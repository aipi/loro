// Optional versioning of the acervo. Git stays a system dependency (resolved
// from PATH); nothing is vendored. This module owns the git/GitHub concern so
// lib.rs keeps only Tauri wiring — see the "git" split target in CLAUDE.md.
//
// Invocation policy (security): always `crate::proc::command("git"|"gh").args([...])`
// with fixed tokens — never `sh -c`, never interpolate user input into a shell
// string. Values coming from the user are passed as isolated positional args.
// Logs never carry tokens/PII (BR: structured logs, no secrets).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Output;

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
    crate::proc::command("gh")
        .args(args)
        .current_dir(base)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .output()
        .map_err(|e| e.to_string())
}

fn tool_version(bin: &str) -> Option<(u32, u32, u32)> {
    let out = crate::proc::command(bin).arg("--version").output().ok()?;
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
    crate::proc::command("gh")
        .args(["auth", "status"])
        .env("GH_PROMPT_DISABLED", "1")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// The public GitHub login (not a secret) — used to target notifications at "me".
pub fn gh_account() -> Option<String> {
    let out = crate::proc::command("gh")
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
    let out = crate::proc::command("gh")
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
        let out = crate::proc::command("git")
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

// Is this text an e-mail ADDRESS? The identity signs every version the team
// reads and is how GitHub attributes a commit to a person, so "seu@email" — the
// example the sheet itself used to pre-fill as a value — cannot be accepted just
// because it is not empty. Shape only: exactly one `@`, both halves non-empty, a
// dotted domain, and none of the characters that would break the author line
// (whitespace, control, `<`, `>`, `,`, `;`, `"`).
fn is_email_shaped(email: &str) -> bool {
    let e = email.trim();
    let Some((local, domain)) = e.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !domain.contains('@')
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !e
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "<>,;\"".contains(c))
}

// Safe, idempotent onboarding fix: set the git identity locally in the acervo
// repo (scoped; no system-wide change). Values are plain positional args.
pub fn set_identity(base: &Path, name: &str, email: &str) -> Result<(), String> {
    if name.trim().is_empty() || email.trim().is_empty() {
        return Err("err.git_identity_required".into());
    }
    if !is_email_shaped(email) {
        return Err("err.git_identity_invalid_email".into());
    }
    git_init_repo(base)?;
    for (key, val) in [("user.name", name.trim()), ("user.email", email.trim())] {
        let out = crate::proc::command("git")
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
    let out = crate::proc::command("git")
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

// Why the remote could not be reached. A bool collapsed "you have not connected
// a repository" and "this machine has no network right now" into the same
// answer, so five minutes offline made the app blame the user's setup (N6).
#[derive(PartialEq, Debug, Clone, Copy)]
pub enum RemoteAccess {
    Ok,
    Denied,
    Offline,
}

// A transport failure names itself in gh's stderr; anything else is an answer
// FROM GitHub (404/403/not found), which is a real access problem.
fn looks_offline(stderr: &str) -> bool {
    let s = stderr.to_lowercase();
    [
        "dial tcp",
        "no such host",
        "network is unreachable",
        "temporary failure in name resolution",
        "connection refused",
        "connection reset",
        "i/o timeout",
        "timeout awaiting",
        "tls handshake",
        "proxyconnect",
        "server misbehaving",
        "eof",
    ]
    .iter()
    .any(|needle| s.contains(needle))
}

// Read access to the remote confirmed without writing anything.
pub fn gh_repo_accessible(base: &Path) -> RemoteAccess {
    match gh(base, &["repo", "view", "--json", "nameWithOwner"]) {
        Ok(o) if o.status.success() => RemoteAccess::Ok,
        Ok(o) => {
            if looks_offline(&String::from_utf8_lossy(&o.stderr)) {
                RemoteAccess::Offline
            } else {
                RemoteAccess::Denied
            }
        }
        // gh itself did not run: nothing was asked of the network
        Err(_) => RemoteAccess::Denied,
    }
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

// ---- branch-first flow (ADR-0002 §2) ----------------------------------------
// Local view of the git graph: everything here resolves without network or gh,
// so the studio stays responsive offline. gh remains only on the propose path.

fn ref_exists(base: &Path, r: &str) -> bool {
    crate::proc::command("git")
        .args(["rev-parse", "--verify", "--quiet", r])
        .current_dir(base)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn ref_sha(base: &Path, r: &str) -> Option<String> {
    let out = crate::proc::command("git")
        .args(["rev-parse", "--verify", "--quiet", r])
        .current_dir(base)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// Default branch resolved locally (no network, no gh): origin/HEAD when the
// clone recorded it, else the conventional local head, else "main".
pub fn local_default_branch(base: &Path) -> String {
    if let Ok(out) = crate::proc::command("git")
        .args(["symbolic-ref", "refs/remotes/origin/HEAD"])
        .current_dir(base)
        .output()
    {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if let Some(b) = s.strip_prefix("refs/remotes/origin/") {
                if !b.is_empty() {
                    return b.to_string();
                }
            }
        }
    }
    for cand in ["main", "master"] {
        if ref_exists(base, &format!("refs/heads/{cand}")) {
            return cand.into();
        }
    }
    "main".into()
}

pub fn is_dirty(base: &Path) -> bool {
    crate::proc::command("git")
        .args(["status", "--porcelain"])
        .current_dir(base)
        .output()
        .map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false)
}

// Local branches, most recently committed first.
pub fn list_branches(base: &Path) -> Result<Vec<String>, String> {
    let out = crate::proc::command("git")
        .args([
            "for-each-ref",
            "refs/heads",
            "--format=%(refname:short)",
            "--sort=-committerdate",
        ])
        .current_dir(base)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

// What a branch actually HOLDS, in documents — the only honest way for the
// picker to talk about it. A project that started versioning after setup has an
// empty default branch (Baseline::Empty commits nothing), so the row the UI
// labels "(principal)" can be an empty room: leaving the draft for it takes
// every document off the disk. Git keeps the content safe on the draft commit,
// but the screen goes empty, so the price has to be stated before the click
// (DESIGN.md §1). Dot-folders are the machine's own (.github/, .claude/,
// .gitignore) — the user never sees them as documents, so they are not counted.
fn tracked_documents(base: &Path, rev: &str) -> Vec<String> {
    let out = crate::proc::command("git")
        .args(["ls-tree", "-r", "--name-only", rev])
        .current_dir(base)
        .output();
    let Ok(out) = out else { return Vec::new() };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && !l.split('/').any(|p| p.starts_with('.')))
        .collect()
}

pub fn documents_on(base: &Path, rev: &str) -> usize {
    tracked_documents(base, rev).len()
}

// Documents that leave the screen when the user goes from `rev` to `target`.
pub fn documents_leaving(base: &Path, rev: &str, target: &str) -> usize {
    let there: std::collections::HashSet<String> =
        tracked_documents(base, target).into_iter().collect();
    tracked_documents(base, rev)
        .into_iter()
        .filter(|f| !there.contains(f))
        .count()
}

pub fn switch_branch(base: &Path, branch: &str) -> Result<(), String> {
    if is_dirty(base) {
        return Err("err.working_tree_dirty".into());
    }
    if !ref_exists(base, &format!("refs/heads/{branch}")) {
        return Err("err.branch_not_found".into());
    }
    let out = crate::proc::command("git")
        .args(["checkout", branch])
        .current_dir(base)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[derive(PartialEq, Debug)]
pub enum SyncOutcome {
    Updated,
    AlreadyUpToDate,
    NoRemote,
    Offline,
    Diverged,
    SkippedDirty,
}

// Best-effort fast-forward of the local default branch from origin. Never an
// error: every failure degrades to an outcome the caller can surface as a
// warning. The local default branch is never rewritten outside fast-forward.
pub fn sync_default_branch(base: &Path) -> SyncOutcome {
    if git_remote_url(base).is_none() {
        return SyncOutcome::NoRemote;
    }
    let default = local_default_branch(base);
    // low-speed limits keep a flaky network from hanging the UI
    let fetch = crate::proc::command("git")
        .args([
            "-c",
            "http.lowSpeedLimit=1",
            "-c",
            "http.lowSpeedTime=10",
            "fetch",
            "origin",
            &default,
        ])
        .current_dir(base)
        .output();
    match fetch {
        Ok(o) if o.status.success() => {}
        _ => return SyncOutcome::Offline,
    }
    let local_ref = format!("refs/heads/{default}");
    if current_branch(base).as_deref() == Some(default.as_str()) {
        if is_dirty(base) {
            return SyncOutcome::SkippedDirty;
        }
        let before = ref_sha(base, &local_ref);
        let merge = crate::proc::command("git")
            .args(["merge", "--ff-only", &format!("origin/{default}")])
            .current_dir(base)
            .output();
        match merge {
            Ok(o) if o.status.success() => {
                if ref_sha(base, &local_ref) == before {
                    SyncOutcome::AlreadyUpToDate
                } else {
                    SyncOutcome::Updated
                }
            }
            _ => SyncOutcome::Diverged,
        }
    } else {
        // not on the default branch: fetch refspec updates it fast-forward-only
        let before = ref_sha(base, &local_ref);
        let out = crate::proc::command("git")
            .args(["fetch", "origin", &format!("{default}:{default}")])
            .current_dir(base)
            .output();
        match out {
            Ok(o) if o.status.success() => {
                if ref_sha(base, &local_ref) == before {
                    SyncOutcome::AlreadyUpToDate
                } else {
                    SyncOutcome::Updated
                }
            }
            _ => SyncOutcome::Diverged,
        }
    }
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
    let out = crate::proc::command("git")
        .args(&args)
        .current_dir(base)
        .output();
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
        return Err("err.change_description_required".into());
    }
    Ok(slug)
}

pub fn current_branch(base: &Path) -> Option<String> {
    let out = crate::proc::command("git")
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

// Does HEAD resolve to a commit? False on a repo that was only `git init`ed:
// its default branch is UNBORN, so no ref points at anything yet.
fn head_commit_exists(base: &Path) -> bool {
    crate::proc::command("git")
        .args(["rev-parse", "--verify", "--quiet", "HEAD"])
        .current_dir(base)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// What the baseline commit contains.
// `Seeded`: the acervo exactly as setup created it — the official starting point
// of the knowledge, so a later draft carries only the user's own changes.
// `Empty`: a repo that reached the versioning flow with no baseline at all (it
// was created before this rule). Its whole working tree IS the version the user
// is saving right now, so the baseline takes nothing and the draft keeps every
// change to propose.
pub enum Baseline {
    Seeded,
    Empty,
}

// The project's official branch has to EXIST before the first draft: on an
// unborn repo `git checkout -b rfc/<slug>` renames the unborn branch instead of
// branching off it, so the default branch is never created — the branch picker
// calls a non-existent branch the default, switching to it fails, the sync can
// never fast-forward, and the promise "quando o time aprova, vira oficial" has
// nothing to become official into. Idempotent: a no-op once HEAD has a commit.
pub fn ensure_baseline_commit(base: &Path, kind: Baseline) -> Result<(), String> {
    if head_commit_exists(base) {
        return Ok(());
    }
    // Name the unborn branch after the default THIS app resolves, so the branch
    // the picker labels "(principal)" is the one on disk whatever the machine's
    // init.defaultBranch happens to be.
    let default = local_default_branch(base);
    let _ = crate::proc::command("git")
        .args(["symbolic-ref", "HEAD", &format!("refs/heads/{default}")])
        .current_dir(base)
        .output();
    match kind {
        Baseline::Seeded => stage_and_commit(base, BASELINE_MESSAGE.into()).map(|_| ()),
        Baseline::Empty => commit_empty_baseline(base),
    }
}

// The timeline prints commit subjects verbatim, so the baseline names itself in
// the user's words (DESIGN.md §4: acervo → projeto).
const BASELINE_MESSAGE: &str = "base do projeto";

fn commit_empty_baseline(base: &Path) -> Result<(), String> {
    let (name, email) = git_identity(base);
    let mut args = identity_args(name.as_deref(), email.as_deref());
    args.push("-c".into());
    args.push("commit.gpgsign=false".into());
    args.push("commit".into());
    args.push("--allow-empty".into());
    args.push("-m".into());
    args.push(BASELINE_MESSAGE.into());
    let out = crate::proc::command("git")
        .args(&args)
        .current_dir(base)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

// Versionar step 1: create (or switch to) rfc/<slug>.
//
// A draft starts from the work in front of the user. With pending edits the new
// draft branches off HEAD, never off the default branch: `checkout -b <new>
// <default>` moves those edits onto another base, so a version already saved on
// the current draft disappears from the open document (and, when the same file
// is touched twice, git refuses the checkout altogether). With a clean tree the
// draft starts from the locally-resolved default so it stays independent
// (ADR-0002 §2; the propose path still asks gh for the authoritative default).
pub fn create_branch(base: &Path, slug: &str) -> Result<String, String> {
    git_init_repo(base)?;
    ensure_baseline_commit(base, Baseline::Empty)?;
    let branch = format!("rfc/{slug}");
    if current_branch(base).as_deref() == Some(branch.as_str()) {
        return Ok(branch);
    }
    let start = if is_dirty(base) {
        current_branch(base)
    } else {
        let default = local_default_branch(base);
        ref_exists(base, &format!("refs/heads/{default}")).then_some(default)
    };
    let mut args: Vec<&str> = vec!["checkout", "-b", &branch];
    if let Some(start) = start.as_deref() {
        args.push(start);
    }
    let create = crate::proc::command("git")
        .args(&args)
        .current_dir(base)
        .output()
        .map_err(|e| e.to_string())?;
    if create.status.success() {
        return Ok(branch);
    }
    // branch already exists → switch to it (append more commits to the same RFC)
    let switch = crate::proc::command("git")
        .args(["checkout", &branch])
        .current_dir(base)
        .output()
        .map_err(|e| e.to_string())?;
    if switch.status.success() {
        return Ok(branch);
    }
    // The one failure left that the user can act on is pending work blocking the
    // checkout: say it as a code the UI translates, instead of forwarding git's
    // raw multi-line English into a toast.
    if is_dirty(base) {
        Err("err.working_tree_dirty".into())
    } else {
        Err(String::from_utf8_lossy(&create.stderr).trim().to_string())
    }
}

pub fn push_branch(base: &Path, branch: &str) -> Result<(), String> {
    let out = crate::proc::command("git")
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
        return Err("err.git_not_found".into());
    }
    ensure_gitignore(base)?;
    if base.join(".git").is_dir() {
        return Ok(());
    }
    let out = crate::proc::command("git")
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
#[serde(rename_all = "camelCase")]
pub struct GitState {
    available: bool,
    repo: bool,
    pending: usize,
    branch: Option<String>,
}

// How many changes a version would carry. ONE authority: the number the button
// counts is the same one the save flow asks before deciding there is anything to
// save, so the label ("tudo salvo ✓") and the refusal can never disagree.
pub fn pending_changes(base: &Path) -> usize {
    crate::proc::command("git")
        .args(["status", "--porcelain"])
        .current_dir(base)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().count())
        .unwrap_or(0)
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
        base.as_ref().map(|b| pending_changes(b)).unwrap_or(0)
    } else {
        0
    };
    let branch = if available && repo {
        base.as_ref().and_then(|b| current_branch(b))
    } else {
        None
    };
    GitState {
        available,
        repo,
        pending,
        branch,
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
            if let Ok(o) = crate::proc::command("git")
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
    let cfg = read_brain_config().ok_or("err.acervo_not_configured")?;
    let base = PathBuf::from(&cfg.brain_dir);
    stage_and_commit(&base, message)
}

// What a save attempt DID, as a fact the screen can read. The result used to be
// a pt-BR sentence ("nada para versionar") the app never looked at, so it
// toasted "versão salva" over a commit that never happened.
pub struct VersionAttempt {
    pub branch: String,
    pub saved: bool,
    pub warn: Option<String>,
}

// Sync outcomes the user should see as a warning (the flow still proceeds —
// branch-first degrades, ADR-0002 §2). NoRemote is the pure-local case: no warn.
fn sync_warn(outcome: &SyncOutcome) -> Option<String> {
    match outcome {
        SyncOutcome::Offline => Some("err.git_offline".into()),
        SyncOutcome::Diverged => Some("err.main_diverged".into()),
        _ => None,
    }
}

// "Salvar versão", whole: refuse a no-op, sync the default branch (best effort),
// open the draft and commit the work there.
//
// Lives here (not in the Tauri wrapper) because the decisions it takes are
// domain rules, and a rule with no test is how the app came to announce versions
// that did not exist.
pub fn save_version(base: &Path, slug: &str, message: String) -> Result<VersionAttempt, String> {
    // N3 · nothing pending is not a version. Asked BEFORE the network sync and
    // before any draft is created, so a no-op costs no ~10s fetch, leaves no
    // empty draft behind and moves nobody onto another draft.
    if base.join(".git").is_dir() && pending_changes(base) == 0 {
        return Ok(VersionAttempt {
            branch: current_branch(base).unwrap_or_default(),
            saved: false,
            warn: None,
        });
    }
    let warn = sync_warn(&sync_default_branch(base));
    let branch = create_branch(base, slug)?;
    let result = stage_and_commit(base, message)?;
    Ok(VersionAttempt {
        branch,
        saved: result == OUTCOME_VERSIONED,
        warn,
    })
}

// The `-c` overrides a version is committed with. Command-line `-c` has the
// HIGHEST precedence in git, so passing an identity unconditionally does not
// "fall back": it OVERRIDES the one the doctor's "identidade git" fix just set,
// every version ends up authored by a bot, and the review flow loses who
// proposed what. Only the half git cannot resolve is filled in, so a machine
// with no identity at all still commits.
fn identity_args(name: Option<&str>, email: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if name.is_none() {
        args.push("-c".into());
        args.push("user.name=Loro".into());
    }
    if email.is_none() {
        args.push("-c".into());
        args.push("user.email=loro@localhost".into());
    }
    args
}

// The two outcomes of a commit attempt, as STABLE codes. They are not sentences
// for the user: the screen decides what to say from the fact, in its own
// language (CLAUDE.md §6 — a pt-BR sentence from the backend is not a msgid).
pub const OUTCOME_VERSIONED: &str = "versionado";
pub const OUTCOME_NOTHING: &str = "nada-a-versionar";

// Core of "version now", reused by the two-button flow (Versionar/Propor):
// ensure ephemeral sources stay untracked, stage everything else, commit with the
// user's git identity (falling back only for what the machine does not define).
pub fn stage_and_commit(base: &Path, message: String) -> Result<String, String> {
    if !base.join(".git").is_dir() {
        git_init_repo(base)?;
    }
    // queue/sources never enter default versioning: guarantee the ignore rules
    // and untrack anything previously indexed (files stay on disk)
    ensure_gitignore(base)?;
    let _ = crate::proc::command("git")
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
    let add = crate::proc::command("git")
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
    let (name, email) = git_identity(base);
    let mut args = identity_args(name.as_deref(), email.as_deref());
    // no TTY for a passphrase inside the app: users with commit.gpgsign=true
    // would otherwise fail on every version
    args.push("-c".into());
    args.push("commit.gpgsign=false".into());
    args.push("commit".into());
    args.push("-m".into());
    args.push(msg);
    let out = crate::proc::command("git")
        .args(&args)
        .current_dir(base)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stdout).to_string()
            + &String::from_utf8_lossy(&out.stderr);
        if err.contains("nothing to commit") {
            return Ok(OUTCOME_NOTHING.into());
        }
        return Err(err.trim().to_string());
    }
    Ok(OUTCOME_VERSIONED.into())
}

// Reset from the index every staged path the ADR-0009 quarantine denies. Reads
// the staged set (`git diff --cached --name-only`) and unstages the matches with
// isolated positional args (no shell).
fn unstage_versioning_denied(base: &Path) {
    let Ok(out) = crate::proc::command("git")
        .args(["diff", "--cached", "--name-only"])
        .current_dir(base)
        .output()
    else {
        return;
    };
    for rel in String::from_utf8_lossy(&out.stdout).lines() {
        if is_versioning_denied(rel) {
            let _ = crate::proc::command("git")
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
    fn parse_semver_extracts_from_real_outputs() {
        assert_eq!(parse_semver("git version 2.50.1"), Some((2, 50, 1)));
        assert_eq!(
            parse_semver("gh version 2.83.2 (2025-12-10)"),
            Some((2, 83, 2))
        );
        assert_eq!(parse_semver("sem versao aqui"), None);
    }

    #[test]
    fn version_meets_compares_major_minor() {
        assert!(version_meets((2, 50, 1), (2, 20)));
        assert!(version_meets((3, 0, 0), (2, 20)));
        assert!(!version_meets((2, 10, 0), (2, 20)));
        assert!(!version_meets((1, 99, 0), (2, 0)));
    }

    #[test]
    fn parse_auth_protocol_reads_ssh_and_https() {
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
    fn parse_log_line_splits_on_unit_separator() {
        let c = parse_log_line("abc123\u{1f}2026-07-26T10:00:00-03:00\u{1f}Ana\u{1f}feat: x | y")
            .unwrap();
        assert_eq!(c.id, "abc123");
        assert_eq!(c.author, "Ana");
        assert_eq!(c.label, "feat: x | y"); // pipe in the subject is preserved
        assert!(parse_log_line("").is_none());
    }

    #[test]
    fn pr_info_deserializes_gh_json() {
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
    fn pr_info_tolerates_missing_fields() {
        // gh may omit fields; nothing should break (serde default)
        let prs: Vec<PrInfo> = serde_json::from_str(r#"[{"number":1}]"#).unwrap();
        assert_eq!(prs[0].number, 1);
        assert!(prs[0].title.is_empty());
        assert!(prs[0].review_requests.is_empty());
    }

    #[test]
    fn sanitize_slug_hardens_the_branch_name() {
        // accents (non-ASCII) become a separator — portable branch name
        assert_eq!(sanitize_slug("Nova política!").unwrap(), "nova-pol-tica");
        assert_eq!(sanitize_slug("Frota 2026").unwrap(), "frota-2026");
        assert_eq!(sanitize_slug("  --hack; rm -rf  ").unwrap(), "hack-rm-rf");
        assert!(!sanitize_slug("x").unwrap().starts_with('-'));
        // no useful characters → error (never yields an empty/unsafe branch)
        assert!(sanitize_slug("   !!!   ").is_err());
        assert!(sanitize_slug("---").is_err());
    }

    #[test]
    fn is_versioning_denied_blocks_audio_transcript_audit_under_contextos() {
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
    fn stage_and_commit_never_versions_audio_transcript_audit_or_pessoal() {
        if which("git").is_none() {
            return; // git is a system dependency; skip when absent
        }
        let root = std::env::temp_dir().join(format!("loro-quar-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("contextos/frota/reunioes/r1")).unwrap();
        std::fs::create_dir_all(root.join("brainstorming/x")).unwrap();
        std::fs::create_dir_all(root.join("pessoal/temas/x")).unwrap();
        git_init_repo(&root).unwrap();
        set_identity(&root, "Teste", "teste@exemplo.com").unwrap();

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
        // owner decision (2026-07-28): root notas/ is personal — never versioned
        std::fs::create_dir_all(root.join("notas")).unwrap();
        std::fs::write(root.join("notas/2026-07-28-anotacao.md"), "pessoal").unwrap();

        stage_and_commit(&root, "base".into()).unwrap();

        let tracked = crate::proc::command("git")
            .args(["ls-files"])
            .current_dir(&root)
            .output()
            .unwrap();
        let files = String::from_utf8_lossy(&tracked.stdout);
        assert!(files.contains("contextos/frota/context.md"));
        assert!(!files.contains(".wav"), "audio is never versioned");
        assert!(
            !files.contains("reuniao.md"),
            "the transcript is never versioned"
        );
        assert!(
            !files.contains("auditoria.jsonl"),
            "the audit is never versioned"
        );
        assert!(
            !files.contains("brainstorming"),
            "the brainstorming/ world is never versioned"
        );
        assert!(
            !files.contains("pessoal"),
            "the legacy pessoal/ world is never versioned"
        );
        assert!(
            !files.contains("notas/"),
            "root notas/ is personal — never versioned"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- branch-first flow (ADR-0002 §2) fixtures --------------------------

    fn run_git(dir: &Path, args: &[&str]) -> Output {
        crate::proc::command("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap()
    }

    fn rev_sha(dir: &Path, r: &str) -> String {
        let out = run_git(dir, &["rev-parse", r]);
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn temp_repo(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("loro-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    // Repo with one commit and a deterministic default-branch name (older git
    // inits as "master"; the tests need "main").
    fn init_with_commit(root: &Path) {
        git_init_repo(root).unwrap();
        set_identity(root, "Teste", "teste@exemplo.com").unwrap();
        std::fs::write(root.join("context.md"), "base").unwrap();
        stage_and_commit(root, "base".into()).unwrap();
        run_git(root, &["branch", "-M", "main"]);
    }

    // N1 — "salvar versão" twice with different descriptions used to branch the
    // second draft off the default, which moved the pending edit onto another
    // base: the version saved a moment earlier left the open document and the
    // history, while the UI still said "versão salva / tudo salvo".
    #[test]
    fn a_new_draft_keeps_the_version_saved_on_the_current_one() {
        if which("git").is_none() {
            return; // git is a system dependency; skip when absent
        }
        let root = temp_repo("draft-chain");
        init_with_commit(&root);

        std::fs::write(root.join("frota.md"), "politica de frota").unwrap();
        create_branch(&root, "politica-de-frota").unwrap();
        stage_and_commit(&root, "politica de frota".into()).unwrap();

        // a second knowledge file, described differently → another draft
        std::fs::write(root.join("mobile.md"), "nota mobile").unwrap();
        create_branch(&root, "nota-mobile").unwrap();
        stage_and_commit(&root, "nota mobile".into()).unwrap();

        assert_eq!(current_branch(&root).as_deref(), Some("rfc/nota-mobile"));
        assert_eq!(
            std::fs::read_to_string(root.join("frota.md")).ok(),
            Some("politica de frota".to_string()),
            "the document went back to its pre-version content"
        );
        let log = run_git(&root, &["log", "--oneline"]);
        let log = String::from_utf8_lossy(&log.stdout).to_string();
        assert!(
            log.contains("politica de frota"),
            "the version saved first vanished from the history: {log}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // N1 (variant) — editing the SAME file twice made git abort the checkout and
    // its raw multi-line English landed verbatim in a toast. The draft the user
    // is on keeps the work either way.
    #[test]
    fn a_second_draft_over_the_same_file_never_leaks_raw_git_english() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("draft-same-file");
        init_with_commit(&root);

        std::fs::write(root.join("context.md"), "primeira").unwrap();
        create_branch(&root, "primeira-mudanca").unwrap();
        stage_and_commit(&root, "primeira mudança".into()).unwrap();
        std::fs::write(root.join("context.md"), "segunda").unwrap();

        let branch = create_branch(&root, "segunda-mudanca")
            .unwrap_or_else(|e| panic!("versionar failed with a raw git message: {e}"));
        assert_eq!(branch, "rfc/segunda-mudanca");
        assert_eq!(
            std::fs::read_to_string(root.join("context.md")).unwrap(),
            "segunda",
            "the pending edit was thrown away by the checkout"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // N2 — a project whose repo has no commits: the first "salvar versão" used to
    // RENAME the unborn default branch, so the acervo lived on a draft forever and
    // "quando o time aprova, vira oficial" had nothing to become official into.
    #[test]
    fn the_first_version_leaves_an_official_branch_to_merge_into() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("baseline");
        git_init_repo(&root).unwrap();
        set_identity(&root, "Teste", "teste@exemplo.com").unwrap();
        std::fs::write(root.join("context.md"), "conhecimento").unwrap();

        create_branch(&root, "primeira-mudanca").unwrap();
        let result = stage_and_commit(&root, "primeira mudança".into()).unwrap();

        assert!(
            ref_exists(&root, "refs/heads/main"),
            "no official branch exists after the first version"
        );
        assert_eq!(local_default_branch(&root), "main");
        assert_eq!(
            current_branch(&root).as_deref(),
            Some("rfc/primeira-mudanca")
        );
        // the baseline must not swallow the version the user is saving: it lands
        // on the draft, so there is something to send for review
        assert_eq!(result, "versionado");
        let tracked = run_git(
            &root,
            &["ls-tree", "-r", "--name-only", "rfc/primeira-mudanca"],
        );
        assert!(String::from_utf8_lossy(&tracked.stdout).contains("context.md"));
        // the picker's "(principal)" row has to be reachable
        switch_branch(&root, "main").unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    // N2 (setup leg) — a project created with "guardar histórico" on had git init
    // and no commit, so it owned no branch at all. The baseline is the seeded
    // acervo itself: what the team's approval later makes official.
    #[test]
    fn a_seeded_project_starts_on_an_official_branch() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("seeded-baseline");
        git_init_repo(&root).unwrap();
        set_identity(&root, "Teste", "teste@exemplo.com").unwrap();
        std::fs::create_dir_all(root.join("contextos/frota")).unwrap();
        std::fs::write(root.join("contextos/frota/context.md"), "semente").unwrap();

        ensure_baseline_commit(&root, Baseline::Seeded).unwrap();

        assert!(ref_exists(&root, "refs/heads/main"));
        let tracked = run_git(&root, &["ls-tree", "-r", "--name-only", "main"]);
        assert!(String::from_utf8_lossy(&tracked.stdout).contains("contextos/frota/context.md"));
        assert!(
            !is_dirty(&root),
            "the seeded project starts fully versioned"
        );
        // and running setup again on the same project changes nothing
        let before = rev_sha(&root, "HEAD");
        ensure_baseline_commit(&root, Baseline::Seeded).unwrap();
        assert_eq!(rev_sha(&root, "HEAD"), before);
        let _ = std::fs::remove_dir_all(&root);
    }

    // N3 — every version was authored by "Loro <loro@localhost>": command-line
    // `-c` wins over everything, so the identity the doctor's "corrigir" writes
    // was overridden and the timeline attributed the team's knowledge to a bot.
    #[test]
    fn a_version_is_authored_by_the_identity_the_doctor_sets() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("author");
        git_init_repo(&root).unwrap();
        set_identity(&root, "Daniela Lima", "daniela@exemplo.com.br").unwrap();
        std::fs::write(root.join("context.md"), "conhecimento").unwrap();

        stage_and_commit(&root, "primeira versão".into()).unwrap();

        let out = run_git(&root, &["log", "-1", "--format=%an <%ae>"]);
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            "Daniela Lima <daniela@exemplo.com.br>"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // N3 (second leg) — the sheet used to ship its own example ("seu@email") as
    // an editable VALUE and the only check here was non-empty, so the address
    // stamped on every version the team reads could be text that is not an
    // address. The refusal lives at the boundary: the doctor row would turn ✓ on
    // an identity GitHub can never attribute to anyone.
    #[test]
    fn set_identity_refuses_an_email_that_is_not_an_address() {
        for bad in [
            "seu@email",
            "seu@email.",
            "seu@.com",
            "ana",
            "@exemplo.com",
            "ana@",
            "ana@exemplo com.br",
            "Ana <ana@exemplo.com>",
            "ana@a@exemplo.com",
        ] {
            assert!(!is_email_shaped(bad), "{bad} is not an e-mail address");
        }
        for good in [
            "ana@exemplo.com",
            "ana.souza@exemplo.com.br",
            "ana+frota@exemplo.com",
        ] {
            assert!(is_email_shaped(good), "{good} is an e-mail address");
        }
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("identity-email");
        git_init_repo(&root).unwrap();
        assert_eq!(
            set_identity(&root, "Ana", "seu@email").unwrap_err(),
            "err.git_identity_invalid_email"
        );
        // and nothing was written: a refused identity leaves the repo as it was
        // (scoped to --local; the machine's global identity is not ours to read)
        let local = |root: &Path| {
            let out = run_git(root, &["config", "--local", "user.email"]);
            out.status
                .success()
                .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        };
        assert_eq!(local(&root), None);
        set_identity(&root, "Ana", "ana@exemplo.com").unwrap();
        assert_eq!(local(&root).as_deref(), Some("ana@exemplo.com"));
        let _ = std::fs::remove_dir_all(&root);
    }

    // N3 — the fallback still exists for a machine with no git identity, and it
    // never covers a half the user did define.
    #[test]
    fn only_the_identity_git_cannot_resolve_falls_back() {
        assert_eq!(
            identity_args(None, None),
            vec!["-c", "user.name=Loro", "-c", "user.email=loro@localhost"]
        );
        assert!(identity_args(Some("Daniela"), Some("d@exemplo.com.br")).is_empty());
        assert_eq!(
            identity_args(Some("Daniela"), None),
            vec!["-c", "user.email=loro@localhost"]
        );
        assert_eq!(
            identity_args(None, Some("d@exemplo.com.br")),
            vec!["-c", "user.name=Loro"]
        );
    }

    #[test]
    fn list_branches_returns_locals() {
        if which("git").is_none() {
            return; // git is a system dependency; skip when absent
        }
        let root = temp_repo("branches");
        init_with_commit(&root);
        create_branch(&root, "primeira").unwrap();
        create_branch(&root, "segunda").unwrap();

        let branches = list_branches(&root).unwrap();
        for expected in ["main", "rfc/primeira", "rfc/segunda"] {
            assert!(
                branches.iter().any(|b| b == expected),
                "missing branch {expected} in {branches:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn switch_branch_blocks_on_dirty_working_tree() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("switch-dirty");
        init_with_commit(&root);
        create_branch(&root, "mudanca").unwrap();
        std::fs::write(root.join("context.md"), "edição pendente").unwrap();

        let err = switch_branch(&root, "main").unwrap_err();
        assert_eq!(err, "err.working_tree_dirty");
        assert_eq!(current_branch(&root).as_deref(), Some("rfc/mudanca"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn switch_branch_errors_on_missing_branch() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("switch-missing");
        init_with_commit(&root);

        let err = switch_branch(&root, "nao-existe").unwrap_err();
        assert_eq!(err, "err.branch_not_found");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sync_default_without_remote_returns_no_remote() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("sync-noremote");
        init_with_commit(&root);

        assert_eq!(sync_default_branch(&root), SyncOutcome::NoRemote);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sync_default_fast_forwards_from_origin() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("sync-ff");
        let bare = root.join("origin.git");
        std::fs::create_dir_all(&bare).unwrap();
        run_git(&bare, &["init", "--bare", "--initial-branch=main"]);

        let a = root.join("a");
        std::fs::create_dir_all(&a).unwrap();
        init_with_commit(&a);
        run_git(&a, &["remote", "add", "origin", bare.to_str().unwrap()]);
        assert!(run_git(&a, &["push", "-u", "origin", "main"])
            .status
            .success());

        let c = root.join("c");
        assert!(run_git(
            &root,
            &["clone", bare.to_str().unwrap(), c.to_str().unwrap()]
        )
        .status
        .success());
        set_identity(&c, "Teste", "teste@exemplo.com").unwrap();

        // origin moves ahead; the local clone is behind
        std::fs::write(a.join("context.md"), "avanço").unwrap();
        stage_and_commit(&a, "feat: avanço".into()).unwrap();
        assert!(run_git(&a, &["push", "origin", "main"]).status.success());

        assert_eq!(sync_default_branch(&c), SyncOutcome::Updated);
        assert_eq!(rev_sha(&c, "main"), rev_sha(&c, "origin/main"));
        assert_eq!(sync_default_branch(&c), SyncOutcome::AlreadyUpToDate);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sync_default_reports_diverged_and_keeps_local_main() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("sync-div");
        let bare = root.join("origin.git");
        std::fs::create_dir_all(&bare).unwrap();
        run_git(&bare, &["init", "--bare", "--initial-branch=main"]);

        let a = root.join("a");
        std::fs::create_dir_all(&a).unwrap();
        init_with_commit(&a);
        run_git(&a, &["remote", "add", "origin", bare.to_str().unwrap()]);
        assert!(run_git(&a, &["push", "-u", "origin", "main"])
            .status
            .success());

        let c = root.join("c");
        assert!(run_git(
            &root,
            &["clone", bare.to_str().unwrap(), c.to_str().unwrap()]
        )
        .status
        .success());
        set_identity(&c, "Teste", "teste@exemplo.com").unwrap();

        // both sides commit: origin and local main diverge
        std::fs::write(c.join("context.md"), "local próprio").unwrap();
        stage_and_commit(&c, "local".into()).unwrap();
        let local_sha = rev_sha(&c, "main");
        std::fs::write(a.join("context.md"), "remoto").unwrap();
        stage_and_commit(&a, "remoto".into()).unwrap();
        assert!(run_git(&a, &["push", "origin", "main"]).status.success());

        assert_eq!(sync_default_branch(&c), SyncOutcome::Diverged);
        // the local default branch is never rewritten outside fast-forward
        assert_eq!(rev_sha(&c, "main"), local_sha);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sync_offline_degrades() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("sync-offline");
        init_with_commit(&root);
        run_git(
            &root,
            &["remote", "add", "origin", "/loro-nonexistent-remote.git"],
        );

        assert_eq!(sync_default_branch(&root), SyncOutcome::Offline);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn local_default_branch_prefers_origin_head_then_main() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("default-branch");
        init_with_commit(&root);

        // (b) no origin/HEAD → local main wins
        assert_eq!(local_default_branch(&root), "main");

        // (a) origin/HEAD, when present, wins over local heads
        run_git(
            &root,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/develop",
            ],
        );
        assert_eq!(local_default_branch(&root), "develop");
        run_git(
            &root,
            &["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"],
        );

        // (c) master when there is no main
        run_git(&root, &["branch", "-M", "master"]);
        assert_eq!(local_default_branch(&root), "master");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn version_never_commits_on_default() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("ver-default");
        init_with_commit(&root);
        let main_sha = rev_sha(&root, "main");

        create_branch(&root, "proposta").unwrap();
        std::fs::write(root.join("context.md"), "mudança").unwrap();
        stage_and_commit(&root, "feat: mudança".into()).unwrap();

        assert_eq!(current_branch(&root).as_deref(), Some("rfc/proposta"));
        assert_eq!(rev_sha(&root, "main"), main_sha, "main never moves");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn version_creates_rfc_branch_and_preserves_main() {
        if which("git").is_none() {
            return; // git is a system dependency; skip when absent
        }
        let root = std::env::temp_dir().join(format!("loro-ver-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        git_init_repo(&root).unwrap();
        set_identity(&root, "Teste", "teste@exemplo.com").unwrap();
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

        // the main branch still exists (all work branches off it)
        let kept = crate::proc::command("git")
            .args(["rev-parse", "--verify", &orig])
            .current_dir(&root)
            .output()
            .unwrap()
            .status
            .success();
        assert!(kept);
        let _ = std::fs::remove_dir_all(&root);
    }

    // N2 — a project whose versioning started AFTER setup has an empty default
    // branch (Baseline::Empty commits nothing), so every document lives on the
    // draft. Switching to the branch the picker labels "(principal)" therefore
    // takes the whole project off the disk. Git keeps it safe on the draft
    // commit; the SCREEN went empty with no warning and no way back stated.
    // The UI can only state that price if the backend counts it.
    #[test]
    fn the_default_branch_of_a_draft_only_project_holds_no_documents() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("docs-empty-main");
        std::fs::create_dir_all(root.join("contextos/frota")).unwrap();
        std::fs::create_dir_all(root.join(".github/workflows")).unwrap();
        std::fs::write(root.join("contextos/frota/context.md"), "conhecimento").unwrap();
        std::fs::write(root.join("INDEX.md"), "índice").unwrap();
        std::fs::write(root.join(".github/workflows/ci.yml"), "on: push").unwrap();
        git_init_repo(&root).unwrap();
        set_identity(&root, "Teste", "teste@exemplo.com").unwrap();

        // exactly what "começar a guardar versões" runs on a repo-less project
        create_branch(&root, "primeira-versao").unwrap();
        stage_and_commit(&root, "primeira versão".into()).unwrap();
        let default = local_default_branch(&root);

        assert_eq!(
            documents_on(&root, &default),
            0,
            "the baseline commits nothing: the branch called (principal) is an empty room"
        );
        assert_eq!(
            documents_on(&root, "rfc/primeira-versao"),
            2,
            "the draft holds the documents; machine folders (.github/) are not documents"
        );
        assert_eq!(
            documents_leaving(&root, "rfc/primeira-versao", &default),
            2,
            "switching to (principal) takes both documents off the screen"
        );
        assert_eq!(
            documents_leaving(&root, &default, "rfc/primeira-versao"),
            0,
            "going back to the draft costs nothing"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // The seeded baseline is the same defect with a smaller blast radius: only
    // the documents created after setup leave the screen.
    #[test]
    fn a_seeded_default_branch_only_loses_what_the_draft_added() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("docs-seeded-main");
        init_with_commit(&root); // context.md committed on main
        create_branch(&root, "frota").unwrap();
        std::fs::write(root.join("nota-nova.md"), "documento novo").unwrap();
        stage_and_commit(&root, "nova nota".into()).unwrap();

        assert_eq!(documents_on(&root, "main"), 1);
        assert_eq!(documents_on(&root, "rfc/frota"), 2);
        assert_eq!(documents_leaving(&root, "rfc/frota", "main"), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    // N3 — the app said "versão salva" over a commit that never happened, and
    // the attempt still created (and switched to) an empty draft on the way.
    // Nothing pending is not a version: the flow refuses BEFORE it changes
    // anything, and reports the refusal as a fact.
    #[test]
    fn saving_a_version_with_nothing_pending_saves_nothing_and_says_so() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("version-noop");
        init_with_commit(&root);
        create_branch(&root, "politica-de-frota").unwrap();
        std::fs::write(root.join("frota.md"), "conhecimento").unwrap();
        let first = save_version(&root, "politica-de-frota", "política de frota".into()).unwrap();
        assert!(
            first.saved,
            "the first version had a pending change to carry"
        );
        assert_eq!(
            pending_changes(&root),
            0,
            "the tree is clean after a version"
        );

        let branches_before = list_branches(&root).unwrap();
        let head_before = rev_sha(&root, "HEAD");

        let again = save_version(&root, "reviso-a-politica", "reviso a política".into()).unwrap();

        assert!(
            !again.saved,
            "there was nothing to version — the app must not be told a version was saved"
        );
        assert_eq!(
            list_branches(&root).unwrap(),
            branches_before,
            "a no-op created an empty draft as a side effect the sheet never mentions"
        );
        assert_eq!(
            current_branch(&root).unwrap(),
            "rfc/politica-de-frota",
            "a no-op moved the user onto another draft"
        );
        assert_eq!(rev_sha(&root, "HEAD"), head_before, "nothing was committed");
        let _ = std::fs::remove_dir_all(&root);
    }

    // The other half of the same rule: a real pending change still versions.
    #[test]
    fn saving_a_version_with_a_pending_change_commits_it() {
        if which("git").is_none() {
            return;
        }
        let root = temp_repo("version-real");
        init_with_commit(&root);
        std::fs::write(root.join("frota.md"), "conhecimento").unwrap();
        assert!(pending_changes(&root) > 0);

        let out = save_version(&root, "politica-de-frota", "política de frota".into()).unwrap();

        assert!(out.saved);
        assert_eq!(out.branch, "rfc/politica-de-frota");
        assert_eq!(pending_changes(&root), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    // N6 — the doctor could not tell "no repository connected" from "this
    // machine has no network right now", so five minutes offline switched the
    // team flow off and blamed the user's setup.
    #[test]
    fn a_transport_failure_is_offline_not_a_missing_repository() {
        assert!(looks_offline(
            "dial tcp: lookup api.github.com: no such host"
        ));
        assert!(looks_offline("Get \"https://api.github.com\": i/o timeout"));
        assert!(looks_offline("connection refused"));
        assert!(
            !looks_offline("GraphQL: Could not resolve to a Repository with the name 'x/y'."),
            "an answer FROM GitHub is an access problem, not a network one"
        );
        assert!(!looks_offline("HTTP 404: Not Found"));
    }
}
