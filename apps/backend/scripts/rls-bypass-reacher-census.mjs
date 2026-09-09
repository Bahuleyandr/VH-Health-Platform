import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectBypassReachers } from './lib/rlsBypassReacherSource.mjs';
import {
  assertTablePin,
  buildPin,
  migrationStatements,
  renderPin,
  serializePin
} from './lib/rlsBypassReacherPin.mjs';

export const PIN_PATH = 'docs/security/rls-bypass-reacher-pin-2026-09-08.json';
export const REPORT_PATH = 'docs/security/rls-bypass-reacher-census-2026-09-08.md';

export function connectionInventory() {
  return [
    {
      consumer: 'additional imported pg module: scripts/backfill-drug-compositions.mjs:1',
      role: 'explicit connectionString or DATABASE_URL or TEST_DATABASE_URL; actual connection role requires query',
      bypassrls: 'environment-dependent; unverified',
      evidence:
        'Imported by pharmacyOrderController for its pure parser helper. Direct backfill calls at lines 5/21/31/45 only address drug_compositions, pharmacy_catalog and drug_composition_curation_queue; no target-table intersection. Source scan counts this separately from the four imports within src.'
    },
    {
      consumer: 'prisma / bare transaction clients',
      role: 'DATABASE_URL: declared vhhealth_runtime; wrapped transactions SET LOCAL ROLE vhhealth_app',
      bypassrls: 'false for both declared runtime roles',
      evidence:
        'infra/kubernetes/apps/backend/configmap.yaml:231-247; infra/kubernetes/base/cnpg/cluster.yaml:225-240; src/lib/prisma.js:713-727. Bare tx sites remain enumerated pending context proof.'
    },
    {
      consumer: 'prismaReadOnly (all sites, including setTenant readOnly wrappers)',
      role: 'DATABASE_READ_URL override, otherwise primary DATABASE_URL; actual override role requires connection query',
      bypassrls: 'unknown for override; false for declared primary fallback',
      evidence:
        'src/lib/prisma.js:668-686. Census includes read-only queries even when a request path normally supplies ALS.'
    },
    {
      consumer: 'direct pg: src/utils/scheduler.js:9',
      role: 'SCHEDULER_LOCK_DATABASE_URL override or DATABASE_URL (declared vhhealth_runtime)',
      bypassrls: 'unknown for override; false for declared primary fallback',
      evidence:
        'withDbAdvisoryLock:111/125 only pg_try_advisory_lock/pg_advisory_unlock. Callback SQL is traced separately; no target-table SQL on the lock connection.'
    },
    {
      consumer: 'direct pg: src/services/clinical/bloodborneMarkerReconciliationService.js:78',
      role: 'SCHEDULER_LOCK_DATABASE_URL override or DATABASE_URL (declared vhhealth_runtime)',
      bypassrls: 'unknown for override; false for declared primary fallback',
      evidence:
        'withReconciliationJobLock:665/678 only advisory lock/unlock. Callback Prisma SQL is traced separately.'
    },
    {
      consumer: 'direct pg: src/utils/migrations/runMigrations.js:5',
      role: 'DATABASE_URL; declared owner migration job uses vhhealth, app uses vhhealth_runtime with RUN_MIGRATIONS=false',
      bypassrls: 'true for declared migration owner; false for declared application role',
      evidence:
        'createNoTransactionClient:228; runStatements:213; applyNoTransactionMigration.js:runPgStatements. Expanded SQL statements appear in the administrative appendix. cnpg/cluster.yaml:275-286 and backend/configmap.yaml:247 are declarations, not live proof.'
    },
    {
      consumer: 'direct pg: src/scripts/security/audit-secret-encryption.js:11',
      role: 'operator DATABASE_URL; actual connection role requires query',
      bypassrls: 'environment-dependent; unverified',
      evidence:
        'SECRET_COLUMNS:23 enumerates integration_credentials, smart_apps, hl7_feed_subscriptions, teleconsult_provider_configs and mfa_devices; query:98 checks information_schema and query:141 scans those five tables. Intersection with these 22 tables is empty.'
    }
  ];
}

export function collectPin(repoRoot, revision) {
  const trace = collectBypassReachers(repoRoot);
  const runLines = [];
  for (const row of trace.sourceManifest.filter(row => row.file.startsWith('apps/backend/src/'))) {
    const text = readFileSync(path.join(repoRoot, row.file), 'utf8');
    for (const [index, line] of text.split(/\r?\n/).entries())
      if (/runWithSuperAdmin\(/.test(line)) runLines.push(`${row.file}:${index + 1}`);
  }
  const scheduler = readFileSync(
    path.join(repoRoot, 'apps/backend/src/utils/scheduler.js'),
    'utf8'
  );
  const lexical = {
    runWithSuperAdminLines: runLines.length,
    runWithSuperAdminFiles: new Set(runLines.map(row => row.replace(/:\d+$/, ''))).size,
    runWithSuperAdminLocations: runLines,
    withJobLockLines: scheduler.split(/\r?\n/).filter(line => /withJobLock\(/.test(line)).length
  };
  return buildPin(trace, migrationStatements(repoRoot, trace.targetTables), {
    revision,
    lexical,
    connections: connectionInventory()
  });
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const args = process.argv.slice(2);
  const expectedFile = path.join(repoRoot, PIN_PATH);
  const expected = args.includes('--write') ? null : JSON.parse(readFileSync(expectedFile, 'utf8'));
  const revision =
    expected?.revision ||
    execFileSync(
      'git',
      ['rev-parse', args.includes('--revision') ? args[args.indexOf('--revision') + 1] : 'HEAD'],
      { cwd: repoRoot, encoding: 'utf8' }
    ).trim();
  const pin = collectPin(repoRoot, revision);
  if (args.includes('--write')) {
    writeFileSync(expectedFile, serializePin(pin));
    writeFileSync(path.join(repoRoot, REPORT_PATH), renderPin(pin));
  } else if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(pin));
  } else if (args.includes('--check')) {
    if (pin.tables.length !== expected.tables.length) throw new Error('Table population changed');
    for (const table of pin.tables)
      assertTablePin(
        table,
        expected.tables.find(row => row.table === table.table)
      );
    for (const key of ['registrations', 'entryPoints', 'statements']) {
      if (JSON.stringify(pin[key]) !== JSON.stringify(expected[key]))
        throw new Error(`${key} changed: regenerate and review census`);
    }
    console.log(
      `Census matches: ${pin.tables.length} tables; ${pin.registrations.length} jobs; ${pin.statements.length} unique statements; all dispositions PENDING.`
    );
  } else throw new Error('Use --write, --check, or --json');
  if (args.includes('--write'))
    console.log(pin.tables.map(row => `${row.table}: ${row.equation}`).join('\n'));
}
