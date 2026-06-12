#!/usr/bin/env node
// scripts/check-schema-drift.mjs
//
// Compares the committed `prisma/schema.prisma` against a fresh
// `prisma db pull` of the current DATABASE_URL. Fails with exit 1 if
// they diverge — ensuring that when someone adds/changes a migration
// they also update schema.prisma, so Prisma's type system stays a
// safety net for raw queries and drift bugs like the batch-18/22
// `ordered_date` / `payslips.staff_uid` class are caught at review
// time instead of in production 500s.
//
// Usage:
//   node scripts/check-schema-drift.mjs
//   (CI: runs after ensure-test-db.mjs has applied all migrations)
//
// Exit codes:
//   0 — schemas match
//   1 — drift detected (diff printed to stderr)
//   2 — infrastructure error (missing DATABASE_URL, prisma binary, etc.)

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(__dirname, '..');
const committedSchemaPath = join(backendRoot, 'prisma', 'schema.prisma');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set — cannot check schema drift');
  process.exit(2);
}

// `prisma db pull` writes to the target path atomically, so use a temp
// copy so the committed file is never touched by this check.
const workDir = mkdtempSync(join(tmpdir(), 'prisma-drift-'));
const tmpSchemaPath = join(workDir, 'schema.prisma');

try {
  // Seed the temp schema with the committed file's full contents. `prisma db
  // pull` is only deterministic when seeded with the existing schema — it
  // reuses @@map annotations, relation back-reference names, and model
  // ordering. A re-pull against an up-to-date seed is effectively a no-op
  // and produces byte-identical output; a mismatch means true drift.
  const committedSource = readFileSync(committedSchemaPath, 'utf8');
  writeFileSync(tmpSchemaPath, committedSource);

  // Run `prisma db pull` against the temp file.
  const prismaBin = join(backendRoot, 'node_modules', 'prisma', 'build', 'index.js');
  const pullResult = spawnSync(
    process.execPath,
    [prismaBin, 'db', 'pull', `--schema=${tmpSchemaPath}`, '--url', process.env.DATABASE_URL],
    { cwd: backendRoot, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
  );
  if (pullResult.status !== 0) {
    console.error('prisma db pull failed:');
    console.error(pullResult.stderr || pullResult.stdout);
    process.exit(2);
  }

  const committedNormalised = normalise(committedSource);
  const pulledNormalised = normalise(readFileSync(tmpSchemaPath, 'utf8'));

  if (committedNormalised === pulledNormalised) {
    console.log('✓ schema.prisma matches DB — no drift');
    process.exit(0);
  }

  console.error('✗ schema.prisma drift detected');
  console.error('');
  console.error('The committed prisma/schema.prisma is out of sync with the');
  console.error('DATABASE_URL you are checking against. Resolve with either:');
  console.error('');
  console.error('  (1) Your migration adds/changes the DB — update the schema:');
  console.error('      npm --prefix apps/backend exec -- prisma db pull');
  console.error('      git add apps/backend/prisma/schema.prisma');
  console.error('');
  console.error('  (2) The committed schema is correct and the DB is ahead —');
  console.error('      drop the extra tables/columns or add a down-migration.');
  console.error('');
  console.error('Diff (committed → pulled):');
  const diffResult = spawnSync(
    'diff',
    ['-u', committedSchemaPath, tmpSchemaPath],
    { cwd: backendRoot, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
  );
  // Truncate overly long diffs so CI logs stay readable.
  const diffOut = (diffResult.stdout || '').split('\n');
  const preview = diffOut.slice(0, 200).join('\n');
  console.error(preview);
  if (diffOut.length > 200) {
    console.error(`... (${diffOut.length - 200} more lines)`);
  }
  process.exit(1);
} finally {
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* cleanup */ }
}

/**
 * Normalise schema.prisma content so comparison isn't spooked by
 * harmless variations:
 *   - Trim trailing whitespace per line
 *   - Drop blank lines at the very start/end
 *   - Leave in-file ordering alone (prisma db pull is stable between runs)
 */
function normalise(source) {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '') + '\n';
}
