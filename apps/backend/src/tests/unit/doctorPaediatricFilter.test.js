// Unit regression for finding H' D73 (37cf68ae).
//
// `doctorService.getAllDoctors` accepted `?ageRange=paediatric` but the
// SQL filter used `COALESCE(d.age_range, 'all') = $param OR
// COALESCE(d.age_range, 'all') = 'all'`. Because most doctor rows
// have NULL age_range (migration 189 added the column without
// back-fill), COALESCE defaulted them all to 'all' — which then
// always matched the OR clause. The paediatric picker therefore
// returned every adult-trained consultant in the hospital, the same
// regression the original 2026-05-11-pediatric-opd fix tried to
// close but didn't.
//
// The fix:
//   * Default NULL age_range to 'adult' (historical hospital policy —
//     paediatricians are an explicitly-flagged specialty).
//   * paediatric picker: ageRange IN ('paediatric','all').
//   * adult picker:      ageRange IN ('adult','all').
//   * 'all' picker:      no filter (everyone).
//
// This unit test mocks the prisma raw-SQL surface and asserts the
// generated WHERE clauses match the new shape — locking in the
// regression so a future refactor can't silently re-introduce the
// COALESCE(..., 'all') fail-open path.

import { jest } from '@jest/globals';

const queryRawMock = jest.fn();
const queryRawTaggedMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawMock,
    // getDoctorSchema uses the tagged-template form; return a rich
    // column list so it caches a schema object that exercises the
    // age_range filter (we only assert on the WHERE SQL anyway).
    $queryRaw: queryRawTaggedMock,
  },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { doctorService } = await import('../../services/doctor/doctorService.js');

describe('doctorService.getAllDoctors — paediatric / adult age-range filter (H D73)', () => {
  beforeEach(() => {
    queryRawMock.mockReset();
    queryRawTaggedMock.mockReset();
    // Seed a doctors schema with every column the service might branch
    // on, so getDoctorSchema caches a "full-featured" schema.
    queryRawTaggedMock.mockResolvedValue([
      'specialty', 'bio', 'experience_years', 'consultation_fee',
      'available_days', 'available_hours', 'qualifications',
      'education', 'certifications', 'is_available', 'created_at',
      'updated_at', 'department', 'age_range',
    ].map((column_name) => ({ column_name })));
    // Default mock: SELECT rows return []; COUNT(*) queries return
    // [{count: 0}] so countDoctors doesn't crash on result[0].count.
    queryRawMock.mockImplementation(async (sql) => {
      if (/SELECT COUNT/i.test(sql)) return [{ count: 0 }];
      return [];
    });
  });

  it('paediatric picker filters to age_range IN paediatric/all and defaults NULL to adult (excluded)', async () => {
    await doctorService.getAllDoctors({ ageRange: 'paediatric' });
    // listDoctors makes two queries (count + rows); both must apply the filter.
    expect(queryRawMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    const sql = queryRawMock.mock.calls[0][0];
    expect(sql).toMatch(/COALESCE\(d\.age_range, 'adult'\) IN \('paediatric', 'all'\)/);
    // The legacy fail-open OR clause must be gone.
    expect(sql).not.toMatch(/COALESCE\(d\.age_range, 'all'\)/);
  });

  it('adult picker filters to age_range IN adult/all (the new explicit default catches NULLs)', async () => {
    await doctorService.getAllDoctors({ ageRange: 'adult' });
    const sql = queryRawMock.mock.calls[0][0];
    expect(sql).toMatch(/COALESCE\(d\.age_range, 'adult'\) IN \('adult', 'all'\)/);
  });

  it('all picker skips the age_range filter entirely (full roster)', async () => {
    await doctorService.getAllDoctors({ ageRange: 'all' });
    const sql = queryRawMock.mock.calls[0][0];
    expect(sql).not.toMatch(/age_range/);
  });

  it('omitting ageRange leaves the filter off (back-compat)', async () => {
    await doctorService.getAllDoctors({});
    const sql = queryRawMock.mock.calls[0][0];
    expect(sql).not.toMatch(/age_range/);
  });
});
