// ADR-0016 — a barra de formatação markdown existe nas DUAS superfícies de
// edição (a aba do Studio e o editor modal de pendentes/instruções), e as duas
// usam o mesmo CM6. Guardas estruturais: sem DOM aqui, então afirmamos sobre o
// HTML e o CSS, que é onde os erros dessas duas propriedades aparecem.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
const HTML = read("index.html");
const CSS = read("style.css");
const norm = (s) => s.replace(/\s+/g, " ");

test("mdedit.js é carregado antes de app.js (a barra depende de LoroMdEdit)", () => {
  const md = HTML.indexOf('src="mdedit.js"');
  const app = HTML.indexOf('src="app.js"');
  assert.ok(md > 0, "mdedit.js não é carregado no index.html");
  assert.ok(md < app, "mdedit.js deve ser carregado antes de app.js");
});

test("a aba do Studio tem a barra imediatamente antes do host do CM6", () => {
  const bar = HTML.indexOf('id="bEditBar"');
  const host = HTML.indexOf('id="bEditHost"');
  assert.ok(bar > 0, "#bEditBar ausente");
  assert.ok(bar < host, "#bEditBar deve vir antes de #bEditHost");
});

test("o editor modal usa CM6, não mais um textarea", () => {
  assert.ok(!/id="editArea"/.test(HTML), "o textarea #editArea deve ter saído do modal");
  assert.ok(!/\.editarea\b/.test(CSS), "o CSS do textarea .editarea deve ter saído");
  assert.ok(HTML.includes('id="editModalHost"'), "#editModalHost (host do CM6 no modal) ausente");
  assert.ok(HTML.includes('id="editModalBar"'), "#editModalBar (barra no modal) ausente");
});

test("a barra quebra linha em vez de estourar a janela padrão de 560px", () => {
  const css = norm(CSS);
  assert.match(
    css,
    /\.mdbar \{[^}]*flex-wrap:\s*wrap/,
    "a .mdbar precisa de flex-wrap: wrap — na janela padrão (560px) os botões não caberiam em uma linha",
  );
});

test("a barra não rola junto com o documento no modo editar", () => {
  const css = norm(CSS);
  assert.match(
    css,
    /#wsBody\.editing \.mdbar \{[^}]*flex:\s*none/,
    "no modo editar a barra é altura fixa (flex: none), senão o flex a esticaria ou a comprimiria",
  );
});

test("o host do CM6 no modal tem altura limitada para o editor poder rolar", () => {
  const css = norm(CSS);
  assert.match(
    css,
    /#editModalHost \{[^}]*(height|max-height):/,
    "#editModalHost precisa de altura limitada, senão o CM6 cresce com o documento e o modal estoura",
  );
});
