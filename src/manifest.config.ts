import { defineManifest } from '@crxjs/vite-plugin';

// NOTE: <all_urls> + webRequest = broad surface. Personal/unpacked use only.
// See SPEC.md "Security". Content script is scoped to kwik hosts ONLY.
export default defineManifest({
  manifest_version: 3,
  name: 'Animepahe Batch Downloader',
  version: '0.1.0',
  description: 'Batch-download episodes from an open animepahe anime page.',
  minimum_chrome_version: '116',
  action: {
    default_title: 'Animepahe Batch Downloader',
    default_popup: 'src/popup/index.html',
  },
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  permissions: [
    'downloads',
    'offscreen',
    'storage',
    'tabs',
    'scripting',
    'webRequest',
    'declarativeNetRequestWithHostAccess',
  ],
  host_permissions: ['<all_urls>'],
  content_scripts: [
    {
      // kwik player only — force play() so the HLS manifest loads. See SPEC Q5.
      matches: ['*://*.kwik.si/*', '*://*.kwik.cx/*'],
      js: ['src/content/kwik.ts'],
      run_at: 'document_idle',
      all_frames: true,
    },
  ],
  // ffmpeg.wasm needs wasm-unsafe-eval; no remote code.
  content_security_policy: {
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
  web_accessible_resources: [
    {
      resources: ['assets/*'],
      matches: ['<all_urls>'],
    },
  ],
});
