import { jest } from '@jest/globals';

const revealPayslipCredentialMock = jest.fn();
const logAuditMock = jest.fn();
const loggerErrorMock = jest.fn();

const prismaMock = {};
// payrollController reaches for setTenant on the arrears work-item paths; the
// reveal path under test never runs it, but the loader still needs the symbol.
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenant: jest.fn(async (_tenantId, fn) => fn(prismaMock))
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: loggerErrorMock,
    warn: jest.fn()
  }
}));
jest.unstable_mockModule('../../services/staff/payrollService.js', () => ({
  executePayrollRun: jest.fn(),
  editPayslipAndRegenerate: jest.fn(),
  issuePayrollRun: jest.fn(),
  revealPayslipCredential: revealPayslipCredentialMock,
  signPayrollRun: jest.fn(),
  generateAnnualTaxSummary: jest.fn(),
  calculateArrears: jest.fn(),
  // Controller narrows on `err instanceof SalaryArrearsCommandError` to pick the
  // status code, so the mock has to be a real class, not a jest.fn().
  SalaryArrearsCommandError: class SalaryArrearsCommandError extends Error {
    constructor(message, statusCode = 409) {
      super(message);
      this.name = 'SalaryArrearsCommandError';
      this.statusCode = statusCode;
    }
  }
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: req => req.tenantId
}));
jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: logAuditMock
}));
jest.unstable_mockModule('../../utils/r2Storage.js', () => ({
  getSignedFileUrl: jest.fn()
}));

const { revealPayslipPassword } = await import('../../controllers/staff/payrollController.js');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const STAFF_UID = '22222222-2222-4222-8222-222222222222';

function makeReq(id = '7') {
  return {
    params: { id },
    tenantId: TENANT_ID,
    user: { uid: STAFF_UID, role: 'NURSE' }
  };
}

function makeRes(req) {
  const headers = {};
  return {
    req,
    headers,
    statusCode: null,
    body: null,
    setHeader: jest.fn((name, value) => {
      headers[name.toLowerCase()] = value;
    }),
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  logAuditMock.mockResolvedValue(undefined);
});

test('reveals only the owned credential with no-store headers and an audit event', async () => {
  const req = makeReq();
  const res = makeRes(req);
  revealPayslipCredentialMock.mockResolvedValue({
    credential: 'PDF-only-secret',
    document_id: 91
  });

  await revealPayslipPassword(req, res);

  expect(revealPayslipCredentialMock).toHaveBeenCalledWith({
    tenantId: TENANT_ID,
    payslipId: 7,
    staffUid: STAFF_UID
  });
  expect(res.headers['cache-control']).toBe('no-store, max-age=0');
  expect(res.headers.pragma).toBe('no-cache');
  expect(res.statusCode).toBe(200);
  expect(res.body).toMatchObject({
    success: true,
    data: { password: 'PDF-only-secret' }
  });
  expect(logAuditMock).toHaveBeenCalledWith(
    req,
    'payslip-password-revealed',
    { payslip_id: 7, document_id: 91 },
    { resource: 'payslip', resourceId: 7 }
  );
  expect(JSON.stringify(logAuditMock.mock.calls)).not.toContain('PDF-only-secret');
});

test('returns no credential and does not audit when the payslip is not owned', async () => {
  const req = makeReq();
  const res = makeRes(req);
  revealPayslipCredentialMock.mockResolvedValue(null);

  await revealPayslipPassword(req, res);

  expect(res.statusCode).toBe(404);
  expect(res.body).toEqual({
    success: false,
    message: 'Payslip password not available'
  });
  expect(res.body).not.toHaveProperty('data');
  expect(logAuditMock).not.toHaveBeenCalled();
  expect(res.headers['cache-control']).toBe('no-store, max-age=0');
});

test('rejects an invalid id without invoking credential access', async () => {
  const req = makeReq('not-an-id');
  const res = makeRes(req);

  await revealPayslipPassword(req, res);

  expect(res.statusCode).toBe(400);
  expect(res.body).toEqual({
    success: false,
    message: 'Invalid payslip id'
  });
  expect(revealPayslipCredentialMock).not.toHaveBeenCalled();
  expect(logAuditMock).not.toHaveBeenCalled();
  expect(res.headers['cache-control']).toBe('no-store, max-age=0');
});

test('failure responses never contain credential material', async () => {
  const req = makeReq();
  const res = makeRes(req);
  revealPayslipCredentialMock.mockRejectedValue(new Error('decrypt provider unavailable'));

  await revealPayslipPassword(req, res);

  expect(res.statusCode).toBe(500);
  expect(res.body).toEqual({
    success: false,
    message: 'Failed to reveal payslip password'
  });
  expect(res.body).not.toHaveProperty('data');
  expect(JSON.stringify(res.body)).not.toContain('PDF-only-secret');
  expect(logAuditMock).not.toHaveBeenCalled();
  expect(res.headers['cache-control']).toBe('no-store, max-age=0');
});
