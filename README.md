# usage

Personal + small-team stack for subscription quota I already pay for. One optional daemon
as source of truth; thin clients render it.

**Shape:** daemon plugins fetch/parse each provider and publish one shape — `windows[]`
meters (pct, color, reset, will_deplete). Clients (web dashboard, GNOME panel, later MCP)
just render it. Add a provider on the daemon → every client lights up.

## Active

| Project | What | Status |
|---|---|---|
| [usage-daemon/](usage-daemon/) ([gh](https://github.com/bubbabright/usage-daemon)) | Node/JS hub. Plugins + `/usage/*` API. MCP planned. | **Running** (systemd user service, port 8787) |
| [usage-web-ui/](usage-web-ui/) | React/Vite dashboard. Reads the daemon. | **Running** (systemd user service, port 5173) |
| [extensions/_retired/multi-provider-usage-gnome-extension/](extensions/_retired/multi-provider-usage-gnome-extension/) | One GNOME panel for every daemon provider. Zero-touch. | Intended survivor; parked in `_retired`. |

Everything else is retired — see [extensions/_retired/](extensions/_retired/) (per-provider
Claude/Grok/Ollama/Firecrawl/Mistral/etc. exts).

## Design notes

- GNOME Shell 46-49. Okabe-Ito palette, dark/light aware.
- History: daemon JSONL under `~/.local/state/usage-daemon/<provider>/history.jsonl`.
  Aggregate SQLite planned.
- Least-squares burn-rate / `will_deplete`.
- Last-known on failure — never blank the panel.
- Never auto-spend quota to refresh a token. Daemon reads OAuth files read-only.

## Deployment (hyperion / 192.168.1.196)

- **Daemon:** `systemctl --user status usage-daemon` — `Restart=always`, `loginctl enable-linger daniel`
- **Web UI:** `systemctl --user status usage-web-ui` — `Restart=always`, Vite dev server on `:5173`
- **Caddy (192.168.1.10):** Proxies `usage.hoboguppy.com` → `:5173`, `/usage/*` → daemon `:8787`
- Both services survive reboot without login.

## Docs

- `usage-daemon/README.md` — HTTP contract, install
- `AGENTS.md` — repo notes

(End of file - total 33 lines)