#!/usr/bin/env node
// growth-lms-import.mjs - NL-5 P4 growth reference LMS importer.
//
// Usage:
//   node scripts/growth-lms-import.mjs --dataset WHO_0_5 --csv who-lms.csv --version 2026-01
//
// CSV columns: sex,metric,age_days,l,m,s[,source_version]
// Content files are operator-supplied unless redistribution is explicitly cleared.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parseCsvLine } from './terminology-import.mjs';

const VALID_DATASETS = new Set(['WHO_0_5', 'IAP_5_18', 'CDC_2_20', 'FENTON']);
const VALID_SEXES = new Set(['M', 'F']);
const VALID_METRICS = new Set(['height_cm', 'weight_kg', 'head_circumference_cm', 'bmi']);
const REQUIRED_COLUMNS = ['sex', 'metric', 'age_days', 'l', 'm', 's'];

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dataset') args.dataset = argv[++i];
    else if (a === '--csv') args.csv = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function emptyStats() {
  return { processed: 0, upserted: 0, skipped: 0, failed: 0 };
}

function normalizeRow(row, dataset, fallbackVersion) {
  const sex = String(row.sex || '').trim().toUpperCase();
  const metric = String(row.metric || '').trim();
  const ageDays = Number.parseInt(row.age_days, 10);
  const l = Number.parseFloat(row.l);
  const m = Number.parseFloat(row.m);
  const s = Number.parseFloat(row.s);
  if (!VALID_SEXES.has(sex)) return null;
  if (!VALID_METRICS.has(metric)) return null;
  if (!Number.isInteger(ageDays) || ageDays < 0) return null;
  if (![l, m, s].every(Number.isFinite) || m <= 0 || s <= 0) return null;
  return {
    dataset,
    sex,
    metric,
    age_days: ageDays,
    l,
    m,
    s,
    source_version: String(row.source_version || fallbackVersion || '').trim() || null,
  };
}

async function createBatch(client, args) {
  const res = await client.query(
    `INSERT INTO growth_lms_import_batches
       (dataset, source_ref, source_version, status, dry_run, started_at, metadata, updated_at)
     VALUES ($1, $2, $3, 'running', $4, NOW(), $5::jsonb, NOW())
     RETURNING id`,
    [
      args.dataset,
      args.csv,
      args.version || null,
      args.dryRun === true,
      JSON.stringify({ importer: 'growth-lms-import.mjs' }),
    ],
  );
  return res.rows[0].id;
}

async function finishBatch(client, batchId, status, stats, errorDetail = null) {
  await client.query(
    `UPDATE growth_lms_import_batches
        SET status = $2,
            rows_processed = $3,
            rows_upserted = $4,
            rows_skipped = $5,
            rows_failed = $6,
            error_detail = $7,
            finished_at = NOW(),
            updated_at = NOW()
      WHERE id = $1`,
    [batchId, status, stats.processed, stats.upserted, stats.skipped, stats.failed, errorDetail],
  );
}

async function upsertLmsRow(client, row, batchId) {
  await client.query(
    `INSERT INTO growth_reference_lms
       (dataset, sex, metric, age_days, l, m, s, source_version, import_batch_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (dataset, sex, metric, age_days) DO UPDATE SET
       l = EXCLUDED.l,
       m = EXCLUDED.m,
       s = EXCLUDED.s,
       source_version = EXCLUDED.source_version,
       import_batch_id = EXCLUDED.import_batch_id,
       updated_at = NOW()`,
    [
      row.dataset,
      row.sex,
      row.metric,
      row.age_days,
      row.l,
      row.m,
      row.s,
      row.source_version,
      batchId,
    ],
  );
}

export async function importGrowthLms({ client, dataset, csv, version = null, dryRun = false }) {
  const args = { dataset, csv, version, dryRun };
  const stats = emptyStats();
  const batchId = await createBatch(client, args);
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(csv), crlfDelay: Infinity });
    let header = null;
    for await (const line of rl) {
      if (!line.trim()) continue;
      const cols = parseCsvLine(line);
      if (!header) {
        header = cols.map((c) => c.trim().toLowerCase());
        const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
        if (missing.length) throw new Error(`CSV missing required columns: ${missing.join(', ')}`);
        continue;
      }
      const raw = Object.fromEntries(header.map((h, i) => [h, (cols[i] ?? '').trim()]));
      const row = normalizeRow(raw, dataset, version);
      stats.processed += 1;
      if (!row) {
        stats.skipped += 1;
        continue;
      }
      if (!dryRun) {
        await upsertLmsRow(client, row, batchId);
        stats.upserted += 1;
      }
    }
    const status = stats.failed > 0 ? 'partial' : 'completed';
    await finishBatch(client, batchId, status, stats);
    return { batchId, status, ...stats };
  } catch (err) {
    stats.failed += 1;
    await finishBatch(client, batchId, 'failed', stats, err.message || String(err));
    throw err;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!VALID_DATASETS.has(args.dataset)) {
    console.error(`--dataset must be one of: ${[...VALID_DATASETS].join(', ')}`);
    process.exit(2);
  }
  if (!args.csv || !fs.existsSync(args.csv)) {
    console.error('--csv <file> is required and must exist');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const startedAt = Date.now();
  try {
    const result = await importGrowthLms({ client, ...args });
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `${args.dryRun ? '[dry-run] ' : ''}${args.dataset}: parsed ${result.processed}` +
      `${args.dryRun ? '' : `, upserted ${result.upserted}`}` +
      `, skipped ${result.skipped} in ${secs}s (batch ${result.batchId})`,
    );
  } finally {
    await client.end();
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
