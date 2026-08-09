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
