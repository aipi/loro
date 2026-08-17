// Loro — lógica da janela principal.
// Usa só o global window.__TAURI__ (core.invoke + event.listen + window),
// sem pacotes npm de plugin. O áudio/texto nunca sai da máquina.

const TAURI = window.__TAURI__ || {};
const invoke = TAURI.core ? TAURI.core.invoke : async () => { throw new Error("Tauri unavailable"); };
const listen = TAURI.event ? TAURI.event.listen : async () => {};
const getWin = TAURI.window ? TAURI.window.getCurrentWindow : null;
const { esc, mdInline, mdRender, mergeSettings } = window.LoroText;
// plataforma reportada pelo doctor ("macos" | "windows" | "linux"); guia o setup
// e o áudio do sistema, que mudam por SO (ADR-0012)
let hostOs = "macos";
// ADR-0009 — reference/front-matter helpers (pure, dependency-free, no bundler).
const R = window.LoroRefs || {};
// ADR-0010 — pure meeting-path helpers (id parsing, marker strip, base join).
const LM = window.LoroMeeting || {};

// log de diagnóstico (vai para loro-client.log via backend) + console
const winLabel = getWin ? (getWin().label || "?") : "?";
function clog(m) { try { invoke("client_log", { msg: `[ui:${winLabel}] ${m}` }); } catch (_) {} console.log(m); }
window.addEventListener("error", (e) => clog(`error: ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => clog(`unhandled rejection: ${e.reason}`));

const $ = (id) => document.getElementById(id);
const el = {
  dot: $("dot"), timer: $("timer"), cfgBtn: $("cfgBtn"), privacy: $("privacy"),
  surface: $("surface"), empty: $("empty"), doc: $("doc"),
  wave: $("wave"), toggle: $("toggleBtn"), savebar: $("savebar"),
  saveBtn: $("saveBtn"), exportBtn: $("exportBtn"), discardBtn: $("discardBtn"),
  cfgPop: $("cfgPop"), toast: $("toast"), srLive: $("srLive"),
  optScroll: $("optScroll"), optTop: $("optTop"), optOverlay: $("optOverlay"),
  optDiar: $("optDiar"), clearBtn: $("clearBtn"),
  model: $("model"), lang: $("lang"), translate: $("translate"),
  autosave: $("autosave"), pickDir: $("pickDir"), source: $("source"), mode: $("mode"),
  liveCollapse: $("liveCollapse"), uiLang: $("uiLang"),
  modelManager: $("modelManager"),
};

// ---- i18n da interface (pt/en) ----
// Gettext-style (src/i18n.js): the pt-BR string in the code is the msgid.
// Static HTML is translated in place: [data-i18n] marks a text node and
// [data-i18n-attrs="title,placeholder"] marks attributes; the original pt
// value is captured on first pass so switching back is lossless.
// `data-i18n-dyn` marks a node whose text is written at RUNTIME by a painter
// (the privacy seal, the dependency banner, the gh badge, the modal title).
// applyI18n freezes a node's msgid on the first pass and rewrites it on every
// language switch, so it was overwriting live state with the boot label — the
// privacy seal went back to "sem guardar áudio", red .warn still applied, while
// audio was being written to disk (BR-8). Whoever owns the text at runtime also
// owns it across a language switch, from rerenderForLang.
const { t, tErr, setLang: setI18nLang } = window.LoroI18n;
function applyI18n() {
  setI18nLang(settings.uiLang);
  document.documentElement.setAttribute("lang", settings.uiLang === "en" ? "en" : "pt-br");
  document.querySelectorAll("[data-i18n]").forEach((n) => {
    if (n.dataset.i18nDyn !== undefined) return;
    if (!n.dataset.i18nSrc) n.dataset.i18nSrc = n.textContent.trim();
    n.textContent = t(n.dataset.i18nSrc);
  });
  document.querySelectorAll("[data-i18n-attrs]").forEach((n) => {
    // N1 · a lista se separava só por vírgula, e um espaço no lugar dela virava
    // UM token com espaço dentro: a chave de dataset derivada pedia ao DOM o
    // atributo `data-i18n-src-aria-label title`, que não é um nome válido —
    // setAttribute lançava no init, applySettings() abortava e a janela nascia
    // em branco. Uma convenção de separador nossa não pode derrubar o app: os
    // dois separadores valem, e um token que não nomeie um atributo do elemento
    // é ignorado (o teste tests/boot.test.js é que reclama dele).
    for (const attr of n.dataset.i18nAttrs.split(/[,\s]+/)) {
      const a = attr.trim();
      if (!a || !/^[A-Za-z_:][A-Za-z0-9._:-]*$/.test(a)) continue;
      // dataset keys must be camelCase — "aria-label" → i18nSrcAriaLabel
      const src = `i18nSrc${a.replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase())}`;
      if (!n.dataset[src]) n.dataset[src] = n.getAttribute(a) || "";
      if (n.dataset[src]) n.setAttribute(a, t(n.dataset[src]));
    }
  });
}
// Dynamic surfaces hold rendered pt/en text, so a language switch re-renders
// them from state (static HTML is handled by applyI18n alone).
// UI-language-driven date/number locale (the only i18n helper besides t/tErr).
const uiLocale = () => (settings.uiLang === "en" ? "en-US" : "pt-BR");
function rerenderForLang() {
  try { render(); } catch (_) {}
  try { updateCfgLabel(); } catch (_) {}
  // R11 · a lateral é desenhada por innerHTML atrás de DUAS assinaturas de cache
  // (sideSig, pessoalSig) construídas a partir do estado do projeto — e o idioma
  // não faz parte desse estado. Trocar de idioma deixava a árvore em inglês ao
  // lado de cabeçalhos em português, até um poll qualquer mudar a assinatura por
  // outro motivo. Zerar as duas AQUI é o que faz o repintar acontecer.
  // (toolsSig é a mesma doença: os rótulos das habilidades também são traduzidos)
  sideSig = ""; pessoalSig = ""; toolsSig = "";
  // ADR-0027 · o destino Revisão é innerHTML atrás das MESMAS assinaturas de
  // cache, pela mesma razão e com a mesma cura: o idioma não faz parte do estado
  // que as monta, então sem zerá-las metade da tela ficaria no idioma anterior.
  try { REV.sig = ""; REV.teamSig = ""; } catch (_) {}
  try { brainRefresh(); } catch (_) {}
  try { paintSideToggle(); } catch (_) {}
  try { paintTermSideBtn(); } catch (_) {}
  try { paintPanelTermPlaceholder(); } catch (_) {}
  try { renderSelectionBar(); } catch (_) {}
  try { refreshTabFromDisk(MANUAL_REL); } catch (_) {} // manual follows uiLang
  // O documento aberto e o painel direito ("COM ESTE DOCUMENTO", as habilidades,
  // o selo versionado/rascunho) são desenhados em innerHTML por renderActive:
  // sem esta linha, escolher inglês deixava metade da tela em português até o
  // usuário clicar em outra aba. renderActive é serializado por geração, então
  // a chamada re-entrante é segura.
  try { renderActive(); } catch (_) {}
  // os nós data-i18n-dyn: quem escreve em tempo de execução também traduz
  try { updatePrivacy(); } catch (_) {}
  try { paintRecControl(); } catch (_) {}
  try { paintSetupBanner(); } catch (_) {}
  try { renderGhCard(); } catch (_) {}
  try { if (REV.openNum) renderReviewDetail(REV.openNum); } catch (_) {}
  // o destino Revisão é desenhado em innerHTML e tem nós data-i18n-dyn (o chip do
  // rascunho, a frase de abertura, a nota do preço): as assinaturas são limpas
  // porque um idioma novo não muda o FATO, e sem isso o repintar seria engolido
  try { REV.sig = ""; REV.teamSig = ""; renderDestReview(); } catch (_) {}
  try { paintChatMode(); } catch (_) {}
  try { paintAutoContextHint(); } catch (_) {}
  // C4 · o painel do chat é pintado por innerHTML FORA de renderActive: depois
  // de escolher inglês, o chip seguia dizendo "perguntar ao acervo" ao lado de um
  // menu já em inglês — a mesma habilidade, duas vezes, em dois idiomas. As
  // linhas de modelo em Configurações tinham a mesma doença.
  try { renderChatChips(); } catch (_) {}
  try { paintChatEmpty(); } catch (_) {}
  try { refreshModelManager(); } catch (_) {}
}

// A gravação é uma VISTA do corpo (redesign 1f), irmã dos destinos e do
// documento — não mais um dock que sobe do rodapé. Abri-la esconde as outras.
function setLivePanel(open) {
  el.surface.hidden = !open;
  if (open) {
    B.home.hidden = true;
    B.docWrap.hidden = true;
  } else if (B.docWrap.hidden) {
    B.home.hidden = false;
  }
  paintRecordingChrome();
}

const state = {
  running: false, autoscroll: true, recordForDiarize: false, fileMode: false,
  meetingMode: false,
  lines: [], startTime: 0, timerId: null,
  // pausa de reunião: o relógio desconta o tempo pausado (pausedMs acumulado;
  // pauseStart marca a pausa corrente) — as duas linhas do tempo (mic e sistema)
  // excluem a pausa igualmente, então continuam alinhadas.
  paused: false, pausedMs: 0, pauseStart: 0,
};

// ADR-0010 — the meeting lifecycle (record-then-transcribe). Distinct from the
// flat-file/live state: `active` gates the meeting-aware transcript-line and
// transcribe-state handlers, `phase` mirrors manifest.status, and transcript
// lines are accumulated then persisted below the marker via brain_meeting_append.
const meeting = {
  active: false, id: null, dir: null, livingRel: null, tema: null,
  phase: null, pendingLines: [], flushTimer: null,
  // ADR-0025: o t=0 da reunião, em epoch — dito pelo backend, tomado imediatamente
  // antes de a captura subir. As DUAS trilhas convertem para ele (LM.sysBlockMs /
  // LM.micBlockMs), então param de ter relógios diferentes. `segPausedMs` é o total
  // pausado quando o segmento de captura corrente começou; `sysAnchor` é o t=0 do
  // WAV desse segmento, relatado pelo sidecar.
  originEpoch: null, segPausedMs: 0, sysAnchor: null,
  // ADR-0012 pseudo-stream: a best-effort tail-transcription interval fills the
  // living surface WHILE recording. `tailFrom` is the next window offset (ms)
  // INTO THE CURRENT capture segment (resume opens a new WAV, so offsets restart
  // at zero — the segment's place on the meeting timeline comes from `sysAnchor`).
  tailTimer: null, tailFrom: 0, tailBusy: false, tailStatus: "",
  tailFlush: null,   // promessa do tick em voo (pausar/encerrar esperam por ela)
  // ADR-0012 model A: a rotating mic recorder — each ~N s segment is transcribed
  // and appended live, so the OPERATOR's speech shows in the stream (the system
  // tail above only covers the other participants). Audio is transient.
  previewRec: null, previewChunks: [], previewTimer: null,
  // últimos trechos appendados (mic e sistema), para detectar o vazamento de uma
  // trilha na outra quando o som sai por alto-falante (LM.micLeakOfSystem).
  appended: [],
  // ADR-0025: o dono da junção. As duas trilhas não são mais dois appendadores
  // correndo pelo mesmo arquivo — a de sistema escreve na hora (nunca é
  // descartada) e a do microfone só é resolvida quando a de sistema já foi ouvida
  // até o fim daquele segmento. Um por reunião (LM.coverageGate).
  gate: null,
};

// ---- configurações persistidas (localStorage) ----
const SETTINGS_KEY = "loro-settings";
const DEFAULTS = {
  model: "large-v3-turbo", lang: "pt", translate: false,
  autoscroll: true, autosave: false, saveDir: "", source: "mic", mode: "live", uiLang: "pt", termSide: true,
  sideW: 0, // sidebar width in px; 0 = the default CSS clamp (ADR-0002 §6)
  welcomeSeen: false, // first-launch feature tour (reopen via palette)
  // redesign (handoff §State Management): o cromo é estado persistido
  theme: "system",            // claro | escuro | sistema
  sidebarCollapsed: false,    // 250px ⇄ 60px
  aiPanelOpen: true,          // painel direito (toggle ✦ IA)
  aiPanelTab: "doc",          // doc | chat | term
  panelW: 0,                  // largura do painel direito em px; 0 = padrão (330)
  termH: 0,                   // altura da doca do terminal em px; 0 = padrão (34vh)
  chatModel: "sonnet",        // modelo e esforço do chat (um controle só)
  chatEffort: "alto",
  // onde uma ação de IA roda: no chat (resposta na conversa) ou no terminal
  actionMode: "chat",
  // o que o chat pode fazer sem perguntar. Em modo -p o agente NÃO tem como
  // perguntar, então "acceptEdits" é o mínimo para ele conseguir agir.
  chatPermission: "acceptEdits",
  // seções da lateral recolhidas (ideas | organize | knowledge)
  sideClosed: [],
  // Cancelamento de eco do microfone. Desligado por padrão: ligá-lo entrega o
  // microfone ao processamento de voz do macOS, que abafa a saída da máquina
  // inteira e achata a voz (ADR-0022 §24). Só faz sentido para quem ouve por
  // alto-falante e precisa que o microfone NÃO escute os outros de volta.
  micEchoCancel: false,
};
let settings = { ...DEFAULTS };
function loadSettings() {
  try { settings = mergeSettings(DEFAULTS, JSON.parse(localStorage.getItem(SETTINGS_KEY))); }
  catch (_) { settings = { ...DEFAULTS }; }
}
function persistSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
}
function applySettings() {
  el.model.value = settings.model;
  el.lang.value = settings.lang;
  el.translate.checked = settings.translate;
  el.optScroll.checked = settings.autoscroll;
  { const ec = $("optEchoCancel"); if (ec) ec.checked = !!settings.micEchoCancel; }
  el.autosave.checked = settings.autosave;
  paintSourceSelectors();
  el.mode.value = settings.mode;
  state.autoscroll = settings.autoscroll;
  el.pickDir.textContent = settings.saveDir || "…";
  el.pickDir.title = settings.saveDir || t("Escolher pasta de armazenamento");
  if (el.uiLang) el.uiLang.value = settings.uiLang;
  applySideWidth();
  applyChrome();
  applyI18n();
  // o rótulo do ● é escrito em tempo de execução (R4): quem reaplica o cromo
  // também o traduz — no boot em inglês ele ficaria com o msgid do HTML
  paintRecControl();
}

// redesign: tema, barra lateral e painel direito são estado de interface
// persistido — reaplicados juntos para o casco nunca ficar meio-aplicado.
function applyChrome() {
  const S = window.LoroShell;
  if (!S) return;
  applyPanelWidth();
  applyTermHeight();
  applySideSections();
  paintActionMode();
  S.setTheme(settings.theme);
  S.setSidebarCollapsed(settings.sidebarCollapsed);
  // o nome do alternador acompanha o estado restaurado (uma lateral que abre
  // recolhida não pode oferecer "recolher")
  paintSideToggle();
  S.setPanelOpen(settings.aiPanelOpen);
  S.setPanelTab(settings.aiPanelTab);
  document.querySelectorAll("#modeSeg .segbtn").forEach((b) =>
    b.classList.toggle("on", b.dataset.mode === settings.mode));
}

// ADR-0002 §6 — sidebar width: 0 keeps the CSS clamp default; any px value is
// user-chosen (drag grip), clamped to [180, 45vw]. Wide sidebars reveal the
// per-row metadata line (.bmeta).
const SIDE_WIDE_AT = 300;
// N26 · os dois tetos de arrasto somavam 105vw (45vw + 60vw) e NADA re-limitava
// na aplicação nem no resize: uma largura guardada num monitor externo reabria
// numa janela menor com a coluna de conteúdo em 0px, a lateral cortada e o painel
// desenhado fora da janela — um estado quebrado que sobrevive ao restart
// (DESIGN.md §2 regra 9 e §7). Decisão pura, em px da janela atual.
const SIDE_MIN = 180, SIDE_DEFAULT = 250, PANEL_DEFAULT = 330, CONTENT_MIN = 400, TERM_MIN = 120;
function clampPanes(winW, winH, s) {
  const open = !!s.aiPanelOpen;
  let sideW = s.sideW || 0, panelW = s.panelW || 0, termH = s.termH || 0;
  // sempre para BAIXO: arredondar para cima devolvia meio pixel além do teto, e um
  // teto que o valor aplicado ultrapassa não é um teto
  if (panelW) {
    const room = winW - CONTENT_MIN - (sideW || SIDE_DEFAULT);
    panelW = Math.floor(Math.min(Math.max(panelW, PANEL_MIN), Math.max(PANEL_MIN, Math.min(winW * 0.6, room))));
  }
  if (sideW) {
    const room = winW - CONTENT_MIN - (open ? (panelW || PANEL_DEFAULT) : 0);
    sideW = Math.floor(Math.min(Math.max(sideW, SIDE_MIN), Math.max(SIDE_MIN, Math.min(winW * 0.45, room))));
  }
  if (termH) termH = Math.floor(Math.min(Math.max(termH, TERM_MIN), winH * 0.75));
  return { sideW, panelW, termH };
}
function reclampPanes() {
  const c = clampPanes(window.innerWidth, window.innerHeight, settings);
  settings.sideW = c.sideW; settings.panelW = c.panelW; settings.termH = c.termH;
  return c;
}
function applySideWidth() {
  reclampPanes();
  const root = document.documentElement;
  if (settings.sideW) root.style.setProperty("--side-w", settings.sideW + "px");
  else root.style.removeProperty("--side-w");
  const side = document.querySelector(".bside");
  if (side) side.classList.toggle("wide", (settings.sideW || 0) >= SIDE_WIDE_AT);
}
(function wireSideGrip() {
  const grip = $("sideGrip");
  if (!grip) return;
  grip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    grip.classList.add("dragging");
    const side = document.querySelector(".bside");
    const left = side ? side.getBoundingClientRect().left : 0;
    const onMove = (ev) => {
      const w = Math.round(Math.min(Math.max(ev.clientX - left, 180), window.innerWidth * 0.45));
      settings.sideW = w;
      applySideWidth();
    };
    const onUp = () => {
      grip.classList.remove("dragging");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      persistSettings();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  // double-click resets to the default clamp width
  grip.addEventListener("dblclick", () => { settings.sideW = 0; persistSettings(); applySideWidth(); });
})();

// ---- colunas laterais redimensionáveis (ADR-0021) ---------------------------
// A árvore já era arrastável; o painel direito e a doca do terminal passam a
// ser também. Um gesto só, um helper só: arrasta → aplica → persiste; duplo
// clique volta ao padrão. Enquanto arrasta, o corpo ganha `.resizing` para que
// o xterm e os canvas não engulam o ponteiro no meio do movimento.
function wireGrip(grip, opts) {
  if (!grip) return;
  grip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    grip.classList.add("dragging");
    document.body.classList.add("resizing");
    if (opts.vertical) document.body.classList.add("rowwise");
    const onMove = (ev) => opts.onDrag(ev);
    const onUp = () => {
      grip.classList.remove("dragging");
      document.body.classList.remove("resizing", "rowwise");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      persistSettings();
      if (opts.after) opts.after();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  grip.addEventListener("dblclick", () => {
    opts.reset();
    persistSettings();
    if (opts.after) opts.after();
  });
}

// Painel direito: 0 = os 330px do design. O piso era 260px "onde as três abas
// ainda cabem" — medido na janela real, não cabiam: a faixa pedia 308px, tinha
// 259px e jogava a aba Terminal para fora da janela, fazendo o <body> rolar na
// horizontal (proibido pelo DESIGN.md §7). O piso agora é a largura em que as
// três abas cabem de fato; a própria faixa também rola por dentro, para que
// nenhuma largura futura volte a empurrar a página.
const PANEL_MIN = 300;
function applyPanelWidth() {
  const root = document.documentElement;
  // O piso E o teto valem na aplicação, não só no arrasto: uma largura guardada
  // antes de o piso subir (ou numa janela maior) continuava em vigor.
  reclampPanes();
  if (settings.panelW) root.style.setProperty("--panel-w", settings.panelW + "px");
  else root.style.removeProperty("--panel-w");
  const grip = $("aiGrip");
  // a alça só existe onde o painel existe: abaixo do ponto de quebra ela ficava
  // pintada em cima da coluna de conteúdo, arrastando um painel invisível (N24)
  if (grip) grip.hidden = !settings.aiPanelOpen || !panelRendered();
}
// N24 · o painel direito pode não ser DESENHADO (a folha de estilo o retira em
// janelas estreitas). Quem pergunta é a geometria real, não um ponto de quebra
// copiado no JS: se amanhã o CSS voltar a desenhá-lo, nada aqui precisa mudar.
function panelRendered() {
  const p = $("aiPanel");
  if (!p || p.hidden) return false;
  if (!p.getBoundingClientRect) return true;
  return p.getBoundingClientRect().width > 0;
}
// aberto e ainda assim sem caixa = a folha de estilo o retirou nesta largura
function panelDropped() {
  const p = $("aiPanel");
  return !!p && !p.hidden && !panelRendered();
}
// e, quando não é desenhado, a interface diz — em vez de deixar o botão "aberto"
// e o clique sem resposta
function panelUnavailable() {
  toast(t("o painel ✦ IA não cabe nesta largura — alargue a janela"), 5000);
  const btn = $("aiPanelBtn");
  if (btn) { btn.classList.remove("on"); btn.setAttribute("aria-expanded", "false"); }
}
// Doca do terminal: só existe quando o terminal está embaixo (⇆).
function applyTermHeight() {
  reclampPanes();
  const root = document.documentElement;
  if (settings.termH) root.style.setProperty("--term-h", settings.termH + "px");
  else root.style.removeProperty("--term-h");
  const dock = $("termDock"), grip = $("termGrip");
  if (grip) grip.hidden = !dock || dock.hidden;
}
wireGrip($("aiGrip"), {
  onDrag: (ev) => {
    const w = Math.round(Math.min(Math.max(window.innerWidth - ev.clientX, PANEL_MIN), window.innerWidth * 0.6));
    settings.panelW = w;
    applyPanelWidth();
  },
  reset: () => { settings.panelW = 0; applyPanelWidth(); },
  after: () => requestAnimationFrame(fitTerm),
});
wireGrip($("termGrip"), {
  vertical: true,
  onDrag: (ev) => {
    const dock = $("termDock");
    if (!dock) return;
    const bottom = dock.getBoundingClientRect().bottom;
    settings.termH = Math.round(Math.min(Math.max(bottom - ev.clientY, 120), window.innerHeight * 0.75));
    applyTermHeight();
    fitTerm();
  },
  reset: () => { settings.termH = 0; applyTermHeight(); },
  after: () => requestAnimationFrame(fitTerm),
});

// ---- render ----
function render() {
  el.doc.innerHTML = state.lines.map((t) => `<p>${mdInline(esc(t))}</p>`).join("");
  const last = el.doc.lastElementChild;
  if (last) last.classList.add("new");
  const has = state.lines.length > 0;
  el.doc.hidden = !has;
  el.empty.hidden = has;
  // o rolador é a coluna da transcrição, não a vista inteira (o rodapé com a
  // onda e o selo de privacidade é fixo — 1f)
  const sc = el.surface.querySelector(".recscroll");
  if (state.autoscroll && sc) sc.scrollTop = sc.scrollHeight;
}
function appendLine(text) { state.lines.push(text); render(); }

// F6 · WCAG 4.1.3 — o app tem UMA região viva (#srLive) e um único ponto que
// fala nela. Ela é lida e não vista: o que aparece na tela continua sendo o
// toast, o indicador do chat e o relógio, então dar voz ao app não acrescenta
// cromo nenhum (a anatomia da DESIGN.md §2 é inviolável).
// O que NÃO passa por aqui: o relógio da gravação (falaria uma vez por segundo)
// e os deltas do chat (falariam a resposta letra por letra). Transições, sim.
function announce(msg) {
  const r = el.srLive;
  if (!r || !msg) return;
  r.textContent = String(msg);
}

// N8/N10 · um nó que ganhou role="button" tem de responder como botão: Enter e
// Espaço. Sem isto a linha é anunciada como controle e não se ativa pelo teclado
// (WCAG 2.1.1) — foi o caso do seletor de rascunho e das marcas de anotação.
function wireActivateKeys(node) {
  if (!node) return node;
  node.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    e.preventDefault();
    if (typeof node.onclick === "function") node.onclick(e);
  });
  return node;
}

// Um toast é o único canal de sucesso/erro do app (DESIGN.md §5): sem região
// viva, uma recusa é indistinguível da ação não ter feito nada.
// A ORDEM importa: uma região viva só é lida quando o texto muda com ela na
// árvore — escrever e só então revelar não anuncia nada.
function toast(msg, ms = 2600) {
  el.toast.hidden = false;
  el.toast.textContent = msg;
  announce(msg);
  clearTimeout(toast._t);
  if (ms) toast._t = setTimeout(() => (el.toast.hidden = true), ms);
  else addToastDismiss();
}
// R15/R23 · Um toast SEM prazo (uma recusa que o usuário precisa ler inteira, um
// trabalho longo em curso) não tinha como sair da tela: sem ×, sem Escape e sem
// clique, a recusa da Gravação de Tela ficou minutos por cima do card do
// documento, em todos os destinos, dizendo "tente de novo" muito depois da
// tentativa. DESIGN.md §5: nenhum cromo permanente entra no layout — quem não tem
// prazo tem porta de saída. O Escape mora no ouvinte da pilha de camadas: uma
// folha aberta é a camada do topo e responde primeiro.
function addToastDismiss() {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "toastbtn toastclose";
  b.textContent = "×";
  b.title = t("fechar aviso");
  b.setAttribute("aria-label", t("fechar aviso"));
  b.onclick = clearToast;
  el.toast.appendChild(b);
}
// Retira um toast ainda no ar. Serve a um caso só: o pedido SAIU (o agente subiu)
// e o turno morreu logo depois — a autenticação, que só se revela no chat-done.
// O "enviada" continua sendo verdade no instante em que foi dito, mas não pode
// ficar na tela ao lado de "nada foi enviado" (DESIGN.md §1).
function clearToast() {
  clearTimeout(toast._t);
  el.toast.hidden = true;
}

// ADR-0018 · AC-5 — um toast que carrega ações. É o empurrãozinho: some sozinho
// como qualquer toast (nenhum cromo permanente entra no layout), e clicar numa
// ação a executa e fecha. Dispensar é não clicar em nada.
function toastAction(msg, actions, ms = 12000) {
  clearTimeout(toast._t);
  el.toast.hidden = false;   // a região viva precisa existir antes do texto
  el.toast.textContent = "";
  announce(msg);
  const span = document.createElement("span");
  span.textContent = msg;
  el.toast.appendChild(span);
  for (const a of actions || []) {
    const b = document.createElement("button");
    b.className = "toastbtn";
    b.textContent = a.label;
    b.onclick = () => { el.toast.hidden = true; clearTimeout(toast._t); a.run(); };
    el.toast.appendChild(b);
  }
  if (ms) toast._t = setTimeout(() => (el.toast.hidden = true), ms);
}

// ---- timer ----
function fmt(s) {
  const m = Math.floor(s / 60), r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}
// tempo gravado de fato: exclui as pausas; congela enquanto pausado
function elapsedActiveMs() {
  if (!state.startTime) return 0;
  const now = state.paused ? state.pauseStart : Date.now();
  return Math.max(0, now - state.startTime - state.pausedMs);
}
// ADR-0025: `originEpoch` deixa o relógio começar onde a GRAVAÇÃO começou, não onde
// a interface se pintou. Numa reunião a captura de sistema já está rodando antes
// disso (poll de permissão de tela + espera do microfone + abrir a aba), e era essa
// diferença que punha as duas trilhas em tempos distintos. O cronômetro, os
// marcadores e o transcript passam a ler o mesmo relógio.
function startTimer(originEpoch) {
  state.startTime = originEpoch || Date.now();
  state.paused = false; state.pausedMs = 0; state.pauseStart = 0;
  paintElapsed(); // do relógio real: com uma origem no passado, 00:00 seria mentira
  state.timerId = setInterval(() => paintElapsed(), 1000);
}
// C1 · o tempo decorrido aparece em DOIS lugares — o rodapé e a aba da reunião.
// renderTabs escrevia o relógio da aba UMA vez (no valor que ele tinha quando a
// aba nasceu), então a aba ficava em 00:00 pela reunião inteira enquanto o rodapé
// contava. Um pintor só escreve os dois: o mesmo relógio não pode ter duas
// leituras (DESIGN.md §1).
function paintElapsed(text) {
  const now = typeof text === "string" ? text : fmt(Math.floor(elapsedActiveMs() / 1000));
  el.timer.textContent = now;
  B.wsTabs.querySelectorAll(".wstime").forEach((n) => { n.textContent = now; });
}
function stopTimer() { clearInterval(state.timerId); state.timerId = null; }

// ---- indicador de áudio (onda) — best-effort, nunca bloqueia o start ----
let audio = { stream: null, ctx: null, analyser: null, raf: null, recorder: null, chunks: [], mime: "" };
const wctx = el.wave.getContext("2d");
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function resizeWave() {
  // oculto (aba acervo): medir agora zeraria o bitmap — ignora;
  // o switchTab re-mede ao voltar pra "ao vivo"
  if (el.wave.clientWidth === 0) return;
  const dpr = window.devicePixelRatio || 1;
  el.wave.width = el.wave.clientWidth * dpr;
  el.wave.height = el.wave.clientHeight * dpr;
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // mudar o bitmap limpa o canvas: redesenha o estado parado
  // (gravando, o próximo frame do drawLoop repinta sozinho)
  if (!audio.analyser) drawIdle();
}
window.addEventListener("resize", resizeWave);

function drawIdle() {
  const w = el.wave.clientWidth, h = el.wave.clientHeight;
  wctx.clearRect(0, 0, w, h);
  wctx.strokeStyle = cssVar("--line"); wctx.lineWidth = 1; wctx.setLineDash([2, 4]);
  wctx.beginPath(); wctx.moveTo(0, h / 2); wctx.lineTo(w, h / 2); wctx.stroke();
  wctx.setLineDash([]);
}

// gradiente de "plumagem" (teal -> amarelo -> vermelho): o Loro se acende ao ouvir
function featherGradient(w) {
  const g = wctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, cssVar("--teal"));
  g.addColorStop(0.55, cssVar("--yellow"));
  g.addColorStop(1, cssVar("--red"));
  return g;
}

function drawLoop() {
  const buf = new Uint8Array(audio.analyser.fftSize);
  const tick = () => {
    if (!audio.analyser) return;
    const w = el.wave.clientWidth, h = el.wave.clientHeight;
    audio.analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
    const level = Math.min(1, peak / 90);
    const speaking = level > 0.12;
    wctx.clearRect(0, 0, w, h);
    wctx.lineWidth = speaking ? 1.8 : 1.4;
    // onda colorida (plumagem) ao detectar fala; cinza enquanto só ouve
    wctx.strokeStyle = speaking ? featherGradient(w) : cssVar("--muted");
    wctx.globalAlpha = speaking ? Math.max(0.65, level) : 0.45;
    wctx.beginPath();
    for (let i = 0; i < buf.length; i++) {
      const x = (i / buf.length) * w, y = (buf[i] / 255) * h;
      i === 0 ? wctx.moveTo(x, y) : wctx.lineTo(x, y);
    }
    wctx.stroke(); wctx.globalAlpha = 1;
    audio.raf = requestAnimationFrame(tick);
  };
  tick();
}

// deviceLabel: p/ áudio do sistema, casa o dispositivo de loopback da plataforma
async function startAudio(deviceLabel) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    clog("getUserMedia unavailable — no audio meter"); setMeter("off"); return;
  }
  // LoroAudio.micConstraints: dispositivo CRU, sem o processamento de voz do
  // sistema — ele derruba o volume da sua voz e abafa a saída da máquina toda
  // (ver o comentário em audio.js), e a transcrição também quer o sinal cru.
  let constraints = LoroAudio.micConstraints(null, settings.micEchoCancel);
  if (deviceLabel) {
    try {
      // os labels de enumerateDevices só aparecem após uma permissão de áudio:
      // fazemos um "priming" e paramos o stream antes de casar o dispositivo certo
      let devs = await navigator.mediaDevices.enumerateDevices();
      if (!devs.some((x) => x.kind === "audioinput" && x.label)) {
        const prime = await navigator.mediaDevices.getUserMedia(LoroAudio.micConstraints(null, settings.micEchoCancel));
        prime.getTracks().forEach((t) => t.stop());
        devs = await navigator.mediaDevices.enumerateDevices();
      }
      const d = devs.find((x) => x.kind === "audioinput" && new RegExp(deviceLabel, "i").test(x.label));
      if (d && d.deviceId) constraints = LoroAudio.micConstraints(d.deviceId, settings.micEchoCancel);
      else {
        clog("meter: input '" + deviceLabel + "' not found — no wave");
        setMeter("nosignal"); return;
      }
    } catch (e) { clog("enumerateDevices error: " + e); setMeter("off"); return; }
  }
  audio.stream = await navigator.mediaDevices.getUserMedia(constraints);
  setMeter(meterKind({ source: settings.source, deviceLabel, paused: state.paused }));
  audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
  audio.analyser = audio.ctx.createAnalyser();
  audio.analyser.fftSize = 1024;
  audio.ctx.createMediaStreamSource(audio.stream).connect(audio.analyser);
  // ADR-0012 model A: a MEETING does NOT use the continuous mic recorder — the
  // transcript is built live from the rotating preview segments + the system tail,
  // and audio is transient. Running a second continuous MediaRecorder on the same
  // stream made WKWebView fire the main recorder's onstop when a preview segment
  // rotated, finalizing the meeting on its own. So only diarize/file modes record.
  if (state.recordForDiarize || state.fileMode) {
    audio.chunks = [];
    audio.recorder = new MediaRecorder(audio.stream);
    audio.mime = audio.recorder.mimeType || "audio/webm";
    audio.recorder.ondataavailable = (e) => { if (e.data.size) audio.chunks.push(e.data); };
    audio.recorder.onstop = state.fileMode ? finalizeFileTranscription : finalizeRecording;
    audio.recorder.start();
  }
  drawLoop();
  clog("audio meter active");
}
// indicador funcional da captura: mic / sistema / pausado / sem sinal / desligado
function setMeter(kind) {
  if (!el.privacy) return;
  const map = {
    mic: ["● mic", t("captando microfone")],
    system: [`● ${t("sistema")}`, t("captando áudio do computador")],
    meeting: [`● ${t("reunião")}`, t("captando sua voz + áudio do computador (Loro Reunião)")],
    // ADR-0022 §19 · pausar para a captura DE VERDADE. O selo continuava em
    // "● mic / captando microfone" ao lado de "nada está sendo gravado": este é o
    // indicador de privacidade (BR-8), a única afirmação que tem de ser exata.
    paused: [`⏸ ${t("pausada")}`, t("reunião pausada — nada está sendo gravado")],
    // o tooltip não cita comando: o caminho de configuração muda por SO (ADR-0012)
    nosignal: [t("sem sinal"), t("não achei o dispositivo de captura — configure o áudio do sistema")],
    off: [t("gravando"), t("gravando")],
  };
  const [txt, title] = map[kind] || map.off;
  el.privacy.textContent = txt;
  el.privacy.title = title;
  el.privacy.dataset.meter = kind;
}
// O que o selo está descrevendo. Pura, e o único lugar que decide: a captura
// (startAudio) e a pausa/retomada liam a mesma regra de dois jeitos, e a pausa
// simplesmente não repintava.
function meterKind({ source, deviceLabel, paused }) {
  if (paused) return "paused";
  if (source === "meeting") return "meeting";
  return deviceLabel ? "system" : "mic";
}
// Repinta o selo a partir do estado atual — texto, tooltip E o vermelho que diz
// "o áudio está indo para o disco", que também mente enquanto nada é gravado.
function paintCaptureMeter() {
  const kind = meterKind({ source: settings.source, deviceLabel: meterLabelFor(settings.source), paused: state.paused });
  setMeter(kind);
  if (el.privacy) el.privacy.classList.toggle("warn", kind !== "paused" && audioGoesToDisk());
}
function stopAudio() {
  if (audio.raf) cancelAnimationFrame(audio.raf);
  audio.raf = null;
  if (audio.recorder && audio.recorder.state !== "inactive") audio.recorder.stop();
  else audio.recorder = null;
  if (audio.ctx) audio.ctx.close();
  if (audio.stream) audio.stream.getTracks().forEach((t) => t.stop());
  audio.stream = audio.ctx = audio.analyser = null;
  drawIdle();
}

async function finalizeRecording() {
  const chunks = audio.chunks; audio.chunks = []; audio.recorder = null;
  if (!chunks.length) return;
  const blob = new Blob(chunks, { type: audio.mime });
  const buf = new Uint8Array(await blob.arrayBuffer());
  const ext = (audio.mime.includes("mp4") || audio.mime.includes("aac")) ? "mp4" : "webm";
  const filename = `rec-${stamp()}.${ext}`;
  try {
    const path = await invoke("save_recording", { data: Array.from(buf), filename });
    toast(t("diarizando… (pode levar alguns minutos)"), 0);
    const md = await invoke("diarize", { audioPath: path });
    state.lines = md.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    render();
    toast(t("diarização concluída"));
  } catch (e) {
    toast(t("diarização falhou") + ": " + tErr(String(e)));
    clog("diarize error: " + e);
  }
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// modo "gravar tudo": salva o áudio bruto e manda transcrever de uma vez com
// whisper-cli (sem VAD/streaming) — as linhas voltam pelo mesmo evento
// transcript-line do modo ao vivo (ver listen() lá embaixo).
async function finalizeFileTranscription() {
  const chunks = audio.chunks; audio.chunks = []; audio.recorder = null;
  state.fileMode = false;
  if (!chunks.length) { toast(t("nada gravado")); return; }
  const blob = new Blob(chunks, { type: audio.mime });
  const buf = new Uint8Array(await blob.arrayBuffer());
  const ext = (audio.mime.includes("mp4") || audio.mime.includes("aac")) ? "mp4" : "webm";
  const filename = `loro-file-${stamp()}.${ext}`;
  try {
    const path = await invoke("save_recording", { data: Array.from(buf), filename });
    await invoke("transcribe_file", { path, cfg: currentCfg() });
  } catch (e) {
    toast(t("transcrição falhou") + ": " + tErr(String(e)));
    clog("transcribe_file error: " + e);
  }
}

// rótulo do dispositivo p/ o medidor/onda (regex de enumerateDevices):
// sistema => o loopback da plataforma; mic/reunião => padrão (a onda usa o microfone).
function meterLabelFor(source) {
  if (source === "system") return LoroAudio.loopbackPattern(hostOs);
  return undefined;
}

// ---- start / stop ----
function currentCfg() {
  return { model: el.model.value, lang: el.lang.value, translate: el.translate.checked, threads: 8 };
}
async function startSession() {
  if (state.running) return;
  // reunião: grava sua voz (mic) + o áudio do sistema (ScreenCaptureKit) e
  // transcreve ao parar — independe do seletor ao vivo/gravar tudo (ADR-0005).
  if (settings.source === "meeting") return startMeetingSession();
  if (settings.mode === "file") return startFileSession();
  const cfg = currentCfg();
  // fonte = áudio do sistema: resolve o dispositivo de loopback (flag -c) a
  // partir da lista enumerada. mic => padrão do sistema (sem -c).
  if (settings.source === "system") {
    let devs;
    try {
      devs = await invoke("list_capture_devices");
    } catch (e) {
      toast(t("falha ao listar dispositivos"));
      clog("list_capture_devices error: " + e);
      return;
    }
    const pick = LoroAudio.pickCaptureDevice(devs, settings.source, hostOs);
    if (pick.missing === "system") {
      openSystemAudioSetup();
      clog("system source: loopback missing; devices=" + JSON.stringify(devs));
      return;
    }
    cfg.capture = pick.capture;
    clog("system source via #" + pick.capture);
  }
  clog("start: " + JSON.stringify(cfg));
  // 1) inicia a transcrição PRIMEIRO — não depende do microfone do webview
  // R16 · o pendente nasce AQUI, junto do processo: até esta linha o app só
  // perguntou coisas. Quem o desfaz é o rec-state (onStarted) — ou a falha logo
  // abaixo, que é o mesmo tipo de verdade.
  setRecPending("starting");
  try {
    await invoke("start", { cfg });
  } catch (e) {
    setRecPending(null);
    toast(t("não iniciou") + ": " + tErr(String(e)));
    clog("invoke start error: " + e);
    // model missing on first run, or left incomplete by an interrupted
    // download: open settings so the user can (re)download it
    if (String(e).startsWith("err.model_not_found") || String(e).startsWith("err.model_incomplete")) openCfg();
    return;
  }
  // 2) medidor/onda (best-effort, nunca bloqueia): mic direto, ou o loopback no modo sistema
  const meterLabel = meterLabelFor(settings.source);
  startAudio(meterLabel).catch((e) => clog("startAudio failed (continuing without wave): " + e));
}
async function stopSession() {
  // meeting.active PRIMEIRO: uma reunião grava o áudio do sistema pelo sidecar do
  // backend, então ela pode estar ativa com state.running falso (o microfone
  // nunca subiu). Na outra ordem "Encerrar reunião" caía no early-return e não
  // fazia nada — o cromo ficava em "encerrando…" com o ● desabilitado.
  if (meeting.active) return stopMeeting();
  if (!state.running) return;
  if (settings.mode === "file") { clog("stop (file mode)"); onStopped(); return; }
  clog("stop requested");
  try { await invoke("stop"); } catch (e) { clog("invoke stop error: " + e); }
}

// ADR-0010 — a meeting is a living file under a tema. START picks/creates a tema
// and calls brain_meeting_start, which scaffolds the meeting home + manifest +
// reuniao.md AND spawns the ScreenCaptureKit sidecar into audio/system.wav
// (REUSING ADR-0005 system_capture_start — the frontend does NOT start capture
// itself). The mic keeps recording via the existing MediaRecorder (the onda +
// audio/mic.webm). The reuniao.md tab is opened as THE live surface (the footer
// live panel is retired for meetings), and the transcript only shows after stop.
// Uma reunião nasce em DOIS tempos (o backend sobe o sidecar de sistema, o
// microfone depende de uma permissão do sistema): entre eles ela não está ativa
// mas também não pode ser iniciada de novo. Esta trava cobre essa janela.
let meetingStarting = false;
const meetingBusy = () => state.running || meeting.active || meetingStarting;
async function startMeetingSession(presetTema) {
  if (meetingBusy()) { toast(t("já há uma gravação em andamento")); return; }
  // Choke point for every entrance: the source selector, the palette's "nova
  // reunião" and the brainstorming sidebar row. The palette path ignores the
  // source selector by design, so hiding the option there is not enough. Fail
  // here, before asking which brainstorming to record into.
  if (hostOs !== "macos") { toast(tErr("err.meeting_macos_only"), 6000); return; }
  let temas = [];
  try { temas = (await invoke("brain_list_brainstorms")) || []; } catch (_) {}
  const choice = await pickMeeting(temas, presetTema);
  if (!choice || !choice.tema) return;
  return startMeetingWith(choice);
}
// Espera `p` por no máximo `ms`; devolve `fallback` quando o prazo vence. A
// promessa continua viva — quem chama decide o que fazer se ela chegar depois.
// Uma promessa PENDENTE não é uma promessa rejeitada: try/catch não a alcança, e
// era isso que travava o início de uma reunião (o diálogo de permissão do
// microfone só resolve quando o usuário responde).
function settleWithin(p, ms, fallback) {
  return new Promise((resolve) => {
    const id = setTimeout(() => resolve(fallback), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(id); resolve(v); },
      () => { clearTimeout(id); resolve(fallback); }
    );
  });
}
// Prazo do microfone. Acima disso há um diálogo do sistema na frente do usuário:
// a reunião não pode ficar presa esperando nem se pintar como GRAVANDO — segue
// com o áudio do sistema (já em captura) e diz em que estado está.
const MIC_GRANT_MS = 6000;
async function startMeetingWith(choice) {
  if (meetingBusy()) { toast(t("já há uma gravação em andamento")); return; }
  const cfg = currentCfg();
  clog("start (meeting ADR-0010): tema=" + choice.tema);
  meetingStarting = true;
  setRecPending("starting"); // nada foi estabelecido ainda: o cromo diz "iniciando…"
  let res;
  try {
    res = await invoke("brain_meeting_start", { input: { tema: choice.tema, titulo: choice.titulo, cfg } });
  } catch (e) {
    const msg = String(e);
      // R15/R24 · a recusa apontava para "as Configurações", que no vocabulário do
    // Loro é a PRÓPRIA página do app (e lá não existe nada sobre isso). O caminho
    // certo é o do sistema, e o app já tem essa frase: err.screen_recording_denied.
    if (/permiss|tcc|grava|screen/i.test(msg)) toast(tErr("err.screen_recording_denied"), 0);
    else toast(t("não iniciei a reunião") + ": " + tErr(msg));
    clog("brain_meeting_start error: " + e);
    meetingStarting = false; setRecPending(null);
    return;
  }
  // O MICROFONE ANTES DO CROMO. Antes a aba reuniao.md era aberta com o selo
  // GRAVANDO e o rodapé de gravação subia, e só então o startAudio era esperado:
  // na primeira reunião depois da instalação essa promessa fica pendente no
  // diálogo de permissão do macOS, o onStarted nunca rodava, o relógio ficava em
  // 00:00 e nenhum preview ao vivo começava. A interface afirmava um estado que
  // não havia alcançado (DESIGN.md §1).
  const micReady = startAudio(undefined).then(
    () => true,
    (e) => { clog("startAudio (meeting) error — continuing with system audio only: " + e); return false; }
  );
  const mic = await settleWithin(micReady, MIC_GRANT_MS, "asking");
  if (mic === "asking") toast(t("o sistema está pedindo permissão para o microfone — a reunião já grava o áudio do sistema"), 8000);
  else if (mic === false) toast(t("sem microfone — a reunião está gravando só o áudio do sistema"), 8000);

  meeting.active = true; meeting.id = res.id; meeting.dir = res.dir;
  meeting.livingRel = res.livingRel; meeting.tema = choice.tema;
  meeting.originEpoch = res.startedEpochMs || null; // ADR-0025: o t=0 das DUAS trilhas
  meeting.phase = "recording"; meeting.pendingLines = [];
  meeting.appended = []; crossTalkHits = 0; crossTalkNudged = false;
  meeting.gate = LM.coverageGate(); // ADR-0025: o dono da junção é POR reunião
                           // histórico de eco é POR reunião (antes dependia de o
                           // relógio ler exatamente 0 — um tique de 1ms vazava a
                           // reunião anterior para dentro da nova)
  state.meetingMode = true;
  meetingStarting = false;
  await openDoc(res.livingRel, { preview: false }); // a aba é a superfície ao vivo
  onStarted();
  startMeetingTail(); // ADR-0012: sistema (outros participantes) ao vivo
  if (mic === true) startMeetingPreview(); // ADR-0012 modelo A: microfone (operador) ao vivo
  // permissão concedida DEPOIS do prazo: o microfone entra na reunião em curso
  // em vez de ficar de fora dela até o fim — e se a reunião já acabou, a captura
  // é fechada na hora (BR-1: nada fica com o microfone aberto sem gravação).
  else micReady.then((ok) => {
    if (!ok) return;
    if (meeting.active && meeting.phase === "recording") startMeetingPreview();
    else stopAudio();
  });
  pessoalSig = ""; refreshPessoal();
  if (mic === true) toast(t("reunião iniciada — a transcrição aparece durante a reunião"));
}

// ADR-0012 pseudo-stream: while recording, poll the system-audio tail every ~18s
// and append any new text below the marker (append-only, read-only contract).
// Each tick transcribes the window [tailFrom, end] via brain_meeting_transcribe_tail
// and advances tailFrom to the returned nextMs so windows never overlap. This is a
// BEST-EFFORT preview — the authoritative mix+transcription at stop stays the
// source of truth — so every error is swallowed (clog) and never crashes the
// meeting. The meeting-appended event repaints the living surface in place.
const MEETING_TAIL_MS = 18000;
function startMeetingTail() {
  stopMeetingTail();
  // ADR-0025: onde este segmento de captura começa na linha do tempo da reunião
  // NÃO é mais estimado aqui. O `meetingElapsedMs()` deste instante era a
  // estimativa errada: no início ele vem depois do poll de permissão e da espera do
  // microfone, e num retomar ele vem depois de o `system_capture_start` bloquear.
  // Quem diz é o sidecar, pela âncora que chega em cada resposta do tail. O que
  // fica aqui é o total pausado até este segmento — a pausa não é tempo gravado.
  meeting.tailFrom = 0; meeting.tailBusy = false;
  if (meeting.gate) meeting.gate.reopen(); // retomar volta a fazer a junção esperar
  meeting.segPausedMs = state.pausedMs;
  // A melhor âncora CONHECIDA agora: este instante. A medida do sidecar chega na
  // primeira resposta do tail e substitui esta. O fallback tem de ser uma
  // estimativa do início DESTE segmento — não o offset cru, que num retomar
  // jogaria a janela para perto do começo da reunião, antes da pausa.
  meeting.sysAnchor = Date.now();
  meeting.tailStatus = t("preview: iniciando…");
  meeting.tailTimer = setInterval(tickMeetingTail, MEETING_TAIL_MS);
}
// Para o intervalo. NÃO limpa `tailBusy`: existe um tick em voo, e zerar a
// trava deixava o próximo disparar por cima dele — dois whisper carvando o MESMO
// arquivo de snapshot, um apagando o do outro, e o `tailFrom` do vencedor
// atrasado sobrescrevendo o do segmento novo (a transcrição de sistema morria em
// silêncio pelo resto da reunião). Quem precisa do fim do tick usa `tailFlush`.
function stopMeetingTail() {
  if (meeting.tailTimer) { clearInterval(meeting.tailTimer); meeting.tailTimer = null; }
}
// Só rearma o intervalo, sem rebasear o offset — para voltar ao estado anterior
// quando uma pausa falha (o WAV do backend continua o mesmo e continua crescendo).
function resumeMeetingTailInterval() {
  if (!meeting.tailTimer) meeting.tailTimer = setInterval(tickMeetingTail, MEETING_TAIL_MS);
}

// ADR-0012 model A: rotate a dedicated mic MediaRecorder (separate from the main
// one, on the same stream) so the operator's speech reaches the LIVE transcript.
// Each interval stops the current segment (its onstop transcribes it) and the
// next is spawned in onstop, giving continuous ~N s segments. Audio is transient.
function blobToBytes(blob) {
  return blob.arrayBuffer().then((b) => Array.from(new Uint8Array(b)));
}
function spawnPreviewRec() {
  if (!audio.stream) return;
  // ADR-0025: o segmento é marcado em EPOCH, não em tempo decorrido — é o que
  // permite convertê-lo para a mesma linha do tempo que a trilha de sistema usa.
  // Um segmento nunca atravessa uma pausa (pausar para o preview, retomar
  // respawna), então uma foto do total pausado basta.
  const segStartEpoch = Date.now();
  const segPausedMs = state.pausedMs;
  let rec;
  try { rec = new MediaRecorder(audio.stream); }
  catch (e) { clog("preview rec error: " + e); return; }
  meeting.previewRec = rec;
  meeting.previewChunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) meeting.previewChunks.push(e.data); };
  rec.onstop = () => {
    const chunks = meeting.previewChunks; meeting.previewChunks = [];
    // Only respawn while the rotation is live (previewTimer set); stopMeetingPreview
    // clears it first, so the final stop flushes the last segment without respawning.
    if (meeting.active && meeting.phase === "recording" && meeting.previewTimer) spawnPreviewRec();
    // `Date.now()` aqui é o fim REAL deste segmento — o onstop dispara logo após o
    // stop(). É o outro lado da junção, no mesmo relógio da cobertura.
    onPreviewSegment(chunks, rec.mimeType || "audio/webm", segStartEpoch, segPausedMs, Date.now());
  };
  try { rec.start(); } catch (e) { clog("preview start error: " + e); }
}
function startMeetingPreview() {
  stopMeetingPreview();
  spawnPreviewRec();
  meeting.previewTimer = setInterval(() => {
    const rec = meeting.previewRec;
    if (rec && rec.state !== "inactive") rec.stop(); // onstop → transcribe + respawn
  }, MEETING_TAIL_MS);
}
function stopMeetingPreview() {
  if (meeting.previewTimer) { clearInterval(meeting.previewTimer); meeting.previewTimer = null; }
  const rec = meeting.previewRec; meeting.previewRec = null;
  if (rec && rec.state !== "inactive") { try { rec.stop(); } catch (_) {} } // flush the last segment
}
// ADR-0025: o teto da espera pela junção. Vencido o prazo, a fala do microfone
// entra do jeito que está — sob a ADR-0018 a transcrição ao vivo é a ÚNICA saída da
// reunião, então uma linha possivelmente duplicada é muito melhor que uma linha
// perdida. Um tique é o intervalo natural: é de quanto em quanto tempo a trilha de
// sistema entrega uma janela.
const ATTRIB_HOLD_MS = MEETING_TAIL_MS;
// As duas trilhas giram no MESMO intervalo, então a janela de sistema que cobre um
// segmento de microfone é fotografada no mesmo tique — e pode sair alguns
// milissegundos ANTES de o segmento fechar. Exigir cobertura estrita faria toda
// fala do microfone esperar o tique seguinte, sistematicamente. A folga é isso:
// milissegundos de audio a menos no fim da janela não mudam a transcrição do eco.
const ATTRIB_TOL_MS = 1000;
// Espera a trilha de sistema ter sido ouvida até o fim deste segmento. O portão é
// puro (LM.coverageGate); aqui só decidimos quando desistir e o que dizer ao usuário
// enquanto isso — uma espera silenciosa seria a interface sabendo algo que não diz.
async function awaitAttribution(id, segEndEpoch) {
  const gate = meeting.gate;
  if (!gate || !meeting.active) return;
  const aviso = setTimeout(() => setTailStatus(id, t("conferindo de quem é a fala…")), 1200);
  try {
    const how = await gate.wait(segEndEpoch - ATTRIB_TOL_MS, ATTRIB_HOLD_MS);
    // BR-8: o log conta O QUE aconteceu, nunca o que foi dito. O caso do prazo é o
    // patológico, e é o único jeito de saber que ele aconteceu.
    if (how === "deadline") clog("meeting attribution: hold expired, appending mic speech unresolved");
  } finally {
    clearTimeout(aviso);
  }
}

// Ponto ÚNICO de anexação da transcrição ao vivo: as duas trilhas passam por
// aqui, e é aqui que o eco de uma na outra é barrado.
//
// ADR-0025: recebe as FALAS de uma janela, já carimbadas na linha do tempo da
// reunião, e escreve a janela inteira numa chamada. Antes uma janela de 18s era um
// bloco só, carimbado no início dela — só a primeira fala tinha tempo verdadeiro.
// Devolve {appended, dropped} porque quem chama precisa dizer a verdade sobre o
// estado do preview: nada escrito por eco é diferente de nada escrito por silêncio.
async function appendMeetingSpeech(id, utterances, source) {
  const fresh = [];
  let dropped = 0;
  for (const u of utterances || []) {
    const text = LM.filterHallucinations((u && u.text) || "");
    if (!text.trim()) continue;
    const chunk = {
      tMs: u.tMs || 0,
      endMs: u.endMs == null ? (u.tMs || 0) : u.endMs,
      source: source,
      tokens: LM.speechTokens(text),
      text: text,
    };
    // ADR-0025: quem pode ser descartado é só a cópia do MICROFONE, porque o
    // vazamento tem um sentido só (alto-falante → microfone). Antes o descarte era
    // simétrico e caía em quem chegasse em segundo lugar — o rótulo era sorteado.
    const eco = LM.micLeakOfSystem(chunk, meeting.appended);
    if (eco) {
      // BR-8: o log conta O QUE aconteceu, nunca o que foi dito.
      clog("meeting append: dropped cross-source echo (source=" + source + " prev=" + eco.source + ")");
      noteCrossTalk(1);
      dropped++;
      continue;
    }
    // REGISTRA ANTES DE ESPERAR. As duas trilhas giram no MESMO intervalo de 18s,
    // então as duas cópias da mesma fala chegam praticamente juntas: registrando
    // só depois do `await`, as duas testavam contra uma lista que ainda não tinha
    // a outra, as duas passavam e o filtro nunca via par nenhum — o log ficou com
    // ZERO descartes enquanto a transcrição duplicava. Entre este push e o teste
    // acima não há await, então nada se intercala.
    meeting.appended.push(chunk);
    if (meeting.appended.length > 40) meeting.appended.shift();
    // Sobreposição PARCIAL (uma trilha com fala própria + o vazamento da outra)
    // não pode ser descartada — perderia fala legítima — mas é a mesma evidência
    // de que o microfone está ouvindo a caixa.
    if (LM.partialCrossTalk(chunk, meeting.appended)) noteCrossTalk(1);
    fresh.push(chunk);
  }
  if (!fresh.length) return { appended: 0, dropped: dropped };
  // ADR-0025 §29: as falas soltas ficam em `meeting.appended` — é com elas, uma a
  // uma, que o vazamento é decidido. O que vai para o arquivo são PARÁGRAFOS: falas
  // seguidas juntas num bloco, carimbado no tempo real da primeira. Um bloco por
  // fala punha um rótulo `[mm:ss · fonte]` no meio de cada frase.
  const blocks = LM.speechParagraphs(fresh);
  try {
    await invoke("brain_meeting_append_timed", {
      input: { id, blocks: blocks.map((b) => ({ tMs: b.tMs, source: source, chunk: b.text })) },
    });
  } catch (e) {
    // não ficou no arquivo: sair da lista para não barrar o gêmeo legítimo
    for (const c of fresh) {
      const i = meeting.appended.indexOf(c);
      if (i >= 0) meeting.appended.splice(i, 1);
    }
    throw e;
  }
  return { appended: fresh.length, dropped: dropped };
}

// O vazamento da caixa é físico. Desde a ADR-0025 o RÓTULO já sai certo — quem cai
// é sempre a cópia do microfone —, mas a fala que é 100% vazamento ainda custa uma
// linha descartada e alguns segundos de espera na junção. Matar o vazamento na
// origem evita as duas coisas, e é um controle que o usuário não tem por que
// adivinhar que existe. Ao terceiro sinal, o app liga os dois: o sintoma que ele
// está vendo e a chave que o desliga. Uma vez por reunião.
let crossTalkHits = 0, crossTalkNudged = false;
function noteCrossTalk(n) {
  crossTalkHits += n;
  if (crossTalkHits < 3 || crossTalkNudged || settings.micEchoCancel) return;
  crossTalkNudged = true;
  toast(t("as duas trilhas estão ouvindo a mesma fala — ligue o cancelamento de eco em Configurações → Captura"), 12000);
}

async function onPreviewSegment(chunks, mime, segStartEpoch, segPausedMs, segEndEpoch) {
  if (!chunks || !chunks.length || !meeting.id) return;
  const id = meeting.id;
  try {
    const data = await blobToBytes(new Blob(chunks, { type: mime }));
    const res = await invoke("brain_meeting_transcribe_segment", { input: { id, data } });
    if (meeting.id !== id) return;
    const falas = (res && res.segments) || [];
    if (!falas.length) { setTailStatus(id, t("preview: microfone sem fala substantiva ainda")); return; }
    // ADR-0025: cada fala do segmento no SEU tempo, convertida para a linha do
    // tempo da reunião — a mesma que a trilha de sistema usa.
    const utterances = falas.map((s) => ({
      tMs: LM.micBlockMs(segStartEpoch, s.tMs, meeting.originEpoch, segPausedMs),
      endMs: LM.micBlockMs(segStartEpoch, s.endMs, meeting.originEpoch, segPausedMs),
      text: s.text,
    }));
    // A JUNÇÃO: espera a trilha de sistema ter sido ouvida até o fim deste segmento
    // antes de resolver de quem é a fala. Sem isto o rótulo volta a ser sorteado —
    // quem chegasse primeiro ganharia. O `await` fica AQUI, antes do teste de
    // vazamento; entre o teste e o registro não pode haver nenhum (ADR-0022 §26).
    await awaitAttribution(id, segEndEpoch || Date.now());
    if (meeting.id !== id) return;
    try {
      const r = await appendMeetingSpeech(id, utterances, "mic");
      setTailStatus(id, r.appended || r.dropped
        ? t("preview ao vivo ativo")
        : t("preview: microfone sem fala substantiva ainda"));
    } catch (e) { clog("brain_meeting_append (mic) error: " + e); }
  } catch (e) {
    clog("brain_meeting_transcribe_segment error: " + e);
    setTailStatus(id, t("preview indisponível") + ": " + tErr(String(e)));
  }
}
function tickMeetingTail() {
  // A promessa fica publicada em `tailFlush` para que pausar/encerrar possam
  // ESPERAR o tick em voo em vez de disparar um concorrente.
  if (meeting.tailBusy) return meeting.tailFlush || Promise.resolve();
  meeting.tailFlush = runMeetingTail();
  return meeting.tailFlush;
}
async function runMeetingTail() {
  if (!meeting.active || meeting.phase !== "recording" || !meeting.id) return;
  meeting.tailBusy = true;
  const id = meeting.id;
  // Até QUANDO a trilha de sistema já foi ouvida, em epoch — o mesmo relógio que
  // marca o fim de um segmento de microfone. Deliberadamente NÃO é o tempo de
  // reunião derivado do WAV: a junção compararia bytes de áudio contra relógio de
  // parede, e os dois `setInterval` (tail e microfone) derivam um do outro ao longo
  // de uma reunião longa. Aqui os dois lados são `Date.now()`, então a relação
  // "esta janela foi tirada depois daquele segmento" é exata.
  //
  // Tomado ANTES do invoke porque é aí que o backend fotografa o WAV; é a leitura
  // conservadora (a janela cobre um pouco além disso), e errar para menos só custa
  // espera, nunca um rótulo errado.
  const snapAt = Date.now();
  try {
    const res = await invoke("brain_meeting_transcribe_tail", { input: { id, fromMs: meeting.tailFrom } });
    if (!res) { setTailStatus(id, t("preview: sem resposta do backend")); return; }
    // ADR-0025: a âncora do segmento corrente — o t=0 do WAV, medido pelo sidecar.
    // Pode chegar depois do início da reunião (uma máquina em silêncio atrasa a
    // primeira amostra), então ela vem em toda resposta, inclusive nas vazias.
    if (res.anchorEpochMs != null) meeting.sysAnchor = res.anchorEpochMs;
    if (typeof res.nextMs === "number" && res.nextMs > meeting.tailFrom) meeting.tailFrom = res.nextMs;
    const falas = res.segments || [];
    if (!falas.length) {
      // Nenhum texto do backend: janela vazia ou áudio ainda não legível.
      setTailStatus(id, t("preview: aguardando áudio (sem novo trecho ainda)"));
      return;
    }
    if (!meeting.active || meeting.id !== id) return;
    // os outros participantes (áudio do sistema), cada fala no seu tempo
    const utterances = falas.map((s) => ({
      tMs: LM.sysBlockMs(meeting.sysAnchor, s.tMs, meeting.originEpoch, meeting.segPausedMs),
      endMs: LM.sysBlockMs(meeting.sysAnchor, s.endMs, meeting.originEpoch, meeting.segPausedMs),
      text: s.text,
    }));
    try {
      const r = await appendMeetingSpeech(id, utterances, "system");
      setTailStatus(id, r.appended || r.dropped
        ? t("preview ao vivo ativo")
        // Houve áudio transcrito, mas só silêncio/ruído (alucinação de legenda) —
        // sinaliza captura OK porém sem fala; diferente de "sem áudio".
        : t("preview: só silêncio/ruído até agora (fale para testar a captura)"));
    } catch (e) { clog("brain_meeting_append (tail) error: " + e); }
  } catch (e) {
    clog("brain_meeting_transcribe_tail error: " + e);
    setTailStatus(id, t("preview indisponível") + ": " + tErr(String(e)));
  } finally {
    meeting.tailBusy = false;
    // No FINALLY, e mesmo em caso de erro: uma janela que falhou não pode prender a
    // junção. O silêncio também cobre — uma janela sem fala prova que aquele
    // intervalo foi ouvido e não havia eco nenhum ali, e sem isso um trecho calado
    // do outro lado faria toda fala do microfone esperar o teto inteiro.
    if (meeting.gate) meeting.gate.advance(snapAt);
  }
}
// Surface the pseudo-stream status in the meeting panel (repaint on change only).
function setTailStatus(id, msg) {
  if (meeting.tailStatus === msg) return;
  meeting.tailStatus = msg;
  renderIfLiving(id);
}

// Encerrar: para captura/onda; o MediaRecorder dispara finalizeMeeting no onstop.
// Se o microfone falhou (sem recorder), conduzimos o encerramento diretamente.
function stopMeeting() {
  clog("stop (meeting ADR-0010)");
  if (state.paused) { state.pausedMs += Date.now() - state.pauseStart; state.paused = false; state.pauseStart = 0; }
  stopMeetingTail();     // encerra o preview de sistema
  stopMeetingPreview();  // encerra o preview de mic (faz o flush do último segmento)
  const hadRecorder = !!(audio.recorder && audio.recorder.state !== "inactive");
  onStopped();
  if (!hadRecorder) finalizeMeeting();
}

// Pausar PARA a captura de verdade — o sidecar morre e nada é gravado enquanto
// dura a pausa (um pausar que continuasse capturando mentiria). Antes de parar,
// a última janela de sistema e o segmento de mic corrente são despejados, para a
// fala até o instante da pausa não se perder.
let pausePending = false;
async function pauseMeeting() {
  if (!meeting.active || meeting.phase !== "recording" || state.paused || pausePending) return;
  pausePending = true;
  paintPauseBtn("pending");
  try {
    stopMeetingPreview();            // flush do segmento de mic corrente
    stopMeetingTail();
    // espera o tick em voo ANTES de pedir o seu: dois carves concorrentes
    // disputam o mesmo snapshot e corrompem os dois lados
    try { await meeting.tailFlush; } catch (_) {}
    try { await tickMeetingTail(); } // última janela de sistema (best-effort)
    catch (e) { clog("final tail before pause: " + e); }
    // Não vem mais janela: quem espera pela junção é liberado agora, em vez de
    // ficar preso no teto (o último segmento de microfone está em voo).
    if (meeting.gate) meeting.gate.close();
    await invoke("brain_meeting_pause", { input: { id: meeting.id } });
    state.paused = true; state.pauseStart = Date.now();
    if (audio.ctx) { try { audio.ctx.suspend(); } catch (_) {} } // congela a onda
    paintCaptureMeter();   // o selo de privacidade não pode seguir dizendo "● mic"
    renderTabs();          // e o ponto vermelho da aba também afirma gravação
    setTailStatus(meeting.id, t("reunião pausada — nada está sendo gravado"));
    toast(t("reunião pausada — nada está sendo gravado"));
  } catch (e) {
    clog("brain_meeting_pause error: " + e);
    toast(t("não consegui pausar") + ": " + tErr(String(e)));
    // Volta ao estado anterior SEM rebasear: toda falha do brain_meeting_pause
    // acontece antes de parar a captura, então o WAV é o mesmo e segue crescendo.
    // `startMeetingTail()` zeraria o offset e a reunião inteira seria transcrita
    // e appendada de novo, ainda por cima carimbada na hora da falha.
    resumeMeetingTailInterval(); startMeetingPreview();
  } finally {
    pausePending = false;
    paintPauseBtn();
  }
}
async function resumeMeeting() {
  if (!meeting.active || !state.paused || pausePending) return;
  pausePending = true;
  paintPauseBtn("pending");
  try {
    await invoke("brain_meeting_resume", { input: { id: meeting.id } });
    state.pausedMs += Date.now() - state.pauseStart;
    state.paused = false; state.pauseStart = 0;
    if (audio.ctx) { try { audio.ctx.resume(); } catch (_) {} }
    paintCaptureMeter();   // volta a dizer o que está sendo captado
    renderTabs();
    startMeetingTail();    // novo segmento: offset em 0, âncora vem do sidecar
    startMeetingPreview();
    setTailStatus(meeting.id, t("preview ao vivo ativo"));
    announce(t("gravando"));   // pausar avisa por toast; retomar não avisava nada
  } catch (e) {
    clog("brain_meeting_resume error: " + e);
    toast(t("não consegui retomar") + ": " + tErr(String(e)));
  } finally {
    pausePending = false;
    paintPauseBtn();
  }
}
function paintPauseBtn(mode) {
  const b = $("recPause");
  if (!b) return;
  b.disabled = mode === "pending";
  b.classList.toggle("pending", mode === "pending");
  b.textContent = state.paused ? "▶ " + t("retomar") : "⏸ " + t("pausar");
  const foot = $("recFoot");
  if (foot) {
    foot.classList.toggle("paused", !!state.paused);
    const note = foot.querySelector(".recnote");
    if (note) note.textContent = state.paused
      ? t("reunião pausada — nada está sendo gravado")
      : t("mic ativo · a gravação continua se você trocar de aba");
  }
}

// STOP (ADR-0012 modelo A): a transcrição JÁ foi montada ao vivo pelos segmentos
// de mic + janelas de sistema — NÃO há passe completo separado (duplicaria tudo).
// Aqui apenas encerramos os loops, paramos o sidecar de sistema e concluímos
// (fecha a reunião + apaga todo o áudio; áudio é transiente).
async function finalizeMeeting() {
  stopMeetingTail();
  stopMeetingPreview(); // faz o flush do último segmento de mic (append assíncrono)
  audio.chunks = []; audio.recorder = null;
  state.meetingMode = false;
  const id = meeting.id;
  if (!id) return;
  // ADR-0025: a ÚLTIMA janela de sistema tinha de ser despejada aqui e não era —
  // pausar fazia o tique final, encerrar ia direto para o brain_meeting_stop. Até
  // 18s de fala dos outros participantes se perdiam no fim de cada reunião, e o
  // áudio é purgado depois (ADR-0018), então se perdiam para sempre. Tem de ser
  // ANTES do stop, que move o WAV e deixa o tail sem fonte.
  try { await meeting.tailFlush; } catch (_) {}
  try { await tickMeetingTail(); }
  catch (e) { clog("final tail before stop: " + e); }
  // Não vem mais janela: libera o último segmento de microfone, que está em voo e
  // senão esperaria o teto inteiro antes de entrar.
  if (meeting.gate) meeting.gate.close();
  meeting.phase = "transcribing";
  setRecPending("stopping"); // desabilita o ● E diz por quê ("encerrando…")
  renderIfLiving(id);
  // encerra o sidecar de áudio do sistema (o mix é ignorado — áudio é transiente)
  try { await invoke("brain_meeting_stop", { input: { id } }); }
  catch (e) { clog("brain_meeting_stop error: " + e); }
  await finishMeetingAfterTranscription(); // fecha a reunião + purga o áudio
}

// Acumula as linhas do transcript-line e as persiste em lote abaixo do marcador
// via brain_meeting_append (append-only). O flush é debounced para não gravar o
// manifest por linha; um flush final ocorre ao concluir a transcrição.
function meetingAccumulate(line) {
  if (line == null || line === "") return;
  const clean = LM.filterHallucinations(line); // drop whisper silence-artifacts
  if (!clean) return;
  meeting.pendingLines.push(clean);
  if (meeting.flushTimer) return;
  meeting.flushTimer = setTimeout(flushMeetingLines, 900);
}
async function flushMeetingLines() {
  meeting.flushTimer = null;
  if (!meeting.id || !meeting.pendingLines.length) return;
  const chunk = meeting.pendingLines.join("\n\n");
  meeting.pendingLines = [];
  try { await invoke("brain_meeting_append", { input: { id: meeting.id, chunk } }); }
  catch (e) { clog("brain_meeting_append error: " + e); }
}

// Conclusão: garante o flush final, fecha a reunião (brain_meeting_finish) e abre
// reuniao.md como aba. ADR-0018: nada é autorado — a análise é OFERECIDA, em um
// clique e dispensável, e só roda se o usuário pedir. Reentrância por meeting.active.
async function finishMeetingAfterTranscription() {
  if (!meeting.active) return;
  meeting.active = false; meeting.phase = "done"; // reentrancy guard set synchronously
  const id = meeting.id;
  if (meeting.flushTimer) { clearTimeout(meeting.flushTimer); meeting.flushTimer = null; }
  await flushMeetingLines();
  // único ponto que sabe que a reunião REALMENTE acabou: é aqui que o cromo sai
  // de "encerrando…" para o estado real
  setRecPending(null);
  el.privacy.classList.remove("warn");
  updatePrivacy();
  let rel = null;
  if (id) {
    try { const r = await invoke("brain_meeting_finish", { id }); rel = r && r.rel; }
    catch (e) { toast(t("não encerrei a reunião") + ": " + tErr(String(e))); clog("meeting_finish error: " + e); }
    // Áudio é transiente (decisão do dono): apaga após a transcrição autoritativa.
    try { await invoke("brain_meeting_purge_audio", { input: { id } }); }
    catch (e) { clog("brain_meeting_purge_audio error: " + e); }
  }
  pessoalSig = ""; refreshPessoal();
  renderIfLiving(id);
  if (rel) { openDoc(rel, { preview: false }); offerAnalyse(LM.meetingDir(rel)); }
  else if (id) toast(t("reunião encerrada"));
}

// Resolve o completoRel (relativo ao acervo) num caminho de arquivo para a
// transcrição existente (ADR-0010: stop devolve rel e não transcreve).
async function acervoFsPath(rel) {
  const cfg = await invoke("brain_get_config");
  const base = (cfg && cfg.brainDir) || "";
  return LM.acervoJoin(base, rel);
}

// Marcadores PII-free (BR-8): timecode a partir do relógio da sessão.
// ADR-0020 §2: um marcador ÚNICO ("momento") — escolher um tipo no meio de uma
// reunião era fricção; o valor está em ancorar o instante, não em classificá-lo.
const MARKER_TIPO = "momento";
async function markMeeting() {
  if (!meeting.active || !meeting.id) { toast(t("nenhuma reunião em andamento")); return; }
  // relógio da reunião, que desconta as pausas — o mesmo que carimba os trechos
  // de mic e as janelas de sistema. Com Date.now() cru o marcador caía adiante
  // da fala pelo total pausado.
  const tMs = elapsedActiveMs();
  try { await invoke("brain_meeting_marker", { input: { id: meeting.id, tipo: MARKER_TIPO, tMs } }); toast(t("momento marcado")); }
  catch (e) { toast(tErr(String(e))); clog("brain_meeting_marker error: " + e); }
}

// paleta: "nova reunião" (independe do seletor de fonte).
// presetTema pins the brainstorming when the flow starts from its sidebar row.
function startMeetingFlow(presetTema) {
  if (meetingBusy()) { toast(t("já há uma gravação em andamento")); return; }
  startMeetingSession(presetTema);
}
// ADR-0013: general Q&A over the acervo. Any question is answered from the
// versioned contexts (local base) first, MCP/external only after (the /loro-ask
// skill enforces the order). Injects into the terminal Claude, like the meeting
// skills — the answer appears in the terminal. Not meeting-scoped.
function askAcervo(ctx) {
  const scope = ctx
    ? `<p class="pmnote">${t("a pergunta fica ancorada neste tema")}: <b>${esc(ctx)}</b></p>`
    : "";
  openModal(
    ctx ? t("Perguntar a um tema") : t("Perguntar ao projeto"),
    scope +
      `<p class="pmnote">${t("A resposta vem primeiro do conhecimento do projeto e, se preciso, de fontes externas configuradas nas habilidades.")} ${esc(aiTargetHint())}</p>` +
      `<label class="wfield"><span class="mono">${t("pergunta")}</span>` +
      `<input id="askInput" type="text" placeholder="${t("ex.: qual a política de multas da frota?")}" spellcheck="false"></label>`,
    t("perguntar"),
    () => {
      const q = (($("askInput") && $("askInput").value) || "").trim();
      const cmd = LoroBrainstorm.brainAskCmd(q, ctx);
      if (!cmd) { toast(t("digite uma pergunta")); return; }
      return dispatchAiFromSheet(cmd);
    }
  );
  const inp = $("askInput"); if (inp) inp.focus();
}

// ADR-0018 · AC-5 — o empurrãozinho: um toast com "analisar" e "agora não". Nada
// é injetado no agente a menos que o usuário clique; dispensar deixa a reunião
// intocada. Nenhum cromo permanente entra no layout — o toast some sozinho.
function offerAnalyse(dir) {
  if (!dir) { toast(t("reunião encerrada")); return; }
  toastAction(t("reunião encerrada — quer analisar agora?"), [
    { label: t("analisar"), run: () => {
        const cmd = LM.analyseOffer("analisar", dir);
        // o mesmo par despachar → relatar do resto do app: o toast que sobra
        // dizendo onde a resposta aparece só sai se o pedido saiu
        if (cmd) dispatchAi(cmd, `${t("análise enviada")} — ${aiTargetHint()}`);
      } },
    { label: t("agora não"), run: () => {} },
  ]);
}

// modo "gravar tudo": não há processo do whisper-stream — apenas grava o áudio
// local (mesmo mecanismo do checkbox de diarização); a transcrição roda inteira
// só ao parar, em finalizeFileTranscription().
async function startFileSession() {
  clog("start (file mode): recording to transcribe at the end");
  state.fileMode = true;
  const meterLabel = meterLabelFor(settings.source);
  try {
    await startAudio(meterLabel);
  } catch (e) {
    state.fileMode = false;
    toast(t("não consegui gravar") + ": " + tErr(String(e)));
    clog("startAudio (file mode) error: " + e);
    return;
  }
  onStarted();
}

function onStarted() {
  setRecPending(null);
  state.running = true;
  requestAnimationFrame(() => resizeWave());
  el.dot.classList.add("on");
  el.toggle.classList.add("on", "recording");
  // reunião: a transcrição vive na aba reuniao.md, não no painel do rodapé (ADR-0010)
  if (!meeting.active) setLivePanel(true);
  el.savebar.hidden = true;
  startTimer(meeting.active ? meeting.originEpoch : null);
  // F6 · o estado da gravação é um STATUS (não um alerta): a transição é dita
  // uma vez. O relógio fica de fora — ele mudaria de segundo em segundo.
  announce(t("gravando"));
}
function onStopped() {
  setRecPending(null);
  if (!state.running) return;
  state.running = false;
  el.dot.classList.remove("on");
  el.toggle.classList.remove("on", "recording");
  stopTimer();
  // ADR-0013: clear the elapsed clock so a NEW recording never looks like it
  // resumes from the last session's time.
  state.startTime = 0;
  paintElapsed("00:00");
  stopAudio();
  updatePrivacy();
  announce(t("gravação encerrada"));
  endLooseBuffer();
}

// Fecha o buffer avulso conforme LM.looseEndAction. Antes isto estava duplicado
// aqui e no fim de transcribe-state, e só o onStarted checava meeting.active —
// então encerrar uma REUNIÃO fazia o rodapé avulso subir por cima da aba dela.
function endLooseBuffer(doneToast) {
  const action = LM.looseEndAction({
    meetingActive: meeting.active,
    lineCount: state.lines.length,
    autosave: settings.autosave,
  });
  if (action === "autosave") return autoSaveNow();
  if (action !== "offer") return;
  el.savebar.hidden = false;
  setLivePanel(true);
  if (doneToast) toast(doneToast);
}

// auto-save silencioso na pasta configurada
async function autoSaveNow() {
  const content = state.lines.join("\n\n") + "\n";
  try {
    let dir = settings.saveDir;
    if (!dir) {
      dir = await invoke("default_save_dir");
      settings.saveDir = dir; persistSettings(); applySettings();
    }
    const path = await invoke("auto_save", { content, dir, filename: `loro-${stamp()}.md` });
    toast(t("salvo") + ": " + path.split("/").pop());
    clearDoc();   // buffer limpo: a próxima sessão começa zerada
  } catch (e) {
    clog("auto_save error: " + e);
    toast(t("auto-save falhou — salve manualmente"));
    el.savebar.hidden = false;
  }
}
// debounce defensivo: ignora acionamentos < 500ms (clique duplo / evento repetido)
let lastToggle = 0;
function toggle() {
  const now = Date.now();
  if (now - lastToggle < 500) return;
  lastToggle = now;
  const stopping = state.running;
  // R16 · o clique em ● não começa nada: ele PERGUNTA onde a gravação vai morar.
  // Pintar "iniciando…" aqui afirmava um começo que ninguém tentou — e desabilitava
  // o único controle capaz de desistir enquanto a folha estava na tela. Parar, sim,
  // é imediato. Quem realmente sobe um processo (startSession / startMeetingWith)
  // pinta o seu próprio pendente, e quem o desfaz é o evento do backend.
  if (stopping) setRecPending("stopping");
  Promise.resolve(stopping ? stopSession() : startRecordFlow())
    // uma falha no caminho aparece (e não deixa o cromo pendente para trás)
    .catch((e) => { setRecPending(null); toast(tErr(String(e))); clog("toggle error: " + e); })
    .finally(() => { if (stopping && !meeting.active) setRecPending(null); });
}

// `null` | "starting" | "stopping". Só toca no cromo — quem decide se está
// gravando continua sendo o backend (rec-state).
let recPending = null;
// R4 · o ● trazia aria-label="Gravar / Parar" fixo no HTML — um nome que anuncia
// as duas ações opostas ao mesmo tempo e nunca muda. Como o aria-label vence o
// conteúdo, a tecnologia assistiva ouvia isso nos quatro estados e não tinha como
// saber se apertar ia começar ou parar. O rótulo visível já era verdade: esta é a
// decisão única de que estado o controle está, e o nome acessível sai dela.
function recControlLabel(kind, on) {
  return kind === "starting" ? t("iniciando…")
    : kind === "stopping" ? t("encerrando…")
    : on ? t("Parar") : t("Gravar");
}
function paintRecControl() {
  const text = recControlLabel(recPending, state.running || meeting.active);
  const label = $("recLabel");
  if (label) label.textContent = text;
  el.toggle.title = text;
  el.toggle.setAttribute("aria-label", text);
}
function setRecPending(kind) {
  recPending = kind;
  el.toggle.classList.toggle("pending", !!kind);
  el.toggle.disabled = !!kind;
  paintRecControl();
  document.querySelectorAll("[data-mtgfinish]").forEach((b) => {
    b.disabled = kind === "stopping";
    b.classList.toggle("pending", kind === "stopping");
  });
}

// ● never starts a loose recording (owner decision 2026-07-28): like every
// other flow, it first asks WHERE the result will live — a brainstorming
// (meeting) or an explicit one-off transcription (the old savebar flow).
async function startRecordFlow() {
  if (meetingBusy()) return;
  if (settings.source === "meeting") return startMeetingSession(); // already asks
  let temas = [];
  try { temas = (await invoke("brain_list_brainstorms")) || []; } catch (_) {}
  const choice = await pickMeeting(temas, null, { allowLoose: true });
  if (!choice) return;
  if (choice.tema) return startMeetingWith(choice);
  return startSession(); // explicit one-off: current live/file flow + savebar
}

// ---- salvar / descartar / limpar ----
// "Salvar em ideias" abria o painel Salvar do sistema e escrevia
// onde o usuário navegasse: a transcrição avulsa nunca chegava ao projeto, e o
// único outro caminho ("Descartar") a destruía. Uma transcrição é material
// CAPTADO, então ela pousa onde material captado mora — as notas de uma ideia, no
// mundo não versionado. Conhecimento (versionado) está fora de questão: uma
// transcrição crua não entra no que vai para o git (BR-8/ADR-0009).
function looseNoteTitle(d) {
  const p = (n) => String(n).padStart(2, "0");
  // sem acento: o backend transforma o título em nome de arquivo ASCII
  return `${t("conversa")} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}h${p(d.getMinutes())}`;
}
// Cria a nota e escreve `body` DEPOIS do esqueleto do backend (front-matter +
// título) em vez de substituí-lo: é o front-matter que faz da nota uma referência
// citável (ADR-0009).
async function newNoteInIdea(tema, titulo, body) {
  const rel = await invoke("brain_new_notebook", { tema: tema || null, titulo });
  if (!rel) throw "err.note_not_created";
  let head = "";
  try { head = await invoke("brain_read", { rel }); } catch (_) {}
  if (head && !head.endsWith("\n")) head += "\n";
  await invoke("brain_write", { rel, content: `${head}\n${body}` });
  return rel;
}
async function save() {
  const content = state.lines.join("\n\n") + "\n";
  if (!content.trim()) { toast(t("não há transcrição para salvar")); return; }
  let temas = [];
  try { temas = (await invoke("brain_list_brainstorms")) || []; } catch (_) {}
  // "soltas" é a pasta que o backend já usa quando nenhuma ideia é escolhida
  // (brainstorming/avulso): a transcrição sempre tem casa, mesmo num projeto novo.
  const opts = temas.map((b) => `<option value="${esc(b.slug)}">${esc(b.nome)}</option>`).join("") +
    `<option value="">${t("soltas (sem ideia)")}</option>`;
  openModal(
    t("Salvar em ideias"),
    `<p class="pmnote">${t("vira uma nota da ideia escolhida — o áudio é apagado depois de transcrito")}</p>` +
      `<label class="wfield"><span class="mono">${t("título")}</span>` +
      `<input id="looseTitle" type="text" value="${esc(looseNoteTitle(new Date()))}" spellcheck="false"></label>` +
      `<label class="wfield"><span class="mono">${t("onde guardar")}</span>` +
      `<select id="looseDest">${opts}</select></label>`,
    t("salvar"),
    async () => {
      const titulo = (($("looseTitle") && $("looseTitle").value) || "").trim();
      const tema = ($("looseDest") && $("looseDest").value) || "";
      if (!titulo) { toast(t("informe um título")); return; }
      try {
        const rel = await newNoteInIdea(tema, titulo, content);
        el.savebar.hidden = true;
        clearDoc();
        pessoalSig = ""; refreshPessoal();
        openDoc(rel, { preview: false });
        toast(`${t("salvo em")} ${rel}`, 5000);
      } catch (e) { toast(tErr(String(e))); clog("save loose transcript error: " + e); }
    }
  );
  const inp = $("looseTitle"); if (inp) { inp.focus(); inp.select(); }
}
// Exportar continua possível — com o nome do que faz. O diálogo do sistema
// pertence a ESTA ação, não à que promete guardar no projeto.
async function exportTranscript() {
  const content = state.lines.join("\n\n") + "\n";
  if (!content.trim()) { toast(t("não há transcrição para salvar")); return; }
  try {
    const path = await invoke("save_transcript", { content });
    if (path) toast(`${t("salvo em")} ${path}`, 5000);
  } catch (e) { toast(t("falha ao salvar")); clog("export error: " + e); }
}
// Descartar joga fora de verdade. Antes só escondia a barra: as linhas ficavam
// no buffer, a gravação seguinte era APENDADA ao texto descartado, e qualquer
// sessão posterior — inclusive uma reunião — reabria o rodapé avulso com aquela
// sobra, para sempre (o buffer só era limpo ao salvar).
//
// F22 · e destruía a ÚNICA cópia da transcrição num clique, sem confirmação e
// sem desfecho — enquanto o mesmo ato, pedido em Configurações ("limpar
// transcrição"), pergunta antes e responde depois. Desde que a transcrição avulsa passou a virar nota de uma ideia, a
// transcrição TEM destino no projeto (uma nota de ideia), então descartar deixou
// de ser "a outra saída" e passou a ser uma perda de verdade: a folha diz o
// preço e o que existe em vez dela (DESIGN.md §1).
function discard() {
  if (!state.lines.length) { clearDoc(); return; }
  openModal(
    t("Descartar a transcrição?"),
    `<p class="pmnote">${t("apaga a única cópia do que foi transcrito nesta sessão — não pode ser desfeito.")}</p>` +
      `<p class="pmnote">${t("para guardar, feche esta folha e use “Salvar em ideias”.")}</p>`,
    t("descartar"),
    () => { clearDoc(); toast(t("transcrição descartada")); }
  );
}
// limpa buffer de transcrição E o timer (sessão salva começa do zero)
function clearDoc() { state.lines = []; render(); el.savebar.hidden = true; paintElapsed("00:00"); }
// "limpar transcrição" mora DENTRO de Configurações, que é uma página opaca em
// cima de tudo: clearDoc repinta a superfície de gravação atrás dela, então o
// clique não produzia nenhuma mudança visível — um botão aparentemente inerte que
// apagava a única cópia da transcrição. Agora diz o preço antes e o desfecho
// depois (DESIGN.md §1).
// N23 · o MESMO ato tinha duas aparências: o botão do rodapé confirmava na folha
// do app e este, em Configurações, num diálogo do sistema — fora do sistema de
// design e sem o caminho do que vai sumir (DESIGN.md §5).
function clearTranscript() {
  if (!state.lines.length) { toast(t("não há transcrição para limpar")); return; }
  openModal(
    t("Apagar a transcrição desta sessão?"),
    `<p class="pmnote">${t("apaga a única cópia do que foi transcrito nesta sessão — não pode ser desfeito.")}</p>` +
      `<p class="pmnote">${t("Não pode ser desfeito.")}</p>`,
    t("apagar"),
    () => { clearDoc(); toast(t("transcrição apagada")); }
  );
}

// ---- F7 · a ARIA acompanha a classe ----------------------------------------
// A seleção era escrita SÓ como `.on`: um estado que existe apenas em CSS não
// existe para a tecnologia assistiva (WCAG 4.1.2). Em Configurações o segmento é
// o ÚNICO controle (o <select id="mode"> é hidden) — inclusive o que decide se o
// chat pode rodar conectores externos e comandos fora da pasta do projeto.
// Os pintores moram em três lugares (shell.js, app.js e a restauração do boot),
// então o espelho observa a CLASSE em vez de depender de todos eles.
const ARIA_MIRROR = [
  ["#destNav .dest", "aria-current", "page", "false"],
  ["#cfgNav .cfgnavbtn", "aria-current", "true", "false"],
  ["#panelTabs .ptab", "aria-selected", "true", "false"],
  [".segrow .segbtn", "aria-pressed", "true", "false"],
  ["#bModes .tab", "aria-pressed", "true", "false"],
  ["#aiPanelBtn", "aria-expanded", "true", "false"],
  // C18 · a linha selecionada da árvore (markSel só trocava a classe) e a cor
  // escolhida do projeto também eram estado só-em-CSS.
  [".btree .bitem", "aria-selected", "true", "false"],
  [".swatches .swatch", "aria-pressed", "true", "false"],
];
function paintAriaState() {
  for (const [sel, attr, on, off] of ARIA_MIRROR) {
    document.querySelectorAll(sel).forEach((n) => n.setAttribute(attr, n.classList.contains("on") ? on : off));
  }
}
{
  const obs = new MutationObserver((recs) => {
    if (recs.some((r) => r.target.matches && ARIA_MIRROR.some(([sel]) => r.target.matches(sel)))) paintAriaState();
  });
  obs.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["class"] });
  paintAriaState();
}

// ---- F19 · foco das camadas modais -----------------------------------------
// Configurações é uma camada OPACA sobre o app inteiro (.cfgpage) e as folhas
// cobrem o conteúdo: sem inert, o Tab andava por dezenas de controles pintados
// por baixo delas — foco invisível e Enter agindo na tela de trás (WCAG 2.4.3/
// 2.4.7). `inert` tira a região do Tab E da árvore de acessibilidade de uma vez,
// que é o que aria-hidden sozinho não faz.
const INERT_BEHIND = ["appHead", "brainShell", "brainSetup", "aiGrip", "aiPanel", "termPanel"];
function setBackgroundInert(on) {
  for (const id of INERT_BEHIND) {
    const n = $(id);
    if (!n) continue;
    if (on) n.setAttribute("inert", ""); else n.removeAttribute("inert");
  }
}
const overlayStack = [];
// C3/C20 · o Escape fechava Configurações, a folha de confirmação, a paleta e a
// busca — cada uma com o seu próprio ouvinte — e NÃO fechava #editWrap, que é
// justamente a que prende o foco atrás de um fundo inert. Quem entra na pilha
// registra COMO se fecha, e um ouvinte só dispensa a camada do topo: uma folha
// nova não pode mais nascer sem Escape.
function enterOverlay(wrap, first, onEscape) {
  if (!wrap || overlayStack.some((o) => o.wrap === wrap)) return;
  overlayStack.push({ wrap, back: document.activeElement, onEscape });
  setBackgroundInert(true);
  const target = (typeof first === "function" ? first() : first)
    || wrap.querySelector("input, select, textarea, button, [href], [tabindex]:not([tabindex='-1'])");
  if (target) { try { target.focus(); } catch (_) {} }
}
function leaveOverlay(wrap) {
  const i = overlayStack.findIndex((o) => o.wrap === wrap);
  if (i < 0) return;
  const [gone] = overlayStack.splice(i, 1);
  // uma camada pode abrir outra (a paleta em cima de Configurações): o fundo só
  // volta a existir quando a última se fecha
  if (!overlayStack.length) setBackgroundInert(false);
  if (gone.back && gone.back.isConnected) { try { gone.back.focus(); } catch (_) {} }
}
// Só a camada do TOPO responde: a paleta (que fecha no seu próprio input, com
// preventDefault) fica no topo com Configurações embaixo, e sem esta regra um
// Escape fecharia as duas de uma vez.
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || !overlayStack.length) return;
  const top = overlayStack[overlayStack.length - 1];
  if (!top.onEscape) return;
  e.preventDefault();
  top.onEscape();
});
// R15/R23 · o Escape também dispensa um toast que está esperando o usuário — e
// só quando não há folha na frente: a camada do topo responde primeiro, pela
// mesma regra da pilha acima.
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || overlayStack.length) return;
  if (!el.toast || el.toast.hidden) return;
  e.preventDefault();
  clearToast();
});

// ---- popover do menu + folha de configurações ----
const cfgWrap = $("cfgWrap"), cfgClose = $("cfgClose"), acervoDir = $("acervoDir");
async function openCfg() {
  cfgWrap.hidden = false;
  enterOverlay(cfgWrap, cfgClose, closeCfg);
  cfgEnvSeen = false; // os checks de rede rodam de novo nesta visita, quando a seção aparecer
  document.querySelectorAll(".cfgsec").forEach((s) => (s.hidden = false));
  $("cfgPop").scrollTop = 0;
  markCfgNav("proj");
  try {
    const cfg = await invoke("brain_get_config");
    acervoDir.textContent = cfg ? cfg.brainDir : t("não configurado — crie um projeto");
    acervoDir.title = cfg ? cfg.brainDir : "";
  } catch (_) { acervoDir.textContent = "—"; }
  // seção projeto: nome ativo + paleta de cores
  const cur = acervos.find((a) => a.id === activeAcervo);
  $("cfgProj").textContent = cur ? cur.name : "—";
  drawProjColors(cur);
  // ADR-0005: autoContext tem efeito real no loop — dá para desligar aqui
  const autoCtx = $("cfgAutoContext");
  if (autoCtx) { autoCtx.checked = !!(cur && cur.autoContext); paintAutoContextHint(autoCtx.checked); }
  // sem pasta escolhida: mostra o destino padrão real (inbox do acervo)
  if (!settings.saveDir) {
    try { el.pickDir.textContent = await invoke("default_save_dir"); } catch (_) {}
  }
  // versão do app (para saber num relance se atualizou)
  try { const v = $("cfgVersion"); if (v) v.textContent = "v" + await invoke("app_version"); } catch (_) {}
  // 1g "IA e terminal": o comando do agente é por projeto (ADR-0003)
  try {
    const cfg2 = await invoke("brain_get_config");
    const ai = $("cfgAgentInput");
    if (ai) ai.value = (cfg2 && cfg2.agent) || "";
    const tb = $("cfgTicketBase");
    if (tb) tb.value = ticketBase();
  } catch (_) {}
  refreshModelManager();
}
// Configurações são UMA página com rolagem (pedido do dono, 2026-08-11): tudo
// visível, e a nav navega — clicar rola até a seção; rolar realça a seção na nav.
let cfgEnvSeen = false; // os checks de ambiente vão à rede (gh auth): uma vez por visita
function markCfgNav(sec) {
  document.querySelectorAll("#cfgNav .cfgnavbtn").forEach((b) => b.classList.toggle("on", b.dataset.sec === sec));
  if (sec === "git" && !cfgEnvSeen) { cfgEnvSeen = true; refreshEnv(true); }
}
function showCfgSection(sec) {
  document.querySelectorAll(".cfgsec").forEach((s) => (s.hidden = false));
  markCfgNav(sec);
  const target = document.querySelector(`.cfgsec[data-sec="${sec}"]`);
  if (target) {
    cfgScrollQuiet = true; // o clique decide o realce; o spy não disputa durante a rolagem
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    clearTimeout(cfgQuietTimer);
    cfgQuietTimer = setTimeout(() => { cfgScrollQuiet = false; }, 600);
  }
}
// R39 · A PORTA QUE UMA FRASE NOMEIA. «conecte o GitHub em Configurações» abria
// Configurações em «Projeto» — a seção «Versões e GitHub» é a última de sete, e é
// ela que nomeia cada bloqueio com o seu remédio («autenticar no Terminal»,
// «corrigir», «conectar»). Uma frase, uma porta, um destino: todas as saídas do
// fluxo de revisão passam por aqui (DESIGN.md §1 — todo caminho de erro tem saída,
// e ela chega onde diz que chega).
async function openCfgGit() {
  await openCfg();
  showCfgSection("git");
}
// scroll-spy: a seção ativa é a última cujo topo já passou pelo terço superior
let cfgScrollQuiet = false;
let cfgQuietTimer = 0;
let cfgSpyRaf = 0;
$("cfgPop").addEventListener("scroll", () => {
  if (cfgScrollQuiet || cfgSpyRaf) return;
  cfgSpyRaf = requestAnimationFrame(() => {
    cfgSpyRaf = 0;
    const pop = $("cfgPop");
    const cut = pop.getBoundingClientRect().top + pop.clientHeight / 3;
    let cur = null;
    document.querySelectorAll(".cfgsec").forEach((s) => {
      if (s.getBoundingClientRect().top <= cut) cur = s.dataset.sec;
    });
    if (cur) markCfgNav(cur);
  });
});
function drawProjColors(cur) {
  renderSwatches($("projColors"), cur ? cur.color : "", async (id) => {
    applyAccent(id);
    if (!cur) return;
    try {
      const av = await invoke("brain_set_color", { id: cur.id, color: id });
      acervos = av.acervos || [];
      const updated = acervos.find((a) => a.id === cur.id);
      drawProjColors(updated);
    } catch (e) { toast(tErr(String(e))); }
  });
}
function closeCfg() { cfgWrap.hidden = true; leaveOverlay(cfgWrap); }
cfgClose.addEventListener("click", closeCfg);

// ---- model manager (ADR-0006): show which models are installed and let the
// user download a missing one on demand (first-run friendly). Text lives in
// i18n (per-model notes keyed by id); arithmetic/ordering in modelui.js. ----
const MU = window.LoroModelUI || {};
const modelDownloading = new Set();
// per-model explanation (pt msgid; EN map translates it — i18n.js gettext style)
const MODEL_NOTES = {
  "large-v3-turbo": "mais preciso — melhor com sotaques e ruído (download maior)",
  "small": "mais rápido e leve — bom para notas rápidas do dia a dia",
};
async function refreshModelManager() {
  if (!el.modelManager) return;
  let list = [];
  try { list = (await invoke("list_models")) || []; } catch (_) { return; }
  el.modelManager.innerHTML = MU.sortModels(list).map((m) => {
    const note = t(MODEL_NOTES[m.id] || "");
    const size = MU.formatSize(m.sizeBytes);
    const rec = m.default ? `<span class="modeltag">${t("recomendado")}</span>` : "";
    let action;
    if (m.installed) {
      action = `<span class="modelok" title="${t("instalado")}">✓ ${t("instalado")}</span>`;
    } else if (modelDownloading.has(m.id)) {
      action = `<div class="modelprog"><div class="bar" data-bar="${esc(m.id)}"></div></div>`;
    } else {
      action = `<button class="abtn modeldl" data-dl="${esc(m.id)}">+ ${t("baixar")} · ${size}</button>`;
    }
    return `<div class="modelrow" data-model="${esc(m.id)}">
      <div class="modelinfo"><span class="modelhead"><span class="mono modelname">${esc(m.label)}</span>${rec}</span>
      <span class="modelnote">${esc(note)}</span></div>
      <div class="modelaction">${action}</div></div>`;
  }).join("");
  el.modelManager.querySelectorAll("[data-dl]").forEach((b) => {
    b.addEventListener("click", () => downloadModel(b.getAttribute("data-dl")));
  });
}
async function downloadModel(id) {
  if (!id || modelDownloading.has(id)) return;
  modelDownloading.add(id);
  refreshModelManager();
  try {
    await invoke("download_model", { model: id });
    toast(t("modelo baixado"));
  } catch (e) {
    toast(tErr(String(e)));
  } finally {
    modelDownloading.delete(id);
    refreshModelManager();
  }
}
listen("model-download-progress", (e) => {
  const p = e.payload || {};
  const bar = el.modelManager && el.modelManager.querySelector(`[data-bar="${p.model}"]`);
  if (bar) bar.style.width = MU.progressPercent(p.downloaded, p.total) + "%";
});
// C29 · a dica embaixo do interruptor explicava o comportamento DESLIGADO
// enquanto ele estava ligado — o preço declarado era o preço do outro ajuste
// (DESIGN.md §1: o preço está na cópia, e o estado não mente). A frase é escrita
// pelo estado, não pelo HTML.
function autoContextHint(on) {
  return on
    ? t("ligado: quando nada existente couber, a IA cria um tema novo e organiza o item nele")
    : t('desligado: quando nada existente couber, a IA deixa o item em "para organizar" e pede o tema a você');
}
function paintAutoContextHint(on) {
  const n = $("cfgAutoContextHint");
  if (!n) return;
  const box = $("cfgAutoContext");
  n.textContent = autoContextHint(on === undefined ? !!(box && box.checked) : !!on);
}
{
  const autoCtx = $("cfgAutoContext");
  if (autoCtx) autoCtx.addEventListener("change", async () => {
    paintAutoContextHint(autoCtx.checked);
    try {
      await invoke("brain_set_auto_context", { value: autoCtx.checked });
      const cur = acervos.find((a) => a.id === activeAcervo);
      if (cur) cur.autoContext = autoCtx.checked;
    } catch (e) { toast(tErr(String(e))); autoCtx.checked = !autoCtx.checked; paintAutoContextHint(autoCtx.checked); }
  });
}
cfgWrap.addEventListener("click", (e) => { if (e.target === cfgWrap) closeCfg(); });

function updateCfgLabel() {
  const m = el.model.value === "large-v3-turbo" ? "turbo" : "small";
  const src = { system: t("áudio do sistema"), meeting: t("reunião") }[el.source.value] || t("microfone");
  const modeLabel = el.mode.value === "file" ? t("gravar tudo") : t("ao vivo");
  const line = `${el.lang.value} · ${m} · ${src} · ${modeLabel}`;
  const sum = $("cfgSummary");
  if (sum) sum.textContent = line;
  const sub = $("cfgSub");
  if (sub) sub.textContent = line;
  el.cfgBtn.title = `${t("Configurações")} — ${el.lang.value} · ${m} · ${modeLabel}`;
}
// BR-8 · o selo diz o que está acontecendo com o áudio, e o tooltip diz o mesmo.
// O title vinha estático do HTML ("Modo sem armazenamento") e continuava
// afirmando isso enquanto o áudio ia para o disco: o texto e o tooltip têm de ter
// o mesmo dono (nó marcado data-i18n-dyn — applyI18n não toca nele).
// O áudio vai para o disco nestes três modos (diarização, "gravar tudo" e
// reunião) — um dono só para a condição, porque o selo de captura precisa da
// MESMA regra para saber quando o vermelho é verdade.
const audioGoesToDisk = () => state.recordForDiarize || state.fileMode || state.meetingMode;
function updatePrivacy() {
  // Durante uma captura quem é dono do selo é o MEDIDOR (● mic / ● reunião /
  // ⏸ pausada). Sem esta linha, qualquer repintura — trocar de idioma, marcar uma
  // caixa em Configurações — devolvia "grava áudio" no meio de uma reunião
  // PAUSADA, onde nada está sendo gravado (BR-8).
  if (state.running || meeting.active) return paintCaptureMeter();
  el.privacy.classList.remove("warn");
  delete el.privacy.dataset.meter;
  if (audioGoesToDisk()) {
    el.privacy.textContent = t("grava áudio");
    el.privacy.title = t("o áudio é apagado depois de transcrito");
    el.privacy.classList.add("warn");
  } else if (settings.autosave) {
    el.privacy.textContent = "auto-save";
    el.privacy.title = t("salvar automaticamente ao parar");
  } else {
    el.privacy.textContent = t("sem guardar áudio");
    el.privacy.title = t("Modo sem armazenamento");
  }
}

// ---- wiring ----
el.toggle.addEventListener("click", toggle);
el.cfgBtn.addEventListener("click", openCfg);
if ($("helpBtn")) $("helpBtn").addEventListener("click", () => openManual());
if (el.uiLang) el.uiLang.addEventListener("change", async (e) => {
  settings.uiLang = e.target.value; persistSettings();
  try { settings.uiLang = await invoke("ui_set_lang", { lang: e.target.value }); } catch (_) {}
  applyI18n();
  rerenderForLang();
});
el.saveBtn.addEventListener("click", save);
el.exportBtn.addEventListener("click", exportTranscript);
el.discardBtn.addEventListener("click", discard);
el.clearBtn.addEventListener("click", clearTranscript);
el.optScroll.addEventListener("change", (e) => {
  state.autoscroll = e.target.checked;
  settings.autoscroll = e.target.checked; persistSettings();
});
el.optTop.addEventListener("change", (e) => { if (getWin) getWin().setAlwaysOnTop(e.target.checked); });
el.optOverlay.addEventListener("change", (e) => invoke("toggle_overlay", { show: e.target.checked }));
$("optEchoCancel").addEventListener("change", (e) => {
  settings.micEchoCancel = e.target.checked;
  persistSettings();
  // vale na PRÓXIMA captura: trocar o modo de um stream vivo exigiria reabrir
  // o microfone no meio da gravação, e uma gravação não pode piscar.
  if (state.running || meeting.active) toast(t("vale na próxima gravação"));
});
el.optDiar.addEventListener("change", (e) => { state.recordForDiarize = e.target.checked; updatePrivacy(); });
// R21 · o seletor de fonte do rodapé de gravação nunca era ESCRITO a partir da
// configuração: ele mostrava "minha voz + áudio do sistema" enquanto a sessão
// captava só o microfone (system_audio=false no log). Os dois controles decidem a
// MESMA coisa, então têm um pintor só, e ele lê a fonte que vale.
function paintSourceSelectors() {
  el.source.value = settings.source;
  const rec = $("recSource");
  if (rec) rec.value = settings.source;
}
el.source.addEventListener("change", () => {
  settings.source = el.source.value; persistSettings(); paintSourceSelectors(); updateCfgLabel();
});

// A reunião depende do sidecar ScreenCaptureKit, que é de macOS (ADR-0005). Fora
// do macOS a opção sai do seletor em vez de deixar o usuário escolher e só
// descobrir no start, com um erro citando o nome interno do binário. Uma
// preferência salva apontando para reunião volta para microfone.
function applySourceAvailability() {
  if (!el.source) return;
  const meeting = el.source.querySelector('option[value="meeting"]');
  if (!meeting) return;
  const supported = hostOs === "macos";
  meeting.hidden = !supported;
  meeting.disabled = !supported;
  if (!supported && settings.source === "meeting") {
    settings.source = "mic";
    el.source.value = "mic";
    persistSettings();
    updateCfgLabel();
    clog("meeting source unavailable on " + hostOs + "; fell back to mic");
  }
}
el.mode.addEventListener("change", () => { settings.mode = el.mode.value; persistSettings(); updateCfgLabel(); });
el.model.addEventListener("change", () => { settings.model = el.model.value; persistSettings(); updateCfgLabel(); });
el.lang.addEventListener("change", () => { settings.lang = el.lang.value; persistSettings(); updateCfgLabel(); });
el.translate.addEventListener("change", () => { settings.translate = el.translate.checked; persistSettings(); });
el.autosave.addEventListener("change", async (e) => {
  settings.autosave = e.target.checked; persistSettings(); updatePrivacy();
  if (settings.autosave && !settings.saveDir) {
    try { settings.saveDir = await invoke("default_save_dir"); persistSettings(); applySettings(); } catch (_) {}
  }
});
el.pickDir.addEventListener("click", async () => {
  try {
    const dir = await invoke("pick_folder");
    if (dir) { settings.saveDir = dir; persistSettings(); applySettings(); }
  } catch (e) { clog("pick_folder error: " + e); }
});

// ============================ acervo (brain) ============================
// Layout tipo site de docs: árvore lateral (fila, contextos, fontes) + conteúdo.
const B = {
  main: $("brain"),
  setup: $("brainSetup"), shell: $("brainShell"),
  dirBtn: $("brainDirBtn"), dirInput: $("brainDirInput"), dirNote: $("brainDirNote"),
  ctxInput: $("brainCtxInput"), createBtn: $("brainCreateBtn"),
  nameInput: $("brainNameInput"), gitInput: $("brainGit"), wizLang: $("wizLang"),
  agentInput: $("brainAgentInput"), wizTemplates: $("wizTemplates"), wizTemplateHint: $("wizTemplateHint"),
  cancelBtn: $("brainCancelBtn"), wizTitle: $("wizTitle"), setupErr: $("brainSetupErr"),
  acervoBtn: $("acervoBtn"), acervoName: $("acervoName"), acervoMenu: $("acervoMenu"),
  gitBtn: $("gitBtn"), branchBtn: $("branchBtn"), proposeBtn: $("proposeBtn"), bMenu: $("bMenu"),
  ghCard: $("ghCard"), ghState: $("ghState"), ghChecks: $("ghChecks"),
  ghNotif: $("ghNotif"), ghCheck: $("ghCheck"),
  navQueue: $("navQueue"), navCtx: $("navCtx"),
  navSources: $("navSources"), navPessoal: $("navPessoal"), queueCount: $("navQueueCount"),
  home: $("bHome"), docWrap: $("bDocWrap"), doc: $("brainDoc"),
  crumb: $("bCrumb"), badge: $("bBadge"), modes: $("bModes"),
  viewBtn: $("bViewBtn"), editBtn2: $("bEditBtn"), editHost: $("bEditHost"),
  editBar: $("bEditBar"),
  gitBadge: $("bGit"),
  wsTabs: $("wsTabs"), wsBody: $("wsBody"),
  cmdk: $("cmdk"), cmdkInput: $("cmdkInput"), cmdkList: $("cmdkList"),
  find: $("bFind"), findInput: $("bFindInput"), findCount: $("bFindCount"),
  findPrev: $("bFindPrev"), findNext: $("bFindNext"), findClose: $("bFindClose"),
  editWrap: $("editWrap"), editTitle: $("editTitle"),
  editModalBar: $("editModalBar"), editModalHost: $("editModalHost"),
  editSave: $("editSave"), editCancel: $("editCancel"), editClose: $("editClose"),
};
let brainTab = false, brainPoll = null, lastSt = null, brainVisHook = false;
// ADR-0008 — the Knowledge Studio workspace. `ws` is plain and serializable;
// live CM6 handles and last-saved buffers live in side Maps keyed by tab id.
const HOME_REL = "__home__";          // sentinel rel for the pinned Home tab
const GUIDE_REL = "inbox/_prompt.md"; // the loop instructions, read/written via brain_*_guide
let ws = LoroWorkspace.empty();
const cmById = new Map();     // tab id -> live CM6 handle
const savedById = new Map();  // tab id -> last-saved text (drives the ● dirty dot)
// ADR-0009 — per-tab parsed front-matter (ref resolution + promovido badge);
// null when a doc has no (or malformed) front-matter.
const fmById = new Map();
const bOpen = new Set();   // nós expandidos da lateral
let sideSig = "";          // assinatura p/ não re-renderizar a lateral sem mudança
let acervos = [], activeAcervo = "", creatingNew = false, gitFiles = {}, wizColor = "";
// git no sistema (brain_git_state.available): a mesma autoridade que decide se o
// botão "salvar versão" existe decide o que a nota do TIME pode prometer
let gitAvailable = true;
// usage template picker state (ADR-0003): selected id, fetched list, and
// whether the user already edited the contexts field by hand.
// ADR-0005: "automático" is a synthetic FIRST option of the same
// picker (owner decision) — mutually exclusive with the verticals: it means
// autoContext=true + generico seeding (no predefined contexts; the loop
// creates/assigns them). No separate checkbox in the wizard anymore.
const AUTO_TEMPLATE_ID = "__auto";
let wizTemplate = AUTO_TEMPLATE_ID, wizTemplates = [], wizCtxDirty = false;
let lastEnvAcervo = null;

// R1/R5 · a paleta do projeto guarda IDENTIDADES, nunca valores de cor. Cada uma
// é um par de tokens por tema em style.css (--accent-<id> + --on-accent-<id>),
// medido por tokens.test.js: eram cinco hexes crus aqui, sem valor no escuro e
// sem tinta própria, e escolher âmbar deixava o único botão primário do app a
// 3,14:1. `id` é o que fica gravado no projeto ("" = o teal do tema).
const PALETTE = [
  { id: "", name: "teal", legacy: [] },
  { id: "blue", name: "azul", legacy: ["#2f6feb"] },
  { id: "purple", name: "roxo", legacy: ["#8957e5"] },
  { id: "amber", name: "âmbar", legacy: ["#bf8700"] },
  { id: "green", name: "verde", legacy: ["#2da44e"] },
  { id: "pink", name: "rosa", legacy: ["#cf4b8f"] },
];
// O que está gravado no projeto → a identidade da paleta. Instalações anteriores
// gravaram o hex cru, então as duas formas resolvem aqui; o que não estiver na
// paleta cai no padrão, em vez de pintar uma cor que ninguém mediu.
function accentId(stored) {
  const v = String(stored == null ? "" : stored).trim().toLowerCase();
  if (!v) return "";
  const hit = PALETTE.find((c) => (c.id && c.id === v) || c.legacy.includes(v));
  return hit ? hit.id : "";
}
// aplica a cor de acento do projeto ativo (data-accent no <html>)
function applyAccent(stored) {
  const id = accentId(stored);
  if (id) document.documentElement.setAttribute("data-accent", id);
  else document.documentElement.removeAttribute("data-accent");
}
function renderSwatches(container, current, onPick) {
  if (!container) return;
  const cur = accentId(current);
  container.innerHTML = PALETTE.map((c) =>
    `<button class="swatch${cur === c.id ? " on" : ""}" title="${t(c.name)}" aria-label="${t(c.name)}"
      data-accent="${c.id}" style="--sw:var(--accent-${c.id || "teal"})"></button>`).join("");
  container.querySelectorAll("[data-accent]").forEach((b) => (b.onclick = () => onPick(b.dataset.accent, b)));
  paintAriaState();   // C18 · a cor escolhida é um estado, não só uma classe
}

// ---- teclado dos menus flutuantes (F17 · WCAG 2.1.1/4.1.2) ------------------
// Todo menu ⋯ é uma pilha de <div class="fitem2"> com .onclick: o usuário de
// teclado chegava ao ⋯ (que É um <button>), abria o menu — e ficava preso, sem
// nenhum item focável e sem Escape. Renomear, mover, apagar, executar
// habilidade, analisar reunião e trocar de projeto só existem aqui.
// Por que papel em vez de <button>: um <button> por item traria de volta o cromo
// do navegador (fundo, borda, texto centrado) e as linhas de projeto CONTÊM um
// <button> (o × de remover) — controle dentro de controle é HTML inválido. O
// cromo é CSS, e a anatomia não muda por causa de acessibilidade (DESIGN.md §2).
// Então o item recebe o papel que seu comportamento já tem: role=menuitem dentro
// de role=menu, uma única entrada de foco e as setas (WAI-ARIA APG, menu).
let menuAnchor = null;
function menuItems(menu) {
  return [...menu.querySelectorAll(".fitem2, button")].filter((n) =>
    !n.hidden && !n.closest("[hidden]") &&
    !n.classList.contains("fstatic") && !n.classList.contains("off") &&
    !(n.classList.contains("fitem2") && n.classList.contains("muted")));
}
// `close` é opcional: um menu flutuante que NÃO é o #bMenu/#acervoMenu (o popover
// de anotação, ADR-0007) traz o seu próprio fechador, senão o Escape dele fecharia
// outro menu e devolveria o foco a um controle que não abriu nada.
// `opts.focus === false` abre o menu SEM levar o foco. Existe por um motivo
// medido: focar um botão colapsa a seleção do documento, então o popover de
// trecho — que nasce de uma seleção de mouse — apagava justamente o que o
// usuário acabou de selecionar (sem Ctrl+C e sem marca visual). Quem abre pelo
// teclado continua recebendo o foco, senão o menu fica intocável (N10).
function wireFloatMenu(menu, anchor, close, opts) {
  if (!menu) return;
  const dismiss = typeof close === "function" ? close : closeFloat;
  menu.setAttribute("role", "menu");
  const head = menu.querySelector(".fhead");
  if (head) {
    head.setAttribute("role", "presentation");
    menu.setAttribute("aria-label", head.textContent.trim());
    menu.dataset.autolabel = "1";
  } else if (menu.dataset.autolabel) {
    // o nó é reusado (innerHTML trocado): o nome vindo do cabeçalho de OUTRO menu
    // não pode ficar. Um nome escrito pelo próprio autor permanece — uma superfície
    // de leitura não ganha cabeçalho visível só para ter nome acessível (DESIGN.md §2)
    delete menu.dataset.autolabel;
    menu.removeAttribute("aria-label");
  }
  menu.querySelectorAll(".fsep").forEach((s) => s.setAttribute("role", "separator"));
  const items = menuItems(menu);
  for (const it of items) {
    it.setAttribute("role", "menuitem");
    it.tabIndex = -1;
    if (it.classList.contains("on")) it.setAttribute("aria-current", "true");
  }
  // Sem âncora (o menu de configurar áudio do sistema abre por conta do fluxo,
  // não de um controle): o foco entra no menu, e fechar não tem a quem voltar.
  // Quem tem fechador próprio guarda a sua âncora: o menuAnchor é do closeFloat, e
  // um clique fora chamaria focus() nela sem nada aberto.
  if (dismiss === closeFloat) menuAnchor = anchor || null;
  if (anchor) {
    anchor.setAttribute("aria-haspopup", "true");
    anchor.setAttribute("aria-expanded", "true");
  }
  menu.onkeydown = (e) => {
    // um campo dentro do menu (renomear) manda nas suas próprias teclas
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName) && e.key !== "Escape") return;
    const list = menuItems(menu);
    const at = list.indexOf(document.activeElement);
    const go = (i) => { const n = list[(i + list.length) % (list.length || 1)]; if (n) n.focus(); };
    if (e.key === "ArrowDown") { e.preventDefault(); go(at + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); go(at < 0 ? -1 : at - 1); }
    else if (e.key === "Home") { e.preventDefault(); go(0); }
    else if (e.key === "End") { e.preventDefault(); go(list.length - 1); }
    else if (e.key === "Enter" || e.key === " ") {
      if (list.includes(document.activeElement)) { e.preventDefault(); document.activeElement.click(); }
    } else if (e.key === "Escape") { e.preventDefault(); dismiss(); }
    else if (e.key === "Tab") dismiss();   // sair pelo Tab fecha e devolve o foco
  };
  // O foco ENTRA no menu — sem isto o teclado abria um menu que não podia tocar.
  if (opts && opts.focus === false) return;
  const first = menu.querySelector("input, textarea") || items[0];
  if (first) { try { first.focus({ preventScroll: true }); } catch (_) { first.focus(); } }
}
function closeFloat() {
  const inside = B.bMenu.contains(document.activeElement) || B.acervoMenu.contains(document.activeElement);
  B.bMenu.hidden = true; B.acervoMenu.hidden = true;
  const a = menuAnchor; menuAnchor = null;
  if (!a) return;
  a.setAttribute("aria-expanded", "false");
  // Devolver o foco só quando ele estava DENTRO do menu (ou perdido no <body>):
  // fechar por clique fora não pode roubar o foco de onde o usuário clicou.
  if (inside || document.activeElement === document.body) { try { a.focus(); } catch (_) {} }
}
// cliques DENTRO do menu nunca chegam ao clique-fora (mesmo com innerHTML trocado)
B.bMenu.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", (e) => {
  const outMenu = !e.target.closest("#bMenu") && !e.target.closest("[data-qmenu]") && !e.target.closest("[data-cmenu]");
  const outSwitch = !e.target.closest("#acervoSwitch");
  // fechar os dois passa pelo closeFloat: é ele que desfaz o aria-expanded do ⋯
  if (outMenu && outSwitch) return closeFloat();
  if (outMenu) B.bMenu.hidden = true;
  if (outSwitch) B.acervoMenu.hidden = true;
});

// ---- (i) ajuda: tooltip clicável --------------------------------------------
// Todo ".ghelp" abre um popover com o texto de data-tip; clicar de novo, clicar
// fora ou Esc fecha. Um único elemento reutilizado — o title nativo era
// invisível demais para cumprir o papel de explicar o fluxo.
const tipBox = document.createElement("div");
tipBox.className = "tipbox mono";
tipBox.hidden = true;
document.body.appendChild(tipBox);
function hideTip() { tipBox.hidden = true; tipBox._for = null; }
document.addEventListener("click", (e) => {
  const g = e.target.closest(".ghelp");
  if (!g) { hideTip(); return; }
  if (tipBox._for === g && !tipBox.hidden) { hideTip(); return; }
  const txt = g.dataset.tip || g.title || "";
  if (!txt) { hideTip(); return; }
  tipBox.textContent = txt;
  tipBox._for = g;
  tipBox.hidden = false;
  const r = g.getBoundingClientRect();
  const w = Math.min(300, window.innerWidth - 20);
  tipBox.style.maxWidth = w + "px";
  tipBox.style.left = Math.max(10, Math.min(r.left, window.innerWidth - w - 10)) + "px";
  tipBox.style.top = r.bottom + 6 + "px";
});
window.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });

// ---- welcome (first launch): the main features in one modal ----------------
// Shown once (settings.welcomeSeen); reopen anytime via the palette
// ("apresentação do Loro"). Content mirrors the manual's headline features.
function showWelcome() {
  const li = (msg) => `<li>${t(msg)}</li>`;
  openModal(
    t("Bem-vindo ao Loro 🦜"),
    `<ul class="welcome">` +
      li("Três destinos no topo: Início · Organizar · Conhecimento — capture, deixe a IA propor, aprove o que vira oficial.") +
      li("Gravar transcreve ao vivo, 100% local; o áudio nunca sai da sua máquina.") +
      li("Modelos de uso (vendas, engenharia, saúde…) moldam os temas e as regras do projeto na criação.") +
      li("O agente de IA é escolha sua por projeto: claude por padrão, ou qualquer CLI — inclusive modelos locais.") +
      li("Ações de IA analisam reuniões, respondem sobre o projeto e evoluem notas — pelo painel ✦ IA ou pelo menu ⋯.") +
      li("⌘/Ctrl+K abre a paleta — ela é a lista viva de tudo o que dá para fazer, com os atalhos ao lado.") +
    `</ul>` +
      `<p class="pmnote"><button id="welcomeManual" class="link mono strong">${t("abrir manual")}</button></p>`,
    t("começar"),
    () => {}
  );
  const m = $("welcomeManual");
  if (m) m.onclick = () => { closeModal(); openManual(); };
  settings.welcomeSeen = true; persistSettings();
}

// o acervo é a tela principal (sempre ativo); a transcrição vive no player (dock)
function initBrain() {
  brainTab = true;
  brainRefresh();
  if (!brainPoll) brainPoll = setInterval(brainRefresh, 10000);
  // volta a atualizar assim que a janela reaparece, para o gate de visibilidade
  // do brainRefresh não deixar a tela velha
  if (!brainVisHook) {
    brainVisHook = true;
    document.addEventListener("visibilitychange", () => { if (!document.hidden) brainRefresh(); });
  }
  if (!settings.welcomeSeen) setTimeout(showWelcome, 600);
}
el.liveCollapse.addEventListener("click", () => setLivePanel(false));

// ---- editor reutilizável (pendentes da fila / instruções do loop) ----
// ADR-0016: o modal usa o mesmo CM6 (e a mesma barra) da aba do Studio. O handle
// é criado a cada abertura e destruído no fechamento — o modal não guarda buffer.
let editOnSave = null, editCm = null;
function openEditor(title, content, onSave) {
  B.editTitle.textContent = title;
  editOnSave = onSave;
  // N8 · sem gravador não há o que salvar: o "salvar" cheio (a ÚNICA ação
  // primária da folha) descartava em silêncio, e uma barra de markdown de 16
  // botões pairava sobre um texto de leitura.
  const readOnly = typeof onSave !== "function";
  B.editSave.hidden = readOnly;
  B.editModalBar.hidden = readOnly;
  B.editCancel.textContent = readOnly ? t("fechar") : t("cancelar");
  B.editWrap.hidden = false;
  if (editCm) { try { editCm.destroy(); } catch (_) {} editCm = null; }
  editCm = window.LoroCM6.create({
    parent: B.editModalHost,
    doc: content || "",
    theme: cmTheme(),
    onSave: () => saveEditor(),
  });
  wireMdKeys(editCm);
  wireMdBar(B.editModalBar, () => editCm);
  // o editor já chamava o foco; o que faltava era tirar o app de trás do Tab
  enterOverlay(B.editWrap, () => null, closeEditor);
  requestAnimationFrame(() => editCm && editCm.focus());
}
function closeEditor() {
  B.editWrap.hidden = true;
  leaveOverlay(B.editWrap);
  editOnSave = null;
  if (editCm) { try { editCm.destroy(); } catch (_) {} editCm = null; }
}
B.editClose.addEventListener("click", closeEditor);
B.editCancel.addEventListener("click", closeEditor);
B.editWrap.addEventListener("click", (e) => { if (e.target === B.editWrap) closeEditor(); });
async function saveEditor() {
  if (!editOnSave) return closeEditor();
  const value = editCm ? editCm.getValue() : "";
  try { await editOnSave(value); closeEditor(); sideSig = ""; brainRefresh(); }
  catch (e) { toast(tErr(String(e))); clog("editor save error: " + e); }
}
B.editSave.addEventListener("click", saveEditor);
$("guideBtn").addEventListener("click", () => openGuideDoc());
// ADR-0013: "gerar contexto" — the fila → contexto step. Injects /loro-context
// into the terminal Claude (the /loro-context loop), which processes the whole
// queue into versioned contexts. Same terminal-skill pattern as analisar/responder.
// One function, two entry points: the home card CTA and the sidebar quick action.
// ADR-0005: "salvar anexos" is opt-in per run — reuses the existing _prompt.md
// guide plumbing (brain_read_guide/brain_write_guide) instead of new backend
// surface; the loop already archives/clears _prompt.md after each run (step 0
// of /loro-context), so this instruction is naturally one-shot.
const ANEXOS_GUIDE_LINE = "Nesta rodada, copie os anexos referenciados pelos itens processados para contexts/<c>/attachments/ (por item, use o contexto de destino desse item).";
async function genContextNow() {
  // ADR-0002 §5: an empty queue is refused loudly here, not just by disabled
  // buttons — there is nothing to generate context FROM, and the user must know.
  if (!lastSt || !lastSt.inbox || !lastSt.inbox.length) {
    toast(t("não há nada para organizar — envie uma reunião ou arquivos antes de gerar conhecimento"), 5000);
    return;
  }
  const saveAnexos = $("queueSaveAnexos");
  if (saveAnexos && saveAnexos.checked) {
    try {
      const cur = (await invoke("brain_read_guide").catch(() => "")) || "";
      if (!cur.includes(ANEXOS_GUIDE_LINE)) {
        await invoke("brain_write_guide", { content: cur ? `${cur}\n\n${ANEXOS_GUIDE_LINE}` : ANEXOS_GUIDE_LINE });
      }
    } catch (e) { clog("queueSaveAnexos guide write error: " + e); }
  }
  await dispatchAi(LoroBrainstorm.brainContextCmd(), t("transformando em conhecimento") + " — " + aiTargetHint());
}
{
  const gen = $("queueGenCtx");
  if (gen) gen.addEventListener("click", genContextNow);
}

const fmtWhen = (ms) => new Date(ms).toLocaleString(uiLocale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
// editável no app = só pendentes de texto na fila; o resto é gerado pelo loop
const isEditable = (p) => p.startsWith("inbox/") && /\.(md|txt)$/i.test(p);
const shortName = (n) => n.replace(/\.(md|txt)$/i, "").replace(/^\d{4}-\d{2}-\d{2}--?/, "");

// C5 · o nome acessível de um <button> vem do seu CONTEÚDO, não do title: os 19
// gatilhos "⋯" da tela calculavam todos o MESMO nome ("⋯"), e trocar o title
// (rodada anterior) não mudou isso — title é só dica de mouse. Cada gatilho diz
// agora de QUAL item ele é (WCAG 4.1.2 · 2.4.6). Um helper único porque são dez
// lugares que desenham a mesma linha de árvore.
function rowMenuHtml(attrs, label, actions) {
  const name = `${actions || t("ações")}: ${label}`;
  return `<button class="rowmenu" ${attrs} title="${esc(name)}" aria-label="${esc(name)}">⋯</button>`;
}

function groupMonths(files) {
  const m = new Map();
  for (const f of files) {
    const k = /^\d{4}-\d{2}/.test(f.name) ? f.name.slice(0, 7) : "outros";
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(f);
  }
  return new Map([...m.entries()].sort((a, b) => b[0].localeCompare(a[0])));
}

async function brainRefresh() {
  if (!brainTab) return;
  // Nada de trabalho enquanto a janela está oculta: cada passada dispara dois
  // processos git (estado + status por arquivo), e no Windows cada processo de
  // console custa um console host. Ficar fazendo isso em segundo plano é gasto
  // puro. Ao voltar para a frente, o listener abaixo atualiza na hora.
  if (typeof document !== "undefined" && document.hidden) return;
  // lista de acervos (projetos) para o seletor
  try {
    const av = await invoke("brain_list_acervos");
    acervos = av.acervos || []; activeAcervo = av.active || "";
  } catch (_) {}
  let st;
  try { st = await invoke("brain_status"); }
  catch (e) { clog("brain_status error: " + e); return; }
  lastSt = st;
  // se não há acervo configurado E não estamos criando um novo → wizard
  const showWizard = (!st.configured || creatingNew);
  // primeiro uso: o wizard aparece por aqui, sem passar por openNewAcervo — os
  // campos precisam do mesmo preparo (senão o seletor de modelos e as cores
  // ficam vazios numa instalação nova). wizInited trava o preparo por exibição:
  // este refresh roda a cada 10s e não pode apagar o que o usuário digitou.
  if (showWizard && !wizInited) {
    B.wizTitle.textContent = t("Crie seu primeiro projeto");
    B.cancelBtn.hidden = true;
    resetWizardFields();
    B.nameInput.focus();
  }
  if (!showWizard) wizInited = false;
  // ADR-0026 §20 — estrutura antiga: a tela para aqui. Não desenhar o casco é o
  // ponto: meio acervo na árvore é pior que uma tela que diz o que houve.
  const legado = !showWizard && !!st.legacyLayout;
  const gate = document.getElementById("brainLegacy");
  if (gate) {
    if (legado && gate.hidden) {
      gate.innerHTML = legacyGateHtml();
      const b = gate.querySelector("[data-migrate]");
      if (b) b.onclick = () => runMigration();
    }
    gate.hidden = !legado;
  }
  B.setup.hidden = !showWizard;
  B.shell.hidden = showWizard || legado;
  // 1j: sem projeto não há destinos, nem o que gravar, nem documento no painel
  document.getElementById("app").classList.toggle("firstrun", showWizard);
  renderSwitch();
  if (showWizard) return;
  renderHome(st);
  // git: estado geral + status por arquivo (cores estilo VSCode na árvore)
  invoke("brain_git_files").then((gf) => {
    const next = gf.files || {};
    if (JSON.stringify(next) !== JSON.stringify(gitFiles)) { gitFiles = next; sideSig = ""; }
  }).catch(() => {});
  invoke("brain_git_state").then((g) => {
    B.gitBtn.hidden = !g.available;
    // a nota do TIME segue a MESMA autoridade do botão: sem git no sistema não
    // existe "funciona local" nenhum para prometer
    gitAvailable = !!g.available;
    renderPanelTeamNote();
    if (g.available) {
      const st = versionBtnState(g, dirtyDocs());
      B.gitBtn.textContent = st.label;
      B.gitBtn.classList.toggle("warm", g.repo && g.pending > 0);
      B.gitBtn.disabled = st.disabled;
      B.gitBtn.title = st.title;
    }
    // ADR-0002 §2: the current branch is always visible; click to switch/create
    if (B.branchBtn) {
      B.branchBtn.hidden = !(g.available && g.repo && g.branch);
      // R40 · o MESMO nome que a Revisão dá ao mesmo rascunho. O ref cru do git ia
      // para a tela, com um prefixo que o app nunca explicou, no único lugar que
      // fala do rascunho enquanto a pessoa edita (DESIGN.md §4).
      if (g.branch) {
        B.branchBtn.innerHTML = draftChipHtml(g.branch, REV.def);
        B.branchBtn.setAttribute("aria-label", draftChipLabel(g.branch, REV.def));
      }
      paintHeadDraft(g.branch, REV.def);
    }
  }).catch(() => {
    B.gitBtn.hidden = true;
    if (B.branchBtn) B.branchBtn.hidden = true;
    paintHeadDraft("", "");
    gitAvailable = false;
    renderPanelTeamNote();
  });
  // GitHub: re-verifica o ambiente ao trocar de acervo (rede — só uma vez por acervo)
  if (activeAcervo !== lastEnvAcervo) { lastEnvAcervo = activeAcervo; envChecked = false; }
  refreshEnv();
  maybeRefreshNotifications();
  // seletor de contexto do envio (preserva escolha)
  const sel = $("importCtx"), chosen = sel.value;
  sel.innerHTML = `<option value="">${t("destino: a IA decide")}</option>` +
    st.contexts.map((c) => `<option value="${esc(c.name)}">${t("destino")}: ${esc(c.name)}</option>`).join("");
  sel.value = chosen && st.contexts.some((c) => c.name === chosen) ? chosen : "";
  // lateral: só re-renderiza quando os dados mudam (preserva expansões profundas)
  const sig = JSON.stringify([st.inbox.map((f) => f.name), st.contexts, st.meetings.length, st.notes.length,
    (st.entryDocs || []).map((f) => f.name)]);
  if (sig !== sideSig) { sideSig = sig; renderSidebar(st); }
  refreshPessoal();   // ADR-0009: produção (mundo pessoal) — self-gated por assinatura
  refreshTools();     // ADR-0005: ferramentas customizadas — self-gated por assinatura
  // ADR-0027 R59 · A REVISÃO ENTRA NO RELÓGIO. Este tique já relia
  // `brain_git_files` (é dele que vem o ponto de mudança não salva na lateral) e
  // nunca chamava `refreshMyChanges`, então a MESMA janela dizia duas coisas: a
  // lateral com o ponto aceso, o centro dizendo «tudo salvo» com o botão de salvar
  // desabilitado, e o seletor de rascunhos recusando toda troca com «salve uma
  // versão antes de trocar de rascunho». Três superfícies, um fato, duas respostas
  // — e nenhum controle de «atualizar» em nenhuma delas.
  //
  // As duas metades são autogatilhadas: `refreshMyChanges` repinta por assinatura,
  // e `refreshTeamReviews` responde do cache de 30s, então o tique de 10s custa
  // uma ida à rede a cada três passadas, não uma por passada.
  if (reviewOn()) { refreshMyChanges(); refreshTeamReviews(); }
  markSel();
}

// ---- os três destinos: Início · Organizar · Conhecimento --------------------
// ADR-0020 §3–7: saem as 4 estatísticas, "contextos mais ativos", o feed do
// loop, a faixa 1·2·3 e o ghCard. Cada destino tem UMA ação primária.
function renderHome(st) {
  const n = st.inbox.length;
  // badge de pendências na nav e na barra recolhida
  for (const id of ["destQueueBadge", "miniQueueBadge"]) {
    const b = $(id);
    if (b) { b.textContent = n; b.hidden = !n; }
  }
  renderDestHome(st, n);
  renderDestOrganize(st, n);
  renderDestKnowledge(st);
  renderDestReview();
  // rodapé da lateral: contagens funcionais (não decorativas)
  const skills = $("footSkillsN"), srcs = $("footSourcesN");
  if (skills) skills.textContent = lastToolFiles.length || "";
  if (srcs) srcs.textContent = st.meetings.length + st.notes.length || "";
}

// 1a — a porta de entrada é gravar; a faixa âmbar é o único chamado secundário.
function renderDestHome(st, n) {
  const bar = $("homePending");
  if (!bar) return;
  bar.hidden = !n;
  if (!n) return;
  $("homePendingN").textContent = n;
  // nomes gerados pelo loop são longos demais para a faixa: o que importa é
  // reconhecer a captura, não ler o caminho inteiro
  const short = (s) => (s.length > 30 ? s.slice(0, 29) + "…" : s);
  const names = st.inbox.slice(0, 2).map((f) => short(shortName(f.name))).join(t(" e "));
  $("homePendingTxt").textContent = n > 1
    ? `${t("capturas prontas para virar conhecimento do time")}${names ? " — " + names : ""}.`
    : `${t("captura pronta para virar conhecimento do time")}${names ? " — " + names : ""}.`;
}

// 1b — a fila como lista de cards; a IA propõe, você aprova.
function renderDestOrganize(st, n) {
  const list = $("orgList");
  if (!list) return;
  list.innerHTML = n
    ? st.inbox.map((f) => {
        const ed = /\.(md|txt)$/i.test(f.name);
        const dest = f.context ? `<i>${t("sugestão: conhecimento")} ${esc(f.context)}</i>` : t("a IA escolhe o destino");
        // Sem caixa de seleção: ela não era lida por ninguém e o botão processava
        // a fila INTEIRA. Desmarcar 4 de 5 itens e ver os 5 virarem conhecimento
        // é o controle mentindo sobre o que vai acontecer com o material do
        // usuário. Para tirar um item da fila existe o ⋯ da própria linha.
        return `<div class="orgrow">
            <span class="ocol">
              <span class="oname" data-doc="inbox/${esc(f.name)}">${esc(shortName(f.name))}</span>
              <span class="ometa">${bWhen(f.mtime)} · ${dest}</span>
            </span>
            <span class="oact">
              ${ed ? `<button class="link mono" data-doc="inbox/${esc(f.name)}">${t("abrir")}</button>` : ""}
              ${rowMenuHtml(`data-qmenu="${esc(f.name)}"`, shortName(f.name))}
            </span>
          </div>`;
      }).join("")
    : `<div class="orgempty">${t("nada para organizar — grave uma reunião, escreva uma nota ou traga arquivos")}</div>`;
  list.querySelectorAll("[data-doc]").forEach((el2) => (el2.onclick = (e) => { e.stopPropagation(); openDoc(el2.dataset.doc); }));
  list.querySelectorAll("[data-qmenu]").forEach((el2) => (el2.onclick = (e) => { e.stopPropagation(); openQueueMenu(el2, el2.dataset.qmenu); }));

  const gen = $("queueGenCtx");
  if (gen) gen.disabled = !n;
  const note = $("orgFootNote");
  if (note) {
    note.textContent = n
      ? `${n} ${n > 1 ? t("itens para organizar") : t("item para organizar")} · ${t("a IA propõe, você aprova")}`
      : t("nada para organizar");
  }
  const gen2 = $("queueGenCtx");
  if (gen2) gen2.title = n ? "" : t("não há nada para transformar ainda");
}

// 1c — só os temas oficiais. Sem logs, sem estatísticas (ADR-0020 §3–5).
function renderDestKnowledge(st) {
  const grid = $("knowGrid");
  if (!grid) return;
  grid.innerHTML = `<button class="knowadd" data-newctx>＋ ${t("Novo tema")}</button>` + st.contexts.map((c) => {
    const prop = ctxDirty(c.name)
      ? `<span class="kprop">${t("mudanças não salvas")}</span>` : "";
    const desc = c.summary || c.description || t("o conhecimento oficial deste tema");
    const srcs = (c.entries || 0) + (c.ideas || 0);
    // F5 — o card é a ação primária desta tela e era um <div> com onclick. Ele
    // CONTÉM o ⋯ (um <button>), então um <button> por fora seria HTML inválido:
    // o card recebe o papel que já tem, com nome próprio (sem o aria-label ele
    // seria lido inteiro, texto por texto) e Enter/Espaço abrindo o tema.
    return `<div class="knowcard" role="button" tabindex="0" data-kctx="${esc(c.name)}"
        aria-label="${esc(t("abrir conhecimento") + ": " + c.name)}">
        <span class="kt">${ico("context")} ${esc(c.name)}</span>
        <span class="kd">${esc(desc)}</span>
        <span class="kf">${srcs ? `${srcs} ${srcs > 1 ? t("fontes") : t("fonte")}` : t("ainda sem fontes")}${prop ? " " + prop : ""}<span class="kopen">${t("abrir")} →</span></span>
        ${rowMenuHtml(`data-cmenu="${esc(c.name)}" data-isctx="1"`, c.name)}
      </div>`;
  }).join("");
  grid.querySelectorAll("[data-kctx]").forEach((el2) => {
    el2.onclick = (e) => {
      if (e.target.closest("[data-cmenu]")) return;
      openDoc(`contexts/${el2.dataset.kctx}/context.md`, { preview: false });
    };
    el2.onkeydown = (e) => {
      if (e.target !== el2) return;   // o ⋯ de dentro cuida das suas teclas
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el2.click(); }
    };
  });
  grid.querySelectorAll("[data-cmenu]").forEach((el2) => (el2.onclick = (e) => {
    e.stopPropagation(); openCtxMenu(el2, el2.dataset.cmenu, false);
  }));
  const add = grid.querySelector("[data-newctx]");
  if (add) add.onclick = promptNewContext;
  // ADR-0026 · o mapa das ligações só faz sentido quando há conhecimento
  const map = $("knowMap");
  if (map) map.hidden = !st.contexts.length;
  paintKnowledgeGaps();
}

// ADR-0026 — o que o próprio conhecimento denuncia: o tema que ninguém cita (quem
// lê pelo mapa nunca chega até ele) e a ligação que aponta para um arquivo que não
// existe. A ADR-0020 §4 tirou da Home a estatística sem pergunta e sem ação; a
// diferença aqui é que cada linha É um defeito nomeado, com a porta do conserto
// ao lado. O nome do tema é o que se lê; o caminho fica no atributo, para a ação.
function knowledgeGapsHtml(graph) {
  const orphans = ((graph && graph.orphans) || []).filter(Boolean);
  const broken = ((graph && graph.broken) || []).filter((b) => b && b.from);
  if (!orphans.length && !broken.length) return "";
  const nameOf = (rel) => String(rel).replace(/^contexts\//, "").replace(/\/context\.md$/, "");
  const act = (rel) => `<button class="mini act" data-gapopen="${esc(String(rel))}">${t("abrir")}</button>`;
  let html = "";
  if (orphans.length) {
    html += `<h2 class="kmttl">${t("Conhecimento que ninguém cita")} <span class="mono">(${orphans.length})</span></h2>` +
      `<p class="hint">${t("nenhum outro tema aponta para estes — quem lê seguindo as ligações não chega até eles. Abra e escreva a ligação a partir do tema que entrega o trabalho para este.")}</p>` +
      `<ul class="gaplist">` + orphans.map((rel) =>
        `<li class="gaprow"><span class="gapname">${esc(nameOf(rel))}</span>${act(rel)}</li>`).join("") +
      `</ul>`;
  }
  if (broken.length) {
    html += `<h2 class="kmttl">${t("Ligações quebradas")} <span class="mono">(${broken.length})</span></h2>` +
      `<p class="hint">${t("o link aponta para um arquivo que não existe: quem clica chega a um beco sem saída. O conserto é no documento que cita.")}</p>` +
      `<ul class="gaplist">` + broken.map((b) =>
        `<li class="gaprow"><span class="gapname">${esc(nameOf(b.from))}</span>` +
        `<span class="gaparrow" aria-hidden="true">→</span>` +
        `<span class="gaptarget mono">${esc(String(b.target || ""))}</span>${act(b.from)}</li>`).join("") +
      `</ul>`;
  }
  return html;
}

// Estado relatado é estado recalculado: o grafo é lido do disco a cada passada
// (o backend revalida por mtime), e a assinatura evita repintar — o que apagaria
// o foco de quem está usando o teclado — quando nada mudou.
let gapsPainted = "";
async function paintKnowledgeGaps() {
  const box = $("knowGaps");
  if (!box) return;
  // varrer o disco por um destino que ninguém está vendo é gasto puro (o poll
  // roda a cada 10s); entrar no destino repinta na hora, por goDest.
  if (!window.LoroShell || LoroShell.destination() !== "knowledge") return;
  let graph = null;
  try { graph = await invoke("brain_knowledge_graph"); }
  catch (e) { clog("brain_knowledge_graph error: " + e); }
  // sem resposta, a seção some: os defeitos do projeto anterior não são deste.
  const html = graph ? knowledgeGapsHtml(graph) : "";
  const sig = activeAcervo + "|" + html;
  if (sig === gapsPainted) return;
  gapsPainted = sig;
  box.innerHTML = html;
  box.querySelectorAll("[data-gapopen]").forEach((b) =>
    (b.onclick = () => openDoc(b.dataset.gapopen, { preview: false })));
}

const bWhen = (ms) => {
  if (!ms) return "";
  try { return new Date(ms).toLocaleDateString(uiLocale(), { day: "2-digit", month: "short" }); }
  catch (_) { return ""; }
};

// ---- ícones Material (SVG inline, monocromático via currentColor) ----
const ICONS = {
  folder: "M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z",
  context: "M12 3L1 9l4 2.18v6L12 21l7-3.82v-6l2-1.09V17h2V9L12 3zm6.82 6L12 12.72 5.18 9 12 5.28 18.82 9zM17 15.99l-5 2.73-5-2.73v-3.72L12 15l5-2.73v3.72z",
  guide: "M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z",
  history: "M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z",
  idea: "M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z",
  ref: "M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2z",
  meeting: "M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z",
  note: "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h10l6-6V5c0-1.1-.9-2-2-2zm-5 14v-4h4l-4 4z",
  file: "M6 2c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z",
  archive: "M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z",
  // habilidades (ADR-0005) — a book with a bookmark marks the CONCEPT
  // (section title, rail cards), matching Claude's own skills icon (owner
  // request); file rows use their own icons below so the title never looks
  // like just another row.
  skill: "M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z",
  // built-in habilidade file — a puzzle piece (ships with the app).
  builtinskill: "M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z",
  // custom habilidade file — a star (authored by the user).
  customskill: "M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8-6.1-3.4-6.1 3.4 1.4-6.8-5.1-4.7 6.9-.8z",
};
function ico(name, extra = "") {
  const d = ICONS[name] || ICONS.file;
  return `<span class="nico ${extra}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg></span>`;
}
// classe de status git (estilo VSCode) para um caminho do acervo
// há mudança não commitada em algum arquivo sob este contexto/subárvore?
function ctxDirty(path) {
  const pre = "contexts/" + path + "/";
  return Object.keys(gitFiles).some((p) => p.startsWith(pre));
}
// ADR-0002 §6 — expanded sidebar rows: date + textual git status, rendered
// always but visible only when the sidebar is wide (CSS .bside.wide).
function gitLabel(path) {
  const c = gitClass(path);
  return c === "g-new" ? t("novo") : c === "g-mod" ? t("modificado") : c === "g-del" ? t("removido") : "";
}
function bMeta(mtime, path) {
  const bits = [];
  if (mtime) {
    try {
      bits.push(new Date(mtime).toLocaleDateString(uiLocale(), { day: "2-digit", month: "short", year: "numeric" }));
    } catch (_) {}
  }
  const g = gitLabel(path);
  if (g) bits.push(g);
  return bits.length ? `<span class="bmeta mono">${esc(bits.join(" · "))}</span>` : "";
}
function gitClass(path) {
  const code = gitFiles[path];
  if (!code) return "";
  if (code === "??" || code.startsWith("A")) return "g-new";
  if (code.startsWith("M") || code.endsWith("M") || code.startsWith("R")) return "g-mod";
  if (code.startsWith("D")) return "g-del";
  return "";
}
// ícone conforme o nome do arquivo/pasta dentro de um contexto
function fileIcon(name, isDir) {
  if (isDir) return name === "brainstorming" || name === "incubadora" ? "idea"
    : name === "referencias" ? "ref" : "folder";
  if (name === "context.md" || name === "guia.md") return "guide";
  if (name === "CHANGELOG.md") return "history";
  if (name === "CODEOWNERS") return "ref";
  return "file";
}

// monta a árvore a partir da lista plana de contextos ("engenharia/frontend" …)
function buildCtxTree(contexts) {
  const root = { children: new Map() };
  for (const c of contexts) {
    let node = root, path = "";
    const segs = c.name.split("/");
    segs.forEach((seg, i) => {
      path = path ? path + "/" + seg : seg;
      if (!node.children.has(seg))
        node.children.set(seg, { seg, path, children: new Map(), isCtx: false, entries: 0, ideas: 0 });
      node = node.children.get(seg);
      if (i === segs.length - 1) { node.isCtx = true; node.entries = c.entries; node.ideas = c.ideas; }
    });
  }
  return root;
}
// Nome de usuário, não nome de arquivo (ADR-0020): quem lê a lateral procura
// "o índice do projeto", não "INDEX.md" — o caminho continua no menu de cada
// linha e no title, para quem precisa dele.
function entryDocsHtml(files) {
  const docs = [
    { name: "INDEX.md", label: "índice do projeto" },
    { name: "TERMS.md", label: "índice remissivo" },
  ];
  const present = new Set((files || []).filter((f) => f && !f.dir).map((f) => f.name));
  return docs.filter((d) => present.has(d.name)).map((d) => {
    const label = t(d.label);
    return `<div class="bitem file ${gitClass(d.name)}" data-doc="${esc(d.name)}" title="${esc(d.name)}">` +
      `${ico("file")}<span class="bn">${esc(label)}</span>${pathMenuBtnHtml(d.name, label)}</div>`;
  }).join("");
}

function renderCtxForest(root) {
  return [...root.children.values()].sort((a, b) => a.seg.localeCompare(b.seg)).map(renderCtxNode).join("");
}
function renderCtxNode(node) {
  const key = "ctx:" + node.path, open = bOpen.has(key);
  const tw = ""; // sem setas laterais: expansão pelo clique; hierarquia pela indentação
  const icon = node.isCtx ? ico("context", "ac") : ico("folder", "ac");
  const nctx = node.isCtx ? (lastSt ? lastSt.contexts : []).find((c) => c.name === node.path) : null;
  // em vez da contagem de entradas do CHANGELOG (confundia), um ponto quando há
  // mudança não commitada na subárvore deste contexto (ADR-0005).
  const dot = ctxDirty(node.path) ? `<span class="gdot" title="${t("mudanças ainda não salvas em uma versão")}">●</span>` : "";
  const pills = (node.isCtx && nctx && nctx.seeded === false
    ? `<span class="pill soft" title="${t("pasta nova — clique para estruturar")}">${t("novo")}</span>` : "") + dot;
  const attr = node.isCtx ? `data-ctx="${esc(node.path)}"` : `data-fold="${esc(node.path)}"`;
  const kids = [...node.children.values()].sort((x, y) => x.seg.localeCompare(y.seg)).map(renderCtxNode).join("");
  // fill target only, NOT a tree level: the context's own files (contexto/
  // histórico/attachments) are siblings of its subcontexts — a .bchild here would
  // double-indent them and read as if they belonged to a subcontext.
  const holder = node.isCtx ? `<div data-ctxchild="${esc(node.path)}" ${open ? "" : "hidden"}></div>` : "";
  const arch = rowMenuHtml(`data-cmenu="${esc(node.path)}" data-isctx="${node.isCtx ? 1 : 0}"`,
    node.seg, t("ações (renomear, mover, deletar)"));
  return `<div class="bitem ${node.isCtx ? "ctx" : "grp"}${open ? " open" : ""}" ${attr} title="${esc(node.path)}">
      <span class="tw">${tw}</span>${icon}<span class="bn">${esc(node.seg)}</span>${pills}${arch}
    </div>
    <div class="bchild" ${open ? "" : "hidden"}>${kids}${holder}</div>`;
}

function renderSidebar(st) {
  // fila (editável)
  B.queueCount.textContent = st.inbox.length;
  B.queueCount.hidden = st.inbox.length === 0;
  B.navQueue.innerHTML = st.inbox.length
    ? st.inbox.map((f) => {
        const ed = /\.(md|txt)$/i.test(f.name);
        return `<div class="bitem file unsynced${ed ? " ed" : ""}" data-doc="inbox/${esc(f.name)}"
          title="${ed ? t("não sincronizado — clique para editar") : t("não sincronizado (aguardando o loop)")}">${ico("file")}<span class="bn">${esc(f.name)}${bMeta(f.mtime, "inbox/" + f.name)}</span>
          ${rowMenuHtml(`data-qmenu="${esc(f.name)}" data-move="${esc(f.name)}"`, shortName(f.name))}</div>`;
      }).join("")
    // R8 · a MESMA ação ("Transformar em conhecimento") aparecia duas vezes na
    // tela ao mesmo tempo — aqui, como linha tracejada de "acrescentar", e em
    // Organizar, como o único botão cheio. Duas aparências para um passo
    // irreversível (o acervo é versionado, ADR-0024) deixam o usuário adivinhando
    // se a linha faz algo menor. Quem sobrevive é o botão: ele é a ação primária
    // do destino que mostra A FILA sobre a qual ela age, com a contagem e o preço
    // ao lado (DESIGN.md §5 e §1). A lateral lista, o destino age — e o ⌘K
    // continua sendo o caminho de teclado.
    : `<div class="bempty">${t("nada para organizar — grave uma reunião, escreva uma nota ou traga arquivos")}</div>`;
  // ADR-0026 · a porta de entrada do projeto. O `INDEX.md` é o documento por onde
  // o protocolo manda TODO mundo começar — e foi o maior ganho isolado da
  // medição (acerto de 0,17 para 0,50 ao descrever os 80 temas). Ele estava em
  // disco, era reescrito pelo loop a cada passada e não aparecia em lugar nenhum
  // da interface: a árvore desenha temas, e a raiz do acervo não é um tema. O
  // único caminho era o ⌘K, para quem já soubesse o nome do arquivo — o app
  // sabendo e não dizendo (DESIGN.md §1). Vem ANTES dos temas porque é por onde
  // se começa, e some quando o arquivo não existe.
  // contextos como ÁRVORE: pastas/áreas agrupam; contextos reais abrem o guia.
  // Criação vive no ＋ do cabeçalho da seção (linhas cheias poluíam a árvore).
  B.navCtx.innerHTML =
    entryDocsHtml(st.entryDocs) +
    (st.contexts.length
      ? renderCtxForest(buildCtxTree(st.contexts))
      : `<div class="bempty">${t("nenhum tema ainda — crie o primeiro para organizar o conhecimento")}</div>`);
  // fontes agrupadas por mês (escala p/ listas grandes)
  B.navSources.innerHTML = [["meetings", st.meetings], ["notes", st.notes]].map(([kind, files]) => {
    if (!files.length) return "";
    const kKey = "src:" + kind, kOpen = bOpen.has(kKey);
    const groups = groupMonths(files);
    const inner = [...groups.entries()].map(([m, fs]) => {
      const gKey = kKey + ":" + m, gOpen = bOpen.has(gKey);
      return `<div class="bitem grp${gOpen ? " open" : ""}" data-toggle="${gKey}">
          ${ico("folder")}<span class="bn">${esc(m)}</span><span class="pill">${fs.length}</span></div>
        <div class="bchild" ${gOpen ? "" : "hidden"}>` +
        fs.map((f) => `<div class="bitem file ${gitClass(f.path)}" data-doc="${esc(f.path)}" title="${esc(f.name)}">${ico("file")}<span class="bn">${esc(shortName(f.name))}${bMeta(f.mtime, f.path)}</span>${pathMenuBtnHtml(f.path, shortName(f.name))}</div>`).join("") +
        `</div>`;
    }).join("");
    return `<div class="bitem ctx${kOpen ? " open" : ""}" data-toggle="${kKey}">
        ${ico(kind === "meetings" ? "meeting" : "note", "ac")}<span class="bn">${kind === "meetings" ? t("reuniões") : t("notas")}</span><span class="pill">${files.length}</span></div>
      <div class="bchild" ${kOpen ? "" : "hidden"}>${inner}</div>`;
  }).join("") || `<div class="bempty">${t("reuniões e notas aparecem aqui quando o loop organizar o que você capturou")}</div>`;
  wireSidebar();
  // re-carrega filhos dos contextos abertos
  for (const c of st.contexts) if (bOpen.has("ctx:" + c.name)) loadCtxChildren(c.name);
}

// ---- teclado da árvore lateral (F18 · WCAG 2.1.1) ---------------------------
// Expandir uma pasta, abrir um tema ou uma ideia era impossível sem mouse: as
// linhas são <div class="bitem"> com .onclick. Elas CONTÊM um <button
// class="rowmenu"> (o ⋯), então um <button> por fora seria controle dentro de
// controle — HTML inválido — e o cromo da linha é CSS, que este conserto não
// muda (DESIGN.md §2). A linha recebe então o papel que seu comportamento já
// tem: uma árvore de verdade, com UMA parada de Tab por árvore e as setas
// andando e expandindo (WAI-ARIA APG, tree).
function treeRows(tree) {
  return [...tree.querySelectorAll(".bitem")].filter((r) => !r.closest("[hidden]"));
}
function wireTreeKeyboard(root) {
  if (!root) return;
  root.querySelectorAll(".btree").forEach((tree) => {
    const rows = [...tree.querySelectorAll(".bitem")];
    // uma árvore vazia (só o texto de vazio) não é uma árvore
    if (!rows.length) { tree.removeAttribute("role"); return; }
    tree.setAttribute("role", "tree");
    tree.querySelectorAll(".bchild").forEach((g) => g.setAttribute("role", "group"));
    const visible = treeRows(tree);
    const cur = visible.find((r) => r.classList.contains("on")) || visible[0];
    for (const row of rows) {
      row.setAttribute("role", "treeitem");
      row.tabIndex = row === cur ? 0 : -1;
      const kids = row.nextElementSibling;
      if (kids && kids.classList.contains("bchild")) row.setAttribute("aria-expanded", String(!kids.hidden));
      else row.removeAttribute("aria-expanded");
      row.onkeydown = (e) => onTreeKey(e, tree, row);
    }
  });
}
function onTreeKey(e, tree, row) {
  const rows = treeRows(tree);
  const at = rows.indexOf(row);
  const focus = (i) => {
    const n = rows[i];
    if (!n) return;
    for (const r of rows) r.tabIndex = -1;
    n.tabIndex = 0; n.focus();
  };
  const open = row.getAttribute("aria-expanded");
  if (e.key === "ArrowDown") { e.preventDefault(); focus(at + 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); focus(at - 1); }
  else if (e.key === "Home") { e.preventDefault(); focus(0); }
  else if (e.key === "End") { e.preventDefault(); focus(rows.length - 1); }
  else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activateTreeRow(row); }
  else if (e.key === "ArrowRight") {
    // C21 · ArrowRight ATIVAVA o nó: abria o context.md do tema e jogava o foco
    // dentro do editor, então quem navegava pelo teclado não conseguia olhar
    // dentro de um tema sem ser teleportado. Pelo padrão tree do WAI-ARIA APG,
    // num nó fechado ele apenas EXPANDE (o foco fica), e num nó aberto vai para
    // o primeiro filho — nunca ativa.
    if (open === "false") { e.preventDefault(); expandTreeRow(row); }
    else if (open === "true") { e.preventDefault(); focus(at + 1); }
  } else if (e.key === "ArrowLeft" && open === "true") { e.preventDefault(); activateTreeRow(row); }
}
// A chave de "está aberto" de cada tipo de linha, do jeito que o clique dela
// escreve em bOpen. Expandir é só isso — abrir um documento é outra ação.
const TREE_OPEN_KEY = {
  ctx: (v) => "ctx:" + v,
  fold: (v) => "ctx:" + v,
  toggle: (v) => v,
  pestoggle: (v) => v,
  tema: (v) => "pes:tema:" + v,
};
function expandTreeRow(row) {
  const mark = Object.keys(TREE_OPEN_KEY).find((k) => row.dataset[k] !== undefined);
  if (!mark) return;
  const val = row.dataset[mark];
  const key = TREE_OPEN_KEY[mark](val);
  if (bOpen.has(key)) return;
  bOpen.add(key);
  const refocus = () => {
    const again = [...document.querySelectorAll(".bitem")].find((r) => r.dataset[mark] === val);
    if (again) { again.tabIndex = 0; try { again.focus(); } catch (_) {} }
  };
  // pestoggle/tema abrem no lugar (o irmão .bchild); ctx/fold/toggle redesenham
  // a lateral inteira, e aí a linha focada deixa de existir.
  if (mark === "pestoggle" || mark === "tema") {
    row.classList.add("open");
    const child = mark === "tema"
      ? [...document.querySelectorAll("[data-temachild]")].find((h) => h.dataset.temachild === val)
      : row.nextElementSibling;
    if (child) child.hidden = false;
    row.setAttribute("aria-expanded", "true");
    if (mark === "tema") loadTemaChildren(val);
    return;
  }
  sideSig = ""; renderSidebar(lastSt); markSel();
  if (mark === "ctx") loadCtxChildren(val);
  requestAnimationFrame(refocus);
}
// Expandir REDESENHA a lateral: o nó que tinha o foco deixa de existir e o foco
// cairia no <body> — a árvore inteira se perderia a cada expansão. Reencontramos
// a mesma linha pela sua chave depois do redesenho.
function activateTreeRow(row) {
  const mark = ["ctx", "fold", "toggle", "pestoggle", "tema", "doc"].find((k) => row.dataset[k] !== undefined);
  const val = mark ? row.dataset[mark] : null;
  row.click();
  if (!mark) return;
  requestAnimationFrame(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    const again = [...document.querySelectorAll(".bitem")].find((r) => r.dataset[mark] === val);
    if (again) { again.tabIndex = 0; again.focus(); }
  });
}

function wireSidebar() {
  B.main.querySelectorAll("[data-doc]").forEach((el2) => {
    // single-click opens an ephemeral preview tab; double-click promotes it (ADR-0008)
    el2.onclick = (e) => { if (e.target.closest("[data-qmenu]") || e.target.closest("[data-pathmenu]")) return; openDoc(el2.dataset.doc, { preview: true }); };
    el2.ondblclick = (e) => { if (e.target.closest("[data-qmenu]") || e.target.closest("[data-pathmenu]")) return; openDoc(el2.dataset.doc, { preview: false }); };
  });
  wirePathMenus();
  B.main.querySelectorAll("[data-qmenu]").forEach((el2) => (el2.onclick = (e) => {
    e.stopPropagation(); openQueueMenu(el2, el2.dataset.qmenu);
  }));
  B.main.querySelectorAll("[data-ctx]").forEach((el2) => (el2.onclick = async (e) => {
    if (e.target.closest("[data-cmenu]")) return;
    const name = el2.dataset.ctx, key = "ctx:" + name;
    const ctx = (lastSt ? lastSt.contexts : []).find((c) => c.name === name);
    if (bOpen.has(key)) { bOpen.delete(key); }
    else {
      bOpen.add(key);
      // pasta criada à mão (sem guia): completa a estrutura antes de abrir
      if (ctx && ctx.seeded === false) {
        try { await invoke("brain_add_context", { name }); } catch (_) {}
      }
      openDoc(`contexts/${name}/context.md`);
    }
    sideSig = ""; renderSidebar(lastSt); markSel();
  }));
  B.main.querySelectorAll("[data-cmenu]").forEach((el2) => (el2.onclick = (e) => {
    e.stopPropagation(); openCtxMenu(el2, el2.dataset.cmenu, el2.dataset.isctx !== "1");
  }));

  B.main.querySelectorAll("[data-addctx]").forEach((el2) => (el2.onclick = promptNewContext));
  // section-header ＋ buttons (compact creation, owner feedback 2026-07-28)
  if ($("addCtxBtn")) $("addCtxBtn").onclick = promptNewContext;
  if ($("addTemaBtn")) $("addTemaBtn").onclick = promptNewTema;
  // pasta/área (não é contexto): só expande/recolhe
  B.main.querySelectorAll("[data-fold]").forEach((el2) => (el2.onclick = (e) => {
    if (e.target.closest("[data-cmenu]")) return;
    const key = "ctx:" + el2.dataset.fold;
    if (bOpen.has(key)) bOpen.delete(key); else bOpen.add(key);
    sideSig = ""; renderSidebar(lastSt); markSel();
  }));
  B.main.querySelectorAll("[data-toggle]").forEach((el2) => (el2.onclick = () => {
    const key = el2.dataset.toggle;
    if (bOpen.has(key)) bOpen.delete(key); else bOpen.add(key);
    sideSig = ""; renderSidebar(lastSt); markSel();
  }));
  // ADR-0005: folder groups (folderGroupHtml) in the context tree toggle via
  // [data-pestoggle] just like in the brainstorming tree — expand/collapse the
  // next sibling (.bchild) in place, no full re-render.
  B.navCtx.querySelectorAll("[data-pestoggle]").forEach((el2) => (el2.onclick = () => {
    const key = el2.dataset.pestoggle, child = el2.nextElementSibling;
    if (bOpen.has(key)) { bOpen.delete(key); el2.classList.remove("open"); if (child) child.hidden = true; }
    else { bOpen.add(key); el2.classList.add("open"); if (child) child.hidden = false; }
  }));
  // ADR-0005: a context's anexos folder actions — create a note / import files.
  B.navCtx.querySelectorAll("[data-ctxaddnota]").forEach((el2) => (el2.onclick = (e) => {
    e.stopPropagation(); promptNewNoteInContext(el2.dataset.ctxaddnota, el2);
  }));
  B.navCtx.querySelectorAll("[data-ctxaddanexo]").forEach((el2) => (el2.onclick = (e) => {
    e.stopPropagation();
    const name = el2.dataset.ctxaddanexo;
    importAnexoFromComputer(`contexts/${name}/attachments`, () => {
      bOpen.add(`ctxfolder:${name}:anexos`); loadCtxChildren(name);
    });
  }));
  wireDrag();
  wireTreeKeyboard(B.main);
}

// arrastar item da fila → soltar em um contexto (roteia neste acervo)
function wireDrag() {
  B.navQueue.querySelectorAll("[data-move]").forEach((btn) => {
    const row = btn.closest(".bitem");
    if (!row) return;
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/loro", btn.dataset.move);
      e.dataTransfer.effectAllowed = "move";
    });
    // os botões dentro de uma linha draggable engoliam o clique no WebView:
    // impedimos que o mousedown neles inicie o arraste da linha
    row.querySelectorAll("button").forEach((b) => {
      b.draggable = false;
      b.addEventListener("mousedown", (e) => e.stopPropagation());
    });
  });
  B.navCtx.querySelectorAll("[data-ctx]").forEach((el2) => {
    el2.addEventListener("dragover", (e) => { e.preventDefault(); el2.classList.add("drop"); });
    el2.addEventListener("dragleave", () => el2.classList.remove("drop"));
    el2.addEventListener("drop", async (e) => {
      e.preventDefault(); el2.classList.remove("drop");
      const name = e.dataTransfer.getData("text/loro");
      if (!name) return;
      try { await invoke("brain_move_to_acervo", { name, targetId: activeAcervo, context: el2.dataset.ctx }); toast(`→ ${el2.dataset.ctx}`); sideSig = ""; brainRefresh(); }
      catch (err) { toast(tErr(String(err))); }
    });
  });
}

// filhos de um contexto: guia, histórico, brainstorming (1 nível, sob demanda)
async function loadCtxChildren(name) {
  const holder = [...B.navCtx.querySelectorAll("[data-ctxchild]")].find((h) => h.dataset.ctxchild === name);
  if (!holder) return;
  let entries = [];
  try { entries = await invoke("brain_list_dir", { rel: "contexts/" + name }); } catch (_) { return; }
  // subpastas que já são subdomínios (contextos) aparecem na ÁRVORE de contextos;
  // não as repetimos aqui como "pasta" — visualização única (ADR-0005).
  const ctxSet = new Set((lastSt && lastSt.contexts ? lastSt.contexts : []).map((c) => c.name));
  const pretty = { "context.md": t("conhecimento"), "guia.md": t("guia do domínio"), "CHANGELOG.md": t("histórico"), CODEOWNERS: t("donos"), brainstorming: t("ideias"), incubadora: t("ideias"), referencias: t("referências") };
  const order = (n) => n === "context.md" ? 0 : n === "guia.md" ? 0 : n === "CHANGELOG.md" ? 1 : n === "referencias" ? 2 : 3;
  entries.sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name));
  let html = "";
  for (const en of entries) {
    if (en.name === "attachments") continue; // ADR-0005: renderizado explicitamente abaixo, sempre visível
    if (en.dir) {
      if (ctxSet.has(name + "/" + en.name)) continue; // subdomínio: já está na árvore
      let files = [];
      try { files = await invoke("brain_list_dir", { rel: en.path }); } catch (_) {}
      files = files.filter((f) => !f.dir);
      if (!files.length) continue;
      html += `<div class="bitem grp open"><span class="tw">▾</span>${ico(fileIcon(en.name, true), "ac")}<span class="bn">${esc(pretty[en.name] || en.name)}</span><span class="pill">${files.length}</span></div><div class="bchild">` +
        files.map((f) => `<div class="bitem file ${gitClass(f.path)}" data-doc="${esc(f.path)}">${ico("file")}<span class="bn">${esc(shortName(f.name))}</span>${pathMenuBtnHtml(f.path, shortName(f.name))}</div>`).join("") + `</div>`;
    } else {
      html += `<div class="bitem file ${gitClass(en.path)}" data-doc="${esc(en.path)}">${ico(fileIcon(en.name, false))}<span class="bn">${esc(pretty[en.name] || en.name)}</span>${pathMenuBtnHtml(en.path, pretty[en.name] || en.name)}</div>`;
    }
  }
  // ADR-0005: um contexto também tem uma pasta `attachments/` — sempre visível, com
  // as mesmas ações de um brainstorming (＋ nova nota, ＋ do computador),
  // versionadas junto com o contexto.
  let anexos = [];
  try { anexos = ((await invoke("brain_list_dir", { rel: `contexts/${name}/attachments` })) || []).filter((f) => !f.dir); }
  catch (_) {}
  const anexRows = anexos.map((f) => `<div class="bitem file ${gitClass(f.path)}" data-doc="${esc(f.path)}" title="${esc(f.name)}">${ico("file")}<span class="bn">${esc(shortName(f.name))}</span>${pathMenuBtnHtml(f.path, shortName(f.name))}</div>`).join("");
  const anexActions =
    `<button class="bsaddbtn" data-ctxaddnota="${esc(name)}" title="${t("Escrever uma nota nos anexos deste tema")}">＋ ${t("nova nota")}</button>` +
    `<button class="bsaddbtn" data-ctxaddanexo="${esc(name)}" title="${t("Adicionar um arquivo do computador aos anexos deste tema")}">＋ ${t("do computador")}</button>`;
  html += folderGroupHtml(`ctxfolder:${name}:anexos`, t("anexos"), anexos.length, anexRows, t("nenhum anexo ainda"), anexActions, `contexts/${name}/attachments`);
  holder.innerHTML = html || `<div class="bempty">${t("vazio")}</div>`;
  wireSidebar();
  markSel();
}

// ============================ produção (mundo pessoal — ADR-0009) ============================
// A árvore da produção espelha pessoal/temas/<slug>/{reunioes,notas,anexos}
// + pessoal/avulso. É o mundo NÃO versionado (âmbar); clicar abre uma aba de preview.
// Só re-renderiza quando os dados mudam (assinatura) — a expansão é preservada em bOpen.
let pessoalSig = "";
// ADR-0013: the non-versioned world is "Brainstorming" (disk: brainstorming/).
// A brainstorming groups reuniões/notes/attachments; it can carry an
// optional categoria (UI-only grouping). Selection of parts -> one consolidated
// report -> the fila (see bsSelection / sendSelectionToQueue).
// ADR-0005: above this many brainstormings the always-expanded tree gets hard
// to scan — the search box appears and the list caps to the most recent
// until the user searches or asks to see all (owner feedback).
const PESSOAL_FILTER_THRESHOLD = 8;
let pessoalRawTemas = [], pessoalRawAvulso = [];
let pessoalFilterQuery = "", pessoalShowAll = false;
// As duas listagens que a assinatura da lateral consome. LoroBrainstorm.pessoalSig
// é pura e as recebe injetadas, para ser testável sem Tauri e sem DOM.
const pessoalWorld = {
  listDir: async (rel) =>
    ((await invoke("brain_list_dir", { rel })) || []).filter((f) => !f.dir).map((f) => f.name),
  listMeetings: async (slug) => (await invoke("brain_list_meetings", { slug })) || [],
};

async function refreshPessoal() {
  if (!brainTab) return;
  let temas = [], avulso = [];
  try { temas = (await invoke("brain_list_brainstorms")) || []; } catch (_) {}
  try { avulso = ((await invoke("brain_list_dir", { rel: "brainstorming/avulso" })) || []).filter((f) => !f.dir); }
  catch (_) {}
  const sig = await LoroBrainstorm.pessoalSig(temas, avulso.map((f) => f.name), bOpen, pessoalWorld);
  if (sig === pessoalSig) return;
  pessoalSig = sig;
  pessoalRawTemas = temas; pessoalRawAvulso = avulso;
  renderPessoal(temas, avulso);
}
function renderPessoal(allTemas, avulso) {
  const filterEl = $("pessoalFilter");
  if (filterEl) filterEl.hidden = allTemas.length <= PESSOAL_FILTER_THRESHOLD;
  const { items: temas, hiddenCount } = LoroBrainstorm.filterAndCapTemas(
    allTemas, pessoalFilterQuery, pessoalShowAll, PESSOAL_FILTER_THRESHOLD);
  // creation moved to the section header (＋, wired once at boot) — full-width
  // creation rows polluted the tree (owner feedback 2026-07-28)
  let html = "";
  if (temas.length || avulso.length) {
    // group brainstormings by their optional categoria (uncategorized last)
    for (const grp of LoroBrainstorm.groupByCategory(temas)) {
      if (grp.categoria !== "Sem categoria" || LoroBrainstorm.groupByCategory(temas).length > 1) {
        html += `<div class="bcat">${esc(grp.categoria === "Sem categoria" ? t("Sem categoria") : grp.categoria)}</div>`;
      }
      html += grp.items.map(renderTemaNode).join("");
    }
    if (hiddenCount > 0) {
      html += `<div class="bitem file" data-showalltemas>${ico("file")}<span class="bn">▾ ${t("ver todos")} (${allTemas.length})</span></div>`;
    }
    if (avulso.length) {
      const key = "pes:avulso", open = bOpen.has(key);
      html += `<div class="bitem ctx${open ? " open" : ""}" data-pestoggle="${key}">${ico("note", "ac")}<span class="bn">${t("avulso")}</span></div>` +
        `<div class="bchild" ${open ? "" : "hidden"}>` +
        avulso.map((f) => `<div class="bitem file" data-doc="${esc(f.path)}" title="${esc(f.name)}">${ico("file")}<span class="bn">${esc(shortName(f.name))}</span>` +
          `${rowMenuHtml(`data-artmenu="${esc(f.path)}" data-artlabel="${esc(f.name)}"`, f.name, t("ações (renomear, mover, copiar caminho, apagar)"))}</div>`).join("") +
        `</div>`;
    }
  } else if (pessoalFilterQuery) {
    html += `<div class="bempty">${t("nenhuma ideia encontrada para")} "${esc(pessoalFilterQuery)}"</div>`;
  } else {
    html += `<div class="bempty">${t("nenhuma ideia ainda — crie a primeira para reunir reuniões e notas")}</div>`;
  }
  B.navPessoal.innerHTML = html;
  wirePessoal();
  B.navPessoal.querySelectorAll("[data-showalltemas]").forEach((el2) => (el2.onclick = () => {
    pessoalShowAll = true; renderPessoal(pessoalRawTemas, pessoalRawAvulso);
  }));
  for (const t of temas) if (bOpen.has("pes:tema:" + t.slug)) loadTemaChildren(t.slug);
}
{
  const fi = $("pessoalFilter");
  if (fi) fi.addEventListener("input", () => {
    pessoalFilterQuery = fi.value; pessoalShowAll = false;
    renderPessoal(pessoalRawTemas, pessoalRawAvulso);
  });
}
function renderTemaNode(t) {
  const key = "pes:tema:" + t.slug, open = bOpen.has(key);
  const holder = `<div class="bchild" data-temachild="${esc(t.slug)}" ${open ? "" : "hidden"}></div>`;
  return `<div class="bitem ctx${open ? " open" : ""}" data-tema="${esc(t.slug)}" title="${esc(t.nome || t.slug)}">` +
    `${ico("idea", "ac")}<span class="bn">${esc(t.nome || t.slug)}</span>` +
    `${rowMenuHtml(`data-bsmenu="${esc(t.slug)}"`, t.nome || t.slug, window.LoroI18n.t("ações da ideia"))}</div>${holder}`;
}
// Dentro de um brainstorming a árvore é PLANA (revisão de UX sobre o ADR-0013):
// as reuniões aparecem direto no nível do brainstorming — com as notas da
// reunião (análises, respostas e qualquer documento gerado) logo abaixo de
// cada uma (ADR-0008). As pastas segmentadas (artefatos/, investigacoes/,
// perguntas/, relatorios/) deixaram de existir: eram atrito, não estrutura.
// A selectable part row: a checkbox (data-bssel/data-bskind) + the open target.
// A meeting row carries a ⋯ menu (renomear/apagar); files keep the plain ×.
function bsPartRow(kind, openRel, selRel, label, title, indent, meetingId, meetingStatus, mopen, meetingNotas) {
  // Uma reunião encerrada e SEM análise não tem o que expandir: a seta abria o
  // vazio. No lugar dela, a ação que falta — gerar a análise.
  const noNotes = meetingId && meetingStatus === "done" && !Number(meetingNotas || 0);
  // R19 · uma reunião interrompida (manifest travado em "recording") também não
  // tem o que expandir — e o que falta nela não é a análise, é encerrar.
  const interrupted = meetingId && meetingStatus === "interrupted";
  const act = meetingId
    ? (interrupted
        ? `<button class="rowgen warn" data-mtgclose="${esc(selRel)}" data-mtgid="${esc(meetingId)}" title="${t("a reunião foi interrompida — encerre para liberar analisar, enviar para organizar e mover")}">■ ${t("encerrar reunião")}</button>`
        : noNotes
        ? `<button class="rowgen" data-mtganalyse="${esc(selRel)}" data-mtgid="${esc(meetingId)}" title="${t("a IA lê a transcrição e escreve a análise")}">✦ ${t("analisar")}</button>`
        : `<button class="rowtoggle${mopen ? " open" : ""}" data-mtgtoggle="${esc(meetingId)}" title="${t("mostrar/ocultar as notas da reunião")}">▸</button>`) +
      rowMenuHtml(
        `data-mtgmenu="${esc(selRel)}" data-mtgid="${esc(meetingId)}" data-mtgtitle="${esc(label)}" data-mtgstatus="${esc(meetingStatus || "")}" data-mtgnotas="${esc(String(meetingNotas || 0))}"`,
        label, t("ações da reunião (analisar, perguntar, enviar para organizar…)"))
    : rowMenuHtml(`data-artmenu="${esc(selRel)}" data-artlabel="${esc(label)}"`, label, t("ações (renomear, apagar)"));
  const icon = kind === "reuniao" ? "meeting" : kind === "nota" ? "note" : "file";
  return `<div class="bitem file${indent ? " bsub" : ""}" data-doc="${esc(openRel)}" title="${esc(title)}">` +
    `<input type="checkbox" class="bschk" data-bssel="${esc(selRel)}" data-bskind="${kind}" title="${t("selecionar para organizar")}">` +
    `${ico(icon)}<span class="bn">${esc(label)}</span>` + act + `</div>`;
}
// Investigações/respostas de cada reunião são carregadas sob demanda (fechado
// por padrão) — a lateral crescia demais listando tudo sempre expandido, e a
// maior parte fica sem uso na maioria das sessões (feedback do owner).
async function loadTemaChildren(slug) {
  const holder = [...B.navPessoal.querySelectorAll("[data-temachild]")].find((h) => h.dataset.temachild === slug);
  if (!holder) return;
  let meetings = [];
  try { meetings = (await invoke("brain_list_meetings", { slug })) || []; } catch (_) {}
  let notas = [];
  try { notas = ((await invoke("brain_list_dir", { rel: `brainstorming/${slug}/notes` })) || []).filter((f) => !f.dir); }
  catch (_) {}
  // ADR-0005: three brainstorming folders — meetings/, notes/, attachments/.
  // attachments/ is fed by a habilidade (sincronizar, apresentação, artefato) or
  // by the user dropping files straight into the real folder on disk — no
  // dedicated "importar" UI for that second path.
  let anexos = [];
  try { anexos = ((await invoke("brain_list_dir", { rel: `brainstorming/${slug}/attachments` })) || []).filter((f) => !f.dir); }
  catch (_) {}
  let inner = "";
  // ADR-0005 (owner request): a pasta de verdade precisa estar visível na UI —
  // três grupos com ícone de pasta (reuniões/notes/attachments), cada um
  // colapsável (mesmo padrão `data-pestoggle` já usado para "avulso"). Cada
  // pasta traz sua PRÓPRIA ação de criação no topo do corpo (owner request:
  // "cada botão poderá existir dentro de cada uma das pastas"):
  //   reuniões → ● gravar · notas → ＋ nova · anexos → ⇄ sincronizar + ＋ do computador.
  let reunioesRows = "";
  const pendingMeetingFills = [];
  for (const m of meetings) {
    // título do manifest (renomeável); cai para o id humanizado quando ausente
    const title = LM.meetingTitleFromManifest({ titulo: m.titulo }, m.id);
    const label = title === m.id ? LM.meetingLabel(m.id, settings.uiLang) : title;
    const mkey = "mtg:" + m.id, mopen = bOpen.has(mkey);
    const mstatus = meetingEffectiveStatus(m.status, m.id, meeting);
    reunioesRows += bsPartRow("reuniao", livingRel(m.rel), m.rel, label, m.id, true, m.id, mstatus, mopen, m.notes);
    reunioesRows += `<div class="bchild" data-mtgchild="${esc(m.id)}" data-mtgrel="${esc(m.rel)}" ${mopen ? "" : "hidden"}></div>`;
    if (mopen) pendingMeetingFills.push([m.id, m.rel]);
  }
  const notasRows = notas.map((f) => bsPartRow("nota", f.path, f.path, shortName(f.name), f.name, true)).join("");
  const anexosRows = anexos.map((f) => bsPartRow("anexo", f.path, f.path, shortName(f.name), f.name, true)).join("");
  const reunioesActions = `<button class="bsaddbtn rec2" data-addmeeting="${esc(slug)}" title="${t("Gravar uma reunião nesta ideia (áudio 100% local)")}">● ${t("gravar reunião")}</button>`;
  const notasActions = `<button class="bsaddbtn" data-addnota="${esc(slug)}" title="${t("Escrever uma nota nesta ideia")}">＋ ${t("nova nota")}</button>`;
  const anexosActions =
    `<button class="bsaddbtn" data-syncdrive="${esc(slug)}" title="${t("Trazer uma nota de reunião externa (Google Drive/Gemini) para os anexos deste tema")}">⇄ ${t("sincronizar")}</button>` +
    `<button class="bsaddbtn" data-addanexo="${esc(slug)}" title="${t("Adicionar um arquivo do computador aos anexos deste tema")}">＋ ${t("do computador")}</button>`;
  // counts are suppressed in the brainstorming tree (0 = no pill) — owner
  // request; the contextos tree keeps its counts (loadCtxChildren).
  inner += folderGroupHtml(`bsfolder:${slug}:reunioes`, t("reuniões"), 0, reunioesRows, t("nenhuma reunião ainda"), reunioesActions, `brainstorming/${slug}/meetings`);
  inner += folderGroupHtml(`bsfolder:${slug}:notas`, t("notas"), 0, notasRows, t("nenhuma nota ainda"), notasActions, `brainstorming/${slug}/notes`);
  inner += folderGroupHtml(`bsfolder:${slug}:anexos`, t("anexos"), 0, anexosRows, t("nenhum anexo ainda"), anexosActions, `brainstorming/${slug}/attachments`);
  holder.innerHTML = inner;
  // fillMeetingChild queries the live DOM — must run AFTER innerHTML is set,
  // not while `inner` is still a string (the container doesn't exist yet).
  // E wirePessoal() só DEPOIS dele: as linhas que ele injeta (as análises e
  // relatórios em <reunião>/notes/) precisam ganhar o onclick também. Com o
  // wire antes, toda análise dentro de uma reunião expandida ficava inerte —
  // clicar não abria nada. O handler do data-mtgtoggle já fazia nesta ordem.
  for (const [id, rel] of pendingMeetingFills) await fillMeetingChild(id, rel);
  wirePessoal();
  markSel();
}
// A collapsible folder group in the sidebar (reuniões/notes/attachments) — a real
// folder icon + label + count, expand/collapse via the same [data-pestoggle]
// wiring already used for "avulso" (wirePessoal, no new JS needed there). The
// folder's own creation action(s) sit at the top of its body, so each button
// lives inside the folder it acts on (ADR-0005, owner request).
function folderGroupHtml(key, label, count, rowsHtml, emptyMsg, actionsHtml, rel) {
  const open = bOpen.has(key);
  const pill = count ? `<span class="pill">${count}</span>` : "";
  const actions = actionsHtml ? `<div class="bsadd">${actionsHtml}</div>` : "";
  return `<div class="bitem ctx${open ? " open" : ""}" data-pestoggle="${key}">${ico("folder", "ac")}<span class="bn">${label}</span>${pill}${rel ? pathMenuBtnHtml(rel, label) : ""}</div>` +
    `<div class="bchild" ${open ? "" : "hidden"}>${actions}${rowsHtml || `<div class="bempty sub">${emptyMsg}</div>`}</div>`;
}
// Busca e injeta investigações/respostas de UMA reunião no seu container
// (chamado ao expandir, e ao re-render de uma tema já expandida).
async function fillMeetingChild(meetingId, meetingRel) {
  const child = [...B.navPessoal.querySelectorAll("[data-mtgchild]")].find((h) => h.dataset.mtgchild === meetingId);
  if (!child) return;
  let inner = "";
  // ADR-0008: every skill-generated document lands in the meeting's notes/
  // (analyses, answers, any produced doc) — one flat folder, no artefatos/<kind>.
  let arts = [];
  try { arts = ((await invoke("brain_list_dir", { rel: `${meetingRel}/notes` })) || []).filter((a) => !a.dir); }
  catch (_) {}
  for (const a of arts) inner += bsPartRow("nota", a.path, a.path, shortName(a.name), a.name, true);
  child.innerHTML = inner || `<div class="bempty sub">${t("nada por aqui ainda")}</div>`;
  // Quem injeta, liga. As linhas daqui são as análises/relatórios da reunião, e
  // cada uma traz o seu ⋯ (data-artmenu) e o clique de abrir — que só existem
  // depois de wirePessoal(). Um dos dois chamadores ligava ANTES de injetar, e
  // o ⋯ do nível mais fundo nascia inerte. Ligar aqui dentro torna a ordem do
  // chamador irrelevante: não dá mais para injetar linha sem handler.
  // wirePessoal é idempotente (atribui .onclick, não empilha listener).
  wirePessoal();
}
// Selection of brainstorming parts to send to the fila (ADR-0013). A plain Set of
// acervo-relative rels; the parts' kinds are read back from the checkbox dataset.
let bsSelection = new Set();
function wirePessoal() {
  B.navPessoal.querySelectorAll("[data-doc]").forEach((el2) => {
    el2.onclick = (e) => {
      if (e.target.closest("[data-delpessoal]") || e.target.closest("[data-bssel]")) return;
      openDoc(el2.dataset.doc, { preview: true });
    };
    el2.ondblclick = () => openDoc(el2.dataset.doc, { preview: false });
  });
  B.navPessoal.querySelectorAll("[data-bssel]").forEach((chk) => {
    chk.checked = bsSelection.has(chk.dataset.bssel);
    chk.onclick = (e) => e.stopPropagation();
    chk.onchange = () => {
      bsSelection = LoroBrainstorm.toggleSelection(bsSelection, chk.dataset.bssel);
      renderSelectionBar();
    };
  });
  B.navPessoal.querySelectorAll("[data-delpessoal]").forEach((el2) => (el2.onclick = (e) => {
    e.stopPropagation(); delPessoal(el2.dataset.delpessoal);
  }));
  B.navPessoal.querySelectorAll("[data-artmenu]").forEach((el2) => (el2.onclick = (e) => {
    e.stopPropagation(); openArtefatoMenu(el2.dataset.artmenu, el2.dataset.artlabel, el2);
  }));
  B.navPessoal.querySelectorAll("[data-addmeeting]").forEach((el2) => (el2.onclick = (e) => {
    e.stopPropagation(); startMeetingFlow(el2.dataset.addmeeting);
  }));
  B.navPessoal.querySelectorAll("[data-bsmenu]").forEach((el2) => (el2.onclick = (e) => {
    e.stopPropagation(); openBsMenu(el2.dataset.bsmenu, el2);
  }));
  B.navPessoal.querySelectorAll("[data-mtgmenu]").forEach((el2) => (el2.onclick = (e) => {
    e.stopPropagation();
    openMeetingMenu(el2.dataset.mtgmenu, el2.dataset.mtgid, el2.dataset.mtgtitle, el2.dataset.mtgstatus, el2, el2.dataset.mtgnotas);
  }));
  B.navPessoal.querySelectorAll("[data-tema]").forEach((el2) => (el2.onclick = (e) => {
    if (e.target.closest("[data-bsmenu]")) return;
    const slug = el2.dataset.tema, key = "pes:tema:" + slug;
    const holder = [...B.navPessoal.querySelectorAll("[data-temachild]")].find((h) => h.dataset.temachild === slug);
    if (bOpen.has(key)) { bOpen.delete(key); el2.classList.remove("open"); if (holder) holder.hidden = true; }
    else {
      bOpen.add(key); el2.classList.add("open"); if (holder) holder.hidden = false;
      loadTemaChildren(slug);
      openTopicDoc(`brainstorming/${slug}`, { preview: true });
    }
    markSel();
  }));
  B.navPessoal.querySelectorAll("[data-pestoggle]").forEach((el2) => (el2.onclick = () => {
    const key = el2.dataset.pestoggle, child = el2.nextElementSibling;
    if (bOpen.has(key)) { bOpen.delete(key); el2.classList.remove("open"); if (child) child.hidden = true; }
    else { bOpen.add(key); el2.classList.add("open"); if (child) child.hidden = false; }
  }));
  wirePathMenus(B.navPessoal);
  B.navPessoal.querySelectorAll("[data-addtema]").forEach((el2) => (el2.onclick = promptNewTema));
  B.navPessoal.querySelectorAll("[data-addnota]").forEach((el2) => (el2.onclick = (e) => {
    e.stopPropagation(); promptNewNota(el2.dataset.addnota, el2);
  }));
  B.navPessoal.querySelectorAll("[data-syncdrive]").forEach((el2) => (el2.onclick = (e) => {
    e.stopPropagation(); promptSyncTool("drive", el2.dataset.syncdrive);
  }));
  B.navPessoal.querySelectorAll("[data-addanexo]").forEach((el2) => (el2.onclick = (e) => {
    e.stopPropagation();
    const slug = el2.dataset.addanexo;
    importAnexoFromComputer(`brainstorming/${slug}/attachments`, () => {
      bOpen.add(`bsfolder:${slug}:anexos`); loadTemaChildren(slug);
    });
  }));
  B.navPessoal.querySelectorAll("[data-mtganalyse]").forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const dir = currentMeetingDir(b.dataset.mtganalyse);
    const cmd = dir && LM.analyseOffer("analisar", dir);
    if (cmd) { runAiCommand(cmd, t("analisar reunião")); scheduleActionRefresh(); }
  }));
  B.navPessoal.querySelectorAll("[data-mtganalyse]").forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    // mesmo caminho do menu ⋯ (dirOverride explícito), já provado
    runMeetingSkill("analyse", b.dataset.mtgid, null, b.dataset.mtganalyse);
  }));
  // R19 · encerrar uma reunião interrompida: o mesmo caminho do menu ⋯
  B.navPessoal.querySelectorAll("[data-mtgclose]").forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    finishInterruptedMeeting(b.dataset.mtgid, b.dataset.mtgclose);
  }));
  B.navPessoal.querySelectorAll("[data-mtgtoggle]").forEach((el2) => (el2.onclick = async (e) => {
    e.stopPropagation();
    const id = el2.dataset.mtgtoggle, key = "mtg:" + id;
    const child = [...B.navPessoal.querySelectorAll("[data-mtgchild]")].find((h) => h.dataset.mtgchild === id);
    if (!child) return;
    if (bOpen.has(key)) {
      bOpen.delete(key); el2.classList.remove("open"); child.hidden = true;
    } else {
      bOpen.add(key); el2.classList.add("open"); child.hidden = false;
      await fillMeetingChild(id, child.dataset.mtgrel);
      wirePessoal(); markSel();
    }
  }));
  wirePessoalDnd();
  wireTreeKeyboard(B.navPessoal.parentElement || B.navPessoal);
}

// A folder-group key (data-pestoggle) → the acervo-relative directory a dropped
// file should move into. Only the flat file folders are valid targets; reuniões
// holds meeting FOLDERS, not loose files, so it is not droppable.
function pestoggleDestDir(key) {
  if (key === "pes:avulso") return "brainstorming/avulso";
  const m = /^bsfolder:(.+):(notas|anexos)$/.exec(key);
  return m ? `brainstorming/${m[1]}/${m[2]}` : null;
}

// Drag a movable file (notes/attachments/avulso/meeting-notes all carry
// data-artmenu) onto a folder-group header to move it (brain_move_pessoal).
// The drag handle is the file ICON, NOT the whole row: a draggable row makes
// the WebView interpret a slightly-moved click (common on trackpads) as a drag
// and swallow the `click`, so single-clicking a file would sometimes fail to
// open it. Keeping the row itself non-draggable makes click-to-open reliable;
// only the icon starts a move. Property assignment keeps this idempotent across
// the repeated wirePessoal() calls on persistent nodes.
function wirePessoalDnd() {
  // #47 — `data-artmenu` sits on the ⋯ BUTTON, never on the row, so the old
  // `.bitem.file[data-artmenu]` matched nothing and file drag never activated —
  // silently, since a zero-length forEach raises no error. Start from the button
  // and walk up, the same shape the meeting handle below uses.
  B.navPessoal.querySelectorAll("[data-artmenu]").forEach((btn) => {
    const row = btn.closest(".bitem.file");
    if (!row) return;
    row.draggable = false;
    const handle = row.querySelector(".nico");
    if (!handle) return;
    handle.draggable = true;
    handle.style.cursor = "grab";
    handle.title = t("arraste para mover");
    handle.ondragstart = (e) => {
      e.dataTransfer.setData("text/loro-file", row.dataset.doc);
      e.dataTransfer.effectAllowed = "move";
    };
  });
  // #44 — a REUNIÃO também arrasta, carregando a pasta inteira. Marcada com um
  // tipo de dado próprio (text/loro-meeting) para o alvo saber o que chegou: o
  // cabeçalho `reuniões` aceita só isto, e as pastas de arquivo só o outro.
  // `data-mtgmenu` fica no BOTÃO ⋯, não na linha — então parte-se do botão e
  // sobe-se para a `.bitem`. Um seletor `.bitem[data-mtgmenu]` não casa nada e
  // o arrastar nunca ativa, em silêncio (foi o que a revisão pegou aqui).
  B.navPessoal.querySelectorAll("[data-mtgmenu]").forEach((btn) => {
    const row = btn.closest(".bitem");
    if (!row) return;
    // gravando não arrasta: o backend recusa, e prometer o drop seria mentira
    if (btn.dataset.mtgstatus !== "done") return;
    row.draggable = false;
    const handle = row.querySelector(".nico");
    if (!handle) return;
    handle.draggable = true;
    handle.style.cursor = "grab";
    handle.title = t("arraste para mover");
    handle.ondragstart = (e) => {
      // o slug de origem viaja no TIPO: o dragover só enxerga `types`, então é
      // a única forma de o cabeçalho do PRÓPRIO brainstorming não acender
      const origem = (/^brainstorming\/([^/]+)\//.exec(btn.dataset.mtgmenu) || [])[1] || "";
      e.dataTransfer.setData(`text/loro-meeting-from-${origem}`, btn.dataset.mtgmenu);
      e.dataTransfer.setData("text/loro-meeting", btn.dataset.mtgmenu);
      e.dataTransfer.effectAllowed = "move";
    };
  });
  B.navPessoal.querySelectorAll("[data-pestoggle]").forEach((el2) => {
    const key = el2.dataset.pestoggle;
    // cabeçalho `reuniões`: aceita uma reunião de OUTRO brainstorming
    const mtgSlug = /^bsfolder:(.+):reunioes$/.test(key);
    if (mtgSlug) {
      el2.ondragover = (e) => {
        const tipos = [...e.dataTransfer.types];
        if (!tipos.includes("text/loro-meeting")) return;
        // não acender no brainstorming de origem: prometer um drop que não faz
        // nada é pior que não aceitar
        const destino = (/^bsfolder:(.+):reunioes$/.exec(key) || [])[1];
        if (tipos.includes(`text/loro-meeting-from-${destino}`)) return;
        e.preventDefault(); el2.classList.add("drop");
      };
      el2.ondragleave = () => el2.classList.remove("drop");
      el2.ondrop = async (e) => {
        e.preventDefault(); el2.classList.remove("drop");
        const rel = e.dataTransfer.getData("text/loro-meeting");
        if (!rel) return;
        const origem = (/^brainstorming\/([^/]+)\//.exec(rel) || [])[1] || "";
        const destino = LM.meetingDropTarget(key, origem);
        if (!destino) return;
        await moveMeetingTo(rel, destino);
      };
      return;
    }
    const dest = pestoggleDestDir(key);
    if (!dest) return;
    el2.ondragover = (e) => {
      // uma reunião arrastada não pertence aqui: não acender nem prometer o drop
      if (![...e.dataTransfer.types].includes("text/loro-file")) return;
      e.preventDefault(); el2.classList.add("drop");
    };
    el2.ondragleave = () => el2.classList.remove("drop");
    el2.ondrop = async (e) => {
      e.preventDefault(); el2.classList.remove("drop");
      const rel = e.dataTransfer.getData("text/loro-file");
      if (!rel) return; // uma reunião arrastada não chega aqui: tipo de dado distinto
      if (rel.split("/").slice(0, -1).join("/") === dest) return; // already here
      try {
        await invoke("brain_move_pessoal", { rel, destDir: dest });
        toast(t("movido"));
        pessoalSig = ""; refreshPessoal();
      } catch (err) { toast(tErr(String(err))); }
    };
  });
}

// ADR-0005: per-source copy for the /loro-sync modal. `required` gates
// the identifier field before injecting the command — drive is the only
// source where a blank identifier still means something (a broad search).
// Fontes usadas só quando a habilidade não declara as suas (habilidade antiga
// ou editada à mão sem argument-hint).
const SYNC_FALLBACK_FONTES = ["drive", "slack", "jira", "confluence"];
// Cópia por fonte conhecida. Uma fonte NOVA (acrescentada na habilidade) cai no
// padrão genérico de syncCopy() em vez de sumir do seletor.
const SYNC_TOOL_COPY = {
  drive: {
    title: "Sincronizar do Drive",
    desc: "traz o documento inteiro do Drive como anexo local, referenciado na nota.",
    field: "busca ou link (opcional)",
    placeholder: "ex.: nome da reunião, ou um link do Drive",
    required: false,
  },
  slack: {
    title: "Sincronizar canal (Slack)",
    desc: "escreve um resumo de uma mensagem/thread do Slack como anexo local, referenciado na nota.",
    field: "canal",
    placeholder: "ex.: #eng-loro",
    required: true,
  },
  jira: {
    title: "Sincronizar ticket (Jira)",
    desc: "escreve um resumo de um ticket do Jira (título, status, pontos-chave) como anexo local, referenciado na nota.",
    field: "chave do ticket ou link",
    placeholder: "ex.: PROJ-123",
    required: true,
  },
  confluence: {
    title: "Sincronizar página (Confluence)",
    desc: "escreve um resumo de uma página do Confluence como anexo local, referenciado na nota.",
    field: "título da página ou link",
    placeholder: "ex.: Ata da reunião de sprint",
    required: true,
  },
};

// "sincronizar" (ADR-0005): shared modal for the 4 built-in /loro-sync
// sources. Without `slug` (Visão Geral entry point), the modal also asks
// which brainstorming to target — with `slug` (the per-brainstorming button),
// the target is already known.
// Cópia da fonte: a conhecida quando existe, um padrão honesto quando é uma
// fonte nova declarada na habilidade. Nunca "return" silencioso — uma fonte que
// aparece no seletor tem de abrir alguma coisa.
function syncCopy(fonte) {
  return SYNC_TOOL_COPY[fonte] || {
    title: `${t("Sincronizar de")} ${fonte}`,
    desc: t("traz o item externo como anexo local, referenciado numa nota."),
    field: t("identificador ou link"),
    placeholder: t("ex.: um link, um canal, uma chave"),
    required: true,
  };
}
async function promptSyncTool(fonte, slug) {
  const cfg = syncCopy(fonte);
  let temaField = "";
  if (!slug) {
    let temas = [];
    try { temas = (await invoke("brain_list_brainstorms")) || []; } catch (_) {}
    if (!temas.length) { toast(t("crie uma ideia primeiro")); return; }
    temaField = `<label class="wfield"><span class="mono">${t("tema")}</span>` +
      `<select id="syncToolTema">` +
      temas.map((b) => `<option value="${esc(b.slug)}">${esc(b.nome)}</option>`).join("") +
      `</select></label>`;
  }
  openModal(
    t(cfg.title),
    `<p class="pmnote">${t(cfg.desc)}</p>` + temaField +
      `<label class="wfield"><span class="mono">${t(cfg.field)}</span>` +
      `<input id="syncToolInput" type="text" placeholder="${t(cfg.placeholder)}" spellcheck="false"></label>`,
    t("buscar"),
    () => {
      const alvo = slug || (($("syncToolTema") && $("syncToolTema").value) || "");
      const q = (($("syncToolInput") && $("syncToolInput").value) || "").trim();
      if (!alvo) { toast(t("informe o tema")); return; }
      if (cfg.required && !q) { toast(t("informe") + ": " + t(cfg.field)); return; }
      const cmd = LoroBrainstorm.syncCmd(fonte, alvo, q);
      if (!cmd) { toast(t("informe o tema")); return; }
      return dispatchAiFromSheet(cmd);
    }
  );
  const inp = $("syncToolInput"); if (inp) inp.focus();
}
// ============================ habilidades (ADR-0005) ============================
// A "habilidade" (UI label; code keeps the English "tool" per CLAUDE.md §6) is
// any .md in .claude/commands/ — the filename IS the slash-command. Built-ins
// (BUILTIN_SKILLS) can be edited but never deleted (brain_delete_tool already
// refuses them; the UI just hides the option); custom ones have full CRUD.
const TOOLS_DIR = ".claude/commands";
// One place decides what a habilidade's path looks like — the lister and the save
// path must agree, or the cache outlives the file it describes (N14).
function isHabilidadeRel(rel) {
  return /\.md$/.test(String(rel || "")) && String(rel).startsWith(TOOLS_DIR + "/");
}
const TOOL_BUILTINS = new Set([
  "loro-context.md", "loro-analyse.md", "loro-question.md",
  "loro-ask.md", "loro-note.md", "loro-sync.md", "loro-tool.md",
  "loro-presentation.md", "loro-artifact.md", "loro-slack.md",
  "loro-digest.md",
]);
// Subset offered by the generic "executar habilidade" picker (brainstorming/
// meeting ⋯ menus): the workflow-specific built-ins already have their own
// dedicated UI (nova nota, perguntar ao acervo, gerar contexto, analisar/
// perguntar na reunião) — repeating them here would just be noise. Only the
// generically "run against an alvo" built-ins + every custom tool show up.
const TOOL_PICKER_EXCLUDE = new Set([
  "loro-context.md", "loro-analyse.md", "loro-question.md",
  "loro-ask.md", "loro-note.md", "loro-tool.md",
  // loro-slack only makes sense with an excerpt alvo, reached from the
  // selection popover (ADR-0007) — never from the generic file-level picker.
  "loro-slack.md",
]);
// ADR-0020 §1 revogou o ADR-0011: /loro-digest saiu da UI POR INTEIRO — nem no
// seletor curado nem no irrestrito. O arquivo continua no disco (é editável como
// qualquer habilidade); nenhuma ação o oferece.
const TOOL_RETIRED = new Set(["loro-digest.md"]);
let toolsSig = "";
async function refreshTools() {
  if (!brainTab) return;
  let files = [];
  // N12 · a lista aceitava QUALQUER arquivo do diretório. Um `.anotacoes.json`
  // (o sidecar que nasce ao grifar a própria habilidade) virava uma habilidade
  // falsa: "usar" mandava /loro-ask.anotacoes.json ao agente e "excluir" só
  // sabia recusar (brain_delete_tool exige .md). Uma habilidade é um .md.
  try { files = ((await invoke("brain_list_dir", { rel: TOOLS_DIR })) || []).filter((f) => !f.dir && f.name.endsWith(".md")); }
  catch (_) { files = []; }
  const sig = JSON.stringify(files.map((f) => f.name));
  if (sig === toolsSig) return;
  toolsSig = sig;
  // description cached per file (used as the hover tooltip everywhere — the
  // picker never renders every description inline, only on :hover/title).
  const withDesc = await Promise.all(files.map(async (f) => {
    let desc = "", fontes = [];
    try {
      const raw = await invoke("brain_read", { rel: f.path });
      const m = /description:\s*(.+)/.exec(raw);
      if (m) desc = m[1].trim();
      // ADR-0005: a habilidade declara as fontes que aceita no seu argument-hint
      // (`<fonte:drive|slack|…>`). Quem edita a habilidade para acrescentar uma
      // fonte a vê no seletor — sem tocar no app.
      const a = /argument-hint:\s*(.+)/.exec(raw);
      const fm = a && /fonte:([a-z0-9|_-]+)/i.exec(a[1]);
      if (fm) fontes = fm[1].split("|").map((x) => x.trim()).filter(Boolean);
    } catch (_) {}
    return { ...f, builtin: TOOL_BUILTINS.has(f.name), desc, fontes };
  }));
  renderTools(withDesc);
}
function toolRow(f) {
  const label = habilidadeLabel(f);
  // puzzle = built-in, star = custom (ADR-0005): the origin is legible from
  // the icon alone, and neither repeats the section title's bolt; the
  // "padrão" pill stays as the textual reinforcement.
  return `<div class="bitem file" data-doc="${esc(f.path)}" title="${esc(f.desc || f.path)}">` +
    `${ico(f.builtin ? "builtinskill" : "customskill")}<span class="bn">${esc(label)}</span>` +
    (f.builtin ? `<span class="pill" title="${t("habilidade padrão")}">${t("padrão")}</span>` : "") +
    // N16 · o nome era fixo e prometia "excluir" nas 11 padrão, cujo menu não a
    // tem: o leitor de tela anunciava uma ação destrutiva que o menu recusa.
    rowMenuHtml(`data-toolmenu="${esc(f.path)}" data-toollabel="${esc(label)}" data-toolbuiltin="${f.builtin ? "1" : ""}"`,
      label, f.builtin ? t("ações (usar, editar, pedir à IA)") : t("ações (usar, editar, pedir à IA, excluir)")) +
    `</div>`;
}
let lastToolFiles = [];
function renderTools(files) {
  lastToolFiles = files;
  // as habilidades ficam sempre à vista no composer do chat (painel direito)
  try { renderChatChips(); } catch (_) {}
  const nav = $("navTools");
  if (nav) {
    nav.innerHTML = files.length
      ? files.map(toolRow).join("")
      : `<div class="bempty">${t("nenhuma habilidade ainda — crie uma com IA ou importe uma pronta (＋)")}</div>`;
  }
  wireTools();
  // N15 · depois de importar, o rodapé da lateral e o rótulo do painel seguiam na
  // contagem antiga até o usuário abrir OUTRO documento: quem sabe da lista nova
  // repinta quem a exibe, na hora.
  const foot = $("footSkillsN");
  if (foot) foot.textContent = files.length || "";
  const tab = activeTab();
  if (tab && tab.rel !== HOME_REL) renderDocRail(tab, tab.rel === GUIDE_REL);
}
function wireTools() {
  const nav = $("navTools");
  if (!nav) return;
  nav.querySelectorAll("[data-doc]").forEach((el2) => {
    el2.onclick = (e) => { if (e.target.closest("[data-toolmenu]")) return; openDoc(el2.dataset.doc, { preview: true }); };
    el2.ondblclick = () => openDoc(el2.dataset.doc, { preview: false });
  });
  nav.querySelectorAll("[data-toolmenu]").forEach((el2) => (el2.onclick = (e) => {
    e.stopPropagation();
    openToolMenu(el2.dataset.toolmenu, el2.dataset.toollabel, el2, !!el2.dataset.toolbuiltin);
  }));
  wireTreeKeyboard(nav.parentElement || nav);
}
// usar / editar / pedir à IA / (excluir, só se não for padrão) — same
// ⋯-menu spirit as openArtefatoMenu, scoped to a habilidade instead of a nota.
function openToolMenu(rel, label, anchor, builtin) {
  B.acervoMenu.hidden = true;
  B.bMenu.innerHTML =
    `<div class="fhead">${esc(label)}</div>` +
    `<div class="fitem2 strong" data-use><span class="fn">▶ ${t("usar")}</span></div>` +
    `<div class="fitem2" data-edit><span class="fn">✎ ${t("editar")}</span></div>` +
    `<div class="fitem2" data-ainote><span class="fn">✦ ${t("pedir à IA")}</span></div>` +
    `<div class="fsep"></div>` +
    copyPathItemsHtml() +
    (builtin
      ? `<div class="fnote">${t("habilidade padrão — não pode ser excluída")}</div>`
      : `<div class="fsep"></div><div class="fitem2 danger" data-del><span class="fn">${t("excluir")}</span></div>`);
  B.bMenu.querySelector("[data-use]").onclick = () => { closeFloat(); promptUseTool(rel); };
  B.bMenu.querySelector("[data-edit]").onclick = () => { closeFloat(); openDoc(rel, { preview: false }); };
  B.bMenu.querySelector("[data-ainote]").onclick = () => { closeFloat(); promptToolAI(rel); };
  wireCopyPathItems(rel);
  if (!builtin) B.bMenu.querySelector("[data-del]").onclick = () => { closeFloat(); delTool(rel); };
  placeMenu(anchor);
}
// N16/N23 · era um window.confirm: um diálogo do sistema, sem o caminho do que
// vai sumir, fora do sistema de design (DESIGN.md §5 — a mesma ação não pode ter
// duas aparências, e a folha do app é quem carrega "uma frase e um caminho").
function delTool(rel) {
  openModal(
    t("Excluir esta habilidade?"),
    `<p class="pmnote">${esc(rel)}</p>` +
      `<p class="pmnote">${t("Não pode ser desfeito.")}</p>`,
    t("excluir"),
    async () => {
      try { await invoke("brain_delete_tool", { rel }); toolsSig = ""; refreshTools(); toast(t("excluída")); }
      catch (e) { toast(tErr(String(e))); }
    }
  );
}
// "usar": reads the tool's own front-matter (description/argument-hint) to
// prompt for arguments, then just runs "/<slug> <alvo> <args>" — the file
// itself IS the slash-command, no dedicated runner needed.
// alvoRel (when given) is the file/topic the habilidade was invoked against:
// it is a FIXED argument shown as a read-only row, never inside the writable
// input (owner feedback) — every loro skill takes the alvo as its first
// token, so it consumes the hint's first token and the remaining tokens are
// listed for the user to fill in the free-text box.
// N14 · a folha declara os argumentos obrigatórios (`<...>` do argument-hint) e
// despachava com o campo vazio, relatando "a resposta aparece no chat". Um token
// entre `[...]` é opcional e não bloqueia.
function missingRequiredArgs(tokens, value) {
  const required = (tokens || []).filter((tk) => /^<.+>$/.test(String(tk)));
  return required.length > 0 && !String(value || "").trim();
}
// N16 · the argument hint's first token names WHERE the skill acts
// (`<alvo:ideia-conhecimento-ou-nota>`, `<target:idea>`). Pure decision: it is
// the only token a destination picker may replace.
function isAlvoToken(tk) {
  return /^<\s*(alvo|target)[:-]/i.test(String(tk || ""));
}
// The other target an argument hint asks for is a MEETING, and a meeting has a
// surface of its own (the open meeting, with the action in its menu). Asking for
// its folder in a text box is the same defect under another name, so the sheet
// points at the place instead of opening.
function isReuniaoToken(tk) {
  return /^<\s*(dir-da-reuniao|meeting-dir)>/i.test(String(tk || ""));
}
// The homes the project actually has, in the same vocabulary and shape as
// "Salvar nota" — the value is the real path the skill receives.
async function alvoDestinations() {
  let ideias = [];
  try { ideias = (await invoke("brain_list_brainstorms")) || []; } catch (_) {}
  const ctxs = (lastSt && lastSt.contexts) || [];
  return ideias.map((b) => ({ value: `brainstorming/${b.slug}`, label: `${t("ideias")} · ${b.nome || b.slug}` }))
    .concat(ctxs.map((c) => ({ value: `contexts/${c.name}`, label: `${t("conhecimento")} · ${c.name}` })));
}
async function promptUseTool(rel, alvoRel) {
  const slug = rel.split("/").pop().replace(/\.md$/, "");
  // N13 · o título era "USAR /LORO-ANALYSE" logo abaixo da linha que o usuário
  // clicou, chamada "analisar reunião" (DESIGN.md §4: o slug não é nome de ação)
  const label = habilidadeLabelByRel(rel);
  let hint = "", desc = "";
  try {
    const raw = await invoke("brain_read", { rel });
    const mHint = /argument-hint:\s*(.+)/.exec(raw);
    const mDesc = /description:\s*(.+)/.exec(raw);
    if (mHint) hint = mHint[1].trim();
    if (mDesc) desc = mDesc[1].trim();
  } catch (_) {}
  const fixed = (alvoRel || "").trim();
  const tokens = hint.match(/<[^>]+>|\[[^\]]+\]/g) || [];
  // N16 · with no document open (the palette on Início) the sheet had no target,
  // and the internal token reached the screen as copy AND as the placeholder: the
  // only way through was typing a disk path (`brainstorming/<slug>`). Internal
  // vocabulary cannot be a prerequisite for using the app (DESIGN.md §4) — the
  // target is chosen.
  if (!fixed && tokens.length > 0 && isReuniaoToken(tokens[0])) {
    toast(t("abra a reunião para analisar"), 5000);
    return;
  }
  const picking = !fixed && tokens.length > 0 && isAlvoToken(tokens[0]);
  const dests = picking ? await alvoDestinations() : [];
  if (picking && !dests.length) {
    toast(t("crie uma ideia ou um tema antes de rodar esta habilidade"), 5000);
    return;
  }
  const rest = (fixed || picking) && tokens.length ? tokens.slice(1) : tokens;
  const restHint = rest.join("  ");
  openModal(
    `${t("usar")}: ${label}`,
    (desc ? `<p class="pmnote">${esc(desc)}</p>` : "") +
      (fixed ? `<div class="wfield"><span class="mono">${t("alvo")}</span><span class="lockval mono" title="${esc(fixed)}">${esc(fixed)}</span></div>` : "") +
      (picking ? `<label class="wfield"><span class="mono">${t("alvo")}</span><select id="useToolAlvo">` +
        dests.map((d) => `<option value="${esc(d.value)}">${esc(d.label)}</option>`).join("") + `</select></label>` : "") +
      (restHint ? `<p class="pmnote">${t("argumentos")}: ${esc(restHint)}</p>` : "") +
      `<label class="wfield"><span class="mono">${t("escrever")}</span>` +
      `<input id="useToolInput" type="text" placeholder="${esc(restHint || t("opcional"))}" spellcheck="false"></label>`,
    t("rodar"),
    () => {
      const args = (($("useToolInput") && $("useToolInput").value) || "").trim();
      const alvo = fixed || (($("useToolAlvo") && $("useToolAlvo").value) || "");
      if (missingRequiredArgs(rest, args)) { toast(t("preencha os argumentos pedidos")); return; }
      // o chat registra a AÇÃO escolhida (era a barra crua "/loro-question")
      return dispatchAiFromSheet("/" + slug + (alvo ? " " + alvo : "") + (args ? " " + args : ""), null, label);
    }
  );
  const inp = $("useToolInput"); if (inp) inp.focus();
}
function promptToolAI(rel) {
  openModal(
    t("Pedir à IA sobre esta habilidade"),
    `<p class="pmnote">${t("a IA lê a habilidade e aplica o pedido nela mesma — evolui, não apaga.")}</p>` +
      `<label class="wfield"><span class="mono">${t("pedido")}</span>` +
      `<input id="toolAiInput" type="text" placeholder="${t("ex.: adicione um passo para validar o input")}" spellcheck="false"></label>`,
    t("enviar"),
    () => {
      const p = (($("toolAiInput") && $("toolAiInput").value) || "").trim();
      const cmd = LoroBrainstorm.toolCmd(rel, p);
      if (!cmd) { toast(t("descreva o pedido")); return; }
      return dispatchAiFromSheet(cmd);
    }
  );
  const inp = $("toolAiInput"); if (inp) inp.focus();
}
function promptNewToolAI() {
  openModal(
    t("Nova habilidade (IA)"),
    `<p class="pmnote">${t("descreva o que a habilidade deve fazer — a IA cria a skill; ela aparece na lateral quando terminar.")}</p>` +
      `<label class="wfield"><span class="mono">${t("descrição")}</span>` +
      `<input id="newToolInput" type="text" placeholder="${t("ex.: resume um ticket do Jira em 3 bullets")}" spellcheck="false"></label>`,
    t("criar"),
    () => {
      const d = (($("newToolInput") && $("newToolInput").value) || "").trim();
      const cmd = LoroBrainstorm.newToolCmd(d);
      if (!cmd) { toast(t("descreva a habilidade")); return; }
      return dispatchAiFromSheet(cmd, t("pedido enviado — a habilidade aparece na lateral"));
    }
  );
  const inp = $("newToolInput"); if (inp) inp.focus();
}
function promptImportTool() {
  openModal(
    t("Importar habilidade existente"),
    `<p class="pmnote">${t("cole o conteúdo de uma skill (.md) que você já tem.")}</p>` +
      `<label class="wfield"><span class="mono">${t("nome")}</span>` +
      `<input id="importToolName" type="text" placeholder="${t("ex.: resumo-jira")}" spellcheck="false"></label>` +
      `<label class="wfield"><span class="mono">${t("conteúdo")}</span>` +
      `<textarea id="importToolBody" rows="8" spellcheck="false" placeholder="---&#10;description: ...&#10;---&#10;&#10;..."></textarea></label>`,
    t("importar"),
    async () => {
      const nome = (($("importToolName") && $("importToolName").value) || "").trim();
      const conteudo = (($("importToolBody") && $("importToolBody").value) || "").trim();
      if (!nome || !conteudo) { toast(t("preencha nome e conteúdo")); return; }
      try {
        const rel = await invoke("brain_new_tool", { nome, conteudo });
        toolsSig = ""; refreshTools();
        toast(t("habilidade importada"));
        openDoc(rel, { preview: false });
      } catch (e) { toast(tErr(String(e))); }
    }
  );
  const inp = $("importToolName"); if (inp) inp.focus();
}
function openAddToolMenu(anchor) {
  B.acervoMenu.hidden = true;
  B.bMenu.innerHTML =
    `<div class="fitem2 strong" data-ai><span class="fn">✦ ${t("nova habilidade (IA)")}</span></div>` +
    `<div class="fitem2" data-import><span class="fn">⇩ ${t("importar skill existente")}</span></div>`;
  B.bMenu.querySelector("[data-ai]").onclick = () => { closeFloat(); promptNewToolAI(); };
  B.bMenu.querySelector("[data-import]").onclick = () => { closeFloat(); promptImportTool(); };
  placeMenu(anchor);
}
{ const ab = $("addToolBtn"); if (ab) ab.addEventListener("click", (e) => { e.stopPropagation(); openAddToolMenu(ab); }); }
// ADR-0005: the habilidades section collapses/expands from its own header —
// with many skills the list stops crowding the sidebar; the caret shows state.
{
  const tt = $("toolsToggle"), navT = $("navTools");
  if (tt && navT) tt.addEventListener("click", () => {
    navT.hidden = !navT.hidden;
    tt.classList.toggle("closed", navT.hidden);
    tt.setAttribute("aria-expanded", String(!navT.hidden));
  });
}
// Shared "executar habilidade" picker (brainstorming ⋯ and meeting ⋯): a
// compact dropdown-like list — one row per pickable habilidade, description
// only on hover (title=), never rendered inline (ADR-0005: avoid a wall of
// text once there are many). loro-sync.md is special-cased into its 4
// sources since it is one file covering four distinct identifiers.
// Flattens lastToolFiles into runnable entries: loro-sync.md expands into its
// 4 sources (one file, four distinct identifiers); every other pickable
// habilidade (built-in or custom, minus the 5 workflow-specific ones) is one
// entry. Shared by the ⋯ menu picker AND the meeting rail dropdown so both
// stay in sync automatically.
// Friendly display names for the built-in habilidades — `loro-…` filenames
// mean nothing to the user (owner feedback); customs keep their own name.
// C10/C14 · o rótulo chega a t() por VARIÁVEL, então a varredura de literais não
// o vê: foi assim que "perguntar ao acervo" (o termo que a DESIGN.md §4 retirou)
// sobreviveu no chip de todas as telas, e que cinco habilidades ficaram sem par
// em inglês — a mesma ação aparecia duas vezes, em dois idiomas. Toda habilidade
// padrão tem rótulo aqui; vocabulary.test.js guarda as duas regras.
const TOOL_LABELS = {
  "loro-presentation.md": "apresentação",
  "loro-artifact.md": "artefato",
  "loro-note.md": "nota por IA",
  "loro-ask.md": "perguntar ao projeto",
  "loro-analyse.md": "analisar reunião",
  "loro-question.md": "perguntar sobre a reunião",
  "loro-context.md": "transformar em conhecimento",
  "loro-tool.md": "criar habilidade",
  "loro-slack.md": "perguntar no Slack",
  "loro-digest.md": "índice da ideia",
  // N13 · sem esta linha, loro-sync aparecia na lateral pelo NOME DO ARQUIVO,
  // entre dez nomes em pt-BR
  "loro-sync.md": "sincronizar fontes",
};
// O nome do ARQUIVO (`loro-ask`) não é o nome de uma ação: as padrão têm rótulo
// próprio; uma habilidade customizada usa o nome que o autor deu a ela.
function habilidadeLabel(f) {
  return TOOL_LABELS[f.name] ? t(TOOL_LABELS[f.name]) : shortName(f.name);
}
// O mesmo rótulo a partir do caminho — a folha "usar" só tem o rel em mão.
function habilidadeLabelByRel(rel) {
  const name = String(rel || "").split("/").pop() || "";
  return habilidadeLabel({ name });
}
// Relevance order for the dropdown/picker (ADR-0005, owner feedback): the most
// context-relevant habilidades first, least last. On the meeting surface the
// meeting skills (perguntar sobre a reunião, analisar) lead; elsewhere the
// general order applies. Custom habilidades (not listed) sink to the end,
// alphabetically. Filenames not listed rank last too.
const TOOL_ORDER = {
  doc: [
    "loro-ask.md", "loro-note.md", "loro-presentation.md", "loro-artifact.md",
    "loro-digest.md", "loro-sync.md", "loro-slack.md",
    "loro-question.md", "loro-analyse.md", "loro-context.md", "loro-tool.md",
  ],
  meeting: [
    "loro-question.md", "loro-analyse.md",
    "loro-ask.md", "loro-note.md", "loro-presentation.md", "loro-artifact.md",
    "loro-slack.md", "loro-sync.md", "loro-digest.md",
    "loro-context.md", "loro-tool.md",
  ],
};
function habilidadeRank(name, surface) {
  const order = TOOL_ORDER[surface] || TOOL_ORDER.doc;
  const i = order.indexOf(name);
  return i === -1 ? order.length : i;
}
function habilidadeEntriesFrom(files, surface) {
  const entries = [];
  const ordered = files.filter((f) => !TOOL_RETIRED.has(f.name)).sort((a, b) => {
    const d = habilidadeRank(a.name, surface) - habilidadeRank(b.name, surface);
    return d !== 0 ? d : shortName(a.name).localeCompare(shortName(b.name));
  });
  for (const f of ordered) {
    if (f.name === "loro-sync.md") {
      for (const fonte of (f.fontes && f.fontes.length ? f.fontes : SYNC_FALLBACK_FONTES)) {
        entries.push({ kind: "sync", fonte, label: `${t("sincronizar")}: ${fonte}`, title: f.desc });
      }
    } else {
      entries.push({ kind: "tool", rel: f.path, label: habilidadeLabel(f), title: f.desc || f.path });
    }
  }
  return entries;
}
// Curated: excludes the 5 workflow-specific built-ins (already have dedicated
// UI) — used by the ⋯ menu picker, which coexists with that dedicated UI.
function pickableHabilidadeEntries(surface) {
  return habilidadeEntriesFrom(lastToolFiles.filter((f) => !TOOL_PICKER_EXCLUDE.has(f.name)), surface);
}
// Unrestricted: every habilidade, no exclusion — used where there is no
// separate dedicated UI to coexist with (the meeting rail, ADR-0005).
function allHabilidadeEntries(surface) {
  return habilidadeEntriesFrom(lastToolFiles, surface);
}
function runHabilidadeEntry(entry, alvoRel) {
  if (entry.kind === "sync") promptSyncTool(entry.fonte, alvoRel);
  else promptUseTool(entry.rel, alvoRel);
}
// `all` lifts the workflow-builtin exclusion — used where no dedicated UI
// coexists (the Visão Geral hero button); alvoRel may be null there (each
// habilidade then asks for/omits its own target).
function openHabilidadeMenu(alvoRel, anchor, all, surface) {
  B.acervoMenu.hidden = true;
  const entries = all ? allHabilidadeEntries(surface) : pickableHabilidadeEntries(surface);
  const rows = entries.map((e, i) =>
    `<div class="fitem2" data-entry="${i}" title="${esc(e.title)}"><span class="fn">${esc(e.label)}</span></div>`).join("");
  B.bMenu.innerHTML = `<div class="fhead">${t("executar habilidade")}</div>` +
    (rows || `<div class="fnote">${t("nenhuma habilidade disponível")}</div>`);
  B.bMenu.querySelectorAll("[data-entry]").forEach((el2) => (el2.onclick = () => {
    closeFloat(); runHabilidadeEntry(entries[Number(el2.dataset.entry)], alvoRel);
  }));
  placeMenu(anchor);
}

// ADR-0005: "＋ do computador" — native file picker → copies the chosen files
// into an attachments/ folder (brain_import_files). Works for both a brainstorming
// (destRel = brainstorming/<slug>/attachments) and a context (contexts/<c>/attachments);
// `after` runs on success (re-open + reload the right tree).
async function importAnexoFromComputer(destRel, after) {
  if (!destRel) { toast(t("este documento não tem uma pasta de anexos")); return; }
  try {
    const n = await invoke("brain_import_files", { destRel });
    if (n > 0) {
      toast(`${n} ${n > 1 ? t("arquivos anexados") : t("arquivo anexado")}`);
      if (after) after();
    }
  } catch (e) { toast(tErr(String(e))); clog("brain_import_files error: " + e); }
}

// ADR-0005: inline "nova nota" in a context's anexos folder — the context
// counterpart to promptNewNota, writing via brain_new_note_in and reloading
// the context children so the note shows immediately.
function promptNewNoteInContext(name, anchor) {
  if (notaEditing) return;
  notaEditing = true;
  const inp = document.createElement("input");
  inp.className = "bnewctx";
  inp.placeholder = t("título da nota (Enter)");
  anchor.before(inp); inp.focus();
  const done = () => { inp.remove(); notaEditing = false; };
  inp.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") return done();
    if (e.key !== "Enter") return;
    const titulo = inp.value.trim();
    if (!titulo) return done();
    try {
      const rel = await invoke("brain_new_note_in", { destRel: `contexts/${name}/attachments`, titulo });
      done(); bOpen.add(`ctxfolder:${name}:anexos`); loadCtxChildren(name);
      if (rel) openDoc(rel, { preview: false });
    } catch (err) { toast(tErr(String(err))); }
  });
  inp.addEventListener("blur", done);
}

// Inline "nova nota" inside a brainstorming (mirrors promptNewContext/promptNewTema).
// Writes brainstorming/<slug>/notes/<slug>.md via brain_new_notebook and opens it.
let notaEditing = false;
function promptNewNota(slug, anchor) {
  if (notaEditing) return;
  notaEditing = true;
  const inp = document.createElement("input");
  inp.className = "bnewctx";
  inp.placeholder = t("título da nota (Enter)");
  anchor.before(inp); inp.focus();
  const done = () => { inp.remove(); notaEditing = false; };
  inp.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") return done();
    if (e.key !== "Enter") return;
    const titulo = inp.value.trim();
    if (!titulo) return done();
    try {
      const rel = await invoke("brain_new_notebook", { tema: slug, titulo });
      done(); bOpen.add(`bsfolder:${slug}:notas`); pessoalSig = ""; refreshPessoal();
      if (rel) openDoc(rel, { preview: false });
    } catch (err) { toast(tErr(String(err))); }
  });
  inp.addEventListener("blur", done);
}

// The ⋯ menu of a brainstorming — renomear / enviar tudo à fila / apagar. Mirrors
// the contextos action menu so create/edit/delete feel identical across worlds.
// Redesign 1b — a ordem do menu ⋯ é fixa e a mesma em toda pasta:
// criar · agir · mover · destruir. ADR-0020 §1 removeu "atualizar índice
// (resumão)": o digest saiu da UI junto com o /loro-digest.
function openBsMenu(slug, anchor) {
  B.acervoMenu.hidden = true;
  // o cabeçalho do menu mostrava o SLUG ("PLATAFORMA-DE-PAGAMENTOS"), não o nome
  // que o usuário digitou — o slug é o nome da pasta no disco
  const tema = (pessoalRawTemas || []).find((x) => x.slug === slug);
  B.bMenu.innerHTML =
    `<div class="fhead">${esc((tema && tema.nome) || slug)}</div>` +
    `<div class="fitem2" data-newnote><span class="fn">${ico("note", "ac")} ${t("nova nota")}</span></div>` +
    `<div class="fitem2" data-rec><span class="fn">${ico("meeting")} ${t("gravar reunião aqui")}</span></div>` +
    `<div class="fitem2" data-attach><span class="fn">${ico("file")} ${t("anexar arquivo")}</span></div>` +
    `<div class="fsep"></div>` +
    `<div class="fitem2 strong" data-ainote><span class="fn">✦ ${t("nota por IA…")}</span></div>` +
    `<div class="fitem2" data-tools><span class="fn">${ico("skill")} ${t("executar habilidade…")}</span></div>` +
    // B9 · "enviar tudo para organizar" truncava no meio da palavra: o rótulo é
    // o que cabe na caixa do menu (.floatmenu tem largura máxima em CSS).
    `<div class="fitem2" data-toqueue><span class="fn">→ ${t("tudo para organizar")}</span></div>` +
    `<div class="fsep"></div>` +
    `<div class="fitem2" data-ren><span class="fn">${t("renomear")}</span></div>` +
    copyPathItemsHtml() +
    `<div class="fsep"></div>` +
    `<div class="fitem2 danger" data-del><span class="fn">${t("excluir")}</span></div>`;
  const row = anchor.closest(".bitem") || anchor;
  B.bMenu.querySelector("[data-newnote]").onclick = () => { closeFloat(); promptNewNota(slug, row); };
  B.bMenu.querySelector("[data-rec]").onclick = () => { closeFloat(); startMeetingFlow(slug); };
  B.bMenu.querySelector("[data-attach]").onclick = () => { closeFloat(); importAnexoFromComputer(`brainstorming/${slug}/attachments`, () => { pessoalSig = ""; refreshPessoal(); }); };
  B.bMenu.querySelector("[data-ainote]").onclick = () => { closeFloat(); promptNoteAI(`brainstorming/${slug}/notes`, false); };
  B.bMenu.querySelector("[data-tools]").onclick = () => openHabilidadeMenu(`brainstorming/${slug}`, anchor);
  B.bMenu.querySelector("[data-ren]").onclick = () => { closeFloat(); promptRenameBs(slug); };
  B.bMenu.querySelector("[data-toqueue]").onclick = () => { closeFloat(); sendBrainstormAllToQueue(slug); };
  wireCopyPathItems(`brainstorming/${slug}`);
  B.bMenu.querySelector("[data-del]").onclick = () => { closeFloat(); delPessoal("brainstorming/" + slug, "tema"); };
  placeMenu(anchor);
}

// Rename via the shared modal — window.prompt is unreliable in the webview
// (same reason pickMeeting/askMeetingQuestion use openModal).
function promptRenameBs(slug) {
  openModal(
    t("Renomear ideia"),
    `<label class="wfield"><span class="mono">${t("nome")}</span>` +
      `<input id="bsRenInput" type="text" value="${esc(slug)}" spellcheck="false"></label>`,
    t("renomear"),
    async () => {
      const nome = (($("bsRenInput") && $("bsRenInput").value) || "").trim();
      if (!nome) { toast(t("informe um nome")); return; }
      try {
        const r = await invoke("brain_rename_brainstorm", { slug, nome });
        pessoalSig = ""; refreshPessoal();
        if (r && r.rel) openTopicDoc(r.rel, { preview: false });
        toast(t("renomeado"));
      } catch (e) { toast(t("não renomeei") + ": " + tErr(String(e))); }
    }
  );
  const inp = $("bsRenInput"); if (inp) { inp.focus(); inp.select(); }
}

// O menu ⋯ de uma reunião na árvore — renomear (só o título; o id/pasta é
// estável, então abas e artefatos continuam válidos) / apagar.
function openMeetingMenu(rel, id, title, status, anchor, notas) {
  B.acervoMenu.hidden = true;
  // the meeting's AI actions live here too (not only in the open tab); the
  // report is only worth opening after the meeting is done — before that the
  // entry shows disabled with the reason instead of failing on click.
  const ready = status === "done";
  // R19 · uma reunião cujo manifest ficou em "recording" não vai terminar sozinha:
  // a nota antiga prometia que analisar/enviar/mover apareceriam "quando a reunião
  // terminar", e não havia como terminá-la. Aqui ela ganha a saída.
  const interrupted = status === "interrupted";
  const dis = ready ? "" : " disabled";
  // AC-7: a análise É a saída da reunião — sem nenhuma, não há o que enfileirar,
  // e o motivo fica declarado em vez de o envio falhar em silêncio.
  // meeting.js decide SE bloqueia (uma razão só: reunião sem análise). O texto
  // é escrito aqui porque o dele ainda diz "fila", palavra que a DESIGN.md §4
  // retirou da tela.
  const bloqueio = LM.meetingQueueBlock(notas);
  const bloqueioMsg = t("analise a reunião antes de enviar para organizar");
  B.bMenu.innerHTML =
    `<div class="fhead">${esc(title)}</div>` +
    (interrupted
      ? `<div class="fitem2 strong" data-mtgclose><span class="fn">■ ${t("encerrar reunião")}</span></div>`
      : "") +
    `<div class="fitem2 strong${dis ? " off" : ""}" data-analyse><span class="fn">✦ ${t("analisar")}</span></div>` +
    `<div class="fitem2${ready ? "" : " strong"}" data-question><span class="fn">? ${t("perguntar…")}</span></div>` +
    `<div class="fitem2${dis || bloqueio ? " off" : ""}" data-queue><span class="fn">${t("enviar para organizar")} →</span></div>` +
    (interrupted
      ? `<div class="fnote">${t("a reunião foi interrompida — encerre para liberar analisar, enviar para organizar e mover")}</div>`
      : ready ? "" : `<div class="fnote">${t("analisar e enviar para organizar ficam disponíveis quando a reunião terminar — perguntar já funciona agora")}</div>`) +
    (ready && bloqueio ? `<div class="fnote">${bloqueioMsg}</div>` : "") +
    `<div class="fitem2" data-tools><span class="fn">${ico("skill")} ${t("executar habilidade…")}</span></div>` +
    `<div class="fsep"></div>` +
    `<div class="fitem2" data-ren><span class="fn">✎ ${t("renomear")}</span></div>` +
    `<div class="fitem2${dis ? " off" : ""}" data-mvmtg><span class="fn">⇄ ${t("mover para…")}</span></div>` +
    copyPathItemsHtml() +
    `<div class="fitem2 danger" data-del><span class="fn">${t("apagar reunião")}</span></div>`;
  wireCopyPathItems(rel);
  // mover só depois de encerrada: durante a gravação o retema disputaria o
  // manifesto e o arquivo vivo com o append, e um trecho se perderia
  if (ready) B.bMenu.querySelector("[data-mvmtg]").onclick = () => { closeFloat(); promptMoveMeeting(rel); };
  if (ready) {
    B.bMenu.querySelector("[data-analyse]").onclick = () => { closeFloat(); openDoc(livingRel(rel), { preview: false }); runMeetingSkill("analyse", id, null, rel); };
    B.bMenu.querySelector("[data-queue]").onclick = () => {
      closeFloat();
      // ADR-0018: the meeting goes as its DIRECTORY; the backend's single owner
      // expands it into the notes/ that represent it (BR-8 stays there).
      if (bloqueio) { toast(bloqueioMsg); return; }
      sendFilesToQueue([LoroBrainstorm.queueRelForSelection("reuniao", rel)]);
    };
  }
  if (interrupted) {
    B.bMenu.querySelector("[data-mtgclose]").onclick = () => { closeFloat(); finishInterruptedMeeting(id, rel); };
  }
  B.bMenu.querySelector("[data-question]").onclick = () => { closeFloat(); askMeetingQuestion(id, rel); };
  B.bMenu.querySelector("[data-tools]").onclick = () => openHabilidadeMenu(rel, anchor);
  B.bMenu.querySelector("[data-ren]").onclick = () => { closeFloat(); promptRenameMeeting(id, title); };
  B.bMenu.querySelector("[data-del]").onclick = () => { closeFloat(); delPessoal(rel, "reuniao"); };
  placeMenu(anchor);
}

// notes and analysis artifacts: rename in place (world-confined backend),
// move to another folder, copy path (relative/absolute) + delete
function openArtefatoMenu(rel, label, anchor) {
  B.acervoMenu.hidden = true;
  B.bMenu.innerHTML =
    `<div class="fhead">${esc(label)}</div>` +
    `<div class="fitem2 strong" data-ainote><span class="fn">✦ ${t("pedir à IA…")}</span></div>` +
    `<div class="fsep"></div>` +
    `<div class="fitem2" data-ren><span class="fn">✎ ${t("renomear")}</span></div>` +
    `<div class="fitem2" data-mv><span class="fn">⇄ ${t("mover para…")}</span></div>` +
    copyPathItemsHtml() +
    `<div class="fsep"></div>` +
    `<div class="fitem2 danger" data-del><span class="fn">${t("apagar")}</span></div>`;
  B.bMenu.querySelector("[data-ainote]").onclick = () => { closeFloat(); promptNoteAI(rel, true); };
  B.bMenu.querySelector("[data-ren]").onclick = () => { closeFloat(); promptRenameArtefato(rel); };
  B.bMenu.querySelector("[data-mv]").onclick = () => { closeFloat(); promptMoveFile(rel); };
  wireCopyPathItems(rel);
  B.bMenu.querySelector("[data-del]").onclick = () => { closeFloat(); delPessoal(rel); };
  placeMenu(anchor);
}

// Copy a file's acervo-relative path (portable, mirrors acervo:// refs) or its
// absolute on-disk path (resolved by the backend, guarded to the acervo root).
async function copyFilePath(rel, absolute) {
  let text = rel;
  if (absolute) {
    try { text = await invoke("brain_abs_path", { rel }); }
    catch (e) { toast(tErr(String(e))); return; }
  }
  toast((await copyToClipboard(text)) ? t("caminho copiado") : t("não consegui copiar"));
}

// Dependency-light clipboard write: the WebView clipboard API first, a hidden
// textarea + execCommand fallback for contexts where it is unavailable.
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (_) { return false; }
}

// ADR-0009 (extended, issue #18): the copy-path rows shared by every ⋯ menu in
// the sidebar tree — relative path (portable, mirrors acervo://) and absolute
// on-disk path. `copyPathItemsHtml` returns the two rows; `wireCopyPathItems`
// binds them after the menu is placed (no-op if the rows are absent).
function copyPathItemsHtml() {
  return `<div class="fitem2" data-cprel><span class="fn">⧉ ${t("copiar caminho relativo")}</span></div>` +
    `<div class="fitem2" data-cpabs><span class="fn">⧉ ${t("copiar caminho absoluto")}</span></div>`;
}
function wireCopyPathItems(rel) {
  const r = B.bMenu.querySelector("[data-cprel]"); if (r) r.onclick = () => { closeFloat(); copyFilePath(rel, false); };
  const a = B.bMenu.querySelector("[data-cpabs]"); if (a) a.onclick = () => { closeFloat(); copyFilePath(rel, true); };
}
// A ⋯ menu with ONLY the copy-path actions — for tree rows that otherwise have
// no menu (fontes, context children, folder headers). Every node in the tree
// can copy its path (issue #18).
function openPathMenu(rel, label, anchor) {
  B.acervoMenu.hidden = true;
  B.bMenu.innerHTML = `<div class="fhead">${esc(label)}</div>` + copyPathItemsHtml();
  wireCopyPathItems(rel);
  placeMenu(anchor);
}
// The copy-only ⋯ button markup for a tree row/folder header that has no richer
// menu (issue #18); `wirePathMenus` binds every such button under `root`.
function pathMenuBtnHtml(rel, label) {
  return rowMenuHtml(`data-pathmenu="${esc(rel)}" data-pathlabel="${esc(label || rel)}"`, label || rel, t("copiar caminho (relativo/absoluto)"));
}
function wirePathMenus(root) {
  (root || B.main).querySelectorAll("[data-pathmenu]").forEach((el2) => (el2.onclick = (e) => {
    e.stopPropagation();
    openPathMenu(el2.dataset.pathmenu, el2.dataset.pathlabel || el2.dataset.pathmenu, el2);
  }));
}

// #44 — "mover para…" de uma REUNIÃO: o destino é sempre o meetings/ de outro
// brainstorming (LM.meetingMoveTargets), nunca avulso/notes/attachments, que guardam
// arquivos soltos. O backend confina a move e nunca sobrescreve.
async function promptMoveMeeting(rel) {
  const slugAtual = (/^brainstorming\/([^/]+)\//.exec(rel) || [])[1] || "";
  let temas = [];
  try { temas = (await invoke("brain_list_brainstorms")) || []; } catch (_) {}
  const dests = LM.meetingMoveTargets(temas, slugAtual);
  if (!dests.length) { toast(t("nenhum destino disponível")); return; }
  openModal(
    t("Mover reunião"),
    `<label class="wfield"><span class="mono">${t("destino")}</span>` +
      `<select id="mvMtgDest">` +
      dests.map((d) => `<option value="${esc(d.slug)}">${esc(d.label)}</option>`).join("") +
      `</select></label>`,
    t("mover"),
    async () => {
      const destSlug = ($("mvMtgDest") && $("mvMtgDest").value) || "";
      if (!destSlug) return;
      await moveMeetingTo(rel, destSlug);
    }
  );
}

// A move em si, compartilhada pelo menu e pelo arrastar-e-soltar.
async function moveMeetingTo(rel, destSlug) {
  try {
    await invoke("brain_move_meeting", { rel, destSlug });
    // abas abertas apontam para o caminho antigo: salvar falharia com "not found".
    // Com a barra, para `…/m1` não fechar as abas de `…/m10`.
    closeTabsUnder(rel.replace(/\/+$/, "") + "/");
    toast(t("movida"));
    pessoalSig = ""; refreshPessoal();
  } catch (e) { toast(tErr(String(e))); }
}

// "mover para…": pick a destination folder within the brainstorming world
// (avulso, or any brainstorming's notes/attachments). The backend confines the move
// to the non-versioned world and never overwrites (brain_move_pessoal).
async function promptMoveFile(rel) {
  let temas = [];
  try { temas = (await invoke("brain_list_brainstorms")) || []; } catch (_) {}
  const cur = rel.split("/").slice(0, -1).join("/");
  const opts = [{ dir: "brainstorming/avulso", label: t("avulso") }];
  for (const b of temas) {
    opts.push({ dir: `brainstorming/${b.slug}/notes`, label: `${b.nome || b.slug} › ${t("notas")}` });
    opts.push({ dir: `brainstorming/${b.slug}/attachments`, label: `${b.nome || b.slug} › ${t("anexos")}` });
  }
  const dests = opts.filter((o) => o.dir !== cur);
  if (!dests.length) { toast(t("nenhum destino disponível")); return; }
  openModal(
    t("Mover arquivo"),
    `<label class="wfield"><span class="mono">${t("destino")}</span>` +
      `<select id="mvDest">` +
      dests.map((d) => `<option value="${esc(d.dir)}">${esc(d.label)}</option>`).join("") +
      `</select></label>`,
    t("mover"),
    async () => {
      const destDir = ($("mvDest") && $("mvDest").value) || "";
      if (!destDir) return;
      try {
        await invoke("brain_move_pessoal", { rel, destDir });
        toast(t("movido"));
        pessoalSig = ""; refreshPessoal();
      } catch (e) { toast(tErr(String(e))); }
    }
  );
}

// /loro-note: create a note from a prompt (target = notes folder) or evolve an
// existing note in place (target = the .md file). Runs in the terminal agent;
// the sidebar's post-action refresh burst surfaces the result.
function promptNoteAI(target, isFile) {
  openModal(
    isFile ? t("Pedir à IA sobre esta nota") : t("Nota por IA"),
    `<p class="pmnote">${isFile
      ? t("a IA lê a nota e aplica o pedido nela mesma — evolui, não apaga.")
      : t("descreva a nota que o Loro deve criar nesta ideia.")}</p>` +
      `<label class="wfield"><span class="mono">${t("pedido")}</span>` +
      `<input id="noteAiInput" type="text" placeholder="${isFile
        ? t("ex.: resuma em 5 bullets e liste as dúvidas")
        : t("ex.: nota sobre os riscos do contrato X, com o que sabemos hoje")}" spellcheck="false"></label>`,
    t("enviar"),
    () => {
      const p = (($("noteAiInput") && $("noteAiInput").value) || "").trim();
      const cmd = LoroBrainstorm.noteCmd(target, p);
      if (!cmd) { toast(t("descreva o pedido")); return; }
      return dispatchAiFromSheet(cmd, t("pedido enviado — a nota aparece na lateral"));
    }
  );
  const inp = $("noteAiInput"); if (inp) inp.focus();
}
function promptRenameArtefato(rel) {
  const current = rel.split("/").pop() || "";
  openModal(
    t("Renomear arquivo"),
    `<label class="wfield"><span class="mono">${t("nome")}</span>` +
      `<input id="artRenInput" type="text" value="${esc(current)}" spellcheck="false"></label>`,
    t("renomear"),
    async () => {
      const name = (($("artRenInput") && $("artRenInput").value) || "").trim();
      if (!name) { toast(t("informe um título")); return; }
      try {
        await invoke("brain_rename_pessoal", { rel, name });
        toast(t("renomeado"));
        pessoalSig = ""; refreshPessoal();
      } catch (e) { toast(tErr(String(e))); }
    }
  );
  const inp = $("artRenInput");
  if (inp) { inp.focus(); const dot = current.lastIndexOf("."); inp.setSelectionRange(0, dot > 0 ? dot : current.length); }
}

function promptRenameMeeting(id, current) {
  openModal(
    t("Renomear reunião"),
    `<label class="wfield"><span class="mono">${t("título")}</span>` +
      `<input id="mtgRenInput" type="text" value="${esc(current)}" spellcheck="false"></label>`,
    t("renomear"),
    async () => {
      const titulo = (($("mtgRenInput") && $("mtgRenInput").value) || "").trim();
      if (!titulo) { toast(t("informe um título")); return; }
      try {
        await invoke("brain_meeting_rename", { input: { id, titulo } });
        toast(t("reunião renomeada"));
        pessoalSig = ""; refreshPessoal();
        const tb = activeTab();
        if (tb && LM.meetingDir(tb.rel)) renderActive(); // heading da aba aberta
      } catch (e) { toast(t("não renomeei") + ": " + tErr(String(e))); }
    }
  );
  const inp = $("mtgRenInput"); if (inp) { inp.focus(); inp.select(); }
}

// ---- ADR-0024 · triagem de entrada -----------------------------------------
// Mostra o que os arquivos carregam antes de eles entrarem. Credencial RECUSA o
// arquivo (BR-9: o acervo é versionado; um segredo que passa vira commit); o
// resto avisa e quem decide é o usuário — bloquear por heurística seria censurar
// o material dele. Devolve true quando o envio deve seguir.
//
// BR-8: o achado que chega aqui tem regra, linha e contagem — nunca o texto
// encontrado. A tela não tem como vazar o que não recebeu.
const INTAKE_LABEL = {
  "intake.secret": (f) => t("parece conter uma credencial") + " (" + t("linha") + " " + f.line + ")",
  "intake.cpf": (f) => t("parece conter CPF") + " (" + t("linha") + " " + f.line + ")",
  "intake.transcript": (f) => f.count + " " + t("marcas de transcrição — a BR-8 mantém transcrição fora do que vai para organizar"),
};
async function passIntake(rels, whole) {
  let report;
  try { report = await invoke("brain_triage_files", { rels }); }
  catch (e) { clog("brain_triage_files error: " + e); return true; } // triagem indisponível não trava o trabalho
  if (!report || !report.length) return true;
  const blocked = report.filter((r) => r.findings.some((f) => f.severity === "block"));
  const warned = report.filter((r) => !r.findings.some((f) => f.severity === "block"));
  const row = (r, cls) =>
    `<div class="intakerow ${cls}"><b>${esc(r.rel.split("/").pop())}</b>` +
    r.findings.map((f) => `<span>${esc(INTAKE_LABEL[f.rule] ? INTAKE_LABEL[f.rule](f) : f.rule)}</span>`).join("") +
    `<i class="mono">${esc(r.rel)}</i></div>`;
  const body =
    (blocked.length
      ? `<p class="intakehead block">${blocked.length > 1
          ? blocked.length + " " + t("arquivos não vão entrar")
          : t("um arquivo não vai entrar")} — ${t("o projeto é versionado e vai para o git")}</p>` +
        blocked.map((r) => row(r, "block")).join("")
      : "") +
    (warned.length
      ? `<p class="intakehead warn">${t("confira antes de enviar")}</p>` + warned.map((r) => row(r, "warn")).join("")
      : "");
  // Quando TUDO que sobrou está bloqueado não há o que confirmar: o modal só
  // informa. Se sobrou algo enviável, o botão manda o resto — os bloqueados são
  // recusados pelo backend de qualquer forma, então não há como escapar deles.
  const soBloqueio = warned.length === 0;
  return await new Promise((resolve) => {
    let decidiu = false;
    const responde = (v) => { if (!decidiu) { decidiu = true; resolve(v); } };
    // A folha se dispensa de cinco maneiras (confirmar, cancelar, ×, Escape,
    // clique fora) e QUEM ESPERA precisa ser avisado por todas: ouvir só os
    // cliques em cancelar/× deixava este await pendente para sempre no Escape —
    // o envio para organizar morria em silêncio (o mesmo defeito do ● Gravar).
    openModal(
      t("triagem de entrada"),
      body,
      soBloqueio ? null : t("enviar assim mesmo"),
      soBloqueio ? null : () => responde(true),
      () => responde(false),
    );
  });
}

// ADR-0014: send the given files to the fila, ONE queue item per file (no
// consolidated report). `rels` are acervo-relative file paths already resolved by
// the caller (meeting -> its directory, everything else -> the file itself).
async function sendFilesToQueue(rels) {
  const list = (rels || []).filter(Boolean);
  if (!list.length) return;
  // ADR-0024: o que entra no acervo passa por uma triagem ANTES. A porta é de mão
  // única — o acervo é versionado, e o que vira commit e é empurrado não volta.
  if (!(await passIntake(list))) return;
  try {
    const names = await invoke("brain_send_files_to_queue", { rels: list, destContext: null });
    pessoalSig = ""; refreshPessoal(); sideSig = ""; brainRefresh();
    const n = (names && names.length) || list.length;
    toast(n > 1 ? `${n} ${t("arquivos para organizar")}` : t("arquivo para organizar"));
  } catch (e) { toast(t("não enviei") + ": " + tErr(String(e))); clog("send_to_queue error: " + e); }
}

// Send EVERY queueable file of a brainstorming (the ⋯ "enviar tudo → fila").
async function sendBrainstormAllToQueue(slug) {
  if (!(await passIntake([`brainstorming/${slug}`], true))) return;
  try {
    const names = await invoke("brain_send_brainstorm_to_queue", { slug, destContext: null });
    pessoalSig = ""; refreshPessoal(); sideSig = ""; brainRefresh();
    const n = (names && names.length) || 0;
    toast(n > 1 ? `${n} ${t("arquivos para organizar")}` : t("arquivo para organizar"));
  } catch (e) { toast(t("não enviei") + ": " + tErr(String(e))); clog("send_all_to_queue error: " + e); }
}

// The selected parts across the tree -> the ACTUAL files to queue (each its own
// item). A meeting goes as its directory (the backend expands it into the
// notes/ that represent it, ADR-0018); notes/analyses/attachments go as-is.
async function sendSelectionToQueue() {
  const rels = [];
  B.navPessoal.querySelectorAll("[data-bssel]").forEach((chk) => {
    if (bsSelection.has(chk.dataset.bssel)) {
      rels.push(LoroBrainstorm.queueRelForSelection(chk.dataset.bskind, chk.dataset.bssel));
    }
  });
  if (!rels.filter(Boolean).length) return;
  await sendFilesToQueue(rels);
  bsSelection = new Set(); renderSelectionBar();
}

// A sticky action bar shown while any part is selected — the evident, explicit
// "enviar seleção para a fila" action (ADR-0013 flow step brainstorming → fila).
function renderSelectionBar() {
  let bar = $("bsSelBar");
  if (!bsSelection.size) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "bsSelBar"; bar.className = "bsselbar";
    B.navPessoal.after(bar);
  }
  // two clean rows for the narrow sidebar (owner feedback: the three items
  // wrapping side-by-side read as clutter): count + a quiet "limpar" link on
  // top, the primary action as a full-width CTA below.
  const n = bsSelection.size;
  bar.innerHTML =
    `<div class="bsselrow"><span class="mono">${n} ${t(n > 1 ? "selecionados" : "selecionado")}</span>` +
    `<button class="link mono muted" id="bsSelClear">${t("limpar")}</button></div>` +
    `<button class="railbtn cta" id="bsSelSend" title="${t("Envia cada arquivo escolhido para organizar (um item por arquivo)")}">${t("enviar para organizar")} →</button>`;
  $("bsSelSend").onclick = sendSelectionToQueue;
  $("bsSelClear").onclick = () => { bsSelection = new Set(); wirePessoal(); renderSelectionBar(); };
}

// Apaga um item do mundo brainstorming (arquivo, reunião ou brainstorming inteiro).
// Confinado a brainstorming/ no backend (nunca toca contexts/ versionado).
function delPessoal(rel, kind) {
  const what = kind === "tema" ? t("a ideia e TODO o seu conteúdo")
    : kind === "reuniao" ? t("a reunião e todos os seus arquivos (transcrição, análises, artefatos)")
    : t("este item");
  // N23 · a folha do app, com o caminho do que sai do disco — não o confirm do SO
  openModal(
    `${t("Apagar")} ${what}?`,
    `<p class="pmnote">${esc(rel)}</p><p class="pmnote">${t("Não pode ser desfeito.")}</p>`,
    t("apagar"),
    async () => {
      try {
        await invoke("brain_brainstorm_delete", { input: { rel } });
        closeTabsUnder(rel);
        toast(t("apagado"));
        pessoalSig = ""; refreshPessoal();
      } catch (e) { toast(t("não apaguei") + ": " + tErr(String(e))); clog("brain_brainstorm_delete error: " + e); }
    }
  );
}

// ---- workspace selectors (ADR-0008) ----
function activeTab() { return LoroWorkspace.activeTab(ws); }
function homeTab() { return ws.tabs.find((t) => t.rel === HOME_REL) || null; }
function isHomeActive() { const t = activeTab(); return !t || t.rel === HOME_REL; }
// null when Home/empty (preserves the old `currentDoc === null` semantics),
// the document rel otherwise.
function currentRel() { const t = activeTab(); return !t || t.rel === HOME_REL ? null : t.rel; }

// OS DOCUMENTOS ABERTOS QUE AINDA NÃO ESTÃO NO ARQUIVO. O disco não é o editor:
// uma versão guarda o que já foi salvo, então uma aba suja fica FORA dela — e a
// Revisão dizia «tudo salvo» com o ● da aba dois centímetros acima (DESIGN.md §1:
// o estado nunca mente). A linha do tempo do painel já somava as duas verdades
// (`tab.dirty || gitFiles[rel]`); esta é a metade que faltava ter nome.
function dirtyDocs() {
  return (ws.tabs || [])
    .filter((tb) => tb.rel !== HOME_REL && tb.dirty)
    .map((tb) => ({ id: tb.id, title: tb.title, rel: tb.rel }));
}

// ADR-0026 §12 — a que TEMA um documento pertence. A árvore desenha temas em
// linhas `[data-ctx]`; o documento aberto é um `[data-doc]`. Sem essa ponte,
// abrir um tema não acendia nada na árvore e a lateral virava uma lista de
// pastas sem relação com o que está na tela.
function ctxOfDoc(rel) {
  const m = /^contexts\/(.+)\/[^/]+$/.exec(String(rel || ""));
  return m ? m[1] : "";
}

function markSel() {
  const rel = currentRel();
  B.main.querySelectorAll("[data-doc]").forEach((el2) =>
    el2.classList.toggle("on", el2.dataset.doc === rel));
  // o tema dono do documento aberto acende junto — inclusive quando o que está
  // aberto é o histórico ou os donos, que continuam sendo daquele tema
  const ctx = ctxOfDoc(rel);
  B.main.querySelectorAll("[data-ctx]").forEach((el2) =>
    el2.classList.toggle("here", !!ctx && el2.dataset.ctx === ctx));
  // C18 · a árvore é redesenhada por innerHTML: sem esta linha as linhas novas
  // nascem sem aria-selected (o observador só vê MUDANÇA de classe).
  paintAriaState();
}

// ---- faixa de abas ----
// Regra nº 2 do redesign: NÃO existe aba "Início" — abas são só documentos
// abertos. A aba Home continua existindo em `ws` como o estado "nada aberto"
// (é o alvo de openHome/showHome), mas nunca é desenhada; com uma faixa vazia
// o CSS a esconde por inteiro e o conteúdo encosta no cabeçalho.
// ADR-0026 · a aba do índice é uma TELA, não um arquivo: o título de uma aba é o
// basename do rel, e o sentinela `loro://indice` daria "indice" na faixa — uma
// palavra sem acento, que se lê como erro de digitação e não como nome.
const tabTitle = (tab) => (tab.rel === INDEX_REL ? t("índice remissivo") : tab.title);

function renderTabs() {
  const active = ws.activeId;
  const docs = ws.tabs.filter((tab) => tab.rel !== HOME_REL);
  B.wsTabs.innerHTML = docs.map((tab) => {
    const cls = ["wstab"];
    if (tab.kind === "context") cls.push("wstab--context");
    else if (tab.kind === "personal") cls.push("wstab--personal");
    if (tab.id === active) cls.push("on");
    if (tab.preview) cls.push("preview");   // aba efêmera: itálico (ADR-0008)
    const rec = meeting.active && meeting.livingRel === tab.rel;
    // pausada: o ponto vermelho é a afirmação "estou gravando" e sai de cena
    // enquanto nada é captado (ADR-0022 §19) — o relógio congelado fica
    const lead = rec && !state.paused
      ? `<span class="wsrecdot" aria-hidden="true"></span>`
      : ico(tabIcon(tab), tabIconTone(tab));
    const dot = tab.dirty ? `<span class="wsdot" title="${t("alterações não salvas")}">●</span>` : "";
    // a aba de gravação mostra o timer e NÃO tem × (só para pelo botão Parar)
    const time = rec ? `<span class="wstime">${esc(el.timer.textContent)}</span>` : "";
    const close = rec ? "" : `<button class="wsclose" data-close="${tab.id}" title="${t("fechar")} (⌘/Ctrl+W)" aria-label="${t("fechar")} ${esc(tabTitle(tab))}">×</button>`;
    // C18 · qual documento está aberto existia SÓ na classe .on: para a
    // tecnologia assistiva a faixa era um monte de <div> sem papel (WCAG 4.1.2 /
    // 1.3.1). A faixa é uma tablist de verdade, com tabindex rotativo — uma
    // parada de Tab por faixa, como na árvore lateral.
    const on = tab.id === active;
    return `<div class="${cls.join(" ")}" data-tab="${tab.id}" draggable="true" role="tab"
        aria-selected="${on ? "true" : "false"}" tabindex="${on ? 0 : -1}"
        title="${esc(tab.rel)}">${lead}<span class="wsn">${esc(tabTitle(tab))}</span>${time}${dot}${close}</div>`;
  }).join("") + (docs.length ? `<button class="tabadd" data-tabadd title="${t("abrir…")}">＋</button>` : "");
  wireTabs();
}
// ícone por tipo: conhecimento (teal) · ideia (âmbar) · outros neutros
function tabIcon(tab) { return tab.kind === "context" ? "context" : tab.kind === "personal" ? "note" : "file"; }
function tabIconTone(tab) { return tab.kind === "context" ? "ac" : tab.kind === "personal" ? "amber" : ""; }
// APG (tabs, ativação automática): as setas trocam de aba e o foco acompanha a
// aba ativa. renderTabs redesenha a faixa inteira, então a linha focada deixa de
// existir — o foco é reencontrado pelo id da aba, como na árvore lateral.
function focusTabById(id) {
  const n = B.wsTabs.querySelector(`[data-tab="${CSS.escape(id)}"]`);
  if (n) { try { n.focus(); } catch (_) {} }
}
function onTabKey(e, ids, at) {
  const jump = (i) => {
    const id = ids[(i + ids.length) % ids.length];
    if (!id) return;
    e.preventDefault();
    activateTab(id);
    focusTabById(id);
  };
  if (e.key === "ArrowRight") jump(at + 1);
  else if (e.key === "ArrowLeft") jump(at - 1);
  else if (e.key === "Home") jump(0);
  else if (e.key === "End") jump(ids.length - 1);
  else if (e.key === "Enter" || e.key === " ") jump(at);
}
function wireTabs() {
  const ids = [...B.wsTabs.querySelectorAll("[data-tab]")].map((n) => n.dataset.tab);
  B.wsTabs.querySelectorAll("[data-tab]").forEach((elx) => {
    const id = elx.dataset.tab;
    elx.onkeydown = (e) => onTabKey(e, ids, ids.indexOf(id));
    elx.onclick = (e) => { if (e.target.closest("[data-close]")) return; activateTab(id); };
    // middle-click closes (VS Code parity)
    elx.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); closeTabById(id); } };
    elx.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/wstab", id); e.dataTransfer.effectAllowed = "move"; });
    elx.addEventListener("dragover", (e) => e.preventDefault());
    elx.addEventListener("drop", (e) => {
      e.preventDefault();
      const dragId = e.dataTransfer.getData("text/wstab");
      if (dragId) reorderTab(dragId, id);
    });
  });
  B.wsTabs.querySelectorAll("[data-close]").forEach((b) =>
    (b.onclick = (e) => { e.stopPropagation(); closeTabById(b.dataset.close); }));
  const add = B.wsTabs.querySelector("[data-tabadd]");
  if (add) add.onclick = () => openPalette("file");
}
function activateTab(id) { ws = LoroWorkspace.setActive(ws, id); renderTabs(); renderActive(); }
function reorderTab(dragId, overId) {
  const idx = ws.tabs.findIndex((t) => t.id === overId);
  if (idx < 0) return;
  ws = LoroWorkspace.moveTab(ws, dragId, idx);
  // keep Home first (it is pinned/non-closable)
  const h = homeTab();
  if (h && ws.tabs[0] && ws.tabs[0].id !== h.id) ws = LoroWorkspace.moveTab(ws, h.id, 0);
  renderTabs();
}
// Single point of truth for dropping a tab's live editor state (ADR-0002 §3):
// the CM6 handle is destroyed BEFORE the maps forget it, so no stale buffer
// can keep answering for a reused/closed tab id.
function disposeTabState(id) {
  const h = cmById.get(id);
  if (h) { try { h.destroy(); } catch (_) {} }
  cmById.delete(id); savedById.delete(id); fmById.delete(id);
}
function closeTabById(id) {
  const tab = ws.tabs.find((t) => t.id === id);
  if (!tab || tab.rel === HOME_REL) return; // Home is non-closable
  const close = () => {
    disposeTabState(id);
    ws = LoroWorkspace.closeTab(ws, id);
    renderTabs(); renderActive();
  };
  // N23 · perder o que foi escrito é destrutivo: confirma na folha do app, com o
  // nome do documento — o window.confirm era chrome do navegador
  if (!tab.dirty) return close();
  openModal(
    t("Descartar alterações não salvas?"),
    `<p class="pmnote">${esc(tab.title)}</p>` +
      `<p class="pmnote">${t("o que foi escrito e não salvo é perdido — não pode ser desfeito.")}</p>`,
    t("descartar"),
    close
  );
}
function closeActiveTab() { const t = activeTab(); if (t) closeTabById(t.id); }
function reopenClosedTab() { ws = LoroWorkspace.reopenClosed(ws); renderTabs(); renderActive(); }
function cycleTab(back) {
  if (ws.tabs.length < 2) return;
  if (!back) {
    const id = LoroWorkspace.nextMru(ws);
    if (id) return activateTab(id);
  }
  const i = ws.tabs.findIndex((t) => t.id === ws.activeId);
  const n = ws.tabs.length;
  activateTab(ws.tabs[(((i + (back ? -1 : 1)) % n) + n) % n].id);
}
// close any open tab whose rel matches / lives under a (deleted/moved) path
function closeTabsUnder(prefixOrRel, exact) {
  const doomed = ws.tabs.filter((t) => t.rel !== HOME_REL &&
    (exact ? t.rel === prefixOrRel : t.rel.startsWith(prefixOrRel)));
  doomed.forEach((t) => {
    disposeTabState(t.id);
    ws = LoroWorkspace.closeTab(ws, t.id);
  });
  if (doomed.length) { renderTabs(); renderActive(); }
}

function showHome() {
  B.docWrap.hidden = true;
  el.surface.hidden = true;
  B.home.hidden = false;
  B.wsBody.classList.remove("editing");
  clearPanelDoc();
  markSel();
}

// Sem documento aberto a aba "Documento" do painel não tem sujeito: mostra a
// razão em uma linha em vez de cabeçalhos vazios e um botão sem alvo.
// C30 · "Nenhum documento aberto" era falso com quatro abas na faixa: o painel
// não tem sujeito porque nenhum documento está EM FOCO (o usuário está num
// destino). A cópia lê a fonte da verdade — as abas do workspace — e orienta o
// passo seguinte que existe de verdade.
function panelDocEmptyCopy(openDocs) {
  return openDocs > 0
    ? { title: t("Nenhum documento em foco"),
        hint: t("escolha um documento na faixa de abas acima — as habilidades de IA, as versões e o envio para revisão aparecem aqui.") }
    : { title: t("Nenhum documento aberto"),
        hint: t("abra um conhecimento ou uma reunião na barra lateral — as habilidades de IA, as versões e o envio para revisão aparecem aqui.") };
}
function clearPanelDoc() {
  const empty = $("pDocEmpty"), secs = $("pDocSecs");
  const copy = panelDocEmptyCopy(((ws && ws.tabs) || []).filter((tab) => tab.rel !== HOME_REL).length);
  const title = $("pDocEmptyTitle"), hint = $("pDocEmptyHint");
  if (title) title.textContent = copy.title;
  if (hint) hint.textContent = copy.hint;
  if (empty) empty.hidden = false;
  if (secs) secs.hidden = true;
}
function showPanelDocSecs() {
  const empty = $("pDocEmpty"), secs = $("pDocSecs");
  if (empty) empty.hidden = true;
  if (secs) secs.hidden = false;
}
function openHome() {
  const h = homeTab();
  if (h) { ws = LoroWorkspace.setActive(ws, h.id); renderTabs(); }
  closeFind();
  showHome();
}
// (re)initialize the workspace to a single pinned, non-closable Home tab
function setupWorkspace() {
  cmById.forEach((h) => { try { h.destroy(); } catch (_) {} });
  cmById.clear(); savedById.clear(); fmById.clear();
  ws = LoroWorkspace.empty();
  ws = LoroWorkspace.openTab(ws, HOME_REL, { preview: false }).ws;
  ws = LoroWorkspace.pin(ws, LoroWorkspace.activeTab(ws).id);
  renderTabs(); showHome();
}

function docBadge(p, isGuide) {
  if (isGuide) return [t("instruções do loop — aplicadas antes de processar"), "ok"];
  if (p === MANUAL_REL) return [t("manual do Loro — somente leitura"), "ro"];
  // ADR-0026 · não é documento nenhum: é o que o conhecimento diz de si, montado
  // na hora. O selo padrão ("documento do projeto") prometeria um arquivo.
  if (p === INDEX_REL) return [t("calculado agora — não é um arquivo do projeto"), "ro"];
  if (p.startsWith("inbox/")) return [t("pendente — será processado pelo loop"), "ok"];
  if (p.endsWith("guia.md")) return [t("formato antigo — migre para context.md"), "warn2"];
  if (p.endsWith("CHANGELOG.md")) return [t("histórico (append-only)"), "ro"];
  return [t("documento do projeto"), "ro"];
}
// Versioning (git) badge — only on context tabs; a pessoal/ tab never surfaces
// any git state (ADR-0008, LoroWorld.gitVisible).
function setDocGit(p, kind, isGuide) {
  if (isGuide || !LoroWorld.gitVisible(kind)) { B.gitBadge.hidden = true; return; }
  const cls = gitClass(p);
  // C13 · a linha do crumb tem DOIS selos de pintores diferentes: o do MUNDO
  // (LoroWorld.crumbBadge → "versionado") e este, o do ARQUIVO. Dizer "novo (não
  // versionado)" ao lado de "versionado" era afirmar e negar o mesmo fato na
  // mesma linha; o selo do arquivo fala do que ele é de fato — se já existe uma
  // versão salva dele (DESIGN.md §4: versionar → "salvar versão").
  const map = { "g-new": t("sem versão salva"), "g-mod": t("modificado"), "g-del": t("apagado") };
  if (cls && map[cls]) {
    B.gitBadge.hidden = false; B.gitBadge.textContent = map[cls]; B.gitBadge.className = "mono badge " + cls;
    // N8 · o selo ABRE o histórico: o nome acessível diz a ação e o estado, não
    // só o estado (4.1.2) — era anunciado como texto estático.
    const name = `${map[cls]} — ${t("ver o histórico deste documento")}`;
    B.gitBadge.setAttribute("aria-label", name);
    B.gitBadge.title = name;
  } else B.gitBadge.hidden = true;
}

// O tema do editor vem do TEMA DO APP (ADR-0020: `data-theme`, com "sistema"
// resolvido no shell), não direto do sistema operacional. Lendo o SO, escolher
// "escuro" num Mac claro deixava um cartão branco dentro de um app escuro — a
// superfície de escrita era o único lugar que ignorava a escolha do usuário.
const cmTheme = () => (window.LoroShell ? LoroShell.resolvedTheme() : "light");
// read a document's raw text (guide-aware; falls back from context.md to guia.md)
// ADR-0002 §7 — the user manual ships inside the app as a webview asset (one
// file per language), opened as a read-only studio tab; no IPC involved.
const MANUAL_REL = "loro://manual";
async function readDoc(rel) {
  if (rel === SCRATCH_REL) return "";   // rascunho: nasce em branco, não em disco
  if (rel === MANUAL_REL) {
    const r = await fetch(settings.uiLang === "en" ? "manual.en.md" : "manual.pt.md");
    return await r.text();
  }
  if (rel === GUIDE_REL) { try { return await invoke("brain_read_guide"); } catch (_) { return ""; } }
  try { return await invoke("brain_read", { rel }); }
  catch (err) {
    if (rel.endsWith("/context.md")) return await invoke("brain_read", { rel: rel.replace(/\/context\.md$/, "/guia.md") });
    throw err;
  }
}

// O manual precisa abrir mesmo SEM projeto (primeiro uso): a aba do manual
// vive no shell, que o wizard esconde — o clique "funcionava" numa tela
// invisível. Sem shell, o manual abre num modal de leitura.
async function openManual() {
  if (!B.shell.hidden) return openDoc(MANUAL_REL, { preview: false });
  try {
    const txt = await readDoc(MANUAL_REL);
    openModal(t("Como funciona o Loro"), `<div class="manualmodal">${mdRender(txt)}</div>`, null, null);
  } catch (e) { toast(tErr(String(e))); clog("openManual error: " + e); }
}

// ---- barra de formatação markdown (ADR-0016) --------------------------------
// Markdown-aware, não WYSIWYG: o botão aplica ao buffer CM6 a edição mínima que
// LoroMdEdit devolve, então o arquivo em disco continua sendo markdown escrito
// por humano — diff de git limpo e âncoras de anotação (ADR-0007) intactas.
const MD = window.LoroMdEdit;

function applyMdAction(h, action) {
  if (!h) return;
  const sel = h.view.state.selection.main;
  const edit = MD.apply(h.getValue(), sel.anchor, sel.head, action);
  if (!edit) return;
  h.view.dispatch({ changes: edit.changes, selection: edit.selection, scrollIntoView: true });
  h.focus();
}

// Uma barra, duas superfícies (aba do Studio e editor modal): `getHandle`
// resolve o CM6 ativo naquela superfície no momento do clique.
function wireMdBar(bar, getHandle) {
  if (!bar || bar.dataset.wired) return;
  bar.dataset.wired = "1";
  let group = null;
  MD.ACTIONS.forEach((a) => {
    if (group !== null && a.group !== group) {
      const sep = document.createElement("span");
      sep.className = "mdsep";
      bar.appendChild(sep);
    }
    group = a.group;
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.md = a.action;
    b.textContent = a.label;
    b.title = t(a.title);
    // deixa o tooltip sob o applyI18n: uma troca de idioma o retraduz sozinha
    b.dataset.i18nAttrs = "title";
    b.dataset.i18nSrcTitle = a.title;
    // o mousedown roubaria o foco (e a seleção) do editor antes do clique
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => applyMdAction(getHandle(), a.action));
    bar.appendChild(b);
  });
}

// ⌘B/⌘I/⌘K na captura: no WKWebView o atalho nativo aplicaria negrito/itálico
// como HTML dentro do contenteditable do CM6, sujando o buffer.
function wireMdKeys(h) {
  h.view.dom.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const action = MD.KEYS["Mod-" + e.key.toLowerCase()];
    if (!action) return;
    e.preventDefault();
    applyMdAction(h, action);
  }, true);
}

// ---- editor fiel (CodeMirror 6, ADR-0008): um handle por aba em cmById ----
// dirty is the unsaved-buffer dot: cleared by save, set on divergence from disk.
function onEditorChange(id, value) {
  const dirty = value !== savedById.get(id);
  const tab = ws.tabs.find((t) => t.id === id);
  if (tab && dirty) maybeFirstEditNote(tab);
  if (tab && tab.dirty !== dirty) {
    ws = LoroWorkspace.markDirty(ws, id, dirty); renderTabs();
    if (ws.activeId === id) paintEditFoot(ws.tabs.find((x) => x.id === id), true);
  }
}

// ADR-0008/0009: the first time a pessoal/ (personal) draft is edited, surface a
// one-time inline note that it is not versioned. "Shown once" persists locally.
const FIRST_EDIT_KEY = "loro-firstedit-personal";
function maybeFirstEditNote(tab) {
  if (!tab || tab.kind !== "personal") return;
  try { if (localStorage.getItem(FIRST_EDIT_KEY)) return; } catch (_) { return; }
  const note = $("bDraftNote");
  if (note) note.hidden = false;
  try { localStorage.setItem(FIRST_EDIT_KEY, "1"); } catch (_) {}
}
async function saveTab(id, value) {
  const tab = ws.tabs.find((t) => t.id === id);
  if (!tab) return;
  // o rascunho ainda não tem casa: salvar é escolher onde ele vai morar
  if (tab.rel === SCRATCH_REL) return promptSaveScratch(value);
  try {
    if (tab.rel === GUIDE_REL) await invoke("brain_write_guide", { content: value });
    else await invoke("brain_write", { rel: tab.rel, content: value });
    savedById.set(id, value);
    ws = LoroWorkspace.markDirty(ws, id, false);
    renderTabs();
    if (ws.activeId === id) paintEditFoot(ws.tabs.find((x) => x.id === id), true);
    toast(t("salvo"));
    // N14 · refreshTools() caches a habilidade's `description:`/`fonte:` behind a
    // signature made of FILE NAMES only, so editing a habilidade left the picker
    // offering yesterday's skill for the whole session — against ADR-0005 §2
    // ("quem edita a habilidade para acrescentar uma fonte a vê no seletor").
    // The app just wrote the file: it is the one moment it KNOWS the cache is stale.
    if (isHabilidadeRel(tab.rel)) toolsSig = "";
    sideSig = ""; brainRefresh();
  } catch (e) { toast(tErr(String(e))); clog("save doc error: " + e); }
}
// O bundle do CM6 não expõe troca de tema em editor montado, então a mudança
// vale remontando. Só remontamos o que NÃO tem alteração pendente: perder
// digitação para trocar de cor seria um preço absurdo — quem está com rascunho
// aberto continua no tema anterior até salvar.
if (window.LoroShell && LoroShell.onThemeChange) {
  LoroShell.onThemeChange(() => {
    let remontou = false;
    cmById.forEach((h, id) => {
      if (savedById.get(id) !== h.getValue()) return;   // rascunho: preserva
      try { h.view.destroy(); } catch (_) {}
      cmById.delete(id);
      remontou = true;
    });
    if (remontou) renderActive();
  });
}

function saveActive() {
  const t = activeTab();
  if (!t || t.rel === HOME_REL) return;
  const h = cmById.get(t.id);
  // devolve a promessa do DISCO: quem versiona depois de salvar precisa esperar o
  // arquivo, e não a chamada (F30)
  if (h) return saveTab(t.id, h.getValue());
}
// O rodapé de edição (#bEditFoot) nascia `hidden` e NINGUÉM o mostrava: os dois
// handlers wired nele eram inalcançáveis por clique e o modo editar ficava sem
// nenhuma ação primária — o único caminho de salvar era o ⌘S, que a interface não
// documenta em lugar nenhum. Este é o pintor único do rodapé.
function paintEditFoot(tab, editing) {
  const foot = $("bEditFoot");
  if (!foot) return;
  foot.hidden = !editing;
  if (!editing) return;
  const save = $("bSaveVersion");
  // UM rótulo, porque UM ato: o clique grava o arquivo. O commit é do projeto
  // inteiro e vive na Revisão — chamar isto de «Salvar versão» num documento de
  // conhecimento prometia um commit que o clique não faz mais.
  if (save) save.textContent = t("Salvar");
  const note = $("bEditNote");
  if (note) note.textContent = tab && tab.dirty ? t("mudanças não salvas") : t("salvo");
}
async function mountEditor(tab, stale) {
  let h = cmById.get(tab.id);
  if (!h) {
    let raw;
    try { raw = await readDoc(tab.rel); } catch (e) { toast(t("não foi possível abrir")); clog("readDoc error: " + e); return; }
    if (stale && stale()) return; // a newer render won the race
    savedById.set(tab.id, raw);
    h = window.LoroCM6.create({
      parent: B.editHost,
      doc: raw,
      theme: cmTheme(),
      onChange: (v) => onEditorChange(tab.id, v),
      onSave: (v) => saveTab(tab.id, v),
    });
    wireMdKeys(h);
    cmById.set(tab.id, h);
  }
  B.doc.hidden = true;
  B.editHost.hidden = false;
  wireMdBar(B.editBar, () => cmById.get(activeTab() ? activeTab().id : null));
  B.editBar.hidden = false;
  B.wsBody.classList.add("editing"); // ADR-0008: editor ocupa o painel inteiro
  // show only the active tab's editor within the shared host
  cmById.forEach((hh, id) => { hh.view.dom.style.display = id === tab.id ? "" : "none"; });
  requestAnimationFrame(() => h.focus());
}
// ---- B5 · a vista de uma IDEIA -------------------------------------------
// Clicar numa ideia abria `brainstorming/<slug>/indice.md`: o artefato do digest
// cuja UI a ADR-0020 revogou. O usuário caía num documento quase vazio, sem a
// lista de reuniões, sem contagem e sem próximo passo — exatamente o "arrow into
// an empty list" que o DESIGN.md §1 nomeia. O ARQUIVO continua sendo um
// documento comum (a ADR-0020 revogou o fluxo, não o material do usuário: o modo
// editar segue abrindo o texto). O que muda é a VISTA: a ideia mostra o que ela
// já tem e o que fazer com ela.
function ideaSlugOf(rel) {
  const m = /^brainstorming\/([^/]+)\/indice\.md$/.exec(String(rel == null ? "" : rel));
  return m ? m[1] : null;
}
// Decisão pura: quantas peças a ideia tem e, quando não tem nenhuma, qual é a
// frase que orienta o passo seguinte (nunca uma lista vazia calada).
function ideaMaterialCount(counts) {
  const c = counts || {};
  return (Number(c.meetings) || 0) + (Number(c.notes) || 0) + (Number(c.attachments) || 0);
}
function ideaSectionHtml(title, rows, emptyMsg) {
  return `<h2>${esc(title)} <span class="mono">(${rows.length})</span></h2>` +
    (rows.length ? `<ul>${rows.join("")}</ul>` : `<p class="bempty">${esc(emptyMsg)}</p>`);
}
// Um <button class="link"> em vez de um <a> sem href: uma linha da ideia é
// alcançável pelo teclado e anunciada como controle (WCAG 2.1.1 / 4.1.2).
function ideaRowHtml(rel, label) {
  return `<li><button class="link" data-open="${esc(rel)}">${esc(label)}</button></li>`;
}
// N17 · a superfície da ideia era o único leitor que mandava o arquivo CRU para o
// mdRender: o front-matter saía como prosa entre dois <hr> ("loro: 1 id: … refs:
// []") e o `# <nome>` do indice.md repetia o h1 da própria superfície — dois h1
// numa região e um h1 depois de três h2 (WCAG 1.3.1). renderView e
// paintMeetingSurface já separam o front-matter (ADR-0009); esta faz o mesmo e
// ainda tira o título duplicado.
function ideaBodyMarkdown(raw) {
  const split = R.splitFrontMatter(String(raw || ""));
  const body = split && split.body != null ? split.body : String(raw || "");
  return body.replace(/^\s*#\s+[^\n]*\n?/, "");
}
async function renderIdeaSurface(slug, tab, stale) {
  B.editHost.hidden = true;
  B.editBar.hidden = true;
  B.doc.hidden = false;
  B.wsBody.classList.remove("editing");
  fmById.set(tab.id, null);
  let meetings = [], notas = [], anexos = [], nome = slug, body = "";
  try { meetings = (await invoke("brain_list_meetings", { slug })) || []; } catch (_) {}
  try { notas = ((await invoke("brain_list_dir", { rel: `brainstorming/${slug}/notes` })) || []).filter((f) => !f.dir); } catch (_) {}
  try { anexos = ((await invoke("brain_list_dir", { rel: `brainstorming/${slug}/attachments` })) || []).filter((f) => !f.dir); } catch (_) {}
  try {
    const temas = (await invoke("brain_list_brainstorms")) || [];
    const found = temas.find((b) => b && b.slug === slug);
    if (found && found.nome) nome = found.nome;
  } catch (_) {}
  // um buffer editado e não salvo vence o disco, e NÃO reescreve o último salvo
  // (era o que fazia o pontinho de "não salvo" mentir ao voltar para visualizar)
  const h = cmById.get(tab.id);
  if (h) body = h.getValue();
  else {
    try { body = await readDoc(tab.rel); } catch (_) {}
    if (stale && stale()) return; // a newer render won the race
    savedById.set(tab.id, body);
  }
  const total = ideaMaterialCount({ meetings: meetings.length, notes: notas.length, attachments: anexos.length });
  const mtgRows = meetings.map((m) => {
    const title = LM.meetingTitleFromManifest({ titulo: m.titulo }, m.id);
    const label = title === m.id ? LM.meetingLabel(m.id, settings.uiLang) : title;
    return ideaRowHtml(livingRel(m.rel), label);
  });
  const notaRows = notas.map((f) => ideaRowHtml(f.path, shortName(f.name)));
  const anexoRows = anexos.map((f) => ideaRowHtml(f.path, shortName(f.name)));
  // uma ação primária (gravar aqui) + a outra porta real como secundária; o
  // vazio diz o que fazer em vez de descrever a própria vacuidade (§5)
  const acts =
    `<div class="mtg-offer"><button class="btn solid" data-idea="rec">● ${t("gravar reunião aqui")}</button> ` +
    `<button class="btn" data-idea="nota">＋ ${t("nova nota")}</button>` +
    `<p class="mtg-preview">${total
      ? t("o que valer virar conhecimento do time você envia para organizar.")
      : t("nada aqui ainda — grave uma reunião ou escreva uma nota; a transcrição fica na sua máquina.")}</p></div>`;
  B.doc.innerHTML =
    `<h1>${esc(nome)}</h1>` + acts +
    ideaSectionHtml(t("reuniões"), mtgRows, t("nenhuma reunião ainda")) +
    ideaSectionHtml(t("notas"), notaRows, t("nenhuma nota ainda")) +
    ideaSectionHtml(t("anexos"), anexoRows, t("nenhum anexo ainda")) +
    // o texto do próprio indice.md continua visível: é material, e a ADR-0020
    // aposentou o fluxo do digest, não o arquivo. Sem `.annotatable`: anotar
    // depende de decorateAnnotations para PINTAR a marca, e uma anotação que
    // nunca aparece seria um controle mentindo.
    (ideaBodyMarkdown(body).trim() ? mdRender(ideaBodyMarkdown(body), docOpts()) : "");
  wireDocLinks();
  B.doc.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => openDoc(b.dataset.open, { preview: false })));
  const rec = B.doc.querySelector('[data-idea="rec"]');
  if (rec) rec.onclick = () => startMeetingFlow(slug);
  const nota = B.doc.querySelector('[data-idea="nota"]');
  if (nota) nota.onclick = () => promptNewNota(slug, nota);
}

async function renderView(tab, stale) {
  const h = cmById.get(tab.id);
  let raw;
  if (h) raw = h.getValue(); // an edited-but-not-saved buffer wins over disk
  else {
    try { raw = await readDoc(tab.rel); }
    catch (e) { toast(t("não foi possível abrir")); clog("brain_read error: " + e); return; }
    if (stale && stale()) return; // a newer render won the race
    savedById.set(tab.id, raw);
  }
  const fallback = tab.rel === GUIDE_REL
    ? t("_Sem instruções ainda. Escreva orientações que o loop seguirá antes de organizar o que você capturou._")
    : "";
  B.editHost.hidden = true;
  B.editBar.hidden = true;
  B.doc.hidden = false;
  B.wsBody.classList.remove("editing");
  // ADR-0009: strip the leading YAML front-matter and surface it as a collapsible
  // "Referências" panel; a malformed/unterminated block degrades to plain body
  // (splitFrontMatter returns frontMatter:null), never throwing.
  let fm = null, body = raw || "";
  try {
    const split = R.splitFrontMatter(raw || "");
    body = split.body;
    if (split.frontMatter != null) fm = R.parseFrontMatter(split.frontMatter);
  } catch (_) { fm = null; body = raw || ""; }
  fmById.set(tab.id, fm);
  const panel = fm ? renderRefsPanel(fm) : "";
  // ADR-0026: as referências olham para dentro do documento; a volta ("Citado
  // por") olha para fora. As duas nascem na MESMA pintura — uma seção inserida
  // depois desloca o texto que o leitor já começou a ler.
  const back = await backlinksHtmlFor(tab.rel, stale);
  if (stale && stale()) return;
  // ADR-0007: the rendered markdown body is wrapped in an .annotatable container
  // so selection offsets and painted marks are scoped to the content (never the
  // refs panel). GUIDE_REL is not an acervo doc, so it is not annotatable.
  const annotatable = tab.rel !== GUIDE_REL;
  B.doc.innerHTML = panel + back + (annotatable
    ? `<div class="annotatable">${mdRender(body || fallback, docOpts())}</div>`
    : mdRender(body || fallback, docOpts()));
  wireDocLinks();
  wireBacklinks();
  if (annotatable) await decorateAnnotations(tab.rel, stale);
}

// ADR-0009: front-matter refs (+ audio) as a collapsible panel; each row is a
// click target dispatched exactly like an inline ref: link.
function renderRefsPanel(fm) {
  const refs = Array.isArray(fm.refs) ? fm.refs : [];
  const audio = Array.isArray(fm.audio) ? fm.audio : [];
  const all = refs.concat(audio);
  const rows = all.map((r) => {
    if (!r || typeof r !== "object") return "";
    const tipo = r.tipo || (R.tipoFromExt ? R.tipoFromExt(r.caminho || "") : "other");
    const name = (String(r.caminho || "").split("/").pop()) || String(r.caminho || r.id || "");
    return `<li class="refrow"><a class="refitem" data-ref="${esc(String(r.id == null ? "" : r.id))}">` +
      `<span class="reftipo mono">${esc(tipo)}</span><span class="refname">${esc(name)}</span></a></li>`;
  }).join("");
  if (!rows) return "";
  return `<details class="refspanel" open><summary>${t("Referências")} <span class="mono">(${all.length})</span></summary>` +
    `<ul class="reflist">${rows}</ul></details>`;
}

// ============================ ADR-0026: a direção de volta do link ============================
// O painel de Referências olha para DENTRO do documento (o material que ele
// carrega). Uma ligação lateral só era legível na ponta que a escreveu: quem lia
// o documento citado não tinha como saber que alguém dependia dele.
//
// O tipo chega ecoado como QUEM CITA o declarou — `upstream` na página de A quer
// dizer "o alvo entrega para A". Impresso cru na página do alvo, ele diria o
// contrário do que está escrito, então a inversão é decisão da LEITURA e mora
// aqui. Sem tipo declarado não se inventa um: a linha existe (alguém cita) e o
// sentido fica em silêncio.
function backlinkKindLabel(kind) {
  const k = String(kind || "").toLowerCase();
  if (k === "upstream") return t("recebe deste");
  if (k === "downstream") return t("entrega para este");
  if (k === "bidirecional" || k === "bidirectional") return t("nos dois sentidos");
  return "";
}

function backlinksHtml(rows) {
  const list = (rows || []).filter((r) => r && r.rel);
  if (!list.length) return "";   // ninguém cita: nenhuma seção nasce (DESIGN.md §1)
  const items = list.map((r) => {
    const kind = backlinkKindLabel(r.kind);
    // <button>, não <a>: um <a> sem href fica fora da ordem de tabulação e não
    // tem papel de link — a linha do painel de referências ao lado tem esse
    // defeito e ele não se repete numa superfície nova (WCAG 2.1.1 / 4.1.2).
    return `<li class="refrow"><button class="refitem" data-backlink="${esc(r.rel)}">` +
      `<span class="refname">${esc(r.context || r.rel)}</span>` +
      (kind ? `<span class="backkind mono">${esc(kind)}</span>` : "") +
      `</button></li>`;
  }).join("");
  return `<details class="refspanel backpanel" open><summary>${t("Citado por")} ` +
    `<span class="mono">(${list.length})</span></summary>` +
    `<ul class="reflist">${items}</ul></details>`;
}

// Só `contexts/**/context.md` carrega ligação lateral (é o único arquivo que o
// grafo varre), então perguntar por uma nota ou por uma reunião seria IPC à toa.
// Devolve markup em vez de pintar: inserida DEPOIS, a seção empurraria o
// documento para baixo justo quando o leitor começou a ler.
async function backlinksHtmlFor(rel, stale) {
  if (!/^contexts\/.+\/context\.md$/.test(rel)) return "";
  let rows = [];
  try { rows = (await invoke("brain_backlinks", { rel })) || []; }
  catch (e) { clog("brain_backlinks error: " + e); return ""; }
  if (stale && stale()) return "";   // uma leitura mais nova venceu a corrida
  return backlinksHtml(rows);
}
function wireBacklinks() {
  B.doc.querySelectorAll("[data-backlink]").forEach((b) =>
    (b.onclick = () => openDoc(b.dataset.backlink, { preview: true })));
}

// ============================ ADR-0026: índice remissivo (tela, nunca arquivo) ============================
// Um índice gravado no acervo envelhece entre duas escritas e passa a mentir com
// a autoridade de um documento versionado. Este é calculado a cada leitura, a
// partir do que o conhecimento JÁ escreveu: o nome que o vizinho usa no link, o
// título do ponto em aberto, o slug da decisão e o código externo citado.
const INDEX_REL = "loro://indice";

// O endereço tem de ser legível fora da tela: `H-3` sozinho não diz de quem é —
// a numeração é local ao arquivo. O hotspot já chega qualificado do grafo; a
// seção, a decisão e o código externo ganham o nome do tema aqui.
function locatorLabel(e) {
  const ctx = String((e && e.context) || "")
    || String((e && e.rel) || "").replace(/^contexts\//, "").replace(/\/context\.md$/, "");
  const loc = String((e && e.locator) || "");
  if (!loc) return ctx;
  return loc.startsWith(ctx + "#") ? loc : (ctx ? ctx + " " + loc : loc);
}

function indexSurfaceHtml(terms) {
  const list = (terms || [])
    .filter((x) => x && x.term && (x.entries || []).length)
    .sort((a, b) => String(a.term).localeCompare(String(b.term), uiLocale()));
  const head = `<h1>${t("índice remissivo")}</h1>` +
    `<p class="idxlead">${t("cada palavra aqui já está escrita no conhecimento: é o nome que um tema usa para chamar o outro, o título de um ponto em aberto, uma decisão ou um código citado. A tela é recalculada a cada leitura — não existe arquivo de índice para envelhecer.")}</p>`;
  if (!list.length) {
    return head + `<p class="bempty">${t("ainda não há termos — eles aparecem conforme os temas passam a se citar, abrir pontos e registrar decisões.")}</p>`;
  }
  const verbetes = list.map((x) => {
    const locs = (x.entries || []).map((e) =>
      `<a class="loc" href="#" data-path="acervo://${esc(String(e.rel || ""))}"` +
      ` data-term="${esc(String(x.term || ""))}">${esc(locatorLabel(e))}</a>`)
      .join(", ");
    return `<dt class="idxterm">${esc(x.term)}</dt><dd class="idxlocs">${locs}</dd>`;
  }).join("");
  return head + `<dl class="idx">${verbetes}</dl>`;
}

async function renderIndexSurface(tab, stale) {
  B.editHost.hidden = true;
  B.editBar.hidden = true;
  B.doc.hidden = false;
  B.wsBody.classList.remove("editing");
  fmById.set(tab.id, null);
  let terms = [];
  try { terms = (await invoke("brain_index_terms")) || []; }
  catch (e) { clog("brain_index_terms error: " + e); }
  if (stale && stale()) return;
  B.doc.innerHTML = indexSurfaceHtml(terms);
  wireDocLinks();   // o localizador abre pela mesma rota de sempre (brain_resolve_ref)
}

// ============================ reunião: superfície viva (ADR-0010) ============================
// The living reuniao.md tab renders the transcript (append-only, read-only) plus
// an in-tab side rail (audio + artefatos from the manifest) and a DISABLED
// análise section with the per-meeting consent toggle (default OFF; ADR-0011).
// It stays under pessoal/ (kind "personal"), so LoroWorld hides any Git state and
// nothing here ever writes into contexts/.
async function renderMeetingLiving(tab, stale) {
  const id = LM.livingId(tab.rel);
  B.editHost.hidden = true;
  B.editBar.hidden = true;
  B.doc.hidden = false;
  B.wsBody.classList.remove("editing");
  fmById.set(tab.id, null);
  let raw = "", manifest = null;
  try { raw = await readDoc(tab.rel); } catch (_) {}
  try { manifest = await invoke("brain_meeting_manifest", { id }); } catch (_) {}
  if (stale && stale()) return; // a newer render won the race
  const artefatos = await listArtefatos(LM.meetingDir(tab.rel));
  if (stale && stale()) return;
  const status = manifest ? manifest.status : (meeting.id === id ? meeting.phase : "done");
  paintMeetingSurface(id, raw, manifest, status, artefatos, tab.rel, stale);
}

// Lista os ARQUIVOS reais sob <reunião>/notes/ — o skill grava direto em disco
// (não no manifest), então o rail precisa escanear para mostrá-los. ADR-0008:
// todo documento gerado é uma nota, numa pasta plana (sem artefatos/<kind>).
async function listArtefatos(dirRel) {
  let files = [];
  try { files = ((await invoke("brain_list_dir", { rel: `${dirRel}/notes` })) || []).filter((f) => !f.dir); }
  catch (_) {}
  return files.map((f) => ({ kind: "nota", name: f.name, rel: f.path }));
}

// Re-render the living surface in place on meeting-appended, preserving the
// reader scroll: only follow the tail when the user is already at the bottom;
// otherwise keep position and reveal the "novas linhas ↓" pill (ADR-0010 — no
// forced auto-scroll).
async function refreshLivingInPlace(id) {
  const tab = activeTab();
  if (!tab || LM.livingId(tab.rel) !== id) return;
  const wasBottom = nearBottom(B.wsBody);
  const prevTop = B.wsBody.scrollTop;
  let raw = "", manifest = null;
  try { raw = await readDoc(tab.rel); } catch (_) { return; }
  try { manifest = await invoke("brain_meeting_manifest", { id }); } catch (_) {}
  if (ws.activeId !== tab.id) return;
  const artefatos = await listArtefatos(LM.meetingDir(tab.rel));
  if (ws.activeId !== tab.id) return;
  const status = manifest ? manifest.status : (meeting.id === id ? meeting.phase : "done");
  paintMeetingSurface(id, raw, manifest, status, artefatos, tab.rel, () => ws.activeId !== tab.id);
  if (wasBottom) scrollMeetingBottom();
  else { B.wsBody.scrollTop = prevTop; showPill(); }
}

function renderIfLiving(id) {
  const t = activeTab();
  if (t && LM.livingId(t.rel) === id) renderActive();
}

function paintMeetingSurface(id, raw, manifest, status, artefatos, rel, stale) {
  const body = LM.stripMarker(R.splitFrontMatter ? R.splitFrontMatter(raw || "").body : (raw || ""));
  // R19 · o manifest não sabe que o app foi fechado no meio: quem grava é a
  // reunião viva. Tudo abaixo lê o estado EFETIVO.
  const eff = meetingEffectiveStatus(status, id, meeting);
  // ADR-0012: mostra o status do pseudo-stream enquanto grava (preview ao vivo),
  // para o problema "não aparece nada" ser diagnosticável sem olhar logs.
  const preview = eff === "recording" && meeting.id === id && meeting.tailStatus
    ? `<p class="mtg-preview mono">${esc(meeting.tailStatus)}</p>` : "";
  const emptyMsg = eff === "recording"
    ? `<p class="bempty">${t("gravando — o preview ao vivo aparece a cada ~18s conforme houver fala.")}</p>`
    : eff === "interrupted"
    // "não houve fala capturada" seria um palpite: o que se sabe é que a gravação
    // não chegou ao fim.
    ? `<p class="bempty">${t("sem transcrição — a gravação foi interrompida antes de transcrever alguma fala.")}</p>`
    : `<p class="bempty">${t("sem transcrição — não houve fala capturada nesta reunião.")}</p>`;
  // ADR-0018: a análise É a saída da reunião. Encerrada, o único convite era um
  // toast que expira — depois dele a aba ficava com o selo CONCLUÍDA e nenhuma
  // porta para o passo seguinte. DESIGN.md §1: "a finished meeting with no
  // analysis shows ✦ analisar". A oferta é UMA ação, só quando a reunião terminou
  // e ainda não há nada em notes/ (a mesma decisão pura que barra o envio para a
  // fila) — enquanto grava, nenhum cromo novo entra.
  const semAnalise = eff === "done" && !!LM.meetingQueueBlock((artefatos || []).length);
  // R19 · numa reunião interrompida a ação que falta não é analisar: é encerrar.
  // Uma ação primária por tela, e a frase diz o que aconteceu e o que se ganha.
  const offer = eff === "interrupted"
    ? `<div class="mtg-offer"><button class="btn solid" data-mtg="close">■ ${t("encerrar reunião")}</button>` +
      `<p class="mtg-preview">${t("a reunião foi interrompida — encerre para liberar analisar, enviar para organizar e mover")}</p></div>`
    : semAnalise
    ? `<div class="mtg-offer"><button class="btn solid" data-mtg="analyse">✦ ${t("analisar")}</button>` +
      `<p class="mtg-preview">${t("a IA lê a transcrição e escreve a análise")}</p></div>`
    : "";
  // ADR-0007: the transcript body is annotatable (append-only, so anchors stay
  // valid as new lines arrive); the status bar/preview stay outside .annotatable.
  const badge = meetingBadgeStatus(eff, !!state.paused && meeting.id === id);
  // N18 · o corpo de toda reunião começa com o título semeado por meeting.rs: é a
  // fala transcrita — não o arquivo — que decide se há transcrição.
  const spoken = LM.transcriptText(body).trim();
  B.doc.innerHTML =
    `<div class="mtg-surface">` +
      `<div class="mtg-doc">${meetingStatusBar(badge)}${preview}${offer}` +
        (spoken
          ? `<div class="annotatable transcript">${colorSpeakers(mdRender(body, docOpts()))}</div>`
          : `${body.trim() ? mdRender(body, docOpts()) : ""}${emptyMsg}`) +
      `</div>` +
    `</div>`;
  wireMeetingSurface(id);
  wireDocLinks();
  if (spoken && rel) decorateAnnotations(rel, stale);
}


// ADR-0013 grava `[mm:ss · você]` / `[mm:ss · sistema]` no markdown. No modo
// visualizar isso era texto cinza igual ao resto: quem falou sumia. Aqui o selo
// ganha a mesma cor que tem ao vivo (você = teal, os demais = âmbar).
// Roda sobre HTML JÁ escapado por mdRender, então o casamento é seguro.
function colorSpeakers(html) {
  return html.replace(/\[(\d{1,2}:\d{2})\s*·\s*([^\]<]{1,24})\]/g, (m, ts, who) => {
    const me = /^(voc[e\u00ea]|you|eu)$/i.test(who.trim());
    return `<span class="mtg-src${me ? " me" : ""}">${ts} \u00b7 ${who}</span>`;
  });
}

function meetingStatusBar(status) {
  const map = {
    recording: [t("gravando"), "rec"],
    // ADR-0022 §19 · pausada tem selo próprio: o ponto para de pulsar (.warn não
    // anima) porque a captura parou de verdade.
    paused: [t("pausada"), "warn"],
    // R19 · vermelho é gravação em curso (DESIGN.md §3): uma reunião interrompida
    // é pendência, e pendência é âmbar — que também não pulsa.
    interrupted: [t("interrompida"), "warn"],
    transcribing: [t("transcrevendo…"), "warn"],
    done: [t("concluída"), "ok"],
  };
  const [txt, cls] = map[status] || [t("concluída"), "ok"];
  return `<div class="mtg-status ${cls}"><span class="mtg-statusdot"></span><span class="mono">${esc(txt)}</span></div>`;
}
// O manifest só sabe "recording": a pausa é estado da janela. Sem isto o selo da
// superfície ficava byte-a-byte igual ao de gravando, ao lado do rodapé dizendo
// "nada está sendo gravado" — a mesma tela afirmando e negando o mesmo fato.
function meetingBadgeStatus(status, paused) {
  return status === "recording" && paused ? "paused" : status;
}
// R19 · O manifest fica em "recording" enquanto a reunião grava — e CONTINUA nele
// se o app foi fechado (ou caiu) no meio. Depois disso a reunião era um beco sem
// saída: selo vermelho "● gravando" com nada gravando, um ▸ que abria o vazio, e
// analisar / enviar / mover desabilitados "quando a reunião terminar" — sem
// nenhum jeito de terminá-la. Só apagar (destruir o material) estava habilitado.
// Quem grava é a reunião VIVA, e o app sabe qual é: "recording" em qualquer outra
// é uma reunião INTERROMPIDA, e isso é o que a tela passa a dizer.
function meetingEffectiveStatus(status, id, live) {
  if (status !== "recording") return status;
  return live && live.active && live.id === id ? "recording" : "interrupted";
}
// A saída: encerrar de verdade, com o comando que já existe (ele só troca o
// status no manifest — a transcrição, as notas e os anexos ficam onde estão).
async function finishInterruptedMeeting(id, rel) {
  try {
    await invoke("brain_meeting_finish", { id });
    pessoalSig = ""; refreshPessoal();
    if (rel) refreshTabFromDisk(livingRel(rel));
    toast(t("reunião encerrada — a transcrição foi mantida"));
  } catch (e) {
    toast(t("não encerrei a reunião") + ": " + tErr(String(e)));
    clog("finish interrupted meeting error: " + e);
  }
}

// ============================ anotações (ADR-0007) ============================
// A selection over any rendered markdown (a context doc OR a meeting transcript)
// raises a floating popover: grifar · comentar · perguntar · analisar · Slack.
// Highlights/comments persist in a co-located sidecar (Rust), anchored by TEXT
// QUOTE (src/annotate.js) so they survive re-render and — since a transcript is
// append-only — live appends. The excerpt is addressable as `acervo://<rel>#id`,
// which feeds the excerpt-scoped habilidades. Read-view only for now; CM6 edit
// decorations are recorded as GUI-verification debt (ADR-0007).
let annotState = { rel: null, list: [], orphans: [] };
let _annotPop = null;

function annotPop() {
  if (!_annotPop) {
    _annotPop = document.createElement("div");
    _annotPop.className = "annot-pop";
    _annotPop.hidden = true;
    // N10 · era um <div> nu: sem papel, sem nome, sem Escape e sem foco — a
    // camada de anotações existia só para o mouse (WCAG 4.1.2 / 2.1.1).
    _annotPop.setAttribute("aria-label", t("ações do trecho"));
    _annotPop.addEventListener("mousedown", (e) => e.stopPropagation());
    document.body.appendChild(_annotPop);
  }
  return _annotPop;
}
let _annotReturnFocus = null;
function hideAnnotPop() {
  if (_annotPop) _annotPop.hidden = true;
  // quem abriu volta a dizer que está fechado — uma marca "expandida" sobre um
  // popover invisível é estado mentindo (4.1.2)
  if (_annotReturnFocus && _annotReturnFocus.setAttribute) _annotReturnFocus.setAttribute("aria-expanded", "false");
}
// Escape / Tab: fecha E devolve o foco a quem abriu (a marca grifada, quando havia
// uma). As ações não passam por aqui — cada uma leva o foco para o seu destino.
function closeAnnotPop() {
  const back = _annotReturnFocus;
  hideAnnotPop();
  _annotReturnFocus = null;
  if (back && back.focus) back.focus();
}
// O popover é um menu flutuante como os outros 14: o teclado dele vem do helper
// único (F17) — role=menu com menuitem de verdade, setas, Home/End, uma entrada de
// foco só, e Escape/Tab que fecham. Antes ele declarava role="menu" com <button>s
// soltos: um menu de ZERO itens para quem lê a tela, sem setas.
function focusAnnotPop(returnTo, opts) {
  _annotReturnFocus = returnTo || null;
  wireFloatMenu(annotPop(), returnTo, closeAnnotPop, opts);
}
function annotBtn(a, label, extra) { return `<button class="annot-act${extra ? " " + extra : ""}" data-a="${a}">${esc(label)}</button>`; }

function positionPop(rect) {
  const pop = annotPop();
  // o nome do popover é reescrito a cada abertura: criado uma vez, ele não passa
  // pelo aplicador de idioma (o mesmo motivo do data-i18n-dyn)
  pop.setAttribute("aria-label", t("ações do trecho"));
  pop.hidden = false;
  const h = pop.offsetHeight || 40, w = pop.offsetWidth || 220;
  let top = rect.top - h - 8;
  if (top < 8) top = rect.bottom + 8;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - w - 8);
  pop.style.top = top + "px";
  pop.style.left = left + "px";
}

function annotContainer() { return B.doc.querySelector(".annotatable"); }
function toolRelByName(name) { const f = lastToolFiles.find((x) => x.name === name); return f ? f.path : null; }

async function loadAnnotations(rel) {
  try { const f = await invoke("brain_annotations_get", { rel }); return (f && f.anotacoes) || []; }
  catch (_) { return []; }
}

// Paint every locatable annotation as <mark data-annot-id>; return the ones that
// no longer resolve (orphans) so the panel can surface them instead of dropping
// them silently (ADR-0007 — nothing by accident).
function paintAnnotations(container, list) {
  const text = container.textContent;
  const orphans = [];
  for (const a of list) {
    const loc = window.LoroAnnotate.locate(text, (a && a.anchor) || {});
    if (!loc) { orphans.push(a); continue; }
    const cls = "annot" + (a.comentarios && a.comentarios.length ? " has-comment" : "") +
      (a.cor ? " cor-" + String(a.cor).replace(/[^a-z]/gi, "") : "");
    window.LoroAnnotate.paintRange(container, loc.start, loc.end, { "data-annot-id": a.id, class: cls });
  }
  return orphans;
}

// Load + paint + wire annotations for the currently-rendered doc. Called at the
// end of renderView / paintMeetingSurface. Two guards drop a superseded run:
// `stale()` (the renderActive renderGen — the annotation load is a slow IPC
// round-trip during which the user can switch docs) AND container identity (a
// newer render replaced the .annotatable). `annotState.rel` is committed
// SYNCHRONOUSLY up front so a selection made before the load resolves targets
// THIS doc, never the previous one (a highlight would otherwise land elsewhere).
async function decorateAnnotations(rel, stale) {
  const container = annotContainer();
  if (!container || !rel) { annotState = { rel: null, list: [], orphans: [] }; return; }
  annotState = { rel, list: [], orphans: [] };
  const list = await loadAnnotations(rel);
  if ((stale && stale()) || annotContainer() !== container) return; // a newer render won
  const orphans = paintAnnotations(container, list);
  annotState = { rel, list, orphans };
  wireMarks(container);
  renderAnnotPanel(container);
}

function wireMarks(container) {
  container.querySelectorAll("mark.annot[data-annot-id]").forEach((m) => {
    m.onclick = (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      const a = (annotState.list || []).find((x) => x.id === m.getAttribute("data-annot-id"));
      if (a) openMarkPopover(a, m.getBoundingClientRect(), m);
    };
    // N10 · a marca é a única porta para comentar/perguntar/analisar/desgrifar:
    // sem tabindex/role/nome ela era invisível ao teclado e ao leitor de tela.
    m.setAttribute("tabindex", "0");
    m.setAttribute("role", "button");
    m.setAttribute("aria-label", `${t("trecho grifado")}: ${m.textContent}`);
    // o Enter abre um menu: dizê-lo ANTES do primeiro toque é o que o leitor de
    // tela precisa para saber que existe algo a abrir (4.1.2)
    m.setAttribute("aria-haspopup", "true");
    m.setAttribute("aria-expanded", "false");
    wireActivateKeys(m);
  });
}

// Selection → popover. Deferred a tick so the browser has committed the
// selection; ignored unless the range sits inside the annotatable container.
function annotOnMouseUp() {
  setTimeout(() => {
    const container = annotContainer();
    if (!container) return;
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer) || !sel.toString().trim()) return;
    const a = rangeLenTo(container, range.startContainer, range.startOffset);
    const b = rangeLenTo(container, range.endContainer, range.endOffset);
    const s = Math.min(a, b), e = Math.max(a, b);
    if (e - s < 1) return;
    const anchor = window.LoroAnnotate.makeAnchor(container.textContent, s, e);
    openSelectionPopover(anchor, range.getBoundingClientRect(), null, { keepSelection: true });
  }, 0);
}
// Length of text from the container start up to (node, offset) — the plain-text
// offset the anchor is expressed in (Range.toString adds no newlines, matching
// textContent, so it lines up with makeAnchor/locate).
function rangeLenTo(container, node, offset) {
  const r = document.createRange();
  r.setStart(container, 0);
  r.setEnd(node, offset);
  return r.toString().length;
}

function openSelectionPopover(anchor, rect, returnTo, opts) {
  const pop = annotPop();
  pop.innerHTML =
    annotBtn("grifar", "✎ " + t("grifar")) +
    annotBtn("comentar", "💬 " + t("comentar")) +
    annotBtn("perguntar", "? " + t("perguntar")) +
    annotBtn("analisar", "✦ " + t("analisar")) +
    annotBtn("slack", "➤ Slack");
  pop.querySelector('[data-a="grifar"]').onclick = async () => { hideAnnotPop(); await ensureHighlight(anchor); };
  pop.querySelector('[data-a="comentar"]').onclick = () => { hideAnnotPop(); promptComment((txt) => ensureHighlight(anchor, { comentarios: [{ texto: txt }] })); };
  pop.querySelector('[data-a="perguntar"]').onclick = () => { hideAnnotPop(); runExcerptSkill("loro-question.md", anchor); };
  pop.querySelector('[data-a="analisar"]').onclick = () => { hideAnnotPop(); runExcerptSkill("loro-analyse.md", anchor); };
  pop.querySelector('[data-a="slack"]').onclick = () => { hideAnnotPop(); runExcerptSkill("loro-slack.md", anchor); };
  positionPop(rect);
  // veio de uma seleção de mouse: a seleção é o assunto, e o foco fica onde está
  focusAnnotPop(returnTo, opts && opts.keepSelection ? { focus: false } : undefined);
}

// N10 · o único caminho para criar uma anotação era um arrasto de mouse real
// (`annotOnMouseUp`): num documento de leitura o teclado não tem cursor de
// texto, então grifar/comentar/perguntar não existiam sem mouse. Aqui o trecho
// é DITO — escrito ou colado — e o resto do fluxo é o mesmo popover.
function excerptRangeIn(text, needle) {
  const hay = String(text || ""), q = String(needle || "").trim();
  if (!q) return null;
  let i = hay.indexOf(q);
  if (i < 0) i = hay.toLowerCase().indexOf(q.toLowerCase());
  return i < 0 ? null : { start: i, end: i + q.length };
}
function promptAnnotateExcerpt() {
  const container = annotContainer();
  if (!container) { toast(t("abra um documento de leitura para grifar um trecho")); return; }
  openModal(
    t("Grifar um trecho"),
    `<p class="pmnote">${t("escreva ou cole o trecho exato do documento — o grifo abre as ações do trecho.")}</p>` +
      `<label class="wfield"><span class="mono">${t("trecho")}</span>` +
      `<input id="annotExcerpt" type="text" spellcheck="false"></label>`,
    t("grifar"),
    async () => {
      const q = (($("annotExcerpt") && $("annotExcerpt").value) || "").trim();
      const box = annotContainer();
      if (!box) { toast(t("abra um documento de leitura para grifar um trecho")); return; }
      const range = excerptRangeIn(box.textContent, q);
      if (!range) { toast(t("não encontrei esse trecho no documento")); return; }
      const anchor = window.LoroAnnotate.makeAnchor(box.textContent, range.start, range.end);
      // N11 · o id da anotação nova voltava daqui e era descartado; o foco ia
      // para `querySelector("mark.annot")`, que é o PRIMEIRO grifo do documento.
      // Como o Enter dali abre ✕ desgrifar, o caminho de teclado apagava uma
      // passagem que o usuário não tocou (WCAG 2.1.1/4.1.2).
      const id = await ensureHighlight(anchor);
      if (!id) return;
      // a marca recém-pintada é o controle: o foco vai para ela, e dali o Enter
      // abre comentar / perguntar / analisar / Slack / desgrifar
      const cont = annotContainer();
      const mark = cont && cont.querySelector(`mark.annot[data-annot-id="${CSS.escape(id)}"]`);
      if (mark && mark.focus) mark.focus();
    }
  );
}

function openMarkPopover(a, rect, returnTo) {
  const pop = annotPop();
  const rel = annotState.rel;
  const comments = (a.comentarios || []).map((c) => `<div class="annot-cmt">${esc(c.texto)}</div>`).join("") ||
    `<div class="annot-none mono">${t("sem comentários")}</div>`;
  // os comentários são leitura, não uma ação: role=presentation os mantém fora da
  // contagem de itens do menu (o mesmo tratamento que .fhead recebe)
  pop.innerHTML = `<div class="annot-cmts" role="presentation">${comments}</div>` +
    annotBtn("comentar", "💬 " + t("comentar")) +
    annotBtn("perguntar", "? " + t("perguntar")) +
    annotBtn("analisar", "✦ " + t("analisar")) +
    annotBtn("slack", "➤ Slack") +
    annotBtn("desgrifar", "✕ " + t("desgrifar"), "danger");
  const alvo = `acervo://${rel}#${a.id}`;
  pop.querySelector('[data-a="comentar"]').onclick = () => { hideAnnotPop(); promptComment(async (txt) => {
    try { await invoke("brain_annotation_update", { rel, id: a.id, patch: { addComentario: { texto: txt } } }); await renderActive(); }
    catch (e) { toast(tErr(String(e))); }
  }); };
  pop.querySelector('[data-a="perguntar"]').onclick = () => { hideAnnotPop(); useExcerptTool("loro-question.md", alvo); };
  pop.querySelector('[data-a="analisar"]').onclick = () => { hideAnnotPop(); useExcerptTool("loro-analyse.md", alvo); };
  pop.querySelector('[data-a="slack"]').onclick = () => { hideAnnotPop(); useExcerptTool("loro-slack.md", alvo); };
  pop.querySelector('[data-a="desgrifar"]').onclick = async () => {
    hideAnnotPop();
    try { await invoke("brain_annotation_delete", { rel, id: a.id }); await renderActive(); toast(t("grifo removido")); }
    catch (e) { toast(tErr(String(e))); }
  };
  positionPop(rect);
  focusAnnotPop(returnTo);
}

function useExcerptTool(name, alvo) {
  const rel = toolRelByName(name);
  // N15 · the refusal was hand-written for Slack and served ALL THREE actions:
  // clicking "perguntar" named a product the user never chose. The name comes from
  // the same label the clicked row shows (DESIGN.md §4).
  if (!rel) { toast(habilidadeLabel({ name }) + " — " + t("habilidade indisponível")); return; }
  promptUseTool(rel, alvo);
}

// A fresh selection sent to a habilidade first MATERIALIZES a highlight, so the
// excerpt is both evidenced on screen and addressable (`acervo://rel#id`) when
// the skill runs — exactly the "destaco o trecho para evidenciá-lo na análise"
// flow (owner request).
async function ensureHighlight(anchor, extra) {
  const rel = annotState.rel;
  if (!rel) return null;
  try {
    const anotacao = Object.assign({ tipo: "grifo", cor: "amarelo", anchor }, extra || {});
    const id = await invoke("brain_annotation_add", { rel, anotacao });
    await renderActive();
    return id;
  } catch (e) { toast(tErr(String(e))); return null; }
}
async function runExcerptSkill(name, anchor) {
  const rel = annotState.rel;
  if (!rel) return;
  const id = await ensureHighlight(anchor);
  if (id) useExcerptTool(name, `acervo://${rel}#${id}`);
}

function promptComment(onText) {
  openModal(
    t("comentar trecho"),
    `<label class="wfield"><span class="mono">${t("comentário")}</span>` +
    `<input id="annotCmt" type="text" spellcheck="false" placeholder="${t("ex.: preciso da sua ajuda com isso")}"></label>`,
    t("salvar"),
    () => {
      const txt = (($("annotCmt") && $("annotCmt").value) || "").trim();
      if (!txt) { toast(t("escreva um comentário")); return; }
      onText(txt);
    }
  );
  const i = $("annotCmt"); if (i) i.focus();
}

// "Reunir os comentários" (owner request): a collapsible panel, rendered as a
// SIBLING after the annotatable container (never inside it — its text must not
// pollute the offsets the anchors are measured against). Lists every commented
// passage plus any orphans, each row scrolling to its mark.
function renderAnnotPanel(container) {
  const old = B.doc.querySelector(".annot-panel");
  if (old) old.remove();
  const withC = (annotState.list || []).filter((a) => a.comentarios && a.comentarios.length);
  const orphans = annotState.orphans || [];
  if (!withC.length && !orphans.length) return;
  const quote = (a) => esc(String((a.anchor && a.anchor.quote) || "").slice(0, 80));
  const rows = withC.map((a) =>
    `<div class="annot-prow" data-goto="${esc(a.id)}"><div class="annot-pquote mono">“${quote(a)}”</div>` +
    (a.comentarios || []).map((c) => `<div class="annot-pcmt">${esc(c.texto)}</div>`).join("") + `</div>`).join("");
  const orph = orphans.length
    ? `<div class="annot-orphans"><div class="annot-ohead mono">${t("trechos órfãos")} (${orphans.length})</div>` +
      orphans.map((a) => `<div class="annot-pcmt">“${quote(a)}”</div>`).join("") + `</div>`
    : "";
  const panel = document.createElement("details");
  panel.className = "annot-panel";
  panel.innerHTML = `<summary>💬 ${t("comentários")} (${withC.length})</summary>${rows}${orph}`;
  container.insertAdjacentElement("afterend", panel);
  panel.querySelectorAll("[data-goto]").forEach((el) => (el.onclick = () => {
    const m = container.querySelector(`mark[data-annot-id="${el.getAttribute("data-goto")}"]`);
    if (m) m.scrollIntoView({ block: "center" });
  }));
}

// Global wiring (once): selection inside the doc opens the popover; a click
// elsewhere or a scroll dismisses it.
B.doc.addEventListener("mouseup", annotOnMouseUp);
document.addEventListener("mousedown", (e) => { if (!_annotPop || _annotPop.hidden) return; if (!_annotPop.contains(e.target)) hideAnnotPop(); });
B.wsBody.addEventListener("scroll", hideAnnotPop, { passive: true });

function wireMeetingSurface(id) {
  // O controle da gravação vive no rodapé compartilhado (#recFoot), não aqui.
  // O que vive aqui é a oferta de análise de uma reunião concluída (ADR-0018):
  // o MESMO caminho das habilidades, não um segundo.
  const go = B.doc.querySelector('[data-mtg="analyse"]');
  if (go) go.onclick = () => runMeetingSkill("analyse", id);
  // R19 · a saída de uma reunião interrompida
  const close = B.doc.querySelector('[data-mtg="close"]');
  if (close) close.onclick = () => finishInterruptedMeeting(id, currentMeetingDir(id));
}

// Resolve the acervo-relative meeting dir for a skill run: the active living/
// report tab is the source of truth; fall back to the recording meeting's dir.
function currentMeetingDir(id) {
  const t = activeTab();
  if (t) { const d = LM.meetingDir(t.rel); if (d) return d; }
  if (meeting.id === id && meeting.dir) return meeting.dir;
  return null;
}

// ADR-0012: inject the skill slash command into the terminal Claude. We reuse
// termRun (opens the panel + types the command via term_input) — no in-app model
// call. Results appear in the terminal AND, as the skill writes them, under the
// meeting's notes/; we refresh the tree afterwards so the new
// files surface (the skill never touches manifest.json, so the rail's artefatos
// list only reflects app-written artifacts).
async function runMeetingSkill(kind, id, question, dirOverride) {
  const dir = dirOverride || currentMeetingDir(id);
  if (!dir) { toast(t("abra a reunião para analisar")); return; }
  const cmd = LM.meetingSkillCmd(kind, dir, question);
  if (!cmd) { toast(t("digite uma pergunta")); return; }
  // "análise enviada ao agente" saía antes do envio e sem dizer onde olhar: o
  // chat logo abaixo dizia "nada foi enviado".
  const done = `${kind === "question" ? t("pergunta enviada") : t("análise enviada")} — ${aiTargetHint()}`;
  if (!await dispatchAi(cmd, done)) return;
  // A skill write is async and IPC-free (no pessoal-changed event), so nudge a
  // couple of tree/surface refreshes to reveal the artefatos it produces.
  scheduleMeetingSkillRefresh(id);
}
function scheduleMeetingSkillRefresh(id) {
  [6000, 20000].forEach((ms) => setTimeout(() => {
    pessoalSig = ""; refreshPessoal(); renderIfLiving(id);
  }, ms));
}

// "perguntar…": prompt for a free-text question, then inject /loro-question. Uses the
// shared modal (window.prompt is unreliable in the webview) mirroring pickMeeting.
function askMeetingQuestion(id, dirOverride) {
  const dir = dirOverride || currentMeetingDir(id);
  if (!dir) { toast(t("abra a reunião para responder")); return; }
  openModal(
    t("Perguntar sobre a reunião"),
    `<p class="pmnote">${t("a pergunta roda no agente do projeto; a resposta fica também nas notas da reunião.")} ${esc(aiTargetHint())}</p>` +
      `<label class="wfield"><span class="mono">${t("pergunta")}</span>` +
      `<input id="mtgQuestion" type="text" placeholder="${t("ex.: quais decisões ficaram em aberto?")}" spellcheck="false"></label>`,
    t("perguntar"),
    () => {
      const q = (($("mtgQuestion") && $("mtgQuestion").value) || "").trim();
      if (!q) { toast(t("digite uma pergunta")); return; }
      runMeetingSkill("question", id, q, dirOverride);
    }
  );
  const inp = $("mtgQuestion"); if (inp) inp.focus();
}

// Fill the análise rail with the honest ai_doctor posture and wire the local
// "ver auditoria" read (ADR-0011). No AI action is wired here: the analisar
// button stays disabled and nothing leaves the machine — this only reads
// booleans (ai_doctor) and the meeting-local audit (brain_meeting_audit).
async function wireMeetingAi(id) {
  const statusEl = B.doc.querySelector("#mtgAiStatus");
  const sink = B.doc.querySelector("#mtgAiSink");
  try {
    const d = await invoke("ai_doctor");
    if (statusEl) statusEl.textContent = LM.aiStatusLine(d, settings.uiLang);
    // The disclosure text comes from the backend (ADR-0011 constant); its
    // visibility is driven by the cloud toggle in wireMeetingSurface.
    if (sink) sink.textContent = (d && d.ambientBinarySink) || "";
  } catch (e) {
    if (statusEl) statusEl.textContent = t("status indisponível");
    clog("ai_doctor error: " + e);
  }
  const auditBtn = B.doc.querySelector("#mtgAuditBtn");
  const list = B.doc.querySelector("#mtgAuditList");
  if (auditBtn && list) auditBtn.onclick = () => showMeetingAudit(id, list);
}

// Render the meeting-local audit — the user-facing "what left the machine"
// list (ADR-0011). In v1 no external call happens, so it is empty and shows the
// honest reassurance. Content read here stays local (the file is quarantined
// under pessoal/ by git.rs); it is never shared or PR'd.
async function showMeetingAudit(id, list) {
  if (!list.hidden) { list.hidden = true; return; }
  list.hidden = false;
  list.innerHTML = `<li class="bempty">${t("carregando…")}</li>`;
  let events = [];
  try { events = await invoke("brain_meeting_audit", { id }); }
  catch (e) { list.innerHTML = `<li class="bempty">${t("não li a auditoria")}</li>`; clog("meeting_audit error: " + e); return; }
  if (!events || !events.length) {
    list.innerHTML = `<li class="bempty">${t("nada saiu desta máquina")}</li>`;
    return;
  }
  list.innerHTML = events.map((ev) =>
    `<li class="mtg-auditrow"><span class="mtg-audittarget">${esc(ev.target || "?")}</span>` +
    `<span class="mtg-auditmeta">${esc(ev.kind || "")} · ${esc(String(ev.tokens || 0))} tokens · ${esc(ev.when || "")}</span></li>`
  ).join("");
}

// Artifact click: docs open as a tab; charts/images embed via brain_read_asset
// (CSP-safe data: URI); anything else opens in the OS default app — all guarded
// to the acervo root in Rust (ADR-0009/0010).
async function mtgOpenArtifact(rel, name) {
  const key = name || rel;
  if (/\.(md|txt)$/i.test(key)) { openDoc(rel, { preview: true }); return; }
  if (/\.(svg|png|jpe?g|gif|webp)$/i.test(key)) {
    try { const a = await invoke("brain_read_asset", { rel }); mtgShowImage(rel, a.mime, a.base64); }
    catch (e) { toast(t("não abri a imagem")); clog("read_asset error: " + e); }
    return;
  }
  mtgOpenExternal(rel);
}
async function mtgOpenExternal(rel) {
  try { await invoke("brain_open_external", { rel }); }
  catch (e) { toast(t("não abri o arquivo")); clog("open_external error: " + e); }
}

// ADR-0010: delete one audio track (mic/system/completo). Guarded by a confirm
// (destructive, and BR-1 makes it local-only — there is no copy elsewhere), then
// repaints the living surface from the manifest the backend returns.
function mtgDeleteAudio(id, which) {
  const label = { completo: t("áudio completo"), mic: t("microfone"), system: t("sistema") }[which] || t("áudio");
  // N23 · mesma folha, mesmo vocabulário das outras exclusões (BR-1: a única cópia
  // é local, então não há de onde recuperar)
  openModal(
    `${t("Apagar o")} ${label}?`,
    `<p class="pmnote">${t("desta reunião? Esta ação não pode ser desfeita.")}</p>`,
    t("apagar"),
    async () => {
      try {
        await invoke("brain_meeting_delete_audio", { input: { id, which } });
        toast(`${label} ${t("apagado")}`);
        refreshLivingInPlace(id); // repinta a partir do manifest atualizado
      } catch (e) { toast(t("não apaguei o áudio") + ": " + tErr(String(e))); clog("delete_audio error: " + e); }
    }
  );
}
function mtgShowImage(rel, mime, base64) {
  openModal(String(rel).split("/").pop(), `<div class="mtg-imgwrap"><img alt="" src="data:${mime};base64,${base64}"></div>`, null, null);
}

// "novas linhas ↓" pill + tail-follow (no forced auto-scroll; ADR-0010).
function nearBottom(elm) { return elm.scrollHeight - elm.scrollTop - elm.clientHeight < 48; }
function scrollMeetingBottom() { B.wsBody.scrollTop = B.wsBody.scrollHeight; hidePill(); }
function showPill() { const p = $("mtgPill"); if (p) p.hidden = false; }
function hidePill() { const p = $("mtgPill"); if (p) p.hidden = true; }

// START picker: choose an existing tema or type a new one (+ optional title).
// Resolves to {tema,titulo} on confirm or null on cancel/close.
function pickMeeting(temas, presetTema, opts2) {
  const allowLoose = !!(opts2 && opts2.allowLoose);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; resolve(v); };
    // ● flow: the destination select leads with the explicit one-off option
    // (value "") — recording is never loose by default (decision 2026-07-28).
    const loose = allowLoose
      ? `<option value="">${t("transcrição avulsa (salvar ao final)")}</option>`
      : "";
    const opts = (temas || []).map((t) =>
      `<option value="${esc(t.slug)}"${t.slug === presetTema ? " selected" : ""}>${esc(t.nome || t.slug)}</option>`).join("");
    // ADR-0013: the brainstorming comes from the select (created elsewhere — no
    // "novo tema" field here). With none yet, a single name field bootstraps one.
    // Fields use the app's canonical `.wfield` pattern (same as the setup wizard).
    const temaField = (temas && temas.length) || allowLoose
      ? `<label class="wfield"><span class="mono">${allowLoose ? t("onde salvar") : t("ideia")}</span>` +
          `<select id="mtgTema">${loose}${opts}</select></label>`
      : `<label class="wfield"><span class="mono">brainstorming</span>` +
          `<input id="mtgNovoTema" type="text" placeholder="${t("ex.: frota 2026")}" spellcheck="false"></label>`;
    const html =
      `<p class="pmnote">${t("a reunião é gravada 100% na sua máquina — o áudio nunca sai do computador.")}</p>` +
      temaField +
      `<label class="wfield"><span class="mono">${t("título")}</span>` +
        `<input id="mtgTitulo" type="text" placeholder="${t("opcional — ex.: semanal de custos")}" spellcheck="false"></label>`;
    openModal(allowLoose ? t("Nova gravação") : t("Nova reunião"), html, t("começar"), () => {
      const selEl = $("mtgTema");
      const novo = (($("mtgNovoTema") && $("mtgNovoTema").value) || "").trim();
      const tema = selEl ? selEl.value : novo;
      const titulo = (($("mtgTitulo") && $("mtgTitulo").value) || "").trim();
      // the modal closes on confirm regardless; abort (never hang) if no brainstorming
      if (!tema && !allowLoose) { toast(t("escolha ou nomeie uma ideia")); finish(null); return; }
      finish({ tema: tema || null, titulo: titulo || null });
    }, () => finish(null)); // cancelar, ×, Escape ou clique fora: todos respondem
  });
}

// contextual header actions (move/delete) for the active document
function applyDocActions(rel) {
  const isQueue = rel.startsWith("inbox/") && !rel.endsWith("_prompt.md");
  const movable = isQueue || /^(meetings|notes|reunioes|notas)\//.test(rel) ||
    /^contexts\/.+\/(referencias|brainstorming)\//.test(rel);
  $("bDocActs").hidden = !movable;
  $("bDelDoc").hidden = !isQueue;
  if (isQueue) {
    const qname = rel.slice(6);
    $("bMoveDoc").onclick = (e) => { e.stopPropagation(); openMoveMenu($("bMoveDoc"), qname); };
    $("bDelDoc").onclick = (e) => { e.stopPropagation(); openConfirmDelete($("bDelDoc"), qname); };
  } else if (movable) {
    $("bMoveDoc").onclick = (e) => { e.stopPropagation(); openMoveFileMenu($("bMoveDoc"), rel); };
  }
}

// render the active tab's content into the document pane (view or edit)
// renderActive is serialized by a generation token (ADR-0002 §3): concurrent
// calls (rapid tab switches, view/edit toggles) can interleave awaits, so only
// the LATEST generation may keep going after any await — the winner alone
// touches editor/doc visibility. Cheaper and stricter than the old per-id
// guard (covers same-tab re-renders too).
let renderGen = 0;
async function renderActive() {
  const gen = ++renderGen;
  const stale = () => gen !== renderGen;
  hidePill();
  const tab = activeTab();
  if (!tab || tab.rel === HOME_REL) { showHome(); return; }
  const isGuide = tab.rel === GUIDE_REL;
  B.home.hidden = true;
  el.surface.hidden = true;   // abrir um documento sai da vista de gravação
  B.docWrap.hidden = false;
  $("bDraftNote").hidden = true;   // the first-edit note is one-time; reset per render
  paintEditFoot(null, false);      // o rodapé de edição é reaberto abaixo, se for o caso
  closeFind();
  B.crumb.textContent = isGuide ? t("instruções do loop")
    : tab.rel === MANUAL_REL ? t("manual de uso")
    : tab.rel === INDEX_REL ? t("índice remissivo")
    : tab.rel === SCRATCH_REL ? t("nota nova — ainda não salva") : tab.rel;
  // permanent world badge (versionado / rascunho), else document-specific badge
  const world = LoroWorld.crumbBadge(tab.kind, settings.uiLang);
  const [label, cls] = world && !isGuide ? [world.label, world.cls] : docBadge(tab.rel, isGuide);
  B.badge.textContent = label; B.badge.className = "mono badge " + cls;
  setDocGit(tab.rel, tab.kind, isGuide);
  if (isGuide) $("bDocActs").hidden = true; else applyDocActions(tab.rel);
  // ADR-0005 (owner request): habilidade/pedir à IA/versionar live in the
  // doc's right-side rail, not the header — a meeting's living surface
  // renders its own surface (paintMeetingSurface) instead.
  renderDocRail(tab, isGuide);
  // ADR-0010: a meeting living file (reuniao.md) is its own append-only surface —
  // transcript + artefatos rail + análise/consent; no free-form CM6 editing.
  // ADR-0026: o índice remissivo é uma TELA, no mesmo cartão de 700px do resto
  // da leitura — sem modos (não há o que editar) e sem ações de arquivo.
  if (tab.rel === INDEX_REL) {
    B.modes.hidden = true;
    $("bPromoted").hidden = true;
    $("bDocActs").hidden = true;
    // não há documento em foco: o painel diria "rascunho — não versionado" de uma
    // tela que não é arquivo nenhum, e ofereceria habilidades sem sujeito.
    clearPanelDoc();
    await renderIndexSurface(tab, stale);
    if (stale()) return;
    B.wsBody.scrollTop = 0;
    markSel();
    return;
  }
  if (LM.isLiving(tab.rel)) {
    B.modes.hidden = true;
    $("bPromoted").hidden = true;
    $("bDocActs").hidden = true;
    $("bDocRail").hidden = true;
    await renderMeetingLiving(tab, stale);
    if (stale()) return;
    B.wsBody.scrollTop = 0;
    markSel();
    return;
  }
  const scratch = tab.rel === SCRATCH_REL;
  const textFile = isGuide || scratch || /\.(md|txt)$/i.test(tab.rel);
  B.modes.hidden = !textFile;
  B.viewBtn.classList.toggle("on", tab.mode !== "edit");
  B.editBtn2.classList.toggle("on", tab.mode === "edit");
  const editing = textFile && tab.mode === "edit";
  // B5 · uma ideia abre a SUA vista, não o indice.md quase vazio. Editar continua
  // valendo: o arquivo é um documento comum (ADR-0020).
  const idea = !editing ? ideaSlugOf(tab.rel) : null;
  if (idea) await renderIdeaSurface(idea, tab, stale);
  else if (editing) await mountEditor(tab, stale);
  else await renderView(tab, stale);
  if (stale()) return;
  paintEditFoot(tab, editing);
  updatePromotedBadge(tab);
  B.wsBody.scrollTop = 0;
  markSel();
}

// ADR-0005 (owner request): habilidade / pedir à IA / versionar as a right-
// side rail on the document viewer — the SAME pattern (visible buttons; the
// habilidade control is a dropdown + ▶ play button, never a menu) used on
// the meeting surface and the acervo header. Each action shows only when it
// actually applies to the open doc; the whole rail hides when none do.
// Redesign 1d/1e: o trilho virou a aba "Documento" do painel direito —
// "COM ESTE DOCUMENTO" (3 ações + todas), LINHA DO TEMPO e TIME. O elemento
// #bDocRail continua no DOM (âncora histórica), mas nunca é desenhado.
function renderDocRail(tab, isGuide) {
  const rail = $("bDocRail");
  if (rail) { rail.hidden = true; rail.innerHTML = ""; }
  const acts = $("pActions");
  if (!acts) return;
  showPanelDocSecs();
  const isMd = tab.rel.endsWith(".md") && tab.rel !== MANUAL_REL;
  const skillable = !isGuide && isMd;
  const aiable = !isGuide && isMd && tab.rel.startsWith("brainstorming/");
  const editing = tab.mode === "edit";
  const head = $("pActionsHead");
  if (head) head.textContent = editing ? t("ENQUANTO EDITA") : t("COM ESTE DOCUMENTO");

  // no modo editar o painel oferece o que serve à edição (handoff 1e)
  const anexos = anexosDirFor(tab.rel);
  if (editing) {
    acts.innerHTML =
      `<button class="pact" data-pact="ai">✦ ${t("Pedir mudança à IA")}</button>` +
      (anexos ? `<button class="pact" data-pact="attach">${t("Anexar arquivo")}</button>` : "");
  } else {
    const top = skillable ? allHabilidadeEntries("doc").slice(0, 3) : [];
    acts.innerHTML = top.map((e, i) =>
        `<button class="pact" data-skill="${i}" title="${esc(e.title || "")}">${esc(e.label)}</button>`).join("") +
      (aiable ? `<button class="pact" data-pact="ai">✦ ${t("Pedir mudança à IA")}</button>` : "");
    if (!acts.innerHTML) acts.innerHTML = `<p class="pnote">${t("este documento não tem habilidades")}</p>`;
    acts.querySelectorAll("[data-skill]").forEach((b) => (b.onclick = () =>
      runHabilidadeEntry(top[Number(b.dataset.skill)], tab.rel)));
  }
  acts.querySelectorAll("[data-pact]").forEach((b) => (b.onclick = () => {
    if (b.dataset.pact === "ai") promptNoteAI(tab.rel, true);
    else if (anexos) importAnexoFromComputer(anexos, () => refreshTabFromDisk(tab.rel));
  }));
  const all = $("pAllSkills");
  if (all) {
    // N15 · o rótulo contava ARQUIVOS e o menu lista ENTRADAS (loro-sync abre em
    // 4 fontes, a aposentada loro-digest sai): 12 no rótulo, 14 no menu. Uma
    // contagem só pode vir da lista que o controle abre.
    all.textContent = `${t("todas as habilidades de IA")} (${allHabilidadeEntries("doc").length}) ▸`;
    all.onclick = (e) => { e.stopPropagation(); openHabilidadeMenu(tab.rel, all, true, "doc"); };
  }
  renderPanelTimeline(tab);
  renderPanelTeam(tab, isGuide);
}

// Pasta de anexos do documento aberto — o destino de "Anexar arquivo" (1e).
// O backend só aceita um `attachments/` sob brainstorming/ ou contexts/
// (acervo::guarded_anexos_dir). Devolver "inbox" como último recurso fazia o
// botão existir sem destino e falhar com err.invalid_anexos_dest na cara do
// usuário; agora um documento sem anexos simplesmente não oferece o botão.
function anexosDirFor(rel) {
  // uma reunião tem os SEUS anexos, não os da ideia inteira
  const mtg = /^(brainstorming\/[^/]+\/meetings\/[^/]+)\//.exec(rel);
  if (mtg) return `${mtg[1]}/attachments`;
  const m = /^contexts\/([^/]+(?:\/[^/]+)*?)\//.exec(rel);
  if (m) return `contexts/${m[1]}/attachments`;
  const b = /^brainstorming\/([^/]+)\//.exec(rel);
  if (b) return `brainstorming/${b[1]}/attachments`;
  return null;
}

// LINHA DO TEMPO (1d): agora · última versão salva · histórico.
// N7 · a linha "última versão salva" era empurrada SEM CONDIÇÃO: aparecia num
// projeto sem nenhum commit (o selo ao lado dizia "sem versão salva", na mesma
// tela) e no manual, que não pode ter versão. A verdade é o histórico do
// documento — é ele que decide se essa linha existe. Decisão pura:
// `versions` = quantas versões o brain_timeline devolveu para este documento.
// O RÓTULO, O ESTADO E O MOTIVO do botão de versão do painel ✦ IA, em um lugar só.
// «tudo salvo ✓» é uma afirmação sobre o PROJETO, e o editor pode ter texto que
// ainda não foi ao arquivo: o botão dizia «tudo salvo ✓» a 200px do pé do editor
// dizendo «mudanças não salvas», sobre o mesmo documento (DESIGN.md §1). Ele
// continua desabilitado sem nada pendente — salvar versão não guardaria um texto
// que não está no arquivo, e um controle que não faz nada é pior que nenhum —, mas
// agora diz o passo que falta em vez de mentir sobre o estado.
// N5 · a contagem é do PROJETO todo (git status do acervo), numa seção que fala do
// documento aberto: o rótulo nomeia o que a ação faz de fato.
function versionBtnState(g, unsavedDocs) {
  if (!g.repo) return { label: t("começar a guardar versões"), disabled: false, title: "" };
  if (g.pending) {
    return { label: `${t("Salvar versão do projeto")} (${g.pending})`, disabled: false, title: "" };
  }
  const unsaved = (unsavedDocs || []).length;
  return {
    label: unsaved ? t("Salvar versão do projeto") : t("tudo salvo ✓"),
    disabled: true,
    title: unsaved ? t("salve o documento primeiro") : "",
  };
}

function timelineRows(o) {
  const rows = [];
  if (o.dirty) rows.push({ cls: "now", label: t("mudanças não salvas"), meta: t("agora") });
  if (o.kind !== "context") {
    rows.push({ cls: "draft", label: t("rascunho — não versionado"), meta: t("só na sua máquina") });
    return rows;
  }
  if (o.versions > 0) rows.push({ cls: "saved", label: t("última versão salva"), meta: o.when || t("no histórico do projeto") });
  else rows.push({ cls: "none", label: t("sem versão salva ainda"), meta: t("salvar versão guarda a primeira") });
  return rows;
}
function paintTimelineRows(rows) {
  const tl = $("pTimeline");
  if (!tl) return;
  tl.innerHTML = rows.map((r) =>
    `<div class="tl ${r.cls}"><span class="tldot"></span><span>${esc(r.label)}<span class="tlmeta">${esc(r.meta)}</span></span></div>`).join("");
}
function renderPanelTimeline(tab) {
  const tl = $("pTimeline");
  if (!tl) return;
  const dirty = !!tab.dirty || !!gitFiles[tab.rel];
  const hist = $("pHistory");
  // o histórico ainda não chegou: pinta o que já se sabe sem afirmar versão
  paintTimelineRows(timelineRows({ dirty, kind: tab.kind, versions: 0 }));
  if (hist) { hist.hidden = true; hist.onclick = () => showTimeline(tab.rel); }
  if (tab.kind !== "context") return;
  const rel = tab.rel;
  invoke("brain_timeline", { rel }).then((items) => {
    const cur = activeTab();
    if (!cur || cur.rel !== rel) return; // outro documento venceu a corrida
    const list = items || [];
    const last = list[0];
    const when = last && last.when
      ? new Date(last.when).toLocaleString(uiLocale(), { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
      : "";
    paintTimelineRows(timelineRows({ dirty: !!tab.dirty || !!gitFiles[rel], kind: tab.kind, versions: list.length, when }));
    // um "ver histórico completo" que só pode dizer "(sem versões ainda)" é um
    // controle que não faz nada
    if (hist) hist.hidden = list.length === 0;
  }).catch(() => {});
}

// TIME (1d): rascunho de trabalho + enviar para revisão. Só faz sentido no
// mundo versionado — no rascunho pessoal a seção some inteira.
function renderPanelTeam(tab, isGuide) {
  const versionable = !isGuide && tab.kind === "context";
  const sec = $("proposeBtn") && $("proposeBtn").closest(".psec");
  if (sec) sec.hidden = !versionable;
  renderPanelTeamNote();
}
// N6 · a nota prometia "abre um pedido de revisão no GitHub; quando o time aprova,
// vira oficial" mesmo sem versionamento configurado — com os dois botões
// escondidos, era uma promessa sem controle e sem caminho. Ou a promessa vale, ou
// a nota diz onde se liga (o mesmo padrão do card "abra a aba Terminal").
// N6 · a seção TIME é a única cópia que o usuário lê antes de pagar o preço, e
// ela prometia a revisão sem nenhum controle na tela. Três estados, um por
// verdade: sem git no sistema (nem histórico local existe), git sem GitHub
// conectado (o local funciona, o time não), e conectado.
function renderPanelTeamNote() {
  const note = $("pTeamNote"), fix = $("pTeamFix");
  if (!note) return;
  const on = !!(envDoctor && envDoctor.versioningEnabled);
  if (!gitAvailable) {
    note.textContent = t("sem o git instalado, este computador não guarda histórico de versões.");
    if (fix) { fix.hidden = false; fix.textContent = t("ver o que falta em Configurações"); }
    return;
  }
  // N6 · o app sabia que a REDE tinha falhado e acusava a configuração: com git,
  // gh, login e repositório todos certos, cinco minutos offline pintavam "falta
  // conectar o GitHub" e escondiam o botão de revisão. Sem rede é um terceiro
  // estado, e o remédio dele é tentar de novo — não ir a Configurações.
  if (!on && envDoctor && envDoctor.offline) {
    note.textContent = t("sem conexão agora — salvar versão funciona local; a revisão do time volta quando a rede voltar.");
    if (fix) { fix.hidden = false; fix.textContent = t("verificar de novo"); }
    return;
  }
  note.textContent = on
    ? t("a versão guarda o projeto inteiro num rascunho separado e abre um pedido de revisão no GitHub; quando o time aprova, vira oficial.")
    : t("salvar versão funciona local; para enviar ao time falta conectar o GitHub.");
  if (fix) {
    fix.hidden = on;
    fix.textContent = t("conectar o GitHub em Configurações");
  }
}
{
  const f = $("pTeamFix");
  // o mesmo link carrega dois remédios porque a nota carrega dois estados: sem
  // rede, o passo é refazer a checagem; sem configuração, é ir a Configurações
  if (f) f.addEventListener("click", async () => {
    if (envDoctor && envDoctor.offline && !envDoctor.versioningEnabled) return void refreshEnv(true);
    await openCfgGit();
  });
}

// ADR-0009: a persistent "promovido → <contexto>" badge, read from the source
// file's front-matter (stamped non-destructively by brain_promote).
function updatePromotedBadge(tab) {
  const badge = $("bPromoted");
  if (!badge) return;
  let raw = null;
  const h = cmById.get(tab.id);
  if (h) { try { raw = h.getValue(); } catch (_) {} }
  if (raw == null) raw = savedById.get(tab.id);
  let promo = null;
  if (raw != null) {
    try {
      const split = R.splitFrontMatter(raw);
      if (split.frontMatter != null) promo = R.parseFrontMatter(split.frontMatter).promovido;
    } catch (_) { promo = null; }
  }
  const para = promo && (promo.para || (typeof promo === "string" ? promo : ""));
  if (para) { badge.hidden = false; badge.textContent = t("juntado ao conhecimento") + " → " + para; }
  else badge.hidden = true;
}

// per-active-tab view/edit toggle (Cmd/Ctrl-E)
async function setActiveMode(mode) {
  const t = activeTab();
  if (!t || t.rel === HOME_REL) return;
  ws = LoroWorkspace.setMode(ws, t.id, mode);
  renderTabs();
  await renderActive();
}
function toggleActiveMode() {
  const t = activeTab();
  if (!t || t.rel === HOME_REL) return;
  setActiveMode(t.mode === "edit" ? "view" : "edit");
}
B.viewBtn.addEventListener("click", () => setActiveMode("view"));
B.editBtn2.addEventListener("click", () => setActiveMode("edit"));

// abre as "instruções do loop" (inbox/_prompt.md) como uma aba em modo edição
async function openGuideDoc() {
  ws = LoroWorkspace.openTab(ws, GUIDE_REL, { preview: false }).ws;
  ws = LoroWorkspace.setMode(ws, LoroWorkspace.activeTab(ws).id, "edit");
  renderTabs();
  await renderActive();
}

// ---- busca no documento (Ctrl/⌘+F) ----
let findMarks = [], findIdx = -1;
function clearMarks() {
  findMarks.forEach((m) => { const t = document.createTextNode(m.textContent); m.replaceWith(t); });
  findMarks = []; findIdx = -1;
  B.doc.normalize();
}
function runFind(q) {
  clearMarks();
  if (!q) { B.findCount.textContent = "0/0"; return; }
  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const walker = document.createTreeWalker(B.doc, NodeFilter.SHOW_TEXT, null);
  const targets = [];
  let node;
  while ((node = walker.nextNode())) if (rx.test(node.nodeValue)) targets.push(node);
  for (const t of targets) {
    const frag = document.createDocumentFragment();
    let last = 0; const s = t.nodeValue; rx.lastIndex = 0; let m;
    while ((m = rx.exec(s))) {
      if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
      const mark = document.createElement("mark"); mark.className = "hl"; mark.textContent = m[0];
      frag.appendChild(mark); findMarks.push(mark); last = m.index + m[0].length;
      if (m.index === rx.lastIndex) rx.lastIndex++;
    }
    if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
    t.replaceWith(frag);
  }
  if (findMarks.length) gotoMark(0); else B.findCount.textContent = "0/0";
}
function gotoMark(i) {
  if (!findMarks.length) return;
  findIdx = (i + findMarks.length) % findMarks.length;
  findMarks.forEach((m, k) => m.classList.toggle("cur", k === findIdx));
  findMarks[findIdx].scrollIntoView({ block: "center" });
  B.findCount.textContent = `${findIdx + 1}/${findMarks.length}`;
}
function openFind() {
  if (B.docWrap.hidden) return;   // só quando um documento está aberto
  const t = activeTab();
  if (t && t.mode === "edit") return; // no modo editar, o CM6 é dono da busca (⌘/Ctrl+F)
  B.find.hidden = false; B.findInput.focus(); B.findInput.select();
  if (B.findInput.value) runFind(B.findInput.value);
}
function closeFind() { B.find.hidden = true; clearMarks(); B.findCount.textContent = "0/0"; }
B.findInput.addEventListener("input", () => runFind(B.findInput.value));
B.findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); gotoMark(findIdx + (e.shiftKey ? -1 : 1)); }
  else if (e.key === "Escape") closeFind();
});
B.findNext.addEventListener("click", () => gotoMark(findIdx + 1));
B.findPrev.addEventListener("click", () => gotoMark(findIdx - 1));
B.findClose.addEventListener("click", () => { closeFind(); });
// ADR-0009: reference dispatch. A clicked link is either a front-matter ref
// (`ref:<id>` — inline, or a panel row's data-ref) or a bare relative/anchored
// local path. Both resolve through brain_resolve_ref (canonicalize + starts_with
// guard live in Rust) and dispatch by tipo: doc opens a tab; image renders inline
// as a CSP-safe data: URI; audio/other open in the OS default app.
function wireDocLinks() {
  const tab = activeTab();
  const rel = currentRel();
  if (!rel || !tab) return;
  const fm = fmById.get(tab.id) || null;
  B.doc.querySelectorAll("a[data-path]").forEach((a) =>
    (a.onclick = (e) => { e.preventDefault(); onRefClick(rel, fm, a.dataset.path, a); }));
  B.doc.querySelectorAll("a[data-ref]").forEach((a) =>
    (a.onclick = (e) => { e.preventDefault(); onRefClick(rel, fm, "ref:" + a.dataset.ref, a); }));
}
// ADR-0026 §15 — rola até o ponto que a citação nomeia. O id é o que o renderer
// escreveu no bloco (o apelido do hotspot, ou o `H-n` de um acervo antigo): se
// não existir, a função não faz nada — um documento aberto no topo é melhor que
// um salto para o lugar errado.
function revealAnchor(id) {
  if (!id) return false;
  const alvo = document.getElementById(id);
  if (!alvo) return false;
  alvo.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
  // a marca some sozinha: é para achar o ponto, não para ficar pintando o texto
  alvo.classList.add("justfound");
  setTimeout(() => alvo.classList.remove("justfound"), 1600);
  return true;
}

// ADR-0026 §19 — grifa o trecho que o verbete nomeia, por 10s. O índice sabe QUAL
// palavra você procurava; abrir o documento no topo devolvia essa busca para o
// olho. Anda pelos NÓS DE TEXTO e envolve só o trecho: reescrever o innerHTML do
// documento apagaria anotação (ADR-0007), link e estado de rolagem.
function highlightTerm(termo) {
  const alvo = String(termo || "").trim();
  const raiz = B.doc;
  if (!alvo || !raiz) return false;
  const dobra = (x) => x.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const busca = dobra(alvo);
  const andarilho = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT);
  for (let no = andarilho.nextNode(); no; no = andarilho.nextNode()) {
    if (no.parentElement && no.parentElement.closest("mark.termfound")) continue;
    const i = dobra(no.nodeValue || "").indexOf(busca);
    if (i < 0) continue;
    const faixa = document.createRange();
    faixa.setStart(no, i);
    faixa.setEnd(no, i + alvo.length);
    const marca = document.createElement("mark");
    marca.className = "termfound";
    try { faixa.surroundContents(marca); } catch (_) { return false; }
    marca.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    // dez segundos e some: é para achar o trecho, não para marcar o documento
    setTimeout(() => {
      const pai = marca.parentNode;
      if (!pai) return;
      while (marca.firstChild) pai.insertBefore(marca.firstChild, marca);
      pai.removeChild(marca);
      pai.normalize();
    }, 10000);
    return true;
  }
  return false;
}

function reducedMotion() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

async function onRefClick(sourceRel, fm, token, anchorEl) {
  let caminho = token;
  const m = /^ref:(.+)$/.exec(token || "");
  if (m) {
    const found = R.findRef ? R.findRef(fm, m[1].trim()) : null;
    if (!found || !found.caminho) { toast(t("referência não encontrada")); return; }
    caminho = found.caminho;
  }
  let res;
  try { res = await invoke("brain_resolve_ref", { sourceRel, ref: caminho }); }
  catch (e) { toast(t("não resolvi a referência")); clog("resolve_ref error: " + e); return; }
  if (!res || !res.exists) { toast(t("arquivo não encontrado") + (res && res.rel ? ": " + res.rel : "")); return; }
  // ADR-0026 §12 — seguir uma referência é navegar com intenção: a aba é PRÓPRIA.
  // Com preview, o segundo salto comia o primeiro e você perdia de onde veio.
  if (res.tipo === "doc") {
    const hash = String(caminho).split("#")[1] || "";
    const termo = anchorEl && anchorEl.dataset ? anchorEl.dataset.term : "";
    await openDoc(res.rel, { preview: false });
    // depois da pintura: o alvo só existe quando o documento já está na tela
    requestAnimationFrame(() => {
      if (termo && highlightTerm(termo)) return;
      if (hash) revealAnchor(hash);
    });
    return;
  }
  if (res.tipo === "image") {
    try {
      const asset = await invoke("brain_read_asset", { rel: res.rel });
      toggleInlineImage(anchorEl, asset.mime, asset.base64, res.rel);
    } catch (e) { toast(t("não abri a imagem")); clog("read_asset error: " + e); }
    return;
  }
  // external ref (loro-sync, e.g. a Drive doc) → OS default browser
  if (res.tipo === "link") {
    try { await invoke("brain_open_link", { url: res.rel }); }
    catch (e) { toast(t("não abri o link")); clog("open_link error: " + e); }
    return;
  }
  // audio / other → OS default app (guarded to the acervo root in Rust)
  try { await invoke("brain_open_external", { rel: res.rel }); }
  catch (e) { toast(t("não abri o arquivo")); clog("open_external error: " + e); }
}
// CSP-safe inline image: a base64 data: URI (img-src 'self' data:). Toggles off
// on a second click so a reference does not permanently occupy the reader.
function toggleInlineImage(anchorEl, mime, base64, rel) {
  const next = anchorEl.nextElementSibling;
  if (next && next.classList && next.classList.contains("refimg")) { next.remove(); return; }
  const fig = document.createElement("span");
  fig.className = "refimg";
  const img = document.createElement("img");
  img.src = `data:${mime};base64,${base64}`;
  img.alt = String(rel).split("/").pop();
  fig.appendChild(img);
  anchorEl.insertAdjacentElement("afterend", fig);
}

// Open (or focus) a document as a workspace tab. Single-click = ephemeral
// preview (default); pass {preview:false} for double-click / palette / permanent.
// ADR-0026 §14 — o documento de um tema pode se chamar `index.md` (gerado hoje)
// ou `indice.md` (acervo escrito antes). Quem sabe qual existe é o disco, não o
// frontend: montar o caminho na mão abria uma aba de arquivo inexistente.
// ADR-0026 §14 — o arquivo vivo da reunião se chama `meeting.md`. Estava escrito
// à mão em quatro lugares com o nome ANTIGO, então toda reunião gravada por esta
// versão abria "arquivo não encontrado". Um nome, um lugar.
const LIVING_FILE = "meeting.md";
const livingRel = (dir) => `${dir}/${LIVING_FILE}`;

// ADR-0026 §20 · o portão da estrutura antiga. Diz o que está acontecendo, o que
// a migração FAZ e o que ela não faz — o medo aqui é perder arquivo, e a resposta
// tem de vir antes do botão (DESIGN.md §1: o preço está na cópia).
function legacyGateHtml() {
  return `<div class="wizhead">
      <img src="parrot.png" width="34" height="34" alt="" class="wizard-icon" />
      <div>
        <h1>${t("Este projeto usa a estrutura antiga")}</h1>
        <p class="lead">${t("as pastas mudaram de nome e o Loro precisa atualizar este projeto antes de abrir. sem isso, parte do conhecimento não aparece.")}</p>
      </div>
    </div>
    <div class="wizcard">
      <p class="hint">${t("a atualização renomeia as pastas e os arquivos que o Loro criou. nada é apagado, nada é reescrito, e o que você escreveu continua exatamente igual.")}</p>
      <p class="hint">${t("você vê a lista completa do que vai mudar antes de confirmar.")}</p>
      <button class="btn solid" data-migrate>${t("atualizar a estrutura")}</button>
    </div>`;
}

async function openTopicDoc(rel, opts) {
  try { await openDoc(await invoke("brain_topic_doc", { rel }), opts); }
  catch (e) { toast(tErr(String(e))); }
}

async function openDoc(relPath, opts) {
  const r = LoroWorkspace.openTab(ws, relPath, opts || { preview: true });
  ws = r.ws;
  // preview slot reused in place: the old document's live editor state must
  // die with it, or it keeps answering for the new rel (ADR-0002 §3)
  if (r.evictedId) disposeTabState(r.evictedId);
  renderTabs();
  await renderActive();
}

// ============================ paleta de comandos (⌘P / ⌘⇧P) ============================
// pt-BR command registry (ADR-0008). `run` wires to existing handlers/buttons.
// Every command carries a shortcut (owner decision 2026-07-28): `code` is a
// KeyboardEvent.code matched on ⌘/Ctrl+⌥ (Alt+letter types symbols on macOS, so
// e.key is useless here); `combo` overrides the display for pre-existing
// mod-only shortcuts that are handled elsewhere in the keydown block.
const IS_MAC = /mac/i.test(navigator.platform || "");
const comboLabel = (c) =>
  c.combo || (c.code ? (IS_MAC ? "⌘⌥" : "Ctrl+Alt+") + c.code.replace(/^(Key|Digit)/, "") : "");
// Os gates dos comandos de documento: a mesma verdade que os manipuladores
// consultam antes de desistir em silêncio (N9).
const hasDoc = () => !!currentRel();
const hasClosedTab = () => !!(ws && ws.closed && ws.closed.length);
// N8 · a screen hides a control by hiding the SECTION it lives in (the TIME
// `.psec`, `#pDocSecs` with no document): the button's own `hidden` stays false,
// so a gate that read only the button kept offering it in ⌘K — and the global
// shortcut kept firing it — for a control the screen had removed. On screen
// means neither the control nor any ancestor is hidden.
function controlOnScreen(el) {
  for (let n = el; n; n = n.parentElement) if (n.hidden) return false;
  return !!el;
}
// 1k — a paleta é a documentação viva dos atalhos: cada comando mostra o seu.
// `group` é o cabeçalho sob o qual a linha aparece (ir para · gravar · criar ·
// documento · fazer), na ordem em que os grupos são declarados aqui.
const CMD_GROUPS = ["ir para", "gravar", "criar", "documento", "fazer"];
const COMMANDS = [
  { group: "ir para", label: "Início", code: "KeyH", run: () => { openHome(); goDest("home"); } },
  { group: "ir para", label: "Organizar", run: () => { openHome(); goDest("organize"); } },
  { group: "ir para", label: "Conhecimento", run: () => { openHome(); goDest("knowledge"); } },
  // ADR-0027 · sem `when`: a metade local (o que você mudou) não depende do
  // GitHub, então o destino existe sempre — o que degrada é a aba do time, e ela
  // degrada DIZENDO.
  { group: "ir para", label: "Revisão", run: () => { openHome(); goDest("review", "now"); } },
  { group: "ir para", label: "Índice remissivo", run: () => openDoc(INDEX_REL, { preview: false }) },
  { group: "ir para", label: "Como funciona o Loro", run: () => openManual() },
  { group: "ir para", label: "Configurações", run: () => openCfg() },
  { group: "ir para", label: "apresentação do Loro", code: "KeyA", run: () => showWelcome() },
  { group: "ir para", label: "Trocar de projeto · mover projeto de pasta", code: "KeyG", run: () => runMigration() },

  { group: "gravar", label: "Gravar", code: "KeyR", run: () => startMeetingFlow() },
  { group: "gravar", label: "Encerrar gravação", combo: IS_MAC ? "⇧⌘R" : "Ctrl+Shift+R", run: () => { if (state.running || meeting.active) stopSession(); else toast(t("nenhuma gravação em andamento")); } },
  { group: "gravar", label: "Marcar momento", code: "KeyM", run: () => markMeeting() },

  { group: "criar", label: "Nova ideia", code: "KeyB", run: () => promptNewTema() },
  { group: "criar", label: "Novo caderno de notas", code: "KeyK", run: () => promptNewNotebook() },
  { group: "criar", label: "Novo tema", code: "KeyC", run: () => promptNewContext() },

  // N9 · estas quatro linhas eram oferecidas em Início, sem documento nenhum
  // aberto: os manipuladores davam `return` no primeiro if e a paleta fechava
  // sem dizer nada — quatro controles que não fazem nada na tela de entrada
  // (DESIGN.md §1). `hasDoc` é a MESMA verdade que os manipuladores consultam.
  { group: "documento", label: "Alternar visualizar/editar", combo: IS_MAC ? "⌘E" : "Ctrl+E", when: hasDoc, run: () => toggleActiveMode() },
  // ⌘S grava o ARQUIVO (saveActive); "Salvar versão" é o commit. Anunciar o mesmo
  // atalho nos dois ensinava um mapeamento que o app não implementa — e a paleta
  // é a documentação viva dos atalhos.
  { group: "documento", label: "Salvar", combo: IS_MAC ? "⌘S" : "Ctrl+S", when: hasDoc, run: () => saveActive() },
  // N6 · a paleta é uma lista estática: oferecia "Enviar para revisão do time"
  // (e o atalho global) com o botão escondido e o ambiente não conectado — a
  // recusa só vinha DEPOIS de escrever a proposta inteira. `when` é o mesmo gate
  // da tela, então a paleta nunca oferece um controle que não existe.
  { group: "documento", label: "Salvar versão do projeto", when: () => controlOnScreen(B.gitBtn) && !B.gitBtn.disabled, run: () => B.gitBtn.click() },
  { group: "documento", label: "Enviar para revisão do time", code: "KeyP", when: () => controlOnScreen(B.proposeBtn), run: () => B.proposeBtn.click() },
  { group: "documento", label: "Buscar no documento", combo: IS_MAC ? "⌘F" : "Ctrl+F", when: hasDoc, run: () => openFind() },
  // N10 · sem esta linha, grifar/comentar só existiam para o arrasto do mouse
  { group: "documento", label: "Grifar um trecho…", run: () => promptAnnotateExcerpt() },
  { group: "documento", label: "Fechar aba", combo: IS_MAC ? "⌘W" : "Ctrl+W", when: hasDoc, run: () => closeActiveTab() },
  { group: "documento", label: "Reabrir aba", combo: IS_MAC ? "⇧⌘T" : "Ctrl+Shift+T", when: hasClosedTab, run: () => reopenClosedTab() },

  { group: "fazer", label: "Executar habilidade…", run: () => openHabilidadeMenu(currentRel(), $("aiPanelBtn"), true, "doc") },
  // N5 · a outra metade do fluxo (o que o time mandou revisar) só tinha porta
  // num toast que expira e numa faixa que se dispensa: aqui ela é permanente.
  { group: "fazer", label: "Ver revisões do time", when: () => !!(envDoctor && envDoctor.versioningEnabled), run: () => { openHome(); goDest("review", "team"); } },
  { group: "fazer", label: "Perguntar ao projeto", code: "KeyQ", run: () => askAcervo() },
  { group: "fazer", label: "Transformar em conhecimento", run: () => genContextNow() },
  { group: "fazer", label: "Ajustar instruções da IA", code: "KeyI", run: () => openGuideDoc() },
];
// Os comandos com gate (`when`) só entram na paleta quando o controle
// correspondente existe na tela — e o atalho global lê a MESMA lista, para não
// haver uma tecla que faz o que a paleta não oferece.
function availableCommands() {
  return COMMANDS.filter((c) => typeof c.when !== "function" || c.when());
}
let cmdkMode = "file";     // "file" | "command"
let cmdkIndex = 0;         // highlighted row
let cmdkRows = [];         // current result rows (file hits or commands)
let paletteIndex = [];     // cached brain_list_all result

function paletteOpen() { return !B.cmdk.hidden; }
function openPalette(mode) {
  cmdkMode = mode;
  B.cmdk.hidden = false;
  B.cmdkInput.value = mode === "command" ? ">" : "";
  if (mode === "file") {
    // refresh the quick-open index each open (cheap; keeps it current)
    invoke("brain_list_all").then((idx) => { paletteIndex = idx || []; renderPalette(); })
      .catch((e) => { paletteIndex = []; renderPalette(); clog("brain_list_all error: " + e); });
  }
  renderPalette();
  enterOverlay(B.cmdk, B.cmdkInput, closePalette);
  B.cmdkInput.select();
}
function closePalette() {
  B.cmdk.hidden = true; cmdkRows = []; cmdkIndex = 0;
  B.cmdkInput.removeAttribute("aria-activedescendant");
  leaveOverlay(B.cmdk);
}

// most-recently-used doc rels from ws.mru (empty query in file mode)
function mruRecents() {
  const seen = new Set();
  const out = [];
  for (const id of ws.mru) {
    const tab = ws.tabs.find((t) => t.id === id);
    if (!tab || tab.rel === HOME_REL || seen.has(tab.rel)) continue;
    seen.add(tab.rel);
    out.push({ rel: tab.rel, title: tab.title, kind: tab.kind });
  }
  return out;
}
function renderPalette() {
  const raw = B.cmdkInput.value;
  const isCmd = cmdkMode === "command" || raw.startsWith(">");
  const query = isCmd ? raw.replace(/^>\s*/, "") : raw;
  // ⌘K é uma paleta só (1k): arquivos E comandos na mesma lista, agrupados.
  // O prefixo "›" continua funcionando para quem quer só comandos.
  const cmdRows = LoroFuzzy.filter(query, availableCommands(), (c) => t(c.label))
    .map((c) => ({ kind: "cmd", group: c.group, label: t(c.label), run: c.run, combo: comboLabel(c) }));
  let fileRows = [];
  if (!isCmd) {
    const src = query ? paletteIndex : mruRecents();
    fileRows = LoroFuzzy.filter(query, src, (it) => it.rel)
      .map((it) => ({ kind: "file", group: "abrir", rel: it.rel, label: it.title || it.rel, sub: it.rel, world: it.kind }));
  }
  // as linhas são reordenadas por grupo ANTES de indexar, para que ↑/↓ sigam
  // exatamente a ordem que se lê na tela
  const order = isCmd ? CMD_GROUPS : ["abrir", ...CMD_GROUPS];
  const pool = isCmd ? cmdRows : [...fileRows.slice(0, 8), ...cmdRows];
  cmdkRows = order.flatMap((g) => pool.filter((r) => r.group === g));
  cmdkIndex = 0;
  let lastGroup = null;
  B.cmdkList.innerHTML = cmdkRows.length
    ? cmdkRows.map((r, i) => {
        // o título de grupo não é uma opção: role=presentation o mantém fora da
        // contagem que o leitor de tela anuncia
        const head = r.group !== lastGroup ? `<li class="cmdk-group" role="presentation">${esc(t(r.group))}</li>` : "";
        lastGroup = r.group;
        const sub = r.sub ? `<span class="cmdk-sub mono">${esc(r.sub)}</span>` : "";
        const kbd = r.combo ? `<span class="cmdk-k mono">${esc(r.combo)}</span>` : "";
        return `${head}<li class="cmdk-item${i === 0 ? " on" : ""}" id="cmdk-opt-${i}" role="option"` +
          ` aria-selected="${i === 0}" data-i="${i}"><span class="cmdk-l">${esc(r.label)}</span>${sub}${kbd}</li>`;
      }).join("")
    : `<li class="cmdk-empty mono" role="presentation">${t("nada encontrado")}</li>`;
  B.cmdkList.querySelectorAll("[data-i]").forEach((li) => {
    li.onmousemove = () => setCmdkIndex(Number(li.dataset.i));
    li.onclick = () => { setCmdkIndex(Number(li.dataset.i)); runPalette(); };
  });
  setCmdkIndex(0);
  // F8 · quantos resultados apareceram é um status: era desenhado e nunca dito,
  // e "nada encontrado" também não (WCAG 4.1.3).
  announce(cmdkRows.length
    ? `${cmdkRows.length} ${cmdkRows.length > 1 ? t("resultados") : t("resultado")}`
    : t("nada encontrado"));
}
function setCmdkIndex(i) {
  cmdkIndex = i;
  B.cmdkList.querySelectorAll(".cmdk-item").forEach((li, k) => {
    const on = k === i;
    li.classList.toggle("on", on);
    // o realce era SÓ visual: o foco fica no campo, então quem lê a tela nunca
    // soube em que opção estava (aria-activedescendant é o que diz)
    li.setAttribute("aria-selected", String(on));
  });
  const cur = B.cmdkList.querySelector(".cmdk-item.on");
  if (cur) {
    B.cmdkInput.setAttribute("aria-activedescendant", cur.id);
    // N9 · a lista rola por dentro (46vh ≈ 11 linhas de 26): a linha escolhida
    // ficava fora da vista e o Enter rodava um comando que não estava na tela.
    if (cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
  } else B.cmdkInput.removeAttribute("aria-activedescendant");
}
function runPalette() {
  const row = cmdkRows[cmdkIndex];
  if (!row) return;
  closePalette();
  if (row.kind === "file") openDoc(row.rel, { preview: true });
  else row.run();
}
B.cmdkInput.addEventListener("input", renderPalette);
B.cmdkInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); setCmdkIndex(Math.min(cmdkIndex + 1, cmdkRows.length - 1)); }
  else if (e.key === "ArrowUp") { e.preventDefault(); setCmdkIndex(Math.max(cmdkIndex - 1, 0)); }
  else if (e.key === "Enter") { e.preventDefault(); runPalette(); }
  else if (e.key === "Escape") { e.preventDefault(); closePalette(); }
});
B.cmdk.addEventListener("click", (e) => { if (e.target === B.cmdk) closePalette(); });

// ---- one central capture-phase keyboard handler (ADR-0008) ----
function termHasFocus() {
  const p = $("termPanel");
  return p && !p.hidden && p.contains(document.activeElement);
}
window.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  // keys we fully own are also stopped in the capture phase so they never reach
  // CM6 / other listeners and double-fire.
  const own = () => { e.preventDefault(); e.stopPropagation(); };
  // 1k: ⌘K é A paleta (arquivos + comandos). ⌘P/⌘⇧P continuam como atalhos
  // herdados para quem já os tinha na mão.
  if (mod && !e.shiftKey && (key === "k" || key === "p")) { own(); openPalette("file"); return; }
  if (mod && e.shiftKey && key === "p") { own(); openPalette("command"); return; }
  // ⇧⌘R encerra a gravação (⌘R grava — via COMMANDS/⌘⌥R)
  if (mod && e.shiftKey && key === "r") {
    own();
    if (state.running || meeting.active) stopSession(); else toast(t("nenhuma gravação em andamento"));
    return;
  }
  if (key === "escape") {
    if (paletteOpen()) { own(); closePalette(); return; }
    if (!B.find.hidden) { own(); closeFind(); return; }
  }
  if (paletteOpen()) return;   // the palette input owns the rest of its keys
  // every palette command answers to mod+alt+<code> — app-level chords, so they
  // win even over the terminal (the shell has no claim on ⌘⌥ combos)
  if (mod && e.altKey && !e.repeat) {
    const cmd = availableCommands().find((c) => c.code === e.code);
    if (cmd) { own(); cmd.run(); return; }
  }
  if (termHasFocus()) return;  // route everything else to the shell
  if (e.ctrlKey && key === "tab") { own(); cycleTab(e.shiftKey); return; }
  // ⌘/Ctrl+W MUST preventDefault or the WebView closes the window (ADR-0008)
  if (mod && key === "w") { own(); closeActiveTab(); return; }
  if (mod && key === "s") { own(); saveActive(); return; }
  if (mod && key === "e") { own(); toggleActiveMode(); return; }
  if (mod && key === "f" && !B.docWrap.hidden) {
    const t = activeTab();
    if (t && t.mode === "edit") return; // CM6 owns find in edit mode (don't stop it)
    own(); openFind(); return;
  }
}, true);

// ---- seletor de acervo (projetos) ----
function renderSwitch() {
  const cur = acervos.find((a) => a.id === activeAcervo);
  B.acervoName.textContent = cur ? cur.name : t("projeto");
  // com o wizard à vista o accent é o preview da cor escolhida nele — sem o
  // desvio, este poll (10s) revertia o preview para a cor do acervo ativo
  applyAccent(!B.setup.hidden ? wizColor : (cur ? cur.color : ""));
}
B.acervoBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!B.acervoMenu.hidden) return closeFloat();
  B.acervoMenu.innerHTML =
    acervos.map((a) => `<div class="fitem2${a.id === activeAcervo ? " on" : ""}" data-acervo="${esc(a.id)}">
        <span class="fn">${esc(a.name)}</span>${a.autoContext ? '<span class="pill">auto</span>' : ""}
        <button class="rowmenu" data-rmacervo="${esc(a.id)}" title="${t("remover projeto do Loro (a pasta é preservada)")}" aria-label="${t("remover projeto do Loro (a pasta é preservada)")}: ${esc(a.name)}">×</button></div>`).join("") +
    `<div class="fsep"></div><div class="fitem2 add" data-newacervo="1">＋ ${t("novo projeto")}</div>`;
  B.acervoMenu.querySelectorAll("[data-acervo]").forEach((el2) => (el2.onclick = async (e) => {
    if (e.target.closest("[data-rmacervo]")) return;
    closeFloat();
    if (el2.dataset.acervo === activeAcervo) return;
    try { await invoke("brain_set_active", { id: el2.dataset.acervo }); setupWorkspace(); sideSig = ""; brainRefresh(); }
    catch (err) { toast(tErr(String(err))); }
  }));
  B.acervoMenu.querySelectorAll("[data-rmacervo]").forEach((el2) => (el2.onclick = (e) => {
    e.stopPropagation(); openConfirmRemoveAcervo(el2, el2.dataset.rmacervo);
  }));
  B.acervoMenu.querySelector("[data-newacervo]").onclick = () => { closeFloat(); openNewAcervo(); };
  B.acervoMenu.hidden = false;
  wireFloatMenu(B.acervoMenu, B.acervoBtn);
});

// remover projeto: tira o acervo do Loro (a pasta no disco é preservada)
function openConfirmRemoveAcervo(anchor, id) {
  const a = acervos.find((x) => x.id === id);
  const name = a ? a.name : id;
  B.acervoMenu.hidden = true;
  B.bMenu.innerHTML =
    `<div class="fhead">${t("remover projeto")}</div>
     <div class="fitem2 muted fstatic">“${esc(name)}” ${t("sai do Loro — a pasta em")} ${esc(a ? a.dir : "")} ${t("é preservada no disco")}</div>
     <div class="confirm-actions">
       <button class="btn-danger" data-yes>${t("remover")}</button>
       <button class="link mono muted" data-no>${t("cancelar")}</button>
     </div>`;
  B.bMenu.querySelector("[data-yes]").onclick = async () => {
    closeFloat();
    try {
      const av = await invoke("brain_remove_acervo", { id });
      acervos = av.acervos || []; activeAcervo = av.active || "";
      toast(t("projeto removido (pasta preservada)"));
      setupWorkspace(); sideSig = ""; brainRefresh();
    } catch (e) { toast(tErr(String(e))); }
  };
  B.bMenu.querySelector("[data-no]").onclick = closeFloat;
  const r = anchor.getBoundingClientRect();
  B.bMenu.style.left = Math.min(r.left, window.innerWidth - 260) + "px";
  B.bMenu.style.top = r.bottom + 4 + "px";
  B.bMenu.hidden = false;
  wireFloatMenu(B.bMenu, anchor);
}

// Preparo único dos campos do wizard, usado pelos DOIS caminhos de entrada:
// openNewAcervo (menu "novo projeto") e o primeiro uso via brainRefresh. Só o
// primeiro caminho preparava — numa instalação nova o seletor "como o time
// trabalha" e a paleta de cores ficavam vazios.
let wizInited = false, wizDefaultDir = "", wizDirDirty = false;
function resetWizardFields() {
  wizInited = true;
  B.nameInput.value = ""; B.ctxInput.value = ""; wizDirDirty = false;
  // a pasta padrão REAL aparece antes de qualquer escolha, DENTRO do campo — é a
  // mesma para a qual o brain_setup cai quando o campo fica vazio, e agora ela
  // pode ser editada em vez de só substituída pelo diálogo do sistema
  // …e, num projeto NOVO, uma pasta que ainda não é de ninguém: oferecer a pasta
  // já tomada abria o formulário numa recusa em vermelho (N19)
  setWizDir(freeAcervoDir(wizDefaultDir, acervos, creatingNew));
  invoke("default_acervo_dir").then((d) => {
    wizDefaultDir = d || "";
    // só repõe o padrão se o usuário ainda não escreveu nada: a resposta é
    // assíncrona e chegava depois de a pessoa começar a digitar
    if (!wizDirDirty && wizDefaultDir) setWizDir(freeAcervoDir(wizDefaultDir, acervos, creatingNew));
  }).catch(() => {});
  B.gitInput.checked = true;
  B.agentInput.value = "claude";
  // language starts at the current UI language; changing it in the wizard
  // (ADR-0005 §6) switches the UI live and becomes the acervo's gen language
  if (B.wizLang) B.wizLang.value = settings.uiLang;
  // default to automático (the previous checkbox defaulted on) — ADR-0005
  wizColor = ""; wizTemplate = AUTO_TEMPLATE_ID; wizCtxDirty = false;
  B.setupErr.hidden = true;
  // o detalhe do ⓘ de "onde guardar" volta recolhido a cada abertura
  const dirInfo = $("wizDirInfo"), dirBody = $("wizDirInfoBody");
  if (dirBody) dirBody.hidden = true;
  if (dirInfo) dirInfo.setAttribute("aria-expanded", "false");
  // o accent pré-visualiza a cor selecionada NO wizard (teal padrão) — sem
  // isto o botão "Criar projeto" ficava com a cor do acervo ativo
  applyAccent(wizColor);
  drawWizColors();
  loadWizTemplates();
}
// ⓘ de "onde guardar" (exceção deliberada à ADR-0020): clique abre/fecha o
// detalhe do que mora na pasta — nunca hover
{
  const i = $("wizDirInfo"), body = $("wizDirInfoBody");
  if (i && body) i.addEventListener("click", () => {
    body.hidden = !body.hidden;
    i.setAttribute("aria-expanded", String(!body.hidden));
  });
}
function openNewAcervo() {
  creatingNew = true;
  B.wizTitle.textContent = t("Novo projeto");
  resetWizardFields();
  B.cancelBtn.hidden = false;
  B.setup.hidden = false; B.shell.hidden = true;
  B.nameInput.focus();
}
function drawWizColors() {
  renderSwatches($("wizColors"), wizColor, (id) => { wizColor = id; drawWizColors(); applyAccent(id); });
}

// ---- usage template picker (ADR-0003): builtins + ~/.loro/templates --------
async function loadWizTemplates() {
  try { wizTemplates = await invoke("brain_list_templates", {}); }
  catch (e) { wizTemplates = []; clog("brain_list_templates error: " + e); }
  drawWizTemplates();
}
function drawWizTemplates() {
  const box = B.wizTemplates;
  box.innerHTML = "";
  // synthetic "automático" first — its own mode, not a backend preset
  const auto = document.createElement("option");
  auto.value = AUTO_TEMPLATE_ID;
  auto.textContent = t("automático");
  box.appendChild(auto);
  for (const tpl of wizTemplates) {
    const o = document.createElement("option");
    o.value = tpl.id;
    o.textContent = tpl.name + (tpl.builtin ? "" : " ✎");
    o.title = tpl.description;
    box.appendChild(o);
  }
  box.value = wizTemplate;
  box.onchange = () => {
    wizTemplate = box.value;
    // automático → contexts are optional (the loop creates them); a vertical
    // prefills its predefined contexts as before.
    const tpl = wizTemplates.find((x) => x.id === wizTemplate);
    if (tpl) B.ctxInput.value = LoroPresets.prefillContexts(B.ctxInput.value, wizCtxDirty, tpl.contexts);
    drawWizHint();
  };
  drawWizHint();
}
function drawWizHint() {
  const hint = B.wizTemplateHint;
  hint.innerHTML = "";
  if (wizTemplate === AUTO_TEMPLATE_ID) {
    hint.hidden = false;
    hint.textContent = t("o loop cria e escolhe o tema sozinho ao organizar — você não precisa definir temas agora (dá para desligar depois em Configurações).");
    return;
  }
  const sel = wizTemplates.find((x) => x.id === wizTemplate);
  if (!sel) { hint.hidden = true; return; }
  hint.hidden = false;
  hint.append(document.createTextNode(sel.description + " "));
  if (sel.id !== "generico") {
    const dup = document.createElement("button");
    dup.type = "button"; dup.className = "link mono";
    dup.textContent = t("duplicar para personalizar");
    dup.onclick = async () => {
      try {
        const dir = await invoke("brain_duplicate_template", { id: sel.id });
        toast(t("modelo duplicado em") + " " + dir, 5000);
        await loadWizTemplates();
      } catch (e) { toast(tErr(String(e))); }
    };
    hint.appendChild(dup);
  }
}
B.ctxInput.addEventListener("input", () => { wizCtxDirty = true; });
B.cancelBtn.addEventListener("click", () => { creatingNew = false; applyAccent(activeColor()); brainRefresh(); });
function activeColor() { const a = acervos.find((x) => x.id === activeAcervo); return a ? a.color : ""; }
// ADR-0026 §2 — onde os códigos citados pelo conhecimento (MM-1147) abrem. Vazio
// é o padrão honesto: o código continua sendo uma marca, e nada é adivinhado.
function ticketBase() { const a = acervos.find((x) => x.id === activeAcervo); return (a && a.ticketBase) || ""; }
// Opções de leitura de um documento do acervo (ADR-0026).
function docOpts() { return { ticketBase: ticketBase() }; }
// ADR-0005 §6: choosing the acervo language in the wizard switches the whole
// UI live (the wizard itself relabels), so the choice is visible before you
// commit; it's then sent as the acervo's generation language on create.
if (B.wizLang) B.wizLang.addEventListener("change", async (e) => {
  settings.uiLang = e.target.value; persistSettings();
  try { settings.uiLang = await invoke("ui_set_lang", { lang: e.target.value }); } catch (_) {}
  if (el.uiLang) el.uiLang.value = settings.uiLang;
  applyI18n(); rerenderForLang();
  // o applyI18n acima re-traduz o título estático a partir do HTML ("Crie seu
  // primeiro projeto") — se estamos no fluxo "novo projeto", repõe o certo
  if (creatingNew) B.wizTitle.textContent = t("Novo projeto");
  // o caminho é do usuário (não é msgid): só a frase abaixo dele muda de idioma
  paintWizDirNote();
  // os nomes dos modelos vêm do backend já localizados: re-busca, não só redesenha
  loadWizTemplates();
});

// ---- onde guardar: um caminho DIGITÁVEL, com o picker ao lado ---------------
// O campo obrigatório do primeiro uso só existia como botão que abre o diálogo
// do macOS: não dava para completar o primeiro uso pelo teclado, não dava para
// colar um caminho que você já sabe, e nenhuma verificação automatizada
// conseguia criar um projeto. Agora o caminho é texto — e é validado do mesmo
// jeito que o backend o usa, com o preço dito na cópia em vez de falhar calado.
//
// O backend compara a pasta com as dos projetos existentes por STRING EXATA
// (resolve_acervo_slot) e monta o caminho com PathBuf::from, então normalizar
// aqui não é cosmético: "…/Loro/" ou "…//Loro" passariam pela porta que recusa
// uma pasta já tomada, e um caminho relativo cairia no diretório de trabalho do
// processo — que não é lugar nenhum que o usuário possa apontar.
function normalizeAcervoDir(raw) {
  const s = String(raw == null ? "" : raw).trim().replace(/\/{2,}/g, "/");
  // a raiz ("/") e a raiz de um volume no Windows ("C:\") SÃO a pasta: cortar a
  // barra final delas produziria um caminho que não existe
  if (s.length <= 1 || /:[\\/]?$/.test(s)) return s;
  return s.replace(/[\\/]+$/, "");
}
function isAbsoluteAcervoDir(dir) {
  return dir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(dir);
}
// Devolve { dir, err, note }: `dir` é o que vai para o brain_setup, `err` é o
// msgid da recusa (vazio quando serve) e `note` é o que vai acontecer com ele.
// Pura: os projetos existentes entram como lista, não como estado global.
function validateAcervoDir(raw, defaultDir, acervos, expectNew) {
  const typed = normalizeAcervoDir(raw);
  const dir = typed || normalizeAcervoDir(defaultDir);
  // N20 · `usedDefault` travels with the refusals too: a refusal that says "esta
  // pasta" over an empty field points at nothing on screen, and the painter has to
  // know the path is not visible in order to say it.
  const usedDefault = !typed;
  if (!dir) return { dir: "", err: "escreva o caminho da pasta ou use escolher pasta…", usedDefault };
  if (dir.startsWith("~")) {
    return { dir, err: "escreva o caminho completo, sem ~ (ou use escolher pasta…)", usedDefault };
  }
  if (!isAbsoluteAcervoDir(dir)) {
    return { dir, err: "escreva o caminho completo da pasta, começando na raiz (ou use escolher pasta…)", usedDefault };
  }
  if (dir.split(/[\\/]/).includes("..")) {
    return { dir, err: "escreva o caminho sem “..” — ele precisa apontar direto para a pasta", usedDefault };
  }
  const taken = (acervos || []).find((a) => a && normalizeAcervoDir(a.dir) === dir);
  // a MESMA recusa que o backend dá na porta (ADR-0024), dita antes da viagem:
  // o código err.* já tem as duas línguas e nomeia o projeto que mora ali
  if (taken && expectNew) return { dir, err: "err.acervo_dir_taken:" + (taken.name || ""), usedDefault };
  return {
    dir,
    err: "",
    // apagar o campo é legítimo (o backend cai na pasta padrão) — mas então a
    // tela tem de dizer QUAL pasta vai ser usada, em vez de ficar em branco
    usedDefault,
    // a pasta pode não existir ainda: o brain_setup a cria. Dizer isso é o que
    // evita a leitura "digitei errado" diante de um caminho perfeitamente válido.
    note: !typed ? "vazio: vamos usar a pasta padrão"
      : taken ? "esta pasta já é este projeto — o conteúdo é mantido"
      : "a pasta é criada se ainda não existir",
  };
}
// The field's effective value (empty = the folder the wizard offered).
// N20 · the field is prefilled with the FREE folder (freeAcervoDir), and clearing
// it fell back to the backend's raw constant — which, from the second project on,
// is the first project's folder. The refusal then named another project for an
// empty field. The empty field means the same folder the wizard prefilled.
function wizDirState() {
  return validateAcervoDir(
    B.dirInput ? B.dirInput.value : "",
    freeAcervoDir(wizDefaultDir, acervos, creatingNew),
    acervos, creatingNew);
}
// N19 · `default_acervo_dir` é uma CONSTANTE (~/Documents/Loro), e o wizard a
// oferecia sempre: para todo segundo projeto o formulário abria já em vermelho,
// acusando a pasta que o próprio app sugeriu. A sugestão passa a ser uma pasta
// livre — o mesmo padrão, com sufixo, ao lado da primeira. Pura.
function freeAcervoDir(defaultDir, acervos, expectNew) {
  const base = normalizeAcervoDir(defaultDir);
  if (!base || !expectNew) return base;
  const taken = new Set((acervos || []).map((a) => normalizeAcervoDir(a && a.dir)));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const cand = `${base}-${n}`;
    if (!taken.has(cand)) return cand;
  }
  return base;
}
// `reject` (opcional): a recusa que o backend acabou de dar para ESTE caminho. Sem
// ela a nota seguia prometendo "a pasta é criada se ainda não existir" para o
// caminho que o sistema de arquivos tinha acabado de negar (N20).
function paintWizDirNote(reject) {
  const note = B.dirNote;
  if (!note) return;
  if (reject) {
    // a região viva é revelada ANTES de receber o texto (N22/F6)
    note.hidden = false;
    note.classList.add("err");
    note.textContent = reject;
    return;
  }
  // a pasta padrão vem do backend por promessa: enquanto ela não chega e ninguém
  // digitou nada, não há o que dizer — "escreva o caminho da pasta" seria uma
  // acusação em vermelho antes do primeiro toque no formulário
  const typed = (B.dirInput && B.dirInput.value.trim()) || "";
  if (!typed && !wizDirDirty && !wizDefaultDir) { note.hidden = true; note.textContent = ""; return; }
  const st = wizDirState();
  let msg = st.err ? checkHint(st.err) : (st.note ? t(st.note) : "");
  // the path is a value, not a msgid: it goes beside the sentence.
  // N20 · the refusal also talks about ONE folder ("esta pasta já é o projeto X")
  // and the path was appended only on the success branch, so with an empty field
  // "esta pasta" pointed at nothing. The app knows the folder — so it says it.
  if (st.usedDefault && st.dir) msg += " — " + st.dir;
  // N22 · a ORDEM importa: uma região viva só é lida quando o texto muda com ela
  // já na árvore visível — escrever e só então revelar não anuncia nada. A regra
  // é a mesma que a suíte de a11y guarda para o toast e para o #brainSetupErr.
  note.hidden = !msg;
  note.classList.toggle("err", !!st.err);
  note.textContent = msg;
}
function setWizDir(dir) {
  if (B.dirInput) B.dirInput.value = dir || "";
  paintWizDirNote();
}
if (B.dirInput) B.dirInput.addEventListener("input", () => { wizDirDirty = true; paintWizDirNote(); });
// setup / criar acervo
B.dirBtn.addEventListener("click", async () => {
  try {
    const d = await invoke("pick_folder");
    if (d) { wizDirDirty = true; setWizDir(d); }
  } catch (e) { clog("pick_folder error: " + e); }
});
B.createBtn.addEventListener("click", async () => {
  const contexts = B.ctxInput.value.split(",").map((s) => s.trim()).filter(Boolean);
  B.setupErr.hidden = true;
  // o caminho digitado é recusado ANTES do estado pendente: um campo que só
  // falha depois de "criando…" faz o usuário esperar por uma recusa que o app
  // já sabia dar (DESIGN.md §1)
  const dirSt = wizDirState();
  paintWizDirNote();
  if (dirSt.err) {
    B.setupErr.hidden = false; B.setupErr.textContent = checkHint(dirSt.err);
    if (B.dirInput) B.dirInput.focus();
    return;
  }
  // DESIGN.md §5 · estado pendente: brain_setup semeia a pasta e roda `git init`
  // (processos filhos). Sem isto a única ação primária da primeira tela não dava
  // resposta nenhuma e continuava clicável — um segundo clique re-semeava tudo.
  if (B.createBtn.disabled) return;
  const label = B.createBtn.textContent;
  B.createBtn.disabled = true;
  B.createBtn.classList.add("pending");
  B.createBtn.textContent = t("criando…");
  try {
    // ADR-0005: automático is a synthetic picker option → autoContext + generico
    // seeding; any real template = manual (autoContext off).
    const auto = wizTemplate === AUTO_TEMPLATE_ID;
    const av = await invoke("brain_setup", {
      dir: dirSt.dir, contexts,
      name: B.nameInput.value.trim() || null,
      autoContext: auto,
      gitInit: B.gitInput.checked,
      color: wizColor || null,
      template: auto ? "generico" : (wizTemplate || null),
      agent: B.agentInput.value.trim() || null,
      // ADR-0005 §6 (revises ADR-0002 §1): the acervo's generation language is
      // an explicit wizard choice, not implicitly the UI language.
      lang: B.wizLang ? B.wizLang.value : null,
      // "novo projeto" x reconfigurar o mesmo: sem essa intenção, o backend
      // reaproveitava a entrada da pasta e o projeto novo tomava o lugar do que
      // já morava ali — dois domínios de conhecimento numa pasta só.
      expectNew: creatingNew,
    });
    acervos = av.acervos || []; activeAcervo = av.active || "";
    creatingNew = false;
    toast(t("projeto criado"));
    settings.saveDir = ""; persistSettings();
    setupWorkspace(); sideSig = ""; brainRefresh();
  } catch (e) {
    // role="alert" só fala o que muda com o nó já na árvore: revelar primeiro
    const msg = tErr(String(e));
    B.setupErr.hidden = false; B.setupErr.textContent = msg;
    // N20 · a nota do campo seguia prometendo "a pasta é criada se ainda não
    // existir" para o caminho que o sistema de arquivos acabou de recusar
    paintWizDirNote(msg);
  } finally {
    B.createBtn.disabled = false;
    B.createBtn.classList.remove("pending");
    B.createBtn.textContent = label;
  }
});

// ---- versionar (branch + commit local) → propor mudança (push + PR/RFC) ----
// O Git fica escondido: o usuário só "versiona" e depois "propõe a mudança".
// Extraída para função (ADR-0005): o mesmo botão "versionar" também aparece
// no rail lateral de um documento de contexto, não só no cabeçalho da acervo.
// N1 · a descrição da versão NÃO é o nome do rascunho. `brain_version` escolhe o
// branch pelo slug, então mandar a descrição como slug fazia cada versão nascer
// num rascunho novo, criado A PARTIR do principal: a versão anterior saía do
// documento aberto (e, com o mesmo arquivo sujo, o checkout abortava com o texto
// cru do git). O rascunho se troca no ⎇ (openBranchPicker) — aqui só se descreve
// o que mudou, e a versão cai no rascunho em que o usuário já está.
// SALVAR CRIA UM RASCUNHO? Só a partir do conhecimento oficial. Em qualquer outro
// branch a versão cai onde a pessoa está (save_version), então prometer um rascunho
// novo ali contradizia, na mesma tela, a frase que diz que salvar atualiza a revisão
// aberta. `draftSlugFromBranch` responde outra pergunta — se o rascunho é endereçável
// por slug — e não serve para esta.
function willCreateDraft(current, def) {
  const cur = String(current || "");
  return !cur || cur === (def || "main");
}

function draftSlugFromBranch(current, def) {
  const cur = String(current || "");
  if (!cur || cur === (def || "main")) return null;
  // brain_version endereça o rascunho por SLUG e o backend o resolve como
  // rfc/<slug>: um branch de outra origem não é endereçável assim, então dizer
  // que a versão cai nele seria mentira — nesse caso ela nasce num rascunho novo.
  if (!cur.startsWith("rfc/")) return null;
  return cur.slice(4) || null;
}
// COMO A TELA CHAMA o lugar onde você está — outra pergunta, e por isso outra
// função. `draftSlugFromBranch` responde "este rascunho é endereçável por slug?",
// que é o que `brain_version` precisa saber; usá-la para nomear a tela fazia o
// chip do compositor dizer "no conhecimento oficial" no branch de uma mudança em
// revisão, enquanto a faixa logo acima dizia "você está editando o rascunho
// «feature/x»" e o ✦ IA mostrava "⎇ feature/x". Um fato, uma resposta
// (DESIGN.md §5).
function draftNameFromBranch(current, def) {
  const cur = String(current || "");
  if (!cur || cur === (def || "main")) return "";
  return draftSlugFromBranch(cur, def) || cur;
}
// COMO A TELA CHAMA O LUGAR, em uma frase inteira. A folha «Rascunhos de
// trabalho» — a única tela cuja função é ESCOLHER o lugar — era a que chamava os
// lugares de `main (principal)` e `rfc/onboarding-atualizado-co`, um clique ao
// lado do chip do compositor, que diz «no conhecimento oficial» e «no rascunho
// onboarding-atualizado-co» (DESIGN.md §4: os termos internos não são pré-requisito
// para usar o app; §5: um fato, um nome).
function placeName(branch, def) {
  const name = draftNameFromBranch(branch, def);
  return name ? t("rascunho «%1»", [name]) : t("conhecimento oficial");
}
// O MESMO nome, no chip que diz ONDE VOCÊ ESTÁ — nas duas telas que o mostram. O
// painel ✦ IA imprimia o ref cru do git enquanto a Revisão chamava o mesmo
// rascunho de «no rascunho onboarding-atualizado-co»: um objeto, dois nomes, e o
// interno na tela em que a pessoa está editando (DESIGN.md §4 — o prefixo do git é
// rascunho de trabalho; §5 — um fato, um nome).
// PROSA E VALOR SÃO DUAS COISAS (DESIGN.md §5): o rótulo de um campo é prosa em
// --sans, e só o VALOR que ele carrega pode ser mono. A frase inteira («no rascunho
// X», «no conhecimento oficial») morava dentro do `font: mono` do .pbranch, então a
// tela que promete não exigir git escrevia a sua própria prosa na letra da máquina.
// O nome do rascunho continua mono — ele é um endereço.
// PROSA E VALOR SÃO DUAS COISAS (DESIGN.md §5): o rótulo de um campo é prosa em
// --sans, e só o VALOR que ele carrega pode ser mono. A frase inteira («no rascunho
// X», «no conhecimento oficial») morava dentro do `font: mono` do .pbranch, então a
// tela que promete não exigir git escrevia a sua própria prosa na letra da máquina.
// O nome do rascunho continua mono — ele é um endereço.
//
// Duas saídas para um fato: o TEXTO é o nome acessível e o que os toasts dizem; o
// HTML é a mesma frase com o endereço separado. Uma função para os dois, senão as
// duas divergem.
function draftChipLabel(branch, def) {
  const name = draftNameFromBranch(branch, def);
  return `⎇ ${name ? `${t("no rascunho")} ${name}` : t("no conhecimento oficial")}`;
}
function draftChipHtml(branch, def) {
  const name = draftNameFromBranch(branch, def);
  return `<span class="rvchipglyph" aria-hidden="true">⎇</span>` +
    (name
      ? `<span>${esc(t("no rascunho"))}</span><span class="mono">${esc(name)}</span>`
      : `<span>${esc(t("no conhecimento oficial"))}</span>`);
}
// A FORMA COMPACTA, para o cabeçalho. O desenho põe ali só `⎇ <nome> ⌄` — glifo,
// endereço, caret — e eu tinha reusado a forma com prosa: numa pílula de 190px a
// frase «no rascunho» quebrava em duas linhas, inchava o controle e desalinhava o
// cabeçalho. A frase inteira continua no title e no nome acessível, que é onde ela
// cabe; a linha mostra o endereço, que é o que muda.
function draftChipCompact(branch, def) {
  const name = draftNameFromBranch(branch, def);
  return `<span class="rvchipglyph" aria-hidden="true">⎇</span>` +
    `<span class="mono">${esc(name || t("oficial"))}</span>` +
    `<span class="rvchipcaret" aria-hidden="true">⌄</span>`;
}
async function currentDraftSlug() {
  try {
    const info = await invoke("git_branches");
    return draftSlugFromBranch(info && info.current, info && info.default);
  } catch (_) { return null; }
}
async function promptVersionar() {
  const draft = await currentDraftSlug();
  openModal(
    t("Salvar versão"),
    // N5 · a seção é por documento, mas a versão é do acervo todo: o preço tem de
    // estar dito na cópia, antes do clique.
    `<p class="pmnote">${t("guarda o projeto inteiro — todos os temas, não só o documento aberto.")}</p>` +
      (draft
        ? `<div class="wfield"><span class="mono">${t("rascunho")}</span><span class="lockval mono">⎇ ${esc(draft)}</span></div>`
        : `<p class="pmnote">${t("esta descrição também nomeia o rascunho de trabalho que vai receber a versão.")}</p>`) +
      `<label class="wfield"><span class="mono">${t("o que mudou")}</span>` +
      `<input id="versionMsg" type="text" placeholder="${t("ex.: política de frota revisada")}" spellcheck="false"></label>`,
    t("salvar versão"),
    async () => {
      const message = (($("versionMsg") && $("versionMsg").value) || "").trim();
      if (!message) { toast(t("descreva a mudança")); return; }
      const r = await invoke("brain_version", { slug: draft || message, message });
      // N3 · o resultado voltava e era descartado: com a árvore limpa o backend
      // não versionava nada e a tela anunciava "versão salva" mesmo assim.
      if (!r || !r.saved) { toast(t("nada mudou desde a última versão — nenhuma versão foi criada")); return; }
      toast(t("versão salva"));
      // sync degraded (offline / diverged main): tell the user, don't block
      if (r && r.warn) toast(tErr(r.warn), 5000);
      // N3 · o ⎇ e a contagem do botão ficavam parados até o tique de 10s
      brainRefresh();
    }
  );
}
B.gitBtn.addEventListener("click", promptVersionar);

// N2 (round 3) · what a switch COSTS, decided before the click. Clicking the
// "(principal)" row used to take the whole project off the disk in silence: on
// a project that only started versioning after setup, the baseline commit
// carries no file at all, so that branch is an empty room and every document
// lives on the draft. git keeps the content safe on the draft's commit — what
// was missing is the screen saying the price, saying nothing was deleted, and
// saying the way back (DESIGN.md §1). `leaving` and `docs` come counted from
// git_branches; a switch that removes nothing has no price to declare.
function switchPrice(stand, from, def) {
  const leaving = (stand && stand.leaving) || 0;
  if (!leaving) return null;
  // `def` viaja com o preço porque a folha nomeia os DOIS lugares, e saber qual
  // deles é o conhecimento oficial é a pergunta que `def` responde
  return { leaving, targetEmpty: !(stand && stand.docs), from: from || "", def: def || "main" };
}
function holdsLabel(docs) {
  return docs ? `${docs} ${docs > 1 ? t("documentos") : t("documento")}` : t("nada guardado ainda");
}
// The switch already happened: the toast is the only place that can say where
// the material went. It used to say "⎇ main" and nothing else, while the tabs
// closed and the sidebar emptied.
//
// `def` travels with the call because the ONLY way to know whether a ref is the
// official knowledge is to know which ref is the default — the caller just read
// it from git_branches. Without it this line printed the raw git ref ("⎇
// rfc/toast-tres", "⎇ main") two centimetres above the chip that calls the same
// place «no rascunho toast-tres»: one fact, two names (DESIGN.md §4/§5).
function afterSwitch(branch, price, def) {
  const kept = price
    ? ` · ${price.leaving} ${price.leaving > 1 ? t("documentos ficaram no rascunho anterior") : t("documento ficou no rascunho anterior")}`
    : "";
  toast("⎇ " + placeName(branch, def || (price && price.def) || REV.def) + kept, price ? 6000 : undefined);
  // the disk changed under the open tabs — reset to Home (acervo-switch pattern)
  setupWorkspace(); sideSig = ""; brainRefresh();
  // MEASURED IN THE RUNNING APP: the toast said «⎇ conhecimento oficial» while the
  // chip two centimetres above still said «no rascunho fe5-aviso», until the 10 s
  // poll came round. Where you are is this destination's own fact: the switch is
  // the moment it changed (refreshMyChanges re-reads git_branches and repaints the
  // chip, the empty state and the price of saving; it no-ops off the destination).
  refreshMyChanges();
}
// The price, stated before the click, with the destination and the way back
// named — both as the screen calls them, never as git does.
function confirmSwitchBranch(branch, price) {
  openModal(
    t("Trocar de rascunho"),
    // «7 documentos saem da tela — lá ainda não há nenhum documento — a tela vai
    // ficar vazia» eram duas orações dizendo a mesma coisa: a segunda basta.
    `<p class="pmnote">${price.targetEmpty
      ? esc(t("lá ainda não há nenhum documento — a tela vai ficar vazia."))
      : `${price.leaving} ${price.leaving > 1 ? t("documentos saem da tela") : t("documento sai da tela")}`}</p>` +
      `<p class="pmnote">${t("nada é apagado: eles continuam guardados no rascunho atual.")}</p>` +
      `<div class="wfield"><span class="mono">${t("vai para")}</span>` +
      `<span class="lockval mono">⎇ ${esc(placeName(branch, price.def))}</span></div>` +
      (price.from
        ? `<div class="wfield"><span class="mono">${t("volta para")}</span>` +
          `<span class="lockval mono">⎇ ${esc(placeName(price.from, price.def))}</span></div>`
        : ""),
    t("trocar mesmo assim"),
    async () => {
      try { afterSwitch(await invoke("git_switch_branch", { branch }), price, price.def); }
      catch (e) { toast(tErr(String(e)), 5000); }
    }
  );
}
// ADR-0002 §2 — branch picker: see the current branch, switch to another local
// branch or create a new rfc/. Switching with a dirty tree is blocked by the
// backend (err.working_tree_dirty); the remedy is the Versionar button itself.
async function openBranchPicker() {
  let info;
  try { info = await invoke("git_branches"); } catch (e) { toast(tErr(String(e))); return; }
  // Com mudança que ainda não está em nenhuma versão, `switch_branch` RECUSA
  // (err.working_tree_dirty). A folha oferecia todas as linhas, prometia na
  // seguinte um preço que não ia acontecer e só no TERCEIRO clique dizia que não
  // dava — e `dirty` vem do mesmo `git_branches` que desenha as linhas, então ela
  // já sabia no primeiro (DESIGN.md §1: nenhum controle que não faz nada; o estado
  // nunca mente).
  // A ÁRVORE SUJA NÃO É MAIS UMA RECUSA, é um preço. `switch_branch` deixou de
  // pré-recusar o que o git aceita: no caso comum a modificação viaja com a pessoa.
  // Então a folha para de nascer com todas as linhas apagadas — o que virou o normal
  // desde que salvar o arquivo não commita mais — e passa a DIZER o que acontece.
  const dirty = !!info.dirty;
  // N8 · as linhas eram <div> com onclick: trocar de rascunho era impossível pelo
  // teclado (WCAG 2.1.1) e o leitor de tela as anunciava como texto (4.1.2).
  const rows = (info.branches || []).map((b) => {
    const cur = b.name === info.current;
    const holds = holdsLabel(b.docs);
    const name = placeName(b.name, info.default);
    const off = false;   // quem recusa é o git, e só quando sobrescreveria
    return `<div class="fitem2 draftrow${cur ? " on" : ""}${off ? " muted fstatic" : ""}" data-branch="${esc(b.name)}"` +
      (off ? ` data-off="1" aria-disabled="true"` : ` role="button" tabindex="0"`) +
      `${cur ? ' aria-current="true"' : ""}` +
      ` aria-label="${esc(name)} — ${esc(holds)}${off ? " — " + t("salve uma versão primeiro") : ""}">` +
      `<span class="fn">${cur ? "● " : ""}${esc(name)}</span>` +
      `<span class="fmeta">${esc(off ? t("salve uma versão primeiro") : holds)}</span></div>`;
  }).join("");
  const body = openModal(
    t("Rascunhos de trabalho"),
    `<div class="fitem2 muted fstatic">${t("cada mudança vive num rascunho. Trocar de rascunho troca o que você vê em «mudanças de agora» — nada se perde.")}</div>` +
      // CRIAR continua funcionando com a árvore suja (`checkout -b` leva a mudança
      // com ela), e é isso que a frase promete: a recusa é só da troca
      (dirty ? `<div class="fitem2 muted fstatic">${t("você tem mudança que ainda não está em nenhuma versão: ela vai com você para o rascunho escolhido. Se lá o documento for diferente, a troca é recusada e a tela diz qual.")}</div>` : "") +
      rows +
      `<div class="fsep"></div><div class="fitem2 add" data-newbranch>＋ ${t("novo rascunho…")}</div>`,
    null,
    null
  );
  body.querySelectorAll("[data-branch]").forEach((el2) => {
    if (el2.dataset.off) return;   // a folha já disse que esta linha não está disponível
    el2.onclick = async () => {
      closeModal();
      const b = el2.dataset.branch;
      if (b === info.current) return;
      const stand = (info.branches || []).find((x) => x.name === b);
      const price = switchPrice(stand, info.current, info.default);
      if (price) return confirmSwitchBranch(b, price);
      try { afterSwitch(await invoke("git_switch_branch", { branch: b }), null, info.default); }
      catch (e) { toast(tErr(String(e)), 5000); }
    };
    wireActivateKeys(el2);
  });
  const nb = body.querySelector("[data-newbranch]");
  if (nb) {
    nb.setAttribute("role", "button");
    nb.setAttribute("tabindex", "0");
    nb.onclick = () => promptNewDraft();
    wireActivateKeys(nb);
  }
}

// D3 · o nome do rascunho é UM campo. O desenho compunha `<tipo>/<assunto>` a
// partir de cinco pílulas, mas o backend endereça o rascunho por slug e só
// resolve o prefixo que já usa — cinco controles a mais para o mesmo resultado.
// O contador e a prévia são a resposta imediata que um campo com limite deve dar
// (DESIGN.md §1: toda ação tem retorno).
const DRAFT_MAX = 24;
function draftSlugify(raw) {
  return String(raw || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, DRAFT_MAX)
    // o corte no 24\u00ba caractere pode cair num "-", e `sanitize_slug` (git.rs) apara
    // as pontas: sem esta linha o nome que a tela ANUNCIA teria um tra\u00e7o que o
    // rascunho criado n\u00e3o tem
    .replace(/-+$/g, "");
}
function promptNewDraft() {
  openModal(
    t("Novo rascunho"),
    `<p class="pmnote">${t("o nome diz o assunto — curto e objetivo, até 24 letras, sem espaços.")}</p>` +
      `<label class="wfield stack"><span>${t("Novo rascunho")}</span>` +
      `<input id="newDraft" type="text" placeholder="${t("assunto-do-rascunho")}" spellcheck="false"></label>` +
      // o contador é a metade da máquina da linha, então ele é o que vai em mono
      `<p class="pmnote"><span class="mono" id="newDraftEcho">${t("%1/24", [0])}</span></p>`,
    t("criar e trocar para ele"),
    async () => {
      const slug = draftSlugify($("newDraft") && $("newDraft").value);
      if (!slug) { toast(t("dê um nome curto ao rascunho")); return; }
      // um rascunho novo nasce do trabalho que está na frente do usuário: nada
      // sai da tela, então não há preço a declarar
      // afterSwitch já relê onde estamos: repetir aqui era o mesmo pedido duas vezes
      afterSwitch(await invoke("git_create_branch", { slug }), null, REV.def);
    }
  );
  const field = $("newDraft"), echo = $("newDraftEcho");
  if (!field || !echo) return;
  const paint = () => {
    const slug = draftSlugify(field.value);
    echo.textContent = `${t("%1/24", [slug.length])}${slug ? " · ⎇ " + slug : ""}`;
  };
  field.addEventListener("input", paint);
  paint();
}
if (B.branchBtn) B.branchBtn.addEventListener("click", openBranchPicker);

// S7 · a folha pergunta o que o MODELO DO TIME pergunta: os rótulos vêm do
// arquivo que o repositório já traz (brain_pr_template), não de uma lista que
// este app inventou — e são o texto do time, não msgids. A espera mora no
// confirmar da folha, que é onde o pendente já é anunciado (WCAG 4.1.2); por isso
// o ouvinte continua síncrono.
B.proposeBtn.addEventListener("click", () => {
  Promise.all([
    invoke("brain_pr_template").catch(() => null),
    currentDraftSlug(),
  ]).then(([tpl, slug]) => {
    const secs = (tpl && tpl.sections && tpl.sections.length) ? tpl.sections : [];
    const rel = (tpl && tpl.rel) || "";
    // A DICA DO MODELO ERA CALCULADA E JOGADA FORA. O backend já devolve, por
    // seção, a frase que o próprio `<!-- … -->` do modelo do time carrega
    // (`PrTemplate.hints`), e a folha pedia a descrição que o time inteiro vai ler
    // como N caixas vazias de uma linha. A frase vira o placeholder — é ela que diz
    // o que a seção quer — e o campo vira multilinha, porque «o que muda e por quê»
    // não é um valor de uma linha (o desenho usa textarea rows=2).
    const hints = (tpl && tpl.hints) || [];
    const fields = secs.map((s, i) =>
      `<label class="wfield stack"><span>${esc(s)}</span>` +
      `<textarea class="prsec" data-sec="${i}" rows="2" spellcheck="false"` +
      `${hints[i] ? ` placeholder="${esc(hints[i])}"` : ""}></textarea></label>`).join("");
    openModal(
      t("Enviar para revisão do time"),
      `<p class="pmnote">${esc(t("o time recebe a mudança do rascunho «%1» com a descrição abaixo. Nada entra no conhecimento oficial sem aprovação.", [slug || REV.branch || "—"]))}</p>` +
        `<label class="wfield stack"><span>${t("Título")}</span>` +
        `<input id="prTitle" type="text" placeholder="${t("uma linha sobre a mudança")}" spellcheck="false"></label>` +
        fields +
        // o CAMINHO é a metade da máquina desta linha (DESIGN.md §3: um caminho é
        // sempre mono), e a frase em volta é prosa
        (rel ? `<p class="pmnote">${t("modelo do time · %1", [`<span class="mono">${esc(rel)}</span>`])} — ` +
          `<button class="plink" id="prTplBtn">${t("configurar o modelo")}</button></p>` : ""),
      t("↗ enviar para o time"),
      async () => {
        const title = (($("prTitle") && $("prTitle").value) || "").trim();
        if (!title) { toast(t("descreva a mudança")); return; }
        const body = secs.map((s, i) => {
          const f = document.querySelector(`.prsec[data-sec="${i}"]`);
          return `## ${s}\n\n${((f && f.value) || "").trim()}\n`;
        }).join("\n");
        const pr = await invoke("brain_propose_change", { title, body });
        // N4 · a url voltava do backend e era jogada fora: quem acabou de propor
        // não tinha por onde chegar à própria revisão. O número não é um endereço.
        lastProposalUrl = (pr && pr.url) || "";
        const msg = pr && pr.number ? `${t("enviado para revisão do time")} · #${pr.number}` : t("enviado para revisão do time");
        const acts = [];
        if (lastProposalUrl) acts.push({ label: t("abrir a revisão"), run: () => openProposalUrl(lastProposalUrl) });
        acts.push({ label: t("ver revisões"), run: () => goDest("review", "team") });
        toastAction(msg, acts);
        maybeRefreshNotifications(true);
      }
    );
    const cfg = $("prTplBtn");
    if (cfg) cfg.onclick = () => openTeamTemplateSheet(secs);
  });
});

// "configurar o modelo": uma seção por linha. O arquivo mora dentro da árvore
// versionada, então a mudança nasce como mudança pendente e passa pela MESMA
// revisão que qualquer outra — é o que a cópia promete, e é o que acontece.
function openTeamTemplateSheet(current) {
  openModal(
    t("configurar o modelo"),
    `<p class="pmnote">${t("uma seção por linha — vale para todo o time, e a mudança passa pela mesma revisão que qualquer outra.")}</p>` +
      `<label class="wfield stack"><span>${t("seções do modelo")}</span>` +
      `<textarea id="prTplBody" rows="7" spellcheck="false">${esc((current || []).join("\n"))}</textarea></label>`,
    t("salvar o modelo do time"),
    async () => {
      const raw = (($("prTplBody") && $("prTplBody").value) || "").split("\n").map((l) => l.trim()).filter(Boolean);
      if (!raw.length) { toast(t("o modelo precisa de pelo menos uma seção")); return; }
      await invoke("brain_set_pr_template", { sections: raw });
      toast(t("modelo do time atualizado — vale para as próximas revisões"), 5000);
      brainRefresh();
      // de volta para onde a pessoa estava: a folha do envio, já com os campos novos
      B.proposeBtn.click();
    }
  );
}

// N4 · a metade da revisão não tinha superfície: `gh_pr_list` existia no contrato
// e nenhum caller no frontend, então "2 aguardam sua revisão" era um número sem
// porta. ADR-0027 · a folha virou DESTINO: a leitura acontece dentro do Loro e o
// navegador deixou de ser o único lugar onde uma mudança pode ser lida. O
// endereço continua alcançável (⧉ copiar link) porque colar a revisão no chat do
// time é uma coisa que uma pessoa faz — e o app é quem tem o endereço.
let lastProposalUrl = "";
async function copyProposalUrl(url) {
  toast((await copyToClipboard(url)) ? t("link copiado") : t("não consegui copiar"));
}
// A revisão acontece no navegador, e o app tinha o endereço e nenhuma porta:
// copiar o link era consolo, não ação. Vai pelo mesmo caminho estreito de uma
// referência externa — `brain_open_link` só aceita http(s), sem shell, e nenhum
// token passa por aqui (BR-9).
async function openProposalUrl(url) {
  if (!url) return;
  try { await invoke("brain_open_link", { url }); }
  catch (e) { toast(t("não abri a revisão no navegador")); clog("open_link error: " + e); }
}
/* ====================== Revisão · o destino (ADR-0027) ======================
   Duas metades do mesmo assunto: o que VOCÊ mudou e ainda não salvou, e o que o
   TIME propôs e espera alguém ler. Toda a decisão de FORMA — o que é um trecho,
   quem pode aprovar, o que bloqueia, como uma linha de diff se numera — mora em
   review.js, que é puro e não fala português. Aqui só se escolhe o msgid e se
   liga o clique. */
const RV = window.LoroReview;
const REV = {
  changes: null,              // FileDiff[] de brain_git_diff (null = ainda não lido)
  changesErr: "",
  // "%1 de %2 vistos" é da SESSÃO: um contador que sobrevivesse a uma versão
  // salva estaria contando arquivos que já não estão na mudança.
  viewed: new Set(),
  mode: "unified",            // D5 · numa coluna de 720px o lado a lado dá 330px
  openDiff: new Set(),        // caminhos com o diff completo aberto
  openCard: new Set(),        // caminhos com o cartão aberto
  rowsMore: new Map(),        // caminho → quantas linhas de diff já foram abertas
  prs: null, prsErr: "", prsStale: false, prsFresh: false,
  detail: null, detailDiff: null, detailErr: "", openNum: 0,
  branch: "", def: "main",
  cameFrom: "",               // F11 · de qual rascunho saímos para editar o de outra pessoa
  sig: "", teamSig: "",
};

const reviewOn = () => LoroShell.destination() === "review";
const reviewTab = () => LoroShell.reviewTab();

// DESIGN.md §5 · o pendente é desfeito pelo DESFECHO, nunca por um relógio: uma
// chamada ao gh são três processos e duas idas à rede, e um botão que volta
// sozinho antes da resposta mente sobre o que já terminou.
async function withPending(btn, run, label) {
  if (!btn) return run();
  const was = btn.textContent;
  btn.disabled = true;
  btn.classList.add("pending");
  btn.setAttribute("aria-busy", "true");
  btn.textContent = label || t("um momento…");
  try { return await run(); }
  finally {
    btn.disabled = false;
    btn.classList.remove("pending");
    btn.removeAttribute("aria-busy");
    btn.textContent = was;
  }
}

// Concordância de número. "1 trechos mudaram" e "1 linhas sem mudança" são a
// interface escrevendo errado sobre o próprio conteúdo, e as duas formas são
// msgids separados — quem traduz escolhe as duas (o app já faz isso em
// holdsLabel: "1 documento" / "18 documentos").
function plural(n, one, many) {
  return t(Math.abs(Number(n)) === 1 ? one : many, [n]);
}

// Os códigos cujo remédio é o diagnóstico de Configurações. Um só lugar: a recusa
// prévia de F5 (revProposeBtn) e o erro que fica dentro da folha (pmError) têm de
// oferecer a MESMA porta, senão são duas regras para a mesma verdade. Cobre o que
// teamBlockCode() escolhe entre, mais as duas do projeto.
const ENV_REMEDY = ["err.gh_not_found", "err.gh_auth_required", "err.git_remote_required",
  "err.github_unreachable", "err.acervo_not_configured", "err.git_repo_required"];

// O que impede a metade do time de funcionar, como CÓDIGO estável — a mesma
// verdade que o card de Configurações pinta, sem uma segunda frase para manter.
function teamBlockCode() {
  const d = envDoctor;
  if (!d || d.versioningEnabled) return "";
  if (d.offline) return "err.github_unreachable";
  if (d.gh && !d.gh.ok) return "err.gh_not_found";
  if (d.ghAuth && !d.ghAuth.ok) return "err.gh_auth_required";
  if (d.remote && !d.remote.ok) return "err.git_remote_required";
  return "err.gh_not_found";
}

// R38 · A REGIÃO VIVA FALA PELA METADE QUE ESTÁ NA TELA. As duas metades se pintam
// na mesma passada (renderDestReview) e as duas falavam na única região viva do
// app: a última a terminar ganhava, então chegar no destino anunciava «nada aqui
// ainda» sobre a metade escondida e nada sobre a que estava na frente
// (WCAG 4.1.2/4.1.3). Um leitor de tela ouve o que um olho vê, ou nada.
function announceRev(half, msg) {
  if (!reviewOn() || reviewTab() !== half) return;
  if (REV.openNum) return;   // a revisão aberta cobre as duas listas
  announce(msg);
}

// R43 · O ENDEREÇO do controle que tem o teclado, para que um repintar não o
// perca. `list.innerHTML = …` destrói o nó focado: no poll de 10s (uma análise
// escrevendo um documento, um git em curso) o foco caía no <body> e o Tab
// recomeçava no primeiro cartão — o foco movido por uma mudança que o usuário não
// fez (WCAG 2.4.3). A marca é o atributo que identifica a linha, nunca o nó.
const FOCUS_MARKS = ["data-rvseen", "data-rvfull", "data-rvmode", "data-rvmore"];
function focusMarkIn(root) {
  const on = document.activeElement;
  if (!on || !root || !root.contains || !root.contains(on)) return "";
  for (const a of FOCUS_MARKS) {
    const v = on.getAttribute && on.getAttribute(a);
    if (v && !/["\\]/.test(v)) return `[${a}="${v}"]`;
  }
  const card = on.closest && on.closest("[data-rvcard]");
  const p = card && card.getAttribute("data-rvcard");
  if (on.tagName === "SUMMARY" && p && !/["\\]/.test(p)) return `[data-rvcard="${p}"] > summary`;
  return "";
}
function restoreFocusMark(root, mark) {
  if (!mark || !root) return;
  const on = document.activeElement;
  // um foco que já tem dono não se move: só o que o repintar deixou órfão volta
  if (on && on !== document.body && root.contains && root.contains(on)) return;
  const n = root.querySelector(mark);
  if (n) { try { n.focus(); } catch (_) {} }
}

/* ---- a frase de abertura, o rascunho e os contadores --------------------- */

// A frase acompanha a ABA: as duas metades prometem coisas diferentes, e uma
// frase só teria de mentir sobre uma delas.
function paintReviewIntro() {
  const p = $("revIntro");
  if (!p) return;
  p.textContent = reviewTab() === "team"
    ? t("Mudanças propostas ao conhecimento oficial. Nada entra sem aprovação — e a sua leitura acontece aqui, sem sair do Loro.")
    : t("Nada sai do seu computador sozinho: salvar guarda uma versão no seu rascunho de trabalho; enviar para revisão é um passo separado, e o time aprova antes de virar conhecimento oficial.");
  const off = $("revOffline");
  if (off) off.hidden = !(envDoctor && envDoctor.offline);
}

// R44 · O QUE O APP JÁ SABE, ANTES DO CLIQUE. «↗ Enviar para revisão do time»
// ficava armado e calado numa tela que já sabia que a outra metade não está
// conectada — o mesmo teamBlockCode() era avaliado NO clique, e a resposta era um
// toast citando `gh auth login` a quem foi prometido que não precisa saber git. A
// superfície antiga da mesma ação (a seção TIME do painel) já era mais estrita:
// ela esconde o botão e diz onde se liga. Aqui o botão fica na tela — é a porta
// permanente desta metade —, mas desarmado, com o motivo dito acima dele e o
// remédio como botão (DESIGN.md §1: a interface não sabe nada que não diz).
// QUEM SOU EU nesta tela, num lugar só: a conta que o diagnóstico do ambiente
// leu. Duas cópias dessa leitura decidem «meu rascunho» de dois jeitos.
function reviewMe() {
  return (envDoctor && envDoctor.account) || "";
}

// O QUE TOMA O LUGAR DO CONTROLE. Um passo que não existe mais não vira um botão
// desarmado nem desaparece em silêncio: vira o estado que explica por que ele não
// está lá, com a porta para a revisão que já existe.
function paintOpenReviewState(aberta) {
  const el = $("revOpenState"), go = $("revOpenStateGo");
  if (!el) return;
  el.hidden = !aberta;
  if (go) go.hidden = !aberta;
  if (!aberta) return;
  // Sem saber QUEM EU SOU (o diagnóstico do ambiente ainda não leu a conta), o app
  // não pode afirmar que o rascunho é de outra pessoa: `same("aipi", "")` é falso, e
  // era isso que fazia a própria mudança da pessoa se apresentar como alheia. Sem a
  // conta, a frase é a neutra — a que vale nos dois casos.
  el.textContent = !reviewMe() || aberta.mine
    ? t("esta mudança já está em revisão (#%1) — salvar versão atualiza a revisão aberta.", [aberta.number])
    : t("este rascunho é de outra pessoa e já está em revisão (#%1) — salvar versão atualiza a revisão aberta.", [aberta.number]);
  if (go) {
    go.textContent = t("ver a revisão #%1", [aberta.number]);
    go.onclick = () => goDest("review", "team") || openReview(aberta.number);
  }
}

// UMA PORTA, NÃO DUAS. O estado «tudo salvo» oferece «abrir Configurações» (R48:
// um estado vazio orienta o passo que FUNCIONA, e uma porta não é uma frase), e o
// portão do time oferecia a MESMA porta 300px abaixo, com a mesma frase, na mesma
// passada de pintura. A de cima fica — ela é a que o estado vazio nomeia —, e a de
// baixo se cala. A nota continua, porque ela é o motivo do botão desarmado.
function emptyStateOffersCfg() {
  const block = teamBlockCode();
  const vazia = Array.isArray(REV.changes) && REV.changes.length === 0;
  return vazia && !!draftSlugFromBranch(REV.branch, REV.def) && !!block && block !== "err.github_unreachable";
}

function paintTeamGate() {
  const note = $("revTeamNote"), go = $("revTeamGo"), btn = $("revProposeBtn");
  if (!note) return;
  const block = teamBlockCode();
  note.hidden = !block;
  // sem rede o remédio não é Configurações: é esperar a rede (a nota já diz isso).
  // E se o estado vazio já está oferecendo a mesma porta, esta se cala.
  if (go) go.hidden = !block || block === "err.github_unreachable" || emptyStateOffersCfg();
  // Desabilitado, sem título: um tooltip não dispara num controle desabilitado, e
  // o texto do código («autentique no GitHub (gh auth login)…») é do diagnóstico de
  // Configurações — na tela que promete que não é preciso saber git, o motivo é a
  // frase acima e o remédio é o botão dela.
  if (btn) btn.disabled = !!block;
  // ENVIAR DEIXA DE SER UM PASSO quando o rascunho já está em revisão. O controle
  // dizia «↗ Enviar para revisão do time» e por dentro ATUALIZAVA a revisão aberta
  // — um rótulo que promete abrir o que ele vai atualizar. Com o bloqueio do time
  // o botão continua na tela e desarmado (é a porta permanente desta metade, e a
  // nota acima diz o motivo); aqui ele SAI, porque não há passo nenhum a oferecer:
  // salvar versão já leva a versão à revisão (DESIGN.md §1 — nunca um controle que
  // não faz nada).
  const aberta = block ? null : RV.openReviewFor(REV.prs, REV.branch, { me: reviewMe() });
  if (btn && !block) btn.hidden = !!aberta;
  paintOpenReviewState(aberta);
  if (!block) return;
  note.textContent = block === "err.github_unreachable"
    ? t("sem conexão agora — salvar versão funciona local; a revisão do time volta quando a rede voltar.")
    : t("o time ainda não está conectado — conecte o GitHub em Configurações para enviar e receber revisões.");
  if (go && !go.hidden) { go.textContent = t("abrir Configurações"); go.onclick = openCfgGit; }
}

// R36 · A FRASE QUE QUALIFICA «Salvar versão do projeto»: a versão guarda o que já
// está no ARQUIVO, e o editor pode ter texto que ainda não foi para lá — que
// ficaria fora da versão, em silêncio. Ela mora na descrição do botão
// (aria-describedby), como o preço: quem chega nele pelo teclado ouve as duas
// (WCAG 3.3.2). Com a lista vazia quem carrega essa verdade é o estado vazio, que
// é onde a pergunta da tela é respondida.
function paintUnsavedDocs(unsaved, hasFiles) {
  const note = $("revUnsavedNote"), go = $("revUnsavedGo");
  if (!note) return;
  const show = !!(unsaved.length && hasFiles);
  note.hidden = !show;
  if (go) go.hidden = !show;
  if (!show) return;
  note.textContent = t(
    "texto não salvo em %1: a versão guarda o que já está no arquivo, então salve o documento primeiro.",
    [unsaved.map((d) => d.title).join(", ")]
  );
  if (!go) return;
  go.textContent = t("abrir o documento");
  // repetido por linha, o nome acessível diz QUAL documento (WCAG 2.4.6/2.5.3)
  go.setAttribute("aria-label", `${t("abrir o documento")} — ${unsaved[0].title}`);
  go.onclick = () => activateTab(unsaved[0].id);
}

// O MESMO FATO EM TRÊS LUGARES, UMA FONTE. O chip do cabeçalho, o do compositor da
// Revisão e o da seção TIME dizem onde a próxima versão cai; `draftChipHtml` desenha
// e `draftChipLabel` dá o texto que vira nome acessível. Sem branch (ou sem git) o
// controle não é desenhado — um chip vazio não é um fato.
function paintHeadDraft(branch, def) {
  const el = $("headDraft");
  if (!el) return;
  const has = !!branch;
  el.hidden = !has;
  if (!has) return;
  el.innerHTML = draftChipCompact(branch, def);
  el.setAttribute("aria-label", `${t("Rascunhos de trabalho")} — ${draftChipLabel(branch, def)}`);
  el.title = draftChipLabel(branch, def);
}

function paintReviewDraft() {
  const chip = $("revDraft");
  if (!chip) return;
  // onde você ESTÁ (o nome real do lugar) e se ele é endereçável por slug são
  // duas coisas: a primeira nomeia a tela, a segunda decide se salvar CRIA um
  // rascunho novo
  const slug = draftSlugFromBranch(REV.branch, REV.def);
  chip.innerHTML = draftChipHtml(REV.branch, REV.def);
  chip.setAttribute("aria-label", `${t("Rascunhos de trabalho")} — ${draftChipLabel(REV.branch, REV.def)}`);
  // A SEGUNDA METADE DO PREÇO. Sem um rascunho endereçável, "Salvar versão"
  // CRIA um (`brain_version` → `git checkout -b rfc/<slug>`) e a pessoa sai do
  // lugar em que estava. Isso era feito em silêncio, com o nome tirado da frase
  // que ela acabou de escrever — 49 letras que ninguém escolheu, na tela cuja
  // folha vizinha ensina "até 24 letras". O nome é dito antes do clique, e é o
  // MESMO que saveVersionFromReview manda (draftSlugify).
  const note = $("revSaveNote");
  if (!note) return;
  // A pergunta é «salvar vai CRIAR um rascunho?», e a resposta é «só a partir do
  // oficial». Ela era `!!slug` — se o rascunho é endereçável por `rfc/<slug>` —, o
  // que num branch de time (`feat/…`) dava falso e fazia a tela prometer um rascunho
  // novo ao lado da frase que diz que salvar atualiza a revisão aberta.
  const cria = willCreateDraft(REV.branch, REV.def);
  note.hidden = !cria;
  if (!cria) return;
  const willBe = draftSlugify(($("revMsg") && $("revMsg").value) || "");
  note.textContent = willBe
    ? t("salvar cria o rascunho «%1» e guarda a versão nele — o conhecimento oficial só recebe mudanças por revisão.", [willBe])
    : t("salvar cria um rascunho de trabalho com o nome da sua descrição — o conhecimento oficial só recebe mudanças por revisão.");
}

/* ---- 1g.1 · o que VOCÊ mudou -------------------------------------------- */

// O estado do documento é a palavra do backend (diff.rs::ChangeKind) traduzida
// UMA vez: o ponto da lateral e este distintivo dizem a mesma coisa da mesma
// mudança, então não podem ter dois nomes (DESIGN.md §5).
function changeBadge(status) {
  if (status === "added") return { cls: "ok", label: t("novo") };
  if (status === "removed") return { cls: "warn", label: t("removido") };
  if (status === "renamed") return { cls: "warn2", label: t("renomeado") };
  return { cls: "warn2", label: t("modificado") };
}

// Quantas linhas o resumo mostra antes de dizer quantas ficaram de fora, e
// quantas linhas de diff um cartão desenha de uma vez. Um documento novo é UM
// trecho com o arquivo inteiro dentro: sem teto, um cartão vira o arquivo.
const BIT_LINES = 12;
const DIFF_ROWS_MAX = 400;

function diffRowsHtml(file) {
  const all = RV.diffRows(file, { mode: REV.mode });
  const path = String((file && file.path) || "");
  const cap = REV.rowsMore.get(path) || DIFF_ROWS_MAX;
  const rows = all.slice(0, cap);
  const cut = all.length - rows.length;
  const num = (n) => (n === null || n === undefined ? "" : String(n));
  return rows.map((r) => {
    if (r.kind === "gap") {
      // Não é um controle: o backend manda três linhas de contexto e mais nada,
      // então um "abrir" aqui abriria coisa nenhuma (DESIGN.md §1). Mas ela era
      // BYTE A BYTE o vizinho que É um controle — mesma classe, mesmo ⋯ na frente,
      // 20 linhas acima do corte de 400 que carrega um botão de verdade. Duas
      // coisas diferentes com a mesma aparência: o ⋯ sai (ele promete «tem mais,
      // clique») e a faixa fica explicitamente quieta.
      return `<div class="rvgap quiet">${esc(plural(r.lines, "%1 linha sem mudança", "%1 linhas sem mudança"))}</div>`;
    }
    if (r.kind === "uni") {
      const tone = r.tone === "none" ? "" : ` ${r.tone}`;
      return `<div class="rvrow uni${tone}"><span class="rvnum">${num(r.oldNum)}</span>` +
        `<span class="rvnum">${num(r.newNum)}</span><span class="rvsign">${r.sign}</span>` +
        `<span class="rvtxt">${esc(r.text)}</span></div>`;
    }
    // D8 · lado a lado. A folha tinge a LINHA, e numa linha emparelhada as duas
    // metades têm tons opostos — tingi-la diria uma coisa só sobre duas. Aqui o
    // que carrega a mudança é a POSIÇÃO (esquerda = como era, direita = como
    // fica), o sinal dentro da célula e o hachurado onde não havia linha; cor
    // nunca é a única pista (WCAG 1.4.1).
    const side = (s) => {
      const empty = s.tone === "empty";
      const sign = s.tone === "add" ? "+" : s.tone === "del" ? "−" : "";
      return `<span class="rvnum${empty ? " rvhatch" : ""}">${num(s.num)}</span>` +
        `<span class="rvtxt${empty ? " rvhatch" : ""}">` +
        (sign ? `<span class="rvsign">${sign}</span> ` : "") + esc(s.text) + `</span>`;
    };
    return `<div class="rvrow split">${side(r.left)}${side(r.right)}</div>`;
  }).join("") +
    // O corte é DITO, e tem como continuar. Dizer "… e mais 812 linhas" e parar
    // ali era um beco sem saída no destino que existe para ver as linhas exatas
    // (DESIGN.md §1). Diferente do INTERVALO entre dois pedaços: as linhas do
    // corte já estão na memória, então continuar a leitura é um clique — nada é
    // pedido ao backend, e o teto continua existindo para o cartão não virar o
    // arquivo (DESIGN.md §7).
    (cut > 0
      ? `<div class="rvgap">⋯ ${esc(plural(cut, "… e mais %1 linha", "… e mais %1 linhas"))}` +
        `<button class="plink" data-rvmore="${esc(path)}">${t("mostrar mais linhas")}</button></div>`
      : "");
}

// "como era / como fica" em texto. Fica fora de changeCardHtml porque o cartão
// abre por <details>, e um cartão que abre vazio e só se preenche na próxima
// passada do poll é a tela sem resposta ao clique (DESIGN.md §1): quem abre o
// cartão insere o resumo na hora, com esta mesma função.
function plainBitsHtml(file) {
  return RV.plainBits(file).map((b) => {
    const label = b.whole
      ? (b.kind === "after" ? t("documento novo") : t("documento removido"))
      : (b.kind === "after" ? t("como fica") : t("como era"));
    // o resumo é resumo: a leitura completa é o diff, que tem controle próprio
    // (DESIGN.md §7 — nada cresce sem limite dentro do cartão)
    const lines = String(b.text).split("\n");
    const shown = lines.slice(0, BIT_LINES).join("\n");
    const rest = lines.length - BIT_LINES;
    return `<div class="rvbit ${b.kind === "after" ? "after" : "before"}">` +
      `<span class="rvlabel">${label}</span>${esc(shown)}` +
      (rest > 0 ? `\n${esc(plural(rest, "… e mais %1 linha", "… e mais %1 linhas"))}` : "") + `</div>`;
  }).join("");
}

// Abrir/fechar um cartão: o estado é guardado (o próximo repintar respeita) E o
// resumo entra na árvore agora.
//
// `files` é A LISTA QUE DESENHOU os cartões, e é parâmetro de propósito. Antes o
// caminho era resolvido contra as duas listas globais em ordem fixa (a árvore de
// trabalho primeiro, a revisão aberta depois); as duas são chaveadas pelo mesmo
// caminho do acervo, então um revisor com edição local no documento que a
// proposta também muda abria o cartão da proposta e lia o SEU texto como "como
// fica", com o diff verdadeiro logo abaixo (DESIGN.md §1: o estado nunca mente).
function wireCardToggle(root, files) {
  root.querySelectorAll("[data-rvcard]").forEach((d) => (d.ontoggle = () => {
    const p = d.dataset.rvcard;
    if (d.open) REV.openCard.add(p); else REV.openCard.delete(p);
    REV.sig = "";
    const box = d.querySelector(".rvbits");
    const file = RV.fileAt(files, p);
    if (d.open && box && file && !box.querySelector(".rvbit")) {
      box.insertAdjacentHTML("afterbegin", plainBitsHtml(file));
    }
  }));
}

// O CONTROLE que carregou o desfecho deixa de existir no repintar: os três
// controles do cartão («marcar como visto», «ver a mudança completa» e o seletor de
// diff) refazem a lista inteira, então o foco caía no <body> e o Tab recomeçava no
// resumo do cartão — para quem usa teclado ou leitor de tela os três não davam
// retorno nenhum (WCAG 2.4.3 + 4.1.3). O mesmo padrão do leaveOverlay: guarda quem
// era, repinta, devolve. `said` é uma função porque a frase depende do estado DEPOIS
// do repintar.
function repaintFocused(attr, val, repaint, said) {
  repaint();
  for (const n of document.querySelectorAll(`[${attr}]`)) {
    if (n.getAttribute(attr) !== val) continue;
    try { n.focus(); } catch (_) {}
    break;
  }
  if (said) announce(said());
}

// Continuar a leitura de um diff cortado. Mesma ligação nas duas listas que
// desenham cartões, uma função só: o teto sobe UM passo por clique, e é o mesmo
// passo que o desenho usa.
function wireDiffMore(root, repaint) {
  root.querySelectorAll("[data-rvmore]").forEach((b) => (b.onclick = () => {
    const p = b.dataset.rvmore;
    REV.rowsMore.set(p, (REV.rowsMore.get(p) || DIFF_ROWS_MAX) + DIFF_ROWS_MAX);
    REV.sig = "";
    repaint();
  }));
}

// `scope` é a LISTA a que este cartão pertence («now» = árvore de trabalho,
// «pr:<n>» = uma revisão aberta). As duas falam os mesmos caminhos, e a marca de
// «visto» é do conteúdo lido naquela lista (review.js::changeId).
function changeCardHtml(file, scope) {
  const c = RV.classifyFile(file);
  const badge = changeBadge(c.status);
  const open = REV.openCard.has(c.path);
  const diffOpen = REV.openDiff.has(c.path);
  const seen = REV.viewed.has(RV.changeId(file, scope));
  // um documento novo (ou removido) não tem "trechos": ele é o trecho, e o
  // contador só repetiria o que o distintivo já disse
  const runs = c.changedRuns && (c.status === "modified" || c.status === "renamed")
    ? ` · ${plural(c.changedRuns, "%1 trecho mudou", "%1 trechos mudaram")}`
    : "";
  const counts = c.binary
    ? t("não dá para mostrar as linhas deste arquivo")
    : `+${c.additions} −${c.deletions}${runs}`;
  // O texto entra na árvore só quando o cartão ABRE. Um <details> fechado guarda
  // o conteúdo no DOM de qualquer forma, e um documento novo é UM trecho com o
  // arquivo inteiro dentro: num projeto que ainda não salvou nada, isso são 25
  // arquivos completos em HTML antes de a pessoa clicar em nada.
  const bits = open ? plainBitsHtml(file) : "";
  // aria-pressed é ESCRITO aqui, não espelhado: paintAriaState observa mutações de
  // classe de nós que já existem, e estes nascem de innerHTML — escapavam do
  // espelho por construção, e a seleção ficava só na cor (WCAG 1.4.1/4.1.2).
  // Os três controles do cartão se repetem UMA VEZ POR DOCUMENTO mudado, e o
  // rótulo visível deles é o mesmo em todos: sem o documento no nome acessível, um
  // leitor de tela ouve «marcar como visto» N vezes sem nada que as ligue a um
  // documento (WCAG 2.4.6). O que identifica é o CAMINHO, não o nome do arquivo:
  // todo conhecimento se chama `context.md`, então dois cartões teriam o mesmo nome
  // acessível (é o que o resumo visível resolve mostrando o nome E a pasta). O
  // rótulo visível continua sendo o começo do nome acessível (2.5.3) — a mesma
  // regra de «responder — <endereço>» e «ver a verificação ↗ — <nome>».
  const seg = diffOpen
    ? `<div class="segrow" role="group" aria-label="${esc(t("como mostrar a mudança"))} — ${esc(c.path)}">` +
      `<button class="segbtn${REV.mode === "unified" ? " on" : ""}" data-rvmode="unified"` +
      ` aria-pressed="${REV.mode === "unified"}">${t("unificado")}</button>` +
      `<button class="segbtn${REV.mode === "split" ? " on" : ""}" data-rvmode="split"` +
      ` aria-pressed="${REV.mode === "split"}">${t("lado a lado")}</button></div>`
    : "";
  const verLabel = diffOpen ? t("esconder a mudança completa") : t("ver a mudança completa");
  const vistoLabel = seen ? t("✓ visto") : t("marcar como visto");
  const acts = `<div class="revacts">` +
    (c.binary ? "" : `<button class="plink" data-rvfull="${esc(c.path)}" aria-expanded="${diffOpen}"` +
      ` aria-label="${esc(verLabel)} — ${esc(c.path)}">${verLabel}</button>`) +
    seg +
    `<button class="mini act" data-rvseen="${esc(c.path)}" aria-pressed="${seen}"` +
    ` aria-label="${esc(vistoLabel)} — ${esc(c.path)}">${vistoLabel}</button></div>`;
  return `<details class="revcard"${open ? " open" : ""} data-rvcard="${esc(c.path)}">` +
    `<summary class="revsum"><span class="badge ${badge.cls}">${badge.label}</span>` +
    `<span class="rvname">${esc(c.name)}</span><span class="rvpath">${esc(c.dir)}</span>` +
    `<span class="rvmeta">${esc(counts)}</span></summary>` +
    `<div class="rvbits">${bits}${acts}</div>` +
    (diffOpen ? `<div class="rvdiff">${diffRowsHtml(file)}</div>` : "") +
    `</details>`;
}

// A faixa de F11: você está com o rascunho de OUTRA pessoa na frente, e a tela
// diz de quem é a mudança e como voltar.
function paintEditBanner() {
  const bar = $("revEditBanner"), msg = $("revEditMsg");
  if (!bar) return;
  // `p.mine` NÃO existe no PrInfo que o gh devolve, então `!p.mine` era sempre
  // verdadeiro e o seu PRÓPRIO rascunho recebia a frase escrita para o de outra
  // pessoa («você está editando o rascunho…»). Quem é o autor se decide pela mesma
  // regra do resto da tela, uma vez, em review.js.
  const pr = RV.openReviewFor(REV.prs, REV.branch, { me: reviewMe() });
  // sem a conta lida, «você está editando o rascunho de outra pessoa» é um palpite
  const alheio = !!pr && !pr.mine && !!reviewMe();
  bar.hidden = !alheio;
  if (!alheio || !msg) return;
  msg.textContent = t(
    "você está editando o rascunho «%1» — mudança #%2 em revisão. O que você vê é a mudança inteira contra o conhecimento oficial; salvar versão atualiza a revisão aberta.",
    [draftNameFromBranch(REV.branch, REV.def) || REV.branch, pr.number]
  );
}

function renderMyChanges() {
  const list = $("revChanges"), empty = $("revEmpty");
  if (!list || !empty) return;
  paintEditBanner();
  const files = REV.changes || [];
  // R36 · o DISCO não é o editor: uma aba com texto que ainda não foi salvo fica
  // FORA da versão, e esta tela dizia «tudo salvo» com o ● da aba dois centímetros
  // acima. A mesma soma que a linha do tempo do painel já fazia.
  const unsaved = dirtyDocs();
  // R48 · o passo seguinte que o estado vazio nomeia depende do que a outra
  // metade sabe: sem isto a frase só trocaria quando a árvore de trabalho mudasse
  // por outro motivo, e o diagnóstico do ambiente chega DEPOIS da primeira pintura
  const sig = JSON.stringify([REV.changesErr, REV.mode, REV.branch, teamBlockCode(),
    files.map((f) => [f.path, f.kind, f.additions, f.deletions, f.binary]),
    unsaved.map((d) => d.rel),
    [...REV.openCard], [...REV.openDiff], [...REV.viewed], [...REV.rowsMore]]);
  if (sig === REV.sig) return;   // o poll de 10s não pode fechar um cartão aberto
  REV.sig = sig;
  // R43 · quem tem o teclado agora, para o repintar não o perder (WCAG 2.4.3)
  const mark = focusMarkIn(list);
  paintUnsavedDocs(unsaved, files.length);

  const title = $("revEmptyTitle"), note = $("revEmptyMsg"), go = $("revEmptyGo");
  const slug = draftSlugFromBranch(REV.branch, REV.def);
  paintLoading("revNowLoading", false);
  const showEmpty = (b, hint, action) => {
    list.innerHTML = "";
    empty.hidden = false;
    title.textContent = b;
    note.textContent = hint;
    go.hidden = !action;
    // uma porta que age sobre UM documento diz qual, no nome acessível — e o nome
    // do documento anterior não fica atrás de um botão escondido (DESIGN.md §9)
    if (action && action.name) go.setAttribute("aria-label", `${action.label} — ${action.name}`);
    else go.removeAttribute("aria-label");
    if (action) { go.textContent = action.label; go.onclick = action.run; }
    // WCAG 4.1.3 · o estado desta metade troca sozinho (o poll relê a árvore) e
    // «tentar de novo» pode repintar o MESMO erro: sem a região viva do app,
    // apertar a única porta da tela não produzia pixel novo nem anúncio. E fala
    // só a metade que está na tela (announceRev): as duas se pintam na mesma passada.
    announceRev("now", hint ? `${b} — ${hint}` : b);
  };

  if (REV.changesErr === "err.git_repo_required") {
    showEmpty(t("sem versões ainda"),
      t("este projeto ainda não guarda versões — salve a primeira para que o time possa revisar."), null);
  } else if (REV.changesErr) {
    // a porta é o handler, não o rótulo: e ela carrega o pendente, senão apertar
    // não tem estado nenhum enquanto o git responde
    showEmpty(t("não consegui ler as mudanças agora"), tErr(REV.changesErr),
      { label: t("tentar de novo"), run: () => withPending(go, () => refreshMyChanges()) });
  } else if (REV.changes === null) {
    // era um estado vazio com o título «um momento…»: um <b> parado, sem dizer que
    // a tela está trabalhando nem anunciar isso a quem não a vê
    list.innerHTML = "";
    empty.hidden = true;
    paintLoading("revNowLoading", true, t("lendo o que você mudou…"));
    return;
  } else if (!files.length && unsaved.length) {
    // A tela responde «o que você mudou» — e há mudança, só não no arquivo. Dizer
    // «tudo salvo» aqui era mentir e orientar o passo errado (enviar para revisão o
    // que ainda não existe); o passo seguinte é a aba do documento.
    showEmpty(t("mudanças não salvas"),
      t("texto não salvo em %1 — a mudança aparece aqui depois de salvar.",
        [unsaved.map((d) => d.title).join(", ")]),
      { label: t("abrir o documento"), run: () => activateTab(unsaved[0].id), name: unsaved[0].title });
  } else if (!files.length) {
    // O PASSO SEGUINTE TEM DE EXISTIR. «Envie para revisão quando quiser que o
    // time leia» era a única porta nomeada por este estado, e duas frases abaixo
    // — no MESMO cartão, na mesma passada de pintura — a tela dizia «o time ainda
    // não está conectado» com o botão de enviar desabilitado. O mesmo
    // teamBlockCode() que paintTeamGate lê responde antes do clique
    // (DESIGN.md §1: todo estado vazio orienta o passo seguinte, e a interface
    // não sabe nada que não diz).
    const block = teamBlockCode();
    const remedy = !!slug && !!block && block !== "err.github_unreachable";
    showEmpty(t("tudo salvo"),
      !slug ? t("nada mudou desde a última versão salva.")
        : !block ? t("a versão está guardada no rascunho «%1». Envie para revisão quando quiser que o time leia.", [slug])
          : block === "err.github_unreachable"
            ? t("a versão está guardada no rascunho «%1». Sem conexão agora — envie para revisão quando a rede voltar.", [slug])
            : t("a versão está guardada no rascunho «%1». Para o time ler, conecte o GitHub em Configurações.", [slug]),
      remedy ? { label: t("abrir Configurações"), run: openCfgGit } : null);
  } else {
    empty.hidden = true;
    const { seen, total } = RV.viewedCount(files, REV.viewed, "now");
    // o contador é a metade da máquina desta linha, então vai num <span> mono
    // próprio: pedir hint e mono no MESMO elemento pinta --sans com o espaçamento do
    // mono (as duas regras têm a mesma especificidade e .hint vem depois, com o
    // atalho `font:`) — a metade errada da regra sobrevivia (DESIGN.md §3)
    list.innerHTML = `<p class="hint"><span class="mono">${esc(t("%1 de %2 vistos", [seen, total]))}</span></p>` +
      files.map((f) => changeCardHtml(f, "now")).join("");
    wireCardToggle(list, files);
    wireDiffMore(list, renderMyChanges);
    const vistos = () => {
      const c = RV.viewedCount(REV.changes || [], REV.viewed, "now");
      return t("%1 de %2 vistos", [c.seen, c.total]);
    };
    // WCAG 4.1.2 · chegar ao destino com mudança na tela também é um estado: sem
    // isto a metade cheia era a única que não falava, e o silêncio dela era o que
    // deixava a região viva com a frase da metade escondida.
    announceRev("now", plural(files.length, "%1 documento mudado", "%1 documentos mudados"));
    list.querySelectorAll("[data-rvfull]").forEach((b) => (b.onclick = () => {
      const p = b.dataset.rvfull;
      // ver a mudança completa mantém o cartão ABERTO: um diff desenhado dentro
      // de um cartão fechado é um controle cujo efeito não se vê
      if (REV.openDiff.has(p)) REV.openDiff.delete(p); else { REV.openDiff.add(p); REV.openCard.add(p); }
      repaintFocused("data-rvfull", p, renderMyChanges);
    }));
    list.querySelectorAll("[data-rvmode]").forEach((b) => (b.onclick = () => {
      REV.mode = b.dataset.rvmode;
      repaintFocused("data-rvmode", b.dataset.rvmode, renderMyChanges);
      if (REV.openNum) renderReviewDetail(REV.openNum);
    }));
    list.querySelectorAll("[data-rvseen]").forEach((b) => (b.onclick = () => {
      const p = b.dataset.rvseen;
      // a marca é da MUDANÇA, não do caminho: senão ela sobrevive à versão salva e
      // um diff que ninguém abriu chega marcado como lido
      const id = RV.changeId(RV.fileAt(files, p), "now");
      if (REV.viewed.has(id)) REV.viewed.delete(id); else REV.viewed.add(id);
      repaintFocused("data-rvseen", p, renderMyChanges, vistos);
    }));
    restoreFocusMark(list, mark);
  }
  // O contador da aba é o número de documentos mudados — a verdade DESTA
  // metade, com UM pintor (o da outra metade é refreshNotifications, que lê
  // brain_notifications). Sem isto o distintivo do HTML seria cromo morto: um
  // "0" que ninguém escreve (DESIGN.md §9).
  const nowBadge = $("revNowBadge");
  if (nowBadge) { nowBadge.textContent = files.length; nowBadge.hidden = !files.length; }
  // "Salvar versão" sem nada mudado é um controle que não faz nada: o estado
  // vazio logo acima já diz por quê (o mesmo par do queueGenCtx).
  const save = $("revSaveBtn");
  if (save) {
    const none = !REV.changesErr && Array.isArray(REV.changes) && !files.length;
    save.disabled = none;
    save.title = none ? t("tudo salvo") : "";
  }
}

async function refreshMyChanges() {
  if (!reviewOn()) return;
  try {
    const info = await invoke("git_branches");
    REV.branch = (info && info.current) || ""; REV.def = (info && info.default) || "main";
  } catch (_) { /* sem repositório: brain_git_diff diz o mesmo, com código */ }
  try {
    REV.changes = await invoke("brain_git_diff", { rel: null });
    REV.changesErr = "";
  } catch (e) {
    REV.changes = []; REV.changesErr = String(e);
  }
  REV.sig = "";
  paintReviewDraft();
  renderMyChanges();
}

// D4 · o campo está ao lado do que ele descreve, então o botão grava direto. O
// preço ("guarda o projeto inteiro") está escrito acima dele, antes do clique.
// Não substitui promptVersionar(): aquele é a rota POR DOCUMENTO, onde as
// mudanças não estão na tela.
async function saveVersionFromReview() {
  const field = $("revMsg");
  const message = ((field && field.value) || "").trim();
  if (!message) { toast(t("descreva a mudança em uma linha antes de salvar")); if (field) field.focus(); return; }
  const draft = await currentDraftSlug();
  // O nome do rascunho que nasce daqui é o que a tela DISSE antes do clique
  // (paintReviewDraft), pela mesma regra de 24 letras da folha «Novo rascunho».
  // A descrição crua ia como slug: o backend a corta em 50 caracteres e faz
  // `checkout -b rfc/<frase>`, então uma frase de uma linha virava um rascunho
  // que ninguém nomeou — e o usuário saía do lugar em que estava, em silêncio.
  const slug = draft || draftSlugify(message);
  let r;
  try {
    r = await invoke("brain_version", { slug, message });
  } catch (e) {
    // R10 · um código estável se traduz; o inglês cru do git não é mensagem que
    // o produto escreveu. Sem esta captura a promessa rejeitada morria no
    // console e a tela não dizia nada (DESIGN.md §1).
    const code = String(e);
    toast(code.startsWith("err.") ? tErr(code) : t("não consegui salvar a versão agora"), 6000);
    clog("brain_version error: " + (code.startsWith("err.") ? code : "opaque"));
    return;
  }
  // N3 · o resultado voltava e era descartado: com a árvore limpa o backend não
  // salvava nada e a tela anunciava "versão salva" mesmo assim.
  if (!r || !r.saved) { toast(t("nada mudou desde a última versão — nenhuma versão foi criada")); return; }
  if (field) field.value = "";
  const landed = draftNameFromBranch(r.branch, REV.def) || slug;
  // TRÊS DESFECHOS, TRÊS FRASES. Salvar num rascunho em revisão empurra a versão,
  // e o commit é local: se o empurrão não chegou, dizer «revisão atualizada» seria
  // mentira, e dizer só «versão salva» esconderia que o time não a viu.
  toast(
    r.review && r.pushed
      ? t("versão salva no rascunho «%1» — a revisão #%2 foi atualizada.", [landed, r.review])
      : r.review
        ? t("versão salva neste computador — a revisão #%1 recebe a atualização quando a rede voltar.", [r.review])
        : t("a versão está guardada no rascunho «%1». Envie para revisão quando quiser que o time leia.", [landed]),
    6000
  );
  if (r.warn) toast(tErr(r.warn), 5000);
  brainRefresh();
  refreshMyChanges();
}

/* ---- 1g.2 · o que o TIME propôs ----------------------------------------- */

const prWhen = (iso) => (iso ? new Date(iso).toLocaleDateString(uiLocale(), { day: "2-digit", month: "short" }) : "");

// STATES only (review.js::prChips): os contadores viram a linha de prosa da
// linha, porque quatro objetos numa linha são dois a mais do que ela precisa.
function chipHtml(chip) {
  const label = chipLabel(chip);
  const cls = chip.tone === "ok" ? "ok" : chip.tone === "danger" ? "warn" : "warn2";
  return label ? `<span class="badge ${cls}">${esc(label)}</span>` : "";
}
// O RÓTULO SOZINHO. A linha da lista precisa do texto para o nome acessível (o
// chip é pixel; quem ouve a linha tem de ouvir o estado — WCAG 4.1.2), e o
// detalhe precisa do HTML. Uma tabela, duas saídas.
function chipLabel(chip) {
  return {
    checks: chip.values.state === "ok" ? t("✓ verificações ok")
      : chip.values.state === "fail" ? t("✗ verificações falharam") : t("verificações em curso"),
    changes: t("mudanças pedidas"),
    conflict: t("conflita com o oficial"),
    ready: t("pronta para entrar"),
    approvedByMe: t("você aprovou ✓"),
    merged: t("entrou no oficial ✓"),
    stale: t("aprovação de versão anterior"),
    approved: t("aprovada"),
  }[chip.key] || "";
}

function teamRowHtml(p, forMe) {
  const num = esc(String(p.number || ""));
  const who = (p.author && p.author.login) || "";
  const draft = draftNameFromBranch(p.headRefName, REV.def);
  const line = forMe ? t("%1 pediu a sua revisão", [who])
    : p.mine ? t("sua mudança") : t("proposta de %1", [who]);
  // A LINHA DIZ SE ESTÁ BLOQUEADA. Ela rolava o seu próprio chip a partir do
  // reviewDecision e mais nada, então uma mudança com verificação falhando ou em
  // conflito com o oficial aparecia igual a uma pronta — e é essa a pergunta que
  // «Revisões do time» existe para responder de relance. A regra é a de review.js,
  // e os rótulos são os do MESMO chipHtml do detalhe.
  const chipsList = RV.listChips(p);
  const chips = chipsList.map(chipHtml).join("");
  const estado = chipsList.map((c) => chipLabel(c)).filter(Boolean).join(" · ");
  const meta = `${line} · ${t("rascunho «%1» → conhecimento oficial", [draft])}` +
    (p.updatedAt ? " · " + prWhen(p.updatedAt) : "");
  // O nome acessível carrega o número, o assunto, o ESTADO e a linha de meta: um
  // aria-label na linha inteira SUBSTITUÍA o conteúdo dela, e a única coisa que
  // esta superfície existe para dizer — de quem é a vez — ficava só em pixels
  // (WCAG 4.1.2/2.4.6). E quem abre é um <button> de verdade: o ⧉ copiar link
  // morava DENTRO de um div[role=button], e o ARIA dá filhos apresentacionais a um
  // role=button — a exposição do botão de dentro fica indefinida. Dois irmãos.
  return `<div class="revcard revrow">` +
    `<button class="rvopen" data-prdetail="${num}"` +
    ` aria-label="${t("abrir a revisão")} #${num} — ${esc(p.title || "")}` +
    `${estado ? " · " + esc(estado) : ""} · ${esc(meta)}">` +
    `<span class="rvtitle">#${num} ${esc(p.title || "")}</span></button>${chips}` +
    `<button class="mini act" data-prurl="${num}" aria-label="${t("copiar link")} #${num}">⧉ ${t("copiar link")}</button>` +
    `<span class="rvsub">${esc(meta)}</span></div>`;
}

// A IDADE DO QUE ESTÁ NA TELA, dita. Uma lista que veio do cache é verdadeira
// sobre o passado e pode ser falsa sobre agora, então ela não pode passar por
// leitura de agora (DESIGN.md §1 — o estado nunca mente). Sem rede é outro fato e
// outra frase: aquela lista não vai ser revalidada até a rede voltar.
function paintReviewAge(total) {
  const el = $("revAge");
  if (!el) return;
  const mostrar = !!total && !REV.prsFresh && !teamBlockCode();
  el.hidden = !mostrar;
  if (!mostrar) return;
  el.textContent = REV.prsStale
    ? t("sem conexão agora — esta lista é a última leitura feita. Ela atualiza sozinha quando a rede voltar.")
    : t("esta é a leitura anterior — buscando as revisões de agora…");
}

// «AINDA NÃO CARREGUEI» É UM TERCEIRO FATO. `REV.prs || []` colapsava «nunca
// carregou» (null) com «carregou e não há nenhuma» ([]), então na primeira entrada a
// tela dizia «nada aqui ainda — nenhuma revisão aberta ainda» por ~1,7s enquanto
// ainda buscava: o estado mentia, e o passo que ela orientava era enviar uma
// mudança que talvez já estivesse lá.
//
// O indicador é o do chat («pensando…»): três pontos, rótulo em mono, embrulho de
// prefers-reduced-motion, e o texto vai para o nó role=status — quem não vê a tela
// ouve que ela está trabalhando (WCAG 4.1.3), do mesmo jeito.
//
// Loader e rótulo de idade são MUTUAMENTE EXCLUSIVOS por construção: o loader diz
// «não tenho nada», o rótulo diz «tenho, mas não é de agora».
function paintLoading(id, on, label) {
  const el = $(id);
  if (!el) return !!on;
  el.hidden = !on;
  el.innerHTML = on
    ? `<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>` +
      `<span class="lbl">${esc(label || t("um momento…"))}</span>`
    : "";
  return !!on;
}

function renderTeamReviews() {
  const forMeBox = $("revForMe"), mineBox = $("revMine"), empty = $("revTeamEmpty");
  if (!forMeBox || !mineBox || !empty) return;
  const me = (envDoctor && envDoctor.account) || "";
  const { forMe, mine } = RV.groupReviews(REV.prs || [], { me });
  const sig = JSON.stringify([REV.prsErr, REV.prsStale, REV.prsFresh, me,
    (REV.prs || []).map((p) => [p.number, p.title, p.reviewDecision, p.updatedAt])]);
  if (sig === REV.teamSig) return;
  REV.teamSig = sig;

  const list = $("revList");
  const total = forMe.length + mine.length;
  // nunca carregou E não há bloqueio a declarar: está buscando
  const carregando = REV.prs === null && !REV.prsErr && !teamBlockCode();
  paintLoading("revTeamLoading", carregando, t("buscando as revisões do time…"));
  paintReviewAge(total);
  const title = $("revTeamEmptyTitle"), note = $("revTeamEmptyMsg"), go = $("revTeamEmptyGo");
  const block = teamBlockCode();
  forMeBox.innerHTML = forMe.map((p) => teamRowHtml(p, true)).join("");
  mineBox.innerHTML = mine.map((p) => teamRowHtml(p, false)).join("");
  for (const s of (list ? list.querySelectorAll(".revgroup") : [])) {
    s.hidden = !total || !(s.contains(forMeBox) ? forMe.length : mine.length);
  }
  empty.hidden = !!total || carregando;
  if (!total && !carregando) {
    if (block === "err.github_unreachable") {
      title.textContent = t("sem conexão");
      note.textContent = t("sem conexão agora — esta lista é a última leitura feita. Ela atualiza sozinha quando a rede voltar.");
      go.hidden = true;
    } else if (block) {
      title.textContent = t("nada aqui ainda");
      note.textContent = t("o time ainda não está conectado — conecte o GitHub em Configurações para enviar e receber revisões.");
      go.hidden = false;
      go.textContent = t("abrir Configurações");
      go.onclick = openCfgGit;
    } else if (REV.prsErr) {
      // ARCHITECTURE §4 · o inglês cru do gh NÃO é uma mensagem que o produto
      // escreveu. `gh_pr_list` é anterior ao contrato de códigos estáveis e
      // devolve o stderr do gh: sem este ramo, a tela mostrava "To get started
      // with GitHub CLI, please run: gh auth login" em inglês, no meio de uma
      // tela em português. Um código estável se traduz; prosa de subprocesso,
      // não — e aí o remédio é o diagnóstico, que é uma tela deste app.
      const code = REV.prsErr.startsWith("err.");
      title.textContent = t("não consegui ler as revisões agora");
      // Descartar o inglês cru do gh é certo; não escrever NADA no lugar é a
      // interface sabendo algo que não diz — o app sabe que a leitura falhou e
      // sabe onde está o diagnóstico, então essa é a frase (DESIGN.md §1).
      note.textContent = code ? tErr(REV.prsErr)
        : t("o Loro não conseguiu falar com o GitHub agora — o diagnóstico em Configurações diz o que falta.");
      go.hidden = false;
      go.textContent = code ? t("tentar de novo") : t("ver o que falta em Configurações");
      go.onclick = code ? () => withPending(go, () => refreshTeamReviews()) : openCfgGit;
    } else {
      title.textContent = t("nada aqui ainda");
      note.textContent = t("nenhuma revisão aberta ainda — envie uma mudança para revisão do time.");
      go.hidden = true;
    }
    // WCAG 4.1.3 · este texto troca sem a pessoa mexer em nada (a leitura do gh
    // volta quando a rede volta, e «tentar de novo» repinta o mesmo erro): sem a
    // região viva do app ele existe só em pixels. E fala só quando é ELE que está
    // na tela: as duas metades se pintam na mesma passada (R38).
    announceRev("team", `${title.textContent} — ${note.textContent}`);
  }
  const wire = (box) => {
    box.querySelectorAll("[data-prdetail]").forEach((row) => {
      // um <button> de verdade: Enter/Espaço e o papel vêm do elemento, e o ⧉
      // copiar link é irmão dele — nada de controle dentro de controle
      row.onclick = () => openReview(Number(row.dataset.prdetail));
    });
    box.querySelectorAll("[data-prurl]").forEach((b) => (b.onclick = () => {
      const p = (REV.prs || []).find((x) => String(x.number) === b.dataset.prurl);
      if (p && p.url) copyProposalUrl(p.url);
    }));
  };
  wire(forMeBox); wire(mineBox);
}

// CACHE-THEN-REVALIDATE. Ler o remote custa ~1,7s, e o destino esperava essa ida
// à rede ANTES de desenhar qualquer coisa: entrar em «Revisões do time» era uma
// tela vazia por um segundo e meio. Agora a lista que já se conhece vai para a
// tela na hora, a revalidação acontece atrás, e a tela repinta se o remote
// discordar. O que a idade da leitura NÃO pode fazer é ficar escondida — quem lê
// precisa saber que está vendo a leitura anterior (DESIGN.md §1), e é o backend
// que diz a idade junto com os dados.
async function refreshTeamReviews() {
  // gastar um processo do gh e uma ida à rede por um destino que ninguém está
  // olhando é desperdício puro — a mesma regra do brain_knowledge_graph.
  if (!reviewOn()) return;
  if (teamBlockCode()) { REV.teamSig = ""; renderTeamReviews(); return; }
  // o que já se sabe, imediatamente: sem isto a primeira pintura espera a rede
  if (REV.prs && REV.prs.length) { REV.prsFresh = false; REV.teamSig = ""; renderTeamReviews(); }
  try {
    const read = await invoke("gh_pr_list");
    REV.prs = read.prs;
    // ageMs === 0 é a leitura que ACABOU de sair da rede; qualquer coisa acima
    // disso veio do cache e a tela tem de dizer isso
    REV.prsFresh = !read.ageMs;
    REV.prsErr = ""; REV.prsStale = false;
  } catch (e) {
    // a última leitura continua na tela, dita como o que é
    REV.prsErr = String(e); REV.prsStale = !!(REV.prs && REV.prs.length); REV.prsFresh = false;
  }
  REV.teamSig = "";
  renderTeamReviews();
  renderMyChanges();   // a faixa de F11 depende de saber os rascunhos em revisão
}

/* ---- 1g.3 · uma revisão aberta, lida dentro do Loro --------------------- */

// A vista trocou: o teclado vai com ela. Sem isto o foco caía no <body>, e como
// #revOpen vem DEPOIS de #revList no DOM, a lista à qual a pessoa acabou de voltar
// ficava atrás do ponto de partida do Tab — só Shift+Tab ou o mouse chegavam nela
// (WCAG 2.4.3). O padrão é o do enterOverlay/leaveOverlay, aplicado a uma troca de
// vista dentro do destino.
function backToReviewList() {
  const era = REV.openNum;
  REV.openNum = 0; REV.detail = null; REV.detailDiff = null; REV.detailErr = "";
  const list = $("revList"), open = $("revOpen");
  if (list) list.hidden = false;
  if (open) open.hidden = true;
  REV.teamSig = "";
  renderTeamReviews();
  // o foco volta para A LINHA que foi aberta (ela acabou de ser redesenhada)
  const row = era && list && list.querySelector(`[data-prdetail="${era}"]`);
  if (row) { try { row.focus(); } catch (_) {} }
  else { const tab = document.querySelector('#revTabs [data-revtab="team"]'); if (tab) tab.focus(); }
}

function openReview(number) {
  REV.openNum = number;
  REV.detail = null; REV.detailDiff = null; REV.detailErr = "";
  const list = $("revList"), open = $("revOpen");
  if (list) list.hidden = true;
  if (open) open.hidden = false;
  renderReviewDetail(number);
  loadReviewDetail(number);
  // o primeiro controle da revisão aberta é o que a fecha: o foco entra por ele, e
  // o leitor de tela ouve que a vista trocou em vez de ficar sem nada focado
  const back = $("revBack");
  if (back) { try { back.focus(); } catch (_) {} }
  announce(t("revisão #%1 aberta", [number]));
}

async function loadReviewDetail(number) {
  if (!reviewOn()) return;
  // As duas leituras são INDEPENDENTES e eram seriais: `gh pr view` (~1,7s) e só
  // então `gh pr diff` (~2,0s), 3,7s antes de a revisão aparecer. Nada no diff
  // decide o que pedir na descrição, então elas saem juntas e a espera passa a ser
  // a da mais lenta. allSettled porque o texto da revisão vale sem o diff — quem
  // falha é o diff, e a tela ainda tem o que ler.
  const [det, dif] = await Promise.allSettled([
    invoke("gh_pr_detail", { number }),
    invoke("gh_pr_diff", { number }),
  ]);
  if (det.status === "fulfilled") {
    REV.detail = det.value; REV.detailErr = "";
  } else {
    REV.detail = null; REV.detailErr = String(det.reason);
  }
  REV.detailDiff = dif.status === "fulfilled" ? dif.value : [];
  if (REV.openNum === number) renderReviewDetail(number);
}

function decisionHtml(pr, st) {
  const need = st.approvals.need || 1;
  const draft = draftNameFromBranch(pr.headRefName, REV.def);
  const waiting = (pr.reviewRequests || []).map((r) => r.login || r.slug || r.name).filter(Boolean).join(", ");
  const author = (pr.author && pr.author.login) || "";
  if (st.merged) {
    return `<p class="pmnote">${esc(t("✓ entrou no conhecimento oficial — o rascunho «%1» foi encerrado.", [draft]))}</p>`;
  }
  if (st.canMerge) {
    return `<h3 class="rvhead">${t("Sua revisão")}</h3>` +
      `<p class="hint">${esc(t("%1 de %1 aprovações · verificações ok. Juntar cria a versão no conhecimento oficial e encerra o rascunho «%2».", [st.approvals.have, draft]))}</p>` +
      `<div class="revacts"><button class="btn solid" data-prmerge>${t("Juntar ao conhecimento oficial")}</button></div>`;
  }
  if (st.canDecide) {
    const failing = st.checks === "fail"
      ? `<p class="hint">${t("as verificações ainda falham — mesmo aprovada, a mudança só entra quando elas passarem.")}</p>` : "";
    // POR QUE A REVISÃO VOLTOU. Uma decisão minha pode vencer (o autor salvou
    // outra versão) ou ser pedida de novo: o bloco oferecia o ESTADO antigo
    // («você aprovou») sem controle nenhum, numa linha que a própria lista tinha
    // filado em «Aguardam a sua revisão» — e a frase que o acompanhava prometia
    // uma entrada que o GitHub não vai contar (DESIGN.md §1: o estado nunca
    // mente; F8 tem de fechar).
    const back = (st.stale && st.decided === "approved"
      ? `<p class="pmnote">${t("a sua aprovação era de uma versão anterior: uma nova versão foi salva depois dela, e ela não conta mais.")}</p>`
      : st.stale && st.decided === "changes_requested"
        ? `<p class="pmnote">${t("o seu pedido de mudanças era de uma versão anterior: uma nova versão foi salva depois dele.")}</p>`
        : "") +
      (st.askedAgain && st.decided
        ? `<p class="pmnote">${esc(t("%1 pediu a sua revisão de novo.", [author || t("alguém do time")]))}</p>` : "");
    return `<h3 class="rvhead">${t("Sua revisão")}</h3>` + back +
      `<label class="wfield stack"><span>${t("um comentário para o time (opcional)")}</span>` +
      `<input id="revDecisionMsg" type="text" /></label>` +
      `<p class="hint">${esc(t("aprovar conta como uma das %1 aprovações que a mudança precisa para entrar no conhecimento oficial.", [need]))}</p>` +
      failing +
      `<div class="revacts"><button class="btn solid" data-praction="approve">${t("✓ Aprovar")}</button>` +
      `<button class="btn" data-praction="request_changes">${t("pedir mudanças")}</button>` +
      `<button class="btn" data-praction="comment">${t("só comentar")}</button></div>`;
  }
  if (st.decided === "approved") {
    return `<p class="pmnote"><b>${t("você aprovou")}</b></p>` +
      `<p class="hint">${t("a mudança entra no conhecimento oficial quando todas as aprovações chegarem.")}</p>`;
  }
  if (st.blocked === "conflict") {
    return `<p class="hint">${t("o conhecimento oficial andou desde que você enviou — esta mudança conflita com ele. Resolva as diferenças no terminal ou no GitHub; nada se perde.")}</p>`;
  }
  if (st.blocked === "changes") {
    const who = (pr.reviews || []).filter((r) => r.state === "CHANGES_REQUESTED").map((r) => r.author)[0] || "";
    // QUEM ESTÁ LENDO. O bloco era byte a byte o mesmo para os dois papéis: o
    // revisor lia o próprio login em terceira pessoa («ana pediu mudanças») e
    // recebia o remédio do AUTOR — salvar uma nova versão num rascunho que não é
    // dele. O app sabe as duas coisas (st.decided diz que o pedido é meu, st.mine
    // diz que o rascunho é meu).
    return `<p class="pmnote"><b>${st.decided === "changes_requested"
      ? esc(t("você pediu mudanças"))
      : esc(t("%1 pediu mudanças", [who]))}</b></p>` +
      `<p class="hint">${st.mine
        ? t("responda na conversa, salve uma nova versão no rascunho e peça nova revisão — a mudança não entra no oficial enquanto o pedido estiver aberto.")
        : esc(t("a mudança não entra no oficial enquanto o pedido estiver aberto — %1 responde na conversa e salva uma nova versão, e você é avisado aqui quando pedirem a sua revisão de novo.",
          [author || t("alguém do time")]))}</p>`;
  }
  if (st.mine) {
    return `<p class="hint">${esc(t("esta mudança é sua — falta a aprovação de %1. Você será avisado aqui quando alguém revisar.", [waiting || t("alguém do time")]))}</p>`;
  }
  return `<p class="hint">${t("nova revisão pedida")}</p>`;
}

// ONDE a conversa acontece — o endereço que a distingue das outras da mesma
// revisão. Uma função porque a linha, o nome do botão e a folha da resposta dizem a
// mesma coisa, e três cópias divergem.
function threadWhere(th) {
  return th && th.path ? `${th.path}${th.line ? ":" + th.line : ""}` : "";
}

// O QUE O AUTOR ESCREVEU, como ele escreveu. A descrição de uma revisão e cada
// comentário da conversa são markdown — é o que o modelo do time pede e o que o
// GitHub guarda: títulos, listas, tabelas, ênfase, bloco de código. As duas
// superfícies escapavam o texto e o despejavam cru, então `**assim**`, `> assim`
// e uma tabela chegavam à tela como sintaxe da máquina, na metade da tela cuja
// única função é ser LIDA (DESIGN.md §5 — a sintaxe da máquina não chega à
// superfície; ADR-0018 — a análise é a saída do produto). O mesmo mdRender do
// leitor de documentos, com as mesmas opções, para que uma ligação e um
// localizador sejam marcados aqui como são lá.
function reviewProse(src) {
  return mdRender(String(src === null || src === undefined ? "" : src), docOpts());
}
function reviewProseHtml(pr) {
  return (pr.sections || []).length
    ? pr.sections.map((s) => `<div class="rvbits"><span class="rvlabel">${esc(s.label)}</span>` +
      `<div class="rvbit rvprose">${reviewProse(s.text)}</div></div>`).join("")
    : `<div class="rvbits"><div class="rvbit rvprose">` +
      (pr.body ? reviewProse(pr.body) : esc(t("sem descrição"))) + `</div></div>`;
}

// O GitHub guarda uma sugestão de mudança como uma cerca ```suggestion dentro do
// comentário. A ADR afirmava «a sugestão é renderizada só-leitura» e isso nunca
// existiu: a cerca chegava como bloco de código sem nome, indistinguível de
// qualquer outro. Aplicar a sugestão continua fora (não há primitivo do gh, e
// adivinhar um patch sobre conhecimento é destrutivo — ADR-0027 item 3), mas ela ao
// menos se apresenta pelo que é, com a saída dita.
function suggestionHtml(body) {
  const m = /```suggestion\r?\n([\s\S]*?)```/.exec(String(body || ""));
  if (!m) return "";
  return `<div class="rvsug"><span class="rvlabel">${esc(t("sugestão de mudança"))}</span>` +
    `<pre>${esc(m[1].replace(/\s+$/, ""))}</pre>` +
    `<p class="hint">${esc(t("aplicar uma sugestão acontece no GitHub — o Loro não reescreve o seu conhecimento por adivinhação."))}</p></div>`;
}

function threadHtml(th) {
  const comments = (th.comments || []).map((c) =>
    `<div class="rvbit"><span class="rvlabel">${esc(c.author || "")} · ${esc(prWhen(c.when))}</span>` +
    `<div class="rvprose">${reviewProse(String(c.body || "").replace(/```suggestion\r?\n[\s\S]*?```/, ""))}</div>` +
    suggestionHtml(c.body) + `</div>`
  ).join("");
  const where = threadWhere(th);
  return `<div class="revcard"><div class="revrow">` +
    `<span class="rvtitle">${esc(where)}</span>` +
    (th.resolved ? `<span class="badge ok">${t("resolvida ✓")}</span>` : "") +
    (th.outdated ? `<span class="badge warn2">${t("aprovação de versão anterior")}</span>` : "") +
    `</div>` +
    (th.excerpt ? `<div class="rvdiff">${th.excerpt.split("\n").map((l) =>
      `<div class="rvrow uni"><span class="rvnum"></span><span class="rvnum"></span>` +
      `<span class="rvsign"></span><span class="rvtxt">${esc(l)}</span></div>`).join("")}</div>` : "") +
    `<div class="rvbits">${comments}` +
    // «responder» repetido em N conversas não diz A QUAL (WCAG 2.4.6): o nome
    // acessível carrega o endereço da conversa, e o rótulo visível é o começo dele
    `<div class="revacts"><button class="plink" data-prreply="${th.id}"` +
    ` aria-label="${t("responder")} — ${esc(where || t("a conversa da revisão"))}">${t("responder")}</button>` +
    `</div></div></div>`;
}

// O que está bloqueando, COM NOME. A lista de verificações chegava inteira do
// backend (git.rs::CheckRun tem nome e endereço) e a tela a dobrava numa palavra
// só: o revisor era avisado de que a mudança não entra e não tinha como saber por
// qual verificação, nem onde vê-la — a interface sabendo algo que não diz
// (DESIGN.md §1). A saída de cada linha é a MESMA porta do app (openProposalUrl).
function checksHtml(pr) {
  const bad = RV.failingChecks((pr || {}).checks);
  if (!bad.length) return "";
  // O título já diz o estado do grupo: repetir um distintivo em cada linha são N
  // objetos que não dizem nada de novo (DESIGN.md §7).
  return `<h3 class="rvhead">${t("Verificações que falharam")}</h3>` +
    bad.map((c, i) => {
      const name = c.name || t("verificação sem nome");
      return `<div class="revcard"><div class="revrow">` +
        `<span class="rvtitle">${esc(name)}</span>` +
        // "ver a verificação" repetido em N linhas não diz QUAL (WCAG 2.4.6), e o
        // rótulo visível é o começo do nome acessível (2.5.3)
        (c.url ? `<button class="mini act" data-prcheck="${i}"` +
          ` aria-label="${esc(t("ver a verificação ↗"))} — ${esc(name)}">${t("ver a verificação ↗")}</button>` : "") +
        `</div></div>`;
    }).join("");
}

function renderReviewDetail(number) {
  const head = $("revPrHead"), body = $("revPrBody"), files = $("revPrFiles"),
    dec = $("revPrDecision"), threads = $("revPrThreads"), checks = $("revPrChecks");
  if (!head) return;
  const pr = REV.detail;
  if (!pr) {
    if (checks) checks.innerHTML = "";
    // ABRIR UMA REVISÃO SÃO ~2s DE REDE, e a espera era a palavra «um momento…»
    // colada no número, sem dizer que a tela está trabalhando e sem anunciar isso a
    // quem não a vê. Mesmo indicador das duas listas e do chat.
    head.innerHTML = REV.detailErr
      ? `<span class="rvtitle">#${esc(String(number))}</span>` +
        `<span class="badge warn">${esc(tErr(REV.detailErr))}</span>`
      : `<span class="rvtitle">#${esc(String(number))}</span>` +
        `<p class="rvloading" role="status" aria-live="polite">` +
        `<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>` +
        `<span class="lbl">${esc(t("lendo a revisão…"))}</span></p>`;
    body.innerHTML = ""; files.innerHTML = ""; threads.innerHTML = "";
    // Uma revisão que não abre ainda tem saída: o endereço existe na lista.
    const known = (REV.prs || []).find((p) => p.number === number);
    dec.innerHTML = REV.detailErr && known && known.url
      ? `<div class="revacts"><button class="btn" data-propen="${esc(known.url)}">${t("abrir no GitHub ↗")}</button></div>`
      : "";
    dec.querySelectorAll("[data-propen]").forEach((b) => (b.onclick = () => openProposalUrl(b.dataset.propen)));
    return;
  }
  const me = (envDoctor && envDoctor.account) || "";
  const st = RV.reviewState(pr, { me });
  const chips = RV.prChips(pr, { me }).map(chipHtml).join("");
  const draft = draftNameFromBranch(pr.headRefName, REV.def);
  // R42 · a revisão aberta é o ITEM da tela: sem cabeçalho próprio, o h1 continuava
  // «Revisão», as seções dela eram h2 e a navegação por cabeçalhos lia três seções
  // de um item que nada nomeava (WCAG 1.3.1/2.4.6).
  head.innerHTML = `<h2 class="rvtitle">#${esc(String(pr.number))} ${esc(pr.title || "")}</h2>${chips}` +
    `<span class="rvsub">${esc(t("rascunho «%1» → conhecimento oficial", [draft]))} · ` +
    `${esc(t("%1 de %2 aprovações", [st.approvals.have, st.approvals.need]))}` +
    `${st.comments ? " · " + esc(plural(st.comments, "%1 comentário", "%1 comentários")) : ""}</span>` +
    `<div class="revacts">` +
    `<button class="mini act" data-prurl2 aria-label="${t("copiar link")} #${esc(String(pr.number))}">⧉ ${t("copiar link")}</button>` +
    `<button class="mini act" data-propen>${t("abrir no GitHub ↗")}</button>` +
    (pr.headRefName && pr.headRefName !== REV.branch
      ? `<button class="mini act" data-predit>${t("⎇ abrir para editar")}</button>` : "") +
    `</div>`;
  body.innerHTML = reviewProseHtml(pr);
  if (checks) {
    checks.innerHTML = checksHtml(pr);
    const bad = RV.failingChecks(pr.checks);
    checks.querySelectorAll("[data-prcheck]").forEach((b) =>
      (b.onclick = () => openProposalUrl((bad[Number(b.dataset.prcheck)] || {}).url)));
  }
  const fl = REV.detailDiff || [];
  files.innerHTML = `<h3 class="rvhead">${t("O que muda")}</h3>` +
    (fl.length ? fl.map((f) => changeCardHtml(f, `pr:${number}`)).join("")
      : `<p class="hint">${(pr.files || []).map((f) => esc(f.path)).join(", ") || t("um momento…")}</p>`);
  wireCardToggle(files, fl);
  wireDiffMore(files, () => renderReviewDetail(number));
  const repinta = () => renderReviewDetail(number);
  const vistosPr = () => {
    const c = RV.viewedCount(REV.detailDiff || [], REV.viewed, `pr:${number}`);
    return t("%1 de %2 vistos", [c.seen, c.total]);
  };
  files.querySelectorAll("[data-rvfull]").forEach((b) => (b.onclick = () => {
    const p = b.dataset.rvfull;
    if (REV.openDiff.has(p)) REV.openDiff.delete(p); else { REV.openDiff.add(p); REV.openCard.add(p); }
    repaintFocused("data-rvfull", p, repinta);
  }));
  files.querySelectorAll("[data-rvmode]").forEach((b) => (b.onclick = () => {
    REV.mode = b.dataset.rvmode; REV.sig = "";
    repaintFocused("data-rvmode", b.dataset.rvmode, repinta);
    renderMyChanges();
  }));
  files.querySelectorAll("[data-rvseen]").forEach((b) => (b.onclick = () => {
    const p = b.dataset.rvseen;
    // a marca é da mudança DESTA revisão: a árvore de trabalho fala os mesmos
    // caminhos, e uma marca compartilhada atravessaria de uma lista para a outra
    const id = RV.changeId(RV.fileAt(REV.detailDiff || [], p), `pr:${number}`);
    if (REV.viewed.has(id)) REV.viewed.delete(id); else REV.viewed.add(id);
    repaintFocused("data-rvseen", p, repinta, vistosPr);
  }));
  dec.innerHTML = decisionHtml(pr, st);
  threads.innerHTML = (pr.threads || []).length
    ? `<h3 class="rvhead">${t("Conversa")}</h3>` + pr.threads.map(threadHtml).join("")
    : "";
  wireReviewDetail(pr, st);
}

function wireReviewDetail(pr, st) {
  const head = $("revPrHead"), dec = $("revPrDecision"), threads = $("revPrThreads");
  head.querySelectorAll("[data-prurl2]").forEach((b) => (b.onclick = () => copyProposalUrl(pr.url)));
  head.querySelectorAll("[data-propen]").forEach((b) => (b.onclick = () => openProposalUrl(pr.url)));
  head.querySelectorAll("[data-predit]").forEach((b) => (b.onclick = () => openForEditing(pr)));
  dec.querySelectorAll("[data-praction]").forEach((b) => (b.onclick = () => sendReviewDecision(b, pr, b.dataset.praction)));
  dec.querySelectorAll("[data-prmerge]").forEach((b) => (b.onclick = () => mergeReview(b, pr, st)));
  threads.querySelectorAll("[data-prreply]").forEach((b) =>
    (b.onclick = () => promptReply(pr, threadOf(pr, Number(b.dataset.prreply)))));
}

async function sendReviewDecision(btn, pr, action) {
  const field = $("revDecisionMsg");
  const body = ((field && field.value) || "").trim();
  if (action === "request_changes" && !body) { toast(t("escreva o que precisa mudar antes de pedir mudanças")); if (field) field.focus(); return; }
  if (action === "comment" && !body) { toast(t("escreva o comentário primeiro")); if (field) field.focus(); return; }
  await withPending(btn, async () => {
    try {
      await invoke("gh_pr_review", { number: pr.number, action, body });
    } catch (e) {
      toast(tErr(String(e)), 5000);
      return;
    }
    const who = (pr.author && pr.author.login) || "";
    toast(action === "approve" ? t("revisão registrada — %1 será avisado", [who])
      : action === "request_changes" ? t("pedido de mudanças enviado") : t("comentário enviado"));
    await loadReviewDetail(pr.number);
    maybeRefreshNotifications(true);
  });
}

async function mergeReview(btn, pr, st) {
  await withPending(btn, async () => {
    try {
      await invoke("gh_pr_merge", { number: pr.number, headRef: pr.headRefName || "" });
    } catch (e) { toast(tErr(String(e)), 6000); return; }
    toast(t("mudança entrou no conhecimento oficial ✓"), 6000);
    // gh troca de rascunho para apagar o antigo: o que está na tela mudou
    await loadReviewDetail(pr.number);
    brainRefresh();
    refreshMyChanges();
    refreshTeamReviews();
    maybeRefreshNotifications(true);
  });
}

// A folha da resposta DIZ a qual conversa ela responde: o título era «sua
// resposta», o campo era «sua resposta» e nada na tela — nem na árvore de
// acessibilidade — dizia de qual das conversas se tratava, então dava para postar
// na errada (WCAG 2.4.6; DESIGN.md §1: o estado nunca mente). O trecho citado é a
// mesma marca que a conversa mostra na lista.
function threadOf(pr, id) {
  return (((pr && pr.threads) || []).find((x) => Number(x.id) === id)) || { id };
}
function promptReply(pr, th) {
  const where = threadWhere(th);
  const autor = ((th.comments || [])[0] || {}).author || "";
  openModal(
    where ? t("responder a %1", [where]) : t("sua resposta"),
    (autor ? `<p class="pmnote">${esc(t("%1 escreveu nesta conversa", [autor]))}</p>` : "") +
      (th.excerpt ? `<div class="rvbit before">${esc(String(th.excerpt).split("\n").slice(0, 3).join("\n"))}</div>` : "") +
      `<label class="wfield stack"><span>${t("sua resposta")}</span>` +
      `<input id="revReplyMsg" type="text" /></label>`,
    t("enviar"),
    async () => {
      const body = (($("revReplyMsg") && $("revReplyMsg").value) || "").trim();
      if (!body) { toast(t("escreva a resposta primeiro")); return; }
      // o erro SOBE: a folha fica aberta com o texto digitado e o motivo dentro
      // dela, em vez de fechar e virar um toast que expira (R17)
      await invoke("gh_pr_reply", { number: pr.number, commentId: th.id, body });
      toast(t("resposta enviada"));
      loadReviewDetail(pr.number);
    }
  );
}

// F11 · abrir o rascunho de outra pessoa passa pelo MESMO preço de qualquer
// troca de rascunho — e guarda de onde viemos, para "voltar ao meu rascunho"
// não ser um botão que adivinha.
async function openForEditing(pr) {
  let info;
  try { info = await invoke("git_branches"); } catch (e) { toast(tErr(String(e))); return; }
  const target = pr.headRefName;
  const stand = (info.branches || []).find((b) => b.name === target);
  if (!stand) { toast(t("este rascunho ainda não está neste computador — abra no GitHub")); return; }
  REV.cameFrom = info.current || "";
  const price = switchPrice(stand, info.current, info.default);
  const land = () => { goDest("review", "now"); refreshMyChanges(); };
  if (price) { confirmSwitchBranch(target, price); land(); return; }
  try { afterSwitch(await invoke("git_switch_branch", { branch: target }), null, info.default); land(); }
  catch (e) { toast(tErr(String(e)), 5000); }
}

async function backToMyDraft() {
  if (!REV.cameFrom) return openBranchPicker();
  try { afterSwitch(await invoke("git_switch_branch", { branch: REV.cameFrom }), null, REV.def); REV.cameFrom = ""; refreshMyChanges(); }
  catch (e) { toast(tErr(String(e)), 5000); }
}

/* ---- o destino inteiro --------------------------------------------------- */

function renderDestReview() {
  paintReviewIntro();
  paintTeamGate();
  paintReviewDraft();
  renderMyChanges();
  renderTeamReviews();
}

function refreshReview() {
  if (!reviewOn()) return;
  paintReviewIntro();
  paintTeamGate();
  refreshMyChanges();
  refreshTeamReviews();
  maybeRefreshNotifications(true);
}

// ============================ produção: modal genérico (ADR-0009) ============================
// One reusable confirm sheet drives the promotion picker and the migration
// preview: a title, an HTML body the caller may wire, and a confirm handler.
const PM = {
  wrap: $("pmWrap"), title: $("pmTitle"), body: $("pmBody"),
  confirm: $("pmConfirm"), cancel: $("pmCancel"), close: $("pmClose"),
  err: $("pmErr"), errMsg: $("pmErrMsg"), errGo: $("pmErrGo"),
};
// R17 · o motivo de um confirmar que falhou, DENTRO da folha. Achado no app
// rodando: enviar para revisão sem o gh autenticado fechava a folha, apagava os
// sete campos digitados e o único aviso do erro expirava com o toast — a tela
// voltava a ser exatamente o que era antes da tentativa. Quando o app SABE o
// remédio (é o ambiente do time que falta), ele é um botão — o mesmo da recusa
// prévia de F5, não uma segunda regra.
function pmError(code) {
  if (!PM.err) return;
  const c = String(code || "");
  PM.err.hidden = !c;
  if (PM.errGo) PM.errGo.hidden = true;
  if (!c) return;
  // tErr traduz um código estável e devolve o próprio texto quando não é um: um
  // msgid lançado pelo handler já é mensagem escrita pelo produto
  const msg = tErr(c);
  PM.errMsg.textContent = msg;
  if (PM.errGo && ENV_REMEDY.includes(c)) PM.errGo.hidden = false;
  announce(msg);
}
let pmOnConfirm = null;
let pmOnDismiss = null;
// Which sheet is on screen. A confirm handler may open the NEXT sheet while the
// first one is still awaiting (the branch picker does); the counter is how the
// pending state knows the sheet it belongs to is gone and must not be touched.
let pmGen = 0;
// A sheet can be dismissed five ways (confirmar, cancelar, ×, Escape, clique
// fora). Quem ESPERA uma resposta da folha precisa ser avisado por TODAS elas:
// pickMeeting resolvia só nos cliques de cancelar/×, então Escape e o clique fora
// deixavam a promessa pendente para sempre e o ● Gravar ficava travado em
// "iniciando…", desabilitado, até reiniciar o app. O aviso mora aqui, no fechador
// único, e não em cada caminho de saída.
function openModal(title, bodyHtml, confirmLabel, onConfirm, onDismiss) {
  pmGen++;
  // R41 · UMA FOLHA QUE SUBSTITUI OUTRA («＋ novo rascunho…» dentro da folha dos
  // rascunhos, «configurar o modelo» dentro da do envio) troca o título e o corpo
  // com a camada já na pilha: enterOverlay volta na hora e o innerHTML abaixo
  // destrói justamente o nó que tinha o foco, então o teclado ficava no <body> e
  // nada dizia que o diálogo mudou de nome (WCAG 2.4.3/4.1.2).
  const trocada = !PM.wrap.hidden;
  PM.title.textContent = title;
  PM.body.innerHTML = bodyHtml;
  PM.confirm.textContent = confirmLabel || t("confirmar");
  PM.confirm.hidden = !onConfirm;
  // a sheet reused right after a pending confirm must not inherit its state
  PM.confirm.disabled = false;
  PM.confirm.removeAttribute("aria-busy");
  pmOnConfirm = onConfirm || null;
  pmOnDismiss = onDismiss || null;
  pmError("");   // uma folha nova não herda o erro da anterior
  PM.wrap.hidden = false;
  // o foco entra na folha: o primeiro campo do corpo, ou o confirmar
  const first = () => PM.body.querySelector("input, select, textarea, button")
    || (PM.confirm.hidden ? PM.close : PM.confirm);
  enterOverlay(PM.wrap, first, closeModal);
  if (trocada) {
    const n = first();
    if (n) { try { n.focus(); } catch (_) {} }
    announce(title);   // o diálogo é OUTRO: quem não vê a tela ouve o nome novo
  }
  return PM.body;
}
function closeModal() {
  const dismissed = pmOnDismiss;
  PM.wrap.hidden = true;
  pmError("");   // o motivo morre com a folha que o mostrou
  pmOnConfirm = null;
  pmOnDismiss = null;
  leaveOverlay(PM.wrap);
  if (dismissed) dismissed();
}
PM.close.addEventListener("click", closeModal);
PM.cancel.addEventListener("click", closeModal);
// a folha NÃO fecha: arrumar o que falta em Configurações e voltar encontra os
// campos como estavam, e o confirmar continua armado
if (PM.errGo) PM.errGo.addEventListener("click", () => openCfgGit());
PM.wrap.addEventListener("click", (e) => { if (e.target === PM.wrap) closeModal(); });
PM.confirm.addEventListener("click", async () => {
  if (!pmOnConfirm) return closeModal();
  // confirmar NÃO é desistir: o onConfirm é que vai responder a quem espera
  const dismissed = pmOnDismiss;
  pmOnDismiss = null;
  // N8 · the sheet used to vanish BEFORE the await: "salvar versão" runs a
  // `git fetch` that can take ~10s, and the screen said nothing at all in the
  // meantime. The primary action carries the pending state, and the sheet only
  // closes once the work it started has an outcome (DESIGN.md §1: every action
  // has feedback). `gen` is the sheet this click belongs to — a handler that
  // opened the next sheet has already replaced both the label and the state.
  const fn = pmOnConfirm;
  const gen = pmGen;
  const label = PM.confirm.textContent;
  pmOnConfirm = null;
  PM.confirm.disabled = true;
  PM.confirm.setAttribute("aria-busy", "true");
  PM.confirm.textContent = t("um momento…");
  let failed = "";
  try { await fn(); }
  catch (e) {
    // Um STRING lançado é mensagem escrita pelo produto — o idioma do app: o
    // `invoke` rejeita com o código err.* do backend, e um handler recusa lançando
    // o próprio msgid. Um Error é maquinaria, e ninguém lê stack numa folha.
    failed = typeof e === "string" && e ? e : t("não deu para concluir agora");
    // BR-8 · um erro opaco pode carregar caminho ou conteúdo: só o código vai ao log
    clog("modal confirm error: " + (failed.startsWith("err.") ? failed : "opaque"));
  }
  finally {
    if (gen === pmGen) {
      PM.confirm.disabled = false;
      PM.confirm.removeAttribute("aria-busy");
      PM.confirm.textContent = label;
      // R17 · uma folha que FALHOU fica na tela. Fechá-la apagava os campos que a
      // pessoa acabou de escrever e o motivo saía junto, com o toast: a tela
      // voltava a ser a de antes da tentativa, sem registro dela (DESIGN.md §1 —
      // todo caminho de falha deixa uma saída). Ela volta armada, e quem espera a
      // folha continua sendo avisado por qualquer uma das cinco saídas.
      if (failed) {
        pmOnConfirm = fn;
        pmOnDismiss = dismissed;
        pmError(failed);
      } else closeModal();
    }
  }
});

// drop a tab's cached editor/buffer so the next render re-reads it from disk
// (brain_promote stamps the source file's front-matter without moving it).
function refreshTabFromDisk(rel) {
  const tab = ws.tabs.find((t) => t.rel === rel);
  if (!tab) return;
  disposeTabState(tab.id);
  if (ws.activeId === tab.id) renderActive();
}

// ---- novo tema / novo caderno ----
// Inline create, mirroring promptNewContext (the contextos "system pattern").
let bsEditing = false;
function promptNewTema() {
  if (bsEditing) return;
  bsEditing = true;
  const inp = document.createElement("input");
  inp.className = "bnewctx";
  inp.placeholder = t("nome da ideia (Enter) · ex.: frota 2026");
  B.navPessoal.before(inp); inp.focus();
  const done = () => { inp.remove(); bsEditing = false; };
  inp.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") return done();
    if (e.key !== "Enter") return;
    const nome = inp.value.trim();
    if (!nome) return done();
    try {
      const r = await invoke("brain_create_brainstorm", { input: { nome } });
      done(); pessoalSig = ""; refreshPessoal();
      if (r && r.rel) openTopicDoc(r.rel, { preview: false });
    } catch (err) { toast(tErr(String(err))); }
  });
  inp.addEventListener("blur", done);
}
function promptNewNotebook() {
  openEditor(t("Novo caderno — título (linha 1) · tema opcional (linha 2)"), "", async (v) => {
    const [titulo, tema] = (v || "").split("\n").map((s) => s.trim());
    if (!titulo) throw t("informe um título");
    const rel = await invoke("brain_new_notebook", { tema: tema || null, titulo });
    toast(t("caderno criado"));
    pessoalSig = ""; refreshPessoal();
    if (rel) openDoc(rel, { preview: false });
  });
}

// ---- promoção guiada (não destrutiva): destino + prévia → promover → propor ----
// The preview is derived from the source's front-matter refs (deny-list applied
// client-side for display only); the actual copy/rewrite/merge runs in Rust.
function promotionPreview(fm) {
  const refs = (fm && Array.isArray(fm.refs)) ? fm.refs : [];
  const audio = (fm && Array.isArray(fm.audio)) ? fm.audio : [];
  const out = [];
  for (const r of refs) {
    if (!r || typeof r !== "object") continue;
    const tipo = r.tipo || (R.tipoFromExt ? R.tipoFromExt(r.caminho || "") : "other");
    const name = String(r.caminho || "").split("/").pop() || String(r.caminho || "");
    out.push(tipo === "audio" ? `${t("áudio")}: ${name} → ${t("referência em texto (stub)")}` : `${tipo}: ${name} → referencias/${name}`);
  }
  for (const a of audio) {
    if (!a || typeof a !== "object") continue;
    out.push(`${t("áudio")}: ${String(a.caminho || "").split("/").pop() || a.caminho} → ${t("referência em texto (stub)")}`);
  }
  return out;
}
async function startPromotion(sourceRel) {
  if (!sourceRel) { toast(t("abra um caderno pessoal para juntar a um conhecimento")); return; }
  if (!sourceRel.startsWith("pessoal/")) { toast(t("só um item pessoal pode ser juntado a um conhecimento")); return; }
  const ctxs = lastSt ? lastSt.contexts.map((c) => c.name) : [];
  if (!ctxs.length) { toast(t("crie um tema de conhecimento primeiro")); return; }
  // pre-read the source front-matter for the preview (best-effort)
  let fm = null;
  try {
    const raw = await readDoc(sourceRel);
    const split = R.splitFrontMatter(raw);
    if (split.frontMatter != null) fm = R.parseFrontMatter(split.frontMatter);
  } catch (_) { fm = null; }
  const previewItems = promotionPreview(fm);
  const preview = previewItems.length
    ? previewItems.map((l) => "• " + esc(l)).join("<br>")
    : t("sem anexos — apenas o texto será mesclado no conhecimento");
  const opts = ctxs.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  const html =
    `<p class="pmnote">${t("não destrutivo — o original permanece no seu espaço pessoal (rascunho). Áudio nunca é copiado; vira referência em texto.")}</p>` +
    `<label class="pmfield"><span class="mono">${t("de")}</span><span class="mono pmsrc">${esc(sourceRel)}</span></label>` +
    `<label class="pmfield"><span class="mono">${t("destino")}</span><select id="pmDest" class="mini-select">${opts}</select></label>` +
    `<div class="pmphead">${t("o que será juntado ao conhecimento do tema:")}</div>` +
    `<div class="pmpreview">${preview}</div>`;
  openModal(t("Juntar a um conhecimento"), html, t("juntar"), async () => {
    const destContext = $("pmDest").value;
    const r = await invoke("brain_promote", { sourceRel, destContext, mode: "merge" });
    toast(`${t("juntado ao conhecimento")} → ${destContext}`);
    refreshTabFromDisk(sourceRel);
    sideSig = ""; pessoalSig = ""; brainRefresh(); refreshPessoal();
    offerPropose(r, destContext);
  });
}
// after a promotion, offer to version+propose right away (existing ADR-0004 flow)
function offerPropose(r, destContext) {
  const files = (r && r.stagedFiles) || [];
  const entry = r && r.changelogEntry ? `<div class="pmphead">CHANGELOG: ${esc(String(r.changelogEntry))}</div>` : "";
  const html =
    `<p class="pmnote">${t("juntado ao conhecimento")} <b>${esc(destContext)}</b> — ${t("nenhuma versão foi salva ainda — nada foi destruído.")}</p>` +
    `<div class="pmpreview">${files.length ? files.map((f) => "• " + esc(f)).join("<br>") : t("context.md atualizado")}</div>${entry}`;
  openModal(t("Mudança pronta"), html, t("salvar versão agora"), async () => { B.gitBtn.click(); });
}

// ---- migrar acervo (simulação → aplicar) — estende brain_migrate (ADR-0004/0009) ----
function migrationBodyHtml(rep) {
  // As chaves são as que o MigrationReport serializa. A versão anterior lia
  // `moves`/`planned`/`movimentos` — nenhuma existe — então a simulação dizia
  // sempre "nada a migrar" e o usuário confirmava no escuro uma operação que
  // renomeia a árvore inteira (DESIGN.md §1: a interface não pode esconder o que sabe).
  const lines = ["renamedWorld", "incubated", "renamed", "conflicts", "legacyIdeas", "scaffolding"]
    .flatMap((k) => (Array.isArray(rep && rep[k]) ? rep[k] : []))
    .map((m) => (typeof m === "string" ? m : `${m.from || "?"} → ${m.to || "?"}`));
  const preview = lines.length ? lines.map((l) => "• " + esc(l)).join("<br>") : t("nada a migrar");
  return `<p class="pmnote">${t("simulação — nada é movido ainda · notas/ permanece versionado · incubadora/ vira tema pessoal")}</p>` +
    `<div class="pmpreview">${preview}</div>`;
}
async function runMigration() {
  let rep;
  try { rep = await invoke("brain_migrate", { apply: false }); }
  catch (e) { toast(t("falha ao planejar migração")); clog("migrate error: " + e); return; }
  openModal(t("Migrar projeto (simulação)"), migrationBodyHtml(rep), t("aplicar migração"), async () => {
    await invoke("brain_migrate", { apply: true });
    toast(t("migração aplicada"));
    sideSig = ""; pessoalSig = ""; brainRefresh(); refreshPessoal();
  });
}

// first-edit note dismiss
$("bDraftClose").addEventListener("click", () => { $("bDraftNote").hidden = true; });

// ---- eventos da produção (ADR-0009) ----
listen("brainstorming-changed", () => { pessoalSig = ""; refreshPessoal(); });
listen("pessoal-changed", () => { pessoalSig = ""; refreshPessoal(); });
listen("tema-changed", () => { pessoalSig = ""; refreshPessoal(); });
listen("promotion-done", (e) => {
  const p = (e && e.payload) || {};
  toast(p.destContext ? `${t("juntado ao conhecimento")} → ${p.destContext}` : t("juntado ao conhecimento"));
  sideSig = ""; pessoalSig = ""; brainRefresh(); refreshPessoal();
  const tb = activeTab(); if (tb && tb.rel !== HOME_REL) renderActive();
});

// GitHub environment doctor: checked once per acervo (network); the wizard card
// and the "propor" button are gated by versioningEnabled. Nothing is stored.
let envDoctor = null, envChecked = false;
async function refreshEnv(force) {
  if (envChecked && !force) return;
  envChecked = true;
  try { envDoctor = await invoke("env_doctor"); }
  catch (_) { envDoctor = null; }
  renderGhCard();
  maybeRefreshNotifications(true);
}
// C9 · a dica de um check chega em DOIS formatos no mesmo campo: um código
// `err.*` estável e uma frase pt-BR (que é o msgid). A tela imprimia o campo
// cru, então a linha que diz o que falta para conectar o GitHub aparecia como
// "err.git_remote_required" e as frases nunca traduziam (CLAUDE.md §6).
function checkHint(hint) {
  const h = String(hint || "");
  if (!h) return "";
  return h.startsWith("err.") ? tErr(h) : t(h);
}
// N4 · a linha do check mostrava `detail || hint`, e detail vencia: para o
// remoto inalcançável o usuário via a URL certa e o MOTIVO ("verifique o acesso")
// era calculado e jogado fora; para git/gh abaixo do piso, detail é a versão, e
// "atualize o git" nunca chegava à tela. Valor e motivo são duas coisas, e a
// interface sabe as duas (DESIGN.md §1).
function checkSay(c) {
  const detail = (c && c.detail) || "";
  const hint = c && !c.ok ? checkHint(c.hint) : "";
  return [detail, hint].filter(Boolean).join(" — ");
}
function renderGhCard() {
  const d = envDoctor;
  // o diagnóstico do ambiente é a fonte do portão da Revisão: quando ele chega (ou
  // muda), a tela que promete a revisão do time é repintada com ele
  paintTeamGate();
  // R48 · o estado vazio de «mudanças de agora» é a SEGUNDA superfície do mesmo
  // fato: o passo seguinte que ele nomeia só existe se a outra metade estiver
  // conectada. Medido no app rodando: o diagnóstico chega DEPOIS da primeira
  // pintura, e sem esta linha o cartão ficava com «Envie para revisão quando quiser
  // que o time leia» duas frases acima de «o time ainda não está conectado».
  renderMyChanges();
  B.proposeBtn.hidden = !(d && d.versioningEnabled);
  // N5 · a porta permanente para a outra metade do fluxo (as revisões abertas)
  const rev = $("pReviewsBtn");
  if (rev) rev.hidden = !(d && d.versioningEnabled);
  renderPanelTeamNote();
  // N6 · o card sumia inteiro quando o gh não estava instalado — exatamente na
  // máquina em que o usuário mais precisa do diagnóstico. Esta seção mora em
  // Configurações (ADR-0020 §7): chegar até ela já é o opt-in, e uma seção que
  // desaparece deixa a promessa da revisão sem remédio nenhum.
  if (!d) { B.ghCard.hidden = true; return; }
  B.ghCard.hidden = false;
  // N6 · sem rede o ambiente não está "local": está configurado e inalcançável.
  B.ghState.textContent = d.versioningEnabled
    ? `${t("conectado")}${d.account ? " · @" + d.account : ""}`
    : (d.offline ? t("sem rede") : "local");
  B.ghState.className = "mono badge " + (d.versioningEnabled ? "ok" : "ro");
  const rows = [
    ["git", d.git, ""], ["gh (GitHub CLI)", d.gh, ""], [t("autenticação"), d.ghAuth, "gh auth login"],
    [t("identidade git"), d.gitIdentity, ""], [t("repositório remoto"), d.remote, ""],
  ];
  B.ghChecks.innerHTML = rows.map(([label, c, cmd]) => {
    const fix = c.fixable && !c.ok ? ` <button class="mini act" data-fix="identity">${t("corrigir")}</button>` : "";
    // N6 · o remédio deste bloqueio era a frase "gh auth login" para o usuário
    // digitar em algum lugar. O app já tem o padrão certo para a mesma classe de
    // falha (o card do chat com "Abrir o Terminal"): o comando roda no terminal
    // embutido, que é onde o login interativo do gh acontece.
    const run = cmd && !c.ok
      ? ` <button class="mini act" data-runterm="${esc(cmd)}">${t("autenticar no Terminal")}</button>` : "";
    // N4 · o único bloqueio que sobra depois de todo mundo autenticar não tinha
    // remédio nenhum — só a palavra "origin" (o remédio de um
    // bloqueio é um botão). Só quando não há repositório nenhum conectado: com
    // um remoto configurado e fora do ar o remédio é a rede voltar.
    const connect = c === d.remote && !c.ok && !c.detail
      ? ` <button class="mini act" data-connect>${t("conectar")}</button>` : "";
    return `<li class="ghchk ${c.ok ? "on" : "off"}"><span>${c.ok ? "✓" : "•"} ${esc(label)}</span>` +
      `<span class="ghhint mono">${esc(checkSay(c))}</span>${fix}${run}${connect}</li>`;
  }).join("");
  B.ghChecks.querySelectorAll("[data-fix]").forEach((b) => (b.onclick = fixIdentity));
  B.ghChecks.querySelectorAll("[data-connect]").forEach((b) => (b.onclick = promptConnectRemote));
  B.ghChecks.querySelectorAll("[data-runterm]").forEach((b) => (b.onclick = () => {
    closeCfg();
    termRun(b.dataset.runterm);
    toast(t("siga o login no Terminal — depois use “verificar”"), 6000);
  }));
}
// N4 · conectar o projeto a um repositório do time é o passo que destrava a
// revisão — e é o único que tira conhecimento desta máquina, então o preço vem
// escrito antes do clique (DESIGN.md §1). O comando roda no terminal embutido,
// onde o gh já faz o login: nenhum token passa pelo app (BR-9).
function promptConnectRemote() {
  openModal(
    t("conectar um repositório do time"),
    `<p class="pmnote">${t("o conhecimento salvo em versões passa a ter uma cópia no GitHub, privada, na sua conta. reuniões, notas e itens para organizar continuam só neste computador.")}</p>`,
    t("conectar no Terminal"),
    () => {
      closeCfg();
      termRun("gh repo create --source . --private --remote origin --push");
      toast(t("siga os passos no Terminal — depois use “verificar”"), 6000);
    }
  );
}
// N3 · o campo vinha PRÉ-PREENCHIDO com "Seu Nome/seu@email" como valor, e a
// checagem era só "não vazio": clicar em salvar gravava "seu@email" como e-mail.
// Exemplo é placeholder; um e-mail que não é e-mail é recusado antes da viagem.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
async function fixIdentity() {
  openModal(
    t("Identidade do git"),
    `<p class="pmnote">${t("é o nome que assina cada versão salva — o time vê isso no histórico.")}</p>` +
      `<label class="wfield"><span class="mono">${t("nome")}</span>` +
      `<input id="gitIdName" type="text" placeholder="${t("ex.: Ana Souza")}" spellcheck="false"></label>` +
      `<label class="wfield"><span class="mono">${t("e-mail")}</span>` +
      `<input id="gitIdEmail" type="text" placeholder="ana@exemplo.com" spellcheck="false"></label>`,
    t("salvar"),
    async () => {
      const name = (($("gitIdName") && $("gitIdName").value) || "").trim();
      const email = (($("gitIdEmail") && $("gitIdEmail").value) || "").trim();
      if (!name || !email) { toast(t("informe nome e e-mail")); return; }
      if (!EMAIL_RE.test(email)) { toast(t("informe um e-mail válido")); return; }
      await invoke("env_set_identity", { name, email });
      toast(t("identidade salva"));
      refreshEnv(true);
    }
  );
}
// N6 · "verificar" subia cinco processos (e ia à rede quando autenticado) e não
// pintava nada: o usuário não tinha como saber que rodou. Um estado pendente
// enquanto roda, uma frase quando termina.
async function ghCheckRun() {
  const btn = B.ghCheck;
  const label = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.classList.add("pending"); btn.textContent = t("verificando…"); }
  announce(t("verificando o ambiente…"));
  try { await refreshEnv(true); }
  finally {
    if (btn) { btn.disabled = false; btn.classList.remove("pending"); btn.textContent = label; }
  }
  const d = envDoctor;
  toast(d && d.versioningEnabled ? t("ambiente verificado — pronto para revisão do time") : t("ambiente verificado — ainda falta algo abaixo"));
}
B.ghCheck.addEventListener("click", ghCheckRun);

// Notificações (colaboração): derivadas dos PRs abertos. Sem GitHub → oculto.
// ADR-0020 §7: o ghCard saiu da home, MAS o aviso não some — realocado para o
// topo de Conhecimento (1c) como uma faixa dispensável.
// N4 · dispensar guardava um flag de SESSÃO: um × calava todo aviso futuro até
// reiniciar o app. Agora a dispensa vale para aquele aviso (a assinatura dos
// contadores); um aviso diferente volta a aparecer.
let notifDismissedSig = "";
let notifCheckedAt = 0;
async function refreshNotifications() {
  const bar = $("ghNotifBar");
  const hide = () => { if (bar) bar.hidden = true; };
  // ADR-0027 · UM pintor para o contador da Revisão. renderHome pinta o contador
  // da fila num laço que passa a um elemento de distância deste; dois pintores
  // para um número é como um contador sobrevive à verdade que o gerou.
  const badge = (n) => {
    for (const id of ["destReviewBadge", "revTeamBadge"]) {
      const b = $(id);
      if (b) { b.textContent = n; b.hidden = !n; }
    }
  };
  if (!envDoctor || !envDoctor.versioningEnabled) { badge(0); return hide(); }
  let n;
  try { n = await invoke("brain_notifications"); } catch (_) { badge(0); return hide(); }
  if (!n.connected) { badge(0); return hide(); }
  // ANTES da dispensa: dispensar a faixa não pode zerar um contador que continua
  // verdadeiro (o × vale para AQUELE aviso, não para o fato).
  badge(n.reviewRequestedToMe.length);
  const parts = [];
  if (n.reviewRequestedToMe.length) parts.push(`⌛ ${n.reviewRequestedToMe.length} ${t("aguardam sua revisão")}`);
  if (n.awaitingApproval.length) parts.push(`${n.awaitingApproval.length} ${t("aguardando aprovação")}`);
  if (n.changesPending.length) parts.push(`${n.changesPending.length} ${t("com ajustes pedidos")}`);
  if (n.recentlyApproved.length) parts.push(`✓ ${n.recentlyApproved.length} ${t("aprovadas")}`);
  const sig = parts.join(" · ");
  if (!sig || sig === notifDismissedSig) return hide();
  B.ghNotif.textContent = sig;
  if (bar) bar.hidden = false;
}
// A faixa era viva só no papel: refreshNotifications só rodava dentro do
// refreshEnv, que se auto-trava por acervo — o contador só mudava ao trocar de
// projeto ou apertar "verificar". `gh` é processo + rede, então o tique é lento.
const NOTIF_EVERY_MS = 120000;
function maybeRefreshNotifications(force) {
  const now = Date.now();
  if (!force && now - notifCheckedAt < NOTIF_EVERY_MS) return;
  notifCheckedAt = now;
  refreshNotifications();
}

// Timeline: navegar versões do conhecimento sem expor commits/hashes/branches.
// Acionada pelo selo de versionamento do documento aberto.
// N8 · era um openEditor: o histórico do time (leitura) abria como CM6 editável,
// com barra de markdown e um "salvar" cheio que DESCARTAVA em silêncio. Uma folha
// de leitura não tem ação primária de escrita.
function showTimeline(rel) {
  invoke("brain_timeline", { rel }).then((items) => {
    const rows = (items || []).map((c) => {
      const when = c.when ? new Date(c.when).toLocaleString(uiLocale(), { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
      return `<div class="fitem2 fstatic"><span class="fn">${esc(when)} — ${esc(c.label || "")}</span>` +
        (c.author ? `<span class="mono muted">${esc(c.author)}</span>` : "") + `</div>`;
    }).join("");
    openModal(
      `${t("Histórico")} — ${rel}`,
      rows || `<p class="pmnote">${t("(sem versões anteriores ainda)")}</p>`,
      null,
      null
    );
  }).catch((e) => { toast(t("sem histórico")); clog("timeline error: " + e); });
}
// N8 · o selo era um <span> com listener: invisível ao teclado e anunciado como
// texto estático, embora seja a única porta para o histórico com o painel fechado.
function openTimelineForCurrent() {
  const rel = currentRel();
  if (rel) showTimeline(rel);
}
B.gitBadge.addEventListener("click", openTimelineForCurrent);
B.gitBadge.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
  e.preventDefault();
  openTimelineForCurrent();
});

// ---- confirmação destrutiva EXPLÍCITA (nada de "confirmar?" escondido) ----
function openConfirmDelete(anchor, name) {
  B.acervoMenu.hidden = true;
  B.bMenu.innerHTML =
    `<div class="fhead">${t("apagar de para organizar")}</div>
     <div class="fitem2 muted fstatic">“${esc(name)}” ${t("não será processado pelo loop")}</div>
     <div class="confirm-actions">
       <button class="btn-danger" data-yes>${t("apagar")}</button>
       <button class="link mono muted" data-no>${t("cancelar")}</button>
     </div>`;
  B.bMenu.querySelector("[data-yes]").onclick = async () => {
    closeFloat();
    try {
      await invoke("brain_delete_inbox", { name });
      toast(t("apagado — não será processado"));
      closeTabsUnder("inbox/" + name, true);
      sideSig = ""; brainRefresh();
    } catch (e) { toast(tErr(String(e))); }
  };
  B.bMenu.querySelector("[data-no]").onclick = closeFloat;
  const r = anchor.getBoundingClientRect();
  B.bMenu.style.left = Math.min(r.left, window.innerWidth - 240) + "px";
  B.bMenu.style.top = r.bottom + 4 + "px";
  B.bMenu.hidden = false;
  wireFloatMenu(B.bMenu, anchor);
}

// ---- menu agrupado do item da fila: mover / apagar ----
function openQueueMenu(anchorEl, name) {
  B.acervoMenu.hidden = true;
  B.bMenu.innerHTML =
    `<div class="fhead">${esc(name)}</div>
     <div class="fitem2" data-a="mv"><span class="fn">⇢ ${t("mover para…")}</span></div>` +
    copyPathItemsHtml() +
    `<div class="fitem2 ditem" data-a="del"><span class="fn">${t("apagar…")}</span></div>`;
  B.bMenu.querySelector('[data-a="mv"]').onclick = () => openMoveMenu(anchorEl, name);
  wireCopyPathItems(`inbox/${name}`);
  B.bMenu.querySelector('[data-a="del"]').onclick = () => openConfirmDelete(anchorEl, name);
  placeMenu(anchorEl);
}

// ---- menu de ações do contexto/pasta: renomear/mover, deletar ----
// O menu é `position: fixed`, então quem o ancora perto de uma borda precisa
// puxá-lo de volta para dentro da janela — abrir pelo chip do chat (canto
// inferior direito do painel) cortava o menu na direita e embaixo.
function placeMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  B.bMenu.hidden = false;
  B.bMenu.style.left = "0px";
  B.bMenu.style.top = "0px";
  const m = B.bMenu.getBoundingClientRect();
  const pad = 10;
  const left = Math.max(pad, Math.min(r.left, window.innerWidth - m.width - pad));
  // abaixo da âncora quando cabe; acima quando não cabe
  const below = r.bottom + 4;
  const top = below + m.height + pad <= window.innerHeight
    ? below
    : Math.max(pad, r.top - m.height - 4);
  B.bMenu.style.left = left + "px";
  B.bMenu.style.top = top + "px";
  // TODOS os 14 menus passam por aqui: é o lugar único onde eles ganham teclado.
  wireFloatMenu(B.bMenu, anchor);
}

// áreas/pastas do projeto (prefixos-pai dos contextos existentes)
function ctxFolders() {
  const set = new Set();
  (lastSt ? lastSt.contexts : []).forEach((c) => {
    const parts = c.name.split("/");
    for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join("/"));
  });
  return [...set].sort();
}
async function ctxMoved(name, newPath) {
  closeFloat(); toast(`${t("movido")} → ${newPath}`);
  bOpen.delete("ctx:" + name);
  closeTabsUnder("contexts/" + name + "/", false);
  sideSig = ""; brainRefresh();
}
function openCtxMenu(anchor, name, isFolder) {
  B.acervoMenu.hidden = true;
  B.bMenu.innerHTML =
    `<div class="fhead">${esc(name)}${isFolder ? ` (${t("pasta")})` : ""}</div>
     <div class="fitem2 strong" data-a="ask"><span class="fn">? ${t("perguntar…")}</span></div>
     <div class="fsep"></div>
     <div class="fitem2" data-a="ren"><span class="fn">✎ ${t("renomear")}</span></div>
     <div class="fitem2" data-a="mv"><span class="fn">⇢ ${t("mover para…")}</span></div>` +
    copyPathItemsHtml() +
    `<div class="fitem2 ditem" data-a="del"><span class="fn">${t("deletar…")}</span></div>`;
  B.bMenu.querySelector('[data-a="ask"]').onclick = () => { closeFloat(); askAcervo(name); };
  B.bMenu.querySelector('[data-a="ren"]').onclick = () => openRenameCtx(anchor, name);
  B.bMenu.querySelector('[data-a="mv"]').onclick = () => openMoveCtxMenu(anchor, name, isFolder);
  wireCopyPathItems(`contexts/${name}`);
  B.bMenu.querySelector('[data-a="del"]').onclick = () => openConfirmDeleteCtx(anchor, name, isFolder);
  placeMenu(anchor);
}

// RENOMEAR: muda só o nome, mantendo a pasta-pai atual
function openRenameCtx(anchor, name) {
  const leaf = name.split("/").pop();
  const parent = name.includes("/") ? name.slice(0, name.lastIndexOf("/") + 1) : "";
  B.bMenu.innerHTML =
    `<div class="fhead">${t("renomear")}</div>
     <input id="renInput" class="bnewctx menuinput" value="${esc(leaf)}" spellcheck="false" />
     <div class="fitem2 muted fstatic">${t("novo nome (mantém a pasta atual)")}</div>`;
  const inp = B.bMenu.querySelector("#renInput");
  inp.focus(); inp.select();
  inp.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") return closeFloat();
    if (e.key !== "Enter") return;
    const to = parent + inp.value.trim();
    try { await invoke("brain_rename_context", { from: name, to }); await ctxMoved(name, to); }
    catch (err) { toast(tErr(String(err))); }
  });
}

// MOVER: para outra pasta do projeto, pasta nova, ou OUTRO projeto
function openMoveCtxMenu(anchor, name, isFolder) {
  const leaf = name.split("/").pop();
  const parent = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
  const folders = ctxFolders().filter((f) => f !== parent && f !== name && !f.startsWith(name + "/"));
  const others = acervos.filter((a) => a.id !== activeAcervo);
  B.bMenu.innerHTML =
    `<div class="fhead">${t("mover")} “${esc(leaf)}”</div>
     <div class="fhead">${t("neste projeto")}</div>` +
    (parent !== "" ? `<div class="fitem2" data-to=""><span class="fn">↥ ${t("raiz")}</span></div>` : "") +
    folders.map((f) => `<div class="fitem2" data-to="${esc(f)}"><span class="fn">→ ${esc(f)}/</span></div>`).join("") +
    `<div class="fitem2" data-newfolder><span class="fn">＋ ${t("nova pasta…")}</span></div>` +
    (others.length ? `<div class="fhead">${t("outro projeto")}</div>` +
      others.map((a) => `<div class="fitem2" data-ac="${esc(a.id)}"><span class="fn">⇢ ${esc(a.name)}</span></div>`).join("") : "");
  const moveTo = async (dest) => {
    const to = dest === "" ? leaf : dest + "/" + leaf;
    try { await invoke("brain_rename_context", { from: name, to }); await ctxMoved(name, to); }
    catch (err) { toast(tErr(String(err))); }
  };
  B.bMenu.querySelectorAll("[data-to]").forEach((el2) => (el2.onclick = () => moveTo(el2.dataset.to)));
  B.bMenu.querySelectorAll("[data-ac]").forEach((el2) => (el2.onclick = async () => {
    void isFolder;
    try { await invoke("brain_move_context_to_acervo", { name, targetId: el2.dataset.ac }); await ctxMoved(name, t("outro projeto")); }
    catch (err) { toast(tErr(String(err))); }
  }));
  const nf = B.bMenu.querySelector("[data-newfolder]");
  if (nf) nf.onclick = () => {
    B.bMenu.innerHTML = `<div class="fhead">${t("mover para nova pasta")}</div>
       <input id="nfInput" class="bnewctx menuinput" placeholder="${t("nome-da-pasta (ex.: operacoes)")}" spellcheck="false" />
       <div class="fitem2 muted fstatic">${t("Enter confirma · vira")} <pasta>/${esc(leaf)}</div>`;
    const inp = B.bMenu.querySelector("#nfInput");
    inp.focus();
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Escape") return closeFloat();
      if (e.key === "Enter" && inp.value.trim()) moveTo(inp.value.trim());
    });
  };
  placeMenu(anchor);
}

// deletar contexto/pasta: destrutivo, com confirmação explícita
function openConfirmDeleteCtx(anchor, name, isFolder) {
  B.bMenu.innerHTML =
    `<div class="fhead">${t("deletar")} ${isFolder ? t("pasta") : t("tema")}</div>
     <div class="fitem2 muted fstatic">“${esc(name)}” ${isFolder ? t("e todos os subtemas serão apagados") : t("será apagado")} ${t("do disco (se o projeto é versionado, o histórico git preserva)")}</div>
     <div class="confirm-actions">
       <button class="btn-danger" data-yes>${t("deletar")}</button>
       <button class="link mono muted" data-no>${t("cancelar")}</button>
     </div>`;
  B.bMenu.querySelector("[data-yes]").onclick = async () => {
    closeFloat();
    try {
      await invoke("brain_delete_context", { name });
      toast(t("deletado"));
      closeTabsUnder("contexts/" + name + "/", false);
      bOpen.delete("ctx:" + name);
      sideSig = ""; brainRefresh();
    } catch (e) { toast(tErr(String(e))); }
  };
  B.bMenu.querySelector("[data-no]").onclick = closeFloat;
  placeMenu(anchor);
}

// ---- mover ARQUIVO do acervo (reunião/nota/referência) p/ referências de um contexto ----
function openMoveFileMenu(anchorEl, rel) {
  B.acervoMenu.hidden = true;
  const ctxs = lastSt ? lastSt.contexts.map((c) => c.name) : [];
  B.bMenu.innerHTML =
    `<div class="fhead">${t("mover para referências de")}</div>` +
    (ctxs.length ? ctxs.map((c) => `<div class="fitem2" data-ref="${esc(c)}"><span class="fn">→ ${esc(c)}</span></div>`).join("")
                 : `<div class="fitem2 muted fstatic">${t("sem temas")}</div>`) +
    `<div class="fsep"></div><div class="fitem2" data-ref=""><span class="fn">→ ${t("notas (sem tema)")}</span></div>`;
  B.bMenu.querySelectorAll("[data-ref]").forEach((el2) => (el2.onclick = async () => {
    closeFloat();
    try {
      const newRel = await invoke("brain_move", { rel, destContext: el2.dataset.ref });
      toast(t("movido"));
      sideSig = ""; brainRefresh();
      if (ws.tabs.some((t) => t.rel === rel)) { closeTabsUnder(rel, true); openDoc(newRel, { preview: false }); }
    } catch (e) { toast(tErr(String(e))); clog("brain_move error: " + e); }
  }));
  placeMenu(anchorEl);
}

// ---- mover item da fila (menu "mover para →") ----
function openMoveMenu(anchor, fileName) {
  B.acervoMenu.hidden = true;
  const cur = lastSt ? lastSt.contexts.map((c) => c.name) : [];
  const others = acervos.filter((a) => a.id !== activeAcervo);
  B.bMenu.innerHTML =
    `<div class="fhead">${t("rotear neste projeto")}</div>` +
    (cur.length ? cur.map((c) => `<div class="fitem2" data-ctx="${esc(c)}"><span class="fn">→ ${esc(c)}</span></div>`).join("")
                : `<div class="fitem2 muted">${t("sem temas")}</div>`) +
    (others.length ? `<div class="fhead">${t("mover para outro projeto")}</div>` +
      others.map((a) => `<div class="fitem2" data-to="${esc(a.id)}"><span class="fn">⇢ ${esc(a.name)}</span></div>`).join("")
      : "");
  const doMove = async (payload) => {
    closeFloat();
    try {
      await invoke("brain_move_to_acervo", { name: fileName, ...payload });
      toast(t("movido"));
      closeTabsUnder("inbox/" + fileName, true);
      sideSig = ""; brainRefresh();
    } catch (e) { toast(tErr(String(e))); clog("move error: " + e); }
  };
  B.bMenu.querySelectorAll("[data-ctx]").forEach((el2) =>
    (el2.onclick = () => doMove({ targetId: activeAcervo, context: el2.dataset.ctx })));
  B.bMenu.querySelectorAll("[data-to]").forEach((el2) =>
    (el2.onclick = () => doMove({ targetId: el2.dataset.to, context: null })));
  const r = anchor.getBoundingClientRect();
  B.bMenu.style.left = Math.min(r.left, window.innerWidth - 230) + "px";
  B.bMenu.style.top = r.bottom + 4 + "px";
  B.bMenu.hidden = false;
  wireFloatMenu(B.bMenu, anchor);
}
// enviar arquivos p/ a fila (com direcionamento opcional)
$("brainImport").addEventListener("click", async () => {
  const ctx = $("importCtx").value || null;
  try {
    const n = await invoke("brain_import", { context: ctx });
    if (n > 0) { toast(`${n} ${n > 1 ? t("arquivos para organizar") : t("arquivo para organizar")}`); sideSig = ""; brainRefresh(); }
  } catch (e) { toast(tErr(String(e))); clog("brain_import error: " + e); }
});
// novo contexto (input inline no cabeçalho da lateral)
// input inline p/ criar contexto (usado pelo header e pelo item "+ novo contexto")
let ctxEditing = false;
function promptNewContext() {
  if (ctxEditing) return;
  ctxEditing = true;
  const inp = document.createElement("input");
  inp.className = "bnewctx";
  inp.placeholder = t("nome-do-tema (Enter) · ex.: engenharia/qa");
  B.navCtx.before(inp); inp.focus();
  const done = () => { inp.remove(); ctxEditing = false; };
  inp.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") return done();
    if (e.key !== "Enter") return;
    try { await invoke("brain_add_context", { name: inp.value }); done(); sideSig = ""; brainRefresh(); }
    catch (err) { toast(tErr(String(err))); }
  });
  inp.addEventListener("blur", done);
}

// ============================ terminal embutido (PTY) ============================
// xterm.js (vendorizado) na frente + portable-pty no backend — a pilha do VSCode.
let term = null, fit = null, termReady = false, termSize = { cols: 0, rows: 0 };
// N24 · com o painel fora da tela, o terminal roteado para ele não tinha como
// aparecer — e o ⇆ que o traria de volta mora DENTRO dele. Sem painel desenhado, a
// doca de baixo é a única casa possível.
function routeTerminalToDock() {
  if (!settings.termSide) return false;
  settings.termSide = false;
  persistSettings();
  applyTermLayout();
  return true;
}
function setTermPanel(open) {
  $("termPanel").hidden = !open;
  const dock = $("termDock");
  if (dock) dock.hidden = !!settings.termSide || !open;
  applyTermHeight();
  if (open) {
    if (settings.termSide) {
      settings.aiPanelOpen = true; LoroShell.setPanelOpen(true);
      // o painel foi aberto: se a folha de estilo NÃO o desenha nesta largura, o
      // terminal ficaria montado num nó invisível — vai para a doca de baixo
      if (!panelRendered()) {
        panelUnavailable();
        routeTerminalToDock();
        if (dock) dock.hidden = false;
      } else {
        settings.aiPanelTab = "term"; LoroShell.setPanelTab("term");
      }
      persistSettings();
    }
    if (!term) initTerm();
    requestAnimationFrame(fitTerm);
    if (term) term.focus();
  }
}
function fitTerm() {
  if (!fit || $("termPanel").hidden) return;
  try {
    fit.fit();
    // Only notify the PTY when the grid actually changed. A redundant resize
    // spams SIGWINCH at the agent's TUI, forcing a redraw that can overprint
    // the previous frame ("text over text"); the ResizeObserver + window resize
    // + rAF paths would otherwise fire it on every unrelated tick.
    if (term.cols !== termSize.cols || term.rows !== termSize.rows) {
      termSize = { cols: term.cols, rows: term.rows };
      invoke("term_resize", { cols: term.cols, rows: term.rows }).catch(() => {});
    }
  } catch (_) {}
}
function initTerm() {
  const Term = window.Terminal, Fit = window.FitAddon && window.FitAddon.FitAddon;
  if (!Term) { toast(t("terminal indisponível")); clog("xterm missing"); return; }
  // O terminal do redesign é escuro nos DOIS temas (handoff §painel direito):
  // fundo #26231d, texto #d8d3c8, cursor âmbar.
  term = new Term({
    fontFamily: "ui-monospace, SF Mono, Menlo, monospace", fontSize: 11.5,
    cursorBlink: true, scrollback: 4000,
    theme: { background: "#26231d", foreground: "#d8d3c8", cursor: "#e6b13a", green: "#2fc7bf" },
  });
  if (Fit) { fit = new Fit(); term.loadAddon(fit); }
  term.open($("termView"));
  fitTerm();
  // Refit on ANY geometry change of the terminal box — the live panel opening/
  // closing reshapes the side-mode grid row above it, and a stale fit leaves
  // the PTY cols/rows diverged from the rendered box (text renders "broken").
  if (window.ResizeObserver) new ResizeObserver(() => fitTerm()).observe($("termView"));
  term.onData((d) => invoke("term_input", { data: d }).catch(() => {}));
  invoke("term_open", { cols: term.cols || 80, rows: term.rows || 24 })
    .then(() => { termReady = true; })
    .catch((e) => { toast(tErr(String(e))); clog("term_open error: " + e); });
}
async function restartTerm() {
  try { await invoke("term_close"); } catch (_) {}
  if (term) { term.dispose(); term = null; fit = null; termReady = false; }
  termSize = { cols: 0, rows: 0 };
  initTerm();
}
listen("term-output", (e) => { if (term) term.write(e.payload); });
listen("term-exit", () => {
  if (term) term.write(`\r\n\x1b[2m[${t("processo encerrado — 'reiniciar' para abrir de novo")}]\x1b[0m\r\n`);
  termReady = false;
  // O "Instalar agora" do banner roda brew/curl AQUI: o fim do processo é o único
  // sinal que o app tem de que as dependências podem ter chegado. Sem esta
  // re-sondagem o banner seguia dizendo que faltam, instaladas ou não.
  checkSetup();
});
$("termClear").addEventListener("click", restartTerm);
window.addEventListener("resize", fitTerm);
// N24/N26 · a janela muda de tamanho (meia tela, monitor externo, restart noutra
// máquina) e nada relia as larguras guardadas nem o painel: o app abria com a
// coluna de conteúdo em 0px, ou com o chat e o terminal inalcançáveis.
window.addEventListener("resize", () => {
  reclampPanes();
  applySideWidth(); applyPanelWidth(); applyTermHeight();
  if (panelDropped()) { panelUnavailable(); routeTerminalToDock(); }
});
// Orientação: lateral (aba Terminal do painel direito, padrão do redesign) ou
// embaixo, ancorado no rodapé da coluna de conteúdo. O ⇆ alterna; o MESMO
// elemento #termPanel é movido entre os dois pontos de montagem.
function applyTermLayout() {
  // o painel ABERTO mas não desenhado (janela estreita) não pode hospedar o
  // terminal — fechado ele continua sendo casa válida (N24)
  if (settings.termSide && panelDropped()) settings.termSide = false;
  const side = !!settings.termSide;
  LoroShell.mountTerminal(side);
  applyTermHeight();
  if (side && !$("termPanel").hidden) {
    settings.aiPanelOpen = true;
    LoroShell.setPanelOpen(true);
    settings.aiPanelTab = "term";
    LoroShell.setPanelTab("term");
  } else if (!side && settings.aiPanelTab === "term") {
    // N11/N28 · ao mover o terminal para a doca de baixo a aba Terminal continuava
    // aria-selected sobre um painel VAZIO de 419px. A aba do painel só pode
    // continuar escolhida se o terminal morar nela.
    settings.aiPanelTab = LoroShell.setPanelTab("doc");
  }
  paintPanelTermPlaceholder();
  paintTermSideBtn();
  requestAnimationFrame(fitTerm);
}
// O painel guarda a aba Terminal mesmo quando o terminal está embaixo: em vez de
// um vazio mudo, ela diz onde ele está e oferece a volta (DESIGN.md §5 — todo
// vazio orienta o passo seguinte; §8 mantém a visibilidade no painel).
// N10 · o ramo montado removia só o BOTÃO e deixava a caixa: com o terminal
// trazido para o painel, "o terminal está na doca embaixo" continuava impressa,
// em negrito, por cima do terminal vivo (DESIGN.md §1 — o estado não mente).
// Uma remoção só, usada pelos dois ramos.
function removePanelTermPlaceholder(host) {
  const box = host.querySelector(".pempty");
  if (box) box.remove();
}
function paintPanelTermPlaceholder() {
  const host = $("panelTerm");
  if (!host) return;
  const panel = $("termPanel");
  if (panel && panel.parentElement === host) {
    removePanelTermPlaceholder(host);
    return;
  }
  removePanelTermPlaceholder(host);
  // fechado é diferente de "está lá embaixo": cada estado diz o que É e oferece a
  // ação que falta
  const closed = !panel || panel.hidden;
  const box = document.createElement("div");
  box.className = "pempty";
  box.innerHTML = `<b>${closed ? t("o terminal está fechado") : t("o terminal está na doca embaixo")}</b>` +
    `<button class="btn" data-termback>${closed ? t("abrir o terminal") : t("trazer para o painel")}</button>`;
  host.appendChild(box);
  box.querySelector("[data-termback]").onclick = () => {
    settings.termSide = true; persistSettings(); applyTermLayout(); setTermPanel(true);
  };
}
// N11 · o nome acessível do ⇆ era o próprio glifo: nunca dizia em qual dos dois
// estados está (4.1.2), enquanto o #sideToggle ao lado faz isso certo.
function paintTermSideBtn() {
  const b = $("termSide");
  if (!b) return;
  const label = t(settings.termSide ? "mover o terminal para baixo" : "mover o terminal para o painel");
  b.setAttribute("aria-label", label);
  b.title = label;
  // no painel, quem manda na visibilidade é a aba (DESIGN.md §8): o × existe só
  // na doca de baixo, onde nada mais controla o terminal
  const hide = $("termHide");
  if (hide) hide.hidden = !!settings.termSide;
}
$("termSide").addEventListener("click", () => {
  settings.termSide = !settings.termSide; persistSettings(); applyTermLayout();
});
// N11 · na doca de baixo nem a aba do painel nem um × controlavam a visibilidade:
// o terminal ficava ocupando ~34vh sem porta de saída.
{
  const hide = $("termHide");
  if (hide) hide.addEventListener("click", () => { setTermPanel(false); paintPanelTermPlaceholder(); });
}

// roda um comando de SHELL no terminal embutido (abre o painel e digita)
function termRun(cmd) {
  setTermPanel(true);
  let tries = 0;
  const send = () => {
    if (termReady) { invoke("term_input", { data: cmd + "\n" }).catch(() => {}); return; }
    if (++tries < 40) setTimeout(send, 250);
  };
  send();
}

// ---- post-action auto-refresh (owner feedback 2026-07-28) ------------------
// Skills run asynchronously in the terminal agent, so a poll is how the sidebar
// learns that the analysis/report landed. O poll NÃO zera mais as assinaturas:
// `LoroBrainstorm.pessoalSig` já enxerga os filhos expandidos, então um tick sem novidade
// termina sem tocar no DOM. Zerar era o que quebrava o uso — a árvore era
// reconstruída a cada 5s e o clique do usuário caía num nó que acabara de ser
// substituído, além de a barra viver "em atualização" sem nunca assentar.
//
// A janela é longa porque uma análise passa fácil de dois minutos, e o tick
// ocioso agora é barato (lê só o que está aberto e compara). Pulado enquanto o
// usuário digita num input da lateral, para um re-render nunca comer um título
// de nota pela metade.
let actionRefreshTimer = null, actionRefreshUntil = 0;
function scheduleActionRefresh(ms = 600000) {
  actionRefreshUntil = Date.now() + ms;
  if (actionRefreshTimer) return;
  actionRefreshTimer = setInterval(() => {
    if (Date.now() > actionRefreshUntil) {
      clearInterval(actionRefreshTimer); actionRefreshTimer = null; return;
    }
    const focused = document.activeElement;
    if (focused && focused.closest && focused.closest(".bside") &&
        (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA")) return;
    // brainRefresh() já chama refreshPessoal() no fim — e este agora se auto-
    // limita pela assinatura profunda, então um tick sem novidade não toca a
    // árvore do brainstorming. A de CONTEXTOS continua sendo forçada: a sig
    // dela também é rasa (inbox + contextos + contagens) e ainda não enxerga
    // anexos de contexto, então zerar é o que a mantém viva. Mesmo defeito,
    // fora do que foi relatado — corrigir lá pede o mesmo tratamento.
    sideSig = "";
    brainRefresh();
  }, 5000);
}

// ADR-0002 §4 / ADR-0003 — runs a skill in the acervo's AI agent. Slash-commands
// only mean something to Claude; for any other agent the same skill is injected
// as a plain prompt (LoroPresets.agentInvocation). Handshake: poll term_status
// until the agent's process exists under the PTY shell (relaunching it once if
// the session was reused after the agent exited), give the TUI a short settle
// so it doesn't drop pending stdin, then inject. Fails loudly instead of typing
// into a bare shell.
async function termRunAgent(cmd) {
  const cfg = await invoke("brain_get_config").catch(() => null);
  if (!cfg || !cfg.brainDir) { toast(tErr("err.acervo_not_configured")); return false; }
  const agent = await invoke("term_agent").catch(() => "claude");
  const line = LoroPresets.agentInvocation(agent, cmd);
  setTermPanel(true);
  let relaunched = false;
  for (let tries = 0; tries < 50; tries++) {           // ~15s total
    const st = await invoke("term_status").catch(() => null);
    if (st && st.open && st.agentRunning) {
      await new Promise((r) => setTimeout(r, tries === 0 ? 0 : 800)); // settle a fresh TUI
      await invoke("term_input", { data: line + "\n" }).catch(() => {});
      scheduleActionRefresh(); // the skill writes files the sidebar must show
      return true;
    }
    // ADR-0005: term_open already typed the launch line — a fresh session
    // reports agentRunning:false for a few polls simply because `ps` hasn't
    // caught up yet. Retyping it during that grace window is the bug (agent
    // command appearing twice); only relaunch once the grace window passed
    // and the agent still isn't there (it actually exited).
    if (st && st.open && !st.agentRunning && !st.justLaunched && termReady && !relaunched) {
      relaunched = true; // reused session where the agent exited: bring it back
      await invoke("term_input", { data: agent + "\n" }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  toast(t("não foi possível abrir o agente no terminal — verifique se o CLI configurado está instalado"), 5000);
  clog("termRunAgent: agent did not come up; command not injected");
  return false;
}

// ---- setup guiado: o Loro verifica dependências e resolve pelo terminal ----
const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin";
// O que a ÚLTIMA sondagem viu. O banner era avaliado uma vez no boot e nada
// podia limpá-lo: depois de instalar tudo pelo terminal ele seguia afirmando
// "faltam dependências" pelo resto da sessão (DESIGN.md §1 — o estado mente).
// Guardar o resultado separa a sondagem (checkSetup) da pintura
// (paintSetupBanner), então uma troca de idioma repinta sem re-sondar.
let setupMissing = null;   // null = ainda não sondado · [] = tudo pronto
// A sondagem guarda CHAVES e a pintura traduz: uma troca de idioma repinta o
// banner sem sondar de novo.
const SETUP_DEP_LABEL = {
  whisper: () => t("whisper (motor de transcrição)"),
  model: () => t("modelo de voz"),
  ffmpeg: () => t("ffmpeg (conversão de áudio)"),
};
// O nó #setupMsg é data-i18n-dyn: a lista do que falta entra no texto, e
// applyI18n a reduzia de volta a "faltam dependências" sem dizer o quê.
function setupMissingLabel() {
  return t("faltam dependências") + ": " +
    (setupMissing || []).map((k) => (SETUP_DEP_LABEL[k] ? SETUP_DEP_LABEL[k]() : k)).join(" · ");
}
function paintDepBanner(banner, msg, missing, text) {
  if (!banner) return;
  if (!missing) { banner.hidden = true; return; }
  if (msg) msg.textContent = text;
  banner.hidden = false;
}
// A MESMA verdade em duas casas: Início (com o instalador, porque o terminal
// existe) e o primeiro uso. O banner do wizard era markup morto — nunca era
// exibido e o seu "Instalar agora" não tinha handler nenhum —, então uma
// instalação nova sem whisper montava o projeto sem nunca dizer que a
// transcrição não ia funcionar.
function paintSetupBanner() {
  const missing = !!(setupMissing && setupMissing.length);
  const label = missing ? setupMissingLabel() : "";
  paintDepBanner($("setupBanner"), $("setupMsg"), missing, label);
  paintDepBanner($("wizDeps"), $("wizDepsMsg"), missing,
    label + " — " + t("a transcrição só funciona depois disso; o Loro instala para você em Início, ao criar o projeto."));
}
async function checkSetup() {
  try {
    const d = await invoke("doctor");
    hostOs = d.os || hostOs; // antes de qualquer early-return: guia o áudio do sistema
    applySourceAvailability();
    const missing = [];
    if (!d.whisper_stream) missing.push("whisper");
    if (!d.models || d.models.length === 0) missing.push("model");
    // ffmpeg entra na conta: o modo gravar-e-transcrever converte para WAV 16kHz
    // com ele, então sem ffmpeg esse modo falha em runtime e não no setup.
    if (!d.ffmpeg) missing.push("ffmpeg");
    setupMissing = missing;
    paintSetupBanner();
    if (!missing.length) return true;
    $("setupRun").onclick = async () => {
      // O Windows não tem whisper-stream pré-compilado (o modo ao vivo precisa
      // de SDL2), então um script embutido compila o motor. No macOS vem do brew.
      if (hostOs === "windows") {
        try {
          const script = await invoke("whisper_setup_script");
          termRun(`powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`);
          toast(t("instalando no terminal — acompanhe abaixo"), 4000);
        } catch (e) {
          toast(t("não consegui preparar o instalador") + ": " + tErr(e), 5000);
        }
        return;
      }
      const parts = [];
      if (!d.whisper_stream) parts.push("brew install whisper-cpp");
      if (!d.ffmpeg) parts.push("brew install ffmpeg");
      if (!d.models || d.models.length === 0)
        parts.push(`mkdir -p ~/.loro/models && curl -L --progress-bar -o ~/.loro/models/ggml-large-v3-turbo.bin ${MODEL_URL}`);
      termRun(parts.join(" && "));
      toast(t("instalando no terminal — acompanhe abaixo"), 4000);
    };
    return false;
  } catch (_) { return null; }
}

// A instalação acontece FORA do app (brew/curl no terminal embutido): o app não
// tem como observar o fim dela, então oferece a re-verificação em vez de deixar
// o banner afirmando para sempre que as dependências faltam. Mesmo padrão do
// "verificar" do card de ambiente.
async function recheckSetup() {
  const b = $("setupCheck");
  if (b && b.disabled) return;
  const label = b ? b.textContent : "";
  if (b) { b.disabled = true; b.classList.add("pending"); b.textContent = t("verificando…"); }
  try {
    const ok = await checkSetup();
    if (ok === true) toast(t("tudo pronto — as dependências estão instaladas"), 5000);
    else if (ok === false) toast(setupMissingLabel(), 5000);
    else toast(t("não consegui verificar as dependências"), 5000);
  } finally {
    if (b) { b.disabled = false; b.classList.remove("pending"); b.textContent = label; }
  }
}
$("setupCheck").addEventListener("click", recheckSetup);

// fluxo guiado do áudio do sistema; os passos mudam por plataforma (ADR-0012).
// No Windows não há pacote instalável por linha de comando: ou o driver de áudio
// já expõe a Mixagem estéreo (basta habilitar no painel de Som), ou o usuário
// instala o VB-Cable à mão. Por isso lá o passo 1 abre o painel.
function openSystemAudioSetup() {
  B.acervoMenu.hidden = true;
  B.bMenu.innerHTML = hostOs === "windows"
    ? `<div class="fhead">${t("áudio do sistema — configurar")}</div>
     <div class="fitem2 muted fstatic">${t("1 · no painel de Som, aba Gravação, mostre os dispositivos desativados · 2 · habilite a Mixagem estéreo. Se o seu driver não tiver, instale o VB-Cable e use-o como saída padrão")}</div>
     <div class="fitem2" data-am><span class="fn">${t("1 · abrir o painel de Som")}</span></div>
     <div class="fitem2" data-bh><span class="fn">${t("2 · baixar o VB-Cable")}</span></div>`
    : `<div class="fhead">${t("áudio do sistema — configurar")}</div>
     <div class="fitem2 muted fstatic">${t("1 · instale o driver BlackHole · 2 · crie um dispositivo multi-saída (saída padrão) no Áudio MIDI incluindo o BlackHole")}</div>
     <div class="fitem2" data-bh><span class="fn">${t("1 · instalar BlackHole no terminal")}</span></div>
     <div class="fitem2" data-am><span class="fn">${t("2 · abrir Áudio MIDI")}</span></div>`;
  B.bMenu.querySelector("[data-bh]").onclick = () => {
    closeFloat();
    if (hostOs === "windows") invoke("open_vbcable_download").catch(() => {});
    else termRun("brew install blackhole-2ch");
  };
  B.bMenu.querySelector("[data-am]").onclick = () => { closeFloat(); invoke("open_audio_setup").catch(() => {}); };
  const r = el.privacy.getBoundingClientRect();
  B.bMenu.style.left = Math.max(10, r.left - 200) + "px";
  B.bMenu.style.top = (r.top - 150) + "px";
  B.bMenu.hidden = false;
  wireFloatMenu(B.bMenu, null);
}

// ---- arrastar arquivos do SISTEMA para a fila (Tauri drag-drop) ----
// um ou mais arquivos soltos na janela (na aba acervo) entram na fila do acervo ativo
// C6 · `_prompt.md` é o arquivo de INSTRUÇÕES do loop (GUIDE_REL), não um item:
// importado, ele sobrescreve o guia — que não é versionado, então não há volta —
// e `list_queue` o filtra da listagem, de modo que o toast contava um item que a
// tela nunca mostrava. Os importadores do backend ainda não checam o nome (ver o
// contrato em notes), então a porta que a interface possui recusa aqui e diz por quê.
function isQueueGuidePath(p) {
  const leaf = String(p || "").replace(/\\/g, "/").split("/").pop() || "";
  return leaf.toLowerCase() === "_prompt.md";
}
function splitQueueGuideDrop(paths) {
  return {
    ok: paths.filter((p) => !isQueueGuidePath(p)),
    guides: paths.filter(isQueueGuidePath).length,
  };
}
listen("tauri://drag-drop", async (e) => {
  if (!brainTab) return;
  const dropped = (e.payload && e.payload.paths) || [];
  if (!dropped.length) return;
  document.getElementById("app").classList.remove("dropping");
  const { ok: paths, guides } = splitQueueGuideDrop(dropped);
  try {
    const n = paths.length ? await invoke("brain_import_paths", { paths, context: null }) : 0;
    if (n > 0) { toast(`${n} ${n > 1 ? t("arquivos para organizar") : t("arquivo para organizar")}`); sideSig = ""; brainRefresh(); }
  } catch (err) { toast(tErr(String(err))); clog("import_paths error: " + err); }
  // a recusa fala por último e fica mais tempo: é ela que explica o arquivo que
  // NÃO entrou (antes ele entrava, por cima do guia, e a contagem o incluía)
  if (guides) toast(t("_prompt.md é o arquivo de instruções do loop — renomeie antes de importar"), 6000);
});
listen("tauri://drag-enter", () => { if (brainTab) document.getElementById("app").classList.add("dropping"); });
listen("tauri://drag-leave", () => document.getElementById("app").classList.remove("dropping"));

// ---- eventos do backend ----
// reunião em transcrição: acumula as linhas e persiste abaixo do marcador
// (brain_meeting_append); fora de reunião, mesmo destino de sempre (rodapé).
listen("transcript-line", (e) => {
  if (meeting.active && meeting.phase === "transcribing") { meetingAccumulate(e.payload); return; }
  appendLine(e.payload);
});
listen("rec-state", (e) => (e.payload ? onStarted() : onStopped()));
listen("hotkey-toggle", () => toggle());

// ADR-0010: reuniao.md cresceu — atualiza a aba viva no lugar (segue o rodapé só
// se o usuário já estava no fim; senão, mostra o pill "novas linhas ↓").
listen("meeting-appended", (e) => {
  const p = (e && e.payload) || {};
  const id = LM.livingId(p.meetingRel || "");
  if (id) refreshLivingInPlace(id);
});

// modo "gravar tudo": transcribe_file roda em segundo plano e sinaliza por
// evento (a UI nunca fica travada esperando) — mesmo destino do modo ao vivo
// (savebar / auto-save) uma vez que as linhas chegaram.
listen("transcribe-state", (e) => {
  const running = !!e.payload;
  // reunião: a transcrição de completo.wav alimenta a aba viva; a conclusão
  // dispara o relatório (ADR-0010). Não usa a savebar/auto-save do modo plano.
  if (meeting.active && meeting.phase === "transcribing") {
    el.toggle.disabled = running;
    if (running) {
      el.privacy.textContent = t("transcrevendo…");
      el.privacy.classList.add("warn");
      toast(t("transcrevendo a reunião… pode levar alguns minutos"), 0);
    } else {
      finishMeetingAfterTranscription();
    }
    return;
  }
  el.toggle.disabled = running;
  if (running) {
    el.privacy.textContent = t("transcrevendo…");
    el.privacy.classList.add("warn");
    toast(t("transcrevendo o áudio gravado… pode levar alguns minutos"), 0);
    return;
  }
  updatePrivacy();
  if (!meeting.active && !state.lines.length) { toast(t("transcrição vazia")); return; }
  endLooseBuffer(t("transcrição concluída"));
});
listen("transcribe-error", (e) => {
  toast(t("transcrição falhou") + ": " + tErr(String(e.payload)));
  clog("transcribe-error: " + e.payload);
});

// ADR-0010: "novas linhas ↓" pill (meeting living surface) — click jumps to the
// tail; scrolling to the bottom dismisses it.
if ($("mtgPill")) $("mtgPill").addEventListener("click", scrollMeetingBottom);
B.wsBody.addEventListener("scroll", () => { if (nearBottom(B.wsBody)) hidePill(); });


// ============================ casco do redesign ============================
// Ligações dos controles novos (cabeçalho, destinos, barra lateral recolhível,
// painel direito, gravação e configurações). A lógica de estado mora no
// shell.js; aqui só o que precisa conhecer o acervo/IPC.

// ---- destinos: Início · Organizar · Conhecimento · Revisão ------------------
function goDest(name, tab) {
  LoroShell.setDestination(name);
  // um destino é sempre a Home do workspace — abas são só documentos abertos
  if (!isHomeActive()) openHome(); else showHome();
  // ADR-0026 · o mapa das ligações é lido só onde é olhado: entrar no destino
  // pinta na hora, em vez de esperar a próxima passada do poll (10s).
  if (name === "knowledge") paintKnowledgeGaps();
  // ADR-0027 · a mesma regra para a Revisão: entrar não pode esperar os 120s do
  // tique de avisos, e a aba pedida é parte do endereço (⌘K e a faixa chegam
  // direto na metade do time).
  if (name === "review") {
    LoroShell.setReviewTab(tab || LoroShell.reviewTab());
    refreshReview();
  }
}
document.querySelectorAll("#destNav .dest").forEach((b) =>
  b.addEventListener("click", () => goDest(b.dataset.dest)));
// ADR-0026 · o índice remissivo abre como as outras leituras: uma aba no mesmo
// cartão de 700px. Permanente (preview: false) — é destino, não espiada.
if ($("knowIdxBtn")) $("knowIdxBtn").addEventListener("click", () => openDoc(INDEX_REL, { preview: false }));

// ---- ADR-0027 · os controles do destino Revisão ----------------------------
// A tira de abas é cromo e mora no shell.js; aqui só o que precisa de IPC.
document.querySelectorAll("#revTabs .segbtn").forEach((b) => b.addEventListener("click", () => {
  paintReviewIntro();
  paintTeamGate();
  // a metade que APARECE tem de se repintar (e se anunciar) mesmo que o conteúdo
  // dela não tenha mudado desde a última leitura: quem trocou de aba não ouviria
  // nada da metade que acabou de entrar na tela (R38).
  REV.sig = ""; REV.teamSig = "";
  if (b.dataset.revtab === "team") refreshTeamReviews(); else refreshMyChanges();
}));
if ($("revSaveBtn")) $("revSaveBtn").addEventListener("click", (e) => withPending(e.currentTarget, saveVersionFromReview));
// O nome do rascunho que a descrição vai criar é dito enquanto se escreve — a
// mesma resposta imediata que a folha «Novo rascunho» dá ao seu campo.
if ($("revMsg")) $("revMsg").addEventListener("input", paintReviewDraft);
if ($("revProposeBtn")) $("revProposeBtn").addEventListener("click", () => {
  // F5 · a recusa vem ANTES de escrever a descrição inteira, e traz o remédio
  const block = teamBlockCode();
  if (block) return toastAction(tErr(block), [{ label: t("abrir Configurações"), run: openCfgGit }], 8000);
  B.proposeBtn.click();
});
// UM CONTROLE, UM DESFECHO. O chip e «trocar de rascunho» abriam a MESMA folha,
// lado a lado, e o nome acessível do chip já reivindica a porta («Rascunhos de
// trabalho — ⎇ no rascunho X»). Dois controles e dois pontos de tabulação para o
// mesmo lugar: o link saiu.
for (const id of ["revDraft", "headDraft"]) {
  if ($(id)) $(id).addEventListener("click", openBranchPicker);
}
if ($("revBackToMine")) $("revBackToMine").addEventListener("click", backToMyDraft);
if ($("revBack")) $("revBack").addEventListener("click", backToReviewList);

// ---- cabeçalho: Gravar · ✦ IA ----------------------------------------------
// o botão ● do cabeçalho é o MESMO el.toggle de sempre (ligado mais acima)
$("aiPanelBtn").addEventListener("click", () => {
  settings.aiPanelOpen = !settings.aiPanelOpen;
  persistSettings();
  LoroShell.setPanelOpen(settings.aiPanelOpen);
  applyPanelWidth();
  // N24 · numa janela estreita o painel não é desenhado: o botão ficava cheio e
  // aria-expanded="true" mostrando NADA. Ou o painel aparece, ou a tela diz por quê.
  if (settings.aiPanelOpen && !panelRendered()) { panelUnavailable(); routeTerminalToDock(); return; }
  if (settings.aiPanelOpen && settings.aiPanelTab === "term") requestAnimationFrame(fitTerm);
});
document.querySelectorAll("#panelTabs .ptab").forEach((b) => b.addEventListener("click", () => {
  settings.aiPanelTab = LoroShell.setPanelTab(b.dataset.ptab);
  // N11 · clicar na aba Terminal invertia settings.termSide em SILÊNCIO (e o
  // persist rodava antes da inversão, então nem era gravada). Quem decide a doca
  // é o ⇆ / o botão do vazio: aqui a aba só liga o terminal onde ele já mora.
  if (settings.aiPanelTab === "term" && settings.termSide) setTermPanel(true);
  paintPanelTermPlaceholder();
  persistSettings();
}));
// pill "gravando · mm:ss" no cabeçalho: volta para a aba/vista da gravação
$("headRec").addEventListener("click", () => {
  if (meeting.active && meeting.livingRel) openDoc(meeting.livingRel, { preview: false });
  else setLivePanel(true);
});

// ---- barra lateral: 250px ⇄ 60px (o alternador fica EMBAIXO, junto ao ⚙) ----
function toggleSidebar(force) {
  settings.sidebarCollapsed = force === undefined ? !settings.sidebarCollapsed : !!force;
  persistSettings();
  LoroShell.setSidebarCollapsed(settings.sidebarCollapsed);
  paintSideToggle();
}
// O alternador é só um ícone (o <svg> é aria-hidden), então o nome acessível
// vinha do `title` — que dizia "recolher barra lateral" nos DOIS estados. Um nome
// que não acompanha o estado nomeia a ação errada metade do tempo; e como este nó
// está sob o applyI18n, o dono do texto tem de traduzir também (F25).
function paintSideToggle() {
  const st = $("sideToggle");
  if (!st) return;
  const collapsed = !!settings.sidebarCollapsed;
  const label = t(collapsed ? "expandir barra lateral" : "recolher barra lateral");
  st.setAttribute("aria-expanded", String(!collapsed));
  st.setAttribute("aria-label", label);
  st.title = label;
}
$("sideToggle").addEventListener("click", () => toggleSidebar());
document.querySelectorAll("#sideMini .minibtn").forEach((b) => b.addEventListener("click", () => {
  const what = b.dataset.mini;
  if (what === "expand") return toggleSidebar(false);
  if (what === "settings") return openCfg();
  if (what === "rec") return setLivePanel(true);
  if (what === "skills") return openHabilidadeMenu(currentRel(), b, true, "doc");
  toggleSidebar(false);
  goDest(what === "ideas" ? "home" : what);
}));
$("sideSearch").addEventListener("click", () => openPalette("file"));

// As três seções da lateral (ideias · para organizar · conhecimento) recolhem.
// Com muitos temas a árvore vira um rolo infinito; recolher é como o usuário
// escolhe o que quer ver. O estado é persistido.
function applySideSections() {
  const closed = new Set(settings.sideClosed || []);
  document.querySelectorAll("[data-sect]").forEach((btn) => {
    const off = closed.has(btn.dataset.sect);
    btn.classList.toggle("closed", off);
    // a seta era o único sinal: quem lê a tela não sabia se a seção está aberta
    btn.setAttribute("aria-expanded", String(!off));
    const body = document.querySelector(`[data-sectbody="${btn.dataset.sect}"]`);
    if (body) body.hidden = off;
  });
}
document.querySelectorAll("[data-sect]").forEach((btn) => btn.addEventListener("click", () => {
  const key = btn.dataset.sect;
  const closed = new Set(settings.sideClosed || []);
  if (closed.has(key)) closed.delete(key); else closed.add(key);
  settings.sideClosed = [...closed];
  persistSettings();
  applySideSections();
}));
// as duas linhas do rodapé revelam árvores que ficam fora do caminho por
// padrão — o CRUD das habilidades e a lista de reuniões/notes continuam ali
$("footSkills").addEventListener("click", () => {
  const s = $("toolsSection");
  if (s) { s.hidden = !s.hidden; if (!s.hidden) s.scrollIntoView({ block: "nearest" }); }
});
$("footSources").addEventListener("click", () => {
  const s = $("navSources");
  if (s) { s.hidden = !s.hidden; if (!s.hidden) s.scrollIntoView({ block: "nearest" }); }
});

// ---- 1a · Início ------------------------------------------------------------
$("heroRec").addEventListener("click", () => startRecordFlow());
$("heroNote").addEventListener("click", () => openScratchNote());
$("heroFiles").addEventListener("click", () => $("brainImport").click());
$("heroAsk").addEventListener("click", () => openChatComposer());
// Abrir o chat tem de ser perceptível mesmo quando o painel JÁ estava aberto na
// aba certa — senão o clique parece não ter feito nada (era o caso do card
// "Perguntar à IA"). O realce no composer é a confirmação.
function openChatComposer() {
  settings.aiPanelOpen = true; LoroShell.setPanelOpen(true);
  settings.aiPanelTab = LoroShell.setPanelTab("chat");
  persistSettings();
  applyPanelWidth();
  // N24 · o foco caía dentro de uma subárvore display:none (focus() falha em
  // silêncio) e o card "Perguntar à IA" simplesmente não fazia nada
  if (!panelRendered()) { panelUnavailable(); return; }
  const box = document.querySelector(".composerbox");
  const inp = $("chatInput");
  if (box) { box.classList.remove("flash"); void box.offsetWidth; box.classList.add("flash"); }
  if (inp) inp.focus();
}

// ---- nota nova: escreve primeiro, decide onde depois -----------------------
// O cartão "Escrever uma nota" promete um rascunho rápido. Pedir a pasta ANTES
// de existir texto inverte a ordem: a pessoa ainda não sabe onde aquilo mora.
// A nota nasce como uma aba de rascunho (não existe em disco) e só ao salvar o
// app pergunta onde guardar.
const SCRATCH_REL = "loro://nova-nota";
async function openScratchNote() {
  await openDoc(SCRATCH_REL, { preview: false });
  await setActiveMode("edit");
}
// Onde uma nota pode morar: as notas de uma ideia ou os anexos de um
// conhecimento — as mesmas duas casas que o backend aceita.
async function promptSaveScratch(text) {
  let temas = [];
  try { temas = (await invoke("brain_list_brainstorms")) || []; } catch (_) {}
  const ctxs = (lastSt && lastSt.contexts) || [];
  if (!temas.length && !ctxs.length) { toast(t("crie uma ideia ou um tema antes de salvar a nota")); return; }
  const opts =
    temas.map((b) => `<option value="bs:${esc(b.slug)}">${t("ideias")} · ${esc(b.nome)}</option>`).join("") +
    ctxs.map((c) => `<option value="ctx:${esc(c.name)}">${t("conhecimento")} · ${esc(c.name)}</option>`).join("");
  // o título é o começo do texto quando há um; senão a pessoa escreve
  const guess = (text.split("\n").find((l) => l.trim()) || "").replace(/^#+\s*/, "").trim().slice(0, 60);
  openModal(
    t("Salvar nota"),
    `<label class="wfield"><span class="mono">${t("título")}</span>` +
      `<input id="scratchTitle" type="text" value="${esc(guess)}" placeholder="${t("título da nota")}" spellcheck="false"></label>` +
    `<label class="wfield"><span class="mono">${t("onde guardar")}</span>` +
      `<select id="scratchDest">${opts}</select></label>`,
    t("salvar"),
    async () => {
      const titulo = (($("scratchTitle") && $("scratchTitle").value) || "").trim();
      const dest = ($("scratchDest") && $("scratchDest").value) || "";
      if (!titulo) { toast(t("informe um título")); return; }
      try {
        const rel = dest.startsWith("bs:")
          ? await invoke("brain_new_notebook", { tema: dest.slice(3), titulo })
          : await invoke("brain_new_note_in", { destRel: `contexts/${dest.slice(4)}/attachments`, titulo });
        if (!rel) throw "err.note_not_created";
        // o esqueleto criado pelo backend cede lugar ao que a pessoa escreveu
        if (text.trim()) await invoke("brain_write", { rel, content: text });
        closeTabsUnder(SCRATCH_REL, true);
        openDoc(rel, { preview: false });
        refreshAfterSkill();
        toast(t("nota salva"));
      } catch (e) { toast(tErr(String(e))); }
    }
  );
  const inp = $("scratchTitle"); if (inp) { inp.focus(); inp.select(); }
}
$("homePendingGo").addEventListener("click", () => goDest("organize"));

// ---- 1c · Conhecimento ------------------------------------------------------
// dispensar é sobre ESTE aviso: a assinatura dispensada some, um aviso novo volta
$("ghNotifClose").addEventListener("click", () => {
  notifDismissedSig = B.ghNotif ? B.ghNotif.textContent : "";
  $("ghNotifBar").hidden = true;
});
$("ghNotifOpen").addEventListener("click", () => goDest("review", "team"));
{
  // N5 · a porta que não expira nem se dispensa — ADR-0027 · e agora ela leva a
  // um DESTINO, que não se dispensa nem quando o aviso some
  const rev = $("pReviewsBtn");
  if (rev) rev.addEventListener("click", () => goDest("review", "team"));
}

// ---- 1d/1e · documento ------------------------------------------------------
// "Aprovar" é o gesto humano obrigatório: nada da IA vira oficial sem ele.
$("bApproveBtn").addEventListener("click", () => { $("bApprove").hidden = true; $("bProposal").hidden = true; B.gitBtn.click(); });
$("bApproveEdit").addEventListener("click", () => setActiveMode("edit"));
$("bApproveAsk").addEventListener("click", () => { const r = currentRel(); if (r) promptNoteAI(r, true); });
// O buffer PRIMEIRO: a versão guarda o que está em DISCO, então commitar antes de
// gravar deixaria a edição de fora do commit — e o `await` é o que faz essa ordem
// existir no tempo, não só no texto. Num rascunho pessoal (gitignorado) não há
// versão a salvar — o rótulo do botão diz isso e o clique para no arquivo.
//
// F30 · e a versão é aberta por QUEM a abre. Isto era `B.gitBtn.click()`, e aquele
// botão está desabilitado exatamente no caso deste fluxo (árvore limpa, buffer
// sujo: ele é o estado «tudo salvo ✓»): um clique programático num controle
// desabilitado não dispara, então salvar aqui gravava o arquivo e não chegava a
// versão nenhuma — o fluxo morria em silêncio, com um toast dizendo «salvo».
// GRAVAR O ARQUIVO E VERSIONAR O PROJETO SÃO DOIS ATOS. Este era o ÚNICO primário
// do modo de edição e, num documento de conhecimento, ele gravava o arquivo e
// abria a folha de versão — não havia como só salvar o texto. Um commit é do
// projeto inteiro, não do documento em foco, e agora ele tem casa própria: o
// destino Revisão, que está no relógio e mostra a mudança assim que o arquivo é
// gravado. Aqui sobra o que o botão sempre disse que fazia.
$("bSaveVersion").addEventListener("click", async () => {
  await saveActive();
});
$("bDiscardEdit").addEventListener("click", async () => {
  const tab = activeTab();
  if (!tab) return;
  await refreshTabFromDisk(tab.rel);
  setActiveMode("view");
  toast(t("mudanças descartadas"));
});

// ---- 1f · gravação ----------------------------------------------------------
$("recFinish").addEventListener("click", () => {
  setRecPending("stopping");
  // O finally vazio deixava o cromo em "encerrando…" para sempre (com o ●
  // desabilitado) sempre que o encerramento voltava sem nada a fazer. Enquanto a
  // reunião ainda está fechando, o pendente é a verdade e quem o desfaz é
  // finishMeetingAfterTranscription; se nada ficou em curso, ele sai já — e uma
  // falha aparece em vez de silenciar.
  Promise.resolve(stopSession())
    .catch((e) => { toast(t("não encerrei a reunião") + ": " + tErr(String(e))); clog("recFinish error: " + e); })
    .finally(() => { if (!meeting.active) setRecPending(null); });
});
$("recPause").addEventListener("click", () => (state.paused ? resumeMeeting() : pauseMeeting()));
$("recMark").addEventListener("click", () => markMeeting());
$("recImage").addEventListener("click", () => {
  // "inbox" NÃO é destino de anexo: guarded_anexos_dir exige brainstorming/ ou
  // contexts/ terminando em /attachments e recusa o resto (err.invalid_anexos_dest).
  // Fora de uma reunião não há pasta de anexos — o botão diz isso em vez de
  // disparar um erro de backend.
  if (!(meeting.active && meeting.dir)) { toast(t("anexar precisa de uma reunião aberta")); return; }
  importAnexoFromComputer(meeting.dir + "/attachments", () => { pessoalSig = ""; refreshPessoal(); });
});
$("recOverlay").addEventListener("click", () => { el.optOverlay.checked = !el.optOverlay.checked; el.optOverlay.dispatchEvent(new Event("change")); });
$("recSource").addEventListener("change", () => {
  el.source.value = $("recSource").value;
  el.source.dispatchEvent(new Event("change"));
});

// ---- 1g · configurações (página) -------------------------------------------
document.querySelectorAll("#cfgNav .cfgnavbtn").forEach((b) =>
  b.addEventListener("click", () => showCfgSection(b.dataset.sec)));
document.querySelectorAll("#actionModeSeg .segbtn").forEach((b) => b.addEventListener("click", () => {
  settings.actionMode = b.dataset.actionmode;
  persistSettings();
  paintActionMode();
}));
function paintActionMode() {
  document.querySelectorAll("#actionModeSeg .segbtn").forEach((b) =>
    b.classList.toggle("on", b.dataset.actionmode === settings.actionMode));
  document.querySelectorAll("#chatPermSeg .segbtn").forEach((b) =>
    b.classList.toggle("on", b.dataset.chatperm === settings.chatPermission));
}
document.querySelectorAll("#chatPermSeg .segbtn").forEach((b) => b.addEventListener("click", () => {
  settings.chatPermission = b.dataset.chatperm;
  persistSettings();
  paintActionMode();
}));
document.querySelectorAll("#themeSeg .segbtn").forEach((b) => b.addEventListener("click", () => {
  settings.theme = LoroShell.setTheme(b.dataset.theme);
  persistSettings();
}));
document.querySelectorAll("#modeSeg .segbtn").forEach((b) => b.addEventListener("click", () => {
  el.mode.value = b.dataset.mode;
  el.mode.dispatchEvent(new Event("change"));
  document.querySelectorAll("#modeSeg .segbtn").forEach((x) => x.classList.toggle("on", x === b));
}));
{
  const ai = $("cfgAgentInput");
  if (ai) ai.addEventListener("change", async () => {
    try { await invoke("brain_set_agent", { agent: ai.value.trim() }); toast(t("agente atualizado")); }
    catch (e) { toast(tErr(String(e))); }
  });
  // ADR-0026 §2 — o campo diz a verdade sobre o que aceitou: o backend normaliza
  // (só http/https, com o separador final), então o input volta com o valor real.
  const tb = $("cfgTicketBase");
  if (tb) tb.addEventListener("change", async () => {
    try {
      await invoke("brain_set_ticket_base", { base: tb.value.trim() });
      const av = await invoke("brain_list_acervos");
      acervos = av.acervos || []; activeAcervo = av.active || "";
      tb.value = ticketBase();
      toast(tb.value ? t("endereço atualizado") : t("os códigos ficam sem link"));
    } catch (e) { toast(tErr(String(e))); }
  });
}


// ---- despachante único das ações de IA (chat | terminal) --------------------
// Toda habilidade, pergunta e análise passa por aqui. O destino é escolha do
// usuário (Configurações → IA e terminal): no chat a resposta fica na conversa;
// no terminal ele acompanha o passo a passo e pode intervir. Antes o destino era
// sempre o terminal e o chat era um beco sem saída.
// Uma frase só, derivada do destino escolhido — em vez de prometer "terminal"
// em texto fixo espalhado por vários modais.
function aiTargetHint() {
  return settings.actionMode === "term"
    ? t("a resposta aparece na aba Terminal")
    : t("a resposta aparece no chat");
}

let chatLastPrompt = null;
// Devolve uma promessa de BOOLEANO: o pedido saiu ou não. Antes não devolvia
// nada, e quem chamava anunciava "enviada" na linha seguinte — o chat então dizia
// "nada foi enviado" (DESIGN.md §1: um despacho que pode falhar não relata
// sucesso antes de saber).
function runAiCommand(cmd, label) {
  if (!cmd) return Promise.resolve(false);
  // recusar ANTES de empilhar a bolha: senão cada clique repetido deixava um
  // pedido órfão na conversa seguido de um aviso de recusa
  if (settings.actionMode !== "term" && chatBusy) { toast(tErr("err.chat_busy")); return Promise.resolve(false); }
  chatLastPrompt = cmd;
  if (settings.actionMode === "term") return termRunAgent(cmd);
  openChatComposer();
  chatPush("chatmsg", esc(label || cmd));
  chatTurn = null; chatBuf = "";
  setChatBusy(true);
  // MESMA normalização do caminho do terminal: um "/loro-…" só significa algo
  // para o Claude. Para qualquer outro agente vira a instrução equivalente
  // (LoroPresets.agentInvocation) — sem isto, com `ollama run llama3` toda ação
  // de IA mandava a barra crua e o modelo respondia bobagem, em silêncio. E o
  // agente é lido AGORA: trocá-lo em Configurações valia só no próximo boot.
  return currentChatAgent()
    .then((agent) => invoke("chat_send", {
      input: {
        prompt: LoroPresets.agentInvocation(agent, cmd),
        model: chatPrefs.model, effort: effortCli(chatPrefs.effort),
        permission: settings.chatPermission, fresh: chatFresh,
      },
    }))
    .then(() => { chatFresh = false; return true; })
    .catch((e) => { chatSendFailed(e); return false; });
}
// O par despachar → relatar tem um dono só. A falha já está na tela (a linha de
// erro do chat ou o toast do terminal), então aqui só o sucesso fala — e diz
// ONDE a resposta vai aparecer, que era exatamente o que faltava.
async function dispatchAi(cmd, doneMsg, label) {
  const sent = await runAiCommand(cmd, label);
  if (sent) toast(doneMsg || aiTargetHint(), 4000);
  return sent;
}
// N8 · a sheet now holds its pending state until the work it started answers.
// An AI dispatch HANDS the work to another surface — the chat, or the terminal
// the dispatch itself opens BEHIND the sheet — and that surface carries the
// feedback ("pensando…", the terminal's own output). So this one gets out of the
// way immediately instead of covering its own destination.
function dispatchAiFromSheet(cmd, doneMsg, label) {
  closeModal();
  return dispatchAi(cmd, doneMsg, label);
}
// O comando do agente é por acervo (ADR-0003) e editável em Configurações, então
// não pode ser lido uma vez no boot: `chat_status` devolve o que vale agora.
async function currentChatAgent() {
  try {
    const st = await invoke("chat_status");
    // trocar o agente em Configurações vale já: o pill do painel acompanha
    if (st && st.agent) { chatAgent = st.agent; paintChatMode(); }
  } catch (_) { /* sem backend: fica o último conhecido */ }
  return chatAgent;
}

// ---- painel: Chat -----------------------------------------------------------
// As habilidades ficam SEMPRE à vista (handoff §painel direito): uma linha de
// chips arma a ação; enviar sem texto executa com a instrução padrão. O destino
// é o agente do projeto — o mesmo que roda as habilidades no terminal.
let chatArmed = null;
function renderChatChips() {
  const chips = $("chatChips");
  if (!chips) return;
  const todas = allHabilidadeEntries("doc");
  const top = todas.slice(0, 3);
  chips.innerHTML = top.map((e, i) => `<button class="chip" data-chip="${i}">${esc(e.label)}</button>`).join("") +
    `<button class="chip" data-chipall>${t("todas")} (${todas.length}) ▸</button>`;
  chips.querySelectorAll("[data-chip]").forEach((b) => (b.onclick = () => armChat(top[Number(b.dataset.chip)])));
  const all = chips.querySelector("[data-chipall]");
  if (all) all.onclick = (e) => { e.stopPropagation(); openHabilidadeMenu(currentRel(), all, true, "doc"); };
}
function armChat(entry) {
  chatArmed = entry || null;
  const box = $("chatArmed");
  if (!box) return;
  box.hidden = !chatArmed;
  if (!chatArmed) return;
  box.innerHTML = `<span class="armedchip">${esc(chatArmed.label)}<button data-disarm aria-label="${t("desarmar")}">×</button></span>`;
  box.querySelector("[data-disarm]").onclick = () => armChat(null);
  const inp = $("chatInput"); if (inp) inp.focus();
}
function chatPush(cls, html) {
  const th = $("chatThread");
  if (!th) return;
  const empty = th.querySelector(".chatempty");
  if (empty) empty.remove();
  const node = document.createElement("div");
  node.className = cls;
  node.innerHTML = html;
  th.appendChild(node);
  th.scrollTop = th.scrollHeight;
}
// Um turno = uma bolha do usuário + uma resposta que cresce por deltas.
// `chatTurn` é a resposta viva; `chatBuf` acumula o markdown para re-renderizar
// a cada delta (o agente escreve markdown, não texto puro).
let chatTurn = null, chatBuf = "", chatBusy = false;

function chatAnswerNode() {
  if (chatTurn) return chatTurn;
  const th = $("chatThread");
  const empty = th.querySelector(".chatempty");
  if (empty) empty.remove();
  chatTurn = document.createElement("div");
  chatTurn.className = "chatans";
  // NÃO zere chatBuf aqui: o primeiro delta já escreveu nele antes de pedir o
  // nó, e limpar aqui comia o começo de toda resposta. Quem zera é sendChat,
  // que é onde um turno de fato começa.
  th.appendChild(chatTurn);
  return chatTurn;
}
function chatAtBottom() {
  const th = $("chatThread");
  return th.scrollHeight - th.scrollTop - th.clientHeight < 40;
}
function chatPaint() {
  const stick = chatAtBottom();
  chatAnswerNode().innerHTML = mdRender(chatBuf, docOpts());
  chatThinking(chatBusy);   // reancora o indicador no fim
  if (stick) { const th = $("chatThread"); th.scrollTop = th.scrollHeight; }
}
function setChatBusy(on) {
  chatBusy = on;
  const send = $("chatSend");
  send.textContent = on ? "■" : "↑";
  send.classList.toggle("stop", on);
  send.title = on ? t("parar") : t("Enviar");
  $("chatInput").disabled = false;   // dá para escrever o próximo enquanto responde
  chatThinking(on);
}

// Sinal de que ALGO está acontecendo. Sem ele o chat ficava mudo entre o envio
// e o primeiro delta — que numa pergunta com busca leva dezenas de segundos, e
// o usuário não tinha como saber se tinha travado.
function chatThinking(on) {
  const th = $("chatThread");
  if (!th) return;
  let node = th.querySelector(".chatthinking");
  // F6 · o mesmo sinal para quem não vê os três pontinhos. É dito nas duas
  // transições (começou a pensar / terminou), nunca a cada delta.
  if (!!on !== !!node) announce(on ? t("pensando…") : t("resposta pronta"));
  if (!on) { if (node) node.remove(); return; }
  if (!node) {
    node = document.createElement("div");
    node.className = "chatthinking";
    node.innerHTML = `<span class="dots"><i></i><i></i><i></i></span><span class="lbl">${esc(t("pensando…"))}</span>`;
    th.appendChild(node);
  }
  th.appendChild(node);   // mantém o indicador SEMPRE no fim da conversa
  th.scrollTop = th.scrollHeight;
}
// Cada ferramenta vira um passo EXPANSÍVEL: fechado mostra só o nome (a
// conversa não vira um log); aberto mostra o que foi pedido e o que voltou.
// Antes o passo era um chip mudo e o usuário não tinha como ver o que aconteceu.
const chatSteps = new Map();   // tool_use id -> nó do passo
function chatStep(tool) {
  const th = $("chatThread");
  if (!th) return;
  const step = document.createElement("details");
  step.className = "chatstep";
  step.innerHTML =
    `<summary><span class="dot"></span><span class="nm">${esc(tool.name || "?")}</span>` +
    `<span class="st"></span></summary>` +
    `<div class="io"><div class="lbl">${esc(t("pedido"))}</div><pre class="in">${esc(prettyJson(tool.input))}</pre></div>`;
  th.appendChild(step);
  if (tool.id) chatSteps.set(tool.id, step);
  chatThinking(chatBusy);
  th.scrollTop = th.scrollHeight;
}
// O input chega como JSON cru; indentado ele é legível, e se não for JSON
// mostramos como veio em vez de esconder.
function prettyJson(raw) {
  if (!raw) return "";
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch (_) { return String(raw); }
}
function chatStepResult(res) {
  const step = res.id && chatSteps.get(res.id);
  if (!step) return;
  const st = step.querySelector(".st");
  if (st) st.textContent = res.isError || res.permission ? "!" : "✓";
  step.classList.toggle("failed", !!(res.isError || res.permission));
  const io = step.querySelector(".io");
  if (io && res.text) {
    io.insertAdjacentHTML("beforeend",
      `<div class="lbl">${esc(t("resposta"))}</div><pre class="out">${esc(res.text)}</pre>`);
  }
  // um passo que falhou já abre: é o que o usuário precisa ver
  if (res.isError || res.permission) step.open = true;
}

// Esforço na língua da interface ⇄ nível do CLI. O usuário escolhe "alto",
// o agente recebe "high".
const EFFORT_LEVELS = [
  { label: "baixo", cli: "low" }, { label: "médio", cli: "medium" },
  { label: "alto", cli: "high" }, { label: "muito alto", cli: "xhigh" },
  { label: "máx", cli: "max" },
];
const effortCli = (label) => (EFFORT_LEVELS.find((e) => e.label === label) || { cli: "high" }).cli;

async function sendChat() {
  if (chatBusy) return chatStop();
  const inp = $("chatInput");
  const text = (inp.value || "").trim();
  if (!text && !chatArmed) return;
  // Uma habilidade armada é um comando do agente; texto solto é uma pergunta
  // ancorada no que o projeto já sabe (/loro-ask), como na paleta.
  let prompt = text;
  let shown = text;
  if (chatArmed) {
    shown = `${chatArmed.label}${text ? " — " + text : ""}`;
    prompt = await chatSkillPrompt(chatArmed, text);
  } else {
    prompt = LoroBrainstorm.brainAskCmd(text, null) || text;
  }
  chatPush("chatmsg", esc(shown));
  chatLastPrompt = prompt;
  armChat(null);
  inp.value = "";
  chatTurn = null; chatBuf = "";
  setChatBusy(true);
  try {
    await invoke("chat_send", {
      input: {
        prompt, model: chatPrefs.model, effort: effortCli(chatPrefs.effort),
        permission: settings.chatPermission, fresh: chatFresh,
      },
    });
    chatFresh = false;
  } catch (e) {
    chatSendFailed(e);
  }
}

// Uma recusa (turno em andamento) não é uma resposta: era escrita DENTRO da
// bolha da resposta corrente, o que embaralhava a conversa a cada clique
// repetido. Recusa vira aviso; falha de verdade vira uma linha própria.
// Recarrega o que uma habilidade pode ter escrito: as duas árvores e os filhos
// já expandidos (reuniões e contextos), que são carregados sob demanda.
function refreshAfterSkill() {
  sideSig = ""; pessoalSig = "";
  brainRefresh();
  refreshPessoal().then(reloadOpenChildren).catch(reloadOpenChildren);
  // uma skill pode terminar de escrever logo depois do turno
  setTimeout(() => { pessoalSig = ""; refreshPessoal().then(reloadOpenChildren).catch(() => {}); }, 2500);
}
// Os filhos são carregados sob demanda e o rel de cada um vive no próprio nó
// (data-mtgrel/data-temachild), então a fonte da verdade aqui é o DOM já
// renderizado — não um mapa paralelo que poderia divergir.
function reloadOpenChildren() {
  B.navPessoal.querySelectorAll("[data-mtgchild]").forEach((n) => {
    if (!n.hidden) fillMeetingChild(n.dataset.mtgchild, n.dataset.mtgrel);
  });
  B.navPessoal.querySelectorAll("[data-temachild]").forEach((n) => {
    if (!n.hidden) loadTemaChildren(n.dataset.temachild);
  });
  for (const key of bOpen) {
    const ctx = /^ctx:(.+)$/.exec(key);
    if (ctx) loadCtxChildren(ctx[1]);
  }
}

function chatSendFailed(e) {
  const msg = String(e);
  if (msg.startsWith("err.chat_busy")) { toast(tErr(msg)); return; }
  setChatBusy(false);
  chatTurn = null; chatBuf = "";
  if (agentAuthFailure(msg)) return chatAuthBlock();
  chatPush("chatfail", esc(t("não consegui falar com o agente") + ": " + tErr(msg)));
}
// O prompt de uma habilidade armada: a mesma invocação que o terminal usaria
// (slash-command no Claude, instrução em texto nos demais agentes).
async function chatSkillPrompt(entry, extra) {
  const base = entry.kind === "sync"
    ? `/loro-sync ${entry.fonte}`
    : `/${(entry.rel || "").split("/").pop().replace(/\.md$/, "")}`;
  const alvo = currentRel();
  const line = [base, alvo, extra].filter(Boolean).join(" ");
  return LoroPresets.agentInvocation(await currentChatAgent(), line);
}
function chatStop() { invoke("chat_cancel").catch(() => {}); }

listen("chat-delta", (e) => { chatBuf += e.payload || ""; chatPaint(); });
listen("chat-tool", (e) => {
  // uma nova ferramenta encerra o parágrafo corrente: o texto que vier depois
  // é uma nova fala, não a continuação da anterior
  if (chatBuf.trim()) { chatTurn = null; chatBuf = ""; }
  chatStep(e.payload || {});
});
listen("chat-tool-result", (e) => chatStepResult(e.payload || {}));
// B13 · A saída de um agente que não está autenticado é a saída de um PROCESSO,
// não uma resposta: "Not logged in · Please run /login" ia para dentro da bolha
// da resposta, em inglês, numa UI em pt-BR, sem dizer o que falhou nem como sair.
// A comparação é feita sobre o turno inteiro e só quando ele é curto — uma
// resposta de verdade tem corpo, então um texto que FALA de login não é
// confundido com um turno que MORREU por login.
function agentAuthFailure(text) {
  const s = String(text || "").trim();
  if (!s || s.length > 400) return false;
  return /\bnot logged in\b|please run \/login|\blogin required\b|\bplease log in\b|\binvalid api key\b|authentication[_ -]?(error|failed)|\bunauthorized\b/i.test(s);
}
listen("chat-done", (e) => {
  const p = (e && e.payload) || {};
  setChatBusy(false);
  if (agentAuthFailure(p.detail || chatBuf)) return chatAuthBlock();
  if (p.ok) {
    // uma habilidade escreve arquivos NOVOS; as assinaturas de cache não os
    // veem, e os filhos de cada reunião são carregados sob demanda. Forçar o
    // recarregamento é o que evita ter de abrir e fechar as pastas na mão.
    refreshAfterSkill();
    offerCreatedFiles(chatBuf);
    return;
  }
  if (p.permission) return chatPermissionBlock();
  chatBuf += (chatBuf ? "\n\n" : "") + (p.detail || tErr(p.error || "err.chat_agent_failed"));
  chatPaint();
});

// ---- B15 · o arquivo que o chat acabou de criar --------------------------
// Uma habilidade termina dizendo "✅ apresentação criada: <caminho>" — e o chat
// parava aí: o caminho é TEXTO, não um controle, então o usuário lia o nome do
// arquivo e tinha de ir procurá-lo na lateral. DESIGN.md §1: ofereça a ação.
// A oferta é verificada contra o disco antes de aparecer: um botão que abre um
// arquivo que não existe é pior que nenhum botão.
function filesNamedInAnswer(text) {
  const out = [];
  // o lookbehind barra o que só PARECE um caminho do projeto: uma URL
  // (…/contexts/x.md) ou um caminho absoluto não é um rel que openDoc abre.
  // `contextos` continua na lista: um acervo escrito antes da ADR-0026 §14 tem
  // esse caminho, e o agente vai nomeá-lo como ele está no disco.
  const re = /(?<![\w./-])(?:brainstorming|contexts|contextos|inbox|processed|referencias)\/[A-Za-z0-9._\-/]+\.(?:md|txt)\b/g;
  for (const m of String(text == null ? "" : text).matchAll(re)) {
    if (!out.includes(m[0])) out.push(m[0]);
  }
  // três é o teto: a conversa não vira um gerenciador de arquivos (§5)
  return out.slice(0, 3);
}
async function relExistsOnDisk(rel) {
  const i = String(rel).lastIndexOf("/");
  if (i < 0) return false;
  const dir = rel.slice(0, i), name = rel.slice(i + 1);
  try {
    const entries = (await invoke("brain_list_dir", { rel: dir })) || [];
    return entries.some((f) => !f.dir && f.name === name);
  } catch (_) { return false; }
}
async function offerCreatedFiles(answer) {
  const th = $("chatThread");
  if (!th) return;
  const found = [];
  for (const rel of filesNamedInAnswer(answer)) {
    if (await relExistsOnDisk(rel)) found.push(rel);
  }
  if (!found.length) return;
  const box = document.createElement("div");
  box.className = "toolsrow";
  box.innerHTML = found.map((rel) =>
    `<button class="btn sm" data-openrel="${esc(rel)}" title="${esc(rel)}">${t("abrir")} ${esc(shortName(rel.split("/").pop()))}</button>`).join("");
  th.appendChild(box);
  th.scrollTop = th.scrollHeight;
  box.querySelectorAll("[data-openrel]").forEach((b) =>
    (b.onclick = () => openDoc(b.dataset.openrel, { preview: false })));
}

// B13 · O agente não está conectado à conta do usuário. O texto cru do processo
// sai da conversa e entra um estado de erro na voz do app, que NOMEIA a
// recuperação — a mesma forma do bloco de permissão (DESIGN.md §5: a recusa não
// mora dentro do conteúdo).
// BR-9: o Loro nunca guarda credencial. Quem se autentica é o agente do usuário,
// no terminal dele; o app só abre a porta e diz o comando.
function chatAuthBlock() {
  const th = $("chatThread");
  if (!th) return;
  // C25 · o despacho tinha dado certo (o agente subiu) e o toast disse "enviada";
  // a recusa de login só aparece aqui, no fim do turno. As duas frases não podem
  // coexistir na tela: quem descobre que nada foi enviado apaga a que sobrou.
  clearToast();
  // o turno morto não pode ficar como se fosse a resposta
  if (chatTurn) { chatTurn.remove(); chatTurn = null; }
  chatBuf = "";
  const box = document.createElement("div");
  box.className = "chatperm";
  box.innerHTML =
    `<b>${esc(t("o agente de IA não está conectado à sua conta"))}</b>` +
    `<span>${esc(t("nada foi enviado. abra a aba Terminal e rode /login no seu agente — o Loro nunca guarda a sua credencial."))}</span>` +
    `<span class="row"><button class="btn sm" data-term>${esc(t("Abrir o Terminal"))}</button></span>`;
  th.appendChild(box);
  th.scrollTop = th.scrollHeight;
  announce(t("o agente de IA não está conectado à sua conta"));
  box.querySelector("[data-term]").onclick = () => {
    settings.aiPanelTab = LoroShell.setPanelTab("term"); persistSettings();
    setTermPanel(true);
    box.remove();
  };
}

// ADR-0021: negação de permissão não é um erro seco — é uma escolha. O bloco
// âmbar oferece liberar a pasta (e repetir) ou continuar no terminal, onde o
// agente pode pedir permissão interativamente.
function chatPermissionBlock() {
  const th = $("chatThread");
  const box = document.createElement("div");
  box.className = "chatperm";
  box.innerHTML =
    `<b>${esc(t("o agente não teve permissão para concluir"))}</b>` +
    `<span>${esc(t("nada foi alterado. o chat não consegue parar e perguntar no meio de uma ação — escolha o que ele pode fazer e peça de novo."))}</span>` +
    `<span class="row"><button class="btn sm" data-perm>${esc(t("Liberar tudo e repetir"))}</button>` +
    `<button class="btn sm" data-handoff>${esc(t("Continuar no terminal"))}</button></span>`;
  th.appendChild(box);
  th.scrollTop = th.scrollHeight;
  // "liberar tudo" muda a POLÍTICA do chat (persistida) e repete o último
  // pedido — antes o botão liberava a pasta, que nunca era o que faltava.
  box.querySelector("[data-perm]").onclick = () => {
    settings.chatPermission = "bypassPermissions";
    persistSettings();
    paintActionMode();
    box.remove();
    if (chatLastPrompt) runAiCommand(chatLastPrompt, t("repetindo com permissão total"));
    else toast(t("permissão liberada — peça de novo"));
  };
  box.querySelector("[data-handoff]").onclick = async () => {
    try {
      const cmd = await invoke("chat_handoff");
      settings.aiPanelTab = LoroShell.setPanelTab("term"); persistSettings();
      setTermPanel(true);
      termRun(cmd);
      box.remove();
    } catch (err) { toast(tErr(String(err))); }
  };
}

$("chatSend").addEventListener("click", sendChat);
$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
// o composer cresce com o texto até o teto do CSS
$("chatInput").addEventListener("input", (e) => {
  e.target.style.height = "auto";
  e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
});
let chatFresh = true, chatAgent = "claude";
// C28 · o pill nomeia o agente que vai rodar. Ele estava sob applyI18n, que
// congela o msgid do boot ("modo aberto") e o reescreve a cada troca de idioma:
// o painel perdia para sempre a única informação de QUEM responde. Mesmo remédio
// do selo de privacidade (F25): o nó é data-i18n-dyn e quem escreve em tempo de
// execução também traduz, a partir de rerenderForLang.
function paintChatMode() {
  const pill = $("chatMode");
  if (!pill) return;
  pill.textContent = chatAgent;
  pill.title = t("o agente configurado para este projeto");
}
// C4 · a frase morava em TRÊS lugares (boot, reiniciar e mais nada que a
// repintasse): trocar de idioma deixava a conversa vazia no idioma anterior.
// Um escritor só, chamado também de rerenderForLang.
function paintChatEmpty() {
  const th = $("chatThread");
  const p = th && th.querySelector(".chatempty");
  if (p) p.textContent = t("pergunte qualquer coisa — a resposta vem primeiro do que o projeto já sabe.");
}
function resetChatThread() {
  const th = $("chatThread");
  if (!th) return;
  th.innerHTML = `<p class="chatempty"></p>`;
  paintChatEmpty();
}
$("chatReset").addEventListener("click", async () => {
  try { await invoke("chat_reset"); } catch (_) {}
  chatFresh = true; chatTurn = null; chatBuf = ""; chatSteps.clear(); setChatBusy(false);
  resetChatThread();
  armChat(null);
});
$("chatModel").addEventListener("click", (e) => {
  e.stopPropagation();
  // modelo e esforço num controle só (revisão do time, decisão 3)
  B.acervoMenu.hidden = true;
  B.bMenu.innerHTML = `<div class="fhead">${t("modelo")}</div>` +
    ["sonnet", "opus", "haiku", "fable"].map((m) => `<div class="fitem2${m === chatPrefs.model ? " on" : ""}" data-model="${m}"><span class="fn">${m}</span></div>`).join("") +
    `<div class="fsep"></div><div class="fhead">${t("esforço")}</div>` +
    EFFORT_LEVELS.map((x) => `<div class="fitem2${x.label === chatPrefs.effort ? " on" : ""}" data-effort="${x.label}"><span class="fn">${t(x.label)}</span></div>`).join("");
  B.bMenu.querySelectorAll("[data-model]").forEach((b) => (b.onclick = () => { closeFloat(); chatPrefs.model = b.dataset.model; persistChatPrefs(); }));
  B.bMenu.querySelectorAll("[data-effort]").forEach((b) => (b.onclick = () => { closeFloat(); chatPrefs.effort = b.dataset.effort; persistChatPrefs(); }));
  placeMenu($("chatModel"));
});
const chatPrefs = { model: "sonnet", effort: "alto" };
function persistChatPrefs() {
  settings.chatModel = chatPrefs.model; settings.chatEffort = chatPrefs.effort;
  persistSettings(); paintChatPrefs();
}
function paintChatPrefs() { $("chatModel").textContent = `${chatPrefs.model} · ${chatPrefs.effort} ⌄`; }

// ---- estado de gravação refletido no cabeçalho e nas abas -------------------
// A gravação continua se o usuário trocar de aba: o pill do cabeçalho é o
// caminho de volta, e o rótulo do ● vira "Parar".
let recChromeWasOn = false;
function paintRecordingChrome() {
  const on = state.running || meeting.active;
  // parado é o estado normal: sem gravação, um tick não toca no DOM
  if (!on && !recChromeWasOn) return;
  recChromeWasOn = on;
  paintRecControl();
  el.toggle.classList.toggle("recording", on);
  const pill = $("headRec");
  const away = on && el.surface.hidden && !(meeting.active && currentRel() === meeting.livingRel);
  if (pill) {
    pill.hidden = !away;
    pill.textContent = state.paused
      ? `⏸ ${t("pausada")} · ${el.timer.textContent}`
      : `● ${t("gravando")} · ${el.timer.textContent}`;
  }
  const mini = document.querySelector('#sideMini .minibtn[data-mini="rec"]');
  if (mini) mini.hidden = !on;
  const foot = $("recFoot");
  if (foot) foot.hidden = !on;
  // pausar/encerrar a reunião a partir de onde ela está acontecendo
  const fin = $("recFinish");
  if (fin) fin.hidden = !meeting.active;
  const pau = $("recPause");
  if (pau) {
    const showPause = meeting.active && (meeting.phase === "recording" || state.paused);
    if (pau.hidden === showPause) { pau.hidden = !showPause; paintPauseBtn(); }
  }
  // C27 · "Marcar momento" grava um marcador no manifest da reunião e "Anexar
  // imagem" escreve em <reunião>/attachments: fora de uma reunião os dois só sabiam
  // RECUSAR ("nenhuma reunião em andamento") — com o relógio da transcrição
  // avulsa correndo na frente do usuário. DESIGN.md §1: nunca um controle que
  // não faz nada. Eles existem exatamente enquanto a reunião existe.
  for (const id of ["recMark", "recImage"]) {
    const b = $(id);
    if (b) b.hidden = !meeting.active;
  }
  if (on) requestAnimationFrame(() => resizeWave());
}
setInterval(paintRecordingChrome, 1000);

// ---- init ----
loadSettings();
applySettings();
// uiLang lives in the backend config (source of truth). One-time migration:
// a pre-existing "en" choice in localStorage is pushed to the backend.
(async () => {
  try {
    let lang = await invoke("ui_get_lang");
    if (lang !== "en" && settings.uiLang === "en") {
      lang = await invoke("ui_set_lang", { lang: "en" });
    }
    if (lang !== settings.uiLang) {
      settings.uiLang = lang;
      persistSettings();
      applySettings();
      rerenderForLang();
    }
  } catch (_) { /* no backend (tests/dev server): localStorage value stands */ }
})();
// o cabeçalho mostra a versão (o "100% local" vive no manual e no seletor de fonte)
invoke("app_version").then((v) => { const n = $("appVersion"); if (n) n.textContent = "v" + v; }).catch(() => {});
resizeWave();
drawIdle();
updateCfgLabel();
updatePrivacy();
// casco do redesign: destino inicial, seção de configurações e painel de chat
LoroShell.setDestination("home");
showCfgSection("proj");
chatPrefs.model = settings.chatModel; chatPrefs.effort = settings.chatEffort;
paintChatPrefs();
// o chat sobrevive a um reload da janela: o turno roda no backend, então a
// interface recupera o estado em vez de fingir que não há nada em andamento
paintChatMode();
invoke("chat_status").then((st) => {
  chatAgent = (st && st.agent) || "claude";
  paintChatMode();
  chatFresh = !(st && st.hasSession);
  if (st && st.running) setChatBusy(true);
}).catch(() => {});
resetChatThread();
paintRecordingChrome();
setupWorkspace();   // ADR-0008: Home é a primeira aba fixa (não fechável)
initBrain();   // acervo é a tela principal (sem abas)
applyTermLayout();
if (settings.aiPanelOpen && settings.aiPanelTab === "term") setTermPanel(true);
checkSetup();
clog("init ok · TAURI=[" + Object.keys(TAURI).join(",") + "] · gUM=" + !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));

// auto-teste headless (só com LORO_SELFTEST=1): exercita start -> espera -> stop
invoke("selftest_enabled").then((on) => {
  if (!on) return;
  invoke("list_capture_devices").then((d) => clog("selftest: devices=" + JSON.stringify(d)))
    .catch((e) => clog("selftest: list_capture_devices error: " + e));
  invoke("brain_status").then((s) => clog(`selftest: brain configured=${s.configured} ctx=${s.contexts.length} inbox=${s.inbox.length} processed=${s.processed}`))
    .catch((e) => clog("selftest: brain_status error: " + e));
  clog("selftest: starting");
  startSession().then(() => {
    setTimeout(async () => {
      clog(`selftest: running=${state.running} lines=${state.lines.length}`);
      await stopSession();
      clog("selftest: stopped");
    }, 7000);
  });
}).catch((e) => clog("selftest_enabled error: " + e));
