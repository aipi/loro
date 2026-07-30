// Loro backend (Tauri). Spawns the system whisper-stream and streams its output
// to the UI via events. Nothing (audio/text) leaves the machine.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Deserialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tracing::{error, info};

mod paths;
use paths::*;
mod config;
use config::*;
mod templates;
use templates::*;
mod presets;
use presets::*;
mod git;
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
        std::process::Command::new("curl")
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
    // any model just so the binary starts; killed as soon as the list is read
    let model = model_path("small");
    let model = if model.exists() {
        model
    } else {
        model_path("large-v3-turbo")
    };
    let mut child = Command::new(&bin)
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

// extracts the text from whisper-stream lines: "[hh:mm --> hh:mm]   text"
fn extract_text(line: &str) -> Option<String> {
    if !line.contains("-->") {
        return None;
    }
    let idx = line.find(']')?;
    let t = line[idx + 1..].trim();
    if t.is_empty() || t == "[Start speaking]" {
        return None;
    }
    Some(t.to_string())
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
    let model = model_path(&cfg.model);
    if !model.exists() {
        error!(model = %model.display(), "model not found");
        return Err(format!("err.model_not_found:{}", model.display()));
    }
    let threads = cfg.threads.unwrap_or(8).to_string();

    let args = stream_args(
        &model.to_string_lossy(),
        &cfg.lang,
        cfg.translate,
        &threads,
        cfg.capture,
    );
    let mut command = Command::new(&bin);
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
    let model = model_path(&cfg.model);
    if !model.exists() {
        error!(model = %model.display(), "model not found");
        return Err(format!("err.model_not_found:{}", model.display()));
    }
    let Some(ffmpeg) = which("ffmpeg") else {
        return Err("err.ffmpeg_not_found".into());
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
    let out = Command::new(ffmpeg)
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
    let mut child = Command::new(cli)
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

// Parse a whisper-cli stdout blob into segment texts, reusing the SAME
// `extract_text` parser as the live/file paths (no divergent parsing).
fn parse_whisper_lines(stdout: &str) -> Vec<String> {
    stdout.lines().filter_map(extract_text).collect()
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

// Transcribe just the window [from_ms, to_ms] of an already-16k-or-any WAV and
// RETURN the segment texts (no global event). The caller owns any overlap
// (~1.5s) and the offset bookkeeping. Additive sibling of transcribe_wav.
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
) -> Result<Vec<String>, String> {
    let dst = src.with_file_name(format!(".window-{from_ms}.wav"));
    let carve = Command::new(ffmpeg)
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
    let out = Command::new(cli)
        .args(&args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&dst);
    let out = out?;
    if !out.status.success() {
        return Err("err.whisper_cli_failed".into());
    }
    Ok(parse_whisper_lines(&String::from_utf8_lossy(&out.stdout)))
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
    let mut cmd = Command::new(ffmpeg);
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

fn epoch_millis() -> u128 {
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

// Core of the sidecar start, callable from meeting.rs (ADR-0010) as a plain
// pub(crate) fn — the #[tauri::command] wrapper cannot be reused directly.
pub(crate) fn system_capture_start(app: &AppHandle, state: &AppState) -> Result<String, String> {
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

    let mut child = Command::new(&bin)
        .arg(&out)
        .stdin(Stdio::piped()) // closing this stdin later signals a clean stop
        .stdout(Stdio::null())
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
    let model = model_path(&cfg.model);
    if !model.exists() {
        error!(model = %model.display(), "model not found");
        return Err(format!("err.model_not_found:{}", model.display()));
    }
    let Some(ffmpeg) = which("ffmpeg") else {
        return Err("err.ffmpeg_not_found".into());
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
    let d = base.join("contextos").join(name);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let ch = d.join("CHANGELOG.md");
    if !ch.exists() {
        let body = if lang == "en" {
            format!("# {name} — CHANGELOG\n\n> Dated history of this context's knowledge (append-only; the loop never rewrites prior entries).\n")
        } else {
            format!("# {name} — CHANGELOG\n\n> Registro cronológico do conhecimento deste contexto, escrito como documentação.\n> O loop apenas acrescenta entradas datadas; nunca reescreve as anteriores.\n")
        };
        std::fs::write(&ch, body).map_err(|e| e.to_string())?;
    }
    // Non-destructive: only seed context.md when neither the new nor the legacy
    // knowledge file exists (an already-populated context is never overwritten).
    if context_file(&d).is_none() {
        std::fs::write(d.join("context.md"), context_md(name, lang, mold))
            .map_err(|e| e.to_string())?;
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

// Contexts derived from disk. A directory under contextos/ is a CONTEXT when it
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
    walk(&base.join("contextos"), "", 1, &mut out);
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
fn ensure_acervo_structure(
    base: &Path,
    ctxs: &[String],
    lang: &str,
    tpl: Option<&TemplateContent>,
) -> Result<(), String> {
    // First setup = no loop state yet. The queue guide (inbox/_prompt.md) is
    // consumed by the loop, so re-materializations must never re-inject it.
    let first_setup = !base.join(".brain/state.json").exists();
    for sub in [
        "inbox",
        "processed",
        "reunioes",
        "notas",
        ".brain",
        "contextos",
        ".claude/commands",
    ] {
        std::fs::create_dir_all(base.join(sub)).map_err(|e| e.to_string())?;
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
    ] {
        let p = base.join(rel);
        if !p.exists() {
            std::fs::write(&p, body).map_err(|e| e.to_string())?;
        }
    }
    // Vertical extra skills from the usage template (ADR-0003), after the four
    // standard ones and equally non-destructive.
    if let Some(tpl) = tpl {
        for (name, body) in &tpl.skills {
            let p = base.join(".claude/commands").join(name);
            if !p.exists() {
                std::fs::write(&p, body).map_err(|e| e.to_string())?;
            }
        }
        if first_setup {
            if let Some(prompt) = &tpl.inbox_prompt {
                let p = base.join("inbox/_prompt.md");
                if !p.exists() {
                    std::fs::write(&p, prompt).map_err(|e| e.to_string())?;
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
        std::fs::write(&state, "{\"processed\":[]}\n").map_err(|e| e.to_string())?;
    }
    let act = base.join(".brain/activity.log");
    if !act.exists() {
        std::fs::write(&act, "").map_err(|e| e.to_string())?;
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
        std::fs::write(&agents, body).map_err(|e| e.to_string())?;
    }
    let index = base.join("INDEX.md");
    if !index.exists() {
        let body = if lang == "en" {
            "# Base index\n\n_The loop fills this index on each run._\n"
        } else {
            "# Índice do acervo\n\n_O loop preenche este índice a cada processamento._\n"
        };
        std::fs::write(&index, body).map_err(|e| e.to_string())?;
    }
    // Collaboration scaffolding (opt-in): CODEOWNERS defines who approves each
    // context; the PR template is the RFC body. Non-destructive — never touch an
    // existing CODEOWNERS/template (users curate owners by hand).
    std::fs::create_dir_all(base.join(".github")).map_err(|e| e.to_string())?;
    let codeowners = base.join(".github/CODEOWNERS");
    if !codeowners.exists() {
        std::fs::write(&codeowners, codeowners_template(ctxs, lang)).map_err(|e| e.to_string())?;
    }
    let pr_tmpl = base.join(".github/pull_request_template.md");
    if !pr_tmpl.exists() {
        std::fs::write(&pr_tmpl, pr_template(lang)).map_err(|e| e.to_string())?;
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

#[tauri::command]
#[allow(clippy::too_many_arguments)] // mirrors the wizard form 1:1 (IPC contract)
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
) -> Result<AcervosView, String> {
    let dir = if dir.trim().is_empty() {
        default_brain_dir().display().to_string()
    } else {
        dir.trim().to_string()
    };
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
    let id = if let Some(a) = cfg.acervos.iter_mut().find(|a| a.dir == dir) {
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

// Pure, testable core: delete a context/folder dir under contextos/.
fn delete_context_dir(base: &Path, name: &str) -> Result<(), String> {
    if !valid_context(name) {
        return Err("err.invalid_name".into());
    }
    let src = base.join("contextos").join(name);
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

// Pure, testable core: rename/move a context dir within contextos/.
fn rename_context_dir(base: &Path, from: &str, to: &str) -> Result<(), String> {
    let to = to.trim().to_lowercase().replace(' ', "-");
    if !valid_context(from) || !valid_context(&to) {
        return Err("err.invalid_context_name".into());
    }
    if from == to {
        return Ok(());
    }
    let root = base.join("contextos");
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
    let src = PathBuf::from(&active).join("contextos").join(&name);
    if !src.is_dir() {
        return Err("err.context_not_found".into());
    }
    let leaf = name.rsplit('/').next().unwrap_or(&name);
    let dest = PathBuf::from(&target).join("contextos").join(leaf);
    if dest.exists() {
        return Err("err.context_exists_in_target".into());
    }
    std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::rename(&src, &dest).map_err(|e| e.to_string())
}

// macOS: opens Audio MIDI Setup (Multi-Output Device is created by the user)
#[tauri::command]
fn open_audio_midi() -> Result<(), String> {
    Command::new("open")
        .args(["-a", "Audio MIDI Setup"])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// ---- git/GitHub environment doctor + collaboration commands ----------------
// Thin Tauri wrappers over git.rs. Opt-in: `versioning_enabled` gates the remote
// flow (Versionar/Propor). Nothing here stores credentials — the doctor is a
// validator/proxy that only reports readiness and public metadata.

// minimum tool versions we treat as "up to date" without hitting the network
// (privacy-first): a conservative floor that only flags genuinely old builds.
const GIT_FLOOR: (u32, u32) = (2, 20);
const GH_FLOOR: (u32, u32) = (2, 0);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Check {
    ok: bool,
    detail: String,
    hint: String,
    fixable: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvDoctor {
    git: Check,
    gh: Check,
    gh_auth: Check,
    git_identity: Check,
    remote: Check,
    versioning_enabled: bool,
    account: Option<String>,
    protocol: Option<String>,
}

// Validate the git/gh environment. Never asks for or stores secrets: reads only
// booleans, versions and the public login.
#[tauri::command]
fn env_doctor() -> EnvDoctor {
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
    let access = authed
        && base
            .as_ref()
            .map(|b| gh_repo_accessible(b))
            .unwrap_or(false);
    let remote = Check {
        ok: remote_url.is_some() && access,
        detail: remote_url.clone().unwrap_or_default(),
        hint: if remote_url.is_none() {
            "err.git_remote_required".into()
        } else if !access {
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
        identity = git_identity.ok, remote = remote.ok, versioning_enabled,
        "env checks"
    );
    EnvDoctor {
        git,
        gh,
        gh_auth,
        git_identity,
        remote,
        versioning_enabled,
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
// it to one knowledge file (e.g. "contextos/frota/context.md"); None = the acervo.
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionOutcome {
    branch: String,
    result: String,
    warn: Option<String>,
}

// Sync outcomes the user should see as a warning (the flow still proceeds —
// branch-first degrades, ADR-0002 §2). NoRemote is the pure-local case: no warn.
fn sync_warn(outcome: &SyncOutcome) -> Option<String> {
    match outcome {
        SyncOutcome::Offline => Some("err.git_offline".into()),
        SyncOutcome::Diverged => Some("err.main_diverged".into()),
        _ => None,
    }
}

// "Versionar": sync the default branch (best effort), create rfc/<slug> off it
// and commit the working changes there. Local git only on the write path.
#[tauri::command]
fn brain_version(slug: String, message: String) -> Result<VersionOutcome, String> {
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    let base = PathBuf::from(&cfg.brain_dir);
    let slug = sanitize_slug(&slug)?;
    let warn = sync_warn(&sync_default_branch(&base));
    let branch = create_branch(&base, &slug)?;
    let result = stage_and_commit(&base, message)?;
    Ok(VersionOutcome {
        branch,
        result,
        warn,
    })
}

// ---- branch-first IPC (ADR-0002 §2): list / switch / create ----------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BranchesInfo {
    current: Option<String>,
    default: String,
    branches: Vec<String>,
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
    Ok(BranchesInfo {
        current: current_branch(&base),
        default: local_default_branch(&base),
        branches: list_branches(&base)?,
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
        let out = Command::new("git")
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

    // ADR-0013: rename the legacy non-versioned world before folding incubadora, so
    // both land in the new brainstorming/ tree.
    rename_personal_world(base, apply, &mut report.renamed_world)?;

    for c in &ctxs {
        let cdir = base.join("contextos").join(c);
        let guia = cdir.join("guia.md");
        let ctx = cdir.join("context.md");
        if guia.is_file() && ctx.is_file() {
            report.conflicts.push(c.clone());
        } else if guia.is_file() {
            report.renamed.push(c.clone());
            if apply {
                migrate_rename(
                    base,
                    &format!("contextos/{c}/guia.md"),
                    &format!("contextos/{c}/context.md"),
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
    // on disk; a later commit simply untracks brainstorming/); notas/ is left
    // versioned and untouched. Reports every planned move; never deletes.
    fold_incubadora(base, apply, &mut report.incubated)?;

    if apply {
        ensure_gitignore(base)?;
    }
    Ok(report)
}

// ADR-0013: rename the legacy non-versioned world pessoal/ -> brainstorming/.
// pessoal/temas/<slug> -> brainstorming/<slug> (and tema.md -> indice.md);
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
        // tema.md -> indice.md inside each migrated brainstorming
        if let Ok(rd) = std::fs::read_dir(&target) {
            for e in rd.flatten().filter(|e| e.path().is_dir()) {
                let old = e.path().join("tema.md");
                let new = e.path().join("indice.md");
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
    if target == active && ctx.is_none() {
        return Err("err.choose_destination".into());
    }
    let src = PathBuf::from(&active).join("inbox").join(&name);
    if !src.is_file() {
        return Err("err.not_in_queue".into());
    }
    let tdir = PathBuf::from(&target).join("inbox");
    std::fs::create_dir_all(&tdir).map_err(|e| e.to_string())?;
    let fname = match ctx {
        Some(c) if valid_context(&c) => format!("{}--{}", c.replace('/', "-"), name),
        Some(_) => return Err("err.invalid_context".into()),
        None => name.clone(),
    };
    std::fs::rename(&src, tdir.join(fname)).map_err(|e| e.to_string())
}

// Move any acervo file into a context's `referencias/` (or to `notas/` when no
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
        base.join("notas")
    } else {
        if !valid_context(dc) {
            return Err("err.invalid_context".into());
        }
        base.join("contextos").join(dc).join("referencias")
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
    if name.contains('/') || name.contains("..") || name.starts_with('.') || name.is_empty() {
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

// safe queue filename (no path separators / traversal), text only
fn valid_inbox_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.contains('/')
        && !name.contains("..")
        && (name.ends_with(".md") || name.ends_with(".txt"))
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

// ADR-0013: the fila (inbox/) is THE path brainstorming -> contexto. Copy an
// existing report (or any acervo text file) into the queue, steered to a target
// context via the `<contexto>--<nome>` prefix the /loro-context loop reads. The
// report stays in the brainstorming; only a copy enters the queue. Path-guarded to
// the acervo root; contexts with '/' collapse to '-' so the queue name stays flat.
#[tauri::command]
fn brain_send_report_to_queue(
    report_rel: String,
    dest_context: Option<String>,
) -> Result<String, String> {
    let rel = report_rel.replace('\\', "/");
    if !(rel.ends_with(".md") || rel.ends_with(".txt")) {
        return Err("err.queue_text_only".into());
    }
    if let Some(c) = dest_context.as_deref() {
        if !c.is_empty() && !valid_context(c) {
            return Err(format!("err.invalid_context:{c}"));
        }
    }
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    let base = PathBuf::from(&cfg.brain_dir)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let src = base
        .join(&rel)
        .canonicalize()
        .map_err(|_| "err.report_not_found".to_string())?;
    if !src.starts_with(&base) || !src.is_file() {
        return Err("err.report_outside_acervo".into());
    }
    let content = std::fs::read_to_string(&src).map_err(|e| e.to_string())?;
    let basename = src
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("relatorio.md");
    let ctx = dest_context
        .as_deref()
        .filter(|c| !c.is_empty())
        .map(|c| c.replace('/', "-"));
    let name = import_name(ctx.as_deref(), basename);
    if !valid_inbox_name(&name) {
        return Err("err.invalid_queue_name".into());
    }
    let inbox = base.join("inbox");
    std::fs::create_dir_all(&inbox).map_err(|e| e.to_string())?;
    std::fs::write(inbox.join(&name), content).map_err(|e| e.to_string())?;
    Ok(name)
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
    // ADR-0009 write guard: meeting transcript/audit/audio never enters contextos/.
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
            if name.starts_with('.') {
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
    if rel.starts_with("contextos/") {
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
#[tauri::command]
fn brain_read_guide() -> String {
    read_brain_config()
        .and_then(|cfg| {
            std::fs::read_to_string(PathBuf::from(cfg.brain_dir).join("inbox/_prompt.md")).ok()
        })
        .unwrap_or_default()
}

#[tauri::command]
fn brain_write_guide(content: String) -> Result<(), String> {
    let cfg = read_brain_config().ok_or("acervo not configured")?;
    let dir = PathBuf::from(&cfg.brain_dir).join("inbox");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join("_prompt.md");
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
    reunioes: Vec<BrainFile>,
    notas: Vec<BrainFile>,
    incubadora: Vec<BrainFile>,
    activity: String,
}

fn list_files(base: &Path, sub: &str) -> Vec<BrainFile> {
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

#[tauri::command]
fn brain_status() -> BrainStatus {
    let Some(cfg) = read_brain_config() else {
        return BrainStatus {
            configured: false,
            dir: String::new(),
            contexts: vec![],
            inbox: vec![],
            processed: 0,
            reunioes: vec![],
            notas: vec![],
            incubadora: vec![],
            activity: String::new(),
        };
    };
    let base = PathBuf::from(&cfg.brain_dir);
    let contexts = list_contexts(&base)
        .iter()
        .map(|c| {
            let cdir = base.join("contextos").join(c);
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
    BrainStatus {
        configured: true,
        dir: cfg.brain_dir.clone(),
        contexts,
        inbox: list_files_filtered(&base, "inbox", false),
        processed: list_files_filtered(&base, "processed", false).len(),
        reunioes: list_files(&base, "reunioes"),
        notas: list_files(&base, "notas"),
        incubadora: incub,
        activity,
    }
}

// imported filename: the "<contexto>--" prefix steers the loop
fn import_name(context: Option<&str>, filename: &str) -> String {
    match context {
        Some(c) if !c.is_empty() => format!("{c}--{filename}"),
        _ => filename.to_string(),
    }
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
    std::fs::create_dir_all(&inbox).map_err(|e| e.to_string())?;
    let mut n = 0;
    for f in files {
        let src = PathBuf::from(f.to_string());
        let Some(name) = src.file_name().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        let dest = inbox.join(import_name(context.as_deref(), &name));
        std::fs::copy(&src, &dest).map_err(|e| format!("{name}: {e}"))?;
        n += 1;
    }
    Ok(n)
}

// ADR-0005: import files from the computer straight into an anexos/ folder —
// a brainstorming's OR a context's (owner request: "no contexto ... consiga
// add a partir do computador"). Mirrors brain_import, but the destination is
// an anexos/ folder (not the inbox), filenames are kept as-is (anexos are
// arbitrary files — pdf/xlsx/images), and collisions get a numeric suffix
// instead of clobbering. dest_rel is guarded by guarded_anexos_dir (only a
// normalized brainstorming/contextos anexos path is accepted).
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
        let mut dest = dir.join(&name);
        if dest.exists() {
            let stem = std::path::Path::new(&name)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| name.clone());
            let ext = std::path::Path::new(&name)
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            let mut i = 2;
            loop {
                let cand = dir.join(format!("{stem}-{i}{ext}"));
                if !cand.exists() {
                    dest = cand;
                    break;
                }
                i += 1;
            }
        }
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
    std::fs::create_dir_all(&inbox).map_err(|e| e.to_string())?;
    let mut n = 0;
    for p in paths {
        let src = PathBuf::from(&p);
        if !src.is_file() {
            continue;
        }
        let Some(name) = src.file_name().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        let dest = inbox.join(import_name(context.as_deref(), &name));
        std::fs::copy(&src, &dest).map_err(|e| format!("{name}: {e}"))?;
        n += 1;
    }
    Ok(n)
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
        let output = Command::new("bash")
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
    ] {
        let p = base.join(rel);
        if !p.exists() {
            let _ = std::fs::write(&p, body);
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
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    let _ = apph.emit("term-exit", ());
                    break;
                }
                Ok(n) => {
                    let _ = apph.emit(
                        "term-output",
                        String::from_utf8_lossy(&buf[..n]).to_string(),
                    );
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
                // `ps -axo comm=` may print the full executable path on macOS
                let base = comm.rsplit('/').next().unwrap_or(comm);
                if base == name {
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
    let agent_running = Command::new("ps")
        .args(["-axo", "pid=,ppid=,comm="])
        .output()
        .ok()
        .map(|o| {
            has_descendant_process(
                &parse_ps_table(&String::from_utf8_lossy(&o.stdout)),
                root,
                &agent_name,
            )
        })
        .unwrap_or(false);
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
            auto_save,
            list_capture_devices,
            ui_get_lang,
            ui_set_lang,
            brain_get_config,
            brain_setup,
            brain_list_acervos,
            brain_set_auto_context,
            brain_list_templates,
            brain_duplicate_template,
            brain_set_active,
            brain_set_color,
            brain_remove_acervo,
            brain_add_context,
            brain_rename_context,
            brain_move_context_to_acervo,
            open_audio_midi,
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
            brain_send_report_to_queue,
            brain_brainstorm_build_report,
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
            brain_promote,
            brain_meeting_start,
            brain_meeting_stop,
            brain_meeting_append,
            brain_meeting_write_artifact,
            brain_meeting_marker,
            brain_meeting_set_consent,
            brain_meeting_manifest,
            brain_meeting_rename,
            brain_meeting_build_notebook,
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

    // ADR-0002 §4 — the terminal/Claude readiness handshake asks the OS whether
    // a `claude` process lives under the PTY shell, instead of guessing from
    // terminal output.
    #[test]
    fn ps_table_parses_and_finds_descendant_by_name() {
        let table = parse_ps_table(
            "  1     0  launchd\n 300     1  zsh\n 412   300  claude\n 500   412  node\n 600     1  zsh\n",
        );
        assert!(has_descendant_process(&table, 300, "claude"));
        assert!(!has_descendant_process(&table, 600, "claude"));
        // the root itself does not count as its own descendant match
        assert!(!has_descendant_process(&table, 412, "zsh"));
        // grandchildren are found too
        assert!(has_descendant_process(&table, 300, "node"));
        // malformed lines are skipped, not fatal
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
    fn pty_opens_spawns_and_exits() {
        // exercises the same path as term_open (openpty + spawn + reader + writer)
        // without a blocking read: proves the portable-pty stack works on this machine.
        let sys = portable_pty::native_pty_system();
        let pair = sys
            .openpty(portable_pty::PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = portable_pty::CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "exit 0"]);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let _reader = pair.master.try_clone_reader().unwrap();
        let _writer = pair.master.take_writer().unwrap();
        let status = child.wait().unwrap();
        assert!(status.success());
    }

    #[test]
    fn list_all_indexes_text_and_skips_git_and_large() {
        // ADR-0008 flat quick-open index: every text-ish file by full rel path,
        // skipping hidden dirs (.git) and oversized/binary files.
        let root = std::env::temp_dir().join(format!("loro-la-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("contextos/a")).unwrap();
        std::fs::create_dir_all(root.join("pessoal/temas/x")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("contextos/a/context.md"), "# a").unwrap();
        std::fs::write(root.join("pessoal/temas/x/nota.md"), "nota").unwrap();
        std::fs::write(root.join(".git/config"), "[core]\n").unwrap();
        // oversized image (>512KB): allowed extension but skipped by the size guard
        std::fs::write(root.join("big.png"), vec![0u8; 600 * 1024]).unwrap();

        let hits = list_all_in(&root);
        let rels: Vec<&str> = hits.iter().map(|h| h.rel.as_str()).collect();
        assert!(rels.contains(&"contextos/a/context.md"));
        assert!(rels.contains(&"pessoal/temas/x/nota.md"));
        assert_eq!(
            hits.len(),
            2,
            "only the two .md files; no .git, no large image"
        );

        let ctx = hits
            .iter()
            .find(|h| h.rel == "contextos/a/context.md")
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
            let d = root.join("contextos").join(c);
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
            let d = root.join("contextos").join(c);
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
        assert!(!root.join("contextos/frota").exists());
        assert!(root.join("contextos/operacoes/frota/guia.md").is_file());
        // renames a whole FOLDER (the subtree follows)
        rename_context_dir(&root, "engenharia", "eng").unwrap();
        assert!(root.join("contextos/eng/frontend/guia.md").is_file());
        // a collision is refused
        std::fs::create_dir_all(root.join("contextos/frota2")).unwrap();
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
        assert!(!root.join("contextos/frota").exists());
        // whole folder (with subcontexts)
        delete_context_dir(&root, "engenharia").unwrap();
        assert!(!root.join("contextos/engenharia").exists());
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
        assert!(co.contains("# /contextos/frota/    @owner"));
        assert!(co.contains("# /contextos/engenharia/frontend/    @owner"));
        assert!(co.contains("CODEOWNERS"));
    }

    #[test]
    fn seeding_uses_context_md_and_collaboration_without_brainstorming() {
        let root = std::env::temp_dir().join(format!("loro-seed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        ensure_acervo_structure(&root, &["frota".into()], "pt", None).unwrap();
        // the official source of truth is context.md; no guia.md nor brainstorming/
        assert!(root.join("contextos/frota/context.md").is_file());
        assert!(!root.join("contextos/frota/guia.md").exists());
        assert!(!root.join("contextos/frota/brainstorming").exists());
        // collaboration scaffolding
        assert!(root.join(".github/CODEOWNERS").is_file());
        assert!(root.join(".github/pull_request_template.md").is_file());
        // idempotent and non-destructive: running again does not break
        ensure_acervo_structure(&root, &["frota".into()], "pt", None).unwrap();
        let _ = std::fs::remove_dir_all(&root);
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
        let ctx = std::fs::read_to_string(root.join("contextos/contas/context.md")).unwrap();
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
        let d = root.join("contextos/frota");
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
        // notas/ stays versioned; nothing is ever deleted.
        let root = std::env::temp_dir().join(format!("loro-inc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("incubadora/ideia-a")).unwrap();
        std::fs::create_dir_all(root.join("notas")).unwrap();
        std::fs::write(root.join("incubadora/ideia-a/nota.md"), "rascunho").unwrap();
        std::fs::write(root.join("notas/mantida.md"), "versionada").unwrap();

        // dry-run: lists the planned move, changes nothing
        let r = migrate_acervo(&root, false, "pt").unwrap();
        assert!(r
            .incubated
            .iter()
            .any(|s| s.contains("incubadora/ideia-a/nota.md -> brainstorming/incubadora")));
        assert!(!root
            .join("brainstorming/incubadora/ideia-a/nota.md")
            .exists());

        // apply: copies into brainstorming/, leaves the legacy original AND notas/ intact
        let r = migrate_acervo(&root, true, "pt").unwrap();
        assert_eq!(r.incubated.len(), 1);
        assert!(root
            .join("brainstorming/incubadora/ideia-a/nota.md")
            .is_file());
        assert!(root.join("incubadora/ideia-a/nota.md").is_file()); // non-destructive
        assert!(root.join("notas/mantida.md").is_file()); // notas/ stays

        // idempotent: the destination already exists → nothing to fold
        let r = migrate_acervo(&root, true, "pt").unwrap();
        assert!(r.incubated.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migration_renames_pessoal_to_brainstorming_non_destructively() {
        // ADR-0013: pessoal/temas/<slug> -> brainstorming/<slug>, tema.md -> indice.md;
        // dry-run changes nothing; a conflict (both worlds) moves nothing.
        let root = std::env::temp_dir().join(format!("loro-rw-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("pessoal/temas/frota/reunioes/r1")).unwrap();
        std::fs::create_dir_all(root.join("pessoal/avulso")).unwrap();
        std::fs::write(root.join("pessoal/temas/frota/tema.md"), "# Frota").unwrap();
        std::fs::write(
            root.join("pessoal/temas/frota/reunioes/r1/reuniao.md"),
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

        // apply: renamed on disk, tema.md -> indice.md, legacy pessoal/ gone
        migrate_acervo(&root, true, "pt").unwrap();
        assert!(root.join("brainstorming/frota/indice.md").is_file());
        assert!(!root.join("brainstorming/frota/tema.md").exists());
        assert!(root
            .join("brainstorming/frota/reunioes/r1/reuniao.md")
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
        assert_eq!(
            std::fs::read_to_string(root.join("brainstorming/y/indice.md")).unwrap(),
            "novo"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn seed_context_never_overwrites_legacy_guia() {
        let root = std::env::temp_dir().join(format!("loro-legacy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let d = root.join("contextos/frota");
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
            let d = root.join("contextos").join(c);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("guia.md"), "x").unwrap();
        }
        // HAND-MADE folder without guia.md: must be mapped as a (leaf) context
        std::fs::create_dir_all(root.join("contextos/vendas")).unwrap();
        // a utility subfolder does NOT become a context
        std::fs::create_dir_all(root.join("contextos/frota/brainstorming")).unwrap();
        // hidden/reserved folder is ignored
        let arch = root.join("contextos/_arquivados/velho");
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

    #[test]
    fn parse_whisper_lines_uses_the_shared_parser() {
        // a whisper-cli stdout fixture: two spoken lines + noise the parser drops
        let stdout = "### START | t0 = 0 ms\n\
            [00:00:00.000 --> 00:00:02.000]   Bom dia a todos\n\
            [00:00:02.000 --> 00:00:03.000]   [Start speaking]\n\
            [00:00:03.000 --> 00:00:05.000]   vamos revisar os custos\n\
            linha sem timestamp\n";
        let segs = parse_whisper_lines(stdout);
        assert_eq!(segs, vec!["Bom dia a todos", "vamos revisar os custos"]);
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
