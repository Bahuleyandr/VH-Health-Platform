import {
  DIALYSIS_EMERGENCY_OVERRIDE_ROUTE_ROLES,
  HOLD_EVIDENCE_REVIEW_ROUTE_ROLES,
  REPROCESSING_MOUNT_ROUTE_ROLES,
  REPROCESSING_POLICY_ROUTE_ROLES,
  RPD_BIOLOGICAL_HOLD_ADJUDICATION_ROUTE_ROLES,
  RPD_ROUTINE_HOLD_RELEASE_ROUTE_ROLES,
} from '../../config/routeRolePolicy.js';
import {
  assertHoldReleaseAuthority,
  accountableRoleForHold,
} from '../../services/clinical/reprocessableDeviceRules.js';
import { getRolePolicyRoleCodes } from '../../config/rolePolicyGraph.js';

describe('reprocessable device authorization role sets', () => {
  test('pins every Revision 3 role set by exact membership', () => {
    expect(RPD_BIOLOGICAL_HOLD_ADJUDICATION_ROUTE_ROLES).toEqual([
      'INFECTION_CONTROL_OFFICER', 'CONSULTANT', 'ADMIN', 'SUPER_ADMIN',
    ]);
    expect(RPD_ROUTINE_HOLD_RELEASE_ROUTE_ROLES).toEqual([
      'QUALITY_OFFICER', 'OT_INCHARGE', 'ADMIN', 'SUPER_ADMIN',
    ]);
    expect(DIALYSIS_EMERGENCY_OVERRIDE_ROUTE_ROLES).toEqual([
      'CONSULTANT', 'ADMIN', 'SUPER_ADMIN',
    ]);
    expect(HOLD_EVIDENCE_REVIEW_ROUTE_ROLES).toEqual([
      'INFECTION_CONTROL_OFFICER', 'CONSULTANT', 'ADMIN', 'SUPER_ADMIN',
    ]);
    expect(REPROCESSING_MOUNT_ROUTE_ROLES).toEqual([
      'QUALITY_OFFICER', 'INFECTION_CONTROL_OFFICER', 'CONSULTANT', 'ADMIN', 'SUPER_ADMIN',
    ]);
    expect(REPROCESSING_POLICY_ROUTE_ROLES).toEqual([
      'QUALITY_OFFICER', 'INFECTION_CONTROL_OFFICER', 'ADMIN', 'SUPER_ADMIN',
    ]);
    const allNamedRoles = new Set([
      ...RPD_BIOLOGICAL_HOLD_ADJUDICATION_ROUTE_ROLES,
      ...RPD_ROUTINE_HOLD_RELEASE_ROUTE_ROLES,
      ...DIALYSIS_EMERGENCY_OVERRIDE_ROUTE_ROLES,
      ...HOLD_EVIDENCE_REVIEW_ROUTE_ROLES,
      ...REPROCESSING_MOUNT_ROUTE_ROLES,
      ...REPROCESSING_POLICY_ROUTE_ROLES,
    ]);
    expect(allNamedRoles.size).toBe(6);
    const liveRoles = getRolePolicyRoleCodes();
    for (const role of allNamedRoles) expect(liveRoles).toContain(role);
  });

  test('pins accountable roles and administrative application-only behavior', () => {
    expect(accountableRoleForHold('bloodborne_exposure')).toBe('INFECTION_CONTROL_OFFICER');
    expect(accountableRoleForHold('prion_exposure')).toBe('CONSULTANT');
    expect(accountableRoleForHold('sterilization_failed')).toBe('QUALITY_OFFICER');
    expect(accountableRoleForHold('inspection_failed')).toBe('OT_INCHARGE');

    expect(() => assertHoldReleaseAuthority({
      holdType: 'bloodborne_exposure',
      actorRole: 'ADMIN',
      approverRole: 'ADMIN',
    })).toThrow(expect.objectContaining({ code: 'RPD_ACCOUNTABLE_APPROVAL_REQUIRED' }));
    expect(assertHoldReleaseAuthority({
      holdType: 'bloodborne_exposure',
      actorRole: 'ADMIN',
      approverRole: 'INFECTION_CONTROL_OFFICER',
    })).toEqual({ accountableRole: 'INFECTION_CONTROL_OFFICER', administrativeApplication: true });
    expect(assertHoldReleaseAuthority({
      holdType: 'inspection_failed',
      actorRole: 'OT_INCHARGE',
      approverRole: 'OT_INCHARGE',
    })).toEqual({ accountableRole: 'OT_INCHARGE', administrativeApplication: false });
  });

  test('keeps biological, routine, evidence-view, and emergency powers separate', () => {
    expect(() => assertHoldReleaseAuthority({
      holdType: 'prion_exposure', actorRole: 'QUALITY_OFFICER', approverRole: 'CONSULTANT',
    })).toThrow(expect.objectContaining({ code: 'RPD_HOLD_RELEASE_FORBIDDEN' }));
    expect(() => assertHoldReleaseAuthority({
      holdType: 'load_invalidated', actorRole: 'CONSULTANT', approverRole: 'QUALITY_OFFICER',
    })).toThrow(expect.objectContaining({ code: 'RPD_HOLD_RELEASE_FORBIDDEN' }));
    expect(REPROCESSING_MOUNT_ROUTE_ROLES).toContain('CONSULTANT');
    expect(REPROCESSING_POLICY_ROUTE_ROLES).not.toContain('CONSULTANT');
    expect(HOLD_EVIDENCE_REVIEW_ROUTE_ROLES).not.toContain('QUALITY_OFFICER');
  });
});
