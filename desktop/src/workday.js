// Loro — the recorded workday's decision (ADR-0038 §2). Isolated, testable
// module: loaded in the browser via <script> (defines window.LoroWorkday) and in
// Node via require() for node --test.
//
// Same two contracts as loops.js:
// 1. PURE — it takes `nowFields(new Date())` (loops.js), the config and the
//    controller's state, and returns a NEW plain decision. No DOM, no IPC.
// 2. LANGUAGE-FREE — it returns enums (`acao`). The one string it builds is the
//    meeting TITLE, which is data with a format fixed by ADR-0038 §1
//    (`Dia AAAA-MM-DD HH:00`), not UI copy: the external agent reads it.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroWorkday = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const p2 = (n) => String(n).padStart(2, "0");
  const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

  // "HH:MM" → minutes since midnight. "24:00" is accepted as the end of the day
  // (a window that runs to midnight); anything else unreadable is null — the
  // window is then off, never guessed.
  function parseClock(s) {
    const m = /^(\d{2}):(\d{2})$/.exec(String(s == null ? "" : s).trim());
    if (!m) return null;
    const hh = Number(m[1]), mi = Number(m[2]);
    if (hh === 24 && mi === 0) return 1440;
    if (hh > 23 || mi > 59) return null;
    return hh * 60 + mi;
  }

  // The hour a recording belongs to, as a key that orders as text: date AND
  // hour, because "10h" yesterday and "10h" today are different hours.
  function hourKey(agora) {
    return `${agora.date} ${p2(agora.hh)}`;
  }

  // The key of the NEXT whole hour, through the platform's calendar so midnight,
  // month and year turns come out right.
  function nextHourKey(agora) {
    const d = new Date(Number(agora.epochMs) || 0);
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}`;
  }

  function titleOf(agora) {
    return `Dia ${agora.date} ${p2(agora.hh)}:00`;
  }

  function inWindow(agora, cfg) {
    if (!cfg || cfg.ligado !== true) return false;
    const ini = parseClock(cfg.inicio), fim = parseClock(cfg.fim);
    if (ini == null || fim == null || ini >= fim) return false;
    const dias = Array.isArray(cfg.dias) ? cfg.dias : ALL_DAYS;
    if (!dias.includes(agora.weekday)) return false;
    const now = agora.hh * 60 + agora.mi;
    return now >= ini && now < fim;
  }

  // { agora, cfg {ligado, inicio, fim, dias}, estado {gravandoDia,
  // horaDaGravacao, suspensoAteHora, gravandoManual} } →
  // { acao: "iniciar"|"rotacionar"|"encerrar"|"nada", titulo?, hora? }
  function decide(input) {
    const agora = (input && input.agora) || {};
    const cfg = (input && input.cfg) || null;
    const estado = (input && input.estado) || {};
    const open = inWindow(agora, cfg);

    if (estado.gravandoDia) {
      if (!open) return { acao: "encerrar" };
      const hora = hourKey(agora);
      if (estado.horaDaGravacao === hora) return { acao: "nada" };
      return { acao: "rotacionar", titulo: titleOf(agora), hora };
    }
    // A manual recording belongs to the person: the day waits for it to end and
    // starts on the next check (ADR-0038 §1).
    if (!open || estado.gravandoManual) return { acao: "nada" };
    const hora = hourKey(agora);
    if (estado.suspensoAteHora && hora < estado.suspensoAteHora) return { acao: "nada" };
    return { acao: "iniciar", titulo: titleOf(agora), hora };
  }

  return { decide, parseClock, hourKey, nextHourKey, titleOf, inWindow };
});
