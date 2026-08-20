# Firecrawl Usage Extension

![GNOME Shell 46+](https://img.shields.io/badge/GNOME%20Shell-46%2B-blue)
![License](https://img.shields.io/badge/license-MIT-green)

Firecrawl credit balance, GNOME top panel.

Modeled on my [Claude](https://github.com/bubbabright/claude-usage-extension) and
[Grok](https://github.com/bubbabright/supergrok-usage-extension) extensions. Polls
`GET /v2/team/credit-usage` using API key [firecrawl CLI](https://docs.firecrawl.dev)
already stores locally.

No headless browser. No scraping. Firecrawl's credit-usage endpoint public, documented.

## Where this fits

**Standalone by default.** Own engine. Reads API key from
`~/.config/firecrawl-cli/credentials.json` (`firecrawl login`). **No daemon required.**

Also **R&D workbench** for Firecrawl. API moves, I adapt here, then copy
proven engine into [usage-daemon](https://github.com/bubbabright/usage-daemon) as
firecrawl plugin. Multi-provider + web dashboard then show Firecrawl, zero
extension edits.

Panel UX kept in parity with Claude/Grok extensions where data model allows.
**One thing genuinely differs**, UI diverges to match (see "ext divergence rule"
in [suite README](../README.md)): Firecrawl credits **roll over indefinitely** — no
hard per-cycle cap. `remainingCredits` can sit well above `planCredits` for months if
burn low. So:

- Panel shows **raw remaining-credit count**, not percentage — "887%" would be
  accurate but useless.
- Progress bar represents remaining credits **capped at one cycle's worth**
  (`min(100, 100 * remaining / plan)`), still reads "topped up" vs. "running low."
- Depletion warning is **runway projection** (days until balance hits zero at
  observed burn rate), not "will exceed 100% before period end" check — no period
  boundary to project against.

Standing rule: **never auto-spend quota just to refresh a status token.** Nothing to
refresh here anyway — CLI's API key static, no OAuth expiry.

## Features

| Feature | Description |
|---------|-------------|
| Balance monitoring | Polls `GET /v2/team/credit-usage`, shows remaining credits + capped progress bar. |
| Runway projection | Least-squares burn rate on credit balance; warns if on track to hit zero within N days. |
| History tracking | In-memory ring buffer (~20k samples, ~70 days) of polls. |
| HTML reports | Self-contained offline report: auto-scaled balance chart plus burn-rate table. |
| CSV export | Historical usage from dropdown or Settings. |
| Hover tooltip | Timestamp of last successful poll. |
| Offline resilience | Last successful values, marked stale if fetching fails. |
| Customization | Refresh interval, panel columns, runway threshold, proxy support. |

### Panel menu

- Remaining credits + plan credits per cycle + cycle % + last-poll time
- Runway estimate ("exhausted in ~N days" or "balance steady or growing")
- Open firecrawl.dev Usage, Open usage report, Export history (CSV), Settings, About

## Data source

Auth: firecrawl CLI's stored API key in `~/.config/firecrawl-cli/credentials.json`
(`firecrawl login` or `firecrawl config`).

| Endpoint | Notes |
|----------|-------|
| `GET https://api.firecrawl.dev/v2/team/credit-usage` | Bearer auth. JSON: `remainingCredits`, `planCredits`, `billingPeriodStart`, `billingPeriodEnd`. Official, documented endpoint. |

`apiUrl` in same credentials file overrides API base (self-hosted Firecrawl),
read-only, same as key.

## HTML report

**Open usage report** (panel menu or Settings → History) writes
`~/.cache/firecrawl-usage/usage-report.html`, opens in browser. Fully offline (no
CDN, no fetch), history baked in.

### Chart

Remaining-credit balance over time, **auto-scaled y-axis** (not 0-100%, since balance
can run above one cycle's plan), dashed reference line at current plan-credits
level. Hover for timestamps; switch ranges (24h / 7d / 30d / all-time) with controls.

### Burn-rate table

**Burn rate** table below chart summarizes credits consumed per period from
consecutive polls (negative values mean balance growing, not shrinking):

| | Now | Avg | Peak (date) |
|---|-----|-----|-------------|
| **Hourly** | Latest interval | Mean across intervals | Highest interval + when |
| **Daily** | … | … | … |
| **Weekly** | … | … | … |

Cells show **-** until enough poll history exists in selected range:

| Row | Minimum span for **Now** | Minimum intervals for **Avg** / **Peak** |
|-----|---------------------------|------------------------------------------|
| Hourly | 30 minutes | 2 |
| Daily | 6 hours | 2 |
| Weekly | 1 day | 2 |

More frequent polling fills table sooner. Regenerate report after new history
accumulates; static snapshot, not live.

## CSV export

Settings → History → **Export CSV…** (or dropdown's **Export history (CSV)**) writes
every recorded sample:

| Column | Format | Notes |
|--------|--------|-------|
| `timestamp` | ISO 8601 UTC | Millisecond precision, always UTC |
| `epoch_ms` | Unix epoch, milliseconds | Same instant, plain integer |
| `remaining` | Number | Raw `remainingCredits` from API |
| `plan` | Number | Raw `planCredits` for that poll's cycle |
| `pct` | Number, 0-100 (capped) | `min(100, 100 * remaining / plan)` |

Gaps in timestamps mean API unreachable then, not zero usage.

## Requirements

- GNOME Shell **46-49**
- firecrawl CLI installed, authenticated (`firecrawl login`) so
  `~/.config/firecrawl-cli/credentials.json` has valid API key

## Installation

### Option A: install.sh (recommended)

```bash
git clone https://github.com/bubbabright/firecrawl-usage-extension
cd firecrawl-usage-extension
./install.sh
```

Copies into `~/.local/share/gnome-shell/extensions/`, compiles schema, enables. Re-run
after `git pull`. Use `./install.sh --dry-run` to preview.

Then restart GNOME Shell if needed:

- **Wayland**: log out and back in.
- **X11**: `Alt+F2` → `r` → Enter.

### Option B: manual

```bash
git clone https://github.com/bubbabright/firecrawl-usage-extension
cp -r firecrawl-usage-extension \
  ~/.local/share/gnome-shell/extensions/firecrawl-usage@bubbabright
cd ~/.local/share/gnome-shell/extensions/firecrawl-usage@bubbabright/schemas
glib-compile-schemas .
gnome-extensions enable firecrawl-usage@bubbabright
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Panel stuck on `…` or `!` | Run `firecrawl login`; confirm `~/.config/firecrawl-cli/credentials.json` has `apiKey`. |
| `401`/`403` in logs | Key rejected: `firecrawl login` again, click refresh icon in panel menu. |
| Extension not listed / not ACTIVE | First install on Wayland usually needs log out/in; then `gnome-extensions enable firecrawl-usage@bubbabright`. |
| Prefs changes do not apply | `gnome-extensions disable firecrawl-usage@bubbabright && gnome-extensions enable firecrawl-usage@bubbabright`. |
| After `git pull` | Re-run `./install.sh` from repo root. |
| Report table all **-** | Need more polls in range; lower refresh interval, wait, regenerate. |
| Runway warning never fires | Balance must trend down over ≥6h of polls; growing/flat balance never warns. |

Logs: `journalctl -f -o cat /usr/bin/gnome-shell | grep 'Firecrawl Usage:'`

History: `~/.cache/firecrawl-usage/history.jsonl` · Report: `~/.cache/firecrawl-usage/usage-report.html`

## Related projects

- [claude-usage-extension](https://github.com/bubbabright/claude-usage-extension) (Claude standalone)
- [supergrok-usage-extension](https://github.com/bubbabright/supergrok-usage-extension) (Grok standalone)
- [ollama-cloud-usage-extension](https://github.com/bubbabright/ollama-cloud-usage-extension) (Ollama thin client; needs daemon)
- [multi-provider-usage-extension](https://github.com/bubbabright/multi-provider-usage-extension) (every daemon provider in one panel)
- [usage-daemon](https://github.com/bubbabright/usage-daemon) (optional hub)

## License

MIT, see [LICENSE](LICENSE)