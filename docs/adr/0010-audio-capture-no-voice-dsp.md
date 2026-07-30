# ADR-0010 — Audio capture: voice DSP off, and the WebKit meter fixes

- **Status:** accepted (owner decision, 2026-07-30)
- **Context:** starting a capture muffled **all** macOS system output (music, a
  video, a call), and the live waveform meter did not animate. Investigation
  (a runtime `wave-diag` probe: `AudioContext.state`, canvas size, track
  sample-rate/label, analyser peak) pinned three independent WebKit/WKWebView
  causes, not one:
  1. **Muffling.** `getUserMedia` defaults (`{ audio: true }`) turn the WebRTC
     voice DSP on: `echoCancellation` + `noiseSuppression` + `autoGainControl`.
     On macOS that flips Core Audio into voice-processing mode (VPIO), which
     ducks/comm-processes every app's output while a capture is live.
  2. **Suspended context.** WKWebView creates the `AudioContext` **suspended**;
     the `AnalyserNode` then reads constant silence (a flat line) even while the
     `MediaRecorder` records normally — the two are independent paths.
  3. **Un-pulled graph.** WebKit only processes a `MediaStreamAudioSourceNode`
     when the graph reaches the `destination`. Connected only to an analyser,
     the node stays silent (`getByteTimeDomainData` ≈ 128 constant). Chrome
     pulls an analyser-only graph; WebKit does not.

  Diagnostics also surfaced a hard **WebKit coupling on `echoCancellation`**
  that forces a per-source choice (measured, both directions):

  | `echoCancellation` | built-in mic → Web Audio | system loopback (BlackHole) → Web Audio | system output |
  |---|---|---|---|
  | **false** | silent (no wave) | **flows** (wave) | not muffled |
  | **true**  | **flows** (wave) | cancelled as "echo" (silent) | muffled (VPIO) |

  With EC off the raw mic path is not fed to Web Audio; with EC on the AEC
  cancels the BlackHole loopback and VPIO muffles output again. There is no
  single setting that lights the wave for both sources without muffling.

## Decision

`noiseSuppression` and `autoGainControl` are **always off** (they are the
"processed/telephone" voice DSP and never help — transcription gets 16 kHz mono
via ffmpeg regardless, former ADR-0003 / baseline §2). `echoCancellation` is
chosen **per source** via a pure helper `LoroAudio.audioConstraints(deviceId,
{ echoCancellation })`:

- **System capture** (BlackHole, `deviceLabel` set) → **EC off**: loopback
  reaches the meter *and* nothing is muffled.
- **Meeting** (mic via `getUserMedia` + system via the ScreenCaptureKit
  sidecar) → **EC off**: protects the system audio the meeting records (the
  other participants). Trade-off, decided by the owner: the mic waveform does
  **not** animate during a meeting. Clean recorded audio outranks the meter.
- **Mic-only dictation** → **EC on**: the only way WebKit feeds the mic to Web
  Audio, so the wave animates. No system capture is involved, so re-engaging
  VPIO only ducks unrelated apps while dictating — acceptable.

In `startAudio` the source is `micEC = !deviceLabel && !state.meetingMode`.

Two WebKit meter fixes apply to every source:
- **Resume** the `AudioContext` if it is `suspended` (allowed — `startAudio`
  runs inside the record-button user gesture).
- **Reach the destination** through a **zero-gain** `GainNode`
  (`analyser → gain(0) → destination`) so the source node is pulled without
  routing capture to the speakers.

## Consequences

- **Frontend (`audio.js`):** `audioConstraints(deviceId, opts)` — EC from
  `opts.echoCancellation` (default false), NS/AGC hard-off.
- **Frontend (`app.js` `startAudio`):** per-source `micEC`; `AudioContext`
  resume; `analyser → gain(0) → destination` graph.
- **Tests (`tests/audio.test.js`):** NS/AGC off by default and with a
  `deviceId`; `{ echoCancellation: true }` flips only EC.
- **User-visible:** system audio no longer muffles during capture; the wave
  animates for mic-only and system capture; the mic wave is intentionally
  static during meetings (recording fidelity wins).
- **BRs upheld:** BR-1 (local inference) and BR-8 (no transcript/PII in logs)
  untouched — only stream constraints and the local audio graph changed.
- **Not touched:** the ffmpeg 16 kHz mono transcription pipeline, the Swift
  system sidecar's 48 kHz stereo capture, and `pickCaptureDevice`.
- **Deferred:** a meeting mic meter that does not depend on the WebKit source
  node (e.g. level derived from the `mic.webm` MediaRecorder segments) — would
  restore the meeting wave without EC. Not done here.
- **Numbering:** next file in the incremental ADR series (…0008, 0009, 0010).
  The baseline's former-ADR map also lists a legacy "0010" (meeting living
  file, baseline §8); as with 0009, the incremental file and the legacy map
  entry share a number but are distinct — new code comments citing `ADR-0010`
  mean this decision.
