// Loro — the owner's tasks, read from a file an external agent writes
// (ADR-0041 §10). Isolated, testable module: window.LoroTarefas in the browser,
// require() under node --test. PURE and LANGUAGE-FREE, like agenda.js.
//
// BR-9: Loro never touches Google. The agent writes
//   <acervo>/.loro/agenda/tarefas.json
//   {"versao":1,"geradoEm":"<ISO with offset>","tarefas":[{"id","titulo",
//    "prazo":"YYYY-MM-DD"|null,"notas","status":"needsAction"|"completed",
//    "concluidaEm":"<ISO>"|null,"link":"<url>"|null}]}
// and consumes what Loro appends to tarefas-acoes.json (concluir / reabrir).
(function (root, factory) {
  const api = factory(root.LoroAgenda || (typeof require !== "undefined" ? require("./agenda.js") : null));
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroTarefas = api;
})(typeof window !== "undefined" ? window : globalThis, function (AG) {
  const STALE_MS = 120 * 60000;
  const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

  // A calendar date (no time, no zone): it is compared with the LOCAL day.
  function validDate(s) {
    const m = typeof s === "string" ? DATE.exec(s.trim()) : null;
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? s.trim() : null;
  }

  function parseTask(t) {
    if (!t || typeof t !== "object" || Array.isArray(t)) return null;
    if (typeof t.id !== "string" || !t.id.trim()) return null;
    const status = t.status === "completed" ? "completed" : t.status === "needsAction" ? "needsAction" : null;
    if (!status) return null;
    return {
      id: t.id,
      titulo: typeof t.titulo === "string" ? t.titulo.trim() : "",
      prazo: validDate(t.prazo),
      notas: typeof t.notas === "string" ? t.notas : "",
      status,
      concluidaEmMs: AG.parseInstant(t.concluidaEm),
      link: AG.safeUrl(t.link),
    };
  }

  // text → {status: "ok"|"stale"|"invalid"|"missing", geradoEmMs, tarefas}
  function parseTarefas(text, nowMs) {
    const none = (status) => ({ status, geradoEmMs: null, tarefas: [] });
    if (text == null || text === "") return none("missing");
    let j;
    try { j = JSON.parse(text); } catch (_) { return none("invalid"); }
    if (!j || typeof j !== "object" || Array.isArray(j) || j.versao !== 1 || !Array.isArray(j.tarefas)) return none("invalid");
    const geradoEmMs = AG.parseInstant(j.geradoEm);
    if (geradoEmMs == null) return none("invalid");
    const seen = new Set(), tarefas = [];
    for (const raw of j.tarefas) {
      const t = parseTask(raw);
      if (!t || seen.has(t.id)) continue;
      seen.add(t.id);
      tarefas.push(t);
    }
    return { status: Number(nowMs) - geradoEmMs > STALE_MS ? "stale" : "ok", geradoEmMs, tarefas };
  }

  // Pending actions Loro wrote and the agent has not reflected yet. An action
  // is dropped once the file shows its result, or the task left the file.
  // pending: [{id, acao}] → the ones still pending
  function reconcile(pending, tarefas) {
    return (pending || []).filter((p) => {
      const t = (tarefas || []).find((x) => x.id === p.id);
      if (!t) return false;
      if (p.acao === "concluir") return t.status !== "completed";
      if (p.acao === "reabrir") return t.status !== "needsAction";
      return false;
    });
  }

  // The status the screen shows: the file's, overridden by a pending action.
  function effective(t, pending) {
    const p = (pending || []).filter((x) => x.id === t.id).pop();
    if (!p) return { done: t.status === "completed", pendente: "" };
    return { done: p.acao === "concluir", pendente: p.acao };
  }

  // Groups: Atrasadas (prazo before today), Hoje, Próximas, Sem prazo, and
  // Concluídas. A task being completed stays where it was (shown «concluindo…»)
  // until the file reflects it; one being reopened comes back to its group.
  function group(tarefas, nowMs, pending) {
    const hoje = AG.dayKey(new Date(nowMs));
    const out = { atrasadas: [], hoje: [], proximas: [], semPrazo: [], concluidas: [] };
    for (const t of tarefas || []) {
      const st = effective(t, pending);
      if (t.status === "completed" && st.pendente !== "reabrir") { out.concluidas.push(t); continue; }
      if (!t.prazo) out.semPrazo.push(t);
      else if (t.prazo < hoje) out.atrasadas.push(t);
      else if (t.prazo === hoje) out.hoje.push(t);
      else out.proximas.push(t);
    }
    const byPrazo = (a, b) => (a.prazo < b.prazo ? -1 : a.prazo > b.prazo ? 1 : a.titulo.localeCompare(b.titulo));
    out.atrasadas.sort(byPrazo); out.hoje.sort(byPrazo); out.proximas.sort(byPrazo);
    out.semPrazo.sort((a, b) => a.titulo.localeCompare(b.titulo));
    out.concluidas.sort((a, b) => (b.concluidaEmMs || 0) - (a.concluidaEmMs || 0));
    return out;
  }

  // The tab's badge: what is overdue or due today and not done (nor being done).
  function badgeCount(tarefas, nowMs, pending) {
    const g = group(tarefas, nowMs, pending);
    return g.atrasadas.concat(g.hoje).filter((t) => !effective(t, pending).done).length;
  }

  // Notes as plain text with http(s) links: [{text} | {url}]. The caller renders
  // text with textContent (line breaks kept by CSS) and urls as buttons that
  // open in the browser — never as HTML.
  function linkify(notas) {
    const out = [];
    const re = /https?:\/\/[^\s<>"']+/gi;
    const s = String(notas || "");
    let last = 0, m;
    while ((m = re.exec(s))) {
      let url = m[0].replace(/[.,;:!?)\]]+$/, "");
      if (m.index > last) out.push({ text: s.slice(last, m.index) });
      if (AG.safeUrl(url)) out.push({ url }); else out.push({ text: url });
      last = m.index + url.length;
      re.lastIndex = last;
    }
    if (last < s.length) out.push({ text: s.slice(last) });
    return out;
  }

  return { STALE_MS, validDate, parseTarefas, reconcile, effective, group, badgeCount, linkify };
});
