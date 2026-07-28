// ADR-0008 — the vendored CM6 blob is a self-contained, CSP-safe IIFE that
// assigns window.LoroCM6. It is built by tools/vendor-cm6 (dev-only) and must
// never contain module-loader syntax, since the runtime has no bundler and the
// Tauri CSP forbids network/dynamic loading.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const BLOB = path.join(__dirname, "..", "src", "vendor", "cm6.js");

test("cm6 vendor blob exists (run `make vendor-cm6` to build)", () => {
  assert.ok(fs.existsSync(BLOB), `${BLOB} missing — build it with the vendor toolchain`);
});

test("cm6 blob is a self-contained IIFE with no module-loader syntax", () => {
  const src = fs.readFileSync(BLOB, "utf8");
  // A minified bundle carries token-name string literals (e.g. "AtKeyword
  // import charset") that defeat a raw-text scan, so assert the property that
  // actually matters: the blob compiles as a plain (non-module) script.
  // Top-level `import`/`export` are SyntaxErrors in that context, which is
  // exactly the CSP-safe, bundler-free guarantee we need — and would throw here.
  assert.doesNotThrow(() => new Function(src), "blob is not a valid non-module script (contains top-level import/export?)");
  // esbuild's IIFE output never opens with a module statement.
  assert.ok(!/^\s*(import|export)\b/.test(src), "blob starts with a module statement");
});

test("cm6 blob assigns the window.LoroCM6 global with a create factory", () => {
  const src = fs.readFileSync(BLOB, "utf8");
  assert.ok(src.includes("LoroCM6"), "blob does not reference LoroCM6");
  // Evaluate in a minimal window sandbox; the factory must materialize.
  const win = {};
  const fn = new Function("window", "self", "globalThis", "document", src + "\nreturn window.LoroCM6;");
  const api = fn(win, win, win, undefined);
  assert.ok(api && typeof api.create === "function", "window.LoroCM6.create is not a function");
});
