# Claude Usage Surface — Master Plan (Marching Orders)

> **RECOVERED + RECONCILED 2026-07-11.** This file was written 2026-07-05, saved,
> then lost when `usage-daemon/` was re-created empty. Recovered verbatim from the
> `cec09cc5` session log and reconciled to current state:
> - **Daemon language = JS/node, NOT Go** (user decision 2026-07-11; see
>   `../todo/REFACTOR-1-descriptor-object.md` → "Daemon language"). All "Go daemon"
>   text below is corrected.
> - **Daemon is a framework + runner; each provider is a plugin.** Ollama is the
>   first provider. The current build spec is `../todo/HANDOFF-7-ollama-cloud-usage.md`
>   — read it, not this file, for the daemon's concrete architecture.
> - **Descriptor/meter contract:** the daemon publishes provider-agnostic "meter"
>   sources `(id, value, color-token, resets_at, will_deplete)`; the extension is a
>   thin client that renders them. See REFACTOR-1 "LIFT SEAM".
> - Phases 1 / 1.5 / 1.6 / 2 (below) are **DONE**. Repo moved `/mnt/nas/projects/*`
>   → `/sync/projects/usage/*`. Treat the phase history below as context, not TODO.

**Goal:** a robust, always-available surface for personal Claude usage — visible
in the GNOME panel, browsable as an interactive report, queryable by local AI —
plus scheduling logic that maximizes ROI on the Pro subscription.

**Author of this plan:** Claude Opus 4.8. **Status date:** 2026-07-05.

---

## Why this exists

The upstream `Haletran/claude-usage-extension` GNOME extension polls the
undocumented `https://api.anthropic.com/api/oauth/usage` endpoint. It failed in
two ways for daily use:

1. **Persistent HTTP 429.** Requests without a `claude-code` `User-Agent` land in
   an aggressively rate-limited bucket that never recovers for the session.
   Root-caused this session; fixed by adding the header. (Upstream refs:
   `anthropics/claude-code#31021, #30930, #31637`.)
2. **HTTP 401 on token expiry.** The OAuth access token in
   `~/.claude/.credentials.json` expires (`expiresAt`); the extension had no
   handling beyond a dead "No token". **Confirmed empirically** that no cheap
   CLI command force-refreshes it — `claude --version` and `claude auth status`
   do *not* refresh. Only an actual model request (or the running Claude Code
   process itself) refreshes the token as a side effect. Decision: **passive** —
   show last-known usage, never auto-spend quota to refresh a status token.

## Repos / locations (updated 2026-07-11)

| Path | What |
|---|---|
| `/sync/projects/usage/claude-usage-extension/` | **Canonical** Claude fork (`bubbabright`) — working, in daily use |
| `/sync/projects/usage/grok-usage-extension/` | Grok usage extension — working, in daily use |
| `/sync/projects/usage/ollama-cloud-usage-extension/` | Ollama parity-client (planned; HANDOFF-7) |
| `/sync/projects/usage/usage-daemon/` | This plan + the **Node/JS daemon** (framework + provider plugins) |
| `~/.local/share/gnome-shell/extensions/*-dev@bubbabright/` | Live dev installs (isolated uuid per ext) |
| `~/.cache/claude-code-usage/history.jsonl` | Rolling usage history, one JSON object per successful poll |

**Data contract** (used everywhere — extension writes it, report + daemon read it):
```json
{"t": 1783250789974, "five_hour": 44.0, "seven_day": 39.0}
```
`t` = epoch ms. Percentages 0–100. Append-only JSONL, auto-trimmed (~20k lines).
The daemon generalizes this to a provider-agnostic `windows[]` snapshot (HANDOFF-7 §A2).

---

## Phases

### Phase 1 — Extension (DONE)
Dual panel bars (5h/7d, Okabe-Ito colorblind-safe orange/blue, independently
toggleable) · UA-header 429 fix · distinct 401/429/HTTP messages · cached
last-known display on error · dynamic `limits[]` rendering (per-model caps like
Fable appear automatically) · JSONL history logging · opt-in cost-aware "Force
Token Refresh" button.

### Phase 1.5 — Projection + Report (DONE)
- **Projected-depletion warning:** from in-window burn rate, if a limit is on
  track to hit 100% before its own reset, blink that panel bar red. Setting-gated.
- **HTML usage report (Cairo-free):** `report/usage-report.template.html` — a
  self-contained, dependency-free canvas chart.

### Phase 1.6 — Review debt (DONE — see HANDOFF-1..2)
In-memory ring buffer (killed the blocking compositor-thread read), visibility-gated
blink, skip-missing-field append, least-squares burn-rate slope.

### Phase 2 — ROI Scheduler (DONE / folded into projections)
History-driven: project time-to-cap vs reset countdown, idle-headroom hints,
front-loaded-weekly flag, menu recommendation.

### Phase 3 — Local Daemon + MCP (IN BUILD — Node/JS)
- **Node/JS daemon** (NOT Go — user decision 2026-07-11; node needed for
  headless-browser scrape of usage pages, and lets the descriptor/rule code lift
  verbatim from the extension) at `127.0.0.1:8787`: a **framework + runner** that
  owns *all* polling (single poller — eliminates the duplicate-request 429 risk),
  respects `Retry-After`, and loads **provider plugins** (ollama first). Serves:
  - `GET /usage/{provider}/current`, `GET /usage/{provider}/history`, `GET /usage/providers`
  - `GET /?provider=…` → the **same** HTML report, fetching `/usage/{provider}/history`
    live instead of inlined (one line changes in the template).
- **Two-direction consumption** (user, 2026-07-12 — see `../README.md` +
  `usage-two-direction-goal` memory). The daemon is **optional**, not a required repoint:
  - *Dir 1 — standalone exts.* Each per-provider ext keeps its own engine and works with
    no daemon; **dual-mode** — reads `http://127.0.0.1:8787/usage/{provider}/current` when
    the daemon is up, else self-polls. Daemon is single-source-of-truth *when present*.
  - *Dir 2 — unified ext.* One ext renders any provider the daemon publishes (multi-provider
    power users). Daemon-only by nature.
- **MCP wrapper (generic):** thin stdio MCP server exposing `get_usage(provider)`,
  **provider-agnostic** — usable by *any* MCP client for *any* provider, not Claude-specific
  and not limited to Claude Code sessions.
- **Concrete architecture + build order:** `../todo/HANDOFF-7-ollama-cloud-usage.md`.

---

## Standing decisions (do not relitigate)
- **Never auto-spend quota** to refresh a token. Passive display only. The
  refresh button is explicit, opt-in, and cost-warned.
- **Colors:** 5-hour = `#E69F00` (orange), 7-day = `#56B4E9` (blue). Okabe-Ito,
  colorblind-safe, dark/light aware. Used in panel, report, everywhere.
- **Don't hardcode which limits exist.** Render from the API `limits[]` array (and,
  daemon-side, from the published `windows[]`) so new offerings appear without code changes.
- **Daemon = JS/node**, framework + provider plugins, localhost-only, fail-soft to
  last-known. Providers self-register at startup (module import), no dynamic `.so`/plugin loading.
- **Backup / sync (2026-07-13):** `/sync/projects` is **Syncthing-synced, single client →
  NAS, backed up on-change 24/7 with versioning** (no longer CIFS; no concurrent-write
  corruption risk). Local `.git` is already continuously backed up, so unpushed commits are
  not at risk of loss. Push to GitHub for remote sync / publishing, not as the sole backup.
