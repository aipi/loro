// Testes do modo intérprete (ADR-0035): recorte por silêncio e fila de fala.
// node --test, sem dependências.
const test = require("node:test");
const assert = require("node:assert");
const I = require("../src/interpreter.js");

// Roda uma sequência de amostras pelo reducer, devolvendo os cortes.
function run(samples) {
  let st = I.newChunker();
  const cuts = [];
  for (const [rms, t] of samples) {
    const r = I.feed(st, rms, t);
    st = r.state;
    if (r.cut) cuts.push({ t, reason: r.reason });
  }
  return cuts;
}

const LOUD = 0.2;
const QUIET = 0.001;

test("ADR-0035 · o corte é no SILÊNCIO, não no relógio", () => {
  // fala de 0 a 2000ms, depois silêncio; fecha HANG_MS após o último som
  const s = [];
  for (let t = 0; t <= 2000; t += 100) s.push([LOUD, t]);
  for (let t = 2100; t <= 3200; t += 100) s.push([QUIET, t]);
  const cuts = run(s);
  assert.strictEqual(cuts.length, 1);
  assert.strictEqual(cuts[0].reason, "silence");
  // O corte cai na PRIMEIRA amostra em/após o fim do silêncio de espera. Não se
  // afirma um instante exato: as amostras são de 100ms e HANG_MS não precisa
  // ser múltiplo delas — prender o teste a isso o quebraria a cada ajuste de
  // latência sem nada ter regredido.
  const due = 2100 + I.HANG_MS;
  assert.ok(cuts[0].t >= due, "cortou antes da hora: " + cuts[0].t);
  assert.ok(cuts[0].t < due + 100, "cortou tarde demais: " + cuts[0].t);
});

test("uma pausa curta no meio da frase NÃO parte a elocução em duas", () => {
  // 300ms de silêncio (menos que HANG_MS) entre dois trechos de fala
  const s = [];
  for (let t = 0; t <= 1000; t += 100) s.push([LOUD, t]);
  for (let t = 1100; t <= 1300; t += 100) s.push([QUIET, t]);
  for (let t = 1400; t <= 2400; t += 100) s.push([LOUD, t]);
  for (let t = 2500; t <= 3600; t += 100) s.push([QUIET, t]);
  const cuts = run(s);
  assert.strictEqual(cuts.length, 1, "a respiração virou duas frases");
});

test("histerese: oscilar entre os limiares não pica a fala", () => {
  // rms ENTRE o limiar de silêncio e o de fala conta como continuação. A fala
  // precisa passar de MIN_SPEECH_MS ANTES da oscilação, senão o descarte de
  // fala curta mascara o resultado e o teste vira verde sem testar nada — foi o
  // que aconteceu na primeira versão deste arquivo (2026-09-06).
  // O piso ADAPTA, então o "meio" tem de vir do piso REAL no instante da
  // oscilação — não da constante inicial. Calcular do valor errado foi o que
  // fez esta versão do teste falhar por motivo falso.
  let st = I.newChunker();
  let t = 0;
  for (; t <= 2000; t += 100) st = I.feed(st, 0.0008, t).state;   // aprende o piso
  const mid = (I.silenceAt(st.floor) + I.speechAt(st.floor)) / 2;
  const cuts = [];
  for (const end = t + I.MIN_SPEECH_MS + 400; t <= end; t += 100) {
    const r = I.feed(st, LOUD, t); st = r.state; if (r.cut) cuts.push(t);
  }
  for (const end = t + 3000; t <= end; t += 100) {
    const r = I.feed(st, mid, t); st = r.state; if (r.cut) cuts.push(t);
  }
  assert.strictEqual(cuts.length, 0, "a oscilação entre os limiares partiu a fala");
});

// --- limiar adaptativo -------------------------------------------------------

// O DEFEITO medido em 2026-09-06: com 0.02 fixo, o modo ligou, amostrou por
// minutos e NUNCA detectou fala — o microfone cru do Loro (sem ganho
// automático) não chega perto de um limiar chutado de fora.
test("uma voz baixa num ambiente silencioso É detectada", () => {
  const QUIETROOM = 0.0008;   // ruído de sala, bem abaixo do 0.02 antigo
  const SOFTVOICE = 0.012;    // voz baixa: também abaixo do 0.02 antigo
  const s = [];
  for (let t = 0; t <= 3000; t += 100) s.push([QUIETROOM, t]); // aprende o piso
  for (let t = 3100; t <= 4500; t += 100) s.push([SOFTVOICE, t]);
  for (let t = 4600; t <= 5600; t += 100) s.push([QUIETROOM, t]);
  const cuts = run(s);
  assert.strictEqual(cuts.length, 1, "a voz baixa não foi ouvida");
  assert.strictEqual(cuts[0].reason, "silence");
});

test("num ambiente ruidoso o mesmo nível de ruído NÃO vira fala", () => {
  const NOISY = 0.02; // exatamente o limiar fixo antigo — aqui é só o fundo
  const s = [];
  for (let t = 0; t <= 8000; t += 100) s.push([NOISY, t]);
  assert.strictEqual(run(s).length, 0, "o ruído de fundo foi confundido com fala");
});

// DEFEITO medido 2026-09-06: a PRIMEIRA amostra alta entrava no cálculo do
// ruído de fundo (o estado ainda dizia "não falando"), inflando o piso 3,5x —
// 0,00081 para 0,0028. O limiar de silêncio subia junto e a frase seguinte era
// lida como silêncio: numa conversa, a detecção degradava a cada frase.
test("a amostra que INICIA a fala não polui o ruído de fundo", () => {
  let st = I.newChunker();
  for (let t = 0; t <= 2000; t += 100) st = I.feed(st, 0.0008, t).state;
  const floorBefore = st.floor;
  const after = I.feed(st, 0.2, 2100).state;   // a amostra que abre a elocução
  assert.strictEqual(after.speaking, true, "não abriu a elocução");
  assert.strictEqual(after.floor, floorBefore, "a fala entrou no piso de ruído");
});

test("o piso não aprende com a própria fala (senão a detecção se desliga)", () => {
  const before = { speaking: true, startedAt: 0, quietSince: 0, floor: 0.002, peak: 0 };
  const after = I.feed(before, 0.5, 100).state;
  assert.strictEqual(after.floor, 0.002);
});

test("silêncio digital não vira fala por causa do piso mínimo", () => {
  const s = [];
  for (let t = 0; t <= 20000; t += 100) s.push([0, t]);
  assert.strictEqual(run(s).length, 0);
});

test("estalo curto é descartado sem virar elocução", () => {
  const s = [[LOUD, 0], [LOUD, 100]]; // 100ms < MIN_SPEECH_MS
  for (let t = 200; t <= 1400; t += 100) s.push([QUIET, t]);
  assert.strictEqual(run(s).length, 0);
});

test("quem nunca pausa ainda sai: o teto de duração corta", () => {
  const s = [];
  for (let t = 0; t <= I.MAX_UTTERANCE_MS + 500; t += 100) s.push([LOUD, t]);
  const cuts = run(s);
  assert.strictEqual(cuts.length, 1);
  assert.strictEqual(cuts[0].reason, "max");
});

test("silêncio puro nunca abre uma elocução", () => {
  const s = [];
  for (let t = 0; t <= 10000; t += 100) s.push([QUIET, t]);
  assert.strictEqual(run(s).length, 0);
});

// --- a fila -----------------------------------------------------------------

test("a fila nunca corta uma frase: a seguinte espera a anterior falar", () => {
  let q = I.newQueue();
  q = I.enqueue(q, "first sentence");
  q = I.enqueue(q, "second sentence");
  const a = I.dequeue(q);
  assert.strictEqual(a.text, "first sentence");
  // enquanto fala, a próxima NÃO sai
  const b = I.dequeue(a.queue);
  assert.strictEqual(b.text, null);
  // terminou de falar: agora sim
  const c = I.dequeue(I.finishSpeaking(a.queue));
  assert.strictEqual(c.text, "second sentence");
});

test("tradução vazia não vira fala nem ocupa a fila", () => {
  let q = I.newQueue();
  q = I.enqueue(q, "   ");
  q = I.enqueue(q, "");
  assert.strictEqual(I.backlog(q), 0);
  assert.strictEqual(I.dequeue(q).text, null);
});

test("o backlog é visível: é o sinal de que o atraso está acumulando", () => {
  let q = I.newQueue();
  q = I.enqueue(q, "um");
  q = I.enqueue(q, "dois");
  q = I.enqueue(q, "tres");
  assert.strictEqual(I.backlog(q), 3);
  const r = I.dequeue(q);
  assert.strictEqual(I.backlog(r.queue), 2);
});

// --- a guarda do modelo -----------------------------------------------------

// ADR-0035 §2, medido 2026-09-06: o turbo IGNORA -tr em silêncio e devolve
// português. Sem esta guarda a UI deixa ligar e o usuário descobre na reunião.
test("o modelo padrão (turbo) não traduz e a UI tem de saber disso", () => {
  assert.strictEqual(I.canTranslate("large-v3-turbo"), false);
  assert.strictEqual(I.canTranslate("small"), true);
  assert.strictEqual(I.canTranslate("medium"), true);
  assert.strictEqual(I.canTranslate(""), false);
  assert.strictEqual(I.canTranslate(undefined), false);
});

// --- escolha automática ------------------------------------------------------

// Os dois seletores nasciam VAZIOS e não havia como ligar o modo (relatado
// 2026-09-06 no primeiro teste na UI). Escolher sozinho é o conserto: um
// seletor vazio não é uma pergunta, é um bloqueio.
test("o driver virtual é o padrão quando está instalado", () => {
  const devs = ["Alto-falantes (MacBook Pro)", "BlackHole 2ch"];
  assert.strictEqual(
    I.pickPreferred(devs, "", I.PREFER_DEVICE),
    "BlackHole 2ch"
  );
});

test("sem driver virtual, cai no primeiro dispositivo em vez de ficar vazio", () => {
  const devs = ["Alto-falantes (MacBook Pro)"];
  assert.strictEqual(
    I.pickPreferred(devs, "", I.PREFER_DEVICE),
    "Alto-falantes (MacBook Pro)"
  );
});

test("a escolha guardada do usuário vence a preferida", () => {
  const devs = ["Alto-falantes (MacBook Pro)", "BlackHole 2ch"];
  assert.strictEqual(
    I.pickPreferred(devs, "Alto-falantes (MacBook Pro)", I.PREFER_DEVICE),
    "Alto-falantes (MacBook Pro)"
  );
});

// Um dispositivo guardado que sumiu não pode congelar o seletor num nome morto.
test("dispositivo guardado que sumiu não é mantido", () => {
  const devs = ["Alto-falantes (MacBook Pro)"];
  assert.strictEqual(
    I.pickPreferred(devs, "BlackHole 2ch", I.PREFER_DEVICE),
    "Alto-falantes (MacBook Pro)"
  );
});

test("a voz padrão é a de melhor qualidade entre as instaladas", () => {
  const voices = ["Albert", "Bahh", "Samantha", "Daniel"];
  assert.strictEqual(I.pickPreferred(voices, "", I.PREFER_VOICE), "Samantha");
});

test("lista vazia devolve vazio sem estourar", () => {
  assert.strictEqual(I.pickPreferred([], "", I.PREFER_DEVICE), "");
  assert.strictEqual(I.pickPreferred(undefined, "", I.PREFER_DEVICE), "");
});

// O intérprete usa o modelo QUE ELE PRECISA, não o da transcrição. Antes ele
// recusava ligar no turbo e mandava o usuário trocar de modelo noutra tela —
// um beco sem saída relatado no primeiro teste na UI (2026-09-06).
test("o modelo do intérprete traduz, independente do que a transcrição usa", () => {
  assert.strictEqual(I.canTranslate(I.MODEL), true);
});

// --- só a voz do microfone, nunca o áudio do sistema -------------------------

// Pedido do dono (2026-09-06): traduzir o áudio do sistema repetiria em inglês
// o que a OUTRA pessoa disse, e — se a entrada for o mesmo driver virtual em
// que o modo fala — vira laço infinito.
const LOOPBACKS = [
  "BlackHole 2ch",
  "blackhole 16ch",
  "VB-Cable",
  "CABLE Output (VB-Audio Virtual Cable)",
  "Mixagem estéreo",
  "Stereo Mix",
  "Dispositivo Agregado",
  "Loopback Audio",
];
for (const name of LOOPBACKS) {
  test("recusa entrada de áudio do sistema: " + name, () => {
    assert.strictEqual(I.isSystemAudioInput(name), true);
  });
}

test("um microfone de verdade NÃO é confundido com áudio do sistema", () => {
  for (const name of [
    "Microfone (MacBook Pro)",
    "MacBook Pro Microphone",
    "Shure MV7",
    "AirPods Pro",
    "Yeti Nano",
  ]) {
    assert.strictEqual(I.isSystemAudioInput(name), false, name);
  }
});

test("sem rótulo não se acusa nada (a permissão pode ainda não ter vindo)", () => {
  assert.strictEqual(I.isSystemAudioInput(""), false);
  assert.strictEqual(I.isSystemAudioInput(undefined), false);
});
