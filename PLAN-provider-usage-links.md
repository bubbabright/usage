# Provider usage-page links in web UI

> Note: this file is plan-mode's required scratch location. Per standing rule,
> the real plan doc goes in the project — on approval this gets written to
> `/mnt/nas/projects/usage/PLAN-provider-usage-links.md`, not kept here.

## Context
User wants each provider in the usage-daemon web UI to show a link to that
provider's own usage/billing page (e.g. console.anthropic.com, console.groq.com),
so they can jump straight from the local dashboard to the vendor's page for
detail the daemon doesn't surface. User also wants the URL editable from the
web UI (best-guess defaults will be wrong for some providers).

## Approach
Overrides are saved server-side by the daemon (not localStorage) so the edited
URL is the same for every browser/device hitting this daemon and survives
across machines the way auth/cookie state already does. New small JSON store
alongside `config.toml`, in the same XDG config dir `config.js` already uses
(`usage-daemon/src/config.js:13-16`), plus one new PUT route.

1. **Backend default** — add a `usageUrl` field to each provider's `config()`
   return object (pattern at `usage-daemon/src/providers/claude.js:185-197`).
   One-line addition per file, 10 of the 11 providers:
   - `ollama.js` → `https://ollama.com/settings`
   - `claude.js` → `https://claude.ai/settings/usage`
   - `grok.js` → `https://grok.com/?_s=usage`
   - `mistral.js` → `https://console.mistral.ai/usage`
   - `opencode-go.js` → `https://opencode.ai`
   - `openrouter.js` → `https://openrouter.ai/activity`
   - `cloudflare.js` → `https://dash.cloudflare.com`
   - `deepgram.js` → `https://console.deepgram.com`
   - `groq.js` → `https://console.groq.com/usage`
   - `firecrawl.js` → `https://www.firecrawl.dev/app/usage`
   - `codexbar.js` — skip (local wrapper around other CLIs, `auth: {kind:'none'}`,
     no single vendor page; leave `usageUrl` unset)

   These are best-guess defaults confirmed by the user as an acceptable
   starting point, correctable via the UI per point 3.

2. **Frontend read** — `ProviderSettingsModal` in
   `usage-web-ui/src/client/SettingsView.tsx` already fetches
   `GET /usage/${provider}/config` (line 14) into `config` state. Place the
   link directly in the modal's header button row (`SettingsView.tsx:40-53`,
   the row that already holds the "Connected" badge, `auth.kind` badge, and
   the `X` close button) — an icon-only `ExternalLink` button
   (already imported in `App.tsx:4`, import it into `SettingsView.tsx` too)
   as `<a href=... target="_blank" rel="noopener noreferrer">`, sized/styled
   to match the adjacent close button, with `aria-label="Open {provider}
   usage page"` and `cursor-pointer` (per UI-UX guidelines: icon-only
   buttons need aria-label, no layout-shifting hover). Positioned before the
   `X` button, using the effective URL from step 3. Hidden entirely if no
   URL is set (covers `codexbar`).

3. **Server-side store + endpoint** — new module
   `usage-daemon/src/usage-urls.js`: JSON file `usage-urls.json` next to
   `config.toml` (same dir helper pattern as `config.js:13-16`), shape
   `{ "grok": "https://...", ... }`. Exports `loadOverrides()` (read file,
   `{}` on missing/parse-error — same tolerant style as `loadConfig()`) and
   `saveOverride(provider, url)` (merge into the file; empty/absent `url`
   deletes the key so it falls back to the default). No in-process cache
   needed — this endpoint is low-frequency, read the file fresh each call.

   `http.js`:
   - `GET /:provider/config` (line 156-162) — after `entry.provider.config?.()`,
     merge in the override: `const overrides = await loadOverrides(); if (overrides[provider]) c.usageUrl = overrides[provider];`
   - New `router.put('/:provider/usage-url', ...)` (near the existing
     `cookie`/`auth` routes, `http.js:197-227`) — reads `url` from JSON body,
     trims it, calls `saveOverride(provider, url)`, responds
     `{ ok: true, usageUrl: url || null }`. Empty string clears the override.

4. **Frontend edit control** — in `ProviderSettingsModal`
   (`SettingsView.tsx`), a small pencil/edit affordance next to the
   `ExternalLink` button switches it to a text input; on save,
   `PUT /usage/${provider}/usage-url` with `{ url }`, then update local
   `config.usageUrl` from the response (or re-fetch `/config`) so the link
   reflects the change immediately.

## Files touched
- `usage-daemon/src/providers/{ollama,claude,grok,mistral,opencode-go,openrouter,cloudflare,deepgram,groq,firecrawl}.js` — add default `usageUrl` to `config()`
- `usage-daemon/src/usage-urls.js` (new) — override store (load/save JSON file)
- `usage-daemon/src/http.js` — merge override into `GET /:provider/config`; add `PUT /:provider/usage-url`
- `usage-web-ui/src/client/SettingsView.tsx` — render link + edit control in `ProviderSettingsModal`

## Verification
- `cd usage-daemon && npm test` (or existing test command) if provider config
  shape is asserted anywhere — otherwise this is additive and won't break
  existing tests.
- Run the daemon + web UI (`run` skill or project's existing dev script),
  open each provider's settings gear icon, confirm the usage-page link
  appears and opens the right URL in a new tab, edit a URL and confirm
  `usage-urls.json` is written and the link updates, restart the daemon and
  confirm the override still applies, then clear it and confirm it reverts
  to the backend default.
