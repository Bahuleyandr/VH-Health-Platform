// WP2 — coding_enforcement shape on tenant terminology settings
// (migration 720 JSONB column, shaped/validated app-side).

import { jest } from '@jest/globals';

const queryRawMock = jest.fn();
const executeRawMock = jest.fn(async () => 1);

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawMock, $executeRawUnsafe: executeRawMock },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  getTenantTerminologySettings,
  setTenantTerminologySettings,
  clearTerminologySettingsCache,
  normalizeCodingEnforcementLevel,
  CODING_ENFORCEMENT_SURFACES,
  CODING_ENFORCEMENT_LEVELS,
  DEFAULT_TERMINOLOGY_SETTINGS,
} = await import('../../services/terminology/terminologySettingsService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

function settingsRow(overrides = {}) {
  return {
    tenant_id: TENANT,
    preferred_diagnosis_system: 'ICD11',
    enabled_systems: ['ICD10', 'ICD11'],
    snomed_pickers_enabled: false,
    coding_enforcement: {},
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  clearTerminologySettingsCache();
});

describe('coding enforcement constants + level normalization', () => {
  test('surface list matches migration 720 CHECK additions', () => {
    expect(CODING_ENFORCEMENT_SURFACES).toEqual([
      'death_certificate',
      'insurance_preauth',
      'insurance_claim',
      'discharge_summary',
    ]);
    expect(CODING_ENFORCEMENT_LEVELS).toEqual(['off', 'warn', 'block']);
  });

  test('normalizeCodingEnforcementLevel defaults to off on anything unknown', () => {
    expect(normalizeCodingEnforcementLevel('block')).toBe('block');
    expect(normalizeCodingEnforcementLevel(' WARN ')).toBe('warn');
    expect(normalizeCodingEnforcementLevel('banana')).toBe('off');
    expect(normalizeCodingEnforcementLevel(null)).toBe('off');
    expect(normalizeCodingEnforcementLevel(undefined)).toBe('off');
  });

  test('defaults carry an empty coding_enforcement map', () => {
    expect(DEFAULT_TERMINOLOGY_SETTINGS.coding_enforcement).toEqual({});
  });
});

describe('getTenantTerminologySettings coding_enforcement shaping', () => {
  test('no row => default {} (every surface off)', async () => {
    queryRawMock.mockResolvedValueOnce([]);
    const settings = await getTenantTerminologySettings(TENANT);
    expect(settings.coding_enforcement).toEqual({});
  });

  test('unknown surfaces and levels are dropped; off entries elided', async () => {
    queryRawMock.mockResolvedValueOnce([settingsRow({
      coding_enforcement: {
        death_certificate: 'block',
        insurance_claim: 'WARN',
        discharge_summary: 'off',
        radiology_report: 'block',
        insurance_preauth: 'banana',
      },
    })]);
    const settings = await getTenantTerminologySettings(TENANT);
    expect(settings.coding_enforcement).toEqual({
      death_certificate: 'block',
      insurance_claim: 'warn',
    });
  });

  test('DB failure fails open to defaults (feature dormant)', async () => {
    queryRawMock.mockRejectedValueOnce(new Error('db down'));
    const settings = await getTenantTerminologySettings(TENANT);
    expect(settings.coding_enforcement).toEqual({});
    expect(settings.is_default).toBe(true);
  });
});

describe('setTenantTerminologySettings coding_enforcement validation', () => {
  test('rejects an unknown surface', async () => {
    queryRawMock.mockResolvedValueOnce([]); // current settings read
    await expect(setTenantTerminologySettings(TENANT, {
      coding_enforcement: { radiology_report: 'block' },
    })).rejects.toMatchObject({ code: 'TERMINOLOGY_SETTINGS_BAD_CODING_SURFACE' });
  });

  test('rejects an unknown level', async () => {
    queryRawMock.mockResolvedValueOnce([]);
    await expect(setTenantTerminologySettings(TENANT, {
      coding_enforcement: { death_certificate: 'maybe' },
    })).rejects.toMatchObject({ code: 'TERMINOLOGY_SETTINGS_BAD_CODING_LEVEL' });
  });

  test('rejects a non-object payload', async () => {
    queryRawMock.mockResolvedValueOnce([]);
    await expect(setTenantTerminologySettings(TENANT, {
      coding_enforcement: ['block'],
    })).rejects.toMatchObject({ code: 'TERMINOLOGY_SETTINGS_BAD_CODING_ENFORCEMENT' });
  });

  test('persists the normalized map ($5 jsonb param) and echoes it back', async () => {
    queryRawMock
      .mockResolvedValueOnce([]) // current settings read
      .mockImplementationOnce(async (sql, ...params) => {
        expect(sql).toContain('coding_enforcement');
        // $5 == JSON payload of the normalized enforcement map
        expect(JSON.parse(params[4])).toEqual({ discharge_summary: 'warn' });
        return [settingsRow({ coding_enforcement: { discharge_summary: 'warn' } })];
      });
    const settings = await setTenantTerminologySettings(TENANT, {
      coding_enforcement: { discharge_summary: 'WARN', death_certificate: 'off' },
    });
    expect(settings.coding_enforcement).toEqual({ discharge_summary: 'warn' });
    // audit row written
    expect(executeRawMock).toHaveBeenCalledTimes(1);
    expect(executeRawMock.mock.calls[0][0]).toContain('terminology_audit_events');
  });

  test('omitting coding_enforcement keeps the current stored map', async () => {
    queryRawMock
      .mockResolvedValueOnce([settingsRow({
        coding_enforcement: { insurance_preauth: 'block' },
      })])
      .mockImplementationOnce(async (sql, ...params) => {
        expect(JSON.parse(params[4])).toEqual({ insurance_preauth: 'block' });
        return [settingsRow({ coding_enforcement: { insurance_preauth: 'block' } })];
      });
    const settings = await setTenantTerminologySettings(TENANT, {
      snomed_pickers_enabled: true,
    });
    expect(settings.coding_enforcement).toEqual({ insurance_preauth: 'block' });
  });
});
