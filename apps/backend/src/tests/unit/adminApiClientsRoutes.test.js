/**
 * routes/admin/mfaApiClientsRoutes.js used to serve two unrelated concerns.
 * The /api/v1/admin/mfa half was a second, parallel TOTP stack (six endpoints
 * over services/auth/mfaService.js and the migration-120 mfa_* tables) with no
 * caller in any client; it was removed in the re-audit 2026-08-23 pass. The
 * live admin MFA path is controllers/auth/adminAuthController, mounted at
 * /api/v1/auth/admin/mfa/*.
 *
 * This suite pins both directions: the parallel stack stays gone, and the
 * API-client half that shared the file stays wired.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const ACTOR = '11111111-1111-4111-8111-111111111111';
const TENANT = '00000000-0000-4000-8000-000000000001';

const issueApiKeyMock = jest.fn(async () => ({ id: 9, plaintext: 'k' }));
const listApiClientsMock = jest.fn(async () => ({ clients: [], count: 0 }));
const listApiKeysMock = jest.fn(async () => ({ keys: [], count: 0 }));
const rotateApiKeyMock = jest.fn(async () => ({ id: 10 }));
const revokeApiKeyMock = jest.fn(async () => ({ id: 9 }));
const upsertApiClientMock = jest.fn(async () => ({ id: 3 }));

jest.unstable_mockModule('../../services/auth/apiClientService.js', () => ({
  issueApiKey: issueApiKeyMock,
  listApiClients: listApiClientsMock,
  listApiKeys: listApiKeysMock,
  rotateApiKey: rotateApiKeyMock,
  revokeApiKey: revokeApiKeyMock,
  upsertApiClient: upsertApiClientMock,
}));

const routeModule = await import('../../routes/admin/mfaApiClientsRoutes.js');

function filesUnder(target) {
  if (!fs.statSync(target).isDirectory()) return [target];
  return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) return filesUnder(child);
    return entry.name.endsWith('.js') ? [child] : [];
  });
}

function buildApp(mountPath, router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = TENANT;
    req.user = { uid: ACTOR, role: 'SUPER_ADMIN' };
    next();
  });
  app.use(mountPath, router);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ code: err.code, message: err.message });
  });
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('parallel Phase-B4 admin MFA stack is removed', () => {
  it('services/auth/mfaService.js no longer exists', () => {
    expect(fs.existsSync(path.join(srcRoot, 'services', 'auth', 'mfaService.js'))).toBe(false);
  });

  it('no non-test source file imports the deleted mfaService', () => {
    // Module specifiers only — the surviving route file names the removed
    // service in a prose docblock, which is documentation, not a dependency.
    const importsMfaService = /\b(?:from|import|require)\s*\(?\s*['"][^'"]*auth\/mfaService\.js['"]/;
    const offenders = filesUnder(srcRoot)
      .filter((file) => !file.includes(`${path.sep}tests${path.sep}`))
      .filter((file) => importsMfaService.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(srcRoot, file));

    expect(offenders).toEqual([]);
  });

  it('the route module exports the API-client router and nothing else', () => {
    expect(Object.keys(routeModule).sort()).toEqual(['apiClientsRouter', 'default']);
    expect(routeModule.default).toBe(routeModule.apiClientsRouter);
  });

  it('the admin barrel mounts no /mfa router', () => {
    const barrel = fs.readFileSync(path.join(srcRoot, 'routes', 'admin', 'index.js'), 'utf8');

    expect(barrel).not.toMatch(/mfaRouter/);
    expect(barrel).not.toMatch(/router\.use\(\s*'\/mfa'/);
  });

  it.each([
    ['post', '/mfa/devices'],
    ['post', '/mfa/devices/7/verify'],
    ['post', '/mfa/authenticate'],
    ['post', '/mfa/backup-codes/consume'],
    ['patch', '/mfa/devices/7/revoke'],
    ['get', '/mfa/devices'],
  ])('%s %s is no longer served', async (method, url) => {
    const app = buildApp('/mfa', routeModule.default);

    const res = await request(app)[method](url).send({ code: '123456' });

    expect(res.status).toBe(404);
  });
});

describe('admin API-client routes stay wired', () => {
  it('lists API clients for the request tenant', async () => {
    const res = await request(buildApp('/api-clients', routeModule.apiClientsRouter))
      .get('/api-clients')
      .query({ status: 'active' });

    expect(res.status).toBe(200);
    expect(listApiClientsMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      status: 'active',
    }));
  });

  it('upserts an API client and stamps the acting admin', async () => {
    const res = await request(buildApp('/api-clients', routeModule.apiClientsRouter))
      .put('/api-clients')
      .send({ client_code: 'partner-a', display_name: 'Partner A' });

    expect(res.status).toBe(200);
    expect(upsertApiClientMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      clientCode: 'partner-a',
      createdBy: ACTOR,
    }));
  });

  it('issues, rotates and revokes API keys', async () => {
    const app = buildApp('/api-clients', routeModule.apiClientsRouter);

    const issued = await request(app).post('/api-clients/4/keys').send({ display_name: 'ci' });
    const rotated = await request(app).post('/api-clients/4/keys/9/rotate').send({});
    const revoked = await request(app).patch('/api-clients/keys/9/revoke').send({ revoked_reason: 'leaked' });

    expect(issued.status).toBe(201);
    expect(rotated.status).toBe(200);
    expect(revoked.status).toBe(200);
    expect(issueApiKeyMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      apiClientId: '4',
      createdBy: ACTOR,
    }));
    expect(rotateApiKeyMock).toHaveBeenCalledWith(expect.objectContaining({
      apiClientId: '4',
      id: '9',
      revokedReason: 'rotated',
    }));
    expect(revokeApiKeyMock).toHaveBeenCalledWith(expect.objectContaining({
      id: '9',
      revokedReason: 'leaked',
    }));
  });

  it('lists API keys for a client', async () => {
    const res = await request(buildApp('/api-clients', routeModule.apiClientsRouter))
      .get('/api-clients/4/keys')
      .query({ status: 'active' });

    expect(res.status).toBe(200);
    expect(listApiKeysMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      apiClientId: '4',
      status: 'active',
    }));
  });
});
