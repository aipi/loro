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
| `docs/adr/0002-….md` | Incremental ADRs from 2026-07-28 on (0002: Studio v2 — generation language, branch-first git, editor lifecycle, in-app manual; 0003: acervo usage templates & per-acervo AI agent; 0004: acervo efficient-reading layer — summary card, stable IDs, reading protocol; 0005: acervo as a work surface — `/loro-sync` external sources into local anexos, habilidades (built-in + custom), the three brainstorming folders + context anexos, `autoContext` with a real effect, the actions rail, per-acervo language, terminal launch bugfix; 0006: distribution via Homebrew Cask + first-run model download with SHA-256 verification; 0007: annotation layer — co-located sidecar highlights/comments anchored by text-quote, excerpt-addressable habilidades via `acervo://<rel>#<annot-id>`, outbound `loro-slack`; 0008: skill-generated meeting material lives in the meeting's `notas/` (supersedes ADR-0012's `artefatos/` subtree), legacy folders self-heal into `notas/`; 0009: move any file across the brainstorming tree (menu + drag-and-drop, `brain_move_pessoal`), copy a file's relative/absolute path (`brain_abs_path`), avulso rows get the ⋯ menu, and the brainstorming tree drops its item-count pills; 0011: brainstorming digest — `/loro-digest` (re)writes the topic's `indice.md` with a summary + key points + linked material index + `refs:`, manual and re-runnable with an `indice.md` staleness nudge (`digest_itens`/`LoroBrainstorm.digestNotice`); 0014: the fila receives the REAL selected files (one queue item per file), not a consolidated report — supersedes ADR-0013's merged relatorio; `brain_send_files_to_queue`/`brain_send_brainstorm_to_queue`, a meeting is queued as its `relatorio.md` and the raw transcript/audio/audit never enter the fila (BR-8; `acervo::is_queueable`)) |
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

```
loro/
├─ docs/            ARCHITECTURE, adr/ (the single consolidated 0001-baseline.md)
├─ brain/           this repo's own harness (product context, domain `loro`)
├─ desktop/         Tauri app
│  ├─ src/          frontend (vanilla JS; tests in tests/)
│  └─ src-tauri/    Rust core (cargo test --lib)
├─ loro.sh          CLI (setup, live, file, ui, diarize, test…)
├─ Makefile         quality targets
└─ CLAUDE.md · CONTRIBUTING.md
```

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
