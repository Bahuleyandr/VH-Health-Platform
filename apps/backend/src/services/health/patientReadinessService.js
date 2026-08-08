import { setTenantTx } from '../../lib/prisma.js';

export const PATIENT_READINESS_CONTRACT_VERSION = 1;
export const PATIENT_READINESS_PURPOSE = 'patient_outage';
export const PATIENT_READINESS_ENDPOINT_ID = 'vhhealth-api';

const ROUTE_KINDS = new Set(['public', 'internal']);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function serverTime(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Patient readiness clock returned an invalid timestamp');
  }
  return date.toISOString();
}

function notReady({ routeKind, clock, state, internalError = null }) {
  return {
    statusCode: 503,
    payload: {
      readinessContractVersion: PATIENT_READINESS_CONTRACT_VERSION,
      readinessPurpose: PATIENT_READINESS_PURPOSE,
      ready: false,
      ...(ROUTE_KINDS.has(routeKind) ? { routeKind } : {}),
      serverTime: serverTime(clock),
      state,
    },
    internalError,
  };
}

export async function evaluatePatientReadiness({
  tenantId,
  routeKind,
  clock = () => new Date(),
  scopeRunner = setTenantTx,
} = {}) {
  const normalizedTenantId = String(tenantId ?? '').trim().toLowerCase();
  const normalizedRouteKind = String(routeKind ?? '').trim().toLowerCase();

  if (!ROUTE_KINDS.has(normalizedRouteKind)) {
    return notReady({
      routeKind: normalizedRouteKind,
      clock,
      state: 'endpoint_unverified',
    });
  }

  if (!UUID_PATTERN.test(normalizedTenantId)) {
    return notReady({
      routeKind: normalizedRouteKind,
      clock,
      state: 'database_unavailable',
      internalError: new Error('Patient readiness requires a resolved tenant UUID'),
    });
  }

  try {
    const rows = await scopeRunner(normalizedTenantId, async tx =>
      tx.$queryRawUnsafe(
        `SELECT t.id::text AS tenant_id,
                NULLIF(current_setting('app.current_tenant_id', true), '') AS tenant_scope
           FROM tenants t
          WHERE t.id = $1::uuid
            AND t.status = 'active'
            AND NULLIF(current_setting('app.current_tenant_id', true), '') = $1::text
          LIMIT 1`,
        normalizedTenantId,
      ),
    );
    const tenant = rows[0];
    if (
      String(tenant?.tenant_id ?? '').toLowerCase() !== normalizedTenantId ||
      String(tenant?.tenant_scope ?? '').toLowerCase() !== normalizedTenantId
    ) {
      return notReady({
        routeKind: normalizedRouteKind,
        clock,
        state: 'database_unavailable',
        internalError: new Error('Patient readiness tenant probe did not verify'),
      });
    }
  } catch (internalError) {
    return notReady({
      routeKind: normalizedRouteKind,
      clock,
      state: 'database_unavailable',
      internalError,
    });
  }

  return {
    statusCode: 200,
    payload: {
      readinessContractVersion: PATIENT_READINESS_CONTRACT_VERSION,
      readinessPurpose: PATIENT_READINESS_PURPOSE,
      ready: true,
      endpointId: PATIENT_READINESS_ENDPOINT_ID,
      routeKind: normalizedRouteKind,
      tenantId: normalizedTenantId,
      database: 'ready',
      serverTime: serverTime(clock),
    },
    internalError: null,
  };
}
