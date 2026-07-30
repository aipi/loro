// Model-manager pure helpers (ADR-0006).
const test = require("node:test");
const assert = require("node:assert");
const { formatSize, progressPercent, sortModels } = require("../src/modelui.js");

test("formatSize shows MB under a gigabyte and GB above", () => {
  assert.strictEqual(formatSize(487601967), "465 MB"); // small
  assert.strictEqual(formatSize(1624555275), "1.5 GB"); // large-v3-turbo
  assert.strictEqual(formatSize(0), "0 MB");
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
