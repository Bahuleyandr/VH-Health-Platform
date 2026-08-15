// Pins the file-scan policy itself: the vocabulary, the two declared postures,
// and — most importantly — the invariants that stop a future "quick fix" from
// re-opening either half of the original defect.
//
// The load-bearing test in here is `never serves an unknown-outcome status`.
// The one-line fix somebody will reach for when an upload 423s is to add
// 'pending' or 'failed' to a clean-status set. That single edit would make
// EVERY consumer of this module serve never-scanned files. The test below fails
// if it is ever made, under either policy.

import { jest } from '@jest/globals';

const {
  FILE_SCAN_POLICY,
  FILE_SCAN_STATUS,
  acceptedScanStatusForPolicy,
  describeFileScanPolicy,
  isFileScanningRequired,
  isScanStatusServable,
  normalizeScanStatus,
  resolveFileScanPolicy,
  servableScanStatuses,
} = await import('../../config/fileScanPolicy.js');

const REQUIRED = { FILE_SCAN_POLICY: FILE_SCAN_POLICY.REQUIRED };
const DISABLED = { FILE_SCAN_POLICY: FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK };
const EVERY_POLICY = [
  ['required', REQUIRED],
  ['disabled_accepted_risk', DISABLED],
];

describe('fileScanPolicy — status vocabulary', () => {
  it('folds legacy clean spellings and casing onto the canonical values', () => {
    expect(normalizeScanStatus('clean')).toBe(FILE_SCAN_STATUS.CLEAN);
    expect(normalizeScanStatus('cleaned')).toBe(FILE_SCAN_STATUS.CLEAN);
    expect(normalizeScanStatus('passed')).toBe(FILE_SCAN_STATUS.CLEAN);
    expect(normalizeScanStatus('  PENDING ')).toBe(FILE_SCAN_STATUS.PENDING);
    expect(normalizeScanStatus('QUARANTINED')).toBe(FILE_SCAN_STATUS.QUARANTINED);
    expect(normalizeScanStatus('NOT_SCANNED')).toBe(FILE_SCAN_STATUS.NOT_SCANNED);
  });

  it('folds an unrecognised or missing status to PENDING, never to CLEAN', () => {
    for (const value of [null, undefined, '', 'ok', 'scanned', 'safe', 'true', 42]) {
      expect(normalizeScanStatus(value)).toBe(FILE_SCAN_STATUS.PENDING);
      expect(isScanStatusServable(value, REQUIRED)).toBe(false);
      expect(isScanStatusServable(value, DISABLED)).toBe(false);
    }
  });
});

describe('fileScanPolicy — policy resolution', () => {
  it('defaults to `required` when unset, blank, or unrecognised (fail closed)', () => {
    for (const env of [{}, { FILE_SCAN_POLICY: '' }, { FILE_SCAN_POLICY: '   ' },
      { FILE_SCAN_POLICY: 'off' }, { FILE_SCAN_POLICY: 'disabled' }, { FILE_SCAN_POLICY: 'true' }]) {
      expect(resolveFileScanPolicy(env)).toBe(FILE_SCAN_POLICY.REQUIRED);
      expect(isFileScanningRequired(env)).toBe(true);
    }
  });

  it('honours the explicit accepted-risk declaration, case-insensitively', () => {
    expect(resolveFileScanPolicy(DISABLED)).toBe(FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK);
    expect(resolveFileScanPolicy({ FILE_SCAN_POLICY: ' Disabled_Accepted_Risk ' }))
      .toBe(FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK);
    expect(isFileScanningRequired(DISABLED)).toBe(false);
  });

  it('describes each posture in operator-readable prose', () => {
    expect(describeFileScanPolicy(REQUIRED)).toMatch(/refused when the scanner is unreachable/);
    expect(describeFileScanPolicy(DISABLED)).toMatch(/no scan is attempted/);
  });
});

describe('fileScanPolicy — servable-status invariants', () => {
  it('NEVER serves an unknown-outcome status under ANY policy (regression guard)', () => {
    // If this test fails, someone has widened a clean-status set to unblock a
    // stuck download. That change serves never-scanned bytes on the generic
    // upload path, the staff-message attachment path, and the brand-kit gate
    // simultaneously. Fix the policy configuration instead — see
    // src/config/fileScanPolicy.js and FILE_SCAN_POLICY in .env.example.
    for (const [label, env] of EVERY_POLICY) {
      const servable = servableScanStatuses(env);
      expect(`${label}:${servable.has(FILE_SCAN_STATUS.PENDING)}`).toBe(`${label}:false`);
      expect(`${label}:${servable.has(FILE_SCAN_STATUS.FAILED)}`).toBe(`${label}:false`);
      expect(isScanStatusServable('pending', env)).toBe(false);
      expect(isScanStatusServable('PENDING', env)).toBe(false);
      expect(isScanStatusServable('failed', env)).toBe(false);
    }
  });

  it('NEVER serves a quarantined file under ANY policy', () => {
    for (const [, env] of EVERY_POLICY) {
      expect(isScanStatusServable('quarantined', env)).toBe(false);
      expect(isScanStatusServable('QUARANTINED', env)).toBe(false);
    }
  });

  it('ALWAYS serves a proven-clean file under ANY policy', () => {
    for (const [, env] of EVERY_POLICY) {
      expect(isScanStatusServable('clean', env)).toBe(true);
      expect(isScanStatusServable('passed', env)).toBe(true);
    }
  });

  it('serves not_scanned only where the deployment declared it runs without a scanner', () => {
    expect(isScanStatusServable('not_scanned', REQUIRED)).toBe(false);
    expect(isScanStatusServable('not_scanned', DISABLED)).toBe(true);
  });

  it('keeps each policy servable set exactly as declared', () => {
    expect([...servableScanStatuses(REQUIRED)].sort()).toEqual(['clean']);
    expect([...servableScanStatuses(DISABLED)].sort()).toEqual(['clean', 'not_scanned']);
  });

  it('writes only a status that its own policy will later serve', () => {
    // The rule that makes the blackhole impossible: whatever we stamp on an
    // accepted file must pass the gate that same policy applies.
    for (const [, env] of EVERY_POLICY) {
      expect(isScanStatusServable(acceptedScanStatusForPolicy(env), env)).toBe(true);
    }
    expect(acceptedScanStatusForPolicy(REQUIRED)).toBe(FILE_SCAN_STATUS.CLEAN);
    expect(acceptedScanStatusForPolicy(DISABLED)).toBe(FILE_SCAN_STATUS.NOT_SCANNED);
  });

  it('reads process.env when no env is passed', () => {
    const previous = process.env.FILE_SCAN_POLICY;
    try {
      process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK;
      expect(isScanStatusServable('not_scanned')).toBe(true);
      process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.REQUIRED;
      expect(isScanStatusServable('not_scanned')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.FILE_SCAN_POLICY;
      else process.env.FILE_SCAN_POLICY = previous;
    }
  });
});

describe('fileScanPolicy — the two consumers agree', () => {
  // The original defect was two gates disagreeing about the same row. Assert
  // that whatever the upload gate blocks, the messaging gate blocks too, by
  // proving they are literally the same predicate over the whole vocabulary.
  it('produces one verdict per (status, policy) pair for every consumer', () => {
    const allStatuses = [...Object.values(FILE_SCAN_STATUS), 'cleaned', 'passed', 'PENDING', 'bogus'];
    for (const [, env] of EVERY_POLICY) {
      for (const status of allStatuses) {
        const viaSet = servableScanStatuses(env).has(normalizeScanStatus(status));
        expect(isScanStatusServable(status, env)).toBe(viaSet);
      }
    }
  });

  afterAll(() => jest.restoreAllMocks());
});
