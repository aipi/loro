// Loro — annotation anchoring (ADR-0007). Isolated, testable module: loaded in
// the browser via <script> (defines window.LoroAnnotate) and in Node via
// require(). Highlights/comments are anchored by TEXT QUOTE + bounded context
// (the W3C Web Annotation / hypothes.is model), never by an absolute offset, so
// a passage survives re-render and — because a transcript is append-only —
// survives live appends. Anchor logic (makeAnchor/locate) is PURE string logic,
// no DOM; paintRange is browser-only and defined only when a document exists.
// Everything is TOTAL: malformed input degrades (null / no-op), never throws.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroAnnotate = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  // How much surrounding text an anchor remembers on each side. Enough to
  // disambiguate a repeated quote; short enough that a light edit near the
  // passage still leaves the quote itself findable.
  const CTX = 40;

  function esc(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Chars shared at the END of `a` and `b` (used to score a candidate's prefix).
  function commonSuffixLen(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
  }
  // Chars shared at the START of `a` and `b` (used to score a candidate's suffix).
  function commonPrefixLen(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  }

  // Build a text-quote anchor for [start, end) within `textContent`.
  function makeAnchor(textContent, start, end) {
    const t = String(textContent == null ? "" : textContent);
    let s = Math.max(0, Math.min(t.length, start | 0));
    let e = Math.max(s, Math.min(t.length, end | 0));
    return {
      quote: t.slice(s, e),
      prefix: t.slice(Math.max(0, s - CTX), s),
      suffix: t.slice(e, e + CTX),
    };
  }

  // Whitespace-tolerant fallback: match the quote's words with `\s+` between
  // them, so a re-render that re-wrapped lines still resolves the passage.
  function fuzzyFind(text, quote) {
    const words = String(quote).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    try {
      const rx = new RegExp(words.map(esc).join("\\s+"));
      const m = rx.exec(text);
      if (m) return { start: m.index, end: m.index + m[0].length };
    } catch (_e) {
      /* pathological quote → treat as orphan */
    }
    return null;
  }

  // Resolve an anchor against the current `textContent`. Order: exact (unique) →
  // exact (disambiguated by prefix/suffix context) → whitespace-fuzzy → orphan.
  // Returns { start, end } or null; NEVER throws.
  function locate(textContent, anchor) {
    const text = String(textContent == null ? "" : textContent);
    const quote = anchor && anchor.quote != null ? String(anchor.quote) : "";
    if (!quote) return null;
    const prefix = anchor && anchor.prefix != null ? String(anchor.prefix) : "";
    const suffix = anchor && anchor.suffix != null ? String(anchor.suffix) : "";

    const hits = [];
    for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) hits.push(i);

    if (hits.length === 1) return { start: hits[0], end: hits[0] + quote.length };
    if (hits.length > 1) {
      let best = hits[0];
      let bestScore = -1;
      for (const h of hits) {
        const before = text.slice(Math.max(0, h - prefix.length), h);
        const after = text.slice(h + quote.length, h + quote.length + suffix.length);
        const score = commonSuffixLen(prefix, before) + commonPrefixLen(suffix, after);
        if (score > bestScore) {
          bestScore = score;
          best = h;
        }
      }
      return { start: best, end: best + quote.length };
    }
    return fuzzyFind(text, quote);
  }

  // ---- browser-only DOM painter ----------------------------------------------
  // Wrap the plain-text range [start, end) (offsets into `container.textContent`)
  // in <mark {...attrs}>, splitting across text nodes/inline elements as needed —
  // the same TreeWalker technique as the ⌘F highlighter (app.js runFind),
  // generalized. Returns the list of <mark> elements created. No-op off-DOM.
  function paintRange(container, start, end, attrs) {
    if (typeof document === "undefined" || !container || end <= start) return [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    const marks = [];
    let pos = 0;
    let node;
    const nodes = [];
    while ((node = walker.nextNode())) nodes.push(node);
    for (const n of nodes) {
      const len = n.nodeValue.length;
      const nodeStart = pos;
      const nodeEnd = pos + len;
      pos = nodeEnd;
      if (nodeEnd <= start || nodeStart >= end) continue;
      const from = Math.max(0, start - nodeStart);
      const to = Math.min(len, end - nodeStart);
      const s = n.nodeValue;
      const frag = document.createDocumentFragment();
      if (from > 0) frag.appendChild(document.createTextNode(s.slice(0, from)));
      const mark = document.createElement("mark");
      for (const k in attrs || {}) mark.setAttribute(k, attrs[k]);
      mark.textContent = s.slice(from, to);
      frag.appendChild(mark);
      marks.push(mark);
      if (to < len) frag.appendChild(document.createTextNode(s.slice(to)));
      n.replaceWith(frag);
    }
    return marks;
  }

  return { makeAnchor, locate, paintRange, CTX };
});
