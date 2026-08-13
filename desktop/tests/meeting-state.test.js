// Uma reunião não pode se pintar como GRAVANDO antes de a captura existir, nem
// ficar presa em "encerrando…" para sempre, nem appendar a MESMA fala duas vezes
// (uma por trilha). Os três defeitos foram reproduzidos dirigindo o app numa
// instalação nova; estes testes prendem as correções.
//
// DESIGN.md §1: "State must never lie" · "The interface must not know something
// it does not say". ADR-0022 §22 (filtro de eco entre trilhas), ADR-0018 (a
// análise É a saída da reunião).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const APP = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
const { EN } = require("../src/i18n.js");

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
// Uma função PURA de app.js pode ser exercitada de verdade: extraímos o fonte e
// o avaliamos isolado (mesmo recurso que cm6-vendor.test.js usa no bundle).
// `deps` são as constantes de módulo que ela lê — vêm do fonte, não recopiadas
// aqui, senão o teste passaria com um valor que o app não usa.
function loadFn(name, deps) {
  const head = (deps || []).map((c) => {
    const m = APP.match(new RegExp("^const " + c + " = .*?;$", "m"));
    assert.ok(m, `app.js deve definir a constante ${c}`);
    return m[0];
  }).join("\n");
  // eslint-disable-next-line no-new-func
  return new Function(head + "\nreturn (" + fnSource(name) + ");")();
}

// ============================================================ B2
// Na PRIMEIRA reunião depois da instalação o macOS abre o diálogo de permissão
// do microfone: a promessa do getUserMedia fica PENDENTE até o usuário
// responder. O código pintava a reunião (aba reuniao.md com o selo GRAVANDO,
// rodapé de gravação) e só DEPOIS esperava a captura — relógio parado em 00:00,
// nenhum preview ao vivo, nada capturado pelo microfone.
test("B2 — settleWithin devolve o valor quando a promessa chega no prazo", async () => {
  const settleWithin = loadFn("settleWithin");
  assert.equal(await settleWithin(Promise.resolve(true), 500, "asking"), true);
  assert.equal(await settleWithin(Promise.resolve(false), 500, "asking"), false);
});

test("B2 — settleWithin não espera para sempre uma promessa pendente", async () => {
  const settleWithin = loadFn("settleWithin");
  const nunca = new Promise(() => {}); // o diálogo de permissão sem resposta
  assert.equal(await settleWithin(nunca, 20, "asking"), "asking");
});

test("B2 — a reunião só se pinta gravando depois de esperar a captura", () => {
  const body = fnBody("startMeetingWith");
  const mic = body.indexOf("startAudio(");
  const pinta = body.indexOf("meeting.active = true");
  const abre = body.indexOf("openDoc(");
  assert.ok(mic > -1 && pinta > -1 && abre > -1);
  assert.ok(mic < pinta,
    "a captura é esperada ANTES de meeting.active — senão o selo GRAVANDO aparece sem nada gravando");
  assert.ok(mic < abre, "e antes de abrir a superfície ao vivo");
  assert.match(body, /settleWithin\(/, "a espera tem prazo: um diálogo do sistema não resolve sozinho");
  assert.match(body, /setRecPending\("starting"\)/, "enquanto isso o cromo diz 'iniciando…'");
});

test("B2 — a permissão pendente é dita como o estado que é", () => {
  const body = fnBody("startMeetingWith");
  assert.match(body, /pedindo permissão para o microfone/,
    "a interface não pode saber que há um diálogo na frente do usuário e não dizer");
  assert.match(body, /sem microfone/, "e um microfone recusado é dito, não fingido");
});

test("B2 — o preview de microfone entra quando a permissão chega depois", () => {
  const body = fnBody("startMeetingWith");
  assert.match(body, /micReady\.then\(/,
    "aceitar a permissão tarde tem de ligar o preview do microfone, não perdê-lo");
});

test("B2 — BR-1: a permissão que chega depois do fim não deixa o microfone aberto", () => {
  const body = fnBody("startMeetingWith");
  assert.match(body, /else stopAudio\(\)/,
    "conceder a permissão depois do fim da reunião não pode deixar a captura viva");
});

test("B2 — uma reunião ativa é encerrável mesmo sem microfone estabelecido", () => {
  const body = fnBody("stopSession");
  assert.ok(body.indexOf("meeting.active") < body.indexOf("!state.running"),
    "state.running é falso quando o microfone nunca subiu: sem esta ordem 'Encerrar reunião' não fazia nada");
});

test("B2 — Encerrar reunião nunca fica pendente para sempre", () => {
  const m = APP.match(/\$\("recFinish"\)\.addEventListener\("click",[\s\S]*?\n\}\);/);
  assert.ok(m, "o botão Encerrar continua wired");
  assert.match(m[0], /\.catch\(/, "uma falha no encerramento aparece, não silencia");
  assert.match(m[0], /setRecPending\(null\)/,
    "sem isto o ● ficava desabilitado em 'encerrando…' para sempre");
});

test("B2 — o fim da reunião devolve o botão de gravar ao estado real", () => {
  const body = fnBody("finishMeetingAfterTranscription");
  assert.match(body, /setRecPending\(null\)/);
});

test("B2 — os msgids do microfone têm par em inglês", () => {
  for (const pt of [
    "o sistema está pedindo permissão para o microfone — a reunião já grava o áudio do sistema",
    "sem microfone — a reunião está gravando só o áudio do sistema",
  ]) assert.ok(EN[pt] && EN[pt] !== pt, `sem par em inglês: ${pt}`);
});

// ============================================================ B3
// ADR-0018: a análise É a saída da reunião. Encerrada, o app deixava o usuário
// na aba reuniao.md com o selo CONCLUÍDA e NENHUMA porta para analisar — a
// única oferta era um toast que expira. DESIGN.md §1: "a finished meeting with
// no analysis shows ✦ analisar".
test("B3 — uma reunião concluída sem análise oferece analisar na própria aba", () => {
  const body = fnBody("paintMeetingSurface");
  assert.match(body, /data-mtg="analyse"/, "a oferta é um botão de verdade, não um toast que expira");
  assert.match(body, /meetingQueueBlock\(/,
    "a condição é 'nada em notas/' — a mesma decisão pura que barra o envio para a fila");
  // R19 passou a decisão para o estado EFETIVO (o manifest fica em "recording"
  // quando o app é fechado no meio): a condição é a mesma, agora sobre a verdade.
  assert.match(body, /eff === "done"/, "e só quando a reunião terminou — gravando não entra cromo novo");
});

test("B3 — a oferta é ligada ao mesmo caminho de análise das habilidades", () => {
  const body = fnBody("wireMeetingSurface");
  assert.match(body, /data-mtg="analyse"/);
  assert.match(body, /runMeetingSkill\("analyse"/);
});

// ============================================================ B4
// Saída real de uma reunião gravada agora: "[00:00 · sistema] A CIDADE NO
// BRASIL" seguido de "[00:00 · você] A CIDADE NO BRASIL". O filtro de eco
// (ADR-0022 §22) exige 8 tokens de substância antes de comparar, então nenhuma
// fala curta era comparada — e a MESMA linha, no MESMO timecode, nas DUAS
// trilhas, passava duas vezes.
test("B4 — a mesma linha nas duas trilhas no mesmo timecode é uma só", () => {
  const dup = loadFn("crossTrackDuplicate", ["DUP_WINDOW_MS"]);
  const antes = [{ tMs: 0, source: "system", tokens: ["a", "cidade", "no", "brasil"] }];
  const agora = { tMs: 0, source: "mic", tokens: ["a", "cidade", "no", "brasil"] };
  assert.ok(dup(agora, antes), "curta ou não, é a mesma fala ouvida duas vezes");
});

test("B4 — a mesma trilha repetindo é fala repetida de verdade", () => {
  const dup = loadFn("crossTrackDuplicate", ["DUP_WINDOW_MS"]);
  const antes = [{ tMs: 0, source: "mic", tokens: ["tá", "bom"] }];
  assert.ok(!dup({ tMs: 0, source: "mic", tokens: ["tá", "bom"] }, antes));
});

test("B4 — textos diferentes na mesma janela continuam passando", () => {
  const dup = loadFn("crossTrackDuplicate", ["DUP_WINDOW_MS"]);
  const antes = [{ tMs: 0, source: "system", tokens: ["a", "cidade", "no", "brasil"] }];
  assert.ok(!dup({ tMs: 0, source: "mic", tokens: ["a", "cidade", "no", "chile"] }, antes));
});

test("B4 — longe no tempo é conversa, não eco", () => {
  const dup = loadFn("crossTrackDuplicate", ["DUP_WINDOW_MS"]);
  const antes = [{ tMs: 0, source: "system", tokens: ["tá", "bom"] }];
  assert.ok(!dup({ tMs: 60000, source: "mic", tokens: ["tá", "bom"] }, antes));
});

test("B4 — o ponto único de anexação consulta o duplicado exato", () => {
  const body = fnBody("appendMeetingChunk");
  assert.match(body, /crossTrackDuplicate\(/);
  const dup = body.indexOf("crossTrackDuplicate(");
  const push = body.indexOf("meeting.appended.push");
  assert.ok(dup < push, "o teste vem antes do registro, como o do eco");
});

// ============================================================ R19
// Uma reunião cujo manifest ficou em "recording" (o app fechou ou caiu no meio)
// era um beco sem saída: selo vermelho "● gravando" com nada gravando, uma seta
// ▸ que abria o vazio, e analisar / enviar / mover desabilitados "quando a
// reunião terminar" — sem nenhum jeito de terminá-la. O único caminho habilitado
// era apagar a reunião, isto é, destruir o material. Quem grava é a reunião VIVA,
// e o app sabe qual é; encerrar usa o comando que já existe (brain_meeting_finish),
// que só troca o status e não toca na transcrição.
test("R19 — 'recording' numa reunião que não é a viva é uma reunião interrompida", () => {
  const eff = loadFn("meetingEffectiveStatus");
  const live = { active: true, id: "2026-08-12-1136-reuniao" };
  assert.equal(eff("recording", live.id, live), "recording", "a reunião viva continua gravando");
  assert.equal(eff("recording", "outra-reuniao", live), "interrupted");
  assert.equal(eff("recording", "x", { active: false, id: "x" }), "interrupted",
    "o app foi fechado no meio: o manifest ficou, a gravação não");
  assert.equal(eff("recording", "x", null), "interrupted");
  assert.equal(eff("done", "x", live), "done", "os outros estados passam intactos");
  assert.equal(eff("transcribing", "x", live), "transcribing");
});

test("R19 — o selo tem o estado interrompida, e ele não pulsa em vermelho", () => {
  const bar = fnBody("meetingStatusBar");
  assert.match(bar, /interrupted: \[t\("interrompida"\), "warn"\]/,
    "vermelho é gravação em curso (DESIGN.md §3); interrompida é âmbar, e âmbar não anima");
});

test("R19 — a superfície diz o que houve e oferece encerrar, não apagar", () => {
  const body = fnBody("paintMeetingSurface");
  assert.match(body, /meetingEffectiveStatus\(/, "a superfície pinta pelo estado efetivo");
  assert.ok(!/status === "recording" && meeting\.id === id && meeting\.tailStatus/.test(body),
    "o preview ao vivo não pode ser oferecido por uma reunião que não está gravando");
  assert.match(body, /data-mtg="close"/, "a saída é uma ação primária na própria superfície");
  assert.match(fnBody("wireMeetingSurface"), /data-mtg="close"/);
  const fin = fnBody("finishInterruptedMeeting");
  assert.match(fin, /brain_meeting_finish/, "encerrar é o comando que já existe (idempotente)");
  assert.ok(!/purge_audio|brain_del|apagar/.test(fin), "nada do material do usuário é destruído");
  assert.match(fin, /refreshPessoal\(\)/, "a árvore volta a dizer a verdade na hora");
});

test("R19 — a árvore não mostra uma seta que abre o vazio, e o ⋯ oferece a saída", () => {
  const children = fnBody("loadTemaChildren");
  assert.match(children, /meetingEffectiveStatus\(m\.status, m\.id, meeting\)/,
    "a linha da reunião é desenhada com o estado efetivo, não com o do manifest");
  const row = fnBody("bsPartRow");
  assert.match(row, /interrupted/, "uma reunião interrompida não ganha o ▸ de expandir nada");
  assert.match(row, /data-mtgclose/, "…e ganha a ação que a desbloqueia");
  const menu = fnBody("openMeetingMenu");
  assert.match(menu, /interrupted/);
  assert.match(menu, /data-mtgclose/, "o ⋯ também oferece encerrar");
  assert.ok(
    /interrupted[\s\S]*?fnote/.test(menu),
    "e explica por que analisar/enviar/mover estão fechados (a promessa antiga nunca se cumpria)",
  );
});

test("R19 — os msgids da reunião interrompida têm par em inglês", () => {
  for (const pt of [
    "interrompida",
    "encerrar reunião",
    "sem transcrição — a gravação foi interrompida antes de transcrever alguma fala.",
    "reunião encerrada — a transcrição foi mantida",
    "a reunião foi interrompida — encerre para liberar analisar, enviar para organizar e mover",
  ]) assert.ok(EN[pt] && EN[pt] !== pt, `sem par em inglês: ${pt}`);
});
