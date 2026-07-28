# ADR-0001 — Baseline (consolidated technical decisions)

**Status:** Accepted
**Date:** 2026-07-28
**Authors:** Engineering
**Supersedes:** consolidates the former ADR-0001..0013 (this file's previous
v1-baseline version plus the twelve post-baseline ADRs); their individual files
were removed when this consolidation landed — git preserves full history. The
v1 baseline had itself consolidated the 38 pre-baseline exploratory ADRs.
**Superseded by:** —

> This is the **single ADR** of the project: one consolidated record of the
> technical decisions that define Loro today. New decisions amend this file (or,
> if the project returns to incremental ADRs, start again at `0002-…`). The
> product/business rationale lives in the brain (domain `loro`,
> `brain/contexts/loro/`); this file is the engineering *how*.

## Former-ADR map

Code comments and tests reference decisions by their former ADR number. They
resolve here:

| Former ADR | Topic | Section below |
|---|---|---|
| 0001 | v1 baseline (platform, engine, privacy, acervo, shell) | §1–§4 |
| 0002 | brain as a portable context harness by domain | §4 |
| 0003 | two transcription modes: live (VAD) and file (whole-recording) | §2 |
| 0004 | knowledge versioning & collaboration (context.md, RFC=PR, hotspots) | §5 |
| 0005 | meeting capture: mic + system audio, zero driver setup | §2 |
| 0006 | recursive subdomain contexts | §4 |
| 0007 | unified context tree (no duplicate folder view) | §4 |
| 0008 | Knowledge Studio workspace shell (tabs, palette, CM6) | §6 |
| 0009 | context flow vs individual production (worlds, refs, promotion) | §7 |
| 0010 | meeting living file, notebook, transient audio | §8 |
| 0011 | meeting-AI privacy contract (BR-1 cloud/MCP opt-in qualification) | §9 |
| 0012 | meeting AI via a terminal-Claude skill on the live stream file | §9 |
| 0013 | Brainstorming → Fila → Contexto flow + terminology | §7 |

A bare "pre-baseline ADR-000x" reference points at the 38 exploratory ADRs that
predated the v1 baseline (removed in `50804e7`); anything current is in this file.

## Context

Loro was built by fast iteration, each step recorded as its own ADR. Twice that
grew past usefulness: 38 exploratory ADRs were collapsed into the v1 baseline
(2026-07-24), and the twelve ADRs written since — the two transcription modes,
meeting capture, the versioned knowledge flow, the Knowledge Studio and its
Brainstorming → Fila → Contexto redesign — were consolidated here before opening
the repository (2026-07-28). The owner asked for exactly one authoritative ADR.

## Decision

### §1 Platform & engine

- Desktop app on **Tauri v2** (Rust core + system WebView, vanilla JS frontend,
  no bundler at runtime). Chosen over Electron/SwiftUI for a light, cross-OS binary.
- The transcription engine (**whisper.cpp**) is a **system dependency, never
  vendored**: `whisper-cli`/`whisper-stream` resolved from PATH + known locations
  (`/opt/homebrew/bin`…) or `WHISPER_STREAM_BIN`/`WHISPER_CLI_BIN`. GUI apps get a
  minimal PATH — the resolver and the embedded terminal (login shell) account for
  it. The same not-vendored pattern governs `gh` (§5) and the `claude` binary (§9).
- Diarization via **WhisperX** (offline, user's own HF token). Models are ggml
  files under `~/.loro/models`.
- The one native binary that IS ours: `syscap/loro-syscap.swift`, a small
  ScreenCaptureKit sidecar built by `make syscap` and bundled as a Tauri resource
  (§2, meeting capture).
- Backend split by concern (`paths`, `config`, `templates`, `acervo`, `meeting`,
  `git`, `ai`, core `lib`); TDD, `clippy -D warnings`, per-BR test coverage.

### §2 Capture & transcription

- **Live mode** — `start`/`stop` spawn `whisper-stream` (VAD); parsed lines
  stream to the UI as `transcript-line` events.
- **File mode** — record the whole session locally (`MediaRecorder`, no engine
  process while recording), then `transcribe_file` converts to 16 kHz mono WAV
  (ffmpeg) and transcribes it whole with `whisper-cli` (no VAD — more faithful
  than streaming). The heavy work runs on `spawn_blocking`, never on the
  command-dispatch thread; the same `extract_text` parser re-emits
  `transcript-line`, so the UI has zero mode-specific code paths. Events:
  `transcribe-state(bool)`, `transcribe-error(string)`.
- **Meeting mode** — "minha voz + áudio do sistema" with zero driver setup: a
  ScreenCaptureKit sidecar records system audio behind one Screen Recording
  permission (no BlackHole/Aggregate Device; that loopback path remains only for
  the plain "áudio do sistema" source), the frontend records the mic, and ffmpeg
  mixes late (`amix`, `normalize=0`, `duration=longest`) — perfect sync is
  unnecessary for a transcript. The sidecar stops on stdin EOF; a denied
  permission surfaces as an actionable error (exit code 4 + settings pane).
- **Live meeting transcript (pseudo-stream, Model A)** — during a meeting the
  transcript accretes live from rotated mic segments (~18 s) plus system-audio
  tail windows, each transcribed and appended as it arrives; whisper
  silence-hallucinations are filtered. There is NO second authoritative full
  pass at stop — the live preview IS the transcript (window-edge accuracy traded
  for a live, audio-less flow).

### §3 Privacy & security posture

- **BR-1 — inference is 100% local by default.** Audio and transcripts never
  leave the machine; **raw audio never leaves it under any circumstance**.
  BR-1 is *qualified, not weakened*, for meeting AI: nothing external runs until
  the user explicitly invokes it (§9).
- **BR-8 — logs are structural.** Structured English logs under `~/.loro/logs`
  carry event codes + numeric/enum fields only; `client_log` is a redaction
  boundary (no free-form content), markers/stats serialize type + timecode + ref
  and have no text field by construction.
- **BR-9 — no credentials.** No token/secret is ever requested, stored or
  logged; external tools (`gh`, `claude`) use their own ambient, user-owned
  credentials.
- `git`/`gh`/engine invocations use fixed argument tokens (never `sh -c`, never
  string interpolation); branch slugs sanitize to `[a-z0-9-]`; file IPC is
  canonicalize + `starts_with(acervo root)` guarded.
- A typed model-I/O choke-point (`ai.rs`: `ModelRunner`/`CloudInput`/
  `ConsentToken`) enforces the consent contract by construction — bounded
  current-meeting excerpt only, explicit per-call attachments, audio/base64
  rejected by type, per-meeting revocable consent, two-tier audit (local
  content-bearing `auditoria.jsonl` vs opaque call-ids in shared logs). It is
  **reserved for any future in-app model call**; the live meeting-AI path is
  gated by skill instructions + explicit user invocation instead (§9).
- Restrictive Tauri CSP (`default-src 'self'; script-src 'self'; img-src 'self'
  data:`); local images render via base64 `data:` URIs from a bounded,
  mime-allowlisted `brain_read_asset`.

### §4 The acervo — a portable context harness by domain

- The knowledge base ("acervo"/"brain") is a **user-chosen folder outside the
  codebase**, organized by generic, user-defined domains — no built-in taxonomy.
  Instruction file is agent-agnostic **`AGENTS.md`** (thin Claude command
  adapters). Multiple acervos (projects), one active, per-project color/language
  and optional git; removal only detaches (folder preserved on disk).
- **One source of truth per domain: `context.md`** (+ append-only
  `CHANGELOG.md`). Unconsolidated/contradictory knowledge lives inline as
  parseable **hotspots** (`> [!HOTSPOT]`), never as separate idea files —
  hotspots are the domain's evolution backlog.
- **Domains are recursive**: a context folder may contain subdomain folders of
  the same shape, discovered from disk, bounded by `MAX_CONTEXT_DEPTH = 6` (a
  safety limit, not a modeling constraint). When a domain becomes a composite,
  the loop splits it; the parent `context.md` becomes overview + index and
  cross-cutting topics get one canonical home.
- **One navigation**: the sidebar renders the recursive context tree only; a
  subdomain appears exactly once (`loadCtxChildren` skips subdirectories that
  are themselves contexts). Non-context grouping folders stay pure
  expand/collapse nodes.
- Ephemeral sources (fila/queue, meetings, prompt history) are **not versioned**.
- Structure detection is non-destructive: existing folders are respected, only
  gaps are filled.

### §5 Knowledge versioning & collaboration

- **A change proposal is an RFC = branch + Pull Request**, not a document. The
  edit lands directly in `context.md` (+ CHANGELOG); the PR is the RFC.
- **Git is hidden behind two actions**: *Versionar* = `git checkout -b
  rfc/<slug>` + add + commit (local-only, needs just git); *Propor mudança* =
  push + `gh pr create`, gated on a ready environment and refused from the
  default branch (main stays the source of truth).
- **Remote collaboration is opt-in.** An environment doctor (`env_doctor`)
  validates git/gh/auth/identity/remote reading only booleans, versions and the
  public login; the only wizard-applied fix is the git identity, scoped to the
  acervo repo. Approval happens on GitHub via `CODEOWNERS` + branch protection;
  the app only reads status (`gh --json`). `brain_notifications` derives a
  collaboration inbox from open PRs; `brain_timeline` shows history without
  surfacing hashes/branches.
- **Migration is non-destructive and idempotent** (`brain_migrate`, dry-run by
  default): `guia.md` → `context.md` via `git mv`, scaffolding created when
  absent, legacy folders reported, never deleted; world renames prefer an atomic
  rename and keep the original on cross-device copy errors; coexisting old/new
  worlds report a conflict and clobber nothing.

### §6 Knowledge Studio shell

- **`.bmain` is an editor group**: a tab strip over a scroll container; plain,
  serializable workspace state (`ws = {tabs, activeId, mru, closed, seq}`)
  mutated only through pure, node-testable `LoroWorkspace` reducers; live
  editor states live in a side map, disposed on close. No `currentDoc` shadow
  global.
- **Two view modes** — *visualizar* (markdown render) and *editar* (CodeMirror 6)
  — toggled by Cmd/Ctrl-E. Preview tabs (single-click, ephemeral, promoted on
  edit/pin); Home is a pinned first tab. `●` = unsaved buffer only; the git
  badge renders only on versioned-world tabs.
- **Two visually distinct worlds**: versioned (`contextos/`) vs non-versioned
  (`brainstorming/`, badge "rascunho — não versionado"), accent-striped so they
  are unmistakable at the tab surface.
- **Creation-first lists**: creation actions ("＋ novo brainstorming", "＋ nova
  nota", "＋ novo contexto") lead their lists instead of trailing them
  (2026-07-28). The brainstorming tree is flat: meetings sit directly under the
  brainstorming (no per-kind folder rows), with notas as a trailing subsection.
- **Command palette** (Cmd/Ctrl-P quick-open over `brain_list_all`; `>` or
  Cmd/Ctrl-Shift-P for commands), pt-BR verbs first, fuzzy match
  NFD-normalizing pt-BR diacritics. One capture-phase keyboard handler with
  focus-scoped precedence (the embedded terminal keeps all keys except palette
  + Esc); Cmd/Ctrl-W must `preventDefault` or the WebView closes the window.
- **CM6 is vendored as a pre-bundled IIFE**: a dev-only `tools/vendor-cm6/`
  (npm + esbuild, never shipped, never loaded at runtime) produces a committed
  `desktop/src/vendor/cm6.js` (+ css) exposing `window.LoroCM6` — the running
  product stays bundler-free, offline and CSP-safe; the blob is reproducible
  from pinned versions (`make vendor-cm6`).

### §7 The knowledge flow — Brainstorming → Fila → Contexto

- **Two disjoint on-disk worlds, quarantined by gitignore.** The non-versioned
  world is `brainstorming/<slug>/` (renamed from `pessoal/temas/…`; legacy
  `pessoal/` kept as a second ignore line until old acervos age out) with
  `reunioes/ investigacoes/ perguntas/ notas/ relatorios/`, a living `indice.md`
  and a `meta.json` (optional `categoria`, UI-only grouping). It is invisible to
  the context walk and can never enter a Versionar/Propor commit (also enforced
  by the `stage_and_commit` untrack list and a write guard refusing meeting
  audio/transcripts under `contextos/`).
- **The flow is three sequential, visible stages**: build an idea in a
  brainstorming → **elect** parts into ONE consolidated report that enters the
  **fila** (the existing `inbox/` queue — no new store) → **"gerar contexto"**
  runs the `/brain-context` loop skill, which distills the fila into versioned
  `contextos/`. What enters the fila is always the consolidated report
  (`brain_brainstorm_build_report` + `brain_send_report_to_queue`, steered by
  the `<ctx>--` prefix), never raw transcript or audio.
- **Direct promotion is retired from the primary path**: `brain_promote` (a
  non-destructive copy+rewrite with a deny-list — never audio, never audit
  files, refs rewritten so nothing dangles into the ignored world) remains an
  internal capability; the UI routes everything through the fila.
- **References are human-readable**: YAML front-matter (`refs`, relative paths)
  plus inline `ref:`/relative links resolved by the extended `data-path`
  handler — `.md` opens a tab, images render inline via `data:` URI, other
  types open in the OS default app (guarded to the acervo root).
- **PII-free markers**: markers are `{tipo, t_ms, ref}` only — no text field by
  construction (BR-8). The marker-COUNT surfaces ("Dúvidas: 0…" blocks in
  reports, the UI stats strip, and the `brain_stats`/`brain_brainstorm_status`
  commands) were later removed as noise (2026-07-28, "lean reports"); markers
  themselves still round-trip untouched in `meta.json`/manifest.
- The loop skill is **`/brain-context`** (hyphenated — a dot is not a valid
  Claude Code command name), materialized into each acervo's `.claude/` by
  `templates.rs` like all acervo skills.

### §8 Meetings — living file, notebook, transient audio

- **One canonical meeting home**: `brainstorming/<slug>/reunioes/
  <AAAA-MM-DD-HHMM>-<slug>/` containing `reuniao.md` (the living, append-only
  notebook), `relatorio.md` (the built report), `manifest.json` (the one
  join-table: references + metadata + PII-free stats; written atomically by the
  app only, behind a per-meeting lock) and `artefatos/`. One `brain_meeting_*`
  command family.
- **Audio is transient, not kept**: it exists only during the meeting and is
  deleted after the stop-flush (`brain_meeting_purge_audio`); the transcript is
  the durable artifact and nothing references stored audio.
- The meeting tab IS the live surface (the growing `reuniao.md` as a workspace
  tab); free-form editing is disabled while recording; appends land below a
  stable marker with a non-intrusive "novas linhas ↓" pill.
- **The report is lean** (`brain_meeting_build_notebook` → `relatorio.md`):
  Cabeçalho · Resumo · Decisões · Dúvidas & Respostas only. The boilerplate
  sections (Investigações, Dados & Gráficos, Linha do tempo, Transcrição —
  the transcript lives in `reuniao.md`, duplicating it was noise —, Referências,
  Estatísticas) and the marker-count blocks were removed (2026-07-28); the
  brainstorming-level consolidated report likewise carries no counters.
  Analysis markers arrive via a PII-free `marcadores.jsonl` sidecar folded into
  the manifest at build time. The meeting panel offers four actions: analisar ·
  responder · ver relatório · enviar para a fila. A meeting is labelled by its
  `titulo` (renameable, `brain_meeting_rename`); an untitled one is labelled by
  its date/time ("reunião 28/07 14:30"), never a bare folder name.

### §9 Meeting AI — a terminal-Claude skill, local-first

- **Execution = a skill run by the Claude already resident in Loro's embedded
  terminal** (`/brain-analyse`, `/brain-answer` — the same pattern as the
  `/brain-context` loop). The app injects the invocation into the terminal PTY;
  the app spawns no model process. *analyse* produces tema/decisões/riscos/
  inconsistências/perguntas as PII-free markers + artifacts and refreshes the
  report; *answer* answers an objective question with an optional artifact.
- **Local-first**: the skills read the meeting's live file + relevant
  `contextos/` (the local base) FIRST and may reach the internet/MCP only after
  exhausting it, stating what came from outside. They must never read another
  meeting's transcript or non-versioned notes they weren't pointed at, and they
  log what they read/produced to the meeting's local `auditoria.jsonl`.
- **Privacy reframe, stated honestly**: consent = the explicit act of invoking
  the skill (nothing leaves until the user runs it — BR-1's "local by default"
  = no skill run). Audio never leaves (skills read text only). The typed §3
  choke-point does NOT govern this path — the gate is skill instructions + user
  action, a documented reduction in by-construction enforceability accepted for
  fidelity to the terminal-loop pattern. The ambient `claude` binary may persist
  excerpts in its own store; this third sink is disclosed (`ai_doctor`).
  Cloud/MCP consent toggles and the audit view are not surfaced in the v1
  meeting panel; `brain_meeting_set_consent`/`brain_meeting_audit` remain in the
  backend for a future in-app model call. Per-connector MCP consent (default
  off) remains the contract for that future path.

## Consequences

**Positive** — one authoritative document; every former ADR number used in code
comments resolves through the map above; the privacy contract, the quarantine
between worlds and the not-vendored pattern are stated in one place; product
context stays decoupled in the brain; full fine-grained history is preserved in
git.

**Negative / trade-offs** — fine-grained rationale (each decision's alternatives
and review findings) now requires reading the git history of the removed ADR
files; a future contributor must amend a large document instead of adding a
small one (revisit if the single-ADR policy hurts); deferred work recorded in
the former ADRs (split panes, read-only-CM6 find unification, the in-app
`CloudRunner` transport, MCP connectors, end-user whisper packaging,
Windows/Linux system audio) is tracked as hotspots in the brain domain `loro`,
not here.

## References

- Product/business context: brain domain `loro` (`brain/contexts/loro/context.md`,
  including the immutable business rules `BR-1`/`BR-8`/`BR-9`).
- Architecture detail: `docs/ARCHITECTURE.md` (contexts, IPC contract, flows).
- History: `git log -- docs/adr/` (removed individual ADRs), `50804e7`
  (pre-baseline ADR removal).
