# hotspots-board — o quadro dos pontos em aberto

Uma extensão de **nível 1** (zero código): um manifesto, um documento de view e
quatro habilidades. Nada roda — a tela vem do que ela declarou, e o Loro
desenha com os próprios componentes, nos dois temas e nos dois idiomas.

## O que ela faz

Todo conhecimento deste produto carrega os seus **pontos em aberto** (os blocos
`> [!HOTSPOT]` da seção 6 de cada `context.md`). O quadro os organiza pelo
**estado de trabalho** — `aberto · em pauta · em resolução · concluído` — com
uma **busca** em vez de um despejo, e três interações que passam pelo chat e
**produzem** coisas reais:

| ação no cartão | habilidade | o que produz |
|---|---|---|
| **mover** | `loro-kanban-move` | `kanban/<tema>/<id>/ponto.md` versionado com o estado e o porquê; **concluir também rascunha a edição do conhecimento**, que aguarda em Revisão |
| **comentar** | `loro-kanban-comment` | um arquivo versionado por comentário, que o time lê e revisa como qualquer mudança |
| **perguntar** | `loro-kanban-ask` | resposta no chat, lendo o documento do tema e os comentários — só leitura |
| **Gerar pauta** (topo) | `loro-kanban-pauta` | `brainstorming/pauta-<data>/pauta.md` a partir dos pontos EM PAUTA — material do projeto, entra pela fila como tudo |

O estado de cada ponto mora num **documento** (`ponto.md`, front-matter
`status:`), não num banco da extensão — versionado, revisável, aberto por
qualquer pessoa, legível sem o Loro. Nada se arrasta: mover passa pelo chat e
deixa rastro. Um `status:` fora dos quatro volta a valer `aberto` — o quadro
nunca esconde um cartão.

## Instalar

Configurações → Extensões → *instalar de uma pasta* → aponte para esta pasta.
Os arquivos entram como **mudança pendente** (nada é commitado): o time revisa
a extensão em Revisão como revisa conhecimento.

## Os ajustes — até onde vai

Esta extensão declara os quatro abaixo; o schema aceita também `number`,
`enum`, `path` e `host` (BR-9: não existe kind de segredo — um schema que
declara um é recusado na instalação, por nome).

| ajuste | kind | escopo | efeito |
|---|---|---|---|
| `rotulo` | string | **projeto** (versionado, viaja com o time) | o título do quadro |
| `filtro` | string | **máquina** (só neste computador) | a busca — também editável no próprio quadro, Enter aplica |
| `mostrar_comentarios` | bool | projeto | a contagem 💬 nos cartões |
| `dica_de_uso` | bool | máquina | a frase explicativa sob o título |

Os campos do quadro e a folha de Configurações → Extensões → ⋯ → ajustes
escrevem no MESMO lugar (`ext_settings_set` mescla por escopo), então as duas
telas nunca dizem valores diferentes.

## O que este exemplo prova

- o contrato de primitivas aguenta um kanban real (colunas `w-md` + rolagem
  própria + `where` composto `status` E `busca`) — o caso que quebrou a
  primeira versão do contrato, medido: 79 colunas de 12px;
- `layout: "wide"`: a tela larga é da COLUNA de conteúdo, nunca da janela;
- o botão `ask` abre a porta do chat e ela é da pessoa: modal, palavras
  próprias, o modo de permissão de sempre — a extensão só escolheu a
  habilidade e o alvo;
- fatos, nunca arquivos: a extensão não lê markdown nenhum — `status` e
  `comentarios` chegam derivados pelo Loro (nomes de arquivo + a linha
  `status:` de `ponto.md`, e nada mais).
