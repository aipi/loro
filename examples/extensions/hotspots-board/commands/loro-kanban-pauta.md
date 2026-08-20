---
description: Gera a pauta da próxima reunião a partir dos pontos EM PAUTA do quadro — grava como material do projeto, de onde entra pela fila como tudo
---

# gerar a pauta da reunião

Argumentos: `[acréscimos]` — opcional, itens que a pessoa quer na pauta além
dos pontos do quadro.

1. Varra `kanban/*/*/ponto.md` (e níveis mais fundos: o contexto pode ser
   aninhado). Colete todo ponto com `status: em-pauta`.
2. Para cada um, abra o bloco `> [!HOTSPOT] <id>` no documento do tema e o
   último comentário da pasta, se houver — a pauta diz O QUE decidir e o que
   já foi dito, em uma ou duas linhas por ponto.
3. Escreva `brainstorming/pauta-<AAAA-MM-DD>/pauta.md` (crie a pasta):
   título, data, um item por ponto com o link do tema
   (`contexts/<contexto>/context.md`), e os acréscimos da pessoa no fim.
   É o mundo NÃO versionado de propósito: uma pauta é material de trabalho e
   entra pela fila quando merecer virar conhecimento — como tudo aqui.
4. Se nenhum ponto está em pauta, diga isso e não crie arquivo — uma pauta
   vazia é pior que nenhuma.
5. Confirme no chat com o caminho e a contagem de itens.
