// Testes da seleção de dispositivo de captura (node --test). Sem dependências.
const test = require("node:test");
const assert = require("node:assert");
const { pickCaptureDevice } = require("../src/audio.js");

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
