# Plan: Stability + usability overhaul — usage-daemon + usage-web-ui

## Context

User symptom: **"most providers fall off line and do not recover."** Live dashboard confirms: claude `rate_limited (stale)` 1 day, grok `auth_expired` 5d, cloudflare 8d, mistral 4d. Review of daemon + both UIs found the causes: fixed-interval polling with no backoff/retry-after, no fetch timeouts, stale hardcoded Claude UA that Anthropic 429-buckets, cwd-relative config/state paths (config's `expandHome()` expands `~` to `process.cwd()`, not homedir — wrong-launch-dir silently loses whole config), silent failures (no logging of poll errors), an unsupervised ad-hoc daemon process on hyperion, and a React UI that hides error reasons and never recovers its own error banner. Goal: providers self-heal from transient failures, loudly demand re-auth when human needed, and daemon survives crashes/restarts.

User decisions:
- Built-in daemon dashboard: **keep BOTH UIs** — wire dashboard.js at `GET /` as a deliberately-minimal rescue/status page (status, error reasons, re-auth paste). React UI stays the featured daily dashboard.
- Fix systemd unit on hyperion (Restart=always, correct WorkingDirectory).
- Remove dead "Global Alert Triggers" settings UI.
- Re-auth UX: persistent UI banner + one-click jump to paste form (no push notifications yet).

Repos: `usage-daemon/` and `usage-web-ui/` are independent git repos. **No Claude co-author on commits.** Bump About/version on milestone.

**Architecture principle (governs every phase below): usage-web-ui stays independent of the daemon's internals.** It's a standalone client — it talks to the daemon only over the documented `/usage/*` HTTP contract (`windows[]`, snapshot fields), same as any other consumer (extensions, `/metrics`, dashboard.js). It must keep its own computation (e.g. `slope()`/burn-rate projection) rather than delegating to daemon-computed values, and must degrade gracefully if a daemon-side field is absent (older daemon, different deploy). New daemon fields (Phase 4) are additive and optional-to-consume, never a hard requirement for existing UI features to function. No shared package/module between the two repos.

---

## Phase 1 — Recovery core (daemon; the "don't fall off" fix)

### 1a. Adaptive scheduler — `usage-daemon/src/runner.js`
- Replace per-provider `setInterval` with self-rescheduling `setTimeout` chain (re-arm after poll completes).
- Extract pure `nextDelay(status, failures, retryAfter, base)` (new small module or in runner):
  - ok → base interval (`intervalSeconds()`).
  - `rate_limited` + retryAfter → `max(retryAfter*1000, base)` + jitter. (`RateLimitedError.retryAfter` already parsed by every provider — currently ignored. Plumb via `_markStale(err)`.)
  - `rate_limited`/`error` without retryAfter → exponential backoff `base * 2^failures`, cap ~1h, jitter, hard floor = base.
  - `auth_expired` → slow re-check cadence (~30 min) so re-login is picked up without restart.
- In-flight guard: `entry.inFlight`; concurrent `poll()` awaits/returns existing promise (manual `/refresh` included).
- Fetch timeout: wrap `provider.fetch()` in `Promise.race` with 30s abort (covers signal-ignoring scrapers immediately); pass `AbortSignal` to providers incrementally.
- Log every poll failure (`provider, status, message, consecutive failures, next retry`) and every stale→ok recovery in `_markStale`/`poll`. Ends silent rot.
- Track per-entry: `failures`, `last_success_t`, `next_poll_at`, `backoff_ms`.

### 1b. Path anchoring — `usage-daemon/src/store.js`, `usage-daemon/src/config.js` — **done (v0.3.2)**
- `store.js stateDir()`: `$XDG_STATE_HOME || ~/.local/state` + `/usage-daemon/<provider>` (matches its own header comment). `USAGE_STATE_DIR` env override for tests.
- `config.js configPath()`: `$XDG_CONFIG_HOME || ~/.config` + `/usage-daemon/config.toml`, fallback to old cwd-relative file if it exists (migration grace). Logs which config loaded.
- `expandHome()`: `~` → `os.homedir()` (was `process.cwd()`).
- **Auto-migration, not manual `mv`**: this path switch actually stranded ~20 days of history per provider on this machine on its first restart with the new code (old cwd-relative `history.jsonl` silently orphaned, new XDG path started empty). Recovered by hand once (merge+dedupe by `t`, backups in `usage-daemon/BACKUP-history-merge-20260801-055045/`), then closed the gap in code: `store.js`'s `migrateLegacyHistory()` runs once per provider per process (marker file `.legacy-migrated`) on first `append()`/`read()` — if a legacy cwd-relative `history.jsonl` exists and the XDG one doesn't know about it, merges it in automatically. So the hyperion cutover no longer needs a manual `mv` step.

## Phase 2 — Provider correctness (daemon)

- **mistral.js:309-310, 366-378** — (found live: fresh cookie pasted via Settings UI, provider stayed `auth_expired` with unhelpful message). Two bugs: (1) any 3xx response is treated as auth failure — too broad, could false-positive on unrelated redirects; (2) non-401/403/429/3xx/ok statuses fall through silently ("soft fail", line 319) into a generic `AuthExpiredError('Mistral fetch produced no meter data')` that discards the real HTTP status/reason. Fix: capture and surface the actual status code / response snippet in the thrown error so "cookie looks set but still stale" is diagnosable instead of a dead-end message.
- **claude.js:29** — UA `claude-code/2.1.0` stale (confirmed: same literal string copy-pasted into 3 retired GNOME extensions too, never bumped anywhere, ever; real installed CLI is `2.1.220`) → Anthropic 429-buckets it → stuck rate_limited (the screenshot bug). Make version configurable (`[providers.claude] user_agent_version`) with auto-detect default (`claude --version` once at startup, cached; hardcoded bumped fallback). Verify 429 path parses `retry-after` header (claude.js:174 does) so Phase 1 honors it.
- **grok.js:390** — same species of bug as claude's: `'x-user-agent': 'connect-es/2.1.1'` hardcodes the connect-es gRPC-web client library version used by xAI's own web app for the weekly-credits protobuf endpoint (grok.js:387-394). If xAI's frontend ships a newer connect-es, this drifts stale exactly like claude's UA did. Audited all 11 providers' UA strings: this and claude are the only two that *impersonate a specific real, versioned client* — the rest (cloudflare/firecrawl/deepgram/groq: self-identifying `usage-daemon/0.1`; ollama/mistral/opencode-go/openrouter: generic `Mozilla/5.0 ...` browser fingerprint, not version-pinned) have no equivalent drift risk and need no change. Fix: same pattern as claude — make the connect-es version configurable with a documented fallback, and note in comments that this value needs periodic manual bump-checking (no local install to auto-detect it from, unlike claude's CLI).
- **groq.js:53** — `parseDuration` regex lacks hours/days groups; daily RPD reset (`"7h29m0s"`) unparsed most of day (known bug, REVIEW-groq-provider.md). Extend regex `(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)(ms|s))?` + at-least-one-match guard; add fixture tests with hour-bearing strings.
- **burnrate.js:27** — `willDeplete` comment claims current-window filtering; code fits slope on ALL history. Filter points to current window: walk history backwards, cut at first pct decrease (reset discontinuity); cap lookback at window length when known.

## Phase 3 — Process hygiene (daemon + hyperion)

- **index.js**: `process.on('unhandledRejection')` (log) + `uncaughtException` (log, exit 1 — supervisor restarts clean). Express 4-arg error middleware after routes (log + 500 JSON). Startup summary log: config path, state dir, enabled providers.
- **systemd**: add `usage-daemon/usage-daemon.service` example to repo — correct `WorkingDirectory` (repo checkout), `ExecStart=node src/index.js`, `Restart=always`, `RestartSec=5`. Hyperion cutover checklist (deploy step): stop ad-hoc node pid (find via `ss -tlnp | grep 8787`), migrate state dir, remove/replace stale unit (old one points at dead `usage-daemon-modern` path), enable+start, confirm `/usage/providers`.

## Phase 4 — Observability (daemon)

- **`/metrics` (index.js)**: emit for EVERY provider (currently skips non-ok — down providers invisible): `usage_provider_status{provider,status}`, `usage_provider_stale`, `usage_provider_last_success_timestamp_seconds`, `usage_provider_consecutive_failures`, plus `usage_window_pct` incl. stale-last-known.
- **`runner.list()`**: additive fields — `error`, `last_success_t`, `consecutive_failures`, `next_poll_at`, `backoff_ms`. `windows[]` shape untouched (contract). Check `extensions/` consumers before touching any existing key — add only, rename nothing.

## Phase 5 — Web UI stability + usability (`usage-web-ui/src/client/`)

- **App.tsx:190-205** — `setError(null)` on successful providers fetch (banner currently permanent after one blip). Optionally "data may be stale" ribbon via lastFetchOk timestamp.
- **App.tsx:213-233** — provider-detail fetch: AbortController + stale-guard (`if (id !== selectedRef.current) return`) — kills wrong-provider paint race. Surface partial fetch failures inline; `refreshCurrent` failure gets visible message, not console-only.
- **Error boundary** — new small `ErrorBoundary` component wrapping main content (main.tsx); null-safe window rendering so one bad snapshot degrades one card, not whole app.
- **Failure surfacing** — show `snap.error`, "last good poll Xago" (`last_success_t`), `next_poll_at` on cards + detail, all optionally-rendered (fall back to existing `t`/stale display if a field is missing — don't require Phase 4 to have shipped). Fix detail status dot missing red branch (App.tsx:456): red = auth_expired/error, amber = rate_limited/stale.
- **Re-auth banner (user decision)** — persistent "N providers need re-auth" banner when any `auth_expired`; click jumps to that provider's cookie/token paste form (daemon `setCookie`/`setAuthPayload` endpoints already exist). auth_expired cards get red border + "re-auth needed" CTA.
- ~~**SettingsView.tsx:224-238** — remove dead "Global Alert Triggers" UI (user decision).~~ **done.** Also went further than this phase scoped: Settings is no longer a standalone page — `SettingsView.tsx` now exports `ProviderSettingsModal`, opened via a gear icon on each sidebar provider row (auth form + visibility toggle combined per-provider, no separate global settings nav item).

## Phase 6 — Both-UIs cleanup (user decision: keep both)

- Wire `dashboard.js` at daemon `GET /` + `report.js` at `GET /?provider=` (imports + routes in index.js/http.js — the code already exists, currently orphaned).
- **Trim dashboard.js to rescue-page scope**: provider cards with status/error/last-success, re-auth paste forms, force-poll. Explicitly NOT feature-parity with React UI — document this in its header comment so drift is by design, not rot.
- Update it to show Phase 4 fields (error, last_success_t, next_poll_at) — its whole job is "why is it red."
- Docs truth: README/AGENTS.md — daemon serves rescue page at `GET /`, React UI is the featured dashboard; document config/state path resolution, backoff policy, systemd unit.
- slope() dedupe: add daemon-computed `depletes_at` per window (additive); drop App.tsx:348 local slope in favor of it.

## Phase 7 — Tests (pure-function tests land WITH their phase; this is the sweep)

- `nextDelay()` unit tests (backoff growth, retryAfter honoring, floor/cap).
- Runner integration with fake provider (resolves/rejects/hangs): in-flight guard, 30s timeout, stale→ok transition, disk-fallback `_markStale` path.
- `store.js` append/trim/read round-trip in temp dir (`USAGE_STATE_DIR`).
- `config.js` path resolution + fixed `expandHome` + `*_file` resolution.
- `http.js`/`/metrics` via Express app on ephemeral port: new list() fields, all-provider metrics emission, `GET /` serves rescue page.
- groq hour/day duration fixtures; burnrate cross-reset window test.
- Web UI: no test infra today — don't build harness this pass; manual checklist in README.

## Sequencing

- Phases 1–3 = the recovery story; ship to hyperion as ONE deploy (path anchoring + systemd cutover interact).
- Phase 4 before 5/6 (UIs consume the new fields).
- Each repo commits separately (independent git repos). Version bump on completion (milestone).

## Verification

1. **Backoff**: stub provider throwing `RateLimitedError(retryAfter=600)` → assert next poll ≥600s; throwing generic errors → delays double, cap 1h; recovery resets to base.
2. **Timeout**: provider that never resolves → 30s abort logged, no stacked polls.
3. **Paths**: launch daemon from random cwd → config found in `~/.config`, history in `~/.local/state`.
4. **Claude live**: deploy on hyperion, watch logs — claude leaves rate_limited within one poll (UA fix). Confirm against active CLI session.
5. **Crash recovery**: `kill -9` daemon → systemd restarts in 5s, providers repopulate from disk fallback.
6. **Metrics**: break one provider (bad cookie) → its rows present in `/metrics` with status label.
7. **UI**: dev server + throttled network — error banner clears after blip; rapid provider switching no cross-paint; auth_expired card shows red + reason + re-auth CTA; banner links to paste form; pasting cookie recovers card immediately.
8. **Rescue page**: `curl http://127.0.0.1:8787/` returns dashboard HTML; open in browser with React UI stopped — status + re-auth still usable.
9. `cd usage-daemon && npm test` green.
