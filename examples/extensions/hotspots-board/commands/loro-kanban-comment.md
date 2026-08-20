---
description: Comenta um ponto do quadro — cria um arquivo versionado em kanban/ que o time lê, revisa e responde
---

# comentar um ponto em aberto

Argumentos: `<contexto#id> <comentário>` — o primeiro token é o ponto, o resto
é o comentário da pessoa.

1. Separe `<contexto>` e `<id>` no primeiro `#`.
2. Autor: `git config user.name` (se vazio, use "alguém"). Data: hoje, ISO.
3. Escreva `kanban/<contexto>/<id>/<AAAA-MM-DD>-<slug-do-autor>.md`:

   ```markdown
   ---
   ponto: <contexto>#<id>
   autor: <autor>
   data: <AAAA-MM-DD>
   ---

   <o comentário, como a pessoa escreveu>
   ```

   Se já existir arquivo com esse nome, acrescente `-2`, `-3`… ao nome.
4. **Não faça commit nem push.** O arquivo fica como mudança pendente e aparece
   em Revisão — é assim que o time vê, discute e versiona a conversa.
5. Confirme no chat com o caminho criado e lembre que o quadro mostra a
   contagem de comentários do ponto.
