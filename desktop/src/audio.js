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

  // Monta as constraints do getUserMedia. `noiseSuppression`/`autoGainControl`
  // ficam SEMPRE desligados: ligados (o padrão do WKWebView) processam a voz e
  // colocam o macOS em voice-processing (VPIO), abafando toda a saída de áudio
  // do sistema durante a captura. `echoCancellation` é o único ajustável e tem
  // um efeito colateral do WebKit que obriga a escolha POR FONTE:
  //   - false: o loopback do sistema (BlackHole) chega ao Web Audio e nada é
  //     abafado — usado p/ captura de sistema e p/ reunião (protege o áudio de
  //     sistema que o ScreenCaptureKit grava);
  //   - true: o WebKit passa a alimentar o MICROFONE ao Web Audio (sem isso o
  //     AnalyserNode do mic devolve zeros e a onda não anima), ao custo de
  //     reativar o VPIO — aceitável só no ditado mic-só, onde não há captura de
  //     sistema junto.
  // A transcrição recebe 16 kHz mono via ffmpeg independentemente (ADR-0010).
  // Função pura — sem IPC nem UI.
  function audioConstraints(deviceId, opts) {
    const audio = {
      echoCancellation: !!(opts && opts.echoCancellation),
      noiseSuppression: false,
      autoGainControl: false,
    };
    if (deviceId) audio.deviceId = { exact: deviceId };
    return { audio };
  }

  return { pickCaptureDevice, audioConstraints };
});
