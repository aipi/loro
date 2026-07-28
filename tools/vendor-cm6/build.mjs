// ADR-0008 — dev-only build step. Bundles src/index.js (CodeMirror 6) into a
// single committed IIFE at desktop/src/vendor/cm6.js (+ cm6.css if the bundle
// emits any style). Run via `make vendor-cm6`. NEVER shipped; the running app
// only loads the produced blob, never this toolchain.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(here, "../../desktop/src/vendor/cm6.js");

const result = await build({
  entryPoints: [resolve(here, "src/index.js")],
  bundle: true,
  format: "iife",
  minify: true,
  target: "es2020",
  legalComments: "none",
  outfile,
  // CM6 ships its base editor CSS via JS-injected StyleModule, so a separate
  // stylesheet is normally empty; emit it anyway for a stable load contract.
  metafile: false,
});

// esbuild writes an adjacent cm6.css only when the bundle contains real CSS.
// Guarantee the file exists so index.html can reference it unconditionally.
const cssOut = outfile.replace(/\.js$/, ".css");
if (!existsSync(cssOut)) {
  writeFileSync(
    cssOut,
    "/* ADR-0008 — CM6 injects its own base styles at runtime via StyleModule; " +
      "this file is a stable placeholder so index.html can load it unconditionally. */\n"
  );
}

if (result.warnings.length) {
  for (const w of result.warnings) console.warn(w.text);
}
console.log(`vendor-cm6: wrote ${outfile}`);
