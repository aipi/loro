// The Mac does not idle-sleep while Loro records. Born in ADR-0038 §4 for the
// recorded workday; ADR-0041 keeps it and widens it to ANY recording (a manual
// meeting, a scheduled one, the live mode): a 40-minute meeting on a laptop with a
// 30-minute idle timer used to lose its tail to sleep.
//
// It is driven from the backend's single recording switch (`set_recording` in
// lib.rs), not from the frontend: every start, stop, pause and resume already
// passes there, so there is no second state to keep in step.

use std::process::Child;
use std::sync::Mutex;

// `-i` holds the "prevent idle sleep" assertion, and nothing more: the display
// may still sleep, and a closed lid without an external monitor still sleeps (the
// system's call, out of reach of an unprivileged app). `-w <pid>` ties the
// assertion to Loro's own process, so a crash or a force-quit releases it too —
// the app never leaves a Mac it no longer runs on awake. Absolute path for the
// same reason as ADR-0030: a GUI launch does not inherit the shell's PATH.
const CAFFEINATE: &str = "/usr/bin/caffeinate";

fn caffeinate_args(pid: u32) -> Vec<String> {
    vec!["-i".into(), "-w".into(), pid.to_string()]
}

static HOLD: Mutex<Option<Child>> = Mutex::new(None);

// Spawn the holder once; a second "on" while it lives is a no-op, and one that
// died (killed from outside) is respawned.
fn hold_with(slot: &mut Option<Child>, program: &str, args: &[String]) -> Result<(), String> {
    if let Some(c) = slot.as_mut() {
        if matches!(c.try_wait(), Ok(None)) {
            return Ok(());
        }
    }
    let child = std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| "err.keep_awake_failed".to_string())?;
    *slot = Some(child);
    Ok(())
}

fn release_with(slot: &mut Option<Child>) {
    if let Some(mut c) = slot.take() {
        let _ = c.kill();
        let _ = c.wait(); // reap: no zombie per recording
    }
}

/// Called on app exit: `-w` would release it a moment later anyway, but the app
/// says goodbye to what it started.
pub fn release() {
    if let Ok(mut slot) = HOLD.lock() {
        release_with(&mut slot);
    }
}

/// `on` → hold the assertion; `off` → release it. macOS only: elsewhere it holds
/// nothing. A failure is logged, never raised — a recording must not fail
/// because the Mac could not be kept awake.
pub fn set(on: bool) {
    let Ok(mut slot) = HOLD.lock() else {
        return;
    };
    if !on || !cfg!(target_os = "macos") {
        release_with(&mut slot);
        return;
    }
    if let Err(e) = hold_with(&mut slot, CAFFEINATE, &caffeinate_args(std::process::id())) {
        tracing::warn!(error = %e, "keep-awake not held");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caffeinate_holds_idle_sleep_tied_to_the_app_pid() {
        assert_eq!(CAFFEINATE, "/usr/bin/caffeinate");
        assert_eq!(caffeinate_args(4242), vec!["-i", "-w", "4242"]);
    }

    // The lifecycle, with a stand-in for caffeinate (the test must not hold a
    // real power assertion): one holder per "on", released on "off".
    #[cfg(unix)]
    #[test]
    fn the_holder_is_spawned_once_and_reaped_on_release() {
        let mut slot: Option<Child> = None;
        let args = vec!["30".to_string()];
        hold_with(&mut slot, "/bin/sleep", &args).unwrap();
        let pid = slot.as_ref().unwrap().id();
        hold_with(&mut slot, "/bin/sleep", &args).unwrap();
        assert_eq!(slot.as_ref().unwrap().id(), pid, "a second on is a no-op");
        release_with(&mut slot);
        assert!(slot.is_none());
        release_with(&mut slot);
        assert_eq!(
            hold_with(&mut slot, "/nonexistent/caffeinate", &[]).unwrap_err(),
            "err.keep_awake_failed"
        );
    }
}
