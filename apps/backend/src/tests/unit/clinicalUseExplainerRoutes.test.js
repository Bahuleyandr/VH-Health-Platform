/**
 * Unit tests for the clinical-plane patient-explainer routes added to
 * `clinicalUseRoutes.js`.
 *
 * The routes are thin wrappers around patientExplainersService — same
 * generators the admin-plane endpoints use. The point of these tests
 * is to lock in:
 *   1. Route paths are mounted at the expected slugs.
 *   2. Each route forwards the body fields with the correct camelCase
 *      → service-arg mapping (e.g. `report_text` → `reportText`).
 *   3. tenantId comes from req.tenantId (multi-tenant isolation).
 *   4. The audit log records `route_family: 'clinical'` so governance
 *      can distinguish point-of-care drafts from admin-portal drafts.
 *
 * No DB, no supertest-against-app — just a mini express app that
 * mounts the router with mocked service + audit + middleware.
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const generateLabMock = jest.fn();
const generateRadiologyMock = jest.fn();
const generateReportMock = jest.fn();
const generatePrescriptionMock = jest.fn();
const generateInvoiceMock = jest.fn();
const auditMock = jest.fn();

jest.unstable_mockModule('../../services/ai/patientExplainersService.js', () => ({
  generateInvoicePatientExplanation: generateInvoiceMock,
  generateLabPatientExplanation: generateLabMock,
  generatePatientReportExplanation: generateReportMock,
  generatePrescriptionPatientExplanation: generatePrescriptionMock,
  generateRadiologyPatientExplanation: generateRadiologyMock,
}));

jest.unstable_mockModule('../../routes/admin/clinicalAi/audit.js', () => ({
  logClinicalAiAudit: auditMock,
}));

// Stub the workflow-runner imports so the module loads without trying
// to touch the real services. We only test the explainer routes here;
// the admission / compose / review routes are covered elsewhere.
jest.unstable_mockModule('../../services/ai/clinicalAiWorkflowService.js', () => ({
  generateAdmissionAiDraft: jest.fn(),
  listReviews: jest.fn(),
  updateReview: jest.fn(),
}));
jest.unstable_mockModule('../../services/ai/dischargeComposeService.js', () => ({
  composeDischargePackage: jest.fn(),
  getComposeGraph: jest.fn(),
  DISCHARGE_COMPOSE_WORKFLOW_KEY: 'discharge_summary_compose',
}));
jest.unstable_mockModule('../../services/ai/workflowCheckpointStore.js', () => ({
  getDefaultCheckpointStore: jest.fn(() => ({ getRun: jest.fn(), listChildren: jest.fn() })),
}));
jest.unstable_mockModule('../../services/ai/workflowGraphRunner.js', () => ({
  resumeWorkflow: jest.fn(),
}));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn(() => Promise.resolve([])) },
}));

// shared.js exports the requireClinicalAiUse middleware. Bypass the
// auth gate for these tests — we're checking route wiring, not RBAC
// (RBAC is covered in clinicalAiRouteSplit.test.js).
jest.unstable_mockModule('../../routes/admin/clinicalAi/shared.js', () => ({
  requireClinicalAiUse: (_req, _res, next) => next(),
  normalizeRole: (r) => String(r || '').toUpperCase(),
}));

const router = (await import('../../routes/admin/clinicalAi/clinicalUseRoutes.js')).default;

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';

function makeApp() {
  const app = express();
  app.use(express.json());
  // Inject req.tenantId + req.user as middleware would in production.
  app.use((req, _res, next) => {
    req.tenantId = TENANT;
    req.user = { uid: 'doctor-uid', role: 'DOCTOR' };
    next();
  });
  app.use('/clinical-ai/clinical', router);
  return app;
}

const sampleResult = {
  module_key: 'patient_report_explainer',
  generation_id: 1,
  draft: { explanation_summary: 'mock summary', key_points: [], next_steps: [], when_to_seek_help: [], source_citations: [], safety_flags: [] },
  safety_flags: [],
  source_citations: [],
  used_ai: true,
  provider: 'openai-compatible',
  status: 'draft',
  review_status: 'pending',
  requires_signoff: true,
  decision_support_only: true,
};

beforeEach(() => {
  generateLabMock.mockReset().mockResolvedValue({ ...sampleResult, module_key: 'lab_patient_explanation' });
  generateRadiologyMock.mockReset().mockResolvedValue({ ...sampleResult, module_key: 'radiology_patient_explanation' });
  generateReportMock.mockReset().mockResolvedValue({ ...sampleResult });
  generatePrescriptionMock.mockReset().mockResolvedValue({ ...sampleResult, module_key: 'prescription_patient_explainer' });
  generateInvoiceMock.mockReset().mockResolvedValue({ ...sampleResult, module_key: 'invoice_patient_explainer' });
  auditMock.mockReset().mockResolvedValue(undefined);
});

describe('clinical-plane patient-explainer routes', () => {
  it('POST /lab-patient-explanations forwards investigation_id + language and tenantId', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/clinical-ai/clinical/lab-patient-explanations')
      .send({ investigation_id: 42, language: 'hi' });

    expect(res.statusCode).toBe(201);
    expect(generateLabMock).toHaveBeenCalledTimes(1);
    const args = generateLabMock.mock.calls[0][0];
    expect(args.tenantId).toBe(TENANT);
    expect(args.investigationId).toBe(42);
    expect(args.language).toBe('hi');
    expect(args.generatedBy).toBe('doctor-uid');
  });

  it('POST /radiology-patient-explanations forwards radiology_order_id', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/clinical-ai/clinical/radiology-patient-explanations')
      .send({ radiology_order_id: 7 });

    expect(res.statusCode).toBe(201);
    const args = generateRadiologyMock.mock.calls[0][0];
    expect(args.radiologyOrderId).toBe(7);
    expect(args.language).toBe('en'); // default
  });

  it('POST /patient-report-explanations forwards report_type + report_text + optional patient/admission', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/clinical-ai/clinical/patient-report-explanations')
      .send({
        report_type: 'consultation',
        report_text: 'A clinical note long enough to pass the 30-char min length check.',
        patient_uid: PATIENT_UID,
        admission_id: 99,
        language: 'ta',
      });

    expect(res.statusCode).toBe(201);
    const args = generateReportMock.mock.calls[0][0];
    expect(args.reportType).toBe('consultation');
    expect(args.reportText).toContain('A clinical note long enough');
    expect(args.patientUid).toBe(PATIENT_UID);
    expect(args.admissionId).toBe(99);
    expect(args.language).toBe('ta');
  });

  it('POST /prescription-patient-explanations forwards prescription_id', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/clinical-ai/clinical/prescription-patient-explanations')
      .send({ prescription_id: 3 });

    expect(res.statusCode).toBe(201);
    const args = generatePrescriptionMock.mock.calls[0][0];
    expect(args.prescriptionId).toBe(3);
  });

  it('POST /invoice-patient-explanations forwards invoice_id', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/clinical-ai/clinical/invoice-patient-explanations')
      .send({ invoice_id: 11 });

    expect(res.statusCode).toBe(201);
    const args = generateInvoiceMock.mock.calls[0][0];
    expect(args.invoiceId).toBe(11);
  });

  it('audit log marks route_family as clinical (not admin)', async () => {
    const app = makeApp();
    await request(app)
      .post('/clinical-ai/clinical/patient-report-explanations')
      .send({ report_type: 'consultation', report_text: 'note long enough to pass validation here' });

    expect(auditMock).toHaveBeenCalled();
    const auditPayload = auditMock.mock.calls[0][4];
    expect(auditPayload.route_family).toBe('clinical');
    expect(auditPayload.module_key).toBe('patient_report_explainer');
  });

  it('errors thrown by the service are forwarded to express error handler (next(err))', async () => {
    generateReportMock.mockReset().mockRejectedValue(Object.assign(new Error('boom'), { statusCode: 400 }));
    const app = makeApp();
    // Default express error handler returns 500 for thrown errors with no
    // statusCode handler. The route is correctly calling next(err); the
    // global error middleware (in app.js) would map it to a structured
    // response. For this test we just verify the call propagates.
    const res = await request(app)
      .post('/clinical-ai/clinical/patient-report-explanations')
      .send({ report_type: 'consultation', report_text: 'note long enough to pass validation here' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    // Audit should NOT have fired on error (we only audit successful results)
    expect(auditMock).not.toHaveBeenCalled();
  });
});
