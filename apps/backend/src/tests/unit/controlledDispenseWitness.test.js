import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const createApprovalMock = jest.fn();
const recordApprovalDecisionMock = jest.fn();
const txMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
};
const setTenantTxMock = jest.fn(async (_tenantId, callback) => callback(txMock));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: txMock,
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  createApproval: createApprovalMock,
  recordApprovalDecision: recordApprovalDecisionMock,
}));

const witnessService = await import(
  '../../services/pharmacy/controlledDispenseWitnessService.js'
);
const { dispenseControlled, controlledDispenseWitnessPayload } = await import(
  '../../services/pharmacy/inventoryV2Service.js'
);

const {
  CONTROLLED_DISPENSE_APPROVAL_SCOPES,
  CONTROLLED_DISPENSE_WITNESS_ROLES,
  approveControlledDispenseWitnessApproval,
  assertControlledDispenseWitness,
  consumeControlledDispenseWitnessApproval,
  controlledDispenseApprovalFingerprint,
  createControlledDispenseWitnessApproval,
} = witnessService;

const TENANT = '00000000-0000-4000-8000-000000000001';
const DISPENSER = '11111111-1111-4111-8111-111111111111';
const WITNESS = '22222222-2222-4222-8222-222222222222';
const PAYLOAD = {
  inventory_item_id: 5,
  inventory_batch_id: 9,
  batch_safety_contract: 'usable_in_stock_nonexpired_sufficient_stock_v1',
  quantity: 1,
  patient_uid: null,
  patient_name: null,
  patient_phone: null,
  prescription_id: null,
  prescription_number: null,
  prescriber_uid: null,
  prescriber_name: null,
  prescriber_registration: null,
  patient_id_proof_type: null,
  patient_id_proof_last4: null,
};

function approvalRow(overrides = {}) {
  const payloadHash = controlledDispenseApprovalFingerprint({
    scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventory,
    payload: PAYLOAD,
    requestedBy: DISPENSER,
  });
  return {
    id: 71,
    approval_kind: 'controlled_dispense_witness',
    subject_resource_type: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventory,
    subject_resource_id: payloadHash,
    status: 'approved',
    approved_by: [{ uid: WITNESS, at: new Date().toISOString() }],
    expires_at: new Date(Date.now() + 60_000),
    decided_by: WITNESS,
    created_by: DISPENSER,
    decided_at: new Date(),
    metadata: {
      contract: 'controlled_dispense_witness_v1',
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventory,
      payload_hash: payloadHash,
      requested_by: DISPENSER,
    },
    ...overrides,
  };
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  executeRawUnsafeMock.mockReset();
  createApprovalMock.mockReset();
  recordApprovalDecisionMock.mockReset();
  setTenantTxMock.mockClear();
});

describe('controlled-dispense witness roster', () => {
  test('rejects malformed and self-selected witness identities before querying', async () => {
    await expect(assertControlledDispenseWitness(txMock, {
      tenantId: TENANT, witnessUid: 'garbage', performedBy: DISPENSER,
    })).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_INVALID' });
    await expect(assertControlledDispenseWitness(txMock, {
      tenantId: TENANT, witnessUid: DISPENSER, performedBy: DISPENSER,
    })).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_SELF' });
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  test.each(['RECEPTIONIST', 'ADMIN'])('rejects nonclinical role %s', async (role) => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ uid: WITNESS, name: 'User', role }]);
    await expect(assertControlledDispenseWitness(txMock, {
      tenantId: TENANT, witnessUid: WITNESS, performedBy: DISPENSER,
    })).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_ROLE_INELIGIBLE' });
  });

  test('requires a live same-tenant staff row and returns its canonical name', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);
    await expect(assertControlledDispenseWitness(txMock, {
      tenantId: TENANT, witnessUid: WITNESS, performedBy: DISPENSER,
    })).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_NOT_FOUND' });
    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain('JOIN staff');
    expect(sql).toContain('s.is_active = true');
    expect(sql).toContain('COALESCE(s.archived, false) = false');
    expect(sql).toContain('FOR KEY SHARE');
    expect(params).toEqual([TENANT, WITNESS]);

    queryRawUnsafeMock.mockResolvedValueOnce([{
      uid: WITNESS, name: 'Canonical Roster Name', role: 'PHARMACY_STAFF',
    }]);
    await expect(assertControlledDispenseWitness(txMock, {
      tenantId: TENANT, witnessUid: WITNESS, performedBy: DISPENSER,
    })).resolves.toEqual({
      uid: WITNESS, name: 'Canonical Roster Name', role: 'PHARMACY_STAFF',
    });
  });

  test('the eligible roster excludes administrative and nonclinical roles', () => {
    expect(CONTROLLED_DISPENSE_WITNESS_ROLES).toEqual(expect.arrayContaining([
      'PHARMACY_STAFF', 'PHARMACY_INCHARGE', 'DOCTOR', 'NURSING_STAFF',
    ]));
    expect(CONTROLLED_DISPENSE_WITNESS_ROLES).not.toContain('ADMIN');
    expect(CONTROLLED_DISPENSE_WITNESS_ROLES).not.toContain('RECEPTIONIST');
    expect(CONTROLLED_DISPENSE_WITNESS_ROLES).not.toContain('PATIENT');
  });
});

describe('independent witness approval', () => {
  test('creates a short-lived approval bound to the seller and exact payload hash', async () => {
    createApprovalMock.mockResolvedValueOnce({ id: 71n, status: 'pending' });
    const created = await createControlledDispenseWitnessApproval({
      tenantId: TENANT,
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventory,
      payload: PAYLOAD,
      requestedBy: DISPENSER,
    });
    expect(created.id).toBe('71');
    expect(createApprovalMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      approvalKind: 'controlled_dispense_witness',
      createdBy: DISPENSER,
      requiredApprovers: 1,
      metadata: expect.objectContaining({ requested_by: DISPENSER }),
      tx: txMock,
    }));
    const call = createApprovalMock.mock.calls[0][0];
    expect(call.subjectResourceId).toBe(call.metadata.payload_hash);
    expect(call.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('only the authenticated second actor can approve the exact payload', async () => {
    const pending = approvalRow({ status: 'pending', approved_by: [], decided_by: null });
    queryRawUnsafeMock
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([{
        uid: WITNESS, name: 'Canonical Witness', role: 'PHARMACY_STAFF',
      }]);
    recordApprovalDecisionMock.mockResolvedValueOnce({ ...pending, id: 71n, status: 'approved' });
    const approved = await approveControlledDispenseWitnessApproval({
      tenantId: TENANT,
      approvalId: 71,
      actorUid: WITNESS,
      payload: PAYLOAD,
    });
    expect(approved.id).toBe('71');
    expect(recordApprovalDecisionMock).toHaveBeenCalledWith(expect.objectContaining({
      actorUid: WITNESS,
      actorRoles: ['PHARMACY_STAFF'],
      decision: 'approve',
      tx: txMock,
    }));
  });

  test('credential-hosted approval stays bound to the seller who requested it', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([
      approvalRow({ status: 'pending', approved_by: [], decided_by: null }),
    ]);
    await expect(approveControlledDispenseWitnessApproval({
      tenantId: TENANT,
      approvalId: 71,
      actorUid: WITNESS,
      requesterUid: '33333333-3333-4333-8333-333333333333',
      payload: PAYLOAD,
    })).rejects.toMatchObject({
      code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_REQUESTER_MISMATCH',
    });
    expect(recordApprovalDecisionMock).not.toHaveBeenCalled();
  });

  test('rejects approval or consumption when the exact dispense payload changes', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([approvalRow({ status: 'pending' })]);
    await expect(approveControlledDispenseWitnessApproval({
      tenantId: TENANT,
      approvalId: 71,
      actorUid: WITNESS,
      payload: { ...PAYLOAD, quantity: 2 },
    })).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_MISMATCH' });
    expect(recordApprovalDecisionMock).not.toHaveBeenCalled();

    queryRawUnsafeMock.mockResolvedValueOnce([approvalRow()]);
    await expect(consumeControlledDispenseWitnessApproval({
      tx: txMock,
      tenantId: TENANT,
      approvalId: 71,
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventory,
      payload: { ...PAYLOAD, quantity: 2 },
      requestedBy: DISPENSER,
    })).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_MISMATCH' });
  });

  test('consumption uses the authenticated witness roster name, not caller text', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([approvalRow()])
      .mockResolvedValueOnce([{
        uid: WITNESS, name: 'Canonical Witness', role: 'PHARMACY_STAFF',
      }])
      .mockResolvedValueOnce([]);
    const evidence = await consumeControlledDispenseWitnessApproval({
      tx: txMock,
      tenantId: TENANT,
      approvalId: 71,
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventory,
      payload: PAYLOAD,
      requestedBy: DISPENSER,
    });
    expect(evidence).toMatchObject({ uid: WITNESS, name: 'Canonical Witness' });
    expect(queryRawUnsafeMock.mock.calls[2][0]).toContain("'consumed_at'");
  });
});

describe('dispenseControlledTx wiring', () => {
  test('requires a concrete batch before reading inventory or moving stock', async () => {
    await expect(dispenseControlled({
      tenantId: TENANT,
      inventory_item_id: 5,
      quantity: 1,
      performed_by: DISPENSER,
      performed_by_name: 'Pharmacist',
    })).rejects.toMatchObject({ code: 'INVENTORY_BATCH_REQUIRED' });
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  test('caller flags cannot bypass locked batch status validation', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 5, schedule_class: 'H1', is_narcotic: false, unit_label: 'tab',
      }])
      .mockResolvedValueOnce([{
        id: 9,
        inventory_item_id: 5,
        remaining_quantity: '10',
        status: 'quarantined',
        is_expired: false,
      }]);

    await expect(dispenseControlled({
      tenantId: TENANT,
      inventory_item_id: 5,
      inventory_batch_id: 9,
      quantity: 1,
      performed_by: DISPENSER,
      performed_by_name: 'Pharmacist',
      require_usable_batch: false,
    })).rejects.toMatchObject({ code: 'INVENTORY_BATCH_UNAVAILABLE' });
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  test('an unapproved Schedule X dispense rejects before any stock movement', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 5, schedule_class: 'X', is_narcotic: true, unit_label: 'tab' }])
      .mockResolvedValueOnce([]);

    await expect(dispenseControlled({
      tenantId: TENANT,
      inventory_item_id: 5,
      inventory_batch_id: 9,
      quantity: 1,
      performed_by: DISPENSER,
      performed_by_name: 'Pharmacist',
      witness_approval_id: 71,
    })).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_NOT_FOUND' });
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
  });

  test('caller-selected witness fields cannot substitute for second-party approval', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 5, schedule_class: 'X', is_narcotic: true, unit_label: 'tab' }]);
    await expect(dispenseControlled({
      tenantId: TENANT,
      inventory_item_id: 5,
      inventory_batch_id: 9,
      quantity: 1,
      performed_by: DISPENSER,
      performed_by_name: 'Pharmacist',
      witness_uid: WITNESS,
      witness_name: 'Caller Chosen',
    })).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_INVALID' });
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  test('the direct-dispense fingerprint is normalized before approval', () => {
    expect(controlledDispenseWitnessPayload({
      inventory_item_id: '5', inventory_batch_id: '9', quantity: '1',
    })).toEqual(PAYLOAD);
  });
});
