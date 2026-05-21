// Unit tests for claimsService. Covers the input-validation gates
// (which fire before prisma is touched) and the claimed_amount
// derivation logic. The full submit/decision/payment state-machine
// is covered by the e2e Playwright suite against a seeded DB.

import prisma from '../../lib/prisma.js';
import {
  createPreauth,
  createClaim,
  extractPreauthCaps,
  FINAL_CASHLESS_REQUIRED_DOC_TYPES,
  insurerMatchesPolicyPayer,
  recordPreauthResponse,
  submitClaim,
  submitPreauth,
} from '../../services/insurance/claimsService.js';

describe('createPreauth validation', () => {
  const validBase = {
    tenantId: '00000000-0000-4000-8000-000000000001',
    policy_id: 1,
    patient_uid: '11111111-1111-4111-8111-111111111111',
    primary_diagnosis: 'Acute appendicitis',
    expected_cost: 60000,
  };

  it('rejects missing policy_id', async () => {
    await expect(
      createPreauth({ ...validBase, policy_id: undefined }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/policy_id/i),
    });
  });

  it('rejects missing patient_uid', async () => {
    await expect(
      createPreauth({ ...validBase, patient_uid: undefined }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/patient_uid/i),
    });
  });

  it('rejects missing primary_diagnosis', async () => {
    await expect(
      createPreauth({ ...validBase, primary_diagnosis: undefined }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/primary_diagnosis/i),
    });
  });

  it('rejects expected_cost <= 0', async () => {
    await expect(
      createPreauth({ ...validBase, expected_cost: 0 }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/expected_cost/i),
    });
    await expect(
      createPreauth({ ...validBase, expected_cost: -100 }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/expected_cost/i),
    });
  });
});

describe('createClaim validation + claimed_amount derivation', () => {
  const validBase = {
    tenantId: '00000000-0000-4000-8000-000000000001',
    policy_id: 1,
    patient_uid: '11111111-1111-4111-8111-111111111111',
    total_billed: 50000,
  };

  it('rejects missing policy_id', async () => {
    await expect(
      createClaim({ ...validBase, policy_id: undefined }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/policy_id/i),
    });
  });

  it('rejects missing patient_uid', async () => {
    await expect(
      createClaim({ ...validBase, patient_uid: undefined }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/patient_uid/i),
    });
  });

  it('rejects total_billed <= 0', async () => {
    await expect(
      createClaim({ ...validBase, total_billed: 0 }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/total_billed/i),
    });
  });

  it('rejects when derived claimed_amount goes <= 0 (copay + non-payable wipe out the bill)', async () => {
    await expect(
      createClaim({
        ...validBase,
        total_billed: 1000,
        patient_copay: 600,
        non_payable_amount: 400,
        // claimed_amount derived = 1000 - 600 - 400 = 0 → rejected
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/claimed_amount/i),
    });
  });

  it('rejects explicitly-zero claimed_amount', async () => {
    await expect(
      createClaim({ ...validBase, claimed_amount: 0 }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/claimed_amount/i),
    });
  });

  it('rejects claimed_amount that exceeds total_billed (cannot claim more than billed)', async () => {
    await expect(
      createClaim({ ...validBase, total_billed: 50000, claimed_amount: 60000 }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'CLAIM_AMOUNT_EXCEEDS_BILLED',
      message: expect.stringMatching(/cannot exceed total_billed/i),
    });
  });

  it('rejects when patient_copay + non_payable_amount exceed total_billed', async () => {
    await expect(
      createClaim({
        ...validBase,
        total_billed: 50000,
        claimed_amount: 1, // keep derived claim > 0 so we reach the share guard
        patient_copay: 30000,
        non_payable_amount: 25000, // 30000 + 25000 = 55000 > 50000
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'CLAIM_PATIENT_SHARE_EXCEEDS_BILLED',
      message: expect.stringMatching(/cannot exceed total_billed/i),
    });
  });

  it('rejects a final cashless claim linked to a draft invoice', async () => {
    const originalQueryRaw = prisma.$queryRawUnsafe;
    prisma.$queryRawUnsafe = async (sql) => {
      const text = String(sql);
      if (text.includes('FROM billing_invoices')) {
        return [{
          id: 12,
          status: 'DRAFT',
          total_amount: 50000,
          patient_uid: validBase.patient_uid,
          admission_id: 44,
        }];
      }
      throw new Error(`Unexpected query in draft-invoice claim test: ${text}`);
    };

    try {
      await expect(
        createClaim({
          ...validBase,
          invoice_id: 12,
          admission_id: 44,
          claim_type: 'cashless',
          stage: 'final',
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/requires an issued invoice/i),
      });
    } finally {
      prisma.$queryRawUnsafe = originalQueryRaw;
    }
  });
});

describe('submitClaim invoice state guard', () => {
  const tenantId = '00000000-0000-4000-8000-000000000001';
  const patientUid = '11111111-1111-4111-8111-111111111111';
  let originalQueryRaw;

  beforeEach(() => {
    originalQueryRaw = prisma.$queryRawUnsafe;
    prisma.$queryRawUnsafe = async (sql) => {
      const text = String(sql);
      if (text.includes('SELECT * FROM tpa_claims')) {
        return [{
          id: 9,
          status: 'prepared',
          claim_type: 'cashless',
          stage: 'final',
          invoice_id: 12,
          patient_uid: patientUid,
          admission_id: 44,
          total_billed: 65000,
        }];
      }
      if (text.includes('FROM billing_invoices')) {
        return [{
          id: 12,
          status: 'DRAFT',
          total_amount: 65000,
          patient_uid: patientUid,
          admission_id: 44,
        }];
      }
      throw new Error(`Unexpected query in submitClaim invoice-state test: ${text}`);
    };
  });

  afterEach(() => {
    prisma.$queryRawUnsafe = originalQueryRaw;
  });

  it('rejects submission when the linked final bill is still draft', async () => {
    await expect(
      submitClaim({ tenantId, id: 9, submitted_by: patientUid }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/requires an issued invoice/i),
    });
  });
});

describe('extractPreauthCaps', () => {
  // Regression for 2026-05-10-tpa-insurance-claim-billing-preauth-caps-hidden-from-detail.
  // The structured caps insurer sends back (pharmacy max, room
  // category) must surface on GET /preauth/:id, otherwise billing
  // screens cannot read them.
  it('returns null for empty / non-object input', () => {
    expect(extractPreauthCaps(null)).toBeNull();
    expect(extractPreauthCaps(undefined)).toBeNull();
    expect(extractPreauthCaps('not-an-object')).toBeNull();
    expect(extractPreauthCaps({})).toBeNull();
  });

  it('returns the nested caps object verbatim when present', () => {
    const caps = {
      pharmacy: { max_amount: 15000, currency: 'INR' },
      room_category: { max_category: 'semi_private' },
    };
    expect(extractPreauthCaps({ caps, insurer_note: 'ignored' })).toEqual(caps);
  });

  it('lifts flat pharmacy_cap / room_category fallbacks into normalized shape', () => {
    expect(extractPreauthCaps({ pharmacy_cap: 15000 })).toEqual({
      pharmacy: { max_amount: 15000, currency: 'INR' },
    });
    expect(extractPreauthCaps({ pharmacy_cap: 15000, room_category: 'semi_private' })).toEqual({
      pharmacy: { max_amount: 15000, currency: 'INR' },
      room_category: { max_category: 'semi_private' },
    });
  });

  it('prefers nested caps over flat fallbacks', () => {
    const out = extractPreauthCaps({
      caps: { pharmacy: { max_amount: 20000, currency: 'INR' } },
      pharmacy_cap: 99999,
    });
    expect(out).toEqual({ pharmacy: { max_amount: 20000, currency: 'INR' } });
  });
});

describe('FINAL_CASHLESS_REQUIRED_DOC_TYPES', () => {
  // Regression for 2026-05-10-tpa-insurance-claim-discharge-final-claim-submits-without-packet.
  // The cashless packet check must include the two non-negotiable
  // docs. Loosening to a single item re-opens the submitted-but-empty
  // bug; adding lab/imaging breaks observation-only admissions.
  it('contains discharge_summary and final_bill, nothing else', () => {
    expect([...FINAL_CASHLESS_REQUIRED_DOC_TYPES].sort()).toEqual([
      'discharge_summary', 'final_bill',
    ]);
  });
});

describe('submitPreauth standard document bundle', () => {
  const tenantId = '00000000-0000-4000-8000-000000000001';
  const submittedBy = '11111111-1111-4111-8111-111111111111';
  let originalQueryRaw;
  let originalExecuteRaw;
  let preauth;
  let insertedDocTypes;

  beforeEach(() => {
    originalQueryRaw = prisma.$queryRawUnsafe;
    originalExecuteRaw = prisma.$executeRawUnsafe;
    insertedDocTypes = [];
    preauth = {
      id: 42,
      policy_id: 7,
      patient_uid: '22222222-2222-4222-8222-222222222222',
      admission_id: 16,
      preauth_number: 'PA-TEST-0042',
      request_type: 'planned',
      parent_preauth_id: null,
      primary_diagnosis: 'Cataract',
      expected_cost: 55000,
      status: 'draft',
      query_text: null,
      submit_due_at: null,
      created_at: new Date(),
    };

    prisma.$queryRawUnsafe = async (sql, ...params) => {
      const text = String(sql);
      if (text.includes('SELECT * FROM insurance_preauth')) {
        return [{ ...preauth }];
      }
      if (text.includes('WITH RECURSIVE root')) {
        return [{ id: preauth.id }];
      }
      if (text.includes('SUM(CASE WHEN status')) {
        return [{ approved_total: 0, requested_total: preauth.expected_cost, chain_length: 1 }];
      }
      if (text.includes('FROM insurance_preauth_responses')) {
        return [];
      }
      if (text.includes('SELECT doc_type FROM tpa_claim_documents')) {
        return [];
      }
      if (text.includes("AND doc_type = 'clinical_summary'")) {
        return [];
      }
      if (text.includes('INSERT INTO tpa_claim_documents')) {
        insertedDocTypes.push(params[2]);
        return [{
          id: insertedDocTypes.length,
          claim_id: params[0],
          preauth_id: params[1],
          doc_type: params[2],
          file_name: params[3],
          file_url: params[4],
          mime_type: params[6],
        }];
      }
      if (text.includes('SELECT COUNT(*)::int AS n FROM tpa_claim_documents')) {
        return [{ n: insertedDocTypes.length }];
      }
      throw new Error(`Unexpected query in submitPreauth unit test: ${text}`);
    };

    prisma.$executeRawUnsafe = async (sql) => {
      const text = String(sql);
      if (text.includes('UPDATE insurance_preauth')) {
        preauth = { ...preauth, status: 'submitted', submitted_at: new Date() };
        return 1;
      }
      throw new Error(`Unexpected execute in submitPreauth unit test: ${text}`);
    };
  });

  afterEach(() => {
    prisma.$queryRawUnsafe = originalQueryRaw;
    prisma.$executeRawUnsafe = originalExecuteRaw;
  });

  // Regression for 2026-05-15-tpa-insurance-claim-billing-77e939fd.
  // Submitting a cashless preauth with only the admission row available
  // must still attach the three standard virtual documents.
  it('auto-attaches admission note, advice letter, and record bundle before submission', async () => {
    const result = await submitPreauth({
      tenantId,
      id: preauth.id,
      submitted_by: submittedBy,
      submission_channel: 'portal',
    });

    expect(result.status).toBe('submitted');
    expect(insertedDocTypes.sort()).toEqual([
      'admission_note',
      'advice_letter',
      'record_bundle',
    ]);
  });

  // Regression for 2026-05-15-tpa-insurance-claim-doctor-1a5941b4.
  // A consultant's enhancement note is already the clinical summary; the
  // submit flow should not demand a duplicated upload step.
  it('turns enhancement notes into a clinical summary document before submission', async () => {
    preauth = {
      ...preauth,
      request_type: 'enhancement',
      admission_id: null,
      parent_preauth_id: 41,
      notes: 'Needs seven more inpatient days for pancreatitis monitoring and insulin titration.',
    };

    const result = await submitPreauth({
      tenantId,
      id: preauth.id,
      submitted_by: submittedBy,
      submission_channel: 'portal',
    });

    expect(result.status).toBe('submitted');
    expect(insertedDocTypes).toEqual(['clinical_summary']);
  });
});

// Stage-4-C input-validation gate. Fires before getPreauth() touches the DB
// so we can exercise it as a unit test.
// Finding: 2026-05-09-tpa-insurance-claim-billing-preauth-response-500-wrong-field
describe('recordPreauthResponse boundary validation', () => {
  const base = {
    tenantId: '00000000-0000-4000-8000-000000000001',
    preauth_id: 1,
    sanctioned_amount: 50000,
  };

  it('rejects empty body with 400 listing valid response_type values', async () => {
    await expect(recordPreauthResponse({ ...base })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/response_type is required/i),
    });
  });

  it('rejects unknown response_type with 400', async () => {
    await expect(
      recordPreauthResponse({ ...base, response_type: 'maybe' }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/Invalid response_type/i),
    });
  });

  // The "alias accepted" check needs to call recordPreauthResponse
  // past its synchronous validator, which then invokes getPreauth()
  // → prisma.$queryRawUnsafe(). In this unit-test env the prisma
  // singleton has a live connection; an unstubbed call hangs the
  // suite when jest.teardown tries to disconnect.
  //
  // Why monkey-patch instead of jest.spyOn? Under Jest's ESM mode
  // (--experimental-vm-modules), spies returned by jest.spyOn don't
  // expose the convenience helpers (.mockResolvedValue, etc) the
  // way classic CommonJS Jest does — calling them throws
  // "TypeError: jest.spyOn(...).mockResolvedValue is not a
  // function". Direct property replacement is the lowest-common-
  // denominator pattern that always works, and it lines up with
  // backend CLAUDE.md's guidance ("import and stub the prisma
  // singleton directly").
  describe('alias acceptance (with prisma stub)', () => {
    let originalQueryRaw;
    let stubCallCount;
    beforeEach(() => {
      stubCallCount = 0;
      originalQueryRaw = prisma.$queryRawUnsafe;
      // Empty result → getPreauth's `if (!rows.length) throw notFound`
      // fires synchronously after the stub resolves.
      prisma.$queryRawUnsafe = async () => {
        stubCallCount += 1;
        return [];
      };
    });
    afterEach(() => {
      prisma.$queryRawUnsafe = originalQueryRaw;
    });

    const cases = [
      ['decision', 'partial'],
      ['decision', 'partial_approval'],
      ['decision', 'partially_approved'],
      ['response_type', 'approved'],
      ['response_type', 'partially_approved'],
      ['response_type', 'denied'],
      ['response_type', 'queried'],
      ['response_type', 'enhancement_request'],
    ];
    for (const [field, value] of cases) {
      it(`accepts ${field}: "${value}" past the validator (proven by reaching getPreauth)`, async () => {
        let err;
        try {
          await recordPreauthResponse({ ...base, [field]: value });
        } catch (e) {
          err = e;
        }
        expect(err).toBeDefined();
        // 404 "Pre-auth not found" from the stub proves we passed
        // the alias gate. A 400 with `response_type` complaint would
        // mean the gate rejected — that's what we're guarding against.
        expect(err.statusCode).toBe(404);
        expect(err.message).toMatch(/pre-auth not found/i);
        expect(stubCallCount).toBeGreaterThan(0);
      });
    }

    it('still rejects truly invalid alias even with prisma stubbed (gate-isolation sanity check)', async () => {
      await expect(
        recordPreauthResponse({ ...base, decision: 'banana' }),
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/Invalid response_type/i),
      });
      // Prisma must NOT have been called — the gate fires first.
      expect(stubCallCount).toBe(0);
    });
  });
});

describe('insurerMatchesPolicyPayer (preauth response payer guard)', () => {
  it('accepts display-name variants of the same payer', () => {
    expect(insurerMatchesPolicyPayer('Star Health', 'Star Health and Allied Insurance')).toBe(true);
    expect(insurerMatchesPolicyPayer('STAR HEALTH', 'star-health')).toBe(true);
  });

  it('rejects a genuinely different insurer', () => {
    expect(insurerMatchesPolicyPayer('New India Assurance', 'Star Health and Allied Insurance')).toBe(false);
  });

  it('is permissive when either side is empty (nothing to compare)', () => {
    expect(insurerMatchesPolicyPayer('', 'Star Health')).toBe(true);
    expect(insurerMatchesPolicyPayer('New India Assurance', '')).toBe(true);
    expect(insurerMatchesPolicyPayer(null, null)).toBe(true);
  });
});
