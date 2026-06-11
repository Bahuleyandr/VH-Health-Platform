import { jest } from '@jest/globals';

jest.unstable_mockModule('../../utils/securityAuditLogger.js', () => ({
  logSecurityEvent: jest.fn(),
}));

const {
  adminIpAllowlist,
  ipMatchesCIDR,
  isIpAllowedByAdminAllowlist,
  parseAdminIpAllowlist,
} = await import('../../middleware/ipAllowlistMiddleware.js');

const originalEnv = { ...process.env };

function makeResponse() {
  const res = {
    status: jest.fn(() => res),
    json: jest.fn(() => res),
  };
  return res;
}

describe('admin IP allowlist middleware', () => {
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    jest.clearAllMocks();
  });

  it('parses comma-separated allowlist entries', () => {
    expect(parseAdminIpAllowlist(' 203.0.113.10, 10.10.0.0/16 ,,')).toEqual([
      '203.0.113.10',
      '10.10.0.0/16',
    ]);
  });

  it('matches exact IPv4 and IPv4 CIDR entries', () => {
    expect(ipMatchesCIDR('203.0.113.10', '203.0.113.10')).toBe(true);
    expect(ipMatchesCIDR('::ffff:203.0.113.10', '203.0.113.10')).toBe(true);
    expect(ipMatchesCIDR('10.10.20.30', '10.10.0.0/16')).toBe(true);
    expect(ipMatchesCIDR('10.11.20.30', '10.10.0.0/16')).toBe(false);
  });

  it('treats malformed CIDR entries as non-matches', () => {
    expect(ipMatchesCIDR('10.10.20.30', '10.10.0.0/99')).toBe(false);
    expect(ipMatchesCIDR('10.10.20.30', '10.10.0.0/nope')).toBe(false);
  });

  it('allows missing allowlist outside production to preserve local development', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.ADMIN_IP_ALLOWLIST;
    const req = { ip: '203.0.113.10', originalUrl: '/api/v1/admin' };
    const res = makeResponse();
    const next = jest.fn();

    adminIpAllowlist(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('fails closed when production allowlist is missing', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ADMIN_IP_ALLOWLIST;
    const req = { ip: '203.0.113.10', originalUrl: '/api/v1/admin' };
    const res = makeResponse();
    const next = jest.fn();

    adminIpAllowlist(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'ADMIN_IP_ALLOWLIST_REQUIRED',
    }));
  });

  it('blocks production clients outside the configured allowlist', () => {
    process.env.NODE_ENV = 'production';
    process.env.ADMIN_IP_ALLOWLIST = '10.10.0.0/16';
    const req = { ip: '203.0.113.10', originalUrl: '/api/v1/admin' };
    const res = makeResponse();
    const next = jest.fn();

    adminIpAllowlist(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'ADMIN_IP_NOT_ALLOWED',
    }));
  });

  it('allows production clients inside the configured allowlist', () => {
    expect(isIpAllowedByAdminAllowlist('10.10.20.30', ['10.10.0.0/16'])).toBe(true);
  });
});
