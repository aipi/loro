# ADR-0039 — The meeting microphone is captured by the sidecar, not by the webview (macOS)

- **Status:** accepted, implemented 2026-11-18 (PR pending owner verification in a real call). macOS only.
- **Extends:** ADR-0005 (the ScreenCaptureKit sidecar), ADR-0012 (live pseudo-stream),
  ADR-0022 §19/§24/§24b (pause, raw mic constraints, `meetingMic`), ADR-0025 (per-segment
  anchors, cross-track attribution), ADR-0038 (recorded workday).
- **Amends:** ADR-0022 §24 — on macOS, `micEchoCancel` no longer applies (see §4).
- **Revokes:** nothing. The getUserMedia path stays, for Windows.

## Context

Owner report, 2026-11-18, v0.18.0, macOS 26.7 (Apple Silicon): while Loro recorded a meeting
— notably a "dia gravado" hour (ADR-0038) that started by itself while a Google Meet call in
Chrome was already using the microphone — the people on the call heard the owner **extremely
low**. It happened with `micEchoCancel` both on and off. Manual recordings started before or at
the start of a call (v0.17) had no complaints.

### What was measured, and what was not

| Claim | Status |
|---|---|
| `loro.log.2026-11-18`: the 19:00:10Z workday hour started the system sidecar at 19:00:10Z, but `audio meter active` (the webview `getUserMedia` resolving) only at **19:04:18Z** — the mic opened four minutes into an ongoing call | measured (log) |
| Default input device volume on the owner's machine right after the incident: **27/100** (`osascript -e "input volume of (get volume settings)"`) | measured; the cause of that value is **not** known |
| WebKit (trunk, `Source/WebCore/platform/mediastream/cocoa/CoreAudioCaptureSource.cpp` and `CoreAudioCaptureUnit.cpp`): with `echoCancellation: true` the capture unit is `kAudioUnitSubType_VoiceProcessingIO` and WebKit sets `kAUVoiceIOProperty_OtherAudioDuckingConfiguration`; with `echoCancellation: false` macOS gets a separate non-VPIO unit (`createNonVPIOUnit` → `kAudioUnitSubType_HALOutput`) | read in source; **which WebKit build ships in macOS 26.7 was not verified** |
| The working hypothesis "WebKit uses VPIO regardless of the constraint" | **not supported** by the trunk source above for the `micEchoCancel: false` case. With it on, VPIO (and ducking) is confirmed by source |
| That opening the mic in Loro mid-call lowers what Meet sends (VPIO side effect, AGC moving the device's input volume, or something else) | **assumed, not reproduced**. No unified-log records survived for the incident window |

So the fix below removes Loro's microphone from WebKit entirely — the one capture path Loro does
not control — and opens the device in the most passive way available. It is a mitigation built
on a partly-confirmed diagnosis; the owner's real-call test is the measurement that settles it.

## Decision

### 1. On macOS the sidecar records the microphone

`loro-syscap <system.wav> --mic <mic.wav>`. The microphone is captured with an
**`AVAudioEngine` input tap**, not with `SCStreamConfiguration.captureMicrophone`:

- AVAudioEngine's voice processing is **opt-in** (`setVoiceProcessingEnabled`), off by default,
  and the sidecar never turns it on (a Rust test reads the Swift source and fails if it does).
  No VPIO unit, no AGC, no ducking of other audio. The input node is a plain HAL input.
- `captureMicrophone` (macOS 15+) does not document what processing it applies, so "raw" could
  not be checked; AVAudioEngine also works on every macOS the sidecar already supports (13+),
  so no OS-version split is needed on macOS.

A refused microphone permission, a machine with no input device, or the default input changing
format mid-meeting is **not fatal**: the system track keeps recording and the sidecar prints
`mic-unavailable <reason>`. The frontend then marks the meeting single-track (the privacy seal
says so, BR-8) and shows one toast pointing at System Settings → Privacy & Security →
Microphone. It does **not** fall back to getUserMedia mid-meeting — that would reopen the path
this ADR removes.

### 2. Two tracks, end to end (owner's hard requirement)

The microphone and the system audio are **never mixed**:

| | `sistema` (system) | `você` (microphone) |
|---|---|---|
| capture | ScreenCaptureKit `.audio` buffers | AVAudioEngine input tap |
| file | `loro-sys-<t>.wav` → `audio/system.wav`, `system-N.wav` | `loro-mic-<t>.wav` → `audio/mic.wav`, `mic-N.wav` |
| anchor line (stdout) | `first-sample-epoch-ms N` | `mic-first-sample-epoch-ms N` |
| pending list (backend) | `syscap_pending` | `mic_pending` (separate map) |
| live window | `brain_meeting_transcribe_tail {track: "system"}` | `brain_meeting_transcribe_tail {track: "mic"}` |
| written as | `source: "system"` → `[mm:ss · sistema]` | `source: "mic"` → `[mm:ss · você]` |

`live_tail_source` (Rust) is the only place that maps a track to a file, and
`LM.tailUtterances` (JS) the only place that stamps a window's speech with its source; both are
unit-tested for "mic reads only mic, system reads only system" and for the labels. The
cross-track filter (`LM.micLeakOfSystem`, the coverage gate of ADR-0025) is unchanged and runs
on the new path too — the mic window waits for the system track to have been heard up to its
end before its speech is resolved, and a mic copy of system speech is still dropped.

### 3. What stays the same

- The per-utterance epoch `e=` (ADR-0038 §3): both tracks now have a measured anchor, so the
  mic's `e=` is *more* exact than before (it used to be the MediaRecorder segment start).
- Pause kills the sidecar (both tracks stop); resume spawns one with `--mic` again, opening a new
  `mic-N.wav` segment. The final window of each track is transcribed before pause/stop.
- `purge_audio` removes `mic.wav` and `mic-N.wav` with everything else (BR-8).
- `meetingMic: false` → the sidecar is started without `--mic`; nothing asks for the microphone.
- Windows: unchanged. The in-process WASAPI capture records only loopback, so the microphone
  keeps going through getUserMedia there (`LoroAudio.meetingMicPath`).

### 4. `micEchoCancel` on macOS

It is a getUserMedia constraint; on the sidecar path there is nothing to apply it to. Decision:
**ignored on macOS, kept on Windows.** The Settings switch is disabled on macOS with a hint
saying why; the stored value is not erased. The cross-talk nudge offers only "record only the
system" on macOS. Speaker leakage is handled after the fact by the existing filter; whoever
listens through speakers and wants one track turns `meetingMic` off.

### 5. The audio wave

The header wave was fed by the webview's `AnalyserNode`. On the sidecar path there is no
webview stream, so **the wave stays idle during a macOS meeting**. Streaming levels from the
sidecar over stdout was considered and left out: it is UI decoration, and the capture-state
truth (BR-8) is the privacy seal, which is repainted from the real mic state.

## Also in this change: a whisper-cli that cannot run

A Homebrew `ggml` bump on 2026-11-18 left `whisper-cli` failing to launch (dyld), and the app
only logged `err.whisper_cli_failed` every 18 s per track. Now the reason (stderr tail) is logged
**once** until a window succeeds again, and the UI shows **one** toast telling the user
transcription is failing and to update the engine (`brew upgrade whisper-cpp`); a window that
transcribes again re-arms it.

## Consequences

- First meeting after updating: the sidecar's microphone access is attributed by macOS to
  Loro (its responsible process), like its Screen Recording access. If Loro already had
  Microphone permission it should not ask again; in dev (`tauri dev` from a terminal) the
  terminal app is what gets asked. **Not verified on a fresh machine.**
- If the incident's cause is not on Loro's side of the device (e.g. the meeting app's own AGC
  reacting to a second client), this change will not fix it; the owner's real-call test decides.

## Verification still owed (owner, real call)

1. During a Meet call, start a workday hour; ask the other side about your volume.
2. Run `osascript -e "input volume of (get volume settings)"` before and after.
3. Check the meeting file has `· você]` blocks with your speech only, `· sistema]` blocks with
   the others' only.
4. Deny the microphone for Loro once: the meeting must continue with system audio and say so.
