import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';

const setTenantTxMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: setTenantTxMock,
}));
// Only the MAR supply reconciliation obligations are exercised here, but
// marSupplyService's service graph reaches billingV2Service and
// billingCreditNoteService, which link against the ward-indent and credit-note
// obligation helpers. Mock the module's WHOLE named surface so the graph links
// no matter which consumer the import order pulls in first.
jest.unstable_mockModule('../../services/ipd/wardIndentObligationService.js', () => ({
  completeMarSupplyReconciliationObligationTx: jest.fn(),
  materializeMarSupplyReconciliationObligationTx: jest.fn(),
  completeWardIndentStateObligationTx: jest.fn(),
  materializeWardIndentStateObligationTx: jest.fn(),
  reconcileWardIndentNotificationCoverageTx: jest.fn(),
  sweepWardIndentNotificationCoverage: jest.fn(),
  materializeBillingCreditNoteObligationTx: jest.fn(),
  completeBillingCreditNoteObligationTx: jest.fn(),
  advanceBillingCreditNoteObligationTx: jest.fn(),
  advanceBillingCreditNoteRefundObligationTx: jest.fn(),
  advanceBillingCreditNoteRefundPayoutObligationTx: jest.fn(),
  completeBillingCreditNoteRefundObligationTx: jest.fn(),
}));
// marSupplyService reads only CONTROLLED_DISPENSE_WITNESS_ROLES (narrowed here
// so the witness-role refusal is provable), but the wider graph links against
// the scope map and the approval helpers. The scope map is a CONSTANT consumers
// index at module scope, so it carries the real frozen values, not a jest.fn().
jest.unstable_mockModule('../../services/pharmacy/controlledDispenseWitnessService.js', () => ({
  CONTROLLED_DISPENSE_WITNESS_ROLES: ['DOCTOR', 'NURSING_STAFF'],
  FACILITY_BOUND_CONTROLLED_DISPENSE_WITNESS_ROLES: ['PHARMACY_STAFF', 'PHARMACY_INCHARGE'],
  CONTROLLED_DISPENSE_APPROVAL_SCOPES: {
    inventory: 'inventory_controlled_dispense',
    inventoryMovement: 'inventory_controlled_movement',
    inventoryDisposal: 'pharmacy_inventory_controlled_disposal',
    pharmacyOrder: 'pharmacy_order_inventory_dispense',
    counterSale: 'pharmacy_counter_sale',
    dispenseSubstitution: 'pharmacy_dispense_substitution',
    wardIndent: 'ward_indent_controlled_handoff',
  },
  serializeControlledDispenseWitnessApproval: jest.fn(),
  controlledDispenseApprovalFingerprint: jest.fn(),
  assertControlledDispenseWitness: jest.fn(),
  createControlledDispenseWitnessApproval: jest.fn(),
  preflightControlledDispenseWitnessApproval: jest.fn(),
  approveControlledDispenseWitnessApproval: jest.fn(),
  assertApprovedControlledDispenseWitness: jest.fn(),
  consumeControlledDispenseWitnessApproval: jest.fn(),
  isControlledDispenseWitnessEvidence: jest.fn(),
}));

const { reconcileMarSupplyOverride } = await import('../../services/clinical/marSupplyService.js');

const IDS = Object.freeze({
  actor: '10000000-0000-4000-8000-000000000001',
  otherActor: '10000000-0000-4000-8000-000000000002',
  tenant: '10000000-0000-4000-8000-000000000003',
});
const CONSUMPTION_ID = 9001n;
const ADMINISTRATION_ID = 42;
const COMMAND_KEY = 'mar-supply-reconciliation-whole-command';
const STORED_RESPONSE = Object.freeze({
  consumption: { id: 9001, medication_administration_id: ADMINISTRATION_ID },
  links: [{ id: 71 }, { id: 72 }],
  reconciled_quantity: 1.5,
  outstanding_quantity: 0,
  state: { status: 'consumed' },
});

function fingerprint(allocations, expectedMedicationAdministrationId = ADMINISTRATION_ID) {
  const byId = new Map();
  for (const allocation of allocations) {
    const key = BigInt(allocation.inventory_allocation_id).toString();
    byId.set(key, Math.round(((byId.get(key) || 0) + allocation.quantity) * 10000) / 10000);
  }
  const normalized = {
    consumption_id: CONSUMPTION_ID.toString(),
    expected_medication_administration_id: expectedMedicationAdministrationId,
    allocations: [...byId.entries()]
      .sort(([left], [right]) => (BigInt(left) < BigInt(right) ? -1 : 1))
      .map(([inventoryAllocationId, quantity]) => ({
        inventory_allocation_id: inventoryAllocationId,
        quantity: quantity.toFixed(4),
      })),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function replayTx({ allocations, actorUid = IDS.actor, expectedId = ADMINISTRATION_ID }) {
  return {
    $queryRawUnsafe: jest.fn(async (sql) => {
      if (sql.includes('pg_advisory_xact_lock')) return [{ lock_result: '' }];
      if (sql.includes('FROM mar_supply_consumptions')) {
        return [{
          id: CONSUMPTION_ID,
          tenant_id: IDS.tenant,
          medication_administration_id: ADMINISTRATION_ID,
          clinical_order_id: 31,
          ward_indent_item_id: 61,
          quantity: 1.5,
          evidence_status: 'unmatched_override',
          recorded_by: IDS.actor,
        }];
      }
      if (sql.includes('FROM mar_supply_reconciliation_command_receipts')) {
        return [{
          id: 81n,
          tenant_id: IDS.tenant,
          unmatched_consumption_id: CONSUMPTION_ID,
          medication_administration_id: ADMINISTRATION_ID,
          actor_uid: actorUid,
          command_key: COMMAND_KEY,
          request_body_sha256: fingerprint(allocations, expectedId),
          response_data: STORED_RESPONSE,
          completed_at: '2026-08-27T10:00:00.000Z',
        }];
      }
      throw new Error(`Unexpected SQL: ${sql.slice(0, 120)}`);
    }),
  };
}

describe('whole-command MAR supply reconciliation idempotency', () => {
  const baseAllocations = Object.freeze([
    { inventory_allocation_id: '8', quantity: 0.5 },
    { inventory_allocation_id: '7', quantity: 1 },
  ]);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each([
    ['numeric consumption id', 9001, baseAllocations, ADMINISTRATION_ID],
    ['overflowing consumption id', '9223372036854775808', baseAllocations, ADMINISTRATION_ID],
    ['numeric allocation id', '9001', [
      { inventory_allocation_id: 7, quantity: 1 },
    ], ADMINISTRATION_ID],
    ['overflowing allocation id', '9001', [
      { inventory_allocation_id: '9223372036854775808', quantity: 1 },
    ], ADMINISTRATION_ID],
    ['overflowing medication administration id', '9001', baseAllocations, 2147483648],
  ])('rejects %s before opening a database transaction', async (
    _case,
    consumptionId,
    allocations,
    expectedMedicationAdministrationId,
  ) => {
    await expect(reconcileMarSupplyOverride(
      consumptionId,
      allocations,
      {
        tenantId: IDS.tenant,
        reconciledBy: IDS.actor,
        commandKey: COMMAND_KEY,
        expectedMedicationAdministrationId,
      },
    )).rejects.toMatchObject({ statusCode: 400 });
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  test('replays the stored response for the exact normalized allocation command', async () => {
    const tx = replayTx({ allocations: baseAllocations });
    setTenantTxMock.mockImplementation(async (_tenantId, callback) => callback(tx));

    const replay = await reconcileMarSupplyOverride(
      CONSUMPTION_ID,
      [
        { inventory_allocation_id: '8', quantity: 0.25 },
        { inventory_allocation_id: '7', quantity: 1 },
        { inventory_allocation_id: '8', quantity: 0.25 },
      ],
      {
        tenantId: IDS.tenant,
        reconciledBy: IDS.actor,
        commandKey: COMMAND_KEY,
        expectedMedicationAdministrationId: ADMINISTRATION_ID,
      },
    );

    expect(replay).toEqual(STORED_RESPONSE);
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(3);
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    expect(tx.$queryRawUnsafe.mock.calls[1][0]).not.toContain('FOR UPDATE');
  });

  test.each([
    ['expanded', [
      ...baseAllocations,
      { inventory_allocation_id: '9', quantity: 0.25 },
    ]],
    ['shrunk', [baseAllocations[1]]],
  ])('rejects a %s allocation-set replay under the same command key', async (_case, allocations) => {
    const tx = replayTx({ allocations: baseAllocations });
    setTenantTxMock.mockImplementation(async (_tenantId, callback) => callback(tx));

    await expect(reconcileMarSupplyOverride(
      CONSUMPTION_ID,
      allocations,
      {
        tenantId: IDS.tenant,
        reconciledBy: IDS.actor,
        commandKey: COMMAND_KEY,
        expectedMedicationAdministrationId: ADMINISTRATION_ID,
      },
    )).rejects.toMatchObject({
      statusCode: 422,
      code: 'MAR_SUPPLY_RECONCILIATION_COMMAND_MISMATCH',
    });
  });

  test.each([
    ['actor', IDS.otherActor, ADMINISTRATION_ID],
    ['target', IDS.actor, ADMINISTRATION_ID + 1],
  ])('rejects changed %s identity under the same command key', async (_case, actor, expectedId) => {
    const tx = replayTx({ allocations: baseAllocations });
    setTenantTxMock.mockImplementation(async (_tenantId, callback) => callback(tx));

    await expect(reconcileMarSupplyOverride(
      CONSUMPTION_ID,
      baseAllocations,
      {
        tenantId: IDS.tenant,
        reconciledBy: actor,
        commandKey: COMMAND_KEY,
        expectedMedicationAdministrationId: expectedId,
      },
    )).rejects.toMatchObject({
      statusCode: 422,
      code: 'MAR_SUPPLY_RECONCILIATION_COMMAND_MISMATCH',
    });
  });
});
