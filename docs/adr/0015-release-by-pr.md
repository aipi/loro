# ADR-0015 — Release by PR (merge a `release/*` branch = ship)

- **Status:** accepted (owner decision, 2026-08-03)
- **Context:** shipping a version was three manual, error-prone steps: edit the
  version in the three files that must agree (`tauri.conf.json`, `Cargo.toml`,
  `Cargo.lock`), commit that to `main`, then create and push a `v*` tag. The tag
  push triggered `release.yml`. The owner asked to make this "more automated,
  starting from a release PR": open a PR, review it, and have merging it ship the
  release — no hand-edited files, no manual tag.

## Decision

### §1 A release is a PR whose merge ships

`make release VERSION=x.y.z` (→ `scripts/prepare-release.sh`) opens the release:
it branches `release/vX.Y.Z` off the latest `origin/main`, bumps the three
version files in lockstep, commits `chore(release): bump version to X.Y.Z`, and
opens a PR titled `release: vX.Y.Z`. The human reviews it (CI runs on the PR like
any other) and merges it. Nothing else is done by hand.

### §2 One builder, two triggers

`release.yml` now triggers on **either** a merged `release/*` PR **or** a pushed
`v*` tag (the manual escape hatch). A job-level `if` guards the PR path so it runs
only when a `release/*` branch was actually merged — ordinary PRs never ship. The
job:

- checks out the commit that carries the bump (`merge_commit_sha` on the PR path,
  the tagged commit on the tag path);
- resolves the version from `tauri.conf.json` (the single source), and on the tag
  path enforces `tag == version` (no git/app drift, loro-release-checklist §1);
- refuses to re-release an existing `vX.Y.Z` (guards a stale PR or a rerun);
- runs the test/clippy/fmt gate, builds the `.dmg`, and `gh release create`s the
  release — which **creates the tag** `vX.Y.Z` on the target commit when absent,
  so no separate tag push (and no PAT) is needed;
- bumps the Homebrew cask in the tap (unchanged; still gated on `TAP_TOKEN`).

### §3 Why not a bot-driven PR (release-please) or a dispatch button

Considered and declined for now: `workflow_dispatch` (no review step) and
release-please (adds an external action and pins the whole flow to conventional
commits). The release-PR model keeps the existing review + branch-protection
gate, needs no new secret, and reuses the proven tag-driven builder. It can be
revisited if commit-driven changelogs become desirable.

## Consequences

- **`.github/workflows/release.yml`:** added the `pull_request: [closed]` trigger
  + guard, a "resolve version and tag" step, conditional checkout, the
  already-exists guard, and `gh release create --target` (creates the tag). The
  tag-push path is preserved.
- **`scripts/prepare-release.sh`** (new) + **`make release VERSION=…`**: open the
  release PR; validates semver, clean tree, no duplicate branch/version.
- **Docs:** `CONTRIBUTING.md` "Releasing" section; this ADR; `CLAUDE.md` index.
- **BRs:** none touched (release plumbing only). Security posture unchanged: the
  core release uses `GITHUB_TOKEN`; only the optional cask bump uses `TAP_TOKEN`.
- **Note:** a tag/release created by `GITHUB_TOKEN` does not re-trigger workflows,
  so there is no build loop between the PR path and the tag path.
