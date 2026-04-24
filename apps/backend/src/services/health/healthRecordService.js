// src/services/health/healthRecordService.js
//
// This module used to expose getHealthRecords / getHealthRecordById /
// createHealthRecord / updateHealthRecord that claimed to read/write
// vitals on the `health_records` table. Those functions were
// fundamentally broken — the live `health_records` schema is a file-
// upload store (id / uid / phone / file_key / file_name / file_type /
// file_size / privacy_level / created_by / created_at / updated_at),
// not a vitals table. The service was writing `patient_id`,
// `recorded_by`, `recorded_date`, `vital_signs`, `measurements`,
// `symptoms`, `notes` — none of which exist. Any real call to those
// routes would 500 with "column does not exist".
//
// The healthRecordController even carried a try/catch fallback that
// returned an empty list "Could not retrieve health records —
// health_records table may not exist". Nobody noticed because the
// endpoints aren't exercised by any client:
//   - Patient app + staff app go through patient-side file-upload
//     routes (`/api/v1/records/health-records/*`) backed by
//     `recordService.createHealthRecord` which uses the right schema.
//   - Vitals recording is handled by `patientHealthController` →
//     `patient_vitals` table (blood_pressure / heart_rate / temp /
//     spo2 / weight / mood / recorded_at), which has its own complete
//     CRUD surface at `/api/v1/health/patient/vitals`.
//
// Resolution (batch 45): delete the broken functions + their routes,
// keep `checkDoctorPatientAccess` (used by `patientHealthController`
// for IDOR checks on the four patient-summary endpoints).

import prisma from '../../lib/prisma.js';

/**
 * Returns true when `doctorId` (users.id int) has at least one
 * appointment with `patientId` (users.id int). Used by the four
 * `/patient/:patient_id/*` endpoints in `protectedRoutes.js` to gate
 * cross-patient access by DOCTOR-role users.
 *
 * Migrated from raw `$queryRawUnsafe` to typed findFirst so a future
 * rename of `appointments.doctor_id` or `appointments.patient_id`
 * fails at query-construction.
 */
export async function checkDoctorPatientAccess(doctorId, patientId) {
  const match = await prisma.appointments.findFirst({
    where: {
      doctor_id: parseInt(doctorId),
      patient_id: parseInt(patientId),
    },
    select: { id: true },
  });
  return match !== null;
}
