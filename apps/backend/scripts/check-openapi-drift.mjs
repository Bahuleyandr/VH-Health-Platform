#!/usr/bin/env node
// apps/backend/scripts/check-openapi-drift.mjs
//
// Regenerates the live-router OpenAPI spec into a temp file and compares it
// against the committed src/docs/openapi.json. Fails (exit 1) on drift so a
// route added/changed without regenerating the spec is caught at review time.
//
// Exit codes (mirror check-schema-drift.mjs):
//   0 — spec matches live routes
//   1 — drift detected (diff printed)
//   2 — infrastructure error (generator failed)
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(__dirname, '..');
const committedSpecPath = join(backendRoot, 'src', 'docs', 'openapi.json');

const workDir = mkdtempSync(join(tmpdir(), 'openapi-drift-'));
const tmpSpecPath = join(workDir, 'openapi.json');

function canonicalise(source) {
  return `${JSON.stringify(JSON.parse(source), null, 2)}\n`;
}

try {
  const gen = spawnSync(
    process.execPath,
    [join(backendRoot, 'scripts', 'generate-openapi.mjs'), `--out=${tmpSpecPath}`],
    { cwd: backendRoot, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
  );
  if (gen.status !== 0) {
    console.error('generate-openapi.mjs failed:');
    console.error(gen.stderr || gen.stdout);
    process.exit(2);
  }

  const committed = canonicalise(readFileSync(committedSpecPath, 'utf8'));
  const generated = canonicalise(readFileSync(tmpSpecPath, 'utf8'));

  if (committed === generated) {
    console.log('✓ openapi.json matches live routes — no drift');
    process.exit(0);
  }

  console.error('✗ openapi.json drift detected');
  console.error('');
  console.error('The committed src/docs/openapi.json is out of sync with the live');
  console.error('Express routes. Regenerate and commit it:');
  console.error('');
  console.error('  npm --prefix apps/backend run openapi:generate');
  console.error('  git add apps/backend/src/docs/openapi.json');
  console.error('');
  const diff = spawnSync('diff', ['-u', committedSpecPath, tmpSpecPath], {
    cwd: backendRoot, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
  });
  const lines = (diff.stdout || '').split('\n');
  console.error(lines.slice(0, 200).join('\n'));
  if (lines.length > 200) console.error(`... (${lines.length - 200} more diff lines)`);
  process.exit(1);
} finally {
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* cleanup */ }
}
