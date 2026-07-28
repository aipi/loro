// Optional versioning of the acervo. Git stays a system dependency (resolved
// from PATH); nothing is vendored. This module owns the git/GitHub concern so
// lib.rs keeps only Tauri wiring — see the "git" split target in CLAUDE.md.
//
// Invocation policy (security): always `Command::new("git"|"gh").args([...])`
// with fixed tokens — never `sh -c`, never interpolate user input into a shell
// string. Values coming from the user are passed as isolated positional args.
// Logs never carry tokens/PII (BR: structured logs, no secrets).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use crate::config::read_brain_config;
use crate::paths::which;

// ---- gh (GitHub CLI) — read layer -----------------------------------------
// Opt-in remote collaboration. gh stays a system dependency (from PATH); the
// app stores NO credentials — it only reads whether the environment is ready
// and surfaces public PR/review metadata. Tokens are never captured or logged.

pub fn gh_available() -> bool {
    which("gh").is_some()
}

// Run gh in the acervo, with prompts and update-notifier disabled so output is
// deterministic and never blocks. Fixed args only (no shell, no interpolation).
fn gh(base: &Path, args: &[&str]) -> Result<Output, String> {
    Command::new("gh")
        .args(args)
        .current_dir(base)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .output()
        .map_err(|e| e.to_string())
}

fn tool_version(bin: &str) -> Option<(u32, u32, u32)> {
    let out = Command::new(bin).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_semver(&String::from_utf8_lossy(&out.stdout))
}

// First `\d+.\d+[.\d+]` token in a version string. Handles "git version 2.50.1"
// and "gh version 2.83.2 (2025-12-10)".
pub fn parse_semver(s: &str) -> Option<(u32, u32, u32)> {
    for tok in s.split(|c: char| !(c.is_ascii_digit() || c == '.')) {
        let parts: Vec<&str> = tok.split('.').collect();
        if parts.len() >= 2 && !parts[0].is_empty() && parts[0].chars().all(|c| c.is_ascii_digit())
        {
            let a = parts[0].parse().ok()?;
            let b = parts.get(1).and_then(|x| x.parse().ok()).unwrap_or(0);
            let c = parts.get(2).and_then(|x| x.parse().ok()).unwrap_or(0);
            return Some((a, b, c));
        }
    }
    None
}

// version >= floor, comparing major then minor (patch ignored).
pub fn version_meets(v: (u32, u32, u32), floor: (u32, u32)) -> bool {
    v.0 > floor.0 || (v.0 == floor.0 && v.1 >= floor.1)
}

pub fn git_version() -> Option<(u32, u32, u32)> {
    tool_version("git")
}
pub fn gh_version() -> Option<(u32, u32, u32)> {
    tool_version("gh")
}

pub fn version_str(v: Option<(u32, u32, u32)>) -> String {
    v.map(|(a, b, c)| format!("{a}.{b}.{c}"))
        .unwrap_or_default()
}

// gh is authenticated when `gh auth status` exits 0. We never read the token.
pub fn gh_authed() -> bool {
    Command::new("gh")
        .args(["auth", "status"])
        .env("GH_PROMPT_DISABLED", "1")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// The public GitHub login (not a secret) — used to target notifications at "me".
pub fn gh_account() -> Option<String> {
    let out = Command::new("gh")
        .args(["api", "user", "-q", ".login"])
        .env("GH_PROMPT_DISABLED", "1")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

// Git protocol reported by gh (ssh | https) — reveals whether SSH or a PAT/HTTPS
// credential is wired. Parsed from `gh auth status`; never captures the token.
pub fn gh_protocol() -> Option<String> {
    let out = Command::new("gh")
        .args(["auth", "status"])
        .env("GH_PROMPT_DISABLED", "1")
        .output()
        .ok()?;
    let text =
        String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    parse_auth_protocol(&text)
}

// Extracts "ssh" / "https" from the "Git operations protocol: <p>" line.
pub fn parse_auth_protocol(s: &str) -> Option<String> {
    for line in s.lines() {
        let l = line.to_ascii_lowercase();
        if l.contains("protocol") {
            if l.contains("ssh") {
                return Some("ssh".into());
            }
            if l.contains("https") {
                return Some("https".into());
            }
        }
    }
    None
}

// (user.name, user.email) as resolved by git (global + local); None when unset.
pub fn git_identity(base: &Path) -> (Option<String>, Option<String>) {
    let read = |key: &str| -> Option<String> {
        let out = Command::new("git")
            .args(["config", key])
            .current_dir(base)
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!s.is_empty()).then_some(s)
    };
    (read("user.name"), read("user.email"))
}

// Safe, idempotent onboarding fix: set the git identity locally in the acervo
// repo (scoped; no system-wide change). Values are plain positional args.
pub fn set_identity(base: &Path, name: &str, email: &str) -> Result<(), String> {
    if name.trim().is_empty() || email.trim().is_empty() {
        return Err("nome e e-mail são obrigatórios".into());
    }
    git_init_repo(base)?;
    for (key, val) in [("user.name", name.trim()), ("user.email", email.trim())] {
        let out = Command::new("git")
            .args(["config", key, val])
            .current_dir(base)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
    }
    Ok(())
}

pub fn git_remote_url(base: &Path) -> Option<String> {
    let out = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(base)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

// Read access to the remote confirmed without writing anything.
pub fn gh_repo_accessible(base: &Path) -> bool {
    gh(base, &["repo", "view", "--json", "nameWithOwner"])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// Used by create_branch to branch off the default branch.
pub fn default_branch(base: &Path) -> String {
    gh(
        base,
        &[
            "repo",
            "view",
            "--json",
            "defaultBranchRef",
            "-q",
            ".defaultBranchRef.name",
        ],
    )
    .ok()
    .filter(|o| o.status.success())
    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| "main".into())
}

// ---- timeline (abstracted git history) -------------------------------------
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub id: String,
    pub when: String,
    pub author: String,
    pub label: String,
}

// Field separator is the ASCII unit separator (0x1f) so subjects with spaces or
// pipes are safe to split.
pub fn parse_log_line(line: &str) -> Option<Commit> {
    let mut it = line.split('\u{1f}');
    let id = it.next()?.to_string();
    let when = it.next().unwrap_or_default().to_string();
    let author = it.next().unwrap_or_default().to_string();
    let label = it.next().unwrap_or_default().to_string();
    if id.is_empty() {
        return None;
    }
    Some(Commit {
        id,
        when,
        author,
        label,
    })
}

pub fn git_log(base: &Path, rel: Option<&str>, limit: usize) -> Vec<Commit> {
    let n = format!("-{limit}");
    let mut args = vec![
        "log".to_string(),
        n,
        "--pretty=format:%H\u{1f}%aI\u{1f}%an\u{1f}%s".to_string(),
    ];
    if let Some(r) = rel {
        args.push("--".to_string());
        args.push(r.to_string());
    }
    let out = Command::new("git").args(&args).current_dir(base).output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter_map(parse_log_line)
            .collect(),
        _ => Vec::new(),
    }
}

// ---- Pull Requests (the RFCs) ----------------------------------------------
#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Author {
    #[serde(default)]
    pub login: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Reviewer {
    #[serde(default)]
    pub login: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub slug: Option<String>,
}

impl Reviewer {
    pub fn handle(&self) -> Option<&str> {
        self.login
            .as_deref()
            .or(self.slug.as_deref())
            .or(self.name.as_deref())
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrInfo {
    #[serde(default)]
    pub number: u64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub head_ref_name: String,
    #[serde(default)]
    pub author: Author,
    #[serde(default)]
    pub review_decision: Option<String>,
    #[serde(default)]
    pub review_requests: Vec<Reviewer>,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub state: Option<String>,
}

const PR_FIELDS: &str =
    "number,title,headRefName,author,reviewDecision,reviewRequests,updatedAt,url,state";

pub fn pr_list(base: &Path) -> Result<Vec<PrInfo>, String> {
    let out = gh(base, &["pr", "list", "--json", PR_FIELDS, "--limit", "50"])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}

pub fn pr_status(base: &Path, number: u64) -> Result<PrInfo, String> {
    let n = number.to_string();
    let out = gh(base, &["pr", "view", &n, "--json", PR_FIELDS])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}

// ---- write flow: Versionar (local) then Propor (remote + PR) ---------------

// ASCII-only branch slug ([a-z0-9-], no leading dash). Security: the sanitized
// value is the only user input in the branch name, so it can never be read as a
// flag or a shell metachar.
pub fn sanitize_slug(s: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in s.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let slug: String = out.trim_matches('-').chars().take(50).collect();
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        return Err("descreva a mudança para gerar o identificador".into());
    }
    Ok(slug)
}

pub fn current_branch(base: &Path) -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(base)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty() && s != "HEAD").then_some(s)
}

// Versionar step 1: create (or switch to) rfc/<slug>, branching off the default
// branch when it exists locally so main stays clean.
pub fn create_branch(base: &Path, slug: &str) -> Result<String, String> {
    git_init_repo(base)?;
    let branch = format!("rfc/{slug}");
    let start = default_branch(base);
    let has_start = Command::new("git")
        .args([
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{start}"),
        ])
        .current_dir(base)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let mut args: Vec<&str> = vec!["checkout", "-b", &branch];
    if has_start {
        args.push(&start);
    }
    let create = Command::new("git")
        .args(&args)
        .current_dir(base)
        .output()
        .map_err(|e| e.to_string())?;
    if create.status.success() {
        return Ok(branch);
    }
    // branch already exists → switch to it (append more commits to the same RFC)
    let switch = Command::new("git")
        .args(["checkout", &branch])
        .current_dir(base)
        .output()
        .map_err(|e| e.to_string())?;
    if switch.status.success() {
        Ok(branch)
    } else {
        Err(String::from_utf8_lossy(&create.stderr).trim().to_string())
    }
}

pub fn push_branch(base: &Path, branch: &str) -> Result<(), String> {
    let out = Command::new("git")
        .args(["push", "-u", "origin", branch])
        .current_dir(base)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrRef {
    pub number: u64,
    pub url: String,
}

// Propor step 2: open the PR (the RFC). title/body are positional args (no
// shell); body carries the filled PR template.
pub fn pr_create(base: &Path, branch: &str, title: &str, body: &str) -> Result<PrRef, String> {
    let out = gh(
        base,
        &[
            "pr", "create", "--head", branch, "--title", title, "--body", body,
        ],
    )?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let number = url
        .rsplit('/')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    Ok(PrRef { number, url })
}

pub fn git_available() -> bool {
    which("git").is_some()
}

// BR: the queue and other ephemeral sources NEVER enter default versioning.
// ADR-0013: the whole Brainstorming world (`brainstorming/`) is quarantined by
// this single entry — one gitignore line disjoints it from the versioned tree.
// The legacy `pessoal/` line stays as a safety belt for acervos not yet migrated
// (ADR-0009 named that world `pessoal/`); either line alone quarantines its world.
// Owner decision (2026-07-28): root `notas/` is personal too — the `/notas/`
// pattern is anchored so only the acervo-root folder is ignored, never a
// `notas/` that a context might legitimately version.
pub const GIT_IGNORED: [&str; 8] = [
    ".DS_Store",
    "inbox/",
    "processed/",
    "reunioes/",
    "/notas/",
    ".brain/prompt-history/",
    "brainstorming/",
    "pessoal/",
];

// ADR-0009/0013 write guard: meeting audio, the transcript (`reuniao.md`) and the
// content-bearing audit (`auditoria.jsonl`) must NEVER enter the versioned tree.
// True when `rel` (acervo-relative, forward slashes) is such an artifact under
// `contextos/`. Pure so the quarantine is unit-testable without a git repo.
pub fn is_versioning_denied(rel: &str) -> bool {
    let r = rel.trim_start_matches("./").replace('\\', "/");
    if !r.starts_with("contextos/") {
        return false;
    }
    let lower = r.to_ascii_lowercase();
    let leaf = r.rsplit('/').next().unwrap_or(&r);
    lower.ends_with(".wav")
        || lower.ends_with(".webm")
        || leaf == "reuniao.md"
        || leaf == "auditoria.jsonl"
}

// Idempotent: guarantees the ignore entries exist in the acervo's .gitignore
// (covers repos initialized before this rule, or hand-made ones).
pub fn ensure_gitignore(base: &Path) -> Result<(), String> {
    let gi = base.join(".gitignore");
    let cur = std::fs::read_to_string(&gi).unwrap_or_default();
    let mut out = cur.clone();
    for entry in GIT_IGNORED {
        if !cur.lines().any(|l| l.trim() == entry) {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(entry);
            out.push('\n');
        }
    }
    if out != cur {
        std::fs::write(&gi, out).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn git_init_repo(base: &Path) -> Result<(), String> {
    if !git_available() {
        return Err("git não encontrado no sistema".into());
    }
    ensure_gitignore(base)?;
    if base.join(".git").is_dir() {
        return Ok(());
    }
    let out = Command::new("git")
        .arg("init")
        .current_dir(base)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct GitState {
    available: bool,
    repo: bool,
    pending: usize,
}

#[tauri::command]
pub fn brain_git_state() -> GitState {
    let available = git_available();
    let base = read_brain_config().map(|c| PathBuf::from(c.brain_dir));
    let repo = base
        .as_ref()
        .map(|b| b.join(".git").is_dir())
        .unwrap_or(false);
    let pending = if available && repo {
        base.as_ref()
            .and_then(|b| {
                Command::new("git")
                    .args(["status", "--porcelain"])
                    .current_dir(b)
                    .output()
                    .ok()
            })
            .map(|o| String::from_utf8_lossy(&o.stdout).lines().count())
            .unwrap_or(0)
    } else {
        0
    };
    GitState {
        available,
        repo,
        pending,
    }
}

// Per-file git status (VSCode-like colors in the tree). Maps acervo-relative
// path -> porcelain code ("M", "??", "A", "D"…). Empty when there is no repo.
#[derive(serde::Serialize)]
pub struct GitFiles {
    repo: bool,
    files: HashMap<String, String>,
}

#[tauri::command]
pub fn brain_git_files() -> GitFiles {
    let base = read_brain_config().map(|c| PathBuf::from(c.brain_dir));
    let repo = base
        .as_ref()
        .map(|b| b.join(".git").is_dir())
        .unwrap_or(false);
    let mut files = HashMap::new();
    if repo && git_available() {
        if let Some(b) = base {
            if let Ok(o) = Command::new("git")
                .args(["status", "--porcelain", "-uall"])
                .current_dir(&b)
                .output()
            {
                for line in String::from_utf8_lossy(&o.stdout).lines() {
                    if line.len() < 4 {
                        continue;
                    }
                    let code = line[..2].trim().to_string();
                    let rest = &line[3..];
                    // renames come as "old -> new"; key by the new path
                    let path = rest
                        .rsplit(" -> ")
                        .next()
                        .unwrap_or(rest)
                        .trim_matches('"')
                        .to_string();
                    files.insert(path, code);
                }
            }
        }
    }
    GitFiles { repo, files }
}

// Manual "version now": stage everything and commit (BR: user drives push).
#[tauri::command]
pub fn brain_git_commit(message: String) -> Result<String, String> {
    let cfg = read_brain_config().ok_or("acervo não configurado")?;
    let base = PathBuf::from(&cfg.brain_dir);
    stage_and_commit(&base, message)
}

// Core of "version now", reused by the two-button flow (Versionar/Propor):
// ensure ephemeral sources stay untracked, stage everything else, commit with a
// fallback identity so machines without a global git identity still succeed.
pub fn stage_and_commit(base: &Path, message: String) -> Result<String, String> {
    if !base.join(".git").is_dir() {
        git_init_repo(base)?;
    }
    // queue/sources never enter default versioning: guarantee the ignore rules
    // and untrack anything previously indexed (files stay on disk)
    ensure_gitignore(base)?;
    let _ = Command::new("git")
        .args([
            "rm",
            "-r",
            "--cached",
            "--ignore-unmatch",
            "-q",
            "inbox",
            "processed",
            "reunioes",
            "notas",
            ".brain/prompt-history",
            "brainstorming",
            "pessoal",
        ])
        .current_dir(base)
        .output();
    let add = Command::new("git")
        .args(["add", "-A"])
        .current_dir(base)
        .output()
        .map_err(|e| e.to_string())?;
    if !add.status.success() {
        return Err(String::from_utf8_lossy(&add.stderr).to_string());
    }
    // ADR-0009 write guard: unstage any meeting audio/transcript/audit that
    // slipped under contextos/ (files stay on disk; they just never get committed).
    unstage_versioning_denied(base);
    let msg = if message.trim().is_empty() {
        "acervo: versionar".to_string()
    } else {
        message
    };
    // -c avoids failing when the machine has no global git identity, and
    // disables gpg signing (users with commit.gpgsign=true would otherwise fail)
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=Loro",
            "-c",
            "user.email=loro@localhost",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            &msg,
        ])
        .current_dir(base)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stdout).to_string()
            + &String::from_utf8_lossy(&out.stderr);
        if err.contains("nothing to commit") {
            return Ok("nada para versionar".into());
        }
        return Err(err.trim().to_string());
    }
    Ok("versionado".into())
}

// Reset from the index every staged path the ADR-0009 quarantine denies. Reads
// the staged set (`git diff --cached --name-only`) and unstages the matches with
// isolated positional args (no shell).
fn unstage_versioning_denied(base: &Path) {
    let Ok(out) = Command::new("git")
        .args(["diff", "--cached", "--name-only"])
        .current_dir(base)
        .output()
    else {
        return;
    };
    for rel in String::from_utf8_lossy(&out.stdout).lines() {
        if is_versioning_denied(rel) {
            let _ = Command::new("git")
                .args(["reset", "-q", "--", rel])
                .current_dir(base)
                .output();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_semver_extrai_de_saidas_reais() {
        assert_eq!(parse_semver("git version 2.50.1"), Some((2, 50, 1)));
        assert_eq!(
            parse_semver("gh version 2.83.2 (2025-12-10)"),
            Some((2, 83, 2))
        );
        assert_eq!(parse_semver("sem versao aqui"), None);
    }

    #[test]
    fn version_meets_compara_major_minor() {
        assert!(version_meets((2, 50, 1), (2, 20)));
        assert!(version_meets((3, 0, 0), (2, 20)));
        assert!(!version_meets((2, 10, 0), (2, 20)));
        assert!(!version_meets((1, 99, 0), (2, 0)));
    }

    #[test]
    fn parse_auth_protocol_le_ssh_e_https() {
        assert_eq!(
            parse_auth_protocol("  ✓ Git operations protocol: ssh"),
            Some("ssh".into())
        );
        assert_eq!(
            parse_auth_protocol("- Git operations protocol: https"),
            Some("https".into())
        );
        assert_eq!(parse_auth_protocol("Logged in to github.com"), None);
    }

    #[test]
    fn parse_log_line_separa_por_unit_separator() {
        let c = parse_log_line("abc123\u{1f}2026-07-26T10:00:00-03:00\u{1f}Ana\u{1f}feat: x | y")
            .unwrap();
        assert_eq!(c.id, "abc123");
        assert_eq!(c.author, "Ana");
        assert_eq!(c.label, "feat: x | y"); // pipe no assunto é preservado
        assert!(parse_log_line("").is_none());
    }

    #[test]
    fn pr_info_desserializa_json_do_gh() {
        let json = r#"[{"number":7,"title":"RFC: frota","headRefName":"rfc/frota-x",
            "author":{"login":"ana"},"reviewDecision":"REVIEW_REQUIRED",
            "reviewRequests":[{"login":"bob"},{"name":"Time Frota","slug":"frota"}],
            "updatedAt":"2026-07-26T10:00:00Z","url":"https://github.com/x/y/pull/7","state":"OPEN"}]"#;
        let prs: Vec<PrInfo> = serde_json::from_str(json).unwrap();
        assert_eq!(prs.len(), 1);
        let p = &prs[0];
        assert_eq!(p.number, 7);
        assert_eq!(p.head_ref_name, "rfc/frota-x");
        assert_eq!(p.author.login, "ana");
        assert_eq!(p.review_decision.as_deref(), Some("REVIEW_REQUIRED"));
        assert_eq!(p.review_requests[0].handle(), Some("bob"));
        assert_eq!(p.review_requests[1].handle(), Some("frota"));
    }

    #[test]
    fn pr_info_tolera_campos_ausentes() {
        // gh pode omitir campos; nada deve quebrar (serde default)
        let prs: Vec<PrInfo> = serde_json::from_str(r#"[{"number":1}]"#).unwrap();
        assert_eq!(prs[0].number, 1);
        assert!(prs[0].title.is_empty());
        assert!(prs[0].review_requests.is_empty());
    }

    #[test]
    fn sanitize_slug_blinda_o_nome_da_branch() {
        // acentos (não-ASCII) viram separador — nome de branch portável
        assert_eq!(sanitize_slug("Nova política!").unwrap(), "nova-pol-tica");
        assert_eq!(sanitize_slug("Frota 2026").unwrap(), "frota-2026");
        assert_eq!(sanitize_slug("  --hack; rm -rf  ").unwrap(), "hack-rm-rf");
        assert!(!sanitize_slug("x").unwrap().starts_with('-'));
        // sem caracteres úteis → erro (nunca gera branch vazia/insegura)
        assert!(sanitize_slug("   !!!   ").is_err());
        assert!(sanitize_slug("---").is_err());
    }

    #[test]
    fn is_versioning_denied_bloqueia_audio_transcricao_audit_sob_contextos() {
        // ADR-0009: audio/transcript/audit under contextos/ are denied ...
        assert!(is_versioning_denied(
            "contextos/frota/reunioes/r1/audio.wav"
        ));
        assert!(is_versioning_denied("contextos/frota/audio.WEBM"));
        assert!(is_versioning_denied(
            "contextos/frota/reunioes/r1/reuniao.md"
        ));
        assert!(is_versioning_denied(
            "contextos/frota/reunioes/r1/auditoria.jsonl"
        ));
        // ... but consolidated knowledge and everything outside contextos/ is fine
        assert!(!is_versioning_denied("contextos/frota/context.md"));
        assert!(!is_versioning_denied(
            "contextos/frota/referencias/chart.png"
        ));
        // ADR-0013: the non-versioned world is `brainstorming/`; legacy `pessoal/`
        // stays quarantined too — neither is under contextos/, so never denied.
        assert!(!is_versioning_denied(
            "brainstorming/x/reunioes/r1/audio.wav"
        ));
        assert!(!is_versioning_denied(
            "pessoal/temas/x/reunioes/r1/audio.wav"
        ));
        assert!(!is_versioning_denied("notas/reuniao.md"));
    }

    #[test]
    fn stage_and_commit_nunca_versiona_audio_transcricao_audit_ou_pessoal() {
        if which("git").is_none() {
            return; // git é dependência de sistema; pula se ausente
        }
        let root = std::env::temp_dir().join(format!("loro-quar-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("contextos/frota/reunioes/r1")).unwrap();
        std::fs::create_dir_all(root.join("brainstorming/x")).unwrap();
        std::fs::create_dir_all(root.join("pessoal/temas/x")).unwrap();
        git_init_repo(&root).unwrap();
        set_identity(&root, "Teste", "teste@localhost").unwrap();

        std::fs::write(root.join("contextos/frota/context.md"), "conhecimento").unwrap();
        std::fs::write(root.join("contextos/frota/reunioes/r1/audio.wav"), b"RIFF").unwrap();
        std::fs::write(root.join("contextos/frota/reunioes/r1/reuniao.md"), "fala").unwrap();
        std::fs::write(
            root.join("contextos/frota/reunioes/r1/auditoria.jsonl"),
            "{}\n",
        )
        .unwrap();
        std::fs::write(root.join("brainstorming/x/nota.md"), "brainstorming").unwrap();
        std::fs::write(root.join("pessoal/temas/x/nota.md"), "pessoal").unwrap();

        stage_and_commit(&root, "base".into()).unwrap();

        let tracked = Command::new("git")
            .args(["ls-files"])
            .current_dir(&root)
            .output()
            .unwrap();
        let files = String::from_utf8_lossy(&tracked.stdout);
        assert!(files.contains("contextos/frota/context.md"));
        assert!(!files.contains(".wav"), "áudio nunca é versionado");
        assert!(
            !files.contains("reuniao.md"),
            "transcrição nunca é versionada"
        );
        assert!(
            !files.contains("auditoria.jsonl"),
            "auditoria nunca é versionada"
        );
        assert!(
            !files.contains("brainstorming"),
            "o mundo brainstorming/ nunca é versionado"
        );
        assert!(
            !files.contains("pessoal"),
            "o mundo legado pessoal/ nunca é versionado"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn versionar_cria_branch_rfc_e_preserva_main() {
        if which("git").is_none() {
            return; // git é dependência de sistema; pula se ausente
        }
        let root = std::env::temp_dir().join(format!("loro-ver-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        git_init_repo(&root).unwrap();
        set_identity(&root, "Teste", "teste@localhost").unwrap();
        std::fs::write(root.join("context.md"), "base").unwrap();
        stage_and_commit(&root, "base".into()).unwrap();
        let orig = current_branch(&root).unwrap();

        let branch = create_branch(&root, "minha-rfc").unwrap();
        assert_eq!(branch, "rfc/minha-rfc");
        assert_eq!(current_branch(&root).as_deref(), Some("rfc/minha-rfc"));

        std::fs::write(root.join("context.md"), "mudança proposta").unwrap();
        assert_eq!(
            stage_and_commit(&root, "feat: x".into()).unwrap(),
            "versionado"
        );

        // a branch principal continua existindo (todo trabalho parte dela)
        let kept = Command::new("git")
            .args(["rev-parse", "--verify", &orig])
            .current_dir(&root)
            .output()
            .unwrap()
            .status
            .success();
        assert!(kept);
        let _ = std::fs::remove_dir_all(&root);
    }
}
