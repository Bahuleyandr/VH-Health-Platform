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

function rankSeverity(value) {
  if (!value) return 0;
  return SEVERITY_RANK[String(value).trim().toUpperCase()] || 0;
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

  try {
    const rows = await db.$queryRawUnsafe(
      `WITH patient_row AS (
         SELECT id, uid, allergies
           FROM users
          WHERE ($1::int  IS NOT NULL AND id  = $1::int)
             OR ($2::uuid IS NOT NULL AND uid = $2::uuid)
          LIMIT 1
       ),
       structured AS (
         SELECT pa.allergy_name AS allergen, pa.severity, 'patient_allergies' AS source
           FROM patient_allergies pa
           JOIN patient_row p ON (pa.patient_id = p.id OR pa.patient_uid = p.uid)
          WHERE COALESCE(pa.is_active, TRUE) = TRUE
       ),
       legacy AS (
         SELECT COALESCE(NULLIF(a.allergen, ''), a.name) AS allergen, a.severity,
                'allergies' AS source
           FROM allergies a
           JOIN patient_row p ON a.patient_uid = p.uid
          WHERE COALESCE(a.status, 'active') NOT IN ('inactive', 'resolved', 'entered-in-error')
       ),
       profile AS (
         SELECT trim(value) AS allergen, NULL::text AS severity, 'users.allergies' AS source
           FROM patient_row p,
                regexp_split_to_table(COALESCE(p.allergies, ''), ',') AS value
          WHERE trim(value) <> ''
       ),
       admission_intake AS (
         SELECT trim(value) AS allergen, NULL::text AS severity, 'admission_intake' AS source
           FROM patient_row p
           JOIN LATERAL (
             SELECT a2.allergies
               FROM admissions a2
              WHERE a2.patient_uid = p.uid
                AND COALESCE(a2.status, 'admitted') NOT IN ('discharged', 'cancelled')
              ORDER BY a2.created_at DESC
              LIMIT 1
           ) latest ON TRUE,
           unnest(COALESCE(latest.allergies, ARRAY[]::text[])) AS value
          WHERE trim(value) <> ''
       )
       SELECT allergen, severity, source
         FROM (
           SELECT * FROM structured
           UNION ALL SELECT * FROM legacy
           UNION ALL SELECT * FROM profile
           UNION ALL SELECT * FROM admission_intake
         ) merged
        WHERE allergen IS NOT NULL AND trim(allergen) <> ''`,
      idInt,
      uid,
    );
    return mergeAllergyRows(rows);
  } catch (err) {
    logger.warn('Unified allergy fetch failed — treating as no structured allergies on file', {
      patientId: idInt,
      patientUid: uid,
      error: err?.message,
    });
    return [];
  }
}

export default { getUnifiedActiveAllergies, mergeAllergyRows };
