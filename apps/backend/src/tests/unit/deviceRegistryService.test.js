import { jest } from '@jest/globals';

const queryRawMock = jest.fn();
const executeRawMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawMock,
    $executeRawUnsafe: executeRawMock,
  },
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => {
    if (!tenantId) throw new Error('tenant required');
    return tenantId;
  },
}));

const {
  __testing__,
  authenticateDeviceCredential,
  resolveDeviceBySourceIp,
} = await import('../../services/devices/deviceRegistryService.js');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

describe('deviceRegistryService credential and source-IP auth', () => {
  beforeEach(() => {
    queryRawMock.mockReset();
    executeRawMock.mockReset();
    executeRawMock.mockResolvedValue(1);
  });

  it('hashes device credentials with the prefixed sha256 contract', () => {
    const hash = __testing__.hashDeviceCredential('plain-device-secret');

    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hash).toBe(__testing__.hashDeviceCredential('plain-device-secret'));
    expect(hash).not.toBe(__testing__.hashDeviceCredential('other-secret'));
    expect(__testing__.timingSafeEqualString(hash, hash)).toBe(true);
    expect(__testing__.timingSafeEqualString(hash, `${hash}00`)).toBe(false);
  });

  it('returns a device for a valid credential and allowed source IP without leaking the hash', async () => {
    queryRawMock.mockResolvedValueOnce([{
      id: 12,
      tenant_id: TENANT_ID,
      device_code: 'MON-1',
      credential_hash: __testing__.hashDeviceCredential('secret-1'),
      allowed_source_ips: ['10.1.2.3'],
    }]);

    const device = await authenticateDeviceCredential({
      tenantId: TENANT_ID,
      plaintext: 'secret-1',
      sourceIp: '10.1.2.3',
      deviceCode: 'MON-1',
    });

    expect(device).toMatchObject({ id: 12, device_code: 'MON-1' });
    expect(device.credential_hash).toBeUndefined();
    expect(executeRawMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE device_registry'),
      TENANT_ID,
      12,
    );
    expect(queryRawMock.mock.calls[0][0]).toContain("status = 'active'");
  });

  it('refuses a valid token from an unlisted source IP', async () => {
    queryRawMock.mockResolvedValueOnce([{
      id: 12,
      tenant_id: TENANT_ID,
      device_code: 'MON-1',
      credential_hash: __testing__.hashDeviceCredential('secret-1'),
      allowed_source_ips: ['10.1.2.3'],
    }]);

    await expect(authenticateDeviceCredential({
      tenantId: TENANT_ID,
      plaintext: 'secret-1',
      sourceIp: '10.1.2.99',
      deviceCode: 'MON-1',
    })).resolves.toBeNull();
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it('requires device_code when a source IP matches more than one active device', async () => {
    queryRawMock.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);

    await expect(resolveDeviceBySourceIp({
      tenantId: TENANT_ID,
      sourceIp: '10.1.2.3',
    })).rejects.toMatchObject({ code: 'DEVICE_SOURCE_IP_AMBIGUOUS' });
  });
});
