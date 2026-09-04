// Route-level contract for the blood-borne marker read/void surface.
// The service is mocked (its own behaviour is covered by
// bloodborne-markers.deep.test.js); what is under test here is the HTTP
// surface: input validation, the service call shape, the idempotency
// declaration, and that AppError codes reach the client instead of being
// flattened to a bare status.
import { readFileSync } from 'node:fs';

import express from 'express';
import { jest } from '@jest/globals';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

const listMarkersForPatient = jest.fn();
const voidMarker = jest.fn();
const idempotencyOptions = [];

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATIENT_UID = '20000000-0000-4000-8000-000000000002';
const ACTOR_UID = '30000000-0000-4000-8000-000000000003';

jest.unstable_mockModule('../../services/clinical/bloodborneMarkerService.js', () => ({
  DEFAULT_VALIDITY_DAYS: 90,
  listMarkersForPatient,
  voidMarker,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => TENANT_ID,
  requireTenantId: (tenantId) => tenantId || TENANT_ID,
}));

jest.unstable_mockModule('../../services/security/accessDecisionService.js', () => ({
  ACCESS_POLICY_CODES: { PATIENT_CLINICAL_WORKFLOW_ACCESS: 'patient.clinical_workflow.access' },
}));

jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard: () => (_req, _res, next) => next(),
  phiAccessLogger: () => (_req, _res, next) => next(),
}));

// Mirrors the pre-claim branch of the real middleware (a missing header is a
// hard 400 when required); the declared options are asserted separately so the
// route's real idempotency contract is still pinned.
jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: (options = {}) => {
    idempotencyOptions.push(options);
    return (req, res, next) => (
      req.get('idempotency-key')
        ? next()
        : res.status(400).json({
          success: false,
          message: 'Idempotency-Key header is required for this endpoint',
        })
    );
  },
}));

const { default: router } = await import('../../routes/clinical/bloodborneMarkerRoutes.js');

const MARKER = {
  id: 41,
  tenant_id: TENANT_ID,
  patient_uid: PATIENT_UID,
  marker: 'hiv',
  marker_label: null,
  result: 'non_reactive',
  tested_on: '2026-08-20',
  source: 'lab_result',
  lab_result_id: 9001,
  evidence: { decision: 'verified' },
  recorded_by: ACTOR_UID,
  recorded_at: '2026-08-20T05:30:00.000Z',
  voided_at: null,
  voided_by: null,
  void_reason: null,
  notes: null,
};

const REUSE_STATUS = {
  status: 'unknown',
  reasons: ['HBsAg not on record', 'HCV not on record'],
  markers: [{
    marker: 'hiv',
    label: null,
    result: 'non_reactive',
    tested_on: '2026-08-20',
    source: 'lab_result',
    age_days: 15,
    within_window: true,
  }],
  validity_days: 90,
  evaluated_at: '2026-09-04T05:30:00.000Z',
};

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.tenantId = TENANT_ID;
    req.user = { uid: ACTOR_UID, role: 'DOCTOR' };
    next();
  });
  instance.use('/api/v1/bloodborne-markers', router);
  return instance;
}

describe('blood-borne marker routes', () => {
  beforeEach(() => {
    listMarkersForPatient.mockReset();
    voidMarker.mockReset();
    listMarkersForPatient.mockResolvedValue({ markers: [MARKER], reuse_status: REUSE_STATUS });
    voidMarker.mockResolvedValue({ ...MARKER, voided_at: '2026-09-04T06:00:00.000Z', voided_by: ACTOR_UID, void_reason: 'Entered in error' });
  });

  test('GET returns the markers and the reuse status verbatim, on the default window', async () => {
    const response = await request(app()).get(`/api/v1/bloodborne-markers/patient/${PATIENT_UID}`);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.markers).toEqual([MARKER]);
    // The resolver's status is a passthrough — the route must not re-derive,
    // reorder or drop any of it.
    expect(response.body.data.reuse_status).toEqual(REUSE_STATUS);
    expect(listMarkersForPatient).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      validityDays: 90,
      includeVoided: false,
    });
  });

  test('GET forwards an explicit window and include_voided', async () => {
    const response = await request(app())
      .get(`/api/v1/bloodborne-markers/patient/${PATIENT_UID}`)
      .query({ validity_days: '30', include_voided: 'TRUE' });

    expect(response.status).toBe(200);
    expect(listMarkersForPatient).toHaveBeenCalledWith(expect.objectContaining({
      validityDays: 30,
      includeVoided: true,
    }));
  });

  test('GET rejects a non-UUID patientUid before reaching the service', async () => {
    const response = await request(app()).get('/api/v1/bloodborne-markers/patient/not-a-uuid');

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/patientUid must be a UUID/);
    expect(listMarkersForPatient).not.toHaveBeenCalled();
  });

  test.each([['0'], ['366'], ['abc'], ['1.5'], ['-5']])(
    'GET rejects validity_days=%s instead of silently falling back to the default',
    async (value) => {
      const response = await request(app())
        .get(`/api/v1/bloodborne-markers/patient/${PATIENT_UID}`)
        .query({ validity_days: value });

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/validity_days must be an integer between 1 and 365/);
      expect(listMarkersForPatient).not.toHaveBeenCalled();
    },
  );

  test('GET relays a service AppError with its code', async () => {
    listMarkersForPatient.mockRejectedValue(
      AppError.badRequest('patientUid must be a UUID', 'BLOODBORNE_MARKER_INVALID'),
    );

    const response = await request(app()).get(`/api/v1/bloodborne-markers/patient/${PATIENT_UID}`);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('BLOODBORNE_MARKER_INVALID');
  });

  test('POST void voids the row with the acting user and the supplied reason', async () => {
    const response = await request(app())
      .post(`/api/v1/bloodborne-markers/patient/${PATIENT_UID}/markers/41/void`)
      .set('Idempotency-Key', 'void-41-abc')
      .send({ reason: 'Entered in error' });

    expect(response.status).toBe(200);
    expect(response.body.data.marker.voided_by).toBe(ACTOR_UID);
    expect(voidMarker).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      markerId: '41',
      actorUid: ACTOR_UID,
      reason: 'Entered in error',
    });
  });

  test('POST void is refused without an Idempotency-Key, and declares the required scope', async () => {
    const response = await request(app())
      .post(`/api/v1/bloodborne-markers/patient/${PATIENT_UID}/markers/41/void`)
      .send({ reason: 'Entered in error' });

    expect(response.status).toBe(400);
    expect(voidMarker).not.toHaveBeenCalled();
    expect(idempotencyOptions).toEqual([
      { required: true, scope: 'bloodborne_marker_void' },
    ]);
  });

  test('POST void rejects a non-UUID patientUid before reaching the service', async () => {
    const response = await request(app())
      .post('/api/v1/bloodborne-markers/patient/not-a-uuid/markers/41/void')
      .set('Idempotency-Key', 'void-41-abc')
      .send({ reason: 'Entered in error' });

    expect(response.status).toBe(400);
    expect(voidMarker).not.toHaveBeenCalled();
  });

  test.each([
    [AppError.notFound('Blood-borne marker not found', 'BLOODBORNE_MARKER_NOT_FOUND'), 404, 'BLOODBORNE_MARKER_NOT_FOUND'],
    [AppError.conflict('Blood-borne marker is already voided', 'BLOODBORNE_MARKER_ALREADY_VOIDED'), 409, 'BLOODBORNE_MARKER_ALREADY_VOIDED'],
    [AppError.badRequest('reason is required to void a marker', 'BLOODBORNE_MARKER_INVALID'), 400, 'BLOODBORNE_MARKER_INVALID'],
  ])('POST void relays the service error as %#', async (err, status, code) => {
    voidMarker.mockRejectedValue(err);

    const response = await request(app())
      .post(`/api/v1/bloodborne-markers/patient/${PATIENT_UID}/markers/41/void`)
      .set('Idempotency-Key', 'void-41-abc')
      .send({ reason: 'Entered in error' });

    expect(response.status).toBe(status);
    expect(response.body.code).toBe(code);
  });

  test('exposes only the read and the void — there is no create route by owner decision', () => {
    const source = readFileSync(
      new URL('../../routes/clinical/bloodborneMarkerRoutes.js', import.meta.url),
      'utf8',
    );
    expect(source).toContain("router.get('/patient/:patientUid'");
    expect(source).toContain("'/patient/:patientUid/markers/:id/void'");
    expect(source.match(/router\.(get|post|put|patch|delete)\(/g)).toHaveLength(2);
    expect(source).not.toMatch(/recordMarker|recordBloodborneMarker/);
  });
});
