# Manual do Loro

_O Loro captura sua fala e seus textos localmente e transforma tudo em uma base
de conhecimento por tema — privada, com histórico e revisável. Nada de áudio
ou texto sai da sua máquina sem uma ação explícita sua._

## O fluxo em uma frase

**Ideias → Para organizar → Conhecimento**: você acumula material bruto
(reuniões, notas, anexos) dentro de uma **ideia**; seleciona **os arquivos** que
importam e cada um entra em **para organizar** como ele mesmo (um item por
arquivo); o botão **Transformar em conhecimento →** pede ao agente que destile
tudo isso em **temas de conhecimento** — a fonte oficial da verdade, com
histórico de versões.

## A tela, em uma olhada

Toda tela tem a mesma anatomia:

```
CABEÇALHO 54px — [projeto ⌄] [Início · Organizar · Conhecimento · Revisão] ··· [Gravar] [✦ IA]
BARRA LATERAL │ ABAS (só quando há documento aberto) │ PAINEL 330px
250px ou 60px │ CONTEÚDO                             │ Documento · Chat · Terminal
```

- **Os quatro destinos** ficam no cabeçalho: **Início** (o que você quer guardar
  hoje), **Organizar** (o que foi capturado e ainda não virou conhecimento — o
  número âmbar é a contagem), **Conhecimento** (os temas oficiais do time) e
  **Revisão** (o que você mudou e ainda não salvou, e o que o time propôs e
  espera alguém ler — o número âmbar é quantas revisões pedem você).
- **Gravar** é o botão vermelho do cabeçalho; enquanto grava, ele vira **Parar**
  e a gravação continua se você trocar de aba — um selo `gravando · mm:ss`
  aparece no cabeçalho e leva de volta.
- **Se você ouve por alto-falante**, o microfone escuta de volta o que os
  outros falam, e a mesma frase chega nas duas trilhas. O Loro descarta a cópia
  sozinho, e sempre a do **microfone**: o som vaza da caixa para o microfone, e
  nunca no sentido contrário, então a fala dos outros nunca é rotulada como sua.
  Para isso ele espera alguns segundos a trilha do sistema antes de escrever a
  sua fala — é por isso que o seu texto às vezes aparece um pouco depois. Se
  quiser matar o vazamento na origem, ligue **cancelar o eco do alto-falante**
  em Configurações → Captura, com o custo, declarado ali, de a sua voz sair mais
  baixa. Com fone, deixe desligado.
- **O texto entra em parágrafos**, um por trecho de fala corrida, carimbado com o
  horário em que aquela fala começou de verdade — e uma pausa começa um parágrafo
  novo. O horário é contado desde o instante em que a gravação começou: numa
  reunião a captura do áudio do sistema começa antes de a tela aparecer, então o
  relógio pode abrir com alguns segundos já corridos — é o tempo que já está
  gravado, não um erro.
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
- As três seções da barra lateral (**ideias**, **para organizar**,
  **conhecimento**) **recolhem**: clique no título. Com muitos temas isso é o que
  mantém a árvore navegável.
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
- Cada passo do agente (uma ferramenta que ele usou) **abre**: clique para ver o
  que foi pedido e o que voltou. Um passo que falhou já abre sozinho.
- Se o agente **não teve permissão** para concluir, aparece um bloco âmbar:
  **Liberar tudo e repetir** — que muda o que o chat pode fazer para *tudo, sem
  perguntar*, e vale das próximas vezes também — ou **Continuar no terminal**,
  onde ele pode pedir permissão passo a passo. Nada foi alterado até você
  escolher.
- **Onde as habilidades rodam** é escolha sua: **Configurações → IA e terminal**.
  *No chat*, a resposta fica na conversa; *no terminal*, você acompanha o passo a
  passo e pode intervir. Vale para tudo — analisar uma reunião, perguntar ao
  projeto, rodar uma ação pelo menu ⋯.
- **O que o chat pode fazer** também é escolha sua (**Configurações → IA e
  terminal**). O chat não consegue parar e perguntar no meio de uma ação, então
  ele já vem com permissão para agir: *ler e editar o projeto* cobre analisar uma
  reunião e escrever notas; *tudo, sem perguntar* libera também conectores
  externos (Slack, Drive…) e caminhos fora da pasta do projeto.

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

1. **Criar o projeto** — na primeira abertura, o assistente mostra todos os
   campos de uma vez (nada fica atrás de "opções avançadas"): nome, modelo de
   uso com os temas iniciais logo ao lado (ex.: `produto`, `engenharia`),
   pasta (a padrão já aparece preenchida; o ⓘ detalha o que será guardado
   nela), idioma, cor e o agente de IA. Deixe "guardar histórico de versões"
   marcado para habilitar o fluxo de revisão (recomendado).
2. **Modelo de uso** — a primeira opção é **Automático** (padrão): o agente
   cria e atribui o tema sozinho ao organizar, então você não
   precisa definir temas agora (dá para desligar depois em
   Configurações). As demais opções são modelos prontos (Vendas,
   Engenharia, Produto & gestão, Aprendizado, Educação, Recrutamento,
   Saúde) ou o Genérico (em branco) — nesses, você define os temas e o
   agente não cria novos sozinho. Cada modelo pré-preenche os temas (você
   pode editar), adiciona regras da vertical ao `AGENTS.md`, semeia as instruções
   do agente e define o molde do documento de conhecimento de cada tema (as seções
   variam por vertical — vendas fala de pipeline e compromissos, saúde de
   condutas e protocolos). A explicação de cada opção aparece logo abaixo ao
   selecioná-la. "duplicar para personalizar" copia qualquer modelo para
   `~/.loro/templates/`, onde você edita os arquivos e ele passa a aparecer
   no assistente. Modelos com dados pessoais (Vendas, Recrutamento, Saúde)
   trazem regras de minimização — o de Saúde avisa: dados de saúde são
   sensíveis e o projeto não substitui o prontuário.
3. **Agente de IA** — o campo "agente de IA (comando)" define qual CLI o
   terminal embutido usa neste projeto: `claude` (padrão), `gemini`,
   `ollama run llama3`… O projeto é só arquivos + convenção (`AGENTS.md`),
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
   Tudo que o app **gera** (análises, documentos de reunião, conhecimento)
   nasce no idioma ativo da interface.
6. **Versão** — o rodapé das Configurações (⚙) mostra a versão instalada
   (ex.: `v0.8.0`), para você conferir num relance se a atualização pegou.

## Gravar e transcrever

- **● (gravar)** abre o diálogo de gravação perguntando **onde salvar**: uma
  ideia (vira uma reunião ligada a ela) ou **transcrição avulsa (salvar ao
  final)** — o texto fica no painel ao vivo para salvar/descartar quando você
  parar. O atalho global é `Cmd/Ctrl+Alt+Espaço`.
- Cada comando da paleta (`Cmd/Ctrl+K`) tem um atalho
  `Cmd/Ctrl+Alt+<tecla>`, exibido ao lado do comando na própria paleta.
- **Fontes** (Configurações → Transcrição → *fonte*): **microfone**, **áudio do
  sistema** (requer BlackHole — o app guia a instalação) ou **minha voz + áudio
  do sistema** (a reunião: as duas trilhas juntas; a transcrição acontece ao
  final, com mais fidelidade).
- O áudio é **transitório**: usado para transcrever e descartado. O indicador
  de privacidade na barra mostra o estado ("sem gravar" / "grava áudio").

## Ideias (o mundo sem histórico de versões)

- **Escrever uma nota** (na tela Início) abre um markdown **em branco** na hora:
  você escreve primeiro e, ao salvar, escolhe o título e onde a nota vai morar —
  uma ideia existente ou um tema de conhecimento. Enquanto não salvar, nada é gravado
  em disco.
- O **＋** ao lado de **ideias** cria uma ideia (o botão se chama "Nova ideia"):
  um espaço privado para um assunto. O **＋** ao lado de **conhecimento** cria um
  tema (o botão se chama "Novo tema").
- Dentro dela (expanda a ideia na lateral): cada pasta tem sua
  própria ação de criação no topo — **notas** → **＋ nova nota**;
  **reuniões** → **● gravar reunião** (também na paleta `Cmd/Ctrl+K`
  → "nova reunião"); **anexos** → **⇄ sincronizar** (traz de
  Drive/Slack/Jira/Confluence) e **＋ do computador** (abre o seletor e copia
  um `.pdf`/`.xlsx`/imagem que você já tem para os anexos do tema).
- **✦ nota por IA** (menu ⋯ da ideia) cria uma nota a partir de um
  pedido seu; **✦ pedir à IA** (menu ⋯ de uma nota/análise **e no rail à
  direita de qualquer arquivo aberto**) aplica um pedido sobre o conteúdo
  existente — a IA evolui, nunca apaga.
- **Menu ⋯ de uma reunião**: além de renomear e apagar, **⇄ mover para…** leva a
  reunião inteira — transcrição, análises e material gerado — para outra
  ideia — disponível depois que a reunião termina, como analisar e enviar
  para organizar. Também dá para arrastar a reunião pelo ícone até o cabeçalho
  **📁 reuniões** da ideia de destino. Uma reunião de mesmo nome no destino
  nunca é sobrescrita.
- **Menu ⋯ de qualquer arquivo** (nota, anexo, avulso, nota de reunião):
  além de **renomear** e **apagar**, traz **⇄ mover para…** (escolha a pasta
  de destino — avulso, ou as pastas notes/attachments de qualquer ideia) e
  **⧉ copiar caminho** — **relativo** (portátil, no formato usado pelas
  referências `acervo://`) ou **absoluto** (o caminho completo no disco, útil
  para abrir no Finder/terminal). Nunca sobrescreve um arquivo de mesmo nome no
  destino. O **copiar caminho** está no menu ⋯ de **todo item da árvore
  lateral** — arquivos, ideias, reuniões, itens para organizar, temas,
  pastas (anexos) e habilidades, além das fontes.
- **Arrastar e soltar:** arraste o **ícone** de um arquivo (o cursor vira uma
  mãozinha) e solte sobre o cabeçalho de uma pasta (📁 notas, 📁 anexos ou
  📁 avulso) para movê-lo — o mesmo efeito do **mover para…**, restrito ao
  mundo das ideias (nunca toca o que tem histórico de versões). O resto da linha
  continua sendo clique-para-abrir.
- **Rail de ações à direita do arquivo:** ao abrir qualquer nota/documento,
  a lateral direita mostra cartões de ação separados — **habilidade** (um
  dropdown com nomes amigáveis; a descrição da habilidade selecionada fica
  sempre visível logo abaixo, e **▶ executar** roda sobre o arquivo aberto),
  **pedir à IA…**, e **Salvar versão** (quando o arquivo é de um tema de
  conhecimento). Mesmo padrão em todo lugar onde essas ações existem — reunião,
  documento comum, cabeçalho do projeto. No **modo edição** o editor ocupa o painel
  inteiro e o rail fica oculto; as ações continuam disponíveis no modo
  visualizar.
- **Barra de formatação no modo edição:** acima do editor há botões para
  **negrito** (⌘B), *itálico* (⌘I), riscado, títulos (H1/H2/H3), lista,
  checklist, lista numerada, citação, código, link (⌘K), tabela, bloco de
  código e linha separadora. Eles escrevem a marcação markdown no ponto do
  cursor (ou envolvem o texto selecionado) e desfazem quando você clica de
  novo sobre um trecho já formatado — o arquivo continua sendo markdown
  legível, então o histórico no git mostra apenas o que você mudou de fato.
  A mesma barra aparece no editor dos itens em **para organizar** e das
  instruções do agente, onde **⌘S** salva.
- **✦ analisar**, **? perguntar…** e **enviar para organizar →** ficam no menu
  **⋯** da reunião na lateral. **perguntar…** funciona já durante a gravação; as
  outras duas habilitam quando a reunião termina. **enviar para organizar** manda
  as **análises** da reunião (o que estiver em `notes/`) — a transcrição bruta
  nunca vai. Uma reunião que ninguém analisou não tem o que enviar, e o menu diz
  isso em vez de falhar no clique.
- A aba `meeting.md` da reunião mostra, em vez de botões fixos, um único
  **dropdown de habilidades** ("o que fazer com esta reunião") — escolha
  qualquer habilidade (incluindo analisar/perguntar) e rode sobre a reunião
  aberta. Sem restrição: aparecem todas, padrão e customizadas.
- Numa reunião: use **✎ Marcar momento** (`Cmd/Ctrl+Alt+M`, ou o botão acima da
  transcrição) para ancorar o instante em que algo importante foi dito — é um
  marcador só, sem tipo a escolher no meio da fala; depois rode **analisar** (menu ⋯)
  para o Claude escrever a análise em `notes/`. Quando a gravação termina, o app
  abre a transcrição e **oferece** analisar em um clique — é uma sugestão, não
  roda nada sozinho, e some se você ignorar.
- Nada de uma ideia entra no histórico de versões nem sai da máquina.
- As **notas** de cada reunião (análises, respostas e qualquer documento que
  uma habilidade gere) ficam **recolhidas por padrão** na lateral (toque na
  seta ▸ ao lado da reunião para abrir) — evita que a lista cresça demais
  quando há muitas reuniões analisadas. Tudo o que uma habilidade produz sobre
  a reunião vai para a pasta **notes/** dela (não mais em pastas separadas como
  investigações/respostas).
- Cada ideia tem exatamente três pastas, visíveis na lateral como
  grupos com ícone de pasta (📁 **reuniões**, 📁 **notas**, 📁 **anexos** —
  cada uma clicável para expandir/recolher):
  **meetings/** (toda reunião nasce ali), **notes/** e **attachments/** (uma
  apresentação é só mais um tipo de anexo — não tem pasta própria).
  `attachments/` é alimentada por uma habilidade (sincronizar, apresentação,
  artefato) ou arrastando um arquivo
  direto na pasta real no disco.
- Com muitas ideias, um campo de busca aparece no topo da seção
  (acima de 8) — filtra por nome; sem busca, mostra só os mais recentes +
  "ver todos".

## Habilidades de IA

As habilidades de IA são ações do agente — algumas já vêm prontas (padrão),
outras você cria. Não ficam mais na Visão Geral: rode uma pelo menu **⋯**
de uma ideia → **"executar habilidade…"**, pelo botão **"executar
habilidade…"** no topo do visualizador de **qualquer arquivo markdown**, ou
pelo dropdown de habilidades numa reunião aberta. Sempre um menu/controle
compacto — a descrição de cada uma só aparece ao passar o mouse, para não
poluir a tela quando houver muitas.

Quando você roda uma habilidade sem nenhum documento aberto (pelo ⌘K, em
Início), a folha pergunta **onde** ela deve agir: um seletor com as ideias e os
conhecimentos que o projeto já tem. Abrindo a habilidade de dentro de um
documento, o alvo já vem preenchido com ele.

- **Sincronizar** traz um item externo (Google Drive/Gemini, Slack, Jira ou
  Confluence) para um **anexo local** da ideia, referenciado numa
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
  (um deck em markdown, um diagrama, um script, uma planilha) a partir de uma
  ideia ou de um tema — sempre em `attachments/` (não há pasta
  própria de apresentações), e se você apontar para uma nota específica,
  ela ganha a referência automaticamente.
- **Habilidades padrão** (as de sincronizar, apresentação e artefato) podem
  ser **editadas**, mas nunca excluídas. **Habilidades customizadas** são
  skills que você mesmo cria — aparecem como comandos de barra reais
  (`/nome-da-habilidade`) assim que existem. Duas formas de criar, no **＋**
  da seção "Habilidades de IA" da lateral: **"nova habilidade (IA)"** — descreva
  o que ela deve fazer e a IA escreve a skill — ou **"importar skill
  existente"** — cole o conteúdo de uma skill que você já tem. Cada
  habilidade listada (na lateral) tem um menu **⋯** com **usar**,
  **editar** (abre o arquivo bruto), **pedir à IA** (peça para evoluir a
  habilidade, preservando o que já funciona) e **excluir** (só para as
  customizadas).
- Na lateral, o ícone diz a origem: **🧩 peça** = habilidade padrão,
  **★ estrela** = customizada (o **📖 livro** marca a seção e os controles
  de habilidade, como no próprio Claude). Clique no título da seção
  "Habilidades de IA" para **recolher/exibir** a lista inteira (o caret ▾/▸
  mostra o estado).

## Grifar, comentar e agir sobre um trecho

Em qualquer markdown do projeto — a transcrição de uma reunião, um tema,
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
  **@pessoa** no Slack (ex.: "estamos discutindo uma ideia, preciso da sua ajuda
  com isto"). Quem fala com o Slack é o **agente do terminal**, com o conector
  dele — o Loro nunca guarda credencial, e nada é enviado sem sua confirmação.

**Sem mouse:** na paleta (`Cmd/Ctrl+K`) existe **Grifar um trecho…** — escreva ou
cole o trecho exato e ele é grifado. Cada grifo é um controle: entra na navegação
por **Tab** e abre as mesmas ações com **Enter**. Dentro delas as **setas** andam
de ação em ação, como em qualquer menu do app, e **Esc** fecha devolvendo o foco
ao grifo.

Os grifos e comentários ficam num arquivo ao lado do documento
(`<doc>.anotacoes.json`) e **viajam com o projeto** — não sujam o texto
original nem entram em nenhum log. Se um documento for muito editado e um
trecho grifado não for mais encontrado, ele não é perdido em silêncio:
aparece como **"trecho órfão"** no painel de comentários.

## Os temas de conhecimento também têm anexos

Cada tema tem sua pasta **attachments/**, sempre visível na árvore — com **＋ nova
nota** (escreve uma nota que nasce dentro do tema) e **＋ do computador**
(seletor de arquivos). Diferente dos anexos de uma ideia, os anexos de um tema
**entram no histórico de versões junto com ele** (passam por salvar versão e
por enviar para revisão do time normalmente).

## Para organizar → conhecimento

- **Antes de entrar, o Loro confere o que o arquivo carrega.** Se parecer haver
  uma credencial (chave de API, token, chave privada), o arquivo **não entra** —
  o projeto guarda histórico e vai para o git, e o que é publicado não volta.
  CPF ou transcrição colada dentro de uma nota geram um aviso: você lê e decide.
  O aviso diz a regra e a linha, nunca repete o que encontrou.
- Marque os **arquivos** de uma ideia (reunião → suas análises, notas, anexos)
  e use **enviar para organizar** — cada arquivo vira um item próprio (a
  multi-seleção envia todos). No ⋯ da ideia, **→ tudo para organizar** manda
  todos os arquivos de uma vez. (Você também pode soltar arquivos `.md`/`.txt`
  direto na lista.) A transcrição bruta da reunião nunca vai (BR-8).
- **Transformar em conhecimento →** roda a habilidade de organizar no agente,
  que estrutura o material dentro do tema (o documento de conhecimento + o
  histórico do tema).
- Cada documento de conhecimento abre com um **Sumário** (1 linha por seção +
  IDs `D-…`/`H-…`), regenerado a cada atualização — é ele que deixa a leitura
  barata para pessoas e agentes; decisões e hotspots ganham IDs estáveis,
  localizáveis por busca.
- Sem nada **para organizar**, o botão avisa e não roda: não há de onde gerar.
- O seletor **destino** decide onde o material entra: *a IA decide* ou um tema
  que você escolhe. **guardar os anexos junto** (opcional, marque antes) copia
  os anexos dos itens processados para os anexos do tema — sem marcar, eles
  ficam só na ideia. **ajustar instruções** abre o que o agente deve seguir
  antes de organizar.

## Como um tema puxa o outro

- **Dá para ver para onde o clique leva antes de clicar.** Dentro de um
  documento, um salto para **outro tema** aparece como um nome comum, um salto
  para um **arquivo do projeto** aparece como caminho em letra de máquina, e um
  endereço que **sai para o navegador** leva uma setinha `↗`.
- **Citado por** é a caixa logo abaixo de **Referências**, no fim de um tema.
  Referências mostra o que aquele tema aponta; **Citado por** mostra quem aponta
  para ele — e em que sentido: *recebe deste*, *entrega para este* ou *nos dois
  sentidos*. Clique em qualquer linha para abrir o tema que cita. Se ninguém
  cita, a caixa não aparece.
- **Índice remissivo** — o botão fica em **Conhecimento**, e também no `⌘K`.
  É a lista de toda palavra que o conhecimento já escreveu — o nome que um tema
  usa para chamar o outro, o título de um ponto em aberto, uma decisão, um código
  citado — com o lugar exato de cada uma ao lado. Clique no lugar e ele abre ali.
  **Ele é calculado na hora, toda vez que você abre**: não é um arquivo, não
  envelhece e nada é gravado no projeto por causa dele. `Cmd/Ctrl+F` busca dentro
  da lista.
- **Conhecimento que ninguém cita** e **Ligações quebradas** ficam no fim de
  **Conhecimento**, e só aparecem quando existe o problema. A primeira lista os
  temas para os quais nenhum outro aponta — quem lê seguindo as ligações nunca
  chega até eles; a segunda, os links que apontam para um arquivo que não existe.
  Cada linha diz o nome do tema e tem **abrir** ao lado: no link quebrado, abre o
  documento **que cita** (é lá que se conserta) e mostra o endereço exatamente
  como está escrito.
- **O índice do projeto e o índice remissivo ficam no topo de Conhecimento.** O
  primeiro (`INDEX.md`) lista todos os temas com uma linha de descrição — é por
  onde começar, e por onde a IA começa. O segundo (`TERMS.md`) é a lista de nomes
  com o lugar de cada um. Os dois são arquivos do projeto: abrem no GitHub e em
  qualquer editor, sem o Loro.
- **Projeto com a estrutura antiga pede uma atualização antes de abrir.** O Loro
  reconhece e mostra uma tela só, com um botão: você vê a lista completa do que vai
  mudar antes de confirmar, nada é apagado e o que você escreveu continua igual.
- **Clicar num verbete leva até a palavra, não até o topo do arquivo.** O
  trecho fica grifado por 10 segundos e a tela rola até ele; depois a marca some
  sozinha, sem deixar nada no documento.
- **O índice remissivo se mantém sozinho.** Ele é regerado quando o conhecimento
  muda — não quando você abre a tela — e só é reescrito se o conteúdo mudou de
  verdade, para não sujar o seu `git status` à toa.
- **Nome de pessoa não fica no conhecimento.** O projeto é versionado e
  compartilhado, então quem participa é descrito pelo papel (produto, negócio,
  engenharia), não pelo nome. Isso é regra do próprio projeto, e o Loro sabe
  apontar o que parece dado pessoal para você decidir.
- **Códigos citados (`MM-1147`) viram link quando você diz onde eles abrem.** Em
  **Configurações → Projeto**, o campo *onde abrem os códigos citados* recebe o
  começo do endereço do seu quadro de tarefas (`https://…/browse/`). Sem esse
  endereço o código continua aparecendo no texto, só não é clicável — o Loro não
  adivinha onde os códigos de outra ferramenta vivem.

## Revisão

O destino **Revisão** é a outra metade do produto: nada entra no conhecimento
oficial sem alguém ler. Ele tem duas metades, e a frase no topo muda com a que
você escolher.

### Mudanças de agora

- É o que **você** mudou e ainda não salvou numa versão. Funciona **sem
  internet, sem GitHub e sem conta** — é o histórico do seu computador.
- Um cartão por documento, com **novo · modificado · removido**, o nome, o
  caminho e quanto mudou (`+6 −2 · 2 trechos mudaram`).
- **Clique no cartão** e a mudança aparece na sua língua: **como era** (fundo
  avermelhado) e **como fica** (fundo esverdeado). Um documento novo aparece como
  **documento novo**, com o começo dele. Resumo é resumo: se for longo, o app
  diz quantas linhas ficaram de fora.
- **ver a mudança completa** abre as linhas exatas, dentro do mesmo cartão, com
  os números de linha. **unificado** (o padrão) lê como o documento, com as
  linhas `−` e `+`; **lado a lado** põe o antes à esquerda e o depois à direita.
  Onde não havia linha, o espaço é hachurado. Um intervalo entre dois pedaços é
  anunciado (`⋯ 12 linhas sem mudança`) — é aviso, não botão: essas linhas não
  mudaram.
- Numa mudança muito longa o cartão desenha 400 linhas de cada vez, diz quantas
  faltam (`⋯ … e mais 500 linhas`) e oferece **mostrar mais linhas** ali mesmo —
  a leitura continua dentro da tela, e o aviso desaparece quando acaba.
- **marcar como visto** é para você: o contador `3 de 8 vistos` no topo ajuda a
  não perder um documento numa mudança grande. A marca é **daquela mudança**: se o
  documento mudar outra vez (ou se você salvar a versão e mexer nele de novo), o
  cartão volta a aparecer como não visto — ele é outro texto para ler.
- Um arquivo que não é texto (uma imagem, um áudio) diz **não dá para mostrar as
  linhas deste arquivo** em vez de desenhar um diff vazio.
- Se o projeto ainda não guarda versões, a tela diz isso e o que fazer. Se nada
  mudou, ela diz **tudo salvo** e em qual rascunho está a última versão — e o passo
  seguinte que ela oferece é sempre um que funciona: com o time conectado, **envie
  para revisão**; sem o GitHub conectado, **conecte o GitHub em Configurações** (com
  a porta ali mesmo); sem rede, ela diz que o envio volta **quando a rede voltar**.
- **Uma versão guarda o que já está no arquivo.** Se um documento aberto tem texto
  que você ainda não salvou (a aba mostra ●), a tela diz **texto não salvo em
  ‹documento›** e oferece **abrir o documento** — salve lá, e a mudança aparece
  aqui. Com a lista vazia essa é a resposta da tela, no lugar de «tudo salvo».

### Salvar a versão daqui

- O campo **Descreva a mudança em uma linha** fica ao lado das mudanças que ele
  descreve, então o botão **grava direto** — sem folha no meio. A frase acima
  dele avisa o preço antes do clique: guarda o **projeto inteiro**, todos os
  temas, não só o documento aberto.
- **⎇ no rascunho ‹nome›** diz onde você está; **trocar de rascunho** abre a
  lista. Ela chama os lugares como a tela chama: **conhecimento oficial** e
  **rascunho «nome»** — e a folha da troca diz **para onde** você vai e **por onde**
  volta, com o preço (quantos documentos saem da tela, e que nada é apagado).
  Criar um rascunho novo é um campo só, com o contador `0/24` e a prévia do
  nome enquanto você digita.
- Depois da troca, o aviso chama o lugar **pelo mesmo nome** («⎇ rascunho «prazo-do-
  convite»», «⎇ conhecimento oficial») e repete o preço que foi pago («7 documentos
  ficaram no rascunho anterior»). O nome interno do git não aparece em lugar
  nenhum — e o chip, o estado vazio e o aviso trocam **juntos**.
- Enquanto houver mudança que **ainda não está em nenhuma versão**, trocar de
  rascunho não é possível — o Loro guardaria uma mudança pela metade. As linhas
  aparecem apagadas dizendo **salve uma versão primeiro**, e **＋ novo rascunho…**
  continua funcionando: um rascunho novo **leva a mudança com você**.
- Se você estiver **no conhecimento oficial** (ou num ramo que não é um rascunho
  do Loro), salvar **cria um rascunho de trabalho** — nada é escrito direto no
  oficial. A tela diz isso antes do clique e mostra o nome que a sua descrição vai
  dar a ele (`salvar cria o rascunho «prazo-do-convite»…`), pela mesma regra de 24
  letras da folha **Novo rascunho**.
- Sem descrição, o app pede a descrição e não grava nada. Sem nada mudado, o
  botão fica desligado (o estado vazio logo acima explica por quê).
- Se o **time ainda não está conectado** (ou a rede caiu), a tela diz isso **antes
  do clique**, logo acima dos botões, e **↗ Enviar para revisão do time** fica
  desligado: salvar versão continua funcionando (é local), e **abrir Configurações**
  leva direto à seção **Versões e GitHub**, onde cada coisa que falta é nomeada com
  o seu remédio.
- **↗ Enviar para revisão do time** abre a folha do envio. Os campos são as
  **seções do modelo do time** — o arquivo que o repositório já traz, não uma
  lista que o Loro inventou. **configurar o modelo** deixa você mudar as seções
  (uma por linha): a mudança vale para o time todo e passa pela **mesma revisão**
  que qualquer outra.
- Se um envio **falhar** (o GitHub fora do ar, o time não conectado), a folha
  **não fecha**: o motivo aparece dentro dela, o que você escreveu continua lá e o
  botão continua armado. Quando o que falta é uma configuração, a própria folha
  oferece **abrir Configurações** — arrume o que falta, volte, e clique de novo.

### Revisões do time

- Duas listas: **Aguardam a sua revisão** e **Suas mudanças · e as que você já
  revisou**. Cada linha traz o número, o assunto, o estado (**mudanças pedidas**,
  **aprovada**), de quem é, de qual rascunho vem e quando mudou. **O título abre a
  revisão** — pelo mouse ou pelo teclado, e quem usa leitor de tela ouve o estado
  junto com o assunto. **⧉ copiar link**, ao lado, pega o endereço para colar no
  chat do time.
- **A versão cai no rascunho em que você está.** Salvar uma versão não te move de
  lugar: ela é gravada no rascunho de trabalho em que você já está. Só quando você
  está no **conhecimento oficial** é que salvar cria um rascunho — e o nome dele é
  dito antes do clique, porque o oficial não recebe mudança direta.
- **Trocar de rascunho leva a sua mudança não salva com você.** Se o documento for
  diferente no rascunho de destino, a troca é recusada e a tela diz qual documento —
  aí salvar uma versão primeiro resolve.
- **O rascunho fica no cabeçalho.** O chip `⎇` ao lado de Gravar diz em que rascunho
  de trabalho você está — é onde a próxima versão vai cair — e abre a folha para
  trocar ou criar um. Numa janela estreita ele fica só com o glifo, e o nome continua
  no título e na folha.
- **Salvar o documento grava o arquivo, e só isso.** No modo de edição, **Salvar**
  escreve o texto no disco. A versão do projeto é outro ato, com outra porta: a
  Revisão (ou a seção TIME do painel ✦ IA) — um commit guarda o projeto inteiro, não
  o documento em foco.
- **A tela se mantém viva.** Com a Revisão aberta, o app relê as suas mudanças e as
  revisões do time no mesmo relógio de 10 segundos do resto da tela — não existe
  botão de «atualizar» porque não é preciso, e a lista nunca fica dizendo «tudo
  salvo» enquanto a lateral mostra o ponto de mudança não salva.
- **Enviar é um passo só na primeira vez.** Enquanto o rascunho não tem revisão
  aberta, **↗ Enviar para revisão do time** é a decisão de compartilhar e nada sai
  do seu computador antes dela. Depois que a revisão existe, esse botão **sai da
  tela** — não há passo nenhum a oferecer: **Salvar versão do projeto** já grava a
  versão e a leva à revisão aberta, e a tela diz qual é (#N), com a porta para ela.
  Se a rede estiver fora, a versão fica salva aqui e a revisão recebe a atualização
  quando a rede voltar — a tela diz isso também, em vez de dizer que atualizou.
- **A lista abre na hora.** Ler o time custa uma ida à rede, então a Revisão mostra
  a lista que já conhece imediatamente e busca a de agora atrás. Enquanto o que está
  na tela for a leitura anterior, a tela diz isso — e sem rede ela diz que aquela é a
  última leitura feita, que volta a atualizar quando a rede voltar.
- **A leitura acontece aqui.** Abrir uma revisão mostra a descrição nas seções
  do modelo — **lida como markdown**, do mesmo jeito que um documento do projeto:
  títulos, listas, tabelas, ênfase e bloco de código aparecem formatados, e não
  como os sinais que o autor digitou. O mesmo vale para cada comentário da
  conversa. **O que muda** (os documentos, cada um com o mesmo cartão e o mesmo
  diff de "mudanças de agora") e **Conversa** (cada linha comentada, com o trecho
  citado, quem escreveu e quando; **responder** manda a resposta de dentro do
  app). Cada **responder** diz de qual conversa é (`responder — contexts/…:13`), e
  a folha da resposta repete o endereço, quem escreveu e o trecho — a resposta não
  tem como ir para a conversa errada.
- **Sua revisão** oferece **✓ Aprovar**, **pedir mudanças** ou **só comentar** —
  e diz quanto a sua aprovação vale. Pedir mudanças ou comentar sem escrever
  nada é recusado, com o motivo.
- **Uma revisão pode voltar para você.** Se o autor salvar uma nova versão depois da
  sua aprovação (o chip diz **aprovação de versão anterior**), ou se pedirem a sua
  revisão de novo, a decisão é **oferecida outra vez** — e a tela diz por quê: «a sua
  aprovação era de uma versão anterior…», «%1 pediu a sua revisão de novo.». Uma
  decisão que ainda vale continua sendo só o **estado**, sem botão de novo.
- Depois de **pedir mudanças**, quem lê é você: a tela diz **você pediu mudanças** e
  que a mudança não entra no oficial enquanto o pedido estiver aberto — o próximo
  passo é do autor, e você é avisado aqui quando pedirem a sua revisão de novo. Para
  o **autor** da mudança, a mesma tela diz quem pediu e o que ele tem de fazer
  (responder, salvar uma nova versão no rascunho, pedir nova revisão).
- Quando a mudança é **sua** e já tem as aprovações e as verificações em ordem,
  aparece **Juntar ao conhecimento oficial** — e a cópia diz, antes do clique, o
  que juntar faz e qual rascunho ele encerra. Nunca aparecem as duas coisas ao
  mesmo tempo: quem pode aprovar não pode juntar, e uma revisão já decidida
  mostra o **estado** em vez de oferecer o botão de novo.
- Quando há **conflito** com o oficial, ou uma verificação falhando, o botão de
  juntar **não é oferecido**: a tela diz o que houve e onde resolver. Nada se
  perde.
- **Verificações que falharam** lista cada uma **pelo nome** (a que o time deu no
  CI), com **ver a verificação ↗** para abrir o registro dela. Saber que "as
  verificações" falharam sem saber qual delas era obrigava a sair do app.
- **⎇ abrir para editar** troca para o rascunho da outra pessoa, pelo mesmo aviso
  de preço de qualquer troca. Em **mudanças de agora** uma faixa âmbar passa a
  dizer de quem é o rascunho e qual revisão ele atualiza, com **voltar ao meu
  rascunho**.
- **abrir no GitHub ↗** continua ali para o que o app não faz: aplicar uma
  sugestão de código e marcar uma conversa como resolvida acontecem lá.
- Sem GitHub conectado, esta metade diz o que falta e leva a **Configurações**.
  Sem internet, ela diz que a lista é a **última leitura feita** e que volta
  sozinha quando a rede voltar — e **salvar versão continua funcionando**.

**Como chegar:** o destino **Revisão** no cabeçalho, o ⌘K (**Revisão** e **Ver
revisões do time**), a seção **TIME** do painel ✦ IA e o aviso no topo de
**Conhecimento**. Nenhuma dessas portas expira.

## Salvar versão e enviar para revisão do time

- **⎇** mostra o **rascunho de trabalho** atual; clique para trocar de rascunho
  ou criar um novo. Uma mudança de conhecimento **sempre nasce num rascunho** —
  o conhecimento oficial fica protegido.
- **Salvar versão do projeto** guarda o **projeto inteiro** — todos os temas, não
  só o documento aberto — no histórico, dentro do rascunho de trabalho em que
  você está, com a frase que você escrever. A frase descreve a versão; ela **não
  troca de rascunho** (para isso existe o **⎇**). Sem rede? O fluxo segue local e
  o app avisa.
- Quando não há nada novo para guardar, o botão diz **tudo salvo ✓** e fica
  desligado: não existe versão vazia. Se você pedir uma assim mesmo (pelo ⌘K,
  por exemplo), o app responde **nada mudou desde a última versão** — e nenhum
  rascunho é criado.
- **↗ Enviar para revisão do time** publica o rascunho e abre a revisão. Os
  donos do tema revisam; quando aprovam, a mudança vira o conhecimento oficial.
  Depois de enviar, o aviso oferece **abrir a revisão** e **ver revisões**, que
  leva ao destino **Revisão** — onde a leitura acontece, sem sair do Loro.
- **Ver revisões do time** está sempre à mão: o destino **Revisão** no cabeçalho,
  a seção **TIME** do painel ✦ IA, o ⌘K e o aviso no topo de **Conhecimento**.
  Você nunca depende de pegar um aviso passando, e um destino não se dispensa.
- Sem GitHub configurado, salvar versão continua funcionando **local** e a
  seção **TIME** aponta onde se liga (**Configurações → Versões e GitHub**). Na
  linha **repositório remoto** de **Configurações → Versões e GitHub**, o botão
  **conectar** cria o repositório do time e conecta o projeto — o app diz antes o
  que sobe (só o que já está em versões; reuniões, notas e itens para organizar
  ficam neste computador).
- **Sem rede é diferente de sem configuração**: com tudo conectado e a internet
  fora, o distintivo diz **sem rede**, a seção TIME explica que a revisão volta
  quando a conexão voltar, e o link é **verificar de novo**.
- Cada versão é assinada com a **identidade do git** (nome e e-mail) — é o que o
  time vê no histórico. Em **Configurações → Versões e GitHub**, a linha
  **identidade git** tem **corrigir**; o e-mail precisa ser um endereço de
  verdade (`ana@exemplo.com`), senão a assinatura não chega a ninguém.
- Trocar de rascunho com mudanças ainda não salvas em uma versão é bloqueado —
  salve a versão antes.
- Esta seção é a rota **por documento**, no painel ✦ IA: aqui as mudanças não
  estão na tela, então salvar passa por uma folha que diz o preço. Em
  **Revisão → mudanças de agora** as mudanças estão na sua frente e o botão grava
  direto, com o mesmo preço escrito acima dele.
- No **⎇**, cada linha diz **quanto aquele rascunho guarda** ("18 documentos",
  ou "nada guardado ainda"). Trocar para um rascunho que não tem os seus
  documentos **tira esses documentos da tela** — nada é apagado, eles continuam
  guardados no rascunho em que você estava e voltam quando você voltar para ele.
  O app avisa quantos saem e para onde se volta **antes** de trocar.

## Perguntar ao projeto

- **perguntar ao projeto** é uma habilidade como as outras: está nos chips do
  painel **✦ IA**, na lista **todas ▸** e na paleta (`Cmd/Ctrl+Alt+Q`). A
  resposta se ancora no conhecimento do projeto e diz claramente quando a base
  não cobre o assunto.
- Ao lado de **↗ Enviar para revisão do time** há um **ⓘ** explicando o fluxo:
  publica o rascunho de trabalho e abre a revisão para os donos do tema.

## FAQ

**Onde ficam meus dados?** Na pasta do projeto que você escolheu, e só nela.
Config e modelos ficam em `~/.loro/`. Nenhum conteúdo sai da máquina sem ação
sua (rodar uma habilidade, enviar uma mudança para revisão).

**O que sobe para a nuvem?** Nada, por padrão. "Enviar para revisão do time"
publica o rascunho de trabalho no seu repositório remoto; as habilidades leem o
conhecimento local primeiro e declaram quando consultam algo externo.

**Posso usar vários projetos?** Sim — o seletor no topo da lateral troca de
projeto e cria novos.

**Por que o botão "Transformar em conhecimento" está desabilitado?** Não há
nada para organizar.
Envie arquivos de uma ideia (ou solte arquivos na lista) primeiro.

**Um tema meu apareceu em "Conhecimento que ninguém cita". Ele está errado?**
Não — o documento está inteiro. A lista diz só que nenhum **outro** tema aponta
para ele, então quem lê seguindo as ligações nunca chega até lá. O conserto não é
nele: abra o tema vizinho que entrega trabalho para este e escreva ali o link.
Um projeto novo começa com todos os temas nessa lista, e ela vai esvaziando
conforme os temas passam a se citar.

**O Claude não abre no terminal.** Confira se o CLI está instalado (`claude`
no PATH) e se há um projeto configurado. O app avisa quando não consegue abrir.

**Como mudo a largura da lateral?** Arraste a divisória entre a lateral e o
editor; com a lateral larga, os arquivos mostram data e estado do histórico. Clique
duplo na divisória volta ao padrão.

**Uma aba mostrou conteúdo de outro arquivo.** O caminho no topo do documento é
quem manda: **salvar versão** grava a aba ativa, não o que está desenhado. Se os
dois discordarem, feche a aba e abra o documento de novo — e abra um issue com
os passos.

**Em que idioma o conteúdo é gerado?** No idioma que você escolheu ao criar o
projeto (pt-BR ou inglês) — a interface inteira segue essa escolha. Dá para
trocar depois na engrenagem (⚙); um projeto pode conter documentos nos dois
idiomas se você alternar. As pastas no disco (`meetings/`, `notes/`,
`attachments/`, `contexts/`) ficam sempre em português, independente do idioma —
elas são o disco, não a tela.

**O que é uma "habilidade customizada"?** Uma skill que você mesmo cria —
descrevendo o que ela deve fazer (a IA escreve) ou importando uma que você já
tem. Vira um comando de barra de verdade (`/nome-da-habilidade`) e aparece na
seção "Habilidades de IA" da lateral; roda pelo menu ⋯ ("executar habilidade…")
de uma ideia ou reunião.

**Posso apagar uma habilidade padrão (sincronizar, apresentação, artefato)?**
Não — pode editá-la, mas não excluí-la. Só habilidades customizadas (criadas
por você) podem ser excluídas.

**O que o "modo automático" realmente faz?** É o modelo de uso "Automático"
(escolhido na criação, o padrão). Com ele, o agente pode criar um tema novo
ou decidir a qual tema atribuir algo, sozinho, ao organizar.
Escolhendo qualquer outro modelo (ou desligando depois em Configurações), ele
não cria nada novo por conta própria — deixa o item em **para organizar** e avisa
que precisa da sua decisão manual. Não afeta atribuir a um tema que já
existe.

**Por que as notas de uma reunião não aparecem de cara?**
Ficam recolhidas por padrão para a lateral não crescer demais — toque na
seta ▸ ao lado da reunião para abrir. Análises, respostas e qualquer documento
gerado por uma habilidade ficam todos na pasta **notes/** da reunião.
