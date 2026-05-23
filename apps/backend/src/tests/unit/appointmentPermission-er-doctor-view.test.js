// Regression test for finding 2026-05-23-emergency-walk-in-doctor-70bf7587.
//
// ER walk-ins arrive with `appointments.doctor_id = null` (the consultant
// only claims/assigns at triage). The ER write surfaces (notes, orders)
// already let the treating doctor act on the encounter via separate
// RBAC, but `checkAppointmentPermission` returned `false` on
// `action='view'` because the doctor's id didn't match the (null)
// `doctor_id` — the treating doctor could write but couldn't READ the
// appointment shell to verify their own advised_for_admission queue
// state. The doctor had to fall back to admin creds.
//
// Fix: `checkAppointmentPermission` now allows `view` for DOCTOR when
// the appointment is unclaimed AND the visit_type/department says
// emergency. Strictly view-only — update/cancel still require ownership
// (the doctor must claim first).

import { checkAppointmentPermission } from '../../utils/appointment/appointmentHelpers.js';

const doctor = { role: 'DOCTOR', id: 42 };
const otherDoctor = { role: 'DOCTOR', id: 99 };
const patient = { role: 'PATIENT', id: 7 };
const admin = { role: 'ADMIN', id: 1 };

describe('checkAppointmentPermission — ER unassigned read-access (70bf7587)', () => {
  it('allows DOCTOR.view on an EMERGENCY appointment with doctor_id=null (the repro)', () => {
    expect(checkAppointmentPermission(
      doctor,
      { id: 349, doctor_id: null, visit_type: 'EMERGENCY', department: 'Emergency' },
      'view',
    )).toBe(true);
  });

  it('allows DOCTOR.view when doctor_id is empty-string + department contains "emergency"', () => {
    expect(checkAppointmentPermission(
      doctor,
      { id: 350, doctor_id: '', visit_type: null, department: 'Emergency Medicine' },
      'view',
    )).toBe(true);
  });

  it('does NOT widen update/cancel — those still require ownership (claim-first)', () => {
    expect(checkAppointmentPermission(
      doctor,
      { id: 349, doctor_id: null, visit_type: 'EMERGENCY', department: 'Emergency' },
      'update',
    )).toBe(false);
    expect(checkAppointmentPermission(
      doctor,
      { id: 349, doctor_id: null, visit_type: 'EMERGENCY', department: 'Emergency' },
      'cancel',
    )).toBe(false);
  });

  it('does NOT widen access on an unclaimed NON-emergency appointment (e.g. transient pre-confirmation OPD)', () => {
    expect(checkAppointmentPermission(
      doctor,
      { id: 200, doctor_id: null, visit_type: 'OPD', department: 'General Medicine' },
      'view',
    )).toBe(false);
  });

  it('does NOT widen access on an EMERGENCY appointment that ALREADY has a different claimed doctor', () => {
    expect(checkAppointmentPermission(
      doctor,
      { id: 351, doctor_id: 99, visit_type: 'EMERGENCY', department: 'Emergency' },
      'view',
    )).toBe(false);
    // Sanity: the assigned doctor still gets through the original branch.
    expect(checkAppointmentPermission(
      otherDoctor,
      { id: 351, doctor_id: 99, visit_type: 'EMERGENCY', department: 'Emergency' },
      'view',
    )).toBe(true);
  });

  it('still gates PATIENT/NON-doctor roles correctly (no spill-over from the ER shim)', () => {
    // Random patient should not see another patient's ER appointment.
    expect(checkAppointmentPermission(
      patient,
      { id: 349, doctor_id: null, patient_id: 999, visit_type: 'EMERGENCY', department: 'Emergency' },
      'view',
    )).toBe(false);
  });

  it('ADMIN access is unchanged (full access regardless of doctor_id / department)', () => {
    expect(checkAppointmentPermission(
      admin,
      { id: 349, doctor_id: null, visit_type: 'EMERGENCY', department: 'Emergency' },
      'view',
    )).toBe(true);
    expect(checkAppointmentPermission(
      admin,
      { id: 349, doctor_id: null, visit_type: 'EMERGENCY', department: 'Emergency' },
      'update',
    )).toBe(true);
  });

  it('still allows the assigned ER doctor (original branch) to update/cancel — unchanged', () => {
    expect(checkAppointmentPermission(
      doctor,
      { id: 349, doctor_id: 42, visit_type: 'EMERGENCY', department: 'Emergency' },
      'update',
    )).toBe(true);
    expect(checkAppointmentPermission(
      doctor,
      { id: 349, doctor_id: 42, visit_type: 'EMERGENCY', department: 'Emergency' },
      'cancel',
    )).toBe(true);
  });
});
