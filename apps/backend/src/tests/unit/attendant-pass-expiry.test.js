// Regression test for finding 2026-05-22-inpatient-admission-admission-c1da7281.
//
// `POST /api/v1/admissions` auto-issued 2 attendant passes with
// `expires_at = null` — the printable pass has no validity window so
// ward/security can't tell a stale pass from a current one. The
// passes stay technically active even after transfer, until a
// separate subsystem (discharge cascade) revokes them.
//
// Fix adds a default `ATTENDANT_PASS_DEFAULT_VALIDITY_MS = 14 days`
// stamp on auto-issued passes + replacement passes. The discharge
// path still flips status='expired' (revokes earlier than the safety
// expiry), so this is a defence-in-depth upper bound rather than the
// primary expiry signal.

import { jest } from '@jest/globals';

const mockFindUnique = jest.fn().mockResolvedValue(null);   // no ward color/screening
const mockAggregate = jest.fn().mockResolvedValue({ _max: { pass_index: 2 } });
const mockCreate = jest.fn().mockImplementation(({ data }) => ({ id: Math.floor(Math.random() * 1000) + 1, ...data }));
const mockUpdate = jest.fn();
const mockFindFirst = jest.fn().mockResolvedValue({ pass_number: 'AP-20260523-0028' });

// jest.mock would be cleaner but ipdSupportService imports prisma at
// module-load time and we don't want to set up the full mock machinery
// just for this. Stub the `tx` object that issueDefaultAttendantPasses
// receives — that's the actual seam.
const tx = {
  attendant_passes: {
    create: mockCreate,
    findFirst: mockFindFirst,
    aggregate: mockAggregate,
    update: mockUpdate,
    updateMany: jest.fn(),
  },
  wards: { findUnique: mockFindUnique },
};

const { issueDefaultAttendantPasses } = await import('../../services/ipd/ipdSupportService.js');

describe('issueDefaultAttendantPasses — auto-issued passes have expiry (c1da7281)', () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockFindUnique.mockClear();
    mockFindFirst.mockClear();
  });

  it('every auto-issued pass carries a non-null expires_at (the repro fix)', async () => {
    await issueDefaultAttendantPasses(tx, {
      admissionId: 43,
      patientUid: '85a05d9b-6b0c-4024-870e-297da5e79a25',
      patientName: 'Karuppasamy M',
      wardId: null,
      wardName: 'General Ward',
      issuedBy: 'bb000000-0000-4000-8000-00000000b001',
    });

    expect(mockCreate).toHaveBeenCalledTimes(2);
    for (const call of mockCreate.mock.calls) {
      const data = call[0].data;
      expect(data.expires_at).toBeInstanceOf(Date);
      // ≥ 13 days into future (defensive lower bound, allows clock skew /
      // test-runtime drift but rejects the previous null-or-now bug).
      const horizonMs = data.expires_at.getTime() - Date.now();
      expect(horizonMs).toBeGreaterThan(13 * 24 * 60 * 60 * 1000);
      expect(horizonMs).toBeLessThan(15 * 24 * 60 * 60 * 1000);
    }
  });

  it('both passes for the same admission share the SAME expiry (computed once per admission)', async () => {
    await issueDefaultAttendantPasses(tx, {
      admissionId: 44,
      patientUid: '85a05d9b-6b0c-4024-870e-297da5e79a25',
      patientName: 'Karuppasamy M',
      wardId: null,
      wardName: null,
      issuedBy: 'bb000000-0000-4000-8000-00000000b001',
    });

    expect(mockCreate).toHaveBeenCalledTimes(2);
    const expiry1 = mockCreate.mock.calls[0][0].data.expires_at;
    const expiry2 = mockCreate.mock.calls[1][0].data.expires_at;
    expect(expiry1.getTime()).toBe(expiry2.getTime());
  });

  it('still includes the other required fields (regression on the create shape)', async () => {
    await issueDefaultAttendantPasses(tx, {
      admissionId: 45,
      patientUid: '85a05d9b-6b0c-4024-870e-297da5e79a25',
      patientName: 'Karuppasamy M',
      wardId: null,
      wardName: 'ICU-A',
      issuedBy: 'bb000000-0000-4000-8000-00000000b002',
    });

    const data = mockCreate.mock.calls[0][0].data;
    expect(data.admission_id).toBe(45);
    expect(data.patient_uid).toBe('85a05d9b-6b0c-4024-870e-297da5e79a25');
    expect(data.pass_index).toBe(1);
    expect(data.ward_at_issue).toBe('ICU-A');
    expect(data.issued_by).toBe('bb000000-0000-4000-8000-00000000b002');
  });
});
