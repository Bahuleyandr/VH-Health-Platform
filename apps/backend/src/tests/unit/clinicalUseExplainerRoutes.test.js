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
const listOpdAiModulesMock = jest.fn();
const generateOpVisitPrepMock = jest.fn();
const generateOpPrescriptionSafetyMock = jest.fn();
const generateOpInvestigationReviewMock = jest.fn();
const generateOpDifferentialRedFlagsMock = jest.fn();
const generateOpFollowUpPlanMock = jest.fn();
const generateOpReferralDraftMock = jest.fn();
const auditMock = jest.fn();

jest.unstable_mockModule('../../services/ai/patientExplainersService.js', () => ({
  generateInvoicePatientExplanation: generateInvoiceMock,
  generateLabPatientExplanation: generateLabMock,
  generatePatientReportExplanation: generateReportMock,
  generatePrescriptionPatientExplanation: generatePrescriptionMock,
  generateRadiologyPatientExplanation: generateRadiologyMock,
}));

jest.unstable_mockModule('../../services/ai/opdClinicalAssistService.js', () => ({
  listOpdAiModules: listOpdAiModulesMock,
  generateOpVisitPrep: generateOpVisitPrepMock,
  generateOpPrescriptionSafetyReview: generateOpPrescriptionSafetyMock,
  generateOpInvestigationReview: generateOpInvestigationReviewMock,
  generateOpDifferentialRedFlags: generateOpDifferentialRedFlagsMock,
  generateOpFollowUpPlan: generateOpFollowUpPlanMock,
  generateOpReferralDraft: generateOpReferralDraftMock,
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
const __prismaDefaultMock = { $queryRawUnsafe: jest.fn(() => Promise.resolve([])) };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  isTenantTransactionClient: () => true,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
  circuitBreakerStatus: () => ({ open: false, consecutiveFailures: 0 }),
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

function makeApp({ role = 'DOCTOR', rawRole = null } = {}) {
  const app = express();
  app.use(express.json());
  // Inject req.tenantId + req.user as middleware would in production.
  app.use((req, _res, next) => {
    req.tenantId = TENANT;
    req.user = { uid: 'doctor-uid', role };
    if (rawRole) req.user.rawRole = rawRole;
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
  listOpdAiModulesMock.mockReset().mockResolvedValue({
    modules: [{ module_key: 'op_visit_prep', label: 'OP Visit Prep', enabled: false }],
    count: 1,
  });
  generateOpVisitPrepMock.mockReset().mockResolvedValue({ ...sampleResult, module_key: 'op_visit_prep' });
  generateOpPrescriptionSafetyMock.mockReset().mockResolvedValue({ ...sampleResult, module_key: 'polypharmacy_ai_review' });
  generateOpInvestigationReviewMock.mockReset().mockResolvedValue({ ...sampleResult, module_key: 'op_investigation_review' });
  generateOpDifferentialRedFlagsMock.mockReset().mockResolvedValue({ ...sampleResult, module_key: 'op_differential_red_flags' });
  generateOpFollowUpPlanMock.mockReset().mockResolvedValue({ ...sampleResult, module_key: 'op_follow_up_plan' });
  generateOpReferralDraftMock.mockReset().mockResolvedValue({ ...sampleResult, module_key: 'op_referral_draft' });
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

describe('clinical-plane OP AI assist routes', () => {
  it('GET /op/services returns tenant-scoped Admin toggle state', async () => {
    const app = makeApp();
    const res = await request(app).get('/clinical-ai/clinical/op/services');

    expect(res.statusCode).toBe(200);
    expect(listOpdAiModulesMock).toHaveBeenCalledWith({ tenantId: TENANT });
    expect(res.body.data.modules[0].module_key).toBe('op_visit_prep');
  });

  it.each(['ADMIN', 'SUPER_ADMIN', 'NURSING_STAFF', 'PHARMACY_STAFF', 'RECEPTIONIST'])(
    'GET /op/services rejects non-doctor staff role %s',
    async (role) => {
      const app = makeApp({ role });
      const res = await request(app).get('/clinical-ai/clinical/op/services');

      expect(res.statusCode).toBe(403);
      expect(res.body.details?.code).toBe('OP_AI_DOCTOR_ROLE_REQUIRED');
      expect(listOpdAiModulesMock).not.toHaveBeenCalled();
    },
  );

  it('GET /op/services accepts doctor aliases through the OP doctor gate', async () => {
    const app = makeApp({ role: 'CONSULTANT_PHYSICIAN' });
    const res = await request(app).get('/clinical-ai/clinical/op/services');

    expect(res.statusCode).toBe(200);
    expect(listOpdAiModulesMock).toHaveBeenCalledWith({ tenantId: TENANT });
  });

  it('POST /op/visit-prep rejects admin before generation or audit', async () => {
    const app = makeApp({ role: 'ADMIN' });
    const res = await request(app)
      .post('/clinical-ai/clinical/op/visit-prep')
      .send({ appointment_id: 314 });

    expect(res.statusCode).toBe(403);
    expect(generateOpVisitPrepMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('POST /op/visit-prep forwards appointment_id and audit metadata', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/clinical-ai/clinical/op/visit-prep')
      .send({ appointment_id: 314 });

    expect(res.statusCode).toBe(201);
    expect(generateOpVisitPrepMock).toHaveBeenCalledTimes(1);
    expect(generateOpVisitPrepMock.mock.calls[0][0]).toEqual(expect.objectContaining({
      tenantId: TENANT,
      appointmentId: 314,
      generatedBy: 'doctor-uid',
    }));
    const auditPayload = auditMock.mock.calls[0][4];
    expect(auditPayload.route_family).toBe('clinical');
    expect(auditPayload.care_setting).toBe('opd');
    expect(auditPayload.patient_facing).toBe(false);
    expect(auditPayload.decision_support_only).toBe(true);
  });

  it('POST /op/prescription-safety forwards patient and medication payload', async () => {
    const app = makeApp();
    const medications = [{ name: 'Aspirin', dose: '75 mg', frequency: 'OD' }];
    const res = await request(app)
      .post('/clinical-ai/clinical/op/prescription-safety')
      .send({ patient_uid: PATIENT_UID, medications });

    expect(res.statusCode).toBe(201);
    expect(generateOpPrescriptionSafetyMock.mock.calls[0][0]).toEqual(expect.objectContaining({
      patientUid: PATIENT_UID,
      medications,
    }));
  });

  it('POST /op/investigation-review forwards investigation result context', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/clinical-ai/clinical/op/investigation-review')
      .send({ investigation_id: 22, clinical_question: 'Trend?' });

    expect(res.statusCode).toBe(201);
    expect(generateOpInvestigationReviewMock.mock.calls[0][0]).toEqual(expect.objectContaining({
      tenantId: TENANT,
      investigationId: 22,
      clinicalQuestion: 'Trend?',
    }));
  });

  it('POST /op/differential-red-flags forwards complaint and vitals', async () => {
    const app = makeApp();
    const vitals = { bp: '160/90' };
    const res = await request(app)
      .post('/clinical-ai/clinical/op/differential-red-flags')
      .send({ chief_complaint: 'Chest pain', age_years: 54, vitals });

    expect(res.statusCode).toBe(201);
    expect(generateOpDifferentialRedFlagsMock.mock.calls[0][0]).toEqual(expect.objectContaining({
      tenantId: TENANT,
      chiefComplaint: 'Chest pain',
      ageYears: 54,
      vitals,
    }));
  });

  it('POST /op/follow-up-plan forwards diagnosis and plan', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/clinical-ai/clinical/op/follow-up-plan')
      .send({ diagnosis: 'Hypertension', treatment_plan: 'Adjust medicines and recheck BP' });

    expect(res.statusCode).toBe(201);
    expect(generateOpFollowUpPlanMock.mock.calls[0][0]).toEqual(expect.objectContaining({
      tenantId: TENANT,
      diagnosis: 'Hypertension',
      treatmentPlan: 'Adjust medicines and recheck BP',
    }));
  });

  it('POST /op/referral-draft forwards referral context', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/clinical-ai/clinical/op/referral-draft')
      .send({
        referral_reason: 'Cardiology opinion',
        clinical_summary: 'Exertional chest pain with abnormal ECG changes.',
        target_specialty: 'Cardiology',
      });

    expect(res.statusCode).toBe(201);
    expect(generateOpReferralDraftMock.mock.calls[0][0]).toEqual(expect.objectContaining({
      tenantId: TENANT,
      referralReason: 'Cardiology opinion',
      clinicalSummary: 'Exertional chest pain with abnormal ECG changes.',
      targetSpecialty: 'Cardiology',
    }));
  });
});
