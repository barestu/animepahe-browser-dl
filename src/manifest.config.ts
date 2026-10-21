import { defineManifest } from '@crxjs/vite-plugin';
import { readFileSync } from 'node:fs';

// package.json is the single source of truth for the version — the popup header renders
// __APP_VERSION__ from the same file (vite.config.ts), so the two can never disagree.
// This module is only ever evaluated by Vite in Node; it is never bundled into an
// extension context, so node:fs here is safe.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Generated from design/icon.svg by scripts/gen-icons.mjs into public/icons/,
// which Vite copies verbatim to the dist root — hence root-relative paths here.
const ICONS = {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png',
};

// NOTE: <all_urls> + webRequest = broad surface. Personal/unpacked use only.
// See SPEC.md "Security". Content script is scoped to kwik hosts ONLY.
export default defineManifest({
  manifest_version: 3,
  name: 'Animepahe Batch Downloader',
  version: pkg.version,
  description: 'Batch-download episodes from an open animepahe anime page.',
  minimum_chrome_version: '116',
  icons: ICONS,
  action: {
    default_title: 'Animepahe Batch Downloader',
    default_popup: 'src/popup/index.html',
    default_icon: ICONS,
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
      resources: ['assets/*', 'ffmpeg/*'],
      matches: ['<all_urls>'],
    },
  ],
});
