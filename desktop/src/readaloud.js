// Loro — modo de leitura em voz alta (ADR-0037). Lógica PURA: markdown -> prosa
// falável. O que fala é o `say` pelo backend; o que decide O QUE se fala está
// aqui, testável sem navegador (mesmo padrão UMD do interpreter.js).
//
// POR QUE EXTRAIR, e não mandar o markdown cru: ouvir o cru é ouvir
// "cerquilha cerquilha Título", "asterisco asterisco negrito" e URLs inteiras
// lidas caractere por caractere. Para acessibilidade isso não é uma versão pior
// do texto — é inutilizável. A extração é a feature, não um detalhe dela.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroReadAloud = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  // Um bloco de código é ANUNCIADO e pulado. Ler código em voz alta produz
  // "abre-chaves let espaço x igual" — ninguém acompanha, e quem quer o código
  // vai lê-lo com os olhos. O anúncio existe para a pessoa saber que havia algo
  // ali: pular em silêncio esconde conteúdo.
  const SAY_CODE = "bloco de código.";
  const SAY_TABLE = "tabela:";
  const SAY_IMAGE = "imagem:";

  // Uma linha de separação de tabela: |---|:--:|---|
  const TABLE_SEP = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

  function inline(s) {
    return (
      s
        // Imagem antes de link: a sintaxe dela CONTÉM a de link, e na outra
        // ordem o "!" sobra solto na frase.
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => (alt ? `${SAY_IMAGE} ${alt}` : ""))
        // Link pelo TEXTO, nunca pela URL. É a regra que mais muda a
        // experiência: uma URL falada é dezenas de segundos de ruído.
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        // Link de referência e link automático
        .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
        .replace(/<(https?:\/\/[^>]+)>/g, "")
        // Código em linha: fica o conteúdo, sem o crase. `err.foo` no meio de
        // uma frase é informação; a crase não é.
        .replace(/`([^`]+)`/g, "$1")
        // Ênfase, em qualquer forma
        .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")
        .replace(/~~([^~]+)~~/g, "$1")
        .replace(/(^|\s)_([^_]+)_(?=\s|$|[.,;:!?])/g, "$1$2")
        // Marcação HTML solta no meio do markdown
        .replace(/<\/?[a-zA-Z][^>]*>/g, "")
        .replace(/\s{2,}/g, " ")
        .trim()
    );
  }

  // Uma linha de tabela vira os valores separados por vírgula: "a, b, c". Ler os
  // pipes seria ruído, e PULAR a tabela esconderia dados — que num documento de
  // conhecimento costumam ser o conteúdo principal.
  function tableRow(line) {
    return line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => inline(c.trim()))
      .filter(Boolean)
      .join(", ");
  }

  // Markdown -> parágrafos falávies, em ordem. Devolve uma LISTA porque a
  // unidade de navegação (e de pausa entre trechos) é o parágrafo, não o
  // arquivo.
  function toSpeech(md) {
    const src = String(md == null ? "" : md).replace(/\r\n?/g, "\n");
    const lines = src.split("\n");
    let i = 0;

    // Front matter: metadados, não prosa. Só conta se abrir na PRIMEIRA linha —
    // um "---" no meio do texto é régua horizontal.
    if (lines[0] !== undefined && lines[0].trim() === "---") {
      let j = 1;
      while (j < lines.length && lines[j].trim() !== "---") j++;
      if (j < lines.length) i = j + 1;
    }

    const out = [];
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      const s = inline(buf.join(" "));
      if (s) out.push(s);
      buf = [];
    };

    for (; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trim();

      // Bloco de código cercado: anuncia e pula até fechar.
      const fence = line.match(/^(`{3,}|~{3,})/);
      if (fence) {
        flush();
        const close = fence[1][0].repeat(3);
        let j = i + 1;
        while (j < lines.length && !lines[j].trim().startsWith(close)) j++;
        i = j;
        out.push(SAY_CODE);
        continue;
      }
      // Comentário HTML: some por inteiro, inclusive multilinha.
      if (line.startsWith("<!--")) {
        flush();
        let j = i;
        while (j < lines.length && !lines[j].includes("-->")) j++;
        i = j;
        continue;
      }
      if (!line) {
        flush();
        continue;
      }
      // Régua horizontal não se fala.
      if (/^([-*_])\s*(\1\s*){2,}$/.test(line)) {
        flush();
        continue;
      }
      // Separador de tabela: estrutura, não conteúdo.
      if (TABLE_SEP.test(line) && line.includes("-")) {
        continue;
      }
      // Linha de tabela.
      if (line.startsWith("|") && line.includes("|", 1)) {
        flush();
        const cells = tableRow(line);
        if (cells) out.push(cells);
        continue;
      }
      // Título: vira frase própria, com ponto, para o `say` fazer a pausa que a
      // hierarquia visual faria com o olho.
      const h = line.match(/^#{1,6}\s+(.*)$/);
      if (h) {
        flush();
        const s = inline(h[1]);
        if (s) out.push(/[.!?:]$/.test(s) ? s : s + ".");
        continue;
      }
      // Item de lista e citação: perde a marca, mantém o texto e vira um
      // parágrafo próprio (é assim que se navega item a item).
      const li = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
      if (li) {
        flush();
        const s = inline(li[1]);
        if (s) out.push(/[.!?:]$/.test(s) ? s : s + ".");
        continue;
      }
      const bq = line.match(/^>\s?(.*)$/);
      if (bq) {
        // A citação continua no buffer: um bloco de citação é um parágrafo.
        buf.push(bq[1]);
        continue;
      }
      buf.push(line);
    }
    flush();
    return out;
  }

  // O texto que o `say` recebe: os parágrafos com linha em branco entre eles, que
  // é o que faz o sintetizador respirar. Um bloco só, porque o `say` já lê
  // arquivo inteiro e cortar em N chamadas introduziria silêncio artificial.
  function toSpeechText(md) {
    return toSpeech(md).join("\n\n");
  }

  // O QUE ler: a seleção quando existe, o arquivo todo quando não. Reler um
  // parágrafo é o caso comum de quem usa leitura em voz alta, e é a seleção que
  // expressa isso.
  function pickSource(selection, whole) {
    const sel = String(selection == null ? "" : selection).trim();
    return sel ? { text: sel, scope: "selection" } : { text: String(whole == null ? "" : whole), scope: "file" };
  }

  // O estado do controle, para a tela dizer a verdade. Derivado do backend —
  // nunca guardado em paralelo, que é como uma tela passa a mentir.
  function label(state) {
    if (!state || !state.speaking) return "ler em voz alta";
    return state.paused ? "retomar a leitura" : "pausar a leitura";
  }

  return { toSpeech, toSpeechText, pickSource, label, SAY_CODE, SAY_TABLE, SAY_IMAGE };
});
