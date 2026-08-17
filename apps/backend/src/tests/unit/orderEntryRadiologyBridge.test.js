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
const DOCTOR = '8c4b2222-3333-4444-8555-666677778888';

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

  it.each([
    ['CEUS liver lesion', 'ultrasound'],
    ['CEM diagnostic study', 'mammography'],
  ])('recognises the standalone contrast-study acronym in %s', (testName, modality) => {
    expect(deriveCpoeContrastIntent({ test_name: testName }, modality)).toEqual({
      contrastPlanned: true, contrastAgent: null, intentSource: 'study_text',
    });
  });

  it.each([
    'Ultrasound assessment near cement spacer',
    'Mammography placement check',
  ])('does not match a contrast acronym inside an unrelated word: %s', (testName) => {
    expect(deriveCpoeContrastIntent({ test_name: testName }, 'ultrasound')).toEqual({
      contrastPlanned: false, contrastAgent: null, intentSource: 'modality_not_presumed',
    });
  });

  it('allows explicit negation for a genuinely non-contrast CT study', () => {
    expect(deriveCpoeContrastIntent({ contrast_planned: false }, 'ct')).toEqual({
      contrastPlanned: false, contrastAgent: null, intentSource: 'explicitly_negated',
    });
  });

  it.each([
    'CECT Abdomen',
    'CT abdomen with contrast',
    'MRI brain contrast-enhanced',
  ])('rejects explicit false when the named study requires contrast: %s', (testName) => {
    expect(() => deriveCpoeContrastIntent({
      test_name: testName,
      contrast_planned: false,
    }, 'ct')).toThrow(expect.objectContaining({
      statusCode: 400,
      code: 'RADIOLOGY_CONTRAST_INTENT_CONTRADICTION',
    }));
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
      details: { test_name: 'radiology' }, ordered_by: DOCTOR,
    })).rejects.toMatchObject({ statusCode: 400, code: 'RADIOLOGY_ORDER_MODALITY_REQUIRED' });
  });

  it('accepts the imaging alias and applies the same gate', async () => {
    await expect(createOrder({
      order_type: 'imaging', patient_uid: PATIENT,
      details: { description: 'no modality anywhere' }, ordered_by: DOCTOR,
    })).rejects.toMatchObject({ code: 'RADIOLOGY_ORDER_MODALITY_REQUIRED' });
  });

  it('fails CLOSED when the allergy stores are unreachable on a contrast-presumed order (409)', async () => {
    // The prisma stub makes every allergy source fail → screen status
    // 'failed' → CONTRAST_ALLERGY_SCREEN_INCOMPLETE blocker → 409 without an
    // acknowledged override. "We could not check" must never order contrast.
    await expect(createOrder({
      order_type: 'radiology', patient_uid: PATIENT,
      details: { test_name: 'CT Brain plain' }, ordered_by: DOCTOR,
    })).rejects.toMatchObject({ statusCode: 409, code: 'RADIOLOGY_CONTRAST_ALLERGY_BLOCKED' });
  });

  it('screens the shipped Staff payload when contrast is named in details.reason', async () => {
    await expect(createOrder({
      order_type: 'radiology', patient_uid: PATIENT,
      details: {
        modality: 'ultrasound',
        test_name: 'Ultrasound liver',
        reason: 'Contrast-enhanced study to characterise lesion',
      },
      ordered_by: DOCTOR,
    })).rejects.toMatchObject({ statusCode: 409, code: 'RADIOLOGY_CONTRAST_ALLERGY_BLOCKED' });
  });

  it('screens every Staff indication field when a generic reason precedes a later contrast signal', async () => {
    await expect(createOrder({
      order_type: 'radiology', patient_uid: PATIENT,
      details: {
        modality: 'ultrasound',
        test_name: 'Ultrasound liver',
        reason: 'Characterise focal lesion',
        clinical_indication: 'Contrast-enhanced study requested by radiology',
      },
      ordered_by: DOCTOR,
    })).rejects.toMatchObject({ statusCode: 409, code: 'RADIOLOGY_CONTRAST_ALLERGY_BLOCKED' });
  });

  it('rejects explicit false when generic reason masks a later Staff contrast signal', async () => {
    await expect(createOrder({
      order_type: 'radiology', patient_uid: PATIENT,
      details: {
        modality: 'ultrasound',
        test_name: 'Ultrasound liver',
        reason: 'Characterise focal lesion',
        indication: 'CEUS requested for indeterminate lesion',
        contrast_planned: false,
      },
      notes: 'Review prior study before acquisition',
      ordered_by: DOCTOR,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'RADIOLOGY_CONTRAST_INTENT_CONTRADICTION',
    });
  });

  it('rejects explicit false when a generic reason precedes contrast in top-level notes', async () => {
    await expect(createOrder({
      order_type: 'radiology', patient_uid: PATIENT,
      details: {
        modality: 'mammography',
        test_name: 'Diagnostic mammogram',
        reason: 'Clarify asymmetry',
        contrast_planned: false,
      },
      notes: 'CEM requested after multidisciplinary review',
      ordered_by: DOCTOR,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'RADIOLOGY_CONTRAST_INTENT_CONTRADICTION',
    });
  });

  it('does not treat an unrelated use of the word contrast as a contrast study', async () => {
    await expect(createOrder({
      order_type: 'radiology', patient_uid: PATIENT,
      details: {
        modality: 'ultrasound',
        test_name: 'Ultrasound liver',
        reason: 'Compare and contrast with prior ultrasound findings',
      },
      ordered_by: DOCTOR,
    })).rejects.toThrow(/prisma must not be reached/);
  });

  it('allows explicit noncontrast when generic reason and later fields contain no study signal', async () => {
    await expect(createOrder({
      order_type: 'radiology', patient_uid: PATIENT,
      details: {
        modality: 'ultrasound',
        test_name: 'Ultrasound liver',
        reason: 'Characterise focal lesion',
        clinical_indication: 'Compare and contrast with prior ultrasound findings',
        contrast_planned: false,
      },
      notes: 'Routine follow-up imaging',
      ordered_by: DOCTOR,
    })).rejects.toThrow(/prisma must not be reached/);
  });

  it('lets an acknowledged override through the failed screen and proceeds to the write phase', async () => {
    await expect(createOrder({
      order_type: 'radiology', patient_uid: PATIENT,
      details: {
        test_name: 'CT Brain plain',
        contrast_override_reason: 'Allergy record verified manually on paper chart',
      },
      ordered_by: DOCTOR,
    })).rejects.toThrow(/prisma must not be reached/);
  });

  it('explicit contrast negation skips the screen entirely and proceeds to the write phase', async () => {
    await expect(createOrder({
      order_type: 'radiology', patient_uid: PATIENT,
      details: { test_name: 'CT Brain plain', contrast_planned: false }, ordered_by: DOCTOR,
    })).rejects.toThrow(/prisma must not be reached/);
  });

  it('rejects a CECT order whose caller tries to negate contrast explicitly', async () => {
    await expect(createOrder({
      order_type: 'radiology', patient_uid: PATIENT,
      details: { test_name: 'CECT Abdomen', contrast_planned: false }, ordered_by: DOCTOR,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'RADIOLOGY_CONTRAST_INTENT_CONTRADICTION',
    });
  });

  it.each([
    {
      label: 'details.reason',
      details: { reason: 'Contrast-enhanced study to characterise lesion' },
    },
    {
      label: 'top-level notes fallback',
      details: {},
      notes: 'Contrast-enhanced study to characterise lesion',
    },
  ])('rejects explicit false when contrast is named in $label', async ({ details, notes }) => {
    await expect(createOrder({
      order_type: 'radiology', patient_uid: PATIENT,
      details: {
        modality: 'ultrasound',
        test_name: 'Ultrasound liver',
        contrast_planned: false,
        ...details,
      },
      notes,
      ordered_by: DOCTOR,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'RADIOLOGY_CONTRAST_INTENT_CONTRADICTION',
    });
  });

  it('a plain film is not contrast-presumed and proceeds to the write phase unscreened', async () => {
    await expect(createOrder({
      order_type: 'radiology', patient_uid: PATIENT,
      details: { test_name: 'X-Ray Chest PA' }, ordered_by: DOCTOR,
    })).rejects.toThrow(/prisma must not be reached/);
  });
});
