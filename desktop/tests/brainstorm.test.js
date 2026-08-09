// ADR-0013 — pure Brainstorming-flow helpers (grouping by categoria, the part
// selection model, the fila filename contract, the /loro-context command, the
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
  assert.strictEqual(en[1].hint, "choose files → each one enters the context generation queue");
  assert.strictEqual(en[2].hint, "generate the versioned context from the queue (/loro-context)");
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

test("filterAndCapTemas filters by nome/slug (case-insensitive)", () => {
  const temas = [
    { slug: "frota-2026", nome: "Frota 2026", atualizadoEm: "2026-07-01" },
    { slug: "vendas-q3", nome: "Vendas Q3", atualizadoEm: "2026-07-02" },
  ];
  const r = B.filterAndCapTemas(temas, "FROTA", false, 10);
  assert.strictEqual(r.hiddenCount, 0);
  assert.deepStrictEqual(r.items.map((t) => t.slug), ["frota-2026"]);
  assert.deepStrictEqual(B.filterAndCapTemas(temas, "q3", false, 10).items.map((t) => t.slug), ["vendas-q3"]);
  assert.deepStrictEqual(B.filterAndCapTemas(temas, "nada-aqui", false, 10).items, []);
});

test("filterAndCapTemas caps to the most recent when no query and over cap", () => {
  const temas = [
    { slug: "a", nome: "A", atualizadoEm: "2026-07-01" },
    { slug: "b", nome: "B", atualizadoEm: "2026-07-03" },
    { slug: "c", nome: "C", atualizadoEm: "2026-07-02" },
  ];
  const capped = B.filterAndCapTemas(temas, "", false, 2);
  assert.strictEqual(capped.hiddenCount, 1);
  assert.deepStrictEqual(capped.items.map((t) => t.slug), ["b", "c"]);
  // showAll lifts the cap entirely
  const all = B.filterAndCapTemas(temas, "", true, 2);
  assert.strictEqual(all.hiddenCount, 0);
  assert.strictEqual(all.items.length, 3);
  // under the cap: no-op regardless of showAll
  assert.strictEqual(B.filterAndCapTemas(temas, "", false, 10).hiddenCount, 0);
});

test("selection model toggles rels and maps to backend SelItems in parts order", () => {
  const parts = [
    { kind: "reuniao", rel: "brainstorming/x/reunioes/m1" },
    { kind: "anexo", rel: "brainstorming/x/anexos/a1.md" },
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

// T-7 (ADR-0018): a meeting stays a DIRECTORY here. Which files represent it is
// the backend's single owner (acervo::meeting_queueables) — the JS side never
// rebuilds the BR-8 gate (hotspot #46), and never names relatorio.md again.
test("queueRelForSelection keeps a meeting as its directory, files as themselves", () => {
  assert.strictEqual(
    B.queueRelForSelection("reuniao", "brainstorming/frota/reunioes/m1"),
    "brainstorming/frota/reunioes/m1"
  );
  // a trailing slash on the meeting dir must not survive
  assert.strictEqual(
    B.queueRelForSelection("reuniao", "brainstorming/frota/reunioes/m1/"),
    "brainstorming/frota/reunioes/m1"
  );
  // notes / analyses / attachments are already files — sent as themselves
  assert.strictEqual(
    B.queueRelForSelection("nota", "brainstorming/frota/notas/n1.md"),
    "brainstorming/frota/notas/n1.md"
  );
  assert.strictEqual(
    B.queueRelForSelection("anexo", "brainstorming/frota/anexos/a1.md"),
    "brainstorming/frota/anexos/a1.md"
  );
  assert.strictEqual(B.queueRelForSelection("reuniao", ""), null);
});

test("brainContextCmd is the renamed loop skill (hyphen, not dot)", () => {
  assert.strictEqual(B.brainContextCmd(), "/loro-context");
});

test("brainAskCmd builds a one-line /loro-ask; null on empty", () => {
  assert.strictEqual(B.brainAskCmd("qual o prazo da frota?"), "/loro-ask qual o prazo da frota?");
  // multiline/whitespace flattened — never a premature submit
  const cmd = B.brainAskCmd("linha 1\nlinha 2\t");
  assert.strictEqual(cmd, "/loro-ask linha 1 linha 2");
  assert.ok(!/[\r\n]/.test(cmd));
  assert.strictEqual(B.brainAskCmd("   "), null);
  assert.strictEqual(B.brainAskCmd(null), null);
});

test("brainAskCmd scopes the question to a context when given", () => {
  const { brainAskCmd } = require("../src/brainstorm.js");
  assert.strictEqual(brainAskCmd("qual o pipeline?", "vendas/contas"),
    "/loro-ask [contexto: vendas/contas] qual o pipeline?");
  assert.strictEqual(brainAskCmd("qual o pipeline?"), "/loro-ask qual o pipeline?");
  assert.strictEqual(brainAskCmd("", "vendas"), null);
});

test("noteCmd targets a folder (create) or a note file (evolve)", () => {
  const { noteCmd } = require("../src/brainstorm.js");
  assert.strictEqual(noteCmd("brainstorming/vendas/notas", "riscos do contrato"),
    "/loro-note brainstorming/vendas/notas riscos do contrato");
  assert.strictEqual(noteCmd("brainstorming/vendas/notas/n.md", "resuma\nem bullets"),
    "/loro-note brainstorming/vendas/notas/n.md resuma em bullets");
  assert.strictEqual(noteCmd("", "x"), null);
  assert.strictEqual(noteCmd("brainstorming/vendas/notas", "  "), null);
});

test("toolCmd targets an existing tool file to evolve, mirrors noteCmd", () => {
  const { toolCmd } = require("../src/brainstorm.js");
  assert.strictEqual(toolCmd(".claude/commands/resumo.md", "adicione um exemplo"),
    "/loro-tool .claude/commands/resumo.md adicione um exemplo");
  assert.strictEqual(toolCmd("", "x"), null);
  assert.strictEqual(toolCmd(".claude/commands/resumo.md", "  "), null);
});

test("newToolCmd builds /loro-tool <descrição>, null when empty", () => {
  const { newToolCmd } = require("../src/brainstorm.js");
  assert.strictEqual(newToolCmd("resume um ticket do Jira em 3 bullets"),
    "/loro-tool resume um ticket do Jira em 3 bullets");
  assert.strictEqual(newToolCmd("  "), null);
});

test("syncCmd builds /loro-sync <fonte> <alvo> [busca-ou-link], null when either is empty", () => {
  const { syncCmd } = require("../src/brainstorm.js");
  assert.strictEqual(syncCmd("drive", "vendas"), "/loro-sync drive vendas");
  assert.strictEqual(syncCmd("  drive  ", "  vendas  "), "/loro-sync drive vendas");
  assert.strictEqual(syncCmd("", "vendas"), null);
  assert.strictEqual(syncCmd("drive", ""), null);
  // optional third arg: a title keyword or a direct Drive link
  assert.strictEqual(syncCmd("drive", "vendas", "BARAD DUR"),
    "/loro-sync drive vendas BARAD DUR");
  assert.strictEqual(
    syncCmd("drive", "vendas", "https://docs.google.com/document/d/ID/edit"),
    "/loro-sync drive vendas https://docs.google.com/document/d/ID/edit"
  );
  assert.strictEqual(syncCmd("drive", "vendas", "  "), "/loro-sync drive vendas");
});

test("digestNotice nudges to generate/update the indice.md digest (ADR-0011)", () => {
  const { digestNotice } = require("../src/brainstorm.js");
  // no material at all → no notice
  assert.strictEqual(digestNotice(0, null), null);
  // material but never digested → "gerar"
  assert.deepStrictEqual(digestNotice(3, null), { kind: "gerar", n: 3 });
  assert.deepStrictEqual(digestNotice(3, ""), { kind: "gerar", n: 3 });
  // stamp is a string (front-matter is text) → parsed as a number
  assert.deepStrictEqual(digestNotice(5, "2"), { kind: "novos", n: 3 });
  assert.deepStrictEqual(digestNotice(5, 2), { kind: "novos", n: 3 });
  // up to date (equal) or shrunk → silent
  assert.strictEqual(digestNotice(4, 4), null);
  assert.strictEqual(digestNotice(3, 5), null);
  // a non-numeric stamp degrades to "gerar" (treat as never digested)
  assert.deepStrictEqual(digestNotice(2, "abc"), { kind: "gerar", n: 2 });
});

// ---- assinatura da árvore lateral -----------------------------------------
// Regressão relatada: ao terminar uma análise o relatório não aparecia na
// lateral, e arquivo novo em notas/anexos também não. A assinatura só olhava o
// TOPO (lista de brainstormings + avulsos); uma análise cai em
// <reunião>/notas/ e não muda nada disso — a contagem de reuniões é a mesma e
// `atualizado_em` é uma DATA vinda do manifest.
//
// `listDir(rel) -> [nomes]` e `listMeetings(slug) -> [{id, rel, ...}]` são
// injetados, então o teste roda sem Tauri e sem DOM.
function fakeWorld(fs, meetings) {
  return {
    listDir: async (rel) => (fs[rel] || []).slice(),
    listMeetings: async (slug) => (meetings[slug] || []).slice(),
  };
}
const TEMAS = [{ slug: "tech", nome: "Tech", reunioes: 1, atualizado_em: "2026-08-07" }];
const MTG = { tech: [{ id: "m1", rel: "brainstorming/tech/reunioes/m1", titulo: "", status: "" }] };
const FS_BASE = {
  "brainstorming/tech/notas": ["ideia.md"],
  "brainstorming/tech/anexos": [],
  "brainstorming/tech/reunioes/m1/notas": [],
};
const OPEN_ALL = new Set(["pes:tema:tech", "mtg:m1"]);

test("a análise que o agente escreve muda a assinatura", async () => {
  const fs = JSON.parse(JSON.stringify(FS_BASE));
  const w = fakeWorld(fs, MTG);
  const before = await B.pessoalSig(TEMAS, [], OPEN_ALL, w);
  fs["brainstorming/tech/reunioes/m1/notas"].push("analise-2026-08-07.md");
  const after = await B.pessoalSig(TEMAS, [], OPEN_ALL, w);
  assert.notStrictEqual(after, before, "o relatório novo tem de disparar re-render");
});

test("arquivo novo em notas/ e em anexos/ muda a assinatura", async () => {
  for (const pasta of ["notas", "anexos"]) {
    const fs = JSON.parse(JSON.stringify(FS_BASE));
    const w = fakeWorld(fs, MTG);
    const before = await B.pessoalSig(TEMAS, [], OPEN_ALL, w);
    fs[`brainstorming/tech/${pasta}`].push("novo.md");
    assert.notStrictEqual(await B.pessoalSig(TEMAS, [], OPEN_ALL, w), before, pasta);
  }
});

// O outro lado da moeda: sem mudança a assinatura tem de ser IDÊNTICA, senão o
// poll reconstrói a árvore a cada 5s e come o clique do usuário — que era o
// segundo sintoma do relato.
test("sem novidade a assinatura é estável (não reconstrói o DOM)", async () => {
  const w = fakeWorld(JSON.parse(JSON.stringify(FS_BASE)), MTG);
  const a = await B.pessoalSig(TEMAS, [], OPEN_ALL, w);
  const b = await B.pessoalSig(TEMAS, [], OPEN_ALL, w);
  assert.strictEqual(a, b);
});

test("só lê o que está aberto — nó fechado não custa e não dispara", async () => {
  const fs = JSON.parse(JSON.stringify(FS_BASE));
  const lidos = [];
  const w = {
    listDir: async (rel) => { lidos.push(rel); return (fs[rel] || []).slice(); },
    listMeetings: async (slug) => (MTG[slug] || []).slice(),
  };
  const fechado = new Set();
  const before = await B.pessoalSig(TEMAS, [], fechado, w);
  assert.deepStrictEqual(lidos, [], "com nada expandido não há leitura extra");
  fs["brainstorming/tech/reunioes/m1/notas"].push("analise.md");
  assert.strictEqual(await B.pessoalSig(TEMAS, [], fechado, w), before,
    "arquivo dentro de nó fechado não precisa re-renderizar");
});

test("reunião fechada não é lida, mas a lista de reuniões conta", async () => {
  const fs = JSON.parse(JSON.stringify(FS_BASE));
  const w = fakeWorld(fs, MTG);
  const soTema = new Set(["pes:tema:tech"]);
  const before = await B.pessoalSig(TEMAS, [], soTema, w);
  fs["brainstorming/tech/reunioes/m1/notas"].push("analise.md");
  assert.strictEqual(await B.pessoalSig(TEMAS, [], soTema, w), before);
  // uma reunião NOVA muda, mesmo com todas fechadas
  const mtg2 = { tech: MTG.tech.concat([{ id: "m2", rel: "b/m2", titulo: "", status: "" }]) };
  assert.notStrictEqual(await B.pessoalSig(TEMAS, [], soTema, fakeWorld(fs, mtg2)), before);
});

test("renomear uma reunião muda a assinatura", async () => {
  const w = fakeWorld(JSON.parse(JSON.stringify(FS_BASE)), MTG);
  const before = await B.pessoalSig(TEMAS, [], OPEN_ALL, w);
  const renomeada = { tech: [{ id: "m1", rel: "brainstorming/tech/reunioes/m1", titulo: "Semanal", status: "" }] };
  const w2 = fakeWorld(JSON.parse(JSON.stringify(FS_BASE)), renomeada);
  assert.notStrictEqual(await B.pessoalSig(TEMAS, [], OPEN_ALL, w2), before);
});

test("avulso e a lista de temas continuam contando", async () => {
  const w = fakeWorld(JSON.parse(JSON.stringify(FS_BASE)), MTG);
  const before = await B.pessoalSig(TEMAS, ["a.md"], OPEN_ALL, w);
  assert.notStrictEqual(await B.pessoalSig(TEMAS, ["a.md", "b.md"], OPEN_ALL, w), before);
  const outros = TEMAS.concat([{ slug: "x", nome: "X", reunioes: 0, atualizado_em: "2026-08-07" }]);
  assert.notStrictEqual(await B.pessoalSig(outros, ["a.md"], OPEN_ALL, w), before);
});

test("uma listagem que falha não quebra a assinatura", async () => {
  const w = {
    listDir: async () => { throw new Error("sem permissão"); },
    listMeetings: async () => { throw new Error("off"); },
  };
  const sig = await B.pessoalSig(TEMAS, [], OPEN_ALL, w);
  assert.strictEqual(typeof sig, "string");
  assert.strictEqual(await B.pessoalSig(TEMAS, [], OPEN_ALL, w), sig, "estável mesmo falhando");
});
