// Unit tests for the Sprint-1 billing helpers and Sprint-4 UPI deep
// link builder. Pure-compute, no DB.

import { fiscalYearOf, splitGst } from '../../services/billing/billingV2Service.js';
import { buildUpiDeepLink } from '../../services/billing/paymentLinkService.js';

describe('fiscalYearOf', () => {
  it('Apr 1 starts a new Indian FY', () => {
    expect(fiscalYearOf(new Date('2026-04-01T00:00:00Z'))).toBe(2026);
  });
  it('Mar 31 still belongs to previous FY', () => {
    expect(fiscalYearOf(new Date('2026-03-31T23:59:00Z'))).toBe(2025);
  });
  it('Jan 1 returns previous calendar year', () => {
    expect(fiscalYearOf(new Date('2026-01-01T00:00:00Z'))).toBe(2025);
  });
});

describe('splitGst', () => {
  it('same-state splits evenly into CGST + SGST', () => {
    // 1000 * 18% = 180 → 90 + 90
    const r = splitGst({
      subtotal: 1000, gstRate: 18,
      patientState: 'Karnataka', hospitalState: 'Karnataka',
    });
    expect(r.cgst).toBe(90);
    expect(r.sgst).toBe(90);
    expect(r.igst).toBe(0);
    expect(r.lineTotal).toBe(1180);
  });

  it('inter-state uses single IGST line', () => {
    const r = splitGst({
      subtotal: 1000, gstRate: 18,
      patientState: 'Maharashtra', hospitalState: 'Karnataka',
    });
    expect(r.igst).toBe(180);
    expect(r.cgst).toBe(0);
    expect(r.sgst).toBe(0);
    expect(r.lineTotal).toBe(1180);
  });

  it('case-insensitive state match', () => {
    const r = splitGst({
      subtotal: 100, gstRate: 18,
      patientState: 'KARNATAKA', hospitalState: 'karnataka ',
    });
    expect(r.igst).toBe(0);
    expect(r.cgst + r.sgst).toBe(18);
  });

  it('zero rate produces zero tax', () => {
    expect(splitGst({
      subtotal: 1000, gstRate: 0,
      patientState: 'KA', hospitalState: 'KA',
    })).toEqual({ cgst: 0, sgst: 0, igst: 0, lineTotal: 1000 });
  });

  it('odd amounts: drift goes to SGST so total still adds up', () => {
    // 99 * 5% = 4.95 → split is 2.48 + 2.47 (or similar).
    const r = splitGst({
      subtotal: 99, gstRate: 5,
      patientState: 'KA', hospitalState: 'KA',
    });
    expect(r.cgst + r.sgst).toBeCloseTo(4.95, 2);
    expect(r.lineTotal).toBeCloseTo(99 + 4.95, 2);
  });
});

describe('buildUpiDeepLink (NPCI URI spec)', () => {
  it('returns null when required fields missing', () => {
    expect(buildUpiDeepLink({})).toBeNull();
    expect(buildUpiDeepLink({ vpa: 'a@b' })).toBeNull();
    expect(buildUpiDeepLink({ vpa: 'a@b', name: 'A' })).toBeNull();
  });

  it('produces a valid upi://pay link with the required params', () => {
    const link = buildUpiDeepLink({
      vpa: 'hospital@upi',
      name: 'Acme Hospital',
      amount: 1234.5,
    });
    expect(link).toMatch(/^upi:\/\/pay\?/);
    const u = new URL(link);
    expect(u.searchParams.get('pa')).toBe('hospital@upi');
    expect(u.searchParams.get('pn')).toBe('Acme Hospital');
    expect(u.searchParams.get('am')).toBe('1234.50');
    expect(u.searchParams.get('cu')).toBe('INR');
  });

  it('formats amount to exactly 2 decimal places', () => {
    expect(new URL(buildUpiDeepLink({
      vpa: 'a@b', name: 'X', amount: 100,
    })).searchParams.get('am')).toBe('100.00');
    expect(new URL(buildUpiDeepLink({
      vpa: 'a@b', name: 'X', amount: 99.999,
    })).searchParams.get('am')).toBe('100.00');
  });

  it('omits tn and tr when not provided, includes them when provided', () => {
    const without = new URL(buildUpiDeepLink({
      vpa: 'a@b', name: 'X', amount: 1,
    }));
    expect(without.searchParams.has('tn')).toBe(false);
    expect(without.searchParams.has('tr')).toBe(false);

    const withRefs = new URL(buildUpiDeepLink({
      vpa: 'a@b', name: 'X', amount: 1, note: 'Inv 42', transactionRef: 'VH-42',
    }));
    expect(withRefs.searchParams.get('tn')).toBe('Inv 42');
    expect(withRefs.searchParams.get('tr')).toBe('VH-42');
  });
});
