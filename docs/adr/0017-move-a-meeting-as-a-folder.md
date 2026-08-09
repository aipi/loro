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

### §3 A moved meeting stops naming its old brainstorming — and its old path

A meeting records where it was born in two places: `manifest.json` → `tema`, and
`reuniao.md`'s front matter → `tema:`. **Both are rewritten to the destination**
(owner decision, 2026-08-08).

The manifest also stores acervo-relative paths **of the meeting's own material**:
`audio.mic` / `audio.system` / `audio.completo`, `artifacts[].rel` (and its
`refs[]`), and `refs[].caminho`. Those are rewritten too, by the same argument as
`tema`: a path that names a directory the move deleted is a field that lies for
whoever reads it next. `meeting::repath` matches on whole **segments** and only
re-roots what sat under the old rel — a `refs[]` entry pointing outside the
meeting did not move and is left alone.

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

### §5 A move is refused while the meeting is still recording

The **rename and the metadata rewrite happen under the meeting's own lock**, taken
in `move_meeting_dir` before the rename, so the two halves of the move are never
seen apart.

That lock only closes the race because of a discipline this ADR establishes for
the whole module: **a mutating meeting command takes the lock first and resolves
its directory second.** The lock is keyed by meeting *id*, precisely because the
*path* moves. Every command that resolved first — `brain_meeting_append`,
`brain_meeting_write_artifact` and their siblings — captured the old path, blocked
on the move, and then wrote into a folder that no longer existed, `create_dir_all`
resurrecting it as an orphan while the manifest read failed. Refusing a meeting
that is not `done` (below) hides that for the transcript, but not for the commands
that legitimately run on a *finished* meeting, which is why the ordering — not the
`done` gate — is what makes the lock mean something. `resolve_meeting_dir`
documents that its result is valid only while the lock is held.

The mutex is **not reentrant**, so the guard in `move_meeting_dir` is scoped: it
covers the rename and `remap_meeting_locked` (which documents that its caller
already holds it) and is released before the reference retarget of §6, which takes
the locks of the meetings *it* rewrites.

The **backend refuses a meeting that is not `done`** (`err.meeting_not_finished`),
and the UI gates both doors — the `⋯` entry and the drag handle. The backend check
is the one that matters: drag-and-drop is a second door into the same command, and
an invariant enforced only in a menu is not enforced.

The remap itself is **best-effort after the rename**: the move already happened and
must not be reported as a failure, so a broken manifest is logged and the command
still returns the new rel.

### §6 Inbound references are retargeted, not left to rot

Moving the folder makes every inbound `refs:` entry and every `acervo://` anchor
(ADR-0007) point at a path that no longer exists — `resolve_ref` would start
reporting `exists: false` in silence. After the rename, `retarget_refs_in_content`
rewrites those paths across the **non-versioned worlds** (`brainstorming/` and the
legacy `pessoal/`). Matching is on whole path **segments**, so `.../m1` never
rewrites `.../m10`.

This follows the precedent the promote flow already set: it rewrites or drops a
dangling link rather than shipping one.

Bounds on the walk, all learned from review:

- **`contextos/` is excluded.** It is the versioned tree, whose edits go through a
  branch (ADR-0002), and `move_pessoal_file` already refuses it on both ends.
  Rewriting a context's `CHANGELOG.md` in place would falsify history.
- **Symlinks are not followed and depth is bounded.** A cycle would recurse until
  the stack overflows, which aborts the process — and this runs *after* the rename,
  so the app would die with the meeting already moved.
- **A document owned by a meeting is rewritten under that meeting's lock.** The
  retarget is a read-modify-write over living documents: another meeting's
  `reuniao.md` may be receiving a transcript chunk at that instant, and an
  unlocked rewrite reads before the append and clobbers it. The owner is read off
  the path (`…/reunioes/<id>/…`).
- **A refused write is logged, never swallowed.** It leaves the acervo *partly*
  retargeted, and only the successes were being counted.
- **Custom habilidades are out of scope.** They live outside the acervo
  (`presets.rs`) and may carry `acervo://<rel>#<annot-id>` anchors (ADR-0007);
  those are not rewritten. The retarget's promise is bounded to the acervo — a
  user-authored skill file is not app-managed data, and editing one on a move is a
  decision this ADR does not take.

## Consequences

- **New:** `acervo::move_meeting_dir` + `retarget_refs_in_content` +
  `meeting_id_of`, `meeting::remap_meeting_locked` + `retema_front_matter` +
  `repath`, the `brain_move_meeting` command, `LoroMeeting.meetingMoveTargets` /
  `meetingDropTarget`, and the msgids `Mover reunião` / `movida` and the error
  codes `err.meeting_not_finished` / `err.lock_poisoned` (all with English pairs).
- **Changed beyond the feature:** every mutating command in `meeting.rs` now takes
  the meeting lock *before* resolving its directory (§5). The move is what makes
  the old order wrong, so the reorder belongs to this ADR rather than to a
  separate one.
- **Unchanged:** `brain_move_pessoal` and every file-move path; BR-8's gate lives on
  in `is_queueable`, untouched, because nothing here enumerates a meeting's files.
- **Ordering with #43:** independent by construction (§3). #43 removes the report
  and with it `manifest.tema`'s only reader; this ADR does not depend on which
  lands first.
- **BRs:** BR-8 is *named* by a test (T-6) precisely to assert that this feature does
  not re-implement it. **BR-1** is named by a second test: `move_meeting_dir` is a new
  path for relocating a transcript and its audio, so it re-checks world confinement
  *after* `canonicalize` — a symlink under the brainstorming tree would otherwise
  bridge into `contextos/`, which is what the rule and
  `meeting_stays_under_brainstorming_and_is_never_versioned` exist to prevent.
- **A destination without `reunioes/`** is created on demand rather than offered and
  then failed, matching what `create_meeting` already does.
