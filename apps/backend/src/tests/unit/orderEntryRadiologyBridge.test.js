// Unit tests: staff CPOE → radiology worklist bridge (PR #875 follow-up).
//
// Locks the Phase-0 validation boundary of createOrder's radiology gate — the
// pure modality/field/contrast-intent derivation, the fail-closed modality
// requirement, and the fail-closed contrast screen — without a database.
// prisma is a recursive throwing proxy (emergencyIcuContinuation precedent):
// the allergy stores are therefore unreachable, which is EXACTLY the
// degraded/failed screen condition the gate must fail closed on
// (CONTRAST_ALLERGY_SCREEN_INCOMPLETE → 409 unless overridden). Reaching the
// proxy's "prisma must not be reached" error proves the gate PASSED and the
// flow moved on to the DB write phase.

import { jest } from '@jest/globals';

function makeStub() {
  const fn = async () => {
    throw new Error('prisma must not be reached in validation-boundary tests');
  };
  return new Proxy(fn, {
    get: (_t, prop) => (prop === 'then' ? undefined : makeStub()),
  });
}
const prismaStub = makeStub();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaStub,
  isTenantTransactionClient: () => true,
  prisma: prismaStub,
  prismaReadOnly: prismaStub,
  setTenant: jest.fn(),
  circuitBreakerStatus: jest.fn(() => ({})),
  setTenantTx: async (_tenantId, fn) => fn(prismaStub),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(prismaStub),
  pickTenantClient: () => prismaStub,
}));

const {
  createOrder,
  deriveCpoeContrastIntent,
  resolveRadiologyModality,
  resolveRadiologyOrderFields,
} = await import('../../services/emr/orderEntryService.js');

const PATIENT = '7b3a1111-2222-4333-8444-555566667777';

describe('resolveRadiologyModality', () => {
  it('honours explicit modality fields, alias-normalised', () => {
    expect(resolveRadiologyModality({ modality: 'ct' })).toBe('ct');
    expect(resolveRadiologyModality({ modality: 'X-Ray' })).toBe('xray');
    expect(resolveRadiologyModality({ modality: 'USG' })).toBe('ultrasound');
    expect(resolveRadiologyModality({ modality: 'fluoro' })).toBe('fluoroscopy');
    expect(resolveRadiologyModality({ modality: 'MR' })).toBe('mri');
    expect(resolveRadiologyModality({ modality: 'mammo' })).toBe('mammography');
  });

  it('derives the modality from real client test names (staff CPOE composer / order sets)', () => {
    expect(resolveRadiologyModality({ test_name: 'CT abdomen/pelvis with contrast' })).toBe('ct');
    expect(resolveRadiologyModality({ test_name: 'CT_HEAD' })).toBe('ct');
    expect(resolveRadiologyModality({ test_name: 'HRCT Chest' })).toBe('ct');
    expect(resolveRadiologyModality({ test_name: 'MRI Brain with contrast' })).toBe('mri');
    expect(resolveRadiologyModality({ test_name: 'MRCP' })).toBe('mri');
    expect(resolveRadiologyModality({ test_name: 'X-Ray Chest PA' })).toBe('xray');
    expect(resolveRadiologyModality({ test_name: 'CXR portable' })).toBe('xray');
    expect(resolveRadiologyModality({ study: 'Chest X-ray PA' })).toBe('xray');
    expect(resolveRadiologyModality({ test_name: 'USG Abdomen' })).toBe('ultrasound');
    expect(resolveRadiologyModality({ test_name: 'Doppler carotid' })).toBe('ultrasound');
    expect(resolveRadiologyModality({ test_name: 'Barium swallow' })).toBe('fluoroscopy');
    expect(resolveRadiologyModality({ test_name: 'Bilateral mammogram' })).toBe('mammography');
  });

  it('prefers the specific modality over generic x-ray tokens ("CT Chest" is never a chest film)', () => {
    expect(resolveRadiologyModality({ test_name: 'CT Chest (chest film follow-up)' })).toBe('ct');
  });

  it('returns null when nothing resolves', () => {
    expect(resolveRadiologyModality({ test_name: 'radiology' })).toBeNull();
    expect(resolveRadiologyModality({})).toBeNull();
  });
});

describe('resolveRadiologyOrderFields', () => {
  it('maps explicit fields through and falls back to the test name', () => {
    const fields = resolveRadiologyOrderFields(
      { test_name: 'CT Brain plain', body_part: 'brain', reason: 'head injury' },
      { notes: 'from ER' },
    );
    expect(fields).toEqual({
      modality: 'ct', bodyPart: 'brain', clinicalIndication: 'head injury', testName: 'CT Brain plain',
    });
  });

  it('falls back bodyPart/clinicalIndication to the test name when unset', () => {
    const fields = resolveRadiologyOrderFields({ test_name: 'CT abdomen/pelvis with contrast' });
    expect(fields.bodyPart).toBe('CT abdomen/pelvis with contrast');
    expect(fields.clinicalIndication).toBe('CT abdomen/pelvis with contrast');
  });
});

describe('deriveCpoeContrastIntent (parseContrastIntent parity)', () => {
  it('presumes contrast for CT/MRI/fluoroscopy when omitted', () => {
    for (const modality of ['ct', 'mri', 'fluoroscopy']) {
      expect(deriveCpoeContrastIntent({}, modality)).toEqual({
        contrastPlanned: true, contrastAgent: null, intentSource: 'modality_presumed',
      });
    }
  });

  it('does not presume contrast for plain films / USG / mammo', () => {
    for (const modality of ['xray', 'ultrasound', 'mammography']) {
      expect(deriveCpoeContrastIntent({}, modality)).toEqual({
        contrastPlanned: false, contrastAgent: null, intentSource: 'modality_not_presumed',
      });
    }
  });

  it('explicit negation wins over the presumption', () => {
    expect(deriveCpoeContrastIntent({ contrast_planned: false }, 'ct')).toEqual({
      contrastPlanned: false, contrastAgent: null, intentSource: 'explicitly_negated',
    });
  });

  it('a named agent implies contrast on any modality', () => {
    expect(deriveCpoeContrastIntent({ contrast_agent: 'iohexol 350' }, 'xray')).toEqual({
      contrastPlanned: true, contrastAgent: 'iohexol 350', intentSource: 'agent_named',
    });
  });

  it('agent + explicit false is a 400 contradiction', () => {
    let err;
    try {
      deriveCpoeContrastIntent({ contrast_planned: false, contrast_agent: 'iohexol' }, 'ct');
    } catch (e) { err = e; }
    expect(err).toMatchObject({ statusCode: 400, code: 'RADIOLOGY_CONTRAST_INTENT_CONTRADICTION' });
  });
});

describe('createOrder — radiology gate (Phase 0, fail-closed)', () => {
  it('rejects a radiology order whose modality cannot be resolved (400, before any DB write)', async () => {
    await expect(createOrder({
      order_type: 'radiology', patient_uid: PATIENT,
      details: { test_name: 'radiology' }, ordered_by: 'd',
    })).rejects.toMatchObject({ statusCode: 400, code: 'RADIOLOGY_ORDER_MODALITY_REQUIRED' });
  });

  it('accepts the imaging alias and applies the same gate', async () => {
    await expect(createOrder({
      order_type: 'imaging', patient_uid: PATIENT,
      details: { description: 'no modality anywhere' }, ordered_by: 'd',
    })).rejects.toMatchObject({ code: 'RADIOLOGY_ORDER_MODALITY_REQUIRED' });
  });

  it('fails CLOSED when the allergy stores are unreachable on a contrast-presumed order (409)', async () => {
    // The prisma stub makes every allergy source fail → screen status
    // 'failed' → CONTRAST_ALLERGY_SCREEN_INCOMPLETE blocker → 409 without an
    // acknowledged override. "We could not check" must never order contrast.
    await expect(createOrder({
      order_type: 'radiology', patient_uid: PATIENT,
      details: { test_name: 'CT Brain plain' }, ordered_by: 'd',
    })).rejects.toMatchObject({ statusCode: 409, code: 'RADIOLOGY_CONTRAST_ALLERGY_BLOCKED' });
  });

  it('lets an acknowledged override through the failed screen and proceeds to the write phase', async () => {
    await expect(createOrder({
      order_type: 'radiology', patient_uid: PATIENT,
      details: {
        test_name: 'CT Brain plain',
        contrast_override_reason: 'Allergy record verified manually on paper chart',
      },
      ordered_by: 'd',
    })).rejects.toThrow(/prisma must not be reached/);
  });

  it('explicit contrast negation skips the screen entirely and proceeds to the write phase', async () => {
    await expect(createOrder({
      order_type: 'radiology', patient_uid: PATIENT,
      details: { test_name: 'CT Brain plain', contrast_planned: false }, ordered_by: 'd',
    })).rejects.toThrow(/prisma must not be reached/);
  });

  it('a plain film is not contrast-presumed and proceeds to the write phase unscreened', async () => {
    await expect(createOrder({
      order_type: 'radiology', patient_uid: PATIENT,
      details: { test_name: 'X-Ray Chest PA' }, ordered_by: 'd',
    })).rejects.toThrow(/prisma must not be reached/);
  });
});
