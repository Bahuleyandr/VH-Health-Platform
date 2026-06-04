import {
  ROLE_HIERARCHY,
  canUserManageRole,
  getManageableRoles,
  hasPermission,
} from '../../utils/infrastructure/rbacUtils.js';

describe('RBAC nursing hierarchy', () => {
  it('models CNO as Nursing Superintendent over all nursing incharges and staff branches', () => {
    expect(ROLE_HIERARCHY.CNO).toEqual(expect.objectContaining({
      description: expect.stringContaining('Nursing Superintendent'),
      canViewData: 'nursing_leadership',
    }));

    expect(getManageableRoles('CNO')).toEqual(expect.arrayContaining([
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

    expect(canUserManageRole('CNO', 'OP_INCHARGE')).toBe(true);
    expect(canUserManageRole('CNO', 'IP_STAFF_NURSE')).toBe(true);
    expect(canUserManageRole('CNO', 'OT_INCHARGE')).toBe(true);
    expect(canUserManageRole('CNO', 'CATH_LAB_INCHARGE')).toBe(true);
    expect(hasPermission('CNO', 'manage_nursing_roster')).toBe(true);
  });

  it('keeps individual nursing incharges scoped to their own reporting branches', () => {
    expect(getManageableRoles('NURSING_INCHARGE')).toEqual(['IP_INCHARGE', 'NURSING_STAFF', 'IP_STAFF_NURSE']);
    expect(getManageableRoles('OP_INCHARGE')).toEqual(['OP_STAFF_NURSE']);
    expect(getManageableRoles('IP_INCHARGE')).toEqual(['NURSING_STAFF', 'IP_STAFF_NURSE']);
    expect(getManageableRoles('OT_INCHARGE')).toEqual(['OT_NURSE', 'OT_STAFF']);
    expect(getManageableRoles('CATH_LAB_INCHARGE')).toEqual(['CATH_LAB_STAFF']);

    expect(canUserManageRole('OP_INCHARGE', 'IP_STAFF_NURSE')).toBe(false);
    expect(canUserManageRole('IP_INCHARGE', 'OT_NURSE')).toBe(false);
    expect(canUserManageRole('OT_INCHARGE', 'CATH_LAB_STAFF')).toBe(false);
    expect(canUserManageRole('CATH_LAB_INCHARGE', 'OP_STAFF_NURSE')).toBe(false);
  });
});
