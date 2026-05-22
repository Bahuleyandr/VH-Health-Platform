// Unit test for D5 (tenant-RLS posture boot warning).
//
// When AUTH_ENFORCE_TENANT_RLS is off, tenant_isolation policies are inert.
// In production that is a multi-tenant PHI-isolation gap and the boot guard
// must surface it loudly (warn); elsewhere (dev/test or a confirmed
// single-tenant install) RLS-off is expected and stays info. This pure helper
// drives that decision in logTenantRlsRolePosture().

import { rlsDisabledLogLevel } from '../../lib/prisma.js';

describe('rlsDisabledLogLevel (D5)', () => {
  it('warns loudly when RLS is disabled in production', () => {
    expect(rlsDisabledLogLevel('production')).toBe('warn');
    expect(rlsDisabledLogLevel('PRODUCTION')).toBe('warn');
  });

  it('stays info outside production (dev/test/staging/unset)', () => {
    for (const env of ['test', 'development', 'staging', '', null, undefined]) {
      expect(rlsDisabledLogLevel(env)).toBe('info');
    }
  });
});
