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
  const STAGES = [
    { key: "brainstorming", label: "Brainstorming", hint: "construa a ideia: reuniões e notas" },
    { key: "fila", label: "Fila", hint: "eleja partes → um relatório entra na fila de geração de contexto" },
    { key: "contexto", label: "Contexto", hint: "gere o contexto versionado a partir da fila (/brain-context)" },
  ];

  // Group brainstormings by their optional `categoria` (a UI-only label). Returns
  // an ordered list of { categoria, items } — items keep their input order;
  // groups are sorted with the uncategorized bucket ("Sem categoria") last.
  function groupByCategoria(list) {
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

  // Build the "/brain-context" invocation the "gerar contexto" button injects
  // into the terminal (the renamed loop skill; hyphen, not a dot). No argument is
  // required — the loop reads the whole inbox — so it is a bare command. Kept as a
  // helper (symmetry with meetingSkillCmd) so the command string has one source.
  function brainContextCmd() { return "/brain-context"; }

  // Build the "/brain-ask <question>" invocation for the general Q&A over the
  // acervo's contexts (+ MCP). Flattens whitespace/newlines to one PTY line (the
  // terminal submits on newline). Returns null when the question is empty after
  // sanitizing, so the caller declines to inject.
  function brainAskCmd(question) {
    const q = String(question == null ? "" : question).replace(/\s+/g, " ").trim();
    return q ? "/brain-ask " + q : null;
  }

  return {
    STAGES,
    groupByCategoria,
    emptySelection, toggleSelection, selectedItems,
    reportInboxName, brainContextCmd, brainAskCmd,
  };
});
