// Regression test for finding 2026-05-22-inpatient-admission-billing-8f3634b2.
//
// `collectPayment` accepted a CASH payment with `shift = null`. The
// payment landed in `daily-collection` (no shift filter) but
// `cash-drawer/sessions` close logic filters by exact non-null
// shift — so the patient's INR 2500 discharge cash never attached to
// a drawer-close zero-variance check. Off-the-books bypass.
//
// Fix: reject CASH without shift at the service boundary with
// CASH_PAYMENT_REQUIRES_SHIFT (400). Other modes (UPI, card, online,
// etc.) don't move physical cash and don't need a drawer session,
// so the guard only fires for CASH.

import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
    $executeRawUnsafe: jest.fn(),
  },
}));

const { collectPayment } = await import('../../services/billing/billingV2Service.js');

describe('collectPayment — CASH requires shift (8f3634b2)', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
  });

  it('rejects CASH without shift (the repro)', async () => {
    await expect(
      collectPayment({
        invoice_id: 16, patient_uid: 'aa000000-0000-4000-8000-000000000001',
        amount: 2500, mode: 'CASH', collected_by: 'bb000000-0000-4000-8000-000000000001',
        // no shift
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'CASH_PAYMENT_REQUIRES_SHIFT',
    });
    expect(queryRawUnsafeMock).not.toHaveBeenCalled(); // never reached the INSERT
  });

  it('rejects CASH with empty-string shift', async () => {
    await expect(
      collectPayment({
        invoice_id: 16, patient_uid: 'aa000000-0000-4000-8000-000000000001',
        amount: 2500, mode: 'CASH', collected_by: 'bb000000-0000-4000-8000-000000000001',
        shift: '',
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'CASH_PAYMENT_REQUIRES_SHIFT' });
  });

  it('rejects CASH lowercase (case-insensitive mode check)', async () => {
    await expect(
      collectPayment({
        invoice_id: 16, patient_uid: 'aa000000-0000-4000-8000-000000000001',
        amount: 2500, mode: 'cash', collected_by: 'bb000000-0000-4000-8000-000000000001',
      }),
    ).rejects.toThrow();
    // Either CASH_PAYMENT_REQUIRES_SHIFT (if mode is normalized) or
    // Invalid mode — both are acceptable rejections at the boundary.
  });

  // The "allow" path (CASH with shift, or non-cash without shift) is
  // verified by the absence of CASH_PAYMENT_REQUIRES_SHIFT in any
  // downstream rejection. Driving the full INSERT + recomputeInvoice
  // path in unit form requires mocking 3+ chained queries; the boundary
  // assertion below is sufficient regression coverage — any future
  // change that widens the guard to UPI/CARD (the regression risk)
  // would surface as CASH_PAYMENT_REQUIRES_SHIFT here.
  it('does NOT fire the CASH_PAYMENT_REQUIRES_SHIFT guard for UPI without shift', async () => {
    queryRawUnsafeMock.mockRejectedValue(new Error('downstream-stub-stops-here'));
    let err;
    try {
      await collectPayment({
        invoice_id: 16, patient_uid: 'aa000000-0000-4000-8000-000000000001',
        amount: 1000, mode: 'UPI', reference: 'UPI-TXN-001',
        collected_by: 'bb000000-0000-4000-8000-000000000001',
      });
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.code).not.toBe('CASH_PAYMENT_REQUIRES_SHIFT');
  });

  it('does NOT fire the CASH_PAYMENT_REQUIRES_SHIFT guard for CARD without shift', async () => {
    queryRawUnsafeMock.mockRejectedValue(new Error('downstream-stub-stops-here'));
    let err;
    try {
      await collectPayment({
        invoice_id: 16, patient_uid: 'aa000000-0000-4000-8000-000000000001',
        amount: 1500, mode: 'CARD',
        collected_by: 'bb000000-0000-4000-8000-000000000001',
      });
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.code).not.toBe('CASH_PAYMENT_REQUIRES_SHIFT');
  });

  it('does NOT fire the guard for CASH WITH a shift (control)', async () => {
    queryRawUnsafeMock.mockRejectedValue(new Error('downstream-stub-stops-here'));
    let err;
    try {
      await collectPayment({
        invoice_id: 16, patient_uid: 'aa000000-0000-4000-8000-000000000001',
        amount: 2500, mode: 'CASH',
        collected_by: 'bb000000-0000-4000-8000-000000000001',
        shift: 'GENERAL',
      });
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.code).not.toBe('CASH_PAYMENT_REQUIRES_SHIFT');
  });
});
