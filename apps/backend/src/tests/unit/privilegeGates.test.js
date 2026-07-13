import { readFileSync } from 'node:fs';
import {
  PRIVILEGE_GATES,
  ALWAYS_ON_GATES,
  gateFlagEnabled,
  resolvePrivilegeGateStates,
} from '../../config/privilegeGates.js';

function migration(number, name) {
  return readFileSync(new URL(`../../migrations/${number}_${name}.sql`, import.meta.url), 'utf8');
}

describe('privilege-gate registry (credential-hardening ops)', () => {
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; });

  it('registers every env-flagged clinical gate, including the new OBGyn gate', () => {
    const flags = PRIVILEGE_GATES.map((g) => g.envVar);
    expect(flags).toEqual(expect.arrayContaining([
      'THEATRE_REQUIRE_PRIMARY_SURGEON_PRIVILEGE',
      'THEATRE_REQUIRE_OT_READY_SURGEON_PRIVILEGE',
      'ANESTHESIA_REQUIRE_FINALIZE_PRIVILEGE',
      'CTVS_ENFORCE_PERFUSIONIST_SIGNOFF_PRIVILEGE',
      'CATH_LAB_PRIVILEGE_GATE_ENABLED',
      'CHEMO_REQUIRE_ADMIN_PRIVILEGE',
      'CONTROLLED_SUBSTANCE_REQUIRE_PRESCRIBE_PRIVILEGE',
      'RADIATION_ONCOLOGY_PRIVILEGE_GATE_ENABLED',
      'OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED',
    ]));
    // cath report signing is always-on (no env flag) and listed separately.
    expect(ALWAYS_ON_GATES.map((g) => g.privilegeKey)).toContain('cath_report_signing');
  });

  it('uses the same truthy semantics as isGateEnabled', () => {
    for (const on of ['1', 'true', 'TRUE', 'yes', 'On']) {
      process.env.OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED = on;
      expect(gateFlagEnabled('OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED')).toBe(true);
    }
    for (const off of ['0', 'false', 'no', 'off', '', 'enabled']) {
      process.env.OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED = off;
      expect(gateFlagEnabled('OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED')).toBe(false);
    }
    delete process.env.OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED;
    expect(gateFlagEnabled('OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED')).toBe(false);
  });

  it('resolves all gates OFF by default', () => {
    for (const g of PRIVILEGE_GATES) delete process.env[g.envVar];
    const states = resolvePrivilegeGateStates();
    expect(states.every((g) => g.enabled === false)).toBe(true);
    expect(states).toHaveLength(PRIVILEGE_GATES.length);
  });
});

describe('OBGyn labour-ward privilege seed (migration 574)', () => {
  const seed = migration(574, 'obgyn_labour_ward_privilege_seed');

  it('seeds a grantable obstetrics privilege for every tenant', () => {
    expect(seed).toMatch(/INSERT INTO privilege_catalog/);
    expect(seed).toMatch(/'obgyn_labour_ward_access'/);
    expect(seed).toMatch(/'obstetrics'/);
    expect(seed).toMatch(/FROM tenants t/);
  });

  it('is grantable but leaves runtime enforcement off (env-flagged)', () => {
    expect(seed).toMatch(/"gate_enabled":false/);
    // The catalog status is active (grantable); the env flag governs enforcement.
    expect(seed).toMatch(/'active'/);
  });
});
