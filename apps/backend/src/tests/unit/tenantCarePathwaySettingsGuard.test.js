import { jest } from '@jest/globals';

const queryRawMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawMock,
  },
}));

const {
  createTenant,
  updateTenant,
} = await import('../../services/tenant/tenantService.js');
const {
  mergeGenericTenantSettings,
} = await import('../../services/tenant/tenantSettingsMutationPolicy.js');

const TENANT_ID = '55555555-5555-4555-8555-555555555555';
const PATHWAY_KEY = 'diagnostics_order_to_action';
const RESERVED_SETTINGS = [
  ['active mode', { care_pathways: { [PATHWAY_KEY]: 'active' } }],
  ['shadow mode', { care_pathways: { [PATHWAY_KEY]: 'shadow' } }],
  ['off mode', { care_pathways: { [PATHWAY_KEY]: 'off' } }],
  ['null value', { care_pathways: null }],
  ['array value', { care_pathways: [] }],
  ['scalar value', { care_pathways: 'active' }],
  ['care-team enforcement off', { care_team_enforcement_mode: 'off' }],
  ['care-team enforcement shadow', { care_team_enforcement_mode: 'shadow' }],
  ['care-team enforcement enforce', { care_team_enforcement_mode: 'enforce' }],
  ['care-team enforcement null', { care_team_enforcement_mode: null }],
];
const INVALID_SETTINGS_ROOTS = [
  ['null', null],
  ['array', []],
  ['string', 'care_pathways'],
  ['number', 7],
  ['boolean', false],
  ['function', () => ({})],
  ['undefined', undefined],
];

describe('tenant care-pathway settings mutation boundary', () => {
  beforeEach(() => {
    queryRawMock.mockReset();
  });

  it.each(RESERVED_SETTINGS)(
    'rejects generic tenant creation with reserved %s before any database write',
    async (_label, settings) => {
      await expect(createTenant({
        slug: 'reserved-settings-attempt',
        name: 'Reserved Settings Attempt',
        settings,
      })).rejects.toMatchObject({
        statusCode: 403,
        code: 'TENANT_SETTINGS_RESERVED',
      });

      expect(queryRawMock).not.toHaveBeenCalled();
    },
  );

  it.each(RESERVED_SETTINGS)(
    'rejects generic tenant update with reserved %s before any database write',
    async (_label, settings) => {
      await expect(updateTenant(TENANT_ID, { settings })).rejects.toMatchObject({
        statusCode: 403,
        code: 'TENANT_SETTINGS_RESERVED',
      });

      expect(queryRawMock).not.toHaveBeenCalled();
    },
  );

  it('rejects a reserved accessor without evaluating attacker-controlled code', async () => {
    const getter = jest.fn(() => ({ [PATHWAY_KEY]: 'active' }));
    const settings = { branding: { name: 'Hospital' } };
    Object.defineProperty(settings, 'care_pathways', {
      configurable: true,
      enumerable: true,
      get: getter,
    });

    await expect(updateTenant(TENANT_ID, { settings })).rejects.toMatchObject({
      code: 'TENANT_SETTINGS_RESERVED',
    });
    expect(getter).not.toHaveBeenCalled();
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it.each(INVALID_SETTINGS_ROOTS)(
    'rejects a non-object settings %s on update before it can erase the reserved subtree',
    async (
      _label,
      settings,
    ) => {
      await expect(updateTenant(TENANT_ID, { settings })).rejects.toMatchObject({
        statusCode: 400,
        code: 'TENANT_SETTINGS_INVALID',
      });
      expect(queryRawMock).not.toHaveBeenCalled();
    },
  );

  it.each(INVALID_SETTINGS_ROOTS)(
    'rejects a non-object settings %s on create before any database write',
    async (
      _label,
      settings,
    ) => {
      await expect(createTenant({
        slug: 'invalid-settings-attempt',
        name: 'Invalid Settings Attempt',
        settings,
      })).rejects.toMatchObject({
        statusCode: 400,
        code: 'TENANT_SETTINGS_INVALID',
      });
      expect(queryRawMock).not.toHaveBeenCalled();
    },
  );

  it('rejects a serialization hook that tries to introduce the reserved key', async () => {
    const settings = {
      branding: { name: 'Hospital' },
      toJSON: () => ({ care_pathways: { [PATHWAY_KEY]: 'active' } }),
    };

    await expect(updateTenant(TENANT_ID, { settings })).rejects.toMatchObject({
      code: 'TENANT_SETTINGS_RESERVED',
    });
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it('removes a DB-loaded reserved key before an unrelated settings merge', () => {
    expect(mergeGenericTenantSettings(
      {
        branding: { name: 'Before' },
        care_pathways: { [PATHWAY_KEY]: 'active' },
        care_team_enforcement_mode: 'enforce',
      },
      { branding: { name: 'After' } },
    )).toEqual({
      branding: { name: 'After' },
    });
  });

  it('creates every new tenant with an explicit shadow posture', async () => {
    queryRawMock.mockResolvedValueOnce([{
      id: TENANT_ID,
      settings: {
        branding: { name: 'Hospital' },
        care_team_enforcement_mode: 'shadow',
      },
    }]);

    await createTenant({
      slug: 'explicit-shadow',
      name: 'Explicit Shadow',
      settings: { branding: { name: 'Hospital' } },
    });

    const [, , , , , serializedSettings] = queryRawMock.mock.calls[0];
    expect(JSON.parse(serializedSettings)).toEqual({
      branding: { name: 'Hospital' },
      care_team_enforcement_mode: 'shadow',
    });
  });

  it('uses one atomic update that overlays the exact stored reserved value', async () => {
    queryRawMock.mockResolvedValueOnce([{
      id: TENANT_ID,
      settings: {
        branding: { name: 'Updated Hospital' },
        care_pathways: { [PATHWAY_KEY]: 'shadow' },
      },
    }]);

    await updateTenant(TENANT_ID, {
      settings: { branding: { name: 'Updated Hospital' } },
    });

    expect(queryRawMock).toHaveBeenCalledTimes(1);
    const [sql, serializedSettings, tenantId] = queryRawMock.mock.calls[0];
    expect(sql).toContain("jsonb_typeof(settings) = 'object'");
    expect(sql).toContain("settings ? 'care_pathways'");
    expect(sql).toContain("settings -> 'care_pathways'");
    expect(sql).toContain("settings ? 'care_team_enforcement_mode'");
    expect(sql).toContain("settings -> 'care_team_enforcement_mode'");
    expect(JSON.parse(serializedSettings)).toEqual({
      branding: { name: 'Updated Hospital' },
    });
    expect(tenantId).toBe(TENANT_ID);
  });
});
