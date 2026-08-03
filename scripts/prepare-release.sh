#!/usr/bin/env bash
# Loro — open a release PR (ADR-0015).
#
# Bumps the app version in the three files that must stay in lockstep
# (tauri.conf.json, Cargo.toml, Cargo.lock), on a fresh `release/vX.Y.Z` branch
# off the latest origin/main, and opens a PR titled "release: vX.Y.Z". Merging
# that PR is what ships the release (release.yml builds on merge of release/*).
#
# Usage: scripts/prepare-release.sh <version>   e.g. scripts/prepare-release.sh 0.8.1
set -euo pipefail

VERSION="${1:-}"
if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "usage: scripts/prepare-release.sh <version>  (MAJOR.MINOR.PATCH, e.g. 0.8.1)" >&2
  exit 1
fi
command -v gh >/dev/null 2>&1 || { echo "GitHub CLI (gh) not found" >&2; exit 1; }
command -v cargo >/dev/null 2>&1 || { echo "cargo not found" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BRANCH="release/v${VERSION}"

if [ -n "$(git status --porcelain)" ]; then
  echo "working tree not clean — commit or stash first" >&2
  exit 1
fi

git fetch origin main --quiet
CURRENT=$(python3 -c "import json; print(json.load(open('desktop/src-tauri/tauri.conf.json'))['version'])")
if [ "$CURRENT" = "$VERSION" ]; then
  echo "version is already $VERSION — nothing to bump" >&2
  exit 1
fi
if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  echo "branch $BRANCH already exists on origin" >&2
  exit 1
fi

git checkout -q -b "$BRANCH" origin/main

# tauri.conf.json — the canonical version the release workflow reads.
python3 - "$VERSION" <<'PY'
import json, sys
p = "desktop/src-tauri/tauri.conf.json"
data = json.load(open(p))
data["version"] = sys.argv[1]
open(p, "w").write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
PY

# Cargo.toml — only the [package] version (leave dependency versions alone).
python3 - "$VERSION" <<'PY'
import re, sys
p = "desktop/src-tauri/Cargo.toml"
txt = open(p).read()
txt = re.sub(r'(?m)^(version = ")[^"]+(")', r'\g<1>%s\g<2>' % sys.argv[1], txt, count=1)
open(p, "w").write(txt)
PY

# Cargo.lock — keep the `desktop` package entry in sync.
cargo update -p desktop --manifest-path desktop/src-tauri/Cargo.toml --quiet

git add desktop/src-tauri/tauri.conf.json desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock
git commit -q -m "chore(release): bump version to ${VERSION}"
git push -q -u origin "$BRANCH"

gh pr create --base main --head "$BRANCH" \
  --title "release: v${VERSION}" \
  --body "$(printf 'Release **v%s** (bump %s → %s).\n\nMerging this PR ships the release automatically (ADR-0015): `release.yml` builds the macOS `.dmg`, publishes the GitHub Release `v%s`, and bumps the Homebrew cask.\n\n- [ ] CI green\n- [ ] Optional: GUI smoke of the changes in this release\n' "$VERSION" "$CURRENT" "$VERSION" "$VERSION")"

echo "opened release PR for v${VERSION} — review and merge to ship."
