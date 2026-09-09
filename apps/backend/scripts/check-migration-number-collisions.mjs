#!/usr/bin/env node
// scripts/check-migration-number-collisions.mjs
//
// Fails when two migration files share a numeric prefix. Ordering between
// same-number files is filename-alphabetical, which is fine only while the
// colliding files are independent — a collision with a real dependency would be
// a subtle production-ordering hazard, and the HL7-outbound work already tripped
// over filename-compare collisions once.
//
// THE GRANDFATHERED SET
//
// The historical collisions are FIVE NUMBERS across ELEVEN FILES — 217 is a
// TRIPLE, the other four are pairs — accumulated from concurrent PR trains
// (once-over 2026-08-23). They are exempt so the backlog does not force a rename
// of already-applied migrations: a rename desyncs the `_migrations` tracker on
// every existing database.
//
// The exemption is BY EXACT FILENAME, and the predicate says so:
//
//   a number carrying more than one file is a collision UNLESS EVERY file
//   carrying that number is in GRANDFATHERED_FILES.
//
// It used to be by NUMBER (`new Set(['203','211','217','233','574'])`, filtered
// with `!GRANDFATHERED.has(num)`) with a second, count-based guard bolted on
// (`files.length > (num === '217' ? 3 : 2)`) to stop a grandfathered number
// growing another file. That pair caught an ADDITION but not a COUNT-PRESERVING
// SUBSTITUTION: renaming `217_lab_results_investigation_link.sql` to any other
// `217_*.sql`, or deleting one `203_*.sql` and landing a brand-new `203_*.sql`
// beside the survivor, left the count unchanged and passed silently — a genuine
// new collision on a grandfathered number, admitted by a comment that claimed
// filenames while the code compared numbers.
//
// Filename matching also subsumes the count guard: a fourth `217_*.sql` is not
// in the set, so the number is no longer fully covered and fails. Losing a
// grandfathered file is deliberately fine — a number whose surviving files are
// all in the set stays exempt, so a future consolidation does not need this
// list edited in the same commit.
//
// The set is a closed historical list. Do not add to it: a new collision is the
// thing this gate exists to reject.

import { readdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS_DIR = resolve(HERE, '../src/migrations');

// A run of digits, an underscore, anything, `.sql`. Same predicate as
// scripts/ci/check-migration-registry.mjs: `126b_create_data_breaches.sql` has a
// letter before its underscore and is outside the numbering scheme for both.
export const MIGRATION_FILE = /^(\d+)_.+\.sql$/;

// Eleven filenames, five numbers, 217 a triple. Verified against
// apps/backend/src/migrations at main (6295debbf) — see the meta-test in
// scripts/ci/check-migration-number-collisions.test.mjs, which re-derives this
// list from the live directory so the two cannot drift apart in silence.
export const GRANDFATHERED_FILES = new Set([
  '203_insurance_master_seed_and_admission_link.sql',
  '203_investigations_collection_instructions.sql',
  '211_tpa_claim_line_decisions.sql',
  '211_vitals_urine_dipstick.sql',
  '217_appointments_visit_no.sql',
  '217_emergency_visits_triage_ats_codes.sql',
  '217_lab_results_investigation_link.sql',
  '233_doctor_profile_user_role_repair.sql',
  '233_ensure_ed_tables_exist.sql',
  '574_obgyn_labour_ward_privilege_seed.sql',
  '574_unified_audit_read_model.sql',
]);

export function readMigrationFileNames(dir = MIGRATIONS_DIR) {
  return readdirSync(dir).filter((f) => MIGRATION_FILE.test(f)).sort();
}

export function groupByNumber(fileNames) {
  const byNumber = new Map();
  for (const file of fileNames) {
    const m = MIGRATION_FILE.exec(file);
    if (!m) continue;
    const num = m[1];
    if (!byNumber.has(num)) byNumber.set(num, []);
    byNumber.get(num).push(file);
  }
  return byNumber;
}

/**
 * A number is an offender when it carries more than one file and at least one of
 * those files is not a grandfathered filename. Every offender reports the FULL
 * file list for the number, grandfathered members included, because the reader
 * has to see what the new file collides with.
 */
export function evaluate(fileNames) {
  const byNumber = groupByNumber(fileNames);

  const offenders = [...byNumber.entries()]
    .filter(([, files]) => files.length > 1 && !files.every((f) => GRANDFATHERED_FILES.has(f)))
    .map(([number, files]) => ({
      number,
      files,
      newcomers: files.filter((f) => !GRANDFATHERED_FILES.has(f)),
    }))
    .sort((a, b) => Number(a.number) - Number(b.number));

  const grandfatheredPresent = fileNames.filter((f) => GRANDFATHERED_FILES.has(f));
  const grandfatheredNumbers = new Set(
    grandfatheredPresent.map((f) => MIGRATION_FILE.exec(f)[1]),
  );

  return { byNumber, offenders, grandfatheredPresent, grandfatheredNumbers };
}

// The directory is overridable so the regression suite can point the real
// executable at a mutated temp copy without touching apps/backend/src/migrations.
// Default unchanged: `npm run check:migration-numbers` passes no arguments and
// resolves relative to this file, not to the caller's cwd.
function parseArgs(argv) {
  const fromEnv = process.env.VH_MIGRATIONS_DIR;
  const opts = { migrations: fromEnv ? resolve(fromEnv) : MIGRATIONS_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--migrations') opts.migrations = resolve(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const fileNames = readMigrationFileNames(opts.migrations);

  if (fileNames.length === 0) {
    // A verdict over an empty set is not a pass. If the directory moved or the
    // filename predicate stopped matching, this gate would otherwise report
    // "clean: 0 distinct numbers" and go green forever.
    console.error(`${opts.migrations}: no migration files matched ${MIGRATION_FILE}.`);
    process.exit(1);
  }

  const { byNumber, offenders, grandfatheredPresent, grandfatheredNumbers } = evaluate(fileNames);

  if (offenders.length > 0) {
    console.error('Duplicate migration numbers detected (pick the next free number):');
    for (const { number, files, newcomers } of offenders) {
      console.error(`  ${number}: ${files.join(', ')}`);
      console.error(`     not grandfathered: ${newcomers.join(', ')}`);
    }
    console.error(
      '\nThe exemption is by exact filename, not by number: the five historical\n'
      + 'collisions (eleven files, 217 a triple) are named in GRANDFATHERED_FILES and\n'
      + 'nothing else may share their numbers. Allocate the next free number from\n'
      + 'docs/superpowers/NEXT_LEVEL_EXECUTION_PLAYBOOK.md §5.',
    );
    process.exit(1);
  }

  const dirLabel = relative(process.cwd(), opts.migrations) || opts.migrations;
  console.log(
    `Migration numbering clean: ${fileNames.length} migration files across `
    + `${byNumber.size} distinct numbers in ${dirLabel}; `
    + `${grandfatheredPresent.length} grandfathered files on `
    + `${grandfatheredNumbers.size} numbers, every collision fully covered by filename.`,
  );
}

// pathToFileURL rather than string-building: on Windows a drive path yields
// file:///D:/... (three slashes), so a hand-rolled `file://${argv[1]}` never
// matches and the gate silently no-ops when invoked directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
