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

test('financial crons are disabled by default and fan out fail-closed per tenant', () => {
  const scheduler = read('utils', 'scheduler.js');
  const jobs = read('utils', 'payrollSchedulerJobs.js');
  const fanout = read('utils', 'tenantFanout.js');
  expect(scheduler).toContain("process.env.ENABLE_AUTOMATED_PAYROLL_CRONS === 'true'");

  // Scope the fanout assertions to the ENABLE-gated financial block, so an
  // unrelated cron elsewhere in this file can never break a payroll contract it
  // has nothing to do with — which is exactly what a file-wide count used to do.
  const blockStart = scheduler.indexOf("if (process.env.ENABLE_AUTOMATED_PAYROLL_CRONS === 'true') {");
  const blockEnd = scheduler.indexOf("logger.info('Automated payroll and salary-review crons are disabled')");
  expect(blockStart).toBeGreaterThanOrEqual(0);
  expect(blockEnd).toBeGreaterThan(blockStart);
  const financialCrons = scheduler.slice(blockStart, blockEnd);
  expect(financialCrons).toContain("withJobLock('monthly-payroll'");
  expect(financialCrons).toContain("withJobLock('annual-salary-review'");
  expect(financialCrons.match(/runForEachTenant\(/g)).toHaveLength(2);

  // There is deliberately no `{ strict: true }` assertion. `runForEachTenant`
  // took a real `strict` option until the fleet-receipt rewrite, which removed
  // it by making the behaviour UNCONDITIONAL — so the literal survived at the
  // call sites as decoration the helper destructures away. Pinning its count
  // asserted a no-op under a security-flavoured name, and would have failed the
  // cleanup that deletes it, for zero behavioural reason. Assert what is real:
  // the options bag takes only a lock key, the payroll call sites pass none,
  // and the helper rejects the aggregate run itself — for every caller, not
  // just the ones that used to opt in. A mutation that let a failed tenant
  // degrade back to a best-effort sweep fails here.
  expect(fanout).toContain(
    'export async function runForEachTenant(label, perTenantFn, { lockKey = label } = {}) {',
  );
  expect(financialCrons).not.toContain('{ strict: true }');
  expect(fanout).toContain("err.code = 'TENANT_DISCOVERY_EMPTY';");
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

  // The reminder INSERT grew the tenant-reconciliation pair, so the old
  // four-column literal no longer describes any row this cron writes. That is a
  // deliberate tightening, not drift: chk_annual_review_reminders_tenant_
  // reconciliation and the RESTRICTIVE annual_review_reminders_reconciled_only
  // policy both admit a cron-written row only when tenant_reconciliation_
  // required is FALSE and tenant_id is the caller's own tenant. Pin the whole
  // written shape — column list, the false/'{}' literals, the tenant predicate
  // and the conflict target — instead of a four-column prefix, so a row that
  // stopped declaring itself reconciled, or stopped scoping to one tenant,
  // fails here too.
  expect(jobs).toContain('INSERT INTO annual_review_reminders');
  expect(jobs).toContain('(tenant_id, staff_uid, review_year, reminder_sent_at,');
  expect(jobs).toContain('tenant_reconciliation_required, tenant_reconciliation_evidence)');
  expect(jobs).toContain("SELECT ss.tenant_id, ss.staff_uid, $2, NOW(), false, '{}'::jsonb");
  expect(jobs).toContain('WHERE ss.tenant_id = $1::uuid');
  expect(jobs).toContain('ON CONFLICT (tenant_id, staff_uid, review_year) DO NOTHING');
  expect(jobs).toContain('await setTenant(tid, tx => tx.$queryRawUnsafe(');
});
