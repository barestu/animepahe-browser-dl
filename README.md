# Animepahe Batch Downloader

Chrome (MV3) extension that batch-downloads episodes from an open [animepahe](https://animepahe.ru)
anime page.

Because it runs in your real browser, Cloudflare challenges are passed by your own session — no
`cf_clearance` cookie extraction needed.

## How it works

1. Open an anime page (`…/anime/<id>`), click the extension icon. The toolbar icon itself carries
   the verdict — a green ✓ corner when the tab is downloadable, a red ✗ when you're on animepahe
   but the wrong page, plain when the tab is unrelated — matched by a ✓/✗ badge and repeated with
   the reason inside the popup.
2. Popup lists all episodes (via animepahe's release API, using your logged-in cookies).
3. Pick episodes (checkboxes / range like `1-12,15`), quality, and audio → **Download**.
4. Per episode: the extension opens the kwik player in a hidden tab, sniffs the HLS `.m3u8`,
   then fetches + AES-128 decrypts the segments, muxes to `.mp4` with ffmpeg.wasm, and saves.

Default output: `Downloads/Anime/<title>/<title> - <ep> [<quality>p].mp4` (customizable in settings).

Quality is a *request*, not a guarantee: each play page is parsed for whatever heights it actually
offers (releases are not limited to 360/480/720/1080 — movies and some fansub encodes list
off-ladder heights), and the nearest available one to your pick is used.

## Features

- **Batch queue** — one episode at a time, progress per segment, automatic retry on transient
  CDN errors.
- **Pause / resume** — cooperative, so pausing preserves in-flight work: already-fetched segments
  are kept and resume continues the same run.
- **Cancel** (one job or the whole batch) — two-step arm, no modal. A canceled job disappears from
  the queue; that *is* the confirmation.
- **Retry** a failed episode without re-picking it.
- **Auto-clear** — completed jobs are dropped when the batch drains, leaving a "N episodes done"
  receipt and only what still needs attention. Toggleable in settings.
- **Built-in log terminal** — live diagnostic tail in the popup, with copy-to-clipboard and clear.
  This is what to paste when reporting a breakage.
- **Settings** — animepahe domain (auto-corrected to whichever mirror the tab is on), filename
  template (`{title} {episode} {quality} {audio}`), auto-clear toggle.

## Requirements

- Chrome / Chromium **116+** (offscreen documents, `declarativeNetRequestWithHostAccess`).
- Node 18+ and `pnpm`.

## Build & load (unpacked)

```bash
pnpm install
pnpm build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `dist/`.

Dev with HMR: `pnpm dev` (still load `dist/`; CRXJS hot-reloads).

Other scripts:

| Script | What it does |
|---|---|
| `pnpm build` | `copy:ffmpeg` + `gen:icons` + `tsc --noEmit` + `vite build` → `dist/` |
| `pnpm dev` | same prep, then Vite with CRXJS HMR |
| `pnpm check` | `svelte-check` — type-checks `.svelte` files (`tsc` alone does not) |
| `pnpm copy:ffmpeg` | refresh `public/ffmpeg/` from `node_modules/@ffmpeg/core` |
| `pnpm gen:icons` | rasterize `design/icon.svg` → `public/icons/*.png` |

There is no test framework. Verification is `pnpm build`, `pnpm check`, and exercising the
extension against a live animepahe page. `public/ffmpeg/`, `public/icons/` and `dist/` are
generated — never hand-edited. The popup header shows the version and build timestamp so you can
tell which build is loaded.

## Architecture

| Context | Role |
|---------|------|
| Popup (Svelte) | Reads active tab, fetches episode list, resolves each kwik URL first-party, batch UI, queue view, log tail |
| Service worker | Queue, DNR Referer rules, kwik m3u8 sniff, pause/cancel gate, `chrome.downloads`, offscreen lifecycle, per-tab badge |
| Offscreen doc | Segment fetch + AES-128 decrypt, ffmpeg.wasm mux, blob URL (only context that can `createObjectURL`) |
| Content script | Forces `play()` on kwik so the manifest loads (kwik hosts only) |

The split is forced by Chrome: the service worker cannot fetch animepahe (Cloudflare's
`cf_clearance` is `SameSite=Lax`, so every animepahe request runs *inside the animepahe tab*), and
it cannot call `createObjectURL`. Referer/Origin are forbidden headers for `fetch()`, so
`declarativeNetRequest` session rules supply them for kwik and the CDN; both are removed when the
batch ends.

See [SPEC.md](./SPEC.md) for full design, decisions, and security notes, and
[CLAUDE.md](./CLAUDE.md) for the working map of the codebase.

## Caveats / known risks

- **Personal use only.** Requests `<all_urls>` + `webRequest`; do not publish to the Web Store.
- Large 1080p episodes hold the full file in memory during mux — OOM possible on low-RAM machines.
- Depends on animepahe/kwik markup + kwik's HLS delivery; may break when they change. When it does,
  the play-page parser is the usual culprit — the log panel prints page markers and a markup sample.
- If kwik throws its own Cloudflare challenge in the hidden tab, extraction times out (30 s).
- Segment concurrency is clamped to ≤4; the CDN returns 429 above that.
