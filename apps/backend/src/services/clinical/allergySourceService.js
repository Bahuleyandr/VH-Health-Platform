// src/services/clinical/allergySourceService.js
//
// Roadmap A10 — single source of truth for "what is this patient allergic
// to?". Allergies historically landed in FOUR places, and every consumer
// read a different subset:
//
//   1. patient_allergies   — structured store (allergy_name, severity,
//                            is_active; some rows keyed by patient_id int,
//                            some by patient_uid uuid)
//   2. allergies           — legacy/import table (allergen|name, status;
//                            written by patientDataImport, read ONLY by the
//                            CCDA/FHIR exporters)
//   3. users.allergies     — free-text comma-separated profile column
//   4. admissions.allergies — text[] captured at admission intake
//
// Before this service, validatePrescriptionSafety() read ONLY
// patient_allergies by patient_id — an allergy imported from prior records
// (table 2), profile-captured (3), or recorded at ER/IPD intake (4) never
// reached the prescription gate. Finding class: 2026-05-23 triage "H' D11 —
// Allergy propagation".
//
// Contract: getUnifiedActiveAllergies never throws — clinical callers treat
// allergy fetch as best-effort and must not 500 a prescribing flow because
// one source table is missing on a dev DB. Missing-table errors are
// swallowed per-source via the COALESCE-style union below being executed as
// one statement; statement-level failure returns [] with a warn log.

import logger from '../../logging/logger.js';

const SEVERITY_RANK = {
  LIFE_THREATENING: 5,
  ANAPHYLAXIS: 5,
  CONTRAINDICATED: 4,
  SEVERE: 4,
  HIGH: 3,
  MODERATE: 2,
  MILD: 1,
};

// At/above this rank an allergy-drug conflict is a hard blocker, not a warning
// (SEVERE / CONTRAINDICATED and up). Exported so the prescription gate ranks
// severity instead of matching a hardcoded label set.
export const SEVERE_BLOCK_RANK = 4;

// Labels that explicitly assert NO known severity → rank 0 (warning, not a
// blocker). These are deliberate "we don't know" sentinels, distinct from an
// UNPARSEABLE label.
const NO_SEVERITY_CLAIM = new Set(['UNKNOWN', 'UNSPECIFIED', 'NONE', 'N/A', 'NA', 'NULL', 'NIL']);

// A severity that is PRESENT and not an explicit no-claim sentinel but is not in
// SEVERITY_RANK is treated as SEVERE (fail-safe): a clinician recorded a real
// severity we merely failed to parse, and we must never silently downgrade it to
// a warning. Absent/blank/no-claim severity stays 0 (free-text/profile/intake).
export function rankSeverity(value) {
  if (value == null) return 0;
  const key = String(value).trim().toUpperCase();
  if (!key || NO_SEVERITY_CLAIM.has(key)) return 0;
  return SEVERITY_RANK[key] ?? SEVERE_BLOCK_RANK;
}

/**
 * Merge duplicate allergens (case-insensitive), keeping the highest-ranked
 * severity and accumulating the sources that mentioned it. Pure — exported
 * for unit tests.
 */
export function mergeAllergyRows(rows) {
  const byKey = new Map();
  for (const row of rows || []) {
    const allergen = String(row?.allergen || '').trim();
    if (!allergen) continue;
    const key = allergen.toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        allergen,
        severity: row.severity || null,
        sources: [row.source].filter(Boolean),
      });
      continue;
    }
    if (rankSeverity(row.severity) > rankSeverity(existing.severity)) {
      existing.severity = row.severity;
    }
    if (row.source && !existing.sources.includes(row.source)) {
      existing.sources.push(row.source);
    }
  }
  return [...byKey.values()];
}

/**
 * Fetch every active allergy for a patient across all four stores.
 *
 * @param {object} db    prisma-compatible client ($queryRawUnsafe)
 * @param {object} ref   { patientId?: number|string, patientUid?: string }
 * @returns {Promise<Array<{allergen: string, severity: string|null, sources: string[]}>>}
 */
export async function getUnifiedActiveAllergies(db, { patientId = null, patientUid = null } = {}) {
  const idInt = patientId != null && /^\d+$/.test(String(patientId))
    ? Number.parseInt(String(patientId), 10)
    : null;
  const uid = typeof patientUid === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(patientUid.trim())
    ? patientUid.trim()
    : null;
  if (idInt == null && uid == null) return [];

  // Resolve the patient once (id + uid + free-text profile allergies). If even
  // this fails the patient is genuinely unresolvable and there is nothing to
  // fetch.
  let patient = null;
  try {
    const prows = await db.$queryRawUnsafe(
      `SELECT id, uid, allergies
         FROM users
        WHERE ($1::int  IS NOT NULL AND id  = $1::int)
           OR ($2::uuid IS NOT NULL AND uid = $2::uuid)
        LIMIT 1`,
      idInt,
      uid,
    );
    patient = prows[0] || null;
  } catch (err) {
    logger.warn('Unified allergy fetch: patient lookup failed', {
      patientId: idInt, patientUid: uid, error: err?.message,
    });
    return [];
  }
  if (!patient) return [];

  // Each source is queried INDEPENDENTLY and its failure is isolated: a single
  // source's schema fault (e.g. a table missing on a partial DB) must degrade
  // only THAT source, never silently zero every allergy at the prescription
  // gate (audit §3: fail-open UNION). The free-text profile source is pure JS
  // so it cannot fail.
  const rows = [];

  // 1. Structured store (patient_allergies).
  try {
    const r = await db.$queryRawUnsafe(
      `SELECT pa.allergy_name AS allergen, pa.severity
         FROM patient_allergies pa
        WHERE (pa.patient_id = $1::int OR pa.patient_uid = $2::uuid)
          AND COALESCE(pa.is_active, TRUE) = TRUE`,
      patient.id,
      patient.uid,
    );
    for (const row of r) rows.push({ allergen: row.allergen, severity: row.severity, source: 'patient_allergies' });
  } catch (err) {
    logger.warn("Unified allergy fetch: source 'patient_allergies' failed — skipping it", { error: err?.message });
  }

  // 2. Legacy/import table (allergies).
  try {
    const r = await db.$queryRawUnsafe(
      `SELECT COALESCE(NULLIF(a.allergen, ''), a.name) AS allergen, a.severity
         FROM allergies a
        WHERE a.patient_uid = $1::uuid
          AND COALESCE(a.status, 'active') NOT IN ('inactive', 'resolved', 'entered-in-error')`,
      patient.uid,
    );
    for (const row of r) rows.push({ allergen: row.allergen, severity: row.severity, source: 'allergies' });
  } catch (err) {
    logger.warn("Unified allergy fetch: source 'allergies' failed — skipping it", { error: err?.message });
  }

  // 3. Free-text profile column (users.allergies) — pure JS, cannot fail.
  for (const value of String(patient.allergies || '').split(',')) {
    const allergen = value.trim();
    if (allergen) rows.push({ allergen, severity: null, source: 'users.allergies' });
  }

  // 4. Admission intake (latest active admission's allergies[]).
  try {
    const r = await db.$queryRawUnsafe(
      `SELECT trim(value) AS allergen
         FROM (
           SELECT a2.allergies
             FROM admissions a2
            WHERE a2.patient_uid = $1::uuid
              AND COALESCE(a2.status, 'admitted') NOT IN ('discharged', 'cancelled')
            ORDER BY a2.created_at DESC
            LIMIT 1
         ) latest,
         unnest(COALESCE(latest.allergies, ARRAY[]::text[])) AS value
        WHERE trim(value) <> ''`,
      patient.uid,
    );
    for (const row of r) rows.push({ allergen: row.allergen, severity: null, source: 'admission_intake' });
  } catch (err) {
    logger.warn("Unified allergy fetch: source 'admission_intake' failed — skipping it", { error: err?.message });
  }

  return mergeAllergyRows(rows);
}

export default { getUnifiedActiveAllergies, mergeAllergyRows };
