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

  describe('brand-asset gate follows the same declared scan policy as the other two', () => {
    const asset = (scanStatus) => ({
      storage_key: 'uploads/u/logo.png',
      file_type: 'image/png',
      file_size: 1200,
      scan_status: scanStatus,
      is_active: true,
    });

    let previousPolicy;
    beforeEach(() => { previousPolicy = process.env.FILE_SCAN_POLICY; });
    afterEach(() => {
      if (previousPolicy === undefined) delete process.env.FILE_SCAN_POLICY;
      else process.env.FILE_SCAN_POLICY = previousPolicy;
    });

    it('accepts a not_scanned asset where the deployment declared it runs without a scanner', () => {
      // Before the shared policy this gate had its own private clean-list, so a
      // hospital with no scanner could never attach a logo or letterhead at all.
      process.env.FILE_SCAN_POLICY = 'disabled_accepted_risk';
      expect(() => assertBrandAssetMetadata('logo', asset('not_scanned'))).not.toThrow();
    });

    it('rejects a not_scanned asset where scanning is required', () => {
      process.env.FILE_SCAN_POLICY = 'required';
      expect(() => assertBrandAssetMetadata('logo', asset('not_scanned')))
        .toThrow(/must pass security scan/);
    });

    it('rejects quarantined and failed assets under BOTH policies', () => {
      for (const policy of ['required', 'disabled_accepted_risk']) {
        process.env.FILE_SCAN_POLICY = policy;
        expect(() => assertBrandAssetMetadata('logo', asset('quarantined')))
          .toThrow(/must pass security scan/);
        expect(() => assertBrandAssetMetadata('logo', asset('failed')))
          .toThrow(/must pass security scan/);
      }
    });
  });
});

