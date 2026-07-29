// Loro — global config: multiple acervos (projects), active selection,
// legacy migration. Extracted from lib.rs (AGENTS.md clean-core premise).

use serde::Deserialize;
use std::path::{Path, PathBuf};

// A single acervo (project brain). Loro manages many; one is active at a time.
#[derive(serde::Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Acervo {
    pub id: String,
    pub name: String,
    pub dir: String,
    #[serde(default)]
    pub auto_context: bool, // loop may create/organize contexts on its own
    #[serde(default)]
    pub color: String, // accent color for this project (hex; empty = default)
    #[serde(default)]
    pub lang: String, // project language ("pt" | "en"); drives the templates
}

// Global config (~/.loro/config.json). New format: list of acervos + active id.
#[derive(serde::Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoroConfig {
    #[serde(default)]
    pub acervos: Vec<Acervo>,
    #[serde(default)]
    pub active: String,
    // UI language ("pt" | "en") — user-level preference for the app chrome.
    // Distinct from Acervo.lang, which drives the templates of one project.
    #[serde(default = "default_ui_lang")]
    pub ui_lang: String,
}

impl Default for LoroConfig {
    fn default() -> Self {
        Self {
            acervos: Vec::new(),
            active: String::new(),
            ui_lang: default_ui_lang(),
        }
    }
}

fn default_ui_lang() -> String {
    "pt".into()
}

// Loro speaks two languages; anything unknown falls back to pt (the original).
pub fn normalize_lang(s: &str) -> String {
    if s == "en" {
        "en".into()
    } else {
        "pt".into()
    }
}

// UI language from the global config ("pt" default).
pub fn ui_lang() -> String {
    normalize_lang(&read_loro_config().ui_lang)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ui language: user-level preference, distinct from per-acervo `lang`
    #[test]
    fn ui_lang_defaults_to_pt_when_absent_from_config() {
        let cfg: LoroConfig = serde_json::from_str(r#"{"acervos":[],"active":""}"#).unwrap();
        assert_eq!(cfg.ui_lang, "pt");
        assert_eq!(LoroConfig::default().ui_lang, "pt");
    }

    #[test]
    fn ui_lang_roundtrips_as_camel_case_json() {
        let cfg = LoroConfig {
            ui_lang: "en".into(),
            ..LoroConfig::default()
        };
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains(r#""uiLang":"en""#));
        let back: LoroConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.ui_lang, "en");
    }

    #[test]
    fn normalize_lang_accepts_only_pt_and_en() {
        assert_eq!(normalize_lang("en"), "en");
        assert_eq!(normalize_lang("pt"), "pt");
        assert_eq!(normalize_lang("fr"), "pt");
        assert_eq!(normalize_lang(""), "pt");
    }
}

// The active acervo projected onto the legacy shape, so every existing brain_*
// command keeps working unchanged (they operate on brain_dir).
#[derive(serde::Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct BrainConfig {
    pub brain_dir: String,
    pub contexts: Vec<String>,
    #[serde(default)]
    pub auto_context: bool,
}

pub fn loro_config_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".loro/config.json")
}

pub fn slugify_id(s: &str) -> String {
    let id: String = s
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    let id = id.trim_matches('-').to_string();
    if id.is_empty() {
        "acervo".into()
    } else {
        id
    }
}

// Read config, migrating the legacy {brainDir, contexts} shape into the new
// multi-acervo shape on the fly (and persisting the migration).
pub fn read_loro_config() -> LoroConfig {
    let Ok(txt) = std::fs::read_to_string(loro_config_path()) else {
        return LoroConfig::default();
    };
    if let Ok(cfg) = serde_json::from_str::<LoroConfig>(&txt) {
        if !cfg.acervos.is_empty() {
            return cfg;
        }
    }
    // legacy format?
    if let Ok(old) = serde_json::from_str::<serde_json::Value>(&txt) {
        if let Some(dir) = old.get("brainDir").and_then(|v| v.as_str()) {
            let name = Path::new(dir)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("Acervo")
                .to_string();
            let id = slugify_id(&name);
            let cfg = LoroConfig {
                acervos: vec![Acervo {
                    id: id.clone(),
                    name,
                    dir: dir.to_string(),
                    auto_context: false,
                    color: String::new(),
                    lang: "pt".into(),
                }],
                active: id,
                ui_lang: default_ui_lang(),
            };
            let _ = write_loro_config(&cfg);
            return cfg;
        }
    }
    LoroConfig::default()
}

pub fn write_loro_config(cfg: &LoroConfig) -> Result<(), String> {
    let p = loro_config_path();
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(
        &p,
        serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

pub fn active_acervo(cfg: &LoroConfig) -> Option<&Acervo> {
    cfg.acervos
        .iter()
        .find(|a| a.id == cfg.active)
        .or_else(|| cfg.acervos.first())
}

// The active acervo in legacy shape (or None if nothing configured).
pub fn read_brain_config() -> Option<BrainConfig> {
    let cfg = read_loro_config();
    active_acervo(&cfg).map(|a| BrainConfig {
        brain_dir: a.dir.clone(),
        contexts: vec![],
        auto_context: a.auto_context,
    })
}
