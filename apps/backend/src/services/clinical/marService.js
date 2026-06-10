// src/services/clinical/marService.js
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from './canonicalClinicalPlatformService.js';
import { BCMA_CONFIG } from '../../config/pharmacyConfig.js';

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
} = {}) {
  if (!record?.id) return null;
  const status = record.status || null;
  const stamp = record.updated_at?.toISOString?.()
    || record.administered_at?.toISOString?.()
    || record.created_at?.toISOString?.()
    || Date.now();

  try {
    return await recordCanonicalClinicalEvent({
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
    });
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

  for (const med of expandedMeds) {
    if (!med.medication_name || !med.dose || !med.route || !med.scheduled_time) {
      throw AppError.badRequest('Each medication must have medication_name (or drug_name), dose, route, and scheduled_time (or frequency)');
    }

    const normalizedRoute = normalizeRoute(med.route);
    if (!VALID_ROUTES.includes(normalizedRoute)) {
      throw AppError.badRequest(`Invalid route: ${med.route}. Must be one of: ${VALID_ROUTES.join(', ')}`);
    }

    // F-2 — idempotency guard. If an active (non-cancelled) row already
    // exists for the same patient + medication in the same clinical slot,
    // return it instead of creating a duplicate. The one-minute tolerance
    // absorbs ER-to-ICU carry-over millisecond drift while preserving
    // normal repeated-dose schedules. Findings:
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

    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO medication_administrations
         (patient_uid, prescription_id, medication_name, dose, route, scheduled_time, notes, status)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::timestamptz, $7, 'scheduled')
       RETURNING id, patient_uid, medication_name, dose, dosage, route, scheduled_time, status, administered_by, notes, created_at`,

        patientUid,
        prescriptionId || null,
        med.medication_name,
        med.dose,
        normalizedRoute,
        med.scheduled_time,
        med.notes || null,

    );
    results.push(rows[0]);
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
    });
  }

  logger.info(`Scheduled ${results.length} medications for patient ${patientUid}`);
  return results;
}

/**
 * Record medication administration.
 * @param {number} id - medication_administrations.id
 * @param {string} administeredBy - Staff UID
 * @param {string|null} notes
 * @param {string|null} witnessUid - For controlled substances
 * @returns {Object} Updated record
 */
export async function recordAdministration(id, administeredBy, notes = null, witnessUid = null, options = {}) {
  // Roadmap B1 — BCMA enforcement: bedside administration is scan-first.
  // The non-scan path stays available for genuine downtime (dead scanner,
  // damaged wristband) but requires an explicit override reason, which is
  // persisted on the row and audited on the canonical event.
  const noScanOverrideReason = (options.overrideReason || '').trim() || null;
  if (BCMA_CONFIG.requireScanForMarAdministration && !noScanOverrideReason) {
    throw AppError.conflict(
      'Barcode scan is required for administration — use POST /clinical/mar/:id/administer-with-scan, or supply override_reason for a documented no-scan administration',
      'MAR_SCAN_REQUIRED',
      { scan_endpoint: '/clinical/mar/:id/administer-with-scan' },
    );
  }

  const existing = await prisma.$queryRawUnsafe(
    `SELECT id, status, patient_uid, medication_name, scheduled_time, tenant_id
       FROM medication_administrations
      WHERE id = $1`,
    id
  );

  if (existing.length === 0) {
    throw AppError.notFound('Medication administration record not found');
  }

  if (existing[0].status === 'administered') {
    throw AppError.conflict('Medication has already been administered');
  }

  if (!['scheduled', 'held'].includes(existing[0].status)) {
    throw AppError.invalidTransition(existing[0].status, 'administered', ['scheduled', 'held']);
  }

  // F-2 — cross-row duplicate guard. The id-level check above only
  // blocks re-administering the same row; it can't see a sibling row
  // for the same patient + medication + clinical slot that another
  // nurse already administered. Without this guard the same dose was
  // chartable twice. Findings:
  // 2026-05-09-inpatient-admission-nurse-mar-no-duplicate-guard
  // 2026-05-20-emergency-walk-in-nurse-7622bcce.
  const sibling = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM medication_administrations
      WHERE id <> $1
        AND patient_uid = $2::uuid
        AND medication_name = $3
        AND scheduled_time >= ($4::timestamptz - INTERVAL '1 minute')
        AND scheduled_time < ($4::timestamptz + INTERVAL '1 minute')
        AND status = 'administered'
      ORDER BY ABS(EXTRACT(EPOCH FROM (scheduled_time - $4::timestamptz))) ASC, id ASC
      LIMIT 1`,
    id, existing[0].patient_uid, existing[0].medication_name, existing[0].scheduled_time,
  );
  if (sibling.length) {
    throw AppError.conflict(
      `Another MAR row (id=${sibling[0].id}) for this medication and scheduled time has already been administered`,
      'MAR_DUPLICATE_ADMINISTRATION',
      { duplicate_id: sibling[0].id },
    );
  }

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE medication_administrations
     SET status = 'administered',
         administered_at = NOW(),
         administered_by = $2::uuid,
         notes = COALESCE($3, notes),
         witness_uid = $4::uuid,
         override_reason = COALESCE($5, override_reason)
     WHERE id = $1
     RETURNING id, patient_uid, medication_name, dose, dosage, route, scheduled_time,
               administered_at, status, administered_by, notes, witness_uid,
               override_reason, tenant_id, created_at, updated_at`,
    id, administeredBy, notes, witnessUid, noScanOverrideReason
  );

  await recordCanonicalMarEvent({
    record: rows[0],
    eventType: 'mar.administered',
    actorUid: administeredBy,
    previousStatus: existing[0].status,
    payload: noScanOverrideReason
      ? { scanner_used: false, no_scan_override: true, no_scan_override_reason: noScanOverrideReason }
      : { scanner_used: false },
  });

  logger.info(`Medication ${id} administered by ${administeredBy}`);
  return rows[0];
}

/**
 * Record a missed medication dose.
 * @param {number} id
 * @param {string} reason
 * @returns {Object} Updated record
 */
export async function recordMissed(id, reason, missedBy = null) {
  const existing = await prisma.$queryRawUnsafe(
    'SELECT id, status FROM medication_administrations WHERE id = $1',
    id
  );

  if (existing.length === 0) {
    throw AppError.notFound('Medication administration record not found');
  }

  if (existing[0].status !== 'scheduled') {
    throw AppError.invalidTransition(existing[0].status, 'missed', ['scheduled']);
  }

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE medication_administrations
     SET status = 'missed', notes = COALESCE($2, notes)
     WHERE id = $1
     RETURNING id, patient_uid, medication_name, dose, dosage, route, scheduled_time,
               status, administered_by, notes, tenant_id, created_at, updated_at`,
    id, reason
  );

  await recordCanonicalMarEvent({
    record: rows[0],
    eventType: 'mar.missed',
    actorUid: missedBy,
    previousStatus: existing[0].status,
    payload: { reason },
  });

  logger.info(`Medication ${id} marked as missed`);
  return rows[0];
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

  const existing = await prisma.$queryRawUnsafe(
    'SELECT id, status FROM medication_administrations WHERE id = $1',
    id
  );

  if (existing.length === 0) {
    throw AppError.notFound('Medication administration record not found');
  }

  if (existing[0].status !== 'scheduled') {
    throw AppError.invalidTransition(existing[0].status, 'held', ['scheduled']);
  }

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE medication_administrations
     SET status = 'held', hold_reason = $2, administered_by = $3::uuid
     WHERE id = $1
     RETURNING id, patient_uid, medication_name, dose, dosage, route, scheduled_time,
               status, administered_by, hold_reason, notes, tenant_id,
               created_at, updated_at`,
    id, reason, heldBy
  );

  await recordCanonicalMarEvent({
    record: rows[0],
    eventType: 'mar.held',
    actorUid: heldBy,
    previousStatus: existing[0].status,
    payload: { reason },
  });

  logger.info(`Medication ${id} held by ${heldBy}: ${reason}`);
  return rows[0];
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
