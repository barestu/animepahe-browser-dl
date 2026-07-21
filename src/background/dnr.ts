// Rewrites Referer/Origin on requests that fetch() can't set them on (forbidden headers).
// Two rules (SPEC Q6):
//   - KWIK nav rule: loading the kwik player tab needs Referer=animepahe (kwik CF gate).
//   - CDN rule: offscreen segment/manifest fetches need Referer/Origin=the kwik host that
//     embedded the stream (owocdn/nextcdn/vault validate the embedding origin).
//
// SECURITY: rules are enabled only while a batch runs and removed at the end. See SPEC "Security".

const CDN_RULE_ID = 1001;
const KWIK_RULE_ID = 1002;
const KWIK_HOSTS = ['kwik.si', 'kwik.cx'];

function setHeader(header: string, value: string) {
  return { header, operation: chrome.declarativeNetRequest.HeaderOperation.SET, value };
}

/** Referer=animepahe on kwik navigations so the player embed loads. Enable once per batch. */
export async function enableKwikNavRule(animepaheDomain: string): Promise<void> {
  const R = chrome.declarativeNetRequest.ResourceType;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [KWIK_RULE_ID],
    addRules: [
      {
        id: KWIK_RULE_ID,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: [
            setHeader('Referer', `https://${animepaheDomain}/`),
            setHeader('Origin', `https://${animepaheDomain}`),
          ],
        },
        condition: {
          requestDomains: KWIK_HOSTS,
          resourceTypes: [R.MAIN_FRAME, R.SUB_FRAME, R.XMLHTTPREQUEST],
        },
      },
    ],
  });
}

/** Referer/Origin=<kwik origin> on CDN media/xhr fetches. Call per job with the job's kwik origin. */
export async function setCdnRefererRule(kwikOrigin: string, animepaheDomain: string): Promise<void> {
  const R = chrome.declarativeNetRequest.ResourceType;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [CDN_RULE_ID],
    addRules: [
      {
        id: CDN_RULE_ID,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: [
            setHeader('Referer', `${kwikOrigin}/`),
            setHeader('Origin', kwikOrigin),
          ],
        },
        condition: {
          resourceTypes: [R.MEDIA, R.XMLHTTPREQUEST],
          // don't clobber the user's own animepahe/kwik requests
          excludedRequestDomains: [animepaheDomain, ...KWIK_HOSTS],
        },
      },
    ],
  });
}

export async function disableAllRules(): Promise<void> {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [CDN_RULE_ID, KWIK_RULE_ID] });
}
