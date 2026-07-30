<!--
Read CONTRIBUTING.md and CLAUDE.md §8 first. Title must follow Conventional
Commits: <type>(scope): <description>. Branch off main (feat/…, fix/…, docs/…).
-->

## Summary

<!-- What does this PR change and why? Link the problem it solves. -->

## Source of truth

<!-- What does this trace back to? Link the brain domain rule / ARCHITECTURE
     section / ADR. Add or amend an ADR for any non-trivial decision. -->

- Traces to:
- ADR added/amended:

## How to test

<!-- Steps for a reviewer to verify the change. -->

## Checklist

- [ ] Follows `CLAUDE.md` §8; TDD — the test came first.
- [ ] Tests cover each touched `BR-` and edge cases; test names reference the rule.
- [ ] Domain isolated from framework/IPC/FS (Clean Architecture).
- [ ] Language: code/logs/docs in English; UI in pt-BR, layout unchanged (unless a design decision says otherwise).
- [ ] Non-trivial decision recorded in the ADR (`docs/adr/`).
- [ ] Security posture upheld (ADR-0001 §3): local-only; no PII/transcript/secrets in logs (BR-1/BR-8/BR-9).
- [ ] Docs sweep (ADR-0002 §7): manual, ADR, `README.md`, `docs/ARCHITECTURE.md` updated as needed.
- [ ] `make test` and `make lint` green; app verified (`LORO_SELFTEST=1`).

## AI authorship

<!-- If AI-assisted, disclose model/harness/skills and use a Co-Authored-By trailer. -->

- [ ] AI-assisted — authorship disclosed and `Co-Authored-By:` trailer present.
