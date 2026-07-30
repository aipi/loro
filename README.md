# Loro 🦜 — local speech capture + a per-domain knowledge base

Loro is a **local, privacy-first desktop app** (Tauri v2) that turns what teams
*say and gather* — meetings, brainstorms, thinking out loud, plus notes and
files from tools you already use — into a trustworthy, versioned, per-domain
knowledge base that both **people and AI** can use as context. Speech is
transcribed **entirely on your machine** (whisper.cpp); nothing leaves the
device unless you explicitly send it, and the app never holds a credential.

Three parts work together:

1. **A capture tool** — live transcription (mic, system audio, or both sides of
   a video meeting), as a desktop app and a CLI (`loro.sh`). The app's **meeting**
   mode captures both sides with *zero driver setup* (ScreenCaptureKit); the
   CLI's `SOURCE=system` route instead needs the BlackHole loopback driver — see
   [Capture modes](#capture-modes).
2. **A Knowledge Studio** — a VS Code-like workspace where material flows
   through one explicit path: **Brainstorming → Fila → Contexto**. In a
   *brainstorming* you gather **reuniões**, **notas** and **anexos** (files you
   drop in, or pull from Drive/Slack/Jira/Confluence); you elect parts into
   **one consolidated report** that enters the *fila*; "gerar contexto" runs an
   agent loop that distills the queue into versioned *contextos* — one
   `context.md` source of truth per domain, evolved by RFC = branch + Pull
   Request, with Git hidden behind two buttons ("Versionar" / "Propor
   mudança"). The result is a portable **context harness** any agent or
   teammate can read.
3. **An AI-agent automation layer** — Loro wraps an AI agent CLI (`claude` by
   default, any CLI — ADR-0003) in an embedded terminal and turns its skills,
   called **habilidades**, into one-click UI instead of typed commands. They
   run from a picker (friendly names, always-visible descriptions) on the
   Visão Geral, a brainstorming/meeting `⋯` menu, or the right-side actions
   rail of any open file. Nine ship built-in — the loop (`/loro-context`),
   Q&A (`/loro-ask`), meeting AI (`/loro-analyse`/`/loro-question`), notes
   (`/loro-note`), external sync (`/loro-sync` — brings a Drive doc, or a
   Slack/Jira/Confluence summary, into a local anexo), generators
   (`/loro-presentation`, `/loro-artifact`), and the skill authoring tool
   (`/loro-tool`). You can author your own habilidade — describe it and let
   the AI draft it, or import one you already have — and edit any built-in
   (but not delete it). The capture tool and the knowledge base are what the
   automations act on; this layer is how you reach them.

> Docs: the brain domain `loro` (**`brain/contexts/loro/context.md`**, what/why —
> this repo dogfoods its own model), **`docs/ARCHITECTURE.md`** (how),
> **`docs/adr/`** (0001 is the consolidated baseline; 0002+ are incremental),
> **`CLAUDE.md`** (how to work here). All docs and code are in English; the app
> UI is pt-BR or English — chosen when you create an acervo and switchable in
> Settings, with generated content following that language. An in-app user
> manual (pt/en) opens from the `?` button.

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
The desktop app **downloads the model you pick on first use** (Settings → model),
verified by SHA-256 (ADR-0006) — no manual setup step needed.

## Install (macOS, Apple Silicon)

```bash
brew tap aipi/loro
brew trust aipi/loro         # Homebrew 6+: trust this third-party tap
brew install --cask loro     # installs Loro.app + whisper-cpp + ffmpeg
```

`brew trust` is required once per machine — Homebrew 6+ refuses to load casks
from a non-official tap until you trust it. The cask pulls the engine
(`whisper-cpp`, `ffmpeg`) automatically. The unsigned
`.dmg` is also attached to each
[GitHub Release](https://github.com/aipi/loro/releases) for a manual install.

**No admin rights?** The cask installs into `/Applications`, which a non-admin
user can't write to — `brew` then escalates to `sudo` and fails (`… is not in
the sudoers file`), after hanging on a password prompt. Install into your own
`~/Applications` instead:

```bash
brew install --cask --appdir="$HOME/Applications" loro
```

**Unsigned app (Gatekeeper).** Loro is **ad-hoc signed**, not signed with an
Apple Developer ID and not notarized (ADR-0006, future work) — there is no
verifiable publisher identity, so macOS 15+ may refuse to open it, often with a
misleading **"Loro is damaged and can't be opened. You should move it to the
Trash."** The app is **not** damaged, and its default button is destructive:
click **Cancel**, never *Move to Trash*. Then clear the quarantine attribute
once (adjust the path if you installed into `~/Applications`):

```bash
xattr -dr com.apple.quarantine /Applications/Loro.app
```

Then open Loro normally. (Homebrew 6+ removed the old `--no-quarantine` install
flag, so this is the reliable path.)

**First launch.** Open Loro, go to **Settings (⚙) → model**, and click
**+ download** on the model you want — `large-v3-turbo` (accurate) or `small`
(fast). It downloads on your machine with a progress bar, verified by SHA-256,
into `~/.loro/models`. Then you are ready to transcribe.

### Troubleshooting the install (Homebrew 6+)

| Error | Fix |
|---|---|
| `Refusing to load cask aipi/loro/loro from untrusted tap` | `brew trust aipi/loro` — Homebrew 6+ requires trusting a third-party tap once per machine |
| `invalid option: --no-quarantine` | that flag was removed in Homebrew 6.x; install normally, then run the `xattr -dr …` below if Gatekeeper complains |
| `… is not in the sudoers file` (install hangs on a password prompt) | you're a non-admin user and can't write `/Applications`; reinstall with `brew install --cask --appdir="$HOME/Applications" loro` |
| macOS says the app is "damaged" / offers **Move to Trash** | click **Cancel** (the app is ad-hoc signed, not damaged), then `xattr -dr com.apple.quarantine <path-to>/Loro.app` |

## Quick start (developing from source)

```bash
./loro.sh setup     # install engine + download models to ~/.loro/models
./loro.sh app       # run the desktop app (dev)
./loro.sh live      # or transcribe from the terminal (SOURCE=mic|system)
./loro.sh test      # run the test suite (Rust + JS)
./loro.sh doctor    # report the detected environment
```

## Capture modes

- **Live** — `whisper-stream` (VAD) streams lines as you speak. `SOURCE=mic`
  (default) needs no setup; `SOURCE=system` captures the computer's output through
  the **BlackHole** loopback driver (`./loro.sh sysaudio-setup`), which is a
  system audio driver and therefore **requires admin rights** to install.
- **File** — record the whole session, transcribe it at once (`whisper-cli`,
  more faithful than streaming).
- **Meeting** — your voice + the computer's audio (Meet/Zoom both sides) via a
  ScreenCaptureKit sidecar: one Screen Recording permission, **no virtual audio
  driver and no admin** — so on a locked-down machine this is the way to capture
  both sides. The transcript accretes live into the meeting's notebook; **audio
  is transient** — deleted once transcribed.

## The knowledge base ("acervo")

The acervo lives in a **user-chosen folder, separate from this codebase**
(config in `~/.loro/config.json`). Domains are user-defined and recursive
(subdomains as nested folders); each `contextos/<c>/` has a single `context.md`
source of truth, an append-only `CHANGELOG.md`, and its own `anexos/` for
attached files — open questions live inline as *hotspots*. Every brainstorming
has exactly three folders, shown as such in the sidebar: **`reunioes/`** (every
meeting is born there), **`notas/`**, and **`anexos/`** — fed by a habilidade
(sincronizar, apresentação, artefato) or by importing a file from the computer.

Skills run in the embedded terminal **local-first** (they read the local base
before any external source). When you create an acervo you choose its
**language** (pt-BR / English — the whole app follows), a **usage template**
(ADR-0003) whose first option is **Automático** — the loop creates and assigns
contexts on its own as it processes the fila (any other template = you define
the contexts; switchable later in Settings) — and its own **AI agent CLI**.
"Gerar contexto" has an opt-in checkbox to also copy the processed items'
anexos into `contextos/<c>/anexos/`.

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

## License

Apache-2.0 — see [LICENSE](LICENSE).
