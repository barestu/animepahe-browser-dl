// Copy the single-thread ffmpeg core into public/ so it ships as a static extension asset
// (loaded at runtime via chrome.runtime.getURL — no bundler transforms, no remote code).
import { mkdir, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'node_modules/@ffmpeg/core/dist/esm');
const dest = resolve(root, 'public/ffmpeg');

await mkdir(dest, { recursive: true });
for (const f of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  await copyFile(resolve(src, f), resolve(dest, f));
  console.log(`copied ${f}`);
}
