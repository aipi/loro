# ADR-0025 — One clock, and each utterance at its own time

- Status: accepted
- Date: 2026-08-13
- Owner decision: 2026-08-13 ("os primeiros segundos de audio ele coloca eu como
  voz do sistema e o contrario também… precisamos resolver isso de vez")
- Extends: ADR-0012 (the live preview IS the transcript), ADR-0013 (timecoded
  interleaving), ADR-0018 (the analysis is the meeting's output), ADR-0022 §24-§26
  (raw mic, the cross-track echo filter, and why it was inert)

## Context

Reported in real use: in the first seconds of a meeting the owner's speech is
labelled `sistema`, and the other participants' speech is labelled `você`. The
opt-in speaker echo cancellation (ADR-0022 §25) reduces the physical leak but does
not fix **attribution** — §25 said so in writing: "whichever landed first wins the
label".

Under ADR-0018 the live transcript is the meeting's **only** output and the audio
is purged at the end. A wrong label is not cosmetic: it is the only surviving
version of what was said, and nothing can reconstruct it.

Four mechanisms were found. The third is the root of the first two; the fourth is
a separate defect in the same surface.

### 1. The label was decided by a race

Both tracks rotate on the SAME 18s tick (`MEETING_TAIL_MS`, deliberate since
ADR-0012). When the same speech lands in both through speaker leakage, the append
point dropped **whichever arrived second** (`LM.echoOfOtherSource`,
`crossTrackDuplicate`). Arrival order is a race between two `invoke`s fired in the
same instant. System first → your voice becomes `sistema`. Mic first → their voice
becomes `você`. One mechanism, both reported symptoms.

The leak, however, has **one direction**: sound leaves the speaker and enters the
mic. The reverse path does not exist — the sidecar captures the system's output
with `excludesCurrentProcessAudio`, and the mic is not system output. The right
answer is invariant, and the code was tossing a coin over a question physics
already answers.

### 2. The two tracks were on different clocks

The system track was stamped by its offset into the sidecar's WAV, whose t=0 is
its first sample. The mic was stamped from `state.startTime`, which is set only
after the TCC poll (1.2s), the mic-permission wait (up to 6s) and `openDoc`. Skew:
~1s normally, up to ~7s on the first meeting — and it came back on every resume,
because `brain_meeting_resume` blocks in `system_capture_start` before the
frontend read its base.

### 3. The root: the per-utterance timestamps were thrown away

`extract_text` read whisper's `[hh:mm:ss.mmm --> hh:mm:ss.mmm] text` lines and
**discarded the times**; both meeting commands closed with `segments.join(" ")`. An
entire 18s window became ONE block stamped at its start.

So only the first utterance of each window ever had a true timecode; the
interleaving between tracks was fictional (two 18s blocks with the same stamp); and
echo detection had nothing finer than a window to reason with. The pre-existing
test "um trecho curto NÃO derruba uma janela longa de outro assunto" documents that
limit exactly: a short phrase whose function words all appear in an unrelated 18s
window scores 0.91.

### 4. Stopping lost the other participants' last words

`pauseMeeting` ran a final system-tail tick before stopping capture.
`stopMeeting`/`finalizeMeeting` did not: they cleared the interval and went
straight to `brain_meeting_stop`. The last mic segment was flushed, but the system
window since the last tick — up to 18s of the other participants — was never
transcribed, and the audio is purged right after. Their last words were lost at the
end of every meeting.

## Decision

Four invariants. The first two are the ones that make the rest possible.

### One clock, anchored on a measurement

A meeting has an explicit t=0 in epoch ms (`startedEpochMs`), taken immediately
before the capture is spawned, and **both** tracks convert to it — in one place,
`LM.sysBlockMs` / `LM.micBlockMs`.

The WAV's own t=0 is no longer estimated: the sidecar prints
`first-sample-epoch-ms <epoch>` on stdout at the instant it creates the file, which
is that t=0 by construction. The parent keeps it per capture segment and hands it
to the frontend with every tail answer — including empty ones, because it can be
reported after the meeting started.

**The meeting's anchor is the spawn, NOT the first sample.** They differ by a few
hundred ms normally, but on a silent machine ScreenCaptureKit can delay the first
buffer arbitrarily; anchoring the meeting there would push the mic's own timestamps
negative. With t=0 at the spawn, the WAV enters the timeline through its own offset
(`anchorEpochMs − originEpoch`) and both cases are right.

The visible clock moves with it: the footer counts from when the **recording**
began, not from when the interface painted itself. On a first meeting, where macOS
puts a permission dialog in front of the user, it can already read 00:03 — which is
true, the system capture was recording. Starting a meeting also got faster: the TCC
poll now breaks as soon as the anchor arrives (an anchor proves the capture is
running, so a denial is impossible), ~0.3s instead of a flat 1.2s.

Degradation is deliberate and quiet-but-logged: with no anchor (an older sidecar
binary, or a first sample not yet reported) the timeline falls back to the raw
offset — approximate, as it was before, never broken.

### Each utterance at its own time

`parse_whisper_segments` keeps what `extract_text` was discarding, through the SAME
parser (two parsers is how a line's text and its timecode drift apart). Both
meeting commands now return `segments[{tMs, endMs, text}]`, and a window is written
with `brain_meeting_append_timed` — one read, one write, one repaint for the whole
window instead of one per utterance.

A spoken line whose timecode is unreadable keeps its **text** and inherits the
previous segment's end. Under ADR-0018 speech is never dropped over a timecode.

### Attribution follows physics, not the race

Only a **mic** utterance may be dropped as leakage. A system utterance is never
dropped because of the mic — that is the invariant, and a test states it directly.

The measure is **coverage by contiguous word runs**: what fraction of the mic
utterance sits inside runs of 4+ words that also appear contiguously in the system
utterance. Echo reproduces the same word *sequence* (both tracks carry the same
speech); coincidental overlap of function words does not produce long runs. It is
required together with **mutual containment** (echo is symmetric — both sides
cover each other) and with the two utterances **overlapping in time**, which only
became a real question once each utterance carried its own timestamp.

Because the drop is now directional, the old 8-token floor and the separate
`crossTrackDuplicate` mechanism are gone: one rule covers both the long real pair
and the 4-word duplicate at the same instant. There are fewer mechanisms than
before, not more.

### One owner of the join

The two tracks stop being two appenders racing for the same file. The system track
writes immediately — it is the one that is never dropped, so it has nothing to wait
for. The mic's utterances are only resolved once the system track has been heard up
to the end of that mic segment, which is what makes the resolution *decided* rather
than raced. Ceiling: one tick; past it, the speech goes in as-is, because under
ADR-0018 a possibly-duplicated line is far better than a lost one, and the expiry
is **logged** (a mechanism that degrades silently is exactly how the echo filter
stayed inert for two versions).

Both sides of the join are on the **same clock** (`Date.now()`): the tail publishes
the wall instant its snapshot was taken, and a mic segment carries the wall instant
it ended. Comparing WAV-derived meeting time against wall time would have worked at
first and then loosened on its own — the two 18s intervals drift relative to each
other over a long meeting, and nothing in the code would have said so.

## Amendment (2026-08-13) — the measurement rejected the first design

The thresholds were chosen the way ADR-0022 §25 chose its own: by measuring the
owner's real captures, which live in the test suite. Measured on the pairs, with a
minimum run of 4 words:

| case (real capture) | runs ≥3 | runs ≥4 | mutual |
|---|---|---|---|
| echo pair §25 | 0.89 | **0.89** | 0.89 |
| echo pair §26 | 0.94 | **0.94** | 0.92 |
| exact short duplicate | 1.00 | **1.00** | 1.00 |
| leak + own speech | 0.51 | **0.44** | 0.65 |
| **coincidence** (short phrase × unrelated window) | **0.82** | **0.55** | 0.31 |
| unrelated speech | 0.00 | **0.00** | 0.07 |

Two things in the planned design were **wrong**, and the measurement is what said
so — before any of it became behavior:

1. A minimum run of 3 with a 0.60 cut would have **dropped legitimate speech**: the
   coincidence case scores 0.82 there. At a minimum run of 4 it falls to 0.55, real
   echo stays at 0.89+, and the cut sits at 0.75, inside a measured gap.
2. Mutual containment was going to be **deleted** as a crutch. It is in fact the
   measure that kills the coincidence case (0.31 against 0.89 for real echo), which
   is the one place runs are weakest. Both are required now — two independent
   measures, each with its own measured gap, is stronger than either alone.

One constant is **not** derived from a gap, and is marked as such in the code:
`LEAK_SLACK_MS` (1500ms), the slack on the time-overlap test. Physically the leak
reaches the mic in milliseconds, but whisper segments two different signals (one
clean, one through the air) with boundaries that do not coincide exactly. A real
two-track capture *with* timestamps would let it be tightened; until then the slack
is generous on purpose. It replaces the previous 20s window, which only existed
because a whole window used to be stamped at its start.

## Consequences

- Every utterance carries a true `[mm:ss]`. Before, only the first of each 18s
  window did.
- The interleaving between the tracks is real, so `reuniao.md` finally reads in
  conversation order.
- The 8-token floor and the separate `crossTrackDuplicate` mechanism are **gone**:
  once attribution is directional and each utterance is timed, one rule covers both
  — fewer mechanisms than before, not more.
- `brain_meeting_transcribe_tail` and `brain_meeting_transcribe_segment` changed
  shape (`text` → `segments`). The frontend is their only consumer.
- The anchor's contract spans two languages. Nothing else would report a mismatch,
  because a missing anchor degrades **quietly** — so a test asserts that the Swift
  sidecar prints exactly the prefix the Rust parent reads.

## Limits, stated rather than hidden

- **Self-monitoring conferencing apps.** An app that plays the user's own voice
  back into the system output puts their voice in the system track. The physical
  rule then errs in the old direction. Most conferencing apps do not self-monitor.
- **Speech before the mic exists.** If macOS is still showing the mic permission
  dialog, the user's speech of that period exists ONLY as leakage in the system
  track. Without diarization it cannot be re-attributed, and it stays `sistema`.
- **Acoustic detection is the escalation path, not this decision.** The leak is a
  signal problem and we hold the clean reference signal (the system audio), so our
  own AEC — an adaptive filter in Rust — would remove it before whisper ever sees
  it: no word heuristics, no label to arbitrate, no duplicate, and none of the
  machine-wide audio degradation that made ADR-0022 §24 refuse the browser's AEC.
  It is not taken now because it requires both PCM streams aligned and continuous,
  i.e. moving mic capture out of the webview `MediaRecorder` into native — a
  capture-architecture change, and pure cost for anyone on headphones. Decide it
  **after** measuring the text-level thresholds in real use.

## Status of the two halves

Delivered in two PRs, because the halves have different natures and each stands on
its own:

1. **One clock, each utterance at its own time** — invariants 1 and 2, plus the
   stop-time system flush. No change to the attribution rule, so this half is
   verifiable without provoking any leakage.
2. **Physics decides the label** — invariants 3 and 4, with the thresholds measured
   rather than guessed (see the amendment above).

## §28 — Follow-up (2026-08-13): the first 18 seconds were empty on BOTH tracks

Reported from a real meeting right after the two PRs landed: from 00:00 to 00:18
nothing was recorded — both tracks showed a single whisper silence-hallucination
("Obrigado.") — while everything from 00:18 on was correct, with per-utterance
timecodes 2 seconds apart. The second window even started mid-sentence, proving the
audio of the first window existed and its transcription was lost, not absent.

**Mechanism.** `transcribe_wav_window` carved into
`<src dir>/.window-<from_ms>.wav`. The tail's source is
`<meeting>/audio/.tail.snapshot.<nanos>.wav` and the mic segment's is
`<meeting>/audio/.seg.webm`, so both resolve to the same directory — and on the
FIRST tick both carve with `from_ms = 0`, i.e. into the SAME `.window-0.wav`, from
two `spawn_blocking` threads. Two ffmpeg processes writing one path, and the first
to finish deletes it under the other. From the second tick on the tail's offset is
18000, 36000, … so the names stop colliding and the defect vanishes — which is
exactly the shape of the report.

This is the **third** appearance of this bug class, and the mechanism is what
generalises: ADR-0022 §407 made the *snapshot* name unique and stopped there; the
*carve* destination and `.seg.webm` were left on fixed names. Both are unique per
call now — the carve by a process counter rather than the clock, because the two
carves start in the same instant and nanoseconds can tie.

**Found on the way, and worse in kind:** `purge_audio_core` cleaned `system-N.wav`
and `.tail.snapshot.*` but never `.window-*` or `.seg*`. A transcription interrupted
mid-flight (app closed, whisper killed) left audio behind that the purge would never
remove — a BR-8 leak, and with unique names it accumulates instead of overwriting.
The purge now covers every transient artifact of the live path, and the test seeds
all of them.

**Not fixed here, because it is the owner's call:** whisper writes "Obrigado." (and
"Obrigado por assistir") over silence in Portuguese, and `filterHallucinations` does
not list it. Adding it would delete a real "Obrigado." too — a legitimate utterance
in a meeting — which is why it is not being added without a decision. With the carve
collision fixed, windows mostly carry real audio, so the symptom should become rare.

## §29 — Follow-up (2026-08-13): timing per utterance, writing per paragraph

Owner report on the same capture: keeping each utterance as its own block made the
text **choppy**. One window became five blocks, each carrying a
`[mm:ss · fonte]` label in the middle of a sentence:

```
[00:18 · sistema] modelo, e aí dando tudo
[00:20 · sistema] certo, depois eu apresento pra vocês
```

The owner asked for the old grouping back. The distinction that makes both things
possible: **the per-utterance time is what the attribution needs; the paragraph is
what the reader needs.** So the timing stays and the grouping moves to the write:
consecutive utterances of the same track become one block, stamped at the real time
of the first one.

This is *not* a return to the 18s block. Before, the stamp was the start of the
**window** — wrong by the clock skew — and the attribution had nothing finer than
that to reason with. Now the leak is decided utterance by utterance, on intervals,
and only then is the surviving text joined. A test asserts that order, because doing
it the other way round would silently restore the coarse granularity this ADR exists
to remove.

A pause breaks the paragraph, and the threshold is tight (2s) for a measured reason:
in continuous speech whisper's segments **touch** — the next starts where the previous
ends (0 → 5.780 → 6.780 in a real capture) — so any gap above ~1s is a real pause.
Tight also preserves conversation order better, because a pause in one track is
often the *other* track speaking.

**The price, stated:** a paragraph can span up to a window, so a short interjection
by the other track sorts *after* the paragraph it interrupted. It cannot be fixed by
splitting on the other track's speech, because the join deliberately writes the
system window **before** the mic's utterances for that interval exist — splitting on
what has arrived would make the output depend on arrival order, which is the very
thing this ADR removed.

## What the tests hold

- The **invariant** directly: a system utterance is never dropped because of the
  mic, not even when the pair matches and the mic landed first.
- The **measured gap** itself, not just the threshold: real echo ≥ 0.85,
  coincidence ≤ 0.60, and a gap of at least 0.25 between them. A future
  recalibration cannot slide to a pretty number without evidence.
- The two tracks yield the **same** time for the same utterance — the test that
  reproduces today's skew.
- The join: the gate releases on coverage, on close (pause/stop) and on the
  ceiling; both sides of it are on one clock; the wait happens **before** the
  leakage test, and nothing awaits between that test and the record (ADR-0022 §26).
- The anchor's cross-language contract (Swift prints what Rust reads), because a
  mismatch would degrade silently.
- The final system flush happens **before** `brain_meeting_stop`.
- Two carves at the same offset never share a file (§28), and the purge leaves
  **nothing** behind — every transient name of the live path is seeded in the test.
- The parser against **real** whisper-cli output, and that a carved window's
  timestamps restart at zero (verified by running ffmpeg and whisper, not by reading
  their docs).
