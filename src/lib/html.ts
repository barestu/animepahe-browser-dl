// Decode HTML entities (e.g. &#039; -> ', &amp; -> &) natively via the DOM parser.
// DOM-only — safe to call from the popup/offscreen, not the service worker.
export function decodeEntities(s: string): string {
  return new DOMParser().parseFromString(s, 'text/html').documentElement.textContent ?? s;
}
