// A instalação do motor de voz clonada, para quem não tem nada (ADR-0036 §5).
//
// São TRÊS peças e elas faltam separadamente — o binário do motor, o modelo e o
// vocoder. Tratá-las como uma só produzia o pior estado possível: "instalado"
// com o vocoder faltando, que carrega e não fala. Cada uma tem URL, tamanho e
// SHA-256 próprios, e a tela diz qual falta.
//
// MESMA POSTURA DOS MODELOS DO WHISPER (ADR-0006): nada disto vem no app. O
// download é do usuário, por HTTPS, com hash fixado e instalação atômica. É o
// que mantém o Loro sem redistribuir peso — e, no caso do modelo de voz, sem
// redistribuir um checkpoint cuja licença é NÃO comercial (a tela declara isso
// antes do download; ver interpreter.rs::VOICE_MODEL_ID).
//
// Os SHA-256 vieram do campo `digest` da API de releases do GitHub e foram
// CONFERIDOS contra `shasum -a 256` dos arquivos baixados (2026-09-07): os três
// casaram. Fixar sem conferir seria confiar no que se leu, não no que se tem.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::paths::which;

// A versão do motor é FIXADA: os nomes dos artefatos e os hashes são dela, e um
// "latest" trocaria os dois sem avisar.
pub const ENGINE_VERSION: &str = "1.13.7";

const REL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

// O artefato do motor desta plataforma, e por que `shared` e não `static`:
// medido 2026-09-07, o estático são 114 MB no Windows contra 7 MB do
// compartilhado (ADR-0036 §1). O binário acha as bibliotecas por
// `@loader_path/../lib`, então bin/ e lib/ TÊM de ficar irmãos na instalação.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const ENGINE: (&str, &str, u64) = (
    "osx-arm64-shared",
    "c4789fc9d1d06c0c8095aaadba040f524db869c0f90ac40db93aa71bb4375996",
    20_262_139,
);
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const ENGINE: (&str, &str, u64) = (
    "osx-x64-shared",
    "41f721066362eb80dd5cf648922978577b254183fc47199bb4902fcca2221e7d",
    22_650_210,
);
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const ENGINE: (&str, &str, u64) = (
    "linux-x64-shared",
    "95b9f4358e2d5522a0bd987c3ee91128e31f8abf4340927cab32e438300f3c24",
    27_884_774,
);
// NÃO TESTADO em Windows: o artefato e o hash vêm da mesma API, mas nem a
// extração nem o `@loader_path` equivalente (as DLLs ao lado do .exe) foram
// exercitados numa máquina Windows. A instalação é oferecida; se falhar, falha
// dizendo qual peça, e o motor do sistema continua o padrão.
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const ENGINE: (&str, &str, u64) = (
    "win-x64-shared-MT-Release",
    "0b8f4a8cdde53cee671b0647947c66e10efec1b63ed2606c8eeac650071c9c60",
    24_500_658,
);
#[cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "macos", target_arch = "x86_64"),
    all(target_os = "linux", target_arch = "x86_64"),
    all(target_os = "windows", target_arch = "x86_64"),
)))]
const ENGINE: (&str, &str, u64) = ("", "", 0);

pub const MODEL_ARCHIVE: &str = "sherpa-onnx-zipvoice-distill-int8-zh-en-emilia";
pub const MODEL_SHA: &str = "77219c8b40f4ee8d73a7f902305ff6c1128ef9b54461c41b4ca6ed890b6c2803";
pub const MODEL_SIZE: u64 = 109_162_785;

pub const VOCODER_SHA: &str = "bcb3b970e384161c4d634f0bb9e999ff1c471b34c9bc0b1049a5014065ed3cc0";
pub const VOCODER_SIZE: u64 = 54_157_409;

// O nome do executável do motor, por plataforma.
pub fn engine_exe() -> &'static str {
    if cfg!(windows) {
        "sherpa-onnx-offline-tts.exe"
    } else {
        "sherpa-onnx-offline-tts"
    }
}

// Onde o motor é instalado. `~/.loro/bin` JÁ está em `known_bin_dirs()`, então
// `resolve_engine` o acha sem tocar no PATH do usuário — e `~/.loro/lib` é o
// irmão que o `@loader_path/../lib` do binário procura. Os dois juntos são o
// contrato; separá-los dá um binário que existe e não roda.
pub fn engine_bin_dir() -> PathBuf {
    crate::paths::loro_data_dir().join("bin")
}
pub fn engine_lib_dir() -> PathBuf {
    crate::paths::loro_data_dir().join("lib")
}

#[derive(Serialize, PartialEq, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub id: String,
    pub label: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub installed: bool,
}

pub fn engine_url() -> String {
    format!(
        "{REL}/v{ENGINE_VERSION}/sherpa-onnx-v{ENGINE_VERSION}-{}.tar.bz2",
        ENGINE.0
    )
}
pub fn model_url() -> String {
    format!("{REL}/tts-models/{MODEL_ARCHIVE}.tar.bz2")
}
pub fn vocoder_url() -> String {
    format!("{REL}/vocoder-models/{}", crate::interpreter::VOCODER_FILE)
}

// O motor está instalado quando o executável existe NO NOSSO diretório ou em
// qualquer lugar que a busca de engines alcance — quem já o tem pelo Homebrew
// não deve ser obrigado a baixar de novo.
pub fn engine_installed() -> bool {
    crate::interpreter::neural_tts_bin().is_absolute()
}

pub fn parts() -> Vec<Part> {
    let dir = crate::interpreter::voice_model_dir();
    // O modelo conta como instalado quando TODOS os seus arquivos estão lá,
    // menos o vocoder — que é download separado e tem a sua própria linha.
    let model_ok = crate::interpreter::voice_model_missing(&dir)
        .iter()
        .all(|f| *f == crate::interpreter::VOCODER_FILE);
    vec![
        Part {
            id: "engine".into(),
            label: "motor de voz (sherpa-onnx)".into(),
            url: engine_url(),
            sha256: ENGINE.1.into(),
            size: ENGINE.2,
            installed: engine_installed(),
        },
        Part {
            id: "model".into(),
            label: "modelo de voz (ZipVoice)".into(),
            url: model_url(),
            sha256: MODEL_SHA.into(),
            size: MODEL_SIZE,
            installed: model_ok,
        },
        Part {
            id: "vocoder".into(),
            label: "vocoder".into(),
            url: vocoder_url(),
            sha256: VOCODER_SHA.into(),
            size: VOCODER_SIZE,
            installed: dir.join(crate::interpreter::VOCODER_FILE).exists(),
        },
    ]
}

#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatus {
    pub parts: Vec<Part>,
    // Quantos bytes ainda faltam baixar. A tela mostra isto ANTES de começar:
    // 160 MB não é coisa que se baixe sem avisar.
    pub remaining_bytes: u64,
    pub ready: bool,
    pub supported: bool,
}

pub fn status_from(parts: Vec<Part>, supported: bool) -> InstallStatus {
    let remaining_bytes = parts.iter().filter(|p| !p.installed).map(|p| p.size).sum();
    InstallStatus {
        ready: parts.iter().all(|p| p.installed),
        remaining_bytes,
        parts,
        supported,
    }
}

#[tauri::command]
pub fn voice_install_status() -> Result<InstallStatus, String> {
    Ok(status_from(parts(), !ENGINE.0.is_empty()))
}

#[derive(Deserialize)]
pub struct InstallInput {
    pub part: String,
}

#[tauri::command]
pub async fn voice_install_part(
    app: tauri::AppHandle,
    input: InstallInput,
) -> Result<InstallStatus, String> {
    tauri::async_runtime::spawn_blocking(move || install_blocking(app, &input.part))
        .await
        .map_err(|e| e.to_string())?
}

// ADR-0022 §28: download e extração fora da thread principal.
fn install_blocking(app: tauri::AppHandle, part_id: &str) -> Result<InstallStatus, String> {
    if ENGINE.0.is_empty() {
        return Err("err.voice_install_unsupported".into());
    }
    let part = parts()
        .into_iter()
        .find(|p| p.id == part_id)
        .ok_or("err.voice_install_unknown_part")?;
    if part.installed {
        return voice_install_status();
    }
    if which("curl").is_none() {
        return Err("err.curl_missing".into());
    }
    let work = crate::paths::loro_data_dir().join("tmp");
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let tmp = work.join(format!(".voice-{}.part", part.id));
    let _ = std::fs::remove_file(&tmp);

    download(&app, &part, &tmp)?;
    // Verifica ANTES de extrair: um arquivo corrompido não deve nem ser aberto,
    // e um adulterado nunca deve virar o motor que fala pela pessoa.
    let got = crate::models::sha256_of(&tmp)?;
    if !got.eq_ignore_ascii_case(&part.sha256) {
        let _ = std::fs::remove_file(&tmp);
        return Err("err.voice_install_bad_hash".into());
    }
    let r = match part.id.as_str() {
        "engine" => install_engine(&tmp, &work),
        "model" => install_model(&tmp, &work),
        "vocoder" => install_vocoder(&tmp),
        _ => Err("err.voice_install_unknown_part".into()),
    };
    let _ = std::fs::remove_file(&tmp);
    r?;
    voice_install_status()
}

fn download(app: &tauri::AppHandle, part: &Part, tmp: &Path) -> Result<(), String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tauri::Emitter;

    let stop = Arc::new(AtomicBool::new(false));
    let poller = {
        let (app, id, tmp, stop, total) = (
            app.clone(),
            part.id.clone(),
            tmp.to_path_buf(),
            stop.clone(),
            part.size,
        );
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let downloaded = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
                let _ = app.emit(
                    "voice-install-progress",
                    serde_json::json!({ "part": id, "downloaded": downloaded, "total": total }),
                );
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        })
    };
    // `--proto =https` recusa qualquer redirecionamento fora de HTTPS; `-f`
    // transforma erro HTTP em saída não-zero. Mesmos argumentos do download dos
    // modelos do whisper (ADR-0006).
    let st = crate::proc::command("curl")
        .args(["-fSL", "--proto", "=https", "--tlsv1.2", "-o"])
        .arg(tmp)
        .arg(&part.url)
        .status();
    stop.store(true, Ordering::Relaxed);
    let _ = poller.join();
    match st {
        Ok(s) if s.success() => Ok(()),
        _ => {
            let _ = std::fs::remove_file(tmp);
            Err("err.download_failed".into())
        }
    }
}

// Extrai um .tar.bz2 e devolve o diretório que ele criou. Usa o `tar` do
// sistema — presente no macOS, no Linux e no Windows 10+ (bsdtar) — pela mesma
// razão que o whisper é dependência de sistema: descompactar não é problema
// deste app resolver de novo.
fn untar(archive: &Path, into: &Path) -> Result<PathBuf, String> {
    let before: Vec<PathBuf> = std::fs::read_dir(into)
        .map(|d| d.filter_map(|e| e.ok()).map(|e| e.path()).collect())
        .unwrap_or_default();
    let st = crate::proc::command("tar")
        .arg("-xjf")
        .arg(archive)
        .arg("-C")
        .arg(into)
        .status()
        .map_err(|_| "err.voice_install_no_tar".to_string())?;
    if !st.success() {
        return Err("err.voice_install_extract_failed".into());
    }
    std::fs::read_dir(into)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|p| p.is_dir() && !before.contains(p))
        .ok_or_else(|| "err.voice_install_extract_failed".to_string())
}

// bin/ e lib/ IRMÃOS, porque é isso que o `@loader_path/../lib` do binário
// procura. Instalar só o executável dá um binário que existe e não roda.
fn install_engine(archive: &Path, work: &Path) -> Result<(), String> {
    let root = untar(archive, work)?;
    engine_from_root(&root, &engine_bin_dir(), &engine_lib_dir())
}

// Separado do download para ser TESTÁVEL: sem isto, o único jeito de exercitar a
// movimentação seria escrever no ~/.loro real do usuário, e um teste que faz
// isso não se roda duas vezes.
fn engine_from_root(root: &Path, bin: &Path, lib: &Path) -> Result<(), String> {
    std::fs::create_dir_all(bin).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(lib).map_err(|e| e.to_string())?;
    let src_exe = root.join("bin").join(engine_exe());
    if !src_exe.exists() {
        let _ = std::fs::remove_dir_all(root);
        return Err("err.voice_install_no_binary".into());
    }
    crate::paths::move_or_copy(&src_exe, &bin.join(engine_exe()))?;
    // Toda biblioteca do pacote, seja .dylib, .so ou .dll.
    if let Ok(entries) = std::fs::read_dir(root.join("lib")) {
        for e in entries.filter_map(|e| e.ok()) {
            let p = e.path();
            if p.is_file() {
                if let Some(name) = p.file_name() {
                    crate::paths::move_or_copy(&p, &lib.join(name))?;
                }
            }
        }
    }
    let _ = std::fs::remove_dir_all(root);
    Ok(())
}

// O diretório interno do pacote tem outro nome que o nosso id de modelo, então
// o conteúdo é movido — não o diretório.
fn install_model(archive: &Path, work: &Path) -> Result<(), String> {
    let root = untar(archive, work)?;
    model_from_root(&root, &crate::interpreter::voice_model_dir())
}

fn model_from_root(root: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for e in std::fs::read_dir(root)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
    {
        let from = e.path();
        let Some(name) = from.file_name() else {
            continue;
        };
        let to = dest.join(name);
        let _ = std::fs::remove_dir_all(&to);
        let _ = std::fs::remove_file(&to);
        crate::paths::move_or_copy(&from, &to)?;
    }
    let _ = std::fs::remove_dir_all(root);
    Ok(())
}

// O vocoder é um .onnx solto e mora junto do modelo.
fn install_vocoder(tmp: &Path) -> Result<(), String> {
    let dest = crate::interpreter::voice_model_dir();
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    crate::paths::move_or_copy(tmp, &dest.join(crate::interpreter::VOCODER_FILE))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("loro-vi-{tag}-{}", crate::epoch_millis()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    // Monta um .tar.bz2 com a MESMA forma do pacote real (raiz/bin + raiz/lib),
    // para exercitar extração e movimentação sem baixar 20 MB e sem tocar no
    // ~/.loro do usuário.
    fn fake_engine_archive(work: &Path) -> PathBuf {
        let root = work.join("sherpa-onnx-v9.9.9-fake-shared");
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::create_dir_all(root.join("lib")).unwrap();
        std::fs::write(root.join("bin").join(engine_exe()), b"#!/bin/true\n").unwrap();
        std::fs::write(root.join("lib/libfake.dylib"), b"lib").unwrap();
        let archive = work.join("engine.tar.bz2");
        let st = std::process::Command::new("tar")
            .arg("-cjf")
            .arg(&archive)
            .arg("-C")
            .arg(work)
            .arg(root.file_name().unwrap())
            .status()
            .expect("tar");
        assert!(st.success());
        std::fs::remove_dir_all(&root).unwrap();
        archive
    }

    // A extração tem de ACHAR o diretório que o pacote criou: o nome dele carrega
    // versão e plataforma, então não pode estar chumbado em lugar nenhum.
    #[test]
    fn untar_finds_the_directory_the_package_created() {
        let w = scratch("untar");
        let a = fake_engine_archive(&w);
        let root = untar(&a, &w).expect("untar falhou");
        assert!(root.join("bin").join(engine_exe()).exists(), "{root:?}");
        let _ = std::fs::remove_dir_all(&w);
    }

    // O executável e as bibliotecas TÊM de chegar como irmãos, senão o binário
    // existe e não roda (@loader_path/../lib).
    #[test]
    fn the_engine_install_lands_the_binary_next_to_its_libraries() {
        let w = scratch("engine");
        let a = fake_engine_archive(&w);
        let root = untar(&a, &w).unwrap();
        let bin = w.join("out/bin");
        let lib = w.join("out/lib");
        engine_from_root(&root, &bin, &lib).expect("install falhou");
        assert!(bin.join(engine_exe()).is_file(), "sem executável");
        assert!(lib.join("libfake.dylib").is_file(), "sem biblioteca");
        assert_eq!(bin.parent(), lib.parent(), "bin e lib não são irmãos");
        let _ = std::fs::remove_dir_all(&w);
    }

    // Um pacote sem o executável esperado é RECUSADO em vez de instalado pela
    // metade — meio motor é o estado que só falha na hora de falar.
    #[test]
    fn a_package_without_the_binary_is_refused() {
        let w = scratch("nobin");
        let root = w.join("sherpa-onnx-v9.9.9-empty");
        std::fs::create_dir_all(root.join("lib")).unwrap();
        let err = engine_from_root(&root, &w.join("out/bin"), &w.join("out/lib")).unwrap_err();
        assert_eq!(err, "err.voice_install_no_binary");
        let _ = std::fs::remove_dir_all(&w);
    }

    // O modelo move o CONTEÚDO, não o diretório: o nome interno do pacote é outro
    // que o nosso id, e mover o diretório aninharia tudo um nível.
    #[test]
    fn the_model_install_moves_the_contents_including_directories() {
        let w = scratch("model");
        let root = w.join("sherpa-onnx-zipvoice-fake");
        std::fs::create_dir_all(root.join("espeak-ng-data/pt")).unwrap();
        std::fs::write(root.join("encoder.int8.onnx"), b"e").unwrap();
        std::fs::write(root.join("espeak-ng-data/pt/dict"), b"d").unwrap();
        let dest = w.join("models/zipvoice");
        model_from_root(&root, &dest).expect("install falhou");
        assert!(dest.join("encoder.int8.onnx").is_file());
        // O diretório inteiro tem de vir: uma versão só-para-arquivos deixaria o
        // espeak-ng-data de fora e o modelo não falaria.
        assert!(
            dest.join("espeak-ng-data/pt/dict").is_file(),
            "faltou o diretório"
        );
        assert!(
            !dest.join("sherpa-onnx-zipvoice-fake").exists(),
            "aninhou um nível"
        );
        let _ = std::fs::remove_dir_all(&w);
    }

    // Os hashes fixados vieram da API do GitHub e foram CONFERIDOS contra
    // `shasum -a 256` dos arquivos baixados em 2026-09-07. Este teste guarda os
    // valores: uma troca silenciosa de artefato passa a quebrar aqui.
    #[test]
    fn the_pinned_hashes_are_the_ones_that_were_verified() {
        assert_eq!(
            MODEL_SHA,
            "77219c8b40f4ee8d73a7f902305ff6c1128ef9b54461c41b4ca6ed890b6c2803"
        );
        assert_eq!(
            VOCODER_SHA,
            "bcb3b970e384161c4d634f0bb9e999ff1c471b34c9bc0b1049a5014065ed3cc0"
        );
        assert_eq!(MODEL_SIZE, 109_162_785);
        assert_eq!(VOCODER_SIZE, 54_157_409);
    }

    // Todo download é HTTPS e vem da release fixada — nunca de um "latest", que
    // trocaria artefato e hash sem avisar.
    #[test]
    fn every_download_is_https_and_version_pinned() {
        for u in [engine_url(), model_url(), vocoder_url()] {
            assert!(u.starts_with("https://"), "{u}");
            assert!(!u.contains("latest"), "{u}");
        }
        assert!(engine_url().contains(ENGINE_VERSION), "{}", engine_url());
    }

    // O motor usa o pacote COMPARTILHADO: o estático são 114 MB no Windows
    // contra 7 MB (medido, ADR-0036 §1).
    #[test]
    fn the_engine_download_is_the_shared_build_not_the_static_one() {
        assert!(engine_url().contains("shared"), "{}", engine_url());
        assert!(!engine_url().contains("static"), "{}", engine_url());
    }

    // bin/ e lib/ TÊM de ser irmãos: é o que o `@loader_path/../lib` do binário
    // procura, e instalar só o executável dá um binário que não roda.
    #[test]
    fn the_engine_lands_with_bin_and_lib_as_siblings() {
        assert_eq!(engine_bin_dir().parent(), engine_lib_dir().parent());
        assert_eq!(engine_bin_dir().file_name().unwrap(), "bin");
        assert_eq!(engine_lib_dir().file_name().unwrap(), "lib");
    }

    // E o diretório do binário tem de ser um que a busca de engines alcance,
    // senão o app instala e não acha (ADR-0030).
    #[test]
    fn the_install_dir_is_one_the_engine_lookup_searches() {
        assert!(
            crate::paths::known_bin_dirs().contains(&engine_bin_dir()),
            "o app instalaria o motor onde ele mesmo não procura"
        );
    }

    // As três peças faltam SEPARADAMENTE. Tratá-las como uma só produzia o pior
    // estado: "instalado" sem o vocoder, que carrega e não fala.
    #[test]
    fn the_three_pieces_are_reported_one_by_one() {
        let ids: Vec<String> = parts().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, vec!["engine", "model", "vocoder"]);
    }

    // A tela mostra quanto falta baixar ANTES de começar: 160 MB não é coisa que
    // se baixe sem avisar.
    #[test]
    fn the_remaining_bytes_count_only_what_is_missing() {
        let mk = |id: &str, size: u64, installed: bool| Part {
            id: id.into(),
            label: id.into(),
            url: "https://x".into(),
            sha256: "y".into(),
            size,
            installed,
        };
        let st = status_from(
            vec![
                mk("engine", 20, true),
                mk("model", 100, false),
                mk("vocoder", 50, false),
            ],
            true,
        );
        assert_eq!(st.remaining_bytes, 150, "contou o que já estava instalado");
        assert!(!st.ready);

        let all = status_from(vec![mk("engine", 20, true), mk("model", 100, true)], true);
        assert_eq!(all.remaining_bytes, 0);
        assert!(all.ready);
    }
}
