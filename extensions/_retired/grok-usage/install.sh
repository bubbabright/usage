#!/usr/bin/env bash
# Installs the Grok Usage GNOME Shell extension for the current user.
#
# Copies this repo's runtime files into
# ~/.local/share/gnome-shell/extensions/<uuid>, compiles the GSettings
# schema, and enables the extension. Safe to re-run (idempotent) — e.g.
# after `git pull` to pick up an update.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="$(sed -n 's/.*"uuid": *"\(.*\)".*/\1/p' "$REPO/metadata.json" | head -1)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      echo "usage: $0 [--dry-run]"
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "+ $*"
  else
    "$@"
  fi
}

# Guard: keys must exist in schema before we ship anything.
"$REPO/verify-keys.sh"

echo "Installing $UUID → $DEST"

run mkdir -p "$DEST/schemas" "$DEST/images" "$DEST/report"
run cp "$REPO/extension.js" "$DEST/extension.js"
run cp "$REPO/prefs.js" "$DEST/prefs.js"
run cp "$REPO/stylesheet.css" "$DEST/stylesheet.css"
run cp "$REPO/metadata.json" "$DEST/metadata.json"
run cp "$REPO/schemas/org.gnome.shell.extensions.grok-usage.gschema.xml" \
  "$DEST/schemas/org.gnome.shell.extensions.grok-usage.gschema.xml"
run cp -a "$REPO/images/." "$DEST/images/"
run cp "$REPO/report/usage-report.template.html" "$DEST/report/usage-report.template.html"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "+ glib-compile-schemas $DEST/schemas"
  echo "+ gnome-extensions disable $UUID"
  echo "+ gnome-extensions enable $UUID"
  exit 0
fi

glib-compile-schemas "$DEST/schemas"

if command -v gnome-extensions >/dev/null 2>&1; then
  # Reload if already known; enable otherwise
  gnome-extensions disable "$UUID" 2>/dev/null || true
  gnome-extensions enable "$UUID" 2>/dev/null || true
fi

cat <<EOF

Installed: $UUID

If State is not ACTIVE yet (first install on this session):
  Wayland: log out and back in
  Then: gnome-extensions enable $UUID

Reload after edits (already enabled):
  gnome-extensions disable $UUID && gnome-extensions enable $UUID

Prefs:  gnome-extensions prefs $UUID
History: ~/.cache/grok-usage/history.jsonl
Auth:    ~/.grok/auth.json
EOF
