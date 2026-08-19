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
| `docs/DESIGN.md` | How it LOOKS and BEHAVES — anatomy, tokens, vocabulary, components, and the principles each one came from. Read before drawing new UI |
| `docs/adr/0001-baseline.md` | The consolidated **baseline ADR**: all technical decisions up to 2026-07, with a map from the former ADR numbers still referenced in code comments |
| `docs/adr/0002-….md` | Incremental ADRs from 2026-07-28 on. Each file states its own decision — read the ones you touch instead of a summary here. The ones that govern CURRENT behavior and are most often mis-assumed: **0018** (the analysis IS the meeting's output — there is no report), **0020** (the UI anatomy, and the brainstorming digest it revoked), **0021** (the chat runs the acervo's own agent CLI; `--permission-mode` is always passed), **0022** (meeting pause/resume, raw mic capture, cross-track echo filter), **0022 §28** (the 18s freeze: the live-preview commands ran whisper on the main thread — third time for that bug class, now guarded by a test), **0024** (intake triage: a credential BLOCKS at the fila's door — the acervo is versioned, so that door is one-way), **0030** (the process PATH is HYDRATED once at startup — "from PATH" does not mean the PATH a GUI launch inherited; a probe and its own spawn must resolve through the same lookup). A number cited in code with no file resolves through the baseline map in `0001` |
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
concern, not left as one file. New code goes in the module that owns its
concern; a file that grows past its concern is split further. Keep functions
small and domain-named; no business logic in the Tauri `run()` wiring.

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
- **Diagnose from FACTS, never from deduction** (§7.1 below). A cause that was
  reasoned about is a hypothesis; only a measurement is a cause.
- **An ADR is for an architectural change or a NEW proposal** — nothing else.
  It is not for a code review, and not for a bug in functionality that is already
  mapped: fixing what a decision already promised is not a new decision. The
  reasoning behind a fix belongs where it will be read when someone next touches
  the line — the **code comment** (the *why*, with the measurement that proved it)
  and the **PR** — not in a new numbered file. When an existing ADR turns out to
  describe behaviour that never worked, amend that ADR instead of adding one.
  Trivial style → linter.
- **Nothing is by accident:** every change traces back to the brain source of
  truth or the ADR.
- **The app is not an experiment:** treat all code as production code.
- **Self-referential:** Loro documents its own domain in the same format it
  preaches for other apps (a `context.md` source of truth per domain + hotspots
  + RFC=PR — the self-contained knowledge base the app itself generates).

### 7.1 Facts before deduction — how to debug and how to change

**A plausible explanation is not a diagnosis.** Before claiming a cause, changing a
line because of it, or telling the developer what is happening, GO AND LOOK. Deduction
is for deciding *where to look*; it is never the finding itself. This rule was written
after a session where three confident explanations were each wrong, and each was
corrected in one command by the thing itself.

**Where the facts are, per kind of question:**

| Question | The witness — read it, do not reason about it |
|---|---|
| «why is this loop / meeting / acervo in this state?» | the **acervo on disk**: `~/.loro/config.json` names the active dir; then `loops/<slug>.md` (the definition) and `.loro/loops/<slug>.json` (the runtime record). A record that disagrees with the screen is the record that is right |
| «is this cut / misaligned / overflowing?» | **measure the real DOM**: `node tools/smoke-ui.js` (add a `step()`), or a scratch driver over the same harness with `SMOKE_SHOT=` and `sips -c … -Z` to look at the pixels. `getBoundingClientRect`, `scrollWidth` vs `clientWidth` — never an opinion about a stylesheet |
| «which CSS rule wins?» | `getComputedStyle` in that harness. Specificity read off the source is a guess: `.loopfield input` (class+type) silently beat `.mono`, and the markup asked for one family while the sheet painted another |
| «what does the agent CLI actually emit?» | the **stream**, not the shape you expect it to have. A denial arrives in the final `result` line as often as in a `tool_result`; a mechanism verified only against the imagined shape is verified against yourself |
| «does this string / path / command exist?» | `grep`, `ls`, `cargo test`, `node --check`. Never «it should be called…» |

**Three rules that follow from it:**

1. **A fix carries its measurement.** The code comment says the *why* WITH the number
   («pede 177px em 166px», «9 passos, 1 arquivo, registrado como impedido»). A comment
   that only says what the code does is noise; a measurement is the fact the next
   person needs and cannot re-derive.
2. **A test for a defect must be shown to fail without the fix.** Disable the fix, run
   it, watch it go red, put the fix back. A green test that never could have been red
   is a claim, not a guarantee — and it is worse than no test, because it is believed.
3. **When surface and store disagree, the store is the witness.** The screen is
   derived; the file is what happened. Reading the record first would have skipped two
   of the three wrong explanations above.

**And say which it is.** «I measured X» and «I think X» are different sentences. When a
fact is not available, name the assumption you are proceeding under — never present a
deduction in the voice of a finding.

## 8. How to plan a task

1. Read the relevant brain domain (`context.md`) and the ARCHITECTURE section.
2. If anything is unstated, **ask** — do not assume. And if the task starts from a
   DEFECT, get the fact first (§7.1): the record on disk, the measured DOM, the real
   stream. Do not open an editor on a hypothesis.
3. List the test scenarios (including each BR touched).
4. Confirm the IPC/command contract.
5. Write a failing test.
6. Implement the minimum to pass.
7. Refactor; comment only the *why*.
8. If — and only if — the change is **architectural or a new proposal**, record it
   in the ADR series (`docs/adr/`). A fix, a review finding or a defect in mapped
   functionality gets a code comment and a PR description, never a new ADR.
9. **Docs sweep (ADR-0002 §7):** for every feature added or changed, evaluate
   and update the in-app manual (`desktop/src/manual.pt.md` + `manual.en.md`),
   the ADR, `README.md` and `docs/ARCHITECTURE.md`. Structural docs are never
   optional; the manual is updated whenever user-visible behavior changes.
10. Run `make test` and `make lint`; ensure the app still works (`LORO_SELFTEST=1`).
