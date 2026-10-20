// OFFSCREEN document (reason: BLOBS). Only chrome.runtime is available here.
// Job: fetch+decrypt+concat TS (hls.ts) -> ffmpeg copy-remux to mp4 -> mint blob URL ->
// hand the blob URL to the service worker, which performs chrome.downloads.download.

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { assembleTs } from '@/lib/hls';
import { Gate, CanceledError } from '@/lib/control';
import { remoteLogger } from '@/lib/logger';

const log = remoteLogger('offscreen');

// Single-thread core shipped as a static asset in public/ffmpeg (copied at build time — no
// remote code, MV3-compliant). Pass the chrome-extension:// URLs DIRECTLY (not blob URLs):
// the ffmpeg worker does `import(coreURL)`, and MV3 CSP script-src forbids blob: but allows
// 'self' (the extension origin). See SPEC "ffmpeg".
const coreURL = chrome.runtime.getURL('ffmpeg/ffmpeg-core.js');
const wasmURL = chrome.runtime.getURL('ffmpeg/ffmpeg-core.wasm');
import type { OffscreenMsg, OffscreenReply } from '@/lib/types';

type ProcessMsg = Extract<OffscreenMsg, { type: 'process' }>;

let ffmpeg: FFmpeg | null = null;

// jobId -> pause/cancel gate for the job this document is processing (one at a time; the SW
// runs episodes sequentially). The SW drives these via 'control' messages.
const gates = new Map<string, Gate>();

async function getFfmpeg(): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg;
  const instance = new FFmpeg();
  await instance.load({ coreURL, wasmURL });
  ffmpeg = instance;
  return instance;
}

function reply(msg: OffscreenReply): void {
  chrome.runtime.sendMessage(msg);
}

/**
 * ffmpeg.wasm has no cancel API — the only way out of a running exec() is to kill the worker.
 * We drop the instance so the next job reloads a fresh core.
 */
function killFfmpeg(): void {
  if (!ffmpeg) return;
  try {
    ffmpeg.terminate();
  } catch {
    /* already gone */
  }
  ffmpeg = null;
}

async function process(msg: ProcessMsg): Promise<void> {
  const { jobId, m3u8Url, concurrency } = msg;
  const gate = new Gate();
  gates.set(jobId, gate);
  gate.signal.addEventListener('abort', killFfmpeg, { once: true });
  try {
    reply({ type: 'progress', jobId, stage: 'downloading', segDone: 0, segTotal: 0 });
    log('assemble start', { jobId, concurrency });
    const ts = await assembleTs(
      m3u8Url,
      concurrency,
      (done, total) => reply({ type: 'progress', jobId, stage: 'downloading', segDone: done, segTotal: total }),
      gate,
    );
    log('assembled TS', { jobId, bytes: ts.length });

    // Last cheap checkpoint: a pause taken here holds BEFORE the mux, because ffmpeg.wasm
    // cannot be suspended once exec() starts.
    await gate.wait();

    reply({ type: 'progress', jobId, stage: 'muxing', segDone: 0, segTotal: 0 });
    const ff = await getFfmpeg();
    await ff.writeFile('in.ts', ts);
    // copy-remux only: no transcode. aac_adtstoasc fixes ADTS->ASC for the mp4 container.
    await ff.exec(['-i', 'in.ts', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', 'out.mp4']);
    const out = (await ff.readFile('out.mp4')) as Uint8Array;
    await ff.deleteFile('in.ts');
    await ff.deleteFile('out.mp4');
    log('mux done', { jobId, mp4Bytes: out.length });

    // Don't mint a blob URL nobody will ever claim: the SW has stopped waiting for this job.
    if (gate.isCanceled) throw new CanceledError();

    const blob = new Blob([out as BlobPart], { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);
    reply({ type: 'blobReady', jobId, blobUrl });
  } catch (e) {
    const error = gate.isCanceled ? 'canceled' : e instanceof Error ? e.message : String(e);
    log(gate.isCanceled ? 'canceled' : 'ERROR', { jobId, error });
    reply({ type: 'offscreenError', jobId, error });
  } finally {
    gate.signal.removeEventListener('abort', killFfmpeg);
    gates.delete(jobId);
  }
}

function control(action: 'pause' | 'resume' | 'cancel', jobId: string): void {
  const gate = gates.get(jobId);
  if (!gate) return;
  log(`control ${action}`, { jobId });
  if (action === 'pause') gate.pause();
  else if (action === 'resume') gate.resume();
  else gate.cancel();
}

chrome.runtime.onMessage.addListener((msg: OffscreenMsg) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'process') void process(msg);
  else if (msg.type === 'revoke') URL.revokeObjectURL(msg.blobUrl);
  else if (msg.type === 'control') control(msg.action, msg.jobId);
});
