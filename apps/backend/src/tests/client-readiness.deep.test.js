import { jest } from '@jest/globals';
import request from 'supertest';

const PATH = '/api/v1/health/client-readiness';
const TENANT = '00000000-0000-4000-8000-000000000001';
const loadPolicies = jest.fn();

jest.unstable_mockModule(
  '../services/downtime/clinicalContinuityPolicyService.js',
  () => ({
    CLINICAL_CONTINUITY_ACTION_POLICY_SCHEMA_VERSION: 3,
    CLINICAL_CONTINUITY_POLICY_SCHEMA_VERSION: 1,
    DEFAULT_TENANT_ID: TENANT,
    INCIDENT_PACKET_SIGNING_KEY_PURPOSE:
      'clinical_continuity_incident_packet_signing',
    INCIDENT_PACKET_SIGNING_PURPOSE:
      'vhhealth/continuity/incident-packet/v1',
    enumerateActiveClinicalContinuityPolicies: jest.fn(),
    loadActiveClinicalContinuityPoliciesForTenant: loadPolicies,
    loadActiveClinicalContinuityPolicyForFacilityTx: jest.fn(),
    loadHistoricalClinicalContinuityPolicyForActionTx: jest.fn(),
    requireClinicalContinuityIncidentPacketPolicy: jest.fn(),
  })
);

const { default: app } = await import('../app.js');
const { API_KEY, generateTestToken } = await import('./testClient.js');

function authHeaders(uid = '550e8400-e29b-41d4-a716-446655440022') {
  const token = generateTestToken('ADMIN', {
    uid,
    tenant_id: TENANT,
  });
  return {
    'x-api-key': API_KEY,
    Authorization: `Bearer ${token}`,
    'x-vh-route-kind': 'public',
  };
}

describe('GET /api/v1/health/client-readiness deep contract', () => {
  beforeEach(() => {
    loadPolicies.mockReset();
    loadPolicies.mockImplementation(async tenantId => [
      {
        tenantId,
        policySchemaVersion: 1,
        policyVersion: '2026.07.30'
      }
    ]);
  });

  it('requires both API key and an authenticated bearer and routes its tenant', async () => {
    const noApiKey = await request(app)
      .get(PATH)
      .set('Authorization', `Bearer ${generateTestToken('ADMIN')}`)
      .set('x-vh-route-kind', 'public');
    expect([401, 403]).toContain(noApiKey.statusCode);

    const noBearer = await request(app)
      .get(PATH)
      .set('x-api-key', API_KEY)
      .set('x-vh-route-kind', 'public');
    expect(noBearer.statusCode).toBe(401);

    // The continuity-policy contract remains staff-only. Patient outage
    // recovery uses the separate /patient-readiness operational contract.
    const patient = await request(app)
      .get(PATH)
      .set('x-api-key', API_KEY)
      .set(
        'Authorization',
        `Bearer ${generateTestToken('PATIENT', {
          uid: '550e8400-e29b-41d4-a716-446655440023',
          tenant_id: TENANT,
        })}`,
      )
      .set('x-vh-route-kind', 'public');
    expect(patient.statusCode).toBe(403);

    const secondTenant = '11111111-1111-4111-8111-111111111111';
    const routedTenant = await request(app)
      .get(PATH)
      .set('x-api-key', API_KEY)
      .set(
        'Authorization',
        `Bearer ${generateTestToken('ADMIN', {
          uid: '550e8400-e29b-41d4-a716-446655440026',
          tenant_id: secondTenant,
        })}`,
      )
      .set('x-vh-route-kind', 'public');
    expect(routedTenant.statusCode).toBe(200);
    expect(routedTenant.body.data.tenantId).toBe(secondTenant);
    expect(loadPolicies).toHaveBeenCalledWith(secondTenant, {
      readOnly: true
    });
  });

  it('serves staff the bounded continuity projection and no facility detail', async () => {
    const staffTenant = '22222222-2222-4222-8222-222222222222';
    const response = await request(app)
      .get(PATH)
      .set('x-api-key', API_KEY)
      .set(
        'Authorization',
        `Bearer ${generateTestToken('ADMIN', {
          uid: '550e8400-e29b-41d4-a716-446655440031',
          tenant_id: staffTenant,
        })}`,
      )
      .set('x-vh-route-kind', 'public');

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.body.data).sort()).toEqual(
      [
        'database',
        'endpointId',
        'policy',
        'readinessContractVersion',
        'ready',
        'routeKind',
        'serverTime',
        'tenantId',
      ].sort(),
    );
    expect(response.body.data.tenantId).toBe(staffTenant);
    expect(JSON.stringify(response.body)).not.toMatch(
      /patient|staff|facility|policyDocument|databaseHost|sql|prisma|column/i,
    );
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('still refuses a role outside the readiness list', async () => {
    // The gate must not become a no-op. DIETITIAN is one of the declared roles
    // that `clientReadinessRoutes` deliberately does not admit.
    const response = await request(app)
      .get(PATH)
      .set('x-api-key', API_KEY)
      .set(
        'Authorization',
        `Bearer ${generateTestToken('DIETITIAN', {
          uid: '550e8400-e29b-41d4-a716-446655440034',
          tenant_id: TENANT,
        })}`,
      )
      .set('x-vh-route-kind', 'public');
    expect(response.statusCode).toBe(403);
  });

  it('still refuses a PATIENT on the facility-aware readiness route', async () => {
    // Facility context is staff/facility material (facilityId, contextId,
    // contextRevision). Widening the read-only probe must not widen this.
    const response = await request(app)
      .post(`${PATH}/v2`)
      .set('x-api-key', API_KEY)
      .set(
        'Authorization',
        `Bearer ${generateTestToken('PATIENT', {
          uid: '550e8400-e29b-41d4-a716-446655440032',
          tenant_id: TENANT,
        })}`,
      )
      .set('x-vh-route-kind', 'public')
      .send({ facilityContext: {} });
    expect(response.statusCode).toBe(403);
  });

  it('fails closed for missing and unknown route markers', async () => {
    for (const marker of [null, 'caller-supplied']) {
      let operation = request(app).get(PATH);
      for (const [name, value] of Object.entries(authHeaders())) {
        if (name === 'x-vh-route-kind' && marker === null) continue;
        operation = operation.set(name, name === 'x-vh-route-kind' ? marker : value);
      }
      const response = await operation;
      expect(response.statusCode).toBe(503);
      expect(response.body).toMatchObject({
        success: false,
        code: 'CLIENT_NOT_READY',
        details: {
          readiness: {
            ready: false,
            state: 'endpoint_unverified',
          },
        },
      });
      expect(response.body.details.readiness).not.toHaveProperty('routeKind');
    }
  });

  it('returns only the bounded readiness schema and no PHI', async () => {
    const response = await request(app)
      .get(PATH)
      .set(authHeaders('00000000-0000-4000-8000-000000000024'));
    expect(response.statusCode).toBe(200);
    const readiness = response.body.data;
    expect(readiness).toBeDefined();
    const expectedKeys = [
      'database',
      'endpointId',
      'policy',
      'readinessContractVersion',
      'ready',
      'routeKind',
      'serverTime',
      'tenantId',
    ];
    expect(Object.keys(readiness).sort()).toEqual(expectedKeys.sort());
    expect(JSON.stringify(response.body)).not.toMatch(
      /patient|staff|facility|policyDocument|databaseHost|sql|prisma|column/i,
    );
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('fails closed with bounded disclosure for database and policy failures', async () => {
    const cases = [
      {
        configure: () => loadPolicies.mockRejectedValue(new Error('db host secret')),
        state: 'database_unavailable',
        uid: '550e8400-e29b-41d4-a716-446655440027'
      },
      {
        configure: () => loadPolicies.mockResolvedValue([]),
        state: 'policy_unavailable',
        uid: '550e8400-e29b-41d4-a716-446655440028'
      },
      {
        configure: () =>
          loadPolicies.mockResolvedValue([
            {
              tenantId: TENANT,
              policySchemaVersion: 2,
              policyVersion: 'future'
            }
          ]),
        state: 'policy_incompatible',
        uid: '550e8400-e29b-41d4-a716-446655440029'
      },
      {
        configure: () =>
          loadPolicies.mockResolvedValue([
            {
              tenantId: '11111111-1111-4111-8111-111111111111',
              policySchemaVersion: 1,
              policyVersion: 'wrong-tenant'
            }
          ]),
        state: 'policy_incompatible',
        uid: '550e8400-e29b-41d4-a716-446655440030'
      }
    ];

    for (const testCase of cases) {
      loadPolicies.mockReset();
      testCase.configure();
      const response = await request(app)
        .get(PATH)
        .set(authHeaders(testCase.uid));
      expect(response.statusCode).toBe(503);
      expect(response.body.details.readiness).toMatchObject({
        readinessContractVersion: 1,
        ready: false,
        routeKind: 'public',
        state: testCase.state
      });
      expect(Object.keys(response.body.details.readiness).sort()).toEqual(
        [
          'readinessContractVersion',
          'ready',
          'routeKind',
          'serverTime',
          'state'
        ].sort()
      );
      expect(JSON.stringify(response.body)).not.toMatch(
        /db host secret|patient|staff|facility|policyDocument|databaseHost|sql|prisma|column/i
      );
    }
  });

  it('enforces the dedicated rate limit and supplies Retry-After', async () => {
    const headers = authHeaders('00000000-0000-4000-8000-000000000025');
    let response;
    for (let index = 0; index <= 30; index++) {
      response = await request(app).get(PATH).set(headers);
    }
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBeDefined();
    expect(response.body).toMatchObject({
      success: false,
      code: 'RATE_LIMITED',
    });
  }, 30000);
});
