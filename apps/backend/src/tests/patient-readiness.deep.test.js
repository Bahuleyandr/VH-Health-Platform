import request from 'supertest';

import app from '../app.js';
import { API_KEY, generateTestToken, ensureTestIdentity } from './testClient.js';

const PATH = '/api/v1/health/patient-readiness';
const TENANT = '00000000-0000-4000-8000-000000000001';

function bearer(role = 'PATIENT', overrides = {}) {
  return `Bearer ${generateTestToken(role, {
    uid: '550e8400-e29b-41d4-a716-446655440042',
    tenant_id: TENANT,
    ...overrides,
  })}`;
}

describe('GET /api/v1/health/patient-readiness deep contract', () => {
  // Authentication fails closed when a token's subject has no live identity
  // row, so an invented uid 401s before this suite's authz gate is reached.
  beforeAll(async () => {
    await ensureTestIdentity('550e8400-e29b-41d4-a716-446655440042', { tenantId: TENANT });
  });
  it('requires the API key, patient JWT, tenant middleware, and patient role', async () => {
    const noApiKey = await request(app)
      .get(PATH)
      .set('Authorization', bearer())
      .set('x-vh-route-kind', 'public');
    expect([401, 403]).toContain(noApiKey.statusCode);

    const noBearer = await request(app)
      .get(PATH)
      .set('x-api-key', API_KEY)
      .set('x-vh-route-kind', 'public');
    expect(noBearer.statusCode).toBe(401);

    const staff = await request(app)
      .get(PATH)
      .set('x-api-key', API_KEY)
      .set('Authorization', bearer('ADMIN'))
      .set('x-vh-route-kind', 'public');
    expect(staff.statusCode).toBe(403);
  });

  it('returns the bounded patient outage projection from a primary tenant probe', async () => {
    const response = await request(app)
      .get(PATH)
      .set('x-api-key', API_KEY)
      .set('Authorization', bearer())
      .set('x-vh-route-kind', 'public');

    expect(response.statusCode).toBe(200);
    expect(response.body.data).toEqual({
      readinessContractVersion: 1,
      readinessPurpose: 'patient_outage',
      ready: true,
      endpointId: 'vhhealth-api',
      routeKind: 'public',
      tenantId: TENANT,
      database: 'ready',
      serverTime: expect.any(String),
    });
    expect(response.body.data).not.toHaveProperty('policy');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(response.body)).not.toMatch(
      /staff|facility|policyDocument|databaseHost|sql|prisma|column/i,
    );
  });

  it('fails closed with the exact bounded contract for an untrusted route marker', async () => {
    const response = await request(app)
      .get(PATH)
      .set('x-api-key', API_KEY)
      .set('Authorization', bearer())
      .set('x-vh-route-kind', 'caller-supplied');

    expect(response.statusCode).toBe(503);
    expect(response.body).toMatchObject({
      success: false,
      code: 'PATIENT_NOT_READY',
      details: {
        readiness: {
          readinessContractVersion: 1,
          readinessPurpose: 'patient_outage',
          ready: false,
          state: 'endpoint_unverified',
          serverTime: expect.any(String),
        },
      },
    });
    expect(Object.keys(response.body.details.readiness).sort()).toEqual(
      [
        'readinessContractVersion',
        'readinessPurpose',
        'ready',
        'serverTime',
        'state',
      ].sort(),
    );
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('keeps the strict continuity endpoint unavailable to patients', async () => {
    const response = await request(app)
      .get('/api/v1/health/client-readiness')
      .set('x-api-key', API_KEY)
      .set('Authorization', bearer())
      .set('x-vh-route-kind', 'public');
    expect(response.statusCode).toBe(403);
  });
});
