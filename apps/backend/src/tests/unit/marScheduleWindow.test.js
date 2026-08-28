// C-L3 — expandSchedule silently clamped duration_days to 14, so an
// OD × 30-day prescription scheduled only 14 days of doses; days 15–30 never
// existed on the MAR and neither the ordering doctor nor the ward nurse was
// told. The fix honours durations up to MAR_SCHEDULE_LIMITS.maxScheduleDays
// (default 30) IN FULL and turns anything beyond the window — or beyond the
// absolute dose ceiling — into a loud 400, never a silent truncation.
//
// scheduleMedications expands frequencies in Phase 0, before any DB access,
// so the window refusal is provable with a mocked prisma: no row is written.

import { jest } from '@jest/globals';

const prismaMock = { $queryRawUnsafe: jest.fn() };
const setTenantTxMock = jest.fn(async (_tenantId, fn) => fn(prismaMock));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: setTenantTxMock,
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(prismaMock),
  pickTenantClient: () => prismaMock,
  isTenantTransactionClient: () => true,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { scheduleMedications } = await import('../../services/clinical/marService.js');

const PATIENT_UID = '10000000-0000-4000-8000-00000000c1e3';
const TENANT = '00000000-0000-4000-8000-000000000001';

function med(overrides = {}) {
  return {
    medication_name: 'Metformin',
    dose: '500mg',
    route: 'oral',
    frequency: 'OD',
    start_time: '2026-08-01T08:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Phase-0 dup pre-check finds an existing sibling for every slot, so the
  // full expansion is observable through the idempotent-return path with no
  // insert transaction at all.
  prismaMock.$queryRawUnsafe.mockImplementation(async () => [
    { id: 1, patient_uid: PATIENT_UID, status: 'scheduled' },
  ]);
});

describe('scheduleMedications — duration window (C-L3)', () => {
  it('honours a 30-day OD duration in full (was silently clamped to 14 days)', async () => {
    const results = await scheduleMedications(
      PATIENT_UID, null, [med({ duration_days: 30 })], { tenantId: TENANT },
    );
    expect(results).toHaveLength(30); // one dose per day, all 30 days scheduled
    expect(setTenantTxMock).not.toHaveBeenCalled(); // dedupe path — nothing written
  });

  it('refuses a duration beyond the window with a loud 400 instead of truncating', async () => {
    await expect(
      scheduleMedications(PATIENT_UID, null, [med({ duration_days: 45 })], { tenantId: TENANT }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'MAR_DURATION_EXCEEDS_WINDOW',
      details: { requested_days: 45, max_schedule_days: 30 },
    });
    // Phase-0 refusal: no row was read or written for the rejected schedule.
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  it('refuses an expansion beyond the absolute dose ceiling (q1h abuse guard)', async () => {
    await expect(
      scheduleMedications(
        PATIENT_UID, null, [med({ frequency: 'q1h', duration_days: 20 })], { tenantId: TENANT },
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'MAR_SCHEDULE_DOSE_CEILING',
    });
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('still expands BD × 5 days to 10 doses (H D12 regression)', async () => {
    const results = await scheduleMedications(
      PATIENT_UID, null, [med({ frequency: 'BD', duration_days: 5 })], { tenantId: TENANT },
    );
    expect(results).toHaveLength(10);
  });

  it('still rejects an unrecognised frequency with the existing loud 400', async () => {
    await expect(
      scheduleMedications(
        PATIENT_UID, null, [med({ frequency: 'whenever convenient' })], { tenantId: TENANT },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
