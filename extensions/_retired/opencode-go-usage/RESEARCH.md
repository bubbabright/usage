# OpenCode Go — usage fetch research

> **STATUS 2026-07-18:** ✅ live meter source confirmed · **daemon plugin landed** (`usage-daemon/src/providers/opencode-go.js`). Cookie-authed `GET /workspace/{id}/go` page → SSR hydration `rollingUsage`/`weeklyUsage`/`monthlyUsage` → 3 windows, server-computed percents, no cap math needed. Tests green (`npm test` / `node --test test/opencode-go.test.js`).

## Decided source: workspace Go page hydration

`GET https://opencode.ai/workspace/{workspaceID}/go` — cookie-auth (`auth=Fe26.2**…`
session cookie), **stable URL** (no `X-Server-Id` build hash, no seroval RPC body —
unlike the console's `_server` endpoint). The Go page's SolidStart hydration
(`$R.push(["lite.subscription.get", [workspaceID], {...}])`) embeds:

```
{ mine:true, useBalance:false, region:["us","eu","sg"], plan:"lite",
  rollingUsage:  { status:"ok", resetInSec:5507,   usagePercent:6 },  // 5h
  weeklyUsage:   { status:"ok", resetInSec:160294, usagePercent:2 },  // weekly
  monthlyUsage:  { status:"ok", resetInSec:2621026,usagePercent:1 } } // monthly
```

- Percent is server-computed (`usagePercent`, integer) — daemon never reconstructs
  the $12/$30/$60 caps or window boundaries.
- `resetInSec` → absolute: `new Date(Date.now() + resetInSec*1000).toISOString()`.
- `status !== "ok"` on a window → emit `pct: null` for that window (soft fail),
  not a thrown error.
- Missing `rollingUsage` block entirely (logged out / redirect to `/auth`) →
  `AuthExpiredError`.
- `workspace_id` (`wrk_...`) can be pinned in config or auto-discovered from the
  first authed page's hydration (`workspaces[]`).

Fragility class: HTML/hydration scrape (same as `ollama.js`) — breaks only if
opencode restructures the page markup, not on every deploy (unlike the
build-hash-gated `_server` endpoint below).

## Rejected/superseded sources

### Console `_server` daily-aggregate endpoint — captured, NOT used

`POST https://opencode.ai/_server` — cookie-auth, but requires
`X-Server-Id: <64-hex build hash>` + `X-Server-Instance` headers that rotate on
every opencode redeploy, plus a seroval-encoded body. Returns day-bucketed
`{usage:[{date,model,totalCost,keyId,plan}]}` (totalCost ×1e-8 USD) — too
coarse for the 5h window anyway. Too brittle for a daemon dependency; the Go
page hydration above supersedes it for the live meter.

### `usage.list` / per-request records (early hydration find, superseded)

An earlier capture of `/workspace/{id}/usage` hydration exposed a
`usage.list["wrk_...", pageIdx]` resource with per-request rows:
`{id, workspaceID, timeCreated, model, provider, inputTokens, outputTokens,
reasoningTokens, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens, cost,
keyID, sessionID, enrichment:{plan}}`. `cost` unit divisor unconfirmed (looked
like 1e-8 USD, unverified against a known-price row). `provider` field observed
as `"console-go.oa-compat"` (OpenAI-compat proxy shim). Not used in v1 — the Go
page's pre-computed `rollingUsage` percents make per-request summation
unnecessary for the meter. Kept here only in case segments/per-model breakdown
is wanted later (Phase 2 candidate, alongside the local DB source below).

## Auth

`~/.local/share/opencode/auth.json` (mode 0600): `{"opencode-go": {type:"api",
key:<secret>}, ...}`. This is the **inference** Bearer key (used for API calls),
confirmed present once the account is signed up for Go — but the Go page meter
above uses the **browser session cookie**, not this key. Daemon auth kind is
`cookie` (paste flow via `POST /usage/opencode-go/cookie`, same as
ollama/mistral), not an `auth.json` read. The api key read (`api-file` kind)
was considered but not pursued since the cookie path was already confirmed
working end-to-end and needs no separate capture to prove Bearer acceptance.

## Local SQLite history (offline fallback, not wired in v1)

`~/.local/share/opencode/opencode.db` (SQLite, WAL). `session` table: `cost`
(real, plain USD float, NOT ×1e8), `tokens_input/output/reasoning/cache_read/
cache_write`, `model` (JSON text — `json_extract(model,'$.providerID')`),
`workspace_id`, `time_created` (epoch ms).

Provider ID taxonomy (verified against real data):
- `opencode-go` = the paid Go subscription — `cost` populated. This is what
  the daemon should meter.
- `opencode` = free Zen tier (`*-free`, `big-pickle`, `hy3-free` model ids) —
  cost always 0. Excluded.
- `ollama` / `ollama-cloud` = separate provider, own plugin already.

Offline meter query (no network/cookie needed):
```sql
SELECT sum(CASE WHEN time_created >= :now_ms - :win_ms THEN cost END)
FROM session WHERE json_extract(model,'$.providerID')='opencode-go';
```
pct = 100 * usd_in_window / cap (caps: 5h $12, weekly $30, monthly $60).

**Caveat:** this-machine-only — undercounts if Go is used from another device,
and lags in-flight sessions (measured ~$0.027 lag on an active session vs the
console's per-request total). Server `rollingUsage` is cross-device-authoritative
and removes both problems, so it stays the v1 source; the local DB is a Phase 2
candidate for segments/history/offline fallback, not required for the meter.

## Design notes carried into the plugin

- Colors (Okabe-Ito): 5h `#009E73` green, weekly `#56B4E9` blue, monthly
  `#E69F00` orange.
- Window ids/letters: `5h`/`5h`, `weekly`/`Wk`, `monthly`/`Mo`.
- `tier` read from the `plan` field in the hydration (`"lite"` observed).
- `segments: []` in v1 — no per-model breakdown yet (see Phase 2 above).

## Secrets hygiene

Never write raw cookie or api key values into this file or the fixture. Live
creds live only in `~/.config/usage-daemon/opencode-go.cookie` (0600, daemon-
owned) and `auth.json` (read-only, never touched by the daemon).

## Done / open

- [x] Plugin `src/providers/opencode-go.js` registered in `src/index.js`.
- [x] `[providers.opencode-go]` block in `config.example.toml`.
- [x] `test/opencode-go.test.js` + `test/fixtures/opencode-go-go.html` — 5/5 green.
- [x] `src/providers/icons/opencode-go.svg` (placeholder glyph — swap for the
      real OpenCode Go mark if/when lifted from the page's brand SVG).
- [ ] Live verification: paste a real cookie into
      `~/.config/usage-daemon/opencode-go.cookie`, set `workspace_id`,
      `enabled=true`, run the daemon, `curl localhost:8787/usage/opencode-go/current`
      and compare percents against the `/go` page. **Needs Daniel** (real
      session cookie only exists in his browser).
- [ ] Logged-out path live check: bad/expired cookie → status `auth_expired`,
      stale=true, last-known snapshot kept.
- [ ] Phase 2 (later): wire local DB (`opencode.db`) for segments/history/
      offline fallback — needs a sqlite driver decision (`node:sqlite` vs
      `better-sqlite3` vs shelling to the `sqlite3` CLI); daemon is currently
      zero-dep.
