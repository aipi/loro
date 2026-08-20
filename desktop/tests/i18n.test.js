// i18n module — gettext-style: the pt-BR string in the code IS the msgid;
// EN holds the translations. Backend errors arrive as stable "err.*" codes.
const test = require("node:test");
const assert = require("node:assert");
const { t, tErr, setLang, getLang, EN, ERR_PT } = require("../src/i18n.js");

test("t returns the msgid itself in pt (source language)", () => {
  setLang("pt");
  assert.equal(t("configurações"), "configurações");
  assert.equal(t("string desconhecida"), "string desconhecida");
});

test("t translates to en and falls back to the msgid when missing", () => {
  setLang("en");
  assert.equal(t("configurações"), "settings");
  assert.equal(t("string sem tradução"), "string sem tradução");
  setLang("pt");
});

test("setLang normalizes unknown languages to pt", () => {
  setLang("fr");
  assert.equal(getLang(), "pt");
  setLang("en");
  assert.equal(getLang(), "en");
  setLang("pt");
});

test("tErr translates backend error codes in both languages", () => {
  // N7 · a amostra segue o vocabulário da tela (DESIGN.md §4): "acervo" saiu do
  // dicionário de erros junto com branch/main/origin.
  setLang("pt");
  assert.equal(tErr("err.acervo_not_found"), "projeto não encontrado");
  setLang("en");
  assert.equal(tErr("err.acervo_not_found"), "project not found");
  setLang("pt");
});

test("tErr interpolates the detail after the first colon", () => {
  setLang("pt");
  assert.equal(
    tErr("err.model_not_found:/tmp/x.bin"),
    "modelo não encontrado: /tmp/x.bin"
  );
  // detail appended when the message has no {detail} placeholder
  assert.equal(tErr("err.invalid_name:abc"), "nome inválido: abc");
  setLang("pt");
});

test("tErr passes through unknown codes and plain messages", () => {
  setLang("pt");
  assert.equal(tErr("err.unknown_thing"), "err.unknown_thing");
  assert.equal(tErr("Operation not permitted (os error 1)"), "Operation not permitted (os error 1)");
  assert.equal(tErr(""), "");
});

test("a missing agent command names the command and never an errno", () => {
  // ADR-0030 — o que a pessoa lia era "No such file or directory (os error 2)".
  // A mensagem tem de dizer QUAL comando faltou e o que fazer, nos dois idiomas.
  for (const lang of ["pt", "en"]) {
    setLang(lang);
    const msg = tErr("err.agent_not_found:claude");
    assert.ok(msg.includes("claude"), `${lang}: não nomeia o comando: ${msg}`);
    assert.ok(!msg.includes("os error"), `${lang}: vazou errno: ${msg}`);
    assert.ok(!msg.startsWith("err."), `${lang}: código não traduzido: ${msg}`);
  }
  setLang("pt");
});

test("ffmpeg error renders the platform install hint from the detail", () => {
  // o backend manda o comando certo do SO no detail, então a mesma mensagem
  // serve para macOS e Windows sem citar Homebrew no lugar errado
  setLang("pt");
  assert.equal(
    tErr("err.ffmpeg_not_found:winget install Gyan.FFmpeg"),
    "ffmpeg não encontrado. Instale (winget install Gyan.FFmpeg)."
  );
  setLang("en");
  assert.equal(
    tErr("err.ffmpeg_not_found:brew install ffmpeg"),
    "ffmpeg not found. Install it (brew install ffmpeg)."
  );
  setLang("pt");
});

test("every err code has both pt and en messages", () => {
  for (const key of Object.keys(ERR_PT)) {
    assert.ok(key.startsWith("err."), `${key} is not an err code`);
    assert.ok(EN[key], `missing EN message for ${key}`);
  }
});

// T-9 (#44) — todo msgid REALMENTE USADO no app tem par em inglês. A primeira
// versão deste teste iterava as chaves de EN e checava que os valores não eram
// vazios: isso valida a tabela contra si mesma e deixa passar exatamente o buraco
// que ele diz fechar — um t("string nova") sem entrada em EN.
const fs = require("node:fs");
const path = require("node:path");

// O msgid capturado do FONTE vem escapado (`\\n` são dois caracteres); a chave do
// mapa é a string já interpretada. Sem desescapar, toda msgid com quebra de linha
// parecia faltando — foi o que aconteceu na primeira versão deste teste.
function unescapeJs(s) {
  return s.replace(/\\(n|t|r|"|'|\\)/g, (_, c) =>
    ({ n: "\n", t: "\t", r: "\r" }[c] || c));
}

function usedMsgids(file) {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8");
  const out = new Set();
  // t("literal") / t('literal') — só literais; t(variavel) não é verificável
  for (const m of src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"\s*[,)]/g)) out.add(unescapeJs(m[1]));
  for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'\s*[,)]/g)) out.add(unescapeJs(m[1]));
  return out;
}

// #49 — a dívida foi paga: nenhum msgid usado no app.js fica sem par. O teste
// é o que impede ela de voltar, e foi ele que a encontrou (a primeira versão
// iterava as chaves de EN e validava a tabela contra si mesma).
test("every msgid used in app.js has an English pair", () => {
  const faltando = [...usedMsgids("app.js")]
    .filter((k) => k && !k.startsWith("err.") && !(k in EN))
    .sort();
  assert.deepStrictEqual(faltando, [], "msgids sem par em inglês:\n  " + faltando.join("\n  "));
});

test("os msgids da move de reunião existem e têm par", () => {
  for (const k of ["Mover reunião", "movida", "mover para…", "destino", "mover"]) {
    assert.ok(EN[k] && EN[k].trim(), `sem par em inglês: ${k}`);
  }
});

// #44 rodada 3 — o teste acima itera ERR_PT, então um código que o backend emite
// e que ninguém cadastrou passava despercebido: o usuário via `err.foo` cru no
// toast. Este varre os `err.*` do Rust e exige par nos dois mapas.
test("every err.* emitted by the backend is translated", () => {
  const dir = path.join(__dirname, "..", "src-tauri", "src");
  const codigos = new Set();
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".rs"))) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of src.matchAll(/"(err\.[a-z0-9_]+)/g)) codigos.add(m[1]);
  }
  const semPar = [...codigos].filter((c) => !(c in ERR_PT) || !(c in EN)).sort();
  assert.deepStrictEqual(semPar, [], "códigos sem tradução:\n  " + semPar.join("\n  "));
});

// C9 — os checks de ambiente (Versões e GitHub) mandam a dica em DOIS formatos
// no mesmo campo: um código `err.*` estável e uma frase pt-BR (que é o msgid).
// A tela imprimia o campo cru: a linha que diz o que falta para conectar o
// GitHub aparecia como `err.git_remote_required`, e as frases nunca traduziam.
test("C9 — toda dica dos checks de ambiente tem tradução nos dois idiomas", () => {
  const rs = fs.readFileSync(path.join(__dirname, "..", "src-tauri", "src", "lib.rs"), "utf8");
  const doctor = rs.match(/fn env_doctor_blocking\(\) -> EnvDoctor \{([\s\S]*?)\n\}/);
  assert.ok(doctor, "lib.rs deve definir env_doctor_blocking()");
  const dicas = [...doctor[1].matchAll(/hint: if[\s\S]*?\n\s*\},/g)]
    .flatMap((b) => [...b[0].matchAll(/"([^"]+)"\.into\(\)/g)].map((m) => m[1]));
  assert.ok(dicas.length >= 5, `esperava as dicas dos checks, achei ${dicas.length}`);
  const semPar = dicas.filter((d) => (d.startsWith("err.")
    ? !(d in ERR_PT) || !(d in EN)
    : !EN[d] || EN[d] === d));
  assert.deepStrictEqual(semPar, [],
    "dica que chega crua (ou sem inglês) à tela:\n  " + semPar.join("\n  "));
});

test("C9 — a tela traduz a dica em vez de imprimir o campo cru", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  const card = app.match(/function renderGhCard\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(card, "app.js deve definir renderGhCard()");
  assert.ok(!/c\.detail \|\| c\.hint/.test(card[1]),
    "o campo cru chegava à tela como `err.git_remote_required`");
  // N4 · a decisão do que a linha DIZ virou uma função só (checkSay), que é
  // quem chama o tradutor: a linha imprime valor E motivo, não um ou outro.
  assert.match(card[1], /checkSay\(c\)/, "a linha passa por um único decisor");
  const say = app.match(/function checkSay\(c\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(say, "app.js deve definir checkSay()");
  assert.match(say[1], /checkHint\(/, "a dica passa por um tradutor único");
  const fn = app.match(/function checkHint\(hint\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fn, "app.js deve definir checkHint()");
  assert.match(fn[1], /tErr\(/, "um código err.* é traduzido por tErr");
  assert.match(fn[1], /\bt\(/, "uma frase pt-BR é um msgid: passa por t()");
});

// T-11 · AC-4 (ADR-0018) — o relatório de reunião não pode mais ser nomeado por
// nenhuma string viva, e todo msgid novo tem par em inglês.
test("nenhum msgid vivo nomeia um relatório de reunião", () => {
  const mortos = [
    "abra uma reunião para gerar o relatório",
    "Abre o relatório desta reunião (resumo, decisões, dúvidas, investigações).",
    "abrir relatório",
    "não montei o relatório",
    "relatório pronto",
    "ver relatório",
  ];
  for (const m of mortos) {
    assert.ok(!(m in EN), `msgid removido ainda presente: ${m}`);
  }
  // as strings sobreviventes que FALAVAM de relatório foram reescritas
  for (const [pt, en] of Object.entries(EN)) {
    if (!/reuni[ãa]o|meeting/i.test(pt + " " + en)) continue;
    assert.ok(!/relat[óo]rio|\breport\b/i.test(pt + " " + en),
      `uma string de reunião ainda nomeia relatório: ${pt}`);
  }
});

test("os msgids novos da ADR-0018 têm par em inglês", () => {
  for (const m of [
    "reunião encerrada — quer analisar agora?",
    "agora não",
    "analise a reunião antes de enviar para a fila",
    "não encerrei a reunião",
    "analisar e enviar para a fila ficam disponíveis quando a reunião terminar — perguntar já funciona agora",
  ]) {
    assert.ok(EN[m] && EN[m] !== m, `sem par em inglês: ${m}`);
  }
});

// #52 — o teste acima só varre app.js, mas METADE dos msgids vive no index.html
// (`data-i18n` no texto, `data-i18n-attrs` em title/placeholder/aria-label). Eram
// invisíveis para a suíte: passavam sem par e apareciam em português com a UI em
// inglês. Este teste varre o HTML do mesmo jeito que o aplicador de i18n varre o
// DOM — o msgid é o TEXTO do elemento (o valor de `data-i18n=` é ignorado por
// ele, e portanto aqui também).
test("todo msgid do index.html tem par em inglês", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");
  const faltando = new Set();
  // `data-i18n` e `data-i18n="chave"`: o aplicador IGNORA o valor e usa o texto
  // do elemento nos dois casos, então os dois entram — excluir a forma com valor
  // foi o furo que deixou "Armazenamento" passar sem par.
  for (const m of html.matchAll(/<([a-z0-9]+)\b([^>]*\bdata-i18n\b(?!-)[^>]*)>([^<]*)</gi)) {
    const txt = m[3].trim();
    if (txt && !(txt in EN)) faltando.add(txt);
  }
  // N19 · aqui o varredor repetia a premissa do aplicador (separar só por
  // vírgula) e, pior, PULAVA em silêncio o token que não casasse: com
  // `data-i18n-attrs="aria-label title"` a busca virava /aria-label title="…"/,
  // não casava nada, e um nome acessível sem par passava como traduzido — a
  // mesma premissa que derrubava o boot (N1). Agora separa por vírgula OU
  // espaço e RECLAMA do token que não nomeie um atributo do elemento: um
  // pulo em silêncio é um falso "está tudo traduzido".
  for (const m of html.matchAll(/<[^>]*\bdata-i18n-attrs="([^"]+)"[^>]*>/g)) {
    for (const attr of m[1].split(/[,\s]+/).map((x) => x.trim())) {
      if (!attr) continue;
      const v = new RegExp("\\b" + attr + '="([^"]*)"').exec(m[0]);
      if (!v) { faltando.add(`${attr}: atributo declarado e ausente do elemento`); continue; }
      if (v[1] && !(v[1] in EN)) faltando.add(`${attr}: ${v[1]}`);
    }
  }
  assert.deepStrictEqual([...faltando].sort(), [],
    "msgids do index.html sem par em inglês:\n  " + [...faltando].sort().join("\n  "));
});

// O varredor acima só serve se casar com TODO `data-i18n` do arquivo: um
// atributo que ele deixasse escapar viraria um falso "está tudo traduzido".
test("o varredor do index.html não deixa nenhum data-i18n de fora", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");
  // O total conta a forma NUA e a forma COM VALOR (`data-i18n="storage"`); o
  // varredor tem de casar as duas. Contar o mesmo padrão dos dois lados deixaria
  // o teste sempre verde — foi o que aconteceu, e "Armazenamento" passou.
  const total = (html.match(/\bdata-i18n(?!-)/g) || []).length;
  const casados = [...html.matchAll(/<([a-z0-9]+)\b([^>]*\bdata-i18n\b(?!-)[^>]*)>([^<]*)</gi)].length;
  assert.ok(total > 100, `esperava dezenas de msgids no HTML, achei ${total}`);
  assert.strictEqual(casados, total, `${total - casados} elementos data-i18n não foram varridos`);
});

// ADR-0027 (rodada 2) — um msgid órfão é cromo morto: ele envelhece como verdade
// e mente na próxima leitura (DESIGN.md §9). A mesma diferença que RETIROU dois
// msgids de uma superfície morta ("Revisões abertas", "a revisão acontece no
// GitHub…") acrescentou um terceiro que nenhuma superfície usava — e nada na
// suíte varria o catálogo, então só uma varredura ad-hoc o achou. R11 já guarda
// função sem chamador e estado que ninguém lê; esta é a mesma guarda para o
// catálogo, no bloco que a ADR-0027 construiu. O catálogo inteiro carrega 197
// órfãos anteriores a esta ADR (medidos; registrados na ADR-0027 §rodada 2): a
// dívida é de superfícies que já saíram do app e não se paga às cegas aqui.
test("ADR-0027 — nenhum msgid do destino Revisão fica sem superfície", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "i18n.js"), "utf8");
  const ini = src.indexOf("// ---- ADR-0027 · Revisão");
  const fim = src.indexOf("\n  };", ini);
  assert.ok(ini > 0 && fim > ini, "o bloco da ADR-0027 dentro do mapa EN");
  const bloco = src.slice(ini, fim);
  const cruas = [...bloco.matchAll(/^\s{4}"((?:[^"\\]|\\.)*)":/gm)].map((m) => m[1]);
  assert.ok(cruas.length > 80, `esperava os msgids do destino, achei ${cruas.length}`);
  // ACHADO (rodada 3): a varredura decidia "usado" por SUBSTRING crua, então todo
  // msgid contido em outro era invisível para ela — «verificações ok» casava dentro
  // de `t("✓ verificações ok")`. O bloco está cheio de msgids que são pedaço de um
  // vizinho vivo (`novo`, `enviar`, `responder`, `unificado`, `Resumo`, `sua
  // resposta`), e reescrever uma frase deixando a forma curta atrás é exatamente
  // como um msgid morre. Agora o casamento é do LITERAL INTEIRO: as strings de
  // app.js e os textos/atributos do index.html.
  const usados = new Set();
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  // Duas leituras, porque um msgid mora em dois lugares: solto numa expressão, e
  // como ARGUMENTO dentro de um literal de template (`${t("…")}`) — nesse a
  // varredura de pares de aspas emenda o `"` do HTML com o `"` do argumento e o
  // msgid vira fronteira em vez de conteúdo. A segunda ancora em `(`/`,`, que é
  // onde um argumento começa.
  for (const re of [/"((?:[^"\\\n]|\\.)*)"/g, /'((?:[^'\\\n]|\\.)*)'/g,
    /[(,]\s*"((?:[^"\\\n]|\\.)*)"/g]) {
    for (const m of app.matchAll(re)) usados.add(unescapeJs(m[1]));
  }
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");
  // o texto de um elemento data-i18n É o msgid, e um atributo traduzido é o valor
  // inteiro do atributo (placeholder, title, aria-label)
  for (const m of html.matchAll(/<([a-z0-9]+)\b([^>]*\bdata-i18n\b(?!-)[^>]*)>([^<]*)</gi)) {
    usados.add(m[3].trim());
  }
  for (const m of html.matchAll(/=\s*"([^"]*)"/g)) usados.add(m[1].trim());
  // a varredura só serve se ENCONTRAR as superfícies: um leitor cego diria
  // "órfão" para o catálogo inteiro, e um piso alto é o que denuncia isso
  assert.ok(usados.size > 500, `só ${usados.size} literais lidos — o leitor cegou`);
  const orfaos = cruas.filter((k) => !usados.has(k) && !usados.has(unescapeJs(k)));
  assert.deepStrictEqual(orfaos, [],
    "msgid no catálogo e em nenhuma superfície:\n  " + orfaos.join("\n  "));
});

// #53 (revisão) — o mapa EN é um objeto literal: uma chave repetida não é erro
// de sintaxe, a última vence em silêncio. Foi assim que a Aparência sequestrou
// "tema" (o termo do DOMÍNIO, um tema de brainstorming) e a UI em inglês passou
// a pedir que o usuário escolhesse um "theme" onde queria dizer "topic". Os 235
// testes seguiam verdes: todos perguntam se a chave existe, nenhum se existe
// UMA vez. Este lê o arquivo como texto, porque em objeto já é tarde.
test("nenhuma chave de tradução é declarada duas vezes", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "i18n.js"), "utf8");
  const repetidas = [];
  for (const bloco of src.split(/\n  \w+:\s*\{/).slice(1)) {
    const vistas = new Map();
    for (const m of bloco.matchAll(/^\s{4}"((?:[^"\\]|\\.)*)":/gm)) {
      vistas.set(m[1], (vistas.get(m[1]) || 0) + 1);
    }
    for (const [k, n] of vistas) if (n > 1) repetidas.push(`${k} (${n}×)`);
  }
  assert.deepStrictEqual(repetidas, [], "chaves repetidas — a última vence sem avisar:\n  " + repetidas.join("\n  "));
});

// UMA DATA NA TELA SEGUE O IDIOMA DA INTERFACE. `toLocaleString()` sem
// argumento usa o locale da MÁQUINA, então a interface em inglês num sistema
// pt-BR imprimia "20/08/2026, 12:15" — e isso passou por toda a suíte de i18n,
// que só olha o dicionário. Passou uma vez (update.js, 2026-08-20); o guarda
// existe para não passar de novo. `uiLocale()` em app.js é quem sabe o idioma;
// um módulo isolado recebe o locale de quem o chama.
test("nenhuma data nasce sem locale — a tela fala o idioma da interface", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(__dirname, "..", "src");
  const faltas = [];
  const semLocale = /\.toLocale(?:String|DateString|TimeString)\(\s*[),{]/;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    fs.readFileSync(path.join(dir, f), "utf8").split("\n").forEach((linha, i) => {
      if (semLocale.test(linha)) faltas.push(`${f}:${i + 1} → ${linha.trim()}`);
    });
  }
  assert.deepEqual(faltas, [], "chamada de data sem locale explícito");
});
