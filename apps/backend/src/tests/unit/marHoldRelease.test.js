import { jest } from '@jest/globals';

const setTenantTxMock = jest.fn();
const recordCanonicalClinicalEventMock = jest.fn();
const finaliseMarHttpIdempotencyTxMock = jest.fn();
const claimMarMedicationExceptionTxMock = jest.fn();
const claimMarMedicationExceptionTaskTxMock = jest.fn();
const completeTaskFromDomainEvidenceMock = jest.fn();
const resolveMarMedicationExceptionTxMock = jest.fn();
const resolveMarMedicationExceptionForTerminalOrderTxMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn() },
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
  recordMedicationSafetyReviews: jest.fn(),
}));
jest.unstable_mockModule('../../services/clinical/marSupplyService.js', () => ({
  assertMedicationOrdersExecutionReadyTx: jest.fn(),
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
  claimMarMedicationExceptionTx: claimMarMedicationExceptionTxMock,
  getMarExceptionMedicationAdministrationId: jest.fn(),
  handoffMarMedicationExceptionTx: jest.fn(),
  listAssignedMarMedicationExceptions: jest.fn(),
  openMarMedicationExceptionTx: jest.fn(),
  requiredMarMedicationExceptionCaseId: (value) => String(value),
  requiredMarMedicationExceptionEventId: (value) => String(value),
  resolveMarMedicationExceptionForTerminalOrderTx:
    resolveMarMedicationExceptionForTerminalOrderTxMock,
  resolveMarMedicationExceptionTx: resolveMarMedicationExceptionTxMock,
}));
jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  claimMarMedicationExceptionTaskTx: claimMarMedicationExceptionTaskTxMock,
  completeTaskFromDomainEvidence: completeTaskFromDomainEvidenceMock,
  createMarMedicationExceptionTaskTx: jest.fn(),
}));

const {
  releaseHeldMedication,
  terminallyProjectMedicationOrderDosesTx,
} = await import('../../services/clinical/marService.js');

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
    if (sql.includes('FROM medication_administrations')
      && !sql.includes('administration.')) {
      return [{ clinical_order_id: 91 }];
    }
    if (sql.includes('FROM clinical_orders clinical_order')) {
      return [{
        id: 91,
        clinical_order_status: 'verified',
        clinical_order_verified_by: IDS.actor,
        clinical_order_verified_at: '2026-08-27T08:00:00.000Z',
        release_actor_role: role,
      }];
    }
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
    const statements = tx.$queryRawUnsafe.mock.calls.map(([sql]) => sql);
    const orderLockIndex = statements.findIndex((sql) => (
      sql.includes('FROM clinical_orders clinical_order')
    ));
    const marLockIndex = statements.findIndex((sql) => (
      sql.includes('FROM medication_administrations administration')
    ));
    expect(orderLockIndex).toBeGreaterThanOrEqual(0);
    expect(marLockIndex).toBeGreaterThan(orderLockIndex);
    expect(statements[orderLockIndex]).toContain('FOR UPDATE OF clinical_order');
    expect(statements[orderLockIndex]).toContain('FOR SHARE OF actor');
    expect(statements[orderLockIndex]).not.toContain('FOR SHARE OF clinical_order');
    expect(statements[marLockIndex]).toContain('FOR UPDATE OF administration');
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

describe('terminal medication-order MAR projection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveMarMedicationExceptionForTerminalOrderTxMock.mockResolvedValue({
      exceptionCase: { id: 81, status: 'resolved' },
      event: { id: 82, disposition: 'order_stopped' },
    });
    recordCanonicalClinicalEventMock.mockResolvedValue({ id: 1 });
  });

  test('cancels a future held dose, closes its exception obligation, and suppresses stale alerts', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const heldDose = {
      id: 42,
      patient_uid: IDS.patient,
      medication_name: 'Unit test medicine',
      dose: '500 mg',
      dosage: null,
      route: 'oral',
      scheduled_time: future,
      administered_at: null,
      administered_by: null,
      status: 'held',
      notes: null,
      hold_reason: 'Awaiting prescriber review',
      refusal_reason: null,
      witness_uid: null,
      tenant_id: IDS.tenant,
      clinical_order_id: 91,
      supply_quantity_per_dose: 1,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM clinical_orders clinical_order')) {
          return [{ id: 91, status: 'cancelled', actor_role: 'DOCTOR' }];
        }
        if (sql.includes('FROM medication_administrations')) return [heldDose];
        if (sql.includes('FROM mar_medication_exception_cases')) {
          return [{ id: 81 }];
        }
        if (sql.includes('FROM notification_outbox')) return [];
        if (sql.includes('UPDATE medication_administrations')) {
          return [{ ...heldDose, status: 'cancelled', updated_at: new Date() }];
        }
        throw new Error(`Unexpected SQL: ${sql.slice(0, 100)}`);
      }),
      $executeRawUnsafe: jest.fn().mockResolvedValue(2),
    };

    const result = await terminallyProjectMedicationOrderDosesTx(tx, {
      tenantId: IDS.tenant,
      order: {
        id: 91,
        tenant_id: IDS.tenant,
        order_type: 'medication',
        encounter_id: null,
      },
      actorUid: IDS.actor,
      terminalStatus: 'cancelled',
      reason: 'Medication no longer clinically indicated',
    });

    expect(result).toEqual([expect.objectContaining({
      medication_administration_id: 42,
      previous_status: 'held',
      status: 'cancelled',
      resolved_exception_case_id: '81',
      suppressed_notification_count: 2,
    })]);
    expect(claimMarMedicationExceptionTxMock).not.toHaveBeenCalled();
    expect(resolveMarMedicationExceptionForTerminalOrderTxMock).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
      tenantId: IDS.tenant,
      exceptionCaseId: '81',
      actorUid: IDS.actor,
      completeTaskTx: completeTaskFromDomainEvidenceMock,
      }),
    );
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("status = 'SUPPRESSED'"),
      IDS.tenant,
      'mar-exception:81:%',
    );
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'mar.order_terminally_projected',
        eventStatus: 'cancelled',
        payload: expect.objectContaining({
          clinical_order_terminal_status: 'cancelled',
          terminal_reason: 'Medication no longer clinically indicated',
          resolved_exception_case_id: '81',
          suppressed_notification_count: 2,
        }),
      }),
      { db: tx },
    );
  });

  test('closes an assigned exception from the authorized parent-order transition', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM clinical_orders clinical_order')) {
          return [{ id: 91, status: 'discontinued', actor_role: 'DOCTOR' }];
        }
        if (sql.includes('FROM medication_administrations')) {
          return [{
            id: 42,
            tenant_id: IDS.tenant,
            patient_uid: IDS.patient,
            clinical_order_id: 91,
            scheduled_time: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            status: 'held',
          }];
        }
        if (sql.includes('FROM mar_medication_exception_cases')) {
          return [{ id: 81, assigned_prescriber_uid: '10000000-0000-4000-8000-000000000099' }];
        }
        if (sql.includes('FROM notification_outbox')) return [];
        if (sql.includes('UPDATE medication_administrations')) {
          return [{
            id: 42,
            tenant_id: IDS.tenant,
            patient_uid: IDS.patient,
            clinical_order_id: 91,
            scheduled_time: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            status: 'cancelled',
          }];
        }
        throw new Error(`Unexpected SQL: ${sql.slice(0, 100)}`);
      }),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    };

    await terminallyProjectMedicationOrderDosesTx(tx, {
      tenantId: IDS.tenant,
      order: { id: 91, tenant_id: IDS.tenant, order_type: 'medication' },
      actorUid: IDS.actor,
      terminalStatus: 'discontinued',
      reason: 'Therapy changed',
    });
    expect(claimMarMedicationExceptionTxMock).not.toHaveBeenCalled();
    expect(resolveMarMedicationExceptionForTerminalOrderTxMock).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ exceptionCaseId: '81', actorUid: IDS.actor }),
    );
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalled();
  });

  test('fails closed while a critical exception alert has an in-flight claim', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM clinical_orders clinical_order')) {
          return [{ id: 91, status: 'completed', actor_role: 'DOCTOR' }];
        }
        if (sql.includes('FROM medication_administrations')) {
          return [{
            id: 42,
            tenant_id: IDS.tenant,
            patient_uid: IDS.patient,
            clinical_order_id: 91,
            scheduled_time: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            status: 'missed',
          }];
        }
        if (sql.includes('FROM mar_medication_exception_cases')) return [{ id: 81 }];
        if (sql.includes('FROM notification_outbox')) {
          return [{
            id: 700,
            status: 'CLAIMED',
            claim_generation: 3,
            lease_expires_at: new Date(Date.now() + 30_000),
          }];
        }
        throw new Error(`Unexpected SQL: ${sql.slice(0, 100)}`);
      }),
      $executeRawUnsafe: jest.fn(),
    };

    await expect(terminallyProjectMedicationOrderDosesTx(tx, {
      tenantId: IDS.tenant,
      order: { id: 91, tenant_id: IDS.tenant, order_type: 'medication' },
      actorUid: IDS.actor,
      terminalStatus: 'completed',
      reason: 'Medication course completed',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'MAR_ORDER_TERMINAL_EXCEPTION_NOTIFICATION_IN_FLIGHT',
      details: { notification_outbox_id: 700, notification_status: 'CLAIMED' },
    });
    expect(resolveMarMedicationExceptionForTerminalOrderTxMock).not.toHaveBeenCalled();
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });
});
