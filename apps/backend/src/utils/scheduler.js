// src/utils/scheduler.js

// Named import, not the default namespace: node-cron 4.6 added a top-level
// `schedule` named export alongside the default object, which makes
// `cron.schedule(...)` trip import/no-named-as-default-member (a warning, and
// this package lints with --max-warnings=0). Both spellings resolve to the same
// function; the named one is the unambiguous home.
import { schedule as cronSchedule } from 'node-cron';
import pg from 'pg';
import path from 'path';
import { cleanupOldBackups as cleanupBackups } from '../../admin/cleanup-backups.js';
import purgeArchives from '../../admin/purge-archives.js';
import { isPathwayProjectorShadowEnabled } from '../config/pathwayProjectorConfig.js';
import {
  isPathwayReconciliationEnabled,
  pathwayReconciliationCron,
} from '../config/pathwayReconciliationConfig.js';
import prisma from '../lib/prisma.js';
import { runWithSuperAdmin } from '../lib/tenantContext.js';
import logger from '../logging/logger.js';

const runningJobs = new Set();

// node-cron task handles, kept so gracefulShutdown (bin/www.js) can .stop()
// every timer before prisma.$disconnect() — otherwise a tick can fire mid-
// disconnect and throw. registerCron() pushes each scheduled task here.
const scheduledTasks = [];

function registerCron(...args) {
  const task = cronSchedule(...args);
  scheduledTasks.push(task);
  return task;
}

/**
 * Stop every registered node-cron task. Idempotent. Called by
 * bin/www.js gracefulShutdown BEFORE prisma.$disconnect() so no cron tick
 * races a closing DB connection. node-cron's .stop() prevents future
 * invocations; an already-running tick finishes against the still-open pool.
 */
export function stopAllScheduledTasks() {
  for (const task of scheduledTasks) {
    try {
      task.stop();
    } catch (err) {
      logger.warn('Failed to stop a scheduled task during shutdown:', err.message);
    }
  }
  logger.info(`Stopped ${scheduledTasks.length} scheduled task(s).`);
}

// ─── Cross-process job lock (C-5) ────────────────────────────────────────────
//
// cluster.js forks CLUSTER_WORKERS workers per pod, and the Deployment runs
// 3 replicas — up to 6 processes each registering the same crons. The legacy
// in-process `runningJobs` Set only dedupes ticks *within one process*, so
// every mutating sweep could run up to 6× concurrently (duplicate patient SMS,
// double escalations/audit rows, 6 concurrent pg_dumps). See audit C-5.
//
// Fix: a Postgres advisory lock keyed on the job name. Exactly one process
// across the whole fleet acquires it per tick; the rest skip. We use a
// SESSION-level lock (pg_try_advisory_lock) held on a DEDICATED short-lived
// pg connection for the full duration of the job body, then released
// (pg_advisory_unlock) and the connection closed in finally.
//
// Why a dedicated pg.Client and not prisma.$queryRaw: the Prisma pg adapter
// pools connections, so a pg_try_advisory_lock issued on one pooled connection
// and the matching pg_advisory_unlock issued later could land on DIFFERENT
// physical connections — leaking the lock forever. A lock we own end-to-end on
// one connection cannot leak. The body itself still runs on the normal prisma
// pool; the lock connection just sits idle holding the lock.
//
// Failure-open posture: if the lock connection can't be established (DB blip),
// we fall back to running the job WITHOUT the cross-process guard rather than
// silently skipping a sweep fleet-wide. The in-process Set still prevents
// same-process overlap in that degraded window.
const ADVISORY_LOCK_NAMESPACE = 0x5648; // 'VH' — keeps our keyspace clear of other apps' hashtext() locks.

function advisoryConnectionString() {
  // Never pin a statement_timeout on the lock connection: it holds the lock
  // idle across a possibly-long job body and must not be reaped mid-run.
  return process.env.SCHEDULER_LOCK_DATABASE_URL || process.env.DATABASE_URL;
}

/**
 * Acquire a fleet-wide advisory lock for `jobName`, run `fn`, release the lock.
 * Returns true if the lock was acquired (job ran), false if another process
 * held it (job skipped). On connection failure, runs `fn` un-guarded and
 * returns true (fail-open — see note above).
 *
 * Exported for tests (proves a second concurrent caller is skipped).
 */
export async function withDbAdvisoryLock(jobName, fn) {
  const connectionString = advisoryConnectionString();
  if (!connectionString) {
    // No DB configured (shouldn't happen in real runs) — run un-guarded.
    await fn();
    return true;
  }

  const client = new pg.Client({ connectionString });
  let connected = false;
  try {
    await client.connect();
    connected = true;
  } catch (err) {
    logger.warn(
      `Advisory-lock connection failed for ${jobName} — running without cross-process guard:`,
      err.message,
    );
    await fn();
    return true;
  }

  let acquired = false;
  try {
    // pg_try_advisory_lock(int4, int4): namespace + a stable hash of the job
    // name. hashtext() is deterministic across processes/replicas, so all
    // workers contend for the SAME lock id per job.
    const res = await client.query(
      'SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked',
      [ADVISORY_LOCK_NAMESPACE, jobName],
    );
    acquired = res.rows?.[0]?.locked === true;
    if (!acquired) {
      logger.info(`Skipping ${jobName} — advisory lock held by another process/replica`);
      return false;
    }
    await fn();
    return true;
  } finally {
    if (acquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [
          ADVISORY_LOCK_NAMESPACE,
          jobName,
        ]);
      } catch (err) {
        // Unlock on the same connection we acquired on; if it fails the
        // connection is about to close anyway, which releases the lock.
        logger.warn(`Advisory unlock failed for ${jobName}:`, err.message);
      }
    }
    if (connected) {
      try {
        await client.end();
      } catch {
        // Closing the connection is best-effort; the session lock is released
        // by the backend terminating regardless.
      }
    }
  }
}

// Phase-2 RLS: scheduled jobs run outside the Express request scope, so
// they have no AsyncLocalStorage tenant context. Wrapping every job body
// in runWithSuperAdmin marks the work as a cross-tenant aggregator —
// the prisma proxy at src/lib/prisma.js then auto-applies
// setTenant(null, fn, { superAdmin: true }) so RLS policies (075 + 236)
// allow the scan when AUTH_ENFORCE_TENANT_RLS=true. Jobs that need
// per-tenant scoping should loop over tenants with runInTenantContext
// inside their own body.
//
// Two layers of overlap protection:
//   1. in-process `runningJobs` Set — fast-path, prevents a tick stacking on
//      the previous run within THIS process.
//   2. cross-process Postgres advisory lock (withDbAdvisoryLock) — prevents
//      the same job running concurrently across the 6-process cluster fleet.
function withJobLock(jobName, fn) {
  return async () => {
    if (runningJobs.has(jobName)) {
      logger.warn(`Skipping ${jobName} — previous run still active`);
      return;
    }
    runningJobs.add(jobName);
    const start = Date.now();
    try {
      const ran = await withDbAdvisoryLock(jobName, () => runWithSuperAdmin(fn));
      if (ran) {
        logger.info(`Job ${jobName} completed in ${Date.now() - start}ms`);
      }
    } catch (err) {
      logger.error(`Job ${jobName} failed after ${Date.now() - start}ms:`, err);
    } finally {
      runningJobs.delete(jobName);
    }
  };
}

// Deliberately WITHOUT the cross-process advisory lock — for observation jobs
// only, never for jobs that mutate.
//
// A Prometheus gauge lives in the process that set it. Under withJobLock only
// one replica wins the advisory lock each tick, so only that replica refreshes
// its gauge while every other replica keeps serving whatever it last observed.
// An alert reading max() across replicas then latches on the stalest reading
// and never clears; reading min() would let a stale replica mask a real
// failure. A read-only probe is cheap enough to run on every replica, which
// keeps every scraped series current. In-process overlap protection still
// applies.
function withReplicaLocalJobGuard(jobName, fn) {
  return async () => {
    if (runningJobs.has(jobName)) {
      logger.warn(`Skipping ${jobName} — previous run still active`);
      return;
    }
    runningJobs.add(jobName);
    try {
      await runWithSuperAdmin(fn);
    } catch (err) {
      logger.error(`Job ${jobName} failed:`, err);
    } finally {
      runningJobs.delete(jobName);
    }
  };
}
import purgeLogs from '../scripts/cleanup-logs.js';

// R2 Maintenance Jobs
import { retryFailedNotifications } from '../services/notificationRetryService.js';
import { runUnreadCriticalEscalation } from '../services/notification/notificationService.js';
import { executeArchiveMigration } from './archiveMigrationJob.js';

// Clinical-AI workflow resume scheduler — Phase 5 of the rollout.
import { runPausedWorkflowSweep } from '../services/ai/workflowResumeScheduler.js';

// Operational forecast alert sweep — Task 4. Advisory; flag-gated.
import { runSweep } from '../services/ai/operationalAlertService.js';
import { runBiomedCmmsMaintenanceSweep } from '../services/biomed/biomedCmmsService.js';

// Prior-auth → appeal chain starter sweep — Task 6. Auto-starts the chain
// for denied prior-auth requests that have no appeal letter / run yet.
import { startPendingPriorAuthAppeals } from '../services/ai/priorAuthAppealChainService.js';

// Revenue-cycle standing-queue tracker — flag-gated. Advisory tracker only.
// Per-stage auto-generation triggers are DEFERRED (human-in-loop design).
// Fans out per-tenant (audit §3): the bare runRevenueCycleSweep({}) collapsed to
// the default tenant only, so every other tenant's queue went untracked.
import { runRevenueCycleSweepAllTenants } from '../services/billing/revenueCycleTrackerService.js';
import { reconcileLedger, persistReconciliationCheck } from '../services/billing/ledger/ledgerReconciliation.js';
import { resolveLedgerModeForTenant } from '../services/billing/ledger/ledgerAuthoritativeMode.js';

// Webhook delivery dispatcher — Phase A3 PR2 of the structural audit.
import { dispatchPendingDeliveries, reapStaleInFlightDeliveries } from '../services/integrations/webhookDeliveryService.js';
import { dispatchPendingNHCXMessages, reapStaleNHCXDispatches } from '../services/nhcx/nhcxOutboundDispatcherService.js';

// Event-outbox drain. publishEvent() writes event_outbox rows from ~40 producers
// but NOTHING drained them — rows sat at status='pending' forever (the delivery
// bridge was half-built). drainEventOutbox below is the missing consumer: it
// claims due rows (FOR UPDATE SKIP LOCKED) and bridges each to the webhook
// delivery pipeline via enqueueDelivery (event_outbox_id FK links the two).
import {
  claimPendingEvents,
  completeClaimedEventFanout,
  failClaimedEvent,
  reapStaleProcessingEvents,
} from '../services/events/eventOutboxService.js';

// Visit-status reaper — A8. Flips stale SCHEDULED appointments to MISSED.
import { reapStaleScheduledVisits } from '../services/appointment/appointmentReaperService.js';

// Staff roster deadline escalation — next week's roster must be published
// before the configured cutoff, otherwise HR gets an in-app alert.
import { runRosterDeadlineEscalation } from '../services/staff/rosterDeadlineService.js';
import { purgeExpiredStaffMessages } from '../services/messaging/staffMessageRetentionService.js';
import { purgeExpiredNoteDrafts } from '../services/emr/clinicalNoteDraftService.js';
import { purgeExpiredAmbientAudio } from '../services/ai/ambientDocumentationService.js';
import { purgeAuditEvidenceForTenant } from '../services/compliance/auditRetentionService.js';

// Inpatient drug-chart SLA — once a patient has reached a ward/ICU bed,
// doctors and that ward's nurses must not silently miss first medication charting.
import { runMissingDrugChartSweep } from '../services/clinical/drugChartSlaService.js';

// Bed inspection sweeper — D1. Marks stale pending inspections as expired.
import { expireStaleInspections } from '../services/bed/bedInspectionService.js';

// PHI-access break-glass expiry sweeper — CareTeam ABAC design §5. Flips
// active overrides past their expires_at to the terminal 'expired' status for
// audit cleanliness (the engine already treats them as inactive by time).
import { sweepExpiredBreakGlass } from '../services/security/breakGlassService.js';

// Results-inbox escalation engine — RESULTS_INBOX_ESCALATION_DESIGN §4.3/§4.4.
// Evaluates active escalation_rules against overdue tasks / breached mig-269
// SLA instances and fires tiered actions (re-notify → duty role → leadership),
// plus a backfill backstop, so no critical result falls through the cracks.
import { runEscalationSweep } from '../services/workflow/escalationEngineService.js';

// Notifications
// NB: backupVerification / canaryHealthCheck / wardDowntimePackService entry-
// points are intentionally NOT imported here anymore — those jobs are owned by
// dedicated k8s CronJobs (audit C-5), not the in-process scheduler.
import { tickAdminKpi } from './kpiAggregator.js';
import { tickDailyOps } from './dailyOpsBroadcaster.js';
import { tickTeleconsultOps } from './teleconsultOpsBroadcaster.js';
import { purgeHousekeepingPhotos } from './housekeepingPurgeJob.js';
import { sendAppointmentReminders, sendTimedReminders, processPendingScheduledNotifications } from './notifications/appointmentReminderJob.js';
import { sendInvestigationNotifications } from './notifications/InvestigationNotificationJob.js';
import { escalateStuckOrders } from './notifications/stuckOrderEscalation.js';
import { executeCleanup } from './r2CleanupJob.js';
import { deliverPendingFeedMessages } from '../services/hl7/hl7OutboundService.js';
import { sweepWaitlists } from '../services/scheduling/schedulingOptimizationService.js';
import { expiryRadarSweep } from '../services/staff/credentialingService.js';
import { detectSchemaDrift } from './schemaDriftDetector.js';
import { runCanaryChecks } from './canaryHealthCheck.js';
import { expireOldIdempotencyKeys } from '../services/idempotency/idempotencyService.js';
import loadSwaggerDocument from './swaggerLoader.js';

// Notification outbox drain (audit C-6). The outbox persists notification
// intent before the inline send; getPendingForRetry had zero callers, so the
// durable-retry guarantee was inert — breach/critical-lab/escalation notices
// were lost whenever the inline send failed. The drain below is the missing
// consumer.
import { notificationOutbox } from './notifications/notificationOutbox.js';
import { deliverNotificationOutboxRow } from './notifications/notificationOutboxDelivery.js';
import { reconcileExpiredClaims } from '../services/notification/notificationDeliveryLedgerService.js';

// Audit hash-chain scheduled verifier (platform audit 2026-06-18 §3). The
// tamper-evident chain on clinical_audit_events (migration 282) was only ever
// recomputed on a manual admin endpoint, so a tampered chain could sit
// undetected indefinitely. The cron below runs verifyAuditChain on a schedule
// and raises a LOUD alert (error log + security webhook) on any mismatch.
import { verifyAuditChain } from '../services/clinical/documentIntegrityService.js';
import { sendSecurityWebhook } from './securityWebhook.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';
import { runForEachTenant } from './tenantFanout.js';

/**
 * Verify the per-tenant audit hash chain for every active tenant (plus the
 * platform default) and alert loudly on any tamper. Exported for tests.
 *
 * One tenant's verification failure (or a thrown DB error) never aborts the
 * sweep — each tenant is wrapped in its own try/catch so a single bad chain or
 * transient error can't suppress checks for the others, and the cron tick
 * itself can't crash the scheduler.
 *
 * @returns {{ tenantsChecked:number, breaks:number, alerts:number }}
 */
export async function runAuditChainVerification() {
  // Discover active tenants; always include the default-tenant floor even if
  // the tenants table is empty/unavailable (single-tenant prod today).
  let tenantIds = [DEFAULT_TENANT_ID];
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM tenants WHERE status = 'active'`,
    );
    const ids = (Array.isArray(rows) ? rows : []).map((r) => r.id).filter(Boolean);
    tenantIds = [...new Set([DEFAULT_TENANT_ID, ...ids])];
  } catch (err) {
    logger.warn(`audit-chain-verify: tenant discovery failed, defaulting to platform tenant: ${err.message}`);
  }

  let tenantsChecked = 0;
  let totalBreaks = 0;
  let alerts = 0;
  for (const tenantId of tenantIds) {
    try {
      const verdict = await verifyAuditChain({ tenantId });
      tenantsChecked += 1;
      if (!verdict.intact) {
        totalBreaks += verdict.breaks;
        alerts += 1;
        // LOUD alert: structured error log + security webhook (PagerDuty/Slack).
        logger.error('AUDIT CHAIN TAMPER DETECTED', {
          tenant_id: tenantId,
          breaks: verdict.breaks,
          checked: verdict.checked,
          first_break_seq: verdict.first_break_seq,
          first_break_id: verdict.first_break_id,
        });
        sendSecurityWebhook('AUDIT_CHAIN_TAMPERED', {
          reason: `Audit hash chain tamper detected for tenant ${tenantId}: ${verdict.breaks} broken link(s); first break at seq ${verdict.first_break_seq} (id ${verdict.first_break_id})`,
          tenantId,
        });
      } else {
        logger.info(`audit-chain-verify: tenant ${tenantId} intact (${verdict.checked} link(s))`);
      }
    } catch (err) {
      // A verifier exception for one tenant must not abort the whole sweep or
      // crash the scheduler. Surface it loudly but keep going.
      logger.error(`audit-chain-verify: verification FAILED for tenant ${tenantId}: ${err.message}`, err);
    }
  }
  return { tenantsChecked, breaks: totalBreaks, alerts };
}

/**
 * Drain the notification outbox: claim a batch of due PENDING/FAILED rows
 * (FOR UPDATE SKIP LOCKED), attempt delivery via the real send path, and mark
 * each row SENT or FAILED (with the existing 5-min backoff + 3-attempt cap).
 *
 * Send-path routing per row:
 * The row delivery helper preserves the legacy path when tenant preferences
 * are unset:
 *   - SMS rows  (type='sms' or only a recipient_phone)        → no gateway is
 *     configured, so the attempt records a provider receipt of
 *     `rejected('sms_gateway_not_configured')` and the row goes FAILED. It is
 *     never reported as sent. fix-deferred: SMS gateway integration.
 *   - push rows (everything else, resolve device tokens)      → sendPushNotification
 * For appointment reminder / result-ready rows with an explicit
 * tenants.settings.notificationChannels override, it fans out through the
 * shared notification dispatcher (including WhatsApp/voice dry-run logging).
 *
 * A row with no deliverable target (no phone, no resolvable token) is marked
 * FAILED with a reason and backs off — after 3 such attempts it drops out of
 * the eligible set (retry_count >= 3), which is the intended dead-letter state.
 *
 * Exported for tests (proves a pending row is marked SENT after a drain).
 *
 * @param {Object} [opts]
 * @param {number} [opts.limit=50] Max rows per drain tick.
 * @returns {{ claimed:number, sent:number, failed:number }}
 */
export async function drainNotificationOutbox({ tenantId, limit = 50 } = {}) {
  if (!tenantId) throw new Error('notification outbox drain requires tenantId');
  const expired = await reconcileExpiredClaims({ tenantId, limit });
  const batch = await notificationOutbox.claimPendingBatch({ tenantId, limit });
  if (!batch.length) {
    return { claimed: 0, sent: 0, failed: 0, uncertain: 0, deferred: 0, expired };
  }

  let sent = 0;
  let failed = 0;
  let uncertain = 0;
  let deferred = 0;
  for (const row of batch) {
    try {
      const result = await deliverNotificationOutboxRow(row);
      const claimFence = {
        tenantId,
        claimToken: row.claim_token,
        claimGeneration: row.claim_generation,
      };
      if (result.outcome === 'acknowledged') {
        await notificationOutbox.markSent(row.id, claimFence);
        sent += 1;
      } else if (result.outcome === 'rejected') {
        const finalize = result.terminal
          ? notificationOutbox.markTerminalFailed.bind(notificationOutbox)
          : notificationOutbox.markFailed.bind(notificationOutbox);
        await finalize(
          row.id,
          result.terminal ? 'provider_terminal_rejection' : 'provider_rejected_notification',
          claimFence,
        );
        failed += 1;
      } else if (result.outcome === 'uncertain') {
        await notificationOutbox.markReconciliationRequired(
          row.id,
          'provider_delivery_outcome_uncertain',
          claimFence,
        );
        uncertain += 1;
      } else {
        await notificationOutbox.releaseClaim(row.id, 'tenant_channel_cursor_blocked', claimFence);
        deferred += 1;
      }
    } catch (err) {
      uncertain += 1;
      logger.warn(
        `outbox-drain: row ${row.id} remains leased for expiry reconciliation after delivery error:`,
        err.message,
      );
    }
  }
  logger.info(
    `Notification outbox drain: claimed ${batch.length}, sent ${sent}, rejected ${failed}, uncertain ${uncertain}, deferred ${deferred}`,
  );
  return { claimed: batch.length, sent, failed, uncertain, deferred, expired };
}

/**
 * Drain the event_outbox through leased claims. For each claim, subscription
 * fan-out and source completion commit in one tenant transaction. The unique
 * source/subscription bridge makes an ambiguous replay idempotent; an error
 * rolls back both fan-out and source completion before the exact claim fence is
 * failed with backoff.
 *
 * Exported for tests. `enqueueImpl` is an injection seam (mirrors
 * dispatchPendingDeliveries' fetchImpl) so the failure path can be exercised
 * deterministically.
 *
 * @param {Object} [opts]
 * @param {number} [opts.limit=100] Max rows per drain tick.
 * @param {Function} [opts.completeImpl] Override for atomic completion (tests).
 * @param {Function} [opts.claimImpl] Override for claimPendingEvents (tests).
 * @param {Function} [opts.failImpl] Override for fenced failure (tests).
 * @returns {{ claimed:number, delivered:number, failed:number, lostFence:number, enqueued:number }}
 */
export async function drainEventOutbox({
  limit = 100,
  claimImpl = claimPendingEvents,
  completeImpl = completeClaimedEventFanout,
  failImpl = failClaimedEvent,
} = {}) {
  const batch = await claimImpl({ limit });
  if (!batch.length) {
    return { claimed: 0, delivered: 0, failed: 0, lostFence: 0, enqueued: 0 };
  }

  let delivered = 0;
  let failed = 0;
  let lostFence = 0;
  let enqueued = 0;
  for (const row of batch) {
    try {
      const result = await completeImpl({ claim: row });
      if (result?.lost_fence) {
        lostFence += 1;
      } else if (result?.delivered) {
        enqueued += Number(result.enqueued || 0);
        delivered += 1;
      }
    } catch (err) {
      const result = await failImpl({
        claim: row,
        message: String(err?.message || err).slice(0, 1000),
      });
      if (result?.lost_fence) lostFence += 1;
      else if (result?.failed) failed += 1;
      logger.warn(`event-outbox-drain: delivery failed for row ${row.id}:`, err.message);
    }
  }
  logger.info(`Event outbox drain: claimed ${batch.length}, delivered ${delivered}, failed ${failed}, lost fence ${lostFence}, deliveries enqueued ${enqueued}`);
  return { claimed: batch.length, delivered, failed, lostFence, enqueued };
}

// CI-8 open-handle guard: every cron timer below is registered at import
// time and keeps the Node event loop alive, which leaks Jest open handles.
// scheduler.js is only imported by bin/www.js in real runs, so skipping all
// registration under NODE_ENV==="test" is behaviour-identical outside tests.
if (process.env.NODE_ENV !== 'test') {
  // 🗓️ Daily at 00:00 - Purge old logs
  registerCron('0 0 * * *', withJobLock('purge-logs', async () => {
    logger.info('Scheduled Task: Purging old logs...');
    await purgeLogs();
  }));

  // 🗓️ Every 5 minutes - synthetic canary health checks (audit 2026-06-22 M9).
  // runCanaryChecks tests DB read/write, stuck notifications, and unacknowledged
  // CRITICAL alerts. It was implemented but wired to NO tick, so the early-warning
  // signal it produces ran nowhere. withJobLock → exactly one runner across the
  // worker×replica fleet.
  registerCron('*/5 * * * *', withJobLock('canary-checks', async () => {
    await runCanaryChecks();
  }));

  // 🗓️ Hourly at :15 - idempotency-key retention sweep (audit 2026-06-22 M11).
  // expireOldIdempotencyKeys is implemented ("run from a cron tick") but was wired
  // to no scheduler, so the hot money-path idempotency_keys table grew unbounded.
  // Hourly keeps it bounded; the sweep is self-batched (LIMIT) + missing-schema-safe.
  registerCron('15 * * * *', withJobLock('idempotency-keys-sweep', async () => {
    const { expired } = await expireOldIdempotencyKeys();
    if (expired) logger.info(`Scheduled Task: expired ${expired} idempotency keys`);
  }));

  // 🗓️ Every 30 min - ledger reconciliation (T2 money-ledger Phase 2b). Per
  // active tenant, assert ledger AR == legacy amount_due + trial balance == 0.
  // During the strangler this is informational (logs/metrics drift); it becomes
  // a hard alert when the ledger is flipped authoritative (Phase 4). withJobLock
  // already runs the fn under runWithSuperAdmin, so the tenant enumeration reads
  // cross-tenant and reconcileLedger() re-scopes per tenant via setTenantTx.
  registerCron('*/30 * * * *', withJobLock('ledger-reconciliation', async () => {
    const tenants = await prisma.$queryRawUnsafe('SELECT id FROM tenants');
    let drift = 0;
    for (const t of tenants) {
      try {
        const tenantMode = await resolveLedgerModeForTenant(String(t.id));
        const r = await reconcileLedger(String(t.id), { mode: tenantMode });
        await persistReconciliationCheck(String(t.id), r, tenantMode); // Phase 4-5 evidence row
        drift += r.mismatches.length + r.unwired.length + r.eventsDrift.length + (r.trialBalancePaise !== 0 ? 1 : 0);
      } catch (err) {
        logger.error('ledger-reconciliation tenant failed', { tenantId: String(t.id), error: err.message });
      }
    }
    logger.info('ledger-reconciliation sweep complete', { tenants: tenants.length, driftSignals: drift });
  }));

  // 🗓️ Daily at 00:00 - Swagger validation
  registerCron('0 0 * * *', withJobLock('swagger-validation', async () => {
    logger.info('Scheduled Task: Validating Swagger...');
    const swaggerDocument = loadSwaggerDocument();
    if (!swaggerDocument) {throw new Error('Swagger document not loaded');}
    logger.info('✅ Swagger documentation validated.');
  }));

  // 🗓️ Daily at 02:00 - Backup database + verification
  //
  // REMOVED in-process registration (audit C-5). The database backup is owned
  // by a dedicated k8s CronJob — see infra/kubernetes/base/cnpg/ (CNPG
  // scheduled backups) and the ops runbook in docs/DEPLOYMENT_GUIDE.md. Running
  // it in-process too meant up to 6 concurrent nightly pg_dumps across the
  // worker×replica fleet. The CronJob is the single authoritative runner.

  // 🗓️ Monthly on 1st at 02:00 - Archive migration.
  // Wrapped in withJobLock (audit §5 reliability): without it, every
  // worker×replica (up to 6 processes) spawned a concurrent r2-migrate-archive
  // child on the same tick. The advisory lock makes exactly one process across
  // the fleet run it; executeArchiveMigration now resolves on child exit so the
  // lock is held for the migration's full duration.
  registerCron('0 2 1 * *', withJobLock('archive-migration', async () => {
    logger.info('Scheduled Task: Archive migration...');
    await executeArchiveMigration();
  }));

  // 🗓️ Monthly on 1st at 03:00 - R2 storage cleanup.
  // Wrapped in withJobLock (audit §5 reliability): previously a bare cron, so
  // all 6 processes raced deletes against the same R2 bucket. Single-runner now.
  registerCron('0 3 1 * *', withJobLock('r2-cleanup', async () => {
    await executeCleanup();
  }));

  // 🗓️ Weekly on Sunday at 03:00 - Purge archived logs
  registerCron('0 3 * * 0', withJobLock('purge-archives', async () => {
    logger.info('Scheduled Task: Purging .gz archived logs...');
    await purgeArchives();
  }));

  // 🗓️ Weekly on Sunday at 04:00 - Cleanup old backups
  registerCron('0 4 * * 0', withJobLock('cleanup-backups', async () => {
    logger.info('Scheduled Task: Cleaning up old backups...');
    await cleanupBackups(path.resolve('backups', 'local'));
    await cleanupBackups(path.resolve('backups', 'render'));
  }));

  // 🕗 Daily at 08:00 - Send appointment reminders (existing daily push-only)
  registerCron('0 8 * * *', withJobLock('send-appointment-reminders', () => runForEachTenant('send-appointment-reminders', () => sendAppointmentReminders())));

  // ⏰ Every hour - Send 24h and 1h SMS+push appointment reminders
  registerCron('0 * * * *', withJobLock('timed-reminders', () => runForEachTenant('timed-reminders', () => sendTimedReminders())));

  // 🔔 Every 5 minutes - Process pending scheduled notifications (feedback requests, etc.)
  registerCron('*/5 * * * *', withJobLock('process-scheduled-notifications', () => runForEachTenant('process-scheduled-notifications', () => processPendingScheduledNotifications())));

  // 💊 Every 5 minutes - Alert if an active ward/ICU admission still has no drug chart after 1 hour.
  registerCron('*/5 * * * *', withJobLock('drug-chart-missing-sla', async () => {
    await runForEachTenant('drug-chart-missing-sla', () => runMissingDrugChartSweep());
  }));

  // 🔄 Every 5 minutes - Retry failed push/SMS notifications (exponential backoff)
  registerCron('*/5 * * * *', withJobLock('retry-failed-notifications', retryFailedNotifications));

  // 📤 Every 2 minutes - drain the notification outbox (audit C-6). Claims due
  // PENDING/FAILED rows via FOR UPDATE SKIP LOCKED, delivers via the real send
  // path, marks SENT/FAILED with backoff. Cross-process-safe via withJobLock's
  // advisory lock + the SKIP LOCKED claim. Without this the durable-retry
  // guarantee for breach/critical-lab/escalation notices was inert.
  registerCron('*/2 * * * *', withJobLock('notification-outbox-drain', async () => {
    await runForEachTenant('notification-outbox-drain', tenantId => (
      drainNotificationOutbox({ tenantId, limit: 100 })
    ));
  }));

  registerCron('*/5 * * * *', withJobLock('biomed-cmms-maintenance-sweep', async () => {
    const result = await runForEachTenant('biomed-cmms-maintenance-sweep', (tenantId) =>
      runBiomedCmmsMaintenanceSweep({ tenantId })
    );
    logger.info('biomed-cmms-maintenance-sweep complete', result);
  }));

  // 📨 Every 2 minutes - drain the event_outbox. publishEvent() writes
  // event_outbox rows from ~40 producers but nothing drained them (the delivery
  // bridge was half-built), so rows sat at status='pending' forever. The drain
  // leases due rows via FOR UPDATE SKIP LOCKED, performs set-based idempotent
  // subscription fan-out, and marks the source delivered in the same tenant
  // transaction (including when no subscription matches). Failures back off or
  // dead-letter at the cap. The separate webhook-delivery-dispatch cron then
  // leases, signs and POSTs the enqueued deliveries.
  registerCron('*/2 * * * *', withJobLock('event-outbox-drain', async () => {
    await drainEventOutbox({ limit: 100 });
  }));

  registerCron('*/5 * * * *', withJobLock('event-outbox-stale-lease-reaper', async () => {
    const result = await reapStaleProcessingEvents({ limit: 200 });
    if (result.reaped) {
      logger.warn(`Scheduled Task: reaped ${result.reaped} stale event-outbox leases`);
    }
  }));

  // Every 2 minutes — default-off S1a shadow projector. The implementation is
  // loaded only when explicitly enabled so the scheduler's eager module graph
  // and existing partial-module test mocks remain unchanged.
  registerCron('*/2 * * * *', withJobLock('pathway-projector-shadow', async () => {
    if (!isPathwayProjectorShadowEnabled()) return;
    const { runPathwayProjectorShadowTick } = await import('../services/events/pathwayProjectorService.js');
    await runPathwayProjectorShadowTick();
  }));

  // Reuse the existing two-minute pathway cadence to detect normal diagnostic
  // generations that became patient-visible after their release delay. The
  // command re-evaluates the authoritative portal predicate under the
  // generation lock. Until production activation authority is shipped it is
  // inert for off/shadow tenants and reports active tenants as evidence-blocked.
  registerCron('*/2 * * * *', withJobLock('diagnostic-normal-release-sweep', async () => {
    const { runDiagnosticNormalReleaseSweep } = await import(
      '../services/diagnostics/diagnosticNormalReleaseSweepService.js'
    );
    const result = await runForEachTenant(
      'diagnostic-normal-release-sweep',
      (tenantId) => runDiagnosticNormalReleaseSweep({ tenantId }),
    );
    logger.info('diagnostic-normal-release-sweep complete', result);
  }));

  // Queue a single generic, PHI-free result-ready intent for each current
  // structured Radiology/AP generation only after the portal visibility rule
  // passes. This remains inert unless both the Diagnostics pathway is active
  // and the tenant explicitly enables diagnostic_result_notifications.
  registerCron('*/2 * * * *', withJobLock('diagnostic-result-patient-notification', async () => {
    const { runStructuredDiagnosticPatientNotificationSweep } = await import(
      '../services/diagnostics/diagnosticResultPatientNotificationService.js'
    );
    const result = await runForEachTenant(
      'diagnostic-result-patient-notification',
      (tenantId) => runStructuredDiagnosticPatientNotificationSweep({ tenantId }),
    );
    logger.info('diagnostic-result-patient-notification complete', result);
  }));

  // Every 5 minutes — reclaim expired S1a inbox leases. This is separately
  // locked from the shadow tick and remains inert under the default-off flag.
  registerCron('*/5 * * * *', withJobLock('pathway-projector-stale-lease-reaper', async () => {
    if (!isPathwayProjectorShadowEnabled()) return;
    const { reapStaleInboxLeases } = await import('../services/events/pathwayProjectorService.js');
    await reapStaleInboxLeases();
  }));

  // Default-off S1b-c3 pathway reconciliation. The outer job lock reduces
  // duplicate fleet work; the service retains a tenant/pathway transaction
  // fence because this lock intentionally fails open during DB connectivity
  // degradation. This job observes and appends evidence only.
  registerCron(pathwayReconciliationCron(), withJobLock('care-pathway-reconciliation', async () => {
    if (!isPathwayReconciliationEnabled()) return;
    const { runCarePathwayReconciliationSweep } = await import(
      '../services/pathways/pathwayReconciliationService.js'
    );
    await runCarePathwayReconciliationSweep();
  }));

  // 🚨 Every 10 minutes - escalate unread critical notifications so safety
  // alerts cannot remain invisible without an auditable event.
  registerCron('*/10 * * * *', withJobLock('unread-critical-notification-escalation', async () => {
    await runForEachTenant('unread-critical-notification-escalation', () => runUnreadCriticalEscalation());
  }));

  // ⚠️ Every 30 minutes - Escalate stuck orders (appointments, pharmacy, investigations)
  registerCron('*/30 * * * *', withJobLock('escalate-stuck-orders', () => runForEachTenant('escalate-stuck-orders', () => escalateStuckOrders())));

  // Operational forecast alert sweep — advisory, flag-gated. Mirrors the
  // every-30-min cadence of escalate-stuck-orders. Default tenant today; wrap
  // in runWithSuperAdmin for cross-tenant fan-out when multi-tenant.
  if (String(process.env.CLINICAL_AI_OPERATIONAL_ALERTS_ENABLED || '').toLowerCase() === 'true') {
    registerCron('*/30 * * * *', withJobLock('operational-alert-sweep', async () => {
      const r = await runForEachTenant('operational-alert-sweep', () => runSweep({}));
      logger.info('operational-alert-sweep complete', r);
    }));
  }

  // Revenue-cycle tracker sweep — flag-gated. Projects PA→appeal spine into
  // revenue_cycle_runs standing queue every 5 minutes. Advisory/read-model
  // only; never auto-submits or generates drafts. Fans out over ALL tenants
  // (audit §3) — runs under the withJobLock super-admin context, each tenant
  // fault-isolated so one tenant's failure can't abort the others.
  if (String(process.env.REVENUE_CYCLE_TRACKER_ENABLED || '').toLowerCase() === 'true') {
    registerCron('*/5 * * * *', withJobLock('revenue-cycle-tracker-sweep', async () => {
      const r = await runRevenueCycleSweepAllTenants();
      logger.info('revenue-cycle-tracker-sweep complete', r);
    }));
  }

  // Nightly clinical-coding suggestion batch — flag-gated, OFF by default.
  // Double-gated: this env flag AND the clinical_coding_assist module (which
  // ships disabled) must both be enabled before any suggestion is generated.
  // Suggestions only ever land as PENDING clinical_ai_reviews items for the
  // coding team — nothing is auto-applied to claims or the record. Per-tenant
  // fan-out with fault isolation; lazy import keeps the AI workflow graph out
  // of the scheduler's boot path when the flag is off.
  if (String(process.env.CLINICAL_AI_CODING_BATCH_ENABLED || '').toLowerCase() === 'true') {
    registerCron('45 1 * * *', withJobLock('coding-suggestion-batch', async () => {
      const { runCodingSuggestionBatch } = await import('../services/ai/codingBatchSuggestionService.js');
      const r = await runForEachTenant('coding-suggestion-batch', (tenantId) =>
        runCodingSuggestionBatch({ tenantId, source: 'scheduled' }));
      logger.info('coding-suggestion-batch complete', r);
    }));
  }

  // 🖨️ Every 15 minutes - regenerate per-ward downtime packs (roadmap A3).
  //
  // REMOVED in-process registration (audit C-5). A dedicated k8s CronJob owns
  // ward-downtime-pack regeneration (see infra/kubernetes/ + the manifest that
  // runs `generateWardDowntimePacks` on a schedule, docs/DOWNTIME_PROCEDURE.md).
  // The packs must already exist when an outage starts — never generated on
  // demand — but regeneration must run exactly once per tick, not once per
  // worker×replica. The CronJob is authoritative.

  // 🔎 Every 5 minutes — observe whether ward downtime packs actually EXIST.
  //
  // The CronJob above can succeed having produced nothing (its sweep is gated;
  // see services/downtime/wardDowntimePackOutputProbe.js), so its exit code is
  // not evidence that a ward has a pack to print. This probe measures the
  // output itself and publishes it for the WardDowntimePacksMissing rule. It
  // is read-only and runs on every replica on purpose — see
  // withReplicaLocalJobGuard.
  registerCron('*/5 * * * *', withReplicaLocalJobGuard('ward-downtime-pack-output-probe', async () => {
    const { observeWardDowntimePackOutput } = await import(
      '../services/downtime/wardDowntimePackOutputProbe.js'
    );
    await observeWardDowntimePackOutput();
  }));

  // 📡 Every 2 minutes — claim one owner-authorized outbound HL7v2 message
  // per tenant/subscription. A transport response alone never completes the
  // message; only a parsed, control-ID-correlated MSA|AA can advance delivery.
  registerCron('*/2 * * * *', withJobLock('hl7-outbound-feeds', async () => {
    await runForEachTenant('hl7-outbound-feeds', tenantId => (
      deliverPendingFeedMessages({ tenantId, limit: 50 })
    ));
  }));

  // 📅 Every 10 minutes — waitlist auto-fill sweep (roadmap D2): freed
  // capacity for today/tomorrow is offered to waiting patients
  // priority-then-FIFO.
  registerCron('*/10 * * * *', withJobLock('waitlist-auto-fill', async () => {
    await sweepWaitlists();
  }));

  // 🪪 Daily at 06:30 — credential expiry radar (roadmap D3): surfaces
  // registrations/privileges expiring within 30 days. NABH wants the trail.
  registerCron('30 6 * * *', withJobLock('credential-expiry-radar', async () => {
    await expiryRadarSweep();
  }));

  // 🪦 Every 15 minutes — A8 visit-status reaper. The service performs one
  // cross-tenant super-admin sweep: OFF/SHADOW retain legacy MISSED
  // bookkeeping, while ACTIVE appointments are left for the governed
  // lifecycle and surfaced through pathway reconciliation.
  registerCron('*/15 * * * *', withJobLock('reap-stale-visits', async () => {
    await reapStaleScheduledVisits();
  }));

  // A missed linked appointment or an explicitly configured referral expiry
  // becomes named human work. The sweep does not invent a clinical disposition
  // or close the referral; it materializes one idempotent owner task for review.
  registerCron('*/15 * * * *', withJobLock('referral-recovery-sweep', async () => {
    const { runReferralRecoverySweep } = await import(
      '../services/referral/referralRecoverySweepService.js'
    );
    await runForEachTenant(
      'referral-recovery-sweep',
      (tenantId) => runReferralRecoverySweep({ tenantId }),
    );
  }));

  // 🩺 Every 15 minutes — ABDM stuck-data-request sweep (BE-M7 backstop).
  // A consent-bound HIE request whose in-process pipeline died (restart, or
  // the FAILED-marker write itself failed) otherwise stays 'PROCESSING'
  // forever with no signal. The sweep marks stale rows FAILED and logs
  // loudly; rows claimed by the I16 recovery workbench are excluded.
  registerCron('*/15 * * * *', withJobLock('abdm-stuck-data-request-sweep', async () => {
    const { default: abdmService } = await import('../services/abdm/abdmService.js');
    const result = await abdmService.sweepStuckDataRequests();
    if (result.scanned > 0) {
      logger.warn('abdm-stuck-data-request-sweep complete', result);
    }
  }));

  // 🛏️ Every hour — D1 bed-inspection sweeper. Marks pending bed
  // inspections that have outlived their expires_at as 'expired' so
  // the receptionist UI doesn't keep showing stale shortlists.
  registerCron('0 * * * *', withJobLock('expire-bed-inspections', async () => {
    await expireStaleInspections();
  }));

  // 🧹 Every 10 minutes — bed-cleaning dispatch retry. Discharge/transfer
  // start the bed-keyed cleaning SLA in-tx, but the housekeeping_requests
  // work item is dispatched post-commit best-effort; this sweep re-dispatches
  // for any 'cleaning' bed with no active request (idempotent — the dispatch
  // dedupes against existing active requests).
  registerCron('*/10 * * * *', withJobLock('bed-cleaning-dispatch-sweep', async () => {
    const { sweepMissingBedCleaningDispatches } = await import(
      '../services/staff/housekeepingTaskDispatchService.js'
    );
    await runForEachTenant(
      'bed-cleaning-dispatch-sweep',
      async (tenantId) => {
        const result = await sweepMissingBedCleaningDispatches({ tenantId });
        if (result.scanned > 0) {
          logger.info('bed-cleaning-dispatch-sweep re-dispatched missing tickets', { tenantId, ...result });
        }
      },
    );
  }));

  // 🛟 Every 5 minutes — PHI-access break-glass expiry sweeper (CareTeam ABAC
  // §5). Flips active overrides whose expires_at has passed to 'expired' and
  // records the transition in status history. Audit-cleanliness only: the ABAC
  // engine already ignores time-expired rows, so this never changes an access
  // decision. Runs cross-tenant under runWithSuperAdmin (withJobLock wrapper).
  registerCron('*/5 * * * *', withJobLock('expire-break-glass', async () => {
    await sweepExpiredBreakGlass();
  }));

  // 🔐 Hourly — verify the tamper-evident audit hash chain (platform audit
  // 2026-06-18 §3). Recomputes clinical_audit_events' per-tenant chain
  // (migration 282) for every active tenant and fires a LOUD alert (error log +
  // sendSecurityWebhook) on any broken link. Cross-process-safe via withJobLock
  // (advisory lock) + runs under runWithSuperAdmin so RLS lets it read every
  // tenant. Append-only triggers (migration 324) make undetected tampering by
  // the app role impossible in the first place; this is the detection backstop
  // for any out-of-band (e.g. superuser/DBA) tamper.
  registerCron('0 * * * *', withJobLock('audit-chain-verify', async () => {
    const r = await runAuditChainVerification();
    logger.info('audit-chain-verify sweep complete', r);
  }));

  // 🚑 Every 2 minutes — results-inbox escalation engine
  // (RESULTS_INBOX_ESCALATION_DESIGN §4.4). Marks tasks overdue, evaluates
  // active escalation_rules against breached critical-result SLA instances and
  // fires tiered actions once each (re-notify → duty role → leadership +
  // security webhook), and backfills any breached SLA instance that lost its
  // task. Runs cross-tenant under runWithSuperAdmin (withJobLock wrapper); each
  // tenant's writes re-scope via setTenantTx.
  registerCron('*/2 * * * *', withJobLock('results-inbox-escalation', async () => {
    await runEscalationSweep({});
  }));

  // 🗓️ Daily at 09:00 - Send in-app investigation report notifications
  registerCron('0 9 * * *', withJobLock('investigation-notifications', () => runForEachTenant('investigation-notifications', () => sendInvestigationNotifications())));

  // 🗓️ Friday 17:00 by default — next week's roster deadline.
  // Override with ROSTER_NEXT_WEEK_DEADLINE_CRON plus the weekday/hour envs used
  // by the service when hospitals pick a different cutoff.
  registerCron(
    process.env.ROSTER_NEXT_WEEK_DEADLINE_CRON || '0 17 * * 5',
    withJobLock('roster-deadline-escalation', async () => {
      await runForEachTenant('roster-deadline-escalation', () => runRosterDeadlineEscalation({ force: true }));
    }),
    { timezone: process.env.APP_TIMEZONE || process.env.TZ || 'Asia/Kolkata' }
  );

  // 🗓️ Daily at 03:30 - Apply tenant retention policies to all five audit sinks.
  // The service fails closed unless an active policy explicitly selects erase
  // and does not require an unimplemented archive/legal-hold decision.
  registerCron('30 3 * * *', withJobLock('purge-audit-logs', async () => {
    logger.info('Scheduled Task: Evaluating per-tenant audit retention policies...');
    const fanout = await runForEachTenant('audit-retention', async (tenantId) => {
      const result = await purgeAuditEvidenceForTenant({ tenantId });
      logger.info('Audit retention tenant sweep complete', {
        tenant_id: tenantId,
        deleted_total: result.deleted_total,
        sinks: result.sinks.map((sink) => ({
          table: sink.table,
          decision: sink.decision,
          reason: sink.reason,
          deleted: sink.deleted,
        })),
      });
    });
    logger.info('Audit retention fan-out complete', fanout);
  }));

  // Daily at 03:32 - Purge staff messages older than the configured retention
  // window. Default is 30 days.
  registerCron('32 3 * * *', withJobLock('purge-staff-messages', async () => {
    await purgeExpiredStaffMessages();
  }));

  // 🗓️ Daily at 03:38 - Purge expired clinical note drafts (autosave scratch
  // past its 14-day TTL). Drafts carry no canonical-record meaning, so this is a
  // pure cleanup. Cross-tenant under runWithSuperAdmin (withJobLock wrapper).
  registerCron('38 3 * * *', withJobLock('purge-expired-note-drafts', async () => {
    logger.info('Scheduled Task: Purging expired clinical note drafts...');
    const removed = await purgeExpiredNoteDrafts();
    logger.info(`Note-drafts cleanup: ${removed} expired draft(s) deleted`);
  }));

  // 🗓️ Daily at 03:35 - Purge expired token blacklist entries
  registerCron('35 3 * * *', withJobLock('purge-invalidated-tokens', async () => {
    logger.info('Scheduled Task: Purging expired invalidated tokens...');
    const result = await prisma.$queryRawUnsafe(
      `DELETE FROM invalidated_tokens WHERE expires_at < NOW()`
    );
    logger.info(`Invalidated tokens cleanup: ${Number(result) || 0} rows deleted`);
  }));

  // 🗓️ Daily at 03:40 - Purge expired OTP sessions
  registerCron('40 3 * * *', withJobLock('purge-expired-otps', async () => {
    logger.info('Scheduled Task: Purging expired OTP sessions...');
    const result = await prisma.$queryRawUnsafe(
      `DELETE FROM otp_sessions WHERE expires_at < NOW() - INTERVAL '1 day'`
    );
    logger.info(`Expired OTP cleanup: ${Number(result) || 0} rows deleted`);
  }));

  // 🗓️ Daily at 03:45 - Purge file deletion log entries older than 90 days
  registerCron('45 3 * * *', withJobLock('purge-file-deletion-log', async () => {
    logger.info('Scheduled Task: Purging file_deletion_log entries older than 90 days...');
    const result = await prisma.$queryRawUnsafe(
      `DELETE FROM file_deletion_log WHERE deleted_at < NOW() - INTERVAL '90 days'`
    );
    logger.info(`File deletion log cleanup: ${Number(result) || 0} rows deleted`);
  }));

  // 🗓️ Daily at 03:50 - Purge housekeeping photos past retention window
  registerCron('50 3 * * *', withJobLock('purge-housekeeping-photos', purgeHousekeepingPhotos));

  // 🗓️ Daily at 03:52 - Purge expired ambient audio encounters + sibling tables.
  // Covers three tables that each carry a `retention_until DATE` column:
  //   • clinical_ambient_encounters  (migration 027, 30-day default)
  //   • clinical_voice_notes          (migration 016, 30-day default)
  //   • clinical_nursing_ambient_sessions (migration 042, 365-day default)
  // Safe to run cross-tenant: GUC unset → tenant_isolation policy permissive
  // branch. Only deletes rows where retention_until < CURRENT_DATE.
  registerCron('52 3 * * *', withJobLock('purge-expired-ambient-audio', async () => {
    logger.info('Scheduled Task: Purging expired ambient audio records...');
    const counts = await purgeExpiredAmbientAudio();
    logger.info(
      `Ambient audio cleanup: ${counts.ambientEncounters} encounter(s), ` +
      `${counts.voiceNotes} voice note(s), ` +
      `${counts.nursingAmbientSessions} nursing ambient session(s) deleted`,
    );
  }));

  // Every 5 minutes - Canary health check (synthetic tests against critical paths)
  //
  // REMOVED in-process registration (audit C-5). A dedicated k8s CronJob owns
  // the canary synthetic checks (see infra/kubernetes/ canary CronJob manifest)
  // so they run exactly once per tick fleet-wide instead of once per
  // worker×replica. `runCanaryChecks` is the shared entrypoint the CronJob
  // invokes.

  // Every 30 seconds — admin:kpi aggregator tick. Short cadence is safe because
  // tickAdminKpi runs two indexed count queries and emits over WebSocket only.
  // withJobLock guarantees no overlap if a tick ever backs up.
  registerCron('*/30 * * * * *', withJobLock('admin-kpi-tick', tickAdminKpi));
  // Every 60s — daily-ops snapshot push (per-tenant). withJobLock = one runner across processes.
  registerCron('0 * * * * *', withJobLock('daily-ops-tick', tickDailyOps));
  // Every 60s — teleconsult ops snapshot push (per-tenant, non-PHI telemetry).
  registerCron('15 * * * * *', withJobLock('teleconsult-ops-tick', tickTeleconsultOps));

  // Every 30 seconds — clinical-AI workflow resume scheduler (Phase 5 of
  // the rollout, docs/CLINICAL_AI_ROLLOUT_PLAN.md). Polls
  // clinical_ai_workflow_runs for status='paused' rows whose external
  // gate has fired (e.g. 'await_governance' → matching
  // clinical_ai_approvals.status='approved'), and calls resumeWorkflow().
  // Bounded at 25 resumes per tick to avoid runaway fan-out.
  registerCron('*/30 * * * * *', withJobLock('clinical-ai-workflow-resume', async () => {
    await runPausedWorkflowSweep({ maxResumes: 25 });
  }));

  // Every 60 seconds — prior-auth → appeal chain starter sweep (Task 6).
  // Finds denied prior-auth requests with no appeal letter / workflow run
  // and auto-starts the appeal chain for each. Bounded at 25 per tick.
  registerCron('*/60 * * * * *', withJobLock('clinical-ai-prior-auth-appeal-start', () => startPendingPriorAuthAppeals({ maxStarts: 25 })));

  // Every 30 seconds — webhook delivery dispatcher. Claims pending /
  // retryable-failed rows from webhook_deliveries via FOR UPDATE SKIP
  // LOCKED, signs + POSTs each, and writes per-attempt audit through
  // integration_logs. Bounded at 25 deliveries per tick.
  registerCron('*/30 * * * * *', withJobLock('webhook-delivery-dispatch', async () => {
    await dispatchPendingDeliveries({ batchSize: 25 });
  }));

  // Every 5 minutes — reap stale in_flight webhook deliveries (audit M10). A
  // worker crash AFTER claiming a row (status='in_flight') but BEFORE completing
  // it orphans the delivery forever (the dispatcher only re-picks pending/failed).
  // Reclaim rows whose explicit worker lease expired.
  registerCron('*/5 * * * *', withJobLock('webhook-reap-stale-inflight', async () => {
    const { reaped } = await reapStaleInFlightDeliveries({ limit: 200 });
    if (reaped) logger.warn(`Scheduled Task: reaped ${reaped} stale in_flight webhook deliveries`);
  }));

  // Every 30 seconds — NHCX outbound dispatcher. It is inert when
  // NHCX_ENABLED=false, and otherwise claims pending/retryable NHCX exchange
  // envelopes with SKIP LOCKED before encrypting and POSTing to the gateway.
  registerCron('*/30 * * * * *', withJobLock('nhcx-outbound-dispatch', async () => {
    await dispatchPendingNHCXMessages({ batchSize: 25 });
  }));

  // Every 5 minutes — recover NHCX rows left in the transient sent state after
  // a worker crash between claim and terminal status write.
  registerCron('*/5 * * * *', withJobLock('nhcx-reap-stale-sent', async () => {
    const { reaped } = await reapStaleNHCXDispatches({ staleMinutes: 15 });
    if (reaped) logger.warn(`Scheduled Task: reaped ${reaped} stale NHCX outbound dispatches`);
  }));

  // Schema drift detection — once at startup
  setImmediate(async () => {
    try { await detectSchemaDrift(); } catch (e) { logger.warn('Schema drift check failed:', e.message); }
  });

  // Prime the KPI channel once on startup so first subscribers get a snapshot
  // without waiting up to 30s for the next cron tick.
  setImmediate(async () => {
    try { await tickAdminKpi(); } catch (e) { logger.warn('Initial admin:kpi tick failed:', e.message); }
    try { await tickDailyOps(); } catch (e) { logger.warn('Initial daily-ops tick failed:', e.message); }
    try { await tickTeleconsultOps(); } catch (e) { logger.warn('Initial teleconsult-ops tick failed:', e.message); }
  });
}

// ✅ Manual Trigger for all tasks.
//
// Boot-time gating (audit C-6/§4 "runAllScheduledTasksNow fire-and-forget on
// every worker boot → SMS/backup stampede on deploy"):
//
//   • bin/www.js calls this on EVERY worker boot. With 6 processes that meant
//     6× immediate runs of heavy MUTATING jobs (appointment SMS reminders,
//     timed reminders, escalations) on every deploy — a patient-SMS stampede.
//   • Each mutating call is now wrapped in withDbAdvisoryLock under a STABLE
//     job name, so even if every process enters this function on boot, exactly
//     one acquires each job's fleet-wide lock and the rest skip. The lock names
//     intentionally match the cron job names so a boot run and a concurrent
//     cron tick also dedupe against each other.
//   • The whole heavy block is ALSO opt-in via RUN_STARTUP_TASKS (default off):
//     in normal cluster operation the registered crons already cover these on
//     their schedules, so firing them again at boot is redundant. Set
//     RUN_STARTUP_TASKS=true only for single-process/manual invocations
//     (e.g. `npm run scheduler:run-now`) where you want an immediate sweep.
//
// Cheap, idempotent housekeeping (log/swagger validation) always runs; the
// outbox drain always runs (idempotent + advisory-locked) so a manual call
// flushes anything queued.
export async function runAllScheduledTasksNow() {
  const runStartupTasks = String(process.env.RUN_STARTUP_TASKS || '').toLowerCase() === 'true';
  logger.info(
    `Running scheduled tasks manually (RUN_STARTUP_TASKS=${runStartupTasks ? 'on' : 'off'})...`,
  );
  try {
    // Cheap, idempotent, non-fan-out housekeeping — safe on every boot.
    await purgeLogs();
    await purgeArchives();

    const swaggerDocument = loadSwaggerDocument();
    if (!swaggerDocument) {throw new Error('Swagger document not loaded');}
    logger.info('✅ Swagger documentation validated.');

    // Always drain the outboxes once on boot — idempotent + advisory-locked, so
    // only one process across the fleet actually flushes each batch.
    await withDbAdvisoryLock('notification-outbox-drain', () => runWithSuperAdmin(() => (
      runForEachTenant('notification-outbox-drain', tenantId => (
        drainNotificationOutbox({ tenantId, limit: 100 })
      ))
    )));
    await withDbAdvisoryLock('event-outbox-drain', () => drainEventOutbox({ limit: 100 }));

    if (!runStartupTasks) {
      logger.info('Skipping heavy startup sweeps (RUN_STARTUP_TASKS not set). Registered crons own these.');
      return;
    }

    // NB: database backup is NOT triggered here — it is owned by a dedicated
    // k8s CronJob (audit C-5). Triggering it from every worker boot caused a
    // pg_dump stampede on deploy.
    await withDbAdvisoryLock('startup-r2-cleanup', () => executeCleanup());
    await withDbAdvisoryLock('cleanup-backups', async () => {
      await cleanupBackups(path.resolve('backups', 'local'));
      await cleanupBackups(path.resolve('backups', 'render'));
    });

    // Heavy MUTATING / fan-out jobs — each fleet-wide single-runner via the
    // advisory lock so a boot stampede can't multiply patient SMS / escalations.
    await withDbAdvisoryLock('send-appointment-reminders', () => runWithSuperAdmin(sendAppointmentReminders));
    await withDbAdvisoryLock('timed-reminders', () => runWithSuperAdmin(sendTimedReminders));
    await withDbAdvisoryLock('process-scheduled-notifications', () => runWithSuperAdmin(processPendingScheduledNotifications));
    await withDbAdvisoryLock('drug-chart-missing-sla', () => runWithSuperAdmin(runMissingDrugChartSweep));
    await withDbAdvisoryLock('unread-critical-notification-escalation', () => runWithSuperAdmin(runUnreadCriticalEscalation));
    await withDbAdvisoryLock('purge-staff-messages', () => runWithSuperAdmin(purgeExpiredStaffMessages));
    await withDbAdvisoryLock('investigation-notifications', () => runWithSuperAdmin(sendInvestigationNotifications));
    await withDbAdvisoryLock('roster-deadline-escalation', () => runWithSuperAdmin(() => runRosterDeadlineEscalation({ force: true })));
    await withDbAdvisoryLock('expire-break-glass', () => runWithSuperAdmin(sweepExpiredBreakGlass));
    await withDbAdvisoryLock('results-inbox-escalation', () => runWithSuperAdmin(() => runEscalationSweep({})));

    // Purge file deletion log entries older than 90 days
    await withDbAdvisoryLock('purge-file-deletion-log', () => runWithSuperAdmin(async () => {
      const fileDeletionResult = await prisma.$queryRawUnsafe(
        `DELETE FROM file_deletion_log WHERE deleted_at < NOW() - INTERVAL '90 days'`
      );
      logger.info(`File deletion log cleanup: ${Number(fileDeletionResult) || 0} rows deleted`);
    }));

    logger.info('✅ All manual tasks completed.');
  } catch (err) {
    logger.error('Error running manual tasks:', err.message || err);
  }
}

if (process.env.NODE_ENV !== 'test') {
  // ─── Payroll Crons ───────────────────────────────────────────────────────────

  // 🗓️ Monthly on 1st at 06:00 — Auto-generate payroll for previous month
  registerCron('0 6 1 * *', withJobLock('monthly-payroll', async () => {
    logger.info('Scheduled Task: Monthly payroll generation...');
    const now = new Date();
    let month = now.getMonth(); // 0-based = last month
    let year = now.getFullYear();
    if (month === 0) { month = 12; year--; }

    const {
      calculatePayslip,
      savePayslip,
      recordPayrollFailure,
      summarizePayrollRunOutcome,
    } = await import('../services/staff/payrollService.js');

    // Check if already done
    const existing = await prisma.$queryRawUnsafe(
      'SELECT id, status FROM payroll_runs WHERE month=$1 AND year=$2',
      month, year
    );
    if (existing.length > 0 && existing[0].status === 'completed') {
      logger.info(`Payroll for ${month}/${year} already completed`);
      return;
    }

    // Get all active staff with salary config
    const staffList = await prisma.$queryRawUnsafe(`
      SELECT ss.staff_uid, u.name, u.role,
             COALESCE(s.department, ss.department) as department
      FROM staff_salary ss
      JOIN users u ON ss.staff_uid = u.uid
      LEFT JOIN staff s ON s.user_id = u.uid
      WHERE ss.is_active = true
    `);

    // Create / reset run
    const run = await prisma.$queryRawUnsafe(
      // Clear the previous attempt's failure tally when re-running, so a run
      // that dies before finalizing cannot leave a stale count on display.
      `INSERT INTO payroll_runs (month, year, status)
       VALUES ($1, $2, 'processing')
       ON CONFLICT (tenant_id, month, year) DO UPDATE
         SET status='processing', failed_staff_count=0, failed_staff=NULL
       RETURNING id, month, year, status, total_staff, total_gross, total_net, total_deductions, created_at`,
      month, year
    );
    const runId = run[0].id;

    let processed = 0;
    const failures = [];
    let totalGross = 0, totalNet = 0, totalDeductions = 0;
    for (const staff of staffList) {
      try {
        const calc = await calculatePayslip(staff.staff_uid, month, year);
        await savePayslip(runId, calc);
        totalGross += parseFloat(calc.gross_salary) || 0;
        totalNet += parseFloat(calc.net_salary) || 0;
        totalDeductions += parseFloat(calc.total_deductions) || 0;
        processed++;
      } catch (e) {
        // One staff member's failure must not abort the others, but it must
        // survive into the run record — an unpaid person is not a zero-paid one.
        logger.error(`Payroll calc failed for ${staff.staff_uid}: ${e.message}`);
        recordPayrollFailure(failures, staff.staff_uid, e);
      }
    }

    const outcome = summarizePayrollRunOutcome({
      processed, failures, totalGross, totalNet, totalDeductions,
    });
    await prisma.$queryRawUnsafe(
      `UPDATE payroll_runs
          SET status=$1, total_staff=$2, total_gross=$3, total_net=$4,
              total_deductions=$5, failed_staff_count=$6, failed_staff=$7::jsonb
        WHERE id=$8`,
      outcome.status, outcome.total_staff, outcome.total_gross, outcome.total_net,
      outcome.total_deductions, outcome.failed_staff_count,
      JSON.stringify(outcome.failed_staff),
      runId
    );
    if (outcome.failed_staff_count > 0) {
      logger.error(
        `Monthly payroll ${month}/${year} completed WITH ERRORS: ${processed} payslips written, ` +
        `${outcome.failed_staff_count} staff failed — those staff have no payslip for this period`
      );
    } else {
      logger.info(`Monthly payroll generated: ${processed} payslips for ${month}/${year}`);
    }
  }));

  // 🗓️ Weekly Monday 02:30 — ClinicalTrials.gov catalog sync for every active tenant
  registerCron('30 2 * * 1', withJobLock('trial-catalog-sync', async () => {
    logger.info('Scheduled Task: Clinical trial catalog sync (weekly)');
    const { syncTrialsFromPublicRegistry } = await import('../services/ai/trialCatalogSyncService.js');
    const tenants = await prisma.$queryRawUnsafe(
      `SELECT id, region FROM tenants WHERE status = 'active'`
    ).catch(() => []);
    let total = 0;
    for (const tenant of tenants) {
      try {
        const result = await syncTrialsFromPublicRegistry({
          tenantId: tenant.id,
          tenantRegion: tenant.region || 'IN',
          maxResults: 100,
        });
        logger.info(`Trial sync for tenant ${tenant.id}: ${result.upserted_count} upserts, status=${result.status}`);
        total += result.upserted_count;
      } catch (err) {
        logger.warn(`Trial sync failed for tenant ${tenant.id}: ${err.message}`);
      }
    }
    logger.info(`Weekly trial sync complete. Total upserts: ${total}`);
  }));

  // 🗓️ Weekly Monday 03:15 — clinical-AI knowledge corpus refresh (WS5 B5.5).
  // Re-imports the formulary / antibiogram / protocol corpus for every active
  // tenant that has set up the matching KBs. The antibiogram especially is a
  // rolling 90-day window, so a weekly cadence keeps the curated susceptibility
  // summaries current. Imported docs land curation_status='pending' (dark to
  // retrieval) until a human signs them off — the refresh never auto-approves.
  // Idempotent: unchanged source rows dedup on file_hash and are skipped.
  registerCron(
    process.env.KNOWLEDGE_CORPUS_REFRESH_CRON || '15 3 * * 1',
    withJobLock('knowledge-corpus-refresh', async () => {
      logger.info('Scheduled Task: Clinical-AI knowledge corpus refresh (weekly)');
      const { importSource } = await import('../services/ai/knowledgeCurationService.js');
      const { runInTenantContext } = await import('../lib/tenantContext.js');
      const tenants = await prisma.$queryRawUnsafe(
        `SELECT id FROM tenants WHERE status = 'active'`,
      ).catch(() => []);
      const KB_TYPE_FOR_SOURCE = {
        formulary: 'formulary',
        antibiogram: 'antibiotic_policy',
        protocols: 'clinical_guideline',
      };
      let tenantsRefreshed = 0;
      let totalInserted = 0;
      for (const tenant of tenants) {
        try {
          // Discover the tenant's active KB per source (skip sources with none).
          const kbIds = {};
          await runInTenantContext(tenant.id, async () => {
            for (const [src, kbType] of Object.entries(KB_TYPE_FOR_SOURCE)) {
              const rows = await prisma.$queryRawUnsafe(
                `SELECT id FROM knowledge_bases
                 WHERE tenant_id = $1::uuid AND kb_type = $2 AND status = 'active'
                 ORDER BY updated_at DESC LIMIT 1`,
                tenant.id, kbType,
              ).catch(() => []);
              if (rows[0]) kbIds[src] = rows[0].id;
            }
          });
          if (!Object.keys(kbIds).length) continue;

          let tenantInserted = 0;
          for (const src of Object.keys(kbIds)) {
            const result = await importSource({
              tenantId: tenant.id, source: src, kbIds, dryRun: false,
            });
            tenantInserted += result[src]?.inserted || 0;
          }
          totalInserted += tenantInserted;
          tenantsRefreshed += 1;
          logger.info(`Knowledge corpus refresh for tenant ${tenant.id}: ${tenantInserted} new doc(s) (pending sign-off)`);
        } catch (err) {
          logger.warn(`Knowledge corpus refresh failed for tenant ${tenant.id}: ${err.message}`);
        }
      }
      logger.info(`Weekly knowledge corpus refresh complete. Tenants refreshed: ${tenantsRefreshed}, new docs: ${totalInserted}`);
    }),
  );

  // 🗓️ Annual on Dec 1 at 08:00 — Annual salary review reminder
  registerCron('0 8 1 12 *', withJobLock('annual-salary-review', async () => {
    logger.info('Scheduled Task: Annual salary review reminder...');
    const year = new Date().getFullYear();
    await prisma.$queryRawUnsafe(`
      INSERT INTO annual_review_reminders (staff_uid, review_year, reminder_sent_at)
      SELECT ss.staff_uid, $1, NOW()
      FROM staff_salary ss
      WHERE ss.is_active = true
        AND ss.date_of_joining IS NOT NULL
        AND ss.date_of_joining::date <= CURRENT_DATE - INTERVAL '11 months'
      ON CONFLICT (staff_uid, review_year) DO NOTHING
    `, year);
    logger.info(`Annual review reminders created for ${year}`);
  }));
}
