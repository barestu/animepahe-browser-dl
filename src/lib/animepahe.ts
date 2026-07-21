import type { Audio, Episode, KwikSource, Quality } from './types';
import type { Fetcher } from './tab-fetch';
import { decodeEntities } from './html';

// animepahe sits behind Cloudflare; the cf_clearance cookie is SameSite=Lax so it only rides
// FIRST-PARTY requests. All animepahe fetches therefore run inside the animepahe tab via an
// injected Fetcher (see tab-fetch.ts), never a cross-site fetch from the extension. See SPEC.

interface ReleaseItem {
  session: string; // episode session
  episode: number | string;
}
interface ReleaseResponse {
  data: ReleaseItem[];
  last_page: number;
  current_page: number;
}

function base(domain: string): string {
  return `https://${domain}`;
}

/** Pull the anime title from the /anime/<session> page <title>. */
export async function getAnimeTitle(
  fetchText: Fetcher,
  domain: string,
  animeSession: string,
): Promise<string> {
  const html = await fetchText(`${base(domain)}/anime/${animeSession}`);
  const m = html.match(/<title>\s*(.*?)\s*(?:::|\||<\/title>)/i);
  const raw = decodeEntities(m?.[1] ?? 'Unknown');
  return raw
    .replace(/\s*anime info.*$/i, '')
    .replace(/\s*\bEp\.?\s.*$/i, '') // drop "Ep. 1-13 [Completed]" and anything after
    .replace(/\s*\[[^\]]*\]\s*$/, '') // drop any trailing [status] bracket
    .trim();
}

/** Fetch every episode (paginates the release API). */
export async function getEpisodeList(
  fetchText: Fetcher,
  domain: string,
  animeSession: string,
  title: string,
): Promise<Episode[]> {
  const out: Episode[] = [];
  let page = 1;
  let lastPage = 1;

  do {
    const url = `${base(domain)}/api?m=release&id=${animeSession}&sort=episode_asc&page=${page}`;
    const text = await fetchText(url);
    if (text.trimStart().startsWith('<')) {
      throw new Error(
        `API returned HTML, not JSON (domain ${domain}). Likely a Cloudflare page — ` +
          `make sure the tab has fully loaded past any Cloudflare check.`,
      );
    }
    const json = JSON.parse(text) as ReleaseResponse;
    lastPage = json.last_page ?? 1;
    for (const item of json.data ?? []) {
      out.push({
        animeSession,
        episodeSession: item.session,
        episodeNumber: String(item.episode),
        title,
      });
    }
    page += 1;
  } while (page <= lastPage);

  return out;
}

/**
 * Parse the /play/<anime>/<episode> page for per-quality kwik links.
 * animepahe renders a #resolutionMenu with <button> elements carrying data-src /
 * data-audio / data-resolution. Regex-based (no DOMParser) so it runs in the service
 * worker. Highest-drift point in the app (see SPEC risks) — update selectors on breakage.
 */
export function parsePlaySources(html: string): KwikSource[] {
  const sources: KwikSource[] = [];
  // Match each <button ...> tag carrying a data-src attribute.
  const buttonRe = /<button\b[^>]*\bdata-src=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = buttonRe.exec(html)) !== null) {
    const tag = m[0];
    const kwikUrl = m[1];
    if (!/kwik\./.test(kwikUrl)) continue;
    const resolution = (tag.match(/data-resolution=["']([^"']+)["']/i)?.[1] || '').replace(/p$/i, '');
    const audioAttr = (tag.match(/data-audio=["']([^"']+)["']/i)?.[1] || 'jpn').toLowerCase();
    const audio: Audio = audioAttr.startsWith('eng') ? 'eng' : 'jpn';
    if (!['360', '480', '720', '1080'].includes(resolution)) continue;
    sources.push({ quality: resolution as Quality, audio, kwikUrl });
  }
  return sources;
}

export async function fetchPlayPage(
  fetchText: Fetcher,
  domain: string,
  animeSession: string,
  episodeSession: string,
): Promise<KwikSource[]> {
  const html = await fetchText(`${base(domain)}/play/${animeSession}/${episodeSession}`);
  return parsePlaySources(html);
}

/** Pick the best source for a target quality/audio, falling back to nearest quality. */
export function pickSource(sources: KwikSource[], quality: Quality, audio: Audio): KwikSource | null {
  if (sources.length === 0) return null;
  const byAudio = sources.filter((s) => s.audio === audio);
  const pool = byAudio.length ? byAudio : sources;
  const exact = pool.find((s) => s.quality === quality);
  if (exact) return exact;
  // nearest by numeric distance
  const target = Number(quality);
  return pool
    .slice()
    .sort((a, b) => Math.abs(Number(a.quality) - target) - Math.abs(Number(b.quality) - target))[0];
}
