// src/services/clinical/marService.js
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { isDoctor } from '../../utils/roleHelpers.js';
import {
  recordCanonicalClinicalEvent,
  recordMedicationSafetyReviews,
} from './canonicalClinicalPlatformService.js';
import { BCMA_CONFIG, MAR_SCHEDULE_LIMITS } from '../../config/pharmacyConfig.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { consumeMarSupplyTx } from './marSupplyService.js';
import {
  finaliseMarHttpIdempotencyTx,
  findMarAdministrationCommandReplayTx,
  fingerprintMarAdministrationRequest,
  recordMarAdministrationCommandReceiptTx,
} from './marAdministrationCommandService.js';
import {
  findMarTransitionCommandReplayTx,
  fingerprintMarTransitionRequest,
  recordMarTransitionCommandReceiptTx,
} from './marTransitionCommandService.js';
import {
  claimMarMedicationExceptionTx,
  getMarExceptionMedicationAdministrationId,
  handoffMarMedicationExceptionTx,
  listAssignedMarMedicationExceptions,
  openMarMedicationExceptionTx,
  requiredMarMedicationExceptionCaseId,
  requiredMarMedicationExceptionEventId,
  resolveMarMedicationExceptionTx,
} from './marMedicationExceptionService.js';
import {
  claimMarMedicationExceptionTaskTx,
  completeTaskFromDomainEvidence,
  createMarMedicationExceptionTaskTx,
} from '../workflow/taskService.js';

// ===================================================================
// Medication Administration Record (MAR) Service
// ===================================================================

// Route allowlist mirrors the MAR clinical reference set; aliases ('sl' for
// sublingual, 'sq' for subcutaneous) are normalised before the includes check
// below so a nurse can chart GTN as either 'sublingual' or 'sl' without the
// chart silently storing the wrong route. Finding:
// 2026-05-09-emergency-walk-in-nurse-mar-route-enum-missing-sublingual.
const VALID_ROUTES = [
  'oral', 'iv', 'im', 'sc', 'topical', 'inhaled',
  'sublingual', 'buccal', 'transdermal', 'rectal', 'intranasal', 'ophthalmic',
];
const ROUTE_ALIASES = {
  sl: 'sublingual',
  sq: 'sc',
  subq: 'sc',
  po: 'oral',
  pr: 'rectal',
  td: 'transdermal',
  inh: 'inhaled',
  // Long-form spellings clinicians also write free-text (the CPOE layer
  // normalises some of these, but order-set / carry-over payloads reach
  // the MAR with the raw word).
  intravenous: 'iv',
  intramuscular: 'im',
  subcutaneous: 'sc',
  intranasal: 'intranasal',
  nasal: 'intranasal',
};

// Resolve a single token to its canonical route (allowlist value or alias),
// or null if it isn't a route word.
function resolveRouteToken(token) {
  if (VALID_ROUTES.includes(token)) return token;
  if (ROUTE_ALIASES[token]) return ROUTE_ALIASES[token];
  return null;
}

// Normalise a route to a canonical allowlist value.
//
// A plain route ('oral', 'PO', 'sublingual') resolves directly. Compound
// routes that pair a route with an administration modifier — "PO chewed",
// "PO crushed via NG", "IV push" — are common in ACS order sets (the
// chest-pain bundle seeds Aspirin as route "PO chewed"). The modifier is
// not an enum value, so the whole string fails the allowlist and the dose
// is silently dropped from the MAR (the route check throws, the carry-over
// /order-integration catch swallows it). Recover the clinical route by
// scanning tokens for the first that resolves; the modifier survives in
// the order/MAR notes, not the structured route column. Finding:
// 2026-05-21-emergency-walk-in-nurse-7d2d873a (STAT aspirin absent from ICU MAR).
function normalizeRoute(raw) {
  const cleaned = String(raw || '').trim().toLowerCase();
  if (!cleaned) return cleaned;
  // Whole-string match first so an exact route/alias is never re-interpreted.
  const direct = resolveRouteToken(cleaned);
  if (direct) return direct;
  // Compound route: take the first token that is a recognised route word.
  for (const token of cleaned.split(/[^a-z]+/).filter(Boolean)) {
    const resolved = resolveRouteToken(token);
    if (resolved) return resolved;
  }
  // No route word found — return the cleaned string so the allowlist check
  // still rejects genuinely invalid routes with a loud 400.
  return cleaned;
}

function normalizeSupplyQuantity(value, fieldName = 'supply_quantity_per_dose') {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  const normalized = Math.round(parsed * 10000) / 10000;
  if (
    !Number.isFinite(parsed)
    || parsed <= 0
    || Math.abs(parsed - normalized) > 1e-9
    || normalized > 9999999999.9999
  ) {
    throw AppError.badRequest(`${fieldName} must be positive with at most four decimal places`);
  }
  return normalized;
}

// Frequency-to-schedule expansion. Doctors store prescriptions with a
// frequency string (e.g. "8-hourly", "BD") and a duration_days, but MAR
// scheduling expects an explicit `scheduled_time` per dose. Without
// server-side expansion the doctor or nurse had to compute every dose
// timestamp by hand — at 30+ IPD patients per ward, a real source of
// missed/double dosing. Finding:
// 2026-05-09-inpatient-admission-doctor-mar-route-format-mismatch.
const FREQUENCY_HOURLY_MAP = {
  od: 24, 'once-daily': 24, 'once daily': 24, daily: 24, qd: 24, hs: 24,
  bd: 12, bid: 12, 'twice-daily': 12, 'twice daily': 12, 'twice a day': 12, '12-hourly': 12,
  tds: 8, tid: 8, 'three-times-daily': 8, '8-hourly': 8, 'every 8 hours': 8,
  qid: 6, 'four-times-daily': 6, '6-hourly': 6, 'every 6 hours': 6,
  q4h: 4, '4-hourly': 4, 'every 4 hours': 4,
  q2h: 2, '2-hourly': 2, 'every 2 hours': 2,
  q1h: 1, hourly: 1, 'every hour': 1,
};

function hoursForFrequency(raw) {
  if (raw == null) return null;
  const key = String(raw).trim().toLowerCase();
  if (FREQUENCY_HOURLY_MAP[key] != null) return FREQUENCY_HOURLY_MAP[key];
  const everyMatch = key.match(/^every\s+(\d+)\s*h/);
  if (everyMatch) return Number(everyMatch[1]);
  const hourlyMatch = key.match(/^(\d+)[-\s]?hourly$/);
  if (hourlyMatch) return Number(hourlyMatch[1]);
  return null;
}

// Expand a (frequency, start_time, duration_days) tuple into an array
// of explicit scheduled_time ISO strings. Returns null when the
// frequency is unrecognised — the caller falls back to requiring an
// explicit scheduled_time so the error stays loud.
//
// C-L3: this used to clamp duration_days to 14 SILENTLY, so an OD × 30-day
// prescription scheduled only 14 days of doses — days 15–30 simply never
// existed on the MAR and nobody was told. The bounds are now loud 400s
// (house style — the unrecognised-frequency error in the same flow):
// durations within MAR_SCHEDULE_LIMITS are honoured IN FULL, and anything
// beyond the day window or the absolute dose ceiling throws instead of
// truncating. `Number(durationDays) || 1` still maps absent/0/NaN/negative
// to 1 day (defensive defaulting, unchanged).
export function expandSchedule(frequency, startTime, durationDays) {
  const interval = hoursForFrequency(frequency);
  if (interval == null) return null;
  const start = startTime ? new Date(startTime) : new Date();
  if (Number.isNaN(start.getTime())) return null;
  const { maxScheduleDays, maxTotalDoses } = MAR_SCHEDULE_LIMITS;
  const days = Math.max(1, Number(durationDays) || 1);
  if (days > maxScheduleDays) {
    throw AppError.badRequest(
      `duration_days ${days} exceeds the ${maxScheduleDays}-day MAR scheduling window — schedule in blocks or supply explicit scheduled_time entries`,
      'MAR_DURATION_EXCEEDS_WINDOW',
      { requested_days: days, max_schedule_days: maxScheduleDays },
    );
  }
  const totalDoses = Math.ceil((days * 24) / interval);
  if (totalDoses > maxTotalDoses) {
    throw AppError.badRequest(
      `Expanding ${days} day(s) of "${frequency}" would create ${totalDoses} doses (ceiling ${maxTotalDoses}) — schedule in blocks or supply explicit scheduled_time entries`,
      'MAR_SCHEDULE_DOSE_CEILING',
      { requested_days: days, total_doses: totalDoses, max_total_doses: maxTotalDoses },
    );
  }
  const out = [];
  for (let i = 0; i < totalDoses; i += 1) {
    const t = new Date(start.getTime() + i * interval * 60 * 60 * 1000);
    out.push(t.toISOString());
  }
  return out;
}

async function recordCanonicalMarEvent({
  record,
  eventType,
  actorUid = null,
  actorRole = null,
  previousStatus = null,
  encounterId = null,
  sourceClinicalOrderId = null,
  payload = {},
  db = null,
} = {}) {
  if (!record?.id) return null;
  const status = record.status || null;
  const stamp = record.updated_at?.toISOString?.()
    || record.administered_at?.toISOString?.()
    || record.created_at?.toISOString?.()
    || Date.now();

  // The canonical MAR timeline + audit event is a medication-safety artifact and
  // must be ATOMIC with the detail write (docs/CANONICAL_CLINICAL_TIMELINE.md).
  // When called with a transaction handle (`db`), let recordCanonicalClinicalEvent
  // govern error handling: it already swallows ONLY 42P01 (canonical layer not
  // migrated onto this DB) and RE-THROWS every other fault, so a real canonical
  // failure aborts the caller's tx and the detail write rolls back — no orphan
  // MAR row without a timeline/audit row. The previous unconditional try/catch
  // here swallowed ALL failures, silently breaking that atomicity inside the tx.
  // Only the post-commit path (no `db`) keeps a best-effort swallow.
  const emit = () => recordCanonicalClinicalEvent({
    tenantId: record.tenant_id,
    patientUid: record.patient_uid,
    encounterId,
    eventType,
    eventStatus: status,
    sourceTable: 'medication_administrations',
    sourceId: String(record.id),
    resourceType: 'mar',
    resourceId: String(record.id),
    actorUid: actorUid || record.administered_by,
    actorRole,
    summary: `${record.medication_name || 'Medication'} ${status || 'updated'}`,
    payload: {
      medication_administration_id: record.id,
      medication_name: record.medication_name || null,
      dose: record.dose || record.dosage || null,
      route: record.route || null,
      scheduled_time: record.scheduled_time || null,
      administered_at: record.administered_at || null,
      previous_status: previousStatus,
      status,
      source_clinical_order_id: sourceClinicalOrderId || record.clinical_order_id || null,
      supply_quantity_per_dose: record.supply_quantity_per_dose || null,
      notes: record.notes || null,
      hold_reason: record.hold_reason || null,
      refusal_reason: record.refusal_reason || null,
      ...payload,
    },
    beforeState: previousStatus ? { status: previousStatus } : null,
    afterState: { status },
    tags: ['mar', 'medication'],
    timelineIdempotencyKey: `medication_administrations:${record.id}:${eventType}:${status || 'none'}:${stamp}`,
    auditIdempotencyKey: `medication_administrations:${record.id}:audit:${eventType}:${status || 'none'}:${stamp}`,
  }, db ? { db } : undefined);

  if (db) {
    // In-tx: propagate (atomic). recordCanonicalClinicalEvent has already
    // narrowed the swallow to the canonical-table-absent case.
    return emit();
  }
  try {
    return await emit();
  } catch (err) {
    logger.warn(`Canonical MAR event skipped for row ${record.id}`, {
      error: err?.message || String(err),
    });
    return null;
  }
}

// Locate an existing non-cancelled row for the same patient + medication in
// the same clinical slot (±1 minute — absorbs ER-to-ICU carry-over drift).
// Used both as the friendly Phase-0 pre-check and as the winner lookup after
// a 23505 on migration 642's uniq_mar_scheduled_dose backstop index (which is
// exact-equality on scheduled_time, a subset of this window).
async function findScheduledSibling(tenantId, patientUid, med, db = prisma) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, patient_uid::text, medication_name, dose, dosage, route,
            scheduled_time, status, administered_by::text, notes,
            tenant_id::text, clinical_order_id, supply_quantity_per_dose,
            created_at
       FROM medication_administrations
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND medication_name = $3
        AND scheduled_time >= ($4::timestamptz - INTERVAL '1 minute')
        AND scheduled_time < ($4::timestamptz + INTERVAL '1 minute')
        AND status <> 'cancelled'
      ORDER BY ABS(EXTRACT(EPOCH FROM (scheduled_time - $4::timestamptz))) ASC, id ASC
      LIMIT 1`,
    tenantId, patientUid, med.medication_name, med.scheduled_time,
  );
  return rows[0] || null;
}

function assertScheduledSiblingCompatible(row, {
  clinicalOrderId,
  supplyQuantityPerDose,
}) {
  const orderMatches = clinicalOrderId == null
    ? row.clinical_order_id == null
    : Number(row.clinical_order_id) === Number(clinicalOrderId);
  const existingQuantity = normalizeSupplyQuantity(row.supply_quantity_per_dose);
  const quantityMatches = existingQuantity == null && supplyQuantityPerDose == null
    || existingQuantity != null && supplyQuantityPerDose != null
      && Math.abs(existingQuantity - supplyQuantityPerDose) <= 1e-9;
  if (!orderMatches || !quantityMatches) {
    throw AppError.conflict(
      'An existing MAR dose in this clinical slot is linked to different order or supply evidence',
      'MAR_SCHEDULE_IDENTITY_CONFLICT',
      {
        medication_administration_id: Number(row.id),
        existing_clinical_order_id: row.clinical_order_id == null
          ? null : Number(row.clinical_order_id),
        requested_clinical_order_id: clinicalOrderId == null
          ? null : Number(clinicalOrderId),
        existing_supply_quantity_per_dose: existingQuantity,
        requested_supply_quantity_per_dose: supplyQuantityPerDose,
      },
    );
  }
}

/**
 * Schedule medications for a patient.
 * @param {string} patientUid
 * @param {number|null} prescriptionId
 * @param {Array} medications - [{ medication_name, dose, route, scheduled_time, notes? }]
 *   - `drug_name` is accepted as an alias for `medication_name` (prescriptions
 *     use the same column name but some upstream callers send `drug_name`).
 *   - When `scheduled_time` is omitted, the service expands `frequency` +
 *     optional `start_time` + `duration_days` into an array of doses.
 * @returns {Array} Created medication_administration records
 */
export async function scheduleMedications(patientUid, prescriptionId, medications, context = {}) {
  if (!medications || medications.length === 0) {
    throw AppError.badRequest('At least one medication entry is required');
  }

  const expandedMeds = [];
  for (const med of medications) {
    const medicationName = med.medication_name || med.drug_name;
    if (!medicationName) {
      throw AppError.badRequest('Each medication must have medication_name (or drug_name)');
    }
    const base = { ...med, medication_name: medicationName };
    if (med.scheduled_time) {
      expandedMeds.push(base);
      continue;
    }
    if (med.frequency) {
      const times = expandSchedule(med.frequency, med.start_time, med.duration_days);
      if (!times) {
        throw AppError.badRequest(
          `Cannot expand frequency "${med.frequency}". Supply explicit scheduled_time entries or use one of: OD, BD, TDS, QID, 8-hourly, 12-hourly, etc.`,
        );
      }
      for (const t of times) expandedMeds.push({ ...base, scheduled_time: t });
      continue;
    }
    expandedMeds.push(base);
  }

  const tenantId = requireTenantId(context.tenantId);
  const preparedMeds = [];
  for (const med of expandedMeds) {
    if (!med.medication_name || !med.dose || !med.route || !med.scheduled_time) {
      throw AppError.badRequest('Each medication must have medication_name (or drug_name), dose, route, and scheduled_time (or frequency)');
    }

    const normalizedRoute = normalizeRoute(med.route);
    if (!VALID_ROUTES.includes(normalizedRoute)) {
      throw AppError.badRequest(`Invalid route: ${med.route}. Must be one of: ${VALID_ROUTES.join(', ')}`);
    }
    const clinicalOrderId = med.clinical_order_id
      ?? context.sourceClinicalOrderId
      ?? null;
    if (clinicalOrderId != null && (!Number.isSafeInteger(Number(clinicalOrderId)) || Number(clinicalOrderId) <= 0)) {
      throw AppError.badRequest('clinical_order_id must be a positive integer');
    }
    const supplyQuantityPerDose = normalizeSupplyQuantity(
      med.supply_quantity_per_dose ?? context.supplyQuantityPerDose ?? null,
    );
    const scheduledAt = new Date(med.scheduled_time);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw AppError.badRequest('scheduled_time must be a valid date-time');
    }
    preparedMeds.push({
      ...med,
      route: normalizedRoute,
      scheduled_time: scheduledAt.toISOString(),
      clinicalOrderId: clinicalOrderId == null ? null : Number(clinicalOrderId),
      supplyQuantityPerDose,
    });
  }

  const preflight = [];
  let allExisting = true;
  const preflightDb = context.db || prisma;
  for (const med of preparedMeds) {
    const dup = await findScheduledSibling(tenantId, patientUid, med, preflightDb);
    if (!dup) {
      allExisting = false;
      preflight.push(null);
      continue;
    }
    assertScheduledSiblingCompatible(dup, {
      clinicalOrderId: med.clinicalOrderId,
      supplyQuantityPerDose: med.supplyQuantityPerDose,
    });
    preflight.push(dup);
  }
  if (allExisting) return preflight;

  const persistSchedule = async (tx) => {
    const lockKeys = [...new Set(preparedMeds.map((med) => (
      `mar-schedule:${tenantId}:${patientUid}:${med.medication_name.trim().toLowerCase()}`
    )))].sort();
    for (const lockKey of lockKeys) {
      await tx.$queryRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))::text AS lock_result',
        lockKey,
      );
    }

    const results = [];
    for (const med of preparedMeds) {
      const dup = await findScheduledSibling(tenantId, patientUid, med, tx);
      if (dup) {
        assertScheduledSiblingCompatible(dup, {
          clinicalOrderId: med.clinicalOrderId,
          supplyQuantityPerDose: med.supplyQuantityPerDose,
        });
        results.push(dup);
        continue;
      }

      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO medication_administrations
           (patient_uid, prescription_id, medication_name, dose, route,
            scheduled_time, notes, status, clinical_order_id,
            supply_quantity_per_dose)
         VALUES ($1::uuid, $2, $3, $4, $5, $6::timestamptz, $7, 'scheduled',
                 $8::int, $9::numeric)
         RETURNING id, patient_uid, medication_name, dose, dosage, route,
                   scheduled_time, status, administered_by, notes, tenant_id,
                   clinical_order_id, supply_quantity_per_dose, created_at`,
        patientUid,
        prescriptionId || null,
        med.medication_name,
        med.dose,
        med.route,
        med.scheduled_time,
        med.notes || null,
        med.clinicalOrderId,
        med.supplyQuantityPerDose,
      );
      await recordCanonicalMarEvent({
        record: rows[0],
        eventType: 'mar.scheduled',
        actorUid: context.actorUid,
        actorRole: context.actorRole,
        encounterId: context.encounterId,
        sourceClinicalOrderId: med.clinicalOrderId,
        payload: {
          prescription_id: prescriptionId || null,
        },
        db: tx,
      });
      results.push(rows[0]);
    }
    return results;
  };

  let results;
  try {
    results = context.db
      ? await persistSchedule(context.db)
      : await setTenantTx(tenantId, persistSchedule);
  } catch (err) {
    const isUniqueRace = err?.meta?.code === '23505'
      || /23505|duplicate key value/i.test(err?.message || '');
    if (!isUniqueRace || context.db) throw err;

    const winners = [];
    let allResolved = true;
    for (const med of preparedMeds) {
      const winner = await findScheduledSibling(tenantId, patientUid, med);
      if (!winner) {
        allResolved = false;
        break;
      }
      assertScheduledSiblingCompatible(winner, {
        clinicalOrderId: med.clinicalOrderId,
        supplyQuantityPerDose: med.supplyQuantityPerDose,
      });
      winners.push(winner);
    }
    results = allResolved
      ? winners
      : await setTenantTx(tenantId, persistSchedule);
  }

  logger.info(`Scheduled ${results.length} medications for patient ${patientUid}`);
  return results;
}

export const MAR_ADMINISTRATION_MODES = Object.freeze({
  ONLINE_NO_SCAN: 'online_no_scan',
  ONLINE_BARCODE_SCAN: 'online_barcode_scan',
  RETROSPECTIVE_PAPER_BACK_ENTRY: 'retrospective_paper_back_entry',
});

const MAR_ADMINISTRATION_MODE_VALUES = new Set(Object.values(MAR_ADMINISTRATION_MODES));

export function duplicateAdministrationError(duplicateId = null) {
  return AppError.conflict(
    'This dose has already been administered (another MAR row for the same medication and scheduled time)',
    'MAR_DUPLICATE_ADMINISTRATION',
    duplicateId === null ? undefined : { duplicate_id: duplicateId },
  );
}

function inspectionError(inspection) {
  if (inspection.code === 'MAR_TARGET_NOT_FOUND') {
    return AppError.notFound('Medication administration record not found');
  }
  if (inspection.code === 'MAR_ALREADY_ADMINISTERED') {
    return AppError.conflict('Medication has already been administered');
  }
  if (inspection.code === 'MAR_DUPLICATE_ADMINISTRATION') {
    return duplicateAdministrationError(inspection.duplicateId);
  }
  if (inspection.code === 'MAR_STATE_CONFLICT') {
    if (inspection.currentStatus === 'held') {
      return AppError.conflict(
        'Held medication requires a prescriber-governed release before administration',
        'MAR_HOLD_RELEASE_REQUIRED',
      );
    }
    return AppError.invalidTransition(inspection.currentStatus, 'administered', ['scheduled']);
  }
  return AppError.conflict(
    'Medication administration context is not valid for this write',
    inspection.code || 'MAR_ADMINISTRATION_CONTEXT_INVALID',
  );
}

function normalizedIso(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Lock and inspect the canonical medication-administration row inside the
 * caller's tenant transaction. Both online charting and C5.2 paper back-entry
 * use this boundary; only the wrappers decide which canonical event to emit.
 */
export async function inspectMedicationAdministrationTx(tx, {
  tenantId,
  medicationAdministrationId,
  administeredBy,
  witnessUid = null,
  witnessRole = null,
  occurredAt = null,
  expectedPatientUid = null,
  expectedAdmissionId = null,
  expectedEncounterId = null,
  mode = MAR_ADMINISTRATION_MODES.ONLINE_NO_SCAN,
} = {}) {
  if (!tx?.$queryRawUnsafe || !MAR_ADMINISTRATION_MODE_VALUES.has(mode)) {
    throw AppError.badRequest('Medication administration mode is invalid', 'MAR_ADMINISTRATION_MODE_INVALID');
  }
  const tid = requireTenantId(tenantId);
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, patient_uid::text, medication_name, dose, dosage, route,
            scheduled_time, administered_at, administered_by::text, status,
            notes, witness_uid::text, override_reason, tenant_id::text,
            clinical_order_id, supply_quantity_per_dose,
            created_at, updated_at, patient_scanned_at, medication_scanned_at
       FROM medication_administrations
      WHERE tenant_id = $1::uuid AND id = $2::integer
      FOR UPDATE`,
    tid,
    medicationAdministrationId,
  );
  const row = rows[0];
  if (!row) return { disposition: 'conflict', code: 'MAR_TARGET_NOT_FOUND' };
  if (expectedPatientUid && row.patient_uid !== expectedPatientUid) {
    return { disposition: 'conflict', code: 'MAR_TARGET_MISMATCH', row };
  }

  const retrospective = mode === MAR_ADMINISTRATION_MODES.RETROSPECTIVE_PAPER_BACK_ENTRY;
  const occurredAtIso = normalizedIso(occurredAt);
  if (retrospective) {
    if (
      !occurredAtIso
      || !expectedPatientUid
      || !Number.isSafeInteger(Number(expectedAdmissionId))
      || Number(expectedAdmissionId) < 1
      || !witnessUid
      || !String(witnessRole || '').trim()
    ) {
      return { disposition: 'conflict', code: 'MAR_RETROSPECTIVE_CONTEXT_INVALID', row };
    }
    if (witnessUid === administeredBy) {
      return { disposition: 'conflict', code: 'MAR_WITNESS_SEPARATION_REQUIRED', row };
    }
    const admissions = await tx.$queryRawUnsafe(
      `SELECT id, patient_uid::text, encounter_id::text, admitted_at, discharged_at
         FROM admissions
        WHERE tenant_id = $1::uuid
          AND id = $2::integer
          AND patient_uid = $3::uuid
          AND ($4::uuid IS NULL OR encounter_id = $4::uuid)
          AND COALESCE(admitted_at, created_at) <= $5::timestamptz
          AND (discharged_at IS NULL OR $5::timestamptz < discharged_at)
        LIMIT 1
        FOR KEY SHARE`,
      tid,
      Number(expectedAdmissionId),
      expectedPatientUid,
      expectedEncounterId,
      occurredAtIso,
    );
    if (!admissions[0]) return { disposition: 'conflict', code: 'MAR_ADMISSION_MISMATCH', row };

    const witnesses = await tx.$queryRawUnsafe(
      `SELECT uid::text, upper(role) AS role
         FROM users
        WHERE tenant_id = $1::uuid
          AND uid = $2::uuid
          AND upper(role) = upper($3)
          AND is_active = true
          AND status = 'active'
          AND is_deleted = false
        LIMIT 1
        FOR KEY SHARE`,
      tid,
      witnessUid,
      String(witnessRole).trim(),
    );
    if (!witnesses[0]) return { disposition: 'conflict', code: 'MAR_WITNESS_NOT_AUTHORIZED', row };
  }

  const currentStatus = String(row.status || '').toLowerCase();
  if (currentStatus === 'administered') {
    const exactProjection = retrospective
      && row.administered_by === administeredBy
      && normalizedIso(row.administered_at) === occurredAtIso
      && row.witness_uid === witnessUid;
    return exactProjection
      ? { disposition: 'exact_projection', row }
      : { disposition: 'conflict', code: 'MAR_ALREADY_ADMINISTERED', currentStatus, row };
  }
  if (currentStatus === 'held') {
    return { disposition: 'conflict', code: 'MAR_HOLD_RELEASE_REQUIRED', currentStatus, row };
  }
  if (currentStatus !== 'scheduled') {
    return { disposition: 'conflict', code: 'MAR_STATE_CONFLICT', currentStatus, row };
  }

  const siblings = await tx.$queryRawUnsafe(
    `SELECT id
       FROM medication_administrations
      WHERE tenant_id = $1::uuid
        AND id <> $2::integer
        AND patient_uid = $3::uuid
        AND medication_name = $4
        AND scheduled_time >= ($5::timestamptz - INTERVAL '1 minute')
        AND scheduled_time < ($5::timestamptz + INTERVAL '1 minute')
        AND status = 'administered'
      ORDER BY ABS(EXTRACT(EPOCH FROM (scheduled_time - $5::timestamptz))) ASC, id ASC
      LIMIT 1`,
    tid,
    medicationAdministrationId,
    row.patient_uid,
    row.medication_name,
    row.scheduled_time,
  );
  if (siblings[0]) {
    return {
      disposition: 'conflict',
      code: 'MAR_DUPLICATE_ADMINISTRATION',
      duplicateId: siblings[0].id,
      row,
    };
  }
  return { disposition: 'apply', occurredAt: occurredAtIso, row };
}

/**
 * Apply the detail-row mutation after inspectMedicationAdministrationTx has
 * locked and validated the row. This function deliberately emits no timeline
 * or audit event; the online and retrospective wrappers own different effects.
 */
export async function recordMedicationAdministrationTx(tx, {
  tenantId,
  medicationAdministrationId,
  administeredBy,
  notes = null,
  witnessUid = null,
  witnessRole = null,
  overrideReason = null,
  occurredAt = null,
  expectedPatientUid = null,
  expectedAdmissionId = null,
  expectedEncounterId = null,
  mode = MAR_ADMINISTRATION_MODES.ONLINE_NO_SCAN,
  commandKey = null,
  supplyQuantity = null,
  supplyOverrideReason = null,
  inspection = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const checked = inspection || await inspectMedicationAdministrationTx(tx, {
    tenantId: tid,
    medicationAdministrationId,
    administeredBy,
    witnessUid,
    witnessRole,
    occurredAt,
    expectedPatientUid,
    expectedAdmissionId,
    expectedEncounterId,
    mode,
  });
  if (checked.disposition === 'exact_projection') {
    return { disposition: 'exact_projection', record: checked.row, previousStatus: 'administered' };
  }
  if (checked.disposition !== 'apply') throw inspectionError(checked);
  if (
    Number(checked.row?.id) !== Number(medicationAdministrationId)
    || checked.row?.tenant_id !== tid
  ) {
    throw AppError.conflict('Medication inspection context changed', 'MAR_INSPECTION_CONTEXT_MISMATCH');
  }

  const supply = await consumeMarSupplyTx(tx, {
    tenantId: tid,
    administration: checked.row,
    recordedBy: administeredBy,
    witnessUid,
    administrationMode: mode,
    commandKey,
    supplyQuantity,
    supplyOverrideReason,
  });

  let rows;
  try {
    rows = await tx.$queryRawUnsafe(
      `UPDATE medication_administrations
          SET status = 'administered',
              administered_at = COALESCE($1::timestamptz, NOW()),
              administered_by = $2::uuid,
              notes = COALESCE($3, notes),
              witness_uid = $4::uuid,
              override_reason = COALESCE($5, override_reason),
              updated_at = clock_timestamp()
        WHERE tenant_id = $6::uuid
          AND id = $7::integer
          AND lower(status) = 'scheduled'
        RETURNING id, patient_uid::text, medication_name, dose, dosage, route,
                  scheduled_time, administered_at, status, administered_by::text,
                  notes, witness_uid::text, override_reason, tenant_id::text,
                  clinical_order_id, supply_quantity_per_dose,
                  created_at, updated_at, patient_scanned_at, medication_scanned_at`,
      mode === MAR_ADMINISTRATION_MODES.RETROSPECTIVE_PAPER_BACK_ENTRY
        ? checked.occurredAt
        : null,
      administeredBy,
      notes,
      witnessUid,
      mode === MAR_ADMINISTRATION_MODES.ONLINE_NO_SCAN ? overrideReason : null,
      tid,
      medicationAdministrationId,
    );
  } catch (err) {
    if (err?.meta?.code === '23505' || /23505|duplicate key value/i.test(err?.message || '')) {
      throw duplicateAdministrationError();
    }
    throw err;
  }
  if (rows.length !== 1) {
    throw AppError.conflict('Medication state changed', 'MAR_ADMINISTRATION_STATE_CONFLICT');
  }
  return {
    disposition: 'recorded',
    record: { ...rows[0], supply_state: supply },
    previousStatus: checked.row.status,
    supply,
  };
}

/**
 * Record medication administration.
 * @param {number} id - medication_administrations.id
 * @param {string} administeredBy - Staff UID
 * @param {string|null} notes
 * @param {string|null} witnessUid - For controlled substances
 * @param {Object} [options]
 * @param {string|null} [options.overrideReason] documented no-scan reason
 * @param {string|null} [options.tenantId] canonical tenant (req.tenantId). Falls
 *   back to the MA row's tenant_id when legacy callers omit it.
 * @returns {Object} Updated record
 */
export async function recordAdministration(id, administeredBy, notes = null, witnessUid = null, options = {}) {
  const noScanOverrideReason = (options.overrideReason || '').trim() || null;
  if (BCMA_CONFIG.requireScanForMarAdministration && !noScanOverrideReason) {
    throw AppError.conflict(
      'Barcode scan is required for administration — use POST /clinical/mar/:id/administer-with-scan, or supply override_reason for a documented no-scan administration',
      'MAR_SCAN_REQUIRED',
      { scan_endpoint: '/clinical/mar/:id/administer-with-scan' },
    );
  }

  let tid;
  if (options.tenantId) {
    tid = requireTenantId(options.tenantId);
  } else {
    const tenantRows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text
         FROM medication_administrations
        WHERE id = $1::integer
        LIMIT 1`,
      id,
    );
    if (!tenantRows[0]) throw AppError.notFound('Medication administration record not found');
    tid = requireTenantId(tenantRows[0].tenant_id);
  }

  const commandKey = options.commandKey || null;
  const commandIdentity = commandKey ? {
    tenantId: tid,
    medicationAdministrationId: id,
    actorUid: administeredBy,
    commandScope: 'mar_administer',
    commandKey,
    requestBodySha256: options.requestFingerprint || fingerprintMarAdministrationRequest({
      notes: notes || null,
      witness_uid: witnessUid || null,
      override_reason: noScanOverrideReason,
      supply_override_reason: options.supplyOverrideReason || null,
      supply_quantity: options.supplyQuantity ?? null,
    }),
    administrationMode: MAR_ADMINISTRATION_MODES.ONLINE_NO_SCAN,
  } : null;

  const finaliseCommandTx = async (tx, responseData) => {
    if (!commandIdentity) return responseData;
    const committedResponse = await recordMarAdministrationCommandReceiptTx(tx, {
      ...commandIdentity,
      responseData,
    });
    await finaliseMarHttpIdempotencyTx(tx, {
      claimId: options.httpIdempotencyClaimId || null,
      tenantId: tid,
      actorUid: administeredBy,
      commandKey,
      requestBodySha256: commandIdentity.requestBodySha256,
      responseData: committedResponse,
      requestId: options.requestId || null,
    });
    return committedResponse;
  };

  const result = await setTenantTx(tid, async (tx) => {
    if (commandIdentity) {
      const replay = await findMarAdministrationCommandReplayTx(tx, commandIdentity);
      if (replay) {
        await finaliseMarHttpIdempotencyTx(tx, {
          claimId: options.httpIdempotencyClaimId || null,
          tenantId: tid,
          actorUid: administeredBy,
          commandKey,
          requestBodySha256: commandIdentity.requestBodySha256,
          responseData: replay,
          requestId: options.requestId || null,
        });
        return replay;
      }
    }
    const inspection = await inspectMedicationAdministrationTx(tx, {
      tenantId: tid,
      medicationAdministrationId: id,
      administeredBy,
      witnessUid,
    });
    if (inspection.disposition !== 'apply') {
      if (commandIdentity) {
        const replay = await findMarAdministrationCommandReplayTx(tx, commandIdentity);
        if (replay) {
          await finaliseMarHttpIdempotencyTx(tx, {
            claimId: options.httpIdempotencyClaimId || null,
            tenantId: tid,
            actorUid: administeredBy,
            commandKey,
            requestBodySha256: commandIdentity.requestBodySha256,
            responseData: replay,
            requestId: options.requestId || null,
          });
          return replay;
        }
      }
      throw inspectionError(inspection);
    }
    const applied = await recordMedicationAdministrationTx(tx, {
      tenantId: tid,
      medicationAdministrationId: id,
      administeredBy,
      notes,
      witnessUid,
      overrideReason: noScanOverrideReason,
      commandKey,
      supplyQuantity: options.supplyQuantity ?? null,
      supplyOverrideReason: options.supplyOverrideReason || null,
      inspection,
    });
    if (noScanOverrideReason) {
      // Canonical invariant item 5 (docs/CANONICAL_CLINICAL_TIMELINE.md): a
      // documented override of a medication-safety control must persist a
      // medication_safety_reviews row in the SAME transaction as the detail
      // write. The no-scan override bypasses the BCMA scan gate, so record it
      // as a blocked finding with the override reason — the helper stores it
      // status='overridden' with override_required=true. The helper swallows
      // per-row insert failures, so verify a row actually landed and abort
      // (rolling the administration back) when none did: an unrecorded safety
      // override must not commit.
      const reviews = await recordMedicationSafetyReviews({
        tenantId: tid,
        patientUid: applied.record.patient_uid,
        safety: {
          safe: false,
          blockers: [{
            type: 'bcma_no_scan_override',
            severity: 'medium',
            medication_name: applied.record.medication_name,
            message: `Barcode scan bypassed for administration: ${noScanOverrideReason}`,
            medication_administration_id: applied.record.id,
          }],
          warnings: [],
        },
        override: { reason: noScanOverrideReason, approvedBy: administeredBy },
        actorUid: administeredBy,
      }, { db: tx });
      if (!reviews.length) {
        throw AppError.internal(
          'Medication safety review write failed for no-scan override',
          'MEDICATION_SAFETY_REVIEW_WRITE_FAILED',
        );
      }
    }
    await recordCanonicalMarEvent({
      record: applied.record,
      eventType: 'mar.administered',
      actorUid: administeredBy,
      previousStatus: applied.previousStatus,
      payload: {
        scanner_used: false,
        ...(noScanOverrideReason
          ? { no_scan_override: true, no_scan_override_reason: noScanOverrideReason }
          : {}),
        mar_supply: applied.supply,
      },
      db: tx,
    });
    return finaliseCommandTx(tx, applied.record);
  });

  logger.info(`Medication ${id} administered by ${administeredBy}`);
  return result;
}

async function recordMarTransition({
  id,
  reason,
  actorUid,
  transitionAction,
  commandScope,
  responseMessage,
  options,
}) {
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) {
    throw AppError.badRequest(
      transitionAction === 'held'
        ? 'Hold reason is required'
        : 'Missed medication reason is required',
    );
  }
  if (transitionAction === 'held' && !actorUid) {
    throw AppError.badRequest('Holding nurse identity is required');
  }

  const existing = await prisma.$queryRawUnsafe(
    `SELECT id, status, tenant_id::text
       FROM medication_administrations
      WHERE id = $1::integer
      LIMIT 1`,
    id,
  );
  if (!existing[0]) {
    throw AppError.notFound('Medication administration record not found');
  }
  const tenantId = requireTenantId(existing[0].tenant_id);
  if (options.tenantId && requireTenantId(options.tenantId) !== tenantId) {
    throw AppError.notFound('Medication administration record not found');
  }
  if (!options.commandKey && String(existing[0].status || '').toLowerCase() !== 'scheduled') {
    throw AppError.invalidTransition(existing[0].status, transitionAction, ['scheduled']);
  }

  const commandIdentity = options.commandKey ? {
    tenantId,
    medicationAdministrationId: id,
    actorUid,
    commandScope,
    transitionAction,
    commandKey: options.commandKey,
    requestBodySha256: options.requestFingerprint || fingerprintMarTransitionRequest({
      reason: cleanReason,
    }),
  } : null;

  const finaliseCommandTx = async (tx, responseData) => {
    if (!commandIdentity) return responseData;
    const committedResponse = await recordMarTransitionCommandReceiptTx(tx, {
      ...commandIdentity,
      responseData,
    });
    await finaliseMarHttpIdempotencyTx(tx, {
      claimId: options.httpIdempotencyClaimId || null,
      tenantId,
      actorUid,
      commandKey: options.commandKey,
      requestBodySha256: commandIdentity.requestBodySha256,
      responseData: committedResponse,
      requestId: options.requestId || null,
      message: responseMessage,
    });
    return committedResponse;
  };

  const row = await setTenantTx(tenantId, async (tx) => {
    if (commandIdentity) {
      const replay = await findMarTransitionCommandReplayTx(tx, commandIdentity);
      if (replay) {
        await finaliseMarHttpIdempotencyTx(tx, {
          claimId: options.httpIdempotencyClaimId || null,
          tenantId,
          actorUid,
          commandKey: options.commandKey,
          requestBodySha256: commandIdentity.requestBodySha256,
          responseData: replay,
          requestId: options.requestId || null,
          message: responseMessage,
        });
        return replay;
      }
    }

    const lockedRows = await tx.$queryRawUnsafe(
      `SELECT id, status
         FROM medication_administrations
        WHERE tenant_id = $1::uuid AND id = $2::integer
        FOR UPDATE`,
      tenantId,
      id,
    );
    const locked = lockedRows[0];
    if (!locked) throw AppError.notFound('Medication administration record not found');
    if (String(locked.status || '').toLowerCase() !== 'scheduled') {
      if (commandIdentity) {
        const replay = await findMarTransitionCommandReplayTx(tx, commandIdentity);
        if (replay) {
          await finaliseMarHttpIdempotencyTx(tx, {
            claimId: options.httpIdempotencyClaimId || null,
            tenantId,
            actorUid,
            commandKey: options.commandKey,
            requestBodySha256: commandIdentity.requestBodySha256,
            responseData: replay,
            requestId: options.requestId || null,
            message: responseMessage,
          });
          return replay;
        }
      }
      throw AppError.conflict('Medication state changed', 'MAR_ADMINISTRATION_STATE_CONFLICT');
    }

    const rows = transitionAction === 'missed'
      ? await tx.$queryRawUnsafe(
        `UPDATE medication_administrations
            SET status = 'missed',
                notes = COALESCE($2, notes),
                missed_by = $3::uuid,
                missed_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE tenant_id = $4::uuid
            AND id = $1::integer
            AND lower(status) = 'scheduled'
          RETURNING id, patient_uid::text, medication_name, dose, dosage, route,
                    scheduled_time, administered_at, status, administered_by::text,
                    notes, hold_reason, held_by::text, held_at,
                    missed_by::text, missed_at, tenant_id::text,
                    created_at, updated_at`,
        id,
        cleanReason,
        actorUid || null,
        tenantId,
      )
      : await tx.$queryRawUnsafe(
        `UPDATE medication_administrations
            SET status = 'held',
                hold_reason = $2,
                held_by = $3::uuid,
                held_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE tenant_id = $4::uuid
            AND id = $1::integer
            AND lower(status) = 'scheduled'
          RETURNING id, patient_uid::text, medication_name, dose, dosage, route,
                    scheduled_time, administered_at, status, administered_by::text,
                    notes, hold_reason, held_by::text, held_at,
                    missed_by::text, missed_at, tenant_id::text,
                    created_at, updated_at`,
        id,
        cleanReason,
        actorUid,
        tenantId,
      );
    if (rows.length !== 1) {
      throw AppError.conflict('Medication state changed', 'MAR_ADMINISTRATION_STATE_CONFLICT');
    }
    await recordCanonicalMarEvent({
      record: rows[0],
      eventType: `mar.${transitionAction}`,
      actorUid,
      previousStatus: locked.status,
      payload: { reason: cleanReason },
      db: tx,
    });
    await openMarMedicationExceptionTx(tx, {
      tenantId,
      medicationAdministrationId: id,
      exceptionKind: transitionAction,
      reason: cleanReason,
      raisedBy: actorUid,
      commandKey: commandIdentity?.commandKey,
      requestFingerprint: commandIdentity?.requestBodySha256,
      raisedAt: transitionAction === 'held' ? rows[0].held_at : rows[0].missed_at,
      createTaskTx: createMarMedicationExceptionTaskTx,
    });
    return finaliseCommandTx(tx, rows[0]);
  });

  logger.info(`Medication ${id} marked ${transitionAction} by ${actorUid || 'unknown actor'}`);
  return row;
}

/**
 * Record a missed medication dose.
 * @param {number} id
 * @param {string} reason
 * @param {string|null} missedBy
 * @param {Object} [options]
 * @returns {Object} Updated record
 */
export async function recordMissed(id, reason, missedBy = null, options = {}) {
  return recordMarTransition({
    id,
    reason,
    actorUid: missedBy,
    transitionAction: 'missed',
    commandScope: 'mar_miss',
    responseMessage: 'Missed medication recorded',
    options,
  });
}

/**
 * Hold a medication with reason.
 * @param {number} id
 * @param {string} reason
 * @param {string} heldBy - Staff UID
 * @param {Object} [options]
 * @returns {Object} Updated record
 */
export async function holdMedication(id, reason, heldBy, options = {}) {
  return recordMarTransition({
    id,
    reason,
    actorUid: heldBy,
    transitionAction: 'held',
    commandScope: 'mar_hold',
    responseMessage: 'Medication held',
    options,
  });
}

/**
 * Release a held dose back to the schedulable state. The original hold
 * attribution remains on the MAR row and the release reason is appended to the
 * canonical clinical timeline/audit trail in the same transaction.
 */
export async function releaseHeldMedication(id, reason, releasedBy, {
  tenantId,
  commandKey,
  requestFingerprint,
  httpIdempotencyClaimId,
  requestId = null,
} = {}) {
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) throw AppError.badRequest('Prescriber release reason is required');
  const tid = requireTenantId(tenantId);
  const actorUid = String(releasedBy || '').trim();
  if (!actorUid) throw AppError.badRequest('Releasing prescriber identity is required');
  if (!commandKey || !requestFingerprint || !httpIdempotencyClaimId) {
    throw AppError.badRequest(
      'Held medication release requires a durable idempotency command',
      'MAR_HOLD_RELEASE_IDEMPOTENCY_REQUIRED',
    );
  }

  const record = await setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT administration.id, administration.patient_uid::text,
              administration.medication_name, administration.dose,
              administration.dosage, administration.route,
              administration.scheduled_time, administration.administered_at,
              administration.status, administration.administered_by::text,
              administration.notes, administration.hold_reason,
              administration.held_by::text, administration.held_at,
              administration.witness_uid::text,
              administration.tenant_id::text,
              administration.clinical_order_id,
              administration.supply_quantity_per_dose,
              administration.created_at, administration.updated_at,
              clinical_order.status AS clinical_order_status,
              actor.role AS release_actor_role
         FROM medication_administrations administration
         JOIN clinical_orders clinical_order
           ON clinical_order.tenant_id = administration.tenant_id
          AND clinical_order.id = administration.clinical_order_id
          AND clinical_order.order_type = 'medication'
         JOIN users actor
           ON actor.tenant_id = administration.tenant_id
          AND actor.uid = $3::uuid
          AND actor.is_active = TRUE
          AND actor.status = 'active'
          AND COALESCE(actor.is_deleted, FALSE) = FALSE
        WHERE administration.tenant_id = $1::uuid
          AND administration.id = $2::integer
        FOR UPDATE OF administration, clinical_order, actor`,
      tid,
      id,
      actorUid,
    );
    const current = rows[0];
    if (!current) throw AppError.notFound('Held medication administration record not found');
    if (!isDoctor(String(current.release_actor_role || '').trim().toUpperCase())) {
      throw AppError.forbidden(
        'Only an active prescriber may release a held medication',
        'MAR_HOLD_RELEASE_PRESCRIBER_REQUIRED',
      );
    }
    if (!['ordered', 'verified', 'in_progress'].includes(
      String(current.clinical_order_status || '').toLowerCase(),
    )) {
      throw AppError.conflict(
        'The medication order is no longer active and cannot release this held dose',
        'MAR_HOLD_RELEASE_ORDER_INACTIVE',
      );
    }
    if (String(current.status || '').toLowerCase() !== 'held') {
      throw AppError.invalidTransition(current.status, 'scheduled', ['held']);
    }
    const updated = await tx.$queryRawUnsafe(
      `UPDATE medication_administrations
          SET status = 'scheduled',
              updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid
          AND id = $2::integer
          AND lower(status) = 'held'
        RETURNING id, patient_uid::text, medication_name, dose, dosage, route,
                  scheduled_time, administered_at, status,
                  administered_by::text, notes, hold_reason,
                  held_by::text, held_at, witness_uid::text,
                  tenant_id::text, clinical_order_id,
                  supply_quantity_per_dose::text, created_at, updated_at`,
      tid,
      id,
    );
    if (updated.length !== 1) {
      throw AppError.conflict('Medication hold state changed', 'MAR_HOLD_RELEASE_STATE_CONFLICT');
    }
    await recordCanonicalMarEvent({
      record: updated[0],
      eventType: 'mar.hold_released',
      actorUid,
      actorRole: String(current.release_actor_role || '').trim().toUpperCase(),
      previousStatus: 'held',
      payload: {
        release_reason: cleanReason,
        held_reason: current.hold_reason || null,
        held_by: current.held_by || null,
        held_at: current.held_at || null,
      },
      db: tx,
    });
    const exceptionRows = await tx.$queryRawUnsafe(
      `SELECT id
         FROM mar_medication_exception_cases
        WHERE tenant_id = $1::uuid
          AND medication_administration_id = $2::integer
          AND exception_kind = 'held'
          AND status = 'open'
        LIMIT 1
        FOR UPDATE`,
      tid,
      id,
    );
    if (!exceptionRows[0]) {
      throw AppError.conflict(
        'Held medication exception requires reconciliation before release',
        'MAR_EXCEPTION_CASE_MISSING',
      );
    }
    await resolveMarMedicationExceptionTx(tx, {
      tenantId: tid,
      exceptionCaseId: requiredMarMedicationExceptionCaseId(exceptionRows[0].id),
      disposition: 'hold_released',
      reason: cleanReason,
      actorUid,
      commandKey,
      requestFingerprint,
      completeTaskTx: completeTaskFromDomainEvidence,
    });
    await finaliseMarHttpIdempotencyTx(tx, {
      claimId: httpIdempotencyClaimId,
      tenantId: tid,
      actorUid,
      commandKey,
      requestBodySha256: requestFingerprint,
      responseData: updated[0],
      requestId,
      message: 'Medication hold released by prescriber',
    });
    return updated[0];
  });

  logger.info(`Medication ${id} hold released by prescriber ${actorUid}`);
  return record;
}

function marExceptionResponse(result) {
  return {
    exception_case_id: requiredMarMedicationExceptionCaseId(result.exceptionCase.id),
    medication_administration_id: Number(
      result.exceptionCase.medication_administration_id,
    ),
    status: result.exceptionCase.status,
    disposition: result.event.disposition,
    resolution_event_id: requiredMarMedicationExceptionEventId(result.event.id),
    replayed: result.replayed === true,
  };
}

export async function claimMedicationException({
  exceptionCaseId,
  actorUid,
  actorRoles = [],
  actorPrimaryRole = null,
  actorRawRole = null,
  tenantId,
  commandKey,
  requestFingerprint,
  httpIdempotencyClaimId,
  requestId = null,
}) {
  const tid = requireTenantId(tenantId);
  if (!commandKey || !requestFingerprint || !httpIdempotencyClaimId) {
    throw AppError.badRequest(
      'Medication exception claim requires a durable idempotency command',
      'MAR_EXCEPTION_IDEMPOTENCY_REQUIRED',
    );
  }
  return setTenantTx(tid, async (tx) => {
    const claimed = await claimMarMedicationExceptionTx(tx, {
      tenantId: tid,
      exceptionCaseId,
      actorUid,
      actorRoles,
      actorPrimaryRole,
      actorRawRole,
      commandKey,
      claimTaskTx: claimMarMedicationExceptionTaskTx,
    });
    const response = {
      exception_case_id: requiredMarMedicationExceptionCaseId(claimed.exceptionCase.id),
      medication_administration_id: Number(
        claimed.exceptionCase.medication_administration_id,
      ),
      task_id: Number(claimed.exceptionCase.task_id),
      assigned_prescriber_uid: String(claimed.exceptionCase.assigned_prescriber_uid),
      status: claimed.exceptionCase.status,
      deep_link: `/mar/due?exception_id=${requiredMarMedicationExceptionCaseId(
        claimed.exceptionCase.id,
      )}`,
      replayed: claimed.replayed,
    };
    await finaliseMarHttpIdempotencyTx(tx, {
      claimId: httpIdempotencyClaimId,
      tenantId: tid,
      actorUid,
      commandKey,
      requestBodySha256: requestFingerprint,
      responseData: response,
      requestId,
      message: claimed.replayed
        ? 'Medication exception claim replayed'
        : 'Medication exception claimed',
    });
    return response;
  });
}

export async function handoffMedicationException({
  exceptionCaseId,
  expectedPrescriberUid,
  targetPrescriberUid,
  reason,
  actorUid,
  tenantId,
  commandKey,
  requestFingerprint,
  httpIdempotencyClaimId,
  requestId = null,
}) {
  const tid = requireTenantId(tenantId);
  if (!commandKey || !requestFingerprint || !httpIdempotencyClaimId) {
    throw AppError.badRequest(
      'Medication exception handoff requires a durable idempotency command',
      'MAR_EXCEPTION_IDEMPOTENCY_REQUIRED',
    );
  }
  return setTenantTx(tid, async (tx) => {
    const handoff = await handoffMarMedicationExceptionTx(tx, {
      tenantId: tid,
      exceptionCaseId,
      expectedPrescriberUid,
      targetPrescriberUid,
      reason,
      actorUid,
      commandKey,
      requestFingerprint,
    });
    const response = {
      exception_case_id: handoff.exceptionCaseId,
      task_id: handoff.taskId,
      assignment_handoff_event_id: handoff.eventId,
      from_prescriber_uid: handoff.fromPrescriberUid,
      assigned_prescriber_uid: handoff.toPrescriberUid,
      handed_off_at: handoff.occurredAt,
      deep_link: `/mar/due?exception_id=${handoff.exceptionCaseId}`,
      replayed: handoff.replayed,
    };
    await finaliseMarHttpIdempotencyTx(tx, {
      claimId: httpIdempotencyClaimId,
      tenantId: tid,
      actorUid,
      commandKey,
      requestBodySha256: requestFingerprint,
      responseData: response,
      requestId,
      message: handoff.replayed
        ? 'Medication exception handoff replayed'
        : 'Medication exception reassigned to prescriber',
    });
    return response;
  });
}

export async function recordMedicationExceptionDisposition({
  exceptionCaseId,
  disposition,
  reason,
  replacementClinicalOrderId = null,
  actorUid,
  tenantId,
  commandKey,
  requestFingerprint,
  httpIdempotencyClaimId,
  requestId = null,
}) {
  const tid = requireTenantId(tenantId);
  if (!commandKey || !requestFingerprint || !httpIdempotencyClaimId) {
    throw AppError.badRequest(
      'Medication exception disposition requires a durable idempotency command',
      'MAR_EXCEPTION_IDEMPOTENCY_REQUIRED',
    );
  }
  const result = await setTenantTx(tid, async (tx) => {
    const resolved = await resolveMarMedicationExceptionTx(tx, {
      tenantId: tid,
      exceptionCaseId,
      disposition,
      reason,
      actorUid,
      commandKey,
      requestFingerprint,
      replacementClinicalOrderId,
      completeTaskTx: completeTaskFromDomainEvidence,
    });
    const response = marExceptionResponse(resolved);
    if (!resolved.replayed) {
      await recordCanonicalMarEvent({
        record: {
          id: Number(resolved.exceptionCase.medication_administration_id),
          tenant_id: tid,
          patient_uid: resolved.exceptionCase.patient_uid,
          clinical_order_id: resolved.exceptionCase.clinical_order_id,
          medication_name: resolved.exceptionCase.medication_name,
          scheduled_time: resolved.exceptionCase.scheduled_time,
          status: resolved.exceptionCase.administration_status,
        },
        eventType: 'mar.exception_reviewed',
        actorUid,
        actorRole: resolved.exceptionCase.actor_role,
        previousStatus: resolved.exceptionCase.administration_status,
        payload: {
          exception_case_id: requiredMarMedicationExceptionCaseId(resolved.exceptionCase.id),
          disposition: resolved.event.disposition,
          resolution_event_id: requiredMarMedicationExceptionEventId(resolved.event.id),
          replacement_clinical_order_id: replacementClinicalOrderId,
          treatment_mutated: false,
          review_reason: String(reason || '').trim(),
        },
        db: tx,
      });
    }
    await finaliseMarHttpIdempotencyTx(tx, {
      claimId: httpIdempotencyClaimId,
      tenantId: tid,
      actorUid,
      commandKey,
      requestBodySha256: requestFingerprint,
      responseData: response,
      requestId,
      message: 'Medication exception disposition recorded',
    });
    return response;
  });
  logger.info(`MAR medication exception ${exceptionCaseId} disposition recorded`, {
    actorUid,
    disposition,
  });
  return result;
}

export async function getAssignedMedicationExceptions({
  tenantId,
  actorUid,
  caseId = null,
}) {
  const tid = requireTenantId(tenantId);
  return setTenantTx(tid, (tx) => listAssignedMarMedicationExceptions({
    db: tx,
    tenantId: tid,
    actorUid,
    caseId,
  }));
}

export async function getMedicationExceptionAdministrationId({
  tenantId,
  exceptionCaseId,
}) {
  const tid = requireTenantId(tenantId);
  return setTenantTx(tid, (tx) => getMarExceptionMedicationAdministrationId({
    db: tx,
    tenantId: tid,
    exceptionCaseId,
  }));
}

/**
 * Get a patient's MAR for a specific date.
 * @param {string} patientUid
 * @param {string} date - ISO date string (YYYY-MM-DD), defaults to today
 * @returns {Array} Medication records for the day
 */
export async function getPatientMAR(patientUid, date) {
  const targetDate = date || new Date().toISOString().split('T')[0];

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, prescription_id, medication_name, dose, route,
            scheduled_time, administered_at, administered_by, status,
            hold_reason, refusal_reason, notes, witness_uid, created_at
     FROM medication_administrations
     WHERE patient_uid = $1::uuid
       AND scheduled_time >= $2::date
       AND scheduled_time < ($2::date + INTERVAL '1 day')
     ORDER BY scheduled_time ASC`,
    patientUid, targetDate
  );

  return rows;
}

/**
 * Get overdue medications (scheduled but past their scheduled_time).
 * Optionally filter by ward via a join with bed assignments.
 * @param {string|null} wardId
 * @returns {Array} Overdue medication records
 */
export async function getOverdueMedications(wardId, { tenantId } = {}) {
  const tid = requireTenantId(tenantId);
  let query = `
    SELECT ma.id, ma.patient_uid, ma.medication_name, ma.dose, ma.route,
           ma.scheduled_time, ma.status, ma.notes
    FROM medication_administrations ma
    WHERE ma.tenant_id = $1::uuid
      AND ma.status = 'scheduled'
      AND ma.scheduled_time < NOW()
  `;
  const params = [tid];

  if (wardId) {
    params.push(wardId);
    query += `
      AND ma.patient_uid IN (
        SELECT b.patient_uid FROM beds b
        WHERE b.tenant_id = $1::uuid
          AND b.ward_id = $${params.length}
          AND b.patient_uid IS NOT NULL
      )
    `;
  }

  query += ' ORDER BY ma.scheduled_time ASC';

  const rows = await prisma.$queryRawUnsafe(query, ...params);
  return rows;
}

/**
 * Get the nurse "due meds" list — scheduled/held medications within a
 * rolling window around now. Joins patient name + bed/ward so the client
 * can render a single list without extra round-trips.
 *
 * @param {Object} opts
 * @param {number|null} opts.wardId - Optional ward filter
 * @param {number} opts.pastMinutes - How far back to look (default 120)
 * @param {number} opts.futureMinutes - How far forward (default 60)
 * @returns {Array} Medication rows with patient_name, bed_number, ward_name
 */
export async function getDueMedications({
  tenantId,
  wardId = null,
  pastMinutes = 120,
  futureMinutes = 60,
} = {}) {
  const tid = requireTenantId(tenantId);
  const params = [tid, pastMinutes, futureMinutes];
  let wardClause = '';
  if (wardId) {
    params.push(wardId);
    wardClause = `AND b.ward_id = $${params.length}`;
  }

  const query = `
    SELECT ma.id,
           ma.patient_uid,
           ma.medication_name,
           ma.dose,
           ma.dosage,
           ma.route,
           ma.scheduled_time,
           ma.status,
           ma.notes,
           u.name AS patient_name,
           b.bed_number,
           b.ward_id,
           w.name AS ward_name
      FROM medication_administrations ma
      LEFT JOIN users u
        ON u.tenant_id = ma.tenant_id
       AND u.uid = ma.patient_uid
      LEFT JOIN beds b
        ON b.tenant_id = ma.tenant_id
       AND b.patient_id = u.id
      LEFT JOIN wards w
        ON w.tenant_id = ma.tenant_id
       AND w.id = b.ward_id
     WHERE ma.tenant_id = $1::uuid
       AND ma.status IN ('scheduled', 'held')
       AND ma.scheduled_time BETWEEN (NOW() - ($2 || ' minutes')::interval)
                                 AND (NOW() + ($3 || ' minutes')::interval)
       ${wardClause}
     ORDER BY ma.scheduled_time ASC
  `;

  return prisma.$queryRawUnsafe(query, ...params);
}

export default {
  scheduleMedications,
  recordAdministration,
  recordMissed,
  holdMedication,
  releaseHeldMedication,
  claimMedicationException,
  handoffMedicationException,
  recordMedicationExceptionDisposition,
  getAssignedMedicationExceptions,
  getMedicationExceptionAdministrationId,
  getPatientMAR,
  getOverdueMedications,
  getDueMedications,
};
