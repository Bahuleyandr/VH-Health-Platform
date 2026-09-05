#!/usr/bin/env node
// Blood-borne marker reconciliation sweep (spec 2026-09-04 §18): re-drive the
// marker writer over signed HIV/HBsAg/HCV lab results that carry no active
// marker row, repairing a post-commit hook miss the sign-off path cannot
// repair on its own.
//
// Shaped after scripts/reconcile-lab-threshold-exceptions.mjs: the same
// runForEachTenant fan-out, the same job-label-as-lock-key pairing, the same
// single JSON summary line on stdout. One deliberate difference — this script
// is DRY RUN by default and writes only with --apply, echoing the mandatory
// confirmation flag on reconcile-lab-critical-alert-generations.mjs. A repair
// job that writes clinical rows the moment someone runs it to "see what it
// would do" is the wrong default.
//
//   node scripts/reconcile-bloodborne-markers.mjs            # report only
//   node scripts/reconcile-bloodborne-markers.mjs --apply    # repair
//
//   BLOODBORNE_MARKER_RECONCILIATION_BATCH_SIZE  per-tenant candidate cap (1-5000, default 500)
//   BLOODBORNE_MARKER_RECONCILIATION_SINCE       ISO instant; only results signed at or after it
//
// Exit 1 on a fan-out failure. runForEachTenant is fail-closed — one tenant
// that throws rejects the aggregate — so a zero exit means every active tenant
// was swept, and the durable receipt in scheduled_job_runs is the record.

import prisma from '../src/lib/prisma.js';
import {
  DEFAULT_LIMIT,
  RECONCILIATION_JOB_LABEL,
  reconcileAllTenants,
} from '../src/services/clinical/bloodborneMarkerReconciliationService.js';

const MAX_BATCH_SIZE = 5000;
const APPLY_FLAG = '--apply';

function batchSize() {
  const raw = process.env.BLOODBORNE_MARKER_RECONCILIATION_BATCH_SIZE || DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_BATCH_SIZE) {
    throw new Error(`BLOODBORNE_MARKER_RECONCILIATION_BATCH_SIZE must be 1-${MAX_BATCH_SIZE}`);
  }
  return parsed;
}

function since() {
  const raw = String(process.env.BLOODBORNE_MARKER_RECONCILIATION_SINCE || '').trim();
  if (!raw) return null;
  const instant = new Date(raw);
  if (Number.isNaN(instant.getTime())) {
    throw new Error('BLOODBORNE_MARKER_RECONCILIATION_SINCE must be a valid ISO instant');
  }
  return instant.toISOString();
}

async function main() {
  const dryRun = !process.argv.includes(APPLY_FLAG);
  const summary = await reconcileAllTenants({
    since: since(),
    limit: batchSize(),
    dryRun,
  });
  // The per-tenant rows are dropped from the stdout line on purpose: the
  // totals and the run id are the operator's summary, and a fleet-wide sweep
  // would otherwise print one row per tenant into a log pipeline.
  const { tenants, ...totals } = summary;
  process.stdout.write(`${JSON.stringify({ ...totals, tenants: tenants.length })}\n`);
  if (dryRun && totals.candidates > 0) {
    process.stdout.write(
      `[${RECONCILIATION_JOB_LABEL}] dry run: rerun with ${APPLY_FLAG} to repair these\n`,
    );
  }
}

main()
  .catch((error) => {
    process.stderr.write(`[${RECONCILIATION_JOB_LABEL}] ${error?.message || error}\n`);
    // Partial progress rides out on the aggregate error rather than being lost
    // with it; print it so an operator can see how far the sweep got.
    if (error?.result) process.stderr.write(`${JSON.stringify(error.result)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
