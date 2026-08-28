import { jest } from '@jest/globals';

const setTenantTxMock = jest.fn();
const recordCanonicalClinicalEventMock = jest.fn();
const finaliseMarHttpIdempotencyTxMock = jest.fn();
const resolveMarMedicationExceptionTxMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn() },
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
  recordMedicationSafetyReviews: jest.fn(),
}));
jest.unstable_mockModule('../../services/clinical/marSupplyService.js', () => ({
  consumeMarSupplyTx: jest.fn(),
}));
jest.unstable_mockModule('../../services/clinical/marAdministrationCommandService.js', () => ({
  finaliseMarHttpIdempotencyTx: finaliseMarHttpIdempotencyTxMock,
  findMarAdministrationCommandReplayTx: jest.fn(),
  fingerprintMarAdministrationRequest: jest.fn(),
  recordMarAdministrationCommandReceiptTx: jest.fn(),
}));
jest.unstable_mockModule('../../services/clinical/marTransitionCommandService.js', () => ({
  findMarTransitionCommandReplayTx: jest.fn(),
  fingerprintMarTransitionRequest: jest.fn(),
  recordMarTransitionCommandReceiptTx: jest.fn(),
}));
jest.unstable_mockModule('../../services/clinical/marMedicationExceptionService.js', () => ({
  claimMarMedicationExceptionTx: jest.fn(),
  getMarExceptionMedicationAdministrationId: jest.fn(),
  handoffMarMedicationExceptionTx: jest.fn(),
  listAssignedMarMedicationExceptions: jest.fn(),
  openMarMedicationExceptionTx: jest.fn(),
  requiredMarMedicationExceptionCaseId: (value) => String(value),
  requiredMarMedicationExceptionEventId: (value) => String(value),
  resolveMarMedicationExceptionTx: resolveMarMedicationExceptionTxMock,
}));
jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  claimMarMedicationExceptionTaskTx: jest.fn(),
  completeTaskFromDomainEvidence: jest.fn(),
  createMarMedicationExceptionTaskTx: jest.fn(),
}));

const { releaseHeldMedication } = await import('../../services/clinical/marService.js');

const IDS = Object.freeze({
  actor: '10000000-0000-4000-8000-000000000001',
  patient: '10000000-0000-4000-8000-000000000002',
  tenant: '10000000-0000-4000-8000-000000000003',
});

const CLAIM = Object.freeze({
  commandKey: 'mar-release-hold-unit',
  requestFingerprint: 'a'.repeat(64),
  httpIdempotencyClaimId: 71,
  requestId: 'request-mar-release-hold-unit',
});

function createTx({ role = 'DOCTOR', status = 'held' } = {}) {
  const query = jest.fn(async (sql) => {
    if (sql.includes('FROM medication_administrations administration')) {
      return [{
        id: 42,
        patient_uid: IDS.patient,
        medication_name: 'Unit test medicine',
        dose: '500 mg',
        dosage: null,
        route: 'oral',
        scheduled_time: '2026-08-27T10:00:00.000Z',
        administered_at: null,
        status,
        administered_by: null,
        notes: null,
        hold_reason: 'Awaiting review',
        held_by: IDS.actor,
        held_at: '2026-08-27T09:00:00.000Z',
        witness_uid: null,
        tenant_id: IDS.tenant,
        clinical_order_id: 91,
        supply_quantity_per_dose: 1,
        clinical_order_status: 'ordered',
        release_actor_role: role,
      }];
    }
    if (sql.includes('UPDATE medication_administrations')) {
      return [{
        id: 42,
        patient_uid: IDS.patient,
        medication_name: 'Unit test medicine',
        dose: '500 mg',
        dosage: null,
        route: 'oral',
        scheduled_time: '2026-08-27T10:00:00.000Z',
        administered_at: null,
        status: 'scheduled',
        administered_by: null,
        notes: null,
        hold_reason: 'Awaiting review',
        held_by: IDS.actor,
        held_at: '2026-08-27T09:00:00.000Z',
        witness_uid: null,
        tenant_id: IDS.tenant,
        clinical_order_id: 91,
        supply_quantity_per_dose: 1,
      }];
    }
    if (sql.includes('FROM mar_medication_exception_cases')) {
      return [{ id: 81 }];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 100)}`);
  });
  return { $queryRawUnsafe: query };
}

describe('prescriber-governed MAR hold release', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    recordCanonicalClinicalEventMock.mockResolvedValue({ id: 1 });
    finaliseMarHttpIdempotencyTxMock.mockResolvedValue({ id: CLAIM.httpIdempotencyClaimId });
    resolveMarMedicationExceptionTxMock.mockResolvedValue({
      exceptionCase: { id: 81, status: 'resolved' },
      event: { id: 82, disposition: 'hold_released' },
    });
  });

  test('commits the release, canonical event, and HTTP claim in one tenant transaction', async () => {
    const tx = createTx();
    setTenantTxMock.mockImplementation(async (_tenantId, callback) => callback(tx));

    const result = await releaseHeldMedication(
      42,
      'Prescriber reviewed current observations and approved administration',
      IDS.actor,
      { tenantId: IDS.tenant, ...CLAIM },
    );

    expect(result).toMatchObject({ id: 42, status: 'scheduled' });
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'mar.hold_released',
        patientUid: IDS.patient,
        payload: expect.objectContaining({
          release_reason: 'Prescriber reviewed current observations and approved administration',
          held_reason: 'Awaiting review',
        }),
      }),
      expect.objectContaining({ db: tx }),
    );
    expect(finaliseMarHttpIdempotencyTxMock).toHaveBeenCalledWith(tx, {
      claimId: CLAIM.httpIdempotencyClaimId,
      tenantId: IDS.tenant,
      actorUid: IDS.actor,
      commandKey: CLAIM.commandKey,
      requestBodySha256: CLAIM.requestFingerprint,
      responseData: expect.objectContaining({ id: 42, status: 'scheduled' }),
      requestId: CLAIM.requestId,
      message: 'Medication hold released by prescriber',
    });
    expect(resolveMarMedicationExceptionTxMock).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        tenantId: IDS.tenant,
        exceptionCaseId: '81',
        disposition: 'hold_released',
        actorUid: IDS.actor,
        commandKey: CLAIM.commandKey,
        requestFingerprint: CLAIM.requestFingerprint,
      }),
    );
  });

  test('fails before mutation when durable HTTP command evidence is absent', async () => {
    await expect(releaseHeldMedication(
      42,
      'Prescriber approved administration',
      IDS.actor,
      { tenantId: IDS.tenant },
    )).rejects.toMatchObject({
      statusCode: 400,
      code: 'MAR_HOLD_RELEASE_IDEMPOTENCY_REQUIRED',
    });
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  test('rejects an active non-prescriber before releasing the held state', async () => {
    const tx = createTx({ role: 'NURSING_INCHARGE' });
    setTenantTxMock.mockImplementation(async (_tenantId, callback) => callback(tx));

    await expect(releaseHeldMedication(
      42,
      'Nursing review is not prescriber authority',
      IDS.actor,
      { tenantId: IDS.tenant, ...CLAIM },
    )).rejects.toMatchObject({
      statusCode: 403,
      code: 'MAR_HOLD_RELEASE_PRESCRIBER_REQUIRED',
    });
    expect(tx.$queryRawUnsafe.mock.calls.some(([sql]) => (
      sql.includes('UPDATE medication_administrations')
    ))).toBe(false);
    expect(finaliseMarHttpIdempotencyTxMock).not.toHaveBeenCalled();
  });
});
