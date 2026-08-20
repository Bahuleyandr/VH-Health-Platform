// Behavior pins for the persistent system-settings surface
// (GET/PUT /api/v1/system/settings, migration 724).
//
// The previous controller queried a system_settings table that no migration
// had ever created, swallowed the resulting "relation does not exist" error,
// and answered 200 from a per-process in-memory object — so the admin CRUD
// smoke read green while every settings request errored in the Postgres logs
// and admin edits silently vanished on pod restart. These tests pin the new
// contract:
//   * reads merge DB rows OVER code defaults (empty table → pure defaults)
//   * writes persist via the ON CONFLICT (key) upsert — no in-memory shadow
//   * a database fault is a 500, never a fake-success fallback
//   * only allowlisted keys are written; an update with none is a 400

import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.unstable_mockModule('../../services/health/systemHealthService.js', () => ({
  getSystemStatus: jest.fn(() => ({ status: 'healthy' })),
}));

const { getSettings, updateSettings } = await import(
  '../../controllers/system/systemController.js'
);

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
});

describe('GET /system/settings', () => {
  it('merges persisted rows over code defaults', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([
      { key: 'maintenanceMode', value: 'true' },
      { key: 'maxAppointmentsPerDay', value: '75' },
    ]);
    const res = makeRes();

    await getSettings({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.maintenanceMode).toBe(true); // DB row wins
    expect(res.body.data.maxAppointmentsPerDay).toBe(75);
    expect(res.body.data.appName).toBe('VHHealth'); // default fills the gap
  });

  it('an empty table returns pure defaults (fresh deploys keep working)', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);
    const res = makeRes();

    await getSettings({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.maintenanceMode).toBe(false);
    expect(res.body.data.sessionTimeoutMinutes).toBe(60);
  });

  it('a database fault is a 500 — never a silent in-memory fallback', async () => {
    // The exact failure the old code swallowed for months.
    queryRawUnsafeMock.mockRejectedValueOnce(
      new Error('relation "system_settings" does not exist'),
    );
    const res = makeRes();

    await getSettings({}, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

describe('PUT /system/settings', () => {
  it('persists each allowlisted key via the ON CONFLICT upsert and answers with the re-read view', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([]) // upsert maintenanceMode
      .mockResolvedValueOnce([{ key: 'maintenanceMode', value: 'true' }]); // re-read
    const res = makeRes();

    await updateSettings(
      { body: { maintenanceMode: true, notAllowed: 'x' }, user: { uid: 'u1' } },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.data.maintenanceMode).toBe(true);

    const upsert = queryRawUnsafeMock.mock.calls[0];
    expect(upsert[0]).toContain('INSERT INTO system_settings');
    expect(upsert[0]).toContain('ON CONFLICT (key) DO UPDATE');
    expect(upsert[1]).toBe('maintenanceMode');
    expect(upsert[2]).toBe('true'); // JSON-encoded value
    // the disallowed key never reaches the database
    const writtenKeys = queryRawUnsafeMock.mock.calls
      .filter(([sql]) => sql.includes('INSERT'))
      .map((call) => call[1]);
    expect(writtenKeys).toEqual(['maintenanceMode']);
  });

  it('rejects an update containing no allowlisted key with a 400 and writes nothing', async () => {
    const res = makeRes();

    await updateSettings({ body: { bogus: 1 }, user: { uid: 'u1' } }, res);

    expect(res.statusCode).toBe(400);
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('a write failure is a 500 — the update is not faked into memory', async () => {
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('connection refused'));
    const res = makeRes();

    await updateSettings(
      { body: { maintenanceMode: true }, user: { uid: 'u1' } },
      res,
    );

    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
  });
});
