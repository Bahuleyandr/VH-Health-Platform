import { EventEmitter } from 'events';
import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const logPhiAccessMock = jest.fn();
const warnMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
  },
}));

jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: logPhiAccessMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: warnMock,
  },
}));

const {
  billingPhiAccessLogger,
  deriveBillingInvoiceId,
  isBillingPhiPath,
  resolveBillingPhiContext,
} = await import('../../middleware/billingPhiAccessMiddleware.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const PATIENT = '22222222-2222-4222-8222-222222222222';

function makeReq(overrides = {}) {
  return {
    method: 'GET',
    url: '/invoices',
    originalUrl: '/api/v1/billing/v2/invoices',
    query: {},
    body: {},
    ip: '127.0.0.1',
    id: 'req-123',
    user: {
      uid: ACTOR,
      role: 'BILLING_STAFF',
      tenant_id: TENANT,
      deviceType: 'desktop',
    },
    ...overrides,
  };
}

function makeRes(statusCode = 200) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  return res;
}

async function flushImmediate() {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  logPhiAccessMock.mockReset();
  warnMock.mockReset();
});

describe('billing PHI access middleware', () => {
  it('recognizes billing v2 PHI paths and skips service-master paths', () => {
    expect(isBillingPhiPath('/invoices')).toBe(true);
    expect(isBillingPhiPath('/invoices/123/issue')).toBe(true);
    expect(isBillingPhiPath('/payments')).toBe(true);
    expect(isBillingPhiPath('/payment-links?patient_uid=x')).toBe(true);
    expect(isBillingPhiPath('/services')).toBe(false);
  });

  it('derives invoice id from body, query, or invoice URL path', () => {
    expect(deriveBillingInvoiceId(makeReq({ body: { invoice_id: 7 } }))).toBe('7');
    expect(deriveBillingInvoiceId(makeReq({ query: { invoice_id: '8' } }))).toBe('8');
    expect(deriveBillingInvoiceId(makeReq({ url: '/invoices/9/issue' }))).toBe('9');
  });

  it('uses direct patient context without a database lookup', async () => {
    const req = makeReq({
      query: { patient_uid: PATIENT },
      url: '/invoices?patient_uid=222',
    });

    const context = await resolveBillingPhiContext(req);

    expect(context).toEqual({
      patientUid: PATIENT,
      admissionId: null,
      invoiceId: null,
    });
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('logs direct patient invoice reads without a database lookup', async () => {
    const req = makeReq({
      query: { patient_uid: PATIENT },
      url: `/invoices?patient_uid=${PATIENT}`,
    });
    const res = makeRes(200);

    billingPhiAccessLogger()(req, res, jest.fn());
    res.emit('finish');
    await flushImmediate();

    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(logPhiAccessMock).toHaveBeenCalledWith(expect.objectContaining({
      patientId: PATIENT,
      recordType: 'BILLING_INVOICE',
      action: 'VIEW',
      deviceType: 'desktop',
      tenantId: TENANT,
    }));
  });

  it('resolves invoice route ids to patient context for PHI audit logging', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      patient_uid: PATIENT,
      admission_id: 44,
    }]);
    const req = makeReq({
      method: 'POST',
      url: '/invoices/123/issue',
      originalUrl: '/api/v1/billing/v2/invoices/123/issue',
    });
    const res = makeRes(201);
    const next = jest.fn();

    billingPhiAccessLogger()(req, res, next);
    res.emit('finish');
    await flushImmediate();

    expect(next).toHaveBeenCalledTimes(1);
    expect(queryRawUnsafeMock).toHaveBeenCalledWith(
      expect.stringContaining('FROM billing_invoices'),
      123,
      TENANT,
    );
    expect(logPhiAccessMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: ACTOR,
      userRole: 'BILLING_STAFF',
      patientId: PATIENT,
      recordType: 'BILLING_INVOICE',
      action: 'CREATE',
      requestId: 'req-123',
      actorUid: ACTOR,
      subjectUid: ACTOR,
      deviceType: 'desktop',
      tenantId: TENANT,
    }));
  });

  it('does not log non-PHI billing service-master reads', async () => {
    const req = makeReq({
      url: '/services',
      originalUrl: '/api/v1/billing/v2/services',
    });
    const res = makeRes(200);

    billingPhiAccessLogger()(req, res, jest.fn());
    res.emit('finish');
    await flushImmediate();

    expect(logPhiAccessMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('does not log failed billing responses', async () => {
    const req = makeReq({
      url: '/invoices/123',
      originalUrl: '/api/v1/billing/v2/invoices/123',
    });
    const res = makeRes(403);

    billingPhiAccessLogger()(req, res, jest.fn());
    res.emit('finish');
    await flushImmediate();

    expect(logPhiAccessMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });
});
