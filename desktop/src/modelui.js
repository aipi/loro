// Loro — pure helpers for the transcription-model manager (ADR-0006). Loaded in
// the browser via <script> (defines window.LoroModelUI) and in Node via
// require() for `node --test`. No DOM, no Tauri: rendering lives in app.js, the
// arithmetic and ordering live here so they are unit-tested.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroModelUI = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  // Human-readable size. Uses binary units under conventional MB/GB labels,
  // matching how download sizes are usually shown.
  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    const GiB = 1024 * 1024 * 1024;
    const MiB = 1024 * 1024;
    if (n >= GiB) return (n / GiB).toFixed(1) + " GB";
    // Sub-megabyte assets exist since ADR-0034 (the 885.098-byte VAD model).
    // Without
    // this branch the button offered "1 MB" for 864 KB — the button is the
    // price tag, so it rounds to a unit that can carry the number.
    if (n < MiB) return Math.round(n / 1024) + " KB";
    return Math.round(n / MiB) + " MB";
  }

  // Download progress as a clamped 0–100 integer. Guards a zero/unknown total.
  function progressPercent(downloaded, total) {
    const d = Number(downloaded) || 0;
    const t = Number(total) || 0;
    if (t <= 0) return 0;
    return Math.min(100, Math.max(0, Math.floor((d / t) * 100)));
  }

  // Order for display: the recommended (default) model first, the rest in their
  // catalog order. Never mutates the input.
  function sortModels(list) {
    return (list || [])
      .slice()
      .sort((a, b) => (b.default === true ? 1 : 0) - (a.default === true ? 1 : 0));
  }

  // ---- as peças da voz clonada como linhas do MESMO gerenciador (ADR-0036) ----
  // Elas são da mesma natureza que um modelo — algo grande que se baixa uma vez e
  // fica em ~/.loro — então vivem na mesma superfície em que se baixa modelo, e
  // não num painel próprio. O prefixo distingue quem atende o download: o
  // catálogo do whisper ou o instalador do motor de voz.
  const VOICE_PREFIX = "voice:";

  function isVoicePart(id) {
    return String(id || "").startsWith(VOICE_PREFIX);
  }
  function voicePartOf(id) {
    return isVoicePart(id) ? String(id).slice(VOICE_PREFIX.length) : "";
  }
  function voiceRowId(part) {
    return VOICE_PREFIX + part;
  }

  // Converte o status do instalador para a MESMA forma de uma linha de modelo,
  // para que a tela tenha um só jeito de desenhar "algo grande para baixar".
  // Devolve vazio quando a plataforma não suporta: oferecer o que não instala
  // seria pior que não oferecer.
  function voiceRows(status) {
    if (!status || !status.supported || !Array.isArray(status.parts)) return [];
    return status.parts.map((p) => ({
      id: voiceRowId(p.id),
      label: p.label,
      sizeBytes: p.size,
      installed: !!p.installed,
      default: false,
    }));
  }

  return {
    formatSize,
    progressPercent,
    sortModels,
    voiceRows,
    isVoicePart,
    voicePartOf,
    voiceRowId,
    VOICE_PREFIX,
  };
});
