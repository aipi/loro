// DESIGN.md §4 as a test: the internal terms survive in code, IPC and on disk,
// and STOP being a prerequisite for using the app.
//
//   acervo → projeto · brainstorming → ideias · fila → para organizar ·
//   contextos → conhecimento
//
// B7 (found by driving the app): the retired words were still on the first
// screens a new user sees — the header chip said "acervo", the new-idea input
// asked for the "nome do brainstorming", the NOVA REUNIÃO sheet labelled its one
// required field "brainstorming", the document crumb said "documento do acervo",
// Organizar's footer counted "itens na fila" and a chat chip offered to
// "perguntar ao acervo". The ⋯ menu of an idea was titled with the raw slug
// instead of the name the user typed.
//
// This test reads the SOURCE (like wizard.test.js): a retired term must not
// appear inside any user-visible string, and every replacement needs its English
// pair. Identifiers, IPC command names, paths and comments are untouched — only
// what reaches the screen.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
const APP = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const { EN } = require("../src/i18n.js");

// every literal msgid the app renders: t("…") / t('…')
function msgids() {
  const out = new Set();
  for (const m of APP.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"\s*[,)]/g)) out.add(m[1]);
  for (const m of APP.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'\s*[,)]/g)) out.add(m[1]);
  return [...out];
}

// A palavra retirada não pode aparecer em NENHUMA string que o usuário lê. As
// exceções são nomes de coisas no disco (a explicação da pasta do projeto) e os
// seletores de CSS que passam por t() por acidente de escrita.
const RETIRED = [
  [/\bacervos?\b/i, "acervo → projeto"],
  [/\bbrainstormings?\b/i, "brainstorming → ideias"],
  [/\bfila\b/i, "fila → para organizar"],
];
const SELECTOR = /^[#[.]/; // t("#acervoSwitch"), t("[data-rmacervo]") — não são texto

test("B7 — nenhum msgid do app.js carrega um termo interno retirado", () => {
  const sujos = [];
  for (const id of msgids()) {
    if (SELECTOR.test(id)) continue;
    for (const [re, regra] of RETIRED) if (re.test(id)) sujos.push(`${regra}: "${id}"`);
  }
  assert.deepStrictEqual(sujos.sort(), [], "vocabulário interno na tela:\n  " + sujos.sort().join("\n  "));
});

test("B7 — o chip do cabeçalho nasce e permanece 'projeto'", () => {
  const m = HTML.match(/<span id="acervoName"[^>]*>([^<]*)</);
  assert.ok(m, "o chip do projeto continua no cabeçalho");
  assert.equal(m[1], "projeto", "antes de carregar um projeto o chip dizia 'acervo'");
  assert.match(APP, /B\.acervoName\.textContent = cur \? cur\.name : t\("projeto"\)/);
});

test("B7 — o ⋯ de uma ideia é titulado com o nome que o usuário digitou", () => {
  const m = APP.match(/function openBsMenu\(slug, anchor\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, "app.js deve definir openBsMenu()");
  assert.match(m[1], /pessoalRawTemas/, "o slug cru ('PLATAFORMA-DE-PAGAMENTOS') não é o nome da ideia");
  assert.ok(!/<div class="fhead">\$\{esc\(slug\)\}/.test(m[1]),
    "o cabeçalho do menu não pode ser o slug");
});

test("B7 — o campo obrigatório de NOVA REUNIÃO é rotulado no vocabulário da UI", () => {
  const m = APP.match(/allowLoose \? t\("onde salvar"\) : ([^}]+)\}/);
  assert.ok(m, "o rótulo do campo continua no montador da folha");
  assert.match(m[1], /t\("ideia"\)/, "estava escrito 'brainstorming' cru, sem tradução");
  assert.ok(EN["ideia"], "sem par em inglês: ideia");
});

test("B7 — o rodapé de Organizar conta no vocabulário do destino", () => {
  const body = APP.match(/function renderDestOrganize\(st, n\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(body);
  assert.match(body[1], /itens para organizar/);
  assert.match(body[1], /nada para organizar/);
});

test("B7 — toda substituição tem par em inglês", () => {
  const novos = [
    "itens para organizar", "item para organizar", "nada para organizar",
    "documento do projeto", "Perguntar ao projeto", "ideia",
    "nome da ideia (Enter) · ex.: frota 2026", "ações da ideia",
    "nenhuma ideia ainda — crie a primeira para reunir reuniões e notas",
    "nenhuma ideia encontrada para", "crie uma ideia primeiro", "Renomear ideia",
    "enviar para organizar", "tudo para organizar",
    "arquivos para organizar", "arquivo para organizar",
    "o projeto é versionado e vai para o git",
  ];
  const faltando = novos.filter((k) => !EN[k] || EN[k] === k);
  assert.deepStrictEqual(faltando, [], "sem par em inglês:\n  " + faltando.join("\n  "));
});

// ---------------------------------------------------------------------------
// Rodada 2 (C10/C11/C12/C31) — a varredura acima olhava TRÊS palavras e só os
// literais `t("…")` do app.js. Os críticos acharam o resto do contrato:
//
//   C10 — o rótulo de uma habilidade chega a t() por VARIÁVEL (TOOL_LABELS), e
//         por isso "perguntar ao acervo" seguia no chip de todas as telas;
//   C11 — o context.md que o produto GERA abria com "Evolui por RFC (branch +
//         PR) revisada pelos donos do contexto" — jargão retirado como primeira
//         linha do conteúdo que o usuário lê;
//   C12 — versionar / rfc/ / Pull Request / commit / promover sobreviviam nas
//         telas de salvar versão, enviar para revisão e juntar a um conhecimento;
//   C31 — o manual (a única instrução que acompanha o app) ensinava
//         "brainstorming" e "fila" como nome primário.
//
// O MECANISMO não muda (ADR-0001 §5: a RFC é o PR, o commit é o commit) — muda
// como ele é DITO ao usuário.
const RETIRED2 = [
  [/\bversionar\b/i, 'versionar → "salvar versão"'],
  [/\bcommit/i, 'commit → "salvar versão"'],
  [/\brfcs?\b/i, 'RFC → "enviar para revisão do time"'],
  [/pull request/i, 'Pull Request → "enviar para revisão do time"'],
  [/\bPRs?\b/, 'PR → "enviar para revisão do time"'],
  [/\bpromo(v|ç)/i, 'promover → "juntar a um conhecimento"'],
  [/\bcontextos?\b/i, "contexto → conhecimento (um deles: tema)"],
  [/\bstaged?\b/i, "staged → o que será juntado"],
];

test("C12 — nenhum msgid do app.js diz versionar, rfc, commit, PR ou promover", () => {
  const sujos = [];
  for (const id of msgids()) {
    if (SELECTOR.test(id)) continue;
    for (const [re, regra] of RETIRED2) if (re.test(id)) sujos.push(`${regra}: "${id}"`);
  }
  assert.deepStrictEqual(sujos.sort(), [], "vocabulário retirado na tela:\n  " + sujos.sort().join("\n  "));
});

// O aviso de sucesso do envio para revisão era montado em template literal
// (`PR #12 aberto`), e o título de reserva do pedido era a sigla crua ("RFC") —
// os dois fora do alcance da varredura de msgids. O usuário clicava no botão com
// o nome certo e o app respondia com a palavra retirada.
test("C12 — o fluxo de enviar para revisão não nomeia o mecanismo", () => {
  const m = APP.match(/B\.proposeBtn\.addEventListener\("click", \(\) => \{([\s\S]*?)\n\}\);/);
  assert.ok(m, "o botão de enviar para revisão continua ligado");
  const sujos = [];
  for (const [re, regra] of RETIRED2) if (re.test(m[1])) sujos.push(regra);
  assert.deepStrictEqual(sujos.sort(), [],
    "termo retirado no fluxo de enviar para revisão:\n  " + sujos.sort().join("\n  "));
});

// O ⓘ da pasta do projeto é a PRIMEIRA tela: ele nomeia as pastas que existem no
// disco (isso é o disco, e fica), mas explicava cada uma com a palavra retirada
// — "inbox/ (a fila do que chega)" — e pedia a ação pelo verbo antigo, "dá para
// versionar com git". A explicação pertence ao vocabulário da tela.
test("C12 — o ⓘ da pasta do projeto explica o disco no vocabulário da tela", () => {
  const m = HTML.match(/<p id="wizDirInfoBody"[^>]*>([\s\S]*?)<\/p>/);
  assert.ok(m, "o detalhe da pasta continua no assistente");
  const msgid = m[1].trim();
  const prosa = msgid.replace(/[a-z_]+\//g, ""); // os nomes de pasta no disco não são vocabulário de tela
  const sujos = [];
  for (const [re, regra] of [...RETIRED, ...RETIRED2]) if (re.test(prosa)) sujos.push(regra);
  assert.deepStrictEqual(sujos.sort(), [],
    "termo retirado na explicação da pasta:\n  " + sujos.sort().join("\n  "));
  assert.ok(EN[msgid] && EN[msgid] !== msgid, "sem par em inglês para a explicação da pasta");
});

// O rótulo de uma habilidade é `t(TOOL_LABELS[f.name])`: uma variável, invisível
// para a varredura de literais — foi exatamente aí que "perguntar ao acervo"
// sobreviveu a uma rodada inteira de limpeza.
function toolLabels() {
  const m = APP.match(/const TOOL_LABELS = \{([\s\S]*?)\n\};/);
  assert.ok(m, "app.js deve definir TOOL_LABELS");
  const out = {};
  for (const r of m[1].matchAll(/"([^"]+)":\s*"([^"]+)"/g)) out[r[1]] = r[2];
  return out;
}

test("C10 — nenhum rótulo de habilidade carrega um termo interno", () => {
  const sujos = [];
  for (const [file, label] of Object.entries(toolLabels())) {
    for (const [re, regra] of [...RETIRED, ...RETIRED2]) {
      if (re.test(label)) sujos.push(`${file} → "${label}" (${regra})`);
    }
  }
  assert.deepStrictEqual(sujos.sort(), [], "termo interno no rótulo de uma habilidade:\n  " + sujos.sort().join("\n  "));
});

test("C10 — toda habilidade padrão tem rótulo, e todo rótulo tem par em inglês", () => {
  const labels = toolLabels();
  // um `loro-*.md` sem rótulo aparece na tela como o nome do arquivo cru
  const builtins = APP.match(/const TOOL_BUILTINS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(builtins, "app.js deve declarar TOOL_BUILTINS");
  // loro-sync é a exceção: o rótulo dela é montado com a FONTE ("sincronizar: drive")
  const semRotulo = [...builtins[1].matchAll(/"([^"]+\.md)"/g)].map((m) => m[1])
    .filter((f) => f !== "loro-sync.md" && !labels[f]);
  assert.deepStrictEqual(semRotulo, [], "habilidade padrão sem rótulo (o usuário vê o nome do arquivo):\n  " + semRotulo.join("\n  "));
  const semPar = Object.values(labels).filter((l) => !EN[l] || EN[l] === l);
  assert.deepStrictEqual(semPar, [], "rótulo sem par em inglês (a mesma habilidade aparece nos dois idiomas):\n  " + semPar.join("\n  "));
});

test("C10 — a habilidade de perguntar tem UM nome, não três", () => {
  const labels = toolLabels();
  const chip = labels["loro-ask.md"];
  assert.ok(chip, "loro-ask continua sendo uma habilidade rotulada");
  const pal = APP.match(/label: "([^"]+)", code: "KeyQ"/);
  assert.ok(pal, "a paleta continua oferecendo a pergunta");
  assert.equal(pal[1].toLowerCase(), chip.toLowerCase(),
    "chip, lateral e paleta chamavam a MESMA ação de três nomes diferentes");
  // e a lateral usa o rótulo, não o nome do arquivo (`loro-ask`)
  const row = APP.match(/function toolRow\(f\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(row);
  assert.match(row[1], /habilidadeLabel\(/, "a lateral mostrava o nome do arquivo cru");
});

// C11 — o context.md é o PRODUTO: é o que o usuário abre em Conhecimento. A
// primeira linha dele não pode ser o mecanismo interno.
const TAURI = path.join(__dirname, "..", "src-tauri");
function seededContextDocs() {
  const docs = [];
  const rs = fs.readFileSync(path.join(TAURI, "src", "templates.rs"), "utf8");
  for (const m of rs.matchAll(/pub const CONTEXT_TEMPLATE(?:_EN)?: &str = "([\s\S]*?)";\n/g)) {
    docs.push(["templates.rs:CONTEXT_TEMPLATE", m[1]]);
  }
  assert.equal(docs.length, 2, "os dois moldes de context.md (pt/en) continuam em templates.rs");
  const tplDir = path.join(TAURI, "templates");
  for (const pack of fs.readdirSync(tplDir)) {
    for (const lang of ["pt", "en"]) {
      const f = path.join(tplDir, pack, lang, "context.md");
      if (fs.existsSync(f)) docs.push([`templates/${pack}/${lang}`, fs.readFileSync(f, "utf8")]);
    }
  }
  assert.ok(docs.length > 10, `esperava os moldes das verticais, achei ${docs.length}`);
  return docs;
}

test("C11 — o conhecimento que o produto semeia não abre com jargão retirado", () => {
  const sujos = [];
  for (const [nome, doc] of seededContextDocs()) {
    for (const re of [/\bRFCs?\b/, /Pull Request/i, /\bPRs?\b/, /branch/i]) {
      const hit = re.exec(doc);
      if (hit) sujos.push(`${nome}: "${hit[0]}"`);
    }
  }
  assert.deepStrictEqual(sujos.sort(), [],
    "o documento que o usuário lê ensina o mecanismo interno:\n  " + sujos.sort().join("\n  "));
});

test("C11 — o molde continua sendo o mesmo documento (seções intactas)", () => {
  for (const [nome, doc] of seededContextDocs()) {
    assert.match(doc, /Hotspots|Hotspot/, `${nome}: a seção de hotspots é a estrutura do molde`);
    assert.match(doc, /!HOTSPOT/, `${nome}: o marcador que o loop escreve`);
  }
});

// C31 — o manual é a ÚNICA instrução que acompanha o app. Ele mandava o usuário
// procurar uma seção "Brainstorming" e uma "fila" que a tela não tem.
function manualProse(file) {
  const raw = fs.readFileSync(path.join(SRC, file), "utf8");
  return raw
    .split("\n")
    // a tabela "Na tela | No disco" existe para ensinar o mapeamento: é a única
    // linha onde o termo interno é o assunto
    .filter((l) => !/^\s*\|/.test(l))
    // caminhos e nomes de pasta no disco (`brainstorming/<slug>/`) são o disco
    .map((l) => l.replace(/`[^`]*`/g, ""))
    .join("\n");
}

test("C31 — o manual não ensina o termo interno como nome primário", () => {
  for (const [file, termos] of [
    ["manual.pt.md", [/\bbrainstormings?\b/i, /\bfila\b/i, /\bacervos?\b/i, /\bcontextos?\b/i, /\bRFCs?\b/, /Pull Request/i, /\bversionar\b/i, /\bpromov/i]],
    ["manual.en.md", [/\bbrainstormings?\b/i, /\bqueue\b/i, /\bRFCs?\b/, /Pull Request/i]],
  ]) {
    const prose = manualProse(file);
    const sujos = [];
    for (const re of termos) {
      for (const m of prose.matchAll(new RegExp(re.source, re.flags.includes("i") ? "gi" : "g"))) {
        const line = prose.slice(0, m.index).split("\n").length;
        sujos.push(`${file}:${line} "${m[0]}"`);
      }
    }
    assert.deepStrictEqual(sujos.slice(0, 12), [],
      `o manual manda procurar um controle que a tela não tem:\n  ${sujos.join("\n  ")}`);
  }
});

test("C31 — o manual nomeia os controles com o rótulo que está na tela", () => {
  const pt = fs.readFileSync(path.join(SRC, "manual.pt.md"), "utf8");
  // rótulos reais, lidos do próprio index.html/app.js
  for (const label of ["Transformar em conhecimento", "para organizar", "Salvar versão", "Nova ideia"]) {
    assert.ok(pt.includes(label), `o manual não cita o controle "${label}" como ele aparece na tela`);
  }
  assert.ok(!/## Brainstorming/i.test(pt), "a seção tinha o nome interno no título");
});

// B9 — "enviar tudo para organi…" truncava no meio da palavra dentro do menu de
// uma ideia. O rótulo é o que cabe; a largura do menu é CSS.
test("B9 — o item do menu não é mais longo do que a caixa do menu", () => {
  const m = APP.match(/function openBsMenu[\s\S]*?data-toqueue[^`]*`/);
  assert.ok(m, "o item de enviar tudo continua no menu da ideia");
  const label = /t\("([^"]+)"\)/.exec(m[0].slice(m[0].indexOf("data-toqueue")));
  assert.ok(label, "o item tem rótulo traduzido");
  assert.ok(label[1].length <= 22, `rótulo longo demais para o menu (${label[1].length} caracteres): ${label[1]}`);
});

// ============================================================ critic round 4
// N7 — a varredura acima lê t("…") no app.js, os msgids do index.html e os
// TOOL_LABELS. Nunca leu o DICIONÁRIO DE ERROS, que é texto de tela como
// qualquer outro: 26 das 111 mensagens carregavam um termo retirado, em pt e em
// inglês, e a suíte passava verde. As do fluxo de colaboração eram as piores —
// falavam branch, main, origin e "clique em Versionar", um controle que não
// existe (o botão é "Salvar versão do projeto").
const { ERR_PT } = require("../src/i18n.js");

// "branch", "main" e "origin" nunca foram palavras do produto; "versionar" e
// "acervo/brainstorming/fila" foram aposentadas em DESIGN.md §4.
const RETIRED_ERR = [
  [/\bacervos?\b/i, "acervo → projeto"],
  [/\bbrainstormings?\b/i, "brainstorming → ideias"],
  [/\bfila\b/i, "fila → Organizar"],
  [/\bbranch(es)?\b/i, "branch → rascunho / conhecimento oficial"],
  [/\bmain\b/i, "main → conhecimento oficial"],
  [/\borigin\b/i, "origin → repositório do time"],
  [/\bversionar\b/i, "Versionar → salvar versão"],
  [/\bcommits?\b/i, "commit → versão"],
  [/\bpull request/i, "pull request → revisão do time"],
];

test("N7 — nenhuma mensagem de erro em pt-BR carrega um termo retirado", () => {
  const sujos = [];
  for (const [code, msg] of Object.entries(ERR_PT)) {
    for (const [re, regra] of RETIRED_ERR) if (re.test(msg)) sujos.push(`${regra} — ${code}: "${msg}"`);
  }
  assert.deepStrictEqual(sujos.sort(), [],
    "vocabulário interno num toast de erro:\n  " + sujos.sort().join("\n  "));
});

test("N7 — nem a versão em inglês da mesma mensagem", () => {
  const sujos = [];
  for (const code of Object.keys(ERR_PT)) {
    const msg = EN[code];
    assert.ok(msg, `código sem par em inglês: ${code}`);
    for (const [re, regra] of RETIRED_ERR) if (re.test(msg)) sujos.push(`${regra} — ${code}: "${msg}"`);
  }
  assert.deepStrictEqual(sujos.sort(), [],
    "vocabulário interno num toast de erro (en):\n  " + sujos.sort().join("\n  "));
});

test("N7 — um erro não manda clicar num controle que não está na tela", () => {
  // "clique em Versionar primeiro" nomeava um botão que se chama outra coisa.
  const rotulos = new Set([...HTML.matchAll(/<button[^>]*data-i18n>([^<]+)</g)].map((m) => m[1].trim()));
  assert.ok(rotulos.has("Salvar versão do projeto"), "o rótulo real do controle continua no HTML");
  const sujos = [];
  for (const [code, msg] of Object.entries(ERR_PT)) {
    const m = /clique em ([A-ZÀ-Ú][^\s,.:;]*)/.exec(msg);
    if (m && !rotulos.has(m[1])) sujos.push(`${code}: manda clicar em “${m[1]}”`);
  }
  assert.deepStrictEqual(sujos, [], sujos.join("\n  "));
});
