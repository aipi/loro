// Loro — captura de áudio. Módulo isolado e testável (mesmo padrão UMD do text.js):
// carregado no browser via <script> (define window.LoroAudio) e no Node via require().
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroAudio = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  // Escolhe o dispositivo de captura (flag -c do whisper-stream) a partir da
  // lista enumerada e da fonte selecionada. Função pura — sem IPC nem UI.
  //   mic    -> { capture: undefined }   (padrão do sistema, sem -c)
  //   system -> BlackHole, ou { missing: "system" }
  // A fonte "meeting" (reunião) NÃO passa por aqui: ela grava via ScreenCaptureKit
  // (áudio do sistema) + microfone e transcreve ao final (ver ADR-0005).
  function pickCaptureDevice(devices, source) {
    const devs = Array.isArray(devices) ? devices : [];
    if (source === "system") {
      const bh = devs.find((d) => /blackhole/i.test(d.name));
      return bh ? { capture: bh.index } : { missing: "system" };
    }
    return { capture: undefined };
  }

  return { pickCaptureDevice };
});
