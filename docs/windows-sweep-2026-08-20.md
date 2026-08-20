# Windows sweep — 2026-08-20

A diagnostic pass over the whole product on Windows 11 (10.0.26200), Loro 0.13.1
built from `main` at `bdf2373`. The goal was to find what breaks, what is missing
by design, and what is only this machine — **before** a user finds it, which is
how every previous Windows defect in this project was found.

Nothing here is fixed except one tooling defect (see §5); everything else is an
issue.

## 0. How to read this

Three categories, never mixed:

| Tag | Meaning |
|---|---|
| **DEFECT** | Windows bug in the product. Has an issue. |
| **BY DESIGN** | macOS-only feature. Correct behaviour is that the UI does not offer it. |
| **ENVIRONMENT** | This machine, not the product. No issue. |

Every claim of cause below carries the measurement that produced it (CLAUDE.md
§7.1). Where something could not be measured, it says so instead of guessing.

## 1. Build and boot

The card said the installed app was 0.13.x. It was not — **measured**:

```
C:\Users\bernardo.peixer\Loro\Loro.exe  FileVersion 0.7.0  (31 jul 2026)
```

0.7.0 predates `chat.rs`, `loops.rs`, `intake.rs`, `diff.rs`, `loops.js`,
`review.js`, `shell.js` and `mdedit.js` — the exact modules the card wanted
exercised. Sweeping that binary would have measured nothing. So 0.13.1 was built
from this worktree (`npm run tauri build -- --bundles msi`, exit 0) and every
runtime result below comes from **that** binary.

Boot log (`~/.loro/logs/loro.log.2026-08-20`, read as UTF-8):

```
INFO desktop_lib: Loro starting os="windows"
INFO desktop_lib::proc: PATH hydrated from_login_shell=false before=61 after=58
INFO doctor: diagnostics whisper_stream=true models=1 acervo=true
INFO ui-diag: [ui:main] init ok · TAURI=[app,core,dpi,…] · gUM=true
INFO env_doctor: env checks git=true gh=true authed=true identity=true remote=false offline=false versioning_enabled=false
```

`from_login_shell=false` is ADR-0030 behaving as written: `hydrate_path()`
short-circuits on Windows because a GUI process already inherits the machine+user
PATH from the registry. **Works.**

## 2. Flow-by-flow verdict

| Flow | Verdict | Evidence |
|---|---|---|
| App boot, WebView2, IPC surface | **works** | `init ok · TAURI=[…] · gUM=true`; window alive at 120s |
| PATH hydration (ADR-0030) | **works** | `from_login_shell=false before=61 after=58` — the Windows branch |
| Engine doctor | **works** | `whisper_stream=true models=1 acervo=true` |
| Mic capture + device enumeration | **works** | `devices=[{"index":0,"name":"Grupo de microfones (Tecnologia Intel® Smart Sound…)"}]` — accents intact, so log encoding is right |
| **Record-all** (ffmpeg → WAV 16k → whisper-cli) | **works, end to end** | `file transcription started model=large-v3-turbo lang=pt` → `file transcription finished ok=true`, 26.7s for a 7s clip. Store confirms: `loro-file-20260820-013226.webm` + `.16k.wav` both on disk |
| **Live** (whisper-stream) engine | **works (init + capture)** | ran directly: model loaded 1623.92 MB, SDL2 opened the device, printed `[Start speaking]`, alive at 20s. *Not* proven to emit text — that needs someone to speak; see §6 |
| System audio (loopback) | **works — guides, does not fail** | no loopback device on this machine (ENVIRONMENT). `pickCaptureDevice` returns `missing:"system"` → `openSystemAudioSetup()` shows the Windows branch: Sound panel → Recording tab → enable Mixagem estéreo, plus VB-Cable download. Backed by `control.exe mmsys.cpl,,1` and a pinned test |
| Meeting | **BY DESIGN — correctly gated** | `hostOs !== "macos"` → toast `err.meeting_macos_only`; the selector drops the option (`supported = hostOs === "macos"`, app.js:2204). No entry point reaches a raw error |
| Loops surface (loops.js, ADR-0029) | **works** | 27/27 smoke steps, incl. loop screen view/edit, blocked loop, new-loop geometry, rhythm layout |
| Tree, drag-file-to-tree, plugins sheet, settings, language switch | **works** | same smoke run, 0 JS console errors |
| Setup script (the old BOM/CP1252 bug) | **fixed, verified** | deployed copy `utf8BOM=True`; written BOM-first at lib.rs:2059 and pinned by a `#[cfg(windows)]` test |
| Agent resolution (chat + loops) | **DEFECT** | issue A — §3.1 |
| Open non-renderable asset (wav/pdf/xlsx) | **DEFECT** | issue B — §3.2 |
| Embedded terminal shell | **DEFECT** | issue C — §3.3 |
| Rust suite on Windows | **DEFECT** | issue D — §3.4 |
| `tools/smoke-ui.js` on Windows | **DEFECT — fixed here** | §5 |
| Git versioning / propose-change / branch picker | **not exercised** | §6 |
| Brainstorming → Fila → Contexto, chat round-trip, review/diff | **not exercised end to end** | §6 |

## 3. Confirmed defects

### 3.1 Agent is resolved by bare name or `.exe` only — a `.cmd`/`.ps1` shim breaks it

`paths::exe_candidates` (`desktop/src-tauri/src/paths.rs:112`) offers exactly two
candidates on Windows: `name` and `name.exe`. Windows resolves executables through
`PATHEXT` (`.COM;.EXE;.BAT;.CMD;…`), and node-installed CLIs ship a `.cmd` shim —
never a `.exe`.

Worse than missing it: the extensionless POSIX shell script that npm ships
*alongside* the shim satisfies `is_file()`, so `which` returns a path that cannot
be executed. **Measured** on this machine's `C:\nvm4w\nodejs`, which has `npm`,
`npm.cmd`, `npm.ps1` and no `npm.exe`:

```
CreateProcess FAILED: %1 não é um aplicativo Win32 válido.
```

That is the same "found, but did not execute" state `chat.rs:696` asserts against.
Because `which` said yes, the friendly `err.agent_not_found` never fires and the
user gets a raw errno for an agent that is installed and working.

Blast radius is both AI surfaces: `chat::agent_command` (`chat.rs:493`) and the
loop engine (`loops.rs:2017`).

Not reproducible with the default agent *on this machine*: `claude` here is
`C:\Users\bernardo.peixer\.local\bin\claude.exe` (measured), and `.local/bin` is in
`known_bin_dirs`, so it resolves. The defect bites npm-installed agents.

### 3.2 `brain_open_external` spawns `open`, which does not exist on Windows

`desktop/src-tauri/src/acervo.rs:2231`:

```rust
crate::proc::command("open").arg(&p).spawn()
```

Unconditional. **Measured**: `Get-Command open` returns nothing on Windows. So
"open this wav/pdf/xlsx in the default app" — offered by the UI — cannot work, and
fails as a raw spawn error.

The evidence that this is an oversight and not a decision is 20 lines below it:
`open_url_cmd` (`acervo.rs:2256`) branches to `rundll32.exe url.dll,FileProtocolHandler`
for Windows, and `audio_setup_cmd` (`lib.rs:2007`) branches to `control.exe`. Same
file, same pattern, applied everywhere except local files.

### 3.3 The embedded terminal opens `cmd.exe`, not the shell the code intends

`desktop/src-tauri/src/lib.rs:4316`:

```rust
let ps = std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into());
```

The variable is named `ps`, the fallback is `powershell.exe`, and the comment
above promises a "LOGIN + INTERACTIVE shell so the user's real PATH/profile is
loaded". **Measured**: `COMSPEC=C:\WINDOWS\system32\cmd.exe`. So the terminal is
`cmd.exe`, which has no profile mechanism at all — the stated intent is not met on
the one platform the branch exists for. A PowerShell-profile PATH (scoop, nvm4w)
is invisible, and a `.ps1` agent shim cannot be launched from it.

### 3.4 Three Rust tests are POSIX-only and are red on Windows

`cargo test --manifest-path desktop/src-tauri/Cargo.toml` — **run twice,
deterministic**:

```
test result: FAILED. 426 passed; 5 failed
```

Two of the five are the CRLF class (§4). The other three are POSIX assumptions and
will stay red after the CRLF fix:

- `proc::tests::the_gui_path_is_told_apart_from_a_shell_path` (`proc.rs:264`)
- `proc::tests::merging_keeps_order_drops_repeats_and_appends_the_known_dirs_last` (`proc.rs:291`)

  Both feed `:`-separated POSIX PATH literals to `std::env::split_paths`, which
  splits on `;` on Windows, so `"/opt/homebrew/bin:/usr/bin"` is one directory:
  ```
  left:  "/opt/homebrew/bin:/usr/bin;/usr/bin:/bin;/x/bin;/usr/bin"
  right: "/opt/homebrew/bin:/usr/bin:/bin:/x/bin"
  ```
- `chat::tests::the_agent_is_found_where_it_is_installed_not_only_on_path` (`chat.rs:669`)
  writes an extensionless `#!/bin/sh` file and expects to execute it.

**No product impact from these three**: `hydrate_path()` checks `cfg!(windows)`
first, so `path_lacks_user_dirs` is unreachable on Windows, and `merge_path_dirs`
uses the platform-correct `split_paths`/`join_paths`. The cost is that the suite
is red on Windows, which is precisely the condition under which the four previous
Windows defects went unnoticed.

## 4. Recorded, not filed — line endings

`core.autocrlf=true` with no `.gitattributes` in the repo. **Measured**:
`lib.rs` has 6932 CRLF and 0 bare LF. Every test that introspects source text with
a hardcoded `\n` therefore fails: 4 in node (`N8`, `N26`, `C11` ×2) and 2 in Rust
(`the_review_commands_are_reachable_from_the_screen`,
`sending_a_draft_already_under_review_updates_it_instead_of_asking_for_a_second`,
both `include_str!("lib.rs")` matching `",\n"` / `"\n}\n"`).

Already owned by another card (CI). Recorded here for completeness; **no issue
opened and nothing changed**, to avoid a duplicate.

Node suite for the record: `tests 879, pass 875, fail 4`.

## 5. Fixed in this PR (trivial and isolated)

`tools/smoke-ui.js` — the harness CLAUDE.md §7.1 names as *the* witness for any
"is this cut / misaligned / overflowing?" question — **never ran on Windows**:

- its browser list held only macOS and Linux paths, so it exited 0 with
  `smoke: pulado — nenhum Chrome encontrado` on a machine with **two** Chromium
  browsers installed (measured: Edge x86 + Chrome);
- and it built page URLs as `file://${path}`, which on Windows is
  `file://C:\Users\…` — not a URL Chrome resolves, so it would have loaded the
  page without `app.js` even once a browser was found.

Both fixed (Windows browser paths + `pathToFileURL`). Result on Windows:

```
27 steps, 27 ok, 0 JS console errors
comandos IPC exercitados: 37
cabeçalho: {"nav":[513,867],"right":[881,1366],"left":[14,499]}
```

This is the only behaviour change in the PR, and it is tooling, not product. It is
what let §2 report a verdict on the loops surface at all.

## 6. What this sweep did NOT establish

Stated plainly rather than implied:

- **Live transcription producing text.** The engine initialises and captures
  (§2), but the persisted setting on this machine is record-all, so the headless
  selftest exercised file mode. Emitting lines needs a human to speak.
- **Chat / skills round-trip** (`/loro-context`, `/loro-ask`). The agent resolves
  here (§3.1), but no turn was driven to completion, so nothing is claimed about
  it. The card's premise that `claude` is a `claude.ps1` shim under
  `C:\nvm4w\nodejs` is **stale** — measured, there is no claude there at all
  (ENVIRONMENT).
- **Brainstorming → Fila → Contexto end to end**, and **review/diff**. The DOM
  surface loads clean, and `brain_status` answered `configured=true ctx=1 inbox=0`,
  but no document was pushed through the whole pipeline.
- **Git versioning flows.** `env checks` reports `remote=false
  versioning_enabled=false` for the active acervo, so versioning, propose-change
  and the branch picker were never in a state to be exercised.

These need a driven GUI session, not a headless one. The smoke harness now runs on
Windows (§5), which is the cheapest way to extend coverage into them next.

## 7. Issues opened

| Issue | Title | Severity |
|---|---|---|
| [#82](https://github.com/aipi/loro/issues/82) | Agent resolution ignores `PATHEXT`: a `.cmd`/`.ps1` shim is missed, and the POSIX stub next to it is "found" but unspawnable | high — kills chat and loops for npm-installed agents |
| [#83](https://github.com/aipi/loro/issues/83) | `brain_open_external` spawns `open`, which does not exist on Windows | medium — a UI action that cannot work |
| [#84](https://github.com/aipi/loro/issues/84) | Embedded terminal opens `cmd.exe` while the code intends PowerShell | medium |
| [#85](https://github.com/aipi/loro/issues/85) | Three Rust tests assert POSIX paths and are red on Windows | medium — keeps the suite red, which is how defects hide |

Referenced above as issue A/B/C/D respectively in §2 and §3.
