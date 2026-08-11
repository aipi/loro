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
  setLang("pt");
  assert.equal(tErr("err.acervo_not_found"), "acervo não encontrado");
  setLang("en");
  assert.equal(tErr("err.acervo_not_found"), "knowledge base not found");
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
  for (const m of html.matchAll(/<[^>]*\bdata-i18n-attrs="([^"]+)"[^>]*>/g)) {
    for (const attr of m[1].split(",").map((x) => x.trim())) {
      const v = new RegExp(attr + '="([^"]+)"').exec(m[0]);
      if (v && !(v[1] in EN)) faltando.add(`${attr}: ${v[1]}`);
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
