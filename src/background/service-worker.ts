// Orchestrator. Owns queue, DNR rules, offscreen lifecycle, kwik m3u8 sniffing, and downloads.
// Offscreen can only use chrome.runtime, so ALL chrome.* API work happens here (SPEC).

import { loadSettings, saveSettings } from '@/lib/settings';
import { buildFilename } from '@/lib/naming';
import { appendLog } from '@/lib/logger';
import type { Episode, Job, LogMsg, OffscreenReply, Pick, PopupMsg } from '@/lib/types';
import { enableKwikNavRule, setCdnRefererRule, disableAllRules } from './dnr';
import { ensureOffscreen, closeOffscreen } from './offscreen';
import { resolveM3u8 } from './kwik';
import * as store from './queue-store';

// jobId -> resolver for the offscreen blob result.
const pending = new Map<string, { resolve: (blobUrl: string) => void; reject: (e: Error) => void }>();
let looping = false;

function jobId(ep: Episode, q: string, a: string): string {
  return `${ep.animeSession}:${ep.episodeSession}:${q}:${a}`;
}

// Logging is always on (capped ring buffer in storage.local; popup reads it live).
function swLog(msg: string, data?: unknown): void {
  const line = data === undefined ? msg : `${msg} ${typeof data === 'string' ? data : JSON.stringify(data)}`;
  void appendLog({ t: new Date().toISOString(), ctx: 'sw', msg: line });
}

// ---- messaging ----

chrome.runtime.onMessage.addListener((msg: PopupMsg | OffscreenReply | LogMsg, _sender, sendResponse) => {
  // log entries from offscreen/popup
  if ('type' in msg && msg.type === 'log') {
    void appendLog((msg as LogMsg).entry);
    return false;
  }
  // offscreen -> sw
  if ('type' in msg && (msg.type === 'progress' || msg.type === 'blobReady' || msg.type === 'offscreenError')) {
    handleOffscreenReply(msg as OffscreenReply);
    return false;
  }
  // popup -> sw (async replies use sendResponse; return true to keep the channel open)
  handlePopup(msg as PopupMsg).then(sendResponse);
  return true;
});

async function handlePopup(msg: PopupMsg): Promise<unknown> {
  switch (msg.type) {
    case 'getState':
      return store.getState();
    case 'getSettings':
      return loadSettings();
    case 'saveSettings':
      await saveSettings(msg.settings);
      swLog('settings saved', { domain: msg.settings.animepaheDomain });
      return { ok: true };
    case 'enqueue':
      swLog('enqueue', msg.picks.map((p) => `${p.episode.episodeNumber}[${p.quality}p]`).join(','));
      await enqueue(msg.picks);
      void runLoop();
      return { ok: true };
    case 'retry':
      await store.patchJob(msg.jobId, { stage: 'queued', error: undefined, attempts: 0 });
      void runLoop();
      return { ok: true };
    case 'cancelAll':
      await store.cancelAll();
      return { ok: true };
  }
}

function handleOffscreenReply(reply: OffscreenReply): void {
  if (reply.type === 'progress') {
    void store.patchJob(reply.jobId, {
      stage: reply.stage,
      segDone: reply.segDone,
      segTotal: reply.segTotal,
    });
  } else if (reply.type === 'blobReady') {
    pending.get(reply.jobId)?.resolve(reply.blobUrl);
  } else if (reply.type === 'offscreenError') {
    pending.get(reply.jobId)?.reject(new Error(reply.error));
  }
}

// ---- queue building ----

async function enqueue(picks: Pick[]): Promise<void> {
  const jobs: Job[] = picks.map((p) => ({
    id: jobId(p.episode, p.quality, p.audio),
    episode: p.episode,
    quality: p.quality,
    audio: p.audio,
    kwikUrl: p.kwikUrl,
    stage: 'queued',
    segTotal: 0,
    segDone: 0,
    attempts: 0,
  }));
  await store.addJobs(jobs);
}

// ---- run loop (sequential) ----

async function runLoop(): Promise<void> {
  if (looping) return;
  looping = true;
  const settings = await loadSettings();
  await store.setRunning(true);
  swLog('batch start', { domain: settings.animepaheDomain, concurrency: settings.segmentConcurrency });
  await enableKwikNavRule(settings.animepaheDomain);
  await ensureOffscreen();

  try {
    let job: Job | undefined;
    while ((job = await store.nextQueued())) {
      await runJob(job, settings.animepaheDomain, settings.filenameTemplate, settings.segmentConcurrency, settings.maxRetries);
    }
  } finally {
    await disableAllRules();
    await closeOffscreen();
    await store.setRunning(false);
    looping = false;
    swLog('batch end');
  }
}

async function runJob(
  job: Job,
  animepaheDomain: string,
  template: string,
  concurrency: number,
  maxRetries: number,
): Promise<void> {
  const tag = `ep ${job.episode.episodeNumber}`;
  try {
    // 1. sniff the m3u8 by loading the (already-resolved) kwik link in a background tab
    await store.patchJob(job.id, { stage: 'extracting' });
    swLog(`${tag}: extracting`, job.kwikUrl);
    const m3u8Url = await resolveM3u8(job.kwikUrl);
    swLog(`${tag}: m3u8`, m3u8Url);

    // 2. point CDN fetches at THIS job's kwik origin (owocdn validates the embedding host)
    await setCdnRefererRule(new URL(job.kwikUrl).origin, animepaheDomain);

    // 3. hand off to offscreen for fetch+decrypt+mux; await the blob URL
    // clamp concurrency: owocdn rate-limits (429) above a few parallel connections
    await store.patchJob(job.id, { stage: 'downloading' });
    const blobUrl = await requestBlob(job.id, m3u8Url, Math.min(concurrency, 4));

    // 4. download from the service worker (offscreen can't use chrome.downloads)
    await store.patchJob(job.id, { stage: 'saving' });
    const filename = buildFilename(template, job);
    swLog(`${tag}: saving`, filename);
    await downloadAndWait(blobUrl, filename);
    swLog(`${tag}: done`, filename);

    // 5. release the blob in the context that created it
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', blobUrl }).catch(() => {});
    pending.delete(job.id);
    await store.patchJob(job.id, { stage: 'done', filename });
  } catch (e) {
    pending.delete(job.id);
    const attempts = job.attempts + 1;
    swLog(`${tag}: error (attempt ${attempts})`, e instanceof Error ? e.message : String(e));
    if (attempts < maxRetries) {
      await store.patchJob(job.id, { stage: 'queued', attempts });
    } else {
      await store.patchJob(job.id, {
        stage: 'failed',
        attempts,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

function requestBlob(id: string, m3u8Url: string, concurrency: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    chrome.runtime
      .sendMessage({ target: 'offscreen', type: 'process', jobId: id, m3u8Url, concurrency })
      .catch(reject);
  });
}

function downloadAndWait(url: string, filename: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        reject(new Error(chrome.runtime.lastError?.message ?? 'download failed to start'));
        return;
      }
      const onChanged = (delta: chrome.downloads.DownloadDelta) => {
        if (delta.id !== downloadId || !delta.state) return;
        if (delta.state.current === 'complete') {
          chrome.downloads.onChanged.removeListener(onChanged);
          resolve();
        } else if (delta.state.current === 'interrupted') {
          chrome.downloads.onChanged.removeListener(onChanged);
          reject(new Error('download interrupted'));
        }
      };
      chrome.downloads.onChanged.addListener(onChanged);
    });
  });
}

// Resume an interrupted batch if the SW restarts mid-run.
chrome.runtime.onStartup.addListener(() => void runLoop());
