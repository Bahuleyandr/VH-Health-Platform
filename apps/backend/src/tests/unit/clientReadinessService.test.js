import { jest } from '@jest/globals';

import {
  CLIENT_READINESS_CONTRACT_VERSION,
  CLIENT_READINESS_ENDPOINT_ID,
  evaluateClientReadiness,
} from '../../services/health/clientReadinessService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-07-30T01:02:03.000Z');

function policy(overrides = {}) {
  return {
    tenantId: TENANT,
    policySchemaVersion: 1,
    ...overrides,
  };
}

describe('clientReadinessService', () => {
  it('returns the minimal ready contract for a verified internal route', async () => {
    const result = await evaluateClientReadiness({
      tenantId: TENANT,
      routeKind: 'internal',
      clock: () => NOW,
      loadPolicies: jest.fn().mockResolvedValue([policy()]),
    });

    expect(result).toEqual({
      statusCode: 200,
      internalError: null,
      payload: {
        readinessContractVersion: CLIENT_READINESS_CONTRACT_VERSION,
        ready: true,
        endpointId: CLIENT_READINESS_ENDPOINT_ID,
        routeKind: 'internal',
        tenantId: TENANT,
        database: 'ready',
        policy: { state: 'compatible', schemaVersion: 1 },
        serverTime: NOW.toISOString(),
      },
    });
  });

  it('fails closed before database access for missing or unknown route kind', async () => {
    const loadPolicies = jest.fn();
    for (const routeKind of [undefined, '', 'caller-supplied']) {
      const result = await evaluateClientReadiness({
        tenantId: TENANT,
        routeKind,
        clock: () => NOW,
        loadPolicies,
      });
      expect(result.statusCode).toBe(503);
      expect(result.payload).toMatchObject({
        ready: false,
        state: 'endpoint_unverified',
      });
      expect(result.payload).not.toHaveProperty('routeKind');
      expect(Object.keys(result.payload).sort()).toEqual(
        [
          'readinessContractVersion',
          'ready',
          'serverTime',
          'state',
        ].sort(),
      );
    }
    expect(loadPolicies).not.toHaveBeenCalled();
  });

  it('distinguishes database, missing-policy, and incompatible-policy failures', async () => {
    const databaseError = new Error('connection refused to internal-db-name');
    const database = await evaluateClientReadiness({
      tenantId: TENANT,
      routeKind: 'public',
      clock: () => NOW,
      loadPolicies: jest.fn().mockRejectedValue(databaseError),
    });
    expect(database.payload.state).toBe('database_unavailable');
    expect(database.internalError).toBe(databaseError);

    const unavailable = await evaluateClientReadiness({
      tenantId: TENANT,
      routeKind: 'public',
      clock: () => NOW,
      loadPolicies: jest.fn().mockResolvedValue([]),
    });
    expect(unavailable.payload.state).toBe('policy_unavailable');

    const incompatible = await evaluateClientReadiness({
      tenantId: TENANT,
      routeKind: 'public',
      clock: () => NOW,
      loadPolicies: jest.fn().mockResolvedValue([
        policy({ policySchemaVersion: 2 }),
      ]),
    });
    expect(incompatible.payload.state).toBe('policy_incompatible');
    for (const result of [database, unavailable, incompatible]) {
      expect(Object.keys(result.payload).sort()).toEqual(
        [
          'readinessContractVersion',
          'ready',
          'routeKind',
          'serverTime',
          'state',
        ].sort(),
      );
    }
  });

  it('rejects cross-tenant policy data and invalid tenant input', async () => {
    const mismatch = await evaluateClientReadiness({
      tenantId: TENANT,
      routeKind: 'public',
      clock: () => NOW,
      loadPolicies: jest.fn().mockResolvedValue([
        policy({ tenantId: '11111111-1111-4111-8111-111111111111' }),
      ]),
    });
    expect(mismatch.payload.state).toBe('policy_incompatible');

    await expect(
      evaluateClientReadiness({
        tenantId: 'not-a-tenant',
        routeKind: 'public',
        loadPolicies: jest.fn(),
      }),
    ).rejects.toThrow('resolved tenant UUID');
  });

  it('never serializes PHI or internal database error material', async () => {
    const result = await evaluateClientReadiness({
      tenantId: TENANT,
      routeKind: 'public',
      clock: () => NOW,
      loadPolicies: jest.fn().mockRejectedValue(
        new Error('patient_name column on db.internal failed'),
      ),
    });
    const serialized = JSON.stringify(result.payload);
    expect(serialized).not.toMatch(
      /patient|staff|facility|policyDocument|databaseHost|column|db\.internal/i,
    );
  });
});
