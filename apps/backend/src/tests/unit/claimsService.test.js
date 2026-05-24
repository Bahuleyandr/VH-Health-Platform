// Unit tests for claimsService. Covers the input-validation gates
// (which fire before prisma is touched) and the claimed_amount
// derivation logic. The full submit/decision/payment state-machine
// is covered by the e2e Playwright suite against a seeded DB.

import prisma from '../../lib/prisma.js';
import {
  buildClaimWarnings,
  CLAIM_WARNING_CODES,
  computeCoverExceededWarning,
  computeRoomCapWarning,
  createPreauth,
  createClaim,
  detectClaimPayerMismatch,
  detectPayerFromReference,
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
      // `getPreauth` now joins insurance_policies + payers to surface
      // `payer_name` (so recordPreauthResponse's PREAUTH_INSURER_MISMATCH
      // guard actually fires). Match on the aliased `FROM insurance_preauth pre`
      // signature distinctive of the new query, and include `payer_name`
      // on the returned shape so any downstream consumer in the stub sees it.
      if (text.includes('FROM insurance_preauth pre')) {
        return [{ ...preauth, payer_name: preauth.payer_name ?? null }];
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

// D4 — final claim / settlement can post to the WRONG payer
// (finding 2026-05-20-tpa-insurance-claim-billing-df39fefb). The settlement
// path carries no structured insurer the way pre-auth does; the payer signal
// is free-text (settlement reference + claim tpa_reference_id). These pure
// helpers extract a confident payer token and decide a mismatch verdict.
describe('detectPayerFromReference (free-text settlement reference parsing)', () => {
  it('resolves a recognised leading insurer token to its canonical payer name', () => {
    // The exact reference shapes from the finding.
    expect(detectPayerFromReference('NIA-NEFT-CL-2627-00004-63000')).toBe('New India Assurance Co Ltd');
    expect(detectPayerFromReference('NIA-FINAL-CL-2627-00004')).toBe('New India Assurance Co Ltd');
    expect(detectPayerFromReference('STAR-CL-2627-00004')).toBe('Star Health and Allied Insurance');
  });

  it('handles a leading payment-routing token before the insurer (NEFT-NIA-...)', () => {
    expect(detectPayerFromReference('NEFT-NIA-CL-2627-00004')).toBe('New India Assurance Co Ltd');
    expect(detectPayerFromReference('UTR/STAR/00099')).toBe('Star Health and Allied Insurance');
  });

  it('returns null for a bare claim number with no insurer token (not confident)', () => {
    expect(detectPayerFromReference('CL-2627-00004')).toBeNull();
    expect(detectPayerFromReference('NEFT-00012345')).toBeNull();
  });

  it('returns null for an unrecognised leading token (avoid false matches)', () => {
    expect(detectPayerFromReference('ACME-123-456')).toBeNull();
    expect(detectPayerFromReference('')).toBeNull();
    expect(detectPayerFromReference(null)).toBeNull();
  });

  it('does NOT match an insurer name buried mid-string (only the leading token is consulted)', () => {
    // "STAR" appears, but not as a confident leading token — stays null so a
    // free-text note never trips the guard.
    expect(detectPayerFromReference('CL-2627-REF-STAR')).toBeNull();
  });
});

describe('detectClaimPayerMismatch (confident-mismatch decision)', () => {
  const STAR = 'Star Health and Allied Insurance';

  it('flags the df39fefb shape: NIA settlement reference on a Star Health policy', () => {
    const v = detectClaimPayerMismatch({
      policyPayerName: STAR,
      references: ['NIA-NEFT-CL-2627-00004-63000', 'NIA-FINAL-CL-2627-00004'],
    });
    expect(v).toMatchObject({
      mismatch: true,
      detectedPayer: 'New India Assurance Co Ltd',
      source: 'reference',
    });
  });

  it('treats a structured insurer as the strong signal', () => {
    expect(detectClaimPayerMismatch({
      policyPayerName: STAR, structuredInsurer: 'New India Assurance',
    })).toMatchObject({ mismatch: true, source: 'insurer' });
  });

  it('does NOT flag a reference whose insurer matches the policy payer (display-name variant)', () => {
    expect(detectClaimPayerMismatch({
      policyPayerName: STAR, references: ['STAR-NEFT-CL-2627-00004'],
    })).toEqual({ mismatch: false });
  });

  it('does NOT flag when the reference carries no recognised insurer token', () => {
    expect(detectClaimPayerMismatch({
      policyPayerName: STAR, references: ['CL-2627-00004', 'NEFT-00012345'],
    })).toEqual({ mismatch: false });
  });

  it('is permissive when the policy payer is unknown (nothing authoritative)', () => {
    // No payer master row on the policy → never block, even with an NIA ref.
    expect(detectClaimPayerMismatch({
      policyPayerName: '', references: ['NIA-NEFT-CL-2627-00004'],
    })).toEqual({ mismatch: false });
  });

  it('is permissive with no signal at all', () => {
    expect(detectClaimPayerMismatch({ policyPayerName: STAR })).toEqual({ mismatch: false });
    expect(detectClaimPayerMismatch({ policyPayerName: STAR, references: [] })).toEqual({ mismatch: false });
  });
});

// Deferred half of finding 2026-05-20-tpa-insurance-claim-billing-4600ed9c
// (+ room-cap finding -b5906e90). #154 added the HARD claimed≤billed guard;
// these advisories are NON-BLOCKING. The pure helpers are exercised here;
// the gatherer + createClaim attachment use a prisma stub.
describe('computeCoverExceededWarning (non-blocking cover advisory)', () => {
  it('returns null when there is no sanctioned cover yet (nothing approved)', () => {
    expect(computeCoverExceededWarning({ claimedAmount: 80000, sanctionedCover: 0 })).toBeNull();
    expect(computeCoverExceededWarning({ claimedAmount: 80000, sanctionedCover: null })).toBeNull();
  });

  it('returns null when the claim is within (or exactly at) the sanctioned cover', () => {
    expect(computeCoverExceededWarning({ claimedAmount: 50000, sanctionedCover: 65000 })).toBeNull();
    expect(computeCoverExceededWarning({ claimedAmount: 65000, sanctionedCover: 65000 })).toBeNull();
    // within a paisa → silent (mirrors the moneyEquals epsilon)
    expect(computeCoverExceededWarning({ claimedAmount: 65000.005, sanctionedCover: 65000 })).toBeNull();
  });

  it('warns with the exact shortfall when claimed exceeds cover (the 4600ed9c shape)', () => {
    // ₹80k final claim against a ₹65k cumulative sanctioned cover.
    const w = computeCoverExceededWarning({ claimedAmount: 80000, sanctionedCover: 65000 });
    expect(w).toMatchObject({
      code: 'CLAIM_EXCEEDS_SANCTIONED_COVER',
      sanctioned: 65000,
      claimed: 80000,
      shortfall: 15000,
    });
    expect(w.message).toMatch(/enhancement/i);
    // Copy reassures it is non-blocking (".. is not blocked").
    expect(w.message).toMatch(/not blocked/i);
  });

  it('returns null when nothing is claimed', () => {
    expect(computeCoverExceededWarning({ claimedAmount: 0, sanctionedCover: 65000 })).toBeNull();
  });
});

describe('computeRoomCapWarning (room-cap liability advisory)', () => {
  it('returns null when there is neither a cap amount nor a capped category', () => {
    expect(computeRoomCapWarning({})).toBeNull();
    expect(computeRoomCapWarning({ roomCharges: 30000 })).toBeNull();
  });

  it('returns null when room charges are within the cap amount', () => {
    expect(computeRoomCapWarning({ roomCharges: 9000, roomCapAmount: 13500 })).toBeNull();
  });

  it('flags the exact patient-payable excess when room charges exceed the cap amount', () => {
    // 3 nights private @ ₹6000 = ₹18000 vs semi-private cap ₹13500.
    const w = computeRoomCapWarning({
      roomCharges: 18000,
      roomCapAmount: 13500,
      admissionRoomCategory: 'private',
      cappedRoomCategory: 'semi_private',
    });
    expect(w).toMatchObject({
      code: 'CLAIM_ROOM_CHARGES_EXCEED_CAP',
      room_charges: 18000,
      room_cap: 13500,
      excess: 4500,
      patient_payable: 4500,
      capped_category: 'semi_private',
      admission_category: 'private',
    });
    expect(w.message).toMatch(/before final claim submission/i);
    expect(w.message).toMatch(/financial-liability consent/i);
  });

  it('flags qualitatively when only categories are known (no rupee cap)', () => {
    // Saraswati: insurer capped at semi_private, admission is private.
    const w = computeRoomCapWarning({
      admissionRoomCategory: 'private',
      cappedRoomCategory: 'semi_private',
    });
    expect(w).toMatchObject({
      code: 'CLAIM_ROOM_CHARGES_EXCEED_CAP',
      excess: null,
      patient_payable: null,
      capped_category: 'semi_private',
      admission_category: 'private',
    });
    expect(w.message).toMatch(/Capture financial-liability consent/i);
  });

  it('does not flag when the admission category is at or below the capped category', () => {
    expect(computeRoomCapWarning({
      admissionRoomCategory: 'semi_private',
      cappedRoomCategory: 'private',
    })).toBeNull();
    expect(computeRoomCapWarning({
      admissionRoomCategory: 'general',
      cappedRoomCategory: 'general',
    })).toBeNull();
  });
});

describe('buildClaimWarnings (gatherer, prisma-stubbed)', () => {
  const tenantId = '00000000-0000-4000-8000-000000000001';
  let originalQueryRaw;
  let originalExecuteRaw;
  let originalAdmissions;
  let correspondenceInserts;

  beforeEach(() => {
    originalQueryRaw = prisma.$queryRawUnsafe;
    originalExecuteRaw = prisma.$executeRawUnsafe;
    originalAdmissions = prisma.admissions;
    correspondenceInserts = [];
  });

  afterEach(() => {
    prisma.$queryRawUnsafe = originalQueryRaw;
    prisma.$executeRawUnsafe = originalExecuteRaw;
    prisma.admissions = originalAdmissions;
  });

  it('returns [] immediately for a claim with no linked preauth (no DB touched)', async () => {
    let called = 0;
    prisma.$queryRawUnsafe = async () => { called += 1; return []; };
    const out = await buildClaimWarnings({
      tenantId,
      claim: { id: 1, preauth_id: null, claimed_amount: 80000 },
    });
    expect(out).toEqual([]);
    expect(called).toBe(0);
  });

  it('surfaces the cover-exceeded warning + logs a correspondence note when asked', async () => {
    prisma.$queryRawUnsafe = async (sql, ...params) => {
      const text = String(sql);
      // chainTotalsFor: root resolution then totals aggregate.
      if (text.includes('WITH RECURSIVE root')) return [{ id: 71 }];
      if (text.includes('SUM(CASE WHEN status')) {
        return [{ approved_total: 65000, requested_total: 80000, chain_length: 2 }];
      }
      // No insurer caps recorded.
      if (text.includes('FROM insurance_preauth_responses')) return [{ raw_response: {} }];
      // Room charges (not reached without caps, but answer safely).
      if (text.includes("category = 'room_rent'")) return [{ total: 0 }];
      throw new Error(`Unexpected query in buildClaimWarnings cover test: ${text}`);
    };
    prisma.$executeRawUnsafe = async (sql, ...params) => {
      const text = String(sql);
      if (text.includes('INSERT INTO tpa_claim_correspondence')) {
        correspondenceInserts.push({ claimId: params[0], subject: params[1], body: params[2] });
        return 1;
      }
      throw new Error(`Unexpected execute in buildClaimWarnings cover test: ${text}`);
    };

    const out = await buildClaimWarnings({
      tenantId,
      claim: { id: 2, preauth_id: 71, claimed_amount: 80000, invoice_id: null, admission_id: null },
      logCorrespondence: true,
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      code: CLAIM_WARNING_CODES.EXCEEDS_SANCTIONED_COVER,
      sanctioned: 65000,
      claimed: 80000,
      shortfall: 15000,
    });
    expect(correspondenceInserts).toHaveLength(1);
    expect(correspondenceInserts[0].claimId).toBe(2);
    expect(correspondenceInserts[0].subject).toMatch(/enhancement/i);
  });

  it('does NOT log a correspondence note on a read (logCorrespondence default false)', async () => {
    prisma.$queryRawUnsafe = async (sql) => {
      const text = String(sql);
      if (text.includes('WITH RECURSIVE root')) return [{ id: 71 }];
      if (text.includes('SUM(CASE WHEN status')) {
        return [{ approved_total: 65000, requested_total: 80000, chain_length: 2 }];
      }
      if (text.includes('FROM insurance_preauth_responses')) return [{ raw_response: {} }];
      if (text.includes("category = 'room_rent'")) return [{ total: 0 }];
      throw new Error(`Unexpected query in buildClaimWarnings read test: ${text}`);
    };
    prisma.$executeRawUnsafe = async (sql) => {
      throw new Error(`No execute expected on read path: ${String(sql)}`);
    };

    const out = await buildClaimWarnings({
      tenantId,
      claim: { id: 3, preauth_id: 71, claimed_amount: 80000, invoice_id: null, admission_id: null },
    });
    expect(out).toHaveLength(1);
    expect(out[0].code).toBe(CLAIM_WARNING_CODES.EXCEEDS_SANCTIONED_COVER);
    expect(correspondenceInserts).toHaveLength(0);
  });

  it('surfaces the room-cap warning from insurer caps + billed room charges', async () => {
    prisma.$queryRawUnsafe = async (sql) => {
      const text = String(sql);
      if (text.includes('WITH RECURSIVE root')) return [{ id: 80 }];
      if (text.includes('SUM(CASE WHEN status')) {
        // Cover fully sanctioned → no cover warning, isolating the room one.
        return [{ approved_total: 80000, requested_total: 80000, chain_length: 1 }];
      }
      if (text.includes('FROM insurance_preauth_responses')) {
        return [{ raw_response: { caps: { room_category: { max_category: 'semi_private', max_amount: 13500 } } } }];
      }
      if (text.includes("category = 'room_rent'")) return [{ total: 18000 }];
      throw new Error(`Unexpected query in buildClaimWarnings room test: ${text}`);
    };
    prisma.admissions = {
      findUnique: async () => ({ room_category: 'private' }),
    };

    const out = await buildClaimWarnings({
      tenantId,
      claim: { id: 4, preauth_id: 80, claimed_amount: 80000, invoice_id: 55, admission_id: 27 },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      code: CLAIM_WARNING_CODES.ROOM_CHARGES_EXCEED_CAP,
      room_charges: 18000,
      room_cap: 13500,
      excess: 4500,
      patient_payable: 4500,
    });
  });

  it('returns [] (never throws) when the advisory queries fail', async () => {
    prisma.$queryRawUnsafe = async () => { throw new Error('db down'); };
    const out = await buildClaimWarnings({
      tenantId,
      claim: { id: 5, preauth_id: 99, claimed_amount: 80000 },
    });
    expect(out).toEqual([]);
  });
});

describe('createClaim attaches non-blocking warnings (does not reject)', () => {
  const tenantId = '00000000-0000-4000-8000-000000000001';
  const patientUid = '11111111-1111-4111-8111-111111111111';
  let originalQueryRaw;
  let originalExecuteRaw;

  beforeEach(() => {
    originalQueryRaw = prisma.$queryRawUnsafe;
    originalExecuteRaw = prisma.$executeRawUnsafe;
  });

  afterEach(() => {
    prisma.$queryRawUnsafe = originalQueryRaw;
    prisma.$executeRawUnsafe = originalExecuteRaw;
  });

  it('creates the claim AND surfaces a cover-exceeded warning when claimed exceeds cover', async () => {
    // Claim ₹80k billed/claimed against a ₹65k cumulative cover. The
    // claimed≤billed hard guard passes (80000 ≤ 80000); the advisory fires.
    prisma.$queryRawUnsafe = async (sql, ...params) => {
      const text = String(sql);
      if (text.includes('INSERT INTO tpa_claim_counter')) return [{ next_value: 7 }];
      if (text.includes('INSERT INTO tpa_claims')) {
        return [{
          id: 314,
          claim_number: 'CL-TEST-00007',
          policy_id: params[1],
          preauth_id: params[2],
          invoice_id: params[3],
          patient_uid: params[4],
          admission_id: params[5],
          claim_type: params[6],
          total_billed: params[7],
          claimed_amount: params[10],
          status: 'prepared',
        }];
      }
      // buildClaimWarnings queries:
      if (text.includes('WITH RECURSIVE root')) return [{ id: 90 }];
      if (text.includes('SUM(CASE WHEN status')) {
        return [{ approved_total: 65000, requested_total: 80000, chain_length: 2 }];
      }
      if (text.includes('FROM insurance_preauth_responses')) return [{ raw_response: {} }];
      if (text.includes("category = 'room_rent'")) return [{ total: 0 }];
      throw new Error(`Unexpected query in createClaim warning test: ${text}`);
    };
    prisma.$executeRawUnsafe = async (sql) => {
      const text = String(sql);
      if (text.includes('INSERT INTO tpa_claim_correspondence')) return 1;
      throw new Error(`Unexpected execute in createClaim warning test: ${text}`);
    };

    const claim = await createClaim({
      tenantId,
      policy_id: 1,
      preauth_id: 90,
      patient_uid: patientUid,
      total_billed: 80000,
      claimed_amount: 80000,
    });

    // Claim was created (not rejected) AND carries the advisory.
    expect(claim.id).toBe(314);
    expect(Number(claim.claimed_amount)).toBe(80000);
    expect(Array.isArray(claim.warnings)).toBe(true);
    expect(claim.warnings).toHaveLength(1);
    expect(claim.warnings[0]).toMatchObject({
      code: 'CLAIM_EXCEEDS_SANCTIONED_COVER',
      sanctioned: 65000,
      claimed: 80000,
      shortfall: 15000,
    });
  });

  it('attaches an empty warnings array when the claim has no linked preauth', async () => {
    prisma.$queryRawUnsafe = async (sql, ...params) => {
      const text = String(sql);
      if (text.includes('INSERT INTO tpa_claim_counter')) return [{ next_value: 8 }];
      if (text.includes('INSERT INTO tpa_claims')) {
        return [{
          id: 315,
          claim_number: 'CL-TEST-00008',
          preauth_id: null,
          claimed_amount: params[10],
          total_billed: params[7],
          status: 'prepared',
        }];
      }
      throw new Error(`Unexpected query in createClaim no-preauth test: ${text}`);
    };

    const claim = await createClaim({
      tenantId,
      policy_id: 1,
      patient_uid: patientUid,
      total_billed: 50000,
    });
    expect(claim.id).toBe(315);
    expect(claim.warnings).toEqual([]);
  });
});
