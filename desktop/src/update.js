// Loro — o que a tela DIZ sobre haver uma versão nova (ADR-0032).
//
// Módulo isolado e testável: recebe o status que o backend calculou e devolve
// texto. Nenhuma decisão de versão mora aqui — "é mais nova?" é do backend, que
// compara número a número; repetir a comparação em JS seria uma segunda verdade
// sobre o mesmo fato.
//
// pt-BR é a língua-fonte: a string daqui É o msgid (DESIGN.md §4), e `t` é
// injetado para o teste rodar nos dois idiomas.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoroUpdate = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const id = (s) => s;

  function fill(s, v) {
    return String(s).replace("{v}", v);
  }

  // A marca do cabeçalho. Sem atualização ela é a etiqueta que já existia — a
  // versão instalada e a promessa de que tudo roda local. Com atualização ela
  // vira controle: diz QUAL versão existe e que dá para clicar.
  function headTag(st, t) {
    t = t || id;
    const cur = "v" + ((st && st.current) || "");
    if (!st || !st.available) {
      return { text: cur, mark: false, title: t("tudo roda 100% no seu computador") };
    }
    return {
      text: fill(t("v{v} disponível"), st.latest),
      mark: true,
      title: fill(t("há uma versão nova ({v}) — clique para ver como atualizar"), "v" + st.latest),
    };
  }

  // A frase de estado em Configurações. Três estados, não dois: "não olhei"
  // NUNCA pode ser dito como "você está atualizado" — o app só afirma o que
  // mediu (CLAUDE.md §7.1).
  function statusLine(st, t) {
    t = t || id;
    if (!st) return t("não deu para verificar agora");
    if (st.available) return fill(t("há uma versão nova: v{v}"), st.latest);
    if (st.checked || st.lastCheck) return t("você está na última versão");
    return t("ainda não verificado");
  }

  // Como atualizar, PELA ROTA QUE INSTALOU. Quem veio do cask recebe o comando
  // do cask; quem arrastou o .dmg recebe o .dmg. Oferecer `brew upgrade` a quem
  // não instalou por brew é mandar o usuário colher "Cask 'loro' is not
  // installed" no terminal dele.
  function howTo(st, t) {
    t = t || id;
    if (st && st.route === "brew") {
      return {
        text: t("você instalou pelo Homebrew — atualize com este comando no seu terminal:"),
        command: (st && st.command) || "brew upgrade --cask loro",
      };
    }
    return {
      text: t("baixe o .dmg da página da versão e arraste o Loro para a pasta Aplicativos, por cima do antigo."),
      command: "",
    };
  }

  // O carimbo da última consulta. Data local, e um travessão quando nunca houve
  // consulta — nunca uma data inventada a partir do epoch 0 ("31/12/1969").
  function lastCheckLabel(st, t, now) {
    t = t || id;
    const secs = (st && st.lastCheck) || 0;
    if (!secs) return t("nunca verificado");
    const d = new Date(secs * 1000);
    return fill(t("verificado em {v}"), d.toLocaleString());
  }

  return { headTag, statusLine, howTo, lastCheckLabel };
});
