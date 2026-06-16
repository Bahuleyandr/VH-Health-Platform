/**
 * Unit tests for the clinical-plane Clinician EHR Query route
 * (`POST /ehr-query`) added to `clinicalUseRoutes.js`.
 *
 * No DB, no supertest-against-app — a mini express app mounts the real
 * router with mocked service + audit + middleware, mirroring
 * clinicalUseExplainerRoutes.test.js.
 *
 * Coverage:
 *   1. A clinician role (DOCTOR) with { patient_uid, question } → 200, body
 *      carries answer/citations/scope from the mocked service.
 *   2. A non-clinical role (PATIENT) → 403 (the requireClinicalAiUse gate).
 *   3. Module-disabled: answerEhrQuery throws
 *      AppError.forbidden(..., 'EHR_QUERY_MODULE_DISABLED') → route 403.
 *   4. Missing question → 400 (route-level validation, before the service).
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const answerEhrQueryMock = jest.fn();
const auditMock = jest.fn();

jest.unstable_mockModule('../../services/ai/clinicianEhrQueryService.js', () => ({
  answerEhrQuery: answerEhrQueryMock,
}));

jest.unstable_mockModule('../../routes/admin/clinicalAi/audit.js', () => ({
  logClinicalAiAudit: auditMock,
}));

// The router imports these sibling services at module load; stub them so the
// module graph resolves without touching real services. Only the EHR-query
// route is exercised here.
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
jest.unstable_mockModule('../../services/ai/patientExplainersService.js', () => ({
  generateInvoicePatientExplanation: jest.fn(),
  generateLabPatientExplanation: jest.fn(),
  generatePatientReportExplanation: jest.fn(),
  generatePrescriptionPatientExplanation: jest.fn(),
  generateRadiologyPatientExplanation: jest.fn(),
}));
jest.unstable_mockModule('../../services/ai/opdClinicalAssistService.js', () => ({
  listOpdAiModules: jest.fn(),
  generateOpVisitPrep: jest.fn(),
  generateOpPrescriptionSafetyReview: jest.fn(),
  generateOpInvestigationReview: jest.fn(),
  generateOpDifferentialRedFlags: jest.fn(),
  generateOpFollowUpPlan: jest.fn(),
  generateOpReferralDraft: jest.fn(),
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
  prismaReadOnly: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

// phiAccessLogger is a passive after-finish audit logger; stub it to a no-op
// pass-through so the test doesn't depend on the HIPAA audit pipeline.
jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  phiAccessLogger: () => (_req, _res, next) => next(),
}));

// Use the REAL requireClinicalAiUse gate (we want a genuine 403 for PATIENT),
// but the real normalizeRole too.
const { AppError } = await import('../../utils/AppError.js');
const router = (await import('../../routes/admin/clinicalAi/clinicalUseRoutes.js')).default;
const { errorHandlerMiddleware } = await import('../../middleware/errorHandlerMiddleware.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';

function makeApp({ role = 'DOCTOR' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = 'test-request-id';
    req.tenantId = TENANT;
    req.user = { uid: 'doctor-uid', role };
    next();
  });
  app.use('/clinical-ai/clinical', router);
  app.use(errorHandlerMiddleware);
  return app;
}

const sampleResult = {
  answer: 'Per THIS ADMISSION the troponin trended down from 0.9 to 0.3.',
  citations: [{ source: 'investigations', id: 42 }],
  scope: 'both',
  window: { dateFrom: '2026-05-01T00:00:00.000Z', dateTo: null, current_admission_id: 99, event_count: 7 },
  safety_flags: [],
  used_ai: true,
};

beforeEach(() => {
  answerEhrQueryMock.mockReset().mockResolvedValue({ ...sampleResult });
  auditMock.mockReset().mockResolvedValue(undefined);
});

describe('POST /clinical-ai/clinical/ehr-query', () => {
  it('clinician (DOCTOR) with patient_uid + question → 200 with answer/citations/scope', async () => {
    const app = makeApp({ role: 'DOCTOR' });
    const res = await request(app)
      .post('/clinical-ai/clinical/ehr-query')
      .send({ patient_uid: PATIENT_UID, question: 'How has the troponin trended this admission?' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.answer).toBe(sampleResult.answer);
    expect(res.body.data.citations).toEqual(sampleResult.citations);
    expect(res.body.data.scope).toBe('both');

    // Service received the mapped params from the body.
    expect(answerEhrQueryMock).toHaveBeenCalledTimes(1);
    const args = answerEhrQueryMock.mock.calls[0][0];
    expect(args.patientUid).toBe(PATIENT_UID);
    expect(args.question).toContain('troponin');
    expect(args.scope).toBe('both');
    expect(args.req).toBeDefined();

    // Audit recorded the clinical route family.
    expect(auditMock).toHaveBeenCalledTimes(1);
    const auditPayload = auditMock.mock.calls[0][4];
    expect(auditPayload.route_family).toBe('clinical');
    expect(auditPayload.module_key).toBe('clinician_ehr_query');
    expect(auditPayload.patient_facing).toBe(false);
  });

  it('forwards optional scope / admission_id / date window to the service', async () => {
    const app = makeApp({ role: 'CONSULTANT' });
    const res = await request(app)
      .post('/clinical-ai/clinical/ehr-query')
      .send({
        patient_uid: PATIENT_UID,
        question: 'Summarize prior cardiac history.',
        scope: 'history',
        admission_id: 55,
        date_from: '2025-01-01T00:00:00.000Z',
        date_to: '2025-12-31T00:00:00.000Z',
      });

    expect(res.statusCode).toBe(200);
    const args = answerEhrQueryMock.mock.calls[0][0];
    expect(args.scope).toBe('history');
    expect(args.admissionId).toBe(55);
    expect(args.dateFrom).toBe('2025-01-01T00:00:00.000Z');
    expect(args.dateTo).toBe('2025-12-31T00:00:00.000Z');
  });

  it('non-clinical role (PATIENT) → 403 (requireClinicalAiUse gate), service not called', async () => {
    const app = makeApp({ role: 'PATIENT' });
    const res = await request(app)
      .post('/clinical-ai/clinical/ehr-query')
      .send({ patient_uid: PATIENT_UID, question: 'What is my diagnosis?' });

    expect(res.statusCode).toBe(403);
    expect(answerEhrQueryMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('module disabled → service throws EHR_QUERY_MODULE_DISABLED → 403', async () => {
    answerEhrQueryMock.mockReset().mockRejectedValue(
      AppError.forbidden('clinician_ehr_query module is disabled', 'EHR_QUERY_MODULE_DISABLED'),
    );
    const app = makeApp({ role: 'DOCTOR' });
    const res = await request(app)
      .post('/clinical-ai/clinical/ehr-query')
      .send({ patient_uid: PATIENT_UID, question: 'How has the troponin trended this admission?' });

    expect(res.statusCode).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('EHR_QUERY_MODULE_DISABLED');
    // Audit must NOT fire — the service threw before returning a result.
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('missing question → 400 (route validation, service not called)', async () => {
    const app = makeApp({ role: 'DOCTOR' });
    const res = await request(app)
      .post('/clinical-ai/clinical/ehr-query')
      .send({ patient_uid: PATIENT_UID });

    expect(res.statusCode).toBe(400);
    expect(res.body.details?.code).toBe('EHR_QUERY_QUESTION_REQUIRED');
    expect(answerEhrQueryMock).not.toHaveBeenCalled();
  });

  it('missing patient_uid → 400 (route validation, service not called)', async () => {
    const app = makeApp({ role: 'DOCTOR' });
    const res = await request(app)
      .post('/clinical-ai/clinical/ehr-query')
      .send({ question: 'How has the troponin trended this admission?' });

    expect(res.statusCode).toBe(400);
    expect(res.body.details?.code).toBe('EHR_QUERY_PATIENT_REQUIRED');
    expect(answerEhrQueryMock).not.toHaveBeenCalled();
  });
});
