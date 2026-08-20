// ADR-0032 — o aviso de versão nova, do lado da tela. O que se testa aqui é o
// que o app AFIRMA: nunca dizer "está atualizado" sem ter olhado, e nunca
// oferecer o comando do Homebrew a quem não instalou por Homebrew.
const test = require("node:test");
const assert = require("node:assert");
const U = require("../src/update.js");
const { t, setLang } = require("../src/i18n.js");

const base = {
  current: "0.13.0",
  latest: "",
  available: false,
  checked: false,
  enabled: true,
  lastCheck: 0,
  route: "download",
  command: "",
  url: "https://github.com/aipi/loro/releases/latest",
};

test("sem atualização o cabeçalho continua sendo a etiqueta de sempre", () => {
  const h = U.headTag(base, t);
  assert.equal(h.text, "v0.13.0");
  assert.equal(h.mark, false);
});

test("com atualização o cabeçalho nomeia a versão nova e vira clicável", () => {
  const h = U.headTag({ ...base, available: true, latest: "0.13.1" }, t);
  assert.equal(h.text, "v0.13.1 disponível");
  assert.equal(h.mark, true);
  assert.match(h.title, /0\.13\.1/);
});

// CLAUDE.md §7.1 — o app só afirma o que mediu. "Não verifiquei" é um terceiro
// estado, e confundi-lo com "está na última versão" é mentir sobre uma medição
// que nunca houve (é o caso de quem desligou a chave, ou abriu sem rede).
test("nunca verificado NÃO é a mesma frase que está na última versão", () => {
  assert.equal(U.statusLine(base, t), "ainda não verificado");
  assert.equal(U.statusLine({ ...base, checked: true }, t), "você está na última versão");
  assert.equal(U.statusLine({ ...base, lastCheck: 1755000000 }, t), "você está na última versão");
  assert.equal(
    U.statusLine({ ...base, available: true, latest: "0.14.0" }, t),
    "há uma versão nova: v0.14.0",
  );
});

// Oferecer `brew upgrade --cask loro` a quem arrastou o .dmg é mandar o usuário
// colher "Cask 'loro' is not installed" no terminal dele.
test("o comando do Homebrew só aparece para quem instalou pelo Homebrew", () => {
  const brew = U.howTo({ ...base, route: "brew", command: "brew upgrade --cask loro" }, t);
  assert.equal(brew.command, "brew upgrade --cask loro");
  const dmg = U.howTo({ ...base, route: "download" }, t);
  assert.equal(dmg.command, "");
  assert.match(dmg.text, /\.dmg/);
});

test("sem consulta nenhuma o carimbo é «nunca», não 1969", () => {
  assert.equal(U.lastCheckLabel(base, t), "nunca verificado");
  const s = U.lastCheckLabel({ ...base, lastCheck: 1755000000 }, t);
  assert.ok(!s.includes("1969"), s);
  assert.match(s, /verificado em /);
});

test("tudo que a tela diz tem par em inglês", () => {
  setLang("en");
  const st = { ...base, available: true, latest: "0.13.1", route: "brew", lastCheck: 1755000000 };
  const said = [
    U.headTag(st, t).text,
    U.headTag(st, t).title,
    U.headTag(base, t).title,
    U.statusLine(st, t),
    U.statusLine(base, t),
    U.statusLine({ ...base, checked: true }, t),
    U.howTo(st, t).text,
    U.howTo(base, t).text,
    U.lastCheckLabel(st, t),
    U.lastCheckLabel(base, t),
  ];
  for (const s of said) {
    assert.ok(!/[ãõçáéíóúâêô]/i.test(s), `sem par em inglês: ${s}`);
  }
  setLang("pt");
});
