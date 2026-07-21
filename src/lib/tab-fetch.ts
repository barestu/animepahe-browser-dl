// Run a fetch INSIDE a given tab (first-party to that tab's origin) via scripting.executeScript.
// animepahe's API/pages sit behind Cloudflare; the cf_clearance cookie is SameSite=Lax, so a
// cross-site fetch from the extension popup won't send it (-> 403). Fetching from the page's own
// context is first-party: cookies + Referer are correct. See SPEC "Cloudflare".

export type Fetcher = (url: string) => Promise<string>;

export function tabFetcher(tabId: number): Fetcher {
  return async (url: string) => {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      // runs in the tab's ISOLATED world; same-origin fetch carries first-party cookies
      func: async (u: string) => {
        const r = await fetch(u, { credentials: 'include' });
        if (!r.ok) throw new Error(`${r.status}`);
        return r.text();
      },
      args: [url],
      world: 'ISOLATED',
    });
    if (!res || res.result == null) throw new Error('in-tab fetch returned nothing');
    return res.result as string;
  };
}
