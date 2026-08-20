# Screenshots for the GitHub README

Drop PNG captures here using these exact filenames. The root [README.md](../../README.md) references them.

## Required

| File | What to capture |
|------|-----------------|
| `panel-bars.png` | Top panel with **side-by-side** monthly + weekly bars visible (Settings → Display → Stack panel bars **off**). Crop tight to the indicator. |
| `panel-bars-stacked.png` | Same, with **Stack panel bars** **on** (weekly bar above monthly). |
| `dropdown-menu.png` | Click the panel indicator; crop the open menu (monthly %, weekly entry, actions). |
| `preferences.png` | Preferences → **General** tab. |
| `preferences-display.png` | Preferences → **Display** tab (panel layout toggles). |

## Hero banner (optional)

Add your own `../feature-banner.png`, then put this under the `#` title in `README.md`:

```markdown
![Grok Usage Extension](docs/feature-banner.png)
```

## Tips

- Use a theme where panel text is readable (dark top bar works well).
- Wait for a successful weekly auto-poll so the W bar appears in panel shots.
- After changing layout prefs: `gnome-extensions disable grok-usage@bubbabright && gnome-extensions enable grok-usage@bubbabright`
- PNG only; no spaces in filenames.