#!/usr/bin/env bash
# Combined "deploy everything to the dev VM" flow:
#   1. sync + restart daemon (fast feedback for the daemon itself)
#   2. sync + install extension (verify-keys guarded)
#   3. reboot the VM (the extension's reload mechanism here)
#   4. wait for SSH to come back
#   5. relaunch the daemon again (reboot killed step 1's process — no
#      systemd/autostart exists yet by design)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USAGE_ROOT="$(dirname "$HERE")"
source "$HERE/deploy-common.sh"

echo "### 1/5 daemon: sync + restart (pre-reboot)"
"$USAGE_ROOT/usage-daemon/scripts/deploy-dev.sh"

echo "### 2/5 extension: sync + install (no reboot yet)"
"$USAGE_ROOT/ollama-cloud-usage-extension/scripts/deploy-dev.sh" --no-reboot

echo "### 3/5 rebooting $DEV_HOST"
ssh_root reboot || true

echo "### 4/5 waiting for $DEV_HOST to come back"
wait_for_dev_reboot

echo "### 5/5 daemon: relaunch (reboot killed the pre-reboot instance)"
ssh_daniel "'$DEV_HOME/dev/usage-daemon/scripts/restart-daemon.sh'"

echo "### done — extension reloaded via reboot, daemon running post-reboot"
