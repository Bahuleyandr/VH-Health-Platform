import { randomUUID } from 'node:crypto';
import { setTenant, setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  CORE_MARKERS,
  REQUIRED_EXPOSURE_HANDLER_IDS,
  applyExposureHandler,
  exposureResultComplete,
  listExposureHandlers,
  requireUuid,
} from './bloodborneMarkerRules.js';
import { assertExposurePatientLocksTx } from './patientExposureLock.js';

export const EXPOSURE_MAX_ATTEMPTS = 7;
export const EXPOSURE_BACKOFF_SECONDS = Object.freeze([30, 120, 600, 1800, 3600, 14400, 28800]);
export const PLATFORM_EXPOSURE_HANDLER_ID = 'platform-reprocessable-devices.v1';

function positive(value, fallback, maximum = 500) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw AppError.badRequest('Exposure query bound is invalid', 'RPD_EXPOSURE_QUERY_INVALID');
  }
  return number;
}

function handlersForDrain(handlers) {
  const ids = handlers.map(handler => handler.id);
  if (new Set(ids).size !== ids.length
    || REQUIRED_EXPOSURE_HANDLER_IDS.some(id => !ids.includes(id))
    || handlers.some(handler => typeof handler.apply !== 'function')) {
    throw AppError.conflict('Required exposure consumers are unavailable', 'RPD_EXPOSURE_HANDLERS_MISSING');
  }
  return handlers;
}

export async function enqueueExposureEventTx(tx, event) {
  if (!CORE_MARKERS.includes(event.marker)) return null;
  const tenantId = requireTenantId(event.tenantId);
  const patientUid = requireUuid(event.patientUid, 'patientUid');
  const payload = {
    tenantId, patientUid, marker: event.marker,
    testedOn: event.testedOn ?? null, markerRowId: Number(event.markerRowId),
  };
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO bloodborne_exposure_outbox
       (tenant_id, marker_row_id, patient_uid, marker, tested_on, event)
     VALUES ($1::uuid, $2::bigint, $3::uuid, $4, $5::date, $6::jsonb)
     ON CONFLICT (tenant_id, marker_row_id) DO NOTHING
     RETURNING id`,
    tenantId, payload.markerRowId, patientUid, payload.marker, payload.testedOn, JSON.stringify(payload),
  );
  return rows[0] ?? null;
}

export async function snapshotExposureOutbox({ tenantId }) {
  const tid = requireTenantId(tenantId);
  const rows = await setTenant(tid, tx => tx.$queryRawUnsafe(
    `SELECT count(*)::int AS population,
       count(*) FILTER (WHERE status IN ('pending', 'processing'))::int AS pending,
       count(*) FILTER (WHERE status = 'failed')::int AS failed,
       count(*) FILTER (WHERE status = 'delivered')::int AS drained
     FROM bloodborne_exposure_outbox WHERE tenant_id = $1::uuid`, tid,
  ));
  return rows[0];
}

export async function reapExposureLeases({ tenantId, limit = 500 }) {
  const tid = requireTenantId(tenantId);
  return setTenantTx(tid, async tx => {
    const rows = await tx.$queryRawUnsafe(
      `WITH expired AS (
         SELECT id FROM bloodborne_exposure_outbox
          WHERE tenant_id = $1::uuid AND status = 'processing'
            AND lease_expires_at <= clock_timestamp()
          ORDER BY id LIMIT $2::int FOR UPDATE SKIP LOCKED
       ) UPDATE bloodborne_exposure_outbox o
           SET status = CASE WHEN attempts >= $3::int THEN 'failed' ELSE 'pending' END,
               lease_owner = NULL, lease_expires_at = NULL, available_at = clock_timestamp(),
               last_error = 'exposure_lease_expired', updated_at = clock_timestamp()
          FROM expired WHERE o.tenant_id = $1::uuid AND o.id = expired.id RETURNING o.id`,
      tid, positive(limit, 500), EXPOSURE_MAX_ATTEMPTS,
    );
    if (rows.length) {
      await tx.$queryRawUnsafe(
        `UPDATE bloodborne_exposure_deliveries
            SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
                last_error = 'exposure_lease_expired', updated_at = clock_timestamp()
          WHERE tenant_id = $1::uuid AND outbox_id = ANY($2::bigint[]) AND status = 'processing'
          RETURNING id`, tid, rows.map(row => row.id),
      );
    }
    return { reaped: rows.length };
  });
}

async function claimExposureEvents({ tenantId, limit, leaseSeconds }) {
  const owner = randomUUID();
  return setTenantTx(tenantId, tx => tx.$queryRawUnsafe(
    `WITH due AS (
       SELECT id FROM bloodborne_exposure_outbox
        WHERE tenant_id = $1::uuid AND status IN ('pending', 'failed')
          AND attempts < $2::int AND available_at <= clock_timestamp()
        ORDER BY available_at, id LIMIT $3::int FOR UPDATE SKIP LOCKED
     ) UPDATE bloodborne_exposure_outbox o
          SET status = 'processing', attempts = attempts + 1, lease_owner = $4,
              lease_expires_at = clock_timestamp() + $5::int * INTERVAL '1 second',
              updated_at = clock_timestamp()
         FROM due WHERE o.tenant_id = $1::uuid AND o.id = due.id
       RETURNING o.id, o.tenant_id, o.marker_row_id, o.patient_uid, o.marker, o.tested_on,
                 o.event, o.status, o.attempts, o.available_at, o.lease_owner, o.lease_expires_at`,
    tenantId, EXPOSURE_MAX_ATTEMPTS, limit, owner, leaseSeconds,
  ));
}

export async function reconcileExposureApplications({ tenantId, limit = 500 }) {
  const tid = requireTenantId(tenantId);
  return setTenantTx(tid, async tx => {
    const rows = await tx.$queryRawUnsafe(
      `WITH incomplete AS (
         SELECT o.id FROM bloodborne_exposure_outbox o
          WHERE o.tenant_id = $1::uuid AND o.status = 'delivered'
            AND EXISTS (
              SELECT 1 FROM reprocessable_devices d
              LEFT JOIN reprocessable_device_dialysis_links l ON l.tenant_id = d.tenant_id AND l.device_id = d.id
              LEFT JOIN reprocessing_domain_settings s ON s.tenant_id = d.tenant_id AND s.domain = d.domain
              WHERE d.tenant_id = o.tenant_id AND d.status <> 'discarded'
                AND ((d.domain = 'dialysis' AND l.dedicated_patient_uid = o.patient_uid)
                  OR EXISTS (SELECT 1 FROM reprocessable_device_usages u
                    WHERE u.tenant_id = d.tenant_id AND u.device_id = d.id AND u.patient_uid = o.patient_uid
                      AND ((d.domain = 'dialysis' AND u.returned_at IS NULL)
                        OR (d.domain = 'ot' AND (o.tested_on IS NULL OR u.captured_at >=
                          ((o.tested_on - COALESCE(s.serology_validity_days, 90) * INTERVAL '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata'))))))
                AND NOT EXISTS (SELECT 1 FROM bloodborne_exposure_applications a
                  WHERE a.tenant_id = o.tenant_id AND a.outbox_id = o.id AND a.handler_id = $3 AND a.device_id = d.id))
          ORDER BY o.id LIMIT $2::int FOR UPDATE SKIP LOCKED
       ) UPDATE bloodborne_exposure_outbox o
           SET status = 'pending', attempts = 0, delivered_at = NULL,
               available_at = clock_timestamp(), updated_at = clock_timestamp()
          FROM incomplete WHERE o.tenant_id = $1::uuid AND o.id = incomplete.id RETURNING o.id`,
      tid, positive(limit, 500), PLATFORM_EXPOSURE_HANDLER_ID,
    );
    if (rows.length) {
      await tx.$queryRawUnsafe(
        `UPDATE bloodborne_exposure_deliveries SET status = 'pending', attempts = 0,
            remaining_device_count = 1, completed_at = NULL,
            available_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE tenant_id = $1::uuid AND outbox_id = ANY($2::bigint[]) AND handler_id = $3 RETURNING id`,
        tid, rows.map(row => row.id), PLATFORM_EXPOSURE_HANDLER_ID,
      );
    }
    return { reopened: rows.length };
  });
}

async function beginDelivery(claim, handlerId) {
  return setTenantTx(claim.tenant_id, async tx => {
    const current = await tx.$queryRawUnsafe(
      `SELECT id FROM bloodborne_exposure_outbox
        WHERE tenant_id = $1::uuid AND id = $2::bigint AND status = 'processing'
          AND lease_owner = $3 AND attempts = $4::int AND lease_expires_at > clock_timestamp()
        FOR UPDATE`, claim.tenant_id, claim.id, claim.lease_owner, claim.attempts,
    );
    if (!current.length) return { lost_fence: true };
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO bloodborne_exposure_deliveries (tenant_id, outbox_id, handler_id)
       VALUES ($1::uuid, $2::bigint, $3)
       ON CONFLICT (tenant_id, outbox_id, handler_id) DO UPDATE
         SET updated_at = bloodborne_exposure_deliveries.updated_at
       RETURNING id, status, result, remaining_device_count, remaining_alert_count,
                 remaining_notification_count`, claim.tenant_id, claim.id, handlerId,
    );
    const delivery = rows[0];
    if (delivery.status === 'complete' && exposureResultComplete(delivery)) return { complete: true };
    const claimed = await tx.$queryRawUnsafe(
      `UPDATE bloodborne_exposure_deliveries
          SET status = 'processing', attempts = attempts + 1, lease_owner = $3,
              lease_expires_at = $4::timestamptz, completed_at = NULL, updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND id = $2::bigint
        RETURNING id, attempts, result`, claim.tenant_id, delivery.id, claim.lease_owner, claim.lease_expires_at,
    );
    return claimed[0];
  });
}

async function settleDelivery(claim, delivery, outcome) {
  return setTenantTx(claim.tenant_id, tx => tx.$queryRawUnsafe(
    `UPDATE bloodborne_exposure_deliveries d
        SET status = $6::text, remaining_device_count = $7::int, remaining_alert_count = $8::int,
            remaining_notification_count = $9::int, result = $10::jsonb,
            last_error = $11, completed_at = CASE WHEN $6::text = 'complete' THEN clock_timestamp() ELSE NULL END,
            lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
      WHERE d.tenant_id = $1::uuid AND d.id = $2::bigint
        AND d.lease_owner = $3 AND d.attempts = $4::int
        AND EXISTS (SELECT 1 FROM bloodborne_exposure_outbox o
          WHERE o.tenant_id = $1::uuid AND o.id = $5::bigint AND o.status = 'processing'
            AND o.lease_owner = $3 AND o.lease_expires_at > clock_timestamp())
      RETURNING d.id`,
    claim.tenant_id, delivery.id, claim.lease_owner, delivery.attempts, claim.id,
    outcome.complete ? 'complete' : 'failed', outcome.result.remaining_device_count,
    outcome.result.remaining_alert_count, outcome.result.remaining_notification_count,
    JSON.stringify(outcome.result), outcome.error ?? (outcome.complete ? null : 'exposure_obligations_remaining'),
  ));
}

async function settleEvent(claim, handlerIds) {
  return setTenantTx(claim.tenant_id, async tx => {
    const deliveries = await tx.$queryRawUnsafe(
      `SELECT handler_id, status, remaining_device_count, remaining_alert_count, remaining_notification_count
         FROM bloodborne_exposure_deliveries WHERE tenant_id = $1::uuid AND outbox_id = $2::bigint`,
      claim.tenant_id, claim.id,
    );
    const complete = handlerIds.every(id => deliveries.some(row => (
      row.handler_id === id && row.status === 'complete' && exposureResultComplete(row)
    )));
    const backoff = EXPOSURE_BACKOFF_SECONDS[Math.min(claim.attempts - 1, EXPOSURE_BACKOFF_SECONDS.length - 1)];
    const rows = await tx.$queryRawUnsafe(
      `UPDATE bloodborne_exposure_outbox
          SET status = $5::text, delivered_at = CASE WHEN $5::text = 'delivered' THEN clock_timestamp() ELSE NULL END,
              available_at = clock_timestamp() + $6::int * INTERVAL '1 second',
              lease_owner = NULL, lease_expires_at = NULL, last_error = $7, updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND id = $2::bigint AND status = 'processing'
          AND lease_owner = $3 AND attempts = $4::int AND lease_expires_at > clock_timestamp()
        RETURNING id`,
      claim.tenant_id, claim.id, claim.lease_owner, claim.attempts,
      complete ? 'delivered' : 'failed', backoff, complete ? null : 'exposure_obligations_remaining',
    );
    return { complete: complete && rows.length === 1, lost_fence: rows.length !== 1 };
  });
}

export async function drainExposureOutbox({ tenantId, limit = 50, leaseSeconds = 120, handlers = listExposureHandlers() }) {
  const tid = requireTenantId(tenantId);
  const consumers = handlersForDrain(handlers);
  await reapExposureLeases({ tenantId: tid });
  const reconciled = await reconcileExposureApplications({ tenantId: tid });
  const claims = await claimExposureEvents({ tenantId: tid, limit: positive(limit, 50), leaseSeconds: positive(leaseSeconds, 120, 900) });
  const summary = { scanned: claims.length, claimed: claims.length, delivered: 0, failed: 0, pending: 0, lost_fence: 0, reopened: reconciled.reopened };
  for (const claim of claims) {
    try {
      for (const handler of consumers) {
        const delivery = await beginDelivery(claim, handler.id);
        if (delivery.lost_fence) { summary.lost_fence += 1; break; }
        if (delivery.complete) continue;
        const outcome = await applyExposureHandler(handler, claim.event, {
          outboxId: Number(claim.id), deliveryId: Number(delivery.id), previousResult: delivery.result,
        });
        const persisted = await settleDelivery(claim, delivery, outcome);
        if (!persisted.length) { summary.lost_fence += 1; break; }
      }
      const settled = await settleEvent(claim, consumers.map(handler => handler.id));
      if (settled.complete) summary.delivered += 1;
      else summary.failed += 1;
    } catch {
      summary.failed += 1;
    }
  }
  const remaining = await snapshotExposureOutbox({ tenantId: tid });
  summary.pending = remaining.pending;
  summary.remaining_failed = remaining.failed;
  if (summary.failed > 0 || summary.lost_fence > 0 || remaining.failed > 0) {
    const error = AppError.conflict('Exposure delivery is incomplete', 'RPD_EXPOSURE_DRAIN_FAILED');
    error.result = summary;
    throw error;
  }
  return summary;
}

export async function redriveExposureEvent({ tenantId, outboxId }) {
  const tid = requireTenantId(tenantId);
  return setTenantTx(tid, async tx => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE bloodborne_exposure_outbox
          SET status = 'pending', attempts = 0, available_at = clock_timestamp(),
              lease_owner = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND id = $2::bigint AND status = 'failed'
        RETURNING id`, tid, positive(outboxId, null, Number.MAX_SAFE_INTEGER),
    );
    if (!rows.length) throw AppError.conflict('Exposure event is not failed', 'RPD_EXPOSURE_REDRIVE_INVALID');
    await tx.$queryRawUnsafe(
      `UPDATE bloodborne_exposure_deliveries
          SET status = 'pending', attempts = 0, available_at = clock_timestamp(),
              lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND outbox_id = $2::bigint AND status <> 'complete' RETURNING id`,
      tid, outboxId,
    );
    return { outbox_id: Number(rows[0].id), status: 'pending' };
  });
}

export async function drainExposureOutboxForAllTenants({ dryRun = false, limit = 50 } = {}) {
  const { runForEachTenant } = await import('../../utils/tenantFanout.js');
  const totals = { population: 0, pending: 0, failed: 0, drained: 0, claimed: 0 };
  try {
    const run = await runForEachTenant('bloodborne-exposure-outbox-drain', async tenantId => {
      try {
        if (!dryRun) {
          const result = await drainExposureOutbox({ tenantId, limit });
          totals.claimed += result.claimed;
        }
      } finally {
        const snapshot = await snapshotExposureOutbox({ tenantId });
        for (const key of ['population', 'pending', 'failed', 'drained']) totals[key] += snapshot[key];
      }
    });
    return { ...totals, tenants_discovered: run.tenantsDiscovered, tenants_completed: run.tenantsRun, run_id: run.runId };
  } catch (error) {
    error.result = { ...error.result, ...totals };
    throw error;
  }
}

export async function reconcileExposureAdmissionTx(tx, {
  tenantId, patientUid, deviceId, lockedPatientUids, refusePending = true,
}) {
  const tid = requireTenantId(tenantId);
  await assertExposurePatientLocksTx(tx, { tenantId: tid, patientUid, deviceId, lockedPatientUids });
  const relevant = await tx.$queryRawUnsafe(
    `SELECT o.id FROM bloodborne_exposure_outbox o
       JOIN reprocessable_devices d ON d.tenant_id = o.tenant_id AND d.id = $2::bigint
       LEFT JOIN reprocessable_device_dialysis_links l ON l.tenant_id = d.tenant_id AND l.device_id = d.id
       LEFT JOIN reprocessing_domain_settings s ON s.tenant_id = d.tenant_id AND s.domain = d.domain
      WHERE o.tenant_id = $1::uuid
        AND ((d.domain = 'dialysis' AND l.dedicated_patient_uid = o.patient_uid)
          OR EXISTS (SELECT 1 FROM reprocessable_device_usages u
            WHERE u.tenant_id = d.tenant_id AND u.device_id = d.id AND u.patient_uid = o.patient_uid
              AND ((d.domain = 'dialysis' AND u.returned_at IS NULL)
                OR (d.domain = 'ot' AND (o.tested_on IS NULL OR u.captured_at >=
                  ((o.tested_on - COALESCE(s.serology_validity_days, 90) * INTERVAL '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata'))))))
        AND NOT EXISTS (SELECT 1 FROM bloodborne_exposure_applications a
          WHERE a.tenant_id = o.tenant_id AND a.outbox_id = o.id AND a.handler_id = $3 AND a.device_id = d.id)
      LIMIT 1`, tid, deviceId, PLATFORM_EXPOSURE_HANDLER_ID,
  );
  if (relevant.length && refusePending !== false) {
    throw AppError.conflict('Exposure reconciliation is pending', 'RPD_EXPOSURE_RECONCILIATION_PENDING');
  }
  return { complete: relevant.length === 0 };
}
