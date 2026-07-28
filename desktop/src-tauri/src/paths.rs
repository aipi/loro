// Loro — path & engine resolution (data dir, models, whisper binary).
// Extracted from lib.rs (AGENTS.md clean-core premise).

use std::path::PathBuf;

// ---- path resolution --------------------------------------------------------
// Loro data (models, logs) lives under ~/.loro. The transcription engine is a
// system dependency (see ADR-0003): binaries come from PATH or an env override.

pub fn user_home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
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

// Resolve an engine binary: env override, then PATH + known locations,
// then bare name (callers surface an actionable error if missing).
pub fn resolve_engine(env_key: &str, name: &str) -> PathBuf {
    if let Ok(b) = std::env::var(env_key) {
        return PathBuf::from(b);
    }
    for dir in engine_search_dirs() {
        let cand = dir.join(name);
        if cand.is_file() {
            return cand;
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
        let cand = dir.join("loro-syscap");
        if cand.is_file() {
            return cand;
        }
    }
    PathBuf::from("loro-syscap")
}

// find an executable (PATH + known locations) — same search the engine uses
pub fn which(name: &str) -> Option<String> {
    engine_search_dirs()
        .into_iter()
        .map(|d| d.join(name))
        .find(|c| c.is_file())
        .map(|p| p.display().to_string())
}
