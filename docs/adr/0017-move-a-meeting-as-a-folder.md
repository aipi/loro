# ADR-0017 — Moving a meeting moves its folder, and rewrites the brainstorming it names

- **Status:** accepted (owner decision, 2026-08-08 — issue #44)
- **Context:** ADR-0009 gave the Brainstorming tree a move: `brain_move_pessoal`
  relocates a **file** between the non-versioned folders, never overwriting. A
  meeting is not a file. It is the directory `reunioes/<id>/` holding the living
  transcript, the manifest, the generated material under `notas/` (ADR-0008), the
  audit trail and the transient audio — so `move_pessoal_file`, which refuses
  anything that is not `is_file()`, had no path for it. A meeting recorded into the
  wrong brainstorming could only be abandoned there.

## Decision

### §1 The move is a directory rename, not a file walk

`acervo::move_meeting_dir` renames the whole `reunioes/<id>/` directory into the
destination's `reunioes/`. The analysis, the audio, the transcript and the audit
travel together **as a consequence of moving the directory**, not because some list
enumerated them.

That is the point, not an implementation detail. Hotspot #46 records that a
meeting's queue representation resolves through `acervo::meeting_queueables`, which
carries the BR-8 gate (`is_queueable`) — and that any code rebuilding that list
elsewhere rebuilds the gate too, which is how a transcript reaches `inbox/`. A move
that enumerated the folder would have been exactly such a place. Renaming the
directory means this feature never asks which files may travel, so there is no
second BR-8 gate to keep in sync. A test names the rule and pins it.

### §2 The destination is another brainstorming's `reunioes/`, and nothing else

`list_meetings` scans `brainstorming/<slug>/reunioes` and only that path, so a
meeting parked anywhere else — `avulso`, `notas`, `anexos`, a versioned context —
still exists on disk but disappears from the app. The command therefore takes a
destination **slug**, not a free path, and builds `brainstorming/<slug>/reunioes`
itself. A caller cannot express an unreachable destination.

An `<id>` collision at the destination **refuses** with `err.file_exists_in_target`
and moves nothing, following ADR-0009's rule that a move never overwrites.

### §3 A moved meeting stops naming its old brainstorming

A meeting records where it was born in two places: `manifest.json` → `tema`, and
`reuniao.md`'s front matter → `tema:`. **Both are rewritten to the destination**
(owner decision, 2026-08-08).

The alternative — leave them, since `manifest.tema` today has exactly one reader
(`assemble_notebook`, `meeting.rs:511`, the report's "Brainstorming: X" line) and
issue #43 removes that reader — was declined. It would have made this feature's
correctness depend on #43's fate, and left a field that lies for whoever reads it
next. Rewriting is cheap and decouples the two issues; whichever lands first, the
data is honest.

The rewrite is deliberately narrow and ordered:

- Only the `tema` key of the manifest and the `tema:` line inside the **first**
  front-matter block of `reuniao.md`. The transcript body is never touched — a test
  asserts it is identical after a move.
- It runs **after** the rename. A failure while rewriting leaves a meeting that
  moved intact, rather than a source directory half-edited.
- It is best-effort per file: an unreadable manifest does not undo a completed move.

This is the first time a move edits the content it moves. `brain_move_pessoal` is a
pure relocation and stays that way; the meeting case earns the exception because the
folder carries app-managed metadata that names its own location.

### §4 Two surfaces, one path

The `⋯` menu gets **mover para…** (a destination picker over the other
brainstormings), and the meeting row becomes draggable onto another
brainstorming's `reuniões` header — the same pair ADR-0009 gave files.

Drag carries a distinct data type (`text/loro-meeting`), so the folder targets that
accept loose files never see a meeting, and the `reuniões` header never sees a file.
The two decisions behind the UI — which destinations exist, and whether a drop
target is valid — are pure functions in `meeting.js` (`meetingMoveTargets`,
`meetingDropTarget`), unit-tested without a DOM; `app.js` keeps only the wiring.

## Consequences

- **New:** `acervo::move_meeting_dir` + `retema_meeting`, the `brain_move_meeting`
  command, `LoroMeeting.meetingMoveTargets` / `meetingDropTarget`, and the msgids
  `Mover reunião` / `movida` (both with English pairs).
- **Unchanged:** `brain_move_pessoal` and every file-move path; BR-8's gate lives on
  in `is_queueable`, untouched, because nothing here enumerates a meeting's files.
- **Ordering with #43:** independent by construction (§3). #43 removes the report
  and with it `manifest.tema`'s only reader; this ADR does not depend on which
  lands first.
- **BRs:** BR-8 is *named* by a test here (T-6) precisely to assert that this feature
  does not re-implement it.
