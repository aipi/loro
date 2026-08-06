// Loro — captura de áudio. Módulo isolado e testável (mesmo padrão UMD do text.js):
// carregado no browser via <script> (define window.LoroAudio) e no Node via require().
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroAudio = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  // Captura de loopback: o dispositivo que devolve a saída do próprio
  // computador como entrada, para transcrever o áudio do sistema (ADR-0012). O
  // mecanismo é o mesmo em toda plataforma, o whisper-stream captura pela flag
  // -c, só o nome do dispositivo muda.
  const LOOPBACK_PATTERNS = {
    // o macOS não tem loopback nativo, o BlackHole é o driver virtual que guiamos
    macos: "blackhole",
    // no Windows é o loopback do próprio driver (instalações pt-BR chamam de
    // "Mixagem estéreo"), ou um VB-Cable quando o driver não tem nenhum
    windows: "stereo mix|mixagem est[ée]reo|cable output|vb-audio|what u hear",
  };

  // O padrão de nome do dispositivo de loopback da plataforma. Serve tanto para
  // a lista do whisper-stream quanto para os labels do enumerateDevices.
  function loopbackPattern(os) {
    return LOOPBACK_PATTERNS[os] || LOOPBACK_PATTERNS.macos;
  }

  // Escolhe o dispositivo de captura (flag -c do whisper-stream) a partir da
  // lista enumerada e da fonte selecionada. Função pura — sem IPC nem UI.
  //   mic    -> { capture: undefined }   (padrão do sistema, sem -c)
  //   system -> dispositivo de loopback da plataforma, ou { missing: "system" }
  // `os` vem do doctor ("macos" | "windows" | "linux"); sem ele assume macOS.
  // A fonte "meeting" (reunião) NÃO passa por aqui: ela grava via ScreenCaptureKit
  // (áudio do sistema) + microfone e transcreve ao final (ver ADR-0005).
  function pickCaptureDevice(devices, source, os) {
    const devs = Array.isArray(devices) ? devices : [];
    if (source === "system") {
      const re = new RegExp(loopbackPattern(os), "i");
      const lb = devs.find((d) => d && re.test(d.name || ""));
      return lb ? { capture: lb.index } : { missing: "system" };
    }
    return { capture: undefined };
  }

  // Sensibilidade da detecção de fala (-vth do whisper-stream). O whisper
  // transcreve quando a fala PAUSA: a energia do último segundo tem de cair
  // abaixo de vth × a média dos anteriores. O 0.6 do whisper.cpp ficava fixo no
  // código e nunca disparava em sala com som contínuo — a gravação rodava sem
  // emitir nada, sem erro. O valor certo depende da sala, por isso é ajustável;
  // o padrão é alto porque falhar para cima gera ruído visível, e falhar para
  // baixo gera silêncio que o usuário não tem como diagnosticar.
  const VAD_MIN = 0.3, VAD_MAX = 1, VAD_DEFAULT = 0.85;

  // Função pura: prende o valor na faixa e cai no padrão se não for número.
  // Um valor fora da faixa desligaria a transcrição tão silenciosamente quanto
  // o 0.6 fixo, então ele nunca chega ao whisper.
  function clampVadThold(v) {
    // ausente é ausente: Number(null) e Number("") são 0, e cair no piso da
    // faixa por omissão daria o valor MENOS sensível — de volta ao silêncio.
    if (v === null || v === undefined || v === "") return VAD_DEFAULT;
    const n = Number(v);
    if (!Number.isFinite(n)) return VAD_DEFAULT;
    return Math.min(VAD_MAX, Math.max(VAD_MIN, n));
  }

  return { pickCaptureDevice, loopbackPattern, clampVadThold, VAD_MIN, VAD_MAX, VAD_DEFAULT };
});
