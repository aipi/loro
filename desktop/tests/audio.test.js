// Testes da seleção de dispositivo de captura (node --test). Sem dependências.
const test = require("node:test");
const assert = require("node:assert");
const { pickCaptureDevice, loopbackPattern } = require("../src/audio.js");

const DEVS = [
  { index: 0, name: "Microfone (MacBook Pro)" },
  { index: 1, name: "BlackHole 2ch" },
];

test("fonte microfone: sem flag -c (usa o padrão do sistema)", () => {
  const r = pickCaptureDevice(DEVS, "mic");
  assert.strictEqual(r.capture, undefined);
  assert.strictEqual(r.missing, undefined);
});

test("fonte sistema: casa o dispositivo BlackHole", () => {
  const r = pickCaptureDevice(DEVS, "system");
  assert.strictEqual(r.capture, 1);
  assert.strictEqual(r.missing, undefined);
});

test("fonte sistema sem BlackHole: sinaliza missing=system", () => {
  const r = pickCaptureDevice([DEVS[0]], "system");
  assert.strictEqual(r.capture, undefined);
  assert.strictEqual(r.missing, "system");
});

test("lista vazia ou ausente não quebra", () => {
  assert.strictEqual(pickCaptureDevice([], "system").missing, "system");
  assert.strictEqual(pickCaptureDevice(undefined, "mic").capture, undefined);
  assert.strictEqual(pickCaptureDevice(null, "system").missing, "system");
});

// ---- loopback por plataforma (ADR-0012) ----
// No Windows o dispositivo de loopback é a Mixagem estéreo do próprio driver
// (Stereo Mix em inglês) ou um VB-Cable, nunca o BlackHole.
const MIC_WIN = { index: 0, name: "Grupo de microfones (Intel Smart Sound)" };

test("Windows: casa a Mixagem estéreo em pt-BR", () => {
  const devs = [MIC_WIN, { index: 1, name: "Mixagem estéreo (Realtek(R) Audio)" }];
  assert.strictEqual(pickCaptureDevice(devs, "system", "windows").capture, 1);
});

test("Windows: casa Stereo Mix em inglês e VB-Cable", () => {
  const en = [MIC_WIN, { index: 1, name: "Stereo Mix (Realtek High Definition Audio)" }];
  assert.strictEqual(pickCaptureDevice(en, "system", "windows").capture, 1);
  const vb = [MIC_WIN, { index: 2, name: "CABLE Output (VB-Audio Virtual Cable)" }];
  assert.strictEqual(pickCaptureDevice(vb, "system", "windows").capture, 2);
});

test("Windows sem loopback: sinaliza missing=system", () => {
  assert.strictEqual(pickCaptureDevice([MIC_WIN], "system", "windows").missing, "system");
});

test("cada plataforma só aceita o dispositivo que sabe configurar", () => {
  // BlackHole não serve no Windows, Mixagem estéreo não serve no macOS
  const bh = [{ index: 1, name: "BlackHole 2ch" }];
  assert.strictEqual(pickCaptureDevice(bh, "system", "windows").missing, "system");
  const sm = [{ index: 1, name: "Stereo Mix" }];
  assert.strictEqual(pickCaptureDevice(sm, "system", "macos").missing, "system");
});

test("sem os informado mantém o comportamento de macOS", () => {
  assert.strictEqual(pickCaptureDevice(DEVS, "system").capture, 1);
});

test("loopbackPattern é um regex válido em toda plataforma conhecida", () => {
  for (const os of ["macos", "windows", "linux", undefined]) {
    assert.doesNotThrow(() => new RegExp(loopbackPattern(os), "i"));
  }
});

// #53 — regressão relatada em uso real: durante a gravação a voz do usuário
// chegava baixa do outro lado e o que ele ouvia ficava abafado. Causa: pedir o
// microfone com `{ audio: true }` liga o processamento de voz do sistema (eco +
// ganho automático + supressão de ruído), que no macOS troca o caminho de áudio
// da máquina inteira. Loro é gravador, não app de chamada: pede o sinal cru.
test("micConstraints desliga o processamento de voz do sistema", () => {
  const { audio } = require("../src/audio.js").micConstraints();
  assert.strictEqual(audio.echoCancellation, false);
  assert.strictEqual(audio.autoGainControl, false);
  assert.strictEqual(audio.noiseSuppression, false);
});

test("micConstraints preserva as três restrições ao fixar um dispositivo", () => {
  const { audio } = require("../src/audio.js").micConstraints("abc123");
  assert.deepStrictEqual(audio.deviceId, { exact: "abc123" });
  // o caminho com deviceId é o do áudio do sistema (loopback) — foi ele que
  // regrediu antes por ser montado à parte, então tem de carregar o mesmo cru
  assert.strictEqual(audio.echoCancellation, false);
  assert.strictEqual(audio.autoGainControl, false);
  assert.strictEqual(audio.noiseSuppression, false);
});

test("nenhum getUserMedia do app pede `{ audio: true }` cru", () => {
  const fs = require("fs"), path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  const cruas = [...src.matchAll(/getUserMedia\(\s*\{[^}]*\}/g)].map((m) => m[0]);
  assert.deepStrictEqual(cruas, [],
    "getUserMedia com objeto literal volta a ligar o processamento de voz:\n  " + cruas.join("\n  "));
});

// #53 — quem ouve por alto-falante precisa poder religar o cancelamento de eco:
// sem ele o microfone escuta os outros de volta. É escolha, não padrão, porque
// ligá-lo entrega o áudio da máquina ao processamento de voz do sistema.
// Diarização (WhisperX) roda via loro.sh/bash, que o Windows não tem por
// padrão — o único bash.exe de uma instalação comum é o do WSL, que enxerga
// outro sistema de arquivos e não acha o áudio salvo.
test("diarizeSupported: só recusa no Windows", () => {
  const { diarizeSupported } = require("../src/audio.js");
  assert.strictEqual(diarizeSupported("windows"), false);
  assert.strictEqual(diarizeSupported("macos"), true);
  assert.strictEqual(diarizeSupported("linux"), true);
  assert.strictEqual(diarizeSupported(undefined), true);
});

test("micConstraints religa SÓ o cancelamento de eco quando pedido", () => {
  const { micConstraints } = require("../src/audio.js");
  const { audio } = micConstraints(null, true);
  assert.strictEqual(audio.echoCancellation, true);
  // os dois que achatam a voz continuam desligados — não é isso que protege
  // contra o vazamento da caixa, e é isso que deixava o usuário baixo
  assert.strictEqual(audio.autoGainControl, false);
  assert.strictEqual(audio.noiseSuppression, false);
  assert.strictEqual(micConstraints(null, false).audio.echoCancellation, false);
  assert.strictEqual(micConstraints("dev1", true).audio.echoCancellation, true);
});
