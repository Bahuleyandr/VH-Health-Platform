import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const REQUESTER = '11111111-1111-4111-8111-111111111111';
const txQueryMock = jest.fn();
const txClient = { $queryRawUnsafe: txQueryMock };
const setTenantTxMock = jest.fn(async (_tenantId, callback) => callback(txClient));
const compositionIdentityMock = jest.fn();
const createApprovalMock = jest.fn(async (input) => ({ id: '71', ...input }));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn() },
  setTenantTx: setTenantTxMock,
  // documentIntegrityService and the sibling services in the controller's graph
  // link against these two as well. `isTenantTransactionClient` is a real
  // predicate, not a stub that always agrees: it recognises exactly the client
  // setTenantTx hands out here, so a caller passing anything else is still
  // refused the way production would refuse it.
  setTenant: async (_tenantId, callback) => callback(txClient),
  isTenantTransactionClient: (value) => value === txClient,
}));
jest.unstable_mockModule('../../services/pharmacy/compositionIdentityService.js', () => ({
  resolveCompositionIdentitiesByCatalogIds: compositionIdentityMock,
  // prescriptionSafetyCheck, reached through the controller's graph, links
  // against the enrich helper too. Pass the medications straight back: the real
  // function strips forged composition fields and overlays canonical ones, and
  // with no catalog identities resolvable here that is a no-op on its input.
  enrichMedicationsWithComposition: jest.fn(async (_tenantId, meds) => meds),
}));
jest.unstable_mockModule('../../services/pharmacy/controlledDispenseWitnessService.js', () => ({
  CONTROLLED_DISPENSE_APPROVAL_SCOPES: {
    dispenseSubstitution: 'pharmacy_dispense_substitution',
  },
  CONTROLLED_DISPENSE_WITNESS_ROLES: ['PHARMACY_STAFF', 'PHARMACY_INCHARGE'],
  // Real array, not a jest.fn(): inventoryV2Routes.js:83 SPREADS this constant
  // at module scope to build its role allowlist, so a mock function makes the
  // router unloadable. Values mirror the service's own list verbatim.
  FACILITY_BOUND_CONTROLLED_DISPENSE_WITNESS_ROLES: ['PHARMACY_STAFF', 'PHARMACY_INCHARGE'],
  approveControlledDispenseWitnessApproval: jest.fn(),
  consumeControlledDispenseWitnessApproval: jest.fn(),
  createControlledDispenseWitnessApproval: createApprovalMock,
  isControlledDispenseWitnessEvidence: jest.fn(() => false),
  assertControlledDispenseWitness: jest.fn(),
  assertApprovedControlledDispenseWitness: jest.fn(),
  preflightControlledDispenseWitnessApproval: jest.fn(),
  serializeControlledDispenseWitnessApproval: jest.fn(),
  controlledDispenseApprovalFingerprint: jest.fn(),
}));
jest.unstable_mockModule('../../../scripts/backfill-drug-compositions.mjs', () => ({
  enrichCatalogRowForWrite: jest.fn(async (row) => row),
}));

const {
  canonicalSubstitutionQuantity,
  requestSubstitutionWitnessApproval,
  resolveSubstitutionPhase0,
} = await import('../../controllers/pharmacy/pharmacyOrderController.js');

const identity = (catalogId) => ({
  catalog_id: catalogId,
  composition_id: 31,
  composition_confidence: 'high',
  strength_key: '625mg',
  form_key: 'tablet',
  release_key: null,
  route: null,
  active_ingredients: ['amoxicillin'],
  strength_components: null,
});

const linkedAuthority = {
  order_id: 41,
  order_status: 'CONFIRMED',
  facility_id: 7,
  items_list: [{
    order_line_index: 0,
    prescription_line_index: 0,
    catalog_id: 10,
  }],
  prescription_id: 51,
  prescription_status: 'pharmacy_linked',
  medications: [{ catalog_id: 10, quantity: '9999999999.9999' }],
  appointment_id: null,
  admission_id: null,
};

const substitution = {
  order_id: 41,
  prescription_id: 51,
  order_line_index: 0,
  prescription_line_index: 0,
  patient_uid: '22222222-2222-4222-8222-222222222222',
  inventory_item_id: 61,
  inventory_batch_id: 71,
  quantity: '9999999999.9999',
  original_catalog_id: 10,
  final_catalog_id: 11,
};

let grantRows;

function installAuthorityQueries() {
  txQueryMock.mockImplementation(async (sql, ...params) => {
    if (sql.includes('FROM pharmacy_orders po')) return [linkedAuthority];
    if (sql.includes('FROM pharmacy_inventory_items')) {
      return [{ id: 61, catalog_id: 11, facility_id: 7, schedule_class: 'X', is_narcotic: true }];
    }
    if (sql.includes('FROM users actor')) {
      return [{
        id: 81,
        uid: REQUESTER,
        role: 'PHARMACY_STAFF',
        user_name: 'Requester',
        staff_name: 'Requester',
        staff_id: 91,
      }];
    }
    if (sql.includes('FROM pharmacy_staff_facility_grants')) return grantRows;
    if (sql.includes('FROM pharmacy_inventory_batches')) {
      return [{ id: 71, remaining_quantity: '9999999999.9999', status: 'in_stock', is_expired: false }];
    }
    throw new Error(`Unexpected authority query: ${sql}`);
  });
}

beforeEach(() => {
  grantRows = [{ id: '101', granted_at: new Date() }];
  txQueryMock.mockReset();
  setTenantTxMock.mockClear();
  compositionIdentityMock.mockReset();
  compositionIdentityMock.mockResolvedValue(new Map([
    [10, identity(10)],
    [11, identity(11)],
  ]));
  createApprovalMock.mockClear();
  installAuthorityQueries();
});

describe('substitution phase-0 authority boundaries', () => {
  test('accepts the NUMERIC(14,4) ceiling and rejects a high-magnitude fifth decimal', () => {
    expect(canonicalSubstitutionQuantity('9999999999.9999')).toBe(9999999999.9999);
    try {
      canonicalSubstitutionQuantity('9999999999.99999');
      throw new Error('Expected high-magnitude fifth-decimal rejection');
    } catch (error) {
      expect(error).toMatchObject({ code: 'PHARMACY_DISPENSE_QUANTITY_INVALID' });
    }
  });

  test('composition revalidation uses the supplied transaction client', async () => {
    const result = await resolveSubstitutionPhase0(TENANT, substitution, txClient);

    expect(result.qty).toBe(9999999999.9999);
    expect(compositionIdentityMock).toHaveBeenCalledWith(
      TENANT,
      [10, 11],
      { db: txClient },
    );
  });
});

describe('substitution witness-request facility authority', () => {
  test('derives the grant facility from the locked order and ignores a caller facility', async () => {
    const approval = await requestSubstitutionWitnessApproval({
      tenantId: TENANT,
      requested_by: REQUESTER,
      requested_role: 'PHARMACY_STAFF',
      ...substitution,
      facility_id: 999,
    });

    expect(approval.id).toBe('71');
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
    const grantQuery = txQueryMock.mock.calls.find(([sql]) => (
      sql.includes('FROM pharmacy_staff_facility_grants')
    ));
    expect(grantQuery.slice(1)).toEqual([TENANT, REQUESTER, 7]);
    expect(createApprovalMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      requestedBy: REQUESTER,
      payload: expect.objectContaining({ quantity: 9999999999.9999 }),
    }));
  });

  test.each(['missing', 'revoked'])(
    'fails closed when the requester facility grant is %s',
    async () => {
      grantRows = [];

      await expect(requestSubstitutionWitnessApproval({
        tenantId: TENANT,
        requested_by: REQUESTER,
        requested_role: 'PHARMACY_STAFF',
        ...substitution,
      })).rejects.toMatchObject({ code: 'PHARMACY_FACILITY_GRANT_REQUIRED' });

      const grantQuery = txQueryMock.mock.calls.find(([sql]) => (
        sql.includes('FROM pharmacy_staff_facility_grants')
      ));
      expect(grantQuery[0]).toContain("status='active' AND revoked_at IS NULL");
      expect(createApprovalMock).not.toHaveBeenCalled();
    },
  );
});
