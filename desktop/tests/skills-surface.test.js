// Critic round 2 — the habilidades/painel lens. Same family as always: a
// control the interface offers to one input mode only, or a state it asserts
// without checking.
//
//   N9   ⌘K: a seleção por seta nunca rolava para a linha escolhida
//   N10  a camada de anotações (ADR-0007) só existia para o mouse: grifar,
//        comentar e desgrifar não tinham caminho de teclado nenhum
//   N11/N28  com o terminal na doca de baixo, a aba Terminal ficava
//        aria-selected sobre um painel VAZIO, e o ⇆ nomeava-se "⇆"
//   N13  vocabulário interno (slug /loro-…, ADR-nnnn) chegando à tela
//   N14  rodar uma habilidade com argumentos obrigatórios vazios "deu certo"
//   N15  "todas as habilidades de IA (12)" abrindo um menu de 14
//   N16  o ⋯ anunciava "excluir" nas 11 padrão que a escondem, e apagava por
//        window.confirm
//
// DESIGN.md §1/§4/§5, WCAG 2.1.1 (teclado), 4.1.2 (nome/estado), 2.4.7.
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
function loadPure(name) {
  // eslint-disable-next-line no-new-func
  return new Function("const t = (s) => s;\nreturn (" + fnSource(name) + ");")();
}
function tagWithId(id) {
  const m = HTML.match(new RegExp('<[a-z0-9]+[^>]*\\bid="' + id + '"[^>]*>'));
  assert.ok(m, `index.html deve conter #${id}`);
  return m[0];
}
function pair(msgid) {
  assert.ok(EN[msgid] && EN[msgid] !== msgid, `falta o par em inglês de “${msgid}”`);
}

// ---------------------------------------------------------------- N9
test("N9 — a linha selecionada da paleta entra em vista", () => {
  const body = fnBody("setCmdkIndex");
  assert.match(body, /scrollIntoView/,
    "com 26 opções em 46vh, ↑/↓ mudavam uma linha fora da área visível");
  assert.match(body, /nearest/, "rolar o mínimo: a lista não pode saltar sob o cursor");
});

// ---------------------------------------------------------------- N10
test("N10 — uma marca de anotação é um controle focável e anunciado", () => {
  const body = fnBody("wireMarks");
  assert.match(body, /tabindex/, "só tinha onclick: o teclado não alcançava nenhum grifo");
  assert.match(body, /role/);
  assert.match(body, /aria-label|setAttribute\("aria-label"/);
  assert.match(body, /wireActivateKeys\(/);
});

// A primeira volta deu ao popover um role="menu", um nome e um Escape próprios. Um
// role="menu" cujos filhos não são menuitem é um menu de ZERO itens para quem lê a
// tela (e aria-required-children no axe), sem setas, sem Home/End e com cada botão
// virando uma parada de Tab — enquanto o app já tem UM comportamento de menu
// flutuante (F17: wireFloatMenu, usado pelos 14 outros). Duas anatomias para o mesmo
// objeto é o que DESIGN.md §5 proíbe; as garantias da primeira volta continuam
// exigidas aqui, agora no lugar onde valem para todos.
test("N10 — o popover de anotação é um menu de verdade, pelo helper único", () => {
  const open = fnBody("openSelectionPopover") + fnBody("openMarkPopover");
  assert.match(open, /focusAnnotPop\(/, "o foco entra no popover — senão ele existe e não se alcança");
  const entry = fnBody("focusAnnotPop");
  assert.match(entry, /wireFloatMenu\(/, "o teclado do popover é o mesmo dos outros menus (F17)");
  assert.match(entry, /closeAnnotPop/, "com o SEU fechador: o Escape não pode fechar outro menu");
  const helper = fnBody("wireFloatMenu");
  assert.match(helper, /role", "menu"/, "o papel é declarado num lugar só");
  assert.match(helper, /menuitem/, "cada ação é um menuitem — hoje era um menu de zero itens");
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Escape"]) {
    assert.match(helper, new RegExp(key), `o popover herda ${key} do helper`);
  }
  // o nome do popover é do autor (a superfície de leitura não ganha cabeçalho
  // visível): o helper não pode apagá-lo ao passar
  assert.match(fnBody("positionPop") + fnBody("annotPop"), /aria-label/);
  assert.match(
    helper,
    /autolabel[\s\S]*removeAttribute\("aria-label"\)/,
    "o helper só limpa o nome que ele mesmo escreveu — senão o popover perde o dele ao passar",
  );
  // e fechar devolve o foco a quem abriu, dizendo que fechou (4.1.2)
  const close = fnBody("closeAnnotPop") + fnBody("hideAnnotPop");
  assert.match(close, /aria-expanded/, "a marca continuava 'expandida' com o popover fechado");
  assert.match(close, /focus\(\)/);
});

test("N10 — grifar tem caminho de teclado: o trecho pode ser digitado", () => {
  assert.match(APP, /function promptAnnotateExcerpt/);
  const cmds = APP.slice(APP.indexOf("const COMMANDS = ["), APP.indexOf("function availableCommands"));
  assert.match(cmds, /promptAnnotateExcerpt\(\)/, "a paleta é o caminho sem mouse");
  const f = loadPure("excerptRangeIn");
  assert.deepEqual(f("a base da frota é local", "da frota"), { start: 7, end: 15 });
  assert.deepEqual(f("A Base da Frota", "base da frota"), { start: 2, end: 15 });
  assert.equal(f("nada aqui", "outra coisa"), null);
  assert.equal(f("nada aqui", "   "), null);
  pair("não encontrei esse trecho no documento");
});

// ------------------------------------------------------------ N11 / N28
test("N11/N28 — mover o terminal para baixo não deixa a aba Terminal sobre o vazio", () => {
  const body = fnBody("applyTermLayout");
  assert.match(body, /aiPanelTab/, "a aba continuava selecionada sobre um painel vazio");
  assert.match(body, /!side|side \? /, "a decisão depende do lado em que o terminal está");
  // e o painel, quando o terminal não mora nele, diz onde ele está e oferece a volta
  assert.match(APP, /function paintPanelTermPlaceholder/);
  const ph = fnBody("paintPanelTermPlaceholder");
  assert.match(ph, /panelTerm/);
  assert.match(ph, /data-termback|termBack/, "um vazio orienta o passo seguinte (§5)");
  pair("o terminal está na doca embaixo");
  pair("trazer para o painel");
});

test("N11 — a aba Terminal não inverte em silêncio a escolha da doca", () => {
  const h = APP.slice(APP.indexOf('document.querySelectorAll("#panelTabs .ptab")'));
  const handler = h.slice(0, h.indexOf("}));") + 4);
  assert.ok(!/settings\.termSide = true/.test(handler),
    "clicar na aba desfazia a escolha do usuário sem dizer nada — e antes do persist");
  assert.match(handler, /persistSettings\(\)/);
});

test("N11 — o ⇆ diz em que estado está", () => {
  assert.match(APP, /function paintTermSideBtn/);
  const p = fnBody("paintTermSideBtn");
  assert.match(p, /aria-label/, "o nome acessível era o próprio glifo “⇆”");
  assert.match(p, /termSide/);
  pair("mover o terminal para baixo");
  pair("mover o terminal para o painel");
  // F25/C28 · quem escreve o nome em tempo de execução é o DONO dele: um
  // data-i18n-attrs no mesmo atributo o devolveria ao rótulo estático na troca de
  // idioma (o mesmo defeito do pill do chat), e por isso o repintor entra no
  // rerenderForLang
  assert.ok(!/id="termSide"[^>]*data-i18n-attrs/.test(HTML));
  assert.match(fnBody("rerenderForLang"), /paintTermSideBtn\(\)/);
});

test("N11 — na doca de baixo o terminal tem como sair da tela", () => {
  assert.match(HTML, /id="termHide"/,
    "com o painel fechado, nem a aba nem o × controlavam a doca: 34vh presos");
  assert.match(APP, /termHide/);
});

// ---------------------------------------------------------------- N13
test("N13 — a folha 'usar' chama a habilidade pelo nome do usuário, não pelo slug", () => {
  const body = fnBody("promptUseTool");
  assert.ok(!/\$\{t\("usar"\)\} \/\$\{slug\}/.test(body),
    "o título era USAR /LORO-ANALYSE sob uma linha chamada 'analisar reunião'");
  assert.match(body, /habilidadeLabelByRel|labelFor/);
  assert.match(APP, /function habilidadeLabelByRel/);
  // o rótulo depende da tabela real e do shortName reais: as três peças entram
  // juntas, senão o teste validaria uma cópia
  const labels = APP.match(/const TOOL_LABELS = \{[\s\S]*?\n\};/);
  const short = APP.match(/const shortName = .*;/);
  assert.ok(labels && short);
  // eslint-disable-next-line no-new-func
  const f = new Function("const t = (s) => s;\n" + labels[0] + "\n" + short[0] + "\n" +
    fnSource("habilidadeLabel") + "\nreturn (" + fnSource("habilidadeLabelByRel") + ");")();
  assert.equal(f(".claude/skills/loro-analyse.md"), "analisar reunião");
  assert.equal(f("x/loro-sync.md"), "sincronizar fontes");
  assert.equal(f("x/minha-skill.md"), "minha-skill");
});

test("N13 — loro-sync tem rótulo próprio (não aparecia pelo nome do arquivo)", () => {
  const labels = APP.slice(APP.indexOf("const TOOL_LABELS = {"), APP.indexOf("// O nome do ARQUIVO"));
  assert.match(labels, /"loro-sync\.md":/);
  pair("sincronizar fontes");
});

test("N13 — o chat registra a ação escolhida, não a barra interna", () => {
  // N8 · o despacho da folha passou a ser o `…FromSheet` (a folha sai da frente
  // do chat/terminal que ela abre); o que a bolha registra continua sendo o rótulo
  assert.match(fnBody("promptUseTool"), /dispatchAiFromSheet\([\s\S]*?,\s*null,\s*label\)/,
    "a bolha do chat mostrava /loro-question");
});

// ---------------------------------------------------------------- N14
test("N14 — rodar sem os argumentos obrigatórios é recusado, não celebrado", () => {
  const body = fnBody("promptUseTool");
  assert.match(body, /required|obrigat/i, "a folha declarava <dir> <pergunta> e despachava vazio");
  assert.match(body, /toast\(/);
  const f = loadPure("missingRequiredArgs");
  assert.equal(f(["<dir-da-reuniao>", "<pergunta>"], ""), true);
  assert.equal(f(["<dir-da-reuniao>"], "meetings/x"), false);
  assert.equal(f(["[opcional]"], ""), false, "um token opcional não bloqueia");
  assert.equal(f([], ""), false);
  pair("preencha os argumentos pedidos");
});

// ---------------------------------------------------------------- N15
test("N15 — a contagem é a do menu que o controle abre", () => {
  const body = fnBody("renderDocRail");
  assert.ok(!/lastToolFiles\.length/.test(body),
    "o rótulo contava arquivos e o menu listava entradas: os dois números nunca batem");
  assert.match(body, /allHabilidadeEntries\("doc"\)\.length|entries\.length/);
});

test("N15 — importar uma habilidade repinta os contadores na hora", () => {
  const body = fnBody("renderTools");
  assert.match(body, /footSkillsN|renderPanelForActive|repaint/,
    "o rótulo ficava em 11 enquanto a árvore já tinha 12");
});

// ---------------------------------------------------------------- N16
test("N16 — o ⋯ anuncia só o que o menu tem", () => {
  const body = fnBody("toolRow");
  assert.match(body, /builtin \?/, "o mesmo nome fixo prometia excluir nas 11 padrão");
  assert.match(body, /ações \(usar, editar, pedir à IA\)/);
  pair("ações (usar, editar, pedir à IA)");
});

test("N16 — excluir uma habilidade usa a folha do app, não o confirm do sistema", () => {
  const body = fnBody("delTool");
  assert.ok(!/confirm\(/.test(body), "um diálogo nativo está fora do sistema de design (§5)");
  assert.match(body, /openConfirmDeleteTool|openModal\(/);
});

test("N16 — o ＋ das habilidades tem nome", () => {
  const tag = tagWithId("addToolBtn");
  assert.match(tag, /aria-label="[^"]+"/, "o nome acessível era “＋”, igual a outros dois");
});

// ============================================================ critic round 4
//   N10  a aba Terminal do painel continuava dizendo que o terminal está em
//        outro lugar com o terminal rodando logo abaixo da frase
//   N11  "Grifar um trecho…" pelo teclado focava o PRIMEIRO grifo do documento,
//        não o que acabou de nascer — e dali o Enter → desgrifar apagava outra
//        passagem
//   N12  grifar dentro de uma habilidade fazia do sidecar de anotações uma
//        habilidade falsa que não dava para excluir

// ---------------------------------------------------------------- N10
test("N10 — quando o terminal está no painel, o vazio inteiro sai da tela", () => {
  const body = fnBody("paintPanelTermPlaceholder");
  const mounted = body.slice(0, body.indexOf("const old"));
  assert.ok(!/ph\.remove\(\)/.test(mounted),
    "só o BOTÃO saía: a caixa “o terminal está na doca embaixo” ficava por cima do terminal vivo");
  assert.match(mounted, /\.pempty|closest\("\.pempty"\)|removePanelTermPlaceholder/,
    "o ramo montado tem de remover a caixa toda, como o outro ramo já faz");
});

test("N10 — os dois ramos removem pelo MESMO caminho", () => {
  const body = fnBody("paintPanelTermPlaceholder");
  const quantos = (body.match(/removePanelTermPlaceholder\(host\)/g) || []).length;
  assert.ok(quantos >= 2,
    `um ramo removia a caixa e o outro removia o botão; achei ${quantos} remoções pela função única`);
  const rem = fnBody("removePanelTermPlaceholder");
  assert.match(rem, /pempty/, "a remoção é da caixa, não do botão");
});

// ---------------------------------------------------------------- N11
test("N11 — o teclado foca o grifo que ACABOU de nascer, não o primeiro", () => {
  const body = fnBody("promptAnnotateExcerpt");
  assert.ok(!/querySelector\("mark\.annot\[data-annot-id\]"\)/.test(body),
    "querySelector devolve o primeiro do documento: o Enter → desgrifar apagava outra passagem");
  assert.match(body, /const id = await ensureHighlight\(anchor\)/,
    "ensureHighlight já devolve o id da anotação nova e ele era descartado");
  assert.match(body, /data-annot-id="\$\{id\}"|\[data-annot-id="/,
    "o foco vai para a marca daquele id");
});

test("N11 — sem id não há foco em marca nenhuma", () => {
  const body = fnBody("promptAnnotateExcerpt");
  assert.match(body, /if \(!id\)/,
    "se a anotação não foi criada, focar “alguma” marca é agir sobre o objeto errado");
});

// ---------------------------------------------------------------- N12
test("N12 — a lista de habilidades só aceita habilidades", () => {
  const body = fnBody("refreshTools");
  assert.match(body, /\.md/, "qualquer arquivo em .claude/commands virava uma habilidade");
  assert.match(body, /filter\(\(f\) => !f\.dir && f\.name\.endsWith\("\.md"\)\)/,
    "o excluir do backend só aceita .md: uma linha que não é .md só sabe recusar");
});

test("N12 — o sidecar de anotações é arquivo da máquina: não entra em listagem", () => {
  const acervo = fs.readFileSync(path.join(__dirname, "..", "src-tauri", "src", "acervo.rs"), "utf8");
  assert.match(acervo, /pub const SIDECAR_SUFFIX: &str = "\.anotacoes\.json";/,
    "o sufixo tem de ter um dono só");
  const lib = fs.readFileSync(path.join(__dirname, "..", "src-tauri", "src", "lib.rs"), "utf8");
  const dir = lib.match(/fn brain_list_dir\(rel: String\)[\s\S]*?\n\}/);
  assert.ok(dir, "lib.rs deve definir brain_list_dir()");
  assert.match(dir[0], /SIDECAR_SUFFIX/,
    "notas e anexos ganhavam um *.anotacoes.json ao lado do documento grifado");
});

// ---------------------------------------------------------------- N14
// refreshTools() guarda `description:`/`fonte:` de cada habilidade atrás de uma
// assinatura feita só de NOMES DE ARQUIVO. Editar a habilidade não muda nome
// nenhum, então o seletor seguia oferecendo a skill de ontem pela sessão inteira
// — contra a promessa da ADR-0005 §2 ("quem edita a habilidade para acrescentar
// uma fonte a vê no seletor"). O app acabou de ESCREVER o arquivo: é o momento
// em que ele sabe que o cache morreu.
test("N14 — salvar uma habilidade invalida o cache que descreve as habilidades", () => {
  const body = fnBody("saveTab");
  assert.match(body, /isHabilidadeRel\(tab\.rel\)/,
    "saveTab tem de reconhecer que o arquivo salvo É uma habilidade");
  assert.match(body, /toolsSig = ""/,
    "sem zerar a assinatura, refreshTools desiste no primeiro if e a descrição fica velha");
  // a assinatura é de nomes: é por isso que editar o conteúdo passa despercebido
  assert.match(fnBody("refreshTools"), /const sig = JSON\.stringify\(files\.map\(\(f\) => f\.name\)\)/);
});

test("N14 — o que conta como habilidade é decidido num lugar só", () => {
  const dirDecl = APP.match(/const TOOLS_DIR = "[^"]+";/);
  assert.ok(dirDecl, "a pasta das habilidades tem de ser uma constante");
  // eslint-disable-next-line no-new-func
  const isHabilidadeRel = new Function(dirDecl[0] + "\nreturn (" + fnSource("isHabilidadeRel") + ");")();
  assert.equal(isHabilidadeRel(".claude/commands/loro-ask.md"), true);
  assert.equal(isHabilidadeRel(".claude/commands/minha.md"), true);
  // um documento comum não pode zerar o cache das habilidades…
  assert.equal(isHabilidadeRel("contexts/plataforma/context.md"), false);
  // …nem um arquivo da máquina que apenas mora na mesma pasta
  assert.equal(isHabilidadeRel(".claude/commands/loro-ask.anotacoes.json"), false);
  assert.equal(isHabilidadeRel(""), false);
  assert.equal(isHabilidadeRel(null), false);
  // o lister e o gravador têm de falar da MESMA pasta
  assert.match(APP, /const TOOLS_DIR = "\.claude\/commands";/);
  assert.match(fnBody("refreshTools"), /brain_list_dir", \{ rel: TOOLS_DIR \}/);
});

// ---------------------------------------------------------------- N15
// A recusa de useExcerptTool era escrita à mão para o Slack e servia às TRÊS
// ações do popover do trecho: clicar em "perguntar" acusava um produto que o
// usuário não escolheu (DESIGN.md §4 — a cópia descreve o que a tela fez).
test("N15 — a habilidade indisponível é nomeada pela ação que o usuário clicou", () => {
  const body = fnBody("useExcerptTool");
  assert.ok(!/"Slack \/ "/.test(body),
    "o nome do produto estava cravado na recusa das três ações");
  assert.match(body, /habilidadeLabel\(\{ name \}\)/,
    "o nome sai do mesmo rótulo que a linha clicada mostra");
  pair("habilidade indisponível");
  // e as três ações continuam passando por aqui (é o único ponto de entrada)
  for (const skill of ["loro-question.md", "loro-analyse.md", "loro-slack.md"]) {
    assert.ok(APP.includes(`useExcerptTool("${skill}"`), `${skill} entra por useExcerptTool`);
  }
});

// ---------------------------------------------------------------- N16
// Sem documento aberto (a paleta em Início) a folha "usar" não tinha alvo: ela
// imprimia o token interno do argument-hint ("<alvo:ideia-conhecimento-ou-nota>")
// como texto E como placeholder, e a única saída era digitar um caminho de disco.
// O vocabulário interno não pode ser pré-requisito para usar o app (DESIGN.md §4).
test("N16 — o alvo do argument-hint é escolhido, não digitado", () => {
  const isAlvoToken = loadPure("isAlvoToken");
  // os tokens que as habilidades do produto realmente declaram (templates.rs)
  assert.equal(isAlvoToken("<alvo:ideia-conhecimento-ou-nota>"), true);
  assert.equal(isAlvoToken("<alvo:ideia>"), true);
  assert.equal(isAlvoToken("<alvo-nota-ou-tema>"), true);
  assert.equal(isAlvoToken("<target:idea-knowledge-or-note>"), true);
  // e nada mais: um argumento de texto continua sendo um campo de texto
  assert.equal(isAlvoToken("<pergunta>"), false);
  assert.equal(isAlvoToken("<descrição>"), false);
  assert.equal(isAlvoToken("[mensagem]"), false);

  const body = fnBody("promptUseTool");
  assert.match(body, /const picking = !fixed && tokens\.length > 0 && isAlvoToken\(tokens\[0\]\)/,
    "só o primeiro token, e só quando ele nomeia um alvo");
  assert.match(body, /<select id="useToolAlvo">/, "o alvo vira um seletor de destinos reais");
  assert.match(body, /const alvo = fixed \|\| \(\(\$\("useToolAlvo"\)/,
    "o que foi escolhido é o que vai no comando");
  assert.match(body, /\(fixed \|\| picking\) && tokens\.length \? tokens\.slice\(1\)/,
    "o token resolvido pelo seletor sai da linha “argumentos:” e do placeholder");
});

test("N16 — uma habilidade de reunião aponta a reunião em vez de pedir a pasta dela", () => {
  const isReuniaoToken = loadPure("isReuniaoToken");
  assert.equal(isReuniaoToken("<dir-da-reuniao>"), true);
  assert.equal(isReuniaoToken("<meeting-dir>"), true);
  assert.equal(isReuniaoToken("<alvo:ideia>"), false);
  const body = fnBody("promptUseTool");
  assert.match(body, /isReuniaoToken\(tokens\[0\]\)/,
    "sem reunião aberta, a folha pedia `<dir-da-reuniao>` digitado à mão");
  assert.match(body, /toast\(t\("abra a reunião para analisar"\)/,
    "a mesma frase que o caminho da reunião já usa quando não há reunião");
  pair("abra a reunião para analisar");
});

test("N16 — os destinos são as casas que o projeto tem, no vocabulário da tela", () => {
  const body = fnBody("alvoDestinations");
  assert.match(body, /brain_list_brainstorms/, "as ideias vêm da mesma fonte de “Salvar nota”");
  assert.match(body, /lastSt && lastSt\.contexts/, "e os conhecimentos, da mesma que a lateral pinta");
  assert.match(body, /brainstorming\/\$\{b\.slug\}/, "o valor é o caminho real que a habilidade recebe");
  assert.match(body, /contexts\/\$\{c\.name\}/);
  for (const m of ["ideias", "conhecimento"]) pair(m);
  // sem nenhuma casa, a folha não abre pedindo um caminho impossível: ela diz o passo
  assert.match(fnBody("promptUseTool"), /crie uma ideia ou um tema antes de rodar esta habilidade/);
  pair("crie uma ideia ou um tema antes de rodar esta habilidade");
});
