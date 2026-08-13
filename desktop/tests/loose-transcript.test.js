// C24 (blocker, critic round 1) — the one-off transcription never landed in the
// project. The end bar asked "guardar no projeto?" and its primary button said
// "Salvar em ideias", but the handler opened a native OS Save panel
// (`save_transcript`) and wrote wherever the user browsed to; the only other exit
// ("Descartar") destroyed the text. the flow closes now: a loose
// transcription is captured material, so it lands as a note in an ideia — the
// non-versioned world — and the app opens it so the user can find it.
//
// DESIGN.md §1: "the interface must not know something it does not say" and every
// flow closes end to end. The suite runs without a DOM, so the seam is the SOURCE
// of app.js/index.html (same style as honest-controls.test.js / wizard.test.js).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
const APP = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const { EN } = require("../src/i18n.js");

function fnSource(name) {
  const re = new RegExp("(?:async )?function " + name + "\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}");
  const m = APP.match(re);
  assert.ok(m, `app.js deve definir ${name}()`);
  return m[0];
}
function fnBody(name) {
  const src = fnSource(name);
  return src.slice(src.indexOf("{") + 1, -1);
}
// Uma função pura de app.js é exercitada de verdade: o fonte é extraído e
// avaliado isolado, com um `t` de identidade (o msgid É o texto em pt).
function loadPure(name) {
  // eslint-disable-next-line no-new-func
  return new Function("const t = (s) => s;\nreturn (" + fnSource(name) + ");")();
}

// ---------------------------------------------------------------- C24
test("C24 — salvar a transcrição avulsa escreve no projeto, não num diálogo do SO", () => {
  const body = fnBody("save");
  assert.ok(!/save_transcript/.test(body),
    "o botão prometia 'Salvar em ideias' e abria o painel Salvar do macOS");
  assert.match(body, /brain_new_notebook|newNoteInIdea/,
    "a transcrição nasce como nota de uma ideia (mundo não versionado)");
});

test("C24 — a nota criada recebe a transcrição e é aberta para o usuário achar", () => {
  const body = fnBody("newNoteInIdea");
  assert.match(body, /brain_new_notebook/, "cria a nota com o front-matter do backend");
  assert.match(body, /brain_write/, "e escreve a transcrição dentro dela");
  const save = fnBody("save");
  assert.match(save, /openDoc\(/, "o resultado abre como aba: o usuário precisa achá-lo");
  assert.match(save, /refreshPessoal\(\)/, "e aparece na lateral sem esperar o próximo tick");
  assert.match(save, /toast\(/, "toda ação tem desfecho");
});

test("C24 — nada é escrito no mundo versionado: uma ideia é o único destino", () => {
  const body = fnBody("save");
  assert.ok(!/contextos\//.test(body),
    "BR-8 — uma transcrição crua não entra em conhecimento (versionado)");
});

test("C24 — a barra do fim descreve exatamente o que cada botão faz", () => {
  // R20 agrupou os três botões em .endacts (a frase precisava de largura para
  // não desabar): a barra é o bloco do savebar até o fim desse grupo
  const m = HTML.match(/<div id="savebar"[\s\S]*?<div class="endacts">[\s\S]*?<\/div>/);
  assert.ok(m, "o savebar continua no lugar");
  assert.match(m[0], /descartar apaga a transcrição — não pode ser desfeito/,
    "o preço de Descartar continua na cópia (F22)");
  assert.match(m[0], /Salvar em ideias/, "a ação primária promete o destino real");
  assert.match(m[0], /id="exportBtn"/,
    "exportar para um arquivo do computador continua possível — com o nome do que faz");
  assert.match(m[0], /class="btn solid sm"/, "uma única ação primária (DESIGN.md §1)");
  assert.equal((m[0].match(/class="btn solid/g) || []).length, 1);
});

test("C24 — exportar é quem fala com o diálogo do SO", () => {
  const body = fnBody("exportTranscript");
  assert.match(body, /save_transcript/);
  assert.match(APP, /el\.exportBtn\.addEventListener\("click", exportTranscript\)/);
});

test("C24 — o título sugerido é datado e não depende do idioma para virar arquivo", () => {
  const looseNoteTitle = loadPure("looseNoteTitle");
  const nome = looseNoteTitle(new Date(2026, 7, 12, 14, 5));
  assert.match(nome, /2026-08-12/, "a sugestão carrega a data da gravação");
  assert.match(nome, /14h05/, "e a hora, para duas gravações do mesmo dia não colidirem");
  assert.ok(!/[^\x20-\x7e]/.test(nome.replace(/conversa/, "")),
    "o backend transforma o título em nome de arquivo ASCII: sem acento na sugestão");
});

test("C24 — os msgids novos têm par em inglês", () => {
  for (const pt of [
    "Salvar em ideias",
    "Exportar arquivo…",
    "Transcrição pronta — guardar no projeto?",
    "vira uma nota da ideia escolhida — o áudio é apagado depois de transcrito",
    "conversa",
    "soltas (sem ideia)",
    "salvo em",
    "não há transcrição para salvar",
  ]) assert.ok(EN[pt] && EN[pt] !== pt, `sem par em inglês: ${pt}`);
});
