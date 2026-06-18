// Audit §3 (FHIR/interop) deferred MEDIUM — SMART-on-FHIR scope enforcement at
// the FHIR resource boundary.
//
// The platform issues + verifies SMART access tokens (smartOAuthService), but
// the FHIR routes historically gated only on the platform JWT (requireRole at
// the app.js mount). A registered SMART app's *granted scopes* were never
// enforced. This suite proves the additive enforcement that lives inside
// fhirRoutes.js:
//   - a SMART token WITHOUT the needed scope → 403 OperationOutcome
//   - a SMART token WITH the scope → allowed
//   - a SMART token scoped to patient A cannot read patient B → 403
//   - the existing platform-JWT (staff) path is UNCHANGED
//   - /metadata stays open
//
// These are mock-based router tests (the established fhirRoutesTenantIsolation
// pattern): the FHIR router is mounted on a bare express app and the
// smartOAuthService + prisma are mocked, so the enforcement branch can be
// driven deterministically for both token types. A companion DB-integration
// deep test (fhirSmartScope.deep.test.js) seeds a real registered app + token
// against the QA Postgres.

import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const TENANT_A = '00000000-0000-4000-8000-000000000001';
const PATIENT_A = '11111111-1111-4111-8111-111111111111';
const PATIENT_B = '22222222-2222-4222-8222-222222222222';
const ACTOR_UID = '33333333-3333-4333-8333-333333333333';

const SMART_TOKEN = 'vh_access_smarttoken_under_test';
const PLATFORM_JWT_PLACEHOLDER = 'platform.jwt.placeholder';

const queryRawUnsafeMock = jest.fn();
const verifyAccessTokenMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: TENANT_A,
}));

jest.unstable_mockModule('../../services/emr/vitalsChartService.js', () => ({
  recordVitals: jest.fn(),
}));

jest.unstable_mockModule('../../services/clinical/problemListService.js', () => ({
  createProblem: jest.fn(),
}));

jest.unstable_mockModule('../../services/terminology/clinicalCodeBindingService.js', () => ({
  attachResourceCodings: jest.fn(async (rows) => rows),
  normalizeClinicalCodings: jest.fn((codings) => codings),
  systemUriForKey: jest.fn((key) => key || 'urn:test-system'),
}));

// The access-decision primitive used by assertFhirPatientResolvable. In the
// SMART path we want the patient to resolve (so the SMART scope/context check
// is what governs, not the care-team shadow guard). Always allow.
jest.unstable_mockModule('../../services/security/accessDecisionService.js', () => ({
  authorizePatientAccessRequest: jest.fn(async () => ({ allowed: true })),
  patientAccessErrorPayload: jest.fn(() => ({ message: 'denied', code: 'DENIED' })),
}));

// The SMART scope-enforcement middleware verifies the bearer token through
// smartOAuthService.verifyAccessToken. Mock ONLY the network/DB-touching verify
// call so we control which tokens are recognised as SMART tokens (and with which
// scopes / patient context). scopesAllow is a pure function whose real
// implementation is unit-tested independently in smartOAuthService.test.js; mirror
// it here so the middleware exercises faithful scope-matching semantics without
// the module-caching ambiguity of importing the real module under a mock.
const SMART_SCOPE_RE = /^(patient|user|system)\/([A-Za-z*]+)\.(read|write|\*)$/;
function fakeScopesAllow(grantedScopes, { level = 'patient', resource, operation = 'read' } = {}) {
  if (!Array.isArray(grantedScopes) || !resource) return false;
  for (const scope of grantedScopes) {
    const m = SMART_SCOPE_RE.exec(String(scope).trim());
    if (!m) continue;
    const [, lvl, res, op] = m;
    if (lvl !== level) continue;
    if (res !== '*' && res !== resource) continue;
    if (op !== '*' && op !== operation) continue;
    return true;
  }
  return false;
}

jest.unstable_mockModule('../../services/smartFhir/smartOAuthService.js', () => ({
  default: {
    verifyAccessToken: verifyAccessTokenMock,
    scopesAllow: fakeScopesAllow,
  },
  verifyAccessToken: verifyAccessTokenMock,
  scopesAllow: fakeScopesAllow,
}));

const { default: fhirRouter } = await import('../../routes/fhir/fhirRoutes.js');

// Build an app that mimics the REAL app.js mount ORDER for the two token types:
//  - Platform JWT: jwtAuth populates req.user, requireRole passes, router runs.
//  - SMART token : jwtAuth would 401 a non-JWT bearer, so a platform JWT never
//    gets a req.user here; we leave req.user UNSET and let the bearer carry the
//    SMART token. This mirrors a mount-level SMART auth shim that runs when the
//    platform JWT is absent (see REPORT).
function buildApp({ asPlatformJwt = false } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = TENANT_A;
    if (asPlatformJwt) {
      // Simulates the platform JWT staff path (req.user populated by jwtAuth).
      req.user = { uid: ACTOR_UID, role: 'DOCTOR', tenantId: TENANT_A };
    }
    next();
  });
  app.use('/fhir', fhirRouter);
  return app;
}

function installObservationQueryMock() {
  queryRawUnsafeMock.mockImplementation(async (sql) => {
    const compact = String(sql).replace(/\s+/g, ' ');
    if (compact.includes('FROM vitals_chart v')) {
      return [{
        id: 'vital-1-heart_rate',
        patient_uid: PATIENT_A,
        type: 'heart_rate',
        value: '72',
        unit: 'beats/min',
        recorded_date: '2026-06-11T10:00:00.000Z',
        recorded_by: ACTOR_UID,
      }];
    }
    if (compact.includes('FROM users') && compact.includes("role = 'PATIENT'")) {
      return [{
        uid: PATIENT_A, phone: '9000000001', name: 'Patient A',
        gender: 'female', is_active: true,
      }];
    }
    return [];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  installObservationQueryMock();
});

describe('FHIR SMART-on-FHIR scope enforcement', () => {
  describe('/metadata stays open', () => {
    it('serves the CapabilityStatement with no token at all', async () => {
      // No platform JWT, no SMART token, verifyAccessToken returns null.
      verifyAccessTokenMock.mockResolvedValue(null);
      const res = await request(buildApp()).get('/fhir/metadata');
      expect(res.status).toBe(200);
      expect(res.body.resourceType).toBe('CapabilityStatement');
      expect(verifyAccessTokenMock).not.toHaveBeenCalled();
    });
  });

  describe('platform JWT (staff) path is UNCHANGED', () => {
    it('does not consult the SMART verifier when req.user is present', async () => {
      const res = await request(buildApp({ asPlatformJwt: true }))
        .get('/fhir/Observation')
        .query({ patient: PATIENT_A });
      expect(res.status).toBe(200);
      expect(res.body.resourceType).toBe('Bundle');
      // The staff path must never touch the SMART token machinery.
      expect(verifyAccessTokenMock).not.toHaveBeenCalled();
    });
  });

  describe('SMART token WITH the needed scope → allowed', () => {
    it('allows a patient/Observation.read token to read Observation', async () => {
      verifyAccessTokenMock.mockResolvedValue({
        id: 10,
        granted_scopes: ['patient/Observation.read'],
        patient_uid: PATIENT_A,
        user_uid: null,
        user_role: null,
        client_id: 'app-under-test',
      });
      const res = await request(buildApp())
        .get('/fhir/Observation')
        .query({ patient: PATIENT_A })
        .set('Authorization', `Bearer ${SMART_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.resourceType).toBe('Bundle');
      expect(verifyAccessTokenMock).toHaveBeenCalledTimes(1);
    });

    it('allows a user/*.read token (org-wide context) to read Observation', async () => {
      verifyAccessTokenMock.mockResolvedValue({
        id: 11,
        granted_scopes: ['user/*.read'],
        patient_uid: null,
        user_uid: ACTOR_UID,
        user_role: 'DOCTOR',
        client_id: 'app-under-test',
      });
      const res = await request(buildApp())
        .get('/fhir/Observation')
        .query({ patient: PATIENT_A })
        .set('Authorization', `Bearer ${SMART_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.resourceType).toBe('Bundle');
    });
  });

  describe('SMART token WITHOUT the needed scope → 403', () => {
    it('rejects a patient/Patient.read token reading Observation', async () => {
      verifyAccessTokenMock.mockResolvedValue({
        id: 12,
        granted_scopes: ['patient/Patient.read'],
        patient_uid: PATIENT_A,
        user_uid: null,
        user_role: null,
        client_id: 'app-under-test',
      });
      const res = await request(buildApp())
        .get('/fhir/Observation')
        .query({ patient: PATIENT_A })
        .set('Authorization', `Bearer ${SMART_TOKEN}`);
      expect(res.status).toBe(403);
      expect(res.body.resourceType).toBe('OperationOutcome');
      expect(res.body.issue[0].code).toBe('forbidden');
      // The query must never run — enforcement happens before the handler.
      expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    });

    it('rejects a read-only token attempting a write (POST Observation)', async () => {
      verifyAccessTokenMock.mockResolvedValue({
        id: 13,
        granted_scopes: ['patient/Observation.read'],
        patient_uid: PATIENT_A,
        user_uid: null,
        user_role: null,
        client_id: 'app-under-test',
      });
      const res = await request(buildApp())
        .post('/fhir/Observation')
        .set('Authorization', `Bearer ${SMART_TOKEN}`)
        .send({
          resourceType: 'Observation',
          status: 'final',
          code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
          subject: { reference: `Patient/${PATIENT_A}` },
          valueQuantity: { value: 72, unit: 'beats/min' },
        });
      expect(res.status).toBe(403);
      expect(res.body.resourceType).toBe('OperationOutcome');
      expect(res.body.issue[0].code).toBe('forbidden');
    });
  });

  describe('patient-context confinement (A cannot read B)', () => {
    it('rejects a token scoped to patient A reading patient B Observations', async () => {
      verifyAccessTokenMock.mockResolvedValue({
        id: 14,
        granted_scopes: ['patient/Observation.read'],
        patient_uid: PATIENT_A,
        user_uid: null,
        user_role: null,
        client_id: 'app-under-test',
      });
      const res = await request(buildApp())
        .get('/fhir/Observation')
        .query({ patient: PATIENT_B })
        .set('Authorization', `Bearer ${SMART_TOKEN}`);
      expect(res.status).toBe(403);
      expect(res.body.resourceType).toBe('OperationOutcome');
      expect(res.body.issue[0].code).toBe('forbidden');
      expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    });

    it('rejects a patient-context token reading patient B by path (Patient/:id)', async () => {
      verifyAccessTokenMock.mockResolvedValue({
        id: 15,
        granted_scopes: ['patient/Patient.read'],
        patient_uid: PATIENT_A,
        user_uid: null,
        user_role: null,
        client_id: 'app-under-test',
      });
      const res = await request(buildApp())
        .get(`/fhir/Patient/${PATIENT_B}`)
        .set('Authorization', `Bearer ${SMART_TOKEN}`);
      expect(res.status).toBe(403);
      expect(res.body.resourceType).toBe('OperationOutcome');
      expect(res.body.issue[0].code).toBe('forbidden');
    });

    it('allows a patient-context token to read its OWN patient by path', async () => {
      verifyAccessTokenMock.mockResolvedValue({
        id: 16,
        granted_scopes: ['patient/Patient.read'],
        patient_uid: PATIENT_A,
        user_uid: null,
        user_role: null,
        client_id: 'app-under-test',
      });
      const res = await request(buildApp())
        .get(`/fhir/Patient/${PATIENT_A}`)
        .set('Authorization', `Bearer ${SMART_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.resourceType).toBe('Patient');
    });
  });

  describe('unrecognised bearer with no platform JWT → 401', () => {
    it('rejects a bearer that is neither a platform JWT nor a SMART token', async () => {
      verifyAccessTokenMock.mockResolvedValue(null);
      const res = await request(buildApp())
        .get('/fhir/Observation')
        .query({ patient: PATIENT_A })
        .set('Authorization', `Bearer ${PLATFORM_JWT_PLACEHOLDER}`);
      expect(res.status).toBe(401);
      expect(res.body.resourceType).toBe('OperationOutcome');
    });
  });
});
