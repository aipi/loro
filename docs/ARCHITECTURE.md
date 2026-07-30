# Loro — Architecture

> Version 1.0 · July 2026
>
> **Changelog v1.0:** first architecture document. Describes the system as
> implemented after de-vendoring whisper and adopting product discipline.

## 1. Overview

Loro is a **Tauri v2** desktop app: a Rust core (native process) plus a system
WebView rendering a dependency-free HTML/CSS/JS frontend. The Rust core spawns
an **external** whisper binary for transcription and exposes typed commands and
events to the frontend over Tauri IPC. A separate agent loop (Claude Code)
processes captured transcripts into a knowledge base on disk.

```
+---------------------- Loro.app (Tauri) ----------------------+
|  WebView (frontend)              Rust core (backend)         |
|  index.html / app.js  <--IPC-->  commands + events           |
|  (pt-BR UI, canvas wave)         spawn(whisper-stream)        |
+------------------------------|-------------------------------+
                               | stdout lines
                        whisper-cli / whisper-stream   (system dependency)
                               |
                        ~/.loro/  (config, models, logs)
                               |
   transcripts (inbox) ---> Claude loop (/loro-context) ---> knowledge base
```

**Knowledge flow (ADR-0001 §7):** the studio makes one sequential path explicit —
**Brainstorming → Fila → Contexto**. A *brainstorming* (`brainstorming/<slug>/`, the
renamed non-versioned world) gathers meetings/investigations/questions/notes; the
user elects parts into ONE consolidated report that enters the **fila** (the
`inbox/` queue); **"gerar contexto"** runs `/loro-context` (the renamed loop skill)
which distills the fila into versioned `contextos/`.

Config, models and logs live under `~/.loro/`. The knowledge base ("brain") is a
separate, user-chosen folder and is **not** part of the codebase.

## 2. Contexts (bounded contexts)

- **Capture & Transcription** — audio source selection (mic / system / meeting),
  spawning and lifecycle of the whisper process, parsing its stdout into transcript
  lines, emitting them to the UI, saving/auto-saving sessions. **mic** and
  **system** resolve to a single `whisper-stream` capture index (`-c`): the system
  default, or the BlackHole loopback. **meeting** (ADR-0001 §2) is a separate,
  driver-free flow: a ScreenCaptureKit sidecar (`loro-syscap`) records the
  computer's audio while the frontend records the mic; on stop the two are mixed
  (ffmpeg) and transcribed whole with `whisper-cli` (reusing file mode).
- **Knowledge base (brain)** — setup and layout of the acervo, per-context guide
  + change log, inbox/processed queue, import of files, status for the UI. The
  actual distillation is performed by the external Claude loop, not the app.
- **Settings & platform** — persisted user settings, window/tray/background
  behavior, global shortcut, diagnostics.

## 3. External engine (whisper)

The transcription engine is **not vendored** (ADR-0001 §1). Loro resolves the
system binaries `whisper-cli` and `whisper-stream` from `PATH` or from
`WHISPER_STREAM_BIN` / `WHISPER_CLI_BIN`. On macOS these come from
`brew install whisper-cpp` (1.9.1 ships both, incl. the SDL2 live streamer).
Models are ggml files under `~/.loro/models` (configurable). If the engine is
missing the app fails with an explicit, actionable message.

Live transcription uses `whisper-stream` in VAD mode; file/diarization flows use
`whisper-cli`.

The app exposes **two transcription modes** (ADR-0001 §2): **live** (`start`/`stop`,
`whisper-stream`, VAD, streamed lines) and **file** (`transcribe_file`,
`whisper-cli`, no VAD — the whole recording is transcribed at once, which tends
to be more faithful than streaming with VAD). Both land in the same
`transcript-line` stream and the same save/auto-save destination, so the rest of
the UI (buffer, savebar, acervo inbox) does not need to know which mode produced
the text.

## 4. IPC contract (commands & events)

Commands are Rust `#[tauri::command]` functions invoked from the frontend; keys
are camelCase on the JS side. Events flow Rust → frontend via `emit`/`listen`.

**Error contract (ADR-0001 §10):** user-facing command errors are stable codes
— `err.<snake_key>`, optionally `err.<key>:<detail>` — translated by the
frontend (`tErr()` in `src/i18n.js`) into the active UI language. Raw
OS/serde errors may still pass through and are shown untranslated.

### 4.1 Commands (representative)

| Command | Args | Returns | Purpose |
|---|---|---|---|
| `start` | `cfg {model, lang, translate, threads, capture?}` | `()` / err | spawn the streaming engine (live mode) |
| `stop` | — | `()` | terminate the engine process (live mode) |
| `transcribe_file` | `path, cfg {model, lang, translate, threads}` | `()` / err | file mode: converts `path` to 16kHz mono WAV (ffmpeg) and transcribes it whole with `whisper-cli` (no VAD); runs off the main thread, streams results via `transcript-line`/`transcribe-state`/`transcribe-error` |
| `start_system_capture` | — | wavPath / err | meeting mode (ADR-0001 §2): spawn the ScreenCaptureKit sidecar recording system audio to a WAV; errors fast on a denied Screen Recording permission |
| `stop_system_capture` | — | `()` | stop the sidecar cleanly (close its stdin → it finalizes the WAV) |
| `transcribe_meeting` | `micPath?, sysPath?, cfg` | `()` / err | mix the mic and system-audio tracks (ffmpeg `amix`) into one 16kHz mono WAV and transcribe whole with `whisper-cli`; same events as `transcribe_file` |
| `save_recording` | `data, filename` | path | write a recorded buffer (e.g. file-mode audio or diarization capture) to `transcripts/` |
| `save_transcript` | `content` | path or `null` | native save dialog + write |
| `auto_save` | `content, dir, filename` | path | silent save to the configured folder |
| `list_capture_devices` | — | `[{index,name}]` | enumerate capture devices (for `-c`) |
| `list_models` | — | `[{id,label,sizeBytes,installed,default}]` | the transcription models Loro uses, each flagged installed or missing, for the first-run model manager (ADR-0006) |
| `download_model` | `model` | `()` / err | download a catalog model into `~/.loro/models` over HTTPS (system `curl`), verify its pinned SHA-256, install atomically; emits `model-download-progress` (ADR-0006). Idempotent |
| `brain_get_config` / `brain_setup` / `brain_add_context` / `brain_remove_context` | … | config | acervo config lifecycle; `brain_setup` takes `template?` (usage preset id, ADR-0003) and `agent?` (per-acervo AI CLI command, default `claude`) |
| `brain_list_templates` | `lang?` | `[{id,name,description,contexts,builtin,dir?}]` | usage templates for the wizard (ADR-0003): builtins + `~/.loro/templates`, localized |
| `brain_duplicate_template` | `id` | dir path | copy a template into `~/.loro/templates` as an editable custom template |
| `ui_get_lang` / `ui_set_lang` | — / `lang ("pt"\|"en")` | lang | user-level UI language (ADR-0001 §10, ADR-0002 §1: generated content follows it); set relabels the tray live |
| `brain_status` | — | status | contexts, inbox, processed, activity |
| `brain_read` | `rel` | content | read a file inside the acervo (path-traversal guarded) |
| `brain_import` | `context?` | count | copy files into the inbox (prefix `<ctx>--`) |
| `brain_import_files` | `destRel` | count | native file picker → copy chosen files into an `anexos/` folder — a brainstorming's or a context's (guarded, ADR-0005) |
| `brain_new_note_in` | `destRel, titulo` | rel | create a living-front-matter note inside an `anexos/` folder (context counterpart of `brain_new_notebook`, ADR-0005) |
| `brain_delete_inbox` | `name` | `()` | delete an unprocessed queue item |
| `brain_set_auto_context` | `value: bool` | `()` | post-creation toggle (Settings) for autoContext — global config + local `.loro/settings.json` (ADR-0005 §3) |
| `brain_new_tool` / `brain_delete_tool` | `nome, conteudo` / `rel` | rel / `()` | create (imported skill content) or delete a custom habilidade — any `.claude/commands/*.md` outside the 10 built-in skills (ADR-0005) |
| `brain_annotations_get` | `rel` | `{doc, anotacoes[]}` | read a document's annotation sidecar `<doc>.anotacoes.json` (empty if none); highlights/comments anchored by text-quote (ADR-0007) |
| `brain_annotation_add` | `rel, anotacao` | id | add a highlight/comment; returns the assigned stable `an_…` id (ADR-0007) |
| `brain_annotation_update` | `rel, id, patch` | `()` | patch an annotation — change `cor` and/or append a `comentario` (ADR-0007) |
| `brain_annotation_delete` | `rel, id` | `()` | remove a highlight/comment ("desgrifar") (ADR-0007) |

Brainstorming world + the fila → contexto flow (ADR-0001 §7):

| Command | Args | Returns | Purpose |
|---|---|---|---|
| `brain_create_brainstorm` | `{nome, categoria?}` | `{slug, rel}` | create a brainstorming under `brainstorming/` |
| `brain_list_brainstorms` | — | list | list brainstormings (with categoria) |
| `brain_list_meetings` | `slug` | `[{id,rel,titulo,status}]` | a brainstorming's meetings, newest first, labelled by manifest `titulo` |
| `brain_meeting_rename` | `{id, titulo}` | `()` | rename a meeting (manifest + heading; the folder id stays stable) |
| `brain_rename_brainstorm` | `slug, nome` | `{slug, rel}` | rename a brainstorming (folder + meta) |
| `brain_set_brainstorm_category` | `{slug, categoria?}` | `()` | set/clear the UI grouping category |
| `brain_brainstorm_delete` | `{rel}` | `()` | delete a brainstorming item (guarded to `brainstorming/`) |
| `brain_rename_pessoal` | `rel, name` | new rel | rename a note/analysis file in place (world-confined, keeps extension, never overwrites — ADR-0003 §5) |
| `brain_move_pessoal` | `rel, destDir` | new rel | move a file into another folder of the same non-versioned world (brainstorming/pessoal); never overwrites — ADR-0009 |
| `brain_abs_path` | `rel` | abs path | resolve an acervo-relative path to its absolute on-disk path (guarded to the acervo root); backs "copy absolute path" — ADR-0009 |
| `brain_brainstorm_build_report` | `slug, selection[]` | `{rel}` | build ONE consolidated report (empty selection = all parts) |
| `brain_send_report_to_queue` | `reportRel, destContext?` | name | copy a report into the fila (`inbox/`) steered by `<ctx>--` |

Knowledge versioning & collaboration (ADR-0001 §5) — all opt-in, no credentials stored:

| Command | Args | Returns | Purpose |
|---|---|---|---|
| `brain_git_state` / `brain_git_files` | — | state / per-file status | local repo status (button label, VSCode-like tree colors) |
| `env_doctor` | — | checklist + `versioningEnabled` | validate git/gh/auth/identity/remote; gates the remote flow |
| `env_set_identity` | `name, email` | `()` / err | the one safe wizard fix — sets git identity scoped to the acervo |
| `brain_version` | `slug, message` | `{branch, result, warn?}` | Versionar (ADR-0002 §2): sync local default with origin (fetch + ff-only, degradable — `warn` = `err.git_offline`/`err.main_diverged`), then `rfc/<slug>` + add + commit (local) |
| `git_branches` / `git_switch_branch` / `git_create_branch` | — / `branch` / `slug` | `{current, default, branches, dirty}` / branch / branch | branch-first flow (ADR-0002 §2): picker data, switch (blocked on dirty tree), create `rfc/<slug>` off the synced default |
| `term_status` | — | `{open, agentRunning}` | readiness handshake (ADR-0002 §4, ADR-0003 §3): skill invocations are injected only when the acervo's agent process lives under the PTY shell |
| `term_agent` | — | command string | the active acervo's AI agent command (frontend launches it in the PTY; non-Claude agents get skills as plain prompts) |
| `brain_propose_change` | `title, body` | `{number, url}` | Propor: push the rfc/ branch + `gh pr create` (the RFC); gated |
| `gh_pr_list` / `gh_pr_status` | — / `number` | PR(s) | read open PRs / one PR's review status via `gh --json` |
| `brain_notifications` | — | inbox by category | collaboration inbox from open PRs; `connected:false` when local-only |
| `brain_timeline` | `rel?` | `[{id,when,author,label}]` | abstracted history (git log) for the timeline UI |
| `brain_migrate` | `apply?` | report | non-destructive `guia.md`→`context.md` + scaffolding (dry-run default) |

### 4.2 Events

| Event | Payload | Meaning |
|---|---|---|
| `transcript-line` | `string` | a new transcribed line — emitted by both live (`whisper-stream`) and file (`whisper-cli`) modes |
| `rec-state` | `bool` | recording / stopped — the UI's source of truth (live mode) |
| `transcribe-state` | `bool` | file-mode transcription job running / finished |
| `transcribe-error` | `string` | file-mode transcription failed with a message |
| `hotkey-toggle` | — | global shortcut or tray toggle fired |
| `model-download-progress` | `{model, downloaded, total}` | model download progress in bytes (ADR-0006) |
| `model-download-done` | `string` | a model finished downloading and was installed (ADR-0006) |

Path resolution: `LORO_HOME` (exported by `loro.sh`) or a sensible default;
`~/.loro/config.json` holds engine/model/brain configuration.

## 5. Key flows

- **Live:** `start` → spawn `whisper-stream` (VAD) → stdout thread parses lines →
  `transcript-line` events → UI appends; `rec-state true` drives the wave/tray/
  timer. `stop` kills the child; on EOF the thread emits `rec-state false`.
- **File (ADR-0001 §2):** the UI records the whole session locally (`MediaRecorder`,
  same mechanism as the diarization capture) — no engine process runs while
  recording. On stop, the buffer is written to disk (`save_recording`) and
  `transcribe_file` is invoked: it validates the engine/model/ffmpeg, emits
  `transcribe-state(true)`, then runs ffmpeg (16kHz mono WAV) + `whisper-cli` on
  a blocking-pool task so the command returns immediately and the UI is never
  blocked. Parsed segments stream back as `transcript-line` (same parser and
  event as live mode); `transcribe-state(false)` marks completion, at which
  point the UI applies the same savebar/auto-save decision as the live path.
  Errors surface via `transcribe-error`.
- **Auto-save:** on stop, if enabled, the buffer is written to
  `<saveDir>/loro-<timestamp>.md` (validated filename).
- **Brain loop (`/loro-context`, ADR-0001 §7):** `loop → /loro-context` reads the acervo inbox, distills each new input
  into `reunioes/` or `notas/`, appends prose to `contextos/<c>/CHANGELOG.md`,
  updates `contextos/<c>/context.md` (consolidated in sections 1–5; anything still
  open/contradictory as a **hotspot** in section 6 — ideas are no longer files),
  moves raw to `processed/`, updates state. Suggests a new context when none fits,
  and splits a composite domain into recursive `contextos/<c>/<sub>/` subdomains
  (parent becomes overview + index), up to `MAX_CONTEXT_DEPTH` levels (ADR-0001 §4).
- **Efficient-reading layer (ADR-0004):** every `context.md` opens with a
  regenerated **Summary card** (§0); decisions carry stable IDs
  (`D-YYYY-MM-DD-<slug>`), hotspots carry `H-<n>`, and the `INDEX.md` line is
  enriched (description · updated date · hotspot range) so agents route without
  opening files. The generated `AGENTS.md` and every skill teach the protocol:
  index → card → ID search → targeted section read.
- **External-source sync (`/loro-sync`, ADR-0005):** brings an
  external item — a Gemini note on Google Drive (full document), a Slack
  channel message, a Jira ticket, or a Confluence page (agent-written
  summaries) — into a LOCAL anexo file (`brainstorming/<tema>/anexos/`),
  referenced by an acervo note (`tipo: doc`, never the external URL
  directly in `refs:`). Runs as a terminal-Claude skill like `/loro-note`,
  using the terminal agent's own connector access (ambient-credential
  model, ADR-0004 baseline) — the Tauri app never talks to any of these
  APIs or stores a token. Always an explicit, user-triggered invocation
  (BR-1); the agent confirms the exact item before bringing it in; content
  lives only in the acervo's own material, never in a log (BR-8).
  Reachable from a brainstorming's sidebar or a meeting's `⋯` menu
  ("executar habilidade…", ADR-0005).
- **Habilidades (built-in + custom, ADR-0005):** any `.claude/
  commands/*.md` is a "habilidade" (UI label; code says `tool`) — the
  filename IS the slash-command. 10 built-ins ship with the acervo
  (`/loro-context`, `/loro-analyse`, `/loro-question`, `/loro-ask`,
  `/loro-note`, `/loro-sync`, `/loro-tool`, `/loro-presentation`,
  `/loro-artifact`, `/loro-slack`); built-ins can be edited but never deleted. Custom ones
  are created either by describing them to `/loro-tool` (AI drafts the
  skill, same dual create-or-evolve shape as `/loro-note`) or by importing
  an already-written skill file directly (`brain_new_tool`, no AI). Listed
  in a sidebar section (usar/editar/pedir à IA/excluir-if-custom) and run
  from "⋯ → executar habilidade" on a brainstorming (curated picker,
  excludes the 5 workflow-specific built-ins with dedicated UI elsewhere),
  from the top of ANY open markdown document's viewer, or — unrestricted,
  no exclusion — from a single dropdown in a meeting's rail
  ("o que fazer com esta reunião" no longer lists fixed actions; those
  moved to the meeting's `⋯` menu). `/loro-presentation`/`/loro-artifact`
  generate material (markdown by default) into `anexos/` — a
  brainstorming's `brainstorming/<tema>/anexos/` or a context's
  `contextos/<c>/anexos/`; there is no separate presentations folder.
- **Knowledge versioning (ADR-0001 §5), Git hidden behind two buttons:** *Versionar*
  → `brain_version` creates `rfc/<slug>` off the default branch and commits the
  working changes locally (Git only). *Propor mudança* → `brain_propose_change`
  pushes that branch and opens the PR (the RFC) via `gh`, gated on `env_doctor`'s
  `versioningEnabled`. Owners approve on GitHub via `.github/CODEOWNERS` + branch
  protection; merging into `main` makes the change the official source of truth.
  Local-only stays the default; `brain_notifications`/`brain_timeline` surface
  review status and history without exposing commits/branches to the user.

## 6. Observability

Structured logging (English, no PII/secrets) written under `~/.loro/logs/`, plus
a diagnostics ("doctor") command that reports environment, engine discovery,
model presence and permissions. Logging rules: ADR-0001 §3 (BR-8).

## 7. Security posture

- 100% local inference (BR-1); restrictive Tauri CSP; minimal command allowlist.
- `brain_read` and file operations are guarded against path traversal.
- No secrets requested or persisted (BR-9); no personal paths in code.
- Model downloads are HTTPS-only and verified against a pinned SHA-256 before
  install (ADR-0006), so a compromised mirror or MITM cannot substitute the
  model file; the only host contacted is the model mirror.
- Remote collaboration is opt-in and credential-free: `git`/`gh` run with fixed
  argument tokens (never a shell), branch slugs are sanitized to `[a-z0-9-]`, and
  the environment doctor reads only booleans/versions/public login — tokens are
  never captured or logged (ADR-0001 §5).

## 8. Registered decisions

All technical decisions are consolidated in the single **`docs/adr/0001-baseline.md`**
(with a map from the former ADR numbers still referenced by code comments):

| Decision | Choice | Section |
|---|---|---|
| Desktop framework | Tauri v2 | ADR-0001 §1 |
| Engine sourcing | whisper.cpp as a system dependency, not vendored | ADR-0001 §1 |
| Transcription | live (`whisper-stream` VAD) + file (`whisper-cli`, whole recording, off-main-thread) | ADR-0001 §2 |
| Meeting capture | mic + system audio via ScreenCaptureKit sidecar, mixed late | ADR-0001 §2 |
| Privacy | BR-1 local inference · BR-8 structural logs · BR-9 no credentials | ADR-0001 §3 |
| Product per context | single `context.md` (source of truth) + CHANGELOG; inline hotspots | ADR-0001 §4 |
| Change proposal | RFC = branch + Pull Request; opt-in remote via `gh` + CODEOWNERS | ADR-0001 §5 |
| Studio shell | multi-tab workspace, command palette, vendored CM6 IIFE | ADR-0001 §6 |
| Knowledge flow | Brainstorming → Fila → Contexto (`/loro-context`) | ADR-0001 §7 |
| Meetings | living file + notebook report, transient audio | ADR-0001 §8 |
| Meeting AI | terminal-Claude skills, local-first | ADR-0001 §9 |
| Doc language | English | ADR-0001 |
| External-source sync | `/loro-sync <fonte>` (drive/slack/jira/confluence) → local anexo + ref, ambient terminal-agent connector | ADR-0005 |
| Habilidades (built-in + custom) | any `.claude/commands/*.md`; 10 built-ins, editable-not-deletable; `/loro-tool` (AI-drafted) or direct import for custom ones | ADR-0005 |
| Annotation layer | select a passage in any markdown → grifar/comentar + excerpt-scoped habilidade (perguntar/analisar/Slack); highlights/comments in a co-located `<doc>.anotacoes.json` sidecar anchored by text-quote; alvo `acervo://<rel>#<annot-id>`; outbound `/loro-slack` via the agent's connector | ADR-0007 |
| `autoContext` | per-acervo `.loro/settings.json` gate on the loop creating a brand-new context; toggle in wizard + Settings | ADR-0005 |
| Terminal launch/status | `active_agent()` used for auto-launch (not hardcoded); `justLaunched` grace window avoids retyping into a live session | ADR-0005 |
| Distribution | Homebrew Cask (`brew install --cask loro`) with `whisper-cpp`+`ffmpeg` as formula deps; tap `aipi/homebrew-loro` bumped by release CI | ADR-0006 |
| First-run models | not bundled; downloaded on demand over HTTPS, verified by pinned SHA-256, atomic install into `~/.loro/models` | ADR-0006 |
