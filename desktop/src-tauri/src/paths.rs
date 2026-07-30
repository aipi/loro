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

// Directories searched for engine binaries. GUI apps on macOS get a minimal
// PATH (no /opt/homebrew/bin), so well-known package-manager locations are
// appended after the PATH entries.
pub fn engine_search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    // Loro-managed engine install: the guided Windows setup drops the whisper
    // binaries here, so they are found without touching the user's PATH.
    let managed = loro_data_dir().join("bin");
    if !dirs.contains(&managed) {
        dirs.push(managed);
    }
    for known in [
        "/opt/homebrew/bin", // Homebrew (Apple Silicon)
        "/usr/local/bin",    // Homebrew (Intel) / manual installs
        "/opt/homebrew/opt/whisper-cpp/bin",
        "/usr/bin",
    ] {
        let p = PathBuf::from(known);
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    }
    dirs
}

// Executable candidates for a base name in a dir. On Windows an extensionless
// name also matches its `.exe` form (whisper-stream -> whisper-stream.exe), so
// engine discovery works the same as on Unix.
fn exe_candidates(dir: &Path, name: &str) -> Vec<PathBuf> {
    let mut cands = vec![dir.join(name)];
    #[cfg(windows)]
    if Path::new(name).extension().is_none() {
        cands.push(dir.join(format!("{name}.exe")));
    }
    cands
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

// file/offline transcription uses whisper-cli (no VAD/streaming), see
// ADR-0003 "two transcription modes".
pub fn whisper_cli_bin() -> PathBuf {
    resolve_engine("WHISPER_CLI_BIN", "whisper-cli")
}

pub fn model_path(model: &str) -> PathBuf {
    models_dir().join(format!("ggml-{model}.bin"))
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

// find an executable (PATH + known locations) — same search the engine uses
pub fn which(name: &str) -> Option<String> {
    engine_search_dirs()
        .into_iter()
        .flat_map(|d| exe_candidates(&d, name))
        .find(|c| c.is_file())
        .map(|p| p.display().to_string())
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
    fn engine_search_includes_loro_bin() {
        // the guided setup installs the engine into ~/.loro/bin, so the search
        // must always include it (no PATH edit required)
        assert!(engine_search_dirs().contains(&loro_data_dir().join("bin")));
    }
}
