import { setTenantTx } from '../../lib/prisma.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';
import { CORE_MARKERS, registerExposureHandler } from './bloodborneMarkerRules.js';
import { PLATFORM_EXPOSURE_HANDLER_ID } from './bloodborneExposureOutboxService.js';
import { lockPatientExposureTx } from './patientExposureLock.js';
import { placeHoldTx } from './reprocessableDeviceService.js';

const COMPLETE = Object.freeze({
  remaining_device_count: 0, remaining_alert_count: 0, remaining_notification_count: 0,
});

export async function recordPredatingExposureOutcomesTx(tx, { tenantId, patientUid, deviceId, outboxId = null }) {
  return tx.$queryRawUnsafe(
    `WITH locked_device AS (
       SELECT id, tenant_id, domain, created_at, exposure_flag, cycle_count, metadata
         FROM reprocessable_devices WHERE tenant_id = $1::uuid AND id = $3::bigint FOR UPDATE
     ), evaluated AS (
       SELECT event.id AS outbox_id, device.id AS device_id,
              event.occurred_at, device.created_at,
              (event.occurred_at < device.created_at
               AND device.domain = 'dialysis' AND device.exposure_flag = FALSE
               AND device.cycle_count = 0
               AND COALESCE(device.metadata->>'enrolled_mid_life', 'false') = 'false'
               AND NOT EXISTS (SELECT 1 FROM reprocessable_device_usages usage
                 WHERE usage.tenant_id = device.tenant_id AND usage.device_id = device.id)
               AND NOT EXISTS (SELECT 1 FROM reprocessable_device_holds hold
                 WHERE hold.tenant_id = device.tenant_id AND hold.device_id = device.id)) AS predates_creation
         FROM locked_device device
         JOIN bloodborne_exposure_outbox event
           ON event.tenant_id = device.tenant_id AND event.patient_uid = $2::uuid
        WHERE ($4::bigint IS NULL OR event.id = $4::bigint)
     ) INSERT INTO bloodborne_exposure_applications
         (tenant_id, outbox_id, handler_id, device_id, result, metadata)
       SELECT $1::uuid, outbox_id, $5, device_id, 'not_applicable_predates_creation',
              jsonb_build_object('event_occurred_at', occurred_at, 'device_created_at', created_at)
         FROM evaluated WHERE predates_creation
       ON CONFLICT (tenant_id, outbox_id, handler_id, device_id) DO NOTHING
       RETURNING id, hold_id, result`,
    tenantId, patientUid, deviceId, outboxId, PLATFORM_EXPOSURE_HANDLER_ID,
  );
}

export async function findPlatformExposureCandidatesTx(tx, event) {
  return tx.$queryRawUnsafe(
    `SELECT d.id, d.domain, d.status, d.version,
       (SELECT u.id FROM reprocessable_device_usages u
         WHERE u.tenant_id = d.tenant_id AND u.device_id = d.id AND u.patient_uid = $2::uuid
         ORDER BY u.captured_at DESC, u.id DESC LIMIT 1) AS source_usage_id
     FROM reprocessable_devices d
     LEFT JOIN reprocessable_device_dialysis_links l ON l.tenant_id = d.tenant_id AND l.device_id = d.id
     LEFT JOIN reprocessing_domain_settings s ON s.tenant_id = d.tenant_id AND s.domain = d.domain
     WHERE d.tenant_id = $1::uuid AND d.status <> 'discarded'
       AND ((d.domain = 'dialysis' AND l.dedicated_patient_uid = $2::uuid)
         OR EXISTS (SELECT 1 FROM reprocessable_device_usages u
           WHERE u.tenant_id = d.tenant_id AND u.device_id = d.id AND u.patient_uid = $2::uuid
             AND ((d.domain = 'dialysis' AND u.returned_at IS NULL)
               OR (d.domain = 'ot' AND ($3::date IS NULL OR u.captured_at >=
                 (($3::date - COALESCE(s.serology_validity_days, 90) * INTERVAL '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata'))))))
     ORDER BY d.id FOR UPDATE OF d`,
    event.tenantId, event.patientUid, event.testedOn,
  );
}

export async function applyPlatformExposureTx(tx, event, { outboxId }) {
  const candidates = await findPlatformExposureCandidatesTx(tx, event);
  const applications = [];
  for (const device of candidates) {
    await recordPredatingExposureOutcomesTx(tx, {
      tenantId: event.tenantId, patientUid: event.patientUid, deviceId: device.id, outboxId,
    });
    const existing = await tx.$queryRawUnsafe(
      `SELECT id, hold_id, result FROM bloodborne_exposure_applications
        WHERE tenant_id = $1::uuid AND outbox_id = $2::bigint AND handler_id = $3 AND device_id = $4::bigint`,
      event.tenantId, outboxId, PLATFORM_EXPOSURE_HANDLER_ID, device.id,
    );
    if (existing.length) { applications.push(existing[0]); continue; }
    const activeHolds = await tx.$queryRawUnsafe(
      `SELECT id FROM reprocessable_device_holds
        WHERE tenant_id = $1::uuid AND device_id = $2::bigint
          AND hold_type = 'bloodborne_exposure' AND status = 'active'`, event.tenantId, device.id,
    );
    const held = await placeHoldTx(tx, {
      tenantId: event.tenantId, deviceId: Number(device.id), holdType: 'bloodborne_exposure',
      reasonCode: event.testedOn == null ? 'exposure_undated_declaration' : 'exposure_late_result',
      placedVia: 'exposure_handler', sourceMarkerRowId: event.markerRowId,
      sourceUsageId: device.source_usage_id == null ? null : Number(device.source_usage_id),
      expectedVersion: Number(device.version),
    });
    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO bloodborne_exposure_applications
         (tenant_id, outbox_id, handler_id, device_id, hold_id, source_usage_id, result)
       VALUES ($1::uuid, $2::bigint, $3, $4::bigint, $5::bigint, $6::bigint, $7::text)
       RETURNING id, hold_id, result`,
      event.tenantId, outboxId, PLATFORM_EXPOSURE_HANDLER_ID, device.id, held.hold.id, device.source_usage_id,
      activeHolds.length ? 'hold_associated' : 'hold_created',
    );
    applications.push(inserted[0]);
  }
  return applications;
}

export async function applyPlatformExposure(event, { outboxId } = {}) {
  if (!CORE_MARKERS.includes(event.marker)) return { ...COMPLETE };
  if (!outboxId) throw new TypeError('Platform exposure requires its durable outbox identity');
  return setTenantTx(event.tenantId, async tx => {
    await lockPatientExposureTx(tx, event);
    await applyPlatformExposureTx(tx, event, { outboxId });
    const applications = await tx.$queryRawUnsafe(
      `SELECT device_id, hold_id, result FROM bloodborne_exposure_applications
        WHERE tenant_id = $1::uuid AND outbox_id = $2::bigint AND handler_id = $3 ORDER BY device_id`,
      event.tenantId, outboxId, PLATFORM_EXPOSURE_HANDLER_ID,
    );
    const applied = applications.filter(row => row.result !== 'not_applicable_predates_creation');
    const partition = {
      application_count: applications.length, applied_count: applied.length,
      not_applicable_predates_creation_count: applications.length - applied.length,
    };
    if (!applied.length) return { ...COMPLETE, ...partition };
    const deviceIds = applied.map(row => Number(row.device_id));
    await tx.$queryRawUnsafe(
      `INSERT INTO cds_alerts (tenant_id, patient_uid, alert_type, severity, title, description, source_data)
       SELECT $1::uuid, $2::uuid, 'reprocessable_device_exposure', 'high',
              'Reprocessable devices require infection-control review',
              $3::text, $4::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM cds_alerts
          WHERE tenant_id = $1::uuid AND alert_type = 'reprocessable_device_exposure'
            AND source_data ->> 'exposure_outbox_id' = $5::text)
        RETURNING id`,
      event.tenantId, event.patientUid,
      event.testedOn == null ? 'Undated evidence requires review of the recorded device uses.' : 'Recorded device uses require infection-control review.',
      JSON.stringify({ exposure_outbox_id: outboxId, device_ids: deviceIds }), String(outboxId),
    );
    const officers = await tx.$queryRawUnsafe(
      `SELECT id, uid FROM users WHERE tenant_id = $1::uuid AND role = 'INFECTION_CONTROL_OFFICER'
        AND is_active = TRUE AND status = 'active' AND COALESCE(is_deleted, FALSE) = FALSE ORDER BY id`,
      event.tenantId,
    );
    for (const officer of officers) {
      await notificationOutbox.queue({
        tenantId: event.tenantId, type: 'reprocessable_device_exposure', channel: 'inapp',
        recipientId: officer.id, title: 'Reprocessable devices require review',
        body: event.testedOn == null ? 'Undated exposure evidence requires infection-control review.' : 'Exposure evidence requires infection-control review.',
        sourceEventKey: `reprocessable-exposure:${outboxId}:${officer.uid}`,
        templateVersion: 'reprocessable-exposure.v1',
        data: { kind: 'reprocessable_device_exposure', exposure_outbox_id: outboxId },
      }, { tx, strict: true });
    }
    return { ...COMPLETE, ...partition };
  });
}

registerExposureHandler({ id: PLATFORM_EXPOSURE_HANDLER_ID, apply: applyPlatformExposure });
