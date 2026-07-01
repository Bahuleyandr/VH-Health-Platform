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

/**
 * Refresh the DB-derived gauges. ONE batched read per tick. Tolerant of a DB
 * error: logs + leaves the prior snapshot (a metrics collector must never throw
 * into the caller / crash the process).
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

    dbBreakerOpen.set({}, circuitBreakerStatus().open ? 1 : 0);
  } catch (err) {
    logger.warn(`collectReliabilityMetrics: refresh skipped — ${err?.message || err}`);
  }
}

export function serializeReliabilityMetrics() {
  return [
    eventOutboxPending, eventOutboxOldestAge, eventOutboxDeadLetter,
    notificationOutboxPending,
    webhookPending, webhookFailed, webhookDead,
    dbBreakerOpen,
    wsBroadcastDropped, wsFanoutSubscriberErrors, eventDeadLettered,
    ledgerReconciliationDrift,
    noteDraftJanitorDeletions, noteDraftSaveErrors,
  ].map((m) => m.serialize()).filter(Boolean).join('\n\n') + '\n';
}
