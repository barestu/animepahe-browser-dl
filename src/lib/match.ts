// Single source of truth for "is this tab a usable animepahe anime page?".
// Both the popup status row and the toolbar badge call matchTab(), so the two
// surfaces can never disagree. The host check is deliberately pattern-based
// (animepahe.<any tld>) plus the user's saved domain, so the domain still isn't
// hardcoded — see SPEC "Security".

/** Path shape the rest of the app consumes: /anime/<animeSession>. */
const ANIME_PATH = /\/anime\/([A-Za-z0-9-]+)/;
const ANIMEPAHE_HOST = /^(?:www\.)?animepahe\.[a-z]{2,}$/i;

export type TabMatch =
  | { ok: true; host: string; animeSession: string }
  | { ok: false; host: string; onAnimepahe: boolean; reason: string };

export function isAnimepaheHost(host: string, savedDomain?: string): boolean {
  return ANIMEPAHE_HOST.test(host) || (!!savedDomain && host === savedDomain);
}

export function matchTab(url: string | undefined, savedDomain?: string): TabMatch {
  let parsed: URL;
  try {
    // chrome://, about:blank and undefined must resolve to a miss, never throw.
    parsed = new URL(url ?? '');
  } catch {
    return { ok: false, host: '', onAnimepahe: false, reason: 'No page open' };
  }

  const host = parsed.hostname;
  if (!isAnimepaheHost(host, savedDomain)) {
    return { ok: false, host, onAnimepahe: false, reason: 'Not an animepahe page' };
  }

  const animeSession = parsed.pathname.match(ANIME_PATH)?.[1];
  if (!animeSession) {
    return { ok: false, host, onAnimepahe: true, reason: 'Not an anime page (open …/anime/…)' };
  }

  return { ok: true, host, animeSession };
}
