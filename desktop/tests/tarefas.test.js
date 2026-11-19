// ADR-0041 §10 — as tarefas do dono, num arquivo que o agente escreve (BR-9).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const TF = require("../src/tarefas.js");
const SRC = path.join(__dirname, "..", "src");
const APP = fs.readFileSync(path.join(SRC, "app.js"), "utf8");

const T = (iso) => Date.parse(iso);
const file = (tarefas, geradoEm = "2026-11-18T08:00:00-03:00") => JSON.stringify({ versao: 1, geradoEm, tarefas });
const tk = (id, prazo, extra) => Object.assign({ id, titulo: "Tarefa " + id, prazo, notas: "", status: "needsAction", concluidaEm: null, link: null }, extra || {});

test("ADR-0041 §10 — o contrato do arquivo, com os campos opcionais", () => {
  const p = TF.parseTarefas(file([
    tk("a", "2026-11-18", { notas: "linha 1\nlinha 2", link: "https://tasks.google.com/task/a" }),
    tk("b", null, { status: "completed", concluidaEm: "2026-11-17T18:00:00-03:00" }),
    { id: "c", titulo: "mínima", status: "needsAction" },
  ]), T("2026-11-18T09:00:00-03:00"));
  assert.strictEqual(p.status, "ok");
  const [a, b, c] = p.tarefas;
  assert.deepStrictEqual(a, { id: "a", titulo: "Tarefa a", prazo: "2026-11-18", notas: "linha 1\nlinha 2", status: "needsAction", concluidaEmMs: null, link: "https://tasks.google.com/task/a" });
  assert.strictEqual(b.concluidaEmMs, T("2026-11-17T18:00:00-03:00"));
  assert.deepStrictEqual([c.prazo, c.notas, c.link], [null, "", null]);
});

test("ADR-0041 §10 — ausente, quebrado, velho, e o que cai um a um", () => {
  assert.strictEqual(TF.parseTarefas(null, 0).status, "missing");
  for (const bad of ["{x", "[]", JSON.stringify({ versao: 2, geradoEm: "2026-11-18T08:00:00Z", tarefas: [] }), JSON.stringify({ versao: 1, geradoEm: "ontem", tarefas: [] })]) {
    assert.strictEqual(TF.parseTarefas(bad, 0).status, "invalid", bad);
  }
  assert.strictEqual(TF.parseTarefas(file([]), T("2026-11-18T10:01:00-03:00")).status, "stale");
  const p = TF.parseTarefas(file([
    tk("ok", "2026-11-18"),
    tk("", "2026-11-18"),
    tk("st", null, { status: "deleted" }),
    tk("pz", "18/11/2026"),
    tk("fev", "2026-02-30"),
    tk("lk", null, { link: "javascript:alert(1)" }),
    tk("ok", null),
  ]), T("2026-11-18T09:00:00-03:00"));
  assert.deepStrictEqual(p.tarefas.map((t) => t.id), ["ok", "pz", "fev", "lk"]);
  const by = (id) => p.tarefas.find((t) => t.id === id);
  assert.strictEqual(by("pz").prazo, null, "prazo em outro formato vira sem prazo");
  assert.strictEqual(by("fev").prazo, null, "30 de fevereiro não existe");
  assert.strictEqual(by("lk").link, null);
});

test("ADR-0041 §10 — os grupos: atrasadas, hoje, próximas, sem prazo, concluídas", () => {
  const ts = TF.parseTarefas(file([
    tk("ontem", "2026-11-17"), tk("hoje", "2026-11-18"), tk("amanha", "2026-11-19"),
    tk("semana", "2026-11-25"), tk("solta", null),
    tk("feita", "2026-11-10", { status: "completed", concluidaEm: "2026-11-16T10:00:00-03:00" }),
  ]), 0).tarefas;
  const g = TF.group(ts, new Date(2026, 10, 18, 9, 0).getTime(), []);
  assert.deepStrictEqual(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.map((t) => t.id)])), {
    atrasadas: ["ontem"], hoje: ["hoje"], proximas: ["amanha", "semana"], semPrazo: ["solta"], concluidas: ["feita"],
  });
  assert.strictEqual(TF.badgeCount(ts, new Date(2026, 10, 18, 9, 0).getTime(), []), 2, "atrasadas + hoje");
});

test("ADR-0041 §10 — a virada da meia-noite: o prazo é o dia LOCAL", () => {
  const ts = [{ id: "x", titulo: "x", prazo: "2026-11-18", status: "needsAction" }];
  assert.deepStrictEqual(TF.group(ts, new Date(2026, 10, 18, 23, 59, 59).getTime(), []).hoje.map((t) => t.id), ["x"]);
  assert.deepStrictEqual(TF.group(ts, new Date(2026, 10, 19, 0, 0, 1).getTime(), []).atrasadas.map((t) => t.id), ["x"]);
  assert.deepStrictEqual(TF.group(ts, new Date(2026, 10, 17, 23, 59).getTime(), []).proximas.map((t) => t.id), ["x"]);
});

test("ADR-0041 §10 — concluir é otimista: fica «concluindo…» até o arquivo mostrar", () => {
  const aberta = [{ id: "a", titulo: "a", prazo: "2026-11-18", status: "needsAction" }];
  const pend = [{ id: "a", acao: "concluir" }];
  const now = new Date(2026, 10, 18, 9).getTime();
  // enquanto o arquivo não mudou, a ação segue pendente e a tarefa aparece concluindo
  assert.deepStrictEqual(TF.reconcile(pend, aberta), pend);
  assert.deepStrictEqual(TF.effective(aberta[0], pend), { done: true, pendente: "concluir" });
  assert.deepStrictEqual(TF.group(aberta, now, pend).hoje.map((t) => t.id), ["a"], "fica no lugar dela");
  assert.strictEqual(TF.badgeCount(aberta, now, pend), 0, "e já não conta como por fazer");
  // o arquivo seguinte reflete: a ação cai
  const feita = [{ id: "a", titulo: "a", prazo: "2026-11-18", status: "completed" }];
  assert.deepStrictEqual(TF.reconcile(pend, feita), []);
  // reabrir uma concluída: volta ao grupo dela até o arquivo confirmar
  const re = [{ id: "a", acao: "reabrir" }];
  assert.deepStrictEqual(TF.group(feita, now, re).hoje.map((t) => t.id), ["a"]);
  assert.deepStrictEqual(TF.reconcile(re, feita), re);
  assert.deepStrictEqual(TF.reconcile(re, aberta), []);
  // a tarefa sumiu do arquivo: nada a esperar
  assert.deepStrictEqual(TF.reconcile(pend, []), []);
});

test("ADR-0041 §10 — notas com links: texto puro, só http(s) vira link", () => {
  assert.deepStrictEqual(TF.linkify("ver https://x.com/a, e depois\njavascript:alert(1)"), [
    { text: "ver " }, { url: "https://x.com/a" }, { text: ", e depois\njavascript:alert(1)" },
  ]);
  assert.deepStrictEqual(TF.linkify(""), []);
  assert.deepStrictEqual(TF.linkify("(http://y.org/b)."), [{ text: "(" }, { url: "http://y.org/b" }, { text: ")." }]);
});

test("ADR-0041 §10 — o app lê o arquivo, grava a ação e nunca escreve no Google", () => {
  assert.match(APP, /invoke\("tarefas_read"\)/);
  assert.match(APP, /invoke\("tarefas_acao", \{ id/);
  assert.match(APP, /LTF\.reconcile\(/);
  const B = fs.readFileSync(path.join(SRC, "bubble.js"), "utf8");
  assert.match(B, /send\("tarefa", \{ id/);
  assert.match(B, /LTF\.linkify\(/);
  assert.doesNotMatch(B, /innerHTML = [^;]*notas/);
});
