# usage

Live plan headroom across messy AI providers. Not a monorepo — a folder of
independent repos under `bubbabright`, plus handoffs.

## Architecture

Daemon + thin clients. Daemon is the hub — plugins fetch/parse each provider and
publish one shape (`windows[]`). Add a plugin there → every thin client lights up.
Per-provider standalone GNOME extensions (own engine, no daemon) are retired.

## Directories

| Dir | What |
|-----|------|
| `usage-daemon/` | Central poller + Express API + React SPA. The hub. Active. |
| `usage-web-ui/` | Standalone React/Vite dashboard (proxies to daemon). Active. |
| `extensions/_retired/` | Retired GNOME Shell extensions (claude, grok, ollama-cloud, firecrawl, groq, mistral, opencode-go, openrouter, cloudflare, multi-provider). `multi-provider-usage-gnome-extension/` in here is the intended survivor, parked pending revival. |
| `scripts/` | Deploy helpers |

## Dev workflow

```bash
# daemon (primary)
cd usage-daemon && npm start

# web UI dev server (separate process)
cd usage-web-ui && npm dev
# proxies /usage/* to daemon at 127.0.0.1:8787

# tests
cd usage-daemon && npm test
```

## Running the daemon (hyperion) — fixed 2026-08-18

The daemon runs under a `--user` systemd unit with `Restart=always`, installed at
`~/.config/systemd/user/usage-daemon.service` from `usage-daemon/usage-daemon.service`.
`systemctl --user status usage-daemon` now tells the truth.

```bash
systemctl --user restart usage-daemon
journalctl --user -u usage-daemon -n 50 --no-pager
tail -f ~/.local/state/usage-daemon/daemon.log
```

Never start a second daemon by hand (`nohup node src/index.js ...`) — that form was the
old workaround, and it had no supervisor, died silently with its process group, and
truncated its own log on every start. Exactly one: `ss -tlnp | grep 8787`.

Historically (2026-07-27 → 2026-08-18) no unit was installed at all; the stale `/etc`
one pointed at a dead `usage-daemon-modern` subpath, so the live process was always an
unsupervised ad-hoc `node src/index.js`. That is why older docs say to ignore systemctl.

## Key design

- Daemon is **optional** — standalones work without it.
- `windows[]` shape is the contract between daemon and clients.
- Daemon never returns secrets (cookie/oauth tokens).
- Every provider plugin is compiled-in via `registry.js`.
- `will_deplete` projected from least-squares on history — purely local.
