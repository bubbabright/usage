# OpenRouter — usage fetch research

> **STATUS 2026-07-13:** ✅ COMPLETE, no gaps. `GET /api/v1/key` gives everything (daily/weekly/monthly + limit, one normal key). Ready to build. Next step = build standalone ext (build order: OpenRouter → Mistral → Groq).

**Verdict: easiest of the three.** Fully public, documented, single API key auth. No cookie/no admin role. Best first candidate to build.

Dashboard being mirrored: <https://openrouter.ai/activity> / credits page.

## Auth

Standard Bearer with a normal API key (or a provisioning/management key for `/credits`):

```
Authorization: Bearer $OPENROUTER_API_KEY
```

Base URL: `https://openrouter.ai/api/v1`

## Endpoints

### 1. `GET /api/v1/key` — per-key usage + limit (primary signal)

Returns rolling usage buckets and the key's credit cap. **This is the richest source** — gives daily/weekly/monthly directly, no local accumulation needed.

```jsonc
{
  "data": {
    "label": "sk-...",
    "limit": 100.0,            // credit cap on key (null = unlimited)
    "limit_reset": null,       // reset schedule type (string|null)
    "limit_remaining": 41.2,   // credits left on key
    "include_byok_in_limit": false,
    "usage": 58.8,             // total credits consumed (all time)
    "usage_daily": 3.1,        // current UTC day
    "usage_weekly": 12.4,      // current UTC week (Mon start)
    "usage_monthly": 40.0,     // current UTC month
    "byok_usage": 0,
    "byok_usage_daily": 0, "byok_usage_weekly": 0, "byok_usage_monthly": 0,
    "is_free_tier": false
  }
}
```

### 2. `GET /api/v1/credits` — account credit balance

Management-key scope. Whole-account, not per-key.

```jsonc
{ "data": { "total_credits": 100.0, "total_usage": 58.8 } }
```

Remaining balance = `total_credits - total_usage`. (`balance`/`remaining_credits` fields are NOT documented — compute it.)

### 3. Per-response headers (live rate limit, secondary)

Every completion response carries `x-ratelimit-*` (see groq notes — OpenRouter exposes similar). Not needed if using `/key`.

## Map to daemon snapshot (`windows[]`)

Model is **spend/credit**, not a rolling time-window like claude 5h/7d. Two natural meters:

| window id | source | pct | resets_at |
|---|---|---|---|
| `monthly` | `usage_monthly` vs `limit` | `usage_monthly/limit*100` | 1st of next month UTC |
| `credits` | `total_usage` vs `total_credits` | `total_usage/total_credits*100` | none (top-up balance) |

Prepaid credit balance has **no reset** → `resets_at: null`, `will_deplete` still meaningful (burn-rate to zero balance). Daily/weekly available as extra meters if wanted.

## Caveats

- `/credits` needs a management/provisioning key; `/key` works with the same key that does inference. Prefer `/key`.
- Credits model ≠ time-window model → descriptor needs a "balance" meter kind (no reset). Flag for daemon plugin.

## Sources
- <https://openrouter.ai/docs/api/reference/limits>
- <https://github.com/steipete/CodexBar/blob/main/docs/openrouter.md>
