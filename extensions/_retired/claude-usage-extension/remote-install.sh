#!/usr/bin/env bash
# One-liner installer for machines without a local checkout:
#   curl -fsSL https://raw.githubusercontent.com/bubbabright/claude-usage-extension/main/remote-install.sh | bash
#
# Clones the repo to a temp dir, runs install.sh from it, cleans up. Accepts
# the same flags as install.sh (e.g. --dry-run) plus --ref <branch|tag> to
# install something other than main.
set -euo pipefail

REPO_URL="https://github.com/bubbabright/claude-usage-extension.git"
REF="main"
ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git clone --depth 1 --branch "$REF" "$REPO_URL" "$TMP/repo"
"$TMP/repo/install.sh" "${ARGS[@]}"
