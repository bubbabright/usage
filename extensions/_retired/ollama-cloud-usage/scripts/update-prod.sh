#!/usr/bin/env bash
# "Pull latest + reinstall" for THIS machine (hyperion). Run after pushing
# changes from the dev VM to GitHub. Local-only, no SSH.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "update-prod: working tree has local changes — refusing to pull. Stash/commit first." >&2
  git status --short >&2
  exit 1
fi
echo "==> git pull ($branch)"
git pull --ff-only origin "$branch"

echo "==> reinstall"
./install.sh
echo "==> done. Log out/in (Wayland) or Alt+F2 r (X11) to load the new build."
