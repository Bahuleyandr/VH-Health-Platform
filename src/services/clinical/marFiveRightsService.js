// src/services/clinical/marFiveRightsService.js
//
// Layer on top of the existing marService that adds 5-rights barcode
// verification for bedside medication administration. Flow:
//
//   1. Nurse scans patient wristband (encodes users.uid — UUID).
//   2. Nurse scans drug barcode / NDC.
//   3. Client POSTs /clinical/mar/verify { ma_id, scanned_patient_uid, scanned_barcode }
//      → this module runs the five rights check and returns the structured
//        result. Nothing is written.
//   4. If all five pass (or nurse supplies override_reason), client POSTs
//      /clinical/mar/:id/administer-with-scan to commit the MAR row AND the
//      5-rights audit trail.
//
// The five rights:
//   - patient: scanned wristband maps to the MA's patient_uid.
//   - drug:    scanned barcode matches the MA's medication_name (substring,
//              case-insensitive — a proper drug DB with NDC lookup is a
//              known future upgrade, noted in marFiveRightsService.js).
//   - dose:    MA row has a non-empty dose/dosage.
//   - route:   MA row has a non-empty route.
//   - time:    MA has a scheduled_time within the acceptable window
//              (±60 minutes by default). If scheduled_time is null we treat
//              `time` as a pass (SOS/STAT/unscheduled admins).

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

const DEFAULT_WINDOW_MINUTES = 60;

function _norm(s) {
  return (s ?? '').toString().toLowerCase().trim();
}

/**
 * Compute the 5-rights result for a medication_administrations row.
 * Does not write anything.
 */
export async function evaluate5Rights({ ma_id, scanned_patient_uid, scanned_barcode, windowMinutes = DEFAULT_WINDOW_MINUTES }) {
  if (!ma_id) throw AppError.badRequest('ma_id is required');
  if (!scanned_patient_uid) throw AppError.badRequest('scanned_patient_uid is required');
  if (!scanned_barcode) throw AppError.badRequest('scanned_barcode is required');

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, medication_name, dose, dosage, route,
            scheduled_time, status
       FROM medication_administrations
      WHERE id = $1`,
    ma_id,
  );
  if (rows.length === 0) throw AppError.notFound('Medication administration record not found');
  const ma = rows[0];

  if (ma.status !== 'scheduled' && ma.status !== 'held') {
    throw AppError.conflict(`Cannot verify — status is ${ma.status}`);
  }

  const rightPatient = _norm(ma.patient_uid) === _norm(scanned_patient_uid);

  const medName = ma.medication_name || '';
  const rightDrug =
    _norm(medName).length > 0 &&
    (_norm(medName).includes(_norm(scanned_barcode))
      || _norm(scanned_barcode).includes(_norm(medName)));

  const rightDose = Boolean(ma.dose || ma.dosage);
  const rightRoute = Boolean(ma.route);

  let rightTime = true;
  let minutesFromScheduled = null;
  if (ma.scheduled_time) {
    const deltaMs = Date.now() - new Date(ma.scheduled_time).getTime();
    minutesFromScheduled = Math.round(deltaMs / 60_000);
    rightTime = Math.abs(minutesFromScheduled) <= windowMinutes;
  }

  const rights = {
    patient: rightPatient,
    drug:    rightDrug,
    dose:    rightDose,
    route:   rightRoute,
    time:    rightTime,
  };
  const allPassed = Object.values(rights).every(Boolean);

  return {
    ma: {
      id: ma.id,
      patient_uid: ma.patient_uid,
      medication_name: ma.medication_name,
      dose: ma.dose || ma.dosage || null,
      route: ma.route,
      scheduled_time: ma.scheduled_time,
    },
    rights,
    allPassed,
    context: {
      minutesFromScheduled,
      windowMinutes,
    },
  };
}

/**
 * Commit the MAR row with rights audit. Transitions status to 'administered'
 * the same way the plain marService.recordAdministration does, but additionally
 * writes the scanned identifiers, rights_passed jsonb, and override_reason.
 */
export async function administerWithScan({ ma_id, scanned_patient_uid, scanned_barcode, administeredBy, overrideReason = null, windowMinutes = DEFAULT_WINDOW_MINUTES }) {
  const evaluation = await evaluate5Rights({ ma_id, scanned_patient_uid, scanned_barcode, windowMinutes });
  if (!evaluation.allPassed && !overrideReason) {
    // Surface the failing rights so the client can drive the override modal.
    const err = AppError.conflict('5-rights check failed');
    err.details = { rights: evaluation.rights, context: evaluation.context };
    throw err;
  }

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE medication_administrations
       SET status              = 'administered',
           administered_at     = NOW(),
           administered_by     = $2,
           scanned_patient_uid = $3::uuid,
           scanned_barcode     = $4,
           rights_passed       = $5::jsonb,
           all_rights_passed   = $6,
           override_reason     = $7
     WHERE id = $1
     RETURNING id, patient_uid, medication_name, dosage, route, status,
               administered_at, administered_by, rights_passed,
               all_rights_passed, override_reason`,
    ma_id,
    administeredBy,
    scanned_patient_uid,
    scanned_barcode,
    JSON.stringify(evaluation.rights),
    evaluation.allPassed,
    overrideReason,
  );
  return rows[0];
}

export default { evaluate5Rights, administerWithScan };
