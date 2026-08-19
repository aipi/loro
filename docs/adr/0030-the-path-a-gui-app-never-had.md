# ADR-0030 — The PATH a GUI app never had

- **Status:** accepted and implemented (2026-08-19)
- **Extends:** ADR-0003 (the engine is a system dependency: binaries come from
  PATH or an env override), ADR-0005 §2, ADR-0021 (the chat runs the acervo's own
  agent CLI), ADR-0029 §4 (a loop cycle runs that same CLI unattended)
- **Amends:** nothing is revoked. The rule "binaries come from PATH" stands — this
  decision is about **which PATH** the app has when it asks.

## Context

The chat in the *installed* app answered:

```
não consegui iniciar o agente de IA: No such file or directory (os error 2)
```

for an agent CLI that was installed and working. The measurements, in order:

| What was asked | The witness | The answer |
|---|---|---|
| what PATH does the installed app have? | `ps eww` on the running `Loro.app` | `PATH=/usr/bin:/bin:/usr/sbin:/sbin` |
| where is the agent CLI? | `ls -l $(which claude)` | `/opt/homebrew/bin/claude` only |
| does the app's own probe find it? | `paths::which("claude")` under that PATH | `Some("/opt/homebrew/bin/claude")` |
| does the spawn find it? | `Command::new("claude")` under that PATH | `No such file or directory (os error 2)` |

An app opened from the Dock or Finder inherits **launchd's** PATH, not the user's:
four system directories and nothing else. No login shell ever ran, so nothing a
profile adds — Homebrew, `~/.local/bin`, a version manager's shims — is on it.

Three consequences were live in the shipped product, all from this one cause:

- **the chat and every loop cycle** spawned the agent by bare name and got ENOENT
  (`chat.rs`, `loops.rs`);
- **the env doctor** told the user to *install* a `gh` that was already installed
  — `gh` also lives only in `/opt/homebrew/bin`, and the doctor's row is a spawn;
- **the embedded terminal worked the whole time**, because it opens a LOGIN +
  INTERACTIVE shell (`term_open`). The same machine therefore had a working agent
  in one pane and a missing one in the other, which is why the report was "out of
  nowhere": nothing about the app changed, the agent's install location did.

The deeper fault is not a missing directory, it is a **split**: `paths::which`
searched the process PATH *plus* known locations, while `spawn` searched the
process PATH alone. Probe and spawn were answering different questions about the
same binary, so an availability check could pass and its own spawn still fail.
Patching call sites would have kept the split and multiplied it — `git` alone is
spawned by bare name in 38 places.

Rejected alternatives:

- **Ask the user to fix their PATH** (`launchctl config user path`, editing
  `/etc/paths`). Needs `sudo` and a reboot, is machine-global, and asks a person
  to configure their OS so that an app can find a tool the app already knows how
  to find.
- **Hardcode a longer known-locations list only.** Covers Homebrew and the CLI's
  own installer, never nvm/asdf/fnm/volta or a custom prefix — the list is
  unbounded and every entry is a guess about someone else's machine.
- **Absolute path in the acervo's `agent` field.** Works (it is the workaround
  handed to the user who reported it), but it is per-project, per-machine
  configuration for something the app can determine itself, and it fixes only the
  agent — not `gh`, not `ffmpeg`.

## Decision

**Hydrate the process PATH once, at startup, before anything is spawned**
(`proc::hydrate_path`, called from `run()` right after logging is up). From then
on the process PATH *is* the user's PATH, so probe and spawn are the same
question again.

Two sources, in this order:

1. **The user's login shell, asked once** — `$SHELL -l -i -c /usr/bin/env`, the
   PATH line off the dump. This is the only source that knows about version
   managers and custom prefixes. `-l -i` matches what the embedded terminal
   already opens, so both see the same tools; `-i` is load-bearing because
   nvm/asdf/fnm are set up in `.zshrc`, not `.zprofile`. Asked only when the
   current PATH has **no directory under `$HOME`** — the signature of a PATH no
   profile ever touched. Never on Windows, where a GUI process inherits the
   machine+user PATH from the registry.
2. **`paths::known_bin_dirs()`** — Homebrew (both prefixes), `/usr/local/bin`,
   `~/.loro/bin`, and the per-user locations the agent CLI's own installers use
   (`~/.local/bin`, `~/.claude/local`) plus the common JS/Rust toolchain bins.
   This is the floor for when the shell cannot answer: no `SHELL`, an rc file
   that dies, or the 5s probe timeout.

Ordering is a rule, not an accident: **the shell's own ordering first, then what
the process already had, then the known directories last.** A package-manager
default may never shadow a binary the user's own PATH already resolves. Nothing
is ever dropped, and repeats are collapsed.

Two smaller decisions ride along, because the split is only closed with them:

- **The agent is spawned through a resolution, never a bare name**
  (`chat::agent_command`): `paths::which` answers, and the `Command` is built on
  the absolute path. Hydration alone would have been enough on the measured
  machine; resolving explicitly is what makes the probe and the spawn provably
  the same lookup on machines this decision cannot see.
- **A missing agent is a sentence, not an errno.** `err.agent_not_found:<bin>`
  names the command and says the two next steps (install it, or write its full
  path in the project's settings). `os error 2` told nobody anything.

`paths::which` also stops pretending a command *written with a path*
(`/opt/homebrew/bin/claude`, `./bin/agent`) is a name to look up — it is the
location. That case only ever worked by accident (`Path::join` swallows an
absolute right side) and answered "not found" for a relative one.

## Consequences

**Good.** One mechanism fixes every tool Loro shells out to, on every machine, in
the installed app: the agent (chat and unattended loop cycles), `gh` and the
GitHub rows of the env doctor, `git`, `ffmpeg`, the whisper binaries. Measured on
the reporting machine, starting from the launchd PATH: `claude --version` and
`gh --version` go from `os error 2` to answering, and the app's own startup log
reads `PATH hydrated from_login_shell=true before=4 after=22`.

**Cost.** One extra child process at startup, once, only when the PATH looks
GUI-minimal: measured 0.08–0.29s for the shell, 112ms for the whole hydration
including the merge. It runs an interactive rc file, so a user whose `.zshrc` is
slow pays that once at launch, bounded by a 5s timeout after which the known
directories still apply.

**Trust boundary.** Loro now takes PATH from the user's own shell configuration —
the same trust the embedded terminal has always extended, and strictly narrower
than the terminal, which runs that shell interactively. The dump is asked of
`env` (not `printf %s "$PATH"`) so the value survives a shell that does not treat
PATH as a string, and it is parsed line-wise because rc files talk on the way out
("Restored session: …" was printed before the dump on the measured machine).
Only the PATH line is read. **Nothing about the PATH is ever logged** — the log
line carries counts and a boolean, because a home directory is not something the
diagnostic channel needs (BR-8).

**Coverage.** `path_lacks_user_dirs` is tested against the exact string measured
on the installed app; `path_from_env_dump` against the real rc noise;
`merge_path_dirs` for order, repeats and the known-dirs-last rule. The defect
itself has a test that fails without the fix: with the PATH set to the four
launchd directories and a binary planted in a known location, a bare-name spawn
raises ENOENT and `agent_command` runs it (`chat.rs`, verified red by reverting
the resolution).

**Not covered.** A tool installed *after* the app was launched is still invisible
to that running instance — the probe happens once at startup, and re-asking on
every spawn would pay the shell cost forever. Restarting Loro is the answer, and
the "not found" message now says something a person can act on. The env doctor
still has no row for the agent CLI itself; it reports `git`/`gh`/identity only.
