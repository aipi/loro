# Manual do Loro

_O Loro captura sua fala e seus textos localmente e transforma tudo em uma base
de conhecimento por contexto — privada, versionável e revisável. Nada de áudio
ou texto sai da sua máquina sem uma ação explícita sua._

## O fluxo em uma frase

**Brainstorming → Fila → Contexto**: você acumula material bruto (reuniões,
notas, anexos) num brainstorming; seleciona **os arquivos** que importam e cada
um entra na fila como ele mesmo (um item por arquivo — não há mais relatório
consolidado); o botão "gerar contexto" pede ao Claude do terminal que destile a
fila em `contextos/` — a fonte oficial da verdade, versionada em git.

## A tela, em uma olhada

Toda tela tem a mesma anatomia:

```
CABEÇALHO 54px — [projeto ⌄] [Início · Organizar · Conhecimento] ··· [Gravar] [✦ IA]
BARRA LATERAL │ ABAS (só quando há documento aberto) │ PAINEL 330px
250px ou 60px │ CONTEÚDO                             │ Documento · Chat · Terminal
```

- **Os três destinos** ficam no cabeçalho: **Início** (o que você quer guardar
  hoje), **Organizar** (o que foi capturado e ainda não virou conhecimento — o
  número âmbar é a contagem) e **Conhecimento** (os temas oficiais do time).
- **Gravar** é o botão vermelho do cabeçalho; enquanto grava, ele vira **Parar**
  e a gravação continua se você trocar de aba — um selo `gravando · mm:ss`
  aparece no cabeçalho e leva de volta.
- **Se você ouve por alto-falante**, o microfone escuta de volta o que os
  outros falam, e a mesma frase entra nas duas trilhas. O Loro descarta a
  cópia sozinho; se ainda assim ele confundir quem falou, ligue **cancelar o
  eco do alto-falante** em Configurações → Captura — com o custo, declarado
  ali, de a sua voz sair mais baixa. Com fone, deixe desligado.
- **O rodapé de gravação** é o mesmo para a gravação avulsa e para a reunião:
  relógio, onda do áudio e o selo de privacidade no pé do conteúdo. Numa reunião
  ele ganha **⏸ pausar / ▶ retomar** e **■ Encerrar reunião**, à esquerda do
  relógio. Pausar **para a captura de verdade** — nada é gravado até você
  retomar, o relógio congela e o papagaio da barra de menu para de piscar.
- **✦ IA** mostra ou recolhe o painel da direita.
- **Abas são só documentos abertos** — não existe aba "Início". Um clique na
  árvore abre uma aba de pré-visualização (em itálico); dois cliques fixam.
- O **alternador da barra lateral** (250px ⇄ 60px) fica embaixo, ao lado de
  **⚙ Configurações**.
- `Cmd/Ctrl+K` abre a **paleta**: arquivos e comandos na mesma lista, agrupados
  em *ir para · gravar · criar · documento · fazer*, com o atalho de cada um à
  direita. Ela é a lista viva de tudo o que dá para fazer.

### O chat (painel ✦ IA)

A aba **Chat** conversa com o **agente do seu projeto** — o mesmo CLI que roda no
terminal embutido (Configurações → IA e terminal). Nada sai para uma API do
Loro: o processo é local e a conta é sua.

- Escreva a pergunta e envie (Enter; Shift+Enter quebra linha). A resposta vai
  aparecendo aos poucos, no próprio chat.
- Os **chips** acima do campo são as habilidades de IA mais usadas. Clicar arma a ação;
  enviar sem texto roda com a instrução padrão, e o `×` desarma.
- A conversa **continua** de uma pergunta para a outra. **reiniciar** começa do
  zero.
- `sonnet · alto ⌄` é um controle só: escolha o **modelo** e o **esforço** (quanto
  o agente pensa antes de responder).
- O ↑ vira **■** enquanto responde — clique para parar o turno.
- Se o agente precisar de **permissão** para mexer na pasta, aparece um bloco
  âmbar: **Permitir esta pasta** (vale só para esta conversa) ou **Continuar no
  terminal**, onde ele pode pedir permissão passo a passo.

- **Onde as habilidades rodam** é escolha sua: **Configurações → IA e terminal**.
  *No chat*, a resposta fica na conversa; *no terminal*, você acompanha o passo a
  passo e pode intervir. Vale para tudo — analisar uma reunião, perguntar ao
  projeto, rodar uma ação pelo menu ⋯.
- As três seções da barra lateral (**ideias**, **para organizar**,
  **conhecimento**) **recolhem**: clique no título. Com muitos temas isso é o que
  mantém a árvore navegável.

- **O que o chat pode fazer** também é escolha sua (**Configurações → IA e
  terminal**). O chat não consegue parar e perguntar no meio de uma ação, então
  ele já vem com permissão para agir: *ler e editar o projeto* cobre analisar uma
  reunião e escrever notas; *tudo, sem perguntar* libera também conectores
  externos (Slack, Drive…) e caminhos fora da pasta do projeto.
- Cada passo do agente (uma ferramenta que ele usou) **abre**: clique para ver o
  que foi pedido e o que voltou. Um passo que falhou já abre sozinho.

### Ajustar as larguras

As três colunas laterais são ajustáveis: **arraste** a divisória entre a barra de
ideias e o conteúdo, entre o conteúdo e o painel ✦ IA, ou o topo do terminal
quando ele está embaixo. **Dois cliques** na divisória volta ao tamanho padrão.
O tamanho escolhido fica guardado.

### Como as coisas se chamam

O Loro fala a sua língua na tela e guarda os nomes técnicos no disco:

| Na tela | No disco / nos ADRs |
|---|---|
| projeto | acervo |
| ideias | brainstorming |
| para organizar | fila (`inbox/`) |
| conhecimento | contextos |
| habilidades de IA | habilidades |
| salvar versão | versionar (commit) |
| enviar para revisão do time | propor mudança (RFC = PR) |
| juntar a um conhecimento | promover |

### Tema

Em **Configurações → Aparência** você escolhe **claro**, **escuro** ou
**sistema** (acompanha o macOS/Windows).

## Primeiros passos

Na primeira abertura, um **modal de boas-vindas** resume as principais
funcionalidades (fluxo, gravação, modelos, agente, IA e atalhos) — reabra
quando quiser pela paleta: `Cmd/Ctrl+K` → "apresentação do Loro".

1. **Criar o acervo** — na primeira abertura, o assistente pede um nome, a
   pasta onde gerar e os contextos iniciais (ex.: `produto`, `engenharia`).
   Marque "versionar com git" para habilitar o fluxo de revisão (recomendado).
2. **Modelo de uso** — a primeira opção é **Automático** (padrão): o loop
   cria e atribui contexto sozinho ao processar a fila, então você não
   precisa definir contextos agora (dá para desligar depois em
   Configurações). As demais opções são modelos prontos (Vendas,
   Engenharia, Produto & gestão, Aprendizado, Educação, Recrutamento,
   Saúde) ou o Genérico (em branco) — nesses, você define os contextos e o
   loop não cria novos sozinho. Cada modelo pré-preenche os contextos (você
   pode editar), adiciona regras da vertical ao `AGENTS.md`, semeia o guia
   da fila e define o molde do `context.md` de cada contexto (as seções
   variam por vertical — vendas fala de pipeline e compromissos, saúde de
   condutas e protocolos). A explicação de cada opção aparece logo abaixo ao
   selecioná-la. "Duplicar para personalizar" copia qualquer modelo para
   `~/.loro/templates/`, onde você edita os arquivos e ele passa a aparecer
   no assistente. Modelos com dados pessoais (Vendas, Recrutamento, Saúde)
   trazem regras de minimização — o de Saúde avisa: dados de saúde são
   sensíveis e o acervo não substitui o prontuário.
3. **Agente de IA** — o campo "agente de IA (comando)" define qual CLI o
   terminal embutido usa neste acervo: `claude` (padrão), `gemini`,
   `ollama run llama3`… O acervo é só arquivos + convenção (`AGENTS.md`),
   então qualquer agente — inclusive um modelo local — consegue trabalhar
   nele; para agentes que não entendem slash-commands, o Loro envia as
   instruções da skill como texto.
4. **Modelos de transcrição** — em Configurações (⚙) → *modelo*, cada modelo
   aparece como **instalado** ou com um botão **+ baixar**. O download roda no
   seu computador, mostra o progresso e é verificado por SHA-256 antes de valer.
   `large-v3-turbo` é mais preciso; `small` é mais rápido e leve. Se você tentar
   transcrever sem um modelo, o Loro abre as Configurações para você baixar.
   (Instalado pelo Homebrew, o whisper e o ffmpeg já vêm juntos.)
   Um download interrompido não vira modelo: o arquivo só entra em uso inteiro e
   verificado. Se um modelo antigo tiver ficado pela metade, ele volta a aparecer
   como *não instalado* — basta baixar de novo.
5. **Idioma** — na engrenagem (⚙), "idioma da interface" alterna pt-BR/inglês.
   Tudo que o app **gera** (análises, documentos de reunião, contextos)
   nasce no idioma ativo da interface.
6. **Versão** — o rodapé das Configurações (⚙) mostra a versão instalada
   (ex.: `v0.8.0`), para você conferir num relance se a atualização pegou.

## Gravar e transcrever

- **● (gravar)** abre o diálogo de gravação perguntando **onde salvar**: um
  brainstorming (vira uma reunião ligada ao tema) ou "transcrição avulsa"
  (o texto fica no painel ao vivo para salvar/descartar ao final). O atalho
  global é `Cmd/Ctrl+Alt+Espaço`.
- Cada comando da paleta (`Cmd/Ctrl+K`) tem um atalho `Cmd/Ctrl+Alt+
  <tecla>`, exibido ao lado do comando na própria paleta.
- **Fontes**: microfone, áudio do sistema (requer BlackHole — o app guia a
  instalação) ou **reunião** (mic + sistema juntos; a transcrição acontece ao
  final, com mais fidelidade).
- O áudio é **transitório**: usado para transcrever e descartado. O indicador
  de privacidade na barra mostra o estado ("sem gravar" / "grava áudio").

## Brainstorming (o mundo não versionado)

- **Escrever uma nota** (na tela Início) abre um markdown **em branco** na hora:
  você escreve primeiro e, ao salvar, escolhe o título e onde a nota vai morar —
  um brainstorming existente ou um contexto. Enquanto não salvar, nada é gravado
  em disco.
- O **＋** no cabeçalho da seção cria um brainstorming (espaço privado para
  um tema); o **＋** da seção contextos cria um contexto.
- Dentro dele (expanda o brainstorming na lateral): cada pasta tem sua
  própria ação de criação no topo — **notas** → **＋ nova nota**;
  **reuniões** → **● gravar reunião** (também na paleta `Cmd/Ctrl+K`
  → "nova reunião"); **anexos** → **⇄ sincronizar** (traz de Drive/Slack/
  Jira/Confluence) e **＋ do computador** (abre o seletor de arquivos e copia
  um `.pdf`/`.xlsx`/imagem que você já tem para os anexos do tema).
- **✦ nota por IA** (menu ⋯ do brainstorming) cria uma nota a partir de um
  pedido seu; **✦ pedir à IA** (menu ⋯ de uma nota/análise **e no rail à
  direita de qualquer arquivo aberto**) aplica um pedido sobre o conteúdo
  existente — a IA evolui, nunca apaga.
- **Menu ⋯ de uma reunião**: além de renomear e apagar, **⇄ mover para…** leva a
  reunião inteira — transcrição, análises e material gerado — para outro
  brainstorming — disponível depois que a reunião termina, como analisar e enviar
  para a fila. Também dá para arrastar a reunião pelo ícone até o cabeçalho
  **📁 reuniões** do brainstorming de destino. Uma reunião de mesmo nome no destino
  nunca é sobrescrita.
- **Menu ⋯ de qualquer arquivo** (nota, anexo, avulso, nota de reunião):
  além de **renomear** e **apagar**, traz **⇄ mover para…** (escolha a pasta
  de destino — avulso, ou as pastas notas/anexos de qualquer brainstorming) e
  **⧉ copiar caminho** — **relativo** (portátil, no formato usado pelas
  referências `acervo://`) ou **absoluto** (o caminho completo no disco, útil
  para abrir no Finder/terminal). Nunca sobrescreve um arquivo de mesmo nome no
  destino. O **copiar caminho** está no menu ⋯ de **todo item da árvore
  lateral** — arquivos, brainstormings, reuniões, itens da fila, contextos,
  pastas (anexos) e habilidades, além das fontes.
- **Arrastar e soltar:** arraste o **ícone** de um arquivo (o cursor vira uma
  mãozinha) e solte sobre o cabeçalho de uma pasta (📁 notas, 📁 anexos ou
  📁 avulso) para movê-lo — o mesmo efeito do **mover para…**, restrito ao
  mundo do brainstorming (nunca toca o que é versionado). O resto da linha
  continua sendo clique-para-abrir.
- **Rail de ações à direita do arquivo:** ao abrir qualquer nota/documento,
  a lateral direita mostra cartões de ação separados — **habilidade** (um
  dropdown com nomes amigáveis; a descrição da habilidade selecionada fica
  sempre visível logo abaixo, e **▶ executar** roda sobre o arquivo aberto),
  **pedir à IA…**, e **versionar** (quando o arquivo é de um contexto).
  Mesmo padrão em todo lugar onde essas ações existem — reunião, documento
  comum, cabeçalho do acervo. No **modo edição** o editor ocupa o painel
  inteiro e o rail fica oculto; as ações continuam disponíveis no modo
  visualizar.
- **Barra de formatação no modo edição:** acima do editor há botões para
  **negrito** (⌘B), *itálico* (⌘I), riscado, títulos (H1/H2/H3), lista,
  checklist, lista numerada, citação, código, link (⌘K), tabela, bloco de
  código e linha separadora. Eles escrevem a marcação markdown no ponto do
  cursor (ou envolvem o texto selecionado) e desfazem quando você clica de
  novo sobre um trecho já formatado — o arquivo continua sendo markdown
  legível, então o histórico no git mostra apenas o que você mudou de fato.
  A mesma barra aparece no editor de pendentes da fila e das instruções do
  loop, onde **⌘S** salva.
- As ações **analisar**, **perguntar…** e **enviar para a fila** ficam no menu
  **⋯** da reunião na lateral. **Perguntar** funciona já durante a gravação; as
  outras duas habilitam quando a reunião termina. **Enviar para a fila** manda as
  **análises** da reunião (o que estiver em `notas/`) — a transcrição bruta nunca
  vai. Uma reunião que ninguém analisou não tem o que enviar, e o menu diz isso
  em vez de falhar no clique.
- A aba `reuniao.md` da reunião mostra, em vez de botões fixos, um único
  **dropdown de habilidades** ("o que fazer com esta reunião") — escolha
  qualquer habilidade (incluindo analisar/perguntar) e rode sobre a reunião
  aberta. Sem restrição: aparecem todas, padrão e customizadas.
- Numa reunião: use **✎ Marcar momento** (`Cmd/Ctrl+Alt+M`, ou o botão acima da
  transcrição) para ancorar o instante em que algo importante foi dito — é um
  marcador só, sem tipo a escolher no meio da fala; depois rode **analisar** (menu ⋯)
  para o Claude escrever a análise em `notas/`. Quando a gravação termina, o app
  abre a transcrição e **oferece** analisar em um clique — é uma sugestão, não
  roda nada sozinho, e some se você ignorar.
- Nada do brainstorming é versionado nem sai da máquina.
- As **notas** de cada reunião (análises, respostas e qualquer documento que
  uma habilidade gere) ficam **recolhidas por padrão** na lateral (toque na
  seta ▸ ao lado da reunião para abrir) — evita que a lista cresça demais
  quando há muitas reuniões analisadas. Tudo o que uma habilidade produz sobre
  a reunião vai para a pasta **notas/** dela (não mais em pastas separadas como
  investigações/respostas).
- Cada brainstorming tem exatamente três pastas, visíveis na lateral como
  grupos com ícone de pasta (📁 **reuniões**, 📁 **notas**, 📁 **anexos** —
  cada uma clicável para expandir/recolher):
  **reunioes/** (toda reunião nasce ali), **notas/** e **anexos/** (uma
  apresentação é só mais um tipo de anexo — não tem pasta própria).
  `anexos/` é alimentada por uma habilidade (sincronizar, apresentação,
  artefato) ou arrastando um arquivo
  direto na pasta real no disco.
- Com muitos brainstormings, um campo de busca aparece no topo da seção
  (acima de 8) — filtra por nome; sem busca, mostra só os mais recentes +
  "ver todos".

## Habilidades

Habilidades são ações do agente de IA — algumas já vêm prontas (padrão),
outras você cria. Não ficam mais na Visão Geral: rode uma pelo menu **⋯**
de um brainstorming → **"executar habilidade…"**, pelo botão **"executar
habilidade…"** no topo do visualizador de **qualquer arquivo markdown**, ou
pelo dropdown de habilidades numa reunião aberta. Sempre um menu/controle
compacto — a descrição de cada uma só aparece ao passar o mouse, para não
poluir a tela quando houver muitas.

- **Sincronizar** traz um item externo (Google Drive/Gemini, Slack, Jira ou
  Confluence) para um **anexo local** do brainstorming, referenciado numa
  nota. Drive traz o documento inteiro; Slack, Jira e Confluence trazem um
  **resumo** escrito pelo agente (nunca o texto/descrição crus). Cada fonte
  pede um identificador diferente: Drive aceita uma busca opcional ou um
  link; Slack pede o nome do canal; Jira, a chave do ticket ou link;
  Confluence, o título da página ou link. O agente sempre lista o que
  encontrou e pede sua confirmação antes de trazer. Itens compartilhados por
  colegas não têm pasta/organização própria na sua conta — isso é esperado,
  ainda são aceitos.
  **Pré-requisito:** o agente do terminal precisa ter o conector daquele
  serviço (Drive, Slack, Jira, Confluence) já configurado/autenticado — o
  Loro não gerencia essas credenciais.
- **Apresentação** e **artefato** são habilidades padrão que geram material
  (um deck em markdown, um diagrama, um script, uma planilha) a partir de um
  brainstorming ou de um contexto — sempre em `anexos/` (não há pasta
  própria de apresentações), e se você apontar para uma nota específica,
  ela ganha a referência automaticamente.
- **Habilidades padrão** (as de sincronizar, apresentação e artefato) podem
  ser **editadas**, mas nunca excluídas. **Habilidades customizadas** são
  skills que você mesmo cria — aparecem como comandos de barra reais
  (`/nome-da-habilidade`) assim que existem. Duas formas de criar, no **＋**
  da seção "habilidades" da lateral: **"nova habilidade (IA)"** — descreva
  o que ela deve fazer e a IA escreve a skill — ou **"importar skill
  existente"** — cole o conteúdo de uma skill que você já tem. Cada
  habilidade listada (na lateral) tem um menu **⋯** com **usar**,
  **editar** (abre o arquivo bruto), **pedir à IA** (peça para evoluir a
  habilidade, preservando o que já funciona) e **excluir** (só para as
  customizadas).
- Na lateral, o ícone diz a origem: **🧩 peça** = habilidade padrão,
  **★ estrela** = customizada (o **📖 livro** marca a seção e os controles
  de habilidade, como no próprio Claude). Clique no título da seção
  "habilidades" para **recolher/exibir** a lista inteira (o caret ▾/▸
  mostra o estado).

## Grifar, comentar e agir sobre um trecho

Em qualquer markdown do acervo — a transcrição de uma reunião, um contexto,
uma nota — **selecione um trecho** com o mouse e uma pequena ferramenta
flutuante aparece com cinco ações:

- **✎ grifar** — destaca o trecho (fica evidenciado, como sublinhar na vida
  real). Clique no grifo depois para **✕ desgrifar** e removê-lo.
- **💬 comentar** — escreve um comentário preso àquele trecho. O grifo ganha
  um traço mais forte e todos os comentários do documento se reúnem num
  painel **"💬 comentários"** logo abaixo do texto (cada linha leva de volta
  ao trecho).
- **? perguntar** / **✦ analisar** — roda a habilidade só sobre aquele
  trecho: ele é grifado e entregue **evidenciado** ao agente, que foca a
  análise/pergunta nele.
- **➤ Slack** — envia uma pergunta sobre o trecho para um **#canal** ou
  **@pessoa** no Slack (ex.: "estamos num brainstorming, preciso da sua ajuda
  com isto"). Quem fala com o Slack é o **agente do terminal**, com o conector
  dele — o Loro nunca guarda credencial, e nada é enviado sem sua confirmação.

Os grifos e comentários ficam num arquivo ao lado do documento
(`<doc>.anotacoes.json`) e **viajam com o acervo** — não sujam o texto
original nem entram em nenhum log. Se um documento for muito editado e um
trecho grifado não for mais encontrado, ele não é perdido em silêncio:
aparece como **"trecho órfão"** no painel de comentários.

## Contextos também têm anexos

Cada contexto tem sua pasta **anexos/**, sempre visível na árvore — com
**＋ nova nota** (escreve uma nota que nasce dentro do contexto) e **＋ do
computador** (seletor de arquivos). Diferente dos anexos de brainstorming,
os anexos de um contexto são **versionados junto com ele** (entram no fluxo
de versionar/propor mudança normalmente).

## Fila → gerar contexto

- Marque os **arquivos** de um brainstorming (reunião → suas análises, notas,
  anexos) e **envie para a fila** — cada arquivo vira um item próprio
  na fila (multi-seleção envia todos). No ⋯ do brainstorming, **"enviar tudo →
  fila"** manda todos os arquivos de uma vez. (Você também pode soltar arquivos
  `.md`/`.txt` direto na fila.) A transcrição bruta da reunião nunca vai (BR-8).
- **▶ gerar contexto** roda `/loro-context` no Claude do terminal, que
  estrutura o material em `contextos/<c>/context.md` (+ CHANGELOG).
- Cada `context.md` abre com um **Sumário** (1 linha por seção + IDs `D-…`/`H-…`),
  regenerado a cada atualização — é ele que deixa a leitura barata para pessoas
  e agentes; decisões e hotspots ganham IDs estáveis, localizáveis por busca.
- Com a fila **vazia**, o botão avisa e não roda: não há de onde gerar.
- O checkbox **"salvar anexos referenciados no contexto"** (opcional, marque
  antes de gerar) copia os anexos dos itens processados para
  `contextos/<c>/anexos/` — sem marcar, os anexos ficam só no brainstorming.

## Versionar e propor mudança (RFC = PR)

- **⎇ (branch)** mostra a branch atual; clique para trocar de branch ou criar
  uma nova. Mudanças de conhecimento **sempre nascem numa branch** `rfc/…` —
  a main é protegida.
- **versionar** sincroniza a main com o remoto (quando houver), cria/reusa a
  branch `rfc/<slug>` e commita suas mudanças locais. Sem rede? O fluxo segue
  local e o app avisa.
- **propor mudança** publica a branch e abre o Pull Request (a RFC). Os donos
  do contexto (CODEOWNERS) revisam; o merge torna a proposta oficial.
- Trocar de branch com alterações não versionadas é bloqueado — versione antes.

## Perguntar ao acervo

- Na Visão Geral, o botão **📖 executar habilidade** abre a lista completa de
  habilidades — **perguntar ao acervo** é uma delas (também na paleta,
  `Cmd/Ctrl+Alt+Q`). A pergunta roda com `/loro-ask`; a resposta se ancora
  nos `context.md` do acervo e diz claramente quando a base não cobre o
  assunto.
- Ao lado de **propor mudança** há um **ⓘ** explicando o fluxo: publica a
  branch `rfc/…` e abre o Pull Request (a RFC) para revisão dos donos do
  contexto.

## FAQ

**Onde ficam meus dados?** Na pasta do acervo que você escolheu, e só nela.
Config e modelos ficam em `~/.loro/`. Nenhum conteúdo sai da máquina sem ação
sua (rodar um skill, propor um PR).

**O que sobe para a nuvem?** Nada, por padrão. "Propor mudança" publica a
branch no seu repositório remoto; os skills do Claude leem a base local
primeiro e declaram quando consultam algo externo.

**Posso usar vários projetos?** Sim — o seletor ◆ no topo da lateral troca de
acervo e cria novos.

**Por que o botão "gerar contexto" está desabilitado?** A fila está vazia.
Envie arquivos de um brainstorming (ou solte arquivos na fila) primeiro.

**O Claude não abre no terminal.** Confira se o CLI está instalado (`claude`
no PATH) e se há um acervo configurado. O app avisa quando não consegue abrir.

**Como mudo a largura da lateral?** Arraste a divisória entre a lateral e o
editor; com a lateral larga, os arquivos mostram data e estado git. Clique
duplo na divisória volta ao padrão.

**Uma aba mostrou conteúdo de outro arquivo.** Isso era um defeito antigo do
editor, corrigido — se voltar a acontecer, abra um issue com os passos.

**Em que idioma o conteúdo é gerado?** No idioma que você escolheu ao criar o
acervo (pt-BR ou inglês) — a interface inteira segue essa escolha. Dá para
trocar depois na engrenagem (⚙); um acervo pode conter documentos nos dois
idiomas se você alternar. As pastas no disco (`reunioes/`, `notas/`,
`anexos/`, `contextos/`) ficam sempre em português, independente do idioma.

**O que é uma "habilidade customizada"?** Uma skill que você mesmo cria —
descrevendo o que ela deve fazer (a IA escreve) ou importando uma que você já
tem. Vira um comando de barra de verdade (`/nome-da-habilidade`) e aparece na
seção "habilidades" da lateral; roda pelo menu ⋯ ("executar habilidade…")
de um brainstorming ou reunião.

**Posso apagar uma habilidade padrão (sincronizar, apresentação, artefato)?**
Não — pode editá-la, mas não excluí-la. Só habilidades customizadas (criadas
por você) podem ser excluídas.

**O que o "modo automático" realmente faz?** É o modelo de uso "Automático"
(escolhido na criação, o padrão). Com ele, o loop pode criar um contexto novo
ou decidir a qual contexto atribuir algo, sozinho, ao processar a fila.
Escolhendo qualquer outro modelo (ou desligando depois em Configurações), ele
não cria nada novo por conta própria — deixa o item pendente na fila e avisa
que precisa da sua decisão manual. Não afeta atribuir a um contexto que já
existe.

**Por que as notas de uma reunião não aparecem de cara?**
Ficam recolhidas por padrão para a lateral não crescer demais — toque na
seta ▸ ao lado da reunião para abrir. Análises, respostas e qualquer documento
gerado por uma habilidade ficam todos na pasta **notas/** da reunião.
