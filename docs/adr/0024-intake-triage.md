# ADR-0024 — Intake triage: what a file carries, checked at the door

- Status: accepted
- Date: 2026-08-11
- Owner decision: 2026-08-11 ("gerar o doctor em cima dos arquivos que serão
  inseridos no acervo")
- Extends: ADR-0014 (the fila receives real files), BR-8, BR-9

## Context

The acervo is **versioned**: `contextos/` becomes a commit, a PR, and eventually
a remote (ADR-0001 §5). That makes the queue a **one-way door** — a credential
that gets through becomes a commit, and once pushed it has leaked. Nothing later
in the flow can take it back.

Until now there was exactly one gate: `acervo::is_queueable`, which upholds BR-8
by keeping the raw transcript, the audio and the audit out of the fila. It
decides **by file name**. So `reuniao.md` is refused while a note called
`resumo.md` with the whole transcript pasted inside walks straight in. The
guarantee was structural, not actual.

Four other doors had no gate at all: `brain_import_files` (files from the
computer), `/loro-sync` (Drive, Slack, Jira, Confluence), the AI-written notes,
and the quick note.

## Decision

A new module `src-tauri/src/intake.rs` inspects a file's **content** before it
enters, and a read-only command `brain_triage_files` reports what it found so the
UI can show it before anything moves.

### What it looks for

| Rule | Severity | Why |
|---|---|---|
| `intake.secret` — vendor-prefixed credentials (`sk-`, `ghp_`/`gho_`/…, `xoxb-`, `AIza`, `AKIA…`, PEM private key header) | **block** | BR-9. The one-way door above |
| `intake.cpf` — a formatted Brazilian CPF | warn | LGPD (organisation policy) |
| `intake.transcript` — 3+ `[mm:ss · fonte]` lines | warn | Closes the BR-8 hole: the same transcript, pasted into any other file |

### Only a credential blocks

Everything else warns and the user decides. Blocking on a content heuristic
would turn a guess into censorship of the user's own material, and the project's
rule is that the AI proposes and the user approves. The credential rule is the
exception because its cost is asymmetric and irreversible.

### The rules are deliberately narrow

Each credential shape is a vendor-defined prefix **plus a length**, so prose
("rotacionar a API key toda sexta") cannot match, and a 40-char commit hash is
not a token. A broad rule — any long hex string, any `Bearer …` — would fire on
documentation and train the user to click through the one warning that must never
become routine. The CPF rule matches only the **formatted** form for the same
reason: bare 11-digit runs collide with phone numbers, order ids and timestamps.

### BR-8 binds the detector itself

A finding carries `{severity, rule, line, count}` — the rule name, a coordinate
and a tally. **Never the matched text.** A leak detector that quotes the secret
into a finding has put it in the log, the toast and the report. A test serialises
the findings and asserts none of the input's sensitive substrings survive.

### The block is re-checked in the backend

`brain_send_files_to_queue` re-runs the blocking check on the content it is about
to write, independently of whatever the UI did. A gate that trusts the frontend
to have asked is not a gate — and the frontend is not the only caller of the
future.

## Consequences

- New IPC: `brain_triage_files(rels) -> [{rel, findings[]}]` (read-only; expands
  a meeting to its `notas/*` through the same single owner as the send path).
- `err.intake_secret:<file>` names the file and the rule, never the finding.
- The triage runs on the fila's two entry points. The other three doors
  (`brain_import_files`, `/loro-sync`, AI-written notes) are **not covered yet** —
  stated here rather than implied, because a partial gate that reads as complete
  is worse than an obviously partial one.
- `acervo::guarded_existing` became `pub(crate)` so the triage reuses the
  existing path guard instead of growing a second one.
- Non-text files are skipped, not guessed at.

### The tests cannot contain a token-shaped literal

The first version of the credential test wrote its samples out in full, and
**GitHub's push protection refused the push** — its scanner recognised the shape,
which is precisely what this module detects. The samples are now composed at
runtime (`amostra(prefix, char, n)`), so no token-shaped literal exists in the
source. A secret detector whose own tests are swept up as secrets cannot enter
the repository — and the block was, in its way, an independent confirmation that
the patterns match what real scanners look for.

## Explicitly NOT done

- **Duplicate detection** (the same content already in the acervo) and **weight**
  (a file that will dominate ADR-0004's reading layer) were scoped out with the
  owner: both need a full acervo walk per send, and neither is a one-way door.
- **Contradiction with a recorded decision** needs judgment, not a rule. It stays
  with the `/loro-context` loop, which already reads `context.md` while
  distilling. A deterministic gate must not promise it.
