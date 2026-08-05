// Loro — comandos de formatação markdown da barra de edição (ADR-0016).
// Módulo isolado e testável: carregado no browser via <script> (define
// window.LoroMdEdit) e no Node via require().
//
// A decisão do ADR-0016 é markdown-aware, não WYSIWYG: cada comando é uma
// função PURA que recebe o documento e a seleção e devolve a edição mínima
// (`changes`) mais a nova seleção — o formato que o CM6 despacha. Nada
// reserializa o documento, então o diff no git continua sendo só o trecho
// tocado e as âncoras de anotação (ADR-0007) não se movem sozinhas.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroMdEdit = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const WORD = /[\p{L}\p{N}_]/u;

  // ---- marcadores inline ----
  // `present` decide, a partir do número de marcadores colados em cada lado da
  // seleção, se ela já está formatada. Contar a sequência (em vez de comparar
  // texto) é o que faz itálico dentro de negrito não se confundir: `**x**` tem
  // duas estrelas de cada lado (par → não é itálico), `***x***` tem três
  // (ímpar → é itálico e sai uma estrela de cada lado).
  const INLINE = {
    bold: { mark: "**", present: (l, r) => l >= 2 && r >= 2 },
    italic: { mark: "*", present: (l, r) => l % 2 === 1 && r % 2 === 1 },
    strike: { mark: "~~", present: (l, r) => l >= 2 && r >= 2 },
    code: { mark: "`", present: (l, r) => l % 2 === 1 && r % 2 === 1 },
  };

  function runBefore(doc, pos, ch) {
    let n = 0;
    while (pos - n - 1 >= 0 && doc[pos - n - 1] === ch) n++;
    return n;
  }
  function runAfter(doc, pos, ch) {
    let n = 0;
    while (pos + n < doc.length && doc[pos + n] === ch) n++;
    return n;
  }

  function toggleInline(doc, from, to, kind) {
    const { mark, present } = INLINE[kind];
    const len = mark.length;
    const ch = mark[0];

    // cursor sem seleção: envolve a palavra sob ele, ou abre marcadores vazios
    if (from === to) {
      let a = from, b = to;
      while (a > 0 && WORD.test(doc[a - 1])) a--;
      while (b < doc.length && WORD.test(doc[b])) b++;
      if (a === b) {
        return {
          changes: [{ from, to, insert: mark + mark }],
          selection: { anchor: from + len, head: from + len },
        };
      }
      from = a; to = b;
    }

    const sel = doc.slice(from, to);

    // já formatada por fora: remove os marcadores vizinhos
    if (present(runBefore(doc, from, ch), runAfter(doc, to, ch))) {
      return {
        changes: [
          { from: from - len, to: from, insert: "" },
          { from: to, to: to + len, insert: "" },
        ],
        selection: { anchor: from - len, head: to - len },
      };
    }

    // a seleção engloba os marcadores: tira de dentro
    if (sel.length >= len * 2 && sel.startsWith(mark) && sel.endsWith(mark)) {
      const inner = sel.slice(len, sel.length - len);
      return {
        changes: [{ from, to, insert: inner }],
        selection: { anchor: from, head: from + inner.length },
      };
    }

    return {
      changes: [{ from, to, insert: mark + sel + mark }],
      selection: { anchor: from + len, head: from + len + sel.length },
    };
  }

  // ---- operações de linha (títulos, listas, citação) ----
  const lineStart = (doc, pos) => doc.lastIndexOf("\n", pos - 1) + 1;
  const lineEnd = (doc, pos) => {
    const i = doc.indexOf("\n", pos);
    return i < 0 ? doc.length : i;
  };

  const MARKERS = {
    task: /^(\s*)[-*+] \[[ xX]\] /,
    bullet: /^(\s*)[-*+] (?!\[[ xX]\] )/,
    ordered: /^(\s*)\d+\. /,
    quote: /^(\s*)> /,
    heading: /^(\s*)(#{1,6}) /,
  };

  const stripMarkers = (line) => {
    for (const re of Object.values(MARKERS)) {
      const m = re.exec(line);
      if (m) return m[1] + line.slice(m[0].length);
    }
    return line;
  };
  const indentOf = (line) => (/^\s*/.exec(line) || [""])[0];

  // Uma operação de bloco reescreve as linhas tocadas de uma vez: mantém o
  // histórico de undo em um passo só e dá uma seleção previsível (o bloco
  // transformado). Com o cursor sem seleção, ele acompanha o deslocamento da
  // própria linha em vez de virar seleção.
  function blockOp(doc, from, to, transform) {
    const bFrom = lineStart(doc, from);
    const bTo = lineEnd(doc, to);
    const lines = doc.slice(bFrom, bTo).split("\n");
    const out = transform(lines);
    const insert = out.join("\n");
    const collapsed = from === to;
    let selection;
    if (collapsed) {
      // desloca o cursor pelo que mudou no começo da sua própria linha
      const idx = doc.slice(bFrom, from).split("\n").length - 1;
      const delta = out[idx].length - lines[idx].length;
      const pos = Math.max(lineStart(doc, from), from + delta);
      selection = { anchor: pos, head: pos };
    } else {
      selection = { anchor: bFrom, head: bFrom + insert.length };
    }
    return { changes: [{ from: bFrom, to: bTo, insert }], selection };
  }

  const isBlank = (line) => line.trim() === "";

  function setHeading(doc, from, to, level) {
    const hashes = "#".repeat(level);
    return blockOp(doc, from, to, (lines) => {
      const body = lines.filter((l) => !isBlank(l));
      const allAtLevel = body.length > 0 && body.every((l) => {
        const m = MARKERS.heading.exec(l);
        return m && m[2].length === level;
      });
      return lines.map((l) => {
        if (isBlank(l) && lines.length > 1) return l;
        const bare = stripMarkers(l);
        if (allAtLevel) return bare;
        return indentOf(bare) + hashes + " " + bare.trimStart();
      });
    });
  }

  function toggleLinePrefix(doc, from, to, kind) {
    return blockOp(doc, from, to, (lines) => {
      const body = lines.filter((l) => !isBlank(l));
      const allMarked = body.length > 0 && body.every((l) => MARKERS[kind].test(l));
      let n = 0;
      return lines.map((l) => {
        if (isBlank(l) && lines.length > 1) return l;
        const bare = stripMarkers(l);
        if (allMarked) return bare;
        n++;
        const prefix = kind === "ordered" ? `${n}. `
          : kind === "task" ? "- [ ] "
          : kind === "quote" ? "> "
          : "- ";
        return indentOf(bare) + prefix + bare.trimStart();
      });
    });
  }

  // ---- link ----
  function insertLink(doc, from, to) {
    const sel = doc.slice(from, to);
    const insert = `[${sel}]()`;
    // com texto selecionado o que falta é o destino; sem texto, o rótulo
    const pos = sel ? from + insert.length - 1 : from + 1;
    return { changes: [{ from, to, insert }], selection: { anchor: pos, head: pos } };
  }

  // ---- blocos ----
  const TABLE = "|   |   |\n| --- | --- |\n|   |   |\n";

  function insertBlock(doc, from, to, kind) {
    if (kind === "codeblock") {
      const bFrom = lineStart(doc, from);
      const bTo = lineEnd(doc, to);
      const body = doc.slice(bFrom, bTo);
      const insert = "```\n" + body + "\n```";
      const inner = bFrom + 4;
      return {
        changes: [{ from: bFrom, to: bTo, insert }],
        selection: { anchor: inner, head: inner + body.length },
      };
    }
    // tabela/régua entram em linha própria, sem grudar no parágrafo anterior
    const pad = isBlank(doc.slice(lineStart(doc, from), from)) ? "" : "\n\n";
    const block = kind === "table" ? TABLE : "---\n";
    const insert = pad + block;
    const pos = from + pad.length + (kind === "table" ? 2 : block.length);
    return { changes: [{ from, to, insert }], selection: { anchor: pos, head: pos } };
  }

  // ---- barra: ações, na ordem e nos grupos em que aparecem ----
  // `label` é o glifo do botão; `title` é o tooltip (msgid pt-BR do i18n).
  const ACTIONS = [
    { action: "bold", label: "B", title: "negrito (⌘B)", group: 1 },
    { action: "italic", label: "I", title: "itálico (⌘I)", group: 1 },
    { action: "strike", label: "S", title: "riscado", group: 1 },
    { action: "h1", label: "H1", title: "título 1", group: 2 },
    { action: "h2", label: "H2", title: "título 2", group: 2 },
    { action: "h3", label: "H3", title: "título 3", group: 2 },
    { action: "bullet", label: "•", title: "lista", group: 3 },
    { action: "task", label: "☑", title: "checklist", group: 3 },
    { action: "ordered", label: "1.", title: "lista numerada", group: 3 },
    { action: "quote", label: "“", title: "citação", group: 4 },
    { action: "code", label: "</>", title: "código", group: 4 },
    { action: "link", label: "🔗", title: "link (⌘K)", group: 5 },
    { action: "table", label: "▦", title: "inserir tabela", group: 5 },
    { action: "codeblock", label: "{ }", title: "bloco de código", group: 5 },
    { action: "rule", label: "―", title: "linha separadora", group: 5 },
  ];

  // Atalhos tratados pelo host (o WKWebView aplicaria negrito nativo no
  // contenteditable do CM6 se ⌘B não fosse interceptado).
  const KEYS = { "Mod-b": "bold", "Mod-i": "italic", "Mod-k": "link" };

  function apply(doc, anchor, head, action) {
    doc = String(doc == null ? "" : doc);
    const from = Math.min(anchor, head);
    const to = Math.max(anchor, head);
    if (INLINE[action]) return toggleInline(doc, from, to, action);
    const h = /^h([1-6])$/.exec(action);
    if (h) return setHeading(doc, from, to, Number(h[1]));
    if (MARKERS[action] && action !== "heading") return toggleLinePrefix(doc, from, to, action);
    if (action === "link") return insertLink(doc, from, to);
    if (action === "table" || action === "codeblock" || action === "rule") {
      return insertBlock(doc, from, to, action);
    }
    return null;
  }

  return { apply, ACTIONS, KEYS };
});
