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
const transitionCaseStatusMock = jest.fn();

jest.unstable_mockModule('../../services/clinical/cathLabService.js', () => ({
  addContrastRadiationRecord: jest.fn(),
  addDeviceLink: jest.fn(),
  addHemodynamicSummary: jest.fn(),
  addPostProcedureOrder: jest.fn(),
  createCase: jest.fn(),
  getCase: getCaseMock,
  listCases: listCasesMock,
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

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
  // NL13-P1f: cathLabRoutes now mounts cathSchedulingRoutes, whose service
  // chain (cathSchedulingRegistryService + schedulingOptimizationService)
  // imports requireTenantId at module load.
  requireTenantId: (tenantId) => tenantId || '00000000-0000-4000-8000-000000000001',
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
