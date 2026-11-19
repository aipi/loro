// Loro — the day's agenda and the recording scheduler (ADR-0041 §4). Isolated,
// testable module: loaded in the browser via <script> (defines
// window.LoroAgenda) and in Node via require() for node --test.
//
// Same two contracts as loops.js:
// 1. PURE — it takes the file's TEXT, a clock (`nowMs`) and the executor's
//    state, and returns NEW plain values. No DOM, no IPC.
// 2. LANGUAGE-FREE — it returns enums (`status`, `acao`); the UI translates.
//
// The file is written by an EXTERNAL agent (BR-9: Loro never holds a calendar
// credential), into the active acervo, one per day:
//   .loro/agenda/<YYYY-MM-DD>.json
//   {"versao":1,"geradoEm":"<ISO-8601 with offset>","eventos":[{"id","titulo",
//    "inicio","fim","comConvidados"}]}
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroAgenda = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const MIN = 60000;
  const STALE_MS = 120 * MIN;   // older than this: «agenda não atualizada»
  const END_WARN_MS = 2 * MIN;  // «termina em 2 min — estender?»
  const EXTEND_MS = 15 * MIN;   // one «+15 min»
  const SUGGEST_MS = 10 * MIN;  // how long «Gravar <título>?» stays relevant

  const p2 = (n) => String(n).padStart(2, "0");

  // The LOCAL day — the file is named by the day the person lives in.
  function dayKey(d) {
    const x = d instanceof Date ? d : new Date(Number(d) || 0);
    return `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())}`;
  }

  // ISO-8601 WITH an offset (Z or ±HH:MM). Without one the instant depends on
  // the machine's timezone — refused, never guessed.
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
  function parseInstant(s) {
    if (typeof s !== "string" || !ISO.test(s)) return null;
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? ms : null;
  }

  function parseEvent(e) {
    if (!e || typeof e !== "object" || Array.isArray(e)) return null;
    if (typeof e.id !== "string" || !e.id.trim()) return null;
    const inicioMs = parseInstant(e.inicio), fimMs = parseInstant(e.fim);
    if (inicioMs == null || fimMs == null || fimMs <= inicioMs) return null;
    return {
      id: e.id,
      titulo: typeof e.titulo === "string" ? e.titulo.trim() : "",
      inicioMs, fimMs,
      comConvidados: e.comConvidados === true,
    };
  }

  // text → { status: "ok"|"stale"|"invalid"|"missing", geradoEmMs, eventos }.
  // A bad EVENT is dropped alone; a bad FILE yields no events at all.
  function parseAgenda(text, nowMs) {
    const none = (status) => ({ status, geradoEmMs: null, eventos: [] });
    if (text == null || text === "") return none("missing");
    let j;
    try { j = JSON.parse(text); } catch (_) { return none("invalid"); }
    if (!j || typeof j !== "object" || Array.isArray(j)) return none("invalid");
    if (j.versao !== 1 || !Array.isArray(j.eventos)) return none("invalid");
    const geradoEmMs = parseInstant(j.geradoEm);
    if (geradoEmMs == null) return none("invalid");
    const seen = new Set();
    const eventos = [];
    for (const raw of j.eventos) {
      const e = parseEvent(raw);
      if (!e || seen.has(e.id)) continue;
      seen.add(e.id);
      eventos.push(e);
    }
    eventos.sort((a, b) => a.inicioMs - b.inicioMs || (a.id < b.id ? -1 : 1));
    // Stale is a NOTE, not a refusal: the events of a file written at 7:00 are
    // still the person's meetings at 10:00; only a change made after it is missed.
    const status = Number(nowMs) - geradoEmMs > STALE_MS ? "stale" : "ok";
    return { status, geradoEmMs, eventos };
  }

  function upcoming(eventos, nowMs) {
    return (eventos || []).filter((e) => e.fimMs > nowMs);
  }

  function pruneSchedule(s, today) {
    const out = { versao: 1, eventos: {} };
    const src = (s && s.eventos) || {};
    for (const id of Object.keys(src)) {
      const e = src[id];
      if (e && (!e.data || e.data >= today)) out.eventos[id] = e;
    }
    return out;
  }

  // { nowMs, eventos, agendadas {id: {tema}}, estado {rec, atual, tratados,
  //   avisoFimDado, ultimoTema} } →
  // { acao: "nada"|"iniciar"|"encerrar"|"trocar"|"avisar-fim"|"perguntar-troca"|"sugerir",
  //   evento?, tema?, minutos? }
  //
  // `rec`: "idle" | "recording" | "paused" | "busy" (starting or stopping).
  // `atual`: what is recording — {tipo:"manual"} or {tipo:"agendada", eventId,
  //   fimMs (as it was at start), extraMs (the «+15 min» taken)}.
  // `tratados`: event ids already started, prompted, suggested or declined —
  //   none of them is acted on again.
  function decide(input) {
    const now = Number(input && input.nowMs) || 0;
    const eventos = (input && input.eventos) || [];
    const agendadas = (input && input.agendadas) || {};
    const estado = (input && input.estado) || {};
    const rec = estado.rec || "idle";
    const tratados = new Set(estado.tratados || []);
    const nada = { acao: "nada" };
    if (rec === "busy") return nada;

    const live = (e) => e.inicioMs <= now && now < e.fimMs;
    const temaOf = (e) => (agendadas[e.id] && agendadas[e.id].tema) || estado.ultimoTema || null;
    // Due = scheduled, under way, not yet handled. Of several, the one that
    // began LAST: it is the meeting the person is walking into now.
    const due = eventos
      .filter((e) => Object.prototype.hasOwnProperty.call(agendadas, e.id) && live(e) && !tratados.has(e.id))
      .sort((a, b) => b.inicioMs - a.inicioMs)[0] || null;

    const atual = estado.atual || null;
    if (rec !== "idle" && atual && atual.tipo === "agendada") {
      const ev = eventos.find((e) => e.id === atual.eventId);
      // the end follows the FILE (the agent may move it); gone from the file,
      // the end saved at start stands
      const fim = (ev ? ev.fimMs : Number(atual.fimMs) || 0) + (Number(atual.extraMs) || 0);
      if (now >= fim) {
        if (due && due.id !== atual.eventId) return { acao: "trocar", evento: due, tema: temaOf(due) };
        return { acao: "encerrar" };
      }
      if (due && due.id !== atual.eventId) return { acao: "perguntar-troca", evento: due };
      if (now >= fim - END_WARN_MS && !estado.avisoFimDado) {
        return { acao: "avisar-fim", evento: ev || null, minutos: Math.max(1, Math.ceil((fim - now) / MIN)) };
      }
      return nada;
    }
    if (rec !== "idle") {
      // the person's own recording is never cut: the bubble asks
      return due ? { acao: "perguntar-troca", evento: due } : nada;
    }
    if (due) return { acao: "iniciar", evento: due, tema: temaOf(due) };
    // Not scheduled but with guests, just started: OFFER, never start.
    const sug = eventos.find((e) => e.comConvidados && live(e) && now < e.inicioMs + SUGGEST_MS
      && !tratados.has(e.id) && !Object.prototype.hasOwnProperty.call(agendadas, e.id));
    if (sug) return { acao: "sugerir", evento: sug };
    return nada;
  }

  return {
    STALE_MS, END_WARN_MS, EXTEND_MS, SUGGEST_MS,
    dayKey, parseInstant, parseAgenda, upcoming, pruneSchedule, decide,
  };
});
