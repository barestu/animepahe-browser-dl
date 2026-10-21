# Security

## Reporting

Report a vulnerability privately through
[GitHub Security Advisories](https://github.com/barestu/animepahe-browser-dl/security/advisories/new)
rather than opening a public issue. This is a personal-use project maintained in spare time, so
expect best-effort response times and no SLA.

Only the latest release is supported — fixes land in a new tag, never as a patch to an old one.

## What this extension can see, and why

This extension requests a deliberately broad permission set. You are loading it unpacked from
source or from a zip, so you can — and should — read the manifest before you trust it:
[src/manifest.config.ts](src/manifest.config.ts).

| Permission | Why it is needed |
|---|---|
| `host_permissions: <all_urls>` | Segment CDN hostnames vary per release and are not known ahead of time. |
| `webRequest` (observe only) | Sniffs the HLS `.m3u8` request in the hidden kwik tab. kwik's player is obfuscated; observing the real request is more robust than parsing its JS. |
| `declarativeNetRequestWithHostAccess` | kwik and the CDN validate `Referer`/`Origin`, which `fetch()` cannot set — these are forbidden headers. DNR supplies them. |
| `scripting` + `tabs` | Every animepahe request runs *inside your animepahe tab* (see below). |
| `downloads`, `storage`, `offscreen` | Saving the file, the queue/settings/log, and the ffmpeg.wasm host document. |

**`<all_urls>` + `webRequest` is the widest part of this surface** and the reason the project does
not ship to the Chrome Web Store. Mitigations actually in place:

- **DNR rules are batch-scoped.** The CDN `Referer`/`Origin` rewrite rule matches
  `media`/`xmlhttprequest` broadly because CDN hosts vary, so it is added at batch start and
  **removed at batch end** — it is never always-on. See [src/background/dnr.ts](src/background/dnr.ts).
- **The content script is scoped to kwik hosts only**, never `<all_urls>`.
- **No remote code.** ffmpeg core and every dependency are bundled and loaded from
  `chrome-extension://` URLs; nothing is fetched or `eval`'d from the network.
- **`cf_clearance` is never read, stored, or transmitted.** animepahe requests run first-party
  inside your own tab, so the browser attaches the cookie itself — the `cookies` permission is not
  requested and nothing is persisted.
- **Filenames are sanitized per path segment** (illegal characters plus `.`/`..` stripped) before
  any download, because episode titles and numbers are page-controlled. See
  [src/lib/naming.ts](src/lib/naming.ts).
- **No telemetry, no analytics, no external endpoints.** The extension talks to animepahe, kwik,
  and the segment CDN. Nothing else.

Full design rationale is in the Security section of [SPEC.md](SPEC.md).

## Out of scope

- The breadth of `<all_urls>` itself. It is documented, intentional, and the stated reason this is
  unpacked-only. A report saying "this extension has broad permissions" will be closed as known.
- Anything requiring an attacker to already control your browser profile or the extension's own
  storage.
- Vulnerabilities in animepahe, kwik, or their CDN.
