import type { Audio, Episode, KwikSource, Quality, SourceQuality } from './types';
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
    // Accept any numeric height. A whitelist of the common ladder silently discarded whole
    // releases (e.g. a 272p movie encode) and surfaced as "no streams parsed".
    if (!/^\d{2,4}$/.test(resolution)) continue;
    sources.push({ quality: resolution as SourceQuality, audio, kwikUrl });
  }
  return sources;
}

/**
 * Fetch and parse one play page. Returns the raw html alongside the sources: when the parse
 * comes back empty the caller needs the page itself to say why (see describePlayPage), and
 * re-fetching to find out would double the load on a host that rate-limits bursts.
 */
export async function fetchPlayPage(
  fetchText: Fetcher,
  domain: string,
  animeSession: string,
  episodeSession: string,
): Promise<{ html: string; sources: KwikSource[] }> {
  const html = await fetchText(`${base(domain)}/play/${animeSession}/${episodeSession}`);
  return { html, sources: parsePlaySources(html) };
}

/**
 * Why did parsePlaySources() come back empty? The regex is the highest-drift code in the app,
 * so a zero-source result is ambiguous between "markup changed", "Cloudflare interstitial" and
 * "episode genuinely has no streams". Reduce the page to a few markers that tell those apart;
 * the string goes into the popup error and the log, never the whole page.
 */
export function describePlayPage(html: string): string {
  const marks = [
    `len=${html.length}`,
    `resolutionMenu=${/resolutionMenu/i.test(html)}`,
    `data-src=${(html.match(/\bdata-src=/gi) || []).length}`,
    `kwik=${(html.match(/kwik\./gi) || []).length}`,
    `button=${(html.match(/<button\b/gi) || []).length}`,
  ];
  // Only an actual interstitial counts: the challenge-platform script tag ships on every
  // normal animepahe page, so matching it reports Cloudflare on pages that loaded fine.
  if (/cf-browser-verification|Just a moment|cf_chl_opt/i.test(html)) marks.push('cloudflare=true');
  const title = html.match(/<title>\s*(.*?)\s*<\/title>/i)?.[1];
  if (title) marks.push(`title="${title.slice(0, 60)}"`);
  return marks.join(' ');
}

/**
 * The raw markup around the first data-src attribute. When the markers say the menu is there
 * but parsePlaySources() still found nothing, only the real tag says which attribute moved.
 */
export function samplePlayMarkup(html: string): string {
  const at = html.search(/\bdata-src=/i);
  if (at < 0) return '(no data-src in page)';
  return html.slice(Math.max(0, at - 220), at + 220).replace(/\s+/g, ' ');
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
