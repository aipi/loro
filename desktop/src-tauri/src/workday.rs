// ADR-0038 — the recorded workday's backend half: its config in
// ~/.loro/config.json (§5) and the "do not idle-sleep" assertion while it records
// (§4). The decision of WHEN to record is not here: it lives in the frontend
// (`src/workday.js`), because the app's own clock knows the timezone (ADR-0029
// §4.6) — the backend never needs a timezone database.

use serde::{Deserialize, Serialize};
use std::process::Child;
use std::sync::Mutex;

use crate::config::{read_loro_config, write_loro_config};

/// `"diaGravado": { "ligado", "inicio", "fim", "dias" }` (ADR-0038 §5). Absent
/// from the file = off.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkdayCfg {
    #[serde(default)]
    pub ligado: bool,
    #[serde(default = "default_inicio")]
    pub inicio: String,
    #[serde(default = "default_fim")]
    pub fim: String,
    // 0 = Sunday, like the loop rhythms
    #[serde(default = "all_days")]
    pub dias: Vec<u8>,
}

fn default_inicio() -> String {
    "09:00".into()
}
fn default_fim() -> String {
    "18:30".into()
}
fn all_days() -> Vec<u8> {
    (0..7).collect()
}

impl Default for WorkdayCfg {
    fn default() -> Self {
        Self {
            ligado: false,
            inicio: default_inicio(),
            fim: default_fim(),
            dias: all_days(),
        }
    }
}

// "HH:MM" → minutes. "24:00" is the end of the day. The same grammar as
// `parseClock` in src/workday.js — a window either side reads, both read.
fn clock_minutes(s: &str) -> Option<u32> {
    let (h, m) = s.trim().split_once(':')?;
    if h.len() != 2 || m.len() != 2 {
        return None;
    }
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    match (h, m) {
        (24, 0) => Some(1440),
        (0..=23, 0..=59) => Some(h * 60 + m),
        _ => None,
    }
}

/// Refuse a window that cannot be recorded instead of storing one the tick would
/// silently ignore: the screen must say why the toggle did not take.
pub fn normalize(cfg: WorkdayCfg) -> Result<WorkdayCfg, String> {
    let ini = clock_minutes(&cfg.inicio).ok_or("err.workday_invalid_window")?;
    let fim = clock_minutes(&cfg.fim).ok_or("err.workday_invalid_window")?;
    if ini >= fim {
        return Err("err.workday_invalid_window".into());
    }
    let mut dias: Vec<u8> = cfg.dias.into_iter().filter(|d| *d < 7).collect();
    dias.sort_unstable();
    dias.dedup();
    Ok(WorkdayCfg {
        ligado: cfg.ligado,
        inicio: cfg.inicio.trim().to_string(),
        fim: cfg.fim.trim().to_string(),
        dias,
    })
}

#[tauri::command]
pub fn workday_get() -> WorkdayCfg {
    read_loro_config().dia_gravado.unwrap_or_default()
}

#[tauri::command]
pub fn workday_set(cfg: WorkdayCfg) -> Result<WorkdayCfg, String> {
    let cfg = normalize(cfg)?;
    let mut all = read_loro_config();
    all.dia_gravado = Some(cfg.clone());
    write_loro_config(&all)?;
    Ok(cfg)
}

// ---- §4 · the Mac does not idle-sleep while the day records -----------------

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
        .map_err(|_| "err.workday_keep_awake_failed".to_string())?;
    *slot = Some(child);
    Ok(())
}

fn release_with(slot: &mut Option<Child>) {
    if let Some(mut c) = slot.take() {
        let _ = c.kill();
        let _ = c.wait(); // reap: no zombie per recorded day
    }
}

/// Called on app exit: `-w` would release it a moment later anyway, but the app
/// says goodbye to what it started.
pub fn release_keep_awake() {
    if let Ok(mut slot) = HOLD.lock() {
        release_with(&mut slot);
    }
}

/// `on` → hold the assertion; `off` → release it. Returns whether it is held.
/// macOS only in this version (ADR-0038, "Explicitly NOT done"): elsewhere it
/// holds nothing and says so.
#[tauri::command]
pub fn workday_keep_awake(on: bool) -> Result<bool, String> {
    let mut slot = HOLD.lock().map_err(|_| "lock envenenado".to_string())?;
    if !on || !cfg!(target_os = "macos") {
        release_with(&mut slot);
        return Ok(false);
    }
    hold_with(&mut slot, CAFFEINATE, &caffeinate_args(std::process::id()))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adr0038_absent_config_is_off_with_the_default_window() {
        let cfg: crate::config::LoroConfig =
            serde_json::from_str(r#"{"acervos":[],"active":""}"#).unwrap();
        assert!(cfg.dia_gravado.is_none());
        let d = WorkdayCfg::default();
        assert!(!d.ligado);
        assert_eq!((d.inicio.as_str(), d.fim.as_str()), ("09:00", "18:30"));
        assert_eq!(d.dias, vec![0, 1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn adr0038_the_config_shape_is_the_one_the_adr_documents() {
        let json = r#"{"acervos":[],"active":"","diaGravado":{"ligado":true,"inicio":"09:00","fim":"18:30","dias":[1,2,3,4,5]}}"#;
        let cfg: crate::config::LoroConfig = serde_json::from_str(json).unwrap();
        let w = cfg.dia_gravado.clone().unwrap();
        assert!(w.ligado);
        assert_eq!(w.dias, vec![1, 2, 3, 4, 5]);
        // and it round-trips under the same key, so the external agent can write it
        let back = serde_json::to_string(&cfg).unwrap();
        assert!(back.contains(r#""diaGravado":{"ligado":true"#), "{back}");
        // a config that never had it is written byte-for-byte without it
        let plain = serde_json::to_string(&crate::config::LoroConfig::default()).unwrap();
        assert!(!plain.contains("diaGravado"), "{plain}");
    }

    #[test]
    fn adr0038_a_window_that_cannot_be_recorded_is_refused() {
        let ok = |i: &str, f: &str| WorkdayCfg {
            ligado: true,
            inicio: i.into(),
            fim: f.into(),
            dias: vec![6, 1, 1, 9, 0],
        };
        let n = normalize(ok("09:00", "18:30")).unwrap();
        assert_eq!(n.dias, vec![0, 1, 6], "sorted, deduplicated, 0..6 only");
        assert!(normalize(ok("22:00", "24:00")).is_ok());
        for (i, f) in [
            ("18:30", "09:00"),
            ("10:00", "10:00"),
            ("9:00", "18:30"),
            ("09:00", "24:01"),
            ("xx", "18:30"),
        ] {
            assert_eq!(
                normalize(ok(i, f)).unwrap_err(),
                "err.workday_invalid_window",
                "{i}–{f}"
            );
        }
    }

    #[test]
    fn adr0038_caffeinate_holds_idle_sleep_tied_to_the_app_pid() {
        assert_eq!(CAFFEINATE, "/usr/bin/caffeinate");
        assert_eq!(caffeinate_args(4242), vec!["-i", "-w", "4242"]);
    }

    // The lifecycle, with a stand-in for caffeinate (the test must not hold a
    // real power assertion): one holder per "on", released on "off".
    #[cfg(unix)]
    #[test]
    fn adr0038_the_holder_is_spawned_once_and_reaped_on_release() {
        let mut slot: Option<Child> = None;
        let args = vec!["30".to_string()];
        hold_with(&mut slot, "/bin/sleep", &args).unwrap();
        let pid = slot.as_ref().unwrap().id();
        hold_with(&mut slot, "/bin/sleep", &args).unwrap();
        assert_eq!(slot.as_ref().unwrap().id(), pid, "a second on is a no-op");
        release_with(&mut slot);
        assert!(slot.is_none());
        // releasing nothing is fine (app exit without a recorded day)
        release_with(&mut slot);
        // a missing binary is a product error code, not an io::Error in English
        assert_eq!(
            hold_with(&mut slot, "/nonexistent/caffeinate", &[]).unwrap_err(),
            "err.workday_keep_awake_failed"
        );
    }
}
