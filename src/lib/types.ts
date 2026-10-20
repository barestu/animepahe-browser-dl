// Shared types across popup / service-worker / offscreen. Single source of truth for messaging.

export type Quality = '360' | '480' | '720' | '1080';
export type Audio = 'jpn' | 'eng';

export interface Episode {
  animeSession: string;
  episodeSession: string;
  episodeNumber: string; // may be decimal, e.g. "7.5"
  title: string; // anime title
}

/** A resolved download source for one quality/audio variant, parsed from the play page. */
export interface KwikSource {
  quality: Quality;
  audio: Audio;
  kwikUrl: string; // https://kwik.si/e/<id>
}

export type JobStage =
  | 'queued'
  | 'extracting' // resolving m3u8 via kwik tab
  | 'downloading' // fetching + decrypting segments
  | 'muxing' // ffmpeg copy-remux
  | 'saving'
  | 'done'
  | 'failed';

export interface Job {
  id: string;
  episode: Episode;
  quality: Quality;
  audio: Audio;
  kwikUrl: string; // resolved in the popup (first-party) at enqueue time
  stage: JobStage;
  segTotal: number;
  segDone: number;
  attempts: number;
  error?: string;
  filename?: string;
}

/** A fully-resolved download request handed from popup to service worker. */
export interface Pick {
  episode: Episode;
  quality: Quality;
  audio: Audio;
  kwikUrl: string;
}

export interface Settings {
  animepaheDomain: string; // e.g. "animepahe.ru"
  quality: Quality;
  audio: Audio;
  filenameTemplate: string; // tokens: {title} {episode} {quality} {audio}
  useCustomFolder: boolean; // File System Access instead of chrome.downloads
  /** Drop completed jobs from the queue when a batch drains, leaving only what needs attention. */
  autoClearDone: boolean;
  segmentConcurrency: number;
  maxRetries: number;
}

export const DEFAULT_SETTINGS: Settings = {
  animepaheDomain: 'animepahe.ru',
  quality: '1080',
  audio: 'jpn',
  filenameTemplate: 'Anime/{title}/{title} - {episode} [{quality}p].mp4',
  useCustomFolder: false,
  autoClearDone: true,
  segmentConcurrency: 3,
  maxRetries: 3,
};

/** storage.local key holding the diagnostic log ring buffer (popup subscribes via onChanged). */
export const LOG_STORAGE_KEY = 'logs';

export interface LogEntry {
  t: string; // ISO timestamp
  ctx: string; // 'sw' | 'offscreen' | 'popup'
  msg: string;
}

// ---- Messaging contracts ----

// popup -> service worker
export type PopupMsg =
  | { type: 'getState' }
  | { type: 'enqueue'; picks: Pick[] }
  | { type: 'retry'; jobId: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'cancelJob'; jobId: string }
  | { type: 'cancelAll' }
  | { type: 'clearFinished' }
  | { type: 'dismissReceipt' }
  | { type: 'getSettings' }
  | { type: 'saveSettings'; settings: Settings };

// any context -> service worker (collector)
export type LogMsg = { type: 'log'; entry: LogEntry };

// service worker -> offscreen
export type OffscreenMsg =
  | {
      target: 'offscreen';
      type: 'process';
      jobId: string;
      m3u8Url: string;
      concurrency: number;
    }
  | { target: 'offscreen'; type: 'revoke'; blobUrl: string }
  // Cooperative control of the job the offscreen document is currently processing.
  | { target: 'offscreen'; type: 'control'; action: 'pause' | 'resume' | 'cancel'; jobId: string };

// offscreen -> service worker
export type OffscreenReply =
  | { type: 'progress'; jobId: string; stage: JobStage; segDone: number; segTotal: number }
  | { type: 'blobReady'; jobId: string; blobUrl: string }
  | { type: 'offscreenError'; jobId: string; error: string };

export interface AppState {
  jobs: Job[];
  running: boolean;
  /** Batch-level pause. Persisted so it survives a service-worker restart. */
  paused: boolean;
  /** Receipt for the last cleared batch — the only success signal left once done jobs auto-clear. */
  lastDone?: { count: number; at: string };
}
