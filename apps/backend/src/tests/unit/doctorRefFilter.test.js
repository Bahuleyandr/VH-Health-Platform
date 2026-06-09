/**
 * Unit tests for resolveDoctorFilterId (roadmap A9) — the lenient
 * doctor-id canonicalizer for READ/filter paths.
 *
 * The strict resolver (resolveDoctorRef) is exercised by the integration
 * suites; here we drive the filter wrapper with a stubbed db client to pin
 * its non-throwing contract:
 *   - non-numeric / empty → null (caller drops the filter)
 *   - resolvable          → canonical users.id
 *   - unresolvable        → parsed input unchanged
 *   - resolver throws     → parsed input unchanged (never 500s a list)
 */

import { jest } from '@jest/globals';
import { resolveDoctorFilterId, parseDoctorRef } from '../../services/doctor/doctorRefService.js';

// Build a stub db whose $queryRawUnsafe returns the resolver's 3-CTE row.
function dbReturning({ inputUser = null, direct = null, profile = null } = {}) {
  return {
    $queryRawUnsafe: jest.fn(async () => [{
      input_user: inputUser,
      direct_doctor: direct,
      profile_doctor: profile,
    }]),
  };
}

describe('parseDoctorRef', () => {
  it('parses positive integers and rejects everything else', () => {
    expect(parseDoctorRef('42')).toBe(42);
    expect(parseDoctorRef(7)).toBe(7);
    expect(parseDoctorRef('0')).toBeNull();
    expect(parseDoctorRef('-3')).toBeNull();
    expect(parseDoctorRef('abc')).toBeNull();
    expect(parseDoctorRef('')).toBeNull();
    expect(parseDoctorRef(null)).toBeNull();
    expect(parseDoctorRef(undefined)).toBeNull();
    expect(parseDoctorRef('12abc')).toBeNull();
  });
});

describe('resolveDoctorFilterId', () => {
  it('returns null for non-numeric input without touching the db', async () => {
    const db = dbReturning();
    expect(await resolveDoctorFilterId(db, 'not-a-number')).toBeNull();
    expect(await resolveDoctorFilterId(db, '')).toBeNull();
    expect(await resolveDoctorFilterId(db, undefined)).toBeNull();
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('returns the canonical users.id when the input is already a doctor users.id', async () => {
    const db = dbReturning({
      direct: { id: 101, uid: 'u-101', name: 'Dr A', role: 'DOCTOR', doctor_row_id: 7, department: 'GM' },
    });
    expect(await resolveDoctorFilterId(db, '101')).toBe(101);
  });

  it('maps a doctors.id profile reference to the linked users.id', async () => {
    const db = dbReturning({
      profile: { id: 205, uid: 'u-205', name: 'Dr B', role: 'DOCTOR', doctor_row_id: 9, department: 'ENT' },
    });
    // Caller passed doctors.id=9; rows store users.id=205.
    expect(await resolveDoctorFilterId(db, '9')).toBe(205);
  });

  it('returns the parsed input unchanged when nothing resolves', async () => {
    const db = dbReturning();
    expect(await resolveDoctorFilterId(db, '999')).toBe(999);
  });

  it('returns the parsed input unchanged when the strict resolver throws (ambiguous)', async () => {
    const db = dbReturning({
      inputUser: { id: 33, uid: 'u-33', name: 'Nurse N', role: 'NURSE', is_active: true },
      profile: { id: 88, uid: 'u-88', name: 'Dr C', role: 'DOCTOR', doctor_row_id: 33, department: 'OBG' },
    });
    // Strict resolver raises AMBIGUOUS_DOCTOR_REF here; the filter variant
    // must swallow it and keep the raw value.
    expect(await resolveDoctorFilterId(db, '33')).toBe(33);
  });

  it('returns the parsed input unchanged when the db itself errors', async () => {
    const db = { $queryRawUnsafe: jest.fn(async () => { throw new Error('db down'); }) };
    expect(await resolveDoctorFilterId(db, '55')).toBe(55);
  });
});
