/**
 * Phase F3 — spec-driven role-matrix tests.
 *
 * Walks every role × every gate combination from a single declarative
 * matrix. Catches drift introduced by role-registry changes (a new role
 * silently failing a downstream gate, or an existing role unexpectedly
 * losing/gaining access). Pair with roleHelpers.test.js (which covers
 * the per-helper unit behaviour) — this test is the cross-product
 * assertion that nothing else gets quietly mis-categorised.
 */

import {
  ROLES,
  canAccessBloodBank,
  canAccessCathLab,
  canAccessOT,
  canAccessRadiology,
  canDispatchAmbulance,
  canEditDischargeSummary,
  canManageAiGovernance,
  canManageClaims,
  canManageDataProtection,
  canManageIntegrations,
  canSignDischargeSummary,
  canViewDischargeSummary,
  canViewMedicalData,
  isAdmin,
  isClinical,
  isDoctor,
  isLeadership,
  isMachineRole,
  isPatient,
  isPlatformRole,
  isStaff,
  isSupportStaff
} from '../../utils/roleHelpers.js';

// Every gate the matrix covers. Each entry: { gate, fn, allow: Set<role> }.
// `allow` is the source of truth — the test asserts every role in the
// registry is either in `allow` (returns true) or not (returns false).
//
// Update this matrix when a gate's policy changes; keep it lock-step
// with apps/backend/src/utils/roleHelpers.js.
const GATES = [
  {
    name: 'isAdmin',
    fn: isAdmin,
    allow: new Set(['ADMIN'])
  },
  {
    name: 'isPatient',
    fn: isPatient,
    allow: new Set(['PATIENT'])
  },
  {
    name: 'isDoctor',
    fn: isDoctor,
    allow: new Set(['DOCTOR', 'DUTY_DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT'])
  },
  {
    name: 'isClinical',
    fn: isClinical,
    allow: new Set([
      'DOCTOR',
      'DUTY_DOCTOR',
      'CONSULTANT',
      'JUNIOR_DOCTOR',
      'RESIDENT',
      'NURSING_STAFF',
      'NURSING_INCHARGE',
      'OP_STAFF_NURSE',
      'OP_INCHARGE',
      'IP_STAFF_NURSE',
      'IP_INCHARGE',
      'OT_NURSE',
      'OT_INCHARGE',
      'CATH_LAB_STAFF',
      'CATH_LAB_INCHARGE',
      'RADIOLOGIST',
      'ANESTHETIST',
      // British/Indian spelling — first-class in CLINICAL_ROLES since the
      // 2026-08-22 audit (it was selectable and rbacConfig-listed but the
      // helpers rejected it, locking anaesthetists out of ~25 route files).
      'ANAESTHETIST',
      'PHYSIOTHERAPIST',
      'DIETITIAN',
      'COUNSELLOR'
    ])
  },
  {
    name: 'isLeadership',
    fn: isLeadership,
    allow: new Set(['CMO', 'CNO', 'DEPARTMENT_HEAD', 'MEDICAL_SUPERINTENDENT', 'ADMIN'])
  },
  {
    name: 'isSupportStaff',
    fn: isSupportStaff,
    allow: new Set([
      'SOCIAL_WORKER',
      'SECURITY',
      'CASHIER',
      'BILLING_STAFF',
      'BILLING_INCHARGE',
      'FINANCE_INCHARGE',
      'INSURANCE_COORDINATOR',
      'ADMISSION_OFFICER',
      'IPD_COUNSELLOR',
      'QUALITY_OFFICER',
      'INFECTION_CONTROL_OFFICER',
      'CARE_COORDINATOR',
      'CLAIMS_MANAGER',
      'AMBULANCE_COORDINATOR',
      'STORES_PURCHASE_INCHARGE',
      'RECEPTION_INCHARGE',
      'DRIVER',
      'HOUSEKEEPING_STAFF',
      'HOUSEKEEPING_INCHARGE',
      'MAINTENANCE'
    ])
  },
  {
    name: 'isPlatformRole',
    fn: isPlatformRole,
    allow: new Set(['INTEGRATION_ADMIN', 'AI_GOVERNANCE_ADMIN', 'DATA_PROTECTION_OFFICER'])
  },
  {
    name: 'isMachineRole',
    fn: isMachineRole,
    allow: new Set(['WEBHOOK_CLIENT', 'DEVICE_GATEWAY'])
  },
  {
    name: 'canSignDischargeSummary',
    fn: canSignDischargeSummary,
    allow: new Set(['DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR'])
  },
  {
    name: 'canEditDischargeSummary',
    fn: canEditDischargeSummary,
    allow: new Set(['DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'MEDICAL_RECORDS', 'ADMIN'])
  },
  {
    name: 'canViewDischargeSummary',
    fn: canViewDischargeSummary,
    allow: new Set([
      'DOCTOR',
      'DUTY_DOCTOR',
      'CONSULTANT',
      'JUNIOR_DOCTOR',
      'RESIDENT',
      'NURSING_STAFF',
      'NURSING_INCHARGE',
      'IP_STAFF_NURSE',
      'IP_INCHARGE',
      'MEDICAL_RECORDS',
      'ADMIN'
    ])
  },
  {
    name: 'canViewMedicalData',
    fn: canViewMedicalData,
    allow: new Set([
      'DOCTOR',
      'DUTY_DOCTOR',
      'CONSULTANT',
      'JUNIOR_DOCTOR',
      'RESIDENT',
      'NURSING_STAFF',
      'NURSING_INCHARGE',
      'IP_STAFF_NURSE',
      'IP_INCHARGE',
      'OP_STAFF_NURSE',
      'OP_INCHARGE',
      'OT_NURSE',
      'OT_INCHARGE',
      'CATH_LAB_STAFF',
      'CATH_LAB_INCHARGE',
      'RADIOLOGIST',
      'ANESTHETIST',
      'ANAESTHETIST',
      'PHYSIOTHERAPIST',
      'DIETITIAN',
      'COUNSELLOR',
      'ADMIN',
      'MEDICAL_RECORDS'
    ])
  },
  {
    name: 'canAccessRadiology',
    fn: canAccessRadiology,
    allow: new Set([
      'DOCTOR',
      'DUTY_DOCTOR',
      'CONSULTANT',
      'JUNIOR_DOCTOR',
      'RESIDENT',
      'RADIOLOGIST',
      'ADMIN',
      'CMO'
    ])
  },
  {
    name: 'canAccessOT',
    fn: canAccessOT,
    allow: new Set([
      'DOCTOR',
      'DUTY_DOCTOR',
      'CONSULTANT',
      'JUNIOR_DOCTOR',
      'OT_STAFF',
      'OT_NURSE',
      'OT_INCHARGE',
      'ANESTHETIST',
      'ADMIN',
      'CMO'
    ])
  },
  {
    name: 'canAccessCathLab',
    fn: canAccessCathLab,
    allow: new Set([
      'DOCTOR',
      'DUTY_DOCTOR',
      'CONSULTANT',
      'JUNIOR_DOCTOR',
      'RESIDENT',
      'CATH_LAB_STAFF',
      'CATH_LAB_INCHARGE',
      'ADMIN',
      'SUPER_ADMIN',
      'CMO'
    ])
  },
  {
    name: 'canAccessBloodBank',
    fn: canAccessBloodBank,
    allow: new Set([
      'DOCTOR',
      'DUTY_DOCTOR',
      'CONSULTANT',
      'JUNIOR_DOCTOR',
      'NURSING_STAFF',
      'IP_STAFF_NURSE',
      'OT_NURSE',
      'OT_INCHARGE',
      'CATH_LAB_STAFF',
      'BLOOD_BANK_TECHNICIAN',
      'ADMIN'
    ])
  },
  {
    name: 'canManageIntegrations',
    fn: canManageIntegrations,
    allow: new Set(['INTEGRATION_ADMIN', 'ADMIN'])
  },
  {
    name: 'canManageAiGovernance',
    fn: canManageAiGovernance,
    allow: new Set(['AI_GOVERNANCE_ADMIN', 'ADMIN'])
  },
  {
    name: 'canManageDataProtection',
    fn: canManageDataProtection,
    allow: new Set(['DATA_PROTECTION_OFFICER', 'ADMIN'])
  },
  {
    name: 'canDispatchAmbulance',
    fn: canDispatchAmbulance,
    allow: new Set(['AMBULANCE_COORDINATOR', 'EMERGENCY_RESPONDER', 'ADMIN'])
  },
  {
    name: 'canManageClaims',
    fn: canManageClaims,
    allow: new Set(['CLAIMS_MANAGER', 'INSURANCE_COORDINATOR', 'ADMIN'])
  }
];

const ALL_ROLES = Object.values(ROLES);

describe('Role × gate matrix (Phase F3)', () => {
  for (const { name, fn, allow } of GATES) {
    describe(name, () => {
      for (const role of ALL_ROLES) {
        const expected = allow.has(role);
        it(`role=${role} → ${expected}`, () => {
          expect(fn(role)).toBe(expected);
        });
      }
    });
  }

  it('has at least the 38 roles the registry advertises', () => {
    expect(ALL_ROLES.length).toBeGreaterThanOrEqual(38);
  });

  it('isStaff covers every human role except PATIENT and machine roles', () => {
    for (const role of ALL_ROLES) {
      const expected = role !== 'PATIENT' && !isMachineRole(role);
      expect(isStaff(role)).toBe(expected);
    }
  });
});
