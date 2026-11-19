// Loro — the recording bubble window (ADR-0041). A REMOTE: the main window
// (app.js) owns the meeting and the scheduler; this window only paints the
// `bubble-state` it receives and sends `bubble-cmd` back. Its mini chat runs the
// acervo's agent on its OWN channel (`chat_send {channel: "bubble"}`). Decisions
// that can be pure live in bubble-core.js and agenda.js.
const TAURI = window.__TAURI__;
const { listen, emit } = TAURI.event;
const invoke = TAURI.core.invoke;
const BC = window.LoroBubble;
const LAG = window.LoroAgenda;
const I18N = window.LoroI18n;
const t = (s, args) => (I18N ? I18N.t(s, args) : s);
const $ = (id) => document.getElementById(id);

let st = { rec: "idle", temas: [], linhas: [], agenda: { status: "missing", eventos: [] }, chatCtx: [] };
let open = false;
let lastPromptKey = "";
let tab = "rec";
let openEv = "";          // the agenda row whose details are open
const temaEv = {};        // per-event destination picked in its row
let iconPx = 32;
const BASE_PANEL_H = 520; // bubble.rs EXPANDED

function send(cmd, extra) {
  return emit("bubble-cmd", Object.assign({ cmd }, extra || {}));
}

// ---- language: the main window says which -------------------------------------
let lang = "";
function applyLang(l) {
  if (!I18N || !l || l === lang) return;
  lang = l;
  I18N.setLang(l);
  for (const el of document.querySelectorAll("[data-i18n]")) {
    if (!el.dataset.msgid) el.dataset.msgid = el.textContent.trim();
    el.textContent = t(el.dataset.msgid);
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
}

// ---- size: 32 (padrão) / 48 / 64 pt, from the person's setting ------------------
function applySize(px) {
  iconPx = [32, 48, 64].includes(Number(px)) ? Number(px) : 32;
  const root = document.documentElement.style;
  root.setProperty("--icon", iconPx + "px");
  root.setProperty("--badge", BC.badgePx(iconPx) + "px");
}
invoke("bubble_get_size").then(applySize, () => applySize(32));
listen("bubble-size", (e) => applySize(e && e.payload));

// ---- open / close ----------------------------------------------------------------
let closeTimer = null;
async function setOpen(next) {
  if (next === open) return;
  open = next;
  $("icon").setAttribute("aria-expanded", String(open));
  if (open) {
    clearTimeout(closeTimer);
    let anchor = { right: false, bottom: false };
    try { anchor = (await invoke("bubble_expand", { expanded: true })) || anchor; } catch (_) {}
    document.body.classList.toggle("anchor-right", !!anchor.right);
    document.body.classList.toggle("anchor-bottom", !!anchor.bottom);
    document.body.classList.add("open");
    paint();
    fitChat();
    return;
  }
  // the panel fades back into the icon (140 ms), THEN the window shrinks
  document.body.classList.remove("open");
  closeTimer = setTimeout(async () => {
    try { await invoke("bubble_expand", { expanded: false }); } catch (_) {}
    document.body.classList.remove("anchor-right", "anchor-bottom");
  }, 150);
}

// The icon: a click opens/closes the panel and NOTHING else (owner, 2026-11-18:
// «clicar expande»). Recording starts from the panel's «Gravar».
function onIconClick() {
  setOpen(BC.panel(open, "icon-click"));
}

// Press-and-hold + move drags the window; a press without movement is a click.
// The drag is the SYSTEM's (startDragging): it follows the cursor across screens.
const gesture = BC.gesture();
$("icon").addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  gesture.down(e.screenX, e.screenY);
});
document.addEventListener("mousemove", (e) => {
  if (gesture.move(e.screenX, e.screenY) === "drag") {
    try { TAURI.window.getCurrentWindow().startDragging(); } catch (_) {}
  }
});
document.addEventListener("mouseup", (e) => {
  if (gesture.up(e.screenX, e.screenY) === "click") onIconClick();
});
$("icon").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onIconClick(); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setOpen(BC.panel(open, "escape"));
});
window.addEventListener("blur", () => setOpen(BC.panel(open, "blur")));

// ---- tabs ------------------------------------------------------------------------
function setTab(name) {
  tab = name;
  $("tabBtnRec").setAttribute("aria-selected", String(name === "rec"));
  $("tabBtnAgenda").setAttribute("aria-selected", String(name === "agenda"));
  $("tabRec").hidden = name !== "rec";
  $("tabAgenda").hidden = name !== "agenda";
  paint();
}
$("tabBtnRec").addEventListener("click", () => setTab("rec"));
$("tabBtnAgenda").addEventListener("click", () => setTab("agenda"));

// ---- destination: chips inline, «outra…» opens the full list ---------------------
const NOVA = "__nova__";
let temaChoice = "";      // "" = follow the main window's `destino`
let temaMode = "chips";   // "chips" | "list" | "nova"
function chosenTema() {
  if (temaMode === "nova") return ($("bNovaIdeia").value || "").trim();
  if (temaMode === "list") return $("bTema").value === NOVA ? ($("bNovaIdeia").value || "").trim() : $("bTema").value;
  return temaChoice || st.destino || "";
}
function pickTema(slug) {
  temaChoice = slug; temaMode = "chips";
  send("set-tema", { tema: slug });
  paint();
}
$("bTema").addEventListener("change", () => {
  const nova = $("bTema").value === NOVA;
  $("bNovaIdeia").hidden = !nova;
  if (nova) { $("bNovaIdeia").focus(); return; }
  pickTema($("bTema").value);
});
$("bNovaIdeia").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("bGravar").click(); }
});
function isNova() {
  return temaMode === "nova" || (temaMode === "list" && $("bTema").value === NOVA);
}
$("bGravar").addEventListener("click", () => {
  const tema = chosenTema();
  if (!tema) { $("bAviso").textContent = t("escolha ou nomeie uma ideia"); return; }
  $("bAviso").textContent = "";
  send("start", { tema, nova: isNova() });
});
$("bPausar").addEventListener("click", () => send("pause"));
$("bRetomar").addEventListener("click", () => send("resume"));
$("bEncerrar").addEventListener("click", () => send("stop"));
$("bNova").addEventListener("click", () => {
  const tema = chosenTema();
  if (!tema) { $("bAviso").textContent = t("escolha ou nomeie uma ideia"); return; }
  send("new", { tema, nova: isNova() });
});
$("bAbrir").addEventListener("click", () => send("open"));

// ---- painting ----------------------------------------------------------------------
const hhmm = (ms) => {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
};
function scheduledMap() {
  const m = {};
  for (const e of (st.agenda && st.agenda.eventos) || []) if (e.agendada) m[e.id] = { tema: e.tema };
  return m;
}
function stateLine(b) {
  if (st.rec === "recording") return t("gravando") + " · " + b.time;
  if (st.rec === "paused") return t("pausado") + " · " + b.time;
  if (st.rec === "starting") return t("iniciando…");
  if (st.rec === "stopping") return t("encerrando…");
  return t("pronto para gravar");
}
function paintBadge() {
  const b = BC.badge(st, Date.now());
  const badge = $("badge");
  badge.className = b.kind || "";
  badge.textContent = b.kind === "pause" ? "❚❚" : "";
  // the collapsed icon's tooltip: the state and the next meeting (refinamento 4)
  const next = LAG ? LAG.nextEvent((st.agenda && st.agenda.eventos) || [], scheduledMap(), Date.now()) : null;
  const tip = BC.tooltip(b.kind ? stateLine(b) : "Loro", next, hhmm,
    { proxima: t("Próxima"), gravar: t("gravar"), semTitulo: t("(sem título)") });
  $("icon").title = open ? "" : tip;
  $("icon").setAttribute("aria-label", tip.replace(/\n/g, " · "));
  return b;
}

function paintHead(b) {
  document.body.classList.toggle("rec", st.rec === "recording");
  document.body.classList.toggle("paused", st.rec === "paused");
  const label = st.rec === "recording" ? t("gravando") : st.rec === "paused" ? t("pausado")
    : st.rec === "starting" ? t("iniciando…") : st.rec === "stopping" ? t("encerrando…") : t("pronto para gravar");
  $("bStatusText").textContent = label;
  const temaNome = (slug) => ((st.temas || []).find((x) => x.slug === slug) || {}).nome || slug;
  $("bTitle").textContent = st.rec !== "idle"
    ? (st.titulo || t("Reunião")) + (st.tema ? " · " + temaNome(st.tema) : "")
    : (chosenTema() ? t("em %1", [temaNome(chosenTema())]) : "Loro");
  $("bTime").textContent = b.time || "";
}

function paintTemas() {
  const box = $("bTemaChips");
  const sel = $("bTema");
  const busy = st.rec !== "idle";
  const current = busy ? st.tema : chosenTema();
  // the chips: the current one first, then the others the main window lists
  const temas = st.temas || [];
  const order = [];
  if (current && temas.some((x) => x.slug === current)) order.push(current);
  for (const x of temas) if (order.length < 4 && !order.includes(x.slug)) order.push(x.slug);
  box.textContent = "";
  for (const slug of order) {
    const x = temas.find((y) => y.slug === slug);
    const b = document.createElement("button");
    b.className = "chip"; b.textContent = (x && (x.nome || x.slug)) || slug; b.title = b.textContent;
    b.setAttribute("aria-pressed", String(slug === current && temaMode === "chips"));
    b.disabled = busy;
    b.addEventListener("click", () => pickTema(slug));
    box.appendChild(b);
  }
  const more = document.createElement("button");
  more.className = "chip"; more.textContent = temas.length > order.length ? t("outra…") : t("+ nova ideia…");
  more.disabled = busy;
  more.setAttribute("aria-pressed", String(temaMode !== "chips"));
  more.addEventListener("click", () => {
    temaMode = temas.length > order.length ? "list" : "nova";
    paint();
    if (temaMode === "nova") $("bNovaIdeia").focus();
  });
  box.appendChild(more);
  if (!temas.length && temaMode === "chips") temaMode = "nova";
  // the full list, when asked for
  if (sel !== document.activeElement) {
    const keep = sel.value;
    sel.textContent = "";
    for (const x of temas) {
      const o = document.createElement("option");
      o.value = x.slug; o.textContent = x.nome || x.slug;
      sel.appendChild(o);
    }
    const n = document.createElement("option");
    n.value = NOVA; n.textContent = t("+ nova ideia…");
    sel.appendChild(n);
    if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
    else if (current) sel.value = current;
  }
  sel.hidden = busy || temaMode !== "list";
  $("bNovaIdeia").hidden = busy || !(temaMode === "nova" || (temaMode === "list" && sel.value === NOVA));
}

function paintControls() {
  const shown = new Set(BC.controls({ rec: st.rec, meeting: !!st.meeting, canRecord: !!st.canRecord }));
  $("bGravar").hidden = !shown.has("gravar");
  $("bPausar").hidden = !shown.has("pausar");
  $("bRetomar").hidden = !shown.has("retomar");
  $("bEncerrar").hidden = !shown.has("encerrar");
  $("bNova").hidden = !shown.has("nova");
  $("bAviso").textContent = st.aviso ? t(st.aviso) : "";
}

function paintTail() {
  const box = $("bTail");
  box.dataset.empty = st.rec === "idle" ? t("nada gravando") : t("aguardando fala…");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 8;
  box.textContent = "";
  for (const l of BC.tail(st.linhas, 12)) {
    const p = document.createElement("div");
    const who = document.createElement("span");
    const label = BC.whoLabel(l.who);
    who.className = "who " + label;
    who.textContent = t(label);
    p.appendChild(who);
    p.appendChild(document.createTextNode(l.text));
    box.appendChild(p);
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
}

// ---- agenda: hoje / amanhã / já passaram, each row expandable ---------------------
function liveText(e, now) {
  const s = LAG.statusOf(e, now);
  if (s.kind === "agora") return t("agora");
  if (s.kind === "passou") return t("já passou");
  if (s.minutos < 60) return t("começa em %1 min", [s.minutos]);
  return t("começa às %1", [hhmm(e.inicioMs)]);
}
function eventRow(e, now) {
  const li = document.createElement("li");
  const s = LAG.statusOf(e, now);
  li.className = "ev" + (s.kind === "agora" ? " now" : "") + (openEv === e.id ? " open" : "");
  li.dataset.ev = e.id;
  const head = document.createElement("button");
  head.setAttribute("aria-expanded", String(openEv === e.id));
  const h = document.createElement("span"); h.className = "hora"; h.textContent = hhmm(e.inicioMs);
  const tit = document.createElement("span"); tit.className = "tit";
  tit.textContent = e.titulo || t("(sem título)"); tit.title = tit.textContent;
  head.append(h, tit);
  if (s.kind === "agora") { const m = document.createElement("span"); m.className = "mark"; m.textContent = t("agora"); head.appendChild(m); }
  if (e.agendada) { const m = document.createElement("span"); m.className = "mark"; m.textContent = "● " + t("gravar"); head.appendChild(m); }
  head.addEventListener("click", () => { openEv = openEv === e.id ? "" : e.id; paintAgenda(); });
  li.appendChild(head);
  if (openEv !== e.id) return li;

  const det = document.createElement("div");
  det.className = "det";
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${hhmm(e.inicioMs)}–${hhmm(e.fimMs)} · ${t("%1 min", [LAG.durationMin(e)])} · ${liveText(e, now)} · `
    + (e.comConvidados ? t("com convidados") : t("sem convidados"));
  det.appendChild(meta);
  if (s.kind !== "passou") {
    // the destination for THIS event
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", t("onde salvar"));
    for (const x of st.temas || []) {
      const o = document.createElement("option"); o.value = x.slug; o.textContent = x.nome || x.slug; sel.appendChild(o);
    }
    const want = temaEv[e.id] || e.tema || chosenTema();
    if (want && [...sel.options].some((o) => o.value === want)) sel.value = want;
    sel.addEventListener("change", () => {
      temaEv[e.id] = sel.value;
      if (e.agendada) send("schedule", { id: e.id, on: true, tema: sel.value });
    });
    det.appendChild(sel);
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = !!e.agendada;
    cb.addEventListener("change", () => {
      const tema = sel.value || chosenTema();
      if (cb.checked && !tema) { cb.checked = false; $("bAviso").textContent = t("escolha ou nomeie uma ideia"); return; }
      send("schedule", { id: e.id, on: cb.checked, tema });
    });
    lab.append(cb, document.createTextNode(t("Gravar quando começar")));
    det.appendChild(lab);
    if (s.kind === "agora" && st.rec === "idle") {
      const now2 = document.createElement("button");
      now2.className = "btn primary"; now2.textContent = t("Gravar agora");
      now2.addEventListener("click", () => send("record-now", { id: e.id, tema: sel.value || chosenTema() }));
      const row = document.createElement("div"); row.className = "row"; row.appendChild(now2);
      det.appendChild(row);
    }
  }
  li.appendChild(det);
  return li;
}
function paintAgenda() {
  const now = Date.now();
  const ag = st.agenda || { status: "missing", eventos: [] };
  const g = LAG.group(ag.eventos || [], now);
  const ul = $("bAgenda");
  ul.textContent = "";
  const section = (title, list) => {
    if (!list.length) return;
    const h = document.createElement("li"); h.className = "grp"; h.textContent = title; ul.appendChild(h);
    for (const e of list) ul.appendChild(eventRow(e, now));
  };
  section(t("Hoje"), g.hoje);
  section(t("Amanhã"), g.amanha);
  const past = $("bPassados");
  past.hidden = !g.passados.length;
  past.querySelector("summary").textContent = t("Já passaram (%1)", [g.passados.length]);
  const pul = past.querySelector("ul");
  pul.textContent = "";
  for (const e of g.passados) pul.appendChild(eventRow(e, now));
  const nota = $("bAgendaNota");
  if (ag.status === "missing" || ag.status === "stale" || ag.status === "invalid") nota.textContent = t("agenda não atualizada");
  else if (!g.hoje.length && !g.amanha.length) nota.textContent = t("nenhuma reunião pela frente");
  else nota.textContent = "";
}

function paintPrompt() {
  const box = $("bPrompt"), txt = $("bPromptText"), acts = $("bPromptActs");
  const p = st.prompt;
  box.hidden = !p;
  if (!p) { lastPromptKey = ""; return; }
  acts.textContent = "";
  const btn = (label, cmd, primary) => {
    const b = document.createElement("button");
    b.className = "btn " + (primary ? "primary" : "ghost");
    b.textContent = t(label);
    b.addEventListener("click", () => send(cmd, { id: p.eventId }));
    acts.appendChild(b);
  };
  const titulo = p.titulo || t("(sem título)");
  if (p.kind === "extend") {
    txt.textContent = t("termina em %1 min — estender?", [p.minutos]);
    btn("+15 min", "extend", true);
    btn("deixar terminar", "dismiss");
  } else if (p.kind === "switch") {
    txt.textContent = t("Começou: %1 — trocar para ela?", [titulo]);
    btn("Trocar", "switch", true);
    btn("Continuar", "keep");
  } else if (p.kind === "suggest") {
    txt.textContent = t("Gravar %1?", [titulo]);
    btn("Gravar", "record-suggested", true);
    btn("agora não", "dismiss");
  }
  // a NEW question opens the panel so it is seen; the same one does not reopen
  // a panel the person closed
  const key = p.kind + ":" + (p.eventId || "");
  if (key !== lastPromptKey) {
    lastPromptKey = key;
    if (!open) setOpen(BC.panel(open, "prompt"));
  }
}

function paint() {
  const b = paintBadge();
  if (!open) return;
  paintHead(b);
  if (tab === "rec") { paintTemas(); paintControls(); paintTail(); }
  else { paintAgenda(); $("bAviso").textContent = st.aviso ? t(st.aviso) : ""; }
}

listen("bubble-state", (e) => {
  st = Object.assign({}, st, (e && e.payload) || {});
  applyLang(st.lang);
  paintPrompt();
  paint();
});

// ---- the mini chat (ADR-0041 §3, owner request A) ----------------------------------
// The acervo's agent on the bubble's own channel: its own session (--resume for
// follow-ups), its own events. Context goes as FILE REFERENCES (the living meeting
// and the agenda files), never pasted.
const chat = { busy: false, cur: null, buf: "", hasSession: false };
function chatScrollToEnd() { const log = $("bChatLog"); log.scrollTop = log.scrollHeight; }
function addMsg(kind, text) {
  const d = document.createElement("div");
  d.className = "msg " + kind;
  if (kind === "q" || kind === "err") d.textContent = text;
  $("bChatLog").appendChild(d);
  return d;
}
function renderAnswer(el, text) {
  el.innerHTML = BC.mdLite(text);
  const c = document.createElement("button");
  c.className = "copy"; c.textContent = "⧉"; c.title = t("copiar"); c.setAttribute("aria-label", t("copiar"));
  c.addEventListener("click", () => {
    try { navigator.clipboard.writeText(text); c.textContent = "✓"; setTimeout(() => (c.textContent = "⧉"), 1200); } catch (_) {}
  });
  el.appendChild(c);
}
function paintChatBar() {
  $("bChatSend").hidden = chat.busy;
  $("bChatStop").hidden = !chat.busy;
  $("bChatState").textContent = chat.busy ? t("pensando…") : "";
  $("bChatNova").hidden = chat.busy || !$("bChatLog").children.length;
}
// the card grows with the conversation, up to 70% of the screen (bubble.rs)
let fitTimer = null;
function fitChat() {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    if (!open) return;
    const log = $("bChatLog");
    const extra = log.children.length ? Math.min(log.scrollHeight, 340) : 0;
    invoke("bubble_panel_height", { height: BASE_PANEL_H + extra }).catch(() => {});
  }, 80);
}
async function chatSend() {
  const ta = $("bChatIn");
  const q = ta.value.trim();
  if (!q || chat.busy) return;
  ta.value = ""; autosize();
  addMsg("q", q);
  chat.cur = addMsg("a", ""); chat.buf = "";
  chat.busy = true; paintChatBar(); chatScrollToEnd(); fitChat();
  try {
    await invoke("chat_send", { input: { prompt: BC.chatPrompt(q, st.chatCtx || []), channel: "bubble", fresh: !chat.hasSession } });
  } catch (e) {
    chat.busy = false; chat.cur.remove(); chat.cur = null;
    addMsg("err", I18N ? I18N.tErr(String(e)) : String(e));
    paintChatBar();
  }
}
listen("bubble-chat-delta", (e) => {
  if (!chat.cur) return;
  chat.buf += String((e && e.payload) || "");
  renderAnswer(chat.cur, chat.buf);
  chatScrollToEnd(); fitChat();
});
listen("bubble-chat-tool", (e) => {
  const p = (e && e.payload) || {};
  if (chat.busy) $("bChatState").textContent = t("usando %1…", [p.name || "?"]);
});
listen("bubble-chat-done", (e) => {
  const p = (e && e.payload) || {};
  chat.busy = false;
  if (p.ok) chat.hasSession = true;
  else if (chat.cur) {
    if (!chat.buf) chat.cur.remove();
    addMsg("err", I18N ? I18N.tErr(p.error || "err.chat_agent_failed") + (p.detail ? ": " + String(p.detail).slice(0, 200) : "") : String(p.error));
  }
  chat.cur = null;
  paintChatBar(); chatScrollToEnd(); fitChat();
});
$("bChatSend").addEventListener("click", chatSend);
$("bChatStop").addEventListener("click", () => {
  invoke("chat_cancel", { channel: "bubble" }).catch(() => {});
  chat.busy = false; chat.cur = null; paintChatBar();
});
$("bChatNova").addEventListener("click", () => {
  invoke("chat_reset", { channel: "bubble" }).catch(() => {});
  chat.hasSession = false; chat.cur = null;
  $("bChatLog").textContent = "";
  paintChatBar(); fitChat();
});
function autosize() {
  const ta = $("bChatIn");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 96) + "px";
}
$("bChatIn").addEventListener("input", autosize);
$("bChatIn").addEventListener("keydown", (e) => {
  // Enter sends, Shift+Enter breaks the line (Esc is the document's: collapse)
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); chatSend(); }
});

// The clock only re-reads numbers; the dot and the glyph never change state on
// their own (no blinking, ADR-0041 §2). The agenda's «começa em» follows it.
let ticks = 0;
setInterval(() => {
  const b = paintBadge();
  if (!open) return;
  $("bTime").textContent = b.time || "";
  if (tab === "agenda" && ++ticks % 30 === 0) paintAgenda();
}, 1000);

// Ask the main window for the current state: it may have started before us.
send("hello");
paintChatBar();
