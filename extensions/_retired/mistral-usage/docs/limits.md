# Mistral org limits (captured 2026-07-13)

Source: <https://admin.mistral.ai/plateforme/limits>

Per-model completion rate limits (TPM = tokens/min, RPS = requests/sec). Static-ish org config — usable as **fallback denominators** for a rate-limit meter when the live `/admin/rate-limit` call isn't available.

## Completion rate limits per model

| Model | TPM | RPS |
|---|---|---|
| codestral-2508 | 625,000 | 2.08 |
| codestral-embed | 50,000 | 1.00 |
| devstral-2512 | 1,000,000 | 0.83 |
| labs-leanstral-1-5-1 | 5,000,000 | 0.63 |
| magistral-medium-2509 | 75,000 | 0.08 |
| magistral-small-2509 | 25,000 | 0.03 |
| ministral-14b-2512 | 937,500 | 0.50 |
| ministral-3b-2512 | 1,300,000 | 12.50 |
| ministral-8b-2512 | 625,000 | 3.13 |
| mistral-embed-2312 | 20,000,000 | 1.00 |
| mistral-large-2512 | 250,000 | 0.07 |
| mistral-medium-2505 | 375,000 | 0.42 |
| mistral-medium-2508 | 356,250 | 0.38 |
| mistral-medium-latest | 25,000 | 0.83 |
| mistral-moderation-2603 | 50,000 | 1.67 |
| mistral-small-2506 | 2,250,000 | 5.00 |
| mistral-small-2603 | 50,000 | 0.83 |
| open-mistral-nemo | 500,000 | 0.50 |
| voxtral-mini-2602 | 50,000 | 1.00 |
| voxtral-mini-transcribe-realtime-2602 | 50,000 | 1.00 |
| voxtral-mini-tts-2603 | 50,000 | 1.00 |
| voxtral-small-2507 | 50,000 | 1.00 |

## Audio
- Audio seconds per minute: 3,600
- Audio seconds per month: — (none)

## OCR
- Pages per minute: 625

## Documents
- Max upload file size: 100 MB (range 1 MB – 250 MB)
