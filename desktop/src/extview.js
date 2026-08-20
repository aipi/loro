// Loro — the extension surface renderer (ADR-0031 R5a, contract §1). Isolated,
// testable module: loaded in the browser via <script> (defines
// window.LoroExtView) and in Node via require() for node --test.
//
// FOUR contracts. The first three are the ones loops.js:1-24 and refs.js:3
// already state; the fourth is this module's alone, and it is the reason the
// module exists at all instead of a painter inside app.js (12919 lines,
// CLAUDE.md §5 clean-core premise).
//
// 1. It is PURE. It takes the plain data `ext_view` returns (a view document
//    plus the facts the HOST computed) and returns a NEW string. No DOM, no
//    IPC, no `invoke`, no mutation of an input. Rendering the same document
//    twice returns the same bytes.
// 2. It is LANGUAGE-FREE. Not one pt-BR literal lives here: every
//    user-visible sentence arrives in `ctx.strings`, and every refusal is a
//    stable `err.*` code that app.js turns into a msgid at paint time. The
//    msgid scanners (tests/i18n.test.js, tests/vocabulary.test.js) read
//    app.js, so a literal parked here would escape BOTH and ship
//    untranslated with a green suite — the lesson loops.js:9-13 records.
// 3. It is DEP-FREE. It cannot require text.js: measured, no module in
//    desktop/src/ cross-imports another. So the five-character escape is
//    duplicated here and tests/extview.test.js proves the two agree character
//    for character, rather than a comment claiming they do.
// 4. THE DOCUMENT IS UNTRUSTED INPUT. It arrives from a third party's process.
//    Therefore: every interpolated value is escaped; every value is a token
//    ROLE from a closed alphabet, never a measurement (no hex, no px, no font
//    name, no locator, no CSS); an unknown primitive is REFUSED BY NAME and
//    the refusal is painted (ADR-0029 §3.7 — a node dropped in silence is a
//    surface that lies); and every ceiling that stops a hang is checked BEFORE
//    layout.
//
// WHAT THIS MODULE DELIBERATELY CANNOT DO, because the guarantee is the
// absence of the API and not a check inside it: it emits no inline `style`
// attribute, no focus-order override, no locator of any scheme, and no
// element that can load a remote byte. A composition unreachable by keyboard
// cannot be composed, because the author never gets to write the focus order:
// a `button` is a <button>, a `field` is a labelled input, a `link` is an <a>,
// and they appear in DOM order.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroExtView = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  // THE FIVE, not three — byte for byte the set desktop/src/text.js:17
  // escapes, and the doubled-quote half is load-bearing for the same measured
  // reason recorded there: a value with a quote in it closes the attribute it
  // was interpolated into, and the app's CSP permits an inline style
  // attribute. Even with no malice, a path containing `"` (legal on
  // macOS/Linux) truncated a data attribute and turned a card into a control
  // that does nothing. Here the values come from a third party's process, so
  // the same five are the floor, not the ceiling.
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ---- the closed alphabet (contract §1.1) --------------------------------
  // Every entry maps to a token defined in BOTH :root blocks of style.css
  // (:10 light, :88 dark), which is the whole reason an extension's screen
  // keeps working in both themes without ever learning which one is active.
  const TONES = ["ink", "ink2", "ink3", "muted", "teal", "amber", "red", "green", "accent"];
  // the sheet's 2px rhythm, docs/DESIGN.md:407 — "2 · 4 · 6 · 8 · 10 · 12 · 14"
  const STEPS = [0, 2, 4, 6, 8, 10, 12, 14];
  const SIZES = ["title", "body", "label", "meta"];
  const ALIGNS = ["start", "center", "end", "between"];
  const FAMILIES = ["sans", "mono"];
  const SCROLL_MAX = ["sm", "md", "lg"];
  // Width ROLES, not measurements (round 2). MEASURED at the owner's real scale
  // (79 columns): a column with no declared width kept flex-shrink:1 inside the
  // horizontal scroller and painted at 12px — text over text. The role maps to
  // a token in style.css; the number never crosses this boundary.
  const WIDTHS = ["xs", "sm", "md", "lg"];
  // A habilidade slug: it becomes half of a chat line, so the alphabet is the
  // guard — the same shape CLAUDE.md §6 fixes for command files (hyphenated,
  // never a dot).
  const RE_SKILL = /^[a-z][a-z0-9-]{2,47}$/;
  const SCROLL_AXIS = ["y", "x"];
  // the 14 names measured in app.js's own ICONS map (app.js:2903-2924). An
  // icon an extension names is Loro's drawing or it is nothing: the set is not
  // extensible, and no name outside it resolves.
  const ICONS_ALLOWED = ["folder", "context", "guide", "history", "idea", "ref", "meeting",
    "note", "file", "archive", "loop", "skill", "builtinskill", "customskill"];
  // the facts catalogue, closed for R5a (contract §2.1). `each.of` is checked
  // against this list statically, so a typo is named before any row is read.
  const FACTS = ["acervo.hotspots", "acervo.contexts", "acervo.orphans", "acervo.broken", "acervo.areas"];
  const FIELD_KINDS = ["string", "number", "bool", "enum"];
  const LAYOUTS = ["stack", "row", "grid", "scroll"];
  const LEAVES = ["text", "badge", "field", "button", "link", "doc", "divider", "spacer", "icon"];

  // ---- the ceilings ------------------------------------------------------
  const MAX_DEPTH = 8;      // component expansion depth (contract §1.5)
  const MAX_NODES = 2000;   // nodes after full expansion (contract §1.5)
  const MAX_CHILDREN = 64;  // children of one layout node, and of `view`
  const MAX_COMPONENTS = 32;
  const EACH_CAP = 200;     // default `each.cap`
  const MAX_EACH_CAP = 200;
  const DOC_CAP = 120;      // default `doc.cap`, in lines
  const MAX_DOC_CAP = 400;
  const MAX_ARGS = 8;
  const MAX_OPTIONS = 24;
  const MAX_PATTERN = 120;
  // Recursion ceiling for the whole tree, NOT in the frozen contract and named
  // here so nobody reads it as one. MEASURED: with MAX_DEPTH, MAX_NODES and
  // this one all removed, a component whose body is a `use` of itself makes
  // `render` throw `RangeError: Maximum call stack size exceeded` instead of
  // returning — in the app that is an uncaught throw inside a painter, so the
  // surface goes blank and says nothing. With MAX_DEPTH alone it returns
  // `err.ext_view_depth:8`. This ceiling covers the case MAX_DEPTH does not:
  // `children` nesting is unbounded by every other rule, so 2000 nodes may
  // arrive as a 2000-deep chain with no `use` in it at all. The kanban of
  // contract §1.7 measures 11 levels deep, so 128 is an order of margin over
  // the deepest real composition.
  const MAX_NEST = 128;

  const RE_COMPONENT = /^[a-z][a-z0-9-]{0,31}$/;
  const RE_FIELD_ID = /^[a-z][a-z0-9_-]{0,31}$/;
  const RE_ACTION = /^[a-z][a-z0-9_-]{0,47}$/;
  const RE_ARG_KEY = /^[a-z][a-z0-9_]{0,15}$/;
  const RE_EACH_AS = /^[a-z][a-z0-9]{0,15}$/;
  // A bound read: `<var>.<dot.path>`. At least one dot is required on purpose —
  // a bare `{"$":"hs"}` names a ROW, and a row is not a scalar, so rendering it
  // would print an object shape at the person.
  const RE_REF = /^[a-z][a-z0-9_]{0,31}(\.[A-Za-z0-9_-]{1,48}){1,8}$/;
  // A pattern an author may hand to a browser regex engine. Anything that can
  // backtrack catastrophically or reach backwards is out: no group lookaround,
  // no backreference. Length is capped at MAX_PATTERN by the contract.
  const RE_PATTERN_UNSAFE = /\((?:\?<|\?=|\?!)|\\[0-9]/;

  // The frozen class list (contract §8.C). Exported so a test can pin it and
  // the integrator can write exactly these selectors and no others. A modifier
  // that is NOT in this list is carried as a `data-` attribute instead of a
  // new class, so the list stays closed: `.extv-text[data-wrap="false"]`,
  // `.extv-text[data-family="mono"]`, `.extv-spacer[data-step="8"]`,
  // `.extv-doc[data-plain="true"]`.
  const CLASSES = [
    "extv", "extv-attr", "extv-err", "extv-more",
    "extv-stack", "extv-row", "extv-row-wrap", "extv-grid", "extv-scroll", "extv-scroll-x",
    "extv-text", "extv-doc", "extv-div", "extv-spacer", "extv-ico", "extv-field", "extv-link",
    "g-0", "g-2", "g-4", "g-6", "g-8", "g-10", "g-12", "g-14",
    "p-0", "p-2", "p-4", "p-6", "p-8", "p-10", "p-12", "p-14",
    "tn-ink", "tn-ink2", "tn-ink3", "tn-muted", "tn-teal", "tn-amber", "tn-red", "tn-green", "tn-accent",
    "sz-title", "sz-body", "sz-label", "sz-meta",
    "c-2", "c-3", "c-4", "c-5", "c-6",
    "al-start", "al-center", "al-end", "al-between",
    "mx-sm", "mx-md", "mx-lg",
    "w-xs", "w-sm", "w-md", "w-lg", "extv-surface",
  ];

  function isPlain(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }
  function own(o, k) {
    // hasOwnProperty and never `in`: the path segments come from the
    // extension, and `constructor` / `__proto__` are reachable with `in`.
    return o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
  }
  // The `:<detail>` half of a code ends up in an error list app.js reads AND in
  // the painted refusal. It is extension-controlled, so it is reduced to a
  // short, boring alphabet before it becomes part of a stable code.
  function detail(v) {
    return String(v === undefined ? "" : v).replace(/[^\w./@#:*+-]/g, "").slice(0, 48);
  }

  // ======================= validation (§1.0 … §1.5) =======================

  function newState() {
    const st = {
      errors: [],
      components: Object.create(null),
      fieldIds: Object.create(null),
      add(code) {
        if (!st.errors.includes(code)) st.errors.push(code);
      },
    };
    return st;
  }

  // An I18n pair, and BOTH halves are required: ADR-0031 §3 — the person chose
  // a language and an extension is not an exception to it.
  function vI18n(v, ptr, st) {
    if (!isPlain(v) || typeof v.pt !== "string" || !v.pt || typeof v.en !== "string" || !v.en) {
      st.add("err.ext_i18n_missing:" + detail(ptr));
      return false;
    }
    return true;
  }
  function isRef(v) {
    return isPlain(v) && typeof v.$ === "string";
  }
  // Str = I18n | Ref. A Ref resolves to DATA, which is not translated and is
  // rendered as the extension's own claim (§1.6.5).
  function vStr(v, ptr, st) {
    if (isRef(v)) {
      if (!RE_REF.test(v.$)) st.add("err.ext_view_ref:" + detail(v.$));
      return;
    }
    vI18n(v, ptr, st);
  }
  function vStep(v, name, st) {
    if (v === undefined) return;
    if (!STEPS.includes(v)) st.add("err.ext_view_value:" + name);
  }
  function vEnum(v, allowed, name, st) {
    if (v === undefined) return;
    if (typeof v !== "string" || !allowed.includes(v)) st.add("err.ext_view_value:" + name);
  }
  function vBool(v, name, st) {
    if (v === undefined) return;
    if (typeof v !== "boolean") st.add("err.ext_view_value:" + name);
  }

  function vChildren(node, ptr, st, nest) {
    const kids = node.children;
    if (!Array.isArray(kids) || kids.length < 1 || kids.length > MAX_CHILDREN) {
      st.add("err.ext_view_value:children");
      return;
    }
    kids.forEach((k, i) => vNode(k, ptr + "/children/" + i, st, nest + 1));
  }

  function vNode(node, ptr, st, nest) {
    if (nest > MAX_NEST) {
      st.add("err.ext_view_depth:" + MAX_NEST);
      return;
    }
    if (!isPlain(node) || typeof node.kind !== "string") {
      st.add("err.ext_view_node:" + detail(isPlain(node) ? node.kind : typeof node));
      return;
    }
    const k = node.kind;
    if (LAYOUTS.includes(k)) {
      vStep(node.gap, "gap", st);
      vStep(node.pad, "pad", st);
      vEnum(node.align, ALIGNS, "align", st);
      vEnum(node.w, WIDTHS, "w", st);
      if (k === "stack") vBool(node.surface, "surface", st);
      if (k === "row") vBool(node.wrap, "row.wrap", st);
      if (k === "grid" && !(Number.isInteger(node.cols) && node.cols >= 2 && node.cols <= 6)) {
        st.add("err.ext_view_value:grid.cols");
      }
      if (k === "scroll") {
        vEnum(node.max, SCROLL_MAX, "scroll.max", st);
        vEnum(node.axis, SCROLL_AXIS, "scroll.axis", st);
      }
      vChildren(node, ptr, st, nest);
      return;
    }
    if (k === "each") return vEach(node, ptr, st, nest);
    if (k === "when") return vWhen(node, ptr, st, nest);
    if (k === "use") return vUse(node, ptr, st);
    if (LEAVES.includes(k)) return vLeaf(node, ptr, st);
    // An unknown primitive is REFUSED BY NAME, and render() paints the refusal.
    st.add("err.ext_view_node:" + detail(k));
  }

  function vEach(node, ptr, st, nest) {
    if (typeof node.of !== "string" || !FACTS.includes(node.of)) {
      st.add("err.ext_view_facts:" + detail(node.of));
    }
    // `as` is required BECAUSE a nested each must be able to read the outer
    // row: the kanban of contract §1.7 is impossible without it.
    if (typeof node.as !== "string" || !RE_EACH_AS.test(node.as)) {
      st.add("err.ext_view_value:each.as");
    }
    if (node.cap !== undefined && !(Number.isInteger(node.cap) && node.cap >= 1 && node.cap <= MAX_EACH_CAP)) {
      st.add("err.ext_view_value:each.cap");
    }
    if (node.where !== undefined) {
      // Round 2 widened this from one key to 1..=4, ALL required to match (an
      // AND): a status board filters by column AND by the person's search in
      // one each. Four is a ceiling, not a plan — past it a where is a query
      // planner, and the place for one of those is the backend's facts.
      const keys = isPlain(node.where) ? Object.keys(node.where) : null;
      if (!keys || keys.length < 1 || keys.length > 4) st.add("err.ext_view_value:each.where");
      else for (const key of keys) {
        const op = node.where[key];
        const ops = isPlain(op) ? Object.keys(op).filter((o) => o === "eq" || o === "gt" || o === "has") : [];
        if (!isPlain(op) || ops.length !== 1 || Object.keys(op).length !== 1) {
          st.add("err.ext_view_value:each.where");
        } else if (ops[0] === "eq" && isRef(op.eq) && !RE_REF.test(op.eq.$)) {
          st.add("err.ext_view_ref:" + detail(op.eq.$));
        } else if (ops[0] === "gt" && typeof op.gt !== "number") {
          st.add("err.ext_view_value:each.where");
        } else if (ops[0] === "has" && !(typeof op.has === "string" || isRef(op.has))) {
          st.add("err.ext_view_value:each.where");
        } else if (ops[0] === "has" && isRef(op.has) && !RE_REF.test(op.has.$)) {
          st.add("err.ext_view_ref:" + detail(op.has.$));
        }
      }
    }
    vNode(node.body, ptr + "/body", st, nest + 1);
  }

  function vWhen(node, ptr, st, nest) {
    const ops = ["is", "exists", "gt"].filter((o) => node[o] !== undefined);
    if (ops.length !== 1) st.add("err.ext_view_value:when");
    if (ops[0] === "exists" && typeof node.exists !== "boolean") st.add("err.ext_view_value:when");
    if (ops[0] === "gt" && typeof node.gt !== "number") st.add("err.ext_view_value:when");
    if (isRef(node.value) && !RE_REF.test(node.value.$)) st.add("err.ext_view_ref:" + detail(node.value.$));
    if (!Array.isArray(node.then) || node.then.length < 1 || node.then.length > MAX_CHILDREN) {
      st.add("err.ext_view_value:when.then");
    } else {
      node.then.forEach((n, i) => vNode(n, ptr + "/then/" + i, st, nest + 1));
    }
    if (node.else !== undefined) {
      if (!Array.isArray(node.else) || node.else.length > MAX_CHILDREN) st.add("err.ext_view_value:when.else");
      else node.else.forEach((n, i) => vNode(n, ptr + "/else/" + i, st, nest + 1));
    }
  }

  function vUse(node, ptr, st) {
    if (typeof node.component !== "string" || !own(st.components, node.component)) {
      st.add("err.ext_view_component:" + detail(node.component));
      return;
    }
    const args = node.args;
    if (args !== undefined && !isPlain(args)) {
      st.add("err.ext_view_component:" + detail(node.component));
      return;
    }
    const params = st.components[node.component];
    for (const p of params) {
      if (!own(args || {}, p)) st.add("err.ext_view_ref:param." + detail(p));
      else vStr((args || {})[p], ptr + "/args/" + p, st);
    }
  }

  function vLeaf(node, ptr, st) {
    const k = node.kind;
    if (k === "text") {
      vStr(node.text, ptr + "/text", st);
      vEnum(node.tone, TONES, "tone", st);
      vEnum(node.size, SIZES, "size", st);
      vEnum(node.family, FAMILIES, "family", st);
      vBool(node.wrap, "text.wrap", st);
      return;
    }
    if (k === "badge") {
      vStr(node.text, ptr + "/text", st);
      vEnum(node.tone, TONES, "tone", st);
      return;
    }
    if (k === "divider") return;
    if (k === "spacer") {
      if (!STEPS.includes(node.size)) st.add("err.ext_view_value:spacer.size");
      return;
    }
    if (k === "icon") {
      if (typeof node.name !== "string" || !ICONS_ALLOWED.includes(node.name)) {
        st.add("err.ext_view_value:icon.name");
      }
      vEnum(node.tone, TONES, "tone", st);
      return;
    }
    if (k === "doc") {
      vStr(node.md, ptr + "/md", st);
      if (node.cap !== undefined && !(Number.isInteger(node.cap) && node.cap >= 1 && node.cap <= MAX_DOC_CAP)) {
        st.add("err.ext_view_value:doc.cap");
      }
      return;
    }
    if (k === "link") {
      vI18n(node.label, ptr + "/label", st);
      if (isRef(node.rel)) {
        // A Ref carries acervo data, so the value can only be judged when it
        // resolves — paint() re-checks it against relPath() there.
        if (!RE_REF.test(node.rel.$)) st.add("err.ext_view_ref:" + detail(node.rel.$));
      } else if (typeof node.rel !== "string" || !relOk(node.rel)) {
        st.add("err.ext_view_value:link.rel");
      }
      return;
    }
    if (k === "field") return vField(node, ptr, st);
    if (k === "button") return vButton(node, ptr, st);
  }

  function vField(node, ptr, st) {
    if (typeof node.id !== "string" || !RE_FIELD_ID.test(node.id) || own(st.fieldIds, node.id)) {
      st.add("err.ext_view_value:field.id");
    } else {
      st.fieldIds[node.id] = true;
    }
    if (typeof node.field !== "string" || !FIELD_KINDS.includes(node.field)) {
      st.add("err.ext_view_value:field");
    }
    vI18n(node.label, ptr + "/label", st);
    if (node.placeholder !== undefined) vI18n(node.placeholder, ptr + "/placeholder", st);
    if (node.hint !== undefined) vI18n(node.hint, ptr + "/hint", st);
    vBool(node.readonly, "field.readonly", st);
    if (node.field === "enum") {
      const opts = node.options;
      const from = node.optionsFrom;
      // one source of truth per dropdown: static options XOR a facts collection
      if (opts !== undefined && from !== undefined) {
        st.add("err.ext_view_value:field.options");
      } else if (from !== undefined) {
        // options born from the facts (round 2, the owner's dropdown): the
        // collection is the closed catalogue's, the two field names are plain
        // identifiers, and `empty` is the offered "all of them" row — a filter
        // dropdown with no way back to everything is a trap
        if (!isPlain(from) || typeof from.of !== "string" || !FACTS.includes(from.of)) {
          st.add("err.ext_view_facts:" + detail(isPlain(from) ? from.of : typeof from));
        } else if (!RE_ARG_KEY.test(String(from.value)) || !RE_ARG_KEY.test(String(from.label))) {
          st.add("err.ext_view_value:field.options");
        }
        if (node.empty !== undefined) vI18n(node.empty, ptr + "/empty", st);
      } else if (!Array.isArray(opts) || opts.length < 1 || opts.length > MAX_OPTIONS) {
        st.add("err.ext_view_value:field.options");
      } else {
        opts.forEach((o, i) => {
          if (!isPlain(o) || typeof o.value !== "string") st.add("err.ext_view_value:field.options");
          else vI18n(o.label, ptr + "/options/" + i + "/label", st);
        });
      }
    }
    if (node.pattern !== undefined) {
      if (node.field !== "string" || typeof node.pattern !== "string" ||
          node.pattern.length > MAX_PATTERN || RE_PATTERN_UNSAFE.test(node.pattern)) {
        st.add("err.ext_view_value:field.pattern");
      }
    }
  }

  function vButton(node, ptr, st) {
    // Exactly one door: `action` reaches the extension's own program;
    // `ask` reaches the CHAT — and only through the person (a modal, their
    // words, their permission mode, ADR-0021). Same rule for a manifest view
    // and an MCP-served one: both cross this validator, so neither door can
    // fire without the click and the sentence.
    if (node.ask !== undefined) {
      const bad = node.action !== undefined || node.values !== undefined ||
        node.args !== undefined || node.confirm !== undefined ||
        !isPlain(node.ask) || typeof node.ask.skill !== "string" ||
        !RE_SKILL.test(node.ask.skill);
      if (bad) st.add("err.ext_view_value:button.ask");
      else {
        if (node.ask.target !== undefined) vStr(node.ask.target, ptr + "/ask/target", st);
        if (node.ask.hint !== undefined) vI18n(node.ask.hint, ptr + "/ask/hint", st);
        if (node.ask.placeholder !== undefined) vI18n(node.ask.placeholder, ptr + "/ask/placeholder", st);
      }
      vI18n(node.label, ptr + "/label", st);
      vBool(node.primary, "button.primary", st);
      vBool(node.disabled, "button.disabled", st);
      return;
    }
    if (typeof node.action !== "string" || !RE_ACTION.test(node.action)) {
      st.add("err.ext_view_value:button.action");
    }
    vI18n(node.label, ptr + "/label", st);
    vBool(node.primary, "button.primary", st);
    vBool(node.disabled, "button.disabled", st);
    if (node.confirm !== undefined) vI18n(node.confirm, ptr + "/confirm", st);
    const values = node.values;
    if (values !== undefined) {
      if (!Array.isArray(values) || values.some((v) => typeof v !== "string" || !RE_FIELD_ID.test(v))) {
        st.add("err.ext_view_value:button.values");
      }
    }
    if (node.args !== undefined) {
      if (!isPlain(node.args)) {
        st.add("err.ext_view_value:button.args");
        return;
      }
      const keys = Object.keys(node.args);
      if (keys.length > MAX_ARGS || keys.some((k) => !RE_ARG_KEY.test(k))) {
        st.add("err.ext_view_value:button.args");
      }
      // `values` and `args` land in ONE flat object at ext_action (contract
      // §4.3), so a key that is also a collected field id is a collision the
      // host cannot resolve — refused here, not silently overwritten there.
      for (const k of keys) {
        if (Array.isArray(values) && values.includes(k)) st.add("err.ext_view_value:button.args");
        vStr(node.args[k], ptr + "/args/" + k, st);
      }
    }
  }

  // An acervo-relative path, and NOTHING else. There is no locator in this
  // contract: the app's CSP is load-bearing, so anything carrying a scheme, a
  // protocol-relative prefix, an absolute root or a `..` segment is refused by
  // name instead of being handed to a navigator.
  const RE_SCHEME = /^[a-z][a-z0-9+.-]*:|^\/\//i;
  function relOk(rel) {
    const s = String(rel);
    if (!s || s.length > 512) return false;
    if (s.includes("://") || RE_SCHEME.test(s)) return false;
    // A backslash, not a space: a folder name WITH a space is legal on
    // macOS/Linux and refusing it would refuse a document a person really has.
    // The quote in such a path is handled where it matters — esc() at the
    // attribute, which is the defect text.js:8-16 measured.
    if (s.startsWith("/") || s.includes("\\")) return false;
    return !s.split("/").includes("..");
  }

  function validate(doc) {
    const st = newState();
    if (!isPlain(doc)) {
      st.add("err.ext_view_empty");
      return { ok: false, errors: st.errors };
    }
    if (doc.loroView !== 1) {
      st.add("err.ext_view_version:" + detail(doc.loroView));
      return { ok: false, errors: st.errors };
    }
    if (doc.components !== undefined) {
      if (!isPlain(doc.components) || Object.keys(doc.components).length > MAX_COMPONENTS) {
        st.add("err.ext_view_component:components");
      } else {
        for (const key of Object.keys(doc.components)) {
          const c = doc.components[key];
          if (!RE_COMPONENT.test(key) || !isPlain(c) || !isPlain(c.body) ||
              (c.params !== undefined && !(Array.isArray(c.params) && c.params.every((p) => typeof p === "string" && RE_ARG_KEY.test(p))))) {
            st.add("err.ext_view_component:" + detail(key));
            continue;
          }
          st.components[key] = Array.isArray(c.params) ? c.params.slice() : [];
        }
        for (const key of Object.keys(st.components)) {
          vNode(doc.components[key].body, "/components/" + key + "/body", st, 1);
        }
      }
    }
    const view = doc.view;
    if (!Array.isArray(view) || view.length === 0) {
      st.add("err.ext_view_empty");
      return { ok: false, errors: st.errors };
    }
    if (view.length > MAX_CHILDREN) st.add("err.ext_view_value:view");
    view.forEach((n, i) => vNode(n, "/view/" + i, st, 1));
    return { ok: st.errors.length === 0, errors: st.errors };
  }

  // ======================= expansion (§1.5) ===============================
  // Author components are inlined BEFORE layout, which is what makes the two
  // ceilings meaningful: a component that expands into itself stops at depth 8
  // instead of becoming a hang, and a document that expands past 2000 nodes
  // stops instead of becoming an unbounded string.
  //
  // A `use` becomes an internal `bind` node carrying the argument
  // EXPRESSIONS, not their values: the arguments of the kanban's `card` read
  // `{"$":"hs.hotspot"}`, and `hs` only exists once a row is in scope. So the
  // structure is static and the reads stay dynamic.

  function errNode(code) {
    return { kind: "_err", code };
  }

  function expandNode(node, comps, st, depth, nest) {
    if (st.over) return errNode("err.ext_view_size:" + st.count);
    if (nest > MAX_NEST) {
      st.add("err.ext_view_depth:" + MAX_NEST);
      return errNode("err.ext_view_depth:" + MAX_NEST);
    }
    st.count += 1;
    if (st.count > MAX_NODES) {
      st.over = true;
      st.add("err.ext_view_size:" + st.count);
      return errNode("err.ext_view_size:" + st.count);
    }
    if (!isPlain(node) || typeof node.kind !== "string") {
      const code = "err.ext_view_node:" + detail(isPlain(node) ? node.kind : typeof node);
      st.add(code);
      return errNode(code);
    }
    const k = node.kind;
    if (k === "use") {
      // The ceiling is checked BEFORE the body is fetched, so a self-reference
      // is a refusal at depth 8 and never a frame on the stack. Remove this
      // `if` and tests/extview.test.js goes red on `err.ext_view_depth:8`;
      // remove MAX_NEST as well and it throws (see MAX_NEST above).
      if (depth >= MAX_DEPTH) {
        const code = "err.ext_view_depth:" + MAX_DEPTH;
        st.add(code);
        return errNode(code);
      }
      const c = own(comps, node.component) ? comps[node.component] : null;
      if (!isPlain(c) || !isPlain(c.body)) {
        const code = "err.ext_view_component:" + detail(node.component);
        st.add(code);
        return errNode(code);
      }
      const args = isPlain(node.args) ? node.args : {};
      const params = Object.create(null);
      for (const p of (Array.isArray(c.params) ? c.params : [])) {
        if (own(args, p)) params[p] = args[p];
        else st.add("err.ext_view_ref:param." + detail(p));
      }
      return { kind: "bind", params, body: expandNode(c.body, comps, st, depth + 1, nest + 1) };
    }
    if (LAYOUTS.includes(k)) {
      const kids = Array.isArray(node.children) ? node.children : [];
      return Object.assign({}, node, {
        children: kids.slice(0, MAX_CHILDREN).map((ch) => expandNode(ch, comps, st, depth, nest + 1)),
      });
    }
    if (k === "each") {
      return Object.assign({}, node, { body: expandNode(node.body, comps, st, depth, nest + 1) });
    }
    if (k === "when") {
      const out = Object.assign({}, node);
      out.then = (Array.isArray(node.then) ? node.then : []).slice(0, MAX_CHILDREN)
        .map((ch) => expandNode(ch, comps, st, depth, nest + 1));
      out.else = (Array.isArray(node.else) ? node.else : []).slice(0, MAX_CHILDREN)
        .map((ch) => expandNode(ch, comps, st, depth, nest + 1));
      return out;
    }
    return Object.assign({}, node);
  }

  function expand(doc) {
    const st = {
      count: 0, over: false, errors: [],
      add(code) {
        if (!st.errors.includes(code)) st.errors.push(code);
      },
    };
    if (!isPlain(doc) || !Array.isArray(doc.view)) {
      st.add("err.ext_view_empty");
      return { nodes: [], errors: st.errors };
    }
    const comps = isPlain(doc.components) ? doc.components : {};
    const nodes = doc.view.slice(0, MAX_CHILDREN).map((n) => expandNode(n, comps, st, 0, 1));
    return { nodes, errors: st.errors };
  }

  // ======================= reads (§1.1 Ref) ===============================

  function dig(obj, dotPath) {
    let cur = obj;
    for (const seg of String(dotPath).split(".")) {
      if (!own(cur, seg)) return { ok: false };
      cur = cur[seg];
    }
    if (cur === null || typeof cur === "object") return { ok: false };
    return { ok: true, value: cur };
  }

  function factsOf(ctx, name) {
    const f = ctx && ctx.facts;
    return own(f, name) ? f[name] : null;
  }

  // `facts.<collection>.<field>` is readable from anywhere (it is not row
  // data); `param.<name>` reads a component argument; anything else reads the
  // `as` name of an enclosing each. The collection names contain a dot, so the
  // longest known prefix wins — `facts.acervo.hotspots.count` is the
  // collection `acervo.hotspots` and the field `count`, never `acervo`.
  function resolveRef(path, ctx, scope) {
    const p = String(path);
    if (p === "facts" || p.indexOf("facts.") === 0) {
      const rest = p.slice(6);
      for (const name of FACTS) {
        if (rest.indexOf(name + ".") === 0) return dig(factsOf(ctx, name), rest.slice(name.length + 1));
      }
      return { ok: false };
    }
    if (p.indexOf("settings.") === 0) {
      // The HOST's copy of the effective settings (defaults overlaid by what
      // the person saved), passed in ctx by app.js for level 1 and level 2
      // alike — the extension's process never writes them (ext.rs §5.5).
      return dig((ctx && ctx.settings) || null, p.slice(9));
    }
    const dot = p.indexOf(".");
    if (dot < 0) return { ok: false };
    const head = p.slice(0, dot);
    if (!own(scope, head)) return { ok: false };
    return dig(scope[head], p.slice(dot + 1));
  }

  // Str -> a plain string. An I18n picks by ctx.lang; a Ref resolves to DATA
  // and is left alone, because data is the extension's claim and translating
  // it would be Loro asserting something it cannot verify.
  function strValue(v, ctx, scope) {
    if (isRef(v)) {
      const r = resolveRef(v.$, ctx, scope);
      if (!r.ok) return { ok: false, code: "err.ext_view_ref:" + detail(v.$) };
      return { ok: true, value: String(r.value) };
    }
    if (isPlain(v)) {
      const lang = ctx && ctx.lang === "en" ? "en" : "pt";
      if (typeof v[lang] === "string" && v[lang]) return { ok: true, value: v[lang] };
      return { ok: false, code: "err.ext_i18n_missing:" + detail(lang) };
    }
    return { ok: false, code: "err.ext_i18n_missing:" + detail(typeof v) };
  }

  function i18nValue(v, ctx) {
    const lang = ctx && ctx.lang === "en" ? "en" : "pt";
    return isPlain(v) && typeof v[lang] === "string" ? v[lang] : "";
  }

  // ======================= paint ==========================================

  function cls(list) {
    return list.filter(Boolean).join(" ");
  }
  function stepOf(v, dflt) {
    return STEPS.includes(v) ? v : dflt;
  }
  function toneCls(v) {
    // No default tone, and that is deliberate: in this app red means
    // recording-and-irreversible (docs/DESIGN.md loop table), so a tone class
    // appears only where the author asked for one.
    return TONES.includes(v) ? "tn-" + v : "";
  }
  function boxCls(node) {
    return [
      "g-" + stepOf(node.gap, 8),
      "p-" + stepOf(node.pad, 0),
      "al-" + (ALIGNS.includes(node.align) ? node.align : "start"),
      WIDTHS.includes(node.w) ? "w-" + node.w : "",
    ];
  }

  function errBlock(code, ctx) {
    const label = (ctx && ctx.strings && ctx.strings.refused) || "";
    return '<div class="extv-err">' + (label ? esc(label) + " " : "") +
      '<code class="mono">' + esc(code) + "</code></div>";
  }

  function moreBlock(n, ctx) {
    const tpl = (ctx && ctx.strings && ctx.strings.more) || "";
    return '<p class="extv-more">' + esc(String(tpl).replace("%1", String(n))) + "</p>";
  }

  // A `doc` is CONTENT, so an image and an external reference are stripped
  // rather than refused (contract §1.3) — and the strip happens on the
  // MARKDOWN SOURCE, never on produced HTML. Measured: desktop/src/text.js:67
  // turns an image with a remote target into a real image element and
  // text.js:74 turns a remote target into an anchor that opens a new context,
  // which are exactly the two things this contract has no locator for. A regex
  // over produced HTML would be the same injection bug one level up.
  const RE_IMG = /!\[([^\]]*)\]\([^)]*\)/g;
  const RE_LINK = /\[([^\]]*)\]\(([^)\s]*)[^)]*\)/g;
  function stripDoc(src) {
    return String(src)
      .replace(RE_IMG, "$1")
      // THE SAME GUARD THE `link` PRIMITIVE APPLIES, and it used to be a weaker
      // one: `RE_SCHEME` alone let `[x](../../../../etc/passwd)` and `[x]()`
      // through, and the reader turns those into a real anchor carrying a
      // `data-path`. `relOk` is the whole rule (no scheme, no `//`, no absolute
      // root, no `..`, no backslash), so what survives here is a project-relative
      // path and nothing else - which is what makes the host safe to WIRE that
      // anchor to the same guarded door every reference crosses.
      .replace(RE_LINK, (m, label, target) => (relOk(target) ? m : label));
  }

  function paintDoc(node, ctx, scope, st) {
    const got = strValue(node.md, ctx, scope);
    if (!got.ok) {
      st.add(got.code);
      return errBlock(got.code, ctx);
    }
    const cap = Number.isInteger(node.cap) && node.cap >= 1 && node.cap <= MAX_DOC_CAP ? node.cap : DOC_CAP;
    const lines = stripDoc(got.value).split("\n");
    const shown = lines.slice(0, cap).join("\n");
    const rest = lines.length - cap;
    // The upgrade path, and the reason it is optional: `ctx.md` is Loro's own
    // reader (LoroText.mdRender), which escapes its input at text.js:59 before
    // it formats anything. It is NOT in the frozen ctx of contract §8.C, so
    // absent it the block degrades to the escaped source — a document that
    // reads as plain text is honest; one that renders unescaped is not.
    const body = typeof (ctx && ctx.md) === "function"
      ? '<div class="extv-doc">' + ctx.md(shown) + "</div>"
      : '<div class="extv-doc" data-plain="true">' + esc(shown) + "</div>";
    return body + (rest > 0 ? moreBlock(rest, ctx) : "");
  }

  function paintText(node, ctx, scope, st) {
    const got = strValue(node.text, ctx, scope);
    if (!got.ok) {
      st.add(got.code);
      return errBlock(got.code, ctx);
    }
    const wrap = node.wrap === false;
    const attrs = [
      'class="' + cls(["extv-text", "sz-" + (SIZES.includes(node.size) ? node.size : "body"), toneCls(node.tone)]) + '"',
      node.family === "mono" ? 'data-family="mono"' : "",
      // wrap:false truncates with an ellipsis and keeps the FULL value in
      // `title`, so a truncation never becomes a loss.
      wrap ? 'data-wrap="false" title="' + esc(got.value) + '"' : "",
    ];
    return "<p " + attrs.filter(Boolean).join(" ") + ">" + esc(got.value) + "</p>";
  }

  function paintBadge(node, ctx, scope, st) {
    const got = strValue(node.text, ctx, scope);
    if (!got.ok) {
      st.add(got.code);
      return errBlock(got.code, ctx);
    }
    // The app's own badge, not a new one: `.badge` is mono with an 11px floor
    // (style.css:274/:2479, pinned by tests/tokens.test.js:1215). DESIGN §5 —
    // the same thing must not have two appearances.
    return '<span class="' + cls(["mono", "badge", toneCls(node.tone) || "tn-muted"]) + '">' +
      esc(got.value) + "</span>";
  }

  function paintIcon(node, ctx) {
    const d = ctx && ctx.icons && own(ctx.icons, node.name) ? ctx.icons[node.name] : "";
    // aria-hidden always: an icon is never the only carrier of meaning.
    return '<span class="' + cls(["extv-ico", toneCls(node.tone)]) + '" aria-hidden="true">' +
      (d ? '<svg viewBox="0 0 24 24"><path d="' + esc(d) + '"/></svg>' : "") + "</span>";
  }

  function paintLink(node, ctx, scope, st) {
    let rel;
    if (isRef(node.rel)) {
      const got = strValue(node.rel, ctx, scope);
      if (!got.ok) {
        st.add(got.code);
        return errBlock(got.code, ctx);
      }
      rel = got.value;
    } else {
      rel = typeof node.rel === "string" ? node.rel : "";
    }
    if (!relOk(rel)) {
      const code = "err.ext_view_value:link.rel";
      st.add(code);
      return errBlock(code, ctx);
    }
    // href="#" and not the path: the click is dispatched by app.js through the
    // same guard every acervo path goes through. An anchor with no href is out
    // of the focus order and has no link role, which is the mouse-only defect
    // text.js:70-72 records — so the href stays, and it stays inert.
    return '<a class="extv-link" href="#" data-extv-rel="' + esc(rel) + '">' +
      esc(i18nValue(node.label, ctx)) + "</a>";
  }

  function paintField(node, ctx, scope, st) {
    const domId = "extvf-" + st.ext + "-" + (st.seq += 1);
    const label = esc(i18nValue(node.label, ctx));
    const hint = node.hint ? esc(i18nValue(node.hint, ctx)) : "";
    const ph = node.placeholder ? esc(i18nValue(node.placeholder, ctx)) : "";
    let value = "";
    if (isRef(node.value)) {
      const got = strValue(node.value, ctx, scope);
      if (!got.ok) st.add(got.code);
      else value = got.value;
    } else if (node.value !== undefined && node.value !== null && typeof node.value !== "object") {
      value = String(node.value);
    }
    const common = 'id="' + domId + '" data-extv-field="' + esc(node.id) + '"' +
      (node.readonly === true ? " readonly" : "") +
      (hint ? ' aria-describedby="' + domId + '-h"' : "");
    let control;
    if (node.field === "enum") {
      let list = Array.isArray(node.options) ? node.options : [];
      let emptyOpt = "";
      if (isPlain(node.optionsFrom)) {
        const coll = factsOf(ctx, node.optionsFrom.of);
        const rows = coll && Array.isArray(coll.rows) ? coll.rows : [];
        list = rows.map((r) => {
          const v = own(r, node.optionsFrom.value) ? String(r[node.optionsFrom.value]) : "";
          const l = own(r, node.optionsFrom.label) ? String(r[node.optionsFrom.label]) : v;
          // a facts row is DATA, so the label is the extension's claim: it goes
          // through the same esc() below, never through i18n
          return { value: v, _raw: l };
        }).filter((o) => o.value);
        if (node.empty) {
          emptyOpt = '<option value=""' + (value === "" ? " selected" : "") + ">" +
            esc(i18nValue(node.empty, ctx)) + "</option>";
        }
      }
      const opts = emptyOpt + list.slice(0, MAX_OPTIONS).map((o) =>
        '<option value="' + esc(o.value) + '"' + (String(o.value) === value ? " selected" : "") + ">" +
        esc(o._raw !== undefined ? o._raw : i18nValue(o.label, ctx)) + "</option>").join("");
      control = "<select " + common + ">" + opts + "</select>";
    } else if (node.field === "bool") {
      control = '<input type="checkbox" ' + common +
        (value && value !== "false" ? " checked" : "") + ">";
    } else {
      control = '<input type="' + (node.field === "number" ? "number" : "text") + '" ' + common +
        (value ? ' value="' + esc(value) + '"' : "") +
        (ph ? ' placeholder="' + ph + '"' : "") +
        (typeof node.pattern === "string" && node.pattern ? ' pattern="' + esc(node.pattern) + '"' : "") +
        ">";
    }
    return '<div class="extv-field">' +
      '<label for="' + domId + '">' + label + "</label>" + control +
      (hint ? '<p class="extv-text sz-meta tn-muted" id="' + domId + '-h">' + hint + "</p>" : "") +
      "</div>";
  }

  function paintButton(node, ctx, scope, st) {
    if (isPlain(node.ask) && typeof node.ask.skill === "string" && RE_SKILL.test(node.ask.skill)) {
      // The target is resolved in the ROW's scope, same reason as args below:
      // the modal receives the card it was clicked on, not the last one.
      let target = "";
      if (node.ask.target !== undefined) {
        const got = strValue(node.ask.target, ctx, scope);
        if (!got.ok) st.add(got.code);
        else target = got.value;
      }
      const primary = node.primary === true;
      let solid = false;
      if (primary) {
        solid = st.primaries === 0;
        st.primaries += 1;
        if (!solid) st.add("err.ext_view_value:button.primary");
      }
      return "<button " + cls([
        'class="' + (solid ? "btn solid" : "btn") + '"',
        'data-extv-ask="' + esc(node.ask.skill) + '"',
        target ? 'data-extv-ask-target="' + esc(target) + '"' : "",
        node.ask.hint ? 'data-extv-ask-hint="' + esc(i18nValue(node.ask.hint, ctx)) + '"' : "",
        node.ask.placeholder ? 'data-extv-ask-ph="' + esc(i18nValue(node.ask.placeholder, ctx)) + '"' : "",
        node.disabled === true ? "disabled" : "",
      ]) + ">" + esc(i18nValue(node.label, ctx)) + "</button>";
    }
    // `args` is the author's own binding and it is what gives a card's button
    // a SUBJECT: it is resolved in the row's scope here, before the call, so
    // ext_action receives the row it was clicked on and not the last one.
    const args = {};
    if (isPlain(node.args)) {
      for (const k of Object.keys(node.args)) {
        const got = strValue(node.args[k], ctx, scope);
        if (!got.ok) st.add(got.code);
        else args[k] = got.value;
      }
    }
    const values = Array.isArray(node.values) ? node.values.join(",") : "";
    // The SECOND primary is refused BY NAME and painted as an ordinary button:
    // two filled buttons competing is the screen claiming both are THE action.
    const primary = node.primary === true;
    let solid = false;
    if (primary) {
      solid = st.primaries === 0;
      st.primaries += 1;
      if (!solid) st.add("err.ext_view_value:button.primary");
    }
    return "<button " + cls([
      'class="' + (solid ? "btn solid" : "btn") + '"',
      'data-extv-action="' + esc(node.action) + '"',
      values ? 'data-extv-values="' + esc(values) + '"' : "",
      Object.keys(args).length ? "data-extv-args=\"" + esc(JSON.stringify(args)) + '"' : "",
      node.confirm ? 'data-extv-confirm="' + esc(i18nValue(node.confirm, ctx)) + '"' : "",
      node.disabled === true ? "disabled" : "",
    ]) + ">" + esc(i18nValue(node.label, ctx)) + "</button>";
  }

  function rowMatches(row, where, ctx, scope, st) {
    if (!isPlain(where)) return true;
    for (const key of Object.keys(where)) {
      const op = where[key];
      const got = dig(row, key);
      if (!isPlain(op)) return false;
      if (own(op, "gt")) {
        if (!(got.ok && Number(got.value) > Number(op.gt))) return false;
        continue;
      }
      if (own(op, "has")) {
        // the search operator: case-folded substring, and an EMPTY needle
        // matches everything — an empty box is not a filter, and hiding the
        // whole board behind it would read as data loss
        let needle = op.has;
        if (isRef(needle)) {
          const r = strValue(needle, ctx, scope);
          if (!r.ok) {
            st.add(r.code);
            return false;
          }
          needle = r.value;
        }
        const hay = got.ok ? String(got.value).toLowerCase() : "";
        if (String(needle).toLowerCase() && !hay.includes(String(needle).toLowerCase())) return false;
        continue;
      }
      let want = op.eq;
      if (isRef(want)) {
        const r = strValue(want, ctx, scope);
        if (!r.ok) {
          st.add(r.code);
          return false;
        }
        want = r.value;
      }
      if (!got.ok) return false;
      if (typeof got.value === "number" && typeof want === "number") {
        if (got.value !== want) return false;
      } else if (String(got.value) !== String(want)) return false;
    }
    return true;
  }

  function paintEach(node, ctx, scope, st, nest) {
    const coll = factsOf(ctx, node.of);
    if (!coll || !Array.isArray(coll.rows)) {
      const code = "err.ext_view_facts:" + detail(node.of);
      st.add(code);
      return errBlock(code, ctx);
    }
    // The `where` is resolved in the ENCLOSING scope, not the row's: the inner
    // each of the kanban filters on `{"$":"col.context"}`, which only exists
    // one frame out. Measured: hand `rowMatches` a scope holding just the row
    // and the board renders two empty columns with `err.ext_view_ref:col.context`.
    const rows = coll.rows.filter((r) => rowMatches(r, node.where, ctx, scope, st));
    const cap = Number.isInteger(node.cap) && node.cap >= 1 && node.cap <= MAX_EACH_CAP ? node.cap : EACH_CAP;
    let html = "";
    for (const row of rows.slice(0, cap)) {
      // A NEW frame each row, never a mutated one, and it COPIES the enclosing
      // scope: the outer row stays visible, which is what lets the body of an
      // inner each read the column it sits in. Measured: replace the copy with
      // a bare frame and a body reading `col.context` alongside `hs.hotspot`
      // renders four rows with `err.ext_view_ref:col.context` in each.
      const inner = Object.assign(Object.create(null), scope);
      inner[node.as] = row;
      html += paint(node.body, ctx, inner, st, nest + 1);
    }
    // The remainder past the cap is COUNTED, never silently cut: a list that
    // just stops is a dead end.
    const rest = rows.length - cap;
    return html + (rest > 0 ? moreBlock(rest, ctx) : "");
  }

  function paintWhen(node, ctx, scope, st, nest) {
    const wantsExists = node.exists !== undefined;
    let got = { ok: true, value: node.value };
    if (isRef(node.value)) {
      const r = resolveRef(node.value.$, ctx, scope);
      got = r.ok ? { ok: true, value: r.value } : { ok: false };
      // An unresolved read is an error EXCEPT under `exists`, whose whole job
      // is to ask the question.
      if (!r.ok && !wantsExists) st.add("err.ext_view_ref:" + detail(node.value.$));
    }
    let yes = false;
    if (wantsExists) yes = got.ok === (node.exists === true);
    else if (node.gt !== undefined) yes = got.ok && Number(got.value) > Number(node.gt);
    else yes = got.ok && String(got.value) === String(node.is);
    const branch = yes ? node.then : node.else;
    return (Array.isArray(branch) ? branch : []).map((n) => paint(n, ctx, scope, st, nest + 1)).join("");
  }

  function paint(node, ctx, scope, st, nest) {
    if (nest > MAX_NEST) {
      const code = "err.ext_view_depth:" + MAX_NEST;
      st.add(code);
      return errBlock(code, ctx);
    }
    if (!isPlain(node) || typeof node.kind !== "string") {
      const code = "err.ext_view_node:" + detail(isPlain(node) ? node.kind : typeof node);
      st.add(code);
      return errBlock(code, ctx);
    }
    const k = node.kind;
    if (k === "_err") return errBlock(node.code, ctx);
    if (k === "bind") {
      const params = Object.create(null);
      for (const p of Object.keys(node.params)) {
        const got = strValue(node.params[p], ctx, scope);
        // An unresolved argument is left ABSENT rather than emptied, so the
        // refusal surfaces where the body reads it — which is where the hole
        // is visible on screen.
        if (got.ok) params[p] = got.value;
        else st.add(got.code);
      }
      const inner = Object.assign(Object.create(null), scope);
      inner.param = params;
      return paint(node.body, ctx, inner, st, nest + 1);
    }
    if (k === "each") return paintEach(node, ctx, scope, st, nest);
    if (k === "when") return paintWhen(node, ctx, scope, st, nest);
    if (LAYOUTS.includes(k)) {
      const kids = (Array.isArray(node.children) ? node.children : [])
        .map((c) => paint(c, ctx, scope, st, nest + 1)).join("");
      if (k === "grid") {
        const cols = Number.isInteger(node.cols) && node.cols >= 2 && node.cols <= 6 ? node.cols : 0;
        if (!cols) {
          const code = "err.ext_view_value:grid.cols";
          st.add(code);
          return errBlock(code, ctx);
        }
        return '<div class="' + cls(["extv-grid", "c-" + cols].concat(boxCls(node))) + '">' + kids + "</div>";
      }
      if (k === "scroll") {
        const max = SCROLL_MAX.includes(node.max) ? node.max : "md";
        const x = node.axis === "x";
        return '<div class="' + cls(["extv-scroll", x ? "extv-scroll-x" : "", "mx-" + max].concat(boxCls(node))) +
          '">' + kids + "</div>";
      }
      if (k === "row") {
        return '<div class="' + cls(["extv-row", node.wrap === true ? "extv-row-wrap" : ""].concat(boxCls(node))) +
          '">' + kids + "</div>";
      }
      return '<div class="' + cls(["extv-stack", node.surface === true ? "extv-surface" : ""].concat(boxCls(node))) + '">' + kids + "</div>";
    }
    if (k === "text") return paintText(node, ctx, scope, st);
    if (k === "badge") return paintBadge(node, ctx, scope, st);
    if (k === "icon") return paintIcon(node, ctx);
    if (k === "link") return paintLink(node, ctx, scope, st);
    if (k === "field") return paintField(node, ctx, scope, st);
    if (k === "button") return paintButton(node, ctx, scope, st);
    if (k === "doc") return paintDoc(node, ctx, scope, st);
    if (k === "divider") return '<hr class="extv-div">';
    if (k === "spacer") return '<div class="extv-spacer" data-step="' + stepOf(node.size, 8) + '" aria-hidden="true"></div>';
    const code = "err.ext_view_node:" + detail(k);
    st.add(code);
    return errBlock(code, ctx);
  }

  function render(doc, ctx) {
    const c = isPlain(ctx) ? ctx : {};
    const st = {
      errors: [],
      seq: 0,
      // DESIGN.md §1 and §2 rule 4 — ONE primary action per screen. Nothing
      // enforced it: any number of `primary: true` nodes came out as
      // `.btn.solid` (measured in the real DOM: two filled buttons, zero
      // refusals). The count lives in the PAINT state and not in validation,
      // because one component used twice paints two buttons from one
      // declaration.
      primaries: 0,
      // The DOM id namespace. Only [a-z0-9-] survives, so an extension id
      // cannot write an attribute boundary into an id.
      ext: String(c.extId || "").toLowerCase().replace(/[^a-z0-9-]/g, "") || "x",
      add(code) {
        if (!st.errors.includes(code)) st.errors.push(code);
      },
    };
    const v = validate(doc);
    for (const e of v.errors) st.add(e);
    const attr = (c.strings && c.strings.attribution) || "";
    // The attribution line is the container's FIRST child, so anything below
    // it reads as the EXTENSION's claim and not as Loro's: DESIGN §1, the
    // state never lies about who is asserting it.
    const head = '<div class="extv" data-ext="' + esc(st.ext) + '">' +
      (attr ? '<p class="extv-attr">' + esc(attr) + "</p>" : "");
    const fatal = st.errors.filter((e) =>
      e.indexOf("err.ext_view_version:") === 0 || e === "err.ext_view_empty");
    if (fatal.length) {
      return { html: head + fatal.map((e) => errBlock(e, c)).join("") + "</div>", errors: st.errors };
    }
    const ex = expand(doc);
    for (const e of ex.errors) st.add(e);
    let body = ex.nodes.map((n) => paint(n, c, Object.create(null), st, 1)).join("");
    if (!body) {
      const empty = (c.strings && c.strings.empty) || "";
      if (empty) body = '<p class="extv-text sz-body tn-muted">' + esc(empty) + "</p>";
    }
    return { html: head + body + "</div>", errors: st.errors };
  }

  return {
    esc, validate, expand, render, relOk, stripDoc,
    CLASSES, TONES, STEPS, SIZES, ALIGNS, FAMILIES, ICONS_ALLOWED, FACTS,
    MAX_DEPTH, MAX_NODES, MAX_NEST, EACH_CAP, DOC_CAP, MAX_CHILDREN,
  };
});
