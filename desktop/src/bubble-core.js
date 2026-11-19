// Loro — the recording bubble's decisions (ADR-0041 §1–§3). Isolated, testable
// module: loaded in the bubble window via <script> (defines window.LoroBubble)
// and in Node via require() for node --test. PURE: no DOM, no IPC.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroBubble = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  // Below this distance a press-and-release is a CLICK. A hand on a trackpad
  // moves 1–3 px while clicking; 4 px keeps those clicks and still starts a drag
  // on the first deliberate movement.
  const DRAG_THRESHOLD_PX = 4;

  function isDrag(a, b, threshold) {
    const t = threshold == null ? DRAG_THRESHOLD_PX : threshold;
    return Math.hypot(b.x - a.x, b.y - a.y) > t;
  }

  // One press at a time: down → (move…) → up. Returns what the window must do:
  // "drag" once, when the movement crosses the threshold (the system then owns
  // the drag); "click" on a release that never crossed it; "none" otherwise.
  function gesture(threshold) {
    let start = null, dragging = false;
    return {
      down(x, y) { start = { x, y }; dragging = false; return "none"; },
      move(x, y) {
        if (!start || dragging) return "none";
        if (!isDrag(start, { x, y }, threshold)) return "none";
        dragging = true;
        return "drag";
      },
      up() {
        const was = start && !dragging;
        start = null; dragging = false;
        return was ? "click" : "none";
      },
    };
  }

  // The panel, open or closed. The icon toggles it; a click outside (blur) and
  // Esc close it; a scheduler prompt opens it so the question is seen.
  function panel(open, event) {
    switch (event) {
      case "icon-click": return !open;
      case "blur":
      case "escape": return false;
      case "prompt": return true;
      default: return !!open;
    }
  }

  const p2 = (n) => String(n).padStart(2, "0");
  function formatElapsed(ms) {
    const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${p2(m)}:${p2(r)}` : `${m}:${p2(r)}`;
  }

  // Recorded time: since the start, minus every pause — the running pause too.
  function elapsedMs(st, nowMs) {
    if (!st || !st.startedAt) return 0;
    const paused = (Number(st.pausedMs) || 0) + (st.rec === "paused" && st.pauseStart ? nowMs - st.pauseStart : 0);
    return nowMs - st.startedAt - paused;
  }

  // The collapsed icon's corner: a STEADY dot (recording), a STEADY pause glyph,
  // or a neutral one while starting/stopping. Never an animation.
  function badge(st, nowMs) {
    const rec = st && st.rec;
    if (rec === "recording") return { kind: "rec", time: formatElapsed(elapsedMs(st, nowMs)) };
    if (rec === "paused") return { kind: "pause", time: formatElapsed(elapsedMs(st, nowMs)) };
    if (rec === "starting" || rec === "stopping") return { kind: "pending", time: null };
    return { kind: null, time: null };
  }

  // Speaker labels of the meeting transcript (ADR-0013: mic = você, system = sistema).
  function whoLabel(source) {
    return source === "system" ? "sistema" : "você";
  }

  function tail(lines, n) {
    return (lines || []).slice(-n);
  }

  // Which buttons the panel shows. A live (non-meeting) recording has no pause:
  // only meetings pause (ADR-0022).
  function controls(st) {
    const rec = st && st.rec;
    if (rec === "idle") return st.canRecord ? ["gravar"] : [];
    if (rec === "recording") return st.meeting ? ["pausar", "encerrar", "nova"] : ["encerrar"];
    if (rec === "paused") return ["retomar", "encerrar", "nova"];
    return [];
  }

  return { DRAG_THRESHOLD_PX, isDrag, gesture, panel, formatElapsed, elapsedMs, badge, whoLabel, tail, controls };
});
