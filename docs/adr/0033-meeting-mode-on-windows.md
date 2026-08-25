# ADR-0033 — Meeting mode on Windows: the capturer was the macOS part, not the mode

> Numbering note: this was drafted as `0031`, which looked free because the
> file sequence has a HOLE there — `0032` was already on main. Two decisions
> reached for the same empty slot: this one and the executable extension
> (PR #90, with #92 stacked on it). Git would have merged both cleanly,
> because the filenames differ, and the repo would carry two ADR-0031 with
> code comments citing "ADR-0031" for two different decisions — the same
> collision the ADR-0013 note in `0023` records. This one moved because it is
> the cheaper side: 14 references against 74. The next free number after
> `0032` is `0033`, not `0032`.

- **Status:** accepted and implemented (2026-08-20)
- **Extends:** ADR-0005 (meeting mode: mic + system audio, mixed late,
  transcribed whole), ADR-0025 (track attribution: each capture segment reports
  the epoch of its own first sample)
- **Amends:** ADR-0005's platform scope. Meeting mode was recorded as macOS-only
  because its capturer is Swift + ScreenCaptureKit. Nothing else about the mode
  was ever macOS-specific, and this decision separates the two.
- **Revokes:** nothing.

## Context

Starting a meeting on Windows refused with:

```
não iniciei a reunião: o modo reunião só funciona no macOS
(captura via ScreenCaptureKit) — use "ao vivo" ou "gravar tudo"
```

That message was accurate about the *implementation* and wrong about the
*feature*. Reading the sidecar contract showed how small the macOS-specific part
actually is — 163 lines of Swift behind four observable behaviours:

| The contract | Where it lives |
|---|---|
| `loro-syscap <out.wav>` writes system audio to that path | argv |
| one line `first-sample-epoch-ms <n>` — the WAV's own t=0 (ADR-0025) | stdout |
| closing its stdin finalizes the WAV and exits 0 | stdin EOF |
| exit code 4 means the Screen Recording permission was denied | exit status |

Everything downstream of the WAV — mixing the two tracks with ffmpeg, the
cross-track echo filter (ADR-0022 §24b), transcription, the analysis that IS the
meeting's output (ADR-0018) — never knew which platform produced the file. So
meeting mode on Windows reduces to one question: **where does the second track
come from?**

## Measurements

| What was asked | The witness | The answer |
|---|---|---|
| does a new crate have to be downloaded? | `Cargo.lock` + `~/.cargo/registry` | `windows` 0.61.3 is already in the tree via Tauri and already extracted locally — feature flags only, no fetch |
| does loopback need a permission prompt? | ran a real 3s capture | no prompt at any point; nothing to grant, unlike macOS Screen Recording |
| what format does the endpoint hand over? | the same capture | 48000 Hz, 8-byte block — stereo IEEE float32 |
| does the WAV track wall time? | 3s capture, header arithmetic | 2.999 s |
| is the silence padding what makes that true? | same capture, padding removed | **2.990 s** — so no. The endpoint was already delivering silent packets |

That last row corrected a premise. The padding was written believing an idle
render endpoint delivers nothing; on this machine it delivers silence on its own,
and the pad contributed 9 ms out of 3 s. It stays as a guard for the case where
no process holds a render stream, labelled in the code as **not reproduced**, and
it is safe because it only ever appends.

## Decision

**1. Windows captures system audio in-process, through WASAPI loopback on the
default render endpoint.** A thread, not a sidecar.

The symmetry argument favoured a second sidecar binary with the identical
contract. The failure history outvoted it: the first Windows meeting attempt died
on `loro-syscap (program not found)` — a binary that compiled fine and was never
packaged. A sidecar has to be built, bundled *and then found*; a thread cannot
fail to be packaged. macOS keeps its sidecar because ScreenCaptureKit leaves no
choice, so the asymmetry is the honest shape of the problem.

**2. The two paths meet at the WAV and at the anchor map, not at a process
abstraction.** `system_capture_start` returns the same thing it always did: a
path in `recordings_dir`. The Windows path writes its ADR-0025 anchor into the
same keyed-by-path map, so `meeting.rs` aligns the tracks without knowing which
platform produced either one.

**3. The anchor is reported at `Start()`, not at the first buffer.** The sidecar
cannot do this — it only learns t=0 when a buffer arrives, and a silent machine
delays that, which is why the parent polls up to 1.2 s for it. The in-process
path knows the instant the stream starts, and the silence padding makes frame 0
correspond to that instant even with nothing playing. The anchor is in the map
before `system_capture_start` returns.

**4. Ten failure points collapse into two user-facing codes.** `err.capture_no_output`
when there is no active render endpoint (actionable: plug in headphones), and
`err.capture_failed:{detail}` for everything else, with the failing stage in the
detail. Ten separate msgids would have been ten translations of the same
sentence.

**5. The platform gate is one pure function on each side.** `LoroAudio.meetingSupported(os)`
in the frontend, the `syscap_start_inprocess` shim in the backend. The frontend
gate existed in two places (the source selector and the session start) and both
had to change together, or the selector would offer a mode the start refuses.

## Consequences

- Meeting mode works on macOS and Windows. Linux has neither capturer and says
  so by name.
- The sidecar code stays compiled on every platform even though Windows never
  reaches it. Cfg-ing it out would turn `resolve_syscap` and `parse_anchor_line`
  into dead code on Windows, and CI builds with `-D warnings`. The cost is a few
  KB of unreachable binary; the comment in `lib.rs` says why.
- The WAV writer is generic over `Write + Seek`, so the file format is tested
  over an in-memory cursor. A CI runner has no audio endpoint, and a capture path
  testable only by playing sound through real hardware would never be tested.
- The one test that needs a real endpoint is `#[ignore]`d with the command to run
  it in its own comment. It is not silently skipped and it does not pretend to
  pass in CI.
- Windows loopback taps the **default output device**. Meeting audio going to a
  device that is not the default is not captured. macOS via ScreenCaptureKit has
  no such constraint. Not solved here; if it bites, the fix is a device picker,
  which is a new decision.
