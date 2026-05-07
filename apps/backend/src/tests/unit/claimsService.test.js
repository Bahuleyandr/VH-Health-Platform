// Unit tests for claimsService. Covers the input-validation gates
// (which fire before prisma is touched) and the claimed_amount
// derivation logic. The full submit/decision/payment state-machine
// is covered by the e2e Playwright suite against a seeded DB.

import { createPreauth, createClaim } from '../../services/insurance/claimsService.js';

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
