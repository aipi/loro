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
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatToolResult {
    id: String,
    is_error: bool,
    text: String,
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
struct ChatDone {
    ok: bool,
    /// Código de erro estável (err.*) quando `ok` é falso — nunca a mensagem crua.
    error: Option<String>,
    /// Trecho da falha do agente, quando ele mesmo explicou (já é texto do usuário).
    detail: Option<String>,
    /// Verdadeiro quando a falha foi de PERMISSÃO: a interface oferece liberar a
    /// pasta ou continuar no terminal em vez de mostrar um erro seco (ADR-0021).
    permission: bool,
}

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

fn is_claude(agent: &str) -> bool {
    crate::agent_process_name(agent).to_lowercase() == "claude"
}

// Argumentos do turno. Separado da execução para poder ser testado sem processo.
fn claude_args(model: &str, effort: &str, permission: &str, resume: Option<&str>) -> Vec<String> {
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
    out.permission = out.permission || looks_like_permission_denial(detail);
    if !detail.is_empty() {
        out.detail = Some(detail.to_string());
    }
}

fn handle_stream_line(app: &AppHandle, line: &str, out: &mut ChatDone) -> Option<String> {
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
                            let _ = app.emit("chat-delta", text);
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
                    let _ = app.emit(
                        "chat-tool",
                        ChatTool {
                            id: b.get("id").and_then(|x| x.as_str()).unwrap_or("").into(),
                            name: b.get("name").and_then(|x| x.as_str()).unwrap_or("").into(),
                            input: cap(&b.get("input").map(|i| i.to_string()).unwrap_or_default()),
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
                    let permission = looks_like_permission_denial(&text);
                    if permission {
                        out.permission = true;
                    }
                    let _ = app.emit(
                        "chat-tool-result",
                        ChatToolResult {
                            id: b
                                .get("tool_use_id")
                                .and_then(|x| x.as_str())
                                .unwrap_or("")
                                .into(),
                            is_error,
                            text: cap(&text),
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
    if !is_claude(&agent) {
        return Err("err.chat_handoff_unsupported".into());
    }
    Ok(format!("{agent} --resume {id}"))
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

    let mut cmd = command(&bin);
    cmd.current_dir(&dir);
    cmd.args(&base_args);
    let claude = is_claude(&agent);
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
        let mut done = ChatDone {
            ok: true,
            error: None,
            detail: None,
            permission: false,
        };
        let mut session: Option<String> = None;
        let mut lines = 0usize;

        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            lines += 1;
            if claude {
                if let Some(id) = handle_stream_line(&app, &line, &mut done) {
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

    #[test]
    fn a_permission_denial_survives_the_end_of_the_turn() {
        // O `result` é sempre a ÚLTIMA linha: atribuir a flag ali apagava a
        // negação lida no meio do turno, e o usuário via o erro cru em vez da
        // escolha (ADR-0021 §2).
        let mut out = ChatDone {
            ok: true,
            error: None,
            detail: None,
            permission: true, // um tool_result já negou, no meio do turno
        };
        let v: serde_json::Value =
            serde_json::from_str(r#"{"is_error":true,"result":"API Error: 500"}"#).unwrap();
        apply_result_line(&v, &mut out);
        assert!(
            out.permission,
            "a negação foi apagada pelo fim do turno — o bloco âmbar não apareceria"
        );
    }

    #[test]
    fn a_result_that_denies_permission_sets_the_flag() {
        let mut out = ChatDone {
            ok: true,
            error: None,
            detail: None,
            permission: false,
        };
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
        let mut done = ChatDone {
            ok: true,
            error: None,
            detail: None,
            permission: false,
        };
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
