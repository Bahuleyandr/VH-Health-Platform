// WP2 — coding enforcement gate for downstream documents (migration 720).
//
// Prisma-mocked unit matrix: env kill-switch × tenant per-surface level,
// across every enforcement surface. Pins the dark-ship invariant (both
// default off ⇒ no-op, validateCode never consulted), the min(env, tenant)
// AND semantics, warn-attaches-warnings + audit row, block ⇒ AppError 400
// TERMINOLOGY_CODE_INVALID, and the content-prerequisite rule that an
// un-imported system can warn but never block.

import { jest } from '@jest/globals';

const executeRawMock = jest.fn(async () => 1);
const validateCodeMock = jest.fn();
const getSettingsMock = jest.fn();

const SURFACES = [
  'death_certificate',
  'insurance_preauth',
  'insurance_claim',
  'discharge_summary',
];

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $executeRawUnsafe: executeRawMock },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../services/terminology/terminologyService.js', () => ({
  validateCode: validateCodeMock,
}));

jest.unstable_mockModule('../../services/terminology/terminologySettingsService.js', () => ({
  getTenantTerminologySettings: getSettingsMock,
  CODING_ENFORCEMENT_SURFACES: SURFACES,
  normalizeCodingEnforcementLevel: (value) => {
    const text = String(value ?? '').trim().toLowerCase();
    return ['off', 'warn', 'block'].includes(text) ? text : 'off';
  },
}));

const {
  envEnforcementLevel,
  resolveEnforcementLevel,
  validateDocumentCodes,
} = await import('../../services/terminology/codingEnforcementService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

function tenantSettings(codingEnforcement = {}) {
  return {
    tenant_id: TENANT,
    preferred_diagnosis_system: 'ICD11',
    enabled_systems: ['ICD10', 'ICD11'],
    snomed_pickers_enabled: false,
    coding_enforcement: codingEnforcement,
  };
}

const originalEnv = process.env.TERMINOLOGY_CODING_ENFORCEMENT;

afterAll(() => {
  if (originalEnv === undefined) delete process.env.TERMINOLOGY_CODING_ENFORCEMENT;
  else process.env.TERMINOLOGY_CODING_ENFORCEMENT = originalEnv;
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.TERMINOLOGY_CODING_ENFORCEMENT;
  getSettingsMock.mockResolvedValue(tenantSettings({}));
  validateCodeMock.mockResolvedValue({
    valid: true, mode: 'catalog', reason: null, concept: { display: 'ok' },
  });
});

describe('envEnforcementLevel', () => {
  test('defaults to off when unset, empty, or garbage', () => {
    expect(envEnforcementLevel({})).toBe('off');
    expect(envEnforcementLevel({ TERMINOLOGY_CODING_ENFORCEMENT: '' })).toBe('off');
    expect(envEnforcementLevel({ TERMINOLOGY_CODING_ENFORCEMENT: 'banana' })).toBe('off');
  });
  test('accepts warn/block case-insensitively', () => {
    expect(envEnforcementLevel({ TERMINOLOGY_CODING_ENFORCEMENT: 'warn' })).toBe('warn');
    expect(envEnforcementLevel({ TERMINOLOGY_CODING_ENFORCEMENT: 'BLOCK' })).toBe('block');
  });
});

describe('resolveEnforcementLevel — min(env, tenant) AND semantics', () => {
  const matrix = [
    // [env, tenant, expected]
    [undefined, 'block', 'off'],
    ['off', 'block', 'off'],
    ['warn', 'block', 'warn'],
    ['warn', 'warn', 'warn'],
    ['block', undefined, 'off'],
    ['block', 'off', 'off'],
    ['block', 'warn', 'warn'],
    ['block', 'block', 'block'],
  ];
  for (const surface of SURFACES) {
    for (const [env, tenant, expected] of matrix) {
      test(`${surface}: env=${env ?? 'unset'} tenant=${tenant ?? 'absent'} => ${expected}`, async () => {
        if (env === undefined) delete process.env.TERMINOLOGY_CODING_ENFORCEMENT;
        else process.env.TERMINOLOGY_CODING_ENFORCEMENT = env;
        getSettingsMock.mockResolvedValue(
          tenantSettings(tenant === undefined ? {} : { [surface]: tenant }),
        );
        await expect(resolveEnforcementLevel({ tenantId: TENANT, surface }))
          .resolves.toBe(expected);
      });
    }
  }

  test('env off short-circuits without a settings read', async () => {
    process.env.TERMINOLOGY_CODING_ENFORCEMENT = 'off';
    await resolveEnforcementLevel({ tenantId: TENANT, surface: 'death_certificate' });
    expect(getSettingsMock).not.toHaveBeenCalled();
  });

  test('unknown surface throws', async () => {
    await expect(resolveEnforcementLevel({ tenantId: TENANT, surface: 'radiology_report' }))
      .rejects.toThrow(/Unknown coding enforcement surface/);
  });
});

describe('validateDocumentCodes — off / dormant', () => {
  test('both defaults off: no-op, catalogue never consulted', async () => {
    const verdict = await validateDocumentCodes({
      tenantId: TENANT, surface: 'insurance_preauth', codes: ['NOT-A-CODE'],
    });
    expect(verdict).toEqual({ level: 'off', checked: false, valid: true, results: [], warnings: [] });
    expect(validateCodeMock).not.toHaveBeenCalled();
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  test('block level with no codes supplied is a pass (validity gate, not completeness)', async () => {
    process.env.TERMINOLOGY_CODING_ENFORCEMENT = 'block';
    getSettingsMock.mockResolvedValue(tenantSettings({ discharge_summary: 'block' }));
    const verdict = await validateDocumentCodes({
      tenantId: TENANT, surface: 'discharge_summary', codes: [null, '', '   '],
    });
    expect(verdict.checked).toBe(false);
    expect(verdict.valid).toBe(true);
    expect(validateCodeMock).not.toHaveBeenCalled();
  });
});

describe('validateDocumentCodes — warn', () => {
  beforeEach(() => {
    process.env.TERMINOLOGY_CODING_ENFORCEMENT = 'warn';
  });

  test('valid codes pass silently with results attached', async () => {
    getSettingsMock.mockResolvedValue(tenantSettings({ death_certificate: 'warn' }));
    const verdict = await validateDocumentCodes({
      tenantId: TENANT, surface: 'death_certificate', codes: ['I21.9'],
    });
    expect(verdict.level).toBe('warn');
    expect(verdict.valid).toBe(true);
    expect(verdict.warnings).toEqual([]);
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  test('invalid code attaches warnings + writes a terminology audit row, never throws', async () => {
    getSettingsMock.mockResolvedValue(tenantSettings({ insurance_claim: 'warn' }));
    validateCodeMock.mockResolvedValue({
      valid: false, mode: 'catalog', reason: 'code_not_found', concept: null,
    });
    const verdict = await validateDocumentCodes({
      tenantId: TENANT, surface: 'insurance_claim', codes: ['ZZZ.99'],
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.warnings).toHaveLength(1);
    expect(verdict.warnings[0]).toContain('ZZZ.99');
    expect(executeRawMock).toHaveBeenCalledTimes(1);
    const [sql, , action] = executeRawMock.mock.calls[0];
    expect(sql).toContain('terminology_audit_events');
    expect(action).toBe('CODING_ENFORCEMENT_WARNING');
  });

  test("a terminology lookup fault under 'warn' degrades to unchecked — it never fails the write (BC-L2)", async () => {
    getSettingsMock.mockResolvedValue(tenantSettings({ death_certificate: 'warn' }));
    validateCodeMock.mockRejectedValue(new Error('db down'));
    const verdict = await validateDocumentCodes({
      tenantId: TENANT, surface: 'death_certificate', codes: ['I21.9'],
    });
    expect(verdict.level).toBe('warn');
    expect(verdict.checked).toBe(false);
    expect(verdict.valid).toBe(true);
    expect(verdict.warnings).toHaveLength(1);
    expect(verdict.warnings[0]).toContain('validation unavailable');
  });

  test('tenant block is capped at warn by the env level', async () => {
    getSettingsMock.mockResolvedValue(tenantSettings({ insurance_preauth: 'block' }));
    validateCodeMock.mockResolvedValue({
      valid: false, mode: 'catalog', reason: 'code_not_found', concept: null,
    });
    const verdict = await validateDocumentCodes({
      tenantId: TENANT, surface: 'insurance_preauth', codes: ['BAD'],
    });
    expect(verdict.level).toBe('warn');
    expect(verdict.valid).toBe(false);
  });
});

describe('validateDocumentCodes — block', () => {
  beforeEach(() => {
    process.env.TERMINOLOGY_CODING_ENFORCEMENT = 'block';
  });

  for (const surface of SURFACES) {
    test(`${surface}: authoritative catalogue miss throws 400 TERMINOLOGY_CODE_INVALID`, async () => {
      getSettingsMock.mockResolvedValue(tenantSettings({ [surface]: 'block' }));
      validateCodeMock.mockResolvedValue({
        valid: false, mode: 'catalog', reason: 'code_not_found', concept: null,
      });
      let thrown;
      try {
        await validateDocumentCodes({ tenantId: TENANT, surface, codes: ['NOPE.1'] });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      expect(thrown.statusCode).toBe(400);
      expect(thrown.code).toBe('TERMINOLOGY_CODE_INVALID');
      expect(thrown.details.surface).toBe(surface);
      expect(thrown.details.invalid_codes).toEqual([
        { code: 'NOPE.1', reason: 'code_not_found' },
      ]);
      // Audit row recorded as blocked before the throw.
      expect(executeRawMock).toHaveBeenCalledTimes(1);
      expect(executeRawMock.mock.calls[0][2]).toBe('CODING_ENFORCEMENT_BLOCKED');
    });
  }

  test('valid codes pass under block', async () => {
    getSettingsMock.mockResolvedValue(tenantSettings({ discharge_summary: 'block' }));
    const verdict = await validateDocumentCodes({
      tenantId: TENANT, surface: 'discharge_summary', codes: ['I21.9', 'E11.9'],
    });
    expect(verdict.valid).toBe(true);
    expect(verdict.results).toHaveLength(2);
  });

  test('un-imported system can never block (content prerequisite): warns instead', async () => {
    getSettingsMock.mockResolvedValue(tenantSettings({ death_certificate: 'block' }));
    validateCodeMock.mockResolvedValue({
      valid: false, mode: 'unimported', reason: 'system_not_imported', concept: null,
    });
    const verdict = await validateDocumentCodes({
      tenantId: TENANT, surface: 'death_certificate', codes: ['I21.9'],
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.warnings).toHaveLength(1);
    expect(executeRawMock.mock.calls[0][2]).toBe('CODING_ENFORCEMENT_WARNING');
  });

  test("a partial catalogue (mode 'partial') can never block: warns instead (BC-M2)", async () => {
    getSettingsMock.mockResolvedValue(tenantSettings({ death_certificate: 'block' }));
    validateCodeMock.mockResolvedValue({
      valid: false, mode: 'partial', reason: 'catalog_import_incomplete', concept: null,
    });
    const verdict = await validateDocumentCodes({
      tenantId: TENANT, surface: 'death_certificate', codes: ['I21.9'],
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.warnings).toHaveLength(1);
    expect(executeRawMock.mock.calls[0][2]).toBe('CODING_ENFORCEMENT_WARNING');
  });

  test('a terminology lookup fault stays fail-closed under block', async () => {
    getSettingsMock.mockResolvedValue(tenantSettings({ death_certificate: 'block' }));
    validateCodeMock.mockRejectedValue(new Error('db down'));
    await expect(
      validateDocumentCodes({
        tenantId: TENANT, surface: 'death_certificate', codes: ['I21.9'],
      }),
    ).rejects.toThrow('db down');
  });

  test('mixed hard + soft failures: only authoritative misses appear in the 400 details', async () => {
    getSettingsMock.mockResolvedValue(tenantSettings({ insurance_claim: 'block' }));
    validateCodeMock.mockImplementation(async (system, code) => (
      code === 'HARD.1'
        ? { valid: false, mode: 'catalog', reason: 'code_not_found', concept: null }
        : { valid: false, mode: 'unimported', reason: 'system_not_imported', concept: null }
    ));
    let thrown;
    try {
      await validateDocumentCodes({
        tenantId: TENANT, surface: 'insurance_claim', codes: ['HARD.1', 'SOFT.2'],
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown.code).toBe('TERMINOLOGY_CODE_INVALID');
    expect(thrown.details.invalid_codes).toEqual([
      { code: 'HARD.1', reason: 'code_not_found' },
    ]);
  });

  test('codes are trimmed and de-duplicated case-insensitively before validation', async () => {
    getSettingsMock.mockResolvedValue(tenantSettings({ insurance_preauth: 'block' }));
    await validateDocumentCodes({
      tenantId: TENANT,
      surface: 'insurance_preauth',
      codes: [' I21.9 ', 'i21.9', 'I21.9'],
    });
    expect(validateCodeMock).toHaveBeenCalledTimes(1);
    expect(validateCodeMock).toHaveBeenCalledWith('ICD10', 'I21.9');
  });

  test('audit write failure never blocks the verdict (warn path)', async () => {
    process.env.TERMINOLOGY_CODING_ENFORCEMENT = 'warn';
    getSettingsMock.mockResolvedValue(tenantSettings({ insurance_claim: 'warn' }));
    validateCodeMock.mockResolvedValue({
      valid: false, mode: 'catalog', reason: 'code_not_found', concept: null,
    });
    executeRawMock.mockRejectedValueOnce(new Error('audit table on fire'));
    const verdict = await validateDocumentCodes({
      tenantId: TENANT, surface: 'insurance_claim', codes: ['BAD'],
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.warnings).toHaveLength(1);
  });
});
