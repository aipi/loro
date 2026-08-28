// Loro — path & engine resolution (data dir, models, whisper binary).
// Extracted from lib.rs (AGENTS.md clean-core premise).

use std::path::{Path, PathBuf};

// ---- path resolution --------------------------------------------------------
// Loro data (models, logs) lives under ~/.loro. The transcription engine is a
// system dependency (see ADR-0003): binaries come from PATH or an env override.

pub fn user_home() -> PathBuf {
    home_from(|k| std::env::var(k).ok())
}

// Home resolution is platform-aware: Unix sets HOME, Windows sets USERPROFILE.
// Split from user_home so the selection can be unit-tested without mutating the
// process environment.
fn home_from(get: impl Fn(&str) -> Option<String>) -> PathBuf {
    for key in ["HOME", "USERPROFILE"] {
        if let Some(h) = get(key).filter(|h| !h.is_empty()) {
            return PathBuf::from(h);
        }
    }
    PathBuf::from(".")
}

// Loro data dir (models, logs, engine config). Override with LORO_HOME.
pub fn loro_data_dir() -> PathBuf {
    if let Ok(h) = std::env::var("LORO_HOME") {
        return PathBuf::from(h);
    }
    user_home().join(".loro")
}

pub fn models_dir() -> PathBuf {
    if let Ok(d) = std::env::var("LORO_MODELS_DIR") {
        return PathBuf::from(d);
    }
    loro_data_dir().join("models")
}

// Writable per-user location for recorded audio and its scratch conversions.
// Lives under the Loro data dir (~/.loro) so it is writable regardless of the
// process working directory — an installed app launched from Finder has CWD `/`
// (read-only), which would fail with os error 30 if we wrote next to the CWD.
pub fn recordings_dir() -> PathBuf {
    loro_data_dir().join("recordings")
}

// Project dir (dev): where the loro.sh CLI and transcripts live. Override with
// LORO_PROJECT_DIR. Only used for the diarization handoff and scratch files.
pub fn project_dir() -> PathBuf {
    if let Ok(h) = std::env::var("LORO_PROJECT_DIR") {
        return PathBuf::from(h);
    }
    std::env::current_dir().unwrap_or_else(|_| user_home())
}

// Well-known locations for the tools Loro shells out to (the engine, the agent
// CLI, git/gh) — the floor under `proc::hydrate_path` (ADR-0030) for when the
// user's login shell cannot be reached. Measured on the installed Loro.app:
// PATH=/usr/bin:/bin:/usr/sbin:/sbin, while `claude` and `gh` live only in
// /opt/homebrew/bin.
pub fn known_bin_dirs() -> Vec<PathBuf> {
    // Loro-managed engine install: the guided Windows setup drops the whisper
    // binaries here, so they are found without touching the user's PATH.
    let mut dirs = vec![loro_data_dir().join("bin")];
    for known in [
        "/opt/homebrew/bin", // Homebrew (Apple Silicon)
        "/opt/homebrew/sbin",
        "/usr/local/bin", // Homebrew (Intel) / manual installs
        "/opt/homebrew/opt/whisper-cpp/bin",
        "/usr/bin",
    ] {
        dirs.push(PathBuf::from(known));
    }
    // Per-user installs. `~/.local/bin` is where the agent CLI's own native
    // installer puts it, and `~/.claude/local` is where `migrate-installer`
    // moves it — neither is ever on a GUI app's PATH.
    let home = user_home();
    for rel in [
        ".local/bin",
        ".claude/local",
        ".bun/bin",
        ".deno/bin",
        ".volta/bin",
        ".npm-global/bin",
        ".cargo/bin",
        "bin",
    ] {
        dirs.push(home.join(rel));
    }
    dirs
}

// Directories searched for engine binaries: the process PATH first (it is the
// user's own ordering), then the known locations.
pub fn engine_search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for known in known_bin_dirs() {
        if !dirs.contains(&known) {
            dirs.push(known);
        }
    }
    dirs
}

// Executable candidates for a base name in a dir. On Windows an extensionless
// name also matches `.exe`, `.cmd` and `.bat` forms — compiled engines
// (whisper-stream -> whisper-stream.exe) as well as the npm-style global
// shims the agent CLI installs there (`claude` + `claude.cmd`, no `.exe` at
// all). The extension forms are tried BEFORE the bare name: npm always drops
// the bare file too (a node-shebang script, inert on native Windows), so
// `is_file()` on the bare name alone would resolve to a file that exists but
// cannot execute — found, but does not run.
fn exe_candidates(dir: &Path, name: &str) -> Vec<PathBuf> {
    let bare = dir.join(name);
    // cfg!() rather than #[cfg]: the body then compiles on every platform, so
    // `cands` is always seen as used (an attribute would strip it off-Windows
    // and trip clippy's unused). The branch is folded away.
    if cfg!(windows) && Path::new(name).extension().is_none() {
        let mut cands: Vec<PathBuf> = ["exe", "cmd", "bat"]
            .iter()
            .map(|ext| dir.join(format!("{name}.{ext}")))
            .collect();
        cands.push(bare);
        return cands;
    }
    vec![bare]
}

// Resolve an engine binary: env override, then PATH + known locations,
// then bare name (callers surface an actionable error if missing).
pub fn resolve_engine(env_key: &str, name: &str) -> PathBuf {
    if let Ok(b) = std::env::var(env_key) {
        return PathBuf::from(b);
    }
    for dir in engine_search_dirs() {
        if let Some(found) = exe_candidates(&dir, name).into_iter().find(|c| c.is_file()) {
            return found;
        }
    }
    PathBuf::from(name)
}

pub fn whisper_bin() -> PathBuf {
    resolve_engine("WHISPER_STREAM_BIN", "whisper-stream")
}

// file/offline transcription uses whisper-cli (no streaming), see ADR-0003
// "two transcription modes". It DOES use VAD since ADR-0034 — whisper-cli grew
// its own, and silence without it makes the model invent captions.
pub fn whisper_cli_bin() -> PathBuf {
    resolve_engine("WHISPER_CLI_BIN", "whisper-cli")
}

// Split out so a caller that resolves against a directory other than
// `models_dir()` — models::is_installed_in, and its tests — cannot drift from
// the naming used here.
pub fn model_file_name(model: &str) -> String {
    format!("ggml-{model}.bin")
}

pub fn model_path(model: &str) -> PathBuf {
    models_dir().join(model_file_name(model))
}

// System-audio capturer (ScreenCaptureKit sidecar, macOS — see ADR-0005). Unlike
// whisper it is our own binary, so resolution favors the copy built from
// `syscap/loro-syscap.swift`: LORO_SYSCAP_BIN override, then the dev build next
// to the source (`CARGO_MANIFEST_DIR/syscap`), then PATH/known dirs. The packaged
// app additionally checks its resource dir (the command has the AppHandle).
pub fn syscap_bin() -> PathBuf {
    if let Ok(b) = std::env::var("LORO_SYSCAP_BIN") {
        return PathBuf::from(b);
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("syscap")
        .join("loro-syscap");
    if dev.is_file() {
        return dev;
    }
    for dir in engine_search_dirs() {
        if let Some(found) = exe_candidates(&dir, "loro-syscap")
            .into_iter()
            .find(|c| c.is_file())
        {
            return found;
        }
    }
    PathBuf::from("loro-syscap")
}

// ffmpeg is a system dependency (ADR-0003). The install hint travels as the
// error's `detail` so the frontend renders it in the active language while still
// naming the installer that actually exists on the running platform. Every
// caller must use this: the message template interpolates {detail}, so a bare
// "err.ffmpeg_not_found" would render as "Install ()".
pub fn ffmpeg_not_found_err() -> String {
    let hint = if cfg!(target_os = "windows") {
        "winget install Gyan.FFmpeg"
    } else {
        "brew install ffmpeg"
    };
    format!("err.ffmpeg_not_found:{hint}")
}

// N20 — a folder the user typed can refuse everything the project needs to be
// written into it, and `io::Error::to_string()` is not a message the product wrote
// (ADR-0001 §10): "Not a directory (os error 20)" reaches a pt-BR screen, says
// nothing about what is wrong and offers no next step. Every write that lands
// INSIDE a project folder answers with one of these stable codes instead, so the
// sentence the user reads is owned by the UI and exists in both languages.
pub fn folder_write_error(err: &std::io::Error) -> String {
    match err.kind() {
        std::io::ErrorKind::PermissionDenied => "err.acervo_dir_not_writable".to_string(),
        _ => "err.acervo_dir_unusable".to_string(),
    }
}

// find an executable (PATH + known locations) — same search the engine uses
pub fn which(name: &str) -> Option<String> {
    // A command WRITTEN with a path ("/opt/homebrew/bin/claude", "./bin/agent")
    // is not a name to look up: it already says where it is. Searching dirs for
    // it only ever worked by accident (`Path::join` swallows an absolute right
    // side) and answered "not found" for a relative one.
    if name.contains('/') || name.contains('\\') {
        let direct = PathBuf::from(name);
        let mut cands = vec![direct.clone()];
        if cfg!(windows) && direct.extension().is_none() {
            cands.push(direct.with_extension("exe"));
        }
        return cands
            .into_iter()
            .find(|c| c.is_file())
            .map(|p| p.display().to_string());
    }
    engine_search_dirs()
        .into_iter()
        .flat_map(|d| exe_candidates(&d, name))
        .find(|c| c.is_file())
        .map(|p| p.display().to_string())
}

// ADR-0026 §14 — the acervo's folders were renamed to English, and the migration
// that renames them on disk is USER-triggered. Until someone runs it, an existing
// acervo still has the Portuguese folder — and every read that hardcoded the new
// name found nothing: no themes, no meetings, no notes, and every meeting command
// failing. Resolve the name once, from what is actually on disk, and both spellings
// keep working. New/empty acervos get the English name.
pub fn acervo_dir(base: &std::path::Path, current: &str, legacy: &str) -> std::path::PathBuf {
    let atual = base.join(current);
    if atual.is_dir() {
        return atual;
    }
    let antigo = base.join(legacy);
    if antigo.is_dir() {
        return antigo;
    }
    atual
}

pub fn contexts_dir(base: &std::path::Path) -> std::path::PathBuf {
    acervo_dir(base, "contexts", "contextos")
}

// ADR-0026 §20 — um acervo escrito antes da renomeação. Sustentar as DUAS grafias
// em todo o código provou ser insustentável: três rodadas de revisão, três
// conjuntos de vazamento, e o pior deles fez o conhecimento sumir da tela. Em vez
// de fingir que funciona meio-a-meio, o app RECONHECE o estado e oferece a
// migração — que já é não destrutiva, idempotente e de um ato só.
pub fn is_legacy_layout(base: &std::path::Path) -> bool {
    ["contextos", "reunioes", "notas"]
        .iter()
        .any(|d| base.join(d).is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_prefers_home_then_userprofile() {
        // Unix: HOME wins when both are present.
        let both = home_from(|k| match k {
            "HOME" => Some("/home/u".into()),
            "USERPROFILE" => Some("C:\\Users\\u".into()),
            _ => None,
        });
        assert_eq!(both, PathBuf::from("/home/u"));

        // Windows: only USERPROFILE set.
        let win = home_from(|k| (k == "USERPROFILE").then(|| "C:\\Users\\u".into()));
        assert_eq!(win, PathBuf::from("C:\\Users\\u"));

        // An empty HOME is ignored and falls through to USERPROFILE.
        let empty = home_from(|k| match k {
            "HOME" => Some(String::new()),
            "USERPROFILE" => Some("C:\\Users\\u".into()),
            _ => None,
        });
        assert_eq!(empty, PathBuf::from("C:\\Users\\u"));

        // Nothing set: fall back to the current dir.
        assert_eq!(home_from(|_| None), PathBuf::from("."));
    }

    #[test]
    fn engine_candidates_match_platform() {
        let c = exe_candidates(Path::new("/x"), "whisper-stream");
        assert!(c.contains(&Path::new("/x").join("whisper-stream")));
        #[cfg(windows)]
        assert!(c.contains(&Path::new("/x").join("whisper-stream.exe")));
        #[cfg(not(windows))]
        assert_eq!(c.len(), 1);

        // An explicit extension is left untouched on every platform.
        assert_eq!(exe_candidates(Path::new("/x"), "ffmpeg.exe").len(), 1);
    }

    #[test]
    fn ffmpeg_error_carries_a_platform_install_hint() {
        // the detail must name the installer that exists on THIS os — pointing a
        // Windows user at Homebrew is a dead end
        let e = ffmpeg_not_found_err();
        let (code, hint) = e.split_once(':').expect("formato err.code:detail");
        assert_eq!(code, "err.ffmpeg_not_found");
        assert!(
            !hint.is_empty(),
            "a mensagem interpola {{detail}}, nao pode vir vazio"
        );
        if cfg!(target_os = "windows") {
            assert!(hint.contains("winget"), "esperava winget, veio: {hint}");
            assert!(!hint.contains("brew"), "dica de macOS no Windows: {hint}");
        } else {
            assert!(hint.contains("brew"));
        }
    }

    // N20 — the wizard's folder field is typeable, so the OS is the one that says
    // no. Whatever it says, the user must read a sentence the product wrote: the
    // mapper never forwards the io message, and it tells "no permission" apart
    // from the rest because those are two different next steps.
    #[test]
    fn a_folder_failure_becomes_a_code_the_ui_translates() {
        use std::io::{Error, ErrorKind};
        assert_eq!(
            folder_write_error(&Error::new(
                ErrorKind::PermissionDenied,
                "Permission denied"
            )),
            "err.acervo_dir_not_writable"
        );
        for kind in [
            ErrorKind::NotADirectory,
            ErrorKind::NotFound,
            ErrorKind::Other,
        ] {
            let code = folder_write_error(&Error::new(kind, "Not a directory (os error 20)"));
            assert_eq!(code, "err.acervo_dir_unusable", "{kind:?}");
        }
        // no io text ever survives into what the user reads
        let raw = folder_write_error(&Error::other("os error 20"));
        assert!(raw.starts_with("err."), "{raw}");
        assert!(!raw.contains("os error"), "{raw}");
    }

    #[test]
    fn engine_search_includes_loro_bin() {
        // the guided setup installs the engine into ~/.loro/bin, so the search
        // must always include it (no PATH edit required)
        assert!(engine_search_dirs().contains(&loro_data_dir().join("bin")));
    }
}
