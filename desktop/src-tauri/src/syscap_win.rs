// Windows system-audio capture for meeting mode: WASAPI loopback on the default
// render endpoint (ADR-0033).
//
// Why a thread and not a sidecar like macOS: the Swift capturer is a separate
// process because ScreenCaptureKit leaves no choice. On Windows there is a
// choice, and the first Windows meeting attempt died at exactly the sidecar's
// weak point — "loro-syscap (program not found)", a binary that built fine and
// was never packaged. A thread cannot fail to be packaged.
//
// No permission prompt exists for loopback (unlike macOS Screen Recording), so
// the parent's exit-code-4 branch simply never fires here.
//
// Privacy (BR-1/BR-8): audio is written to the local WAV the caller named and
// nowhere else; logs carry counts and formats, never audio.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tracing::{info, warn};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
    WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED,
};

use crate::wav::{WavFmt, WavWriter, WAVE_FORMAT_IEEE_FLOAT, WAVE_FORMAT_PCM};

// WAVE_FORMAT_EXTENSIBLE and the IEEE-float subformat GUID live behind the
// Win32_Media_Multimedia feature, which we would otherwise pull in for two
// constants. They are fixed by the WAV format itself and cannot drift.
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;
const SUBTYPE_IEEE_FLOAT: windows::core::GUID =
    windows::core::GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);

// One second of shared-mode buffer, in 100ns units. Generous on purpose: the
// poll below runs every 10ms, so an overrun needs a 100x scheduling stall.
const BUFFER_DURATION_100NS: i64 = 10_000_000;
const POLL: Duration = Duration::from_millis(10);

pub struct Capture {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Capture {
    // Blocks until the capture thread has finalized the WAV header. The caller
    // hands that same WAV to ffmpeg on the next line, so returning before the
    // sizes are patched would hand over a file that reads as empty.
    pub fn stop(mut self) {
        self.join();
        info!("system audio capture stopped (wasapi loopback)");
    }

    fn join(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.join();
    }
}

// Start capturing to `out`. Returns once the endpoint is open and running, so a
// missing or disabled output device surfaces as an error the UI can show instead
// of a meeting that silently records nothing. The receiver carries the ADR-0025
// anchor (epoch ms of the WAV's own t=0).
pub fn start(out: &Path) -> Result<(Capture, Receiver<u64>), String> {
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = channel::<Result<(), String>>();
    let (anchor_tx, anchor_rx) = channel::<u64>();
    let path: PathBuf = out.to_path_buf();
    let thread_stop = Arc::clone(&stop);

    let handle = std::thread::Builder::new()
        .name("loro-syscap-wasapi".into())
        .spawn(move || {
            unsafe {
                // COM is per-thread; this thread owns its apartment.
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                run(&path, &thread_stop, &ready_tx, &anchor_tx);
                CoUninitialize();
            }
        })
        .map_err(|e| format!("err.capture_failed:thread ({e})"))?;

    // The thread reports the outcome of opening the endpoint exactly once.
    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => Ok((
            Capture {
                stop,
                handle: Some(handle),
            },
            anchor_rx,
        )),
        Ok(Err(e)) => {
            stop.store(true, Ordering::Relaxed);
            let _ = handle.join();
            Err(e)
        }
        Err(_) => {
            stop.store(true, Ordering::Relaxed);
            Err("err.capture_failed:timeout".into())
        }
    }
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// The sample geometry the endpoint is actually running at. Shared mode never
// converts, so this is the only format loopback will hand us.
unsafe fn mix_format(raw: *const WAVEFORMATEX) -> Result<WavFmt, String> {
    if raw.is_null() {
        return Err("err.capture_failed:format (null)".into());
    }
    let wf = *raw;
    // WAVE_FORMAT_EXTENSIBLE hides the real sample type in a subformat GUID; the
    // plain tags mean what they say. Guessing from bit depth alone would write a
    // float stream under a header claiming integer PCM, and ffmpeg would
    // faithfully mix the resulting noise into the meeting.
    let format_tag = if wf.wFormatTag == WAVE_FORMAT_EXTENSIBLE {
        // WAVEFORMATEXTENSIBLE is 1-byte packed, so the GUID field cannot be
        // borrowed at its natural alignment; read it out unaligned instead.
        let ext = raw as *const WAVEFORMATEXTENSIBLE;
        let sub = std::ptr::read_unaligned(std::ptr::addr_of!((*ext).SubFormat));
        if sub == SUBTYPE_IEEE_FLOAT {
            WAVE_FORMAT_IEEE_FLOAT
        } else {
            WAVE_FORMAT_PCM
        }
    } else {
        wf.wFormatTag
    };
    let fmt = WavFmt {
        sample_rate: wf.nSamplesPerSec,
        channels: wf.nChannels,
        bits_per_sample: wf.wBitsPerSample,
        format_tag,
    };
    if fmt.block_align() == 0 {
        return Err("err.capture_failed:format (zero block align)".into());
    }
    Ok(fmt)
}

unsafe fn open() -> Result<(IAudioClient, IAudioCaptureClient, WavFmt), String> {
    let enumerator: IMMDeviceEnumerator =
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|e| format!("err.capture_failed:enumerator ({e})"))?;
    // The default *render* endpoint: loopback taps what the machine plays.
    let device = enumerator
        .GetDefaultAudioEndpoint(eRender, eConsole)
        .map_err(|e| {
            warn!(error = %e, "no default render endpoint");
            "err.capture_no_output".to_string()
        })?;
    let client: IAudioClient = device
        .Activate(CLSCTX_ALL, None)
        .map_err(|e| format!("err.capture_failed:activate ({e})"))?;
    let raw: *mut WAVEFORMATEX = client
        .GetMixFormat()
        .map_err(|e| format!("err.capture_failed:format ({e})"))?;
    let fmt = match mix_format(raw) {
        Ok(f) => f,
        Err(e) => {
            CoTaskMemFree(Some(raw as *const _));
            return Err(e);
        }
    };
    let init = client.Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK,
        BUFFER_DURATION_100NS,
        0,
        raw,
        None,
    );
    CoTaskMemFree(Some(raw as *const _));
    init.map_err(|e| format!("err.capture_failed:init ({e})"))?;
    let capture: IAudioCaptureClient = client
        .GetService()
        .map_err(|e| format!("err.capture_failed:service ({e})"))?;
    Ok((client, capture, fmt))
}

unsafe fn run(
    out: &Path,
    stop: &AtomicBool,
    ready: &Sender<Result<(), String>>,
    anchor: &Sender<u64>,
) {
    let (client, capture, fmt) = match open() {
        Ok(v) => v,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let mut writer = match File::create(out)
        .map_err(|e| e.to_string())
        .and_then(|f| WavWriter::new(f, fmt).map_err(|e| e.to_string()))
    {
        Ok(w) => w,
        Err(e) => {
            let _ = ready.send(Err(format!("err.capture_failed:write ({e})")));
            return;
        }
    };
    if let Err(e) = client.Start() {
        let _ = ready.send(Err(format!("err.capture_failed:start ({e})")));
        return;
    }
    // ADR-0025: t=0 of this WAV. Unlike the macOS sidecar we can report it at
    // Start() instead of at the first buffer, because the silence padding below
    // makes frame 0 correspond to THIS instant even when nothing is playing yet.
    // The sidecar has to wait for a buffer, and a silent machine delays it.
    let t0 = Instant::now();
    let _ = anchor.send(epoch_millis());
    let _ = ready.send(Ok(()));
    info!(
        rate = fmt.sample_rate,
        ch = fmt.channels,
        bits = fmt.bits_per_sample,
        "system audio capture started (wasapi loopback)"
    );

    let mut failure: Option<String> = None;
    'outer: while !stop.load(Ordering::Relaxed) {
        let mut packet = match capture.GetNextPacketSize() {
            Ok(n) => n,
            Err(e) => {
                failure = Some(format!("packet size: {e}"));
                break;
            }
        };
        if packet == 0 {
            // Keeps the file in lockstep with wall time. Measured on a normal
            // desktop session this pad is nearly idle: a 3s capture came out
            // 2.999s with it and 2.990s without, because the endpoint was
            // already handing over silent packets. It is here for the case where
            // NO process holds a render stream and loopback goes quiet instead
            // of silent — the WAV would then be shorter than wall time and every
            // word after the gap would land early against the mic track, the same
            // skew ADR-0025 removed. NOT reproduced on this machine, so it is a
            // guard and not a fix for an observed bug. It cannot make things
            // worse: it only ever appends, never truncates.
            let expected = (t0.elapsed().as_secs_f64() * fmt.sample_rate as f64) as u32;
            let have = writer.frames_written();
            if expected > have {
                if let Err(e) = writer.write_silence(expected - have) {
                    failure = Some(format!("silence: {e}"));
                    break;
                }
            }
            std::thread::sleep(POLL);
            continue;
        }
        while packet != 0 {
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            if let Err(e) = capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None) {
                failure = Some(format!("get buffer: {e}"));
                break 'outer;
            }
            let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null();
            let write = if silent {
                writer.write_silence(frames)
            } else {
                let len = frames as usize * fmt.block_align() as usize;
                writer.write_frames(std::slice::from_raw_parts(data, len))
            };
            // Released before the error check on purpose: a write failure must
            // not also leak the endpoint's buffer.
            let _ = capture.ReleaseBuffer(frames);
            if let Err(e) = write {
                failure = Some(format!("write: {e}"));
                break 'outer;
            }
            packet = capture.GetNextPacketSize().unwrap_or(0);
        }
    }

    let _ = client.Stop();
    let frames = writer.frames_written();
    match writer.finalize() {
        Ok(_) => info!(frames, "system audio capture finalized"),
        Err(e) => warn!(error = %e, "failed to finalize capture wav"),
    }
    if let Some(e) = failure {
        warn!(error = %e, "system audio capture ended early");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Needs a real audio endpoint, so it is #[ignore]d: a CI runner has none and
    // a test that cannot run there must not pretend to. Run it by hand with
    //   cargo test --lib syscap_win -- --ignored --nocapture
    // It is the only witness for the two claims the unit tests cannot make: that
    // the endpoint opens at all, and that an IDLE endpoint still produces a WAV
    // as long as wall time (the silence padding).
    #[test]
    #[ignore]
    fn captures_wall_time_even_with_nothing_playing() {
        let out = std::env::temp_dir().join("loro-syscap-probe.wav");
        let _ = std::fs::remove_file(&out);
        let (capture, anchor) = start(&out).expect("open default render endpoint");
        let epoch = anchor
            .recv_timeout(Duration::from_millis(500))
            .expect("anchor reported at Start()");
        std::thread::sleep(Duration::from_secs(3));
        capture.stop();

        let bytes = std::fs::read(&out).expect("wav written");
        assert_eq!(&bytes[0..4], b"RIFF");
        let data_len = u32::from_le_bytes(bytes[40..44].try_into().unwrap());
        assert!(data_len > 0, "header still claims an empty data chunk");
        let rate = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
        let block = u16::from_le_bytes(bytes[32..34].try_into().unwrap()) as u32;
        let seconds = data_len as f64 / (rate * block) as f64;
        println!("epoch={epoch} rate={rate} block={block} seconds={seconds:.3}");
        assert!(
            (2.7..3.6).contains(&seconds),
            "captured {seconds:.3}s of a 3s window — the file drifted from wall time"
        );
    }
}
