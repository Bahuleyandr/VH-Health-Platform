import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const warnMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: warnMock,
  },
}));

const { logPhiAccess } = await import('../../utils/hipaaAudit.js');

const TENANT = '00000000-0000-4000-8000-000000000777';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const PATIENT = '22222222-2222-4222-8222-222222222222';

async function flushImmediate() {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset().mockResolvedValue({});
  warnMock.mockReset();
});

describe('logPhiAccess tenant context', () => {
  it('writes request tenant and device context into hipaa_access_log', async () => {
    logPhiAccess({
      userId: ACTOR,
      userRole: 'RECEPTIONIST',
      patientId: PATIENT,
      recordType: 'PATIENT_SEARCH',
      action: 'VIEW',
      ip: '127.0.0.1',
      requestId: 'req-front-office-phi',
      actorUid: ACTOR,
      subjectUid: ACTOR,
      actingAsDependent: false,
      deviceType: 'desktop',
      tenantId: TENANT,
    });

    await flushImmediate();

    expect(queryRawUnsafeMock).toHaveBeenCalledWith(
      expect.stringContaining('device_type, tenant_id'),
      ACTOR,
      'RECEPTIONIST',
      PATIENT,
      'PATIENT_SEARCH',
      'VIEW',
      '127.0.0.1',
      'req-front-office-phi',
      ACTOR,
      ACTOR,
      false,
      'desktop',
      TENANT,
    );
  });
});
