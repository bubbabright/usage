# Cloudflare Workers AI — usage fetch research

> **STATUS 2026-07-15:** ⚠️ PARTIAL — pricing model + dataset name confirmed, exact
> GraphQL field list NOT confirmed (docs search didn't surface the schema, needs live
> introspection against `graphql.cloudflare.com/explorer` with a real account token).
> Not ready to build; one gap to close first (see Gaps).

**Verdict: different shape from groq/openrouter/mistral.** Those are spend/credit
models against a prepaid balance. Workers AI is a **daily neuron quota with overage
billing** — closer to a hybrid of Claude's rolling-window model (daily reset, hard
free-tier ceiling) and OpenRouter's credit model (paid overage has no ceiling once
you're on the Workers Paid plan).

Dashboard being mirrored: `dash.cloudflare.com/?to=/:account/ai/workers-ai`.

## Auth

Standard Cloudflare API token, same one `wrangler login` already produced
(`~/.wrangler/config/default.toml`). GraphQL Analytics API needs **Account
Analytics Read** scope — the token minted during this session's `wrangler login`
includes `account:read`, unconfirmed whether that alone satisfies Analytics Read or
whether a dedicated scope is needed (see Gaps).

```
Authorization: Bearer $CLOUDFLARE_API_TOKEN
```

Endpoint: `https://api.cloudflare.com/client/v4/graphql` (single GraphQL endpoint for
all Cloudflare analytics, not Workers-AI-specific).

## What's confirmed

### Pricing / free-tier model (`developers.cloudflare.com/workers-ai/platform/pricing/`)

- **Free allocation: 10,000 Neurons/day**, all accounts (Free or Paid Workers plan).
- **Resets daily at 00:00 UTC** — this is the natural `resets_at` for a `windows[]`
  entry, same shape as Claude's 5h/7d windows.
- Above 10k/day: requires **Workers Paid** plan, billed **$0.011 / 1,000 Neurons**,
  no cap (pure overage, like OpenRouter's credit model but no prepaid balance to run
  out of — it's postpaid).
- **Neurons** = Cloudflare's normalized compute unit across model types (tokens,
  audio-seconds, images all map to a neuron cost per model).
- Dashboard already shows per-model neuron breakdown — API parity for that isn't
  separately confirmed.

### GraphQL Analytics API dataset (exists, schema unconfirmed)

Found via web search only (not surfaced by Cloudflare's own docs search tool),
referenced in `cloudflare/skills` repo's `graphql-api` reference:

- `aiInferenceAdaptive` — raw per-request AI inference log rows.
- `aiInferenceAdaptiveGroups` — pre-aggregated (the one to use for a daily neuron
  count, mirrors how `workersInvocationsByOwnerAndScriptGroups` is used for Dynamic
  Workers count per the June 2026 changelog).

Both are **account-level** (queried via `viewer.accounts(filter: {accountTag})`,
not `viewer.zones`), consistent with Workers AI being an account-scoped product.

Sibling dataset pattern confirmed from other products' docs (Workflows, Email
Routing, DNS) — the shape is always:

```graphql
query {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      aiInferenceAdaptiveGroups(
        limit: 10000
        filter: { date_geq: $start, date_leq: $end }
        orderBy: [date_DESC]
      ) {
        count
        sum { ??? }        # neurons field name NOT confirmed
        dimensions { date, model }  # field names NOT confirmed
      }
    }
  }
}
```

### Billable Usage dashboard (Apr 2026 feature, dashboard-only)

`developers.cloudflare.com/billing/manage/billable-usage/` — daily usage-based cost
across all products (Workers AI included), same numbers as the invoice. **Dashboard
only** — no REST/GraphQL API endpoint found for this specific view. Budget alerts
(dollar-threshold email notifications) are also UI/Notifications-configured, not
found in the API docs — likely not the integration point for a polling daemon
either way (push notification, not pull).

## Map to daemon snapshot (`windows[]`) — tentative

| window id | source | pct | resets_at |
|---|---|---|---|
| `daily_neurons` | `aiInferenceAdaptiveGroups` sum, vs 10,000 free allocation | `neurons_today/10000*100` | next `00:00 UTC` |

Single window, unlike Claude (2) or OpenRouter (2) — Workers AI has one quota
dimension (daily neurons), not separate daily/weekly/monthly buckets. Once past
10k/day on Workers Paid, `pct` conceptually exceeds 100% (uncapped overage) —
descriptor needs to handle `pct > 100` as "in overage, still billing" rather than
clamping, same open question flagged for the daemon's meter-kind design elsewhere
(see openrouter's balance-meter-kind gap).

## Gaps (blocking build)

- **Exact field names on `aiInferenceAdaptiveGroups`/`aiInferenceAdaptive` not
  confirmed** — need live introspection (`graphql.cloudflare.com/explorer`, now
  reachable since `wrangler login` completed this session) against a real account
  to confirm: the neurons sum field name, whether `model` is a filterable/groupable
  dimension, and whether the free-tier remaining count is derivable or must be
  computed locally (`10000 - sum(neurons)`, clamped at the UTC day boundary).
- **Analytics Read scope** — confirm the existing wrangler OAuth token's scopes
  cover GraphQL Analytics API reads, or whether a separate API token with
  `Account Analytics:Read` must be minted (Account API tokens page, not part of the
  `wrangler login` scope set observed this session — see scope list in
  `cloudflare/AGENTS.md`'s wrangler-login output, which does not list an analytics
  scope explicitly, though `account (read)` is present).
- **No confirmed way to read the free-tier reset boundary programmatically** beyond
  "00:00 UTC daily" from the pricing doc prose — no API field observed for it, so
  it'd be hardcoded (safe, since Cloudflare states it as a fixed rule, not
  per-account config).

## Sources
- <https://developers.cloudflare.com/workers-ai/platform/pricing/>
- <https://developers.cloudflare.com/billing/manage/billable-usage/>
- <https://developers.cloudflare.com/changelog/post/2026-04-13-billable-usage-dashboard-and-budget-alerts/>
- <https://developers.cloudflare.com/changelog/post/2026-06-11-dynamic-workers-count/> (sibling GraphQL usage-count pattern, Dynamic Workers)
- <https://github.com/cloudflare/skills/tree/main/skills/cloudflare/references/graphql-api> (only source naming `aiInferenceAdaptiveGroups`/`aiInferenceAdaptive` — not yet cross-checked against the live schema)
- <https://developers.cloudflare.com/analytics/graphql-api/> (GraphQL Analytics API overview)

---
## Implementation handoff
Build orders: [`../todo/HANDOFF-21-cloudflare-usage.md`](../todo/HANDOFF-21-cloudflare-usage.md) (Phase 0 schema close → plugin). Written 2026-07-15.
