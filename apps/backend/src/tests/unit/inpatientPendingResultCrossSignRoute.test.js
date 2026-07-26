import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const ACTOR_UID = '20000000-0000-4000-8000-000000000001';
const HANDOFF_ID = '30000000-0000-4000-8000-000000000001';
const GENERATION_ID = '40000000-0000-4000-8000-000000000001';
const DIAGNOSTIC_ACTION_ID = '50000000-0000-4000-8000-000000000001';
const IDEMPOTENCY_KEY = 'pending-result-cross-sign-route-1';
const GENERATION_HASH = 'a'.repeat(64);
const GENERIC_FORBIDDEN_MESSAGE =
  'Only the live named discharge follow-up physician may cross-sign this pending result';
const GENERIC_FORBIDDEN_CODE =
  'INPATIENT_PENDING_RESULT_CROSS_SIGN_FORBIDDEN';

const recordPendingResultOwnerCrossSignMock = jest.fn();

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/emr/admissionService.js', () => ({
  default: {},
}));

jest.unstable_mockModule(
  '../../services/emr/inpatientPathwayDomainService.js',
  () => ({
    getInpatientDischargeEvidence: jest.fn(),
    listPostDischargeContacts: jest.fn(),
    recordFollowUpException: jest.fn(),
    recordPendingResultAvailable: jest.fn(),
    recordPendingResultHandoff: jest.fn(),
    recordPendingResultOwnerCrossSign:
      recordPendingResultOwnerCrossSignMock,
    recordPendingResultSummaryInclusion: jest.fn(),
    recordPostDischargeContact: jest.fn(),
  }),
);

jest.unstable_mockModule(
  '../../services/emr/patientCommandBoardService.js',
  () => ({ default: {} }),
);

jest.unstable_mockModule(
  '../../services/emr/dischargeSummaryGenerator.js',
  () => ({}),
);

jest.unstable_mockModule(
  '../../services/ai/clinicalAiWorkflowService.js',
  () => ({
    generateAdmissionAiDraft: jest.fn(),
    generateWardRoundBrief: jest.fn(),
  }),
);

jest.unstable_mockModule('../../services/ai/translationService.js', () => ({
  listTranslations: jest.fn(),
  translateGeneration: jest.fn(),
}));

jest.unstable_mockModule(
  '../../services/ai/longitudinalRiskService.js',
  () => ({
    getLatestRisk: jest.fn(),
    scoreLongitudinalRisk: jest.fn(),
  }),
);

jest.unstable_mockModule(
  '../../services/ai/patientTeachBackService.js',
  () => ({
    generateTeachBackSession: jest.fn(),
    submitTeachBackAnswers: jest.fn(),
  }),
);

jest.unstable_mockModule(
  '../../services/ai/nursingAmbientDocumentationService.js',
  () => ({ generateNursingAmbientSession: jest.fn() }),
);

jest.unstable_mockModule(
  '../../services/ai/familyUpdateGeneratorService.js',
  () => ({ generateFamilyUpdate: jest.fn() }),
);

jest.unstable_mockModule('../../utils/roleHelpers.js', () => ({
  canEditDischargeSummary: jest.fn(() => true),
  canSignDischargeSummary: jest.fn(() => true),
  canViewDischargeSummary: jest.fn(() => true),
}));

jest.unstable_mockModule(
  '../../controllers/appointment/appointmentWorkflowController.js',
  () => ({ adviseForAdmission: jest.fn() }),
);

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
}));

const passThroughGuard = () => (_req, _res, next) => next();
jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard: passThroughGuard,
  patientAccessGuardForResource: passThroughGuard,
}));

jest.unstable_mockModule(
  '../../services/security/accessDecisionService.js',
  () => ({
    ACCESS_POLICY_CODES: {
      PATIENT_ADMISSION_VIEW: 'PATIENT_ADMISSION_VIEW',
      PATIENT_ADMISSION_WRITE: 'PATIENT_ADMISSION_WRITE',
    },
  }),
);

const { default: admissionRouter } = await import(
  '../../routes/emr/admissionRoutes.js'
);
const { errorHandlerMiddleware } = await import(
  '../../middleware/errorHandlerMiddleware.js'
);

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = TENANT_ID;
    req.user = {
      id: 71,
      uid: ACTOR_UID,
      role: 'DOCTOR',
    };
    next();
  });
  app.use('/api/v1/emr', admissionRouter);
  app.use(errorHandlerMiddleware);
  return app;
}

function requestBody() {
  return {
    generation_id: GENERATION_ID,
    diagnostic_action_id: DIAGNOSTIC_ACTION_ID,
    generation_snapshot_sha256: GENERATION_HASH,
    attested: true,
  };
}

beforeEach(() => {
  recordPendingResultOwnerCrossSignMock.mockReset();
});

describe('pending-result cross-sign admission route', () => {
  test('requires Idempotency-Key before the service can accept the command', async () => {
    recordPendingResultOwnerCrossSignMock.mockImplementationOnce(
      async (_admissionId, _handoffId, input) => {
        if (!input.idempotencyKey) {
          throw AppError.badRequest(
            'Idempotency-Key header is required',
            'INPATIENT_PENDING_RESULT_CROSS_SIGN_IDEMPOTENCY_KEY_INVALID',
          );
        }
        throw new Error('unexpected command acceptance');
      },
    );

    const response = await request(makeApp())
      .post(`/api/v1/emr/51/pending-result-handoffs/${HANDOFF_ID}/cross-sign`)
      .send(requestBody());

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      success: false,
      message: 'Idempotency-Key header is required',
      code: 'INPATIENT_PENDING_RESULT_CROSS_SIGN_IDEMPOTENCY_KEY_INVALID',
    });
    expect(recordPendingResultOwnerCrossSignMock).toHaveBeenCalledWith(
      51,
      HANDOFF_ID,
      {
        ...requestBody(),
        idempotencyKey: undefined,
      },
      {
        id: 71,
        uid: ACTOR_UID,
        role: 'DOCTOR',
        tenantId: TENANT_ID,
      },
    );
  });

  test('passes the exact attested command, idempotency key, and server actor', async () => {
    const resolution = {
      id: '60000000-0000-4000-8000-000000000001',
      handoff_id: HANDOFF_ID,
      generation_id: GENERATION_ID,
      replayed: false,
    };
    recordPendingResultOwnerCrossSignMock.mockResolvedValueOnce(resolution);

    const response = await request(makeApp())
      .post(`/api/v1/emr/51/pending-result-handoffs/${HANDOFF_ID}/cross-sign`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(requestBody());

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      success: true,
      message: 'Pending result cross-signed by its named physician',
      data: { resolution },
    });
    expect(recordPendingResultOwnerCrossSignMock).toHaveBeenCalledWith(
      51,
      HANDOFF_ID,
      {
        ...requestBody(),
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      {
        id: 71,
        uid: ACTOR_UID,
        role: 'DOCTOR',
        tenantId: TENANT_ID,
      },
    );
  });

  test('keeps guessed other-owner and missing resources on one generic 403', async () => {
    const guessedAdmissionId = 987654;
    const missingHandoffId = '90000000-0000-4000-8000-000000000099';
    recordPendingResultOwnerCrossSignMock
      .mockRejectedValueOnce(
        AppError.forbidden(
          GENERIC_FORBIDDEN_MESSAGE,
          GENERIC_FORBIDDEN_CODE,
        ),
      )
      .mockRejectedValueOnce(
        AppError.forbidden(
          GENERIC_FORBIDDEN_MESSAGE,
          GENERIC_FORBIDDEN_CODE,
        ),
      );

    const otherOwner = await request(makeApp())
      .post(`/api/v1/emr/51/pending-result-handoffs/${HANDOFF_ID}/cross-sign`)
      .set('Idempotency-Key', `${IDEMPOTENCY_KEY}-owner`)
      .send(requestBody());
    const missing = await request(makeApp())
      .post(
        `/api/v1/emr/${guessedAdmissionId}/pending-result-handoffs/`
          + `${missingHandoffId}/cross-sign`,
      )
      .set('Idempotency-Key', `${IDEMPOTENCY_KEY}-missing`)
      .send(requestBody());

    expect(otherOwner.statusCode).toBe(403);
    expect(missing.statusCode).toBe(403);
    expect(otherOwner.body).toEqual({
      success: false,
      message: GENERIC_FORBIDDEN_MESSAGE,
      code: GENERIC_FORBIDDEN_CODE,
    });
    expect(missing.body).toEqual(otherOwner.body);
    const serialized = JSON.stringify([otherOwner.body, missing.body]);
    expect(serialized).not.toContain(String(guessedAdmissionId));
    expect(serialized).not.toContain(HANDOFF_ID);
    expect(serialized).not.toContain(missingHandoffId);
    expect(serialized).not.toContain(GENERATION_ID);
    expect(serialized).not.toContain(DIAGNOSTIC_ACTION_ID);
  });
});
