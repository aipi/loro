// Loro — subprocess creation.
//
// Every child process MUST be created through `command()` instead of
// `Command::new`. Loro is a GUI app (`windows_subsystem = "windows"`), so on
// Windows a plainly spawned console child gets its own console window, which
// flashes on screen for the lifetime of the child. Loro shells out constantly —
// git state polling, the env doctor, `which`-style probes — so the result is a
// black window blinking over the UI many times a minute.
//
// This is invisible in a debug build: `tauri dev` keeps a console attached, so
// children inherit it and nothing flashes. It only shows in the release binary.
//
// CREATE_NO_WINDOW suppresses the console without detaching the pipes, so
// stdout/stderr capture keeps working exactly as before.
//
// Not for the embedded terminal: that runs through portable-pty, which allocates
// a pseudo-console on purpose and never shows a window.

use std::ffi::OsStr;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;
use tracing::info;

// winbase.h CREATE_NO_WINDOW. Hardcoded rather than pulled from a winapi crate
// to keep this module dependency-free on every platform.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// Process creation flags for a GUI-spawned child. Windows-only: elsewhere there
// is nothing to suppress, and a cross-platform version would be dead code off
// Windows (clippy's dead_code, denied in CI).
#[cfg(windows)]
pub fn gui_creation_flags() -> u32 {
    CREATE_NO_WINDOW
}

// Session markers another agent leaves in the environment. Loro spawns the
// user's agent CLI (embedded terminal and chat), and if Loro itself was started
// from inside an agent session those markers are inherited: the CLI then
// believes it is a *nested child* of that session and silently turns off its own
// transcript ("Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION
// marker"). Loro's agent is a session of its own, so the markers are stripped.
//
// This is a deny list, never a `CLAUDE_*` wildcard: real user configuration
// travels under the same prefix (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_USE_BEDROCK`,
// `CLAUDE_CODE_MAX_OUTPUT_TOKENS`…) and dropping it would break the agent the
// user configured.
pub const INHERITED_SESSION_MARKERS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_EFFORT",
    "CLAUDE_PID",
];

// A Command that never flashes a console window and never pretends to be the
// child of somebody else's agent session.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    // `mut` is only needed on Windows, where the cfg block below sets the flag.
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(gui_creation_flags());
    }
    for k in INHERITED_SESSION_MARKERS {
        cmd.env_remove(k);
    }
    cmd
}

// ---- the PATH a GUI app never had (ADR-0030) --------------------------------
//
// A double-clicked app inherits launchd's PATH, not the user's. MEASURED on the
// installed Loro (`ps eww` on the running app, macOS 25.6):
// PATH=/usr/bin:/bin:/usr/sbin:/sbin — while `claude` and `gh` exist only under
// /opt/homebrew/bin. Every bare-name spawn therefore failed for a reason no
// message could explain: the chat answered "não consegui iniciar o agente de IA:
// No such file or directory (os error 2)" for an agent that was installed and
// working, and the env doctor told the user to install a `gh` that was already
// there. The embedded terminal never showed it, because it opens a LOGIN shell
// (lib.rs `term_open`) — the same machine had a working agent in one pane and a
// missing one in the other.
//
// Patching each call site was never the fix: `paths::which` searched the known
// locations while `spawn` searched the process PATH, so the probe and the spawn
// answered different questions about the same binary. Hydrating the process PATH
// once, before anything is spawned, makes it one question again.
//
// Two sources, in this order:
//  1. the user's LOGIN + INTERACTIVE shell, asked once — the only source that
//     knows about nvm/asdf/fnm/volta or a custom prefix. Interactive matters:
//     those live in .zshrc, not .zprofile. Measured cost: 0.08–0.29s.
//  2. `paths::known_bin_dirs()` — the floor for when the shell cannot answer.

// A shell that never returns must cost this, not the app's startup.
const PATH_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

// Does this PATH look like one no login shell ever touched? A user profile
// essentially always contributes a directory under $HOME (~/.local/bin,
// ~/.cargo/bin, a version manager's shims); launchd's PATH is four system
// directories and nothing else.
pub fn path_lacks_user_dirs(path: &str, home: &Path) -> bool {
    !std::env::split_paths(path).any(|d| d.starts_with(home))
}

// The PATH line out of an `env` dump. The dump is asked of the shell instead of
// `printf %s "$PATH"` because the value must survive a shell that does not treat
// PATH as a string (fish expands `$PATH` to a space-separated list); `env` prints
// the exported variable verbatim in every shell. And it is parsed line-wise
// because an rc file talks on the way out — the probe here printed "Restored
// session: …" before the dump.
pub fn path_from_env_dump(dump: &str) -> Option<String> {
    dump.lines()
        .find_map(|l| l.strip_prefix("PATH="))
        .filter(|p| !p.is_empty())
        .map(str::to_string)
}

// The user's real PATH, from the same kind of shell the embedded terminal opens,
// so both see the same tools.
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty())?;
    let mut child = command(&shell)
        .args(["-l", "-i", "-c", "/usr/bin/env"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let out = child.stdout.take()?;
    // Read in a thread: an rc file that blocks would otherwise hold the window.
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = BufReader::new(out).read_to_string(&mut buf);
        let _ = tx.send(buf);
    });
    let dump = rx.recv_timeout(PATH_PROBE_TIMEOUT).ok();
    let _ = child.kill();
    let _ = child.wait();
    dump.as_deref().and_then(path_from_env_dump)
}

// PATH entries in order, without repeats: the sources in the order given, then
// the known locations LAST — a package-manager default must never shadow a
// binary the user's own PATH already resolves.
pub fn merge_path_dirs(sources: &[&str], extra: &[PathBuf]) -> String {
    let mut out: Vec<PathBuf> = Vec::new();
    for src in sources {
        for d in std::env::split_paths(src) {
            if !d.as_os_str().is_empty() && !out.contains(&d) {
                out.push(d);
            }
        }
    }
    for d in extra {
        if !out.contains(d) {
            out.push(d.clone());
        }
    }
    // A directory with a path separator in it cannot be joined back: keep the
    // PATH we were given rather than hand the process an empty one.
    std::env::join_paths(&out)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| sources.first().map(|s| s.to_string()).unwrap_or_default())
}

// Called ONCE from `run()`, before anything is spawned.
pub fn hydrate_path() {
    let current = std::env::var("PATH").unwrap_or_default();
    let probed = if cfg!(windows) {
        // A Windows GUI process inherits the machine+user PATH from the
        // registry, so there is nothing missing to go and fetch.
        None
    } else if path_lacks_user_dirs(&current, &crate::paths::user_home()) {
        login_shell_path()
    } else {
        None
    };
    let sources: Vec<&str> = match probed.as_deref() {
        Some(p) => vec![p, current.as_str()],
        None => vec![current.as_str()],
    };
    let merged = merge_path_dirs(&sources, &crate::paths::known_bin_dirs());
    let before = std::env::split_paths(&current).count();
    let after = std::env::split_paths(&merged).count();
    if merged != current {
        std::env::set_var("PATH", &merged);
    }
    // Counts, never the PATH itself: a log line is not the place for a home dir
    // (BR-8).
    info!(
        from_login_shell = probed.is_some(),
        before, after, "PATH hydrated"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn gui_flags_are_create_no_window() {
        // 0x08000000 — the value is load-bearing: a wrong flag either shows the
        // window anyway or changes how the child is created. Measured effect on
        // 30 console spawns: 82 console hosts without it, 20 with it (ADR-0023,
        // renumbered from 0014 — that number belongs to the fila decision).
        assert_eq!(gui_creation_flags(), 0x0800_0000);
    }

    #[test]
    fn a_spawned_agent_does_not_inherit_another_agents_session() {
        // The symptom this prevents is silent: the agent runs, but its transcript
        // is never written because it thinks it is a nested child.
        std::env::set_var("CLAUDE_CODE_CHILD_SESSION", "1");
        let out = if cfg!(windows) {
            command("cmd")
                .args(["/C", "echo %CLAUDE_CODE_CHILD_SESSION%"])
                .output()
                .unwrap()
        } else {
            command("sh")
                .args(["-c", "printf %s \"$CLAUDE_CODE_CHILD_SESSION\""])
                .output()
                .unwrap()
        };
        std::env::remove_var("CLAUDE_CODE_CHILD_SESSION");
        let seen = String::from_utf8_lossy(&out.stdout);
        assert!(
            seen.trim().is_empty() || seen.trim() == "%CLAUDE_CODE_CHILD_SESSION%",
            "child still saw the marker: {seen:?}"
        );
    }

    #[test]
    fn stripping_markers_never_touches_user_configuration() {
        // A `CLAUDE_*` wildcard would silently drop the agent the user configured.
        for keep in [
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_MODEL",
        ] {
            assert!(
                !INHERITED_SESSION_MARKERS.contains(&keep),
                "{keep} is configuration, not a session marker"
            );
        }
    }

    // ---- PATH hydration (ADR-0030) -----------------------------------------

    #[test]
    fn the_gui_path_is_told_apart_from_a_shell_path() {
        let home = Path::new("/Users/x");
        // the string measured on the installed Loro.app
        assert!(path_lacks_user_dirs("/usr/bin:/bin:/usr/sbin:/sbin", home));
        // homebrew alone is still not a user profile talking
        assert!(path_lacks_user_dirs("/opt/homebrew/bin:/usr/bin", home));
        // a profile essentially always puts something under $HOME on it
        assert!(!path_lacks_user_dirs(
            "/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin",
            home
        ));
    }

    #[test]
    fn the_path_line_survives_what_an_rc_file_prints() {
        // "Restored session:" is real: a shell plugin on the machine where this
        // was written printed it BEFORE the dump.
        let dump = "Restored session: qua 19 ago 2026\nSHELL=/bin/zsh\nPATH=/opt/homebrew/bin:/usr/bin\nHOME=/Users/x\n";
        assert_eq!(
            path_from_env_dump(dump).unwrap(),
            "/opt/homebrew/bin:/usr/bin"
        );
        assert!(path_from_env_dump("nothing here\n").is_none());
        assert!(path_from_env_dump("PATH=\n").is_none());
    }

    #[test]
    fn merging_keeps_order_drops_repeats_and_appends_the_known_dirs_last() {
        let merged = merge_path_dirs(
            &["/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin"],
            &[PathBuf::from("/x/bin"), PathBuf::from("/usr/bin")],
        );
        // the shell's ordering first, nothing dropped, nothing duplicated, and
        // the known dir last — it may never shadow the user's own resolution
        assert_eq!(merged, "/opt/homebrew/bin:/usr/bin:/bin:/x/bin");
    }

    #[test]
    fn command_still_captures_stdout() {
        // The real risk of setting creation flags is breaking pipe capture, and
        // every caller here reads stdout. Prove a round trip works.
        let out = if cfg!(windows) {
            command("cmd").args(["/C", "echo loro"]).output().unwrap()
        } else {
            command("echo").arg("loro").output().unwrap()
        };
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "loro");
    }
}
