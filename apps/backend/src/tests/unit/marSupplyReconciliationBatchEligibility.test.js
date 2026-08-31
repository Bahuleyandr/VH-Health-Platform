import { readFileSync } from 'node:fs';
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

const { reconcileMarSupplyOverride } = await import(
  '../../services/clinical/marSupplyService.js'
);

const migration = readFileSync(
  new URL('../../migrations/744_medication_inventory_billing_mar_closure.sql', import.meta.url),
  'utf8',
);

const IDS = Object.freeze({
  actor: '20000000-0000-4000-8000-000000000001',
  tenant: '20000000-0000-4000-8000-000000000002',
});
const CONSUMPTION_ID = 9101n;
const ADMINISTRATION_ID = 52;
const ALLOCATION_ID = 77n;
const COMMAND_KEY = 'mar-supply-batch-eligibility';

function fingerprint() {
  const normalized = {
    consumption_id: CONSUMPTION_ID.toString(),
    expected_medication_administration_id: ADMINISTRATION_ID,
    allocations: [{
      inventory_allocation_id: ALLOCATION_ID.toString(),
      quantity: '1.0000',
    }],
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function consumptionRow() {
  return {
    id: CONSUMPTION_ID,
    tenant_id: IDS.tenant,
    medication_administration_id: ADMINISTRATION_ID,
    clinical_order_id: 31,
    ward_indent_item_id: 61,
    quantity: 1,
    evidence_status: 'unmatched_override',
    recorded_by: IDS.actor,
  };
}

function allocationRow(reason) {
  return {
    inventory_batch_id: 88,
    status: 'received',
    received_quantity: 2,
    consumed_quantity: 0,
    returned_quantity: 0,
    available_quantity: 2,
    batch_status: reason.replace(/^batch_/, ''),
    expiry_date: '2099-12-31',
    inventory_item_status: reason === 'inventory_item_inactive' ? 'inactive' : 'active',
    batch_unavailable_reason: reason,
  };
}

function serviceTx(reason) {
  return {
    $queryRawUnsafe: jest.fn(async (sql) => {
      if (sql.includes('pg_advisory_xact_lock')) return [{ lock_result: '' }];
      if (sql.includes('FROM mar_supply_consumptions')) return [consumptionRow()];
      if (sql.includes('FROM mar_supply_reconciliation_command_receipts')) return [];
      if (sql.includes('FROM ward_indent_inventory_allocations allocation')) {
        return [allocationRow(reason)];
      }
      throw new Error(`Unexpected SQL: ${sql.slice(0, 160)}`);
    }),
  };
}

describe('MAR supply reconciliation current-batch eligibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each([
    'batch_expired',
    'batch_recalled',
    'batch_quarantined',
    'batch_reserved',
    'inventory_item_inactive',
  ])('rejects %s custody before writing reconciliation evidence', async (reason) => {
    const tx = serviceTx(reason);
    setTenantTxMock.mockImplementation(async (_tenantId, callback) => callback(tx));

    await expect(reconcileMarSupplyOverride(
      CONSUMPTION_ID,
      [{ inventory_allocation_id: ALLOCATION_ID, quantity: 1 }],
      {
        tenantId: IDS.tenant,
        reconciledBy: IDS.actor,
        commandKey: COMMAND_KEY,
        expectedMedicationAdministrationId: ADMINISTRATION_ID,
      },
    )).rejects.toMatchObject({
      statusCode: 409,
      code: 'MAR_SUPPLY_RECONCILIATION_BATCH_UNAVAILABLE',
      details: {
        inventory_allocation_id: ALLOCATION_ID.toString(),
        inventory_batch_id: 88,
        reason,
      },
    });

    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(4);
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    const allocationSql = tx.$queryRawUnsafe.mock.calls[3][0];
    expect(allocationSql).toContain('mar_supply_batch_unavailable_reason(');
    expect(allocationSql).toContain('FOR UPDATE OF allocation, batch FOR SHARE OF item');
    expect(tx.$queryRawUnsafe.mock.calls.some(([sql]) => (
      sql.includes('INSERT INTO mar_supply_reconciliation_links')
    ))).toBe(false);
  });

  test('returns an exact stored replay before current batch eligibility is re-evaluated', async () => {
    const storedResponse = {
      consumption: { id: Number(CONSUMPTION_ID) },
      links: [{ id: 501 }],
      reconciled_quantity: 1,
      outstanding_quantity: 0,
      state: { status: 'consumed' },
    };
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('pg_advisory_xact_lock')) return [{ lock_result: '' }];
        if (sql.includes('FROM mar_supply_consumptions')) return [consumptionRow()];
        if (sql.includes('FROM mar_supply_reconciliation_command_receipts')) {
          return [{
            unmatched_consumption_id: CONSUMPTION_ID,
            medication_administration_id: ADMINISTRATION_ID,
            actor_uid: IDS.actor,
            command_key: COMMAND_KEY,
            request_body_sha256: fingerprint(),
            response_data: storedResponse,
          }];
        }
        throw new Error(`Exact replay unexpectedly evaluated custody: ${sql.slice(0, 160)}`);
      }),
    };
    setTenantTxMock.mockImplementation(async (_tenantId, callback) => callback(tx));

    await expect(reconcileMarSupplyOverride(
      CONSUMPTION_ID,
      [{ inventory_allocation_id: ALLOCATION_ID, quantity: 1 }],
      {
        tenantId: IDS.tenant,
        reconciledBy: IDS.actor,
        commandKey: COMMAND_KEY,
        expectedMedicationAdministrationId: ADMINISTRATION_ID,
      },
    )).resolves.toEqual(storedResponse);
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(3);
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    expect(tx.$queryRawUnsafe.mock.calls[1][0]).not.toContain('FOR UPDATE');
  });
});

describe('migration 744 MAR reconciliation batch invariant', () => {
  test('defines one current-eligibility reason function for service and trigger paths', () => {
    const eligibilityFunction = migration.match(
      /CREATE OR REPLACE FUNCTION mar_supply_batch_unavailable_reason\([\s\S]*?\n\$fn\$;/,
    )?.[0];
    expect(eligibilityFunction).toBeDefined();
    expect(eligibilityFunction).toContain("<> 'active'");
    expect(eligibilityFunction).toContain("NOT IN ('in_stock', 'depleted')");
    expect(eligibilityFunction).toContain("= 'depleted'");
    expect(eligibilityFunction).toContain(
      "inventory_batch_expiry_date < (reference_instant AT TIME ZONE 'Asia/Kolkata')::date",
    );
    expect(eligibilityFunction).toContain(
      'reference_instant TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP',
    );
    expect(eligibilityFunction).not.toContain('inventory_batch_expiry_date < CURRENT_DATE');
    expect(eligibilityFunction).toContain("THEN 'batch_expired'");
    expect(eligibilityFunction).toContain('STABLE');
    expect(eligibilityFunction).toContain('SET search_path = pg_catalog');
  });

  test('rechecks and locks current batch and product state inside the database projection', () => {
    const projectionFunction = migration.match(
      /CREATE OR REPLACE FUNCTION mar_supply_apply_reconciliation_link\(\)[\s\S]*?\n\$fn\$;/,
    )?.[0];
    expect(projectionFunction).toBeDefined();
    expect(projectionFunction).toContain('FOR UPDATE OF batch FOR SHARE OF item');
    expect(projectionFunction).toContain('mar_supply_batch_unavailable_reason(');
    expect(projectionFunction)
      .toContain("CONSTRAINT = 'chk_mar_supply_reconciliation_batch_eligible'");
    expect(projectionFunction).toContain('allocation.received_quantity');
    expect(projectionFunction).toContain('- allocation.consumed_quantity');
    expect(projectionFunction).toContain('- allocation.returned_quantity');
  });
});
