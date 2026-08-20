# Firecrawl Usage Extension

![GNOME Shell 46+](https://img.shields.io/badge/GNOME%20Shell-46%2B-blue)
![License](https://img.shields.io/badge/license-MIT-green)

Firecrawl credit balance in the GNOME top panel.

Modeled on my [Claude](https://github.com/bubbabright/claude-usage-extension) and
[Grok](https://github.com/bubbabright/supergrok-usage-extension) extensions. Polls
`GET /v2/team/credit-usage` using the API key the [firecrawl CLI](https://docs.firecrawl.dev)
already stores locally.

No headless browser. No scraping. Firecrawl's credit-usage endpoint is public and documented.

## Where this fits

**Standalone by default.** Own engine. Reads the API key from
`~/.config/firecrawl-cli/credentials.json` (`firecrawl login`). **No daemon required.**

This is also the **R&D workbench** for Firecrawl. If the API moves, I adapt here, then copy
the proven engine into [usage-daemon](https://github.com/bubbabright/usage-daemon) as the
firecrawl plugin. Multi-provider and the web dashboard then show Firecrawl with zero
extension edits.

I keep panel UX in parity with the Claude/Grok extensions where the data model allows.
**One thing genuinely differs**, and the UI diverges to match it (see "ext divergence rule"
in the [suite README](../README.md)): Firecrawl credits **roll over indefinitely** — there
is no hard per-cycle cap. `remainingCredits` can sit well above `planCredits` for months if
you're not burning much. So:

- The panel shows a **raw remaining-credit count**, not a percentage — "887%" would be
  accurate but useless.
- The progress bar represents remaining credits **capped at one cycle's worth**
  (`min(100, 100 * remaining / plan)`), so it still reads as "topped up" vs. "running low."
- The depletion warning is a **runway projection** (days until the balance hits zero at the
  observed burn rate), not a "will exceed 100% before period end" check — there's no period
  boundary to project against.

Standing rule: **never auto-spend quota just to refresh a status token.** There's nothing to
refresh here anyway — the CLI's API key is static, no OAuth expiry.

## Features

| Feature | Description |
|---------|-------------|
| Balance monitoring | Polls `GET /v2/team/credit-usage` and shows remaining credits + a capped progress bar. |
| Runway projection | Least-squares burn rate on the credit balance; warns if on track to hit zero within N days. |
| History tracking | In-memory ring buffer (~20k samples, ~70 days) of polls. |
| HTML reports | Self-contained offline report: auto-scaled balance chart plus burn-rate table. |
| CSV export | Historical usage from the dropdown or Settings. |
| Hover tooltip | Timestamp of the last successful poll. |
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

`apiUrl` in the same credentials file overrides the API base (self-hosted Firecrawl),
read-only, same as the key.

## HTML report

**Open usage report** (panel menu or Settings → History) writes
`~/.cache/firecrawl-usage/usage-report.html` and opens it in the browser. Fully offline (no
CDN, no fetch) with history baked in.

### Chart

Remaining-credit balance over time on an **auto-scaled y-axis** (not 0-100%, since balance
can run above one cycle's plan), with a dashed reference line at the current plan-credits
level. Hover for timestamps; switch ranges (24h / 7d / 30d / all-time) with the controls.

### Burn-rate table

A **Burn rate** table below the chart summarizes credits consumed per period from
consecutive polls (negative values mean the balance is growing, not shrinking):

| | Now | Avg | Peak (date) |
|---|-----|-----|-------------|
| **Hourly** | Latest interval | Mean across intervals | Highest interval + when |
| **Daily** | … | … | … |
| **Weekly** | … | … | … |

Cells show **-** until enough poll history exists in the selected range:

| Row | Minimum span for **Now** | Minimum intervals for **Avg** / **Peak** |
|-----|---------------------------|------------------------------------------|
| Hourly | 30 minutes | 2 |
| Daily | 6 hours | 2 |
| Weekly | 1 day | 2 |

More frequent polling fills the table sooner. Regenerate the report after new history
accumulates; it is a static snapshot, not live.

## CSV export

Settings → History → **Export CSV…** (or the dropdown's **Export history (CSV)**) writes
every recorded sample:

| Column | Format | Notes |
|--------|--------|-------|
| `timestamp` | ISO 8601 UTC | Millisecond precision, always UTC |
| `epoch_ms` | Unix epoch, milliseconds | Same instant, plain integer |
| `remaining` | Number | Raw `remainingCredits` from the API |
| `plan` | Number | Raw `planCredits` for that poll's cycle |
| `pct` | Number, 0-100 (capped) | `min(100, 100 * remaining / plan)` |

Gaps in timestamps mean the API was unreachable then, not zero usage.

## Requirements

- GNOME Shell **46-49**
- firecrawl CLI installed and authenticated (`firecrawl login`) so
  `~/.config/firecrawl-cli/credentials.json` has a valid API key

## Installation

### Option A: install.sh (recommended)

```bash
git clone https://github.com/bubbabright/firecrawl-usage-extension
cd firecrawl-usage-extension
./install.sh
```

Copies into `~/.local/share/gnome-shell/extensions/`, compiles the schema, enables. Re-run
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
| Panel stuck on `…` or `!` | Run `firecrawl login`; confirm `~/.config/firecrawl-cli/credentials.json` has an `apiKey`. |
| `401`/`403` in logs | Key rejected: `firecrawl login` again, then click the refresh icon in the panel menu. |
| Extension not listed / not ACTIVE | First install on Wayland usually needs log out/in; then `gnome-extensions enable firecrawl-usage@bubbabright`. |
| Prefs changes do not apply | `gnome-extensions disable firecrawl-usage@bubbabright && gnome-extensions enable firecrawl-usage@bubbabright`. |
| After `git pull` | Re-run `./install.sh` from the repo root. |
| Report table all **-** | Need more polls in range; lower refresh interval, wait, regenerate. |
| Runway warning never fires | Balance must be trending down over ≥6h of polls; a growing/flat balance never warns. |

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
