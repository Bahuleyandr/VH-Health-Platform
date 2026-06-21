/**
 * Unit tests for key-aware PHI redaction in logMasking.scrubPhiDeep (audit
 * 2026-06-18 §4 Observability): the deep scrubber walked VALUES only, so
 * `logger.info('x', { mrn: 'AB12345' })` survived — an MRN with no adjacent
 * "MRN"/"UHID" label slipped the value regex. scrubPhiDeep now also redacts
 * by KEY NAME (mirroring the Sentry scrubber's SENSITIVE_KEY_PATTERN) and the
 * string scrubber gained Aadhaar/ABHA patterns.
 */

import {
  scrubPhiDeep,
  scrubPhiFromString,
} from '../../utils/logMasking.js';

describe('scrubPhiDeep — key-aware redaction', () => {
  it('redacts a sensitive KEY even when the value has no adjacent label', () => {
    const out = scrubPhiDeep({ mrn: 'AB12345', count: 3 });
    expect(out.mrn).not.toBe('AB12345');
    expect(out.mrn).toBe('[REDACTED]');
    // non-sensitive keys pass through
    expect(out.count).toBe(3);
  });

  it('redacts password / token / secret / authorization / apiKey keys', () => {
    const out = scrubPhiDeep({
      password: 'hunter2',
      token: 'opaque-not-a-jwt',
      secret: 'abc',
      authorization: 'Bearer x',
      apiKey: 'k-123',
      pin: '4321',
      otp: '000000',
    });
    for (const k of ['password', 'token', 'secret', 'authorization', 'apiKey', 'pin', 'otp']) {
      expect(out[k]).toBe('[REDACTED]');
    }
  });

  it('redacts clinical/PHI keys: diagnosis, address, patientName, aadhaar, abha', () => {
    const out = scrubPhiDeep({
      diagnosis: 'something private',
      address: '12 MG Road',
      patientName: 'Priya Iyer',
      aadhaar: '1234 5678 9012',
      abha: '12-3456-7890-1234',
    });
    expect(out.diagnosis).toBe('[REDACTED]');
    expect(out.address).toBe('[REDACTED]');
    expect(out.patientName).toBe('[REDACTED]');
    expect(out.aadhaar).toBe('[REDACTED]');
    expect(out.abha).toBe('[REDACTED]');
  });

  it('still scrubs by value for non-sensitive keys (existing behavior preserved)', () => {
    const out = scrubPhiDeep({ note: 'reach me at +911234567890' });
    // `note` is itself a sensitive key -> whole value redacted
    expect(out.note).toBe('[REDACTED]');

    const out2 = scrubPhiDeep({ description: 'reach me at +911234567890' });
    // `description` is not a sensitive key -> value-level phone scrub applies
    expect(out2.description).not.toContain('+911234567890');
    expect(out2.description).toContain('***');
  });

  it('recurses into nested objects and arrays for key redaction', () => {
    const out = scrubPhiDeep({ outer: { inner: { mrn: 'X9999' } }, list: [{ otp: '111111' }] });
    expect(out.outer.inner.mrn).toBe('[REDACTED]');
    expect(out.list[0].otp).toBe('[REDACTED]');
  });

  it('does not mutate the caller object', () => {
    const input = { mrn: 'AB12345' };
    scrubPhiDeep(input);
    expect(input.mrn).toBe('AB12345');
  });
});

describe('scrubPhiFromString — Aadhaar / ABHA value patterns', () => {
  it('masks a bare 12-digit Aadhaar number', () => {
    const out = scrubPhiFromString('aadhaar 1234 5678 9012 on file');
    expect(out).not.toContain('1234 5678 9012');
    expect(out).not.toContain('123456789012');
  });

  it('masks a 14-digit ABHA number', () => {
    const out = scrubPhiFromString('ABHA 12-3456-7890-1234 verified');
    expect(out).not.toContain('12-3456-7890-1234');
  });
});
