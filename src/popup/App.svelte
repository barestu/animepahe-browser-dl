<script lang="ts">
  import { onMount } from 'svelte';
  import { getAnimeTitle, getEpisodeList, fetchPlayPage, pickSource } from '@/lib/animepahe';
  import { tabFetcher, type Fetcher } from '@/lib/tab-fetch';
  import type { AppState, Audio, Episode, Job, Pick, Quality, Settings } from '@/lib/types';
  import { DEFAULT_SETTINGS } from '@/lib/types';

  let loading = true;
  let error = '';
  let title = '';
  let episodes: Episode[] = [];
  let selected = new Set<string>(); // episodeSession
  let rangeText = '';
  let quality: Quality = '1080';
  let audio: Audio = 'jpn';
  let state: AppState = { jobs: [], running: false };
  let settings: Settings = DEFAULT_SETTINGS;
  let showSettings = false;
  let tabId = -1;
  let domain = '';
  let fetchText: Fetcher = async () => '';
  let resolving = false;

  const send = (msg: unknown) => chrome.runtime.sendMessage(msg);

  function parseAnimeSession(url: string | undefined): string | null {
    const m = url?.match(/\/anime\/([A-Za-z0-9-]+)/);
    return m?.[1] ?? null;
  }

  onMount(async () => {
    settings = (await send({ type: 'getSettings' })) as Settings;
    quality = settings.quality;
    audio = settings.audio;
    state = (await send({ type: 'getState' })) as AppState;

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'stateUpdate') state = msg.state as AppState;
    });

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const session = parseAnimeSession(tab?.url);
      if (!session || tab?.id == null) {
        error = 'Open an animepahe anime page (…/anime/…) then reopen this popup.';
        return;
      }
      tabId = tab.id;
      // Use the domain of the tab the user is actually on (e.g. animepahe.pw). All animepahe
      // fetches run first-party inside this tab so the SameSite=Lax cf_clearance cookie is sent.
      domain = new URL(tab.url!).hostname;
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
    try {
      // Resolve each episode's kwik link first-party here; the SW can't fetch animepahe.
      for (const ep of chosen) {
        const sources = await fetchPlayPage(fetchText, domain, ep.animeSession, ep.episodeSession);
        const src = pickSource(sources, quality, audio);
        if (src) picks.push({ episode: ep, quality: src.quality, audio: src.audio, kwikUrl: src.kwikUrl });
        else missed.push(ep.episodeNumber);
      }
      if (picks.length) await send({ type: 'enqueue', picks });
      if (missed.length) error = `No source found for episode(s): ${missed.join(', ')}`;
      selectNone();
    } catch (e) {
      error = `Resolve failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      resolving = false;
    }
  }

  async function saveSettings() {
    await send({ type: 'saveSettings', settings });
    showSettings = false;
  }

  const pct = (j: Job) => (j.segTotal ? Math.round((j.segDone / j.segTotal) * 100) : j.stage === 'done' ? 100 : 0);
  const buildInfo = `v${__APP_VERSION__} · built ${__BUILD_TIME__}`;
</script>

<div class="row" style="justify-content:space-between;align-items:baseline">
  <h1>Animepahe Batch Downloader</h1>
  <span class="muted" style="font-size:10px" title="build version + timestamp">{buildInfo}</span>
</div>

{#if showSettings}
  <div>
    <label class="row">Domain <input type="text" bind:value={settings.animepaheDomain} /></label>
    <label class="row" style="margin-top:6px">Filename
      <input type="text" bind:value={settings.filenameTemplate} style="flex:1" /></label>
    <p class="muted">Tokens: {'{title} {episode} {quality} {audio}'} — relative to Downloads/.</p>
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

{#if state.jobs.length}
  <hr />
  <div class="row" style="justify-content:space-between">
    <strong>Queue {state.running ? '(running)' : ''}</strong>
    <button class="ghost" on:click={() => send({ type: 'cancelAll' })}>Clear</button>
  </div>
  {#each state.jobs as job (job.id)}
    <div class="job">
      <div class="row" style="justify-content:space-between">
        <span>{job.episode.title} — Ep {job.episode.episodeNumber} [{job.quality}p]</span>
        {#if job.stage === 'failed'}
          <button class="ghost" on:click={() => send({ type: 'retry', jobId: job.id })}>Retry</button>
        {/if}
      </div>
      <div class="stage {job.stage === 'failed' ? 'failed' : ''}">
        {job.stage}{job.stage === 'downloading' && job.segTotal ? ` ${job.segDone}/${job.segTotal}` : ''}{job.error ? ` — ${job.error}` : ''}
      </div>
      <div class="bar"><i style="width:{pct(job)}%"></i></div>
    </div>
  {/each}
{/if}
