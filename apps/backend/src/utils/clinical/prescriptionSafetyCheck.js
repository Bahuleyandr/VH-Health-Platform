import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

/**
 * Per-dose mg/kg ceilings for common paediatric drugs. Names matched
 * case-insensitive substring against the medication name. Conservative
 * limits — production should pull from a curated drug master rather than
 * this seed list. See finding
 * 2026-05-08-pediatric-opd-doctor-no-weight-based-dose-check.
 */
const PAEDIATRIC_MG_PER_KG = {
  paracetamol: 15,        // 10–15 mg/kg/dose, 60 mg/kg/day max
  acetaminophen: 15,
  ibuprofen: 10,          // 5–10 mg/kg/dose, 40 mg/kg/day max
  amoxicillin: 25,        // 20–40 mg/kg/dose
  azithromycin: 10,
  cefixime: 8,
  ciprofloxacin: 15,
  ondansetron: 0.15,      // 0.1–0.15 mg/kg/dose
  cetirizine: 5,          // total mg, age-dependent — flag aggressive overdose
};

const DOSE_VALUE_RX = /(-?\d+(?:\.\d+)?)\s*(mg|mcg|µg|g|ml)\b/i;

// Syrup-strength patterns in medication names. Catch "125mg/5ml",
// "100 mg/ml", "100mg / 5 ml", etc. Returns mg-per-ml when present.
const STRENGTH_RX = /(\d+(?:\.\d+)?)\s*mg\s*\/\s*(\d+(?:\.\d+)?)?\s*ml\b/i;

function parseStrengthMgPerMl(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(STRENGTH_RX);
  if (!m) return null;
  const mg = Number.parseFloat(m[1]);
  const perMl = m[2] != null && m[2] !== '' ? Number.parseFloat(m[2]) : 1;
  if (!Number.isFinite(mg) || !Number.isFinite(perMl) || perMl <= 0 || mg <= 0) return null;
  return mg / perMl;
}

function parseDoseToMg(doseString, options = {}) {
  if (!doseString || typeof doseString !== 'string') return null;
  const m = doseString.match(DOSE_VALUE_RX);
  if (!m) return null;
  const value = Number.parseFloat(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = m[2].toLowerCase();
  if (unit === 'mg') return value;
  if (unit === 'g') return value * 1000;
  if (unit === 'mcg' || unit === 'µg') return value / 1000;
  // ml is liquid volume — needs a strength (e.g. "125mg/5ml") to
  // convert. When the caller passes a strengthMgPerMl (parsed from the
  // medication name or an explicit field), we do the conversion here;
  // otherwise return null so the dose check skips silently. Finding:
  // 2026-05-10-pediatric-opd-doctor-syrup-volume-dose-bypass.
  if (unit === 'ml' && Number.isFinite(options.strengthMgPerMl) && options.strengthMgPerMl > 0) {
    return value * options.strengthMgPerMl;
  }
  return null;
}

function findMgPerKg(medName) {
  const name = String(medName || '').toLowerCase();
  for (const [drug, mgPerKg] of Object.entries(PAEDIATRIC_MG_PER_KG)) {
    if (name.includes(drug)) return { drug, mgPerKg };
  }
  return null;
}

// Loud-but-honest allergy phrasing seen in clinician free-text notes.
// "Allergy: Penicillin", "Allergies — Sulfa, NSAIDs", "Pt allergic to
// peanuts". The trailing list is captured up to the next sentence
// terminator so multi-allergen lines split cleanly downstream.
const NOTE_ALLERGY_RX = /(?:allergy|allergies|allergic\s+to)\s*[-:–]?\s*([A-Za-z][A-Za-z0-9 ,/-]{1,120})/gi;

const ALLERGY_LIST_SPLIT_RX = /[,;/]| and /i;

// Beta-lactam cross-reactivity — penicillin-class allergy implies
// caution on any beta-lactam. Substring match (no regex anchors) so
// brand names like "amoxiclav" / "augmentin" still hit.
const BETA_LACTAM_DRUGS = [
  'penicillin', 'amoxicillin', 'ampicillin', 'piperacillin',
  'cloxacillin', 'flucloxacillin', 'methicillin', 'augmentin',
  'amoxiclav', 'tazobactam',
];
const BETA_LACTAM_ALLERGENS = ['penicillin', 'amoxicillin', 'beta-lactam', 'beta lactam'];

function extractAllergiesFromNote(text) {
  if (!text || typeof text !== 'string') return [];
  const found = new Set();
  for (const match of text.matchAll(NOTE_ALLERGY_RX)) {
    const raw = (match[1] || '').trim();
    if (!raw) continue;
    for (const piece of raw.split(ALLERGY_LIST_SPLIT_RX)) {
      const cleaned = piece
        .replace(/[.\s]+$/, '')
        .trim()
        .toLowerCase();
      // Drop common false-positive trailing words (one-word stopwords)
      // and require ≥3 chars so "no", "an", "to" never become an allergen.
      if (cleaned.length >= 3 && !/^(none|nil|nka|nkda|known|reported)$/.test(cleaned)) {
        found.add(cleaned);
      }
    }
  }
  return [...found];
}

function medicationConflictsWithAllergen(medName, allergen) {
  const med = String(medName || '').toLowerCase();
  const allergy = String(allergen || '').toLowerCase();
  if (!med || !allergy) return false;
  if (med.includes(allergy) || allergy.includes(med)) return true;
  // Beta-lactam cross-reactivity (penicillin allergy ↔ amoxicillin etc.)
  const allergyIsBetaLactam = BETA_LACTAM_ALLERGENS.some((a) => allergy.includes(a));
  if (allergyIsBetaLactam && BETA_LACTAM_DRUGS.some((d) => med.includes(d))) return true;
  return false;
}

/**
 * Best-effort patient context lookup for paediatric weight-based dosing.
 * Reads age (DOB) + most-recent recorded weight. Returns null if either
 * piece is missing — the dose check then silently skips for this patient
 * rather than 500'ing or false-flagging.
 */
async function loadPaediatricContext(patientId) {
  if (!patientId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT
         CASE WHEN birthday IS NOT NULL THEN
           DATE_PART('year', AGE(NOW()::date, birthday))::int
         ELSE NULL END AS age_years
       FROM users WHERE id = $1 LIMIT 1`,
      patientId,
    );
    const ageYears = rows[0]?.age_years ?? null;
    if (ageYears === null || ageYears >= 12) return null; // Not paediatric
    // Most recent recorded weight from vitals_chart (joined via patient_uid).
    // This won't fire for patients we never recorded vitals on; that's OK,
    // dose check just skips silently in that case.
    const weightRows = await prisma.$queryRawUnsafe(
      `SELECT vc.weight_kg
         FROM vitals_chart vc
         JOIN users u ON u.uid = vc.patient_uid
        WHERE u.id = $1 AND vc.weight_kg IS NOT NULL
        ORDER BY vc.recorded_at DESC NULLS LAST LIMIT 1`,
      patientId,
    );
    const weightKg = weightRows[0]?.weight_kg ? Number(weightRows[0].weight_kg) : null;
    if (!Number.isFinite(weightKg) || weightKg <= 0) return null;
    return { ageYears, weightKg };
  } catch (err) {
    logger.warn(`prescriptionSafetyCheck: paediatric context lookup failed for patient=${patientId}: ${err.message}`);
    return null;
  }
}

/**
 * Validate a prescription against patient allergies and active medications.
 * Call before saving any new prescription.
 * @param {number} patientId
 * @param {Array} medications - [{ medication_id, name, ... }]
 * @returns {{ safe: boolean, warnings: Array, blockers: Array }}
 */
export async function validatePrescriptionSafety(patientId, medications) {
  const warnings = [];
  const blockers = [];

  try {
    // 1. Check patient allergies
    const allergyResult = await prisma.$queryRawUnsafe(
      `SELECT allergy_name, severity FROM patient_allergies WHERE patient_id = $1 AND is_active = true`,
      patientId
    );
    const allergies = allergyResult;

    if (allergies.length > 0) {
      for (const med of medications) {
        const medName = (med.name || med.medication_name || '').toLowerCase();
        for (const allergy of allergies) {
          const allergyName = (allergy.allergy_name || '').toLowerCase();
          // Simple substring match — production should use a proper drug-allergy database
          if (medName.includes(allergyName) || allergyName.includes(medName)) {
            const issue = {
              type: 'ALLERGY_CONFLICT',
              medication: med.name || med.medication_name,
              allergy: allergy.allergy_name,
              severity: allergy.severity || 'UNKNOWN',
              message: `Patient is allergic to "${allergy.allergy_name}" — "${med.name || med.medication_name}" may cause a reaction`,
            };
            if (allergy.severity === 'SEVERE' || allergy.severity === 'LIFE_THREATENING') {
              blockers.push(issue);
            } else {
              warnings.push(issue);
            }
          }
        }
      }
    }

    // 1b. Unstructured allergy scan. Doctors routinely write "Allergy:
    //     Penicillin" in the appointment note instead of (or before)
    //     adding a structured patient_allergies row. The structured-only
    //     check above misses the allergen entirely and reports the
    //     beta-lactam prescription as safe — clinical-safety failure.
    //     Scan recent free-text notes for the patient and treat any
    //     extracted allergen as a blocker (severity UNSTRUCTURED), with
    //     beta-lactam cross-reactivity wired in for the canonical
    //     penicillin→amoxicillin case. The override path remains
    //     available for cases where the note has been reviewed.
    //     Finding:
    //     2026-05-10-dynamic-acute-abdomen-doctor-allergy-safety-misses-penicillin.
    // Postgres requires per-source ORDER BY / LIMIT to live inside a
    // subquery — otherwise the parser treats the ORDER BY as applying to
    // the whole UNION and chokes on the next SELECT (`syntax error at or
    // near "UNION"`). Each side is wrapped in its own scalar subquery so
    // the 50-row cap is per-source.
    const noteRows = await prisma.$queryRawUnsafe(
      `SELECT source, body FROM (
         SELECT 'appointment' AS source,
                COALESCE(notes, '') || ' ' || COALESCE(reason, '') AS body,
                created_at
           FROM appointments
          WHERE patient_id = $1::int
            AND created_at >= NOW() - INTERVAL '365 days'
          ORDER BY created_at DESC
          LIMIT 50
       ) a
       UNION ALL
       SELECT source, body FROM (
         SELECT 'clinical_note' AS source, COALESCE(cn.notes, '') AS body
           FROM clinical_notes cn
           JOIN users u ON u.uid = cn.patient_uid
          WHERE u.id = $1::int
            AND cn.created_at >= NOW() - INTERVAL '365 days'
            AND COALESCE(cn.status, 'current') NOT IN ('superseded', 'deleted')
          ORDER BY cn.created_at DESC
          LIMIT 50
       ) c`,
      patientId,
    );

    const noteAllergens = new Set();
    for (const row of noteRows) {
      for (const allergen of extractAllergiesFromNote(row.body)) {
        noteAllergens.add(allergen);
      }
    }
    if (noteAllergens.size) {
      for (const med of medications) {
        const medName = med.name || med.medication_name || '';
        for (const allergen of noteAllergens) {
          // Skip if the structured check already produced a match for
          // this (medication, allergen) pair — avoid duplicate blockers.
          const alreadyFlagged = blockers.concat(warnings).some(
            (b) =>
              b.type === 'ALLERGY_CONFLICT' &&
              String(b.medication || '').toLowerCase() === medName.toLowerCase() &&
              String(b.allergy || '').toLowerCase() === allergen,
          );
          if (alreadyFlagged) continue;
          if (medicationConflictsWithAllergen(medName, allergen)) {
            blockers.push({
              type: 'ALLERGY_CONFLICT_UNSTRUCTURED',
              medication: medName,
              allergy: allergen,
              severity: 'UNSTRUCTURED',
              message: `Patient note records allergy "${allergen}" — "${medName}" may cause a reaction. Confirm and add a structured patient_allergies entry, or override with reason.`,
            });
          }
        }
      }
    }

    // 2. Check for duplicate active prescriptions (same medication)
    const activeMedsResult = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT
          COALESCE(
            NULLIF(TRIM(ep.medication_name), ''),
            NULLIF(TRIM(med.value->>'name'), ''),
            NULLIF(TRIM(med.value->>'medication_name'), '')
          ) AS medication_name
       FROM e_prescriptions ep
       LEFT JOIN LATERAL jsonb_array_elements(COALESCE(ep.medications, '[]'::jsonb)) AS med(value) ON TRUE
       WHERE ep.patient_id = $1
         AND LOWER(COALESCE(ep.status, 'active')) IN ('active', 'pharmacy_linked')
         AND (ep.follow_up_date IS NULL OR ep.follow_up_date >= CURRENT_DATE)`,
      patientId
    );

    for (const med of medications) {
      const medName = (med.name || med.medication_name || '').toLowerCase();
      for (const active of activeMedsResult) {
        if ((active.medication_name || '').toLowerCase() === medName) {
          warnings.push({
            type: 'DUPLICATE_MEDICATION',
            medication: med.name || med.medication_name,
            message: `"${med.name || med.medication_name}" is already actively prescribed to this patient`,
          });
        }
      }
    }

    // 3. Paediatric weight-based dose sanity check. Only fires for patients
    //    under 12 with a recorded weight; only checks drugs in the seed
    //    PAEDIATRIC_MG_PER_KG table. Anything outside that scope is
    //    silently skipped (no false positives, no false-confidence
    //    "all checked"). See finding
    //    2026-05-08-pediatric-opd-doctor-no-weight-based-dose-check.
    //
    //    A trigger (>1.2x weight-based ceiling) is now a HARD BLOCKER
    //    rather than a warning so the staff-app CDS modal forces the
    //    doctor to acknowledge with an override reason — adult-tablet
    //    doses for toddlers previously slipped through warnings-only.
    //    Override path is the same one the allergy blocker uses
    //    (`override: { reason: '...' }` on createPrescription, audited
    //    to prescription_safety_overrides). Findings:
    //      2026-05-09-pediatric-opd-doctor-paed-dose-warning-not-blocker
    //      2026-05-12-pediatric-opd-doctor-eba299c1
    const paedCtx = await loadPaediatricContext(patientId);
    if (paedCtx) {
      for (const med of medications) {
        const medName = med.name || med.medication_name || '';
        const mapping = findMgPerKg(medName);
        if (!mapping) continue;
        // Resolve syrup/drop strength so an ml-only dose can be converted
        // to mg. Priority: explicit strength_mg_per_ml field, then the
        // medication name (e.g. "Paracetamol syrup 125mg/5ml"), then the
        // strength / concentration free-text field if the doctor entered
        // one. Falls back to null → ml-only dose is skipped.
        const strengthMgPerMl =
          Number(med.strength_mg_per_ml) ||
          parseStrengthMgPerMl(medName) ||
          parseStrengthMgPerMl(med.strength) ||
          parseStrengthMgPerMl(med.concentration) ||
          null;
        const doseMg = parseDoseToMg(med.dose || med.dosage || '', { strengthMgPerMl });
        if (doseMg === null) continue;
        const expectedMaxMg = mapping.mgPerKg * paedCtx.weightKg * 1.2; // 20% headroom
        if (doseMg > expectedMaxMg) {
          const ratio = (doseMg / (mapping.mgPerKg * paedCtx.weightKg)).toFixed(2);
          blockers.push({
            type: 'PAEDIATRIC_DOSE_HIGH',
            medication: medName,
            patient_weight_kg: paedCtx.weightKg,
            patient_age_years: paedCtx.ageYears,
            entered_dose_mg: doseMg,
            expected_max_per_dose_mg: Number(expectedMaxMg.toFixed(2)),
            mg_per_kg_reference: mapping.mgPerKg,
            strength_mg_per_ml: strengthMgPerMl,
            message: `${medName} ${doseMg}mg in a ${paedCtx.weightKg}kg ${paedCtx.ageYears}y patient is ${ratio}x the recommended ${mapping.mgPerKg}mg/kg per-dose ceiling. Confirm with weight-based dose, or override with reason.`,
          });
        }
      }
    }

  } catch (err) {
    // Fail CLOSED on safety-check failure. Returning safe:true silently
    // allowed an allergy/dup-Rx lookup to be bypassed by triggering the
    // bug — a clinical-safety failure (CLAUDE.md: "Never return fake
    // success data in catch blocks"). The override path remains available
    // for cases where manual review has cleared the patient — callers
    // can pass an `override: { reason }` payload to createPrescription.
    // See finding 2026-05-08-pediatric-opd-doctor-cds-swallows-errors.
    logger.error('Prescription safety check failed (blocking prescription pending manual override):', err.message);
    blockers.push({
      type: 'SAFETY_CHECK_ERROR',
      message: 'Automated safety check failed — manual review and override required before prescribing.',
    });
    return { safe: false, warnings, blockers };
  }

  return {
    safe: blockers.length === 0,
    warnings,
    blockers,
  };
}

export default { validatePrescriptionSafety };
