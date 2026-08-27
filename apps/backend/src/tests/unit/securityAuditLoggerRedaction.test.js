import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const warnMock = jest.fn();
const recordSecurityEventMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { warn: warnMock },
}));

jest.unstable_mockModule('../../observability/securityEventMetrics.js', () => ({
  recordSecurityEvent: recordSecurityEventMock,
}));

const { logSecurityEvent } = await import('../../utils/securityAuditLogger.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for security audit write');
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset().mockResolvedValue({});
  warnMock.mockReset();
  recordSecurityEventMock.mockReset();
});

describe('security audit credential boundary', () => {
  it('redacts denied-request query credentials and explicitly attributes the tenant', async () => {
    const secret = 'security-row-receiver-secret';

    logSecurityEvent('PERMISSION_DENIED', {
      userId: '11111111-1111-4111-8111-111111111111',
      userRole: 'NURSING_STAFF',
      tenantId: TENANT_ID,
      path: `/api/v1/hl7-feeds/subscriptions?authHeader=${secret}&token_number=OP-17`,
      method: 'GET',
      statusCode: 403,
    });
    await waitFor(() => queryRawUnsafeMock.mock.calls.length === 1);

    const call = queryRawUnsafeMock.mock.calls[0];
    expect(call[0]).toContain(', tenant_id');
    expect(call[6]).toBe(
      '/api/v1/hl7-feeds/subscriptions?authHeader=[REDACTED]&token_number=OP-17',
    );
    expect(call[15]).toBe(TENANT_ID);
    expect(JSON.stringify(call)).not.toContain(secret);
  });

  it('keeps the same redaction and tenant attribution in the file fallback', async () => {
    const secret = 'security-file-receiver-secret';
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('scratch database unavailable'));

    logSecurityEvent('PERMISSION_DENIED', {
      tenantId: TENANT_ID,
      path: `/api/v1/hl7-feeds/subscriptions?api_key=${secret}`,
    });
    await waitFor(() => warnMock.mock.calls.some(call => call[0] === 'SECURITY_EVENT (file fallback):'));

    const fallback = warnMock.mock.calls.find(
      call => call[0] === 'SECURITY_EVENT (file fallback):',
    );
    expect(fallback[1]).toEqual(expect.objectContaining({
      tenantId: TENANT_ID,
      path: '/api/v1/hl7-feeds/subscriptions?api_key=[REDACTED]',
    }));
    expect(JSON.stringify(fallback)).not.toContain(secret);
  });
});
