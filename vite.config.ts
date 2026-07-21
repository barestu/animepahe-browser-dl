import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath, URL } from 'node:url';
import manifest from './src/manifest.config';

export default defineConfig({
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
