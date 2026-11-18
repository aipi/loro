// ADR-0038 — dia gravado: o Loro grava o expediente sozinho, em horas emendadas.
//
// Duas costuras, como loops.test.js: o MÓDULO PURO (`src/workday.js`) roda de
// verdade e decide; o que não pode ser puro (o tique, a parada manual, a tela) é
// verificado no FONTE de app.js/index.html — não há DOM sob `node --test`.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const WD = require("../src/workday.js");
const { nowFields } = require("../src/loops.js");

const SRC = path.join(__dirname, "..", "src");
const APP = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const WD_SRC = fs.readFileSync(path.join(SRC, "workday.js"), "utf8");
const { EN } = require("../src/i18n.js");

// 2026-11-18 é uma quarta-feira (weekday 3). Horário LOCAL, como o app lê.
const at = (y, mo, d, h, mi) => nowFields(new Date(y, mo - 1, d, h, mi, 0, 0));
const CFG = { ligado: true, inicio: "09:00", fim: "18:30", dias: [0, 1, 2, 3, 4, 5, 6] };
const IDLE = { gravandoDia: false, horaDaGravacao: null, suspensoAteHora: null, gravandoManual: false };

test("ADR-0038 §1 — fora da janela não faz nada", () => {
  assert.deepStrictEqual(WD.decide({ agora: at(2026, 11, 18, 8, 59), cfg: CFG, estado: IDLE }), { acao: "nada" });
  assert.deepStrictEqual(WD.decide({ agora: at(2026, 11, 18, 18, 30), cfg: CFG, estado: IDLE }), { acao: "nada" });
  assert.deepStrictEqual(WD.decide({ agora: at(2026, 11, 18, 23, 0), cfg: CFG, estado: IDLE }), { acao: "nada" });
});

test("ADR-0038 §1 — o app aberto no meio da janela começa na hora corrente (10:17)", () => {
  assert.deepStrictEqual(
    WD.decide({ agora: at(2026, 11, 18, 10, 17), cfg: CFG, estado: IDLE }),
    { acao: "iniciar", titulo: "Dia 2026-11-18 10:00", hora: "2026-11-18 10" }
  );
  // o primeiro minuto da janela também
  assert.strictEqual(WD.decide({ agora: at(2026, 11, 18, 9, 0), cfg: CFG, estado: IDLE }).acao, "iniciar");
});

test("ADR-0038 §1 — na virada da hora cheia a gravação do dia rotaciona", () => {
  const estado = { ...IDLE, gravandoDia: true, horaDaGravacao: "2026-11-18 10" };
  assert.deepStrictEqual(WD.decide({ agora: at(2026, 11, 18, 10, 59), cfg: CFG, estado }), { acao: "nada" });
  assert.deepStrictEqual(
    WD.decide({ agora: at(2026, 11, 18, 11, 0), cfg: CFG, estado }),
    { acao: "rotacionar", titulo: "Dia 2026-11-18 11:00", hora: "2026-11-18 11" }
  );
});

test("ADR-0038 §1 — no fim da janela (18:30) o dia encerra", () => {
  const estado = { ...IDLE, gravandoDia: true, horaDaGravacao: "2026-11-18 18" };
  assert.deepStrictEqual(WD.decide({ agora: at(2026, 11, 18, 18, 29), cfg: CFG, estado }), { acao: "nada" });
  assert.deepStrictEqual(WD.decide({ agora: at(2026, 11, 18, 18, 30), cfg: CFG, estado }), { acao: "encerrar" });
});

test("ADR-0038 §5 — um dia da semana fora de `dias` não grava (0 = domingo)", () => {
  const util = { ...CFG, dias: [1, 2, 3, 4, 5] };
  // 2026-11-22 é domingo
  assert.deepStrictEqual(WD.decide({ agora: at(2026, 11, 22, 10, 0), cfg: util, estado: IDLE }), { acao: "nada" });
  assert.strictEqual(WD.decide({ agora: at(2026, 11, 18, 10, 0), cfg: util, estado: IDLE }).acao, "iniciar");
  // e se a gravação do dia ainda estiver de pé num dia fora da lista, ela encerra
  const gravando = { ...IDLE, gravandoDia: true, horaDaGravacao: "2026-11-21 23" };
  assert.deepStrictEqual(WD.decide({ agora: at(2026, 11, 22, 10, 0), cfg: util, estado: gravando }), { acao: "encerrar" });
});

test("ADR-0038 §1 — parar à mão suspende o dia até a próxima virada de hora", () => {
  const suspenso = { ...IDLE, suspensoAteHora: WD.nextHourKey(at(2026, 11, 18, 10, 40)) };
  assert.strictEqual(suspenso.suspensoAteHora, "2026-11-18 11");
  assert.deepStrictEqual(WD.decide({ agora: at(2026, 11, 18, 10, 41), cfg: CFG, estado: suspenso }), { acao: "nada" });
  assert.deepStrictEqual(WD.decide({ agora: at(2026, 11, 18, 10, 59), cfg: CFG, estado: suspenso }), { acao: "nada" });
  assert.strictEqual(WD.decide({ agora: at(2026, 11, 18, 11, 0), cfg: CFG, estado: suspenso }).acao, "iniciar");
});

test("ADR-0038 §1 — uma reunião manual em andamento não é interrompida pelo dia", () => {
  const manual = { ...IDLE, gravandoManual: true };
  assert.deepStrictEqual(WD.decide({ agora: at(2026, 11, 18, 9, 0), cfg: CFG, estado: manual }), { acao: "nada" });
  assert.deepStrictEqual(WD.decide({ agora: at(2026, 11, 18, 14, 0), cfg: CFG, estado: manual }), { acao: "nada" });
  // e o fim da janela também não a encerra: ela é da pessoa, não do dia
  assert.deepStrictEqual(WD.decide({ agora: at(2026, 11, 18, 18, 30), cfg: CFG, estado: manual }), { acao: "nada" });
});

test("ADR-0038 §1 — a virada de meia-noite: a hora é chave de DATA e hora", () => {
  // a suspensão das 23h termina à meia-noite do dia SEGUINTE
  assert.strictEqual(WD.nextHourKey(at(2026, 11, 18, 23, 40)), "2026-11-19 00");
  // fim de mês e de ano
  assert.strictEqual(WD.nextHourKey(at(2026, 11, 30, 23, 5)), "2026-12-01 00");
  assert.strictEqual(WD.nextHourKey(at(2026, 12, 31, 23, 5)), "2027-01-01 00");
  // uma janela que vai até 24:00 encerra na meia-noite
  const noite = { ...CFG, inicio: "22:00", fim: "24:00" };
  const gravando = { ...IDLE, gravandoDia: true, horaDaGravacao: "2026-11-18 23" };
  assert.deepStrictEqual(WD.decide({ agora: at(2026, 11, 18, 23, 59), cfg: noite, estado: gravando }), { acao: "nada" });
  assert.deepStrictEqual(WD.decide({ agora: at(2026, 11, 19, 0, 0), cfg: noite, estado: gravando }), { acao: "encerrar" });
  // a mesma HORA de outro dia é outra hora: uma gravação que ficou de pé desde
  // ontem às 10h (máquina dormindo) rotaciona hoje às 10h, não continua
  const ontem = { ...IDLE, gravandoDia: true, horaDaGravacao: "2026-11-17 10" };
  assert.deepStrictEqual(
    WD.decide({ agora: at(2026, 11, 18, 10, 5), cfg: CFG, estado: ontem }),
    { acao: "rotacionar", titulo: "Dia 2026-11-18 10:00", hora: "2026-11-18 10" }
  );
  // e uma suspensão que passou da meia-noite já venceu
  const suspensoOntem = { ...IDLE, suspensoAteHora: "2026-11-17 19" };
  assert.strictEqual(WD.decide({ agora: at(2026, 11, 18, 9, 0), cfg: CFG, estado: suspensoOntem }).acao, "iniciar");
});

test("ADR-0038 §5 — desligado não grava, e desligar no meio encerra a gravação do dia", () => {
  const off = { ...CFG, ligado: false };
  assert.deepStrictEqual(WD.decide({ agora: at(2026, 11, 18, 10, 0), cfg: off, estado: IDLE }), { acao: "nada" });
  const gravando = { ...IDLE, gravandoDia: true, horaDaGravacao: "2026-11-18 10" };
  assert.deepStrictEqual(WD.decide({ agora: at(2026, 11, 18, 10, 30), cfg: off, estado: gravando }), { acao: "encerrar" });
  // ausente = desligado (ADR-0038 §5)
  assert.deepStrictEqual(WD.decide({ agora: at(2026, 11, 18, 10, 0), cfg: null, estado: IDLE }), { acao: "nada" });
});

test("ADR-0038 §5 — uma janela ilegível ou vazia é desligada, nunca adivinhada", () => {
  for (const bad of [
    { ...CFG, inicio: "9h", fim: "18:30" },
    { ...CFG, inicio: "18:30", fim: "09:00" },
    { ...CFG, inicio: "10:00", fim: "10:00" },
    { ...CFG, inicio: "25:00", fim: "26:00" },
  ]) {
    assert.deepStrictEqual(WD.decide({ agora: at(2026, 11, 18, 12, 0), cfg: bad, estado: IDLE }), { acao: "nada" }, JSON.stringify(bad));
  }
  assert.strictEqual(WD.parseClock("09:00"), 540);
  assert.strictEqual(WD.parseClock("24:00"), 1440);
  assert.strictEqual(WD.parseClock("24:01"), null);
  assert.strictEqual(WD.parseClock("9:5"), null);
  // `dias` ausente = todos os dias
  const semDias = { ligado: true, inicio: "09:00", fim: "18:30" };
  assert.strictEqual(WD.decide({ agora: at(2026, 11, 22, 10, 0), cfg: semDias, estado: IDLE }).acao, "iniciar");
});

// ---- o módulo é puro e não fala português ---------------------------------
test("ADR-0038 §2 — workday.js é puro: sem DOM, sem IPC", () => {
  assert.doesNotMatch(WD_SRC, /\bdocument\.|\binvoke\(|__TAURI__|\bwindow\.(?!LoroWorkday)/);
  // devolve enums; o único texto é o TÍTULO de dado fixado pela ADR (§1)
  assert.doesNotMatch(WD_SRC, /\bt\(/);
});

// ---- o relógio no app -----------------------------------------------------
function fnSource(name) {
  const re = new RegExp("(?:async )?function " + name + "\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}");
  const m = APP.match(re);
  assert.ok(m, `app.js deve definir ${name}()`);
  return m[0];
}

test("ADR-0038 §2 — o tique do dia roda a cada 15 s e NÃO trava com a janela escondida", () => {
  assert.match(APP, /const WORKDAY_TICK_MS = 15000;/);
  assert.match(APP, /setInterval\(workdayTick, WORKDAY_TICK_MS\)/);
  const body = fnSource("workdayTick");
  assert.doesNotMatch(body, /document\.hidden/,
    "o loopTick para com a janela escondida; o dia gravado precisa rodar só na bandeja");
  assert.match(body, /LWD\.decide\(/);
});

test("ADR-0038 §2 — o início do dia usa o caminho sem modal, no tema `dia`", () => {
  const body = fnSource("workdayStart");
  assert.match(body, /startMeetingWith\(\{ tema: WORKDAY_TEMA, titulo/);
  assert.doesNotMatch(body, /pickMeeting/);
  assert.match(APP, /const WORKDAY_TEMA = "dia";/);
});

test("ADR-0038 §1 — rotacionar é parar, esperar a reunião fechar, e começar", () => {
  const body = fnSource("workdayRotate");
  const stop = body.indexOf("workdayStop(");
  const start = body.indexOf("workdayStart(");
  assert.ok(stop >= 0 && start > stop, "parar antes de começar");
  assert.match(fnSource("workdayStop"), /await workdayIdle\(/, "esperar o finalizar antes de seguir");
});

test("ADR-0038 §1 — parar à mão uma gravação do dia a suspende até a próxima hora", () => {
  const body = fnSource("stopMeeting");
  assert.match(body, /workdayNoteManualStop\(\)/);
  assert.match(fnSource("workdayNoteManualStop"), /LWD\.nextHourKey\(/);
});

test("ADR-0038 §1 — «retomar o dia» está na paleta, só quando há o que retomar", () => {
  const line = APP.split("\n").find((l) => l.includes('label: "Retomar o dia gravado"'));
  assert.ok(line, "a paleta oferece retomar o dia");
  assert.match(line, /when: workdaySuspended/);
  assert.ok(EN["Retomar o dia gravado"], "o rótulo da paleta tem par em inglês");
});

test("ADR-0038 §5 — a configuração lê e grava pelo IPC, no config global", () => {
  assert.match(APP, /invoke\("workday_get"\)/);
  assert.match(APP, /invoke\("workday_set", \{ cfg/);
  for (const id of ["optWorkday", "workdayInicio", "workdayFim"]) {
    assert.match(HTML, new RegExp(`id="${id}"`), `index.html deve ter #${id}`);
  }
  assert.match(HTML, /<script src="workday.js"><\/script>\s*\n\s*<script src="update.js">|<script src="workday.js"><\/script>/);
});

test("ADR-0038 §4 — o Mac fica acordado enquanto o dia grava, e solta quando para", () => {
  assert.match(fnSource("workdayStart"), /invoke\("workday_keep_awake", \{ on: true \}\)/);
  assert.match(APP, /invoke\("workday_keep_awake", \{ on: false \}\)/);
});
