# HANDOFF: usage-daemon-modern — every file, TL;DR style

Date: 2026-07-19. State: dev tree, not running, not a git repo yet.

## One line

Old zero-dep daemon + new React/Vite/Tailwind web UI fused into **one Express process, one port** — daemon polls providers, same process serves the SPA. Web UI is now the primary client.

## The big picture

```
providers (5) → runner (scheduler) → snapshot {windows[], status, stale}
                    ↓                        ↓
             store (history.jsonl)    express /usage/* API
                                             ↓
                              React SPA (vite dev middleware or dist/)
```

Two trees exist. `../usage-daemon/` = old production repo (git, zero-dep, server-rendered HTML dashboard). **This tree** = modern fork: same daemon core, plus React client, plus Express, plus a deliberate design change — **everything lives in the project dir** (see "Self-contained drift" below).

## File-by-file

### Root

| File | TL;DR |
|---|---|
| `index.html` | Vite SPA entry. Empty `#root` + `<script src="/src/client/main.tsx">`. |
| `vite.config.ts` | React + Tailwind v4 plugins, build → `dist/`. No proxy needed (same origin). |
| `package.json` | `dev`/`start` = `node src/index.js` (one process = daemon + UI). `build` = vite. `test` = node --test. Real deps now: express 5, react 19, recharts 3, date-fns 4, lucide, tailwind 4, vite 8, TS 7. Zero-dep era over. |
| `config.example.toml` | Documented config shape. TOML on purpose (no YAML — see old README). |
| `install.sh` | OLD-tree installer (clone to `~/.local/share/usage-daemon`, systemd unit, port 8787). Not yet updated for modern tree. |
| `tsconfig.json` | TS config for client. |
| `bun.lock` + `package-lock.json` | Both exist — bun and npm both touched this tree. Pick one eventually. |
| `README.md` | Copied from old tree. **Stale**: says zero-dep, no mention of React client, `src/client/`, express, opencode-go provider, or `/metrics`. |
| `HANDOFF-modern-tree-tour.md` | This file. |

### src/ — daemon core

| File | TL;DR |
|---|---|
| `index.js` | Entry. Imports `ipv4.js` FIRST (dns patch), loads config, registers 5 providers, starts Runner, builds Express app: `/usage/*` API router + `/metrics` (Prometheus text) + SPA (vite middlewareMode in dev, static `dist/` when `NODE_ENV=production`). Listens `0.0.0.0:cfg.port` (was hardcoded 3000; fixed this session to use config = 8787). |
| `config.js` | Minimal hand-rolled TOML parser (sections, strings, ints, bools, comments). **Reads `<cwd>/config.toml`** — not `~/.config/usage-daemon/`. `expandHome()` maps `~` → **cwd** too. Resolves `cookie_file`/`admin_key_file` contents into config. Missing file → defaults (ollama only). |
| `registry.js` | name → factory Map. Compiled-in on purpose, no dynamic loading. 24 lines. |
| `runner.js` | The heart. Per-provider setInterval; `poll()` = fetch → pure parse → normalize (`toHostIso` on resets, `willDeplete` from history) → snapshot → `store.append`. Fail-soft `_markStale()`: keeps last-known windows, falls back to on-disk history after restart (rebuilds windows from config labels/colors, resets_at null). Also `setCookie` (writes 0600 file, re-poll), `setAuthPayload`, `clearCookie`. Never blanks data, never invents zeros. |
| `store.js` | Append-only `history.jsonl` per provider, compact rows `{t, tier, <windowId>: pct}`. Trim to 20k lines. **Writes to `<cwd>/.local/state/usage-daemon/<provider>/`** — in-project, NOT `~/.local/state`. |
| `burnrate.js` | Least-squares slope over recent history → `will_deplete` bool per window (hits 100% before reset?). 44 lines. |
| `time.js` | `toHostIso()` — every timestamp re-rendered as ISO-8601 in host-local TZ with explicit offset. Instant unchanged. |
| `ipv4.js` | Monkey-patches `dns.lookup` to family:4. Lab has broken IPv6; without this, undici fetch to AAAA hosts (anthropic, grok) hangs to timeout. Must import before any fetch. |
| `http.js` | Express router for `/usage/*`: providers list, per-provider config/current/history/refresh, icon + icons (variant lookup in `providers/icons/`), POST cookie (text or JSON), POST auth (oauth-file paste — NEW vs old tree), DELETE cookie. 64kb body cap. Cookies never echoed back. |
| `dashboard.js` | OLD server-rendered multi-provider dashboard (`GET /`). **Dead code in modern tree** — SPA took over `/`. 524 lines. |
| `report.js` | OLD single-provider HTML report (`GET /?provider=x`). **Also dead** in modern tree. |

### src/providers/ — plugins (each: `createProvider()` → id/label, auth, config(), configure(), intervalSeconds(), fetch(), pure parse(), optional meta())

| File | Auth | TL;DR |
|---|---|---|
| `claude.js` | oauth-file | Reads `~/.claude/.credentials.json` READ-ONLY (never refreshes token). GET api.anthropic.com/api/oauth/usage with `claude-code/2.1.0` UA (else 429s). Windows: session (5h, orange) then weekly (7d, blue). Expired → `auth_expired`, last-known stays. |
| `grok.js` | oauth-file | Reads `~/.grok/auth.json`. Monthly billing + weekly via gRPC-web envelope parse. Windows: weekly, monthly. Biggest plugin (417 lines). |
| `ollama.js` | cookie | Scrapes ollama.com/settings HTML. Windows: session, weekly. |
| `mistral.js` | cookie (+optional admin key) | admin.mistral.ai tRPC `billing.budget` for free Vibe + API meters (ready-made %, backs off to a capped interval once Vibe hits 100% until reset); optional Admin API key adds $ monthly spend window. Windows: vibe_monthly, api_monthly, monthly_spend. |
| `opencode-go.js` | cookie | Scrapes workspace Go page hydration JSON. Needs `workspace_id` in config. Windows: 5h rolling (green), weekly (blue), monthly (orange). Newest plugin. |
| `icons/` | — | svg/png per provider, `-dark`/`-light` variants, served by `/usage/:p/icon?variant=`. |

Colors are Okabe-Ito palette, suite-wide convention. `windows[]` array order = client display order (clients never sort).

### src/client/ — React SPA (the primary client now)

| File | TL;DR |
|---|---|
| `main.tsx` | ReactDOM.createRoot + StrictMode. 10 lines. |
| `App.tsx` | Everything-component. Fetches `/usage/providers` every 30s; sidebar (provider list + status dots: green ok / amber stale / red error), selecting fetches config+current+history in parallel. `ProviderDashboard`: header (tier badge, status, Force Poll → POST refresh), per-window cards (pct, color bar, resets-in, will_deplete warning), Recharts LineChart of history (transforms rows → `{time, <label>: pct}`). `settings` is a fake provider id routing to SettingsView. |
| `SettingsView.tsx` | Per-provider auth cards: cookie kind → textarea + Set/Flush (POST/DELETE `/cookie`); oauth-file kind → paste JSON → POST `/auth`. Alert-threshold inputs are **UI-only, wired to nothing**. |
| `index.css` | Tailwind entry + custom scrollbar. |

### test/

Fixture-driven pure-parse + burnrate tests, `node --test`. Vendored HTML/JSON fixtures per provider — no network in tests.

### local/ — relocated runtime artifacts (this session)

| Path | What |
|---|---|
| `local/state/usage-daemon/` | REAL history from old daemon (claude 1278 rows, mistral 935, opencode-go 261, grok 178, ollama 13 + daemon.log/pid/zip strays). Was `~/.local/state/usage-daemon`; **moved here, symlink left behind**. |
| `local/share/usage-daemon/` | install.sh's clone of old repo (identical to `../usage-daemon` @ ee5076d). Was `~/.local/share/usage-daemon`; **moved here, symlink left behind**. |
| `local/systemd/usage-daemon.service` | Copy of the user unit. Original still at `~/.config/systemd/user/` (systemd needs it there). |

### .local/ — modern tree's OWN state dir

`.local/state/usage-daemon/ollama/history.jsonl` — created by store.js (`<cwd>/.local/state/...`) during a brief dev run. **This is where the modern daemon writes.** Separate from `local/state/` above. See gotcha #1.

## Self-contained drift (important design fact)

Modern tree deliberately re-rooted "home" paths to the project dir: `config.js` reads `<cwd>/config.toml`, `expandHome('~')` → cwd, `store.js` writes `<cwd>/.local/state/`. Old tree used real `~/.config`, `~/.local/state`. Nobody wrote the project-local `config.toml` yet, so a bare start loads defaults = ollama only. Provider credential paths hardcoding `os.homedir()` (claude, grok) still read real HOME — mixed model.

## Deployment state right now

- **Nothing running.** Old systemd daemon stopped (still `enabled` — respawns at next login unless disabled). Port 8787 free.
- Old paths all resolve via symlinks into this project. Nothing deleted.
- `node_modules` installed. `dist/` not built yet (dev mode = vite middleware, no build needed).

## Gotchas / open items (priority order)

1. **Two state dirs.** Real history in `local/state/` (moved from `~`); modern daemon writes to `.local/state/`. Unify (point store.js at one, or move rows) or web UI charts start near-empty.
2. **No project-local `config.toml`.** Copy from `~/.config/usage-daemon/config.toml` (port 8787, all 5 providers) into project root — else only ollama loads. Add cookie files similarly (`expandHome` puts `~/...` cookie paths under cwd now).
3. **Binds `0.0.0.0`**, old tree bound localhost. Fine for Tailscale-era plans; know that it's open on LAN.
4. `/metrics` skips non-ok providers entirely — a dead provider silently vanishes from Prometheus instead of reporting status 0.
5. `README.md` stale (pre-React). `dashboard.js`/`report.js` dead code.
6. Settings alert thresholds are decorative — no backend.
7. Old systemd unit still points at old tree via `~/.local/share/usage-daemon` symlink → starting it now runs OLD daemon against relocated files. Write a new unit for this tree when it graduates.
8. Not a git repo. `git init` when ready; old tree stays the published GitHub repo until cutover.
9. bun.lock + package-lock.json both present — pick one.

## Start it

```sh
cd /mnt/nas/projects/usage/usage-daemon-modern
node src/index.js        # daemon + web UI on cfg.port (8787), vite dev mode
# browse http://127.0.0.1:8787/
```

Prod later: `npm run build` then `NODE_ENV=production node src/index.js` (serves dist/).
