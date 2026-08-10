/**
 * ADM-2 (review 2026-08-10) — tenant-wide announcement banner routes.
 * The admin-portal banner is persisted in tenants.settings.announcementBanner;
 * GET is open to any authenticated portal user, PUT is ADMIN-gated, text is
 * sanitized and capped, and every save is audit-logged.
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const queryUnsafeMock = jest.fn();
const executeUnsafeMock = jest.fn();
const logAuditMock = jest.fn();
const requireRoleCalls = [];

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryUnsafeMock,
    $executeRawUnsafe: executeUnsafeMock,
  },
}));

jest.unstable_mockModule('../../middleware/rbacMiddleware.js', () => ({
  requireRole: (...roles) => {
    requireRoleCalls.push(roles);
    return (req, res, next) => {
      const role = String(req.user?.role || '').toUpperCase();
      if (!roles.map((r) => String(r).toUpperCase()).includes(role)) {
        return res.status(403).json({ success: false, message: 'Forbidden' });
      }
      return next();
    };
  },
}));

jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: logAuditMock,
}));

const { default: announcementBannerRoutes } = await import(
  '../../routes/notification/announcementBannerRoutes.js'
);

const TENANT = '00000000-0000-4000-8000-000000000001';

function makeApp({ tenantId = TENANT, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (tenantId) req.tenantId = tenantId;
    req.user = { uid: 'admin-1', role };
    next();
  });
  app.use('/announcement-banner', announcementBannerRoutes);
  return app;
}

beforeEach(() => {
  queryUnsafeMock.mockReset();
  executeUnsafeMock.mockReset();
  logAuditMock.mockReset();
  logAuditMock.mockResolvedValue(undefined);
});

describe('GET /announcement-banner', () => {
  it('returns the normalized tenant banner', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      {
        banner: {
          text: 'Maintenance tonight 10 PM',
          type: 'warning',
          enabled: true,
          updated_at: '2026-08-10T00:00:00.000Z',
        },
      },
    ]);

    const res = await request(makeApp()).get('/announcement-banner');

    expect(res.status).toBe(200);
    expect(res.body.data.banner).toEqual({
      text: 'Maintenance tonight 10 PM',
      type: 'warning',
      enabled: true,
      updated_at: '2026-08-10T00:00:00.000Z',
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls[0][1]).toBe(TENANT);
  });

  it('returns a null banner when none is configured', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ banner: null }]);
    const res = await request(makeApp()).get('/announcement-banner');
    expect(res.status).toBe(200);
    expect(res.body.data.banner).toBeNull();
  });

  it('returns a null banner without a tenant context', async () => {
    const res = await request(makeApp({ tenantId: null })).get(
      '/announcement-banner'
    );
    expect(res.status).toBe(200);
    expect(res.body.data.banner).toBeNull();
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('normalizes an off-vocabulary type and disables empty text', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { banner: { text: '', type: 'sparkly', enabled: true } },
    ]);
    const res = await request(makeApp()).get('/announcement-banner');
    expect(res.body.data.banner).toEqual({
      text: '',
      type: 'info',
      enabled: false,
      updated_at: null,
    });
  });
});

describe('PUT /announcement-banner', () => {
  it('is gated to ADMIN and SUPER_ADMIN', async () => {
    expect(requireRoleCalls).toContainEqual(['ADMIN', 'SUPER_ADMIN']);

    const res = await request(makeApp({ role: 'NURSING_STAFF' }))
      .put('/announcement-banner')
      .send({ text: 'x', type: 'info', enabled: true });
    expect(res.status).toBe(403);
    expect(executeUnsafeMock).not.toHaveBeenCalled();
  });

  it('sanitizes markup, caps length, persists, and audits', async () => {
    executeUnsafeMock.mockResolvedValueOnce(1);

    const res = await request(makeApp())
      .put('/announcement-banner')
      .send({
        text: '<script>alert(1)</script><b>Fire drill</b> at 10',
        type: 'critical',
        enabled: true,
      });

    expect(res.status).toBe(200);
    const saved = res.body.data.banner;
    expect(saved.text).toBe('Fire drill at 10');
    expect(saved.type).toBe('critical');
    expect(saved.enabled).toBe(true);
    expect(saved.updated_at).toEqual(expect.any(String));

    expect(executeUnsafeMock).toHaveBeenCalledTimes(1);
    const [sql, tenantArg, jsonArg] = executeUnsafeMock.mock.calls[0];
    expect(sql).toContain("jsonb_set");
    expect(sql).toContain('announcementBanner');
    expect(tenantArg).toBe(TENANT);
    expect(JSON.parse(jsonArg).text).toBe('Fire drill at 10');

    expect(logAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      'announcement-banner-updated',
      expect.objectContaining({ enabled: true, type: 'critical' })
    );
  });

  it('rejects an unknown type and a non-boolean enabled flag', async () => {
    const badType = await request(makeApp())
      .put('/announcement-banner')
      .send({ text: 'x', type: 'shiny', enabled: true });
    expect(badType.status).toBe(400);

    const badEnabled = await request(makeApp())
      .put('/announcement-banner')
      .send({ text: 'x', type: 'info', enabled: 'yes' });
    expect(badEnabled.status).toBe(400);
    expect(executeUnsafeMock).not.toHaveBeenCalled();
  });

  it('stores a disabled banner when text is empty (clear)', async () => {
    executeUnsafeMock.mockResolvedValueOnce(1);
    const res = await request(makeApp())
      .put('/announcement-banner')
      .send({ text: '', type: 'info', enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.data.banner.enabled).toBe(false);
  });

  it('404s without a tenant context', async () => {
    const res = await request(makeApp({ tenantId: null }))
      .put('/announcement-banner')
      .send({ text: 'x', type: 'info', enabled: true });
    expect(res.status).toBe(404);
  });
});
