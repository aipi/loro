# CLAUDE.md — Loro

This document is the base of the project. It tells any contributor (human or AI)
how to work here. Nothing volatile belongs in this file — mutable technical
decisions live in `docs/adr/`.

> **DO NOT ASSUME PREMISES.** If something is not stated in the sources of truth,
> ask the responsible developer. The developer is the anchor of the project: the
> AI proposes, the developer decides, an ADR records it. What is decided gets
> written down.

## 1. Project summary

Loro is a local, privacy-first desktop app (Tauri v2) that transcribes speech in
real time and builds a per-context knowledge base from the transcripts. Read
the brain domain `loro` (`brain/contexts/loro/`, business/product) and
`docs/ARCHITECTURE.md` (technical) before changing anything.

## 2. Sources of truth & precedence

Product/business context lives in the **brain** (this repo dogfoods its own model,
domain `loro`); technical decisions live in the code repo.

| Document | Role |
|---|---|
| `brain/contexts/loro/context.md` | What the product is, its rationale, and the immutable business rules (`BR-…`) |
| `docs/ARCHITECTURE.md` | How it is built (contexts, IPC contract, flows) |
| `docs/adr/0001-baseline.md` | The consolidated **baseline ADR**: all technical decisions up to 2026-07, with a map from the former ADR numbers still referenced in code comments |
| `docs/adr/0002-….md` | Incremental ADRs from 2026-07-28 on (0002: Studio v2 — generation language, branch-first git, editor lifecycle, in-app manual; 0003: acervo usage templates & per-acervo AI agent; 0004: acervo efficient-reading layer — summary card, stable IDs, reading protocol; 0005: acervo as a work surface — `/loro-sync` external sources into local anexos, habilidades (built-in + custom), the three brainstorming folders + context anexos, `autoContext` with a real effect, the actions rail, per-acervo language, terminal launch bugfix; 0006: distribution via Homebrew Cask + first-run model download with SHA-256 verification; 0007: annotation layer — co-located sidecar highlights/comments anchored by text-quote, excerpt-addressable habilidades via `acervo://<rel>#<annot-id>`, outbound `loro-slack`; 0008: skill-generated meeting material lives in the meeting's `notas/` (supersedes ADR-0012's `artefatos/` subtree), legacy folders self-heal into `notas/`; 0009: move any file across the brainstorming tree (menu + drag-and-drop, `brain_move_pessoal`), copy a file's relative/absolute path (`brain_abs_path`), avulso rows get the ⋯ menu, and the brainstorming tree drops its item-count pills; 0011: brainstorming digest — `/loro-digest` (re)writes the topic's `indice.md` with a summary + key points + linked material index + `refs:`, manual and re-runnable with an `indice.md` staleness nudge (`digest_itens`/`LoroBrainstorm.digestNotice`); 0014: the fila receives the REAL selected files (one queue item per file), not a consolidated report — supersedes ADR-0013's merged relatorio; `brain_send_files_to_queue`/`brain_send_brainstorm_to_queue`, a meeting is queued as its `relatorio.md` and the raw transcript/audio/audit never enter the fila (BR-8; `acervo::is_queueable`); 0015: release by PR — `make release VERSION=x.y.z` opens a `release/*` PR that only bumps the version, and merging it ships (`release.yml` also triggers on a merged `release/*`, builds the `.dmg`, and `gh release create`s the tag+release); pushing a `v*` tag stays as the manual escape hatch; 0016: markdown formatting bar in the edit modes — markdown-aware, NOT WYSIWYG (a rich-text serializer was declined: git-diff churn, ADR-0007 anchors, front matter), pure commands in `mdedit.js`/`LoroMdEdit`, and the modal editor drops its textarea for the same CM6 + bar; 0017: moving a meeting moves its FOLDER (`brain_move_meeting`, menu + drag), rewriting the `tema` and the meeting's own paths in `manifest.json`, the front-matter `tema:`, and every inbound ref across the non-versioned worlds — refused while still recording, and every mutating meeting command now locks *before* it resolves its directory; 0018: the analysis IS the meeting's output — `relatorio.md` is removed (`brain_meeting_finish` only sets `done`), a meeting is queued as its `notas/*` through the single owner `acervo::meeting_queueables` (BR-8 untouched), `/loro-digest` reads manifest + `notas/`, the end of a recording OFFERS the analysis instead of running it, and a legacy report is deleted on first listing — an explicit derogation from the non-destructive premise; supersedes ADR-0001 §8, ADR-0011's meeting source and ADR-0014 §2; 0020: UI simplification — one anatomy (header 54px · sidebar 250/60 · document-only tabs · right panel 330px), three destinations replacing the numbered flow, simplified vocabulary (projeto/ideias/para organizar/conhecimento/ações de IA — renamed to **habilidades de IA** by 0022), selectable theme with warm dark tokens via `data-theme`, and deliberate removals: the brainstorming digest (**revokes ADR-0011**), typed meeting markers, the home stats/bars/feed/1·2·3 strip/ghCard and every `ⓘ` tooltip; 0021: a functional chat — the Chat tab runs the acervo's OWN agent CLI non-interactively (`-p --output-format stream-json`, multi-turn via `--resume`, prompt over stdin) and streams the answer into the thread instead of routing to the terminal; no API call and no new credential (BR-1/BR-9); a permission denial surfaces a choice (`chat_handoff` — see the amendment) instead of a dead end; model+effort are one control; and every side pane (tree, right panel, terminal dock) drags to resize with a shared grip, persisted); 0022: usability pass — the chat shows it is working (thinking indicator + a step per tool), a recording meeting gets the clock and "encerrar" on its own surface, a meeting with no analysis offers ✦ analisar instead of an empty arrow, `env_doctor` becomes async (it was what froze the trip into Settings — `gh auth status` is network on the main thread), where an AI action runs becomes a setting (chat|terminal) behind a single dispatcher, the sidebar sections collapse, the Settings/wizard fields become one two-column grid, `＋ Novo tema` moves to the top, the terminal's × goes, first run hides nav/record/panel, and the header shows the version; meeting pause/resume is explicitly out of scope — it needs capture segmentation and tail rebasing; second round: "ações de IA" becomes **Habilidades de IA**, the sidebar's ✦ analisar carries its own row's folder (it used the open tab's — hence "não encontrei a pasta", or analysing the wrong meeting), Gravar/Parar get a pending state, /loro-sync's sources come from the habilidade's own `argument-hint`, and the copy stops promising the terminal (`aiTargetHint()`); third round: ONE recording footer shared by the loose recording and the meeting (a container query keeps it inside the content column), "escrever uma nota" opens a blank markdown and the destination is chosen on save (`loro://nova-nota`), the sidebar re-fills its OPEN folders after a skill writes, and three regressions go (a clipped floating menu, the legacy chip rule squeezing the `<details>` step, a busy refusal written into the answer bubble); fourth round: the destinations pill is centred on the window (absolute — both header blocks change width with their content), edit mode stops shrink-wrapping to its content (`#bDocWrap` aligned `flex-start`, right for reading, wrong for editing), and Loro's spawned agent stops inheriting ANOTHER agent's session markers (`proc::INHERITED_SESSION_MARKERS`, stripped in `command()` and in the PTY — a deny list, never a `CLAUDE_*` wildcard: the CLI was silently disabling its own transcript); fifth round: meeting pause/resume SHIPS (supersedes this ADR's own "Explicitly NOT done": pausing kills the sidecar — nothing is captured while paused, `syscap_pending` becomes a segment list landing as `system.wav`/`system-2.wav`…, the clock excludes pauses and the system tail rebases via `tailBase`+`tailFrom`, purge sweeps `system-*.wav`), the footer controls move LEFT of the clock with ⏸ pausar and Encerrar restyled as the same red pill as Parar, and the tray finally blinks for meetings (`set_tray_recording` was loose-recording-only); sixth round: Settings becomes ONE scrolling page (the nav scrolls to the section, a scroll-spy highlights it, `gh auth status` still runs once per visit when its section is first reached) and edit mode uses the SAME centered 700px card as view mode — the frame never changes with the mode, only the content; and a documentation audit closed the drift: the duplicate ADR-0014 (the Windows ToolHelp one, cited by nobody) becomes **0023**, the never-written "ADR-0019" stops being cited (the denial flow is recorded in 0021), ARCHITECTURE gains the pause/resume commands and five decision rows, `context.md` stops saying meeting AI is terminal-only, the mic is requested RAW (`{ audio: true }` turned on the system's voice processing — AGC flattened the user's voice and the whole machine's output went muffled; Loro is a recorder and plays nothing, so the echo cancellation it was paying for cancelled nothing) — and its other half: with speakers the mic re-hears what the system already captured, so the SAME speech landed in both tracks; a cross-track echo filter (`LoroMeeting.echoOfOtherSource`, thresholds set against the real capture: 0.92 containment for the echo, 0.13 for unrelated speech) drops the duplicate, and a Settings toggle kills the leak at the source for whoever needs correct attribution, at the stated price — and the filter turned out to be INERT: both tracks rotate on the same 18s interval, so the two copies arrived before either was recorded (the record happened after the await); the log proved it with zero drops against a 0.91 pair, and partial overlap (own speech + leak, below the drop threshold by design) now nudges toward the echo-cancel control instead of being silently discarded; and an independent review swept 15 defects — the meeting marker was dead since ADR-0020 (UI sends `momento`, the Rust allow-list still held the four legacy kinds), the chat could deadlock on an undrained stderr, `wait()` under the global mutex froze every chat command, a denial was erased by the last line of the stream, sessions crossed projects via `--resume`, slash commands went raw to non-Claude agents, the pause rollback could re-transcribe the whole meeting, two carves shared one snapshot file, the editor read the OS theme instead of `data-theme`, and Organizar's checkbox promised a selection nothing read; and the i18n suite finally covers `index.html` — half the msgids lived there untested, and eight had no English pair; and the ADR-0021 amendment: the chat in -p mode CANNOT ask for permission, so `--permission-mode` is now always passed (measured: without it every write is denied WITH `is_error:false`) and is the user's choice — `acceptEdits` (reads/edits the project, default) or `bypassPermissions` (also external connectors and paths outside the folder); denial is detected on the `tool_result`, not at the end of the turn; steps become `<details>` carrying request/response (capped at 2000 chars); `chat_add_dir` goes for having no caller left) |
| `CLAUDE.md` | How to work (this file) |

**Precedence on conflict:** brain domain source-of-truth > ARCHITECTURE > ADR > CLAUDE.md.

## 3. Immutable business rules

Business rules live in the brain source of truth (`brain/contexts/loro/context.md`,
"Business rules"). Tests must cover each explicitly, naming the rule (e.g. `BR-1 —
inference stays local`). Never weaken a BR without a recorded ADR decision.

## 4. Engineering principles

- **TDD by default:** red → green → refactor. A change starts with a failing test.
- **Clean Architecture:** the domain does not know the framework; dependencies
  point inward. Keep Tauri/IPC/FS at the edges.
- **SOLID / DRY / KISS, no overengineering.** Prefer the simplest design that
  meets the rule. Small, well-named functions that respect their domain.
- **IPC-first:** define the command/event contract (ARCHITECTURE §4) before
  implementing.
- **Quality and security are premises**, not options (ADR-0001 §3).

## 5. Project structure

The transcription engine (whisper) is **not** in the repo — it is a system
dependency (ADR-0001 §1).

**Backend module layout (clean-core premise).** `src-tauri/src/` is split by
concern, not left as one file: `paths.rs` (data dir / models / engine
resolution), `config.rs` (multi-acervo global config + migration),
`templates.rs` (acervo instruction templates), and `lib.rs` (Tauri wiring, IPC
commands, audio/transcription, tray). New code goes in the module that owns its
concern; a file that grows past its concern is split further (target modules:
`acervo`, `transcription`, `git`). Keep functions small and domain-named; no
business logic in the Tauri `run()` wiring.

## 6. Conventions

- **Language:** code, comments, logs and all documentation (brain, ADR,
  ARCHITECTURE, this file) are in **English**. The product UI is **pt-BR by
  default with a user-selectable English toggle** (ADR-0001 §10; pt-BR strings
  in code are the i18n msgids). The layout must not change without a design
  decision.
- **Naming:** ubiquitous language — names reflect the domain, per language idiom
  (Rust snake_case, JS camelCase). Claude Code command/skill files use **hyphenated**
  names (`loro-context`, `loro-analyse`, `loro-question`), never a dot — a dot is
  not a valid Claude Code command name.
- **Comments:** default is none; comment the *why*, never the *what*; reference
  `BR-`/`ADR-` when relevant.
- **Logs:** structured, English, event-oriented; never contain transcript
  content, PII or secrets (BR-8).
- **Dates:** ISO 8601.

## 7. Working philosophy

- **Never assume premises** (§ top). Ask; then record what was decided.
- **The ADR records everything non-trivial**: amend `docs/adr/0001-baseline.md`
  (or, if the project returns to incremental ADRs, add `0002-…`). Trivial style → linter.
- **Nothing is by accident:** every change traces back to the brain source of
  truth or the ADR.
- **The app is not an experiment:** treat all code as production code.
- **Self-referential:** Loro documents its own domain in the same format it
  preaches for other apps (a `context.md` source of truth per domain + hotspots
  + RFC=PR — the self-contained knowledge base the app itself generates).

## 8. How to plan a task

1. Read the relevant brain domain (`context.md`) and the ARCHITECTURE section.
2. If anything is unstated, **ask** — do not assume.
3. List the test scenarios (including each BR touched).
4. Confirm the IPC/command contract.
5. Write a failing test.
6. Implement the minimum to pass.
7. Refactor; comment only the *why*.
8. Record a non-trivial decision in the ADR series (`docs/adr/`).
9. **Docs sweep (ADR-0002 §7):** for every feature added or changed, evaluate
   and update the in-app manual (`desktop/src/manual.pt.md` + `manual.en.md`),
   the ADR, `README.md` and `docs/ARCHITECTURE.md`. Structural docs are never
   optional; the manual is updated whenever user-visible behavior changes.
10. Run `make test` and `make lint`; ensure the app still works (`LORO_SELFTEST=1`).

## 9. What this file does NOT do

It does not replace the brain source of truth or ARCHITECTURE, it does not pin
the stack (that is the ADR), and it is not a changelog.
