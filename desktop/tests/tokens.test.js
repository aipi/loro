// Design-system guard over desktop/src/style.css (DESIGN.md §3, §6, §9).
//
// The stylesheet is the source of truth for the palette ("when DESIGN.md and the
// code disagree the code wins"), so this suite parses it, resolves every custom
// property for BOTH themes — including values built with var() chains and
// color-mix() over another token — and asserts the pairings the app actually
// paints against WCAG 2.1 AA.
//
// Three floors, all of them measured here: 4.5:1 for text, 3:1 for the boundary
// of a control (1.4.11) and 3:1 for a focus ring against the surface it lands on.
// The boundary and focus rows read the colour the stylesheet really declares for
// a selector — the first version of this suite asserted the 3:1 floor in a
// comment and measured no border at all, so every text field in the app sat at
// ~1.2:1 while the suite was green.
//
// It also guards the structural rules the design system kept losing: no colour
// literal outside the token blocks, every animation wrapped for
// prefers-reduced-motion, every elevation from a --sh-* token, prose never set in
// the machine's font, and DESIGN.md's colour table matching the code it claims to
// be taken from.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const CSS_PATH = path.join(__dirname, "..", "src", "style.css");
const CSS = fs.readFileSync(CSS_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/* ---------- a minimal, brace-aware CSS reader ---------- */

// Returns a flat list of { at: [prelude…], sel, body, keyframes } — at-rules are
// descended into (so a rule inside @media keeps its ancestry) except @keyframes,
// whose body stays opaque.
function readRules(css, at = []) {
  const out = [];
  let i = 0;
  let prelude = "";
  while (i < css.length) {
    const c = css[i];
    if (c !== "{") {
      prelude += c;
      i++;
      continue;
    }
    let depth = 1;
    let j = i + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    const body = css.slice(i + 1, j - 1);
    const sel = prelude.trim().replace(/\s+/g, " ");
    if (sel.startsWith("@")) {
      if (/^@keyframes/.test(sel)) out.push({ at, sel, body, keyframes: true });
      else out.push(...readRules(body, at.concat(sel)));
    } else if (sel) {
      out.push({ at, sel, body, keyframes: false });
    }
    prelude = "";
    i = j;
  }
  return out;
}

// Declarations of one rule body, split at top level (a ";" or ":" inside
// var()/color-mix() parentheses is not a separator). Each entry is
// [property, value, important]: `!important` is stripped from the value — a
// reader that kept it inside the value could resolve neither the colour nor the
// keyword, so `outline: none !important` read as "says nothing" and the sheet's
// own priority was invisible to every measurement here (R21).
function readDecls(body) {
  const out = [];
  let depth = 0;
  let cur = "";
  const push = (chunk) => {
    let d = 0;
    for (let k = 0; k < chunk.length; k++) {
      const ch = chunk[k];
      if (ch === "(") d++;
      else if (ch === ")") d--;
      else if (ch === ":" && d === 0) {
        const raw = chunk.slice(k + 1).trim();
        const important = /!\s*important$/i.test(raw);
        out.push([
          chunk.slice(0, k).trim(),
          important ? raw.replace(/!\s*important$/i, "").trim() : raw,
          important,
        ]);
        return;
      }
    }
  };
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === ";" && depth === 0) {
      push(cur);
      cur = "";
    } else cur += ch;
  }
  push(cur);
  return out.filter(([k, v]) => k && v);
}

const RULES = readRules(CSS);

// Every declaration the sheet ends up carrying for one selector in one context,
// folded in source order (later wins) — the cascade among selectors of equal
// specificity, which is what these rules are.
function declsOf(sel, context = null) {
  const out = new Map();
  for (const r of RULES) {
    if (r.keyframes) continue;
    if ((r.at.join(" ") || null) !== context) continue;
    if (!r.sel.split(",").some((s) => s.trim() === sel)) continue;
    for (const [k, v] of readDecls(r.body)) out.set(k, v.trim());
  }
  return out;
}

const ROOT_LIGHT = ":root";
const ROOT_DARK = ':root[data-theme="dark"]';
const isRootSel = (sel) =>
  sel.split(",").some((s) => s.trim() === ROOT_LIGHT || s.trim() === ROOT_DARK);

// Token map per theme: every top-level :root block applies to both themes, the
// dark block only to dark, in source order (later wins) — exactly the cascade.
function tokensFor(theme) {
  const map = {};
  for (const r of RULES) {
    if (r.at.length || r.keyframes) continue;
    const sels = r.sel.split(",").map((s) => s.trim());
    const light = sels.includes(ROOT_LIGHT);
    const dark = sels.includes(ROOT_DARK);
    if (!light && !(dark && theme === "dark")) continue;
    for (const [k, v] of readDecls(r.body)) if (k.startsWith("--")) map[k] = v;
  }
  return map;
}

const TOKENS = { light: tokensFor("light"), dark: tokensFor("dark") };

/* ---------- colour resolution ---------- */

const TRANSPARENT = { r: 0, g: 0, b: 0, a: 0 };

function fromHex(h) {
  let s = h.slice(1);
  if (s.length === 3 || s.length === 4) s = s.split("").map((c) => c + c).join("");
  const n = (i) => parseInt(s.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: s.length === 8 ? n(6) / 255 : 1 };
}

// Splits "a, b, c" at top level.
function splitArgs(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function resolve(expr, theme) {
  const v = String(expr).trim();
  if (!v) throw new Error("empty colour expression");
  if (v === "transparent") return TRANSPARENT;
  if (v.startsWith("#")) return fromHex(v);

  if (v.startsWith("var(")) {
    const args = splitArgs(v.slice(4, -1));
    const name = args[0].trim();
    const own = TOKENS[theme][name];
    if (own !== undefined) return resolve(own, theme);
    if (args.length > 1) return resolve(args.slice(1).join(","), theme);
    throw new Error(`unresolved token ${name} (${theme})`);
  }

  const rgb = v.match(/^rgba?\(([^)]*)\)$/i);
  if (rgb) {
    const p = splitArgs(rgb[1].replace(/\//g, " ")).flatMap((x) => x.split(/\s+/));
    const n = p.map(Number);
    return { r: n[0], g: n[1], b: n[2], a: p.length > 3 ? n[3] : 1 };
  }

  if (v.startsWith("color-mix(")) {
    const args = splitArgs(v.slice(10, -1));
    assert.match(args[0].trim(), /^in srgb$/, `only srgb mixing is modelled: ${v}`);
    const parse = (s) => {
      const m = s.trim().match(/^(.*?)(?:\s+([\d.]+)%)?$/s);
      return { color: resolve(m[1].trim(), theme), pct: m[2] === undefined ? null : Number(m[2]) / 100 };
    };
    const a = parse(args[1]);
    const b = parse(args[2]);
    let pa = a.pct, pb = b.pct;
    if (pa === null && pb === null) pa = pb = 0.5;
    else if (pa === null) pa = 1 - pb;
    else if (pb === null) pb = 1 - pa;
    // CSS Color 5: mixing happens on premultiplied channels.
    const alpha = a.color.a * pa + b.color.a * pb;
    const ch = (k) =>
      alpha === 0 ? 0 : (a.color[k] * a.color.a * pa + b.color[k] * b.color.a * pb) / alpha;
    return { r: ch("r"), g: ch("g"), b: ch("b"), a: alpha };
  }

  throw new Error(`unsupported colour expression: ${v}`);
}

// Paints a colour over an opaque backdrop (simple source-over compositing).
function over(color, backdrop) {
  const ch = (k) => color[k] * color.a + backdrop[k] * (1 - color.a);
  return { r: ch("r"), g: ch("g"), b: ch("b"), a: 1 };
}

const channel = (v) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const luminance = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);

function contrast(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

const hexOf = (c) =>
  "#" + ["r", "g", "b"].map((k) => Math.round(c[k]).toString(16).padStart(2, "0")).join("");

// Stack: opaque base first, then every layer painted on top.
function surface(layers, theme) {
  return layers.reduce((bg, layer) => over(resolve(layer, theme), bg), { r: 0, g: 0, b: 0, a: 1 });
}

function ratio(theme, fgExpr, layers) {
  const bg = surface(layers, theme);
  return contrast(over(resolve(fgExpr, theme), bg), bg);
}

const round2 = (n) => Math.round(n * 100) / 100;

/* ---------- the maths itself must be right ---------- */

test("contrast maths matches the WCAG 2.1 anchors", () => {
  const light = "light";
  assert.equal(round2(ratio(light, "#767676", ["#ffffff"])), 4.54);
  assert.equal(round2(ratio(light, "#000000", ["#ffffff"])), 21.0);
  assert.equal(round2(ratio(light, "#ffffff", ["#ffffff"])), 1.0);
  assert.equal(round2(ratio(light, "#0e8c86", ["#ffffff"])), 4.11); // the old teal fill
  assert.equal(round2(ratio(light, "#97938a", ["#ffffff"])), 3.06); // the old --muted
});

test("alpha and color-mix resolution matches the values the browser computes", () => {
  // 50% black over white is mid grey…
  assert.equal(hexOf(surface(["#ffffff", "color-mix(in srgb, #000000 50%, transparent)"], "light")), "#808080");
  // …and the documented --side is white 55% over paper.
  assert.equal(hexOf(surface(["var(--side)"], "light")), "#fdfdfb");
  assert.equal(hexOf(surface(["var(--paper)"], "dark")), "#211e19");
  // var() fallbacks and chains resolve (--accent falls back to the theme teal).
  assert.equal(hexOf(surface(["var(--accent, var(--teal))"], "dark")), hexOf(surface(["var(--teal)"], "dark")));
});

/* ---------- the pairings the app paints ---------- */

// Each row: what the app draws, the colour token, the surface stack under it and
// the WCAG floor (4.5:1 for text, 3:1 for a control's only visual boundary).
const PAIRINGS = [
  // body and secondary text
  ["body text (.doc, .bitem) on paper", "var(--ink)", ["var(--paper)"], 4.5],
  ["body text on a card (.cfgcard, .doccard)", "var(--ink)", ["var(--panel)"], 4.5],
  ["body text on the sidebar", "var(--ink)", ["var(--side)"], 4.5],
  ["secondary text (.chatans, .depmsg) on paper", "var(--ink2)", ["var(--paper)"], 4.5],
  ["secondary text on a card", "var(--ink2)", ["var(--panel)"], 4.5],
  ["tertiary text (.hgreet p, .dest, .chip) on paper", "var(--ink3)", ["var(--paper)"], 4.5],
  ["tertiary text on a card", "var(--ink3)", ["var(--panel)"], 4.5],
  ["tertiary text on the sidebar", "var(--ink3)", ["var(--side)"], 4.5],
  // captions: .mono, .hint, .orgempty, .chatempty, .pempty span, .recnote, .mc-s
  ["captions (--muted) on paper", "var(--muted)", ["var(--paper)"], 4.5],
  ["captions (--muted) on a card", "var(--muted)", ["var(--panel)"], 4.5],
  ["captions (--muted) on the sidebar", "var(--muted)", ["var(--side)"], 4.5],

  // filled controls — one primary action per screen, and it must be readable
  [".btn.solid label", "var(--on-teal)", ["var(--paper)", "var(--accent, var(--teal))"], 4.5],
  [".btn.solid.amber label (first-run 'Instalar agora')", "var(--on-solid)", ["var(--paper)", "var(--yellow)"], 4.5],
  [".abtn.cta / .railbtn.cta label", "var(--on-teal)", ["var(--paper)", "var(--accent, var(--teal))"], 4.5],
  [".sendbtn glyph", "var(--on-teal)", ["var(--panel)", "var(--accent, var(--teal))"], 4.5],
  [".mtgpill label", "var(--on-teal)", ["var(--paper)", "var(--accent, var(--teal))"], 4.5],
  [".recbtn label (Gravar)", "var(--on-red)", ["var(--paper)", "var(--red)"], 4.5],
  [".btn-danger label (destructive confirm)", "var(--on-red)", ["var(--panel)", "var(--red)"], 4.5],
  [".primary / .segbtn.on / .tab.on label", "var(--paper)", ["var(--paper)", "var(--ink)"], 4.5],
  [".recbtn.recording label", "var(--paper)", ["var(--paper)", "var(--ink)"], 4.5],

  // header navigation
  ["active nav destination (.dest.on)", "var(--on-accent)", ["var(--panel)", "var(--accent)"], 4.5],
  ["idle nav destination (.dest)", "var(--ink3)", ["var(--panel)"], 4.5],

  // the pending counters — a numeral whose only job is to be read
  ["queue counter badge (.destbadge, .cbadge)", "var(--on-solid)", ["var(--panel)", "var(--yellow)"], 4.5],
  ["collapsed-rail counter (.minibadge)", "var(--on-solid)", ["var(--paper)", "var(--yellow)"], 4.5],
  // on the ACTIVE destination the counter sits on the accent fill, so it wears the
  // accent's own pair inverted (amber-on-amber vanished with the amber accent)
  ["queue counter on the active destination (.dest.on .destbadge)", "var(--accent)",
    ["var(--panel)", "var(--accent)", "var(--on-accent)"], 4.5],

  // semantic colours used as text
  ["teal as text (.mc-t.teal, .chatans .src) on paper", "var(--teal)", ["var(--paper)"], 4.5],
  ["teal as text on a card", "var(--teal)", ["var(--panel)"], 4.5],
  ["teal as text on the sidebar", "var(--teal)", ["var(--side)"], 4.5],
  ["teal as text on its own 8% tint (.armedchip, .rowgen)", "var(--teal)",
    ["var(--paper)", "color-mix(in srgb, var(--teal) 8%, transparent)"], 4.5],
  ["teal as text on its own 10% tint (.cfgnavbtn.on)", "var(--teal)",
    ["var(--side)", "color-mix(in srgb, var(--teal) 10%, transparent)"], 4.5],
  ["amber as text (.pendingbar b, .g-mod .bn) on paper", "var(--yellow-ink)", ["var(--paper)"], 4.5],
  ["amber as text on a card", "var(--yellow-ink)", ["var(--panel)"], 4.5],
  ["amber as text on the sidebar", "var(--yellow-ink)", ["var(--side)"], 4.5],
  ["amber on its own 14% tint (#navPessoal .bitem.on, .reftipo)", "var(--yellow-ink)",
    ["var(--side)", "color-mix(in srgb, var(--yellow) 14%, transparent)"], 4.5],
  ["amber on its own 8% tint (.pillamber)", "var(--yellow-ink)",
    ["var(--panel)", "color-mix(in srgb, var(--yellow) 8%, transparent)"], 4.5],
  ["amber on its own 12% tint (.doc .mtg-src)", "var(--yellow-ink)",
    ["var(--paper)", "color-mix(in srgb, var(--yellow) 12%, transparent)"], 4.5],
  // R19 — "encerrar reunião" on an interrupted meeting's tree row (pending, not AI)
  ["amber on its own 10% tint (.rowgen.warn)", "var(--yellow-ink)",
    ["var(--side)", "color-mix(in srgb, var(--yellow) 10%, transparent)"], 4.5],
  ["amber on its own 18% tint (.rowgen.warn:hover)", "var(--yellow-ink)",
    ["var(--side)", "color-mix(in srgb, var(--yellow) 18%, transparent)"], 4.5],
  ["failed agent step marker (details.chatstep.failed .st)", "var(--yellow-ink)", ["var(--paper)"], 4.5],
  ["untracked filename (.g-new .bn) on the sidebar", "var(--green)", ["var(--side)"], 4.5],
  ["untracked filename on paper", "var(--green)", ["var(--paper)"], 4.5],
  ["red as text (.hint.err, .headrec) on paper", "var(--red)", ["var(--paper)"], 4.5],
  ["red as text on a card", "var(--red)", ["var(--panel)"], 4.5],
  ["red on its own 7% tint (.headrec, .mtgrec)", "var(--red)",
    ["var(--paper)", "color-mix(in srgb, var(--red) 7%, transparent)"], 4.5],
  ["destructive text (.ulink.danger) on paper", "var(--danger)", ["var(--paper)"], 4.5],
  ["destructive text on a card", "var(--danger)", ["var(--panel)"], 4.5],

  // the two chips that landed just under the line: the tint recipe (a % of ink
  // or red over the surface) is part of the pairing, not decoration
  ['.pill.soft "novo" on the sidebar', "var(--ink3)",
    ["var(--side)", "color-mix(in srgb, var(--ink) 5%, transparent)"], 4.5],
  ['.pill.soft "novo" on a card', "var(--ink3)",
    ["var(--panel)", "color-mix(in srgb, var(--ink) 5%, transparent)"], 4.5],
  ['.pill.soft "novo" on paper', "var(--ink3)",
    ["var(--paper)", "color-mix(in srgb, var(--ink) 5%, transparent)"], 4.5],
  ["tab close × on hover (.wstab .wsclose:hover) over the strip", "var(--red)",
    ["color-mix(in srgb, var(--panel) 55%, var(--paper))",
      "color-mix(in srgb, var(--red) 8%, transparent)"], 4.5],
  ["tab close × on hover over the active tab", "var(--red)",
    ["var(--paper)", "color-mix(in srgb, var(--red) 8%, transparent)"], 4.5],

  // live controls that used to be painted with the disabled token
  ["tab close × (.wstab .wsclose)", "var(--ink3)", ["var(--paper)"], 4.5],
  ["palette shortcut hint (.cmdk-k)", "var(--muted)", ["var(--panel)"], 4.5],
  ["palette esc affordance (.cmdk-esc)", "var(--muted)", ["var(--panel)"], 4.5],
  ["chat step disclosure caret (details.chatstep > summary::after)", "var(--ink3)", ["var(--paper)"], 3],

  // the terminal keeps one fixed palette in both themes
  ["terminal output (--term-fg)", "var(--term-fg)", ["var(--term-bg)"], 4.5],
  ["terminal captions (--term-dim)", "var(--term-dim)", ["var(--term-bg)"], 4.5],
  ["terminal session name (--term-ok)", "var(--term-ok)", ["var(--term-bg)"], 4.5],
  ["terminal 'encerrar' (--term-danger)", "var(--term-danger)", ["var(--term-bg)"], 4.5],
];

for (const theme of ["light", "dark"]) {
  test(`every pairing the app paints clears WCAG 2.1 AA — ${theme} theme`, () => {
    const failures = [];
    for (const [what, fg, layers, min] of PAIRINGS) {
      let r;
      try {
        r = ratio(theme, fg, layers);
      } catch (e) {
        failures.push(`${what}: ${e.message}`);
        continue;
      }
      if (r < min) {
        failures.push(
          `${what}: ${fg} on ${hexOf(surface(layers, theme))} = ${round2(r)}:1 (needs ${min}:1)`,
        );
      }
    }
    assert.deepEqual(failures, [], `\n  ${failures.join("\n  ")}\n`);
  });
}

/* ---------- boundaries and focus rings (WCAG 2.1 AA 1.4.11) ---------- */

// The rows below name a SELECTOR instead of a token, and the colour comes from
// the declaration the stylesheet really carries: the previous table asserted a
// 3:1 floor for "a control's only visual boundary" and measured none, so every
// text field in the app sat at ~1.2:1 while the suite was green.

// The last colour expression in a value — `var(--x)`, `var(--x, var(--y))` or a
// literal. Balanced-paren scan, so a nested fallback is not cut in half.
function lastColour(value) {
  let found = null;
  for (let i = 0; i < value.length; i++) {
    if (value.startsWith("var(", i)) {
      let depth = 0;
      let j = i + 3;
      for (; j < value.length; j++) {
        if (value[j] === "(") depth++;
        else if (value[j] === ")" && --depth === 0) break;
      }
      found = value.slice(i, j + 1);
      i = j;
      continue;
    }
    if (value[i] === "#") {
      const m = /^#[0-9a-fA-F]{3,8}/.exec(value.slice(i));
      if (m) {
        found = m[0];
        i += m[0].length - 1;
      }
    }
  }
  return found;
}

// R17 — the first version of this reader only ever REMEMBERED a colour, so `border: none` on a
// later rule was invisible to it, and it skipped every rule inside an at-rule, so
// an override in a @media/@container block was invisible too: a mutation that
// stripped the border off three field-shaped controls, and one that dropped two
// of them to a 1.19:1 hairline inside @media, both kept the suite fully green.
// A boundary declaration is therefore one of four things — a colour, a REMOVAL,
// an off-system colour, or nothing — and the sheet is read once per context it
// can be read in. The two ways still open when this round re-audited the suite by
// mutation (each mutation applied to a copy of the sheet, the suite expected to go
// red): a per-side removal (`border-left-width: 0`) named a property the list did
// not carry, and a boundary painted with a KEYWORD (`border-color: transparent`,
// `border: 1px solid white`, or a shorthand with no colour at all, which means
// currentColor) carried no colour this parser could see, so the declaration was
// skipped and the previous value stood.
const BOUNDARY_PROP =
  /^border(-(top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?(-(width|style|color))?$/;
const BORDER_STYLE = /^(none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)$/i;

function borderDecl(prop, value) {
  const v = value.trim();
  if (/^(none|hidden)$/i.test(v)) return { removed: v };
  if (!/-color$/.test(prop) && /(^|\s)0(px|em|rem|%)?(\s|$)/.test(v)) return { removed: v };
  const colour = lastColour(v);
  if (colour) return { colour };
  if (/-(width|style)$/.test(prop)) return null; // says nothing about the colour
  // whatever is left once the width and the style are taken out IS the colour:
  // a keyword the token system does not own, or nothing (i.e. currentColor)
  const rest = v.split(/\s+/).filter((w) => w && !/^[\d.]+(px|em|rem|%)?$/.test(w) && !BORDER_STYLE.test(w));
  return { offSystem: rest.length ? rest.join(" ") : "currentColor" };
}

// A border has four sides and the sheet writes them separately (`border: …` then
// `border-top: none`), so the fold below is per side: the box is judged CLOSED or
// not, instead of by whichever declaration came last.
const SIDES = ["top", "right", "bottom", "left"];
const sidesOf = (prop) => {
  const m = /^border-(top|right|bottom|left)(-(width|style|color))?$/.exec(prop);
  return m ? [m[1]] : SIDES;
};

// The base cascade, plus the base as overridden by each at-rule block: a media
// query or container query that matches comes later in the sheet, so it wins, and
// the boundary has to hold at every width the app can be used at.
const AT_CONTEXTS = [null, ...new Set(RULES.filter((r) => r.at.length && !r.keyframes).map((r) => r.at.join(" ")))];

// Every declaration that can paint this control's boundary in `context`: the ones
// whose selector IS the guarded one (the cascade among equals, later wins) and the
// ones that are the guarded selector with extra ancestors on their left
// (`#cfgWrap .cfgcard .field select`). Those have HIGHER specificity, so they win
// wherever they sit in the sheet, which is exactly how a weakened border sneaks
// back in — the third hole the mutation audit found. A pseudo-class state
// (:hover, :disabled) is a different question from the rest state this floor is
// about, and does not take part.
function boundaryDecls(sel, context) {
  const out = [];
  for (const r of RULES) {
    if (r.keyframes) continue;
    const at = r.at.join(" ");
    if (at && at !== context) continue;
    const own = r.sel.split(",").map((s) => s.trim());
    const exact = own.some((s) => s === sel);
    const deeper = own.find((s) => s.endsWith(" " + sel) || s.endsWith(">" + sel));
    if (!exact && !deeper) continue;
    for (const [k, v, important] of readDecls(r.body)) {
      if (!BOUNDARY_PROP.test(k)) continue;
      const d = borderDecl(k, v);
      if (d) out.push({ ...d, via: exact ? null : deeper, prop: k, value: v.trim(), important });
    }
  }
  // the fold that follows is "later wins", which is only the cascade among
  // declarations of equal priority: an !important one wins wherever it sits
  return [...out.filter((d) => !d.important), ...out.filter((d) => d.important)];
}

// A text field's box IS its affordance: nothing else on screen says "you can
// type here", so 1.4.11 applies to the border, against the surface it sits on
// AND against its own fill.
const BOUNDARIES = [
  // Configurações
  [".cfgcard input[type=\"text\"]", "text field in Configurações", ["var(--panel)"]],
  [".cfgcard .field input[type=\"text\"]", "text field in Configurações (grid rule)", ["var(--panel)"]],
  [".cfgcard .field select", "select in Configurações", ["var(--panel)"]],
  [".cfgcard .field .dirinfo", "folder value in Configurações", ["var(--panel)"]],
  // first run
  [".wizcard .wfield input", "first-run text field", ["var(--panel)"]],
  [".wizcard .wfield input", "first-run text field, against its own fill", ["var(--paper)"]],
  [".wizcard .wfield select", "first-run select", ["var(--panel)"]],
  [".wizcard .wfield .dirbtn", "first-run folder picker", ["var(--panel)"]],
  // modals, menus and the rest of the app
  [".wfield", "field row in a modal sheet", ["var(--paper)"]],
  [".sheet .field", "field row in the recording sheet", ["var(--paper)"]],
  [".field select", "select in a menu", ["var(--panel)"]],
  [".mini-select", "compact select (rails, meeting rows)", ["var(--panel)"]],
  [".mini-select", "compact select on paper", ["var(--paper)"]],
  [".dirbtn", "folder picker", ["var(--panel)"]],
  [".sidefilter", "sidebar search field", ["var(--side)"]],
  [".findbar", "find bar in a document", ["var(--paper)"]],
  [".edithost", "editor host (the writing surface)", ["var(--paper)"]],
  [".composerbox", "chat composer", ["var(--panel)"]],
  // the markdown bar is the top half of the writing box, so it carries the same
  // boundary; its bottom edge is deliberately open, because the editor host below
  // it closes the same card (one box, two rules — the 4th column says so)
  [".mdbar", "markdown bar (the top edge of the writing box)", ["var(--panel)"],
    "the .edithost under it closes the box"],
  // MEDIDO na rodada 3: o chip do rascunho («no rascunho ⎇ …», que abre a folha
  // dos rascunhos) e as ações rotuladas .mini.act («marcar como visto», «voltar
  // ao meu rascunho», «⧉ copiar link») tinham 1,16–1,28:1 de borda. Os dois são
  // anteriores ao destino, e a Revisão é a casa mais visível deles agora — a
  // 1.4.11 pede 3:1 da borda de um controle onde ela estiver.
  [".pbranch", "draft chip (opens the drafts sheet)", ["var(--panel)"]],
  [".pbranch", "draft chip on paper", ["var(--paper)"]],
  [".mini.act", "labelled row action (marcar como visto, copiar link, mover)", ["var(--panel)"]],
  [".mini.act", "labelled row action on the sidebar", ["var(--side)"]],
  // MEDIDO na rodada 3, no app rodando: a pílula de TODO `.btn` secundário media
  // 1,16:1 no escuro e 1,25:1 no claro contra o cartão, com o preenchimento
  // idêntico a ele (1,00:1) — nada marcava a caixa do «↗ Enviar para revisão do
  // time», do «pedir mudanças», do «só comentar» e da porta «abrir Configurações»
  // do estado vazio. A rodada 2 fez esta MESMA medição para os irmãos (.mini.act,
  // .pbranch) e o botão base ficou atrás; é ele que carrega a segunda metade do
  // fluxo primário do destino.
  [".btn", "secondary button (enviar para revisão, pedir mudanças, abrir Configurações)", ["var(--panel)"]],
  [".btn", "secondary button on paper (the empty state's door)", ["var(--paper)"]],
];

// A more specific rule may legitimately take a control's border away when the box
// MOVED — outward to the row that draws it, or inward to controls that draw their
// own. Each place the shipped sheet does that is named here, with where the box
// went; a new one fails this test until someone can say the same about it. That is
// the difference between a documented exception and a hole.
// `separator: true` says the line that is left is not a boundary at all but a
// rule between two rows, so its 1.2:1 hairline is the right colour for it.
const BOX_MOVED = new Map([
  [".wizcard .wfield", {
    why: "the first-run row is a separator: its input, select and folder picker each draw their own boundary, and all three are measured above",
    separator: true,
  }],
  [".sheet .field select", { why: "the .sheet .field row draws the box, and it is measured above" }],
  [".sheet .dirbtn", { why: "same row, same box" }],
  [".wfield .dirbtn", { why: "the .wfield row draws the box, and it is measured above" }],
  ["#wsBody.editing .edithost", {
    why: "editing: the markdown bar closes the top edge of the same card, in the same --line-control",
  }],
]);

// The four sides, folded in source order, then judged as a box: painted on every
// side, in a colour from the token system, clearing 3:1 on the surface it sits on.
// `allowOpen` is for the documented exceptions in BOX_MOVED — the box being open
// is the exception, the colour of whatever IS painted never is.
function judgeBox(decls, theme, layers, allowOpen = false) {
  const box = { top: null, right: null, bottom: null, left: null };
  for (const d of decls) for (const s of sidesOf(d.prop)) box[s] = d;
  const gone = SIDES.filter((s) => !box[s] || box[s].removed);
  if (!allowOpen) {
    if (gone.length === SIDES.length) return "the border is removed — the box IS the affordance";
    if (gone.length) {
      const how = gone.map((s) => (box[s] ? `${box[s].prop}: ${box[s].value}` : "never declared")).join(", ");
      return `the box is open on ${gone.join("/")} (${how})`;
    }
  }
  const painted = SIDES.filter((s) => box[s] && !box[s].removed);
  // an exception may leave a side to its neighbour; it may not leave NO side
  if (allowOpen && !painted.length && gone.length === SIDES.length && decls.some((d) => !d.via)) {
    return "the border is removed on every side — the box IS the affordance";
  }
  const off = painted.filter((s) => box[s].offSystem);
  if (off.length) {
    return `the boundary is painted with ${box[off[0]].offSystem}, outside the token system, so it cannot be measured`;
  }
  for (const s of painted) {
    const r = ratio(theme, box[s].colour, layers);
    if (r < 3) {
      return `${box[s].colour} on ${hexOf(surface(layers, theme))} = ${round2(r)}:1 (needs 3:1)`;
    }
  }
  return null;
}

for (const theme of ["light", "dark"]) {
  test(`every control boundary clears 3:1 — ${theme} theme`, () => {
    const failures = [];
    for (const context of AT_CONTEXTS) {
      const where = context ? ` inside ${context}` : "";
      for (const [sel, what, layers, openBecause] of BOUNDARIES) {
        const decls = boundaryDecls(sel, context);
        const own = decls.filter((d) => !d.via);
        if (!own.length) failures.push(`${what} (${sel})${where}: no border declared`);
        else {
          const bad = judgeBox(own, theme, layers, !!openBecause);
          if (bad) failures.push(`${what} (${sel})${where}: ${bad}`);
        }
        // and the same floor wherever a MORE SPECIFIC rule repaints it
        for (const via of new Set(decls.filter((d) => d.via).map((d) => d.via))) {
          const moved = BOX_MOVED.get(via);
          if (moved && moved.separator) continue;
          const bad = judgeBox(decls.filter((d) => d.via === via), theme, layers, !!moved);
          if (bad) failures.push(`${what}, painted by the more specific ${via}${where}: ${bad}`);
        }
      }
    }
    assert.deepEqual(failures, [], `\n  ${failures.join("\n  ")}\n`);
  });
}

// N21 (audit, round 7) — the rows above are an ALLOWLIST, the same shape that made
// the focus-ring guard unable to fail: a new field declaring `border: 1px solid
// var(--line)` paints a 1.25:1 boundary in light and 1.16:1 in dark (measured) and
// breaks nothing here. The token block already says it out loud — "the hairline
// tokens are separators (1.2:1) and cannot carry a control" — and only prose enforced
// it. This reads every rule that paints a border on a form element, whatever its
// selector, and asks it the same 3:1 the allowlist asks. `border: none` is not a
// failure: it means the box moved outward, and the row that draws it is above.
test("no form control's border is painted with a separator token (WCAG 1.4.11)", () => {
  const FIELD = /[\s>+~,(](input|textarea|select)\b/;
  const BORDER = /^border(-(top|right|bottom|left))?(-color)?$/;
  const failures = [];
  let read = 0;
  for (const r of RULES) {
    if (r.keyframes) continue;
    for (const s of r.sel.split(",").map((x) => x.trim())) {
      if (!FIELD.test(" " + s)) continue;
      for (const [k, v] of readDecls(r.body)) {
        if (!BORDER.test(k)) continue;
        const colour = lastColour(v);
        if (!colour) continue;
        read++;
        for (const theme of ["light", "dark"]) {
          for (const layers of [["var(--panel)"], ["var(--paper)"]]) {
            const got = ratio(theme, colour, layers);
            if (got < 3) {
              failures.push(
                `${s} { ${k}: ${v} } on ${hexOf(surface(layers, theme))} in ${theme} = ${round2(got)}:1 (needs 3:1)`,
              );
            }
          }
        }
      }
    }
  }
  assert.ok(read >= 3, "the scan must actually be reading the sheet's field borders");
  assert.deepEqual(failures, [], `\n  ${failures.join("\n  ")}\n`);
});

// A focus ring carries meaning, so it needs 3:1 against whatever it lands on —
// and `outline-offset` puts it OUTSIDE the control, on the surface behind it.
// Two surfaces in the app are inverted (the terminal is dark in both themes, the
// toast is painted with --ink), and the ring inherited the accent regardless.
const FOCUS_RINGS = [
  [":focus-visible", "on paper", ["var(--paper)"]],
  [":focus-visible", "on a card or the panel", ["var(--panel)"]],
  [":focus-visible", "on the sidebar", ["var(--side)"]],
  [".termpanel :focus-visible", "inside the terminal dock", ["var(--term-bg)"]],
  [".toastbtn:focus-visible", "on the end-of-meeting toast", ["var(--paper)", "var(--ink)"]],
  // R14 — the ring is measured above, but nothing checked that one is PAINTED:
  // `.wfield select { outline: none }` (0,1,1) beat the global `:focus-visible`
  // (0,1,0), so the control that decides where a recording lands had no focus
  // indicator at all — and a <select> has no caret to fall back on.
  // MIGRADO (rodada 4): o anel da linha do campo deixou de ser da FOLHA e passou
  // a ser da linha onde ela estiver (`.wfield:focus-within`) — a mesma asserção,
  // agora sobre um seletor que alcança a folha E o cartão do destino Revisão.
  [".wfield:focus-within", "on the field row of a sheet or a card", ["var(--panel)"]],
  [".wizcard .wfield select:focus-visible", "on a first-run select", ["var(--panel)"]],
  [".cfgcard .field select:focus-visible", "on a select in Configurações", ["var(--panel)"]],
  // N21 — the same hole, found by reading every outline declaration instead of an
  // allowlist: these two boxes switched the global ring off and painted nothing, so
  // the caret was the only sign of focus and their other controls (the find bar's
  // counter and ×, the send button) had none at all.
  [".findbar:focus-within", "on the find bar of a document", ["var(--panel)"]],
  [".composerbox:focus-within", "on the chat composer", ["var(--panel)"]],
];

// A ring that is DECLARED somewhere is not a ring that survives the cascade: the
// row below fails if the rule that paints it disappears (the reader would then
// fall back to the global :focus-visible, which is exactly what was overridden).
test("the controls that switch off the global outline paint one of their own", () => {
  for (const sel of [
    ".wfield:focus-within",
    ".wizcard .wfield select:focus-visible",
    ".cfgcard .field select:focus-visible",
    ".findbar:focus-within",
    ".composerbox:focus-within",
  ]) {
    const own = RULES.some(
      (r) => !r.keyframes && r.sel.split(",").some((s) => s.trim() === sel) &&
        readDecls(r.body).some(([k, v]) => k === "outline" && /solid/.test(v)),
    );
    assert.ok(own, `${sel} must declare a visible outline of its own (WCAG 2.4.7)`);
  }
});

// MEDIDO na rodada 3 (harness de teclado, os dois temas): das 40+ paradas de Tab
// do destino Revisão, EXATAMENTE DUAS não tinham indicador de foco nenhum —
// #revMsg («Descreva a mudança em uma linha») e #revDecisionMsg («um comentário
// para o time»), os dois campos de texto da tela. E os dois são para onde as duas
// recusas MANDAM o teclado: «descreva a mudança em uma linha antes de salvar» põe
// o foco no controle cujo foco não se vê. A causa é a mesma R14 de sempre —
// `.wfield input { outline: none }` (0,1,1) vence o `:focus-visible` global
// (0,1,0) — e o remendo estava preso à folha (`.sheet .wfield:focus-within`),
// enquanto estes dois campos moram num `.revcard`. O anel segue a CAIXA, não a
// tela em que ela aparece.
const WFIELD_HOMES = [
  [".sheet", "uma folha de confirmação (Novo rascunho, Enviar para revisão)"],
  [".revcard", "o cartão do destino Revisão (#revMsg, #revDecisionMsg)"],
];
test("um campo de texto tem anel de foco em TODA superfície onde ele vive (WCAG 2.4.7)", () => {
  // quem apaga o anel do campo: a regra que o teste R14 nomeia
  const apaga = RULES.some((r) => !r.keyframes &&
    r.sel.split(",").some((s) => /^\.wfield (input|select|textarea)$/.test(s.trim())) &&
    readDecls(r.body).some(([k, v]) => k === "outline" && /^(none|0)/.test(v.trim())));
  assert.ok(apaga, "a regra que apaga o anel do campo continua existindo — é ela que cria a dívida");

  // quem PINTA um anel para a linha do campo, e onde esse pintor alcança
  const pintores = [];
  for (const r of RULES) {
    if (r.keyframes || r.at.length) continue;
    for (const [k, v] of readDecls(r.body)) {
      if (!/^outline$/.test(k) || !/solid|dashed|dotted|double/.test(v)) continue;
      for (const s of r.sel.split(",").map((x) => x.trim())) {
        if (!/\.wfield[^ ]*:focus-within$/.test(s)) continue;
        pintores.push({ chain: s.replace(/:focus-within$/, "").split(/\s+/), colour: lastColour(v) });
      }
    }
  }
  assert.ok(pintores.length, "alguma regra tem de pintar o anel da linha do campo (WCAG 2.4.7)");
  const falhas = [];
  for (const [casa, onde] of WFIELD_HOMES) {
    // o pintor alcança esta casa quando a cadeia dele é sufixo de <casa> .wfield
    const alvo = [casa, ".wfield"];
    const alcanca = pintores.filter((p) =>
      p.chain.every((t, i) => alvo[alvo.length - p.chain.length + i] === t));
    if (!alcanca.length) { falhas.push(`${onde} (${casa} .wfield): nenhum anel pintado — WCAG 2.4.7`); continue; }
    for (const theme of ["light", "dark"]) {
      const r = ratio(theme, alcanca[0].colour, ["var(--panel)"]);
      if (r < 3) falhas.push(`${onde}: o anel mede ${round2(r)}:1 em ${theme} (piso 3:1)`);
    }
  }
  assert.deepEqual(falhas, [], `\n  ${falhas.join("\n  ")}\n`);
});

// R17 — read the same way as a boundary, and for the same reason: `outline: none`
// on a later rule, or inside a @media block, used to be invisible to a reader that
// only ever remembered a COLOUR. A ring the sheet switches off is not a ring,
// whichever rule switches it off.
// R21 — and `!important` was invisible to it too: the audit mutation
// `:focus-visible { outline: none !important; outline: 1.5px solid var(--accent) }`
// left the whole suite green while a browser applied the important one and painted
// no ring anywhere, because this reader took the LAST declaration. Priority is
// read now: an important declaration wins over every normal one.
function outlineState(sel, context) {
  const seen = { normal: null, important: null };
  for (const r of RULES) {
    if (r.keyframes) continue;
    const at = r.at.join(" ");
    if (at && at !== context) continue;
    if (!r.sel.split(",").some((s) => s.trim() === sel)) continue;
    for (const [k, v, important] of readDecls(r.body)) {
      if (!/^outline(-(color|style|width))?$/.test(k)) continue;
      const val = v.trim();
      const set = (s) => { seen[important ? "important" : "normal"] = s; };
      if (/^(none|hidden|transparent)$/i.test(val)) { set({ removed: val }); continue; }
      if (/^outline(-width)?$/.test(k) && /(^|\s)0(px|em|rem|%)?(\s|$)/.test(val)) {
        set({ removed: val });
        continue;
      }
      const c = lastColour(val);
      if (c) set({ colour: c });
    }
  }
  return seen.important || seen.normal;
}

for (const theme of ["light", "dark"]) {
  test(`every focus indicator clears 3:1 where it lands — ${theme} theme`, () => {
    const failures = [];
    for (const context of AT_CONTEXTS) {
      const where2 = context ? ` inside ${context}` : "";
      for (const [sel, where, layers] of FOCUS_RINGS) {
        const state = outlineState(sel, context) || outlineState(":focus-visible", context);
        if (!state) {
          failures.push(`focus ring ${where} (${sel})${where2}: no focus ring declared`);
          continue;
        }
        if (state.removed) {
          failures.push(
            `focus ring ${where} (${sel})${where2}: the ring is switched off (outline: ${state.removed}) — WCAG 2.4.7`,
          );
          continue;
        }
        const r = ratio(theme, state.colour, layers);
        if (r < 3) {
          failures.push(
            `focus ring ${where} (${sel})${where2}: ${state.colour} on ${hexOf(surface(layers, theme))} = ${round2(r)}:1 (needs 3:1)`,
          );
        }
      }
    }
    assert.deepEqual(failures, [], `\n  ${failures.join("\n  ")}\n`);
  });
}

// R3 — a reference inside a document was identified by COLOUR ALONE. WCAG G183
// lets colour be the only cue when it clears 3:1 against the surrounding text; the
// accent reaches 2.95:1 on --ink prose in light and 1.79:1 in dark, so it never
// qualified — in dark a link inside a paragraph read as ordinary prose. The
// underline it did have was :hover-only, so a keyboard reader never saw it at all.
test("a link inside a document is never identified by colour alone (WCAG 1.4.1)", () => {
  const accents = ["--accent", ...Object.keys(TOKENS.light).filter((k) => /^--accent-[a-z]+$/.test(k))];
  const weak = [];
  for (const theme of ["light", "dark"]) {
    for (const name of accents) {
      const r = contrast(resolve(`var(${name})`, theme), resolve("var(--ink)", theme));
      if (r < 3) weak.push(`${name} against the prose around it (${theme}) = ${round2(r)}:1`);
    }
  }
  assert.ok(weak.length, "no accent clears 3:1 against --ink — if one ever did, this rule could be argued");
  const base = declsOf(".doc a");
  const cue = `${base.get("text-decoration") || ""} ${base.get("text-decoration-line") || ""}`;
  assert.match(cue, /underline/, `colour is not enough (${weak[0]}), so the underline is permanent, not a hover reveal`);
  // and the cue itself has to be perceivable: the first attempt drew it at 60% of
  // the accent, which is 2.56:1 on paper in light — a cue nobody can see is none
  const paint = base.get("text-decoration-color");
  if (paint) {
    for (const theme of ["light", "dark"]) {
      const r = ratio(theme, paint, ["var(--paper)"]);
      assert.ok(r >= 3, `the underline is the cue, so it must be visible: ${paint} on paper in ${theme} = ${round2(r)}:1`);
    }
  }
  for (const sel of [".doc a:hover", ".doc a:focus-visible"]) {
    const d = declsOf(sel);
    assert.ok(
      [...d.keys()].some((k) => /^text-decoration/.test(k)),
      `${sel} must carry the cue too — it existed only on :hover, which a keyboard never reaches (WCAG 2.4.7)`,
    );
  }
});

/* ---------- the per-project accent palette (R1/R5) ---------- */

// A project's accent is the one colour a user may change, and it paints the
// single primary action (`.btn.solid`), the selected sidebar row, the dashed
// "add here" rows, the focus ring and every accent-as-text surface. The palette
// shipped as five raw hexes in app.js with no dark value and no ink of its own,
// so choosing a colour dropped the primary action's label to 2.67:1 while this
// suite stayed green (it only ever resolved `var(--accent, var(--teal))`, which
// is always the teal fallback in a stylesheet that never declares --accent).
//
// So the palette is measured HERE, whatever it is made of: every swatch, as a
// fill under its own ink and as text on every surface it lands on, in both
// themes. `swatchPaint()` reads the token pair when the palette is part of the
// token system and falls back to the raw hex + the frozen ink when it is not —
// the fallback IS the defect, and it fails loudly instead of being skipped.
const APP_JS = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");

function paletteEntries() {
  const m = APP_JS.match(/const PALETTE = \[([\s\S]*?)\n\];/);
  assert.ok(m, "app.js must declare the project palette (PALETTE)");
  const entries = [...m[1].matchAll(/\{([^}]*)\}/g)].map((e) => {
    const field = (k) => (e[1].match(new RegExp(k + ':\\s*"([^"]*)"')) || [])[1];
    return { id: field("id"), name: field("name"), hex: field("hex"), raw: e[1] };
  });
  assert.equal(entries.length, 6, "the palette is still the same six choices");
  return entries;
}

function swatchPaint(entry) {
  const key = entry.id || "teal";
  const fill = `--accent-${key}`;
  const ink = `--on-accent-${key}`;
  const declared = (name) => TOKENS.light[name] !== undefined;
  return {
    what: `${entry.name || key} swatch`,
    fill: declared(fill) ? `var(${fill})` : (entry.hex || "var(--teal)"),
    ink: declared(ink) ? `var(${ink})` : "var(--on-teal)",
  };
}

for (const theme of ["light", "dark"]) {
  test(`every project accent is readable as a fill and as text — ${theme} theme`, () => {
    const failures = [];
    for (const entry of paletteEntries()) {
      const s = swatchPaint(entry);
      const rows = [
        // the ONE primary action per screen, plus .abtn.cta/.railbtn.cta/.sendbtn/.mtgpill
        ["ink on the accent fill (.btn.solid label)", s.ink, ["var(--paper)", s.fill], 4.5],
        ["accent as text on paper (.doc .spk, .mini.act.ai)", s.fill, ["var(--paper)"], 4.5],
        ["accent as text on a card (.badge.ok, .doc a, .sheet .sect)", s.fill, ["var(--panel)"], 4.5],
        ["accent as text on the sidebar (.swico, .fitem2.on)", s.fill, ["var(--side)"], 4.5],
        // the selected row and the highlighted palette item paint a tint of the
        // accent and then write the accent on top of it
        ["accent on its own 13% tint (.bitem.on)", s.fill,
          ["var(--side)", `color-mix(in srgb, ${s.fill} 13%, transparent)`], 4.5],
        ["accent on its own 14% tint (.cmdk-item.on, .bitem.file.on)", s.fill,
          ["var(--panel)", `color-mix(in srgb, ${s.fill} 14%, transparent)`], 4.5],
        ["accent on its own 15% tint (.mini.on)", s.fill,
          ["var(--panel)", `color-mix(in srgb, ${s.fill} 15%, transparent)`], 4.5],
        // :focus-visible is a 1.5px accent outline 2px outside the control
        ["focus ring on paper", s.fill, ["var(--paper)"], 3],
        ["focus ring on a card", s.fill, ["var(--panel)"], 3],
        ["focus ring on the sidebar", s.fill, ["var(--side)"], 3],
      ];
      for (const [what, fg, layers, min] of rows) {
        let r;
        try {
          r = ratio(theme, fg, layers);
        } catch (e) {
          failures.push(`${s.what} — ${what}: ${e.message}`);
          continue;
        }
        if (r < min) {
          failures.push(
            `${s.what} — ${what}: ${fg} on ${hexOf(surface(layers, theme))} = ${round2(r)}:1 (needs ${min}:1)`,
          );
        }
      }
    }
    assert.deepEqual(failures, [], `\n  ${failures.join("\n  ")}\n`);
  });
}

test("the palette lives in the token system, not as raw hexes in app.js", () => {
  // `legacy` holds the hexes older installs PERSISTED (a stored key, resolved to
  // an identity); a hex that PAINTS is the defect.
  const offenders = paletteEntries()
    .filter((e) => /^#[0-9a-fA-F]{3,8}$/.test(e.hex || ""))
    .map((e) => `${e.name || e.id}: ${e.raw.trim()}`);
  assert.deepEqual(offenders, [], `a swatch defined in JS has no theme and no ink of its own:\n  ${offenders.join("\n  ")}`);
  for (const e of paletteEntries()) {
    const key = e.id || "teal";
    for (const token of [`--accent-${key}`, `--on-accent-${key}`]) {
      assert.ok(TOKENS.light[token] !== undefined, `style.css must declare ${token}`);
      assert.ok(TOKENS.dark[token] !== undefined, `${token} must have a dark value of its own`);
    }
  }
});

test("a colour persisted by an older install still resolves to a palette identity", () => {
  const table = APP_JS.match(/const PALETTE = \[[\s\S]*?\n\];/)[0];
  const fn = APP_JS.match(/function accentId\(stored\)[\s\S]*?\n\}/)[0];
  // eslint-disable-next-line no-new-func
  const accentId = new Function(`${table}\nreturn (${fn});`)();
  assert.equal(accentId("#bf8700"), "amber", "the hex older installs persisted still names its colour");
  assert.equal(accentId("#2F6FEB"), "blue", "the disk does not care about case");
  assert.equal(accentId("pink"), "pink");
  assert.equal(accentId(""), "", "no colour chosen means the theme's teal");
  assert.equal(accentId(null), "");
  assert.equal(accentId("#123456"), "", "a value outside the palette falls back — never paints an unmeasured colour");
});

test("the swatches stay distinguishable from each other and from their surface", () => {
  for (const theme of ["light", "dark"]) {
    const fills = paletteEntries().map((e) => ({ what: e.name || e.id, c: resolve(swatchPaint(e).fill, theme) }));
    for (const f of fills) {
      // a 20px circle IS the control: 1.4.11 applies to it against the card it sits on
      for (const under of ["var(--panel)", "var(--paper)"]) {
        const r = ratio(theme, hexOf(f.c), [under]);
        assert.ok(r >= 3, `${f.what} swatch on ${under} in ${theme} = ${round2(r)}:1 (needs 3:1)`);
      }
    }
    for (let i = 0; i < fills.length; i++) {
      for (let j = i + 1; j < fills.length; j++) {
        const [a, b] = [fills[i], fills[j]];
        const d = Math.hypot(a.c.r - b.c.r, a.c.g - b.c.g, a.c.b - b.c.b);
        assert.ok(d >= 40, `${a.what} and ${b.what} are the same colour in ${theme} (distance ${Math.round(d)})`);
      }
    }
  }
});

test("the accent chosen by the user carries its ink everywhere it is a fill", () => {
  // `background: var(--accent); color: var(--on-teal)` was the whole bug: the
  // fill followed the pick and the ink stayed frozen on teal's. A TINT of the
  // accent is a different pairing (accent as text on its own tint, measured
  // above) — this row is about the solid fill.
  const offenders = [];
  for (const r of RULES) {
    if (r.keyframes || isRootSel(r.sel)) continue;
    const d = Object.fromEntries(readDecls(r.body));
    const bg = (d["background"] || d["background-color"] || "").trim();
    if (!/^var\(--accent[,)]/.test(bg) || !d.color) continue;
    if (!/var\(--on-accent\)/.test(d.color)) offenders.push(`${r.sel} { background: ${bg}; color: ${d.color} }`);
  }
  assert.deepEqual(offenders, [], `\n  ${offenders.join("\n  ")}\n`);
});

// R20 — at the end of a recording the explanatory sentence (which states the
// price: "descartar apaga a transcrição — não pode ser desfeito") was the only
// flexible item in a row of three flex:none buttons, so with the ✦ IA panel open
// it collapsed to a ~70px column of one-word lines. DESIGN.md §2.9: the sentence
// truncates or gets its space, never collapses — and §7: it responds to the
// COLUMN, so the query is a container query.
test("the end-of-recording bar gives its sentence room, and reads the column", () => {
  const decls = declsOf;
  const txt = decls(".endtxt");
  assert.match(txt.get("flex") || "", /1 1 \d+px/, "flex:1 with a 0 basis is what let it collapse");
  assert.equal(txt.get("min-width"), "0");
  assert.ok(decls(".endacts").size, "the three buttons must move as ONE group, or they wrap one by one");
  assert.match(decls(".endbar").get("flex-wrap") || "", /wrap/);

  // the reflow lives in a container query, never in a window media query
  const containerCtx = AT_CONTEXTS.filter((c) => c && /^@container/.test(c));
  const reflowed = containerCtx.some((c) => (decls(".endbar", c).get("flex-direction") || "") === "column");
  assert.ok(reflowed, "a narrow COLUMN must stack the bar (DESIGN.md §7)");
  for (const c of AT_CONTEXTS.filter((x) => x && /^@media/.test(x))) {
    const d = decls(".endbar", c);
    for (const prop of ["flex-direction", "display", "flex-wrap"]) {
      assert.ok(!d.has(prop), `a window media query must not decide the bar's flow (${c} sets ${prop})`);
    }
  }
});

// B6 — the recording footer clipped a CONTROL. The order of sacrifice was already
// right (the sentence truncates, then the wave gives up its width, and the clock,
// the seal and the buttons never shrink), but the row could not WRAP and it is
// `overflow: hidden`: measured in a headless layout of the shipped sheet, at a
// 1080px window with the ✦ IA panel open the column is 490px, the controls that
// never shrink need 446px plus 68px of padding, and the privacy seal — the one
// claim BR-8 exists to make — ended 38.6px past the edge and was simply cut.
// DESIGN.md §2.9 and §7: the sentence goes first, a control moves to a second
// line rather than being cut, and the whole decision reads the COLUMN (the panel
// is what takes the column away), never the window.
test("the recording footer never clips a control (DESIGN.md §2.9, §7)", () => {
  assert.equal(declsOf(".recfoot").get("min-width"), "0");
  const note = declsOf(".recfoot .recnote");
  assert.match(note.get("text-overflow") || "", /ellipsis/, "the sentence truncates first");
  assert.equal(note.get("min-width"), "0");
  for (const sel of [".recfoot .timer", ".recfoot .privacypill", ".recfoot .btn", ".recfoot .recbtn.sm"]) {
    assert.equal(declsOf(sel).get("flex"), "none", `${sel} must never shrink (DESIGN.md §2.9)`);
  }

  const column = AT_CONTEXTS.filter((c) => c && /^@container/.test(c));
  assert.ok(
    column.some((c) => /wrap/.test(declsOf(".recfoot", c).get("flex-wrap") || "")),
    "in a column too narrow for the controls they must wrap to a second line, not be clipped",
  );
  assert.ok(
    column.some((c) => declsOf(".recfoot .recnote", c).get("display") === "none"),
    "the sentence disappears before a control has to move",
  );
  assert.ok(
    column.some((c) => /^1 1 0$/.test(declsOf(".recfoot .wave", c).get("flex") || "")),
    "and the wave gives up its own width before that",
  );
  for (const c of AT_CONTEXTS.filter((x) => x && /^@media/.test(x))) {
    for (const sel of [".recfoot", ".recnote", ".recfoot .recnote", ".recfoot .wave", ".recfoot .privacypill"]) {
      for (const prop of ["display", "flex", "flex-wrap", "flex-direction"]) {
        assert.ok(
          !declsOf(sel, c).has(prop),
          `a WINDOW media query must not decide the recording footer's flow (${c} sets ${prop} on ${sel})`,
        );
      }
    }
  }
});

// B17 — the destructive confirmation borrows the floating PICKER's box, and that
// box is frozen at 196px because a picker is a column of names. The confirmation
// carries a sentence and a PATH: measured in a headless layout of the shipped
// sheet, its content needed 302px inside a 194px box and the path overflowed by
// 113px, so the copy that says what is about to be destroyed was cut off.
// DESIGN.md §5: a menu clamps to the viewport and is not clipped.
test("a destructive confirmation is not clipped by the picker's width (DESIGN.md §5)", () => {
  assert.equal(declsOf(".floatmenu").get("max-width"), "196px", "a picker is still a fixed column of names");
  const confirm = declsOf(".floatmenu:has(.confirm-actions)");
  assert.ok(confirm.size, "the confirmation must not be frozen at the picker's width");
  assert.ok(parseFloat(confirm.get("min-width")) >= 240, `a sentence needs room: min-width is ${confirm.get("min-width")}`);
  assert.match(
    confirm.get("max-width") || "",
    /calc\(100vw/,
    "and it clamps to the viewport instead of being clipped",
  );
  const stat = declsOf(".floatmenu .fstatic");
  assert.equal(stat.get("white-space"), "normal", "the sentence wraps");
  assert.match(
    stat.get("overflow-wrap") || "",
    /anywhere|break-word/,
    "a path is one unbreakable token: it wraps instead of overflowing the menu",
  );
});

// R6 — the "RECOMENDADO" badge was a direct child of a flex COLUMN, so it
// stretched to 371px for a 65px word and read as an empty input field two rows
// under two real ones. A badge is as wide as its text (DESIGN.md §5).
test("a badge is never stretched by its container (DESIGN.md §5)", () => {
  const decls = new Map();
  for (const r of RULES) {
    if (r.keyframes) continue;
    if (!r.sel.split(",").some((s) => s.trim() === ".modeltag")) continue;
    for (const [k, v] of readDecls(r.body)) decls.set(k, v.trim());
  }
  assert.ok(decls.size, ".modeltag must exist");
  assert.ok(
    decls.get("align-self") === "start" || decls.get("width") === "fit-content",
    "a flex child stretches to the container's cross size unless it says otherwise",
  );
  assert.equal(decls.get("border-radius"), "999px", "DESIGN.md §5: pills and badges are 999px");
});

// One state, one appearance (DESIGN.md §5): the active destination was painted
// with --ink on Início and the fixed teal on the other two, so with a project
// colour the header pill disagreed with every other active surface.
test("the active nav destination has exactly one fill", () => {
  const fills = [];
  for (const r of RULES) {
    if (r.keyframes) continue;
    if (!r.sel.split(",").some((s) => /^\.dest[^\s]*\.on$/.test(s.trim()))) continue;
    for (const [k, v] of readDecls(r.body)) if (k === "background" || k === "background-color") fills.push(`${r.sel}: ${v}`);
  }
  assert.equal(fills.length, 1, `"active destination" must not have two appearances:\n  ${fills.join("\n  ")}`);
  assert.match(fills[0], /var\(--accent\)/, "the active pill follows the accent, like every other active surface");
});

/* ---------- structural rules of the token system ---------- */

test("--yellow-ink is the readable form of amber, never a copy of the fill", () => {
  for (const theme of ["light", "dark"]) {
    const fill = hexOf(resolve("var(--yellow)", theme));
    const ink = hexOf(resolve("var(--yellow-ink)", theme));
    assert.notEqual(ink, fill, `--yellow-ink === --yellow in ${theme}: amber on amber renders at 1.00:1`);
    // --yellow-ink is the ink for amber TINTS and neutral surfaces; the solid
    // amber fill has its own ink (--on-solid), which must also be readable.
    assert.ok(
      contrast(resolve("var(--on-solid)", theme), resolve("var(--yellow)", theme)) >= 4.5,
      `--on-solid on the amber fill is below 4.5:1 in ${theme}`,
    );
  }
});

// Catches the whole family in one sweep: a rule that paints its own background
// and its own text must not collapse (white on amber was 1.96:1, and the failed
// agent step drew an amber glyph on amber at exactly 1.00:1).
test("no rule pairs a text colour with a background below 4.5:1", () => {
  const skip = /^(none|inherit|initial|unset|currentColor|transparent)$/i;
  const offenders = [];
  for (const r of RULES) {
    if (r.keyframes || isRootSel(r.sel)) continue;
    const d = Object.fromEntries(readDecls(r.body));
    const bgRaw = d["background"] || d["background-color"];
    if (!d.color || !bgRaw) continue;
    const bg = bgRaw.split(/\s+(?=[\w#]|var\()/)[0].trim();
    if (skip.test(d.color) || skip.test(bg) || /gradient/.test(bg)) continue;
    for (const theme of ["light", "dark"]) {
      let ratioValue;
      try {
        const under = surface(["var(--paper)", bg], theme);
        ratioValue = contrast(over(resolve(d.color, theme), under), under);
      } catch {
        continue; // not a colour we can resolve (e.g. a shorthand with an image)
      }
      // 4.5:1 is the floor for TEXT, and every rule swept here paints its own
      // words: the sweep used to stop at 3:1, so a pair between the two floors
      // could arrive with the suite green. A non-text pairing that lands here has
      // to argue for itself instead of being covered by a lower floor.
      if (ratioValue < 4.5) offenders.push(`[${theme}] ${r.sel}: ${d.color} on ${bg} = ${round2(ratioValue)}:1`);
    }
  }
  assert.deepEqual(offenders, [], `\n  ${offenders.join("\n  ")}\n`);
});

// DESIGN.md §3: mono is for "anything the machine owns — paths, timecodes,
// counters, badges, terminal", and "mono is never used for prose". The markup
// carries a `.mono` class on field labels and the CSS gave `.hint` the mono
// family, so the first-run labels and every explanatory sentence in
// Configurações rendered in the machine's font. The rule that paints prose has
// to declare the family itself — inheriting from `.mono` is how this came back.
const PROSE = [
  [".hint", "helper sentence under a control"],
  // N8 — a modal's title is a whole sentence ("Novo rascunho — descreva a mudança
  // em uma linha", "Como funciona o Loro"), and the markup carries `.mono` on it,
  // so the sheet that opens the team's history was headed in the machine's font.
  [".sheet-title", "the title of a modal sheet"],
  // R7 — the toast is the app's ONLY feedback surface, and a refusal
  // ("permita a Gravação de Tela…") is a sentence, not a value. The first sweep
  // fixed the field labels and missed the surface that carries most of the prose.
  [".toast", "every success and every refusal the app ever shows"],
  [".toastbtn", "the action a toast can carry"],
  [".modelnote", "the note under a transcription model"],
  [".endtxt span", "the sentence that states the price at the end of a recording"],
  [".orgrow .ometa", "what will happen to an item in Organizar"],
  [".mini-select", "the compact select that describes where something lands"],
  [".wfield > span:first-child", "field label (first run, modals)"],
  [".field > .mono:first-child", "field label (menus)"],
  [".cfgcard .field > .mono:first-child", "field label in Configurações"],
  [".sheet .field > .mono:first-child", "field label in the recording sheet"],
  [".pmnote", "note in the promote/migrate modals"],
  [".pmphead", "lead-in of the promote preview"],
  [".pmpreview", "the text that will be merged"],
  [".fnote", "footnote at the foot of a floating menu"],
];

test("prose is set in --sans, never in the machine's font (DESIGN.md §3)", () => {
  const offenders = [];
  for (const [sel, what] of PROSE) {
    let family = null;
    let seen = false;
    for (const r of RULES) {
      if (r.keyframes) continue;
      if (!r.sel.split(",").some((s) => s.trim() === sel)) continue;
      seen = true;
      for (const [k, v] of readDecls(r.body)) {
        if (k !== "font" && k !== "font-family") continue;
        const m = /var\(--(sans|mono)\)/.exec(v);
        if (m) family = m[1];
      }
    }
    if (!seen) offenders.push(`${what} (${sel}): the rule is gone`);
    else if (family === null) offenders.push(`${what} (${sel}): no family of its own — inherits the .mono class`);
    else if (family !== "sans") offenders.push(`${what} (${sel}): var(--${family})`);
  }
  assert.deepEqual(offenders, [], `\n  ${offenders.join("\n  ")}\n`);
});

// DESIGN.md's own preamble: "values here are taken from desktop/src/style.css …
// when the two disagree, the code is right and this file is stale — fix it". It
// went stale anyway, and every stale value was the pre-accessibility one that
// failed 4.5:1, so the document taught the next screen to fail. A table nobody
// measures is a landmine; this test is the measurement.
const DESIGN_MD = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "DESIGN.md"), "utf8");

test("every hex documented in DESIGN.md §3 is the value style.css ships", () => {
  const mismatches = [];
  let checked = 0;
  for (const line of DESIGN_MD.split("\n")) {
    if (!/^\|\s*`--/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    const names = [...cells[0].matchAll(/`(--[\w-]+)`/g)].map((m) => m[1]);
    for (const [column, theme] of [[1, "light"], [2, "dark"]]) {
      const hexes = [...(cells[column] || "").matchAll(/`(#[0-9a-fA-F]{3,8})`/g)].map((m) => m[1].toLowerCase());
      if (!hexes.length || hexes.length !== names.length) continue; // a prose cell
      names.forEach((name, k) => {
        checked++;
        const shipped = hexOf(resolve(`var(${name})`, theme));
        if (shipped !== hexes[k]) mismatches.push(`${name} (${theme}): DESIGN.md says ${hexes[k]}, style.css ships ${shipped}`);
      });
    }
  }
  assert.ok(checked >= 30, `only ${checked} documented values were found — did §3's colour table move?`);
  assert.deepEqual(mismatches, [], `\n  ${mismatches.join("\n  ")}\n`);
});

// DESIGN.md §2 states that its fixed measurements are "encoded in shell.js and
// the .bshell grid, not just here", and that the panel's floor is "enforced in
// app.js (PANEL_MIN) and pinned by tokens.test.js" — nothing pinned any
// measurement anywhere, which is exactly how three of the numbers in that table
// went stale. This is the pin the document claims.
test("every fixed measurement in DESIGN.md §2 is the one the code enforces", () => {
  const cell = (label) => {
    const m = new RegExp(`^\\|\\s*${label}\\s*\\|([^|]*)\\|`, "m").exec(DESIGN_MD);
    assert.ok(m, `DESIGN.md §2 has no "${label}" row`);
    return m[1].trim();
  };
  const read = (re, what) => {
    const m = re.exec(APP_JS);
    assert.ok(m, `could not read ${what} out of app.js — the drag clamp moved`);
    return m.slice(1);
  };
  const vw = (frac) => Math.round(Number(frac) * 100) + "vw";
  const vh = (frac) => Math.round(Number(frac) * 100) + "vh";

  const [sideFloor, sideCeil] = read(
    /Math\.max\(ev\.clientX - left, (\d+)\), window\.innerWidth \* (0?\.\d+)\)/, "the sidebar drag clamp");
  const [panelCeil] = read(
    /Math\.max\(window\.innerWidth - ev\.clientX, PANEL_MIN\), window\.innerWidth \* (0?\.\d+)\)/, "the panel drag clamp");
  const [panelFloor] = read(/const PANEL_MIN = (\d+);/, "PANEL_MIN");
  const [termFloor, termCeil] = read(
    /Math\.max\(bottom - ev\.clientY, (\d+)\), window\.innerHeight \* (0?\.\d+)\)/, "the terminal dock drag clamp");

  const expected = [
    ["Header height", [declsOf(".apphead").get("height")]],
    ["Sidebar", [
      TOKENS.light["--side-w-default"],
      (declsOf(".bshell.collapsed").get("grid-template-columns") || "").split(/\s+/)[0],
      sideFloor + "px", vw(sideCeil),
    ]],
    ["Right panel", [TOKENS.light["--panel-w"], panelFloor + "px", vw(panelCeil)]],
    ["Document card", [declsOf(".doccard").get("max-width")]],
    ["Terminal dock", [
      (/var\(--term-h,\s*([\d.]+vh)\)/.exec(declsOf(".termdock").get("height") || "") || [])[1],
      termFloor + "px", vh(termCeil),
    ]],
  ];
  for (const [label, values] of expected) {
    const text = cell(label);
    for (const v of values) {
      assert.ok(v, `a measurement for "${label}" could not be read out of the code`);
      assert.ok(text.includes(v), `DESIGN.md §2 "${label}" reads "${text}" — the code enforces ${v}`);
    }
  }
  // the same 700px card in both modes: "view AND edit" is the claim in the table
  assert.equal(declsOf("#wsBody.editing .doccard").get("max-width"), declsOf(".doccard").get("max-width"));
});

test("the neutral ramp keeps distinct steps in both themes", () => {
  for (const theme of ["light", "dark"]) {
    const ramp = ["--ink", "--ink2", "--ink3", "--muted", "--ghost"].map((n) => hexOf(resolve(`var(${n})`, theme)));
    assert.equal(new Set(ramp).size, ramp.length, `duplicated step in the ${theme} neutral ramp: ${ramp}`);
  }
});

test("the dark palette stays warm — no neutral grey paper (DESIGN.md §3)", () => {
  for (const name of ["--paper", "--panel", "--side"]) {
    const c = resolve(`var(${name})`, "dark");
    assert.ok(c.r > c.b, `${name} lost its warmth in dark: ${hexOf(c)}`);
  }
});

// R17 — every measurement in this suite resolves tokens from the TOP-LEVEL :root
// blocks, so a token redefined anywhere else is invisible to ALL of it: an audit
// mutation that dropped --line-control to a 1.2:1 hairline inside a @media block
// kept the entire suite green. DESIGN.md §3 already rules the mechanism out — the
// theme is resolved in JS and stamped as `data-theme`, never read from
// prefers-color-scheme in a component — so this is where that stops being a
// convention and becomes something that fails.
test("the token system is declared only in the top-level :root blocks", () => {
  const ROOT_BLOCK = /^:root(\[data-(theme|accent)="[a-z]+"\])?$/;
  const offenders = [];
  for (const r of RULES) {
    if (r.keyframes) continue;
    const names = readDecls(r.body).filter(([k]) => k.startsWith("--")).map(([k]) => k);
    if (!names.length) continue;
    const where = r.at.length ? `inside ${r.at.join(" ")} → ` : "";
    if (r.at.length || !r.sel.split(",").every((s) => ROOT_BLOCK.test(s.trim()))) {
      offenders.push(`${where}${r.sel} { ${names.join("; ")} } — invisible to every measurement in this suite`);
    }
  }
  assert.deepEqual(offenders, [], `\n  ${offenders.join("\n  ")}\n`);
});

// Colour literals belong in the token blocks; a rule that hardcodes one cannot
// follow the theme (that is how #fff ended up on the amber counter badges).
//
// The guard used to read FIVE property names, so a literal written inside a
// `border` / `border-top` / `outline` / `background-image` / gradient /
// `caret-color` / `text-decoration-color` shorthand was invisible to it — and
// this stylesheet declares hairlines with the shorthand almost everywhere, so the
// dead half was precisely the one that would bite. It now reads EVERY
// declaration: a colour is a colour wherever it is written.
// EMPTY, and that is the point. The one row this map ever carried was
// `.termstrip { border-bottom }` — an alpha-white hairline that could not resolve
// from the system because the terminal palette had no line token. The decision the
// row was waiting for was taken (`--term-line`, beside --term-bg/--term-fg/
// --term-dim/--term-ok, one value in both themes like the rest of that palette),
// so the row went, exactly as the self-check below demands. The sheet now has NO
// colour literal outside the token blocks.
const COLOUR_LITERALS_ALLOWED = new Map([]);
test("no colour literal outside the :root token blocks", () => {
  const offenders = [];
  const allowedSeen = new Set();
  for (const r of RULES) {
    if (r.keyframes || isRootSel(r.sel)) continue;
    for (const [k, v] of readDecls(r.body)) {
      if (k.startsWith("--")) continue;
      // url(#id) is an SVG reference, and a quoted string is content, not paint
      const paint = v.replace(/url\([^)]*\)/g, "").replace(/"[^"]*"/g, "").replace(/'[^']*'/g, "");
      if (!/#[0-9a-fA-F]{3,8}\b/.test(paint) && !/\brgba?\(/.test(paint)) continue;
      const sels = r.sel.split(",").map((s) => s.trim());
      if (sels.every((s) => COLOUR_LITERALS_ALLOWED.get(s) === k)) {
        sels.forEach((s) => allowedSeen.add(`${s}|${k}`));
        continue;
      }
      offenders.push(`${r.sel} { ${k}: ${v} }`);
    }
  }
  assert.deepEqual(offenders, [], `\n  ${offenders.join("\n  ")}\n`);
  // the exception cannot rot: once the rule resolves from a token, the row goes
  for (const [sel, prop] of COLOUR_LITERALS_ALLOWED) {
    assert.ok(allowedSeen.has(`${sel}|${prop}`),
      `${sel} { ${prop} } no longer carries a colour literal: drop the allowlist row`);
  }
});

test("every animation is wrapped for prefers-reduced-motion (DESIGN.md §6)", () => {
  const reduced = new Set();
  for (const r of RULES) {
    if (!r.at.some((a) => /prefers-reduced-motion/.test(a))) continue;
    for (const s of r.sel.split(",")) reduced.add(s.trim());
  }
  const animated = [];
  for (const r of RULES) {
    if (r.keyframes || r.at.some((a) => /prefers-reduced-motion/.test(a))) continue;
    for (const [k, v] of readDecls(r.body)) {
      if (k !== "animation" && k !== "animation-name") continue;
      if (v.trim() === "none") continue;
      for (const s of r.sel.split(",")) animated.push(s.trim());
    }
  }
  const unguarded = animated.filter((s) => !reduced.has(s));
  assert.deepEqual(unguarded, [], `unguarded animations: ${unguarded.join(", ")}`);
  assert.ok(animated.length >= 6, "expected the animated components to still be there");
});

test("elevation comes from the --sh-* tokens, glows from the palette (DESIGN.md §3)", () => {
  const offenders = [];
  for (const r of RULES) {
    if (r.keyframes || isRootSel(r.sel)) continue;
    for (const [k, v] of readDecls(r.body)) {
      if (k !== "box-shadow" || v.trim() === "none") continue;
      if (v.includes("inset")) continue; // an inline mark, not an elevation
      if (/var\(--sh-/.test(v) || /color-mix\(/.test(v)) continue;
      offenders.push(`${r.sel} { box-shadow: ${v} }`);
    }
  }
  assert.deepEqual(offenders, [], `\n  ${offenders.join("\n  ")}\n`);
});

// --ghost is the disabled/decorative token (DESIGN.md §3) and sits below 3:1 by
// design; a live control painted with it has no perceptible boundary.
test("--ghost never paints a live control", () => {
  const allowed = new Set([".tl .tldot", ".heroarrow", ".pempty .ic"]);
  const offenders = [];
  for (const r of RULES) {
    if (isRootSel(r.sel)) continue;
    for (const [k, v] of readDecls(r.body)) {
      if (!/var\(--ghost\)/.test(v)) continue;
      for (const s of r.sel.split(",").map((x) => x.trim())) {
        if (!allowed.has(s) && !/:disabled|\[disabled\]/.test(s)) offenders.push(`${s} { ${k}: ${v} }`);
      }
    }
  }
  assert.deepEqual(offenders, [], `\n  ${offenders.join("\n  ")}\n`);
});

// DESIGN.md §7 is absolute: "the page body never scrolls horizontally", and wide
// content "scrolls inside its own container". Measured in the running app at the
// panel's floor width, the third tab (Terminal) rendered from x=1230 to x=1329 in
// a 1280px window — 49px past the right edge — and that single overflow made
// <body> scroll sideways (scrollWidth 1329 vs clientWidth 1280). The tab strip
// needed 308px and had 259px, so the floor cannot be justified by "the three tabs
// still fit": the strip has to be unable to push the page in the first place.
// N9 — the ⌘K arrow-key selection was invisible. The only cue the sheet gave the
// selected row was `background: color-mix(in srgb, var(--teal) 8%, transparent)`,
// which composites to 1.12:1 against the rows around it in light and 1.15:1 in
// dark (measured in a headless Blink render of the shipped sheet), with no border,
// no shadow, no weight change and no ring — focus stays in the input, so Enter ran
// one of 26 commands the user could not see selected. "Selected" is a UI component
// state: 3:1 (WCAG 1.4.11), and colour alone at 8% is not a state.
test("the selected ⌘K row is a visible state, not a wash (WCAG 1.4.11)", () => {
  const on = declsOf(".cmdk-item.on");
  assert.ok(on.size, ".cmdk-item.on must exist");
  const wash = on.get("background") || on.get("background-color");
  assert.ok(wash, "the selected row still paints a fill");
  const cue = on.get("box-shadow") || on.get("border-left") || on.get("border") || on.get("outline");
  for (const theme of ["light", "dark"]) {
    const row = surface(["var(--panel)", wash], theme);
    const neighbour = surface(["var(--panel)"], theme);
    assert.ok(
      cue,
      `the fill alone is ${round2(contrast(row, neighbour))}:1 against the rows around it in ${theme} — the selected row needs a second cue`,
    );
    const colour = lastColour(cue);
    assert.ok(colour, `the indicator must be painted from the token system, not with "${cue}"`);
    for (const under of [row, neighbour]) {
      const r = contrast(over(resolve(colour, theme), under), under);
      assert.ok(
        r >= 3,
        `the ⌘K selection indicator is ${colour} on ${hexOf(under)} in ${theme} = ${round2(r)}:1 (needs 3:1)`,
      );
    }
  }
});

// N12/N27 — the chat did not contain what it was given. Measured in a headless
// Blink render of the shipped sheet with the panel at its 330px default: a single
// 70-character token gave `.chatmsg` scrollWidth 616 in a 265px bubble (351px of
// the message drawn outside the panel and outside the window), a pasted PR URL 462
// vs 265, `.chatthread` 647 vs 297 (recovering the text scrolled the whole
// conversation sideways), and `.chatans pre` 592 vs 297 with its <code> drawn to
// x=1791 in a 1512px window — 279px past the edge. `.chatans pre code` also
// computed `monospace`, the UA generic, instead of var(--mono): the chat was the
// one reading surface off the type system. DESIGN.md §7 and §3.
test("the chat contains what it is given (DESIGN.md §7)", () => {
  const breaks = (sel) => {
    const d = declsOf(sel);
    return /anywhere|break-word/.test(`${d.get("overflow-wrap") || ""} ${d.get("word-break") || ""}`);
  };
  for (const sel of [".chatmsg", ".chatans"]) {
    assert.ok(breaks(sel), `${sel} must break an unbreakable token instead of drawing it outside the panel`);
  }
  assert.equal(declsOf(".chatthread").get("min-width"), "0", "the thread is allowed to be narrower than its widest bubble");
  const pre = declsOf(".chatans pre");
  assert.match(
    `${pre.get("overflow") || ""} ${pre.get("overflow-x") || ""}`,
    /auto|scroll/,
    "a code block inside an answer scrolls inside its own container",
  );
  for (const sel of [".chatans pre", ".chatans code"]) {
    const d = declsOf(sel);
    assert.match(
      `${d.get("font") || ""} ${d.get("font-family") || ""}`,
      /var\(--mono\)/,
      `${sel} must name the mono TOKEN — without it the chat renders in the UA's generic monospace`,
    );
  }
});

// N25 — at ≤900px `.docbody` flips to a column and keeps `align-items:
// flex-start`, so its single child is shrink-to-fit in the cross axis. Measured in
// a headless Blink render of the shipped sheet at an 880px window (the app's floor
// is 860): the content column is 625px, `.docbody` 519px, and `.docmain` rendered
// 559.5px — crossing the card's right border by 9.5px, with `.doccard` scrollWidth
// 590 vs clientWidth 579 — while at 901px the same document sat at 276px inside
// the card. The code block also stopped scrolling in its own container (scrollWidth
// === clientWidth at 880px, 544 vs 274 at 901px): it inflated the document
// instead. DESIGN.md §7 and WCAG 2.1 AA 1.4.10 (reflow).
test("a stacked document keeps the card's margins (DESIGN.md §7, WCAG 1.4.10)", () => {
  const narrow = AT_CONTEXTS.filter((c) => c && /^@media \(max-width: 900px\)$/.test(c));
  assert.ok(narrow.length, "the ≤900px breakpoint must still exist");
  let stacked = 0;
  for (const c of narrow) {
    const body = declsOf(".docbody", c);
    if ((body.get("flex-direction") || "") !== "column") continue;
    stacked++;
    assert.ok(
      body.get("align-items") === "stretch" || declsOf(".docmain", c).get("width") === "100%",
      "a column flex container leaves its child shrink-to-fit in the cross axis: the reader must be stretched to the card",
    );
  }
  assert.equal(stacked, 1, "exactly one query stacks the document's rail — if it moved, this guard has to move with it");
  // and an unbreakable token (a URL, a path) wraps instead of forcing the column
  // wider than the card that contains it
  const doc = declsOf(".doc");
  assert.match(
    `${doc.get("overflow-wrap") || ""} ${doc.get("word-break") || ""}`,
    /anywhere|break-word/,
    "reading prose must never require horizontal scrolling (WCAG 1.4.10)",
  );
});

// N24 — below 1041px the whole ✦ IA panel was `display: none`, while the toggle
// kept its 12% fill and `aria-expanded="true"`, the Home card still called
// openChatComposer() into a display:none subtree, and the terminal — mounted
// inside the panel by default — became unreachable with no copy anywhere saying
// the panel had been dropped. Measured at 1024px (tauri.conf allows 860): the
// panel computed display:none, box 0x0, while `.aigrip` was still painted at
// x=1019..1024 for the full height, a col-resize control for a panel that is not
// there. A window width may take a pane's SPACE; it may not take the pane.
test("the ✦ IA panel is never dropped by a window width (DESIGN.md §1, §2)", () => {
  for (const context of AT_CONTEXTS) {
    const d = declsOf(".aipanel", context);
    if (!d.size) continue;
    assert.notEqual(
      d.get("display"),
      "none",
      `${context || "the base sheet"} hides the panel while ✦ IA still reports it open`,
    );
  }
  const ctx = AT_CONTEXTS.find((c) => c && /max-width:\s*1040px/.test(c));
  assert.ok(ctx, "the sub-reference-window behaviour must still be declared");
  for (const prop of ["width", "min-width"]) {
    assert.match(
      declsOf(".aipanel", ctx).get(prop) || "",
      /min\(\s*var\(--panel-w[^)]*\)\s*,\s*45vw\s*\)/,
      `below the reference window the panel yields WIDTH (${prop} ≤ 45vw) instead of existence`,
    );
  }
  // and the sidebar is what gives up its share next, so the content column survives
  const narrow = AT_CONTEXTS.find((c) => c && /max-width:\s*900px/.test(c));
  assert.match(
    declsOf(".bshell", narrow).get("grid-template-columns") || "",
    /min\(var\(--side-w.*?,\s*34%\)/,
    "at ≤900px the sidebar's ceiling drops to 34% of the column",
  );
});

// N24 (round 7) — the panel yields WIDTH now instead of existence, so the content
// column is 434px at a 1024px window and 341px at the 860px floor with ✦ IA open.
// Two destination grids kept asking the WINDOW how much room they had, which is the
// rule DESIGN.md §7 opens with ("layout responds to the column, not the window").
// Measured in a headless Blink render of the shipped sheet with the panel open:
// the Home hero needs 367px of min-content, so at a 950px window (column 360px,
// grid track row 288px) the "Perguntar à IA" card — the one N24 is about — was drawn
// from x=538 to x=658 with the column ending at x=615, 43px outside it, and .wsbody
// scrolled sideways (scrollWidth 403 vs clientWidth 360); at 901px it was 92px out.
// The Conhecimento grid needs 433px and does the same at a 1051px window: two cards
// ended at x=732 with the column ending at x=716 and .wsbody scrollWidth 477 vs
// clientWidth 461. Both were "fixed" just below their window breakpoint (≤900 and
// ≤1050) and broken just above it — the signature of measuring the wrong box.
test("a destination grid reads the column it lives in, not the window (DESIGN.md §7)", () => {
  const isContainer = (r) =>
    !r.keyframes &&
    r.sel.split(",").some((s) => s.trim() === ".bmain") &&
    readDecls(r.body).some(([k, v]) => k === "container-type" && v.trim() === "inline-size");
  assert.ok(RULES.some(isContainer), ".bmain must stay the query container the destinations read");

  for (const sel of [".herogrid", ".knowgrid"]) {
    assert.match(
      declsOf(sel).get("grid-template-columns") || "",
      /1fr\s+1fr/,
      `${sel} is a multi-column grid while the column has room for one`,
    );
    const stacks = AT_CONTEXTS.filter(
      (c) => c && (declsOf(sel, c).get("grid-template-columns") || "").trim() === "1fr",
    );
    assert.ok(stacks.length, `${sel} must still collapse to one column when the column is narrow`);
    for (const c of stacks) {
      assert.match(
        c,
        /^@container/,
        `${sel} collapses inside "${c}" — a window width cannot see the ✦ IA panel taking the column away`,
      );
    }
    for (const c of AT_CONTEXTS.filter((x) => x && /^@media/.test(x))) {
      assert.ok(
        !declsOf(sel, c).has("grid-template-columns"),
        `a WINDOW media query must not decide ${sel}'s flow (${c})`,
      );
    }
  }
});

// The same fix's other half: the sidebar's ceiling drops to 34% of the column below
// 900px, and at the 860px floor `tauri.conf` allows that is 178.5px while the footer
// row's own min-content is 184px. Measured in the same render: #sideToggle — the
// collapse control DESIGN.md §2.3 puts beside ⚙ Configurações — ended at x=184 in a
// pane that clips at x=179, inside `.bside { overflow: hidden }`, so 5px of a control
// were cut with nothing to scroll. §2.9's ladder is explicit: the sentence truncates,
// and a control is never clipped.
test("the narrow sidebar truncates its label instead of clipping the collapse control (DESIGN.md §2.9)", () => {
  const cfg = declsOf(".footcfg");
  assert.equal(cfg.get("flex"), "1", "⚙ Configurações is still the row's elastic half");
  assert.equal(
    cfg.get("min-width"),
    "0",
    "flex:1 keeps min-width:auto, so the label's min-content pushed the control out of the pane",
  );
  const label = declsOf(".footcfg span");
  assert.match(label.get("overflow") || "", /hidden/);
  assert.match(label.get("text-overflow") || "", /ellipsis/, "the label truncates first (§2.9)");
  assert.match(label.get("white-space") || "", /nowrap/);
  assert.equal(declsOf(".footside").get("flex"), "none", "and the control keeps its own 36px");
});

// N26 — pane sizes are persisted and were never re-clamped to the window they are
// applied in, and the two drag ceilings sum to 105vw. Measured in a headless Blink
// render of the shipped sheet at 1512x830 with the values app.js writes
// (--side-w 680px, --panel-w 1536px, --term-h 1080px, all reachable on an external
// display): `.aipanel` 1536px wide ending at x=1541 (29px past the edge) with
// documentElement.scrollWidth 1541 vs clientWidth 1512 — the body scrolling
// sideways, which DESIGN.md §7 forbids — `.bwrap` and `.bmain` at 0px (no sidebar
// and no document at all), the send button clipped at x=1482..1516, and #termDock
// 1080px tall ending 345px below the window. The drag clamps live in app.js; the
// sheet is what has to make the state unreachable.
test("a persisted pane size can never exceed the window it is applied in (DESIGN.md §2)", () => {
  const panel = declsOf(".aipanel");
  for (const prop of ["width", "min-width"]) {
    assert.match(
      panel.get(prop) || "",
      /min\(\s*var\(--panel-w[^)]*\)\s*,\s*60vw\s*\)/,
      `.aipanel ${prop} must clamp to the 60vw ceiling DESIGN.md §2 documents, whatever was persisted`,
    );
  }
  const dock = declsOf(".termdock", null).get("height") || "";
  assert.match(dock, /var\(--term-h,\s*34vh\)/, "the dock still defaults to 34vh");
  assert.match(dock, /clamp\(\s*120px\s*,.*,\s*75vh\s*\)/, "and it is held between the floor and the ceiling of the same table");
  assert.match(
    declsOf(".bshell").get("grid-template-columns") || "",
    /min\(var\(--side-w.*?,\s*45%\)/,
    "the sidebar's ceiling reads the column it lives in, so it can never be clipped by the panel",
  );
});

// N29 — `.doc pre` sets `.85em` and `.doc code` another `.85em` over the 14.5px
// reader, and the two multiply: the code inside a code block computed 10.4762px
// (measured), below every step in DESIGN.md §3 that is meant to be READ (11px for
// metadata, 11.5px for a helper sentence) and at the 10.5px the scale reserves for
// a micro-label. A code block is content, not a badge.
test("a code block in a document is not smaller than the smallest readable step", () => {
  const em = (v) => {
    const m = /^([\d.]+)em$/.exec((v || "").trim());
    return m ? Number(m[1]) : null;
  };
  const reader = Number((/([\d.]+)px/.exec(declsOf(".doc.reader").get("font") || "") || [])[1]);
  assert.ok(reader, "the reader's own size must be readable out of .doc.reader");
  const preEm = em(declsOf(".doc pre").get("font-size"));
  assert.ok(preEm, ".doc pre still sizes itself relative to the reader");
  const codeEm = em(declsOf(".doc pre code").get("font-size")) ?? em(declsOf(".doc code").get("font-size")) ?? 1;
  const effective = Math.round(reader * preEm * codeEm * 100) / 100;
  assert.ok(
    effective >= 11.5,
    `code inside a document's code block renders at ${effective}px (${reader} × ${preEm} × ${codeEm}) — DESIGN.md §3's smallest readable step is 11.5px`,
  );
});

// N21 — the guard that claimed to hold 2.4.7 was an ALLOWLIST of nine selectors,
// so `outline: none` on the record button, the three destination tabs and the
// wizard's colour swatches broke 0 of 455 tests (measured, on a copy of the tree).
// The check now reads EVERY outline declaration the sheet carries: switching a ring
// off is a defect unless another rule paints one for the same control, or for the
// box the app focuses (`:focus-within`), which is what the field-shaped controls do.
const RING_EXCEPTIONS = new Map([
  [".cmdk-input", "the palette's input is the only focusable node in the dialog and always holds focus; the dialog is the surface, and the row Enter will run carries its own indicator (.cmdk-item.on)"],
]);

test("every focus indicator the sheet switches off is replaced by one it paints (WCAG 2.4.7)", () => {
  const OUTLINE = /^outline(-(color|style|width))?$/;
  // a selector's chain of compound parts, with pseudo-classes/elements and
  // attribute filters removed: what it points AT, so two rules can be compared
  const chainOf = (sel) =>
    sel
      .replace(/::?[a-z-]+(\([^()]*\))?/gi, "")
      .replace(/\[[^\]]*\]/g, "")
      .split(/\s*[>+~\s]\s*/)
      .filter(Boolean);
  const suffix = (a, b) => {
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    return short.every((t, i) => long[long.length - short.length + i] === t);
  };

  const painters = [];
  for (const r of RULES) {
    if (r.keyframes) continue;
    for (const [k, v] of readDecls(r.body)) {
      if (!OUTLINE.test(k) || !/solid|dashed|dotted|double/.test(v)) continue;
      for (const s of r.sel.split(",").map((x) => x.trim())) {
        if (!/:focus/.test(s)) continue;
        const chain = chainOf(s);
        if (chain.length) painters.push({ chain, within: /:focus-within/.test(s), sel: s });
      }
    }
  }
  assert.ok(painters.length >= 5, "the sheet must still paint focus rings of its own");

  const offenders = [];
  for (const r of RULES) {
    if (r.keyframes) continue;
    for (const [k, v] of readDecls(r.body)) {
      if (!OUTLINE.test(k)) continue;
      const val = v.trim();
      const removed =
        /^(none|hidden|transparent)$/i.test(val) ||
        (/^outline(-width)?$/.test(k) && /(^|\s)0(px|em|rem|%)?(\s|$)/.test(val));
      if (!removed) continue;
      for (const s of r.sel.split(",").map((x) => x.trim())) {
        if (RING_EXCEPTIONS.has(s)) continue;
        const chain = chainOf(s);
        const covered = painters.some(
          (p) => suffix(p.chain, chain) || (p.within && chain.includes(p.chain[p.chain.length - 1])),
        );
        if (!covered) offenders.push(`${s} { ${k}: ${val} } — nothing paints a ring for it (WCAG 2.4.7)`);
      }
    }
  }
  assert.deepEqual(offenders, [], `\n  ${offenders.join("\n  ")}\n`);
});

test("the right panel's tab strip can never push the page sideways (DESIGN.md §7)", () => {
  const strip = RULES.filter((r) => !r.keyframes && r.sel.split(",").some((s) => s.trim() === ".paneltabs"));
  assert.ok(strip.length, ".paneltabs must exist");
  const decls = new Map();
  for (const r of strip) for (const [k, v] of readDecls(r.body)) decls.set(k, v.trim());
  assert.equal(decls.get("min-width"), "0", ".paneltabs must be allowed to shrink below its content");
  assert.match(
    decls.get("overflow-x") || "",
    /auto|scroll/,
    ".paneltabs must scroll inside its own container instead of overflowing the page"
  );
});

/* ============================================================ critic round 4
   The document is the product's primary output (ADR-0018), and it was the one
   reading surface whose type ladder and code block were never decided:

     N22  h3 was 0.775px smaller than h2 and 50 weight units HEAVIER, one ink
          step dimmer — the deeper level read stronger than its parent — and it
          differed from an inline bold phrase by 0.725px and nothing else. h4
          rendered SMALLER than the prose it introduces.
     N23  a code block had the card's own fill (1.00:1) and a 1.15–1.25:1
          hairline, so its clipped scroll edge read as damaged content, and the
          `pre` itself resolved the UA's generic monospace.
*/

// px out of a `font:` shorthand or a `font-size:` declaration
function pxOf(decls) {
  const v = decls.get("font-size") || decls.get("font") || "";
  const m = /(\d[\d.]*)px/.exec(v);
  return m ? Number(m[1]) : null;
}
function weightOf(decls) {
  const f = decls.get("font-weight") || decls.get("font") || "";
  const m = /(?:^|\s)([1-9]\d{2})(?=\s|\/|$)/.exec(f);
  return m ? Number(m[1]) : null;
}
// the ladder as the reader really computes it: `.doc.reader X` when declared,
// otherwise `.doc X` resolved against the reader's own 14.5px
function readerHeading(tag) {
  const own = declsOf(`.doc.reader ${tag}`);
  const base = declsOf(`.doc ${tag}`);
  const readerPx = pxOf(declsOf(".doc.reader"));
  let px = pxOf(own);
  if (px === null) {
    const em = /([\d.]+)em/.exec(base.get("font-size") || "");
    px = em ? Number(em[1]) * readerPx : readerPx;
  }
  return {
    px: Math.round(px * 1000) / 1000,
    weight: weightOf(own) ?? weightOf(base) ?? 700, // UA bold when nobody declares
    colour: own.get("color") || base.get("color") || declsOf(".doc.reader").get("color"),
  };
}

test("N22 — a escada de títulos do documento DESCE, e nenhum degrau some na prosa", () => {
  const readerPx = pxOf(declsOf(".doc.reader"));
  assert.equal(readerPx, 14.5, "a prosa do leitor continua em 14.5px");
  const [h1, h2, h3, h4] = ["h1", "h2", "h3", "h4"].map(readerHeading);

  assert.ok(h1.px > h2.px, `h1 ${h1.px}px não é maior que h2 ${h2.px}px`);
  assert.ok(h2.px > h3.px, `h2 ${h2.px}px não é maior que h3 ${h3.px}px`);
  assert.ok(h3.px > h4.px, `h3 ${h3.px}px não é maior que h4 ${h4.px}px`);
  assert.ok(h4.px >= readerPx,
    `h4 (${h4.px}px) é MENOR que a prosa que ele apresenta (${readerPx}px)`);
  // um nível mais fundo nunca é mais pesado que o seu pai
  for (const [a, b, nome] of [[h1, h2, "h1/h2"], [h2, h3, "h2/h3"], [h3, h4, "h3/h4"]]) {
    assert.ok(a.weight >= b.weight, `${nome}: o nível mais fundo é mais PESADO (${a.weight} vs ${b.weight})`);
  }
});

test("N22 — um h3 não se confunde com uma frase em negrito", () => {
  const h3 = readerHeading("h3");
  const readerPx = pxOf(declsOf(".doc.reader"));
  // `strong` herda a prosa: 14.5px, peso 700 do UA, cor --ink2
  assert.ok(h3.px - readerPx >= 1,
    `h3 (${h3.px}px) e uma frase em negrito (${readerPx}px) diferiam por ${(h3.px - readerPx).toFixed(3)}px`);
  assert.ok(/--ink\)/.test(h3.colour || ""),
    `o título de seção é --ink; veio ${h3.colour} (a mesma tinta do negrito da prosa)`);
});

test("N23 — um bloco de código no documento tem superfície própria e uma borda achável", () => {
  const pre = declsOf(".doc pre");
  const card = declsOf(".doccard").get("background");
  assert.equal(card, "var(--panel)", "o cartão do documento continua sendo --panel");
  assert.notEqual(pre.get("background"), card,
    "mesmo preenchimento do cartão (1.00:1): a borda cortada do scroll lia como linha quebrada");
  for (const theme of ["light", "dark"]) {
    const borda = ratio(theme, pre.get("border").split(" ").pop(), ["var(--panel)"]);
    assert.ok(borda >= 3,
      `${theme}: a borda do bloco de código fica em ${round2(borda)}:1 contra o cartão (piso 3:1, WCAG 1.4.11)`);
  }
});

test("N23 — o `pre` do documento declara a fonte da máquina, não a genérica do navegador", () => {
  const pre = declsOf(".doc pre");
  const fam = pre.get("font-family") || pre.get("font") || "";
  assert.match(fam, /var\(--mono\)/,
    "só o <code> filho resolvia --mono; o pre computava o `monospace` genérico do UA (DESIGN.md §3)");
});

test("N23 — as duas superfícies de leitura decidem o bloco de código do mesmo jeito", () => {
  // o chat já tinha a decisão (`.chatans pre`); o documento nunca teve
  for (const sel of [".doc pre", ".chatans pre"]) {
    const d = declsOf(sel);
    assert.match(d.get("overflow") || d.get("overflow-x") || "", /auto/,
      `${sel}: conteúdo largo rola dentro da própria caixa (DESIGN.md §7)`);
    assert.ok(d.get("background"), `${sel}: sem preenchimento próprio não há caixa`);
  }
});

test("N24 — o cabeçalho de uma tabela do documento é a prosa do autor, não um rótulo da máquina", () => {
  const th = declsOf(".doc th");
  const td = declsOf(".doc td");
  // 10.5px + mono + CAIXA ALTA reescreviam o texto que o autor escreveu, na
  // superfície cujo trabalho inteiro é ser lida (DESIGN.md §3: mono nunca é prosa)
  assert.ok(!/mono/.test(th.get("font-family") || th.get("font") || ""),
    "mono nunca é prosa: o cabeçalho é texto do autor");
  assert.ok(!th.get("text-transform"),
    "text-transform: uppercase destrói a caixa que o autor escolheu");
  const px = /(\d[\d.]*)px/.exec(th.get("font-size") || th.get("font") || "");
  assert.ok(!px, `o cabeçalho não tem degrau próprio de tamanho (veio ${px && px[1]}px)`);
  // continua sendo cabeçalho: peso e tinta o distinguem da célula
  assert.equal(th.get("font-weight"), "650");
  assert.equal(th.get("color"), "var(--ink)");
  assert.ok(td.get("padding"), "a linha de células continua com o mesmo ritmo");
});

test("N26 — o manual em modal decide o bloco de código como as outras superfícies de leitura", () => {
  // é a PRIMEIRA superfície de leitura de quem acabou de instalar: sem regra de
  // `pre`, o bloco computava o `monospace` genérico do UA, sem caixa, e um bloco
  // largo empurrava a folha inteira em vez de rolar dentro de si (DESIGN.md §7)
  const pre = declsOf(".manualmodal pre");
  assert.ok(pre.size, ".manualmodal precisa decidir o seu bloco de código");
  assert.match(pre.get("font-family") || pre.get("font") || "", /var\(--mono\)/);
  assert.ok(pre.get("background"), "sem preenchimento próprio não há caixa");
  assert.match(pre.get("overflow-x") || pre.get("overflow") || "", /auto/,
    "conteúdo largo rola dentro da própria caixa, não empurra a folha");
  for (const theme of ["light", "dark"]) {
    const borda = ratio(theme, (pre.get("border") || "").split(" ").pop(), ["var(--panel)"]);
    assert.ok(borda >= 3,
      `${theme}: a borda do bloco fica em ${round2(borda)}:1 contra a folha (piso 3:1, WCAG 1.4.11)`);
  }
  const table = declsOf(".manualmodal table");
  assert.ok(table.size, "uma tabela do manual também precisa caber");
  assert.match(table.get("overflow-x") || "", /auto/);
  assert.equal(declsOf(".manualmodal th").get("font-weight"), "650",
    "o cabeçalho da tabela do manual segue a mesma decisão do leitor (N24)");
});

/* ═════════════ rodada 3 · medido no cabeçalho e nos estados do destino ════════
   Quatro achados que o desenho novo trouxe e que só a medição pega. */

// ACHADO MEDIDO (Chrome 151, quatro destinos, pill de gravação visível, os dois
// contadores da nav): entre 901px e ~1015px o `#headRec` era o ÚNICO item
// encolhível do flex do cabeçalho (`.switch`, `.destnav` e `.headright` são
// `flex: none`), então ele absorvia o déficit inteiro — 35px dos 151px de que
// precisa a 901px, sem relógio e sem a palavra "gravando". Enquanto isso a
// etiqueta da versão (decoração) e o ar entre os blocos mantinham os seus pixels,
// porque o bloco que os cedia só valia a partir de 900px. A ordem da regra 9 é o
// inverso: prosa, decoração, ar — e um controle NUNCA é cortado.
const HEADER_RUNS_OUT = 1015;
test("o cabeçalho cede prosa e decoração antes de cortar um controle (DESIGN.md §2.8/§2.9)", () => {
  const pill = declsOf(".headrec");
  assert.ok(pill.size, ".headrec must exist");
  assert.equal(pill.get("flex"), "none",
    "o pill de gravação é um controle (volta para a gravação): ele não pode ser o item que encolhe");
  assert.ok(!pill.has("min-width"),
    "`min-width: 0` é o que autoriza um item de flex a encolher abaixo do seu conteúdo");
  // e quem cede é a PROSA: o bloco do projeto encolhe, e encolhe DE VERDADE — sem
  // `display: flex` nele o botão de dentro fica no seu tamanho de conteúdo e
  // transborda a caixa (medido: caixa 142px, conteúdo 177px a 1016px, com o nome
  // e o ⌄ por cima da pílula da nav)
  const proseBlock = declsOf(".apphead .switch");
  assert.equal(proseBlock.get("flex"), "0 1 auto", "o bloco do projeto é o item que cede");
  assert.equal(proseBlock.get("min-width"), "0");
  assert.equal(proseBlock.get("display"), "flex",
    "sem isto o filho não é item de flex e transborda em vez de elidir");
  assert.equal(declsOf(".projname").get("min-width"), "0");
  assert.match(declsOf(".projname").get("text-overflow") || "", /ellipsis/);

  // o bloco que cede tem de valer NA LARGURA em que o cabeçalho realmente acaba
  const cede = AT_CONTEXTS.filter((c) => c && /^@media \(max-width:/.test(c) &&
    (declsOf(".localtag", c).get("display") === "none" || declsOf(".apphead", c).has("gap")));
  assert.ok(cede.length, "o cabeçalho tem um bloco de largura estreita");
  const larguras = cede.map((c) => Number(/max-width:\s*(\d+)px/.exec(c)[1]));
  for (const w of larguras) {
    assert.ok(w >= HEADER_RUNS_OUT,
      `o cabeçalho pede ${HEADER_RUNS_OUT}px com quatro destinos e a gravação em curso, ` +
      `e este bloco só cede a partir de ${w}px — entre os dois o único item encolhível é o pill`);
  }
  // e o que cede é prosa/decoração/ar, nunca o rótulo de um controle
  const bloco = `@media (max-width: ${Math.max(...larguras)}px)`;
  assert.equal(declsOf(".localtag", bloco).get("display"), "none", "a etiqueta da versão é decoração");
  assert.equal(declsOf(".apphead .dot", bloco).get("display"), "none", "o ponto é decoração (aria-hidden)");
  assert.ok(declsOf(".projname", bloco).has("max-width"), "o nome do projeto é prosa: ele elide");
  assert.ok(declsOf(".apphead", bloco).has("gap"), "e o ar entre os blocos fecha");
  for (const sel of [".dest", ".apphead .recbtn", ".apphead .aibtn"]) {
    const d = declsOf(sel, bloco);
    assert.ok(!d.has("display") || d.get("display") !== "none",
      `${sel} é um controle: ele não desaparece numa janela estreita`);
    // `readDecls` devolve o NOME da propriedade sem os dois pontos, então
    // `/font:/` sobre as chaves nunca podia casar: metade desta asserção não
    // podia reprovar, e era justamente a metade que morde — esta folha declara
    // tipo quase só pelo atalho (`.dest`, `.localtag`, `.mini.act`, `.pbranch`).
    // Uma asserção que não pode reprovar é um achado (mesma doença do filtro de
    // grep que já escondeu um diff do cargo fmt neste repositório).
    assert.ok(!d.has("font-size") && !d.has("font"),
      `${sel}: o rótulo de um controle não encolhe (regra 8)`);
  }
});

// ACHADO MEDIDO: `.revsum .badge` computava para -apple-system 10px — `.badge`
// nunca declarou família, e os sete distintivos novos do destino não repetiram o
// `class="mono badge"` que os antigos escrevem à mão. E `.badge.ok` pintava com
// `var(--accent)`: com o âmbar do projeto, «novo» (ok) e «modificado» (warn2)
// mediam 1,02:1 de diferença — dois estados do git com a mesma tinta na mesma
// lista, e a tinta de um estado sendo uma preferência de decoração.
const BADGE_STATES = [".badge.ok", ".badge.warn", ".badge.warn2"];
test("um distintivo é mono, e dois estados na mesma lista nunca têm a mesma tinta (DESIGN.md §5/§3)", () => {
  let family = null;
  for (const r of RULES) {
    if (r.keyframes) continue;
    if (!r.sel.split(",").some((s) => s.trim() === ".badge")) continue;
    for (const [k, v] of readDecls(r.body)) {
      const m = (k === "font" || k === "font-family") && /var\(--(sans|mono)\)/.exec(v);
      if (m) family = m[1];
    }
  }
  assert.equal(family, "mono",
    "DESIGN.md §5: distintivos são mono — sem família própria o distintivo herda a prosa do cartão");
  for (const sel of BADGE_STATES) {
    const ink = declsOf(sel).get("color");
    assert.ok(ink, `${sel} declara a sua tinta`);
    assert.ok(!/--accent/.test(ink),
      `${sel}: a tinta de um ESTADO não pode ser a cor que o usuário escolheu para o projeto`);
  }
  for (const theme of ["light", "dark"]) {
    const inks = BADGE_STATES.map((s) => hexOf(resolve(declsOf(s).get("color"), theme)));
    assert.equal(new Set(inks).size, inks.length,
      `dois estados com a mesma tinta no tema ${theme}: ${BADGE_STATES.join(" / ")} = ${inks.join(" / ")}`);
    // e cada uma continua legível sobre o preenchimento do próprio distintivo
    for (const [i, sel] of BADGE_STATES.entries()) {
      const r = ratio(theme, declsOf(sel).get("color"), [declsOf(".badge").get("background") || "var(--panel)"]);
      assert.ok(r >= 4.5, `${sel} no tema ${theme}: ${inks[i]} = ${round2(r)}:1 (piso 4,5:1)`);
    }
  }
});

// ACHADO MEDIDO: `class="hint mono"` computava para -apple-system 11.5px com
// letter-spacing de mono, e `class="pmnote mono"` o mesmo — `.mono` e `.hint`/
// `.pmnote` têm a MESMA especificidade e as segundas vêm depois com o atalho
// `font:`, que reinicia a família. Sobrava a metade errada da regra: a prosa com
// o espaçamento da máquina e o caminho do arquivo em --sans (DESIGN.md §3).
test("uma classe que pede a fonte da máquina realmente a pinta (DESIGN.md §3)", () => {
  const MARKUP = APP_JS + fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");
  const familyOf = (cls) => {
    let fam = null;
    RULES.forEach((r) => {
      if (r.keyframes || !r.sel.split(",").some((s) => s.trim() === "." + cls)) return;
      for (const [k, v] of readDecls(r.body)) {
        const m = (k === "font" || k === "font-family") && /var\(--(sans|mono)\)/.exec(v);
        if (m) fam = m[1];
      }
    });
    return fam;
  };
  const mortos = [];
  const vistos = new Set();
  for (const m of MARKUP.matchAll(/class="([^"$]*\bmono\b[^"$]*)"/g)) {
    const classes = m[1].trim().split(/\s+/).filter(Boolean);
    if (classes.length < 2 || vistos.has(classes.join(" "))) continue;
    vistos.add(classes.join(" "));
    // a última regra de classe única que declara família é a que vence (todas
    // têm especificidade 0,1,0 — a ordem do arquivo decide)
    let vencedora = null;
    for (const r of RULES) {
      if (r.keyframes) continue;
      for (const s of r.sel.split(",").map((x) => x.trim())) {
        if (!/^\.[\w-]+$/.test(s) || !classes.includes(s.slice(1))) continue;
        for (const [k, v] of readDecls(r.body)) {
          const f = (k === "font" || k === "font-family") && /var\(--(sans|mono)\)/.exec(v);
          if (f) vencedora = { cls: s, fam: f[1] };
        }
      }
    }
    if (vencedora && vencedora.fam !== "mono") {
      mortos.push(`class="${classes.join(" ")}" → ${vencedora.cls} vence com var(--${vencedora.fam})`);
    }
  }
  assert.ok(vistos.size >= 20, `só ${vistos.size} combinações com .mono foram lidas — o varredor cegou`);
  assert.ok(familyOf("mono") === "mono", ".mono continua declarando a família da máquina");
  assert.deepEqual(mortos, [],
    "a classe pede a fonte da máquina e não a recebe — o que sobra é o espaçamento dela na prosa:\n  " +
      mortos.join("\n  "));
});

// ACHADO MEDIDO: `.btn:disabled` fixa `--ink3` e o comentário ao lado diz por quê
// ("4,9:1"); duas regras abaixo, `.btn.solid:disabled` pintava `--muted` sobre um
// preenchimento de 10% da tinta = 3,72:1 no escuro e 3,97:1 no claro. Não é falha
// de SC (1.4.3 isenta o inativo), é o piso que a própria folha declara — e é o
// estado em que o botão primário do destino passa a maior parte do tempo (tudo
// salvo).
test("um controle desabilitado lê no piso que a própria folha declara", () => {
  const falhas = [];
  for (const theme of ["light", "dark"]) {
    for (const sel of [".btn:disabled", ".btn.solid:disabled"]) {
      const d = declsOf(sel);
      assert.ok(d.size, `${sel} must exist`);
      const ink = d.get("color");
      assert.ok(ink, `${sel} declara a sua tinta`);
      const fill = d.get("background");
      for (const base of ["var(--paper)", "var(--panel)"]) {
        const layers = fill ? [base, fill] : [base];
        const r = ratio(theme, ink, layers);
        if (r < 4.5) falhas.push(`${sel} em ${theme} sobre ${hexOf(surface(layers, theme))}: ${round2(r)}:1`);
      }
    }
  }
  assert.deepEqual(falhas, [], `\n  ${falhas.join("\n  ")}\n`);
});

// MEDIDO: o rótulo de `.mini.act` é `9.5px var(--mono)` — abaixo do menor passo
// documentado (§3 vai até 10,5px) e é a fonte da máquina numa FRASE («marcar como
// visto», «voltar ao meu rascunho»). Onde a etiqueta é prosa, ela é prosa.
test("uma ação rotulada da Revisão é prosa em --sans, no passo do §3", () => {
  for (const sel of [".revacts .mini.act", ".revrow .mini.act", ".notifbar .mini.act"]) {
    const font = declsOf(sel).get("font") || "";
    assert.match(font, /var\(--sans\)/, `${sel}: uma frase não é escrita na fonte da máquina`);
    const size = Number((/(\d+(?:\.\d+)?)px/.exec(font) || [])[1]);
    assert.ok(size >= 11.5, `${sel}: ${size}px está abaixo do passo de 11,5px do §3`);
  }
});

/* ============================================== achados abertos no teto da 5ª
   Dois valores que a rodada 3 deixou fora da escala do §3 e que os críticos
   voltaram a achar na 5ª. Nenhum dos dois foi corrigido dentro do loop porque a
   guarda que os pegaria seria VERMELHA — e uma asserção nascida com exceção
   legaliza o defeito em vez de fechá-lo. Aqui os valores mudaram, e a guarda
   nasce verde e mordendo.
*/
test("R60 — todo distintivo respeita o piso da escala (§3: 11px para um badge)", () => {
  // .badge era 10px: 0,5px sob o piso de 10.5px que a escala reserva para um
  // micro-rótulo, e 1px sob os 11px que a tabela do §3 reserva para um distintivo —
  // numa marca cuja função é ser lida de relance
  const px = (sel) => {
    const d = declsOf(sel);
    const v = d.get("font-size") || d.get("font") || "";
    const m = /(\d[\d.]*)px/.exec(v);
    return m ? Number(m[1]) : null;
  };
  const badge = px(".badge");
  assert.ok(badge !== null, ".badge precisa declarar o seu degrau");
  assert.ok(badge >= 11, `.badge está em ${badge}px — a tabela do §3 reserva 11px para um distintivo`);
  // §3 declara DOIS degraus e eles não são o mesmo: 11px para um distintivo,
  // 10.5px para um micro-rótulo/contador. Um contador é a segunda coisa.
  for (const sel of [".destbadge", ".cbadge", ".minibadge"]) {
    const v = px(sel);
    assert.ok(v !== null, `${sel} precisa declarar o seu degrau`);
    assert.ok(v >= 10.5, `${sel} em ${v}px fica sob o degrau de 10.5px que §3 dá a um contador`);
  }
});

test("R60 — o título de seção da Revisão é prosa em --sans, e a escada desce", () => {
  // .phead é 11px mono MAIÚSCULO em --muted, que é a máquina nomeando um cesto
  // (IDEIAS · COM ESTE DOCUMENTO). O destino Revisão o usava para FRASES escritas
  // por uma pessoa («Aguardam a sua revisão», «O que muda», «Conversa»), e §3 é
  // explícito: mono nunca é prosa, e uma frase não é gritada. A escada também
  // invertia — um h2 de 11px a 4,65:1 apresentando títulos de cartão de 13,5px.
  const head = declsOf(".rvhead");
  const font = head.get("font") || "";
  assert.match(font, /var\(--sans\)/, "prosa é --sans; mono é a metade da máquina da linha");
  assert.ok(!/var\(--mono\)/.test(font), ".rvhead não pode cair na letra da máquina");
  assert.equal(head.get("text-transform"), "none", "uma frase não é gritada");
  assert.equal(head.get("letter-spacing"), "normal", "o tracking do rótulo de cesto não é de prosa");
  assert.match(head.get("color") || "", /var\(--ink\)/, "um título é distinguido por tamanho E tinta");

  // A ESCADA DESCE: h2 > h3 > título do cartão > prosa do cartão
  const px = (sel, d) => {
    const v = (d || declsOf(sel)).get("font-size") || (d || declsOf(sel)).get("font") || "";
    const m = /(\d[\d.]*)px/.exec(v);
    return m ? Number(m[1]) : null;
  };
  const h2 = px(".rvhead", head), h3 = px("h3.rvhead");
  assert.ok(h2 > h3, `h2 ${h2}px tem de ser maior que h3 ${h3}px`);
  const cartao = px(".rvname");
  if (cartao !== null) {
    assert.ok(h3 >= cartao,
      `h3 ${h3}px apresenta títulos de cartão de ${cartao}px — a escada não pode inverter`);
  }

  // e o .phead SEGUE mono maiúsculo, porque lá ele está certo: os três rótulos do
  // painel ✦ IA são a máquina nomeando um cesto
  const ph = declsOf(".phead");
  assert.match(ph.get("font") || "", /var\(--mono\)/, "o rótulo de cesto continua sendo da máquina");
  const HTMLSRC = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");
  const revBlock = HTMLSRC.slice(HTMLSRC.indexOf('id="destReview"'), HTMLSRC.indexOf('id="bDocWrap"'));
  assert.ok(!/class="phead"/.test(revBlock),
    "nenhuma frase do destino pode voltar para a classe do rótulo de cesto");
});

test("R60 — o chip do rascunho põe a prosa em --sans e só o endereço em mono", () => {
  // .pbranch é `font: 11.5px var(--mono)` e a frase inteira («no rascunho X», «no
  // conhecimento oficial») morava dentro dele. §5: o rótulo de um campo é prosa, e
  // só o VALOR que ele carrega pode ser mono.
  const prosa = declsOf(".pbranch > span:not(.mono)");
  assert.match(prosa.get("font-family") || "", /var\(--sans\)/,
    "a frase do chip é prosa: a tela que promete não exigir git não a escreve na letra da máquina");
  const APPSRC = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  const m = /function draftChipHtml\([\s\S]*?\n\}/.exec(APPSRC);
  assert.ok(m, "app.js deve declarar draftChipHtml()");
  assert.match(m[0], /<span class="mono">\$\{esc\(name\)\}<\/span>/,
    "o NOME do rascunho é um endereço — ele fica mono");
  assert.ok(!/class="mono"[^>]*>\$\{esc\(t\(/.test(m[0]),
    "e nenhuma frase traduzida entra num span mono");
});
