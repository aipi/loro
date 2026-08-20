---
description: Move um ponto do quadro para outro estado (em-pauta, em-resolucao, concluido) — grava o estado como documento versionado; concluir também rascunha a edição do conhecimento
---

# mover um ponto do quadro

Argumentos: `<contexto#id> <novo-estado> [por quê]` — estados válidos:
`aberto`, `em-pauta`, `em-resolucao`, `concluido`. Qualquer outro valor: pare e
diga quais são os quatro, sem escrever nada.

1. Separe `<contexto>` e `<id>` no primeiro `#`. Confirme que o bloco
   `> [!HOTSPOT] <id>` existe em `contexts/<contexto>/context.md`; se não
   existir, diga isso e pare.
2. Escreva (criando ou reescrevendo) `kanban/<contexto>/<id>/ponto.md`:

   ```markdown
   ---
   ponto: <contexto>#<id>
   status: <novo-estado>
   desde: <AAAA-MM-DD>
   por: <git config user.name>
   ---

   <o "por quê", se a pessoa deu um. Mantenha abaixo o histórico anterior do
   arquivo, se havia um — um movimento não apaga a trilha dos anteriores.>
   ```

3. **Se o novo estado é `concluido`, produza a segunda metade** — o motivo de
   esta habilidade existir: rascunhe a edição do conhecimento que fecha o
   ponto. No `contexts/<contexto>/context.md`, transforme o bloco
   `> [!HOTSPOT] <id>` no registro do que foi decidido (ou remova-o, se os
   comentários em `kanban/<contexto>/<id>/` dizem claramente o desfecho —
   cite-os). Deixe a edição como **mudança pendente**: ela aparece em Revisão
   e o time aprova como qualquer conhecimento. Um ponto concluído cujo
   documento ainda o lista como aberto é o quadro mentindo.
4. **Não faça commit nem push**, nunca.
5. Confirme no chat: o estado novo, o arquivo escrito e — se concluiu — que a
   edição do conhecimento está aguardando em Revisão.
