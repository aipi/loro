// Loro — modo intérprete (ADR-0035). Lógica PURA: o recorte por silêncio e a
// fila. O que toca no microfone, no IPC e na tela fica no app.js; aqui fica o
// que dá para testar sem navegador (mesmo padrão UMD do audio.js).
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroInterpreter = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  // O mesmo julgamento do interpreter.rs::model_translates, e pela mesma razão
  // medida: `large-v3-turbo` IGNORA `-tr` em silêncio e devolve português. Aqui
  // ele serve para a UI DESABILITAR o modo antes de gravar, em vez de deixar o
  // usuário descobrir na reunião. O backend recusa de novo — esta cópia é
  // conveniência de tela, nunca a guarda.
  function canTranslate(model) {
    return !!model && !String(model).includes("turbo");
  }

  // Recorte por SILÊNCIO, não por relógio.
  //
  // O andaime de teste cortava a cada 8s fixos, e é a diferença entre "fale
  // rápido que eu vou cortar" e "fale à vontade, eu espero você parar". O
  // whisper traduz um pensamento fechado; entregar meia frase é o que produz
  // tradução ruim, não a latência.
  //
  // SPEECH_RMS/SILENCE_RMS têm HISTERESE (limiar de entrada acima do de saída):
  // com um limiar só, uma respiração no meio da frase oscila em volta dele e
  // pica a elocução em pedaços.
  // Os limiares são RELATIVOS ao ruído de fundo, não absolutos.
  //
  // A primeira versão usava 0.02 fixo para "isto é fala", um número CHUTADO.
  // Medido 2026-09-06 na máquina do dono: o modo ligou, amostrou a 100ms por
  // minutos e NUNCA passou do limiar — nenhuma elocução saiu, sem erro nenhum.
  // O Loro pede o microfone CRU (audio.js RAW_AUDIO, sem ganho automático),
  // então o nível bruto de uma voz normal fica muito abaixo de um chute feito
  // de fora. Um limiar absoluto é sempre errado para alguém: depende do
  // microfone, do ganho e da distância. O piso de ruído o próprio sinal
  // informa, e fala é o que se destaca DELE.
  const FLOOR_MIN = 0.0004;  // silêncio digital não pode virar fala
  const FLOOR_MAX = 0.05;
  const SPEECH_MULT = 5;     // fala = 5x o ruído de fundo
  const SILENCE_MULT = 2.5;  // histerese: sai de fala mais cedo do que entra

  // LATÊNCIA (pedido do dono 2026-09-06: "precisa ser live"). Estes dois números
  // são atraso puro, sentido em toda frase:
  // HANG_MS era 600 — é tempo parado depois que você já calou. 350ms ainda
  // atravessa a pausa entre palavras sem picar a frase.
  // MAX_UTTERANCE_MS era 30000: quem fala corrido esperava meio minuto pela
  // primeira palavra em inglês. 12s corta antes de a espera virar constrangimento.
  const HANG_MS = 350;
  const MIN_SPEECH_MS = 400;      // menos que isto é estalo/tosse, não frase
  const MAX_UTTERANCE_MS = 12000;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function newChunker() {
    return { speaking: false, startedAt: 0, quietSince: 0, floor: 0.002, peak: 0 };
  }

  // O piso desce depressa e sobe devagar: entrar num ambiente silencioso tem de
  // ser notado logo, mas uma frase longa não pode "virar" ruído de fundo e
  // desligar a própria detecção. Durante a fala ele não aprende nada.
  // `quiet` é "esta amostra NÃO é fala". Passar apenas o estado anterior era um
  // defeito medido (2026-09-06): na PRIMEIRA amostra alta ainda não estamos
  // "falando", então a própria fala entrava na conta do ruído de fundo — o piso
  // subiu 3,5x (0,00081 -> 0,0028), o limiar de silêncio subiu junto, e a voz
  // seguinte passou a ser lida como silêncio. Numa conversa a detecção
  // degradaria a cada frase.
  function nextFloor(floor, rms, quiet) {
    if (!quiet) return floor;
    const a = rms < floor ? 0.2 : 0.01;
    return clamp(floor * (1 - a) + rms * a, FLOOR_MIN, FLOOR_MAX);
  }
  function speechAt(floor) { return floor * SPEECH_MULT; }
  function silenceAt(floor) { return floor * SILENCE_MULT; }

  // Reducer puro: devolve o novo estado e se a elocução FECHOU agora.
  function feed(st, rms, nowMs) {
    const prev = st.floor === undefined ? 0.002 : st.floor;
    // Só amostras que não são fala — nem durante uma elocução, nem a que a
    // inicia — podem ensinar o piso.
    const quiet = !st.speaking && rms < speechAt(prev);
    const s = {
      speaking: st.speaking,
      startedAt: st.startedAt,
      quietSince: st.quietSince,
      floor: nextFloor(prev, rms, quiet),
      peak: Math.max(st.peak || 0, rms),
    };
    const keep = (r) => { const n = newChunker(); n.floor = s.floor; return { state: n, cut: r === "silence", reason: r }; };
    if (!s.speaking) {
      if (rms >= speechAt(s.floor)) { s.speaking = true; s.startedAt = nowMs; s.quietSince = 0; }
      return { state: s, cut: false, reason: "" };
    }
    if (nowMs - s.startedAt >= MAX_UTTERANCE_MS) {
      const n = newChunker(); n.floor = s.floor;
      return { state: n, cut: true, reason: "max" };
    }
    if (rms > silenceAt(s.floor)) { s.quietSince = 0; return { state: s, cut: false, reason: "" }; }
    if (!s.quietSince) s.quietSince = nowMs;
    if (nowMs - s.quietSince < HANG_MS) return { state: s, cut: false, reason: "" };
    const spoke = s.quietSince - s.startedAt;
    if (spoke < MIN_SPEECH_MS) return keep("short");
    return keep("silence");
  }

  // A fila. A voz sintética dura ~87% do tempo da fala original (medido), então
  // duas frases seguidas SE ATROPELAM. A regra é: nunca cortar uma frase no
  // meio — a seguinte espera a anterior terminar de falar.
  function newQueue() {
    return { items: [], speaking: false };
  }
  function enqueue(q, text) {
    const t = String(text || "").trim();
    if (!t) return q; // silêncio traduzido a nada não vira fala nem espera
    return { items: q.items.concat([t]), speaking: q.speaking };
  }
  // O próximo a falar, ou null enquanto o anterior ainda fala.
  function dequeue(q) {
    if (q.speaking || !q.items.length) return { queue: q, text: null };
    return {
      queue: { items: q.items.slice(1), speaking: true },
      text: q.items[0],
    };
  }
  function finishSpeaking(q) {
    return { items: q.items, speaking: false };
  }
  // Quantas frases estão esperando atrás da que fala agora. A UI mostra isto:
  // é o sinal de que o usuário está falando mais rápido do que a voz entrega, e
  // sem ele o atraso acumula sem ninguém entender por quê.
  function backlog(q) {
    return q.items.length;
  }

  // O intérprete fala APENAS a voz do microfone, nunca o áudio do sistema
  // (pedido do dono, 2026-09-06). Traduzir o áudio do sistema significaria
  // repetir em inglês o que a OUTRA pessoa acabou de dizer — confusão garantida
  // — e, se a entrada for o próprio driver virtual em que o modo fala, um LAÇO:
  // ele ouviria a própria voz e a traduziria de novo, para sempre.
  //
  // Pedir o microfone não basta como garantia: o dispositivo de entrada PADRÃO
  // do sistema pode ser o loopback. Por isso o rótulo da trilha que veio é
  // conferido, e não a intenção com que ela foi pedida.
  // Conservador de propósito: recusa dispositivo virtual de QUALQUER plataforma,
  // não só o da atual. Um VB-Cable instalado num Mac existe, e checar só o
  // padrão do macOS o deixaria passar — foi o que o teste pegou (2026-09-06).
  // O custo de um falso positivo é a pessoa escolher outro microfone; o custo de
  // um falso negativo é a voz da outra pessoa voltando traduzida, em laço.
  const SYSTEM_INPUT = new RegExp(
    [
      "blackhole",
      "vb-?cable",
      "cable output",
      "vb-audio",
      "stereo mix",
      "mixagem est",
      "what u hear",
      "loopback",
      "aggregate",
      "agregado",
      "multi-output",
      "soundflower",
    ].join("|"),
    "i"
  );

  function isSystemAudioInput(label) {
    if (!label) return false;
    return SYSTEM_INPUT.test(label);
  }

  // O modelo que o intérprete usa, INDEPENDENTE do que a transcrição usa.
  // Antes o modo recusava ligar quando a transcrição estava no turbo e mandava
  // o usuário trocar de modelo em outro lugar — um beco sem saída. O modelo de
  // tradução é uma necessidade interna deste modo, não uma escolha que valha a
  // pena empurrar para a tela.
  const MODEL = "small";

  // Onde a voz deve sair por padrão: o driver virtual, que é o ponto do modo.
  const PREFER_DEVICE = /blackhole|vb-?cable|cable output|mixagem est|stereo mix/i;
  // Voz padrão: a de melhor qualidade entre as que vêm instaladas no macOS.
  const PREFER_VOICE = /^samantha/i;

  // Escolhe sozinho em vez de deixar o seletor vazio. A escolha guardada vence;
  // senão a preferida; senão a primeira. Sem isto os dois seletores nasciam em
  // branco e não havia como ligar o modo.
  function pickPreferred(names, stored, prefer) {
    const list = Array.isArray(names) ? names.filter(Boolean) : [];
    if (stored && list.indexOf(stored) >= 0) return stored;
    const m = list.find((n) => prefer.test(n));
    return m || list[0] || "";
  }

  return {
    canTranslate,
    isSystemAudioInput,
    MODEL,
    PREFER_DEVICE,
    PREFER_VOICE,
    pickPreferred,
    newChunker,
    feed,
    newQueue,
    enqueue,
    dequeue,
    finishSpeaking,
    backlog,
    speechAt,
    silenceAt,
    nextFloor,
    SPEECH_MULT,
    SILENCE_MULT,
    FLOOR_MIN,
    HANG_MS,
    MIN_SPEECH_MS,
    MAX_UTTERANCE_MS,
  };
});
