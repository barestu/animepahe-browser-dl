<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { getAnimeTitle, getEpisodeList, fetchPlayPage, pickSource } from '@/lib/animepahe';
  import { tabFetcher, type Fetcher } from '@/lib/tab-fetch';
  import { matchTab, type TabMatch } from '@/lib/match';
  import { logsToText, remoteLogger, getLogs, clearLogs } from '@/lib/logger';
  import type { AppState, Audio, Episode, Job, LogEntry, Pick, Quality, Settings } from '@/lib/types';
  import { DEFAULT_SETTINGS, LOG_STORAGE_KEY } from '@/lib/types';

  const plog = remoteLogger('popup');

  let loading = true;
  let error = '';
  let title = '';
  let episodes: Episode[] = [];
  let selected = new Set<string>(); // episodeSession
  let rangeText = '';
  let quality: Quality = '1080';
  let audio: Audio = 'jpn';
  let state: AppState = { jobs: [], running: false, paused: false };
  let settings: Settings = DEFAULT_SETTINGS;
  let showSettings = false;
  let tabId = -1;
  let domain = '';
  let fetchText: Fetcher = async () => '';
  let resolving = false;
  let match: TabMatch | null = null;

  // --- log terminal ---
  let logsOpen = false;
  let logs: LogEntry[] = [];
  let copied = false;
  let logBox: HTMLDivElement | undefined;

  const send = (msg: unknown) => chrome.runtime.sendMessage(msg);

  onMount(async () => {
    settings = (await send({ type: 'getSettings' })) as Settings;
    quality = settings.quality;
    audio = settings.audio;
    state = (await send({ type: 'getState' })) as AppState;

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'stateUpdate') state = msg.state as AppState;
    });

    // Live log buffer: initial read + subscribe to storage changes (SW writes there).
    logs = await getLogs();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[LOG_STORAGE_KEY]) {
        logs = (changes[LOG_STORAGE_KEY].newValue as LogEntry[]) ?? [];
        void autoscroll();
      }
    });

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      match = matchTab(tab?.url, settings.animepaheDomain);
      if (!match.ok || tab?.id == null) {
        error = 'Open an animepahe anime page (…/anime/…) then reopen this popup.';
        return;
      }
      tabId = tab.id;
      // Use the domain of the tab the user is actually on (e.g. animepahe.pw). All animepahe
      // fetches run first-party inside this tab so the SameSite=Lax cf_clearance cookie is sent.
      domain = match.host;
      const session = match.animeSession;
      fetchText = tabFetcher(tabId);
      if (domain !== settings.animepaheDomain) {
        settings = { ...settings, animepaheDomain: domain };
        await send({ type: 'saveSettings', settings });
      }
      title = await getAnimeTitle(fetchText, domain, session);
      episodes = await getEpisodeList(fetchText, domain, session, title);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  });

  function toggle(ep: Episode) {
    selected.has(ep.episodeSession) ? selected.delete(ep.episodeSession) : selected.add(ep.episodeSession);
    selected = selected;
  }

  function selectAll() {
    selected = new Set(episodes.map((e) => e.episodeSession));
  }
  function selectNone() {
    selected = new Set();
  }

  function applyRange() {
    const wanted = new Set<number>();
    for (const part of rangeText.split(',')) {
      const t = part.trim();
      const range = t.match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) {
        for (let i = +range[1]; i <= +range[2]; i++) wanted.add(i);
      } else if (/^\d+$/.test(t)) {
        wanted.add(+t);
      }
    }
    selected = new Set(
      episodes.filter((e) => wanted.has(Math.floor(Number(e.episodeNumber)))).map((e) => e.episodeSession),
    );
  }

  async function download() {
    const chosen = episodes.filter((e) => selected.has(e.episodeSession));
    if (chosen.length === 0) return;
    resolving = true;
    error = '';
    const picks: Pick[] = [];
    const missed: string[] = [];
    // Resolve each episode's kwik link first-party here; the SW can't fetch animepahe.
    // One failure doesn't abort the batch — collect and report.
    for (const ep of chosen) {
      try {
        const sources = await fetchPlayPage(fetchText, domain, ep.animeSession, ep.episodeSession);
        const src = pickSource(sources, quality, audio);
        if (src) picks.push({ episode: ep, quality: src.quality, audio: src.audio, kwikUrl: src.kwikUrl });
        else missed.push(ep.episodeNumber);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        plog(`resolve failed ep ${ep.episodeNumber}`, reason);
        missed.push(`${ep.episodeNumber} (${reason})`);
      }
      await new Promise((r) => setTimeout(r, 400)); // be gentle on animepahe (rate-limits bursts)
    }
    if (picks.length) await send({ type: 'enqueue', picks });
    error = missed.length ? `Could not resolve: ${missed.join(', ')}` : '';
    selectNone();
    resolving = false;
  }

  async function saveSettings() {
    await send({ type: 'saveSettings', settings });
    showSettings = false;
  }

  const pct = (j: Job) => (j.segTotal ? Math.round((j.segDone / j.segTotal) * 100) : j.stage === 'done' ? 100 : 0);

  const ACTIVE: Job['stage'][] = ['extracting', 'downloading', 'muxing', 'saving'];
  const isActive = (j: Job) => ACTIVE.includes(j.stage);

  // Cancel is destructive (an in-flight episode loses every segment fetched so far), so it is
  // two-step. window.confirm() is avoided on purpose: a modal dismisses the extension popup,
  // which would tear down this page mid-decision.
  let armed = '';
  let armTimer: ReturnType<typeof setTimeout> | undefined;

  function arm(key: string) {
    armed = key;
    clearTimeout(armTimer);
    armTimer = setTimeout(() => (armed = ''), 3000);
  }

  async function cancelAll() {
    if (armed !== 'all' && state.jobs.some((j) => j.stage !== 'done')) return arm('all');
    armed = '';
    await send({ type: 'cancelAll' });
  }

  async function cancelJob(job: Job) {
    if (armed !== job.id && isActive(job)) return arm(job.id);
    armed = '';
    await send({ type: 'cancelJob', jobId: job.id });
  }
  const buildInfo = `v${__APP_VERSION__} · built ${__BUILD_TIME__}`;

  // Scroll the terminal to the bottom, but only if the user was already at the bottom.
  async function autoscroll() {
    if (!logBox) return;
    const atBottom = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 24;
    await tick();
    if (atBottom && logBox) logBox.scrollTop = logBox.scrollHeight;
  }

  async function toggleLogs() {
    logsOpen = !logsOpen;
    if (logsOpen) {
      await tick();
      if (logBox) logBox.scrollTop = logBox.scrollHeight;
    }
  }

  async function copyLog() {
    await navigator.clipboard.writeText(logsToText(logs));
    copied = true;
    setTimeout(() => (copied = false), 1000);
  }

  async function clearLog() {
    await clearLogs();
    logs = [];
  }

  const shortTime = (iso: string) => iso.slice(11, 19); // HH:MM:SS
  const isError = (m: string) => /error/i.test(m);
</script>

<div class="row" style="justify-content:space-between;align-items:baseline">
  <h1>Animepahe Batch Downloader</h1>
  <span class="muted" style="font-size:10px" title="build version + timestamp">{buildInfo}</span>
</div>

<!-- Tab match verdict: same matchTab() the toolbar badge uses, so the two agree. -->
{#if match?.ok}
  <div class="status ok" title="This tab is a downloadable animepahe anime page">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12" /></svg>
    <span>{match.host} · /anime/{match.animeSession}</span>
  </div>
{:else if match}
  <div class="status bad" title={match.host || 'no page'}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18M6 6l12 12" /></svg>
    <span>{match.reason}</span>
  </div>
{/if}

{#if showSettings}
  <div>
    <label class="row">Domain <input type="text" bind:value={settings.animepaheDomain} /></label>
    <label class="row" style="margin-top:6px">Filename
      <input type="text" bind:value={settings.filenameTemplate} style="flex:1" /></label>
    <p class="muted">Tokens: {'{title} {episode} {quality} {audio}'} — relative to Downloads/.</p>
    <label class="row" style="margin-top:6px">
      <input type="checkbox" bind:checked={settings.autoClearDone} />
      Clear completed episodes when the batch finishes
    </label>
    <div class="row">
      <button on:click={saveSettings}>Save</button>
      <button class="ghost" on:click={() => (showSettings = false)}>Cancel</button>
    </div>
  </div>
  <hr />
{/if}

{#if loading}
  <p class="muted">Loading episodes…</p>
{:else if error}
  <p class="failed">{error}</p>
{:else}
  <p class="muted">{title} — {episodes.length} episodes</p>

  <div class="controls">
    <button class="ghost" on:click={selectAll}>All</button>
    <button class="ghost" on:click={selectNone}>None</button>
    <input type="text" placeholder="range e.g. 1-12,15" bind:value={rangeText} style="width:120px" />
    <button class="ghost" on:click={applyRange}>Apply</button>
  </div>

  <div class="eplist">
    {#each episodes as ep (ep.episodeSession)}
      <label class="ep">
        <input type="checkbox" checked={selected.has(ep.episodeSession)} on:change={() => toggle(ep)} />
        Episode {ep.episodeNumber}
      </label>
    {/each}
  </div>

  <div class="controls">
    <select bind:value={quality}>
      <option value="1080">1080p</option>
      <option value="720">720p</option>
      <option value="480">480p</option>
      <option value="360">360p</option>
    </select>
    <select bind:value={audio}>
      <option value="jpn">JPN</option>
      <option value="eng">ENG</option>
    </select>
    <button on:click={download} disabled={selected.size === 0 || resolving}>
      {resolving ? 'Resolving…' : `Download ${selected.size}`}
    </button>
    <button class="ghost" on:click={() => (showSettings = true)}>⚙</button>
  </div>
{/if}

{#if state.jobs.length === 0 && state.lastDone}
  <hr />
  <div class="status ok receipt">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12" /></svg>
    <span>Saved {state.lastDone.count} episode{state.lastDone.count === 1 ? '' : 's'} · {shortTime(state.lastDone.at)}</span>
    <button class="icon" title="Dismiss" on:click={() => send({ type: 'dismissReceipt' })}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18M6 6l12 12" /></svg>
    </button>
  </div>
{/if}

{#if state.jobs.length}
  <hr />
  <div class="row" style="justify-content:space-between">
    <strong>
      Queue
      {#if state.paused}<span class="pausedchip">paused</span>{:else if state.running}<span class="muted">(running)</span>{/if}
    </strong>
    <div class="row" style="gap:4px">
      {#if state.paused}
        <button class="ghost" on:click={() => send({ type: 'resume' })}>▶ Resume</button>
      {:else}
        <button class="ghost" on:click={() => send({ type: 'pause' })} disabled={!state.running}>⏸ Pause</button>
      {/if}
      <button class="ghost" on:click={() => send({ type: 'clearFinished' })}>Clear done</button>
      <button class="ghost danger" on:click={cancelAll}>{armed === 'all' ? 'Sure?' : 'Cancel all'}</button>
    </div>
  </div>
  {#each state.jobs as job (job.id)}
    <div class="job">
      <div class="row" style="justify-content:space-between">
        <span>{job.episode.title} — Ep {job.episode.episodeNumber} [{job.quality}p]</span>
        <div class="row" style="gap:4px">
          {#if job.stage === 'failed'}
            <button class="ghost" on:click={() => send({ type: 'retry', jobId: job.id })}>Retry</button>
          {/if}
          {#if job.stage !== 'done'}
            <button class="ghost danger" title="Cancel this episode" on:click={() => cancelJob(job)}>
              {armed === job.id ? 'Sure?' : '✕'}
            </button>
          {/if}
        </div>
      </div>
      <div class="stage {job.stage === 'failed' ? 'failed' : ''}">
        {job.stage}{job.stage === 'downloading' && job.segTotal ? ` ${job.segDone}/${job.segTotal}` : ''}{state.paused && isActive(job) ? ' — paused' : ''}{job.error ? ` — ${job.error}` : ''}
      </div>
      <div class="bar"><i class={state.paused && isActive(job) ? 'paused' : ''} style="width:{pct(job)}%"></i></div>
    </div>
  {/each}
{/if}

<hr />
<button class="ghost logtoggle" on:click={toggleLogs}>
  {logsOpen ? '▾' : '▸'} Logs {logs.length ? `(${logs.length})` : ''}
</button>

{#if logsOpen}
  <div class="term">
    <div class="term-bar">
      <span class="muted" style="font-size:10px">diagnostic log</span>
      <div class="row" style="gap:4px">
        <button class="icon" title={copied ? 'Copied' : 'Copy'} on:click={copyLog}>
          {#if copied}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12" /></svg>
          {:else}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
          {/if}
        </button>
        <button class="icon" title="Clear" on:click={clearLog}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
        </button>
      </div>
    </div>
    <div class="term-body" bind:this={logBox}>
      {#if logs.length === 0}
        <div class="term-empty">— no logs —</div>
      {:else}
        {#each logs as e}
          <div class="logline {isError(e.msg) ? 'err' : ''}">
            <span class="dim">{shortTime(e.t)}</span>
            <span class="dim">{e.ctx}</span>
            <span>{e.msg}</span>
          </div>
        {/each}
      {/if}
    </div>
  </div>
{/if}
