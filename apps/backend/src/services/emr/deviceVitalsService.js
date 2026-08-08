// src/services/emr/deviceVitalsService.js
//
// Roadmap C5 / NL-7 P1 — bedside monitor and device-gateway vitals ingestion.
//
// Staff/direct senders retain the PID-3 patient UID path. DEVICE_GATEWAY callers
// may send an optional patient_uid or rely on an active device association; the
// service never guesses a patient from bed/location context.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { parseHL7 } from '../hl7/hl7Parser.js';
import { obxResultsToVitals } from '../fhir/observationVitalsMapper.js';
import { recordVitals } from './vitalsChartService.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import {
  authenticateDeviceCredential,
  getActiveDeviceByCode,
  resolveDeviceBySourceIp,
  touchDeviceSeen,
} from '../devices/deviceRegistryService.js';
import { resolveActiveAssociation } from '../devices/deviceAssociationService.js';
import { classifyVitalAnomalyCandidates } from '../../utils/clinical/vitalSignMonitor.js';
import {
  enqueueExternalRecoveryItem,
  processNextItemTx,
  readExternalRecoveryResumeState,
} from '../integrations/externalInterfaceRecoveryService.js';
import { validateI09GatewayRecovery } from '../integrations/externalVitalsRecoveryService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_GATEWAY_ROLE = 'DEVICE_GATEWAY';
const OBSERVED_AT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const NEWS2_RELEVANT_FIELDS = new Set([
  'heart_rate',
  'systolic_bp',
  'temperature',
  'spo2',
  'respiratory_rate',
  'consciousness',
]);

/**
 * Parse an HL7 v2 TS value — `YYYYMMDD[HH[MM[SS[.S+]]]][±ZZZZ]` — into a JS
 * Date. An explicit ±ZZZZ offset is honored; offset-less timestamps are
 * interpreted as server-local time (bedside monitors are set to ward wall
 * clocks). Returns null for empty/invalid input. Pure — exported for unit
 * tests.
 */
export function parseHl7Timestamp(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const m = raw.match(
    /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(?:(\d{2})(?:(\d{2})(?:\.(\d+))?)?)?)?([+-]\d{4})?$/,
  );
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, frac, offset] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return null;
  const hours = Number(hh ?? 0);
  const minutes = Number(mm ?? 0);
  const seconds = Number(ss ?? 0);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  const ms = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0;
  let date;
  if (offset) {
    const sign = offset[0] === '-' ? -1 : 1;
    const offsetMinutes = sign * ((Number(offset.slice(1, 3)) * 60) + Number(offset.slice(3, 5)));
    date = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds, ms) - (offsetMinutes * 60 * 1000));
  } else {
    date = new Date(year, month - 1, day, hours, minutes, seconds, ms);
  }
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Extract patient uid + OBX observations from a parsed ORU message, plus the
 * device observation timestamp: the first valid OBX-14 across OBX segments,
 * else OBR-7 from the first OBR segment, else null (`observedAt`), with
 * `observedAtSource` naming which field supplied it ('obx14' | 'obr7' | null).
 * Pure given parseHL7 output — exported for unit tests.
 */
export function extractVitalsFromOru(parsed) {
  const segments = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const find = (type) => segments.filter((s) => s.type === type);
  const pid = find('PID')[0];
  const rawId = pid?.fields?.[3] ?? pid?.fields?.[2] ?? '';
  const candidate = String(rawId || '').split('^')[0].split('~')[0].trim();
  const patientUid = UUID_RE.test(candidate) ? candidate : null;

  const obxSegments = find('OBX');
  const observations = obxSegments.map((obx) => {
    const f = obx.fields || [];
    const codeField = String(f[3] ?? '');
    const code = codeField.split('^')[0].trim();
    const value = String(f[5] ?? '').trim();
    return { loinc_code: code, value_numeric: Number.parseFloat(value), value_text: value };
  }).filter((o) => o.loinc_code);

  let observedAt = null;
  let observedAtSource = null;
  for (const obx of obxSegments) {
    const parsedTs = parseHl7Timestamp(obx.fields?.[14]);
    if (parsedTs) {
      observedAt = parsedTs;
      observedAtSource = 'obx14';
      break;
    }
  }
  if (!observedAt) {
    const obr = find('OBR')[0];
    const parsedTs = parseHl7Timestamp(obr?.fields?.[7]);
    if (parsedTs) {
      observedAt = parsedTs;
      observedAtSource = 'obr7';
    }
  }

  return { patientUid, observations, observedAt, observedAtSource };
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

async function updateInterfaceMessage(messageId, { status, errorText = null, resultCount = null, verdicts = null } = {}, db = prisma) {
  await db.$executeRawUnsafe(
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

// C-M3: the control-id ledger is consulted (read-only) at the top of the
// gateway branch and CONSUMED (inserted) only once the outcome of this
// delivery is durable or definitive — charted vitals, or a deliberate
// suppression. A transient failure leaves no row behind, so the gateway's
// redelivery of the same control-id is re-processed instead of being
// swallowed as a duplicate AA while the sample was never charted.
async function isDuplicateControlId({ tenantId, deviceId, controlId }) {
  if (!controlId || !deviceId) return false;
  await prisma.$executeRawUnsafe(
    `DELETE FROM device_vitals_control_ids WHERE expires_at < NOW()`,
  ).catch(() => {});
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM device_vitals_control_ids
      WHERE tenant_id = $1::uuid
        AND device_registry_id = $2
        AND control_id = $3
        AND expires_at >= NOW()
      LIMIT 1`,
    tenantId,
    deviceId,
    controlId,
  );
  return rows.length > 0;
}

async function consumeControlId({ tenantId, deviceId, controlId, messageId = null, db = prisma }) {
  if (!controlId || !deviceId) return { consumed: false, conflict: false };
  const rows = await db.$queryRawUnsafe(
    `INSERT INTO device_vitals_control_ids
       (tenant_id, device_registry_id, control_id, interface_message_id)
     VALUES ($1::uuid, $2, $3, $4::int)
     ON CONFLICT (tenant_id, device_registry_id, control_id) DO NOTHING
     RETURNING id`,
    tenantId,
    deviceId,
    controlId,
    messageId,
  );
  return { consumed: rows.length > 0, conflict: rows.length === 0 };
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

  try {
    const parsed = parseHL7(String(message));
    const {
      patientUid: pidPatientUid,
      observations,
      observedAt: rawObservedAt,
      observedAtSource: rawObservedAtSource,
    } = extractVitalsFromOru(parsed);
    // C-L5: stamp the vitals row with the device's observation time rather
    // than the drain/receipt time. Guard against device clock skew — an
    // observation timestamp more than 5 minutes in the future is ignored and
    // the row falls back to the receipt time (NOW()).
    const futureSkewMs = rawObservedAt ? rawObservedAt.getTime() - Date.now() : 0;
    const observedAt = rawObservedAt && futureSkewMs <= OBSERVED_AT_MAX_FUTURE_SKEW_MS
      ? rawObservedAt
      : null;
    const observedAtSource = observedAt ? rawObservedAtSource : 'receipt-fallback';
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
      // C-M3: duplicate CHECK only — the control-id is consumed later, once
      // the outcome is durable (charted) or definitive (suppressed).
      const duplicate = await isDuplicateControlId({
        tenantId,
        deviceId: device.id,
        controlId: meta.controlId,
      });
      if (duplicate) {
        await countSuppressed({ tenantId, deviceId: device.id, reason: 'duplicate_control_id' });
        return {
          duplicate: true,
          ack: 'AA',
          control_id: meta.controlId,
          mapped: [],
          unmapped: [],
        };
      }
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
        // Suppression is a definitive AA outcome — consume the control-id so
        // a gateway redelivery of the same sample dedupes instead of being
        // re-evaluated.
        await consumeControlId({
          tenantId,
          deviceId: device.id,
          controlId: meta.controlId,
        });
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
      // C-L5: device observation time (OBX-14 / OBR-7) when present and sane;
      // undefined falls back to NOW() (receipt time) inside recordVitals.
      ...(observedAt ? { recorded_at: observedAt } : {}),
      alertOptions,
    });

    const successVerdicts = {
      mapped: mapping.mapped,
      unmapped: mapping.unmapped,
      vitals_chart_id: result.vitals.id,
      news2: result.news2 ? { total: result.news2.total_score ?? result.news2.totalScore ?? null } : null,
      control_id: meta.controlId,
      device_registry_id: device?.id ?? null,
      association_id: resolved.association?.id ?? null,
      // Receipt-vs-observation audit trail: the lab_interface_messages row's
      // own timestamps stay the receipt time; the verdicts carry the device
      // observation time actually stamped on the vitals row (null when the
      // receipt fallback was used) and which source supplied it.
      observed_at: observedAt ? observedAt.toISOString() : null,
      observed_at_source: observedAtSource,
    };

    if (isGateway) {
      // C-M3: consume the control-id and flip the interface message to
      // 'ingested' atomically, only AFTER the vitals write is durable. If a
      // concurrent identical delivery won the insert race, the vitals are
      // already durably written — log and keep returning success.
      await setTenantTx(tenantId, async (tx) => {
        if (messageId) {
          await updateInterfaceMessage(messageId, {
            status: 'ingested',
            resultCount: mapping.mapped.length,
            verdicts: successVerdicts,
          }, tx);
        }
        const consumed = await consumeControlId({
          tenantId,
          deviceId: device.id,
          controlId: meta.controlId,
          messageId,
          db: tx,
        });
        if (consumed.conflict) {
          logger.warn(
            `Device vitals control-id ${meta.controlId} already consumed by a concurrent delivery `
            + `(device_registry_id=${device.id}); vitals_chart row ${result.vitals.id} is durably written`,
          );
        }
      });
    } else if (messageId) {
      await updateInterfaceMessage(messageId, {
        status: 'ingested',
        resultCount: mapping.mapped.length,
        verdicts: successVerdicts,
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
    // C-M3: no control-id row exists on any failure path (consumption happens
    // only after a durable/definitive outcome), so the gateway's retry of the
    // same control-id is re-processed rather than dropped. DEVICE_NOT_ASSOCIATED
    // still parks its failed, replayable interface message (written inside
    // resolveGatewayPatient).
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

export async function ingestSequencedDeviceVitalsRecovery(input = {}, context = {}) {
  if (!gatewayContext(context)) {
    throw AppError.forbidden(
      'I09 recovery is accepted only from DEVICE_GATEWAY callers',
      'EXTERNAL_RECOVERY_GATEWAY_REQUIRED',
    );
  }
  const prepared = await setTenantTx(input.tenantId, (tx) => validateI09GatewayRecovery({
    tenantId: input.tenantId,
    message: input.message,
    deviceCode: input.deviceCode,
    patientUid: input.patientUid,
    channel: input.channel,
    recovery: input.recovery,
  }, { tx }));
  const operation = {
    tenantId: input.tenantId,
    offsetId: prepared.offsetId,
    interfaceFamily: prepared.interfaceFamily,
    sourcePartition: prepared.sourcePartition,
    generation: prepared.generation,
    sourcePosition: prepared.sourcePosition,
    sourceToken: prepared.sourceToken,
    predecessorToken: prepared.predecessorToken,
    duplicateKey: prepared.duplicateKey,
    occurredAt: prepared.occurredAt,
    command: {
      ...prepared.command,
      actor_uid: context.actorUid || null,
    },
    commandFingerprint: prepared.commandFingerprint,
  };
  const queued = await enqueueExternalRecoveryItem(operation);
  if (queued.held) {
    throw AppError.conflict(
      'Canonical I09 recovery marker is missing; owner reconciliation is required',
      'EXTERNAL_RECOVERY_MARKER_MISSING',
    );
  }
  if (queued.duplicate) return queued;
  return processNextItemTx(operation);
}

export async function readI09GatewayRecoveryResumeState({
  tenantId,
  gatewayRegistryId,
  deviceRegistryId,
} = {}, context = {}) {
  if (!gatewayContext(context)) {
    throw AppError.forbidden(
      'I09 recovery resume state is available only to DEVICE_GATEWAY callers',
      'EXTERNAL_RECOVERY_GATEWAY_REQUIRED',
    );
  }
  const gatewayId = Number(gatewayRegistryId);
  const deviceId = Number(deviceRegistryId);
  if (!Number.isSafeInteger(gatewayId) || gatewayId < 1
    || !Number.isSafeInteger(deviceId) || deviceId < 1) {
    throw AppError.badRequest(
      'gateway_registry_id and device_registry_id must be positive integers',
      'EXTERNAL_RECOVERY_INPUT_INVALID',
    );
  }
  await setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, kind FROM device_registry
        WHERE tenant_id = $1::uuid AND id IN ($2::integer, $3::integer)
          AND status = 'active'`,
      tenantId, gatewayId, deviceId,
    );
    const gateway = rows.find((row) => Number(row.id) === gatewayId);
    const device = rows.find((row) => Number(row.id) === deviceId);
    if (
      gatewayId === deviceId
      || gateway?.kind !== 'monitor_gateway'
      || device?.kind !== 'monitor'
    ) {
      throw AppError.forbidden(
        'Distinct monitor_gateway and monitor device identities must be active in the authenticated tenant',
        'EXTERNAL_RECOVERY_DEVICE_REFUSED',
      );
    }
  });
  return readExternalRecoveryResumeState({
    tenantId,
    interfaceFamily: 'I09',
    sourcePartition: `i09/gateway/${gatewayId}/device/${deviceId}`,
  });
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

/**
 * Clinician verification of a device vitals row.
 *
 * Canonical clinical timeline invariant (docs/CANONICAL_CLINICAL_TIMELINE.md):
 * the vitals_chart flip + one clinical_timeline_events row + one
 * clinical_audit_events row persist in the SAME transaction.
 * recordCanonicalClinicalEvent throws in-tx (CANONICAL_TIMELINE_REQUIRED /
 * CANONICAL_AUDIT_REQUIRED) when either canonical write does not land, so a
 * failed canonical pair rolls the verification flip back rather than leaving
 * the timeline/audit layer out of sync. Verification is one-shot — the
 * device_verified=false guard makes a second call NOT_FOUND — so the
 * insert-once idempotency key is correct.
 */
export async function verifyDeviceVitals(vitalsId, context = {}) {
  if (!context.actorUid) throw AppError.unauthorized('Verifier identity missing');
  if (!context.tenantId) throw AppError.badRequest('tenantId is required', 'DEVICE_VITALS_NO_TENANT');
  return setTenantTx(context.tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
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
    const idempotencyKey = `vitals_chart:${row.id}:device_verified`;
    await recordCanonicalClinicalEvent({
      tenantId: context.tenantId,
      patientUid: row.patient_uid,
      eventType: 'vitals.device_verified',
      eventStatus: 'verified',
      sourceTable: 'vitals_chart',
      sourceId: String(row.id),
      resourceType: 'vitals',
      resourceTable: 'vitals_chart',
      resourceId: String(row.id),
      actorUid: context.actorUid,
      actorRole: context.actorRole || null,
      summary: `Device vitals verified (${row.source_device || 'monitor'})`,
      payload: {
        vitals_chart_id: row.id,
        source_kind: 'device',
        verification_status: 'verified',
      },
      afterState: { device_verified: true },
      metadata: { source_device: row.source_device },
      tags: ['vitals', 'device-synced', 'verified'],
      timelineIdempotencyKey: idempotencyKey,
      auditIdempotencyKey: idempotencyKey,
    }, { db: tx });
    return row;
  });
}

export default {
  parseHl7Timestamp,
  extractVitalsFromOru,
  extractDeviceMessageMeta,
  ingestDeviceVitals,
  ingestSequencedDeviceVitalsRecovery,
  readI09GatewayRecoveryResumeState,
  resolveDeviceForGateway,
  listUnverifiedDeviceVitals,
  verifyDeviceVitals,
};
