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
const LTF = window.LoroTarefas;
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
  if (e.key !== "Escape") return;
  if (openPicker) { openPicker.close(); return; }
  setOpen(BC.panel(open, "escape"));
});
window.addEventListener("blur", () => setOpen(BC.panel(open, "blur")));

// ---- tabs ------------------------------------------------------------------------
function setTab(name) {
  tab = name;
  for (const [btn, pane, key] of [["tabBtnRec", "tabRec", "rec"], ["tabBtnAgenda", "tabAgenda", "agenda"], ["tabBtnTarefas", "tabTarefas", "tarefas"]]) {
    $(btn).setAttribute("aria-selected", String(name === key));
    $(pane).hidden = name !== key;
  }
  paint();
}
$("tabBtnRec").addEventListener("click", () => setTab("rec"));
$("tabBtnAgenda").addEventListener("click", () => setTab("agenda"));
$("tabBtnTarefas").addEventListener("click", () => setTab("tarefas"));

// Links leave through the backend, which opens http(s) only in the default
// browser (brain_open_link) — never inside this webview.
function openLink(url) {
  if (!url || !/^https?:\/\//i.test(url)) return;
  invoke("brain_open_link", { url }).catch(() => {});
}

// ---- destination: ONE compact field that opens a searchable list ----------------
// Owner (2026-11-18): chips did not scale («e se tiver uma lista grande?»). The
// picker shows the current idea; clicking opens a type-to-filter list (fuzzy.js):
// «Recentes» first, then every idea alphabetically (8 rows, scrolls), and
// «+ nova ideia «texto»» when nothing has that name. ↑/↓/Enter/Esc. The SAME
// component is the per-event destination in the Agenda.
const FZ = window.LoroFuzzy;
let dest = null;          // {slug, nome, nova} chosen here; null = follow st.destino
const temaNome = (slug) => ((st.temas || []).find((x) => x.slug === slug) || {}).nome || slug;
function currentDest() {
  if (dest) return dest;
  return st.destino ? { slug: st.destino, nome: temaNome(st.destino), nova: false } : null;
}
// what the main window receives: an existing idea's slug, or the NAME of a new one
const destArg = (d) => (d ? (d.nova ? d.nome : d.slug) : "");

let openPicker = null;    // the one picker whose list is open
function makePicker(host, opts) {
  const wrap = document.createElement("div");
  wrap.className = "picker";
  const btn = document.createElement("button");
  btn.className = "pickbtn";
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  const pop = document.createElement("div");
  pop.className = "pickpop"; pop.hidden = true;
  const q = document.createElement("input");
  q.type = "text"; q.className = "pickq"; q.spellcheck = false;
  q.setAttribute("role", "combobox"); q.setAttribute("aria-autocomplete", "list");
  q.placeholder = t("buscar ou criar ideia…");
  const ul = document.createElement("ul");
  ul.className = "picklist"; ul.setAttribute("role", "listbox");
  ul.setAttribute("aria-label", t("ideias"));
  pop.append(q, ul);
  wrap.append(btn, pop);
  host.textContent = "";
  host.appendChild(wrap);
  let items = [], active = -1;
  const label = () => {
    const v = opts.value();
    btn.textContent = "";
    const name = document.createElement("span"); name.className = "pickname";
    name.textContent = v ? (v.nova ? t("nova: %1", [v.nome]) : v.nome) : t("escolher ideia…");
    const caret = document.createElement("span"); caret.className = "pickcaret"; caret.textContent = "▾";
    btn.append(name, caret);
    btn.disabled = !!(opts.disabled && opts.disabled());
  };
  const render = () => {
    items = BC.pickerItems({ temas: st.temas || [], recentes: st.recentes || [], query: q.value, filter: FZ ? FZ.filter : undefined });
    if (active >= items.length) active = items.length - 1;
    if (active < 0 && items.length) active = 0;
    ul.textContent = "";
    let lastKind = "";
    items.forEach((it, i) => {
      const grp = it.kind === "recent" ? t("Recentes") : it.kind === "all" ? t("Todas as ideias") : "";
      if (grp && it.kind !== lastKind) {
        const h = document.createElement("li"); h.className = "pickgrp"; h.setAttribute("role", "presentation"); h.textContent = grp;
        ul.appendChild(h);
      }
      lastKind = it.kind;
      const li = document.createElement("li");
      li.className = "pickit" + (it.kind === "new" ? " new" : "");
      li.setAttribute("role", "option");
      li.id = "pk-" + Math.random().toString(36).slice(2);
      li.setAttribute("aria-selected", String(i === active));
      li.textContent = it.kind === "new" ? t("+ nova ideia «%1»", [it.nome]) : it.nome;
      li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(i); });
      ul.appendChild(li);
      if (i === active) { q.setAttribute("aria-activedescendant", li.id); li.scrollIntoView({ block: "nearest" }); }
    });
    if (!items.length) {
      const li = document.createElement("li"); li.className = "pickgrp"; li.textContent = t("digite o nome de uma ideia");
      ul.appendChild(li);
    }
  };
  const close = () => {
    pop.hidden = true; btn.setAttribute("aria-expanded", "false");
    if (openPicker === api) openPicker = null;
  };
  const choose = (i) => {
    const it = items[i];
    if (!it) return;
    close();
    opts.onPick(it.kind === "new" ? { slug: "", nome: it.nome, nova: true } : { slug: it.slug, nome: it.nome, nova: false });
    label();
    btn.focus();
  };
  const openIt = () => {
    if (openPicker && openPicker !== api) openPicker.close();
    openPicker = api;
    q.value = ""; active = -1;
    pop.hidden = false; btn.setAttribute("aria-expanded", "true");
    render(); q.focus();
  };
  btn.addEventListener("click", () => (pop.hidden ? openIt() : close()));
  q.addEventListener("input", () => { active = 0; render(); });
  q.addEventListener("keydown", (e) => {
    const r = BC.pickerKey(active, e.key, items.length);
    if (r.action === "none") return;
    e.preventDefault();
    // Esc closes the LIST, not the whole panel
    e.stopPropagation();
    if (r.action === "move") { active = r.index; render(); }
    else if (r.action === "pick") choose(r.index);
    else if (r.action === "close") { close(); btn.focus(); }
  });
  const api = { close, label, isOpen: () => !pop.hidden };
  label();
  return api;
}

const mainPicker = makePicker($("bDest"), {
  value: () => (st.rec !== "idle" && st.tema ? { slug: st.tema, nome: temaNome(st.tema), nova: false } : currentDest()),
  // during a recording the destination is the meeting's: changing it would
  // promise a move that does not happen
  disabled: () => st.rec !== "idle",
  onPick: (d) => {
    dest = d;
    if (!d.nova) send("set-tema", { tema: d.slug });
    paint();
  },
});

$("bGravar").addEventListener("click", () => {
  const d = currentDest();
  if (!d) { $("bAviso").textContent = t("escolha ou nomeie uma ideia"); return; }
  $("bAviso").textContent = "";
  send("start", { tema: destArg(d), nova: !!d.nova });
  if (d.nova) dest = null; // created now; the main window makes it the destino
});
$("bPausar").addEventListener("click", () => send("pause"));
$("bRetomar").addEventListener("click", () => send("resume"));
$("bEncerrar").addEventListener("click", () => send("stop"));
$("bNova").addEventListener("click", () => {
  const d = currentDest();
  if (!d) { $("bAviso").textContent = t("escolha ou nomeie uma ideia"); return; }
  send("new", { tema: destArg(d), nova: !!d.nova });
  if (d.nova) dest = null;
});
// opening the main window folds the panel: the bubble steps aside while that
// window is in front, and comes back as the icon, not the open panel
$("bAbrir").addEventListener("click", () => { setOpen(false); send("open"); });
// owner, 2026-11-19: «fechar essa miniatura a algum momento». Hidden until the
// tray item, ⌘K «Mostrar / ocultar balão» or Settings shows it again.
$("bOcultar").addEventListener("click", async () => {
  await setOpen(false);
  setTimeout(() => { invoke("bubble_set_visible", { visible: false }).catch(() => {}); }, 160);
});

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
  const d = currentDest();
  $("bTitle").textContent = st.rec !== "idle"
    ? (st.titulo || t("Reunião")) + (st.tema ? " · " + temaNome(st.tema) : "")
    : (d ? t("em %1", [d.nome]) : "Loro");
  $("bTime").textContent = b.time || "";
}

function paintTemas() {
  // a list the person is typing in is not repainted under the cursor
  if (!mainPicker.isOpen()) mainPicker.label();
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
let nextId = "";
function eventRow(e, now) {
  const li = document.createElement("li");
  const s = LAG.statusOf(e, now);
  li.className = "ev" + (s.kind === "agora" ? " now" : "") + (openEv === e.id ? " open" : "");
  li.dataset.ev = e.id;
  const head = document.createElement("button");
  head.className = "evhead";
  head.setAttribute("aria-expanded", String(openEv === e.id));
  const h = document.createElement("span"); h.className = "hora"; h.textContent = hhmm(e.inicioMs);
  const tit = document.createElement("span"); tit.className = "tit";
  tit.textContent = e.titulo || t("(sem título)");
  head.append(h, tit);
  if (s.kind === "agora") { const m = document.createElement("span"); m.className = "mark"; m.textContent = t("agora"); head.appendChild(m); }
  if (e.agendada) { const m = document.createElement("span"); m.className = "mark"; m.textContent = "● " + t("gravar"); head.appendChild(m); }
  head.addEventListener("click", () => { openEv = openEv === e.id ? "" : e.id; paintAgenda(); });
  const row = document.createElement("div");
  row.className = "evrow";
  row.appendChild(head);
  // «Entrar» à vista no que está acontecendo e no próximo a começar
  if (e.link && (s.kind === "agora" || e.id === nextId)) {
    const j = document.createElement("button");
    j.className = "btn primary join"; j.textContent = t("Entrar");
    j.addEventListener("click", () => openLink(e.link));
    row.appendChild(j);
  }
  li.appendChild(row);
  if (openEv !== e.id) return li;

  const det = document.createElement("div");
  det.className = "det";
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${hhmm(e.inicioMs)}–${hhmm(e.fimMs)} · ${t("%1 min", [LAG.durationMin(e)])} · ${liveText(e, now)} · `
    + (e.comConvidados ? t("com convidados") : t("sem convidados"));
  det.appendChild(meta);
  if (e.link || e.linkAgenda) {
    const links = document.createElement("div"); links.className = "row";
    if (e.link && s.kind !== "passou") {
      const j = document.createElement("button"); j.className = "btn ghost"; j.textContent = t("Entrar");
      j.addEventListener("click", () => openLink(e.link)); links.appendChild(j);
    }
    if (e.linkAgenda) {
      const a = document.createElement("button"); a.className = "btn link"; a.textContent = t("Abrir na agenda");
      a.addEventListener("click", () => openLink(e.linkAgenda)); links.appendChild(a);
    }
    det.appendChild(links);
  }
  if (s.kind !== "passou") {
    // the destination for THIS event: the same picker as the Gravação tab
    const host = document.createElement("div");
    det.appendChild(host);
    const evDest = () => temaEv[e.id] || (e.tema ? { slug: e.tema, nome: temaNome(e.tema), nova: false } : currentDest());
    makePicker(host, {
      value: evDest,
      onPick: (d) => {
        temaEv[e.id] = d;
        if (e.agendada) send("schedule", { id: e.id, on: true, tema: destArg(d), nova: !!d.nova });
      },
    });
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = !!e.agendada;
    cb.addEventListener("change", () => {
      const d = evDest();
      if (cb.checked && !d) { cb.checked = false; $("bAviso").textContent = t("escolha ou nomeie uma ideia"); return; }
      send("schedule", { id: e.id, on: cb.checked, tema: destArg(d), nova: !!(d && d.nova) });
    });
    lab.append(cb, document.createTextNode(t("Gravar quando começar")));
    det.appendChild(lab);
    if (s.kind === "agora" && st.rec === "idle") {
      const now2 = document.createElement("button");
      now2.className = "btn primary"; now2.textContent = t("Gravar agora");
      now2.addEventListener("click", () => { const d = evDest(); send("record-now", { id: e.id, tema: destArg(d), nova: !!(d && d.nova) }); });
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
  const nx = (ag.eventos || []).filter((e) => e.inicioMs > now).sort((a, b) => a.inicioMs - b.inicioMs)[0];
  nextId = nx ? nx.id : "";
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
  } else if (p.kind === "join") {
    txt.textContent = t("Gravando: %1", [titulo]);
    const b = document.createElement("button");
    b.className = "btn primary"; b.textContent = t("Entrar na reunião");
    b.addEventListener("click", () => { openLink(p.link); send("dismiss"); });
    acts.appendChild(b);
    btn("ok", "dismiss");
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

// ---- tarefas (ADR-0041 §10): o arquivo do agente; concluir grava uma AÇÃO -----
let openTk = "";
function prazoText(p, hoje) {
  if (p === hoje) return t("hoje");
  const [y, m, d] = p.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(lang === "en" ? "en-US" : "pt-BR", { day: "numeric", month: "short" });
}
function taskRow(tk, hoje, pend) {
  const st2 = LTF.effective(tk, pend);
  const li = document.createElement("li");
  li.className = "tk" + (st2.done ? " done" : "") + (openTk === tk.id ? " open" : "");
  li.dataset.tk = tk.id;
  const row = document.createElement("div"); row.className = "tkrow";
  const cb = document.createElement("input");
  cb.type = "checkbox"; cb.checked = st2.done;
  cb.setAttribute("aria-label", st2.done ? t("reabrir") : t("concluir"));
  cb.addEventListener("change", () => send("tarefa", { id: tk.id, acao: cb.checked ? "concluir" : "reabrir" }));
  const tit = document.createElement("button");
  tit.className = "tkt"; tit.textContent = tk.titulo || t("(sem título)");
  tit.setAttribute("aria-expanded", String(openTk === tk.id));
  tit.addEventListener("click", () => { openTk = openTk === tk.id ? "" : tk.id; paintTarefas(); });
  row.append(cb, tit);
  if (st2.pendente) {
    const pd = document.createElement("span"); pd.className = "pend";
    pd.textContent = st2.pendente === "concluir" ? t("concluindo…") : t("reabrindo…");
    row.appendChild(pd);
  } else if (tk.prazo && tk.status !== "completed") {
    const pz = document.createElement("span");
    pz.className = "prazo" + (tk.prazo < hoje ? " late" : "");
    pz.textContent = prazoText(tk.prazo, hoje);
    row.appendChild(pz);
  }
  li.appendChild(row);
  if (openTk === tk.id) {
    if (tk.notas) {
      const n = document.createElement("div"); n.className = "notas";
      // texto puro (as quebras ficam pelo CSS) e só http(s) vira link
      for (const seg of LTF.linkify(tk.notas)) {
        if (seg.url) {
          const a = document.createElement("button"); a.className = "lnk"; a.textContent = seg.url;
          a.addEventListener("click", () => openLink(seg.url)); n.appendChild(a);
        } else n.appendChild(document.createTextNode(seg.text));
      }
      li.appendChild(n);
    }
    if (tk.link) {
      const acts = document.createElement("div"); acts.className = "acts";
      const g = document.createElement("button"); g.className = "btn link"; g.textContent = t("Abrir no Google");
      g.addEventListener("click", () => openLink(tk.link)); acts.appendChild(g);
      li.appendChild(acts);
    }
  }
  return li;
}
function paintTarefas() {
  const tf = st.tarefas || { status: "missing", lista: [], pendentes: [] };
  const now = Date.now(), hoje = LAG.dayKey(new Date(now));
  const g = LTF.group(tf.lista || [], now, tf.pendentes || []);
  const ul = $("bTarefas");
  ul.textContent = "";
  const section = (title, list) => {
    if (!list.length) return;
    const h = document.createElement("li"); h.className = "grp"; h.textContent = title; ul.appendChild(h);
    for (const tk of list) ul.appendChild(taskRow(tk, hoje, tf.pendentes || []));
  };
  section(t("Atrasadas"), g.atrasadas);
  section(t("Hoje"), g.hoje);
  section(t("Próximas"), g.proximas);
  section(t("Sem prazo"), g.semPrazo);
  const done = $("bConcluidas");
  done.hidden = !g.concluidas.length;
  done.querySelector("summary").textContent = t("Concluídas (%1)", [g.concluidas.length]);
  const dul = done.querySelector("ul"); dul.textContent = "";
  for (const tk of g.concluidas) dul.appendChild(taskRow(tk, hoje, tf.pendentes || []));
  const nota = $("bTarefasNota");
  if (tf.status !== "ok") nota.textContent = t("tarefas não atualizadas");
  else if (!g.atrasadas.length && !g.hoje.length && !g.proximas.length && !g.semPrazo.length) nota.textContent = t("nenhuma tarefa aberta");
  else nota.textContent = "";
}
function paintTarefasBadge() {
  const tf = st.tarefas || { lista: [], pendentes: [] };
  const n = LTF ? LTF.badgeCount(tf.lista || [], Date.now(), tf.pendentes || []) : 0;
  const b = $("bTarefasBadge");
  b.hidden = !n; b.textContent = n ? String(n) : "";
  $("tabBtnTarefas").setAttribute("aria-label", n ? t("Tarefas") + " · " + t("%1 para hoje ou atrasadas", [n]) : t("Tarefas"));
}

function paint() {
  const b = paintBadge();
  if (!open) return;
  paintHead(b);
  paintTarefasBadge();
  if (tab === "rec") { paintTemas(); paintControls(); paintTail(); }
  else if (tab === "agenda") { paintAgenda(); $("bAviso").textContent = st.aviso ? t(st.aviso) : ""; }
  else paintTarefas();
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
  c.className = "copy"; c.textContent = "⧉"; c.setAttribute("aria-label", t("copiar"));
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
  // um turno que terminou sem texto não deixa uma bolha vazia na conversa
  if (chat.cur && !chat.buf) chat.cur.remove();
  if (!p.ok && chat.cur) {
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
// «/» abre a lista de skills e comandos (ADR-0041 §11), como no terminal do
// Claude Code: filtra enquanto digita, ↑/↓ movem, Tab/Enter completam, Esc fecha.
// A lista vem do backend (skills_list), que a guarda por 60 s.
const slash = { list: [], at: 0, items: [], active: 0, open: false };
async function slashLoad() {
  if (Date.now() - slash.at < 60000 && slash.list.length) return;
  try { slash.list = (await invoke("skills_list")) || []; slash.at = Date.now(); } catch (_) {}
}
function slashClose() { slash.open = false; $("bSlash").hidden = true; }
function slashRender() {
  const ul = $("bSlash");
  ul.textContent = "";
  slash.items.forEach((it, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(i === slash.active));
    const n = document.createElement("span"); n.className = "sn"; n.textContent = "/" + it.name;
    const d = document.createElement("span"); d.className = "sd"; d.textContent = it.description || "";
    li.append(n, d);
    li.addEventListener("mousedown", (e) => { e.preventDefault(); slashPick(i); });
    ul.appendChild(li);
    if (i === slash.active) li.scrollIntoView({ block: "nearest" });
  });
  ul.hidden = !slash.items.length;
  slash.open = !!slash.items.length;
}
async function slashUpdate() {
  const q = BC.slashQuery($("bChatIn").value);
  if (q == null) { slashClose(); return; }
  await slashLoad();
  slash.items = BC.slashItems(slash.list, q, FZ ? FZ.filter : undefined);
  slash.active = 0;
  slashRender();
}
function slashPick(i) {
  const it = slash.items[i];
  if (!it) return;
  const ta = $("bChatIn");
  ta.value = BC.slashComplete(it.name);
  slashClose();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  autosize();
}
$("bChatIn").addEventListener("input", () => { autosize(); slashUpdate(); });
$("bChatIn").addEventListener("keydown", (e) => {
  if (slash.open) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      slash.active = BC.pickerKey(slash.active, e.key, slash.items.length).index;
      slashRender(); return;
    }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); slashPick(slash.active); return; }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); slashClose(); return; }
  }
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
  if (++ticks % 30 === 0) { if (tab === "agenda") paintAgenda(); paintTarefasBadge(); }
}, 1000);

// Ask the main window for the current state: it may have started before us.
send("hello");
paintChatBar();
