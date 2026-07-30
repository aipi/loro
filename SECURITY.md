# Security Policy

Loro is a **local, privacy-first** desktop app. Security and privacy are
premises, not options (`docs/adr/0001-baseline.md` §3). This policy explains
how to report a vulnerability and what our threat model considers in scope.

## Supported versions

Loro is in active pre-1.0 development. Only the latest released version and the
`main` branch receive security fixes.

| Version | Supported |
|---|---|
| latest release / `main` | ✅ |
| older releases | ❌ |

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Please report privately using GitHub's
[**Private vulnerability reporting**](https://github.com/aipi/loro/security/advisories/new)
(Security → Advisories → *Report a vulnerability*). This keeps the details
confidential until a fix is available.

When reporting, please include:

- A description of the vulnerability and its impact.
- Steps to reproduce (a minimal proof of concept is ideal).
- Affected version / commit and platform (macOS version, etc.).

Please **do not** include real personal data, transcripts, credentials, tokens,
or secrets in your report. Redact or use synthetic data — a redacted reproduction
is enough.

### What to expect

- **Acknowledgement**: within 5 business days.
- **Assessment**: we will confirm the issue and its severity, and keep you
  updated on progress.
- **Fix & disclosure**: we aim to ship a fix and publish an advisory
  coordinately. We are happy to credit you (or keep you anonymous, your choice).

## Scope & threat model

Loro's core security guarantees are the business rules `BR-1`, `BR-8` and `BR-9`
(see the brain domain `loro` and `docs/adr/0001-baseline.md` §3):

- **BR-1 — inference is 100% local by default.** Raw audio never leaves the
  machine. Anything external (optional AI-agent skills) runs only on the user's
  explicit invocation, through their own agent CLI and account.
- **BR-8 — logs are content-free.** No transcript text, no PII, no secrets in
  logs.
- **BR-9 — no credential is ever requested, stored, or logged.** `git`, `gh`,
  and the agent CLI use the user's own ambient credentials.

**In scope** — issues that break one of the above, for example:

- Transcript audio or text leaving the device without explicit user action.
- PII, transcript content, or secrets written to logs.
- The app requesting, storing, or logging a credential.
- Local privilege escalation, path traversal, or code execution via crafted
  input, files dropped into an acervo, or IPC.
- Tampering with the first-run model download integrity check (SHA-256
  verification, ADR-0006).

**Out of scope** — typically not accepted:

- Vulnerabilities in third-party dependencies with no exploitable impact in
  Loro (report those upstream; tell us if Loro's usage makes them exploitable).
- Issues that require a pre-compromised machine or a malicious OS-level actor.
- Social engineering of maintainers or users.
- Behavior of the user's own external tools (`claude`, `gh`, `git`, cloud
  connectors) when explicitly invoked by the user.

## Handling of data in reports

Security reports are treated as confidential. Following the project's own rules,
we will not reproduce personal data from a report beyond what is strictly needed
to fix the issue, and we minimize/anonymize wherever possible.
