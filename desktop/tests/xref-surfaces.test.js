// ADR-0026 — the three reading surfaces of a lateral link.
//
// The knowledge base already writes the links; nothing was reading them back.
// This suite pins the reading side, and each test is the defect it prevents:
//
//   the return direction ("Citado por") is INVERTED on read — the kind is
//   echoed as the CITING document declared it, so printing it raw on the cited
//   document says the opposite of what is true;
//   the índice remissivo is a CALCULATED screen — never a file in the acervo,
//   never a locator the reader cannot address;
//   what nobody cites is a defect with an ACTION, not a number on the wall
//   (ADR-0020 §4 removed statistics with no question and no action).
//
// The frontend is vanilla JS loaded by <script> (no DOM in `node --test`), so
// the seam is the SOURCE of app.js/index.html/style.css, like honest-controls
// and surface-truth. Every decision that could be a pure function is one, and
// is exercised for real.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
const APP = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const CSS = fs.readFileSync(path.join(SRC, "style.css"), "utf8");
const T = require("../src/text.js");

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
// The pure painters run for real, with the app's own `esc` and the identity
// translator (pt-BR is the source language, so the msgid IS the string).
function loadPure(names) {
  const src = names.map(fnSource).join("\n");
  // eslint-disable-next-line no-new-func
  return new Function("esc", "t", "uiLocale", src + "\nreturn { " + names.join(", ") + " };")(
    T.esc, (s) => s, () => "pt-BR");
}
// O bloco de estilo da ADR-0026, e só as REGRAS dele: um comentário que cita o
// que a folha não faz ("nada de prefers-color-scheme aqui") não é a folha
// fazendo — a primeira versão desta varredura acusou o próprio comentário.
function adr26Css() {
  const bloco = CSS.slice(CSS.indexOf("/* ADR-0026 · superfícies de leitura"));
  assert.ok(bloco, "o bloco de estilo da ADR-0026 existe e é nomeado");
  return { bloco, regras: bloco.replace(/\/\*[\s\S]*?\*\//g, "") };
}

// ======================================================= 1 · "Citado por"

test("ADR-0026 — sem ninguém citando, o painel de volta não é desenhado", () => {
  const { backlinksHtml, backlinkKindLabel } = loadPure(["backlinksHtml", "backlinkKindLabel"]);
  void backlinkKindLabel;
  assert.equal(backlinksHtml([]), "", "um controle vazio é pior que nenhum (DESIGN.md §1)");
  assert.equal(backlinksHtml(null), "", "sem resposta do grafo também não há seção");
  assert.equal(backlinksHtml([{ context: "x" }]), "",
    "uma linha sem documento não abre nada: não é linha");
});

test("ADR-0026 — o sentido do link é INVERTIDO na leitura de quem é citado", () => {
  const { backlinkKindLabel } = loadPure(["backlinkKindLabel"]);
  // o backend ecoa o tipo como QUEM CITA declarou: "upstream" na página de A quer
  // dizer "B (o alvo) entrega para A". Impresso cru na página de B, diria que A é
  // que entrega — o oposto do que está escrito.
  assert.equal(backlinkKindLabel("upstream"), "recebe deste");
  assert.equal(backlinkKindLabel("downstream"), "entrega para este");
  assert.equal(backlinkKindLabel("bidirecional"), "nos dois sentidos");
  assert.equal(backlinkKindLabel("bidirectional"), "nos dois sentidos", "o molde em inglês também");
  assert.equal(backlinkKindLabel(""), "", "sem tipo declarado não se inventa um");
  assert.equal(backlinkKindLabel("qualquer coisa"), "");
  assert.equal(backlinkKindLabel(undefined), "");
});

test("ADR-0026 — cada linha diz quem cita, em que sentido, e abre o documento", () => {
  const { backlinksHtml } = loadPure(["backlinksHtml", "backlinkKindLabel"]);
  const html = backlinksHtml([
    { rel: "contexts/assinatura/context.md", context: "assinatura", kind: "upstream" },
    { rel: "contexts/rac/agendamento/context.md", context: "rac/agendamento", kind: "" },
  ]);
  assert.match(html, /Citado por/);
  assert.match(html, /\(2\)/, "a contagem é a da lista que a seção mostra");
  assert.match(html, /assinatura/);
  assert.match(html, /rac\/agendamento/);
  assert.match(html, /recebe deste/);
  // o controle é operável por teclado: um <a> sem href não tem papel de link
  assert.match(html, /<button[^>]*data-backlink="contexts\/assinatura\/context\.md"/);
  assert.equal((html.match(/data-backlink=/g) || []).length, 2, "toda linha abre alguma coisa");
  // e a linha sem tipo declarado não ganha um selo vazio
  assert.equal((html.match(/class="backkind mono"/g) || []).length, 1);
});

test("ADR-0026 — o painel de volta só é pedido a um documento de conhecimento", () => {
  const body = fnBody("backlinksHtmlFor");
  assert.match(body, /\^contexts\\\/\.\+\\\/context\\\.md\$/,
    "só context.md tem ligação lateral: perguntar por uma nota é IPC à toa");
  assert.match(body, /invoke\("brain_backlinks", \{ rel \}\)/,
    "o nome do argumento é o do contrato (rel)");
  assert.equal((body.match(/return "";/g) || []).length, 3,
    "fora do conhecimento, sem resposta e em leitura vencida: os três saem sem seção");
  assert.match(body, /stale/, "uma leitura mais nova vence a corrida");
});

test("ADR-0026 — a volta nasce na MESMA pintura do documento", () => {
  const body = fnBody("renderView");
  assert.match(body, /const back = await backlinksHtmlFor\(tab\.rel, stale\)/,
    "o painel de referências olha para dentro; a volta olha para fora, e alguém tem de pedi-la");
  assert.match(body, /B\.doc\.innerHTML = panel \+ back \+/,
    "inserida depois, a seção empurraria para baixo o texto que o leitor já começou a ler");
  assert.match(body, /wireBacklinks\(\)/, "e cada linha precisa abrir o documento que cita");
  assert.match(fnBody("wireBacklinks"), /openDoc\(b\.dataset\.backlink/);
});

// =================================================== 2 · índice remissivo

test("ADR-0026 — o índice é uma TELA calculada: nada é escrito no acervo", () => {
  const body = fnBody("renderIndexSurface");
  assert.match(body, /invoke\("brain_index_terms"\)/, "os termos vêm do que já está escrito");
  assert.ok(!/brain_write|brain_save|brain_add_ref|invoke\("brain_[a-z_]*write/.test(body),
    "um índice em arquivo envelhece e passa a mentir: esta tela é recalculada na leitura");
  assert.match(APP, /const INDEX_REL = "loro:\/\/[a-z]+";/,
    "a tela mora num sentinela loro://, como o manual — não é um caminho do projeto");
  assert.ok(!/indice\.md.*INDEX_REL|INDEX_REL.*indice\.md/.test(APP),
    "o índice remissivo não é o indice.md de nenhuma ideia");
});

test("ADR-0026 — o verbete traz o localizador qualificado, em mono e clicável", () => {
  const { indexSurfaceHtml } = loadPure(["indexSurfaceHtml", "locatorLabel"]);
  const html = indexSurfaceHtml([
    { term: "precificação", entries: [
      { rel: "contexts/assinatura/context.md", context: "assinatura", locator: "assinatura#H-3" },
      { rel: "contexts/rac/agendamento/context.md", context: "rac/agendamento", locator: "§2" },
    ] },
  ]);
  assert.match(html, /precificação/);
  assert.match(html, /class="loc"[^>]*>assinatura#H-3</,
    "H-3 sozinho não endereça nada: o hotspot é qualificado pelo contexto na leitura");
  assert.match(html, /rac\/agendamento §2/, "a seção também é dita com o dono dela");
  // o clique passa pela rota que já funciona (a[data-path] → brain_resolve_ref)
  assert.match(html, /data-path="acervo:\/\/contexts\/assinatura\/context\.md"/,
    "ancorado no projeto: o índice não tem diretório próprio para resolver relativo");
  assert.equal((html.match(/class="loc"/g) || []).length, 2);
});

test("ADR-0026 — o localizador nomeia onde a palavra está, sempre", () => {
  const { locatorLabel } = loadPure(["locatorLabel"]);
  assert.equal(locatorLabel({ context: "assinatura", locator: "assinatura#H-3" }), "assinatura#H-3",
    "o que já vem qualificado não é qualificado duas vezes");
  assert.equal(locatorLabel({ context: "assinatura", locator: "§2" }), "assinatura §2");
  assert.equal(locatorLabel({ context: "assinatura", locator: "D-2026-05-12-slug" }),
    "assinatura D-2026-05-12-slug");
  assert.equal(locatorLabel({ context: "assinatura", locator: "MM-1147" }), "assinatura MM-1147");
  assert.equal(locatorLabel({ context: "assinatura", locator: "" }), "assinatura",
    "sem seção numerada acima, o endereço é o documento inteiro");
  assert.equal(locatorLabel({ rel: "contexts/x/context.md" }), "x",
    "sem contexto declarado, o nome sai do próprio caminho — nunca uma linha em branco");
});

test("ADR-0026 — sem termos, o índice explica em vez de mostrar uma lista vazia", () => {
  const { indexSurfaceHtml } = loadPure(["indexSurfaceHtml", "locatorLabel"]);
  const vazio = indexSurfaceHtml([]);
  assert.ok(!/<dl/.test(vazio), "uma lista de definições sem definição nenhuma é cromo");
  assert.match(vazio, /class="bempty"/, "o vazio é dito com a mesma marca do resto do app");
  assert.equal(indexSurfaceHtml(null), indexSurfaceHtml([]), "sem resposta é o mesmo vazio");
  // um termo sem nenhuma entrada não vira verbete: não há para onde ir
  assert.equal(indexSurfaceHtml([{ term: "x", entries: [] }]), vazio);
});

test("ADR-0026 — a palavra é a do autor: o índice não a reescreve nem a executa", () => {
  const { indexSurfaceHtml } = loadPure(["indexSurfaceHtml", "locatorLabel"]);
  const html = indexSurfaceHtml([
    { term: "<b>preço</b>", entries: [{ rel: "contexts/a/context.md", context: "a", locator: "" }] },
  ]);
  assert.ok(!/<b>preço<\/b>/.test(html), "markup vindo do acervo é texto, não HTML");
  assert.match(html, /&lt;b&gt;preço/);
});

test("ADR-0026 — os verbetes saem em ordem alfabética, como um índice de livro", () => {
  const { indexSurfaceHtml } = loadPure(["indexSurfaceHtml", "locatorLabel"]);
  const e = [{ rel: "contexts/a/context.md", context: "a", locator: "" }];
  const html = indexSurfaceHtml([
    { term: "reserva", entries: e }, { term: "álibi", entries: e }, { term: "cobrança", entries: e },
  ]);
  const ordem = [...html.matchAll(/class="idxterm">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(ordem, ["álibi", "cobrança", "reserva"],
    "a ordem do backend é a da varredura do disco; um índice se lê pela letra");
});

test("ADR-0026 — a tela do índice entra pela anatomia única, sem inventar destino", () => {
  const body = fnBody("renderActive");
  assert.match(body, /INDEX_REL/, "renderActive é o único despachante de superfície");
  assert.match(fnBody("docBadge"), /INDEX_REL/,
    "o selo não pode dizer 'documento do projeto' de uma tela que é cálculo");
  assert.match(HTML, /id="knowIdxBtn"/, "a porta de entrada mora no destino Conhecimento");
  const know = HTML.slice(HTML.indexOf('id="destKnowledge"'), HTML.indexOf('id="bDocWrap"'));
  assert.match(know, /id="knowIdxBtn"/);
  assert.ok(!/id="knowIdxBtn"[^>]*class="[^"]*solid/.test(HTML),
    "uma ação primária por tela: a do Conhecimento não é o índice");
  assert.match(APP, /\$\("knowIdxBtn"\)[\s\S]{0,120}INDEX_REL/,
    "o botão abre a tela de verdade");
});

// ============================================ 3 · o que ninguém cita

test("ADR-0026 — sem órfão e sem link quebrado, nenhuma seção nasce", () => {
  const { knowledgeGapsHtml } = loadPure(["knowledgeGapsHtml"]);
  assert.equal(knowledgeGapsHtml({ orphans: [], broken: [] }), "");
  assert.equal(knowledgeGapsHtml(null), "");
  assert.equal(knowledgeGapsHtml({}), "");
});

test("ADR-0026 — todo órfão vem com UMA ação ao lado, nunca um número solto", () => {
  const { knowledgeGapsHtml } = loadPure(["knowledgeGapsHtml"]);
  const html = knowledgeGapsHtml({
    orphans: ["contexts/assinatura/context.md", "contexts/rac/agendamento/context.md"],
    broken: [],
  });
  assert.match(html, /Conhecimento que ninguém cita/);
  assert.equal((html.match(/class="gaprow"/g) || []).length, 2);
  assert.equal((html.match(/data-gapopen=/g) || []).length, 2,
    "ADR-0020 §4: estatística sem pergunta e sem ação foi removida da Home — não volta aqui");
  assert.match(html, /data-gapopen="contexts\/assinatura\/context\.md"/);
  assert.match(html, />assinatura</, "o nome é o do tema, não o caminho do arquivo");
  assert.ok(!/>contexts\/assinatura\/context\.md</.test(html));
});

test("ADR-0026 — o link quebrado mostra o alvo exatamente como o autor escreveu", () => {
  const { knowledgeGapsHtml } = loadPure(["knowledgeGapsHtml"]);
  const html = knowledgeGapsHtml({
    orphans: [],
    broken: [{ from: "contexts/assinatura/context.md", target: "../inexistente/context.md" }],
  });
  assert.match(html, /Ligações quebradas/);
  assert.match(html, /\.\.\/inexistente\/context\.md/,
    "é essa string que o autor tem de corrigir: reescrevê-la esconde o defeito");
  assert.match(html, /data-gapopen="contexts\/assinatura\/context\.md"/,
    "a ação abre o documento QUE CITA — é lá que o conserto acontece");
  assert.equal((html.match(/data-gapopen=/g) || []).length, 1);
});

test("ADR-0026 — a seção é recalculada a cada passada, e só onde é olhada", () => {
  const body = fnBody("paintKnowledgeGaps");
  assert.match(body, /invoke\("brain_knowledge_graph"\)/, "o estado relatado é lido, não lembrado");
  assert.match(body, /destination\(\) !== "knowledge"/,
    "varrer o disco por um destino que ninguém está vendo é gasto puro");
  assert.match(body, /data-gapopen/, "a ação de cada linha é ligada quando a linha nasce");
  assert.match(fnBody("renderDestKnowledge"), /paintKnowledgeGaps\(/);
  assert.match(fnBody("goDest"), /paintKnowledgeGaps\(/,
    "entrar no destino não pode esperar os 10s do poll");
});

// ==================================================== 4 · DESIGN.md §9

test("DESIGN §9 — as três superfícies têm borda de controle e vivem nos dois temas", () => {
  const { regras } = adr26Css();
  assert.ok(!/prefers-color-scheme/.test(regras),
    "o tema é `data-theme` resolvido no casco: ler o SO ignora a escolha do usuário");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(regras), "nenhuma cor crua: tudo sai do sistema de tokens");
  for (const sel of [".backpanel", ".gaprow", ".idxterm", ".knowmap"]) {
    assert.ok(regras.includes(sel), `a folha precisa desenhar ${sel}`);
  }
  assert.match(regras, /button\.refitem/,
    "a linha do 'Citado por' é um <button>: um <a> sem href não recebe foco (WCAG 2.1.1)");
  // a caixa que É a afordância do controle clareia os 3:1 da WCAG 1.4.11
  assert.match(regras, /#knowIdxBtn \{ border-color: var\(--line-control\); \}/);
  assert.match(regras, /\.gaprow \.mini\.act \{[^}]*border-color: var\(--line-control\)/);
});

test("DESIGN §9 — a coluna estreita é lida pela COLUNA, nunca pela janela", () => {
  const { regras } = adr26Css();
  assert.match(regras, /@container \(max-width: \d+px\)/,
    "o painel ✦ IA tira COLUNA, não janela (DESIGN.md §7)");
  assert.ok(!/@media \(max-width/.test(regras),
    "uma media query de janela não vê o painel aberto: foi exatamente esse o defeito da grade da Home");
  assert.match(CSS, /\.bmain \{ container-type: inline-size; \}/,
    "o contêiner consultado continua sendo a coluna de conteúdo");
});

test("DESIGN §9 — nada aqui se move sem respeitar quem pediu menos movimento", () => {
  const { regras } = adr26Css();
  const movimento = [...regras.matchAll(/^\s*(animation|transition):[^;]+;/gm)].map((m) => m[0].trim());
  const guardado = /prefers-reduced-motion/.test(regras);
  assert.ok(!movimento.length || guardado,
    "movimento novo sem o guardião de prefers-reduced-motion:\n  " + movimento.join("\n  "));
});

// BR-8 — o grafo só abre `contexts/**/context.md`, mas quem PINTA também não
// pode virar um caminho para conteúdo: nenhum dos três pintores registra o que
// recebeu, e nenhum deles imprime caminho de reunião, transcrição ou pessoal.
test("BR-8 — nenhuma das três telas registra o que leu", () => {
  for (const fn of ["backlinksHtmlFor", "renderIndexSurface", "paintKnowledgeGaps"]) {
    const body = fnBody(fn);
    const logs = [...body.matchAll(/clog\(([^)]*)\)/g)].map((m) => m[1]);
    for (const l of logs) {
      assert.ok(/error/.test(l) && !/\b(rows|terms|graph|html)\b/.test(l),
        `${fn}: o log leva conteúdo do acervo junto (BR-8): clog(${l})`);
    }
  }
});

// A linha da porta de entrada é desenhada com os MESMOS colaboradores das linhas
// vizinhas (ícone, cor de status do git, menu de caminho) — testá-la com dublês
// provaria que o markup existe, não que ele é igual ao das irmãs.
function loadEntry() {
  const src = ["entryDocsHtml", "ico", "gitClass", "pathMenuBtnHtml", "rowMenuHtml"].map(fnSource).join("\n");
  // eslint-disable-next-line no-new-func
  return new Function("esc", "t", "ICONS", "gitFiles",
    src + "\nreturn { entryDocsHtml };")(T.esc, (s) => s, { file: "M0 0" }, {});
}

// ======================================================= 4 · a porta de entrada
//
// O INDEX.md é o que a medição apontou como o maior ganho isolado de busca
// (acerto de 0,17 → 0,50 ao descrever os 80 temas), o protocolo manda começar
// por ele e o loop o reescreve a cada passada. E ele não aparecia em lugar
// nenhum da interface: a árvore de Conhecimento desenha só os temas, então o
// único caminho era o ⌘K — para quem já soubesse o nome do arquivo. O app sabia
// e não dizia (DESIGN.md §1).

test("ADR-0026 — a porta de entrada do projeto aparece na árvore", () => {
  const { entryDocsHtml } = loadEntry();
  const html = entryDocsHtml([
    { name: "INDEX.md", dir: false },
    { name: "AGENTS.md", dir: false },
    { name: "contexts", dir: true },
  ]);
  assert.match(html, /data-doc="INDEX\.md"/, "abre o arquivo de verdade");
  assert.match(html, /índice do projeto/, "com o nome do usuário, não o do arquivo");
});

test("ADR-0026 — sem o arquivo, nenhuma linha é desenhada", () => {
  const { entryDocsHtml } = loadEntry();
  assert.strictEqual(entryDocsHtml([{ name: "contexts", dir: true }]), "");
  assert.strictEqual(entryDocsHtml([]), "");
  assert.strictEqual(entryDocsHtml(null), "");
});

test("ADR-0026 — uma pasta chamada INDEX.md não vira documento", () => {
  const { entryDocsHtml } = loadEntry();
  assert.strictEqual(entryDocsHtml([{ name: "INDEX.md", dir: true }]), "");
});

test("ADR-0026 — a árvore de Conhecimento desenha a porta antes dos temas", () => {
  const src = fnBody("renderSidebar");
  assert.match(src, /entryDocsHtml/, "renderSidebar monta a porta de entrada");
  const pos = src.indexOf("entryDocsHtml");
  const forest = src.indexOf("renderCtxForest");
  assert.ok(pos >= 0 && forest >= 0 && pos < forest, "a porta vem antes da lista de temas");
});

// O varredor de i18n encontra `t("literal")`. O rótulo da porta de entrada chega
// por `t(d.label)` — chamada dinâmica, invisível para ele: a suíte ficou verde
// com o rótulo sem tradução, e em inglês a lateral mostraria português. Este
// teste fecha o buraco pela lista, que é onde o texto realmente mora.
test("ADR-0026 — o rótulo da porta de entrada tem par em inglês", () => {
  const I18N = fs.readFileSync(path.join(SRC, "i18n.js"), "utf8");
  const src = fnSource("entryDocsHtml");
  const labels = [...src.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(labels.length, "a lista de documentos de entrada declara rótulos");
  for (const label of labels) {
    assert.ok(
      I18N.includes(`"${label}":`),
      `o rótulo "${label}" chega por t(d.label) e não tem par em inglês`
    );
  }
});

// ======================================================= 5 · onde eu estou
//
// A árvore marcava com `.on` só as linhas `[data-doc]`. Um tema é uma linha
// `[data-ctx]` — então abrir `contexts/trato/hardware-lifecycle/context.md`
// não acendia nada, e ainda por cima o documento chegava numa aba de preview
// que substituía a anterior: você perdia de onde veio E onde está.

test("ADR-0026 — o tema aberto acende na árvore", () => {
  const { ctxOfDoc } = loadPure(["ctxOfDoc"]);
  assert.strictEqual(ctxOfDoc("contexts/assinatura/context.md"), "assinatura");
  assert.strictEqual(ctxOfDoc("contexts/trato/hardware-lifecycle/context.md"), "trato/hardware-lifecycle");
  assert.strictEqual(ctxOfDoc("contexts/assinatura/CHANGELOG.md"), "assinatura");
});

test("ADR-0026 — o que não é tema não acende tema nenhum", () => {
  const { ctxOfDoc } = loadPure(["ctxOfDoc"]);
  assert.strictEqual(ctxOfDoc("INDEX.md"), "");
  assert.strictEqual(ctxOfDoc("pessoal/temas/x.md"), "");
  assert.strictEqual(ctxOfDoc(""), "");
});

test("ADR-0026 — markSel acende a linha do tema, não só a do arquivo", () => {
  const src = fnBody("markSel");
  assert.match(src, /ctxOfDoc/, "markSel usa o tema do documento aberto");
  assert.match(src, /data-ctx/, "e marca a linha do tema na árvore");
});

test("ADR-0026 — seguir uma referência não substitui a aba de onde você veio", () => {
  const src = fnBody("onRefClick");
  const abre = /openDoc\(res\.rel,\s*\{\s*preview:\s*false\s*\}\)/;
  assert.match(src, abre, "a referência abre aba própria (preview: false)");
});

// ======================================================= 6 · a seleção sobrevive
//
// Selecionar uma frase abria o popover de trecho, e o popover levava o foco para
// o seu primeiro botão — o que COLAPSA a seleção do documento. Você perdia o
// Ctrl+C e perdia a marca visual do que tinha acabado de selecionar. O foco
// entrar no menu existe por acessibilidade (N10: sem isso o teclado abria um
// menu intocável), então quem decide é o GATILHO: veio do mouse, a seleção fica
// e o foco não se mexe; veio do teclado, o foco entra como antes.

test("ADR-0026 — seleção com o mouse não perde o foco para o popover", () => {
  const src = fnBody("annotOnMouseUp");
  assert.match(src, /keepSelection/, "o gatilho de mouse pede para manter a seleção");
});

test("ADR-0026 — o menu flutuante sabe abrir sem roubar o foco", () => {
  const src = fnSource("wireFloatMenu");
  assert.match(src, /opts\s*(=|\)|,)/, "wireFloatMenu aceita opções");
  const focusLine = /if \(first && [^)]*focus[^)]*\)|opts\.focus === false|noFocus/;
  assert.match(src, focusLine, "e o foco é condicional, não incondicional");
});

test("ADR-0026 — o caminho de teclado continua entrando no menu", () => {
  const src = fnBody("promptAnnotateExcerpt");
  assert.doesNotMatch(src, /keepSelection/, "o trecho ditado por teclado ainda leva o foco ao menu");
});

// O contrato entre o Rust e o JS: o nome do campo. Os dois lados estavam
// testados — a função pura desenhava, o renderSidebar chamava — e mesmo assim
// nada aparecia na tela, porque o backend serializava `entry_docs` e o leitor
// pedia `entryDocs`. Um teste de cada lado não vê o vão entre eles.
test("ADR-0026 — o campo que o backend envia é o campo que a tela lê", () => {
  const RS = fs.readFileSync(path.join(SRC, "..", "src-tauri", "src", "lib.rs"), "utf8");
  const decl = /#\[serde\(rename = "([^"]+)"\)\]\s*\n\s*entry_docs/.exec(RS);
  assert.ok(decl, "o campo declara explicitamente a chave JSON");
  const key = decl[1];
  assert.match(fnBody("renderSidebar"), new RegExp("st\\." + key + "\\b"),
    `a tela lê st.${key} — a mesma chave que o backend envia`);
});

// ======================================================= 7 · chegar no ponto
//
// Citar um ponto em aberto só vale se o clique ATERRISSA nele. O fragmento
// (`…/context.md#cancelamento-cdc`) era descartado no caminho: o documento abria
// no topo e a pessoa procurava de novo, com o olho, o que o link já sabia.

test("ADR-0026 — a referência com âncora rola até o ponto", () => {
  const src = fnBody("onRefClick");
  assert.match(src, /#/, "o fragmento é lido");
  assert.match(src, /revealAnchor|scrollIntoView/, "e vira rolagem até o alvo");
});

test("ADR-0026 — a âncora é procurada no documento, sem inventar seletor", () => {
  const { revealAnchor } = loadPure(["revealAnchor"]);
  assert.strictEqual(typeof revealAnchor, "function");
  const body = fnBody("revealAnchor");
  assert.match(body, /getElementById|querySelector/, "procura o id que o renderer escreveu");
  assert.match(body, /prefers-reduced-motion|reduced/, "respeita quem pediu menos movimento");
});

// ======================================================= 8 · o verbete grifa
//
// Clicar num verbete abria o documento no topo e devolvia a busca para o olho:
// o índice sabia QUAL palavra você procurava e não dizia onde ela estava. Agora
// o clique leva o termo junto, o trecho é grifado por 10s e a tela rola até ele.

test("ADR-0026 — o verbete leva o termo junto do caminho", () => {
  const { indexSurfaceHtml } = loadPure(["indexSurfaceHtml", "locatorLabel"]);
  const html = indexSurfaceHtml([
    { term: "cancelamento", entries: [{ rel: "contexts/assinatura/context.md", context: "assinatura", locator: "§2" }] },
  ]);
  assert.match(html, /data-term="cancelamento"/, "o clique sabe qual palavra procurar");
  assert.match(html, /data-path="acervo:\/\/contexts\/assinatura\/context\.md"/);
});

test("ADR-0026 — o grifo dura 10s e some sozinho", () => {
  const body = fnBody("highlightTerm");
  assert.match(body, /10000|10_000/, "dez segundos, como pedido");
  assert.match(body, /remove|classList/, "e a marca sai depois — não fica pintando o documento");
  assert.match(body, /scrollIntoView/, "a tela vai até o trecho");
});

test("ADR-0026 — o grifo não reescreve o texto do autor", () => {
  const body = fnBody("highlightTerm");
  assert.doesNotMatch(body, /innerHTML\s*=/, "mexer no innerHTML do documento apagaria anotação e link");
  assert.match(body, /createTreeWalker|TEXT_NODE|nodeValue/, "anda nos nós de texto e envolve o trecho");
});
