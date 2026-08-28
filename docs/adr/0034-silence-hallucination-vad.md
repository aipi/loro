# ADR-0034 — Silence has a voice: whisper invents captions, and only VAD stops it

- **Status:** accepted and implemented (2026-08-26)
- **Extends:** ADR-0003 (whisper as a system dependency; "two transcription
  modes"), ADR-0006 (models are per-user data, downloaded on demand and
  verified by SHA-256)
- **Amends:** ADR-0003's note that the file/offline path is "no VAD/streaming".
  That line described the *engine call*, and stayed true only for as long as
  whisper-cli had no VAD of its own. It now does, and the offline path uses it.
- **Revokes:** nothing.

## Context

A real meeting transcript, recorded on this repo's own owner machine, contains
these lines — none of them spoken:

```
28:20 · você   E aí
29:17 · você   Acesse o nosso site www.mesmerism.com.br
29:36 · você   A CIDADE NO BRASIL
31:11 · você   Tchau, tchau, tchau.
```

This is whisper's documented failure on silence: with no speech in the window,
the decoder still has to emit something, and it falls back to the caption
boilerplate that saturates its training data.

`meeting.js` already filtered the best-known shape of it (`Legenda por…`,
`Amara.org`, a lone `[Música]`). That filter is a blocklist on the *output*, and
the lines above are why a blocklist cannot be the answer: `E aí` and
`Tchau, tchau` are ordinary Brazilian speech. A pattern wide enough to catch the
hallucination is wide enough to delete a real greeting and a real goodbye.

## The measurement

Two 18s WAVs — the meeting window size — at 16 kHz mono, the exact shape
`window_ffmpeg_args` produces. Model `large-v3-turbo`, `-l pt`, on macOS with
whisper-cpp 1.9.1:

| Input | Output with the args Loro passed |
|---|---|
| digital silence | `Legenda por Sônia Ruberti` |
| pink noise at −50 dBFS | `E aí` |

Every decoder-side knob was then measured on those same two files:

| Flag | Result |
|---|---|
| `-nf` / `--no-fallback` | byte-identical to baseline |
| `-et 2.4` | byte-identical — **it is already the default** |
| `-sns` / `--suppress-nst` | byte-identical |
| `-nth 0.4` | byte-identical |
| `--suppress-blank` | **does not exist** in whisper-cli 1.9.1 |

None of them work, and the reason is structural: the hallucination is emitted on
the *first* pass at temperature 0. There is no fallback to suppress and no
threshold being crossed — the model is confident about text it invented.

`--vad` is the only one that changes the outcome, because it is the only one
that acts *before* the decoder: Silero segments the audio and the silence is
never handed over at all.

| Input | Baseline | `--vad` |
|---|---|---|
| digital silence | `Legenda por Sônia Ruberti` | *(nothing)* |
| noise −50 dBFS | `E aí` | *(nothing)* |
| speech at −3.9 dB | full sentence | full sentence, identical |
| speech at −27.9 dB | full sentence | full sentence, identical |

The two speech files are the control, and they are the reason this is safe to
turn on by default: VAD costs no words, including quiet ones. A silent window
also gets **~2× faster** (1.18s → 0.56s; a speech window is unchanged,
1.20s → 1.25s), which pushes in the right direction on the same 18s tick
ADR-0022 §28 froze on.

## Decision

1. **The offline path passes `--vad` whenever the VAD model is present.**
   `cli_args` takes a `vad_model: Option<&str>`; `Some` adds
   `--vad -vm <path> -vp 200`. All three whisper-cli callers (file mode, meeting
   stop, the live 18s window) go through it, so they cannot diverge.

   `-vp 200` (speech padding) is not the 30ms default, and that is measured: on
   the sentence attenuated to −48.9 dBFS the 30ms default ate the first word —
   "Bom dia pessoal" came back as "Dia pessoal". 200ms restores it, and silence
   stays silent (both the silence and the low-noise file still transcribe to
   nothing even at 400ms).

2. **Degrade, never block.** `None` reproduces the pre-VAD arguments exactly. A
   missing 864 KB file must never be able to stop a transcription, so nothing
   about this feature is on the critical path.

3. **The VAD model is fetched like any other model, and is not one.** It reuses
   `models.rs` verbatim — pinned SHA-256, atomic install, completeness check —
   and it sits in the **same download list** the model manager already paints
   (`list_models`), next to `large-v3-turbo` and `small`.

   It is still deliberately **not** in `CATALOG`, because `CATALOG` answers a
   different question ("what can I transcribe with?"). The transcription picker
   is the `<select id="model">`, which never sees it. One list to *obtain* a
   model, a separate list to *choose* one.

   This replaced a dedicated row placed just below the model list. That row
   rendered correctly and was still measured to go unnoticed in real use
   (2026-08-26): the model went undownloaded, so `--vad` was never passed and
   the hallucination reproduced in full. A separate row is a row nobody finds.
   Making a defect fix opt-in behind an affordance the user must notice is the
   same as not shipping it.

4. **A file in `models_dir` is not automatically a transcription model.**
   `doctor` answers "does this machine have a model?" by listing `ggml-*` there,
   and the VAD now lives in that directory. `is_transcription_model_file`
   excludes it, so a machine holding only the 864 KB VAD still reads as *no
   model*: the setup banner keeps naming the missing voice model and "Instalar
   agora" still fetches it.

5. **A second HuggingFace base.** Measured on 2026-08-26,
   `ggerganov/whisper.cpp` does not host the VAD model (404); whisper.cpp
   publishes it under `ggml-org/whisper-vad`. Hence `LORO_HF_VAD_BASE`,
   overridable for mirrors and air-gapped installs exactly like `LORO_HF_BASE`.

6. **The `meeting.js` blocklist stays exactly as it is.** It is not extended to
   the new lines. With VAD the strings are never generated, and without VAD a
   wider blocklist would delete real speech. The filter keeps covering the
   narrow, unambiguous caption-credit shapes it already covered.

## Consequences

- A user who has not downloaded the VAD model sees today's behaviour, unchanged.
- BR-1 holds: Silero runs locally; the only host contacted is the model mirror,
  and only when the user asks for the download.
- `--vad` is whisper-cli-only. The live `whisper-stream` path already does its
  own voice-activity gating (`-vth`) and is untouched by this decision.
- Pinning `silero-v5.1.2` means a future `v6.x` is a deliberate bump with a new
  pinned digest, not a silent upgrade.

## What was rejected

- **Extending the output blocklist** — rejected in point 6 above: it cannot
  separate an invented `E aí` from a spoken one.
- **`-nf` / `-et` / `-sns` / `-nth`** — rejected on measurement, not on
  reasoning. All four leave the output byte-identical.
- **Bundling the model in the app** — 864 KB is small, but it would put a binary
  asset in the repo and in the release, for a file the existing verified
  download path already handles.
