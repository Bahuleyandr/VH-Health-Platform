// src/observability/reliabilityMetrics.js
// Reliability signal metrics for the event-outbox / webhook / WS-fan-out
// machinery. DB-derived gauges are refreshed by collectReliabilityMetrics()
// (a periodic in-process collector started in bin/www.js); counters increment
// inline at the event site. Appended to /metrics after the RED exporter.
//
// Status-name notes (do NOT re-guess):
//   event_outbox.status      pending|processing|delivered|failed  (failed = dead-letter @ MAX_ATTEMPTS=7)
//   webhook_deliveries.status pending|failed|dead                 (dead = terminal undelivered)
//   notification_outbox.status PENDING|SENT|FAILED                (UPPERCASE)
import prisma, { circuitBreakerStatus } from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { Gauge, Counter } from './metricPrimitives.js';

// ---- Gauges (set by the collector) ----------------------------------------
const eventOutboxPending = new Gauge('event_outbox_pending_rows', 'event_outbox rows in pending status');
const eventOutboxOldestAge = new Gauge('event_outbox_oldest_pending_age_seconds', 'Age of the oldest pending event_outbox row (seconds); 0 when none');
const eventOutboxDeadLetter = new Gauge('event_outbox_dead_letter_rows', 'event_outbox rows in the terminal failed (dead-letter) status');
const notificationOutboxPending = new Gauge('notification_outbox_pending_rows', 'notification_outbox rows in PENDING status');
const webhookPending = new Gauge('webhook_deliveries_pending_rows', 'webhook_deliveries rows in pending status');
const webhookFailed = new Gauge('webhook_deliveries_failed_rows', 'webhook_deliveries rows in failed status (retrying)');
const webhookDead = new Gauge('webhook_deliveries_dead_rows', 'webhook_deliveries rows in the terminal dead status (undelivered)');
const dbBreakerOpen = new Gauge('db_circuit_breaker_open', 'Whether any Prisma client circuit breaker is open (1=open, 0=closed)');
const dbReadReplicaLagSeconds = new Gauge('db_read_replica_lag_seconds', 'Approximate read-replica replay lag observed through prismaReadOnly (seconds); emitted only when DATABASE_READ_URL is configured');
const deviceRegistryActiveDevices = new Gauge('device_registry_active_devices', 'Active registered clinical devices');
const deviceSilentDevices = new Gauge('device_silent_devices', 'Active devices whose last_seen_at is older than three times their expected interval, or has never been seen');
const deviceVitalsUnverifiedRows = new Gauge('device_vitals_unverified_rows', 'Unverified device-originated vitals_chart rows');
const deviceAssociationsActive = new Gauge('device_associations_active', 'Active device-patient associations');
const deviceUnassociatedMessages = new Gauge('device_unassociated_messages_total', 'Device ORU messages parked as DEVICE_NOT_ASSOCIATED');
const deviceSamplesSuppressed = new Gauge('device_samples_suppressed_total', 'Device vital samples suppressed by bounded policy reason', ['reason']);

// ---- Counters (incremented inline at the event site) ----------------------
const wsBroadcastDropped = new Counter('ws_broadcast_dropped_total', 'Observable WS broadcast/sendToUser drops (per-socket backpressure or cross-process fan-out fallback). NOTE: the at-most-once Redis-failover drop is invisible to the app — see ws_fanout_subscriber_errors_total for the failover-window proxy.', ['reason']);
const wsFanoutSubscriberErrors = new Counter('ws_fanout_subscriber_errors_total', 'WS Redis fan-out subscriber error/reconnect events — the window during which a published broadcast can be silently dropped (at-most-once)', []);
const eventDeadLettered = new Counter('event_outbox_dead_lettered_total', 'event_outbox rows that crossed MAX_ATTEMPTS into the terminal failed (dead-letter) state', []);
const ledgerReconciliationDrift = new Counter('ledger_reconciliation_drift_total', 'Money-ledger reconciliation drift signals from the periodic sweep (ledger vs legacy event tables / unwired invoice / unbalanced trial balance). Hard-alerted (Sentry fatal) at enforce mode.', ['kind']);
const noteDraftJanitorDeletions = new Counter('note_draft_janitor_deletions_total', 'Clinical note_drafts rows removed by the daily TTL janitor (purgeExpiredNoteDrafts). A private-scratchpad cleanup — no canonical clinical events.', []);
const noteDraftSaveErrors = new Counter('note_draft_save_errors_total', 'Clinical note-draft (autosave) UPSERTs that failed on an UNEXPECTED error (real DB/write failure). Deliberate 400 validation rejections (AppError NOTE_DRAFT_*) are client faults and are NOT counted here.', []);

// reason is a bounded, low-cardinality label. Anything unexpected collapses to 'other'.
const WS_DROP_REASONS = new Set(['backpressure', 'fanout_local_fallback', 'publish_error']);
export function recordWsBroadcastDropped(reason) {
  wsBroadcastDropped.inc({ reason: WS_DROP_REASONS.has(reason) ? reason : 'other' });
}
export function recordWsFanoutSubscriberError() {
  wsFanoutSubscriberErrors.inc({});
}
export function recordEventDeadLettered() {
  eventDeadLettered.inc({});
}
const LEDGER_DRIFT_KINDS = new Set(['mismatch', 'unwired', 'events', 'trial_balance']);
export function recordLedgerReconciliationDrift(kind) {
  ledgerReconciliationDrift.inc({ kind: LEDGER_DRIFT_KINDS.has(kind) ? kind : 'other' });
}
// Increment by the number of drafts the daily janitor deleted (a non-negative
// count; a 0-count tick is a harmless no-op).
export function recordNoteDraftJanitorDeletions(n) {
  const count = Number(n);
  if (Number.isFinite(count) && count > 0) noteDraftJanitorDeletions.inc({}, count);
}
export function recordNoteDraftSaveError() {
  noteDraftSaveErrors.inc({});
}

function hasReadReplicaDsn() {
  return Boolean(process.env.DATABASE_READ_URL?.trim());
}

async function collectReadReplicaLagMetric() {
  if (!hasReadReplicaDsn()) return;
  try {
    // prismaReadOnly is lazy-imported so it is NOT part of this module's eager
    // import graph — this file is reached from eventOutboxService (and thus
    // most services), and a static named import breaks every test that mocks
    // ../lib/prisma.js without prismaReadOnly (the clinicalAiWorkflowService
    // guard-comment class). Only runs when DATABASE_READ_URL is configured.
    const { prismaReadOnly } = await import('../lib/prisma.js');
    const [row] = await prismaReadOnly.$queryRawUnsafe(`
      SELECT
        CASE
          WHEN pg_is_in_recovery()
            THEN COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::double precision, 0)
          ELSE 0
        END AS lag_seconds
    `);
    dbReadReplicaLagSeconds.set({}, Number(row?.lag_seconds ?? 0));
  } catch (err) {
    logger.warn(`collectReliabilityMetrics: read-replica lag skipped — ${err?.message || err}`);
  }
}

/**
 * Refresh the DB-derived gauges. Tolerant of DB errors: logs + leaves the prior
 * snapshot (a metrics collector must never throw into the caller / crash the
 * process).
 */
export async function collectReliabilityMetrics() {
  try {
    const [eo] = await prisma.$queryRawUnsafe(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')                                   AS pending,
        COUNT(*) FILTER (WHERE status = 'failed')                                    AS dead_letter,
        COALESCE(EXTRACT(EPOCH FROM (now() - MIN(available_at) FILTER (WHERE status = 'pending')))::bigint, 0) AS oldest_age
      FROM event_outbox
    `);
    eventOutboxPending.set({}, Number(eo?.pending ?? 0));
    eventOutboxDeadLetter.set({}, Number(eo?.dead_letter ?? 0));
    eventOutboxOldestAge.set({}, Number(eo?.oldest_age ?? 0));

    const [no] = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) FILTER (WHERE status = 'PENDING') AS pending FROM notification_outbox`,
    );
    notificationOutboxPending.set({}, Number(no?.pending ?? 0));

    const [wd] = await prisma.$queryRawUnsafe(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'failed')  AS failed,
        COUNT(*) FILTER (WHERE status = 'dead')    AS dead
      FROM webhook_deliveries
    `);
    webhookPending.set({}, Number(wd?.pending ?? 0));
    webhookFailed.set({}, Number(wd?.failed ?? 0));
    webhookDead.set({}, Number(wd?.dead ?? 0));

    const [dm] = await prisma.$queryRawUnsafe(`
      WITH registry AS (
        SELECT
          COUNT(*) FILTER (WHERE status = 'active') AS active_devices,
          COUNT(*) FILTER (
            WHERE status = 'active'
              AND (
                last_seen_at IS NULL
                OR last_seen_at < NOW() - (GREATEST(expected_interval_seconds, 60) * 3 * INTERVAL '1 second')
              )
          ) AS silent_devices
        FROM device_registry
      ),
      vitals AS (
        SELECT COUNT(*) AS unverified_rows
          FROM vitals_chart
         WHERE source = 'device'
           AND device_verified = false
      ),
      associations AS (
        SELECT COUNT(*) AS active_associations
          FROM device_patient_associations
         WHERE ended_at IS NULL
      ),
      unassociated AS (
        SELECT COUNT(*) AS unassociated_messages
          FROM lab_interface_messages
         WHERE message_type = 'ORU^VITALS'
           AND status = 'failed'
           AND error = 'DEVICE_NOT_ASSOCIATED'
      )
      SELECT
        registry.active_devices,
        registry.silent_devices,
        vitals.unverified_rows,
        associations.active_associations,
        unassociated.unassociated_messages,
        COALESCE((
          SELECT jsonb_object_agg(reason, count)
            FROM device_vital_suppression_counters
        ), '{}'::jsonb) AS suppressed
      FROM registry, vitals, associations, unassociated
    `);
    deviceRegistryActiveDevices.set({}, Number(dm?.active_devices ?? 0));
    deviceSilentDevices.set({}, Number(dm?.silent_devices ?? 0));
    deviceVitalsUnverifiedRows.set({}, Number(dm?.unverified_rows ?? 0));
    deviceAssociationsActive.set({}, Number(dm?.active_associations ?? 0));
    deviceUnassociatedMessages.set({}, Number(dm?.unassociated_messages ?? 0));
    const suppressed = dm?.suppressed && typeof dm.suppressed === 'object' ? dm.suppressed : {};
    for (const [reason, value] of Object.entries(suppressed)) {
      deviceSamplesSuppressed.set({ reason }, Number(value ?? 0));
    }

    dbBreakerOpen.set({}, circuitBreakerStatus().open ? 1 : 0);
  } catch (err) {
    logger.warn(`collectReliabilityMetrics: refresh skipped — ${err?.message || err}`);
  }
  await collectReadReplicaLagMetric();
}

export function serializeReliabilityMetrics() {
  const metrics = [
    eventOutboxPending, eventOutboxOldestAge, eventOutboxDeadLetter,
    notificationOutboxPending,
    webhookPending, webhookFailed, webhookDead,
    deviceRegistryActiveDevices, deviceSilentDevices, deviceVitalsUnverifiedRows,
    deviceAssociationsActive, deviceUnassociatedMessages, deviceSamplesSuppressed,
    dbBreakerOpen,
    wsBroadcastDropped, wsFanoutSubscriberErrors, eventDeadLettered,
    ledgerReconciliationDrift,
    noteDraftJanitorDeletions, noteDraftSaveErrors,
  ];
  if (hasReadReplicaDsn()) metrics.splice(8, 0, dbReadReplicaLagSeconds);
  return metrics.map((m) => m.serialize()).filter(Boolean).join('\n\n') + '\n';
}
