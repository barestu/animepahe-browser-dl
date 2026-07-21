// Run a fetch INSIDE a given tab (first-party to that tab's origin) via scripting.executeScript.
// animepahe's API/pages sit behind Cloudflare; the cf_clearance cookie is SameSite=Lax, so a
// cross-site fetch from the extension popup won't send it (-> 403). Fetching from the page's own
// context is first-party: cookies + Referer are correct. See SPEC "Cloudflare".

export type Fetcher = (url: string) => Promise<string>;

interface InPageResult {
  ok: boolean;
  status: number;
  body: string;
  retryAfter: number; // seconds, 0 if absent
  err?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([429, 502, 503]);
const MAX_ATTEMPTS = 6;

export function tabFetcher(tabId: number): Fetcher {
  return async (url: string) => {
    let lastErr = 'unknown';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const injected = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (u: string): Promise<InPageResult> => {
          try {
            const r = await fetch(u, { credentials: 'include' });
            const ra = Number(r.headers.get('retry-after'));
            return {
              ok: r.ok,
              status: r.status,
              body: await r.text(),
              retryAfter: Number.isFinite(ra) && ra > 0 ? ra : 0,
            };
          } catch (e) {
            return { ok: false, status: 0, body: '', retryAfter: 0, err: e instanceof Error ? e.message : String(e) };
          }
        },
        args: [url],
        world: 'ISOLATED',
      });

      const res = injected?.[0]?.result as InPageResult | undefined;
      // exponential backoff w/ jitter, capped; honor Retry-After when present
      const backoff = (extra = 0) =>
        sleep(extra || Math.min(800 * 2 ** attempt, 20_000) + attempt * 200);

      if (!res) {
        lastErr = 'no frame result (tab busy/navigating)';
        await backoff();
        continue;
      }
      if (res.err) {
        lastErr = res.err;
        await backoff();
        continue;
      }
      if (res.ok) return res.body;
      if (RETRYABLE.has(res.status)) {
        lastErr = `HTTP ${res.status}`;
        await backoff(res.retryAfter * 1000);
        continue;
      }
      throw new Error(`${url} -> HTTP ${res.status}`); // non-retryable
    }
    throw new Error(`in-tab fetch failed for ${url}: ${lastErr}`);
  };
}
