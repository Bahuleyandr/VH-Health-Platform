import { jest } from '@jest/globals';

const fileMetadataFindFirstMock = jest.fn();
const getTenantByIdMock = jest.fn();
const updateTenantMock = jest.fn();
const getSignedFileUrlMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { file_metadata: { findFirst: fileMetadataFindFirstMock } },
}));

jest.unstable_mockModule('../../utils/r2Storage.js', () => ({
  getSignedFileUrl: getSignedFileUrlMock,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  getTenantById: getTenantByIdMock,
  updateTenant: updateTenantMock,
}));

const {
  getTenantBrandKit,
  updateTenantBrandKit,
} = await import('../../services/tenant/brandKitService.js');

const TENANT_ID = '55555555-5555-4555-8555-555555555555';

describe('brandKitService', () => {
  beforeEach(() => {
    fileMetadataFindFirstMock.mockReset();
    getTenantByIdMock.mockReset();
    updateTenantMock.mockReset();
    getSignedFileUrlMock.mockReset();
  });

  it('falls back to tenant name and stamped mobile branding when no kit is configured', async () => {
    getTenantByIdMock.mockResolvedValue({ id: TENANT_ID, name: 'Default Hospital', settings: {} });

    const kit = await getTenantBrandKit(TENANT_ID);

    expect(kit).toMatchObject({
      name: 'Default Hospital',
      logoUrl: null,
      supportEmail: null,
      fallbacks: {
        name: true,
        logo: true,
        supportEmail: true,
      },
      mobile: {
        identityMode: 'stamped_build',
        tokenColorSource: 'VH_TENANT_PRIMARY',
      },
    });
  });

  it('requires clean file_metadata before storing uploaded logo assets', async () => {
    getTenantByIdMock.mockResolvedValue({
      id: TENANT_ID,
      name: 'Acme',
      settings: { branding: {} },
    });
    fileMetadataFindFirstMock.mockResolvedValueOnce({
      storage_key: 'uploads/admin/logo.png',
      file_type: 'image/png',
      file_size: 1000,
      scan_status: 'PENDING',
      is_active: true,
    });

    await expect(updateTenantBrandKit(TENANT_ID, {
      assets: { logo: { storageKey: 'uploads/admin/logo.png' } },
    })).rejects.toThrow(/must pass security scan/);

    expect(updateTenantMock).not.toHaveBeenCalled();
  });

  it('stores validated asset metadata and resolves signed runtime URLs', async () => {
    getTenantByIdMock.mockResolvedValue({
      id: TENANT_ID,
      name: 'Acme',
      settings: { branding: {} },
    });
    updateTenantMock.mockResolvedValue({
      id: TENANT_ID,
      name: 'Acme',
      settings: {
        branding: {
          name: 'Acme Care',
          assets: { logo: { storageKey: 'uploads/admin/logo.png' } },
        },
      },
    });
    fileMetadataFindFirstMock
      .mockResolvedValueOnce({
        storage_key: 'uploads/admin/logo.png',
        file_type: 'image/png',
        file_size: 1000,
        scan_status: 'clean',
        is_active: true,
      })
      .mockResolvedValueOnce({
        storage_key: 'uploads/admin/logo.png',
        file_type: 'image/png',
        file_size: 1000,
        scan_status: 'clean',
        is_active: true,
      });
    getSignedFileUrlMock.mockResolvedValueOnce('https://signed.example/logo.png');

    const kit = await updateTenantBrandKit(TENANT_ID, {
      name: 'Acme Care',
      assets: { logo: { storageKey: 'uploads/admin/logo.png' } },
    });

    expect(updateTenantMock.mock.calls[0][1].settings.branding.assets.logo).toMatchObject({
      storageKey: 'uploads/admin/logo.png',
      mimeType: 'image/png',
      fileSize: 1000,
    });
    expect(kit.logoUrl).toBe('https://signed.example/logo.png');
  });
});
