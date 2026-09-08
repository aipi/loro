# ADR-0035 — Modo intérprete: a sua voz sai em inglês, e o driver é guiado, não empacotado

- **Status:** **accepted and implemented** (2026-09-06), phase 1, macOS. The
  owner decided three things and they are premises, not open questions: the
  virtual audio driver is **guided, never packaged**; the mode is **an option,
  never a default**; and the **voice is user-selectable**. §6 records what
  building and testing it taught, including two defects the measurements caught.
- **Extends:** ADR-0003 (whisper as a system dependency; two transcription
  modes), ADR-0012 (loopback capture and the guided driver flow), ADR-0033
  (meeting mode on Windows — the capturer is the platform part, not the mode),
  ADR-0034 (VAD cuts before the decoder)
- **Amends:** nothing yet. §2 records a defect in behaviour ADR-0003 already
  promised; per CLAUDE.md §7 that is a code comment + PR, **not** this ADR.
- **Revokes:** nothing.

## Context

The ask: speak Portuguese, and the person on the other end of the call hears
English. Not a caption — a voice.

Loro already owns four of the five pieces. It captures raw mic audio with the
system's voice processing off (`desktop/src/audio.js:72`, `RAW_AUDIO`), it runs
whisper locally, it already exposes a "traduzir para inglês" checkbox wired to
whisper's `-tr` flag (`desktop/src/app.js:2339` → `lib.rs:377`, `lib.rs:412`),
and it already walks the user through installing BlackHole on macOS and
VB-Cable / Mixagem Estéreo on Windows (`i18n.js:756-758`,
`docs/install-windows.md:91`, `manual.pt.md:198`).

The fifth piece does not exist anywhere in the app: nothing is ever *played*.
`speechSynthesis`, `AVSpeech`, `.play()`, `say`, `tts` — none appear in
`desktop/src/*.js` or `desktop/src-tauri/src/*.rs`.

## The measurement (2026-09-06, Apple M4, this repo's owner machine)

Nothing below is estimated. Input: `pt.wav`, 8.617s of synthetic pt-BR speech
(`say -v Luciana`, converted to 16 kHz mono — the exact shape
`window_ffmpeg_args` produces).

| Stage | Time | Output |
|---|---|---|
| `whisper-cli -m ggml-small -l pt -tr -t 8` | **0.666s** | "Good morning guys, I wanted to discuss the schedule of the project…" |
| `say -v Samantha` (system TTS, zero new dependency) | **0.608s** | 7.5s of English audio |
| **whole chain** | **1.435s** | ~17% of the speech's own wall time |

Control: the same `small` model **without** `-tr` returned Portuguese. The
translation is real, not a coincidence of the sample.

`whisper-cli`, `whisper-stream`, `ffmpeg` and `say` all already resolve on
PATH here, and the Silero VAD model is already on disk
(`~/.loro/models/ggml-silero-v5.1.2.bin`, 885 KB).

**The compute cost is not the problem.** The latency budget is spent on (a) the
chunk size needed to close a sentence and (b) the wall time of *speaking* the
translation. The reference for (a) is UFAL's `whisper_streaming`: LocalAgreement
policy, 3.3s latency on long-form speech, ~2.0s with 1s chunks.

## 1. What the survey found: everyone punts on the same part

| Project | What it is | Why it cannot be reused |
|---|---|---|
| [Sokuji](https://github.com/kizuna-ai-lab/sokuji) | Closest match: two-way, desktop + browser extension, 44 ASR / 75 MT / 137 TTS local | **AGPL-3.0** vs. Loro's **Apache-2.0** — cannot vendor. README never says which driver it uses |
| [my-translator](https://github.com/phuc-nt/my-translator) | MIT, macOS+Windows, published latencies (~2s cloud, ~10s local) | Needs API keys (**BR-9**), and never documents audio injection — it only draws a caption overlay |
| [Realtime-Speech-to-Speech-Translation](https://github.com/kensonhui/Realtime-Speech-to-Speech-Translation) | Whisper + SpeechT5, explicit virtual mic | 1.5s **on an A100**. Python server + GPU. macOS via BlackHole; Windows undocumented |
| [Whisper-Live-Translator](https://github.com/alex-l-f/Whisper-Live-Translator) | Pushes audio to a virtual cable | Requires CUDA; the author calls it "incredibly messy" |

Every one of them hands the audio routing to a third-party driver the user
installs by hand. Nobody solved "no configuration", because it is not an
application-software problem — see §3.

## 2. A defect found on the way (fix in its own PR, not here)

Same audio, same flags, the two models Loro's catalog actually offers
(`models.rs:28` — the catalog has exactly two rows):

- `ggml-small.bin` + `-tr` → **English** (0.666s)
- `ggml-large-v3-turbo.bin` + `-tr` → **Portuguese, untranslated** (1.309s)

`large-v3-turbo` is Loro's default model (`app.js:214`). The turbo distillation
dropped the translation task, and whisper **ignores `-tr` silently** — no error,
no warning. So today: a user who ticks "traduzir para inglês" on the default
model gets Portuguese back, and the checkbox works on **one of the two models
the app offers**.

This is a defect in functionality ADR-0003 already mapped, so per CLAUDE.md §7
it gets a code comment carrying the measurement above and a PR — never an ADR.
Minimum fix: the checkbox reflects the selected model's real capability instead
of lying. It is worth fixing whether or not the interpreter mode is ever built.

## 3. Why "no configuration" is not reachable, and why it does not matter here

**macOS.** Apple does **not** grant `com.apple.developer.driverkit.family.audio`
for virtual devices — the official position in the developer forums is that
AudioDriverKit is for hardware-backed audio only. What remains is an
**AudioServerPlugIn (HAL)**, and `coreaudiod` loads those only from
`/Library/Audio/Plug-Ins/HAL` — a system directory, **root required**. There is
no `~/Library` variant. BlackHole is exactly that: a HAL plug-in, no kext, but
an admin password and a prompted restart. It is **GPL-3.0**, so shipping a
renamed "Loro Mic" build carries a source-publication obligation.

**Windows.** There is no user-mode API that creates a microphone — WASAPI/APO
cannot insert a device into the audio topology; that needs a kernel-mode
component. The options are VB-Cable (proprietary; redistribution only under a
commercial agreement with VB-Audio), a signed driver of our own (EV certificate
+ Microsoft attestation), or the one decent OSS option,
[Virtual-Audio-Driver](https://github.com/VirtualDrivers/Virtual-Audio-Driver)
(MIT) — which requires `bcdedit /set testsigning on`, unacceptable for an end
user.

**This is why the owner's "guide, don't package" decision is the cheap one.**
Loro already walks the user through installing that exact driver for system
capture. The interpreter uses **the same driver in the opposite direction**. For
a user who already uses meeting mode, the additional configuration is **zero** —
they select the device as their microphone in Zoom. Guiding keeps the cost in
days; packaging moves it into licence review and certificate procurement.

## 4. What the mode is competing with

Google Meet has shipped native voice-to-voice translation, and pt-BR↔English is
one of its five supported pairs (June 2026). Zoom's Voice Translator is in beta
(5 languages, no Portuguese, paid US accounts).

So the differentiator is **not** translation. It is: works in **any** app, runs
**100% locally**, sends nothing to a cloud (**BR-1**), and needs no account.
That has to be the stated value before the first line is written, or the feature
is a worse Meet.

## 5. Proposal

### 5.1 It is an option, never a default (owner decision, 2026-09-06)

The mode is off unless explicitly turned on, per session. It never activates
because a meeting started. Two reasons beyond the owner's call:

1. **It breaks a written premise.** "O Loro não toca nada" is the argument that
   justifies `echoCancellation: false` (`audio.js:47-56`) — the app plays no
   audio, so there is no echo of its own to cancel. Playing TTS ends that.
   Mitigation, and it must be an invariant: the synthesized voice goes **only**
   to the virtual device, **never** to the speakers. Then it never re-enters the
   mic and the premise holds for the capture path.
2. **A translated voice in a real meeting is not a neutral side effect.** Nobody
   should discover it is on.

### 5.2 Engine: `whisper -tr`, and therefore English only

Per the owner's choice. The honest limitation, stated in the UI and not buried:
whisper translates **X → English only**. There is no pt→es, no en→pt. Any other
pair needs a translation engine that does not exist in the app and would need
its own ADR.

It also forces a model choice: **the interpreter cannot run on `large-v3-turbo`**
(§2). It must select a translating model, and say so when the user's default is
the turbo.

### 5.3 Shape

A new backend module `interpreter.rs` (CLAUDE.md §5 — new concern, new module),
never business logic in the Tauri `run()` wiring:

```
mic (RAW_AUDIO, already ours)
  → VAD chunker (Silero, already on disk — cut on silence, not on a fixed clock)
  → whisper-cli -tr   (translating model; NOT the turbo)
  → TTS sidecar       (`say` on macOS, SAPI on Windows — same sidecar pattern
                       as loro-syscap, which already exists on both platforms)
  → output device chosen by the user (the guided BlackHole / VB-Cable)
```

Cutting on VAD rather than on a fixed clock is the whole quality question: a
5s clock cuts mid-sentence and whisper translates half a thought. ADR-0022 §28
also applies — **none of this runs on the main thread**; that bug class has
already cost this project three appearances.

### 5.4 Phases

| Phase | Content | Cost |
|---|---|---|
| **0 — done** | The chain above, measured. Remaining: `whisper-stream -tr` on short chunks (quality on a cut sentence is the real risk, not latency), and Windows TTS | hours |
| **1** | `interpreter.rs` + the toggle + device picker. Reuses the driver flow that already exists | ~1 week |
| **2** | Guided install polish for both platforms; the mic-direction copy in the existing flow | days |
| **3** | The reverse direction — translating *them* into your ear. Needs **no** virtual device at all (output goes to your headphones) and system audio is already captured on both platforms. Cheapest slice, possibly the most valuable |

### 5.5 Open, not assumed

- **Windows TTS cost is unmeasured.** The assumption is that SAPI5 /
  `System.Speech.Synthesis.SpeechSynthesizer` is comparable to `say`'s 0.608s
  with no new dependency. It must be measured on a Windows machine before it
  becomes a premise — this repo has been burned by exactly that gap before
  (`docs/windows-sweep-2026-08-20.md`).
- **Turn-taking.** The translated voice takes ~87% of the original's wall time
  (7.5s for 8.6s). Two people talking normally will overlap. Whether the mode
  queues, drops, or interrupts is a product decision, not a technical one.
- Whether the guided flow should detect the driver is already installed (it
  likely can, from the same device enumeration `pickCaptureDevice` uses).

## 6. What building it taught (2026-09-06)

Three things the implementation measured that the proposal above had wrong or
did not know.

### 6.1 The real-voice chain is faster than the synthetic one

The owner's own voice, 8s of pt-BR through the mic: **439ms** to translate —
against the 666ms measured on the `say`-generated sample. The latency budget is
looser than §"The measurement" assumed. The bottleneck is entirely the pause
needed to close a sentence plus the wall time of speaking it.

### 6.2 Device ids do not survive a `coreaudiod` restart — a defect this ADR
would have shipped

Installing BlackHole put `BlackHole2ch.driver` in `/Library/Audio/Plug-Ins/HAL`,
but `system_profiler` still listed only the built-in devices: `coreaudiod`
scans that directory **only at start**. After `sudo killall coreaudiod`:

```
before:   71 Alto-falantes (MacBook Pro)
after:    74 Alto-falantes (MacBook Pro)     <- moved
          86 BlackHole 2ch
```

Every id shifted. The first implementation stored the id in settings, which
means that after any reboot the mode would speak through **whatever device
inherited that number** — plausibly the speakers, mid-meeting, with the voice
then looping back into the mic. Settings now store the **name**, and
`interpreter.rs::resolve_device_id` re-resolves at every utterance;
`a_device_is_found_by_name_even_after_every_id_shifted` is the regression.

This also sharpens what the guided flow must do: **installed is not loaded.**
Detecting the driver on disk while CoreAudio does not list it is a distinct,
actionable state — "restart coreaudiod" — and without naming it the user only
sees a device that stubbornly fails to appear.

### 6.3 A test that could never have been red

The first hysteresis test in `tests/interpreter.test.js` passed **with the
hysteresis removed** — the utterance in the fixture was 100ms, so the
short-speech discard swallowed the cut and the two thresholds were never
exercised. Per CLAUDE.md §7.1 rule 2 it was worse than no test, because it was
believed. The fixture now speaks past `MIN_SPEECH_MS` before oscillating, and
was shown to fail with a single threshold and pass with two.

The same red-then-green check was run on the smoke step: flipping
`interpEnabled` to `true` in `DEFAULTS` makes `cfg-modo-interprete` fail with
"o modo intérprete nasceu LIGADO". The "never a default" decision is guarded by
a test that can actually break, not by a comment.

### 6.4 Still open

- **Windows is not built.** `interpreter_devices`/`_voices`/`_speak` return
  `err.interpreter_platform_unsupported` off macOS. The chunker, the queue and
  the translation path are platform-neutral, so Windows needs only the TTS
  sidecar — but SAPI's cost and its device routing remain **unmeasured**, and
  shipping unverified Windows code is what §5.5 already refused to do.
- **Turn-taking is queue-only.** The backlog is shown; nothing drops or
  interrupts. Whether it should is a product decision the first real meeting
  will answer.

## Business rules

- **BR-1 — inference stays local.** Held, and strengthened: the whole chain
  (whisper `-tr`, system TTS) runs on-device. No network call exists on this
  path. Raw audio never leaves the machine.
- **BR-8 — logs are content-free.** The translated text is transcript content.
  It must never reach a log — same discipline as `meeting.rs`, and the existing
  `no_content_variable_in_ai_or_meeting_logs` test (`ai.rs:717`) should be
  extended to cover `interpreter.rs`.
- **BR-9 — no credentials.** Held: no API key anywhere on this path. This is
  what rules out ElevenLabs / Google / OpenAI TTS by the direct route.
