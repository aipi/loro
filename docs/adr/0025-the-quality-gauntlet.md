# ADR-0025 — The quality gauntlet: what eight rounds against the bar decided

- Status: accepted
- Date: 2026-08-12
- Extends: ADR-0001 (§5 versioning/RFC=PR, §10 pt-BR msgid + stable `err.*`),
  ADR-0002 §2 (branch-first flow), ADR-0005 (habilidades), ADR-0007 (annotation
  layer), ADR-0009 (refs and the versioning quarantine), ADR-0018 (the meeting's
  output), ADR-0020 (anatomy, vocabulary), ADR-0022 (usability pass), ADR-0024
  (intake triage)
- Supersedes: `save_transcript` as the destination of the end-of-recording bar.
  Everything else here settles behaviour that was never written down — and was
  therefore wrong in the places listed below.

## Context

A quality loop drove the running app against a fixed bar (flows that close end to
end · DESIGN.md §1 as usability tests · WCAG 2.1 AA, verifiable · 100% DESIGN.md
and the tokens), with independent critics inspecting the artifact — screenshots,
measured values, replayed command sequences — rather than the code's intentions.

Every decision below was forced by a defect reproduced in the running app, not by
taste. They are consolidated here as one record because they were taken in one
piece of work, and because most of them are the same principle applied in
different rooms: **the interface may not assert what it has not established.**

## Decisions

### 1. A loose transcription lands in an ideia, not in a file dialog

The end bar asked "guardar no projeto?" over a button reading "Salvar em ideias",
and called `save_transcript` — the native OS save panel. Nothing reached the
acervo; the only other exit destroyed the text.

A loose transcription is captured material, so it lands where captured material
lives: **as a note of an ideia**. The button's promise is the specification. It
asks for the two things the app cannot know (a title, which ideia) and writes
through the commands that already own that world — `brain_new_notebook`, then
`brain_read` + `brain_write` to put the transcript *under* the living front
matter rather than replacing it — then opens the note as a tab and names the path
in the toast. No new IPC command.

**Never conhecimento:** `contextos/` is the versioned world, and BR-8 keeps
transcript content out of it (`is_versioning_denied` enforces it). The picker
lists ideias plus "soltas (sem ideia)", so a brand-new project still has an
honest destination. The native panel survives as a differently-named secondary,
**Exportar arquivo…**, so the capability stays true to ARCHITECTURE §4.

### 2. The collaboration flow is honest end to end

The surface carrying "nada fica oficial sem a sua aprovação" was broken from the
first click to the last. Seven rules, each testable:

1. **A version lands on the draft the user is already on.** The description is
   the commit message, never an address; the draft changes in the **⎇** picker
   and nowhere else. Previously the description was used as both, so a second
   version moved the work to another draft and the first one vanished from the
   open document.
2. **A project owns an official branch from day one.** `brain_setup` calls
   `ensure_baseline_commit`, idempotent and best effort. Before this, `git init`
   left no commit, the first save renamed the unborn `main` into `rfc/<slug>`,
   and approval had nothing to become official *into*.
3. **A version is signed by the user.** `identity_args` fills only the half git
   cannot resolve, and `set_identity` validates the e-mail's shape at the
   boundary (`err.git_identity_invalid_email`). The commit used to pass
   `-c user.name=Loro`, the *highest*-precedence identity in git, so the doctor's
   "corrigir" changed nothing and the team read a bot as the author.
4. **The review is reachable and the app opens it**, through a narrow http(s)
   opener that never goes through a shell — on Windows too (`rundll32` instead of
   `cmd /C start`). BR-9 is untouched: no credential is read, stored or logged.
5. **The surface names its whole-project scope**, because that is what versioning
   does; it sat in a per-document section saying nothing.
6. **With versioning unavailable it points instead of promising** — three states
   from the same authority the button reads, not two.
7. **A refusal is a fact, decided before anything changes.** `save_version` owns
   refuse → sync → branch → commit and returns a stable outcome code, never a
   sentence in one language; `pending_changes()` is the single authority the
   counter and the refusal share, so "tudo salvo ✓" and "nada para versionar" can
   never disagree.

### 3. Switching drafts states its price

Clicking "(principal)" silently deleted the whole knowledge base from disk (42
files → 18): the baseline was an empty commit, so checking it out removed every
versioned file, with a `toast("⎇ main")` as the only feedback.

`git_branches` now returns, per branch, what its tree **keeps** and what would
**leave the screen**. Every row prints it, in its accessible name too. When
anything would leave, the switch goes through a confirmation stating how many
documents leave, that **nothing is deleted**, that they stay on the current draft,
and which draft to return to.

### 4. The words the backend hands the user

A folder that cannot hold a project answers with a stable code, never an errno:
`err.acervo_dir_is_file`, `err.acervo_dir_not_writable`, `err.acervo_dir_unusable`
— each naming what is wrong *and* the next step, in both languages. Inspection
still runs before any disk write, so ADR-0024's one-way door is untouched.

`argument-hint:` is UI copy like `description:`, written in the vocabulary of the
screen in both languages; the skill's **body** keeps the exact contract the agent
needs. The refresh reaches projects that already exist, rewriting only lines Loro
itself shipped — anything the user edited is never touched.

### 5. The app proves it boots

Four `data-i18n-attrs` values were space-separated; `applyI18n` derived an invalid
attribute name, threw at module top level, and **the window rendered nothing** —
while 518 tests and a clean lint stayed green, because no suite executed the boot
path.

`data-i18n-attrs` is comma-separated, `applyI18n` splits on `/[,\s]+/` and ignores
a token that cannot be an attribute name, and `desktop/tests/boot.test.js` runs
the shipped applier over the shipped `index.html` on a minimal DOM that enforces
the two browser rules the bug lived in. The i18n scanner stopped sharing the
applier's premise: a token that does not name a present attribute is a failure,
never a silent skip.

### 6. The reading surface is typed, and the small lies are gone

A document's `h3` was indistinguishable from a bold phrase and `h4` smaller than
body; a code block had the card's own fill (1.00:1) and code compounded to
10.48px; a table's header rewrote the author's words in uppercase mono; the raw
`[!HOTSPOT]` marker reached the reader. The reading surface now follows the type
scale of DESIGN.md §3, and what the author wrote is what the reader sees.

Alongside them: a sheet that vanished while its work was pending, a habilidade
cache that outlived its file, and an annotation popover that named the wrong
skill — all corrected at their single source rather than at the label.

## Consequences

- The bar is now partly executable: contrast, control boundaries, focus rings,
  reduced motion, the token system, the boot path and the i18n pairs are pinned
  by suites that were each proven to fail against the unfixed code.
- `DESIGN.md` was re-derived from `style.css` (its own rule: the code wins) —
  including a new `--line-control` boundary token and a per-project accent
  palette that carries measured ink per theme, so choosing a project colour can
  no longer break the primary action's contrast.
- What was **not** done, deliberately: no general "open anything" IPC command, no
  shell, no credential handling, no new feature to close a flow that a defect fix
  could close. Genuine feature ideas were filed as issues instead.

## What this ADR does not settle

At the time of writing the app **renders a blank window** with tests and lint
green and no error logged — a regression from the last batch of this work, not
yet diagnosed. `workbench.md` carries the evidence and the next step. The rule it
teaches is already recorded above: a suite that never starts the app cannot say
the app starts.
