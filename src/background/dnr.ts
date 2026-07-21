// Rewrites Referer on CDN segment/manifest fetches so hotlink checks pass. fetch() can't set
// Referer (forbidden header), so we use a declarativeNetRequest session rule instead (SPEC Q6).
//
// SECURITY: this rule affects media/xhr requests broadly while active — we deliberately set
// ONLY Referer (not Origin) to avoid CORS/CSRF side effects, and remove the rule the moment the
// batch ends. Enable only while downloading. See SPEC "Security".

const RULE_ID = 1001;
const KWIK_REFERER = 'https://kwik.si/';

export async function enableRefererRule(animepaheDomain: string): Promise<void> {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_ID],
    addRules: [
      {
        id: RULE_ID,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: [
            {
              header: 'Referer',
              operation: chrome.declarativeNetRequest.HeaderOperation.SET,
              value: KWIK_REFERER,
            },
          ],
        },
        condition: {
          resourceTypes: [
            chrome.declarativeNetRequest.ResourceType.MEDIA,
            chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
          ],
          // don't touch the user's own animepahe/kwik navigation requests
          excludedRequestDomains: [animepaheDomain, 'kwik.si', 'kwik.cx'],
        },
      },
    ],
  });
}

export async function disableRefererRule(): Promise<void> {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_ID] });
}
