# Mistral Billing page (captured 2026-07-13)

Source: <https://admin.mistral.ai/organization/billing> — front of `GET/POST /admin/spend-limit` + credit balance.

## Payment / Credits
- Payment methods: none added.
- **Credits: $0.00**
- **Auto Recharge: Disabled** (needs payment method to enable).
- Redeem-gift-code + billing-info fields present.

## Monthly spending limit (API **and** Vibe)
> Configure a monthly usage cap for API consumption. If reached, API access is suspended until next month or the limit is raised.

- **Usage: $0** (current month)
- **Monthly limit: $10**
- API usage: $0

## Mapping — this is the spend meter denominator
- `Monthly limit: $10` = the cap → denominator for a `% spend` window. Comes from `GET /admin/spend-limit`.
- `Usage: $0` = numerator (same figure as `/admin/usage` total).
- **One cap covers both API and Vibe** — so a single `monthly_spend` meter (`usage/limit`) is authoritative for paid consumption; the separate Vibe `%` (subscriptions page) is the *free-tier entitlement* quota, distinct from this $ cap.
- Reset = start of next calendar month (limit language: "until the next month begins").

## Snapshot mapping
| window id | numerator | denominator | resets_at |
|---|---|---|---|
| `monthly_spend` | `/admin/usage` total | `/admin/spend-limit` ($10) | 1st next month UTC |
