// src/services/clinical/marService.js
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import {
  recordCanonicalClinicalEvent,
  recordMedicationSafetyReviews,
} from './canonicalClinicalPlatformService.js';
import { BCMA_CONFIG } from '../../config/pharmacyConfig.js';
import { requireTenantId } from '../tenant/tenantService.js';

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
function expandSchedule(frequency, startTime, durationDays) {
  const interval = hoursForFrequency(frequency);
  if (interval == null) return null;
  const start = startTime ? new Date(startTime) : new Date();
  if (Number.isNaN(start.getTime())) return null;
  const days = Math.max(1, Math.min(Number(durationDays) || 1, 14));
  const totalDoses = Math.ceil((days * 24) / interval);
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
      source_clinical_order_id: sourceClinicalOrderId || null,
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

  // Expand frequency-only entries into a flat list of (medication, scheduled_time)
  // tuples before the row-by-row write loop. Done up front so a malformed
  // frequency surfaces as a single 400 instead of partial rows.
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

  const results = [];
  // Single-tenant-safe: the medication_administrations.tenant_id column carries a
  // literal default, so an insert that omits it lands on the default tenant.
  // setTenantTx(tenantId) makes the per-row detail write + canonical MAR event
  // atomic and tenant-scoped.
  const tenantId = requireTenantId(context.tenantId);

  for (const med of expandedMeds) {
    if (!med.medication_name || !med.dose || !med.route || !med.scheduled_time) {
      throw AppError.badRequest('Each medication must have medication_name (or drug_name), dose, route, and scheduled_time (or frequency)');
    }

    const normalizedRoute = normalizeRoute(med.route);
    if (!VALID_ROUTES.includes(normalizedRoute)) {
      throw AppError.badRequest(`Invalid route: ${med.route}. Must be one of: ${VALID_ROUTES.join(', ')}`);
    }

    // F-2 — idempotency guard (Phase 0, pre-flight on plain prisma). If an
    // active (non-cancelled) row already exists for the same patient +
    // medication in the same clinical slot, return it instead of creating a
    // duplicate. The one-minute tolerance absorbs ER-to-ICU carry-over
    // millisecond drift while preserving normal repeated-dose schedules.
    // Findings:
    // 2026-05-09-inpatient-admission-nurse-mar-no-duplicate-guard
    // 2026-05-20-emergency-walk-in-nurse-7622bcce.
    const dup = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, medication_name, dose, dosage, route, scheduled_time, status, administered_by, notes, created_at
         FROM medication_administrations
        WHERE patient_uid = $1::uuid
          AND medication_name = $2
          AND scheduled_time >= ($3::timestamptz - INTERVAL '1 minute')
          AND scheduled_time < ($3::timestamptz + INTERVAL '1 minute')
          AND status <> 'cancelled'
        ORDER BY ABS(EXTRACT(EPOCH FROM (scheduled_time - $3::timestamptz))) ASC, id ASC
        LIMIT 1`,
      patientUid, med.medication_name, med.scheduled_time,
    );
    if (dup.length) {
      results.push(dup[0]);
      continue;
    }

    // Phase 1 — atomic: the scheduled MAR row + its canonical mar.scheduled
    // timeline + audit event commit together (or roll back together). Previously
    // the canonical event ran outside the tx, swallowed — so a scheduled dose
    // could exist with no canonical safety record.
    const row = await setTenantTx(tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO medication_administrations
           (patient_uid, prescription_id, medication_name, dose, route, scheduled_time, notes, status)
         VALUES ($1::uuid, $2, $3, $4, $5, $6::timestamptz, $7, 'scheduled')
         RETURNING id, patient_uid, medication_name, dose, dosage, route, scheduled_time, status, administered_by, notes, tenant_id, created_at`,
        patientUid,
        prescriptionId || null,
        med.medication_name,
        med.dose,
        normalizedRoute,
        med.scheduled_time,
        med.notes || null,
      );
      await recordCanonicalMarEvent({
        record: rows[0],
        eventType: 'mar.scheduled',
        actorUid: context.actorUid,
        actorRole: context.actorRole,
        encounterId: context.encounterId,
        sourceClinicalOrderId: context.sourceClinicalOrderId,
        payload: {
          prescription_id: prescriptionId || null,
        },
        db: tx,
      });
      return rows[0];
    });
    results.push(row);
  }

  logger.info(`Scheduled ${results.length} medications for patient ${patientUid}`);
  return results;
}

export const MAR_ADMINISTRATION_MODES = Object.freeze({
  ONLINE_NO_SCAN: 'online_no_scan',
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
    return AppError.invalidTransition(inspection.currentStatus, 'administered', ['scheduled', 'held']);
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
  if (!['scheduled', 'held'].includes(currentStatus)) {
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
          AND lower(status) IN ('scheduled', 'held')
        RETURNING id, patient_uid::text, medication_name, dose, dosage, route,
                  scheduled_time, administered_at, status, administered_by::text,
                  notes, witness_uid::text, override_reason, tenant_id::text,
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
  return { disposition: 'recorded', record: rows[0], previousStatus: checked.row.status };
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

  const result = await setTenantTx(tid, async (tx) => {
    const inspection = await inspectMedicationAdministrationTx(tx, {
      tenantId: tid,
      medicationAdministrationId: id,
      administeredBy,
      witnessUid,
    });
    if (inspection.disposition !== 'apply') throw inspectionError(inspection);
    const applied = await recordMedicationAdministrationTx(tx, {
      tenantId: tid,
      medicationAdministrationId: id,
      administeredBy,
      notes,
      witnessUid,
      overrideReason: noScanOverrideReason,
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
      payload: noScanOverrideReason
        ? { scanner_used: false, no_scan_override: true, no_scan_override_reason: noScanOverrideReason }
        : { scanner_used: false },
      db: tx,
    });
    return applied.record;
  });

  logger.info(`Medication ${id} administered by ${administeredBy}`);
  return result;
}

/**
 * Record a missed medication dose.
 * @param {number} id
 * @param {string} reason
 * @returns {Object} Updated record
 */
export async function recordMissed(id, reason, missedBy = null) {
  // Phase 0 — pre-flight existence/state check on plain prisma.
  const existing = await prisma.$queryRawUnsafe(
    'SELECT id, status, tenant_id FROM medication_administrations WHERE id = $1',
    id
  );

  if (existing.length === 0) {
    throw AppError.notFound('Medication administration record not found');
  }

  if (existing[0].status !== 'scheduled') {
    throw AppError.invalidTransition(existing[0].status, 'missed', ['scheduled']);
  }

  const tenantId = requireTenantId(existing[0].tenant_id);

  // Phase 1 — atomic: the missed-dose state flip + its canonical mar.missed
  // timeline + audit event commit together. A missed dose is a safety event;
  // emitting the canonical row on `tx` (was swallowed outside the tx) means a
  // canonical-write failure rolls the state change back rather than losing it.
  const row = await setTenantTx(tenantId, async (tx) => {
    // Concurrency guard (mirrors recordMedicationAdministrationTx /
    // marFiveRightsService.administerWithScan). The Phase-0 status check above
    // read the row UNLOCKED and OUTSIDE this tx; that read is not a safe basis
    // for the state flip. Lock the row FOR UPDATE and re-check status inside
    // the tx so a nurse marking an overdue dose missed serializes against a
    // concurrent administration — the loser sees status='administered' and is
    // rejected with a 409 instead of silently flipping a given dose to missed.
    const lockedRows = await tx.$queryRawUnsafe(
      `SELECT id, status
         FROM medication_administrations
        WHERE tenant_id = $1::uuid AND id = $2::integer
        FOR UPDATE`,
      tenantId, id,
    );
    const locked = lockedRows[0];
    if (!locked) throw AppError.notFound('Medication administration record not found');
    if (String(locked.status || '').toLowerCase() !== 'scheduled') {
      throw AppError.conflict('Medication state changed', 'MAR_ADMINISTRATION_STATE_CONFLICT');
    }

    const rows = await tx.$queryRawUnsafe(
      `UPDATE medication_administrations
       SET status = 'missed', notes = COALESCE($2, notes)
       WHERE tenant_id = $3::uuid AND id = $1
         AND lower(status) = 'scheduled'
       RETURNING id, patient_uid, medication_name, dose, dosage, route, scheduled_time,
                 status, administered_by, notes, tenant_id, created_at, updated_at`,
      id, reason, tenantId
    );
    // Lost race despite the lock (defense in depth): the status guard matched
    // 0 rows. Reject rather than emit a canonical event for a write that
    // never happened.
    if (rows.length !== 1) {
      throw AppError.conflict('Medication state changed', 'MAR_ADMINISTRATION_STATE_CONFLICT');
    }
    await recordCanonicalMarEvent({
      record: rows[0],
      eventType: 'mar.missed',
      actorUid: missedBy,
      previousStatus: locked.status,
      payload: { reason },
      db: tx,
    });
    return rows[0];
  });

  logger.info(`Medication ${id} marked as missed`);
  return row;
}

/**
 * Hold a medication with reason.
 * @param {number} id
 * @param {string} reason
 * @param {string} heldBy - Staff UID
 * @returns {Object} Updated record
 */
export async function holdMedication(id, reason, heldBy) {
  if (!reason) {
    throw AppError.badRequest('Hold reason is required');
  }

  // Phase 0 — pre-flight existence/state check on plain prisma.
  const existing = await prisma.$queryRawUnsafe(
    'SELECT id, status, tenant_id FROM medication_administrations WHERE id = $1',
    id
  );

  if (existing.length === 0) {
    throw AppError.notFound('Medication administration record not found');
  }

  if (existing[0].status !== 'scheduled') {
    throw AppError.invalidTransition(existing[0].status, 'held', ['scheduled']);
  }

  const tenantId = requireTenantId(existing[0].tenant_id);

  // Phase 1 — atomic: the hold state flip + its canonical mar.held timeline +
  // audit event commit together. Emitting on `tx` (was swallowed outside the tx)
  // means a canonical-write failure rolls the hold back rather than losing the
  // safety record.
  const row = await setTenantTx(tenantId, async (tx) => {
    // Concurrency guard (mirrors recordMedicationAdministrationTx /
    // marFiveRightsService.administerWithScan). Without it, a hold racing an
    // administration could flip an administered dose back to 'held' AND
    // overwrite administered_by with the holding nurse, destroying the
    // administering nurse's attribution. Lock FOR UPDATE, re-check status
    // inside the tx, and reject the loser with a 409 — the administered
    // record (status + administered_by) is preserved untouched.
    const lockedRows = await tx.$queryRawUnsafe(
      `SELECT id, status
         FROM medication_administrations
        WHERE tenant_id = $1::uuid AND id = $2::integer
        FOR UPDATE`,
      tenantId, id,
    );
    const locked = lockedRows[0];
    if (!locked) throw AppError.notFound('Medication administration record not found');
    if (String(locked.status || '').toLowerCase() !== 'scheduled') {
      throw AppError.conflict('Medication state changed', 'MAR_ADMINISTRATION_STATE_CONFLICT');
    }

    const rows = await tx.$queryRawUnsafe(
      `UPDATE medication_administrations
       SET status = 'held', hold_reason = $2, administered_by = $3::uuid
       WHERE tenant_id = $4::uuid AND id = $1
         AND lower(status) = 'scheduled'
       RETURNING id, patient_uid, medication_name, dose, dosage, route, scheduled_time,
                 status, administered_by, hold_reason, notes, tenant_id,
                 created_at, updated_at`,
      id, reason, heldBy, tenantId
    );
    // Lost race despite the lock (defense in depth): the status guard matched
    // 0 rows. Reject rather than emit a canonical event for a write that
    // never happened.
    if (rows.length !== 1) {
      throw AppError.conflict('Medication state changed', 'MAR_ADMINISTRATION_STATE_CONFLICT');
    }
    await recordCanonicalMarEvent({
      record: rows[0],
      eventType: 'mar.held',
      actorUid: heldBy,
      previousStatus: locked.status,
      payload: { reason },
      db: tx,
    });
    return rows[0];
  });

  logger.info(`Medication ${id} held by ${heldBy}: ${reason}`);
  return row;
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
export async function getOverdueMedications(wardId) {
  let query = `
    SELECT ma.id, ma.patient_uid, ma.medication_name, ma.dose, ma.route,
           ma.scheduled_time, ma.status, ma.notes
    FROM medication_administrations ma
    WHERE ma.status = 'scheduled'
      AND ma.scheduled_time < NOW()
  `;
  const params = [];

  if (wardId) {
    params.push(wardId);
    query += `
      AND ma.patient_uid IN (
        SELECT b.patient_uid FROM beds b
        WHERE b.ward_id = $${params.length} AND b.patient_uid IS NOT NULL
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
export async function getDueMedications({ wardId = null, pastMinutes = 120, futureMinutes = 60 } = {}) {
  const params = [pastMinutes, futureMinutes];
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
      LEFT JOIN users u ON u.uid = ma.patient_uid
      LEFT JOIN beds  b ON b.patient_id = u.id
      LEFT JOIN wards w ON w.id = b.ward_id
     WHERE ma.status IN ('scheduled', 'held')
       AND ma.scheduled_time BETWEEN (NOW() - ($1 || ' minutes')::interval)
                                 AND (NOW() + ($2 || ' minutes')::interval)
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
  getPatientMAR,
  getOverdueMedications,
  getDueMedications,
};
