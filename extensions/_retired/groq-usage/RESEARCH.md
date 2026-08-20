# Groq — usage fetch research

> **STATUS 2026-07-13:** ⚠️ no public spend API. Dev tier → Path A `x-ratelimit-*` headers only (rate limits, not $). Enterprise → Path C Prometheus (`api.groq.com/v1/metrics/prometheus`, gated). OPEN CAPTURE: Groq console `Dashboard→Usage` XHR (Path B) for real $ spend — devtools Network, filter `groq`, copy-as-cURL. Not yet done.

**Verdict: no public billing/usage API.** Groq does NOT expose a documented `/usage` or `/spend` endpoint (open feature request only). Two viable paths, both like the grok ext pattern (reverse-engineered) or header-scraping.

Dashboard being mirrored: <https://console.groq.com/dashboard/usage> (token consumption + monthly spend, ~10–15 min delayed).

## Path A — `x-ratelimit-*` response headers (documented, reliable, but indirect)

Every response from `https://api.groq.com/openai/v1/*` carries rate-limit headers. **No extra request needed if piggybacking on real inference**, but to poll for status alone you must send a cheap request (costs a token/RPD tick — conflicts with the never-auto-spend rule; use a minimal 1-token call or accept staleness).

| Header | Meaning |
|---|---|
| `x-ratelimit-limit-requests` | max requests / window (= RPD) |
| `x-ratelimit-limit-tokens` | max tokens / window (= TPM) |
| `x-ratelimit-remaining-requests` | requests left (**Requests Per Day**) |
| `x-ratelimit-remaining-tokens` | tokens left (**Tokens Per Minute**) |
| `x-ratelimit-reset-requests` | time to RPD reset (e.g. `"2m59.56s"`) |
| `x-ratelimit-reset-tokens` | time to TPM reset (e.g. `"1.2s"`) |
| `retry-after` | seconds (429 only) |

Quirks:
- `remaining-requests` = **RPD**, `remaining-tokens` = **TPM** (mismatched windows — one daily, one per-minute).
- Reset values are duration strings (`"1.2s"`, `"120ms"`, `"2m59s"`) — parse to seconds, add to now for `resets_at`.
- These are **rate limits, not billing spend**. For $ spend / monthly consumption there is NO header — only the console.

## Path B — console internal API (reverse-engineer, like grok ext did)

`console.groq.com/dashboard/usage` fetches spend/token history from an internal (undocumented) endpoint behind the console session (not the API key). Same shape as how grok-usage-extension polls `cli-chat-proxy.grok.com/v1/billing`. Gives real monthly spend + token history the headers can't.

TODO: capture the XHR the dashboard makes (devtools → Network on the usage page) — record path, auth (session cookie vs bearer), response JSON. Not yet done.
Console spend UI lives at **Dashboard → Usage** (view) and **Settings → Billing → Limits** (spend cap). Spend tracked ~10–15 min delayed, org-wide across all keys.

## Path C — Prometheus metrics endpoint (documented, but ENTERPRISE-ONLY)

`GET https://api.groq.com/v1/metrics/prometheus` — a VictoriaMetrics-backed Prometheus API. **Best programmatic source Groq offers**, but **Enterprise tier only** (must contact their Enterprise team; free/dev tier can't use it).

- Auth: `Authorization: Bearer <api-key>`
- Standard Prometheus paths: `/api/v1/query`, `/query_range`, `/series`, `/labels`. Query lang = MetricsQL (PromQL superset).
- Metrics: `model_project_id_status_code:requests:rate5m` (requests), `model_project_id:tokens_in:rate5m` / `:tokens_out:rate5m` (tokens), queue/ttft/e2e latency buckets, `prompt_cache_hits/misses:rate5m`.
- **No $ spend metric** — request/token/latency/cache rates only. Spend still console-only.

Relevant only if the user has (or gets) Enterprise. For dev/free tier → not available; fall back to Path A/B.

## Recommendation

- **Dev/free tier (this account):** Path A headers — RPD remaining + TPM remaining. Cleanest, documented, works on any tier. Spend meter needs Path B (console internal XHR), not yet captured.
- **Enterprise:** Path C Prometheus for rich request/token history; still Path B for $ spend.
- Build header path first (parity with claude/grok window model); defer spend meter until the console XHR is captured.
- CodexBar issue [#993](https://github.com/steipete/CodexBar/issues/993) (another usage-tracker) hit the same wall: no confirmed public usage/spend API — corroborates.

## Map to daemon snapshot (`windows[]`)

| window id | source | pct | resets_at |
|---|---|---|---|
| `daily_requests` | `1 - remaining_req/limit_req` | `%` | now + `reset-requests` |
| `tpm` | `1 - remaining_tok/limit_tok` | `%` | now + `reset-tokens` (per-min, noisy) |
| `spend` (later) | Path B monthly | `spend/cap` | 1st next month |

TPM resets per-minute → too noisy for a panel bar; likely show RPD only, keep TPM as dropdown detail.

## Sources
- <https://console.groq.com/docs/prometheus-metrics> (Path C — enterprise Prometheus)
- <https://console.groq.com/docs/billing-faqs>
- <https://console.groq.com/docs/rate-limits>
- <https://console.groq.com/docs/spend-limits>
- <https://community.groq.com/t/add-api-endpoint-to-fetch-billing-and-usage-data/378> (feature request — no API yet)
