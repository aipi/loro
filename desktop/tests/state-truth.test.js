// One family of defects, found by driving the app (critic round 1): the interface
// asserting something that is not true. In each case the cure is the same — find
// the single source of truth and make the UI read from it, instead of patching the
// label:
//
//   C1  the meeting TAB clock froze at 00:00 while the footer clock ticked
//   C2  a PAUSED meeting kept the "gravando" badge on its own surface
//   C26 …and the privacy pill kept "● mic / captando microfone" beside
//       "nada está sendo gravado" (ADR-0022 §19: pausing stops capture for real)
//   C25 the success toast fired before the AI dispatch was known to have worked
//   C27 "Marcar momento"/"Anexar imagem" were enabled in the loose recording view
//       and could only refuse, with the clock running
//   C13 a document showed "versionado" next to "novo (não versionado)"
//   C30 the Documento panel said "Nenhum documento aberto" with tabs open
//   C28 applyI18n clobbered the chat's agent pill back to its boot msgid
//   C29 a Settings hint explained the OFF behaviour while the switch was ON
//   C6  a file named _prompt.md overwrote the loop's own guide, silently
//   C32 the new-project screen wore the CONFIGURED project's chrome until a ~10s
//       poll got around to applying `firstrun` — one state, two owners
//   C33 …and in that screen the project switch still showed its ⌄ (a menu the
//       click would not open), while `pointer-events: none` left the button in
//       the tab order, so Enter opened it anyway
//
// DESIGN.md §1 ("state must never lie", "never show a control that does nothing"),
// BR-8 (the privacy indicator is the one claim that must be exact).
// No DOM under `node --test`: the seam is the SOURCE of app.js/index.html, and a
// decision that can be a pure function is one and is exercised for real.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
const APP = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const CSS = fs.readFileSync(path.join(SRC, "style.css"), "utf8");
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
// `t` de identidade: em pt o msgid É o texto, então a função pura pode ser
// exercitada sem o dicionário nem o DOM.
function loadPure(name) {
  // eslint-disable-next-line no-new-func
  return new Function("const t = (s) => s;\nreturn (" + fnSource(name) + ");")();
}
function tagWithId(id) {
  const m = HTML.match(new RegExp('<[a-z0-9]+[^>]*\\bid="' + id + '"[^>]*>'));
  assert.ok(m, `index.html deve conter #${id}`);
  return m[0];
}

// ---------------------------------------------------------------- C1
test("C1 — o relógio da aba e o do rodapé são o MESMO relógio", () => {
  const body = fnBody("paintElapsed");
  assert.match(body, /el\.timer\.textContent/, "o rodapé é escrito pelo pintor");
  assert.match(body, /wstime/, "e a faixa de abas também — era pintada uma vez e congelava");
  assert.match(fnBody("startTimer"), /paintElapsed\(\)/, "o tique chama o pintor único");
  assert.ok(!/el\.timer\.textContent = fmt\(/.test(fnBody("startTimer")),
    "o tique não pode escrever só um dos dois relógios");
});

// ---------------------------------------------------------------- C2
test("C2 — ADR-0022 §19: pausada não é 'gravando' no selo da reunião", () => {
  const badge = loadPure("meetingBadgeStatus");
  assert.equal(badge("recording", true), "paused");
  assert.equal(badge("recording", false), "recording");
  assert.equal(badge("transcribing", true), "transcribing", "pausar só existe gravando");
  assert.equal(badge("done", true), "done");
  assert.match(fnBody("meetingStatusBar"), /paused:/, "o selo tem um estado pausada");
  assert.match(fnBody("paintMeetingSurface"), /meetingBadgeStatus\(/,
    "a superfície pinta o selo pela decisão única");
  // o ponto vermelho da aba é a mesma afirmação, em outro lugar
  assert.match(fnBody("renderTabs"), /rec && !state\.paused/);
  assert.match(fnBody("pauseMeeting"), /renderTabs\(\)/);
  assert.match(fnBody("resumeMeeting"), /renderTabs\(\)/);
});

// ---------------------------------------------------------------- C26
test("C26 — BR-8: o selo de captura não afirma microfone com a reunião pausada", () => {
  const kind = loadPure("meterKind");
  assert.equal(kind({ source: "meeting", paused: true }), "paused");
  assert.equal(kind({ source: "meeting", paused: false }), "meeting");
  assert.equal(kind({ source: "mic", paused: false }), "mic");
  assert.equal(kind({ source: "system", deviceLabel: "Loro", paused: false }), "system");
  assert.equal(kind({ source: "mic", deviceLabel: "Loro", paused: true }), "paused",
    "pausado vence qualquer fonte: nada está sendo captado");
  assert.match(fnBody("setMeter"), /paused:/, "o medidor conhece o estado pausado");
  assert.match(fnBody("startAudio"), /meterKind\(/, "um só lugar decide o que o selo diz");
});

test("C26 — pausar e retomar repintam o selo de captura", () => {
  assert.match(fnBody("pauseMeeting"), /paintCaptureMeter\(\)/);
  assert.match(fnBody("resumeMeeting"), /paintCaptureMeter\(\)/);
  // o vermelho "o áudio vai para o disco" também mente enquanto nada é gravado
  assert.match(fnBody("paintCaptureMeter"), /warn/);
  assert.match(fnBody("updatePrivacy"), /audioGoesToDisk\(\)/,
    "a condição do vermelho tem um dono só (DRY)");
  // trocar de idioma (rerenderForLang → updatePrivacy) devolvia "grava áudio"
  // em cima do selo pausado: durante uma captura o dono do selo é o medidor
  assert.match(fnBody("updatePrivacy"), /return paintCaptureMeter\(\)/);
});

test("C26 — os msgids do estado pausado têm par em inglês", () => {
  for (const pt of ["pausada", "reunião pausada — nada está sendo gravado"]) {
    assert.ok(EN[pt] && EN[pt] !== pt, `sem par em inglês: ${pt}`);
  }
});

// ---------------------------------------------------------------- C25
test("C25 — nenhum despacho de IA declara sucesso antes de saber o resultado", () => {
  const maus = [...APP.matchAll(/runAiCommand\([^;]*\);\s*\n\s*toast\(/g)].map((m) => m[0]);
  assert.deepStrictEqual(maus, [],
    "o toast de sucesso vinha antes do envio; o chat depois dizia 'nada foi enviado'");
  const body = fnBody("dispatchAi");
  assert.match(body, /await runAiCommand\(/, "o despacho é esperado");
  assert.match(body, /if \(sent\)/, "e só então o desfecho é anunciado");
});

test("C25 — runAiCommand devolve se o pedido saiu", () => {
  const body = fnBody("runAiCommand");
  assert.match(body, /return Promise\.resolve\(false\)/, "uma recusa não é um envio");
  assert.match(body, /return true/);
  assert.match(body, /return false/);
});

test("C25 — quando o turno morre por login, o 'enviada' sai da tela", () => {
  // o agente SOBE (chat_send resolve) e só no fim do turno se sabe que a
  // credencial faltava: o toast de sucesso não pode ficar ao lado de
  // "nada foi enviado"
  assert.match(fnBody("chatAuthBlock"), /clearToast\(\)/);
  assert.match(fnBody("clearToast"), /hidden = true/);
});

test("C25 — a mensagem diz ONDE a resposta vai aparecer", () => {
  assert.match(fnBody("runMeetingSkill"), /aiTargetHint\(\)/,
    "'análise enviada ao agente' não dizia onde olhar");
  assert.match(fnBody("genContextNow"), /dispatchAi\(/);
  for (const pt of ["análise enviada", "pergunta enviada"]) {
    assert.ok(EN[pt] && EN[pt] !== pt, `sem par em inglês: ${pt}`);
  }
  for (const morto of ["análise enviada ao agente", "pergunta enviada ao agente"]) {
    assert.ok(!(morto in EN), `msgid que mentia ainda no catálogo: ${morto}`);
  }
});

// ---------------------------------------------------------------- C27
test("C27 — os controles de reunião não ficam ligados numa transcrição avulsa", () => {
  for (const id of ["recMark", "recImage"]) {
    assert.match(tagWithId(id), /\bhidden\b/,
      `${id} só sabe agir numa reunião: nasce escondido`);
  }
  const body = fnBody("paintRecordingChrome");
  assert.match(body, /recMark/);
  assert.match(body, /recImage/);
  assert.match(body, /meeting\.active/,
    "quem os mostra é a existência da reunião, não o clique do usuário");
});

// ---------------------------------------------------------------- R21
// O seletor de fonte do rodapé de gravação era só LIDO: mostrava "minha voz +
// áudio do sistema" enquanto o backend registrava system_audio=false — a única
// afirmação que esse cromo existe para fazer (que áudio está sendo captado) era
// falsa. Os dois seletores decidem a mesma coisa, então têm um pintor só.
test("R21 — o seletor de fonte da gravação é escrito a partir da fonte que vale", () => {
  const body = fnBody("paintSourceSelectors");
  assert.match(body, /recSource/, "o seletor do rodapé é escrito, não só lido");
  assert.match(body, /el\.source/, "e o de Configurações também: um estado, dois lugares");
  assert.match(body, /settings\.source/, "a fonte da verdade é a configuração persistida");
  assert.match(fnBody("applySettings"), /paintSourceSelectors\(/,
    "reaplicar as configurações (boot incluído) pinta os dois");
  const onChange = APP.match(/el\.source\.addEventListener\("change",[\s\S]*?\n\}\);/);
  assert.ok(onChange, "o seletor de Configurações continua wired");
  assert.match(onChange[0], /paintSourceSelectors\(\)/,
    "mudar em Configurações tem de chegar ao rodapé — era só o caminho inverso que existia");
  // e o caminho de volta continua: mudar no rodapé decide de verdade
  const rec = APP.match(/\$\("recSource"\)\.addEventListener\("change",[\s\S]*?\n\}\);/);
  assert.ok(rec, "o seletor do rodapé continua wired");
  assert.match(rec[0], /el\.source\.value = \$\("recSource"\)\.value/);
});

// ---------------------------------------------------------------- C13
test("C13 — a linha de selos não afirma e nega o versionamento", () => {
  const body = fnBody("setDocGit");
  assert.ok(!/não versionado/.test(body),
    "'versionado' (mundo) e 'novo (não versionado)' (arquivo) ficavam lado a lado");
  assert.match(body, /sem versão salva/, "o selo do arquivo fala de VERSÃO SALVA");
  assert.ok(!("novo (não versionado)" in EN), "msgid contraditório ainda no catálogo");
  assert.ok(EN["sem versão salva"], "sem par em inglês: sem versão salva");
  const { crumbBadge } = require("../src/world.js");
  for (const lang of ["pt", "en"]) {
    const mundo = crumbBadge("context", lang).label;
    assert.ok(!/não versionado|not versioned/i.test(mundo),
      "o selo do mundo versionado não pode negar o versionamento");
  }
});

// ---------------------------------------------------------------- C30
test("C30 — o painel Documento não diz 'nenhum documento aberto' com abas abertas", () => {
  const copy = loadPure("panelDocEmptyCopy");
  const vazio = copy(0), comAbas = copy(3);
  assert.match(vazio.title, /Nenhum documento aberto/);
  assert.notEqual(comAbas.title, vazio.title, "com abas abertas a frase era falsa");
  assert.match(comAbas.hint, /aba/, "o próximo passo real é escolher uma das abas");
  const body = fnBody("clearPanelDoc");
  assert.match(body, /panelDocEmptyCopy\(/);
  assert.match(body, /ws\.tabs/, "a contagem vem da fonte da verdade (o workspace)");
  for (const id of ["pDocEmptyTitle", "pDocEmptyHint"]) {
    assert.match(tagWithId(id), /data-i18n-dyn/,
      "quem escreve em tempo de execução também traduz (F25)");
  }
  for (const pt of [
    "Nenhum documento em foco",
    "escolha um documento na faixa de abas acima — as habilidades de IA, as versões e o envio para revisão aparecem aqui.",
  ]) assert.ok(EN[pt] && EN[pt] !== pt, `sem par em inglês: ${pt}`);
});

// ---------------------------------------------------------------- C28
test("C28 — trocar de idioma não apaga o agente do chat", () => {
  const tag = tagWithId("chatMode");
  assert.ok(!/\bdata-i18n\b(?!-)/.test(tag),
    "sob applyI18n o pill voltava ao msgid do boot ('modo aberto') e perdia o agente");
  assert.match(tag, /data-i18n-dyn/, "o nó se declara escrito em tempo de execução");
  assert.match(fnBody("paintChatMode"), /chatAgent/, "o pintor lê o agente conhecido");
  assert.match(fnBody("rerenderForLang"), /paintChatMode\(\)/);
  assert.ok(!("modo aberto" in EN), "o rótulo que sequestrava o pill saiu do catálogo");
});

// ---------------------------------------------------------------- C29
test("C29 — a dica embaixo do interruptor descreve o estado em que ele está", () => {
  const hint = loadPure("autoContextHint");
  assert.match(hint(false), /^desligado:/);
  assert.match(hint(true), /^ligado:/);
  assert.notEqual(hint(true), hint(false));
  assert.match(tagWithId("cfgAutoContextHint"), /data-i18n-dyn/);
  assert.match(fnBody("openCfg"), /paintAutoContextHint\(/, "ao abrir, a dica já é a certa");
  assert.match(APP, /paintAutoContextHint\(autoCtx\.checked\)/, "e muda com o clique");
  for (const pt of [
    "ligado: quando nada existente couber, a IA cria um tema novo e organiza o item nele",
    'desligado: quando nada existente couber, a IA deixa o item em "para organizar" e pede o tema a você',
  ]) assert.ok(EN[pt] && EN[pt] !== pt, `sem par em inglês: ${pt}`);
});

// ---------------------------------------------------------------- C6
test("C6 — _prompt.md é o guia do loop, não um item: arrastar não o sobrescreve", () => {
  const isGuide = loadPure("isQueueGuidePath");
  assert.equal(isGuide("/Users/x/Downloads/_prompt.md"), true);
  assert.equal(isGuide("C:\\Users\\x\\_PROMPT.md"), true, "o disco não diferencia caixa");
  assert.equal(isGuide("/Users/x/notes.md"), false);
  assert.equal(isGuide("/Users/x/_prompt.md.txt"), false);
  // ADR-0028 moveu o corpo do listener para o roteador `handleSystemDrop` (o solto
  // agora tem três destinos) — o guard segue no ramo da fila, que é o único que importa
  const drop = fnSource("handleSystemDrop");
  assert.match(drop, /isQueueGuidePath|splitQueueGuideDrop/,
    "o guia é barrado ANTES do import (o backend ainda não o barra)");
  assert.match(APP, /listen\("tauri:\/\/drag-drop", \(e\) => handleSystemDrop\(/,
    "e o listener continua ligado ao roteador");
  assert.ok(EN["_prompt.md é o arquivo de instruções do loop — renomeie antes de importar"],
    "a recusa tem par em inglês");
});

// ---------------------------------------------------------------- C32
// A tela de PROJETO NOVO aparecia em três aparências, dependendo de quando se
// olhava: `openNewAcervo` revelava a tela na hora (os dois `hidden`) e deixava a
// classe `firstrun` — que é o que tira do cabeçalho o que não tem assunto sem
// projeto — para o `brainRefresh`, um poll de ~10s. No intervalo, o formulário de
// projeto novo ficava cercado pelo cromo do projeto CONFIGURADO: pílula de
// destinos, Gravar, ✦ IA, e o painel aberto estreitando a coluna do cartão.
// Um estado, um pintor — a mesma cura de C1/C2/C28.
test("C32 — a tela de projeto novo tem UM dono do cromo, não um poll", () => {
  const painter = fnBody("paintWizardChrome");
  assert.match(painter, /B\.setup\.hidden = !showWizard/, "o pintor mostra o wizard");
  assert.match(painter, /B\.shell\.hidden = showWizard \|\| !!legado/, "e esconde o casco");
  assert.match(painter, /classList\.toggle\("firstrun", !!showWizard\)/,
    "e é ele que aplica a classe — não um tique posterior");

  // as DUAS entradas passam pelo mesmo pintor
  const open = fnBody("openNewAcervo");
  assert.match(open, /paintWizardChrome\(true\)/, "quem abre a tela pinta o cromo dela na hora");
  assert.match(fnBody("brainRefresh"), /paintWizardChrome\(showWizard, legado\)/,
    "e o refresh periódico usa o MESMO pintor");

  // ninguém mais escreve os três sinais por fora do pintor
  const fora = APP.replace(fnSource("paintWizardChrome"), "");
  for (const [re, o_que] of [
    [/B\.setup\.hidden\s*=/, "B.setup.hidden"],
    [/B\.shell\.hidden\s*=/, "B.shell.hidden"],
    [/classList\.toggle\("firstrun"/, 'a classe "firstrun"'],
  ]) assert.doesNotMatch(fora, re, `${o_que} tem um dono só`);

  // e o que a classe tira é justamente o que não tem assunto sem projeto
  for (const sel of ["\\.destnav", "\\.recbtn", "#aiPanelBtn", "#aiPanel"]) {
    assert.match(CSS, new RegExp("#app\\.firstrun " + sel),
      `#app.firstrun precisa cobrir ${sel}: é ele que some quando não há projeto`);
  }
});

// ---------------------------------------------------------------- C33
// No modo de criação de projeto o seletor de projeto mostrava um ⌄ — a promessa de
// um menu — que o clique não cumpria. E o "desligado" era só `pointer-events: none`,
// que barra o MOUSE e deixa o botão no tab order: com Enter o menu de projetos
// abria por cima do wizard. DESIGN.md §1 — nunca mostrar um controle que não faz
// nada. O rótulo em si é de B7 e não muda: sem o ⌄ ele se lê como rótulo.
test("C33 — criando um projeto, o seletor não se veste de controle", () => {
  const src = fnBody("renderSwitch");

  // o estado vem da MESMA fonte do resto do cromo do wizard
  assert.match(src, /const wizard = !B\.setup\.hidden/,
    "a decisão lê a única fonte de verdade, não uma flag paralela");

  // a seta e o anúncio do popup acompanham o estado
  assert.match(src, /caret\.hidden = wizard/, "o ⌄ some quando não há menu para abrir");
  assert.match(src, /B\.acervoBtn\.disabled = wizard/,
    "`disabled` é o que tira do tab order e barra o Enter, não pointer-events");
  assert.match(src, /removeAttribute\("aria-haspopup"\)/,
    "um botão desligado não pode seguir anunciando um popup");
  assert.match(src, /setAttribute\("aria-haspopup", "true"\)/, "e volta a anunciar quando volta a abrir");

  // e não espera o poll: o pintor do cromo do wizard já repinta o seletor (C32)
  assert.match(fnBody("paintWizardChrome"), /renderSwitch\(\)/,
    "quem muda o estado pinta o seletor na hora");
  assert.match(HTML, /<span class="swcaret"/, "o ⌄ continua existindo no markup (é ele que é escondido)");
});

// Escape (or a click outside) on the "Nova gravação" sheet used to leave the ●
// Gravar button disabled at "iniciando…" forever: pickMeeting resolved only on the
// cancelar/× CLICK listeners, while Escape and the backdrop go through
// closeModal(), so the promise stayed pending and the caller's finally — the thing
// that clears the pending chrome — never ran. Found by driving the running app
// (critic round 2, blocker). The invariant is that the sheet has ONE dismissal
// owner that answers whoever is waiting, not one listener per exit.
test("C-r2 — toda saída da folha responde a quem espera (o ● não trava em 'iniciando…')", () => {
  const src = APP;

  // closeModal is the single dismissal owner and it notifies the waiter
  const closeFn = src.slice(src.indexOf("function closeModal()"), src.indexOf("function closeModal()") + 400);
  assert.match(closeFn, /pmOnDismiss/, "closeModal precisa avisar quem espera pela folha");
  assert.match(closeFn, /if \(dismissed\) dismissed\(\)/, "closeModal precisa CHAMAR o aviso, não só limpá-lo");

  // confirmar não é desistir: o onConfirm responde, então o aviso é desarmado
  const confirmFn = src.slice(src.indexOf('PM.confirm.addEventListener("click"'), src.indexOf('PM.confirm.addEventListener("click"') + 400);
  assert.match(confirmFn, /pmOnDismiss = null/, "confirmar não pode disparar o aviso de desistência");

  // pickMeeting registra o aviso em vez de depender de cliques em cancelar/×
  const pick = src.slice(src.indexOf("function pickMeeting("), src.indexOf("function pickMeeting(") + 2600);
  assert.match(pick, /\}, \(\) => finish\(null\)\)/, "pickMeeting precisa passar o onDismiss ao openModal");
  assert.doesNotMatch(
    pick,
    /PM\.(cancel|close)\.addEventListener/,
    "pickMeeting não pode voltar a depender de um listener por caminho de saída"
  );
});

// A triagem de entrada (ADR-0024) é a MESMA espera: a porta do acervo é de mão
// única, e um Escape deixava sendFilesToQueue esperando para sempre — nada
// entrava e nada era dito.
test("C-r2 — a triagem de entrada responde por todas as saídas da folha", () => {
  const body = fnBody("passIntake");
  assert.doesNotMatch(body, /PM\.(cancel|close)\.addEventListener/,
    "um listener por caminho de saída não vê Escape nem o clique fora");
  const call = body.match(/openModal\(([\s\S]*?)\n\s*\);/);
  assert.ok(call, "passIntake continua abrindo a folha de triagem");
  assert.match(call[1], /\(\) => (responde|resolve)\(false\)/,
    "o aviso de desistência é o último parâmetro do openModal, e ele responde false");
});

// R16 — o ● dizia "iniciando…", desabilitado, enquanto o app apenas PERGUNTAVA
// onde a gravação vai morar: nada havia sido tentado, o relógio estava em 00:00,
// e o único controle capaz de desistir estava fora de circulação. Um estado
// pendente pertence ao começo de verdade (DESIGN.md §5).
test("C-r2 — o pendente do ● pertence ao início, não à pergunta que o antecede", () => {
  const body = fnBody("toggle");
  assert.doesNotMatch(body, /setRecPending\("starting"\)/,
    "o clique abre uma folha antes de começar: aqui não há começo para anunciar");
  assert.match(body, /setRecPending\("stopping"\)/, "parar é imediato — esse pendente é verdade");
  // quem realmente sobe um processo é quem pinta o pendente
  assert.match(fnBody("startMeetingWith"), /setRecPending\("starting"\)/);
  const loose = fnBody("startSession");
  assert.match(loose, /setRecPending\("starting"\)/,
    "a transcrição avulsa também sobe um processo: ela pinta o seu próprio pendente");
  assert.ok(loose.indexOf('setRecPending("starting")') > loose.indexOf('invoke("start"') - 400,
    "o pendente nasce junto do invoke start, não antes das perguntas");
  assert.match(loose, /setRecPending\(null\)/, "uma falha do start desfaz o pendente");
});

// ---------------------------------------------------------------- B5
// Clicar numa ideia abria `brainstorming/<slug>/indice.md` — o artefato do digest
// cujo fluxo a ADR-0020 revogou. O resultado era um documento quase vazio ("o
// loop preenche este índice…"), sem a lista de reuniões, sem contagem e sem
// próximo passo: exatamente a "porta para uma lista vazia" que o DESIGN.md §1
// nomeia. O arquivo continua sendo um documento comum (material do usuário, e o
// modo editar segue abrindo o texto); o que passa a existir é a VISTA da ideia.
// as funções da vista escrevem HTML, então recebem o `esc` REAL (text.js) e um
// `t` de identidade — o mesmo par que o app usa em pt
const { esc } = require("../src/text.js");
function loadHtmlFn(name) {
  // eslint-disable-next-line no-new-func
  return new Function("esc", "t", "return (" + fnSource(name) + ");")(esc, (s) => s);
}

test("B5 — uma ideia abre a SUA vista, não o indice.md cru", () => {
  const ideaSlugOf = loadPure("ideaSlugOf");
  assert.equal(ideaSlugOf("brainstorming/plataforma/indice.md"), "plataforma");
  assert.equal(ideaSlugOf("brainstorming/plataforma/notes/x.md"), null);
  assert.equal(ideaSlugOf("brainstorming/a/meetings/r/meeting.md"), null);
  assert.equal(ideaSlugOf("contexts/plataforma/context.md"), null);
  assert.equal(ideaSlugOf(null), null);
  // o desvio mora no pintor único do documento aberto
  const body = fnBody("renderActive");
  assert.match(body, /ideaSlugOf\(tab\.rel\)/, "renderActive decide pela vista da ideia");
  assert.match(body, /renderIdeaSurface\(/);
  assert.match(body, /!editing \? ideaSlugOf/,
    "editar tem de continuar abrindo o texto: o arquivo é um documento comum (ADR-0020)");
});

test("B5 — a vista lista o material da ideia e conta cada pasta", () => {
  const body = fnBody("renderIdeaSurface");
  assert.match(body, /brain_list_meetings/, "as reuniões da ideia entram na vista");
  assert.match(body, /brainstorming\/\$\{slug\}\/notes/, "as notas também");
  assert.match(body, /brainstorming\/\$\{slug\}\/attachments/, "e os anexos");
  const section = loadHtmlFn("ideaSectionHtml");
  const cheia = section("reuniões", ["<li>a</li>", "<li>b</li>"], "nenhuma reunião ainda");
  assert.match(cheia, /\(2\)/, "a contagem é dita, não deixada para o usuário contar");
  assert.match(cheia, /<ul>/);
  const vazia = section("notes", [], "nenhuma nota ainda");
  assert.match(vazia, /\(0\)/);
  assert.match(vazia, /nenhuma nota ainda/, "uma seção vazia diz que está vazia");
  assert.ok(!/<ul>/.test(vazia), "sem lista fantasma");
});

test("B5 — a linha do material é um controle alcançável pelo teclado", () => {
  const row = loadHtmlFn("ideaRowHtml");
  const html = row("brainstorming/a/notes/n.md", "nota");
  assert.match(html, /<button class="link" data-open="brainstorming\/a\/notes\/n\.md">/,
    "um <a> sem href não entra na ordem de tabulação nem é anunciado como link (WCAG 2.1.1/4.1.2)");
  const body = fnBody("renderIdeaSurface");
  assert.match(body, /\[data-open\][\s\S]{0,120}openDoc\(/, "e o clique abre o documento");
});

test("B5 — o vazio orienta o próximo passo, com UMA ação primária", () => {
  const body = fnBody("renderIdeaSurface");
  assert.match(body, /class="btn solid" data-idea="rec"/, "a ação primária é gravar aqui");
  assert.equal((body.match(/btn solid/g) || []).length, 1, "uma ação primária por tela (DESIGN.md §1)");
  assert.match(body, /class="btn" data-idea="nota"/, "e a outra porta real fica secundária");
  assert.match(body, /nada aqui ainda — grave uma reunião ou escreva uma nota/,
    "sem material, a frase diz o que fazer");
  assert.match(body, /startMeetingFlow\(slug\)/, "gravar aqui grava NESTA ideia");
  assert.match(body, /promptNewNota\(slug,/);
  const count = loadPure("ideaMaterialCount");
  assert.equal(count({ meetings: 0, notes: 0, attachments: 0 }), 0);
  assert.equal(count({ meetings: 2, notes: 1, attachments: 3 }), 6);
  assert.equal(count(null), 0);
});

test("B5 — as frases da vista da ideia têm par em inglês", () => {
  for (const m of [
    "gravar reunião aqui",
    "nada aqui ainda — grave uma reunião ou escreva uma nota; a transcrição fica na sua máquina.",
    "o que valer virar conhecimento do time você envia para organizar.",
    "nenhuma reunião ainda", "nenhuma nota ainda", "nenhum anexo ainda",
  ]) assert.ok(EN[m] && EN[m] !== m, `sem par em inglês: ${m}`);
});

// ---------------------------------------------------------------- B15
// Uma habilidade termina anunciando o arquivo que criou ("✅ apresentação criada:
// contexts/…/attachments/x.md") e a conversa parava aí: o caminho é TEXTO, não um
// controle. DESIGN.md §1: "offer the action" — quem acabou de gerar um documento
// quer abri-lo, não procurá-lo na árvore.
test("B15 — o chat reconhece os arquivos que a resposta nomeia", () => {
  const files = loadPure("filesNamedInAnswer");
  assert.deepStrictEqual(
    files("✅ Apresentação criada: contexts/plataforma/attachments/decisoes.md"),
    ["contexts/plataforma/attachments/decisoes.md"]);
  // dentro de crase (o agente escreve markdown) e repetido no mesmo texto
  assert.deepStrictEqual(
    files("escrevi `brainstorming/a/notes/n.md` e revisei brainstorming/a/notes/n.md"),
    ["brainstorming/a/notes/n.md"]);
  // nada que não seja um arquivo do projeto entra
  assert.deepStrictEqual(files("veja https://x.dev/contexts/foo.md e /etc/passwd"), []);
  assert.deepStrictEqual(files("li o contexto contexts/plataforma"), []);
  assert.deepStrictEqual(files(null), []);
  // teto: a conversa não vira um gerenciador de arquivos
  const many = files([1, 2, 3, 4, 5].map((i) => `inbox/f${i}.md`).join(" "));
  assert.equal(many.length, 3);
});

test("B15 — a oferta só aparece para arquivo que existe, e abre a aba", () => {
  const body = fnBody("offerCreatedFiles");
  assert.match(body, /relExistsOnDisk\(rel\)/,
    "um botão que abre um arquivo inexistente é pior que nenhum botão");
  assert.match(body, /data-openrel/);
  assert.match(body, /openDoc\(b\.dataset\.openrel/, "o clique abre o documento");
  assert.match(body, /if \(!found\.length\) return;/, "sem arquivo, nenhum cromo entra na conversa");
  assert.match(fnBody("relExistsOnDisk"), /brain_list_dir/, "a existência é lida do disco");
  // e o gancho é o fim de turno BEM-SUCEDIDO
  const done = APP.match(/listen\("chat-done"[\s\S]*?\n\}\);/);
  assert.ok(done, "o listener de chat-done continua existindo");
  assert.match(done[0], /if \(p\.ok\) \{[\s\S]*?offerCreatedFiles\(chatBuf\)/,
    "a oferta pertence ao turno que terminou bem");
});

// ---------------------------------------------------------------- R11
// Trocar de idioma deixava a árvore da lateral no idioma anterior: ela é
// desenhada por innerHTML atrás de assinaturas de cache montadas com o estado do
// PROJETO, e o idioma não faz parte desse estado. Resultado observado: cabeçalhos
// em inglês (IDEAS / TO ORGANIZE) sobre uma linha "Transformar em conhecimento →"
// em português, ao mesmo tempo.
test("R11 — trocar de idioma invalida as assinaturas da lateral", () => {
  const body = fnBody("rerenderForLang");
  assert.match(body, /sideSig = ""/, "a árvore de conhecimento/fila precisa repintar");
  assert.match(body, /pessoalSig = ""/, "a árvore de ideias também");
  assert.match(body, /toolsSig = ""/, "e os rótulos das habilidades, que também são traduzidos");
  const sig = body.indexOf('sideSig = ""');
  const refresh = body.indexOf("brainRefresh()");
  assert.ok(sig >= 0 && refresh > sig,
    "zerar DEPOIS do refresh não repinta nada: a assinatura tem de cair antes");
});

// A contagem e o seu CHAMADOR são o mesmo contrato. O teste de unidade chamava a
// função com as chaves novas e passava; quem chamava de verdade ainda mandava as
// antigas, então uma ideia com reuniões gravadas dizia "nada aqui ainda".
test("ADR-0026 — o chamador da contagem usa as chaves que a função lê", () => {
  const fonte = fnSource("renderIdeaSurface");
  const chamada = /ideaMaterialCount\(\{([^}]*)\}/.exec(fonte);
  assert.ok(chamada, "renderIdeaSurface conta o material da ideia");
  const corpo = fnBody("ideaMaterialCount");
  for (const chave of ["meetings", "notes", "attachments"]) {
    assert.match(corpo, new RegExp("c\\." + chave + "\\b"), `a função lê c.${chave}`);
    assert.match(chamada[1], new RegExp("\\b" + chave + "\\s*:"), `e o chamador manda ${chave}`);
  }
});

// A simulação da migração lia chaves que o backend nunca mandou: dizia sempre
// "nada a migrar" e o usuário confirmava no escuro uma operação que renomeia a
// árvore inteira do projeto.
test("ADR-0026 — a simulação da migração lê as chaves que o backend serializa", () => {
  const RS = fs.readFileSync(path.join(__dirname, "..", "src-tauri", "src", "lib.rs"), "utf8");
  const bloco = /struct MigrationReport \{([\s\S]*?)\n\}/.exec(RS);
  assert.ok(bloco, "o relatório de migração existe no backend");
  const campos = [...bloco[1].matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1])
    .filter((c) => c !== "dry_run")
    .map((c) => c.replace(/_(\w)/g, (_, l) => l.toUpperCase()));   // camelCase do serde
  const corpo = fnBody("migrationBodyHtml");
  for (const campo of campos) {
    assert.match(corpo, new RegExp('"' + campo + '"'), `a simulação mostra ${campo}`);
  }
});
