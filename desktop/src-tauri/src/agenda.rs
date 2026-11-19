// ADR-0041 §4 — the day's agenda, WITHOUT credentials (BR-9: the app never
// stores a credential and never reads Google). An external agent, with its own
// calendar connector, writes the day into the active acervo:
//
//   <acervo>/.loro/agenda/<YYYY-MM-DD>.json
//   {"versao":1,"geradoEm":"<ISO-8601 with offset>","eventos":[{"id","titulo",
//    "inicio","fim","comConvidados"}]}
//
// This module only READS that file (raw text — parsing and every decision live
// in the pure `src/agenda.js`, testable under node) and keeps what the person
// chose to record, `<acervo>/.loro/agenda/agendadas.json`. Both are local,
// machine bookkeeping with meeting titles in them: `.loro/agenda/` is in the
// acervo's .gitignore (git.rs GIT_IGNORED), never versioned (BR-8).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::acervo::acervo_base;

/// A day file larger than this is not an agenda: refuse instead of loading it.
const MAX_AGENDA_BYTES: u64 = 512 * 1024;
const MAX_SCHEDULED: usize = 500;

fn agenda_dir(base: &Path) -> PathBuf {
    base.join(".loro").join("agenda")
}

/// `YYYY-MM-DD`, digits only: the name is built from it, so nothing else may
/// reach the path (no `..`, no separator).
fn valid_date(d: &str) -> bool {
    let b = d.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

pub fn read_day(base: &Path, date: &str) -> Result<Option<String>, String> {
    if !valid_date(date) {
        return Err("err.agenda_bad_date".into());
    }
    let p = agenda_dir(base).join(format!("{date}.json"));
    let Ok(meta) = std::fs::metadata(&p) else {
        return Ok(None);
    };
    if !meta.is_file() {
        return Ok(None);
    }
    if meta.len() > MAX_AGENDA_BYTES {
        return Err("err.agenda_too_large".into());
    }
    std::fs::read_to_string(&p)
        .map(Some)
        .map_err(|_| "err.agenda_unreadable".to_string())
}

/// What the person toggled «gravar» on: event id → the tema it records into.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    #[serde(default = "one")]
    pub versao: u32,
    #[serde(default)]
    pub eventos: BTreeMap<String, Scheduled>,
}

fn one() -> u32 {
    1
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Scheduled {
    pub tema: String,
    // the event's day, `YYYY-MM-DD`: lets the frontend drop past days
    #[serde(default)]
    pub data: String,
}

fn schedule_path(base: &Path) -> PathBuf {
    agenda_dir(base).join("agendadas.json")
}

pub fn read_schedule(base: &Path) -> Schedule {
    std::fs::read_to_string(schedule_path(base))
        .ok()
        .and_then(|t| serde_json::from_str::<Schedule>(&t).ok())
        .unwrap_or(Schedule {
            versao: 1,
            eventos: BTreeMap::new(),
        })
}

// A tema is a brainstorming slug segment: it becomes a folder name when the
// meeting starts, so a separator or a dot-dot never gets that far.
fn valid_tema(t: &str) -> bool {
    let t = t.trim();
    !t.is_empty() && t.len() <= 120 && !t.contains(['/', '\\']) && t != "." && t != ".."
}

pub fn normalize_schedule(s: Schedule) -> Result<Schedule, String> {
    if s.eventos.len() > MAX_SCHEDULED {
        return Err("err.agenda_too_large".into());
    }
    let mut eventos = BTreeMap::new();
    for (id, e) in s.eventos {
        let id = id.trim().to_string();
        if id.is_empty() || id.len() > 1024 || !valid_tema(&e.tema) {
            return Err("err.agenda_bad_schedule".into());
        }
        if !e.data.is_empty() && !valid_date(&e.data) {
            return Err("err.agenda_bad_schedule".into());
        }
        eventos.insert(
            id,
            Scheduled {
                tema: e.tema.trim().to_string(),
                data: e.data,
            },
        );
    }
    Ok(Schedule { versao: 1, eventos })
}

pub fn write_schedule(base: &Path, s: Schedule) -> Result<Schedule, String> {
    let s = normalize_schedule(s)?;
    let dir = agenda_dir(base);
    std::fs::create_dir_all(&dir).map_err(|e| crate::paths::folder_write_error(&e))?;
    // write-then-rename: the external agent may read this file at any moment
    let tmp = dir.join(".agendadas.json.tmp");
    let body = serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| crate::paths::folder_write_error(&e))?;
    std::fs::rename(&tmp, schedule_path(base)).map_err(|e| crate::paths::folder_write_error(&e))?;
    Ok(s)
}

/// The day file as text, or `None` when the agent has not written it.
#[tauri::command]
pub fn agenda_read(date: String) -> Result<Option<String>, String> {
    read_day(&acervo_base()?, &date)
}

#[tauri::command]
pub fn agenda_schedule_get() -> Result<Schedule, String> {
    Ok(read_schedule(&acervo_base()?))
}

#[tauri::command]
pub fn agenda_schedule_set(schedule: Schedule) -> Result<Schedule, String> {
    write_schedule(&acervo_base()?, schedule)
}

// ---- ADR-0041 §10 · the owner's tasks (the agent writes, Loro reads) ---------

const TASKS_FILE: &str = "tarefas.json";
const TASK_ACTIONS_FILE: &str = "tarefas-acoes.json";
const MAX_ACTIONS: usize = 1000;

/// `.loro/agenda/tarefas.json` as text (parsed in the pure `src/tarefas.js`),
/// or None when the agent has not written it.
pub fn read_tasks(base: &Path) -> Result<Option<String>, String> {
    let p = agenda_dir(base).join(TASKS_FILE);
    let Ok(meta) = std::fs::metadata(&p) else {
        return Ok(None);
    };
    if !meta.is_file() {
        return Ok(None);
    }
    if meta.len() > MAX_AGENDA_BYTES {
        return Err("err.agenda_too_large".into());
    }
    std::fs::read_to_string(&p)
        .map(Some)
        .map_err(|_| "err.agenda_unreadable".to_string())
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct TaskActions {
    #[serde(default)]
    pub acoes: Vec<TaskAction>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TaskAction {
    pub id: String,
    /// "concluir" | "reabrir"
    pub acao: String,
    /// ISO-8601 with offset, from the frontend (which knows the timezone)
    pub em: String,
}

/// APPEND one action to `tarefas-acoes.json` — the agent consumes and clears
/// it. Loro never writes Google (BR-9). Write-then-rename: the agent may be
/// reading the file at this very moment. A corrupted file starts over rather
/// than blocking the person's click.
pub fn append_task_action(base: &Path, a: TaskAction) -> Result<usize, String> {
    let id = a.id.trim();
    if id.is_empty() || id.len() > 1024 || !matches!(a.acao.as_str(), "concluir" | "reabrir") {
        return Err("err.agenda_bad_task_action".into());
    }
    let em = a.em.trim();
    if em.is_empty()
        || em.len() > 40
        || !em
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | ':' | '.' | '+'))
    {
        return Err("err.agenda_bad_task_action".into());
    }
    let dir = agenda_dir(base);
    std::fs::create_dir_all(&dir).map_err(|e| crate::paths::folder_write_error(&e))?;
    let path = dir.join(TASK_ACTIONS_FILE);
    let mut all: TaskActions = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    if all.acoes.len() >= MAX_ACTIONS {
        return Err("err.agenda_too_large".into());
    }
    all.acoes.push(TaskAction {
        id: id.to_string(),
        acao: a.acao,
        em: em.to_string(),
    });
    let tmp = dir.join(".tarefas-acoes.json.tmp");
    let body = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| crate::paths::folder_write_error(&e))?;
    std::fs::rename(&tmp, &path).map_err(|e| crate::paths::folder_write_error(&e))?;
    Ok(all.acoes.len())
}

#[tauri::command]
pub fn tarefas_read() -> Result<Option<String>, String> {
    read_tasks(&acervo_base()?)
}

#[tauri::command]
pub fn tarefas_acao(id: String, acao: String, em: String) -> Result<usize, String> {
    append_task_action(&acervo_base()?, TaskAction { id, acao, em })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "loro-agenda-{tag}-{}-{}",
            std::process::id(),
            crate::epoch_millis()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn adr0041_the_day_file_is_read_from_the_acervo_and_absent_is_none() {
        let base = tmp("read");
        assert_eq!(read_day(&base, "2026-11-18").unwrap(), None);
        let dir = base.join(".loro/agenda");
        std::fs::create_dir_all(&dir).unwrap();
        let body = r#"{"versao":1,"geradoEm":"2026-11-18T08:00:00-03:00","eventos":[]}"#;
        std::fs::write(dir.join("2026-11-18.json"), body).unwrap();
        assert_eq!(
            read_day(&base, "2026-11-18").unwrap().as_deref(),
            Some(body)
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn adr0041_the_date_can_never_walk_out_of_the_agenda_folder() {
        let base = tmp("guard");
        for bad in [
            "../../etc/passwd",
            "2026-11-1",
            "2026/11/18",
            "2026-11-18/",
            "aaaa-bb-cc",
            "",
        ] {
            assert_eq!(
                read_day(&base, bad).unwrap_err(),
                "err.agenda_bad_date",
                "{bad}"
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn adr0041_an_oversized_day_file_is_refused() {
        let base = tmp("big");
        let dir = base.join(".loro/agenda");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("2026-11-18.json"),
            vec![b' '; (MAX_AGENDA_BYTES + 1) as usize],
        )
        .unwrap();
        assert_eq!(
            read_day(&base, "2026-11-18").unwrap_err(),
            "err.agenda_too_large"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn adr0041_the_schedule_round_trips_in_the_documented_shape() {
        let base = tmp("sched");
        assert_eq!(read_schedule(&base).eventos.len(), 0);
        let mut eventos = BTreeMap::new();
        eventos.insert(
            "abc123_20261118T130000Z".to_string(),
            Scheduled {
                tema: "frota-2026".into(),
                data: "2026-11-18".into(),
            },
        );
        let saved = write_schedule(&base, Schedule { versao: 7, eventos }).unwrap();
        assert_eq!(
            saved.versao, 1,
            "the version is the app's, not the caller's"
        );
        let txt = std::fs::read_to_string(base.join(".loro/agenda/agendadas.json")).unwrap();
        assert!(txt.contains(r#""versao": 1"#), "{txt}");
        assert!(txt.contains(r#""tema": "frota-2026""#), "{txt}");
        assert_eq!(read_schedule(&base), saved);
        // a corrupted file reads as empty, never as an error that blocks recording
        std::fs::write(base.join(".loro/agenda/agendadas.json"), "{oops").unwrap();
        assert_eq!(read_schedule(&base).eventos.len(), 0);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn adr0041_task_actions_are_appended_in_the_documented_shape() {
        let base = tmp("acoes");
        assert_eq!(read_tasks(&base).unwrap(), None);
        let a = |id: &str, acao: &str| TaskAction {
            id: id.into(),
            acao: acao.into(),
            em: "2026-11-18T10:00:00-03:00".into(),
        };
        assert_eq!(append_task_action(&base, a("t1", "concluir")).unwrap(), 1);
        assert_eq!(append_task_action(&base, a("t2", "reabrir")).unwrap(), 2);
        let txt = std::fs::read_to_string(base.join(".loro/agenda/tarefas-acoes.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&txt).unwrap();
        assert_eq!(v["acoes"][0]["id"], "t1");
        assert_eq!(v["acoes"][0]["acao"], "concluir");
        assert_eq!(v["acoes"][1]["acao"], "reabrir");
        assert_eq!(v["acoes"][1]["em"], "2026-11-18T10:00:00-03:00");
        // a corrupted file (the agent mid-write) starts over instead of failing
        std::fs::write(base.join(".loro/agenda/tarefas-acoes.json"), "{oops").unwrap();
        assert_eq!(append_task_action(&base, a("t3", "concluir")).unwrap(), 1);
        // only the two verbs, a real id, and a plain timestamp
        for bad in [
            a("", "concluir"),
            a("t", "apagar"),
            TaskAction {
                id: "t".into(),
                acao: "concluir".into(),
                em: "x; rm".into(),
            },
        ] {
            assert_eq!(
                append_task_action(&base, bad).unwrap_err(),
                "err.agenda_bad_task_action"
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn adr0041_a_schedule_with_a_tema_that_is_a_path_is_refused() {
        for tema in ["", "  ", "../x", "a/b", "..", "a\\b"] {
            let mut eventos = BTreeMap::new();
            eventos.insert(
                "e1".to_string(),
                Scheduled {
                    tema: tema.into(),
                    data: String::new(),
                },
            );
            assert_eq!(
                normalize_schedule(Schedule { versao: 1, eventos }).unwrap_err(),
                "err.agenda_bad_schedule",
                "{tema:?}"
            );
        }
    }
}
