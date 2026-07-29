// Loro — acervo usage templates (presets, ADR-0003). A preset seeds a new
// acervo: seed contexts, an AGENTS.md vertical addendum, the initial queue
// guide (inbox/_prompt.md) and optional extra skills. Builtins are embedded
// via include_str! (self-contained binary); custom templates are plain files
// under ~/.loro/templates/<slug>/ in the exact same layout, so "duplicate to
// customize" is just writing the same bytes to disk. A custom template with a
// builtin's id shadows it. Template content is user data: it is never executed
// by the app — the user's own AI agent interprets it (same posture as
// inbox/_prompt.md).

use crate::paths::loro_data_dir;
use std::path::PathBuf;

// What the wizard shows for one template (localized for the requested lang).
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub contexts: Vec<String>,
    pub builtin: bool,
    pub dir: Option<String>, // custom templates only
}

// What gets applied when an acervo is created from a template. Seed contexts
// travel in TemplateInfo only: the wizard prefills the field and the user's
// edited list is the truth — the backend never merges (ADR-0003 §1).
#[derive(Default, Clone, Debug)]
pub struct TemplateContent {
    // Appended to the generated AGENTS.md — never a replacement: the default
    // AGENTS.md carries the loop mechanics the whole model depends on.
    pub agents_extra: Option<String>,
    pub inbox_prompt: Option<String>, // seeded to inbox/_prompt.md on first setup
    pub skills: Vec<(String, String)>, // (filename, body) -> .claude/commands/
}

struct Builtin {
    id: &'static str,
    manifest: &'static str,
    agents_pt: &'static str,
    agents_en: &'static str,
    prompt_pt: &'static str,
    prompt_en: &'static str,
}

// "generico" is handled in code (empty content, honors the "no built-in
// taxonomy" baseline §4 default) — it has no directory on purpose.
pub const GENERIC_TEMPLATE: &str = "generico";

const BUILTINS: &[Builtin] = &[
    Builtin {
        id: "vendas",
        manifest: include_str!("../templates/vendas/template.json"),
        agents_pt: include_str!("../templates/vendas/pt/AGENTS.md"),
        agents_en: include_str!("../templates/vendas/en/AGENTS.md"),
        prompt_pt: include_str!("../templates/vendas/pt/_prompt.md"),
        prompt_en: include_str!("../templates/vendas/en/_prompt.md"),
    },
    Builtin {
        id: "engenharia",
        manifest: include_str!("../templates/engenharia/template.json"),
        agents_pt: include_str!("../templates/engenharia/pt/AGENTS.md"),
        agents_en: include_str!("../templates/engenharia/en/AGENTS.md"),
        prompt_pt: include_str!("../templates/engenharia/pt/_prompt.md"),
        prompt_en: include_str!("../templates/engenharia/en/_prompt.md"),
    },
    Builtin {
        id: "produto",
        manifest: include_str!("../templates/produto/template.json"),
        agents_pt: include_str!("../templates/produto/pt/AGENTS.md"),
        agents_en: include_str!("../templates/produto/en/AGENTS.md"),
        prompt_pt: include_str!("../templates/produto/pt/_prompt.md"),
        prompt_en: include_str!("../templates/produto/en/_prompt.md"),
    },
    Builtin {
        id: "aprendizado",
        manifest: include_str!("../templates/aprendizado/template.json"),
        agents_pt: include_str!("../templates/aprendizado/pt/AGENTS.md"),
        agents_en: include_str!("../templates/aprendizado/en/AGENTS.md"),
        prompt_pt: include_str!("../templates/aprendizado/pt/_prompt.md"),
        prompt_en: include_str!("../templates/aprendizado/en/_prompt.md"),
    },
    Builtin {
        id: "educacao",
        manifest: include_str!("../templates/educacao/template.json"),
        agents_pt: include_str!("../templates/educacao/pt/AGENTS.md"),
        agents_en: include_str!("../templates/educacao/en/AGENTS.md"),
        prompt_pt: include_str!("../templates/educacao/pt/_prompt.md"),
        prompt_en: include_str!("../templates/educacao/en/_prompt.md"),
    },
    Builtin {
        id: "recrutamento",
        manifest: include_str!("../templates/recrutamento/template.json"),
        agents_pt: include_str!("../templates/recrutamento/pt/AGENTS.md"),
        agents_en: include_str!("../templates/recrutamento/en/AGENTS.md"),
        prompt_pt: include_str!("../templates/recrutamento/pt/_prompt.md"),
        prompt_en: include_str!("../templates/recrutamento/en/_prompt.md"),
    },
    Builtin {
        id: "saude",
        manifest: include_str!("../templates/saude/template.json"),
        agents_pt: include_str!("../templates/saude/pt/AGENTS.md"),
        agents_en: include_str!("../templates/saude/en/AGENTS.md"),
        prompt_pt: include_str!("../templates/saude/pt/_prompt.md"),
        prompt_en: include_str!("../templates/saude/en/_prompt.md"),
    },
];

pub fn custom_templates_dir() -> PathBuf {
    loro_data_dir().join("templates")
}

// Slug gate for template ids: rejects path traversal before any disk access.
pub fn valid_template_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

// Manifest fields are either a plain value or a {pt, en} map; unknown/missing
// lang falls back to the other one (a half-translated custom template still works).
fn pick_lang_str(v: &serde_json::Value, lang: &str) -> Option<String> {
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    let other = if lang == "en" { "pt" } else { "en" };
    v.get(lang)
        .or_else(|| v.get(other))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

fn pick_lang_list(v: &serde_json::Value, lang: &str) -> Vec<String> {
    let as_list = |x: &serde_json::Value| -> Option<Vec<String>> {
        x.as_array().map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().map(|s| s.to_string()))
                .collect()
        })
    };
    if let Some(l) = as_list(v) {
        return l;
    }
    let other = if lang == "en" { "pt" } else { "en" };
    v.get(lang)
        .or_else(|| v.get(other))
        .and_then(as_list)
        .unwrap_or_default()
}

fn info_from_manifest(
    id: &str,
    manifest: &str,
    lang: &str,
    builtin: bool,
    dir: Option<String>,
) -> Option<TemplateInfo> {
    let m: serde_json::Value = serde_json::from_str(manifest).ok()?;
    Some(TemplateInfo {
        id: id.to_string(),
        name: m
            .get("name")
            .and_then(|v| pick_lang_str(v, lang))
            .unwrap_or_else(|| id.to_string()),
        description: m
            .get("description")
            .and_then(|v| pick_lang_str(v, lang))
            .unwrap_or_default(),
        contexts: m
            .get("contexts")
            .map(|v| pick_lang_list(v, lang))
            .unwrap_or_default(),
        builtin,
        dir,
    })
}

fn generic_info(lang: &str) -> TemplateInfo {
    let (name, description) = if lang == "en" {
        (
            "Generic",
            "A blank base — you name the contexts; no preset rules.",
        )
    } else {
        (
            "Genérico",
            "Acervo em branco — você nomeia os contextos; sem regras pré-definidas.",
        )
    };
    TemplateInfo {
        id: GENERIC_TEMPLATE.into(),
        name: name.into(),
        description: description.into(),
        contexts: vec![],
        builtin: true,
        dir: None,
    }
}

fn non_empty(s: String) -> Option<String> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(s)
    }
}

// Read one localized file from a custom template dir, falling back to the
// other language when the requested variant is missing.
fn read_custom_file(dir: &std::path::Path, lang: &str, rel: &str) -> Option<String> {
    let other = if lang == "en" { "pt" } else { "en" };
    for l in [lang, other] {
        if let Ok(s) = std::fs::read_to_string(dir.join(l).join(rel)) {
            if let Some(s) = non_empty(s) {
                return Some(s);
            }
        }
    }
    None
}

fn read_custom_skills(dir: &std::path::Path, lang: &str) -> Vec<(String, String)> {
    let other = if lang == "en" { "pt" } else { "en" };
    for l in [lang, other] {
        let skills_dir = dir.join(l).join("skills");
        let Ok(entries) = std::fs::read_dir(&skills_dir) else {
            continue;
        };
        let mut out: Vec<(String, String)> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|x| x == "md"))
            .filter_map(|e| {
                let name = e.file_name().to_str()?.to_string();
                let body = std::fs::read_to_string(e.path()).ok()?;
                Some((name, body))
            })
            .collect();
        if !out.is_empty() {
            out.sort_by(|a, b| a.0.cmp(&b.0));
            return out;
        }
    }
    Vec::new()
}

// List every template the wizard can offer: generico first, then the other
// builtins, then customs (~/.loro/templates). A custom sharing a builtin id
// replaces that builtin's entry in place.
pub fn list_templates(lang: &str) -> Vec<TemplateInfo> {
    let mut out = vec![generic_info(lang)];
    out.extend(
        BUILTINS
            .iter()
            .filter_map(|b| info_from_manifest(b.id, b.manifest, lang, true, None)),
    );
    let dir = custom_templates_dir();
    let mut customs: Vec<TemplateInfo> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let id = e.file_name().to_str()?.to_string();
            if !valid_template_slug(&id) {
                return None;
            }
            let manifest = std::fs::read_to_string(e.path().join("template.json")).ok()?;
            info_from_manifest(
                &id,
                &manifest,
                lang,
                false,
                Some(e.path().display().to_string()),
            )
        })
        .collect();
    customs.sort_by(|a, b| a.id.cmp(&b.id));
    for c in customs {
        if let Some(slot) = out.iter_mut().find(|t| t.id == c.id) {
            *slot = c; // custom shadows the builtin of the same id
        } else {
            out.push(c);
        }
    }
    out
}

// Resolve a template id into the content applied at acervo creation.
// Custom dir wins over the builtin of the same id (shadowing).
pub fn resolve_template(id: &str, lang: &str) -> Result<TemplateContent, String> {
    if !valid_template_slug(id) {
        return Err("err.invalid_template".into());
    }
    if id == GENERIC_TEMPLATE {
        return Ok(TemplateContent::default());
    }
    let dir = custom_templates_dir().join(id);
    if dir.join("template.json").is_file() {
        return Ok(TemplateContent {
            agents_extra: read_custom_file(&dir, lang, "AGENTS.md"),
            inbox_prompt: read_custom_file(&dir, lang, "_prompt.md"),
            skills: read_custom_skills(&dir, lang),
        });
    }
    let b = BUILTINS
        .iter()
        .find(|b| b.id == id)
        .ok_or("err.template_not_found")?;
    let (agents, prompt) = if lang == "en" {
        (b.agents_en, b.prompt_en)
    } else {
        (b.agents_pt, b.prompt_pt)
    };
    Ok(TemplateContent {
        agents_extra: non_empty(agents.to_string()),
        inbox_prompt: non_empty(prompt.to_string()),
        skills: Vec::new(), // builtins ship no extra skills in v1 (ADR-0003)
    })
}

// Copy a template (builtin or custom) into ~/.loro/templates as an editable
// custom template. Slug collisions get a -2/-3 suffix.
pub fn duplicate_template(id: &str) -> Result<PathBuf, String> {
    if !valid_template_slug(id) {
        return Err("err.invalid_template".into());
    }
    let root = custom_templates_dir();
    let mut slug = format!("{id}-2");
    let mut n = 2;
    while root.join(&slug).exists() {
        n += 1;
        slug = format!("{id}-{n}");
    }
    let dest = root.join(&slug);
    let src = custom_templates_dir().join(id);
    if src.join("template.json").is_file() {
        copy_template_dir(&src, &dest)?;
        return Ok(dest);
    }
    let b = BUILTINS
        .iter()
        .find(|b| b.id == id)
        .ok_or("err.template_not_found")?;
    for (rel, body) in [
        ("template.json", b.manifest),
        ("pt/AGENTS.md", b.agents_pt),
        ("pt/_prompt.md", b.prompt_pt),
        ("en/AGENTS.md", b.agents_en),
        ("en/_prompt.md", b.prompt_en),
    ] {
        let p = dest.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&p, body).map_err(|e| e.to_string())?;
    }
    Ok(dest)
}

fn copy_template_dir(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = dest.join(entry.file_name());
        if entry.path().is_dir() {
            copy_template_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // LORO_HOME is process-global; serialize the tests that touch it.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_temp_home<T>(f: impl FnOnce() -> T) -> T {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("loro-presets-{:x}", rand_suffix()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("LORO_HOME", &dir);
        let out = f();
        std::env::remove_var("LORO_HOME");
        let _ = std::fs::remove_dir_all(&dir);
        out
    }

    fn rand_suffix() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }

    #[test]
    fn slug_gate_rejects_traversal_and_empty() {
        assert!(valid_template_slug("vendas"));
        assert!(valid_template_slug("meu-template-2"));
        assert!(!valid_template_slug(""));
        assert!(!valid_template_slug("../etc"));
        assert!(!valid_template_slug("a/b"));
        assert!(!valid_template_slug("A"));
        assert!(!valid_template_slug(&"x".repeat(65)));
    }

    #[test]
    fn list_templates_has_generico_first_and_all_builtins() {
        with_temp_home(|| {
            let list = list_templates("pt");
            assert_eq!(list[0].id, "generico");
            assert!(list[0].contexts.is_empty());
            for id in [
                "vendas",
                "engenharia",
                "produto",
                "aprendizado",
                "educacao",
                "recrutamento",
                "saude",
            ] {
                assert!(list.iter().any(|t| t.id == id && t.builtin), "{id}");
            }
        });
    }

    #[test]
    fn list_templates_localizes_by_lang() {
        with_temp_home(|| {
            let pt = list_templates("pt");
            let en = list_templates("en");
            let v_pt = pt.iter().find(|t| t.id == "vendas").unwrap();
            let v_en = en.iter().find(|t| t.id == "vendas").unwrap();
            assert_eq!(v_pt.name, "Vendas");
            assert_eq!(v_en.name, "Sales");
            assert!(v_pt.contexts.contains(&"contas".to_string()));
            assert!(v_en.contexts.contains(&"accounts".to_string()));
        });
    }

    #[test]
    fn resolve_generico_is_empty_content() {
        let c = resolve_template("generico", "pt").unwrap();
        assert!(c.agents_extra.is_none());
        assert!(c.inbox_prompt.is_none());
        assert!(c.skills.is_empty());
    }

    #[test]
    fn resolve_builtin_carries_agents_and_prompt_per_lang() {
        with_temp_home(|| {
            let pt = resolve_template("vendas", "pt").unwrap();
            assert!(pt.agents_extra.unwrap().contains("vertical: vendas"));
            assert!(pt.inbox_prompt.unwrap().contains("Guia da fila"));
            let en = resolve_template("vendas", "en").unwrap();
            assert!(en.agents_extra.unwrap().contains("Vertical rules: sales"));
        });
    }

    #[test]
    fn resolve_rejects_unknown_and_invalid_ids() {
        with_temp_home(|| {
            assert_eq!(
                resolve_template("nao-existe", "pt").unwrap_err(),
                "err.template_not_found"
            );
            assert_eq!(
                resolve_template("../x", "pt").unwrap_err(),
                "err.invalid_template"
            );
        });
    }

    #[test]
    fn custom_template_is_listed_and_shadows_builtin() {
        with_temp_home(|| {
            let dir = custom_templates_dir().join("vendas");
            std::fs::create_dir_all(dir.join("pt")).unwrap();
            std::fs::write(
                dir.join("template.json"),
                r#"{"version":1,"name":"Vendas da casa","contexts":["clientes"]}"#,
            )
            .unwrap();
            std::fs::write(dir.join("pt/AGENTS.md"), "## Regras da casa\n").unwrap();
            let list = list_templates("pt");
            let v = list.iter().find(|t| t.id == "vendas").unwrap();
            assert_eq!(v.name, "Vendas da casa");
            assert_eq!(v.contexts, vec!["clientes".to_string()]);
            assert!(!v.builtin);
            let c = resolve_template("vendas", "pt").unwrap();
            assert!(c.agents_extra.unwrap().contains("Regras da casa"));
        });
    }

    #[test]
    fn custom_skills_are_resolved_with_lang_fallback() {
        with_temp_home(|| {
            let dir = custom_templates_dir().join("meu");
            std::fs::create_dir_all(dir.join("pt/skills")).unwrap();
            std::fs::write(dir.join("template.json"), r#"{"version":1,"name":"Meu"}"#).unwrap();
            std::fs::write(dir.join("pt/skills/brain-mensagem.md"), "corpo").unwrap();
            let c = resolve_template("meu", "en").unwrap(); // en missing -> pt fallback
            assert_eq!(c.skills, vec![("brain-mensagem.md".into(), "corpo".into())]);
        });
    }

    #[test]
    fn duplicate_builtin_writes_editable_copy_and_dedupes_slug() {
        with_temp_home(|| {
            let first = duplicate_template("vendas").unwrap();
            assert!(first.ends_with("vendas-2"));
            assert!(first.join("template.json").is_file());
            assert!(first.join("pt/AGENTS.md").is_file());
            let second = duplicate_template("vendas").unwrap();
            assert!(second.ends_with("vendas-3"));
            let list = list_templates("pt");
            assert!(list.iter().any(|t| t.id == "vendas-2" && !t.builtin));
        });
    }
}
