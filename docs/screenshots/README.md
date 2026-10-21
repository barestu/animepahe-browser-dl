# Screenshot

The root README embeds one image, by exact name. Drop the PNG in this directory and the docs are
complete — no README edits needed.

| File | Shot |
|---|---|
| `popup.png` | Popup with the episode list, a range selected, quality and audio dropdowns visible |

This is the shot that tells a stranger what the extension is, so it should show the extension doing
its actual job: a real anime, several episodes checked, the dropdowns readable.

## Capture notes

- **2× DPI** (a HiDPI display, or Chrome DevTools device toolbar at 2× — not an upscaled 1× shot).
- The popup UI is dark-only, so the shot will be dark on both GitHub themes. That is expected.
- Crop tight to the popup. Leave out your profile avatar, other tabs, the bookmarks bar, and other
  extension icons. The episode list will contain an anime title — that is the point — but check
  nothing else personal is in frame.
- Keep it under ~500 KB. `pngquant` or `oxipng` if needed; this is committed to the repo.

Re-capture when the popup UI changes materially — a stale screenshot is worse than none.

If you later want more shots (badge verdict, queue mid-download, log panel, settings), add them
here and reference them from the README's Usage and Troubleshooting sections.
