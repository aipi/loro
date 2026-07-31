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
use std::process::Command;

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

// A Command that never flashes a console window.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    // `mut` is only needed on Windows, where the cfg block below sets the flag.
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(gui_creation_flags());
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn gui_flags_are_create_no_window() {
        // 0x08000000 — the value is load-bearing: a wrong flag either shows the
        // window anyway or changes how the child is created. Measured effect on
        // 30 console spawns: 82 console hosts without it, 20 with it (ADR-0013).
        assert_eq!(gui_creation_flags(), 0x0800_0000);
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
