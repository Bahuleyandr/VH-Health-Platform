import { createHash } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import {
  currentCanonicalTransactionRevision,
  recordCanonicalClinicalEvent,
} from '../clinical/canonicalClinicalPlatformService.js';

const SOURCE_RECORD_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,180}$/;
const WEARABLE_SOURCES = new Set(['healthkit', 'health_connect', 'google_fit']);
export const WEARABLE_RECORDED_AT_MAX_AGE_MS = 31 * 24 * 60 * 60 * 1000;
export const WEARABLE_RECORDED_AT_MAX_FUTURE_MS = 5 * 60 * 1000;

function canonicalPayload({
  bloodPressure,
  heartRate,
  temperature,
  bloodSugar,
  weight,
  spO2,
  source,
  recordedAtSource,
}) {
  return JSON.stringify([
    source,
    recordedAtSource.toISOString(),
    bloodPressure
      ? [bloodPressure.systolic ?? null, bloodPressure.diastolic ?? null]
      : null,
    heartRate ?? null,
    temperature ?? null,
    bloodSugar ?? null,
    weight ?? null,
    spO2 ?? null,
  ]);
}

function normalizeSourceRecordId(value) {
  if (value === undefined || value === null || value === '') {
    throw AppError.badRequest('sourceRecordId is required for wearable vitals');
  }
  if (typeof value !== 'string') {
    throw AppError.badRequest('sourceRecordId must be a string');
  }
  const normalized = String(value).trim();
  if (!SOURCE_RECORD_ID_PATTERN.test(normalized)) {
    throw AppError.badRequest(
      'sourceRecordId must be 1-180 chars [A-Za-z0-9_.:-]',
    );
  }
  return normalized;
}

function eventPayload(row) {
  return {
    patient_generated: true,
    device_synced: true,
    device_verified: false,
    source: row.source,
    source_record_id: row.source_record_id,
    recorded_at_source: row.recorded_at_source,
    blood_pressure: row.blood_pressure,
    heart_rate: row.heart_rate,
    temperature: row.temperature,
    blood_sugar: row.blood_sugar,
    weight: row.weight,
    spo2: row.spo2,
  };
}

function prepareWearableVital({
  tenantId,
  patientUid,
  bloodPressure,
  heartRate,
  temperature,
  bloodSugar,
  weight,
  spO2,
  source,
  sourceRecordId,
  recordedAtSource,
  receivedAt = new Date(),
}) {
  if (!tenantId) throw AppError.badRequest('Tenant context is required');
  if (!patientUid) throw AppError.unauthorized('Unauthorized');
  if (!(recordedAtSource instanceof Date) || Number.isNaN(recordedAtSource.getTime())) {
    throw AppError.badRequest('recordedAtSource must be a valid ISO-8601 timestamp');
  }
  if (!WEARABLE_SOURCES.has(source)) {
    throw AppError.badRequest('source must identify a supported wearable provider');
  }
  const sourceTimeDeltaMs = recordedAtSource.getTime() - receivedAt.getTime();
  if (sourceTimeDeltaMs > WEARABLE_RECORDED_AT_MAX_FUTURE_MS ||
      sourceTimeDeltaMs < -WEARABLE_RECORDED_AT_MAX_AGE_MS) {
    throw AppError.badRequest(
      'recordedAtSource must be within the supported wearable import window',
      'WEARABLE_RECORDED_AT_OUT_OF_RANGE',
    );
  }

  const payloadHash = createHash('sha256')
    .update(canonicalPayload({
      bloodPressure,
      heartRate,
      temperature,
      bloodSugar,
      weight,
      spO2,
      source,
      recordedAtSource,
    }))
    .digest('hex');
  return {
    payloadHash,
    receiptId: normalizeSourceRecordId(sourceRecordId),
  };
}

export async function recordPatientWearableVital({
  tenantId,
  patientUid,
  actorRole,
  bloodPressure = null,
  heartRate = null,
  temperature = null,
  bloodSugar = null,
  weight = null,
  spO2 = null,
  source,
  sourceRecordId = null,
  recordedAtSource,
}) {
  const { payloadHash, receiptId } = prepareWearableVital({
    tenantId,
    patientUid,
    bloodPressure,
    heartRate,
    temperature,
    bloodSugar,
    weight,
    spO2,
    source,
    sourceRecordId,
    recordedAtSource,
  });

  return setTenantTx(tenantId, async (tx) => {
    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO patient_vitals
         (tenant_id, patient_uid, blood_pressure, heart_rate, temperature,
          blood_sugar, weight, spo2, source, source_record_id,
          source_record_hash, recorded_at, recorded_at_source)
       VALUES
         ($1::uuid, $2::uuid, $3::jsonb, $4::int, $5::numeric,
          $6::int, $7::numeric, $8::int, $9::varchar, $10::varchar,
          $11::char(64), CURRENT_TIMESTAMP, $12::timestamptz)
       ON CONFLICT (tenant_id, patient_uid, source, source_record_id)
       WHERE source_record_id IS NOT NULL
       DO NOTHING
       RETURNING id, tenant_id, patient_uid, blood_pressure, heart_rate,
                 temperature, blood_sugar, weight, spo2, recorded_at,
                 source, source_record_id, source_record_hash,
                 recorded_at_source`,
      tenantId,
      patientUid,
      bloodPressure ? JSON.stringify(bloodPressure) : null,
      heartRate,
      temperature,
      bloodSugar,
      weight,
      spO2,
      source,
      receiptId,
      payloadHash,
      recordedAtSource,
    );

    let row = inserted[0] || null;
    const created = Boolean(row);
    if (!row) {
      const existing = await tx.$queryRawUnsafe(
        `SELECT id, tenant_id, patient_uid, blood_pressure, heart_rate,
                temperature, blood_sugar, weight, spo2, recorded_at,
                source, source_record_id, source_record_hash,
                recorded_at_source
           FROM patient_vitals
          WHERE tenant_id = $1::uuid
            AND patient_uid = $2::uuid
            AND source = $3::varchar
            AND source_record_id = $4::varchar
          LIMIT 1`,
        tenantId,
        patientUid,
        source,
        receiptId,
      );
      row = existing[0] || null;
      if (!row) {
        throw AppError.conflict(
          'Wearable vital receipt could not be reconciled',
          'WEARABLE_VITAL_RECEIPT_UNAVAILABLE',
        );
      }
      if (row.source_record_hash !== payloadHash) {
        throw AppError.conflict(
          'sourceRecordId was reused with a different vital payload',
          'WEARABLE_VITAL_RECEIPT_MISMATCH',
        );
      }
    }

    if (created) {
      const payload = eventPayload(row);
      const eventKey = `patient_vitals:${createHash('sha256')
        .update(`${tenantId}\0${patientUid}\0${source}\0${receiptId}`)
        .digest('hex')}`;
      await recordCanonicalClinicalEvent({
        tenantId,
        patientUid,
        eventType: 'vitals.recorded',
        eventSubtype: 'wearable',
        eventStatus: 'unverified',
        sourceTable: 'patient_vitals',
        sourceId: String(row.id),
        resourceType: 'patient_vital',
        resourceId: String(row.id),
        actorUid: patientUid,
        actorRole,
        occurredAt: row.recorded_at_source,
        visibleToPatient: true,
        summary: `Patient-generated ${source} vital recorded`,
        payload,
        afterState: payload,
        tags: ['vitals', 'patient-generated', 'device-synced', 'unverified', 'wearable'],
        timelineIdempotencyKey: `${eventKey}:timeline`,
        auditIdempotencyKey: `${eventKey}:audit`,
      }, { db: tx });
    }

    return {
      row,
      created,
      duplicate: !created,
      receipt: {
        sourceRecordId: receiptId,
        sourceRecordHash: payloadHash,
        duplicate: !created,
      },
    };
  });
}

export async function correctPatientWearableVital({
  tenantId,
  patientUid,
  actorRole,
  bloodPressure = null,
  heartRate = null,
  temperature = null,
  bloodSugar = null,
  weight = null,
  spO2 = null,
  source,
  sourceRecordId = null,
  recordedAtSource,
}) {
  const { payloadHash, receiptId } = prepareWearableVital({
    tenantId,
    patientUid,
    bloodPressure,
    heartRate,
    temperature,
    bloodSugar,
    weight,
    spO2,
    source,
    sourceRecordId,
    recordedAtSource,
  });
  const correctedAt = new Date();

  return setTenantTx(tenantId, async (tx) => {
    const existingRows = await tx.$queryRawUnsafe(
      `SELECT id, tenant_id, patient_uid, blood_pressure, heart_rate,
              temperature, blood_sugar, weight, spo2, recorded_at,
              source, source_record_id, source_record_hash,
              recorded_at_source
         FROM patient_vitals
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND source = $3::varchar
          AND source_record_id = $4::varchar
        LIMIT 1
        FOR UPDATE`,
      tenantId,
      patientUid,
      source,
      receiptId,
    );
    const existing = existingRows[0] || null;
    if (!existing) {
      throw AppError.notFound(
        'Wearable vital receipt was not found for correction',
        'WEARABLE_VITAL_RECEIPT_NOT_FOUND',
      );
    }
    if (existing.source_record_hash === payloadHash) {
      return {
        row: existing,
        corrected: false,
        duplicate: true,
        receipt: {
          sourceRecordId: receiptId,
          sourceRecordHash: payloadHash,
          corrected: false,
          duplicate: true,
        },
      };
    }

    const updatedRows = await tx.$queryRawUnsafe(
      `UPDATE patient_vitals
          SET blood_pressure = $5::jsonb,
              heart_rate = $6::int,
              temperature = $7::numeric,
              blood_sugar = $8::int,
              weight = $9::numeric,
              spo2 = $10::int,
              source_record_hash = $11::char(64),
              recorded_at_source = $12::timestamptz
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND source = $3::varchar
          AND source_record_id = $4::varchar
        RETURNING id, tenant_id, patient_uid, blood_pressure, heart_rate,
                  temperature, blood_sugar, weight, spo2, recorded_at,
                  source, source_record_id, source_record_hash,
                  recorded_at_source`,
      tenantId,
      patientUid,
      source,
      receiptId,
      bloodPressure ? JSON.stringify(bloodPressure) : null,
      heartRate,
      temperature,
      bloodSugar,
      weight,
      spO2,
      payloadHash,
      recordedAtSource,
    );
    const row = updatedRows[0] || null;
    if (!row) {
      throw AppError.conflict(
        'Wearable vital receipt could not be corrected',
        'WEARABLE_VITAL_RECEIPT_CORRECTION_UNAVAILABLE',
      );
    }

    const beforeState = eventPayload(existing);
    const afterState = eventPayload(row);
    const revision = await currentCanonicalTransactionRevision(tx);
    const correctionKey = `patient_vitals:${createHash('sha256')
      .update(`${tenantId}\0${patientUid}\0${source}\0${receiptId}\0${payloadHash}`)
      .digest('hex')}:corrected:tx:${revision}`;
    await recordCanonicalClinicalEvent({
      tenantId,
      patientUid,
      eventType: 'vitals.corrected',
      eventSubtype: 'wearable',
      eventStatus: 'corrected',
      sourceTable: 'patient_vitals',
      sourceId: String(row.id),
      resourceType: 'patient_vital',
      resourceId: String(row.id),
      actorUid: patientUid,
      actorRole,
      occurredAt: correctedAt,
      visibleToPatient: true,
      summary: `Patient ${source} wearable vital corrected`,
      payload: {
        source_record_id: receiptId,
        corrected_fields: Object.keys(afterState).filter(
          key => JSON.stringify(beforeState[key]) !== JSON.stringify(afterState[key]),
        ),
      },
      beforeState,
      afterState,
      tags: ['vitals', 'patient-generated', 'device-synced', 'unverified', 'wearable', 'corrected'],
      timelineIdempotencyKey: `${correctionKey}:timeline`,
      auditIdempotencyKey: `${correctionKey}:audit`,
    }, { db: tx, strict: true });

    return {
      row,
      corrected: true,
      duplicate: false,
      receipt: {
        sourceRecordId: receiptId,
        sourceRecordHash: payloadHash,
        corrected: true,
        duplicate: false,
      },
    };
  });
}

export default { correctPatientWearableVital, recordPatientWearableVital };
