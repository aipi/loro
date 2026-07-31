# ADR-0013 — Windows process tree via ToolHelp (agent readiness handshake)

- **Status:** accepted (owner decision, 2026-07-31)

## Context

`term_status` answers one question for the frontend: is the AI agent CLI alive
inside the embedded terminal? ADR-0002 §4 chose to ask the OS rather than guess
from terminal output, and the implementation shelled out to:

```
ps -axo pid=,ppid=,comm=
```

**`ps` does not exist on Windows.** The spawn simply fails, `.output()` returns
`Err`, and `agent_running` is therefore *always* `false` there.

That is not a cosmetic gap. `termRunAgent` polls `term_status` 50 times at 300ms
before giving up, so on Windows every habilidade, every `/loro-*` command and
every "perguntar ao acervo" opened the terminal panel, waited **15 seconds**, and
failed with "não foi possível abrir o agente no terminal". Worse, inside that
loop a session past its grace window gets the agent name retyped, so the user
could also see the launch command appear twice. The entire AI-automation layer —
one of Loro's three pillars — was unusable on Windows.

ADR-0012 made Loro *run* on Windows but missed this, because the terminal was
verified to open and never driven through a habilidade.

Two candidate replacements were rejected:

- **`wmic process get ProcessId,ParentProcessId,Name`** — the obvious no-new-
  dependency answer, and it was the plan until it was checked on the target
  machine: `wmic` has been removed from current Windows 11. Not available.
- **`tasklist`** — ships with Windows, but reports no parent PID. It could only
  answer "is a process with this name running anywhere", which would report a
  `claude` open in an unrelated window as the terminal's agent. The handshake
  exists precisely to be exact about *this* terminal's descendants.

## Decision

Read the process table straight from the Win32 **ToolHelp** snapshot API
(`CreateToolhelp32Snapshot` + `Process32FirstW`/`Process32NextW`) on Windows,
keeping `ps` on Unix. `process_table() -> Vec<(pid, ppid, name)>` is the platform
seam; everything above it is unchanged and stays pure:
`has_descendant_process` still does the tree walk and is still unit-tested.

This adds `windows-sys` as a `cfg(windows)` dependency. It is already present in
the build as a transitive Tauri dependency, so it costs no extra download or
compile time, and the two features used are narrow (`Win32_Foundation`,
`Win32_System_Diagnostics_ToolHelp`).

Reading a snapshot in-process is also the right shape for the caller: at 300ms
polling, the `ps` design spawned a subprocess ~50 times per habilidade, whereas a
snapshot is a normal API call with no process creation at all.

**Name comparison became platform-tolerant.** ToolHelp reports the bare image
name and always keeps the extension (`claude.exe`), while the configured agent is
`claude` and macOS `ps -axo comm=` may print a full path. `process_name_matches`
reduces both sides to a lowercase, extension-free basename, splitting on `/` and
`\`. Lowercasing is required on Windows, where process names are
case-insensitive, and is harmless elsewhere. Without this the snapshot would have
been read correctly and still never matched — the fix is only complete with it.

## Consequences

**Good.** The agent handshake works on Windows, so habilidades, `/loro-*` and
"perguntar ao acervo" stop hanging 15 seconds and failing. macOS behavior is
untouched: same `ps` call, same tree walk. The polling cost drops from a
subprocess per poll to a snapshot on both platforms' hot path.

**Cost.** A small block of `unsafe` and a platform dependency, where before there
was a portable shell-out. The `unsafe` is confined to `process_table`, checks the
handle before use, and closes it on every exit path.

**Coverage.** The tree walk is now tested against a literal table so it runs on
every platform, not only where `ps` output can be pasted; `process_name_matches`
is tested against the real `claude.exe`, path and case variants; and
`process_table` is asserted against this machine's live table, including that the
test process itself appears in it. That last one is what proves the snapshot
actually works rather than silently returning empty — the exact failure mode the
`ps` version had.

**Not covered.** Whether the agent CLI is *ready for input* (as opposed to
running) is still inferred from the grace window in ADR-0002 §4; this ADR only
fixes the liveness question on Windows.
