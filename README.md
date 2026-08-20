# usage

Personal stack for usage tracking. 

**Shape:** daemon plugins fetch/parse each provider and publish one shape —
`windows[]` meters (pct, color, reset, will_deplete). The web UI just renders
it. Add a provider on the daemon → the UI lights up.

## Active

| Project | What | Status |
|---|---|---|
| [usage-daemon/](usage-daemon/) | Node/JS hub. Plugins + `/usage/*` API.
| [usage-web-ui/](usage-web-ui/) | React/Vite dashboard. Reads the daemon.
reference, not active.

## Design notes

- History: daemon JSONL under `~/.local/state/usage-daemon/<provider>/history.jsonl`.
- Last-known on failure — never blank the panel.
