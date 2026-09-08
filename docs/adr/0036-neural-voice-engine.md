# ADR-0036 — A voz do intérprete tem motor: `say` continua o barato, o neural é escolha medida

- **Status:** **accepted** (2026-09-07), implementation in progress. The owner
  chose on 2026-09-06: `say` stays the cheap engine, a **cross-platform** neural
  engine is added, and **voice cloning is deferred** — §3 is why.
- **Extends:** ADR-0035 (modo intérprete), ADR-0003 (the engine is a *system
  dependency* resolved on PATH, not vendored), ADR-0006 (models are per-user
  data, downloaded on demand and verified by SHA-256), ADR-0030 (a probe and its
  own spawn must resolve through the same lookup)
- **Revokes:** nothing. ADR-0035's `say`-only posture is **extended**, not
  replaced: `say` remains the default, for the measured reason in §4.

## Context

ADR-0035 shipped the interpreter with one voice engine: macOS `say`. Two limits
followed, and both are real:

1. **`say` is macOS-only.** ADR-0035 §5.5 already refused to fake a Windows
   path. Linux has none either. The mode is a macOS feature by accident of its
   engine, not by design.
2. **The installed system voices are the *compact* tier** — the owner heard them
   and asked for better. The Enhanced/Premium downloads help, but they are still
   macOS-only.

The ask was therefore: a neural voice engine that works on macOS, Windows and
Linux, plus — if possible — **the owner's own voice**.

## 1. The engine: sherpa-onnx, as a PATH binary and not as a crate

[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (k2-fsa) is **Apache-2.0**,
the same licence as Loro, and ships offline TTS for Kokoro/VITS/Piper/Matcha
models on all three platforms.

It has a Rust crate, and **we deliberately do not use it.** Measured 2026-09-07:

| Path | What it costs |
|---|---|
| `sherpa-onnx` crate | **145 transitive packages** (this `Cargo.toml` has 9 direct deps on purpose), and `build.rs` downloads a native archive **at build time** |
| prebuilt `sherpa-onnx-offline-tts` binary | nothing in the build; resolved on PATH exactly like `whisper-cli` |

The binary path is also the *consistent* one: ADR-0003 already decided the
transcription engine is a system dependency, and `paths.rs::resolve_engine`
already exists for precisely this. The neural voice is one more engine behind the
same lookup, so ADR-0030 applies unchanged — probe and spawn resolve identically.

**Two facts about the crate, recorded so nobody re-discovers them:**

- The default feature is `static`. Measured archive sizes: macOS arm64 19 MB,
  Linux x64 21 MB, **Windows x64 114 MB**. With `shared` they are 8 / 9 / **7
  MB**. Anyone who does link the crate must pass `default-features = false,
  features = ["shared"]`.
- On a network with TLS interception (this company's), `build.rs` **fails** —
  its `ureq` uses bundled roots and rejects the proxy CA, while `curl` succeeds
  through the system keychain. The escape hatch is `SHERPA_ONNX_ARCHIVE_DIR`
  with a locally fetched `.tar.bz2`, and the path must be **absolute** (a
  relative one is reported as "does not contain expected archive").

## 2. The model: Kokoro, and the licence was read in the archive

`kokoro-int8-en-v0_19` — **98 MB compressed, 152 MB on disk**, English only,
which is all the interpreter can produce (ADR-0035 §5.2: `-tr` makes English and
nothing else). Downloaded on demand into `~/.loro/models` with a pinned
SHA-256 — the ADR-0006 pattern, unchanged.

Its `LICENSE` file, read inside the extracted archive rather than taken from a
claim, is **Apache-2.0**.

## 3. Voice cloning is DEFERRED — and the blocker is PACKAGING, not licensing

> **Amended 2026-09-07, same day.** The first version of this section concluded
> that cloning was blocked by licensing. That was **wrong**, and the error was
> one of scope: it is true only *inside sherpa-onnx's model zoo*. Outside it,
> **MIT-licensed cloning models with MIT weights exist** — **Chatterbox**
> (Resemble AI; the Nano variant is 110M and claimed at ~3× realtime on 8 CPU
> cores — vendor claim, **not measured here**) and **OpenVoice v2** (MyShell +
> MIT, MIT since April 2024). Both clone from ~5s of reference audio. The real
> obstacle is that both are **Python/PyTorch**.
>
> That obstacle has a precedent-shaped answer: this project already treats a
> heavy engine as a **system dependency on PATH** — whisper is not in the repo
> (ADR-0003). Chatterbox can enter the same way: whoever wants their own voice
> installs it, and whoever does not never sees Python. Cross-platform, MIT, and
> it is genuinely *the user's own voice*.
>
> §3 below remains accurate about the **sherpa zoo** specifically, and that is
> why the neural engine of this ADR ships Kokoro (preset voices) rather than a
> cloning model.

The technology is present and would fit: sherpa-onnx exposes
`OfflineTtsZipvoiceModelConfig` and `OfflineTtsPocketModelConfig`, and
`GenerationConfig` takes `reference_audio` + `reference_text` — exactly the
"record your voice in Settings" flow the owner asked for.

**Both available checkpoints are non-commercial:**

| Model | Blocker |
|---|---|
| **Pocket TTS** | the model's own README states *"It is for non-commercial."* |
| **ZipVoice-Emilia** | ZipVoice's *code* is Apache-2.0, but the shipped checkpoint is `zipvoice-distill-zh-en-**emilia**` — trained on the Emilia dataset, **CC BY-NC-4.0** |

Loro is Apache-2.0 and is a product, not research. Shipping a non-commercial
checkpoint would encumber the distribution, and that defect surfaces only when
someone sells or audits. So cloning waits.

**What would unblock it,** in order of likelihood (revised by the amendment above):

- **Chatterbox or OpenVoice v2 as an optional system dependency on PATH**, the
  whisper pattern (ADR-0003). MIT code, MIT weights, cross-platform, clones from
  ~5s. Needs its CPU latency measured before it is promised.

- A checkpoint trained only on **Emilia-YODAS** (CC BY 4.0, commercial-OK). The
  data exists; the checkpoint does not, in sherpa's zoo.
- **macOS Personal Voice** — Apple-built, on-device, the owner's actual voice,
  licence-clean, no download. Rejected for this round because it is macOS-only,
  and it needs a Swift sidecar (`say` cannot reach it; only
  `AVSpeechSynthesizer` can). The `syscap/loro-syscap.swift` precedent means the
  shape is already in the repo.

**One design fact to keep for when cloning lands:** the reference sample needs
its **transcript**. So the recording surface must hand the user a *fixed phrase
to read*, never a free recording — otherwise `reference_text` is a guess.

## 4. Why `say` stays the DEFAULT — the measurement

Same sentence, same machine (M4, 8 threads), 2026-09-07:

| Engine | Time until the voice can start | Audio produced |
|---|---|---|
| `say -r 210` | **0.608s** | 7.5s |
| Kokoro int8 | **3.923s** (RTF 0.499) | 7.2s |

And short utterances are *worse* in ratio — "Good morning everyone." measured
**RTF 0.825** (1.133s of compute for 1.373s of audio), because the fixed cost
dominates. Conversational speech is mostly short utterances.

ADR-0035 §6.1 recorded the owner's own complaint — *"funcionou mas tomou muito
tempo"* — and §6 spent three changes buying latency back. Making a **6.4× slower**
engine the default would spend all of it and more.

So: **the neural voice is an option whose cost is stated on screen**, not an
upgrade applied silently. The engine is the user's choice, which is the same
harness posture the rest of this app takes.

**Streaming does not rescue it, yet.** `sherpa-onnx-offline-tts-play` does play
while generating — but only to the **default output device**, with no selection
flag. The interpreter's whole point is speaking into a *chosen* device while the
meeting stays on the headphones, so that binary cannot serve it. Playback is
therefore: generate a WAV, then play it to the chosen device with
`ffmpeg -f audiotoolbox -audio_device_index N` (verified as a valid output on
2026-09-07; ffmpeg is already a hard dependency).

## 5. Decision

1. A **`TtsEngine` seam** with two implementations: `system` (`say`, default)
   and `neural` (`sherpa-onnx-offline-tts` + Kokoro). New engines plug in without
   touching the mode.
2. The neural engine is **opt-in**, and the UI states its latency cost next to
   the choice.
3. `sherpa-onnx-offline-tts` is a **system dependency on PATH** (ADR-0003), never
   a crate. Absent binary → the choice is offered but explains what to install;
   it never breaks the default engine.
4. The Kokoro model is a **catalog entry** downloaded on demand with a pinned
   SHA-256 (ADR-0006). Absent model → same posture as an absent whisper model.
5. **Cloning is out of this ADR.** It returns when a commercially-licensed
   checkpoint exists, or as macOS Personal Voice under its own decision.

## 6. What building it taught (2026-09-07)

### 6.1 Kokoro is out; the cloned voice is both faster AND the user's

Measured on the owner's real recording as reference, same sentence:

| Engine | Time | RTF |
|---|---|---|
| `say -r 210` | 0.608s | — |
| Kokoro (preset voice) | 3.923s | 0.499 |
| **ZipVoice (the owner's voice)** | **1.378s** | **0.192** |

Kokoro was slower *and* generic — it does not clone at all (its voices come from
`voices.bin`, selected by `--sid`; there is no `--reference-audio` on that path).
It was dropped. §2's Kokoro decision is superseded by this measurement.

### 6.2 A flag I invented, and the BR-8 claim that had to be corrected

`zipvoice_args` passed `--text-file`. That option **does not exist** — the binary
answers `Invalid option`, and the earlier hand tests had passed the text
positionally, so a test asserting only my own string hid it.

The honest consequence: the BR-8 rationale in §5 ("text goes by file, never as an
argument") **does not hold for this engine**. It has no file option, so the
translated sentence appears in the process `argv`. It is not a log and does not
persist, and on macOS a process's argv is readable only by its own user — but it
is more exposure than the system engine has (`say` accepts `-f` and still uses
it). The text is passed after a `--` separator so a translation starting with `-`
is not parsed as a flag.

### 6.3 The two audio enumerations are different — the routing never worked

ADR-0036's first draft claimed `ffmpeg -f audiotoolbox -audio_device_index` was
"verified". It was not: only that index 0 did not error. The `say` ids and the
audiotoolbox indices are **separate enumerations**:

| Device | `say -a` id | audiotoolbox index |
|---|---|---|
| BlackHole 2ch | 86 | **0** |
| Alto-falantes | 74 | **2** |

Passing 86 failed with `AudioObjecTGetPropertyData UID`. The mapping was proved
by capture: playing to index 0 put **-4.6 dB** on BlackHole's input; index 2 put
**-91 dB** (silence). Each engine now resolves the device **by name** in its own
listing (`ffmpeg -f audiotoolbox -list_devices true` gives name, index and UID).

### 6.4 The meter had to leave the timer — measured, after I dismissed it

ADR-0035 §6 recorded a suspicion of `setInterval` throttling and then dismissed
it as wrong because the log was silent. The diagnostic left in place later filled
the log: **`interp tick gap ms=1001`**, dozens of consecutive lines, with the
Loro window in the background — which is the *normal* case, since whoever uses
the mode is looking at the meeting, not at Loro.

At 1s per sample the chunker collapses: `HANG_MS` is 350ms, so one silent sample
cuts immediately, and a one-sample utterance measures 0ms and is discarded as too
short. The mode went deaf precisely while in use.

The meter now runs in an **AudioWorklet** (`desktop/src/interp-worklet.js`),
driven by the audio hardware clock — there is no timer to throttle. Two further
gains: it sees *all* the audio (the old analyser held only the last window, so at
1s ticks ~870ms of speech was never even looked at), and the timestamps come from
the **audio** clock, so a burst of delayed messages still yields correct
decisions — only the reaction is late.

### 6.5 A fresh machine installs it itself (§5.4)

`voice_install.rs`: three pieces that go missing **separately** — engine binary,
model, vocoder — each with its own pinned URL, size and SHA-256, downloaded by
the user over HTTPS with atomic install.

They are offered **in the existing model manager**, as rows beside the whisper
models, not in a panel of their own: same nature (something large, fetched once,
living in `~/.loro`), so the screen has one way to draw "something large to
download". A `voice:` id prefix is what routes a click to the installer instead
of the whisper catalog, and the same progress bar serves both. On a platform
without support the rows are simply absent — offering what cannot install is
worse than not offering. Nothing is bundled, which is also what
keeps Loro from redistributing a non-commercially-licensed checkpoint; the
licence is stated on screen whenever the cloned voice is selected.

Verified on 2026-09-07:

- The three URLs answer 200 with the expected sizes.
- The pinned hashes come from the GitHub release API `digest` field and were
  **confirmed** against `shasum -a 256` of the downloaded files. All three match.
- The exact `curl` argument set the installer uses downloads the engine and its
  hash matches.
- Extraction and layout were exercised against a synthetic archive of the real
  shape, and on a scratch `HOME` the installed binary **runs standalone** —
  RTF 0.255, no `DYLD_LIBRARY_PATH` and nothing on `PATH`. That works only
  because `bin/` and `lib/` land as siblings (`@loader_path/../lib`), and
  `~/.loro/bin` is already in `known_bin_dirs()`, so the app finds what it
  installs (ADR-0030). A test asserts that last invariant.
- Total footprint: ~180 MB downloaded, ~240 MB on disk.

**Windows is offered but NOT verified.** The artifact name and hash come from the
same API, but neither the extraction nor the DLL-beside-the-exe layout was
exercised on a Windows machine. Device enumeration and WAV playback there are
still unimplemented — `audiotoolbox` is macOS-only and ffmpeg has no WASAPI
output. The system engine remains the default everywhere.

## Business rules

- **BR-1 — inference stays local.** Held. Kokoro runs on-device; the model is a
  file, not a service. No network call on the speaking path.
- **BR-8 — logs are content-free.** The text handed to the engine is speech
  content: it goes by **file**, never as an argument (ADR-0035 already), and
  never into a log. Engine logs carry RTF and ms, nothing else.
- **BR-9 — no credentials.** Held, and this is why the cloud voices
  (ElevenLabs and peers) are absent rather than merely unchosen.
