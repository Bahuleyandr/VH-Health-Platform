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

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawMock,
    $executeRawUnsafe: executeRawMock,
    $transaction: txMock,
  },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const bedManagementService = (await import('../../services/bed/bedManagementService.js')).default;

const PATIENT = 'cccc1111-2222-4333-8444-eeeeeeee3434';
const TX_CLIENT = {
  $queryRawUnsafe: queryRawMock,
  $executeRawUnsafe: executeRawMock,
};

beforeEach(() => {
  queryRawMock.mockReset();
  executeRawMock.mockReset();
  txMock.mockReset();
  // Make $transaction invoke the callback with our tx mock shim so
  // the same queryRawMock / executeRawMock instrumented sites fire.
  txMock.mockImplementation(async (fn) => fn(TX_CLIENT));
  executeRawMock.mockResolvedValue(1);
});

function mockTransferRows({ fromBedType, toBedType, toStatus = 'available' }) {
  queryRawMock
    // current bed lookup
    .mockResolvedValueOnce([{ id: 100, bed_number: 'A1', bed_type: fromBedType }])
    // target bed lookup
    .mockResolvedValueOnce([{ id: 200, status: toStatus, bed_number: 'B2', bed_type: toBedType }])
    // occupy new bed RETURNING
    .mockResolvedValueOnce([{
      id: 200, bed_number: 'B2', ward_id: 5, status: 'occupied',
      patient_uid: PATIENT, assigned_at: new Date(),
      created_at: new Date(), updated_at: new Date(), bed_type: toBedType,
    }]);
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
    // The admission's room_category was re-stamped to match the new bed type.
    const restampCall = executeRawMock.mock.calls.find((args) =>
      /UPDATE admissions[\s\S]*room_category/i.test(args[0]),
    );
    expect(restampCall).toBeTruthy();
    expect(restampCall[1]).toBe('private');
    expect(restampCall[2]).toBe(PATIENT);
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
    expect(restampCall[1]).toBe('general');
  });

  it('accepts same-tier transfer (general → general) without acknowledgement', async () => {
    mockTransferRows({ fromBedType: 'general', toBedType: 'general' });
    const result = await bedManagementService.transferPatient(
      PATIENT, 200, 'ward change', 'staff-uid', 'ADMIN',
    );
    expect(result.class_change).toBeNull();
  });

  it('still rejects target bed that is not available (status check)', async () => {
    mockTransferRows({ fromBedType: 'general', toBedType: 'general', toStatus: 'cleaning' });
    await expect(
      bedManagementService.transferPatient(PATIENT, 200, 'reason', 'staff-uid', 'ADMIN'),
    ).rejects.toThrow(/not available/i);
  });
});
