// Loro — pure, dependency-free helpers for the meeting workspace (ADR-0010).
// Isolated/testable module: loaded in the browser via <script> (defines
// window.LoroMeeting) and in Node via require() for `node --test`. No DOM, no
// Tauri — every function is a pure string transform so the meeting lifecycle
// wiring in app.js stays thin and the parsing/joining logic is unit-covered.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroMeeting = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  // A meeting home is brainstorming/<slug>/reunioes/<id>/ (ADR-0013) where <id>
  // is [a-z0-9-] (validated in meeting.rs); the legacy pessoal/temas/<slug>/…
  // home is still recognized for un-migrated acervos. The living notebook is
  // reuniao.md, under the gitignore quarantine (never versioned); ADR-0018
  // removed the built report, so the meeting's output is its notas/.
  const HOME = "(?:brainstorming\\/[^/]+|pessoal\\/temas\\/[^/]+)\\/reunioes";
  const LIVING_RE = new RegExp("^" + HOME + "\\/([a-z0-9-]+)\\/reuniao\\.md$");
  const DIR_RE = new RegExp("^(" + HOME + "\\/[a-z0-9-]+)\\/reuniao\\.md$");

  // The stable append marker meeting.rs writes into the living file; the reader
  // must strip it so the transcript surface never shows the raw comment.
  const MARKER = "<!-- loro:transcricao -->";

  function livingId(rel) {
    const m = LIVING_RE.exec(String(rel == null ? "" : rel));
    return m ? m[1] : null;
  }
  function isLiving(rel) { return livingId(rel) != null; }

  // Derive the acervo-relative meeting directory from the living transcript path.
  // ADR-0018 removed the report, so `reuniao.md` is the only door. The
  // meeting AI skills (ADR-0012) take this dir as $ARGUMENTS, and the embedded
  // terminal runs with the acervo root as cwd, so acervo-relative is exactly
  // what the slash command needs.
  function meetingDir(rel) {
    const m = DIR_RE.exec(String(rel == null ? "" : rel));
    return m ? m[1] : null;
  }

  // Collapse a free-text argument into a single PTY line: the terminal submits
  // on newline, so any CR/LF/tab would run the command early. We flatten every
  // whitespace run (\s covers \r \n \t) to one space and trim. Only the user's
  // typed question is passed here — never transcript text (BR-8).
  function sanitizeSkillArg(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  }

  // Build the exact slash-command string the app injects into the terminal
  // Claude (ADR-0012): analyse -> "/loro-analyse <dir>"; question ->
  // "/loro-question <dir> <question>". Command names use hyphens (a dot is not a
  // valid Claude Code command name); they must match the files materialised by
  // templates.rs (.claude/commands/loro-analyse.md, loro-question.md). Returns
  // null when the dir is missing, or (for question) when the question is empty
  // after sanitising, so the caller declines to inject.
  function meetingSkillCmd(kind, dir, question) {
    const d = sanitizeSkillArg(dir);
    if (!d) return null;
    if (kind === "question") {
      const q = sanitizeSkillArg(question);
      if (!q) return null;
      return "/loro-question " + d + " " + q;
    }
    return "/loro-analyse " + d;
  }

  function stripMarker(text) {
    // Drop the transcript marker AND the hidden per-segment sort-key comments
    // (`<!-- loro:t=NNN -->`, ADR-0013) so neither shows in the rendered surface
    // (text.js escapes HTML, so a comment would otherwise render as literal text).
    return String(text == null ? "" : text)
      .split(MARKER).join("")
      .replace(/^[ \t]*<!--\s*loro:t=\d+\s*-->[ \t]*\r?\n?/gm, "");
  }

  // A human label for a meeting in the tree. Prefer the manifest `titulo`; fall
  // back to the meeting id (folder name) so a meeting NEVER shows as a stale
  // "nova reunião" default. `id` is the last path segment of the meeting dir.
  function meetingTitleFromManifest(manifest, id) {
    const t = manifest && typeof manifest.titulo === "string" ? manifest.titulo.trim() : "";
    // Data comparison, not UI copy: manifests written under either UI language
    // may carry a stale default title, so both pt and en defaults are rejected.
    const STALE = ["reunião", "nova reunião", "meeting", "new meeting"];
    if (t && STALE.indexOf(t.toLowerCase()) === -1) return t;
    return String(id == null ? "" : id);
  }
  // Label from a meeting id like "2026-07-27-1430-semanal-de-custos": strip the
  // AAAA-MM-DD-HHMM stamp and humanize the slug tail ("semanal de custos"). An
  // untitled meeting carries the generic "reuniao" tail, which identifies
  // nothing in the sidebar — label it by its date/time instead ("reunião 27/07
  // 14:30"). Falls back to the raw id when it does not match the stamped shape.
  // `lang` ("pt" default | "en") localizes only the generated "reunião"/"meeting"
  // prefix; a titled slug is data and is never translated.
  function meetingLabel(id, lang) {
    const s = String(id == null ? "" : id);
    const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})-(.+)$/.exec(s);
    if (!m) return s;
    const tail = m[6].replace(/-/g, " ").trim();
    if (!tail || tail === "reuniao" || tail === "nova reuniao") {
      const word = lang === "en" ? "meeting" : "reunião";
      return word + " " + m[3] + "/" + m[2] + " " + m[4] + ":" + m[5];
    }
    return tail;
  }

  // Join the acervo base with an acervo-relative path using a single separator.
  // brain_meeting_stop returns completoRel as an acervo-relative path, but the
  // existing transcription takes a filesystem path, so the frontend resolves it
  // against the acervo base here (ADR-0010: stop returns a rel, does not
  // transcribe).
  function acervoJoin(base, rel) {
    const b = String(base == null ? "" : base).replace(/\/+$/, "");
    const r = String(rel == null ? "" : rel).replace(/^\/+/, "");
    return b ? b + "/" + r : r;
  }

  // Format the ai_doctor posture into one honest status line for the análise
  // rail (ADR-0011). Booleans only — never a secret or a token (BR-9); in v1
  // embeddings/MCP/análise are deferred, so this reports "—" for them and the
  // caller keeps the analisar button disabled. Pure so it is node-tested.
  // `lang` ("pt" default | "en") localizes the copy directly — pure modules
  // cannot reach the window-level i18n dictionary.
  const AI_STATUS_COPY = {
    pt: { ready: "pronto", unavailable: "indisponível", available: "disponível", cloud: "nuvem" },
    en: { ready: "ready", unavailable: "unavailable", available: "available", cloud: "cloud" },
  };
  function aiStatusLine(d, lang) {
    d = d || {};
    const t = AI_STATUS_COPY[lang === "en" ? "en" : "pt"];
    const local = d.localModelReady
      ? t.ready + (d.localModelName ? " (" + d.localModelName + ")" : "")
      : t.unavailable;
    const nuvem = d.cloudAvailable ? t.available : "—";
    const mcp = d.mcpAvailable ? t.available : "—";
    return "local: " + local + " · " + t.cloud + ": " + nuvem + " · MCP: " + mcp;
  }

  // Whisper hallucinates caption-credit / non-speech artifacts on SILENCE (e.g.
  // "Legenda por Sônia Ruberti", "Legendas pela comunidade Amara.org", a lone
  // "[Música]" or "♪"). Drop those high-confidence non-speech lines so silence
  // never pollutes the transcript. Conservative — only well-known patterns, so
  // real speech is never removed.
  const HALLUCINATION = [
    /\blegendas?\b.*\b(por|pela|pelo|amara|comunidade)\b/i,
    /\bamara\.org\b/i,
    /\bsubtitl(es|ed)\b.*\bby\b/i,
    /^[\s\-–—♪♫🎵*·.]*$/, // símbolo/pontuação/branco apenas
    /^\s*[[(]?\s*(m[úu]sica|music|aplausos|applause|risos|laughter|sil[êe]ncio|silence)\s*[\])]?\s*$/i,
  ];
  function isHallucination(line) {
    const t = (line || "").trim();
    if (!t) return true;
    return HALLUCINATION.some(function (re) { return re.test(t); });
  }
  // Drop hallucinated lines from a (possibly multi-line) transcript chunk;
  // returns "" when everything was non-speech (caller then shows "só silêncio").
  function filterHallucinations(text) {
    return String(text == null ? "" : text)
      .split(/\r?\n/)
      .filter(function (l) { return !isHallucination(l); })
      .join("\n")
      .trim();
  }

  // ---- eco entre trilhas (mic × sistema) ------------------------------------
  // A reunião tem DUAS captações independentes: o microfone (você) e o áudio do
  // sistema (os outros). Quando o som sai por alto-falante, o microfone escuta
  // de novo o que o sistema já gravou, e a MESMA fala é transcrita duas vezes —
  // uma vez por trilha, com timecodes quase iguais e texto quase igual (o
  // whisper nunca transcreve os dois sinais idêntico).
  //
  // Não dá para resolver isso comparando texto exato. Comparamos CONJUNTOS de
  // palavras normalizadas e exigimos contenção alta: o trecho novo é eco quando
  // quase tudo o que ele diz já foi dito pela OUTRA trilha, por perto no tempo.
  function speechTokens(text) {
    return String(text == null ? "" : text)
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")   // sem acento: "tô"/"to"
      .replace(/[^a-z0-9\s]/g, " ")                        // sem pontuação
      .split(/\s+/)
      .filter(Boolean);
  }
  // Cobertura MÚTUA (0..1): o menor dos dois lados de "quanto de um está no
  // outro". Medir só o menor conjunto contra o maior era um erro grave e da
  // direção pior possível: um segmento curto de microfone ("eu acho que a gente
  // pode fechar isso com o time") tem quase todas as suas palavras funcionais
  // presentes numa janela de 18s de outro assunto — 0,91 de contenção — e a
  // JANELA INTEIRA, com a fala de todo mundo, era descartada. Sob a ADR-0018 a
  // transcrição ao vivo é a única saída da reunião e o áudio é purgado depois:
  // o trecho some para sempre.
  //
  // Eco de verdade é simétrico — as duas trilhas ouviram a mesma coisa, então os
  // dois conjuntos se cobrem. Tamanhos muito diferentes reprovam por construção,
  // que é exatamente o caso "não são a mesma fala".
  function tokenContainment(a, b) {
    const A = new Set(a), B = new Set(b);
    if (!A.size || !B.size) return 0;
    let hits = 0;
    A.forEach(function (w) { if (B.has(w)) hits++; });
    return Math.min(hits / A.size, hits / B.size);
  }
  // Piso de tamanho: "tá bom", "sim, claro" repetem naturalmente numa conversa —
  // descartar trechos curtos por semelhança apagaria fala legítima. Só trechos
  // com substância entram no teste.
  const ECHO_MIN_TOKENS = 8;
  const ECHO_MIN_CONTAINMENT = 0.7;
  // A janela de sistema é appendada com o tMs do INÍCIO dela, então o par pode
  // ficar afastado por até uma janela inteira — a folga é isso, não chute.
  const ECHO_WINDOW_MS = 20000;
  // `recent` são os trechos já appendados: {tMs, source, tokens}. Devolve o que
  // casou (para o log) ou null. Só compara com a trilha OPOSTA: a mesma trilha
  // repetindo é fala repetida de verdade, não eco.
  function echoOfOtherSource(chunk, recent) {
    const c = chunk || {};
    const mine = speechTokens(c.text);
    if (mine.length < ECHO_MIN_TOKENS) return null;
    const list = Array.isArray(recent) ? recent : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const prev = list[i];
      if (!prev || prev.source === c.source) continue;
      if (Math.abs((prev.tMs || 0) - (c.tMs || 0)) > ECHO_WINDOW_MS) continue;
      if (tokenContainment(mine, prev.tokens || []) >= ECHO_MIN_CONTAINMENT) return prev;
    }
    return null;
  }

  // O que fazer com o buffer da transcrição AVULSA quando uma sessão termina.
  // Uma reunião tem a própria superfície (a aba reuniao.md, ADR-0010): o rodapé
  // avulso não participa dela, nem para salvar nem para aparecer. Decisão pura
  // porque os dois pontos de término (onStopped e o fim de transcribe-state)
  // precisam responder igual — era a divergência entre eles que deixava o
  // rodapé subir por cima de uma reunião.
  //   "none"     → não mexe no rodapé
  //   "autosave" → salva sozinho na pasta configurada
  //   "offer"    → mostra a barra salvar/descartar e abre o painel
  function looseEndAction(o) {
    const d = o || {};
    if (d.meetingActive) return "none";
    if (!(Number(d.lineCount) > 0)) return "none";
    return d.autosave ? "autosave" : "offer";
  }

  // #44 — destinos possíveis para MOVER uma reunião. Uma reunião só existe em
  // `<brainstorming>/reunioes/` (é o caminho que o list_meetings varre), então o
  // destino é sempre outro brainstorming — nunca avulso, notas ou anexos, que
  // guardam arquivos soltos. O brainstorming atual sai da lista.
  function meetingMoveTargets(temas, slugAtual) {
    return (Array.isArray(temas) ? temas : [])
      .filter(function (b) { return b && b.slug && b.slug !== slugAtual; })
      .map(function (b) { return { slug: b.slug, label: b.nome || b.slug }; });
  }

  // O alvo de arrastar-e-soltar: devolve o slug de destino quando a chave do
  // grupo é o cabeçalho `reuniões` de OUTRO brainstorming, e null em qualquer
  // outro caso (notas, anexos, avulso, o próprio brainstorming).
  function meetingDropTarget(groupKey, slugAtual) {
    var m = /^bsfolder:(.+):reunioes$/.exec(String(groupKey == null ? "" : groupKey));
    if (!m) return null;
    return m[1] && m[1] !== slugAtual ? m[1] : null;
  }

  // ADR-0018 · AC-5 — o fim de uma gravação SUGERE a análise, nunca a executa.
  // O desfecho da oferta é decidido aqui, puro: só o clique em "analisar" produz
  // um comando; dispensar devolve null e a reunião fica intocada.
  function analyseOffer(escolha, dir) {
    if (escolha !== "analisar" || !dir) return null;
    return meetingSkillCmd("analyse", dir);
  }

  // ADR-0018 · AC-7 — a análise É a saída da reunião, então uma reunião sem nada
  // em `notas/` não tem o que enfileirar. Devolve o motivo (msgid) quando o envio
  // deve ficar bloqueado, e null quando pode ir. Puro.
  function meetingQueueBlock(notas) {
    return Number(notas) > 0 ? null : "analise a reunião antes de enviar para a fila";
  }

  return {
    meetingMoveTargets, meetingDropTarget,
    looseEndAction, analyseOffer, meetingQueueBlock,
    livingId, isLiving, meetingDir,
    sanitizeSkillArg, meetingSkillCmd,
    stripMarker, acervoJoin, aiStatusLine, MARKER,
    isHallucination, filterHallucinations,
    speechTokens, tokenContainment, echoOfOtherSource,
    meetingTitleFromManifest, meetingLabel,
  };
});
