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

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawMock,
  // getDoctorSchema uses the tagged-template form; return a rich
  // column list so it caches a schema object that exercises the
  // age_range filter (we only assert on the WHERE SQL anyway).
  $queryRaw: queryRawTaggedMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
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

describe('doctorService.getAvailableDoctors — strict current availability', () => {
  beforeEach(() => {
    queryRawMock.mockReset();
    queryRawTaggedMock.mockReset();
    queryRawTaggedMock.mockResolvedValue([
      'specialty', 'bio', 'experience_years', 'consultation_fee',
      'available_days', 'available_hours', 'qualifications',
      'education', 'certifications', 'is_available', 'created_at',
      'updated_at', 'department', 'age_range',
    ].map((column_name) => ({ column_name })));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('filters by route-safe current IST shift and department without future roster fallback', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-25T04:30:00.000Z')); // Monday 10:00 IST
    queryRawMock.mockResolvedValueOnce([
      {
        id: 1,
        uid: '11111111-1111-4111-8111-111111111111',
        name: 'Dr Current',
        department: 'Cardiology',
        available_hours: [{ start: '09:00', end: '13:00' }],
      },
      {
        id: 2,
        uid: '22222222-2222-4222-8222-222222222222',
        name: 'Dr Later',
        department: 'Cardiology',
        available_hours: [{ start: '14:00', end: '18:00' }],
      },
      {
        id: 3,
        uid: '33333333-3333-4333-8333-333333333333',
        name: 'Dr Unscheduled',
        department: 'Cardiology',
        available_hours: null,
      },
    ]);

    const result = await doctorService.getAvailableDoctors({ department: 'Cardiology' });

    expect(result.currentTime).toEqual(expect.objectContaining({ day: 'MONDAY', hour: 10, minute: 0 }));
    expect(result.doctors.map((d) => d.name)).toEqual(['Dr Current']);

    const sql = queryRawMock.mock.calls[0][0];
    expect(sql).toMatch(/d\.is_available = true/);
    expect(sql).toMatch(/unnest\(d\.available_days\)/);
    expect(sql).toMatch(/UPPER\(d\.department\) = UPPER\(\$2\)/);
    expect(queryRawMock.mock.calls[0][1]).toBe('MONDAY');
    expect(queryRawMock.mock.calls[0][2]).toBe('Cardiology');
  });
});
