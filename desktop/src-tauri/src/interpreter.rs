// Modo intérprete (ADR-0035): a fala do usuário sai como voz em inglês por um
// dispositivo de saída ESCOLHIDO — normalmente o driver virtual que o app já
// ensina a instalar (BlackHole no macOS), selecionado como microfone no app de
// chamada.
//
// NÃO é tradução simultânea, e a UI não deve chamar assim. É CONSECUTIVA: o
// whisper traduz um pensamento fechado, não palavra a palavra, então o ciclo é
// falar → pausa → tradução → voz. Medido nesta máquina (M4) sobre a voz REAL do
// dono em 2026-09-06: 8s de fala em pt-BR traduzidos em 439ms, e a voz em inglês
// dura ~87% do original. Quem falar por cima atropela — por isso a fila do lado
// do front nunca corta uma frase no meio.
//
// A saída vai para o dispositivo escolhido, e a escolha é explícita: apontar
// para os alto-falantes é legítimo (é como se testa a cadeia sem uma reunião),
// mas o padrão é o dispositivo virtual. É isso que preserva a premissa "o Loro
// não toca nada" que justifica `echoCancellation: false` (audio.js RAW_AUDIO):
// se a voz saísse pela caixa numa reunião, ela voltaria pelo microfone e
// entraria na própria transcrição.

// FORA DO macOS o caminho de FALA deste módulo não tem implementação: `say` e
// `audiotoolbox` são do macOS, e o ffmpeg não tem saída WASAPI (ADR-0036 §6.5).
// As metades PURAS — os parsers, a montagem de argumentos, a resolução de
// dispositivo por nome — continuam compiladas em toda plataforma, porque são
// elas que a implementação de Windows/Linux vai reusar e porque os testes as
// exercitam em todo alvo. Sem chamador, o clippy as vê como mortas: 17 erros nos
// CIs de ubuntu e windows (medido 2026-09-07), invisíveis num `make lint` que só
// checa o host — foi assim que a PR #99 quebrou.
//
// O allow é ESCOPADO a não-macOS de propósito: no macOS, código morto continua
// sendo erro. Ele desaparece quando o caminho de fala existir nas outras
// plataformas, que é o momento em que essas funções ganham chamador.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::paths::{ffmpeg_not_found_err, which};

// Um modelo do catálogo que REALMENTE executa a tarefa de tradução.
//
// Medido 2026-09-06, mesmo áudio (8,617s pt-BR), mesmos argumentos:
//   ggml-small.bin        + -tr -> "Good morning guys, I wanted to discuss…"
//   ggml-large-v3-turbo   + -tr -> "Bom dia pessoal, eu queria discutir…"  (pt!)
//
// A destilação `turbo` descartou a tarefa de tradução, e o whisper IGNORA `-tr`
// EM SILÊNCIO — sem erro, sem aviso, devolvendo o idioma de origem. Como
// `large-v3-turbo` é o modelo padrão do app (app.js), o modo intérprete tem de
// recusar explicitamente em vez de falar português com voz inglesa.
pub fn model_translates(id: &str) -> bool {
    !id.contains("turbo")
}

// O idioma de destino é fixo: o `-tr` do whisper só traduz PARA inglês
// (ADR-0035 §5.2). Qualquer outro par precisa de um motor que o app não tem.
pub const TARGET_LANG_PREFIX: &str = "en_";

// O nome de um dispositivo virtual de saída. Mesmo espírito da guarda de entrada
// no front: reconhecer o driver pelo NOME, não pela plataforma. Sem regex de
// propósito — este Cargo.toml tem 9 dependências e nenhuma delas é para isto.
const VIRTUAL_OUTPUT_HINTS: &[&str] = &[
    "blackhole",
    "vb-cable",
    "vbcable",
    "cable input",
    "vb-audio",
    "loopback",
];

pub fn is_virtual_output(name: &str) -> bool {
    let n = name.to_lowercase();
    VIRTUAL_OUTPUT_HINTS.iter().any(|h| n.contains(h))
}

#[derive(Serialize, PartialEq, Debug, Clone)]
pub struct OutputDevice {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, PartialEq, Debug, Clone)]
pub struct Voice {
    pub name: String,
    pub locale: String,
}

// Lê a lista do `say -a '?'`. Cada linha é o id numérico com recuo, um espaço e
// o nome: "   74 Alto-falantes (MacBook Pro)". O nome tem espaços e parênteses,
// então só o PRIMEIRO campo é o id e todo o resto é o nome.
pub fn parse_say_devices(out: &str) -> Vec<OutputDevice> {
    out.lines()
        .filter_map(|line| {
            let (id, name) = line.trim().split_once(char::is_whitespace)?;
            if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
            let name = name.trim();
            if name.is_empty() {
                return None;
            }
            Some(OutputDevice {
                id: id.to_string(),
                name: name.to_string(),
            })
        })
        .collect()
}

// O id de um dispositivo A PARTIR DO NOME.
//
// MEDIDO 2026-09-06: os ids do `say` NÃO sobrevivem a um restart do coreaudiod.
// Instalar o BlackHole e rodar `killall coreaudiod` mudou "Alto-falantes" de 71
// para 74 na mesma sessão. Guardar o id nas configurações faria o modo falar num
// dispositivo aleatório depois de um reboot — possivelmente no alto-falante, no
// meio de uma reunião. Por isso a configuração guarda o NOME e o id é resolvido
// a cada fala.
pub fn resolve_device_id(devices: &[OutputDevice], name: &str) -> Option<String> {
    devices
        .iter()
        .find(|d| d.name == name)
        .map(|d| d.id.clone())
}

// Lê a lista do `say -v '?'`. O formato é "<nome> <locale> # <exemplo>", e o
// NOME contém espaços e parênteses aninhados ("Eddy (Inglês (Reino Unido))",
// "Bad News"). Por isso o corte é pelo `#` e depois pelo ÚLTIMO campo à
// esquerda: o locale é sempre o último token antes do comentário.
pub fn parse_voices(out: &str) -> Vec<Voice> {
    out.lines()
        .filter_map(|line| {
            let left = line.split('#').next()?.trim();
            let (name, locale) = left.rsplit_once(char::is_whitespace)?;
            let name = name.trim();
            if name.is_empty() || !locale.contains('_') {
                return None;
            }
            Some(Voice {
                name: name.to_string(),
                locale: locale.to_string(),
            })
        })
        .collect()
}

// Só as vozes do idioma de destino. Uma voz portuguesa lendo texto inglês sai
// ininteligível, e o `-tr` não produz outra coisa senão inglês.
//
// NÃO filtra as vozes "de brincadeira" da Apple (Bahh, Boing, Bubbles…). É a
// lição da ADR-0034: uma lista de bloqueio larga o bastante para pegá-las é
// larga o bastante para matar voz legítima, e as vozes premium que o usuário
// baixar depois não estão em lista nenhuma que possamos manter. Quem escolhe é
// o ouvido do usuário — por isso a UI tem pré-escuta.
pub fn english_voices(all: &[Voice]) -> Vec<Voice> {
    all.iter()
        .filter(|v| v.locale.starts_with(TARGET_LANG_PREFIX))
        .cloned()
        .collect()
}

// Argumentos do `say`. O texto vai por ARQUIVO (-f), não como argumento: uma
// tradução que comece com "-" viraria uma flag, e o texto é conteúdo de fala —
// mantê-lo fora da linha de comando também o mantém fora de qualquer ps (BR-8).
//
// `device` é o id JÁ RESOLVIDO e é obrigatório: sem -a o `say` toca no
// dispositivo padrão, que é o alto-falante.
// LATÊNCIA: a voz sintética leva ~87% do tempo da fala original (medido), então
// numa conversa o atraso ACUMULA — foi o que o dono sentiu em 2026-09-06
// ("funcionou mas tomou muito tempo"). Falar mais rápido encurta cada elocução
// e faz a espera drenar em vez de crescer. 210 wpm contra o padrão ~175 do
// `say`: ~20% mais curto, ainda dentro do que se entende sem esforço.
pub const SPEAK_RATE_WPM: u32 = 210;

pub fn say_args(voice: &str, device: &str, text_file: &str) -> Vec<String> {
    let mut a = Vec::new();
    if !voice.is_empty() {
        a.push("-v".into());
        a.push(voice.into());
    }
    a.push("-r".into());
    a.push(SPEAK_RATE_WPM.to_string());
    a.push("-a".into());
    a.push(device.into());
    a.push("-f".into());
    a.push(text_file.into());
    a
}

#[derive(Deserialize)]
pub struct TranslateInput {
    pub data: Vec<u8>,
    pub model: String,
    pub lang: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Translated {
    pub text: String,
}

// O motor de voz é ESCOLHA, não premissa (ADR-0036). Dois hoje:
//   system — o `say` do macOS. Padrão, porque é 6,4x mais rápido (medido).
//   neural — sherpa-onnx + Kokoro. Melhor voz, cross-platform, mais lento.
//
// Medido 2026-09-07 (M4, 8 threads, a mesma frase):
//   say -r 210     0,608s até a voz poder começar
//   Kokoro int8    3,923s  (RTF 0,499; e RTF 0,825 numa frase curta, que é o
//                           que uma conversa tem)
// Por isso o neural não é atualização silenciosa: é opção com o custo na tela.
#[derive(Deserialize, Serialize, PartialEq, Debug, Clone, Copy, Default)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    // O padrão é o barato, e o teste `the_default_engine_is_the_fast_one` é
    // quem guarda isso.
    #[default]
    System,
    Neural,
}

// O binário do motor neural, resolvido no PATH como QUALQUER motor deste app
// (ADR-0003, e ADR-0030: a sonda e o spawn passam pela MESMA busca). Não é
// crate: a crate arrasta 145 pacotes e baixa artefato nativo em tempo de build,
// e este Cargo.toml tem 9 dependências de propósito.
pub fn neural_tts_bin() -> PathBuf {
    crate::paths::resolve_engine("LORO_SHERPA_TTS_BIN", "sherpa-onnx-offline-tts")
}

// Onde o modelo de voz fica, no mesmo diretório dos modelos do whisper.
pub fn voice_model_dir() -> PathBuf {
    crate::paths::models_dir().join(VOICE_MODEL_ID)
}

// ZipVoice em vez de Kokoro, e a troca é MEDIDA (2026-09-07, a mesma frase, a
// voz real do dono como referência):
//   Kokoro (voz genérica)     3,923s   RTF 0,499
//   ZipVoice (a voz do dono)  1,378s   RTF 0,192
// O Kokoro era mais lento E não era a voz da pessoa — não justificava o espaço.
//
// LICENÇA: este checkpoint é treinado no dataset Emilia (CC BY-NC-4.0). O app
// NÃO o distribui — é baixado sob demanda, com a licença declarada na tela antes
// do download, no mesmo padrão dos modelos do whisper (ADR-0006). Ser open
// source não torna NC permissivo; declarar é o que torna isto honesto.
pub const VOICE_MODEL_ID: &str = "zipvoice-distill-int8-zh-en-emilia";

// O vocoder é arquivo SEPARADO na origem e mora junto do modelo aqui. Testado
// 2026-09-07: o hifigan_v2 (3,6 MB) NÃO serve — carrega como ONNX e o modelo
// rejeita o formato. Fica o vocos de 52 MB.
pub const VOCODER_FILE: &str = "vocos_24khz.onnx";

// Os arquivos que o motor precisa. Se um só faltar ele não roda, e dizer O QUE
// falta é melhor que falhar no meio de uma reunião.
pub fn voice_model_missing(dir: &Path) -> Vec<&'static str> {
    [
        "encoder.int8.onnx",
        "decoder.int8.onnx",
        "lexicon.txt",
        "tokens.txt",
        "espeak-ng-data",
        VOCODER_FILE,
    ]
    .into_iter()
    .filter(|f| !dir.join(f).exists())
    .collect()
}

// Argumentos do sherpa-onnx-offline-tts para o ZipVoice, com a voz do usuário
// como referência. `out` é o WAV que depois é tocado no dispositivo escolhido —
// o `-play` toca só no dispositivo PADRÃO e por isso não serve (§4).
//
// `ref_text` é obrigatório e é o texto EXATO da frase gravada: é ele que ancora
// a voz. É por isso que as frases da amostra são fixas (voice_sample.rs).
// `text` vai POSICIONAL, e isso NÃO é escolha: medido 2026-09-07, o
// sherpa-onnx-offline-tts recusa `--text-file` ("Invalid option") e não tem
// nenhuma opção equivalente. Eu havia inventado essa flag e ela nunca existiu.
//
// Consequência honesta para a BR-8: neste motor a frase traduzida aparece no
// argv do processo. Não é log, não persiste, e no macOS o argv de um processo só
// é legível pelo próprio usuário — mas é exposição a mais que o motor do sistema
// não tem (o `say` aceita `-f arquivo`, e continua usando).
pub fn zipvoice_args(
    dir: &Path,
    threads: &str,
    out: &str,
    text: &str,
    ref_audio: &str,
    ref_text: &str,
) -> Vec<String> {
    let j = |f: &str| dir.join(f).to_string_lossy().into_owned();
    vec![
        format!("--zipvoice-encoder={}", j("encoder.int8.onnx")),
        format!("--zipvoice-decoder={}", j("decoder.int8.onnx")),
        format!("--zipvoice-data-dir={}", j("espeak-ng-data")),
        format!("--zipvoice-lexicon={}", j("lexicon.txt")),
        format!("--zipvoice-tokens={}", j("tokens.txt")),
        format!("--zipvoice-vocoder={}", j(VOCODER_FILE)),
        format!("--reference-audio={ref_audio}"),
        format!("--reference-text={ref_text}"),
        format!("--num-threads={threads}"),
        format!("--output-filename={out}"),
        // Separador ANTES do posicional: uma tradução que comece com "-" seria
        // lida como flag, e "--" encerra a análise de opções.
        "--".into(),
        text.into(),
    ]
}

// Um dispositivo como o ffmpeg/audiotoolbox o enumera. É uma lista SEPARADA da
// do `say`, com índices próprios — e confundir as duas foi um defeito medido.
#[derive(Serialize, PartialEq, Debug, Clone)]
pub struct AudioToolboxDevice {
    pub index: String,
    pub name: String,
}

// Lê `ffmpeg -f audiotoolbox -list_devices true`. Cada linha é
// "[N]    <nome>, <UID>" — o nome tem espaços e parênteses e o UID vem depois
// da ÚLTIMA vírgula.
pub fn parse_audiotoolbox_devices(out: &str) -> Vec<AudioToolboxDevice> {
    out.lines()
        .filter_map(|line| {
            // A linha vem com o prefixo de log do ffmpeg —
            // "[AudioToolbox @ 0x1] [0]  Nome, UID" — então o PRIMEIRO par de
            // colchetes não é o índice. Vale o primeiro par cujo conteúdo é só
            // dígitos; pegar o primeiro par rejeitava toda a lista (medido).
            let mut close = 0usize;
            let mut index = "";
            let b = line.as_bytes();
            let mut i = 0usize;
            while i < b.len() {
                if b[i] == b'[' {
                    if let Some(rel) = line[i..].find(']') {
                        let c = i + rel;
                        let inner = line[i + 1..c].trim();
                        if !inner.is_empty() && inner.chars().all(|ch| ch.is_ascii_digit()) {
                            index = inner;
                            close = c;
                            break;
                        }
                        i = c + 1;
                        continue;
                    }
                }
                i += 1;
            }
            if index.is_empty() {
                return None;
            }
            let rest = line[close + 1..].trim();
            // Sem vírgula não é linha de dispositivo (é o cabeçalho, ou log).
            let name = rest.rsplit_once(',')?.0.trim();
            if name.is_empty() {
                return None;
            }
            Some(AudioToolboxDevice {
                index: index.to_string(),
                name: name.to_string(),
            })
        })
        .collect()
}

// O índice do audiotoolbox A PARTIR DO NOME.
//
// MEDIDO 2026-09-07: os índices do audiotoolbox NÃO são os ids do `say -a`. Na
// mesma máquina, "BlackHole 2ch" era 86 para o `say` e 0 para o audiotoolbox, e
// passar 86 falhou com "AudioObjecTGetPropertyData UID". Provado por captura: ao
// tocar no índice 0, a entrada do BlackHole recebeu -4,6 dB; no índice 2, -91 dB
// (silêncio). São duas enumerações diferentes, e cada motor resolve na sua.
pub fn resolve_audiotoolbox_index(devices: &[AudioToolboxDevice], name: &str) -> Option<String> {
    devices
        .iter()
        .find(|d| d.name == name)
        .map(|d| d.index.clone())
}

// Argumentos para LISTAR as saídas do audiotoolbox. Entrada nula porque o
// ffmpeg exige uma para chegar ao muxer, e não queremos tocar nada.
pub fn list_devices_args() -> Vec<String> {
    [
        "-hide_banner",
        "-v",
        "info",
        "-f",
        "lavfi",
        "-i",
        "anullsrc",
        "-t",
        "0.1",
        "-f",
        "audiotoolbox",
        "-list_devices",
        "true",
        "-",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

// Toca um WAV num dispositivo de saída ESCOLHIDO. O `afplay` não seleciona
// dispositivo e o `say -a` só fala texto; o ffmpeg faz, e já é dependência
// obrigatória deste app. `device_index` é o índice do AUDIOTOOLBOX, resolvido
// pelo nome em `resolve_audiotoolbox_index` — nunca o id do `say`.
pub fn play_args(wav: &str, device_index: &str) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-v".into(),
        "error".into(),
        "-i".into(),
        wav.into(),
        "-f".into(),
        "audiotoolbox".into(),
        "-audio_device_index".into(),
        device_index.into(),
        "-".into(),
    ]
}

#[derive(Deserialize)]
pub struct SpeakInput {
    pub text: String,
    pub voice: String,
    // O NOME do dispositivo, nunca o id — ver resolve_device_id.
    pub device: String,
    #[serde(default)]
    pub engine: Engine,
}

// Junta os segmentos que o whisper devolveu em uma frase só. A fala do usuário
// já chega recortada por silêncio pelo front, então uma chamada é UMA elocução:
// o que interessa é o texto contínuo, não os tempos.
pub fn join_segments(segments: &[crate::SpokenSegment]) -> String {
    let mut out = String::new();
    for s in segments {
        let t = s.text.trim();
        if t.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(t);
    }
    out
}

#[cfg(target_os = "macos")]
const SAY: &str = "/usr/bin/say";

// O `say -a '?'` e o `say -v '?'` escrevem a lista e saem com status de ERRO
// (não é um pedido de fala), então o status não é o critério — a lista é. E a
// lista sai ora em stdout ora em stderr conforme a versão, então lemos as duas.
#[cfg(target_os = "macos")]
fn say_listing(flag: &str) -> Result<String, String> {
    let out = crate::proc::command(std::path::Path::new(SAY))
        .args([flag, "?"])
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr))
}

// O preparo do áudio, em três estados — e o do meio é o que ninguém documenta.
//
// MEDIDO 2026-09-06: `brew install --cask blackhole-2ch` deixou o driver em
// /Library/Audio/Plug-Ins/HAL e o CoreAudio NÃO o listou. O `coreaudiod` varre
// esse diretório só quando sobe. "Instalado" e "disponível" são estados
// diferentes, e sem separá-los a pessoa vê um dispositivo que teima em não
// aparecer e não tem o que fazer.
//
// Nada aqui EXECUTA nada: instalar o driver e reiniciar o coreaudiod pedem
// senha de administrador, e um app que roda sudo escondido é o que ninguém deve
// construir. Isto diagnostica e devolve o comando; quem o roda é a pessoa, à
// vista, no terminal que o app já tem.
#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioSetup {
    pub state: String,   // "ready" | "installed_not_loaded" | "missing" | "unsupported"
    pub command: String, // o comando do passo atual ("" quando pronto)
}

// O estado, a partir dos DOIS fatos independentes: o driver no disco e o
// dispositivo na lista do CoreAudio. Função pura — os dois fatos entram, o
// diagnóstico sai — porque a combinação é o que importa, não cada um.
pub fn audio_setup_from(driver_on_disk: bool, device_listed: bool) -> AudioSetup {
    if device_listed {
        return AudioSetup {
            state: "ready".into(),
            command: String::new(),
        };
    }
    if driver_on_disk {
        return AudioSetup {
            state: "installed_not_loaded".into(),
            command: "sudo killall coreaudiod".into(),
        };
    }
    AudioSetup {
        state: "missing".into(),
        command: "brew install --cask blackhole-2ch".into(),
    }
}

#[tauri::command]
pub fn interpreter_audio_setup() -> Result<AudioSetup, String> {
    #[cfg(target_os = "macos")]
    {
        let driver = std::path::Path::new("/Library/Audio/Plug-Ins/HAL")
            .read_dir()
            .map(|d| {
                d.filter_map(|e| e.ok()).any(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .to_lowercase()
                        .contains("blackhole")
                })
            })
            .unwrap_or(false);
        let listed = parse_say_devices(&say_listing("-a")?)
            .iter()
            .any(|d| is_virtual_output(&d.name));
        Ok(audio_setup_from(driver, listed))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(AudioSetup {
            state: "unsupported".into(),
            command: String::new(),
        })
    }
}

#[tauri::command]
pub fn interpreter_devices() -> Result<Vec<OutputDevice>, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(parse_say_devices(&say_listing("-a")?))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("err.interpreter_platform_unsupported".into())
    }
}

#[tauri::command]
pub fn interpreter_voices() -> Result<Vec<Voice>, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(english_voices(&parse_voices(&say_listing("-v")?)))
    }
    #[cfg(not(target_os = "macos"))]
    {
        // ADR-0035 §5.5: o custo do SAPI no Windows é uma ASSUNÇÃO não medida, e
        // este repo já pagou caro por medir o Windows de longe. Recusar é
        // honesto; fingir que funciona não é.
        Err("err.interpreter_platform_unsupported".into())
    }
}

#[tauri::command]
pub async fn interpreter_translate(input: TranslateInput) -> Result<Translated, String> {
    tauri::async_runtime::spawn_blocking(move || translate_blocking(input))
        .await
        .map_err(|e| e.to_string())?
}

// ADR-0022 §28: roda em spawn_blocking. Um whisper na thread principal já
// congelou este app três vezes; a quarta não vai ser esta.
fn translate_blocking(input: TranslateInput) -> Result<Translated, String> {
    if input.data.is_empty() {
        return Ok(Translated {
            text: String::new(),
        });
    }
    if !model_translates(&input.model) {
        return Err(format!("err.model_cannot_translate:{}", input.model));
    }
    let ffmpeg = which("ffmpeg").ok_or_else(ffmpeg_not_found_err)?;
    let cli = crate::paths::whisper_cli_bin();
    let model = crate::paths::model_path(&input.model);
    if !model.exists() {
        return Err(format!("err.model_not_found:{}", model.display()));
    }
    // Fora do acervo: uma elocução do intérprete não é material de reunião e não
    // pode ser versionada nem sobrar na árvore. Nome único porque duas elocuções
    // podem estar em voo (a fila do front despacha a seguinte enquanto esta fala).
    let seg = std::env::temp_dir().join(format!(".loro-interp.{}.webm", crate::epoch_millis()));
    std::fs::write(&seg, &input.data).map_err(|e| e.to_string())?;
    let lang = if input.lang.is_empty() {
        "auto"
    } else {
        &input.lang
    };
    let segments = crate::transcribe_wav_window(
        &PathBuf::from(ffmpeg),
        &seg,
        &cli,
        &model,
        lang,
        true, // -tr: é a razão de existir deste caminho
        "8",
        0,
        None,
    );
    let _ = std::fs::remove_file(&seg);
    Ok(Translated {
        text: join_segments(&segments?),
    })
}

#[tauri::command]
pub async fn interpreter_speak(input: SpeakInput) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || speak_blocking(input))
        .await
        .map_err(|e| e.to_string())?
}

fn speak_blocking(input: SpeakInput) -> Result<(), String> {
    if input.text.trim().is_empty() {
        return Ok(());
    }
    if input.device.trim().is_empty() {
        return Err("err.interpreter_no_device".into());
    }
    #[cfg(target_os = "macos")]
    {
        let devices = parse_say_devices(&say_listing("-a")?);
        // Resolvido AGORA, pelo nome: o id de ontem pode ser de outro aparelho.
        let id = resolve_device_id(&devices, input.device.trim())
            .ok_or_else(|| format!("err.interpreter_device_gone:{}", input.device))?;
        // Cada motor recebe o texto do jeito que o SEU binário aceita: o `say`
        // por arquivo (-f), o neural posicional — ele não tem opção de arquivo.
        match input.engine {
            Engine::System => speak_with_say(&input.voice, &id, &input.text),
            // O motor neural recebe o NOME do dispositivo: ele resolve na
            // enumeração do audiotoolbox, não na do `say` (medido — os índices
            // são diferentes).
            Engine::Neural => speak_with_neural(input.device.trim(), &input.text),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("err.interpreter_platform_unsupported".into())
    }
}

#[cfg(target_os = "macos")]
fn speak_with_say(voice: &str, device_id: &str, text: &str) -> Result<(), String> {
    // O `say` ACEITA arquivo, e é por isso que ele o usa: mantém a fala fora da
    // linha de comando (BR-8) e evita que um texto iniciado por "-" vire flag.
    let f = std::env::temp_dir().join(format!(".loro-interp.{}.txt", crate::epoch_millis()));
    std::fs::write(&f, text.as_bytes()).map_err(|e| e.to_string())?;
    let args = say_args(voice, device_id, &f.to_string_lossy());
    let out = crate::proc::command(Path::new(SAY))
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&f);
    if !out.status.success() {
        return Err("err.interpreter_speak_failed".into());
    }
    Ok(())
}

// ADR-0036: gera o WAV com o Kokoro e o toca no dispositivo ESCOLHIDO. São dois
// passos porque o binário que toca enquanto gera só alcança o dispositivo
// PADRÃO, e o modo existe justamente para falar em outro.
//
// `voice` aqui é o índice da voz do Kokoro (o voices.bin traz várias), não um
// nome do `say`. Valor não numérico cai na voz 0 em vez de recusar: trocar de
// motor não pode invalidar a escolha de voz que já estava guardada.
#[cfg(target_os = "macos")]
fn speak_with_neural(device_name: &str, text: &str) -> Result<(), String> {
    let dir = voice_model_dir();
    let missing = voice_model_missing(&dir);
    if !missing.is_empty() {
        return Err(format!(
            "err.interpreter_voice_model_missing:{}",
            missing.join(",")
        ));
    }
    // A voz é a do USUÁRIO: a frase mais longa que ele gravou, com o texto
    // exato dela. Sem amostra o motor não inventa uma voz — ele diz que falta
    // gravar, porque sintetizar com voz aleatória seria pior que não falar.
    let (ref_audio, ref_text) = crate::voice_sample::best_reference()
        .ok_or_else(|| "err.interpreter_no_voice_sample".to_string())?;
    let bin = neural_tts_bin();
    let wav = std::env::temp_dir().join(format!(".loro-interp.{}.wav", crate::epoch_millis()));
    let gen = crate::proc::command(&bin)
        .args(zipvoice_args(
            &dir,
            "8",
            &wav.to_string_lossy(),
            text,
            &ref_audio.to_string_lossy(),
            &ref_text,
        ))
        .output()
        .map_err(|_| "err.interpreter_neural_missing".to_string())?;
    if !gen.status.success() || !wav.exists() {
        let _ = std::fs::remove_file(&wav);
        return Err("err.interpreter_speak_failed".into());
    }
    let ffmpeg = which("ffmpeg").ok_or_else(ffmpeg_not_found_err)?;
    // O índice é resolvido AGORA, pelo nome, na enumeração do audiotoolbox —
    // que é outra lista que a do `say` (ver resolve_audiotoolbox_index).
    let listing = crate::proc::command(Path::new(&ffmpeg))
        .args(list_devices_args())
        .output()
        .map_err(|e| e.to_string())?;
    let devices = parse_audiotoolbox_devices(
        &(String::from_utf8_lossy(&listing.stdout).to_string()
            + &String::from_utf8_lossy(&listing.stderr)),
    );
    let idx = resolve_audiotoolbox_index(&devices, device_name)
        .ok_or_else(|| format!("err.interpreter_device_gone:{device_name}"))?;
    let play = crate::proc::command(Path::new(&ffmpeg))
        .args(play_args(&wav.to_string_lossy(), &idx))
        .output()
        .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&wav);
    if !play.status.success() {
        return Err("err.interpreter_speak_failed".into());
    }
    Ok(())
}

// O motor neural está disponível? A UI usa isto para oferecer a escolha SEM
// mentir: binário e modelo são coisas separadas e faltam separadamente.
#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NeuralStatus {
    pub binary: bool,
    pub model: bool,
    pub missing: Vec<String>,
    // A amostra é peça separada: binário, modelo e voz faltam separadamente, e a
    // tela precisa dizer QUAL falta em vez de um "indisponível" mudo.
    pub sample: bool,
}

#[tauri::command]
pub fn interpreter_neural_status() -> Result<NeuralStatus, String> {
    // ADR-0030: a sonda passa pela MESMA busca que o spawn. `resolve_engine`
    // devolve o nome cru quando não acha nada, então um caminho absoluto é o
    // sinal de que achou de verdade.
    let bin = neural_tts_bin();
    let binary = bin.is_absolute();
    let dir = voice_model_dir();
    let missing = voice_model_missing(&dir);
    Ok(NeuralStatus {
        binary,
        model: missing.is_empty(),
        missing: missing.into_iter().map(String::from).collect(),
        sample: crate::voice_sample::best_reference().is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("loro-interp-test-{tag}-{}", crate::epoch_millis()))
    }

    // MEDIDO 2026-09-07 — a saída REAL do `ffmpeg -f audiotoolbox
    // -list_devices true` nesta máquina. O nome carrega espaços e parênteses, e
    // o UID vem depois da ÚLTIMA vírgula.
    #[test]
    fn audiotoolbox_devices_are_read_with_their_real_names() {
        let out = "[AudioToolbox @ 0x1] CoreAudio devices:\n\
                   [AudioToolbox @ 0x1] [0]                  BlackHole 2ch, BlackHole2ch_UID\n\
                   [AudioToolbox @ 0x1] [1]        Microfone (MacBook Pro), BuiltInMicrophoneDevice\n\
                   [AudioToolbox @ 0x1] [2]    Alto-falantes (MacBook Pro), BuiltInSpeakerDevice\n";
        let d = parse_audiotoolbox_devices(out);
        assert_eq!(d.len(), 3, "{d:?}");
        assert_eq!(d[0].index, "0");
        assert_eq!(d[0].name, "BlackHole 2ch");
        assert_eq!(d[2].name, "Alto-falantes (MacBook Pro)");
    }

    // O DEFEITO que isto conserta: os índices do audiotoolbox NÃO são os ids do
    // `say`. "BlackHole 2ch" era 86 no `say` e 0 no audiotoolbox; passar 86 ao
    // ffmpeg falhou com "AudioObjecTGetPropertyData UID". Provado por captura —
    // tocando no índice 0 a entrada do BlackHole recebeu -4,6 dB, no 2 recebeu
    // -91 dB.
    #[test]
    fn the_two_engines_resolve_the_same_device_in_their_own_enumerations() {
        let say = parse_say_devices("   86 BlackHole 2ch\n   74 Alto-falantes (MacBook Pro)\n");
        let atb = parse_audiotoolbox_devices(
            "[x] [0] BlackHole 2ch, UID\n[x] [2] Alto-falantes (MacBook Pro), UID\n",
        );
        let name = "BlackHole 2ch";
        assert_eq!(resolve_device_id(&say, name).unwrap(), "86");
        assert_eq!(resolve_audiotoolbox_index(&atb, name).unwrap(), "0");
    }

    #[test]
    fn the_header_line_is_not_a_device() {
        let d = parse_audiotoolbox_devices("[AudioToolbox @ 0x1] CoreAudio devices:\n");
        assert!(d.is_empty(), "{d:?}");
    }

    #[test]
    fn a_device_that_is_gone_is_reported_not_guessed() {
        let atb = parse_audiotoolbox_devices("[x] [2] Alto-falantes (MacBook Pro), UID\n");
        assert!(resolve_audiotoolbox_index(&atb, "BlackHole 2ch").is_none());
    }

    // A listagem não pode TOCAR nada: entrada nula e duração mínima.
    #[test]
    fn listing_devices_plays_nothing() {
        let a = list_devices_args();
        assert!(a.iter().any(|x| x == "anullsrc"), "{a:?}");
        assert!(a.iter().any(|x| x == "-list_devices"), "{a:?}");
    }

    // ADR-0036 — o motor é escolha, e o PADRÃO é o barato. Medido: `say` 0,608s
    // contra 3,923s do Kokoro na mesma frase. Trocar o padrão gastaria toda a
    // latência que a ADR-0035 §6 comprou de volta.
    #[test]
    fn the_default_engine_is_the_fast_one() {
        assert_eq!(Engine::default(), Engine::System);
    }

    // Um SpeakInput sem `engine` continua válido e cai no motor barato: a UI
    // antiga não sabe do campo, e uma reunião não pode ficar 6x mais lenta por
    // causa de um payload sem um campo novo.
    #[test]
    fn an_input_without_an_engine_field_falls_back_to_the_system_voice() {
        let v: SpeakInput =
            serde_json::from_str(r#"{"text":"hi","voice":"Samantha","device":"BlackHole 2ch"}"#)
                .unwrap();
        assert_eq!(v.engine, Engine::System);
    }

    #[test]
    fn the_engine_is_selectable_from_the_wire() {
        let v: SpeakInput = serde_json::from_str(
            r#"{"text":"hi","voice":"0","device":"BlackHole 2ch","engine":"neural"}"#,
        )
        .unwrap();
        assert_eq!(v.engine, Engine::Neural);
    }

    // Um modelo pela metade não pode falhar no meio de uma reunião: o que falta
    // é nomeado antes de qualquer subprocesso.
    #[test]
    fn a_half_downloaded_voice_model_names_what_is_missing() {
        let d = tmp("zv-partial");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("tokens.txt"), b"x").unwrap();
        let missing = voice_model_missing(&d);
        assert!(missing.contains(&"encoder.int8.onnx"), "{missing:?}");
        // O vocoder é download SEPARADO na origem — esquecê-lo era o jeito mais
        // fácil de ter um modelo "completo" que não fala.
        assert!(missing.contains(&VOCODER_FILE), "{missing:?}");
        assert!(!missing.contains(&"tokens.txt"), "{missing:?}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_complete_voice_model_is_missing_nothing() {
        let d = tmp("zv-full");
        std::fs::create_dir_all(d.join("espeak-ng-data")).unwrap();
        for f in [
            "encoder.int8.onnx",
            "decoder.int8.onnx",
            "lexicon.txt",
            "tokens.txt",
            VOCODER_FILE,
        ] {
            std::fs::write(d.join(f), b"x").unwrap();
        }
        assert!(voice_model_missing(&d).is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    // O texto vai por arquivo também no motor neural (BR-8), e o WAV é um passo
    // separado porque o binário que toca enquanto gera só alcança o dispositivo
    // padrão (ADR-0036 §4).
    #[test]
    fn the_neural_engine_reads_text_from_a_file_and_writes_a_wav() {
        let a = zipvoice_args(
            Path::new("/m"),
            "8",
            "/tmp/o.wav",
            "Good morning.",
            "/v/phrase-1.wav",
            "O rápido cão marrom pulou sobre a cerca do jardim.",
        );
        assert!(
            a.iter().any(|x| x == "--output-filename=/tmp/o.wav"),
            "{a:?}"
        );
        // MEDIDO: o binário recusa `--text-file` ("Invalid option") e não tem
        // equivalente, então o texto é POSICIONAL — e vem depois de "--", senão
        // uma tradução iniciada por "-" seria lida como flag.
        assert!(!a.iter().any(|x| x.starts_with("--text-file")), "{a:?}");
        let sep = a.iter().position(|x| x == "--").expect("no -- separator");
        assert_eq!(a[sep + 1], "Good morning.");
        assert_eq!(sep + 2, a.len(), "o texto não é o último argumento");
    }

    // Uma tradução que comece com "-" não pode virar flag.
    #[test]
    fn a_translation_starting_with_a_dash_is_still_text() {
        let a = zipvoice_args(
            Path::new("/m"),
            "8",
            "/tmp/o.wav",
            "-- not a flag",
            "/v/p.wav",
            "ref",
        );
        let sep = a.iter().position(|x| x == "--").expect("no separator");
        assert_eq!(a[sep + 1], "-- not a flag");
    }

    // A voz clonada precisa do áudio E do texto da referência. Passar só o
    // áudio faria o modelo adivinhar o que foi dito, e é isso que degrada a voz.
    //
    // E o Kokoro NÃO faz isto: ele só tem vozes pré-definidas escolhidas por
    // --sid, sem nenhuma referência de áudio. Foi por isso que ele saiu.
    #[test]
    fn the_cloned_voice_gets_both_the_sample_and_its_exact_text() {
        let text = "O rápido cão marrom pulou sobre a cerca do jardim.";
        let a = zipvoice_args(
            Path::new("/m"),
            "8",
            "/tmp/o.wav",
            "Good morning.",
            "/v/phrase-1.wav",
            text,
        );
        assert!(
            a.iter().any(|x| x == "--reference-audio=/v/phrase-1.wav"),
            "{a:?}"
        );
        assert!(
            a.iter().any(|x| x == &format!("--reference-text={text}")),
            "{a:?}"
        );
        // e o vocoder, que é o arquivo que mais se esquece
        assert!(
            a.iter().any(|x| x.starts_with("--zipvoice-vocoder=")),
            "{a:?}"
        );
    }

    // A reprodução tem de ir para o dispositivo ESCOLHIDO — é a mesma
    // invariante do `say -a`: sem isso a voz cai no alto-falante e volta pelo
    // microfone.
    #[test]
    fn playback_targets_the_chosen_device_never_the_default() {
        let a = play_args("/tmp/o.wav", "86");
        let i = a
            .iter()
            .position(|x| x == "-audio_device_index")
            .expect("no device flag");
        assert_eq!(a[i + 1], "86");
        assert!(a.iter().any(|x| x == "audiotoolbox"), "{a:?}");
    }

    // ADR-0035 §2 — o achado que obriga este módulo a escolher o modelo. Sem
    // esta guarda o modo fala PORTUGUÊS com voz inglesa e não avisa ninguém.
    // MEDIDO 2026-09-06: o driver estava em /Library/Audio/Plug-Ins/HAL e o
    // CoreAudio NÃO o listava — o `coreaudiod` só varre o diretório ao subir.
    // "Instalado" e "disponível" são estados diferentes; sem separá-los a pessoa
    // vê um dispositivo que teima em não aparecer e não tem o que fazer.
    #[test]
    fn installed_but_not_loaded_is_its_own_state_with_its_own_step() {
        let s = audio_setup_from(true, false);
        assert_eq!(s.state, "installed_not_loaded");
        assert!(s.command.contains("coreaudiod"), "{}", s.command);
    }

    #[test]
    fn nothing_installed_asks_for_the_install_not_a_restart() {
        let s = audio_setup_from(false, false);
        assert_eq!(s.state, "missing");
        assert!(s.command.contains("blackhole"), "{}", s.command);
    }

    #[test]
    fn a_listed_device_is_ready_and_asks_for_nothing() {
        let s = audio_setup_from(true, true);
        assert_eq!(s.state, "ready");
        assert!(s.command.is_empty());
    }

    #[test]
    fn a_virtual_output_is_recognised_by_name_across_platforms() {
        for n in [
            "BlackHole 2ch",
            "CABLE Input (VB-Audio Virtual Cable)",
            "Loopback Audio",
        ] {
            assert!(is_virtual_output(n), "{n}");
        }
        for n in [
            "Alto-falantes (MacBook Pro)",
            "AirPods Pro",
            "Studio Display Speakers",
        ] {
            assert!(!is_virtual_output(n), "{n}");
        }
    }

    #[test]
    fn the_default_turbo_model_cannot_translate_and_is_refused() {
        assert!(!model_translates("large-v3-turbo"));
        assert!(model_translates("small"));
        assert!(model_translates("medium"));
    }

    #[test]
    fn translate_refuses_the_turbo_before_spending_a_single_subprocess() {
        let err = translate_blocking(TranslateInput {
            data: vec![1, 2, 3],
            model: "large-v3-turbo".into(),
            lang: "pt".into(),
        })
        .unwrap_err();
        assert!(err.starts_with("err.model_cannot_translate:"), "{err}");
    }

    // A voz fala mais rápido que o padrão: cada elocução encurtada é atraso que
    // não se acumula na conversa seguinte (ADR-0035 §6).
    #[test]
    fn the_voice_speaks_faster_than_the_default_so_the_lag_drains() {
        let a = say_args("Samantha", "74", "/tmp/t.txt");
        let i = a.iter().position(|x| x == "-r").expect("no -r flag");
        assert_eq!(a[i + 1], "210");
        assert!(SPEAK_RATE_WPM > 175, "not faster than the say default");
    }

    #[test]
    fn say_always_routes_to_the_chosen_device() {
        let a = say_args("Samantha", "74", "/tmp/t.txt");
        let i = a.iter().position(|x| x == "-a").expect("no -a flag");
        assert_eq!(a[i + 1], "74");
    }

    // O texto vai por arquivo: uma tradução iniciada por "-" viraria flag, e
    // conteúdo de fala não pode aparecer numa linha de comando (BR-8).
    #[test]
    fn say_passes_the_text_by_file_never_as_an_argument() {
        let a = say_args("Samantha", "74", "/tmp/t.txt");
        let i = a.iter().position(|x| x == "-f").expect("no -f flag");
        assert_eq!(a[i + 1], "/tmp/t.txt");
        assert!(!a.iter().any(|x| x.starts_with("Good morning")));
    }

    #[test]
    fn speak_without_a_device_is_refused() {
        let err = speak_blocking(SpeakInput {
            text: "hello".into(),
            voice: "Samantha".into(),
            device: "  ".into(),
            engine: Engine::System,
        })
        .unwrap_err();
        assert_eq!(err, "err.interpreter_no_device");
    }

    // O formato real do `say -a '?'` nesta máquina (2026-09-06).
    #[test]
    fn parse_say_devices_reads_id_and_name_with_spaces_and_parens() {
        let d = parse_say_devices("   86 BlackHole 2ch\n   74 Alto-falantes (MacBook Pro)\n");
        assert_eq!(
            d,
            vec![
                OutputDevice {
                    id: "86".into(),
                    name: "BlackHole 2ch".into()
                },
                OutputDevice {
                    id: "74".into(),
                    name: "Alto-falantes (MacBook Pro)".into()
                },
            ]
        );
    }

    #[test]
    fn parse_say_devices_ignores_headers_and_blank_lines() {
        let d = parse_say_devices("Known audio devices:\n\n   74 Speakers\ngarbage\n");
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].id, "74");
    }

    // REGRESSÃO do defeito medido em 2026-09-06: instalar o BlackHole e
    // reiniciar o coreaudiod moveu "Alto-falantes" de 71 para 74. Guardar o id
    // faria o app falar no aparelho errado; guardar o NOME sobrevive.
    #[test]
    fn a_device_is_found_by_name_even_after_every_id_shifted() {
        let before = parse_say_devices("   71 Alto-falantes (MacBook Pro)\n");
        let after = parse_say_devices("   86 BlackHole 2ch\n   74 Alto-falantes (MacBook Pro)\n");
        let name = "Alto-falantes (MacBook Pro)";
        assert_eq!(resolve_device_id(&before, name).unwrap(), "71");
        assert_eq!(resolve_device_id(&after, name).unwrap(), "74");
        assert_eq!(resolve_device_id(&after, "BlackHole 2ch").unwrap(), "86");
    }

    #[test]
    fn a_device_that_was_unplugged_is_reported_missing_not_guessed() {
        let now = parse_say_devices("   74 Alto-falantes (MacBook Pro)\n");
        assert!(resolve_device_id(&now, "BlackHole 2ch").is_none());
    }

    // O formato real do `say -v '?'`: o nome carrega espaços e parênteses
    // ANINHADOS, e o locale é o último campo antes do "#".
    #[test]
    fn parse_voices_keeps_names_with_spaces_and_nested_parens() {
        let v = parse_voices(
            "Bad News            en_US    # Hello! My name is Bad News.\n\
             Eddy (Inglês (Reino Unido)) en_GB    # Hello! My name is Eddy.\n\
             Samantha            en_US    # Hello! My name is Samantha.\n",
        );
        assert_eq!(v[0].name, "Bad News");
        assert_eq!(v[0].locale, "en_US");
        assert_eq!(v[1].name, "Eddy (Inglês (Reino Unido))");
        assert_eq!(v[1].locale, "en_GB");
        assert_eq!(v[2].name, "Samantha");
    }

    #[test]
    fn only_english_voices_are_offered_because_tr_only_makes_english() {
        let all = parse_voices(
            "Samantha  en_US  # Hello!\n\
             Luciana   pt_BR  # Olá!\n\
             Daniel    en_GB  # Hello!\n\
             Eddy (Alemão (Alemanha)) de_DE # Hallo!\n",
        );
        let en = english_voices(&all);
        assert_eq!(en.len(), 2);
        assert!(en.iter().all(|v| v.locale.starts_with("en_")));
        assert!(!en.iter().any(|v| v.name == "Luciana"));
    }

    // ADR-0034 aplicada a vozes: nada de lista de bloqueio. As vozes-piada da
    // Apple continuam na lista, e a pré-escuta da UI é quem resolve — uma regra
    // larga o bastante para matar "Bahh" mataria voz premium legítima.
    #[test]
    fn novelty_voices_are_not_filtered_out_the_ear_decides() {
        let all = parse_voices("Bahh  en_US  # Hello!\nSamantha  en_US  # Hello!\n");
        assert_eq!(english_voices(&all).len(), 2);
    }

    #[test]
    fn join_segments_makes_one_utterance_out_of_the_windows_pieces() {
        let segs = vec![
            crate::SpokenSegment {
                t_ms: 0,
                end_ms: 1000,
                text: " Good morning guys, ".into(),
            },
            crate::SpokenSegment {
                t_ms: 1000,
                end_ms: 2000,
                text: "  ".into(),
            },
            crate::SpokenSegment {
                t_ms: 2000,
                end_ms: 3000,
                text: "I wanted to discuss the schedule.".into(),
            },
        ];
        assert_eq!(
            join_segments(&segs),
            "Good morning guys, I wanted to discuss the schedule."
        );
    }
}
