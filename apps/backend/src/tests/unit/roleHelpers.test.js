/**
 * Phase F1 — roleHelpers unit tests for the formal seniority/specialty
 * roles added 2026-04-30. Verifies group membership + new helper
 * predicates + downstream gate effects (discharge summary signing,
 * radiology / OT / blood-bank access).
 */

import {
  ROLES,
  CLINICAL_ROLES,
  DISCHARGE_SUMMARY_SIGN_ROLES,
  DOCTOR_TIERS,
  MACHINE_ROLES,
  PLATFORM_ROLES,
  SUPPORT_ROLES,
  canAccessBloodBank,
  canAccessOT,
  canAccessRadiology,
  canDispatchAmbulance,
  canManageAiGovernance,
  canManageClaims,
  canManageDataProtection,
  canManageIntegrations,
  canSignDischargeSummary,
  isAiGovernanceAdmin,
  isAmbulanceCoordinator,
  isCareCoordinator,
  isClaimsManager,
  isClinical,
  isConsultant,
  isCounsellor,
  isDataProtectionOfficer,
  isDoctor,
  isIntegrationAdmin,
  isMachineRole,
  isPlatformRole,
  isResident,
  isStaff,
  isWebhookClient,
} from '../../utils/roleHelpers.js';

describe('Phase F1 role registry', () => {
  it('exposes the 10 new roles', () => {
    expect(ROLES.CONSULTANT).toBe('CONSULTANT');
    expect(ROLES.JUNIOR_DOCTOR).toBe('JUNIOR_DOCTOR');
    expect(ROLES.RESIDENT).toBe('RESIDENT');
    expect(ROLES.COUNSELLOR).toBe('COUNSELLOR');
    expect(ROLES.CARE_COORDINATOR).toBe('CARE_COORDINATOR');
    expect(ROLES.CLAIMS_MANAGER).toBe('CLAIMS_MANAGER');
    expect(ROLES.AMBULANCE_COORDINATOR).toBe('AMBULANCE_COORDINATOR');
    expect(ROLES.INTEGRATION_ADMIN).toBe('INTEGRATION_ADMIN');
    expect(ROLES.WEBHOOK_CLIENT).toBe('WEBHOOK_CLIENT');
    expect(ROLES.AI_GOVERNANCE_ADMIN).toBe('AI_GOVERNANCE_ADMIN');
    expect(ROLES.DATA_PROTECTION_OFFICER).toBe('DATA_PROTECTION_OFFICER');
  });

  it('puts doctor seniority tiers in CLINICAL_ROLES + DOCTOR_TIERS', () => {
    expect(CLINICAL_ROLES).toContain('CONSULTANT');
    expect(CLINICAL_ROLES).toContain('JUNIOR_DOCTOR');
    expect(CLINICAL_ROLES).toContain('RESIDENT');
    expect(DOCTOR_TIERS).toEqual(['DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT']);
  });

  it('routes specialty support roles into SUPPORT_ROLES', () => {
    expect(SUPPORT_ROLES).toContain('CARE_COORDINATOR');
    expect(SUPPORT_ROLES).toContain('CLAIMS_MANAGER');
    expect(SUPPORT_ROLES).toContain('AMBULANCE_COORDINATOR');
  });

  it('routes platform-governance roles into PLATFORM_ROLES', () => {
    expect(PLATFORM_ROLES).toContain('INTEGRATION_ADMIN');
    expect(PLATFORM_ROLES).toContain('AI_GOVERNANCE_ADMIN');
    expect(PLATFORM_ROLES).toContain('DATA_PROTECTION_OFFICER');
  });

  it('routes WEBHOOK_CLIENT into MACHINE_ROLES (never a human)', () => {
    expect(MACHINE_ROLES).toEqual(['WEBHOOK_CLIENT']);
  });
});

describe('isDoctor across seniority tiers', () => {
  it('treats every doctor tier as a doctor', () => {
    for (const tier of ['DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT']) {
      expect(isDoctor(tier)).toBe(true);
    }
  });
  it('does NOT treat NURSING_STAFF, COUNSELLOR or specialty roles as doctors', () => {
    expect(isDoctor('NURSING_STAFF')).toBe(false);
    expect(isDoctor('COUNSELLOR')).toBe(false);
    expect(isDoctor('CARE_COORDINATOR')).toBe(false);
  });
});

describe('Discharge summary signing', () => {
  it('lets DOCTOR / CONSULTANT / JUNIOR_DOCTOR sign', () => {
    expect(canSignDischargeSummary('DOCTOR')).toBe(true);
    expect(canSignDischargeSummary('CONSULTANT')).toBe(true);
    expect(canSignDischargeSummary('JUNIOR_DOCTOR')).toBe(true);
  });
  it('blocks RESIDENT from signing', () => {
    expect(canSignDischargeSummary('RESIDENT')).toBe(false);
  });
  it('blocks NURSING_STAFF, COUNSELLOR, CARE_COORDINATOR', () => {
    expect(canSignDischargeSummary('NURSING_STAFF')).toBe(false);
    expect(canSignDischargeSummary('COUNSELLOR')).toBe(false);
    expect(canSignDischargeSummary('CARE_COORDINATOR')).toBe(false);
  });
});

describe('Specialty role predicates', () => {
  it('isConsultant / isResident / isCounsellor / isCareCoordinator', () => {
    expect(isConsultant('CONSULTANT')).toBe(true);
    expect(isResident('RESIDENT')).toBe(true);
    expect(isCounsellor('COUNSELLOR')).toBe(true);
    expect(isCareCoordinator('CARE_COORDINATOR')).toBe(true);
  });
  it('platform-role predicates', () => {
    expect(isIntegrationAdmin('INTEGRATION_ADMIN')).toBe(true);
    expect(isAiGovernanceAdmin('AI_GOVERNANCE_ADMIN')).toBe(true);
    expect(isDataProtectionOfficer('DATA_PROTECTION_OFFICER')).toBe(true);
    expect(isPlatformRole('INTEGRATION_ADMIN')).toBe(true);
    expect(isWebhookClient('WEBHOOK_CLIENT')).toBe(true);
    expect(isMachineRole('WEBHOOK_CLIENT')).toBe(true);
    expect(isMachineRole('DOCTOR')).toBe(false);
  });
  it('operations-role predicates', () => {
    expect(isClaimsManager('CLAIMS_MANAGER')).toBe(true);
    expect(isAmbulanceCoordinator('AMBULANCE_COORDINATOR')).toBe(true);
  });
});

describe('Specialty role gates', () => {
  it('canManageIntegrations: INTEGRATION_ADMIN and ADMIN only', () => {
    expect(canManageIntegrations('INTEGRATION_ADMIN')).toBe(true);
    expect(canManageIntegrations('ADMIN')).toBe(true);
    expect(canManageIntegrations('DOCTOR')).toBe(false);
  });
  it('canManageAiGovernance: AI_GOVERNANCE_ADMIN and ADMIN only', () => {
    expect(canManageAiGovernance('AI_GOVERNANCE_ADMIN')).toBe(true);
    expect(canManageAiGovernance('ADMIN')).toBe(true);
    expect(canManageAiGovernance('CONSULTANT')).toBe(false);
  });
  it('canManageDataProtection: DPO and ADMIN only', () => {
    expect(canManageDataProtection('DATA_PROTECTION_OFFICER')).toBe(true);
    expect(canManageDataProtection('ADMIN')).toBe(true);
    expect(canManageDataProtection('CARE_COORDINATOR')).toBe(false);
  });
  it('canDispatchAmbulance: AMBULANCE_COORDINATOR / EMERGENCY_RESPONDER / ADMIN', () => {
    expect(canDispatchAmbulance('AMBULANCE_COORDINATOR')).toBe(true);
    expect(canDispatchAmbulance('EMERGENCY_RESPONDER')).toBe(true);
    expect(canDispatchAmbulance('ADMIN')).toBe(true);
    expect(canDispatchAmbulance('DOCTOR')).toBe(false);
  });
  it('canManageClaims: CLAIMS_MANAGER / INSURANCE_COORDINATOR / ADMIN', () => {
    expect(canManageClaims('CLAIMS_MANAGER')).toBe(true);
    expect(canManageClaims('INSURANCE_COORDINATOR')).toBe(true);
    expect(canManageClaims('ADMIN')).toBe(true);
    expect(canManageClaims('NURSING_STAFF')).toBe(false);
  });
});

describe('Existing access gates respect new doctor tiers', () => {
  it('canAccessRadiology accepts CONSULTANT / JUNIOR_DOCTOR / RESIDENT', () => {
    expect(canAccessRadiology('CONSULTANT')).toBe(true);
    expect(canAccessRadiology('JUNIOR_DOCTOR')).toBe(true);
    expect(canAccessRadiology('RESIDENT')).toBe(true);
  });
  it('canAccessOT accepts CONSULTANT / JUNIOR_DOCTOR but not RESIDENT', () => {
    expect(canAccessOT('CONSULTANT')).toBe(true);
    expect(canAccessOT('JUNIOR_DOCTOR')).toBe(true);
    expect(canAccessOT('RESIDENT')).toBe(false);
  });
  it('canAccessBloodBank accepts senior tiers + nursing + technician', () => {
    expect(canAccessBloodBank('CONSULTANT')).toBe(true);
    expect(canAccessBloodBank('JUNIOR_DOCTOR')).toBe(true);
    expect(canAccessBloodBank('NURSING_STAFF')).toBe(true);
    expect(canAccessBloodBank('BLOOD_BANK_TECHNICIAN')).toBe(true);
    expect(canAccessBloodBank('RESIDENT')).toBe(false);
  });
});

describe('isStaff / isClinical respect new specialty roles', () => {
  it('isStaff is true for the new roles', () => {
    for (const r of ['CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT', 'COUNSELLOR',
      'CARE_COORDINATOR', 'CLAIMS_MANAGER', 'AMBULANCE_COORDINATOR',
      'INTEGRATION_ADMIN', 'AI_GOVERNANCE_ADMIN', 'DATA_PROTECTION_OFFICER']) {
      expect(isStaff(r)).toBe(true);
    }
  });
  it('isStaff is false for WEBHOOK_CLIENT (machine role)', () => {
    expect(isStaff('WEBHOOK_CLIENT')).toBe(false);
  });
  it('isClinical is true for clinical-grouped new roles', () => {
    expect(isClinical('CONSULTANT')).toBe(true);
    expect(isClinical('COUNSELLOR')).toBe(true);
    expect(isClinical('CARE_COORDINATOR')).toBe(false);
  });
});

describe('DISCHARGE_SUMMARY_SIGN_ROLES is the canonical signer list', () => {
  it('has exactly the senior doctor tiers', () => {
    expect(DISCHARGE_SUMMARY_SIGN_ROLES.sort()).toEqual(['CONSULTANT', 'DOCTOR', 'JUNIOR_DOCTOR']);
  });
});
