import { jest } from '@jest/globals';

const evaluateEntitlement = jest.fn();

jest.unstable_mockModule('../../services/entitlements/entitlementService.js', () => ({
  evaluateEntitlement
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

const { requireEntitlement } = await import('../../middleware/entitlementMiddleware.js');

function makeReq(overrides = {}) {
  return {
    tenantId: '00000000-0000-4000-8000-000000000001',
    method: 'GET',
    path: '/api-clients',
    originalUrl: '/api/v1/admin/api-clients',
    id: 'req-1',
    user: {
      uid: '11111111-1111-4111-8111-111111111111',
      role: 'ADMIN'
    },
    ...overrides
  };
}

function makeRes() {
  const res = {
    headers: {},
    statusCode: 200,
    body: null,
    req: { id: 'req-1', originalUrl: '/api/v1/admin/api-clients' },
    setHeader: jest.fn((key, value) => {
      res.headers[key] = value;
    }),
    status: jest.fn(code => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn(body => {
      res.body = body;
      return res;
    })
  };
  return res;
}

describe('requireEntitlement', () => {
  beforeEach(() => evaluateEntitlement.mockReset());

  it('passes allowed entitlement decisions through', async () => {
    evaluateEntitlement.mockResolvedValueOnce({
      allowed: true,
      hardBlock: true,
      status: 'active',
      reason: 'active'
    });
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await requireEntitlement('developer.api_clients')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.setHeader).toHaveBeenCalledWith('X-VH-Entitlement-Status', 'active');
  });

  it('hard-blocks denied commercial, admin, and developer decisions', async () => {
    evaluateEntitlement.mockResolvedValueOnce({
      allowed: false,
      hardBlock: true,
      status: 'not_entitled',
      reason: 'missing package'
    });
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await requireEntitlement('developer.api_clients')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.details.code).toBe('FEATURE_NOT_ENTITLED');
  });

  it('does not fail closed when an urgent clinical check errors', async () => {
    evaluateEntitlement.mockRejectedValueOnce(new Error('table missing'));
    const req = makeReq({ originalUrl: '/api/v1/sos' });
    const res = makeRes();
    const next = jest.fn();

    await requireEntitlement('clinical.emergency', { urgentClinical: true })(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.setHeader).toHaveBeenCalledWith('X-VH-Entitlement-Status', 'check_unavailable');
  });
});
