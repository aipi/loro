// Loro — intake triage: what a file carries, checked BEFORE it enters the acervo.
//
// The acervo is VERSIONED: `contexts/` becomes a commit, a PR, and eventually a
// remote. A credential that gets through this door is a commit, and once pushed
// it has leaked — there is no taking it back. That one-way door is why the check
// belongs at the gate and not in a later review step.
//
// It also closes a real hole in the BR-8 guarantee. `acervo::is_queueable` keeps
// the raw transcript out of the fila, but it decides by FILE NAME: `reuniao.md`
// is refused while a note called `resumo.md` with the whole transcript pasted
// inside walks straight in. This module looks at the content.
//
// Posture (owner decision, 2026-08-11): only a credential BLOCKS. Everything else
// warns and the user decides — blocking on a content heuristic would turn a guess
// into censorship of the user's own material, and the project's rule is that the
// AI proposes and the user approves.
//
// BR-8 is binding ON THIS MODULE ITSELF: a finding carries the rule name, the
// line number and a count — NEVER the matched text. A leak detector that quotes
// the secret into a log or an error message has leaked it.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// Refuses the file. Only ever a credential.
    Block,
    /// Surfaced to the user, who decides.
    Warn,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub severity: Severity,
    /// Stable identifier the UI translates (`intake.secret`, `intake.cpf`, …).
    /// Never a message built from the file's content.
    pub rule: &'static str,
    /// 1-based line of the first occurrence — a coordinate, not the content.
    pub line: usize,
    /// How many lines matched. Lets the UI say "18 marcas" without quoting one.
    pub count: usize,
}

// Credential shapes. Deliberately narrow: each one is a vendor-defined prefix
// plus a length, so a prose mention of "our API key" cannot match. A broad rule
// (any 32-char hex, "Bearer …") would fire on commit hashes and documentation and
// train the user to click through the one warning that must never be routine.
fn looks_like_secret(line: &str) -> bool {
    // OpenAI-style, GitHub PAT, Slack token, Google API key, AWS access key id.
    let prefixed = [
        ("sk-", 20),
        ("ghp_", 36),
        ("gho_", 36),
        ("ghu_", 36),
        ("ghs_", 36),
        ("ghr_", 36),
        ("xoxb-", 24),
        ("xoxp-", 24),
        ("xoxa-", 24),
        ("AIza", 35),
    ];
    for (prefix, min_len) in prefixed {
        let mut rest = line;
        while let Some(i) = rest.find(prefix) {
            let tail = &rest[i + prefix.len()..];
            let token: String = tail
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .collect();
            if token.len() >= min_len {
                return true;
            }
            rest = &rest[i + prefix.len()..];
        }
    }
    // AWS access key id: AKIA + exactly 16 uppercase alphanumerics.
    if let Some(i) = line.find("AKIA") {
        let token: String = line[i + 4..]
            .chars()
            .take_while(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
            .collect();
        if token.len() >= 16 {
            return true;
        }
    }
    // PEM private key header — the only multi-word shape here, and unambiguous.
    line.contains("-----BEGIN") && line.contains("PRIVATE KEY")
}

// A Brazilian CPF, formatted. Unformatted (11 bare digits) is deliberately NOT
// matched: it collides with phone numbers, order ids and timestamps, and a
// warning that cries wolf is worse than no warning. LGPD-driven (org policy).
fn looks_like_cpf(line: &str) -> bool {
    let b = line.as_bytes();
    let d = |i: usize| b.get(i).is_some_and(u8::is_ascii_digit);
    (0..b.len().saturating_sub(13)).any(|i| {
        d(i) && d(i + 1) && d(i + 2)
            && b[i + 3] == b'.'
            && d(i + 4) && d(i + 5) && d(i + 6)
            && b[i + 7] == b'.'
            && d(i + 8) && d(i + 9) && d(i + 10)
            && b[i + 11] == b'-'
            && d(i + 12) && d(i + 13)
            // não pode haver um quarto grupo: 000.000.000-00.00 não é CPF
            && !b.get(i + 14).is_some_and(u8::is_ascii_digit)
    })
}

// A meeting transcript line as the living file writes it: `[mm:ss · fonte]`
// (meeting.rs `timed_block`). One is a quotation; many are the transcript itself.
fn looks_like_transcript_line(line: &str) -> bool {
    let t = line.trim_start();
    if !t.starts_with('[') {
        return false;
    }
    let inner = match t[1..].find(']') {
        Some(i) => &t[1..1 + i],
        None => return false,
    };
    let (tc, rest) = match inner.split_once('·') {
        Some(p) => p,
        None => return false,
    };
    if rest.trim().is_empty() {
        return false;
    }
    let tc = tc.trim();
    // mm:ss ou hh:mm:ss — só dígitos e dois-pontos, com pelo menos um separador
    tc.contains(':') && tc.chars().all(|c| c.is_ascii_digit() || c == ':')
}

/// How many transcript lines make a file "a transcript" rather than a quotation.
/// Three is the smallest count that cannot be an illustrative excerpt.
const TRANSCRIPT_MIN: usize = 3;

/// Inspect a file's text. Pure — no IO, no logging, no acervo knowledge.
pub fn scan(text: &str) -> Vec<Finding> {
    let mut out = Vec::new();
    let mut push = |severity, rule, line, count| {
        if count > 0 {
            out.push(Finding {
                severity,
                rule,
                line,
                count,
            });
        }
    };

    let mut secret = (0usize, 0usize);
    let mut cpf = (0usize, 0usize);
    let mut transcript = (0usize, 0usize);
    for (i, line) in text.lines().enumerate() {
        let n = i + 1;
        if looks_like_secret(line) {
            secret.1 += 1;
            if secret.0 == 0 {
                secret.0 = n;
            }
        }
        if looks_like_cpf(line) {
            cpf.1 += 1;
            if cpf.0 == 0 {
                cpf.0 = n;
            }
        }
        if looks_like_transcript_line(line) {
            transcript.1 += 1;
            if transcript.0 == 0 {
                transcript.0 = n;
            }
        }
    }
    push(Severity::Block, "intake.secret", secret.0, secret.1);
    push(Severity::Warn, "intake.cpf", cpf.0, cpf.1);
    if transcript.1 >= TRANSCRIPT_MIN {
        push(
            Severity::Warn,
            "intake.transcript",
            transcript.0,
            transcript.1,
        );
    }
    out
}

/// Does anything here refuse the file outright?
pub fn blocked(findings: &[Finding]) -> bool {
    findings.iter().any(|f| f.severity == Severity::Block)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(text: &str) -> Vec<&'static str> {
        scan(text).into_iter().map(|f| f.rule).collect()
    }

    // As amostras são MONTADAS em tempo de execução, nunca escritas inteiras no
    // fonte. Não é preciosismo: a primeira versão deste teste trazia a amostra do
    // Slack literal e o push protection do GitHub RECUSOU o push — o scanner dele
    // reconheceu a forma, que é exatamente o que este módulo detecta. Um detector
    // de segredo cujos testes são varridos como segredo não entra no repositório.
    fn amostra(prefixo: &str, corpo: char, n: usize) -> String {
        format!("{prefixo}{}", corpo.to_string().repeat(n))
    }

    #[test]
    fn a_credential_blocks_the_file() {
        // BR-9: o app nunca guarda segredo, e o acervo vai para o git — este é o
        // único achado que recusa o arquivo em vez de perguntar.
        let amostras = [
            format!("export TOKEN={}", amostra("ghp_", 'a', 36)),
            format!("chave: {}", amostra("sk-", 'a', 28)),
            format!("slack: {}", amostra("xoxb-", 'a', 30)),
            format!("AWS_ACCESS_KEY_ID={}", amostra("AKIA", 'A', 16)),
            "-----BEGIN RSA PRIVATE KEY-----".to_string(),
            format!("google: {}", amostra("AIza", 'a', 35)),
        ];
        for line in &amostras {
            let f = scan(line);
            assert!(
                blocked(&f),
                "não bloqueou uma credencial com prefixo conhecido: {f:?}"
            );
        }
    }

    #[test]
    fn talking_about_secrets_is_not_a_secret() {
        // O falso positivo é caro: treina o usuário a clicar "enviar assim mesmo"
        // justamente no aviso que nunca pode virar rotina.
        for line in [
            "combinamos de rotacionar a API key do GitHub toda sexta",
            "o token fica no 1Password, ninguém commita",
            "commit sk-lint falhou", // prefixo sem tamanho
            "veja o commit 9f2a1c4e8b7d6a5f4e3d2c1b0a9f8e7d", // hash, não chave
            "AKIA é o prefixo de uma chave da AWS", // menção, sem chave
        ] {
            assert!(!blocked(&scan(line)), "falso positivo: {line:?}");
        }
    }

    #[test]
    fn a_pasted_transcript_warns_but_never_blocks() {
        // O furo real da BR-8: is_queueable barra `reuniao.md` pelo NOME, então
        // a mesma transcrição colada numa nota qualquer entrava sem obstáculo.
        let colada = "# Resumo\n\n[00:02 · você] tudo certo por aí\n[00:06 · sistema] tudo\n[00:31 · você] fechado então\n";
        let f = scan(colada);
        assert_eq!(rules(colada), vec!["intake.transcript"]);
        assert!(
            !blocked(&f),
            "conteúdo do usuário nunca é recusado por heurística"
        );
        assert_eq!(f[0].count, 3);
        assert_eq!(f[0].line, 3, "aponta a primeira ocorrência");
    }

    #[test]
    fn quoting_one_line_of_a_meeting_is_not_a_transcript() {
        let citacao = "Ele resumiu assim:\n\n[00:02 · você] a gente fecha sexta\n\nE seguimos.";
        assert!(
            rules(citacao).is_empty(),
            "uma citação não é uma transcrição"
        );
    }

    #[test]
    fn cpf_warns_and_a_lookalike_does_not() {
        // LGPD (política da organização): sinaliza, nunca bloqueia.
        let com = "responsável: 123.456.789-09";
        assert_eq!(rules(com), vec!["intake.cpf"]);
        assert!(!blocked(&scan(com)));
        // versão/valor/data não são CPF
        for nao in [
            "versão 1.234.567-89 do doc",
            "R$ 123.456.789,09",
            "123.456.789-090",
        ] {
            assert!(rules(nao).is_empty(), "falso positivo de CPF: {nao:?}");
        }
    }

    #[test]
    fn a_finding_never_carries_the_content_it_found() {
        // BR-8 aplicada AO PRÓPRIO DETECTOR: um detector de vazamento que cita o
        // segredo no achado (e daí no log, no toast, no relatório) vazou o segredo.
        let text = format!("token={}\ncpf 123.456.789-09", amostra("ghp_", 'a', 36));
        let text = text.as_str();
        let serial = serde_json::to_string(&scan(text)).unwrap();
        for segredo in ["ghp_", "aaaaaaaa", "123.456", "789-09", "token="] {
            assert!(
                !serial.contains(segredo),
                "o achado carrega {segredo:?}: {serial}"
            );
        }
        // e ainda assim é útil: regra, linha e contagem
        assert!(serial.contains("intake.secret") && serial.contains("\"line\":1"));
    }

    #[test]
    fn a_clean_file_produces_nothing() {
        let ok = "# Proposta\n\nFechamos a rota com o fornecedor novo.\n";
        assert!(scan(ok).is_empty());
        assert!(!blocked(&scan(ok)));
    }
}
