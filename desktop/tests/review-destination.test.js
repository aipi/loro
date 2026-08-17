// ADR-0027 — the Revisão destination. Each test below is named after the DEFECT
// it forbids, not after the code that happens to avoid it today.
//
// The family: the review half of the product had a NUMBER and no door. "2
// aguardam sua revisão" lived in a toast that expires and a banner that can be
// dismissed, and the only thing the app could do with a proposed change was hand
// the address back to the user. Making it a destination introduced its own class
// of defect, and this file is the guard for that class:
//
//   R1  a counter with two painters (the nav badge and the inbox badge are one
//       array element apart), and a dismissed banner zeroing a count that is
//       still true
//   R2  17 sentences carry %1/%2 and t() had no interpolation — a typo'd
//       placeholder prints "%1" on screen, and an EN pair that loses a
//       placeholder loses a word of the sentence
//   R3  a pending state undone by a timer instead of by the outcome (a gh call
//       is three processes and two network round trips)
//   R4  the diff re-parsed on the way to the screen: the row's kind sniffed off
//       the first character of the text, next to a backend that already said it
//   R5  the click handler turned async and the msgid sweep silently stopped
//       reading the propose flow (vocabulary.test.js:141 pins the sync arrow)
//   R6  a gh process spent on a destination nobody is looking at
//   R7  two primary actions on the open review (Aprovar beside Juntar), or a
//       decided review answered with a re-armed button
//   R8  BR-8: a diff row, a review body or a comment reaching a log line
//
// Source-level, like honest-controls.test.js: there is no DOM under node --test,
// so the seam is the source of app.js/index.html plus the pure modules.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
const APP = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const { EN, ERR_PT, t, setLang } = require("../src/i18n.js");
const RV = require("../src/review.js");

function fnSource(name) {
  const re = new RegExp("(?:async )?function " + name + "\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}");
  const m = APP.match(re);
  assert.ok(m, `app.js deve definir ${name}()`);
  return m[0];
}
const fnBody = (name) => {
  const s = fnSource(name);
  return s.slice(s.indexOf("{") + 1, -1);
};

// O pintor da decisão EXERCIDO como função, com as mesmas dependências que ele
// tem na tela: `t` interpola %N e devolve o msgid (o que o pt faz), `esc` é a
// identidade e o nome do rascunho vem da regra do próprio app. Uma asserção sobre
// o TEXTO do pintor só sabe da forma; esta roda os ramos.
function pintorDaDecisao() {
  // eslint-disable-next-line no-new-func
  return new Function(
    'const t = (m, a) => String(m).replace(/%([1-9])/g, (_, i) => (a && a[i - 1] !== undefined ? a[i - 1] : "%" + i));\n' +
    'const esc = (s) => String(s === null || s === undefined ? "" : s);\n' +
    'const REV = { def: "main" };\n' +
    fnSource("draftSlugFromBranch") + "\n" +
    fnSource("draftNameFromBranch") + "\n" +
    "return " + fnSource("decisionHtml") + ";"
  )();
}

// -------------------------------------------------------------------- R1
// O contador da nav é pintado por refreshNotifications. renderHome pinta o
// contador da fila num laço de ids que passa a UM elemento de distância dele:
// dois pintores para um número é exatamente como um contador sobrevive à verdade
// que o gerou (a contagem ficava parada depois de trocar de projeto ou de idioma).
test("R1 — o contador da Revisão tem UM pintor, e não é o da fila", () => {
  const notif = fnBody("refreshNotifications");
  assert.match(notif, /destReviewBadge/,
    "quem sabe quantas revisões pedem você é quem lê brain_notifications");
  assert.match(notif, /reviewRequestedToMe\.length/);
  const home = fnBody("renderHome");
  assert.ok(!/destReviewBadge/.test(home),
    "renderHome pinta o contador da fila: um segundo pintor para a Revisão é a mesma doença de novo");
  // e o mesmo pintor alimenta a aba, para nav e aba nunca discordarem
  assert.match(notif, /revTeamBadge/);
});

test("R1 — todo distintivo do destino tem um escritor, e só um", () => {
  // Um "0" no HTML que ninguém escreve é cromo morto (DESIGN.md §9), e dois
  // escritores para um número é como um contador sobrevive à verdade que o gerou.
  const donos = {
    destReviewBadge: "refreshNotifications",   // revisões que pedem você
    revTeamBadge: "refreshNotifications",
    revNowBadge: "renderMyChanges",            // documentos que você mudou
  };
  for (const [id, dono] of Object.entries(donos)) {
    assert.match(HTML, new RegExp(`id="${id}"`), `#${id} continua na tela`);
    const escritores = ["refreshNotifications", "renderMyChanges", "renderHome",
      "renderTeamReviews", "renderDestReview"].filter((f) => fnBody(f).includes(id));
    assert.deepStrictEqual(escritores, [dono],
      `#${id}: um distintivo tem exatamente um escritor, e é ${dono}`);
  }
});

test("R1 — dispensar a faixa não zera um contador que continua verdadeiro", () => {
  const notif = fnBody("refreshNotifications");
  const pintou = notif.indexOf("badge(n.reviewRequestedToMe.length)");
  const dispensa = notif.indexOf("notifDismissedSig");
  assert.ok(pintou > 0, "o contador é pintado a partir do fato lido");
  assert.ok(dispensa > 0, "a dispensa continua existindo");
  assert.ok(pintou < dispensa,
    "o × vale para AQUELE aviso, não para o fato: pintar depois da dispensa apaga uma verdade");
  // sem versionamento / sem conexão / não conectado o contador vai a zero: um
  // número que sobrevive à sua fonte é o mesmo defeito pelo outro lado
  assert.equal((notif.match(/badge\(0\)/g) || []).length, 3,
    "os três caminhos de saída têm de zerar o contador");
});

// -------------------------------------------------------------------- R2
test("R2 — t() interpola %N, e um %N sem argumento não desaparece da frase", () => {
  setLang("pt");
  assert.equal(t("%1 de %2 vistos", [2, 7]), "2 de 7 vistos");
  assert.equal(t("%1 de %2 vistos"), "%1 de %2 vistos", "sem argumentos o msgid passa inteiro");
  // um argumento faltando deixa o marcador VISÍVEL: um defeito que se vê é
  // melhor do que uma frase que perde uma palavra em silêncio
  assert.equal(t("%1 de %2 vistos", [2]), "2 de %2 vistos");
  assert.equal(t("%1/24", [0]), "0/24", "zero é um valor, não ausência");
  setLang("en");
  assert.equal(t("%1 de %2 vistos", [2, 7]), "2 of 7 read", "a interpolação vale nos dois idiomas");
  setLang("pt");
});

test("R2 — nenhum par em inglês perde (nem inventa) um marcador da frase em pt", () => {
  const marks = (s) => [...new Set(String(s).match(/%[1-9]/g) || [])].sort().join("");
  const ruins = [];
  for (const [pt, en] of Object.entries(EN)) {
    if (pt.startsWith("err.")) continue;   // ERR_PT usa {detail}, outro mecanismo
    if (marks(pt) !== marks(en)) ruins.push(`${pt} → ${en}`);
  }
  assert.deepStrictEqual(ruins, [],
    "um par que perde um %N perde uma palavra da frase; um que inventa imprime o marcador:\n  " + ruins.join("\n  "));
});

// -------------------------------------------------------------------- R3
test("R3 — o pendente da Revisão é desfeito pelo DESFECHO, nunca por um relógio", () => {
  const body = fnBody("withPending");
  // O anúncio e o desfazer do anúncio são a MESMA substring: `/aria-busy/` contra
  // o corpo inteiro era satisfeita pela linha do `finally`, então a linha que
  // ANUNCIA podia ser apagada com a suíte verde — toda ação da Revisão ficaria
  // pendente sem dizer nada a quem não vê a tela (WCAG 4.1.2). As duas metades
  // são afirmadas separadamente, e cada uma no seu lugar.
  const iSet = body.indexOf('setAttribute("aria-busy", "true")');
  const iTry = body.indexOf("try {");
  const iFinally = body.indexOf("finally {");
  const iClear = body.indexOf('removeAttribute("aria-busy")');
  assert.ok(iSet > 0, "o estado pendente é ANUNCIADO, não só pintado (WCAG 4.1.2)");
  assert.ok(iClear > 0, "e o anúncio é desfeito no fim");
  assert.ok(iTry > 0 && iSet < iTry, "o anúncio acontece antes de a chamada começar");
  assert.ok(iFinally > 0 && iClear > iFinally, "e é desfeito pelo desfecho, dentro do finally");
  assert.match(body, /disabled = true/, "o controle sai de circulação no clique");
  assert.match(body, /finally \{/, "e volta mesmo quando a chamada falha");
  assert.ok(!/setTimeout|setInterval/.test(body),
    "um relógio devolveria o botão antes da resposta — três processos e duas idas à rede depois");
  // toda ação da Revisão que sobe um processo passa por ele
  for (const fn of ["sendReviewDecision", "mergeReview"]) {
    assert.match(fnBody(fn), /withPending\(/, `${fn} gasta rede e tem de dizer que está trabalhando`);
  }
  assert.match(APP, /revSaveBtn"\)\.addEventListener\("click", \(e\) => withPending\(/,
    "salvar versão sobe um processo git e pode levar segundos");
  // as folhas herdam o pendente do confirmar (openModal), que já é testado
  assert.match(fnBody("promptReply"), /openModal\(/);
});

// -------------------------------------------------------------------- R4
test("R4 — a tela nunca re-interpreta uma linha de diff: o tipo vem do backend", () => {
  const body = fnBody("diffRowsHtml");
  assert.match(body, /r\.tone/, "o tom da linha é o que diff.rs disse que ela é");
  assert.match(body, /r\.sign/, "e o sinal também");
  assert.ok(!/text\[0\]|charAt\(0\)|startsWith\("\+"\)|startsWith\("-"\)/.test(body),
    "farejar o primeiro caractere do texto é uma segunda gramática de diff para manter");
  // e o número da linha vem calculado, não contado aqui
  assert.match(body, /oldNum|newNum/);
  assert.ok(!/\+\+|lineNo\s*\+/.test(body), "a numeração é do parser, que tem #[test]");
});

test("R4 — um arquivo binário diz que não dá para mostrar, em vez de desenhar um diff vazio", () => {
  const bin = { path: "contexts/frota/mapa.png", kind: "modified", binary: true, additions: 0, deletions: 0, hunks: [] };
  assert.deepStrictEqual(RV.diffRows(bin, {}), [], "não há linha para desenhar");
  assert.deepStrictEqual(RV.plainBits(bin, {}), []);
  assert.match(fnBody("changeCardHtml"), /c\.binary/, "o cartão tem de dizer o que ele é");
  assert.ok(EN["não dá para mostrar as linhas deste arquivo"]);
});

// -------------------------------------------------------------------- R5
test("R5 — o fluxo de enviar para revisão continua alcançável pela varredura de vocabulário", () => {
  // vocabulary.test.js:141 acha o manipulador por esta forma EXATA. Torná-lo
  // async não quebra o app — quebra a varredura, em silêncio, e o termo retirado
  // volta a poder entrar no fluxo sem ninguém ver.
  assert.match(APP, /B\.proposeBtn\.addEventListener\("click", \(\) => \{/,
    "o manipulador é síncrono: a espera mora no confirmar da folha, que já anuncia o pendente");
  const i = APP.indexOf('B.proposeBtn.addEventListener("click", () => {');
  const handler = APP.slice(i, APP.indexOf("\n});", i) + 4);
  assert.ok(!/^\s*await /m.test(handler.split("openModal(")[0]),
    "nada é esperado antes de a folha abrir");
  assert.match(handler, /brain_pr_template/, "os campos são as seções do modelo DO TIME");
  assert.match(handler, /toastAction\(/);
  assert.match(handler, /pr\.url/);
});

// -------------------------------------------------------------------- R6
test("R6 — nenhum processo do gh é gasto num destino que ninguém está olhando", () => {
  for (const fn of ["refreshTeamReviews", "loadReviewDetail", "refreshMyChanges"]) {
    assert.match(fnBody(fn), /reviewOn\(\)/,
      `${fn} sobe processo e vai à rede: fora do destino é gasto puro`);
  }
  assert.match(APP, /const reviewOn = \(\) => LoroShell\.destination\(\) === "review";/,
    "a autoridade é o casco, não uma cópia da verdade");
  // e a metade do time não sobe o gh quando o ambiente já diz que não dá
  assert.match(fnBody("refreshTeamReviews"), /teamBlockCode\(\)/,
    "sem gh/sem autenticação/sem remoto a lista diz o motivo em vez de tentar");
});

test("R6 — o poll de 10s não fecha um cartão que o usuário abriu", () => {
  const body = fnBody("renderMyChanges");
  assert.match(body, /REV\.sig/, "o repintar é guardado por assinatura, como a lateral");
  assert.match(body, /openCard/, "e o que está aberto é estado, não um acidente do DOM");
  assert.match(body, /if \(sig === REV\.sig\) return;/);
});

// -------------------------------------------------------------------- R9
// ACHADO NO APP RODANDO: o cartão é um <details>, e o conteúdo era montado só no
// pintor. Clicar no cartão marcava o estado, mas o resumo só aparecia na próxima
// passada do poll — até 10 segundos de um cartão aberto e VAZIO. Um clique sem
// resposta é a tela sem retorno (DESIGN.md §1).
test("R9 — abrir um cartão mostra o resumo AGORA, não na próxima passada do poll", () => {
  const body = fnBody("wireCardToggle");
  assert.match(body, /ontoggle/, "o <details> é a divulgação, e o toggle é o evento dele");
  assert.match(body, /insertAdjacentHTML|innerHTML/,
    "abrir tem de trazer o conteúdo na hora; guardar o estado e esperar o poll é o defeito");
  assert.match(body, /plainBitsHtml\(/, "e o conteúdo é o mesmo que o pintor escreve — uma função só");
  assert.match(body, /REV\.openCard/, "sem perder o estado, que o repintar respeita");
  // as duas listas que desenham cartões usam o MESMO ligador
  assert.match(fnBody("renderMyChanges"), /wireCardToggle\(/);
  assert.match(fnBody("renderReviewDetail"), /wireCardToggle\(/);
});

test("R9 — um documento novo não anuncia 'trechos': ele é o trecho", () => {
  const body = fnBody("changeCardHtml");
  assert.match(body, /c\.status === "modified" \|\| c\.status === "renamed"/,
    "'+1 −0 · 1 trechos mudaram' num documento novo repete o que o distintivo já disse");
});

// ACHADO NO APP RODANDO: `+1 −0 · 1 trechos mudaram`. Toda contagem do destino
// tinha uma forma só, então no singular a interface escrevia errado sobre o
// próprio conteúdo. As duas formas são msgids separados, para quem traduz
// escolher as duas — o app já fazia isso em holdsLabel.
test("R9 — toda contagem do destino concorda em número", () => {
  setLang("pt");
  const plural = new Function("const t = (m, a) => String(m).replace(/%1/g, a[0]);\n" +
    "return (" + fnSource("plural") + ");")();
  assert.equal(plural(1, "%1 trecho mudou", "%1 trechos mudaram"), "1 trecho mudou");
  assert.equal(plural(2, "%1 trecho mudou", "%1 trechos mudaram"), "2 trechos mudaram");
  assert.equal(plural(0, "%1 linha sem mudança", "%1 linhas sem mudança"), "0 linhas sem mudança");
  // e nenhuma contagem do destino escapa por um t() direto de um par plural
  for (const many of ["%1 trechos mudaram", "%1 linhas sem mudança", "%1 comentários", "… e mais %1 linhas"]) {
    const one = { "%1 trechos mudaram": "%1 trecho mudou", "%1 linhas sem mudança": "%1 linha sem mudança",
      "%1 comentários": "%1 comentário", "… e mais %1 linhas": "… e mais %1 linha" }[many];
    assert.ok(EN[one] && EN[many], `faltam os dois pares de "${many}"`);
    assert.ok(!APP.includes(`t("${many}"`), `"${many}" chamado direto: no singular escreve "1 ${many.slice(3)}"`);
    assert.ok(APP.includes(`"${one}", "${many}"`), `"${many}" tem de passar por plural()`);
  }
});

// -------------------------------------------------------------------- R7
test("R7 — uma ação primária por revisão aberta: Aprovar e Juntar nunca convivem", () => {
  const base = {
    number: 7, state: "OPEN", author: { login: "ana" }, headRefName: "rfc/frota",
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checks: [{ name: "ci", state: "ok" }],
    approvals: 1, changesRequested: 0, reviewRequests: [], reviews: [], threads: [],
  };
  const casos = [
    { ...base, mine: true },
    { ...base, mine: false },
    { ...base, mine: true, mergeStateStatus: "BLOCKED" },
    { ...base, mine: false, changesRequested: 1 },
    { ...base, mine: true, mergeable: "CONFLICTING" },
    { ...base, mine: true, state: "MERGED" },
    { ...base, mine: false, checks: [{ name: "ci", state: "failed" }] },
  ];
  for (const pr of casos) {
    const st = RV.reviewState(pr, { me: pr.mine ? "ana" : "bruno" });
    assert.ok(!(st.canReview && st.canMerge),
      `revisar e juntar ao mesmo tempo: ${JSON.stringify(pr.mergeStateStatus)}`);
  }
  // e o pintor tem UMA autoridade: nenhum ramo dele decide por conta própria.
  //
  // Isto era um `!/pr\.mine &&/` — UMA sequência de bytes proibida. `pr.mine ===
  // true &&`, `pr["mine"] &&` ou um `mine` desestruturado passavam, e a
  // invariante que a asserção dizia proteger (um primário por tela) não era o
  // que ela testava. Agora o pintor é EXERCIDO sobre a mesma matriz de casos do
  // redutor, e a forma sintática é varrida em cima disso.
  const body = fnBody("decisionHtml");
  assert.match(body, /st\.canMerge/);
  // MIGRADA (rodada 5): a autoridade de «quem ainda tem uma decisão a tomar» era
  // `st.canReview && !st.decided` escrito DENTRO do pintor — e por isso uma
  // aprovação vencida caía num ramo sem controle nenhum. A conta agora é uma
  // resposta só do redutor (`canDecide`), e é ela que o pintor pergunta.
  assert.match(body, /st\.canDecide/);
  const decisao = pintorDaDecisao();
  for (const mine of [true, false]) {
    for (const state of ["OPEN", "MERGED", "CLOSED"]) {
      for (const gate of ["CLEAN", "BLOCKED", "DIRTY", "BEHIND", ""]) {
        for (const mergeable of ["MERGEABLE", "CONFLICTING", "UNKNOWN"]) {
          for (const checks of [[], [{ name: "ci", state: "ok" }], [{ name: "ci", state: "failed" }], [{ name: "ci", state: "running" }]]) {
            for (const changesRequested of [0, 1]) {
              const p = { ...base, mine, state, mergeStateStatus: gate, mergeable, checks, changesRequested };
              const st = RV.reviewState(p, { me: mine ? "ana" : "bruno" });
              const html = decisao(p, st);
              const caso = `mine=${mine} state=${state} gate=${gate} mergeable=${mergeable} checks=${(checks[0] || {}).state || "—"} pedidas=${changesRequested}`;
              assert.ok(!(/data-prmerge/.test(html) && /data-praction/.test(html)),
                `dois primários na mesma tela: ${caso}`);
              assert.strictEqual(/data-prmerge/.test(html), !!st.canMerge,
                `"Juntar" oferecido fora de canMerge (ou escondido dentro dele): ${caso}`);
              assert.strictEqual(/data-praction/.test(html), !!st.canDecide,
                `os três botões de revisão fora de quem pode decidir: ${caso}`);
              assert.ok((html.match(/class="btn solid"/g) || []).length <= 1,
                `mais de uma ação primária desenhada: ${caso}`);
              assert.ok(html.trim(), `nenhum ramo pode devolver vazio — a tela ficaria sem dizer nada: ${caso}`);
            }
          }
        }
      }
    }
  }
  // e a forma: toda condição do pintor pergunta ao estado, não ao PR
  const condicoes = [...body.matchAll(/\bif \(([^)]*)\)\s*\{/g)].map((m) => m[1]);
  assert.ok(condicoes.length >= 6, `esperava os ramos do pintor, achei ${condicoes.length}`);
  for (const c of condicoes) {
    assert.ok(!/\bpr\b/.test(c),
      `um segundo juiz na decisão — reviewState é a autoridade única: if (${c})`);
  }
});

test("R7 — uma revisão já decidida é substituída pelo estado, não por um botão re-armado", () => {
  const pr = {
    number: 9, state: "OPEN", mine: false, author: { login: "ana" },
    mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", checks: [], approvals: 1,
    changesRequested: 0, reviewRequests: [], threads: [],
    reviews: [{ author: "bruno", state: "APPROVED", when: "2026-08-01", stale: false }],
  };
  const st = RV.reviewState(pr, { me: "bruno" });
  assert.equal(st.decided, "approved", "a última submissão de cada autor é que vale");
  const body = fnBody("decisionHtml");
  const iDecided = body.indexOf('st.decided === "approved"');
  const iCanDecide = body.indexOf("st.canDecide");
  assert.ok(iCanDecide >= 0 && iDecided >= 0);
  assert.ok(iCanDecide < iDecided, "quem pode decidir é perguntado ANTES de contar um estado antigo");
  // MIGRADA (rodada 5): a asserção era a forma `st.canReview && !st.decided` no
  // pintor. A afirmação é a mesma e mais forte — EXERCIDA: com a decisão tomada e
  // ainda válida, os três botões não voltam.
  assert.equal(st.canDecide, false, "nada novo desde a minha aprovação: não há decisão a tomar");
  const html = pintorDaDecisao()(pr, st);
  assert.ok(!/data-praction/.test(html), "com a decisão tomada os três botões não podem ser oferecidos de novo");
  assert.match(html, /você aprovou/, "e o que fica na tela é o estado");
  assert.ok(EN["você aprovou"] && EN["a mudança entra no conhecimento oficial quando todas as aprovações chegarem."]);
});

// ------------------------------------------------------------------- R10
// ACHADO NO APP RODANDO: com o gh instalado e não autenticado, a lista do time
// mostrou "To get started with GitHub CLI, please run: gh auth login" — inglês
// cru do subprocesso, no meio de uma tela em português. `gh_pr_list` é anterior
// ao contrato de códigos estáveis e devolve o stderr do gh; a tela é o último
// lugar onde isso pode ser barrado (ARCHITECTURE §4 / ADR-0001 §10).
test("R10 — prosa de subprocesso nunca chega à tela; um código estável, sim", () => {
  const body = fnBody("renderTeamReviews");
  assert.match(body, /startsWith\("err\."\)/,
    "o que se traduz é um código estável; o resto não é mensagem que o produto escreveu");
  const i = body.indexOf('startsWith("err.")');
  const j = body.indexOf("tErr(REV.prsErr)");
  assert.ok(j > i, "tErr só é chamado depois de saber que o texto É um código");
  // MIGRADA (rodada 3, R20): a asserção era `code ? tErr(REV.prsErr) : ""` — o
  // ramo sem código não repassava o inglês do gh e também não escrevia NADA, e o
  // espaço em branco era o que a linha reservada dizia. A afirmação continua a
  // mesma, mais forte: o inglês cru não entra E a frase é escrita pelo produto.
  const semCodigo = body.slice(body.indexOf('startsWith("err.")'));
  const ramo = semCodigo.slice(semCodigo.indexOf("note.textContent"), semCodigo.indexOf("go.hidden"));
  assert.match(ramo, /code \? tErr\(REV\.prsErr\)/, "com código, a tradução do código");
  assert.match(ramo, /: *\n? *t\("o Loro não conseguiu falar com o GitHub agora/,
    "sem código, a tela DIZ o que houve — nem o inglês do gh, nem uma linha em branco");
  assert.ok(!/note\.textContent = code \? tErr\(REV\.prsErr\) : ""/.test(body));
  // e a saída existe nos dois casos: repetir, ou ir ao diagnóstico
  assert.match(body, /ver o que falta em Configurações/);
  assert.ok(EN["ver o que falta em Configurações"]);
});

// -------------------------------------------------------------------- R8
test("R8 — BR-8: nenhuma linha de diff, corpo de revisão ou comentário chega a um log", () => {
  const suspeitos = [];
  for (const fn of ["diffRowsHtml", "changeCardHtml", "threadHtml", "decisionHtml",
    "renderReviewDetail", "sendReviewDecision", "promptReply", "loadReviewDetail"]) {
    for (const m of fnBody(fn).matchAll(/clog\(([^)]*)\)/g)) suspeitos.push(`${fn}: ${m[1]}`);
  }
  assert.deepStrictEqual(suspeitos, [],
    "BR-8: um diff é conteúdo de conhecimento — ele vai para a tela e para lugar nenhum mais:\n  " + suspeitos.join("\n  "));
});

// ------------------------------------------------------------------- R11
// Cromo morto tem uma forma em JS que a varredura de HTML não pega: uma função
// sem chamador e um campo de estado que ninguém lê. Os dois envelhecem como
// verdade e mentem na próxima leitura (DESIGN.md §9 / honest-controls N13).
// O alcance desta varredura era um filtro de PREFIXOS (`^rev`, `paintEdit`, …)
// com piso `>= 20`: 35 funções passavam pelo filtro, então quinze podiam sair
// dele — por um rename, por uma mudança para review.js, por virar arrow — e a
// varredura parava de cobri-las sem nunca reprovar. Duas nem eram do destino
// (revealAnchor, paintEditFoot), pegas pelos prefixos soltos. É a mesma doença
// que o N5 nomeia ao trocar `calls >= 4` por rotas NOMEADAS: uma contagem com
// folga não reprova. A lista é explícita nas duas direções — perder uma função
// dela reprova, e ACRESCENTAR uma função ao destino sem listá-la também.
const DA_REVISAO = [
  "withPending", "plural", "teamBlockCode", "paintReviewIntro", "paintReviewDraft",
  "changeBadge", "diffRowsHtml", "plainBitsHtml", "wireCardToggle", "changeCardHtml",
  "checksHtml", "paintEditBanner", "renderMyChanges", "refreshMyChanges",
  "saveVersionFromReview", "chipHtml", "teamRowHtml", "renderTeamReviews",
  "refreshTeamReviews", "backToReviewList", "openReview", "loadReviewDetail",
  "decisionHtml", "threadHtml", "renderReviewDetail", "wireReviewDetail",
  "sendReviewDecision", "mergeReview", "promptReply", "openForEditing",
  "backToMyDraft", "renderDestReview", "refreshReview", "wireDiffMore",
  // achado do dono no remote real · a prosa da revisão é markdown (R56)
  "reviewProse", "reviewProseHtml",
  // achado do dono · a travada do clique e a idade da leitura (R57)
  "paintReviewAge",
  // achado do dono · enviar não é um passo quando a revisão já existe (R58)
  "paintOpenReviewState", "reviewMe",
  // uma porta, não duas (R61)
  "emptyStateOffersCfg",
  // o rótulo de um chip para o nome acessível, e a sugestão nomeada (R62)
  "chipLabel", "suggestionHtml",
  // «ainda não carreguei» é um terceiro fato (R63)
  "paintLoading",
  // o rascunho no cabeçalho, como o desenho previu (R64)
  "paintHeadDraft",
  // a forma compacta do chip e a pergunta certa sobre criar rascunho (R66)
  "draftChipCompact", "willCreateDraft",
  "repaintFocused", "threadWhere", "threadOf",
  // rodada 4 · as funções que fecharam os achados da crítica
  "announceRev", "focusMarkIn", "restoreFocusMark", "paintTeamGate", "paintUnsavedDocs",
  // fora do bloco do destino, mas da mesma superfície
  "promptNewDraft", "openTeamTemplateSheet", "draftNameFromBranch", "placeName",
  "draftChipLabel", "dirtyDocs", "versionBtnState", "openCfgGit",
];

test("R11 — o destino não deixa função sem chamador nem estado que ninguém lê", () => {
  const decl = [...APP.matchAll(/^(?:async )?function ([A-Za-z_$][\w$]*)\(/gm)].map((m) => m[1]);
  const daRevisao = DA_REVISAO;
  const fora = daRevisao.filter((n) => !decl.includes(n));
  assert.deepStrictEqual(fora, [],
    "função do destino que saiu da varredura (renomeada? movida? virou arrow?):\n  " + fora.join("\n  "));
  // e a lista não pode envelhecer: toda função declarada no bloco do destino está nela
  const bloco = APP.slice(
    APP.indexOf("/* ====================== Revisão · o destino"),
    APP.indexOf("// ============================ produção: modal genérico")
  );
  assert.ok(bloco.length > 4000, "o bloco do destino é onde ele mora");
  const naoListadas = [...bloco.matchAll(/^(?:async )?function ([A-Za-z_$][\w$]*)\(/gm)]
    .map((m) => m[1]).filter((n) => !daRevisao.includes(n));
  assert.deepStrictEqual(naoListadas, [],
    "função nova no destino e fora da varredura de órfãs:\n  " + naoListadas.join("\n  "));
  const orfas = daRevisao.filter((n) =>
    (APP.match(new RegExp(`\\b${n}\\b`, "g")) || []).length < 2);
  assert.deepStrictEqual(orfas, [], "função definida e nunca chamada:\n  " + orfas.join("\n  "));
  // e todo campo de REV é lido em algum lugar, não só escrito.
  //
  // O varredor era POSICIONAL (rodada 3): `/^\s{2}(\w+):/gm` colhia só o PRIMEIRO
  // campo de cada linha, e o segundo padrão casava PARES — então um terceiro campo
  // na mesma linha (`sig: "", teamSig: "", zumbi: 0,`) não era colhido por nenhum
  // dos dois e `soEscritos` ficava vazio por um motivo que não tinha nada a ver com
  // o código. Uma asserção que não pode reprovar é a mesma doença do filtro de grep
  // que já escondeu um diff do cargo fmt neste repositório. Agora é UMA passada por
  // `nome:` sobre o bloco inteiro, com piso — se o varredor cegar, ele reprova.
  const rev = APP.slice(APP.indexOf("const REV = {"), APP.indexOf("const reviewOn ="))
    .replace(/\/\/[^\n]*/g, "");   // um comentário não declara campo
  const campos = [...new Set([...rev.matchAll(/(?:^|[{,]\s*)([a-zA-Z][\w$]*)\s*:/gm)].map((m) => m[1]))];
  assert.ok(campos.length >= 18,
    `só ${campos.length} campos de REV foram colhidos — o varredor cegou: ${campos.join(", ")}`);
  const soEscritos = campos.filter((c) =>
    (APP.match(new RegExp(`REV\\.${c}\\b`, "g")) || []).length < 2);
  assert.deepStrictEqual(soEscritos, [], "estado escrito e nunca lido:\n  " + soEscritos.join("\n  "));
});

// ------------------------------------------------------------------- R12
// ACHADO NO APP RODANDO (rodada 2): no conhecimento oficial, "Salvar versão do
// projeto" mandava a DESCRIÇÃO como slug do rascunho. `brain_version` endereça o
// rascunho por slug e `create_branch` faz `git checkout -b rfc/<slug>`: um clique
// movia a pessoa para um rascunho de 49 letras que ela não nomeou, numa tela cujo
// chip dizia "no conhecimento oficial" e cuja folha vizinha ensina "até 24
// letras". A troca de ramo é o próprio git vazando pela tela feita para esconder
// ele (DESIGN.md §1: o preço está dito na cópia, e o estado nunca mente).
test("R12 — salvar não cria em silêncio um rascunho nomeado pela sua frase", () => {
  const body = fnBody("saveVersionFromReview");
  assert.ok(!/slug: draft \|\| message/.test(body),
    "a descrição crua virava o nome do rascunho — 49 letras que ninguém escolheu");
  assert.match(body, /draftSlugify\(/,
    "o nome do rascunho segue a regra de 24 letras da folha «Novo rascunho»");
  // a MESMA regra pinta a frase que a tela diz antes do clique: duas regras
  // seriam a tela prometendo um nome e o backend criando outro
  assert.match(fnBody("paintReviewDraft"), /draftSlugify\(/,
    "quem anuncia o nome usa a mesma regra de quem o cria");
  const slugify = new Function(
    APP.match(/const DRAFT_MAX = \d+;/)[0] + "\nreturn " + fnSource("draftSlugify") + ";")()
;
  const frase = "onboarding atualizado com o novo prazo do convite";
  assert.ok(slugify(frase).length <= 24, `o nome anunciado tem de caber na regra: ${slugify(frase)}`);
  assert.equal(slugify(frase), "onboarding-atualizado-co");
  // o nome DITO é o nome criado: sanitize_slug (git.rs) apara as pontas, então um
  // corte que caia num "-" fazia a tela anunciar um rascunho que não existe
  assert.equal(slugify("abcdefghijklmnopqrstuvw xyz"), "abcdefghijklmnopqrstuvw");
  assert.ok(!/-$/.test(slugify("prazo do convite atualizado hoje")));
  // e a segunda metade do preço está no compositor, ANTES do botão
  const bloco = HTML.slice(HTML.indexOf('id="revSave"'), HTML.indexOf('id="revTeam"'));
  const nota = bloco.indexOf('id="revSaveNote"');
  assert.ok(nota > 0, "a tela diz que salvar aqui CRIA um rascunho");
  assert.ok(nota < bloco.indexOf('id="revSaveBtn"'), "e diz antes do clique");
  assert.ok(EN["salvar cria o rascunho «%1» e guarda a versão nele — o conhecimento oficial só recebe mudanças por revisão."]);
  assert.ok(EN["salvar cria um rascunho de trabalho com o nome da sua descrição — o conhecimento oficial só recebe mudanças por revisão."]);
  // e o preço é dito a quem NÃO VÊ a tela: as duas frases são a descrição do
  // botão, então chegar nele pelo teclado é ouvi-las (WCAG 3.3.2)
  // MIGRADO (rodada 4): a descrição do botão ganhou a terceira frase do preço (o
  // texto que ainda não está no arquivo, R36) — a asserção passa a exigir as três.
  const desc = /id="revSaveBtn"[^>]*aria-describedby="([^"]*)"/.exec(bloco);
  assert.ok(desc, "o botão continua descrito pelo preço");
  for (const id of ["revSavePrice", "revSaveNote", "revUnsavedNote"]) {
    assert.ok(desc[1].split(/\s+/).includes(id),
      `quem chega ao botão pelo teclado tem de ouvir o preço inteiro: falta #${id}`);
  }
  assert.match(bloco, /id="revSavePrice"/);
  // a nota é escrita em tempo de execução, e por um pintor só
  assert.match(bloco, /id="revSaveNote"[^>]*data-i18n-dyn/);
  const escritores = ["paintReviewDraft", "renderMyChanges", "renderDestReview", "saveVersionFromReview"]
    .filter((f) => fnBody(f).includes("revSaveNote"));
  assert.deepStrictEqual(escritores, ["paintReviewDraft"], "duas canetas na mesma frase é como ela passa a mentir");
  // e uma gravação que falha DIZ (o invoke não tinha captura: a promessa
  // rejeitada morria no console e a tela não dizia nada)
  assert.match(body, /catch/, "uma versão que não salvou tem de dizer o que houve");
  assert.match(body, /startsWith\("err\."\)/,
    "um código estável se traduz; o inglês cru do git não é mensagem do produto (R10)");
  assert.ok(EN["não consegui salvar a versão agora"]);
});

// ------------------------------------------------------------------- R13
// ACHADO: `CheckRun { name, state, url }` chegava inteiro do backend e a tela
// dobrava tudo em UMA palavra ("✗ verificações falharam"). O revisor era avisado
// de que a mudança está bloqueada e não tinha como saber por qual verificação nem
// onde vê-la: a única saída era ir ao GitHub — na tela cuja razão de existir é
// ler a mudança DENTRO do Loro (S5).
test("R13 — uma verificação que falha é nomeada na tela, com o caminho até ela", () => {
  const body = fnBody("checksHtml");
  assert.match(body, /failingChecks\(/, "quem decide o que falhou é o redutor puro");
  assert.match(body, /c\.name/, "a linha diz QUAL verificação falhou");
  assert.match(body, /data-prcheck/, "e leva até ela");
  assert.match(body, /aria-label="\$\{esc\(t\("ver a verificação ↗"\)\)\} — \$\{esc\(name\)\}"/,
    "«ver a verificação» repetido em N linhas não diz QUAL (WCAG 2.4.6)");
  const detail = fnBody("renderReviewDetail");
  assert.match(detail, /checksHtml\(/, "a revisão aberta pinta o bloco");
  assert.match(detail, /openProposalUrl\(/, "a porta para o navegador continua sendo uma só");
  assert.match(detail, /revPrChecks/);
  assert.match(HTML, /id="revPrChecks"/, "o bloco tem lugar na revisão aberta");
  // um distintivo/bloco tem UM escritor (R1)
  const escritores = ["renderReviewDetail", "renderTeamReviews", "renderMyChanges", "renderDestReview"]
    .filter((f) => fnBody(f).includes("revPrChecks"));
  assert.deepStrictEqual(escritores, ["renderReviewDetail"]);
  assert.ok(EN["Verificações que falharam"] && EN["ver a verificação ↗"]);
  assert.ok(EN["verificação sem nome"], "uma linha anônima seria cromo morto");
});

// ------------------------------------------------------------------- R14
// ACHADO: o resumo inserido ao abrir um cartão vinha de `diffFileAt(path)`, que
// procurava o caminho na árvore de trabalho PRIMEIRO e na revisão aberta depois.
// As duas listas são chaveadas pelo mesmo caminho do acervo: um revisor com
// edição local no documento que a proposta também muda abria o cartão da proposta
// e lia o SEU texto como "como fica" — com o diff verdadeiro logo abaixo.
test("R14 — o cartão resolve o caminho na lista que o desenhou, não em duas globais", () => {
  assert.ok(!/function diffFileAt/.test(APP),
    "resolver um caminho contra DUAS listas globais é o defeito, não a implementação");
  const src = fnSource("wireCardToggle");
  assert.match(src, /function wireCardToggle\(root, files/, "a lista é parâmetro");
  const body = fnBody("wireCardToggle");
  assert.ok(!/REV\.changes|REV\.detailDiff/.test(body),
    "nenhuma lista global entra aqui: a dona do cartão é quem ligou o cartão");
  assert.match(body, /RV\.fileAt\(files,/, "e a busca é a do módulo puro, com a lista dada");
  // cada pintor passa a SUA lista, e é a mesma de que os cartões nasceram
  const meu = fnBody("renderMyChanges");
  assert.match(meu, /files\.map\(\(f\) => changeCardHtml\(f/, "os cartões daqui nascem de REV.changes");
  assert.match(meu, /wireCardToggle\(list, files\)/);
  const det = fnBody("renderReviewDetail");
  assert.match(det, /const fl = REV\.detailDiff/, "os cartões da revisão nascem do diff da revisão");
  assert.match(det, /fl\.map\(\(f\) => changeCardHtml\(f/);
  assert.match(det, /wireCardToggle\(files, fl\)/);
});

// ------------------------------------------------------------------- R15
// ACHADO: passadas 400 linhas a leitura terminava num aviso contado ("… e mais
// 812 linhas") e mais nada — um beco sem saída dentro do destino cuja razão de
// existir é ver as linhas exatas (S3). O intervalo ENTRE dois pedaços continua
// sendo só aviso (o backend manda -U3 e nada mais), mas o CORTE é do app: as
// linhas já estão na memória, então continuar a leitura é um clique.
test("R15 — uma leitura cortada tem como continuar, dentro da tela", () => {
  const body = fnBody("diffRowsHtml");
  assert.match(body, /data-rvmore/, "o corte carrega o controle que continua a leitura");
  assert.match(body, /REV\.rowsMore/, "e quanto já foi aberto é estado, não acidente do DOM");
  assert.ok(EN["mostrar mais linhas"]);
  // o intervalo segue sem controle: um botão que abre nada é o que §1 proíbe
  const gap = body.slice(body.indexOf('r.kind === "gap"'), body.indexOf('r.kind === "uni"'));
  assert.ok(!/data-rv|<button/.test(gap), "o intervalo é aviso, não controle");
  // as duas listas de cartões ligam o controle, pelo MESMO ligador
  const wirer = fnBody("wireDiffMore");
  assert.match(wirer, /data-rvmore/);
  assert.match(wirer, /REV\.rowsMore\.set\(/, "o teto sobe um passo por clique");
  assert.match(wirer, /DIFF_ROWS_MAX/, "e o passo é o mesmo que o desenho usa");
  assert.match(wirer, /repaint\(\)/, "o clique repinta: um controle sem efeito visível não existe");
  for (const fn of ["renderMyChanges", "renderReviewDetail"]) {
    assert.match(fnBody(fn), /wireDiffMore\(/, `${fn} liga o controle que desenhou`);
  }
  // e a assinatura do poll não pode engolir o repintar do clique
  assert.match(fnBody("renderMyChanges"), /\[\.\.\.REV\.rowsMore\]/,
    "sem o teto na assinatura, `if (sig === REV.sig) return` mata o clique");
});

// ------------------------------------------------------------------- R16
// ACHADO: `⎇ no conhecimento oficial` era pintado para QUALQUER branch fora do
// padrão rfc/… — inclusive o rascunho que a faixa logo acima nomeia em F11. Na
// mesma tela, ao mesmo tempo: "você está editando o rascunho «feature/x»" e "a
// versão vai para o conhecimento oficial", com o ✦ IA mostrando "⎇ feature/x".
// Um fato não pode ter duas respostas numa tela (DESIGN.md §5).
test("R16 — o chip do rascunho não chama de oficial o rascunho que a faixa nomeia", () => {
  const nome = new Function(
    fnSource("draftSlugFromBranch") + "\n" + fnSource("draftNameFromBranch") + "\nreturn draftNameFromBranch;"
  )();
  assert.equal(nome("main", "main"), "", "só o branch principal É o conhecimento oficial");
  assert.equal(nome("", "main"), "");
  assert.equal(nome("rfc/frota", "main"), "frota", "um rascunho endereçável diz o slug");
  assert.equal(nome("feature/x", "main"), "feature/x",
    "e um branch de outra origem diz o nome real — era aqui que a tela dizia 'oficial'");
  assert.equal(nome("master", "master"), "");
  const body = fnBody("paintReviewDraft");
  // MIGRADO (rodada 4): o chip passou a ser escrito por draftChipLabel, que é a
  // MESMA frase do chip do painel ✦ IA — e é ela que chama draftNameFromBranch.
  assert.match(body, /draftChipLabel\(/, "o chip usa a mesma resposta da faixa");
  assert.match(fnBody("draftChipLabel"), /draftNameFromBranch\(/);
  assert.match(fnBody("draftChipLabel"), /no conhecimento oficial/);
  // e a faixa de F11 e a linha da lista falam pela mesma função
  assert.match(fnBody("paintEditBanner"), /draftNameFromBranch\(/);
  assert.match(fnBody("teamRowHtml"), /draftNameFromBranch\(/);
});

// ------------------------------------------------------------ o destino inteiro
test("ADR-0027 — o preço de salvar está dito ACIMA do botão, antes do clique", () => {
  const bloco = HTML.slice(HTML.indexOf('id="revSave"'), HTML.indexOf('id="revTeam"'));
  const preco = bloco.indexOf("guarda o projeto inteiro");
  const botao = bloco.indexOf('id="revSaveBtn"');
  assert.ok(preco > 0 && botao > 0, "o compositor tem o preço e o botão");
  assert.ok(preco < botao,
    "D4 · o botão grava direto, então a frase que a folha dizia depois tem de estar antes");
});

test("ADR-0027 — todo estado vazio da Revisão orienta o passo seguinte", () => {
  const body = fnBody("renderMyChanges");
  // cada caminho vazio escreve um título E uma frase; os que têm remédio têm botão
  assert.match(body, /err\.git_repo_required/, "sem histórico de versões é um estado, não um erro cru");
  assert.match(body, /tentar de novo/, "uma leitura que falhou tem porta de saída");
  assert.match(body, /tudo salvo/);
  const team = fnBody("renderTeamReviews");
  assert.match(team, /abrir Configurações/, "não conectado: o remédio é um botão, não uma frase");
  assert.match(team, /sem conexão agora/, "sem rede a lista diz que é a última leitura");
  assert.match(team, /nenhuma revisão aberta ainda/);
});

test("ADR-0027 — o destino não é escondido quando o GitHub não está conectado", () => {
  // a metade local (o que você mudou) é git puro: esconder o destino esconderia
  // uma capacidade que funciona, e o botão da nav não tem gate nenhum
  const nav = HTML.slice(HTML.indexOf('id="destNav"'), HTML.indexOf("</nav>"));
  assert.match(nav, /data-dest="review"/);
  assert.ok(!/data-dest="review"[^>]*hidden/.test(nav), "o destino existe sempre");
  const cmds = APP.slice(APP.indexOf("const COMMANDS = ["), APP.indexOf("let cmdkMode"));
  const linha = cmds.match(/\{ group: "ir para", label: "Revisão"([^\n]*)/);
  assert.ok(linha, "⌘K tem a linha do destino");
  assert.ok(!/when:/.test(linha[1]), "sem gate: o que degrada é a aba do time, e ela degrada DIZENDO");
});

test("ADR-0027 — o rascunho de outra pessoa se abre pelo MESMO preço de qualquer troca", () => {
  const body = fnBody("openForEditing");
  assert.match(body, /switchPrice\(/, "F11 não pode ter um caminho de troca sem preço");
  const iPreco = body.indexOf("switchPrice(");
  const iTroca = body.indexOf("git_switch_branch");
  assert.ok(iTroca > iPreco, "o preço é calculado antes de a árvore se mover");
  assert.match(body, /REV\.cameFrom/, "e o caminho de volta é guardado, não adivinhado");
  assert.match(fnBody("backToMyDraft"), /cameFrom/);
  assert.ok(EN["voltar ao meu rascunho"]);
});

/* ══════════════ rodada 3 · o que os críticos acharam NO APP RODANDO ══════════
   Cada teste abaixo tem o nome do DEFEITO, não o da correção. Os nove primeiros
   nasceram de um fluxo que não fecha ou de um estado que só existe em pixels; os
   últimos, de asserções que não podiam reprovar — um guarda que passa por causa
   da linha errada é pior que nenhum, porque diz que o defeito está coberto. */

// ------------------------------------------------------------------- R17
// ACHADO NO APP RODANDO: enviar para revisão falha (o gh não está autenticado
// neste HOME), a folha FECHA, os sete campos digitados vão embora e o único aviso
// do erro expira com o toast — a tela volta a ser exatamente o que era antes da
// tentativa, sem registro dela. O fechamento era incondicional: QUALQUER folha
// que falhasse descartava o que a pessoa escreveu.
test("R17 — uma folha que falha não fecha levando embora o que a pessoa escreveu", () => {
  const i = APP.indexOf('PM.confirm.addEventListener("click"');
  assert.ok(i > 0, "o confirmar da folha continua ligado");
  const h = APP.slice(i, APP.indexOf("\n});", i) + 4);
  // o desfecho decide: fechar é do sucesso, e o erro FICA na tela
  assert.match(h, /if \(failed\)/, "o caminho do erro é um ramo próprio, não o mesmo do sucesso");
  assert.match(h, /else closeModal\(\);/,
    "fechar é do sucesso: fechar no erro apaga os campos e o motivo de uma vez");
  assert.match(h, /pmOnConfirm = fn;/,
    "e a folha volta armada: sem isso o confirmar da folha que ficou não faz mais nada");
  assert.match(h, /pmOnDismiss = dismissed;/,
    "quem espera a folha continua sendo avisado por qualquer saída (a doença do ● travado)");
  assert.match(h, /pmError\(failed\)/, "o motivo é escrito DENTRO da folha");
  // e o corpo da folha não é reconstruído: openModal só escreve no corpo quando
  // uma folha NOVA abre
  const conf = h.slice(h.indexOf("try {"));
  assert.ok(!/PM\.body\.innerHTML/.test(conf), "reescrever o corpo apagaria os campos digitados");
  // a mensagem tem lugar próprio na folha, é anunciada e tem porta de saída
  assert.match(HTML, /id="pmErr"[^>]*role="alert"/, "o motivo é um alerta, não uma frase muda");
  assert.match(HTML, /id="pmErrMsg"/);
  assert.match(HTML, /id="pmErrGo"/, "quando o app sabe o remédio, ele é um botão");
  const err = fnBody("pmError");
  assert.match(err, /announce\(/, "WCAG 4.1.3: quem não vê a folha também é avisado");
  assert.match(err, /tErr\(/, "um código estável se traduz");
  // o remédio é o MESMO da recusa prévia de F5, não uma segunda regra: a lista de
  // códigos cujo remédio é o diagnóstico cobre tudo o que teamBlockCode escolhe
  assert.match(err, /ENV_REMEDY\.includes\(/);
  const remedio = APP.match(/const ENV_REMEDY = \[([\s\S]*?)\];/);
  assert.ok(remedio, "a lista de códigos com remédio é explícita");
  for (const code of [...fnBody("teamBlockCode").matchAll(/"(err\.[a-z_]+)"/g)].map((m) => m[1])) {
    assert.ok(remedio[1].includes(code),
      `${code} bloqueia a metade do time e a folha não oferece a porta de Configurações`);
  }
  // e o motivo morre com a folha: nem a próxima folha o herda, nem ele fica na
  // árvore de acessibilidade de uma folha que já saiu da tela
  assert.match(fnBody("openModal"), /pmError\(""\)/);
  assert.match(fnBody("closeModal"), /pmError\(""\)/);
});

// ------------------------------------------------------------------- R18
// ACHADO NO APP RODANDO: a folha «Rascunhos de trabalho» — a única tela cuja
// função é ESCOLHER o lugar — chamava os lugares de `main (principal)` e
// `● rfc/onboarding-atualizado-co`, um clique ao lado do chip do compositor que
// diz «no conhecimento oficial» e «no rascunho onboarding-atualizado-co». Um
// fato com dois nomes na distância de um clique (DESIGN.md §4/§5).
test("R18 — a folha que escolhe o lugar não chama os lugares pelo nome do git", () => {
  const nome = new Function(
    'const t = (m, a) => String(m).replace(/%([1-9])/g, (_, i) => (a && a[i - 1] !== undefined ? a[i - 1] : "%" + i));\n' +
    fnSource("draftSlugFromBranch") + "\n" + fnSource("draftNameFromBranch") + "\n" +
    fnSource("placeName") + "\nreturn placeName;"
  )();
  assert.equal(nome("main", "main"), "conhecimento oficial");
  assert.equal(nome("rfc/frota", "main"), "rascunho «frota»", "nem `rfc/`, nem `(principal)`");
  assert.equal(nome("feature/x", "main"), "rascunho «feature/x»");
  const picker = fnBody("openBranchPicker");
  assert.match(picker, /placeName\(/, "a linha visível é nomeada pela mesma função");
  assert.ok(!/\(\$\{t\("principal"\)\}\)|esc\(b\.name\)\}\$\{def/.test(picker),
    "«main (principal)» era o nome do git com uma legenda");
  assert.ok(!/aria-label="\$\{esc\(b\.name\)\}/.test(picker),
    "o nome acessível dizia `main` mesmo quando a linha visível não dizia");
  // a folha do preço diz PARA ONDE se vai, não só o caminho de volta
  const conf = fnBody("confirmSwitchBranch");
  assert.match(conf, /placeName\(/, "um preço que não nomeia o destino é meio preço");
  assert.match(conf, /"vai para"/, "e o destino tem rótulo próprio na folha");
  // e a duplicata saiu: «7 documentos saem da tela — lá ainda não há nenhum
  // documento — a tela vai ficar vazia» eram duas orações dizendo o mesmo, uma
  // colada na outra. Agora são ramos exclusivos: ou a contagem, ou a tela vazia.
  assert.match(conf, /price\.targetEmpty\s*\n?\s*\?/, "a tela vazia é um RAMO, não um apêndice");
  const preco = conf.slice(conf.indexOf("price.targetEmpty"), conf.indexOf("nada é apagado"));
  assert.ok(!/documentos saem da tela[\s\S]*lá ainda não há/.test(preco) &&
    !/lá ainda não há[\s\S]*documentos saem da tela/.test(preco.replace(/\?[\s\S]*?:/, "")),
    "as duas orações não podem sair juntas na mesma frase");
  // e a rota por documento também deixou de imprimir o nome do ramo
  assert.ok(!/⎇ rfc\//.test(APP), "`⎇ rfc/<slug>` é o git vazando pela tela que existe para escondê-lo");
  assert.ok(EN["conhecimento oficial"] && EN["rascunho «%1»"] && EN["vai para"]);
});

// ------------------------------------------------------------------- R19
// R19 nasceu de um defeito real: com mudança não salva, a folha oferecia todas as
// linhas (clique 1), prometia um preço que não ia acontecer (clique 2) e só no
// clique 3 dizia que não dava. A cura foi apagar as linhas quando `dirty`.
//
// REVERTIDA por achado do dono (2026-08-17): «não tenho conseguido trocar de branch
// onde a opção aparece». A premissa da R19 era que a troca SERIA recusada — e era,
// porque `switch_branch` recusava qualquer árvore suja ANTES de perguntar ao git.
// O git só recusa quando sobrescreveria a modificação; no caso comum ele a leva com
// a pessoa. E desde que salvar o arquivo parou de commitar (round 8), árvore suja é
// o estado NORMAL — então a folha vivia com todas as linhas mortas.
//
// A claim que fica é mais forte, porque cobre os dois lados: a folha não pré-recusa
// o que o git aceita, E a recusa que sobra chega com o remédio.
test("R19 — a folha não pré-recusa a troca que o git aceitaria", () => {
  const picker = fnBody("openBranchPicker");
  assert.match(picker, /const off = false;/,
    "apagar a linha por `dirty` matava a troca que o git faria sem perder nada");
  assert.ok(!/const off = dirty && !cur/.test(picker),
    "a árvore suja deixou de ser uma recusa: ela é um preço, e um preço se diz");

  // e o preço É dito, antes do clique
  assert.match(picker, /info\.dirty/, "a verdade continua vindo do mesmo git_branches");
  assert.match(picker, /ela vai com você para o rascunho escolhido/,
    "o que acontece com a mudança não salva é dito na folha (DESIGN.md §1)");
  assert.match(picker, /a troca é recusada e a tela diz qual/,
    "e o caso em que o git recusa é dito junto, em vez de virar surpresa no clique");
  assert.ok(EN["você tem mudança que ainda não está em nenhuma versão: ela vai com você para o rascunho escolhido. Se lá o documento for diferente, a troca é recusada e a tela diz qual."]);

  // «＋ novo rascunho…» segue vivo, como sempre foi
  const novo = picker.slice(picker.indexOf("data-newbranch"));
  assert.ok(!/data-off/.test(novo), "criar um rascunho novo nunca foi bloqueado");
});

test("R19 — quem decide se a troca pode é o git, e a recusa vem com o remédio", () => {
  const sw = GIT.slice(GIT.indexOf("pub fn switch_branch"), GIT.indexOf("\n}", GIT.indexOf("pub fn switch_branch")));
  assert.ok(!/if is_dirty\(base\) \{/.test(sw),
    "a pré-checagem era mais severa que o git: era ela que criava o beco sem saída");
  assert.match(sw, /args\(\["checkout", branch\]\)/, "a tentativa acontece");
  assert.match(sw, /would be overwritten|local changes/,
    "e a única recusa que o git dá aqui é a sobrescrita");
  assert.match(sw, /err\.switch_would_lose_change/,
    "que é a única vez em que «salve uma versão primeiro» é o conserto certo");
  assert.ok(ERR_PT["err.switch_would_lose_change"] && EN["err.switch_would_lose_change"],
    "o código novo precisa do texto em pt-BR e do par em inglês");
  // e os dois casos estão pinados no Rust, com o chão intacto na recusa
  assert.match(GIT, /fn a_pending_edit_travels_with_you_instead_of_blocking_the_switch/);
  assert.match(GIT, /fn a_switch_that_would_overwrite_the_edit_is_refused_with_the_remedy/);
});

// ------------------------------------------------------------------- R20
// ACHADO NO APP RODANDO: «não consegui ler as revisões agora», a linha de
// explicação VAZIA e um botão. Descartar o inglês cru do gh é certo; não escrever
// nada no lugar é a interface sabendo algo que não diz (DESIGN.md §1).
test("R20 — o estado que falhou tem uma frase escrita, não um espaço em branco", () => {
  const team = fnBody("renderTeamReviews");
  assert.ok(!/note\.textContent = code \? tErr\(REV\.prsErr\) : ""/.test(team),
    "a frase do ramo sem código era a string vazia");
  assert.match(team, /o Loro não conseguiu falar com o GitHub agora/,
    "o produto escreve a frase quando o subprocesso não tem uma que sirva");
  assert.ok(EN["o Loro não conseguiu falar com o GitHub agora — o diagnóstico em Configurações diz o que falta."]);
});

// ------------------------------------------------------------------- R21
// ACHADO (teclado, Chrome com o __TAURI__ dublado): Enter numa linha abre a
// revisão e o foco cai em <body>; Enter em «← revisões do time» devolve a lista e
// o foco cai em <body> outra vez — e a lista fica ATRÁS do ponto de partida do
// Tab, então seguindo em frente não se chega mais a ela. WCAG 2.4.3/4.1.2.
test("R21 — abrir e voltar de uma revisão levam o foco com eles", () => {
  const open = fnBody("openReview");
  assert.match(open, /revBack/, "o foco entra na revisão pelo controle que a fecha");
  assert.match(open, /focus\(\)/);
  assert.match(open, /announce\(/, "a vista trocou: quem não vê a tela também é avisado (4.1.2)");
  const back = fnBody("backToReviewList");
  assert.match(back, /data-prdetail/, "voltar devolve o foco à LINHA que foi aberta");
  assert.match(back, /focus\(\)/);
  assert.ok(EN["revisão #%1 aberta"]);
});

// ------------------------------------------------------------------- R22
// ACHADO (árvore de acessibilidade do Chrome): o nome acessível da linha
// SUBSTITUÍA o conteúdo dela — o distintivo «mudanças pedidas», quem pediu, qual
// rascunho e quando desapareciam, e a superfície existe para dizer de quem é a
// vez. E um <button> real morava DENTRO de um div[role=button]: controles
// aninhados, com filhos apresentacionais e exposição indefinida.
test("R22 — o nome da linha do time diz o estado, e nenhum controle mora dentro de outro", () => {
  const row = fnBody("teamRowHtml");
  // quem abre é um <button> de verdade: papel, teclado e foco vêm do elemento
  assert.match(row, /<button class="rvopen" data-prdetail=/,
    "role=button + tabindex era uma imitação; um botão real é mais forte");
  assert.ok(!/role="button" tabindex="0" data-prdetail/.test(row),
    "a linha inteira deixou de ser um controle de mentira");
  // e o ⧉ copiar link é IRMÃO, não filho
  const abre = row.indexOf("rvopen");
  const copia = row.indexOf("data-prurl");
  assert.ok(abre > 0 && copia > abre, "os dois controles existem");
  // o botão que abre FECHA antes de o outro começar: irmãos, não pai e filho
  assert.ok(row.indexOf("</button>", abre) < copia,
    "um controle dentro de outro é aninhamento interativo (axe nested-interactive)");
  // o nome acessível carrega o ESTADO, não só «abrir a revisão #41 — título»
  assert.match(row, /aria-label="\$\{t\("abrir a revisão"\)\} #\$\{num\}/,
    "o número e o assunto continuam no nome (WCAG 2.4.6)");
  assert.match(row, /estado/, "e o distintivo e a linha de meta entram nele (4.1.2)");
  const label = row.slice(row.indexOf("aria-label="), row.indexOf("aria-label=") + 300);
  assert.match(label, /line|meta/, "quem pediu, qual rascunho e quando fazem parte do nome");
});

// ------------------------------------------------------------------- R23
// ACHADO (árvore de acessibilidade): «unificado / lado a lado» carregava a
// seleção SÓ em CSS — aria-pressed ausente nos dois, antes e depois de acionar. O
// espelho da casa (paintAriaState) observa mutações de classe de nós que já
// existem, e estes nascem de innerHTML: escapam por construção.
test("R23 — o seletor de como ler o diff carrega a sua seleção na ARIA", () => {
  const card = fnBody("changeCardHtml");
  assert.match(card, /data-rvmode="unified"[^>]*aria-pressed|aria-pressed="\$\{REV\.mode === "unified"\}"/,
    "a seleção não pode existir só como cor (WCAG 1.4.1/4.1.2)");
  const seg = card.slice(card.indexOf("segrow"), card.indexOf("data-rvseen"));
  assert.equal((seg.match(/aria-pressed=/g) || []).length, 2,
    "os DOIS botões dizem o seu estado: só o escolhido diria metade");
  assert.match(seg, /aria-pressed="\$\{REV\.mode === "split"\}"/);
});

// ------------------------------------------------------------------- R24
// ACHADO (teclado): «marcar como visto», «ver a mudança completa» e o seletor de
// diff funcionam e os três destroem o botão que os carregava — o foco cai em
// <body> e o Tab recomeça no cartão. Para quem usa teclado ou leitor de tela os
// três controles não produzem retorno nenhum (WCAG 2.4.3 + 4.1.3).
test("R24 — um controle que repinta a lista devolve o foco a si mesmo", () => {
  const helper = fnBody("repaintFocused");
  assert.match(helper, /focus\(\)/, "o foco volta para o controle equivalente depois do repintar");
  assert.match(helper, /announce\(/, "e o desfecho é anunciado (4.1.3)");
  for (const [pintor, quantos] of [["renderMyChanges", 3], ["renderReviewDetail", 3]]) {
    const body = fnBody(pintor);
    assert.equal((body.match(/repaintFocused\(/g) || []).length, quantos,
      `${pintor}: os três controles do cartão passam pelo mesmo caminho`);
  }
  // o contador «N de M vistos» é o desfecho de «marcar como visto»
  assert.match(fnBody("renderMyChanges"), /repaintFocused\("data-rvseen"/);
  assert.match(fnBody("renderMyChanges"), /%1 de %2 vistos/);
});

// ------------------------------------------------------------------- R25
// ACHADO (árvore de acessibilidade): duas conversas, dois botões chamados
// exatamente «responder», e a folha que eles abrem («sua resposta») nunca diz a
// QUAL conversa a resposta vai. WCAG 2.4.6 — e o estado não pode mentir: uma
// resposta pode ir para a conversa errada.
//
// REESCRITO (trava, rodada 5): as duas asserções de texto que moravam aqui não
// podiam ficar vermelhas pelo defeito que o teste nomeia. `/data-prreply[^>]*
// aria-label=|…/` é satisfeito pela PRIMEIRA alternativa — basta que o botão
// tenha um aria-label qualquer —, e `/where/` é satisfeito pela linha
// `const where = threadWhere(th)`. Dar a TODAS as conversas o nome «responder —
// a conversa da revisão» passava byte a byte. Agora os dois pintores são
// EXERCIDOS e o que se mede é o que 2.4.6 pede: dois nomes diferentes.
test("R25 — cada «responder» diz de qual conversa é, e a folha repete onde está", () => {
  const interp = (m, a) => String(m).replace(/%([1-9])/g, (_, i) => (a && a[i - 1] !== undefined ? a[i - 1] : "%" + i));
  const escId = (s) => String(s === null || s === undefined ? "" : s);
  // eslint-disable-next-line no-new-func
  const conversa = new Function("deps", `
    const { t, esc, prWhen, mdRender, docOpts } = deps;
    ${fnSource("threadWhere")}
    ${fnSource("reviewProse")}
    ${fnSource("suggestionHtml")}
    ${fnSource("threadHtml")}
    return threadHtml;`)({ t: interp, esc: escId, prWhen: () => "11 de ago.",
    mdRender: (src) => "<p>" + escId(src) + "</p>", docOpts: () => ({ ticketBase: "" }) });
  const nome = (html) => {
    const m = html.match(/data-prreply="[^"]*"\s*aria-label="([^"]*)"/);
    assert.ok(m, "o «responder» da conversa precisa de nome acessível (WCAG 4.1.2)");
    return m[1];
  };
  const a = conversa({ id: 7, path: "contexts/operacoes/context.md", line: 13, excerpt: "o prazo é de 48 horas",
    comments: [{ author: "ana", body: "isso mudou na reunião", when: "2026-08-11" }] });
  const b = conversa({ id: 9, path: "contexts/frota/context.md", line: 40, excerpt: "a vistoria",
    comments: [{ author: "bob", body: "confere com o time", when: "2026-08-12" }] });
  assert.match(nome(a), /contexts\/operacoes\/context\.md:13/, "o nome diz QUAL conversa");
  assert.match(nome(b), /contexts\/frota\/context\.md:40/);
  assert.notEqual(nome(a), nome(b),
    "duas conversas com dois botões de nome IGUAL não dizem qual (WCAG 2.4.6)");
  // 2.5.3 · o rótulo visível é o começo do nome acessível
  assert.match(a, />responder<\/button>/, "o rótulo visível continua curto");
  assert.ok(nome(a).startsWith("responder"), "e é o começo do nome");
  // uma conversa da revisão inteira (sem arquivo) ainda tem nome próprio, não vazio
  assert.equal(nome(conversa({ id: 1, comments: [] })), "responder — a conversa da revisão");

  // A FOLHA repete onde está: o título era «sua resposta» nos dois casos, então
  // dava para postar na conversa errada sem nada na tela dizendo qual era.
  const folhas = [];
  // eslint-disable-next-line no-new-func
  const pedir = new Function("deps", `
    const { t, esc, openModal } = deps;
    ${fnSource("threadWhere")}
    ${fnSource("promptReply")}
    return promptReply;`)({
    t: interp, esc: escId,
    openModal: (titulo, corpo) => folhas.push({ titulo, corpo }),
  });
  pedir({ number: 42 }, { id: 7, path: "contexts/operacoes/context.md", line: 13,
    excerpt: "o prazo é de 48 horas", comments: [{ author: "ana" }] });
  assert.equal(folhas.length, 1);
  assert.match(folhas[0].titulo, /contexts\/operacoes\/context\.md:13/,
    "o título da folha diz a QUAL conversa a resposta vai");
  assert.match(folhas[0].corpo, /ana/, "e quem escreveu nela");
  assert.match(folhas[0].corpo, /48 horas/, "com o trecho citado, a mesma marca da lista");
  // e uma conversa sem arquivo não fica com um título vazio
  pedir({ number: 42 }, { id: 1, comments: [] });
  assert.equal(folhas[1].titulo, "sua resposta");
  assert.ok(EN["responder a %1"]);
});

// ------------------------------------------------------------------- R26
// ACHADO (mutação): dois dos quatro estados na assinatura do repintar não eram
// fixados por nada. Tirar `[...REV.viewed]` faz «marcar como visto» não mudar
// nada na tela; tirar `[...REV.openDiff]` faz «ver a mudança completa» não abrir
// nada — e as 706 asserções continuavam verdes. R15 nomeia essa falha para UMA
// das chaves e deixa as duas vizinhas da mesma linha sem guarda.
test("R26 — toda chave de sessão do repintar está na assinatura", () => {
  const body = fnBody("renderMyChanges");
  const m = body.match(/const sig = JSON\.stringify\(\[([\s\S]*?)\]\);/);
  assert.ok(m, "a assinatura continua sendo uma lista explícita");
  // os quatro estados de sessão que um clique muda: sem qualquer um deles
  // `if (sig === REV.sig) return` mata o clique que o mudou
  for (const chave of ["viewed", "openCard", "openDiff", "rowsMore"]) {
    assert.ok(m[1].includes(`REV.${chave}`),
      `REV.${chave} fora da assinatura: o clique que o muda não repinta nada`);
    // e o campo é REALMENTE lido pelo desenho, senão a assinatura guarda um fantasma
    assert.ok(new RegExp(`REV\\.${chave}\\b`).test(APP.slice(APP.indexOf("function changeCardHtml"))),
      `REV.${chave} não é lido pelo desenho`);
  }
  assert.match(body, /if \(sig === REV\.sig\) return;/);
});

// ------------------------------------------------------------------- R27
// ACHADO (mutação): a asserção que dizia «uma leitura que falhou tem porta de
// saída» conferia o RÓTULO do botão. Trocar o handler por `() => {}` deixava um
// botão que não relê nada na única tela que uma leitura falha alcança, com a
// suíte inteira verde.
test("R27 — a porta do estado vazio é um handler que faz a coisa, não um rótulo", () => {
  const body = fnBody("renderMyChanges");
  assert.match(body, /label: t\("tentar de novo"\), run: \(\) => withPending\(go, \(\) => refreshMyChanges\(\)\)/,
    "«tentar de novo» relê de verdade, e com estado pendente (DESIGN.md §1)");
  const team = fnBody("renderTeamReviews");
  assert.match(team, /go\.onclick = code \? \(\) => withPending\(go, \(\) => refreshTeamReviews\(\)\) : openCfgGit/,
    "os dois remédios da metade do time apontam para o que prometem");
  // MIGRADO (rodada 4): a porta de Configurações abre a SEÇÃO que a frase nomeia
  assert.match(team, /openCfgGit/);
  // e o botão do vazio é escrito por um pintor só (R1)
  const escritores = ["renderMyChanges", "renderTeamReviews", "renderDestReview", "refreshReview"]
    .filter((f) => fnBody(f).includes("revEmptyGo"));
  assert.deepStrictEqual(escritores, ["renderMyChanges"]);
});

// ------------------------------------------------------------------- R28
// ACHADO (mutação): R13 existe porque um revisor não sabia QUAL verificação
// falhou, e a sua asserção era satisfeita pela linha `const name = c.name || …`.
// Esvaziar o `.rvtitle` renderizado deixava o bloco listando linhas anônimas com
// a suíte verde — e o rótulo visível deixava de ser o começo do nome acessível
// (WCAG 2.5.3).
test("R28 — o nome da verificação chega à LINHA, não só à variável", () => {
  const body = fnBody("checksHtml");
  assert.match(body, /<span class="rvtitle">\$\{esc\(name\)\}<\/span>/,
    "o nome é o texto da linha: uma variável lida e não escrita não diz nada");
  assert.match(body, /const name = c\.name \|\| t\("verificação sem nome"\)/,
    "e uma verificação sem nome não vira uma linha anônima");
  // 2.5.3: o rótulo visível é o começo do nome acessível
  const i = body.indexOf('aria-label=');
  assert.ok(i > 0 && /\$\{esc\(name\)\}/.test(body.slice(i, i + 160)),
    "o nome acessível contém o rótulo visível");
});

// ------------------------------------------------------------------- R29
// ACHADO (mutação): o mapeamento do distintivo — o fato mais visível de cada
// cartão — não era fixado por nada. `added → { warn, removido }` passava as 706
// asserções: um documento novo anunciado como removido, na tela feita para dizer
// o que você mudou.
test("R29 — o distintivo do cartão diz o estado que o backend mandou", () => {
  setLang("pt");
  const badge = new Function(
    "const t = (m) => m;\nreturn " + fnSource("changeBadge") + ";")();
  assert.deepStrictEqual(badge("added"), { cls: "ok", label: "novo" });
  assert.deepStrictEqual(badge("removed"), { cls: "warn", label: "removido" });
  assert.deepStrictEqual(badge("renamed"), { cls: "warn2", label: "renomeado" });
  assert.deepStrictEqual(badge("modified"), { cls: "warn2", label: "modificado" });
  // um estado desconhecido não pode virar «novo» nem «removido»
  assert.deepStrictEqual(badge("whatever"), { cls: "warn2", label: "modificado" });
  // quatro estados, quatro palavras: duas iguais seriam dois fatos com um nome
  const labels = ["added", "removed", "renamed", "modified"].map((s) => badge(s).label);
  assert.equal(new Set(labels).size, 4);
  for (const l of labels) assert.ok(EN[l], `sem par em inglês: ${l}`);
  // e o estado é o do backend, sem uma segunda gramática aqui
  assert.deepStrictEqual(RV.classifyFile({ path: "a/b.md", kind: "added" }).status, "added");
});

// ------------------------------------------------------------------- R30
// ACHADO (mutação): R1 fixa QUEM escreve cada distintivo e nunca o NÚMERO que
// ele escreve. `nowBadge.textContent = 0` passava a suíte: a aba mostrando «0» ao
// lado de uma lista de três documentos mudados — o contador que sobrevive à
// verdade que o gerou, pelo outro lado.
test("R30 — o contador da aba escreve o número que o gerou", () => {
  const body = fnBody("renderMyChanges");
  assert.match(body, /nowBadge\.textContent = files\.length;/,
    "o contador é a contagem, não uma constante ao lado dela");
  assert.match(body, /nowBadge\.hidden = !files\.length;/, "e zero não é um distintivo, é ausência");
  const notif = fnBody("refreshNotifications");
  assert.match(notif, /badge\(n\.reviewRequestedToMe\.length\)/,
    "o da nav é a contagem lida de brain_notifications");
});

// ------------------------------------------------------------------- R31
// ACHADO (mutação): trocar `=== "team"` por `!== "team"` em paintReviewIntro
// passava a suíte inteira — cada metade abria com a promessa da OUTRA, e os dois
// msgids existem com par em inglês, então as varreduras de i18n ficavam felizes.
test("R31 — cada metade é apresentada pela promessa dela", () => {
  const intro = new Function("aba",
    'const $ = () => ({ textContent: "", setAttribute() {} });\n' +
    'const t = (m) => m;\n' +
    'const reviewTab = () => aba;\n' +
    'const envDoctor = null;\n' +
    "const alvo = { textContent: \"\" };\n" +
    "const nodes = { revIntro: alvo, revOffline: { hidden: false } };\n" +
    "const $$ = (id) => nodes[id];\n" +
    fnSource("paintReviewIntro").replace(/\$\(/g, () => "$$(") + "\n" +
    "paintReviewIntro(); return alvo.textContent;"
  );
  assert.match(intro("now"), /^Nada sai do seu computador sozinho/,
    "«Mudanças de agora» promete o que ela faz: salvar é local, enviar é outro passo");
  assert.match(intro("team"), /^Mudanças propostas ao conhecimento oficial/,
    "«Revisões do time» promete o que ELA faz: nada entra sem aprovação");
});

// ------------------------------------------------------------------- R32
// ACHADO (mutação): wireCardToggle declarava um terceiro parâmetro que nenhum dos
// dois chamadores passa — um ramo inalcançável em código novo, e R14 fixa
// justamente as duas chamadas de dois argumentos que o tornam inalcançável.
test("R32 — nenhuma função do destino carrega parâmetro que ninguém passa", () => {
  const src = fnSource("wireCardToggle");
  assert.match(src, /function wireCardToggle\(root, files\)/, "dois parâmetros, dois argumentos");
  assert.ok(!/typeof repaint === "function"/.test(src), "o ramo inalcançável saiu junto");
  // o irmão continua recebendo o seu repaint dos dois lados — é a assimetria que
  // deixou o parâmetro morto visível
  assert.match(fnSource("wireDiffMore"), /function wireDiffMore\(root, repaint\)/);
  for (const pintor of ["renderMyChanges", "renderReviewDetail"]) {
    const body = fnBody(pintor);
    const chamada = body.match(/wireCardToggle\(([^)]*)\)/);
    assert.ok(chamada, `${pintor} liga os cartões`);
    assert.equal(chamada[1].split(",").length, 2,
      `${pintor}: a chamada tem de casar com a assinatura`);
    assert.match(body, /wireDiffMore\([^)]+,[^)]+\)/, `${pintor} passa o repaint do irmão`);
  }
});

// ------------------------------------------------------------------- R34
// ACHADO (mutação): wireReviewDetail é a ÚNICA emenda entre os controles da
// revisão aberta e as ações. Trocar `Number(b.dataset.prreply)` por `0` mandava
// toda resposta para o comentário 0 — a resposta aparecia embaixo do trecho
// errado — e as 706 asserções continuavam verdes.
test("R34 — cada controle da revisão aberta age sobre a linha que o carregou", () => {
  const wire = fnBody("wireReviewDetail");
  assert.match(wire, /promptReply\(pr, [^)]*b\.dataset\.prreply/,
    "a resposta vai para a conversa da linha, não para um id fixo");
  assert.match(wire, /sendReviewDecision\(b, pr, b\.dataset\.praction\)/,
    "a decisão é a do botão clicado");
  const det = fnBody("renderReviewDetail");
  assert.match(det, /openProposalUrl\(\(bad\[Number\(b\.dataset\.prcheck\)\] \|\| \{\}\)\.url\)/,
    "a verificação aberta é a da linha");
  // e nenhum handler da emenda ignora o seu elemento
  for (const gancho of ["prreply", "praction"]) {
    const i = wire.indexOf(gancho);
    assert.ok(i > 0, `${gancho} continua ligado`);
    assert.ok(/dataset/.test(wire.slice(i, i + 120)), `${gancho} é lido do elemento`);
  }
});

// ------------------------------------------------------------------- R35
// ACHADO (leitor de tela): «tentar de novo» repintava o MESMO erro sem toast e
// sem nada na região viva — o único controle da tela não produzia pixel novo,
// nem anúncio, nem pendente. O mesmo silêncio cobria «%1 de %2 vistos».
test("R35 — o estado desta metade é anunciado, não só desenhado", () => {
  const body = fnBody("renderMyChanges");
  const show = body.slice(body.indexOf("const showEmpty"), body.indexOf("if (REV.changesErr"));
  // MIGRADO (rodada 4): continua sendo a região viva do app — por announceRev, que
  // só fala pela metade que está na tela (R38). announceRev chama announce().
  assert.match(show, /announceRev\("now"/, "WCAG 4.1.3: um texto que troca sozinho precisa de região viva");
  assert.match(fnBody("announceRev"), /announce\(msg\)/);
  const team = fnBody("renderTeamReviews");
  assert.match(team, /announceRev\("team"/);
  // e o app continua com UMA região viva (a11y.test.js F6): ninguém inventa outra
  assert.ok(!/aria-live/.test(fnBody("renderMyChanges") + team),
    "a região viva é #srLive, e quem fala nela é announce()");
});

// ------------------------------------------------------------------- R33
// ACHADO MEDIDO: `class="hint mono"` e `class="pmnote mono"` computavam para
// -apple-system com o espaçamento do mono — as duas classes têm a mesma
// especificidade e a segunda vem depois com o atalho `font:`, que reinicia a
// família. Sobrava a metade errada da regra: o caminho do modelo do time e os dois
// contadores em --sans, e a prosa com o espaçamento da máquina (DESIGN.md §3 — um
// caminho, um horário e um contador ficam em mono). A prosa é da frase; a metade da
// máquina é de um <span> próprio, que nenhuma regra posterior cancela.
test("R33 — o caminho e os contadores ficam na fonte da máquina", () => {
  assert.match(fnBody("renderMyChanges"),
    /<p class="hint"><span class="mono">\$\{esc\(t\("%1 de %2 vistos"/,
    "o contador de vistos é a metade da máquina da linha");
  assert.match(APP, /<span class="mono" id="newDraftEcho">/,
    "o contador «%1/24» também — e é o <span> que o pintor escreve");
  assert.match(fnBody("promptNewDraft"), /echo\.textContent/, "quem pinta é o dono do texto");
  assert.match(APP, /t\("modelo do time · %1", \[`<span class="mono">\$\{esc\(rel\)\}<\/span>`\]\)/,
    "o caminho do modelo do time é mono, e a frase em volta continua prosa");
  // e nenhum elemento pede as duas famílias de uma vez (o que a folha cancela)
  for (const combo of ['class="hint mono"', 'class="pmnote mono"', 'class="mono pmnote"']) {
    assert.ok(!APP.includes(combo), `${combo}: a família pedida não é a pintada`);
  }
});

/* ============================================================ crítica, rodada 3
   Os achados desta rodada saíram do app RODANDO, com o teclado e com um leitor de
   tela. Todos são da mesma família: a tela sabia de um estado e dizia OUTRO —
   «tudo salvo» com uma aba suja em cima, «✓ visto» num diff que ninguém abriu,
   um botão armado para uma metade que não está conectada, e a região viva
   descrevendo a metade escondida. */

// Um nó de tela, o mínimo que os pintores tocam. Não é um DOM: é o contrato que
// eles usam — texto, visibilidade, atributos e o clique.
function noh(extra) {
  return Object.assign({
    textContent: "", innerHTML: "", hidden: false, disabled: false, title: "",
    tagName: "DIV", attrs: {}, onclick: null,
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    contains() { return false; },
    focus() { this.focused = true; },
  }, extra || {});
}

// O pintor da lista EXERCIDO, com as dependências que ele tem na tela. As duas
// funções que ele chama e que também estão sob teste (paintUnsavedDocs,
// announceRev) entram de verdade; o resto é o mínimo para o ramo rodar.
function pintorDaLista(cena) {
  const nodes = {};
  const $ = (id) => (nodes[id] = nodes[id] || noh());
  const falas = [];
  const abertos = [];
  const portas = [];
  const deps = {
    $,
    t: (m, a) => String(m).replace(/%([1-9])/g, (_, i) => (a && a[i - 1] !== undefined ? a[i - 1] : "%" + i)),
    esc: (s) => String(s === null || s === undefined ? "" : s),
    tErr: (c) => `ERR(${c})`,
    RV,
    // o mesmo diagnóstico que paintTeamGate lê, na MESMA passada de pintura: é
    // isso que faz o estado vazio saber se o passo que ele nomeia existe
    envDoctor: cena.env || { versioningEnabled: true },
    openCfgGit: () => portas.push("cfg:git"),
    REV: Object.assign({
      changes: null, changesErr: "", viewed: new Set(), mode: "unified",
      openDiff: new Set(), openCard: new Set(), rowsMore: new Map(),
      branch: "rfc/onboarding-atualizado-co", def: "main", sig: "", openNum: 0,
    }, cena.REV || {}),
    announce: (m) => falas.push(m),
    reviewOn: () => cena.reviewOn !== false,
    reviewTab: () => cena.tab || "now",
    dirtyDocs: () => cena.unsaved || [],
    activateTab: (id) => abertos.push(id),
    plural: (n, one, many) => String(Math.abs(n) === 1 ? one : many).replace("%1", n),
    changeCardHtml: (f) => `<card ${f.path}>`,
    wireCardToggle() {}, wireDiffMore() {}, paintEditBanner() {},
    repaintFocused() {}, withPending() {}, refreshMyChanges() {},
    focusMarkIn: () => cena.mark || "",
    restoreFocusMark: (root, mark) => abertos.push(`focus:${mark}`),
  };
  // eslint-disable-next-line no-new-func
  const build = new Function("deps", `
    const { $, t, esc, tErr, RV, REV, announce, reviewOn, reviewTab, dirtyDocs, activateTab,
      plural, changeCardHtml, wireCardToggle, wireDiffMore, paintEditBanner, repaintFocused,
      withPending, refreshMyChanges, focusMarkIn, restoreFocusMark, envDoctor, openCfgGit } = deps;
    ${fnSource("draftSlugFromBranch")}
    ${fnSource("teamBlockCode")}
    ${fnSource("announceRev")}
    ${fnSource("paintUnsavedDocs")}
    ${fnSource("paintLoading")}
    ${fnSource("renderMyChanges")}
    return renderMyChanges;`);
  return { render: build(deps), nodes, falas, abertos, portas, REV: deps.REV };
}

// ------------------------------------------------------------------- R36
// ACHADO NO APP RODANDO (rodada 3): com o documento aberto tendo mudança não
// salva — a aba pintando «mobile ●» e o pé do editor dizendo «mudanças não
// salvas» —, o destino Revisão respondia «tudo salvo» à pergunta que ele existe
// para responder, desabilitava a ação primária e orientava o passo ERRADO
// («envie para revisão»: não há nada para enviar). O app já sabia somar as duas
// verdades: a linha do tempo do painel usa `tab.dirty || gitFiles[rel]`.
test("R36 — «tudo salvo» não é dito com um documento aberto por salvar", () => {
  const suja = [{ id: "t1", title: "context.md", rel: "contexts/mobile/context.md" }];
  const c = pintorDaLista({ unsaved: suja, REV: { changes: [] } });
  c.render();
  assert.notEqual(c.nodes.revEmptyTitle.textContent, "tudo salvo",
    "a árvore de trabalho está limpa, mas o EDITOR não — a tela não pode afirmar o projeto inteiro");
  assert.match(c.nodes.revEmptyMsg.textContent, /context\.md/,
    "o estado vazio nomeia o documento que está por salvar");
  assert.ok(!/Envie para revisão/.test(c.nodes.revEmptyMsg.textContent),
    "não há nada para enviar: o passo seguinte é salvar o documento");
  assert.equal(c.nodes.revEmptyGo.hidden, false, "e o passo seguinte é uma porta, não uma frase");
  c.nodes.revEmptyGo.onclick();
  assert.deepStrictEqual(c.abertos, ["t1"], "a porta leva para a aba do documento não salvo");
  assert.match(c.nodes.revEmptyGo.getAttribute("aria-label") || "", /context\.md/,
    "e o nome acessível diz QUAL documento (WCAG 2.4.6)");
  assert.ok(c.falas.some((f) => /context\.md/.test(f)), "quem não vê a tela ouve o mesmo estado");

  // sem aba suja, a frase de «tudo salvo» continua sendo a verdade
  const limpa = pintorDaLista({ unsaved: [], REV: { changes: [] } });
  limpa.render();
  assert.equal(limpa.nodes.revEmptyTitle.textContent, "tudo salvo");
  assert.match(limpa.nodes.revEmptyMsg.textContent, /Envie para revisão/);
  assert.equal(limpa.nodes.revEmptyGo.getAttribute("aria-label"), null,
    "e o nome do documento de antes não fica atrás de um botão escondido (DESIGN.md §9)");

  // e com mudança na lista a frase vai para o lado da AÇÃO que ela qualifica: a
  // versão guarda o arquivo, não o texto que está só no editor
  const mista = pintorDaLista({
    unsaved: suja,
    REV: { changes: [{ path: "contexts/frota/context.md", kind: "modified", hunks: [] }] },
  });
  mista.render();
  assert.equal(mista.nodes.revUnsavedNote.hidden, false);
  assert.match(mista.nodes.revUnsavedNote.textContent, /context\.md/);
  assert.equal(mista.nodes.revUnsavedGo.hidden, false);
  mista.nodes.revUnsavedGo.onclick();
  assert.ok(mista.abertos.includes("t1"), "a mesma porta, do lado do botão de salvar");
  assert.equal(limpa.nodes.revUnsavedNote.hidden, true, "sem aba suja a frase não existe");

  // e a assinatura do repintar CONHECE esse estado: sem isso a frase só
  // aparecia quando a árvore de trabalho mudasse por outro motivo
  const troca = pintorDaLista({ unsaved: [], REV: { changes: [] } });
  troca.render();
  const antes = troca.nodes.revEmptyTitle.textContent;
  troca.render.call(null);
  troca.REV.changes = [];
  // a mesma lista, agora com uma aba suja
  const cena = pintorDaLista({ unsaved: suja, REV: { changes: [], sig: troca.REV.sig } });
  cena.render();
  assert.notEqual(cena.nodes.revEmptyTitle.textContent, antes,
    "a assinatura tem de carregar as abas sujas, ou o repintar não acontece");
});

// ------------------------------------------------------------------- R36b
// A mesma verdade no OUTRO controle que a afirma: o botão de versão do painel
// ✦ IA dizia «tudo salvo ✓» a 200px do pé do editor dizendo «mudanças não
// salvas» (medido na mesma tela, rodada 3).
test("R36b — o botão de versão do painel não diz «tudo salvo» com o editor sujo", () => {
  // eslint-disable-next-line no-new-func
  const estado = new Function("deps", `
    const { t } = deps;
    ${fnSource("versionBtnState")}
    return versionBtnState;`)({
    t: (m, a) => String(m).replace(/%([1-9])/g, (_, i) => (a && a[i - 1] !== undefined ? a[i - 1] : "%" + i)),
  });
  const suja = [{ id: "t1", title: "context.md", rel: "contexts/mobile/context.md" }];
  const limpo = estado({ available: true, repo: true, pending: 0 }, []);
  assert.equal(limpo.label, "tudo salvo ✓");
  assert.equal(limpo.disabled, true, "sem nada pendente ele continua sendo o estado, não uma ação");
  const sujo = estado({ available: true, repo: true, pending: 0 }, suja);
  assert.notEqual(sujo.label, "tudo salvo ✓", "há texto que não está no arquivo: nada está «tudo salvo»");
  assert.equal(sujo.disabled, true, "e salvar versão não guardaria esse texto: o controle não se arma");
  assert.match(sujo.title, /salve o documento/, "o motivo e o passo seguinte ficam no controle");
  // com mudança pendente de verdade o rótulo continua o da ação, com a contagem
  const pend = estado({ available: true, repo: true, pending: 3 }, suja);
  assert.match(pend.label, /^Salvar versão do projeto \(3\)/);
  assert.equal(pend.disabled, false);
  // e sem repositório o rótulo é o de começar a guardar versões
  assert.match(estado({ available: true, repo: false, pending: 0 }, []).label, /começar a guardar versões/);
});

// ------------------------------------------------------------------- R37
// ACHADO NO APP RODANDO (rodada 3, reproduzido duas vezes): «✓ visto» e o
// contador sobreviviam a uma versão salva — um cartão de conteúdo NOVO nascia
// `aria-pressed="true"`. A marca é do CONTEÚDO lido (review.js::changeId); aqui
// se fixa que a superfície usa essa identidade, e que as duas listas que falam os
// mesmos caminhos (a árvore de trabalho e uma revisão aberta) têm escopos
// diferentes.
test("R37 — a marca de «visto» do cartão é da mudança, não do caminho", () => {
  const cartao = new Function("deps", `
    const { t, esc, RV, REV, plural } = deps;
    ${fnSource("changeBadge")}
    const plainBitsHtml = () => "";
    const diffRowsHtml = () => "";
    ${fnSource("changeCardHtml")}
    return changeCardHtml;`);
  const file = {
    path: "contexts/mobile/context.md", kind: "modified", additions: 1, deletions: 1, binary: false,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, rows: [
      { kind: "del", oldLine: 1, newLine: null, text: "48 horas" },
      { kind: "add", oldLine: null, newLine: 1, text: "7 dias" },
    ] }],
  };
  const mk = (viewed) => cartao({
    t: (m, a) => String(m).replace(/%([1-9])/g, (_, i) => (a && a[i - 1] !== undefined ? a[i - 1] : "%" + i)),
    esc: (s) => String(s === null || s === undefined ? "" : s),
    RV,
    REV: { viewed, mode: "unified", openDiff: new Set(), openCard: new Set(), rowsMore: new Map() },
    plural: (n, one, many) => String(Math.abs(n) === 1 ? one : many).replace("%1", n),
  });
  // marcado pelo CAMINHO (o defeito) não marca nada
  assert.match(mk(new Set([file.path]))(file, "now"), /data-rvseen[^>]*aria-pressed="false"/);
  // marcado pela MUDANÇA, marca
  assert.match(mk(new Set([RV.changeId(file, "now")]))(file, "now"),
    /data-rvseen[^>]*aria-pressed="true"/);
  // e a marca da árvore de trabalho não vale na revisão aberta
  assert.match(mk(new Set([RV.changeId(file, "now")]))(file, "pr:42"),
    /data-rvseen[^>]*aria-pressed="false"/);
  // os dois pintores passam escopo, e não o mesmo
  const agora = fnBody("renderMyChanges"), aberta = fnBody("renderReviewDetail");
  assert.match(agora, /changeCardHtml\(f, "now"\)/);
  assert.match(aberta, /changeCardHtml\(f, `pr:\$\{number\}`\)/);
  for (const body of [agora, aberta]) {
    assert.match(body, /RV\.changeId\(/, "o alternador guarda a identidade da mudança, não o caminho");
    assert.match(body, /RV\.viewedCount\([^)]*,\s*REV\.viewed,\s*[^)]+\)/,
      "e o contador conta com a mesma chave (senão ele conta outra coisa)");
  }
});

// ------------------------------------------------------------------- R37b
// ACHADO (leitor de tela, rodada 3): «marcar como visto» e «ver a mudança completa»
// se repetem UMA VEZ POR DOCUMENTO mudado, com rótulo idêntico em todos, e o mesmo
// vale para o grupo «unificado/lado a lado». Numa mudança de dez arquivos, na lista
// que existe para você não perder um documento, um leitor de tela ouvia dez vezes o
// mesmo nome sem nada que o ligasse a um documento (WCAG 2.4.6). O app já aplica a
// regra em «responder — <endereço>» e «ver a verificação ↗ — <nome>».
test("R37b — uma ação repetida por documento diz A QUAL documento pertence", () => {
  const cartao = new Function("deps", `
    const { t, esc, RV, REV, plural } = deps;
    ${fnSource("changeBadge")}
    const plainBitsHtml = () => "";
    const diffRowsHtml = () => "";
    ${fnSource("changeCardHtml")}
    return changeCardHtml;`)({
    t: (m, a) => String(m).replace(/%([1-9])/g, (_, i) => (a && a[i - 1] !== undefined ? a[i - 1] : "%" + i)),
    esc: (s) => String(s === null || s === undefined ? "" : s),
    RV,
    REV: { viewed: new Set(), mode: "unified", openDiff: new Set(["contexts/mobile/context.md"]), openCard: new Set(), rowsMore: new Map() },
    plural: (n, one, many) => String(Math.abs(n) === 1 ? one : many).replace("%1", n),
  });
  const html = cartao({
    path: "contexts/mobile/context.md", kind: "modified", additions: 1, deletions: 1, binary: false,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, rows: [
      { kind: "add", oldLine: null, newLine: 1, text: "o reenvio vale uma vez" }] }],
  }, "now");
  const labels = [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(labels.length >= 3, `os três controles do cartão têm nome próprio (achei ${labels.length})`);
  for (const l of labels) {
    // o CAMINHO, não o nome do arquivo: todo conhecimento se chama `context.md`
    assert.match(l, /contexts\/mobile\/context\.md$/,
      `nome acessível sem o documento: «${l}» (WCAG 2.4.6)`);
  }
  // e o rótulo VISÍVEL é o começo do nome acessível (WCAG 2.5.3)
  for (const visivel of ["marcar como visto", "esconder a mudança completa", "como mostrar a mudança"]) {
    assert.ok(labels.some((l) => l.startsWith(visivel)),
      `«${visivel}» tem de ser o começo do nome acessível, não outra frase`);
  }
  // dois cartões diferentes nunca têm o mesmo nome acessível
  const outro = cartao({ path: "contexts/frota/context.md", kind: "modified", additions: 1, deletions: 0, binary: false,
    hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, rows: [{ kind: "add", oldLine: null, newLine: 1, text: "x" }] }] }, "now");
  const outros = [...outro.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(labels.filter((l) => outros.includes(l)), [],
    "dois documentos com o mesmo nome acessível é o defeito de novo, com dois cartões");
});

// ------------------------------------------------------------------- R38
// ACHADO (leitor de tela, rodada 3): chegar em Revisão anunciava a metade que NÃO
// está na tela. As duas metades se pintam na mesma passada e as duas falavam na
// única região viva do app, então a última a terminar ganhava: um usuário de
// leitor ouvia «nada aqui ainda — o time ainda não está conectado» sobre a
// metade escondida, e nada sobre a que estava na frente (WCAG 4.1.2/4.1.3).
test("R38 — a região viva fala pela metade que está na tela", () => {
  const comCartoes = { changes: [{ path: "contexts/frota/context.md", kind: "modified", hunks: [] }] };
  const naTela = pintorDaLista({ tab: "now", unsaved: [], REV: comCartoes });
  naTela.render();
  assert.ok(naTela.falas.length, "a metade na tela é anunciada quando o destino é aberto");

  const escondida = pintorDaLista({ tab: "team", unsaved: [], REV: { changes: [] } });
  escondida.render();
  assert.deepStrictEqual(escondida.falas, [],
    "com a aba do TIME na tela, a metade «de agora» não fala na região viva");

  // e fora do destino nenhuma das duas fala
  const fora = pintorDaLista({ reviewOn: false, tab: "now", unsaved: [], REV: { changes: [] } });
  fora.render();
  assert.deepStrictEqual(fora.falas, []);
});

// O pintor da metade do TIME exercido, com o ambiente como parâmetro: é ele que
// decide o estado vazio, a porta de saída e o que a região viva ouve.
function pintorDoTime(cena) {
  const nodes = {};
  const $ = (id) => (nodes[id] = nodes[id] || noh());
  const falas = [];
  const portas = [];
  const deps = {
    $,
    t: (m, a) => String(m).replace(/%([1-9])/g, (_, i) => (a && a[i - 1] !== undefined ? a[i - 1] : "%" + i)),
    esc: (s) => String(s === null || s === undefined ? "" : s),
    tErr: (c) => `ERR(${c})`,
    RV,
    REV: Object.assign({ prs: [], prsErr: "", prsStale: false, def: "main", teamSig: "", openNum: 0 }, cena.REV || {}),
    envDoctor: cena.env === undefined ? { versioningEnabled: true, account: "eu" } : cena.env,
    announce: (m) => falas.push(m),
    reviewOn: () => cena.reviewOn !== false,
    reviewTab: () => cena.tab || "team",
    teamRowHtml: (p) => `<row ${p.number}>`,
    openReview() {}, copyProposalUrl() {}, refreshTeamReviews() {},
    withPending: (btn, run) => run(),
    openCfgGit: () => portas.push("cfg:git"),
    openCfg: () => portas.push("cfg:top"),
  };
  // eslint-disable-next-line no-new-func
  const build = new Function("deps", `
    const { $, t, esc, tErr, RV, REV, envDoctor, announce, reviewOn, reviewTab, teamRowHtml,
      openReview, copyProposalUrl, refreshTeamReviews, withPending, openCfgGit, openCfg } = deps;
    ${fnSource("teamBlockCode")}
    ${fnSource("announceRev")}
    ${fnSource("paintLoading")}
    ${fnSource("paintReviewAge")}
    ${fnSource("renderTeamReviews")}
    return renderTeamReviews;`);
  return { render: build(deps), nodes, falas, portas };
}

// ------------------------------------------------------------------- R39
// ACHADO NO APP RODANDO (rodada 3): a tela diz «conecte o GitHub em
// Configurações» e a porta abre Configurações em «Projeto» — a seção «Versões e
// GitHub» é a última de sete, e é ela que nomeia cada bloqueio com o seu remédio.
// O app já sabia fazer certo em UM lugar (o link da seção TIME do painel).
test("R39 — a porta «abrir Configurações» abre a seção que ela nomeou", () => {
  const c = pintorDoTime({ env: { versioningEnabled: false, gh: { ok: false } } });
  c.render();
  assert.equal(c.nodes.revTeamEmptyGo.hidden, false, "não conectado: o remédio é um botão");
  c.nodes.revTeamEmptyGo.onclick();
  assert.deepStrictEqual(c.portas, ["cfg:git"],
    "a porta cai na seção «Versões e GitHub», não no topo de Configurações");

  // o mesmo para a leitura que falhou por prosa crua do gh
  const erro = pintorDoTime({ env: { versioningEnabled: true }, REV: { prsErr: "boom, raw gh english" } });
  erro.render();
  erro.nodes.revTeamEmptyGo.onclick();
  assert.deepStrictEqual(erro.portas, ["cfg:git"]);

  // e as ROTAS NOMEADAS do fluxo de revisão — as três que citam Configurações —
  // passam pela mesma porta: uma contagem com folga não reprova (N5).
  const rotas = {
    "a recusa prévia de F5 (o botão de envio)": 'if ($("revProposeBtn"))',
    "o remédio dentro da folha que falhou": "if (PM.errGo) PM.errGo.addEventListener",
    "o link da seção TIME do painel": 'const f = $("pTeamFix");',
  };
  for (const [quem, ancora] of Object.entries(rotas)) {
    const i = APP.indexOf(ancora);
    assert.ok(i > 0, `${quem}: a rota continua existindo (${ancora})`);
    assert.match(APP.slice(i, i + 480), /openCfgGit/,
      `${quem}: a porta nomeia a seção e tem de abrir a seção`);
  }
  assert.match(fnBody("openCfgGit"), /showCfgSection\("git"\)/);
});

// ------------------------------------------------------------------- R40
// ACHADO NO APP RODANDO (rodada 3): o MESMO rascunho tinha dois nomes a um clique
// de distância — «⎇ rfc/onboarding-atualizado-co» no painel ✦ IA (o ref cru, com
// um prefixo que ninguém explicou) e «⎇ no rascunho onboarding-atualizado-co» na
// Revisão. Um objeto, um nome (DESIGN.md §4/§5).
test("R40 — o rascunho tem UM nome nas duas telas que o mostram", () => {
  const chip = new Function("deps", `
    const { t } = deps;
    ${fnSource("draftSlugFromBranch")}
    ${fnSource("draftNameFromBranch")}
    ${fnSource("draftChipLabel")}
    return draftChipLabel;`)({
    t: (m, a) => String(m).replace(/%([1-9])/g, (_, i) => (a && a[i - 1] !== undefined ? a[i - 1] : "%" + i)),
  });
  assert.equal(chip("rfc/onboarding-atualizado-co", "main"), "⎇ no rascunho onboarding-atualizado-co");
  assert.equal(chip("main", "main"), "⎇ no conhecimento oficial");
  assert.ok(!/rfc\//.test(chip("rfc/frota", "main")), "o prefixo do git não chega à tela");
  // e as duas superfícies são pintadas por ele
  assert.match(fnBody("paintReviewDraft"), /draftChipLabel\(/);
  const painel = APP.slice(APP.indexOf("if (B.branchBtn) {"), APP.indexOf("if (B.branchBtn) {") + 500);
  // desde R60 o chip tem duas saídas do MESMO fato: o HTML visível (prosa em
  // --sans + o endereço em mono) e o texto puro, que é o nome acessível
  assert.match(painel, /draftChipHtml\(/, "o chip do painel usa o mesmo desenho que a Revisão");
  assert.match(painel, /aria-label", draftChipLabel\(/,
    "e o nome acessível é o texto puro do mesmo fato, não o HTML");
  assert.ok(!/"⎇ " \+ g\.branch/.test(APP), "o ref cru era impresso direto no botão");
});

// ------------------------------------------------------------------- R41
// ACHADO (teclado, rodada 3): uma folha que SUBSTITUI outra («＋ novo rascunho…»
// dentro da folha dos rascunhos, «configurar o modelo» dentro da do envio) trocava
// o título e o corpo e deixava o foco no <body> — o elemento que tinha o foco
// deixa de existir com o innerHTML, e enterOverlay não faz nada quando a camada já
// está na pilha. Nada era anunciado tampouco: o diálogo mudava de nome e a região
// viva continuava na mensagem anterior (WCAG 2.4.3/4.1.2).
test("R41 — uma folha que substitui outra leva o teclado e o anúncio com ela", () => {
  const cena = (jaAberta) => {
    const campo = noh({ tagName: "INPUT" });
    const body = noh({ querySelector: () => campo });
    const wrap = noh({ hidden: !jaAberta });
    const falas = [];
    const nodes = {
      wrap, body, title: noh(), confirm: noh(), cancel: noh(), close: noh(),
      err: noh(), errMsg: noh(), errGo: noh(),
    };
    // eslint-disable-next-line no-new-func
    const open = new Function("deps", `
      const { PM, t, announce, enterOverlay, closeModal, pmError } = deps;
      let pmOnConfirm = null, pmOnDismiss = null, pmGen = 0;
      ${fnSource("openModal")}
      return openModal;`)({
      PM: { wrap, title: nodes.title, body, confirm: nodes.confirm, cancel: nodes.cancel,
        close: nodes.close, err: nodes.err, errMsg: nodes.errMsg, errGo: nodes.errGo },
      t: (m) => m,
      announce: (m) => falas.push(m),
      enterOverlay: (w, first) => { if (!jaAberta) { const n = typeof first === "function" ? first() : first; if (n) n.focus(); } },
      closeModal() {}, pmError() {},
    });
    open("Novo rascunho", "<input>", "criar e trocar para ele", () => {});
    return { campo, falas, title: nodes.title };
  };
  const nova = cena(false);
  assert.ok(nova.campo.focused, "uma folha nova já levava o foco para o primeiro campo");
  const trocada = cena(true);
  assert.ok(trocada.campo.focused,
    "a folha que substitui outra também: sem isso o teclado fica no <body> (WCAG 2.4.3)");
  assert.ok(trocada.falas.some((f) => /Novo rascunho/.test(f)),
    "e o diálogo novo se anuncia pelo nome (WCAG 4.1.2)");
  assert.deepStrictEqual(nova.falas, [],
    "uma folha que ABRE já é anunciada pela entrada da camada: dois anúncios seriam dois eventos para um");
});

// ------------------------------------------------------------------- R42
// ACHADO (leitor de tela, rodada 3): a revisão aberta não tinha cabeçalho. O h1
// continuava «Revisão» e as seções dela eram h2 — a identidade da revisão (#42 e o
// assunto) era um <span>, então a estrutura de uma revisão aberta era idêntica à de
// qualquer outra e a navegação por cabeçalhos lia três seções de um item que nada
// nomeava (WCAG 1.3.1/2.4.6).
test("R42 — a revisão aberta é um cabeçalho, e as seções dela descem um nível", () => {
  const det = fnBody("renderReviewDetail");
  assert.match(det, /<h2 class="rvtitle">#\$\{esc\(String\(pr\.number\)\)\}/,
    "a revisão aberta tem cabeçalho próprio, com o número e o assunto");
  for (const [fn, titulo] of [["renderReviewDetail", "O que muda"], ["decisionHtml", "Sua revisão"],
    ["renderReviewDetail", "Conversa"], ["checksHtml", "Verificações que falharam"]]) {
    const body = fnBody(fn);
    // .rvhead e não .phead desde R60: estes títulos são PROSA, e .phead é a
    // máquina nomeando um cesto. A claim aqui é o NÍVEL, e ela não mudou.
    assert.match(body, new RegExp(`<h3 class="rvhead">\\$\\{t\\("${titulo}"\\)\\}`),
      `«${titulo}» é seção DA revisão aberta: ela desce para h3`);
    assert.ok(!new RegExp(`<h2 class="(phead|rvhead)">\\$\\{t\\("${titulo}"\\)`).test(body),
      `«${titulo}» não pode ficar no mesmo nível da revisão que a contém`);
  }
  // e o h1 do destino continua sendo um só
  assert.equal((HTML.slice(HTML.indexOf('id="destReview"'), HTML.indexOf('id="bDocWrap"')).match(/<h1/g) || []).length, 1);
});

// ------------------------------------------------------------------- R43
// ACHADO (teclado, rodada 3): quando o poll de 10s repinta a lista, o teclado
// perde o lugar. `list.innerHTML = …` destrói o nó focado, o foco cai no <body> e
// o Tab recomeça no primeiro cartão — por uma mudança que o usuário não fez (uma
// análise escrevendo um documento, um git em curso). WCAG 2.4.3.
test("R43 — o repintar do poll não tira o teclado do lugar", () => {
  const marca = new Function("deps", `
    const { document } = deps;
    ${APP.match(/const FOCUS_MARKS = \[[^\]]*\];/)[0]}
    ${fnSource("focusMarkIn")}
    ${fnSource("restoreFocusMark")}
    return { focusMarkIn, restoreFocusMark };`);
  const botao = noh({ attrs: { "data-rvseen": "contexts/mobile/context.md" } });
  const lista = noh({ contains: (n) => n === botao, querySelector: () => botao });
  const api = marca({ document: { activeElement: botao, body: {} } });
  const m = api.focusMarkIn(lista);
  assert.equal(m, '[data-rvseen="contexts/mobile/context.md"]',
    "a marca é o ENDEREÇO do controle, não o nó (que o repintar destrói)");

  // depois do repintar o foco caiu no <body>: a marca o traz de volta
  const corpo = {};
  const api2 = marca({ document: { activeElement: corpo, body: corpo } });
  api2.restoreFocusMark(lista, m);
  assert.ok(botao.focused, "o teclado volta para a linha em que estava");

  // e o repintar NÃO rouba o foco de quem já o tem em outro lugar. O alvo é UM nó
  // (uma fábrica que devolve um nó novo por chamada faria esta asserção não poder
  // reprovar — foi o que a mutação «rouba o foco de qualquer jeito» mostrou).
  const outro = noh();
  const alvo = noh();
  const api3 = marca({ document: { activeElement: outro, body: {} } });
  const lista2 = noh({ contains: (n) => n === outro, querySelector: () => alvo });
  api3.restoreFocusMark(lista2, m);
  assert.ok(!alvo.focused, "um foco que já tem dono não é movido");

  // um <summary> de cartão é endereçado pelo cartão dele
  const sum = noh({ tagName: "SUMMARY", closest: () => noh({ attrs: { "data-rvcard": "a/b.md" } }) });
  const l3 = noh({ contains: (n) => n === sum });
  assert.equal(marca({ document: { activeElement: sum, body: {} } }).focusMarkIn(l3),
    '[data-rvcard="a/b.md"] > summary');

  // e o pintor guarda e devolve a marca em volta da troca de innerHTML
  const body = fnBody("renderMyChanges");
  const guarda = body.indexOf("focusMarkIn(");
  const troca = body.indexOf("list.innerHTML =");
  const devolve = body.indexOf("restoreFocusMark(");
  assert.ok(guarda > 0 && troca > guarda, "a marca é lida ANTES de a lista ser destruída");
  assert.ok(devolve > troca, "e devolvida depois de a lista existir de novo");
});

// ------------------------------------------------------------------- R44
// ACHADO NO APP RODANDO (rodada 3): «↗ Enviar para revisão do time» ficava armado
// e calado numa tela que JÁ SABIA que a metade do time não está conectada — o app
// avaliava o mesmo teamBlockCode() no clique, e a aba vizinha já dizia a frase. O
// clique respondia com um toast que cita `gh auth login` a quem foi prometido que
// não precisa saber git.
test("R44 — o envio para revisão diz ANTES do clique o que o app já sabe", () => {
  const gate = (env) => {
    const nodes = {};
    const $ = (id) => (nodes[id] = nodes[id] || noh());
    const portas = [];
    // eslint-disable-next-line no-new-func
    const paint = new Function("deps", `
      const { $, t, tErr, envDoctor, openCfgGit, RV, REV, goDest, openReview } = deps;
      ${fnSource("teamBlockCode")}
      ${fnSource("reviewMe")}
      ${fnSource("draftSlugFromBranch")}
      ${fnSource("emptyStateOffersCfg")}
      ${fnSource("paintOpenReviewState")}
      ${fnSource("paintTeamGate")}
      return paintTeamGate;`)({
      $, t: (m, a) => String(m).replace(/%([1-9])/g, (_, i) => (a && a[i - 1] !== undefined ? a[i - 1] : "%" + i)),
      tErr: (c) => `ERR(${c})`, envDoctor: env,
      openCfgGit: () => portas.push("cfg:git"),
      RV, REV: (env && env.REV) || { prs: null, branch: "" },
      goDest: () => portas.push("dest:review"), openReview: () => {},
    });
    paint();
    return { nodes, portas };
  };
  const conectado = gate({ versioningEnabled: true });
  assert.equal(conectado.nodes.revTeamNote.hidden, true, "conectado, a tela não fala do que não bloqueia");
  assert.equal(conectado.nodes.revProposeBtn.disabled, false);

  const semGh = gate({ versioningEnabled: false, gh: { ok: false } });
  assert.equal(semGh.nodes.revTeamNote.hidden, false, "a tela diz o estado ANTES do clique");
  assert.match(semGh.nodes.revTeamNote.textContent, /o time ainda não está conectado/);
  assert.ok(!/gh auth login/.test(semGh.nodes.revTeamNote.textContent),
    "um comando de terminal não é o remédio de quem foi prometido que não precisa de git");
  assert.equal(semGh.nodes.revProposeBtn.disabled, true, "e o controle não fica armado para recusar");
  assert.ok(!/gh auth login/.test(semGh.nodes.revProposeBtn.title || ""),
    "um tooltip não dispara num controle desabilitado: o motivo é a frase, não cromo morto");
  assert.equal(semGh.nodes.revTeamGo.hidden, false);
  semGh.nodes.revTeamGo.onclick();
  assert.deepStrictEqual(semGh.portas, ["cfg:git"], "o remédio é a seção que a frase nomeou");

  const semRede = gate({ versioningEnabled: false, offline: true });
  assert.match(semRede.nodes.revTeamNote.textContent, /sem conexão agora/);
  assert.equal(semRede.nodes.revTeamGo.hidden, true, "sem rede o remédio não é Configurações");
  // a frase é a DESCRIÇÃO do botão: quem chega nele pelo teclado ouve o motivo
  const bloco = HTML.slice(HTML.indexOf('id="revSave"'), HTML.indexOf('id="revTeam"'));
  assert.match(bloco, /id="revProposeBtn"[^>]*aria-describedby="[^"]*revTeamNote/);
  assert.ok(bloco.indexOf('id="revTeamNote"') < bloco.indexOf('id="revProposeBtn"'),
    "e está dita acima do botão, antes do clique");
});

// ------------------------------------------------------------------- R45
// ACHADO NO APP RODANDO (rodada 5): criar «toast tres» respondia «⎇ rfc/toast-tres»
// — o ref cru do git — dois centímetros acima do chip que chama o MESMO lugar de
// «⎇ no rascunho toast-tres», e um clique depois da folha que o chama de «rascunho
// «toast-tres»». Numa primeira troca com preço a mesma linha escrevia «⎇ main»,
// a única palavra que DESIGN.md §4 substitui por «conhecimento oficial». O retorno
// da troca era a última superfície do fato que não passava por placeName.
function trocaDeRascunho(def) {
  const avisos = [];
  const releu = [];
  // eslint-disable-next-line no-new-func
  const api = new Function("deps", `
    let sideSig = "";
    const { t, toast, setupWorkspace, brainRefresh, refreshMyChanges, REV } = deps;
    ${fnSource("draftSlugFromBranch")}
    ${fnSource("draftNameFromBranch")}
    ${fnSource("placeName")}
    ${fnSource("switchPrice")}
    ${fnSource("afterSwitch")}
    return { afterSwitch, switchPrice };`)({
    t: (m, a) => String(m).replace(/%([1-9])/g, (_, i) => (a && a[i - 1] !== undefined ? a[i - 1] : "%" + i)),
    toast: (msg, ms) => avisos.push({ msg, ms }),
    setupWorkspace() {}, brainRefresh() {},
    refreshMyChanges: () => releu.push("now"),
    REV: { def: def || "main" },
  });
  return Object.assign(api, { avisos, releu });
}

test("R45 — o retorno de uma troca de rascunho não nomeia o ref do git", () => {
  const criar = trocaDeRascunho("main");
  criar.afterSwitch("rfc/toast-tres", null, "main");
  assert.equal(criar.avisos.length, 1, "trocar de lugar tem exatamente um retorno");
  assert.equal(criar.avisos[0].msg, "⎇ rascunho «toast-tres»",
    "o aviso chama o lugar como o chip e a folha o chamam");
  assert.ok(!/rfc\//.test(criar.avisos[0].msg),
    "o prefixo do git não aparece na tela que existe para escondê-lo (DESIGN.md §4)");

  // a PRIMEIRA troca que custa documentos: o preço continua dito, e o destino é
  // nomeado pela tela — «main» é a palavra que §4 substitui
  const oficial = trocaDeRascunho("main");
  const price = oficial.switchPrice({ leaving: 7, docs: 0 }, "rfc/toast-tres", "main");
  assert.ok(price, "uma troca que esvazia a tela tem preço");
  oficial.afterSwitch("main", price, price.def);
  const msg = oficial.avisos[0].msg;
  assert.match(msg, /conhecimento oficial/, "o conhecimento oficial tem nome de produto");
  assert.ok(!/\bmain\b/.test(msg), `o ref padrão vazou no aviso: "${msg}"`);
  assert.match(msg, /7 documentos ficaram no rascunho anterior/,
    "e o preço pago continua dito depois do clique");
  assert.equal(oficial.avisos[0].ms, 6000, "um aviso que carrega preço fica mais tempo");

  // um rascunho que não é do Loro continua sendo dito por inteiro (é o nome que a
  // pessoa vê no git), mas ainda como «rascunho «…»»
  const outro = trocaDeRascunho("main");
  outro.afterSwitch("feature/x", null, "main");
  assert.equal(outro.avisos[0].msg, "⎇ rascunho «feature/x»");

  // e o def viaja com a chamada: quem sabe qual é o oficial é quem leu git_branches
  for (const [caller, esperado] of [["confirmSwitchBranch", /afterSwitch\([^;]*price\.def/],
    ["openBranchPicker", /afterSwitch\([^;]*info\.default/], ["openForEditing", /afterSwitch\([^;]*info\.default/]]) {
    assert.match(fnBody(caller), esperado,
      `${caller} sabe qual ramo é o oficial: passar essa resposta é o que impede o aviso de chamá-lo de rascunho`);
  }
  assert.match(fnSource("afterSwitch"), /function afterSwitch\(branch, price, def\)/);
  assert.match(fnBody("afterSwitch"), /placeName\(/,
    "um fato, uma função: o mesmo nome do chip, da folha e do preço");

  // MEDIDO NO APP RODANDO: o aviso já dizia «⎇ conhecimento oficial» enquanto o
  // chip logo acima ainda dizia «no rascunho fe5-aviso» — o mesmo fato com dois
  // valores, até a passada de 10s do poll. Onde você está é fato DESTA metade, e a
  // troca é o instante em que ele mudou.
  assert.deepStrictEqual(oficial.releu, ["now"],
    "a troca relê onde estamos: sem isso o chip e o estado vazio ficam com o lugar antigo");
  assert.deepStrictEqual(criar.releu, ["now"]);
  // e ninguém pede a mesma releitura duas vezes na mesma ação
  assert.ok(!/afterSwitch\([^;]*\);\s*\n?\s*refreshMyChanges\(\);/.test(fnBody("promptNewDraft")),
    "afterSwitch já relê: o segundo pedido era o mesmo trabalho de novo");
});

// ------------------------------------------------------------------- R46
// ACHADO NO APP RODANDO (rodada 5): uma revisão que VOLTA para mim não oferecia
// decisão nenhuma. A lista dizia «bob pediu a sua revisão», o chip dizia
// «aprovação de versão anterior» e o bloco da decisão dizia «você aprovou / a
// mudança entra no conhecimento oficial quando todas as aprovações chegarem» —
// sem um controle. A frase é falsa (o GitHub não conta uma aprovação vencida) e a
// única saída era «abrir no GitHub ↗», na tela que promete «a sua leitura acontece
// aqui, sem sair do Loro». F8 não fechava.
test("R46 — uma revisão que volta para mim oferece a decisão de novo", () => {
  const decisao = pintorDaDecisao();
  const base = {
    number: 12, state: "OPEN", mine: false, author: { login: "bob" }, title: "prazo do convite",
    headRefName: "rfc/prazo-do-convite", approvals: 0, changesRequested: 0,
    reviewRequests: [], threads: [], checks: [{ name: "ci", state: "ok" }],
    mergeStateStatus: "BLOCKED", mergeable: "MERGEABLE",
  };
  const cenas = {
    "a aprovação venceu: bob salvou outra versão": {
      ...base, reviews: [{ author: "ana", state: "APPROVED", stale: true }],
    },
    "venceu e bob pediu a revisão de novo": {
      ...base, reviews: [{ author: "ana", state: "APPROVED", stale: true }],
      reviewRequests: [{ login: "ana" }],
    },
    "pedi mudanças e bob pediu nova revisão": {
      ...base, changesRequested: 1, reviewRequests: [{ login: "ana" }],
      reviews: [{ author: "ana", state: "CHANGES_REQUESTED", stale: true }],
    },
  };
  // e o motivo é O DESTE estado: uma aprovação vencida não pode ser explicada com a
  // frase de um pedido de mudanças, nem vice-versa
  const motivo = {
    "a aprovação venceu: bob salvou outra versão": /a sua aprovação era de uma versão anterior/,
    "venceu e bob pediu a revisão de novo": /a sua aprovação era de uma versão anterior[\s\S]*bob pediu a sua revisão de novo/,
    "pedi mudanças e bob pediu nova revisão": /o seu pedido de mudanças era de uma versão anterior[\s\S]*bob pediu a sua revisão de novo/,
  };
  for (const [nome, pr] of Object.entries(cenas)) {
    const st = RV.reviewState(pr, { me: "ana" });
    const html = decisao(pr, st);
    assert.match(html, motivo[nome], `${nome}: o motivo dito é o desta volta, não o do estado vizinho`);
    assert.match(html, /data-praction="approve"/, `${nome}: a decisão volta a ser oferecida`);
    assert.match(html, /data-praction="request_changes"/, `${nome}: as três, não só aprovar`);
    assert.match(html, /data-praction="comment"/, nome);
    assert.ok(!/a mudança entra no conhecimento oficial quando todas as aprovações chegarem/.test(html),
      `${nome}: uma aprovação vencida não faz a mudança entrar — a frase seria mentira`);
    assert.ok(/versão anterior|de novo/.test(html),
      `${nome}: a tela diz POR QUE a revisão voltou, não só que há botões`);
  }
  // e uma decisão que ainda VALE continua sendo o estado, sem botão re-armado
  const atual = { ...base, reviews: [{ author: "ana", state: "APPROVED", stale: false }] };
  const stAtual = RV.reviewState(atual, { me: "ana" });
  const htmlAtual = decisao(atual, stAtual);
  assert.ok(!/data-praction/.test(htmlAtual), "sem nada novo, aprovar de novo não é uma ação");
  assert.match(htmlAtual, /você aprovou/);
  // o redutor é a autoridade: quem pode decidir é UMA resposta, não uma conta feita
  // dentro do pintor
  assert.equal(RV.reviewState(atual, { me: "ana" }).canDecide, false);
  for (const pr of Object.values(cenas)) {
    assert.equal(RV.reviewState(pr, { me: "ana" }).canDecide, true);
  }
  // e o fato «pediram a minha revisão» tem um lugar só: a lista e o bloco não
  // podem discordar sobre de quem é a vez
  const pedida = cenas["venceu e bob pediu a revisão de novo"];
  assert.equal(RV.groupReviews([pedida], { me: "ana" }).forMe.length, 1);
  assert.equal(RV.reviewState(pedida, { me: "ana" }).askedAgain, true);
  assert.equal(RV.reviewState(cenas["a aprovação venceu: bob salvou outra versão"], { me: "ana" }).askedAgain, false);
  for (const id of ["a sua aprovação era de uma versão anterior: uma nova versão foi salva depois dela, e ela não conta mais.",
    "o seu pedido de mudanças era de uma versão anterior: uma nova versão foi salva depois dele.",
    "%1 pediu a sua revisão de novo."]) {
    assert.ok(EN[id] && EN[id] !== id, `falta o par em inglês de "${id}"`);
  }
});

// ------------------------------------------------------------------- R47
// ACHADO NO APP RODANDO (rodada 5): depois de «pedir mudanças», o revisor lia o
// PRÓPRIO login em terceira pessoa e o remédio do AUTOR — «ana pediu mudanças /
// responda na conversa, salve uma nova versão no rascunho e peça nova revisão» —
// sobre um rascunho que não é dele. O ramo era byte a byte o mesmo para os dois
// papéis, embora o app soubesse quem está lendo (duas linhas acima ele escreve
// «você aprovou»).
test("R47 — o estado de mudanças pedidas fala com quem está lendo", () => {
  const decisao = pintorDaDecisao();
  const base = {
    number: 12, state: "OPEN", author: { login: "bob" }, headRefName: "rfc/prazo-do-convite",
    approvals: 0, changesRequested: 1, reviewRequests: [], threads: [],
    checks: [{ name: "ci", state: "ok" }], mergeStateStatus: "BLOCKED", mergeable: "MERGEABLE",
  };
  const comoRevisor = { ...base, mine: false, reviews: [{ author: "ana", state: "CHANGES_REQUESTED", stale: false }] };
  const revisor = decisao(comoRevisor, RV.reviewState(comoRevisor, { me: "ana" }));
  assert.match(revisor, /você pediu mudanças/, "quem pediu está lendo: o app sabe quem é");
  assert.ok(!/ana pediu mudanças/.test(revisor), "o próprio login em terceira pessoa é a tela sem leitor");
  assert.ok(!/salve uma nova versão no rascunho/.test(revisor),
    "o rascunho não é do revisor: o remédio do autor não é instrução para ele");
  assert.match(revisor, /bob/, "e diz de quem se espera o próximo passo");

  const comoAutor = { ...base, mine: true, author: { login: "ana" }, reviews: [{ author: "bob", state: "CHANGES_REQUESTED", stale: false }] };
  const autor = decisao(comoAutor, RV.reviewState(comoAutor, { me: "ana" }));
  assert.match(autor, /bob pediu mudanças/, "para o autor, quem pediu tem nome");
  assert.match(autor, /salve uma nova versão no rascunho/, "e o remédio é o dele");
  assert.notEqual(revisor, autor, "dois papéis, duas leituras — o bloco não pode ser o mesmo byte a byte");
  assert.ok(EN["você pediu mudanças"] && EN["você pediu mudanças"] !== "você pediu mudanças");
  const espera = "a mudança não entra no oficial enquanto o pedido estiver aberto — %1 responde na conversa e salva uma nova versão, e você é avisado aqui quando pedirem a sua revisão de novo.";
  assert.ok(EN[espera] && EN[espera] !== espera, "falta o par em inglês do estado do revisor");
});

// ------------------------------------------------------------------- R48
// ACHADO NO APP RODANDO (rodada 5): com a árvore limpa e o GitHub não conectado —
// o estado de qualquer primeira instalação — o estado vazio orientava «Envie para
// revisão quando quiser que o time leia», e duas frases abaixo, no MESMO cartão, a
// tela dizia «o time ainda não está conectado» com o botão de enviar desabilitado.
// O único passo seguinte nomeado era o que a tela acabava de recusar; o mesmo
// teamBlockCode() é avaliado na mesma passada de pintura.
test("R48 — «tudo salvo» não orienta o passo que a mesma tela recusa", () => {
  const limpo = pintorDaLista({ unsaved: [], REV: { changes: [] } });
  limpo.render();
  assert.equal(limpo.nodes.revEmptyTitle.textContent, "tudo salvo");
  assert.match(limpo.nodes.revEmptyMsg.textContent, /Envie para revisão/,
    "conectado, o passo seguinte é o envio");
  assert.equal(limpo.nodes.revEmptyGo.hidden, true);

  const semGh = pintorDaLista({ unsaved: [], REV: { changes: [] }, env: { versioningEnabled: false, gh: { ok: false } } });
  semGh.render();
  assert.equal(semGh.nodes.revEmptyTitle.textContent, "tudo salvo", "a versão está salva: isso é verdade");
  assert.ok(!/Envie para revisão/.test(semGh.nodes.revEmptyMsg.textContent),
    "a tela não pode oferecer como passo seguinte a porta que ela mesma trancou");
  assert.match(semGh.nodes.revEmptyMsg.textContent, /onboarding-atualizado-co/,
    "e continua dizendo onde a versão ficou guardada");
  assert.match(semGh.nodes.revEmptyMsg.textContent, /conecte o GitHub em Configurações/,
    "o passo que FUNCIONA é o que a frase nomeia");
  assert.equal(semGh.nodes.revEmptyGo.hidden, false, "e é uma porta, não uma frase");
  semGh.nodes.revEmptyGo.onclick();
  assert.deepStrictEqual(semGh.portas, ["cfg:git"], "a porta abre a seção que a frase nomeou");
  assert.ok(semGh.falas.some((f) => /conecte o GitHub/.test(f)),
    "quem não vê a tela ouve o mesmo passo seguinte");

  const semRede = pintorDaLista({ unsaved: [], REV: { changes: [] }, env: { versioningEnabled: false, offline: true } });
  semRede.render();
  assert.ok(!/Envie para revisão/.test(semRede.nodes.revEmptyMsg.textContent));
  assert.match(semRede.nodes.revEmptyMsg.textContent, /quando a rede voltar/,
    "sem rede o passo seguinte é esperar a rede, não abrir Configurações");
  assert.equal(semRede.nodes.revEmptyGo.hidden, true, "sem rede o remédio não é Configurações (paintTeamGate diz o mesmo)");
  for (const id of ["a versão está guardada no rascunho «%1». Para o time ler, conecte o GitHub em Configurações.",
    "a versão está guardada no rascunho «%1». Sem conexão agora — envie para revisão quando a rede voltar."]) {
    assert.ok(EN[id] && EN[id] !== id, `falta o par em inglês de "${id}"`);
  }

  // MEDIDO NO APP RODANDO: o diagnóstico do ambiente chega DEPOIS da primeira
  // pintura do destino, então o estado vazio ficava com a frase de quem está
  // conectado enquanto o portão logo abaixo já dizia que não está. As duas
  // superfícies do mesmo fato repintam no mesmo lugar — e a assinatura do
  // repintar carrega o fato, senão a chamada não produz pixel novo.
  const gh = fnBody("renderGhCard");
  assert.match(gh, /paintTeamGate\(\)/, "o portão repinta quando o diagnóstico chega");
  assert.match(gh, /renderMyChanges\(\)/,
    "e a outra superfície do mesmo fato também: uma frase por dono, no mesmo instante");
  const sig = fnBody("renderMyChanges").slice(0, fnBody("renderMyChanges").indexOf("if (sig === REV.sig)"));
  assert.match(sig, /teamBlockCode\(\)/,
    "sem o fato na assinatura, repintar não muda nada na tela");
});

/* ============================================================ trava, rodada 5
   Os achados desta rodada não são do produto: são das ASSERÇÕES. Cinco guardas
   nomeavam um defeito e não podiam ficar vermelhas por ele — um regex satisfeito
   pela sua primeira alternativa (R25, reescrito acima), um seletor conferido por
   SUBSTRING (`data-rvmore` casa dentro de `data-rvmores`), dois pintores que
   nenhum teste executa (`diffRowsHtml`, `plainBitsHtml` entram como `() => ""`
   nos dois arreios que montam um cartão) e 34 dos 42 ids do destino que nenhuma
   asserção alcança. Uma asserção que não pode falhar é pior do que nenhuma: ela
   ocupa o lugar da que faltava.

   As quatro abaixo medem o DESENHO e o LIGADOR pelo que eles produzem, não pelo
   texto que os compõe. */

// Valor de uma constante de módulo do app.js, para o arreio usar o número que a
// tela usa (um teto fixado no teste é um teto que pode divergir do desenhado).
function konst(name) {
  const m = APP.match(new RegExp("const " + name + " = ([^;]+);"));
  assert.ok(m, `app.js deve declarar ${name}`);
  return `const ${name} = ${m[1]};`;
}

// ------------------------------------------------------------------- R49
// ACHADO (mutação, rodada 5): trocar `querySelectorAll("[data-rvmore]")` por
// `"[data-rvmores]"` mata «mostrar mais linhas» e as 747 asserções continuavam
// verdes — R15 confere `/data-rvmore/` nas duas metades, e esse regex é
// SUBSTRING do gancho errado. `data-rvfull`, `data-rvmode` e `data-rvseen` não
// tinham asserção de seletor nenhuma. A lição do N4 (asserção sobre o seletor
// COMPLETO, e cada metade contra a sua própria) não havia chegado aos irmãos.
test("R49 — o gancho de um controle tem o mesmo nome no desenho e no seletor que o lê", () => {
  const pintores = ["changeCardHtml", "diffRowsHtml", "teamRowHtml", "threadHtml", "checksHtml",
    "decisionHtml", "renderReviewDetail"];
  const ligadores = ["wireCardToggle", "wireDiffMore", "renderMyChanges", "renderReviewDetail",
    "wireReviewDetail", "renderTeamReviews"];
  const desenhados = new Set();
  for (const f of pintores) {
    // um ATRIBUTO de marcação: precedido de espaço e fechado por `=`, `>` ou espaço.
    // (`repaintFocused("data-rvfull", …)` é uma string, não um gancho desenhado.)
    for (const m of fnSource(f).matchAll(/ data-((?:rv|pr)[a-z0-9]+)(?==|[ >])/g)) desenhados.add(m[1]);
  }
  const selecionados = new Set();
  const lidos = new Set();
  for (const f of ligadores) {
    const s = fnSource(f);
    for (const m of s.matchAll(/querySelectorAll\("\[data-((?:rv|pr)[a-z0-9]+)\]"\)/g)) selecionados.add(m[1]);
    for (const m of s.matchAll(/\.dataset\.((?:rv|pr)[a-z0-9]+)/g)) lidos.add(m[1]);
  }
  assert.deepStrictEqual([...desenhados].sort(), [...selecionados].sort(),
    "um gancho desenhado que ninguém seleciona é um controle que não faz nada (DESIGN.md §1); " +
    "um seletor sem gancho não liga ninguém");
  // um conjunto vazio dos dois lados passaria pela igualdade: o piso é o número
  // de ganchos que o destino tem hoje, e perder um dos dois lados reprova acima
  assert.ok(selecionados.size >= 14,
    `o destino liga 14 ganchos; a varredura achou ${selecionados.size}`);
  for (const k of lidos) {
    assert.ok(selecionados.has(k),
      `.dataset.${k}: o handler lê uma chave que nenhum seletor traz — undefined em silêncio`);
  }
});

// ------------------------------------------------------------------- R50
// ACHADO (mutação, rodada 5): renomear `id="revBack"` no index.html deixa as 747
// asserções verdes e tira a ÚNICA saída de uma revisão aberta (backToReviewList
// tem um chamador só, e `openReview` para de mover o teclado — o defeito que R21
// nomeia). Renomear `id="revMsg"` faz «Salvar versão do projeto» responder
// «descreva a mudança em uma linha» com a frase digitada na tela. Os arreios de
// pintor deste arquivo fabricam um nó para QUALQUER id (`nodes[id] || noh()`),
// então por construção nenhum deles vê um id que não existe na marcação.
test("R50 — todo id que o app procura no destino existe na marcação, e todo id da marcação é lido", () => {
  const SH = fs.readFileSync(path.join(SRC, "shell.js"), "utf8");
  const CSS = fs.readFileSync(path.join(SRC, "style.css"), "utf8");
  const JS = `${APP}\n${SH}`;
  // O QUE O APP PROCURA: `$("revX")`, `#revX` num seletor, ou o id numa lista.
  // Só camelCase (`rev` + maiúscula) é id; `review`/`revtab` são valores de dado.
  const procurados = new Set();
  for (const m of JS.matchAll(/["'`](rev[A-Z][A-Za-z0-9]*)["'`]/g)) procurados.add(m[1]);
  for (const m of JS.matchAll(/#(rev[A-Z][A-Za-z0-9]*)/g)) procurados.add(m[1]);
  const naMarcacao = new Set([...HTML.matchAll(/id="(rev[A-Za-z0-9]*)"/g)].map((m) => m[1]));
  // um id escrito por um pintor (innerHTML) é tão real quanto um do index.html
  const emTemplate = new Set([...JS.matchAll(/id="(rev[A-Za-z0-9]*)"/g)].map((m) => m[1]));
  const semNo = [...procurados].filter((i) => !naMarcacao.has(i) && !emTemplate.has(i)).sort();
  assert.deepStrictEqual(semNo, [],
    `o app procura estes ids e ninguém os declara — o controle fica inerte, em silêncio:\n  ${semNo.join("\n  ")}`);
  assert.ok(procurados.size >= 40,
    `a varredura tem de alcançar os ids do destino; achou ${procurados.size}`);

  // E o inverso: um id na marcação que ninguém lê é cromo morto (DESIGN.md §9).
  // Ler pode ser pelo JS, pelo seletor da folha de estilo ou por um atributo
  // ARIA do próprio HTML (aria-describedby resolve ids).
  const ANCORAS = new Set([
    // o cartão do compositor: caixa de estilo (classe .revsave) e a fronteira que
    // três asserções deste arquivo usam para recortar o bloco. O runtime não o lê.
    "revSave",
  ]);
  const mortos = [];
  for (const id of naMarcacao) {
    if (ANCORAS.has(id)) continue;
    const solto = new RegExp(`(?<![A-Za-z0-9_])${id}(?![A-Za-z0-9_])`);
    const noHtmlForaDaPropria = HTML.split(`id="${id}"`).join(" ");
    if (solto.test(JS) || solto.test(CSS) || solto.test(noHtmlForaDaPropria)) continue;
    mortos.push(id);
  }
  assert.deepStrictEqual(mortos.sort(), [],
    `ids que ninguém lê:\n  ${mortos.join("\n  ")}`);
  for (const id of ANCORAS) {
    assert.ok(naMarcacao.has(id), `${id} saiu da marcação: a exceção acima virou letra morta`);
  }
});

// O pintor do diff EXERCIDO. Era `() => ""` nos dois arreios que montam um
// cartão, e é a função que desenha TODA linha de mudança da tela.
function pintorDoDiff(cena) {
  const REV = { mode: (cena && cena.mode) || "unified", rowsMore: (cena && cena.rowsMore) || new Map() };
  // eslint-disable-next-line no-new-func
  return new Function("deps", `
    const { t, esc, plural, RV, REV } = deps;
    ${konst("DIFF_ROWS_MAX")}
    ${fnSource("diffRowsHtml")}
    return diffRowsHtml;`)({
    t: (m) => m,
    esc: (s) => String(s === null || s === undefined ? "" : s),
    plural: (n, one, many) => String(Math.abs(n) === 1 ? one : many).replace("%1", n),
    RV, REV,
  });
}

// Duas mudanças longe uma da outra: dois pedaços, com o intervalo derivado dos
// cabeçalhos (30 − (1 + 3) = 26).
const ARQUIVO_DOIS_PEDACOS = {
  path: "contexts/frota/context.md", kind: "modified", additions: 2, deletions: 1, binary: false,
  hunks: [
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, rows: [
      { kind: "context", oldLine: 1, newLine: 1, text: "## Prazos" },
      { kind: "del", oldLine: 2, newLine: null, text: "o prazo é de 48 horas" },
      { kind: "add", oldLine: null, newLine: 2, text: "o prazo é de 7 dias" },
    ] },
    { oldStart: 30, oldLines: 1, newStart: 30, newLines: 2, rows: [
      { kind: "context", oldLine: 30, newLine: 30, text: "## Convite" },
      { kind: "add", oldLine: null, newLine: 31, text: "o reenvio vale uma vez por convite" },
    ] },
  ],
};

// ------------------------------------------------------------------- R51
// ACHADO (mutação, rodada 5): `diffRowsHtml` nunca era EXECUTADO por teste
// nenhum — grepado como texto em duas asserções, listado em duas varreduras e
// substituído por `() => ""` nos dois arreios que montam um cartão. Duas
// mutações passavam as 747: inverter o sinal das duas metades do «lado a lado»
// (o app.js diz por escrito que o sinal é a pista NÃO-cor que carrega a mudança,
// WCAG 1.4.1) e tirar a classe add/del do «unificado» (R4 continua verde porque
// `r.tone` segue presente no texto).
test("R51 — a linha do diff diz de que lado está a mudança, e o sinal concorda com a cor", () => {
  const unificado = pintorDoDiff({ mode: "unified" })(ARQUIVO_DOIS_PEDACOS);
  const linhas = [...unificado.matchAll(/<div class="rvrow uni([^"]*)">([\s\S]*?)<\/div>(?=<div|$)/g)]
    .map((m) => ({ cls: m[1].trim(), html: m[2] }));
  const daLinha = (t) => linhas.find((l) => l.html.includes(t));
  const removida = daLinha("48 horas");
  const adicionada = daLinha("7 dias");
  assert.ok(removida && adicionada, "as duas linhas da mudança são desenhadas");
  assert.equal(removida.cls, "del", "a linha que SAIU é desenhada como saída");
  assert.equal(adicionada.cls, "add", "a que ENTROU, como entrada");
  assert.match(removida.html, /<span class="rvsign">−<\/span>/,
    "o sinal é a pista que não depende de cor (WCAG 1.4.1)");
  assert.match(adicionada.html, /<span class="rvsign">\+<\/span>/);
  assert.equal(daLinha("## Prazos").cls, "", "uma linha de contexto não é tingida de mudança");
  // os dois lados numerados: a linha removida tem número só no lado velho
  assert.match(removida.html, /<span class="rvnum">2<\/span><span class="rvnum"><\/span>/,
    "a linha que saiu tem número do lado de antes e nada do lado de depois");
  assert.match(adicionada.html, /<span class="rvnum"><\/span><span class="rvnum">2<\/span>/);
  // o INTERVALO entre os dois pedaços é dito, com o número que os cabeçalhos dão —
  // e desde R61 ele é `.quiet` e SEM o ⋯: ele não abre nada, e era byte a byte o
  // vizinho que abre (o corte de 400 linhas, com um botão de verdade)
  assert.match(unificado, /<div class="rvgap quiet">26 linhas sem mudança<\/div>/);
  assert.ok(!/rvgap quiet">⋯/.test(unificado),
    "o ⋯ promete «tem mais, clique» — numa faixa que não abre nada ele é a aparência de um controle");
  assert.ok(!/data-rvmore/.test(unificado),
    "e a faixa do intervalo não carrega controle nenhum");

  const lado = pintorDoDiff({ mode: "split" })(ARQUIVO_DOIS_PEDACOS);
  const pares = [...lado.matchAll(/<div class="rvrow split">([\s\S]*?)<\/div>(?=<div|$)/g)].map((m) => m[1]);
  const par = pares.find((p) => p.includes("48 horas"));
  assert.ok(par, "a remoção e a adição que a substitui são UMA linha (D5)");
  const metades = par.split(/(?=<span class="rvnum)/).filter((s) => s.includes("rvtxt"));
  assert.equal(metades.length, 2, "duas metades: como era, como fica");
  assert.match(metades[0], /48 horas/, "a ESQUERDA é como era");
  assert.match(metades[0], /<span class="rvsign">−<\/span>/, "e leva o sinal de saída");
  assert.match(metades[1], /7 dias/, "a DIREITA é como fica");
  assert.match(metades[1], /<span class="rvsign">\+<\/span>/);
  // onde não havia linha, a célula é hachurada (a pista sem cor do vazio)
  const soAdicao = pares.find((p) => p.includes("reenvio vale uma vez"));
  const ladosDaAdicao = soAdicao.split(/(?=<span class="rvnum)/);
  assert.match(ladosDaAdicao[0], /rvhatch/,
    "sem linha do lado de antes, a célula é hachurada em vez de mentir um número");
  assert.match(ladosDaAdicao[1], /reenvio vale uma vez/, "e o texto novo fica do lado de depois");

  // o TETO e a saída dele: 400 linhas, o corte é dito e tem como continuar (R15)
  const rows = [];
  for (let i = 1; i <= 405; i++) rows.push({ kind: "context", oldLine: i, newLine: i, text: `linha ${i}` });
  const longo = { path: "contexts/mobile/context.md", kind: "modified", additions: 0, deletions: 0,
    binary: false, hunks: [{ oldStart: 1, oldLines: 405, newStart: 1, newLines: 405, rows }] };
  const cortado = pintorDoDiff({ mode: "unified" })(longo);
  assert.equal((cortado.match(/class="rvrow uni/g) || []).length, 400, "o cartão não vira o arquivo (DESIGN.md §7)");
  assert.match(cortado, /… e mais 5 linhas/, "o corte é DITO");
  assert.match(cortado, /<button class="plink" data-rvmore="contexts\/mobile\/context\.md">mostrar mais linhas<\/button>/,
    "e tem como continuar dentro da tela: um beco sem saída no destino que existe para ver as linhas exatas");
  const inteiro = pintorDoDiff({ mode: "unified", rowsMore: new Map([[longo.path, 800]]) })(longo);
  assert.equal((inteiro.match(/class="rvrow uni/g) || []).length, 405, "continuar a leitura traz o resto");
  assert.ok(!/data-rvmore/.test(inteiro), "e o convite desaparece quando não há mais o que mostrar");

  // F2's failure path: um binário não desenha um diff vazio POR SER binário
  assert.equal(pintorDoDiff({})({ path: "a.png", kind: "modified", binary: true,
    hunks: ARQUIVO_DOIS_PEDACOS.hunks }), "",
    "com linhas na carga e `binary`, o que decide é o binário");
});

// ------------------------------------------------------------------- R52
// ACHADO (mutação, rodada 5): trocar «como era» por «como fica» no pintor deixava
// as 747 verdes — o texto NOVO rotulado como o antigo, na superfície cuja intenção
// de uma frase (design-spec §1, S2) é «ver o que você mudou nas suas palavras», e
// nos dois rótulos mais lidos da tela. review.test.js cobre o REDUTOR (plainBits
// devolve kind: "before"|"after"); nada ligava `after` a «como fica».
test("R52 — «como era» e «como fica» ficam do lado do texto que cada um descreve", () => {
  // eslint-disable-next-line no-new-func
  const bits = new Function("deps", `
    const { t, esc, plural, RV } = deps;
    ${konst("BIT_LINES")}
    ${fnSource("plainBitsHtml")}
    return plainBitsHtml;`)({
    t: (m) => m,
    esc: (s) => String(s === null || s === undefined ? "" : s),
    plural: (n, one, many) => String(Math.abs(n) === 1 ? one : many).replace("%1", n),
    RV,
  });
  const blocos = (html) => [...html.matchAll(/<div class="rvbit (before|after)"><span class="rvlabel">([^<]*)<\/span>([\s\S]*?)<\/div>/g)]
    .map((m) => ({ lado: m[1], rotulo: m[2], texto: m[3] }));

  const mudado = blocos(bits(ARQUIVO_DOIS_PEDACOS));
  const antes = mudado.find((b) => b.lado === "before");
  const depois = mudado.find((b) => b.lado === "after");
  assert.ok(antes && depois, "uma mudança tem os dois lados");
  assert.equal(antes.rotulo, "como era");
  assert.match(antes.texto, /48 horas/, "«como era» carrega o texto que saiu");
  assert.equal(depois.rotulo, "como fica");
  assert.match(depois.texto, /7 dias/, "«como fica» carrega o texto que entrou");
  assert.ok(!/48 horas/.test(depois.texto), "e não o que saiu");
  assert.ok(mudado.indexOf(antes) < mudado.indexOf(depois), "na ordem em que a mudança se lê");

  // um documento novo (ou removido) é UM bloco, e o rótulo diz isso em vez de
  // prometer uma comparação que não existe
  const novo = blocos(bits({ path: "contexts/novo/context.md", kind: "added", binary: false,
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, rows: [
      { kind: "add", oldLine: null, newLine: 1, text: "# Novo tema" },
      { kind: "add", oldLine: null, newLine: 2, text: "primeira linha" },
    ] }] }));
  assert.deepStrictEqual(novo.map((b) => [b.lado, b.rotulo]), [["after", "documento novo"]]);
  assert.match(novo[0].texto, /# Novo tema\nprimeira linha/, "com o arquivo inteiro dentro");
  const ido = blocos(bits({ path: "antigo.md", kind: "removed", binary: false,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, rows: [
      { kind: "del", oldLine: 1, newLine: null, text: "o que havia aqui" },
    ] }] }));
  assert.deepStrictEqual(ido.map((b) => [b.lado, b.rotulo]), [["before", "documento removido"]]);

  // O RESUMO é resumo: o teto é dito, e a leitura completa é o diff
  const rows = [];
  for (let i = 1; i <= 20; i++) rows.push({ kind: "add", oldLine: null, newLine: i, text: `linha ${i}` });
  const grande = blocos(bits({ path: "g.md", kind: "added", binary: false,
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 20, rows }] }));
  assert.equal(grande[0].texto.split("\n").length, 13, "12 linhas mostradas mais a frase do corte");
  assert.match(grande[0].texto, /… e mais 8 linhas$/);

  // F2's failure path, do lado do resumo
  assert.equal(bits({ path: "a.png", kind: "modified", binary: true, hunks: ARQUIVO_DOIS_PEDACOS.hunks }), "",
    "um binário não tem «como era / como fica» POR SER binário");
});

// ------------------------------------------------------------------- R53
// F3 (design-spec §8) — «Salvar uma versão» é a ação primária do destino, e o
// fluxo inteiro só era conferido por GREP: R12 lê o TEXTO de
// saveVersionFromReview (`/draftSlugify\(/`, `/catch/`, `/startsWith\("err\."\)/`).
// Um grep não sabe a ORDEM nem o desfecho: com a recusa da descrição vazia
// movida para DEPOIS do invoke, ou com o `!r.saved` invertido, as asserções de
// R12 continuam todas verdadeiras enquanto a tela grava o que não devia ou
// anuncia uma versão que não existe. Aqui a função roda, e o que se mede é o
// desfecho de cada um dos quatro caminhos que o fluxo tem.
function salvarVersao(cena) {
  const avisos = [];
  const chamadas = [];
  const logs = [];
  const releu = [];
  const campo = noh({ value: (cena && cena.texto) !== undefined ? cena.texto : "", tagName: "INPUT" });
  const nodes = { revMsg: campo };
  // eslint-disable-next-line no-new-func
  const salvar = new Function("deps", `
    const { $, t, tErr, toast, clog, invoke, brainRefresh, refreshMyChanges, REV } = deps;
    ${APP.match(/const DRAFT_MAX = \d+;/)[0]}
    ${fnSource("draftSlugFromBranch")}
    ${fnSource("draftNameFromBranch")}
    ${fnSource("draftSlugify")}
    ${fnSource("currentDraftSlug")}
    ${fnSource("saveVersionFromReview")}
    return saveVersionFromReview;`)({
    $: (id) => nodes[id] || null,
    t: (m, a) => String(m).replace(/%([1-9])/g, (_, i) => (a && a[i - 1] !== undefined ? a[i - 1] : "%" + i)),
    tErr: (c) => `ERR(${c})`,
    toast: (msg) => avisos.push(msg),
    clog: (m) => logs.push(m),
    invoke: (cmd, args) => {
      chamadas.push({ cmd, args });
      if (cmd === "git_branches") return Promise.resolve((cena && cena.branches) || { current: "main", default: "main" });
      if (cena && cena.erro) return Promise.reject(cena.erro);
      return Promise.resolve((cena && cena.resultado) || { saved: true, branch: "rfc/onboarding-atualizado-co" });
    },
    brainRefresh() {}, refreshMyChanges: () => releu.push("now"),
    REV: { def: "main", branch: (cena && cena.branches && cena.branches.current) || "main" },
  });
  return { salvar, avisos, chamadas, logs, releu, campo };
}

test("R53 — F3: salvar versão recusa, grava e anuncia o rascunho em que a versão caiu", async () => {
  // RECUSA · descrição vazia: nada é gravado, e o teclado vai para o campo
  const vazia = salvarVersao({ texto: "   " });
  await vazia.salvar();
  assert.deepStrictEqual(vazia.avisos, ["descreva a mudança em uma linha antes de salvar"]);
  assert.deepStrictEqual(vazia.chamadas, [], "NADA foi gravado: a recusa vem antes de qualquer processo");
  assert.equal(vazia.campo.focused, true, "e o teclado volta para o campo que falta preencher (WCAG 3.3.2)");

  // GRAVA · no conhecimento oficial o rascunho nasce pela regra de 24 letras,
  // nunca com a frase crua (era um checkout -b de 49 letras que ninguém nomeou)
  const nova = salvarVersao({ texto: "onboarding atualizado com o novo prazo do convite" });
  await nova.salvar();
  const versionar = nova.chamadas.find((c) => c.cmd === "brain_version");
  assert.ok(versionar, "com descrição, a versão é gravada");
  assert.equal(versionar.args.slug, "onboarding-atualizado-co", "o nome é o que a tela anunciou antes do clique");
  assert.equal(versionar.args.message, "onboarding atualizado com o novo prazo do convite",
    "a frase é a mensagem da versão, não o nome do lugar");
  assert.ok(nova.avisos.some((a) => /rascunho «onboarding-atualizado-co»/.test(a)),
    "o desfecho nomeia o rascunho em que a versão caiu");
  assert.ok(!nova.avisos.some((a) => /rfc\//.test(a)), "e não pelo ref do git (DESIGN.md §4)");
  assert.equal(nova.campo.value, "", "a descrição usada sai do campo");
  assert.deepStrictEqual(nova.releu, ["now"], "e a lista relê: a mudança já não está pendente");

  // GRAVA · já num rascunho, a versão cai NELE (não num segundo rascunho)
  const mesmo = salvarVersao({ texto: "prazo conferido", branches: { current: "rfc/prazo-do-convite", default: "main" } });
  await mesmo.salvar();
  assert.equal(mesmo.chamadas.find((c) => c.cmd === "brain_version").args.slug, "prazo-do-convite",
    "o rascunho em que a pessoa está é o lugar da versão");

  // HONESTO · a árvore estava limpa: nenhuma versão foi criada, e a tela diz isso
  const nada = salvarVersao({ texto: "sem nada mudado", resultado: { saved: false } });
  await nada.salvar();
  assert.deepStrictEqual(nada.avisos, ["nada mudou desde a última versão — nenhuma versão foi criada"]);
  assert.equal(nada.campo.value, "sem nada mudado", "e o texto fica no campo: ele ainda não foi usado");
  assert.deepStrictEqual(nada.releu, [], "nada mudou, nada a repintar");

  // FALHA · um código estável se traduz, e o log não carrega o que a pessoa
  // escreveu (BR-8: nem descrição, nem prosa crua do git)
  const suja = salvarVersao({ texto: "prazo do convite", erro: "err.working_tree_dirty" });
  await suja.salvar();
  assert.deepStrictEqual(suja.avisos, ["ERR(err.working_tree_dirty)"]);
  assert.equal(suja.campo.value, "prazo do convite", "a frase digitada não se perde numa falha");
  assert.ok(suja.logs.length && suja.logs.every((l) => !/prazo do convite/.test(l)),
    "BR-8 — o log conta o evento, nunca o conteúdo");

  // FALHA OPACA · o inglês cru do git não é mensagem do produto (R10)
  const opaca = salvarVersao({ texto: "prazo", erro: "fatal: unable to access 'https://...'" });
  await opaca.salvar();
  assert.deepStrictEqual(opaca.avisos, ["não consegui salvar a versão agora"]);
  assert.ok(opaca.logs.every((l) => !/unable to access/.test(l)),
    "e o log guarda «opaque», não a prosa do subprocesso");
  assert.ok(EN["nada mudou desde a última versão — nenhuma versão foi criada"]);
  assert.ok(EN["descreva a mudança em uma linha antes de salvar"]);
});

// ------------------------------------------------------------------- R54
// F1 + F2 (design-spec §8), a prova de cada um, montada com os pintores DE
// VERDADE. Os dois arreios que já montavam um cartão entram com `plainBitsHtml`
// e `diffRowsHtml` trocados por `() => ""`, então nada na suíte via a prova de
// F2 — «o cartão se abre em como era / como fica» e «o diff aparece DENTRO do
// mesmo cartão» — nem a de F1 — «um cartão por arquivo mudado, com o distintivo
// e o caminho». Um cartão que desenhasse o diff fora do <details>, ou que
// carregasse o arquivo inteiro fechado, passava.
function cartaoCompleto(cena) {
  const REV = Object.assign({
    mode: "unified", rowsMore: new Map(), openCard: new Set(), openDiff: new Set(), viewed: new Set(),
  }, cena || {});
  // eslint-disable-next-line no-new-func
  return new Function("deps", `
    const { t, esc, plural, RV, REV } = deps;
    ${konst("BIT_LINES")}
    ${konst("DIFF_ROWS_MAX")}
    ${fnSource("changeBadge")}
    ${fnSource("diffRowsHtml")}
    ${fnSource("plainBitsHtml")}
    ${fnSource("changeCardHtml")}
    return changeCardHtml;`)({
    t: (m) => m,
    esc: (s) => String(s === null || s === undefined ? "" : s),
    plural: (n, one, many) => String(Math.abs(n) === 1 ? one : many).replace("%1", n),
    RV, REV,
  });
}

test("R54 — F1/F2: o cartão nomeia o documento, e abre nas suas palavras antes do diff", () => {
  const via = ARQUIVO_DOIS_PEDACOS.path;

  // F1 · fechado: o distintivo, o nome, o caminho e as contas — e NADA do texto
  const fechado = cartaoCompleto()(ARQUIVO_DOIS_PEDACOS, "now");
  assert.match(fechado, /^<details class="revcard" data-rvcard="contexts\/frota\/context\.md">/,
    "um cartão por arquivo mudado, endereçado pelo caminho");
  assert.match(fechado, /<span class="badge warn2">modificado<\/span>/, "o estado que o backend mandou");
  assert.match(fechado, /<span class="rvname">context\.md<\/span>/, "o cartão diz o DOCUMENTO");
  assert.match(fechado, /<span class="rvpath">contexts\/frota\/<\/span>/, "e a pasta é o endereço dele");
  assert.match(fechado, /\+2 −1 · 2 trechos mudaram/, "as contas do que mudou");
  assert.ok(!/rvbit\b/.test(fechado),
    "fechado, o texto não entra na árvore: num projeto sem primeira versão isso seriam 25 arquivos inteiros em HTML");
  assert.ok(!/rvdiff/.test(fechado), "e o diff também não");

  // F2 · aberto: «como era / como fica» DENTRO do cartão, e o diff ainda não
  const aberto = cartaoCompleto({ openCard: new Set([via]) })(ARQUIVO_DOIS_PEDACOS, "now");
  const bits = aberto.slice(aberto.indexOf('<div class="rvbits">'));
  assert.match(bits, /<span class="rvlabel">como era<\/span>o prazo é de 48 horas/,
    "a leitura em prosa entra no corpo do cartão");
  assert.match(bits, /<span class="rvlabel">como fica<\/span>o prazo é de 7 dias/);
  assert.ok(!/rvdiff/.test(aberto), "o diff é um segundo passo, com controle próprio");
  assert.match(aberto, /data-rvfull="contexts\/frota\/context\.md" aria-expanded="false"/,
    "e o controle diz que ainda está fechado (WCAG 4.1.2)");
  assert.match(aberto, /ver a mudança completa/);

  // F2 · o diff abre DENTRO do mesmo <details>, com o seletor dos dois modos
  const comDiff = cartaoCompleto({ openCard: new Set([via]), openDiff: new Set([via]) })(ARQUIVO_DOIS_PEDACOS, "now");
  const fim = comDiff.indexOf("</details>");
  const iDiff = comDiff.indexOf('<div class="rvdiff">');
  assert.ok(iDiff > 0 && iDiff < fim, "o diff aparece DENTRO do mesmo cartão (D2), não numa segunda coluna");
  assert.match(comDiff.slice(iDiff), /class="rvrow uni del"[\s\S]*48 horas/,
    "e são as linhas reais da mudança, não um diff vazio");
  assert.match(comDiff, /esconder a mudança completa/, "o rótulo diz o que o clique FAZ agora");
  assert.match(comDiff, /aria-expanded="true"/);
  assert.match(comDiff, /data-rvmode="unified" aria-pressed="true"/, "unificado é o padrão (D5)");
  assert.match(comDiff, /data-rvmode="split" aria-pressed="false"/, "e os DOIS botões dizem o seu estado");

  // F2 · a marca de «visto» é do CONTEÚDO daquela lista, não do caminho
  const id = RV.changeId(ARQUIVO_DOIS_PEDACOS, "now");
  const visto = cartaoCompleto({ viewed: new Set([id]) })(ARQUIVO_DOIS_PEDACOS, "now");
  assert.match(visto, /data-rvseen="contexts\/frota\/context\.md" aria-pressed="true"/);
  assert.match(visto, /✓ visto/);
  const outraLista = cartaoCompleto({ viewed: new Set([id]) })(ARQUIVO_DOIS_PEDACOS, "pr:42");
  assert.match(outraLista, /aria-pressed="false"/,
    "a marca da árvore de trabalho não atravessa para a revisão aberta: os caminhos são os mesmos");

  // F2 · o caminho de falha: um binário diz que não dá, e não oferece o diff
  const bin = cartaoCompleto()({ path: "contexts/frota/planta.png", kind: "modified", binary: true,
    additions: 0, deletions: 0, hunks: [] }, "now");
  assert.match(bin, /não dá para mostrar as linhas deste arquivo/);
  assert.ok(!/data-rvfull/.test(bin), "sem linhas para mostrar, o controle não é desenhado (DESIGN.md §1)");
  assert.match(bin, /data-rvseen=/, "mas ele continua sendo um documento que se marca como visto");
});

// ------------------------------------------------------------------- R55
// F1 · a LISTA: um cartão por arquivo mudado, o contador de vistos acima dela e
// o distintivo da aba com o mesmo número. `pintorDaLista` já roda o pintor; o que
// faltava era a asserção de que a lista tem UM cartão por arquivo e que os três
// números (cartões, contador, distintivo) são o mesmo fato.
test("R55 — F1: a lista é um cartão por documento mudado, e os três números concordam", () => {
  const arquivos = [
    { path: "contexts/frota/context.md", kind: "modified", additions: 2, deletions: 1, binary: false, hunks: [] },
    { path: "contexts/mobile/context.md", kind: "added", additions: 9, deletions: 0, binary: false, hunks: [] },
    { path: "INDEX.md", kind: "modified", additions: 1, deletions: 1, binary: false, hunks: [] },
  ];
  const c = pintorDaLista({ REV: { changes: arquivos } });
  c.render();
  const html = c.nodes.revChanges.innerHTML;
  assert.equal((html.match(/<card /g) || []).length, 3, "um cartão por arquivo mudado, nem um a mais");
  for (const f of arquivos) assert.ok(html.includes(`<card ${f.path}>`), `falta o cartão de ${f.path}`);
  assert.match(html, /^<p class="hint"><span class="mono">0 de 3 vistos<\/span><\/p>/,
    "o contador é a primeira linha da lista, e a metade da máquina dele é mono");
  assert.equal(c.nodes.revNowBadge.textContent, 3, "o distintivo da aba escreve o número que o gerou");
  assert.equal(c.nodes.revNowBadge.hidden, false);
  assert.equal(c.nodes.revEmpty.hidden, true, "com mudança na tela não há estado vazio");
  assert.equal(c.nodes.revSaveBtn.disabled, false, "e a ação primária está armada");
  assert.ok(c.falas.some((f) => /3 documentos mudados/.test(f)),
    "quem não vê a tela ouve o mesmo número (WCAG 4.1.2)");

  // e a zero o distintivo desaparece em vez de mostrar «0»
  const vazio = pintorDaLista({ REV: { changes: [] } });
  vazio.render();
  assert.equal(vazio.nodes.revNowBadge.hidden, true, "«0» ao lado do nome da aba é cromo morto");
  assert.equal(vazio.nodes.revChanges.innerHTML, "");
  assert.equal(vazio.nodes.revSaveBtn.disabled, true, "sem nada mudado, salvar não é uma ação");
  assert.equal(vazio.nodes.revSaveBtn.title, "tudo salvo", "e o motivo fica no controle");
});

// ------------------------------------------------------------------- R56
// Achado pelo dono, no app rodando contra o remote real: «o texto descritivo do
// review é um markdown». A descrição de uma revisão e cada comentário da conversa
// eram `esc(...)` dentro do `white-space: pre-wrap` do .rvbit, então o corpo do PR
// #6 do turbo — que tem títulos, uma tabela, ênfase e uma citação — chegava à tela
// com `**`, `|` e `>` crus. É a metade da tela cuja única função é ser lida
// (ADR-0018), e DESIGN.md §5 é explícito: a sintaxe da máquina não chega à
// superfície. O teste nomeia o DEFEITO e afirma o COMPORTAMENTO (o texto do autor
// passa pelo leitor de markdown do app), não a implementação.
function prosaDaRevisao() {
  // eslint-disable-next-line no-new-func
  return new Function("deps", `
    const { t, esc, mdRender, docOpts } = deps;
    ${fnSource("reviewProse")}
    ${fnSource("reviewProseHtml")}
    return { reviewProse, reviewProseHtml };`)({
    t: (m) => m,
    esc: (s) => String(s === null || s === undefined ? "" : s),
    // marcador: se o texto do autor NÃO passar por aqui, o par «md[…]» não aparece
    mdRender: (src, opts) => `md[${src}|${opts && "opts" in opts ? "opts" : JSON.stringify(Object.keys(opts || {}))}]`,
    docOpts: () => ({ ticketBase: "" }),
  });
}

test("R56 — a descrição de uma revisão é lida como markdown, não despejada como sintaxe", () => {
  const { reviewProseHtml } = prosaDaRevisao();

  // com as seções do modelo do time (o caminho normal)
  const comSecoes = reviewProseHtml({
    sections: [
      { label: "Resumo", text: "Aplica **as convenções** da ADR-0026.\n\n| era | é |\n|---|---|" },
      { label: "Como conferir", text: "> Ressalva honesta: a troca foi por nome exato." },
    ],
  });
  assert.match(comSecoes, /md\[Aplica \*\*as convenções\*\* da ADR-0026\./,
    "o texto da seção tem de PASSAR pelo mdRender — era esc() e o ** chegava à tela");
  assert.match(comSecoes, /md\[> Ressalva honesta/, "toda seção, não só a primeira");
  assert.match(comSecoes, /class="rvbit rvprose"/,
    "e no bloco que desliga o pre-wrap: com markup, a quebra do fonte viraria linha em branco");
  assert.match(comSecoes, /<span class="rvlabel">Resumo<\/span>/, "o rótulo da seção continua sendo do modelo");
  assert.ok(!/md\[Resumo\]/.test(comSecoes), "o rótulo NÃO é prosa do autor — não passa pelo renderizador");

  // sem seções: o corpo inteiro, pelo mesmo caminho
  const corpo = reviewProseHtml({ body: "## Dado pessoal\n\n- 31 pessoas em 1.085 menções" });
  assert.match(corpo, /md\[## Dado pessoal/, "o corpo cru do PR também é markdown");
  assert.match(corpo, /class="rvbit rvprose"/);

  // sem descrição alguma: uma frase do produto, escapada, JAMAIS markdown de ninguém
  const vazio = reviewProseHtml({});
  assert.match(vazio, /sem descrição/);
  assert.ok(!/md\[/.test(vazio), "uma frase que o produto escreveu não passa pelo renderizador");

  // as opções são as do leitor de documentos: uma ligação e um localizador se
  // marcam aqui como se marcam lá (ADR-0026), em vez de virarem texto morto
  assert.match(corpo, /\|\["ticketBase"\]\]/,
    "reviewProse passa docOpts() — sem isso uma ligação e um localizador não são marcados (ADR-0026)");
});

test("R56 — cada comentário da conversa também é markdown", () => {
  const th = new Function("deps", `
    const { t, esc, prWhen, reviewProse, threadWhere } = deps;
    ${fnSource("suggestionHtml")}
    ${fnSource("threadHtml")}
    return threadHtml;`)({
    t: (m) => m,
    esc: (s) => String(s === null || s === undefined ? "" : s),
    prWhen: () => "14 de ago.",
    reviewProse: (s) => `md[${s}]`,
    threadWhere: (x) => (x && x.path ? `${x.path}:${x.line}` : ""),
  })({
    path: "INDEX.md", line: 6, id: 1,
    comments: [{ author: "bruno", when: "x", body: "Esse trecho ficou na etapa **errada**." }],
  });
  assert.match(th, /md\[Esse trecho ficou na etapa \*\*errada\*\*\.\]/,
    "o comentário do time era esc() — o ** do GitHub chegava cru na conversa");
  assert.match(th, /class="rvprose"/, "e no bloco que desliga o pre-wrap");
  assert.match(th, /<span class="rvlabel">bruno · 14 de ago\.<\/span>/,
    "quem escreveu e quando continuam sendo valores, não prosa do autor");
});

test("R56 — as três superfícies de leitura decidem o bloco de código junto (DESIGN.md §3/§7)", () => {
  const CSS = fs.readFileSync(path.join(SRC, "style.css"), "utf8");
  // um bloco de código é uma CAIXA em toda superfície de leitura, e conteúdo largo
  // rola dentro do próprio container — a terceira superfície não pode reinventar
  // isso numa regra paralela que envelhece sozinha
  assert.match(CSS, /\.doc pre, \.rvprose pre \{/,
    "a revisão tem de ENTRAR na família do .doc pre, não declarar um pre próprio");
  assert.match(CSS, /\.doc table, \.rvprose table \{[^}]*overflow-x: auto/,
    "uma tabela larga rola dentro de si (§7) na revisão como no documento");
  assert.match(CSS, /\.rvprose \{ white-space: normal; \}/,
    "sem isto o markup herda o pre-wrap do .rvbit e cada quebra do fonte vira linha em branco");
  // a escada só desce, e o h4 nunca fica menor que a prosa que apresenta (13px)
  const px = (sel) => {
    const m = new RegExp("\\" + sel + " \\{ font-size: ([\\d.]+)px").exec(CSS);
    assert.ok(m, `${sel} precisa de um degrau declarado`);
    return Number(m[1]);
  };
  const h1 = px(".rvprose h1"), h2 = px(".rvprose h2"), h3 = px(".rvprose h3");
  assert.ok(h1 > h2 && h2 > h3, `a escada tem de descer: ${h1} > ${h2} > ${h3}`);
  assert.match(CSS, /\.rvprose h4, \.rvprose h5, \.rvprose h6 \{ font-size: 13px/,
    "h4 nunca é menor que a prosa de 13px do cartão");
});

// ------------------------------------------------------------------- R57
// Achado pelo dono: «Ao clicar em Review, o app dá uma travada». Medido no turbo:
// um clique disparava git_branches (13 subprocessos), gh_pr_list (~1,7s de rede) e
// brain_notifications (4 subprocessos, ~3,3s, INCLUINDO um segundo `gh pr list`) —
// e nenhum deles era `async`, então em Tauri v2 os três rodavam na MAIN THREAD:
// ~5s de janela travada por clique, e a mesma lista buscada duas vezes.
//
// É a classe do ADR-0022 §28 (whisper na main thread, três vezes) do lado do git.
// A guarda abaixo é POSITIVA — afirma que estes quatro estão fora da main thread —
// e não uma lista de exceção para os outros dez, que seguem abertos na ADR.
const LIB = fs.readFileSync(path.join(__dirname, "..", "src-tauri", "src", "lib.rs"), "utf8");
const GIT = fs.readFileSync(path.join(__dirname, "..", "src-tauri", "src", "git.rs"), "utf8");

test("R57 — os comandos do caminho da Revisão não rodam na main thread", () => {
  // um #[tauri::command] SEM async roda na main thread em Tauri v2, e cada um
  // destes abre subprocesso (git ls-tree por branch, gh pr list, gh auth status)
  for (const cmd of ["gh_pr_list", "gh_pr_status", "git_branches", "brain_notifications"]) {
    const re = new RegExp("#\\[tauri::command\\]\\s*\\n\\s*(async\\s+)?fn " + cmd + "\\b");
    const m = LIB.match(re);
    assert.ok(m, `lib.rs deve declarar o comando ${cmd}`);
    assert.ok(m[1], `${cmd} é síncrono: em Tauri v2 isso é a main thread, e ele abre subprocesso`);
  }
  // e async sozinho não basta: bloquear dentro de um async prende uma thread do
  // executor. O trabalho bloqueante tem de ir para o pool de bloqueio.
  for (const cmd of ["gh_pr_list", "gh_pr_status", "git_branches", "brain_notifications"]) {
    const i = LIB.indexOf(`fn ${cmd}(`);
    const corpo = LIB.slice(i, LIB.indexOf("\n}", i));
    assert.match(corpo, /spawn_blocking/,
      `${cmd} precisa entregar o trabalho bloqueante ao pool (spawn_blocking), não ao executor`);
  }
});

test("R57 — a mesma lista do remote não é buscada duas vezes no mesmo clique", () => {
  // brain_notifications chamava pr_list() por dentro enquanto o destino chamava
  // gh_pr_list: duas idas à rede, ~1,7s cada, para responder a mesma pergunta
  const i = LIB.indexOf("fn brain_notifications_blocking");
  const corpo = LIB.slice(i, LIB.indexOf("\n}\n", i));
  assert.match(corpo, /pr_list_cached\(/,
    "os avisos têm de ler a MESMA leitura que o destino, não abrir a sua própria");
  assert.ok(!/[^_]pr_list\(&base\)/.test(corpo),
    "chamada direta ao pr_list() é a segunda ida à rede que este teste existe para impedir");

  // single-flight: a trava é mantida DURANTE a busca, então um segundo chamador
  // concorrente espera e encontra o resultado pronto em vez de abrir outro processo
  const cache = GIT.slice(GIT.indexOf("pub fn pr_list_cached"), GIT.indexOf("\n}", GIT.indexOf("pub fn pr_list_cached")));
  assert.match(cache, /pr_cache\(\)\.lock\(\)/, "a leitura e a escrita do cache são a MESMA seção crítica");
  assert.ok(cache.indexOf("pr_list(base)") > cache.indexOf("lock()"),
    "a busca acontece COM a trava na mão — é isso que faz o single-flight");
});

test("R57 — uma escrita no remote invalida a leitura na hora", () => {
  // o pior dado velho possível é o mundo de antes da própria ação de quem olha
  for (const cmd of ["gh_pr_review", "gh_pr_merge", "gh_pr_reply"]) {
    const i = LIB.indexOf(`fn ${cmd}(`);
    const corpo = LIB.slice(i, LIB.indexOf("\n}", i));
    assert.match(corpo, /pr_cache_invalidate\(\)/,
      `${cmd} muda a revisão no remote: sem invalidar, a lista mostraria o mundo de antes`);
  }
  const prop = LIB.slice(LIB.indexOf("fn brain_propose_change("));
  const corpoProp = prop.slice(0, prop.indexOf("\n}\n"));
  assert.equal((corpoProp.match(/pr_cache_invalidate\(\)/g) || []).length, 2,
    "enviar tem DOIS desfechos (abre revisão nova, atualiza a aberta) e os dois mudam a lista");
});

test("R57 — a tela pinta o que já sabe antes da rede, e diz que é a leitura anterior", () => {
  const corpo = fnBody("refreshTeamReviews");
  assert.match(corpo, /REV\.prsFresh = !read\.ageMs/,
    "o backend devolve a idade da leitura; sem ler isso a tela não sabe o que está mostrando");

  // e o rótulo existe, com os dois fatos distintos (cache vs sem rede)
  const pintor = fnBody("paintReviewAge");
  assert.match(pintor, /REV\.prsFresh/, "só rotula quando o que está na tela NÃO é a leitura de agora");
  assert.match(pintor, /REV\.prsStale/, "sem rede é outro fato e outra frase");
  assert.match(pintor, /esta é a leitura anterior/);
  assert.ok(EN["esta é a leitura anterior — buscando as revisões de agora…"],
    "todo msgid precisa do par em inglês (CLAUDE.md §6)");

  // a assinatura de repaint tem de VER a frescura, senão a revalidação não repinta
  const render = fnBody("renderTeamReviews");
  assert.match(render, /REV\.prsFresh/,
    "sem a frescura na assinatura, o repaint pós-revalidação é descartado como 'nada mudou'");
  assert.match(render, /paintReviewAge\(/, "e o rótulo é pintado junto com a lista, numa passada só");
});

test("R57 — abrir uma revisão faz as duas leituras independentes ao mesmo tempo", () => {
  const corpo = fnBody("loadReviewDetail");
  assert.match(corpo, /Promise\.allSettled\(\[/,
    "gh_pr_detail (~1,7s) e gh_pr_diff (~2,0s) eram seriais: 3,7s antes de a revisão aparecer");
  const iDet = corpo.indexOf('invoke("gh_pr_detail"');
  const iDif = corpo.indexOf('invoke("gh_pr_diff"');
  const iAwait = corpo.indexOf("await");
  assert.ok(iAwait < iDet && iAwait < iDif,
    "as duas chamadas têm de nascer dentro do MESMO await, ou voltam a ser seriais");
  assert.match(corpo, /allSettled/, "o texto da revisão vale sem o diff — uma falha do diff não apaga a leitura");
});

test("R57 — o rótulo da idade EXERCIDO: três estados, três frases (ou nenhuma)", () => {
  const el = { hidden: true, textContent: "" };
  const pintar = (rev, total, block) => {
    el.hidden = true; el.textContent = "";
    // eslint-disable-next-line no-new-func
    new Function("deps", `
      const { $, t, REV, teamBlockCode } = deps;
      ${fnSource("paintReviewAge")}
      return paintReviewAge;`)({
      $: (id) => (id === "revAge" ? el : null),
      t: (m) => m,
      REV: rev,
      teamBlockCode: () => block || "",
    })(total);
    return { hidden: el.hidden, texto: el.textContent };
  };

  // a leitura que acabou de voltar da rede: nada a declarar
  assert.deepEqual(pintar({ prsFresh: true, prsStale: false }, 2),
    { hidden: true, texto: "" }, "uma leitura de agora não é rotulada — seria ruído");

  // veio do cache: a tela diz que é a anterior e que está buscando
  const cache = pintar({ prsFresh: false, prsStale: false }, 2);
  assert.equal(cache.hidden, false, "uma lista do cache TEM de se declarar");
  assert.match(cache.texto, /leitura anterior/);

  // sem rede: outro fato, outra frase — não vai revalidar até a rede voltar
  const semRede = pintar({ prsFresh: false, prsStale: true }, 2);
  assert.equal(semRede.hidden, false);
  assert.match(semRede.texto, /sem conexão agora/);
  assert.notEqual(semRede.texto, cache.texto,
    "«do cache, atualizando» e «sem rede, não vai atualizar» são fatos diferentes");

  // lista vazia, ou time bloqueado: o rótulo da idade não fala por uma lista que
  // não existe — quem fala nesse caso é o estado vazio, com o seu próprio remédio
  assert.equal(pintar({ prsFresh: false, prsStale: false }, 0).hidden, true,
    "sem nenhuma revisão não há leitura para datar");
  assert.equal(pintar({ prsFresh: false, prsStale: false }, 2, "err.gh_auth_required").hidden, true,
    "com o time desconectado o assunto é a conexão, não a idade");
});

test("R57 — a lista conhecida está na tela ANTES de a rede responder", () => {
  // A primeira versão deste teste comparava índices de texto no corpo da função —
  // e o PRIMEIRO `renderTeamReviews()` do corpo é o do ramo de bloqueio, antes do
  // await, então a asserção passava mesmo com a pré-pintura removida. Uma
  // asserção que não pode reprovar é a doença que este repositório já pegou uma
  // vez (o filtro de grep que escondeu um diff do cargo fmt). Agora o pintor é
  // EXERCIDO e o que se mede é QUANDO ele foi chamado.
  const renders = [];
  let resolverRede;
  const REV = { prs: [{ number: 6 }], prsErr: "", prsStale: false, prsFresh: true, teamSig: "x" };
  // eslint-disable-next-line no-new-func
  const refresh = new Function("deps", `
    const { invoke, REV, reviewOn, teamBlockCode, renderTeamReviews, renderMyChanges } = deps;
    ${fnSource("refreshTeamReviews")}
    return refreshTeamReviews;`)({
    invoke: () => new Promise((r) => { resolverRede = r; }),
    REV,
    reviewOn: () => true,
    teamBlockCode: () => "",
    renderTeamReviews: () => renders.push(REV.prsFresh),
    renderMyChanges: () => {},
  });

  const p = refresh();
  // a rede AINDA não respondeu
  assert.equal(renders.length, 1,
    "a lista que já se conhece tem de ir para a tela antes do await — era uma tela vazia por ~1,7s");
  assert.equal(renders[0], false,
    "e nessa primeira pintura ela se declara NÃO fresca: é a leitura anterior");

  resolverRede({ prs: [{ number: 6 }, { number: 5 }], ageMs: 0 });
  return p.then(() => {
    assert.equal(renders.length, 2, "e repinta quando a rede responde");
    assert.equal(renders[1], true, "aí sim é a leitura de agora, e o rótulo sai");
    assert.equal(REV.prs.length, 2, "com o que o remote respondeu");
  });
});

test("R57 — uma resposta que vem do cache continua se declarando anterior", () => {
  const renders = [];
  let resolverRede;
  const REV = { prs: [{ number: 6 }], prsErr: "", prsStale: false, prsFresh: true, teamSig: "x" };
  // eslint-disable-next-line no-new-func
  const refresh = new Function("deps", `
    const { invoke, REV, reviewOn, teamBlockCode, renderTeamReviews, renderMyChanges } = deps;
    ${fnSource("refreshTeamReviews")}
    return refreshTeamReviews;`)({
    invoke: () => new Promise((r) => { resolverRede = r; }),
    REV, reviewOn: () => true, teamBlockCode: () => "",
    renderTeamReviews: () => renders.push(REV.prsFresh),
    renderMyChanges: () => {},
  });
  const p = refresh();
  resolverRede({ prs: [{ number: 6 }], ageMs: 12000 });  // 12s de idade: veio do cache
  return p.then(() => {
    assert.equal(renders[renders.length - 1], false,
      "ageMs > 0 é cache: a tela não pode passar isso por leitura de agora");
  });
});

// ------------------------------------------------------------------- R58
// Achado pelo dono: «se já existe uma PR aberta para a branch, não deveria mostrar
// send for team review. Além de que o commit deveria ser junto com o push no save
// a project version.»
//
// Os dois são o mesmo desenho. O controle dizia «↗ Enviar para revisão do time» e
// por dentro ATUALIZAVA a revisão aberta (ADR-0027 D-B): um rótulo que promete
// abrir o que ele vai atualizar. E o banner prometia «salvar versão atualiza a
// revisão aberta» desde a primeira rodada enquanto `save_version` só commitava —
// a versão ficava neste computador e o time seguia lendo a anterior (era o achado
// aberto `save-does-not-update-the-open-review`). Enviar deixa de ser um passo
// porque não é um: salvar leva a versão à revisão que já existe.
test("R58 — a regra de «já está em revisão» é UMA, e a tela e o backend leem a mesma", () => {
  const prs = [
    { number: 6, headRefName: "rfc/prazo", state: "OPEN", url: "u6", author: { login: "aipi" } },
    { number: 5, headRefName: "rfc/velho", state: "CLOSED", url: "u5", author: { login: "aipi" } },
    { number: 4, headRefName: "rfc/outro", state: "OPEN", url: "u4", author: { login: "ana" } },
  ];
  assert.deepEqual(RV.openReviewFor(prs, "rfc/prazo", { me: "aipi" }),
    { number: 6, url: "u6", mine: true }, "o rascunho em que estou, com revisão minha aberta");
  assert.equal(RV.openReviewFor(prs, "rfc/velho", { me: "aipi" }), null,
    "uma revisão FECHADA não é um passo a menos — enviar volta a ser um passo");
  assert.equal(RV.openReviewFor(prs, "rfc/nova", { me: "aipi" }), null, "rascunho sem revisão");
  assert.equal(RV.openReviewFor(prs, "", { me: "aipi" }), null, "sem rascunho não há o que perguntar");
  assert.equal(RV.openReviewFor(prs, "rfc/outro", { me: "aipi" }).mine, false,
    "de quem é o rascunho decide QUAL frase a tela usa");
  // um PR sem `state` é aberto (é o que o gh devolve em `pr list` sem --state)
  assert.ok(RV.openReviewFor([{ number: 9, headRefName: "rfc/z", author: {} }], "rfc/z", {}),
    "sem state declarado o PR é aberto — era o que fazia a lista do destino funcionar");

  // e o backend decide o MESMO, na sua própria linguagem: uma regra, duas casas
  assert.match(GIT, /pub fn propose_act\(prs: &\[PrInfo\], branch: &str\) -> ProposeAct/,
    "propose_act é a mesma regra no Rust — se ela sair, a tela e o backend divergem");
});

test("R58 — «enviar para revisão» sai da tela quando não é mais um passo", () => {
  const gate = (rev, env) => {
    const nodes = {};
    const $ = (id) => (nodes[id] = nodes[id] || { hidden: false, textContent: "", disabled: false });
    // eslint-disable-next-line no-new-func
    new Function("deps", `
      const { $, t, tErr, envDoctor, openCfgGit, RV, REV, goDest, openReview } = deps;
      ${fnSource("teamBlockCode")}
      ${fnSource("reviewMe")}
      ${fnSource("draftSlugFromBranch")}
      ${fnSource("emptyStateOffersCfg")}
      ${fnSource("paintOpenReviewState")}
      ${fnSource("paintTeamGate")}
      return paintTeamGate;`)({
      $, t: (m, a) => String(m).replace(/%([1-9])/g, (_, i) => (a && a[i - 1] !== undefined ? a[i - 1] : "%" + i)),
      tErr: (c) => `ERR(${c})`, envDoctor: env || { versioningEnabled: true },
      openCfgGit: () => {}, RV, REV: rev, goDest: () => {}, openReview: () => {},
    })();
    return nodes;
  };
  const PRS = [{ number: 6, headRefName: "rfc/prazo", state: "OPEN", url: "u", author: { login: "aipi" } }];

  // sem revisão aberta: enviar É um passo, e o controle está lá
  const EU = { versioningEnabled: true, account: "aipi" };
  const semRevisao = gate({ prs: PRS, branch: "rfc/nova" }, EU);
  assert.equal(semRevisao.revProposeBtn.hidden, false, "num rascunho novo, enviar continua sendo a decisão");
  assert.equal(semRevisao.revOpenState.hidden, true, "e não há estado a declarar");

  // com revisão aberta: o controle SAI e o estado toma o lugar dele
  const comRevisao = gate({ prs: PRS, branch: "rfc/prazo" }, EU);
  assert.equal(comRevisao.revProposeBtn.hidden, true,
    "o botão prometia ABRIR o que ia ATUALIZAR — um controle que não faz o que diz");
  assert.equal(comRevisao.revOpenState.hidden, false, "um passo que sai não sai em silêncio");
  assert.match(comRevisao.revOpenState.textContent, /^esta mudança já está em revisão \(#6\)/,
    "o estado nomeia a revisão que já existe — e a frase é a de UM RASCUNHO MEU");
  assert.ok(!/de outra pessoa/.test(comRevisao.revOpenState.textContent),
    "de quem é o rascunho decide a frase: `p.mine` não existe no PrInfo, e ler esse campo dava sempre «de outra pessoa»");

  // o rascunho de OUTRA pessoa recebe a outra frase — as duas têm de se distinguir
  const deOutro = gate({ prs: [{ number: 4, headRefName: "rfc/prazo", state: "OPEN", url: "u", author: { login: "ana" } }], branch: "rfc/prazo" },
    { versioningEnabled: true, account: "aipi" });
  assert.match(deOutro.revOpenState.textContent, /de outra pessoa e já está em revisão \(#4\)/,
    "e a frase do rascunho alheio é outra");
  assert.match(comRevisao.revOpenState.textContent, /salvar versão atualiza a revisão aberta/,
    "e diz qual é o passo que sobrou");
  assert.equal(comRevisao.revOpenStateGo.hidden, false, "com a porta para ela (nunca um número sem porta)");
  assert.match(comRevisao.revOpenStateGo.textContent, /#6/);

  // time bloqueado: o botão VOLTA a ser visível e desarmado — R44 não muda de
  // contrato. Uma porta que some é pior que uma que diz por que está fechada, e
  // aqui a leitura do time pode estar velha, então esconder seria adivinhação.
  const bloqueado = gate({ prs: PRS, branch: "rfc/prazo" }, { versioningEnabled: false, gh: { ok: false } });
  assert.equal(bloqueado.revProposeBtn.hidden, false, "com o time desconectado a porta permanente fica");
  assert.equal(bloqueado.revProposeBtn.disabled, true, "desarmada, com o motivo dito acima dela");
  assert.equal(bloqueado.revOpenState.hidden, true, "e o assunto é a conexão, não a revisão aberta");
});

test("R58 — salvar versão empurra quando o rascunho já está em revisão", () => {
  const sv = GIT.slice(GIT.indexOf("pub fn save_version"), GIT.indexOf("\n}", GIT.indexOf("fn open_review_to_update")));
  assert.match(sv, /open_review_to_update\(base, &branch, saved\)/,
    "salvar tem de perguntar se há revisão aberta — a promessa do banner era só texto");
  assert.match(sv, /push_branch\(base, &branch\)\.is_ok\(\)/,
    "e empurrar: sem isso «salvar versão atualiza a revisão aberta» é mentira");
  // o commit é local e não pode se perder porque a rede caiu: dois fatos, dois campos
  assert.match(GIT, /pub review: Option<u64>/);
  assert.match(GIT, /pub pushed: bool/);
  const gate = GIT.slice(GIT.indexOf("fn open_review_to_update"));
  assert.match(gate.slice(0, gate.indexOf("\n}")), /!saved \|\| !gh_available\(\) \|\| !gh_authed\(\) \|\| git_remote_url\(base\)\.is_none\(\)/,
    "sem versão nova, sem gh ou sem remote não se gasta processo perguntando");

  // um rascunho SEM revisão aberta não empurra nada: «nada sai do seu computador
  // sozinho» continua valendo, e enviar continua sendo a decisão de compartilhar
  assert.match(sv, /ProposeAct::Create => None/,
    "sem revisão aberta o empurrão não acontece — enviar segue sendo um passo do usuário");

  // e o comando sai da main thread, porque acabou de ganhar rede
  const m = LIB.match(/#\[tauri::command\]\s*\n\s*(async\s+)?fn brain_version\b/);
  assert.ok(m && m[1], "brain_version agora toca a rede: síncrono, congelaria a janela pelo tempo do push");
  const corpo = LIB.slice(LIB.indexOf("fn brain_version("), LIB.indexOf("\n}\n", LIB.indexOf("fn brain_version(")));
  assert.match(corpo, /spawn_blocking/);
  assert.match(corpo, /if attempt\.pushed \{\s*\n\s*pr_cache_invalidate\(\)/,
    "a revisão acabou de receber uma versão: a lista tem de saber");
});

test("R58 — o desfecho de salvar é dito como foi, nos três casos", () => {
  const corpo = fnBody("saveVersionFromReview");
  assert.match(corpo, /r\.review && r\.pushed/, "atualizou a revisão");
  assert.match(corpo, /a revisão #%2 foi atualizada/);
  assert.match(corpo, /recebe a atualização quando a rede voltar/,
    "o commit é local: se o empurrão não chegou, dizer «revisão atualizada» seria mentira");
  assert.match(corpo, /Envie para revisão quando quiser que o time leia/,
    "e sem revisão aberta a frase antiga continua certa");
  for (const k of ["versão salva no rascunho «%1» — a revisão #%2 foi atualizada.",
    "versão salva neste computador — a revisão #%1 recebe a atualização quando a rede voltar."]) {
    assert.ok(EN[k], `msgid sem par em inglês: ${k}`);
  }
});

test("R58 — a faixa de F11 sabe de quem é o rascunho (p.mine não existia)", () => {
  // `PrInfo` do gh NÃO tem `mine`, então `!p.mine` era sempre verdadeiro e o SEU
  // próprio rascunho em revisão recebia a frase escrita para o de outra pessoa
  // («você está editando o rascunho…»). Verificado no app rodando contra o turbo.
  const corpo = fnBody("paintEditBanner");
  assert.ok(!/&& !p\.mine/.test(corpo),
    "a regra lia um campo que o backend nunca mandou — sempre verdadeiro, nunca falso");
  assert.match(corpo, /RV\.openReviewFor\(REV\.prs, REV\.branch, \{ me: reviewMe\(\) \}\)/,
    "de quem é o rascunho vem da MESMA regra do resto da tela");
  assert.match(corpo, /const alheio = !!pr && !pr\.mine && !!reviewMe\(\)/,
    "no meu próprio rascunho a faixa não aparece — e SEM a conta lida ela também não, "
    + "porque «de outra pessoa» seria um palpite (era o que fazia a mudança da própria "
    + "pessoa se apresentar como alheia no turbo)");
  assert.match(corpo, /bar\.hidden = !alheio/);
});

// ------------------------------------------------------------------- R59
// O BLOCKER que o loop deixou aberto no teto da 5ª rodada. Achado no app rodando:
// a MESMA janela dizia duas coisas. A lateral mostrava o ponto de mudança não
// salva (o tique de 10s relê `brain_git_files`), o centro dizia «tudo salvo» com
// `#revSaveBtn` desabilitado, e o seletor de rascunhos recusava toda troca com
// «salve uma versão antes de trocar de rascunho» — cujo remédio é justamente o
// botão que a tela tinha desligado. Três superfícies, um fato, duas respostas.
// Causa: `refreshMyChanges` não estava no relógio do app, e o destino não tinha
// nenhum controle de «atualizar».
test("R59 — a Revisão está no relógio do app, e não fica dizendo «tudo salvo» com a lateral acesa", () => {
  const tick = fnBody("brainRefresh");
  assert.match(tick, /if \(reviewOn\(\)\) \{ refreshMyChanges\(\); refreshTeamReviews\(\); \}/,
    "o tique relia brain_git_files para o ponto da lateral e nunca relia as mudanças do destino");

  // e as duas metades continuam autogatilhadas: o tique não pode desfazer o que a
  // pessoa abriu, nem gastar uma ida à rede por passada
  assert.match(fnBody("renderMyChanges"), /if \(sig === REV\.sig\) return/,
    "o repaint por assinatura é o que impede o tique de fechar um cartão aberto");
  const time = fnBody("refreshTeamReviews");
  assert.match(time, /invoke\("gh_pr_list"\)/);
  assert.match(LIB, /const PR_LIST_MAX_AGE: Duration = Duration::from_secs\(30\)/,
    "o tique é de 10s: sem a idade do cache seriam três idas à rede por 30s");

  // o gate de visibilidade continua valendo — o tique não trabalha com a janela oculta
  assert.match(tick, /document\.hidden\) return/,
    "trabalho em segundo plano por um destino que ninguém está olhando é gasto puro");
  // ...e ao voltar para a frente atualiza na hora, senão a tela volta velha
  assert.match(APP, /visibilitychange", \(\) => \{ if \(!document\.hidden\) brainRefresh\(\); \}/);
});

// ------------------------------------------------------------------- R61/R62
// O resto dos achados que o loop deixou abertos no teto da 5ª rodada, e os quatro
// que eu mesmo achei dirigindo o app contra o remote real do turbo. Cada um nomeia
// o defeito, não a correção.
test("R61 — um passo que sai não deixa duas portas para o mesmo lugar", () => {
  // «tudo salvo» oferece «abrir Configurações» (R48: um estado vazio orienta o
  // passo que FUNCIONA, e uma porta não é uma frase). O portão do time oferecia a
  // MESMA porta 300px abaixo, com a mesma frase, na mesma passada de pintura.
  const pred = fnBody("emptyStateOffersCfg");
  assert.match(pred, /REV\.changes/, "só vale quando a lista de agora está vazia");
  assert.match(pred, /draftSlugFromBranch/, "e quando há um rascunho para o time ler");
  assert.match(pred, /err\.github_unreachable/, "sem rede o remédio não é Configurações");
  assert.match(fnBody("paintTeamGate"), /emptyStateOffersCfg\(\)/,
    "é o portão de baixo que se cala — a porta de cima é a que o estado vazio nomeia");
  // e o chip do rascunho é o único controle que abre a folha
  assert.ok(!/revSwitchDraft/.test(APP) && !/revSwitchDraft/.test(HTML),
    "o chip é o estado E a porta: o link ao lado era um segundo ponto de tabulação para o mesmo lugar");
});

test("R62 — a linha da lista diz se a mudança está bloqueada", () => {
  // Visto no turbo: duas linhas reais, nenhum chip. `pr_list` não pedia
  // statusCheckRollup nem mergeable, então a metade que existe para dizer DE QUEM
  // É A VEZ não tinha como dizer.
  assert.match(GIT, /updatedAt,url,state,mergeable,statusCheckRollup/,
    "os dois fatos vêm no MESMO gh pr list, sem processo a mais");
  assert.match(GIT, /pub status_check_rollup: Vec<GhCheck>/, "e PrInfo os carrega");
  assert.match(GIT, /pub fn check_runs\(raw: Vec<GhCheck>\) -> Vec<CheckRun>/,
    "a tradução do rollup é UMA — a lista e o detalhe leem o mesmo campo do gh");

  // a regra pura, exercida
  assert.deepEqual(RV.listChips({ checks: [{ state: "fail" }], mergeable: "CONFLICTING" }).map((c) => c.key),
    ["checks", "conflict"], "verificação falhando E conflito são dois fatos distintos");
  assert.deepEqual(RV.listChips({ checks: [{ state: "ok" }], reviewDecision: "APPROVED" }).map((c) => c.key),
    ["checks", "approved"]);
  assert.deepEqual(RV.listChips({}).map((c) => c.key), [],
    "sem dado nenhum a linha não inventa estado");
  assert.deepEqual(RV.listChips({ reviewDecision: "CHANGES_REQUESTED" }).map((c) => c.key), ["changes"]);

  // e o estado vai para o NOME ACESSÍVEL da linha, não só para o pixel (4.1.2)
  const row = fnBody("teamRowHtml");
  assert.match(row, /RV\.listChips\(p\)/, "a linha usa a regra, não um chip próprio");
  assert.match(row, /chipLabel\(c\)/, "e o rótulo puro alimenta o nome acessível");
});

test("R62 — «0 de 0 aprovações» não passa por conta fechada", () => {
  // Visto no #6 do turbo: reviewDecision REVIEW_REQUIRED, nenhum revisor
  // atribuído, e a tela dizia «0 de 0 aprovações» — que lê como «nada pendente»
  // enquanto o GitHub bloqueava a entrada.
  const req = RV.reviewState({ reviewDecision: "REVIEW_REQUIRED", approvals: 0, reviewRequests: [], reviews: [], threads: [] }, { me: "eu" });
  assert.deepEqual(req.approvals, { have: 0, need: 1 },
    "se o remote diz que falta revisão, o denominador não pode ser zero");
  const feito = RV.reviewState({ reviewDecision: "APPROVED", approvals: 2, reviewRequests: [], reviews: [], threads: [] }, { me: "eu" });
  assert.deepEqual(feito.approvals, { have: 2, need: 2 }, "e uma conta que fechou continua fechada");
  const pedidos = RV.reviewState({ reviewDecision: "REVIEW_REQUIRED", approvals: 1, reviewRequests: [{ login: "a" }, { login: "b" }], reviews: [], threads: [] }, { me: "eu" });
  assert.deepEqual(pedidos.approvals, { have: 1, need: 3 },
    "com gente atribuída o denominador continua sendo a gente NA revisão");
});

test("R62 — a folha de envio diz o que cada seção quer, e cabe mais de uma linha", () => {
  const body = APP.slice(APP.indexOf("const hints = (tpl && tpl.hints)"));
  const campo = body.slice(0, body.indexOf("openModal("));
  assert.match(campo, /placeholder="\$\{esc\(hints\[i\]\)\}"/,
    "o backend calculava as dicas do modelo e a folha as jogava fora — N caixas vazias");
  assert.match(campo, /<textarea class="prsec"[^`]*rows="2"/,
    "«o que muda e por quê» não é um valor de uma linha");
  assert.match(LIB, /hints: Vec<String>/, "e o contrato que as traz continua lá");
});

test("R62 — uma sugestão do GitHub se apresenta pelo que é", () => {
  const sug = new Function("deps", `
    const { t, esc } = deps;
    ${fnSource("suggestionHtml")}
    return suggestionHtml;`)({ t: (m) => m, esc: (s) => String(s === null || s === undefined ? "" : s) });
  const out = sug("olha isso:\n```suggestion\nprazo de 24 horas\n```\nque tal?");
  assert.match(out, /class="rvsug"/, "a cerca ```suggestion chegava como bloco de código sem nome");
  assert.match(out, /sugestão de mudança/, "ela se nomeia");
  assert.match(out, /prazo de 24 horas/, "e mostra o que está sendo sugerido");
  assert.match(out, /aplicar uma sugestão acontece no GitHub/,
    "a saída é dita: não há primitivo do gh, e adivinhar um patch sobre conhecimento é destrutivo");
  assert.equal(sug("um comentário comum"), "", "um comentário sem sugestão não desenha cromo");
  assert.ok(EN["sugestão de mudança"] && EN["aplicar uma sugestão acontece no GitHub — o Loro não reescreve o seu conhecimento por adivinhação."],
    "os dois msgids precisam do par em inglês");
});

test("R62 — o trecho citado de uma conversa não carrega o cabeçalho do hunk", () => {
  // Visto na folha de resposta do #6: «@@ -3,35 +3,107 @@» na tela, dentro do
  // trecho citado. DESIGN.md §5 — a sintaxe da máquina não chega à superfície.
  const f = GIT.slice(GIT.indexOf("fn last_lines"), GIT.indexOf("\n}", GIT.indexOf("fn last_lines")));
  assert.match(f, /!l\.starts_with\("@@"\)/,
    "o diffHunk do GitHub começa pelo cabeçalho, e ele não é a linha comentada nem o contexto dela");
});

test("R62 — o módulo puro do destino entra no node --check do lint", () => {
  const MK = fs.readFileSync(path.join(__dirname, "..", "..", "Makefile"), "utf8");
  const m = /^JS_SRC := (.*)$/m.exec(MK);
  assert.ok(m, "o Makefile declara JS_SRC");
  for (const f of ["desktop/src/review.js", "desktop/src/workspace.js"]) {
    assert.ok(m[1].includes(f), `${f} fora do node --check: um erro de sintaxe lá passava pelo make lint`);
  }
});

// ------------------------------------------------------------------- R63/R64
test("R63 — «ainda não carreguei» não é dito como «não há nada»", () => {
  // `REV.prs || []` colapsava null (nunca carregou) com [] (carregou, não há
  // nenhuma), então na primeira entrada a tela dizia «nada aqui ainda — nenhuma
  // revisão aberta ainda» por ~1,7s enquanto ainda buscava. O estado mentia, e o
  // passo que ele orientava era enviar uma mudança que talvez já estivesse lá.
  const render = fnBody("renderTeamReviews");
  assert.match(render, /REV\.prs === null && !REV\.prsErr && !teamBlockCode\(\)/,
    "carregando é um TERCEIRO estado: nem vazio, nem com dado, nem bloqueado");
  assert.match(render, /empty\.hidden = !!total \|\| carregando/,
    "o estado vazio não pode aparecer enquanto a busca está em curso");
  assert.match(render, /paintLoading\("revTeamLoading", carregando/);

  const now = fnBody("renderMyChanges");
  assert.match(now, /paintLoading\("revNowLoading", true, t\("lendo o que você mudou…"\)\)/,
    "«um momento…» era um <b> parado num estado vazio");
  assert.match(now, /paintLoading\("revNowLoading", false\)/,
    "e ele se apaga em toda outra saída, senão fica piscando sobre a lista");

  // loader e rótulo de idade são MUTUAMENTE EXCLUSIVOS: um diz «não tenho nada», o
  // outro diz «tenho, mas não é de agora»
  const idade = fnBody("paintReviewAge");
  assert.match(idade, /!!total/, "sem nada na tela não há leitura para datar");

  for (const k of ["buscando as revisões do time…", "lendo o que você mudou…"]) {
    assert.ok(EN[k], `msgid sem par em inglês: ${k}`);
  }
});

test("R63 — o indicador é o MESMO da casa, e fala para quem não vê a tela", () => {
  const el = { hidden: true, innerHTML: "" };
  const paint = new Function("deps", `
    const { $, t, esc } = deps;
    ${fnSource("paintLoading")}
    return paintLoading;`)({
    $: (id) => (id === "x" ? el : null), t: (m) => m,
    esc: (s) => String(s === null || s === undefined ? "" : s),
  });
  paint("x", true, "buscando…");
  assert.equal(el.hidden, false);
  assert.match(el.innerHTML, /<span class="dots" aria-hidden="true"><i><\/i><i><\/i><i><\/i><\/span>/,
    "três pontos, escondidos do leitor — o texto ao lado é que fala");
  assert.match(el.innerHTML, /<span class="lbl">buscando…<\/span>/);
  paint("x", false);
  assert.equal(el.hidden, true);
  assert.equal(el.innerHTML, "", "apagado não deixa cromo na árvore");

  // a anatomia é a do «pensando…» do chat, não uma segunda
  const CSS = fs.readFileSync(path.join(SRC, "style.css"), "utf8");
  assert.match(CSS, /\.chatthinking, \.rvloading \{/,
    "um segundo indicador seria uma segunda anatomia para o mesmo fato");
  assert.match(CSS, /prefers-reduced-motion: reduce\) \{ \.chatthinking \.dots i, \.rvloading \.dots i/,
    "DESIGN.md §6: toda animação embrulhada");
  // e os dois nós são regiões vivas (WCAG 4.1.3)
  for (const id of ["revNowLoading", "revTeamLoading"]) {
    const tag = new RegExp(`<p id="${id}"[^>]*>`).exec(HTML);
    assert.ok(tag, `${id} precisa existir na marcação`);
    assert.match(tag[0], /role="status"/);
    assert.match(tag[0], /aria-live="polite"/);
  }
});

test("R64 — o rascunho aparece no cabeçalho, como o desenho previu", () => {
  // Ele vivia SÓ na seção TIME do painel ✦ IA, então em que rascunho você está — o
  // fato que decide onde a próxima versão cai — só era visível com o painel aberto
  // e um documento em foco. O desenho o põe no cabeçalho, antes de Gravar.
  const tag = /<button id="headDraft"[^>]*>/.exec(HTML);
  assert.ok(tag, "o cabeçalho precisa do controle");
  assert.match(tag[0], /hidden/, "sem branch (ou sem git) ele não é desenhado: um chip vazio não é um fato");
  const head = HTML.slice(HTML.indexOf('class="headright"'), HTML.indexOf('id="aiPanelBtn"'));
  assert.ok(head.indexOf('id="headDraft"') < head.indexOf('id="toggleBtn"'),
    "o desenho o põe ANTES de Gravar (DESIGN.md §2 rule 7 mantém Gravar antes de ✦ IA)");

  // MESMA fonte dos outros dois chips: um fato, um nome
  const pintor = fnBody("paintHeadDraft");
  // a forma COMPACTA: o desenho põe no cabeçalho só `⎇ <nome> ⌄`. Reusar a forma com
  // prosa fazia «no rascunho» quebrar em duas linhas dentro da pílula de 190px,
  // inchando o controle e desalinhando o cabeçalho (visto no app rodando).
  assert.match(pintor, /draftChipCompact\(branch, def\)/);
  const compacto = fnSource("draftChipCompact");
  assert.match(compacto, /class="mono">\$\{esc\(name \|\| t\("oficial"\)\)\}/,
    "a linha mostra o ENDEREÇO, que é o que muda");
  assert.ok(!/t\("no rascunho"\)/.test(compacto),
    "a frase inteira fica no title e no nome acessível, que é onde ela cabe");
  assert.match(pintor, /aria-label", `\$\{t\("Rascunhos de trabalho"\)\} — \$\{draftChipLabel\(branch, def\)\}`/,
    "o nome acessível é o texto puro do mesmo fato");
  assert.match(pintor, /el\.hidden = !has/);
  // e abre a MESMA folha que os outros
  assert.match(APP, /for \(const id of \["revDraft", "headDraft"\]\)/,
    "um endereço, uma folha — não uma segunda maneira de escolher rascunho");
  // segue a MESMA autoridade do chip do painel: o estado do git
  assert.match(APP, /paintHeadDraft\(g\.branch, REV\.def\)/);
  assert.match(APP, /paintHeadDraft\("", ""\)/, "sem git nenhum ele desaparece junto com os outros");

  // rule 9 · ele é o PRIMEIRO a ceder largura, e nenhum rótulo é cortado
  const CSS = fs.readFileSync(path.join(SRC, "style.css"), "utf8");
  const narrow = CSS.slice(CSS.indexOf("@media (max-width: 1015px)"));
  assert.match(narrow.slice(0, narrow.indexOf("\n}")), /\.headbranch \.mono, \.headbranch \.rvchipcaret \{ display: none; \}/,
    "abaixo de 1015px fica só o glifo — o nome continua no título e na folha");
  assert.match(CSS, /\.headbranch \{ width: auto; flex: 0 1 auto;/,
    "no cabeçalho ele é uma pílula da linha, não um campo de largura cheia");
  assert.match(CSS, /\.headbranch \{[^}]*white-space: nowrap/,
    "UMA linha: a prosa quebrando dentro da pílula inchava o controle e desalinhava o cabeçalho");
});

test("R65 — abrir uma revisão mostra o loader, não a palavra «um momento» colada no número", () => {
  // Achado pelo dono: «o loader do review (enquanto está carregando review #6) não
  // está mostrando». Os dois loaders da rodada anterior cobriram as duas LISTAS; o
  // detalhe — que é onde a espera de ~2s de rede realmente acontece — continuou com
  // um `<span>#6 — um momento…</span>`, sem indicador e sem anúncio.
  const det = fnBody("renderReviewDetail");
  const carregando = det.slice(det.indexOf("if (!pr)"), det.indexOf("const me ="));
  assert.match(carregando, /class="rvloading" role="status" aria-live="polite"/,
    "a espera do detalhe é a mesma da casa: indicador + região viva");
  assert.match(carregando, /<span class="dots" aria-hidden="true"><i><\/i><i><\/i><i><\/i><\/span>/);
  assert.match(carregando, /lendo a revisão…/);
  assert.ok(!/— \$\{t\("um momento…"\)\}/.test(carregando),
    "«um momento…» colado no número não é um indicador de carregando");
  // e o número da revisão continua lá: a tela diz O QUE está carregando
  assert.match(carregando, /<span class="rvtitle">#\$\{esc\(String\(number\)\)\}<\/span>/);
  // o erro NÃO é loader: são dois estados diferentes
  assert.match(carregando, /REV\.detailErr\s*\n?\s*\?/, "com erro a tela mostra o erro, não os pontinhos");
  assert.ok(EN["lendo a revisão…"]);
});

// ------------------------------------------------------------------- R67
// Achados na revisão de código do PR #71. Nenhum deles quebrou a suíte quando foi
// corrigido — o que quer dizer que nenhuma asserção os cobria. Estas cobrem.
test("R67 — a folha de juntar não inventa aprovação nem check", () => {
  // `t()` troca %1 GLOBALMENTE, e a frase era «%1 de %1» com [have, draft]: ela
  // imprimia have/have ao lado de um cabeçalho dizendo «1 de 2». E `canMerge`
  // aceita `checks === null` (nenhum CI configurado), caso em que «verificações ok»
  // afirmava um check que nunca rodou.
  const dec = fnBody("decisionHtml");
  assert.ok(!/%1 de %1 aprovações/.test(dec),
    "%1 de %1 sempre imprime o mesmo número dos dois lados");
  assert.match(dec, /%1 de %2 aprovações\. Juntar cria a versão/);
  assert.match(dec, /\[st\.approvals\.have, st\.approvals\.need, draft\]/,
    "o denominador é o que o resto da tela usa");
  assert.match(dec, /st\.checks === "ok" \?/,
    "a frase dos checks só sai quando eles existem E passaram");
  assert.ok(EN["%1 de %2 aprovações. Juntar cria a versão no conhecimento oficial e encerra o rascunho «%3»."]);
  assert.ok(EN["As verificações passaram."]);
});

test("R67 — cancelar a troca de rascunho não deixa a vista trocada", () => {
  // `confirmSwitchBranch` só ABRE a folha, e `land()` rodava logo depois: cancelar
  // deixava a pessoa nas mudanças do rascunho anterior, com a revisão fechada e
  // `REV.cameFrom` já sobrescrito.
  const abrir = fnBody("openForEditing");
  assert.match(abrir, /confirmSwitchBranch\(target, price, land\)/,
    "a aterrissagem é consequência da confirmação, não do clique que abre a folha");
  assert.ok(!/confirmSwitchBranch\(target, price\); land\(\)/.test(abrir));
  // e o confirmador só a chama quando a troca ACONTECE
  const conf = fnSource("confirmSwitchBranch");
  assert.match(conf, /function confirmSwitchBranch\(branch, price, after\)/);
  const corpo = conf.slice(conf.indexOf("async () =>"));
  assert.ok(corpo.indexOf("git_switch_branch") < corpo.indexOf("if (after) after()"),
    "primeiro a troca, depois a vista — e nada se a troca falhar");
  assert.match(corpo, /catch \(e\) \{ toast\(tErr/, "e a falha continua sendo dita");
});

test("R67 — a porta permanente do time não fica invisível para sempre", () => {
  const gate = fnBody("paintTeamGate");
  assert.match(gate, /if \(btn\) btn\.hidden = !!aberta;/,
    "era `if (btn && !block)`: escondido por «já em revisão», uma queda de rede depois "
    + "nunca reatribuía, e a nota que descreve o botão (aria-describedby) ficava na tela "
    + "falando de um controle ausente");
  assert.ok(!/if \(btn && !block\) btn\.hidden/.test(gate));
});

test("R67 — uma conversa desatualizada não é uma aprovação", () => {
  const th = fnBody("threadHtml");
  assert.match(th, /th\.outdated \? `<span class="badge warn2">\$\{t\("comentário de uma versão anterior"\)\}/,
    "o msgid da aprovação rotulava uma CONVERSA presa a linhas antigas");
  assert.ok(!/th\.outdated \?[^:]*aprovação de versão anterior/.test(th));
  assert.ok(EN["comentário de uma versão anterior"]);
  // e o msgid da aprovação continua vivo onde ele é verdade
  assert.match(APP, /stale: t\("aprovação de versão anterior"\)/);
});

test("R67 — a recusa do git é lida em língua fixa, não na do sistema", () => {
  const sw = GIT.slice(GIT.indexOf("pub fn switch_branch"), GIT.indexOf("\n}", GIT.indexOf("pub fn switch_branch")));
  assert.match(sw, /\.env\("LC_ALL", "C"\)/,
    "o único caminho para err.switch_would_lose_change é casar o texto do git: "
    + "com um git localizado a recusa cairia no ramo genérico e a prosa crua chegaria ao toast");
  assert.match(sw, /\.env\("LANGUAGE", "C"\)/);
  assert.ok(sw.indexOf('.env("LC_ALL"') < sw.indexOf(".output()"),
    "fixado ANTES de rodar");
});

test("R67 — a linha do time lê a forma que o backend REALMENTE manda", () => {
  // O teste da R62 alimentava `{checks:[{state:"fail"}]}` — a forma normalizada — e
  // por isso passava com o backend mandando `statusCheckRollup` cru. Aqui a entrada
  // é a que sai do Rust: chave `checks`, estados do produto.
  const doBackend = { number: 6, checks: [{ name: "VTEC", state: "failed", url: "u" }], mergeable: "MERGEABLE" };
  assert.deepEqual(RV.listChips(doBackend).map((c) => c.key), ["checks"]);
  assert.equal(RV.listChips(doBackend)[0].values.state, "fail");
  // e os estados que o gh usa NÃO são os do produto: se um deles vazar, não é «ok»
  const cru = { number: 6, checks: [{ state: "FAILURE" }] };
  assert.notEqual(RV.listChips(cru)[0] && RV.listChips(cru)[0].values.state, "ok",
    "um estado desconhecido nunca é pintado como passando");
  assert.deepEqual(RV.listChips({ number: 7, checks: [] }).map((c) => c.key), [],
    "sem CI nenhum a linha não inventa chip");
  // o contrato do Rust está pinado do outro lado
  assert.match(GIT, /fn the_list_hands_the_screen_the_check_shape_the_screen_reads/);
  assert.match(GIT, /fn the_open_review_carries_the_decision_the_remote_gave/);
});
