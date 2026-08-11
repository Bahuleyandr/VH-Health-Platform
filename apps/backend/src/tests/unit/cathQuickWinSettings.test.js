import { jest } from '@jest/globals';

const getTenantByIdMock = jest.fn();

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  default: {},
  DEFAULT_TENANT_ID: '00000000-0000-4000-8000-000000000001',
  getTenantById: getTenantByIdMock,
  requireTenantId: (value) => value,
}));

const { getCathQuickWinSettings, CATH_QUICK_WIN_SLOTS } = await import(
  '../../services/tenant/tenantSettingsService.js'
);

const TENANT = '00000000-0000-4000-8000-000000000001';

function tenantWith(settings) {
  return { id: TENANT, slug: 'default', settings };
}

beforeEach(() => {
  getTenantByIdMock.mockReset();
});

describe('getCathQuickWinSettings', () => {
  it('exposes both workbench slots', () => {
    expect(CATH_QUICK_WIN_SLOTS).toEqual(['pre_cath', 'post_cath']);
  });

  it('fails closed to the inert default when unset', async () => {
    getTenantByIdMock.mockResolvedValue(tenantWith({}));
    const settings = await getCathQuickWinSettings(TENANT);
    expect(settings).toEqual({
      consentType: null,
      orderSetFamilies: { pre_cath: null, post_cath: null },
      followUpTemplates: [],
    });
  });

  it('fails closed on malformed config shapes', async () => {
    getTenantByIdMock.mockResolvedValue(tenantWith({ cathQuickWins: ['not', 'an', 'object'] }));
    const settings = await getCathQuickWinSettings(TENANT);
    expect(settings.consentType).toBeNull();
    expect(settings.orderSetFamilies).toEqual({ pre_cath: null, post_cath: null });
    expect(settings.followUpTemplates).toEqual([]);
  });

  it('propagates tenant lookup faults instead of fabricating inert settings', async () => {
    const lookupError = new Error('db down');
    getTenantByIdMock.mockRejectedValue(lookupError);

    await expect(getCathQuickWinSettings(TENANT)).rejects.toBe(lookupError);
  });

  it('parses owner-mapped consent type and order-set families', async () => {
    getTenantByIdMock.mockResolvedValue(tenantWith({
      cathQuickWins: {
        consent: { consentType: '  cath_procedure  ' },
        orderSets: { preCathFamilyKey: 'CATH-PRE', postCathFamilyKey: 'CATH-POST' },
      },
    }));
    const settings = await getCathQuickWinSettings(TENANT);
    expect(settings.consentType).toBe('cath_procedure');
    expect(settings.orderSetFamilies).toEqual({ pre_cath: 'CATH-PRE', post_cath: 'CATH-POST' });
  });

  it('keeps unmapped slots null when only one family is published', async () => {
    getTenantByIdMock.mockResolvedValue(tenantWith({
      cathQuickWins: { orderSets: { preCathFamilyKey: 'CATH-PRE' } },
    }));
    const settings = await getCathQuickWinSettings(TENANT);
    expect(settings.orderSetFamilies).toEqual({ pre_cath: 'CATH-PRE', post_cath: null });
  });

  it('drops follow-up templates missing key, title, or procedure types', async () => {
    getTenantByIdMock.mockResolvedValue(tenantWith({
      cathQuickWins: {
        followUp: {
          templates: [
            { title: 'No key', procedureTypes: ['PCI'] },
            { templateKey: 'no_title', procedureTypes: ['PCI'] },
            { templateKey: 'no_types', title: 'No procedure types' },
            { templateKey: 'empty_types', title: 'Empty list', procedureTypes: [] },
            { templateKey: 'disabled', title: 'Disabled', procedureTypes: ['PCI'], enabled: false },
            { templateKey: 'valid', title: 'Post-PCI review', procedureTypes: ['PCI'] },
          ],
        },
      },
    }));
    const settings = await getCathQuickWinSettings(TENANT);
    expect(settings.followUpTemplates).toHaveLength(1);
    expect(settings.followUpTemplates[0].templateKey).toBe('valid');
  });

  it('normalizes template fields: lowercased types, clamped offset, role default, dedup', async () => {
    getTenantByIdMock.mockResolvedValue(tenantWith({
      cathQuickWins: {
        followUp: {
          templates: [
            {
              templateKey: 'post_pci_review',
              title: 'Post-PCI review',
              description: 'Owner-authored review instructions',
              procedureTypes: [' PCI ', 'Primary PCI'],
              offsetDays: 3,
              staffTaskRole: 'CARDIOLOGIST',
            },
            {
              templateKey: 'post_pci_review',
              title: 'Duplicate key must not double-trigger',
              procedureTypes: ['PCI'],
            },
            {
              templateKey: 'dapt_review',
              title: 'DAPT review',
              procedureTypes: ['PCI'],
              offsetDays: 9999,
            },
          ],
        },
      },
    }));
    const settings = await getCathQuickWinSettings(TENANT);
    expect(settings.followUpTemplates).toHaveLength(2);
    const [first, second] = settings.followUpTemplates;
    expect(first.procedureTypes).toEqual(['pci', 'primary pci']);
    expect(first.offsetDays).toBe(3);
    expect(first.staffTaskRole).toBe('CARDIOLOGIST');
    expect(first.description).toBe('Owner-authored review instructions');
    expect(second.templateKey).toBe('dapt_review');
    expect(second.offsetDays).toBe(0);
    expect(second.staffTaskRole).toBe('DOCTOR');
    expect(second.description).toBeNull();
  });
});
