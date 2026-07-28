// ADR-0013 — pure Brainstorming-flow helpers (grouping by categoria, the part
// selection model, the fila filename contract, the /brain-context command, the
// 3-stage flow copy). No DOM/Tauri: exercised in Node via require().
const test = require("node:test");
const assert = require("node:assert");
const B = require("../src/brainstorm.js");

test("STAGES is the sequential brainstorming -> fila -> contexto flow", () => {
  assert.deepStrictEqual(
    B.STAGES.map((s) => s.key),
    ["brainstorming", "fila", "contexto"]
  );
  // every stage carries a human label + hint the UI shows
  for (const s of B.STAGES) {
    assert.ok(s.label && s.hint, "stage needs label + hint");
  }
});

test("stages(lang) localizes the flow copy; default stays pt-BR", () => {
  // pt (default) is exactly the legacy STAGES constant
  assert.deepStrictEqual(B.stages(), B.STAGES);
  assert.deepStrictEqual(B.stages("pt"), B.STAGES);
  assert.deepStrictEqual(B.STAGES.map((s) => s.label), ["Brainstorming", "Fila", "Contexto"]);
  // en keeps the same keys/order, translates labels + hints
  const en = B.stages("en");
  assert.deepStrictEqual(en.map((s) => s.key), ["brainstorming", "fila", "contexto"]);
  assert.deepStrictEqual(en.map((s) => s.label), ["Brainstorming", "Queue", "Context"]);
  for (const s of en) assert.ok(s.label && s.hint, "en stage needs label + hint");
  assert.strictEqual(en[0].hint, "build the idea: meetings and notes");
  assert.strictEqual(en[1].hint, "elect parts → a report enters the context generation queue");
  assert.strictEqual(en[2].hint, "generate the versioned context from the queue (/brain-context)");
});

test("groupByCategory buckets by categoria, uncategorized last", () => {
  const list = [
    { slug: "a", categoria: "Produto" },
    { slug: "b" },
    { slug: "c", categoria: "Pessoal" },
    { slug: "d", categoria: "Produto" },
  ];
  const groups = B.groupByCategory(list);
  assert.deepStrictEqual(groups.map((g) => g.categoria), ["Pessoal", "Produto", "Sem categoria"]);
  assert.deepStrictEqual(groups.find((g) => g.categoria === "Produto").items.map((i) => i.slug), ["a", "d"]);
  assert.strictEqual(groups.find((g) => g.categoria === "Sem categoria").items[0].slug, "b");
  assert.deepStrictEqual(B.groupByCategory(null), []);
});

test("selection model toggles rels and maps to backend SelItems in parts order", () => {
  const parts = [
    { kind: "reuniao", rel: "brainstorming/x/reunioes/m1" },
    { kind: "pergunta", rel: "brainstorming/x/perguntas/q1.md" },
    { kind: "nota", rel: "brainstorming/x/notas/n1.md" },
  ];
  let sel = B.emptySelection();
  sel = B.toggleSelection(sel, parts[1].rel);
  sel = B.toggleSelection(sel, parts[0].rel);
  assert.ok(sel.has(parts[0].rel) && sel.has(parts[1].rel));
  // toggling again removes it
  sel = B.toggleSelection(sel, parts[1].rel);
  assert.ok(!sel.has(parts[1].rel));
  // mapped items keep parts order, not insertion order
  const items = B.selectedItems(parts, B.toggleSelection(sel, parts[2].rel));
  assert.deepStrictEqual(items, [
    { kind: "reuniao", rel: "brainstorming/x/reunioes/m1" },
    { kind: "nota", rel: "brainstorming/x/notas/n1.md" },
  ]);
});

test("reportInboxName steers a report to a context via the <ctx>-- prefix", () => {
  const rel = "brainstorming/frota/relatorios/2026-07-28-0900-relatorio.md";
  assert.strictEqual(B.reportInboxName(rel, "frota"), "frota--2026-07-28-0900-relatorio.md");
  // hierarchical context collapses '/' to '-' so the queue name stays flat
  assert.strictEqual(B.reportInboxName(rel, "engenharia/frontend"), "engenharia-frontend--2026-07-28-0900-relatorio.md");
  // no context -> the bare filename
  assert.strictEqual(B.reportInboxName(rel, ""), "2026-07-28-0900-relatorio.md");
  assert.strictEqual(B.reportInboxName(rel, null), "2026-07-28-0900-relatorio.md");
});

test("brainContextCmd is the renamed loop skill (hyphen, not dot)", () => {
  assert.strictEqual(B.brainContextCmd(), "/brain-context");
});

test("brainAskCmd builds a one-line /brain-ask; null on empty", () => {
  assert.strictEqual(B.brainAskCmd("qual o prazo da frota?"), "/brain-ask qual o prazo da frota?");
  // multiline/whitespace flattened — never a premature submit
  const cmd = B.brainAskCmd("linha 1\nlinha 2\t");
  assert.strictEqual(cmd, "/brain-ask linha 1 linha 2");
  assert.ok(!/[\r\n]/.test(cmd));
  assert.strictEqual(B.brainAskCmd("   "), null);
  assert.strictEqual(B.brainAskCmd(null), null);
});
