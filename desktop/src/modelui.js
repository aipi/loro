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

  return { formatSize, progressPercent, sortModels };
});
