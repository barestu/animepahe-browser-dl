# Contributing

Thanks for looking. This is a small personal-use extension, so the bar is "does it work against a
live animepahe page and does it keep the architecture intact" rather than process.

## Setup

```bash
pnpm install
pnpm build
```

Then load it: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
`dist/`. Chrome 116+ is required (offscreen documents, `declarativeNetRequestWithHostAccess`).

For iterating, `pnpm dev` runs Vite with CRXJS HMR — you still load `dist/`. The popup header
prints the version and build timestamp, which is the only reliable way to tell which build Chrome
actually has loaded after an HMR session.

| Script | What it does |
|---|---|
| `pnpm build` | `copy:ffmpeg` + `gen:icons` + `tsc --noEmit` + `vite build` → `dist/` |
| `pnpm dev` | same prep, then Vite with CRXJS HMR |
| `pnpm check` | `svelte-check` — type-checks `.svelte` files (`tsc` alone does not) |
| `pnpm copy:ffmpeg` | refresh `public/ffmpeg/` from `node_modules/@ffmpeg/core` |
| `pnpm gen:icons` | rasterize `design/icon.svg` → `public/icons/*.png` |
| `pnpm zip` | pack `dist/` → `release/animepahe-browser-dl-v<version>.zip` |
| `pnpm release:notes` | draft a CHANGELOG section from commits since the last tag |

`public/ffmpeg/`, `public/icons/`, `dist/` and `release/` are generated — never hand-edit them.

## The one rule: respect the four MV3 contexts

The extension is split across four contexts because Chrome forces it, not for style. Putting code
in the wrong one is the most common way to break this codebase.

| Context | Can do | Cannot do |
|---|---|---|
| Popup (Svelte) | first-party animepahe fetches (through the tab), batch UI | survive being closed |
| Service worker | all `chrome.*` APIs, queue, DNR, downloads | fetch animepahe (Cloudflare), `createObjectURL` |
| Offscreen doc | ffmpeg.wasm, blob URLs | any `chrome.*` except `runtime` |
| Content script | force `play()` on kwik | anything else (kwik hosts only) |

Two consequences worth internalising before you move anything:

- `cf_clearance` is `SameSite=Lax`, so **every** animepahe request must run inside the animepahe
  tab (`src/lib/tab-fetch.ts`). The service worker never touches animepahe; the popup pre-resolves
  each episode's kwik URL before enqueueing.
- `Referer`/`Origin` are forbidden headers for `fetch()`, so `declarativeNetRequest` session rules
  supply them (`src/background/dnr.ts`). They are scoped to the batch window and torn down at the
  end — that scoping *is* the mitigation for the broad permission surface.

Messaging contracts live in [src/lib/types.ts](src/lib/types.ts). Add a message type there first.

[CLAUDE.md](CLAUDE.md) is the working map of the codebase (where things are);
[SPEC.md](SPEC.md) is the design record (why things are the way they are). Keep SPEC.md in sync
when behaviour changes.

## Things that will get a PR turned down

- **New Chrome permissions.** `<all_urls>` + `webRequest` is already deliberately broad and
  documented as the main risk. The permission list in `src/manifest.config.ts` does not grow.
- **Anything aimed at Chrome Web Store publishing.** Distribution is unpacked zip via GitHub
  Releases, on purpose — see the README caveats.
- **Transcoding.** ffmpeg.wasm is used copy-remux only (`-c copy -bsf:a aac_adtstoasc`).
- Breaking cooperative pause/cancel. Any new long operation must `await gate.wait()` at a
  boundary and pass `gate.signal` to its fetches; an aborted fetch is a *cancel*, never a
  transient CDN error to retry. See [src/lib/control.ts](src/lib/control.ts).

## Where breakage usually is

When the extension suddenly stops working, it is almost always upstream markup drift, not a
regression. Start at `parsePlaySources()` in [src/lib/animepahe.ts](src/lib/animepahe.ts) and the
kwik selectors in [src/background/kwik.ts](src/background/kwik.ts). The popup logs
`describePlayPage()` page markers and one `samplePlayMarkup()` window per batch precisely so a bug
report can tell you which of the two moved.

## Verification

There is no test framework. Before opening a PR:

1. `pnpm check` — clean.
2. `pnpm build` — clean (this is what CI runs).
3. Load the build in Chrome and download at least one real episode end to end.
4. If you touched pause/cancel, exercise pausing mid-download and resuming, and cancelling both a
   single job and a whole batch.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, `chore:`,
`refactor:`, `perf:`. This is not cosmetic: `pnpm release:notes` groups commits by type to draft
the changelog, and `feat`/`fix`/`perf`/`refactor` are the types that reach release notes.

## Release process (maintainer)

1. Add the new version's section to [CHANGELOG.md](CHANGELOG.md) — `pnpm release:notes` drafts it
   from the commits since the last tag; edit it into something a user would want to read.
2. `pnpm version <x.y.z> -m "chore(release): v%s"` — bumps `package.json`, commits, and tags.
   `src/manifest.config.ts` reads its version from `package.json`, so there is nothing else to
   bump.
3. `git push --follow-tags`.

The `Release` workflow then verifies the tag matches `package.json`, extracts that version's
section from `CHANGELOG.md` (and **fails** if it is missing), builds, zips `dist/`, and publishes a
GitHub Release with the zip attached. A tag containing a `-` (e.g. `v1.1.0-beta.1`) is published as
a pre-release.
