// Unit regression for Phase-3 B-L1.
//
// The completed-request branch of the housekeeping photo purge nulled
// photo_key/photo_url/completion_photo_key/completion_photo_url even when the
// R2 delete FAILED — the key was the only pointer to the object, so a
// transient R2 outage orphaned the file in the bucket forever while the DB
// claimed it was purged (and the next run could no longer retry it).
//
// Fixed behaviour proven here:
//   * a photo ref is nulled ONLY after its own R2 delete succeeded;
//   * a failed delete leaves that ref intact so the next daily run retries;
//   * when every delete fails, the row is not touched at all;
//   * the completed-request retention window runs from RESOLUTION
//     (completed_at/verified_at), not created_at.

import { jest } from '@jest/globals';

const queryRawMock = jest.fn();
const deleteObjectMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawMock },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../utils/r2Storage.js', () => ({
  deleteObject: deleteObjectMock,
}));

const { purgeHousekeepingPhotos } = await import('../../utils/housekeepingPurgeJob.js');

function routeQueries({ completedRows = [] } = {}) {
  queryRawMock.mockImplementation(async (sql) => {
    if (/FROM housekeeping_logs/.test(sql)) return [];
    if (/FROM housekeeping_requests/.test(sql) && /completed/.test(sql) && /SELECT/.test(sql)) {
      return completedRows;
    }
    if (/FROM housekeeping_requests/.test(sql) && /'open','assigned'/.test(sql)) return [];
    if (/^\s*UPDATE housekeeping_requests/.test(sql)) return [];
    return [];
  });
}

function updateCalls() {
  return queryRawMock.mock.calls.filter(([sql]) => /^\s*UPDATE housekeeping_requests/.test(sql));
}

beforeEach(() => {
  queryRawMock.mockReset();
  deleteObjectMock.mockReset();
});

describe('housekeeping photo purge — completed-request branch (B-L1)', () => {
  it('nulls only the refs whose R2 delete succeeded; failed keys stay for retry', async () => {
    routeQueries({
      completedRows: [{ id: 7, photo_key: 'hk/before.jpg', completion_photo_key: 'hk/after.jpg' }],
    });
    deleteObjectMock.mockImplementation(async (key) => {
      if (key === 'hk/after.jpg') throw new Error('R2 unavailable');
      return true;
    });

    const result = await purgeHousekeepingPhotos();

    expect(result.purged).toBe(1);
    expect(result.errors).toBe(1);
    const updates = updateCalls();
    expect(updates).toHaveLength(1);
    const [sql, id] = updates[0];
    expect(id).toBe(7);
    expect(sql).toContain('photo_key = NULL');
    expect(sql).toContain('photo_url = NULL');
    expect(sql).not.toContain('completion_photo_key');
    expect(sql).not.toContain('completion_photo_url');
  });

  it('leaves the row untouched when every delete failed', async () => {
    routeQueries({
      completedRows: [{ id: 8, photo_key: 'hk/one.jpg', completion_photo_key: 'hk/two.jpg' }],
    });
    deleteObjectMock.mockRejectedValue(new Error('R2 down'));

    const result = await purgeHousekeepingPhotos();

    expect(result.purged).toBe(0);
    expect(result.errors).toBe(2);
    expect(updateCalls()).toHaveLength(0);
  });

  it('nulls both pairs when both deletes succeed', async () => {
    routeQueries({
      completedRows: [{ id: 9, photo_key: 'hk/a.jpg', completion_photo_key: 'hk/b.jpg' }],
    });
    deleteObjectMock.mockResolvedValue(true);

    const result = await purgeHousekeepingPhotos();

    expect(result.purged).toBe(2);
    expect(result.errors).toBe(0);
    const updates = updateCalls();
    expect(updates).toHaveLength(1);
    expect(updates[0][0]).toContain('photo_key = NULL');
    expect(updates[0][0]).toContain('completion_photo_key = NULL');
  });

  it('keys the completed-request retention window to resolution time, not created_at', async () => {
    routeQueries({ completedRows: [] });
    deleteObjectMock.mockResolvedValue(true);

    await purgeHousekeepingPhotos();

    const selectCompleted = queryRawMock.mock.calls.find(
      ([sql]) => /FROM housekeeping_requests/.test(sql) && /'completed','verified','closed'/.test(sql),
    );
    expect(selectCompleted).toBeDefined();
    expect(selectCompleted[0]).toContain('COALESCE(completed_at, verified_at, created_at)');
  });
});
