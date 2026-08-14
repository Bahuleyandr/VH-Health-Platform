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
  const fanout = read('utils', 'tenantFanout.js');
  expect(scheduler).toContain("process.env.ENABLE_AUTOMATED_PAYROLL_CRONS === 'true'");

  // Scope the fanout assertions to the ENABLE-gated financial block. A
  // file-wide `{ strict: true }` count was only an accidental proxy for "both
  // payroll fanouts are strict": it silently also pinned "no OTHER cron in this
  // file may use strict fanout", which is not this test's subject and is not a
  // property anyone wants. Adding the unrelated interface-engine-outbound-
  // dispatch cron therefore broke a payroll contract it has nothing to do with.
  const blockStart = scheduler.indexOf("if (process.env.ENABLE_AUTOMATED_PAYROLL_CRONS === 'true') {");
  const blockEnd = scheduler.indexOf("logger.info('Automated payroll and salary-review crons are disabled')");
  expect(blockStart).toBeGreaterThanOrEqual(0);
  expect(blockEnd).toBeGreaterThan(blockStart);
  const financialCrons = scheduler.slice(blockStart, blockEnd);
  expect(financialCrons).toContain("withJobLock('monthly-payroll'");
  expect(financialCrons).toContain("withJobLock('annual-salary-review'");
  expect(financialCrons.match(/runForEachTenant\(/g)).toHaveLength(2);
  expect(financialCrons.match(/\{ strict: true \}/g)).toHaveLength(2);

  // …and pin the guarantee those call sites are asking for against the helper's
  // actual control flow, not just the call-site decoration. Since the fleet
  // receipt rewrite `runForEachTenant` no longer takes a `strict` option — it
  // rejects the aggregate run unconditionally — so a mutation that made a
  // failed tenant degrade back to a best-effort sweep would pass a call-site
  // text check while silently un-doing what this test is named for.
  expect(fanout).toContain('if (failed > 0 || unresolved > 0) {');
  expect(fanout).toContain('throw fanoutError(');

  // The monthly-payroll job no longer inlines the payroll_runs INSERT: the
  // payroll-atomicity rewrite moved it into payrollService.beginPayrollRun, so
  // the run row is created inside the run transaction with an attempt token.
  // The property this line guarded — the run row is written for exactly ONE
  // explicit tenant, never fleet-wide — is unchanged, so assert it at its new
  // home rather than pinning a string that has moved out of this file.
  const payroll = read('services', 'staff', 'payrollService.js');
  expect(jobs).toContain("import { executePayrollRun } from '../services/staff/payrollService.js'");
  expect(jobs).toContain('const tid = requireTenantId(tenantId);');
  expect(jobs).toContain('tenantId: tid,');
  expect(payroll).toContain('INSERT INTO payroll_runs');
  expect(payroll).toContain('(tenant_id, month, year, status, generated_by, generated_at,');
  expect(payroll).toContain("VALUES ($1::uuid, $2, $3, 'processing', $4::uuid, $5::timestamptz,");

  expect(jobs).toContain('(tenant_id, staff_uid, review_year, reminder_sent_at)');
});
