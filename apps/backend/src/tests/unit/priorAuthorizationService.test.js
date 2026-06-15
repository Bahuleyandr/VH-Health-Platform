/**
 * Unit tests for priorAuthorizationService — Task 5.
 *
 * Two behaviours under test:
 *   (a) recordPayerDecision: emits clinical_ai.prior_auth_denied event when
 *       decision is 'denied'; does NOT emit for 'approved'.
 *   (b) generatePriorAuthorization: throws AppError 403 when the module
 *       returned by getClinicalAiModule has enabled === false.
 *
 * No real DB or network: prisma, eventOutboxService, and
 * clinicalAiModuleService are fully mocked.
 */

import { jest } from '@jest/globals';

// ------------------------------------------------------------------ mocks
// These MUST be declared before any dynamic import() of the service.

const mockPublishEvent = jest.fn().mockResolvedValue({ id: 1 });
const mockGetClinicalAiModule = jest.fn().mockResolvedValue({ enabled: true });

const mockQueryRawUnsafe = jest.fn();
const __prismaDefaultMock = { $queryRawUnsafe: mockQueryRawUnsafe };

// Paths are resolved relative to the test file (src/tests/unit/),
// which is two levels up from src/services/ai/ where the service lives.
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
}));

jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  publishEvent: mockPublishEvent,
}));

jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({
  getClinicalAiModule: mockGetClinicalAiModule,
}));

// Stub collaborators the service imports but we don't test here.
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: 'default-tenant-id',
}));
jest.unstable_mockModule('../../services/emr/clinicalTimelineService.js', () => ({
  collectAdmissionClinicalContext: jest.fn().mockResolvedValue({
    admission: { id: 1, chief_complaint: 'fever' },
    diagnoses: [],
    vitals: [],
    medications: [],
    notes: [],
    investigations: [],
    allergies: [],
  }),
}));
jest.unstable_mockModule('../../services/ai/localLlmClient.js', () => ({
  generateClinicalText: jest.fn().mockResolvedValue({
    text: '{}',
    usedAi: false,
    provider: 'template',
  }),
}));
jest.unstable_mockModule('../../services/ai/hallucinationDefenses.js', () => ({
  runOutputDefenses: jest.fn().mockReturnValue([]),
}));
jest.unstable_mockModule('../../services/ai/priorAuthorizationPayerAdapterService.js', () => ({
  submitPriorAuthToPayer: jest.fn().mockResolvedValue({ reference_id: 'REF-1', blocking: false }),
}));

// ------------------------------------------------------------------ lazy imports
let recordPayerDecision;
let generatePriorAuthorization;

beforeAll(async () => {
  const svc = await import('../../services/ai/priorAuthorizationService.js');
  ({ recordPayerDecision, generatePriorAuthorization } = svc);
});

beforeEach(() => {
  jest.clearAllMocks();
  // Default: module enabled
  mockGetClinicalAiModule.mockResolvedValue({ enabled: true });
});

// ================================================================== recordPayerDecision
describe('recordPayerDecision', () => {
  const BASE_ROW = {
    id: 42,
    status: 'denied',
    payer_decided_at: new Date().toISOString(),
    payer_decision_reason: 'no prior auth on file',
    patient_uid: 'patient-uuid-1',
  };

  describe('when decision is "denied"', () => {
    beforeEach(() => {
      mockQueryRawUnsafe.mockResolvedValue([BASE_ROW]);
    });

    it('calls publishEvent once with clinical_ai.prior_auth_denied', async () => {
      await recordPayerDecision({
        priorAuthId: 42,
        decision: 'denied',
        reason: 'no prior auth on file',
        tenantId: 'tenant-1',
      });

      expect(mockPublishEvent).toHaveBeenCalledTimes(1);
      const call = mockPublishEvent.mock.calls[0][0];
      expect(call.eventType).toBe('clinical_ai.prior_auth_denied');
      expect(call.aggregateType).toBe('prior_auth');
      expect(call.aggregateId).toBe('42');
    });

    it('includes patient_uid from the updated row in the event', async () => {
      await recordPayerDecision({
        priorAuthId: 42,
        decision: 'denied',
        reason: 'no prior auth on file',
        tenantId: 'tenant-1',
      });

      const call = mockPublishEvent.mock.calls[0][0];
      expect(call.patientUid).toBe('patient-uuid-1');
    });

    it('includes payer_decision_reason in the event payload', async () => {
      await recordPayerDecision({
        priorAuthId: 42,
        decision: 'denied',
        reason: 'no prior auth on file',
        tenantId: 'tenant-1',
      });

      const call = mockPublishEvent.mock.calls[0][0];
      expect(call.payload.payer_decision_reason).toBe('no prior auth on file');
    });

    it('does not throw even when publishEvent rejects (best-effort)', async () => {
      mockPublishEvent.mockRejectedValueOnce(new Error('outbox table missing'));
      await expect(
        recordPayerDecision({
          priorAuthId: 42,
          decision: 'denied',
          reason: 'test',
          tenantId: 'tenant-1',
        })
      ).resolves.not.toThrow();
    });
  });

  describe('when decision is "approved"', () => {
    beforeEach(() => {
      mockQueryRawUnsafe.mockResolvedValue([{ ...BASE_ROW, status: 'approved' }]);
    });

    it('does NOT call publishEvent', async () => {
      await recordPayerDecision({
        priorAuthId: 42,
        decision: 'approved',
        reason: null,
        tenantId: 'tenant-1',
      });

      expect(mockPublishEvent).not.toHaveBeenCalled();
    });
  });

  describe('when decision is "withdrawn"', () => {
    beforeEach(() => {
      mockQueryRawUnsafe.mockResolvedValue([{ ...BASE_ROW, status: 'withdrawn' }]);
    });

    it('does NOT call publishEvent', async () => {
      await recordPayerDecision({
        priorAuthId: 42,
        decision: 'withdrawn',
        reason: null,
        tenantId: 'tenant-1',
      });

      expect(mockPublishEvent).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('throws AppError badRequest for invalid decision', async () => {
      await expect(
        recordPayerDecision({ priorAuthId: 1, decision: 'rejected', tenantId: 't1' })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('throws AppError notFound when no row returned', async () => {
      mockQueryRawUnsafe.mockResolvedValue([]);
      await expect(
        recordPayerDecision({ priorAuthId: 999, decision: 'denied', tenantId: 't1' })
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });
});

// ================================================================== generatePriorAuthorization
describe('generatePriorAuthorization', () => {
  const VALID_ADMISSION_ROW = {
    id: 1,
    patient_uid: 'patient-uid-1',
    chief_complaint: 'chest pain',
    admitting_diagnosis: 'NSTEMI',
    admitted_at: new Date().toISOString(),
  };

  beforeEach(() => {
    // Admission lookup returns a valid row; INSERT for the draft returns id.
    mockQueryRawUnsafe
      .mockResolvedValueOnce([VALID_ADMISSION_ROW]) // admission SELECT
      .mockResolvedValueOnce([{ id: 10, status: 'draft', created_at: new Date().toISOString() }]); // INSERT RETURNING
  });

  describe('when module is enabled', () => {
    it('resolves successfully without throwing', async () => {
      mockGetClinicalAiModule.mockResolvedValue({ enabled: true });
      await expect(
        generatePriorAuthorization({
          req: { tenantId: 'tenant-1', tenant: {} },
          admissionId: 1,
          payerName: 'TestPayer',
          procedureCode: 'A1234',
        })
      ).resolves.toBeDefined();
    });
  });

  describe('when module is disabled', () => {
    it('throws AppError with statusCode 403', async () => {
      mockGetClinicalAiModule.mockResolvedValue({ enabled: false, display_name: 'Prior Auth Generator' });
      await expect(
        generatePriorAuthorization({
          req: { tenantId: 'tenant-1', tenant: {} },
          admissionId: 1,
          payerName: 'TestPayer',
          procedureCode: 'A1234',
        })
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('throws AppError with code PRIOR_AUTH_MODULE_DISABLED', async () => {
      mockGetClinicalAiModule.mockResolvedValue({ enabled: false });
      await expect(
        generatePriorAuthorization({
          req: { tenantId: 'tenant-1', tenant: {} },
          admissionId: 1,
          payerName: 'TestPayer',
          procedureCode: 'A1234',
        })
      ).rejects.toMatchObject({ code: 'PRIOR_AUTH_MODULE_DISABLED' });
    });
  });

  describe('when admission is not found', () => {
    it('throws AppError 404 before checking module', async () => {
      mockQueryRawUnsafe.mockReset();
      mockQueryRawUnsafe.mockResolvedValueOnce([]); // no admission row
      await expect(
        generatePriorAuthorization({
          req: { tenantId: 'tenant-1', tenant: {} },
          admissionId: 9999,
          payerName: 'TestPayer',
          procedureCode: 'B9999',
        })
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });
});
