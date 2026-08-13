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

// ---------------------------------------------------------------------------
// "onde guardar" era um BOTÃO que só abre o diálogo de pastas do macOS: o campo
// obrigatório do primeiro uso não tinha como ser preenchido pelo teclado, um
// caminho que o usuário já conhece não podia ser colado, e nenhuma verificação
// automatizada conseguia criar um projeto (o diálogo é do sistema). Agora é um
// campo de texto com o picker ao lado, validado do mesmo jeito que o backend
// usa o valor — e o que vai acontecer com o caminho é dito na cópia
// (DESIGN.md §1: o preço está na cópia; §2/§9: simples para quem começa sem
// limitar quem já sabe).
const { EN } = require("../src/i18n.js");

function fnSource(name) {
  const re = new RegExp("(?:async )?function " + name + "\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}");
  const m = APP.match(re);
  assert.ok(m, `app.js deve definir ${name}()`);
  return m[0];
}
// Mesma técnica de meeting-state.test.js: a função PURA é extraída do fonte e
// avaliada isolada, então o teste exercita o código que o app roda.
function loadValidator() {
  // eslint-disable-next-line no-new-func
  return new Function(
    fnSource("normalizeAcervoDir") + "\n" +
    fnSource("isAbsoluteAcervoDir") + "\n" +
    fnSource("validateAcervoDir") + "\n" +
    "return { normalizeAcervoDir, validateAcervoDir };"
  )();
}

test("onde guardar é um campo de texto, com o picker ao lado", () => {
  // o rótulo e o campo formam a mesma linha de formulário
  const field = /<label class="wfield">\s*<span[^>]*>onde guardar<\/span>\s*<input id="brainDirInput"([^>]*)>/.exec(HTML);
  assert.ok(field, "o campo da pasta deve ser um <input> dentro do .wfield de 'onde guardar'");
  assert.match(field[1], /type="text"/, "um caminho é digitado/colado como texto");
  assert.match(field[1], /aria-describedby="brainDirNote"/,
    "o campo aponta para a frase que explica o que vai acontecer com o caminho");
  // o diálogo do sistema continua existindo — como conveniência, não como o
  // único caminho
  assert.match(HTML, /id="brainDirBtn"[^>]*>escolher pasta…</,
    "o picker continua na tela, ao lado do campo");
  assert.match(APP, /B\.dirBtn\.addEventListener\("click"[\s\S]{0,220}pick_folder/,
    "o botão continua abrindo o diálogo de pastas");
  assert.match(APP, /if \(d\) \{ wizDirDirty = true; setWizDir\(d\); \}/,
    "o que o picker devolve entra NO CAMPO (senão o campo e a escolha divergem)");
});

test("o preparador escreve a pasta padrão DENTRO do campo", () => {
  const m = APP.match(/function resetWizardFields\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m);
  // N19 · o valor escrito no campo passou a ser a pasta padrão LIVRE (a constante
  // já pertencia ao primeiro projeto e abria o formulário em vermelho) — continua
  // sendo valor editável do campo, não rótulo de botão
  assert.match(m[1], /setWizDir\(freeAcervoDir\(wizDefaultDir, acervos, creatingNew\)\)/,
    "o padrão real aparece como valor editável do campo, não como rótulo de um botão");
  assert.ok(!/B\.dirBtn\.textContent/.test(APP),
    "o rótulo do picker não é mais o lugar onde o caminho vive");
});

test("o caminho digitado é normalizado como o backend o compara", () => {
  const { normalizeAcervoDir, validateAcervoDir } = loadValidator();
  // resolve_acervo_slot compara a pasta por STRING EXATA: uma barra sobrando
  // passaria pela porta que recusa uma pasta já tomada
  assert.equal(normalizeAcervoDir("  /Users/eu/Documents/Loro/  "), "/Users/eu/Documents/Loro");
  assert.equal(normalizeAcervoDir("/Users/eu//Documents///Loro"), "/Users/eu/Documents/Loro");
  assert.equal(normalizeAcervoDir("/"), "/");
  // a raiz de um volume é a própria pasta (o app também roda no Windows)
  assert.equal(normalizeAcervoDir("C:\\"), "C:\\");
  assert.equal(normalizeAcervoDir("C:\\Users\\eu\\Loro\\"), "C:\\Users\\eu\\Loro");
  // campo vazio = a pasta padrão, exatamente o que o brain_setup faz — e a tela
  // diz QUAL pasta é, em vez de ficar em branco
  const vazio = validateAcervoDir("   ", "/Users/eu/Documents/Loro", [], false);
  assert.equal(vazio.dir, "/Users/eu/Documents/Loro");
  assert.equal(vazio.err, "");
  assert.equal(vazio.usedDefault, true);
  assert.ok(EN[vazio.note], `a nota precisa de par em inglês: ${vazio.note}`);
  const painter = fnSource("paintWizDirNote");
  assert.match(painter, /usedDefault && st\.dir\) msg \+= " — " \+ st\.dir/,
    "o caminho é valor, não msgid: ele entra ao lado da frase");
  // a pasta padrão chega por promessa: até ela chegar, o campo intocado não pode
  // ser acusado em vermelho de estar vazio
  assert.match(painter, /!typed && !wizDirDirty && !wizDefaultDir/,
    "sem padrão conhecido e sem digitação, a frase fica calada");
});

test("um caminho que o backend não resolveria é recusado, dizendo o que fazer", () => {
  const { validateAcervoDir } = loadValidator();
  const casos = [
    ["~/Documents/Loro", "o ~ não é expandido por PathBuf::from"],
    ["Documents/Loro", "um caminho relativo cairia no diretório do processo"],
    ["/Users/eu/../eu/Loro", "'..' escapa da pasta que o usuário acha que escolheu"],
  ];
  for (const [entrada, porque] of casos) {
    const st = validateAcervoDir(entrada, "/Users/eu/Documents/Loro", [], true);
    assert.ok(st.err, `${entrada} deveria ser recusado: ${porque}`);
    assert.ok(EN[st.err], `a recusa precisa de par em inglês: ${st.err}`);
  }
});

test("uma pasta que já é outro projeto é recusada antes de qualquer escrita", () => {
  const { validateAcervoDir } = loadValidator();
  const acervos = [{ id: "a1", name: "Empresa", dir: "/Users/eu/Documents/Loro" }];
  // novo projeto: a porta é de mão única (ADR-0024) e a recusa NOMEIA o dono
  const novo = validateAcervoDir("/Users/eu/Documents/Loro/", "/x", acervos, true);
  assert.equal(novo.err, "err.acervo_dir_taken:Empresa");
  // reconfigurar o MESMO projeto é legítimo: nada de recusa, e a cópia diz que
  // o conteúdo fica
  const mesmo = validateAcervoDir("/Users/eu/Documents/Loro", "/x", acervos, false);
  assert.equal(mesmo.err, "");
  assert.ok(EN[mesmo.note], `a nota precisa de par em inglês: ${mesmo.note}`);
});

test("uma pasta que ainda não existe é aceita — e a cópia diz que será criada", () => {
  const { validateAcervoDir } = loadValidator();
  const st = validateAcervoDir("/Users/eu/Projetos/Time", "/Users/eu/Documents/Loro", [], true);
  assert.equal(st.err, "");
  assert.equal(st.dir, "/Users/eu/Projetos/Time");
  assert.ok(st.note, "o campo não pode ficar calado sobre uma pasta inexistente");
  assert.ok(EN[st.note], `a nota precisa de par em inglês: ${st.note}`);
});

test("criar projeto recusa o caminho ANTES do estado pendente", () => {
  const m = APP.match(/B\.createBtn\.addEventListener\("click", async \(\) => \{([\s\S]*?)\n\}\);/);
  assert.ok(m, "app.js deve ligar o clique de Criar projeto");
  const body = m[1];
  const val = body.indexOf("wizDirState()");
  const pend = body.indexOf('t("criando…")');
  const setup = body.indexOf('invoke("brain_setup"');
  assert.ok(val >= 0 && pend >= 0 && setup >= 0);
  assert.ok(val < pend, "validar depois de pintar 'criando…' faz o usuário esperar por uma recusa já conhecida");
  assert.match(body, /dir: dirSt\.dir/, "o brain_setup recebe o caminho JÁ normalizado");
});

// ---------------------------------------------------------------- N20
// Com um projeto já em ~/Documents/Loro, o wizard prefilla o campo com a pasta
// LIVRE (freeAcervoDir → …/Loro-2). Apagar o campo caía na CONSTANTE crua do
// backend — que é justamente a pasta do primeiro projeto — e a recusa dizia
// "esta pasta já é o projeto “Empresa”" com o campo vazio: nem a pasta nem o
// projeto de que ela fala estavam na tela.
test("N20 — o campo vazio cai na pasta que o próprio wizard ofereceu", () => {
  const src = fnSource("wizDirState");
  assert.match(src, /freeAcervoDir\(wizDefaultDir, acervos, creatingNew\)/,
    "o padrão do campo vazio tem de ser o MESMO valor que o campo veio preenchido");
  assert.ok(!/validateAcervoDir\(\s*B\.dirInput \? B\.dirInput\.value : "",\s*wizDefaultDir,/.test(src),
    "a constante crua do backend já pertence ao primeiro projeto");

  // e o efeito, exercitando as funções puras juntas como o app as usa
  // eslint-disable-next-line no-new-func
  const puro = new Function(
    fnSource("normalizeAcervoDir") + "\n" +
    fnSource("isAbsoluteAcervoDir") + "\n" +
    fnSource("freeAcervoDir") + "\n" +
    fnSource("validateAcervoDir") + "\n" +
    "return { freeAcervoDir, validateAcervoDir };"
  )();
  const acervos = [{ id: "a1", name: "Empresa", dir: "/Users/eu/Documents/Loro" }];
  const oferecida = puro.freeAcervoDir("/Users/eu/Documents/Loro", acervos, true);
  assert.equal(oferecida, "/Users/eu/Documents/Loro-2");
  const st = puro.validateAcervoDir("", oferecida, acervos, true);
  assert.equal(st.err, "", "apagar o campo não pode acusar o projeto de outra pasta");
  assert.equal(st.dir, "/Users/eu/Documents/Loro-2");
  assert.equal(st.usedDefault, true);
});

test("N20 — uma recusa de campo vazio também mostra a pasta de que fala", () => {
  const { validateAcervoDir } = loadValidator();
  const acervos = [{ id: "a1", name: "Empresa", dir: "/Users/eu/Documents/Loro" }];
  // o caso que sobra: a pasta oferecida também está tomada (o app conhece a
  // pasta e a recusa fala de "esta pasta")
  const st = validateAcervoDir("", "/Users/eu/Documents/Loro", acervos, true);
  assert.equal(st.err, "err.acervo_dir_taken:Empresa");
  assert.equal(st.usedDefault, true,
    "sem isto o pintor não sabe que o caminho não está à vista no campo");
  assert.equal(st.dir, "/Users/eu/Documents/Loro");
  const painter = fnSource("paintWizDirNote");
  assert.match(painter, /if \(st\.usedDefault && st\.dir\) msg \+= " — " \+ st\.dir;/,
    "o caminho entrava só no ramo do sucesso: a recusa apontava para nada");
});
