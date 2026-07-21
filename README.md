# Animepahe Batch Downloader

Chrome (MV3) extension that batch-downloads episodes from an open [animepahe](https://animepahe.ru)
anime page. Browser-extension port of [barestu/animepahe-downloader](https://github.com/barestu/animepahe-downloader).

Because it runs in your real browser, Cloudflare challenges are passed by your own session — no
`cf_clearance` cookie extraction needed.

## How it works

1. Open an anime page (`…/anime/<id>`), click the extension icon.
2. Popup lists all episodes (via animepahe's release API, using your logged-in cookies).
3. Pick episodes (checkboxes / range like `1-12,15`), quality, and audio → **Download**.
4. Per episode: the extension opens the kwik player in a hidden tab, sniffs the HLS `.m3u8`,
   then fetches + AES-128 decrypts the segments, muxes to `.mp4` with ffmpeg.wasm, and saves.

Default output: `Downloads/Anime/<title>/<title> - <ep> [<quality>p].mp4` (customizable in settings).

## Build & load (unpacked)

```bash
pnpm install
pnpm build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `dist/`.

Dev with HMR: `pnpm dev` (still load `dist/`; CRXJS hot-reloads).

## Architecture

| Context | Role |
|---------|------|
| Popup (Svelte) | Reads active tab, fetches episode list, batch UI, queue view |
| Service worker | Queue, DNR Referer rule, kwik m3u8 sniff, `chrome.downloads`, offscreen lifecycle |
| Offscreen doc | ffmpeg.wasm mux + blob URL (only context that can `createObjectURL`) |
| Content script | Forces `play()` on kwik so the manifest loads (kwik hosts only) |

See [SPEC.md](./SPEC.md) for full design, decisions, and security notes.

## Caveats / known risks

- **Personal use only.** Requests `<all_urls>` + `webRequest`; do not publish to the Web Store.
- Large 1080p episodes hold the full file in memory during mux — OOM possible on low-RAM machines.
- Depends on animepahe/kwik markup + kwik's HLS delivery; may break when they change.
- If kwik throws its own Cloudflare challenge in the hidden tab, extraction times out.
