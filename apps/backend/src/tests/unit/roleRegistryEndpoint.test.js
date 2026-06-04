/**
 * Phase F1 follow-up — buildRoleRegistry unit tests.
 * The route is mounted under /api/v1/admin/users/role-registry; this
 * test exercises the payload builder directly.
 */

import { buildRoleRegistry } from '../../routes/user/adminUserRoutes.js';

describe('buildRoleRegistry', () => {
  let payload;
  beforeAll(() => {
    payload = buildRoleRegistry();
  });

  it('lists every role in ROLES with grouping flags', () => {
    expect(payload.policy_version).toBe('vh-role-policy-2026-06-v1');
    expect(payload.policy_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.count).toBeGreaterThanOrEqual(60);
    expect(payload.roles.length).toBe(payload.count);
    for (const entry of payload.roles) {
      expect(entry).toHaveProperty('role');
      expect(entry).toHaveProperty('label');
      expect(entry).toHaveProperty('assignable_staff');
      expect(entry).toHaveProperty('phi_access_level');
      expect(entry).toHaveProperty('is_clinical');
      expect(entry).toHaveProperty('is_leadership');
      expect(entry).toHaveProperty('is_support');
      expect(entry).toHaveProperty('is_platform');
      expect(entry).toHaveProperty('is_machine');
      expect(entry).toHaveProperty('is_doctor_tier');
      expect(entry).toHaveProperty('is_admin');
      expect(entry).toHaveProperty('is_patient');
    }
  });

  it('exposes the canonical group lists', () => {
    expect(payload.doctor_tiers).toEqual(['DOCTOR', 'DUTY_DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT']);
    expect(payload.clinical_roles).toContain('COUNSELLOR');
    expect(payload.platform_roles).toContain('DATA_PROTECTION_OFFICER');
    expect(payload.machine_roles).toEqual(['WEBHOOK_CLIENT']);
  });

  it('flags CONSULTANT as clinical + doctor_tier', () => {
    const entry = payload.roles.find((r) => r.role === 'CONSULTANT');
    expect(entry.is_clinical).toBe(true);
    expect(entry.is_doctor_tier).toBe(true);
    expect(entry.is_admin).toBe(false);
    expect(entry.is_machine).toBe(false);
  });

  it('flags WEBHOOK_CLIENT as machine only (not clinical / not staff)', () => {
    const entry = payload.roles.find((r) => r.role === 'WEBHOOK_CLIENT');
    expect(entry.is_machine).toBe(true);
    expect(entry.is_clinical).toBe(false);
    expect(entry.is_doctor_tier).toBe(false);
    expect(entry.is_support).toBe(false);
  });

  it('flags DATA_PROTECTION_OFFICER as platform', () => {
    const entry = payload.roles.find((r) => r.role === 'DATA_PROTECTION_OFFICER');
    expect(entry.is_platform).toBe(true);
    expect(entry.is_clinical).toBe(false);
  });

  it('flags ADMIN with is_admin=true', () => {
    const entry = payload.roles.find((r) => r.role === 'ADMIN');
    expect(entry.is_admin).toBe(true);
    expect(entry.is_patient).toBe(false);
  });

  it('flags PATIENT with is_patient=true', () => {
    const entry = payload.roles.find((r) => r.role === 'PATIENT');
    expect(entry.is_patient).toBe(true);
    expect(entry.is_clinical).toBe(false);
  });

  it('builds role picker options from assignable human policy roles', () => {
    const pickerRoles = payload.role_picker_options.map((entry) => entry.role);

    expect(pickerRoles).toEqual(expect.arrayContaining([
      'IP_STAFF_NURSE',
      'IP_INCHARGE',
      'OT_NURSE',
      'OT_INCHARGE',
      'CATH_LAB_STAFF',
      'CATH_LAB_INCHARGE',
    ]));
    expect(pickerRoles).not.toContain('WEBHOOK_CLIENT');
    expect(pickerRoles).not.toContain('PATIENT');
  });
});
