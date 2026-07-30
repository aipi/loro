// Testes da seleção de dispositivo de captura (node --test). Sem dependências.
const test = require("node:test");
const assert = require("node:assert");
const { pickCaptureDevice, audioConstraints } = require("../src/audio.js");

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

// getUserMedia constraints (ADR-0010): noiseSuppression/autoGainControl SEMPRE
// desligados (ligados, o macOS entra em voice-processing/VPIO e abafa todo o
// áudio do sistema). echoCancellation é escolhido por fonte.
test("por padrão o DSP de voz vem desligado (sem deviceId)", () => {
  const c = audioConstraints();
  assert.strictEqual(c.audio.echoCancellation, false);
  assert.strictEqual(c.audio.noiseSuppression, false);
  assert.strictEqual(c.audio.autoGainControl, false);
  assert.strictEqual(c.audio.deviceId, undefined);
});

test("constraints com deviceId fixam o dispositivo (EC desligado p/ sistema)", () => {
  const c = audioConstraints("bh-123");
  assert.deepStrictEqual(c.audio.deviceId, { exact: "bh-123" });
  assert.strictEqual(c.audio.echoCancellation, false);
  assert.strictEqual(c.audio.noiseSuppression, false);
  assert.strictEqual(c.audio.autoGainControl, false);
});

// mic-só: EC ligado (única forma de o WebKit alimentar o mic ao Web Audio),
// mas NS/AGC seguem desligados (não reintroduzir o abafamento/processamento).
test("echoCancellation:true liga só o EC, mantendo NS/AGC desligados", () => {
  const c = audioConstraints(undefined, { echoCancellation: true });
  assert.strictEqual(c.audio.echoCancellation, true);
  assert.strictEqual(c.audio.noiseSuppression, false);
  assert.strictEqual(c.audio.autoGainControl, false);
});
