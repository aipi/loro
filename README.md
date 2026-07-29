# Loro 🦜 — local speech capture + a per-domain knowledge base

Loro is a **local, privacy-first desktop app** (Tauri v2) with one purpose: turn
what teams *say* — meetings, brainstorms, thinking out loud — into a trustworthy,
versioned, per-domain knowledge base that both **people and AI** can use as
context. Speech is transcribed **entirely on your machine** (whisper.cpp); no
audio or text ever leaves the device by default.

It is two things working together:

1. **A capture tool** — live transcription (mic, system audio, or both sides of
   a video meeting with zero driver setup), as a desktop app and a CLI (`loro.sh`).
2. **A Knowledge Studio** — a VS Code-like workspace where captured material
   flows through one explicit, sequential path:

   **Brainstorming → Fila → Contexto**

   You build an idea in a *brainstorming* (meetings, investigations, questions,
   notes — private, non-versioned); you elect parts of it into **one consolidated
   report** that enters the *fila* (queue); "gerar contexto" runs an agent loop
   (Claude Code in the embedded terminal) that distills the queue into versioned
   *contextos* — one `context.md` source of truth per domain, evolved by
   RFC = branch + Pull Request, with Git completely hidden behind two buttons
   ("Versionar" / "Propor mudança"). The result is a portable **context harness**:
   a folder of per-domain truth any agent or teammate can read.

> Docs: the brain domain `loro` (**`brain/contexts/loro/context.md`**, what/why —
> this repo dogfoods its own model), **`docs/ARCHITECTURE.md`** (how),
> **`docs/adr/`** (0001 is the consolidated baseline; 0002+ are incremental),
> **`CLAUDE.md`** (how to work here). All docs and code are in English; the app
> UI is pt-BR by default with a user-selectable English toggle (generated
> content follows the active UI language). An in-app user manual (pt/en) opens
> from the `?` button.

## Requirements

| Component | Purpose | How |
|---|---|---|
| **whisper-cpp** (`whisper-cli` + `whisper-stream`) | transcription engine (system dependency, never vendored) | `./loro.sh setup` (macOS: `brew install whisper-cpp`) |
| **ffmpeg** | audio conversion/mixing | `./loro.sh setup` |
| **Node.js ≥ 18** + **Rust (rustup)** | desktop app (Tauri) | https://nodejs.org · https://rustup.rs |
| **Python ≥ 3.12** | diarization (optional) | — |
| **git** + **gh** | optional: knowledge versioning / remote collaboration | opt-in, validated by an in-app doctor |
| **AI agent CLI** (`claude` by default) | optional: the agent loop and meeting AI skills | runs in the embedded terminal, user's own account; configurable per acervo (any CLI, including local models — ADR-0003) |

Models are ggml files under `~/.loro/models` (configurable via `LORO_MODELS_DIR`).

## Quick start

```bash
./loro.sh setup     # install engine + download models to ~/.loro/models
./loro.sh app       # run the desktop app (dev)
./loro.sh live      # or transcribe from the terminal (SOURCE=mic|system)
./loro.sh test      # run the test suite (Rust + JS)
./loro.sh doctor    # report the detected environment
```

## Capture modes

- **Live** — `whisper-stream` (VAD) streams lines as you speak.
- **File** — record the whole session, transcribe it at once (`whisper-cli`,
  more faithful than streaming).
- **Meeting** — your voice + the computer's audio (Meet/Zoom both sides) via a
  ScreenCaptureKit sidecar: one Screen Recording permission, no virtual audio
  driver. The transcript accretes live into the meeting's notebook; **audio is
  transient** — deleted once transcribed.

## The knowledge base ("acervo")

The acervo lives in a **user-chosen folder, separate from this codebase**
(config in `~/.loro/config.json`). Domains are user-defined and recursive
(subdomains as nested folders); each has a single `context.md` source of truth +
an append-only `CHANGELOG.md`; open questions live inline as *hotspots*. Meeting
AI (`/loro-analyse`, `/loro-question`), AI-assisted notes (`/loro-note`),
base/context Q&A (`/loro-ask`) and the distillation loop (`/loro-context`)
run as agent skills in the embedded terminal, **local-first**: they read the
local base before any external source. New acervos start from a **usage
template** (sales, engineering, healthcare… — ADR-0003) and choose their own
**AI agent CLI**; a first-launch welcome modal presents the main features.

## Security & privacy

- **BR-1** — inference is 100% local by default; raw audio never leaves the
  machine under any circumstance. Anything external (the optional meeting-AI
  skills) runs only on the user's explicit invocation, via their own agent.
- **BR-8** — logs are structured and content-free: no transcript text, no PII.
- **BR-9** — no credential is ever requested, stored or logged; `git`/`gh`/
  `claude` use the user's own ambient credentials.

See `docs/adr/0001-baseline.md` §3 for the full posture.

## Development

`make test` · `make lint` · `make build` · `make test-docker` (see `Makefile`).
Contribution rules and the AI-agent workflow are in `CONTRIBUTING.md` and
`CLAUDE.md`. The desktop app's UI details: `desktop/README.md`.
