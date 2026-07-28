// Loro — fuzzy matcher for the command-palette quick-open (ADR-0008).
// Pure, no DOM: loaded in the browser via <script> (defines window.LoroFuzzy)
// and in Node via require(). Subsequence match with contiguity, word-boundary
// and basename bonuses; NFD-folds diacritics so 'reuniao' matches 'reunião'.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroFuzzy = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  // Scoring weights are relative only; every ranking rule is an inequality that
  // holds for any positive values. A basename hit dominates a dir-only hit, a
  // word-boundary hit beats a mid-word hit, contiguity beats scattering.
  const BASE = 1;
  const CONTIGUITY = 5;
  const BOUNDARY = 8;
  const BASENAME = 15;

  // Word boundaries in file paths: segment/word separators. A char is at a
  // boundary when it starts the region or follows one of these.
  const SEP = /[/\-_. ]/;

  // pt-BR diacritic folding: 'reunião' -> 'reuniao', 'análise' -> 'analise'.
  function fold(s) {
    return String(s)
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase();
  }

  // Greedy leftmost subsequence match over one already-folded region.
  // Returns a score, or null when query is not a subsequence of text.
  function matchRegion(query, text) {
    let s = 0;
    let ti = 0;
    let prev = -2; // index of the previous matched char (for contiguity)
    for (let qi = 0; qi < query.length; qi++) {
      const c = query[qi];
      const found = text.indexOf(c, ti);
      if (found === -1) return null;
      s += BASE;
      if (found === prev + 1) s += CONTIGUITY;
      if (found === 0 || SEP.test(text[found - 1])) s += BOUNDARY;
      prev = found;
      ti = found + 1;
    }
    return s;
  }

  // Case-insensitive, diacritic-insensitive subsequence score.
  // Empty query -> 0 (matches everything; caller shows MRU). null when no match.
  function score(query, target) {
    const q = fold(query);
    if (q.length === 0) return 0;
    const t = fold(target);

    const full = matchRegion(q, t);

    // A hit inside the basename (after the last '/') is preferred over a hit
    // that only lands in the directory portion.
    const slash = t.lastIndexOf("/");
    if (slash >= 0) {
      const inBase = matchRegion(q, t.slice(slash + 1));
      if (inBase !== null) return Math.max(full, inBase + BASENAME);
    }
    return full;
  }

  // Sort items by descending score, dropping non-matches. Stable for equal
  // scores (original order preserved). keyFn extracts the string to match.
  function filter(query, items, keyFn) {
    return items
      .map((item, i) => ({ item, i, s: score(query, keyFn(item)) }))
      .filter((r) => r.s !== null)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((r) => r.item);
  }

  return { score, filter };
});
