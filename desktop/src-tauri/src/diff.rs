// Unified-diff parsing. PURE: no filesystem, no process, no framework — the
// domain does not know Tauri (CLAUDE.md §4), so every rule below is testable
// without git installed.
//
// The SAME parser serves the working tree (`brain_git_diff`) and a pull request
// (`gh_pr_diff`), so one change never gets two renderings. Line numbers are
// computed HERE, not in JS, for the same reason: an off-by-one has one home and
// one test.
//
// BR-8: nothing in this module logs. A diff row is knowledge content; it travels
// to the screen and nowhere else.

#[derive(serde::Serialize, PartialEq, Eq, Debug, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Added,
    Modified,
    Removed,
    Renamed,
}

#[derive(serde::Serialize, PartialEq, Eq, Debug, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum RowKind {
    Context,
    Add,
    Del,
}

// One diff line. `text` has the leading `+`/`-`/space marker STRIPPED — the
// marker IS `kind`, so the screen styles a row by class and never re-parses a
// diff line to find out what it is.
#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub kind: RowKind,
    pub old_line: Option<usize>,
    pub new_line: Option<usize>,
    pub text: String,
}

// The gap the screen draws between two hunks is derivable —
// `hunks[i+1].new_start - (hunks[i].new_start + hunks[i].new_lines)` — so it is
// not a field.
#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub rows: Vec<Row>,
}

#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub kind: ChangeKind,
    pub additions: usize,
    pub deletions: usize,
    // "not rendered as text": a real binary, or a file past the read ceiling.
    // The card says so instead of drawing an empty diff.
    pub binary: bool,
    pub hunks: Vec<Hunk>,
}

impl FileDiff {
    fn new(path: String) -> Self {
        FileDiff {
            path,
            old_path: None,
            kind: ChangeKind::Modified,
            additions: 0,
            deletions: 0,
            binary: false,
            hunks: Vec::new(),
        }
    }
}

// A file git never saw. Rendered as one all-add hunk, which is why
// `brain_git_diff` needs no `git add -N`: a read command that mutates the index
// is not a read command.
pub fn added_file(path: &str, content: &str) -> FileDiff {
    let mut f = FileDiff::new(path.to_string());
    f.kind = ChangeKind::Added;
    let lines = split_lines(content);
    if lines.is_empty() {
        return f;
    }
    let rows: Vec<Row> = lines
        .iter()
        .enumerate()
        .map(|(i, l)| Row {
            kind: RowKind::Add,
            old_line: None,
            new_line: Some(i + 1),
            text: (*l).to_string(),
        })
        .collect();
    f.additions = rows.len();
    f.hunks.push(Hunk {
        old_start: 0,
        old_lines: 0,
        new_start: 1,
        new_lines: rows.len(),
        rows,
    });
    f
}

// A new file the screen cannot draw as text: a real binary, or one past the
// read ceiling. The card says so instead of drawing an empty diff (F2).
pub fn binary_added(path: &str) -> FileDiff {
    let mut f = FileDiff::new(path.to_string());
    f.kind = ChangeKind::Added;
    f.binary = true;
    f
}

// A file with no text rendering. One NUL byte in the first 8 KiB is the same
// heuristic git uses, and it bounds how much of a large file is ever read.
pub fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
}

fn split_lines(content: &str) -> Vec<&str> {
    let mut v: Vec<&str> = content.split('\n').collect();
    // a trailing newline is a terminator, not an extra empty line
    if v.last() == Some(&"") && v.len() > 1 {
        v.pop();
    }
    if v == [""] {
        v.clear();
    }
    v
}

// ---- the parser -------------------------------------------------------------

pub fn parse_unified_diff(patch: &str) -> Vec<FileDiff> {
    let mut out: Vec<FileDiff> = Vec::new();
    let mut cur: Option<FileDiff> = None;
    let mut minus_path: Option<String> = None;
    let mut old_no = 0usize;
    let mut new_no = 0usize;
    let mut left_old = 0usize;
    let mut left_new = 0usize;

    for line in patch.lines() {
        // While a hunk still owes rows, EVERY line is a row: git's own markers
        // are legitimate file content (a knowledge document may hold a line
        // that reads "--- ", and a diff of a diff holds "@@").
        if left_old + left_new > 0 {
            if line.starts_with('\\') {
                continue; // "\ No newline at end of file" is never a row
            }
            let marker = line.as_bytes().first().copied();
            let row = match marker {
                Some(b'+') => Some((RowKind::Add, &line[1..])),
                Some(b'-') => Some((RowKind::Del, &line[1..])),
                Some(b' ') => Some((RowKind::Context, &line[1..])),
                // git writes an empty context line as " "; a stripped patch
                // writes it as "". Both are the same empty line.
                None => Some((RowKind::Context, "")),
                _ => None,
            };
            if let Some((kind, text)) = row {
                if let Some(f) = cur.as_mut() {
                    let (o, n) = match kind {
                        RowKind::Context => {
                            old_no += 1;
                            new_no += 1;
                            left_old = left_old.saturating_sub(1);
                            left_new = left_new.saturating_sub(1);
                            (Some(old_no), Some(new_no))
                        }
                        RowKind::Add => {
                            new_no += 1;
                            left_new = left_new.saturating_sub(1);
                            f.additions += 1;
                            (None, Some(new_no))
                        }
                        RowKind::Del => {
                            old_no += 1;
                            left_old = left_old.saturating_sub(1);
                            f.deletions += 1;
                            (Some(old_no), None)
                        }
                    };
                    if let Some(h) = f.hunks.last_mut() {
                        h.rows.push(Row {
                            kind,
                            old_line: o,
                            new_line: n,
                            text: text.to_string(),
                        });
                    }
                }
                continue;
            }
            // Malformed or truncated hunk: stop owing rows and read this line
            // as a header instead of swallowing the rest of the patch.
            left_old = 0;
            left_new = 0;
        }

        if let Some(rest) = line.strip_prefix("diff --git ") {
            if let Some(f) = cur.take() {
                out.push(f);
            }
            let (_, new) = header_paths(rest);
            minus_path = None;
            cur = Some(FileDiff::new(new));
            continue;
        }
        let Some(f) = cur.as_mut() else { continue };

        if line.starts_with("new file mode") {
            f.kind = ChangeKind::Added;
        } else if line.starts_with("deleted file mode") {
            f.kind = ChangeKind::Removed;
        } else if let Some(p) = line.strip_prefix("rename from ") {
            f.old_path = Some(unquote_path(p));
            f.kind = ChangeKind::Renamed;
        } else if let Some(p) = line.strip_prefix("rename to ") {
            f.path = unquote_path(p);
            f.kind = ChangeKind::Renamed;
        } else if line.starts_with("Binary files") || line.starts_with("GIT binary patch") {
            // The verdict wins over anything already read for this file: a card
            // that says the lines of this file cannot be shown must not also
            // carry rows and line counts (DESIGN.md §1 — state never lies).
            f.binary = true;
            f.hunks.clear();
            f.additions = 0;
            f.deletions = 0;
        } else if let Some(p) = line.strip_prefix("--- ") {
            if p.trim() != "/dev/null" {
                minus_path = Some(strip_side_prefix(p));
            }
        } else if let Some(p) = line.strip_prefix("+++ ") {
            if p.trim() != "/dev/null" {
                f.path = strip_side_prefix(p);
            } else if let Some(m) = minus_path.clone() {
                f.path = m;
            }
        } else if let Some(h) = parse_hunk_header(line) {
            old_no = h.old_start.saturating_sub(1);
            new_no = h.new_start.saturating_sub(1);
            left_old = h.old_lines;
            left_new = h.new_lines;
            f.hunks.push(h);
        }
    }
    if let Some(f) = cur.take() {
        out.push(f);
    }
    out
}

// "@@ -a,b +c,d @@ optional heading". A missing count means 1.
fn parse_hunk_header(line: &str) -> Option<Hunk> {
    let rest = line.strip_prefix("@@ ")?;
    let end = rest.find(" @@")?;
    let ranges = &rest[..end];
    let mut it = ranges.split_whitespace();
    let (old_start, old_lines) = parse_range(it.next()?.strip_prefix('-')?)?;
    let (new_start, new_lines) = parse_range(it.next()?.strip_prefix('+')?)?;
    Some(Hunk {
        old_start,
        old_lines,
        new_start,
        new_lines,
        rows: Vec::new(),
    })
}

fn parse_range(s: &str) -> Option<(usize, usize)> {
    match s.split_once(',') {
        Some((a, b)) => Some((a.parse().ok()?, b.parse().ok()?)),
        None => Some((s.parse().ok()?, 1)),
    }
}

// The `a/`…`b/` pair of a `diff --git` header. Only a fallback: `+++`/`---` and
// `rename to` are authoritative when present, and they always are for anything
// with hunks. This is what carries the path of a binary or a pure rename.
fn header_paths(rest: &str) -> (String, String) {
    let s = rest.trim();
    if s.starts_with('"') {
        if let Some((a, b)) = split_quoted_pair(s) {
            return (strip_side_prefix(&a), strip_side_prefix(&b));
        }
    }
    // The same name on both sides is the common case and the only split that
    // stays unambiguous when the name holds a space (git does not quote one).
    if s.len() > 5 && (s.len() - 5).is_multiple_of(2) && s.starts_with("a/") {
        let n = (s.len() - 5) / 2;
        let cut = 2 + n;
        if s.is_char_boundary(cut) && s.is_char_boundary(cut + 1) {
            let (a, b) = s.split_at(cut);
            if b.starts_with(" b/") && a[2..] == b[3..] {
                let name = a[2..].to_string();
                return (name.clone(), name);
            }
        }
    }
    if let Some(pos) = s.find(" b/") {
        return (
            strip_side_prefix(&s[..pos]),
            strip_side_prefix(&s[pos + 1..]),
        );
    }
    (String::new(), String::new())
}

fn split_quoted_pair(s: &str) -> Option<(String, String)> {
    let b = s.as_bytes();
    let mut i = 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'"' => break,
            _ => i += 1,
        }
    }
    if i >= b.len() {
        return None;
    }
    let first = s.get(..=i)?.to_string();
    let rest = s.get(i + 1..)?.trim_start();
    Some((first, rest.to_string()))
}

// Drop git's `a/`/`b/` side prefix, after undoing any C-quoting.
fn strip_side_prefix(p: &str) -> String {
    let p = unquote_path(p);
    for pre in ["a/", "b/"] {
        if let Some(r) = p.strip_prefix(pre) {
            return r.to_string();
        }
    }
    p
}

// git C-quotes a path that holds a quote, a backslash or a control character —
// and, unless `core.quotePath=false`, every non-ASCII byte too:
// `"contexts/pol\303\255tica.md"`. Belt AND braces: the caller passes
// `-c core.quotePath=false`, and a pt-BR acervo has accented filenames, so this
// is not a corner case here.
fn unquote_path(s: &str) -> String {
    let t = s.trim();
    if t.len() < 2 || !t.starts_with('"') || !t.ends_with('"') {
        return t.to_string();
    }
    let inner = &t.as_bytes()[1..t.len() - 1];
    let mut out: Vec<u8> = Vec::with_capacity(inner.len());
    let mut i = 0;
    while i < inner.len() {
        if inner[i] != b'\\' || i + 1 >= inner.len() {
            out.push(inner[i]);
            i += 1;
            continue;
        }
        match inner[i + 1] {
            b'n' => {
                out.push(b'\n');
                i += 2;
            }
            b't' => {
                out.push(b'\t');
                i += 2;
            }
            b'r' => {
                out.push(b'\r');
                i += 2;
            }
            c @ (b'0'..=b'7') if i + 4 <= inner.len() => {
                match std::str::from_utf8(&inner[i + 1..i + 4])
                    .ok()
                    .and_then(|o| u8::from_str_radix(o, 8).ok())
                {
                    Some(v) => {
                        out.push(v);
                        i += 4;
                    }
                    None => {
                        out.push(c);
                        i += 2;
                    }
                }
            }
            c => {
                out.push(c);
                i += 2;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Patches are built from line arrays on purpose: a Rust string continuation
    // (`\` at end of line) eats the next line's leading whitespace, which is
    // exactly the space that marks a diff's context row.
    fn patch(lines: &[&str]) -> String {
        lines.join("\n") + "\n"
    }

    // Two hunks over one file: every row has to know where it sits on BOTH
    // sides, or the screen cannot cite a line and the collapsed gap between
    // hunks lands in the wrong place.
    #[test]
    fn parse_unified_diff_numbers_every_row() {
        let p = patch(&[
            "diff --git a/contexts/frota/context.md b/contexts/frota/context.md",
            "index 1111111..2222222 100644",
            "--- a/contexts/frota/context.md",
            "+++ b/contexts/frota/context.md",
            "@@ -1,4 +1,5 @@",
            " # Frota",
            "-prazo de 5 dias",
            "+prazo de 3 dias",
            "+aprovacao do gestor",
            " ",
            " ## Regras",
            "@@ -20,3 +21,3 @@",
            " antes",
            "-linha velha",
            "+linha nova",
        ]);
        let files = parse_unified_diff(&p);
        assert_eq!(files.len(), 1);
        let f = &files[0];
        assert_eq!(f.path, "contexts/frota/context.md");
        assert_eq!(f.kind, ChangeKind::Modified);
        assert_eq!(f.additions, 3);
        assert_eq!(f.deletions, 2);
        assert!(!f.binary);
        assert_eq!(f.hunks.len(), 2);

        let h = &f.hunks[0];
        assert_eq!(
            (h.old_start, h.old_lines, h.new_start, h.new_lines),
            (1, 4, 1, 5)
        );
        assert_eq!(h.rows.len(), 6);
        // context: both sides advance
        assert_eq!(h.rows[0].kind, RowKind::Context);
        assert_eq!((h.rows[0].old_line, h.rows[0].new_line), (Some(1), Some(1)));
        assert_eq!(h.rows[0].text, "# Frota");
        // a removal exists only on the old side, and the marker is stripped
        assert_eq!(h.rows[1].kind, RowKind::Del);
        assert_eq!((h.rows[1].old_line, h.rows[1].new_line), (Some(2), None));
        assert_eq!(h.rows[1].text, "prazo de 5 dias");
        // additions exist only on the new side, and they keep counting
        assert_eq!((h.rows[2].old_line, h.rows[2].new_line), (None, Some(2)));
        assert_eq!((h.rows[3].old_line, h.rows[3].new_line), (None, Some(3)));
        // the context after two adds resumes on both sides
        assert_eq!((h.rows[4].old_line, h.rows[4].new_line), (Some(3), Some(4)));
        assert_eq!(h.rows[4].text, "", "an empty context line stays a row");

        // the second hunk restarts from its own header, not from the first
        let h2 = &f.hunks[1];
        assert_eq!(h2.rows[0].new_line, Some(21));
        assert_eq!(h2.rows[1].old_line, Some(21));
        assert_eq!(h2.rows[2].new_line, Some(22));
        // the collapsed gap the screen draws is derivable, so it is not a field
        assert_eq!(h2.new_start - (h.new_start + h.new_lines), 15);
    }

    // One patch carrying the three shapes a knowledge change actually takes.
    #[test]
    fn parse_unified_diff_reads_added_removed_and_renamed() {
        let p = patch(&[
            "diff --git a/contexts/frota/nova.md b/contexts/frota/nova.md",
            "new file mode 100644",
            "index 0000000..3333333",
            "--- /dev/null",
            "+++ b/contexts/frota/nova.md",
            "@@ -0,0 +1,2 @@",
            "+primeira",
            "+segunda",
            "\\ No newline at end of file",
            "diff --git a/contexts/frota/velha.md b/contexts/frota/velha.md",
            "deleted file mode 100644",
            "index 4444444..0000000",
            "--- a/contexts/frota/velha.md",
            "+++ /dev/null",
            "@@ -1,2 +0,0 @@",
            "-uma",
            "-duas",
            "diff --git a/contexts/frota/antigo.md b/contexts/frota/novo.md",
            "similarity index 92%",
            "rename from contexts/frota/antigo.md",
            "rename to contexts/frota/novo.md",
            "index 5555555..6666666 100644",
            "--- a/contexts/frota/antigo.md",
            "+++ b/contexts/frota/novo.md",
            "@@ -1,2 +1,2 @@",
            " titulo",
            "-corpo velho",
            "+corpo novo",
        ]);
        let files = parse_unified_diff(&p);
        assert_eq!(files.len(), 3);

        let novo = &files[0];
        assert_eq!(novo.kind, ChangeKind::Added);
        assert_eq!(novo.path, "contexts/frota/nova.md");
        assert_eq!(novo.additions, 2);
        assert_eq!(novo.deletions, 0);
        assert_eq!(
            novo.hunks[0].rows.len(),
            2,
            "a marker AFTER the hunk closed is neither a row nor a new file"
        );

        let velha = &files[1];
        assert_eq!(velha.kind, ChangeKind::Removed);
        assert_eq!(
            velha.path, "contexts/frota/velha.md",
            "a removed file takes its path from the --- side"
        );
        assert_eq!(velha.deletions, 2);
        assert_eq!(velha.hunks[0].rows[0].new_line, None);

        let renamed = &files[2];
        assert_eq!(renamed.kind, ChangeKind::Renamed);
        assert_eq!(renamed.path, "contexts/frota/novo.md");
        assert_eq!(
            renamed.old_path.as_deref(),
            Some("contexts/frota/antigo.md"),
            "a rename has to say where the document came from"
        );
        assert_eq!(renamed.additions, 1);
    }

    // Where git ACTUALLY writes "\ No newline at end of file": mid-hunk, while
    // the hunk still owes rows — a replacement of the last line of a file with no
    // trailing newline. Reading the marker as anything but a skip does not lose
    // the marker: it loses the `+` line that FOLLOWS it, so the change renders as
    // a deletion with nothing replacing it and a line of knowledge disappears
    // from the screen. The row count alone cannot see that, which is why the
    // added line is asserted BY NUMBER and by text.
    #[test]
    fn the_no_newline_marker_never_eats_the_line_it_annotates() {
        let p = patch(&[
            "diff --git a/contexts/frota/context.md b/contexts/frota/context.md",
            "--- a/contexts/frota/context.md",
            "+++ b/contexts/frota/context.md",
            "@@ -1,2 +1,2 @@",
            " uma",
            "-duas",
            "\\ No newline at end of file",
            "+duas!",
            "\\ No newline at end of file",
        ]);
        let files = parse_unified_diff(&p);
        assert_eq!(files.len(), 1, "the marker was read as another file");
        let f = &files[0];
        assert_eq!(f.deletions, 1);
        assert_eq!(
            f.additions, 1,
            "the replacement line vanished: the change reads as a pure deletion"
        );
        let rows = &f.hunks[0].rows;
        assert_eq!(
            rows.len(),
            3,
            "\"\\ No newline at end of file\" is never a row"
        );
        assert_eq!(rows[2].kind, RowKind::Add);
        assert_eq!(rows[2].text, "duas!");
        assert_eq!(
            (rows[2].old_line, rows[2].new_line),
            (None, Some(2)),
            "the added last line has to keep the number the screen cites"
        );
    }

    // F2's failure path: a binary file says so instead of drawing an empty diff.
    #[test]
    fn parse_unified_diff_marks_a_binary_file() {
        let p = patch(&[
            "diff --git a/contexts/frota/foto.png b/contexts/frota/foto.png",
            "index 7777777..8888888 100644",
            "Binary files a/contexts/frota/foto.png and b/contexts/frota/foto.png differ",
        ]);
        let files = parse_unified_diff(&p);
        assert_eq!(files.len(), 1);
        assert!(files[0].binary);
        assert!(files[0].hunks.is_empty());
        assert_eq!(files[0].path, "contexts/frota/foto.png");
        assert_eq!(files[0].additions, 0);

        // and a NUL byte in the first 8 KiB is what makes a file binary
        assert!(is_binary(b"RIFF\0\0\0\0WAVE"));
        assert!(!is_binary("conhecimento em pt-BR com acento".as_bytes()));
    }

    // The binary verdict arrives AFTER a hunk when the patch is not a clean `git
    // diff` of one file: `gh pr diff` is bytes over the network, and a read cut
    // by the ceiling ends wherever it ends. `binary` is what the screen uses to
    // decide it cannot draw the change, so the verdict has to win completely —
    // rows AND counts. A card that says «não dá para mostrar as linhas deste
    // arquivo» and still carries "+1 −1" is state that lies (DESIGN.md §1).
    #[test]
    fn a_binary_verdict_after_a_hunk_leaves_no_half_drawn_card() {
        let p = patch(&[
            "diff --git a/contexts/frota/mapa.svg b/contexts/frota/mapa.svg",
            "index 7777777..8888888 100644",
            "--- a/contexts/frota/mapa.svg",
            "+++ b/contexts/frota/mapa.svg",
            "@@ -1 +1 @@",
            "-<svg/>",
            "+<svg viewBox=\"0 0 2 2\"/>",
            "GIT binary patch",
            "delta 42",
            "zcmZ?wbhEHb",
        ]);
        let files = parse_unified_diff(&p);
        assert_eq!(files.len(), 1);
        let f = &files[0];
        assert!(f.binary);
        assert!(
            f.hunks.is_empty(),
            "rows survived the binary verdict: the card draws a diff it also says it cannot show"
        );
        assert_eq!(
            (f.additions, f.deletions),
            (0, 0),
            "the card counts lines it has no rows for"
        );
        assert_eq!(f.path, "contexts/frota/mapa.svg");
    }

    // A hunk row with NO marker at all. git writes an empty context line as a
    // lone space; a patch that travelled through a mailer, a copy-paste or an API
    // arrives with that trailing space stripped. Reading such a row as "not a
    // row" abandons the hunk mid-way, and every line of the change AFTER it
    // disappears from the screen with no word said — the worst shape of failure,
    // because the card still looks complete.
    #[test]
    fn a_context_row_stripped_of_its_marker_does_not_truncate_the_change() {
        let p = patch(&[
            "diff --git a/contexts/frota/context.md b/contexts/frota/context.md",
            "--- a/contexts/frota/context.md",
            "+++ b/contexts/frota/context.md",
            "@@ -1,4 +1,4 @@",
            " # Frota",
            "", // the empty context line, marker stripped
            "-prazo de 5 dias",
            "+prazo de 3 dias",
            " ## Regras",
        ]);
        let files = parse_unified_diff(&p);
        assert_eq!(files.len(), 1);
        let f = &files[0];
        assert_eq!(f.hunks.len(), 1);
        let rows = &f.hunks[0].rows;
        assert_eq!(rows.len(), 5, "the hunk was abandoned at the unmarked row");
        assert_eq!(rows[1].kind, RowKind::Context);
        assert_eq!(rows[1].text, "");
        assert_eq!((rows[1].old_line, rows[1].new_line), (Some(2), Some(2)));
        assert_eq!(
            rows[4].text, "## Regras",
            "the lines after the unmarked row left the screen"
        );
        assert_eq!((rows[4].old_line, rows[4].new_line), (Some(4), Some(4)));
        assert_eq!((f.additions, f.deletions), (1, 1));
    }

    // A pure rename carries no `---`/`+++` pair and no hunk, so `rename to` is
    // the only line that holds the new name — and git quotes ONE side of the
    // `diff --git` header when only that side needs it. Verified against git
    // itself: renaming `politica.md` to `política.md` (the pt-BR case) emits
    // `diff --git a/politica.md "b/pol\303\255tica.md"`, which has no ` b/` to
    // split on. Without the `rename to` line the card comes out with an empty
    // path: a row in «o que você mudou» that names no document.
    #[test]
    fn a_pure_rename_takes_its_new_name_from_the_rename_header() {
        let p = patch(&[
            r#"diff --git a/contexts/frota/politica.md "b/contexts/frota/pol\303\255tica.md""#,
            "similarity index 100%",
            "rename from contexts/frota/politica.md",
            r#"rename to "contexts/frota/pol\303\255tica.md""#,
        ]);
        let files = parse_unified_diff(&p);
        assert_eq!(files.len(), 1);
        let f = &files[0];
        assert_eq!(f.kind, ChangeKind::Renamed);
        assert_eq!(
            f.path, "contexts/frota/política.md",
            "the renamed document reached the screen with no name"
        );
        assert_eq!(
            f.old_path.as_deref(),
            Some("contexts/frota/politica.md"),
            "a rename has to say where the document came from"
        );
        assert!(f.hunks.is_empty());
        assert_eq!((f.additions, f.deletions), (0, 0));
    }

    // A pt-BR acervo has accented filenames; git quotes them octal-escaped.
    #[test]
    fn unquote_path_restores_an_accented_name() {
        assert_eq!(
            unquote_path(r#""contexts/pol\303\255tica.md""#),
            "contexts/política.md"
        );
        assert_eq!(unquote_path("contexts/frota.md"), "contexts/frota.md");
        assert_eq!(unquote_path(r#""com \"aspas\".md""#), "com \"aspas\".md");
        // and a quoted `diff --git` header still yields the path
        let p = patch(&[
            r#"diff --git "a/contexts/pol\303\255tica.md" "b/contexts/pol\303\255tica.md""#,
            "index 1111111..2222222 100644",
            "Binary files a/x and b/x differ",
        ]);
        assert_eq!(parse_unified_diff(&p)[0].path, "contexts/política.md");
    }

    // An untracked file has no patch at all: it is rendered as one all-add hunk,
    // which is why the read command never has to touch the index.
    #[test]
    fn added_file_is_one_hunk_of_adds() {
        let f = added_file("contexts/frota/nova.md", "uma\nduas\n");
        assert_eq!(f.kind, ChangeKind::Added);
        assert_eq!(f.deletions, 0);
        assert_eq!(f.additions, 2);
        assert_eq!(f.hunks.len(), 1);
        let h = &f.hunks[0];
        assert_eq!(
            (h.old_start, h.old_lines, h.new_start, h.new_lines),
            (0, 0, 1, 2)
        );
        assert_eq!(h.rows[0].new_line, Some(1));
        assert_eq!(h.rows[0].old_line, None);
        assert_eq!(h.rows[1].text, "duas");
        // an empty new file draws nothing rather than one phantom line
        assert!(added_file("vazio.md", "").hunks.is_empty());
    }

    // The screen styles a row by class; it never sniffs the first character.
    // That only holds if a document line that LOOKS like a diff marker stays
    // content instead of being read as a second file.
    #[test]
    fn a_document_line_that_looks_like_a_marker_stays_content() {
        let p = patch(&[
            "diff --git a/nota.md b/nota.md",
            "--- a/nota.md",
            "+++ b/nota.md",
            "@@ -1,3 +1,3 @@",
            " --- separador",
            "-@@ nao e um cabecalho",
            "+diff --git nao e um arquivo",
        ]);
        let files = parse_unified_diff(&p);
        assert_eq!(files.len(), 1, "content was read as a second file");
        let rows = &files[0].hunks[0].rows;
        assert_eq!(rows[0].text, "--- separador");
        assert_eq!(rows[1].text, "@@ nao e um cabecalho");
        assert_eq!(rows[2].text, "diff --git nao e um arquivo");
    }

    // The IPC shape the screen reads is pinned here, not remembered: the marker
    // never rides along in `text`, and the kinds are the lowercase words the
    // sidebar's existing status idiom already uses.
    #[test]
    fn the_serialized_shape_is_the_one_the_screen_reads() {
        let p = patch(&[
            "diff --git a/a.md b/a.md",
            "--- a/a.md",
            "+++ b/a.md",
            "@@ -1 +1 @@",
            "-velho",
            "+novo",
        ]);
        let json = serde_json::to_string(&parse_unified_diff(&p)).unwrap();
        assert!(json.contains(r#""kind":"modified""#));
        assert!(json.contains(r#""oldPath":null"#));
        assert!(json.contains(r#""kind":"del""#));
        assert!(json.contains(r#""kind":"add""#));
        assert!(json.contains(r#""oldLine":1"#));
        assert!(json.contains(r#""newLine":1"#));
        assert!(json.contains(r#""binary":false"#));
    }
}
