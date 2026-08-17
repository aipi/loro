// Loro — text/markdown utilities. Isolated, testable module:
// loaded in the browser via <script> (defines window.LoroText) and in Node via require().
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroText = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  // AS CINCO, não três. Isto escapava só `& < >`, e o app interpola texto de
  // TERCEIROS dentro de ATRIBUTOS: título de PR (qualquer autor de fork),
  // caminho de arquivo, nome de check, endereço de conversa. Uma aspa fechava o
  // atributo — `Prazo" style="position:fixed;inset:0;…` punha um style na linha, e
  // o CSP do app permite style inline. E mesmo sem malícia, um caminho com `"`
  // (legal no macOS/Linux) truncava `data-rvfull`, e o cartão virava um controle
  // que não faz nada. Escapar aspas é correto nos dois contextos: dentro de
  // atributo o navegador decodifica, e em texto também.
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
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
  // ADR-0026 §2 — three destinations, three marks. A jump to another context is a
  // NAME (prose), a jump to a material is a PATH (the machine's half of the line,
  // DESIGN.md §3) and an external ticket is a LOCATOR. They were drawn alike, so
  // the reader could not tell what a click would do before clicking.
  const CTX_TARGET = /(^|\/)(context|CLAUDE|AGENTS|INDEX)\.md$/;
  function xrefClass(u) {
    if (/^https?:/.test(u)) return "xref xref--web";
    return CTX_TARGET.test(u) ? "xref xref--ctx" : "xref xref--file";
  }

  // A locator the acervo cites by id (`MM-1147`). Two characters minimum on the
  // prefix on purpose: it must never swallow the acervo's own ids — `H-3` and
  // `D-2026-07-23-slug` both open with a single letter.
  const LOCATOR = /\b([A-Z][A-Z0-9]{1,4})-(\d{1,6})\b/g;

  // Sentinel for an already-finished anchor (distinct from the code-span one).
  const RAW = "";

  // Inline with safe escaping: code spans are extracted first so their content
  // never receives further formatting, and finished anchors are stashed the same
  // way — a locator inside a link label would otherwise nest one <a> in another.
  function inlineMd(s, opts) {
    const ticketBase = (opts && opts.ticketBase) || "";
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
    const raws = [];
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) => {
      raws.push(/^https?:/.test(u)
        ? `<a class="${xrefClass(u)}" href="${u}" target="_blank">${t}</a>`
        : `<a class="${xrefClass(u)}" href="#" data-path="${u}">${t}</a>`);
      return RAW + (raws.length - 1) + RAW;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/(^|\s)\*([^*\n]+)\*(?=$|[\s.,;:!?)])/g, "$1<em>$2</em>");
    s = s.replace(/(^|\s)_([^_\n]+)_(?=$|[\s.,;:!?)])/g, "$1<em>$2</em>");
    // The locator is mono either way; it only becomes clickable when the project
    // carries a base URL — the app never invents where an external id lives.
    s = s.replace(LOCATOR, (m) =>
      ticketBase
        ? `<a class="loc" href="${ticketBase}${m}" target="_blank">${m}</a>`
        : `<span class="loc">${m}</span>`);
    s = s.replace(new RegExp(RAW + "(\\d+)" + RAW, "g"), (_, i) => raws[+i]);
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
    return s;
  }

  // A hard line break the author asked for (line ended in two spaces). It has to
  // survive the join as a sentinel, because inlineMd escapes "<".
  const BREAK = "\u0001";
  const joinLines = (parts) =>
    parts.reduce((a, p) => (a === "" ? p : a.endsWith(BREAK) ? a + p : a + " " + p), "");
  const inlineBlock = (parts, opts) => inlineMd(joinLines(parts), opts).split(BREAK).join("<br>");

  // ADR-0026 §2 — the summary card (§0) is the surface every retrieval path lands
  // on first, and it is a list of definitions, not body prose. The heading names
  // it in both languages; the list that follows it carries the mark, so the
  // stylesheet can contain the card without rewriting a single authored word
  // (DESIGN.md §3: a table in a document keeps the words the author wrote).
  const SUMMARY_HEADING = /^0\s*[·•.\-)]?\s*(sum[áa]rio|summary)\b/i;

  // Block level: h1–h6, ul/ol (nested by indentation, task lists), blockquote,
  // tables, fenced code (with language), hr, paragraphs.
  //
  // Paragraphs follow CommonMark lazy continuation: consecutive non-blank lines
  // are ONE paragraph and a wrapped list item continues that item, so the join
  // happens BEFORE inlineMd — emphasis or a link spanning a wrap is parsed
  // instead of reaching the reader as literal `_`/`[` characters. A blank line
  // separates paragraphs and every other construct (fence, table, quote, hr,
  // heading, list item) interrupts one; fenced code is never joined.
  function mdRender(src, opts) {
    const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
    let html = "", i = 0, inCode = false, inQuote = false, summaryNext = false;
    const listStack = [];
    let para = [];    // lines of the paragraph being read
    let item = null;  // { pre, parts } of the list item being read
    const flushPara = () => {
      if (para.length) { html += "<p>" + inlineBlock(para, opts) + "</p>"; para = []; }
    };
    const flushItem = () => {
      if (item) { html += `<li>${item.pre}${inlineBlock(item.parts, opts)}</li>`; item = null; }
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
        const row = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inlineMd(c.trim(), opts));
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
        // ADR-0026 §15 · o apelido do ponto em aberto (`cancelamento-cdc`, ou o
        // `H-3` de um acervo escrito antes) é ENDEREÇO, não prosa: vira a âncora
        // do bloco e sai do texto, como o marcador que o precede. Sem ele, uma
        // citação de outro documento não teria onde aterrissar; com ele impresso,
        // o leitor lia sintaxe de máquina no meio da frase.
        const hsId = hs ? /^([A-Za-z][A-Za-z0-9-]*)\s+[—–-]\s+/.exec(hs[1]) : null;
        if (!inQuote) {
          flushPara(); closeLists(); inQuote = true;
          html += hs
            ? `<blockquote class="hotspot"${hsId ? ` id="${hsId[1]}"` : ""}>`
            : "<blockquote>";
        }
        // A quote keeps ONE paragraph per line, against CommonMark on purpose: the
        // knowledge document's hotspot callout (`> [!HOTSPOT] …` + one line per
        // field, templates.rs) is written that way and reads as a block of fields.
        // O id VOLTA à tela — como localizador, não como prosa: buscável no Cmd+F,
        // copiável para citar em outro documento, e tipograficamente marcado como
        // a metade da máquina da linha (DESIGN.md §3). O que ele não é mais é uma
        // palavra no meio da frase do título.
        const line = hs ? (hsId ? hs[1].slice(hsId[0].length) : hs[1]) : q[1];
        if (line.trim()) {
          html += (hs ? '<p class="hstitle">' : "<p>") + inlineMd(line, opts) + "</p>";
          // o id em linha PRÓPRIA, abaixo do título: o título é a frase que se lê,
          // o id é o endereço que se copia — duas coisas, duas linhas
          if (hs && hsId) html += `<p class="hsid loc">${hsId[1]}</p>`;
        }
        i++; continue;
      }
      closeQuote();
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(raw)) { flushPara(); closeLists(); html += "<hr>"; i++; continue; }
      const h = raw.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushPara(); closeLists();
        const n = h[1].length; html += `<h${n}>${inlineMd(h[2], opts)}</h${n}>`;
        summaryNext = SUMMARY_HEADING.test(h[2].trim());
        i++; continue;
      }
      const li = raw.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (li) {
        const depth = Math.floor(li[1].replace(/\t/g, "  ").length / 2) + 1;
        const type = /^\d/.test(li[2]) ? "ol" : "ul";
        flushPara(); flushItem();
        if (listStack.length > depth) closeLists(depth);
        if (listStack.length === depth && listStack[depth - 1] !== type) closeLists(depth - 1);
        while (listStack.length < depth) {
          listStack.push(type);
          const card = type === "ul" && summaryNext && listStack.length === 1;
          if (card) summaryNext = false;
          html += type === "ol" ? "<ol>" : card ? '<ul class="summary">' : "<ul>";
        }
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
