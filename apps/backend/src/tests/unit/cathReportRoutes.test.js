import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const createReportMock = jest.fn(async () => ({ id: 51, status: 'draft' }));
const getReportMock = jest.fn(async () => ({ id: 51, status: 'draft', addenda: [] }));
const listReportsMock = jest.fn(async () => [{ id: 51, status: 'draft', addenda: [] }]);
const listReportTemplatesMock = jest.fn(async () => [{ id: 9, report_type: 'ptca' }]);
const markReportPreliminaryMock = jest.fn(async () => ({ id: 51, status: 'preliminary' }));
const resolveCaseViewerLinkMock = jest.fn(async () => ({
  viewer_url: null,
  viewer_status: 'pacs_not_configured',
}));
const signReportMock = jest.fn(async () => ({ id: 51, status: 'signed' }));
const supersedeReportTemplateMock = jest.fn(async () => ({ id: 10, version: 2 }));
const updateReportMock = jest.fn(async () => ({ id: 51, status: 'draft' }));
const addReportAddendumMock = jest.fn(async () => ({ id: 91, report_id: 51 }));
const getSignedReportForPdfMock = jest.fn(async () => ({ id: 51, status: 'signed' }));
const getCaseMock = jest.fn(async () => ({ id: 42, status: 'scheduled' }));
const listCasesMock = jest.fn(async () => [{ id: 42, status: 'scheduled' }]);
const recordConsumableUsageMock = jest.fn(async () => ({ id: 73, quantity: 1 }));
const transitionCaseStatusMock = jest.fn();

jest.unstable_mockModule('../../services/clinical/cathLabService.js', () => ({
  addContrastRadiationRecord: jest.fn(),
  addDeviceLink: jest.fn(),
  addHemodynamicSummary: jest.fn(),
  addPostProcedureOrder: jest.fn(),
  createCase: jest.fn(),
  getCase: getCaseMock,
  listCaseConsumableUsage: jest.fn(),
  listCatalogBatches: jest.fn(),
  listCases: listCasesMock,
  listConsumableCatalog: jest.fn(),
  recordConsumableUsage: recordConsumableUsageMock,
  recordProcedureLog: jest.fn(),
  transitionCaseStatus: transitionCaseStatusMock,
  updateReadinessCheck: jest.fn(),
}));

jest.unstable_mockModule('../../services/clinical/cathReportService.js', () => ({
  addReportAddendum: addReportAddendumMock,
  createReport: createReportMock,
  getReport: getReportMock,
  getSignedReportForPdf: getSignedReportForPdfMock,
  listReports: listReportsMock,
  listReportTemplates: listReportTemplatesMock,
  markReportPreliminary: markReportPreliminaryMock,
  resolveCaseViewerLink: resolveCaseViewerLinkMock,
  signReport: signReportMock,
  supersedeReportTemplate: supersedeReportTemplateMock,
  updateReport: updateReportMock,
}));

jest.unstable_mockModule('../../services/documents/cathReportPdfService.js', () => ({
  renderCathReportPdf: jest.fn(async () => Buffer.from('%PDF-route-test')),
}));

// NL-13 P1e quick-wins routes are covered by cathQuickWinsService.test.js;
// mock the service here to keep this suite's module graph tight.
jest.unstable_mockModule('../../services/clinical/cathQuickWinsService.js', () => ({
  applyCathOrderSetSlot: jest.fn(async () => ({ orders: [] })),
  getCaseQuickWins: jest.fn(async () => ({ readiness_evidence: {}, order_sets: {} })),
  refreshReadinessEvidence: jest.fn(async () => ({ attached: [], skipped: [] })),
  emitCathProcedureCompletionFollowUps: jest.fn(async () => ({ created: [], skipped: [] })),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
  // NL13-P1f: cathLabRoutes now mounts cathSchedulingRoutes, whose service
  // chain (cathSchedulingRegistryService + schedulingOptimizationService)
  // imports requireTenantId at module load.
  requireTenantId: (tenantId) => tenantId || '00000000-0000-4000-8000-000000000001',
  // NL13-P1g: the readiness service/projection chain reaches tenant-posture
  // resolvers (care-team enforcement) that import getTenantById at module load.
  // Return a row whose settings carry no enforcement key so the resolver keeps
  // the documented shadow default; a null row would fail closed with
  // CARE_TEAM_MODE_UNAVAILABLE.
  getTenantById: async () => ({ id: '00000000-0000-4000-8000-000000000001', settings: {} }),
}));

jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  phiAccessLogger: () => (_req, _res, next) => next(),
}));

jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: () => (req, res, next) => (
    req.get('idempotency-key')
      ? next()
      : res.status(400).json({ success: false, message: 'Idempotency-Key header is required' })
  ),
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
  const role = req.get('x-test-role') || 'DOCTOR';
  req.user = {
    uid: '33333333-3333-4333-8333-333333333333',
    role,
    rawRole: role,
    roles: [role],
  };
  req.id = req.get('x-request-id') || 'route-request';
  next();
});
app.use('/api/v1/cath-lab', cathLabRoutes);

beforeEach(() => {
  for (const mock of [
    createReportMock,
    getReportMock,
    listReportsMock,
    listReportTemplatesMock,
    markReportPreliminaryMock,
    resolveCaseViewerLinkMock,
    signReportMock,
    supersedeReportTemplateMock,
    updateReportMock,
    addReportAddendumMock,
    getSignedReportForPdfMock,
    getCaseMock,
    listCasesMock,
    recordConsumableUsageMock,
    transitionCaseStatusMock,
  ]) {
    mock.mockClear();
  }
});

describe('cath report route access matrices and response contract', () => {
  test('lets report-capable desk and technician roles list and open cases', async () => {
    for (const role of ['RECEPTIONIST', 'TECHNICIAN']) {
      const listed = await request(app)
        .get('/api/v1/cath-lab/cases')
        .set('x-test-role', role);
      const opened = await request(app)
        .get('/api/v1/cath-lab/cases/42')
        .set('x-test-role', role);

      expect(listed.statusCode).toBe(200);
      expect(listed.body.data.cases).toEqual([{ id: 42, status: 'scheduled' }]);
      expect(opened.statusCode).toBe(200);
      expect(opened.body.data.case).toEqual({ id: 42, status: 'scheduled' });
    }
  });

  test('keeps every cath workflow mutation closed to report-only roles', async () => {
    const mutationPaths = [
      '/api/v1/cath-lab/cases',
      '/api/v1/cath-lab/cases/42/status',
      '/api/v1/cath-lab/cases/42/readiness',
      '/api/v1/cath-lab/cases/42/procedure-logs',
      '/api/v1/cath-lab/cases/42/hemodynamics',
      '/api/v1/cath-lab/cases/42/contrast-radiation',
      '/api/v1/cath-lab/cases/42/post-orders',
      '/api/v1/cath-lab/cases/42/device-links',
      '/api/v1/cath-lab/cases/42/consumables',
    ];

    for (const role of ['RECEPTIONIST', 'TECHNICIAN']) {
      for (const path of mutationPaths) {
        const response = await request(app)
          .post(path)
          .set('x-test-role', role)
          .send({ status: 'in_progress' });

        expect(response.statusCode).toBe(403);
        expect(response.body.details.code).toBe('CATH_LAB_WORKFLOW_FORBIDDEN');
      }
    }

    expect(transitionCaseStatusMock).not.toHaveBeenCalled();
    expect(recordConsumableUsageMock).not.toHaveBeenCalled();
  });

  test('pins consumable writes to the authenticated tenant', async () => {
    const response = await request(app)
      .post('/api/v1/cath-lab/cases/42/consumables')
      .set('x-test-role', 'DOCTOR')
      .set('idempotency-key', 'cath-usage-route-test')
      .send({
        tenantId: '00000000-0000-4000-8000-000000000099',
        catalog_item_id: 7,
        quantity: 1,
      });

    expect(response.statusCode).toBe(201);
    expect(recordConsumableUsageMock).toHaveBeenCalledWith(
      '42',
      expect.objectContaining({
        tenantId: '00000000-0000-4000-8000-000000000001',
        catalog_item_id: 7,
        quantity: 1,
      }),
      expect.objectContaining({
        actorRole: 'DOCTOR',
        idempotencyKey: 'cath-usage-route-test',
      }),
    );
  });

  test('requires an idempotency key for consumable writes', async () => {
    const response = await request(app)
      .post('/api/v1/cath-lab/cases/42/consumables')
      .set('x-test-role', 'DOCTOR')
      .send({ catalog_item_id: 7, quantity: 1 });

    expect(response.statusCode).toBe(400);
    expect(response.body.message).toMatch(/Idempotency-Key/i);
    expect(recordConsumableUsageMock).not.toHaveBeenCalled();
  });

  test('pins case completion and its billing hook to the authenticated tenant', async () => {
    transitionCaseStatusMock.mockResolvedValueOnce({ id: 42, status: 'completed' });
    const response = await request(app)
      .post('/api/v1/cath-lab/cases/42/status')
      .set('x-test-role', 'DOCTOR')
      .send({
        tenantId: '00000000-0000-4000-8000-000000000099',
        status: 'completed',
      });

    expect(response.statusCode).toBe(200);
    expect(transitionCaseStatusMock).toHaveBeenCalledWith(
      '42',
      expect.objectContaining({
        tenantId: '00000000-0000-4000-8000-000000000001',
        status: 'completed',
      }),
      expect.objectContaining({ actorRole: 'DOCTOR' }),
    );
  });

  test('lets a receptionist create and reopen transcription drafts', async () => {
    const created = await request(app)
      .post('/api/v1/cath-lab/cases/42/reports')
      .set('x-test-role', 'RECEPTIONIST')
      .send({ template_id: 9 });
    const opened = await request(app)
      .get('/api/v1/cath-lab/reports/51')
      .set('x-test-role', 'RECEPTIONIST');

    expect(created.statusCode).toBe(201);
    expect(created.body.data.report).toMatchObject({ id: 51, status: 'draft' });
    expect(opened.statusCode).toBe(200);
    expect(opened.body.data.report).toMatchObject({ id: 51 });
  });

  test('blocks a receptionist from signing', async () => {
    const response = await request(app)
      .post('/api/v1/cath-lab/reports/51/sign')
      .set('x-test-role', 'RECEPTIONIST')
      .send({});

    expect(response.statusCode).toBe(403);
    expect(signReportMock).not.toHaveBeenCalled();
  });

  test('lets a technician resolve images but not edit reports', async () => {
    const viewer = await request(app)
      .get('/api/v1/cath-lab/cases/42/viewer-link')
      .set('x-test-role', 'TECHNICIAN');
    const edit = await request(app)
      .patch('/api/v1/cath-lab/reports/51')
      .set('x-test-role', 'TECHNICIAN')
      .send({ findings_summary: 'forbidden' });

    expect(viewer.statusCode).toBe(200);
    expect(viewer.body.data).toMatchObject({
      viewer_url: null,
      viewer_status: 'pacs_not_configured',
    });
    expect(edit.statusCode).toBe(403);
    expect(updateReportMock).not.toHaveBeenCalled();
  });

  test('lets senior doctor sign and returns the standard report key', async () => {
    const response = await request(app)
      .post('/api/v1/cath-lab/reports/51/sign')
      .set('x-test-role', 'SENIOR_DOCTOR')
      .send({});

    expect(response.statusCode).toBe(200);
    expect(response.body.data.report).toMatchObject({ id: 51, status: 'signed' });
    expect(signReportMock).toHaveBeenCalledWith(
      '51',
      expect.objectContaining({ tenantId: '00000000-0000-4000-8000-000000000001' }),
      expect.objectContaining({ actorRole: 'SENIOR_DOCTOR', requestId: 'route-request' }),
    );
  });

  test('exposes template supersession behind the edit gate', async () => {
    const response = await request(app)
      .post('/api/v1/cath-lab/report-templates/9/supersede')
      .set('x-test-role', 'CATH_LAB_INCHARGE')
      .send({ name: 'PTCA v2' });

    expect(response.statusCode).toBe(201);
    expect(response.body.data.template).toMatchObject({ id: 10, version: 2 });
  });
});
