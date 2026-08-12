// O wizard de projeto tem DOIS caminhos de entrada: openNewAcervo (menu
// "novo projeto") e o primeiro uso, em que brainRefresh o mostra sozinho
// (st.configured=false). O bug: só o primeiro caminho preparava os campos —
// numa instalação nova o seletor "como o time trabalha" ficava vazio e a
// linha "cor do projeto" não tinha nenhuma cor. Estes testes prendem a
// estrutura: um preparador único, chamado pelos dois caminhos.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const APP = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");
const CSS = fs.readFileSync(path.join(__dirname, "..", "src", "style.css"), "utf8");

test("existe um preparador único do wizard (templates + cores)", () => {
  const m = APP.match(/function resetWizardFields\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, "app.js deve definir resetWizardFields()");
  assert.match(m[1], /loadWizTemplates\(\)/, "o preparador carrega os modelos de uso");
  assert.match(m[1], /drawWizColors\(\)/, "o preparador desenha a paleta de cores");
});

test("openNewAcervo usa o preparador em vez de duplicá-lo", () => {
  const m = APP.match(/function openNewAcervo\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, "app.js deve definir openNewAcervo()");
  assert.match(m[1], /resetWizardFields\(\)/);
});

test("brainRefresh prepara o wizard do primeiro uso (e só uma vez)", () => {
  const m = APP.match(/async function brainRefresh\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, "app.js deve definir brainRefresh()");
  // o caminho do primeiro uso chama o preparador…
  assert.match(m[1], /resetWizardFields\(\)/,
    "sem isto, uma instalação nova abre o wizard com o seletor de modelos vazio e sem cores");
  // …guardado por uma flag: brainRefresh roda a cada 10s e não pode apagar o
  // que o usuário já digitou no formulário
  assert.match(m[1], /wizInited/,
    "o preparo tem de ser único por exibição — o poll de 10s não pode limpar o formulário");
});

// Rodada seguinte (dono, 2026-08-11): "garantir que TODOS os dados apareçam"
// — o wizard não esconde nada nem mente sobre estado.

test("o wizard não tem opções avançadas: todos os campos são visíveis", () => {
  assert.ok(!/wizadv/.test(HTML), "o <details> de opções avançadas foi removido — tudo aparece");
  // os três campos que viviam escondidos continuam existindo, agora à vista
  for (const id of ["brainGit", "brainAgentInput", "brainCtxInput"]) {
    assert.ok(HTML.includes(`id="${id}"`), `${id} deve continuar no formulário`);
  }
});

test("o preparador mostra a pasta padrão real e pré-visualiza a cor", () => {
  const m = APP.match(/function resetWizardFields\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m);
  // a pasta que o brain_setup usa quando nada é escolhido aparece de cara,
  // em vez de um "escolher pasta…" mudo
  assert.match(m[1], /default_acervo_dir/, "o wizard busca a pasta padrão do backend");
  // o accent acompanha a cor selecionada NO wizard (teal padrão), não a do
  // acervo ativo — o botão Criar projeto ficava azul com a teal marcada
  assert.match(m[1], /applyAccent\(/, "o preparador aplica o preview da cor");
});

test("o poll não reverte o preview de cor com o wizard aberto", () => {
  const m = APP.match(/function renderSwitch\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m);
  assert.match(m[1], /wizColor/,
    "renderSwitch roda a cada 10s e reaplicava a cor do acervo ativo por cima do preview");
});

// A regra genérica `.wizard .hint { margin-left: 0 }` (duas classes) vencia a
// antiga `.tplhint { … 182px }` (uma classe) — o hint caía sob a coluna dos
// rótulos. A indentação precisa viver numa regra de especificidade ≥ (0,2,0).
test("o hint do modelo alinha à coluna dos campos (e nada o rebaixa)", () => {
  assert.match(CSS, /\.wizcard \.tplhint\s*\{[^}]*182px/,
    "a indentação do hint deve existir como .wizcard .tplhint");
  assert.ok(!/(^|\n)\s*\.tplhint\s*\{/.test(CSS),
    "não pode sobrar regra .tplhint de classe única — ela perde para .wizard .hint e regride o alinhamento");
});

// "temas iniciais" mora ao lado de "como o time trabalha" (dono, 2026-08-11):
// o modelo sugere os temas, então formam uma seçãozinha — e cada um explica o
// que faz com um hint alinhado à coluna dos campos.
test("temas iniciais fica adjacente ao modelo de uso, antes de onde guardar", () => {
  const tpl = HTML.indexOf('id="wizTemplates"');
  const ctx = HTML.indexOf('id="brainCtxInput"');
  const dir = HTML.indexOf('id="brainDirBtn"');
  assert.ok(tpl >= 0 && ctx >= 0 && dir >= 0);
  assert.ok(tpl < ctx && ctx < dir, "ordem esperada: modelo → temas → onde guardar");
  // o campo de temas tem uma explicação própria (hint) logo depois dele
  const after = HTML.slice(ctx, dir);
  assert.match(after, /class="hint tplhint"/, "temas iniciais leva um hint explicando o que são");
});

// "onde guardar" também explica o que é (dono, 2026-08-11): resumo sempre à
// vista e o detalhe atrás de um ⓘ de CLIQUE — exceção deliberada à ADR-0020,
// que revogou os tooltips de hover.
test("onde guardar tem resumo à vista e detalhe atrás de um ⓘ de clique", () => {
  const dir = HTML.indexOf('id="brainDirBtn"');
  const lang = HTML.indexOf('id="wizLang"');
  const between = HTML.slice(dir, lang);
  assert.match(between, /id="wizDirInfo"/, "o ⓘ mora logo abaixo do campo da pasta");
  assert.match(between, /id="wizDirInfoBody"[^>]*hidden/, "o detalhe começa recolhido");
  // é um botão com estado acessível, não um title de hover
  assert.match(between, /aria-expanded="false"/);
  assert.match(APP, /wizDirInfo/, "app.js liga o clique do ⓘ");
});

// "abrir manual" na apresentação não fazia nada no primeiro uso: a aba do
// manual abre no shell, que o wizard esconde. Sem shell → modal de leitura.
test("o manual abre mesmo sem projeto (modal quando o shell está oculto)", () => {
  const m = APP.match(/async function openManual\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, "app.js deve definir openManual()");
  assert.match(m[1], /B\.shell\.hidden/, "decide pela visibilidade do shell");
  assert.match(m[1], /mdRender/, "sem shell, renderiza o manual num modal");
  // todos os chamadores passam pelo desvio — nenhum openDoc(MANUAL_REL) direto
  const direct = [...APP.matchAll(/openDoc\(MANUAL_REL[^)]*\)/g)];
  assert.strictEqual(direct.length, 1, "só o próprio openManual abre a aba do manual");
});
