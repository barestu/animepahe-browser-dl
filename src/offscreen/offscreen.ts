// OFFSCREEN document (reason: BLOBS). Only chrome.runtime is available here.
// Job: fetch+decrypt+concat TS (hls.ts) -> ffmpeg copy-remux to mp4 -> mint blob URL ->
// hand the blob URL to the service worker, which performs chrome.downloads.download.

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import { assembleTs } from '@/lib/hls';

// Single-thread core shipped as a static asset in public/ffmpeg (copied at build time — no
// remote code, MV3-compliant). toBlobURL wraps them so the ffmpeg worker can import them.
const coreURL = chrome.runtime.getURL('ffmpeg/ffmpeg-core.js');
const wasmURL = chrome.runtime.getURL('ffmpeg/ffmpeg-core.wasm');
import type { OffscreenMsg, OffscreenReply } from '@/lib/types';

type ProcessMsg = Extract<OffscreenMsg, { type: 'process' }>;

let ffmpeg: FFmpeg | null = null;

async function getFfmpeg(): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg;
  const instance = new FFmpeg();
  await instance.load({
    coreURL: await toBlobURL(coreURL, 'text/javascript'),
    wasmURL: await toBlobURL(wasmURL, 'application/wasm'),
  });
  ffmpeg = instance;
  return instance;
}

function reply(msg: OffscreenReply): void {
  chrome.runtime.sendMessage(msg);
}

async function process(msg: ProcessMsg): Promise<void> {
  const { jobId, m3u8Url, concurrency } = msg;
  try {
    reply({ type: 'progress', jobId, stage: 'downloading', segDone: 0, segTotal: 0 });
    const ts = await assembleTs(m3u8Url, concurrency, (done, total) =>
      reply({ type: 'progress', jobId, stage: 'downloading', segDone: done, segTotal: total }),
    );

    reply({ type: 'progress', jobId, stage: 'muxing', segDone: 0, segTotal: 0 });
    const ff = await getFfmpeg();
    await ff.writeFile('in.ts', ts);
    // copy-remux only: no transcode. aac_adtstoasc fixes ADTS->ASC for the mp4 container.
    await ff.exec(['-i', 'in.ts', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', 'out.mp4']);
    const out = (await ff.readFile('out.mp4')) as Uint8Array;
    await ff.deleteFile('in.ts');
    await ff.deleteFile('out.mp4');

    const blob = new Blob([out as BlobPart], { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);
    reply({ type: 'blobReady', jobId, blobUrl });
  } catch (e) {
    reply({ type: 'offscreenError', jobId, error: e instanceof Error ? e.message : String(e) });
  }
}

chrome.runtime.onMessage.addListener((msg: OffscreenMsg) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'process') void process(msg);
  else if (msg.type === 'revoke') URL.revokeObjectURL(msg.blobUrl);
});
