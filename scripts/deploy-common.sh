#!/usr/bin/env bash
# Shared dev-VM deploy helpers — sourced by ollama-cloud-usage-extension and
# usage-daemon scripts/*.sh. Lives at the workspace root (not inside either
# repo) so both repos' scripts stay tiny and never duplicate host/user
# constants.
set -euo pipefail

DEV_HOST="dev-deb13-gnome-02"            # root SSH target (passwordless)
DEV_USER="daniel"                         # GNOME session user on that VM
DEV_USER_HOST="${DEV_USER}@${DEV_HOST}"   # direct daniel SSH (passwordless)
DEV_HOME="/home/${DEV_USER}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new)

# ssh as daniel directly — use for rsync targets, install.sh invocation,
# daemon start/stop/status. This is a real login session (correct
# XDG_RUNTIME_DIR/D-Bus), unlike `su - daniel -c`, which does NOT get a
# runtime dir/D-Bus session and silently no-ops `gnome-extensions enable`.
ssh_daniel() { ssh "${SSH_OPTS[@]}" "$DEV_USER_HOST" "$@"; }

# ssh as root — use ONLY for privileged ops (reboot). daniel has no
# passwordless sudo on this VM.
ssh_root() { ssh "${SSH_OPTS[@]}" "root@$DEV_HOST" "$@"; }

rsync_to_dev() {
  # $1 = local repo dir, $2 = remote dest dir (under daniel's home)
  rsync -az --delete \
    --exclude '.git/' --exclude 'node_modules/' --exclude '.claude/' \
    -e "ssh ${SSH_OPTS[*]}" \
    "$1"/ "${DEV_USER_HOST}:$2"/
}

# Poll until SSH to the VM (as daniel) is back up after a reboot. Waits for
# the host to go down first, so it can't false-positive on the pre-reboot
# host answering during the shutdown grace period.
wait_for_dev_reboot() {
  local timeout="${1:-180}" waited=0
  echo "waiting for $DEV_HOST to go down..." >&2
  while ssh_root true 2>/dev/null; do
    sleep 2; waited=$((waited+2))
    [[ $waited -ge $timeout ]] && { echo "timeout waiting for $DEV_HOST to go down" >&2; return 1; }
  done
  echo "$DEV_HOST is down, waiting for it to come back..." >&2
  waited=0
  until ssh_daniel true 2>/dev/null; do
    sleep 3; waited=$((waited+3))
    [[ $waited -ge $timeout ]] && { echo "timeout waiting for $DEV_HOST to come back up" >&2; return 1; }
  done
  echo "$DEV_HOST is back up and SSH-reachable as $DEV_USER" >&2
}
