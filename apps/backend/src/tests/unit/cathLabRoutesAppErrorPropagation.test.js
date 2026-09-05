import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for cathLabRoutes.js — relay-variants port
// of handleFailure() onto relayAppError (mirrors
// paediatricImmunisationRoutesAppErrorPropagation.test.js). The old helper
// relayed `err.details ?? { code: err.code }`, so `code` was only visible when
// a service attached no details; the relay lifts err.code to the envelope root
// unconditionally and keeps err.details under `details`.

const getCaseMock = jest.fn();
const listCasesMock = jest.fn();

jest.unstable_mockModule('../../services/clinical/cathLabService.js', () => ({
  addContrastRadiationRecord: jest.fn(),
  addDeviceLink: jest.fn(),
  addHemodynamicSummary: jest.fn(),
  addPostProcedureOrder: jest.fn(),
  createCase: jest.fn(),
  getCase: getCaseMock,
  listCatalogBatches: jest.fn(),
  listCases: listCasesMock,
  listCaseConsumableUsage: jest.fn(),
  listConsumableCatalog: jest.fn(),
  recordConsumableUsage: jest.fn(),
  recordProcedureLog: jest.fn(),
  transitionCaseStatus: jest.fn(),
  updateReadinessCheck: jest.fn(),
}));

jest.unstable_mockModule('../../services/clinical/cathQuickWinsService.js', () => ({
  applyCathOrderSetSlot: jest.fn(),
  getCaseQuickWins: jest.fn(),
  refreshReadinessEvidence: jest.fn(),
}));

jest.unstable_mockModule('../../services/clinical/cathReportService.js', () => ({
  addReportAddendum: jest.fn(),
  createReport: jest.fn(),
  getReport: jest.fn(),
  getSignedReportForPdf: jest.fn(),
  listReports: jest.fn(),
  listReportTemplates: jest.fn(),
  markReportPreliminary: jest.fn(),
  resolveCaseViewerLink: jest.fn(),
  signReport: jest.fn(),
  supersedeReportTemplate: jest.fn(),
  updateReport: jest.fn(),
}));

jest.unstable_mockModule('../../services/documents/cathReportPdfService.js', () => ({
  renderCathReportPdf: jest.fn(),
}));

// The pre-cath lab readiness rail (Plan 3) is imported by cathLabRoutes and by
// the governance router; stubbed here for the same reason as the services
// above — this suite pins the error envelope, not the readiness resolver, and the real
// module pulls the whole lab-results graph in behind it.
const recordExternalLabResultMock = jest.fn();
jest.unstable_mockModule('../../services/clinical/cathLabReadinessService.js', () => ({
  // ITEM_CODES is real: the :item guard tests membership against it, so a stub
  // list would let the guard admit a code the service refuses.
  ITEM_CODES: Object.freeze(['hb', 'platelets', 'creatinine', 'potassium', 'hiv', 'hbsag', 'hcv']),
  getReadinessSettings: jest.fn(),
  orderMissingLabs: jest.fn(),
  recordExternalLabResult: recordExternalLabResultMock,
  refreshCaseLabReadiness: jest.fn(),
  refreshOpenCasesForPatient: jest.fn(),
  upsertReadinessSettings: jest.fn(),
  waiveLabItem: jest.fn(),
}));

// The device-reuse routes (post-use, device lookup, device history) and the
// consumables listing's reuse decoration live here; stubbed for the same reason
// as the services above — this suite pins the error envelope, not the register.
jest.unstable_mockModule('../../services/clinical/cathDeviceReuseService.js', () => ({
  decorateConsumablesWithReuse: jest.fn(async (usage) => ({
    usage, reuse_restriction: null, reprocessing: null,
  })),
  deviceForCaseLookup: jest.fn(),
  deviceHistory: jest.fn(),
  logDeviceHistoryAccess: jest.fn(async () => ({ logged: 0, skipped: 0 })),
  projectReuseRestrictionForRole: jest.fn((restriction) => restriction),
  roleSeesSerologyDetail: jest.fn(() => true),
  recordPostUse: jest.fn(),
}));

// cathLabRoutes mounts cathSchedulingRoutes; mock its service so the
// Scheduling 2.0 chain stays out of this suite's module graph.
jest.unstable_mockModule('../../services/clinical/cathSchedulingRegistryService.js', () => ({
  addRegistryEntry: jest.fn(),
  cancelCaseSchedule: jest.fn(),
  getCaseSchedule: jest.fn(),
  getScheduleStrip: jest.fn(),
  scheduleCase: jest.fn(),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

// The claim layer, as idempotencyMiddleware really leaves it: req.idempotencyClaim
// carries { id, requestKey, requestBodyHash, scope }. The suite below asserts
// WHICH of those the router forwards into the service context.
const HTTP_CLAIM = Object.freeze({
  id: 4242,
  requestKey: 'cath-ext-key-1',
  requestBodyHash: 'a'.repeat(64),
  scope: 'cath_lab_readiness_external',
});
jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: () => (req, _res, next) => {
    req.idempotencyClaim = { ...HTTP_CLAIM };
    next();
  },
}));

// Re-audit M: these routers now carry per-route patientAccessGuard selectors
// (middleware/routePatientAccessGuards.js). This suite pins the route layer's
// error-envelope contract, not authz — neutralize the guard layer so requests
// reach the handlers. Guard wiring and selector behavior are pinned in
// perioperativeRouteGuards / icuDialysisRouteGuards / cathLabRouteGuards.
jest.unstable_mockModule('../../middleware/routePatientAccessGuards.js', () => ({
  routePatientGuard: () => (_req, _res, next) => next(),
  selectorTenantOf: () => null,
  positiveIntOrNull: () => null,
  positiveBigIntTextOrNull: () => null,
  PG_INT4_MAX: 2147483647,
  PG_INT8_MAX: 9223372036854775807n,
}));

const { default: cathLabRoutes } = await import('../../routes/clinical/cathLabRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = {
    uid: '11111111-1111-4111-8111-111111111111',
    role: 'DOCTOR',
    rawRole: 'DOCTOR',
    roles: ['DOCTOR'],
  };
  next();
});
app.use('/api/v1/cath-lab', cathLabRoutes);

beforeEach(() => {
  getCaseMock.mockReset();
  listCasesMock.mockReset();
  recordExternalLabResultMock.mockReset();
});

describe('cath-lab handleFailure() relays AppError code + details', () => {
  test('AppError rejection surfaces status, root-level code and details', async () => {
    getCaseMock.mockRejectedValueOnce(
      AppError.conflict('Case is already in a terminal status', 'SOME_CODE', { reason: 'x' }),
    );

    const response = await request(app).get('/api/v1/cath-lab/cases/42');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError rejection returns the generic 500 and never leaks err.message', async () => {
    listCasesMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'procedure_type')"),
    );

    const response = await request(app).get('/api/v1/cath-lab/cases');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to list cases');
    expect(response.body.message).not.toMatch(/procedure_type/);
  });
});

describe('contextOf does not hand the HTTP idempotency claim to the lab rail', () => {
  // The external-result route is the one place on this router where the service
  // context reaches a SECOND idempotency layer: recordExternalLabResult passes
  // it into labResultsService.recordExternalLabResultRow, whose ingest rail calls
  // finaliseHttpIdempotencyInTx(claimId) INSIDE the lab transaction. Forwarding
  // the claim's row id and body hash therefore (a) marked this route's HTTP
  // claim complete/200 with the LAB layer's payload, so a replay answered with
  // a whole lab row instead of the published 201 {lab_result_id, item,
  // readiness}, and (b) left a 5xx raised after that transaction commits —
  // marker write, audit, readiness refresh — unable to release or re-finalise
  // the claim, so the retry replayed a success for work never done.
  //
  // The claimed KEY still goes: it is what makes a double-tap one command, and
  // the service derives its own content fingerprint (case_id + item + value)
  // from the request itself.
  test('the external-result route forwards the KEY but neither the claim id nor the body hash', async () => {
    recordExternalLabResultMock.mockResolvedValueOnce({
      lab_result_id: 9, item: 'hbsag', readiness: null,
    });

    const response = await request(app)
      .post('/api/v1/cath-lab/cases/42/readiness/labs/hbsag/external-result')
      .set('Idempotency-Key', 'cath-ext-key-1')
      .send({ value_text: 'non-reactive', observed_on: '2026-09-01', external_lab_name: 'Outside' });

    expect(response.statusCode).toBe(201);
    expect(recordExternalLabResultMock).toHaveBeenCalledTimes(1);
    const context = recordExternalLabResultMock.mock.calls[0][3];

    // Absent, not merely falsy: a forwarded null would still be a channel, and
    // the next reader could not tell "the middleware set none" from "the route
    // drops it deliberately".
    expect('httpIdempotencyClaimId' in context).toBe(false);
    expect('requestFingerprint' in context).toBe(false);
    expect(context.httpIdempotencyClaimId ?? null).toBeNull();
    expect(context.requestFingerprint ?? null).toBeNull();

    // ...while the identity the service DOES need is intact — and the claim
    // layer really did run, so this is a dropped value, not an absent one.
    expect(context.idempotencyKey).toBe('cath-ext-key-1');
    expect(HTTP_CLAIM.requestBodyHash).toHaveLength(64);
    expect(context.requestId).toBe('test-request-id');
    expect(context.actorUid).toBe('11111111-1111-4111-8111-111111111111');
    expect(context.actorRole).toBe('DOCTOR');
  });

  test('the waive route claims a key too and forwards no more of it', async () => {
    // Same claim layer, different scope: nothing on this router may pre-finalise
    // an HTTP claim, so the rule is asserted on the second claiming write too.
    const { waiveLabItem } = await import('../../services/clinical/cathLabReadinessService.js');
    waiveLabItem.mockResolvedValueOnce({ case_id: 42, items: [] });

    await request(app)
      .post('/api/v1/cath-lab/cases/42/readiness/labs/hiv/waive')
      .set('Idempotency-Key', 'cath-waive-key-1')
      .send({ reason: 'emergency PCI' });

    const context = waiveLabItem.mock.calls[0][3];
    expect('httpIdempotencyClaimId' in context).toBe(false);
    expect('requestFingerprint' in context).toBe(false);
    // The header above is 'cath-waive-key-1', but the planted HTTP_CLAIM (module
    // scope, shared by every test in this file) fixes requestKey to
    // 'cath-ext-key-1', and contextOf prefers the claim's requestKey over the
    // header — so that is what the service sees here too.
    expect(context.idempotencyKey).toBe('cath-ext-key-1');
  });
});
