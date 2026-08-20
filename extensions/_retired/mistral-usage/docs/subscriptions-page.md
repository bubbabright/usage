# Mistral Subscriptions page (captured 2026-07-13)

Source: <https://admin.mistral.ai/subscriptions>

Two tabs: **Vibe** and **API Plan**.

## Vibe — Free
> Your personal AI assistant for everyday life and work. Get started with Vibe.
>
> **Monthly usage 100%**
> **Resets in 19 days**
>
> Upgrade to Pro — Unlock the full potential of Vibe with a Pro subscription. [Compare plans](https://admin.mistral.ai/subscriptions/upgrade)

This `%` + reset-days meter is the **free-tier Vibe quota**. **Endpoint captured 2026-07-13** (tRPC):

```
GET https://admin.mistral.ai/api/local-trpc/billing.vibeUsage?input={"json":null,"meta":{"values":["undefined"],"v":1}}
Auth: session cookie (same-origin admin.mistral.ai frontend; NOT the api-key — no Bearer). Like ollama's cookie model.
```

Response (141 B):
```json
{"result":{"data":{"json":{
  "usage_percentage": 100,
  "quota_changed_this_month": false,
  "payg_enabled": false,
  "reset_at": "2026-08-01T00:00:00Z"
}}}}
```

- `usage_percentage: 100` = **REMAINING** quota (100 on a fresh unused free account). Daemon `pct` (=%used) = `100 - usage_percentage`.
- `reset_at` = **calendar 1st-of-month, UTC** (2026-07-13 → 2026-08-01 = the "19 days"). Not rolling anniversary.
- `payg_enabled` = pay-as-you-go flag. `quota_changed_this_month` = whether the plan/quota shifted mid-month.

Sibling tRPC procedures seen on the page: `me` (json, user/org identity), and the paid path likely has `billing.apiUsage` / `subscriptions.*` under the same `/api/local-trpc/` base.

## Confirmed nav (real URLs)
| Nav item | URL |
|---|---|
| Subscriptions | `admin.mistral.ai/subscriptions` |
| Billing | `admin.mistral.ai/organization/billing` |
| Vibe Preferences | `admin.mistral.ai/vibe/preferences` |
| Vibe Privacy | `admin.mistral.ai/vibe/privacy` |
| API Keys | `admin.mistral.ai/organization/api-keys` |
| API Usage | `admin.mistral.ai/organization/usage` |
| API Limits | `admin.mistral.ai/plateforme/limits` |
| API Privacy | `admin.mistral.ai/plateforme/privacy` |

Frontend host is `admin.mistral.ai`; XHRs go to the Admin API base `console.mistral.ai/api/admin` (per docs).
