// src/tests/unit/clinicalTimelineRoutesPhiTenant.test.js
//
// PR #874 residue: the internal logPhiAccess call in clinicalTimelineRoutes
// passed no tenantId. logPhiAccess runs requireTenantId on it — with the
// value undefined the hipaa_access_log row either mis-attributes to the
// default tenant (ALLOW_DEFAULT_TENANT=true today) or silently degrades to
// the file fallback at the multi-tenant cutover. The audit row must resolve
// the tenant exactly like the data read three lines above it
// (req.tenantId || req.user?.tenant_id), so access is attributed to the same
// tenant whose data was served.
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT = '00000000-0000-4000-8000-000000000001';

const readCanonicalPatientTimeline = jest.fn();
const logPhiAccess = jest.fn();
const patientAccessGuardMiddleware = jest.fn((_req, _res, next) => next());

jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard: jest.fn(() => patientAccessGuardMiddleware),
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  readCanonicalPatientTimeline,
}));
jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess,
}));

const { default: clinicalTimelineRoutes } = await import(
  '../../routes/emr/clinicalTimelineRoutes.js'
);

function buildApp({ tenantId = TENANT, userTenantId = null } = {}) {
  const app = express();
  app.use((req, _res, next) => {
    req.tenantId = tenantId;
    req.user = { uid: 'doctor-uid-1', role: 'DOCTOR', tenant_id: userTenantId };
    req.id = 'request-id-1';
    next();
  });
  app.use('/emr/timeline', clinicalTimelineRoutes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  readCanonicalPatientTimeline.mockResolvedValue({
    events: [],
    counts: {},
    legacy_included: false,
    generated_at: '2026-08-16T00:00:00.000Z',
  });
});

describe('GET /emr/timeline/:patientUid PHI audit tenant attribution', () => {
  it('passes the same tenantId to logPhiAccess as to the data read', async () => {
    const res = await request(buildApp()).get('/emr/timeline/patient-uid-9');

    expect(res.status).toBe(200);
    expect(readCanonicalPatientTimeline).toHaveBeenCalledWith(
      'patient-uid-9',
      expect.objectContaining({ tenantId: TENANT }),
    );
    expect(logPhiAccess).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'doctor-uid-1',
      userRole: 'DOCTOR',
      patientId: 'patient-uid-9',
      recordType: 'clinical_timeline',
      action: 'VIEW',
      tenantId: TENANT,
      requestId: 'request-id-1',
    }));
  });

  it('falls back to req.user.tenant_id when req.tenantId is absent (matching the data read)', async () => {
    const app = buildApp({ tenantId: undefined, userTenantId: TENANT });
    const res = await request(app).get('/emr/timeline/patient-uid-9');

    expect(res.status).toBe(200);
    expect(logPhiAccess).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
    );
  });
});
