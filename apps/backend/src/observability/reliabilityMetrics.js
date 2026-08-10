// src/observability/reliabilityMetrics.js
// Reliability signal metrics for the event-outbox / webhook / WS-fan-out
// machinery. DB-derived gauges are refreshed by collectReliabilityMetrics()
// (a periodic in-process collector started in bin/www.js); counters increment
// inline at the event site. Appended to /metrics after the RED exporter.
//
// Status-name notes (do NOT re-guess):
//   event_outbox.status      pending|processing|delivered|failed  (failed = dead-letter @ MAX_ATTEMPTS=7)
//   webhook_deliveries.status pending|failed|dead                 (dead = terminal undelivered)
//   notification_outbox.status PENDING|CLAIMED|SENT|FAILED|RECONCILIATION_REQUIRED|SUPPRESSED (UPPERCASE;
//     FAILED retries until retry_count>=3 then dead-letters; RECONCILIATION_REQUIRED
//     is never auto-retried — de-facto dead letter, mig-609 contract)
import prisma, { circuitBreakerStatus } from '../lib/prisma.js';
import logger from '../logging/logger.js';
import {
  PATHWAY_PROJECTOR_CONSUMER_KEY,
  PATHWAY_PROJECTOR_GENERATION,
} from '../config/pathwayProjectorConfig.js';
import { CANONICAL_PATHWAY_KEYS } from '../services/pathways/pathwayMode.js';
import { pathwayReconciliationRegistry } from '../services/pathways/pathwayReconciliationRegistry.js';
import { Gauge, Counter } from './metricPrimitives.js';

// ---- Gauges (set by the collector) ----------------------------------------
const eventOutboxPending = new Gauge('event_outbox_pending_rows', 'event_outbox rows in pending status');
const eventOutboxOldestAge = new Gauge('event_outbox_oldest_pending_age_seconds', 'Age of the oldest pending event_outbox row (seconds); 0 when none');
const eventOutboxDeadLetter = new Gauge('event_outbox_dead_letter_rows', 'event_outbox rows in the terminal failed (dead-letter) status');
const eventOutboxProcessing = new Gauge('event_outbox_processing_rows', 'event_outbox rows currently owned by a processing lease');
const eventOutboxStaleProcessing = new Gauge('event_outbox_stale_processing_rows', 'event_outbox processing rows whose lease has expired');
const notificationOutboxPending = new Gauge('notification_outbox_pending_rows', 'notification_outbox rows in PENDING status');
const notificationOutboxFailed = new Gauge('notification_outbox_failed_rows', 'notification_outbox rows in FAILED status (retrying until retry_count >= 3)');
const notificationOutboxReconciliationRequired = new Gauge('notification_outbox_reconciliation_required_rows', 'notification_outbox rows in RECONCILIATION_REQUIRED status (never auto-retried — de-facto dead letters)');
const notificationOutboxDeadLetter = new Gauge('notification_outbox_dead_letter_rows', 'notification_outbox rows no auto-path will retry: FAILED with retry_count >= 3 plus all RECONCILIATION_REQUIRED');
const webhookPending = new Gauge('webhook_deliveries_pending_rows', 'webhook_deliveries rows in pending status');
const webhookFailed = new Gauge('webhook_deliveries_failed_rows', 'webhook_deliveries rows in failed status (retrying)');
const webhookDead = new Gauge('webhook_deliveries_dead_rows', 'webhook_deliveries rows in the terminal dead status (undelivered)');
const webhookInFlight = new Gauge('webhook_deliveries_in_flight_rows', 'webhook_deliveries rows currently owned by a dispatch lease');
const webhookStaleInFlight = new Gauge('webhook_deliveries_stale_in_flight_rows', 'webhook_deliveries in-flight rows whose lease has expired');
const webhookParked = new Gauge('webhook_deliveries_parked_rows', 'Due or retryable webhook deliveries parked by a missing or inactive subscription/integration gate or unsupported filter');
const pathwayProjectorInboxPending = new Gauge('pathway_projector_inbox_pending_rows', 'Pathway projector inbox rows awaiting a terminal outcome');
const pathwayProjectorInboxOldestAge = new Gauge('pathway_projector_inbox_oldest_pending_age_seconds', 'Age of the oldest pending Pathway projector inbox row (seconds); 0 when none');
const pathwayProjectorInboxLeased = new Gauge('pathway_projector_inbox_leased_rows', 'Pending Pathway projector inbox rows with a worker lease token');
const pathwayProjectorInboxDead = new Gauge('pathway_projector_inbox_dead_rows', 'Pathway projector inbox rows in the terminal dead status');
const pathwayProjectorInboxRetiredPending = new Gauge('pathway_projector_inbox_retired_pending_rows', 'Pending Pathway projector inbox rows retained by retired generations');
const pathwayReconciliationFailingShadowTenants = new Gauge('care_pathway_reconciliation_failing_shadow_tenants', 'Tenants in shadow whose latest pathway reconciliation evidence is absent, stale-registry, or non-clean', ['pathway_key']);
const pathwayReconciliationTechnicalErrorTenants = new Gauge('care_pathway_reconciliation_technical_error_tenants', 'Tenants whose latest pathway reconciliation receipt contains a technical error', ['pathway_key']);
const pathwayReconciliationCurrentFindings = new Gauge('care_pathway_reconciliation_current_findings', 'Findings in each tenant latest pathway reconciliation receipt', ['pathway_key']);
const pathwayReconciliationCurrentRepairs = new Gauge('care_pathway_reconciliation_current_repairs', 'Repairs in each tenant latest pathway reconciliation receipt', ['pathway_key']);
const pathwayReconciliationLatestEvidenceAge = new Gauge('care_pathway_reconciliation_latest_registry_evidence_age_seconds', 'Oldest age among tenant latest receipts compatible with the current reconciliation registry; 0 when absent', ['pathway_key']);
const pathwayReconciliationActiveWithoutAuthority = new Gauge('care_pathway_reconciliation_active_without_authority_tenants', 'Tenants configured active while production pathway activation authority is unavailable', ['pathway_key']);
const dbBreakerOpen = new Gauge('db_circuit_breaker_open', 'Whether any Prisma client circuit breaker is open (1=open, 0=closed)');
const dbReadReplicaLagSeconds = new Gauge('db_read_replica_lag_seconds', 'Approximate read-replica replay lag observed through prismaReadOnly (seconds); emitted only when DATABASE_READ_URL is configured');
const deviceRegistryActiveDevices = new Gauge('device_registry_active_devices', 'Active registered clinical devices');
const deviceSilentDevices = new Gauge('device_silent_devices', 'Active devices whose last_seen_at is older than three times their expected interval, or has never been seen');
const deviceVitalsUnverifiedRows = new Gauge('device_vitals_unverified_rows', 'Unverified device-originated vitals_chart rows');
const deviceAssociationsActive = new Gauge('device_associations_active', 'Active device-patient associations');
const deviceUnassociatedMessages = new Gauge('device_unassociated_messages_total', 'Device ORU messages parked as DEVICE_NOT_ASSOCIATED');
const deviceSamplesSuppressed = new Gauge('device_samples_suppressed_total', 'Device vital samples suppressed by bounded policy reason', ['reason']);
const coldChainOpenExcursions = new Gauge('cold_chain_open_excursions', 'Open or acknowledged cold-chain excursions requiring staff action');
const EXTERNAL_RECOVERY_SCOPE_LABELS = Object.freeze([
  'tenant_id', 'facility_scope', 'facility_id', 'interface_family', 'direction',
]);
const externalRecoveryActiveOffsets = new Gauge(
  'external_recovery_active_offsets',
  'Live external-interface offsets in the exact current recovery state',
  [...EXTERNAL_RECOVERY_SCOPE_LABELS, 'recovery_state'],
);
const externalRecoveryInboxPending = new Gauge(
  'external_recovery_inbox_pending_rows',
  'External-interface recovery inbox rows still pending',
  EXTERNAL_RECOVERY_SCOPE_LABELS,
);
const externalRecoveryInboxOldestPendingAge = new Gauge(
  'external_recovery_inbox_oldest_pending_age_seconds',
  'Age since recovery recording of the oldest pending external-interface inbox row; 0 when none',
  EXTERNAL_RECOVERY_SCOPE_LABELS,
);
const externalRecoveryInboxDead = new Gauge(
  'external_recovery_inbox_dead_rows',
  'External-interface recovery inbox rows in terminal dead state',
  EXTERNAL_RECOVERY_SCOPE_LABELS,
);
const externalRecoveryCriticalReviewUnacknowledged = new Gauge(
  'external_recovery_critical_review_unacknowledged_rows',
  'Late-critical external-recovery awareness obligations without an acknowledgement receipt',
  EXTERNAL_RECOVERY_SCOPE_LABELS,
);
const externalRecoveryCriticalReviewOldestAge = new Gauge(
  'external_recovery_critical_review_oldest_unacknowledged_age_seconds',
  'Age since recovery recording of the oldest unacknowledged late-critical awareness obligation; 0 when none',
  EXTERNAL_RECOVERY_SCOPE_LABELS,
);
const externalRecoveryObservationTimestamp = new Gauge(
  'external_recovery_observation_timestamp_seconds',
  'Unix timestamp of the last complete valid external-recovery database-output observation',
);
const externalRecoveryOffsetsObserved = new Gauge(
  'external_recovery_offsets_observed_total',
  'Total live external-interface offsets in the last complete valid observation; emitted even when zero',
);

// ---- Counters (incremented inline at the event site) ----------------------
const wsBroadcastDropped = new Counter('ws_broadcast_dropped_total', 'Observable WS broadcast/sendToUser drops (per-socket backpressure or cross-process fan-out fallback). NOTE: the at-most-once Redis-failover drop is invisible to the app — see ws_fanout_subscriber_errors_total for the failover-window proxy.', ['reason']);
const wsFanoutSubscriberErrors = new Counter('ws_fanout_subscriber_errors_total', 'WS Redis fan-out subscriber error/reconnect events — the window during which a published broadcast can be silently dropped (at-most-once)', []);
const eventDeadLettered = new Counter('event_outbox_dead_lettered_total', 'event_outbox rows that crossed MAX_ATTEMPTS into the terminal failed (dead-letter) state', []);
const eventOutboxLeaseReaped = new Counter('event_outbox_stale_lease_reaped_total', 'Expired event_outbox processing leases recovered by the bounded source reaper', []);
const webhookDeliveryLeaseReaped = new Counter('webhook_deliveries_stale_lease_reaped_total', 'Expired webhook delivery leases recovered by the bounded delivery reaper', []);
const outboxOperatorRedrive = new Counter('outbox_operator_redrive_total', 'Audited operator dead-letter redrives by bounded queue kind', ['queue']);
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
function recordPositiveCount(counter, value) {
  const count = Number(value);
  if (Number.isSafeInteger(count) && count > 0) counter.inc({}, count);
}
export function recordEventOutboxLeaseReaped(count) {
  recordPositiveCount(eventOutboxLeaseReaped, count);
}
export function recordWebhookDeliveryLeaseReaped(count) {
  recordPositiveCount(webhookDeliveryLeaseReaped, count);
}
const OUTBOX_REDRIVE_QUEUES = new Set(['event_outbox', 'webhook_delivery', 'notification_outbox']);
export function recordOutboxOperatorRedrive(queue) {
  outboxOperatorRedrive.inc({ queue: OUTBOX_REDRIVE_QUEUES.has(queue) ? queue : 'other' });
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

const EXTERNAL_RECOVERY_FACILITY_SCOPES = new Set(['tenant', 'facility']);
const EXTERNAL_RECOVERY_DIRECTIONS = new Set(['inbound', 'outbound']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXTERNAL_RECOVERY_STATES = new Set([
  'paused', 'replaying', 'ready', 'retired',
  'reconciliation_required_missing_marker',
  'reconciliation_required_source_gap',
  'reconciliation_required_retention_gap',
  'reconciliation_required_provider_state',
]);

function externalRecoveryNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TypeError(`external recovery observation has invalid ${label}`);
  }
  return parsed;
}

function externalRecoveryLabels(scope) {
  const tenantId = String(scope?.tenant_id || '').toLowerCase();
  const facilityScope = String(scope?.facility_scope || '');
  const interfaceFamily = String(scope?.interface_family || '');
  const direction = String(scope?.direction || '');
  if (
    !UUID_PATTERN.test(tenantId)
    || !EXTERNAL_RECOVERY_FACILITY_SCOPES.has(facilityScope)
    || !/^I(?:0[1-9]|[12][0-9]|30)$/.test(interfaceFamily)
    || !EXTERNAL_RECOVERY_DIRECTIONS.has(direction)
  ) {
    throw new TypeError('external recovery observation has invalid bounded labels');
  }
  const facilityId = facilityScope === 'tenant'
    ? 'tenant-wide'
    : String(scope?.facility_id || '');
  if (facilityScope === 'facility' && !/^[1-9][0-9]*$/.test(facilityId)) {
    throw new TypeError('external recovery observation has invalid facility label');
  }
  return {
    tenant_id: tenantId,
    facility_scope: facilityScope,
    facility_id: facilityId,
    interface_family: interfaceFamily,
    direction,
  };
}

async function collectExternalRecoveryOutputMetrics() {
  const rows = await prisma.$queryRawUnsafe(`
    WITH live_offsets AS (
      SELECT offset_id, tenant_id, facility_scope, facility_id,
             interface_family, direction, recovery_state
        FROM event_consumer_offsets
       WHERE scope_kind = 'external_interface'
         AND intake_retired_at IS NULL
    ), scopes AS (
      SELECT DISTINCT tenant_id, facility_scope, facility_id,
                      interface_family, direction
        FROM live_offsets
    ), state_counts AS (
      SELECT tenant_id, facility_scope, facility_id, interface_family,
             direction, recovery_state, COUNT(*)::bigint AS offset_count
        FROM live_offsets
       GROUP BY tenant_id, facility_scope, facility_id, interface_family,
                direction, recovery_state
    ), inbox_counts AS (
      SELECT offsets.tenant_id, offsets.facility_scope, offsets.facility_id,
             offsets.interface_family, offsets.direction,
             COUNT(*) FILTER (WHERE inbox.status = 'pending')::bigint AS pending_rows,
             COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(inbox.recorded_at)
               FILTER (WHERE inbox.status = 'pending')), 0)::bigint
               AS oldest_pending_age_seconds,
             COUNT(*) FILTER (WHERE inbox.status = 'dead')::bigint AS dead_rows
        FROM live_offsets AS offsets
        LEFT JOIN pathway_projector_inbox AS inbox
          ON inbox.tenant_id = offsets.tenant_id
         AND inbox.offset_id = offsets.offset_id
         AND inbox.scope_kind = 'external_interface'
       GROUP BY offsets.tenant_id, offsets.facility_scope, offsets.facility_id,
                offsets.interface_family, offsets.direction
    ), critical_counts AS (
      SELECT offsets.tenant_id, offsets.facility_scope, offsets.facility_id,
             offsets.interface_family, offsets.direction,
             COUNT(*) FILTER (
               WHERE obligation.id IS NOT NULL AND acknowledgement.id IS NULL
             )::bigint AS unacknowledged_rows,
             COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(obligation.recorded_at)
               FILTER (WHERE obligation.id IS NOT NULL AND acknowledgement.id IS NULL)), 0)::bigint
               AS oldest_unacknowledged_age_seconds
        FROM live_offsets AS offsets
        LEFT JOIN external_recovery_critical_review_obligations AS obligation
          ON obligation.tenant_id = offsets.tenant_id
         AND obligation.offset_id = offsets.offset_id
        LEFT JOIN external_recovery_critical_review_acknowledgements AS acknowledgement
          ON acknowledgement.tenant_id = obligation.tenant_id
         AND acknowledgement.obligation_id = obligation.id
       GROUP BY offsets.tenant_id, offsets.facility_scope, offsets.facility_id,
                offsets.interface_family, offsets.direction
    )
    SELECT EXTRACT(EPOCH FROM NOW())::double precision AS observed_at,
           (SELECT COUNT(*)::bigint FROM live_offsets) AS offsets_observed,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'tenant_id', scope.tenant_id,
               'facility_scope', scope.facility_scope,
               'facility_id', scope.facility_id,
               'interface_family', scope.interface_family,
               'direction', scope.direction,
               'pending_rows', inbox.pending_rows,
               'oldest_pending_age_seconds', inbox.oldest_pending_age_seconds,
               'dead_rows', inbox.dead_rows,
               'unacknowledged_rows', critical.unacknowledged_rows,
               'oldest_unacknowledged_age_seconds',
                 critical.oldest_unacknowledged_age_seconds,
               'states', (
                 SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'recovery_state', states.recovery_state,
                   'offset_count', states.offset_count
                 ) ORDER BY states.recovery_state), '[]'::jsonb)
                   FROM state_counts AS states
                  WHERE states.tenant_id = scope.tenant_id
                    AND states.facility_scope = scope.facility_scope
                    AND states.facility_id IS NOT DISTINCT FROM scope.facility_id
                    AND states.interface_family = scope.interface_family
                    AND states.direction = scope.direction
               )
             ) ORDER BY scope.tenant_id, scope.facility_scope, scope.facility_id,
                        scope.interface_family, scope.direction)
               FROM scopes AS scope
               JOIN inbox_counts AS inbox
                 ON inbox.tenant_id = scope.tenant_id
                AND inbox.facility_scope = scope.facility_scope
                AND inbox.facility_id IS NOT DISTINCT FROM scope.facility_id
                AND inbox.interface_family = scope.interface_family
                AND inbox.direction = scope.direction
               JOIN critical_counts AS critical
                 ON critical.tenant_id = scope.tenant_id
                AND critical.facility_scope = scope.facility_scope
                AND critical.facility_id IS NOT DISTINCT FROM scope.facility_id
                AND critical.interface_family = scope.interface_family
                AND critical.direction = scope.direction
           ), '[]'::jsonb) AS scopes
  `);
  if (rows.length !== 1 || !Array.isArray(rows[0]?.scopes)) {
    throw new TypeError('external recovery observation is incomplete');
  }
  const observation = rows[0];
  const observedAt = externalRecoveryNumber(observation.observed_at, 'observation timestamp');
  const total = externalRecoveryNumber(observation.offsets_observed, 'offset total');
  const snapshots = {
    offsets: [], pending: [], pendingAge: [], dead: [], critical: [], criticalAge: [],
  };
  for (const scope of observation.scopes) {
    const labels = externalRecoveryLabels(scope);
    const states = Array.isArray(scope.states) ? scope.states : null;
    if (!states) throw new TypeError('external recovery observation has invalid state output');
    for (const state of states) {
      const recoveryState = String(state?.recovery_state || '');
      if (!EXTERNAL_RECOVERY_STATES.has(recoveryState)) {
        throw new TypeError('external recovery observation has invalid recovery state');
      }
      snapshots.offsets.push({
        labels: { ...labels, recovery_state: recoveryState },
        value: externalRecoveryNumber(state.offset_count, 'state count'),
      });
    }
    snapshots.pending.push({ labels, value: externalRecoveryNumber(scope.pending_rows, 'pending count') });
    snapshots.pendingAge.push({ labels, value: externalRecoveryNumber(scope.oldest_pending_age_seconds, 'pending age') });
    snapshots.dead.push({ labels, value: externalRecoveryNumber(scope.dead_rows, 'dead count') });
    snapshots.critical.push({ labels, value: externalRecoveryNumber(scope.unacknowledged_rows, 'critical review count') });
    snapshots.criticalAge.push({ labels, value: externalRecoveryNumber(scope.oldest_unacknowledged_age_seconds, 'critical review age') });
  }

  externalRecoveryActiveOffsets.replace(snapshots.offsets);
  externalRecoveryInboxPending.replace(snapshots.pending);
  externalRecoveryInboxOldestPendingAge.replace(snapshots.pendingAge);
  externalRecoveryInboxDead.replace(snapshots.dead);
  externalRecoveryCriticalReviewUnacknowledged.replace(snapshots.critical);
  externalRecoveryCriticalReviewOldestAge.replace(snapshots.criticalAge);
  externalRecoveryOffsetsObserved.replace([{ labels: {}, value: total }]);
  externalRecoveryObservationTimestamp.replace([{ labels: {}, value: observedAt }]);
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
        COUNT(*) FILTER (WHERE status = 'processing')                                AS processing,
        COUNT(*) FILTER (WHERE status = 'processing' AND lease_expires_at <= NOW())  AS stale_processing,
        COALESCE(EXTRACT(EPOCH FROM (now() - MIN(available_at) FILTER (WHERE status = 'pending')))::bigint, 0) AS oldest_age
      FROM event_outbox
    `);
    eventOutboxPending.set({}, Number(eo?.pending ?? 0));
    eventOutboxDeadLetter.set({}, Number(eo?.dead_letter ?? 0));
    eventOutboxOldestAge.set({}, Number(eo?.oldest_age ?? 0));
    eventOutboxProcessing.set({}, Number(eo?.processing ?? 0));
    eventOutboxStaleProcessing.set({}, Number(eo?.stale_processing ?? 0));

    const [no] = await prisma.$queryRawUnsafe(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'PENDING') AS pending,
        COUNT(*) FILTER (WHERE status = 'FAILED')  AS failed,
        COUNT(*) FILTER (WHERE status = 'RECONCILIATION_REQUIRED') AS reconciliation_required,
        COUNT(*) FILTER (
          WHERE (status = 'FAILED' AND retry_count >= 3)
             OR status = 'RECONCILIATION_REQUIRED'
        ) AS dead_letter
      FROM notification_outbox
    `);
    notificationOutboxPending.set({}, Number(no?.pending ?? 0));
    notificationOutboxFailed.set({}, Number(no?.failed ?? 0));
    notificationOutboxReconciliationRequired.set({}, Number(no?.reconciliation_required ?? 0));
    notificationOutboxDeadLetter.set({}, Number(no?.dead_letter ?? 0));

    const [wd] = await prisma.$queryRawUnsafe(`
      SELECT
        COUNT(*) FILTER (WHERE delivery.status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE delivery.status = 'failed')  AS failed,
        COUNT(*) FILTER (WHERE delivery.status = 'dead')    AS dead,
        COUNT(*) FILTER (WHERE delivery.status = 'in_flight') AS in_flight,
        COUNT(*) FILTER (
          WHERE delivery.status = 'in_flight'
            AND delivery.lease_expires_at <= NOW()
        ) AS stale_in_flight,
        COUNT(*) FILTER (
          WHERE delivery.status IN ('pending', 'failed')
            AND (
              subscription.id IS NULL
              OR subscription.is_active IS NOT TRUE
              OR subscription.event_filter <> '{}'::jsonb
              OR integration.id IS NULL
              OR integration.status <> 'active'
            )
        ) AS parked
      FROM webhook_deliveries AS delivery
      LEFT JOIN webhook_subscriptions AS subscription
        ON subscription.tenant_id = delivery.tenant_id
       AND subscription.id = delivery.subscription_id
      LEFT JOIN integrations AS integration
        ON integration.tenant_id = subscription.tenant_id
       AND integration.id = subscription.integration_id
    `);
    webhookPending.set({}, Number(wd?.pending ?? 0));
    webhookFailed.set({}, Number(wd?.failed ?? 0));
    webhookDead.set({}, Number(wd?.dead ?? 0));
    webhookInFlight.set({}, Number(wd?.in_flight ?? 0));
    webhookStaleInFlight.set({}, Number(wd?.stale_in_flight ?? 0));
    webhookParked.set({}, Number(wd?.parked ?? 0));

    const [pi] = await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending') AS pending,
         COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE status = 'pending')))::bigint, 0) AS oldest_age,
         COUNT(*) FILTER (WHERE status = 'pending' AND lease_owner IS NOT NULL) AS leased,
         COUNT(*) FILTER (WHERE status = 'dead') AS dead
       FROM pathway_projector_inbox
       WHERE consumer_key = $1
         AND generation = $2
         AND status IN ('pending', 'dead')`,
      PATHWAY_PROJECTOR_CONSUMER_KEY,
      PATHWAY_PROJECTOR_GENERATION,
    );
    pathwayProjectorInboxPending.set({}, Number(pi?.pending ?? 0));
    pathwayProjectorInboxOldestAge.set({}, Number(pi?.oldest_age ?? 0));
    pathwayProjectorInboxLeased.set({}, Number(pi?.leased ?? 0));
    pathwayProjectorInboxDead.set({}, Number(pi?.dead ?? 0));

    const [retiredPi] = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS pending
         FROM event_consumer_offsets offsets
         JOIN pathway_projector_inbox inbox
           ON inbox.consumer_key = offsets.consumer_key
          AND inbox.generation = offsets.generation
        WHERE offsets.consumer_key = $1
          AND offsets.intake_retired_at IS NOT NULL
          AND inbox.status = 'pending'`,
      PATHWAY_PROJECTOR_CONSUMER_KEY,
    );
    pathwayProjectorInboxRetiredPending.set({}, Number(retiredPi?.pending ?? 0));

    try {
      await collectExternalRecoveryOutputMetrics();
    } catch (externalRecoveryError) {
      // Preserve the prior complete external-recovery snapshot. In particular,
      // never publish healthy zeros or a fresh observation timestamp after a
      // missing/malformed/failed database-output read.
      logger.warn(
        `collectReliabilityMetrics: external recovery output skipped — ${externalRecoveryError?.message || externalRecoveryError}`,
      );
    }

    for (const pathwayKey of CANONICAL_PATHWAY_KEYS) {
      const labels = { pathway_key: pathwayKey };
      pathwayReconciliationFailingShadowTenants.set(labels, 0);
      pathwayReconciliationTechnicalErrorTenants.set(labels, 0);
      pathwayReconciliationCurrentFindings.set(labels, 0);
      pathwayReconciliationCurrentRepairs.set(labels, 0);
      pathwayReconciliationLatestEvidenceAge.set(labels, 0);
      pathwayReconciliationActiveWithoutAuthority.set(labels, 0);
    }
    const reconciliationRows = await prisma.$queryRawUnsafe(
      `WITH pathway_keys(pathway_key) AS (
         SELECT UNNEST($1::text[])
       ), tenant_modes AS (
         SELECT tenant.id AS tenant_id,
                pathway.pathway_key,
                CASE
                  WHEN LOWER(COALESCE(
                    tenant.settings #>> ARRAY['care_pathways', pathway.pathway_key],
                    'off'
                  )) IN ('off', 'shadow', 'active')
                  THEN LOWER(COALESCE(
                    tenant.settings #>> ARRAY['care_pathways', pathway.pathway_key],
                    'off'
                  ))
                  ELSE 'off'
                END AS current_mode
           FROM tenants AS tenant
          CROSS JOIN pathway_keys AS pathway
       ), latest AS (
         SELECT DISTINCT ON (evidence.tenant_id, evidence.pathway_key)
                evidence.*
           FROM care_pathway_reconciliation_checks AS evidence
          ORDER BY evidence.tenant_id, evidence.pathway_key,
                   evidence.completed_at DESC, evidence.id DESC
       )
       SELECT mode.pathway_key,
              COUNT(*) FILTER (
                WHERE mode.current_mode = 'shadow'
                  AND (
                    latest.id IS NULL
                    OR latest.passed IS NOT TRUE
                    OR latest.registry_checksum <> $2::char(64)
                  )
              )::integer AS failing_shadow_tenants,
              COUNT(*) FILTER (
                WHERE latest.error_count > 0
              )::integer AS technical_error_tenants,
              COALESCE(SUM(latest.finding_count), 0)::integer AS current_findings,
              COALESCE(SUM(latest.repair_count), 0)::integer AS current_repairs,
              COALESCE(MAX(
                EXTRACT(EPOCH FROM (NOW() - latest.completed_at))
              ) FILTER (
                WHERE latest.registry_checksum = $2::char(64)
              ), 0)::bigint AS latest_registry_evidence_age_seconds,
              COUNT(*) FILTER (
                WHERE mode.current_mode = 'active'
              )::integer AS active_without_authority_tenants
         FROM tenant_modes AS mode
         LEFT JOIN latest
           ON latest.tenant_id = mode.tenant_id
          AND latest.pathway_key = mode.pathway_key
        GROUP BY mode.pathway_key
        ORDER BY mode.pathway_key`,
      CANONICAL_PATHWAY_KEYS,
      pathwayReconciliationRegistry.checksum,
    );
    for (const row of reconciliationRows) {
      const labels = { pathway_key: row.pathway_key };
      pathwayReconciliationFailingShadowTenants.set(
        labels,
        Number(row.failing_shadow_tenants || 0),
      );
      pathwayReconciliationTechnicalErrorTenants.set(
        labels,
        Number(row.technical_error_tenants || 0),
      );
      pathwayReconciliationCurrentFindings.set(labels, Number(row.current_findings || 0));
      pathwayReconciliationCurrentRepairs.set(labels, Number(row.current_repairs || 0));
      pathwayReconciliationLatestEvidenceAge.set(
        labels,
        Number(row.latest_registry_evidence_age_seconds || 0),
      );
      pathwayReconciliationActiveWithoutAuthority.set(
        labels,
        Number(row.active_without_authority_tenants || 0),
      );
    }

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
      ),
      cold_chain AS (
        SELECT COUNT(*) AS open_excursions
          FROM cold_chain_excursions
         WHERE status IN ('open', 'acknowledged')
      )
      SELECT
        registry.active_devices,
        registry.silent_devices,
        vitals.unverified_rows,
        associations.active_associations,
        unassociated.unassociated_messages,
        cold_chain.open_excursions,
        COALESCE((
          SELECT jsonb_object_agg(reason, count)
            FROM device_vital_suppression_counters
        ), '{}'::jsonb) AS suppressed
      FROM registry, vitals, associations, unassociated, cold_chain
    `);
    deviceRegistryActiveDevices.set({}, Number(dm?.active_devices ?? 0));
    deviceSilentDevices.set({}, Number(dm?.silent_devices ?? 0));
    deviceVitalsUnverifiedRows.set({}, Number(dm?.unverified_rows ?? 0));
    deviceAssociationsActive.set({}, Number(dm?.active_associations ?? 0));
    deviceUnassociatedMessages.set({}, Number(dm?.unassociated_messages ?? 0));
    coldChainOpenExcursions.set({}, Number(dm?.open_excursions ?? 0));
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
    eventOutboxProcessing, eventOutboxStaleProcessing,
    notificationOutboxPending, notificationOutboxFailed,
    notificationOutboxReconciliationRequired, notificationOutboxDeadLetter,
    webhookPending, webhookFailed, webhookDead,
    webhookInFlight, webhookStaleInFlight, webhookParked,
    pathwayProjectorInboxPending, pathwayProjectorInboxOldestAge,
    pathwayProjectorInboxLeased, pathwayProjectorInboxDead,
    pathwayProjectorInboxRetiredPending,
    externalRecoveryActiveOffsets,
    externalRecoveryInboxPending,
    externalRecoveryInboxOldestPendingAge,
    externalRecoveryInboxDead,
    externalRecoveryCriticalReviewUnacknowledged,
    externalRecoveryCriticalReviewOldestAge,
    externalRecoveryObservationTimestamp,
    externalRecoveryOffsetsObserved,
    pathwayReconciliationFailingShadowTenants,
    pathwayReconciliationTechnicalErrorTenants,
    pathwayReconciliationCurrentFindings,
    pathwayReconciliationCurrentRepairs,
    pathwayReconciliationLatestEvidenceAge,
    pathwayReconciliationActiveWithoutAuthority,
    deviceRegistryActiveDevices, deviceSilentDevices, deviceVitalsUnverifiedRows,
    deviceAssociationsActive, deviceUnassociatedMessages, deviceSamplesSuppressed,
    coldChainOpenExcursions,
    dbBreakerOpen,
    wsBroadcastDropped, wsFanoutSubscriberErrors, eventDeadLettered,
    eventOutboxLeaseReaped, webhookDeliveryLeaseReaped, outboxOperatorRedrive,
    ledgerReconciliationDrift,
    noteDraftJanitorDeletions, noteDraftSaveErrors,
  ];
  if (hasReadReplicaDsn()) metrics.splice(12, 0, dbReadReplicaLagSeconds);
  return metrics.map((m) => m.serialize()).filter(Boolean).join('\n\n') + '\n';
}

export const __testing__ = Object.freeze({
  collectExternalRecoveryOutputMetrics,
  externalRecoveryLabels,
});
