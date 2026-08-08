import { jest } from '@jest/globals';

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: jest.fn(),
}));

const {
  PATIENT_READINESS_CONTRACT_VERSION,
  PATIENT_READINESS_ENDPOINT_ID,
  PATIENT_READINESS_PURPOSE,
  evaluatePatientReadiness,
} = await import('../../services/health/patientReadinessService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-08-07T01:02:03.000Z');

function verifiedScopeRunner() {
  return jest.fn(async (tenantId, callback) =>
    callback({
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        { tenant_id: tenantId, tenant_scope: tenantId },
      ]),
    }),
  );
}

describe('patientReadinessService', () => {
  it('proves the active tenant and exact RLS scope on the primary client', async () => {
    const scopeRunner = verifiedScopeRunner();
    const result = await evaluatePatientReadiness({
      tenantId: TENANT.toUpperCase(),
      routeKind: 'PUBLIC',
      clock: () => NOW,
      scopeRunner,
    });

    expect(scopeRunner).toHaveBeenCalledTimes(1);
    expect(scopeRunner).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(scopeRunner.mock.calls[0]).toHaveLength(2);
    expect(result).toEqual({
      statusCode: 200,
      internalError: null,
      payload: {
        readinessContractVersion: PATIENT_READINESS_CONTRACT_VERSION,
        readinessPurpose: PATIENT_READINESS_PURPOSE,
        ready: true,
        endpointId: PATIENT_READINESS_ENDPOINT_ID,
        routeKind: 'public',
        tenantId: TENANT,
        database: 'ready',
        serverTime: NOW.toISOString(),
      },
    });
    expect(result.payload).not.toHaveProperty('policy');

    const tx = { $queryRawUnsafe: jest.fn().mockResolvedValue([]) };
    await scopeRunner.mock.calls[0][1](tx);
    const [sql, tenantParam] = tx.$queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/FROM tenants t/i);
    expect(sql).toMatch(/t\.status = 'active'/i);
    expect(sql).toMatch(/current_setting\('app\.current_tenant_id', true\)/i);
    expect(sql).toMatch(/= \$1::text/i);
    expect(tenantParam).toBe(TENANT);
  });

  it('fails before database access when the ingress route marker is untrusted', async () => {
    const scopeRunner = jest.fn();
    for (const routeKind of [undefined, '', 'caller-supplied']) {
      const result = await evaluatePatientReadiness({
        tenantId: TENANT,
        routeKind,
        clock: () => NOW,
        scopeRunner,
      });
      expect(result.payload).toEqual({
        readinessContractVersion: 1,
        readinessPurpose: 'patient_outage',
        ready: false,
        serverTime: NOW.toISOString(),
        state: 'endpoint_unverified',
      });
    }
    expect(scopeRunner).not.toHaveBeenCalled();
  });

  it('fails closed when the tenant is invalid, inactive, or scoped differently', async () => {
    const invalid = await evaluatePatientReadiness({
      tenantId: 'not-a-tenant',
      routeKind: 'public',
      clock: () => NOW,
      scopeRunner: jest.fn(),
    });
    expect(invalid.payload.state).toBe('database_unavailable');

    for (const rows of [
      [],
      [{ tenant_id: TENANT, tenant_scope: '11111111-1111-4111-8111-111111111111' }],
    ]) {
      const result = await evaluatePatientReadiness({
        tenantId: TENANT,
        routeKind: 'internal',
        clock: () => NOW,
        scopeRunner: async (_tenantId, callback) =>
          callback({ $queryRawUnsafe: jest.fn().mockResolvedValue(rows) }),
      });
      expect(result.payload).toEqual({
        readinessContractVersion: 1,
        readinessPurpose: 'patient_outage',
        ready: false,
        routeKind: 'internal',
        serverTime: NOW.toISOString(),
        state: 'database_unavailable',
      });
      expect(result.internalError).toBeInstanceOf(Error);
    }
  });

  it('keeps database errors and policy material out of the failure projection', async () => {
    const internalError = new Error('patient_name column on db.internal failed');
    const result = await evaluatePatientReadiness({
      tenantId: TENANT,
      routeKind: 'public',
      clock: () => NOW,
      scopeRunner: jest.fn().mockRejectedValue(internalError),
    });

    expect(result.internalError).toBe(internalError);
    expect(result.payload).toEqual({
      readinessContractVersion: 1,
      readinessPurpose: 'patient_outage',
      ready: false,
      routeKind: 'public',
      serverTime: NOW.toISOString(),
      state: 'database_unavailable',
    });
    expect(JSON.stringify(result.payload)).not.toMatch(
      /patient_name|column|db\.internal|policy/i,
    );
  });
});
