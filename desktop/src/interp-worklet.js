// Medidor de nível do modo intérprete, na THREAD DE ÁUDIO (ADR-0035).
//
// POR QUE ISTO EXISTE: a primeira versão media o nível num `setInterval` de
// 100ms. MEDIDO 2026-09-07, com a janela do Loro em segundo plano (o caso
// normal — quem usa o modo está olhando o Meet): o WebKit estrangulou o
// temporizador para 1000ms (`interp tick gap ms=1001`, dezenas de vezes
// seguidas no log). A 1s por amostra o recorte desmonta — HANG_MS é 350ms,
// então UMA amostra de silêncio corta na hora, e uma elocução de uma amostra
// parece ter 0ms e é descartada como curta. O modo ficava surdo justamente
// quando estava em uso.
//
// Um AudioWorklet roda no thread de renderização de áudio, movido pelo relógio
// do hardware e NÃO por temporizador — não há o que estrangular. Ele também vê
// TODO o áudio: o analisador antigo só guardava a última janela, então a 1s por
// tique 870ms de fala simplesmente não eram olhados.
//
// O que ele manda para a tela é `{rms, t}`, e `t` vem do relógio de ÁUDIO
// (`currentTime`), não do relógio de parede. É isso que mantém a decisão certa
// mesmo se as mensagens chegarem em rajada numa tela ocupada: os instantes são
// reais, e só a reação é que atrasa.

// Quantos blocos de 128 quadros agrupar antes de mandar uma medida. A 48 kHz um
// bloco tem ~2,7ms; 16 blocos dão ~43ms — resolução de sobra para um limiar de
// 350ms de silêncio, e pouca mensagem para a tela.
const BLOCKS_PER_FRAME = 16;

class InterpMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sum = 0;
    this.n = 0;
    this.blocks = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    // Sem entrada ainda: mantém o processador vivo (devolver false o encerra).
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) this.sum += ch[i] * ch[i];
    this.n += ch.length;
    if (++this.blocks < BLOCKS_PER_FRAME) return true;
    // RMS do quadro agrupado, e o instante no relógio do áudio.
    this.port.postMessage({ rms: Math.sqrt(this.sum / this.n), t: currentTime });
    this.sum = 0;
    this.n = 0;
    this.blocks = 0;
    return true;
  }
}

registerProcessor("interp-meter", InterpMeter);
