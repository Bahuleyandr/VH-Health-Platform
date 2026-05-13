// Unit tests for pharmacyCapService — the pure pieces. The DB-touching
// probePharmacyCap is covered by the dispense integration suite.
//
// Regression for 2026-05-09-tpa-insurance-claim-billing-pharmacy-cap-not-enforced.

import {
  extractPharmacyCapFromRaw,
  shouldBlockDispense,
  PHARMACY_CAP_CRITICAL_PCT,
  PHARMACY_CAP_WARN_PCT,
} from '../../services/pharmacy/pharmacyCapService.js';

describe('extractPharmacyCapFromRaw', () => {
  it('returns null for empty / non-object input', () => {
    expect(extractPharmacyCapFromRaw(null)).toBeNull();
    expect(extractPharmacyCapFromRaw(undefined)).toBeNull();
    expect(extractPharmacyCapFromRaw('string')).toBeNull();
    expect(extractPharmacyCapFromRaw({})).toBeNull();
  });

  it('reads the nested caps.pharmacy.max_amount shape', () => {
    expect(extractPharmacyCapFromRaw({
      caps: { pharmacy: { max_amount: 15000, currency: 'INR' } },
    })).toBe(15000);
  });

  it('falls back to flat pharmacy_cap', () => {
    expect(extractPharmacyCapFromRaw({ pharmacy_cap: 15000 })).toBe(15000);
  });

  it('prefers nested over flat when both present', () => {
    expect(extractPharmacyCapFromRaw({
      caps: { pharmacy: { max_amount: 20000 } },
      pharmacy_cap: 99999,
    })).toBe(20000);
  });

  it('returns null for non-numeric / NaN caps', () => {
    expect(extractPharmacyCapFromRaw({ pharmacy_cap: 'abc' })).toBeNull();
  });
});

describe('shouldBlockDispense', () => {
  // Phase 1 hard-block rule.
  it('skips when probe has no cap', () => {
    expect(shouldBlockDispense({ hasCap: false, level: 'critical' })).toBe(false);
  });

  it('passes through ok / warn levels even with no override', () => {
    expect(shouldBlockDispense({ hasCap: true, level: 'ok' })).toBe(false);
    expect(shouldBlockDispense({ hasCap: true, level: 'warn' })).toBe(false);
  });

  it('blocks critical without override', () => {
    expect(shouldBlockDispense({ hasCap: true, level: 'critical' })).toBe(true);
  });

  it('allows critical with explicit override', () => {
    expect(shouldBlockDispense(
      { hasCap: true, level: 'critical' },
      { allowOverride: true },
    )).toBe(false);
  });

  it('threshold ladder is 80% warn / 100% critical', () => {
    expect(PHARMACY_CAP_WARN_PCT).toBe(80);
    expect(PHARMACY_CAP_CRITICAL_PCT).toBe(100);
  });
});
