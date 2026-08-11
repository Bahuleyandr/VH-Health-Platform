import { jest } from '@jest/globals';

const queryRawMock = jest.fn();
const executeRawMock = jest.fn();
const setTenantTxMock = jest.fn();
const auditMock = jest.fn();

const prismaMock = {
  $queryRawUnsafe: queryRawMock,
  $executeRawUnsafe: executeRawMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: setTenantTxMock,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => tenantId || '00000000-0000-4000-8000-000000000001',
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordClinicalAuditEvent: auditMock,
}));

const {
  associateDevicePatient,
  resolveActiveAssociation,
} = await import('../../services/devices/deviceAssociationService.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const PATIENT = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';

function row({ minutesOld = 10, metadata = {} } = {}) {
  return {
    id: 7,
    tenant_id: TENANT,
    device_registry_id: 3,
    device_code: 'MON-ICU-01',
    device_name: 'ICU monitor',
    device_kind: 'monitor',
    channel: 'BED-1',
    patient_uid: PATIENT,
    bed_id: 44,
    started_at: new Date(Date.now() - minutesOld * 60 * 1000),
    started_by: null,
    start_method: 'scan',
    ended_at: null,
    ended_by: null,
    end_reason: null,
    metadata: {},
    device_metadata: metadata,
  };
}

describe('device association re-confirm TTL', () => {
  beforeEach(() => {
    queryRawMock.mockReset();
    executeRawMock.mockReset();
    setTenantTxMock.mockReset();
    auditMock.mockReset();
  });

  it('leaves active associations untouched when TTL metadata is absent', async () => {
    const active = row();
    queryRawMock.mockResolvedValueOnce([active]);

    const resolved = await resolveActiveAssociation({ tenantId: TENANT, deviceId: 3, channel: 'BED-1' });

    expect(resolved).toMatchObject({ id: 7, patient_uid: PATIENT });
    expect(resolved.device_metadata).toBeUndefined();
    expect(queryRawMock).toHaveBeenCalledTimes(1);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('expires stale associations with end_reason ttl_expired when configured', async () => {
    const active = row({ minutesOld: 35, metadata: { association_reconfirm_ttl_minutes: 30 } });
    queryRawMock
      .mockResolvedValueOnce([active])
      .mockResolvedValueOnce([{ ...active, ended_at: new Date(), end_reason: 'ttl_expired' }]);

    const resolved = await resolveActiveAssociation({ tenantId: TENANT, deviceId: 3, channel: 'BED-1' });

    expect(resolved).toBeNull();
    expect(queryRawMock.mock.calls[1][0]).toContain("end_reason = 'ttl_expired'");
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'device.association_ended',
      actorRole: 'DEVICE_ASSOCIATION_TTL',
      metadata: expect.objectContaining({ reason: 'ttl_expired', ttl_minutes: 30 }),
    }), { db: prismaMock });
  });

  it('honors explicit default-off metadata even when a nested TTL is present', async () => {
    const active = row({
      minutesOld: 120,
      metadata: {
        association_reconfirm_enabled: false,
        association_reconfirm: { ttl_minutes: 30 },
      },
    });
    queryRawMock.mockResolvedValueOnce([active]);

    const resolved = await resolveActiveAssociation({ tenantId: TENANT, deviceId: 3, channel: 'BED-1' });

    expect(resolved).toMatchObject({ id: 7, patient_uid: PATIENT });
    expect(queryRawMock).toHaveBeenCalledTimes(1);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('device association identity boundary', () => {
  beforeEach(() => {
    queryRawMock.mockReset();
    executeRawMock.mockReset();
    setTenantTxMock.mockReset();
    auditMock.mockReset();
  });

  function transactionFor({
    actorRole = 'NURSING_STAFF',
    actorActive = true,
    patientRole = 'PATIENT',
    patientActive = true,
  } = {}) {
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM users') && sql.includes('actor')) {
          return [{
            uid: ACTOR,
            role: actorRole,
            is_active: actorActive,
            status: actorActive ? 'active' : 'deactivated',
            is_deleted: false,
            deleted_at: null,
          }];
        }
        if (sql.includes('FROM device_registry')) {
          return [{
            id: 3,
            device_code: 'MON-1',
            display_name: 'Bedside monitor',
            kind: 'monitor',
          }];
        }
        if (sql.includes('FROM users')) {
          return [{
            uid: PATIENT,
            role: patientRole,
            is_active: patientActive,
            status: patientActive ? 'active' : 'deactivated',
            is_deleted: false,
            deleted_at: null,
            merged_into_uid: null,
          }];
        }
        if (sql.includes('UPDATE device_patient_associations')) return [];
        if (sql.includes('INSERT INTO device_patient_associations')) {
          return [{
            id: 8,
            tenant_id: TENANT,
            patient_uid: PATIENT,
            device_registry_id: 3,
            started_at: new Date(),
          }];
        }
        return [];
      }),
    };
    setTenantTxMock.mockImplementation(async (_tenantId, callback) => callback(tx));
    return tx;
  }

  const input = {
    patient_uid: PATIENT,
    device_code: 'MON-1',
  };

  it.each(['PATIENT', 'DEVICE_GATEWAY', 'WEBHOOK_CLIENT', 'UNKNOWN_ROLE'])(
    'rejects a live %s actor before any association mutation',
    async (actorRole) => {
      const tx = transactionFor({ actorRole });

      await expect(associateDevicePatient(input, {
        tenantId: TENANT,
        actorUid: ACTOR,
        actorRole,
      })).rejects.toMatchObject({
        statusCode: 403,
        code: 'DEVICE_ASSOCIATION_OPERATOR_FORBIDDEN',
      });

      expect(tx.$queryRawUnsafe.mock.calls.some(([sql]) =>
        sql.includes('INSERT INTO device_patient_associations'))).toBe(false);
    },
  );

  it('rejects a deactivated nursing actor before any association mutation', async () => {
    const tx = transactionFor({ actorActive: false });

    await expect(associateDevicePatient(input, {
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'NURSING_STAFF',
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'DEVICE_ASSOCIATION_OPERATOR_FORBIDDEN',
    });

    expect(tx.$queryRawUnsafe.mock.calls.some(([sql]) =>
      sql.includes('INSERT INTO device_patient_associations'))).toBe(false);
  });

  it.each([
    ['non-patient', 'NURSING_STAFF', true],
    ['inactive patient', 'PATIENT', false],
  ])('rejects a %s target before any association mutation', async (_label, patientRole, patientActive) => {
    const tx = transactionFor({ patientRole, patientActive });

    await expect(associateDevicePatient(input, {
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'NURSING_STAFF',
    })).rejects.toMatchObject({
      statusCode: 404,
      code: 'DEVICE_ASSOCIATION_PATIENT_NOT_FOUND',
    });

    expect(tx.$queryRawUnsafe.mock.calls.some(([sql]) =>
      sql.includes('INSERT INTO device_patient_associations'))).toBe(false);
  });
});
