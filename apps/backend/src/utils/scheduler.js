// src/utils/scheduler.js

import cron from 'node-cron';
import pg from 'pg';
import path from 'path';
import { cleanupOldBackups as cleanupBackups } from '../../admin/cleanup-backups.js';
import purgeArchives from '../../admin/purge-archives.js';
import prisma from '../lib/prisma.js';
import { runWithSuperAdmin } from '../lib/tenantContext.js';
import logger from '../logging/logger.js';

const runningJobs = new Set();

// node-cron task handles, kept so gracefulShutdown (bin/www.js) can .stop()
// every timer before prisma.$disconnect() — otherwise a tick can fire mid-
// disconnect and throw. registerCron() pushes each scheduled task here.
const scheduledTasks = [];

function registerCron(...args) {
  const task = cron.schedule(...args);
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
import purgeLogs from '../scripts/cleanup-logs.js';

// R2 Maintenance Jobs
import { retryFailedNotifications } from '../services/notificationRetryService.js';
import { runUnreadCriticalEscalation } from '../services/notification/notificationService.js';
import { executeArchiveMigration } from './archiveMigrationJob.js';

// Clinical-AI workflow resume scheduler — Phase 5 of the rollout.
import { runPausedWorkflowSweep } from '../services/ai/workflowResumeScheduler.js';

// Operational forecast alert sweep — Task 4. Advisory; flag-gated.
import { runSweep } from '../services/ai/operationalAlertService.js';

// Prior-auth → appeal chain starter sweep — Task 6. Auto-starts the chain
// for denied prior-auth requests that have no appeal letter / run yet.
import { startPendingPriorAuthAppeals } from '../services/ai/priorAuthAppealChainService.js';

// Revenue-cycle standing-queue tracker — flag-gated. Advisory tracker only.
// Per-stage auto-generation triggers are DEFERRED (human-in-loop design).
// Fans out per-tenant (audit §3): the bare runRevenueCycleSweep({}) collapsed to
// the default tenant only, so every other tenant's queue went untracked.
import { runRevenueCycleSweepAllTenants } from '../services/billing/revenueCycleTrackerService.js';
import { reconcileLedger } from '../services/billing/ledger/ledgerReconciliation.js';
import { resolveLedgerModeForTenant } from '../services/billing/ledger/ledgerAuthoritativeMode.js';

// Webhook delivery dispatcher — Phase A3 PR2 of the structural audit.
import { dispatchPendingDeliveries, enqueueDelivery, reapStaleInFlightDeliveries } from '../services/integrations/webhookDeliveryService.js';

// Event-outbox drain. publishEvent() writes event_outbox rows from ~40 producers
// but NOTHING drained them — rows sat at status='pending' forever (the delivery
// bridge was half-built). drainEventOutbox below is the missing consumer: it
// claims due rows (FOR UPDATE SKIP LOCKED) and bridges each to the webhook
// delivery pipeline via enqueueDelivery (event_outbox_id FK links the two).
import {
  claimPendingEvents,
  markDelivered as markEventDelivered,
  markFailed as markEventFailed,
} from '../services/events/eventOutboxService.js';

// Visit-status reaper — A8. Flips stale SCHEDULED appointments to MISSED.
import { reapStaleScheduledVisits } from '../services/appointment/appointmentReaperService.js';

// Staff roster deadline escalation — next week's roster must be published
// before the configured cutoff, otherwise HR gets an in-app alert.
import { runRosterDeadlineEscalation } from '../services/staff/rosterDeadlineService.js';
import { purgeExpiredStaffMessages } from '../services/messaging/staffMessageRetentionService.js';
import { purgeExpiredNoteDrafts } from '../services/emr/clinicalNoteDraftService.js';
import { purgeExpiredAmbientAudio } from '../services/ai/ambientDocumentationService.js';

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
import { sendPushNotification } from './notifications/sendPushNotification.js';
import { sendSMS } from '../services/smsService.js';

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
 * Resolve a recipient_id (stored as text — may be an integer users.id or a
 * uuid uid) to its known FCM/device tokens across the three device homes:
 * users.device_token, user_devices.fcm_token, staff_devices.device_token.
 * Returns a de-duplicated, non-empty token array (may be empty).
 */
async function resolveRecipientTokens(recipientId) {
  if (recipientId === null || recipientId === undefined || recipientId === '') return [];
  const idText = String(recipientId);
  const tokens = new Set();
  try {
    // users.device_token — match on int id OR uuid uid (text-cast for safety).
    const userRows = await prisma.$queryRawUnsafe(
      `SELECT device_token AS t FROM users
        WHERE device_token IS NOT NULL
          AND (id::text = $1 OR uid::text = $1)`,
      idText,
    );
    for (const r of userRows) if (r.t) tokens.add(r.t);
  } catch (err) {
    logger.warn('outbox-drain: users token lookup failed:', err.message);
  }
  try {
    const udRows = await prisma.$queryRawUnsafe(
      `SELECT fcm_token AS t FROM user_devices
        WHERE fcm_token IS NOT NULL AND user_uid::text = $1`,
      idText,
    );
    for (const r of udRows) if (r.t) tokens.add(r.t);
  } catch (err) {
    logger.warn('outbox-drain: user_devices token lookup failed:', err.message);
  }
  // staff_devices keys on an integer staff_id — only probe when numeric.
  if (/^\d+$/.test(idText)) {
    try {
      const sdRows = await prisma.$queryRawUnsafe(
        `SELECT device_token AS t FROM staff_devices
          WHERE device_token IS NOT NULL AND is_active = true AND staff_id = $1::int`,
        idText,
      );
      for (const r of sdRows) if (r.t) tokens.add(r.t);
    } catch (err) {
      logger.warn('outbox-drain: staff_devices token lookup failed:', err.message);
    }
  }
  return [...tokens];
}

/**
 * Drain the notification outbox: claim a batch of due PENDING/FAILED rows
 * (FOR UPDATE SKIP LOCKED), attempt delivery via the real send path, and mark
 * each row SENT or FAILED (with the existing 5-min backoff + 3-attempt cap).
 *
 * Send-path routing per row:
 *   - SMS rows  (type='sms' or only a recipient_phone)        → sendSMS
 *   - push rows (everything else, resolve device tokens)      → sendPushNotification
 * Push also fires a WebSocket delivery via userId inside sendPushNotification.
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
export async function drainNotificationOutbox({ limit = 50 } = {}) {
  const batch = await notificationOutbox.claimPendingBatch(limit);
  if (!batch.length) return { claimed: 0, sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;
  for (const row of batch) {
    const isSms = String(row.type || '').toLowerCase() === 'sms'
      || (!!row.recipient_phone && !row.recipient_id);
    try {
      if (isSms) {
        if (!row.recipient_phone) throw new Error('SMS outbox row has no recipient_phone');
        await sendSMS(row.recipient_phone, row.body || row.title || '');
      } else {
        const tokens = await resolveRecipientTokens(row.recipient_id);
        const data = row.payload && typeof row.payload === 'object' ? row.payload : {};
        if (!tokens.length && !row.recipient_id) {
          throw new Error('push outbox row has no resolvable device token or recipient_id');
        }
        // sendPushNotification handles an empty token list gracefully (WS-only
        // delivery via userId) and never throws on zero tokens, so a row with a
        // recipient_id but no live token still resolves as "sent" (WS attempt)
        // rather than looping forever.
        await sendPushNotification({
          tokens,
          title: row.title || '',
          body: row.body || '',
          data,
          userId: row.recipient_id || null,
        });
      }
      await notificationOutbox.markSent(row.id);
      sent += 1;
    } catch (err) {
      await notificationOutbox.markFailed(row.id, String(err.message || err).slice(0, 500));
      failed += 1;
      logger.warn(`outbox-drain: delivery failed for row ${row.id}:`, err.message);
    }
  }
  logger.info(`Notification outbox drain: claimed ${batch.length}, sent ${sent}, failed ${failed}`);
  return { claimed: batch.length, sent, failed };
}

/**
 * Drain the event_outbox: claim a batch of due 'pending' rows (FOR UPDATE SKIP
 * LOCKED via claimPendingEvents), bridge each to the webhook delivery pipeline,
 * and mark the row delivered or failed (with backoff / dead-letter).
 *
 * THE BRIDGE: for each claimed row we call enqueueDelivery({ tenantId, eventType,
 * payload, eventOutboxId: row.id }). enqueueDelivery finds every ACTIVE
 * webhook_subscription matching (tenant_id, event_type) and inserts one
 * webhook_deliveries row per match with its event_outbox_id FK set to row.id —
 * that FK is the durable link from the business event to its outbound deliveries.
 * The separate 'webhook-delivery-dispatch' cron then signs + POSTs those rows.
 *
 * Tenant: the cron runs under runWithSuperAdmin (GUC='bypass'), so we pass the
 * row's own tenant_id to enqueueDelivery explicitly — never relying on the GUC,
 * and never on ALLOW_DEFAULT_TENANT. A row with NO matching active subscription
 * is still a SUCCESS (matched:0, nothing to deliver) → markDelivered, so it
 * leaves the queue instead of looping forever.
 *
 * Outcome mapping per row:
 *   - enqueueDelivery resolves (incl. matched:0 / schema-unavailable) → markDelivered.
 *   - enqueueDelivery throws → markEventFailed (attempts++, backoff to 'pending',
 *     terminal 'failed' at MAX_ATTEMPTS). A backed-off row is not re-claimed
 *     before its available_at.
 *
 * Best-effort downstream: each row's bridge runs OUTSIDE any prisma.$transaction
 * (Phase-1.5 rule — a swallowed error inside a tx aborts it), and a single row's
 * failure never aborts the batch.
 *
 * Exported for tests. `enqueueImpl` is an injection seam (mirrors
 * dispatchPendingDeliveries' fetchImpl) so the failure path can be exercised
 * deterministically.
 *
 * @param {Object} [opts]
 * @param {number} [opts.limit=100] Max rows per drain tick.
 * @param {Function} [opts.enqueueImpl] Override for enqueueDelivery (tests).
 * @returns {{ claimed:number, delivered:number, failed:number, enqueued:number }}
 */
export async function drainEventOutbox({ limit = 100, enqueueImpl = enqueueDelivery } = {}) {
  const batch = await claimPendingEvents(limit);
  if (!batch.length) return { claimed: 0, delivered: 0, failed: 0, enqueued: 0 };

  let delivered = 0;
  let failed = 0;
  let enqueued = 0;
  for (const row of batch) {
    try {
      const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
      const result = await enqueueImpl({
        tenantId: row.tenant_id,
        eventType: row.event_type,
        payload,
        eventOutboxId: row.id,
      });
      enqueued += Array.isArray(result?.enqueued) ? result.enqueued.length : 0;
      await markEventDelivered(row.id);
      delivered += 1;
    } catch (err) {
      await markEventFailed(row.id, String(err?.message || err).slice(0, 1000));
      failed += 1;
      logger.warn(`event-outbox-drain: delivery failed for row ${row.id}:`, err.message);
    }
  }
  logger.info(`Event outbox drain: claimed ${batch.length}, delivered ${delivered}, failed ${failed}, deliveries enqueued ${enqueued}`);
  return { claimed: batch.length, delivered, failed, enqueued };
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
    await drainNotificationOutbox({ limit: 100 });
  }));

  // 📨 Every 2 minutes - drain the event_outbox. publishEvent() writes
  // event_outbox rows from ~40 producers but nothing drained them (the delivery
  // bridge was half-built), so rows sat at status='pending' forever. The drain
  // claims due rows via FOR UPDATE SKIP LOCKED and bridges each to the webhook
  // delivery pipeline (enqueueDelivery → webhook_deliveries.event_outbox_id),
  // marking the row delivered (incl. when no subscription matches) or failed
  // with backoff/dead-letter. Cross-process-safe via withJobLock's advisory
  // lock + the SKIP LOCKED claim. The separate webhook-delivery-dispatch cron
  // then signs + POSTs the enqueued deliveries.
  registerCron('*/2 * * * *', withJobLock('event-outbox-drain', async () => {
    await drainEventOutbox({ limit: 100 });
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

  // 🖨️ Every 15 minutes - regenerate per-ward downtime packs (roadmap A3).
  //
  // REMOVED in-process registration (audit C-5). A dedicated k8s CronJob owns
  // ward-downtime-pack regeneration (see infra/kubernetes/ + the manifest that
  // runs `generateWardDowntimePacks` on a schedule, docs/DOWNTIME_PROCEDURE.md).
  // The packs must already exist when an outage starts — never generated on
  // demand — but regeneration must run exactly once per tick, not once per
  // worker×replica. The CronJob is authoritative.

  // 📡 Every 2 minutes — deliver queued outbound HL7v2 feed messages
  // (roadmap C2). Per-message exponential backoff; dead after 7 attempts;
  // replay via POST /api/v1/hl7-feeds/messages/:id/replay.
  registerCron('*/2 * * * *', withJobLock('hl7-outbound-feeds', async () => {
    await deliverPendingFeedMessages({ limit: 50 });
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

  // 🪦 Every 15 minutes — A8 visit-status reaper. Flip SCHEDULED
  // appointments whose slot is more than 60 min past to MISSED, with
  // a system-attributed appointment_status_history row. Doesn't touch
  // admin_override=true rows. Default grace is 60 min; tune via the
  // service entrypoint.
  registerCron('*/15 * * * *', withJobLock('reap-stale-visits', async () => {
    await runForEachTenant('reap-stale-visits', () => reapStaleScheduledVisits());
  }));

  // 🛏️ Every hour — D1 bed-inspection sweeper. Marks pending bed
  // inspections that have outlived their expires_at as 'expired' so
  // the receptionist UI doesn't keep showing stale shortlists.
  registerCron('0 * * * *', withJobLock('expire-bed-inspections', async () => {
    await expireStaleInspections();
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

  // 🗓️ Daily at 03:30 - Purge audit logs older than 90 days
  //
  // audit_log is append-only at the DB layer (migration 324: a BEFORE
  // UPDATE OR DELETE trigger blocks the app role). This retention purge is the
  // ONE authorized deleter, so it opts into the bypass EXPLICITLY by setting the
  // transaction-local `app.audit_bypass` GUC before the DELETE. A bare
  // prisma.$queryRawUnsafe DELETE would be rejected by the trigger once the prod
  // app role is sealed NOSUPERUSER. The GUC is transaction-scoped (set_config
  // …, true) so it never leaks to other pooled queries.
  registerCron('30 3 * * *', withJobLock('purge-audit-logs', async () => {
    logger.info('Scheduled Task: Purging audit logs older than 90 days...');
    let deleted = 0;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
      deleted = await tx.$executeRawUnsafe(
        `DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '90 days'`
      );
    });
    logger.info(`Audit log cleanup: ${Number(deleted) || 0} rows deleted`);
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
  // Reset rows in_flight > 15 min back to failed+due so they re-dispatch.
  registerCron('*/5 * * * *', withJobLock('webhook-reap-stale-inflight', async () => {
    const { reaped } = await reapStaleInFlightDeliveries({ staleMinutes: 15 });
    if (reaped) logger.warn(`Scheduled Task: reaped ${reaped} stale in_flight webhook deliveries`);
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
    await withDbAdvisoryLock('notification-outbox-drain', () => drainNotificationOutbox({ limit: 100 }));
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

    const { calculatePayslip, savePayslip } = await import('../services/staff/payrollService.js');

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
      `INSERT INTO payroll_runs (month, year, status)
       VALUES ($1, $2, 'processing')
       ON CONFLICT (tenant_id, month, year) DO UPDATE SET status='processing'
       RETURNING id, month, year, status, total_staff, total_gross, total_net, total_deductions, created_at`,
      month, year
    );
    const runId = run[0].id;

    let processed = 0;
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
        logger.warn(`Payroll calc failed for ${staff.staff_uid}: ${e.message}`);
      }
    }

    await prisma.$queryRawUnsafe(
      `UPDATE payroll_runs SET status='completed', total_staff=$1, total_gross=$2, total_net=$3, total_deductions=$4 WHERE id=$5`,
      processed, totalGross.toFixed(2), totalNet.toFixed(2), totalDeductions.toFixed(2), runId
    );
    logger.info(`Monthly payroll generated: ${processed} payslips for ${month}/${year}`);
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
