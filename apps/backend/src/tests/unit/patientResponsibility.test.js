// Unit test for finding
// 2026-05-20-tpa-insurance-claim-patient-25a59426
//
// On a cashless TPA bill the invoice ledger `amount_due` (total − payments)
// is mostly the INSURER's receivable. The patient portal headlined that
// figure as the patient's amount due, so a patient with ₹80,000 cashless
// cover and a ₹5,000 non-payable balance saw ₹80,000 due.
//
// computePatientResponsibility() derives what the PATIENT actually owes,
// netting out the insurer-covered portion, across cash / cashless-preview /
// cashless-final payer states. Pure function — no DB needed.

import { computePatientResponsibility } from '../../services/portal/patientPortalService.js';

describe('computePatientResponsibility (cashless patient amount due — 25a59426)', () => {
  it('cash payer: patient owes the full ledger balance', () => {
    const r = computePatientResponsibility({
      total_amount: 5000,
      amount_due: 5000,
      payments: [],
      tpaBreakdown: null,
      nonPayablePreviewTotal: 0,
      isCashless: false,
    });
    expect(r.basis).toBe('cash');
    expect(r.is_cashless).toBe(false);
    expect(r.patient_amount_due).toBe(5000);
    expect(r.insurer_portion).toBe(0);
  });

  it('cash payer, part-paid: patient_amount_due tracks the outstanding balance', () => {
    const r = computePatientResponsibility({
      total_amount: 5000,
      amount_due: 2000,
      payments: [{ amount: 3000, mode: 'CASH', reversed: false }],
      tpaBreakdown: null,
      isCashless: false,
    });
    expect(r.basis).toBe('cash');
    expect(r.patient_paid).toBe(3000);
    expect(r.patient_amount_due).toBe(2000);
  });

  it('cashless preview (no insurer verdict yet): patient owes only the non-payable preview, NOT the insurer-covered total', () => {
    const r = computePatientResponsibility({
      total_amount: 80000,
      amount_due: 80000, // ledger balance still the full bill pre-settlement
      payments: [],
      tpaBreakdown: null,
      nonPayablePreviewTotal: 5000,
      isCashless: true,
    });
    expect(r.basis).toBe('cashless_preview');
    expect(r.is_cashless).toBe(true);
    expect(r.patient_responsibility).toBe(5000);
    expect(r.patient_amount_due).toBe(5000); // the fix: 5000, not 80000
    expect(r.insurer_portion).toBe(75000);
  });

  it('cashless final verdict: patient owes the insurer-determined patient_share', () => {
    const r = computePatientResponsibility({
      total_amount: 80000,
      amount_due: 80000,
      payments: [],
      tpaBreakdown: { summary: { patient_share: 5000 } },
      nonPayablePreviewTotal: 4000, // ignored once a final verdict exists
      isCashless: true,
    });
    expect(r.basis).toBe('tpa_final');
    expect(r.patient_responsibility).toBe(5000);
    expect(r.patient_amount_due).toBe(5000);
    expect(r.insurer_portion).toBe(75000);
  });

  it('cashless final, patient already paid an advance: due is the remaining patient share', () => {
    const r = computePatientResponsibility({
      total_amount: 80000,
      amount_due: 78000,
      payments: [{ amount: 2000, mode: 'CASH', reversed: false }],
      tpaBreakdown: { summary: { patient_share: 5000 } },
      isCashless: true,
    });
    expect(r.patient_paid).toBe(2000);
    expect(r.patient_amount_due).toBe(3000);
  });

  it('insurer (cashless settlement) payments do NOT reduce the patient amount due', () => {
    const r = computePatientResponsibility({
      total_amount: 80000,
      amount_due: 3000,
      payments: [
        { amount: 75000, mode: 'INSURANCE', reversed: false }, // insurer's cashless settlement
        { amount: 2000, mode: 'CASH', reversed: false }, // patient advance
      ],
      tpaBreakdown: { summary: { patient_share: 5000 } },
      isCashless: true,
    });
    // Only the ₹2,000 patient payment counts; the ₹75,000 insurer settlement
    // is for the insurer's portion and must not shrink the patient's due.
    expect(r.patient_paid).toBe(2000);
    expect(r.patient_amount_due).toBe(3000);
  });

  it('reversed patient payments are excluded', () => {
    const r = computePatientResponsibility({
      total_amount: 80000,
      amount_due: 80000,
      payments: [{ amount: 2000, mode: 'CASH', reversed: true }],
      tpaBreakdown: { summary: { patient_share: 5000 } },
      isCashless: true,
    });
    expect(r.patient_paid).toBe(0);
    expect(r.patient_amount_due).toBe(5000);
  });
});
