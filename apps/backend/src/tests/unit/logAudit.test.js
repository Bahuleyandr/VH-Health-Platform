import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const infoMock = jest.fn();
const errorMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: infoMock,
    error: errorMock,
  },
}));

const { logAudit } = await import('../../utils/logAudit.js');

const ACTOR = '11111111-1111-4111-8111-111111111111';
const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryRawUnsafeMock.mockReset().mockResolvedValue({});
  infoMock.mockReset();
  errorMock.mockReset();
});

describe('logAudit', () => {
  it('enriches audit_logs rows with request, device, tenant, and resource context', async () => {
    await logAudit({
      id: 'req-front-office-1',
      tenantId: TENANT,
      user: {
        uid: ACTOR,
        role: 'RECEPTIONIST',
        deviceType: 'desktop',
      },
      headers: {
        'x-forwarded-for': '10.0.0.10',
        'user-agent': 'VH Staff Windows',
      },
    }, 'FRONT_OFFICE_APPOINTMENT_BOOKED', {
      appointment_id: 123,
      patient_id: 456,
    }, {
      resource: 'appointment',
      resourceId: 123,
    });

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
    const call = queryRawUnsafeMock.mock.calls[0];
    expect(call[0]).toContain('resource, resource_id');
    expect(call[1]).toBe(ACTOR);
    expect(call[2]).toBe('RECEPTIONIST');
    expect(call[3]).toBe('FRONT_OFFICE_APPOINTMENT_BOOKED');
    expect(call[4]).toBe('appointment');
    expect(call[5]).toBe('123');
    expect(call[6]).toBe('10.0.0.10');
    expect(call[7]).toBe('VH Staff Windows');

    const metadata = JSON.parse(call[8]);
    expect(metadata).toEqual(expect.objectContaining({
      request_id: 'req-front-office-1',
      device_type: 'desktop',
      tenant_id: TENANT,
      actor_role: 'RECEPTIONIST',
      appointment_id: 123,
      patient_id: 456,
    }));
    expect(call[9]).toBe(ACTOR);
    expect(call[10]).toBe(ACTOR);
    expect(call[11]).toBe(false);
  });

  it('does not let missing optional request fields break audit logging', async () => {
    await expect(logAudit({
      id: 'req-minimal',
      user: {
        uid: ACTOR,
        role: 'RECEPTIONIST',
      },
    }, 'FRONT_OFFICE_PATIENT_CREATED', {
      patient_uid: '22222222-2222-4222-8222-222222222222',
    }, {
      resource: 'patient',
      resourceId: '22222222-2222-4222-8222-222222222222',
    })).resolves.toBeUndefined();

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
    const call = queryRawUnsafeMock.mock.calls[0];
    expect(call[6]).toBeNull();
    expect(call[7]).toBeNull();
    const metadata = JSON.parse(call[8]);
    expect(metadata).toEqual(expect.objectContaining({
      request_id: 'req-minimal',
      device_type: null,
      tenant_id: null,
      actor_role: 'RECEPTIONIST',
    }));
  });
});
