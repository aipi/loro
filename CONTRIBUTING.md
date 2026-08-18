# Contributing to Loro

Read `CLAUDE.md` and the sources of truth (brain domain `loro`, `docs/ARCHITECTURE.md`,
`docs/adr/`) first. Quality and security are premises.

## If you are an AI agent

- Read the sources of truth in precedence order (brain context > ARCHITECTURE >
  ADR > CLAUDE.md). **Do not assume premises** — ask the developer; record what is
  decided.
- Confirm the problem is real before coding. Look for duplicate work.
- Respect context boundaries (ARCHITECTURE §2); cross-context changes need an ADR
  amendment (`docs/adr/0001-baseline.md`).
- Do not open an ADR for a bug you fixed or for review feedback. If an ADR already
  describes the behaviour, amend it; otherwise the code comment and the PR carry
  the reasoning.
- Disclose authorship (model, harness, skills) and use a `Co-Authored-By` trailer.
- **Show the full diff and get human approval before submitting.**

## Before opening a PR

Follow `CLAUDE.md` §8 (plan a task). Start from a failing test (TDD). Add an ADR
only for an **architectural change or a new proposal** — a fix, a review finding
or a defect in already-mapped functionality does not get one; its reasoning goes
in the code comment and the PR description. Keep the UI in pt-BR and its layout
unchanged unless a design decision says otherwise.

## Commits & PRs

- **Conventional Commits** titles: `<type>(scope): <description>`
  (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`…).
- Branch off `main`: `feat/…`, `fix/…`, `docs/…`.
- Every commit ends with a `Co-Authored-By:` trailer when AI-assisted.

## Quality checklist

- [ ] Tests cover each touched `BR-` and edge cases; test names reference the rule.
- [ ] TDD: the test came first.
- [ ] Domain isolated from framework/IPC/FS (Clean Architecture).
- [ ] Language: code/logs/docs in English; UI in pt-BR.
- [ ] Architectural change or new proposal recorded in the ADR (`docs/adr/`) — and *only* those; a fix carries its why in the code comment and the PR.
- [ ] Security posture upheld (ADR-0001 §3): local-only, no PII/secrets in logs.
- [ ] `make test` and `make lint` green; app verified (`LORO_SELFTEST=1`).

## Releasing (ADR-0015)

Releases are driven by a **release PR** — you never edit the version files or push
a tag by hand:

```
make release VERSION=0.8.1   # opens a "release: v0.8.1" PR (bumps the 3 version files)
```

Review the PR (CI runs on it), then **merge it**. Merging a `release/*` branch
triggers `release.yml`, which runs the test gate, builds the macOS `.dmg`,
publishes the GitHub Release `v0.8.1`, and bumps the Homebrew cask. Pushing a
`v*` tag on `main` still works as a manual escape hatch.

## Commands

```
make test        # cargo test + node --test
make lint        # clippy -D warnings + node --check
make fmt         # cargo fmt
make build       # tauri build
make app         # tauri dev
make test-docker # reproducible headless test run
make release VERSION=x.y.z  # open a release PR (merge to ship)
```
