// GET /rbac/policy carries the server's effective specialty gate modes.
//
// The staff app's department tile filter keys its enforcement on this field:
// it hides a specialty module only when the server itself reports 'enforce'
// for that module (2026-08-25 reaudit, FE-M1). Losing the field silently
// reverts the app to unconditional client-side enforcement — the exact
// report-mode privilege-loss/ledger-starvation defect the field exists to fix.

import { RBACService } from '../../services/infrastructure/rbacService.js';
import {
  SPECIALTY_FEATURE_KEYS,
} from '../../config/specialtyDepartmentPolicy.js';

describe('RBACService.getPolicy specialty_gate_modes', () => {
  const savedGlobal = process.env.SPECIALTY_DEPARTMENT_GATE_MODE;
  const savedDental = process.env.SPECIALTY_DEPARTMENT_GATE_MODE_DENTAL;
  afterEach(() => {
    if (savedGlobal === undefined) delete process.env.SPECIALTY_DEPARTMENT_GATE_MODE;
    else process.env.SPECIALTY_DEPARTMENT_GATE_MODE = savedGlobal;
    if (savedDental === undefined) delete process.env.SPECIALTY_DEPARTMENT_GATE_MODE_DENTAL;
    else process.env.SPECIALTY_DEPARTMENT_GATE_MODE_DENTAL = savedDental;
  });

  it('publishes one mode per gated feature id, reflecting the env knobs', () => {
    delete process.env.SPECIALTY_DEPARTMENT_GATE_MODE;
    process.env.SPECIALTY_DEPARTMENT_GATE_MODE_DENTAL = 'enforce';

    const policy = RBACService.getPolicy();
    expect(policy.specialty_gate_modes).toBeDefined();
    expect(Object.keys(policy.specialty_gate_modes).sort()).toEqual(
      Object.keys(SPECIALTY_FEATURE_KEYS).sort(),
    );
    expect(policy.specialty_gate_modes.dental_charting).toBe('enforce');
    expect(policy.specialty_gate_modes.oncology).toBe('report');
  });

  it('stays OUTSIDE the hashed policy graph — a mode flip must not bump the hash', () => {
    delete process.env.SPECIALTY_DEPARTMENT_GATE_MODE;
    const reportHash = RBACService.getPolicy().policy_hash;
    process.env.SPECIALTY_DEPARTMENT_GATE_MODE = 'enforce';
    const enforceHash = RBACService.getPolicy().policy_hash;
    expect(enforceHash).toBe(reportHash);
  });
});
