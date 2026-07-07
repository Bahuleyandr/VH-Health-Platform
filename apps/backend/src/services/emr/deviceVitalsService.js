// src/services/emr/deviceVitalsService.js
//
// Roadmap C5 / NL-7 P1 — bedside monitor and device-gateway vitals ingestion.
//
// Staff/direct senders retain the PID-3 patient UID path. DEVICE_GATEWAY callers
// may send an optional patient_uid or rely on an active device association; the
// service never guesses a patient from bed/location context.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { parseHL7 } from '../hl7/hl7Parser.js';
import { obxResultsToVitals } from '../fhir/observationVitalsMapper.js';
import { recordVitals } from './vitalsChartService.js';
import { recordClinicalAuditEvent } from '../clinical/canonicalClinicalPlatformService.js';
import {
  authenticateDeviceCredential,
  getActiveDeviceByCode,
  resolveDeviceBySourceIp,
  touchDeviceSeen,
} from '../devices/deviceRegistryService.js';
import { resolveActiveAssociation } from '../devices/deviceAssociationService.js';
import { classifyVitalAnomalyCandidates } from '../../utils/clinical/vitalSignMonitor.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_GATEWAY_ROLE = 'DEVICE_GATEWAY';
const NEWS2_RELEVANT_FIELDS = new Set([
  'heart_rate',
  'systolic_bp',
  'temperature',
  'spo2',
  'respiratory_rate',
  'consciousness',
]);

/**
 * Extract patient uid + OBX observations from a parsed ORU message.
 * Pure given parseHL7 output — exported for unit tests.
 */
export function extractVitalsFromOru(parsed) {
  const segments = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const find = (type) => segments.filter((s) => s.type === type);
  const pid = find('PID')[0];
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

export function extractDeviceMessageMeta(parsed = {}) {
  const channel = String(parsed.pv1?.assignedLocation || parsed.obr?.fillerOrderNumber || '')
    .split('^')[0]
    .trim();
  return {
    controlId: String(parsed.msh?.messageControlId || '').trim() || null,
    messageType: String(parsed.msh?.messageType || '').trim() || 'ORU^R01',
    sourceDeviceCode: String(parsed.msh?.sendingApp || parsed.msh?.sendingFacility || '').trim() || null,
    channel,
  };
}

function gatewayContext(context = {}) {
  return String(context.actorRole || '').toUpperCase() === DEVICE_GATEWAY_ROLE;
}

function cleanUuid(value) {
  const text = value == null ? '' : String(value).trim();
  return UUID_RE.test(text) ? text : null;
}

function cleanText(value, max = 255) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function vitalsForAlertCheck(vitals = {}) {
  const out = {};
  if (vitals.heart_rate != null) out.heart_rate = vitals.heart_rate;
  if (vitals.systolic_bp != null) out.systolic_bp = vitals.systolic_bp;
  if (vitals.diastolic_bp != null) out.diastolic_bp = vitals.diastolic_bp;
  if (vitals.temperature != null) out.temperature = vitals.temperature;
  if (vitals.spo2 != null) out.oxygen_saturation = vitals.spo2;
  if (vitals.respiratory_rate != null) out.respiratory_rate = vitals.respiratory_rate;
  return out;
}

async function insertInterfaceMessage({
  tenantId,
  deviceCode,
  message,
  status = 'received',
  errorText = null,
  verdicts = null,
} = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_interface_messages
       (tenant_id, analyzer_code, direction, protocol, message_type, raw_message, status, error, verdicts, processed_at)
     VALUES ($1::uuid, $2, 'inbound', 'hl7v2', 'ORU^VITALS', $3, $4::text, $5, $6::jsonb,
             CASE WHEN $4::text IN ('ingested', 'failed') THEN NOW() ELSE NULL END)
     RETURNING id`,
    tenantId,
    deviceCode,
    String(message),
    status,
    errorText,
    verdicts ? JSON.stringify(verdicts) : null,
  );
  return Number(rows[0].id);
}

async function updateInterfaceMessage(messageId, { status, errorText = null, resultCount = null, verdicts = null } = {}) {
  await prisma.$executeRawUnsafe(
    `UPDATE lab_interface_messages SET
       status = $2,
       result_count = $3::int,
       error = $4,
       verdicts = $5::jsonb,
       processed_at = NOW()
     WHERE id = $1`,
    messageId,
    status,
    resultCount,
    errorText,
    verdicts ? JSON.stringify(verdicts) : null,
  );
}

async function assertPatientInTenant(patientUid, tenantId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, uid, tenant_id
       FROM users
      WHERE uid = $1::uuid AND tenant_id = $2::uuid
      LIMIT 1`,
    patientUid,
    tenantId,
  );
  if (!rows.length) {
    throw AppError.notFound('Patient not found for PID-3 uid', 'DEVICE_VITALS_PATIENT_NOT_FOUND');
  }
  return rows[0];
}

async function findDeviceRegistry({ tenantId, deviceCode, context }) {
  const isGateway = gatewayContext(context);
  if (!isGateway) return null;
  const device = await getActiveDeviceByCode({ tenantId, deviceCode });
  if (!device) {
    throw AppError.forbidden('Unknown or inactive device', 'DEVICE_AUTH_REFUSED');
  }
  return device;
}

async function markControlId({ tenantId, deviceId, controlId }) {
  if (!controlId || !deviceId) return { duplicate: false, controlIdRowId: null };
  await prisma.$executeRawUnsafe(
    `DELETE FROM device_vitals_control_ids WHERE expires_at < NOW()`,
  ).catch(() => {});
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO device_vitals_control_ids
       (tenant_id, device_registry_id, control_id)
     VALUES ($1::uuid, $2, $3)
     ON CONFLICT (tenant_id, device_registry_id, control_id) DO NOTHING
     RETURNING id`,
    tenantId,
    deviceId,
    controlId,
  );
  return { duplicate: rows.length === 0, controlIdRowId: rows[0]?.id ?? null };
}

async function linkControlId(rowId, messageId) {
  if (!rowId || !messageId) return;
  await prisma.$executeRawUnsafe(
    `UPDATE device_vitals_control_ids
        SET interface_message_id = $2
      WHERE id = $1`,
    rowId,
    messageId,
  ).catch(() => {});
}

async function countSuppressed({ tenantId, deviceId, reason }) {
  if (!deviceId || !reason) return;
  await prisma.$executeRawUnsafe(
    `INSERT INTO device_vital_suppression_counters (tenant_id, device_registry_id, reason, count, updated_at)
     VALUES ($1::uuid, $2, $3, 1, NOW())
     ON CONFLICT (tenant_id, device_registry_id, reason)
     DO UPDATE SET count = device_vital_suppression_counters.count + 1, updated_at = NOW()`,
    tenantId,
    deviceId,
    reason,
  ).catch((err) => logger.warn(`Device suppression counter failed: ${err?.message || err}`));
}

async function latestDeviceVitals({ tenantId, patientUid, sourceDevice }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT heart_rate, systolic_bp, diastolic_bp, temperature, spo2, respiratory_rate, recorded_at
       FROM vitals_chart
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND source = 'device'
        AND source_device = $3
      ORDER BY recorded_at DESC
      LIMIT 1`,
    tenantId,
    patientUid,
    sourceDevice,
  );
  return rows[0] || null;
}

function hasNews2RelevantDelta(vitals = {}, latest = null) {
  if (!latest) return true;
  for (const [field, value] of Object.entries(vitals)) {
    if (!NEWS2_RELEVANT_FIELDS.has(field)) continue;
    if (value == null) continue;
    const previous = latest[field];
    if (previous == null) return true;
    if (Number(previous) !== Number(value)) return true;
  }
  return false;
}

function withinChartingInterval(latest = null, intervalMinutes = 5) {
  if (!latest?.recorded_at) return false;
  const ageMs = Date.now() - new Date(latest.recorded_at).getTime();
  return ageMs >= 0 && ageMs < intervalMinutes * 60 * 1000;
}

async function artifactVerdicts({ tenantId, device, patientUid, channel, candidates }) {
  const verdicts = {};
  if (!device || candidates.length === 0) return verdicts;
  const required = Number(device.artifact_filter_required ?? 2);
  const windowSize = Number(device.artifact_filter_window ?? 3);
  for (const candidate of candidates) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO device_vital_sample_observations
         (tenant_id, device_registry_id, patient_uid, channel, vital_name, severity, breached)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, true)`,
      tenantId,
      device.id,
      patientUid,
      channel || '',
      candidate.vital_name,
      candidate.severity,
    ).catch((err) => logger.warn(`Device artifact observation failed: ${err?.message || err}`));
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS breached
         FROM (
           SELECT breached
             FROM device_vital_sample_observations
            WHERE tenant_id = $1::uuid
              AND device_registry_id = $2
              AND patient_uid = $3::uuid
              AND channel = $4
              AND vital_name = $5
            ORDER BY observed_at DESC
            LIMIT $6::int
         ) recent
        WHERE breached = true`,
      tenantId,
      device.id,
      patientUid,
      channel || '',
      candidate.vital_name,
      windowSize,
    );
    const corroborated = Number(rows[0]?.breached ?? 0) >= required;
    verdicts[candidate.vital_name] = { corroborated, required, window: windowSize };
    if (!corroborated) {
      await countSuppressed({ tenantId, deviceId: device.id, reason: 'artifact_filter' });
    }
  }
  return verdicts;
}

async function hasOpenRepeatAlert(patientId, candidate, windows) {
  const fallback = candidate.severity === 'CRITICAL' ? 10 : 30;
  const windowMinutes = Number.parseInt(windows?.[candidate.severity] ?? fallback, 10) || fallback;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM clinical_alerts
      WHERE patient_id = $1::int
        AND vital_name = $2
        AND severity = $3
        AND COALESCE(acknowledged, false) = false
        AND acknowledged_at IS NULL
        AND created_at >= NOW() - ($4::int * INTERVAL '1 minute')
      LIMIT 1`,
    patientId,
    candidate.vital_name,
    candidate.severity,
    windowMinutes,
  );
  return rows.length > 0;
}

async function buildAlertOptions({ tenantId, device, patientRow, patientUid, channel, vitals }) {
  if (!device) return null;
  const candidates = await classifyVitalAnomalyCandidates(patientRow.id, vitalsForAlertCheck(vitals));
  const windows = {
    CRITICAL: Number(device.critical_suppression_window_minutes ?? 10),
    WARNING: Number(device.warning_suppression_window_minutes ?? 30),
  };
  for (const candidate of candidates) {
    if (await hasOpenRepeatAlert(patientRow.id, candidate, windows)) {
      await countSuppressed({ tenantId, deviceId: device.id, reason: 'repeat_window' });
    }
  }
  return {
    suppressRepeats: true,
    suppressionWindows: windows,
    artifactVerdicts: await artifactVerdicts({
      tenantId,
      device,
      patientUid,
      channel,
      candidates,
    }),
  };
}

async function shouldChartDeviceVitals({ tenantId, device, patientUid, sourceDevice, vitals, patientRow }) {
  if (!device) return { persist: true, reason: null, candidates: [] };
  const candidates = await classifyVitalAnomalyCandidates(patientRow.id, vitalsForAlertCheck(vitals));
  if (candidates.length > 0) return { persist: true, reason: 'breach', candidates };
  const latest = await latestDeviceVitals({ tenantId, patientUid, sourceDevice });
  if (!withinChartingInterval(latest, Number(device.charting_interval_minutes ?? 5))) {
    return { persist: true, reason: 'interval_due', candidates };
  }
  if (hasNews2RelevantDelta(vitals, latest)) {
    return { persist: true, reason: 'news2_delta', candidates };
  }
  await countSuppressed({ tenantId, deviceId: device.id, reason: 'charting_interval' });
  return { persist: false, reason: 'charting_interval', candidates };
}

async function resolveGatewayPatient({
  tenantId,
  device,
  channel,
  patientUid,
  pidPatientUid,
  message,
  deviceCode,
  controlId,
}) {
  const requested = cleanUuid(patientUid) || pidPatientUid;
  if (requested) return { patientUid: requested, association: null };
  const association = await resolveActiveAssociation({
    tenantId,
    deviceId: device.id,
    channel,
  });
  if (association?.patient_uid) {
    return { patientUid: association.patient_uid, association };
  }
  const messageId = await insertInterfaceMessage({
    tenantId,
    deviceCode,
    message,
    status: 'failed',
    errorText: 'DEVICE_NOT_ASSOCIATED',
    verdicts: { code: 'DEVICE_NOT_ASSOCIATED', control_id: controlId, channel: channel || '' },
  });
  throw AppError.badRequest('Device is not associated to a patient', 'DEVICE_NOT_ASSOCIATED', {
    interface_message_id: messageId,
  });
}

/**
 * Ingest one monitor ORU payload. Direct senders produce an inbox row for every
 * attempt. Gateway-originated suppressed/duplicate samples are dropped without
 * an inbox row; unassociated failures are parked as failed, replayable inbox
 * messages.
 */
export async function ingestDeviceVitals({
  message,
  deviceCode = null,
  tenantId = null,
  patientUid = null,
  channel = null,
} = {}, context = {}) {
  if (!tenantId) {
    throw AppError.badRequest('tenantId is required to ingest device vitals', 'DEVICE_VITALS_NO_TENANT');
  }
  if (!message || !String(message).trim().startsWith('MSH|')) {
    throw AppError.badRequest('message must be an HL7 payload starting with MSH|', 'DEVICE_VITALS_BAD_MESSAGE');
  }

  const isGateway = gatewayContext(context);
  let messageId = null;
  let controlIdRowId = null;

  try {
    const parsed = parseHL7(String(message));
    const { patientUid: pidPatientUid, observations } = extractVitalsFromOru(parsed);
    const meta = extractDeviceMessageMeta(parsed);
    const normalizedDeviceCode = cleanText(deviceCode || meta.sourceDeviceCode, 120) || 'monitor';
    const normalizedChannel = cleanText(channel || meta.channel, 80) || '';
    const device = await findDeviceRegistry({
      tenantId,
      deviceCode: normalizedDeviceCode,
      context,
    });

    if (!isGateway) {
      messageId = await insertInterfaceMessage({
        tenantId,
        deviceCode: normalizedDeviceCode,
        message,
        status: 'received',
      });
    } else {
      const control = await markControlId({
        tenantId,
        deviceId: device.id,
        controlId: meta.controlId,
      });
      if (control.duplicate) {
        await countSuppressed({ tenantId, deviceId: device.id, reason: 'duplicate_control_id' });
        return {
          duplicate: true,
          ack: 'AA',
          control_id: meta.controlId,
          mapped: [],
          unmapped: [],
        };
      }
      controlIdRowId = control.controlIdRowId;
    }

    const resolved = isGateway
      ? await resolveGatewayPatient({
        tenantId,
        device,
        channel: normalizedChannel,
        patientUid,
        pidPatientUid,
        message,
        deviceCode: normalizedDeviceCode,
        controlId: meta.controlId,
      })
      : { patientUid: pidPatientUid, association: null };

    if (!resolved.patientUid) {
      throw AppError.badRequest(
        'PID-3 must carry the patient UID (the wristband identifier)',
        'DEVICE_VITALS_NO_PATIENT',
      );
    }
    const patientRow = await assertPatientInTenant(resolved.patientUid, tenantId);

    const mapping = obxResultsToVitals(observations);
    if (Object.keys(mapping.vitals).length === 0) {
      throw AppError.badRequest(
        `No vital-sign LOINCs in OBX segments (unmapped: ${mapping.unmapped.join(', ') || 'none'})`,
        'DEVICE_VITALS_NO_MAPPABLE_OBX',
      );
    }

    if (isGateway) {
      const chartDecision = await shouldChartDeviceVitals({
        tenantId,
        device,
        patientUid: resolved.patientUid,
        sourceDevice: normalizedDeviceCode,
        vitals: mapping.vitals,
        patientRow,
      });
      if (!chartDecision.persist) {
        return {
          suppressed: true,
          reason: chartDecision.reason,
          ack: 'AA',
          control_id: meta.controlId,
          mapped: mapping.mapped,
          unmapped: mapping.unmapped,
        };
      }
      messageId = await insertInterfaceMessage({
        tenantId,
        deviceCode: normalizedDeviceCode,
        message,
        status: 'received',
      });
      await linkControlId(controlIdRowId, messageId);
      await touchDeviceSeen({ tenantId, id: device.id });
    }

    const alertOptions = await buildAlertOptions({
      tenantId,
      device,
      patientRow,
      patientUid: resolved.patientUid,
      channel: normalizedChannel,
      vitals: mapping.vitals,
    });

    const result = await recordVitals({
      tenant_id: tenantId,
      patient_uid: resolved.patientUid,
      ...mapping.vitals,
      source: 'device',
      source_device: normalizedDeviceCode,
      notes: `Device ORU ingest (${mapping.mapped.join(', ')})`,
      recorded_by: context.actorUid,
      alertOptions,
    });

    if (messageId) {
      await updateInterfaceMessage(messageId, {
        status: 'ingested',
        resultCount: mapping.mapped.length,
        verdicts: {
          mapped: mapping.mapped,
          unmapped: mapping.unmapped,
          vitals_chart_id: result.vitals.id,
          news2: result.news2 ? { total: result.news2.total_score ?? result.news2.totalScore ?? null } : null,
          control_id: meta.controlId,
          device_registry_id: device?.id ?? null,
          association_id: resolved.association?.id ?? null,
        },
      });
    }

    return {
      interface_message_id: messageId,
      vitals: result.vitals,
      news2: result.news2,
      alerts: result.alerts,
      mapped: mapping.mapped,
      unmapped: mapping.unmapped,
      ack: 'AA',
      control_id: meta.controlId,
    };
  } catch (err) {
    if (controlIdRowId && err instanceof AppError && err.code === 'DEVICE_NOT_ASSOCIATED') {
      await linkControlId(controlIdRowId, err.details?.interface_message_id || messageId);
      await prisma.$executeRawUnsafe(
        `DELETE FROM device_vitals_control_ids WHERE id = $1`,
        controlIdRowId,
      ).catch(() => {});
    }
    if (messageId) {
      await updateInterfaceMessage(messageId, {
        status: 'failed',
        errorText: err?.code || err?.message || String(err),
        verdicts: { code: err?.code || 'DEVICE_VITALS_INGEST_FAILED' },
      }).catch(() => {});
    }
    if (err instanceof AppError) {
      err.details = { ...(err.details || {}), interface_message_id: messageId || err.details?.interface_message_id };
      throw err;
    }
    logger.error('Device vitals ingestion failed:', err);
    throw AppError.badRequest('Device vitals payload could not be processed', 'DEVICE_VITALS_INGEST_FAILED', {
      interface_message_id: messageId,
    });
  }
}

export async function resolveDeviceForGateway({
  tenantId,
  sourceIp = null,
  bearerToken = null,
  deviceCode = null,
  channel = '',
} = {}) {
  const token = cleanText(bearerToken, 255);
  const device = token
    ? await authenticateDeviceCredential({ tenantId, plaintext: token, sourceIp, deviceCode })
    : await resolveDeviceBySourceIp({ tenantId, sourceIp, deviceCode });
  if (!device) {
    throw AppError.forbidden('Unknown, revoked, or source-IP-mismatched device', 'DEVICE_AUTH_REFUSED');
  }
  const association = await resolveActiveAssociation({
    tenantId,
    deviceId: device.id,
    channel: cleanText(channel, 80) || '',
  });
  return {
    device,
    association,
    patient_uid: association?.patient_uid ?? null,
  };
}

/** ICU review queue: unverified device vitals, newest first. */
export async function listUnverifiedDeviceVitals({ patientUid = null, limit = 50, tenantId = null } = {}) {
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
  if (!context.tenantId) throw AppError.badRequest('tenantId is required', 'DEVICE_VITALS_NO_TENANT');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE vitals_chart SET
       device_verified = true, verified_by = $2::uuid, verified_at = NOW()
     WHERE id = $1 AND source = 'device' AND device_verified = false AND tenant_id = $3::uuid
     RETURNING id, patient_uid, source_device, device_verified, verified_at`,
    vitalsId,
    context.actorUid,
    context.tenantId,
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
  extractDeviceMessageMeta,
  ingestDeviceVitals,
  resolveDeviceForGateway,
  listUnverifiedDeviceVitals,
  verifyDeviceVitals,
};
