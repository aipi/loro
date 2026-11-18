# ADR-0040 — Loro cancels the speakers' echo in its own copy of the meeting microphone

- **Status:** accepted, implemented 2026-11-18 (stacked on ADR-0039's PR; real-call verification owed by the owner). macOS only.
- **Extends:** ADR-0039 (the meeting mic is captured raw by the sidecar), ADR-0025 (cross-track leak filter), ADR-0022 §25.
- **Amends:** ADR-0039 §4 — on macOS the speaker leak is now removed at the source, in Loro's copy; the after-the-fact filter becomes the safety net.
- **Revokes:** nothing.

## Context

The owner has no headset: MacBook built-in speakers and built-in microphone. His real test of
ADR-0039 (2026-11-18) showed the `você` track carrying the remote people's speech, picked up
acoustically from the speakers: the same sentences appear in `sistema` and `você` at 00:54,
01:12 and 01:30 of that meeting. The ADR-0025 filter dropped 5 duplicates but missed paraphrased
ones — whisper transcribes the two tracks with different words for the same sound («tô» /
«estou», «tá» / «está», «Brás tá» / «Basta estar») and different segment boundaries.

The hard constraint stays the one of ADR-0039: **nothing may change the device or what the
meeting app receives** — no VoiceProcessingIO, no AUVoiceIO properties, no ducking, no input
volume change. The two tracks stay separate (cleaned mic → `você`, system → `sistema`).

## Decision

### 1. Acoustic echo cancellation inside the sidecar, on Loro's copy only

The sidecar already holds both signals in one process: the system audio (ScreenCaptureKit, i.e.
what the speakers play — the far end) and the raw microphone (the near end, with the speakers'
sound in it). `loro-syscap` now runs an echo canceller on its **own copy** of the microphone
samples, with the system track as the reference, before writing `mic.wav`. It is pure signal
processing on samples it already has; the device is opened exactly as in ADR-0039.

**Engine: speexdsp's MDF echo canceller + its residual-echo suppressor**, vendored as C sources
(`syscap/speexdsp/`, SpeexDSP-1.2.1, BSD-3-Clause, files unmodified; see `VERSION`), compiled
into the sidecar by `make syscap`. Why not WebRTC APM AEC3, the better canceller:

- AEC3 is C++ inside the WebRTC tree; the standalone extraction (`webrtc-audio-processing`)
  builds with meson/ninja and depends on abseil. Vendoring it means a second build system in
  `make syscap` and the release CI, or a Homebrew runtime dependency for users — both ruled out.
- speexdsp's canceller is six small C files with no dependency: `cc` + `swiftc`, nothing else.
- Measured below, it clears the floor this ADR sets. If a real call shows it is not enough, AEC3
  is the next step and this ADR's harness (`aec_eval`, `pipeline_eval`) is how it would be judged.

Settings (all measured in `aec_eval`): 16 kHz, 10 ms frames (160), 300 ms echo tail (4800),
residual-echo suppression −40 dB (−15 dB while the near end talks). speexdsp applies **no**
spectral gain at all with its denoiser off (`preprocess.c`: "If noise suppression is off, don't
apply the gain") — measured: ERLE identical with and without the suppressor — so the denoiser is
on with its attenuation capped at −3 dB, i.e. effectively no noise suppression (ADR-0022 §24 still
holds: no AGC, no noise removal that flattens speech).

`mic.wav` is now **16 kHz mono Float32** (the cleaned stream), not the device's native rate.
whisper reads 16 kHz anyway; the tail carve (`wav_duration_ms_from_bytes`) reads the byte rate
from the header, so nothing downstream changes. A device change mid-meeting (headset plugged in)
no longer ends the mic track: the converter is rebuilt for the new format and the track goes on.

### 2. Reference alignment

Both streams are stamped with host time: the mic tap's `AVAudioTime.hostTime` and the SCK
buffer's presentation timestamp (taken as host time; a PTS more than 1 s from "now" is not trusted
and arrival time stands in — **assumed**, see below). Each is resampled to 16 kHz mono
(`AVAudioConverter`, stereo downmixed) and placed on one sample timeline whose index 0 is the first
mic sample (`AecPipeline.swift`, `TimelineConverter`). A running position re-syncs to the host time
when they disagree by more than 20 ms (dropouts, device changes), so the two clocks cannot drift.

The canceller (`aec/loro_aec.c`) processes a mic frame once the reference covering it **plus
50 ms of look-ahead** has arrived. The look-ahead covers a reference timestamped slightly late;
the 300 ms tail covers speaker latency + room (a few tens of ms on a laptop). When the system is
silent ScreenCaptureKit delivers nothing, so a frame waits at most 400 ms and then runs with
silence as reference. The output is contiguous: one cleaned sample per mic sample.

**`e=` stays exact.** The anchor printed for `mic.wav` is the wall-clock instant of the first mic
sample (host time → epoch at the moment it is taken), minus the canceller's own latency, measured
at exactly one frame (160 samples, 10 ms): output sample *k* is input sample *k − 160*.

### 3. Safety net: paraphrase-tolerant leak filter (JS)

`LM.micLeakOfSystem` keeps the ADR-0025 literal pair test and adds a second one
(`paraphrasedLeak`): the mic utterance, in canonical words (`tô→estou`, `tá→esta`, `pra→para`,
fillers like «né», «aí» dropped), against the **union** of the system utterances that overlap it in
time (±2 s). Same thresholds as the literal test (4-word runs ≥ 0.75, mutual ≥ 0.5): the measured
gap does not move, only what is compared. On the owner's real pairs (anonymized in
`meeting.test.js`): 01:12 0.95/0.94 and 01:30 0.93/0.75 are dropped; 00:54 is dropped for the part
that is pure leak (0.93/0.91), while the owner's own words spoken in the middle of it («Boa. Mas
vocês ainda não tão na migração…?», only on the mic) stay. Leak + own speech (0.66), coincidence
(0.56) and a reply on the same topic (0.29) stay.

## Measurements (offline, no call) — `make test-aec`, `make aec-speech`

A simulated laptop: far end → 40 ms latency → 120 ms decaying room response (direct path 0.6) →
mic, plus the near end and a noise floor. The reference is timestamped 20 ms late and delivered
120 ms after the mic, in differently-sized buffers. ERLE is measured on the echo-only stretch
after convergence; "near gain" on the near-only stretch.

| run | ERLE | near end gain |
|---|---|---|
| `aec_eval`, synthetic (C canceller, 16 kHz timeline) | 21.4 dB | −0.3 dB |
| `pipeline_eval`, synthetic (Swift pipeline: 48 kHz stereo system, 44.1 kHz mono mic, host times) | 24.9 dB | −0.2 dB |
| `aec_eval`, pt-BR speech (`say`, two voices) | 32.7 dB | −0.2 dB |
| `pipeline_eval`, pt-BR speech | 29.1 dB | −0.2 dB |
| `aec_eval` with the reference misaligned by 250 ms (the test must go red) | 0.6 dB | — |

Convergence: on speech, ERLE over seconds 3–9 is ~16 dB and over 6–9 is ~30 dB — the first few
seconds of echo of a meeting leak before the filter has converged.

Transcribed with whisper-cli (small, pt, VAD), speech run, before → after the canceller:

- echo-only stretch: the whole far-end sentence → «Bom dia pessoal.» (the pre-convergence second);
- double talk: the far end («com os atrasos na entrega…») → the near end («concordo com você, mas
  acho que antes disso»), which the raw mic had lost under the echo;
- near-only stretch: identical.

`make test` fails below 20 dB ERLE or if the near end moves outside [−3, +1] dB.

## What is assumed, not verified

- That ScreenCaptureKit's audio presentation timestamps are on the host clock. If they are not,
  the 1 s sanity check falls back to arrival time, which is late by SCK's delivery latency (the
  50 ms look-ahead may not cover it, and then ERLE drops). A real call is the test.
- A real MacBook's speaker → mic path is nonlinear (small speakers distort at volume); MDF is a
  linear canceller, and the residual suppressor has to absorb the rest. The simulation is linear.
- The first seconds of a meeting (convergence) and any change of the acoustic path (moving the
  laptop, changing the volume) leak until the filter re-converges; the JS filter is the net.
