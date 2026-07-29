// Loro — lógica da janela principal.
// Usa só o global window.__TAURI__ (core.invoke + event.listen + window),
// sem pacotes npm de plugin. O áudio/texto nunca sai da máquina.

const TAURI = window.__TAURI__ || {};
const invoke = TAURI.core ? TAURI.core.invoke : async () => { throw new Error("Tauri unavailable"); };
const listen = TAURI.event ? TAURI.event.listen : async () => {};
const getWin = TAURI.window ? TAURI.window.getCurrentWindow : null;
const { esc, mdInline, mdRender, mergeSettings } = window.LoroText;
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
  saveBtn: $("saveBtn"), discardBtn: $("discardBtn"),
  cfgPop: $("cfgPop"), toast: $("toast"),
  optScroll: $("optScroll"), optTop: $("optTop"), optOverlay: $("optOverlay"),
  optDiar: $("optDiar"), clearBtn: $("clearBtn"),
  model: $("model"), lang: $("lang"), translate: $("translate"),
  autosave: $("autosave"), pickDir: $("pickDir"), source: $("source"), mode: $("mode"),
  liveExpand: $("liveExpand"), liveCollapse: $("liveCollapse"), uiLang: $("uiLang"),
};

// ---- i18n da interface (pt/en) ----
// Gettext-style (src/i18n.js): the pt-BR string in the code is the msgid.
// Static HTML is translated in place: [data-i18n] marks a text node and
// [data-i18n-attrs="title,placeholder"] marks attributes; the original pt
// value is captured on first pass so switching back is lossless.
const { t, tErr, setLang: setI18nLang } = window.LoroI18n;
function applyI18n() {
  setI18nLang(settings.uiLang);
  document.documentElement.setAttribute("lang", settings.uiLang === "en" ? "en" : "pt-br");
  document.querySelectorAll("[data-i18n]").forEach((n) => {
    if (!n.dataset.i18nSrc) n.dataset.i18nSrc = n.textContent.trim();
    n.textContent = t(n.dataset.i18nSrc);
  });
  document.querySelectorAll("[data-i18n-attrs]").forEach((n) => {
    for (const attr of n.dataset.i18nAttrs.split(",")) {
      const a = attr.trim();
      if (!a) continue;
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
  try { brainRefresh(); } catch (_) {}
  try { renderSelectionBar(); } catch (_) {}
  try { refreshTabFromDisk(MANUAL_REL); } catch (_) {} // manual follows uiLang
}

// painel ao vivo (dock): abre/fecha; abre sozinho ao começar a gravar
function setLivePanel(open) {
  el.surface.hidden = !open;
  if (el.liveExpand) el.liveExpand.textContent = open ? "⌄" : "⌃";
  if (open) requestAnimationFrame(() => resizeWave());
}

const state = {
  running: false, autoscroll: true, recordForDiarize: false, fileMode: false,
  meetingMode: false,
  lines: [], startTime: 0, timerId: null,
};

// ADR-0010 — the meeting lifecycle (record-then-transcribe). Distinct from the
// flat-file/live state: `active` gates the meeting-aware transcript-line and
// transcribe-state handlers, `phase` mirrors manifest.status, and transcript
// lines are accumulated then persisted below the marker via brain_meeting_append.
const meeting = {
  active: false, id: null, dir: null, livingRel: null, tema: null,
  phase: null, pendingLines: [], flushTimer: null,
  // ADR-0012 pseudo-stream: a best-effort tail-transcription interval fills the
  // living surface WHILE recording. `tailFrom` is the next window offset (ms).
  tailTimer: null, tailFrom: 0, tailBusy: false, tailStatus: "",
  // ADR-0012 model A: a rotating mic recorder — each ~N s segment is transcribed
  // and appended live, so the OPERATOR's speech shows in the stream (the system
  // tail above only covers the other participants). Audio is transient.
  previewRec: null, previewChunks: [], previewTimer: null,
};

// ---- configurações persistidas (localStorage) ----
const SETTINGS_KEY = "loro-settings";
const DEFAULTS = {
  model: "large-v3-turbo", lang: "pt", translate: false,
  autoscroll: true, autosave: false, saveDir: "", source: "mic", mode: "live", uiLang: "pt", termSide: false,
  sideW: 0, // sidebar width in px; 0 = the default CSS clamp (ADR-0002 §6)
  welcomeSeen: false, // first-launch feature tour (reopen via palette)
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
  el.autosave.checked = settings.autosave;
  el.source.value = settings.source;
  el.mode.value = settings.mode;
  state.autoscroll = settings.autoscroll;
  el.pickDir.textContent = settings.saveDir || "…";
  el.pickDir.title = settings.saveDir || t("Escolher pasta de armazenamento");
  if (el.uiLang) el.uiLang.value = settings.uiLang;
  applySideWidth();
  applyI18n();
}

// ADR-0002 §6 — sidebar width: 0 keeps the CSS clamp default; any px value is
// user-chosen (drag grip), clamped to [180, 45vw]. Wide sidebars reveal the
// per-row metadata line (.bmeta).
const SIDE_WIDE_AT = 300;
function applySideWidth() {
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

// ---- render ----
function render() {
  el.doc.innerHTML = state.lines.map((t) => `<p>${mdInline(esc(t))}</p>`).join("");
  const last = el.doc.lastElementChild;
  if (last) last.classList.add("new");
  const has = state.lines.length > 0;
  el.doc.hidden = !has;
  el.empty.hidden = has;
  if (state.autoscroll) el.surface.scrollTop = el.surface.scrollHeight;
}
function appendLine(text) { state.lines.push(text); render(); }

function toast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toast._t);
  if (ms) toast._t = setTimeout(() => (el.toast.hidden = true), ms);
}

// ---- timer ----
function fmt(s) {
  const m = Math.floor(s / 60), r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}
function startTimer() {
  state.startTime = Date.now();
  el.timer.textContent = "00:00";
  state.timerId = setInterval(() => {
    el.timer.textContent = fmt(Math.floor((Date.now() - state.startTime) / 1000));
  }, 1000);
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

// deviceLabel: p/ áudio do sistema, casa o dispositivo de entrada BlackHole
async function startAudio(deviceLabel) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    clog("getUserMedia unavailable — no audio meter"); setMeter("off"); return;
  }
  let constraints = { audio: true };
  if (deviceLabel) {
    try {
      // os labels de enumerateDevices só aparecem após uma permissão de áudio:
      // fazemos um "priming" e paramos o stream antes de casar o dispositivo certo
      let devs = await navigator.mediaDevices.enumerateDevices();
      if (!devs.some((x) => x.kind === "audioinput" && x.label)) {
        const prime = await navigator.mediaDevices.getUserMedia({ audio: true });
        prime.getTracks().forEach((t) => t.stop());
        devs = await navigator.mediaDevices.enumerateDevices();
      }
      const d = devs.find((x) => x.kind === "audioinput" && new RegExp(deviceLabel, "i").test(x.label));
      if (d && d.deviceId) constraints = { audio: { deviceId: { exact: d.deviceId } } };
      else {
        clog("meter: input '" + deviceLabel + "' not found — no wave");
        setMeter("nosignal"); return;
      }
    } catch (e) { clog("enumerateDevices error: " + e); setMeter("off"); return; }
  }
  audio.stream = await navigator.mediaDevices.getUserMedia(constraints);
  setMeter(settings.source === "meeting" ? "meeting" : (deviceLabel ? "system" : "mic"));
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
// indicador funcional da captura: mic / sistema / sem sinal / desligado
function setMeter(kind) {
  if (!el.privacy) return;
  const map = {
    mic: ["● mic", t("captando microfone")],
    system: [`● ${t("sistema")}`, t("captando áudio do computador (BlackHole)")],
    meeting: [`● ${t("reunião")}`, t("captando sua voz + áudio do computador (Loro Reunião)")],
    nosignal: [t("sem sinal"), t("não achei o dispositivo de captura — rode ./loro.sh sysaudio-setup")],
    off: [t("gravando"), t("gravando")],
  };
  const [txt, title] = map[kind] || map.off;
  el.privacy.textContent = txt;
  el.privacy.title = title;
  el.privacy.dataset.meter = kind;
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
// sistema => BlackHole; mic/reunião => padrão (a onda usa o microfone).
function meterLabelFor(source) {
  if (source === "system") return "blackhole";
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
  // fonte = áudio do sistema: resolve o dispositivo BlackHole (flag -c) a partir
  // da lista enumerada. mic => padrão do sistema (sem -c).
  if (settings.source === "system") {
    let devs;
    try {
      devs = await invoke("list_capture_devices");
    } catch (e) {
      toast(t("falha ao listar dispositivos"));
      clog("list_capture_devices error: " + e);
      return;
    }
    const pick = LoroAudio.pickCaptureDevice(devs, settings.source);
    if (pick.missing === "system") {
      openBlackholeSetup();
      clog("system source: BlackHole missing; devices=" + JSON.stringify(devs));
      return;
    }
    cfg.capture = pick.capture;
    clog("system source via #" + pick.capture);
  }
  clog("start: " + JSON.stringify(cfg));
  // 1) inicia a transcrição PRIMEIRO — não depende do microfone do webview
  try {
    await invoke("start", { cfg });
  } catch (e) {
    toast(t("não iniciou") + ": " + tErr(String(e)));
    clog("invoke start error: " + e);
    return;
  }
  // 2) medidor/onda (best-effort, nunca bloqueia): mic direto, ou o BlackHole no modo sistema
  const meterLabel = meterLabelFor(settings.source);
  startAudio(meterLabel).catch((e) => clog("startAudio failed (continuing without wave): " + e));
}
async function stopSession() {
  if (!state.running) return;
  if (meeting.active) return stopMeeting();
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
async function startMeetingSession(presetTema) {
  if (state.running || meeting.active) { toast(t("já há uma gravação em andamento")); return; }
  let temas = [];
  try { temas = (await invoke("brain_list_brainstorms")) || []; } catch (_) {}
  const choice = await pickMeeting(temas, presetTema);
  if (!choice || !choice.tema) return;
  return startMeetingWith(choice);
}
async function startMeetingWith(choice) {
  if (state.running || meeting.active) { toast(t("já há uma gravação em andamento")); return; }
  const cfg = currentCfg();
  clog("start (meeting ADR-0010): tema=" + choice.tema);
  let res;
  try {
    res = await invoke("brain_meeting_start", { input: { tema: choice.tema, titulo: choice.titulo, cfg } });
  } catch (e) {
    const msg = String(e);
    if (/permiss|tcc|grava|screen/i.test(msg)) toast(t("permita a Gravação de Tela nas Configurações e tente de novo"), 0);
    else toast(t("não iniciei a reunião") + ": " + tErr(msg));
    clog("brain_meeting_start error: " + e);
    return;
  }
  meeting.active = true; meeting.id = res.id; meeting.dir = res.dir;
  meeting.livingRel = res.livingRel; meeting.tema = choice.tema;
  meeting.phase = "recording"; meeting.pendingLines = [];
  state.meetingMode = true;
  await openDoc(res.livingRel, { preview: false }); // a aba é a superfície ao vivo
  // microfone via MediaRecorder (onda + audio/mic.webm); degrada p/ só-sistema se falhar
  try { await startAudio(undefined); }
  catch (e) { clog("startAudio (meeting) error — continuing with system audio only: " + e); }
  onStarted();
  startMeetingTail(); // ADR-0012: sistema (outros participantes) ao vivo
  startMeetingPreview(); // ADR-0012 modelo A: microfone (operador) ao vivo
  pessoalSig = ""; refreshPessoal();
  toast(t("reunião iniciada — a transcrição aparece durante a reunião"));
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
  meeting.tailFrom = 0; meeting.tailBusy = false;
  meeting.tailStatus = t("preview: iniciando…");
  meeting.tailTimer = setInterval(tickMeetingTail, MEETING_TAIL_MS);
}
function stopMeetingTail() {
  if (meeting.tailTimer) { clearInterval(meeting.tailTimer); meeting.tailTimer = null; }
  meeting.tailBusy = false;
}

// ADR-0012 model A: rotate a dedicated mic MediaRecorder (separate from the main
// one, on the same stream) so the operator's speech reaches the LIVE transcript.
// Each interval stops the current segment (its onstop transcribes it) and the
// next is spawned in onstop, giving continuous ~N s segments. Audio is transient.
function blobToBytes(blob) {
  return blob.arrayBuffer().then((b) => Array.from(new Uint8Array(b)));
}
// ms elapsed since the meeting/recording started (the shared session clock).
function meetingElapsedMs() {
  return state.startTime ? Math.max(0, Date.now() - state.startTime) : 0;
}
function spawnPreviewRec() {
  if (!audio.stream) return;
  const segStart = meetingElapsedMs(); // ADR-0013: this segment's start on the timeline
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
    onPreviewSegment(chunks, rec.mimeType || "audio/webm", segStart);
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
async function onPreviewSegment(chunks, mime, tMs) {
  if (!chunks || !chunks.length || !meeting.id) return;
  const id = meeting.id;
  try {
    const data = await blobToBytes(new Blob(chunks, { type: mime }));
    const res = await invoke("brain_meeting_transcribe_segment", { input: { id, data } });
    const text = LM.filterHallucinations((res && res.text) || "");
    if (text.trim() && meeting.id === id) {
      // ADR-0013: the operator's mic segment, timecoded so it interleaves with the
      // system windows in chronological order.
      try { await invoke("brain_meeting_append", { input: { id, chunk: text, tMs: tMs || 0, source: "mic" } }); setTailStatus(id, t("preview ao vivo ativo")); }
      catch (e) { clog("brain_meeting_append (mic) error: " + e); }
    } else {
      setTailStatus(id, t("preview: microfone sem fala substantiva ainda"));
    }
  } catch (e) {
    clog("brain_meeting_transcribe_segment error: " + e);
    setTailStatus(id, t("preview indisponível") + ": " + tErr(String(e)));
  }
}
async function tickMeetingTail() {
  if (!meeting.active || meeting.phase !== "recording" || !meeting.id) return;
  if (meeting.tailBusy) return; // never overlap a still-running window
  meeting.tailBusy = true;
  const id = meeting.id;
  const winStart = meeting.tailFrom; // ADR-0013: this system window's start on the timeline
  try {
    const res = await invoke("brain_meeting_transcribe_tail", { input: { id, fromMs: meeting.tailFrom } });
    if (!res) { setTailStatus(id, t("preview: sem resposta do backend")); return; }
    if (typeof res.nextMs === "number" && res.nextMs > meeting.tailFrom) meeting.tailFrom = res.nextMs;
    const raw = res.text || "";
    const text = LM.filterHallucinations(raw); // drop whisper silence-artifacts
    if (text.trim() && meeting.active && meeting.id === id) {
      // the other participants (system audio), timecoded by the window start.
      try { await invoke("brain_meeting_append", { input: { id, chunk: text, tMs: winStart || 0, source: "system" } }); setTailStatus(id, t("preview ao vivo ativo")); }
      catch (e) { clog("brain_meeting_append (tail) error: " + e); }
    } else if (raw.trim()) {
      // Houve áudio transcrito, mas só silêncio/ruído (alucinação de legenda) —
      // sinaliza captura OK porém sem fala; diferente de "sem áudio".
      setTailStatus(id, t("preview: só silêncio/ruído até agora (fale para testar a captura)"));
    } else {
      // Nenhum texto do backend: janela vazia ou áudio ainda não legível.
      setTailStatus(id, t("preview: aguardando áudio (sem novo trecho ainda)"));
    }
  } catch (e) {
    clog("brain_meeting_transcribe_tail error: " + e);
    setTailStatus(id, t("preview indisponível") + ": " + tErr(String(e)));
  } finally {
    meeting.tailBusy = false;
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
  stopMeetingTail();     // encerra o preview de sistema
  stopMeetingPreview();  // encerra o preview de mic (faz o flush do último segmento)
  const hadRecorder = !!(audio.recorder && audio.recorder.state !== "inactive");
  onStopped();
  if (!hadRecorder) finalizeMeeting();
}

// STOP (ADR-0012 modelo A): a transcrição JÁ foi montada ao vivo pelos segmentos
// de mic + janelas de sistema — NÃO há passe completo separado (duplicaria tudo).
// Aqui apenas encerramos os loops, paramos o sidecar de sistema e concluímos
// (monta o relatório + apaga todo o áudio; áudio é transiente).
async function finalizeMeeting() {
  stopMeetingTail();
  stopMeetingPreview(); // faz o flush do último segmento de mic (append assíncrono)
  audio.chunks = []; audio.recorder = null;
  state.meetingMode = false;
  const id = meeting.id;
  if (!id) return;
  meeting.phase = "transcribing";
  el.toggle.disabled = true;
  renderIfLiving(id);
  // encerra o sidecar de áudio do sistema (o mix é ignorado — áudio é transiente)
  try { await invoke("brain_meeting_stop", { input: { id } }); }
  catch (e) { clog("brain_meeting_stop error: " + e); }
  await finishMeetingAfterTranscription(); // monta o relatório + purga o áudio
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

// Conclusão: garante o flush final, monta o relatório (brain_meeting_build_notebook)
// e abre relatorio.md como aba. Reentrância protegida por meeting.active.
async function finishMeetingAfterTranscription() {
  if (!meeting.active) return;
  meeting.active = false; meeting.phase = "done"; // reentrancy guard set synchronously
  const id = meeting.id;
  if (meeting.flushTimer) { clearTimeout(meeting.flushTimer); meeting.flushTimer = null; }
  await flushMeetingLines();
  el.toggle.disabled = false;
  el.privacy.classList.remove("warn");
  updatePrivacy();
  let rel = null;
  if (id) {
    try { const r = await invoke("brain_meeting_build_notebook", { id }); rel = r && r.rel; }
    catch (e) { toast(t("não montei o relatório") + ": " + tErr(String(e))); clog("build_notebook error: " + e); }
    // Áudio é transiente (decisão do dono): apaga após a transcrição autoritativa.
    try { await invoke("brain_meeting_purge_audio", { input: { id } }); }
    catch (e) { clog("brain_meeting_purge_audio error: " + e); }
  }
  pessoalSig = ""; refreshPessoal();
  renderIfLiving(id);
  if (rel) { toast(t("relatório pronto")); openDoc(rel, { preview: false }); }
  else if (id) toast(t("reunião encerrada"));
}

// Resolve o completoRel (relativo ao acervo) num caminho de arquivo para a
// transcrição existente (ADR-0010: stop devolve rel e não transcreve).
async function acervoFsPath(rel) {
  const cfg = await invoke("brain_get_config");
  const base = (cfg && cfg.brainDir) || "";
  return LM.acervoJoin(base, rel);
}

// Marcadores PII-free (BR-8): tipo + timecode a partir do relógio da sessão.
async function markMeeting(tipo) {
  if (!meeting.active || !meeting.id) { toast(t("nenhuma reunião em andamento")); return; }
  const tMs = state.startTime ? Math.max(0, Date.now() - state.startTime) : 0;
  try { await invoke("brain_meeting_marker", { input: { id: meeting.id, tipo, tMs } }); toast(t("marcado") + ": " + tipo); }
  catch (e) { toast(tErr(String(e))); clog("brain_meeting_marker error: " + e); }
}

// paleta: "nova reunião" (independe do seletor de fonte) · "abrir relatório".
// presetTema pins the brainstorming when the flow starts from its sidebar row.
function startMeetingFlow(presetTema) {
  if (state.running || meeting.active) { toast(t("já há uma gravação em andamento")); return; }
  startMeetingSession(presetTema);
}
// ADR-0013: general Q&A over the acervo. Any question is answered from the
// versioned contexts (local base) first, MCP/external only after (the /loro-ask
// skill enforces the order). Injects into the terminal Claude, like the meeting
// skills — the answer appears in the terminal. Not meeting-scoped.
function askAcervo(ctx) {
  const scope = ctx
    ? `<p class="pmnote mono">${t("a pergunta fica ancorada neste contexto")}: <b>${esc(ctx)}</b></p>`
    : "";
  openModal(
    ctx ? t("Perguntar ao contexto") : t("Perguntar ao acervo"),
    scope +
      `<p class="pmnote mono">${t("A resposta vem primeiro dos contextos (a base de conhecimento) e, se preciso, de conectores MCP. Roda no Claude do terminal.")}</p>` +
      `<label class="wfield"><span class="mono">${t("pergunta")}</span>` +
      `<input id="askInput" type="text" placeholder="${t("ex.: qual a política de multas da frota?")}" spellcheck="false"></label>`,
    t("perguntar"),
    () => {
      const q = (($("askInput") && $("askInput").value) || "").trim();
      const cmd = LoroBrainstorm.brainAskCmd(q, ctx);
      if (!cmd) { toast(t("digite uma pergunta")); return; }
      termRunAgent(cmd);
      toast(t("pergunta enviada ao agente do terminal — a resposta aparece abaixo"), 4000);
    }
  );
  const inp = $("askInput"); if (inp) inp.focus();
}

async function buildAndOpenReport(explicitId) {
  let id = explicitId || meeting.id;
  if (!id) { const rel = currentRel(); id = rel ? (LM.livingId(rel) || LM.reportId(rel)) : null; }
  if (!id) { toast(t("abra uma reunião para gerar o relatório")); return; }
  try {
    const r = await invoke("brain_meeting_build_notebook", { id });
    if (r && r.rel) openDoc(r.rel, { preview: false });
    toast(t("relatório pronto"));
    pessoalSig = ""; refreshPessoal();
  }
  catch (e) { toast(t("não montei o relatório") + ": " + tErr(String(e))); clog("build_notebook error: " + e); }
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
  state.running = true;
  requestAnimationFrame(() => resizeWave());
  el.dot.classList.add("on");
  el.toggle.classList.add("on", "recording");
  // reunião: a transcrição vive na aba reuniao.md, não no painel do rodapé (ADR-0010)
  if (!meeting.active) setLivePanel(true);
  el.savebar.hidden = true;
  startTimer();
}
function onStopped() {
  if (!state.running) return;
  state.running = false;
  el.dot.classList.remove("on");
  el.toggle.classList.remove("on", "recording");
  stopTimer();
  // ADR-0013: clear the elapsed clock so a NEW recording never looks like it
  // resumes from the last session's time.
  state.startTime = 0;
  el.timer.textContent = "00:00";
  stopAudio();
  updatePrivacy();
  if (!state.lines.length) return;
  if (settings.autosave) autoSaveNow();
  else { el.savebar.hidden = false; setLivePanel(true); }
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
  state.running ? stopSession() : startRecordFlow();
}

// ● never starts a loose recording (owner decision 2026-07-28): like every
// other flow, it first asks WHERE the result will live — a brainstorming
// (meeting) or an explicit one-off transcription (the old savebar flow).
async function startRecordFlow() {
  if (state.running || meeting.active) return;
  if (settings.source === "meeting") return startMeetingSession(); // already asks
  let temas = [];
  try { temas = (await invoke("brain_list_brainstorms")) || []; } catch (_) {}
  const choice = await pickMeeting(temas, null, { allowLoose: true });
  if (!choice) return;
  if (choice.tema) return startMeetingWith(choice);
  return startSession(); // explicit one-off: current live/file flow + savebar
}

// ---- salvar / descartar / limpar ----
async function save() {
  const content = state.lines.join("\n\n") + "\n";
  try {
    const path = await invoke("save_transcript", { content });
    if (path) { toast(t("salvo")); el.savebar.hidden = true; clearDoc(); }
  } catch (e) { toast(t("falha ao salvar")); clog("save error: " + e); }
}
function discard() { el.savebar.hidden = true; }
// limpa buffer de transcrição E o timer (sessão salva começa do zero)
function clearDoc() { state.lines = []; render(); el.savebar.hidden = true; el.timer.textContent = "00:00"; }

// ---- popover do menu + folha de configurações ----
const cfgWrap = $("cfgWrap"), cfgClose = $("cfgClose"), acervoDir = $("acervoDir");
async function openCfg() {
  cfgWrap.hidden = false;
  try {
    const cfg = await invoke("brain_get_config");
    acervoDir.textContent = cfg ? cfg.brainDir : t("não configurado — crie um projeto");
    acervoDir.title = cfg ? cfg.brainDir : "";
  } catch (_) { acervoDir.textContent = "—"; }
  // seção projeto: nome ativo + paleta de cores
  const cur = acervos.find((a) => a.id === activeAcervo);
  $("cfgProj").textContent = cur ? cur.name : "—";
  drawProjColors(cur);
  // ADR-0006: autoContext tem efeito real no loop — dá para desligar aqui
  const autoCtx = $("cfgAutoContext");
  if (autoCtx) autoCtx.checked = !!(cur && cur.autoContext);
  // sem pasta escolhida: mostra o destino padrão real (inbox do acervo)
  if (!settings.saveDir) {
    try { el.pickDir.textContent = await invoke("default_save_dir"); } catch (_) {}
  }
}
function drawProjColors(cur) {
  renderSwatches($("projColors"), cur ? cur.color : "", async (hex) => {
    applyAccent(hex);
    if (!cur) return;
    try {
      const av = await invoke("brain_set_color", { id: cur.id, color: hex });
      acervos = av.acervos || [];
      const updated = acervos.find((a) => a.id === cur.id);
      drawProjColors(updated);
    } catch (e) { toast(tErr(String(e))); }
  });
}
function closeCfg() { cfgWrap.hidden = true; }
cfgClose.addEventListener("click", closeCfg);
{
  const autoCtx = $("cfgAutoContext");
  if (autoCtx) autoCtx.addEventListener("change", async () => {
    try {
      await invoke("brain_set_auto_context", { value: autoCtx.checked });
      const cur = acervos.find((a) => a.id === activeAcervo);
      if (cur) cur.autoContext = autoCtx.checked;
    } catch (e) { toast(tErr(String(e))); autoCtx.checked = !autoCtx.checked; }
  });
}
cfgWrap.addEventListener("click", (e) => { if (e.target === cfgWrap) closeCfg(); });
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !cfgWrap.hidden) closeCfg(); });

function updateCfgLabel() {
  const m = el.model.value === "large-v3-turbo" ? "turbo" : "small";
  const src = { system: t("áudio do sistema"), meeting: t("reunião") }[el.source.value] || t("microfone");
  const modeLabel = el.mode.value === "file" ? t("gravar tudo") : t("ao vivo");
  const sum = $("cfgSummary");
  if (sum) sum.textContent = `${el.lang.value} · ${m} · ${src} · ${modeLabel}`;
  el.cfgBtn.title = `${t("Configurações")} — ${el.lang.value} · ${m} · ${modeLabel}`;
}
function updatePrivacy() {
  el.privacy.classList.remove("warn");
  delete el.privacy.dataset.meter;
  if (state.recordForDiarize || state.fileMode || state.meetingMode) { el.privacy.textContent = t("grava áudio"); el.privacy.classList.add("warn"); }
  else if (settings.autosave) { el.privacy.textContent = "auto-save"; }
  else { el.privacy.textContent = t("sem gravar"); }
}

// ---- wiring ----
el.toggle.addEventListener("click", toggle);
el.cfgBtn.addEventListener("click", openCfg);
if ($("helpBtn")) $("helpBtn").addEventListener("click", () => openDoc(MANUAL_REL, { preview: false }));
if (el.uiLang) el.uiLang.addEventListener("change", async (e) => {
  settings.uiLang = e.target.value; persistSettings();
  try { settings.uiLang = await invoke("ui_set_lang", { lang: e.target.value }); } catch (_) {}
  applyI18n();
  rerenderForLang();
});
el.saveBtn.addEventListener("click", save);
el.discardBtn.addEventListener("click", discard);
el.clearBtn.addEventListener("click", clearDoc);
el.optScroll.addEventListener("change", (e) => {
  state.autoscroll = e.target.checked;
  settings.autoscroll = e.target.checked; persistSettings();
});
el.optTop.addEventListener("change", (e) => { if (getWin) getWin().setAlwaysOnTop(e.target.checked); });
el.optOverlay.addEventListener("change", (e) => invoke("toggle_overlay", { show: e.target.checked }));
el.optDiar.addEventListener("change", (e) => { state.recordForDiarize = e.target.checked; updatePrivacy(); });
el.source.addEventListener("change", () => { settings.source = el.source.value; persistSettings(); updateCfgLabel(); });
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
  dirBtn: $("brainDirBtn"), ctxInput: $("brainCtxInput"), createBtn: $("brainCreateBtn"),
  nameInput: $("brainNameInput"), autoInput: $("brainAuto"), gitInput: $("brainGit"),
  agentInput: $("brainAgentInput"), wizTemplates: $("wizTemplates"), wizTemplateHint: $("wizTemplateHint"),
  cancelBtn: $("brainCancelBtn"), wizTitle: $("wizTitle"), setupErr: $("brainSetupErr"),
  acervoBtn: $("acervoBtn"), acervoName: $("acervoName"), acervoMenu: $("acervoMenu"),
  gitBtn: $("gitBtn"), branchBtn: $("branchBtn"), proposeBtn: $("proposeBtn"), bMenu: $("bMenu"),
  ghCard: $("ghCard"), ghState: $("ghState"), ghChecks: $("ghChecks"),
  ghNotif: $("ghNotif"), ghCheck: $("ghCheck"),
  navHome: $("navHome"), navQueue: $("navQueue"), navCtx: $("navCtx"),
  navSources: $("navSources"), navPessoal: $("navPessoal"), queueCount: $("navQueueCount"),
  home: $("bHome"), docWrap: $("bDocWrap"), doc: $("brainDoc"),
  crumb: $("bCrumb"), badge: $("bBadge"), modes: $("bModes"),
  viewBtn: $("bViewBtn"), editBtn2: $("bEditBtn"), editHost: $("bEditHost"),
  gitBadge: $("bGit"),
  wsTabs: $("wsTabs"), wsBody: $("wsBody"),
  cmdk: $("cmdk"), cmdkInput: $("cmdkInput"), cmdkList: $("cmdkList"),
  find: $("bFind"), findInput: $("bFindInput"), findCount: $("bFindCount"),
  findPrev: $("bFindPrev"), findNext: $("bFindNext"), findClose: $("bFindClose"),
  stInbox: $("stInbox"), stDone: $("stDone"), stCtx: $("stCtx"), stSrc: $("stSrc"),
  activity: $("brainActivity"),
  editWrap: $("editWrap"), editArea: $("editArea"), editTitle: $("editTitle"),
  editSave: $("editSave"), editCancel: $("editCancel"), editClose: $("editClose"),
};
let brainTab = false, brainPoll = null, brainDir = "", lastSt = null;
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
// usage template picker state (ADR-0003): selected id, fetched list, and
// whether the user already edited the contexts field by hand
let wizTemplate = "generico", wizTemplates = [], wizCtxDirty = false;
let lastEnvAcervo = null;

// paleta curada (funciona no claro e no escuro); "" = padrão (teal do tema)
const PALETTE = [
  { name: "teal", hex: "" }, { name: "azul", hex: "#2f6feb" },
  { name: "roxo", hex: "#8957e5" }, { name: "âmbar", hex: "#bf8700" },
  { name: "verde", hex: "#2da44e" }, { name: "rosa", hex: "#cf4b8f" },
];
// aplica a cor de acento do projeto ativo (var --accent; "" volta ao teal)
function applyAccent(hex) {
  const root = document.documentElement.style;
  if (hex) root.setProperty("--accent", hex); else root.removeProperty("--accent");
}
function renderSwatches(container, current, onPick) {
  if (!container) return;
  container.innerHTML = PALETTE.map((c) =>
    `<button class="swatch${(current || "") === c.hex ? " on" : ""}" title="${t(c.name)}"
      data-hex="${c.hex}" style="--sw:${c.hex || "var(--teal)"}"></button>`).join("");
  container.querySelectorAll("[data-hex]").forEach((b) => (b.onclick = () => onPick(b.dataset.hex, b)));
}

function closeFloat() { B.bMenu.hidden = true; B.acervoMenu.hidden = true; }
// cliques DENTRO do menu nunca chegam ao clique-fora (mesmo com innerHTML trocado)
B.bMenu.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", (e) => {
  if (!e.target.closest("#bMenu") && !e.target.closest("[data-qmenu]") && !e.target.closest("[data-cmenu]")) B.bMenu.hidden = true;
  if (!e.target.closest("#acervoSwitch")) B.acervoMenu.hidden = true;
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
      li("Fluxo em três passos: Brainstorming → Fila → Contexto — junte ideias, eleja o que importa e gere conhecimento versionado.") +
      li("● grava reuniões ou transcrições avulsas — 100% local; o áudio nunca sai da sua máquina.") +
      li("Modelos de uso (vendas, engenharia, saúde…) moldam os contextos e as regras do acervo na criação.") +
      li("O agente de IA é escolha sua por acervo: claude por padrão, ou qualquer CLI — inclusive modelos locais.") +
      li("Analise reuniões, pergunte ao acervo ou a um contexto, e crie/evolua notas com IA (✦) direto da lateral.") +
      li("⌘/Ctrl+Shift+P abre a paleta de comandos — e todo comando tem um atalho ⌘/Ctrl+⌥.") +
    `</ul>` +
      `<p class="pmnote mono"><button id="welcomeManual" class="link mono strong">${t("abrir manual")}</button></p>`,
    t("começar"),
    () => {}
  );
  const m = $("welcomeManual");
  if (m) m.onclick = () => { closeModal(); openDoc(MANUAL_REL, { preview: false }); };
  settings.welcomeSeen = true; persistSettings();
}

// o acervo é a tela principal (sempre ativo); a transcrição vive no player (dock)
function initBrain() {
  brainTab = true;
  brainRefresh();
  if (!brainPoll) brainPoll = setInterval(brainRefresh, 10000);
  if (!settings.welcomeSeen) setTimeout(showWelcome, 600);
}
if (el.liveExpand) el.liveExpand.addEventListener("click", () => setLivePanel(el.surface.hidden));
el.liveCollapse.addEventListener("click", () => setLivePanel(false));

// ---- editor reutilizável (pendentes da fila / instruções do loop) ----
let editOnSave = null;
function openEditor(title, content, onSave) {
  B.editTitle.textContent = title;
  B.editArea.value = content || "";
  editOnSave = onSave;
  B.editWrap.hidden = false;
  B.editArea.focus();
}
function closeEditor() { B.editWrap.hidden = true; editOnSave = null; }
B.editClose.addEventListener("click", closeEditor);
B.editCancel.addEventListener("click", closeEditor);
B.editWrap.addEventListener("click", (e) => { if (e.target === B.editWrap) closeEditor(); });
B.editSave.addEventListener("click", async () => {
  if (!editOnSave) return closeEditor();
  try { await editOnSave(B.editArea.value); closeEditor(); sideSig = ""; brainRefresh(); }
  catch (e) { toast(tErr(String(e))); clog("editor save error: " + e); }
});
$("guideBtn").addEventListener("click", () => openGuideDoc());
{ const ab = $("askBtn"); if (ab) ab.addEventListener("click", askAcervo); }
// ADR-0013: "gerar contexto" — the fila → contexto step. Injects /loro-context
// into the terminal Claude (the /loro-context loop), which processes the whole
// queue into versioned contexts. Same terminal-skill pattern as analisar/responder.
// One function, two entry points: the home card CTA and the sidebar quick action.
// ADR-0007: "salvar anexos" is opt-in per run — reuses the existing _prompt.md
// guide plumbing (brain_read_guide/brain_write_guide) instead of new backend
// surface; the loop already archives/clears _prompt.md after each run (step 0
// of /loro-context), so this instruction is naturally one-shot.
const ANEXOS_GUIDE_LINE = "Nesta rodada, copie os anexos referenciados pelos itens processados para contextos/<c>/anexos/ (por item, use o contexto de destino desse item).";
async function genContextNow() {
  // ADR-0002 §5: an empty queue is refused loudly here, not just by disabled
  // buttons — there is nothing to generate context FROM, and the user must know.
  if (!lastSt || !lastSt.inbox || !lastSt.inbox.length) {
    toast(t("a fila está vazia — envie um relatório ou arquivos antes de gerar contexto"), 5000);
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
  termRunAgent(LoroBrainstorm.brainContextCmd());
  toast(t("gerando contexto no agente do terminal — acompanhe abaixo"), 4000);
}
{
  const gen = $("queueGenCtx");
  if (gen) gen.addEventListener("click", genContextNow);
}

const fmtWhen = (ms) => new Date(ms).toLocaleString(uiLocale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
// editável no app = só pendentes de texto na fila; o resto é gerado pelo loop
const isEditable = (p) => p.startsWith("inbox/") && /\.(md|txt)$/i.test(p);
const shortName = (n) => n.replace(/\.(md|txt)$/i, "").replace(/^\d{4}-\d{2}-\d{2}--?/, "");

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
  B.setup.hidden = !showWizard;
  B.shell.hidden = showWizard;
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
    if (g.available) {
      B.gitBtn.textContent = g.repo ? (g.pending ? `${t("versionar")} (${g.pending})` : `${t("versionado")} ✓`) : t("iniciar git");
      B.gitBtn.classList.toggle("warm", g.repo && g.pending > 0);
    }
    // ADR-0002 §2: the current branch is always visible; click to switch/create
    if (B.branchBtn) {
      B.branchBtn.hidden = !(g.available && g.repo && g.branch);
      if (g.branch) B.branchBtn.textContent = "⎇ " + g.branch;
    }
  }).catch(() => { B.gitBtn.hidden = true; if (B.branchBtn) B.branchBtn.hidden = true; });
  // GitHub: re-verifica o ambiente ao trocar de acervo (rede — só uma vez por acervo)
  if (activeAcervo !== lastEnvAcervo) { lastEnvAcervo = activeAcervo; envChecked = false; }
  refreshEnv();
  // seletor de contexto do envio (preserva escolha)
  const sel = $("importCtx"), chosen = sel.value;
  sel.innerHTML = `<option value="">${t("contexto")}: ${t("automático")}</option>` +
    st.contexts.map((c) => `<option value="${esc(c.name)}">${t("contexto")}: ${esc(c.name)}</option>`).join("");
  sel.value = chosen && st.contexts.some((c) => c.name === chosen) ? chosen : "";
  // lateral: só re-renderiza quando os dados mudam (preserva expansões profundas)
  const sig = JSON.stringify([st.inbox.map((f) => f.name), st.contexts, st.reunioes.length, st.notas.length]);
  if (sig !== sideSig) { sideSig = sig; renderSidebar(st); }
  refreshPessoal();   // ADR-0009: produção (mundo pessoal) — self-gated por assinatura
  refreshTools();     // ADR-0006: ferramentas customizadas — self-gated por assinatura
  markSel();
}

// ---- visão geral (home) ----
function renderHome(st) {
  B.stInbox.textContent = st.inbox.length;
  B.stDone.textContent = st.processed;
  B.stCtx.textContent = st.contexts.length;
  B.stSrc.textContent = st.reunioes.length + st.notas.length;
  // subtítulo (pasta) + frase-pulso
  $("bSub").textContent = st.dir;
  const lastAct = (st.activity || "").split("\n")[0].match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
  const n = st.inbox.length;
  $("bPulse").textContent = n
    ? `${n} ${n > 1 ? t("itens na fila") : t("item na fila")}`
    : (lastAct ? `${t("em dia · último processamento")} ${lastAct[1].slice(5)}` : t("em dia — envie um relatório do brainstorming ou arquivos"));
  $("bPulse").classList.toggle("warm", n > 0);
  // card da fila: o CTA só chama quando HÁ o que processar; o card "acende"
  // (borda quente) para o próximo passo ficar evidente sem ler nada.
  const gen = $("queueGenCtx");
  if (gen) {
    gen.disabled = !n;
    gen.title = n
      ? t("Processa a fila com o Claude (/loro-context): cada item vira/atualiza um contexto versionado")
      : t("a fila está vazia — selecione partes no brainstorming ou envie arquivos");
  }
  const qc = $("queueCard");
  if (qc) qc.classList.toggle("warm", n > 0);
  // fila (top 4, acionável)
  const q = $("homeQueue");
  q.innerHTML = st.inbox.length
    ? st.inbox.slice(0, 4).map((f) => {
        const ed = /\.(md|txt)$/i.test(f.name);
        return `<div class="qrow unsynced" title="${t("não sincronizado (aguardando o loop)")}"><span class="qname mono" ${ed ? `data-doc="inbox/${esc(f.name)}"` : ""}>${ed ? "✎ " : ""}${esc(f.name)}</span>
          <button class="rowmenu" data-qmenu="${esc(f.name)}" title="${t("ações")}">⋯</button></div>`;
      }).join("") + (st.inbox.length > 4 ? `<div class="bempty">+ ${st.inbox.length - 4} ${t("na lateral")}</div>` : "")
    : `<div class="bempty">${t("vazia — selecione partes no brainstorming ou arraste arquivos abaixo")}</div>`;
  q.querySelectorAll("[data-doc]").forEach((el2) => (el2.onclick = () => openDoc(el2.dataset.doc)));
  q.querySelectorAll("[data-qmenu]").forEach((el2) => (el2.onclick = (e) => { e.stopPropagation(); openQueueMenu(el2, el2.dataset.qmenu); }));
  // contextos mais ativos (barras)
  const top = [...st.contexts].sort((a, b) => (b.entries + b.ideas) - (a.entries + a.ideas)).slice(0, 5);
  const max = Math.max(1, ...top.map((c) => c.entries + c.ideas));
  $("homeBars").innerHTML = top.some((c) => c.entries + c.ideas)
    ? top.map((c) => `<div class="hbar" data-hctx="${esc(c.name)}">
        <span class="hname mono">${esc(c.name)}</span>
        <span class="htrack"><span class="hfill" style="width:${Math.round(((c.entries + c.ideas) / max) * 100)}%"></span></span>
        <span class="hval mono">${c.entries}${c.ideas ? ` <i>+${c.ideas}🌱</i>` : ""}</span>
      </div>`).join("")
    : `<div class="bempty">${t("os guias crescem conforme o loop processa")}</div>`;
  $("homeBars").querySelectorAll("[data-hctx]").forEach((el2) =>
    (el2.onclick = () => openDoc(`contextos/${el2.dataset.hctx}/context.md`)));
  // atividade como feed
  const feed = (st.activity || "").split("\n").filter(Boolean);
  B.activity.innerHTML = feed.length
    ? feed.map((l) => {
        const m = l.match(/^(\d{4}-\d{2}-\d{2} )?(\d{2}:\d{2})?\s*·?\s*(.*)$/);
        const time = m && m[2] ? m[2] : "";
        const txt = m ? m[3] : l;
        return `<div class="fitem"><span class="fdot"></span><span class="ftime mono">${esc(time)}</span><span class="ftxt">${esc(txt)}</span></div>`;
      }).join("")
    : `<div class="bempty">${t("o loop ainda não rodou — use /loop 1h /loro-context no Claude Code")}</div>`;
}

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
  // habilidades (ADR-0007) — a bolt, the same icon language as the rest of
  // this set (no emoji: 🧰 read inconsistently across platforms/fonts).
  skill: "M11 21l1-9H7l6-11-1 9h5l-6 11z",
  // custom habilidade — a star, so a user-authored skill reads differently
  // from a built-in one (bolt) at a glance.
  customskill: "M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8-6.1-3.4-6.1 3.4 1.4-6.8-5.1-4.7 6.9-.8z",
};
function ico(name, extra = "") {
  const d = ICONS[name] || ICONS.file;
  return `<span class="nico ${extra}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg></span>`;
}
// classe de status git (estilo VSCode) para um caminho do acervo
// há mudança não commitada em algum arquivo sob este contexto/subárvore?
function ctxDirty(path) {
  const pre = "contextos/" + path + "/";
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
function renderCtxForest(root) {
  return [...root.children.values()].sort((a, b) => a.seg.localeCompare(b.seg)).map(renderCtxNode).join("");
}
function renderCtxNode(node) {
  const key = "ctx:" + node.path, open = bOpen.has(key);
  const tw = ""; // sem setas laterais: expansão pelo clique; hierarquia pela indentação
  const icon = node.isCtx ? ico("context", "ac") : ico("folder", "ac");
  const nctx = node.isCtx ? (lastSt ? lastSt.contexts : []).find((c) => c.name === node.path) : null;
  // em vez da contagem de entradas do CHANGELOG (confundia), um ponto quando há
  // mudança não commitada na subárvore deste contexto (ADR-0007).
  const dot = ctxDirty(node.path) ? `<span class="gdot" title="${t("mudanças não commitadas")}">●</span>` : "";
  const pills = (node.isCtx && nctx && nctx.seeded === false
    ? `<span class="pill soft" title="${t("pasta nova — clique para estruturar")}">${t("novo")}</span>` : "") + dot;
  const attr = node.isCtx ? `data-ctx="${esc(node.path)}"` : `data-fold="${esc(node.path)}"`;
  const kids = [...node.children.values()].sort((x, y) => x.seg.localeCompare(y.seg)).map(renderCtxNode).join("");
  const holder = node.isCtx ? `<div class="bchild" data-ctxchild="${esc(node.path)}" ${open ? "" : "hidden"}></div>` : "";
  const arch = `<button class="rowmenu" data-cmenu="${esc(node.path)}" data-isctx="${node.isCtx ? 1 : 0}"
      title="${t("ações")} (${node.isCtx ? t("contexto") : t("pasta")}: ${t("renomear, mover, deletar")})">⋯</button>`;
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
          <button class="rowmenu" data-qmenu="${esc(f.name)}" data-move="${esc(f.name)}" title="${t("ações")}">⋯</button></div>`;
      }).join("") +
      `<div class="bitem addctx" data-genctx title="${t("Processa a fila com o Claude (/loro-context)")}">▶ ${t("gerar contexto")}</div>`
    : `<div class="bempty">${t("vazia — envie um relatório ou arquivos para gerar contexto")}</div>`;
  // contextos como ÁRVORE: pastas/áreas agrupam; contextos reais abrem o guia.
  // Criação vive no ＋ do cabeçalho da seção (linhas cheias poluíam a árvore).
  B.navCtx.innerHTML =
    st.contexts.length
      ? renderCtxForest(buildCtxTree(st.contexts))
      : `<div class="bempty">${t("nenhum contexto ainda — crie o primeiro para organizar o conhecimento")}</div>`;
  // fontes agrupadas por mês (escala p/ listas grandes)
  B.navSources.innerHTML = [["reunioes", st.reunioes], ["notas", st.notas]].map(([kind, files]) => {
    if (!files.length) return "";
    const kKey = "src:" + kind, kOpen = bOpen.has(kKey);
    const groups = groupMonths(files);
    const inner = [...groups.entries()].map(([m, fs]) => {
      const gKey = kKey + ":" + m, gOpen = bOpen.has(gKey);
      return `<div class="bitem grp${gOpen ? " open" : ""}" data-toggle="${gKey}">
          ${ico("folder")}<span class="bn">${esc(m)}</span><span class="pill">${fs.length}</span></div>
        <div class="bchild" ${gOpen ? "" : "hidden"}>` +
        fs.map((f) => `<div class="bitem file ${gitClass(f.path)}" data-doc="${esc(f.path)}" title="${esc(f.name)}">${ico("file")}<span class="bn">${esc(shortName(f.name))}${bMeta(f.mtime, f.path)}</span></div>`).join("") +
        `</div>`;
    }).join("");
    return `<div class="bitem ctx${kOpen ? " open" : ""}" data-toggle="${kKey}">
        ${ico(kind === "reunioes" ? "meeting" : "note", "ac")}<span class="bn">${kind === "reunioes" ? t("reuniões") : t("notas")}</span><span class="pill">${files.length}</span></div>
      <div class="bchild" ${kOpen ? "" : "hidden"}>${inner}</div>`;
  }).join("") || `<div class="bempty">${t("reuniões e notas aparecem aqui quando o loop processar a fila")}</div>`;
  wireSidebar();
  // re-carrega filhos dos contextos abertos
  for (const c of st.contexts) if (bOpen.has("ctx:" + c.name)) loadCtxChildren(c.name);
}

function wireSidebar() {
  B.main.querySelectorAll("[data-doc]").forEach((el2) => {
    // single-click opens an ephemeral preview tab; double-click promotes it (ADR-0008)
    el2.onclick = (e) => { if (e.target.closest("[data-qmenu]")) return; openDoc(el2.dataset.doc, { preview: true }); };
    el2.ondblclick = (e) => { if (e.target.closest("[data-qmenu]")) return; openDoc(el2.dataset.doc, { preview: false }); };
  });
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
      openDoc(`contextos/${name}/context.md`);
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
  B.main.querySelectorAll("[data-genctx]").forEach((el2) => (el2.onclick = genContextNow));
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
  // ADR-0007: folder groups (folderGroupHtml) in the context tree toggle via
  // [data-pestoggle] just like in the brainstorming tree — expand/collapse the
  // next sibling (.bchild) in place, no full re-render.
  B.navCtx.querySelectorAll("[data-pestoggle]").forEach((el2) => (el2.onclick = () => {
    const key = el2.dataset.pestoggle, child = el2.nextElementSibling;
    if (bOpen.has(key)) { bOpen.delete(key); el2.classList.remove("open"); if (child) child.hidden = true; }
    else { bOpen.add(key); el2.classList.add("open"); if (child) child.hidden = false; }
  }));
  // ADR-0007: a context's anexos folder actions — create a note / import files.
  B.navCtx.querySelectorAll("[data-ctxaddnota]").forEach((el2) => (el2.onclick = (e) => {
    e.stopPropagation(); promptNewNoteInContext(el2.dataset.ctxaddnota, el2);
  }));
  B.navCtx.querySelectorAll("[data-ctxaddanexo]").forEach((el2) => (el2.onclick = (e) => {
    e.stopPropagation();
    const name = el2.dataset.ctxaddanexo;
    importAnexoFromComputer(`contextos/${name}/anexos`, () => {
      bOpen.add(`ctxfolder:${name}:anexos`); loadCtxChildren(name);
    });
  }));
  wireDrag();
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
  try { entries = await invoke("brain_list_dir", { rel: "contextos/" + name }); } catch (_) { return; }
  // subpastas que já são subdomínios (contextos) aparecem na ÁRVORE de contextos;
  // não as repetimos aqui como "pasta" — visualização única (ADR-0007).
  const ctxSet = new Set((lastSt && lastSt.contexts ? lastSt.contexts : []).map((c) => c.name));
  const pretty = { "context.md": t("contexto"), "guia.md": t("guia do domínio"), "CHANGELOG.md": t("histórico"), CODEOWNERS: t("donos"), brainstorming: "brainstorming", incubadora: "brainstorming", referencias: t("referências") };
  const order = (n) => n === "context.md" ? 0 : n === "guia.md" ? 0 : n === "CHANGELOG.md" ? 1 : n === "referencias" ? 2 : 3;
  entries.sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name));
  let html = "";
  for (const en of entries) {
    if (en.name === "anexos") continue; // ADR-0007: renderizado explicitamente abaixo, sempre visível
    if (en.dir) {
      if (ctxSet.has(name + "/" + en.name)) continue; // subdomínio: já está na árvore
      let files = [];
      try { files = await invoke("brain_list_dir", { rel: en.path }); } catch (_) {}
      files = files.filter((f) => !f.dir);
      if (!files.length) continue;
      html += `<div class="bitem grp open"><span class="tw">▾</span>${ico(fileIcon(en.name, true), "ac")}<span class="bn">${esc(pretty[en.name] || en.name)}</span><span class="pill">${files.length}</span></div><div class="bchild">` +
        files.map((f) => `<div class="bitem file ${gitClass(f.path)}" data-doc="${esc(f.path)}">${ico("file")}<span class="bn">${esc(shortName(f.name))}</span></div>`).join("") + `</div>`;
    } else {
      html += `<div class="bitem file ${gitClass(en.path)}" data-doc="${esc(en.path)}">${ico(fileIcon(en.name, false))}<span class="bn">${esc(pretty[en.name] || en.name)}</span></div>`;
    }
  }
  // ADR-0007: um contexto também tem uma pasta `anexos/` — sempre visível, com
  // as mesmas ações de um brainstorming (＋ nova nota, ＋ do computador),
  // versionadas junto com o contexto.
  let anexos = [];
  try { anexos = ((await invoke("brain_list_dir", { rel: `contextos/${name}/anexos` })) || []).filter((f) => !f.dir); }
  catch (_) {}
  const anexRows = anexos.map((f) => `<div class="bitem file ${gitClass(f.path)}" data-doc="${esc(f.path)}" title="${esc(f.name)}">${ico("file")}<span class="bn">${esc(shortName(f.name))}</span></div>`).join("");
  const anexActions =
    `<button class="bsaddbtn" data-ctxaddnota="${esc(name)}" title="${t("Escrever uma nota nos anexos deste contexto")}">＋ ${t("nova nota")}</button>` +
    `<button class="bsaddbtn" data-ctxaddanexo="${esc(name)}" title="${t("Adicionar um arquivo do computador aos anexos deste contexto")}">＋ ${t("do computador")}</button>`;
  html += folderGroupHtml(`ctxfolder:${name}:anexos`, t("anexos"), anexos.length, anexRows, t("nenhum anexo ainda"), anexActions);
  holder.innerHTML = html || `<div class="bempty">${t("vazio")}</div>`;
  wireSidebar();
  markSel();
}

// ============================ produção (mundo pessoal — ADR-0009) ============================
// A árvore da produção espelha pessoal/temas/<slug>/{reunioes,investigacoes,perguntas,notas}
// + pessoal/avulso. É o mundo NÃO versionado (âmbar); clicar abre uma aba de preview.
// Só re-renderiza quando os dados mudam (assinatura) — a expansão é preservada em bOpen.
let pessoalSig = "";
// ADR-0013: the non-versioned world is "Brainstorming" (disk: brainstorming/).
// A brainstorming groups reuniões/investigações/perguntas/notas; it can carry an
// optional categoria (UI-only grouping). Selection of parts -> one consolidated
// report -> the fila (see bsSelection / sendSelectionToQueue).
// ADR-0007: above this many brainstormings the always-expanded tree gets hard
// to scan — the search box appears and the list caps to the most recent
// until the user searches or asks to see all (owner feedback).
const PESSOAL_FILTER_THRESHOLD = 8;
let pessoalRawTemas = [], pessoalRawAvulso = [];
let pessoalFilterQuery = "", pessoalShowAll = false;
async function refreshPessoal() {
  if (!brainTab) return;
  let temas = [], avulso = [];
  try { temas = (await invoke("brain_list_brainstorms")) || []; } catch (_) {}
  try { avulso = ((await invoke("brain_list_dir", { rel: "brainstorming/avulso" })) || []).filter((f) => !f.dir); }
  catch (_) {}
  const sig = JSON.stringify([temas, avulso.map((f) => f.name)]);
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
      html += `<div class="bitem ctx${open ? " open" : ""}" data-pestoggle="${key}">${ico("note", "ac")}<span class="bn">${t("avulso")}</span><span class="pill">${avulso.length}</span></div>` +
        `<div class="bchild" ${open ? "" : "hidden"}>` +
        avulso.map((f) => `<div class="bitem file" data-doc="${esc(f.path)}" title="${esc(f.name)}">${ico("file")}<span class="bn">${esc(shortName(f.name))}</span></div>`).join("") +
        `</div>`;
    }
  } else if (pessoalFilterQuery) {
    html += `<div class="bempty">${t("nenhum brainstorming encontrado para")} "${esc(pessoalFilterQuery)}"</div>`;
  } else {
    html += `<div class="bempty">${t("nenhum brainstorming ainda — crie o primeiro para reunir reuniões e notas")}</div>`;
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
  const pill = t.reunioes ? `<span class="pill">${t.reunioes}</span>` : "";
  return `<div class="bitem ctx${open ? " open" : ""}" data-tema="${esc(t.slug)}" title="${esc(t.nome || t.slug)}">` +
    `${ico("idea", "ac")}<span class="bn">${esc(t.nome || t.slug)}</span>${pill}` +
    `<button class="rowmenu" data-bsmenu="${esc(t.slug)}" title="${window.LoroI18n.t("ações do brainstorming")}">⋯</button></div>${holder}`;
}
// Dentro de um brainstorming a árvore é PLANA (revisão de UX sobre o ADR-0013):
// as reuniões aparecem direto no nível do brainstorming — com os artefatos de
// análise (investigações/respostas) logo abaixo de cada uma — e as notas como
// subitem ao final. As pastas investigacoes/ e perguntas/ continuam no disco (o
// relatório "tudo" ainda as lê), mas deixam de ser um nível de navegação: a
// segmentação em quatro pastas era atrito, não estrutura.
// A selectable part row: a checkbox (data-bssel/data-bskind) + the open target.
// A meeting row carries a ⋯ menu (renomear/apagar); files keep the plain ×.
function bsPartRow(kind, openRel, selRel, label, title, indent, meetingId, meetingStatus, mopen) {
  const act = meetingId
    ? `<button class="rowtoggle${mopen ? " open" : ""}" data-mtgtoggle="${esc(meetingId)}" title="${t("mostrar/ocultar investigações e respostas")}">▸</button>` +
      `<button class="rowmenu" data-mtgmenu="${esc(selRel)}" data-mtgid="${esc(meetingId)}" data-mtgtitle="${esc(label)}" data-mtgstatus="${esc(meetingStatus || "")}" title="${t("ações da reunião (analisar, perguntar, relatório…)")}">⋯</button>`
    : `<button class="rowmenu" data-artmenu="${esc(selRel)}" data-artlabel="${esc(label)}" title="${t("ações (renomear, apagar)")}">⋯</button>`;
  const icon = kind === "reuniao" ? "meeting" : kind === "nota" ? "note" : "file";
  return `<div class="bitem file${indent ? " bsub" : ""}" data-doc="${esc(openRel)}" title="${esc(title)}">` +
    `<input type="checkbox" class="bschk" data-bssel="${esc(selRel)}" data-bskind="${kind}" title="${t("selecionar para a fila")}">` +
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
  try { notas = ((await invoke("brain_list_dir", { rel: `brainstorming/${slug}/notas` })) || []).filter((f) => !f.dir); }
  catch (_) {}
  // ADR-0007: three brainstorming folders — reunioes/, notas/, anexos/.
  // anexos/ is fed by a habilidade (sincronizar, apresentação, artefato) or
  // by the user dropping files straight into the real folder on disk — no
  // dedicated "importar" UI for that second path.
  let anexos = [];
  try { anexos = ((await invoke("brain_list_dir", { rel: `brainstorming/${slug}/anexos` })) || []).filter((f) => !f.dir); }
  catch (_) {}
  let inner = "";
  // ADR-0007 (owner request): a pasta de verdade precisa estar visível na UI —
  // três grupos com ícone de pasta (reuniões/notas/anexos), cada um
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
    reunioesRows += bsPartRow("reuniao", `${m.rel}/reuniao.md`, m.rel, label, m.id, true, m.id, m.status, mopen);
    reunioesRows += `<div class="bchild" data-mtgchild="${esc(m.id)}" data-mtgrel="${esc(m.rel)}" ${mopen ? "" : "hidden"}></div>`;
    if (mopen) pendingMeetingFills.push([m.id, m.rel]);
  }
  const notasRows = notas.map((f) => bsPartRow("nota", f.path, f.path, shortName(f.name), f.name, true)).join("");
  const anexosRows = anexos.map((f) => bsPartRow("anexo", f.path, f.path, shortName(f.name), f.name, true)).join("");
  const reunioesActions = `<button class="bsaddbtn rec2" data-addmeeting="${esc(slug)}" title="${t("Gravar uma reunião neste brainstorming (áudio 100% local)")}">● ${t("gravar reunião")}</button>`;
  const notasActions = `<button class="bsaddbtn" data-addnota="${esc(slug)}" title="${t("Escrever uma nota neste brainstorming")}">＋ ${t("nova nota")}</button>`;
  const anexosActions =
    `<button class="bsaddbtn" data-syncdrive="${esc(slug)}" title="${t("Trazer uma nota de reunião externa (Google Drive/Gemini) para os anexos deste tema")}">⇄ ${t("sincronizar")}</button>` +
    `<button class="bsaddbtn" data-addanexo="${esc(slug)}" title="${t("Adicionar um arquivo do computador aos anexos deste tema")}">＋ ${t("do computador")}</button>`;
  inner += folderGroupHtml(`bsfolder:${slug}:reunioes`, t("reuniões"), meetings.length, reunioesRows, t("nenhuma reunião ainda"), reunioesActions);
  inner += folderGroupHtml(`bsfolder:${slug}:notas`, t("notas"), notas.length, notasRows, t("nenhuma nota ainda"), notasActions);
  inner += folderGroupHtml(`bsfolder:${slug}:anexos`, t("anexos"), anexos.length, anexosRows, t("nenhum anexo ainda"), anexosActions);
  holder.innerHTML = inner;
  wirePessoal();
  // fillMeetingChild queries the live DOM — must run AFTER innerHTML is set,
  // not while `inner` is still a string (the container doesn't exist yet).
  for (const [id, rel] of pendingMeetingFills) await fillMeetingChild(id, rel);
  markSel();
}
// A collapsible folder group in the sidebar (reuniões/notas/anexos) — a real
// folder icon + label + count, expand/collapse via the same [data-pestoggle]
// wiring already used for "avulso" (wirePessoal, no new JS needed there). The
// folder's own creation action(s) sit at the top of its body, so each button
// lives inside the folder it acts on (ADR-0007, owner request).
function folderGroupHtml(key, label, count, rowsHtml, emptyMsg, actionsHtml) {
  const open = bOpen.has(key);
  const pill = count ? `<span class="pill">${count}</span>` : "";
  const actions = actionsHtml ? `<div class="bsadd">${actionsHtml}</div>` : "";
  return `<div class="bitem ctx${open ? " open" : ""}" data-pestoggle="${key}">${ico("folder", "ac")}<span class="bn">${label}</span>${pill}</div>` +
    `<div class="bchild" ${open ? "" : "hidden"}>${actions}${rowsHtml || `<div class="bempty sub">${emptyMsg}</div>`}</div>`;
}
// Busca e injeta investigações/respostas de UMA reunião no seu container
// (chamado ao expandir, e ao re-render de uma tema já expandida).
async function fillMeetingChild(meetingId, meetingRel) {
  const child = [...B.navPessoal.querySelectorAll("[data-mtgchild]")].find((h) => h.dataset.mtgchild === meetingId);
  if (!child) return;
  let inner = "";
  for (const [asub, akind] of [["investigacoes", "investigacao"], ["respostas", "nota"]]) {
    let arts = [];
    try { arts = ((await invoke("brain_list_dir", { rel: `${meetingRel}/artefatos/${asub}` })) || []).filter((a) => !a.dir); }
    catch (_) {}
    for (const a of arts) inner += bsPartRow(akind, a.path, a.path, shortName(a.name), a.name, true);
  }
  child.innerHTML = inner || `<div class="bempty sub">${t("nada por aqui ainda")}</div>`;
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
    openMeetingMenu(el2.dataset.mtgmenu, el2.dataset.mtgid, el2.dataset.mtgtitle, el2.dataset.mtgstatus, el2);
  }));
  B.navPessoal.querySelectorAll("[data-tema]").forEach((el2) => (el2.onclick = (e) => {
    if (e.target.closest("[data-bsmenu]")) return;
    const slug = el2.dataset.tema, key = "pes:tema:" + slug;
    const holder = [...B.navPessoal.querySelectorAll("[data-temachild]")].find((h) => h.dataset.temachild === slug);
    if (bOpen.has(key)) { bOpen.delete(key); el2.classList.remove("open"); if (holder) holder.hidden = true; }
    else {
      bOpen.add(key); el2.classList.add("open"); if (holder) holder.hidden = false;
      loadTemaChildren(slug);
      openDoc(`brainstorming/${slug}/indice.md`, { preview: true });
    }
    markSel();
  }));
  B.navPessoal.querySelectorAll("[data-pestoggle]").forEach((el2) => (el2.onclick = () => {
    const key = el2.dataset.pestoggle, child = el2.nextElementSibling;
    if (bOpen.has(key)) { bOpen.delete(key); el2.classList.remove("open"); if (child) child.hidden = true; }
    else { bOpen.add(key); el2.classList.add("open"); if (child) child.hidden = false; }
  }));
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
    importAnexoFromComputer(`brainstorming/${slug}/anexos`, () => {
      bOpen.add(`bsfolder:${slug}:anexos`); loadTemaChildren(slug);
    });
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
}

// ADR-0005/0006: per-source copy for the /loro-sync modal. `required` gates
// the identifier field before injecting the command — drive is the only
// source where a blank identifier still means something (a broad search).
const SYNC_TOOL_COPY = {
  drive: {
    title: "Sincronizar reunião externa (Drive)",
    desc: "busca uma nota do Gemini no Drive e traz o documento inteiro como anexo local, referenciado na nota.",
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

// "sincronizar" (ADR-0005/0006): shared modal for the 4 built-in /loro-sync
// sources. Without `slug` (Visão Geral entry point), the modal also asks
// which brainstorming to target — with `slug` (the per-brainstorming button),
// the target is already known.
async function promptSyncTool(fonte, slug) {
  const cfg = SYNC_TOOL_COPY[fonte];
  if (!cfg) return;
  let temaField = "";
  if (!slug) {
    let temas = [];
    try { temas = (await invoke("brain_list_brainstorms")) || []; } catch (_) {}
    if (!temas.length) { toast(t("crie um brainstorming primeiro")); return; }
    temaField = `<label class="wfield"><span class="mono">${t("tema")}</span>` +
      `<select id="syncToolTema">` +
      temas.map((b) => `<option value="${esc(b.slug)}">${esc(b.nome)}</option>`).join("") +
      `</select></label>`;
  }
  openModal(
    t(cfg.title),
    `<p class="pmnote mono">${t(cfg.desc)}</p>` + temaField +
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
      termRunAgent(cmd);
      toast(t("busca enviada ao agente do terminal"), 4000);
    }
  );
  const inp = $("syncToolInput"); if (inp) inp.focus();
}
// ============================ habilidades (ADR-0006/0007) ============================
// A "habilidade" (UI label; code keeps the English "tool" per CLAUDE.md §6) is
// any .md in .claude/commands/ — the filename IS the slash-command. Built-ins
// (BUILTIN_SKILLS) can be edited but never deleted (brain_delete_tool already
// refuses them; the UI just hides the option); custom ones have full CRUD.
const TOOL_BUILTINS = new Set([
  "loro-context.md", "loro-analyse.md", "loro-question.md",
  "loro-ask.md", "loro-note.md", "loro-sync.md", "loro-tool.md",
  "loro-presentation.md", "loro-artifact.md",
]);
// Subset offered by the generic "executar habilidade" picker (brainstorming/
// meeting ⋯ menus): the workflow-specific built-ins already have their own
// dedicated UI (nova nota, perguntar ao acervo, gerar contexto, analisar/
// perguntar na reunião) — repeating them here would just be noise. Only the
// generically "run against an alvo" built-ins + every custom tool show up.
const TOOL_PICKER_EXCLUDE = new Set([
  "loro-context.md", "loro-analyse.md", "loro-question.md",
  "loro-ask.md", "loro-note.md", "loro-tool.md",
]);
let toolsSig = "";
async function refreshTools() {
  if (!brainTab) return;
  let files = [];
  try { files = ((await invoke("brain_list_dir", { rel: ".claude/commands" })) || []).filter((f) => !f.dir); }
  catch (_) { files = []; }
  const sig = JSON.stringify(files.map((f) => f.name));
  if (sig === toolsSig) return;
  toolsSig = sig;
  // description cached per file (used as the hover tooltip everywhere — the
  // picker never renders every description inline, only on :hover/title).
  const withDesc = await Promise.all(files.map(async (f) => {
    let desc = "";
    try {
      const raw = await invoke("brain_read", { rel: f.path });
      const m = /description:\s*(.+)/.exec(raw);
      if (m) desc = m[1].trim();
    } catch (_) {}
    return { ...f, builtin: TOOL_BUILTINS.has(f.name), desc };
  }));
  renderTools(withDesc);
}
function toolRow(f) {
  const label = shortName(f.name);
  // bolt = built-in, star = custom (ADR-0007): the origin is legible from the
  // icon alone; the "padrão" pill stays as the textual reinforcement.
  return `<div class="bitem file" data-doc="${esc(f.path)}" title="${esc(f.desc || f.path)}">` +
    `${ico(f.builtin ? "skill" : "customskill")}<span class="bn">${esc(label)}</span>` +
    (f.builtin ? `<span class="pill" title="${t("habilidade padrão")}">${t("padrão")}</span>` : "") +
    `<button class="rowmenu" data-toolmenu="${esc(f.path)}" data-toollabel="${esc(label)}" data-toolbuiltin="${f.builtin ? "1" : ""}" title="${t("ações (usar, editar, pedir à IA, excluir)")}">⋯</button>` +
    `</div>`;
}
let lastToolFiles = [];
function renderTools(files) {
  lastToolFiles = files;
  const nav = $("navTools");
  if (nav) {
    nav.innerHTML = files.length
      ? files.map(toolRow).join("")
      : `<div class="bempty">${t("nenhuma habilidade ainda — crie uma com IA ou importe uma pronta (＋)")}</div>`;
  }
  wireTools();
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
    (builtin
      ? `<div class="fnote mono">${t("habilidade padrão — não pode ser excluída")}</div>`
      : `<div class="fitem2 danger" data-del><span class="fn">${t("excluir")}</span></div>`);
  B.bMenu.querySelector("[data-use]").onclick = () => { closeFloat(); promptUseTool(rel); };
  B.bMenu.querySelector("[data-edit]").onclick = () => { closeFloat(); openDoc(rel, { preview: false }); };
  B.bMenu.querySelector("[data-ainote]").onclick = () => { closeFloat(); promptToolAI(rel); };
  if (!builtin) B.bMenu.querySelector("[data-del]").onclick = () => { closeFloat(); delTool(rel); };
  placeMenu(anchor);
}
async function delTool(rel) {
  if (!confirm(t("excluir esta habilidade?"))) return;
  try { await invoke("brain_delete_tool", { rel }); toolsSig = ""; refreshTools(); toast(t("excluída")); }
  catch (e) { toast(tErr(String(e))); }
}
// "usar": reads the tool's own front-matter (description/argument-hint) to
// prompt for arguments, then just runs "/<slug> <args>" — the file itself IS
// the slash-command, no dedicated runner needed.
// presetArg pre-fills the input (e.g. the meeting/note the habilidade was
// invoked against) — the user can accept it as-is or extend it, instead of
// retyping a path the caller already knew.
async function promptUseTool(rel, presetArg) {
  const slug = rel.split("/").pop().replace(/\.md$/, "");
  let hint = "", desc = "";
  try {
    const raw = await invoke("brain_read", { rel });
    const mHint = /argument-hint:\s*(.+)/.exec(raw);
    const mDesc = /description:\s*(.+)/.exec(raw);
    if (mHint) hint = mHint[1].trim();
    if (mDesc) desc = mDesc[1].trim();
  } catch (_) {}
  openModal(
    `${t("usar")} /${slug}`,
    (desc ? `<p class="pmnote mono">${esc(desc)}</p>` : "") +
      `<label class="wfield"><span class="mono">${t("argumentos")}</span>` +
      `<input id="useToolInput" type="text" value="${esc(presetArg || "")}" placeholder="${esc(hint || t("opcional"))}" spellcheck="false"></label>`,
    t("rodar"),
    () => {
      const args = (($("useToolInput") && $("useToolInput").value) || "").trim();
      termRunAgent("/" + slug + (args ? " " + args : ""));
      toast(t("comando enviado ao agente do terminal"), 4000);
    }
  );
  const inp = $("useToolInput"); if (inp) inp.focus();
}
function promptToolAI(rel) {
  openModal(
    t("Pedir à IA sobre esta habilidade"),
    `<p class="pmnote mono">${t("a IA lê a habilidade e aplica o pedido nela mesma — evolui, não apaga.")}</p>` +
      `<label class="wfield"><span class="mono">${t("pedido")}</span>` +
      `<input id="toolAiInput" type="text" placeholder="${t("ex.: adicione um passo para validar o input")}" spellcheck="false"></label>`,
    t("enviar"),
    () => {
      const p = (($("toolAiInput") && $("toolAiInput").value) || "").trim();
      const cmd = LoroBrainstorm.toolCmd(rel, p);
      if (!cmd) { toast(t("descreva o pedido")); return; }
      termRunAgent(cmd);
      toast(t("pedido enviado ao agente do terminal"), 4000);
    }
  );
  const inp = $("toolAiInput"); if (inp) inp.focus();
}
function promptNewToolAI() {
  openModal(
    t("Nova habilidade (IA)"),
    `<p class="pmnote mono">${t("descreva o que a habilidade deve fazer — a IA cria a skill; ela aparece na lateral quando terminar.")}</p>` +
      `<label class="wfield"><span class="mono">${t("descrição")}</span>` +
      `<input id="newToolInput" type="text" placeholder="${t("ex.: resume um ticket do Jira em 3 bullets")}" spellcheck="false"></label>`,
    t("criar"),
    () => {
      const d = (($("newToolInput") && $("newToolInput").value) || "").trim();
      const cmd = LoroBrainstorm.newToolCmd(d);
      if (!cmd) { toast(t("descreva a habilidade")); return; }
      termRunAgent(cmd);
      toast(t("pedido enviado ao agente do terminal — a habilidade aparece na lateral"), 4000);
    }
  );
  const inp = $("newToolInput"); if (inp) inp.focus();
}
function promptImportTool() {
  openModal(
    t("Importar habilidade existente"),
    `<p class="pmnote mono">${t("cole o conteúdo de uma skill (.md) que você já tem.")}</p>` +
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
// ADR-0007: the habilidades section collapses/expands from its own header —
// with many skills the list stops crowding the sidebar; the caret shows state.
{
  const tt = $("toolsToggle"), navT = $("navTools");
  if (tt && navT) tt.addEventListener("click", () => {
    navT.hidden = !navT.hidden;
    tt.classList.toggle("closed", navT.hidden);
  });
}
// Shared "executar habilidade" picker (brainstorming ⋯ and meeting ⋯): a
// compact dropdown-like list — one row per pickable habilidade, description
// only on hover (title=), never rendered inline (ADR-0007: avoid a wall of
// text once there are many). loro-sync.md is special-cased into its 4
// sources since it is one file covering four distinct identifiers.
// Flattens lastToolFiles into runnable entries: loro-sync.md expands into its
// 4 sources (one file, four distinct identifiers); every other pickable
// habilidade (built-in or custom, minus the 5 workflow-specific ones) is one
// entry. Shared by the ⋯ menu picker AND the meeting rail dropdown so both
// stay in sync automatically.
function habilidadeEntriesFrom(files) {
  const entries = [];
  for (const f of files) {
    if (f.name === "loro-sync.md") {
      for (const fonte of ["drive", "slack", "jira", "confluence"]) {
        entries.push({ kind: "sync", fonte, label: fonte, title: f.desc });
      }
    } else {
      entries.push({ kind: "tool", rel: f.path, label: shortName(f.name), title: f.desc || f.path });
    }
  }
  return entries;
}
// Curated: excludes the 5 workflow-specific built-ins (already have dedicated
// UI) — used by the ⋯ menu picker, which coexists with that dedicated UI.
function pickableHabilidadeEntries() {
  return habilidadeEntriesFrom(lastToolFiles.filter((f) => !TOOL_PICKER_EXCLUDE.has(f.name)));
}
// Unrestricted: every habilidade, no exclusion — used where there is no
// separate dedicated UI to coexist with (the meeting rail, ADR-0007).
function allHabilidadeEntries() {
  return habilidadeEntriesFrom(lastToolFiles);
}
function runHabilidadeEntry(entry, alvoRel) {
  if (entry.kind === "sync") promptSyncTool(entry.fonte, alvoRel);
  else promptUseTool(entry.rel, alvoRel);
}
function openHabilidadeMenu(alvoRel, anchor) {
  B.acervoMenu.hidden = true;
  const entries = pickableHabilidadeEntries();
  const rows = entries.map((e, i) =>
    `<div class="fitem2" data-entry="${i}" title="${esc(e.title)}"><span class="fn">${esc(e.label)}</span></div>`).join("");
  B.bMenu.innerHTML = `<div class="fhead">${t("executar habilidade")}</div>` +
    (rows || `<div class="fnote mono">${t("nenhuma habilidade disponível")}</div>`);
  B.bMenu.querySelectorAll("[data-entry]").forEach((el2) => (el2.onclick = () => {
    closeFloat(); runHabilidadeEntry(entries[Number(el2.dataset.entry)], alvoRel);
  }));
  placeMenu(anchor);
}

// ADR-0007: "＋ do computador" — native file picker → copies the chosen files
// into an anexos/ folder (brain_import_files). Works for both a brainstorming
// (destRel = brainstorming/<slug>/anexos) and a context (contextos/<c>/anexos);
// `after` runs on success (re-open + reload the right tree).
async function importAnexoFromComputer(destRel, after) {
  try {
    const n = await invoke("brain_import_files", { destRel });
    if (n > 0) {
      toast(`${n} ${n > 1 ? t("arquivos anexados") : t("arquivo anexado")}`);
      if (after) after();
    }
  } catch (e) { toast(tErr(String(e))); clog("brain_import_files error: " + e); }
}

// ADR-0007: inline "nova nota" in a context's anexos folder — the context
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
      const rel = await invoke("brain_new_note_in", { destRel: `contextos/${name}/anexos`, titulo });
      done(); bOpen.add(`ctxfolder:${name}:anexos`); loadCtxChildren(name);
      if (rel) openDoc(rel, { preview: false });
    } catch (err) { toast(tErr(String(err))); }
  });
  inp.addEventListener("blur", done);
}

// Inline "nova nota" inside a brainstorming (mirrors promptNewContext/promptNewTema).
// Writes brainstorming/<slug>/notas/<slug>.md via brain_new_notebook and opens it.
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
function openBsMenu(slug, anchor) {
  B.acervoMenu.hidden = true;
  B.bMenu.innerHTML =
    `<div class="fhead">${esc(slug)}</div>` +
    `<div class="fitem2 strong" data-ainote><span class="fn">✦ ${t("nota por IA…")}</span></div>` +
    `<div class="fitem2" data-tools><span class="fn">${ico("skill")} ${t("executar habilidade…")}</span></div>` +
    `<div class="fsep"></div>` +
    `<div class="fitem2" data-ren><span class="fn">${t("renomear")}</span></div>` +
    `<div class="fitem2" data-toqueue><span class="fn">${t("gerar relatório de tudo → fila")}</span></div>` +
    `<div class="fitem2 danger" data-del><span class="fn">${t("apagar brainstorming")}</span></div>`;
  B.bMenu.querySelector("[data-ainote]").onclick = () => { closeFloat(); promptNoteAI(`brainstorming/${slug}/notas`, false); };
  B.bMenu.querySelector("[data-tools]").onclick = () => openHabilidadeMenu(`brainstorming/${slug}`, anchor);
  B.bMenu.querySelector("[data-ren]").onclick = () => { closeFloat(); promptRenameBs(slug); };
  B.bMenu.querySelector("[data-toqueue]").onclick = () => { closeFloat(); sendBrainstormToQueue(slug, []); };
  B.bMenu.querySelector("[data-del]").onclick = () => { closeFloat(); delPessoal("brainstorming/" + slug, "tema"); };
  const r = anchor.getBoundingClientRect();
  B.bMenu.style.left = Math.max(10, r.left - 120) + "px";
  B.bMenu.style.top = (r.bottom + 4) + "px";
  B.bMenu.hidden = false;
}

// Rename via the shared modal — window.prompt is unreliable in the webview
// (same reason pickMeeting/askMeetingQuestion use openModal).
function promptRenameBs(slug) {
  openModal(
    t("Renomear brainstorming"),
    `<label class="wfield"><span class="mono">${t("nome")}</span>` +
      `<input id="bsRenInput" type="text" value="${esc(slug)}" spellcheck="false"></label>`,
    t("renomear"),
    async () => {
      const nome = (($("bsRenInput") && $("bsRenInput").value) || "").trim();
      if (!nome) { toast(t("informe um nome")); return; }
      try {
        const r = await invoke("brain_rename_brainstorm", { slug, nome });
        pessoalSig = ""; refreshPessoal();
        if (r && r.rel) openDoc(`${r.rel}/indice.md`, { preview: false });
        toast(t("renomeado"));
      } catch (e) { toast(t("não renomeei") + ": " + tErr(String(e))); }
    }
  );
  const inp = $("bsRenInput"); if (inp) { inp.focus(); inp.select(); }
}

// O menu ⋯ de uma reunião na árvore — renomear (só o título; o id/pasta é
// estável, então abas e artefatos continuam válidos) / apagar.
function openMeetingMenu(rel, id, title, status, anchor) {
  B.acervoMenu.hidden = true;
  // the meeting's AI actions live here too (not only in the open tab); the
  // report is only worth opening after the meeting is done — before that the
  // entry shows disabled with the reason instead of failing on click.
  const ready = status === "done";
  const dis = ready ? "" : " disabled";
  B.bMenu.innerHTML =
    `<div class="fhead">${esc(title)}</div>` +
    `<div class="fitem2 strong${dis ? " off" : ""}" data-analyse><span class="fn">✦ ${t("analisar")}</span></div>` +
    `<div class="fitem2${ready ? "" : " strong"}" data-question><span class="fn">? ${t("perguntar…")}</span></div>` +
    `<div class="fitem2${dis ? " off" : ""}" data-report><span class="fn">≡ ${t("ver relatório")}</span></div>` +
    `<div class="fitem2${dis ? " off" : ""}" data-queue><span class="fn">${t("enviar para a fila")} →</span></div>` +
    (ready ? "" : `<div class="fnote mono">${t("analisar, ver relatório e enviar para a fila ficam disponíveis quando a reunião terminar — perguntar já funciona agora")}</div>`) +
    `<div class="fitem2" data-tools><span class="fn">${ico("skill")} ${t("executar habilidade…")}</span></div>` +
    `<div class="fsep"></div>` +
    `<div class="fitem2" data-ren><span class="fn">✎ ${t("renomear")}</span></div>` +
    `<div class="fitem2 danger" data-del><span class="fn">${t("apagar reunião")}</span></div>`;
  if (ready) {
    B.bMenu.querySelector("[data-analyse]").onclick = () => { closeFloat(); openDoc(`${rel}/reuniao.md`, { preview: false }); runMeetingSkill("analyse", id, null, rel); };
    B.bMenu.querySelector("[data-report]").onclick = () => { closeFloat(); buildAndOpenReport(id); };
    B.bMenu.querySelector("[data-queue]").onclick = () => {
      closeFloat();
      const m = /^brainstorming\/([^/]+)\//.exec(rel);
      if (!m) { toast(t("abra a reunião para enviar")); return; }
      sendBrainstormToQueue(m[1], [{ kind: "reuniao", rel }]);
    };
  }
  B.bMenu.querySelector("[data-question]").onclick = () => { closeFloat(); askMeetingQuestion(id, rel); };
  B.bMenu.querySelector("[data-tools]").onclick = () => openHabilidadeMenu(rel, anchor);
  B.bMenu.querySelector("[data-ren]").onclick = () => { closeFloat(); promptRenameMeeting(id, title); };
  B.bMenu.querySelector("[data-del]").onclick = () => { closeFloat(); delPessoal(rel, "reuniao"); };
  placeMenu(anchor);
}

// notes and analysis artifacts: rename in place (world-confined backend) + delete
function openArtefatoMenu(rel, label, anchor) {
  B.acervoMenu.hidden = true;
  B.bMenu.innerHTML =
    `<div class="fhead">${esc(label)}</div>` +
    `<div class="fitem2 strong" data-ainote><span class="fn">✦ ${t("pedir à IA…")}</span></div>` +
    `<div class="fsep"></div>` +
    `<div class="fitem2" data-ren><span class="fn">✎ ${t("renomear")}</span></div>` +
    `<div class="fitem2 danger" data-del><span class="fn">${t("apagar")}</span></div>`;
  B.bMenu.querySelector("[data-ainote]").onclick = () => { closeFloat(); promptNoteAI(rel, true); };
  B.bMenu.querySelector("[data-ren]").onclick = () => { closeFloat(); promptRenameArtefato(rel); };
  B.bMenu.querySelector("[data-del]").onclick = () => { closeFloat(); delPessoal(rel); };
  placeMenu(anchor);
}

// /loro-note: create a note from a prompt (target = notes folder) or evolve an
// existing note in place (target = the .md file). Runs in the terminal agent;
// the sidebar's post-action refresh burst surfaces the result.
function promptNoteAI(target, isFile) {
  openModal(
    isFile ? t("Pedir à IA sobre esta nota") : t("Nota por IA"),
    `<p class="pmnote mono">${isFile
      ? t("a IA lê a nota e aplica o pedido nela mesma — evolui, não apaga.")
      : t("descreva a nota que o Loro deve criar neste brainstorming.")}</p>` +
      `<label class="wfield"><span class="mono">${t("pedido")}</span>` +
      `<input id="noteAiInput" type="text" placeholder="${isFile
        ? t("ex.: resuma em 5 bullets e liste as dúvidas")
        : t("ex.: nota sobre os riscos do contrato X, com o que sabemos hoje")}" spellcheck="false"></label>`,
    t("enviar"),
    () => {
      const p = (($("noteAiInput") && $("noteAiInput").value) || "").trim();
      const cmd = LoroBrainstorm.noteCmd(target, p);
      if (!cmd) { toast(t("descreva o pedido")); return; }
      termRunAgent(cmd);
      toast(t("pedido enviado ao agente do terminal — a nota aparece na lateral"), 4000);
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

// Build ONE consolidated report from the given selection (empty = all parts) and
// send it to the fila. The report is opened as a tab first (it must be visible).
async function sendBrainstormToQueue(slug, selection) {
  try {
    const out = await invoke("brain_brainstorm_build_report", { slug, selection });
    if (out && out.rel) {
      openDoc(out.rel, { preview: false });                 // the report is visible
      await invoke("brain_send_report_to_queue", { reportRel: out.rel, destContext: null });
      pessoalSig = ""; refreshPessoal(); sideSig = ""; brainRefresh();
      toast(t("relatório na fila de geração de contexto"));
    }
  } catch (e) { toast(t("não enviei") + ": " + tErr(String(e))); clog("build_report/send error: " + e); }
}

// The selected parts across the tree -> their SelItem list (kind read from the
// checkbox dataset). Sends them as ONE consolidated report to the fila.
async function sendSelectionToQueue() {
  const sel = [];
  B.navPessoal.querySelectorAll("[data-bssel]").forEach((chk) => {
    if (bsSelection.has(chk.dataset.bssel)) sel.push({ kind: chk.dataset.bskind, rel: chk.dataset.bssel });
  });
  if (!sel.length) return;
  // all selected parts belong to the open brainstorming; derive its slug
  const m = /^brainstorming\/([^/]+)\//.exec(sel[0].rel);
  if (!m) { toast(t("seleção inválida")); return; }
  await sendBrainstormToQueue(m[1], sel);
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
  bar.innerHTML = `<span>${bsSelection.size} ${t("selecionado(s)")}</span>` +
    `<button class="abtn" id="bsSelSend" title="${t("Gera um relatório consolidado das partes escolhidas e o envia para a fila de geração de contexto")}">${t("enviar para a fila")} →</button>` +
    `<button class="abtn ghost" id="bsSelClear">${t("limpar")}</button>`;
  $("bsSelSend").onclick = sendSelectionToQueue;
  $("bsSelClear").onclick = () => { bsSelection = new Set(); wirePessoal(); renderSelectionBar(); };
}

// Apaga um item do mundo brainstorming (arquivo, reunião ou brainstorming inteiro).
// Confinado a brainstorming/ no backend (nunca toca contextos/ versionado).
async function delPessoal(rel, kind) {
  const what = kind === "tema" ? t("o brainstorming e TODO o seu conteúdo")
    : kind === "reuniao" ? t("a reunião e todos os seus arquivos (transcrição, relatório, artefatos)")
    : t("este item");
  if (!confirm(`${t("Apagar")} ${what}? ${t("Não pode ser desfeito.")}`)) return;
  try {
    await invoke("brain_brainstorm_delete", { input: { rel } });
    closeTabsUnder(rel);
    toast(t("apagado"));
    pessoalSig = ""; refreshPessoal();
  } catch (e) { toast(t("não apaguei") + ": " + tErr(String(e))); clog("brain_brainstorm_delete error: " + e); }
}

// ---- workspace selectors (ADR-0008) ----
function activeTab() { return LoroWorkspace.activeTab(ws); }
function homeTab() { return ws.tabs.find((t) => t.rel === HOME_REL) || null; }
function isHomeActive() { const t = activeTab(); return !t || t.rel === HOME_REL; }
// null when Home/empty (preserves the old `currentDoc === null` semantics),
// the document rel otherwise.
function currentRel() { const t = activeTab(); return !t || t.rel === HOME_REL ? null : t.rel; }

function markSel() {
  B.navHome.classList.toggle("on", isHomeActive());
  const rel = currentRel();
  B.main.querySelectorAll("[data-doc]").forEach((el2) =>
    el2.classList.toggle("on", el2.dataset.doc === rel));
}

// ---- tab strip ----
function renderTabs() {
  const active = ws.activeId;
  B.wsTabs.innerHTML = ws.tabs.map((tab) => {
    const home = tab.rel === HOME_REL;
    const cls = ["wstab"];
    if (tab.kind === "context") cls.push("wstab--context");
    else if (tab.kind === "personal") cls.push("wstab--personal");
    if (tab.id === active) cls.push("on");
    if (tab.preview) cls.push("preview");
    if (home) cls.push("home");
    const title = home ? t("visão geral") : esc(tab.title);
    const dot = tab.dirty ? `<span class="wsdot" title="${t("alterações não salvas")}">●</span>` : "";
    const close = home ? "" : `<button class="wsclose" data-close="${tab.id}" title="${t("fechar")} (⌘/Ctrl+W)" aria-label="${t("fechar")}">×</button>`;
    const glyph = home ? "⌂ " : "";
    return `<div class="${cls.join(" ")}" data-tab="${tab.id}" draggable="${home ? "false" : "true"}"
        title="${esc(tab.rel === HOME_REL ? t("visão geral") : tab.rel)}"><span class="wsn">${glyph}${title}</span>${dot}${close}</div>`;
  }).join("");
  wireTabs();
}
function wireTabs() {
  B.wsTabs.querySelectorAll("[data-tab]").forEach((elx) => {
    const id = elx.dataset.tab;
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
  if (tab.dirty && !window.confirm(`${t("Descartar alterações não salvas de")} "${tab.title}"?`)) return;
  disposeTabState(id);
  ws = LoroWorkspace.closeTab(ws, id);
  renderTabs(); renderActive();
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

function showHome() { B.docWrap.hidden = true; B.home.hidden = false; B.wsBody.classList.remove("editing"); markSel(); }
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
B.navHome.addEventListener("click", openHome);

function docBadge(p, isGuide) {
  if (isGuide) return [t("instruções do loop — aplicadas antes de processar"), "ok"];
  if (p === MANUAL_REL) return [t("manual do Loro — somente leitura"), "ro"];
  if (p.startsWith("inbox/")) return [t("pendente — será processado pelo loop"), "ok"];
  if (p.endsWith("guia.md")) return [t("formato antigo — migre para context.md"), "warn2"];
  if (p.endsWith("CHANGELOG.md")) return [t("histórico (append-only)"), "ro"];
  return [t("documento do acervo"), "ro"];
}
// Versioning (git) badge — only on context tabs; a pessoal/ tab never surfaces
// any git state (ADR-0008, LoroWorld.gitVisible).
function setDocGit(p, kind, isGuide) {
  if (isGuide || !LoroWorld.gitVisible(kind)) { B.gitBadge.hidden = true; return; }
  const cls = gitClass(p);
  const map = { "g-new": t("novo (não versionado)"), "g-mod": t("modificado"), "g-del": t("apagado") };
  if (cls && map[cls]) { B.gitBadge.hidden = false; B.gitBadge.textContent = map[cls]; B.gitBadge.className = "mono badge " + cls; }
  else B.gitBadge.hidden = true;
}

const cmTheme = () => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
// read a document's raw text (guide-aware; falls back from context.md to guia.md)
// ADR-0002 §7 — the user manual ships inside the app as a webview asset (one
// file per language), opened as a read-only studio tab; no IPC involved.
const MANUAL_REL = "loro://manual";
async function readDoc(rel) {
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

// ---- editor fiel (CodeMirror 6, ADR-0008): um handle por aba em cmById ----
// dirty is the unsaved-buffer dot: cleared by save, set on divergence from disk.
function onEditorChange(id, value) {
  const dirty = value !== savedById.get(id);
  const tab = ws.tabs.find((t) => t.id === id);
  if (tab && dirty) maybeFirstEditNote(tab);
  if (tab && tab.dirty !== dirty) { ws = LoroWorkspace.markDirty(ws, id, dirty); renderTabs(); }
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
  try {
    if (tab.rel === GUIDE_REL) await invoke("brain_write_guide", { content: value });
    else await invoke("brain_write", { rel: tab.rel, content: value });
    savedById.set(id, value);
    ws = LoroWorkspace.markDirty(ws, id, false);
    renderTabs();
    toast(t("salvo"));
    sideSig = ""; brainRefresh();
  } catch (e) { toast(tErr(String(e))); clog("save doc error: " + e); }
}
function saveActive() {
  const t = activeTab();
  if (!t || t.rel === HOME_REL) return;
  const h = cmById.get(t.id);
  if (h) saveTab(t.id, h.getValue());
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
    cmById.set(tab.id, h);
  }
  B.doc.hidden = true;
  B.editHost.hidden = false;
  B.wsBody.classList.add("editing"); // ADR-0008: editor ocupa o painel inteiro
  // show only the active tab's editor within the shared host
  cmById.forEach((hh, id) => { hh.view.dom.style.display = id === tab.id ? "" : "none"; });
  requestAnimationFrame(() => h.focus());
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
    ? t("_Sem instruções ainda. Escreva orientações que o loop seguirá antes de processar a fila._")
    : "";
  B.editHost.hidden = true;
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
  B.doc.innerHTML = panel + mdRender(body || fallback);
  wireDocLinks();
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

// ============================ reunião: superfície viva (ADR-0010) ============================
// The living reuniao.md tab renders the transcript (append-only, read-only) plus
// an in-tab side rail (audio + artefatos from the manifest) and a DISABLED
// análise section with the per-meeting consent toggle (default OFF; ADR-0011).
// It stays under pessoal/ (kind "personal"), so LoroWorld hides any Git state and
// nothing here ever writes into contextos/.
async function renderMeetingLiving(tab, stale) {
  const id = LM.livingId(tab.rel);
  B.editHost.hidden = true;
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
  paintMeetingSurface(id, raw, manifest, status, artefatos);
}

// Lista os ARQUIVOS reais sob <reunião>/artefatos/<kind>/ — o skill grava direto
// em disco (não no manifest), então o rail precisa escanear para mostrá-los.
async function listArtefatos(dirRel) {
  const kinds = ["respostas", "investigacoes", "graficos", "consultas", "prompts", "documentos", "tabelas", "mcp"];
  const out = [];
  for (const k of kinds) {
    let files = [];
    try { files = (await invoke("brain_list_dir", { rel: `${dirRel}/artefatos/${k}` })) || []; }
    catch (_) {}
    for (const f of files) if (!f.dir) out.push({ kind: k, name: f.name, rel: f.path });
  }
  return out;
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
  paintMeetingSurface(id, raw, manifest, status, artefatos);
  if (wasBottom) scrollMeetingBottom();
  else { B.wsBody.scrollTop = prevTop; showPill(); }
}

function renderIfLiving(id) {
  const t = activeTab();
  if (t && LM.livingId(t.rel) === id) renderActive();
}

function paintMeetingSurface(id, raw, manifest, status, artefatos) {
  const body = LM.stripMarker(R.splitFrontMatter ? R.splitFrontMatter(raw || "").body : (raw || ""));
  // ADR-0012: mostra o status do pseudo-stream enquanto grava (preview ao vivo),
  // para o problema "não aparece nada" ser diagnosticável sem olhar logs.
  const preview = status === "recording" && meeting.id === id && meeting.tailStatus
    ? `<p class="mtg-preview mono">${esc(meeting.tailStatus)}</p>` : "";
  const emptyMsg = status === "recording"
    ? `<p class="bempty">${t("gravando — o preview ao vivo aparece a cada ~18s conforme houver fala.")}</p>`
    : `<p class="bempty">${t("sem transcrição — não houve fala capturada nesta reunião.")}</p>`;
  B.doc.innerHTML =
    `<div class="mtg-surface">` +
      `<div class="mtg-doc">${meetingStatusBar(status)}${preview}` +
        (body.trim() ? mdRender(body) : emptyMsg) +
      `</div>` +
      `<aside class="mtg-rail">${meetingRailHtml()}</aside>` +
    `</div>`;
  wireMeetingSurface(id);
  wireDocLinks();
}

function meetingStatusBar(status) {
  const map = { recording: [t("gravando"), "rec"], transcribing: [t("transcrevendo…"), "warn"], done: [t("concluída"), "ok"] };
  const [txt, cls] = map[status] || [t("concluída"), "ok"];
  return `<div class="mtg-status ${cls}"><span class="mtg-statusdot"></span><span class="mono">${esc(txt)}</span></div>`;
}

// ADR-0007 (owner request): the meeting rail no longer lists fixed actions
// (analisar/perguntar/ver relatório/enviar para a fila — all still reachable
// from the meeting's ⋯ menu) — "o que fazer com esta reunião" is now a
// single, UNRESTRICTED habilidade dropdown (every skill, including
// analisar/perguntar's own /loro-analyse and /loro-question), so the rail
// never hardcodes which actions exist. Options are populated in
// wireMeetingSurface from the already-cached habilidade list; the bolt icon
// keeps habilidades visually distinct everywhere else they appear.
function meetingRailHtml() {
  // Same rail-sec/rail-row/railbtn classes as the generic doc rail
  // (renderDocRail) — "mesmo padrão em todo lugar" (owner request).
  return `<div class="rail-sec">` +
    `<div class="rail-head">${ico("skill")} ${t("habilidade")}</div>` +
    `<div class="rail-row">` +
      `<select id="mtgSkillSelect" class="mini-select"></select>` +
      `<button class="railbtn icon cta" id="mtgSkillRunBtn" title="${t("executar")}">▶</button>` +
    `</div>` +
    `<p class="mtg-note mono">${t("escolha uma habilidade para executar sobre esta reunião — passe o mouse nas opções para ver a descrição")}</p>` +
    `</div>`;
}

function wireMeetingSurface(id) {
  const skillSel = B.doc.querySelector("#mtgSkillSelect");
  if (skillSel) {
    const entries = allHabilidadeEntries();
    skillSel.innerHTML = entries.length
      ? entries.map((e, i) => `<option value="${i}" title="${esc(e.title)}">${esc(e.label)}</option>`).join("")
      : `<option value="">${t("nenhuma habilidade disponível")}</option>`;
    const runBtn = B.doc.querySelector("#mtgSkillRunBtn");
    if (runBtn) runBtn.onclick = () => {
      const entry = entries[Number(skillSel.value)];
      const dir = currentMeetingDir(id);
      if (!entry || !dir) return;
      runHabilidadeEntry(entry, dir);
    };
  }
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
// meeting's artefatos/ + relatorio.md; we refresh the tree afterwards so the new
// files surface (the skill never touches manifest.json, so the rail's artefatos
// list only reflects app-written artifacts).
function runMeetingSkill(kind, id, question, dirOverride) {
  const dir = dirOverride || currentMeetingDir(id);
  if (!dir) { toast(t("abra a reunião para analisar")); return; }
  const cmd = LM.meetingSkillCmd(kind, dir, question);
  if (!cmd) { toast(t("digite uma pergunta")); return; }
  termRunAgent(cmd);
  toast(kind === "question" ? t("pergunta enviada ao agente do terminal") : t("análise enviada ao agente do terminal"), 4000);
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
    `<p class="pmnote mono">${t("a pergunta roda no Claude do terminal (ADR-0012); a resposta aparece lá e em artefatos/respostas.")}</p>` +
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
async function mtgDeleteAudio(id, which) {
  const label = { completo: t("áudio completo"), mic: t("microfone"), system: t("sistema") }[which] || t("áudio");
  if (!window.confirm(`${t("Apagar o")} ${label} ${t("desta reunião? Esta ação não pode ser desfeita.")}`)) return;
  try {
    await invoke("brain_meeting_delete_audio", { input: { id, which } });
    toast(`${label} ${t("apagado")}`);
    refreshLivingInPlace(id); // repinta a partir do manifest atualizado
  } catch (e) { toast(t("não apaguei o áudio") + ": " + tErr(String(e))); clog("delete_audio error: " + e); }
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
      ? `<label class="wfield"><span class="mono">${allowLoose ? t("onde salvar") : "brainstorming"}</span>` +
          `<select id="mtgTema">${loose}${opts}</select></label>`
      : `<label class="wfield"><span class="mono">brainstorming</span>` +
          `<input id="mtgNovoTema" type="text" placeholder="${t("ex.: frota 2026")}" spellcheck="false"></label>`;
    const html =
      `<p class="pmnote mono">${t("a reunião é gravada 100% na sua máquina — o áudio nunca sai do computador.")}</p>` +
      temaField +
      `<label class="wfield"><span class="mono">${t("título")}</span>` +
        `<input id="mtgTitulo" type="text" placeholder="${t("opcional — ex.: semanal de custos")}" spellcheck="false"></label>`;
    openModal(allowLoose ? t("Nova gravação") : t("Nova reunião"), html, t("começar"), () => {
      const selEl = $("mtgTema");
      const novo = (($("mtgNovoTema") && $("mtgNovoTema").value) || "").trim();
      const tema = selEl ? selEl.value : novo;
      const titulo = (($("mtgTitulo") && $("mtgTitulo").value) || "").trim();
      // the modal closes on confirm regardless; abort (never hang) if no brainstorming
      if (!tema && !allowLoose) { toast(t("escolha ou nomeie um brainstorming")); finish(null); return; }
      finish({ tema: tema || null, titulo: titulo || null });
    });
    PM.cancel.addEventListener("click", () => finish(null), { once: true });
    PM.close.addEventListener("click", () => finish(null), { once: true });
  });
}

// contextual header actions (move/delete) for the active document
function applyDocActions(rel) {
  const isQueue = rel.startsWith("inbox/") && !rel.endsWith("_prompt.md");
  const movable = isQueue || /^(reunioes|notas)\//.test(rel) ||
    /^contextos\/.+\/(referencias|brainstorming)\//.test(rel);
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
  B.docWrap.hidden = false;
  $("bDraftNote").hidden = true;   // the first-edit note is one-time; reset per render
  closeFind();
  B.crumb.textContent = isGuide ? t("instruções do loop") : tab.rel === MANUAL_REL ? t("manual de uso") : tab.rel;
  // permanent world badge (versionado / rascunho), else document-specific badge
  const world = LoroWorld.crumbBadge(tab.kind, settings.uiLang);
  const [label, cls] = world && !isGuide ? [world.label, world.cls] : docBadge(tab.rel, isGuide);
  B.badge.textContent = label; B.badge.className = "mono badge " + cls;
  setDocGit(tab.rel, tab.kind, isGuide);
  if (isGuide) $("bDocActs").hidden = true; else applyDocActions(tab.rel);
  // ADR-0007 (owner request): habilidade/pedir à IA/versionar live in the
  // doc's right-side rail, not the header — a meeting's living surface
  // renders its own rail (paintMeetingSurface/meetingRailHtml) instead.
  if (!LM.isLiving(tab.rel)) renderDocRail(tab, isGuide);
  // ADR-0010: a meeting living file (reuniao.md) is its own append-only surface —
  // transcript + artefatos rail + análise/consent; no free-form CM6 editing.
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
  const textFile = isGuide || /\.(md|txt)$/i.test(tab.rel);
  B.modes.hidden = !textFile;
  B.viewBtn.classList.toggle("on", tab.mode !== "edit");
  B.editBtn2.classList.toggle("on", tab.mode === "edit");
  if (textFile && tab.mode === "edit") await mountEditor(tab, stale);
  else await renderView(tab, stale);
  if (stale()) return;
  updatePromotedBadge(tab);
  B.wsBody.scrollTop = 0;
  markSel();
}

// ADR-0007 (owner request): habilidade / pedir à IA / versionar as a right-
// side rail on the document viewer — the SAME pattern (visible buttons; the
// habilidade control is a dropdown + ▶ play button, never a menu) used on
// the meeting surface and the acervo header. Each action shows only when it
// actually applies to the open doc; the whole rail hides when none do.
function renderDocRail(tab, isGuide) {
  const rail = $("bDocRail");
  if (!rail) return;
  const isMd = tab.rel.endsWith(".md") && tab.rel !== MANUAL_REL;
  // "pedir à IA": non-versioned markdown only (evolves a note in place) —
  // same scope as before, just relocated.
  const aiable = !isGuide && isMd && tab.rel.startsWith("brainstorming/");
  // "habilidade": any markdown file except the loop guide/manual.
  const skillable = !isGuide && isMd;
  // "versionar": viewing a context file — a shortcut into the same action
  // as the acervo header's git button.
  const versionable = !isGuide && tab.kind === "context";
  if (!aiable && !skillable && !versionable) { rail.hidden = true; rail.innerHTML = ""; return; }
  rail.hidden = false;
  rail.innerHTML =
    (skillable ? `<div class="rail-sec">` +
      `<div class="rail-head">${ico("skill")} ${t("habilidade")}</div>` +
      `<div class="rail-row">` +
        `<select id="railSkillSelect" class="mini-select"></select>` +
        `<button class="railbtn icon cta" id="railSkillRunBtn" title="${t("executar")}">▶</button>` +
      `</div>` +
    `</div>` : "") +
    (aiable ? `<div class="rail-sec">` +
      `<button class="railbtn" id="railAskAiBtn">✦ ${t("pedir à IA…")}</button>` +
    `</div>` : "") +
    (versionable ? `<div class="rail-sec">` +
      `<button class="railbtn" id="railVersionarBtn">⎇ ${t("versionar")}</button>` +
    `</div>` : "");
  if (skillable) {
    const sel = $("railSkillSelect");
    const entries = allHabilidadeEntries();
    sel.innerHTML = entries.length
      ? entries.map((e, i) => `<option value="${i}" title="${esc(e.title)}">${esc(e.label)}</option>`).join("")
      : `<option value="">${t("nenhuma habilidade disponível")}</option>`;
    $("railSkillRunBtn").onclick = () => {
      const entry = entries[Number(sel.value)];
      if (entry) runHabilidadeEntry(entry, tab.rel);
    };
  }
  if (aiable) $("railAskAiBtn").onclick = () => promptNoteAI(tab.rel, true);
  if (versionable) $("railVersionarBtn").onclick = promptVersionar;
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
  if (para) { badge.hidden = false; badge.textContent = t("promovido") + " → " + para; }
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
  if (res.tipo === "doc") { openDoc(res.rel, { preview: true }); return; }
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
const COMMANDS = [
  { label: "ir para início", code: "KeyH", run: () => openHome() },
  { label: "abrir manual", code: "KeyM", run: () => openDoc(MANUAL_REL, { preview: false }) },
  { label: "apresentação do Loro", code: "KeyA", run: () => showWelcome() },
  { label: "alternar visualizar/editar", combo: IS_MAC ? "⌘E" : "Ctrl+E", run: () => toggleActiveMode() },
  { label: "fechar aba", combo: IS_MAC ? "⌘W" : "Ctrl+W", run: () => closeActiveTab() },
  { label: "reabrir aba", code: "KeyT", run: () => reopenClosedTab() },
  { label: "perguntar ao acervo", code: "KeyQ", run: () => askAcervo() },
  { label: "novo contexto", code: "KeyC", run: () => promptNewContext() },
  { label: "novo brainstorming", code: "KeyB", run: () => promptNewTema() },
  { label: "novo caderno", code: "KeyK", run: () => promptNewNotebook() },
  { label: "nova reunião", code: "KeyR", run: () => startMeetingFlow() },
  { label: "encerrar reunião", code: "KeyX", run: () => { if (meeting.active) stopSession(); else toast(t("nenhuma reunião em andamento")); } },
  { label: "abrir relatório", code: "KeyO", run: () => buildAndOpenReport() },
  { label: "marcar dúvida", code: "Digit1", run: () => markMeeting("duvida") },
  { label: "marcar decisão", code: "Digit2", run: () => markMeeting("decisao") },
  { label: "marcar investigação", code: "Digit3", run: () => markMeeting("investigacao") },
  { label: "migrar acervo", code: "KeyG", run: () => runMigration() },
  { label: "instruções do loop", code: "KeyI", run: () => openGuideDoc() },
  { label: "versionar", code: "KeyV", run: () => B.gitBtn.click() },
  { label: "propor mudança", code: "KeyP", run: () => B.proposeBtn.click() },
];
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
  B.cmdkInput.focus(); B.cmdkInput.select();
}
function closePalette() { B.cmdk.hidden = true; cmdkRows = []; cmdkIndex = 0; }

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
  if (isCmd) {
    // COMMANDS holds pt msgids; translate at render time so a language switch applies
    cmdkRows = LoroFuzzy.filter(query, COMMANDS, (c) => t(c.label))
      .map((c) => ({ kind: "cmd", label: t(c.label), run: c.run, combo: comboLabel(c) }));
  } else {
    const src = query ? paletteIndex : mruRecents();
    cmdkRows = LoroFuzzy.filter(query, src, (it) => it.rel)
      .map((it) => ({ kind: "file", rel: it.rel, label: it.title || it.rel, sub: it.rel, world: it.kind }));
  }
  cmdkIndex = 0;
  B.cmdkList.innerHTML = cmdkRows.length
    ? cmdkRows.map((r, i) => {
        const world = r.kind === "file" && r.world === "context" ? t("versionado")
          : r.kind === "file" && r.world === "personal" ? t("rascunho") : "";
        const badge = world ? `<span class="cmdk-w ${r.world}">${world}</span>` : "";
        const sub = r.sub ? `<span class="cmdk-sub mono">${esc(r.sub)}</span>` : "";
        const kbd = r.combo ? `<span class="cmdk-k mono">${esc(r.combo)}</span>` : "";
        return `<li class="cmdk-item${i === 0 ? " on" : ""}" data-i="${i}"><span class="cmdk-l">${esc(r.label)}</span>${sub}${badge}${kbd}</li>`;
      }).join("")
    : `<li class="cmdk-empty mono">${t("nada encontrado")}</li>`;
  B.cmdkList.querySelectorAll("[data-i]").forEach((li) => {
    li.onmousemove = () => setCmdkIndex(Number(li.dataset.i));
    li.onclick = () => { setCmdkIndex(Number(li.dataset.i)); runPalette(); };
  });
}
function setCmdkIndex(i) {
  cmdkIndex = i;
  B.cmdkList.querySelectorAll(".cmdk-item").forEach((li, k) => li.classList.toggle("on", k === i));
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
  // palette + Esc win even when the terminal has focus
  if (mod && !e.shiftKey && key === "p") { own(); openPalette("file"); return; }
  if (mod && e.shiftKey && key === "p") { own(); openPalette("command"); return; }
  if (key === "escape") {
    if (paletteOpen()) { own(); closePalette(); return; }
    if (!B.find.hidden) { own(); closeFind(); return; }
  }
  if (paletteOpen()) return;   // the palette input owns the rest of its keys
  // every palette command answers to mod+alt+<code> — app-level chords, so they
  // win even over the terminal (the shell has no claim on ⌘⌥ combos)
  if (mod && e.altKey && !e.repeat) {
    const cmd = COMMANDS.find((c) => c.code === e.code);
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
  B.acervoName.textContent = cur ? cur.name : t("acervo");
  applyAccent(cur ? cur.color : "");
}
B.acervoBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!B.acervoMenu.hidden) return closeFloat();
  B.acervoMenu.innerHTML =
    acervos.map((a) => `<div class="fitem2${a.id === activeAcervo ? " on" : ""}" data-acervo="${esc(a.id)}">
        <span class="fn">${esc(a.name)}</span>${a.autoContext ? '<span class="pill">auto</span>' : ""}
        <button class="rowmenu" data-rmacervo="${esc(a.id)}" title="${t("remover projeto do Loro (a pasta é preservada)")}">×</button></div>`).join("") +
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
}

function openNewAcervo() {
  creatingNew = true;
  B.wizTitle.textContent = t("Novo projeto (acervo)");
  B.nameInput.value = ""; B.ctxInput.value = ""; brainDir = ""; B.dirBtn.textContent = "…";
  B.autoInput.checked = true; B.gitInput.checked = true;
  B.agentInput.value = "claude";
  wizColor = ""; wizTemplate = "generico"; wizCtxDirty = false;
  drawWizColors();
  loadWizTemplates();
  B.cancelBtn.hidden = false; B.setupErr.hidden = true;
  B.setup.hidden = false; B.shell.hidden = true;
  B.nameInput.focus();
}
function drawWizColors() {
  renderSwatches($("wizColors"), wizColor, (hex) => { wizColor = hex; drawWizColors(); applyAccent(hex); });
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
    const tpl = wizTemplates.find((x) => x.id === wizTemplate);
    if (tpl) B.ctxInput.value = LoroPresets.prefillContexts(B.ctxInput.value, wizCtxDirty, tpl.contexts);
    drawWizHint();
  };
  drawWizHint();
}
function drawWizHint() {
  const sel = wizTemplates.find((x) => x.id === wizTemplate);
  const hint = B.wizTemplateHint;
  hint.innerHTML = "";
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

// setup / criar acervo
B.dirBtn.addEventListener("click", async () => {
  try { const d = await invoke("pick_folder"); if (d) { brainDir = d; B.dirBtn.textContent = d; } }
  catch (e) { clog("pick_folder error: " + e); }
});
B.createBtn.addEventListener("click", async () => {
  const contexts = B.ctxInput.value.split(",").map((s) => s.trim()).filter(Boolean);
  B.setupErr.hidden = true;
  try {
    const av = await invoke("brain_setup", {
      dir: brainDir, contexts,
      name: B.nameInput.value.trim() || null,
      autoContext: B.autoInput.checked,
      gitInit: B.gitInput.checked,
      color: wizColor || null,
      template: wizTemplate || null,
      agent: B.agentInput.value.trim() || null,
      // ADR-0002 §1: no per-project language — seeds follow the UI language
    });
    acervos = av.acervos || []; activeAcervo = av.active || "";
    creatingNew = false;
    toast(t("projeto criado"));
    settings.saveDir = ""; persistSettings();
    setupWorkspace(); sideSig = ""; brainRefresh();
  } catch (e) {
    B.setupErr.textContent = tErr(String(e)); B.setupErr.hidden = false;
  }
});

// ---- versionar (branch + commit local) → propor mudança (push + PR/RFC) ----
// O Git fica escondido: o usuário só "versiona" e depois "propõe a mudança".
// Extraída para função (ADR-0007): o mesmo botão "versionar" também aparece
// no rail lateral de um documento de contexto, não só no cabeçalho da acervo.
function promptVersionar() {
  openEditor(
    t("Versionar mudança — descreva em uma linha"),
    "",
    async (desc) => {
      const message = (desc || "").trim();
      if (!message) throw t("descreva a mudança");
      const r = await invoke("brain_version", { slug: message, message });
      toast(`${t("versionado em")} ${r.branch}`);
      // sync degraded (offline / diverged main): tell the user, don't block
      if (r.warn) toast(tErr(r.warn), 5000);
    }
  );
}
B.gitBtn.addEventListener("click", promptVersionar);

// ADR-0002 §2 — branch picker: see the current branch, switch to another local
// branch or create a new rfc/. Switching with a dirty tree is blocked by the
// backend (err.working_tree_dirty); the remedy is the Versionar button itself.
async function openBranchPicker() {
  let info;
  try { info = await invoke("git_branches"); } catch (e) { toast(tErr(String(e))); return; }
  const afterSwitch = (branch) => {
    toast("⎇ " + branch);
    // the disk changed under the open tabs — reset to Home (acervo-switch pattern)
    setupWorkspace(); sideSig = ""; brainRefresh();
  };
  const rows = (info.branches || []).map((b) => {
    const cur = b === info.current, def = b === info.default;
    return `<div class="fitem2${cur ? " on" : ""}" data-branch="${esc(b)}"><span class="fn mono">${cur ? "● " : ""}${esc(b)}${def ? ` (${t("principal")})` : ""}</span></div>`;
  }).join("");
  const body = openModal(
    t("Branch de trabalho"),
    `<div class="fitem2 muted fstatic">${t("mudanças de conhecimento nascem em branches rfc/ — a principal é protegida")}</div>` +
      rows +
      `<div class="fsep"></div><div class="fitem2 add" data-newbranch>＋ ${t("nova branch…")}</div>`,
    null,
    null
  );
  body.querySelectorAll("[data-branch]").forEach((el2) => (el2.onclick = async () => {
    closeModal();
    const b = el2.dataset.branch;
    if (b === info.current) return;
    try { afterSwitch(await invoke("git_switch_branch", { branch: b })); }
    catch (e) { toast(tErr(String(e)), 5000); }
  }));
  const nb = body.querySelector("[data-newbranch]");
  if (nb) nb.onclick = () => {
    closeModal();
    openEditor(t("Nova branch — descreva a mudança em uma linha"), "", async (desc) => {
      const slug = (desc || "").trim();
      if (!slug) throw t("descreva a mudança");
      afterSwitch(await invoke("git_create_branch", { slug }));
    });
  };
}
if (B.branchBtn) B.branchBtn.addEventListener("click", openBranchPicker);

B.proposeBtn.addEventListener("click", () => {
  openEditor(
    t("Propor mudança (RFC) — corpo do Pull Request"),
    t("## Resumo da mudança\n\n\n## Contexto afetado\n\n\n## Riscos e pendências\n"),
    async (body) => {
      const title = (body || "").split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) || "RFC";
      const pr = await invoke("brain_propose_change", { title, body });
      toast(pr.number ? `PR #${pr.number} ${t("aberto")}` : t("mudança proposta"));
    }
  );
});

// ============================ produção: modal genérico (ADR-0009) ============================
// One reusable confirm sheet drives the promotion picker and the migration
// preview: a title, an HTML body the caller may wire, and a confirm handler.
const PM = {
  wrap: $("pmWrap"), title: $("pmTitle"), body: $("pmBody"),
  confirm: $("pmConfirm"), cancel: $("pmCancel"), close: $("pmClose"),
};
let pmOnConfirm = null;
function openModal(title, bodyHtml, confirmLabel, onConfirm) {
  PM.title.textContent = title;
  PM.body.innerHTML = bodyHtml;
  PM.confirm.textContent = confirmLabel || t("confirmar");
  PM.confirm.hidden = !onConfirm;
  pmOnConfirm = onConfirm || null;
  PM.wrap.hidden = false;
  return PM.body;
}
function closeModal() { PM.wrap.hidden = true; pmOnConfirm = null; }
PM.close.addEventListener("click", closeModal);
PM.cancel.addEventListener("click", closeModal);
PM.wrap.addEventListener("click", (e) => { if (e.target === PM.wrap) closeModal(); });
PM.confirm.addEventListener("click", async () => {
  if (!pmOnConfirm) return closeModal();
  try { const fn = pmOnConfirm; closeModal(); await fn(); }
  catch (e) { toast(tErr(String(e))); clog("modal confirm error: " + e); }
});
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !PM.wrap.hidden) closeModal(); });

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
  inp.placeholder = t("nome do brainstorming (Enter) · ex.: frota 2026");
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
      if (r && r.rel) openDoc(`${r.rel}/indice.md`, { preview: false });
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
  if (!sourceRel) { toast(t("abra um caderno pessoal para promover")); return; }
  if (!sourceRel.startsWith("pessoal/")) { toast(t("apenas itens pessoais podem ser promovidos")); return; }
  const ctxs = lastSt ? lastSt.contexts.map((c) => c.name) : [];
  if (!ctxs.length) { toast(t("crie um contexto antes de promover")); return; }
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
    : t("sem anexos — apenas o texto será mesclado no context.md");
  const opts = ctxs.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  const html =
    `<p class="pmnote mono">${t("não destrutivo — o original permanece no seu espaço pessoal (rascunho). Áudio nunca é copiado; vira referência em texto.")}</p>` +
    `<label class="pmfield"><span class="mono">${t("de")}</span><span class="mono pmsrc">${esc(sourceRel)}</span></label>` +
    `<label class="pmfield"><span class="mono">${t("destino")}</span><select id="pmDest" class="mini-select">${opts}</select></label>` +
    `<div class="pmphead mono">${t("será preparado (staged) em referencias/ e mesclado no context.md:")}</div>` +
    `<div class="pmpreview mono">${preview}</div>`;
  openModal(t("Promover para contexto"), html, t("promover"), async () => {
    const destContext = $("pmDest").value;
    const r = await invoke("brain_promote", { sourceRel, destContext, mode: "merge" });
    toast(`${t("promovido")} → ${destContext}`);
    refreshTabFromDisk(sourceRel);
    sideSig = ""; pessoalSig = ""; brainRefresh(); refreshPessoal();
    offerPropose(r, destContext);
  });
}
// after a promotion, offer to version+propose right away (existing ADR-0004 flow)
function offerPropose(r, destContext) {
  const files = (r && r.stagedFiles) || [];
  const entry = r && r.changelogEntry ? `<div class="pmphead mono">CHANGELOG: ${esc(String(r.changelogEntry))}</div>` : "";
  const html =
    `<p class="pmnote mono">${t("promovido para")} <b>${esc(destContext)}</b> — ${t("nada foi versionado ainda (não destrutivo).")}</p>` +
    `<div class="pmpreview mono">${files.length ? files.map((f) => "• " + esc(f)).join("<br>") : t("context.md atualizado")}</div>${entry}`;
  openModal(t("Mudança pronta"), html, t("propor mudança agora"), async () => { B.gitBtn.click(); });
}

// ---- migrar acervo (simulação → aplicar) — estende brain_migrate (ADR-0004/0009) ----
function migrationBodyHtml(rep) {
  const moves = rep && (rep.moves || rep.planned || rep.movimentos);
  let lines = [];
  if (Array.isArray(moves)) {
    lines = moves.map((m) => typeof m === "string" ? m : `${m.from || m.de || "?"} → ${m.to || m.para || "?"}`);
  }
  const preview = lines.length ? lines.map((l) => "• " + esc(l)).join("<br>") : t("nada a migrar");
  return `<p class="pmnote mono">${t("simulação — nada é movido ainda · notas/ permanece versionado · incubadora/ vira tema pessoal")}</p>` +
    `<div class="pmpreview mono">${preview}</div>`;
}
async function runMigration() {
  let rep;
  try { rep = await invoke("brain_migrate", { apply: false }); }
  catch (e) { toast(t("falha ao planejar migração")); clog("migrate error: " + e); return; }
  openModal(t("Migrar acervo (simulação)"), migrationBodyHtml(rep), t("aplicar migração"), async () => {
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
  toast(p.destContext ? `${t("promovido")} → ${p.destContext}` : t("promoção concluída"));
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
  refreshNotifications();
}
function renderGhCard() {
  const d = envDoctor;
  B.proposeBtn.hidden = !(d && d.versioningEnabled);
  // opt-in: só mostra o card quando o usuário caminha p/ colaboração (gh instalado
  // ou já há um remoto). Sem isso, o fluxo segue 100% local, sem ruído.
  const heading = d && (d.gh.detail || d.remote.detail);
  if (!heading) { B.ghCard.hidden = true; return; }
  B.ghCard.hidden = false;
  B.ghState.textContent = d.versioningEnabled ? `${t("conectado")}${d.account ? " · @" + d.account : ""}` : "local";
  B.ghState.className = "mono badge " + (d.versioningEnabled ? "ok" : "ro");
  const rows = [
    ["git", d.git], ["gh (GitHub CLI)", d.gh], [t("autenticação"), d.ghAuth],
    [t("identidade git"), d.gitIdentity], [t("repositório remoto"), d.remote],
  ];
  B.ghChecks.innerHTML = rows.map(([label, c]) => {
    const fix = c.fixable && !c.ok ? ` <button class="mini act" data-fix="identity">${t("corrigir")}</button>` : "";
    return `<li class="ghchk ${c.ok ? "on" : "off"}"><span>${c.ok ? "✓" : "•"} ${esc(label)}</span>` +
      `<span class="ghhint mono">${esc(c.detail || c.hint || "")}</span>${fix}</li>`;
  }).join("");
  B.ghChecks.querySelectorAll("[data-fix]").forEach((b) => (b.onclick = fixIdentity));
}
async function fixIdentity() {
  openEditor(t("Identidade do git — nome e e-mail (uma linha cada)"), t("Seu Nome\nseu@email"), async (v) => {
    const [name, email] = (v || "").split("\n").map((s) => s.trim());
    if (!name || !email) throw t("informe nome e e-mail");
    await invoke("env_set_identity", { name, email });
    refreshEnv(true);
  });
}
B.ghCheck.addEventListener("click", () => refreshEnv(true));

// Notificações (colaboração): derivadas dos PRs abertos. Sem GitHub → oculto.
async function refreshNotifications() {
  if (!envDoctor || !envDoctor.versioningEnabled) { B.ghNotif.hidden = true; return; }
  let n;
  try { n = await invoke("brain_notifications"); } catch (_) { B.ghNotif.hidden = true; return; }
  if (!n.connected) { B.ghNotif.hidden = true; return; }
  const parts = [];
  if (n.reviewRequestedToMe.length) parts.push(`⌛ ${n.reviewRequestedToMe.length} ${t("aguardam sua revisão")}`);
  if (n.awaitingApproval.length) parts.push(`${n.awaitingApproval.length} ${t("aguardando aprovação")}`);
  if (n.changesPending.length) parts.push(`${n.changesPending.length} ${t("com ajustes pedidos")}`);
  if (n.recentlyApproved.length) parts.push(`✓ ${n.recentlyApproved.length} ${t("aprovadas")}`);
  B.ghNotif.hidden = parts.length === 0;
  B.ghNotif.textContent = parts.join(" · ");
}

// Timeline: navegar versões do conhecimento sem expor commits/hashes/branches.
// Acionada pelo selo de versionamento do documento aberto.
function showTimeline(rel) {
  invoke("brain_timeline", { rel }).then((items) => {
    const body = items.length
      ? items.map((c) => {
          const when = c.when ? new Date(c.when).toLocaleString(uiLocale(), { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
          return `• ${when} — ${c.label}${c.author ? ` (${c.author})` : ""}`;
        }).join("\n")
      : t("(sem versões anteriores ainda)");
    openEditor(`${t("Histórico")} — ${rel}`, body, null);
  }).catch((e) => { toast(t("sem histórico")); clog("timeline error: " + e); });
}
B.gitBadge.addEventListener("click", () => { const rel = currentRel(); if (rel) showTimeline(rel); });

// ---- confirmação destrutiva EXPLÍCITA (nada de "confirmar?" escondido) ----
function openConfirmDelete(anchor, name) {
  B.acervoMenu.hidden = true;
  B.bMenu.innerHTML =
    `<div class="fhead">${t("apagar da fila")}</div>
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
}

// ---- menu agrupado do item da fila: mover / apagar ----
function openQueueMenu(anchorEl, name) {
  B.acervoMenu.hidden = true;
  B.bMenu.innerHTML =
    `<div class="fhead">${esc(name)}</div>
     <div class="fitem2" data-a="mv"><span class="fn">⇢ ${t("mover para…")}</span></div>
     <div class="fitem2 ditem" data-a="del"><span class="fn">${t("apagar…")}</span></div>`;
  B.bMenu.querySelector('[data-a="mv"]').onclick = () => openMoveMenu(anchorEl, name);
  B.bMenu.querySelector('[data-a="del"]').onclick = () => openConfirmDelete(anchorEl, name);
  placeMenu(anchorEl);
}

// ---- menu de ações do contexto/pasta: renomear/mover, deletar ----
function placeMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  B.bMenu.style.left = Math.min(r.left, window.innerWidth - 250) + "px";
  B.bMenu.style.top = r.bottom + 4 + "px";
  B.bMenu.hidden = false;
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
  closeTabsUnder("contextos/" + name + "/", false);
  sideSig = ""; brainRefresh();
}
function openCtxMenu(anchor, name, isFolder) {
  B.acervoMenu.hidden = true;
  B.bMenu.innerHTML =
    `<div class="fhead">${esc(name)}${isFolder ? ` (${t("pasta")})` : ""}</div>
     <div class="fitem2 strong" data-a="ask"><span class="fn">? ${t("perguntar…")}</span></div>
     <div class="fsep"></div>
     <div class="fitem2" data-a="ren"><span class="fn">✎ ${t("renomear")}</span></div>
     <div class="fitem2" data-a="mv"><span class="fn">⇢ ${t("mover para…")}</span></div>
     <div class="fitem2 ditem" data-a="del"><span class="fn">${t("deletar…")}</span></div>`;
  B.bMenu.querySelector('[data-a="ask"]').onclick = () => { closeFloat(); askAcervo(name); };
  B.bMenu.querySelector('[data-a="ren"]').onclick = () => openRenameCtx(anchor, name);
  B.bMenu.querySelector('[data-a="mv"]').onclick = () => openMoveCtxMenu(anchor, name, isFolder);
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
    `<div class="fhead">${t("deletar")} ${isFolder ? t("pasta") : t("contexto")}</div>
     <div class="fitem2 muted fstatic">“${esc(name)}” ${isFolder ? t("e todos os subcontextos serão apagados") : t("será apagado")} ${t("do disco (se o projeto é versionado, o histórico git preserva)")}</div>
     <div class="confirm-actions">
       <button class="btn-danger" data-yes>${t("deletar")}</button>
       <button class="link mono muted" data-no>${t("cancelar")}</button>
     </div>`;
  B.bMenu.querySelector("[data-yes]").onclick = async () => {
    closeFloat();
    try {
      await invoke("brain_delete_context", { name });
      toast(t("deletado"));
      closeTabsUnder("contextos/" + name + "/", false);
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
                 : `<div class="fitem2 muted fstatic">${t("sem contextos")}</div>`) +
    `<div class="fsep"></div><div class="fitem2" data-ref=""><span class="fn">→ ${t("notas (sem contexto)")}</span></div>`;
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
                : `<div class="fitem2 muted">${t("sem contextos")}</div>`) +
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
}
// enviar arquivos p/ a fila (com direcionamento opcional)
$("brainImport").addEventListener("click", async () => {
  const ctx = $("importCtx").value || null;
  try {
    const n = await invoke("brain_import", { context: ctx });
    if (n > 0) { toast(`${n} ${n > 1 ? t("arquivos na fila") : t("arquivo na fila")}`); sideSig = ""; brainRefresh(); }
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
  inp.placeholder = t("nome-do-contexto (Enter) · ex.: engenharia/qa");
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
let term = null, fit = null, termReady = false;
function setTermPanel(open) {
  $("termPanel").hidden = !open;
  if (open) { if (!term) initTerm(); requestAnimationFrame(fitTerm); if (term) term.focus(); }
}
function fitTerm() {
  if (!fit || $("termPanel").hidden) return;
  try {
    fit.fit();
    invoke("term_resize", { cols: term.cols, rows: term.rows }).catch(() => {});
  } catch (_) {}
}
function initTerm() {
  const Term = window.Terminal, Fit = window.FitAddon && window.FitAddon.FitAddon;
  if (!Term) { toast(t("terminal indisponível")); clog("xterm missing"); return; }
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  term = new Term({
    fontFamily: "ui-monospace, SF Mono, Menlo, monospace", fontSize: 12.5,
    cursorBlink: true, scrollback: 4000,
    theme: dark
      ? { background: "#121719", foreground: "#ece9e2", cursor: "#2bc5b4" }
      : { background: "#fbfaf6", foreground: "#201d18", cursor: "#0e8c86" },
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
  initTerm();
}
listen("term-output", (e) => { if (term) term.write(e.payload); });
listen("term-exit", () => { if (term) term.write(`\r\n\x1b[2m[${t("processo encerrado — 'reiniciar' para abrir de novo")}]\x1b[0m\r\n`); termReady = false; });
$("termBtn").addEventListener("click", () => setTermPanel($("termPanel").hidden));
$("termCollapse").addEventListener("click", () => setTermPanel(false));
$("termClear").addEventListener("click", restartTerm);
window.addEventListener("resize", fitTerm);
// orientação: embaixo (padrão) ou lateral direita — escolha do usuário, persistida
function applyTermLayout() {
  $("mainRow").classList.toggle("side", !!settings.termSide);
  requestAnimationFrame(fitTerm);
}
$("termSide").addEventListener("click", () => {
  settings.termSide = !settings.termSide; persistSettings(); applyTermLayout();
});

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
// Skills run asynchronously in the terminal agent, and the sidebar's signature
// only tracks the brainstorming LIST — artifacts the agent writes (analyses,
// answers, report sections) never change it. After any injected action, force
// a refresh burst: every 5s for 2 minutes, sig cleared so expanded children
// (meetings + artefatos) reload. Skipped while the user types in a sidebar
// inline input, so a re-render never eats a half-written note title.
let actionRefreshTimer = null, actionRefreshUntil = 0;
function scheduleActionRefresh(ms = 120000) {
  actionRefreshUntil = Date.now() + ms;
  if (actionRefreshTimer) return;
  actionRefreshTimer = setInterval(() => {
    if (Date.now() > actionRefreshUntil) {
      clearInterval(actionRefreshTimer); actionRefreshTimer = null; return;
    }
    const focused = document.activeElement;
    if (focused && focused.closest && focused.closest(".bside") &&
        (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA")) return;
    pessoalSig = ""; refreshPessoal();
    sideSig = ""; brainRefresh();
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
  if (!cfg || !cfg.brainDir) { toast(tErr("err.acervo_not_configured")); return; }
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
      return;
    }
    // ADR-0007: term_open already typed the launch line — a fresh session
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
}

// ---- setup guiado: o Loro verifica dependências e resolve pelo terminal ----
const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin";
async function checkSetup() {
  try {
    const d = await invoke("doctor");
    const missing = [];
    if (!d.whisper_stream) missing.push(t("whisper (motor de transcrição)"));
    if (!d.models || d.models.length === 0) missing.push(t("modelo de voz"));
    const banner = $("setupBanner");
    if (!missing.length) { banner.hidden = true; return; }
    $("setupMsg").textContent = t("faltam dependências") + ": " + missing.join(" · ");
    banner.hidden = false;
    $("setupRun").onclick = () => {
      const parts = [];
      if (!d.whisper_stream) parts.push("brew install whisper-cpp");
      if (!d.models || d.models.length === 0)
        parts.push(`mkdir -p ~/.loro/models && curl -L --progress-bar -o ~/.loro/models/ggml-large-v3-turbo.bin ${MODEL_URL}`);
      termRun(parts.join(" && "));
      toast(t("instalando no terminal — acompanhe abaixo"), 4000);
    };
  } catch (_) {}
}

// fluxo guiado do áudio do sistema: instala BlackHole e abre o Áudio MIDI
function openBlackholeSetup() {
  B.acervoMenu.hidden = true;
  B.bMenu.innerHTML =
    `<div class="fhead">${t("áudio do sistema — configurar")}</div>
     <div class="fitem2 muted fstatic">${t("1 · instale o driver BlackHole · 2 · crie um dispositivo multi-saída (saída padrão) no Áudio MIDI incluindo o BlackHole")}</div>
     <div class="fitem2" data-bh><span class="fn">${t("1 · instalar BlackHole no terminal")}</span></div>
     <div class="fitem2" data-am><span class="fn">${t("2 · abrir Áudio MIDI")}</span></div>`;
  B.bMenu.querySelector("[data-bh]").onclick = () => { closeFloat(); termRun("brew install blackhole-2ch"); };
  B.bMenu.querySelector("[data-am]").onclick = () => { closeFloat(); invoke("open_audio_midi").catch(() => {}); };
  const r = el.privacy.getBoundingClientRect();
  B.bMenu.style.left = Math.max(10, r.left - 200) + "px";
  B.bMenu.style.top = (r.top - 150) + "px";
  B.bMenu.hidden = false;
}

// ---- arrastar arquivos do SISTEMA para a fila (Tauri drag-drop) ----
// um ou mais arquivos soltos na janela (na aba acervo) entram na fila do acervo ativo
listen("tauri://drag-drop", async (e) => {
  if (!brainTab) return;
  const paths = (e.payload && e.payload.paths) || [];
  if (!paths.length) return;
  document.getElementById("app").classList.remove("dropping");
  try {
    const n = await invoke("brain_import_paths", { paths, context: null });
    if (n > 0) { toast(`${n} ${n > 1 ? t("arquivos na fila") : t("arquivo na fila")}`); sideSig = ""; brainRefresh(); }
  } catch (err) { toast(tErr(String(err))); clog("import_paths error: " + err); }
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
  if (!state.lines.length) { toast(t("transcrição vazia")); return; }
  if (settings.autosave) autoSaveNow();
  else { el.savebar.hidden = false; setLivePanel(true); toast(t("transcrição concluída")); }
});
listen("transcribe-error", (e) => {
  toast(t("transcrição falhou") + ": " + tErr(String(e.payload)));
  clog("transcribe-error: " + e.payload);
});

// ADR-0010: "novas linhas ↓" pill (meeting living surface) — click jumps to the
// tail; scrolling to the bottom dismisses it.
if ($("mtgPill")) $("mtgPill").addEventListener("click", scrollMeetingBottom);
B.wsBody.addEventListener("scroll", () => { if (nearBottom(B.wsBody)) hidePill(); });

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
B.dirBtn.textContent = t("escolher pasta…");
resizeWave();
drawIdle();
updateCfgLabel();
updatePrivacy();
setupWorkspace();   // ADR-0008: Home é a primeira aba fixa (não fechável)
initBrain();   // acervo é a tela principal (sem abas)
applyTermLayout();
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
