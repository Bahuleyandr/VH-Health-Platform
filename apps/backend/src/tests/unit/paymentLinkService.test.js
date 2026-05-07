// Unit tests for paymentLinkService validation. The DB-touching paths
// (createPaymentLink → INSERT, sendPaymentLink → notification fan-out)
// are exercised by the e2e Playwright suite against a seeded DB.
// These tests cover the input-validation gates that fire before
// prisma is ever called.

import { createPaymentLink, buildUpiDeepLink } from '../../services/billing/paymentLinkService.js';

describe('createPaymentLink validation', () => {
  it('rejects missing patient_uid', async () => {
    await expect(
      createPaymentLink({ tenantId: 't', amount: 100 }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/patient_uid/i),
    });
  });

  it('rejects amount <= 0', async () => {
    await expect(
      createPaymentLink({ tenantId: 't', patient_uid: 'p', amount: 0 }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/amount/i),
    });
    await expect(
      createPaymentLink({ tenantId: 't', patient_uid: 'p', amount: -1 }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/amount/i),
    });
  });

  it('rejects upi_intent without VPA + payee name', async () => {
    // Force missing env so the fallback path can't satisfy the requirement.
    const oldVpa = process.env.HOSPITAL_UPI_VPA;
    const oldName = process.env.HOSPITAL_NAME;
    delete process.env.HOSPITAL_UPI_VPA;
    delete process.env.HOSPITAL_NAME;
    try {
      await expect(
        createPaymentLink({
          tenantId: 't', patient_uid: 'p', amount: 100, provider: 'upi_intent',
        }),
      ).rejects.toMatchObject({
        message: expect.stringMatching(/UPI VPA \+ payee name/i),
      });
    } finally {
      if (oldVpa) process.env.HOSPITAL_UPI_VPA = oldVpa;
      if (oldName) process.env.HOSPITAL_NAME = oldName;
    }
  });
});

describe('buildUpiDeepLink', () => {
  // Most tests live in billingHelpers.test.js. A couple here lock in
  // edge cases not covered elsewhere.
  it('encodes notes that contain spaces correctly', () => {
    const url = buildUpiDeepLink({
      vpa: 'a@b', name: 'X', amount: 1, note: 'Inv #42 OPD',
    });
    // URLSearchParams encodes spaces as +; both decode equivalently
    // for UPI parsers but we verify the round-trip.
    const tn = new URL(url).searchParams.get('tn');
    expect(tn).toBe('Inv #42 OPD');
  });

  it('preserves trailing zeros on whole rupee amounts', () => {
    expect(
      new URL(
        buildUpiDeepLink({ vpa: 'a@b', name: 'X', amount: 250 }),
      ).searchParams.get('am'),
    ).toBe('250.00');
  });
});
