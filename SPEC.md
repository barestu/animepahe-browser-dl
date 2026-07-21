# animepahe-browser-dl — Design Spec

Browser-extension port of [barestu/animepahe-downloader](https://github.com/barestu/animepahe-downloader).
Batch-download anime episodes from an open animepahe anime page. Uses the real browser, so
Cloudflare challenges are passed normally by the user's own session (no cookie-reuse hack needed).

> **Status: verified working end-to-end** on a live animepahe page (episode list → kwik sniff →
> segment fetch/decrypt → ffmpeg mux → mp4 saved). This spec reflects the as-built pipeline;
> sections marked _(as-built)_ changed from the original design during real-browser testing.

## Decisions (grilled)

| # | Branch | Decision |
|---|--------|----------|
| 1 | Browser target | Chrome/Chromium MV3 only. Firefox deferred. |
| 2 | HLS assembly | ffmpeg.wasm → real `.mp4` from day one. |
| 3 | Execution host | Offscreen Document, **sequential** episodes. |
| 4 | m3u8 extraction | Pure real-tab: let browser run kwik JS. |
| 5 | Capture mechanism | `chrome.webRequest` observer + content script to force `play()`. |
| 6 | Segment headers | `declarativeNetRequest` session rules add `Referer`/`Origin`. |
| 7 | Download location | Hybrid: `chrome.downloads` default + optional FSA custom folder _(FSA deferred, inert flag)_. |
| 8 | Naming | `Anime/{title}/{title} - {episode} [{quality}p].mp4`, editable template. |
| 9 | Batch UI | Popup-only (no anime-page injection). |
| 10 | Anime source | Active-tab only; requires `/anime/<session>`. |
| 11 | Queue | Persistent (`chrome.storage.local`), per-episode retry, skip+continue. |
| 12 | ffmpeg | Single-thread core, bundled locally, **copy-remux only**. |
| 13 | Stack | TS + Vite + `@crxjs/vite-plugin`, popup in Svelte. |
| 14 | Domains | Domain taken from the active tab's host, persisted; host perms `<all_urls>`. |
| 15 | Distribution | Unpacked / dev-mode load (no Web Store). |
| 16 | Segment fetch | Parallel pool (default **3**, clamped ≤4), all-in-memory, 429/503 backoff. |

## Cloudflare strategy _(as-built)_

The original plan fetched the animepahe API from the popup with `credentials:'include'`. That
**fails**: `cf_clearance` is `SameSite=Lax`, so it is NOT sent on a cross-site fetch from the
extension origin → Cloudflare 403. As-built fix:

- **All animepahe fetches run FIRST-PARTY inside the animepahe tab** via
  `chrome.scripting.executeScript` (`src/lib/tab-fetch.ts`). Same-origin → cookies + Referer are
  correct → Cloudflare passes.
- The **popup pre-resolves every selected episode's kwik link** at enqueue time (fetches the play
  page in-tab, parses sources, picks quality/audio). The service worker therefore **never fetches
  animepahe** — it only opens kwik tabs and drives the offscreen mux.
- The active tab's hostname (e.g. `animepahe.pw`) becomes the working domain and is persisted to
  settings so it stays consistent.

## Contexts

### Popup (Svelte)
- Reads active tab; requires animepahe `/anime/<session>` URL, else prompts user to open one.
- Fetches episode list `/api?m=release&id=<session>&sort=episode_asc&page=N` (paginated) and the
  anime title **first-party inside the tab** (`tab-fetch.ts`), not a cross-site fetch.
- On Download: resolves each selected episode's play page → kwik link in-tab, then sends the
  fully-resolved `Pick[]` (episode + quality + audio + kwikUrl) to the SW.
- UI: per-episode checkboxes, select-all, range input (e.g. `1-12,15`), quality + audio dropdown,
  Download button ("Resolving…" while pre-resolving).
- Queue/progress view: per-episode stage + segment count, failed list + retry button.
- Receives live `stateUpdate` broadcasts from the SW; refetches state on open.
- Header shows `v<version> · built <YYYY-MM-DD HH:mm>` (baked via Vite `define`) to identify the
  loaded build.

### Service worker
- Queue owner; state persisted in `chrome.storage.local` (survives SW sleep/restart).
- Sequential episode processing. Does **not** fetch animepahe (kwik links pre-resolved in popup).
- **`chrome.webRequest` m3u8 observer registered HERE** (offscreen can't use webRequest).
- **DNR session rules toggled HERE** (offscreen can't use DNR): kwik-nav rule per batch, CDN rule
  re-set per job with that job's kwik origin.
- Orchestrates offscreen lifecycle.
- **`chrome.downloads.download` called HERE** — receives blob-URL string from offscreen
  (offscreen and SW share extension origin, so the blob URL resolves), waits for `complete`, then
  messages offscreen to `revoke`.

### Offscreen document
- **Reason: `BLOBS`** (needs `URL.createObjectURL`, which is unavailable in the SW).
- Per-episode heavy work: segment fetch → decrypt → concat → ffmpeg mux → create blob URL.
- **Only `chrome.runtime` is available here** — no `chrome.downloads`/`webRequest`/DNR.
  Blob URL is messaged to the SW, which triggers the download.
- ffmpeg core loaded via **`chrome.runtime.getURL` (chrome-extension:// URL), NOT `toBlobURL`** —
  the ffmpeg worker does `import(coreURL)`, and MV3 CSP `script-src` forbids `blob:` dynamic
  imports but allows `'self'`. _(as-built; the blob approach threw "Failed to fetch dynamically
  imported module: blob:…".)_
- Reuses one ffmpeg instance across episodes (single offscreen doc, sequential).

### Content script (kwik hosts only)
- Injected into the background kwik tab; calls `video.play()` if the HLS manifest doesn't
  auto-load. No injection on the animepahe page.

## Per-episode pipeline _(as-built)_
1. **(popup, pre-enqueue)** Fetch play page `/play/<anime>/<episode>` in-tab → regex-parse
   per-quality kwik links (`button[data-src]` + `data-resolution`/`data-audio`) → pick target
   quality/audio (fallback to nearest). Result stored as the job's `kwikUrl`.
2. Batch start: DNR **kwik-nav rule** sets `Referer`+`Origin: https://<animepahe-domain>/` on kwik
   navigations (kwik's Cloudflare only allows the embed when Referer is animepahe).
3. Open the job's kwik URL in a background tab (`chrome.tabs.create {active:false}`).
   `chrome.webRequest.onBeforeRequest` observer catches `*.m3u8`; content script forces `play()`.
   Close tab on capture or 30s timeout.
4. DNR **CDN rule** re-set for this job: `Referer`+`Origin` = the job's kwik origin
   (e.g. `https://kwik.cx`) on `media`/`xmlhttprequest` (the CDN, e.g. `owocdn.top`, validates the
   embedding origin — using `kwik.si` when the embed was `kwik.cx` gets a 403).
5. Offscreen: fetch m3u8 + AES key + segments (pool default 3, clamped ≤4; per-segment retry on
   429/503 with exponential backoff honoring `Retry-After`) → WebCrypto AES-128-CBC decrypt each
   segment (IV from `#EXT-X-KEY` or media-sequence) → concat into one TS blob.
6. ffmpeg.wasm single-thread core (bundled), copy-remux:
   `-i in.ts -c copy -bsf:a aac_adtstoasc out.mp4`.
7. Save: offscreen creates blob URL → messages SW → `chrome.downloads.download` →
   `Downloads/Anime/{title}/{title} - {episode} [{quality}p].mp4`; SW waits for `complete`, then
   tells offscreen to revoke the URL.
   - Filename **sanitized**: illegal chars (`\ / : * ? " < > |` → `_`), `.`/`..` segments stripped
     (traversal guard), episode zero-padded, decimals (7.5) preserved.
   - _Optional FSA custom folder is designed but deferred — `Settings.useCustomFolder` is an inert
     flag; all saves currently go through `chrome.downloads`._
8. Retry N attempts on fail → mark failed → continue batch → report at end.

## Manifest _(as-built)_
- Permissions: `downloads`, `offscreen`, `storage`, `tabs`, `scripting`, `webRequest`,
  `declarativeNetRequestWithHostAccess`.
- `host_permissions`: `<all_urls>` (CDN hosts vary: owocdn/padorupado/nextcdn/vault…; TLD wildcards illegal).
- CSP `extension_pages`: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.
- `web_accessible_resources`: `assets/*` + `ffmpeg/*` (worker imports the core by extension URL).
- Content script matches: `*://*.kwik.si/*`, `*://*.kwik.cx/*` only.
- Active animepahe domain is derived from the tab and stored in settings (not hardcoded).

## Build / packaging _(as-built)_
- `scripts/copy-ffmpeg.mjs` copies `@ffmpeg/core` (single-thread ESM) into `public/ffmpeg/` at
  build (`public/ffmpeg/` is gitignored — regenerated). Ships as static extension assets; no
  remote code.
- The offscreen HTML is added as an explicit Vite rollup input — crxjs does not auto-discover
  offscreen documents (they're created at runtime), so without this it isn't bundled.
- Version + build timestamp injected via Vite `define` (`__APP_VERSION__`, `__BUILD_TIME__`).

## Deferred (post-MVP)
- Popup search box (`/api?m=search`).
- Resume partial episode (re-fetch only missing segments after crash).
- OPFS/IndexedDB streaming assembly (lower peak RAM for large 1080p).
- Multithread ffmpeg core (needs SAB + COOP/COEP).
- `.ts` fast-path (skip remux).
- Firefox port.

## Security

Personal unpacked tool, but tighten these:
- **`<all_urls>` + `webRequest` = read all network traffic.** Broadest possible surface. Acceptable
  for a self-loaded personal tool; document it. Do NOT publish with these perms.
- **DNR Referer/Origin rules are batch-scoped** _(as-built caveat)_: the CDN rule matches
  `media`/`xmlhttprequest` broadly (excluding animepahe + kwik hosts) because CDN hosts vary — it
  is **added on batch-start and removed on batch-end**, so the Referer/Origin rewrite is not
  always-on. This is the widest part of the surface; the batch-window scoping is the mitigation.
- **Path traversal:** episode title / number are attacker-influenced (page content). Sanitized per
  path segment: illegal chars + `.`/`..` stripped before building any filename (also guards a
  future FSA path, where the browser does not).
- **Content-script match scope = kwik hosts only**, never `<all_urls>`. Minimizes injection surface.
- **No remote code** (MV3 rule): ffmpeg core + all deps bundled; core loaded from a
  `chrome-extension://` URL, nothing fetched/eval'd from the network.
- **`cf_clearance` not stored / not touched** — animepahe fetches run first-party in the tab, so
  the cookie is sent by the browser; no `cookies` permission requested, nothing persisted.
- **webRequest observation** still allowed in MV3 (non-blocking) but Chrome is deprecating parts;
  m3u8 capture depends on it — fallback = content-script reads `video.src`/hls.js if webRequest
  observation is ever removed.

## Top risks
- **Kwik CF challenge** in the background tab may block the m3u8 → timeout. Handled for the embed
  via the Referer=animepahe nav rule; if kwik escalates, fallback = open the tab visibly for a
  manual solve.
- **CDN rate limiting (429)** on parallel segment fetches. Mitigated: concurrency clamped ≤4
  (default 3) + per-segment exponential backoff honoring `Retry-After`. Heavy batches may still
  need concurrency 1–2.
- **1080p memory peak** (~500MB–1GB) in offscreen → OOM. Mitigation path: OPFS streaming (deferred).
- **Markup drift** breaks the play-page regex parse (`button[data-src]` etc.) — the highest-drift
  point; m3u8 itself is captured by real-tab sniff so it's insulated from kwik JS obfuscation changes.
- **Cross-domain cf_clearance:** the working domain follows the active tab; opening a different
  animepahe TLD than the one you cleared could still 403 until that tab passes Cloudflare.

## Distribution
Unpacked: `pnpm install && pnpm build`, load `dist/` via `chrome://extensions` (developer mode).
No Web Store (would reject `<all_urls>` + content nature). README to document build+load.
