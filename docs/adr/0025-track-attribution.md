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

Only a **mic** chunk may be dropped as leakage; a system window is never dropped
because of the mic. *(Implemented in the second half of this work — see Status
below.)*

### One owner of the join

The two tracks stop being two appenders racing for the same file. *(Same, second
half.)*

## Consequences

- Every utterance carries a true `[mm:ss]`. Before, only the first of each 18s
  window did.
- The interleaving between the tracks is real, so `reuniao.md` finally reads in
  conversation order.
- The mutual-containment crutch in the echo filter and the separate
  `crossTrackDuplicate` mechanism become removable once attribution is directional
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

This ADR covers work delivered in two PRs, because the halves have different
natures and each stands on its own:

1. **One clock, each utterance at its own time** (this document as accepted):
   invariants 1 and 2, plus the stop-time system flush. No change to the
   attribution rule — it is still first-arrival — so this half is verifiable
   without provoking any leakage.
2. **Physics decides the label**: invariants 3 and 4, with the thresholds
   calibrated against the owner's real captures the way ADR-0022 §25 did (0.92 echo
   vs 0.13 unrelated; the cut sits in the gap, not at a guess). Recorded as an
   amendment to this ADR when it lands.
