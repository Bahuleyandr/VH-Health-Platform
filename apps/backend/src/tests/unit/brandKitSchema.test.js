import {
  assertBrandAssetMetadata,
  normalizeBrandKit,
} from '../../services/tenant/brandKitSchema.js';

describe('brandKitSchema', () => {
  it('normalizes runtime branding and locks mobile to stamped builds', () => {
    const kit = normalizeBrandKit({
      name: '  Acme Care  ',
      primaryColor: '#0f9',
      supportEmail: 'Support@Acme.Example',
      helpCenterUrl: 'https://help.acme.example',
      email: { fromName: 'Acme Support' },
    });

    expect(kit).toMatchObject({
      schemaVersion: 1,
      name: 'Acme Care',
      primaryColor: '#00FF99',
      supportEmail: 'support@acme.example',
      helpCenterUrl: 'https://help.acme.example/',
      email: {
        fromName: 'Acme Support',
        replyTo: 'support@acme.example',
      },
      mobile: {
        identityMode: 'stamped_build',
        tokenColorSource: 'VH_TENANT_PRIMARY',
      },
    });
  });

  it('rejects raw or unsafe asset references that did not come from validated uploads', () => {
    expect(() => normalizeBrandKit({
      assets: { logo: { storageKey: '../logo.png' } },
    })).toThrow(/validated upload storage key/);
  });

  it('allows clean tenant-owned logo metadata and rejects pending scans', () => {
    expect(() => assertBrandAssetMetadata('logo', {
      storage_key: 'uploads/u/logo.png',
      file_type: 'image/png',
      file_size: 1200,
      scan_status: 'clean',
      is_active: true,
    })).not.toThrow();

    expect(() => assertBrandAssetMetadata('logo', {
      storage_key: 'uploads/u/logo.png',
      file_type: 'image/png',
      file_size: 1200,
      scan_status: 'PENDING',
      is_active: true,
    })).toThrow(/must pass security scan/);
  });
});

