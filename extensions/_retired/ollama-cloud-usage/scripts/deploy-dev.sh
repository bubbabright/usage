#!/usr/bin/env bash
# Sync this repo to the dev VM and (re)install the extension there via the
# repo's own install.sh — run as daniel directly (NOT su -c: su does not get
# an XDG_RUNTIME_DIR/D-Bus session, so `gnome-extensions enable` silently
# no-ops under it). Default: install + force full reboot (extension-reload
# mechanism for this disposable VM).
#
# Usage: scripts/deploy-dev.sh [--no-reboot] [--dry-run]
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO/../scripts/deploy-common.sh"

REMOTE_DIR="$DEV_HOME/dev/ollama-cloud-usage-extension"
REBOOT=1
DRY_RUN=()
for arg in "$@"; do
  case "$arg" in
    --no-reboot) REBOOT=0 ;;
    --dry-run) DRY_RUN=(--dry-run) ;;
    -h|--help) echo "usage: $0 [--no-reboot] [--dry-run]"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done

echo "==> rsyncing $REPO -> ${DEV_USER_HOST}:${REMOTE_DIR}"
ssh_daniel "mkdir -p '$REMOTE_DIR'"
rsync_to_dev "$REPO" "$REMOTE_DIR"

echo "==> running install.sh remotely as $DEV_USER"
# install.sh runs verify-keys.sh first and aborts (set -e, non-zero exit)
# on schema drift — that non-zero exit propagates through ssh's exit code,
# so this script aborts too, before anything reboots.
ssh_daniel "cd '$REMOTE_DIR' && ./install.sh ${DRY_RUN[*]}"

if [[ "$REBOOT" -eq 1 && -z "${DRY_RUN[*]:-}" ]]; then
  echo "==> forcing full reboot of $DEV_HOST (extension-reload mechanism for this VM)"
  ssh_root reboot || true   # connection drops before ssh gets a clean exit; expected
  wait_for_dev_reboot
  echo "==> reboot complete; extension should be live in daniel's new session"
else
  echo "==> skipping reboot (--no-reboot or --dry-run); extension installed but shell not reloaded"
fi
