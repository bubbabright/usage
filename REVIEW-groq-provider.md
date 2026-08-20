# Review: groq usage provider + token-auth form (working tree)

Scope: pending uncommitted changes in `usage-daemon` (new `groq` provider,
`DELETE /usage/:provider/auth` route, `runner.clearAuth`) and `usage-web-ui`
(token-key form, vite dev exposure). `multi-provider-usage-gnome-extension`
had only committed SVG assets — no logic to review.

## usage-daemon/src/providers/groq.js
- L44: 🔴 `parseDuration` regex `/^(?:(\d+)m)?(\d+(?:\.\d+)?)(ms|s)$/` has no
  hours group. `x-ratelimit-reset-requests` is the time to the **daily** RPD
  reset — hours-scale for most of the day (e.g. `"7h29m0s"`, `"23h59m0s"`).
  Those fail the regex → `parseDuration` returns `null` → `reset_requests_at:
  null` → the `daily_requests` bar (the window the comments call the one that
  matters) shows no reset countdown except in the final ~59 min before
  midnight. Fix: add optional `(?:(\d+)h)?` and fold hours into the total.
- L~200: 🟢 `test/groq.test.js` never exercises an hours-bearing reset string —
  add one (`"7h29m0s"`) to catch the L44 gap.

## usage-web-ui/vite.config.ts
- L8: 🟡 Dev server now binds `host: '0.0.0.0'` with `allowedHosts:
  ['usage.hoboguppy.com', …]`, exposing the unauthenticated vite dev server
  (HMR socket, source, `/usage` → daemon `127.0.0.1:8787` proxy) to the
  network. Anyone reaching it can drive the daemon auth/purge routes. Confirm
  this is Caddy/Tailscale-fronted only and not what serves the public host.

## usage-web-ui/src/client/SettingsView.tsx
- L159: 🟢 Token form reads its value via
  `document.getElementById(...).value` inside onClick instead of React
  state/ref — fragile, diverges from a controlled-input pattern. Cleanup.

## Verdict
One actionable bug (groq reset parser drops hours → RPD window loses its reset
time); one exposure question to confirm (vite `0.0.0.0` + public host); one
optional React cleanup. POST/DELETE `/auth` wiring, `runner.clearAuth`, and
`config.js` `api_key_file` resolution all check out.
