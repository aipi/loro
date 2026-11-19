// Loro — the recording bubble window (ADR-0041). A REMOTE: the main window
// (app.js) owns the meeting and the scheduler; this window only paints the
// `bubble-state` it receives and sends `bubble-cmd` back. Decisions that can be
// pure live in bubble-core.js.
const TAURI = window.__TAURI__;
const { listen, emit } = TAURI.event;
const invoke = TAURI.core.invoke;
const BC = window.LoroBubble;
const I18N = window.LoroI18n;
const t = (s, args) => (I18N ? I18N.t(s, args) : s);
const $ = (id) => document.getElementById(id);

let st = { rec: "idle", temas: [], linhas: [], agenda: { status: "missing", eventos: [] } };
let open = false;
let lastPromptKey = "";

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

// ---- open / close ----------------------------------------------------------------
async function setOpen(next) {
  if (next === open) return;
  open = next;
  let anchor = { right: false, bottom: false };
  try { anchor = (await invoke("bubble_expand", { expanded: open })) || anchor; } catch (_) {}
  document.body.classList.toggle("open", open);
  document.body.classList.toggle("anchor-right", open && !!anchor.right);
  document.body.classList.toggle("anchor-bottom", open && !!anchor.bottom);
  $("icon").setAttribute("aria-expanded", String(open));
  paint();
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

// ---- the panel's controls ----------------------------------------------------------
const NOVA = "__nova__";
function chosenTema() {
  const sel = $("bTema");
  if (sel.value === NOVA) return ($("bNovaIdeia").value || "").trim();
  return sel.value;
}
$("bTema").addEventListener("change", () => {
  const nova = $("bTema").value === NOVA;
  $("bNovaIdeia").hidden = !nova;
  if (nova) { $("bNovaIdeia").focus(); return; }
  send("set-tema", { tema: $("bTema").value });
});
$("bNovaIdeia").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("bGravar").click(); }
});
$("bGravar").addEventListener("click", () => {
  const tema = chosenTema();
  if (!tema) { $("bAviso").textContent = t("escolha ou nomeie uma ideia"); return; }
  $("bAviso").textContent = "";
  send("start", { tema, nova: $("bTema").value === NOVA });
});
$("bPausar").addEventListener("click", () => send("pause"));
$("bRetomar").addEventListener("click", () => send("resume"));
$("bEncerrar").addEventListener("click", () => send("stop"));
$("bNova").addEventListener("click", () => {
  const tema = chosenTema();
  if (!tema) { $("bAviso").textContent = t("escolha ou nomeie uma ideia"); return; }
  send("new", { tema, nova: $("bTema").value === NOVA });
});
$("bAbrir").addEventListener("click", () => send("open"));

// ---- painting ----------------------------------------------------------------------
function paintBadge() {
  const b = BC.badge(st, Date.now());
  const badge = $("badge");
  badge.className = b.kind || "";
  badge.textContent = b.kind === "pause" ? "❚❚" : "";
  const time = $("time");
  time.textContent = b.time || "";
  time.classList.toggle("show", !!b.time && !open);
  const label = b.kind === "rec" ? t("gravando") : b.kind === "pause" ? t("pausado") : "Loro";
  $("icon").setAttribute("aria-label", label);
  return b;
}

function statusText(b) {
  if (st.rec === "recording") return t("gravando") + " · " + b.time;
  if (st.rec === "paused") return t("pausado") + " · " + b.time;
  if (st.rec === "starting") return t("iniciando…");
  if (st.rec === "stopping") return t("encerrando…");
  return t("pronto para gravar");
}

function paintTemas() {
  const sel = $("bTema");
  if (sel === document.activeElement || $("bNovaIdeia") === document.activeElement) return;
  const want = sel.value === NOVA ? NOVA : (st.rec !== "idle" && st.tema) || st.destino || "";
  sel.textContent = "";
  for (const tm of st.temas || []) {
    const o = document.createElement("option");
    o.value = tm.slug; o.textContent = tm.nome || tm.slug;
    sel.appendChild(o);
  }
  const nova = document.createElement("option");
  nova.value = NOVA; nova.textContent = t("+ nova ideia…");
  sel.appendChild(nova);
  if (!st.temas || !st.temas.length) sel.value = NOVA;
  else if (want && [...sel.options].some((o) => o.value === want)) sel.value = want;
  $("bNovaIdeia").hidden = sel.value !== NOVA;
  // during a recording the destination is the meeting's: changing it would
  // promise a move that does not happen
  sel.disabled = st.rec !== "idle";
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

const hhmm = (ms) => {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
};
function paintAgenda() {
  const ul = $("bAgenda");
  ul.textContent = "";
  const ag = st.agenda || { status: "missing", eventos: [] };
  for (const e of ag.eventos || []) {
    const li = document.createElement("li");
    const h = document.createElement("span");
    h.className = "hora"; h.textContent = hhmm(e.inicioMs);
    const tit = document.createElement("span");
    tit.className = "tit"; tit.textContent = e.titulo || t("(sem título)"); tit.title = tit.textContent;
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = !!e.agendada;
    cb.addEventListener("change", () => {
      const tema = chosenTema() || st.destino || "";
      if (cb.checked && !tema) {
        cb.checked = false;
        $("bAviso").textContent = t("escolha ou nomeie uma ideia");
        return;
      }
      send("schedule", { id: e.id, on: cb.checked, tema });
    });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(t("gravar")));
    li.append(h, tit, lab);
    ul.appendChild(li);
  }
  const nota = $("bAgendaNota");
  if (ag.status === "missing" || ag.status === "stale" || ag.status === "invalid") nota.textContent = t("agenda não atualizada");
  else if (!(ag.eventos || []).length) nota.textContent = t("nenhuma reunião pela frente hoje");
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
    b.className = "btn" + (primary ? " primary" : "");
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
  $("bStatus").textContent = statusText(b);
  $("bSub").textContent = st.rec !== "idle" ? (st.titulo || "") : "";
  paintTemas();
  paintControls();
  paintTail();
  paintAgenda();
}

listen("bubble-state", (e) => {
  st = Object.assign({}, st, (e && e.payload) || {});
  applyLang(st.lang);
  paintPrompt();
  paint();
});

// The clock only re-reads a number; the dot and the glyph never change state
// on their own (no blinking, ADR-0041 §2).
setInterval(() => { const b = paintBadge(); if (open) $("bStatus").textContent = statusText(b); }, 1000);

// Ask the main window for the current state: it may have started before us.
send("hello");
