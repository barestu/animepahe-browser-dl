// Run a fetch INSIDE a given tab (first-party to that tab's origin) via scripting.executeScript.
// animepahe's API/pages sit behind Cloudflare; the cf_clearance cookie is SameSite=Lax, so a
// cross-site fetch from the extension popup won't send it (-> 403). Fetching from the page's own
// context is first-party: cookies + Referer are correct. See SPEC "Cloudflare".

export type Fetcher = (url: string) => Promise<string>;

interface InPageResult {
  ok: boolean;
  status: number;
  body: string;
  err?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function tabFetcher(tabId: number): Fetcher {
  return async (url: string) => {
    // Retry: executeScript can transiently return no frame result if the page is mid-navigation.
    let lastErr = 'unknown';
    for (let attempt = 0; attempt < 3; attempt++) {
      const injected = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (u: string): Promise<InPageResult> => {
          try {
            const r = await fetch(u, { credentials: 'include' });
            return { ok: r.ok, status: r.status, body: await r.text() };
          } catch (e) {
            return { ok: false, status: 0, body: '', err: e instanceof Error ? e.message : String(e) };
          }
        },
        args: [url],
        world: 'ISOLATED',
      });

      const res = injected?.[0]?.result as InPageResult | undefined;
      if (!res) {
        lastErr = 'no frame result (tab busy/navigating)';
        await sleep(400 * (attempt + 1));
        continue;
      }
      if (res.err) {
        lastErr = res.err;
        await sleep(400 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
      return res.body;
    }
    throw new Error(`in-tab fetch failed for ${url}: ${lastErr}`);
  };
}
