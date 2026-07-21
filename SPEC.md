# animepahe-browser-dl — Design Spec

Browser-extension port of [barestu/animepahe-downloader](https://github.com/barestu/animepahe-downloader).
Batch-download anime episodes from an open animepahe anime page. Uses the real browser, so
Cloudflare challenges are passed normally by the user's own session (no cookie-reuse hack needed).

## Decisions (grilled)

| # | Branch | Decision |
|---|--------|----------|
| 1 | Browser target | Chrome/Chromium MV3 only. Firefox deferred. |
| 2 | HLS assembly | ffmpeg.wasm → real `.mp4` from day one. |
| 3 | Execution host | Offscreen Document, **sequential** episodes. |
| 4 | m3u8 extraction | Pure real-tab: let browser run kwik JS. |
| 5 | Capture mechanism | `chrome.webRequest` observer + content script to force `play()`. |
| 6 | Segment headers | `declarativeNetRequest` session rules add `Referer`/`Origin`. |
| 7 | Download location | Hybrid: `chrome.downloads` default + optional File System Access custom folder. |
| 8 | Naming | `Anime/{title}/{title} - {episode} [{quality}p].mp4`, editable template. |
| 9 | Batch UI | Popup-only (no anime-page injection). |
| 10 | Anime source | Active-tab only; requires `/anime/<session>`. |
| 11 | Queue | Persistent (`chrome.storage.local`), per-episode retry, skip+continue. |
| 12 | ffmpeg | Single-thread core, bundled locally, **copy-remux only**. |
| 13 | Stack | TS + Vite + `@crxjs/vite-plugin`, popup in Svelte. |
| 14 | Domains | Configurable base + broad host perms (`<all_urls>`). |
| 15 | Distribution | Unpacked / dev-mode load (no Web Store). |
| 16 | Segment fetch | Parallel pool (~6), all-in-memory, configurable. |

## Contexts

### Popup (Svelte)
- Reads active tab; requires animepahe `/anime/<session>` URL, else prompts user to open one.
- Fetches episode list: `/api/?m=release&id=<session>&sort=episode_asc&page=N` (paginated),
  `credentials:'include'` → rides the browser's `cf_clearance` cookie.
- UI: per-episode checkboxes, select-all, range input (e.g. `1-12`), quality + audio dropdown,
  Download button.
- Queue/progress view: per-episode stage, overall progress, failed list + retry button.
- Reconnects to live SW state on reopen (runtime port).

### Service worker
- Queue owner; state persisted in `chrome.storage.local` (survives SW sleep/restart).
- Sequential episode processing.
- **`chrome.webRequest` m3u8 observer registered HERE** (offscreen can't use webRequest).
- **DNR session rules toggled HERE** (offscreen can't use DNR).
- Orchestrates offscreen lifecycle.
- **`chrome.downloads.download` called HERE** — receives blob-URL string from offscreen
  (offscreen and SW share extension origin, so the blob URL resolves).

### Offscreen document
- **Reason: `BLOBS`** (needs `URL.createObjectURL`, which is unavailable in the SW).
- Per-episode heavy work: segment fetch → decrypt → concat → ffmpeg mux → create blob URL.
- **Only `chrome.runtime` is available here** — no `chrome.downloads`/`webRequest`/DNR.
  Blob URL is messaged to the SW, which triggers the download; FSA custom-folder writes are
  done here directly (stored dir handle, no gesture needed).
- Must stay alive until the SW confirms the download started; then revoke URL + tear down
  ffmpeg instance between episodes to release memory.

### Content script (kwik hosts only)
- Injected into the background kwik tab; calls `video.play()` if the HLS manifest doesn't
  auto-load. No injection on the animepahe page.

## Per-episode pipeline
1. Fetch play page `/play/<anime>/<episode>` → parse per-quality kwik links → pick target
   quality/audio (fallback to nearest available, log the substitution).
2. Open kwik `/e/<id>` in background tab (`chrome.tabs.create {active:false}`).
   `chrome.webRequest.onBeforeRequest` observer catches `*.m3u8`; content script forces
   `play()` if needed. Close tab on capture or timeout.
3. DNR session rule adds `Referer`+`Origin: https://kwik.si/` for CDN-host requests.
4. Offscreen: fetch m3u8 + AES key + segments (parallel pool 6, in-memory) →
   WebCrypto AES-128-CBC decrypt each segment (IV from `#EXT-X-KEY` or media-sequence) →
   concat into one TS blob.
5. ffmpeg.wasm single-thread core (bundled), copy-remux:
   `-i in.ts -c copy -bsf:a aac_adtstoasc out.mp4`.
6. Save (offscreen creates blob URL; SW performs the download):
   - Default: offscreen → blob URL → message SW → `chrome.downloads.download` →
     `Downloads/Anime/{title}/{title} - {episode} [{quality}p].mp4`. SW revokes URL after start.
   - Optional: File System Access custom folder — offscreen writes via stored dir handle
     (picker runs in popup on a user gesture; handle persisted in IndexedDB).
   - **Sanitize** illegal chars (`\ / : * ? " < > |` → `_`), **strip `.` / `..` path segments**
     (traversal guard, esp. FSA), zero-pad episode, preserve decimals (7.5).
7. Retry N attempts on fail → mark failed → continue batch → report at end.

## Manifest
- Permissions: `downloads`, `offscreen`, `storage`, `tabs`, `scripting`, `webRequest`,
  `declarativeNetRequestWithHostAccess`.
- `host_permissions`: `<all_urls>` (CDN hosts vary: padorupado/nextcdn/vault…; TLD wildcards illegal).
- CSP (`content_security_policy.extension_pages`): include `wasm-unsafe-eval` for ffmpeg.wasm.
- Configurable active animepahe domain in settings (`.ru`/`.com`/`.org`…); kwik `.si`/`.cx`.

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
- **DNR Referer/Origin spoof must be tightly scoped:** rule `condition.requestDomains` = CDN hosts
  only, `resourceTypes` = `media`/`xmlhttprequest`, and rules added on batch-start / **removed on
  batch-end**. A broad always-on Origin rewrite = CSRF risk against other sites.
- **Path traversal:** episode title / number are attacker-influenced (page content). Sanitize +
  strip `..`/leading `.`/separators before building any filename — `chrome.downloads` blocks abs/`..`
  but FSA writes via dir handle do NOT; guard manually.
- **Content-script match scope = kwik hosts only**, never `<all_urls>`. Minimizes injection surface.
- **No remote code** (MV3 rule): ffmpeg.wasm + all deps bundled; nothing from CDN/eval'd at runtime.
- **`cf_clearance` not stored** — rides existing browser cookies via `credentials:'include'`;
  no `cookies` permission requested, nothing persisted.
- **webRequest observation** still allowed in MV3 (non-blocking) but Chrome is deprecating parts;
  m3u8 capture depends on it — fallback = content-script reads `video.src`/hls.js if webRequest
  observation is ever removed.

## Top risks
- **Kwik CF challenge** in the background tab may block the m3u8 → timeout. Mitigation: retry,
  surface to user, optionally open tab visibly for manual solve.
- **1080p memory peak** (~500MB–1GB) in offscreen → OOM. Mitigation path: OPFS streaming (deferred).
- **Markup/packer drift** breaks play-page parsing. Reduced exposure by pure tab-sniff for m3u8,
  but play-page quality-link parsing still depends on current DOM.

## Distribution
Unpacked: `pnpm install && pnpm build`, load `dist/` via `chrome://extensions` (developer mode).
No Web Store (would reject `<all_urls>` + content nature). README to document build+load.
