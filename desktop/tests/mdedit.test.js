// Testes da lógica de formatação markdown da barra de edição (node --test).
// ADR-0016: os comandos são funções puras (doc + seleção → changes + seleção),
// então a barra e os atalhos são testáveis sem DOM e sem CodeMirror.
const test = require("node:test");
const assert = require("node:assert");
const M = require("../src/mdedit.js");

// Aplica o resultado de um comando ao texto, como o CM6 faria, para o teste
// poder afirmar sobre o documento final e sobre a seleção resultante.
function apply(doc, edit) {
  let out = doc;
  // aplica de trás para frente para os offsets não se deslocarem
  const changes = [...edit.changes].sort((a, b) => b.from - a.from);
  for (const c of changes) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return { doc: out, sel: [edit.selection.anchor, edit.selection.head] };
}
const run = (doc, from, to, action) => apply(doc, M.apply(doc, from, to, action));
const sliceSel = (r) => r.doc.slice(Math.min(...r.sel), Math.max(...r.sel));

// ---- inline: negrito / itálico / riscado / código ----

test("negrito envolve a seleção e mantém o texto selecionado", () => {
  const r = run("um dois três", 3, 7, "bold");
  assert.strictEqual(r.doc, "um **dois** três");
  assert.strictEqual(sliceSel(r), "dois");
});

test("negrito remove os marcadores quando a seleção já está em negrito", () => {
  const r = run("um **dois** três", 5, 9, "bold");
  assert.strictEqual(r.doc, "um dois três");
  assert.strictEqual(sliceSel(r), "dois");
});

test("negrito remove os marcadores quando a seleção os inclui", () => {
  const r = run("um **dois** três", 3, 11, "bold");
  assert.strictEqual(r.doc, "um dois três");
  assert.strictEqual(sliceSel(r), "dois");
});

test("negrito com cursor dentro de uma palavra envolve a palavra", () => {
  const r = run("um dois três", 5, 5, "bold");
  assert.strictEqual(r.doc, "um **dois** três");
  assert.strictEqual(sliceSel(r), "dois");
});

test("negrito com cursor fora de palavra insere marcadores vazios com o cursor no meio", () => {
  const r = run("um  três", 3, 3, "bold");
  assert.strictEqual(r.doc, "um **** três");
  assert.deepStrictEqual(r.sel, [5, 5]);
});

test("itálico usa um asterisco", () => {
  assert.strictEqual(run("um dois", 3, 7, "italic").doc, "um *dois*");
});

test("riscado usa til duplo e alterna", () => {
  assert.strictEqual(run("um dois", 3, 7, "strike").doc, "um ~~dois~~");
  assert.strictEqual(run("um ~~dois~~", 5, 9, "strike").doc, "um dois");
});

test("código inline usa acento grave e alterna", () => {
  assert.strictEqual(run("um dois", 3, 7, "code").doc, "um `dois`");
  assert.strictEqual(run("um `dois`", 4, 8, "code").doc, "um dois");
});

test("itálico dentro de negrito não confunde os marcadores", () => {
  const r = run("**dois**", 2, 6, "italic");
  assert.strictEqual(r.doc, "***dois***");
  assert.strictEqual(sliceSel(r), "dois");
});

// ---- títulos ----

test("h1 prefixa a linha do cursor", () => {
  const r = run("Título\ncorpo", 2, 2, "h1");
  assert.strictEqual(r.doc, "# Título\ncorpo");
  assert.deepStrictEqual(r.sel, [4, 4]);
});

test("h2 substitui um nível de título existente", () => {
  assert.strictEqual(run("# Título", 3, 3, "h2").doc, "## Título");
});

test("h2 no mesmo nível remove o título (alterna)", () => {
  assert.strictEqual(run("## Título", 4, 4, "h2").doc, "Título");
});

test("h3 aplica a todas as linhas da seleção", () => {
  const r = run("um\ndois", 0, 6, "h3");
  assert.strictEqual(r.doc, "### um\n### dois");
});

test("título preserva a indentação da linha", () => {
  assert.strictEqual(run("  Título", 4, 4, "h1").doc, "  # Título");
});

// ---- listas e citação ----

test("lista prefixa cada linha da seleção", () => {
  const r = run("um\ndois", 0, 6, "bullet");
  assert.strictEqual(r.doc, "- um\n- dois");
});

test("lista alterna quando todas as linhas já são itens", () => {
  assert.strictEqual(run("- um\n- dois", 0, 10, "bullet").doc, "um\ndois");
});

test("checklist marca itens não feitos e alterna os já marcados", () => {
  assert.strictEqual(run("um", 0, 2, "task").doc, "- [ ] um");
  assert.strictEqual(run("- [ ] um", 0, 8, "task").doc, "um");
  assert.strictEqual(run("- [x] um", 0, 8, "task").doc, "um");
});

test("checklist converte um item de lista existente sem duplicar o hífen", () => {
  assert.strictEqual(run("- um", 0, 4, "task").doc, "- [ ] um");
});

test("lista numerada numera sequencialmente as linhas da seleção", () => {
  const r = run("um\ndois\ntrês", 0, 12, "ordered");
  assert.strictEqual(r.doc, "1. um\n2. dois\n3. três");
});

test("lista numerada alterna quando todas as linhas já são numeradas", () => {
  assert.strictEqual(run("1. um\n2. dois", 0, 12, "ordered").doc, "um\ndois");
});

test("citação prefixa e alterna", () => {
  assert.strictEqual(run("um\ndois", 0, 6, "quote").doc, "> um\n> dois");
  assert.strictEqual(run("> um\n> dois", 0, 10, "quote").doc, "um\ndois");
});

test("linhas em branco no meio da seleção não recebem prefixo de lista", () => {
  const r = run("um\n\ndois", 0, 8, "bullet");
  assert.strictEqual(r.doc, "- um\n\n- dois");
});

test("prefixo de lista seleciona o bloco transformado quando havia seleção", () => {
  const r = run("um\ndois", 0, 6, "bullet");
  assert.strictEqual(sliceSel(r), "- um\n- dois");
});

// ---- link ----

test("link envolve a seleção e deixa o cursor no destino", () => {
  const r = run("veja o acervo", 7, 13, "link");
  assert.strictEqual(r.doc, "veja o [acervo]()");
  assert.deepStrictEqual(r.sel, [16, 16]);
});

test("link sem seleção deixa o cursor no texto do link", () => {
  const r = run("veja ", 5, 5, "link");
  assert.strictEqual(r.doc, "veja []()");
  assert.deepStrictEqual(r.sel, [6, 6]);
});

// ---- blocos ----

test("tabela é inserida como esqueleto em linha própria", () => {
  const r = run("corpo", 5, 5, "table");
  assert.match(r.doc, /\| {3}\| {3}\|\n\| --- \| --- \|\n/);
  assert.ok(r.doc.startsWith("corpo\n"), "a tabela não deve grudar no texto anterior");
});

test("bloco de código envolve a seleção em cercas", () => {
  const r = run("x = 1", 0, 5, "codeblock");
  assert.strictEqual(r.doc, "```\nx = 1\n```");
});

test("bloco de código sem seleção abre cercas com o cursor dentro", () => {
  const r = run("", 0, 0, "codeblock");
  assert.strictEqual(r.doc, "```\n\n```");
  assert.deepStrictEqual(r.sel, [4, 4]);
});

test("régua insere um separador em linha própria", () => {
  const r = run("um", 2, 2, "rule");
  assert.strictEqual(r.doc, "um\n\n---\n");
});

// ---- contrato ----

test("uma ação desconhecida não produz edição", () => {
  assert.strictEqual(M.apply("um", 0, 2, "inexistente"), null);
});

test("apply aceita a seleção invertida (head antes do anchor)", () => {
  const r = run("um dois três", 7, 3, "bold");
  assert.strictEqual(r.doc, "um **dois** três");
});

test("ACTIONS lista as ações da barra e cada uma tem atalho ou rótulo", () => {
  assert.ok(Array.isArray(M.ACTIONS) && M.ACTIONS.length > 0);
  for (const a of M.ACTIONS) {
    assert.ok(a.action && a.label, `ação sem action/label: ${JSON.stringify(a)}`);
    assert.ok(a.title, `ação ${a.action} sem título (tooltip)`);
    assert.notStrictEqual(M.apply("texto", 0, 5, a.action), null, `ação ${a.action} não implementada`);
  }
});

test("os atalhos declarados apontam para ações existentes", () => {
  const actions = new Set(M.ACTIONS.map((a) => a.action));
  for (const [key, action] of Object.entries(M.KEYS)) {
    assert.ok(actions.has(action), `atalho ${key} aponta para ação inexistente: ${action}`);
  }
});
