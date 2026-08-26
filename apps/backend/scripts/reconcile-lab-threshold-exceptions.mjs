#!/usr/bin/env node

import prisma from '../src/lib/prisma.js';
import { reconcileLabThresholdExceptionsForTenant } from '../src/services/lab/labThresholdReconciliationService.js';
import { runForEachTenant } from '../src/utils/tenantFanout.js';

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;
const JOB_LABEL = 'lab-threshold-exception-reconciliation';

function batchSize() {
  const raw = process.env.LAB_THRESHOLD_RECONCILIATION_BATCH_SIZE || DEFAULT_BATCH_SIZE;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_BATCH_SIZE) {
    throw new Error(`LAB_THRESHOLD_RECONCILIATION_BATCH_SIZE must be 1-${MAX_BATCH_SIZE}`);
  }
  return parsed;
}

async function main() {
  const limit = batchSize();
  const tenantResults = [];
  const run = await runForEachTenant(
    JOB_LABEL,
    async (tenantId) => {
      const result = await reconcileLabThresholdExceptionsForTenant({ tenantId, limit });
      tenantResults.push({ tenant_id: tenantId, ...result });
    },
    { lockKey: JOB_LABEL },
  );
  const totals = tenantResults.reduce((acc, row) => {
    for (const key of [
      'observed',
      'resolved',
      'deferred',
      'already_resolved',
      'critical_alerts_created',
      'failures',
    ]) acc[key] += Number(row[key] || 0);
    return acc;
  }, {
    observed: 0,
    resolved: 0,
    deferred: 0,
    already_resolved: 0,
    critical_alerts_created: 0,
    failures: 0,
  });
  process.stdout.write(`${JSON.stringify({
    job: JOB_LABEL,
    run_id: run.runId,
    tenants_discovered: run.tenantsDiscovered,
    tenants_run: run.tenantsRun,
    ...totals,
  })}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`[${JOB_LABEL}] ${error?.message || error}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
