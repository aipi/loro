// Loro — pure, dependency-free helpers for the meeting workspace (ADR-0010).
// Isolated/testable module: loaded in the browser via <script> (defines
// window.LoroMeeting) and in Node via require() for `node --test`. No DOM, no
// Tauri — every function is a pure string transform so the meeting lifecycle
// wiring in app.js stays thin and the parsing/joining logic is unit-covered.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroMeeting = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  // A meeting home is brainstorming/<slug>/reunioes/<id>/ (ADR-0013) where <id>
  // is [a-z0-9-] (validated in meeting.rs); the legacy pessoal/temas/<slug>/…
  // home is still recognized for un-migrated acervos. The living notebook is
  // reuniao.md and the built report is relatorio.md — both under the gitignore
  // quarantine (never versioned).
  const HOME = "(?:brainstorming\\/[^/]+|pessoal\\/temas\\/[^/]+)\\/reunioes";
  const LIVING_RE = new RegExp("^" + HOME + "\\/([a-z0-9-]+)\\/reuniao\\.md$");
  const REPORT_RE = new RegExp("^" + HOME + "\\/([a-z0-9-]+)\\/relatorio\\.md$");
  const DIR_RE = new RegExp("^(" + HOME + "\\/[a-z0-9-]+)\\/(?:reuniao|relatorio)\\.md$");

  // The stable append marker meeting.rs writes into the living file; the reader
  // must strip it so the transcript surface never shows the raw comment.
  const MARKER = "<!-- loro:transcricao -->";

  function livingId(rel) {
    const m = LIVING_RE.exec(String(rel == null ? "" : rel));
    return m ? m[1] : null;
  }
  function reportId(rel) {
    const m = REPORT_RE.exec(String(rel == null ? "" : rel));
    return m ? m[1] : null;
  }
  function isLiving(rel) { return livingId(rel) != null; }
  function isReport(rel) { return reportId(rel) != null; }

  // Derive the acervo-relative meeting directory from a living/report path. The
  // meeting AI skills (ADR-0012) take this dir as $ARGUMENTS, and the embedded
  // terminal runs with the acervo root as cwd, so acervo-relative is exactly
  // what the slash command needs.
  function meetingDir(rel) {
    const m = DIR_RE.exec(String(rel == null ? "" : rel));
    return m ? m[1] : null;
  }

  // Collapse a free-text argument into a single PTY line: the terminal submits
  // on newline, so any CR/LF/tab would run the command early. We flatten every
  // whitespace run (\s covers \r \n \t) to one space and trim. Only the user's
  // typed question is passed here — never transcript text (BR-8).
  function sanitizeSkillArg(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  }

  // Build the exact slash-command string the app injects into the terminal
  // Claude (ADR-0012): analyse -> "/brain-analyse <dir>"; answer ->
  // "/brain-answer <dir> <question>". Command names use hyphens (a dot is not a
  // valid Claude Code command name); they must match the files materialised by
  // templates.rs (.claude/commands/brain-analyse.md, brain-answer.md). Returns
  // null when the dir is missing, or (for answer) when the question is empty
  // after sanitising, so the caller declines to inject.
  function meetingSkillCmd(kind, dir, question) {
    const d = sanitizeSkillArg(dir);
    if (!d) return null;
    if (kind === "answer") {
      const q = sanitizeSkillArg(question);
      if (!q) return null;
      return "/brain-answer " + d + " " + q;
    }
    return "/brain-analyse " + d;
  }

  function stripMarker(text) {
    // Drop the transcript marker AND the hidden per-segment sort-key comments
    // (`<!-- loro:t=NNN -->`, ADR-0013) so neither shows in the rendered surface
    // (text.js escapes HTML, so a comment would otherwise render as literal text).
    return String(text == null ? "" : text)
      .split(MARKER).join("")
      .replace(/^[ \t]*<!--\s*loro:t=\d+\s*-->[ \t]*\r?\n?/gm, "");
  }

  // A human label for a meeting in the tree. Prefer the manifest `titulo`; fall
  // back to the meeting id (folder name) so a meeting NEVER shows as a stale
  // "nova reunião" default. `id` is the last path segment of the meeting dir.
  function meetingTitleFromManifest(manifest, id) {
    const t = manifest && typeof manifest.titulo === "string" ? manifest.titulo.trim() : "";
    if (t && t.toLowerCase() !== "reunião" && t.toLowerCase() !== "nova reunião") return t;
    return String(id == null ? "" : id);
  }
  // Label from a meeting id like "2026-07-27-1430-semanal-de-custos": strip the
  // AAAA-MM-DD-HHMM stamp and humanize the slug tail ("semanal de custos"). An
  // untitled meeting carries the generic "reuniao" tail, which identifies
  // nothing in the sidebar — label it by its date/time instead ("reunião 27/07
  // 14:30"). Falls back to the raw id when it does not match the stamped shape.
  function meetingLabel(id) {
    const s = String(id == null ? "" : id);
    const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})-(.+)$/.exec(s);
    if (!m) return s;
    const tail = m[6].replace(/-/g, " ").trim();
    if (!tail || tail === "reuniao" || tail === "nova reuniao") {
      return "reunião " + m[3] + "/" + m[2] + " " + m[4] + ":" + m[5];
    }
    return tail;
  }

  // Join the acervo base with an acervo-relative path using a single separator.
  // brain_meeting_stop returns completoRel as an acervo-relative path, but the
  // existing transcription takes a filesystem path, so the frontend resolves it
  // against the acervo base here (ADR-0010: stop returns a rel, does not
  // transcribe).
  function acervoJoin(base, rel) {
    const b = String(base == null ? "" : base).replace(/\/+$/, "");
    const r = String(rel == null ? "" : rel).replace(/^\/+/, "");
    return b ? b + "/" + r : r;
  }

  // Format the ai_doctor posture into one honest pt-BR status line for the
  // análise rail (ADR-0011). Booleans only — never a secret or a token (BR-9);
  // in v1 embeddings/MCP/análise are deferred, so this reports "—" for them and
  // the caller keeps the analisar button disabled. Pure so it is node-tested.
  function aiStatusLine(d) {
    d = d || {};
    const local = d.localModelReady
      ? "pronto" + (d.localModelName ? " (" + d.localModelName + ")" : "")
      : "indisponível";
    const nuvem = d.cloudAvailable ? "disponível" : "—";
    const mcp = d.mcpAvailable ? "disponível" : "—";
    return "local: " + local + " · nuvem: " + nuvem + " · MCP: " + mcp;
  }

  // Whisper hallucinates caption-credit / non-speech artifacts on SILENCE (e.g.
  // "Legenda por Sônia Ruberti", "Legendas pela comunidade Amara.org", a lone
  // "[Música]" or "♪"). Drop those high-confidence non-speech lines so silence
  // never pollutes the transcript. Conservative — only well-known patterns, so
  // real speech is never removed.
  const HALLUCINATION = [
    /\blegendas?\b.*\b(por|pela|pelo|amara|comunidade)\b/i,
    /\bamara\.org\b/i,
    /\bsubtitl(es|ed)\b.*\bby\b/i,
    /^[\s\-–—♪♫🎵*·.]*$/, // símbolo/pontuação/branco apenas
    /^\s*[[(]?\s*(m[úu]sica|music|aplausos|applause|risos|laughter|sil[êe]ncio|silence)\s*[\])]?\s*$/i,
  ];
  function isHallucination(line) {
    const t = (line || "").trim();
    if (!t) return true;
    return HALLUCINATION.some(function (re) { return re.test(t); });
  }
  // Drop hallucinated lines from a (possibly multi-line) transcript chunk;
  // returns "" when everything was non-speech (caller then shows "só silêncio").
  function filterHallucinations(text) {
    return String(text == null ? "" : text)
      .split(/\r?\n/)
      .filter(function (l) { return !isHallucination(l); })
      .join("\n")
      .trim();
  }

  return {
    livingId, reportId, isLiving, isReport, meetingDir,
    sanitizeSkillArg, meetingSkillCmd,
    stripMarker, acervoJoin, aiStatusLine, MARKER,
    isHallucination, filterHallucinations,
    meetingTitleFromManifest, meetingLabel,
  };
});
