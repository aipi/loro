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

test("every err code has both pt and en messages", () => {
  for (const key of Object.keys(ERR_PT)) {
    assert.ok(key.startsWith("err."), `${key} is not an err code`);
    assert.ok(EN[key], `missing EN message for ${key}`);
  }
});
