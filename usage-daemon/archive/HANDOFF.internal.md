# Handoff — Claude Usage Surface

> **RECOVERED + RECONCILED 2026-07-11.** Written 2026-07-05, lost, recovered from the
> `cec09cc5` session log. Reconciled: **daemon = JS/node, not Go**; Phase 1/1.5/1.6/2
> are DONE; repo moved to `/sync/projects/usage/`. The daemon's concrete build spec is
> `../todo/HANDOFF-7-ollama-cloud-usage.md` (framework + runner + ollama plugin); the
> descriptor/meter lift-seam is `../todo/REFACTOR-1-descriptor-object.md`. Read those
> two for what to build now; this file is preserved context.

You are picking up a working project mid-stream. Read `PLAN.internal.md` first for the
full roadmap and standing decisions.

**From:** Claude Opus 4.8 · **Date:** 2026-07-05 · **User:** Daniel (`bubbabright` on GitHub)

---

## TL;DR of current state (2026-07-11)

- Both GNOME extensions (Claude + Grok) are **built, running, in daily use.**
  Phases 1 / 1.5 / 1.6 / 2 complete.
- **Next work = Phase 3: the Node/JS daemon.** Build spec = HANDOFF-7 (ollama is the
  first provider plugin). The daemon is **optional** — see the two-direction goal
  (`../README.md`): per-provider exts stay dual-mode (work with no daemon, read it when up),
  and a **generic** MCP (any client, any provider — not Claude-specific) + a unified
  multi-provider ext consume it. Do NOT frame this as "thin exts that only work via daemon."
- **Do not** rebuild anything that works. Do not relitigate standing decisions in
  `PLAN.internal.md` (especially: never auto-spend quota to refresh tokens).

## Ground truth you must know

1. **The 429 was a missing `User-Agent` header**, not a real quota limit. Fixed.
   If you see 429s again, check the header first.
2. **Token refresh cannot be forced cheaply.** Empirically tested:
   `claude --version` and `claude auth status` do NOT refresh the token in
   `~/.claude/.credentials.json`. Only a real model request does. So the design
   is passive: on 401, show last-known usage; never spend quota automatically.
3. **Backup (2026-07-13):** `/sync/projects` is **Syncthing-synced, single client → NAS,
   backed up on-change 24/7** (no longer CIFS). No concurrent-write corruption risk; local
   `.git` is already continuously backed up. Push to GitHub for remote sync/publishing, not
   as the sole backup — unpushed commits are not at risk.
4. **Data contract** (don't change without updating all consumers):
   `~/.cache/claude-code-usage/history.jsonl`, one line per poll:
   `{"t": <epoch ms>, "five_hour": <0-100>, "seven_day": <0-100>}`. The daemon
   generalizes this to the provider-agnostic `windows[]` snapshot (HANDOFF-7 §A2).

## How to work on the extensions

Each extension is its own git repo under `/sync/projects/usage/`. Each ships a
**run skill** (`.claude/skills/run-*`) with a `driver.sh` that does an isolated
dev-scoped side-by-side install (renamed uuid + schema so it can't collide with the
published extension). Use that, not hand-copied sync scripts.

**Verify without rebooting (Wayland):** nested shell —
`dbus-run-session -- gnome-shell --nested --wayland` — fresh schema cache every
launch, never touches the live panel. See `../todo/QA-LOG.md`.

**Validate before reloading:** `node --check extension.js && node --check prefs.js`.
You cannot see the GNOME panel from the CLI — the user is your eyes. Make small
changes and ask them to confirm.

## The HTML report

`report/usage-report.template.html` is a **self-contained, dependency-free** canvas
chart. `prefs.js` reads it, replaces two placeholders (`/*__USAGE_DATA__*/[]` →
`JSON.stringify(history)`, `/*__GENERATED_AT__*/0` → `Date.now()`), writes the result
to the cache dir, and launches it.

**Daemon migration:** to make it live against the daemon, change the injected
`const USAGE_DATA = ...` to
`const USAGE_DATA = await fetch('/usage/{provider}/history').then(r => r.json())`.
Nothing else in the template changes. The daemon serves this at `GET /?provider=…`.

## DO THIS NEXT — Phase 3 daemon (Node/JS)

Follow `../todo/HANDOFF-7-ollama-cloud-usage.md`:
1. Daemon skeleton: provider registry + `Provider` contract + runner + config loader.
2. Ollama plugin poll/parse — TDD against
   `../ollama-cloud-usage-extension/example-ollama-usage.html` fixture first.
3. HTTP surface (`/usage/ollama/current` + `/history`); verify with `curl`.
4. Report endpoint (fork template, live-fetch swap).
5. `ollama-cloud-usage-extension` parity client → repoint fetch at the daemon.
6. Later: **generic** MCP wrapper (any MCP client, any provider — not Claude-only); add the
   optional daemon-read path to the dual-mode Claude/Grok exts (they keep self-polling too).

## Verify your changes actually work
Never claim the panel/report looks right without the user confirming — you're
CLI-only. `node --check` proves syntax, not behavior.
