import type { Job } from './types';

const ILLEGAL = /[\\/:*?"<>|]/g;

/** Extract the anime session id from an animepahe `/anime/<session>` URL, if present. */
export function parseAnimeSession(url: string | undefined): string | null {
  const m = url?.match(/\/anime\/([A-Za-z0-9-]+)/);
  return m?.[1] ?? null;
}

/** Sanitize one path segment: strip illegal chars AND traversal. Never returns empty. */
function sanitizeSegment(s: string): string {
  const cleaned = s
    .replace(ILLEGAL, '_')
    .replace(/^\.+/, '') // no leading dots (., ..)
    .trim();
  return cleaned || '_';
}

/** Zero-pad integer episode numbers to 2 digits; preserve decimals (7.5 -> 07.5). */
function padEpisode(ep: string): string {
  const m = ep.match(/^(\d+)(\.\d+)?$/);
  if (!m) return sanitizeSegment(ep);
  const int = m[1].padStart(2, '0');
  return int + (m[2] ?? '');
}

/**
 * Build a Downloads-relative path from the template. Each path segment is sanitized
 * independently so `{title}` cannot inject `../` or absolute paths (traversal guard).
 */
export function buildFilename(template: string, job: Job): string {
  const tokens: Record<string, string> = {
    title: job.episode.title,
    episode: padEpisode(job.episode.episodeNumber),
    quality: job.quality,
    audio: job.audio,
  };

  const substituted = template.replace(/\{(title|episode|quality|audio)\}/g, (_, k) => tokens[k] ?? '');

  return substituted
    .split('/')
    .map((seg) => sanitizeSegment(seg))
    .filter(Boolean)
    .join('/');
}
