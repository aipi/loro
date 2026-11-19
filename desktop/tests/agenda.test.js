// ADR-0041 §4 — a agenda do dia sem credencial (BR-9) e o agendador de gravações.
//
// O MÓDULO PURO (`src/agenda.js`) roda de verdade: lê o arquivo que o agente
// externo escreve, valida, e decide a cada tique {iniciar, encerrar, trocar,
// avisar-fim, perguntar-troca, sugerir, nada}. O que não pode ser puro (o tique,
// o executor, a ponte com o balão) é conferido no FONTE de app.js.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const AG = require("../src/agenda.js");

const SRC = path.join(__dirname, "..", "src");
const APP = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
const AG_SRC = fs.readFileSync(path.join(SRC, "agenda.js"), "utf8");

// Instantes com fuso EXPLÍCITO, como o agente escreve. -03:00 é Brasília.
const T = (hhmm, off = "-03:00") => Date.parse(`2026-11-18T${hhmm}:00${off}`);
const MIN = 60000;

function file(eventos, geradoEm = "2026-11-18T08:00:00-03:00", extra = {}) {
  return JSON.stringify(Object.assign({ versao: 1, geradoEm, eventos }, extra));
}
const ev = (id, ini, fim, comConvidados = true, titulo = "Reunião " + id) =>
  ({ id, titulo, inicio: `2026-11-18T${ini}:00-03:00`, fim: `2026-11-18T${fim}:00-03:00`, comConvidados });

// ---- leitura e validação do arquivo -----------------------------------------

test("ADR-0041 §4 — o contrato do arquivo é lido como o agente o escreve", () => {
  const a = AG.parseAgenda(file([ev("a", "10:00", "10:30"), ev("b", "09:00", "09:30", false)]), T("08:30"));
  assert.strictEqual(a.status, "ok");
  assert.strictEqual(a.geradoEmMs, T("08:00"));
  // ordenados pelo início, com os instantes em epoch
  assert.deepStrictEqual(a.eventos.map((e) => e.id), ["b", "a"]);
  assert.deepStrictEqual(a.eventos[1], {
    id: "a", titulo: "Reunião a", inicioMs: T("10:00"), fimMs: T("10:30"), comConvidados: true,
  });
  assert.strictEqual(a.eventos[0].comConvidados, false);
});

test("ADR-0041 §4 — sem arquivo é «ausente», JSON quebrado ou outro formato é «inválido»", () => {
  assert.strictEqual(AG.parseAgenda(null, T("09:00")).status, "missing");
  assert.strictEqual(AG.parseAgenda("", T("09:00")).status, "missing");
  for (const bad of ["{oops", "[]", "42", JSON.stringify({ versao: 2, geradoEm: "2026-11-18T08:00:00Z", eventos: [] }),
    JSON.stringify({ versao: 1, geradoEm: "2026-11-18T08:00:00Z", eventos: {} }),
    JSON.stringify({ versao: 1, geradoEm: "ontem", eventos: [] })]) {
    const a = AG.parseAgenda(bad, T("09:00"));
    assert.strictEqual(a.status, "invalid", bad);
    assert.deepStrictEqual(a.eventos, [], "nada inválido vira agenda: " + bad);
  }
});

test("ADR-0041 §4 — uma agenda com mais de 2h é «não atualizada», mas os eventos continuam valendo", () => {
  const a = AG.parseAgenda(file([ev("a", "11:00", "11:30")], "2026-11-18T08:00:00-03:00"), T("10:01"));
  assert.strictEqual(a.status, "stale");
  assert.strictEqual(a.eventos.length, 1);
  assert.strictEqual(AG.parseAgenda(file([], "2026-11-18T08:00:00-03:00"), T("10:00")).status, "ok", "2h em ponto ainda vale");
});

test("ADR-0041 §4 — o fuso vem do arquivo: Z, -03:00 e +01:00 são o mesmo instante", () => {
  assert.strictEqual(AG.parseInstant("2026-11-18T13:00:00Z"), T("10:00"));
  assert.strictEqual(AG.parseInstant("2026-11-18T14:00:00+01:00"), T("10:00"));
  assert.strictEqual(AG.parseInstant("2026-11-18T10:00:00.000-03:00"), T("10:00"));
  // sem fuso, o instante é ambíguo: recusado, nunca adivinhado pelo fuso da máquina
  assert.strictEqual(AG.parseInstant("2026-11-18T10:00:00"), null);
  assert.strictEqual(AG.parseInstant("2026-11-18"), null);
  assert.strictEqual(AG.parseInstant("amanhã 10h"), null);
  assert.strictEqual(AG.parseInstant(1763470800000), null);
});

test("ADR-0041 §4 — eventos mal formados caem um a um, sem derrubar a agenda", () => {
  const eventos = [
    ev("ok", "10:00", "10:30"),
    { id: "", titulo: "sem id", inicio: "2026-11-18T10:00:00Z", fim: "2026-11-18T11:00:00Z" },
    { id: "semfuso", titulo: "x", inicio: "2026-11-18T10:00:00", fim: "2026-11-18T11:00:00" },
    { id: "invertido", titulo: "x", inicio: "2026-11-18T11:00:00Z", fim: "2026-11-18T10:00:00Z" },
    { id: "zero", titulo: "x", inicio: "2026-11-18T11:00:00Z", fim: "2026-11-18T11:00:00Z" },
    "não é objeto",
    ev("ok", "15:00", "16:00"), // id repetido: o primeiro vale
  ];
  const a = AG.parseAgenda(file(eventos), T("09:00"));
  assert.strictEqual(a.status, "ok");
  assert.deepStrictEqual(a.eventos.map((e) => e.id), ["ok"]);
  assert.strictEqual(a.eventos[0].inicioMs, T("10:00"));
  // título ausente não derruba: o evento existe, a tela diz "(sem título)"
  const s = AG.parseAgenda(file([{ id: "x", inicio: "2026-11-18T10:00:00Z", fim: "2026-11-18T11:00:00Z" }]), T("06:00"));
  assert.strictEqual(s.eventos[0].titulo, "");
  assert.strictEqual(s.eventos[0].comConvidados, false, "comConvidados ausente = falso");
});

test("ADR-0041 §4 — próximas reuniões: as que ainda não acabaram", () => {
  const { eventos } = AG.parseAgenda(file([ev("passou", "08:00", "09:00"), ev("agora", "09:30", "10:30"), ev("depois", "14:00", "15:00")]), T("10:00"));
  assert.deepStrictEqual(AG.upcoming(eventos, T("10:00")).map((e) => e.id), ["agora", "depois"]);
  assert.deepStrictEqual(AG.upcoming(eventos, T("10:30")).map((e) => e.id), ["depois"], "fim é exclusivo");
});

test("ADR-0041 §4 — o nome do arquivo é o dia LOCAL", () => {
  assert.strictEqual(AG.dayKey(new Date(2026, 10, 18, 23, 59)), "2026-11-18");
  assert.strictEqual(AG.dayKey(new Date(2026, 0, 2, 0, 0)), "2026-01-02");
});

test("ADR-0041 §4 — o agendado de dias passados é podado", () => {
  const s = { versao: 1, eventos: { a: { tema: "x", data: "2026-11-17" }, b: { tema: "x", data: "2026-11-18" }, c: { tema: "x", data: "" } } };
  assert.deepStrictEqual(Object.keys(AG.pruneSchedule(s, "2026-11-18").eventos), ["b", "c"]);
  assert.deepStrictEqual(AG.pruneSchedule(null, "2026-11-18"), { versao: 1, eventos: {} });
});

// ---- a decisão ------------------------------------------------------------

const EVS = AG.parseAgenda(file([
  ev("a", "10:00", "10:30"),
  ev("b", "10:30", "11:00"),          // emendada na A
  ev("c", "14:00", "15:00"),
  ev("solo", "16:00", "16:30", false), // sem convidados (foco, almoço)
  ev("d", "17:00", "17:45"),
]), T("09:00")).eventos;
const SCHED = { a: { tema: "frota" }, b: { tema: "vendas" }, c: { tema: "" } };
const IDLE = { rec: "idle", atual: null, tratados: [], avisoFimDado: false, ultimoTema: "geral" };
const decide = (now, estado, extra = {}) =>
  AG.decide(Object.assign({ nowMs: now, eventos: EVS, agendadas: SCHED, estado: Object.assign({}, IDLE, estado) }, extra));

test("ADR-0041 §4 — antes da hora nada; no início, a agendada começa na ideia escolhida", () => {
  assert.deepStrictEqual(decide(T("09:59")), { acao: "nada" });
  const d = decide(T("10:00"));
  assert.strictEqual(d.acao, "iniciar");
  assert.strictEqual(d.evento.id, "a");
  assert.strictEqual(d.tema, "frota");
  // aberto no meio do evento (app ligado às 10:12): começa agora, não perde a reunião
  assert.strictEqual(decide(T("10:12")).acao, "iniciar");
});

test("ADR-0041 §4 — sem ideia escolhida no agendamento, vale a última usada", () => {
  const d = decide(T("14:00"));
  assert.strictEqual(d.acao, "iniciar");
  assert.strictEqual(d.tema, "geral");
});

test("ADR-0041 §4 — uma agendada já tratada (começou, foi parada à mão, foi recusada) não volta", () => {
  assert.deepStrictEqual(decide(T("10:05"), { tratados: ["a"] }), { acao: "nada" });
});

test("ADR-0041 §4 — dois minutos antes do fim, o balão avisa e oferece +15 min (uma vez)", () => {
  const atual = { tipo: "agendada", eventId: "a", fimMs: T("10:30"), extraMs: 0 };
  const est = { rec: "recording", atual, tratados: ["a"] };
  // a B só começa às 10:30, então às 10:28 o aviso é o do fim
  assert.deepStrictEqual(decide(T("10:27"), est), { acao: "nada" });
  assert.deepStrictEqual(decide(T("10:28"), est), { acao: "avisar-fim", evento: EVS[0], minutos: 2 });
  assert.deepStrictEqual(decide(T("10:28"), Object.assign({}, est, { avisoFimDado: true })), { acao: "nada" });
});

test("ADR-0041 §4 — no fim a agendada encerra; estendida, encerra 15 min depois", () => {
  const atual = { tipo: "agendada", eventId: "c", fimMs: T("15:00"), extraMs: 0 };
  assert.deepStrictEqual(decide(T("15:00"), { rec: "recording", atual, tratados: ["c"] }), { acao: "encerrar" });
  // pausada também encerra: a reunião acabou
  assert.deepStrictEqual(decide(T("15:00"), { rec: "paused", atual, tratados: ["c"] }), { acao: "encerrar" });
  const estendida = Object.assign({}, atual, { extraMs: AG.EXTEND_MS });
  assert.deepStrictEqual(decide(T("15:00"), { rec: "recording", atual: estendida, tratados: ["c"], avisoFimDado: false }).acao, "nada");
  assert.strictEqual(decide(T("15:13"), { rec: "recording", atual: estendida, tratados: ["c"] }).acao, "avisar-fim");
  assert.deepStrictEqual(decide(T("15:15"), { rec: "recording", atual: estendida, tratados: ["c"] }), { acao: "encerrar" });
});

test("ADR-0041 §4 — o fim segue o arquivo: se o agente mover o fim, a gravação acompanha", () => {
  const atual = { tipo: "agendada", eventId: "c", fimMs: T("15:00"), extraMs: 0 };
  const movida = AG.parseAgenda(file([ev("c", "14:00", "15:30")]), T("09:00")).eventos;
  assert.strictEqual(decide(T("15:00"), { rec: "recording", atual, tratados: ["c"] }, { eventos: movida }).acao, "nada");
  // e se o evento sumiu do arquivo, vale o fim guardado no início
  assert.strictEqual(decide(T("15:00"), { rec: "recording", atual, tratados: ["c"] }, { eventos: [] }).acao, "encerrar");
});

test("ADR-0041 §4 — emendadas: no fim da A, para a A e começa a B", () => {
  const atual = { tipo: "agendada", eventId: "a", fimMs: T("10:30"), extraMs: 0 };
  const d = decide(T("10:30"), { rec: "recording", atual, tratados: ["a"] });
  assert.strictEqual(d.acao, "trocar");
  assert.strictEqual(d.evento.id, "b");
  assert.strictEqual(d.tema, "vendas");
});

test("ADR-0041 §4 — a A estendida não é cortada pela B: o balão pergunta", () => {
  const atual = { tipo: "agendada", eventId: "a", fimMs: T("10:30"), extraMs: AG.EXTEND_MS };
  const d = decide(T("10:30"), { rec: "recording", atual, tratados: ["a"] });
  assert.strictEqual(d.acao, "perguntar-troca");
  assert.strictEqual(d.evento.id, "b");
});

test("ADR-0041 §4 — uma gravação manual nunca é interrompida: o balão pergunta", () => {
  const manual = { rec: "recording", atual: { tipo: "manual" } };
  const d = decide(T("10:00"), manual);
  assert.strictEqual(d.acao, "perguntar-troca");
  assert.strictEqual(d.evento.id, "a");
  // depois de perguntar (ou de «Continuar»), a agendada está tratada: não pergunta de novo
  assert.deepStrictEqual(decide(T("10:01"), Object.assign({}, manual, { tratados: ["a"] })), { acao: "nada" });
  // pausada também conta como gravação da pessoa
  assert.strictEqual(decide(T("10:00"), { rec: "paused", atual: { tipo: "manual" } }).acao, "perguntar-troca");
});

test("ADR-0041 §4 — enquanto começa ou encerra, o agendador espera", () => {
  assert.deepStrictEqual(decide(T("10:00"), { rec: "busy" }), { acao: "nada" });
});

test("ADR-0041 §4 — com convidados e não agendada: SUGERE gravar no início, nunca começa sozinho", () => {
  const d = decide(T("17:00"));
  assert.strictEqual(d.acao, "sugerir");
  assert.strictEqual(d.evento.id, "d");
  assert.strictEqual(decide(T("17:09")).acao, "sugerir", "dentro dos 10 primeiros minutos");
  assert.deepStrictEqual(decide(T("17:11")), { acao: "nada" }, "depois disso a sugestão já passou");
  assert.deepStrictEqual(decide(T("17:00"), { tratados: ["d"] }), { acao: "nada" }, "uma vez");
  // sem convidados (foco, almoço) não sugere
  assert.deepStrictEqual(decide(T("16:00")), { acao: "nada" });
  // gravando, não sugere outra
  assert.deepStrictEqual(decide(T("17:00"), { rec: "recording", atual: { tipo: "manual" } }), { acao: "nada" });
});

test("ADR-0041 §4 — sobrepostas não tratadas: começa a que começou por último", () => {
  const sobre = AG.parseAgenda(file([ev("x", "10:00", "11:00"), ev("y", "10:15", "10:45")]), T("09:00")).eventos;
  const d = AG.decide({ nowMs: T("10:20"), eventos: sobre, agendadas: { x: { tema: "t" }, y: { tema: "t" } }, estado: IDLE });
  assert.strictEqual(d.evento.id, "y");
});

test("ADR-0041 §4 — agenda.js é puro e não fala português", () => {
  assert.doesNotMatch(AG_SRC, /\bdocument\.|\binvoke\(|__TAURI__|\bwindow\.(?!LoroAgenda)/);
  assert.doesNotMatch(AG_SRC, /\bt\(/);
});

// ---- o executor em app.js ---------------------------------------------------
function fnSource(name) {
  const re = new RegExp("(?:async )?function " + name + "\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}");
  const m = APP.match(re);
  assert.ok(m, `app.js deve definir ${name}()`);
  return m[0];
}

test("ADR-0041 §4 — o relógio da agenda vem do BACKEND (loro-tick) e não trava com a janela escondida", () => {
  assert.match(APP, /listen\("loro-tick", \(\) => agendaTick\(\)\)/);
  const body = fnSource("agendaTick");
  assert.doesNotMatch(body, /document\.hidden/, "a janela passa o dia escondida na bandeja");
  assert.match(body, /LAG\.decide\(/);
  // relê o arquivo do agente a cada tique: ele muda a qualquer hora
  assert.match(body, /await agendaLoad\(\)/);
  assert.match(fnSource("agendaLoad"), /invoke\("agenda_read", \{ date/);
});

test("ADR-0041 §4 — começar uma agendada usa o caminho sem modal e marca a reunião como calada", () => {
  const body = fnSource("agendaStart");
  assert.match(body, /startMeetingWith\(\{ tema: [^,]+, titulo: [^,]+, quiet: true \}\)/);
  assert.doesNotMatch(body, /pickMeeting/);
});

test("ADR-0041 §5 — uma reunião agendada fecha calada: sem aba e sem oferta de análise", () => {
  const body = fnSource("finishMeetingAfterTranscription");
  assert.match(body, /if \(rel && quiet\)/);
});

test("ADR-0041 §5 — o dia gravado da ADR-0038 saiu inteiro", () => {
  for (const gone of ["workdayTick", "WORKDAY_TEMA", "workday_get", "workday_set", "workday_keep_awake", "isWorkdayMeeting", "LoroWorkday"]) {
    assert.ok(!APP.includes(gone), "app.js ainda fala de " + gone);
  }
  assert.ok(!fs.existsSync(path.join(SRC, "workday.js")));
  const html = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
  for (const gone of ["optWorkday", "workdayInicio", "workdayFim", "workday.js"]) {
    assert.ok(!html.includes(gone), "index.html ainda tem " + gone);
  }
  assert.match(html, /<script src="agenda.js"><\/script>/);
});
