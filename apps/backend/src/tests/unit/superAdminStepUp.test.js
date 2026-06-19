// Unit tests for requireSuperAdminStepUp (audit 2026-06-18 — SUPER_ADMIN
// un-scoped bypass HIGH). SUPER_ADMIN blanket-bypasses every requireRole gate,
// so on the sensitive admin/system control planes the master-key role can act
// with no second control. This middleware scopes that bypass: on the routes it
// guards, a SUPER_ADMIN must present a 2FA-verified ("stepped-up") session
// (req.user.mfa === true). Non-super users are untouched — they were already
// gated by the upstream requireRole(...).
import { jest } from '@jest/globals';

const logSecurityEvent = jest.fn();
jest.unstable_mockModule('../../utils/securityAuditLogger.js', () => ({
  logSecurityEvent,
}));

const { requireSuperAdminStepUp } = await import('../../middleware/rbacMiddleware.js');

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function invoke(user) {
  const req = {
    user,
    ip: '127.0.0.1',
    method: 'POST',
    originalUrl: '/api/v1/admin/roles',
    headers: { 'user-agent': 'jest' },
  };
  const res = makeRes();
  let nextCalled = false;
  requireSuperAdminStepUp(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled: () => nextCalled };
}

describe('requireSuperAdminStepUp', () => {
  beforeEach(() => logSecurityEvent.mockClear());

  it('blocks a SUPER_ADMIN whose session is NOT 2FA-stepped-up (403 SUPER_ADMIN_MFA_REQUIRED)', () => {
    // jwtMiddleware normalizes SUPER_ADMIN -> ADMIN on role, preserving it on rawRole.
    const { res, nextCalled } = invoke({ uid: 'sa1', role: 'ADMIN', rawRole: 'SUPER_ADMIN' });
    expect(nextCalled()).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ success: false, code: 'SUPER_ADMIN_MFA_REQUIRED' });
    expect(logSecurityEvent).toHaveBeenCalled();
  });

  it('allows a SUPER_ADMIN with a 2FA-verified (mfa) session', () => {
    const { res, nextCalled } = invoke({ uid: 'sa1', role: 'ADMIN', rawRole: 'SUPER_ADMIN', mfa: true });
    expect(nextCalled()).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(logSecurityEvent).not.toHaveBeenCalled();
  });

  it('passes a normal ADMIN through untouched (already role-gated upstream)', () => {
    const { res, nextCalled } = invoke({ uid: 'a1', role: 'ADMIN', rawRole: 'ADMIN' });
    expect(nextCalled()).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(logSecurityEvent).not.toHaveBeenCalled();
  });

  it('detects SUPER_ADMIN even when it surfaces on the normalized role field (defensive)', () => {
    const { res, nextCalled } = invoke({ uid: 'sa2', role: 'SUPER_ADMIN', rawRole: 'SUPER_ADMIN' });
    expect(nextCalled()).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUPER_ADMIN_MFA_REQUIRED' });
  });

  it('does not treat a truthy-but-non-true mfa value as a verified session', () => {
    // Only an explicit boolean true counts — guards against a forged/odd claim
    // like mfa:"false" or mfa:1 being coerced to "verified".
    const { res, nextCalled } = invoke({ uid: 'sa3', role: 'ADMIN', rawRole: 'SUPER_ADMIN', mfa: 'false' });
    expect(nextCalled()).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('rejects an unauthenticated request (no req.user) with 401', () => {
    const { res, nextCalled } = invoke(undefined);
    expect(nextCalled()).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});
