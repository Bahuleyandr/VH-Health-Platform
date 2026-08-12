import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../..');
const read = (...parts) => fs.readFileSync(path.join(src, ...parts), 'utf8');

test('walk sessions resume and stop idempotently instead of discarding metrics', () => {
  const source = read('routes', 'steps', 'stepsRoutes.js');
  expect(source).toContain("pg_advisory_xact_lock(hashtextextended($1::text, 0))");
  expect(source).toContain('if (active) return { session: active, resumed: true }');
  expect(source).toContain("if (!existing.is_active)");
  expect(source).toContain("duplicate: true");
  expect(source).not.toContain('Close any open session');
});

test('all live external recovery callers use fenced enqueue-and-process takeover', () => {
  const substrate = read('services', 'integrations', 'externalInterfaceRecoveryService.js');
  expect(substrate).toContain('export async function enqueueAndProcessExternalRecoveryItem');
  expect(substrate).toContain("'EXTERNAL_RECOVERY_PENDING'");
  for (const parts of [
    ['services', 'integrations', 'externalLabRecoveryService.js'],
    ['services', 'emr', 'deviceVitalsService.js'],
    ['routes', 'fhir', 'fhirRoutes.js'],
  ]) {
    const caller = read(...parts);
    expect(caller).toContain('enqueueAndProcessExternalRecoveryItem');
  }
});

test('financial crons are disabled by default and use strict tenant fanout', () => {
  const scheduler = read('utils', 'scheduler.js');
  const jobs = read('utils', 'payrollSchedulerJobs.js');
  expect(scheduler).toContain("process.env.ENABLE_AUTOMATED_PAYROLL_CRONS === 'true'");
  expect(scheduler.match(/\{ strict: true \}/g)).toHaveLength(2);
  expect(jobs).toContain('INSERT INTO payroll_runs (tenant_id, month, year, status)');
  expect(jobs).toContain('(tenant_id, staff_uid, review_year, reminder_sent_at)');
});
