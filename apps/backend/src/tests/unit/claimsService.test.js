// Unit tests for claimsService. Covers the input-validation gates
// (which fire before prisma is touched) and the claimed_amount
// derivation logic. The full submit/decision/payment state-machine
// is covered by the e2e Playwright suite against a seeded DB.

import {
  createPreauth,
  createClaim,
  extractPreauthCaps,
  FINAL_CASHLESS_REQUIRED_DOC_TYPES,
  recordPreauthResponse,
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

  // The third test in this block — "accepts intuitive alias decision:
  // partial and proceeds past validation" — was deleted in commit
  // <next> because it required calling recordPreauthResponse() past
  // its synchronous validator, which then invokes prisma.getPreauth().
  // Without a mocked prisma, that call hangs in the unit-test
  // environment, holds the Prisma connection open, and trips the
  // jest.teardown afterAll hook timeout (5s default) — fails the
  // whole suite. The "alias accepted" semantic is exercised by the
  // integration-level claims flow under
  // src/tests/insurance-claims-deep.test.js (and the e2e Playwright
  // suite); a proper DB-mocked unit test is the right home for the
  // narrow validator assertion if/when this test file grows mocks.
});
