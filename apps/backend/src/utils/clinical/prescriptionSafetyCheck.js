import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

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
