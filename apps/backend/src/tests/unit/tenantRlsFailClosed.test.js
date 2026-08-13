// Boot fail-closed decision for unsafe tenant-RLS posture (CAN-040).
import { jest } from '@jest/globals';
import {
  logTenantRlsRolePosture,
  tenantRlsPostureMustFailClosed,
} from '../../lib/prisma.js';

const OK = { enforced: true, ok: true };
const OFF = { enforced: false, ok: false };
const INERT = { enforced: true, ok: false, reason: 'superuser_or_bypassrls' };
const PROBE_ERR = { error: true, reason: 'probe_failed' };

describe('tenantRlsPostureMustFailClosed (CAN-040)', () => {
  it('fails closed in production when RLS is OFF', () => {
    expect(tenantRlsPostureMustFailClosed(OFF, { NODE_ENV: 'production' })).toBe(true);
  });
  it('fails closed in production when RLS is enforced but INERT', () => {
    expect(tenantRlsPostureMustFailClosed(INERT, { NODE_ENV: 'production' })).toBe(true);
  });
  it('does NOT fail closed when posture is OK', () => {
    expect(tenantRlsPostureMustFailClosed(OK, { NODE_ENV: 'production' })).toBe(false);
  });
  it('fails closed on a probe error because isolation could not be proved', () => {
    expect(tenantRlsPostureMustFailClosed(PROBE_ERR, { NODE_ENV: 'production' })).toBe(true);
  });
  it('does NOT fail closed outside production', () => {
    expect(tenantRlsPostureMustFailClosed(OFF, { NODE_ENV: 'test' })).toBe(false);
    expect(tenantRlsPostureMustFailClosed(INERT, { NODE_ENV: 'development' })).toBe(false);
  });
  it('honours the audited single-tenant override', () => {
    expect(tenantRlsPostureMustFailClosed(OFF, { NODE_ENV: 'production', AUTH_TENANT_RLS_FAIL_OPEN: 'true' })).toBe(false);
    expect(tenantRlsPostureMustFailClosed(PROBE_ERR, { NODE_ENV: 'production', AUTH_TENANT_RLS_FAIL_OPEN: 'true' })).toBe(false);
  });

  it('retries transient posture probe failures within the configured startup budget', async () => {
    const probe = jest.fn()
      .mockResolvedValueOnce(PROBE_ERR)
      .mockResolvedValueOnce(PROBE_ERR)
      .mockResolvedValueOnce(OK);

    await expect(logTenantRlsRolePosture({ attempts: 3, delayMs: 0, probe })).resolves.toEqual(OK);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('returns the final error posture after bounded retry exhaustion', async () => {
    const finalError = { error: true, reason: 'probe_failed_final' };
    const probe = jest.fn()
      .mockResolvedValueOnce(PROBE_ERR)
      .mockResolvedValueOnce(finalError);

    await expect(logTenantRlsRolePosture({ attempts: 2, delayMs: 0, probe })).resolves.toEqual(finalError);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
