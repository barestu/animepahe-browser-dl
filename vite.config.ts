import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';
import manifest from './src/manifest.config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
// "YYYY-MM-DD HH:mm" in local time, stamped at build.
const now = new Date();
const p = (n: number) => String(n).padStart(2, '0');
const buildTime = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  plugins: [svelte(), crx({ manifest })],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      // The offscreen document isn't referenced by the manifest (loaded at runtime via
      // chrome.offscreen.createDocument), so crxjs won't discover it — add it explicitly.
      input: { offscreen: 'src/offscreen/index.html' },
      output: { chunkFileNames: 'assets/[name]-[hash].js' },
    },
  },
  // ffmpeg.wasm ships large assets; don't inline them.
  assetsInclude: ['**/*.wasm'],
  server: { port: 5173, strictPort: true },
});
