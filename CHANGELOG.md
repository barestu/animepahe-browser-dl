# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each released version needs a section here **before** its tag is pushed — the release workflow
reads its notes from this file and fails the release if the section is missing.
`pnpm release:notes` drafts one from the commits since the last tag.

## [Unreleased]

## [1.0.0] - 2026-10-21

First tagged release. The extension has been working end-to-end for a while; this cuts a version
so there is something downloadable and something to report bugs against.

### Added

- **Batch download queue** — pick episodes from an open animepahe anime page (checkboxes or a range
  like `1-12,15`), choose quality and audio, and download them one at a time with per-segment
  progress.
- **Full pipeline per episode** — the kwik player is opened in a hidden tab, its HLS `.m3u8` is
  sniffed, segments are fetched with bounded concurrency and AES-128 decrypted, then copy-remuxed
  to `.mp4` with ffmpeg.wasm and saved through `chrome.downloads`.
- **Pause / resume** — cooperative, so pausing preserves in-flight work: already-fetched segments
  are kept and resuming continues the same run instead of restarting it.
- **Cancel** — one job or the whole batch, via a two-step arm rather than a modal (a modal
  dismisses the popup mid-decision). A canceled job disappears from the queue.
- **Retry** a failed episode without re-picking it, plus automatic retry on transient CDN errors.
- **Auto-clear** — completed jobs are dropped when the batch drains, leaving an "N episodes done"
  receipt and only what still needs attention. Toggleable in settings.
- **Per-tab toolbar icon verdict** — a green ✓ corner when the open tab is downloadable, a red ✗
  when you are on animepahe but the wrong page, plain when the tab is unrelated.
- **Built-in log terminal** — live diagnostic tail in the popup with copy-to-clipboard and clear.
  This is what to paste when reporting a breakage; on a parse miss it also prints play-page markers
  and a markup sample.
- **Settings** — animepahe domain (auto-corrected to whichever mirror the tab is on), filename
  template (`{title} {episode} {quality} {audio}`), and the auto-clear toggle.

### Fixed

- Accept any resolution a play page lists instead of matching against a 360/480/720/1080 whitelist
  — movies and some fansub encodes ship off-ladder heights, which previously failed to resolve.
- Decode HTML entities in anime titles and strip episode/status clutter, so filenames come out
  clean.
- Retry on HTTP 429 during the play-page resolve phase.

[Unreleased]: https://github.com/barestu/animepahe-browser-dl/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/barestu/animepahe-browser-dl/releases/tag/v1.0.0
