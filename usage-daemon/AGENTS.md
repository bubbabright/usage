# usage-daemon

Node/Express hub: polls per-provider AI-subscription quota APIs, normalizes each to
one `windows[]` shape, serves it over HTTP. Independent git repo — parent
`/mnt/nas/projects/usage/` is a folder of repos, not a monorepo. See its `../AGENTS.md`
for the wider picture (web UI, retired GNOME extensions).

## Architecture

- `src/index.js` — entrypoint. Loads config, registers 11 compiled-in provider plugins
  (`registry.js`), starts `Runner`, mounts Express (`/usage/*` + `/metrics`), listens
  `0.0.0.0:<port>` (default 8787).
- `src/runner.js` — scheduler. Self-rescheduling `setTimeout` chain per provider (not
  fixed `setInterval`): `nextDelay(status, failures, retryAfter, base)` picks the next
  poll time — `ok` → base interval, `429 Retry-After` → honored floor, `auth_expired` →
  ~30min recheck, other errors → exponential backoff (×2/failure, capped 1h, jittered).
  30s hard fetch timeout. Never blanks a snapshot on failure — keeps last-known
  `windows`, sets `stale:true`.
- `src/providers/*.js` — one file per plugin: `ollama`, `claude`, `grok`, `mistral`,
  `opencode-go`, `openrouter`, `cloudflare`, `deepgram`, `groq`,
  `firecrawl`, `serpapi`. Each exports `createProvider()` with `config()`/`configure()`/
  `intervalSeconds()`/`fetch()`/pure `parse(raw)`.
- `src/http.js` — the `/usage/*` router; doc-comment at top of file lists every route,
  keep it in sync with the router when adding one.
- `src/store.js` — per-provider append-only JSONL history, `~/.local/state/usage-daemon/
  <provider>/history.jsonl`, trimmed ~20k lines. No database. `migrateLegacyHistory()`
  runs once per provider per process (marker file `.legacy-migrated`): if an old
  cwd-relative `history.jsonl` exists that the current XDG path doesn't know about, it
  gets merged in (dedup by `t`) instead of silently orphaned — this actually happened
  once (2026-08-01, ~20 days of history per provider stranded on a path-config restart,
  recovered by hand) before this safety net existed.
- `src/log.js` — the logger. Timestamped, level-tagged, key=value context, size-rotated,
  written with `appendFileSync` (the only kind of write that survives an `exit`/
  `uncaughtException` handler). Also installs the process-level handlers that log
  every exit path: uncaught exception, unhandled rejection, each signal BY NAME,
  `process.exit()` from anywhere, and event-loop drain. Default file
  `~/.local/state/usage-daemon/daemon.log` (never `/tmp` — a reboot wipes it);
  `[logging]` in config.toml or `USAGE_LOG_*` env vars override. Never redirect a
  shell `>` into the same file — that is what used to truncate away every previous
  run's crash evidence.
- `src/cookiejar.js` — reads a session cookie out of Firefox's `cookies.sqlite` so the
  cookie-auth plugins (`ollama`, `mistral`, `opencode-go`) don't need one transcribed
  by hand. Opt in per provider with `cookie_from_firefox = "<domain>"`, which enables
  `POST /usage/:provider/cookie/from-firefox` (a web-UI button) — **on request only,
  never on a timer**. The daemon keeps the stored cookie until it expires, then a human
  approves one read; a background poller reaching into the browser profile every few
  minutes would be a standing cookie-harvesting capability to re-learn something that
  changes once a month. Firefox stores values in plaintext (no keyring decrypt — that
  was Chromium-only), and the DB is copied before opening because Firefox holds it in
  WAL mode. Never writes to the profile; never logs a cookie value; a refresh that
  finds nothing fails loudly and leaves the stored cookie intact.
- `src/burnrate.js` — least-squares slope + `will_deplete` projection, purely local.
- `src/dashboard.js` / `src/report.js` — a rescue-dashboard HTML page. **Written but not
  wired**: `index.js` never imports/mounts it, `GET /` is a live 404. Don't assume it
  renders anything until this is actually mounted.

## Dev workflow

```bash
cp config.example.toml config.toml   # or ~/.config/usage-daemon/config.toml
npm install
node src/index.js      # or: npm start
npm test                # node:test, fixture-driven, per-provider parse fixtures
```

## Key design

- Daemon is **optional** — see parent repo's two-path architecture.
- `windows[]` is the contract with clients (`usage-web-ui`, GNOME extensions). No
  shared package between repos — clients only ever talk `/usage/*` HTTP.
- Never returns secrets (cookie/oauth/token values) in any response.
- OAuth-file providers (claude, grok) read the CLI's own credentials file **read-only**
  and never refresh it — expired token → `auth_expired` status, last-known windows stay.
- Binds `0.0.0.0` — no per-request auth. Keep it behind LAN/Tailscale, never a public
  WAN port.
- Every provider plugin is compiled-in via `registry.js` — no dynamic plugin loading.

## Running it (hyperion) — RESOLVED 2026-08-18, was the long-standing gotcha

The daemon now runs under a real `--user` systemd unit with `Restart=always`, so it
self-heals instead of staying dead. The repo's `usage-daemon.service` is installed at
`~/.config/systemd/user/usage-daemon.service` (`loginctl` linger is already on, so it
starts at boot without a login).

```bash
systemctl --user status usage-daemon
systemctl --user restart usage-daemon
journalctl --user -u usage-daemon -n 50 --no-pager   # or: tail ~/.local/state/usage-daemon/daemon.log
```

**Do not start an ad-hoc `nohup node src/index.js` alongside it** — that is what the
old instructions said, and a bare backgrounded process has no supervisor, is killed
silently with its process group, and truncates its own log on every restart. Exactly
one daemon: `ss -tlnp | grep 8787`.

Historical note (why the docs used to warn): before 2026-08-18 the unit was never
installed on hyperion (a stale `/etc` unit pointed at a dead `usage-daemon-modern`
subpath), so the live process was always ad-hoc and unsupervised.

## Active work

`../PLAN-daemon-webui-stability.md` is the live plan. Done so far: Phase 1b path
anchoring + history auto-migration (v0.3.2); durable logging + supervised startup
(v0.4.0, see `REVIEW-20260818-crash-and-logging.md`). Still open: wiring
`dashboard.js` at `GET /` — check the plan before starting related work.
