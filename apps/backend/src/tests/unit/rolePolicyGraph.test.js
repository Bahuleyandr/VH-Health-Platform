import {
  getClinicalAccountabilityRoleCodes,
  getManageableRolesFromPolicy,
  getOrgHierarchyFromPolicy,
  getRolePickerOptions,
  getRolePolicy,
  getRolePolicyHash,
  getStaffVisibilityRoles,
  PHI_ACCESS_LEVELS,
} from '../../config/rolePolicyGraph.js';

describe('rolePolicyGraph', () => {
  it('serves a stable version/hash envelope', () => {
    const policy = getRolePolicy();

    expect(policy.policy_version).toBe('vh-role-policy-2026-06-v1');
    expect(policy.policy_hash).toBe(getRolePolicyHash());
    expect(policy.policy_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(policy.roles.length).toBeGreaterThanOrEqual(60);
  });

  it('derives clinical accountability roles only from canonical clinical-group entries', () => {
    const policy = getRolePolicy();
    const expected = policy.roles
      .filter((role) => role.group === 'clinical')
      .map((role) => role.role_code);
    const nonClinicalRoles = policy.roles
      .filter((role) => role.group !== 'clinical')
      .map((role) => role.role_code);
    const roles = getClinicalAccountabilityRoleCodes();

    expect(roles).toEqual(expected);
    expect(roles).toHaveLength(32);
    expect(roles).toEqual(expect.arrayContaining([
      'DOCTOR',
      'DUTY_DOCTOR',
      'NURSING_STAFF',
      'RADIOLOGIST',
      'PATHOLOGIST',
      'PHYSIOTHERAPIST',
      'COUNSELLOR',
    ]));
    for (const role of nonClinicalRoles) expect(roles).not.toContain(role);
  });

  it('keeps CNO present in policy, chart, RBAC management, and staff visibility', () => {
    const policy = getRolePolicy();
    const cno = policy.roles.find((role) => role.role_code === 'CNO');
    const chart = getOrgHierarchyFromPolicy();
    const nursingSuperintendent = chart.nodes.find((node) => node.id === 'nursing_superintendent');

    expect(cno).toEqual(expect.objectContaining({
      display_title: 'Nursing Superintendent',
      group: 'leadership',
    }));
    expect(cno?.phi).toEqual(expect.objectContaining({
      access_level: PHI_ACCESS_LEVELS.CLINICAL_LEADERSHIP,
      requires_patient_relationship: true,
      can_break_glass: false,
    }));
    expect(nursingSuperintendent?.role_codes).toContain('CNO');
    expect(getManageableRolesFromPolicy('CNO')).toEqual(expect.arrayContaining([
      'NURSING_INCHARGE',
      'IP_INCHARGE',
      'OP_INCHARGE',
      'OT_INCHARGE',
      'CATH_LAB_INCHARGE',
    ]));
    expect(getStaffVisibilityRoles('CNO')).toEqual(expect.arrayContaining([
      'IP_STAFF_NURSE',
      'OP_STAFF_NURSE',
      'OT_NURSE',
      'CATH_LAB_STAFF',
    ]));
  });

  it('defines OP/IP/OT/Cath incharges in the policy picker and org hierarchy', () => {
    const pickerRoles = getRolePickerOptions().map((role) => role.role);
    const chartRoleCodes = getOrgHierarchyFromPolicy().nodes.flatMap((node) => node.role_codes || []);

    for (const role of ['OP_INCHARGE', 'IP_INCHARGE', 'OT_INCHARGE', 'CATH_LAB_INCHARGE']) {
      expect(pickerRoles).toContain(role);
      expect(chartRoleCodes).toContain(role);
    }
  });

  it('keeps NURSING_INCHARGE scoped to IP/ward nursing only', () => {
    expect(getManageableRolesFromPolicy('NURSING_INCHARGE')).toEqual([
      'IP_INCHARGE',
      'NURSING_STAFF',
      'IP_STAFF_NURSE',
    ]);
    expect(getStaffVisibilityRoles('NURSING_INCHARGE')).toEqual([
      'NURSING_INCHARGE',
      'IP_INCHARGE',
      'NURSING_STAFF',
      'IP_STAFF_NURSE',
    ]);
    expect(getManageableRolesFromPolicy('NURSING_INCHARGE')).not.toEqual(expect.arrayContaining([
      'OP_STAFF_NURSE',
      'OT_NURSE',
      'CATH_LAB_STAFF',
    ]));
  });

  it('keeps HR processing authority separate from clinical PHI access', () => {
    const policy = getRolePolicy();
    const hr = policy.roles.find((role) => role.role_code === 'HR_STAFF');

    expect(hr?.hr_process?.can_process_leave_for_roles).toEqual(expect.arrayContaining([
      'NURSING_STAFF',
      'OP_STAFF_NURSE',
      'OT_NURSE',
      'CATH_LAB_STAFF',
    ]));
    expect(hr?.phi?.access_level).toBe(PHI_ACCESS_LEVELS.STAFF_ONLY);
    expect(hr?.access?.route_capability_groups || []).not.toEqual(expect.arrayContaining([
      'ip_flow',
      'theatre',
      'cath_lab',
    ]));
  });

  it('excludes non-human and non-staff roles from staff role picker options', () => {
    const pickerRoles = getRolePickerOptions().map((role) => role.role);

    expect(pickerRoles).toEqual(expect.arrayContaining([
      'IP_STAFF_NURSE',
      'OT_NURSE',
      'CATH_LAB_STAFF',
      'BILLING_STAFF',
    ]));
    expect(pickerRoles).not.toContain('PATIENT');
    expect(pickerRoles).not.toContain('WEBHOOK_CLIENT');
    expect(pickerRoles).not.toContain('SUPER_ADMIN');
  });

  it('models stores/purchase as operational supply-chain authority without PHI access', () => {
    const policy = getRolePolicy();
    const role = policy.roles.find((item) => item.role_code === 'STORES_PURCHASE_INCHARGE');
    const chart = getOrgHierarchyFromPolicy();
    const node = chart.nodes.find((item) => item.id === 'stores_purchase_incharge');

    expect(role).toEqual(expect.objectContaining({
      display_title: 'Stores / Purchase Incharge',
      group: 'support',
      department: 'Stores / Purchase',
    }));
    // phone_self_service is the universal staff phone surface (home,
    // attendance, alerts, messages) added with phone mode — it is not a
    // PHI capability, so it coexists with the no-PHI assertions below.
    expect(role?.access?.route_capability_groups).toEqual(
      expect.arrayContaining(['supply_chain']),
    );
    expect(role?.access?.route_capability_groups).not.toEqual(
      expect.arrayContaining(['clinical', 'emr', 'pharmacy', 'billing']),
    );
    expect(role?.phi).toEqual(expect.objectContaining({
      access_level: PHI_ACCESS_LEVELS.OPERATIONAL_ONLY,
      requires_patient_relationship: false,
      can_break_glass: false,
    }));
    expect(getRolePickerOptions().map((item) => item.role)).toContain('STORES_PURCHASE_INCHARGE');
    expect(node?.role_codes).toContain('STORES_PURCHASE_INCHARGE');
  });
});
