import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const getRankingsMock = jest.fn();
const replaceRankingsMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: new Proxy({}, { get: () => jest.fn() }),
  prismaReadOnly: new Proxy({}, { get: () => jest.fn() }),
  setTenant: async (_tenantId, fn) => fn({}),
  setTenantTx: async (_tenantId, fn) => fn({}),
}));

jest.unstable_mockModule('../../services/workflow/escalationRecipientRankingService.js', () => ({
  getEscalationRecipientRankings: getRankingsMock,
  replaceEscalationRecipientRankings: replaceRankingsMock,
}));

const router = (await import('../../routes/admin/tenantRoutes.js')).default;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      uid: '22222222-2222-4222-8222-222222222222',
      role: 'ADMIN',
      rawRole: 'SUPER_ADMIN',
    };
    next();
  });
  app.use('/api/v1/admin/tenants', router);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ code: err.code || 'INTERNAL_ERROR' });
  });
  return app;
}

const TENANT = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  getRankingsMock.mockReset();
  replaceRankingsMock.mockReset();
});

describe('tenant escalation recipient ranking routes', () => {
  test('remain under the existing SUPER_ADMIN, step-up, IP-allowlisted route family', () => {
    const appSource = fs.readFileSync(path.resolve(__dirname, '../../app.js'), 'utf8');
    expect(appSource).toMatch(
      /app\.use\(\s*'\/api\/v1\/admin\/tenants',[\s\S]*?requireRole\('SUPER_ADMIN'\),[\s\S]*?requireSuperAdminStepUp,[\s\S]*?adminIpAllowlist,[\s\S]*?tenantRoutes\s*\)/,
    );
  });

  test('GET returns the distinct never-configured control state', async () => {
    getRankingsMock.mockResolvedValue({
      configured: false,
      explicitEmpty: false,
      revision: 0,
      presenceWindowMinutes: 720,
      expectedMappingCount: 0,
      mappings: [],
    });
    const response = await request(buildApp())
      .get(`/api/v1/admin/tenants/${TENANT}/escalation-recipient-rankings`);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ configured: false, explicitEmpty: false });
    expect(getRankingsMock).toHaveBeenCalledWith(TENANT);
  });

  test('PUT forwards only server-derived actor context to the atomic replacement service', async () => {
    replaceRankingsMock.mockResolvedValue({
      configured: true,
      explicitEmpty: true,
      revision: 1,
      presenceWindowMinutes: 720,
      expectedMappingCount: 0,
      mappings: [],
    });
    const response = await request(buildApp())
      .put(`/api/v1/admin/tenants/${TENANT}/escalation-recipient-rankings`)
      .send({
        mappings: [],
        presenceWindowMinutes: 720,
        actorUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        actorRole: 'DOCTOR',
      });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ configured: true, explicitEmpty: true });
    expect(replaceRankingsMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      mappings: [],
      presenceWindowMinutes: 720,
      actorUid: '22222222-2222-4222-8222-222222222222',
      actorRole: 'SUPER_ADMIN',
    }));
  });

  test('propagates validation failures without returning a fake success', async () => {
    replaceRankingsMock.mockRejectedValue(Object.assign(new Error('bad mapping'), {
      statusCode: 400,
      code: 'ESCALATION_RANK_MAPPING_DUPLICATE',
    }));
    const response = await request(buildApp())
      .put(`/api/v1/admin/tenants/${TENANT}/escalation-recipient-rankings`)
      .send({ mappings: [] });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('ESCALATION_RANK_MAPPING_DUPLICATE');
  });
});
