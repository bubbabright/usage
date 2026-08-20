# Mistral — usage fetch research

> **STATUS 2026-07-15:** ✅ both meters captured · **daemon plugin landed** (`usage-daemon/src/providers/mistral.js`, HANDOFF-20). **Vibe** = tRPC `billing.vibeUsage` (🍪 cookie; pct=`100-usage_percentage`; reset `reset_at`). **API spend** = `/admin/usage`÷`/admin/spend-limit` (🔑 admin key, optional window). OPEN LEAD: probe cookie-auth tRPC sibling (`billing.apiUsage`?) to read API spend without the admin key.

**Verdict: real documented Admin API exists**, but gated behind an **Admin-role API key** (Member/Billing keys are rejected). Richest billing data of the three; heaviest auth requirement.

> **Captured pages in [docs/](docs/)** (2026-07-13): [subscriptions-page](docs/subscriptions-page.md) (Vibe % meter + confirmed nav URLs), [usage-page](docs/usage-page.md) (the `$` spend dashboard = front of `GET /admin/usage`, categories + Cost-Per-Day history), [billing-page](docs/billing-page.md) (spend cap **$10/mo** + credit balance = front of `/admin/spend-limit`), [limits](docs/limits.md) (per-model TPM/RPS table — fallback denominators). Frontend host is `admin.mistral.ai`; the Admin API base is `console.mistral.ai/api/admin`.
>
> **Confirmed spend meter:** cap = **$10/mo** (one limit, covers API *and* Vibe), current usage $0, credits $0.00, auto-recharge off. `monthly_spend` = `/admin/usage` total ÷ $10, resets 1st of month. The separate Vibe `%` (subscriptions page) is the free-tier *entitlement* quota, distinct from this $ cap.

Dashboard being mirrored: <https://admin.mistral.ai/subscriptions> + usage dashboard.

## ⚠️ Two distinct meters — free tier vs API plan

The user's account is **Vibe Free tier**, which surfaces a *different* meter than the API-plan spend docs below:

**Vibe free-tier UI (observed 2026-07-13):**
```
Free
Monthly usage   100%
Resets in 19 days
```

- A **monthly % quota with a reset countdown** — NOT a $ spend cap. Same shape as claude/ollama windows (`pct` + `resets_at`), no cap-denominator math needed.
- **ENDPOINT CAPTURED 2026-07-13** (tRPC, session-cookie auth) — details in [docs/subscriptions-page.md](docs/subscriptions-page.md):
  ```
  GET https://admin.mistral.ai/api/local-trpc/billing.vibeUsage?input={"json":null,"meta":{"values":["undefined"],"v":1}}
  → {"result":{"data":{"json":{
       "usage_percentage":100,          // REMAINING (100 = full/unused)
       "quota_changed_this_month":false,
       "payg_enabled":false,
       "reset_at":"2026-08-01T00:00:00Z"  // calendar 1st-of-month, UTC
  }}}}
  ```
- **Ambiguity resolved:** `usage_percentage:100` = **remaining** (fresh account = full tank). Daemon `windows[].pct` (=%used) = **`100 - usage_percentage`**.
- **Reset resolved:** calendar **1st-of-month UTC** (`reset_at`), not rolling anniversary (Jul 13 → Aug 1 = the "19 days").
- **Auth:** session **cookie** (same-origin `admin.mistral.ai`, no Bearer) — like ollama's cookie model, NOT the api-key. → prefs needs a cookie-paste step for this meter.

**Page structure:** `admin.mistral.ai/subscriptions` has two tabs — **Vibe** (this Free meter) and **API Plan**. Left nav under **API**: `API Keys`, `Usage`, `Limits`, `Privacy`; under **Subscriptions**: `Subscriptions`, `Billing`. Two separate usage surfaces:
- **Vibe quota** — tRPC `billing.vibeUsage` (cookie auth) above. ✅ captured.
- **API-plan spend** — `GET /admin/usage` ÷ `/admin/spend-limit` (api-key, Admin role) below.

---

## API-plan path (paid / Admin key) — below

## Auth

Admin API key (key must belong to a user with the **Admin** org role):

```
x-api-key: $MISTRAL_ADMIN_API_KEY
```

Base URL: `https://console.mistral.ai/api/admin`

## Endpoints

### `GET /usage` — billing usage (primary spend signal)

Query params (all optional): `month`, `year`, `workspace_id`.

Response: consumption by category (`chat`, `completion`, `ocr`, `audio`, `connectors`, `libraries_api`, `fine_tuning`, `vibe_usage`) + period dates + currency. **This is monthly $ spend broken down by product.**

### `GET /spend-limit` — org monthly spending cap

Read the cap → gives the denominator for a spend % meter. (`POST /spend-limit` to set: `{"amount":N,"no_monthly_limit":bool}` — do NOT auto-call.)

### `GET /rate-limit` — RPS + token limits

Requests-per-second and token limits for the org.

### Analytics (le Chat / Vibe) — secondary, `start_time`/`end_time` Unix seconds

- `GET /analytics/lechat/usage/by_time_stats?granularity=hour|day|week|month`
- `GET /analytics/lechat/usage/by_user_stats`, `.../by_agent_stats`
- `GET /analytics/vibe/usage/by_workspace?start_time=X&end_time=Y[&workspace_id=]`
- `GET /analytics/vibe/usage/by_organization?start_time=X&end_time=Y`

Return token consumption (input/output/cached), tool calls, sessions, message/file counts.

## Map to daemon snapshot (`windows[]`)

Spend-based (like openrouter), not rolling-window. Natural meter:

| window id | source | pct | resets_at |
|---|---|---|---|
| `monthly_spend` | `GET /usage` (sum categories) vs `GET /spend-limit` | `spend/cap*100` | 1st next month UTC |

Two calls per poll (`/usage` + `/spend-limit`); cap rarely changes so `/spend-limit` can be cached long. Subscriptions/seats (the admin.mistral.ai/subscriptions page) are subscription state, not a usage meter — surface as dropdown detail, not a bar.

## Caveats

- **Admin-role key required** — user must mint one; a normal inference key will 403. Document clearly in prefs (like ollama's cookie step).
- If `no_monthly_limit` is set, spend meter has no denominator → show absolute $ + burn-rate, `resets_at` = month rollover, no pct bar.
- Category breakdown is rich — good dropdown content (per-product spend rows).

## Sources
- <https://docs.mistral.ai/admin/admin-api/usage-metrics>
- <https://docs.mistral.ai/admin/security-access/admin-api>
- <https://docs.mistral.ai/admin/billing-usage/subscriptions>
- <https://docs.mistral.ai/admin/billing-usage/usage-limits>

---
## Implementation handoff
Build order: [`../todo/HANDOFF-20-mistral-usage.md`](../todo/HANDOFF-20-mistral-usage.md) (daemon plugin) — **implemented 2026-07-15**. Register `mistral` in `usage-daemon`; cookie + optional Admin key. Standalone GNOME ext still out of scope.
