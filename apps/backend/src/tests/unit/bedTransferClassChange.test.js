// Unit regression for finding H' D34 (19030e9a).
//
// `bedManagementService.transferPatient` moved a patient from bed A
// to bed B without:
//   * Updating `admissions.room_category` to match the new bed's
//     type — billing tariff stayed anchored to the OLD class, so a
//     patient moved to a private bed still got billed at general
//     rate.
//   * Surfacing a cost-difference warning for class upgrades — the
//     operator (and patient) had no signal that moving general →
//     private/deluxe changed the room-rate tariff.
//
// Fix:
//   * Upgrades (CLASS_RANK toBed > fromBed) reject with 400
//     BED_TRANSFER_CLASS_CHANGE_UNACKNOWLEDGED unless the caller
//     passes `acknowledgeClassChange: true` (staff app must have
//     prompted the patient with the price-difference dialog).
//   * After the bed assignment commits, the admission's
//     `room_category` is re-stamped to match the new bed type so
//     billing emits line items at the correct rate.
//   * ICU upgrades skip this gate (already enforced via
//     canAllocateIcu earlier in the function).
//   * Downgrades (private → general) are allowed without
//     acknowledgement (billing benefit, not hazard).
//
// Asserts on the prisma-mock surface so we can drive the function
// without a live DB.

import { jest } from '@jest/globals';

const queryRawMock = jest.fn();
const executeRawMock = jest.fn();
const txMock = jest.fn();
const setTenantTxMock = jest.fn();
const recordCanonicalClinicalEventMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  circuitBreakerStatus: jest.fn(() => ({ open: false, consecutiveFailures: 0 })),
  default: {
    $queryRawUnsafe: queryRawMock,
    $executeRawUnsafe: executeRawMock,
    $transaction: txMock,
  },
  isTenantTransactionClient: () => true,
  setTenant: setTenantTxMock,
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  cancelWorkflowSla: jest.fn(),
  completeWorkflowSla: jest.fn(),
  currentCanonicalTransactionRevision: jest.fn().mockResolvedValue(1),
  isSchemaMissing: jest.fn(() => false),
  recordClinicalAuditEvent: jest.fn(),
  startWorkflowSla: jest.fn(),
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
}));

const bedManagementService = (await import('../../services/bed/bedManagementService.js')).default;

const PATIENT = 'cccc1111-2222-4333-8444-eeeeeeee3434';
const TENANT = '00000000-0000-4000-8000-000000000001';
const TX_CLIENT = {
  $queryRawUnsafe: queryRawMock,
  $executeRawUnsafe: executeRawMock,
};

beforeEach(() => {
  queryRawMock.mockReset();
  executeRawMock.mockReset();
  txMock.mockReset();
  setTenantTxMock.mockReset();
  // Make $transaction invoke the callback with our tx mock shim so
  // the same queryRawMock / executeRawMock instrumented sites fire.
  txMock.mockImplementation(async (fn) => fn(TX_CLIENT));
  // setTenantTx(tenantId, fn) mirrors $transaction but takes a leading tenant arg.
  setTenantTxMock.mockImplementation(async (_tenantId, fn) => fn(TX_CLIENT));
  executeRawMock.mockResolvedValue(1);
  recordCanonicalClinicalEventMock.mockResolvedValue({
    timeline: { id: 'timeline-1' },
    audit: { id: 'audit-1' },
  });
});

function mockTransferRows({ fromBedType, toBedType, toStatus = 'available' }) {
  queryRawMock
    // current bed lookup
    .mockResolvedValueOnce([{ id: 100, tenant_id: TENANT, bed_number: 'A1', bed_type: fromBedType }])
    // target bed lookup
    .mockResolvedValueOnce([{ id: 200, tenant_id: TENANT, status: toStatus, bed_number: 'B2', bed_type: toBedType }])
    // active admission lookup
    .mockResolvedValueOnce([{
      id: 300,
      tenant_id: TENANT,
      patient_uid: PATIENT,
      admitted_at: new Date('2026-05-01T00:00:00.000Z'),
      expected_los_days: 3,
    }])
    // patient user lookup for destination bed back-link snapshot
    .mockResolvedValueOnce([{ id: 400, name: 'Transfer Test Patient' }])
    // occupy new bed RETURNING
    .mockResolvedValueOnce([{
      id: 200, bed_number: 'B2', ward_id: 5, status: 'occupied',
      patient_uid: PATIENT, assigned_at: new Date(),
      created_at: new Date(), updated_at: new Date(), bed_type: toBedType,
    }])
    // bed_transfers INSERT ... RETURNING
    .mockResolvedValueOnce([{
      id: 500, tenant_id: TENANT, patient_uid: PATIENT, admission_id: 300,
      from_bed_id: 100, to_bed_id: 200, reason: 'test transfer',
      transferred_by: 'staff-uid', transferred_at: new Date(),
    }])
    // active device-association ADT cleanup (endActiveAssociationsForPatient)
    .mockResolvedValueOnce([])
    // bed_cleaning_turnaround SLA rule lookup (startWorkflowSla, in-tx) — return
    // no rule so the SLA start is a clean no-op for this unit-level mock. The
    // real atomic behaviour is proven in bed-cleaning-sla-atomicity.deep.test.js.
    .mockResolvedValueOnce([]);
}

describe('bedManagementService.transferPatient — class-change reconciliation (H D34)', () => {
  it('rejects general → private upgrade without acknowledgement (400 BED_TRANSFER_CLASS_CHANGE_UNACKNOWLEDGED)', async () => {
    mockTransferRows({ fromBedType: 'general', toBedType: 'private' });
    await expect(
      bedManagementService.transferPatient(PATIENT, 200, 'patient request', 'staff-uid', 'ADMIN'),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'BED_TRANSFER_CLASS_CHANGE_UNACKNOWLEDGED',
      details: expect.objectContaining({
        from_bed_type: 'general',
        to_bed_type: 'private',
      }),
    });
  });

  it('accepts general → private when acknowledgeClassChange=true AND re-stamps admissions.room_category', async () => {
    mockTransferRows({ fromBedType: 'general', toBedType: 'private' });
    const result = await bedManagementService.transferPatient(
      PATIENT, 200, 'patient request', 'staff-uid', 'ADMIN',
      { acknowledgeClassChange: true },
    );
    expect(result.to_bed.bed_number).toBe('B2');
    expect(result.class_change).toEqual({ from: 'general', to: 'private', acknowledged: true });
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'bed.transferred',
        patientUid: PATIENT,
        actorUid: 'staff-uid',
        actorRole: 'ADMIN',
        sourceTable: 'bed_transfers',
      }),
      { db: TX_CLIENT },
    );
    // The admission's room_category was re-stamped to match the new bed type.
    const restampCall = executeRawMock.mock.calls.find((args) =>
      /UPDATE admissions[\s\S]*room_category/i.test(args[0]),
    );
    expect(restampCall).toBeTruthy();
    expect(restampCall[1]).toBe(200);
    expect(restampCall[2]).toBe('B2');
    expect(restampCall[4]).toBe('private');
    expect(restampCall[5]).toBe(300);
  });

  it('threads tenant filters through bed transfer source, control, and sink queries', async () => {
    mockTransferRows({ fromBedType: 'general', toBedType: 'private' });
    await bedManagementService.transferPatient(
      PATIENT, 200, 'patient request', 'staff-uid', 'ADMIN',
      { acknowledgeClassChange: true, tenantId: TENANT },
    );

    expect(queryRawMock.mock.calls[0][0]).toContain('tenant_id = $2::uuid');
    expect(queryRawMock.mock.calls[0][2]).toBe(TENANT);
    expect(queryRawMock.mock.calls[1][0]).toContain('b.tenant_id = $2::uuid');
    expect(queryRawMock.mock.calls[1][2]).toBe(TENANT);
    expect(queryRawMock.mock.calls[2][0]).toContain('tenant_id = $2::uuid');
    expect(queryRawMock.mock.calls[2][2]).toBe(TENANT);
    expect(queryRawMock.mock.calls[3][0]).toContain('tenant_id = $2::uuid');
    expect(queryRawMock.mock.calls[3][2]).toBe(TENANT);

    const vacateCall = executeRawMock.mock.calls.find((args) =>
      /UPDATE beds[\s\S]*status = 'cleaning'/i.test(args[0]),
    );
    expect(vacateCall[0]).toContain('tenant_id = $2::uuid');
    expect(vacateCall[2]).toBe(TENANT);

    const restampCall = executeRawMock.mock.calls.find((args) =>
      /UPDATE admissions[\s\S]*room_category/i.test(args[0]),
    );
    expect(restampCall[0]).toContain('tenant_id = $6::uuid');
    expect(restampCall[6]).toBe(TENANT);

    const transferInsertCall = queryRawMock.mock.calls.find((args) =>
      /INSERT INTO bed_transfers \(tenant_id/i.test(args[0]),
    );
    expect(transferInsertCall[1]).toBe(TENANT);
  });

  it('accepts private → general downgrade WITHOUT acknowledgement', async () => {
    mockTransferRows({ fromBedType: 'private', toBedType: 'general' });
    const result = await bedManagementService.transferPatient(
      PATIENT, 200, 'cost concern', 'staff-uid', 'ADMIN',
    );
    expect(result.to_bed.bed_number).toBe('B2');
    expect(result.class_change).toBeNull();
    // Even on downgrade, room_category re-stamps so billing aligns.
    const restampCall = executeRawMock.mock.calls.find((args) =>
      /UPDATE admissions[\s\S]*room_category/i.test(args[0]),
    );
    expect(restampCall[4]).toBe('general');
  });

  it('accepts same-tier transfer (general → general) without acknowledgement', async () => {
    mockTransferRows({ fromBedType: 'general', toBedType: 'general' });
    const result = await bedManagementService.transferPatient(
      PATIENT, 200, 'ward change', 'staff-uid', 'ADMIN',
    );
    expect(result.class_change).toBeNull();
  });

  it('rejects the transfer transaction when canonical persistence returns null', async () => {
    mockTransferRows({ fromBedType: 'general', toBedType: 'general' });
    recordCanonicalClinicalEventMock.mockResolvedValueOnce({ timeline: null, audit: null });

    await expect(
      bedManagementService.transferPatient(
        PATIENT, 200, 'ward change', 'staff-uid', 'ADMIN', { tenantId: TENANT },
      ),
    ).rejects.toMatchObject({ code: 'BED_CANONICAL_EVENT_REQUIRED' });
  });

  it('still rejects target bed that is not available (status check)', async () => {
    mockTransferRows({ fromBedType: 'general', toBedType: 'general', toStatus: 'cleaning' });
    await expect(
      bedManagementService.transferPatient(PATIENT, 200, 'reason', 'staff-uid', 'ADMIN'),
    ).rejects.toThrow(/not available/i);
  });
});
