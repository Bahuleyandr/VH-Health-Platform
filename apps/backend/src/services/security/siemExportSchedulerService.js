// src/services/security/siemExportSchedulerService.js — G3 / BES-1 (reaudit 2026-08-25)
//
// Scheduler wiring for the SIEM export engine (siemExportService). The engine,
// its migrations (448/449/622), and a synthetic drill already exist — but had
// ZERO runtime callers: nothing captured security audit events into the export
// ledger or dispatched them on a schedule. This service is the missing driver.
//
// One sweep per tick, per tenant:
//   1. capturePendingSecurityAuditEvents — copy new module='security' audit_log
//      rows into siem_export_events (redacted, PHI-minimised).
//   2. enqueueSiemDeliveries — fan the captured events out to every ACTIVE
//      siem_export_target as pending delivery attempts.
//   3. dispatchSiemDeliveries — lease + deliver pending attempts.
//
// Enable switch (fail-closed, default OFF):
//   * env  SIEM_EXPORT_SCHEDULER_ENABLED=true is the deployment kill switch.
//   * per-tenant: the presence of an ACTIVE siem_export_targets row IS the
//     per-tenant enable (mirrors lis_listeners — the registry is the flip).
// A tenant with no active target is a fast no-op; the engine already reports
// { skipped_reason: 'no_active_siem_export_target' } from enqueue.
//
// The live SIEM endpoint/credentials are OWNER-SIDE: a target only reaches
// status='active' by an explicit owner write (upsertSiemExportTarget), and a
// webhook target's shared secret is read from an env var named in its config.
// So this scheduler never delivers anywhere the owner did not explicitly wire.

import logger from '../../logging/logger.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  capturePendingSecurityAuditEvents,
  enqueueSiemDeliveries,
  dispatchSiemDeliveries,
} from './siemExportService.js';

const DEFAULT_BATCH = 100;

export function isSiemExportSchedulerEnvEnabled() {
  return process.env.SIEM_EXPORT_SCHEDULER_ENABLED === 'true';
}

// Run the full capture → enqueue → dispatch sweep for one tenant. Fault is the
// caller's to isolate (runForEachTenant already does per-tenant fault
// isolation). Returns a compact counts summary for the scheduler log.
export async function runSiemExportForTenant({ tenantId, batchSize = DEFAULT_BATCH } = {}) {
  const tid = requireTenantId(tenantId);

  const capture = await capturePendingSecurityAuditEvents({ tenantId: tid, batchSize });
  const enqueue = await enqueueSiemDeliveries({ tenantId: tid, batchSize });
  // No active target → nothing to dispatch; skip the lease scan entirely.
  if (enqueue.skipped_reason === 'no_active_siem_export_target') {
    return {
      tenant_id: tid,
      captured: capture.captured_count,
      enqueued: 0,
      dispatched: 0,
      skipped_reason: 'no_active_siem_export_target',
    };
  }
  const dispatch = await dispatchSiemDeliveries({ tenantId: tid, batchSize });
  return {
    tenant_id: tid,
    captured: capture.captured_count,
    enqueued: enqueue.enqueued,
    dispatched: dispatch.dispatched,
    succeeded: dispatch.succeeded,
    failed: dispatch.failed,
    dead: dispatch.dead,
  };
}

// Guard used by the scheduler registration: only schedules the cron when the
// env kill switch is on. Kept here so the scheduler stays declarative.
export function siemExportSchedulerEnabled() {
  return isSiemExportSchedulerEnvEnabled();
}

export function logSweepResult(result) {
  logger.info('siem-export-sweep complete', result);
}

export default {
  isSiemExportSchedulerEnvEnabled,
  runSiemExportForTenant,
  siemExportSchedulerEnabled,
};
