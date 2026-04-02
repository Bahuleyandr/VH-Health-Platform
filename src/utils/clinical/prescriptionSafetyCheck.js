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
      [patientId]
    );
    const allergies = allergyResult.rows;

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
      `SELECT medication_name FROM e_prescriptions
       WHERE patient_id = $1 AND status = 'ACTIVE' AND end_date >= CURRENT_DATE`,
      [patientId]
    );

    for (const med of medications) {
      const medName = (med.name || med.medication_name || '').toLowerCase();
      for (const active of activeMedsResult.rows) {
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
    // Safety check failure should NOT block prescription — log and return safe
    logger.error('Prescription safety check failed (allowing prescription):', err.message);
    warnings.push({
      type: 'SAFETY_CHECK_ERROR',
      message: 'Automated safety check failed — manual review recommended',
    });
    return { safe: true, warnings, blockers };
  }

  return {
    safe: blockers.length === 0,
    warnings,
    blockers,
  };
}

export default { validatePrescriptionSafety };
