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
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) =>
      /^https?:/.test(u) ? `<a href="${u}" target="_blank">${t}</a>` : `<a data-path="${u}">${t}</a>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/(^|\s)\*([^*\n]+)\*(?=$|[\s.,;:!?)])/g, "$1<em>$2</em>");
    s = s.replace(/(^|\s)_([^_\n]+)_(?=$|[\s.,;:!?)])/g, "$1<em>$2</em>");
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
    return s;
  }

  // Block level: h1–h6, ul/ol (nested by indentation, task lists), blockquote,
  // tables, fenced code (with language), hr, paragraphs.
  function mdRender(src) {
    const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
    let html = "", i = 0, inCode = false, inQuote = false;
    const listStack = [];
    const closeLists = (depth = 0) => {
      while (listStack.length > depth) html += listStack.pop() === "ul" ? "</ul>" : "</ol>";
    };
    const closeQuote = () => { if (inQuote) { html += "</blockquote>"; inQuote = false; } };
    while (i < lines.length) {
      const raw = lines[i];
      const fence = raw.match(/^```(\w*)/);
      if (fence) {
        closeLists(); closeQuote();
        if (!inCode) { inCode = true; html += `<pre><code${fence[1] ? ` class="lang-${fence[1]}"` : ""}>`; }
        else { inCode = false; html += "</code></pre>"; }
        i++; continue;
      }
      if (inCode) { html += esc(raw) + "\n"; i++; continue; }
      // table (header row followed by separator row)
      if (/^\s*\|.*\|\s*$/.test(raw) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        closeLists(); closeQuote();
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
        closeLists();
        if (!inQuote) { inQuote = true; html += "<blockquote>"; }
        if (q[1].trim()) html += "<p>" + inlineMd(q[1]) + "</p>";
        i++; continue;
      }
      closeQuote();
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(raw)) { closeLists(); html += "<hr>"; i++; continue; }
      const h = raw.match(/^(#{1,6})\s+(.*)$/);
      if (h) { closeLists(); const n = h[1].length; html += `<h${n}>${inlineMd(h[2])}</h${n}>`; i++; continue; }
      const li = raw.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (li) {
        const depth = Math.floor(li[1].replace(/\t/g, "  ").length / 2) + 1;
        const type = /^\d/.test(li[2]) ? "ol" : "ul";
        if (listStack.length > depth) closeLists(depth);
        if (listStack.length === depth && listStack[depth - 1] !== type) closeLists(depth - 1);
        while (listStack.length < depth) { listStack.push(type); html += type === "ul" ? "<ul>" : "<ol>"; }
        let content = li[3];
        const task = content.match(/^\[( |x|X)\]\s+(.*)$/);
        content = task
          ? `<input type="checkbox" disabled${task[1].toLowerCase() === "x" ? " checked" : ""}> ` + inlineMd(task[2])
          : inlineMd(content);
        html += `<li>${content}</li>`;
        i++; continue;
      }
      closeLists();
      if (raw.trim() === "") { i++; continue; }
      html += "<p>" + inlineMd(raw) + "</p>";
      i++;
    }
    closeLists(); closeQuote(); if (inCode) html += "</code></pre>";
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
