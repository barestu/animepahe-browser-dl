// HLS assembly: parse m3u8 -> fetch key -> fetch+decrypt segments -> concat TS bytes.
// Runs in the OFFSCREEN document. Segment/key/m3u8 requests get their Referer/Origin
// rewritten to kwik by a DNR session rule installed by the service worker (SPEC Q6).
//
// Pause/cancel: every pool worker awaits `gate.wait()` before claiming the next segment, and
// every fetch carries `gate.signal`. Pausing blocks the workers, so already-downloaded segments
// stay in the results array and resuming continues the same run.

import { Gate, CanceledError, sleep } from './control';

interface KeyInfo {
  uri: string;
  iv?: Uint8Array; // explicit IV from #EXT-X-KEY, else derived per-segment
}

interface Playlist {
  segmentUrls: string[];
  key?: KeyInfo;
}

function resolveUrl(base: string, rel: string): string {
  return new URL(rel, base).href;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/** IV for AES-128 HLS when not explicit: 16-byte big-endian media sequence number. */
function ivFromSequence(seq: number): Uint8Array {
  const iv = new Uint8Array(16);
  const view = new DataView(iv.buffer);
  view.setUint32(12, seq >>> 0, false);
  return iv;
}

export function parseM3u8(text: string, m3u8Url: string): Playlist {
  const lines = text.split(/\r?\n/);
  const segmentUrls: string[] = [];
  let key: KeyInfo | undefined;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-KEY')) {
      const method = line.match(/METHOD=([^,]+)/)?.[1];
      if (method && method !== 'NONE') {
        const uri = line.match(/URI="([^"]+)"/)?.[1];
        const ivHex = line.match(/IV=([0-9A-Fa-fx]+)/)?.[1];
        if (uri) key = { uri: resolveUrl(m3u8Url, uri), iv: ivHex ? hexToBytes(ivHex) : undefined };
      }
    } else if (line && !line.startsWith('#')) {
      segmentUrls.push(resolveUrl(m3u8Url, line));
    }
  }
  return { segmentUrls, key };
}

// Retry on rate-limit / transient CDN errors with exponential backoff (honoring Retry-After).
async function fetchBytes(url: string, gate: Gate, attempt = 0): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url, { signal: gate.signal });
  } catch (e) {
    // An aborted fetch is a cancel, never a transient CDN failure — don't retry it.
    if (gate.isCanceled) throw new CanceledError();
    throw e;
  }
  if (res.ok) return new Uint8Array(await res.arrayBuffer());

  const retryable = res.status === 429 || res.status === 503 || res.status === 502;
  if (retryable && attempt < 6) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(1000 * 2 ** attempt, 15_000) + Math.floor(attempt * 250);
    await sleep(backoff, gate); // rejects immediately on cancel instead of idling 15s
    await gate.wait(); // a pause during backoff holds here rather than hammering the CDN
    return fetchBytes(url, gate, attempt + 1);
  }
  throw new Error(`fetch ${url} -> ${res.status}`);
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-CBC' }, false, ['decrypt']);
}

async function decryptSegment(data: Uint8Array, key: CryptoKey, iv: Uint8Array): Promise<Uint8Array> {
  const out = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv as BufferSource }, key, data as BufferSource);
  return new Uint8Array(out);
}

interface Pooled<T> {
  index: number;
  value: T;
}

/** Run tasks with bounded concurrency, preserving order in the results array. */
async function pool<T>(
  count: number,
  limit: number,
  gate: Gate,
  task: (i: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array(count);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < count) {
      // Interruptible boundary: claim the index only after the gate lets us through, so a
      // pause never strands a half-claimed slot and a cancel stops the pool promptly.
      await gate.wait();
      const i = next++;
      results[i] = await task(i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, count) }, () => worker()));
  return results;
}

export interface AssembleProgress {
  (done: number, total: number): void;
}

/** Download every segment, decrypt if needed, and return the concatenated MPEG-TS bytes. */
export async function assembleTs(
  m3u8Url: string,
  concurrency: number,
  onProgress: AssembleProgress,
  gate: Gate,
): Promise<Uint8Array> {
  const manifestText = new TextDecoder().decode(await fetchBytes(m3u8Url, gate));
  const { segmentUrls, key } = parseM3u8(manifestText, m3u8Url);
  if (segmentUrls.length === 0) throw new Error('no segments in m3u8');

  const cryptoKey = key ? await importKey(await fetchBytes(key.uri, gate)) : null;
  const total = segmentUrls.length;
  let done = 0;

  const parts = await pool<Pooled<Uint8Array>>(total, concurrency, gate, async (i) => {
    const raw = await fetchBytes(segmentUrls[i], gate);
    let value = raw;
    if (cryptoKey && key) {
      const iv = key.iv ?? ivFromSequence(i);
      value = await decryptSegment(raw, cryptoKey, iv);
    }
    done += 1;
    onProgress(done, total);
    return { index: i, value };
  });

  // concat in order
  const totalLen = parts.reduce((n, p) => n + p.value.length, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    merged.set(p.value, offset);
    offset += p.value.length;
  }
  return merged;
}
