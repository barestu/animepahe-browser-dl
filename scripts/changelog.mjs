// CHANGELOG helper. Two modes, no dependencies.
//
//   node scripts/changelog.mjs draft
//     Drafts a Keep-a-Changelog section from the Conventional Commits since the last tag.
//     Prints to stdout — review it, then paste it under ## [Unreleased] in CHANGELOG.md.
//
//   node scripts/changelog.mjs extract <version>
//     Prints the body of the "## [<version>] - …" section of CHANGELOG.md. Exits non-zero
//     if that section does not exist, which is what stops the release workflow from
//     publishing a tag with empty notes.
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [mode, arg] = process.argv.slice(2);

const die = (msg) => {
  console.error(`changelog: ${msg}`);
  process.exit(1);
};

// stderr is piped, not inherited: `describe` on a repo with no tags is an expected
// miss, and its "fatal:" line would otherwise look like a failure.
const git = (...args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

// Conventional Commit type -> Keep a Changelog heading. Types absent from this map
// (docs, chore, test, style, build, ci) are housekeeping and stay out of release notes.
const SECTIONS = [
  ['Added', ['feat']],
  ['Fixed', ['fix']],
  ['Changed', ['perf', 'refactor', 'revert']],
];

function draft() {
  let range;
  try {
    const lastTag = git('describe', '--tags', '--abbrev=0');
    range = `${lastTag}..HEAD`;
    console.error(`# commits since ${lastTag}`);
  } catch {
    range = 'HEAD'; // no tags yet — take the whole history
    console.error('# no previous tag; using full history');
  }

  const lines = git('log', range, '--no-merges', '--pretty=%s%x00%h').split('\n').filter(Boolean);
  if (!lines.length) die(`no commits in ${range}.`);

  /** @type {Map<string, string[]>} */
  const buckets = new Map();
  let skipped = 0;

  for (const line of lines) {
    const [subject, hash] = line.split('\0');
    // type(optional scope)!: description
    const m = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/.exec(subject);
    if (!m) {
      skipped++;
      continue;
    }
    const [, type, scope, breaking, desc] = m;
    const heading = breaking
      ? 'Changed'
      : SECTIONS.find(([, types]) => types.includes(type))?.[0];
    if (!heading) {
      skipped++;
      continue;
    }
    const text = `- ${breaking ? '**BREAKING** ' : ''}${scope ? `**${scope}**: ` : ''}${desc} (${hash})`;
    if (!buckets.has(heading)) buckets.set(heading, []);
    buckets.get(heading).push(text);
  }

  const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const today = new Date().toISOString().slice(0, 10);

  const out = [`## [${version}] - ${today}`, ''];
  for (const [heading] of SECTIONS) {
    const items = buckets.get(heading);
    if (!items?.length) continue;
    out.push(`### ${heading}`, '', ...items, '');
  }
  if (out.length === 2) die(`no user-facing commits in ${range}.`);

  process.stdout.write(out.join('\n') + '\n');
  if (skipped) console.error(`# ${skipped} housekeeping commit(s) omitted`);
}

async function extract(version) {
  if (!version) die('extract needs a version, e.g. `extract 1.0.0`.');
  const v = version.replace(/^v/, '');
  const md = await readFile(resolve(root, 'CHANGELOG.md'), 'utf8');

  const lines = md.split('\n');
  // Match "## [1.0.0] - 2026-10-21" and the bare "## 1.0.0" form.
  const startsSection = (l) => /^##\s+(?!#)/.test(l);
  const isTarget = (l) =>
    new RegExp(`^##\\s+\\[?v?${v.replace(/\./g, '\\.')}\\]?(\\s|$)`).test(l);

  const start = lines.findIndex(isTarget);
  if (start === -1) {
    die(
      `CHANGELOG.md has no section for ${v}. Add one (\`pnpm release:notes\` drafts it) ` +
        'before tagging.',
    );
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (startsSection(lines[i])) {
      end = i;
      break;
    }
  }

  const body = lines
    .slice(start + 1, end)
    // Drop link-reference definitions ([1.0.0]: https://…) — they belong to the file, not the notes.
    .filter((l) => !/^\[[^\]]+\]:\s+http/.test(l))
    .join('\n')
    .trim();
  if (!body) die(`the ${v} section of CHANGELOG.md is empty.`);

  process.stdout.write(body + '\n');
}

switch (mode) {
  case 'draft':
    draft();
    break;
  case 'extract':
    await extract(arg);
    break;
  default:
    die('usage: changelog.mjs draft | extract <version>');
}
