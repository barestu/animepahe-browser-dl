# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install
pnpm build        # copy:ffmpeg + gen:icons + tsc --noEmit + vite build  -> dist/
pnpm dev          # same prep, then vite with crxjs HMR (still load dist/)
pnpm check        # svelte-check (type-checks .svelte; tsc alone does not)
pnpm copy:ffmpeg  # refresh public/ffmpeg/ from node_modules/@ffmpeg/core
pnpm gen:icons    # rasterize design/icon.svg -> public/icons/*.png (sharp)
```

Load in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → `dist/`.
Requires Chrome 116+ (`minimum_chrome_version`: offscreen + `declarativeNetRequestWithHostAccess`).

`vite.config.ts` defines `__APP_VERSION__` / `__BUILD_TIME__`; the popup header renders them, which
is the only way to tell which build is actually loaded after an HMR session.

There is **no test framework**. Verification is `pnpm build` (which runs `tsc --noEmit`), `pnpm check`,
and manually exercising the extension against a live animepahe page. `public/ffmpeg/`, `public/icons/`
and `dist/` are gitignored build artifacts — always regenerate, never hand-edit.

[SPEC.md](SPEC.md) is the design record (decision table, as-built notes, risks). Keep it in sync when
behaviour changes; it documents *why*, this file documents *where*.

## Architecture

Four MV3 contexts, each doing what only it can do. The split is forced by Chrome, not by taste —
violating it is the most common way to break this codebase.

| Context | File | Can do | Cannot do |
|---|---|---|---|
| Popup (Svelte) | [src/popup/App.svelte](src/popup/App.svelte) | first-party animepahe fetches (via the tab), batch UI | survive being closed |
| Service worker | [src/background/service-worker.ts](src/background/service-worker.ts) | all `chrome.*` APIs, queue, DNR, downloads | fetch animepahe (Cloudflare), `createObjectURL` |
| Offscreen doc | [src/offscreen/offscreen.ts](src/offscreen/offscreen.ts) | ffmpeg.wasm, blob URLs | any `chrome.*` except `runtime` |
| Content script | [src/content/kwik.ts](src/content/kwik.ts) | force `play()` on kwik | anything else (kwik hosts only) |

Messaging contracts are the single source of truth in [src/lib/types.ts](src/lib/types.ts)
(`PopupMsg`, `OffscreenMsg`, `OffscreenReply`, `AppState`, `Job`, `Settings`). Add a message there
first.

Shared across contexts: [lib/settings.ts](src/lib/settings.ts) (the `settings` storage key, always
spread over `DEFAULT_SETTINGS` on read), [lib/match.ts](src/lib/match.ts), [lib/naming.ts](src/lib/naming.ts),
[lib/logger.ts](src/lib/logger.ts), [lib/control.ts](src/lib/control.ts).
[background/badge.ts](src/background/badge.ts) paints the per-tab icon/badge from `matchTab()` —
derived state only, it persists nothing and never touches the queue.

### Two Cloudflare workarounds that constrain everything

1. **`cf_clearance` is `SameSite=Lax`** → a cross-site fetch from the extension origin gets 403. So
   *every* animepahe request runs **inside the animepahe tab** via `chrome.scripting.executeScript`
   ([src/lib/tab-fetch.ts](src/lib/tab-fetch.ts)). Consequence: the **popup pre-resolves each
   episode's kwik URL before enqueueing** — the service worker never touches animepahe, it only
   receives already-resolved `kwikUrl`s.
2. **kwik and the CDN validate `Referer`/`Origin`**, which `fetch()` cannot set (forbidden headers).
   So [src/background/dnr.ts](src/background/dnr.ts) installs two `declarativeNetRequest` *session*
   rules: a kwik-nav rule (Referer = animepahe) armed for the whole batch, and a CDN rule re-set
   **per job** to that job's kwik origin (`kwik.si` vs `kwik.cx` matters — wrong one = 403). Both are
   removed at batch end; that batch-window scoping is the stated mitigation for the widest part of
   the extension's permission surface.

### Per-episode pipeline

`runJob()` in the service worker is the spine: `extracting` → `downloading` → `muxing` → `saving`.

1. [background/kwik.ts](src/background/kwik.ts) opens the kwik URL in a background tab and sniffs
   `*.m3u8` with a `chrome.webRequest` observer (30 s timeout); the content script forces `play()`
   because some kwik builds don't load the manifest until playback starts.
2. CDN DNR rule re-set for this job's kwik origin.
3. Offscreen runs [lib/hls.ts](src/lib/hls.ts): parse m3u8 → fetch key → bounded-concurrency segment
   pool (default 3, **clamped ≤4** — owocdn 429s above that) → WebCrypto AES-128-CBC decrypt →
   concat TS.
4. ffmpeg.wasm **copy-remux only**, never transcode: `-i in.ts -c copy -bsf:a aac_adtstoasc out.mp4`.
5. Offscreen mints the blob URL, SW calls `chrome.downloads.download` and waits for `complete`, then
   messages offscreen to `revokeObjectURL`.

Whole episode is held in memory (TS + mp4 simultaneously) — OOM risk on 1080p is known and accepted.

### Pause / cancel: cooperative, never force-kill

[src/lib/control.ts](src/lib/control.ts) defines `Gate` (pause flag + waiter list + `AbortController`),
instantiated in the SW and mirrored into offscreen via `{type:'control'}` messages so both obey the
same signal. **Pause preserves in-flight work** — segment workers block at `await gate.wait()` before
claiming the next index, so resume continues the same run with nothing re-fetched.

Rules to preserve when touching this:
- Any new long operation must `await gate.wait()` at a boundary and pass `gate.signal` to fetches.
- An aborted fetch is a **cancel**, never a transient CDN error — it must not be retried.
- `ffmpeg.exec()` cannot be suspended; cancel means `ffmpeg.terminate()` + dropping the instance.
  The checkpoint therefore sits *before* the mux.
- A paused batch produces no message traffic, so the SW pings `chrome.runtime.getPlatformInfo()`
  every 20 s to defeat MV3's ~30 s idle termination.
- **There is no `canceled` stage.** Cancel removes the job from the queue; disappearing *is* the
  feedback. `runJob`'s catch returns early on `gate.isCanceled` so it neither retries nor resurrects
  the removed job via `patchJob`.

### State

[background/queue-store.ts](src/background/queue-store.ts) is the only writer of the `queue` key in
`chrome.storage.local`, and every `setState` broadcasts `{type:'stateUpdate'}` so an open popup
re-renders. `getState()` spreads over `EMPTY` so state written by an older build still loads — keep
that when adding `AppState` fields. Done jobs auto-clear **when the queue drains** (not per episode),
leaving `lastDone` as the only success receipt.

Logs are a capped ring buffer in `storage.local` ([lib/logger.ts](src/lib/logger.ts)); offscreen and
popup send entries to the SW, which is the sole collector. The popup tails it via
`chrome.storage.onChanged`.

## Conventions / gotchas

- `@/` → `src/` (tsconfig paths + Vite alias).
- Top-level `chrome.*` listeners only — MV3 revives the SW for synchronously-bound listeners.
  Registering inside an async callback silently loses events after the SW sleeps.
- No `DOMParser` in the service worker: [lib/animepahe.ts](src/lib/animepahe.ts) parses the play page
  with regex, and `decodeEntities` ([lib/html.ts](src/lib/html.ts)) is DOM-only (popup/offscreen).
- The offscreen HTML must stay an explicit Vite rollup input — crxjs can't discover documents created
  at runtime.
- Pass ffmpeg core as `chrome-extension://` URLs, never blob URLs: MV3 CSP allows `'self'`, not `blob:`.
- Highest-drift code is `parsePlaySources()` and the kwik selectors — update those first when
  animepahe/kwik change their markup. Its two diagnostics, `describePlayPage()` (page markers:
  length, `resolutionMenu`, `data-src` count, Cloudflare interstitial, `<title>`) and
  `samplePlayMarkup()` (one ±220-char window around the first `data-src`), are what the popup logs
  on a parse miss — one sample per batch, because the log is a capped ring buffer.
- `Quality` (the 360/480/720/1080 ladder the user picks) and `SourceQuality` (`string` — whatever
  height a play page actually lists) are deliberately different types. Movies and some fansub
  encodes ship off-ladder heights, so **never** whitelist resolutions when parsing; `pickSource()`
  maps the user's `Quality` onto the nearest available `SourceQuality`, and `Job.quality` carries
  the real one through to the filename.
- Filenames: always go through `buildFilename()` ([lib/naming.ts](src/lib/naming.ts)) — titles are
  page-controlled, and it sanitizes per path segment as the traversal guard.
- "Is this tab usable?" has exactly one implementation, `matchTab()` ([lib/match.ts](src/lib/match.ts)),
  shared by the popup status row and the toolbar badge so they cannot disagree.
- Destructive popup actions use a 3 s two-step arm, **not** `window.confirm()` — a modal dismisses the
  extension popup mid-decision.
- Personal/unpacked use only: `<all_urls>` + `webRequest` is deliberately broad. Do not add
  permissions, and do not publish.
