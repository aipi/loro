// B13 — quando o CLI do agente do usuário não está autenticado, o chat imprimia
// a saída CRUA do processo como se fosse a resposta: "Not logged in · Please run
// /login", em inglês, numa UI em pt-BR, sem dizer o que falhou e sem caminho de
// volta. DESIGN.md §5: uma recusa vai para um aviso, não para dentro do
// conteúdo; §1: a interface não pode saber algo que não diz.
//
// BR-9: o Loro NUNCA guarda credencial — quem se autentica é o agente do
// usuário. Por isso a saída é um estado de erro que NOMEIA a recuperação (rodar
// /login na aba Terminal), e nada de credencial passa pelo app.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const APP = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
const { EN } = require("../src/i18n.js");

// A decisão é uma função pura: extraída do fonte e exercitada de verdade.
function loadAgentAuthFailure() {
  const m = APP.match(/function agentAuthFailure\(text\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, "app.js deve definir agentAuthFailure()");
  return new Function(`${m[0]}; return agentAuthFailure;`)();
}

test("B13 — a falha de credencial do agente é reconhecida", () => {
  const agentAuthFailure = loadAgentAuthFailure();
  for (const s of [
    "Not logged in · Please run /login",
    "not logged in",
    "Invalid API key · Please run /login",
    "Error: unauthorized",
    "authentication_error",
  ]) assert.equal(agentAuthFailure(s), true, `deveria reconhecer: ${s}`);
});

test("B13 — uma resposta de verdade não é confundida com falha de credencial", () => {
  const agentAuthFailure = loadAgentAuthFailure();
  for (const s of [
    "",
    "Aqui está o resumo da reunião: o time decidiu adiar o lançamento.",
    // uma resposta que FALA de login não é uma resposta que falhou por login
    "Para entrar no painel, o time usa login único; a documentação está em contexts/plataforma. "
      + "Isso não é uma falha de autenticação: é o texto do conhecimento, e ele é longo o bastante "
      + "para ser claramente uma resposta e não a saída de um processo que morreu na primeira linha. "
      + "O parágrafo segue explicando o fluxo de autenticação do produto com todos os detalhes que o "
      + "usuário pediu, porque é exatamente isso que ele perguntou ao projeto e o agente respondeu.",
  ]) assert.equal(agentAuthFailure(s), false, `não deveria reconhecer: ${s.slice(0, 40)}`);
});

test("B13 — o turno que falhou por credencial não vira resposta", () => {
  const m = APP.match(/listen\("chat-done",[\s\S]*?\n\}\);/);
  assert.ok(m, "o listener de chat-done continua existindo");
  assert.match(m[0], /agentAuthFailure\(/, "a falha é detectada no fim do turno");
  assert.match(m[0], /chatAuthBlock\(\)/, "e vira um estado de erro próprio");
  // e o texto cru sai da conversa
  assert.ok(m[0].indexOf("agentAuthFailure(") < m[0].indexOf("chatBuf +="),
    "a detecção vem antes de anexar o texto do processo à resposta");
});

test("B13 — o bloco de erro fala na voz do app e nomeia a recuperação", () => {
  const m = APP.match(/function chatAuthBlock\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, "app.js deve definir chatAuthBlock()");
  const src = m[0];
  assert.match(src, /t\("o agente de IA não está conectado à sua conta"\)/);
  assert.match(src, /\/login/, "o comando de recuperação é nomeado");
  assert.match(src, /Terminal/, "e onde rodá-lo");
  assert.match(src, /data-term/, "com um caminho de um clique para a aba Terminal");
  // BR-9: nada de credencial passa pelo app
  assert.ok(!/(token|apiKey|api_key|password|senha)/i.test(src),
    "BR-9: o app não toca em credencial — quem se autentica é o agente do usuário");
});

test("B13 — as mensagens novas têm par em inglês", () => {
  for (const pt of [
    "o agente de IA não está conectado à sua conta",
    "nada foi enviado. abra a aba Terminal e rode /login no seu agente — o Loro nunca guarda a sua credencial.",
    "Abrir o Terminal",
  ]) assert.ok(EN[pt] && EN[pt] !== pt, `sem par em inglês: ${pt}`);
});
