#!/usr/bin/env node
// scripts/rewrite-baseline-header.mjs
//
// Takes a raw `pg_dump --schema-only` output (path passed on the command
// line) and writes apps/backend/src/migrations/000_baseline.sql with the
// header normalised so ci-setup-db.mjs's `pg.Client.query()` can apply it
// against an empty Postgres:
//
//   - Strip `\restrict` and `\unrestrict` psql meta-commands.
//   - Strip `SELECT pg_catalog.set_config('search_path', '', false);` so
//     unqualified table references in 001+ migrations resolve against
//     the public schema.
//   - Strip `SET transaction_timeout = 0;` (PG17-only — CI runs PG16).
//   - Rewrite `CREATE SCHEMA public;` → `CREATE SCHEMA IF NOT EXISTS public;`
//     so the file is idempotent against any DB that already has public.
//   - Prepend a comment block documenting the regeneration recipe so the
//     next person who runs pg_dump knows how to reapply the rewrite.
//
// Run after `pg_dump` lands the raw dump:
//   wsl docker exec vh-pg-baseline pg_dump -U vhhealth -d vhhealth \
//     --schema-only --no-owner --no-privileges --no-comments \
//     --schema=public > /tmp/raw.sql
//   node apps/backend/scripts/rewrite-baseline-header.mjs /tmp/raw.sql

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(__dirname, '..');
const out = resolve(backendRoot, 'src', 'migrations', '000_baseline.sql');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('usage: rewrite-baseline-header.mjs <raw-pg_dump.sql>');
  process.exit(1);
}

const raw = readFileSync(inputPath, 'utf8');

let body = raw
  .replace(/^\\restrict .*$/gm, '')
  .replace(/^\\unrestrict .*$/gm, '')
  .replace(/^SELECT pg_catalog\.set_config\('search_path', '', false\);\n?/gm, '')
  .replace(/^SET transaction_timeout = 0;\n?/gm, '')
  .replace(/^CREATE SCHEMA public;\n?/m, 'CREATE SCHEMA IF NOT EXISTS public;\n');

// Replace pg_dump's leading 8-line marker block with our own narrative
// header. The marker block is the comment+\restrict+comment trio at the
// top of every pg_dump.
const header = `--
-- 000_baseline.sql — DB schema baseline.
--
-- Generated via \`pg_dump --schema-only --no-owner --no-privileges --no-comments\`
-- against a fresh pgvector/pgvector:pg16 container after applying
-- baseline.sql + raw migrations 001+ (i.e. the exact CI Postgres image).
-- This is the canonical bootstrap for raw migrations in CI and
-- ensure-test-db.mjs. It replaces the previous \`prisma db push\` step:
-- prisma db push can no longer recreate the post-migration DB end-to-end
-- because raw migrations introduce GENERATED columns and other features
-- Prisma cannot emit declaratively. Raw migrations are now the source of
-- truth; schema.prisma is regenerated via \`prisma db pull\` and the drift
-- check confirms the two agree.
--
-- Regeneration recipe (any time you add a raw migration and want the
-- baseline to fast-path future fresh DBs):
--   1. Spin up the CI-matching Postgres in WSL/Docker:
--        wsl docker run -d --name vh-pg-baseline -e POSTGRES_USER=vhhealth \\
--          -e POSTGRES_PASSWORD=test -e POSTGRES_DB=vhhealth \\
--          -p 56432:5432 pgvector/pgvector:pg16
--   2. Apply baseline + migrations:
--        DATABASE_URL='postgresql://vhhealth:test@127.0.0.1:56432/vhhealth' \\
--          node scripts/ci-setup-db.mjs
--      (run from inside WSL — Windows localhost-to-WSL forwarding is flaky)
--   3. Dump + rewrite the header:
--        wsl docker exec vh-pg-baseline pg_dump -U vhhealth -d vhhealth \\
--          --schema-only --no-owner --no-privileges --no-comments \\
--          --schema=public > /tmp/raw.sql
--        node scripts/rewrite-baseline-header.mjs /tmp/raw.sql
--   4. Regenerate schema.prisma:
--        DATABASE_URL=... npx prisma db pull --schema=prisma/schema.prisma
--        node scripts/check-schema-drift.mjs
--
-- The CI Postgres image matters: migrations 015 (clinical_ai_corpus) and
-- 113 (knowledge_bases / knowledge_chunks / …) check for pgvector and
-- skip table creation when it's missing. Dumping from a non-pgvector
-- Postgres yields a baseline that drifts from CI — caught by the drift
-- check on the next PR.

`;

// Drop the original pg_dump preamble down to the first SET statement,
// then prepend our narrative header.
const setIdx = body.indexOf('SET statement_timeout');
if (setIdx < 0) {
  console.error('FATAL: could not find SET statement_timeout in input');
  process.exit(1);
}
body = header + body.slice(setIdx);

// Collapse runs of blank lines created by the strips.
body = body.replace(/\n{3,}/g, '\n\n');

writeFileSync(out, body);
console.log(`Wrote ${out} (${body.split('\n').length} lines).`);
