// Loro backend (Tauri). Spawns the system whisper-stream and streams its output
// to the UI via events. Nothing (audio/text) leaves the machine.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tracing::{error, info, warn};

mod paths;
use paths::*;
// every subprocess goes through proc::command so no console window flashes on
// Windows — see proc.rs
mod config;
mod proc;
use config::*;
mod templates;
use templates::*;
mod presets;
use presets::*;
mod chat;
mod git;
mod intake;
use git::*;
mod acervo;
use acervo::*;
mod meeting;
use meeting::*;
mod models;
// ADR-0011 v1 contract-lock. `pub mod` because these types/commands are the
// locked privacy surface for the (deferred) multi-agent graph — reachable API,
// not dead code, even though the transport is not wired yet.
pub mod ai;
use ai::*;

const TRAY_ID: &str = "loro-tray";
const TRAY_ON: &[u8] = include_bytes!("../icons/tray-on.png");
const TRAY_DIM: &[u8] = include_bytes!("../icons/tray-dim.png");

#[derive(Default)]
pub(crate) struct AppState {
    child: Mutex<Option<Child>>,
    // system-audio capturer (ScreenCaptureKit sidecar) for meeting mode, ADR-0005
    syscap: Mutex<Option<Child>>,
    tray: Mutex<Option<tauri::tray::TrayIcon>>,
    tray_menu: Mutex<Option<TrayMenuItems>>,
    recording: AtomicBool,
    term: Mutex<Option<TermSession>>,
}

// Handles to the tray menu items, kept so ui_set_lang can relabel them live.
struct TrayMenuItems {
    show: MenuItem<tauri::Wry>,
    toggle: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

// Tray chrome per UI language. The webview translates itself (frontend I18N);
// the tray lives outside the webview, so the backend owns these few strings.
struct TrayLabels {
    show: &'static str,
    toggle: &'static str,
    quit: &'static str,
    tooltip_recording: &'static str,
}

fn tray_labels(lang: &str) -> TrayLabels {
    if lang == "en" {
        TrayLabels {
            show: "Open Loro",
            toggle: "Start / Stop transcription",
            quit: "Quit",
            tooltip_recording: "Loro — transcribing",
        }
    } else {
        TrayLabels {
            show: "Abrir Loro",
            toggle: "Iniciar / Parar transcrição",
            quit: "Sair",
            tooltip_recording: "Loro — transcrevendo",
        }
    }
}

// an embedded interactive terminal (PTY) session — the VSCode-style backend half
struct TermSession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    // when the agent auto-launch line was written (ADR-0005): term_status uses
    // this to tell "still starting up" apart from "never came up", so the
    // frontend doesn't retype the launch command into a session that already
    // has it in flight (ps-based detection lags a live process by ~1 poll).
    launched_at: std::time::Instant,
}

// Streaming UTF-8 decoder for PTY output. A single `read()` off the master can
// slice the middle of a multi-byte codepoint — the agent's TUI is full of
// emoji and box-drawing glyphs, and a redraw frame routinely exceeds the 4096-
// byte read buffer. Decoding each chunk independently with `from_utf8_lossy`
// turns the split halves into U+FFFD replacement chars, whose display width
// (1 col) diverges from the original (often 2). The TUI then erases the wrong
// number of wrapped lines on its next redraw and overprints — "text over text".
// Holding the incomplete trailing bytes until their continuation arrives keeps
// the emitted stream byte-faithful.
#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    // Feed raw bytes; return the text that is now fully decodable, keeping any
    // incomplete trailing multi-byte sequence for the next call.
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(s) => {
                    out.push_str(s);
                    self.pending.clear();
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    if valid > 0 {
                        // valid_up_to() guarantees this prefix is well-formed.
                        out.push_str(std::str::from_utf8(&self.pending[..valid]).unwrap());
                    }
                    match e.error_len() {
                        // Genuinely invalid bytes: emit one replacement, skip them.
                        Some(bad) => {
                            out.push('\u{FFFD}');
                            self.pending.drain(..valid + bad);
                        }
                        // Incomplete tail: keep it until the continuation arrives.
                        None => {
                            self.pending.drain(..valid);
                            break;
                        }
                    }
                }
            }
        }
        out
    }
}

// ---- structured logging (tracing) -----------------------------------------
// App logs go to ~/.loro/logs/loro.log (English, no PII/secrets). Raw engine
// stderr goes to ~/.loro/logs/engine.log (see `start`). Level via LORO_LOG.
static LOG_GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

fn init_logging() {
    let dir = loro_data_dir().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let (nb, guard) =
        tracing_appender::non_blocking(tracing_appender::rolling::daily(&dir, "loro.log"));
    let _ = LOG_GUARD.set(guard);
    let filter = tracing_subscriber::EnvFilter::try_from_env("LORO_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(nb)
        .with_ansi(false)
        .try_init();
}

#[derive(serde::Serialize)]
struct Doctor {
    os: String,
    arch: String,
    whisper_stream: Option<String>,
    whisper_cli: Option<String>,
    ffmpeg: bool,
    models_dir: String,
    models: Vec<String>,
    acervo_configured: bool,
}

// environment diagnostics for quick troubleshooting
#[tauri::command]
fn doctor() -> Doctor {
    let models = std::fs::read_dir(models_dir())
        .ok()
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    n.starts_with("ggml-").then_some(n)
                })
                .collect()
        })
        .unwrap_or_default();
    let d = Doctor {
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        whisper_stream: which("whisper-stream"),
        whisper_cli: which("whisper-cli"),
        ffmpeg: which("ffmpeg").is_some(),
        models_dir: models_dir().display().to_string(),
        models,
        acervo_configured: read_brain_config().is_some(),
    };
    info!(
        target: "doctor",
        whisper_stream = d.whisper_stream.is_some(),
        models = d.models.len(),
        acervo = d.acervo_configured,
        "diagnostics"
    );
    d
}

// The transcription models Loro uses, each flagged installed or missing, for
// the first-run model manager (ADR-0006). Pure catalog + filesystem check.
#[tauri::command]
fn list_models() -> Vec<models::ModelInfo> {
    models::catalog_status()
}

// Download a catalog model into ~/.loro/models with a verified, atomic install
// (ADR-0006). Streams over HTTPS via system curl and emits
// `model-download-progress { model, downloaded, total }` while it runs; the file
// is checked against its pinned SHA-256 before it is placed, so a tampered or
// truncated download never becomes the active model (protects the user's
// machine; BR-1 keeps everything local — the only host contacted is the model
// mirror). Idempotent: a model already present returns immediately.
#[tauri::command]
async fn download_model(app: AppHandle, model: String) -> Result<(), String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let spec = models::spec(&model).ok_or("err.unknown_model")?;
    if models::is_installed(&model) {
        return Ok(());
    }
    if which("curl").is_none() {
        return Err("err.curl_missing".into());
    }

    let total = spec.size;
    let expected = spec.sha256;
    let url = models::model_url(&model);
    let tmp = models::download_tmp_path(&model);
    let dest = models::install_dest(&model);

    std::fs::create_dir_all(models_dir()).map_err(|_| "err.models_dir".to_string())?;
    let _ = std::fs::remove_file(&tmp); // clear any stale partial

    // progress poller: report the growing temp file against the known total
    let stop = Arc::new(AtomicBool::new(false));
    let poller = {
        let (app, model, tmp, stop) = (app.clone(), model.clone(), tmp.clone(), stop.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let downloaded = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
                let _ = app.emit(
                    "model-download-progress",
                    serde_json::json!({ "model": model, "downloaded": downloaded, "total": total }),
                );
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        })
    };

    // download in the blocking pool. `--proto =https` refuses any non-HTTPS
    // redirect; `--fail` turns HTTP errors into a non-zero exit.
    let dl_tmp = tmp.clone();
    let dl = tauri::async_runtime::spawn_blocking(move || {
        proc::command("curl")
            .args(["-fSL", "--proto", "=https", "--tlsv1.2", "-o"])
            .arg(&dl_tmp)
            .arg(&url)
            .status()
    })
    .await;

    stop.store(true, Ordering::Relaxed);
    let _ = poller.join();

    let ok = matches!(&dl, Ok(Ok(s)) if s.success());
    if !ok {
        let _ = std::fs::remove_file(&tmp);
        error!(model = %model, "model download failed");
        return Err("err.download_failed".into());
    }

    models::verify_and_install(&tmp, &dest, expected)?;
    let _ = app.emit(
        "model-download-progress",
        serde_json::json!({ "model": model, "downloaded": total, "total": total }),
    );
    let _ = app.emit("model-download-done", &model);
    info!(model = %model, "model installed");
    Ok(())
}

// The model file a transcription run will load, refusing anything that is not
// the whole model. Existence alone was the old check, and a truncated download
// passed it: whisper then aborted with "not all tensors loaded from model file"
// *after* capture had started, so the user saw the meter running and no
// transcript, with the real cause only in engine.log. Both errors are
// actionable in the UI — settings opens on either so the model can be fetched.
fn resolve_model(id: &str) -> Result<PathBuf, String> {
    let model = model_path(id);
    if !model.exists() {
        error!(model = %model.display(), "model not found");
        return Err(format!("err.model_not_found:{}", model.display()));
    }
    if !models::is_installed(id) {
        error!(model = %id, "model file incomplete");
        return Err(format!("err.model_incomplete:{id}"));
    }
    Ok(model)
}

// builds the whisper-stream arguments (isolated so it is testable)
// capture: capture-device index (-c); None = default device (mic)
fn stream_args(
    model_path: &str,
    lang: &str,
    translate: bool,
    threads: &str,
    capture: Option<i32>,
) -> Vec<String> {
    let mut a = vec![
        "-m".into(),
        model_path.into(),
        "-l".into(),
        lang.into(),
        "--step".into(),
        "0".into(),
        "--length".into(),
        "5000".into(),
        "-vth".into(),
        "0.6".into(),
        "-t".into(),
        threads.into(),
    ];
    if let Some(id) = capture {
        a.push("-c".into());
        a.push(id.to_string());
    }
    if translate {
        a.push("-tr".into());
    }
    a
}

// builds the whisper-cli arguments (file transcription, no streaming/VAD)
fn cli_args(
    model_path: &str,
    lang: &str,
    translate: bool,
    threads: &str,
    wav_path: &str,
) -> Vec<String> {
    let mut a = vec![
        "-m".into(),
        model_path.into(),
        "-l".into(),
        lang.into(),
        "-t".into(),
        threads.into(),
        "-f".into(),
        wav_path.into(),
    ];
    if translate {
        a.push("-tr".into());
    }
    a
}

// name of the converted 16kHz WAV: same directory as the source file, suffix
// ".16k.wav" (same convention as loro.sh cmd_file)
fn wav_path_for(src: &Path) -> PathBuf {
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("audio");
    src.with_file_name(format!("{stem}.16k.wav"))
}

#[derive(Deserialize)]
pub(crate) struct StartCfg {
    pub(crate) model: String,
    pub(crate) lang: String,
    #[serde(default)]
    translate: bool,
    #[serde(default)]
    threads: Option<u32>,
    #[serde(default)]
    capture: Option<i32>, // device index (system audio); None = mic
}

#[derive(serde::Serialize)]
struct CaptureDevice {
    index: i32,
    name: String,
}

// lists the capture devices exactly as whisper-stream enumerates them
// (same indexing the -c flag uses). Spawns and reads stderr up to the list.
fn capture_devices() -> Result<Vec<CaptureDevice>, String> {
    let bin = whisper_bin();
    if !bin.exists() {
        return Err(format!("err.whisper_stream_not_found:{}", bin.display()));
    }
    // any model just so the binary starts; killed as soon as the list is read.
    // It must be a *complete* one — whisper aborts on a truncated file before
    // it ever prints the device list.
    let model = if models::is_installed("small") {
        model_path("small")
    } else {
        model_path("large-v3-turbo")
    };
    let mut child = proc::command(&bin)
        .args(["-m", &model.to_string_lossy(), "-c", "999"]) // invalid -c: lists devices and exits
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    let mut devices = Vec::new();
    if let Some(err) = child.stderr.take() {
        let reader = BufReader::new(err);
        for line in reader.lines().map_while(Result::ok) {
            // format: "init:    - Capture device #0: 'Microfone (MacBook Pro)'"
            if let Some(rest) = line.split("Capture device #").nth(1) {
                if let Some((num, name)) = rest.split_once(':') {
                    if let Ok(index) = num.trim().parse::<i32>() {
                        let name = name.trim().trim_matches('\'').to_string();
                        devices.push(CaptureDevice { index, name });
                    }
                }
            }
            // everything listed: stop reading
            if line.contains("attempt to open") || devices.len() > 32 {
                break;
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    Ok(devices)
}

#[tauri::command]
fn list_capture_devices() -> Result<Vec<CaptureDevice>, String> {
    capture_devices()
}

// One utterance of a transcription: WHEN it was said (ms into the transcribed
// window) and what was said. ADR-0025: whisper hands these timestamps over for
// free and they used to be discarded, which is what forced a meeting to stamp a
// whole 18s window with a single time — only its first utterance was ever true,
// and cross-track comparison had nothing finer than the window to reason with.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpokenSegment {
    pub(crate) t_ms: u64,
    pub(crate) end_ms: u64,
    pub(crate) text: String,
}

// "hh:mm:ss.mmm" / "mm:ss.mmm" / "mm:ss" -> ms. The LAST field is seconds and the
// ones before it are minutes then hours, so both the whisper-cli and the
// whisper-stream shapes read correctly without two parsers.
fn parse_timecode(s: &str) -> Option<u64> {
    let parts: Vec<&str> = s.trim().split(':').collect();
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    let last = parts[parts.len() - 1];
    let (secs, frac) = match last.split_once(['.', ',']) {
        Some((a, b)) => (a, b),
        None => (last, ""),
    };
    let mut ms = secs.trim().parse::<u64>().ok()? * 1000;
    if !frac.is_empty() {
        let digits: String = frac.chars().take(3).collect();
        if !digits.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        ms += digits.parse::<u64>().ok()? * 10u64.pow(3 - digits.len() as u32);
    }
    let mut unit = 60_000u64; // minutes, then hours
    for p in parts[..parts.len() - 1].iter().rev() {
        ms += p.trim().parse::<u64>().ok()? * unit;
        unit *= 60;
    }
    Some(ms)
}

// The ONE parser for a whisper output line: "[hh:mm:ss.mmm --> hh:mm:ss.mmm] text".
// Gives back the text plus, when the timecode is readable, the times. Two parsers
// is how a line's text and its timecode drift apart.
fn extract_line(line: &str) -> Option<(Option<(u64, u64)>, String)> {
    if !line.contains("-->") {
        return None;
    }
    let idx = line.find(']')?;
    let t = line[idx + 1..].trim();
    if t.is_empty() || t == "[Start speaking]" {
        return None;
    }
    let times = line[..idx]
        .rfind('[')
        .and_then(|open| line[open + 1..idx].split_once("-->"))
        .and_then(|(a, b)| Some((parse_timecode(a)?, parse_timecode(b)?)));
    Some((times, t.to_string()))
}

// extracts the text from whisper-stream lines: "[hh:mm --> hh:mm]   text"
fn extract_text(line: &str) -> Option<String> {
    extract_line(line).map(|(_, text)| text)
}

// marks the recording state; icon blinking is owned by the tray thread
fn set_tray_recording(state: &AppState, on: bool) {
    state.recording.store(on, Ordering::Relaxed);
    if let Some(tray) = state.tray.lock().unwrap().as_ref() {
        let tooltip = if on {
            tray_labels(&ui_lang()).tooltip_recording
        } else {
            "Loro"
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

// filename with no separators/traversal (auto-save)
fn is_safe_filename(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '))
}

// ---- commands ---------------------------------------------------------------
#[tauri::command]
fn start(app: AppHandle, state: State<AppState>, cfg: StartCfg) -> Result<(), String> {
    // kill the previous process, if any
    {
        let mut guard = state.child.lock().unwrap();
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    let bin = whisper_bin();
    if !bin.exists() {
        error!(bin = %bin.display(), "whisper-stream not found");
        return Err(
            "whisper-stream não encontrado. Instale o engine (macOS: brew install whisper-cpp) \
             ou aponte WHISPER_STREAM_BIN para o binário."
                .into(),
        );
    }
    let model = resolve_model(&cfg.model)?;
    let threads = cfg.threads.unwrap_or(8).to_string();

    let args = stream_args(
        &model.to_string_lossy(),
        &cfg.lang,
        cfg.translate,
        &threads,
        cfg.capture,
    );
    let mut command = proc::command(&bin);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|e| {
        error!(error = %e, "failed to spawn whisper-stream");
        format!("failed to start: {e}")
    })?;
    info!(model = %cfg.model, lang = %cfg.lang, system_audio = cfg.capture.is_some(), "transcription started");

    // stdout -> transcription events
    if let Some(out) = child.stdout.take() {
        let app2 = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(text) = extract_text(&line) {
                    let _ = app2.emit("transcript-line", text);
                }
            }
            // stdout EOF => the engine stopped
            let _ = app2.emit("rec-state", false);
        });
    }
    // stderr -> loro-engine.log (whisper-stream diagnostics)
    if let Some(err) = child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::Write;
            let path = loro_data_dir().join("logs/engine.log");
            if let Some(p) = path.parent() {
                let _ = std::fs::create_dir_all(p);
            }
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .ok();
            let reader = BufReader::new(err);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(f) = f.as_mut() {
                    let _ = writeln!(f, "{line}");
                }
            }
        });
    }

    *state.child.lock().unwrap() = Some(child);
    set_tray_recording(state.inner(), true);
    let _ = app.emit("rec-state", true);
    Ok(())
}

#[tauri::command]
fn stop(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    if let Some(mut child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    set_tray_recording(state.inner(), false);
    let _ = app.emit("rec-state", false);
    Ok(())
}

// Offline mode (ADR-0003 "two transcription modes"): the whole recording is transcribed at once with
// whisper-cli (no VAD/streaming) — meant to be more faithful than the live
// whisper-stream/VAD path. Converts to 16kHz mono WAV via ffmpeg first, same
// as loro.sh's `cmd_file`.
//
// The command returns as soon as the (cheap) preflight checks pass; the actual
// ffmpeg + whisper-cli work runs on a blocking-pool task so it never ties up
// the main/UI thread. Progress and the result stream back as `transcript-line`
// events (the same event the live engine emits), with `transcribe-state`
// marking start/end and `transcribe-error` carrying failures.
#[tauri::command]
async fn transcribe_file(app: AppHandle, path: String, cfg: StartCfg) -> Result<(), String> {
    let cli = whisper_cli_bin();
    if !cli.exists() {
        error!(bin = %cli.display(), "whisper-cli not found");
        return Err(
            "whisper-cli não encontrado. Instale o engine (macOS: brew install whisper-cpp) \
             ou aponte WHISPER_CLI_BIN para o binário."
                .into(),
        );
    }
    let model = resolve_model(&cfg.model)?;
    let Some(ffmpeg) = which("ffmpeg") else {
        return Err(ffmpeg_not_found_err());
    };
    let ffmpeg = PathBuf::from(ffmpeg);
    let threads = cfg.threads.unwrap_or(8).to_string();
    let src = PathBuf::from(&path);
    let wav = wav_path_for(&src);

    info!(model = %cfg.model, lang = %cfg.lang, "file transcription started");
    let _ = app.emit("transcribe-state", true);
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = run_file_transcription(
            &ffmpeg,
            &src,
            &wav,
            &cli,
            &model,
            &cfg.lang,
            cfg.translate,
            &threads,
            &app2,
        );
        if let Err(e) = &result {
            error!(error = %e, "file transcription failed");
            let _ = app2.emit("transcribe-error", e.clone());
        }
        info!(ok = result.is_ok(), "file transcription finished");
        let _ = app2.emit("transcribe-state", false);
    });
    Ok(())
}

// converts `src` to 16kHz mono WAV (ffmpeg), then spawns whisper-cli and
// streams its stdout into `transcript-line` events (same parser as the live
// engine — whisper-cli prints the same "[hh:mm --> hh:mm]  text" lines).
#[allow(clippy::too_many_arguments)]
fn run_file_transcription(
    ffmpeg: &Path,
    src: &Path,
    wav: &Path,
    cli: &Path,
    model: &Path,
    lang: &str,
    translate: bool,
    threads: &str,
    app: &AppHandle,
) -> Result<(), String> {
    let out = proc::command(ffmpeg)
        .arg("-y")
        .args(["-loglevel", "error"])
        .arg("-i")
        .arg(src)
        .args(["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"])
        .arg(wav)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }

    transcribe_wav(wav, cli, model, lang, translate, threads, app)
}

// runs whisper-cli on an already-prepared 16kHz mono WAV, streaming its stdout
// into `transcript-line` events. Shared by file mode and meeting mode.
#[allow(clippy::too_many_arguments)]
fn transcribe_wav(
    wav: &Path,
    cli: &Path,
    model: &Path,
    lang: &str,
    translate: bool,
    threads: &str,
    app: &AppHandle,
) -> Result<(), String> {
    let args = cli_args(
        &model.to_string_lossy(),
        lang,
        translate,
        threads,
        &wav.to_string_lossy(),
    );
    let mut child = proc::command(cli)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    if let Some(out) = child.stdout.take() {
        let reader = BufReader::new(out);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(text) = extract_text(&line) {
                let _ = app.emit("transcript-line", text);
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("err.whisper_cli_failed".into());
    }
    Ok(())
}

// ---- pseudo-stream (ADR-0010 promoted by ADR-0012) --------------------------
//
// A BEST-EFFORT live preview: instead of emitting the global `transcript-line`,
// the windowed path RETURNS the segment texts so the meeting layer can persist
// them via brain_meeting_append while the meeting is still recording. The
// authoritative mic+system mix+transcription at brain_meeting_stop stays the
// source of truth and reconciles this preview; window edges may be imperfect.
// transcribe_wav (file mode + meeting stop) is intentionally left UNCHANGED —
// this is strictly additive.

// milliseconds as ffmpeg seconds (`S.mmm`), e.g. 61500 -> "61.500".
fn secs_str(ms: u64) -> String {
    format!("{}.{:03}", ms / 1000, ms % 1000)
}

// ffmpeg args that carve [from_ms, to_ms] of `src` into a 16kHz mono WAV at
// `dst`. `-ss` is an INPUT seek (fast; resets output timestamps to 0), so when a
// `to_ms` is given the `-to` output bound is the WINDOW DURATION (to - from),
// guarded so it never goes negative. Pure/deterministic for unit testing.
fn window_ffmpeg_args(src: &Path, dst: &Path, from_ms: u64, to_ms: Option<u64>) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "-y".into(),
        "-loglevel".into(),
        "error".into(),
        "-ss".into(),
        secs_str(from_ms),
        "-i".into(),
        src.to_string_lossy().into_owned(),
    ];
    if let Some(to) = to_ms {
        a.push("-to".into());
        a.push(secs_str(to.saturating_sub(from_ms)));
    }
    for s in ["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"] {
        a.push(s.into());
    }
    a.push(dst.to_string_lossy().into_owned());
    a
}

// Parse a whisper-cli stdout blob into TIMED segments, reusing the same
// `extract_line` parser as the live/file paths (no divergent parsing). A spoken
// line whose timecode is unreadable keeps its text and inherits the previous
// segment's end: under ADR-0018 the live transcript is the meeting's only output,
// so speech is never dropped over a timecode.
fn parse_whisper_segments(stdout: &str) -> Vec<SpokenSegment> {
    let mut out: Vec<SpokenSegment> = Vec::new();
    let mut cursor = 0u64;
    for line in stdout.lines() {
        let Some((times, text)) = extract_line(line) else {
            continue;
        };
        let (t_ms, end_ms) = match times {
            Some((a, b)) => (a, b.max(a)),
            None => (cursor, cursor),
        };
        cursor = end_ms;
        out.push(SpokenSegment { t_ms, end_ms, text });
    }
    out
}

// Duration (ms) of a canonical PCM WAV from its BYTES. Uses the `fmt ` chunk's
// byte-rate and the ACTUAL bytes after the `data` chunk header — not the stored
// data-size field — so it is correct even while a sidecar is still growing the
// file with a placeholder size. `None` if the blob is not a WAV we can measure.
pub(crate) fn wav_duration_ms_from_bytes(b: &[u8]) -> Option<u64> {
    if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return None;
    }
    let mut byte_rate: Option<u32> = None;
    let mut pos = 12usize;
    while pos + 8 <= b.len() {
        let id = &b[pos..pos + 4];
        let size = u32::from_le_bytes([b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]]) as usize;
        let body = pos + 8;
        if id == b"fmt " && body + 16 <= b.len() {
            byte_rate = Some(u32::from_le_bytes([
                b[body + 8],
                b[body + 9],
                b[body + 10],
                b[body + 11],
            ]));
        }
        if id == b"data" {
            let br = byte_rate? as u64;
            if br == 0 {
                return None;
            }
            let available = b.len().saturating_sub(body) as u64;
            return Some(available * 1000 / br);
        }
        // chunks are word-aligned; advance by the declared size (padded).
        pos = body + size + (size & 1);
    }
    None
}

// Where a window is carved before whisper reads it. UNIQUE per call, and that is
// the whole point: the meeting's two tracks rotate on the same 18s tick, so on the
// FIRST tick both carve with from_ms=0, into the same meeting's audio dir. With the
// offset alone in the name they landed on ONE file from two threads — two ffmpeg
// processes writing it and the first to finish deleting it under the other. The
// first 18 seconds of a meeting came out empty on BOTH tracks, and only the first,
// because from the second tick on the offsets differ. Same bug class as the
// snapshot in ADR-0022 §407.
//
// The id is a process counter, not the clock: the two carves start in the same
// instant, so nanoseconds can tie.
fn window_carve_path(src: &Path, from_ms: u64) -> PathBuf {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let id = N.fetch_add(1, Ordering::Relaxed);
    src.with_file_name(format!(".window-{from_ms}-{id}.wav"))
}

// Transcribe just the window [from_ms, to_ms] of an already-16k-or-any WAV and
// RETURN its timed segments (no global event). The caller owns any overlap
// (~1.5s) and the offset bookkeeping. Additive sibling of transcribe_wav.
//
// The returned times are relative to the WINDOW, not to the file: `-ss` is an
// input seek, which resets the output timestamps to zero (window_ffmpeg_args), so
// a segment's offset inside the source is `from_ms + seg.t_ms`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn transcribe_wav_window(
    ffmpeg: &Path,
    src: &Path,
    cli: &Path,
    model: &Path,
    lang: &str,
    translate: bool,
    threads: &str,
    from_ms: u64,
    to_ms: Option<u64>,
) -> Result<Vec<SpokenSegment>, String> {
    let dst = window_carve_path(src, from_ms);
    let carve = proc::command(ffmpeg)
        .args(window_ffmpeg_args(src, &dst, from_ms, to_ms))
        .output()
        .map_err(|e| e.to_string())?;
    if !carve.status.success() {
        let _ = std::fs::remove_file(&dst);
        return Err(String::from_utf8_lossy(&carve.stderr).to_string());
    }
    let args = cli_args(
        &model.to_string_lossy(),
        lang,
        translate,
        threads,
        &dst.to_string_lossy(),
    );
    let out = proc::command(cli)
        .args(&args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&dst);
    let out = out?;
    if !out.status.success() {
        return Err("err.whisper_cli_failed".into());
    }
    Ok(parse_whisper_segments(&String::from_utf8_lossy(
        &out.stdout,
    )))
}

// ffmpeg: mixes the microphone track and the system-audio track into one 16kHz
// mono WAV. `normalize=0` keeps original levels (amix lowers them by default);
// `duration=longest` covers small start-offset differences between the two
// independently-started recordings. Either input may be absent (mic permission
// denied, or no system audio) — then it degrades to a plain conversion.
pub(crate) fn mix_to_wav(
    ffmpeg: &Path,
    mic: Option<&Path>,
    sys: Option<&Path>,
    wav: &Path,
) -> Result<(), String> {
    let mut cmd = proc::command(ffmpeg);
    cmd.arg("-y").args(["-loglevel", "error"]);
    match (mic, sys) {
        (Some(m), Some(s)) => {
            cmd.arg("-i").arg(m).arg("-i").arg(s).args([
                "-filter_complex",
                "[0:a][1:a]amix=inputs=2:duration=longest:normalize=0",
            ]);
        }
        (Some(only), None) | (None, Some(only)) => {
            cmd.arg("-i").arg(only);
        }
        (None, None) => return Err("err.no_audio_to_transcribe".into()),
    }
    let out = cmd
        .args(["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"])
        .arg(wav)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

pub(crate) fn epoch_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

// Resolve the system-audio capturer: packaged resource dir first, then the
// dev/PATH resolution in paths.rs (ADR-0005).
fn resolve_syscap(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().resource_dir() {
        for cand in [
            dir.join("loro-syscap"),
            dir.join("syscap").join("loro-syscap"),
        ] {
            if cand.is_file() {
                return cand;
            }
        }
    }
    syscap_bin()
}

// Meeting mode (ADR-0005): start capturing the computer's system audio to a WAV
// via the ScreenCaptureKit sidecar. Returns the WAV path the frontend later hands
// to `transcribe_meeting`. Fails fast (macOS Screen Recording permission) so the
// UI can prompt the user before recording their microphone in vain.
#[tauri::command]
fn start_system_capture(app: AppHandle, state: State<AppState>) -> Result<String, String> {
    system_capture_start(&app, &state)
}

// ADR-0025: the epoch (ms) of the first audio sample each capture segment wrote —
// the WAV's own t=0, reported by the sidecar at the only moment it is knowable.
// Keyed by the WAV path, so a paused/resumed meeting keeps one anchor per segment.
// This used to be ESTIMATED by the frontend, which is how a meeting's two tracks
// ended up on clocks up to seconds apart.
fn syscap_anchors() -> &'static Mutex<std::collections::HashMap<PathBuf, u64>> {
    static ANCHORS: OnceLock<Mutex<std::collections::HashMap<PathBuf, u64>>> = OnceLock::new();
    ANCHORS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

const SYSCAP_ANCHOR_PREFIX: &str = "first-sample-epoch-ms ";

// The sidecar's one machine-readable line. Pure so the contract with the Swift
// side is testable: a silent mismatch here would disable the anchor and the
// fallback is deliberately quiet, so nothing would look broken.
fn parse_anchor_line(line: &str) -> Option<u64> {
    line.trim()
        .strip_prefix(SYSCAP_ANCHOR_PREFIX)
        .and_then(|n| n.trim().parse::<u64>().ok())
}

// The anchor of a capture segment, or `None` while it has not been reported yet
// (a silent machine delays the sidecar's first buffer, and an older sidecar binary
// never reports at all). The caller degrades; it never fails.
pub(crate) fn syscap_anchor_of(path: &Path) -> Option<u64> {
    syscap_anchors().lock().ok()?.get(path).copied()
}

// Forget a finished segment's anchor (called when its WAV leaves the temp dir).
pub(crate) fn syscap_anchor_forget(path: &Path) {
    if let Ok(mut m) = syscap_anchors().lock() {
        m.remove(path);
    }
}

// Core of the sidecar start, callable from meeting.rs (ADR-0010) as a plain
// pub(crate) fn — the #[tauri::command] wrapper cannot be reused directly.
pub(crate) fn system_capture_start(app: &AppHandle, state: &AppState) -> Result<String, String> {
    // The sidecar is Swift + ScreenCaptureKit, so meeting mode exists on macOS
    // only. Say that instead of letting the spawn fail and surfacing an internal
    // binary name ("loro-syscap (program not found)"), which tells the user
    // nothing about what to do next.
    if !cfg!(target_os = "macos") {
        return Err("err.meeting_macos_only".into());
    }
    {
        let mut guard = state.syscap.lock().unwrap();
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    let bin = resolve_syscap(app);
    let dir = recordings_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(format!("loro-sys-{}.wav", epoch_millis()));

    let mut child = proc::command(&bin)
        .arg(&out)
        .stdin(Stdio::piped()) // closing this stdin later signals a clean stop
        .stdout(Stdio::piped()) // ADR-0025: the first-sample epoch arrives here
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            error!(bin = %bin.display(), error = %e, "failed to spawn syscap");
            format!("err.syscap_not_found:{} ({e})", bin.display())
        })?;

    if let Some(errpipe) = child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::Write;
            let path = loro_data_dir().join("logs/engine.log");
            if let Some(p) = path.parent() {
                let _ = std::fs::create_dir_all(p);
            }
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .ok();
            for line in BufReader::new(errpipe).lines().map_while(Result::ok) {
                if let Some(f) = f.as_mut() {
                    let _ = writeln!(f, "{line}");
                }
            }
        });
    }

    // ADR-0025: the sidecar reports the epoch of its first written sample on
    // stdout. Read it on its own thread — it may land after this function returns
    // (a silent machine delays the first buffer), and it is still the right anchor
    // whenever it lands.
    let (anchor_tx, anchor_rx) = std::sync::mpsc::channel::<u64>();
    if let Some(outpipe) = child.stdout.take() {
        let key = out.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(outpipe).lines().map_while(Result::ok) {
                if let Some(epoch) = parse_anchor_line(&line) {
                    syscap_anchors().lock().unwrap().insert(key, epoch);
                    let _ = anchor_tx.send(epoch);
                    return;
                }
            }
        });
    }

    // A Screen Recording (TCC) denial makes the sidecar exit fast with code 4;
    // poll briefly so we can return an actionable error instead of "recording".
    for _ in 0..12 {
        match child.try_wait() {
            Ok(Some(status)) => {
                let code = status.code().unwrap_or(-1);
                return Err(if code == 4 {
                    "err.screen_recording_denied".into()
                } else {
                    format!("err.capture_exited:{code}")
                });
            }
            Ok(None) => {}
            Err(e) => return Err(e.to_string()),
        }
        // An anchor PROVES the capture is running, so a denial is no longer
        // possible and the rest of the poll is dead waiting. Starting a meeting
        // drops from ~1.2s to ~0.3s — and every millisecond paid here used to be
        // skew between the two tracks.
        if anchor_rx.try_recv().is_ok() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    info!(out = %out.display(), "system audio capture started");
    *state.syscap.lock().unwrap() = Some(child);
    Ok(out.to_string_lossy().into_owned())
}

// Stop the system-audio capturer cleanly: closing its stdin signals EOF, the
// sidecar finalizes the WAV header and exits; we then reap it.
#[tauri::command]
fn stop_system_capture(state: State<AppState>) -> Result<(), String> {
    system_capture_stop(&state);
    Ok(())
}

// Core of the sidecar stop, callable from meeting.rs (ADR-0010).
pub(crate) fn system_capture_stop(state: &AppState) {
    if let Some(mut child) = state.syscap.lock().unwrap().take() {
        drop(child.stdin.take());
        let _ = child.wait();
        info!("system audio capture stopped");
    }
}

// Meeting mode (ADR-0005): mix the recorded microphone and system-audio tracks
// into one 16kHz mono WAV (ffmpeg) and transcribe it whole with whisper-cli —
// same event flow (`transcript-line`/`transcribe-state`/`transcribe-error`) as
// file mode. Either track may be absent; at least one is required.
#[tauri::command]
async fn transcribe_meeting(
    app: AppHandle,
    mic_path: Option<String>,
    sys_path: Option<String>,
    cfg: StartCfg,
) -> Result<(), String> {
    let cli = whisper_cli_bin();
    if !cli.exists() {
        error!(bin = %cli.display(), "whisper-cli not found");
        return Err(
            "whisper-cli não encontrado. Instale o engine (macOS: brew install whisper-cpp) \
             ou aponte WHISPER_CLI_BIN para o binário."
                .into(),
        );
    }
    let model = resolve_model(&cfg.model)?;
    let Some(ffmpeg) = which("ffmpeg") else {
        return Err(ffmpeg_not_found_err());
    };
    let ffmpeg = PathBuf::from(ffmpeg);
    let mic = mic_path.map(PathBuf::from);
    let sys = sys_path.map(PathBuf::from);
    let Some(base) = sys.clone().or_else(|| mic.clone()) else {
        return Err("err.nothing_recorded".into());
    };
    let wav = wav_path_for(&base);
    let threads = cfg.threads.unwrap_or(8).to_string();

    info!(model = %cfg.model, lang = %cfg.lang, mic = mic.is_some(), system = sys.is_some(), "meeting transcription started");
    let _ = app.emit("transcribe-state", true);
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = mix_to_wav(&ffmpeg, mic.as_deref(), sys.as_deref(), &wav).and_then(|_| {
            transcribe_wav(
                &wav,
                &cli,
                &model,
                &cfg.lang,
                cfg.translate,
                &threads,
                &app2,
            )
        });
        if let Err(e) = &result {
            error!(error = %e, "meeting transcription failed");
            let _ = app2.emit("transcribe-error", e.clone());
        }
        info!(ok = result.is_ok(), "meeting transcription finished");
        let _ = app2.emit("transcribe-state", false);
    });
    Ok(())
}

#[tauri::command]
async fn save_transcript(app: AppHandle, content: String) -> Result<Option<String>, String> {
    let dialog = app.dialog().clone();
    let file = tauri::async_runtime::spawn_blocking(move || {
        dialog
            .file()
            .add_filter("Markdown", &["md"])
            .add_filter("Texto", &["txt"])
            .set_file_name("transcricao.md")
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    match file {
        Some(fp) => {
            let path = fp.to_string();
            std::fs::write(&path, content).map_err(|e| e.to_string())?;
            Ok(Some(path))
        }
        None => Ok(None),
    }
}

// native folder picker (config: default storage location)
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    let dialog = app.dialog().clone();
    let folder = tauri::async_runtime::spawn_blocking(move || dialog.file().blocking_pick_folder())
        .await
        .map_err(|e| e.to_string())?;
    Ok(folder.map(|f| f.to_string()))
}

// default auto-save dir = inbox of the configured acervo (the loop reads it here)
#[tauri::command]
fn default_save_dir() -> String {
    if let Some(cfg) = read_brain_config() {
        return format!("{}/inbox", cfg.brain_dir);
    }
    default_brain_dir().join("inbox").display().to_string()
}

// generic default acervo location (no personal paths in code, see ADR-0011).
// The actual instance path is stored in ~/.loro/config.json.
fn default_brain_dir() -> PathBuf {
    user_home().join("Documents/Loro")
}

// The folder a NEW project defaults to: `Documents/Loro` while it is free, then
// the same name with a numeric suffix. A folder that already holds a project is
// refused (resolve_acervo_slot), so offering it as the default opened the wizard
// on a red refusal the user had not caused — the one state a second project could
// ever start in. Pure over the configured list so it stays deterministic.
fn first_free_acervo_dir(acervos: &[Acervo], base: &Path) -> PathBuf {
    let taken = |p: &Path| acervos.iter().any(|a| Path::new(&a.dir) == p);
    if !taken(base) {
        return base.to_path_buf();
    }
    let name = base
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Loro")
        .to_string();
    let parent = base.parent().unwrap_or(base);
    (2..=99)
        .map(|n| parent.join(format!("{name} {n}")))
        .find(|p| !taken(p))
        // 98 projects in one place: the taken-check still refuses honestly
        .unwrap_or_else(|| base.to_path_buf())
}

// The wizard shows the folder that WILL be used when none is picked — the
// same fallback brain_setup applies to an empty dir (all data visible up
// front, ADR-0022 §30).
#[tauri::command]
fn default_acervo_dir() -> String {
    first_free_acervo_dir(&read_loro_config().acervos, &default_brain_dir())
        .display()
        .to_string()
}

// ============================ brain (acervo) ==================================
// The brain is generic: contexts are defined by the user in Loro's setup.
// Global config in ~/.loro/config.json (also read by the /brain command).

// a single context path segment: lowercase slug
fn valid_segment(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 40
        && !s.starts_with('-')
        && !s.ends_with('-')
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

// a context name may be hierarchical (e.g. "engineering/frontend"), up to 3
// levels; each segment is a lowercase slug. Guards against path traversal.
// A domain is recursive (ADR-0005): a context is itself a domain with
// context.md + CHANGELOG.md that MAY contain subdomain folders in the same shape.
// The bound is a safety limit against pathological trees, not the old 3-level cap.
const MAX_CONTEXT_DEPTH: usize = 6;

pub(crate) fn valid_context(name: &str) -> bool {
    let parts: Vec<&str> = name.split('/').collect();
    !parts.is_empty() && parts.len() <= MAX_CONTEXT_DEPTH && parts.iter().all(|p| valid_segment(p))
}

// context (the official source of truth, MARKDOWN); {{CONTEXT}} = name.
// Section "Hotspots" holds the unconsolidated. The usage template may provide
// its own per-vertical mold (ADR-0003); the baseline template is the fallback.
fn context_md(name: &str, lang: &str, mold: Option<&str>) -> String {
    mold.unwrap_or_else(|| context_template(lang))
        .replace("{{CONTEXT}}", name)
}

// the single knowledge file of a context; "guia.md" is the legacy name (kept so
// pre-migration acervos still resolve — see brain_migrate).
fn context_file(dir: &Path) -> Option<PathBuf> {
    for name in ["context.md", "guia.md"] {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn seed_context(base: &Path, name: &str, lang: &str, mold: Option<&str>) -> Result<(), String> {
    let d = crate::paths::contexts_dir(base).join(name);
    std::fs::create_dir_all(&d).map_err(|e| folder_write_error(&e))?;
    let ch = d.join("CHANGELOG.md");
    if !ch.exists() {
        let body = if lang == "en" {
            format!("# {name} — CHANGELOG\n\n> Dated history of this context's knowledge (append-only; the loop never rewrites prior entries).\n")
        } else {
            format!("# {name} — CHANGELOG\n\n> Registro cronológico do conhecimento deste contexto, escrito como documentação.\n> O loop apenas acrescenta entradas datadas; nunca reescreve as anteriores.\n")
        };
        std::fs::write(&ch, body).map_err(|e| folder_write_error(&e))?;
    }
    // Non-destructive: only seed context.md when neither the new nor the legacy
    // knowledge file exists (an already-populated context is never overwritten).
    if context_file(&d).is_none() {
        std::fs::write(d.join("context.md"), context_md(name, lang, mold))
            .map_err(|e| folder_write_error(&e))?;
    }
    // Ideas are no longer files: unconsolidated knowledge lives as HOTSPOTS inside
    // context.md. New contexts get no brainstorming/ folder; legacy folders on
    // disk are left untouched (migration decides their fate).
    Ok(())
}

// utility subfolders that belong to a context, not contexts themselves. Includes
// legacy idea/reference folders so a pre-migration acervo never lists them as
// contexts.
fn is_ctx_util(name: &str) -> bool {
    matches!(
        name,
        "brainstorming" | "referencias" | "incubadora" | "references" | "ideas" | "changes"
    )
}

// non-utility, visible child directories of `dir` (candidate contexts/groups)
fn ctx_child_dirs(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().is_dir())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| !n.starts_with('.') && !n.starts_with('_') && !is_ctx_util(n))
                .collect()
        })
        .unwrap_or_default()
}

// Contexts derived from disk. A directory under contexts/ is a CONTEXT when it
// has a context.md (or legacy guia.md) OR it is a leaf (no context children) — so
// a folder the user creates by hand is mapped even before it has one. Dirs that only
// group sub-contexts are treated as folders (not listed here). Hierarchical
// slug, e.g. "engenharia/frontend". Skips hidden/utility dirs.
fn list_contexts(base: &Path) -> Vec<String> {
    fn walk(dir: &Path, prefix: &str, depth: usize, out: &mut Vec<String>) {
        if depth > MAX_CONTEXT_DEPTH {
            return;
        }
        for name in ctx_child_dirs(dir) {
            let p = dir.join(&name);
            let full = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let children = ctx_child_dirs(&p);
            if context_file(&p).is_some() || children.is_empty() {
                out.push(full.clone());
            }
            walk(&p, &full, depth + 1, out);
        }
    }
    let mut out = Vec::new();
    walk(&crate::paths::contexts_dir(base), "", 1, &mut out);
    out.sort();
    out.dedup();
    out
}

#[tauri::command]
fn brain_get_config() -> Option<BrainConfig> {
    read_brain_config()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AcervosView {
    acervos: Vec<Acervo>,
    active: String,
}

fn acervos_view() -> AcervosView {
    let cfg = read_loro_config();
    AcervosView {
        active: active_acervo(&cfg)
            .map(|a| a.id.clone())
            .unwrap_or_default(),
        acervos: cfg.acervos,
    }
}

// Materialize the acervo folder structure (idempotent, non-destructive).
// `tpl` is the usage template (preset, ADR-0003) applied only at creation:
// AGENTS.md vertical addendum, extra skills and the initial queue guide.
// A project folder must be a folder Loro can own: an absolute path, and — when
// something is already there — a directory. Inspection only: it never writes, so
// it can run before the one-way door of seeding a template (ADR-0024).
fn acervo_dir_must_be_a_folder(dir: &Path) -> Result<(), String> {
    if dir.as_os_str().is_empty() || !dir.is_absolute() {
        return Err("err.invalid_path".into());
    }
    // N20 — "caminho inválido" is true and useless: the user typed a path that
    // exists and holds something else. The code says WHICH thing is wrong, so the
    // sentence can name the next step (pick another folder).
    if dir.exists() && !dir.is_dir() {
        return Err("err.acervo_dir_is_file".into());
    }
    Ok(())
}

fn ensure_acervo_structure(
    base: &Path,
    ctxs: &[String],
    lang: &str,
    tpl: Option<&TemplateContent>,
) -> Result<(), String> {
    // N20 — every write below lands inside the folder the user typed, so every io
    // failure here is the same statement ("this folder cannot hold a project") and
    // answers with a code the UI translates, never a raw std::io message in
    // English (ADR-0001 §10).
    std::fs::create_dir_all(base).map_err(|e| folder_write_error(&e))?;
    // First setup = no loop state yet. The queue guide (inbox/_prompt.md) is
    // consumed by the loop, so re-materializations must never re-inject it.
    let first_setup = !base.join(".brain/state.json").exists();
    for sub in ["inbox", "processed", ".brain", ".claude/commands"] {
        std::fs::create_dir_all(base.join(sub)).map_err(|e| folder_write_error(&e))?;
    }
    // ADR-0026 §14 — as três pastas renomeadas nascem pelo nome que o DISCO já usa.
    // Criá-las pelo nome novo sem olhar fazia um acervo não migrado ganhar
    // `contexts/` vazia ao lado da `contextos/` cheia: como a resolução prefere a
    // que existe, todo o conhecimento sumia da tela — e a migração passava a
    // reportar "conflito: as duas coexistem" para sempre, sem conserto possível
    // sem apagar pasta na mão. Aqui a estrutura ACOMPANHA o acervo; quem renomeia
    // é a migração, que é um ato do dono.
    for (current, legacy) in [
        ("meetings", "reunioes"),
        ("notes", "notas"),
        ("contexts", "contextos"),
    ] {
        let dir = crate::paths::acervo_dir(base, current, legacy);
        std::fs::create_dir_all(&dir).map_err(|e| folder_write_error(&e))?;
    }
    // /loro-context is the thin Claude adapter for the queue -> context loop
    // (ADR-0013); analyse/answer are the meeting-AI skills the terminal Claude runs
    // over a meeting's live stream (ADR-0012). Neutral instructions live in
    // AGENTS.md. Non-destructive.
    for (rel, body) in [
        (".claude/commands/loro-context.md", brain_skill(lang)),
        (
            ".claude/commands/loro-analyse.md",
            meeting_analyse_skill(lang),
        ),
        (
            ".claude/commands/loro-question.md",
            meeting_question_skill(lang),
        ),
        (".claude/commands/loro-ask.md", brain_ask_skill(lang)),
        (".claude/commands/loro-note.md", loro_note_skill(lang)),
        (".claude/commands/loro-sync.md", loro_sync_skill(lang)),
        (".claude/commands/loro-tool.md", loro_tool_skill(lang)),
        (
            ".claude/commands/loro-presentation.md",
            loro_presentation_skill(lang),
        ),
        (
            ".claude/commands/loro-artifact.md",
            loro_artifact_skill(lang),
        ),
        (".claude/commands/loro-slack.md", loro_slack_skill(lang)),
        (".claude/commands/loro-digest.md", loro_digest_skill(lang)),
    ] {
        let p = base.join(rel);
        if !p.exists() {
            std::fs::write(&p, body).map_err(|e| folder_write_error(&e))?;
        } else {
            refresh_builtin_front_matter(&p, body);
        }
    }
    // Vertical extra skills from the usage template (ADR-0003), after the four
    // standard ones and equally non-destructive.
    if let Some(tpl) = tpl {
        for (name, body) in &tpl.skills {
            let p = base.join(".claude/commands").join(name);
            if !p.exists() {
                std::fs::write(&p, body).map_err(|e| folder_write_error(&e))?;
            }
        }
        if first_setup {
            if let Some(prompt) = &tpl.inbox_prompt {
                let p = base.join("inbox").join(QUEUE_GUIDE_NAME);
                if !p.exists() {
                    std::fs::write(&p, prompt).map_err(|e| folder_write_error(&e))?;
                }
            }
        }
    }
    let mold = tpl.and_then(|t| t.context_md.as_deref());
    for c in ctxs {
        seed_context(base, c, lang, mold)?;
    }
    let state = base.join(".brain/state.json");
    if !state.exists() {
        std::fs::write(&state, "{\"processed\":[]}\n").map_err(|e| folder_write_error(&e))?;
    }
    let act = base.join(".brain/activity.log");
    if !act.exists() {
        std::fs::write(&act, "").map_err(|e| folder_write_error(&e))?;
    }
    // agnostic instruction file (AGENTS.md); keep any legacy CLAUDE.md untouched.
    // The template contributes an addendum, never a replacement — the default
    // body carries the loop mechanics the whole model depends on (ADR-0003).
    let agents = base.join("AGENTS.md");
    if !agents.exists() && !base.join("CLAUDE.md").exists() {
        let mut body = agents_template(ctxs, lang);
        if let Some(extra) = tpl.and_then(|t| t.agents_extra.as_deref()) {
            body.push('\n');
            body.push_str(extra);
        }
        std::fs::write(&agents, body).map_err(|e| folder_write_error(&e))?;
    }
    let index = base.join("INDEX.md");
    if !index.exists() {
        let body = if lang == "en" {
            "# Base index\n\n_The loop fills this index on each run._\n"
        } else {
            "# Índice do acervo\n\n_O loop preenche este índice a cada processamento._\n"
        };
        std::fs::write(&index, body).map_err(|e| folder_write_error(&e))?;
    }
    // ADR-0026 §18 — the índice remissivo is born with the acervo, so a fresh
    // project already opens with both entry documents instead of one.
    let _ = crate::acervo::write_terms(base, lang);
    // Collaboration scaffolding (opt-in): CODEOWNERS defines who approves each
    // context; the PR template is the RFC body. Non-destructive — never touch an
    // existing CODEOWNERS/template (users curate owners by hand).
    std::fs::create_dir_all(base.join(".github")).map_err(|e| folder_write_error(&e))?;
    let codeowners = base.join(".github/CODEOWNERS");
    if !codeowners.exists() {
        std::fs::write(&codeowners, codeowners_template(ctxs, lang))
            .map_err(|e| folder_write_error(&e))?;
    }
    let pr_tmpl = base.join(".github/pull_request_template.md");
    if !pr_tmpl.exists() {
        std::fs::write(&pr_tmpl, pr_template(lang)).map_err(|e| folder_write_error(&e))?;
    }
    Ok(())
}

// Create (or complete) an acervo and add it to the global config, making it
// active. Existing structure is respected (see ADR-0022). With auto_context and
// no contexts given, the loop is free to create/organize contexts itself.
// UI language preference (global, config.json). The frontend reads it on boot
// and re-renders on change; the backend applies it to the tray immediately.
#[tauri::command]
fn ui_get_lang() -> String {
    ui_lang()
}

// The app version (compile-time, from Cargo.toml — kept in sync with
// tauri.conf.json by the release bump). Surfaced in Settings so the user can tell
// at a glance whether an update landed.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn ui_set_lang(lang: String, state: State<AppState>) -> Result<String, String> {
    let lang = normalize_lang(&lang);
    let mut cfg = read_loro_config();
    cfg.ui_lang = lang.clone();
    write_loro_config(&cfg)?;
    let labels = tray_labels(&lang);
    if let Some(items) = state.tray_menu.lock().unwrap().as_ref() {
        let _ = items.show.set_text(labels.show);
        let _ = items.toggle.set_text(labels.toggle);
        let _ = items.quit.set_text(labels.quit);
    }
    Ok(lang)
}

// One folder, one project. `expect_new` carries the user's intent: the wizard's
// "novo projeto" sets it, so setup refuses a folder that already belongs to
// another project instead of taking it over; re-running setup on the SAME
// project leaves it idempotent.
#[derive(Debug, PartialEq, Eq)]
enum AcervoSlot {
    Existing(String),
    New,
}

fn resolve_acervo_slot(
    acervos: &[Acervo],
    dir: &str,
    expect_new: bool,
) -> Result<AcervoSlot, String> {
    match acervos.iter().find(|a| a.dir == dir) {
        Some(a) if expect_new => Err(format!("err.acervo_dir_taken:{}", a.name)),
        Some(a) => Ok(AcervoSlot::Existing(a.id.clone())),
        None => Ok(AcervoSlot::New),
    }
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn brain_setup(
    dir: String,
    contexts: Vec<String>,
    name: Option<String>,
    auto_context: Option<bool>,
    git_init: Option<bool>,
    color: Option<String>,
    lang: Option<String>,
    template: Option<String>,
    agent: Option<String>,
    expect_new: Option<bool>,
) -> Result<AcervosView, String> {
    let dir = if dir.trim().is_empty() {
        default_acervo_dir()
    } else {
        dir.trim().to_string()
    };
    // The folder field is typeable, so the path can be something no folder picker
    // could ever produce. Refuse it with a code the UI translates BEFORE any disk
    // write — the alternative was `ensure_acervo_structure` forwarding a raw
    // std::io message ("Not a directory (os error 20)") into a pt-BR screen.
    acervo_dir_must_be_a_folder(Path::new(&dir))?;
    let auto = auto_context.unwrap_or(false);
    let ctxs: Vec<String> = contexts
        .iter()
        .map(|c| c.trim().to_lowercase().replace(' ', "-"))
        .filter(|c| !c.is_empty())
        .collect();
    if ctxs.is_empty() && !auto {
        return Err("err.context_required".into());
    }
    for c in &ctxs {
        if !valid_context(c) {
            return Err(format!("err.invalid_context:{c}"));
        }
    }
    // A folder holds exactly one project, and this has to be settled BEFORE any
    // disk write: seeding a second template into a folder that already is a
    // project mixes two domains' knowledge, and nothing in the UI undoes it.
    let slot = resolve_acervo_slot(
        &read_loro_config().acervos,
        &dir,
        expect_new.unwrap_or(false),
    )?;
    // ADR-0002 §1: generated content follows the UI language; the per-acervo
    // language field is retired (still stored for older tooling, never asked).
    let lang = lang.map(|l| normalize_lang(&l)).unwrap_or_else(ui_lang);
    // Usage template (ADR-0003): resolve early so an unknown id fails before
    // any disk write. Only the id is ever logged (BR-8).
    let template = template
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(default_template);
    let tpl = resolve_template(&template, &lang)?;
    let agent = normalize_agent(&agent.unwrap_or_default());
    let base = PathBuf::from(&dir);
    ensure_acervo_structure(&base, &ctxs, &lang, Some(&tpl))?;
    write_acervo_settings(&base, auto)?;
    if git_init.unwrap_or(false) {
        git_init_repo(&base)?;
        // The project needs an official branch from day one: without a baseline
        // commit the first "salvar versão" renames the unborn default branch and
        // every version of the knowledge base lives on a rascunho forever, with
        // nothing for the team's approval to make official. Best effort: a git
        // that cannot commit must not abort a project that is already on disk —
        // create_branch repairs the baseline on the versioning path.
        if let Err(e) = ensure_baseline_commit(&base, Baseline::Seeded) {
            warn!(target: "acervo", err = %e, "baseline commit skipped");
        }
    }
    let display_name = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| {
            base.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("Acervo")
                .to_string()
        });
    let color = color.unwrap_or_default();
    let mut cfg = read_loro_config();
    // reuse an existing acervo pointing at this dir, else create a new one
    let id = if let (AcervoSlot::Existing(_), Some(a)) =
        (&slot, cfg.acervos.iter_mut().find(|a| a.dir == dir))
    {
        a.name = display_name;
        a.auto_context = auto;
        a.lang = lang;
        a.template = template;
        a.agent = agent;
        if !color.is_empty() {
            a.color = color;
        }
        a.id.clone()
    } else {
        let mut id = slugify_id(&display_name);
        while cfg.acervos.iter().any(|a| a.id == id) {
            id.push('-');
        }
        cfg.acervos.push(Acervo {
            id: id.clone(),
            name: display_name,
            dir: dir.clone(),
            auto_context: auto,
            color,
            lang,
            template,
            agent,
            ticket_base: String::new(),
        });
        id
    };
    cfg.active = id;
    write_loro_config(&cfg)?;
    Ok(acervos_view())
}

#[tauri::command]
fn brain_list_acervos() -> AcervosView {
    acervos_view()
}

// ADR-0005: post-creation toggle (Configurações) for the active acervo's
// autoContext — updates the global config (so the "auto" pill stays accurate)
// AND the local .loro/settings.json marker the /loro-context skill reads.
#[tauri::command]
fn brain_set_auto_context(value: bool) -> Result<(), String> {
    let mut cfg = read_loro_config();
    let dir = active_acervo(&cfg)
        .map(|a| a.dir.clone())
        .ok_or("acervo not configured")?;
    if let Some(a) = cfg.acervos.iter_mut().find(|a| a.dir == dir) {
        a.auto_context = value;
    }
    write_loro_config(&cfg)?;
    write_acervo_settings(&PathBuf::from(&dir), value)
}

// Redesign 1g ("IA e terminal"): the AI agent command was only settable at
// creation (brain_setup). Settings now edits it for the active acervo —
// normalized so a blank value falls back to the default instead of breaking
// the embedded terminal.
#[tauri::command]
fn brain_set_agent(agent: String) -> Result<(), String> {
    let mut cfg = read_loro_config();
    let dir = active_acervo(&cfg)
        .map(|a| a.dir.clone())
        .ok_or("acervo not configured")?;
    let normalized = normalize_agent(&agent);
    if let Some(a) = cfg.acervos.iter_mut().find(|a| a.dir == dir) {
        a.agent = normalized;
    }
    write_loro_config(&cfg)
}

// ADR-0026 §2: where this project's external locators live. Normalized on the
// way in, so a value that is not http(s) is stored as empty and the reader keeps
// the id as a plain locator instead of linking somewhere nobody asked for.
#[tauri::command]
fn brain_set_ticket_base(base: String) -> Result<(), String> {
    let mut cfg = read_loro_config();
    let dir = active_acervo(&cfg)
        .map(|a| a.dir.clone())
        .ok_or("acervo not configured")?;
    let normalized = normalize_ticket_base(&base);
    if let Some(a) = cfg.acervos.iter_mut().find(|a| a.dir == dir) {
        a.ticket_base = normalized;
    }
    write_loro_config(&cfg)
}

// ---- ADR-0003: acervo usage templates (presets) -----------------------------
#[tauri::command]
fn brain_list_templates(lang: Option<String>) -> Vec<TemplateInfo> {
    let lang = lang.map(|l| normalize_lang(&l)).unwrap_or_else(ui_lang);
    list_templates(&lang)
}

// Copy a template into ~/.loro/templates as an editable custom template;
// returns the created directory path.
#[tauri::command]
fn brain_duplicate_template(id: String) -> Result<String, String> {
    let dir = duplicate_template(&id)?;
    info!(template = %id, "template duplicated"); // id only, never content (BR-8)
    Ok(dir.display().to_string())
}

// set the accent color of a project (persisted in the acervo config)
#[tauri::command]
fn brain_set_color(id: String, color: String) -> Result<AcervosView, String> {
    let mut cfg = read_loro_config();
    let a = cfg
        .acervos
        .iter_mut()
        .find(|a| a.id == id)
        .ok_or("err.acervo_not_found")?;
    a.color = color;
    write_loro_config(&cfg)?;
    Ok(acervos_view())
}

#[tauri::command]
fn brain_set_active(id: String) -> Result<AcervosView, String> {
    let mut cfg = read_loro_config();
    if !cfg.acervos.iter().any(|a| a.id == id) {
        return Err("err.acervo_not_found".into());
    }
    cfg.active = id;
    write_loro_config(&cfg)?;
    Ok(acervos_view())
}

// Remove an acervo from the config only — the folder on disk is preserved.
#[tauri::command]
fn brain_remove_acervo(id: String) -> Result<AcervosView, String> {
    let mut cfg = read_loro_config();
    cfg.acervos.retain(|a| a.id != id);
    if cfg.active == id {
        cfg.active = cfg
            .acervos
            .first()
            .map(|a| a.id.clone())
            .unwrap_or_default();
    }
    write_loro_config(&cfg)?;
    Ok(acervos_view())
}

#[tauri::command]
fn brain_add_context(name: String) -> Result<(), String> {
    let slug = name.trim().to_lowercase().replace(' ', "-");
    if !valid_context(&slug) {
        return Err(format!("err.invalid_context:{slug}"));
    }
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    let lang = ui_lang();
    // Later-added contexts follow the acervo's usage template (ADR-0003); a
    // vanished custom template degrades to the default mold, never an error.
    let full = read_loro_config();
    let mold = active_acervo(&full)
        .and_then(|a| resolve_template(&a.template, &lang).ok())
        .and_then(|t| t.context_md);
    seed_context(Path::new(&cfg.brain_dir), &slug, &lang, mold.as_deref())
}

// Pure, testable core: delete a context/folder dir under contexts/.
fn delete_context_dir(base: &Path, name: &str) -> Result<(), String> {
    if !valid_context(name) {
        return Err("err.invalid_name".into());
    }
    let src = crate::paths::contexts_dir(base).join(name);
    if !src.is_dir() {
        return Err("err.context_not_found".into());
    }
    std::fs::remove_dir_all(&src).map_err(|e| e.to_string())
}

// Delete a context or grouping folder from disk (destructive; the UI guards it
// with an explicit confirmation and git history covers versioned acervos).
#[tauri::command]
fn brain_delete_context(name: String) -> Result<(), String> {
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    delete_context_dir(Path::new(&cfg.brain_dir), &name)
}

// Pure, testable core: rename/move a context dir within contexts/.
fn rename_context_dir(base: &Path, from: &str, to: &str) -> Result<(), String> {
    let to = to.trim().to_lowercase().replace(' ', "-");
    if !valid_context(from) || !valid_context(&to) {
        return Err("err.invalid_context_name".into());
    }
    if from == to {
        return Ok(());
    }
    let root = crate::paths::contexts_dir(base);
    let src = root.join(from);
    if !src.is_dir() {
        return Err("err.context_not_found".into());
    }
    let dest = root.join(&to);
    if dest.exists() {
        return Err("err.context_exists".into());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&src, &dest).map_err(|e| e.to_string())
}

// Rename/move a context within the tree (e.g. `frota` -> `operacoes/frota`).
#[tauri::command]
fn brain_rename_context(from: String, to: String) -> Result<(), String> {
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    rename_context_dir(Path::new(&cfg.brain_dir), &from, &to)
}

// Move a whole context folder to ANOTHER project (acervo).
#[tauri::command]
fn brain_move_context_to_acervo(name: String, target_id: String) -> Result<(), String> {
    if !valid_context(&name) {
        return Err("err.invalid_name".into());
    }
    let cfg = read_loro_config();
    let active = active_acervo(&cfg)
        .ok_or("err.acervo_not_configured")?
        .dir
        .clone();
    let target = cfg
        .acervos
        .iter()
        .find(|a| a.id == target_id)
        .ok_or("err.target_acervo_not_found")?
        .dir
        .clone();
    if target == active {
        return Err("err.already_in_acervo".into());
    }
    let src = crate::paths::contexts_dir(Path::new(&active)).join(&name);
    if !src.is_dir() {
        return Err("err.context_not_found".into());
    }
    let leaf = name.rsplit('/').next().unwrap_or(&name);
    let dest = crate::paths::contexts_dir(Path::new(&target)).join(leaf);
    if dest.exists() {
        return Err("err.context_exists_in_target".into());
    }
    std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::rename(&src, &dest).map_err(|e| e.to_string())
}

// Where the user configures loopback capture (ADR-0012): the Audio MIDI Setup on
// macOS (where a Multi-Output Device is created by hand), the Sound panel's
// Recording tab on Windows (where "Mixagem estéreo" is enabled).
fn audio_setup_cmd() -> (&'static str, Vec<&'static str>) {
    if cfg!(target_os = "windows") {
        ("control.exe", vec!["mmsys.cpl,,1"])
    } else {
        ("open", vec!["-a", "Audio MIDI Setup"])
    }
}

#[tauri::command]
fn open_audio_setup() -> Result<(), String> {
    let (bin, args) = audio_setup_cmd();
    proc::command(bin)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// VB-Cable is not installable from any package manager, so the guided Windows
// flow can only hand the user the official download (ADR-0012).
#[tauri::command]
fn open_vbcable_download() -> Result<(), String> {
    const URL: &str = "https://vb-audio.com/Cable/";
    let (bin, args) = if cfg!(target_os = "windows") {
        ("cmd", vec!["/C", "start", "", URL])
    } else {
        ("open", vec![URL])
    };
    proc::command(bin)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// Guided Windows setup: whisper.cpp has no prebuilt whisper-stream (live mode
// needs SDL2), so the engine is built from source. The script is bundled in the
// binary and materialized into the Loro data dir on demand; the setup button
// runs it in the embedded terminal. See scripts/setup-whisper-windows.ps1.
#[cfg(target_os = "windows")]
const WIN_SETUP_SCRIPT: &str = include_str!("../scripts/setup-whisper-windows.ps1");

#[tauri::command]
fn whisper_setup_script() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let dir = loro_data_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join("setup-whisper-windows.ps1");
        // Written BOM-first: Windows PowerShell 5.1 falls back to CP1252 for a
        // BOM-less .ps1, and the script's accented pt-BR text then decodes into
        // smart quotes that unbalance the parser. The BOM pins it to UTF-8.
        let mut bytes = Vec::from("\u{feff}");
        bytes.extend_from_slice(WIN_SETUP_SCRIPT.trim_start_matches('\u{feff}').as_bytes());
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        Ok(path.display().to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("err.windows_only".into())
    }
}

// ---- git/GitHub environment doctor + collaboration commands ----------------
// Thin Tauri wrappers over git.rs. Opt-in: `versioning_enabled` gates the remote
// flow (Versionar/Propor). Nothing here stores credentials — the doctor is a
// validator/proxy that only reports readiness and public metadata.

// minimum tool versions we treat as "up to date" without hitting the network
// (privacy-first): a conservative floor that only flags genuinely old builds.
const GIT_FLOOR: (u32, u32) = (2, 20);
const GH_FLOOR: (u32, u32) = (2, 0);

#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct Check {
    ok: bool,
    detail: String,
    hint: String,
    fixable: bool,
}

#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct EnvDoctor {
    git: Check,
    gh: Check,
    gh_auth: Check,
    git_identity: Check,
    remote: Check,
    versioning_enabled: bool,
    // N6 — the team flow is off because the network is down, NOT because
    // something is missing from this machine. Without this the screen printed
    // "falta conectar o GitHub" at a fully connected setup.
    offline: bool,
    account: Option<String>,
    protocol: Option<String>,
}

// Validate the git/gh environment. Never asks for or stores secrets: reads only
// booleans, versions and the public login.
//
// ASSÍNCRONO de propósito: o corpo dispara `git --version`, `gh --version` e
// `gh auth status` — e este último vai à REDE. Um comando síncrono do Tauri roda
// na thread principal, então a janela inteira congelava enquanto o gh respondia
// (era isso que fazia a ida e volta para Configurações parecer lenta). O trabalho
// bloqueante vai para o pool; a thread da interface segue pintando.
#[tauri::command]
async fn env_doctor() -> EnvDoctor {
    tauri::async_runtime::spawn_blocking(env_doctor_blocking)
        .await
        .unwrap_or_default()
}

fn env_doctor_blocking() -> EnvDoctor {
    let base = read_brain_config().map(|c| PathBuf::from(c.brain_dir));

    let gv = git_version();
    let git_ok = gv.map(|v| version_meets(v, GIT_FLOOR)).unwrap_or(false);
    let git = Check {
        ok: git_ok,
        detail: version_str(gv),
        hint: if gv.is_none() {
            "instale o git".into()
        } else if !git_ok {
            "atualize o git".into()
        } else {
            String::new()
        },
        fixable: false,
    };

    let ghv = gh_version();
    let gh_ok = ghv.map(|v| version_meets(v, GH_FLOOR)).unwrap_or(false);
    let gh = Check {
        ok: gh_ok,
        detail: version_str(ghv),
        hint: if ghv.is_none() {
            "instale o GitHub CLI (gh)".into()
        } else if !gh_ok {
            "atualize o gh".into()
        } else {
            String::new()
        },
        fixable: false,
    };

    let authed = gh_ok && gh_authed();
    let account = if authed { gh_account() } else { None };
    let protocol = if authed { gh_protocol() } else { None };
    let gh_auth = Check {
        ok: authed,
        detail: account.clone().unwrap_or_default(),
        hint: if !authed {
            "autentique no GitHub: gh auth login".into()
        } else {
            String::new()
        },
        fixable: false,
    };

    let (name, email) = base
        .as_ref()
        .map(|b| git_identity(b))
        .unwrap_or((None, None));
    let id_ok = name.is_some() && email.is_some();
    let git_identity = Check {
        ok: id_ok,
        detail: name.unwrap_or_default(),
        hint: if !id_ok {
            "defina seu nome e e-mail do git".into()
        } else {
            String::new()
        },
        fixable: true,
    };

    let remote_url = base.as_ref().and_then(|b| git_remote_url(b));
    // N6 · a bool collapsed "no repository connected" with "no network right
    // now", so five minutes offline made this row report missing configuration
    // for an environment that is fully configured. Access is only ASKED when a
    // remote exists and the user is authenticated — otherwise there is nothing
    // to reach and no network call to make.
    let access = match (&remote_url, authed) {
        (Some(_), true) => base
            .as_ref()
            .map(|b| gh_repo_accessible(b))
            .unwrap_or(RemoteAccess::Denied),
        _ => RemoteAccess::Denied,
    };
    let offline = access == RemoteAccess::Offline;
    let remote = Check {
        ok: remote_url.is_some() && access == RemoteAccess::Ok,
        detail: remote_url.clone().unwrap_or_default(),
        hint: if remote_url.is_none() {
            "err.git_remote_required".into()
        } else if offline {
            "err.github_unreachable".into()
        } else if access != RemoteAccess::Ok {
            "err.check_repo_access".into()
        } else {
            String::new()
        },
        fixable: false,
    };

    let versioning_enabled = git.ok && gh.ok && gh_auth.ok && remote.ok;
    info!(
        target: "env_doctor",
        git = git.ok, gh = gh.ok, authed = gh_auth.ok,
        identity = git_identity.ok, remote = remote.ok, offline, versioning_enabled,
        "env checks"
    );
    EnvDoctor {
        git,
        gh,
        gh_auth,
        git_identity,
        remote,
        versioning_enabled,
        offline,
        account,
        protocol,
    }
}

// The one safe fix the wizard can apply without a terminal: set the git identity
// (scoped to the acervo repo). No secret involved.
#[tauri::command]
fn env_set_identity(name: String, email: String) -> Result<(), String> {
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    set_identity(&PathBuf::from(&cfg.brain_dir), &name, &email)
}

#[tauri::command]
fn gh_pr_list() -> Result<Vec<PrInfo>, String> {
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    pr_list(&PathBuf::from(&cfg.brain_dir))
}

#[tauri::command]
fn gh_pr_status(number: u64) -> Result<PrInfo, String> {
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    pr_status(&PathBuf::from(&cfg.brain_dir), number)
}

// Abstracted history for the timeline UI: a simple list of versions. `rel` scopes
// it to one knowledge file (e.g. "contexts/frota/context.md"); None = the acervo.
#[tauri::command]
fn brain_timeline(rel: Option<String>) -> Vec<Commit> {
    let Some(cfg) = read_brain_config() else {
        return Vec::new();
    };
    let base = PathBuf::from(&cfg.brain_dir);
    if !base.join(".git").is_dir() {
        return Vec::new();
    }
    git_log(&base, rel.as_deref(), 50)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Notifications {
    connected: bool,
    awaiting_approval: Vec<PrInfo>,
    review_requested_to_me: Vec<PrInfo>,
    changes_pending: Vec<PrInfo>,
    directed_to_me: Vec<PrInfo>,
    recently_approved: Vec<PrInfo>,
}

fn empty_notifications(connected: bool) -> Notifications {
    Notifications {
        connected,
        awaiting_approval: vec![],
        review_requested_to_me: vec![],
        changes_pending: vec![],
        directed_to_me: vec![],
        recently_approved: vec![],
    }
}

// Collaboration inbox derived from open PRs (the RFCs). Without a connected
// GitHub account everything stays local and this reports `connected: false`.
#[tauri::command]
fn brain_notifications() -> Notifications {
    let Some(cfg) = read_brain_config() else {
        return empty_notifications(false);
    };
    let base = PathBuf::from(&cfg.brain_dir);
    if !gh_available() || !gh_authed() || !base.join(".git").is_dir() {
        return empty_notifications(false);
    }
    let me = gh_account();
    let prs = match pr_list(&base) {
        Ok(p) => p,
        Err(_) => return empty_notifications(true),
    };
    let decision = |p: &PrInfo| p.review_decision.clone().unwrap_or_default();
    let requested_to_me = |p: &PrInfo| {
        me.as_deref()
            .map(|m| p.review_requests.iter().any(|r| r.handle() == Some(m)))
            .unwrap_or(false)
    };
    let mine = |p: &PrInfo| me.as_deref() == Some(p.author.login.as_str());
    Notifications {
        connected: true,
        awaiting_approval: prs
            .iter()
            .filter(|p| decision(p) != "APPROVED")
            .cloned()
            .collect(),
        review_requested_to_me: prs.iter().filter(|p| requested_to_me(p)).cloned().collect(),
        changes_pending: prs
            .iter()
            .filter(|p| decision(p) == "CHANGES_REQUESTED")
            .cloned()
            .collect(),
        directed_to_me: prs
            .iter()
            .filter(|p| mine(p) || requested_to_me(p))
            .cloned()
            .collect(),
        recently_approved: prs
            .iter()
            .filter(|p| decision(p) == "APPROVED")
            .cloned()
            .collect(),
    }
}

// ---- write flow: Versionar (local) then Propor mudança (remote PR/RFC) -----

// N3 — `result` used to be a pt-BR sentence the app never read, so a commit that
// never happened was announced as "versão salva". `saved` is the fact the screen
// decides its copy from.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionOutcome {
    branch: String,
    saved: bool,
    warn: Option<String>,
}

// "Versionar": sync the default branch (best effort), create rfc/<slug> off it
// and commit the working changes there. Local git only on the write path.
#[tauri::command]
fn brain_version(slug: String, message: String) -> Result<VersionOutcome, String> {
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    let base = PathBuf::from(&cfg.brain_dir);
    let slug = sanitize_slug(&slug)?;
    let attempt = save_version(&base, &slug, message)?;
    Ok(VersionOutcome {
        branch: attempt.branch,
        saved: attempt.saved,
        warn: attempt.warn,
    })
}

// ---- branch-first IPC (ADR-0002 §2): list / switch / create ----------------

// N2 — the picker used to receive branch NAMES only, so it called one of them
// "(principal)" without knowing whether that branch held any of the project.
// On a project that started versioning after setup it holds nothing, and the
// switch emptied the screen with no warning. Each row now carries what the
// branch keeps (`docs`) and what leaves the screen on the way there
// (`leaving`), which is the price the copy has to state (DESIGN.md §1).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BranchStand {
    name: String,
    docs: usize,
    leaving: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BranchesInfo {
    current: Option<String>,
    default: String,
    branches: Vec<BranchStand>,
    dirty: bool,
}

fn acervo_repo_base() -> Result<PathBuf, String> {
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    let base = PathBuf::from(&cfg.brain_dir);
    if !base.join(".git").is_dir() {
        return Err("err.git_repo_required".into());
    }
    Ok(base)
}

#[tauri::command]
fn git_branches() -> Result<BranchesInfo, String> {
    let base = acervo_repo_base()?;
    let current = current_branch(&base);
    let branches = list_branches(&base)?
        .into_iter()
        .map(|name| BranchStand {
            docs: documents_on(&base, &name),
            leaving: match current.as_deref() {
                Some(cur) if cur != name => documents_leaving(&base, cur, &name),
                _ => 0,
            },
            name,
        })
        .collect();
    Ok(BranchesInfo {
        current,
        default: local_default_branch(&base),
        branches,
        dirty: is_dirty(&base),
    })
}

#[tauri::command]
fn git_switch_branch(branch: String) -> Result<String, String> {
    let base = acervo_repo_base()?;
    switch_branch(&base, &branch)?;
    Ok(current_branch(&base).unwrap_or(branch))
}

// Create (or resume) rfc/<slug>. Sync degrades: whatever the outcome, the
// branch is created off the freshest local default available.
#[tauri::command]
fn git_create_branch(slug: String) -> Result<String, String> {
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    let base = PathBuf::from(&cfg.brain_dir);
    let slug = sanitize_slug(&slug)?;
    let _ = sync_default_branch(&base);
    create_branch(&base, &slug)
}

// "Propor mudança": push the current rfc/ branch and open the PR (the RFC).
// Opt-in gate: requires gh + auth + a remote. Never runs from the default branch.
#[tauri::command]
fn brain_propose_change(title: String, body: String) -> Result<PrRef, String> {
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    let base = PathBuf::from(&cfg.brain_dir);
    if !gh_available() {
        return Err("err.gh_not_found".into());
    }
    if !gh_authed() {
        return Err("err.gh_auth_required".into());
    }
    if git_remote_url(&base).is_none() {
        return Err("err.git_remote_required".into());
    }
    let branch = current_branch(&base).ok_or("err.nothing_to_propose")?;
    if branch == default_branch(&base) {
        return Err("err.on_main_branch".into());
    }
    push_branch(&base, &branch)?;
    let title = if title.trim().is_empty() {
        format!("RFC: {branch}")
    } else {
        title
    };
    let body = if body.trim().is_empty() {
        title.clone()
    } else {
        body
    };
    pr_create(&base, &branch, &title, &body)
}

// ---- migration to the single-context.md model (non-destructive, idempotent) -

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationReport {
    dry_run: bool,
    renamed: Vec<String>,      // contexts where guia.md -> context.md
    conflicts: Vec<String>,    // both files exist — left untouched
    legacy_ideas: Vec<String>, // "<context>: N idea files" — fold into hotspots by hand
    scaffolding: Vec<String>,  // created/rewritten collaboration files
    // ADR-0013: legacy top-level incubadora/ folds into the non-versioned
    // brainstorming/ world. "<from> -> <to>" per planned move; never deletes.
    incubated: Vec<String>,
    // ADR-0013: pessoal/ -> brainstorming/ world rename. "<from> -> <to>" per move;
    // a "conflito:" entry when both worlds coexist (nothing moved).
    #[serde(default)]
    renamed_world: Vec<String>,
}

// Rename preserving git history when possible; falls back to a plain move.
fn migrate_rename(base: &Path, rel_from: &str, rel_to: &str) -> Result<(), String> {
    if base.join(".git").is_dir() && git_available() {
        let out = proc::command("git")
            .args(["mv", rel_from, rel_to])
            .current_dir(base)
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(());
        }
    }
    std::fs::rename(base.join(rel_from), base.join(rel_to)).map_err(|e| e.to_string())
}

// Migrate an existing acervo to the new model: guia.md -> context.md (history
// preserved), collaboration scaffolding, and AGENTS/skill refreshed if still in
// the old Loro-generated format. Nothing is ever deleted. `apply=false` (default)
// only reports what would change.
#[tauri::command]
fn brain_migrate(apply: Option<bool>) -> Result<MigrationReport, String> {
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    migrate_acervo(
        &PathBuf::from(&cfg.brain_dir),
        apply.unwrap_or(false),
        &ui_lang(),
    )
}

fn migrate_acervo(base: &Path, apply: bool, lang: &str) -> Result<MigrationReport, String> {
    // ADR-0026 §14 — the folders are renamed FIRST: everything below reads the
    // acervo by its current (English) names, so a legacy tree has to become one
    // before the rest of the migration looks at it.
    let mut folder_moves = Vec::new();
    rename_acervo_folders(base, apply, &mut folder_moves)?;
    let ctxs = list_contexts(base);
    let mut report = MigrationReport {
        dry_run: !apply,
        renamed: vec![],
        conflicts: vec![],
        legacy_ideas: vec![],
        scaffolding: vec![],
        incubated: vec![],
        renamed_world: vec![],
    };

    report.renamed_world.extend(folder_moves);

    // ADR-0013: rename the legacy non-versioned world before folding incubadora, so
    // both land in the new brainstorming/ tree.
    rename_personal_world(base, apply, &mut report.renamed_world)?;

    for c in &ctxs {
        let cdir = crate::paths::contexts_dir(base).join(c);
        let guia = cdir.join("guia.md");
        let ctx = cdir.join("context.md");
        if guia.is_file() && ctx.is_file() {
            report.conflicts.push(c.clone());
        } else if guia.is_file() {
            report.renamed.push(c.clone());
            if apply {
                migrate_rename(
                    base,
                    &format!("contexts/{c}/guia.md"),
                    &format!("contexts/{c}/context.md"),
                )?;
            }
        }
        for legacy in ["brainstorming", "incubadora", "ideas"] {
            let n = count_md(&cdir.join(legacy));
            if n > 0 {
                report.legacy_ideas.push(format!("{c}/{legacy}: {n}"));
            }
        }
    }

    // Collaboration scaffolding (created only if absent — never overwrites).
    std::fs::create_dir_all(base.join(".github")).map_err(|e| e.to_string())?;
    let codeowners = base.join(".github/CODEOWNERS");
    if !codeowners.exists() {
        report.scaffolding.push(".github/CODEOWNERS".into());
        if apply {
            std::fs::write(&codeowners, codeowners_template(&ctxs, lang))
                .map_err(|e| e.to_string())?;
        }
    }
    let pr_tmpl = base.join(".github/pull_request_template.md");
    if !pr_tmpl.exists() {
        report
            .scaffolding
            .push(".github/pull_request_template.md".into());
        if apply {
            std::fs::write(&pr_tmpl, pr_template(lang)).map_err(|e| e.to_string())?;
        }
    }

    // Refresh AGENTS.md only when still in the old Loro format AND generated by
    // Loro — respect user edits. R3 (ADR-0013): the old-format signal must NOT key
    // on the word "brainstorming" (the NEW AGENTS text legitimately contains it, as
    // the brainstorming→fila→contexto flow); key on the genuinely-old markers
    // `guia.md` and the bare `commands/brain.md` skill reference instead.
    {
        let rel = "AGENTS.md";
        let p = base.join(rel);
        if let Ok(txt) = std::fs::read_to_string(&p) {
            let loro_gen = txt.contains("gerado pelo Loro") || txt.contains("generated by Loro");
            let old_model = txt.contains("guia.md") || txt.contains("commands/brain.md");
            if loro_gen && old_model {
                report.scaffolding.push(rel.into());
                if apply {
                    std::fs::write(&p, agents_template(&ctxs, lang)).map_err(|e| e.to_string())?;
                }
            }
        }
    }

    // A legacy `.claude/commands/brain.md` (the old loop skill) is left on disk for
    // back-compat and only reported — the new loop skill is `loro-context.md`
    // (created below). Never delete the user's file.
    if base.join(".claude/commands/brain.md").is_file() {
        report
            .scaffolding
            .push(".claude/commands/brain.md (legado)".into());
    }

    // ADR-0013/0012: the loop skill (loro-context) and the meeting-AI skills
    // (analyse/answer) are created only if absent so existing acervos gain them on
    // migration; never overwrites edits.
    for (rel, body) in [
        (
            ".claude/commands/loro-context.md",
            brain_skill(lang).to_string(),
        ),
        (
            ".claude/commands/loro-analyse.md",
            meeting_analyse_skill(lang).to_string(),
        ),
        (
            ".claude/commands/loro-question.md",
            meeting_question_skill(lang).to_string(),
        ),
        (
            ".claude/commands/loro-ask.md",
            brain_ask_skill(lang).to_string(),
        ),
        (
            ".claude/commands/loro-note.md",
            loro_note_skill(lang).to_string(),
        ),
        (
            ".claude/commands/loro-sync.md",
            loro_sync_skill(lang).to_string(),
        ),
        (
            ".claude/commands/loro-tool.md",
            loro_tool_skill(lang).to_string(),
        ),
        (
            ".claude/commands/loro-presentation.md",
            loro_presentation_skill(lang).to_string(),
        ),
        (
            ".claude/commands/loro-artifact.md",
            loro_artifact_skill(lang).to_string(),
        ),
        (
            ".claude/commands/loro-slack.md",
            loro_slack_skill(lang).to_string(),
        ),
        (
            ".claude/commands/loro-digest.md",
            loro_digest_skill(lang).to_string(),
        ),
    ] {
        let p = base.join(rel);
        if !p.exists() {
            report.scaffolding.push(rel.into());
            if apply {
                if let Some(parent) = p.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::write(&p, body).map_err(|e| e.to_string())?;
            }
        }
    }

    // ADR-0013: fold a legacy top-level incubadora/ into the non-versioned
    // brainstorming/ world. Non-destructive — files are COPIED (the original stays
    // on disk; a later commit simply untracks brainstorming/); notes/ is left
    // versioned and untouched. Reports every planned move; never deletes.
    fold_incubadora(base, apply, &mut report.incubated)?;

    if apply {
        ensure_gitignore(base)?;
    }
    Ok(report)
}

// ADR-0026 §14 — the acervo's folders, in English. Same posture as the pessoal/
// rename that came before it: rename (atomic, same volume), never clobber a
// destination that exists, and idempotent so a second pass is a no-op. `anexos`
// is nested inside each context, so it is renamed by walking the tree after the
// root folders moved.
const FOLDER_RENAMES: [(&str, &str); 3] = [
    ("contextos", "contexts"),
    ("reunioes", "meetings"),
    ("notas", "notes"),
];
const NESTED_RENAMES: [(&str, &str); 3] = [
    ("reunioes", "meetings"),
    ("notas", "notes"),
    ("anexos", "attachments"),
];

fn rename_acervo_folders(base: &Path, apply: bool, out: &mut Vec<String>) -> Result<(), String> {
    for (legacy, current) in FOLDER_RENAMES {
        let from = base.join(legacy);
        let to = base.join(current);
        if !from.is_dir() {
            continue;
        }
        if to.exists() {
            out.push(format!(
                "conflito: {legacy}/ e {current}/ coexistem — nada movido"
            ));
            continue;
        }
        out.push(format!("{legacy}/ -> {current}/"));
        if apply {
            std::fs::rename(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    // The FILES too, or an acervo migrates half-way: English folders holding
    // Portuguese documents is a tree nobody can reason about. Same posture as the
    // folders — never clobber a destination that already exists.
    let file_renames = [
        ("reuniao.md", crate::meeting::LIVING_FILE),
        ("indice.md", crate::acervo::TOPIC_DOC),
        ("auditoria.jsonl", "audit.jsonl"),
        ("marcadores.jsonl", "markers.jsonl"),
    ];
    // Só o mundo do brainstorming e a raiz: um `indice.md` que a PESSOA escreveu
    // dentro de contexts/ (ou um arquivo esperando em inbox/) não é artefato
    // gerado, e renomeá-lo quebraria o link que aponta para ele — numa migração
    // cuja postura declarada é não destruir nada.
    let mut pending = vec![base.join("brainstorming"), base.join("pessoal")];
    while let Some(dir) = pending.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            let path = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            let Some((_, current)) = file_renames.iter().find(|(legacy, _)| *legacy == name) else {
                continue;
            };
            let to = path.with_file_name(current);
            if to.exists() {
                out.push(format!("conflito: {} ja existe", to.display()));
                continue;
            }
            out.push(format!("{name} -> {current}"));
            if apply {
                std::fs::rename(&path, &to).map_err(|e| e.to_string())?;
            }
        }
    }

    // These folders also live NESTED — a meeting has its own notes/ and
    // attachments/, a context has attachments/, a topic has all three. Renaming
    // only the root ones left half the tree in Portuguese. Deepest first, so a
    // parent never moves out from under a child still queued.
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut pending = vec![base.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten().filter(|e| e.path().is_dir()) {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            dirs.push(e.path());
            pending.push(e.path());
        }
    }
    dirs.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
    for path in dirs {
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let Some((_, current)) = NESTED_RENAMES.iter().find(|(legacy, _)| *legacy == name) else {
            continue;
        };
        if !path.is_dir() {
            continue; // the parent already moved: this path is stale
        }
        let to = path.with_file_name(current);
        if to.exists() {
            out.push(format!("conflito: {} ja existe", to.display()));
            continue;
        }
        out.push(format!("{name}/ -> {current}/"));
        if apply {
            std::fs::rename(&path, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ADR-0013: rename the legacy non-versioned world pessoal/ -> brainstorming/.
// pessoal/temas/<slug> -> brainstorming/<slug> (and tema.md -> index.md, ADR-0026 §14);
// pessoal/avulso and any other pessoal/<x> -> brainstorming/<x>. If brainstorming/
// already exists, report a conflict and DO NOT clobber. Prefer rename (atomic,
// same volume); on failure copy the tree and KEEP the original (non-destructive).
fn rename_personal_world(base: &Path, apply: bool, out: &mut Vec<String>) -> Result<(), String> {
    let legacy = base.join("pessoal");
    let target = base.join("brainstorming");
    if !legacy.is_dir() {
        return Ok(());
    }
    if target.exists() {
        out.push("conflito: pessoal/ e brainstorming/ coexistem — nada movido".into());
        return Ok(());
    }
    // plan the moves: each theme, then avulso/any other top-level pessoal/ entry
    let mut moves: Vec<(String, String)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(legacy.join("temas")) {
        for e in rd.flatten().filter(|e| e.path().is_dir()) {
            let slug = e.file_name().to_string_lossy().to_string();
            moves.push((
                format!("pessoal/temas/{slug}"),
                format!("brainstorming/{slug}"),
            ));
        }
    }
    if let Ok(rd) = std::fs::read_dir(&legacy) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n == "temas" || n.starts_with('.') {
                continue;
            }
            moves.push((format!("pessoal/{n}"), format!("brainstorming/{n}")));
        }
    }
    for (from, to) in &moves {
        out.push(format!("{from} -> {to}"));
    }
    if apply {
        std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        for (from, to) in &moves {
            let fp = base.join(from);
            let tp = base.join(to);
            if tp.exists() {
                continue;
            }
            if let Some(parent) = tp.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            if std::fs::rename(&fp, &tp).is_err() {
                copy_tree(&fp, &tp)?; // cross-device fallback; original kept
            }
        }
        // tema.md -> the topic document inside each migrated brainstorming
        if let Ok(rd) = std::fs::read_dir(&target) {
            for e in rd.flatten().filter(|e| e.path().is_dir()) {
                let old = e.path().join("tema.md");
                let new = crate::acervo::topic_doc_of(&e.path());
                if old.is_file() && !new.exists() {
                    let _ = std::fs::rename(&old, &new);
                }
            }
        }
        // drop the now-empty legacy dirs (only if empty — never data loss)
        let _ = std::fs::remove_dir(legacy.join("temas"));
        let _ = std::fs::remove_dir(&legacy);
    }
    Ok(())
}

// Recursively copy a file or directory tree (non-destructive fallback for a
// cross-device rename). Hidden entries are copied too (they belong to the world).
fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    if from.is_file() {
        if let Some(p) = to.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        std::fs::copy(from, to).map_err(|e| e.to_string())?;
        return Ok(());
    }
    for e in std::fs::read_dir(from)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let child = e.path();
        let dest = to.join(e.file_name());
        if child.is_dir() {
            copy_tree(&child, &dest)?;
        } else if child.is_file() {
            if let Some(p) = dest.parent() {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            std::fs::copy(&child, &dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// Plan/apply the incubadora -> brainstorming/ fold. Each legacy file maps to
// brainstorming/incubadora/<same-subpath>. Existing destinations are never
// overwritten (idempotent, non-destructive).
fn fold_incubadora(base: &Path, apply: bool, out: &mut Vec<String>) -> Result<(), String> {
    let src_root = base.join("incubadora");
    if !src_root.is_dir() {
        return Ok(());
    }
    let dest_root = base.join("brainstorming/incubadora");
    let mut files: Vec<PathBuf> = Vec::new();
    collect_files(&src_root, &mut files);
    files.sort();
    for f in files {
        let Ok(sub) = f.strip_prefix(&src_root) else {
            continue;
        };
        let sub = sub.to_string_lossy().replace('\\', "/");
        let dest = dest_root.join(&sub);
        if dest.exists() {
            continue; // already folded — nothing to do
        }
        out.push(format!(
            "incubadora/{sub} -> brainstorming/incubadora/{sub}"
        ));
        if apply {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(&f, &dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// Recursively collect regular files under `dir` (hidden entries skipped).
fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        if e.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            collect_files(&p, out);
        } else if p.is_file() {
            out.push(p);
        }
    }
}

// Move a queued file from the active acervo to another acervo's inbox,
// optionally routing it to a context via the `<context>--` prefix.
#[tauri::command]
fn brain_move_to_acervo(
    name: String,
    target_id: String,
    context: Option<String>,
) -> Result<(), String> {
    if !valid_inbox_name(&name) {
        return Err("err.invalid_name".into());
    }
    let cfg = read_loro_config();
    let active = active_acervo(&cfg)
        .ok_or("err.acervo_not_configured")?
        .dir
        .clone();
    let target = cfg
        .acervos
        .iter()
        .find(|a| a.id == target_id)
        .ok_or("err.target_acervo_not_found")?
        .dir
        .clone();
    let ctx = context
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());
    move_queue_item(
        Path::new(&active),
        Path::new(&target),
        &name,
        ctx.as_deref(),
    )
}

// The cross-acervo move itself, base-taking so the contract is unit-testable
// without a running Tauri app (clean-core premise, CLAUDE.md §5).
fn move_queue_item(
    active: &Path,
    target: &Path,
    name: &str,
    ctx: Option<&str>,
) -> Result<(), String> {
    if target == active && ctx.is_none() {
        return Err("err.choose_destination".into());
    }
    let src = active.join("inbox").join(name);
    if !src.is_file() {
        return Err("err.not_in_queue".into());
    }
    let tdir = target.join("inbox");
    std::fs::create_dir_all(&tdir).map_err(|e| e.to_string())?;
    let fname = match ctx {
        Some(c) if valid_context(c) => format!("{}--{}", c.replace('/', "-"), name),
        Some(_) => return Err("err.invalid_context".into()),
        None => name.to_string(),
    };
    let dest = tdir.join(&fname);
    // Non-destructive, like `brain_move` inside one acervo: an item waiting in the
    // destination's fila is not versioned anywhere, so replacing it would destroy
    // the only copy of a capture — and the user asked to move one file, not to
    // trade one for another.
    if dest.exists() {
        return Err("err.file_exists_in_target".into());
    }
    std::fs::rename(&src, &dest).map_err(|e| e.to_string())
}

// Move any acervo file into a context's `referencias/` (or to `notes/` when no
// context is given) — lets the user remanage documents/notes across contexts.
#[tauri::command]
fn brain_move(rel: String, dest_context: String) -> Result<String, String> {
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    let base = PathBuf::from(&cfg.brain_dir)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let src = base
        .join(&rel)
        .canonicalize()
        .map_err(|_| "err.not_found".to_string())?;
    if !src.starts_with(&base) || !src.is_file() {
        return Err("err.invalid_origin".into());
    }
    let fname = src
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("err.invalid_name")?
        .to_string();
    let dc = dest_context.trim();
    let destdir = if dc.is_empty() {
        base.join("notes")
    } else {
        if !valid_context(dc) {
            return Err("err.invalid_context".into());
        }
        crate::paths::contexts_dir(&base)
            .join(dc)
            .join("referencias")
    };
    std::fs::create_dir_all(&destdir).map_err(|e| e.to_string())?;
    let target = destdir.join(&fname);
    if target == src {
        return Ok(rel);
    }
    if target.exists() {
        return Err("err.file_exists_in_target".into());
    }
    std::fs::rename(&src, &target).map_err(|e| e.to_string())?;
    Ok(target
        .strip_prefix(&base)
        .map(|p| p.display().to_string())
        .unwrap_or(rel))
}

// deletes a NOT-YET-PROCESSED inbox file (so it is never processed)
#[tauri::command]
fn brain_delete_inbox(name: String) -> Result<(), String> {
    // non-text queue items are deletable (the fila accepts pdf/docs), hence the
    // narrower check here; the guide is not an item, and it is cleared by writing
    // it empty (`brain_write_guide`), never by the queue's delete.
    if name.contains('/')
        || name.contains("..")
        || name.starts_with('.')
        || name.is_empty()
        || is_queue_guide(&name)
    {
        return Err("err.invalid_name".into());
    }
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    let p = PathBuf::from(&cfg.brain_dir).join("inbox").join(&name);
    if !p.is_file() {
        return Err("err.not_in_queue".into());
    }
    std::fs::remove_file(&p).map_err(|e| e.to_string())
}

fn count_md(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    !n.starts_with('.') && (n.ends_with(".md") || n.ends_with(".txt"))
                })
                .count()
        })
        .unwrap_or(0)
}

// safe name for a queue ITEM: no path separators / traversal, text only, and never
// the loop guide — the guide shares the folder but not the nature (`is_queue_guide`),
// so the item commands (write / delete / move / send) must all refuse it.
fn valid_inbox_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.contains('/')
        && !name.contains("..")
        && (name.ends_with(".md") || name.ends_with(".txt"))
        && !is_queue_guide(name)
}

// Phase 2.3 — edit an unprocessed inbox file (text only). Creates it if new.
#[tauri::command]
fn brain_write_inbox(name: String, content: String) -> Result<(), String> {
    if !valid_inbox_name(&name) {
        return Err("err.invalid_report_name".into());
    }
    let cfg = read_brain_config().ok_or("acervo not configured")?;
    let dir = PathBuf::from(&cfg.brain_dir).join("inbox");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(&name), content).map_err(|e| e.to_string())
}

// ADR-0014: the fila (inbox/) is THE path brainstorming -> contexto. Each selected
// brainstorming file is copied into the queue AS ITSELF — one queue item per file,
// no consolidated report (supersedes ADR-0013). The /loro-context loop then distils
// each entry into a versioned context. The raw meeting transcript, audit and audio
// NEVER enter the queue (BR-8; `crate::acervo::is_queueable`).

// Validate + resolve ONE brainstorming file into (abs source, queue name): scope
// (brainstorming/ only), path-guard (canonicalize under base), text-only + the BR-8
// transcript/audio/audit guard, and a collision-free flattened queue name (steered
// to a context via the `<contexto>--<nome>` prefix the /loro-context loop reads).
fn resolve_queue_entry(
    base: &Path,
    rel: &str,
    ctx: Option<&str>,
) -> Result<(PathBuf, String), String> {
    let r = rel.replace('\\', "/");
    if r.contains("..") {
        return Err("err.invalid_path".into());
    }
    if !r.starts_with("brainstorming/") {
        return Err("err.queue_brainstorming_only".into());
    }
    if !crate::acervo::is_queueable(&r) {
        return Err("err.transcript_not_queueable".into());
    }
    let src = base
        .join(&r)
        .canonicalize()
        .map_err(|_| "err.report_not_found".to_string())?;
    if !src.starts_with(base) || !src.is_file() {
        return Err("err.report_outside_acervo".into());
    }
    let name = import_name(ctx, &crate::acervo::queue_name_for(&r));
    // `valid_inbox_name` also refuses the loop guide, so a brainstorming file that
    // flattens to `_prompt.md` cannot rewrite the instructions the loop obeys.
    if !valid_inbox_name(&name) {
        return Err("err.invalid_queue_name".into());
    }
    Ok((src, name))
}

// Send N selected brainstorming files to the fila, one queue item each. Validates
// ALL entries before writing ANY (a bad rel fails the batch, no partial queue).
#[tauri::command]
fn brain_send_files_to_queue(
    rels: Vec<String>,
    dest_context: Option<String>,
) -> Result<Vec<String>, String> {
    if rels.is_empty() {
        return Err("err.queue_empty_selection".into());
    }
    if let Some(c) = dest_context.as_deref() {
        if !c.is_empty() && !valid_context(c) {
            return Err(format!("err.invalid_context:{c}"));
        }
    }
    let ctx = dest_context
        .as_deref()
        .filter(|c| !c.is_empty())
        .map(|c| c.replace('/', "-"));
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    let base = PathBuf::from(&cfg.brain_dir)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    queue_files_into(&base, &rels, ctx.as_deref())
}

// The send itself, base-taking so the batch contract is unit-testable without a
// running Tauri app (clean-core premise, CLAUDE.md §5). `base` must be canonical.
//
// ALL-OR-NOTHING: every entry is resolved, read AND triaged before the first byte
// is written. The fila is a one-way door — the acervo is versioned (ADR-0024) — so
// of the three possible outcomes (all, none, some) the partial write is the worst:
// it puts files in the queue while the caller is told the send failed, and the
// truth of the screen depends on the order of the selection. On success the return
// value names exactly what was written.
fn queue_files_into(
    base: &Path,
    rels: &[String],
    ctx: Option<&str>,
) -> Result<Vec<String>, String> {
    // ADR-0018: a selected MEETING is a directory, and what represents it in the
    // fila is decided by its one owner (`acervo::meeting_queueables`) — never by
    // a second walk here (hotspot #46). A meeting nobody analysed expands to
    // nothing and says so instead of queueing an empty item.
    let mut expanded = Vec::with_capacity(rels.len());
    for rel in rels {
        if base.join(rel.replace('\\', "/")).is_dir() {
            let files = crate::acervo::meeting_queueables(base, rel);
            if files.is_empty() {
                return Err("err.meeting_not_analysed".into());
            }
            expanded.extend(files);
        } else {
            expanded.push(rel.clone());
        }
    }
    let mut staged = Vec::with_capacity(expanded.len());
    for rel in &expanded {
        let (src, name) = resolve_queue_entry(base, rel, ctx)?;
        let content = std::fs::read_to_string(&src).map_err(|e| e.to_string())?;
        // Triagem de entrada (ADR-0024). O bloqueio é revalidado AQUI e não só na
        // tela: o acervo é versionado, então uma credencial que passa vira commit
        // — e um portão que confia no frontend ter perguntado não é portão.
        // BR-8: o erro nomeia o ARQUIVO e a regra, jamais o que foi encontrado.
        if intake::blocked(&intake::scan(&content)) {
            return Err(format!("err.intake_secret:{name}"));
        }
        // The triaged bytes are the bytes written: re-reading at write time would
        // reopen the window in which a file changes after passing the door.
        staged.push((name, content));
    }
    let inbox = base.join("inbox");
    std::fs::create_dir_all(&inbox).map_err(|e| e.to_string())?;
    let mut names = Vec::with_capacity(staged.len());
    for (name, content) in &staged {
        // Past the door everything has been validated, so the only failure left is
        // the filesystem itself — it names the item it broke on instead of surfacing
        // a bare OS error the caller cannot place.
        std::fs::write(inbox.join(name), content).map_err(|e| format!("{name}: {e}"))?;
        names.push(name.clone());
    }
    Ok(names)
}

// Triagem: o que estes arquivos carregam, ANTES de entrarem. Só leitura — nada é
// escrito, nada é movido. A tela chama isto primeiro, mostra os achados e deixa o
// usuário decidir; o bloqueio de credencial não é decisão dele nem dela (ADR-0024).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileTriage {
    rel: String,
    findings: Vec<intake::Finding>,
}

#[tauri::command]
fn brain_triage_files(rels: Vec<String>) -> Result<Vec<FileTriage>, String> {
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    let base = PathBuf::from(&cfg.brain_dir)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let mut expanded = Vec::with_capacity(rels.len());
    for rel in &rels {
        if base.join(rel.replace('\\', "/")).is_dir() {
            expanded.extend(crate::acervo::meeting_queueables(&base, rel));
        } else {
            expanded.push(rel.clone());
        }
    }
    let mut out = Vec::with_capacity(expanded.len());
    for rel in expanded {
        let Ok(src) = crate::acervo::guarded_existing(&base, &rel) else {
            continue;
        };
        let Ok(content) = std::fs::read_to_string(&src) else {
            continue; // binário ou ilegível: a triagem é de texto
        };
        let findings = intake::scan(&content);
        if !findings.is_empty() {
            out.push(FileTriage { rel, findings });
        }
    }
    Ok(out)
}

// "enviar tudo → fila": every queueable file of the brainstorming, each its own item.
#[tauri::command]
fn brain_send_brainstorm_to_queue(
    slug: String,
    dest_context: Option<String>,
) -> Result<Vec<String>, String> {
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    let base = PathBuf::from(&cfg.brain_dir)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let rels = crate::acervo::queueable_files(&base, &slug);
    if rels.is_empty() {
        return Err("err.queue_empty_selection".into());
    }
    brain_send_files_to_queue(rels, dest_context)
}

#[derive(serde::Serialize)]
struct TreeEntry {
    name: String,
    path: String,
    dir: bool,
}

// Edit any text file inside the acervo (view/edit mode in the reader).
// Path-traversal guarded; the file must already exist.
#[tauri::command]
fn brain_write(rel: String, content: String) -> Result<(), String> {
    if !(rel.ends_with(".md") || rel.ends_with(".txt")) {
        return Err("err.text_files_only".into());
    }
    // ADR-0009 write guard: meeting transcript/audit/audio never enters contexts/.
    if is_versioning_denied(&rel) {
        return Err("err.meeting_into_versioned".into());
    }
    let cfg = read_brain_config().ok_or("acervo not configured")?;
    let base = PathBuf::from(&cfg.brain_dir)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let p = base
        .join(&rel)
        .canonicalize()
        .map_err(|_| "not found".to_string())?;
    if !p.starts_with(&base) {
        return Err("err.outside_acervo".into());
    }
    std::fs::write(&p, content).map_err(|e| e.to_string())
}

// Phase 2.4 — list one directory level inside the acervo (for a file tree).
#[tauri::command]
fn brain_list_dir(rel: String) -> Result<Vec<TreeEntry>, String> {
    let cfg = read_brain_config().ok_or("acervo not configured")?;
    let base = PathBuf::from(&cfg.brain_dir)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let target = base
        .join(&rel)
        .canonicalize()
        .map_err(|_| "not found".to_string())?;
    if !target.starts_with(&base) {
        return Err("err.outside_acervo".into());
    }
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&target) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            // N12 · the annotation sidecar is the machine's file, written beside
            // the document the user grifou. Listed as content it became a fake
            // document in every tree — and, under .claude/commands, a fake
            // habilidade whose "excluir" could never work.
            if name.starts_with('.') || name.ends_with(crate::acervo::SIDECAR_SUFFIX) {
                continue;
            }
            let dir = e.path().is_dir();
            let rel_path = if rel.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", rel.trim_end_matches('/'), name)
            };
            out.push(TreeEntry {
                name,
                path: rel_path,
                dir,
            });
        }
    }
    // directories first, then files, alphabetical
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then(a.name.cmp(&b.name)));
    Ok(out)
}

// ADR-0008 — flat quick-open index for the command palette.
#[derive(serde::Serialize)]
struct FileHit {
    rel: String,
    title: String,
    kind: String,
}

// Text-ish docs plus small images: what belongs in the palette (never large
// binaries). Extensions compared lowercase.
const QUICKOPEN_EXTS: &[&str] = &[
    "md", "txt", "json", "png", "jpg", "jpeg", "gif", "svg", "webp",
];
const QUICKOPEN_MAX_BYTES: u64 = 512 * 1024;

fn quickopen_kind(rel: &str) -> &'static str {
    if rel.starts_with("contexts/") {
        "context"
    } else if rel.starts_with("brainstorming/") || rel.starts_with("pessoal/") {
        // ADR-0013: the non-versioned world is `brainstorming/`; legacy `pessoal/`
        // still maps to the same "personal" kind for un-migrated acervos.
        "personal"
    } else {
        "other"
    }
}

// Recursive walk producing every text-ish file by full rel path. Unlike the
// ADR-0005 display tree this does NOT skip subdomain dirs — the palette indexes
// everything. Pure over `base` so it is testable without a running app.
fn list_all_in(base: &Path) -> Vec<FileHit> {
    let mut out = Vec::new();
    walk_quickopen(base, base, &mut out);
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    out
}

fn walk_quickopen(base: &Path, dir: &Path, out: &mut Vec<FileHit>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        // hidden entries (.git, .brain, dotfiles) and node_modules never index
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        // symlinks are not followed — a link out of the acervo can't leak in
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let path = e.path();
        if ft.is_dir() {
            walk_quickopen(base, &path, out);
            continue;
        }
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase());
        if !ext.is_some_and(|x| QUICKOPEN_EXTS.contains(&x.as_str())) {
            continue;
        }
        if e.metadata().is_ok_and(|m| m.len() > QUICKOPEN_MAX_BYTES) {
            continue;
        }
        // rel is always relative to base (strip_prefix): path-traversal safe
        let Ok(rel_path) = path.strip_prefix(base) else {
            continue;
        };
        let rel = rel_path.to_string_lossy().replace('\\', "/");
        let kind = quickopen_kind(&rel).to_string();
        out.push(FileHit {
            rel,
            title: name,
            kind,
        });
    }
}

#[tauri::command]
fn brain_list_all() -> Result<Vec<FileHit>, String> {
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    // same canonicalize + starts_with(base) guard the other brain_* commands use
    let base = PathBuf::from(&cfg.brain_dir)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    Ok(list_all_in(&base))
}

// Phase 2.2 — optional guide prompt the loop runs BEFORE standard processing.
// Stored at inbox/_prompt.md (only affects pending items).
//
// The guide LIVES in the fila but it is NOT a queue item: `brain_setup` seeds it
// from the acervo's usage template (ADR-0003) and the /loro-context loop reads,
// archives and removes it. Everything that ENUMERATES the fila must skip it —
// otherwise a brand-new acervo reports one capture ready to organize and its one
// primary action sends the app's own scaffolding into the versioned acervo, which
// is a one-way door (ADR-0024). `brain_read_guide`/`brain_write_guide` and the
// seeding in `ensure_acervo_structure` are its only legitimate consumers.
const QUEUE_GUIDE_NAME: &str = "_prompt.md";

// True for the fila's guide, given a queue file name or an acervo-relative path.
fn is_queue_guide(name_or_rel: &str) -> bool {
    let r = name_or_rel.replace('\\', "/");
    r.rsplit('/').next().unwrap_or(r.as_str()) == QUEUE_GUIDE_NAME
}

#[tauri::command]
fn brain_read_guide() -> String {
    read_brain_config()
        .and_then(|cfg| {
            std::fs::read_to_string(
                PathBuf::from(cfg.brain_dir)
                    .join("inbox")
                    .join(QUEUE_GUIDE_NAME),
            )
            .ok()
        })
        .unwrap_or_default()
}

#[tauri::command]
fn brain_write_guide(content: String) -> Result<(), String> {
    let cfg = read_brain_config().ok_or("acervo not configured")?;
    let dir = PathBuf::from(&cfg.brain_dir).join("inbox");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join(QUEUE_GUIDE_NAME);
    if content.trim().is_empty() {
        let _ = std::fs::remove_file(&p);
        return Ok(());
    }
    std::fs::write(&p, content).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct BrainFile {
    name: String,
    path: String,
    mtime: u64,
}
#[derive(serde::Serialize)]
struct BrainCtx {
    name: String,
    entries: usize,
    ideas: usize, // legacy idea files still on disk (brainstorming/incubadora)
    seeded: bool, // has a context.md (or legacy guia.md); false for a hand-made empty folder
}
#[derive(serde::Serialize)]
struct BrainStatus {
    configured: bool,
    dir: String,
    contexts: Vec<BrainCtx>,
    inbox: Vec<BrainFile>,
    processed: usize,
    meetings: Vec<BrainFile>,
    notes: Vec<BrainFile>,
    incubadora: Vec<BrainFile>,
    // ADR-0026 — the acervo's entry documents (INDEX.md, TERMS.md). They live at
    // the root, so the contexts tree never listed them: the file the protocol
    // tells everyone to read first was reachable only by typing its name into ⌘K.
    //
    // The JSON key is spelled out because `BrainStatus` has no `rename_all`: every
    // other field is a single word, so nobody noticed — and this one shipped as
    // `entry_docs` while the reader asked for `entryDocs`, which is a row that
    // never drew and a feature that never existed. A test pins both sides.
    #[serde(rename = "entryDocs")]
    entry_docs: Vec<BrainFile>,
    // ADR-0026 §20: a estrutura é a antiga e a leitura seria ambígua — a tela
    // para e oferece a migração em vez de mostrar meio acervo
    #[serde(rename = "legacyLayout")]
    legacy_layout: bool,
    activity: String,
}

fn list_files(base: &Path, sub: &str) -> Vec<BrainFile> {
    list_files_filtered(base, sub, true)
}

// The same listing, given the resolved directory instead of a name — so a caller
// that had to pick between two spellings (ADR-0026 §14) picks once, from disk.
fn list_files_at(dir: &Path) -> Vec<BrainFile> {
    let (Some(base), Some(sub)) = (dir.parent(), dir.file_name().and_then(|n| n.to_str())) else {
        return Vec::new();
    };
    list_files_filtered(base, sub, true)
}

// only_text=false lists any non-hidden file (the inbox accepts pdf/docs etc.)
fn list_files_filtered(base: &Path, sub: &str, only_text: bool) -> Vec<BrainFile> {
    let dir = base.join(sub);
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            if only_text && !(name.ends_with(".md") || name.ends_with(".txt")) {
                continue;
            }
            if !e.path().is_file() {
                continue;
            }
            let mtime = e
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(BrainFile {
                name: name.clone(),
                path: format!("{sub}/{name}"),
                mtime,
            });
        }
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.mtime));
    out
}

// The fila as the app must see it: everything dropped in inbox/ EXCEPT the loop
// guide (`is_queue_guide`). Single owner of "what is in the queue", so the listing,
// the badge count and the CTA that acts on the queue can never disagree.
fn list_queue(base: &Path) -> Vec<BrainFile> {
    list_files_filtered(base, "inbox", false)
        .into_iter()
        .filter(|f| !is_queue_guide(&f.name))
        .collect()
}

#[tauri::command]
fn brain_status() -> BrainStatus {
    let Some(cfg) = read_brain_config() else {
        return BrainStatus {
            configured: false,
            dir: String::new(),
            contexts: vec![],
            inbox: vec![],
            processed: 0,
            meetings: vec![],
            notes: vec![],
            incubadora: vec![],
            entry_docs: vec![],
            legacy_layout: false,
            activity: String::new(),
        };
    };
    let base = PathBuf::from(&cfg.brain_dir);
    let contexts = list_contexts(&base)
        .iter()
        .map(|c| {
            let cdir = crate::paths::contexts_dir(&base).join(c);
            let entries = std::fs::read_to_string(cdir.join("CHANGELOG.md"))
                .map(|t| t.lines().filter(|l| l.starts_with("## ")).count())
                .unwrap_or(0);
            // legacy idea files (pre-migration acervos): ideas are now hotspots
            // inside context.md, so new contexts have none.
            let ideas = count_md(&cdir.join("brainstorming")) + count_md(&cdir.join("incubadora"));
            BrainCtx {
                name: c.clone(),
                entries,
                ideas,
                seeded: context_file(&cdir).is_some(),
            }
        })
        .collect();
    // incubadora: one .md per initiative (subfolders)
    let mut incub = Vec::new();
    if let Ok(rd) = std::fs::read_dir(base.join("incubadora")) {
        for e in rd.flatten() {
            if e.path().is_dir() {
                let name = e.file_name().to_string_lossy().to_string();
                for f in list_files(&base, &format!("incubadora/{name}")) {
                    incub.push(BrainFile {
                        name: name.clone(),
                        path: f.path,
                        mtime: f.mtime,
                    });
                }
            }
        }
    }
    let activity = std::fs::read_to_string(base.join(".brain/activity.log"))
        .map(|t| {
            t.trim()
                .lines()
                .rev()
                .take(30)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    // ADR-0026 §18 — o índice remissivo se mantém sozinho. FORA da thread
    // principal: `brain_status` é um comando síncrono, e no Tauri v2 isso roda na
    // main thread — varrer todos os contextos ali a cada poll é exatamente a
    // classe de bug do ADR-0022 §28, que já custou três aparições. O trabalho é
    // solto; a próxima leitura vê o resultado.
    {
        let base = base.clone();
        let lang = crate::config::active_acervo_lang();
        std::thread::spawn(move || crate::acervo::refresh_terms_if_changed(&base, &lang));
    }

    BrainStatus {
        configured: true,
        dir: cfg.brain_dir.clone(),
        contexts,
        inbox: list_queue(&base),
        processed: list_files_filtered(&base, "processed", false).len(),
        // ADR-0026 §14 — o nome vem do disco: um acervo não migrado ainda tem
        // `reunioes/` e `notas/`, e ler só o nome novo mostrava tudo vazio
        meetings: list_files_at(&crate::paths::acervo_dir(&base, "meetings", "reunioes")),
        notes: list_files_at(&crate::paths::acervo_dir(&base, "notes", "notas")),
        incubadora: incub,
        entry_docs: entry_docs(&base),
        legacy_layout: crate::paths::is_legacy_layout(&base),
        activity,
    }
}

// Only files the acervo's own protocol names as a starting point, and only when
// they exist on disk — a row for a document that is not there is a control that
// does nothing (DESIGN.md §1).
const ENTRY_DOC_NAMES: [&str; 2] = ["INDEX.md", crate::acervo::TERMS_FILE];

fn entry_docs(base: &Path) -> Vec<BrainFile> {
    ENTRY_DOC_NAMES
        .iter()
        .filter_map(|name| {
            let p = base.join(name);
            p.is_file().then(|| BrainFile {
                name: (*name).to_string(),
                path: (*name).to_string(),
                mtime: p
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            })
        })
        .collect()
}

// imported filename: the "<contexto>--" prefix steers the loop
fn import_name(context: Option<&str>, filename: &str) -> String {
    match context {
        Some(c) if !c.is_empty() => format!("{c}--{filename}"),
        _ => filename.to_string(),
    }
}

// The fila's door for files that come from OUTSIDE the acervo. Single owner, so
// the native picker (`brain_import`) and the external drag-and-drop
// (`brain_import_paths`) carry the same guarantees — a guard on one door only is
// no guard, and the drop path was the one that had none.
//
// Base-taking so the contract is unit-testable without a running Tauri app
// (clean-core premise, CLAUDE.md §5). Directories are skipped, so the returned
// count is what actually entered the fila and the caller can report it as fact.
fn import_into_inbox(
    inbox: &Path,
    srcs: &[PathBuf],
    context: Option<&str>,
) -> Result<usize, String> {
    let mut planned: Vec<(&PathBuf, String)> = Vec::with_capacity(srcs.len());
    for src in srcs {
        if !src.is_file() {
            continue;
        }
        let Some(name) = src.file_name().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        let name = import_name(context, &name);
        // The guide lives in inbox/ but it is NOT a queue item (`is_queue_guide`):
        // it is the instruction file the /loro-context loop obeys, and `list_queue`
        // hides it. An import that landed on it destroyed it with no undo AND was
        // counted as an item the fila never shows. Refused for the WHOLE batch,
        // before the first copy: the fila is a one-way door (ADR-0024), so the
        // count the caller reports is exactly what entered.
        if is_queue_guide(&name) {
            return Err(format!("err.invalid_queue_name:{name}"));
        }
        planned.push((src, name));
    }
    if planned.is_empty() {
        return Ok(0);
    }
    std::fs::create_dir_all(inbox).map_err(|e| e.to_string())?;
    let mut n = 0;
    for (src, name) in planned {
        // These bytes come from OUTSIDE the acervo, so a name collision is a
        // different file with the same name — and the item already in the fila may
        // have been edited there. Never overwritten, exactly as the sibling door
        // `brain_import_files` treats attachments/.
        let dest = crate::acervo::next_free_name(inbox, &name);
        std::fs::copy(src, &dest).map_err(|e| format!("{name}: {e}"))?;
        n += 1;
    }
    Ok(n)
}

// imports files into the acervo inbox (native picker, multi-select),
// optionally steered to a context
#[tauri::command]
async fn brain_import(app: AppHandle, context: Option<String>) -> Result<usize, String> {
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    if let Some(c) = context.as_deref() {
        if !c.is_empty() && !valid_context(c) {
            return Err(format!("err.invalid_context:{c}"));
        }
    }
    let dialog = app.dialog().clone();
    let files = tauri::async_runtime::spawn_blocking(move || dialog.file().blocking_pick_files())
        .await
        .map_err(|e| e.to_string())?;
    let Some(files) = files else { return Ok(0) };
    let inbox = PathBuf::from(&cfg.brain_dir).join("inbox");
    let srcs: Vec<PathBuf> = files.iter().map(|f| PathBuf::from(f.to_string())).collect();
    import_into_inbox(&inbox, &srcs, context.as_deref())
}

// ADR-0005: import files from the computer straight into an attachments/ folder —
// a brainstorming's OR a context's (owner request: "no contexto ... consiga
// add a partir do computador"). Mirrors brain_import, but the destination is
// an attachments/ folder (not the inbox), filenames are kept as-is (anexos are
// arbitrary files — pdf/xlsx/images), and collisions get a numeric suffix
// instead of clobbering. dest_rel is guarded by guarded_anexos_dir (only a
// normalized brainstorming/contexts anexos path is accepted).
#[tauri::command]
async fn brain_import_files(app: AppHandle, dest_rel: String) -> Result<usize, String> {
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    let base = PathBuf::from(&cfg.brain_dir);
    let dir = guarded_anexos_dir(&base, &dest_rel)?;
    let dialog = app.dialog().clone();
    let files = tauri::async_runtime::spawn_blocking(move || dialog.file().blocking_pick_files())
        .await
        .map_err(|e| e.to_string())?;
    let Some(files) = files else { return Ok(0) };
    let mut n = 0;
    for f in files {
        let src = PathBuf::from(f.to_string());
        let Some(name) = src.file_name().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        // never overwrite: on collision, insert a numeric suffix before the ext
        let dest = crate::acervo::next_free_name(&dir, &name);
        std::fs::copy(&src, &dest).map_err(|e| format!("{name}: {e}"))?;
        n += 1;
    }
    Ok(n)
}

// Import explicit file paths into the active acervo's inbox (used by external
// drag-and-drop of one or more files onto the queue).
#[tauri::command]
fn brain_import_paths(paths: Vec<String>, context: Option<String>) -> Result<usize, String> {
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    if let Some(c) = context.as_deref() {
        if !c.is_empty() && !valid_context(c) {
            return Err(format!("err.invalid_context:{c}"));
        }
    }
    let inbox = PathBuf::from(&cfg.brain_dir).join("inbox");
    let srcs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    import_into_inbox(&inbox, &srcs, context.as_deref())
}

// reads a file INSIDE the acervo (path-traversal protection)
#[tauri::command]
fn brain_read(rel: String) -> Result<String, String> {
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    let base = PathBuf::from(&cfg.brain_dir)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let p = base
        .join(&rel)
        .canonicalize()
        .map_err(|_| "err.not_found".to_string())?;
    if !p.starts_with(&base) {
        return Err("err.outside_acervo".into());
    }
    std::fs::read_to_string(&p).map_err(|e| e.to_string())
}

// silent auto-save (no dialog) into the configured folder
#[tauri::command]
fn auto_save(content: String, dir: String, filename: String) -> Result<String, String> {
    if !is_safe_filename(&filename) {
        return Err("err.invalid_file_name".into());
    }
    // The default destination IS the fila (`default_save_dir`), and the fila's guide
    // is not a save target: a transcript written there would replace the
    // instructions the /loro-context loop obeys. The check belongs at the door, not
    // in the caller — the frontend is not the only caller of the future (ADR-0024).
    if is_queue_guide(&filename) && Path::new(&dir).file_name().is_some_and(|d| d == "inbox") {
        return Err(format!("err.invalid_queue_name:{filename}"));
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = Path::new(&dir).join(filename);
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

// stores the recorded audio (e.g. MediaRecorder .webm) for later diarization
#[tauri::command]
fn save_recording(data: Vec<u8>, filename: String) -> Result<String, String> {
    let dir = recordings_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(filename);
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

// runs the loro.sh diarize (WhisperX) handoff and returns the speaker Markdown
#[tauri::command]
async fn diarize(audio_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let script = project_dir().join("loro.sh");
        let output = proc::command("bash")
            .arg(&script)
            .arg("diarize")
            .arg(&audio_path)
            .current_dir(project_dir())
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
        let base = Path::new(&audio_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("output");
        let md = project_dir()
            .join("transcripts")
            .join(format!("{base}.diarized.md"));
        std::fs::read_to_string(&md).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn toggle_overlay(app: AppHandle, show: bool) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("overlay") {
        if show {
            w.show().map_err(|e| e.to_string())?;
            let _ = w.set_always_on_top(true);
        } else {
            w.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// headless self-test: active only when LORO_SELFTEST is in the environment
#[tauri::command]
fn selftest_enabled() -> bool {
    std::env::var("LORO_SELFTEST").is_ok()
}

// Frontend diagnostic log routed to ~/.loro/logs. ADR-0011 redaction boundary:
// this is a DEV-DIAGNOSTIC channel and MUST NOT become a transcript/PII sink
// (BR-8). It is hard-capped and tagged so a stray frontend string can never dump
// meeting content into the shared logs; the AI/meeting modules never route
// content here (a source lint in ai.rs enforces that where it matters). The full
// event-code migration of client_log is a follow-up.
const CLIENT_LOG_MAX: usize = 512;
#[tauri::command]
fn client_log(msg: String) {
    let capped: String = msg.chars().take(CLIENT_LOG_MAX).collect();
    info!(target: "ui-diag", "{capped}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// ---- embedded terminal (interactive PTY) — runs the agent CLI in the dock ----
// ADR-0012: guarantee the meeting-AI skills exist in the acervo so
// `/loro-context`, `/loro-analyse` and `/loro-question` are discoverable by the
// terminal Claude even for acervos created before this change — no explicit
// "migrar acervo" needed. Create-if-absent; never overwrites user edits.
// The description and the argument-hint are the lines of a habilidade the UI
// prints (sidebar tooltip, "usar" sheet and the placeholder of its field).
// Seeding is create-if-absent, so a project created by an older Loro would keep
// the old wording forever: rewrite those single lines, and only while they are
// still strings Loro itself shipped — anything the user edited is never touched.
fn refresh_builtin_front_matter(path: &Path, shipped: &str) {
    let Ok(current) = std::fs::read_to_string(path) else {
        return;
    };
    if let Some(next) = refreshed_front_matter(&current, shipped) {
        let _ = std::fs::write(path, next);
    }
}

fn ensure_meeting_skills(base: &Path, lang: &str) {
    if std::fs::create_dir_all(base.join(".claude/commands")).is_err() {
        return;
    }
    for (rel, body) in [
        (".claude/commands/loro-context.md", brain_skill(lang)),
        (
            ".claude/commands/loro-analyse.md",
            meeting_analyse_skill(lang),
        ),
        (
            ".claude/commands/loro-question.md",
            meeting_question_skill(lang),
        ),
        (".claude/commands/loro-ask.md", brain_ask_skill(lang)),
        (".claude/commands/loro-note.md", loro_note_skill(lang)),
        (".claude/commands/loro-sync.md", loro_sync_skill(lang)),
        (".claude/commands/loro-tool.md", loro_tool_skill(lang)),
        (
            ".claude/commands/loro-presentation.md",
            loro_presentation_skill(lang),
        ),
        (
            ".claude/commands/loro-artifact.md",
            loro_artifact_skill(lang),
        ),
        (".claude/commands/loro-slack.md", loro_slack_skill(lang)),
        (".claude/commands/loro-digest.md", loro_digest_skill(lang)),
    ] {
        let p = base.join(rel);
        if !p.exists() {
            let _ = std::fs::write(&p, body);
        } else {
            refresh_builtin_front_matter(&p, body);
        }
    }
}

#[tauri::command]
fn term_open(app: AppHandle, state: State<AppState>, cols: u16, rows: u16) -> Result<(), String> {
    // kill the previous session, if any
    if let Some(mut s) = state.term.lock().unwrap().take() {
        let _ = s.child.kill();
    }
    let sys = portable_pty::native_pty_system();
    let pair = sys
        .openpty(portable_pty::PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    // Cross-platform LOGIN + INTERACTIVE shell so the user's real PATH/profile is
    // loaded (GUI apps get a minimal PATH — otherwise `claude`/`python` are unseen).
    let mut cmd = if cfg!(target_os = "windows") {
        let ps = std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into());
        portable_pty::CommandBuilder::new(ps)
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut c = portable_pty::CommandBuilder::new(&shell);
        c.arg("-l"); // login: sources .zprofile/.bash_profile (the PATH lives there)
        c.arg("-i"); // interactive: sources .zshrc/.bashrc and enables line editing
        c
    };
    cmd.env("TERM", "xterm-256color");
    // O terminal embutido roda o agente do usuário: ele não pode herdar os
    // marcadores de sessão de OUTRO agente (proc::INHERITED_SESSION_MARKERS) —
    // herdados, o agente se acha uma sessão-filha e desliga o próprio histórico.
    for k in proc::INHERITED_SESSION_MARKERS {
        cmd.env_remove(k);
    }
    // ALWAYS open in the active acervo folder (to run the loop / skills right there)
    let mut in_acervo = false;
    if let Some(cfg) = read_brain_config() {
        let d = PathBuf::from(&cfg.brain_dir);
        if d.is_dir() {
            ensure_meeting_skills(&d, &ui_lang()); // discoverable without a manual migrate
            cmd.cwd(d);
            in_acervo = true;
        }
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    // Auto-launch the terminal agent so the /loro-* skills (analisar/perguntar/
    // ask/gerar contexto) work out of the box — the buttons inject slash commands
    // that only a running agent understands. The login shell sources the profile
    // (real PATH) before reading this stdin, so the agent command resolves; if
    // it is not installed the shell just prints "command not found" and stays
    // usable. Uses the ACTIVE acervo's configured agent (ADR-0005) — this used
    // to hardcode "claude", breaking any acervo configured with another CLI.
    let launched_at = std::time::Instant::now();
    if in_acervo {
        let _ = writer.write_all(format!("{}\n", active_agent()).as_bytes());
        let _ = writer.flush();
    }
    let apph = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut dec = Utf8Stream::default();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    let _ = apph.emit("term-exit", ());
                    break;
                }
                Ok(n) => {
                    let s = dec.push(&buf[..n]);
                    if !s.is_empty() {
                        let _ = apph.emit("term-output", s);
                    }
                }
            }
        }
    });
    *state.term.lock().unwrap() = Some(TermSession {
        writer,
        master: pair.master,
        child,
        launched_at,
    });
    info!(target: "term", "terminal opened");
    Ok(())
}

#[tauri::command]
fn term_input(state: State<AppState>, data: String) -> Result<(), String> {
    let mut g = state.term.lock().unwrap();
    if let Some(s) = g.as_mut() {
        s.writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        let _ = s.writer.flush();
    }
    Ok(())
}

#[tauri::command]
fn term_resize(state: State<AppState>, cols: u16, rows: u16) -> Result<(), String> {
    if let Some(s) = state.term.lock().unwrap().as_ref() {
        s.master
            .resize(portable_pty::PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn term_close(state: State<AppState>) {
    if let Some(mut s) = state.term.lock().unwrap().take() {
        let _ = s.child.kill();
    }
}

// ---- ADR-0002 §4: terminal/agent readiness handshake ------------------------
// Slash-commands only mean something to a running agent. The frontend asks
// this instead of guessing from terminal output: is the PTY open, and does the
// active acervo's agent process live under its shell right now? The agent is
// per-acervo (ADR-0003) — any CLI, `claude` by default.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TermStatus {
    open: bool,
    agent_running: bool,
    // ADR-0005: true for a short grace window right after term_open wrote the
    // launch line — `ps`-based detection lags a freshly spawned process by at
    // least one poll, so the frontend must not treat "not detected yet" as
    // "never launched" and retype the agent command into a session that
    // already has it in flight.
    just_launched: bool,
}

const TERM_LAUNCH_GRACE: std::time::Duration = std::time::Duration::from_secs(6);

fn is_within_grace(elapsed: std::time::Duration) -> bool {
    elapsed < TERM_LAUNCH_GRACE
}

// Process name to look for: basename of the agent command's first token
// (e.g. "ollama run llama3" -> "ollama"; "/usr/local/bin/claude" -> "claude").
fn agent_process_name(agent: &str) -> String {
    agent
        .split_whitespace()
        .next()
        .unwrap_or("claude")
        .rsplit('/')
        .next()
        .unwrap_or("claude")
        .to_string()
}

fn active_agent() -> String {
    let cfg = read_loro_config();
    active_acervo(&cfg)
        .map(|a| normalize_agent(&a.agent))
        .unwrap_or_else(default_agent)
}

// Does a process-table entry name the given agent? macOS `ps -axo comm=` may
// print a full path, while Windows reports the bare image name and always keeps
// the `.exe`, so both sides are reduced to a lowercase, extension-free basename.
// Windows process names are case-insensitive, so lowercasing is required there
// and harmless elsewhere (agent binaries are lowercase by convention).
fn process_name_matches(comm: &str, name: &str) -> bool {
    fn base(s: &str) -> String {
        let leaf = s
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(s)
            .to_ascii_lowercase();
        match leaf.strip_suffix(".exe") {
            Some(stem) => stem.to_string(),
            None => leaf,
        }
    }
    base(comm) == base(name)
}

// (pid, ppid, name) for every process on the machine.
//
// Unix reads it from `ps`. Windows has no `ps`, and `wmic` was removed from
// Windows 11, so it walks the ToolHelp snapshot directly — which is also far
// cheaper than a subprocess, and term_status is polled every 300ms while a
// habilidade waits for its agent (ADR-0014).
#[cfg(not(windows))]
fn process_table() -> Vec<(u32, u32, String)> {
    proc::command("ps")
        .args(["-axo", "pid=,ppid=,comm="])
        .output()
        .ok()
        .map(|o| parse_ps_table(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
}

#[cfg(windows)]
fn process_table() -> Vec<(u32, u32, String)> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut table = Vec::new();
    // SAFETY: the snapshot handle is checked before use and closed on every exit
    // path; PROCESSENTRY32W is zeroed with dwSize set, as the API requires.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return table;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                let n = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                table.push((
                    entry.th32ProcessID,
                    entry.th32ParentProcessID,
                    String::from_utf16_lossy(&entry.szExeFile[..n]),
                ));
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    table
}

#[cfg(not(windows))]
fn parse_ps_table(out: &str) -> Vec<(u32, u32, String)> {
    out.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let pid = it.next()?.parse().ok()?;
            let ppid = it.next()?.parse().ok()?;
            let comm = it.next()?.to_string();
            Some((pid, ppid, comm))
        })
        .collect()
}

fn has_descendant_process(table: &[(u32, u32, String)], root: u32, name: &str) -> bool {
    let mut frontier = vec![root];
    let mut seen = std::collections::HashSet::new();
    while let Some(pid) = frontier.pop() {
        if !seen.insert(pid) {
            continue;
        }
        for (cpid, ppid, comm) in table {
            if *ppid == pid {
                if process_name_matches(comm, name) {
                    return true;
                }
                frontier.push(*cpid);
            }
        }
    }
    false
}

#[tauri::command]
fn term_status(state: State<AppState>) -> TermStatus {
    let guard = state.term.lock().unwrap();
    let Some(session) = guard.as_ref() else {
        return TermStatus {
            open: false,
            agent_running: false,
            just_launched: false,
        };
    };
    let Some(root) = session.child.process_id() else {
        return TermStatus {
            open: false,
            agent_running: false,
            just_launched: false,
        };
    };
    let just_launched = is_within_grace(session.launched_at.elapsed());
    let agent_name = agent_process_name(&active_agent());
    let agent_running = has_descendant_process(&process_table(), root, &agent_name);
    TermStatus {
        open: true,
        agent_running,
        just_launched,
    }
}

// The agent command of the active acervo (frontend launches it in the PTY).
#[tauri::command]
fn term_agent() -> String {
    active_agent()
}

pub fn run() {
    init_logging();
    info!(os = std::env::consts::OS, "Loro starting");
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState::default())
        .setup(|app| {
            // --- tray: parrot silhouette (template = adapts to light/dark) ---
            let labels = tray_labels(&ui_lang());
            let show = MenuItem::with_id(app, "show", labels.show, true, None::<&str>)?;
            let toggle = MenuItem::with_id(app, "toggle", labels.toggle, true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", labels.quit, true, Some("Cmd+Q"))?;
            let menu = Menu::with_items(app, &[&show, &toggle, &quit])?;
            app.state::<AppState>()
                .tray_menu
                .lock()
                .unwrap()
                .replace(TrayMenuItems {
                    show: show.clone(),
                    toggle: toggle.clone(),
                    quit: quit.clone(),
                });
            let tray = TrayIconBuilder::with_id(TRAY_ID)
                .icon(Image::from_bytes(TRAY_ON)?)
                .icon_as_template(true)
                .menu(&menu)
                .tooltip("Loro")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "toggle" => {
                        let _ = app.emit("hotkey-toggle", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            app.state::<AppState>().tray.lock().unwrap().replace(tray);

            // --- blink the parrot while recording ---
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut dimmed = false;
                loop {
                    let rec = handle.state::<AppState>().recording.load(Ordering::Relaxed);
                    if let Some(tray) = handle.tray_by_id(TRAY_ID) {
                        if rec {
                            dimmed = !dimmed;
                            let bytes = if dimmed { TRAY_DIM } else { TRAY_ON };
                            if let Ok(img) = Image::from_bytes(bytes) {
                                let _ = tray.set_icon(Some(img));
                                let _ = tray.set_icon_as_template(true);
                            }
                        } else if dimmed {
                            dimmed = false;
                            if let Ok(img) = Image::from_bytes(TRAY_ON) {
                                let _ = tray.set_icon(Some(img));
                                let _ = tray.set_icon_as_template(true);
                            }
                        }
                    }
                    std::thread::sleep(Duration::from_millis(if rec { 550 } else { 300 }));
                }
            });

            // --- global shortcut: Cmd/Ctrl + Alt + Space ---
            let shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::Space);
            app.global_shortcut()
                .on_shortcut(shortcut, |app, _sc, event| {
                    if event.state() == ShortcutState::Pressed {
                        let _ = app.emit("hotkey-toggle", ());
                    }
                })?;

            Ok(())
        })
        // closing the window does NOT quit: hide and keep running in the background
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            start,
            stop,
            transcribe_file,
            start_system_capture,
            stop_system_capture,
            transcribe_meeting,
            save_transcript,
            save_recording,
            diarize,
            toggle_overlay,
            client_log,
            doctor,
            list_models,
            download_model,
            selftest_enabled,
            pick_folder,
            default_save_dir,
            default_acervo_dir,
            auto_save,
            list_capture_devices,
            ui_get_lang,
            app_version,
            ui_set_lang,
            brain_get_config,
            brain_setup,
            brain_list_acervos,
            brain_set_auto_context,
            brain_set_agent,
            brain_set_ticket_base,
            chat::chat_send,
            chat::chat_cancel,
            chat::chat_reset,
            chat::chat_status,
            chat::chat_handoff,
            brain_list_templates,
            brain_duplicate_template,
            brain_set_active,
            brain_set_color,
            brain_remove_acervo,
            brain_add_context,
            brain_rename_context,
            brain_move_context_to_acervo,
            open_audio_setup,
            open_vbcable_download,
            whisper_setup_script,
            brain_delete_context,
            brain_move_to_acervo,
            brain_move,
            brain_import_paths,
            brain_git_state,
            brain_git_files,
            brain_git_commit,
            env_doctor,
            env_set_identity,
            gh_pr_list,
            gh_pr_status,
            brain_timeline,
            brain_notifications,
            brain_version,
            brain_propose_change,
            git_branches,
            git_switch_branch,
            git_create_branch,
            brain_migrate,
            term_open,
            term_input,
            term_resize,
            term_close,
            term_status,
            term_agent,
            brain_import,
            brain_import_files,
            brain_new_note_in,
            brain_delete_inbox,
            brain_write_inbox,
            brain_send_files_to_queue,
            brain_triage_files,
            brain_send_brainstorm_to_queue,
            brain_write,
            brain_list_dir,
            brain_list_all,
            brain_read_guide,
            brain_write_guide,
            brain_status,
            brain_read,
            brain_create_brainstorm,
            brain_rename_brainstorm,
            brain_set_brainstorm_category,
            brain_brainstorm_delete,
            brain_rename_pessoal,
            brain_move_pessoal,
            brain_move_meeting,
            brain_abs_path,
            brain_list_brainstorms,
            brain_list_meetings,
            brain_new_notebook,
            brain_new_tool,
            brain_delete_tool,
            brain_read_asset,
            brain_open_external,
            brain_open_link,
            brain_resolve_ref,
            brain_annotations_get,
            brain_annotation_add,
            brain_annotation_update,
            brain_annotation_delete,
            brain_add_ref,
            brain_knowledge_graph,
            brain_backlinks,
            brain_index_terms,
            brain_index_write,
            brain_pii_scan,
            brain_topic_doc,
            brain_promote,
            brain_meeting_start,
            brain_meeting_stop,
            brain_meeting_pause,
            brain_meeting_resume,
            brain_meeting_append,
            brain_meeting_append_timed,
            brain_meeting_write_artifact,
            brain_meeting_marker,
            brain_meeting_set_origin,
            brain_meeting_set_consent,
            brain_meeting_manifest,
            brain_meeting_rename,
            brain_meeting_finish,
            brain_meeting_delete_audio,
            brain_meeting_purge_audio,
            brain_meeting_transcribe_segment,
            brain_meeting_transcribe_tail,
            brain_meeting_audit,
            ai_doctor
        ])
        .build(tauri::generate_context!())
        .expect("failed to start the Loro app");

    app.run(|app_handle, event| {
        // clicking the Dock icon reopens the window (macOS)
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            if let Some(w) = app_handle.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (app_handle, event);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // "novo projeto" must never take over a folder that already IS a project.
    // Reproduced in the running app: creating a second project while accepting
    // the default folder (always ~/Documents/Loro, so the likeliest path there
    // is) renamed and re-templated the EXISTING acervo in place — the first
    // project vanished from the switcher and the two domains' contexts ended up
    // in one folder. That breaks the product's self-contained & non-destructive
    // premise; setup stays idempotent for the SAME project, which is why the
    // intent has to be explicit.
    #[test]
    fn a_new_project_refuses_a_folder_that_is_already_a_project() {
        let existing = vec![Acervo {
            id: "engenharia".into(),
            name: "Engenharia".into(),
            dir: "/tmp/loro-a".into(),
            auto_context: false,
            color: String::new(),
            lang: "pt".into(),
            template: "engenharia".into(),
            agent: "claude".into(),
            ticket_base: String::new(),
        }];
        // asking for a NEW project on a taken folder is refused, with the name
        // of the project that owns it so the UI can say which one it is
        assert_eq!(
            resolve_acervo_slot(&existing, "/tmp/loro-a", true),
            Err("err.acervo_dir_taken:Engenharia".into())
        );
        // a free folder is a new slot
        assert_eq!(
            resolve_acervo_slot(&existing, "/tmp/loro-b", true),
            Ok(AcervoSlot::New)
        );
        // re-running setup on the SAME project (not "novo projeto") still reuses
        // its entry, so reconfiguring never duplicates it
        assert_eq!(
            resolve_acervo_slot(&existing, "/tmp/loro-a", false),
            Ok(AcervoSlot::Existing("engenharia".into()))
        );
    }

    fn acervo_at(dir: &str) -> Acervo {
        Acervo {
            id: "engenharia".into(),
            name: "Engenharia".into(),
            dir: dir.into(),
            auto_context: false,
            color: String::new(),
            lang: "pt".into(),
            template: "engenharia".into(),
            agent: "claude".into(),
            ticket_base: String::new(),
        }
    }

    // ADR-0022 §30 — the wizard shows the folder that will actually be used when
    // none is picked; it must be the very fallback brain_setup applies. Asserted
    // over the resolver both share, so the check does not depend on which
    // projects the machine running the suite happens to have.
    #[test]
    fn default_acervo_dir_matches_brain_setup_fallback() {
        let base = default_brain_dir();
        assert_eq!(first_free_acervo_dir(&[], &base), base);
        assert!(base.display().to_string().ends_with("Documents/Loro"));
    }

    // N19 — the wizard prefilled a CONSTANT default, so from the second project
    // on it opened already refused: the folder it offered was the one folder
    // resolve_acervo_slot rejects, in red, before the user typed anything.
    #[test]
    fn the_default_folder_of_a_new_project_is_never_one_already_taken() {
        let base = Path::new("/tmp/Documents/Loro");
        let taken = vec![acervo_at("/tmp/Documents/Loro")];
        let free = first_free_acervo_dir(&taken, base);
        assert_eq!(free, Path::new("/tmp/Documents/Loro 2"));
        assert_eq!(
            resolve_acervo_slot(&taken, &free.display().to_string(), true),
            Ok(AcervoSlot::New),
            "the wizard's default has to be a folder a new project can accept"
        );
        // and it keeps walking while the suffixes are taken too
        let mut many = taken.clone();
        many.push(acervo_at("/tmp/Documents/Loro 2"));
        assert_eq!(
            first_free_acervo_dir(&many, base),
            Path::new("/tmp/Documents/Loro 3")
        );
    }

    // N20 — the folder field became typeable, so it can hold a path that is a
    // FILE. brain_setup accepted it and the user got the raw std::io string
    // "Not a directory (os error 20)" on a pt-BR screen.
    #[test]
    fn a_project_folder_that_is_not_a_folder_is_refused_with_a_translated_code() {
        let root = std::env::temp_dir().join(format!("loro-notdir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("config.json");
        std::fs::write(&file, "{}").unwrap();

        assert_eq!(
            acervo_dir_must_be_a_folder(&file),
            Err("err.acervo_dir_is_file".into())
        );
        // a path whose parent is that file cannot be created either, and the
        // failure still has to be a code the UI translates
        assert_eq!(
            ensure_acervo_structure(&file.join("sub"), &["frota".into()], "pt", None),
            Err("err.acervo_dir_unusable".into())
        );
        // a relative path would resolve against whatever the app's cwd is
        assert_eq!(
            acervo_dir_must_be_a_folder(Path::new("Documents/Loro")),
            Err("err.invalid_path".into())
        );
        // an absolute folder that does not exist yet is fine: setup creates it
        assert_eq!(acervo_dir_must_be_a_folder(&root.join("novo")), Ok(()));
        assert_eq!(acervo_dir_must_be_a_folder(&root), Ok(()));
        let _ = std::fs::remove_dir_all(&root);
    }

    // N20 (the other half) — the inspection above cannot know whether the folder
    // ACCEPTS a project: a real, existing directory the user cannot write into
    // passes every check and then fails on the first mkdir. That failure used to
    // travel as "Permission denied (os error 13)" straight into the wizard.
    #[cfg(unix)]
    #[test]
    fn a_project_folder_that_refuses_writes_answers_with_a_translated_code() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("loro-ro-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let ro = root.join("somente-leitura");
        std::fs::create_dir_all(&ro).unwrap();
        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o555)).unwrap();

        let err = ensure_acervo_structure(&ro, &["frota".into()], "pt", None)
            .expect_err("an unwritable folder cannot hold a project");
        assert_eq!(err, "err.acervo_dir_not_writable");
        // and the per-acervo marker written by the same setup answers the same way
        assert_eq!(
            crate::config::write_acervo_settings(&ro, true),
            Err("err.acervo_dir_not_writable".into())
        );

        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    // ADR-0002 §4 — the terminal/Claude readiness handshake asks the OS whether
    // a `claude` process lives under the PTY shell, instead of guessing from
    // terminal output.
    // The tree walk is shared by every platform, so it is tested against a
    // literal table rather than `ps` output.
    #[test]
    fn finds_descendant_by_name_in_the_process_tree() {
        let t = |pid, ppid, name: &str| (pid, ppid, name.to_string());
        let table = vec![
            t(1, 0, "launchd"),
            t(300, 1, "zsh"),
            t(412, 300, "claude"),
            t(500, 412, "node"),
            t(600, 1, "zsh"),
        ];
        assert!(has_descendant_process(&table, 300, "claude"));
        assert!(!has_descendant_process(&table, 600, "claude"));
        // the root itself does not count as its own descendant match
        assert!(!has_descendant_process(&table, 412, "zsh"));
        // grandchildren are found too
        assert!(has_descendant_process(&table, 300, "node"));
    }

    #[test]
    fn windows_process_names_match_despite_the_exe_suffix() {
        // ToolHelp reports "claude.exe"; the configured agent is "claude". Before
        // this, agent detection could never succeed on Windows.
        assert!(process_name_matches("claude.exe", "claude"));
        assert!(process_name_matches("Claude.EXE", "claude")); // case-insensitive
        assert!(process_name_matches("C:\\bin\\claude.exe", "claude")); // backslash path
        assert!(process_name_matches("/usr/local/bin/claude", "claude")); // unix path
        assert!(process_name_matches("claude", "claude"));
        // still discriminating
        assert!(!process_name_matches("node.exe", "claude"));
        assert!(!process_name_matches("claudex.exe", "claude"));
    }

    // The whole point of term_status: an agent running under the PTY is found on
    // this machine's real process table. Uses the test binary itself as the root,
    // since cargo's runner is a live process with a known name.
    #[test]
    fn process_table_reads_this_machine() {
        let table = process_table();
        assert!(table.len() > 5, "tabela vazia: {}", table.len());
        let me = std::process::id();
        assert!(
            table.iter().any(|(pid, _, _)| *pid == me),
            "o proprio processo de teste deve aparecer na tabela"
        );
        // every entry carries a usable name
        assert!(table.iter().all(|(_, _, n)| !n.is_empty()));
    }

    #[cfg(not(windows))]
    #[test]
    fn ps_table_parsing_skips_malformed_lines() {
        let table = parse_ps_table("  1     0  launchd\n 300     1  zsh\n");
        assert_eq!(table.len(), 2);
        assert!(parse_ps_table("garbage\n").is_empty());
    }

    #[test]
    fn tray_labels_follow_ui_lang() {
        let pt = tray_labels("pt");
        assert_eq!(pt.show, "Abrir Loro");
        assert_eq!(pt.toggle, "Iniciar / Parar transcrição");
        assert_eq!(pt.quit, "Sair");
        assert_eq!(pt.tooltip_recording, "Loro — transcrevendo");
        let en = tray_labels("en");
        assert_eq!(en.show, "Open Loro");
        assert_eq!(en.toggle, "Start / Stop transcription");
        assert_eq!(en.quit, "Quit");
        assert_eq!(en.tooltip_recording, "Loro — transcribing");
        // unknown languages fall back to pt
        assert_eq!(tray_labels("fr").show, "Abrir Loro");
    }

    #[test]
    fn extract_text_extracts_transcription() {
        assert_eq!(
            extract_text("[00:00:00.000 --> 00:00:05.000]   Olá mundo"),
            Some("Olá mundo".to_string())
        );
    }

    #[test]
    fn extract_text_keeps_bracketed_annotation() {
        assert_eq!(
            extract_text("[00:00:00.000 --> 00:00:05.000]   [SOM DE FUNDO]"),
            Some("[SOM DE FUNDO]".to_string())
        );
    }

    #[test]
    fn extract_text_ignores_markers_and_empty_lines() {
        assert_eq!(extract_text("### Transcription 0 START | t0 = 77 ms"), None);
        assert_eq!(extract_text("[Start speaking]"), None);
        assert_eq!(extract_text("[00:00:00.000 --> 00:00:05.000]    "), None);
        assert_eq!(extract_text("linha sem timestamp"), None);
    }

    #[test]
    fn stream_args_includes_translation_when_enabled() {
        let a = stream_args("/m.bin", "pt", true, "8", None);
        assert!(a.contains(&"-tr".to_string()));
        assert!(a.windows(2).any(|w| w[0] == "-l" && w[1] == "pt"));
        assert!(a.windows(2).any(|w| w[0] == "-m" && w[1] == "/m.bin"));
    }

    #[test]
    fn stream_args_has_no_translation_by_default() {
        let a = stream_args("/m.bin", "pt", false, "4", None);
        assert!(!a.contains(&"-tr".to_string()));
        assert!(a.windows(2).any(|w| w[0] == "-t" && w[1] == "4"));
    }

    #[test]
    fn stream_args_default_mic_has_no_c_flag() {
        let a = stream_args("/m.bin", "pt", false, "8", None);
        assert!(!a.contains(&"-c".to_string()));
    }

    #[test]
    fn stream_args_system_audio_uses_c() {
        let a = stream_args("/m.bin", "pt", false, "8", Some(2));
        assert!(a.windows(2).any(|w| w[0] == "-c" && w[1] == "2"));
    }

    // Settings surfaces the version so the user can tell an update landed: the
    // command must return the crate version (a non-empty semver-shaped string).
    #[test]
    fn app_version_is_the_crate_semver() {
        let v = app_version();
        assert_eq!(v, env!("CARGO_PKG_VERSION"));
        assert!(!v.is_empty());
        assert_eq!(
            v.split('.').count(),
            3,
            "expected MAJOR.MINOR.PATCH, got {v}"
        );
    }

    #[test]
    fn valid_contexts() {
        assert!(valid_context("frota"));
        assert!(valid_context("produto-a2"));
        assert!(!valid_context("Frota")); // uppercase
        assert!(!valid_context("a b")); // space
        assert!(!valid_context("-x"));
        assert!(!valid_context(""));
        assert!(!valid_context("../etc"));
    }

    #[test]
    fn claude_template_includes_contexts() {
        let t = brain_claude_template(&["alpha".into(), "beta".into()]);
        assert!(t.contains("- `alpha`"));
        assert!(t.contains("- `beta`"));
        assert!(t.contains("context.md")); // official source of truth in markdown
        assert!(t.contains("CHANGELOG.md")); // separate history in md
        assert!(t.contains("CODEOWNERS")); // collaboration per context owner
        assert!(!t.contains("index.html")); // no HTML product
        assert!(t.contains("hotspot")); // ideas become hotspots, not idea files
        assert!(t.contains("/loro-context")); // ADR-0013: renamed skill
    }

    #[test]
    fn context_markdown_replaces_context_placeholder() {
        assert!(CONTEXT_TEMPLATE.contains("{{CONTEXT}}"));
        let g = context_md("frota", "pt", None);
        assert!(g.starts_with("# frota — contexto"));
        assert!(!g.contains("{{CONTEXT}}"));
        assert!(!g.contains("<html")); // pure markdown, no HTML
        assert!(g.contains("Hotspots")); // section 6 is the evolution backlog
                                         // the en language uses the English template
        assert!(context_md("fleet", "en", None).contains("context"));
    }

    #[test]
    fn audio_setup_cmd_opens_the_platform_panel() {
        // ADR-0012: each OS has its own audio panel, and the wrong command only
        // fails at runtime, so the choice is pinned here.
        let (bin, args) = audio_setup_cmd();
        if cfg!(target_os = "windows") {
            assert_eq!(bin, "control.exe");
            // ",,1" selects the Recording tab, where Stereo Mix lives
            assert_eq!(args, vec!["mmsys.cpl,,1"]);
        } else {
            assert_eq!(bin, "open");
            assert_eq!(args, vec!["-a", "Audio MIDI Setup"]);
        }
    }

    #[cfg(windows)]
    #[test]
    fn whisper_setup_script_is_written_as_bom_prefixed_utf8() {
        // Windows PowerShell 5.1 decodes a BOM-less .ps1 as CP1252, where the
        // UTF-8 em dash (E2 80 94) becomes "â€”" — and that trailing U+201D is a
        // smart quote the parser accepts as a string delimiter, which unbalances
        // the quoting and kills the whole script. The BOM forces UTF-8.
        let tmp = std::env::temp_dir().join(format!("loro-setup-{}", std::process::id()));
        std::env::set_var("LORO_HOME", &tmp);
        let path = whisper_setup_script().expect("script deve ser escrito");

        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..3], b"\xEF\xBB\xBF", "script precisa de BOM UTF-8");
        assert_ne!(&bytes[3..6], b"\xEF\xBB\xBF", "BOM duplicado");

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("WHISPER_SDL2")); // build do modo ao vivo
        assert!(content.contains("whisper-stream"));

        std::env::remove_var("LORO_HOME");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn utf8_stream_reassembles_codepoint_split_across_reads() {
        // The parrot emoji is 4 bytes (F0 9F A6 9C). A PTY read that ends after
        // the first two must not surface replacement chars — the completing
        // bytes arrive on the next read and the codepoint is emitted whole.
        let mut d = super::Utf8Stream::default();
        let b = "🦜".as_bytes();
        assert_eq!(d.push(&b[..2]), "");
        assert_eq!(d.push(&b[2..]), "🦜");
    }

    #[test]
    fn utf8_stream_passes_ascii_and_ansi_through() {
        let mut d = super::Utf8Stream::default();
        assert_eq!(d.push(b"\x1b[2Khello"), "\x1b[2Khello");
    }

    #[test]
    fn utf8_stream_handles_three_way_split() {
        // 'a' + emoji(4) + 'b', sliced mid-emoji on both sides.
        let mut d = super::Utf8Stream::default();
        let b = "a🦜b".as_bytes();
        let mut out = String::new();
        out.push_str(&d.push(&b[..3])); // 'a' + first 2 emoji bytes
        out.push_str(&d.push(&b[3..5])); // next 2 emoji bytes -> completes it
        out.push_str(&d.push(&b[5..])); // 'b'
        assert_eq!(out, "a🦜b");
    }

    #[test]
    fn utf8_stream_recovers_from_invalid_byte() {
        // A genuinely invalid byte becomes one replacement char and never stalls
        // the surrounding text.
        let mut d = super::Utf8Stream::default();
        assert_eq!(d.push(&[b'x', 0xFF, b'y']), "x\u{FFFD}y");
    }

    #[test]
    fn pty_opens_spawns_and_exits() {
        // Exercises the same path as term_open (openpty + spawn + reader + writer)
        // without a blocking read: proves the portable-pty stack works on this
        // machine. Windows has no /bin/sh, and ConPTY has finicky
        // natural-exit/wait semantics, so there we spawn the same kind of
        // interactive shell term_open uses and tear it down with kill() instead
        // of waiting on a child to exit on its own (which deadlocks).
        let sys = portable_pty::native_pty_system();
        let pair = sys
            .openpty(portable_pty::PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        if cfg!(target_os = "windows") {
            let cmd = portable_pty::CommandBuilder::new("cmd.exe");
            let mut child = pair.slave.spawn_command(cmd).unwrap();
            drop(pair.slave);
            let _reader = pair.master.try_clone_reader().unwrap();
            let _writer = pair.master.take_writer().unwrap();
            // killing a live pty child proves teardown works on this OS
            child.kill().unwrap();
        } else {
            let mut cmd = portable_pty::CommandBuilder::new("/bin/sh");
            cmd.args(["-c", "exit 0"]);
            let mut child = pair.slave.spawn_command(cmd).unwrap();
            drop(pair.slave);
            let _reader = pair.master.try_clone_reader().unwrap();
            let _writer = pair.master.take_writer().unwrap();
            let status = child.wait().unwrap();
            assert!(status.success());
        }
    }

    #[test]
    fn list_all_indexes_text_and_skips_git_and_large() {
        // ADR-0008 flat quick-open index: every text-ish file by full rel path,
        // skipping hidden dirs (.git) and oversized/binary files.
        let root = std::env::temp_dir().join(format!("loro-la-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("contexts/a")).unwrap();
        std::fs::create_dir_all(root.join("pessoal/temas/x")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("contexts/a/context.md"), "# a").unwrap();
        std::fs::write(root.join("pessoal/temas/x/nota.md"), "nota").unwrap();
        std::fs::write(root.join(".git/config"), "[core]\n").unwrap();
        // oversized image (>512KB): allowed extension but skipped by the size guard
        std::fs::write(root.join("big.png"), vec![0u8; 600 * 1024]).unwrap();

        let hits = list_all_in(&root);
        let rels: Vec<&str> = hits.iter().map(|h| h.rel.as_str()).collect();
        assert!(rels.contains(&"contexts/a/context.md"));
        assert!(rels.contains(&"pessoal/temas/x/nota.md"));
        assert_eq!(
            hits.len(),
            2,
            "only the two .md files; no .git, no large image"
        );

        let ctx = hits
            .iter()
            .find(|h| h.rel == "contexts/a/context.md")
            .unwrap();
        assert_eq!(ctx.kind, "context");
        assert_eq!(ctx.title, "context.md");
        let prod = hits
            .iter()
            .find(|h| h.rel == "pessoal/temas/x/nota.md")
            .unwrap();
        assert_eq!(prod.kind, "personal");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn gitignore_keeps_queue_out_of_versioning() {
        let root = std::env::temp_dir().join(format!("loro-gi-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // old repo: an existing .gitignore without the rules
        std::fs::write(root.join(".gitignore"), "node_modules/\n").unwrap();
        ensure_gitignore(&root).unwrap();
        let gi = std::fs::read_to_string(root.join(".gitignore")).unwrap();
        assert!(gi.contains("node_modules/")); // preserves what was there
        for e in GIT_IGNORED {
            assert!(gi.lines().any(|l| l.trim() == e), "missing {e}");
        }
        // ADR-0013: a single line quarantines the whole Brainstorming world;
        // the legacy pessoal/ line stays for un-migrated acervos.
        assert!(gi.lines().any(|l| l.trim() == "brainstorming/"));
        assert!(gi.lines().any(|l| l.trim() == "pessoal/"));
        // idempotent: running again does not duplicate
        ensure_gitignore(&root).unwrap();
        let gi2 = std::fs::read_to_string(root.join(".gitignore")).unwrap();
        assert_eq!(gi2.matches("inbox/").count(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    fn ctx_fixture(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("loro-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for c in ["frota", "engenharia/frontend", "engenharia/backend"] {
            let d = root.join("contexts").join(c);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("guia.md"), "x").unwrap();
        }
        root
    }

    #[test]
    fn list_contexts_is_recursive_and_beyond_three_levels() {
        // ADR-0005: recursive domain — parent with context.md + nested subdomains
        let root = std::env::temp_dir().join(format!("loro-rec-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let with_ctx = [
            "frota",                      // parent (has context.md AND children) -> listed
            "frota/multas",               // subdomain -> listed
            "frota/eletrica/piloto",      // level 3 -> listed
            "frota/eletrica/piloto/pods", // level 4 (beyond the old cap of 3) -> listed
        ];
        for c in with_ctx {
            let d = root.join("contexts").join(c);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("context.md"), "x").unwrap();
        }
        let got = list_contexts(&root);
        for c in with_ctx {
            assert!(got.contains(&c.to_string()), "missing {c} in {got:?}");
        }
        // "frota/eletrica" only groups (no context.md, has a child) -> NOT a context
        assert!(!got.contains(&"frota/eletrica".to_string()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_moves_context_within_the_tree() {
        let root = ctx_fixture("mv");
        // move into a new area (creates the parent)
        rename_context_dir(&root, "frota", "operacoes/frota").unwrap();
        assert!(!root.join("contexts/frota").exists());
        assert!(root.join("contexts/operacoes/frota/guia.md").is_file());
        // renames a whole FOLDER (the subtree follows)
        rename_context_dir(&root, "engenharia", "eng").unwrap();
        assert!(root.join("contexts/eng/frontend/guia.md").is_file());
        // a collision is refused
        std::fs::create_dir_all(root.join("contexts/frota2")).unwrap();
        let err = rename_context_dir(&root, "operacoes/frota", "frota2").unwrap_err();
        assert_eq!(err, "err.context_exists");
        // an invalid name is refused
        assert!(rename_context_dir(&root, "eng", "Eng Inválido!").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_removes_context_and_folder() {
        let root = ctx_fixture("del");
        delete_context_dir(&root, "frota").unwrap();
        assert!(!root.join("contexts/frota").exists());
        // whole folder (with subcontexts)
        delete_context_dir(&root, "engenharia").unwrap();
        assert!(!root.join("contexts/engenharia").exists());
        // missing and invalid names are refused
        assert!(delete_context_dir(&root, "nada").is_err());
        assert!(delete_context_dir(&root, "../fora").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn templates_per_language() {
        let cx = ["risco".to_string()];
        assert!(agents_template(&cx, "pt").contains("Acervo de contextos"));
        assert!(agents_template(&cx, "en").contains("Knowledge base"));
        assert!(brain_skill("pt").contains("curador"));
        assert!(brain_skill("en").contains("curator"));
    }

    #[test]
    fn import_name_prefixes_context() {
        assert_eq!(import_name(Some("frota"), "doc.pdf"), "frota--doc.pdf");
        assert_eq!(import_name(None, "doc.pdf"), "doc.pdf");
        assert_eq!(import_name(Some(""), "doc.pdf"), "doc.pdf");
    }

    #[test]
    fn context_is_business_readable() {
        assert!(CONTEXT_TEMPLATE.contains("Visão geral"));
        assert!(CONTEXT_TEMPLATE.contains("Fluxos principais"));
        assert!(CONTEXT_TEMPLATE.contains("Hotspots")); // section 6 replaces loose questions/ideas
        assert!(CONTEXT_TEMPLATE.contains("[!HOTSPOT]")); // parseable hotspot marker
        assert!(!CONTEXT_TEMPLATE.contains("Bounded"));
    }

    #[test]
    fn codeowners_generates_commented_line_per_context() {
        let co = codeowners_template(&["frota".into(), "engenharia/frontend".into()], "pt");
        // commented lines: an unfilled CODEOWNERS never blocks GitHub
        assert!(co.contains("# /contexts/frota/    @owner"));
        assert!(co.contains("# /contexts/engenharia/frontend/    @owner"));
        assert!(co.contains("CODEOWNERS"));
    }

    // N13 — a project created before the vocabulary fix carries the old lines ON
    // DISK, and seeding is create-if-absent: the refresh is the only thing that
    // ever reaches it. Both lines the user reads are rewritten (the tooltip and
    // the "argumentos: …" of the "usar" sheet); the body he may have edited is not.
    #[test]
    fn seeding_refreshes_the_two_front_matter_lines_the_user_reads() {
        let root = std::env::temp_dir().join(format!("loro-refresh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".claude/commands")).unwrap();
        let p = root.join(".claude/commands/loro-slack.md");
        std::fs::write(
            &p,
            "---\ndescription: Envia uma pergunta sobre um trecho grifado para um canal/pessoa no Slack, pelo conector do agente (ADR-0007)\nargument-hint: <alvo:acervo://<rel>#<annot-id>> <#canal-ou-@pessoa> [mensagem]\n---\n\ncorpo que o usuário editou\n",
        )
        .unwrap();

        ensure_acervo_structure(&root, &[], "pt", None).unwrap();

        let out = std::fs::read_to_string(&p).unwrap();
        assert!(!out.contains("ADR-0007"), "{out}");
        assert!(!out.contains("acervo://"), "{out}");
        assert!(
            out.ends_with("corpo que o usuário editou\n"),
            "the refresh touches the two lines and nothing else: {out}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn seeding_uses_context_md_and_collaboration_without_brainstorming() {
        let root = std::env::temp_dir().join(format!("loro-seed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        ensure_acervo_structure(&root, &["frota".into()], "pt", None).unwrap();
        // the official source of truth is context.md; no guia.md nor brainstorming/
        assert!(root.join("contexts/frota/context.md").is_file());
        assert!(!root.join("contexts/frota/guia.md").exists());
        assert!(!root.join("contexts/frota/brainstorming").exists());
        // collaboration scaffolding
        assert!(root.join(".github/CODEOWNERS").is_file());
        assert!(root.join(".github/pull_request_template.md").is_file());
        // ADR-0011: the digest skill is seeded like every other built-in
        assert!(root.join(".claude/commands/loro-digest.md").is_file());
        // idempotent and non-destructive: running again does not break
        ensure_acervo_structure(&root, &["frota".into()], "pt", None).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    // ADR-0026 §20 — o portão. O estado meio-migrado é pior que qualquer um dos
    // dois extremos, e foi ele que fez o conhecimento sumir da tela: o app
    // reconhece a estrutura antiga e para, em vez de mostrar meio acervo.
    #[test]
    fn a_legacy_layout_is_reported_so_the_screen_can_stop() {
        let root = std::env::temp_dir().join(format!("loro-gate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("contextos/frota")).unwrap();
        assert!(
            crate::paths::is_legacy_layout(&root),
            "contextos/ é a antiga"
        );

        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("reunioes")).unwrap();
        assert!(crate::paths::is_legacy_layout(&root), "reunioes/ também");

        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("contexts/frota")).unwrap();
        std::fs::create_dir_all(root.join("meetings")).unwrap();
        assert!(
            !crate::paths::is_legacy_layout(&root),
            "um acervo migrado não é portão"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // ADR-0026 §14 — the migration is user-triggered, so until it runs an existing
    // acervo still has the Portuguese folders. Reading has to find them, or the
    // upgrade looks like data loss: no themes, no meetings, no notes.
    #[test]
    fn an_acervo_that_has_not_migrated_still_opens() {
        let root = std::env::temp_dir().join(format!("loro-legacy-open-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("contextos/frota")).unwrap();
        std::fs::write(root.join("contextos/frota/context.md"), "# frota").unwrap();
        std::fs::create_dir_all(root.join("reunioes")).unwrap();
        std::fs::write(root.join("reunioes/r.md"), "# r").unwrap();
        std::fs::create_dir_all(root.join("notas")).unwrap();
        std::fs::write(root.join("notas/n.md"), "# n").unwrap();

        assert_eq!(
            list_contexts(&root),
            vec!["frota".to_string()],
            "os temas aparecem"
        );
        assert_eq!(
            list_files_at(&crate::paths::acervo_dir(&root, "meetings", "reunioes")).len(),
            1,
            "as reuniões aparecem"
        );
        assert_eq!(
            list_files_at(&crate::paths::acervo_dir(&root, "notes", "notas")).len(),
            1,
            "as notas aparecem"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // ADR-0026 §16 — a NEW acervo is born with everything this ADR decided. Every
    // rule here was applied by hand to one existing acervo during the work; a rule
    // that only lives in a migration is a rule the next project will not have.
    // This test is the guarantee, and it fails the day a convention is taught to
    // the migration and forgotten in the generator.
    #[test]
    fn a_fresh_acervo_is_born_with_every_convention() {
        for lang in ["pt", "en"] {
            let root =
                std::env::temp_dir().join(format!("loro-fresh-{lang}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            ensure_acervo_structure(&root, &["frota".to_string()], lang, None).unwrap();

            // §14 — the folders are English, and no Portuguese one is created
            for dir in ["contexts", "meetings", "notes", "inbox", "processed"] {
                assert!(root.join(dir).is_dir(), "[{lang}] missing {dir}/");
            }
            for legacy in ["contextos", "reunioes", "notas", "anexos"] {
                assert!(!root.join(legacy).exists(), "[{lang}] created {legacy}/");
            }

            // the entry documents the protocol sends everyone to
            assert!(root.join("INDEX.md").is_file(), "[{lang}] no INDEX.md");
            assert!(
                root.join("TERMS.md").is_file(),
                "[{lang}] a fresh acervo has no índice remissivo"
            );

            let agents = std::fs::read_to_string(root.join("AGENTS.md")).unwrap();
            let flat = agents.split_whitespace().collect::<Vec<_>>().join(" ");
            // §1 — a cited context is a link, and a handoff carries its kind
            assert!(flat.contains("](../"), "[{lang}] no relative-link rule");
            for kind in ["upstream", "downstream"] {
                assert!(flat.contains(kind), "[{lang}] no edge kind {kind}");
            }
            // §10 — the reading protocol lands on a section, not just a file
            let facts = if lang == "en" {
                "section 5"
            } else {
                "seção 5"
            };
            assert!(flat.contains(facts), "[{lang}] no facts-section rule");
            // §15 — the hotspot id carries its date
            let hotspot = if lang == "en" {
                "H-YYYY-MM-DD-<slug>"
            } else {
                "H-AAAA-MM-DD-<apelido>"
            };
            assert!(flat.contains(hotspot), "[{lang}] hotspot id has no date");
            // §11 — where a meeting came from, as an id
            assert!(flat.contains("origem"), "[{lang}] no meeting-origin rule");

            // the context mould itself carries the dated hotspot format
            let ctx = std::fs::read_to_string(root.join("contexts/frota/context.md")).unwrap();
            assert!(
                ctx.contains("[!HOTSPOT] H-"),
                "[{lang}] mould lost the hotspot"
            );
            assert!(
                ctx.contains("MM-DD-"),
                "[{lang}] the mould's hotspot id has no date"
            );
            let _ = std::fs::remove_dir_all(&root);
        }
    }

    // ---- ADR-0003: usage templates seed AGENTS.md addendum, skills and the
    // queue guide — non-destructively and only on first setup for the guide.
    #[test]
    fn template_seeds_agents_addendum_skills_and_queue_guide() {
        let root = std::env::temp_dir().join(format!("loro-tpl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let tpl = TemplateContent {
            agents_extra: Some("## Regras da vertical: teste\n".into()),
            inbox_prompt: Some("# Guia da fila — teste\n".into()),
            context_md: Some("# {{CONTEXT}} — contexto\n\n## 1 · Molde da vertical\n".into()),
            skills: vec![("brain-mensagem.md".into(), "corpo da skill".into())],
        };
        ensure_acervo_structure(&root, &["contas".into()], "pt", Some(&tpl)).unwrap();
        let agents = std::fs::read_to_string(root.join("AGENTS.md")).unwrap();
        // addendum appended after the default body — the loop mechanics survive
        assert!(agents.contains("Acervo de contextos"));
        assert!(agents.contains("Regras da vertical: teste"));
        assert_eq!(
            std::fs::read_to_string(root.join(".claude/commands/brain-mensagem.md")).unwrap(),
            "corpo da skill"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("inbox/_prompt.md")).unwrap(),
            "# Guia da fila — teste\n"
        );
        // the vertical's own context.md mold, placeholder resolved
        let ctx = std::fs::read_to_string(root.join("contexts/contas/context.md")).unwrap();
        assert!(ctx.starts_with("# contas — contexto"));
        assert!(ctx.contains("Molde da vertical"));
        // the loop consumed the guide; a re-materialization must NOT re-inject it
        std::fs::remove_file(root.join("inbox/_prompt.md")).unwrap();
        ensure_acervo_structure(&root, &["contas".into()], "pt", Some(&tpl)).unwrap();
        assert!(!root.join("inbox/_prompt.md").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn no_template_matches_previous_behavior() {
        let root = std::env::temp_dir().join(format!("loro-notpl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        ensure_acervo_structure(&root, &["frota".into()], "pt", None).unwrap();
        let agents = std::fs::read_to_string(root.join("AGENTS.md")).unwrap();
        assert_eq!(agents, agents_template(&["frota".into()], "pt"));
        assert!(!root.join("inbox/_prompt.md").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn agent_process_name_takes_first_token_basename() {
        assert_eq!(agent_process_name("claude"), "claude");
        assert_eq!(agent_process_name("ollama run llama3"), "ollama");
        assert_eq!(
            agent_process_name("/usr/local/bin/gemini --flash"),
            "gemini"
        );
        assert_eq!(agent_process_name(""), "claude");
    }

    // ADR-0005: the grace window that stops termRunAgent from retyping the
    // agent launch line into a session that already has it in flight.
    #[test]
    fn is_within_grace_holds_for_a_short_window_only() {
        assert!(is_within_grace(std::time::Duration::from_secs(0)));
        assert!(is_within_grace(std::time::Duration::from_secs(5)));
        assert!(!is_within_grace(std::time::Duration::from_secs(6)));
        assert!(!is_within_grace(std::time::Duration::from_secs(30)));
    }

    #[test]
    fn migration_is_non_destructive_and_idempotent() {
        let root = std::env::temp_dir().join(format!("loro-mig-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        // legacy acervo: guia.md + one loose idea in brainstorming/
        let d = root.join("contexts/frota");
        std::fs::create_dir_all(d.join("brainstorming")).unwrap();
        std::fs::write(d.join("guia.md"), "conhecimento").unwrap();
        std::fs::write(d.join("brainstorming/x.md"), "ideia").unwrap();

        // dry-run: reports but changes nothing
        let r = migrate_acervo(&root, false, "pt").unwrap();
        assert!(r.dry_run);
        assert_eq!(r.renamed, vec!["frota".to_string()]);
        assert!(r
            .legacy_ideas
            .iter()
            .any(|s| s.starts_with("frota/brainstorming")));
        assert!(d.join("guia.md").is_file());
        assert!(!d.join("context.md").exists());
        assert!(!root.join(".github/CODEOWNERS").exists());

        // apply: renames and creates scaffolding; ideas preserved (never deleted)
        let r = migrate_acervo(&root, true, "pt").unwrap();
        assert!(!r.dry_run);
        assert!(d.join("context.md").is_file());
        assert!(!d.join("guia.md").exists());
        assert_eq!(
            std::fs::read_to_string(d.join("context.md")).unwrap(),
            "conhecimento"
        );
        assert!(d.join("brainstorming/x.md").is_file()); // non-destructive
        assert!(root.join(".github/CODEOWNERS").is_file());
        assert!(root.join(".github/pull_request_template.md").is_file());

        // idempotent: a second pass has nothing left to rename
        let r = migrate_acervo(&root, true, "pt").unwrap();
        assert!(r.renamed.is_empty());
        assert!(r.conflicts.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migration_folds_legacy_incubadora_into_brainstorming_non_destructively() {
        // ADR-0013: legacy top-level incubadora/ folds into brainstorming/;
        // notes/ stays versioned; nothing is ever deleted.
        let root = std::env::temp_dir().join(format!("loro-inc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("incubadora/ideia-a")).unwrap();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("incubadora/ideia-a/nota.md"), "rascunho").unwrap();
        std::fs::write(root.join("notes/mantida.md"), "versionada").unwrap();

        // dry-run: lists the planned move, changes nothing
        let r = migrate_acervo(&root, false, "pt").unwrap();
        assert!(r
            .incubated
            .iter()
            .any(|s| s.contains("incubadora/ideia-a/nota.md -> brainstorming/incubadora")));
        assert!(!root
            .join("brainstorming/incubadora/ideia-a/nota.md")
            .exists());

        // apply: copies into brainstorming/, leaves the legacy original AND notes/ intact
        let r = migrate_acervo(&root, true, "pt").unwrap();
        assert_eq!(r.incubated.len(), 1);
        assert!(root
            .join("brainstorming/incubadora/ideia-a/nota.md")
            .is_file());
        assert!(root.join("incubadora/ideia-a/nota.md").is_file()); // non-destructive
        assert!(root.join("notes/mantida.md").is_file()); // notes/ stays

        // idempotent: the destination already exists → nothing to fold
        let r = migrate_acervo(&root, true, "pt").unwrap();
        assert!(r.incubated.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migration_renames_pessoal_to_brainstorming_non_destructively() {
        // ADR-0013: pessoal/temas/<slug> -> brainstorming/<slug>, tema.md -> index.md;
        // dry-run changes nothing; a conflict (both worlds) moves nothing.
        let root = std::env::temp_dir().join(format!("loro-rw-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("pessoal/temas/frota/meetings/r1")).unwrap();
        std::fs::create_dir_all(root.join("pessoal/avulso")).unwrap();
        std::fs::write(root.join("pessoal/temas/frota/tema.md"), "# Frota").unwrap();
        std::fs::write(
            root.join("pessoal/temas/frota/meetings/r1/reuniao.md"),
            "fala",
        )
        .unwrap();
        std::fs::write(root.join("pessoal/avulso/2026-07-27-ideia.md"), "solta").unwrap();

        // dry-run: reports the move, changes nothing
        let r = migrate_acervo(&root, false, "pt").unwrap();
        assert!(r
            .renamed_world
            .iter()
            .any(|s| s == "pessoal/temas/frota -> brainstorming/frota"));
        assert!(root.join("pessoal/temas/frota/tema.md").is_file());
        assert!(!root.join("brainstorming/frota").exists());

        // apply: renamed on disk, tema.md -> index.md, legacy pessoal/ gone
        migrate_acervo(&root, true, "pt").unwrap();
        assert!(root.join("brainstorming/frota/index.md").is_file());
        assert!(!root.join("brainstorming/frota/tema.md").exists());
        assert!(root
            .join("brainstorming/frota/meetings/r1/meeting.md")
            .is_file());
        assert!(root
            .join("brainstorming/avulso/2026-07-27-ideia.md")
            .is_file());
        assert!(!root.join("pessoal").exists());

        // idempotent: second pass has nothing to move
        let r = migrate_acervo(&root, true, "pt").unwrap();
        assert!(r.renamed_world.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    // ADR-0026 §14 — the acervo's own folders are named in English too. The rename
    // follows the pessoal/ precedent: non-destructive, idempotent, and it refuses
    // to clobber a destination that already exists.
    #[test]
    fn migration_renames_the_acervo_folders_to_english() {
        let root = std::env::temp_dir().join(format!("loro-dirs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("contextos/frota")).unwrap();
        std::fs::write(root.join("contextos/frota/context.md"), "# frota").unwrap();
        std::fs::create_dir_all(root.join("reunioes")).unwrap();
        std::fs::create_dir_all(root.join("notas")).unwrap();
        std::fs::create_dir_all(root.join("contextos/frota/anexos")).unwrap();

        migrate_acervo(&root, true, "pt").unwrap();

        assert!(root.join("contexts/frota/context.md").is_file());
        assert!(root.join("meetings").is_dir());
        assert!(root.join("notes").is_dir());
        assert!(root.join("contexts/frota/attachments").is_dir());
        assert!(!root.join("contextos").exists());
        assert!(!root.join("reunioes").exists());
        assert!(!root.join("notas").exists());

        // idempotent
        migrate_acervo(&root, true, "pt").unwrap();
        assert!(root.join("contexts/frota/context.md").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    // Half a migration is worse than none: English folders holding Portuguese
    // documents is a tree nobody can reason about.
    #[test]
    fn migration_renames_the_generated_files_too() {
        let root = std::env::temp_dir().join(format!("loro-files-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let mdir = root.join("brainstorming/frota/reunioes/r1");
        std::fs::create_dir_all(&mdir).unwrap();
        std::fs::write(mdir.join("reuniao.md"), "# transcricao").unwrap();
        std::fs::write(mdir.join("auditoria.jsonl"), "{}\n").unwrap();
        std::fs::write(mdir.join("marcadores.jsonl"), "{}\n").unwrap();
        std::fs::write(root.join("brainstorming/frota/indice.md"), "# frota").unwrap();

        migrate_acervo(&root, true, "pt").unwrap();

        let m = root.join("brainstorming/frota/meetings/r1");
        assert!(m.join("meeting.md").is_file(), "o arquivo vivo");
        assert!(m.join("audit.jsonl").is_file());
        assert!(m.join("markers.jsonl").is_file());
        assert!(root.join("brainstorming/frota/index.md").is_file());
        assert!(!m.join("reuniao.md").exists());
        assert_eq!(
            std::fs::read_to_string(m.join("meeting.md")).unwrap(),
            "# transcricao",
            "o conteudo e o mesmo — so o nome mudou"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migration_never_clobbers_a_folder_that_already_exists() {
        let root = std::env::temp_dir().join(format!("loro-dirs2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("contextos/a")).unwrap();
        std::fs::create_dir_all(root.join("contexts/b")).unwrap();
        std::fs::write(root.join("contexts/b/context.md"), "novo").unwrap();

        migrate_acervo(&root, true, "pt").unwrap();

        assert!(
            root.join("contextos/a").is_dir(),
            "the legacy folder is kept"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("contexts/b/context.md")).unwrap(),
            "novo",
            "the existing one is untouched"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // A chave é o contrato: serializa e confere, em vez de confiar no atributo.
    #[test]
    fn the_status_sends_the_entry_documents_under_the_key_the_screen_reads() {
        let json = serde_json::to_string(&BrainStatus {
            configured: true,
            dir: String::new(),
            contexts: vec![],
            inbox: vec![],
            processed: 0,
            meetings: vec![],
            notes: vec![],
            incubadora: vec![],
            entry_docs: vec![BrainFile {
                name: "TERMS.md".into(),
                path: "TERMS.md".into(),
                mtime: 0,
            }],
            legacy_layout: false,
            activity: String::new(),
        })
        .unwrap();
        assert!(
            json.contains(r#""entryDocs":[{"name":"TERMS.md""#),
            "{json}"
        );
        assert!(
            !json.contains("entry_docs"),
            "a chave antiga não pode sobrar"
        );
    }

    #[test]
    fn migration_conflicts_when_both_worlds_coexist() {
        // ADR-0013 R2: if both pessoal/ and brainstorming/ exist, report a conflict
        // and DO NOT clobber the new world.
        let root = std::env::temp_dir().join(format!("loro-rwc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("pessoal/temas/x")).unwrap();
        std::fs::create_dir_all(root.join("brainstorming/y")).unwrap();
        std::fs::write(root.join("brainstorming/y/indice.md"), "novo").unwrap();

        let r = migrate_acervo(&root, true, "pt").unwrap();
        assert!(r.renamed_world.iter().any(|s| s.starts_with("conflito:")));
        // both worlds untouched
        assert!(root.join("pessoal/temas/x").is_dir());
        // o documento do tema é renomeado junto (ADR-0026 §14); o CONTEÚDO é o teste
        assert_eq!(
            std::fs::read_to_string(root.join("brainstorming/y/index.md")).unwrap(),
            "novo"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn seed_context_never_overwrites_legacy_guia() {
        let root = std::env::temp_dir().join(format!("loro-legacy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let d = root.join("contexts/frota");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("guia.md"), "conhecimento legado").unwrap();
        seed_context(&root, "frota", "pt", None).unwrap();
        // legacy guia preserved; no context.md created over it
        assert_eq!(
            std::fs::read_to_string(d.join("guia.md")).unwrap(),
            "conhecimento legado"
        );
        assert!(!d.join("context.md").exists());
        assert!(context_file(&d).is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn valid_hierarchical_contexts() {
        assert!(valid_context("frota"));
        assert!(valid_context("engineering/frontend"));
        assert!(valid_context("engineering/sre/platform"));
        assert!(valid_context("frota/eletrica/piloto/pods/sp/zona-leste")); // 6 levels ok (ADR-0005)
        assert!(!valid_context("a/b/c/d/e/f/g")); // > MAX_CONTEXT_DEPTH (7) levels
        assert!(!valid_context("Engineering/frontend")); // uppercase
        assert!(!valid_context("a//b")); // empty segment
        assert!(!valid_context("../etc")); // traversal
    }

    #[test]
    fn safe_inbox_name() {
        assert!(valid_inbox_name("note.md"));
        assert!(valid_inbox_name("session-1.txt"));
        assert!(!valid_inbox_name("a/b.md")); // separator
        assert!(!valid_inbox_name("../x.md")); // traversal
        assert!(!valid_inbox_name("file.pdf")); // not text-editable
        assert!(!valid_inbox_name(".hidden.md"));
        assert!(!valid_inbox_name(QUEUE_GUIDE_NAME)); // the loop guide is not an item
    }

    // ---- the fila and the loop guide -----------------------------------------

    // The guide LIVES in inbox/ but is not a queue item: `brain_setup` seeds it and
    // the loop consumes it. A brand-new acervo must therefore report an EMPTY fila —
    // otherwise the first screen claims one capture is ready and its single primary
    // action offers to turn the app's own scaffolding into versioned knowledge
    // (DESIGN.md §1: state must never lie).
    #[test]
    fn the_loop_guide_is_not_a_queue_item() {
        let root = std::env::temp_dir().join(format!("loro-guide-q-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("inbox")).unwrap();
        std::fs::write(root.join("inbox/_prompt.md"), "# Guia da fila\n").unwrap();
        assert!(
            list_queue(&root).is_empty(),
            "a fresh acervo must report nothing to organize"
        );
        std::fs::write(root.join("inbox/nota.md"), "uma captura\n").unwrap();
        let q = list_queue(&root);
        assert_eq!(q.len(), 1);
        assert_eq!(q[0].name, "nota.md");
        // the guide is skipped, never removed: its own reader/writer still owns it
        assert!(root.join("inbox/_prompt.md").is_file());
        assert!(is_queue_guide("_prompt.md"));
        assert!(is_queue_guide("inbox/_prompt.md"));
        assert!(!is_queue_guide("prompt.md"));
        let _ = std::fs::remove_dir_all(&root);
    }

    // Fixture: a brainstorming with one note per (name, body) pair.
    fn brainstorming_with(root: &Path, slug: &str, notes: &[(&str, String)]) -> Vec<String> {
        let dir = root.join("brainstorming").join(slug).join("notes");
        std::fs::create_dir_all(&dir).unwrap();
        notes
            .iter()
            .map(|(name, body)| {
                std::fs::write(dir.join(name), body).unwrap();
                format!("brainstorming/{slug}/notes/{name}")
            })
            .collect()
    }

    // ADR-0024 — the fila is a ONE-WAY door (the acervo is versioned), so the batch
    // is all-or-nothing: a credential anywhere in the selection must leave inbox/
    // untouched. Writing the earlier files and then reporting "não enviei" is the
    // worst of the three outcomes — the fila gained items while the UI says it did
    // not (BR-9: no credential enters; DESIGN.md §1: state must never lie).
    #[test]
    fn a_blocked_credential_leaves_nothing_in_the_queue() {
        let root = std::env::temp_dir().join(format!("loro-q-block-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let base = root.canonicalize().unwrap();
        // the credential is composed at runtime — see intake.rs: a literal sample
        // is swept up by GitHub push protection, which is what this module detects
        let token = format!("ghp_{}", "a".repeat(36));
        let rels = brainstorming_with(
            &base,
            "frota",
            &[
                ("a.md", "primeira captura\n".into()),
                ("b.md", "segunda captura\n".into()),
                ("c.md", format!("export TOKEN={token}\n")),
            ],
        );
        let err = queue_files_into(&base, &rels, None).unwrap_err();
        assert_eq!(err, "err.intake_secret:frota-notes-c.md");
        let queued: Vec<String> = list_queue(&base).into_iter().map(|f| f.name).collect();
        assert!(
            queued.is_empty(),
            "partial write: the fila gained {queued:?} while the send reported failure"
        );

        // and the clean part of the same selection goes through when it is the batch
        let names = queue_files_into(&base, &rels[..2], None).unwrap();
        assert_eq!(names, ["frota-notes-a.md", "frota-notes-b.md"]);
        assert_eq!(list_queue(&base).len(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    // A queued file must never LAND on the guide: `queue_name_for` flattens the
    // brainstorming-relative path, so a file named `_prompt.md` at the root of
    // `brainstorming/` would otherwise rewrite the instructions the loop obeys.
    #[test]
    fn a_queued_file_never_clobbers_the_loop_guide() {
        let root = std::env::temp_dir().join(format!("loro-q-guide-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("brainstorming")).unwrap();
        let base = root.canonicalize().unwrap();
        std::fs::write(base.join("brainstorming/_prompt.md"), "nao sou guia\n").unwrap();
        let err = resolve_queue_entry(&base, "brainstorming/_prompt.md", None).unwrap_err();
        assert_eq!(err, "err.invalid_queue_name");
        let _ = std::fs::remove_dir_all(&root);
    }

    // Fixture: a folder OUTSIDE the acervo with one file per (name, body) pair —
    // what the picker and the drag-and-drop hand to the import doors.
    fn outside_files(dir: &Path, files: &[(&str, &str)]) -> Vec<PathBuf> {
        std::fs::create_dir_all(dir).unwrap();
        files
            .iter()
            .map(|(name, body)| {
                let p = dir.join(name);
                std::fs::write(&p, body).unwrap();
                p
            })
            .collect()
    }

    // C6 — the import doors write into inbox/ too, so they carry the same guard as
    // the send door. The guide is not a queue item: `list_queue` hides it, so a file
    // named `_prompt.md` that landed on it destroyed the instructions the
    // /loro-context loop obeys AND was counted as an item the fila never shows
    // (DESIGN.md §1: state must never lie). Refused BEFORE the first copy, because
    // the fila is a one-way door (ADR-0024) and a partial batch reported as a
    // failure is the worst of the three outcomes.
    #[test]
    fn an_import_never_lands_on_the_loop_guide() {
        let root = std::env::temp_dir().join(format!("loro-imp-guide-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let inbox = root.join("inbox");
        std::fs::create_dir_all(&inbox).unwrap();
        std::fs::write(inbox.join(QUEUE_GUIDE_NAME), "# Guia da fila\n").unwrap();
        let srcs = outside_files(
            &root.join("fora"),
            &[
                ("_prompt.md", "conteudo de fora\n"),
                ("nota.md", "captura\n"),
            ],
        );

        let err = import_into_inbox(&inbox, &srcs, None).unwrap_err();
        assert_eq!(err, "err.invalid_queue_name:_prompt.md");
        assert_eq!(
            std::fs::read_to_string(inbox.join(QUEUE_GUIDE_NAME)).unwrap(),
            "# Guia da fila\n",
            "the loop guide was overwritten by an imported file"
        );
        let queued: Vec<String> = list_queue(&root).into_iter().map(|f| f.name).collect();
        assert!(
            queued.is_empty(),
            "partial import: the fila gained {queued:?} while the import reported failure"
        );

        // Steered to a context the SAME file is an ordinary item: the prefix makes a
        // different name, so nothing is lost and nothing is refused for no reason.
        assert_eq!(import_into_inbox(&inbox, &srcs, Some("frota")).unwrap(), 2);
        let mut queued: Vec<String> = list_queue(&root).into_iter().map(|f| f.name).collect();
        queued.sort();
        assert_eq!(queued, ["frota--_prompt.md", "frota--nota.md"]);
        assert_eq!(
            std::fs::read_to_string(inbox.join(QUEUE_GUIDE_NAME)).unwrap(),
            "# Guia da fila\n"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // Non-destructive premise (brain/contexts/loro/context.md, Core premises): the
    // imported bytes come from OUTSIDE the acervo, so a name collision is a
    // DIFFERENT file with the same name — and the item already in the fila may have
    // been edited there (`brain_write_inbox`). It gets a numeric suffix, the same
    // judgment the sibling door `brain_import_files` already makes for attachments/.
    #[test]
    fn an_import_never_overwrites_an_item_already_in_the_queue() {
        let root = std::env::temp_dir().join(format!("loro-imp-clash-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let inbox = root.join("inbox");
        std::fs::create_dir_all(&inbox).unwrap();
        std::fs::write(inbox.join("nota.md"), "a captura que ja estava na fila\n").unwrap();
        let srcs = outside_files(
            &root.join("fora"),
            &[("nota.md", "outra nota, outro arquivo\n")],
        );

        assert_eq!(import_into_inbox(&inbox, &srcs, None).unwrap(), 1);
        assert_eq!(
            std::fs::read_to_string(inbox.join("nota.md")).unwrap(),
            "a captura que ja estava na fila\n",
            "the import overwrote a queue item that was already there"
        );
        assert_eq!(
            std::fs::read_to_string(inbox.join("nota-2.md")).unwrap(),
            "outra nota, outro arquivo\n"
        );
        assert_eq!(list_queue(&root).len(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    // Non-destructive premise, across acervos: `brain_move` refuses a collision
    // inside one acervo (`err.file_exists_in_target`), so the cross-acervo move —
    // the same action with a different destination — must not silently replace the
    // item waiting in the OTHER acervo's fila. Nothing here is versioned yet, so the
    // overwritten capture had no copy anywhere.
    #[test]
    fn moving_a_queue_item_to_another_acervo_never_overwrites_it() {
        let root = std::env::temp_dir().join(format!("loro-mv-clash-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let a = root.join("a");
        let b = root.join("b");
        std::fs::create_dir_all(a.join("inbox")).unwrap();
        std::fs::create_dir_all(b.join("inbox")).unwrap();
        std::fs::write(a.join("inbox/nota.md"), "a captura de A\n").unwrap();
        std::fs::write(b.join("inbox/nota.md"), "a captura de B\n").unwrap();

        let err = move_queue_item(&a, &b, "nota.md", None).unwrap_err();
        assert_eq!(err, "err.file_exists_in_target");
        assert_eq!(
            std::fs::read_to_string(b.join("inbox/nota.md")).unwrap(),
            "a captura de B\n",
            "the move replaced the item waiting in the other acervo's fila"
        );
        // and the origin keeps its file: a refused move moves nothing
        assert!(a.join("inbox/nota.md").is_file());

        // the same move to a free name goes through
        std::fs::remove_file(b.join("inbox/nota.md")).unwrap();
        move_queue_item(&a, &b, "nota.md", None).unwrap();
        assert!(!a.join("inbox/nota.md").exists());
        assert_eq!(
            std::fs::read_to_string(b.join("inbox/nota.md")).unwrap(),
            "a captura de A\n"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // The transcription auto-save writes into inbox/ as well (`default_save_dir`),
    // with a caller-supplied name. A gate that trusts the frontend to have asked is
    // not a gate (ADR-0024) — and `is_safe_filename` accepts `_prompt.md`, so this
    // door could put a transcript over the loop's instruction file. BR-8 also lives
    // here: the transcript belongs in the fila as an item, never as the guide.
    #[test]
    fn auto_save_never_writes_over_the_loop_guide() {
        let root = std::env::temp_dir().join(format!("loro-as-guide-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let inbox = root.join("inbox");
        std::fs::create_dir_all(&inbox).unwrap();
        std::fs::write(inbox.join(QUEUE_GUIDE_NAME), "# Guia da fila\n").unwrap();
        let dir = inbox.display().to_string();

        let err = auto_save(
            "uma transcricao\n".into(),
            dir.clone(),
            QUEUE_GUIDE_NAME.into(),
        )
        .unwrap_err();
        assert_eq!(err, format!("err.invalid_queue_name:{QUEUE_GUIDE_NAME}"));
        assert_eq!(
            std::fs::read_to_string(inbox.join(QUEUE_GUIDE_NAME)).unwrap(),
            "# Guia da fila\n",
            "auto-save wrote over the loop guide"
        );
        // the real auto-save name still works — the guard is the guide, not the door
        auto_save(
            "uma transcricao\n".into(),
            dir,
            "loro-20260812-1200.md".into(),
        )
        .unwrap();
        assert_eq!(list_queue(&root).len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn safe_filenames() {
        assert!(is_safe_filename("loro-20260723-231455.md"));
        assert!(is_safe_filename("sessao 1.txt"));
        assert!(!is_safe_filename("../../etc/passwd"));
        assert!(!is_safe_filename("a/b.md"));
        assert!(!is_safe_filename(".oculto"));
        assert!(!is_safe_filename(""));
    }

    #[test]
    fn models_dir_honors_env_override() {
        std::env::set_var("LORO_MODELS_DIR", "/tmp/loro-test/models");
        assert_eq!(models_dir(), PathBuf::from("/tmp/loro-test/models"));
        assert_eq!(
            model_path("small"),
            PathBuf::from("/tmp/loro-test/models/ggml-small.bin")
        );
        std::env::remove_var("LORO_MODELS_DIR");
    }

    // recordings must live under the writable data dir, never the process CWD:
    // an installed app has CWD `/` (read-only) and would fail with os error 30.
    #[test]
    fn recordings_dir_lives_under_data_dir() {
        std::env::set_var("LORO_HOME", "/tmp/loro-test-home");
        assert_eq!(
            recordings_dir(),
            PathBuf::from("/tmp/loro-test-home/recordings")
        );
        std::env::remove_var("LORO_HOME");
    }

    #[test]
    fn slugify_id_normalizes_names() {
        assert_eq!(slugify_id("Meu Acervo Pessoal!"), "meu-acervo-pessoal");
        assert_eq!(slugify_id("Acme Corp"), "acme-corp");
        assert_eq!(slugify_id("   "), "acervo");
    }

    #[test]
    fn list_contexts_derives_from_disk_and_is_hierarchical() {
        let root = std::env::temp_dir().join(format!("loro-ctx-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for c in ["frota", "engenharia/frontend", "engenharia/backend"] {
            let d = root.join("contexts").join(c);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("guia.md"), "x").unwrap();
        }
        // HAND-MADE folder without guia.md: must be mapped as a (leaf) context
        std::fs::create_dir_all(root.join("contexts/vendas")).unwrap();
        // a utility subfolder does NOT become a context
        std::fs::create_dir_all(root.join("contexts/frota/brainstorming")).unwrap();
        // hidden/reserved folder is ignored
        let arch = root.join("contexts/_arquivados/velho");
        std::fs::create_dir_all(&arch).unwrap();
        std::fs::write(arch.join("guia.md"), "x").unwrap();
        let ctxs = list_contexts(&root);
        assert!(ctxs.contains(&"frota".to_string()));
        assert!(ctxs.contains(&"engenharia/frontend".to_string()));
        assert!(ctxs.contains(&"engenharia/backend".to_string()));
        assert!(
            ctxs.contains(&"vendas".to_string()),
            "a hand-made folder must be mapped"
        );
        assert!(
            !ctxs.contains(&"engenharia".to_string()),
            "a group is not a context"
        );
        assert!(!ctxs.iter().any(|c| c.contains("brainstorming")));
        assert!(!ctxs.iter().any(|c| c.contains("arquivados")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn engine_search_includes_homebrew_dirs() {
        // GUI apps get a minimal PATH on macOS; known package-manager
        // locations must always be part of the search (see ADR-0003).
        let dirs = engine_search_dirs();
        assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(dirs.contains(&PathBuf::from("/usr/local/bin")));
    }

    #[test]
    fn whisper_bin_uses_env_override() {
        std::env::set_var("WHISPER_STREAM_BIN", "/opt/x/whisper-stream");
        assert_eq!(whisper_bin(), PathBuf::from("/opt/x/whisper-stream"));
        std::env::remove_var("WHISPER_STREAM_BIN");
    }

    // ---- offline (file) transcription: whisper-cli, not whisper-stream ----

    #[test]
    fn whisper_cli_bin_uses_env_override() {
        std::env::set_var("WHISPER_CLI_BIN", "/opt/x/whisper-cli");
        assert_eq!(whisper_cli_bin(), PathBuf::from("/opt/x/whisper-cli"));
        std::env::remove_var("WHISPER_CLI_BIN");
    }

    #[test]
    fn cli_args_includes_translation_when_enabled() {
        let a = cli_args("/m.bin", "pt", true, "8", "/tmp/x.16k.wav");
        assert!(a.contains(&"-tr".to_string()));
        assert!(a.windows(2).any(|w| w[0] == "-l" && w[1] == "pt"));
        assert!(a.windows(2).any(|w| w[0] == "-m" && w[1] == "/m.bin"));
        assert!(a
            .windows(2)
            .any(|w| w[0] == "-f" && w[1] == "/tmp/x.16k.wav"));
    }

    #[test]
    fn cli_args_has_no_translation_by_default() {
        let a = cli_args("/m.bin", "pt", false, "4", "/tmp/x.16k.wav");
        assert!(!a.contains(&"-tr".to_string()));
        assert!(a.windows(2).any(|w| w[0] == "-t" && w[1] == "4"));
    }

    #[test]
    fn cli_args_uses_no_streaming_flags() {
        // whisper-cli is not whisper-stream: no --step/--length/-vth/-c
        let a = cli_args("/m.bin", "pt", false, "8", "/tmp/x.16k.wav");
        assert!(!a.contains(&"--step".to_string()));
        assert!(!a.contains(&"--length".to_string()));
        assert!(!a.contains(&"-vth".to_string()));
        assert!(!a.contains(&"-c".to_string()));
    }

    #[test]
    fn wav_path_for_derives_16k_name_in_same_directory() {
        assert_eq!(
            wav_path_for(Path::new("/tmp/rec-1.webm")),
            PathBuf::from("/tmp/rec-1.16k.wav")
        );
        assert_eq!(
            wav_path_for(Path::new("/a/b/audio.mp3")),
            PathBuf::from("/a/b/audio.16k.wav")
        );
    }

    // ---- pseudo-stream (ADR-0010/0012), no real audio -----------------------

    // File-mode regression: transcribe_wav's signature is pinned so the additive
    // window path can never silently change what file mode + meeting stop depend
    // on (the global transcript-line emit runs through this exact function).
    #[test]
    #[allow(clippy::type_complexity)] // the whole point is to pin the exact signature
    fn transcribe_wav_signature_is_unchanged() {
        let _f: fn(&Path, &Path, &Path, &str, bool, &str, &AppHandle) -> Result<(), String> =
            transcribe_wav;
    }

    #[test]
    fn window_ffmpeg_args_carves_the_requested_window() {
        let src = Path::new("/m/audio/system.wav");
        let dst = Path::new("/m/audio/.window-60000.wav");
        // bounded window: -ss = from (60.000s), -to = duration (to-from = 30.000s)
        let a = window_ffmpeg_args(src, dst, 60_000, Some(90_000));
        assert!(a.windows(2).any(|w| w[0] == "-ss" && w[1] == "60.000"));
        assert!(a.windows(2).any(|w| w[0] == "-to" && w[1] == "30.000"));
        assert!(a
            .windows(2)
            .any(|w| w[0] == "-i" && w[1] == "/m/audio/system.wav"));
        // resamples to 16k mono PCM, same as the file path
        assert!(a.windows(2).any(|w| w[0] == "-ar" && w[1] == "16000"));
        assert!(a.windows(2).any(|w| w[0] == "-ac" && w[1] == "1"));
        assert_eq!(a.last().unwrap(), "/m/audio/.window-60000.wav");
        // open-ended window (to end of file): no -to bound at all
        let b = window_ffmpeg_args(src, dst, 1_500, None);
        assert!(b.windows(2).any(|w| w[0] == "-ss" && w[1] == "1.500"));
        assert!(!b.iter().any(|s| s == "-to"));
    }

    // ADR-0025 §28 — reported from a real meeting: from 00:00 to 00:18 NOTHING was
    // recorded on either track (both showed a whisper silence-hallucination), while
    // everything from 00:18 on was perfect. The two tracks rotate on the SAME 18s
    // tick, and on the FIRST tick both carve with from_ms=0 — into the same
    // `.window-0.wav`, in the same meeting's audio dir, from two spawn_blocking
    // threads. Two ffmpeg processes writing one path, and the first to finish
    // deletes it under the other. From the second tick on the tail's offset is
    // 18000, 36000, … so the names stop colliding and the defect disappears — which
    // is exactly the shape of the report. Same bug class as the snapshot in
    // ADR-0022 §407: that name was made unique, this one was not.
    #[test]
    fn two_carves_at_the_same_offset_never_share_a_file() {
        let tail = Path::new("/m/audio/.tail.snapshot.123.wav");
        let mic = Path::new("/m/audio/.seg.456.webm");
        // as duas trilhas, no primeiro tique, com o MESMO from_ms
        let a = window_carve_path(tail, 0);
        let b = window_carve_path(mic, 0);
        assert_ne!(a, b, "as duas trilhas cortariam para o mesmo arquivo");
        // e nem duas chamadas idênticas se cruzam
        assert_ne!(window_carve_path(tail, 0), window_carve_path(tail, 0));
        // continua ao lado do arquivo de origem (quarentena sob pessoal/)
        assert_eq!(a.parent(), Some(Path::new("/m/audio")));
        assert!(a
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(".window-"));
        assert_eq!(a.extension().unwrap(), "wav");
    }

    // ADR-0025 — the anchor's contract spans two languages: Swift prints it, Rust
    // reads it. Nothing else would report a mismatch, because a missing anchor
    // degrades QUIETLY back to the old estimate — the meeting would keep working
    // while the clocks silently drifted apart again.
    #[test]
    fn the_sidecar_and_the_parent_agree_on_the_anchor_line() {
        let swift = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("syscap/loro-syscap.swift"),
        )
        .expect("o sidecar tem de estar no repositório");
        assert!(
            swift.contains(&format!("print(\"{SYSCAP_ANCHOR_PREFIX}")),
            "o sidecar precisa imprimir exatamente o prefixo que o pai lê"
        );
        // and the line it prints is the line we parse
        assert_eq!(
            parse_anchor_line("first-sample-epoch-ms 1786624147797"),
            Some(1_786_624_147_797)
        );
        // an older sidecar (or any other chatter on stdout) is simply not an anchor
        assert_eq!(parse_anchor_line("syscap: capturing system audio"), None);
        assert_eq!(parse_anchor_line("first-sample-epoch-ms abc"), None);
        assert_eq!(parse_anchor_line(""), None);
    }

    // ADR-0025 — the meeting's two tracks could not be put on one timeline while
    // this parser threw the whisper timestamps away: an 18s window collapsed into
    // ONE block stamped at its start, so only its first utterance had a true
    // timecode and cross-track comparison had nothing finer than the window.
    #[test]
    fn parse_whisper_segments_keeps_the_time_of_each_utterance() {
        // Saída REAL do whisper-cli (v1.8, modelo small, pt) sobre 7s de fala. Foi
        // colhida rodando a ferramenta, não escrita à mão: é o formato de linha que
        // sustenta todo o resto, e 7 segundos já rendem DUAS falas com tempos
        // próprios — a granularidade que a janela de 18s jogava fora.
        let real = "\n[00:00:00.000 --> 00:00:05.780]   Bom dia a todos, vamos revisar os custos da frota hoje, depois eu mando os números\n\
            [00:00:05.780 --> 00:00:06.780]   do fornecedor.\n";
        let segs = parse_whisper_segments(real);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].t_ms, 0);
        assert_eq!(segs[0].end_ms, 5_780);
        assert!(segs[0].text.starts_with("Bom dia a todos"));
        assert_eq!(segs[1].t_ms, 5_780);
        assert_eq!(segs[1].end_ms, 6_780);
        assert_eq!(segs[1].text, "do fornecedor.");

        // e o ruído em volta continua fora
        let stdout = "### START | t0 = 0 ms\n\
            [00:00:00.000 --> 00:00:02.000]   Bom dia a todos\n\
            [00:00:02.000 --> 00:00:03.000]   [Start speaking]\n\
            [00:00:03.500 --> 00:00:05.000]   vamos revisar os custos\n\
            linha sem timestamp\n";
        assert_eq!(
            parse_whisper_segments(stdout),
            vec![
                SpokenSegment {
                    t_ms: 0,
                    end_ms: 2_000,
                    text: "Bom dia a todos".into()
                },
                SpokenSegment {
                    t_ms: 3_500,
                    end_ms: 5_000,
                    text: "vamos revisar os custos".into()
                },
            ]
        );
    }

    // A janela é cortada com `-ss`, que é seek de ENTRADA: os timestamps de saída
    // voltam a zero, e é por isso que o tail soma o `from_ms` de volta. Verificado
    // rodando ffmpeg+whisper de verdade — cortando fala.wav a partir de 4s, o
    // whisper devolveu "[00:00:00.000 --> 00:00:02.000] depois eu mando os números
    // do fornecedor", isto é, o áudio do segundo 4 carimbado em zero. Sem essa
    // soma, toda janela depois da primeira cairia no começo da reunião.
    #[test]
    fn a_carved_window_restarts_at_zero_so_the_caller_adds_its_offset() {
        let carved =
            "[00:00:00.000 --> 00:00:02.000]   depois eu mando os números do fornecedor.\n";
        let seg = &parse_whisper_segments(carved)[0];
        assert_eq!(seg.t_ms, 0);
        let from_ms = 4_000;
        assert_eq!(seg.t_ms + from_ms, 4_000);
        assert_eq!(seg.end_ms + from_ms, 6_000);
    }

    // ONE parser for both paths (the streaming/file paths only need the text).
    // Two parsers is how a line's text and its timecode drift apart.
    #[test]
    fn the_timed_and_the_text_paths_read_the_same_line() {
        let line = "[01:02:03.250 --> 01:02:04.000]   depois de uma hora";
        let seg = &parse_whisper_segments(line)[0];
        assert_eq!(seg.t_ms, 3_723_250);
        assert_eq!(seg.end_ms, 3_724_000);
        assert_eq!(extract_text(line).unwrap(), seg.text);
        // a bracketed annotation is still text, exactly as the file path sees it
        let ann = "[00:00:00.000 --> 00:00:05.000]   [SOM DE FUNDO]";
        assert_eq!(parse_whisper_segments(ann)[0].text, "[SOM DE FUNDO]");
        // and the lines that carry no speech carry no segment either
        for quiet in [
            "[Start speaking]",
            "linha sem timestamp",
            "[00:00:00.000 --> 00:00:05.000]    ",
            "### Transcription 0 START | t0 = 77 ms",
        ] {
            assert!(parse_whisper_segments(quiet).is_empty(), "{quiet}");
            assert_eq!(extract_text(quiet), None, "{quiet}");
        }
    }

    // A spoken line whose timestamp we cannot read must not lose its TEXT: under
    // ADR-0018 the live transcript is the meeting's only output. It inherits the
    // previous segment's end, which keeps the window monotonic.
    #[test]
    fn parse_whisper_segments_never_drops_speech_over_an_unreadable_timecode() {
        let stdout = "[00:00:01.000 --> 00:00:02.000]   primeira fala\n\
            [??:?? --> ??:??]   fala com timecode ilegível\n";
        let segs = parse_whisper_segments(stdout);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[1].text, "fala com timecode ilegível");
        assert_eq!(segs[1].t_ms, 2_000);
        assert_eq!(segs[1].end_ms, 2_000);
    }

    #[test]
    fn wav_duration_ms_from_bytes_measures_from_actual_bytes() {
        // build a minimal canonical PCM WAV: 16kHz mono s16le => byte_rate 32000.
        // one second of audio = 32000 data bytes, regardless of the stored size.
        fn hdr(data_size_field: u32, data_bytes: usize) -> Vec<u8> {
            let mut v = Vec::new();
            v.extend_from_slice(b"RIFF");
            v.extend_from_slice(&(36u32 + data_bytes as u32).to_le_bytes());
            v.extend_from_slice(b"WAVE");
            v.extend_from_slice(b"fmt ");
            v.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
            v.extend_from_slice(&1u16.to_le_bytes()); // PCM
            v.extend_from_slice(&1u16.to_le_bytes()); // mono
            v.extend_from_slice(&16_000u32.to_le_bytes()); // sample rate
            v.extend_from_slice(&32_000u32.to_le_bytes()); // byte rate
            v.extend_from_slice(&2u16.to_le_bytes()); // block align
            v.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
            v.extend_from_slice(b"data");
            v.extend_from_slice(&data_size_field.to_le_bytes());
            v.extend(std::iter::repeat_n(0u8, data_bytes));
            v
        }
        // exactly 1s of audio, size field correct
        assert_eq!(wav_duration_ms_from_bytes(&hdr(32_000, 32_000)), Some(1000));
        // a streaming writer left a placeholder size (0) but wrote 0.5s of bytes:
        // we measure from the ACTUAL bytes, so we still get 500ms.
        assert_eq!(wav_duration_ms_from_bytes(&hdr(0, 16_000)), Some(500));
        // not a WAV
        assert_eq!(wav_duration_ms_from_bytes(b"not a wav at all"), None);
    }
}
