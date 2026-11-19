// ADR-0041 §11 — the slash commands the bubble's chat offers: the same skills
// and commands the `claude` CLI loads for the acervo, discovered on disk. Only the
// frontmatter `name` / `description` is read — never the body — and the list is
// cached for 60 s (refreshed when the popover opens after that).
//
// Where they live (Claude Code's own layout):
//   project  <acervo>/.claude/skills/<s>/SKILL.md, <acervo>/.claude/commands/<c>.md
//   user     ~/.claude/skills/<s>/SKILL.md,         ~/.claude/commands/<c>.md
//   plugins  ~/.claude/plugins/**/skills/<s>/SKILL.md  → shown as `plugin:skill`
// A name defined in more than one place keeps the first by precedence:
// project > user > plugin. No CLI built-ins are listed: the ones that exist are
// interactive and do nothing in `-p` mode.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SlashItem {
    pub name: String,
    pub description: String,
    /// "project" | "user" | "plugin"
    pub source: String,
}

const DESC_MAX: usize = 160;
const CACHE_TTL: Duration = Duration::from_secs(60);
const FRONTMATTER_MAX: usize = 16 * 1024;
const PLUGIN_DEPTH: usize = 8;

/// `name` and `description` from a markdown file's YAML frontmatter. Handles
/// plain, quoted ('…' / "…" with \" escapes) and block (`>`, `|`, `>-`, `|-`)
/// values, and a value continued on indented lines. Missing → None.
pub fn frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let body: Vec<&str> = lines.take_while(|l| l.trim() != "---").collect();
    let get = |key: &str| -> Option<String> {
        let mut i = 0;
        while i < body.len() {
            let l = body[i];
            if !l.starts_with(char::is_whitespace) {
                if let Some(rest) = l.strip_prefix(key).and_then(|r| r.strip_prefix(':')) {
                    let v = rest.trim();
                    // the continuation: the indented lines right after
                    let mut more: Vec<&str> = Vec::new();
                    let mut j = i + 1;
                    while j < body.len()
                        && (body[j].starts_with(char::is_whitespace) || body[j].trim().is_empty())
                    {
                        if !body[j].trim().is_empty() {
                            more.push(body[j].trim());
                        }
                        j += 1;
                    }
                    let joined = if matches!(v, ">" | "|" | ">-" | "|-" | ">+" | "|+" | "") {
                        more.join(" ")
                    } else if (v.starts_with('"') && v.ends_with('"') && v.len() >= 2)
                        || (v.starts_with('\'') && v.ends_with('\'') && v.len() >= 2)
                    {
                        let inner = &v[1..v.len() - 1];
                        if v.starts_with('"') {
                            inner.replace("\\\"", "\"").replace("\\\\", "\\")
                        } else {
                            inner.replace("''", "'")
                        }
                    } else if more.is_empty() {
                        v.to_string()
                    } else {
                        format!("{v} {}", more.join(" "))
                    };
                    let joined = joined.trim().to_string();
                    return (!joined.is_empty()).then_some(joined);
                }
            }
            i += 1;
        }
        None
    };
    (get("name"), get("description"))
}

fn one_line(s: &str) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= DESC_MAX {
        return flat;
    }
    let cut: String = flat.chars().take(DESC_MAX - 1).collect();
    format!("{cut}…")
}

fn read_head(p: &Path) -> Option<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(p).ok()?;
    let mut buf = vec![0u8; FRONTMATTER_MAX];
    let n = f.read(&mut buf).ok()?;
    buf.truncate(n);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// A slash name is a plain token: what reaches the composer is typed into a
/// prompt, so nothing with spaces or control characters gets in.
fn plain_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && s.chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
}

fn item_from(p: &Path, fallback: &str, prefix: Option<&str>, source: &str) -> Option<SlashItem> {
    let text = read_head(p)?;
    let (name, desc) = frontmatter(&text);
    let base = name.unwrap_or_else(|| fallback.to_string());
    let name = match prefix {
        Some(pl) => format!("{pl}:{base}"),
        None => base,
    };
    plain_name(&name).then(|| SlashItem {
        name,
        description: one_line(&desc.unwrap_or_default()),
        source: source.into(),
    })
}

fn scan_skills(dir: &Path, prefix: Option<&str>, source: &str, out: &mut Vec<SlashItem>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    entries.sort();
    for d in entries {
        let f = d.join("SKILL.md");
        if f.is_file() {
            let stem = d
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if let Some(it) = item_from(&f, &stem, prefix, source) {
                out.push(it);
            }
        }
    }
}

fn scan_commands(dir: &Path, source: &str, out: &mut Vec<SlashItem>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    entries.sort();
    for f in entries {
        if f.extension().and_then(|e| e.to_str()) == Some("md") && f.is_file() {
            let stem = f
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            // a command's name is its FILE name (the frontmatter has no `name`)
            if let Some(mut it) = item_from(&f, &stem, None, source) {
                it.name = stem.clone();
                if plain_name(&it.name) {
                    out.push(it);
                }
            }
        }
    }
}

/// The plugin a `skills/` folder belongs to: the `name` in the nearest
/// `.claude-plugin/plugin.json` above it, else the folder that holds `skills/`.
fn plugin_name(skills_dir: &Path) -> String {
    let mut cur = skills_dir.parent();
    for _ in 0..3 {
        let Some(d) = cur else { break };
        let pj = d.join(".claude-plugin").join("plugin.json");
        if let Ok(t) = std::fs::read_to_string(&pj) {
            if let Some(n) = serde_json::from_str::<serde_json::Value>(&t)
                .ok()
                .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_string))
            {
                return n;
            }
        }
        cur = d.parent();
    }
    skills_dir
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("plugin")
        .to_string()
}

fn find_skill_dirs(root: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(root) else {
        return;
    };
    let mut dirs: Vec<PathBuf> = rd
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .collect();
    dirs.sort();
    for d in dirs {
        if d.file_name().and_then(|s| s.to_str()) == Some("skills") {
            out.push(d);
        } else if d
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|n| !n.starts_with('.') || n == ".claude-plugin")
        {
            find_skill_dirs(&d, depth - 1, out);
        }
    }
}

/// Merge with precedence: the first list wins a name (project > user > plugin),
/// then everything sorted by name for a stable popover.
pub fn merge(groups: Vec<Vec<SlashItem>>) -> Vec<SlashItem> {
    let mut out: Vec<SlashItem> = Vec::new();
    for g in groups {
        for it in g {
            if !out.iter().any(|o| o.name == it.name) {
                out.push(it);
            }
        }
    }
    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

pub fn discover(project: Option<&Path>, home_claude: &Path) -> Vec<SlashItem> {
    let mut proj = Vec::new();
    if let Some(p) = project {
        scan_skills(&p.join(".claude/skills"), None, "project", &mut proj);
        scan_commands(&p.join(".claude/commands"), "project", &mut proj);
    }
    let mut user = Vec::new();
    scan_skills(&home_claude.join("skills"), None, "user", &mut user);
    scan_commands(&home_claude.join("commands"), "user", &mut user);
    let mut plug = Vec::new();
    let mut dirs = Vec::new();
    find_skill_dirs(&home_claude.join("plugins"), PLUGIN_DEPTH, &mut dirs);
    for d in dirs {
        let name = plugin_name(&d);
        scan_skills(&d, Some(&name), "plugin", &mut plug);
    }
    merge(vec![proj, user, plug])
}

static CACHE: Mutex<Option<(Instant, String, Vec<SlashItem>)>> = Mutex::new(None);

/// The list for the active acervo, cached 60 s (per acervo).
#[tauri::command]
pub async fn skills_list() -> Vec<SlashItem> {
    let project = crate::config::read_brain_config().map(|c| c.brain_dir);
    let key = project.clone().unwrap_or_default();
    if let Ok(g) = CACHE.lock() {
        if let Some((at, k, list)) = g.as_ref() {
            if *k == key && at.elapsed() < CACHE_TTL {
                return list.clone();
            }
        }
    }
    let home = crate::paths::user_home().join(".claude");
    let list = tauri::async_runtime::spawn_blocking(move || {
        discover(project.as_deref().map(Path::new), &home)
    })
    .await
    .unwrap_or_default();
    if let Ok(mut g) = CACHE.lock() {
        *g = Some((Instant::now(), key, list.clone()));
    }
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adr0041_frontmatter_plain_quoted_block_and_missing() {
        let plain = "---\nname: consulta\ndescription: Responde o que era esperado.\n---\nbody";
        assert_eq!(
            frontmatter(plain),
            (
                Some("consulta".into()),
                Some("Responde o que era esperado.".into())
            )
        );
        let quoted = "---\nname: \"x\"\ndescription: \"Diz \\\"oi\\\" e sai\"\n---\n";
        assert_eq!(frontmatter(quoted).1.as_deref(), Some("Diz \"oi\" e sai"));
        let single = "---\ndescription: 'It''s fine'\n---\n";
        assert_eq!(frontmatter(single).1.as_deref(), Some("It's fine"));
        let block = "---\nname: review\ndescription: >\n  Confronta um contrato\n  com o Figma.\nallowed-tools: Read\n---\n";
        assert_eq!(
            frontmatter(block),
            (
                Some("review".into()),
                Some("Confronta um contrato com o Figma.".into())
            )
        );
        let wrapped = "---\ndescription: Linha um\n  continua aqui\n---\n";
        assert_eq!(
            frontmatter(wrapped).1.as_deref(),
            Some("Linha um continua aqui")
        );
        assert_eq!(frontmatter("# no frontmatter\n"), (None, None));
        assert_eq!(
            frontmatter("---\nname: só\n---\n"),
            (Some("só".into()), None)
        );
        // a key that only STARTS with another key's name is not it
        assert_eq!(frontmatter("---\nnamespace: x\n---\n").0, None);
    }

    #[test]
    fn adr0041_a_long_description_becomes_one_short_line() {
        let long = format!("a\n b {}", "x".repeat(400));
        let l = one_line(&long);
        assert!(!l.contains('\n'));
        assert_eq!(l.chars().count(), DESC_MAX);
        assert!(l.ends_with('…'));
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "loro-skills-{tag}-{}-{}",
            std::process::id(),
            crate::epoch_millis()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn write(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn adr0041_discovery_precedence_project_user_plugin_and_plugin_prefix() {
        let root = tmp("disc");
        let proj = root.join("acervo");
        let home = root.join("home/.claude");
        write(
            &proj.join(".claude/skills/consulta/SKILL.md"),
            "---\nname: consulta\ndescription: do projeto\n---\n",
        );
        write(
            &home.join("skills/consulta/SKILL.md"),
            "---\nname: consulta\ndescription: do usuário\n---\n",
        );
        write(
            &home.join("skills/so-user/SKILL.md"),
            "---\ndescription: sem name\n---\n",
        );
        write(
            &home.join("commands/loro-context.md"),
            "---\ndescription: comando\n---\n",
        );
        write(
            &proj.join(".claude/commands/loro-analyse.md"),
            "sem frontmatter\n",
        );
        // a plugin in the cache layout: name from its plugin.json
        let pl = home.join("plugins/cache/mk/turbi-design/1.2.0");
        write(
            &pl.join(".claude-plugin/plugin.json"),
            r#"{"name":"turbi-design"}"#,
        );
        write(
            &pl.join("skills/torque/SKILL.md"),
            "---\nname: torque\ndescription: Torque 2\n---\n",
        );
        // the same plugin skill reached twice (marketplace copy) is listed once
        let mk = home.join("plugins/marketplaces/mk/plugins/turbi-design");
        write(
            &mk.join(".claude-plugin/plugin.json"),
            r#"{"name":"turbi-design"}"#,
        );
        write(
            &mk.join("skills/torque/SKILL.md"),
            "---\nname: torque\ndescription: Torque 2\n---\n",
        );
        // a name that is not a plain token is dropped
        write(
            &home.join("skills/bad/SKILL.md"),
            "---\nname: rm -rf\n---\n",
        );

        let list = discover(Some(&proj), &home);
        let names: Vec<&str> = list.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "consulta",
                "loro-analyse",
                "loro-context",
                "so-user",
                "turbi-design:torque"
            ]
        );
        let c = list.iter().find(|i| i.name == "consulta").unwrap();
        assert_eq!(
            (c.source.as_str(), c.description.as_str()),
            ("project", "do projeto")
        );
        assert_eq!(
            list.iter()
                .find(|i| i.name == "so-user")
                .unwrap()
                .description,
            "sem name"
        );
        assert_eq!(
            list.iter()
                .find(|i| i.name == "turbi-design:torque")
                .unwrap()
                .source,
            "plugin"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn adr0041_merge_keeps_the_first_by_precedence_and_sorts() {
        let it = |n: &str, s: &str| SlashItem {
            name: n.into(),
            description: String::new(),
            source: s.into(),
        };
        let m = merge(vec![
            vec![it("b", "project")],
            vec![it("b", "user"), it("A", "user")],
            vec![it("c", "plugin")],
        ]);
        assert_eq!(
            m.iter()
                .map(|i| (i.name.as_str(), i.source.as_str()))
                .collect::<Vec<_>>(),
            vec![("A", "user"), ("b", "project"), ("c", "plugin")]
        );
    }
}
