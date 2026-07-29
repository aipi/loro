// Loro — pure, dependency-free helpers for the Brainstorming world and the
// brainstorming → fila → contexto flow (ADR-0013). Loaded in the browser via
// <script> (defines window.LoroBrainstorm) and in Node via require() for
// `node --test`. No DOM, no Tauri — pure string/data transforms so the app.js
// wiring stays thin and the flow logic is unit-covered.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroBrainstorm = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  // The sequential flow the UI must make legible. The user always moves left to
  // right: build ideas in a brainstorming, elect parts into the context queue,
  // then generate the versioned context.
  // Stage copy per language. Keys are stable identifiers (never translated);
  // labels/hints are UI copy — pure modules cannot reach the window-level i18n
  // dictionary, so callers pass `lang` ("pt" default | "en") to stages().
  const STAGES_BY_LANG = {
    pt: [
      { key: "brainstorming", label: "Brainstorming", hint: "construa a ideia: reuniões e notas" },
      { key: "fila", label: "Fila", hint: "eleja partes → um relatório entra na fila de geração de contexto" },
      { key: "contexto", label: "Contexto", hint: "gere o contexto versionado a partir da fila (/loro-context)" },
    ],
    en: [
      { key: "brainstorming", label: "Brainstorming", hint: "build the idea: meetings and notes" },
      { key: "fila", label: "Queue", hint: "elect parts → a report enters the context generation queue" },
      { key: "contexto", label: "Context", hint: "generate the versioned context from the queue (/loro-context)" },
    ],
  };
  function stages(lang) {
    return STAGES_BY_LANG[lang === "en" ? "en" : "pt"];
  }
  // Legacy pt-BR constant kept for callers not yet passing a lang.
  const STAGES = STAGES_BY_LANG.pt;

  // Group brainstormings by their optional `categoria` (a UI-only label). Returns
  // an ordered list of { categoria, items } — items keep their input order;
  // groups are sorted with the uncategorized bucket ("Sem categoria") last.
  function groupByCategory(list) {
    const arr = Array.isArray(list) ? list : [];
    const UNCAT = "Sem categoria";
    const map = new Map();
    for (const b of arr) {
      const cat = b && typeof b.categoria === "string" && b.categoria.trim()
        ? b.categoria.trim()
        : UNCAT;
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat).push(b);
    }
    const cats = Array.from(map.keys()).sort(function (a, b) {
      if (a === UNCAT) return 1;
      if (b === UNCAT) return -1;
      return a.localeCompare(b, "pt");
    });
    return cats.map(function (c) { return { categoria: c, items: map.get(c) }; });
  }

  // ADR-0005: with many brainstormings the always-expanded tree got unreadable
  // — a search box replaces it. A query filters by nome/slug; with no query,
  // caps to the `cap` most recently updated (unless `showAll`), reporting how
  // many were hidden so the caller can render a "ver todos (N)" row.
  function filterAndCapTemas(temas, query, showAll, cap) {
    const arr = Array.isArray(temas) ? temas : [];
    const q = String(query == null ? "" : query).trim().toLowerCase();
    if (q) {
      const items = arr.filter(function (t) {
        const nome = String((t && t.nome) || "").toLowerCase();
        const slug = String((t && t.slug) || "").toLowerCase();
        return nome.includes(q) || slug.includes(q);
      });
      return { items, hiddenCount: 0 };
    }
    if (showAll || arr.length <= cap) return { items: arr, hiddenCount: 0 };
    const sorted = arr.slice().sort(function (a, b) {
      return String((b && b.atualizadoEm) || "").localeCompare(String((a && a.atualizadoEm) || ""));
    });
    return { items: sorted.slice(0, cap), hiddenCount: arr.length - cap };
  }

  // A selection model over a brainstorming's parts. Each part is
  // { kind: "reuniao"|"investigacao"|"pergunta"|"nota", rel }. The model is a
  // plain Set of rels so it stays serializable/testable.
  function emptySelection() { return new Set(); }
  function toggleSelection(sel, rel) {
    const s = new Set(sel);
    if (s.has(rel)) s.delete(rel); else s.add(rel);
    return s;
  }
  // Turn (parts, selection-set) into the SelItem[] the backend expects, in the
  // parts' order. An empty selection means "all parts" to the backend, so the
  // caller decides whether to send [] (all) or the mapped subset.
  function selectedItems(parts, sel) {
    const arr = Array.isArray(parts) ? parts : [];
    const s = sel instanceof Set ? sel : new Set(sel || []);
    return arr
      .filter(function (p) { return p && s.has(p.rel); })
      .map(function (p) { return { kind: p.kind, rel: p.rel }; });
  }

  // The queue (inbox) filename for a report sent to the fila, steered to a
  // context via the `<contexto>--<nome>` prefix (contexts with '/' collapse to
  // '-' so the queue name stays flat). Mirrors the Rust import_name contract.
  function reportInboxName(reportRel, destContext) {
    const base = String(reportRel == null ? "" : reportRel).split("/").pop() || "relatorio.md";
    const c = String(destContext == null ? "" : destContext).trim().replace(/\//g, "-");
    return c ? c + "--" + base : base;
  }

  // Build the "/loro-context" invocation the "gerar contexto" button injects
  // into the terminal (the renamed loop skill; hyphen, not a dot). No argument is
  // required — the loop reads the whole inbox — so it is a bare command. Kept as a
  // helper (symmetry with meetingSkillCmd) so the command string has one source.
  function brainContextCmd() { return "/loro-context"; }

  // Build the "/loro-ask <question>" invocation for the general Q&A over the
  // acervo's contexts (+ MCP). Flattens whitespace/newlines to one PTY line (the
  // terminal submits on newline). Returns null when the question is empty after
  // sanitizing, so the caller declines to inject.
  // ctx (optional) scopes the question to one context: the scope travels as a
  // plain-text prefix, so the /loro-ask contract stays a free-text question
  // and any agent understands it.
  function brainAskCmd(question, ctx) {
    const q = String(question == null ? "" : question).replace(/\s+/g, " ").trim();
    if (!q) return null;
    const c = String(ctx == null ? "" : ctx).replace(/\s+/g, " ").trim();
    return "/loro-ask " + (c ? "[contexto: " + c + "] " : "") + q;
  }

  // /loro-note: first token is the target (notes folder → create; .md file →
  // evolve in place); the rest is the prompt, flattened to one line.
  function noteCmd(target, prompt) {
    const d = String(target == null ? "" : target).replace(/\s+/g, " ").trim();
    const p = String(prompt == null ? "" : prompt).replace(/\s+/g, " ").trim();
    return d && p ? "/loro-note " + d + " " + p : null;
  }

  // /loro-sync <fonte> <alvo> [busca-ou-link]: first token is the source (v1:
  // "drive" only), second is the target note/topic, optional third narrows the
  // search (a title keyword) or names the document directly (a Drive link) —
  // useful when the default title search misses a shared meeting. Returns
  // null when source or target is empty.
  function syncCmd(source, target, query) {
    const s = String(source == null ? "" : source).replace(/\s+/g, " ").trim();
    const t = String(target == null ? "" : target).replace(/\s+/g, " ").trim();
    const q = String(query == null ? "" : query).replace(/\s+/g, " ").trim();
    return s && t ? "/loro-sync " + s + " " + t + (q ? " " + q : "") : null;
  }

  // /loro-tool: mirrors noteCmd's dual shape, but for custom tools — first
  // token is the target (a description → create; an existing tool .md →
  // evolve in place with the rest as the request).
  function toolCmd(target, prompt) {
    const d = String(target == null ? "" : target).replace(/\s+/g, " ").trim();
    const p = String(prompt == null ? "" : prompt).replace(/\s+/g, " ").trim();
    return d && p ? "/loro-tool " + d + " " + p : null;
  }
  // /loro-tool <descrição>: the create-a-new-tool shape — a single free-text
  // description, no target file. Returns null when empty.
  function newToolCmd(descricao) {
    const d = String(descricao == null ? "" : descricao).replace(/\s+/g, " ").trim();
    return d ? "/loro-tool " + d : null;
  }

  return {
    STAGES, stages,
    groupByCategory, filterAndCapTemas,
    emptySelection, toggleSelection, selectedItems,
    reportInboxName, brainContextCmd, brainAskCmd, noteCmd, syncCmd, toolCmd, newToolCmd,
  };
});
