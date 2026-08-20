---
description: Pergunta sobre um ponto em aberto do quadro — lê o documento do tema e os comentários do kanban e responde no chat, sem editar nada
---

# perguntar sobre um ponto em aberto

Argumentos: `<contexto#id> <pergunta>` — o primeiro token é o ponto (ex.:
`frota/eletrica#H-3`), o resto é a pergunta da pessoa.

1. Separe `<contexto>` e `<id>` no primeiro `#`. Abra
   `contexts/<contexto>/context.md` (ou `contextos/…` no layout antigo) e
   localize o bloco `> [!HOTSPOT] <id>` — ele é o enunciado do ponto.
2. Se existir a pasta `kanban/<contexto>/<id>/`, leia:
   - `ponto.md` — o estado atual do ponto e desde quando;
   - os demais `*.md` — os comentários do time, cada um com autor e data.
3. Responda no chat, citando o documento do tema e o que o time já disse.
   Se os comentários contradizem o documento, diga isso — é exatamente o que
   a pessoa precisa saber.
4. **Não edite arquivo nenhum.** Esta habilidade só lê.
