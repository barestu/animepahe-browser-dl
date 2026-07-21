import { LOG_STORAGE_KEY as LOG_KEY, type LogEntry } from './types';

const MAX_LINES = 5000;

function fmt(msg: string, data?: unknown): string {
  if (data === undefined) return msg;
  let s: string;
  try {
    s = typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    s = String(data);
  }
  return `${msg} ${s}`;
}

/**
 * Remote logger for contexts that are NOT the collector (offscreen, popup). Sends each entry to
 * the service worker via runtime messaging; the SW decides whether to persist (logging setting).
 */
export function remoteLogger(ctx: string) {
  return (msg: string, data?: unknown) => {
    const entry: LogEntry = { t: new Date().toISOString(), ctx, msg: fmt(msg, data) };
    chrome.runtime.sendMessage({ type: 'log', entry }).catch(() => {});
  };
}

/**
 * Collector-side helpers (service worker). Appends directly to chrome.storage.local, capped.
 * Gated by the caller on the logging setting.
 */
export async function appendLog(entry: LogEntry): Promise<void> {
  const got = await chrome.storage.local.get(LOG_KEY);
  const logs: LogEntry[] = got[LOG_KEY] ?? [];
  logs.push(entry);
  if (logs.length > MAX_LINES) logs.splice(0, logs.length - MAX_LINES);
  await chrome.storage.local.set({ [LOG_KEY]: logs });
}

export async function getLogs(): Promise<LogEntry[]> {
  const got = await chrome.storage.local.get(LOG_KEY);
  return got[LOG_KEY] ?? [];
}

export async function clearLogs(): Promise<void> {
  await chrome.storage.local.set({ [LOG_KEY]: [] });
}

/** Serialize a log buffer to a plain-text dump. */
export function logsToText(logs: LogEntry[]): string {
  return logs.map((e) => `[${e.t}] ${e.ctx.padEnd(9)} ${e.msg}`).join('\n') + '\n';
}
