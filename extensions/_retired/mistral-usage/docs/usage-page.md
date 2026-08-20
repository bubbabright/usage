# Mistral API-plan Usage page (captured 2026-07-13)

Source: <https://admin.mistral.ai/organization/usage> — the **$ spend dashboard**. This is the browser front of the documented Admin API `GET /admin/usage`. (SVG chart markup stripped.)

Period shown: **June 2026**. All zero (no paid API usage).

## Overview — Total Cost: 0 USD
Breakdown categories (each 0.00 USD):
- Completion
- OCR
- Agents / Connectors
- Libraries API
- Audio
- **Total: 0.00 USD**

## Cost Per Day
Recharts line chart, x-axis = days of month (2…7/30), y-axis = USD 0–4. (Empty here.)
Series: `completion`, `ocr`, `connectors`, `libraries`, `audio`.

## Per-category detail
- **Completion API** — Regular + Batch, per-model breakdown (0 USD).
- **OCR API** — per-model (`mistral-ocr-latest` / `mistral-ocr-4-launch`), 0 USD.
- **Agents API** — no connectors usage June 2026.
- **Libraries API** — none.
- **Document Library Storage** — none.
- **Audio (Completion & Transcription)** — none.

## Mapping
Confirms `GET /admin/usage` returns exactly these categories (`chat/completion, ocr, connectors, libraries_api, audio, fine_tuning, vibe_usage`) + period + currency. The **Cost Per Day** series is the history feed → maps to daemon history rows. Denominator for a % meter still needs `GET /admin/spend-limit`.
