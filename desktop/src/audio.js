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

  // Restrições do getUserMedia. Loro é um GRAVADOR, não um app de chamada: pedir
  // o microfone com os padrões do navegador (`{ audio: true }`) liga o
  // processamento de voz do sistema — cancelamento de eco, ganho automático e
  // supressão de ruído. No macOS isso muda o caminho de áudio da MÁQUINA
  // INTEIRA, não só o do Loro: a unidade de voice-processing entra no lugar do
  // caminho normal, o ganho automático achata a sua voz (quem ouve diz que você
  // ficou baixo) e a saída passa a soar abafada — inclusive a do app de chamada,
  // que já faz o próprio cancelamento e não precisa do nosso.
  //
  // O eco que o navegador cancelaria é o que o PRÓPRIO Loro toca, e o Loro não
  // toca nada. O custo é medido; o benefício é zero. Então pedimos o dispositivo
  // cru — que é também o que a transcrição quer: ganho automático bombeando e
  // supressão de ruído comendo consoante pioram o reconhecimento.
  const RAW_AUDIO = {
    echoCancellation: false,
    autoGainControl: false,
    noiseSuppression: false,
  };
  // `echoCancel` é a escolha de quem ouve por ALTO-FALANTE: sem ela o microfone
  // escuta os outros de volta pela caixa e a mesma fala entra nas duas trilhas. O
  // rótulo continua certo — o vazamento tem um sentido só e quem cai é sempre a
  // cópia do microfone (LoroMeeting.micLeakOfSystem, ADR-0025) — mas ligar mata o
  // vazamento na origem em vez de limpá-lo depois, e a fala que é 100% vazamento
  // deixa de custar uma linha descartada da transcrição. Ligar
  // custa o processamento de voz do sistema; por isso é escolha, não padrão.
  // Ganho automático e supressão de ruído seguem SEMPRE desligados: são eles que
  // achatam a voz, e nenhum dos dois protege contra o vazamento da caixa.
  function micConstraints(deviceId, echoCancel) {
    const base = { ...RAW_AUDIO, echoCancellation: !!echoCancel };
    return { audio: deviceId ? { ...base, deviceId: { exact: deviceId } } : base };
  }

  // Diarização (WhisperX) depende de bash + Python; o Windows não tem nenhum
  // dos dois por padrão, e o bash.exe de uma instalação típica é o do WSL, que
  // enxerga outro sistema de arquivos (não acha o áudio salvo pelo Loro).
  function diarizeSupported(os) {
    return os !== "windows";
  }

  return { pickCaptureDevice, loopbackPattern, micConstraints, diarizeSupported, RAW_AUDIO };
});
