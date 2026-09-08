// Leitura em voz alta, para acessibilidade (ADR-0037).
//
// Dita o documento aberto (ou o trecho selecionado) pelo `say`, no dispositivo
// de saída PADRÃO — o fone da pessoa. É a diferença que separa este modo do
// intérprete: o intérprete fala para DENTRO de um driver virtual porque o
// destino é a outra ponta de uma chamada; aqui o destino é o próprio ouvido, e
// forçar um dispositivo seria errado.
//
// A extração de prosa (markdown -> texto falável) NÃO está aqui: ela vive em
// `src/readaloud.js`, do lado que tem o documento aberto, e é lá que está
// testada. Este módulo recebe texto pronto e cuida do processo.
//
// PAUSA DE VERDADE, medida (2026-09-08): SIGSTOP no processo do `say` e captura
// do que saiu no áudio, segundo a segundo —
//   t=0..2s   -6,1 / -2,3 dB   falando
//   t=2..4s   -91,0 dB         SIGSTOP: silêncio digital, imediato
//   t=4..7s   -4,5 / -2,6 dB   SIGCONT: voltou
// O estado do processo (`T` parado, `S` acordado) provava só que o processo
// parou; o que prova que a PAUSA existe é o áudio, e é por isso que a medida foi
// feita gravando a saída em vez de olhar o `ps`.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[cfg(target_os = "macos")]
const SAY: &str = "/usr/bin/say";

// Velocidade da leitura. O padrão do `say` (~175 wpm) é confortável para ouvir
// um documento inteiro; o intérprete usa 210 porque lá a pressa é para o atraso
// não acumular numa conversa (ADR-0036). Ler não tem essa pressa, e apressar
// piora a compreensão de quem depende do áudio.
pub const READ_RATE_WPM: u32 = 175;

// O processo que está falando agora, se houver. Um só: começar uma leitura nova
// corta a anterior — duas vozes simultâneas no mesmo ouvido não são um recurso.
#[derive(Default)]
pub struct Reader {
    child: Option<std::process::Child>,
    paused: bool,
}

pub fn reader() -> &'static Mutex<Reader> {
    static R: std::sync::OnceLock<Mutex<Reader>> = std::sync::OnceLock::new();
    R.get_or_init(|| Mutex::new(Reader::default()))
}

#[derive(Serialize, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReadState {
    pub speaking: bool,
    pub paused: bool,
    pub supported: bool,
}

// Manda um sinal por PID, pelo `kill` do sistema.
//
// POR QUE NÃO a crate `libc`: seriam duas chamadas de `kill()` custando uma
// dependência nova num Cargo.toml que tem 9 de propósito. Este app já resolve o
// que é do sistema saindo para o sistema — `say`, `ffmpeg`, `curl`, `tar`,
// `shasum` — e `/bin/kill -STOP` foi verificado aqui (2026-09-08: estado do
// processo T com STOP, S com CONT).
#[cfg(unix)]
fn signal(pid: u32, sig: &str) {
    let _ = crate::proc::command(Path::new("/bin/kill"))
        .arg(format!("-{sig}"))
        .arg(pid.to_string())
        .status();
}

// Argumentos do `say` para LER. Sem `-a`: a leitura sai no dispositivo padrão,
// que é onde a pessoa está ouvindo. O texto vai por ARQUIVO (`-f`) — fala não
// aparece em linha de comando (BR-8), e um documento que comece com "-" não
// pode virar flag.
pub fn read_args(voice: &str, rate: u32, text_file: &str) -> Vec<String> {
    let mut a = Vec::new();
    if !voice.is_empty() {
        a.push("-v".into());
        a.push(voice.into());
    }
    a.push("-r".into());
    a.push(rate.to_string());
    a.push("-f".into());
    a.push(text_file.into());
    a
}

// Uma voz do sistema, para o seletor da leitura.
#[derive(Serialize, PartialEq, Debug, Clone)]
pub struct ReadVoice {
    pub name: String,
    pub locale: String,
}

// TODAS as vozes, de todos os idiomas — e é de propósito. O seletor do
// intérprete filtra para `en_*` porque o `-tr` do whisper só produz inglês
// (ADR-0036); aqui o texto é o do documento, que neste app é normalmente
// português. Herdar aquele filtro daria uma lista sem uma única voz utilizável.
pub fn parse_voices(out: &str) -> Vec<ReadVoice> {
    out.lines()
        .filter_map(|line| {
            let left = line.split('#').next()?.trim();
            let (name, locale) = left.rsplit_once(char::is_whitespace)?;
            let name = name.trim();
            if name.is_empty() || !locale.contains('_') {
                return None;
            }
            Some(ReadVoice {
                name: name.to_string(),
                locale: locale.to_string(),
            })
        })
        .collect()
}

// As vozes BOAS de cada idioma, em ordem de preferência.
//
// POR QUE ISTO EXISTE, medido em 2026-09-08: "a primeira do locale" era o
// critério, e a ordem do `say -v '?'` em pt_BR é
//   Eddy · Flo · Grandma · Grandpa · Luciana
// — as quatro primeiras são as vozes-PERSONAGEM que a Apple adicionou, e a voz
// de verdade é a última. O modo lia todo documento em português com a voz do
// "Eddy", que foi o relato do dono: "a voz está bem ruim".
//
// É lista POSITIVA, não de bloqueio: diz quais são conhecidamente boas em vez de
// tentar adivinhar quais são piada — a lição da ADR-0034 aplicada a vozes, e a
// razão de o seletor manual continuar oferecendo TODAS.
const PREFERRED: &[(&str, &[&str])] = &[
    ("pt", &["Luciana", "Joana", "Felipe"]),
    ("en", &["Samantha", "Alex", "Daniel", "Karen"]),
    ("es", &["Mónica", "Paulina", "Jorge"]),
    ("fr", &["Thomas", "Amélie", "Audrey"]),
    ("it", &["Alice", "Luca"]),
    ("de", &["Anna", "Markus"]),
];

// A voz padrão para um idioma: a primeira PREFERIDA que exista; sem nenhuma
// delas, a primeira do locale; sem locale, vazio — e aí o `say` usa a voz do
// sistema, que é degradar para a escolha da pessoa em vez de recusar a ler.
pub fn default_voice_for(voices: &[ReadVoice], lang: &str) -> String {
    let lang = lang.to_lowercase();
    let pref = format!("{lang}_");
    let of_lang = |v: &&ReadVoice| v.locale.to_lowercase().starts_with(&pref);
    if let Some((_, wanted)) = PREFERRED.iter().find(|(l, _)| *l == lang) {
        for w in *wanted {
            if let Some(v) = voices.iter().filter(of_lang).find(|v| v.name == *w) {
                return v.name.clone();
            }
        }
    }
    voices
        .iter()
        .find(of_lang)
        .map(|v| v.name.clone())
        .unwrap_or_default()
}

// Corta a leitura em curso — para quem está FORA deste módulo (o wiring do app,
// ao esconder a janela ou ao sair). Fechar a janela do Loro só a ESCONDE
// (CloseRequested faz prevent_close + hide), então sem isto a voz seguia lendo
// um documento que a pessoa não vê mais — foi o relato do dono em 2026-09-08.
pub fn stop_reading() {
    #[cfg(target_os = "macos")]
    stop_current();
}

#[cfg(target_os = "macos")]
fn say_voice_listing() -> Result<String, String> {
    let out = crate::proc::command(Path::new(SAY))
        .args(["-v", "?"])
        .output()
        .map_err(|e| e.to_string())?;
    // O `say -v '?'` escreve a lista e sai com status de ERRO (não é um pedido
    // de fala), então o status não é o critério — a lista é.
    Ok(String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr))
}

#[tauri::command]
pub fn read_aloud_voices() -> Result<Vec<ReadVoice>, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(parse_voices(&say_voice_listing()?))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("err.read_aloud_unsupported".into())
    }
}

#[derive(Deserialize)]
pub struct ReadInput {
    pub text: String,
    #[serde(default)]
    pub voice: String,
    // O idioma do documento, para escolher a voz quando o usuário não escolheu.
    // Sem isto o `say` usa a voz do SISTEMA, que num Mac configurado em inglês
    // leria um documento em português com voz inglesa — ininteligível, e a pessoa
    // não teria como saber que era só uma questão de voz.
    #[serde(default)]
    pub lang: String,
}

fn text_path() -> PathBuf {
    std::env::temp_dir().join(format!(".loro-read.{}.txt", crate::epoch_millis()))
}

#[tauri::command]
pub fn read_aloud_start(input: ReadInput) -> Result<ReadState, String> {
    if input.text.trim().is_empty() {
        return Err("err.read_aloud_nothing_to_read".into());
    }
    #[cfg(target_os = "macos")]
    {
        // A voz escolhida ganha; sem escolha, a primeira PREFERIDA do idioma do
        // documento; sem voz para o idioma, vazio — e aí o `say` usa a do
        // sistema, que é degradar para a preferência da pessoa em vez de recusar
        // a ler. Resolvida ANTES da trava: listar vozes é subprocesso, e não se
        // segura uma trava esperando por um.
        let voice = if !input.voice.is_empty() {
            input.voice.clone()
        } else if !input.lang.is_empty() {
            default_voice_for(&parse_voices(&say_voice_listing()?), &input.lang)
        } else {
            String::new()
        };
        let f = text_path();
        std::fs::write(&f, input.text.as_bytes()).map_err(|e| e.to_string())?;

        // MATAR o anterior e GUARDAR o novo sob a MESMA trava.
        //
        // DEFEITO CORRIGIDO (2026-09-08, "clicar duas vezes sobrepõe os áudios"):
        // antes era `stop_current()` e depois um `lock()` separado. Dois cliques
        // rápidos entram na janela entre as duas travas — o segundo mata "nada"
        // porque o primeiro ainda não guardou o filho, e então o primeiro `say`
        // fica órfão e audível junto do segundo. Com uma trava só, a troca é
        // atômica e a voz nunca dobra.
        let mut r = reader().lock().map_err(|_| "err.read_aloud_busy")?;
        if let Some(mut old) = r.child.take() {
            // CONT antes de matar: um processo PARADO não processa o TERM.
            signal(old.id(), "CONT");
            let _ = old.kill();
            let _ = old.wait();
        }
        r.paused = false;
        let child = crate::proc::command(Path::new(SAY))
            .args(read_args(&voice, READ_RATE_WPM, &f.to_string_lossy()))
            .spawn()
            .map_err(|e| e.to_string())?;
        // O temporário é do PROCESSO, não desta chamada: o `say` lê o arquivo
        // enquanto fala, então apagá-lo aqui truncaria a leitura. Os antigos são
        // varridos no `stop_current`, e o nome único evita disputa de caminho.
        r.child = Some(child);
        Ok(ReadState {
            speaking: true,
            paused: false,
            supported: true,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("err.read_aloud_unsupported".into())
    }
}

// Mata a leitura em curso e limpa os temporários que ela deixou.
#[cfg(target_os = "macos")]
fn stop_current() {
    if let Ok(mut r) = reader().lock() {
        if let Some(mut c) = r.child.take() {
            // CONT antes de matar: um processo PARADO não processa o TERM e
            // ficaria pendurado, com o `wait` esperando para sempre.
            signal(c.id(), "CONT");
            let _ = c.kill();
            let _ = c.wait();
        }
        r.paused = false;
    }
    // Os temporários desta sessão de leitura.
    if let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) {
        for e in entries.filter_map(|e| e.ok()) {
            let n = e.file_name();
            let n = n.to_string_lossy();
            if n.starts_with(".loro-read.") && n.ends_with(".txt") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

#[tauri::command]
pub fn read_aloud_stop() -> Result<ReadState, String> {
    #[cfg(target_os = "macos")]
    {
        stop_current();
        Ok(ReadState {
            speaking: false,
            paused: false,
            supported: true,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("err.read_aloud_unsupported".into())
    }
}

// Pausa e retomada por SINAL, não por matar-e-recomeçar: recomeçar voltaria ao
// início do documento, que para quem ouve é perder o lugar na página. Medido:
// SIGSTOP dá silêncio digital imediato (-91 dB) e SIGCONT retoma exatamente de
// onde parou.
#[tauri::command]
pub fn read_aloud_pause() -> Result<ReadState, String> {
    #[cfg(target_os = "macos")]
    {
        let mut r = reader().lock().map_err(|_| "err.read_aloud_busy")?;
        // O PID sai ANTES do resto: manter o `child` emprestado enquanto se lê
        // `paused` é empréstimo mutável e imutável ao mesmo tempo.
        let Some(pid) = r.child.as_ref().map(|c| c.id()) else {
            return Ok(ReadState {
                speaking: false,
                paused: false,
                supported: true,
            });
        };
        let sig = if r.paused { "CONT" } else { "STOP" };
        signal(pid, sig);
        r.paused = !r.paused;
        Ok(ReadState {
            speaking: true,
            paused: r.paused,
            supported: true,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("err.read_aloud_unsupported".into())
    }
}

#[tauri::command]
pub fn read_aloud_state() -> Result<ReadState, String> {
    #[cfg(target_os = "macos")]
    {
        let mut r = reader().lock().map_err(|_| "err.read_aloud_busy")?;
        // O estado é DERIVADO do processo, não de um sinalizador guardado: uma
        // leitura que terminou sozinha tem de aparecer como parada, senão o
        // botão fica oferecendo "pausar" o que já calou.
        let done = match r.child.as_mut() {
            None => true,
            Some(c) => matches!(c.try_wait(), Ok(Some(_))),
        };
        if done {
            r.child = None;
            r.paused = false;
        }
        Ok(ReadState {
            speaking: !done,
            paused: r.paused,
            supported: true,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(ReadState {
            speaking: false,
            paused: false,
            supported: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Sem `-a`: a leitura sai no dispositivo PADRÃO. É a diferença de propósito
    // com o intérprete, que força o driver virtual — aqui o destino é o ouvido
    // da pessoa, e forçar um dispositivo seria errado.
    #[test]
    fn reading_goes_to_the_default_device_never_a_forced_one() {
        let a = read_args("Luciana", READ_RATE_WPM, "/tmp/t.txt");
        assert!(!a.iter().any(|x| x == "-a"), "{a:?}");
    }

    // O texto vai por arquivo: fala não aparece em linha de comando (BR-8), e um
    // documento que comece com "-" não pode ser lido como flag.
    #[test]
    fn the_document_goes_by_file_never_as_an_argument() {
        let a = read_args("Luciana", READ_RATE_WPM, "/tmp/t.txt");
        let i = a.iter().position(|x| x == "-f").expect("sem -f");
        assert_eq!(a[i + 1], "/tmp/t.txt");
    }

    // Ler não tem a pressa do intérprete: apressar piora a compreensão de quem
    // depende do áudio (o intérprete usa 210 porque lá o atraso acumula).
    #[test]
    fn reading_is_slower_than_the_interpreter_on_purpose() {
        assert_eq!(READ_RATE_WPM, 175);
        assert!(READ_RATE_WPM < crate::interpreter::SPEAK_RATE_WPM);
        let a = read_args("", READ_RATE_WPM, "/tmp/t.txt");
        let i = a.iter().position(|x| x == "-r").expect("sem -r");
        assert_eq!(a[i + 1], "175");
    }

    #[test]
    fn no_voice_means_the_system_voice_not_a_broken_flag() {
        let a = read_args("", READ_RATE_WPM, "/tmp/t.txt");
        assert!(!a.iter().any(|x| x == "-v"), "{a:?}");
    }

    // A lista NÃO é filtrada por idioma, ao contrário da do intérprete: o texto
    // aqui é o do documento, que neste app é normalmente português. Herdar o
    // filtro `en_*` daria uma lista sem uma voz utilizável.
    #[test]
    fn every_language_is_offered_because_the_document_is_not_english() {
        let out = "Luciana            pt_BR    # Olá! Meu nome é Luciana.\n\
                   Samantha           en_US    # Hello! My name is Samantha.\n\
                   Eddy (Alemão (Alemanha)) de_DE # Hallo!\n";
        let v = parse_voices(out);
        assert_eq!(v.len(), 3, "{v:?}");
        assert!(v.iter().any(|x| x.locale == "pt_BR"));
        assert!(v.iter().any(|x| x.locale == "de_DE"));
    }

    // O nome carrega espaços e parênteses aninhados; o locale é o último campo
    // antes do "#" (o mesmo formato que o intérprete já mede).
    #[test]
    fn a_voice_name_with_spaces_and_parens_survives() {
        let v = parse_voices("Eddy (Inglês (Reino Unido)) en_GB # Hello!\n");
        assert_eq!(v[0].name, "Eddy (Inglês (Reino Unido))");
        assert_eq!(v[0].locale, "en_GB");
    }

    // O DEFEITO medido: em pt_BR a ordem do `say` é Eddy, Flo, Grandma, Grandpa,
    // Luciana — as quatro primeiras são vozes-personagem, e "a primeira do
    // locale" escolhia o Eddy para ler todo documento em português.
    #[test]
    fn the_character_voices_do_not_win_just_by_coming_first() {
        let v = parse_voices(
            "Eddy (Português (Brasil)) pt_BR # Olá\n\
             Flo (Português (Brasil)) pt_BR # Olá\n\
             Grandma (Português (Brasil)) pt_BR # Olá\n\
             Grandpa (Português (Brasil)) pt_BR # Olá\n\
             Luciana   pt_BR # Olá\n",
        );
        assert_eq!(
            default_voice_for(&v, "pt"),
            "Luciana",
            "escolheu voz-personagem"
        );
    }

    #[test]
    fn the_preference_order_is_respected_when_more_than_one_is_there() {
        let v = parse_voices("Alex en_US # Hi\nSamantha en_US # Hi\n");
        // Samantha vem antes de Alex na preferência, mesmo listada depois.
        assert_eq!(default_voice_for(&v, "en"), "Samantha");
    }

    // Sem nenhuma preferida, cai na primeira do idioma: é pior que a preferida e
    // melhor que não ler.
    #[test]
    fn with_no_preferred_voice_it_still_reads() {
        let v = parse_voices("Zé (Português) pt_BR # Olá\n");
        assert_eq!(default_voice_for(&v, "pt"), "Zé (Português)");
    }

    #[test]
    fn the_default_voice_follows_the_document_language() {
        let v =
            parse_voices("Samantha  en_US # Hi\nLuciana   pt_BR # Olá\nFelipe    pt_BR # Olá\n");
        assert_eq!(default_voice_for(&v, "pt"), "Luciana");
        assert_eq!(default_voice_for(&v, "en"), "Samantha");
    }

    // Sem voz para o idioma, degrada para a escolha do usuário no painel do
    // macOS — recusar a ler seria pior que ler com outra voz.
    #[test]
    fn a_language_with_no_voice_degrades_instead_of_refusing() {
        let v = parse_voices("Samantha en_US # Hi\n");
        assert_eq!(default_voice_for(&v, "ja"), "");
    }

    #[test]
    fn nothing_to_read_is_refused_before_spawning_anything() {
        for vazio in ["", "   ", "\n\n"] {
            let err = read_aloud_start(ReadInput {
                text: vazio.into(),
                voice: String::new(),
                lang: String::new(),
            })
            .unwrap_err();
            assert_eq!(err, "err.read_aloud_nothing_to_read", "{vazio:?}");
        }
    }

    // O estado nasce parado e diz se a plataforma tem o recurso — a tela precisa
    // da diferença entre "não está lendo" e "não existe aqui".
    #[test]
    fn the_state_starts_silent_and_declares_the_platform() {
        let s = read_aloud_state().unwrap();
        assert!(!s.speaking);
        assert!(!s.paused);
        assert_eq!(s.supported, cfg!(target_os = "macos"));
    }

    // Pausar sem nada lendo não é erro: é uma tecla apertada fora de hora, e
    // responder com o estado real é melhor que estourar.
    #[test]
    fn pausing_with_nothing_playing_answers_the_real_state() {
        let s = read_aloud_stop().unwrap();
        assert!(!s.speaking);
        #[cfg(target_os = "macos")]
        {
            let p = read_aloud_pause().unwrap();
            assert!(!p.speaking);
            assert!(!p.paused);
        }
    }
}
