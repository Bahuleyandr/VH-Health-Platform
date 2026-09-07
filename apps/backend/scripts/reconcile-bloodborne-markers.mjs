#!/usr/bin/env node
// Blood-borne marker reconciliation sweep (spec 2026-09-04 §18): re-drive the
// marker writer over signed HIV/HBsAg/HCV lab results that carry no active
// marker row, repairing a post-commit hook miss the sign-off path cannot
// repair on its own.
//
// Shaped after scripts/reconcile-lab-threshold-exceptions.mjs: the same
// runForEachTenant fan-out and the same single JSON summary line on stdout.
// One deliberate difference — this script is DRY RUN by default and writes
// only with --apply, echoing the mandatory confirmation flag on
// reconcile-lab-critical-alert-generations.mjs. A repair job that writes
// clinical rows the moment someone runs it to "see what it would do" is the
// wrong default.
//
//   node scripts/reconcile-bloodborne-markers.mjs            # report only
//   node scripts/reconcile-bloodborne-markers.mjs --apply    # repair
//
//   --allow-no-handlers   DIAGNOSTIC ONLY. Repair even though no blood-borne
//                         exposure handler is registered in this process, so a
//                         reactive marker will NOT quarantine the cath devices
//                         used on that patient. Only for a run where the
//                         device sweep is known to be handled elsewhere.
//
//   BLOODBORNE_MARKER_RECONCILIATION_BATCH_SIZE  per-tenant scan cap (1-MAX_LIMIT, default 500)
//   BLOODBORNE_MARKER_RECONCILIATION_SINCE       ISO instant; only results signed at or after it
//
// EXPOSURE HANDLERS ARE WHY THE FIRST IMPORT IS WHAT IT IS. Recording a
// REACTIVE marker fans out through notifyExposureHandlers, which quarantines
// the cath devices used on that patient. The handlers register as a MODULE-LOAD
// side effect of their owners, and in the API process that happens only because
// the cath route files import cathDeviceReuseService.js. A script's import
// graph does not, so this sweep used to repair reactive markers into a process
// with an EMPTY handler set: the marker landed, the fan-out iterated nothing,
// and no device was ever quarantined — reported as a clean repair. The
// bootstrap below is imported for that side effect and the count is asserted
// before anything is written.
//
// EXIT CODES
//   0  swept every active tenant with nothing left failing (or a dry run)
//   1  the fan-out failed — one or more tenants rejected, or the run could not
//      be started; `runForEachTenant` is fail-closed, so a zero exit means
//      every active tenant was swept and scheduled_job_runs is the receipt
//   2  refused: --apply with no exposure handler registered (see above)
//   3  --apply completed but `failed` is non-zero — repairs are outstanding
//   4  another process holds this job's advisory lock; nothing was done

// FIRST, and for its side effect: registers every blood-borne exposure handler
// in this process. Must precede any repair. Removing this line is the mutation
// unit/exposureHandlerBootstrap.test.js is calibrated against.
import { exposureHandlerCount } from '../src/services/clinical/exposureHandlerBootstrap.js';

import prisma from '../src/lib/prisma.js';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  RECONCILIATION_JOB_LABEL,
  reconcileAllTenants,
  withReconciliationJobLock,
} from '../src/services/clinical/bloodborneMarkerReconciliationService.js';

const APPLY_FLAG = '--apply';
const ALLOW_NO_HANDLERS_FLAG = '--allow-no-handlers';

export const EXIT_OK = 0;
export const EXIT_FANOUT_FAILED = 1;
export const EXIT_NO_EXPOSURE_HANDLERS = 2;
export const EXIT_REPAIRS_FAILED = 3;
export const EXIT_LOCK_HELD = 4;

function batchSize() {
  const raw = process.env.BLOODBORNE_MARKER_RECONCILIATION_BATCH_SIZE || DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_LIMIT) {
    throw new Error(`BLOODBORNE_MARKER_RECONCILIATION_BATCH_SIZE must be 1-${MAX_LIMIT}`);
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

function say(line) {
  process.stdout.write(`[${RECONCILIATION_JOB_LABEL}] ${line}\n`);
}

async function main() {
  const dryRun = !process.argv.includes(APPLY_FLAG);
  const allowNoHandlers = process.argv.includes(ALLOW_NO_HANDLERS_FLAG);
  const handlers = exposureHandlerCount();

  // Printed on EVERY run, dry or not: the count is the one piece of evidence
  // that this process can act on a reactive result, and an operator reading a
  // dry run should see it before deciding to --apply.
  say(`exposure handlers registered in this process: ${handlers}`);

  if (!dryRun && handlers === 0 && !allowNoHandlers) {
    process.stderr.write(
      `[${RECONCILIATION_JOB_LABEL}] refusing to --apply: no blood-borne exposure handler is `
      + 'registered in this process, so repairing a REACTIVE marker would not quarantine the '
      + `devices used on that patient. Fix the import of `
      + `src/services/clinical/exposureHandlerBootstrap.js, or pass ${ALLOW_NO_HANDLERS_FLAG} `
      + 'if the device sweep is genuinely handled elsewhere for this run.\n',
    );
    return EXIT_NO_EXPOSURE_HANDLERS;
  }
  if (!dryRun && handlers === 0) {
    process.stderr.write(
      `[${RECONCILIATION_JOB_LABEL}] ${ALLOW_NO_HANDLERS_FLAG}: repairing with NO exposure `
      + 'handler; reactive results will not sweep the cath device register.\n',
    );
  }

  // One --apply at a time across the fleet. A dry run takes the same lock: two
  // concurrent dry runs are harmless, but a dry run that overlaps an --apply
  // reports candidates that are being repaired underneath it, which is a
  // misleading report rather than a harmless one.
  const { ran, result: summary } = await withReconciliationJobLock(() => reconcileAllTenants({
    since: since(),
    limit: batchSize(),
    dryRun,
  }));
  if (!ran) {
    process.stderr.write(
      `[${RECONCILIATION_JOB_LABEL}] another run holds this job's lock; nothing was done\n`,
    );
    return EXIT_LOCK_HELD;
  }

  // The per-tenant rows are dropped from the stdout line on purpose: the
  // totals and the run id are the operator's summary, and a fleet-wide sweep
  // would otherwise print one row per tenant into a log pipeline.
  const { tenants, ...totals } = summary;
  process.stdout.write(`${JSON.stringify({
    ...totals,
    exposure_handlers: handlers,
    tenants: tenants.length,
  })}\n`);

  if (dryRun) {
    if (totals.candidates > 0) {
      say(`dry run: rerun with ${APPLY_FLAG} to repair these`);
    }
    // The preflight ran in the dry run too, so this number is the failure
    // count the --apply would inherit before the writer is even called.
    if (totals.would_fail > 0) {
      say(`dry run: ${totals.would_fail} candidate(s) would fail preflight and stay unrepaired`);
    }
    if (totals.unrepairable_excluded > 0) {
      say(
        `dry run: ${totals.unrepairable_excluded} gap(s) excluded as structurally unrepairable `
        + `(${totals.unrepairable_missing_actor} with no signing actor, `
        + `${totals.unrepairable_missing_subject} with no patient row)`,
      );
    }
    // A dry run reports; it never fails on what it found.
    return EXIT_OK;
  }

  if (totals.failed > 0) {
    process.stderr.write(
      `[${RECONCILIATION_JOB_LABEL}] ${totals.failed} candidate(s) could not be repaired; `
      + 'see the per-lab-result warnings in the log\n',
    );
    return EXIT_REPAIRS_FAILED;
  }
  return EXIT_OK;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`[${RECONCILIATION_JOB_LABEL}] ${error?.message || error}\n`);
    // Partial progress rides out on the aggregate error rather than being lost
    // with it; print it so an operator can see how far the sweep got.
    if (error?.result) process.stderr.write(`${JSON.stringify(error.result)}\n`);
    process.exitCode = EXIT_FANOUT_FAILED;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
