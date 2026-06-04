/**
 * Phase F1 follow-up — verify USER_CONFIG.ROLES + HOSPITAL_ROLES are
 * now sourced from the canonical roleHelpers registry, so the
 * F1 additions (CONSULTANT / RESIDENT / DPO / etc.) are accepted by
 * the user-CRUD validator that allowlist-checks against
 * Object.values(USER_CONFIG.ROLES).
 */

import { ACCESS_MATRIX, USER_CONFIG, HOSPITAL_ROLES, ROLE_HIERARCHY } from '../../config/userConfig.js';
import { ROLES } from '../../utils/roleHelpers.js';

describe('USER_CONFIG.ROLES is the canonical registry', () => {
  it('exposes all canonical roles, not a stale subset', () => {
    expect(Object.keys(USER_CONFIG.ROLES)).toEqual(Object.keys(ROLES));
    expect(USER_CONFIG.ROLES).toBe(ROLES);
  });

  it('includes the F1 seniority tiers', () => {
    expect(USER_CONFIG.ROLES.CONSULTANT).toBe('CONSULTANT');
    expect(USER_CONFIG.ROLES.JUNIOR_DOCTOR).toBe('JUNIOR_DOCTOR');
    expect(USER_CONFIG.ROLES.RESIDENT).toBe('RESIDENT');
  });

  it('includes the F1 specialty + platform roles', () => {
    expect(USER_CONFIG.ROLES.COUNSELLOR).toBe('COUNSELLOR');
    expect(USER_CONFIG.ROLES.CARE_COORDINATOR).toBe('CARE_COORDINATOR');
    expect(USER_CONFIG.ROLES.CLAIMS_MANAGER).toBe('CLAIMS_MANAGER');
    expect(USER_CONFIG.ROLES.AMBULANCE_COORDINATOR).toBe('AMBULANCE_COORDINATOR');
    expect(USER_CONFIG.ROLES.INTEGRATION_ADMIN).toBe('INTEGRATION_ADMIN');
    expect(USER_CONFIG.ROLES.AI_GOVERNANCE_ADMIN).toBe('AI_GOVERNANCE_ADMIN');
    expect(USER_CONFIG.ROLES.DATA_PROTECTION_OFFICER).toBe('DATA_PROTECTION_OFFICER');
    expect(USER_CONFIG.ROLES.WEBHOOK_CLIENT).toBe('WEBHOOK_CLIENT');
  });

  it('preserves the original 11 roles for back-compat', () => {
    for (const r of [
      'ADMIN', 'PATIENT', 'DOCTOR', 'NURSING_STAFF', 'PHARMACY_STAFF',
      'LAB_STAFF', 'HR_STAFF', 'GENERAL_STAFF', 'RECEPTIONIST',
      'SECURITY', 'EMERGENCY_RESPONDER',
    ]) {
      expect(USER_CONFIG.ROLES[r]).toBe(r);
    }
  });

  it('Object.values produces the full allowlist for express-validator isIn', () => {
    const allow = Object.values(USER_CONFIG.ROLES);
    expect(allow).toContain('CONSULTANT');
    expect(allow).toContain('DATA_PROTECTION_OFFICER');
    expect(allow).toContain('WEBHOOK_CLIENT');
    expect(allow.length).toBeGreaterThanOrEqual(38);
  });
});

describe('HOSPITAL_ROLES is also the canonical registry', () => {
  it('matches USER_CONFIG.ROLES exactly', () => {
    expect(HOSPITAL_ROLES).toBe(USER_CONFIG.ROLES);
  });
});

describe('USER_CONFIG role inheritance mirrors nursing reporting lines', () => {
  it('puts CNO over every nursing incharge and staff branch', () => {
    expect(ROLE_HIERARCHY.CNO).toEqual(expect.arrayContaining([
      'NURSING_INCHARGE',
      'IP_INCHARGE',
      'NURSING_STAFF',
      'IP_STAFF_NURSE',
      'OP_INCHARGE',
      'OP_STAFF_NURSE',
      'OT_INCHARGE',
      'OT_NURSE',
      'OT_STAFF',
      'CATH_LAB_INCHARGE',
      'CATH_LAB_STAFF',
    ]));
  });

  it('keeps generic Nursing Incharge scoped to IP / ward nursing', () => {
    expect(ROLE_HIERARCHY.NURSING_INCHARGE).toEqual(['IP_INCHARGE', 'NURSING_STAFF', 'IP_STAFF_NURSE']);
    expect(ROLE_HIERARCHY.NURSING_INCHARGE).not.toEqual(expect.arrayContaining([
      'OP_STAFF_NURSE',
      'OT_NURSE',
      'CATH_LAB_STAFF',
    ]));
  });
});

describe('ACCESS_MATRIX includes nursing leadership roles', () => {
  it('grants CNO and IP / ward Nursing Incharge their nursing resource permissions', () => {
    expect(ACCESS_MATRIX.CNO).toEqual(expect.objectContaining({
      users: ['read', 'update'],
      appointments: ['read'],
      records: ['read', 'update'],
      pharmacy: ['read'],
      investigations: ['read', 'update'],
    }));
    expect(ACCESS_MATRIX.NURSING_INCHARGE).toEqual(ACCESS_MATRIX.IP_INCHARGE);
  });
});
