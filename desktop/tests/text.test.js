// Testes das utilidades de texto (node --test). Sem dependências externas.
const test = require("node:test");
const assert = require("node:assert");
const { esc, mdInline, mdRender, mergeSettings } = require("../src/text.js");

test("esc escapa caracteres HTML perigosos", () => {
  assert.strictEqual(esc("<b> & </b>"), "&lt;b&gt; &amp; &lt;/b&gt;");
});

test("esc lida com valores não-string", () => {
  assert.strictEqual(esc(42), "42");
});

test("mdInline destaca rótulo de locutor", () => {
  assert.match(mdInline("SPEAKER_00: olá"), /<span class="spk">SPEAKER_00:<\/span>/);
});

test("mdInline destaca locutor com nome próprio", () => {
  assert.match(mdInline("Daniel: bom dia"), /<span class="spk">Daniel:<\/span>/);
});

test("mdInline aplica negrito", () => {
  assert.strictEqual(mdInline("um **dois** três"), "um <strong>dois</strong> três");
});

test("mdInline aplica código inline", () => {
  assert.match(mdInline("rode `loro.sh`"), /<code>loro\.sh<\/code>/);
});

test("mdInline em texto comum não altera nada", () => {
  assert.strictEqual(mdInline("apenas uma frase simples"), "apenas uma frase simples");
});

test("mdInline itálico com _ isolado, sem pegar snake_case", () => {
  assert.strictEqual(mdInline("_Guia de negócio._"), "<em>Guia de negócio.</em>");
  assert.strictEqual(mdInline("arquivo file_name_ok aqui"), "arquivo file_name_ok aqui");
});

test("mdRender: títulos, parágrafos e listas", () => {
  const html = mdRender("# T\n\ntexto corrido\n\n- um\n- dois\n");
  assert.match(html, /<h1>T<\/h1>/);
  assert.match(html, /<p>texto corrido<\/p>/);
  assert.match(html, /<ul><li>um<\/li><li>dois<\/li><\/ul>/);
});

test("mdRender: link relativo vira interno, http abre fora", () => {
  const html = mdRender("[doc](../reunioes/x.md) e [site](https://a.b)");
  assert.match(html, /<a data-path="\.\.\/reunioes\/x\.md">doc<\/a>/);
  assert.match(html, /<a href="https:\/\/a\.b" target="_blank">site<\/a>/);
});

test("mdRender: bloco de código preservado", () => {
  const html = mdRender("```\ncodigo <aqui>\n```");
  assert.match(html, /<pre><code>codigo &lt;aqui&gt;\n<\/code><\/pre>/);
});

test("mdRender: tabela vira <table> com th/td", () => {
  const html = mdRender("| a | b |\n|---|---|\n| 1 | 2 |\n");
  assert.match(html, /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead>/);
  assert.match(html, /<tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/);
});

test("mdRender: blockquote, h5 e lista ordenada", () => {
  const html = mdRender("> citação\n\n##### Sub\n\n1. um\n2. dois\n");
  assert.match(html, /<blockquote><p>citação<\/p><\/blockquote>/);
  assert.match(html, /<h5>Sub<\/h5>/);
  assert.match(html, /<ol><li>um<\/li><li>dois<\/li><\/ol>/);
});

test("mdRender: task list e tachado", () => {
  const html = mdRender("- [x] feito ~~antigo~~\n- [ ] pendente\n");
  assert.match(html, /<input type="checkbox" disabled checked> feito <del>antigo<\/del>/);
  assert.match(html, /<input type="checkbox" disabled> pendente/);
});

test("mdRender: lista aninhada por indentação", () => {
  const html = mdRender("- pai\n  - filho\n- outro\n");
  assert.match(html, /<ul><li>pai<\/li><ul><li>filho<\/li><\/ul><li>outro<\/li><\/ul>/);
});

test("inlineMd: código não sofre formatação e números ficam intactos", () => {
  const { inlineMd } = require("../src/text.js");
  assert.strictEqual(inlineMd("use `a**b**c` aqui"), "use <code>a**b**c</code> aqui");
  assert.strictEqual(inlineMd("tem 3 itens e 12 fontes"), "tem 3 itens e 12 fontes");
});

test("mdRender: imagem externa renderiza; local vira rótulo", () => {
  const html = mdRender("![logo](https://a.b/x.png) e ![foto](./local.png)");
  assert.match(html, /<img src="https:\/\/a\.b\/x\.png" alt="logo">/);
  assert.match(html, /<em>\[imagem: foto\]<\/em>/);
});

const DEF = { model: "turbo", autosave: false, saveDir: "" };

test("mergeSettings aplica valores válidos", () => {
  assert.deepStrictEqual(
    mergeSettings(DEF, { model: "small", autosave: true }),
    { model: "small", autosave: true, saveDir: "" }
  );
});

test("mergeSettings ignora chaves desconhecidas e tipos errados", () => {
  assert.deepStrictEqual(
    mergeSettings(DEF, { hack: 1, autosave: "sim", saveDir: 42 }),
    DEF
  );
});

test("mergeSettings tolera null/lixo", () => {
  assert.deepStrictEqual(mergeSettings(DEF, null), DEF);
  assert.deepStrictEqual(mergeSettings(DEF, "corrompido"), DEF);
});

const DEF_MODE = { model: "turbo", mode: "live", saveDir: "" };

test("mergeSettings aplica o modo de transcrição (ao vivo / gravar tudo)", () => {
  assert.deepStrictEqual(
    mergeSettings(DEF_MODE, { mode: "file" }),
    { model: "turbo", mode: "file", saveDir: "" }
  );
});

test("mergeSettings ignora modo com tipo errado e mantém o padrão", () => {
  assert.deepStrictEqual(mergeSettings(DEF_MODE, { mode: 1 }), DEF_MODE);
});
