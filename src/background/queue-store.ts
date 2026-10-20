// Persistent job queue in chrome.storage.local so a batch survives service-worker sleep.

import type { AppState, Job } from '@/lib/types';

const KEY = 'queue';

const EMPTY: AppState = { jobs: [], running: false, paused: false };

export async function getState(): Promise<AppState> {
  const got = await chrome.storage.local.get(KEY);
  // Spread over EMPTY so a state written by an older build (no `paused`) still loads.
  return { ...EMPTY, ...((got[KEY] as AppState) ?? {}) };
}

async function setState(state: AppState): Promise<void> {
  await chrome.storage.local.set({ [KEY]: state });
  // Best-effort push to any open popup; ignore "no receiver" errors.
  chrome.runtime.sendMessage({ type: 'stateUpdate', state }).catch(() => {});
}

export async function addJobs(jobs: Job[]): Promise<void> {
  const state = await getState();
  state.jobs.push(...jobs);
  await setState(state);
}

export async function getJob(id: string): Promise<Job | undefined> {
  const state = await getState();
  return state.jobs.find((j) => j.id === id);
}

export async function patchJob(id: string, patch: Partial<Job>): Promise<void> {
  const state = await getState();
  const job = state.jobs.find((j) => j.id === id);
  if (job) Object.assign(job, patch);
  await setState(state);
}

export async function removeJob(id: string): Promise<void> {
  const state = await getState();
  state.jobs = state.jobs.filter((j) => j.id !== id);
  await setState(state);
}

export async function setRunning(running: boolean): Promise<void> {
  const state = await getState();
  state.running = running;
  await setState(state);
}

export async function setPaused(paused: boolean): Promise<void> {
  const state = await getState();
  state.paused = paused;
  await setState(state);
}

/** Drop completed jobs, leaving a receipt so the popup can still confirm what was saved. */
export async function clearFinished(): Promise<number> {
  const state = await getState();
  const before = state.jobs.length;
  state.jobs = state.jobs.filter((j) => j.stage !== 'done');
  const cleared = before - state.jobs.length;
  if (cleared > 0) state.lastDone = { count: cleared, at: new Date().toISOString() };
  await setState(state);
  return cleared;
}

/** Drop every job. The caller is responsible for aborting whatever is mid-flight. */
export async function cancelAll(): Promise<void> {
  await setState({ jobs: [], running: false, paused: false });
}

/** Dismiss the "last batch saved" receipt. */
export async function clearReceipt(): Promise<void> {
  const state = await getState();
  delete state.lastDone;
  await setState(state);
}

export async function nextQueued(): Promise<Job | undefined> {
  const state = await getState();
  return state.jobs.find((j) => j.stage === 'queued');
}
