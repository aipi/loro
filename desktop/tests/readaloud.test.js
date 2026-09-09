// Testes do modo de leitura em voz alta (ADR-0037): markdown -> prosa falável.
// node --test, sem dependências.
const test = require("node:test");
const assert = require("node:assert");
const R = require("../src/readaloud.js");

// A regra que mais muda a experiência de quem OUVE: uma URL falada é meio
// minuto de "agá-tê-tê-pê-dois-pontos-barra-barra".
test("um link é lido pelo TEXTO, nunca pela URL", () => {
  const s = R.toSpeechText("veja o [contrato de IPC](https://github.com/aipi/loro/blob/main/docs/ARCHITECTURE.md#41)");
  assert.strictEqual(s, "veja o contrato de IPC");
  assert.ok(!s.includes("http"), s);
  assert.ok(!s.includes("github"), s);
});

test("um link automático não vira texto nenhum", () => {
  const s = R.toSpeechText("a fonte é <https://exemplo.com/x> e nada mais");
  assert.ok(!s.includes("http"), s);
  assert.ok(s.includes("a fonte é"), s);
});

// Ler "cerquilha cerquilha" no lugar da hierarquia é o defeito mais óbvio de
// mandar markdown cru ao sintetizador.
test("um título perde a marcação e ganha ponto, para o say respirar", () => {
  assert.strictEqual(R.toSpeechText("## Como funciona"), "Como funciona.");
  assert.strictEqual(R.toSpeechText("# Título"), "Título.");
  // já pontuado não ganha ponto duplo
  assert.strictEqual(R.toSpeechText("### E agora?"), "E agora?");
});

test("ênfase desaparece, o texto fica", () => {
  assert.strictEqual(R.toSpeechText("isto é **muito** importante"), "isto é muito importante");
  assert.strictEqual(R.toSpeechText("isto é *sutil*"), "isto é sutil");
  assert.strictEqual(R.toSpeechText("isto é ***tudo***"), "isto é tudo");
  assert.strictEqual(R.toSpeechText("isto foi ~~cortado~~"), "isto foi cortado");
  assert.strictEqual(R.toSpeechText("isto é _assim_ também"), "isto é assim também");
});

test("código em linha mantém o conteúdo e perde a crase", () => {
  assert.strictEqual(R.toSpeechText("o erro é `err.model_not_found` aqui"), "o erro é err.model_not_found aqui");
});

// Ler um bloco de código em voz alta produz "abre-chaves let espaço" — ninguém
// acompanha. Mas PULAR em silêncio esconde que havia algo ali.
test("um bloco de código é anunciado e pulado, não lido nem escondido", () => {
  const s = R.toSpeechText("antes\n\n```rust\nfn main() { let x = 1; }\n```\n\ndepois");
  assert.deepStrictEqual(R.toSpeech("antes\n\n```rust\nfn main(){}\n```\n\ndepois"), [
    "antes",
    R.SAY_CODE,
    "depois",
  ]);
  assert.ok(!s.includes("fn main"), s);
  assert.ok(s.includes("antes") && s.includes("depois"), s);
});

test("bloco com til fecha igual ao de crase", () => {
  const p = R.toSpeech("a\n\n~~~\nx = 1\n~~~\n\nb");
  assert.deepStrictEqual(p, ["a", R.SAY_CODE, "b"]);
});

// Front matter é metadado. Ler "domain dois-pontos loro" antes do documento é
// ruído na primeira coisa que a pessoa ouve.
test("o front matter não é lido", () => {
  const s = R.toSpeechText("---\ndomain: loro\nupdated: 2026-09-08\n---\n\nO texto começa aqui.");
  assert.strictEqual(s, "O texto começa aqui.");
});

// Mas um "---" no meio do texto é régua, não front matter.
test("uma régua no meio do texto não engole o resto do arquivo", () => {
  const s = R.toSpeechText("Primeiro.\n\n---\n\nSegundo.");
  assert.ok(s.includes("Primeiro"), s);
  assert.ok(s.includes("Segundo"), s);
});

// Uma tabela num documento de conhecimento costuma SER o conteúdo. Pular
// esconderia dados; ler os pipes seria ruído.
test("uma tabela é lida como valores, sem os pipes nem o separador", () => {
  const md = "| motor | tempo |\n|---|---|\n| say | 0,6s |\n| neural | 1,4s |";
  const p = R.toSpeech(md);
  assert.deepStrictEqual(p, ["motor, tempo", "say, 0,6s", "neural, 1,4s"]);
  assert.ok(!R.toSpeechText(md).includes("|"), "sobrou pipe");
  assert.ok(!R.toSpeechText(md).includes("---"), "sobrou separador");
});

test("itens de lista viram parágrafos próprios, para navegar item a item", () => {
  const p = R.toSpeech("- primeiro\n- segundo\n\n1. um\n2) dois");
  assert.deepStrictEqual(p, ["primeiro.", "segundo.", "um.", "dois."]);
});

test("uma citação é um parágrafo, sem o sinal de maior", () => {
  const s = R.toSpeechText("> a premissa é\n> que o dado é local");
  assert.strictEqual(s, "a premissa é que o dado é local");
});

test("comentário de HTML não é lido, nem quando ocupa várias linhas", () => {
  const s = R.toSpeechText("antes\n\n<!-- nota\nque continua -->\n\ndepois");
  assert.ok(!s.includes("nota"), s);
  assert.ok(s.includes("antes") && s.includes("depois"), s);
});

test("uma imagem é anunciada pelo texto alternativo, sem a URL", () => {
  const s = R.toSpeechText("![o gráfico de latência](docs/media/x.png)");
  assert.ok(s.startsWith(R.SAY_IMAGE), s);
  assert.ok(s.includes("o gráfico de latência"), s);
  assert.ok(!s.includes(".png"), s);
});

test("uma imagem sem texto alternativo não vira anúncio vazio", () => {
  assert.deepStrictEqual(R.toSpeech("![](x.png)"), []);
});

// Parágrafos se juntam; linhas em branco separam. É o que faz o sintetizador
// respirar entre trechos em vez de ler tudo numa tirada.
test("linhas de um parágrafo se juntam, e parágrafos ficam separados", () => {
  const p = R.toSpeech("uma frase\nque continua\n\noutra ideia");
  assert.deepStrictEqual(p, ["uma frase que continua", "outra ideia"]);
  assert.ok(R.toSpeechText("a\n\nb").includes("\n\n"));
});

test("um arquivo vazio ou nulo não estoura nem produz fala", () => {
  for (const v of ["", null, undefined, "   \n\n  "]) {
    assert.deepStrictEqual(R.toSpeech(v), [], JSON.stringify(v));
    assert.strictEqual(R.toSpeechText(v), "");
  }
});

test("um documento real do repo vira prosa sem marcação nenhuma", () => {
  const md = [
    "---",
    "domain: loro",
    "---",
    "",
    "# ADR-0037 — leitura em voz alta",
    "",
    "- **Status:** aceito, ver [ADR-0035](0035-x.md)",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "```sh",
    "make test",
    "```",
    "",
    "O fim.",
  ].join("\n");
  const s = R.toSpeechText(md);
  for (const ruido of ["#", "**", "|", "---", "](", "```", "make test", "domain:"]) {
    assert.ok(!s.includes(ruido), `sobrou ${JSON.stringify(ruido)} em: ${s}`);
  }
  assert.ok(s.includes("ADR-0037"), s);
  assert.ok(s.includes("aceito, ver ADR-0035"), s);
  assert.ok(s.includes(R.SAY_CODE), s);
});

// --- o que ler ---------------------------------------------------------------

// Reler um parágrafo é o caso comum de quem usa leitura em voz alta.
test("a seleção tem prioridade sobre o arquivo inteiro", () => {
  const r = R.pickSource("só este trecho", "o arquivo todo");
  assert.strictEqual(r.text, "só este trecho");
  assert.strictEqual(r.scope, "selection");
});

test("sem seleção, lê o arquivo inteiro", () => {
  for (const vazio of ["", "   ", null, undefined]) {
    const r = R.pickSource(vazio, "o arquivo todo");
    assert.strictEqual(r.text, "o arquivo todo", JSON.stringify(vazio));
    assert.strictEqual(r.scope, "file");
  }
});

// --- o rótulo do controle ----------------------------------------------------

// O rótulo nomeia a ação de AGORA, e sai do estado do backend — nunca de um
// estado paralelo, que é como uma tela passa a mentir (a mesma regra do R4).
test("o controle nomeia a ação de agora, a partir do estado real", () => {
  assert.strictEqual(R.label(null), "ler em voz alta");
  assert.strictEqual(R.label({ speaking: false, paused: false }), "ler em voz alta");
  assert.strictEqual(R.label({ speaking: true, paused: false }), "pausar a leitura");
  assert.strictEqual(R.label({ speaking: true, paused: true }), "retomar a leitura");
});
