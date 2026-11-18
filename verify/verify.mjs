// Verify pipeline for photoHistory — "done" means this is green.
//   node verify/verify.mjs           → typecheck + unit tests (fast gate)
//   node verify/verify.mjs --rust    → + cargo test --release (src-tauri)
//   node verify/verify.mjs --build   → + next build (static export)
//   node verify/verify.mjs --all     → everything
// Flags compose: --rust --build is equivalent to --all.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const wantRust = args.has('--rust') || args.has('--all');
const wantBuild = args.has('--build') || args.has('--all');

const results = [];
const logPath = resolve(root, 'verify', 'last-run.log');
if (!existsSync(resolve(root, 'verify'))) mkdirSync(resolve(root, 'verify'));

function run(name, cmd, opts = {}) {
  const t0 = Date.now();
  const res = spawnSync(cmd, {
    cwd: root,
    shell: process.platform === 'win32',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  const ms = Date.now() - t0;
  const ok = res.status === 0;
  results.push({ name, ok, ms });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${(ms / 1000).toFixed(1)}s)`);
  if (!ok) {
    const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    console.log(out.split('\n').slice(-40).join('\n'));
  }
  return ok;
}

const all = [];

all.push(run('typecheck (tsc --noEmit)', 'npx tsc --noEmit'));
all.push(
  run('dateHints unit tests', 'node --experimental-strip-types scripts/test-dateHints.mjs'),
);

if (wantRust) {
  all.push(run('cargo test --release (src-tauri)', 'cargo test --release', { cwd: resolve(root, 'src-tauri') }));
}
if (wantBuild) {
  all.push(run('next build (static export)', 'npx next build'));
}

const failed = results.filter((r) => !r.ok);
const line = `[${new Date().toISOString()}] ${failed.length === 0 ? 'GREEN' : 'RED'} :: ${results
  .map((r) => `${r.name}:${r.ok ? 'ok' : 'FAIL'}(${(r.ms / 1000).toFixed(1)}s)`)
  .join(' | ')}\n`;
appendFileSync(logPath, line);

if (failed.length > 0) {
  console.error(`\nVERIFY RED — ${failed.length} of ${results.length} steps failed`);
  process.exit(1);
}
console.log(`\nVERIFY GREEN — ${results.length} steps passed`);
