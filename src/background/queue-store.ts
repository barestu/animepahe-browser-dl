// Persistent job queue in chrome.storage.local so a batch survives service-worker sleep.

import type { AppState, Job } from '@/lib/types';

const KEY = 'queue';

export async function getState(): Promise<AppState> {
  const got = await chrome.storage.local.get(KEY);
  return (got[KEY] as AppState) ?? { jobs: [], running: false };
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

export async function patchJob(id: string, patch: Partial<Job>): Promise<void> {
  const state = await getState();
  const job = state.jobs.find((j) => j.id === id);
  if (job) Object.assign(job, patch);
  await setState(state);
}

export async function setRunning(running: boolean): Promise<void> {
  const state = await getState();
  state.running = running;
  await setState(state);
}

export async function clearFinished(): Promise<void> {
  const state = await getState();
  state.jobs = state.jobs.filter((j) => j.stage !== 'done');
  await setState(state);
}

export async function cancelAll(): Promise<void> {
  await setState({ jobs: [], running: false });
}

export async function nextQueued(): Promise<Job | undefined> {
  const state = await getState();
  return state.jobs.find((j) => j.stage === 'queued');
}
