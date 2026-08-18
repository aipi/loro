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
|  index.html / shell.js /         commands + events           |
|  app.js               <--IPC-->  spawn(whisper-stream)       |
|  (pt-BR UI, canvas wave)                                     |
+------------------------------|-------------------------------+
                               | stdout lines
                        whisper-cli / whisper-stream   (system dependency)
                               |
                        ~/.loro/  (config, models, logs)
                               |
   transcripts (inbox) ---> Claude loop (/loro-context) ---> knowledge base
```

**Knowledge flow (ADR-0001 §7; ADR-0014):** the studio makes one sequential path
explicit — **Brainstorming → Fila → Contexto**. A *brainstorming*
(`brainstorming/<slug>/`, the renamed non-versioned world) gathers
meetings/notes/attachments; the user **selects the real files** to send and each
one enters the **fila** (the `inbox/` queue) AS ITSELF — one queue item per file,
no consolidated report (ADR-0014 supersedes the ADR-0013 merged relatorio). A
meeting is queued as its **analyses** (`meetings/<id>/notes/*`, ADR-0018 — a
meeting no longer has a `relatorio.md`); the raw transcript (`meeting.md`), audit
and audio never enter the fila (BR-8). **"gerar contexto"** runs `/loro-context`
(the renamed loop skill) which distills the fila into versioned `contexts/`.

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
- **Extensions & loops (ADR-0029)** — `plugins.rs` installs a **pacote** (a Claude
  Code plugin plus `loro.json`) into the acervo: it reads the manifest, classifies
  it **from the tree** (declarative vs executable), plans the writes, runs them
  through the intake triage and records what it wrote in `.loro/plugins.json`.
  `loops.rs` owns **standing work**: a loop's definition is a versioned document
  (`loops/<slug>.md`), its runtime is quarantined bookkeeping
  (`.loro/loops/<slug>.json`), and a cycle is ONE agent turn spawned the same way
  the chat spawns one. Nothing in either module is ever executed by the app — a
  pacote is instructions, and a loop is an instruction plus a rhythm.
- **Settings & platform** — persisted user settings, window/tray/background
  behavior, global shortcut, diagnostics.

The backend modules follow the same split (CLAUDE.md §5). Two of them carry the
knowledge-review concern: `git.rs` owns everything that shells out to git/gh and
owns GitHub's vocabulary, and `diff.rs` is **pure** unified-diff parsing — no
framework, no process, no filesystem. The working tree and a pull request share
that one parser, so a change never gets two renderings.

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
OS/serde errors may still pass through and are shown untranslated — **except
where the user typed the input that failed**: everything written into a project
folder maps its `io::Error` through `paths::folder_write_error`, so the wizard
only ever shows `err.acervo_dir_is_file` / `err.acervo_dir_not_writable` /
`err.acervo_dir_unusable`, each naming the next step.

The same rule governs every `gh` call (`git.rs::gh_failure`, ADR-0027): a failed
call becomes `err.github_unreachable` when `looks_offline` recognises the
*transport* failure, and the specific code of the act that failed otherwise —
`err.pr_read_failed`, `err.pr_review_failed`, `err.pr_merge_failed`,
`err.pr_reply_failed`, plus `err.pr_review_body_required`,
`err.pr_template_empty` and `err.pr_template_write_failed` for the refusals the
backend takes on its own. Raw gh English never reaches a toast.

`git push` goes through the same rule (`git.rs::push_branch`): git words a
transport failure its own way ("Could not resolve host"), which `looks_offline`
now recognises, so an offline push says `err.github_unreachable` instead of
forwarding git's English. The one failure that used to be pure gh prose — "a pull
request for branch … already exists" — no longer happens at all: sending a draft
that is already under review updates it (see `brain_propose_change`).

### 4.1 Commands (representative)

| Command | Args | Returns | Purpose |
|---|---|---|---|
| `start` | `cfg {model, lang, translate, threads, capture?}` | `()` / err | spawn the streaming engine (live mode) |
| `stop` | — | `()` | terminate the engine process (live mode) |
| `transcribe_file` | `path, cfg {model, lang, translate, threads}` | `()` / err | file mode: converts `path` to 16kHz mono WAV (ffmpeg) and transcribes it whole with `whisper-cli` (no VAD); runs off the main thread, streams results via `transcript-line`/`transcribe-state`/`transcribe-error` |
| `start_system_capture` | — | wavPath / err | meeting mode (ADR-0001 §2): spawn the ScreenCaptureKit sidecar recording system audio to a WAV; errors fast on a denied Screen Recording permission. The sidecar reports the epoch of its first written sample on **stdout** (`first-sample-epoch-ms <n>`) — the WAV's own t=0, kept per segment and handed to the frontend by the tail (ADR-0025) |
| `stop_system_capture` | — | `()` | stop the sidecar cleanly (close its stdin → it finalizes the WAV) |
| `transcribe_meeting` | `micPath?, sysPath?, cfg` | `()` / err | mix the mic and system-audio tracks (ffmpeg `amix`) into one 16kHz mono WAV and transcribe whole with `whisper-cli`; same events as `transcribe_file` |
| `save_recording` | `data, filename` | path | write a recorded buffer (e.g. file-mode audio or diarization capture) to `transcripts/` |
| `save_transcript` | `content` | path or `null` | native save dialog + write |
| `auto_save` | `content, dir, filename` | path | silent save to the configured folder |
| `list_capture_devices` | — | `[{index,name}]` | enumerate capture devices (for `-c`) |
| `list_models` | — | `[{id,label,sizeBytes,installed,default}]` | the transcription models Loro uses, each flagged installed or missing, for the first-run model manager (ADR-0006). `installed` means the file is *whole* — its size matches the pinned `spec.size`, so a truncated download reads as missing |
| `download_model` | `model` | `()` / err | download a catalog model into `~/.loro/models` over HTTPS (system `curl`), verify its pinned SHA-256, install atomically; emits `model-download-progress` (ADR-0006). Idempotent |
| `brain_get_config` / `brain_setup` / `brain_add_context` / `brain_remove_context` | … | config | acervo config lifecycle; `brain_setup` takes `template?` (usage preset id, ADR-0003) and `agent?` (per-acervo AI CLI command, default `claude`) |
| `brain_list_templates` | `lang?` | `[{id,name,description,contexts,builtin,dir?}]` | usage templates for the wizard (ADR-0003): builtins + `~/.loro/templates`, localized |
| `brain_duplicate_template` | `id` | dir path | copy a template into `~/.loro/templates` as an editable custom template |
| `ui_get_lang` / `ui_set_lang` | — / `lang ("pt"\|"en")` | lang | user-level UI language (ADR-0001 §10, ADR-0002 §1: generated content follows it); set relabels the tray live |
| `app_version` | — | version | the app version (`CARGO_PKG_VERSION`), shown in Settings so an update is visible at a glance |
| `brain_status` | — | status | contexts, inbox, processed, activity |
| `brain_read` | `rel` | content | read a file inside the acervo (path-traversal guarded) |
| `brain_import` | `context?` | count | copy files into the inbox (prefix `<ctx>--`) |
| `brain_import_files` | `destRel` | count | native file picker → copy chosen files into an `attachments/` folder — a brainstorming's or a context's (guarded, ADR-0005) |
| `brain_drop_into` | `paths, destRel` | `[rel]` | files dropped from the COMPUTER onto a folder of the tree: **moved** there (filing), never overwriting. Destinations are one rule (`guarded_drop_dir`): any folder of a non-versioned world (`brainstorming/`, `pessoal/`, `loops/<slug>/`) plus `contexts/**/attachments`; `inbox/` is refused by name — the fila has its own door and it COPIES (ADR-0028, extended 2026-08-18). Two refusals come before the first move: a source already inside the acervo (`err.drop_from_inside`, that is `brain_move_pessoal`'s job) and a credential headed for the versioned tree (`err.intake_secret:<name>`, ADR-0024) |
| `brain_new_note_in` | `destRel, titulo` | rel | create a living-front-matter note inside an `attachments/` folder (context counterpart of `brain_new_notebook`, ADR-0005) |
| `brain_delete_inbox` | `name` | `()` | delete an unprocessed queue item |
| `brain_set_auto_context` | `value: bool` | `()` | post-creation toggle (Settings) for autoContext — global config + local `.loro/settings.json` (ADR-0005 §3) |
| `brain_set_agent` | `agent` | `()` | post-creation edit (Settings → IA e terminal) of the active acervo's AI agent command; blank falls back to the default (ADR-0020) |
| `chat_send` | `{prompt, model, effort, permission, fresh}` | `()` | one chat turn: runs the acervo's agent non-interactively in the acervo dir with an explicit `--permission-mode` (print mode cannot ask, so without one every write is denied); streams `chat-delta`/`chat-tool`/`chat-tool-result` and ends with `chat-done` (ADR-0021) |
| `chat_cancel` | — | `()` | kill the running turn |
| `chat_reset` | — | `()` | drop the session id — the next turn starts a new conversation |
| `chat_status` | — | `{running,hasSession,agent}` | lets the UI recover its state after a window reload |
| `chat_handoff` | — | `"<agent> --resume <id>"` | the line that resumes this conversation in the embedded terminal, where the agent CAN ask interactively (ADR-0021) |
| `brain_new_tool` / `brain_delete_tool` | `nome, conteudo` / `rel` | rel / `()` | create (imported skill content) or delete a custom habilidade — any `.claude/commands/*.md` outside the 11 built-in skills (ADR-0005) |
| `brain_annotations_get` | `rel` | `{doc, anotacoes[]}` | read a document's annotation sidecar `<doc>.anotacoes.json` (empty if none); highlights/comments anchored by text-quote (ADR-0007). The sidecar is the MACHINE's file: no directory listing ever returns it (`SIDECAR_SUFFIX`) |
| `brain_annotation_add` | `rel, anotacao` | id | add a highlight/comment; returns the assigned stable `an_…` id (ADR-0007) |
| `brain_annotation_update` | `rel, id, patch` | `()` | patch an annotation — change `cor` and/or append a `comentario` (ADR-0007) |
| `brain_annotation_delete` | `rel, id` | `()` | remove a highlight/comment ("desgrifar") (ADR-0007) |

Addressable context (ADR-0026) — three **read-only** commands over
`contexts/**/context.md`, and nothing else. They never open `meetings/`,
`meeting.md`, `notes/` or the audit trail, so no transcript or PII can reach a
node, an edge or a term (BR-8); they write nothing anywhere (a test compares the
bytes of every document before and after the pass). All three are `async`: a sync
command runs on the main thread and scanning 80 documents there is the freeze
class of ADR-0022 §28, which a test now guards. One pass builds links, kinds,
hotspots, decisions, codes and title — no file is read twice — behind a cache
keyed by acervo + mtime + size of **each** `context.md`:

| Command | Args | Returns | Purpose |
|---|---|---|---|
| `brain_knowledge_graph` | — | `{nodes[], edges[], broken[], orphans[]}` | the lateral graph, computed on read. `nodes: {rel, context, title, hotspots[] (qualified `<ctx>#H-n`), decisions[], inlinks, outlinks}` · `edges: {from, to, kind}` where `kind` is `upstream\|downstream\|bidirecional\|""` **as the citing document declared it** (the reader inverts it, ADR-0026 §6) · `broken: {from, target}` with the target exactly as the author typed it · `orphans: [rel]` — a context with no lateral inlink (a parent indexing a child is navigation, not an edge; child → parent is). Edges are deduplicated by `(from, to)`, and a declared kind survives an undeclared duplicate |
| `brain_backlinks` | `rel` | `[{rel, context, kind}]` | who cites this document, and how. `rel` is the document rel (`contexts/<ctx>/context.md`), the same identity used by `edges` and `orphans` |
| `brain_index_terms` | — | `[{term, entries: [{rel, context, locator}]}]` | the índice remissivo's data. Terms come only from what is already written — the anchor text a neighbour chose, hotspot titles, decision slugs (date prefix stripped, full id in the locator) and cited external codes; no NLP, no stemming. `locator` addresses **inside** `rel` (`<ctx>#H-3` · `D-YYYY-MM-DD-slug` · `§n` · `MM-1147`, or empty for "in the document") — who cites whom is `brain_backlinks`' answer and is not duplicated here |
| `brain_set_ticket_base` | `base` | `()` / err | per-acervo base URL where cited external ids open (`Acervo.ticket_base`, Configurações → Projeto). `normalize_ticket_base` accepts **http(s) only** — anything else is stored empty and the locator stays unclickable — and appends the separator the URL needs |
| `brain_index_write` | — | `"TERMS.md"` / err | writes the índice remissivo to the acervo root, from the same `index_terms` the screen paints (ADR-0026 §1, revised). Deterministic — no model call — so it can be re-run at any time and never invents a term |
| `brain_status` | — | `{…, legacyLayout}` | `legacyLayout` is true when the acervo still has `contextos/`, `reunioes/` or `notas/` (ADR-0026 §20). The shell is not drawn: the screen states what happened and offers the migration, because a half-migrated tree hides knowledge without saying so |
| `brain_pii_scan` | — | `[{rel, kind, sample, count}]` | reports PII **candidates** in the versioned contexts — an e-mail with a dotted local part, a `nome.sobrenome` handle (ADR-0026 §17). Read-only by contract: it never edits, because a person's name and a product's name have the same shape. A functional mailbox (`sinistros@`) is a role and is not reported |
| `brain_topic_doc` | `rel` | `"<rel>/<file>"` / err | the topic document that EXISTS in that directory: `index.md`, or `index.md` in an acervo written before ADR-0026 §14. The frontend used to build this path by hand, in three places |
| `brain_meeting_set_origin` | `{id, origem}` | `origem` / err | records the open point a meeting came from (ADR-0026 §11), in `manifest.origem`. `normalize_origin` accepts **only** `<contexto>#H-<n>` or `D-YYYY-MM-DD-<slug>`; a path, a title or a sentence is refused with `err.origin_not_an_id` and the recorded value is left untouched. An empty origin is not serialized, so an old manifest stays byte-identical |

Extensions and loops (ADR-0029) — all `async` (they walk folders, hash files and
spawn the agent; synchronous, that happens on the main thread — ADR-0022 §28):

| Command | Args | Returns | Purpose |
|---|---|---|---|
| `brain_plugin_manifest` | `source` | `PluginPreview` | read-only: what a pacote is, what it would write, its **class** read from the TREE (never from the manifest), the intake findings, the destinations that already exist, and the declared parts this version does not install. Writes nothing, anywhere |
| `brain_install_plugin` | `source, hoje` | `{id, version, written[], skipped[], brings}` | copy the declarative parts in and record them in `.loro/plugins.json` (versioned: it is the project's policy). Refuses an executable class BY NAME (`err.plugin_kind_unsupported:<markers>`), a credential (`err.intake_secret:<file>`, BR-9), a path escaping the pacote root, an id already installed. Never overwrites, never shadows a built-in habilidade, and a loop it brings arrives **disarmed**. Commits nothing and pushes nothing — the files land in the working tree, where Revisão already shows them |
| `brain_list_plugins` | — | `[InstalledPlugin]` | what this acervo has installed, with what each pacote brought and a digest per file |
| `brain_remove_plugin` | `id` | `{removed[], kept[]}` | subtract what the pacote wrote. A file whose bytes changed after the install — or whose digest is unknown, or whose recorded path does not resolve inside the project — is **kept** and named: the record is versioned, so it arrives in someone else's commit and is treated as untrusted input |
| `loop_status` | `now` | `{loops[], running[], queued[], cycles[], agentBusy, paralelo, requests[], permite[], recusa[]}` | **the single authority** (§3.9): the sidebar row, the header mark, the ⟳ Loops tab and the loop's own screen all read this one answer. Each loop carries its definition, its runtime, its computed `state` and — when it cannot run — the `blocked` code that says why |
| `loop_tick` | `now` | `{started[], queued[], skipped[]}` | the clock's question: who is due? Decides with the LOCAL civil time the frontend hands it (`{epochMs, date, hh, mi, weekday}`), so a weekly rhythm is compared in the person's calendar and a sub-daily one is a duration — no timezone database in the core. A skipped tick is returned with its reason instead of being silence |
| `loop_run_now` | `slug, now` | `()` / err | run one cycle now: one agent turn, in the acervo, always `--permission-mode acceptEdits` (§4.9 — `bypassPermissions` is refused for an unattended cycle) **plus `--disallowedTools Bash`, always**: the mode auto-approves Bash, so «no commands, no git, read and edit the project» is that flag and not the mode (§8.8, measured from a session log). Re-checks everything the tick checked, and passes the loop's own `--model`/`--effort` when it has them (§4.16) plus `--allowedTools` with what the person allowed (§4.17) — every one of them re-derived from the definition at spawn time, because that document is versioned and arrives in someone else's commit |
| `loop_stop` | `slug` | `()` | kill the running cycle and release its lock |
| `loop_save` | `input` | rel | create or update a loop. The rhythm is validated here; the **scope is not re-openable** (§4.8) and its four shapes (`projeto`, `ideia:<slug>`, `pasta:<rel>`, `conhecimento:<slug>`) are normalized, with an unrecognized shape **refused** rather than widened to the project (§4.15). `modelo`/`esforco` ARE re-openable and are sanitized to a plain token |
| `loop_arm` | `slug, on` | `()` | turn it on/off; turning it on clears a backoff |
| `loop_enrich` | `slug, texto, hoje` | instruction | an adjustment made by talking becomes a DATED line inside the instruction, so the loop stays one readable document |
| `loop_delete` | `slug` | `()` | remove the definition and its runtime record. **What the loop produced stays** |
| `loop_policy` / `loop_set_policy` | — / `policy` | `LoopPolicy` | the project's own loop settings (the brakes a NEW loop is born with, and how many cycles may run at once), in `.loro/settings.json` |
| `loop_folders` | — | `[rel]` | the project's folders, three levels deep and nothing hidden — what lets the scope be CHOSEN instead of typed (§4.15). The field still accepts a typed path; this is the suggestion list |
| `loop_capabilities` | — | `[{id, label, kind, origin}]` | **what this project can offer a loop** beyond reading/editing itself (§4.17): the MCP servers `.mcp.json` declares, each with the pacote that brought it, plus the agent's own outward tools. DISCOVERED, never a list of connector names inside Loro — one installed today shows up today. `Bash` is deliberately absent (§4.3) |
| `loop_permit` | `tool, decision` | `LoopPolicy` | the PROJECT's decision about ONE tool — `permitir` · `recusar` (→ `--disallowedTools`, so a closed door is not «ask again») · `esquecer`. Written to `.loro/settings.json` and applied to every cycle of every loop (§4.18): the pending question is «may a cycle use X», so answering it once clears it on every loop that asked. Reachable from the request in the ⟳ Loops panel, from the amber block on a blocked loop, and from the «pode usar» control on a loop's screen. Does **not** run a cycle |

Brainstorming world + the fila → contexto flow (ADR-0001 §7):

| Command | Args | Returns | Purpose |
|---|---|---|---|
| `brain_create_brainstorm` | `{nome, categoria?}` | `{slug, rel}` | create a brainstorming under `brainstorming/` |
| `brain_list_brainstorms` | — | list | list brainstormings (with categoria) |
| `brain_list_meetings` | `slug` | `[{id,rel,titulo,status,notas}]` | a brainstorming's meetings, newest first, labelled by manifest `titulo`; `notes` counts how many of the meeting's `notes/` the fila would accept (0 = nothing to send, ADR-0018) |
| `brain_meeting_start` | `{tema, titulo?, cfg?}` | `{id, dir, livingRel, startedEpochMs}` | scaffold the meeting home + manifest + `meeting.md` and start the capture sidecar (capture first, so a permission denial leaves no orphan). `startedEpochMs` is the meeting's **t=0**, taken right before the spawn: both tracks convert their timestamps to it (ADR-0025) |
| `brain_meeting_finish` | `id` | `{rel}` | close a meeting: `status: "done"`, nothing authored; returns the `meeting.md` rel the UI opens (ADR-0018 — replaces `brain_meeting_build_notebook`) |
| `brain_meeting_rename` | `{id, titulo}` | `()` | rename a meeting (manifest + heading; the folder id stays stable) |
| `brain_meeting_transcribe_tail` | `{id, fromMs}` | `{segments[], nextMs, anchorEpochMs?}` | best-effort live window of the system track: snapshots the growing WAV, transcribes `[fromMs, end]` and returns **every utterance whisper timed**, each with its offset into that capture segment's WAV, plus `anchorEpochMs` — the WAV's own t=0, measured by the sidecar (absent until reported; the caller degrades) (ADR-0012, ADR-0025) |
| `brain_meeting_transcribe_segment` | `{id, data}` | `{segments[]}` | same for one rotated mic segment (bytes in, transient temp, nothing stored): each utterance with its offset into the segment (ADR-0012 model A, ADR-0025) |
| `brain_meeting_append` | `{id, chunk, tMs?, source?}` | `()` | append one block below the stable marker (append-only, ADR-0010); timed blocks land in chronological order, untimed ones (skills/legacy) at the tail |
| `brain_meeting_append_timed` | `{id, blocks[{tMs, source, chunk}]}` | `()` | a whole window's utterances in ONE pass — one read, one write, one `meeting-appended` — so the living surface repaints once instead of once per utterance (ADR-0025) |
| `brain_triage_files` | `rels[]` | `[{rel, findings[]}]` | read-only: what these files carry before they enter the acervo — `{severity, rule, line, count}`, NEVER the matched text (BR-8 binds the detector itself). A meeting expands to its `notes/*` through the same owner as the send path (ADR-0024) |
| `brain_meeting_pause` | `id` | `()` / err | stop the capture sidecar mid-meeting: NOTHING is recorded while paused. The segment already written stays in the pending list so its last window can still be transcribed (ADR-0022 §19) |
| `brain_meeting_resume` | `id` | `()` / err | open a NEW capture segment (`system-2.wav`, …). Its window offsets restart at zero and its place on the meeting timeline comes from the segment's own anchor, with the pause discounted on both tracks alike (ADR-0022 §19, ADR-0025) |
| `brain_rename_brainstorm` | `slug, nome` | `{slug, rel}` | rename a brainstorming (folder + meta) |
| `brain_set_brainstorm_category` | `{slug, categoria?}` | `()` | set/clear the UI grouping category |
| `brain_brainstorm_delete` | `{rel}` | `()` | delete a brainstorming item (guarded to `brainstorming/`) |
| `brain_rename_pessoal` | `rel, name` | new rel | rename a note/analysis file in place (world-confined, keeps extension, never overwrites — ADR-0003 §5) |
| `brain_move_pessoal` | `rel, destDir` | new rel | move a file into another folder of the same non-versioned world (brainstorming/pessoal); never overwrites — ADR-0009 |
| `brain_move_meeting` | `rel, destSlug` | new rel | move a whole meeting folder into another brainstorming's `meetings/`, rewriting the `tema` and the meeting's own paths in `manifest.json`, the `tema:` in `meeting.md`'s front matter, and every inbound ref across the non-versioned worlds and `.claude/commands/`; refuses a meeting still recording; never overwrites — ADR-0017 |
| `brain_abs_path` | `rel` | abs path | resolve an acervo-relative path to its absolute on-disk path (guarded to the acervo root); backs "copy absolute path" — ADR-0009 |
| `brain_send_files_to_queue` | `rels[], destContext?` | `name[]` | send the selected brainstorming files to the fila (`inbox/`), one item per file, steered by `<ctx>--`; validates all before writing any; rejects transcript/audio/audit (BR-8) |
| `brain_send_brainstorm_to_queue` | `slug, destContext?` | `name[]` | "enviar tudo → fila": send every queueable file of the brainstorming, each its own item |

Knowledge versioning & collaboration (ADR-0001 §5) — all opt-in, no credentials stored.
Every `gh` call runs with the user's **ambient** credential: no token is ever
requested, stored or logged (**BR-9**), and no command below logs a diff, a
description or a review comment — the log lines carry counts, review numbers and
`err.*` codes only (**BR-8**):

| Command | Args | Returns | Purpose |
|---|---|---|---|
| `brain_git_state` / `brain_git_files` | — | state / per-file status | local repo status (button label, VSCode-like tree colors). Both read `git status --porcelain -uall` through ONE authority (`pending_entries`), the same one `brain_git_diff` and the dirty-tree refusals use, so the count on the tab, the cards on the review screen, the sidebar's markers and "this draft cannot be switched" can never disagree (ADR-0027) |
| `env_doctor` | — | checklist + `versioningEnabled` + `offline` | validate git/gh/auth/identity/remote; gates the remote flow. `offline` tells a network failure apart from a missing configuration, so a connected machine with no network is never reported as unconfigured; each check carries `detail` AND `hint`, and the screen prints both |
| `env_set_identity` | `name, email` | `()` / err | the one safe wizard fix — sets git identity scoped to the acervo; the e-mail's shape is validated here (`err.git_identity_invalid_email`), because this identity signs every version the team reads |
| `brain_version` | `slug, message` | `{branch, saved, warn?, review?, pushed}` | Versionar (ADR-0002 §2): with nothing pending it refuses FIRST — no fetch, no draft, `saved:false`. Otherwise sync local default with origin (fetch + ff-only, degradable — `warn` = `err.git_offline`/`err.main_diverged`), then `rfc/<slug>` + add + commit (local) | **Not local-only since ADR-0027 round 6:** when the draft already carries an open review the commit is followed by the push that review reads, so `review` names it and `pushed` says whether it arrived (the commit must not be lost to a dead network). A draft with no open review pushes nothing. Runs off the main thread (`spawn_blocking`) because of that push, and invalidates the PR-list cache when it pushes |
| `git_branches` / `git_switch_branch` / `git_create_branch` | — / `branch` / `slug` | `{current, default, branches:[{name, docs, leaving}], dirty}` / branch / branch | branch-first flow (ADR-0002 §2): picker data, switch (blocked on dirty tree), create `rfc/<slug>`. Each stand carries what the branch KEEPS (`docs`) and what leaves the screen on the way there (`leaving`) — the price the picker states before the click. The new draft is rooted in the synced default only while that changes **nothing on disk** (`git diff --quiet HEAD <default>`); otherwise it starts from `HEAD`. Naming a draft is not a price the user agreed to pay, and on a project whose knowledge lives on a draft — every project until a review lands — the default branch is the empty baseline, so rooting there took the documents, `.github/` and the `.gitignore` off the disk (ADR-0027) |
| `term_status` | — | `{open, agentRunning}` | readiness handshake (ADR-0002 §4, ADR-0003 §3): skill invocations are injected only when the acervo's agent process lives under the PTY shell |
| `term_agent` | — | command string | the active acervo's AI agent command (frontend launches it in the PTY; non-Claude agents get skills as plain prompts) |
| `brain_propose_change` | `title, body` | `{number, url, updated}` | Propor: push the rfc/ branch, then `gh pr create` (the RFC) — gated. A draft that ALREADY has an open review is **updated**, never proposed twice (ADR-0027): the open reviews of that draft are read first (`open_reviews_for_branch`), the push IS what the review reads, and `pr_create` is reached only through `ProposeAct::Create`. `updated:true` says which of the two happened, so the screen can name it; it is also the author's route after `mudanças pedidas` |
| `gh_pr_list` / `gh_pr_status` | — / `number` | `{prs, ageMs}` / PR | read open PRs / one PR's review status via `gh --json`; backs the team half of the Revisão destination. `gh_pr_list` answers from a 30s cache shared with `brain_notifications` and returns the reading's AGE, so the screen can say when it is showing the previous one; any write to a review invalidates it. Both run off the main thread (`spawn_blocking`) |
| `brain_git_diff` | `rel?` | `[FileDiff]` | the working tree against HEAD, parsed by `diff.rs`; untracked documents render as all-add and the index is never touched; the ADR-0009/0013 quarantine applies exactly as on the save path (BR-8). The read path applies the `GIT_IGNORED` list ITSELF (`is_quarantined`, gitignore semantics, pure) instead of trusting the `.gitignore` on disk: that file is written only by WRITE paths, so an acervo created by an earlier release keeps the previous list until something saves — and that gap is how the intake's own bookkeeping (`.brain/state.json`, `.brain/activity.log`) opened the screen with two rows the person never wrote (ADR-0027). Writing it on a read is not an option: a read that changes the tree is not a read. An already-tracked quarantined file stays visible, because the next version is what takes it out of the index. A file marked `binary` carries no rows and no `+/−` counts: the card says it cannot be shown as text and must not also count lines it has nothing to show for |
| `gh_pr_detail` | `number` | `PrDetail` | one review, whole: description already split into the team template's sections, files, checks, reviews (with `stale`), conversation threads, `mergeStateStatus`. Three gh calls; `approvalsRequired` is deliberately absent (branch protection is not readable by a non-admin) |
| `gh_pr_diff` | `number` | `[FileDiff]` | the proposed change, through the same parser as `brain_git_diff` |
| `gh_pr_review` | `number, action, body` | `()` / err | decide: `action ∈ approve \| request_changes \| comment` (typed, so an unknown value fails before any subprocess runs); a blank body on the last two is refused here, not by the screen |
| `gh_pr_merge` | `number, headRef` | `()` / err | `--squash --delete-branch`; refuses first with `err.working_tree_dirty` when the head branch is current and dirty, because deleting it moves the working tree |
| `gh_pr_reply` | `number, commentId, body` | `()` / err | reply inside a conversation thread (`commentId` = the thread's first comment) |
| `brain_pr_template` | — | `{rel, sections, hints}` | the team's review template: first existing of five spellings wins; with no file, `rel` is the lowercase path this app scaffolds and `sections` come from the seeded template. `hints[i]` is section `i`'s own `<!-- … -->` sentence — the guidance the template hides in markup, which is what the field's placeholder says; a section with no comment has an empty hint |
| `brain_set_pr_template` | `sections` | `rel` / err | write the template into the **versioned** tree — it lands as a pending change and is reviewed like any other; does not commit, does not push. The sheet edits LABELS, so the writer puts back everything it was never shown: a section that survives keeps its whole block (`<!-- … -->` hint included — that sentence is the field's placeholder for the whole team), and the block before the first heading (an H1, a line to whoever is contributing, the team's own note) stays where it was. `previous` is the template the sheet was SHOWING, which on a project with no file of its own is the one this app ships — reading the file alone made the team's first save strip every sentence the sheet had just printed (ADR-0027) |
| `brain_open_link` | `url` | `()` / err | open a review (or an external ref) in the OS default browser: http(s) only, no whitespace/control characters, never through a shell (`err.unsupported_link_scheme`) —  |
| `brain_notifications` | — | inbox by category | collaboration inbox from open PRs; `connected:false` when local-only |
| `brain_timeline` | `rel?` | `[{id,when,author,label}]` | abstracted history (git log) for the timeline UI |
| `brain_migrate` | `apply?` | report | non-destructive `guia.md`→`context.md` + scaffolding (dry-run default). The one file it may rewrite instead of create is `.github/pull_request_template.md`, and only while the bytes are still exactly what Loro shipped (`is_shipped_pr_template`): the headings are the send-for-review sheet's field labels, so an old one keeps asking for the retired words, while a template the team wrote is the team's and is never touched |

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
| `loop-cycle` | `{slug, phase: "started"\|"ended", outcome?, err?, files[], startedMs}` | a loop's cycle began or ended (ADR-0029). `files` are the acervo-relative paths it created — an address, never content (BR-8) |
| `loop-tool` / `loop-tool-result` | same shape as `chat-tool` / `chat-tool-result`, plus `loop` | the steps of a cycle, on the SAME reader the chat uses (`chat.rs::handle_stream_line`, one parser for both channels). The `loop` field is what keeps a parallel cycle from painting into another's list; it is absent — and the payload byte-identical — for the chat |

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
  into `meetings/` or `notes/`, appends prose to `contexts/<c>/CHANGELOG.md`,
  updates `contexts/<c>/context.md` (consolidated in sections 1–5; anything still
  open/contradictory as a **hotspot** in section 6 — ideas are no longer files),
  moves raw to `processed/`, updates state. Suggests a new context when none fits,
  and splits a composite domain into recursive `contexts/<c>/<sub>/` subdomains
  (parent becomes overview + index), up to `MAX_CONTEXT_DEPTH` levels (ADR-0001 §4).
- **Efficient-reading layer (ADR-0004):** every `context.md` opens with a
  regenerated **Summary card** (§0); decisions carry stable IDs
  (`D-YYYY-MM-DD-<slug>`), hotspots carry `H-<n>`, and the `INDEX.md` line is
  enriched (description · updated date · hotspot range) so agents route without
  opening files. The generated `AGENTS.md` and every skill teach the protocol:
  index → card → ID search → targeted section read.
- **Addressing layer (ADR-0026):** what ADR-0004 left undescribed is the space
  *between* documents. The loop's `AGENTS.md` teaches a context to cite a
  neighbour with a **relative link whose target exists**, carrying its **kind** in
  one word (`upstream`/`downstream`/`bidirecional`) and only for a real handoff.
  Those links **are** the graph — nothing else is written: `brain_knowledge_graph`,
  `brain_backlinks` and `brain_index_terms` compute the neighbourhood, the return
  direction and the índice remissivo on every read, so no derived artefact can
  drift from the markdown. Hotspot ids stay local to their file and are
  **qualified on read** (`<ctx>#H-3`), never renumbered on disk. Measured on an
  80-context acervo: describing every context in `INDEX.md` moved hit@1 from 0,17
  to 0,50; the whole pass costs tens of milliseconds cold and 1,7 ms cached
  (ADR-0026, "Measurement").
- **External-source sync (`/loro-sync`, ADR-0005):** brings an
  external item — a Gemini note on Google Drive (full document), a Slack
  channel message, a Jira ticket, or a Confluence page (agent-written
  summaries) — into a LOCAL anexo file (`brainstorming/<tema>/attachments/`),
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
  filename IS the slash-command. 11 built-ins ship with the acervo
  (`/loro-context`, `/loro-analyse`, `/loro-question`, `/loro-ask`,
  `/loro-note`, `/loro-sync`, `/loro-tool`, `/loro-presentation`,
  `/loro-artifact`, `/loro-slack`, `/loro-digest`); built-ins can be edited but never deleted. Custom ones
  are created either by describing them to `/loro-tool` (AI drafts the
  skill, same dual create-or-evolve shape as `/loro-note`) or by importing
  an already-written skill file directly (`brain_new_tool`, no AI). Two lines
  of a skill's front matter are UI copy — `description:` (sidebar tooltip and
  the sentence of the "usar" sheet) and `argument-hint:` ("argumentos: …" and
  the placeholder of its field) — so both obey DESIGN.md §4, and seeding
  refreshes them in projects created by an older Loro
  (`templates::refreshed_front_matter`, only while the line is still a string
  Loro itself shipped). Listed
  in a sidebar section (usar/editar/pedir à IA/excluir-if-custom) and run
  from "⋯ → executar habilidade" on a brainstorming (curated picker,
  excludes the 5 workflow-specific built-ins with dedicated UI elsewhere),
  from the top of ANY open markdown document's viewer, or — unrestricted,
  no exclusion — from a single dropdown in a meeting's rail
  ("o que fazer com esta reunião" no longer lists fixed actions; those
  moved to the meeting's `⋯` menu). `/loro-presentation`/`/loro-artifact`
  generate material (markdown by default) into `attachments/` — a
  brainstorming's `brainstorming/<tema>/attachments/` or a context's
  `contexts/<c>/attachments/`; there is no separate presentations folder.
- **A loop's cycle (ADR-0029 §3.8):** the frontend's clock ticks every 30s (there
  is no scheduler in the core — decision §4.6a: a loop runs only while the app is
  open, and the screen counts what it missed while closed). The tick hands
  `loop_tick` the local civil time; `loops.rs` decides who is due, respecting the
  brakes, the backoff, one-cycle-per-loop, the project's parallelism and whether
  the PERSON is using the agent (a due cycle then waits its turn — it never
  cancels a conversation). `loop_run_now` spawns one agent turn with a prompt that
  states the destination, the reading scope (excluding the loop's OWN output — a
  loop whose output is inside its input feeds itself), the file brake and the acts
  a loop never performs (no git, no version, no send for review, nothing
  outbound). The brake is checked DURING the cycle, so hitting it ends the cycle
  instead of being reported afterwards. What came out is the difference between two
  listings of the destination — so the record never reads a byte of what was
  written. The runtime record keeps when, how long, which files and an `err.*`
  code, and nothing else (BR-8).
- **Knowledge versioning (ADR-0001 §5), Git hidden behind two buttons:**
  a project created with versioning on gets its **baseline commit** at setup
  (`ensure_baseline_commit`), so the official branch exists from day one — without
  it the first version renamed the unborn branch and approval had nothing to become
  official into. *Salvar versão do projeto* → `brain_version` puts the WHOLE acervo
  (`git add -A`, minus the ADR-0009/0013 quarantine) on `rfc/<slug>` and commits
  locally, signed with the user's own git identity. The quarantine
  (`git::GIT_IGNORED`) also covers the **intake's own bookkeeping** —
  `.brain/state.json` and `.brain/activity.log`, which every intake run rewrites
  (ADR-0027): the queue that feeds them (`inbox/`) and the queue it drains into
  (`processed/`) are already local-only, so neither file says anything to a
  teammate, and the activity log is prose an agent wrote over raw queue items, so
  versioning it is one more route from a transcript to a shared remote (BR-8).
  A pre-rule acervo carries them in its tree, and `.gitignore` does not apply to a
  tracked file, so the next version untracks them (`git rm --cached`; the files
  stay on disk), and the READ path applies the same list itself so an acervo whose
  `.gitignore` predates the rule never shows either file as a change the person
  made. `.loro/settings.json` stays versioned on purpose: `autoContext`
  is the acervo's policy, and it travels with the acervo. The draft is the one the user is
  already on (the description is the message, never the branch address), and a new
  draft starts from `HEAD` unless rooting it in the default branch would leave the
  working tree byte-identical. *Enviar para revisão do time* →
  `brain_propose_change` pushes that branch and opens the PR (the RFC) via `gh`,
  gated on `env_doctor`'s `versioningEnabled`, and its url is opened/listed through
  `brain_open_link` + `gh_pr_list`. Saving a version stays **local** — nothing
  leaves the machine on its own; the same *Enviar para revisão do time* is what
  carries a new version to a review that is already open, and it says so (`updated`)
  instead of asking gh for a second review of the same draft. Owners approve on GitHub via
  `.github/CODEOWNERS` + branch protection; merging into `main` makes the change the
  official source of truth. Local-only stays the default;
  `brain_notifications`/`brain_timeline` surface review status and history without
  exposing commits/branches to the user.

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
  model file; the only host contacted is the model mirror. Both the app and
  `loro.sh` stream into a temp file and move it into place only once verified,
  and a model is only *used* when its size matches the pinned one — a partial
  download can never become the active model.
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
| Meetings | living file + analyses in `notes/`, transient audio | ADR-0001 §8, ADR-0018 |
| Meeting AI | agent skills, local-first; WHERE they run is the user's choice (chat or terminal) since ADR-0022 §3 | ADR-0001 §9, ADR-0022 |
| Doc language | English | ADR-0001 |
| External-source sync | `/loro-sync <fonte>` (drive/slack/jira/confluence) → local anexo + ref, ambient terminal-agent connector | ADR-0005 |
| Habilidades (built-in + custom) | any `.claude/commands/*.md`; 11 built-ins, editable-not-deletable; `/loro-tool` (AI-drafted) or direct import for custom ones | ADR-0005 |
| Annotation layer | select a passage in any markdown → grifar/comentar + excerpt-scoped habilidade (perguntar/analisar/Slack); highlights/comments in a co-located `<doc>.anotacoes.json` sidecar anchored by text-quote; alvo `acervo://<rel>#<annot-id>`; outbound `/loro-slack` via the agent's connector | ADR-0007 |
| `autoContext` | per-acervo `.loro/settings.json` gate on the loop creating a brand-new context; toggle in wizard + Settings | ADR-0005 |
| Terminal launch/status | `active_agent()` used for auto-launch (not hardcoded); `justLaunched` grace window avoids retyping into a live session | ADR-0005 |
| Distribution | Homebrew Cask (`brew install --cask loro`) with `whisper-cpp`+`ffmpeg` as formula deps; tap `aipi/homebrew-loro` bumped by release CI | ADR-0006 |
| First-run models | not bundled; downloaded on demand over HTTPS, verified by pinned SHA-256, atomic install into `~/.loro/models`; a model is only used when whole | ADR-0006 |
| Design system | anatomy, tokens, vocabulary, components and the principles behind them live in `docs/DESIGN.md` — values there are taken from `style.css`, so the code wins when they disagree | ADR-0020/0021/0022 |
| UI anatomy | one shell everywhere: header 54px (project · nav pill · Record · ✦ AI) → sidebar 250/60px │ document tabs │ right panel 330px (Documento·Chat·Terminal); three destinations replace the numbered flow, no Home tab, no `ⓘ` tooltips | ADR-0020 |
| Theme | `data-theme` on `<html>`, preference `light\|dark\|system` resolved in JS; warm dark tokens (`#211e19`) | ADR-0020 |
| UI vocabulary | projeto · ideias · para organizar · conhecimento · **habilidades de IA** · salvar versão · enviar para revisão do time (internal terms unchanged in code/IPC/disk) | ADR-0020, renamed from "ações de IA" by ADR-0022 §7 |
| Brainstorming digest | **its UI is removed** — the ⋯ entry, the picker entry and the `index.md` staleness nudge are gone; existing `index.md` files stay as ordinary documents. The `/loro-digest` skill itself still ships as a built-in (listed in Habilidades de IA, runnable from chat/terminal) — what was revoked is the dedicated flow, not the skill | ADR-0020 (revokes ADR-0011) |
| Meeting markers | a single "momento" marker (`⌘⌥M`); the three typed markers and `⌘⌥1/2/3` are retired | ADR-0020 |
| Chat | runs the acervo's own agent CLI non-interactively (`-p --output-format stream-json`), multi-turn via `--resume`; no API call, no new credential (BR-1/BR-9). Print mode cannot ask for permission, so `--permission-mode` is always passed and is the user's choice (`acceptEdits` default \| `bypassPermissions`); a denial is detected on the `tool_result` and offers *liberar tudo e repetir* or hand-off to the terminal | ADR-0021 + amendment |
| Resizable panes | file tree, right panel and terminal dock all drag-to-resize and double-click-to-reset, persisted (`sideW`/`panelW`/`termH`) | ADR-0002 §6, ADR-0021 |
| Header axis | `#appHead` is a three-track grid (`1fr auto 1fr`) with both sides bound to their track (`justify-self: stretch`): the nav pill is window-centred while the sides fit their share and is **pushed**, never overlapped, when they do not. Replaces `position: absolute; left: 50%` + a predicted `1140px` breakpoint, which overlapped at the default 1280px window. What yields, in order: the project name (prose), then the draft chip (an address, kept whole in its `title`), then the `1015px` decoration/air ladder. Re-measurable: `make test-layout` | ADR-0020 |
| Wizard chrome | `paintWizardChrome()` is the single owner of "the new-project screen is showing" — both `hidden` flags, the `firstrun` class that strips nav/Record/✦ AI/panel, and a `renderSwitch()` so the project switch follows immediately. `openNewAcervo()` used to reveal the screen and leave the class to a ~10s poll, so the form wore the configured project's chrome until the tick. In that screen the switch hides its `⌄` and is truly `disabled` (`pointer-events: none` left it in the tab order, so Enter still opened the menu) with `aria-haspopup` dropped | ADR-0020 |
| Idea freshness | the ideas tree caps at 8 and keeps the most recent, so the sort key `atualizadoEm` decides what is VISIBLE. It is derived (`brainstorming_freshness`) from the mtimes of the idea's folder, its three groups and each meeting + that meeting's `notes/` — `meta.json`'s `atualizado_em` is only a floor. Read straight from the meta it was empty in every idea, the comparator returned 0 for every pair, and the idea holding the newest analysis was the one hidden. Shallow scan on purpose: it runs on the ~10s poll and stats directories only. Contexts are not capped | ADR-0013 |
| AI action target | user choice (Settings → IA e terminal): **chat** or **terminal**; a single `runAiCommand()` dispatches every habilidade, question and analysis | ADR-0022 |
| System file drop | ONE `tauri://drag-drop` router whose destination is the DROP POSITION (`dropDestinationAt` → `elementFromPoint`): `#panelChat` pastes the path into the composer at the cursor, `#termPanel` types it into the PTY **without `\n`** (a drop never executes), anything else keeps the fila import and its `_prompt.md` guard. The event position is typed `PhysicalPosition` but is in points on macOS/Linux and device pixels on Windows, so `dropPointCss` divides by `devicePixelRatio` **only** on Windows. Two quote rules, one per reader: shell (`zsh`/`cmd.exe`) for the terminal, prompt-string for the composer | ADR-0028 |
| Intake triage | content is inspected BEFORE entering the fila: a vendor-prefixed credential **blocks** (BR-9 — the acervo is versioned, so the door is one-way and re-checked in the backend), a CPF or a pasted transcript **warns** and the user decides. Closes the BR-8 hole where `is_queueable` judged by file NAME, so a transcript pasted into any other file walked in. Rules are narrow on purpose; the other three doors (`brain_import_files`, `/loro-sync`, AI notes) are not covered yet | ADR-0024 |
| Meeting pause/resume | pausing kills the capture sidecar (nothing reaches disk while paused); resuming opens a new segment. Audio stays a LIST of segments (`system.wav`, `system-2.wav`, …) that `purge_audio_core` sweeps whole; the clock excludes pauses and the system tail rebases (`tailBase` + `tailFrom`) so mic and system stay interleaved | ADR-0022 §19 |
| Recording indicator | the tray parrot blinks for a MEETING too, and stops while paused — `set_tray_recording` used to be called only by the loose-recording `start`/`stop` | ADR-0022 §21 |
| Spawned-agent environment | `proc::INHERITED_SESSION_MARKERS` is stripped from every child (and from the PTY): a Loro started inside another agent's session used to hand that session's markers to its own agent, which then disabled its transcript. A deny list, never a `CLAUDE_*` wildcard — user configuration shares the prefix | ADR-0022 §18 |
| Settings page | ONE scrolling page: every section visible, the nav scrolls to a section and a scroll-spy tracks it; the network check (`gh auth status`) still runs once per visit, when its section is first reached | ADR-0022 §22 |
| Document frame | the frame does not change with the mode: edit mode uses the SAME centered 700px card as view mode, the editor filling its height | ADR-0022 §23 |
| Blocking probes | `env_doctor` runs on the blocking pool (`spawn_blocking`) and only re-runs when the Versions/GitHub section is opened — as a sync command it froze the window on `gh auth status` | ADR-0022 |
| Addressable context | the lateral link written in the markdown IS the graph — kind in one word, target must exist. Read-only commands compute the neighbourhood, the backlinks and the índice remissivo on every read: **no index file is ever written** into the acervo. Hotspot ids qualified on read (`<ctx>#H-n`), never renumbered; a meeting cited by ID only; an external code linked only where the project configured a base URL. Refused with reasons: node-and-edge picture, mermaid, embeddings, typed catalogue | ADR-0026 |
| Extension as a package | a pacote IS a Claude Code plugin + `loro.json`; the class is read from the TREE, not the manifest; the executable class is refused by name; installing is a change that passes the intake triage and shows up in Revisão | ADR-0029 |
| Loops (standing AI work) | definition = versioned document (`loops/<slug>.md`), runtime = quarantined record; the CLOCK is the open app (no scheduler in the core), the local civil time comes from the frontend; one authority (`loop_status`) for every surface; seven states, of which **blocked** is the one that keeps «on» from lying; a cycle is `acceptEdits` only, never `bypassPermissions`; the scope may be POINTED at one folder or one context, and then the cycle is told to read only that (§4.15); the model and the effort are the loop's own (§4.16); what a cycle may reach OUTSIDE the project is **the project's** grant, never declared in advance but given in answer to a request that names the tool, applied to cycles only (the Chat keeps its own control), never grantable by a pacote, with `Bash`/`*` refused (§4.18) | ADR-0029 |
| Edit-mode formatting | markdown-aware bar (not WYSIWYG): pure `LoroMdEdit.apply(doc, anchor, head, action)` → CM6 `{changes, selection}`; `⌘B`/`⌘I`/`⌘K` captured off the editor DOM; same bar + CM6 in the Studio tab and the modal editor | ADR-0016 |
