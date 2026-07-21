// Open a kwik page in a background tab, let the real player JS run, and sniff the *.m3u8
// request via chrome.webRequest (SPEC Q4/Q5 — pure real-tab extraction). The content script
// (content/kwik.ts) forces play() so the manifest loads.

const M3U8_RE = /\.m3u8(\?|$)/i;
const TIMEOUT_MS = 30_000;

export async function resolveM3u8(kwikUrl: string): Promise<string> {
  const tab = await chrome.tabs.create({ url: kwikUrl, active: false });
  const tabId = tab.id!;

  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      chrome.webRequest.onBeforeRequest.removeListener(listener);
      clearTimeout(timer);
      chrome.tabs.remove(tabId).catch(() => {});
      fn();
    };

    const listener = (details: chrome.webRequest.WebRequestBodyDetails) => {
      if (details.tabId === tabId && M3U8_RE.test(details.url)) {
        finish(() => resolve(details.url));
      }
    };

    chrome.webRequest.onBeforeRequest.addListener(listener, {
      urls: ['<all_urls>'],
      types: ['xmlhttprequest', 'media', 'other'],
    });

    const timer = setTimeout(
      () => finish(() => reject(new Error('m3u8 sniff timeout (kwik may show a Cloudflare challenge)'))),
      TIMEOUT_MS,
    );
  });
}
