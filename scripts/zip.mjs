// Pack dist/ into release/animepahe-browser-dl-v<version>.zip for a GitHub Release.
//
// dist/ contents go at the ZIP ROOT (not nested under a dist/ folder) so that unzipping
// yields a directory Chrome accepts directly via Load unpacked.
//
// The archive is written by hand rather than by shelling out to `zip`, which is not
// installed on every dev box (notably plain WSL2 images), and rather than adding an
// archiver dependency for one script. Only zlib + the ZIP spec are needed. Entries are
// stamped with a fixed timestamp so the same dist/ always yields a byte-identical zip.
import { readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(root, 'dist');
const outDir = resolve(root, 'release');

const die = (msg) => {
  console.error(`zip: ${msg}`);
  process.exit(1);
};

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

// --- preflight -------------------------------------------------------------------------
let manifest;
try {
  manifest = JSON.parse(await readFile(resolve(distDir, 'manifest.json'), 'utf8'));
} catch {
  die('dist/manifest.json not found — run `pnpm build` first.');
}
if (manifest.version !== pkg.version) {
  die(
    `dist/manifest.json is version ${manifest.version} but package.json is ${pkg.version} — ` +
      'the build is stale. Run `pnpm build`.',
  );
}

// --- collect ---------------------------------------------------------------------------
/** @returns {Promise<string[]>} absolute paths of every file under dir, sorted. */
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else if (entry.isFile()) out.push(p);
  }
  return out.sort();
}

const files = await walk(distDir);
if (!files.length) die('dist/ is empty.');

// --- zip primitives --------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

// Fixed MS-DOS timestamp (1980-01-01 00:00) — keeps the archive reproducible.
const DOS_TIME = 0;
const DOS_DATE = 33;

const DEFLATED = 8;
const STORED = 0;

const local = [];
const central = [];
let offset = 0;

for (const abs of files) {
  const name = relative(distDir, abs).split(sep).join('/');
  const nameBuf = Buffer.from(name, 'utf8');
  const raw = await readFile(abs);
  const crc = crc32(raw);

  // Deflate unless it makes the entry bigger (already-compressed assets like PNG/WASM).
  const deflated = deflateRawSync(raw, { level: 9 });
  const useDeflate = deflated.length < raw.length;
  const body = useDeflate ? deflated : raw;
  const method = useDeflate ? DEFLATED : STORED;

  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0); // local file header signature
  lfh.writeUInt16LE(20, 4); // version needed
  lfh.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
  lfh.writeUInt16LE(method, 8);
  lfh.writeUInt16LE(DOS_TIME, 10);
  lfh.writeUInt16LE(DOS_DATE, 12);
  lfh.writeUInt32LE(crc, 14);
  lfh.writeUInt32LE(body.length, 18);
  lfh.writeUInt32LE(raw.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  lfh.writeUInt16LE(0, 28); // extra field length
  local.push(lfh, nameBuf, body);

  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0); // central directory header signature
  cdh.writeUInt16LE(20, 4); // version made by
  cdh.writeUInt16LE(20, 6); // version needed
  cdh.writeUInt16LE(0x0800, 8);
  cdh.writeUInt16LE(method, 10);
  cdh.writeUInt16LE(DOS_TIME, 12);
  cdh.writeUInt16LE(DOS_DATE, 14);
  cdh.writeUInt32LE(crc, 16);
  cdh.writeUInt32LE(body.length, 20);
  cdh.writeUInt32LE(raw.length, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt16LE(0, 30); // extra
  cdh.writeUInt16LE(0, 32); // comment
  cdh.writeUInt16LE(0, 34); // disk number
  cdh.writeUInt16LE(0, 36); // internal attrs
  cdh.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: regular file, 0644 (>>>0: the shift overflows int32)
  cdh.writeUInt32LE(offset, 42);
  central.push(cdh, nameBuf);

  offset += lfh.length + nameBuf.length + body.length;
}

const centralBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
eocd.writeUInt16LE(0, 4); // disk number
eocd.writeUInt16LE(0, 6); // disk with central dir
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20); // comment length

const zip = Buffer.concat([...local, centralBuf, eocd]);

// --- write -----------------------------------------------------------------------------
await mkdir(outDir, { recursive: true });
const outPath = resolve(outDir, `${pkg.name}-v${pkg.version}.zip`);
await writeFile(outPath, zip);

const { size } = await stat(outPath);
console.log(
  `${relative(root, outPath)} — ${files.length} files, ${(size / 1024 / 1024).toFixed(2)} MB`,
);
