// Testes das utilidades de texto (node --test). Sem dependências externas.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
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
  assert.match(html, /<a href="#" data-path="\.\.\/reunioes\/x\.md">doc<\/a>/);
  assert.match(html, /<a href="https:\/\/a\.b" target="_blank">site<\/a>/);
});

// R2 — a referência interna saía como <a> sem href: fora da ordem de tabulação
// (WCAG 2.1.1) e sem papel de link para a tecnologia assistiva (4.1.2). O app
// despacha pelo data-path e dá preventDefault, então o href é só a semântica.
test("mdRender: referência interna é um link alcançável pelo teclado", () => {
  const attrs = /<a ([^>]*)>doc<\/a>/.exec(mdRender("[doc](contextos/x.md)"));
  assert.ok(attrs, "a referência interna continua sendo um <a>");
  assert.match(attrs[1], /href="/, "sem href o <a> não recebe foco nem é anunciado como link");
  assert.match(attrs[1], /data-path="contextos\/x\.md"/, "o app segue interceptando pelo data-path");
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

// R18 — mdRender emitia um <p> por LINHA DA FONTE. Todo parágrafo com quebra
// dura (markdown normal, e como o manual embarcado é escrito) virava uma pilha
// de fragmentos, a marcação que atravessava a quebra nunca era interpretada
// (o usuário lia o `_` literal) e a continuação de um item de lista escapava
// como parágrafo solto. CommonMark: linhas consecutivas são UM parágrafo.
test("mdRender: linhas consecutivas são um só parágrafo", () => {
  assert.strictEqual(
    mdRender("uma frase longa que\nquebrou em duas linhas\n"),
    "<p>uma frase longa que quebrou em duas linhas</p>"
  );
});

test("mdRender: linha em branco separa parágrafos", () => {
  assert.strictEqual(mdRender("um\n\ndois\n"), "<p>um</p><p>dois</p>");
});

test("mdRender: ênfase e link atravessam a quebra de linha", () => {
  assert.strictEqual(
    mdRender("_O Loro captura sua fala\ne guarda por tema._"),
    "<p><em>O Loro captura sua fala e guarda por tema.</em></p>"
  );
  assert.match(
    mdRender("veja o [documento\ndo gateway](contextos/x.md) depois"),
    /<a [^>]*>documento do gateway<\/a> depois/
  );
});

test("mdRender: item de lista com quebra continua no mesmo item", () => {
  const html = mdRender("- **Os três destinos** ficam no cabeçalho: **Início** (o que\n  guardar hoje)\n- outro\n");
  assert.match(
    html,
    /<li><strong>Os três destinos<\/strong> ficam no cabeçalho: <strong>Início<\/strong> \(o que guardar hoje\)<\/li>/
  );
  assert.doesNotMatch(html, /<p>/, "a continuação não escapa como parágrafo solto");
});

test("mdRender: bloco de código nunca junta linhas", () => {
  assert.strictEqual(
    mdRender("```\nlinha um\nlinha dois\n```\n"),
    "<pre><code>linha um\nlinha dois\n</code></pre>"
  );
});

test("mdRender: título e item de lista interrompem o parágrafo", () => {
  assert.strictEqual(
    mdRender("texto\n# T\noutro\n- item\ncontinua"),
    "<p>texto</p><h1>T</h1><p>outro</p><ul><li>item continua</li></ul>"
  );
});

// A citação é a exceção deliberada à continuação preguiçosa: o callout de
// hotspot do documento de conhecimento (templates.rs) é uma linha por campo.
test("mdRender: a citação mantém uma linha por linha", () => {
  assert.strictEqual(
    mdRender("> [!HOTSPOT] H-1 — título\n> onde: api/gateway\n"),
    '<blockquote class="hotspot"><p class="hstitle">H-1 — título</p><p>onde: api/gateway</p></blockquote>'
  );
});

// N25 · `[!HOTSPOT]` é sintaxe de máquina: o template a escreve para que o agente
// reencontre o ponto em aberto (templates.rs), e ela chegava CRUA ao leitor, na
// superfície que a ADR-0018 define como a saída do produto. O marcador é
// consumido e vira o callout que ele sempre nomeou.
test("N25 — o marcador [!HOTSPOT] não chega ao leitor; ele vira o callout", () => {
  const out = mdRender("> [!HOTSPOT] título curto do ponto em aberto\n> O que está indefinido e por quê.\n");
  assert.ok(!out.includes("[!HOTSPOT]"), `o marcador chegou à tela: ${out}`);
  assert.match(out, /<blockquote class="hotspot">/, "o bloco precisa se identificar para a folha de estilo");
  assert.match(out, /<p class="hstitle">título curto do ponto em aberto<\/p>/,
    "a primeira linha do hotspot é o título dele");
  // uma citação comum não vira callout
  assert.strictEqual(mdRender("> só uma citação"), "<blockquote><p>só uma citação</p></blockquote>");
});

// O marcador vem do template do backend: se o template mudar a grafia, o leitor
// volta a mostrar sintaxe. Os dois lados são checados contra a MESMA string.
test("N25 — o renderer consome exatamente o marcador que o template escreve", () => {
  const templates = fs.readFileSync(
    path.join(__dirname, "..", "src-tauri", "src", "templates.rs"), "utf8");
  const m = /^> (\[![A-Z]+\]) /m.exec(templates);
  assert.ok(m, "o template de conhecimento continua abrindo o ponto em aberto com um marcador");
  assert.strictEqual(m[1], "[!HOTSPOT]");
  const out = mdRender(`> ${m[1]} H-9 — vindo do template\n`);
  assert.ok(!out.includes(m[1]), `o renderer não consome o marcador do template: ${out}`);
});

test("mdRender: dois espaços no fim da linha viram quebra dura", () => {
  assert.strictEqual(mdRender("linha um  \nlinha dois"), "<p>linha um<br>linha dois</p>");
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
