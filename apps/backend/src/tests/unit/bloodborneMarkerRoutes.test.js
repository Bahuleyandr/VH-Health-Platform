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
import * as markerOverlay from '../../../scripts/openapi/schemas/bloodborneMarkers.mjs';
// The rules module is NOT mocked in this file: its constants are the source
// the published enums have to track.
import {
  MARKERS,
  RESULTS,
  SOURCES,
  STATUSES,
} from '../../services/clinical/bloodborneMarkerRules.js';

const listMarkersForPatient = jest.fn();
const voidMarker = jest.fn();
const idempotencyOptions = [];

const POLICY_CODES = { PATIENT_CLINICAL_WORKFLOW_ACCESS: 'patient.clinical_workflow.access' };

// Recorded, not just stubbed: the guard's declared options are the whole
// fail-closed contract of this surface and are asserted below.
const patientAccessGuard = jest.fn(() => function patientAccessGuardMiddleware(_req, _res, next) {
  next();
});

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
  ACCESS_POLICY_CODES: POLICY_CODES,
}));

jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard,
  phiAccessLogger: () => (_req, _res, next) => next(),
}));

// Mirrors the pre-claim branch of the real middleware (a missing header is a
// hard 400 when required); the declared options are asserted separately so the
// route's real idempotency contract is still pinned. It is a jest.fn so a
// request that is rejected BEFORE the claim can be told apart from one that
// reached the claim and passed it.
const idempotencyMiddleware = jest.fn(function idempotencyMiddleware(req, res, next) {
  return req.get('idempotency-key')
    ? next()
    : res.status(400).json({
      success: false,
      message: 'Idempotency-Key header is required for this endpoint',
    });
});

jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: (options = {}) => {
    idempotencyOptions.push(options);
    return idempotencyMiddleware;
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
    // patientAccessGuard is deliberately NOT cleared — its only call happens
    // once, at router construction, and is asserted below.
    idempotencyMiddleware.mockClear();
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

  test.each([
    ['true', true], ['TRUE', true], ['1', true],
    ['false', false], ['False', false], ['0', false], ['', false],
  ])('GET reads include_voided=%s as %s', async (value, expected) => {
    const response = await request(app())
      .get(`/api/v1/bloodborne-markers/patient/${PATIENT_UID}`)
      .query({ include_voided: value });

    expect(response.status).toBe(200);
    expect(listMarkersForPatient).toHaveBeenCalledWith(expect.objectContaining({
      includeVoided: expected,
    }));
  });

  test.each([['yes'], ['on'], ['no'], ['2'], ['null']])(
    'GET rejects include_voided=%s rather than silently serving the active-only list',
    async (value) => {
      const response = await request(app())
        .get(`/api/v1/bloodborne-markers/patient/${PATIENT_UID}`)
        .query({ include_voided: value });

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/include_voided must be true or false/);
      expect(listMarkersForPatient).not.toHaveBeenCalled();
    },
  );

  test('GET rejects a non-UUID patientUid at the uid layer (guard mocked here; the real guard returns 403 first)', async () => {
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
      // retainOnServerError: a void is irreversible, so a 5xx after the commit
      // must leave the claim in place and make the retry replay the stored
      // outcome rather than re-run the void.
      { required: true, scope: 'bloodborne_marker_void', retainOnServerError: true },
    ]);
  });

  test('POST void rejects a non-UUID patientUid at the uid layer, BEFORE the idempotency claim, so no key is burned (guard mocked here; the real guard returns 403 first)', async () => {
    const response = await request(app())
      .post('/api/v1/bloodborne-markers/patient/not-a-uuid/markers/41/void')
      .set('Idempotency-Key', 'void-41-abc')
      .send({ reason: 'Entered in error' });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/patientUid must be a UUID/);
    expect(voidMarker).not.toHaveBeenCalled();
    // The claim layer never ran: a malformed request cannot consume the
    // caller's key and poison the retry of a well-formed one.
    expect(idempotencyMiddleware).not.toHaveBeenCalled();
  });

  test('POST void with a well-formed patientUid does reach the idempotency claim', async () => {
    const response = await request(app())
      .post(`/api/v1/bloodborne-markers/patient/${PATIENT_UID}/markers/41/void`)
      .set('Idempotency-Key', 'void-41-abc')
      .send({ reason: 'Entered in error' });

    expect(response.status).toBe(200);
    expect(idempotencyMiddleware).toHaveBeenCalledTimes(1);
  });

  test.each([['0x29'], ['4e1'], ['41abc'], ['-41'], ['1.0'], [' 41'], ['%2041']])(
    'POST void rejects marker id %s instead of letting Number() coerce it',
    async (value) => {
      const response = await request(app())
        .post(`/api/v1/bloodborne-markers/patient/${PATIENT_UID}/markers/${value}/void`)
        .set('Idempotency-Key', 'void-41-abc')
        .send({ reason: 'Entered in error' });

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/marker id must be a positive integer/);
      expect(voidMarker).not.toHaveBeenCalled();
      // The id check is its own layer ahead of the claim, so a malformed
      // marker id cannot burn the caller's key any more than a malformed uid.
      expect(idempotencyMiddleware).not.toHaveBeenCalled();
    },
  );

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

  test('builds ONE patient-access guard and declares it fail-closed on an unresolvable patient', () => {
    // requirePatientContext is what turns a uid that resolves to no patient in
    // this tenant into a 403 PATIENT_CONTEXT_REQUIRED. Without it the guard
    // reports no_patient_context and falls through to the handler, which then
    // queries by that uid anyway.
    expect(patientAccessGuard).toHaveBeenCalledTimes(1);
    expect(patientAccessGuard).toHaveBeenCalledWith('BLOODBORNE_MARKERS', {
      policyCode: POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
      requirePatientContext: true,
    });
  });

  test('the OpenAPI row contract requires exactly the columns MARKER_SELECT returns', () => {
    // Every column in MARKER_SELECT is on every row the routes emit, so the
    // published `required` list is only honest while it tracks that SQL. Read
    // from the service SOURCE because the module itself is mocked here.
    const serviceSource = readFileSync(
      new URL('../../services/clinical/bloodborneMarkerService.js', import.meta.url),
      'utf8',
    );
    const selectMatch = serviceSource.match(/const MARKER_SELECT = `([^`]*)`/);
    expect(selectMatch).not.toBeNull();
    const columns = selectMatch[1].split(',').map((c) => c.trim()).filter(Boolean);
    expect(columns).toContain('id');
    expect(columns.length).toBeGreaterThan(10);
    expect(markerOverlay.schemas.BloodborneMarker.required).toEqual(columns);
    // additionalProperties:false, so the property set must match too — a
    // column added to the SELECT but not the overlay would otherwise be a
    // response the published contract forbids.
    expect(Object.keys(markerOverlay.schemas.BloodborneMarker.properties)).toEqual(columns);
    // The published enums are a second copy of the service's own constants;
    // a value added to one and not the other is a contract lie (a response
    // the client's generated types reject, or a value the docs promise and
    // the service never emits).
    expect(markerOverlay.ENUMS).toEqual({
      MARKERS: [...MARKERS],
      RESULTS: [...RESULTS],
      SOURCES: [...SOURCES],
      STATUSES: [...STATUSES],
    });
    expect(markerOverlay.schemas.BloodborneMarker.properties.marker.enum).toEqual([...MARKERS]);
    expect(markerOverlay.schemas.BloodborneMarker.properties.result.enum).toEqual([...RESULTS]);
    expect(markerOverlay.schemas.BloodborneMarker.properties.source.enum).toEqual([...SOURCES]);
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
