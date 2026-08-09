# ADR-0018 — The analysis IS the meeting's output; the report is gone

- **Status:** accepted (owner decisions, 2026-08-07 — issue #43)
- **Context:** every meeting produced a `relatorio.md`. The app wrote it when the
  recording stopped (`brain_meeting_build_notebook`), seeded **only** from markers,
  with Resumo/Decisões/Dúvidas sections that were literally placeholder prose; then
  `/loro-analyse` step 6 came back and rewrote those same sections. Since ADR-0008
  the meeting's real output is the analysis in `reunioes/<id>/notas/analise-<ISO>.md`,
  so the report was a second surface saying the same thing — and empty for every
  meeting nobody analysed. It was the old architecture, still standing because three
  accepted decisions leaned on it.

## Decision

### §1 The report is removed, not deprecated

Nothing writes or updates `relatorio.md`. `assemble_notebook` and
`brain_meeting_build_notebook` are deleted; `brain_meeting_finish` takes the
command's place and does one thing — `status: "done"`, authoring nothing.

`done` is what enables **analisar** and **enviar para a fila** in the meeting's `⋯`
menu, so it is preserved exactly. It simply stopped being a side effect of building
a document: closing a meeting and writing a document were never the same act, and
fusing them is what made every meeting carry an empty file.

### §2 In the fila, a meeting resolves to its `notas/*`

One queue item per file, as ADR-0014 already does for everything else — this
**supersedes ADR-0014 §2's** "a meeting is queued as its `relatorio.md`".

Sending stays the **user's choice**: any markdown they pick can go. **BR-8 is
untouched** — `reuniao.md`, `auditoria.jsonl` and non-text are still barred by
`is_queueable`, on every path, including a file dragged into the fila. The
"anything the user wants" stops exactly there.

A meeting nobody analysed therefore has **nothing** queueable, and says so
(`err.meeting_not_analysed`, and the `⋯` entry disabled with the reason) instead of
failing silently or queueing an empty placeholder.

**One owner, still.** `acervo::meeting_queueables` is the single answer to "which
files represent a meeting in the fila"; `queueable_files`, the per-meeting send and
the `notas` count in `brain_list_meetings` all resolve through it. Hotspot #46 is
the reason: any code that rebuilds that list rebuilds the BR-8 gate with it, and
that is how a transcript reaches `inbox/`. The frontend keeps a meeting as its
**directory** and never expands it — the JS side owns no part of the gate.

### §3 `/loro-digest` reads the manifest + `notas/`, never a report

**Supersedes ADR-0011's** source for meetings. A meeting reaches the index through
its `manifest.json` (`titulo`/`status`) and every analysis in `notas/`. **BR-8 is
unchanged and restated in the skill text (pt + en):** never `reuniao.md`, never
audio. A meeting nobody analysed enters the index by title and status alone, with
no invented content.

The legacy *consolidated* report of ADR-0014 (`anexos/*-relatorio.md`) is still
skipped — that is a different artifact and it still exists on disk.

### §4 The end of a recording SUGGESTS the analysis; it never runs it

The user gets `reuniao.md` open plus a **one-click, dismissible offer** to analyse.
Nothing is injected into the terminal agent unless they click; dismissing leaves the
meeting untouched. This is the owner's design decision for the nudge, and the only
layout change this issue authorises — it rides on the existing toast, so **no
permanent chrome** is added.

The outcome is a pure function (`LoroMeeting.analyseOffer`), so accepting and
dismissing are covered without a DOM, and the command it injects is the very same
one the `⋯` menu injects.

### §5 A legacy `relatorio.md` is DELETED on the first listing

**This is a derogation, recorded as one.** The domain's core premises are
non-destructive, and ADR-0008 §2 set the precedent of *self-healing* legacy layout
into `notas/`. Here the owner chose deletion instead (2026-08-07): the file was
app-authored placeholder prose, so migrating it would preserve text that never said
anything, and leaving it would keep a surface the app no longer explains.

The blast radius is pinned by a test: exactly `reunioes/<id>/relatorio.md`, once.
`reuniao.md`, `manifest.json`, `marcadores.jsonl`, `auditoria.jsonl`, `audio/*` and
**every** file in `notas/` survive — including a `notas/relatorio.md`, which is the
user's file and is never touched. A second listing does nothing.

### §6 ADR-0013's marker incorporation survives, and moved

`brain_meeting_build_notebook` was the only trigger for folding `marcadores.jsonl`
into the manifest, and `manifest.marcadores` had no reader other than the report
assembler. Neither fact makes the fold wrong: it exists so the app stays the only
writer of `manifest.json`, and `brain_meeting_marker` (the live `⋯` markers) writes
that field independently of any report.

So the fold **moved to `brain_meeting_finish`** rather than being retired. Its reach
is unchanged: it runs when the recording ends, so markers a habilidade appends later
stay in the sidecar — which is where ADR-0013 keeps them anyway. The analysis skill
still writes markers (AC-2) and still reads `manifest.json`.

## Consequences

- **Supersedes:** ADR-0001 §8's meeting notebook, ADR-0011's meeting source for the
  digest, and ADR-0014 §2's "a meeting is queued as its `relatorio.md`".
- **New:** `acervo::meeting_queueables` + `drop_legacy_report`,
  `meeting::brain_meeting_finish`, `MeetingListItem.notas`,
  `LoroMeeting.analyseOffer` / `meetingQueueBlock`, `toastAction`, the msgids for the
  offer/dismissal/blocked-send (all with English pairs) and `err.meeting_not_analysed`.
- **Gone:** `assemble_notebook`, `brain_meeting_build_notebook`, `deferred_prose`,
  `LoroMeeting.reportId` / `isReport`, `buildAndOpenReport`, the "abrir relatório"
  palette command, the `⋯` "ver relatório" entry and six msgids.
- **BRs:** **BR-8** is named by tests on both sides of the change — `is_queueable`
  still refuses transcript/audit/audio on every path, and the digest skill still
  forbids reading `reuniao.md` and audio. Nothing here widens what may enter the fila.
- **Ordering with #44:** independent, and #44 landed first. It moves a meeting
  folder and rewrites the paths the folder records; this ADR changes what the
  folder *contains*. Neither disturbed the other's premises.
- **`manifest.tema` now has no reader.** ADR-0017 §3 anticipated exactly this:
  it chose to rewrite `tema` on a move rather than leave it, *because* its only
  reader (`assemble_notebook`, the report's "Brainstorming: X" line) was about to
  disappear here — and a field that lies is worse than a field nobody reads. That
  reasoning holds unchanged: the move keeps `tema` honest, and the reference to
  `assemble_notebook` in ADR-0017 §3 is a record of the state at decision time,
  not a pointer to live code. Retiring the field is a separate decision, not
  taken here.
- **Known limit:** a meeting closed while `notas/` is empty is a dead end in the fila
  until someone analyses it. That is the intended shape — the alternative was the
  empty placeholder this ADR removes.
