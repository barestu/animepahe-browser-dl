// Orchestrator. Owns queue, DNR rules, offscreen lifecycle, kwik m3u8 sniffing, and downloads.
// Offscreen can only use chrome.runtime, so ALL chrome.* API work happens here (SPEC).

import { loadSettings, saveSettings } from '@/lib/settings';
import { buildFilename } from '@/lib/naming';
import { appendLog } from '@/lib/logger';
import { Gate, CanceledError } from '@/lib/control';
import type { Episode, Job, LogMsg, OffscreenReply, Pick, PopupMsg } from '@/lib/types';
import { enableKwikNavRule, setCdnRefererRule, disableAllRules } from './dnr';
import { ensureOffscreen, closeOffscreen } from './offscreen';
import { resolveM3u8 } from './kwik';
import { updateBadge, refreshAllBadges } from './badge';
import * as store from './queue-store';

// jobId -> resolver for the offscreen blob result.
const pending = new Map<string, { resolve: (blobUrl: string) => void; reject: (e: Error) => void }>();
let looping = false;

// ---- pause / cancel control ----
// `paused` is batch-level (mirrored into store so it survives an SW restart). `currentGate` is
// the gate for the job in flight; it is mirrored into the offscreen document so the segment
// pool and ffmpeg obey the same pause/cancel.
let paused = false;
let currentGate: Gate | null = null;
let currentJobId: string | null = null;
let betweenJobsWaiters: Array<() => void> = [];

// MV3 terminates an idle service worker after ~30s. While a batch is paused there is no
// message traffic to keep it alive, and losing the SW would strand the in-flight job (its gate
// and the offscreen document's in-memory segments live only in RAM). Touching a chrome API on
// an interval resets the idle timer for as long as the pause lasts.
let keepAlive: ReturnType<typeof setInterval> | null = null;

function startKeepAlive(): void {
  if (keepAlive) return;
  keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
}

function stopKeepAlive(): void {
  if (!keepAlive) return;
  clearInterval(keepAlive);
  keepAlive = null;
}

function jobId(ep: Episode, q: string, a: string): string {
  return `${ep.animeSession}:${ep.episodeSession}:${q}:${a}`;
}

// Logging is always on (capped ring buffer in storage.local; popup reads it live).
function swLog(msg: string, data?: unknown): void {
  const line = data === undefined ? msg : `${msg} ${typeof data === 'string' ? data : JSON.stringify(data)}`;
  void appendLog({ t: new Date().toISOString(), ctx: 'sw', msg: line });
}

function tellOffscreen(action: 'pause' | 'resume' | 'cancel', id: string): void {
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'control', action, jobId: id }).catch(() => {});
}

function releaseBetweenJobs(): void {
  const waiters = betweenJobsWaiters;
  betweenJobsWaiters = [];
  for (const r of waiters) r();
}

/** Checkpoint between episodes: holds the run loop for as long as the batch is paused. */
function waitWhilePaused(): Promise<void> {
  if (!paused) return Promise.resolve();
  return new Promise<void>((r) => betweenJobsWaiters.push(r));
}

async function pauseBatch(): Promise<void> {
  if (paused) return;
  paused = true;
  await store.setPaused(true);
  currentGate?.pause();
  if (currentJobId) tellOffscreen('pause', currentJobId);
  startKeepAlive();
  swLog('paused', currentJobId ?? '(idle)');
}

async function resumeBatch(): Promise<void> {
  paused = false;
  stopKeepAlive();
  await store.setPaused(false);
  currentGate?.resume();
  if (currentJobId) tellOffscreen('resume', currentJobId);
  releaseBetweenJobs();
  swLog('resumed');
  // Nothing is looping if the batch was paused before/between runs — kick it.
  void runLoop();
}

/** Abort whatever the in-flight job is doing (segment fetches, kwik tab, ffmpeg, download). */
function abortCurrent(): void {
  if (!currentJobId) return;
  tellOffscreen('cancel', currentJobId);
  currentGate?.cancel();
}

// ---- toolbar badge ----
// Registered at top level: MV3 only revives the SW for listeners bound synchronously.

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  // animepahe is an SPA — the URL can change without a full load, so watch both.
  if (info.url || info.status === 'complete') void updateBadge(tabId, info.url ?? tab.url);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(
    (tab) => void updateBadge(tabId, tab.url),
    () => {}, // tab vanished
  );
});

chrome.runtime.onInstalled.addListener(() => void refreshAllBadges());

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
      void refreshAllBadges(); // the saved domain feeds matchTab()
      return { ok: true };
    case 'enqueue':
      swLog('enqueue', msg.picks.map((p) => `${p.episode.episodeNumber}[${p.quality}p]`).join(','));
      await store.clearReceipt(); // the previous batch's receipt is stale the moment a new one starts
      await enqueue(msg.picks);
      void runLoop();
      return { ok: true };
    case 'retry':
      await store.patchJob(msg.jobId, { stage: 'queued', error: undefined, attempts: 0 });
      void runLoop();
      return { ok: true };
    case 'pause':
      await pauseBatch();
      return { ok: true };
    case 'resume':
      await resumeBatch();
      return { ok: true };
    case 'cancelJob':
      // Dropping the job from the queue is what makes it "canceled": the run loop skips it,
      // and runJob's catch sees an already-removed job so patchJob is a no-op.
      if (msg.jobId === currentJobId) abortCurrent();
      await store.removeJob(msg.jobId);
      swLog('job canceled', msg.jobId);
      return { ok: true };
    case 'cancelAll':
      abortCurrent();
      paused = false;
      stopKeepAlive();
      releaseBetweenJobs(); // a paused run loop must be let go so it can observe the empty queue
      await store.cancelAll();
      swLog('batch canceled');
      return { ok: true };
    case 'clearFinished':
      await store.clearFinished();
      return { ok: true };
    case 'dismissReceipt':
      await store.clearReceipt();
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
  paused = (await store.getState()).paused; // restore across an SW restart
  await store.setRunning(true);
  // Honour a pause set while the queue was idle BEFORE arming the DNR Referer rules — they are
  // the widest part of the extension's surface (SPEC "Security"), so don't hold them open for a
  // pause window that hasn't downloaded anything yet.
  if (paused) startKeepAlive();
  await waitWhilePaused();
  swLog('batch start', { domain: settings.animepaheDomain, concurrency: settings.segmentConcurrency });
  await enableKwikNavRule(settings.animepaheDomain);
  await ensureOffscreen();

  try {
    let job: Job | undefined;
    while ((job = await store.nextQueued())) {
      await waitWhilePaused();
      // Re-read: the job may have been canceled (removed) while the loop was parked.
      const fresh = await store.getJob(job.id);
      if (!fresh || fresh.stage !== 'queued') continue;
      await runJob(fresh, settings.animepaheDomain, settings.filenameTemplate, settings.segmentConcurrency, settings.maxRetries);
    }
  } finally {
    await disableAllRules();
    await closeOffscreen();
    // Re-read: the toggle may have been flipped mid-batch. Done jobs are dropped only once the
    // queue has drained, so the list stays a live record of the batch while it runs and ends up
    // holding exactly what still needs attention (failed jobs, which keep their Retry button).
    if ((await loadSettings()).autoClearDone) await store.clearFinished();
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
  const gate = new Gate();
  if (paused) gate.pause(); // a pause raced in between the checkpoint and here
  currentGate = gate;
  currentJobId = job.id;
  try {
    // 1. sniff the m3u8 by loading the (already-resolved) kwik link in a background tab
    await store.patchJob(job.id, { stage: 'extracting' });
    swLog(`${tag}: extracting`, job.kwikUrl);
    const m3u8Url = await resolveM3u8(job.kwikUrl, gate);
    swLog(`${tag}: m3u8`, m3u8Url);

    // 2. point CDN fetches at THIS job's kwik origin (owocdn validates the embedding host)
    await setCdnRefererRule(new URL(job.kwikUrl).origin, animepaheDomain);

    // 3. hand off to offscreen for fetch+decrypt+mux; await the blob URL
    // A pause taken during extraction holds HERE, before the offscreen job exists — otherwise
    // the 'pause' control message would arrive before the gate it is meant to close.
    await gate.wait();
    // clamp concurrency: owocdn rate-limits (429) above a few parallel connections
    await store.patchJob(job.id, { stage: 'downloading' });
    const blobUrl = await requestBlob(job.id, m3u8Url, Math.min(concurrency, 4), gate);

    // 4. download from the service worker (offscreen can't use chrome.downloads)
    await store.patchJob(job.id, { stage: 'saving' });
    const filename = buildFilename(template, job);
    swLog(`${tag}: saving`, filename);
    await downloadAndWait(blobUrl, filename, gate);
    swLog(`${tag}: done`, filename);

    // 5. release the blob in the context that created it
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', blobUrl }).catch(() => {});
    pending.delete(job.id);
    await store.patchJob(job.id, { stage: 'done', filename });
  } catch (e) {
    pending.delete(job.id);
    // A cancel is not a failure: the job was already removed from the queue, so don't retry it
    // and don't resurrect it with a patch.
    if (gate.isCanceled || e instanceof CanceledError) {
      swLog(`${tag}: canceled`);
      return;
    }
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
  } finally {
    currentGate = null;
    currentJobId = null;
  }
}

function requestBlob(id: string, m3u8Url: string, concurrency: number, gate: Gate): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const onAbort = () => reject(new CanceledError());
    gate.signal.addEventListener('abort', onAbort, { once: true });
    if (gate.isCanceled) {
      onAbort();
      return;
    }
    chrome.runtime
      .sendMessage({ target: 'offscreen', type: 'process', jobId: id, m3u8Url, concurrency })
      .catch(reject);
  });
}

function downloadAndWait(url: string, filename: string, gate: Gate): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        reject(new Error(chrome.runtime.lastError?.message ?? 'download failed to start'));
        return;
      }
      const cleanup = () => {
        chrome.downloads.onChanged.removeListener(onChanged);
        gate.signal.removeEventListener('abort', onAbort);
      };
      const onChanged = (delta: chrome.downloads.DownloadDelta) => {
        if (delta.id !== downloadId || !delta.state) return;
        if (delta.state.current === 'complete') {
          cleanup();
          resolve();
        } else if (delta.state.current === 'interrupted') {
          cleanup();
          reject(gate.isCanceled ? new CanceledError() : new Error('download interrupted'));
        }
      };
      // Cancel during the (fast, local) blob write: kill the download and erase the partial file.
      const onAbort = () => {
        cleanup();
        chrome.downloads.cancel(downloadId, () => {
          void chrome.runtime.lastError; // nothing to do if it already finished
          chrome.downloads.erase({ id: downloadId }).catch(() => {});
        });
        reject(new CanceledError());
      };
      chrome.downloads.onChanged.addListener(onChanged);
      gate.signal.addEventListener('abort', onAbort, { once: true });
      if (gate.isCanceled) onAbort();
    });
  });
}

// Resume an interrupted batch if the SW restarts mid-run.
chrome.runtime.onStartup.addListener(() => void runLoop());

// Already-open tabs get no navigation event on startup, so paint them here.
chrome.runtime.onStartup.addListener(() => void refreshAllBadges());
