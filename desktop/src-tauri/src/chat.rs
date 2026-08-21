// Loro — chat funcional com o agente do projeto (ADR-0021).
//
// O chat NÃO fala com nenhuma API: ele roda o MESMO CLI que o terminal embutido
// (`agent` do acervo, ADR-0003) em modo não-interativo e transmite a resposta
// linha a linha para a interface. A postura de privacidade é, portanto,
// idêntica à do terminal — a conta é do usuário, o processo é local, e o Loro
// não guarda nem encaminha credencial nenhuma (BR-1, BR-9).
//
// Contrato com o CLI do Claude (verificado em 2026-08-11 contra `claude --help`):
//   claude -p --output-format stream-json --include-partial-messages --verbose
// emite um objeto JSON por linha. As formas que consumimos:
//   {"type":"system","subtype":"init","session_id":"…"}            → id da sessão
//   {"type":"stream_event","event":{"type":"content_block_delta",
//      "delta":{"type":"text_delta","text":"…"}}}                  → texto incremental
//   {"type":"stream_event","event":{"type":"content_block_start",
//      "content_block":{"type":"tool_use","name":"…"}}}            → "usando ferramenta"
//   {"type":"result","subtype":"…","is_error":bool,"result":"…"}   → fim do turno
// Qualquer linha desconhecida é ignorada de propósito: o contrato do CLI evolui
// e uma forma nova não pode derrubar o chat.
//
// Agentes que não são o Claude não têm modo -p padronizado. Para eles o prompt
// vai como argumento único (`ollama run llama3 "…"`) e o stdout inteiro é o
// texto da resposta — sem sessão, sem streaming estruturado.
//
// BR-8: nada de conteúdo nos logs. Só tipo de evento, contagem e código de saída.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tracing::info;

use crate::config::{active_acervo, read_loro_config};
use crate::proc::command;

// Um turno por vez: o chat é uma conversa, não um pool de tarefas. Um segundo
// envio enquanto o primeiro roda é recusado em vez de enfileirado — o usuário
// vê o que está acontecendo em vez de esperar um turno invisível.
#[derive(Default)]
pub struct ChatState {
    child: Option<Child>,
    session_id: Option<String>,
    /// Identifica o turno dono do `child`. A thread leitora só recolhe o
    /// processo se ele ainda for o DELA: sem isso, um turno que terminava tarde
    /// recolhia o processo do turno seguinte, e o novo turno era reportado como
    /// falha (código -1) mesmo tendo dado certo.
    turn: u64,
    /// Pasta do acervo em que a sessão foi aberta. `--resume` é resolvido pelo
    /// CLI POR DIRETÓRIO: retomar em outro projeto procura uma sessão que não
    /// existe lá e o turno morre sem stdout, para sempre. Trocar de projeto
    /// portanto encerra a conversa em vez de arrastá-la.
    session_dir: Option<String>,
}

static CHAT: Mutex<Option<ChatState>> = Mutex::new(None);

fn with_state<T>(f: impl FnOnce(&mut ChatState) -> T) -> T {
    let mut guard = CHAT.lock().expect("chat state poisoned");
    f(guard.get_or_insert_with(ChatState::default))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSendInput {
    pub prompt: String,
    /// Modelo do agente (alias curto: "sonnet", "opus"…). Vazio = padrão do CLI.
    #[serde(default)]
    pub model: String,
    /// Esforço: low | medium | high | xhigh | max. Vazio = padrão do CLI.
    #[serde(default)]
    pub effort: String,
    /// `true` começa uma conversa nova mesmo havendo sessão anterior.
    #[serde(default)]
    pub fresh: bool,
    /// Modo de permissão do CLI: "acceptEdits" (padrão do chat) ou
    /// "bypassPermissions". Vazio = o padrão do próprio CLI, que em modo -p
    /// NEGA toda escrita porque não tem como perguntar.
    #[serde(default)]
    pub permission: String,
}

// Só os modos que fazem sentido num chat não-interativo. `manual`/`plan` pedem
// uma pergunta que o print mode não tem como fazer, então aceitá-los seria
// oferecer um modo quebrado.
fn permission_arg(mode: &str) -> &'static str {
    match mode.trim() {
        "bypassPermissions" | "tudo" => "bypassPermissions",
        _ => "acceptEdits",
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStatus {
    pub running: bool,
    pub has_session: bool,
    pub agent: String,
}

// Um passo do agente (uma ferramenta). `input` vem do bloco tool_use; `result`
// chega depois, no tool_result correspondente, casado por `id`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatTool {
    id: String,
    name: String,
    input: String,
    /// ADR-0029: o mesmo stream serve a um CICLO DE LOOP, e aí o passo precisa
    /// dizer de qual loop é. Ausente no chat, e por isso `skip_serializing_if`:
    /// a carga do chat continua idêntica byte a byte.
    #[serde(rename = "loop", skip_serializing_if = "Option::is_none")]
    loop_slug: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatToolResult {
    id: String,
    is_error: bool,
    text: String,
    #[serde(rename = "loop", skip_serializing_if = "Option::is_none")]
    loop_slug: Option<String>,
    /// A negação de permissão chega AQUI, num tool_result — o turno ainda
    /// termina com is_error=false, então esperar pelo fim era tarde demais.
    permission: bool,
}

// Um passo não pode despejar um arquivo inteiro na conversa.
const STEP_CAP: usize = 2000;
fn cap(s: &str) -> String {
    if s.chars().count() <= STEP_CAP {
        return s.to_string();
    }
    let head: String = s.chars().take(STEP_CAP).collect();
    format!("{head}…")
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatDone {
    pub(crate) ok: bool,
    /// Código de erro estável (err.*) quando `ok` é falso — nunca a mensagem crua.
    pub(crate) error: Option<String>,
    /// Trecho da falha do agente, quando ele mesmo explicou (já é texto do usuário).
    pub(crate) detail: Option<String>,
    /// Verdadeiro quando a falha foi de PERMISSÃO: a interface oferece liberar a
    /// pasta ou continuar no terminal em vez de mostrar um erro seco (ADR-0021).
    pub(crate) permission: bool,
    /// QUAL ferramenta foi recusada (`mcp__slack__…`, `WebFetch`). A negação chega
    /// num `tool_result`, que carrega só o `tool_use_id`; o nome veio antes, no
    /// bloco `assistant`, com o mesmo id. Sem casar os dois, a tela dizia «faltou
    /// permissão» sem poder dizer para quê — e um loop não tinha o que oferecer
    /// (ADR-0029 §4.17). É o NOME da ferramenta, nunca o input dela: um argumento
    /// pode carregar conteúdo do acervo, e o nome não (BR-8).
    #[serde(default)]
    pub(crate) permission_tool: Option<String>,
    /// id → nome de cada ferramenta anunciada neste turno. Bookkeeping do leitor de
    /// stream, não resultado: `skip`, para não viajar até a tela.
    #[serde(skip)]
    pub(crate) tool_names: std::collections::HashMap<String, String>,
}

/// O turno começa dando certo: só uma linha de erro o derruba. Um `Default` que
/// nascesse com `ok: false` reportaria falha em todo ciclo que não falhou.
impl Default for ChatDone {
    fn default() -> Self {
        Self {
            ok: true,
            error: None,
            detail: None,
            permission: false,
            permission_tool: None,
            tool_names: std::collections::HashMap::new(),
        }
    }
}

/// O mesmo resultado, sob o nome que o ciclo de loop usa (ADR-0029): o leitor de
/// stream é um só, e duplicá-lo seria um segundo parser para manter em sincronia.
pub(crate) type StreamOutcome = ChatDone;

// Heurística de negação de permissão. O CLI não devolve um código estável para
// isso, então casamos com o vocabulário que ele usa. Errar para menos é seguro:
// o pior caso é a interface mostrar o erro cru em vez do bloco âmbar.
fn looks_like_permission_denial(s: &str) -> bool {
    let s = s.to_lowercase();
    (s.contains("permission") || s.contains("permissão") || s.contains("not allowed"))
        && (s.contains("den")
            || s.contains("requi")
            || s.contains("request")
            || s.contains("grant")
            || s.contains("neg")
            || s.contains("allow"))
}

/// The tool a denial names, read from the MESSAGE. This is the path a real refusal
/// takes in print mode: the CLI does not always deny inside a `tool_result` (where the
/// id would identify the tool) — it ends the whole turn with «Claude requested
/// permissions to use X, but you haven't granted it yet», and the only place the tool's
/// identity exists is that sentence.
///
/// The discriminator is CASE: an agent tool is CamelCase (`Bash`, `WebFetch`) or an MCP
/// name (`mcp__slack__read`), while «permissions to write» is a verb. Without it, the
/// screen offered to allow a tool called "write", which no agent has.
pub(crate) fn tool_in_denial(text: &str) -> Option<String> {
    let at = text.find("to use ")? + "to use ".len();
    let word: String = text[at..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        .collect();
    // o ponto está no conjunto porque um modelo local se chama `llama3.1` — e por
    // isso a frase «to use Bash.» devolvia uma ferramenta chamada "Bash."
    let word = word.trim_end_matches(['.', '-']).to_string();
    if word.is_empty() || word.len() > 80 {
        return None;
    }
    let first = word.chars().next()?;
    (first.is_ascii_uppercase() || word.starts_with("mcp__")).then_some(word)
}

pub(crate) fn agent_is_claude(agent: &str) -> bool {
    crate::agent_process_name(agent).to_lowercase() == "claude"
}

// Argumentos do turno. Separado da execução para poder ser testado sem processo.
pub(crate) fn claude_args(
    model: &str,
    effort: &str,
    permission: &str,
    resume: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-p".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--include-partial-messages".into(),
        "--verbose".into(),
        "--permission-mode".into(),
        permission_arg(permission).into(),
    ];
    if !model.trim().is_empty() {
        args.push("--model".into());
        args.push(model.trim().into());
    }
    if !effort.trim().is_empty() {
        args.push("--effort".into());
        args.push(effort.trim().into());
    }
    if let Some(id) = resume {
        args.push("--resume".into());
        args.push(id.into());
    }
    args
}

/// A negação, casada com o NOME da ferramenta que a causou. O primeiro nome ganha:
/// um turno pode negar várias vezes, e a que a pessoa precisa resolver é a primeira.
/// Separada de `handle_stream_line` para poder ser testada: aquela função precisa de
/// um `AppHandle`, e portanto de um app rodando.
fn note_denial(out: &mut ChatDone, tool_use_id: &str, text: &str) {
    out.permission = true;
    if out.permission_tool.is_none() {
        out.permission_tool = out
            .tool_names
            .get(tool_use_id)
            .cloned()
            .or_else(|| tool_in_denial(text));
    }
}

// Uma linha do stream-json → efeito na interface. Devolve `Some(session_id)`
// quando a linha carrega o id da sessão (para o --resume do próximo turno).
// O fim do turno, sem emitir nada — separado para poder ser testado: é aqui que
// morava o defeito de apagar a negação de permissão.
fn apply_result_line(v: &serde_json::Value, out: &mut ChatDone) {
    if v.get("is_error").and_then(|e| e.as_bool()) != Some(true) {
        return;
    }
    out.ok = false;
    out.error = Some("err.chat_agent_failed".into());
    let detail = v.get("result").and_then(|r| r.as_str()).unwrap_or("");
    // ACUMULA. O `result` é sempre a última linha do fluxo, então ATRIBUIR aqui
    // apagava a negação que um `tool_result` já registrara no meio do turno — e o
    // bloco âmbar, que existe para oferecer a escolha, nunca aparecia.
    if looks_like_permission_denial(detail) {
        out.permission = true;
        // e o nome vem do TEXTO: nesta linha não existe `tool_use_id` para casar
        if out.permission_tool.is_none() {
            out.permission_tool = tool_in_denial(detail);
        }
    }
    if !detail.is_empty() {
        out.detail = Some(detail.to_string());
    }
}

pub(crate) fn handle_stream_line(
    app: &AppHandle,
    line: &str,
    out: &mut ChatDone,
    ch: &str,
    slug: Option<&str>,
) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    match v.get("type").and_then(|t| t.as_str()) {
        Some("stream_event") => {
            let ev = v.get("event")?;
            match ev.get("type").and_then(|t| t.as_str()) {
                Some("content_block_delta") => {
                    let d = ev.get("delta")?;
                    if d.get("type").and_then(|t| t.as_str()) == Some("text_delta") {
                        let text = d.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        if !text.is_empty() {
                            let _ = app.emit(&format!("{ch}-delta"), text);
                        }
                    }
                }
                // o input só está completo no evento `assistant`; aqui o bloco
                // ainda está sendo montado, então não emitimos nada
                Some("content_block_start") => {}
                _ => {}
            }
            None
        }
        // input completo de cada ferramenta que o agente chamou neste turno
        Some("assistant") => {
            for b in v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
                .into_iter()
                .flatten()
            {
                if b.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                    let id = b.get("id").and_then(|x| x.as_str()).unwrap_or("");
                    let name = b.get("name").and_then(|x| x.as_str()).unwrap_or("");
                    if !id.is_empty() && !name.is_empty() {
                        out.tool_names.insert(id.to_string(), name.to_string());
                    }
                    let _ = app.emit(
                        &format!("{ch}-tool"),
                        ChatTool {
                            id: b.get("id").and_then(|x| x.as_str()).unwrap_or("").into(),
                            name: b.get("name").and_then(|x| x.as_str()).unwrap_or("").into(),
                            input: cap(&b.get("input").map(|i| i.to_string()).unwrap_or_default()),
                            loop_slug: slug.map(str::to_string),
                        },
                    );
                }
            }
            None
        }
        // resultado de cada ferramenta — inclusive a negação de permissão
        Some("user") => {
            for b in v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
                .into_iter()
                .flatten()
            {
                if b.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                    let text = match b.get("content") {
                        Some(serde_json::Value::String(s)) => s.clone(),
                        Some(other) => other.to_string(),
                        None => String::new(),
                    };
                    let is_error = b.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                    // SÓ UM RESULTADO DE ERRO É UMA NEGAÇÃO. `looks_like_permission_denial`
                    // é uma heurística sobre TEXTO, e o texto de um tool_result que deu
                    // certo é CONTEÚDO: uma página que o WebFetch trouxe com as palavras
                    // «permission» e «request» dentro dela virava uma negação que nunca
                    // houve, e o ciclo — que tinha acabado de escrever o arquivo — era
                    // registrado como impedido (medido no acervo do dono em 2026-08-18:
                    // 9 passos, 1 arquivo produzido, «err.loop_permission_refused»).
                    // `is_error` já era lido nesta linha e não era usado para decidir.
                    let permission = is_error && looks_like_permission_denial(&text);
                    if permission {
                        note_denial(
                            out,
                            b.get("tool_use_id").and_then(|x| x.as_str()).unwrap_or(""),
                            &text,
                        );
                    }
                    let _ = app.emit(
                        &format!("{ch}-tool-result"),
                        ChatToolResult {
                            id: b
                                .get("tool_use_id")
                                .and_then(|x| x.as_str())
                                .unwrap_or("")
                                .into(),
                            is_error,
                            text: cap(&text),
                            loop_slug: slug.map(str::to_string),
                            permission,
                        },
                    );
                }
            }
            None
        }
        Some("result") => {
            apply_result_line(&v, out);
            v.get("session_id")
                .and_then(|s| s.as_str())
                .map(str::to_string)
        }
        Some("system") => v
            .get("session_id")
            .and_then(|s| s.as_str())
            .map(str::to_string),
        _ => None,
    }
}

#[tauri::command]
pub fn chat_status() -> ChatStatus {
    let agent = crate::active_agent();
    with_state(|st| {
        // `try_wait` sem bloquear: um filho que já saiu não conta como rodando.
        let running = match st.child.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        };
        if !running {
            st.child = None;
        }
        ChatStatus {
            running,
            has_session: st.session_id.is_some(),
            agent: agent.clone(),
        }
    })
}

// Matar sem colher deixa um zumbi por toda a vida do app: ao TIRAR o processo
// do estado, quem cancela também desarma a thread leitora, que era quem faria o
// wait(). Quem tira, colhe — e colhe FORA do mutex.
fn kill_current_child() {
    let child = with_state(|st| {
        st.turn += 1; // o turno em curso deixa de ser o dono do slot
        st.child.take()
    });
    if let Some(mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
    }
}

/// A pessoa está usando o agente? Um ciclo de loop espera a vez em vez de
/// cancelar a conversa de ninguém (ADR-0029 §4.10).
pub(crate) fn agent_busy() -> bool {
    chat_status().running
}

#[tauri::command]
pub fn chat_reset() {
    kill_current_child();
    with_state(|st| {
        st.session_id = None;
        st.session_dir = None;
    });
    info!("chat reset");
}

#[tauri::command]
pub fn chat_cancel() {
    kill_current_child();
    info!("chat turn cancelled");
}

// ADR-0021: "continuar no terminal" — devolve a linha que retoma ESTA conversa
// no terminal embutido, onde o agente pode pedir permissão interativamente.
#[tauri::command]
pub fn chat_handoff() -> Result<String, String> {
    let agent = crate::active_agent();
    let id = with_state(|st| st.session_id.clone()).ok_or("err.chat_no_session")?;
    if !agent_is_claude(&agent) {
        return Err("err.chat_handoff_unsupported".into());
    }
    Ok(format!("{agent} --resume {id}"))
}

// The agent's binary, RESOLVED — never a bare name handed to the OS. Loro asks
// `paths::which` (process PATH + known locations) so that what the app probes and
// what the app spawns are the same answer; a bare name would be resolved by the
// OS against the PATH alone, and on a GUI launch that PATH is not the user's
// (ADR-0030). When it is genuinely not installed, the caller gets a sentence the
// person can act on instead of "No such file or directory (os error 2)".
pub(crate) fn agent_command(bin: &str) -> Result<std::process::Command, String> {
    let exe = crate::paths::which(bin).ok_or_else(|| format!("err.agent_not_found:{bin}"))?;
    Ok(command(exe))
}

#[tauri::command]
pub fn chat_send(app: AppHandle, input: ChatSendInput) -> Result<(), String> {
    let prompt = input.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("err.chat_empty_prompt".into());
    }
    if chat_status().running {
        return Err("err.chat_busy".into());
    }
    let cfg = read_loro_config();
    let dir = active_acervo(&cfg)
        .map(|a| a.dir.clone())
        .ok_or("err.acervo_not_configured")?;
    let agent = crate::active_agent();

    // A sessão vale para o acervo em que nasceu (ver ChatState::session_dir).
    let resume = with_state(|st| {
        let other_project = st
            .session_dir
            .as_ref()
            .is_some_and(|d| d.as_str() != dir.as_str());
        if input.fresh || other_project {
            st.session_id = None;
            st.session_dir = None;
        }
        st.session_id.clone()
    });

    // O comando do agente é texto livre ("ollama run llama3"): o primeiro token
    // é o binário, o resto são argumentos fixos dele.
    let mut parts = agent.split_whitespace();
    let bin = parts.next().unwrap_or("claude").to_string();
    let base_args: Vec<String> = parts.map(str::to_string).collect();

    let mut cmd = agent_command(&bin)?;
    cmd.current_dir(&dir);
    cmd.args(&base_args);
    let claude = agent_is_claude(&agent);
    if claude {
        cmd.args(claude_args(
            &input.model,
            &input.effort,
            &input.permission,
            resume.as_deref(),
        ));
        // O prompt vai por stdin: um argumento gigante estoura o limite de
        // argv e obriga a escapar aspas na mão.
        cmd.stdin(Stdio::piped());
    } else {
        cmd.arg(&prompt);
        cmd.stdin(Stdio::null());
    }
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("err.agent_spawn:{e}"))?;
    if claude {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(prompt.as_bytes());
            // fechar o stdin é o que sinaliza fim do prompt para o CLI
            drop(stdin);
        }
    }
    let stdout = child.stdout.take().ok_or("err.agent_spawn")?;
    // O stderr é drenado NA HORA, em thread própria. Lê-lo só depois do stdout
    // trava o agente para sempre: cheio o buffer do pipe (dezenas de KiB), a
    // próxima escrita dele bloqueia, ele para de produzir stdout, o EOF nunca
    // chega e o chat fica em "pensando…" até o app morrer. Acontece com qualquer
    // agente falador — `ollama` escreve progresso no stderr, e o Claude repassa o
    // stderr dos servidores MCP.
    let err_tail = std::sync::Arc::new(Mutex::new(String::new()));
    if let Some(e) = child.stderr.take() {
        let sink = err_tail.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(e).lines().map_while(Result::ok) {
                let mut buf = sink.lock().expect("chat stderr poisoned");
                // BR-8: cauda curta, só para diagnosticar a falha
                if buf.len() < 4000 {
                    buf.push_str(&line);
                    buf.push('\n');
                }
            }
        });
    }
    let my_turn = with_state(|st| {
        st.turn += 1;
        st.child = Some(child);
        st.turn
    });

    info!(streaming = claude, "chat turn started");

    let dir_for_session = dir.clone();
    std::thread::spawn(move || {
        // o mesmo estado inicial do `Default`, que é onde ele mora
        let mut done = ChatDone::default();
        let mut session: Option<String> = None;
        let mut lines = 0usize;

        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            lines += 1;
            if claude {
                if let Some(id) = handle_stream_line(&app, &line, &mut done, "chat", None) {
                    session = Some(id);
                }
            } else {
                // agente sem modo estruturado: o stdout É a resposta
                let _ = app.emit("chat-delta", format!("{line}\n"));
            }
        }

        // stderr já vinha sendo drenado em paralelo; aqui só lemos a cauda.
        let err_tail = err_tail.lock().map(|b| b.clone()).unwrap_or_default();

        // Recolhe o processo FORA do mutex, e só se ele ainda for o deste turno:
        // com o wait() dentro do `with_state` a trava global ficava presa pelo
        // tempo inteiro do processo seguinte, e as chamadas do chat — inclusive o
        // cancelar, o único capaz de destravar — bloqueavam na thread principal.
        let mine = with_state(|st| {
            if st.turn == my_turn {
                st.child.take()
            } else {
                None
            }
        });
        let code = match mine.map(|mut c| c.wait()) {
            Some(Ok(s)) => s.code().unwrap_or(-1),
            Some(Err(_)) => -1,
            // ninguém para colher: o turno foi cancelado ou substituído. Não é
            // falha do agente, e reportar -1 pintava um cancelamento como erro.
            None => 0,
        };
        if code != 0 && done.ok {
            done.ok = false;
            done.error = Some("err.chat_agent_failed".into());
            if looks_like_permission_denial(&err_tail) {
                done.permission = true;
            } else if !err_tail.trim().is_empty() {
                done.detail = Some(err_tail.trim().to_string());
            }
        }
        if done.permission {
            // o turno termina com is_error=false mesmo tendo tido escrita negada:
            // quem carrega a verdade é o tool_result, já lido acima
            done.ok = false;
            done.error = Some("err.chat_agent_failed".into());
        }
        if let Some(id) = session {
            with_state(|st| {
                st.session_id = Some(id);
                st.session_dir = Some(dir_for_session.clone());
            });
        }
        // BR-8: contagem e código, nunca o conteúdo.
        info!(lines, code, ok = done.ok, "chat turn finished");
        let _ = app.emit("chat-done", done);
    });

    Ok(())
}

#[cfg(test)]
mod tests {

    // ADR-0030 — o defeito MEDIDO: o Loro.app instalado roda com
    // PATH=/usr/bin:/bin:/usr/sbin:/sbin (lido com `ps eww` no app em execução) e
    // o `claude` só existe em /opt/homebrew/bin. O spawn pelo nome nu respondia
    // "No such file or directory (os error 2)" para um agente instalado e
    // funcionando. Aqui o ~/.loro/bin faz o papel do /opt/homebrew/bin: os dois
    // são locais conhecidos, nenhum dos dois está no PATH que este teste impõe.
    #[test]
    fn the_agent_is_found_where_it_is_installed_not_only_on_path() {
        let tmp = std::env::temp_dir().join("loro-test-agent-resolve");
        let bin = tmp.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let fake = bin.join("loro-fake-agent");
        #[cfg(unix)]
        {
            std::fs::write(&fake, "#!/bin/sh\nexit 0\n").unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        #[cfg(windows)]
        {
            // npm's global installer drops exactly this pair for a CLI agent:
            // a bare node-shebang shim (inert on native Windows — found, but
            // does not run) sitting right next to the real `.cmd`. Writing
            // only the bare file, as this test used to, could never have
            // caught paths::exe_candidates picking the wrong one first.
            std::fs::write(&fake, "#!/usr/bin/env node\nprocess.exit(0)\n").unwrap();
            std::fs::write(bin.join("loro-fake-agent.cmd"), "@exit /b 0\r\n").unwrap();
        }
        let saved_home = std::env::var("LORO_HOME").ok();
        let saved_path = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("LORO_HOME", &tmp);
        std::env::set_var("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
        // a precondição do defeito: pelo nome nu, o binário é inalcançável
        let bare = std::process::Command::new("loro-fake-agent").output();
        let resolved = super::agent_command("loro-fake-agent");
        let missing = super::agent_command("loro-agente-que-nao-existe");
        std::env::set_var("PATH", &saved_path);
        match saved_home {
            Some(h) => std::env::set_var("LORO_HOME", h),
            None => std::env::remove_var("LORO_HOME"),
        }

        assert!(bare.is_err(), "o PATH do teste tem de ser insuficiente");
        let mut cmd = resolved.expect("o agente instalado tem de ser encontrado");
        assert!(cmd.output().is_ok(), "encontrado, mas não executou");
        // e o que REALMENTE não existe vira uma frase, não um errno
        assert_eq!(
            missing.unwrap_err(),
            "err.agent_not_found:loro-agente-que-nao-existe"
        );
    }

    #[test]
    fn a_permission_denial_survives_the_end_of_the_turn() {
        // O `result` é sempre a ÚLTIMA linha: atribuir a flag ali apagava a
        // negação lida no meio do turno, e o usuário via o erro cru em vez da
        // escolha (ADR-0021 §2).
        let mut out = ChatDone {
            permission: true, // um tool_result já negou, no meio do turno
            ..Default::default()
        };
        let v: serde_json::Value =
            serde_json::from_str(r#"{"is_error":true,"result":"API Error: 500"}"#).unwrap();
        apply_result_line(&v, &mut out);
        assert!(
            out.permission,
            "a negação foi apagada pelo fim do turno — o bloco âmbar não apareceria"
        );
    }

    // ADR-0029 §4.17 — a negação NOMEIA a ferramenta. Ela chega num `tool_result`,
    // que carrega só o `tool_use_id`; o nome veio antes, no bloco `assistant`. Sem
    // casar os dois, um loop impedido dizia «faltou permissão» e não tinha o que
    // oferecer à pessoa.
    #[test]
    fn a_denial_carries_the_name_of_the_tool_that_caused_it() {
        let mut out = ChatDone::default();
        out.tool_names
            .insert("t1".into(), "mcp__slack__read_channel".into());
        out.tool_names.insert("t2".into(), "WebFetch".into());
        note_denial(&mut out, "t1", "");
        assert!(out.permission);
        assert_eq!(
            out.permission_tool.as_deref(),
            Some("mcp__slack__read_channel")
        );
        // a segunda negação do mesmo turno não sobrescreve a primeira
        note_denial(&mut out, "t2", "");
        assert_eq!(
            out.permission_tool.as_deref(),
            Some("mcp__slack__read_channel")
        );
        // um id que não veio anunciado cai no TEXTO da negação
        let mut sem = ChatDone::default();
        note_denial(
            &mut sem,
            "desconhecido",
            "requested permissions to use WebFetch, but…",
        );
        assert!(sem.permission);
        assert_eq!(sem.permission_tool.as_deref(), Some("WebFetch"));
        // e quando nem o texto diz, fica vazio em vez de inventar um nome
        let mut nada = ChatDone::default();
        note_denial(&mut nada, "x", "permission denied");
        assert_eq!(nada.permission_tool, None);
    }

    #[test]
    fn a_result_that_denies_permission_sets_the_flag() {
        let mut out = ChatDone::default();
        let v: serde_json::Value =
            serde_json::from_str(r#"{"is_error":true,"result":"permission to write was denied"}"#)
                .unwrap();
        apply_result_line(&v, &mut out);
        assert!(out.permission);
    }

    use super::*;

    #[test]
    fn claude_args_are_non_interactive_and_streaming() {
        let a = claude_args("", "", "", None);
        assert!(
            a.contains(&"-p".to_string()),
            "print mode is what makes it non-interactive"
        );
        assert!(a.contains(&"stream-json".to_string()));
        assert!(a.contains(&"--include-partial-messages".to_string()));
        // --verbose é exigido pelo CLI junto de stream-json em modo -p
        assert!(a.contains(&"--verbose".to_string()));
    }

    #[test]
    fn claude_args_carry_model_effort_resume_and_dirs() {
        let a = claude_args("sonnet", "high", "", Some("abc-123"));
        let joined = a.join(" ");
        assert!(joined.contains("--model sonnet"));
        assert!(joined.contains("--effort high"));
        assert!(joined.contains("--resume abc-123"));
    }

    #[test]
    fn claude_args_omit_empty_options() {
        // Um --model vazio faria o CLI recusar o turno inteiro.
        let a = claude_args("  ", "", "", None);
        assert!(!a.contains(&"--model".to_string()));
        assert!(!a.contains(&"--effort".to_string()));
        assert!(!a.contains(&"--resume".to_string()));
    }

    #[test]
    fn print_mode_always_carries_a_workable_permission_mode() {
        // Sem --permission-mode o CLI em -p NEGA toda escrita (e ainda devolve
        // is_error=false), que era exatamente o sintoma relatado.
        let a = claude_args("", "", "", None);
        let i = a
            .iter()
            .position(|x| x == "--permission-mode")
            .expect("modo de permissão é obrigatório");
        assert_eq!(a[i + 1], "acceptEdits");
    }

    #[test]
    fn permission_mode_only_accepts_modes_that_work_without_a_prompt() {
        assert_eq!(permission_arg("bypassPermissions"), "bypassPermissions");
        assert_eq!(permission_arg("tudo"), "bypassPermissions");
        // manual/plan pedem uma pergunta que o print mode não tem como fazer:
        // caem no modo que funciona em vez de quebrar o turno
        assert_eq!(permission_arg("manual"), "acceptEdits");
        assert_eq!(permission_arg("plan"), "acceptEdits");
        assert_eq!(permission_arg(""), "acceptEdits");
    }

    #[test]
    fn a_step_never_dumps_a_whole_file_into_the_conversation() {
        let big = "x".repeat(STEP_CAP * 3);
        let out = cap(&big);
        assert!(out.chars().count() <= STEP_CAP + 1);
        assert!(out.ends_with('…'));
        // o que cabe passa intacto
        assert_eq!(cap("curto"), "curto");
    }

    // O CAMINHO QUE ACONTECE DE VERDADE (2026-08-18, relatado pelo dono): a recusa
    // não vem num `tool_result` com id — vem na ÚLTIMA linha do turno, e o nome da
    // ferramenta só existe na prosa dela. Sem ler daí, a tela do loop dizia «faltou
    // permissão» sem nome e sem ação: exatamente o beco sem saída que §4.17 fechou.
    #[test]
    fn the_final_line_of_a_refused_turn_still_names_the_tool() {
        let mut out = ChatDone::default();
        let v: serde_json::Value = serde_json::from_str(
            r#"{"is_error":true,"result":"Claude requested permissions to use mcp__slack__read_channel, but you haven't granted it yet"}"#,
        )
        .unwrap();
        apply_result_line(&v, &mut out);
        assert!(out.permission);
        assert_eq!(
            out.permission_tool.as_deref(),
            Some("mcp__slack__read_channel")
        );
    }

    #[test]
    fn a_verb_is_not_a_tool_name() {
        // «permissions to write» é o que o CLI diz quando falta escrever num arquivo:
        // oferecer liberar uma ferramenta chamada "write" seria oferecer nada
        assert_eq!(tool_in_denial("requested permissions to write, but…"), None);
        assert_eq!(
            tool_in_denial("requested permissions to use Bash."),
            Some("Bash".into())
        );
        assert_eq!(
            tool_in_denial("permissions to use WebFetch, but"),
            Some("WebFetch".into())
        );
        assert_eq!(
            tool_in_denial("to use mcp__x__y\n"),
            Some("mcp__x__y".into())
        );
        assert_eq!(tool_in_denial("nada aqui"), None);
        assert_eq!(tool_in_denial("to use "), None);
    }

    // O FALSO POSITIVO QUE CUSTOU UM CICLO (2026-08-18, acervo do dono): o resultado de
    // uma busca web é CONTEÚDO, e conteúdo com as palavras certas parecia uma negação.
    #[test]
    fn the_content_of_a_successful_step_is_not_a_denial() {
        // a heurística sozinha acusa — e é por isso que ela não decide sozinha
        assert!(looks_like_permission_denial(
            "A página fala de permission e request de acesso ao pátio"
        ));
        // o que decide é o resultado ter dado ERRO
        let mut done = ChatDone::default();
        let ok_result = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":false,"content":"…permission… request…"}]}}"#;
        let v: serde_json::Value = serde_json::from_str(ok_result).unwrap();
        let block = &v["message"]["content"][0];
        let is_error = block
            .get("is_error")
            .and_then(|e| e.as_bool())
            .unwrap_or(false);
        let text = block.get("content").and_then(|c| c.as_str()).unwrap_or("");
        // a mesma expressão que `handle_stream_line` avalia (ela precisa de um AppHandle)
        let permission = is_error && looks_like_permission_denial(text);
        assert!(
            !permission,
            "um passo que DEU CERTO não pede permissão nenhuma"
        );
        if permission {
            note_denial(&mut done, "t1", text);
        }
        assert!(!done.permission);
    }

    #[test]
    fn permission_denial_is_recognized_in_both_languages() {
        assert!(looks_like_permission_denial(
            "Claude requested permissions to write, but you haven't granted it yet"
        ));
        assert!(looks_like_permission_denial("permission denied"));
        assert!(looks_like_permission_denial(
            "permissão negada para a pasta"
        ));
        // BR: um erro comum não pode virar o bloco de permissão
        assert!(!looks_like_permission_denial("model not found"));
        assert!(!looks_like_permission_denial("network unreachable"));
    }

    #[test]
    fn text_deltas_and_session_id_are_extracted() {
        // Formas reais do stream-json (probe contra o CLI em 2026-08-11).
        let mut done = ChatDone::default();
        let init = r#"{"type":"system","subtype":"init","session_id":"s-1"}"#;
        let v: serde_json::Value = serde_json::from_str(init).unwrap();
        assert_eq!(v.get("session_id").unwrap().as_str(), Some("s-1"));

        let res =
            r#"{"type":"result","is_error":true,"result":"permission denied","session_id":"s-2"}"#;
        let v: serde_json::Value = serde_json::from_str(res).unwrap();
        assert!(v.get("is_error").unwrap().as_bool().unwrap());
        done.permission = looks_like_permission_denial(v.get("result").unwrap().as_str().unwrap());
        assert!(done.permission);
    }
}
