// DESIGN.md §1 as tests: "never show a control that does nothing" and "state
// must never lie". Each test below was written from a defect found by driving
// the app — a checkbox nothing reads, an edit mode with no save button, a
// shortcut advertised for the wrong action, a banner that keeps asserting a
// state it can no longer verify.
//
// The frontend is vanilla JS loaded by <script> (no DOM in `node --test`), so
// the seam is the SOURCE of app.js/index.html, like wizard.test.js. Where a
// decision could be a pure function, it is one and is exercised for real.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
// A Windows checkout writes this file back with CRLF (core.autocrlf), and a
// couple of assertions below match a literal "\n" against it — normalize
// once here instead of at every call site.
const APP = fs.readFileSync(path.join(SRC, "app.js"), "utf8").replace(/\r\n/g, "\n");
const HTML = fs.readFileSync(path.join(SRC, "index.html"), "utf8").replace(/\r\n/g, "\n");
const { EN } = require("../src/i18n.js");

// body of a top-level `function name(...) { … }` / `async function name(...) { … }`
function fnBody(name) {
  const re = new RegExp("(?:async )?function " + name + "\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}");
  const m = APP.match(re);
  assert.ok(m, `app.js deve definir ${name}()`);
  return m[1];
}

// ---------------------------------------------------------------- F29
// Três caixas em "Versões e GitHub" não eram lidas por ninguém, e duas vinham
// MARCADAS: o usuário desmarcava "salvar versão ao aprovar" e aprovar seguia
// versionando. Um controle que relata um estado que não impõe é pior que
// nenhum controle (DESIGN.md §1) — foram removidas.
test("F29 — nenhuma caixa órfã sobrou em Versões e GitHub", () => {
  for (const id of ["optKeepVersions", "optVersionOnApprove", "optSendForReview"]) {
    assert.ok(!HTML.includes(id), `${id} não faz nada: não pode estar na tela`);
  }
});

test("F29 — os msgids das caixas removidas saíram do catálogo", () => {
  for (const m of [
    "guardar histórico de versões do conhecimento",
    "salvar versão ao aprovar",
    "enviar mudanças para revisão do time",
  ]) {
    assert.ok(!(m in EN), `msgid de controle removido ainda no catálogo: ${m}`);
  }
});

// ---------------------------------------------------------------- F30
// O rodapé de edição (#bEditFoot) nascia `hidden` e ninguém nunca o mostrava:
// os handlers de "Salvar versão"/"Descartar mudanças" eram código inalcançável
// e o modo editar não tinha AÇÃO PRIMÁRIA nenhuma.
test("F30 — um pintor único mostra o rodapé de edição com o modo", () => {
  const body = fnBody("paintEditFoot");
  assert.match(body, /bEditFoot/, "o pintor é quem manda no rodapé");
  assert.match(body, /hidden\s*=\s*!editing/, "o rodapé aparece exatamente no modo editar");
  assert.match(body, /bEditNote/, "o estado salvo/não salvo é escrito na nota do rodapé");
});

test("F30 — renderActive pinta o rodapé nos dois estados", () => {
  const body = fnBody("renderActive");
  const calls = body.match(/paintEditFoot\(/g) || [];
  assert.ok(calls.length >= 2,
    `renderActive deve pintar o rodapé ao entrar e ao sair da edição (achei ${calls.length})`);
});

// MIGRADO (rodada 4) — a asserção era de ORDEM no texto do handler, e a ordem no
// texto não é a ordem no tempo: `saveActive()` grava o arquivo por `invoke` e o
// clique seguinte acontecia ANTES do disco responder. Pior: ele era um clique em
// `B.gitBtn`, que com a árvore limpa está DESABILITADO (é o estado «tudo salvo ✓»)
// — e um clique programático num controle desabilitado não dispara. Medido no app
// rodando: com o buffer sujo e a árvore limpa, «Salvar versão» no rodapé do editor
// gravava o arquivo, dizia «salvo» e não abria versão nenhuma. O fluxo não fechava.
// F30 foi REVERTIDA por decisão do dono (2026-08-17): «o salvar no arquivo não
// deveria gerar um commit». A asserção original garantia que o salvar do rodapé
// CHEGAVA à folha de versão — o fluxo existia e morria em silêncio. Agora o fluxo
// não existe: gravar o arquivo e versionar o projeto são dois atos, e o commit tem
// casa própria (o destino Revisão, que está no relógio e mostra a mudança assim que
// o arquivo é gravado). A claim que fica é MAIS forte, porque proíbe em vez de
// exigir: este clique não commita, e o rótulo não promete versão nenhuma.
test("F30 — o salvar do rodapé grava o ARQUIVO, e não abre commit nenhum", () => {
  const m = APP.match(/\$\("bSaveVersion"\)\.addEventListener\("click",[\s\S]*?\n\}\);/);
  assert.ok(m, "o botão do rodapé continua wired");
  const h = m[0];
  assert.match(h, /await saveActive\(\)/,
    "gravar o buffer é assíncrono: quem chama espera o disco");
  assert.match(fnBody("saveActive"), /return saveTab\(/,
    "e saveActive devolve a promessa do disco, senão não há o que esperar");
  assert.ok(!/promptVersionar/.test(h),
    "um commit é do PROJETO inteiro, não do documento em foco: salvar o arquivo não o dispara");
  assert.ok(!/brain_version|brain_git_commit/.test(h),
    "e não há caminho indireto para o commit a partir daqui");
  assert.ok(!/gitBtn/.test(h),
    "um clique programático num controle desabilitado não dispara nada");

  // o rótulo diz UM ato, para os dois tipos de documento
  const foot = fnBody("paintEditFoot");
  assert.match(foot, /save\.textContent = t\("Salvar"\)/,
    "«Salvar versão» prometia um commit que este clique não faz mais");
  assert.ok(!/kind === "context" \? t\("Salvar versão"\)/.test(foot),
    "e o rótulo não volta a depender do tipo do documento");

  // a versão continua alcançável — só não por aqui
  assert.match(APP, /function promptVersionar/, "a folha de versão continua existindo");
  assert.match(APP, /B\.gitBtn\.addEventListener\("click", promptVersionar\)/,
    "a seção TIME do painel ✦ IA continua sendo uma porta para ela");
  assert.match(APP, /saveVersionFromReview/, "e o destino Revisão é a casa dela");
});

test("F30 — 'Salvar' tem par em inglês", () => {
  assert.equal(EN["Salvar"], "Save");
});

// ---------------------------------------------------------------- F32
// A paleta é a documentação viva dos atalhos: anunciava ⌘S para "Salvar versão"
// (um commit) enquanto ⌘S grava o arquivo. Um atalho, duas ações.
test("F32 — 'Salvar versão' não anuncia mais um atalho que não leva a ele", () => {
  // N5 renomeou o rótulo (a versão é do PROJETO inteiro, não do documento) — a
  // garantia é a mesma: esta linha não anuncia atalho nenhum.
  const row = APP.match(/\{ group: "documento", label: "Salvar versão do projeto",[^}]*\}/);
  assert.ok(row, "a linha da paleta continua existindo");
  assert.ok(!/combo/.test(row[0]), "o combo anunciado não abre o modal de versão");
});

test("F32 — ⌘S aparece na paleta na ação que ele realmente executa", () => {
  const row = APP.match(/\{ group: "documento", label: "Salvar",[^}]*\}/);
  assert.ok(row, "a paleta deve documentar o ⌘S real (salvar o documento)");
  assert.match(row[0], /combo: IS_MAC \? "⌘S" : "Ctrl\+S"/);
  assert.match(row[0], /saveActive\(\)/, "e apontar para o mesmo handler do teclado");
});

// ---------------------------------------------------------------- F24
// "Criar projeto" é a única ação primária da primeira tela e dispara processos
// (git init): sem estado pendente, o primeiro clique do usuário não tem
// resposta e um segundo clique re-semeia tudo (DESIGN.md §5).
test("F24 — Criar projeto pinta pendente e volta ao normal no finally", () => {
  const m = APP.match(/B\.createBtn\.addEventListener\("click", async \(\) => \{[\s\S]*?\n\}\);/);
  assert.ok(m, "o handler do Criar projeto continua wired");
  const h = m[0];
  assert.match(h, /createBtn\.disabled = true/, "o botão sai de circulação no clique");
  assert.match(h, /t\("criando…"\)/, "e diz o que está fazendo");
  assert.match(h, /\} finally \{/, "o pendente é desfeito mesmo quando o setup falha");
});

test("F24 — 'criando…' tem par em inglês", () => {
  assert.equal(EN["criando…"], "creating…");
});

// ---------------------------------------------------------------- F21
// O banner de dependências era avaliado uma vez no boot: depois de instalar
// tudo pelo terminal ele seguia dizendo "faltam dependências" para sempre.
test("F21 — o banner é pintado por um pintor separado da sondagem", () => {
  const body = fnBody("paintSetupBanner");
  assert.match(body, /setupBanner/);
  assert.match(body, /setupMsg/);
});

test("F21 — o banner oferece uma re-verificação com desfecho", () => {
  assert.match(HTML, /id="setupCheck"/, "o banner precisa de um controle de re-verificar");
  const body = fnBody("recheckSetup");
  assert.match(body, /t\("verificando…"\)/, "o clique tem estado pendente");
  assert.match(body, /checkSetup\(/, "e roda a sondagem de novo");
  assert.match(body, /finally/, "o pendente é sempre desfeito");
});

test("F21 — o fim de um comando no terminal re-verifica as dependências", () => {
  const m = APP.match(/listen\("term-exit"[\s\S]*?\n\}\);/);
  assert.ok(m, "o listener de term-exit continua existindo");
  assert.match(m[0], /checkSetup\(\)/,
    "instalar pelo terminal precisa fechar o ciclo: o banner some quando a dependência chega");
});

test("F21 — os msgids da re-verificação têm par em inglês", () => {
  for (const [pt, en] of [
    ["verificar de novo", "check again"],
    ["verificando…", "checking…"],
    ["tudo pronto — as dependências estão instaladas", "all set — the dependencies are installed"],
  ]) assert.equal(EN[pt], en, `sem par em inglês: ${pt}`);
});

// ---------------------------------------------------------------- F22
// "limpar transcrição" vive DENTRO da página de Configurações, que é opaca e
// cobre a tela inteira: apagar o buffer não produzia nenhuma mudança visível.
test("F22 — limpar transcrição diz o preço e confirma o que fez", () => {
  const body = fnBody("clearTranscript");
  assert.match(body, /Não pode ser desfeito\./, "o preço está na cópia");
  assert.match(body, /toast\(/, "e a ação tem resposta — o botão vive atrás de uma folha opaca");
  assert.match(body, /não há transcrição para limpar/, "sem buffer, o botão diz isso em vez de agir");
  assert.match(APP, /el\.clearBtn\.addEventListener\("click", clearTranscript\)/);
});

test("F22 — o savebar declara o preço de Descartar", () => {
  // R20 agrupou os três botões em .endacts: a frase continua ANTES deles
  const m = HTML.match(/<div id="savebar"[\s\S]*?<div class="endacts">/);
  assert.ok(m, "o savebar continua no lugar");
  assert.match(m[0], /descartar apaga a transcrição — não pode ser desfeito/,
    "DESIGN.md §1: o preço está na cópia, não num diálogo extra");
});

test("F22 — os msgids de limpar/descartar têm par em inglês", () => {
  for (const pt of [
    "descartar apaga a transcrição — não pode ser desfeito",
    "não há transcrição para limpar",
    "transcrição apagada",
  ]) assert.ok(EN[pt] && EN[pt] !== pt, `sem par em inglês: ${pt}`);
});

// ---------------------------------------------------------------- F25
// applyI18n congela o msgid do NÓ no primeiro passe e o reescreve a cada troca
// de idioma. O selo de privacidade é escrito em tempo de execução: trocar de
// idioma no meio de uma reunião fazia ele voltar a "sem guardar áudio" — com a
// classe .warn vermelha ainda aplicada — enquanto o áudio ia para o disco.
test("F25 — BR-8: o selo de privacidade não fica sob o applyI18n", () => {
  const m = HTML.match(/<span id="privacy"[^>]*>/);
  assert.ok(m, "#privacy continua no rodapé de gravação");
  assert.ok(!/\bdata-i18n\b(?!-)/.test(m[0]),
    "quem escreve o selo é updatePrivacy: sob data-i18n ele voltava a mentir sobre o áudio");
  assert.ok(!/data-i18n-attrs/.test(m[0]), "o title é do mesmo dono que o texto");
  assert.match(m[0], /data-i18n-dyn/, "o nó se declara escrito em tempo de execução");
});

test("F25 — applyI18n respeita os nós escritos em tempo de execução", () => {
  const body = fnBody("applyI18n");
  assert.match(body, /i18nDyn/, "applyI18n precisa saber pular quem tem pintor próprio");
});

test("F25 — updatePrivacy é dono do texto E do tooltip do selo", () => {
  const body = fnBody("updatePrivacy");
  assert.match(body, /\.title =/, "o tooltip mentia junto: 'Modo sem armazenamento' gravando");
  assert.match(body, /t\("grava áudio"\)/);
});

test("F25 — trocar de idioma repinta o selo e o banner de dependências", () => {
  const body = fnBody("rerenderForLang");
  assert.match(body, /updatePrivacy\(\)/);
  assert.match(body, /paintSetupBanner\(\)/);
});

// ---------------------------------------------------------------- F26
// rerenderForLang só repintava a transcrição, a lateral e a barra de seleção:
// com um documento aberto, o painel direito inteiro ("COM ESTE DOCUMENTO",
// "Pedir mudança à IA", o selo versionado/rascunho) ficava no idioma anterior.
test("F26 — trocar de idioma repinta o documento aberto e o painel direito", () => {
  const body = fnBody("rerenderForLang");
  assert.match(body, /renderActive\(\)/,
    "sem isto o painel direito e o selo da aba ficam no idioma anterior");
});

// C4 — o F26 acima cobria renderActive e mais nada: o painel do CHAT é pintado
// por innerHTML fora dele (os chips de habilidade e a linha de vazio), então
// depois de escolher inglês o chip seguia dizendo "perguntar ao acervo" ao lado
// de um menu em inglês — a mesma habilidade, duas vezes, em dois idiomas.
test("C4 — trocar de idioma repinta os chips e a linha vazia do chat", () => {
  const body = fnBody("rerenderForLang");
  assert.match(body, /renderChatChips\(\)/, "os chips ficavam no idioma anterior");
  assert.match(body, /paintChatEmpty\(\)/, "a linha 'pergunte qualquer coisa' ficava no idioma anterior");
  assert.match(body, /refreshModelManager\(\)/, "as linhas de modelo em Configurações também ficavam");
});

test("C4 — há UM escritor da linha vazia do chat", () => {
  const escritores = [...APP.matchAll(/pergunte qualquer coisa/g)];
  assert.equal(escritores.length, 1,
    "três cópias da mesma frase: uma delas sempre fica sem repintar");
  assert.match(fnBody("paintChatEmpty"), /pergunte qualquer coisa/);
  assert.match(fnBody("resetChatThread"), /paintChatEmpty\(\)/, "reiniciar o chat reusa o pintor");
});

// ---------------------------------------------------------------- R15/R23/R24
// A recusa da Gravação de Tela era um toast SEM prazo: sem ×, sem Escape e sem
// clique, ela ficou minutos na tela por cima do card do documento, em todos os
// destinos, dizendo "tente de novo" muito depois da tentativa — e apontava para
// "as Configurações", que no vocabulário do Loro é a própria página do app, onde
// essa permissão não existe. DESIGN.md §5: nenhum cromo permanente entra no
// layout, e toda recusa orienta o passo seguinte.
test("R15 — um toast sem prazo nasce com porta de saída", () => {
  const body = fnBody("toast");
  assert.match(body, /if \(ms\)[\s\S]*?else addToastDismiss\(\)/,
    "sem prazo, o toast espera o usuário: então ele precisa de um jeito de sair");
  const dismiss = fnBody("addToastDismiss");
  assert.match(dismiss, /aria-label/, "o × precisa de nome acessível");
  assert.match(dismiss, /clearToast/, "o × retira o toast de verdade");
  assert.ok(EN["fechar aviso"] && EN["fechar aviso"] !== "fechar aviso", "sem par em inglês: fechar aviso");
});

test("R15 — o Escape dispensa o toast quando não há folha na frente", () => {
  const listeners = [...APP.matchAll(/window\.addEventListener\("keydown", \(e\) => \{[\s\S]*?\n\}\);/g)]
    .map((m) => m[0]);
  const doToast = listeners.filter((l) => /clearToast\(\)/.test(l));
  assert.equal(doToast.length, 1, "um ouvinte só dispensa o toast");
  assert.match(doToast[0], /overlayStack\.length/,
    "uma folha aberta é a camada do topo e responde primeiro");
});

test("R24 — a recusa da Gravação de Tela nomeia um lugar que existe", () => {
  assert.ok(!/permita a Gravação de Tela nas Configurações/.test(APP),
    '"Configurações" é a página do próprio Loro — a permissão não mora lá');
  assert.match(APP, /toast\(tErr\("err\.screen_recording_denied"\), 0\)/,
    "a frase autoritativa (com o caminho do sistema) é a que já existe no catálogo");
  const { t, tErr, setLang } = require("../src/i18n.js");
  void t;
  setLang("pt");
  assert.match(tErr("err.screen_recording_denied"), /Ajustes do Sistema/,
    "no macOS em pt-BR o painel se chama Ajustes do Sistema");
  setLang("en");
  assert.match(tErr("err.screen_recording_denied"), /System Settings/);
  setLang("pt");
  assert.ok(!("permita a Gravação de Tela nas Configurações e tente de novo" in EN),
    "o msgid que apontava para o lugar errado saiu do catálogo");
});

// ---------------------------------------------------------------- R8
// "Transformar em conhecimento" estava na tela DUAS vezes ao mesmo tempo, a
// 113px de distância: o botão cheio no rodapé de Organizar e uma linha tracejada
// na lateral, as duas ligadas ao mesmo genContextNow. DESIGN.md §5: "a mesma ação
// não pode ter duas aparências"; §1: uma ação primária por tela. Sobrou o botão —
// ele age sobre a fila que o seu destino mostra, com a contagem e o preço ao lado.
test("R8 — transformar em conhecimento tem UMA aparência na tela", () => {
  assert.ok(!/t\("Transformar em conhecimento"\)/.test(APP),
    "app.js não pode desenhar nenhum controle com esse rótulo: o botão do destino é o único");
  assert.match(APP, /group: "fazer", label: "Transformar em conhecimento"/,
    "o caminho de teclado continua existindo");
  assert.ok(!/data-genctx/.test(APP), "a linha tracejada da lateral era a segunda aparência");
  assert.equal((HTML.match(/id="queueGenCtx"/g) || []).length, 1);
  assert.match(HTML, /id="queueGenCtx" class="btn solid"/, "a que sobra é a ação primária do destino");
  assert.match(APP, /\$\("queueGenCtx"\)[\s\S]{0,80}addEventListener\("click", genContextNow\)/);
});

// ---------------------------------------------------------------- F22
// "Descartar" destruía a única cópia da transcrição da sessão num clique: sem
// confirmação, sem desfecho, e com a frase que diz o preço ilegível ao lado dos
// botões. O mesmo ato pedido em Configurações ("limpar transcrição") já
// perguntava antes e respondia depois. Desde que a transcrição avulsa passa a virar nota, a transcrição TEM
// destino no projeto (uma nota de ideia), então descartar é perda de verdade —
// DESIGN.md §1: o preço está na cópia.
test("F22 — descartar confirma, diz o preço e nomeia a alternativa", () => {
  const body = fnBody("discard");
  assert.match(body, /openModal\(/,
    "descartar não pode mais apagar direto: a folha de confirmação é a porta");
  assert.match(body, /t\("Descartar a transcrição\?"\)/, "a folha pergunta o que vai fazer");
  assert.match(body, /não pode ser desfeito/, "e diz o preço, no corpo da folha");
  assert.match(body, /Salvar em ideias/,
    "…e nomeia o que existe em vez disso (a transcrição cabe no projeto)");
  // a destruição mora DENTRO do onConfirm da folha, não solta no corpo
  assert.match(body, /t\("descartar"\),\s*\(\) => \{ clearDoc\(\);/,
    "clearDoc tem de ser o que o botão 'descartar' da folha executa");
  assert.match(body, /toast\(t\("transcrição descartada"\)\)/, "e o desfecho é dito");
});

test("F22 — sem transcrição não há o que confirmar (nem folha vazia)", () => {
  const body = fnBody("discard");
  assert.match(body, /if \(!state\.lines\.length\) \{ clearDoc\(\); return; \}/,
    "uma barra sem linhas fecha sem perguntar — perguntar sobre nada é ruído");
});

test("F22 — as frases da folha de descarte têm par em inglês", () => {
  for (const m of [
    "Descartar a transcrição?",
    "apaga a única cópia do que foi transcrito nesta sessão — não pode ser desfeito.",
    "para guardar, feche esta folha e use “Salvar em ideias”.",
    "transcrição descartada",
  ]) {
    assert.ok(EN[m] && EN[m] !== m, `sem par em inglês: ${m}`);
  }
});

// ---------------------------------------------------------------- F21 (2)
// A outra metade do F21: a faixa de dependências do PRIMEIRO USO era markup
// morto — `#wizDeps` nunca era exibido por ninguém e o seu "Instalar agora" não
// tinha handler nenhum. Numa instalação nova sem whisper o app montava o projeto
// sem nunca dizer que a transcrição não ia funcionar (a interface sabia e não
// falava), e o botão era um controle que não fazia nada.
test("F21 — o primeiro uso também diz o que falta, pelo mesmo pintor", () => {
  const body = fnBody("paintSetupBanner");
  assert.match(body, /wizDeps/, "o banner do primeiro uso entra no mesmo pintor");
  assert.match(body, /wizDepsMsg/);
  assert.match(HTML, /id="wizDepsMsg"[^>]*data-i18n-dyn/,
    "quem escreve em tempo de execução também traduz: sob data-i18n o applyI18n reduz o texto ao msgid do boot");
});

test("F21 — a faixa do primeiro uso não oferece um botão que não pode agir", () => {
  assert.ok(!/id="wizDepsRun"/.test(HTML),
    "o instalador roda no terminal embutido, que vive no casco que o wizard esconde");
  assert.ok(!/wizDepsRun/.test(APP), "e não sobra referência ao controle removido");
  // em vez do botão morto, a orientação: onde a instalação acontece
  const m = APP.match(/function paintSetupBanner\(\)[\s\S]*?\n\}/);
  assert.match(m[0], /instala para você em Início/, "a faixa orienta o próximo passo");
});

test("F21 — a frase do primeiro uso tem par em inglês", () => {
  const pt = "a transcrição só funciona depois disso; o Loro instala para você em Início, ao criar o projeto.";
  assert.ok(EN[pt] && EN[pt] !== pt, "sem par em inglês");
});

// ============================================================ critic round 4
// N9 — na tela de entrada (Início, sem documento aberto) a paleta ⌘K oferecia
// quatro comandos do grupo "documento" que só sabiam desistir: os manipuladores
// dão `return` no primeiro if, runPalette() já fechou a paleta, e a tela apenas
// pisca. O comentário acima do registro afirmava o contrário ("`when` é o mesmo
// gate da tela, então a paleta nunca oferece um controle que não existe") e o
// tour vende a paleta como "a lista viva de tudo o que dá para fazer".
function commandRegistry() {
  const m = APP.match(/const COMMANDS = \[([\s\S]*?)\n\];/);
  assert.ok(m, "app.js deve declarar o registro COMMANDS");
  // uma linha por comando: { group: "…", label: "…", … when: … }
  return [...m[1].matchAll(/\{ group: "([^"]+)", label: "([^"]+)"([^\n]*)/g)].map((c) => ({
    group: c[1], label: c[2], rest: c[3],
  }));
}

test("N9 — todo comando de documento é oferecido só quando há documento", () => {
  const semGate = commandRegistry()
    .filter((c) => c.group === "documento" && !/\bwhen:/.test(c.rest))
    .map((c) => c.label);
  // "Grifar um trecho…" é o único que se recusa FALANDO (toast com o motivo),
  // que é a outra forma honesta de fechar o caso.
  assert.deepStrictEqual(semGate, ["Grifar um trecho…"],
    "comandos oferecidos em Início que só sabem desistir em silêncio:\n  " + semGate.join("\n  "));
});

test("N9 — o gate lê a MESMA verdade que o manipulador consulta", () => {
  assert.match(APP, /const hasDoc = \(\) => !!currentRel\(\);/,
    "o gate tem de ser a condição do manipulador, não uma cópia dela");
  assert.match(APP, /const hasClosedTab = \(\) => !!\(ws && ws\.closed && ws\.closed\.length\);/,
    "“Reabrir aba” sem pilha de fechadas é outro controle que não faz nada");
  // e o atalho global lê a mesma lista (availableCommands), não o registro cru
  const key = APP.match(/function availableCommands\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(key, "availableCommands() continua sendo o filtro único");
  assert.match(key[1], /typeof c\.when !== "function" \|\| c\.when\(\)/);
});

test("N9 — “Fechar aba” não é oferecida sobre a Home, que não fecha", () => {
  // closeTabById devolve na hora quando a aba é a Home (rel === HOME_REL): em
  // Início o comando era um no-op garantido.
  assert.match(APP, /function currentRel\(\) \{ const t = activeTab\(\); return !t \|\| t\.rel === HOME_REL \? null : t\.rel; \}/);
  const fechar = commandRegistry().find((c) => c.label === "Fechar aba");
  assert.match(fechar.rest, /when: hasDoc/);
});

// ---------------------------------------------------------------- N8
// A tela esconde um controle escondendo a SEÇÃO em que ele mora (a `.psec` do
// TIME, o `#pDocSecs` sem documento): o `hidden` do próprio botão continua false.
// O gate lia só o botão, então a paleta seguia oferecendo — e o atalho global
// seguia disparando — um controle que a tela tinha removido. Este é exatamente o
// caso que a regra 6 da ADR-0026 diz ter fechado.
test("N8 — um controle escondido pela SEÇÃO não é oferecido pela paleta", () => {
  // eslint-disable-next-line no-new-func
  const onScreen = new Function("return (function controlOnScreen(el) {" + fnBody("controlOnScreen") + "});")();
  const secao = { hidden: false, parentElement: null };
  const botao = { hidden: false, parentElement: secao };
  assert.equal(onScreen(botao), true, "botão visível numa seção visível");
  secao.hidden = true;
  assert.equal(onScreen(botao), false,
    "o `hidden` mora no ancestral: é ele que decide se o controle está na tela");
  secao.hidden = false; botao.hidden = true;
  assert.equal(onScreen(botao), false);
  assert.equal(onScreen(null), false, "sem elemento não há controle na tela");
});

test("N8 — os dois comandos do TIME leem a visibilidade real do controle", () => {
  const gated = commandRegistry().filter((c) =>
    ["Salvar versão do projeto", "Enviar para revisão do time"].includes(c.label));
  assert.equal(gated.length, 2, "os dois comandos continuam no registro");
  for (const c of gated) {
    assert.match(c.rest, /when: \(\) => controlOnScreen\(B\./,
      `${c.label}: o gate lia só o \`hidden\` do botão, que a tela nunca muda`);
    assert.ok(!/!B\.\w+\.hidden/.test(c.rest),
      `${c.label}: o \`hidden\` do botão não é mais a verdade sozinho`);
  }
  // "Enviar para revisão do time" também é um atalho global (KeyP): a mesma
  // lista filtrada é quem o serve, então o gate vale para os dois caminhos
  assert.match(APP, /function availableCommands\(\)/);
});

test("N8 — a ação primária da folha diz que está trabalhando até ter desfecho", () => {
  const m = APP.match(/PM\.confirm\.addEventListener\("click", async \(\) => \{[\s\S]*?\n\}\);/);
  assert.ok(m, "o confirmar da folha continua wired");
  const h = m[0];
  assert.ok(!/closeModal\(\); await fn\(\)/.test(h),
    "a folha sumia ANTES do await: brain_version pode passar ~10s em silêncio");
  assert.match(h, /PM\.confirm\.disabled = true/, "o botão sai de circulação no clique");
  assert.match(h, /t\("um momento…"\)/, "e diz que está trabalhando");
  assert.match(h, /aria-busy/, "o estado pendente também é anunciado (WCAG 4.1.2)");
  assert.match(h, /finally \{/, "o pendente é desfeito mesmo quando o handler falha");
  assert.match(h, /if \(gen === pmGen\)/,
    "um handler pode abrir a PRÓXIMA folha: o pendente só toca a folha que o abriu");
  // e abrir uma folha nova nunca herda o pendente da anterior
  assert.match(fnBody("openModal"), /PM\.confirm\.disabled = false/);
});

test("N8 — 'um momento…' tem par em inglês", () => {
  assert.equal(EN["um momento…"], "one moment…");
});

test("N8 — um despacho de IA entrega o pendente à superfície que responde", () => {
  // o chat/terminal é que carrega o "pensando…": a folha não pode ficar por cima
  // do terminal que ela mesma acabou de abrir
  assert.match(fnBody("dispatchAiFromSheet"), /closeModal\(\);\n\s*return dispatchAi\(/);
  // o único `return dispatchAi(` que sobra é o do próprio ajudante: nenhuma folha
  // despacha direto (senão ela ficaria por cima do seu próprio destino)
  const diretos = [...APP.matchAll(/return dispatchAi\(/g)].length;
  assert.equal(diretos, 1,
    "todo despacho feito de dentro de uma folha passa por dispatchAiFromSheet");
  assert.match(fnBody("dispatchAiFromSheet"), /return dispatchAi\(/);
});

// ---------------------------------------------------------------- N13
// A tira de rodapé do terminal (#termStatus + "■ parar") era cromo morto: uma
// varredura por todo o frontend achava as duas linhas do index.html e mais nada
// — nenhum escritor, nenhum `hidden = false`, nenhum ouvinte. Custava 13px e uma
// régua para não dizer nada, e oferecia um controle inalcançável (DESIGN.md §9).
test("N13 — a tira morta do terminal saiu da tela", () => {
  for (const id of ["termStatus", "termStop"]) {
    assert.ok(!HTML.includes(`id="${id}"`), `#${id} não faz nada: não pode estar na tela`);
    assert.ok(!APP.includes(id), `nada no app.js escreve #${id}`);
  }
  const CSS = fs.readFileSync(path.join(SRC, "style.css"), "utf8");
  assert.ok(!/\.termfoot/.test(CSS), "as regras da tira saem com ela");
});

test("N13 — o msgid do controle removido saiu do catálogo", () => {
  assert.ok(!("■ parar" in EN), "msgid de controle removido ainda no catálogo");
});

test("N13 — o fim do processo continua sendo dito no próprio terminal", () => {
  // a verdade de um terminal mora no buffer dele: é lá que ela está escrita
  assert.match(APP, /processo encerrado — 'reiniciar' para abrir de novo/);
  assert.match(HTML, /id="termClear"/, "e o remédio ('reiniciar') continua na tira de cima");
});
