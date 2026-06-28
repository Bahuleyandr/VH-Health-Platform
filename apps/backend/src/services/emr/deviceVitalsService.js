// src/services/emr/deviceVitalsService.js
//
// Roadmap C5 — ICU monitor / device vitals ingestion.
//
// Monitors (or their gateway) POST HL7 ORU^R01 payloads whose OBX segments
// carry vital-sign LOINCs. Flow:
//   1. Raw payload persisted in the lab_interface_messages inbox
//      (replayable failures, same pattern as B3).
//   2. PID-3 must carry the patient UID (the same identifier the BCMA
//      wristband encodes).
//   3. OBX rows map via the shared LOINC↔vitals table; the row is written
//      through vitalsChartService.recordVitals → NEWS2, anomaly alerts and
//      canonical timeline events all fire; rows are labelled
//      source='device' + UNVERIFIED until a clinician reviews them.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { parseHL7 } from '../hl7/hl7Parser.js';
import { obxResultsToVitals } from '../fhir/observationVitalsMapper.js';
import { recordVitals } from './vitalsChartService.js';
import { recordClinicalAuditEvent } from '../clinical/canonicalClinicalPlatformService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Extract patient uid + OBX observations from a parsed ORU message.
 * Pure given parseHL7 output — exported for unit tests.
 */
export function extractVitalsFromOru(parsed) {
  const segments = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const find = (type) => segments.filter((s) => s.type === type);
  const pid = find('PID')[0];
  // PID-3 (patient identifier list) — first repetition, first component.
  const rawId = pid?.fields?.[3] ?? pid?.fields?.[2] ?? '';
  const candidate = String(rawId || '').split('^')[0].split('~')[0].trim();
  const patientUid = UUID_RE.test(candidate) ? candidate : null;

  const observations = find('OBX').map((obx) => {
    const f = obx.fields || [];
    const codeField = String(f[3] ?? '');
    const code = codeField.split('^')[0].trim();
    const value = String(f[5] ?? '').trim();
    return { loinc_code: code, value_numeric: Number.parseFloat(value), value_text: value };
  }).filter((o) => o.loinc_code);

  return { patientUid, observations };
}

/**
 * Ingest one monitor ORU payload. Inbox row always lands (status
 * ingested/failed); vitals land through the standard write path.
 */
export async function ingestDeviceVitals({
  message, deviceCode = null, tenantId = null,
} = {}, context = {}) {
  // CAN-045: never fall back to a hardcoded default tenant — the caller's
  // authenticated tenant must scope the inbox row, patient lookup and audit.
  if (!tenantId) {
    throw AppError.badRequest('tenantId is required to ingest device vitals', 'DEVICE_VITALS_NO_TENANT');
  }
  if (!message || !String(message).trim().startsWith('MSH|')) {
    throw AppError.badRequest('message must be an HL7 payload starting with MSH|', 'DEVICE_VITALS_BAD_MESSAGE');
  }
  const inserted = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_interface_messages
       (tenant_id, analyzer_code, direction, protocol, message_type, raw_message, status)
     VALUES ($1::uuid, $2, 'inbound', 'hl7v2', 'ORU^VITALS', $3, 'received')
     RETURNING id`,
    tenantId, deviceCode, String(message),
  );
  const messageId = Number(inserted[0].id);

  try {
    const parsed = parseHL7(String(message));
    const { patientUid, observations } = extractVitalsFromOru(parsed);
    if (!patientUid) {
      throw AppError.badRequest(
        'PID-3 must carry the patient UID (the wristband identifier)',
        'DEVICE_VITALS_NO_PATIENT',
      );
    }
    const patientRows = await prisma.$queryRawUnsafe(
      `SELECT uid FROM users WHERE uid = $1::uuid AND tenant_id = $2::uuid LIMIT 1`, patientUid, tenantId,
    );
    if (!patientRows.length) {
      // CAN-045: a patient in another tenant must not be ingested under this one.
      throw AppError.notFound('Patient not found for PID-3 uid', 'DEVICE_VITALS_PATIENT_NOT_FOUND');
    }

    const mapping = obxResultsToVitals(observations);
    if (Object.keys(mapping.vitals).length === 0) {
      throw AppError.badRequest(
        `No vital-sign LOINCs in OBX segments (unmapped: ${mapping.unmapped.join(', ') || 'none'})`,
        'DEVICE_VITALS_NO_MAPPABLE_OBX',
      );
    }

    const result = await recordVitals({
      patient_uid: patientUid,
      ...mapping.vitals,
      source: 'device',
      source_device: deviceCode || 'monitor',
      notes: `Device ORU ingest (${mapping.mapped.join(', ')})`,
      recorded_by: context.actorUid,
    });

    await prisma.$executeRawUnsafe(
      `UPDATE lab_interface_messages SET
         status = 'ingested', result_count = $2::int,
         verdicts = $3::jsonb, processed_at = NOW()
       WHERE id = $1`,
      messageId,
      mapping.mapped.length,
      JSON.stringify({
        mapped: mapping.mapped,
        unmapped: mapping.unmapped,
        vitals_chart_id: result.vitals.id,
        news2: result.news2 ? { total: result.news2.total_score ?? result.news2.totalScore ?? null } : null,
      }),
    );

    return {
      interface_message_id: messageId,
      vitals: result.vitals,
      news2: result.news2,
      alerts: result.alerts,
      mapped: mapping.mapped,
      unmapped: mapping.unmapped,
    };
  } catch (err) {
    await prisma.$executeRawUnsafe(
      `UPDATE lab_interface_messages SET status = 'failed', error = $2, processed_at = NOW() WHERE id = $1`,
      messageId, err?.message || String(err),
    ).catch(() => {});
    if (err instanceof AppError) {
      err.details = { ...(err.details || {}), interface_message_id: messageId };
      throw err;
    }
    logger.error('Device vitals ingestion failed:', err);
    throw AppError.badRequest('Device vitals payload could not be processed', 'DEVICE_VITALS_INGEST_FAILED', {
      interface_message_id: messageId,
    });
  }
}

/** ICU review queue: unverified device vitals, newest first. */
export async function listUnverifiedDeviceVitals({ patientUid = null, limit = 50, tenantId = null } = {}) {
  // CAN-045: scope the review queue to the caller's tenant.
  if (!tenantId) throw AppError.badRequest('tenantId is required', 'DEVICE_VITALS_NO_TENANT');
  const params = [tenantId];
  let where = `source = 'device' AND device_verified = false AND tenant_id = $1::uuid`;
  if (patientUid) {
    params.push(patientUid);
    where += ` AND patient_uid = $${params.length}::uuid`;
  }
  params.push(Math.min(Number.parseInt(limit, 10) || 50, 200));
  return prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, source_device, heart_rate, systolic_bp, diastolic_bp,
            temperature, spo2, respiratory_rate, recorded_at
       FROM vitals_chart
      WHERE ${where}
      ORDER BY recorded_at DESC
      LIMIT $${params.length}::int`,
    ...params,
  );
}

/** Clinician verification of a device vitals row (audited). */
export async function verifyDeviceVitals(vitalsId, context = {}) {
  if (!context.actorUid) throw AppError.unauthorized('Verifier identity missing');
  // CAN-045: scope the verify update to the caller's tenant; no default-tenant.
  if (!context.tenantId) throw AppError.badRequest('tenantId is required', 'DEVICE_VITALS_NO_TENANT');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE vitals_chart SET
       device_verified = true, verified_by = $2::uuid, verified_at = NOW()
     WHERE id = $1 AND source = 'device' AND device_verified = false AND tenant_id = $3::uuid
     RETURNING id, patient_uid, source_device, device_verified, verified_at`,
    vitalsId, context.actorUid, context.tenantId,
  );
  if (!rows.length) {
    throw AppError.notFound('Unverified device vitals row not found', 'DEVICE_VITALS_NOT_FOUND');
  }
  const row = rows[0];
  await recordClinicalAuditEvent({
    tenantId: context.tenantId,
    patientUid: row.patient_uid,
    action: 'vitals.device_verified',
    actorUid: context.actorUid,
    actorRole: context.actorRole || null,
    resourceType: 'vitals',
    resourceTable: 'vitals_chart',
    resourceId: String(row.id),
    afterState: { device_verified: true },
    metadata: { source_device: row.source_device },
    idempotencyKey: `vitals_chart:${row.id}:device_verified`,
  });
  return row;
}

export default {
  extractVitalsFromOru,
  ingestDeviceVitals,
  listUnverifiedDeviceVitals,
  verifyDeviceVitals,
};
