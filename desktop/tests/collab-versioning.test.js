// Critic round 2 — the collaboration lens. One family again: the versioning
// surface told the user things the code did not do.
//
//   N1  "Salvar versão" passed the DESCRIPTION as the draft name, so a second
//       version with a different description branched off the default again and
//       the previous version vanished from the open document
//   N5  the same button versions the WHOLE project and no copy said so
//   N7  "última versão salva" was asserted unconditionally — with zero commits
//       and on the read-only manual
//   N8  the history sheet was an editable CM6 with a filled "salvar" that
//       discarded; the draft picker was mouse-only; the version badge was a
//       <span> with a click listener
//   N3  the "corrigir identidade" sheet pre-filled "Seu Nome/seu@email" as a
//       VALUE and accepted it as an e-mail
//   N4  the proposal URL was thrown away and the review counter was a dead end
//   N6  with versioning off the panel still promised the review, ⌘K still
//       offered it, and "verificar" painted nothing
//
// DESIGN.md §1 ("state must never lie", "never show a control that does
// nothing", "the price is stated in the copy"), WCAG 2.1.1 / 4.1.2.
// No DOM under `node --test`: the seam is the SOURCE of app.js/index.html plus
// the pure decisions extracted from it.
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
// every pt msgid the app paints needs its English pair (CLAUDE.md §6)
function pair(msgid) {
  assert.ok(EN[msgid] && EN[msgid] !== msgid, `falta o par em inglês de “${msgid}”`);
}

// ---------------------------------------------------------------- N1
test("N1 — a descrição da versão NÃO é o nome do rascunho", () => {
  const body = fnBody("promptVersionar");
  assert.ok(!/slug:\s*message/.test(body),
    "passar a descrição como slug troca de rascunho a cada versão e a anterior desaparece");
  assert.match(body, /draft/, "o rascunho vem do rascunho ATUAL, não da descrição");
  assert.match(body, /brain_version/);
});

test("N1 — draftSlugFromBranch: só o rascunho atual, nunca o principal", () => {
  const f = loadPure("draftSlugFromBranch");
  assert.equal(f("rfc/politica-de-frota", "main"), "politica-de-frota");
  assert.equal(f("main", "main"), null, "no principal a próxima versão abre o primeiro rascunho");
  assert.equal(f("", "main"), null);
  assert.equal(f(null, null), null);
  // um branch de outra origem não é endereçável por slug (o backend resolve
  // rfc/<slug>): afirmar que a versão cai nele seria outra mentira
  assert.equal(f("experimento", "main"), null);
});

// ---------------------------------------------------------------- N5
test("N5 — o botão e a folha dizem que a versão guarda o PROJETO inteiro", () => {
  assert.match(fnBody("promptVersionar"), /projeto inteiro/i,
    "a folha tem de dizer o escopo antes de o usuário pagar o preço");
  assert.match(APP, /t\("Salvar versão do projeto"\)/,
    "o rótulo com a contagem do projeto inteiro nomeia o projeto");
  pair("Salvar versão do projeto");
  // a nota da seção TIME também
  const note = HTML.match(/<p id="pTeamNote"[^>]*>([^<]+)</);
  assert.ok(note, "a nota da seção TIME deve existir");
  assert.match(note[1], /projeto inteiro|todos os temas/,
    "a nota prometia a revisão sem dizer que o rascunho leva o projeto inteiro");
});

// ---------------------------------------------------------------- N7
test("N7 — a linha do tempo lê o histórico REAL (nada de 'última versão salva' sem versão)", () => {
  const rows = loadPure("timelineRows");
  const saved = (r) => r.some((x) => x.label === "última versão salva");
  // um contexto sem nenhuma versão: a linha não pode afirmar que há uma
  const none = rows({ dirty: true, kind: "context", versions: 0 });
  assert.ok(!saved(none), "sem commit não existe 'última versão salva'");
  assert.ok(none.some((r) => r.label === "sem versão salva ainda"));
  assert.ok(none.some((r) => r.label === "mudanças não salvas"));
  // com versões, a linha existe
  assert.ok(saved(rows({ dirty: false, kind: "context", versions: 3 })));
  // fora do mundo versionado (manual, nota pessoal) NUNCA há versão salva
  for (const kind of ["guide", "note", "meeting"]) {
    const r = rows({ dirty: false, kind, versions: 0 });
    assert.ok(!saved(r), `${kind} não é versionado`);
    assert.ok(r.some((x) => /não versionado/.test(x.label)));
  }
  pair("sem versão salva ainda");
});

test("N7 — o pintor consulta brain_timeline e não inventa a linha", () => {
  const body = fnBody("renderPanelTimeline");
  assert.match(body, /brain_timeline/, "a verdade é o histórico, não o tipo da aba");
  assert.match(body, /timelineRows\(/);
  assert.ok(!/rows\.push\(\{ cls: "saved"/.test(body),
    "a linha 'saved' não pode ser empurrada direto pelo pintor");
});

// ---------------------------------------------------------------- N8
test("N8 — o histórico é uma folha de leitura, não um editor com 'salvar' que descarta", () => {
  const body = fnBody("showTimeline");
  assert.ok(!/openEditor\(/.test(body), "o histórico é somente leitura");
  assert.match(body, /openModal\(/);
});

test("N8 — openEditor sem gravador esconde salvar e a barra de markdown", () => {
  const body = fnBody("openEditor");
  assert.match(body, /editSave\.hidden/, "um 'salvar' que descarta é um controle que não faz nada");
  assert.match(body, /editModalBar\.hidden/);
});

test("N8 — o seletor de rascunho é operável pelo teclado", () => {
  const body = fnBody("openBranchPicker");
  assert.match(body, /tabindex="0"/, "as linhas do seletor eram <div> com onclick");
  assert.match(body, /role="button"/);
  assert.match(body, /wireActivateKeys\(/, "Enter/Espaço têm de ativar a linha focada (WCAG 2.1.1)");
  const keys = fnBody("wireActivateKeys");
  assert.match(keys, /keydown/);
  assert.match(keys, /"Enter"/);
  assert.match(keys, /" "/);
});

test("N8 — o selo de versão é um controle anunciado, não um <span> clicável", () => {
  const tag = tagWithId("bGit");
  assert.match(tag, /role="button"/, "4.1.2: o selo abre o histórico do projeto");
  assert.match(tag, /tabindex="0"/, "2.1.1: era invisível ao teclado");
  assert.match(APP, /gitBadge\.addEventListener\("keydown"/,
    "um role=button precisa responder a Enter/Espaço");
  assert.match(APP, /gitBadge\.setAttribute\("aria-label"|gitBadge\.title\s*=/,
    "o nome acessível diz o que o selo faz");
});

// ---------------------------------------------------------------- N3
test("N3 — a folha de identidade não pré-preenche um e-mail falso e valida o que recebe", () => {
  const body = fnBody("fixIdentity");
  assert.ok(!/seu@email/.test(body) || /placeholder="[^"]*seu@email/.test(body),
    "“seu@email” só pode ser placeholder, nunca valor aceitável");
  assert.match(body, /@[^\s]*\\?\.|includes\("@"\)|test\(/, "o e-mail é validado");
  assert.match(body, /informe um e-mail válido/);
  pair("informe um e-mail válido");
});

// ---------------------------------------------------------------- N4
test("N4 — a revisão criada não é esquecida: o link fica alcançável", () => {
  const src = APP.slice(APP.indexOf("B.proposeBtn.addEventListener"));
  const handler = src.slice(0, src.indexOf("\n});") + 4);
  assert.match(handler, /pr\.url|proposal/, "a url voltava do backend e era descartada");
  assert.match(handler, /toastAction\(/, "o app oferece a ação em vez de só informar o número");
});

// A revisão acontece no navegador. A rodada anterior guardou a url e ofereceu
// "copiar link" porque não havia como abrir; `brain_open_link` (http(s), sem
// shell) existe, então o app cumpre a ação em vez de terceirizá-la.
test("N4 — a revisão ABRE: o app não devolve o endereço para o usuário abrir na mão", () => {
  const open = fnBody("openProposalUrl");
  assert.match(open, /brain_open_link/, "o app tem o endereço e tem como abrir");
  assert.match(open, /não abri a revisão no navegador/, "e diz quando não conseguiu");
  pair("não abri a revisão no navegador");

  const src = APP.slice(APP.indexOf("B.proposeBtn.addEventListener"));
  const handler = src.slice(0, src.indexOf("\n});") + 4);
  assert.match(handler, /abrir a revisão/, "quem acabou de propor abre a própria revisão");
  assert.match(handler, /openProposalUrl\(/);
  pair("abrir a revisão");

  // ADR-0027 · a folha `openReviewsSheet` virou o destino Revisão. Cada
  // afirmação abaixo é a MESMA, repontada — e a linha deixou de só "abrir algo"
  // para abrir a revisão que a pessoa veio ler, DENTRO do Loro.
  //
  // A lista são DUAS funções: a linha (markup) e o pintor (ligação). Somadas num
  // bloco só, `/data-prdetail/` era satisfeita por QUALQUER uma das duas: tirar o
  // atributo da linha (nenhuma linha ligada, todas com role="button" que não faz
  // nada) ou trocar o seletor do leitor (NodeList vazia, nenhuma linha ligada)
  // passava a suíte inteira verde. Cada metade é afirmada contra o seu PRÓPRIO
  // texto, e `wireActivateKeys` é fixado DENTRO do laço que roda.
  const row = fnBody("teamRowHtml");
  const painter = fnBody("renderTeamReviews");
  const wire = painter.slice(painter.indexOf("const wire = (box)"));
  assert.ok(wire.includes("querySelectorAll("),
    "o ligador da lista é uma função só, e é ela que percorre as linhas");
  assert.match(row, /data-prdetail="\$\{num\}"/,
    "a LINHA carrega o gancho que a abre — sem ele nada é ligado");
  assert.match(wire, /querySelectorAll\("\[data-prdetail\]"\)/,
    "e o LEITOR procura o MESMO gancho — outro seletor percorre uma lista vazia");
  assert.match(wire, /openReview\(Number\(row\.dataset\.prdetail\)\)/,
    "clicar na linha abre a revisão AQUI DENTRO, e a linha diz qual é");
  const detail = fnBody("renderReviewDetail") + fnBody("wireReviewDetail");
  const sheet = row + painter;
  assert.match(detail, /gh_pr_detail|REV\.detail/,
    "e o que abre é a revisão LIDA, não o endereço dela");
  assert.match(fnBody("loadReviewDetail"), /gh_pr_detail/);
  // a porta para o navegador continua existindo, na revisão aberta, e continua
  // sendo a única do app: nenhuma outra função fala com brain_open_link
  assert.match(detail, /openProposalUrl\(/);
  assert.match(fnBody("openProposalUrl"), /brain_open_link/);
  // e é o único: nenhuma superfície da revisão fala com brain_open_link por fora
  // dela (a outra chamada do app é a referência externa da ADR-0026, outro assunto)
  for (const fn of ["renderTeamReviews", "renderReviewDetail", "wireReviewDetail",
    "loadReviewDetail", "openReview", "decisionHtml", "threadHtml"]) {
    assert.ok(!/brain_open_link/.test(fnBody(fn)),
      `${fn} abre URL por fora de openProposalUrl — a porta tem de ser uma`);
  }
  assert.ok(!/copie o link|abra no navegador/.test(sheet + detail),
    "a cópia não pode mais mandar o usuário fazer o trabalho do app");
  // e a frase que dizia que a leitura acontecia FORA saiu do catálogo junto com
  // a folha: com a revisão aberta aqui dentro ela virou mentira (DESIGN.md §1)
  assert.ok(!("a revisão acontece no GitHub — “abrir” leva você até ela no navegador." in EN),
    "msgid de superfície retirada ainda no catálogo");
  pair("Mudanças propostas ao conhecimento oficial. Nada entra sem aprovação — e a sua leitura acontece aqui, sem sair do Loro.");
  // "abrir"/"copiar link" repetidos em N linhas não dizem QUAL revisão (2.4.6).
  // Agora o nome acessível está na LINHA inteira, que é o alvo — e ela é operável
  // pelo teclado, coisa que a linha .fitem2 fstatic da folha não precisava ser.
  // MIGRADAS (rodada 3): eram `role="button"` + `tabindex="0"` + `wireActivateKeys`
  // na LINHA inteira. Achado na árvore de acessibilidade do Chrome: o <button> real
  // do ⧉ copiar link morava DENTRO desse div[role=button] — aninhamento interativo,
  // e o ARIA dá filhos apresentacionais a um role=button, então a exposição do botão
  // de dentro é indefinida. Quem abre passou a ser um <button> de verdade com o
  // título dentro: papel, Enter/Espaço e foco vêm do elemento (mais forte que a
  // imitação), e os dois controles são irmãos.
  assert.match(row, /<button class="rvopen" data-prdetail=/,
    "quem abre a revisão é um botão de verdade, e não um div fingindo ser um");
  assert.ok(!/role="button"/.test(row), "sem papel de mentira na linha");
  assert.ok(row.indexOf("</button>") < row.indexOf("data-prurl"),
    "o ⧉ copiar link é IRMÃO do botão que abre, não filho dele");
  assert.match(sheet, /aria-label="\$\{t\("abrir a revisão"\)\} #\$\{num\}/);
  assert.match(sheet, /aria-label="\$\{t\("copiar link"\)\} #\$\{num\}"/);
  // e o nome acessível carrega o ESTADO: um aria-label na linha substituía o
  // conteúdo dela, e «mudanças pedidas» ficava só em pixels (WCAG 4.1.2)
  assert.match(row, /\$\{estado \? " · " \+ esc\(estado\) : ""\}/);
  assert.match(row, /esc\(meta\)/);
});

test("N4 — existe uma superfície de revisões (gh_pr_list) e a faixa tem um controle", () => {
  assert.match(APP, /gh_pr_list/, "o comando existia no contrato e ninguém o chamava");
  assert.match(HTML, /id="ghNotifOpen"/, "a faixa tinha só contadores e um ×");
  assert.match(APP, /ghNotifOpen/);
  // ADR-0027 · a superfície deixou de ser uma folha que se dispensa
  assert.match(APP, /function renderTeamReviews/);
  assert.match(APP, /function renderReviewDetail/);
  assert.match(HTML, /id="destReview"/, "é um destino, não uma folha");
  assert.match(fnBody("goDest"), /review/, "e o destino é alcançável pela navegação");
  assert.ok(!/function openReviewsSheet/.test(APP),
    "a folha antiga não pode continuar viva ao lado do destino que a substituiu");
});

test("N4 — dispensar vale para AQUELE aviso, não para a sessão inteira", () => {
  assert.ok(!/notifDismissed\s*=\s*true[^]{0,40}\n/.test(fnBody("refreshNotifications")),
    "o × não pode calar tudo para sempre");
  assert.match(APP, /notifDismissedSig/,
    "a dispensa guarda a assinatura do aviso dispensado — um aviso novo volta a aparecer");
  assert.match(fnBody("refreshNotifications"), /notifDismissedSig/);
});

test("N4 — os avisos se atualizam sem o usuário apertar 'verificar'", () => {
  assert.match(APP, /function maybeRefreshNotifications/);
  assert.match(APP, /maybeRefreshNotifications\(\)/);
});

// ---------------------------------------------------------------- N6
test("N6 — a paleta não oferece o que a tela esconde", () => {
  const cmds = APP.slice(APP.indexOf("const COMMANDS = ["), APP.indexOf("let cmdkMode"));
  assert.match(cmds, /when:\s*\(\)/, "um comando sem controle visível é um beco sem saída");
  assert.match(fnBody("renderPalette"), /availableCommands\(\)/, "a paleta filtra pelo mesmo gate da tela");
  assert.match(fnBody("availableCommands"), /c\.when\(\)/);
  // e o atalho global lê a MESMA lista: uma tecla não pode fazer o que a paleta
  // não oferece (era ⌘⌥P abrindo a folha inteira para recusar no fim)
  const chord = APP.slice(APP.indexOf("if (mod && e.altKey"), APP.indexOf("if (termHasFocus())"));
  assert.match(chord, /availableCommands\(\)/);
});

test("N6 — 'verificar' diz que rodou", () => {
  const src = APP.slice(APP.indexOf("B.ghCheck.addEventListener"));
  const handler = src.slice(0, src.indexOf("\n") + 1);
  assert.match(handler, /ghCheckRun|checking/, "cinco processos e nenhum sinal na tela");
  assert.match(APP, /function ghCheckRun/);
  const run = fnBody("ghCheckRun");
  assert.match(run, /pending|disabled/, "o botão mostra que está verificando");
  assert.match(run, /toast\(|announce\(/, "e o fim da verificação é dito");
});

test("N6 — o bloqueio da autenticação tem botão, não só um comando para digitar", () => {
  const body = fnBody("renderGhCard");
  assert.match(body, /data-runterm|checkAction\(/,
    "o remédio era a frase 'gh auth login' — o app já tem o padrão do botão 'Abrir o Terminal'");
  assert.match(APP, /gh auth login/);
  assert.match(APP, /termRun\(/);
  pair("autenticar no Terminal");
});

test("N6 — o diagnóstico não desaparece na máquina sem gh", () => {
  const body = fnBody("renderGhCard");
  assert.ok(!/if \(!heading\) \{ B\.ghCard\.hidden = true; return; \}/.test(body),
    "sem gh instalado o card sumia inteiro e o usuário ficava sem remédio");
});

// A nota tinha DOIS estados para TRÊS verdades: numa máquina sem git ela dizia
// "salvar versão funciona local" com o botão escondido pelo mesmo brain_git_state.
test("N6 — sem git no sistema, a nota do TIME não promete nem o histórico local", () => {
  const body = fnBody("renderPanelTeamNote");
  assert.match(body, /gitAvailable/,
    "a nota tem de seguir a MESMA autoridade do botão (brain_git_state.available)");
  assert.match(body, /não guarda histórico de versões/);
  pair("sem o git instalado, este computador não guarda histórico de versões.");
  pair("ver o que falta em Configurações");
  // e o pintor do estado do git repinta a nota: senão ela fica com a frase do boot
  const i = APP.indexOf('invoke("brain_git_state")');
  assert.ok(i > 0);
  const paint = APP.slice(i, i + 1200);
  assert.match(paint, /gitAvailable = /);
  assert.match(paint, /renderPanelTeamNote\(\)/);
});

test("N6 — sem versionamento, a seção TIME aponta onde se liga em vez de prometer", () => {
  assert.match(fnBody("renderPanelTeam"), /renderPanelTeamNote\(\)/);
  const body = fnBody("renderPanelTeamNote");
  assert.match(body, /versioningEnabled|envDoctor/, "a nota tem de acompanhar o estado real");
  assert.match(body, /pTeamNote/);
  // o card do ambiente e a nota do painel contam a MESMA verdade
  assert.match(fnBody("renderGhCard"), /renderPanelTeamNote\(\)/);
  assert.match(HTML, /id="pTeamNote"/);
  assert.match(HTML, /id="pTeamFix"/, "e oferecer o caminho (Configurações), não uma frase morta");
  assert.match(APP, /pTeamFix/);
  pair("conectar o GitHub em Configurações");
});

// ---------------------------------------------------------------- N2 (rodada 3)
// Clicar na linha "(principal)" do seletor ⎇ tirava o projeto INTEIRO da tela:
// num projeto que só começou a versionar depois de criado, o commit-base não
// leva arquivo nenhum, então a principal é um cômodo vazio e todo o
// conhecimento vive no rascunho. O git guarda tudo em segurança no commit do
// rascunho — o que não existia era a tela dizer o preço antes do clique, dizer
// que nada foi apagado e por onde se volta (DESIGN.md §1: o estado nunca mente,
// o preço está dito na cópia).
test("N2 — o preço de trocar é contado, não adivinhado", () => {
  const f = loadPure("switchPrice");
  assert.equal(f({ name: "rfc/frota", docs: 18, leaving: 0 }, "main"), null,
    "ir para onde nada sai da tela não tem preço a declarar");
  const p = f({ name: "main", docs: 0, leaving: 18 }, "rfc/frota");
  assert.equal(p.leaving, 18);
  assert.equal(p.targetEmpty, true, "a principal vazia é o caso que esvaziava a tela");
  assert.equal(p.from, "rfc/frota", "e o caminho de volta é o rascunho atual");
  assert.equal(f({ name: "rfc/outro", docs: 12, leaving: 3 }, "rfc/frota").targetEmpty, false);
});

test("N2 — nenhuma troca acontece sem consultar o preço", () => {
  const body = fnBody("openBranchPicker");
  assert.match(body, /switchPrice\(/, "o clique tem de perguntar o que a troca custa");
  const i = body.indexOf('git_switch_branch');
  assert.ok(i > 0, "openBranchPicker troca de rascunho");
  assert.ok(body.indexOf("switchPrice(") < i,
    "git_switch_branch não pode ser chamado antes de o preço ser calculado");
  assert.match(body, /confirmSwitchBranch|price\s*\)/,
    "com preço, a troca passa por uma confirmação");
});

test("N2 — a confirmação diz o preço, que nada foi apagado e por onde se volta", () => {
  const body = fnBody("confirmSwitchBranch");
  assert.match(body, /leaving/, "o número de documentos que saem da tela é dito");
  assert.match(body, /targetEmpty/, "e o destino vazio é dito com todas as letras");
  pair("Trocar de rascunho");
  pair("documentos saem da tela");
  pair("documento sai da tela");
  pair("nada é apagado: eles continuam guardados no rascunho atual.");
  pair("lá ainda não há nenhum documento — a tela vai ficar vazia.");
  pair("volta para");
  pair("trocar mesmo assim");
});

test("N2 — cada linha do seletor diz o que aquela branch guarda", () => {
  const body = fnBody("openBranchPicker");
  assert.match(body, /b\.docs/, "a linha lê o que a branch guarda (git_branches.docs)");
  assert.match(body, /aria-label=/, "o nome acessível carrega o mesmo estado da linha");
  const holds = loadPure("holdsLabel");
  assert.equal(holds(0), "nada guardado ainda", "o cômodo vazio se anuncia como vazio");
  assert.equal(holds(1), "1 documento");
  assert.equal(holds(18), "18 documentos");
  pair("nada guardado ainda");
  pair("documentos");
});

test("N2 — o backend conta o que cada branch guarda e o que sai da tela", () => {
  const git = fs.readFileSync(path.join(__dirname, "..", "src-tauri", "src", "git.rs"), "utf8");
  assert.match(git, /pub fn documents_on\(/);
  assert.match(git, /pub fn documents_leaving\(/);
  const lib = fs.readFileSync(path.join(__dirname, "..", "src-tauri", "src", "lib.rs"), "utf8");
  assert.match(lib, /struct BranchStand/, "git_branches devolve o que cada linha precisa dizer");
  assert.match(lib, /documents_leaving\(&base, cur, &name\)/);
});

// ============================================================ critic round 4
// The same family, one round later: the versioning surface still announced
// things the backend had just refused, and the review half still had no door.
//
//   N3  "versão salva" was toasted over a commit that never happened
//   N4  the last blocker on the road to team review had no remedy, and the row
//       computed a reason and threw it away
//   N5  "Revisões abertas" was reachable only from a transient toast and a
//       dismissible banner
//   N6  five minutes offline switched the team flow off and blamed the setup

// ---------------------------------------------------------------- N3
test("N3 — o app só anuncia a versão que o backend diz ter salvo", () => {
  const body = fnBody("promptVersionar");
  assert.match(body, /r\s*&&\s*r\.saved|!r\.saved|r\.saved/,
    "o resultado voltava e era jogado fora: com a árvore limpa o toast dizia “versão salva”");
  // a recusa é a verdade, não um erro: diz o que houve e não promete nada
  assert.match(body, /nada mudou desde a última versão/);
  pair("nada mudou desde a última versão — nenhuma versão foi criada");
  // e o que acabou de acontecer no disco chega à tela agora, não em até 10s
  assert.match(body, /brainRefresh\(\)/,
    "nada atualizava o ⎇ nem a contagem do botão depois de versionar");
});

test("N3 — o backend entrega o FATO, não uma frase em português", () => {
  const git = fs.readFileSync(path.join(__dirname, "..", "src-tauri", "src", "git.rs"), "utf8");
  const code = git.replace(/^\s*\/\/.*$/gm, ""); // um comentário pode citar o defeito
  assert.ok(!/"nada para versionar"/.test(code),
    "uma frase pt-BR vinda do backend não é um msgid (CLAUDE.md §6)");
  assert.match(git, /pub struct VersionAttempt/);
  assert.match(git, /pub saved: bool/);
  const lib = fs.readFileSync(path.join(__dirname, "..", "src-tauri", "src", "lib.rs"), "utf8");
  assert.match(lib, /saved: attempt\.saved/, "o comando repassa o fato ao frontend");
});

test("N3 — “tudo salvo ✓” não é um botão que abre a folha de salvar", () => {
  const painter = APP.match(/invoke\("brain_git_state"\)\.then\(\(g\) => \{[\s\S]*?\}\)\.catch/);
  assert.ok(painter, "o pintor do estado do git continua lá");
  assert.match(painter[0], /gitBtn\.disabled/,
    "com pending=0 o rótulo dizia “nada a fazer” e o clique abria a folha mesmo assim");
  // e a paleta lê o MESMO gate: um atalho não pode fazer o que a tela desabilitou
  // N8 · o gate lê agora a VISIBILIDADE do controle (o `hidden` mora na seção
  // TIME, não no botão) — sem perder o desabilitado, que é o que este N3 guarda
  assert.match(APP, /when: \(\) => controlOnScreen\(B\.gitBtn\) && !B\.gitBtn\.disabled/);
});

// ---------------------------------------------------------------- N4
test("N4 — a linha do check diz o valor E o motivo, nunca só o valor", () => {
  const body = fnBody("renderGhCard");
  assert.ok(!/c\.detail \|\| checkHint/.test(body),
    "detail vencia: a URL aparecia e o motivo (“verifique o acesso”) era calculado e descartado");
  assert.match(body, /checkSay\(c\)/, "uma função só decide o que a linha diz");
  // checkHint é o tradutor (pt: o msgid É o texto); aqui ele é a identidade
  // eslint-disable-next-line no-new-func
  const say = new Function(
    "const t = (s) => s; const tErr = (s) => s; const checkHint = (h) => String(h || '');\n" +
      "return (" + fnSource("checkSay") + ");"
  )();
  assert.equal(say({ ok: false, detail: "2.19.0", hint: "atualize o git" }), "2.19.0 — atualize o git");
  assert.equal(say({ ok: false, detail: "", hint: "instale o git" }), "instale o git");
  assert.equal(say({ ok: true, detail: "2.44.0", hint: "" }), "2.44.0");
});

test("N4 — o bloqueio que sobra depois de autenticar tem um botão", () => {
  const body = fnBody("renderGhCard");
  assert.match(body, /data-connect|connectRemote/,
    "ADR-0026 regra 6: o remédio de um bloqueio é um botão — este não tinha nenhum");
  const remedy = fnBody("promptConnectRemote");
  assert.match(remedy, /openModal\(/, "o preço é dito antes do clique");
  assert.match(remedy, /termRun\(/, "roda no terminal embutido, o mesmo padrão do “gh auth login”");
  assert.match(remedy, /gh repo create/);
  pair("conectar um repositório do time");
  pair("o conhecimento salvo em versões passa a ter uma cópia no GitHub, privada, na sua conta. reuniões, notas e itens para organizar continuam só neste computador.");
});

// ---------------------------------------------------------------- N5
test("N5 — a metade da revisão tem uma porta permanente, não só um toast", () => {
  // ADR-0027 · eram ≥4 chamadores de uma folha dispensável. Agora as rotas são
  // NOMEADAS uma por uma — perder qualquer uma reprova, o que uma contagem com
  // folga não faz — e todas chegam a um destino da nav, que não se dispensa.
  const rotas = (APP.match(/goDest\("review"/g) || []).length;
  assert.ok(rotas >= 4, `a revisão perdeu rotas: achei ${rotas}`);
  const rota = (re, quem) => assert.match(APP, re, `a revisão perdeu a rota: ${quem}`);
  rota(/label: "Revisão", run: \(\) => \{ openHome\(\); goDest\("review", "now"\); \}/, "⌘K → ir para");
  rota(/label: "Ver revisões do time"[^\n]*goDest\("review", "team"\)/, "⌘K → fazer");
  rota(/label: t\("ver revisões"\), run: \(\) => goDest\("review", "team"\)/, "o aviso do envio");
  rota(/\$\("ghNotifOpen"\)\.addEventListener\("click", \(\) => goDest\("review", "team"\)\)/, "a faixa de avisos");
  rota(/rev\.addEventListener\("click", \(\) => goDest\("review", "team"\)\)/, "a seção TIME do painel ✦ IA");
  assert.match(HTML, /data-dest="review"/, "e a porta principal é permanente: um destino da nav");
  const SHELL = fs.readFileSync(path.join(SRC, "shell.js"), "utf8");
  assert.match(SHELL, /review:\s*"destReview"/, "o casco conhece o destino, senão o botão não liga nada");
  assert.match(APP, /label: "Ver revisões do time"/, "não estava na paleta ⌘K");
  assert.match(APP, /label: "Revisão"/, "e o destino também tem a sua linha em ⌘K");
  assert.match(HTML, /id="pReviewsBtn"/, "nem tinha controle na seção TIME do painel ✦ IA");
  pair("Ver revisões do time");
  pair("Revisão");
});

test("N5 — a faixa de avisos é anunciada a quem não a vê", () => {
  const tag = tagWithId("ghNotifBar");
  assert.match(tag, /role="status"/, "a faixa só virava hidden=false: ninguém era avisado (4.1.2)");
  assert.match(tag, /aria-live="polite"/);
});

// ---------------------------------------------------------------- N6
test("N6 — o doctor separa “sem rede” de “falta configurar”", () => {
  const git = fs.readFileSync(path.join(__dirname, "..", "src-tauri", "src", "git.rs"), "utf8");
  assert.match(git, /pub enum RemoteAccess/, "um bool dizia a mesma coisa nos dois casos");
  assert.match(git, /Offline,/);
  const lib = fs.readFileSync(path.join(__dirname, "..", "src-tauri", "src", "lib.rs"), "utf8");
  assert.match(lib, /err\.github_unreachable/);
  assert.match(lib, /offline,/, "o EnvDoctor carrega o fato até a tela");
});

test("N6 — sem rede, a nota do TIME não acusa a configuração", () => {
  const body = fnBody("renderPanelTeamNote");
  assert.match(body, /envDoctor && envDoctor\.offline|isOffline/,
    "com tudo conectado e a rede fora, a nota mandava “conectar o GitHub”");
  assert.match(body, /sem conexão agora/);
  pair("sem conexão agora — salvar versão funciona local; a revisão do time volta quando a rede voltar.");
  pair("verificar de novo");
});

test("N6 — o distintivo do card diz sem rede em vez de “local”", () => {
  const body = fnBody("renderGhCard");
  assert.match(body, /d\.offline \? t\("sem rede"\)/);
  pair("sem rede");
});
