// Testes da seleção de dispositivo de captura (node --test). Sem dependências.
const test = require("node:test");
const assert = require("node:assert");
const { pickCaptureDevice, loopbackPattern, clampVadThold, VAD_MIN, VAD_MAX, VAD_DEFAULT } = require("../src/audio.js");

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

// Sensibilidade do VAD. A regressão: o -vth ficava fixo em 0.6 (padrão do
// whisper.cpp), que exige uma queda acentuada de energia. Com som de fundo
// contínuo o gatilho nunca disparava e o app gravava sem transcrever nada.
test("o padrão do VAD é mais permissivo que o 0.6 que causava silêncio", () => {
  assert.strictEqual(clampVadThold(undefined), VAD_DEFAULT);
  assert.ok(VAD_DEFAULT > 0.6, `padrão ${VAD_DEFAULT} deve superar 0.6`);
});

test("um valor configurado dentro da faixa passa intacto", () => {
  for (const v of [0.3, 0.5, 0.85, 1]) assert.strictEqual(clampVadThold(v), v);
});

test("valor fora da faixa é preso, nunca chega ao whisper como está", () => {
  assert.strictEqual(clampVadThold(-1), VAD_MIN);
  assert.strictEqual(clampVadThold(12), VAD_MAX);
  assert.strictEqual(clampVadThold(0), VAD_MIN);
});

test("valor não-numérico cai no padrão", () => {
  for (const v of [null, undefined, "", "abc", NaN, {}]) {
    assert.strictEqual(clampVadThold(v), VAD_DEFAULT, `entrada ${String(v)}`);
  }
});

test("string numérica do slider é aceita", () => {
  assert.strictEqual(clampVadThold("0.75"), 0.75);
});
