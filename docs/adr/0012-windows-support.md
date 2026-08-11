# ADR-0012 — Windows support: path resolution, engine setup, loopback audio

- **Status:** accepted (2026-07-30)

> Numbering note: this is the post-baseline `docs/adr/0012-…`, continuing the
> file sequence that reaches `0011`. It is **not** the "0012" in ADR-0001's
> former-ADR map (meeting AI via a terminal-Claude skill) — that row belongs to
> the pre-baseline numbering that was consolidated into the baseline. A bare
> "ADR-0012" written from here on refers to this document.

## Context

Loro was written against macOS. It compiled on Windows, but four separate
assumptions made it unusable there, each failing only at runtime:

1. **`HOME` only.** `paths.rs::user_home` and `config.rs::loro_config_path` read
   `HOME`, which Windows does not set, so the data dir resolved to `.` — relative
   to a working directory that is not writable for an installed app.
2. **Extensionless binaries.** Engine discovery joined a bare name (`whisper-stream`)
   onto each search dir, so it never found `whisper-stream.exe`.
3. **`shasum`/`sha256sum`.** The model manager (ADR-0006) verifies a pinned
   SHA-256 before installing. Neither tool ships with Windows, so every model
   download failed with `err.sha_tool_missing` — the integrity check turned into
   a hard block.
4. **macOS-only guidance.** The setup banner offered Homebrew commands, the
   ffmpeg error named `brew`, and system audio matched the literal `/blackhole/i`
   while its menu ran `brew install blackhole-2ch` and `open -a "Audio MIDI Setup"`.

Windows also has no prebuilt `whisper-stream`. whisper.cpp publishes Windows
binaries for `whisper-cli`, but the live mode needs SDL2, which the release
artifacts are not built with. So the engine has to be compiled locally, while
staying a system dependency (ADR-0003) rather than something vendored.

## Decision

**Resolve the platform, do not fork the app.** The shared code paths stay shared;
only the values they resolve differ.

- `user_home` tries `HOME` then `USERPROFILE`, ignoring an empty value. The
  selection is a pure function taking the env getter, so it is unit-tested
  without mutating the process environment. `loro_config_path` stops reading the
  environment and reuses the shared resolver.
- Engine lookup gains `exe_candidates`: on Windows an extensionless name also
  matches its `.exe` form. Applied at all three lookup sites, including the
  syscap sidecar.
- `~/.loro/bin` joins the engine search path, so a Loro-managed engine is found
  without editing the user's `PATH`.
- `sha256_of` falls back to `certutil`, which ships with Windows. Its output is
  parsed **by shape** — the first token that is 64 hex characters — because
  certutil prints the digest under a *localized* header (pt-BR: "SHA256 hash de")
  and older versions group it into space-separated quads. Parsing by label or
  line position would break on either.

**The engine is built by a bundled script, and it is written BOM-first.** The
script is materialized from the binary and run in the embedded terminal by the
existing setup button. It must carry a UTF-8 BOM: Windows PowerShell 5.1 falls
back to CP1252 for a BOM-less `.ps1`, and the script's pt-BR em dash (UTF-8
`E2 80 94`) then decodes to `â€”`, whose trailing `U+201D` is a smart quote the
parser accepts as a string delimiter. Without the BOM the quoting unbalances and
the script dies at parse time — so this is load-bearing, not cosmetic.

The script does **not** download models. The in-app model manager already does
that with a pinned hash and an atomic install (ADR-0006), and duplicating it in
PowerShell would mean a second, weaker integrity path.

**System audio: same mechanism, platform-aware device.** Loopback capture is
already a pure function (`audio.js::pickCaptureDevice`) that picks a capture
device for `whisper-stream -c`. It gains an `os` argument, defaulting to macOS so
existing behavior is unchanged, and the name patterns move next to it:

- macOS: `blackhole`
- Windows: `stereo mix|mixagem estéreo|cable output|vb-audio|what u hear`

The pt-BR name is matched explicitly. Windows localizes device names, and
matching only the English "Stereo Mix" would silently fail on exactly the install
language this product targets.

`open_audio_midi` becomes `open_audio_setup` and opens Audio MIDI Setup on macOS,
the Sound panel's Recording tab on Windows (`control.exe mmsys.cpl,,1`).

**Windows guidance is driver-first.** Many Windows drivers already expose a
loopback device and only need it enabled, which costs no install, no admin rights
and no reboot. So step 1 opens the Sound panel; only if the driver has none does
step 2 offer VB-Cable, via a new `open_vbcable_download` command. VB-Cable is
**not** in winget (only an unrelated `Soundux` package matches the tag), so unlike
Homebrew this step cannot be one-click.

**Bundle targets become `"all"`.** They were pinned to `["app", "dmg"]`, which are
macOS-only, so a Windows build produced no installer at all. `"all"` means "every
target valid for the host", so macOS still yields exactly `app` + `dmg` while
Windows yields an MSI and an NSIS setup. Verified: both are produced, plus a
standalone `Loro.exe`. The app is unsigned on Windows (no certificate configured),
so SmartScreen warns on first run — the same unsigned-distribution posture ADR-0006
records for macOS, not a new decision.

**The ffmpeg hint travels as error detail.** Errors cross IPC as stable `err.*`
codes resolved by the frontend, and `tErr` already interpolates `{detail}`. So
the backend returns `err.ffmpeg_not_found:<install command>` and the single
translated message names the installer that exists on the running platform.
No new code, no English leaking into a pt-BR build.

## Consequences

**Good.** Windows works with no new native code and no second code path: the
SDL2 capture pipeline, the model manager and the IPC surface are all unchanged in
shape. Four upstream tests that silently failed on Windows now pass, and the new
behavior is covered by pure unit tests — including the localized certutil output
and the pt-BR device name, which are exactly the cases a macOS-only test suite
would never have caught.

**Cost.** First run on Windows compiles whisper.cpp, which needs MSVC, CMake and
several minutes. That is inherent to there being no prebuilt `whisper-stream`
with SDL2. The system-audio flow also cannot be fully automated: enabling Stereo
Mix is manual and VB-Cable is a manual driver install, so the user is guided to
the right panel but still has to act.

**Not covered.** WASAPI loopback would capture a render endpoint directly and
remove the manual step entirely, but SDL2 2.x does not expose it, so it would
mean replacing the capture path inside whisper-stream or adding a native
recorder. Deliberately out of scope; if the manual step proves to be a real
obstacle it is the natural follow-up and deserves its own ADR.

**Verification limit.** The development machine exposes no loopback device
(Intel Smart Sound, no Stereo Mix) and VB-Cable was not installed, so the Windows
matcher is covered by unit tests over real device-name strings but was never
exercised against a live loopback device. macOS was not available either, so the
unchanged macOS branches were reviewed by inspection rather than executed.
