#!/usr/bin/env node
// immunisation-schedule-import.mjs - NL-5 P4 UIP/IAP schedule importer.
//
// Usage:
//   node scripts/immunisation-schedule-import.mjs --tenant <uuid> --schedule uip|iap|both --version 2026
//
// The importer is intentionally operator-run. Existing patient/newborn schedule
// rows are never updated; only vaccine_catalogue rows change for future seeds.

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const VALID_SCHEDULES = new Set(['uip', 'iap', 'both']);

export const UIP_SCHEDULE_ROWS = Object.freeze([
  ['uip', 'BCG', 'BCG', 1, 0, 365, 'Single dose at birth'],
  ['uip', 'HEPB', 'Hepatitis B birth dose', 0, 0, 1, 'Within 24 hours of birth'],
  ['uip', 'OPV', 'OPV zero dose', 0, 0, 15, 'Within 15 days of birth'],
  ['uip', 'PENTA', 'Pentavalent 1', 1, 42, 28, '6 weeks'],
  ['uip', 'OPV', 'OPV 1', 1, 42, 28, '6 weeks'],
  ['uip', 'FIPV', 'Fractional IPV 1', 1, 42, 28, '6 weeks'],
  ['uip', 'ROTA', 'Rotavirus 1', 1, 42, 28, '6 weeks'],
  ['uip', 'PCV', 'PCV 1', 1, 42, 28, '6 weeks'],
  ['uip', 'PENTA', 'Pentavalent 2', 2, 70, 28, '10 weeks'],
  ['uip', 'OPV', 'OPV 2', 2, 70, 28, '10 weeks'],
  ['uip', 'ROTA', 'Rotavirus 2', 2, 70, 28, '10 weeks'],
  ['uip', 'PENTA', 'Pentavalent 3', 3, 98, 28, '14 weeks'],
  ['uip', 'OPV', 'OPV 3', 3, 98, 28, '14 weeks'],
  ['uip', 'FIPV', 'Fractional IPV 2', 2, 98, 28, '14 weeks'],
  ['uip', 'ROTA', 'Rotavirus 3', 3, 98, 28, '14 weeks'],
  ['uip', 'PCV', 'PCV 2', 2, 98, 28, '14 weeks'],
  ['uip', 'MR', 'Measles-Rubella 1', 1, 274, 90, '9-12 months'],
  ['uip', 'JE', 'Japanese Encephalitis 1', 1, 274, 90, 'Endemic districts'],
  ['uip', 'PCV', 'PCV booster', 3, 274, 90, '9-12 months'],
  ['uip', 'VITA', 'Vitamin A 1', 1, 274, 90, '9 months'],
  ['uip', 'DPT', 'DPT booster 1', 4, 548, 180, '16-24 months'],
  ['uip', 'OPV', 'OPV booster', 4, 548, 180, '16-24 months'],
  ['uip', 'MR', 'Measles-Rubella 2', 2, 548, 180, '16-24 months'],
  ['uip', 'JE', 'Japanese Encephalitis 2', 2, 548, 180, 'Endemic districts'],
  ['uip', 'DPT', 'DPT booster 2', 5, 1826, 365, '5-6 years'],
  ['uip', 'TD', 'Td 10 years', 1, 3652, 365, '10 years'],
  ['uip', 'TD', 'Td 16 years', 2, 5844, 365, '16 years'],
].map(([schedule_source, code, display_name, dose_number, recommended_age_days, window_days, description]) => ({
  schedule_source, code, display_name, dose_number, recommended_age_days, window_days, description,
})));

const influenzaRows = Array.from({ length: 18 }, (_, i) => ({
  schedule_source: 'iap',
  code: 'INFLUENZA',
  display_name: `Influenza annual ${i + 1}`,
  dose_number: i + 1,
  recommended_age_days: 183 + i * 365,
  window_days: 90,
  description: 'Annual influenza vaccine from 6 months through adolescence',
}));

export const IAP_SCHEDULE_ROWS = Object.freeze([
  ['iap', 'MMR', 'MMR 1', 1, 274, 90, '9 months'],
  ['iap', 'MMR', 'MMR 2', 2, 456, 90, '15 months'],
  ['iap', 'MMR', 'MMR 3', 3, 1643, 365, '4-6 years'],
  ['iap', 'VAR', 'Varicella 1', 1, 456, 90, '15 months'],
  ['iap', 'VAR', 'Varicella 2', 2, 1643, 365, '4-6 years'],
  ['iap', 'HEPA', 'Hepatitis A 1', 1, 365, 90, '12 months'],
  ['iap', 'HEPA', 'Hepatitis A 2', 2, 548, 90, '18 months'],
  ['iap', 'TCV', 'Typhoid conjugate vaccine', 1, 274, 90, '9-12 months'],
  ['iap', 'TDAP', 'Tdap', 1, 3652, 365, '10 years'],
  ['iap', 'HPV', 'HPV 1', 1, 3287, 365, '9-14 years'],
  ['iap', 'HPV', 'HPV 2', 2, 3469, 365, '6 months after first HPV dose'],
  ...influenzaRows,
].map((row) => Array.isArray(row)
  ? {
    schedule_source: row[0],
    code: row[1],
    display_name: row[2],
    dose_number: row[3],
    recommended_age_days: row[4],
    window_days: row[5],
    description: row[6],
  }
  : row));

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tenant') args.tenantId = argv[++i];
    else if (a === '--schedule') args.schedule = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

export function buildScheduleRows(schedule) {
  if (schedule === 'uip') return [...UIP_SCHEDULE_ROWS];
  if (schedule === 'iap') return [...IAP_SCHEDULE_ROWS];
  return [...UIP_SCHEDULE_ROWS, ...IAP_SCHEDULE_ROWS];
}

function normalizeRow(row) {
  const dose = row.dose_number == null || row.dose_number === '' ? null : Number.parseInt(row.dose_number, 10);
  return {
    schedule_source: row.schedule_source,
    code: String(row.code || '').trim().toUpperCase(),
    display_name: String(row.display_name || '').trim(),
    dose_number: Number.isInteger(dose) ? dose : null,
    recommended_age_days: Number.parseInt(row.recommended_age_days, 10),
    window_days: Number.parseInt(row.window_days ?? 28, 10),
    description: String(row.description || '').trim() || null,
  };
}

function keyFor(row) {
  return `${row.code}::${row.dose_number == null ? 'NULL' : row.dose_number}`;
}

function sourcesFor(schedule) {
  return schedule === 'both' ? ['uip', 'iap'] : [schedule];
}

async function createBatch(client, { tenantId, schedule, version, dryRun, rows }) {
  const res = await client.query(
    `INSERT INTO immunisation_schedule_import_batches
       (tenant_id, schedule, source_version, status, dry_run, started_at, metadata, updated_at)
     VALUES ($1::uuid, $2, $3, 'running', $4, NOW(), $5::jsonb, NOW())
     RETURNING id`,
    [
      tenantId,
      schedule,
      version,
      dryRun === true,
      JSON.stringify({ importer: 'immunisation-schedule-import.mjs', row_count: rows.length }),
    ],
  );
  return res.rows[0].id;
}

async function finishBatch(client, batchId, status, stats, errorDetail = null) {
  await client.query(
    `UPDATE immunisation_schedule_import_batches
        SET status = $2,
            rows_processed = $3,
            rows_upserted = $4,
            rows_retired = $5,
            rows_skipped = $6,
            rows_failed = $7,
            error_detail = $8,
            finished_at = NOW(),
            updated_at = NOW()
      WHERE id = $1`,
    [batchId, status, stats.processed, stats.upserted, stats.retired, stats.skipped, stats.failed, errorDetail],
  );
}

async function upsertCatalogueRow(client, tenantId, row, version) {
  const existing = await client.query(
    `SELECT id
       FROM vaccine_catalogue
      WHERE tenant_id = $1::uuid
        AND code = $2
        AND ((dose_number IS NULL AND $3::int IS NULL) OR dose_number = $3::int)
      ORDER BY id
      LIMIT 1`,
    [tenantId, row.code, row.dose_number],
  );
  if (existing.rows.length) {
    await client.query(
      `UPDATE vaccine_catalogue
          SET display_name = $2,
              recommended_age_days = $3,
              window_days = $4,
              description = $5,
              active = TRUE,
              retired_at = NULL,
              schedule_source = $6,
              source_version = $7
        WHERE id = $1`,
      [
        existing.rows[0].id,
        row.display_name,
        row.recommended_age_days,
        row.window_days,
        row.description,
        row.schedule_source,
        version,
      ],
    );
    return;
  }
  await client.query(
    `INSERT INTO vaccine_catalogue
       (tenant_id, code, display_name, dose_number, recommended_age_days,
        window_days, description, active, schedule_source, source_version)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, TRUE, $8, $9)`,
    [
      tenantId,
      row.code,
      row.display_name,
      row.dose_number,
      row.recommended_age_days,
      row.window_days,
      row.description,
      row.schedule_source,
      version,
    ],
  );
}

async function retireMissingRows(client, tenantId, schedule, importedKeys, dryRun) {
  const sources = sourcesFor(schedule);
  const active = await client.query(
    `SELECT id, code, dose_number
       FROM vaccine_catalogue
      WHERE tenant_id = $1::uuid
        AND schedule_source = ANY($2::text[])
        AND active = TRUE`,
    [tenantId, sources],
  );
  const retireIds = active.rows
    .filter((row) => !importedKeys.has(keyFor(row)))
    .map((row) => row.id);
  if (!dryRun && retireIds.length) {
    await client.query(
      `UPDATE vaccine_catalogue
          SET active = FALSE,
              retired_at = NOW()
        WHERE id = ANY($1::int[])`,
      [retireIds],
    );
  }
  return retireIds.length;
}

export async function importScheduleRows({
  client,
  tenantId,
  schedule,
  version,
  dryRun = false,
  rows = null,
}) {
  const scheduleRows = (rows || buildScheduleRows(schedule)).map(normalizeRow);
  const stats = { processed: 0, upserted: 0, retired: 0, skipped: 0, failed: 0 };
  const batchId = await createBatch(client, { tenantId, schedule, version, dryRun, rows: scheduleRows });
  try {
    const importedKeys = new Set();
    for (const row of scheduleRows) {
      stats.processed += 1;
      if (!sourcesFor(schedule).includes(row.schedule_source)
        || !row.code
        || !row.display_name
        || !Number.isInteger(row.recommended_age_days)
        || row.recommended_age_days < 0
        || !Number.isInteger(row.window_days)
        || row.window_days < 0) {
        stats.skipped += 1;
        continue;
      }
      importedKeys.add(keyFor(row));
      if (!dryRun) {
        await upsertCatalogueRow(client, tenantId, row, version);
        stats.upserted += 1;
      }
    }
    stats.retired = await retireMissingRows(client, tenantId, schedule, importedKeys, dryRun);
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
  if (!args.tenantId) {
    console.error('--tenant <uuid> is required');
    process.exit(2);
  }
  if (!VALID_SCHEDULES.has(args.schedule)) {
    console.error('--schedule must be one of: uip, iap, both');
    process.exit(2);
  }
  if (!args.version) {
    console.error('--version <label> is required');
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
    const result = await importScheduleRows({ client, ...args });
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `${args.dryRun ? '[dry-run] ' : ''}${args.schedule} schedule ${args.version}: ` +
      `processed ${result.processed}` +
      `${args.dryRun ? '' : `, upserted ${result.upserted}, retired ${result.retired}`}` +
      `, skipped ${result.skipped} in ${secs}s (batch ${result.batchId})`,
    );
    console.log('Clinical sign-off reminder: attach the named clinician approval to the tenant import evidence.');
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
