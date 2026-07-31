<div align="center">

<img src="docs/media/loro-cover.png" alt="Loro — Talk. It becomes context. Local ideas capture → a knowledge studio for your team. speech → brainstormings → queue → shared, versioned contexts → produce with AI. 100% local, 0 credentials, any AI agent. macOS · Windows · Linux." width="100%">

<h1>Loro 🦜 — Knowledge Studio</h1>

</div>

---

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

## What is a Loro context?

A **context** is Loro's unit of durable, shared knowledge — one `context.md`
*source of truth* per domain, versioned in Git, that people and AI agents read
alike. The philosophy behind it (from the product's own brain,
`brain/contexts/loro/context.md`):

- **Ideas are cheap; context is earned.** Brainstorming is constant and free;
  a context is *production knowledge*, promoted only after debate and approval —
  never a raw dump of everything said.
- **Organized by archetypes, not org charts.** Product, business and
  engineering converge on a shippable outcome; a domain is recursive
  (subdomains are nested folders), built for groups and forming teams.
- **One source of truth, evolved by RFC = Pull Request.** Each
  `contextos/<domain>/` holds a single `context.md`, an append-only
  `CHANGELOG.md`, and its own `anexos/`. Open questions live *inline* as
  **hotspots** — the origin of the next change. Every change is a branch + PR
  applied directly to the file; merging makes it the new truth. Git stays
  hidden behind two buttons ("Versionar" / "Propor mudança").
- **Self-contained & non-destructive.** Loro detects existing structure,
  respects it, and fills only the gaps — it never overwrites your knowledge.
- **The flow is always visible:** capture → *fila* (queue) → the loop
  interprets and files material by domain → a person promotes proposals into
  the source of truth. The result is a **portable context harness** any agent
  or teammate can read — the same format Loro dogfoods to document itself.

## Requirements

| Component | Purpose | How |
|---|---|---|
| **whisper-cpp** (`whisper-cli` + `whisper-stream`) | transcription engine (system dependency, never vendored) | `./loro.sh setup` (macOS: `brew install whisper-cpp`) · Windows: the in-app setup button builds it (ADR-0012) |
| **ffmpeg** | audio conversion/mixing | `./loro.sh setup` (Windows: `winget install Gyan.FFmpeg`) |
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

## Install (Windows 10/11, x64)

There is no Homebrew cask and no prebuilt installer yet, so on Windows you build
Loro from source once. Everything runs in **PowerShell** — `loro.sh` and the
`Makefile` need a POSIX shell and are not the Windows path.

**1. Install the toolchain.** Rust and Node are needed to build the app; MSVC and
CMake are needed later to build the transcription engine.

```powershell
winget install Rustlang.Rustup OpenJS.NodeJS Kitware.CMake Git.Git Gyan.FFmpeg
```

Visual Studio Build Tools with the **C++ workload** is also required (Rust uses
the MSVC linker). If you don't have it:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

**2. Build Loro.**

```powershell
git clone https://github.com/aipi/loro.git
```

```powershell
cd loro\desktop; npm install; npm run tauri build
```

That produces an installer and a standalone binary under
`desktop\src-tauri\target\release`:

| Artifact | Path |
|---|---|
| MSI installer | `bundle\msi\Loro_<version>_x64_en-US.msi` |
| NSIS setup | `bundle\nsis\Loro_<version>_x64-setup.exe` |
| Standalone exe | `Loro.exe` |

**3. Open Loro.** Run either installer, then launch **Loro** from the Start menu.
To skip installing, run `Loro.exe` from the path above — it is the same app.

To work on the code instead, `npm run tauri dev` compiles and opens the app with
the dev reload loop. The first build takes a few minutes either way; later runs
are incremental.

**4. Install the transcription engine.** Loro opens with a banner reading
*"faltam dependências"* and a **configurar agora no terminal** button. Click it —
on Windows that runs a bundled PowerShell script in the embedded terminal which
builds `whisper-stream` and `whisper-cli` from source with SDL2 and installs them
into `%USERPROFILE%\.loro\bin`, where Loro looks for them (so your `PATH` is left
alone).

whisper.cpp publishes prebuilt Windows binaries for `whisper-cli` but **not** for
`whisper-stream`, because live mode needs SDL2 — that is why this step compiles
instead of downloading. It is idempotent: rerun it after a failure and it resumes.
Restart Loro when it finishes so the engine is detected.

**5. Download a model.** **Settings (⚙) → model → + download**, same as macOS —
`large-v3-turbo` (accurate) or `small` (fast), verified by SHA-256 into
`%USERPROFILE%\.loro\models`.

### Windows notes

| Topic | Detail |
|---|---|
| **The app is unsigned** | there is no code-signing certificate, so SmartScreen shows *"Windows protected your PC"* on first run of the installer. **More info → Run anyway**. |
| **`failed to bundle project: Acesso negado (os error 5)`** | the cached NSIS toolchain extracted only partially (a giveaway is a `makensis.exe` of a few KB). Delete `%LOCALAPPDATA%\tauri\nsis-3.11` and rebuild; the MSI is unaffected and is produced before this step. |
| **Meeting mode is macOS-only** | it captures both sides through a ScreenCaptureKit sidecar (ADR-0005), which is an Apple framework. On Windows the mode reports `err.syscap_not_found`; use **live** or **file** mode instead. |
| **System audio** | Windows has no BlackHole. Loro matches your driver's own loopback device — "Mixagem estéreo" on a pt-BR install, "Stereo Mix" in English — which usually just needs enabling in the Sound panel's Recording tab. If your driver has none, install [VB-Cable](https://vb-audio.com/Cable/) and set it as the default output. The in-app flow walks through both (ADR-0012). |
| **Data location** | `%USERPROFILE%\.loro` (models, logs, engine, config), resolved from `USERPROFILE`. Override with `LORO_HOME`. |
| **`loro.sh` / `make`** | bash and POSIX-shell only. Use the PowerShell commands in [Development](#development) instead. |

## Quick start (developing from source)

macOS/Linux:

```bash
./loro.sh setup     # install engine + download models to ~/.loro/models
./loro.sh app       # run the desktop app (dev)
./loro.sh live      # or transcribe from the terminal (SOURCE=mic|system)
./loro.sh test      # run the test suite (Rust + JS)
./loro.sh doctor    # report the detected environment
```

Windows (PowerShell) — the app itself replaces the CLI here; use the setup banner
for the engine and the ⚙ Settings for models:

```powershell
cd desktop; npm run tauri dev
```

## Capture modes

- **Live** — `whisper-stream` (VAD) streams lines as you speak. `SOURCE=mic`
  (default) needs no setup; `SOURCE=system` captures the computer's output through
  a loopback capture device. On macOS that is the **BlackHole** driver
  (`./loro.sh sysaudio-setup`), which **requires admin rights** to install; on
  Windows it is the audio driver's own "Mixagem estéreo"/"Stereo Mix", which
  usually only needs enabling, with VB-Cable as the fallback (ADR-0012).
- **File** — record the whole session, transcribe it at once (`whisper-cli`,
  more faithful than streaming).
- **Meeting** (macOS only) — your voice + the computer's audio (Meet/Zoom both
  sides) via a ScreenCaptureKit sidecar: one Screen Recording permission, **no
  virtual audio driver and no admin** — so on a locked-down Mac this is the way to
  capture both sides. The transcript accretes live into the meeting's notebook;
  **audio is transient** — deleted once transcribed. ScreenCaptureKit is an Apple
  framework, so on Windows this mode is unavailable — use live or file mode.

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

On Windows the `Makefile` recipes need a POSIX shell, so run the same checks
directly in PowerShell:

```powershell
cd desktop\src-tauri; cargo test
```

```powershell
cd desktop; node --test tests/*.test.js
```

```powershell
cargo clippy --manifest-path desktop/src-tauri/Cargo.toml -- -D warnings; cargo fmt --manifest-path desktop/src-tauri/Cargo.toml -- --check
```

Contribution rules and the AI-agent workflow are in `CONTRIBUTING.md` and
`CLAUDE.md`. The desktop app's UI details: `desktop/README.md`.

## License

Apache-2.0 — see [LICENSE](LICENSE).
