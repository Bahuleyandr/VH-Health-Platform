// Pins the store-loss decision table (Redis-loss drill 2026-08-15, Finding 1).
//
// The defect being guarded against: the deployment's behaviour under rate-limit
// store loss was a library default (express-rate-limit passOnStoreError=false →
// a 500 per request), chosen by nobody. These tests make the posture a pinned,
// per-profile DECISION: loosening auth/otp/sos to fail-open, or landing a new
// profile without writing its posture down, fails CI.
import { RATE_LIMIT_PROFILES } from '../../config/rateLimitProfiles.js';
import {
  RATE_LIMIT_STORE_LOSS_POLICY,
  RATE_LIMIT_STORE_LOSS_POSTURE,
  RATE_LIMIT_STORE_LOSS_RETRY_AFTER_SECONDS,
  storeLossPostureFor,
} from '../../config/rateLimitStoreLossPolicy.js';

describe('rate-limit store-loss policy', () => {
  it('declares an explicit posture for EVERY profile — set equality, no accidents', () => {
    expect(Object.keys(RATE_LIMIT_STORE_LOSS_POLICY).sort())
      .toEqual(Object.keys(RATE_LIMIT_PROFILES).sort());
  });

  it.each(['auth', 'otp', 'sos'])(
    '%s NEVER fails open — unmetered abuse during an outage is an incident',
    (profile) => {
      expect(storeLossPostureFor(profile)).toBe(RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_CLOSED);
    },
  );

  it.each(['dataExport', 'dashboard', 'smartFhirOAuth'])(
    '%s fails closed — the limiter is the security control on this surface',
    (profile) => {
      expect(storeLossPostureFor(profile)).toBe(RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_CLOSED);
    },
  );

  it.each(['patient', 'staff', 'admin', 'default', 'probe', 'clientReadiness', 'clinicalContinuityPolicyDelivery'])(
    '%s fails open by explicit decision — a cache outage must not become an API outage',
    (profile) => {
      expect(storeLossPostureFor(profile)).toBe(RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_OPEN_UNMETERED);
    },
  );

  it('resolves an UNKNOWN profile fail-closed — the permissive branch is never the accident', () => {
    expect(storeLossPostureFor('some-future-profile')).toBe(RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_CLOSED);
    expect(storeLossPostureFor(undefined)).toBe(RATE_LIMIT_STORE_LOSS_POSTURE.FAIL_CLOSED);
  });

  it('store-loss denials carry a SHORT Retry-After, not a profile window', () => {
    expect(RATE_LIMIT_STORE_LOSS_RETRY_AFTER_SECONDS).toBeGreaterThan(0);
    // Must stay well under the smallest fail-closed window (otp: 10 minutes) —
    // the denial says "temporarily throttled", not "you are over quota".
    expect(RATE_LIMIT_STORE_LOSS_RETRY_AFTER_SECONDS).toBeLessThanOrEqual(60);
  });
});
