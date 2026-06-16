// Unit tests for codingValidationService.annotateCodingDraft()
//
// validateCode() real return shape (terminologyService.js:293):
//   valid   → { valid: true, mode: 'catalog', reason: null, concept: { code, display, status, ... } }
//   invalid → { valid: false, mode: 'catalog', reason: 'code_not_found', concept: null }
//   throws  → Promise rejection (DB / network error)
//
// The mock returns here mirror the REAL return shape so isValidResult()
// in the implementation sees what it would see at runtime.

import { jest } from '@jest/globals';

jest.unstable_mockModule('../../services/terminology/terminologyService.js', () => ({
  validateCode: jest.fn(),
}));

const terminology = await import('../../services/terminology/terminologyService.js');
const { annotateCodingDraft } = await import('../../services/ai/codingValidationService.js');

beforeEach(() => terminology.validateCode.mockReset());

test('valid ICD-10 code → validated:true with canonical display, no flag', async () => {
  terminology.validateCode.mockResolvedValue({
    valid: true,
    mode: 'catalog',
    reason: null,
    concept: { code: 'E11.9', display: 'Type 2 diabetes mellitus without complications', status: 'active' },
  });
  const out = await annotateCodingDraft(
    { suggested_codes: [{ code: 'E11.9', description: 'diabetes', confidence: 'medium' }] },
    { tenantId: 't1' },
  );
  expect(out.suggested_codes[0]).toMatchObject({
    system: 'ICD10',
    code: 'E11.9',
    validated: true,
    display: 'Type 2 diabetes mellitus without complications',
    confidence: 'medium',
  });
  expect(out.safety_flags).toEqual([]);
});

test('unvalidated (hallucinated) code → kept, validated:false, confidence low, UNVALIDATED_CODE flag', async () => {
  terminology.validateCode.mockResolvedValue({
    valid: false,
    mode: 'catalog',
    reason: 'code_not_found',
    concept: null,
  });
  const out = await annotateCodingDraft(
    { suggested_codes: [{ code: 'ZZ9.9', description: 'bogus' }] },
    { tenantId: 't1' },
  );
  expect(out.suggested_codes[0]).toMatchObject({ code: 'ZZ9.9', validated: false, confidence: 'low' });
  expect(out.safety_flags[0]).toMatchObject({ type: 'UNVALIDATED_CODE', severity: 'medium' });
});

test('terminology lookup throws → fail-closed (validated:false), never throws out', async () => {
  terminology.validateCode.mockRejectedValue(new Error('db down'));
  const out = await annotateCodingDraft(
    { suggested_codes: [{ code: 'I10' }] },
    { tenantId: 't1' },
  );
  expect(out.suggested_codes[0].validated).toBe(false);
  expect(out.safety_flags[0].type).toBe('UNVALIDATED_CODE');
});

test('empty / missing suggested_codes → empty result, no flags, no throw', async () => {
  const out = await annotateCodingDraft({}, { tenantId: 't1' });
  expect(out).toEqual({ suggested_codes: [], safety_flags: [] });
});

test('ICD-11 code → validated:true with canonical display, system:ICD11, no flag', async () => {
  terminology.validateCode.mockResolvedValue({
    valid: true,
    mode: 'catalog',
    reason: null,
    concept: { code: '5A11', display: 'Type 2 diabetes mellitus', status: 'active' },
  });
  const out = await annotateCodingDraft(
    { suggested_codes: [{ system: 'ICD11', code: '5A11', description: 'T2DM' }] },
    { tenantId: 't1' },
  );
  expect(out.suggested_codes[0]).toMatchObject({
    system: 'ICD11',
    code: '5A11',
    validated: true,
    display: 'Type 2 diabetes mellitus',
  });
  expect(out.safety_flags).toEqual([]);
  expect(terminology.validateCode).toHaveBeenCalledWith('ICD11', '5A11');
});

test('code with no system field (legacy) → treated as ICD10, validateCode called with ICD10', async () => {
  terminology.validateCode.mockResolvedValue({
    valid: true,
    mode: 'catalog',
    reason: null,
    concept: { code: 'I10', display: 'Essential (primary) hypertension', status: 'active' },
  });
  const out = await annotateCodingDraft(
    { suggested_codes: [{ code: 'I10', description: 'Hypertension' }] },
    { tenantId: 't1' },
  );
  expect(out.suggested_codes[0]).toMatchObject({ system: 'ICD10', code: 'I10', validated: true });
  expect(terminology.validateCode).toHaveBeenCalledWith('ICD10', 'I10');
});

test('unsupported system (CPT) → validated:false, confidence:low, validateCode NOT called', async () => {
  const out = await annotateCodingDraft(
    { suggested_codes: [{ system: 'CPT', code: '99213', description: 'Office visit' }] },
    { tenantId: 't1' },
  );
  expect(out.suggested_codes[0]).toMatchObject({ validated: false, confidence: 'low' });
  expect(terminology.validateCode).not.toHaveBeenCalled();
});
