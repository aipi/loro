// Loro — text/markdown utilities. Isolated, testable module:
// loaded in the browser via <script> (defines window.LoroText) and in Node via require().
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroText = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  function esc(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }

  // live-transcript inline formatting: speaker label + bold + italic + code.
  // Redesign 1f: o operador ("você") e os demais canais são cores diferentes —
  // `.spk--me` carrega essa distinção; a classe base segue idêntica.
  const ME = /^(?:\*\*)?(voc[eê]|you|eu|me)\s*:/i;
  function mdInline(s) {
    s = s.replace(/^((?:\*\*)?[A-ZÁ-Ú][\wÀ-ÿ ]{0,24}(?:_\d+)?:(?:\*\*)?)/,
      (m) => `<span class="spk${ME.test(m) ? " spk--me" : ""}">${m}</span>`);
    s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|\s)_([^_\n]+)_(?=$|[\s.,;:!?)])/g, "$1<em>$2</em>");
    s = s.replace(/`(.+?)`/g, "<code>$1</code>");
    return s;
  }

  // ---- full markdown (acervo reader) ----
  // Inline with safe escaping: code spans are extracted first so their content
  // never receives further formatting.
  function inlineMd(s) {
    s = esc(String(s));
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => {
      codes.push(c);
      return "\u0000" + (codes.length - 1) + "\u0000";
    });
    // images: http/data render; local paths become a label (WebView can't read disk)
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, u) =>
      /^(https?:|data:)/.test(u) ? `<img src="${u}" alt="${alt}">` : `<em>[imagem: ${alt || u}]</em>`);
    // An internal reference carries its target in data-path (app.js dispatches it
    // through brain_resolve_ref and calls preventDefault), but it still needs an
    // href: an <a> without one is out of the tab order and has no link role, so
    // the document-to-document navigation was mouse-only (WCAG 2.1.1 / 4.1.2).
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) =>
      /^https?:/.test(u) ? `<a href="${u}" target="_blank">${t}</a>` : `<a href="#" data-path="${u}">${t}</a>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/(^|\s)\*([^*\n]+)\*(?=$|[\s.,;:!?)])/g, "$1<em>$2</em>");
    s = s.replace(/(^|\s)_([^_\n]+)_(?=$|[\s.,;:!?)])/g, "$1<em>$2</em>");
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
    return s;
  }

  // A hard line break the author asked for (line ended in two spaces). It has to
  // survive the join as a sentinel, because inlineMd escapes "<".
  const BREAK = "\u0001";
  const joinLines = (parts) =>
    parts.reduce((a, p) => (a === "" ? p : a.endsWith(BREAK) ? a + p : a + " " + p), "");
  const inlineBlock = (parts) => inlineMd(joinLines(parts)).split(BREAK).join("<br>");

  // Block level: h1–h6, ul/ol (nested by indentation, task lists), blockquote,
  // tables, fenced code (with language), hr, paragraphs.
  //
  // Paragraphs follow CommonMark lazy continuation: consecutive non-blank lines
  // are ONE paragraph and a wrapped list item continues that item, so the join
  // happens BEFORE inlineMd — emphasis or a link spanning a wrap is parsed
  // instead of reaching the reader as literal `_`/`[` characters. A blank line
  // separates paragraphs and every other construct (fence, table, quote, hr,
  // heading, list item) interrupts one; fenced code is never joined.
  function mdRender(src) {
    const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
    let html = "", i = 0, inCode = false, inQuote = false;
    const listStack = [];
    let para = [];    // lines of the paragraph being read
    let item = null;  // { pre, parts } of the list item being read
    const flushPara = () => {
      if (para.length) { html += "<p>" + inlineBlock(para) + "</p>"; para = []; }
    };
    const flushItem = () => {
      if (item) { html += `<li>${item.pre}${inlineBlock(item.parts)}</li>`; item = null; }
    };
    const pushLine = (l) => {
      const text = l.trim() + (/\S {2,}$/.test(l) ? BREAK : "");
      (item ? item.parts : para).push(text);
    };
    const closeLists = (depth = 0) => {
      flushItem();
      while (listStack.length > depth) html += listStack.pop() === "ul" ? "</ul>" : "</ol>";
    };
    const closeQuote = () => { if (inQuote) { html += "</blockquote>"; inQuote = false; } };
    // everything a new block has to leave behind, in the order it closes
    const endBlocks = () => { flushPara(); closeLists(); closeQuote(); };
    while (i < lines.length) {
      const raw = lines[i];
      const fence = raw.match(/^```(\w*)/);
      if (fence) {
        endBlocks();
        if (!inCode) { inCode = true; html += `<pre><code${fence[1] ? ` class="lang-${fence[1]}"` : ""}>`; }
        else { inCode = false; html += "</code></pre>"; }
        i++; continue;
      }
      if (inCode) { html += esc(raw) + "\n"; i++; continue; }
      // table (header row followed by separator row)
      if (/^\s*\|.*\|\s*$/.test(raw) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        endBlocks();
        const row = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inlineMd(c.trim()));
        html += "<table><thead><tr>" + row(raw).map((c) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>";
        i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          html += "<tr>" + row(lines[i]).map((c) => `<td>${c}</td>`).join("") + "</tr>";
          i++;
        }
        html += "</tbody></table>"; continue;
      }
      const q = raw.match(/^\s*>\s?(.*)$/);
      if (q) {
        // N25 · `[!HOTSPOT]` is the marker the knowledge template writes so the
        // agent can find an open point again (templates.rs) — machine syntax that
        // was reaching the reader as literal prose on the surface ADR-0018 makes
        // the product's output. It is consumed here and becomes what it always
        // named: a callout whose first line is its title.
        const hs = q[1].match(/^\[!HOTSPOT\]\s*(.*)$/i);
        if (!inQuote) {
          flushPara(); closeLists(); inQuote = true;
          html += hs ? '<blockquote class="hotspot">' : "<blockquote>";
        }
        // A quote keeps ONE paragraph per line, against CommonMark on purpose: the
        // knowledge document's hotspot callout (`> [!HOTSPOT] …` + one line per
        // field, templates.rs) is written that way and reads as a block of fields.
        const line = hs ? hs[1] : q[1];
        if (line.trim()) html += (hs ? '<p class="hstitle">' : "<p>") + inlineMd(line) + "</p>";
        i++; continue;
      }
      closeQuote();
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(raw)) { flushPara(); closeLists(); html += "<hr>"; i++; continue; }
      const h = raw.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushPara(); closeLists();
        const n = h[1].length; html += `<h${n}>${inlineMd(h[2])}</h${n}>`;
        i++; continue;
      }
      const li = raw.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (li) {
        const depth = Math.floor(li[1].replace(/\t/g, "  ").length / 2) + 1;
        const type = /^\d/.test(li[2]) ? "ol" : "ul";
        flushPara(); flushItem();
        if (listStack.length > depth) closeLists(depth);
        if (listStack.length === depth && listStack[depth - 1] !== type) closeLists(depth - 1);
        while (listStack.length < depth) { listStack.push(type); html += type === "ul" ? "<ul>" : "<ol>"; }
        const task = li[3].match(/^\[( |x|X)\]\s+(.*)$/);
        item = {
          pre: task ? `<input type="checkbox" disabled${task[1].toLowerCase() === "x" ? " checked" : ""}> ` : "",
          parts: [],
        };
        pushLine(task ? task[2] : li[3]);
        i++; continue;
      }
      if (raw.trim() === "") { endBlocks(); i++; continue; }
      // lazy continuation: of the open list item, else of the open paragraph
      if (!item) closeLists();
      pushLine(raw);
      i++;
    }
    endBlocks(); if (inCode) html += "</code></pre>";
    return html;
  }

  // merge persisted settings over defaults: only known keys with matching types
  function mergeSettings(defaults, stored) {
    const out = { ...defaults };
    if (!stored || typeof stored !== "object") return out;
    for (const k of Object.keys(defaults)) {
      if (k in stored && typeof stored[k] === typeof defaults[k]) out[k] = stored[k];
    }
    return out;
  }

  return { esc, mdInline, inlineMd, mdRender, mergeSettings };
});
