import {
  canManageRosterDepartmentWork,
  canPlanRosterForecast,
  canReviewRosterDepartmentRequest,
  canViewRosterDepartment,
  getRosterDepartmentPolicy,
  getRosterDepartmentStaffRoles,
} from '../../config/rosterDepartmentConfig.js';

function user(role) {
  return { role };
}

describe('roster department hierarchy policy', () => {
  it('keeps roster policy central for reused department boards', () => {
    expect(getRosterDepartmentPolicy('nursing')).toMatchObject({
      department: 'nursing',
      targetType: 'ward',
    });
    expect(getRosterDepartmentPolicy('maintenance')).toMatchObject({
      department: 'maintenance',
      targetType: 'maintenance_zone',
    });
    expect(getRosterDepartmentPolicy('medical')).toMatchObject({
      department: 'medical',
      targetType: 'clinical_unit',
    });
  });

  it('separates HR leave-process visibility from operational roster publishing', () => {
    expect(canViewRosterDepartment(user('HR_STAFF'), 'housekeeping')).toBe(true);
    expect(canReviewRosterDepartmentRequest(user('HR_STAFF'), 'housekeeping')).toBe(true);
    expect(canPlanRosterForecast(user('HR_STAFF'), 'housekeeping')).toBe(true);
    expect(canManageRosterDepartmentWork(user('HR_STAFF'), 'housekeeping')).toBe(false);
  });

  it('allows department incharges to manage only their work roster line', () => {
    expect(canManageRosterDepartmentWork(user('HOUSEKEEPING_INCHARGE'), 'housekeeping')).toBe(true);
    expect(canManageRosterDepartmentWork(user('HOUSEKEEPING_INCHARGE'), 'nursing')).toBe(false);
    expect(canManageRosterDepartmentWork(user('NURSING_INCHARGE'), 'nursing')).toBe(true);
    expect(canManageRosterDepartmentWork(user('NURSING_INCHARGE'), 'maintenance')).toBe(false);
  });

  it('supports drivers through the ambulance alias and adds maintenance staff pools', () => {
    expect(getRosterDepartmentPolicy('drivers')?.department).toBe('ambulance');
    expect(canManageRosterDepartmentWork(user('HR_STAFF'), 'drivers')).toBe(true);
    expect(getRosterDepartmentStaffRoles('maintenance')).toEqual(['MAINTENANCE']);
  });
});
