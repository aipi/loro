// Model-manager pure helpers (ADR-0006).
const test = require("node:test");
const assert = require("node:assert");
const { formatSize, progressPercent, sortModels } = require("../src/modelui.js");

test("formatSize scales KB / MB / GB", () => {
  assert.strictEqual(formatSize(487601967), "465 MB"); // small
  assert.strictEqual(formatSize(1624555275), "1.5 GB"); // large-v3-turbo
  // ADR-0034 — the VAD model is the first sub-megabyte asset. Rounding it to
  // "1 MB" overstated 885 KB by ~15%, and the download button IS the price tag
  // (DESIGN.md §1: the state does not lie).
  assert.strictEqual(formatSize(885098), "864 KB");
  assert.strictEqual(formatSize(0), "0 KB");
});

test("progressPercent clamps and guards a zero total", () => {
  assert.strictEqual(progressPercent(0, 100), 0);
  assert.strictEqual(progressPercent(50, 100), 50);
  assert.strictEqual(progressPercent(100, 100), 100);
  assert.strictEqual(progressPercent(200, 100), 100); // never over 100
  assert.strictEqual(progressPercent(10, 0), 0); // unknown total
});

test("sortModels puts the recommended model first without mutating input", () => {
  const input = [
    { id: "small", default: false },
    { id: "large-v3-turbo", default: true },
  ];
  const out = sortModels(input);
  assert.strictEqual(out[0].id, "large-v3-turbo");
  assert.strictEqual(out[1].id, "small");
  assert.strictEqual(input[0].id, "small"); // input untouched
});

// --- as peças da voz clonada no MESMO gerenciador (ADR-0036) -----------------

const MU = require("../src/modelui.js");

const VSTATUS = {
  supported: true,
  ready: false,
  remainingBytes: 183582333,
  parts: [
    { id: "engine", label: "motor de voz (sherpa-onnx)", size: 20262139, installed: true },
    { id: "model", label: "modelo de voz (ZipVoice)", size: 109162785, installed: false },
    { id: "vocoder", label: "vocoder", size: 54157409, installed: false },
  ],
};

test("as peças da voz entram na MESMA forma de uma linha de modelo", () => {
  const rows = MU.voiceRows(VSTATUS);
  assert.strictEqual(rows.length, 3);
  for (const r of rows) {
    // a tela desenha "algo grande para baixar" de um jeito só
    assert.ok(typeof r.label === "string" && r.label.length > 0);
    assert.ok(typeof r.sizeBytes === "number");
    assert.ok(typeof r.installed === "boolean");
    assert.strictEqual(r.default, false, "peça de voz não é modelo recomendado");
  }
  assert.strictEqual(rows[0].installed, true);
  assert.strictEqual(rows[1].installed, false);
});

// O prefixo é o que decide QUEM atende o download — sem ele o botão chamaria o
// catálogo do whisper com o id de uma peça de voz.
test("o prefixo distingue a origem do download", () => {
  const rows = MU.voiceRows(VSTATUS);
  assert.strictEqual(MU.isVoicePart(rows[0].id), true);
  assert.strictEqual(MU.voicePartOf(rows[0].id), "engine");
  assert.strictEqual(MU.isVoicePart("small"), false);
  assert.strictEqual(MU.isVoicePart("large-v3-turbo"), false);
  assert.strictEqual(MU.voicePartOf("small"), "");
});

test("o id da linha e a peça do progresso são o mesmo", () => {
  assert.strictEqual(MU.voiceRowId("vocoder"), MU.voiceRows(VSTATUS)[2].id);
});

// Oferecer o que não instala é pior que não oferecer.
test("plataforma sem suporte não oferece peça nenhuma", () => {
  assert.deepStrictEqual(MU.voiceRows({ supported: false, parts: VSTATUS.parts }), []);
  assert.deepStrictEqual(MU.voiceRows(null), []);
  assert.deepStrictEqual(MU.voiceRows({ supported: true }), []);
});

// As peças convivem com os modelos sem perturbar a ordem deles: o recomendado
// continua primeiro.
test("a mistura não tira o modelo recomendado do topo", () => {
  const models = [
    { id: "small", label: "Small", sizeBytes: 1, installed: true, default: false },
    { id: "large-v3-turbo", label: "Turbo", sizeBytes: 2, installed: true, default: true },
  ];
  const sorted = MU.sortModels(models.concat(MU.voiceRows(VSTATUS)));
  assert.strictEqual(sorted[0].id, "large-v3-turbo");
  assert.strictEqual(sorted.length, 5);
});
