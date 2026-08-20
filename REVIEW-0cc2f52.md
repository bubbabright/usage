# Review: commit 0cc2f52 (docs: update README for modern daemon tree)

## usage-daemon/README.md
- L12: 🟡 "Framework + runner" removed without replacement context. Consider adding "Express-based server + plugin registry" for clarity.
- L31: 🟢 "Default bind: 127.0.0.1:8787" moved from header to later section; header now lacks bind info. Add back to first paragraph.
- L45: 🟡 Provider list says "6 providers today" but README body only lists 4 in the table (ollama, claude, grok, mistral). Add opencode-go, codexbar to table or fix count.
- L78: 🟢 `/usage/headline`, `/metrics`, `/auth` endpoints documented — good.
- L110: 🟢 cwd-based config install path documented — good.
- L145: 🟢 "Zero runtime dependencies" claim removed — correct (Express is a dep).

## /mnt/nas/projects/usage/AGENTS.md
- L1: 🟢 High-level summary clear.
- L10: 🟡 "zero-touch multi-provider panel and web dashboard" — "zero-touch" implies no config; actually requires daemon running and provider plugins. Soften to "central poller".
- L15: 🟢 extensions table includes 9 providers (opencode-go, firecrawl, groq, etc.) — more than daemon's 6. Note this asymmetry or remove unused.
- L22: 🟢 Dev workflow commands accurate (npm start, npm dev, npm test).
- L30: 🟢 Key design points correct and concise.

## Verdict
README.md solid update (minor table count mismatch); AGENTS.md accurate but "zero-touch" slightly overstated.