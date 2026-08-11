# ADR-0022 — Usability pass on the redesign: state, alignment, and the choices the user owns

- Status: accepted
- Date: 2026-08-11
- Amends: ADR-0020 (shell), ADR-0021 (chat)

## Context

First real use of the redesigned app surfaced a set of problems that share one
root: **the interface knew things it did not say.** The chat was working but
looked frozen; the settings page ran a network probe on the UI thread; a meeting
tied to an idea was recording with no clock and no way to stop from where the
recording was happening; a meeting with no analysis offered an arrow into an
empty list. Separately, several choices the code had made for the user (where an
AI action runs, which sidebar sections are visible, how wide each pane is) were
choices the user should own.

## Decision

### 1. Say what is happening

- **The chat shows it is working.** A "pensando…" indicator lives at the end of
  the thread from send until the turn ends. Each tool the agent reaches for
  becomes a discrete step chip instead of raw `usando: Bash` text in the middle
  of the answer, and a new tool closes the current paragraph so the text after it
  reads as a new statement rather than a continuation.
- **A recording meeting has a clock and a way to end it.** The living surface
  gains a recording bar (pulsing dot, running timer, "Encerrar reunião").
  Previously only a loose recording had that chrome, so a meeting attached to an
  idea recorded silently.
- **Opening the chat is visible.** "Perguntar à IA" flashes the composer, so the
  click reads as an action even when the panel was already open on that tab —
  before, it looked dead.
- **Speakers are legible in read mode.** `[mm:ss · você]` / `[mm:ss · sistema]`
  get the same colour treatment they have live (teal for the operator, amber for
  the other channels), applied to already-escaped HTML.

### 2. Offer the action, not the arrow

A finished meeting with no analysis showed a disclosure arrow that opened
nothing. It now shows **✦ analisar** — the action that is actually missing.

### 3. The user owns the choices

| Choice | Was | Now |
|---|---|---|
| Where an AI action runs | always the terminal | Settings → IA e terminal: **no chat** or **no terminal**. Every dispatch goes through one `runAiCommand()` |
| Which sidebar sections are open | always all three | ideias · para organizar · conhecimento each collapse, persisted |
| Pane widths | only the file tree | tree, right panel and terminal dock all resize (ADR-0021) |

### 4. Remove what lies or blocks

- **`env_doctor` is async.** It shells out to `git`, `gh --version` and
  `gh auth status` — the last one goes to the **network**. A synchronous Tauri
  command runs on the main thread, so the whole window froze while `gh`
  answered: that was the "slow transition" into Settings. The blocking work now
  runs on the pool. It is additionally only re-run when the *Versões e GitHub*
  section is opened, instead of on every settings open.
- **The terminal's `×` is gone.** It closed the terminal process from inside a
  tab whose entire purpose is to be the terminal. Visibility is governed by the
  ✦ IA panel and its tab, which is the one control that should own it.
- **The Documento panel has one empty state** instead of three sections each
  explaining their own emptiness.
- **First run hides what has no subject.** With no project yet, the destination
  nav, the record button and the AI panel are hidden — there is nothing to
  navigate, record into, or act on.

### 5. Alignment is a grid, not per-row widths

`.field` / `.wfield` became a single two-column grid (label / control) in both
Settings and the wizard. Controls that are not text fields (segmented toggles,
colour swatches) align left instead of stretching. Below 1080px the grid
collapses to one column. The settings summary line moved into the page header,
where it reads as a caption instead of an orphan line above the first title.

### 6. Copy that describes, not labels

"Organizar" and "Conhecimento" now say what the screen does for you
("Escolha o que vale virar conhecimento. A IA lê, resume e propõe onde cada
coisa entra — nada fica oficial sem a sua aprovação.") rather than restating
their own name. `＋ Novo tema` moved to the **top** of the Knowledge grid: with
many topics the last cell is below the fold, which is the one place a create
action must not be.

## Explicitly NOT done

> **Superseded (same day):** §19 below ships pause/resume with the exact
> scope this section demanded — real capture segmentation and tail rebasing.

**Pause/resume of a meeting.** It needs backend work that does not exist:
`brain_meeting_start` spawns the ScreenCaptureKit sidecar once, and the live
transcript is built from mic segments plus system-tail windows addressed by a
monotonic `tailFrom` offset into a single growing `system.wav`. A real pause
means stopping capture, closing that segment, and rebasing the tail offsets on
resume — new IPC and new bookkeeping. A pause that left the capture running
would tell the user recording had stopped while it had not, which is the exact
class of lie this redesign exists to remove. Deferred with its scope stated.

## Consequences

- New persisted UI state: `actionMode` (`chat` | `term`), `sideClosed[]`.
- `runAiCommand()` is the single dispatch point for every AI action; only the
  dependency installer still talks to the raw shell (`termRun`).
- The header shows the app version; the "100% local" promise lives on in the
  manual, the settings copy and the recording privacy pill, where it is tied to
  something concrete.
- Dead code removed with the shell it belonged to: the meeting rail
  (`meetingRailHtml`), `liveExpand`, `homeSkillBtn`, `proposeHelp`.

## Follow-up in the same pass (2026-08-11, second round)

### 7. "ações de IA" → **Habilidades de IA**

The product term is *habilidade*; "ação" is what one does, not what it is. The UI,
both manuals and the msgids follow. Internals (`.claude/commands/*.md`,
`allHabilidadeEntries`, ADR-0005) already used *habilidade* — the UI had drifted.

### 8. The sidebar "✦ analisar" analysed the wrong meeting, or none

`currentMeetingDir(id)` derives the folder **from the open tab**, so the sidebar
button — which acts on a meeting that is neither open nor recording — got `null`
("não encontrei a pasta desta reunião"). Worse, with a *different* meeting open
it would have returned that one's folder and analysed the wrong meeting. The row
already knows its folder (the same `selRel` the ⋯ menu uses), so the button now
carries it and calls `runMeetingSkill(..., dirOverride)` — the exact path the ⋯
menu already used.

### 9. Record/stop answer in the same frame

`Gravar`/`Parar` spawn processes (whisper, ScreenCaptureKit) and can take
seconds. With no immediate feedback the button read as dead and got clicked
again. A pending state (`iniciando…` / `encerrando…`, disabled, pulsing dot)
paints on click and is cleared by `onStarted`/`onStopped` — the backend events
that define the truth. The meeting's own "Encerrar reunião" shares it.

### 10. External sources come from the skill, not from a list in the app

`/loro-sync` declares what it accepts in its own front matter
(`argument-hint: <fonte:drive|slack|jira|confluence> …`). The picker now reads
that list, so editing the skill to add a source surfaces it in the UI with no
app change. The hardcoded four remain only as a fallback for a skill that
declares none, and an unknown source gets generic modal copy instead of being
silently dropped.

### 11. The copy stopped promising the terminal

With ADR-0022 §3 the destination is the user's choice, so "roda no Claude do
terminal" was no longer true. One helper (`aiTargetHint()`) derives the sentence
from `actionMode`, and the modals/toasts use it.

## Follow-up in the same pass (2026-08-11, third round)

### 12. One recording footer, shared by the loose recording and the meeting

§1 gave a recording meeting its own bar *inside* the living surface (`.mtgrec`),
next to the loose recording's footer. Two bars meant two clocks to keep in sync
and — because the waveform is a `<canvas>` — either a second canvas or a moved
one. The footer is now a single `#recFoot` in the main column, below the content:
same timer, same wave, same privacy pill, for both cases. What is meeting-specific
is one extra control (`■ Encerrar reunião`), shown only while a meeting records.

The row must **fit the content column**, which narrows when the ✦ IA panel opens.
The sacrifice order is deliberate: the explanatory sentence truncates first, then
the wave; clock, privacy pill and the finish button never shrink. A container
query — not a window-width media query — drives it, because what is narrow is the
column, not the window.

### 13. "Escrever uma nota" opens a blank note; the destination is chosen on save

It previously demanded a topic *before* the user had written anything. Now it
opens an empty markdown editor on a scratch rel (`loro://nova-nota`), and the
first save asks for the title and where it goes (an existing brainstorming topic
or a context). Writing first, filing second — the order the user actually works
in. The scratch tab is never a real file until then: nothing is written to disk
if it is closed.

### 14. The sidebar reloads itself after a skill writes

A skill that creates a note (an analysis, a digest) changed the tree, but the
tree only reloads its *collapsed* signature — an already-open folder kept showing
its old children, so the user had to close and reopen it. `refreshAfterSkill()`
now clears the cached signatures **and** re-fills every open meeting/topic/context
child list, with one delayed second pass for a file that lands just after the
process exits.

### 15. Rendering fixes that were regressions, not preferences

- A floating menu (the ✦ Habilidades list) is clamped to the viewport and flips
  above its anchor when it would overflow the bottom — it was being clipped.
- ADR-0021's expandable step is a `<details>`, but the legacy chip rule
  (`display: inline-flex`, `align-self: flex-start`) still applied to the same
  class and squeezed it into a pill. The legacy rule is gone.
- A refusal for a turn already running (`err.chat_busy`) is a **toast**, not a
  line written into the answer bubble — as a bubble line it repeated on every
  click and read as the agent failing.

## Follow-up in the same pass (2026-08-11, fourth round)

### 16. The three destinations are the header's axis

The nav pill sat against the project switch, so the header read as
left-heavy. It is now centred on the **window**, positioned absolutely: the left
block (project name) and the right block (version · Gravar · ✦ IA) both change
width with their content, so centring by flex would leave the pill drifting as
the project name or the record label changed. Below 1080px it returns to the
normal flow, before it could collide with either side (measured at 1100px with
the recording pill visible: left block ends at 280, the pill starts at 405).

### 17. Edit mode fills the column

`#bDocWrap` aligns its children to `flex-start` — right for reading, where the
card is a 700px column centred in the page. In edit mode that alignment made the
card **shrink to its content**: the editor rendered in a narrow strip on the left
with the rest of the column empty (measured: 310px inside a 1025px body). Edit
mode now stretches (ADR-0008: the editor owns the panel).

### 18. Loro's agent is a session of its own

Started from inside another agent's session, Loro inherited that session's
environment markers and passed them to every agent it spawns — the embedded
terminal and the chat. The CLI then took itself for a *nested child* and turned
off its own transcript ("Transcript saving is off — inherited
`CLAUDE_CODE_CHILD_SESSION` marker"), which is a silent loss: the agent answers
normally and writes no history.

`proc::INHERITED_SESSION_MARKERS` is stripped in `proc::command()` (every child)
and in the PTY builder (the embedded terminal, which does not go through
`command()`). It is a **deny list, never a `CLAUDE_*` wildcard** — real user
configuration lives under the same prefix (`CLAUDE_CONFIG_DIR`,
`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`), and dropping it
would break the agent the user configured. Both halves are covered by tests.

## Follow-up in the same pass (2026-08-11, fifth round)

### 19. Meeting pause/resume — supersedes "Explicitly NOT done"

The backend work that section said was missing is now built, on its own terms:

- **Pausing stops capture for real.** `brain_meeting_pause` kills the syscap
  sidecar and the mic segment rotation stops; nothing reaches the disk while
  paused. A pause that kept recording would tell the user recording had stopped
  while it had not — the exact lie the section refused to ship.
- **`syscap_pending` became a list of segments.** Resuming
  (`brain_meeting_resume`) spawns a new sidecar writing a new WAV. At stop, the
  segments land as `audio/system.wav`, `system-2.wav`, … (`system_segment_name`
  — the first keeps the historical name, so an unpaused meeting is byte-identical
  to before). `purge_audio_core` sweeps `system-*.wav`, so a resumed meeting
  purges as clean as a plain one (audio stays transient).
- **The clock excludes pauses** (`elapsedActiveMs`: `pausedMs` accumulated,
  frozen display while paused). Both timelines derive from it — mic segments
  stamp `meetingElapsedMs()`, and the system tail stamps `tailBase + tailFrom`,
  where `tailBase` is the timeline instant the current segment started and
  `tailFrom` the offset inside that segment's WAV (a resume restarts the WAV at
  zero — this is the "tail rebasing" the old section named). Excluding the pause
  from both keeps mic and system interleaved correctly.
- **Before the pause takes effect**, the current mic segment is flushed and one
  final system window is transcribed, so speech up to the pause instant is kept.
- **The truthful surface:** while paused, the footer note says "reunião pausada
  — nada está sendo gravado", the wave dims, the header pill shows ⏸, and the
  tray stops blinking.

### 20. The footer controls live LEFT of the clock, and Encerrar is Parar

`■ Encerrar reunião` had a neutral style while the header's `Parar` was the red
pill — the same action, two appearances. It is now `.recbtn sm` (the same red
pill, compact), preceded by `⏸ pausar` / `▶ retomar`, both BEFORE the timer:
controls, then state, reading left to right.

### 21. The tray blinks for meetings too

The macOS tray icon only blinked for a loose recording: `set_tray_recording` was
called by `start`/`stop` but never by the meeting lifecycle. It is now set on
meeting start/stop and on pause/resume (paused = not blinking, which is the
truth: nothing is being captured).

## Follow-up in the same pass (2026-08-11, sixth round)

### 22. Settings is ONE page; the nav navigates

Each nav button used to show its section and hide the other six, so the page
never gave a sense of what exists. All sections are now visible in one scroll;
clicking a nav item scrolls to its section (`scrollIntoView`), and a scroll-spy
highlights the section whose top last crossed the upper third. The network check
(`gh auth status`) keeps its laziness: it runs once per settings visit, the
first time *Versões e GitHub* is reached — by click or by scroll.

### 23. Edit mode uses the SAME centered card as view mode (padrão geral)

Edit mode used to go full-bleed: no border, no max-width, flat background —
a different room, not a different mode. Owner decision: the frame must not
change when the mode changes, only the content. `#wsBody.editing .doccard`
keeps the reader's 700px centered card (border, radius, panel background) and
becomes a flex column inside, so the editor still fills the card's height and
scrolls internally. This applies to every document — the quick note is just
where the inconsistency was reported.

## Documentation audit (2026-08-11)

Six rounds of change in one day left drift. Swept, with the findings recorded
because each one is a trap that would otherwise return:

| Finding | Resolution |
|---|---|
| **Two ADRs numbered 0014** (the fila one, 2026-08-03; Windows ToolHelp, 2026-07-31) | Every `ADR-0014` citation in the repo means the fila one; the Windows file had none, so it moves to **ADR-0023**. Renumbering the cited one would have broken code comments |
| **ADR-0019 cited five times, never written** — the number came from the design handoff's own series | The denial flow is recorded in ADR-0021, which now says so; `docs/adr/` has no 0019 *by design*, stated once so the gap stops looking like a lost file |
| `chat_add_dir` still in ADR-0021's header after its own amendment removed it | Header rewritten |
| ARCHITECTURE said the UI says "ações de IA" | ADR-0022 §7 renamed it to *habilidades de IA* |
| ARCHITECTURE said Meeting AI is "terminal-Claude skills"; `context.md` said the same | Since ADR-0022 §3 the destination is the user's choice (chat or terminal) |
| ARCHITECTURE claimed the digest was "removed" while `/loro-digest` still ships as a built-in | Precise now: the dedicated **UI** was revoked, the skill still ships and runs |
| `brain_meeting_pause`/`resume` absent from the IPC contract | Added, next to the other meeting commands |
| **Half the msgids live in `index.html`, and no test covered them** | Two tests added: every `data-i18n` text and translated attribute needs an English pair, plus a guard proving the scanner matches all 164 `data-i18n` elements (a scanner that missed some would report "all translated"). Eight strings had no pair and were showing in Portuguese with the UI in English |

`context.md` also gained the pause rule, since "nothing is recorded while
paused" is a promise to the user, not an implementation detail.

## Follow-up (2026-08-11, seventh round) — the mic is asked for RAW

### 24. Loro is a recorder, not a call app

Reported in real use: while Loro records, the user's voice reaches the other side
quiet, and what they hear comes back muffled. Cause: the mic was requested with
`{ audio: true }`, whose browser defaults enable **echo cancellation, automatic
gain control and noise suppression**. On macOS that swaps in the voice-processing
audio unit for the **whole machine**, not just for Loro: AGC flattens the voice,
and the output path degrades — including the call app's, which already does its
own cancellation and never asked for ours.

The echo a browser would cancel is what the page itself plays, and Loro plays
nothing: the benefit is zero, the cost was measured by the user. So the request
is now for the raw device (`LoroAudio.micConstraints`, both for the default input
and for a pinned `deviceId` — the system-audio/loopback path builds its
constraints separately and would otherwise have kept the old behaviour).

It is also what transcription wants: AGC pumping and noise suppression eating
consonants make recognition worse.

Three tests hold it: the two constraint shapes, and a scan asserting no
`getUserMedia({…})` object literal ever comes back into `app.js`.

### 25. The same speech was landing in BOTH tracks

Reported right after §24 shipped, with a capture: every utterance appeared twice
— once as `você`, once as `sistema`, ~1s apart, transcribed slightly differently
each time. With echo cancellation off and sound coming out of **speakers**, the
mic hears what the system capture already recorded digitally. §24 removed the
cancellation; this is its other half.

Two defences, because they solve different halves:

1. **A cross-track echo filter** (`LoroMeeting.echoOfOtherSource`), always on. It
   compares normalised word SETS (accents and punctuation stripped — whisper
   writes "tô" and "to" for the same sound) and drops a chunk when almost
   everything it says was already said by the OTHER track nearby in time.
   Thresholds are chosen against the owner's real capture: the reported pair
   scores **0.92 containment**, unrelated speech in the same meeting **0.13** —
   the cut at 0.70 sits in that gap, not at a guess. Chunks under 8 tokens are
   never dropped ("tá bom" genuinely repeats), the same track repeating is real
   repetition, and the window is 20s because a system window is stamped with its
   START, so a pair can be a full window apart.
2. **A setting** (Settings → Captura → *cancelar o eco do alto-falante*),
   default **off**. The filter cleans the transcript but cannot fix
   **attribution**: when the far end reaches both tracks, the two copies are
   equally plausible and whichever landed first wins the label. Only killing the
   leak at the source fixes that, and only the user knows whether they are on
   speakers. The copy states the price plainly — the machine's audio path
   changes and their voice comes out quieter — so it is a trade, not a toggle.
   AGC and noise suppression stay off in BOTH positions: they are what flattens
   the voice, and neither protects against speaker leakage.

**Known limit, stated rather than hidden:** a mic chunk that is *mostly* leak is
dropped whole. Containment ≥0.70 makes that safe in practice (a chunk that is
half the user's own speech scores ~0.5 and survives), but a chunk that is 80%
leak and 20% the user loses those 20%. The append-only contract (ADR-0010) is why
the fix is not "replace the line": nothing already written is rewritten.

## Independent review sweep (2026-08-11)

A full-effort review of the day's work found 15 defects. Three were introduced by
the review's own subject and are recorded in §25 and below; the rest were
pre-existing and are fixed here. Each entry names the mechanism, because the
mechanism is what generalises.

### Dead on arrival

| Defect | Mechanism |
|---|---|
| **The meeting marker never worked** | ADR-0020 collapsed four typed markers into one (`momento`) in the UI but never touched the Rust allow-list, which still held only the four legacy kinds. Every click answered "tipo de marcador inválido" while the manual promised the feature. `momento` now leads the list; the legacy four stay so pre-redesign manifests keep validating. Its timecode also moved to the pause-aware clock — it was still on raw wall time |
| **Organizar's per-item checkbox read by nobody** | The footer counted the whole queue and the action processed the whole queue. Unchecking 4 of 5 items and watching all 5 become knowledge is the control lying about what happens to the user's material. The checkbox is gone and the copy says *itens na fila*; removing an item is what the row's ⋯ menu is for |
| **The attach button in the recording footer** | Fell back to `destRel: "inbox"`, which `guarded_anexos_dir` rejects by design. Outside a meeting there is no anexos folder, so the button says that instead of firing a backend error |

### The chat could hang, lie, or leak

| Defect | Mechanism |
|---|---|
| **stderr deadlock** | `stderr` was piped but drained only *after* stdout reached EOF. Once the child fills the pipe buffer its next write blocks, it stops producing stdout, EOF never comes, and the chat sits on "pensando…" forever. Any chatty agent triggers it. stderr now drains on its own thread, capped |
| **`wait()` under the global mutex** | The reader thread took whatever child was in the global slot — not its own — and waited on it *while holding the lock*, on the main thread. A stop-then-resend froze every chat command including cancel, and reported a successful turn as failed. Each turn now owns its child via a turn counter, and the wait happens outside the lock |
| **A denial erased at the last line** | `result` is by construction the last line of the stream, and it **assigned** `permission` instead of OR-ing it — wiping the denial a `tool_result` had already recorded mid-turn. The user got the raw error instead of the choice ADR-0021 exists to offer. The end-of-turn handler is now a pure function (`apply_result_line`) with a test |
| **Zombies on cancel** | `chat_cancel`/`chat_reset` killed without reaping, and by *taking* the child they disarmed the reader that would have reaped. One zombie per stop, for the app's lifetime |
| **Sessions crossed projects** | `--resume` is resolved by the CLI **per directory**. Switching acervo kept the old session id, so every turn in the new project failed opaquely forever. The session now remembers the directory it was opened in and is dropped when that changes |
| **Slash commands sent raw** | The terminal path normalises `/loro-…` through `LoroPresets.agentInvocation`; the chat path did not — and chat is the default. With any non-Claude agent every AI action sent a literal slash string. The agent is also read fresh per call: changing it in Settings used to need a restart |

### Pause could duplicate or kill the transcript

| Defect | Mechanism |
|---|---|
| **The rollback re-transcribed the meeting** | Every failure path of `brain_meeting_pause` returns *before* capture stops, so the WAV is unchanged — but the catch called `startMeetingTail()`, which rebases the offset to 0. The next tick would re-transcribe and re-append the entire meeting, timestamped at the failure. It now only re-arms the interval |
| **Two carves over one snapshot** | `stopMeetingTail()` cleared the `tailBusy` guard while a tick was still in flight, and pause immediately awaited another. Both wrote the same fixed `.tail.snapshot.wav`; whichever finished first deleted it under the other, and a late `nextMs` could clobber the new segment's offset and kill the live system transcript for the rest of the meeting. The guard is no longer cleared, the in-flight promise is awaited (`tailFlush`), and the snapshot name is unique per call |
| **Echo history leaked between meetings** | Cleared only when the elapsed clock happened to read exactly 0, one statement after the timer started. It is cleared per meeting now |

### The theme never reached the editor

`cmTheme()` read the OS `prefers-color-scheme` instead of ADR-0020's `data-theme`,
so choosing "escuro" on a light Mac gave a white editor inside a dark app — the
writing surface was the one place ignoring the user's choice, and
`LoroShell.onThemeChange` shipped with zero subscribers. It now derives from the
app theme and re-mounts on change — **only editors with no pending edit**: losing
typing to change a colour would be an absurd price.

### Numbering, corrected against evidence

The ADR-0023 renumbering note claimed the Windows file "had no citation at all".
`git log -S` disproves it: `proc.rs` cited it from the very commit that created
both. That citation now points at 0023, `Cargo.toml`'s bare "ADR-0013" is
qualified, and the note carries the correction rather than the tidy story.

### 26. The echo filter never ran — the two tracks are synchronous

Second capture from the owner: the duplication survived §25. The log settled it —
**zero** dropped echoes, while the reported pair scores 0.91 containment. The
threshold was never the problem.

`appendMeetingChunk` recorded a chunk in the comparison list only **after**
awaiting the append. The two tracks rotate on the SAME 18s interval (the mic
recorder and the system tail were each given `MEETING_TAIL_MS`, deliberately), so
both copies of an utterance arrive within milliseconds of one another: both
tested against a list that did not yet contain the other, both passed, and the
filter never saw a pair. The synchronised rotation makes this the NORMAL case,
not a corner one — which is why the feature looked completely inert.

The chunk is now recorded **before** the await, with nothing awaited between the
test and the record, and removed again if the append fails — a chunk that never
reached the file must not block its legitimate twin.

### 27. Partial overlap is evidence, not garbage

The other half of the same capture: a mic chunk carrying the user's OWN speech
followed by the leak ("E tá de boa aí? Tá pegado" + the far end) scores 0.65 —
below the drop threshold, and rightly so: dropping it would delete what only the
mic heard. But it is the same proof that the mic is hearing the speaker.

`partialCrossTalk` recognises that band (0.35–0.70) without filtering anything.
At the third signal in a meeting the app connects the symptom to the control the
user has no reason to know exists: *as duas trilhas estão ouvindo a mesma fala —
ligue o cancelamento de eco*. Once per meeting, never when it is already on.

That is the honest division of labour: the filter cleans what it can safely
clean, and what only physics can fix is handed to the person who can change the
physics.
