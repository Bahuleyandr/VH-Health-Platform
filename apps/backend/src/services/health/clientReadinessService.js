import {
  CLINICAL_CONTINUITY_POLICY_SCHEMA_VERSION,
  loadActiveClinicalContinuityPoliciesForTenant,
} from '../downtime/clinicalContinuityPolicyService.js';
import {
  resolveClinicalContinuityFacilityContext,
} from '../downtime/clinicalContinuityFacilityContextService.js';

export const CLIENT_READINESS_CONTRACT_VERSION = 1;
export const CLIENT_READINESS_FACILITY_CONTRACT_VERSION = 2;
export const CLIENT_READINESS_ENDPOINT_ID = 'vhhealth-api';

const ROUTE_KINDS = new Set(['public', 'internal']);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function serverTime(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Client readiness clock returned an invalid timestamp');
  }
  return date.toISOString();
}

function readyPayload({ tenantId, routeKind, clock }) {
  return {
    readinessContractVersion: CLIENT_READINESS_CONTRACT_VERSION,
    ready: true,
    endpointId: CLIENT_READINESS_ENDPOINT_ID,
    routeKind,
    tenantId,
    database: 'ready',
    policy: {
      state: 'compatible',
      schemaVersion: CLINICAL_CONTINUITY_POLICY_SCHEMA_VERSION,
    },
    serverTime: serverTime(clock),
  };
}

function notReady({ routeKind, clock, state, internalError = null }) {
  return {
    statusCode: 503,
    payload: {
      readinessContractVersion: CLIENT_READINESS_CONTRACT_VERSION,
      ready: false,
      ...(ROUTE_KINDS.has(routeKind) ? { routeKind } : {}),
      serverTime: serverTime(clock),
      state,
    },
    internalError,
  };
}

function isPolicyContractError(error) {
  return String(error?.code ?? '').startsWith('CONTINUITY_POLICY_');
}

export async function evaluateClientReadiness({
  tenantId,
  routeKind,
  clock = () => new Date(),
  loadPolicies = loadActiveClinicalContinuityPoliciesForTenant,
} = {}) {
  const normalizedTenantId = String(tenantId ?? '').trim().toLowerCase();
  const normalizedRouteKind = String(routeKind ?? '').trim().toLowerCase();
  if (!UUID_PATTERN.test(normalizedTenantId)) {
    throw new Error('Client readiness requires a resolved tenant UUID');
  }

  if (!ROUTE_KINDS.has(normalizedRouteKind)) {
    return notReady({
      routeKind: normalizedRouteKind,
      clock,
      state: 'endpoint_unverified',
    });
  }

  let policies;
  try {
    policies = await loadPolicies(normalizedTenantId, { readOnly: true });
  } catch (error) {
    if (isPolicyContractError(error)) {
      return notReady({
        routeKind: normalizedRouteKind,
        clock,
        state: 'policy_incompatible',
        internalError: error,
      });
    }
    return notReady({
      routeKind: normalizedRouteKind,
      clock,
      state: 'database_unavailable',
      internalError: error,
    });
  }

  if (!Array.isArray(policies) || policies.length === 0) {
    return notReady({
      routeKind: normalizedRouteKind,
      clock,
      state: 'policy_unavailable',
    });
  }

  const policyCompatible = policies.every(
    policy =>
      String(policy?.tenantId ?? '').toLowerCase() === normalizedTenantId &&
      policy?.policySchemaVersion === CLINICAL_CONTINUITY_POLICY_SCHEMA_VERSION,
  );
  if (!policyCompatible) {
    return notReady({
      routeKind: normalizedRouteKind,
      clock,
      state: 'policy_incompatible',
    });
  }

  return {
    statusCode: 200,
    payload: readyPayload({
      tenantId: normalizedTenantId,
      routeKind: normalizedRouteKind,
      clock,
    }),
    internalError: null,
  };
}

export async function evaluateFacilityClientReadiness({
  req,
  facilityContext,
  routeKind,
  clock = () => new Date(),
  resolveContext = resolveClinicalContinuityFacilityContext,
} = {}) {
  const normalizedRouteKind = String(routeKind ?? '').trim().toLowerCase();
  if (!ROUTE_KINDS.has(normalizedRouteKind)) {
    const result = notReady({
      routeKind: normalizedRouteKind,
      clock,
      state: 'endpoint_unverified',
    });
    return {
      ...result,
      payload: {
        ...result.payload,
        readinessContractVersion: CLIENT_READINESS_FACILITY_CONTRACT_VERSION,
      },
    };
  }

  try {
    const context = await resolveContext({
      req,
      envelope: facilityContext,
      clock,
    });
    return {
      statusCode: 200,
      payload: {
        readinessContractVersion: CLIENT_READINESS_FACILITY_CONTRACT_VERSION,
        ready: true,
        endpointId: CLIENT_READINESS_ENDPOINT_ID,
        routeKind: normalizedRouteKind,
        tenantId: context.tenantId,
        database: 'ready',
        policy: {
          state: 'compatible',
          schemaVersion: 3,
        },
        facilityId: String(context.facilityId),
        contextId: context.contextId,
        contextRevision: context.contextRevision,
        serverTime: serverTime(clock),
      },
      internalError: null,
    };
  } catch (internalError) {
    return {
      statusCode: 503,
      payload: {
        readinessContractVersion: CLIENT_READINESS_FACILITY_CONTRACT_VERSION,
        ready: false,
        routeKind: normalizedRouteKind,
        serverTime: serverTime(clock),
        state: 'facility_context_unverified',
      },
      internalError,
    };
  }
}
