#!/usr/bin/env node
// immunisation-schedule-import.mjs - NL-5 P4 UIP/IAP schedule importer.
//
// Usage:
//   node scripts/immunisation-schedule-import.mjs --tenant <uuid> --schedule uip|iap|both --version 2026
//   (preflight only; add --apply to write, and --retire-survivors to disposition
//    catalogue rows that the incoming pack does not contain)
//
// The importer is intentionally operator-run. Existing patient/newborn schedule
// rows are never updated; only vaccine_catalogue rows change for future seeds.
//
// FORK GUARD -----------------------------------------------------------------
// Catalogue rows are matched on (tenant_id, code, dose_number) and the retire
// pass only ever saw rows whose schedule_source matched the pack being imported.
// Against the migration-160 seed (29 rows, all schedule_source='custom') that
// meant an import FORKED the catalogue instead of replacing it:
//
//   * mig-160 seeds BCG with dose_number = NULL; the UIP pack ships BCG dose 1,
//     so the probe could not match and a SECOND active BCG row was inserted.
//   * the UIP pack ships PENTA while mig-160 carries the decomposed DPT/HEPB/HIB
//     components. Being 'custom', they were never retired and stayed active, so
//     every newly seeded child was booked for pentavalent AND each of its three
//     component antigens. Same shape for IPV vs FIPV.
//
// The guard enforces one invariant, and it needs no clinical knowledge to do it:
//
//     after a run, every ACTIVE catalogue row must belong to the incoming pack.
//
// Any active row left outside the pack is a "survivor". Survivors are exactly
// the fork, and the importer now refuses to run while any exist unless the
// operator explicitly dispositions them with --retire-survivors. Note this
// deliberately does NOT need a component/antigen map: DPT/HEPB/HIB are caught
// because they are active rows absent from the incoming pack, not because the
// importer knows PENTA contains them. Choosing an antigen-equivalence policy is
// decision D6 and is not engineering's to make.

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const VALID_SCHEDULES = new Set(['uip', 'iap', 'both']);

export const FORK_GUARD_CODE = 'IMMUNISATION_IMPORT_WOULD_FORK_CATALOGUE';

export class ImportForkError extends Error {
  constructor(plan) {
    const survivorList = plan.survivors
      .map((r) => `${r.code}${r.dose_number == null ? '' : ` dose ${r.dose_number}`} (${r.schedule_source})`)
      .join(', ');
    super(
      `${FORK_GUARD_CODE}: ${plan.survivors.length} active catalogue row(s) are not in the incoming pack `
      + `and would remain active alongside it: ${survivorList}. `
      + 'Re-run with --retire-survivors to retire them, or resolve decision D6 first.',
    );
    this.name = 'ImportForkError';
    this.code = FORK_GUARD_CODE;
    this.survivors = plan.survivors;
    this.collisions = plan.collisions;
    this.plan = plan;
  }
}

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
  // Preflight is the default. Writing requires --apply.
  const args = { apply: false, retireSurvivors: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tenant') args.tenantId = argv[++i];
    else if (a === '--schedule') args.schedule = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--apply') args.apply = true;
    else if (a === '--retire-survivors') args.retireSurvivors = true;
    // --dry-run is retained for the documented runbook invocation; it is now
    // the default, so it is accepted as an explicit no-op.
    else if (a === '--dry-run') args.apply = false;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  args.dryRun = !args.apply;
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

function isImportableRow(row, schedule) {
  return sourcesFor(schedule).includes(row.schedule_source)
    && Boolean(row.code)
    && Boolean(row.display_name)
    && Number.isInteger(row.recommended_age_days)
    && row.recommended_age_days >= 0
    && Number.isInteger(row.window_days)
    && row.window_days >= 0;
}

async function retireRowIds(client, ids) {
  if (!ids.length) return 0;
  const res = await client.query(
    `UPDATE vaccine_catalogue
        SET active = FALSE,
            retired_at = NOW()
      WHERE id = ANY($1::int[])`,
    [ids],
  );
  return res.rowCount;
}

async function retireMissingRows(client, tenantId, schedule, importedKeys) {
  const active = await client.query(
    `SELECT id, code, dose_number
       FROM vaccine_catalogue
      WHERE tenant_id = $1::uuid
        AND schedule_source = ANY($2::text[])
        AND active = TRUE`,
    [tenantId, sourcesFor(schedule)],
  );
  const retireIds = active.rows
    .filter((row) => !importedKeys.has(keyFor(row)))
    .map((row) => row.id);
  return retireRowIds(client, retireIds);
}

async function fetchCatalogue(client, tenantId) {
  const res = await client.query(
    `SELECT vc.id, vc.code, vc.dose_number, vc.display_name, vc.recommended_age_days,
            vc.window_days, vc.description, vc.active, vc.schedule_source,
            (SELECT COUNT(*)::int FROM newborn_immunisations ni
              WHERE ni.vaccine_catalogue_id = vc.id)
          + (SELECT COUNT(*)::int FROM patient_immunisations pi
              WHERE pi.vaccine_catalogue_id = vc.id) AS referencing_doses
       FROM vaccine_catalogue vc
      WHERE vc.tenant_id = $1::uuid
      ORDER BY vc.id`,
    [tenantId],
  );
  return res.rows;
}

/**
 * Read-only preflight. Computes exactly what an import would do, without
 * writing anything. `survivors` is the fork: active rows the incoming pack does
 * not contain and that nothing in the run would retire.
 *
 * The client must NOT already be inside a transaction.
 */
export async function planImport(client, { tenantId, schedule, rows = null }) {
  const scheduleRows = (rows || buildScheduleRows(schedule)).map(normalizeRow);
  const importable = scheduleRows.filter((row) => isImportableRow(row, schedule));
  const existing = await fetchCatalogue(client, tenantId);

  const byKey = new Map(existing.map((row) => [keyFor(row), row]));
  const importedKeys = new Set(importable.map(keyFor));
  const packSources = sourcesFor(schedule);

  const inserts = [];
  const updates = [];
  for (const row of importable) {
    // The probe deliberately ignores `active`, mirroring upsertCatalogueRow:
    // re-importing a retired vaccine reactivates its existing row.
    const match = byKey.get(keyFor(row));
    if (!match) {
      inserts.push(row);
      continue;
    }
    const before = {
      display_name: match.display_name,
      recommended_age_days: match.recommended_age_days,
      window_days: match.window_days,
      description: match.description,
      active: match.active,
      schedule_source: match.schedule_source,
    };
    const after = {
      display_name: row.display_name,
      recommended_age_days: row.recommended_age_days,
      window_days: row.window_days,
      description: row.description,
      active: true,
      schedule_source: row.schedule_source,
    };
    updates.push({
      id: match.id,
      code: row.code,
      dose_number: row.dose_number,
      before,
      after,
      changed: Object.keys(after).filter((field) => before[field] !== after[field]),
      // Reads join the LIVE catalogue row, so changing an age or window here
      // retro-changes how these already-seeded doses render and whether they
      // read as overdue. The operator is shown the blast radius.
      referencing_doses: match.referencing_doses,
    });
  }

  // Already handled by the retire pass: active, in-source, absent from the pack.
  const retires = existing.filter((row) => row.active
    && packSources.includes(row.schedule_source)
    && !importedKeys.has(keyFor(row)));

  // THE FORK: active rows outside the incoming pack that nothing would retire.
  const survivors = existing.filter((row) => row.active
    && !packSources.includes(row.schedule_source)
    && !importedKeys.has(keyFor(row)));

  // Dose-identity collisions: the pack and the catalogue disagree on whether a
  // vaccine's dose is numbered at all (mig-160 BCG dose NULL vs UIP BCG dose 1).
  // Always a subset of `survivors`, but surfaced as its own class because it
  // signals an authority-level disagreement about dose identity (decision D6).
  const collisions = [];
  for (const row of existing) {
    if (!row.active) continue;
    const clash = importable.find((incoming) => incoming.code === row.code
      && (incoming.dose_number == null) !== (row.dose_number == null));
    if (clash) {
      collisions.push({
        code: row.code,
        existing_id: row.id,
        existing_dose_number: row.dose_number,
        incoming_dose_number: clash.dose_number,
      });
    }
  }

  return {
    inserts,
    updates,
    retires,
    survivors,
    collisions,
    processed: scheduleRows.length,
    skipped: scheduleRows.length - importable.length,
  };
}

export async function importScheduleRows({
  client,
  tenantId,
  schedule,
  version,
  dryRun = false,
  rows = null,
  retireSurvivors = false,
}) {
  const scheduleRows = (rows || buildScheduleRows(schedule)).map(normalizeRow);
  const importable = scheduleRows.filter((row) => isImportableRow(row, schedule));
  const plan = await planImport(client, { tenantId, schedule, rows: scheduleRows });

  const stats = {
    processed: plan.processed,
    upserted: 0,
    retired: 0,
    skipped: plan.skipped,
    failed: 0,
  };
  const batchId = await createBatch(client, { tenantId, schedule, version, dryRun, rows: scheduleRows });

  // Fork guard: refuse before writing anything, and record the refused attempt.
  if (plan.survivors.length && !retireSurvivors) {
    const err = new ImportForkError(plan);
    stats.failed = 1;
    await finishBatch(client, batchId, 'failed', stats, err.message);
    throw err;
  }

  if (dryRun) {
    await finishBatch(client, batchId, 'completed', stats);
    return { batchId, status: 'completed', dryRun: true, plan, ...stats };
  }

  // Every catalogue mutation commits or none does. The batch row is written
  // outside this transaction on purpose, so the audit trail survives a rollback.
  try {
    await client.query('BEGIN');
    for (const row of importable) {
      await upsertCatalogueRow(client, tenantId, row, version);
      stats.upserted += 1;
    }
    stats.retired = await retireMissingRows(client, tenantId, schedule, new Set(importable.map(keyFor)));
    if (retireSurvivors && plan.survivors.length) {
      stats.retired += await retireRowIds(client, plan.survivors.map((row) => row.id));
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    stats.failed += 1;
    await finishBatch(client, batchId, 'failed', stats, err.message || String(err));
    throw err;
  }

  await finishBatch(client, batchId, 'completed', stats);
  return { batchId, status: 'completed', plan, ...stats };
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
    printPlan(result.plan);
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `\n${args.dryRun ? '[PREFLIGHT — nothing written] ' : '[APPLIED] '}`
      + `${args.schedule} schedule ${args.version}: processed ${result.processed}`
      + `${args.dryRun ? '' : `, upserted ${result.upserted}, retired ${result.retired}`}`
      + `, skipped ${result.skipped} in ${secs}s (batch ${result.batchId})`,
    );
    if (args.dryRun) {
      console.log('Re-run with --apply to write these changes.');
    }
    console.log('Clinical sign-off reminder: attach the named clinician approval to the tenant import evidence.');
  } catch (err) {
    if (err.code === FORK_GUARD_CODE) {
      console.error('\nREFUSED — this import would FORK the catalogue.\n');
      console.error(`${err.survivors.length} active row(s) are not in the incoming pack and nothing in this run`);
      console.error('would retire them. They would stay active alongside the pack, so children seeded after');
      console.error('this import would be booked for BOTH schedules:\n');
      for (const row of err.survivors) {
        console.error(`  - ${describeRow(row)}  [schedule_source=${row.schedule_source}]`);
      }
      if (err.collisions.length) {
        console.error('\nDose-identity collisions (the pack and the catalogue disagree on whether the dose is');
        console.error('numbered — the probe cannot match them, so the pack row would be inserted as a duplicate):\n');
        for (const c of err.collisions) {
          console.error(`  - ${c.code}: catalogue dose=${c.existing_dose_number ?? 'NULL'} vs pack dose=${c.incoming_dose_number ?? 'NULL'}`);
        }
      }
      console.error('\nResolve by either:');
      console.error('  * re-running with --retire-survivors to retire the rows above, or');
      console.error('  * resolving decision D6 (immunisation authority) first — combining packs needs a signed');
      console.error('    antigen-equivalence policy, which engineering must not invent.');
      await client.end();
      process.exit(3);
    }
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}

function describeRow(row) {
  return `${row.code}${row.dose_number == null ? ' (no dose number)' : ` dose ${row.dose_number}`}`;
}

function printPlan(plan) {
  if (!plan) return;
  console.log('\n=== PREFLIGHT DIFF ===');

  console.log(`\nINSERT (${plan.inserts.length}) — new catalogue rows:`);
  for (const row of plan.inserts) {
    console.log(`  + ${describeRow(row)} @ ${row.recommended_age_days}d (window ${row.window_days}d)`);
  }

  const changed = plan.updates.filter((u) => u.changed.length);
  console.log(`\nUPDATE IN PLACE (${changed.length} of ${plan.updates.length} matched rows would change):`);
  for (const u of changed) {
    const timingChanged = u.changed.includes('recommended_age_days') || u.changed.includes('window_days');
    console.log(`  ~ ${describeRow(u)}: ${u.changed.join(', ')}`);
    if (timingChanged) {
      console.log(`      age ${u.before.recommended_age_days}d -> ${u.after.recommended_age_days}d, `
        + `window ${u.before.window_days}d -> ${u.after.window_days}d`);
      if (u.referencing_doses > 0) {
        console.log(`      WARNING: ${u.referencing_doses} already-seeded dose row(s) reference this catalogue row.`);
        console.log('      Their due_date is fixed at seed time and will NOT move, but every read surface joins');
        console.log('      the live catalogue row — so their displayed age/window, and whether they read as');
        console.log('      overdue, will change retroactively.');
      }
    }
  }

  console.log(`\nRETIRE (${plan.retires.length}) — in-pack-source rows absent from this pack:`);
  for (const row of plan.retires) {
    console.log(`  - ${describeRow(row)}  [schedule_source=${row.schedule_source}]`);
  }

  console.log(`\nSURVIVORS (${plan.survivors.length}) — active rows OUTSIDE the incoming pack:`);
  for (const row of plan.survivors) {
    console.log(`  ! ${describeRow(row)}  [schedule_source=${row.schedule_source}]`);
  }
  if (plan.survivors.length) {
    console.log('    These would remain active alongside the pack (a FORK) unless --retire-survivors is given.');
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
