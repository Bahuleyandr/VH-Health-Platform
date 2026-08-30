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
const {
  approveInventoryDispenseWitnessApproval,
  controlledDispenseWitnessPayload,
  dispenseControlled,
  dispenseControlledTx,
  requestControlledDispenseWitnessApproval,
} = await import('../../services/pharmacy/inventoryV2Service.js');

const {
  CONTROLLED_DISPENSE_APPROVAL_SCOPES,
  CONTROLLED_DISPENSE_WITNESS_ROLES,
  FACILITY_BOUND_CONTROLLED_DISPENSE_WITNESS_ROLES,
  approveControlledDispenseWitnessApproval,
  assertControlledDispenseWitness,
  consumeControlledDispenseWitnessApproval,
  controlledDispenseApprovalFingerprint,
  createControlledDispenseWitnessApproval,
  preflightControlledDispenseWitnessApproval,
} = witnessService;

const TENANT = '00000000-0000-4000-8000-000000000001';
const DISPENSER = '11111111-1111-4111-8111-111111111111';
const WITNESS = '22222222-2222-4222-8222-222222222222';
const PATIENT = '33333333-3333-4333-8333-333333333333';
const PRESCRIBER = '44444444-4444-4444-8444-444444444444';
const FACILITY_A = 11;
const FACILITY_B = 12;
const MAX_INT8_ID = '9223372036854775807';
const PUBLIC_PENDING_APPROVAL_KEYS = [
  'contract',
  'expires_at',
  'id',
  'payload',
  'payload_fingerprint',
  'requested_by',
  'scope',
  'status',
].sort();
const PUBLIC_APPROVED_APPROVAL_KEYS = [
  ...PUBLIC_PENDING_APPROVAL_KEYS,
  'witness',
].sort();
const PAYLOAD = {
  inventory_item_id: 5,
  inventory_batch_id: 9,
  batch_safety_contract: 'usable_in_stock_nonexpired_sufficient_stock_v1',
  quantity: 1,
  patient_uid: null,
  patient_name: null,
  patient_phone: null,
  prescription_id: null,
  prescription_line_index: null,
  prescription_catalog_id: null,
  prescription_number: null,
  prescriber_uid: null,
  prescriber_name: null,
  prescriber_registration: null,
  patient_id_proof_type: null,
  patient_id_proof_last4: null,
};

function approvalRow(overrides = {}, {
  scope = CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventory,
  payload = PAYLOAD,
} = {}) {
  const payloadHash = controlledDispenseApprovalFingerprint({
    scope,
    payload,
    requestedBy: DISPENSER,
  });
  return {
    id: 71,
    approval_kind: 'controlled_dispense_witness',
    subject_resource_type: scope,
    subject_resource_id: payloadHash,
    status: 'approved',
    approved_by: [{ uid: WITNESS, at: new Date().toISOString() }],
    expires_at: new Date(Date.now() + 60_000),
    expires_at_epoch_ms: BigInt(Date.now() + 60_000),
    decided_by: WITNESS,
    created_by: DISPENSER,
    decided_at: new Date(),
    metadata: {
      contract: 'controlled_dispense_witness_v1',
      scope,
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
  test('includes the governed order and disposal approval scopes', () => {
    expect(CONTROLLED_DISPENSE_APPROVAL_SCOPES.pharmacyOrder)
      .toBe('pharmacy_order_inventory_dispense');
    expect(CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventoryDisposal)
      .toBe('pharmacy_inventory_controlled_disposal');
  });

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

  test('facility-bound order and disposal witnesses advertise only pharmacy custody roles', () => {
    expect(FACILITY_BOUND_CONTROLLED_DISPENSE_WITNESS_ROLES).toEqual([
      'PHARMACY_STAFF',
      'PHARMACY_INCHARGE',
    ]);
    expect(FACILITY_BOUND_CONTROLLED_DISPENSE_WITNESS_ROLES).not.toContain('DOCTOR');
    expect(FACILITY_BOUND_CONTROLLED_DISPENSE_WITNESS_ROLES).not.toContain('NURSING_STAFF');
  });
});

describe('independent witness approval', () => {
  test('creates a short-lived approval bound to the seller and exact payload hash', async () => {
    createApprovalMock.mockResolvedValueOnce({
      id: 71n,
      status: 'pending',
      expires_at: new Date(Date.now() + 60_000),
      tenant_id: TENANT,
      task_id: 912,
      metadata: { internal_workflow_state: true },
    });
    const created = await createControlledDispenseWitnessApproval({
      tenantId: TENANT,
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventory,
      payload: PAYLOAD,
      requestedBy: DISPENSER,
    });
    expect(created.id).toBe('71');
    expect(Object.keys(created).sort()).toEqual(PUBLIC_PENDING_APPROVAL_KEYS);
    expect(created).toMatchObject({
      contract: 'controlled_dispense_witness_v1',
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventory,
      status: 'pending',
      requested_by: DISPENSER,
      payload: PAYLOAD,
      payload_fingerprint: controlledDispenseApprovalFingerprint({
        scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventory,
        payload: PAYLOAD,
        requestedBy: DISPENSER,
      }),
    });
    expect(created.witness).toBeUndefined();
    expect(created.metadata).toBeUndefined();
    expect(created.task_id).toBeUndefined();
    expect(created.tenant_id).toBeUndefined();
    expect(createApprovalMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      approvalKind: 'controlled_dispense_witness',
      createdBy: DISPENSER,
      requiredApprovers: 1,
      metadata: expect.objectContaining({
        requested_by: DISPENSER,
      }),
      tx: txMock,
    }));
    const call = createApprovalMock.mock.calls[0][0];
    expect(call.metadata).not.toHaveProperty('payload');
    expect(call.subjectResourceId).toBe(call.metadata.payload_hash);
    expect(call.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('only the authenticated second actor can approve the exact payload', async () => {
    const pending = approvalRow(
      { status: 'pending', approved_by: [], decided_by: null },
      { scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.counterSale },
    );
    queryRawUnsafeMock
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([{
        uid: WITNESS, name: 'Canonical Clinical Witness', role: 'DOCTOR',
      }]);
    recordApprovalDecisionMock.mockResolvedValueOnce({ ...pending, id: 71n, status: 'approved' });
    const approved = await approveControlledDispenseWitnessApproval({
      tenantId: TENANT,
      approvalId: 71,
      actorUid: WITNESS,
      payload: PAYLOAD,
    });
    expect(approved.id).toBe('71');
    expect(Object.keys(approved).sort()).toEqual(PUBLIC_APPROVED_APPROVAL_KEYS);
    expect(Object.keys(approved.witness).sort()).toEqual(['name', 'role', 'uid']);
    expect(approved.witness).toEqual({
      uid: WITNESS,
      name: 'Canonical Clinical Witness',
      role: 'DOCTOR',
    });
    expect(approved.metadata).toBeUndefined();
    expect(approved.approved_by).toBeUndefined();
    expect(recordApprovalDecisionMock).toHaveBeenCalledWith(expect.objectContaining({
      actorUid: WITNESS,
      actorRoles: ['DOCTOR'],
      decision: 'approve',
      tx: txMock,
    }));
  });

  test('atomic approval locks canonical domain authority before the approval row', async () => {
    const pending = approvalRow({ status: 'pending', approved_by: [], decided_by: null });
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      if (/FROM approvals/i.test(sql)) return [pending];
      if (/domain_authority/i.test(sql)) return [{ locked: true }];
      if (/FROM users u[\s\S]*JOIN staff s/i.test(sql)) {
        return [{ uid: WITNESS, name: 'Canonical Witness', role: 'PHARMACY_STAFF' }];
      }
      return [];
    });
    recordApprovalDecisionMock.mockResolvedValueOnce({ ...pending, id: 71n, status: 'approved' });
    const resolvePayload = jest.fn(async ({ tx }) => {
      await tx.$queryRawUnsafe('SELECT true AS domain_authority FOR UPDATE');
      return PAYLOAD;
    });

    await approveControlledDispenseWitnessApproval({
      tenantId: TENANT,
      approvalId: 71,
      actorUid: WITNESS,
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventory,
      resolvePayload,
    });

    const approvalReads = queryRawUnsafeMock.mock.calls
      .map(([sql], index) => ({ sql, index }))
      .filter(({ sql }) => /FROM approvals/i.test(sql));
    const domainLockIndex = queryRawUnsafeMock.mock.calls.findIndex(([sql]) => (
      /domain_authority/i.test(sql)
    ));
    expect(approvalReads).toHaveLength(2);
    expect(approvalReads[0].sql).not.toMatch(/FOR UPDATE/i);
    expect(domainLockIndex).toBeGreaterThan(approvalReads[0].index);
    expect(domainLockIndex).toBeLessThan(approvalReads[1].index);
    expect(approvalReads[1].sql).toMatch(/FOR UPDATE/i);
  });

  test('facility-bound approval records the exact witness pharmacy grant', async () => {
    const payload = {
      contract: 'pharmacy_inventory_disposal_v1',
      facility_id: FACILITY_A,
      inventory_item_id: 5,
      inventory_batch_id: 9,
      quantity: 1,
    };
    const pending = approvalRow({ status: 'pending', approved_by: [], decided_by: null }, {
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventoryDisposal,
      payload,
    });
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      if (/FROM approvals/i.test(sql)) return [pending];
      if (/FROM users u[\s\S]*JOIN staff s/i.test(sql)) {
        return [{ uid: WITNESS, name: 'Canonical Witness', role: 'PHARMACY_STAFF' }];
      }
      if (/FROM users actor/i.test(sql)) {
        return [{
          id: 17,
          uid: WITNESS,
          role: 'PHARMACY_STAFF',
          user_name: 'Canonical Witness',
          staff_name: 'Canonical Witness',
          staff_id: 19,
        }];
      }
      if (/FROM pharmacy_staff_facility_grants/i.test(sql)) return [{ id: MAX_INT8_ID }];
      return [];
    });
    recordApprovalDecisionMock.mockResolvedValueOnce({ ...pending, id: 71n, status: 'approved' });

    const approved = await approveControlledDispenseWitnessApproval({
      tenantId: TENANT,
      approvalId: 71,
      actorUid: WITNESS,
      payload,
    });

    expect(approved.witness).toMatchObject({
      uid: WITNESS,
      role: 'PHARMACY_STAFF',
      facility_grant_id: MAX_INT8_ID,
    });
    expect(Object.keys(approved).sort()).toEqual(PUBLIC_APPROVED_APPROVAL_KEYS);
    expect(Object.keys(approved.witness).sort()).toEqual([
      'facility_grant_id', 'name', 'role', 'uid',
    ]);
    const grantEvidenceWrite = queryRawUnsafeMock.mock.calls.find(([sql]) => (
      /witness_facility_grant_id/i.test(sql) && /UPDATE approvals/i.test(sql)
    ));
    expect(grantEvidenceWrite[0]).toContain("'approved_witness_name'");
    expect(grantEvidenceWrite[0]).toContain("'approved_witness_role'");
    expect(grantEvidenceWrite.slice(1)).toEqual([
      TENANT, 71, MAX_INT8_ID, 'Canonical Witness', 'PHARMACY_STAFF',
    ]);
  });

  test('preflight proves a pending exact approval before resolving credentials', async () => {
    const pending = approvalRow({ status: 'pending', approved_by: [], decided_by: null });
    queryRawUnsafeMock.mockResolvedValueOnce([pending]);
    const resolvePayload = jest.fn(async () => PAYLOAD);

    const preflight = await preflightControlledDispenseWitnessApproval({
      tenantId: TENANT,
      approvalId: 71,
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventory,
      requesterUid: DISPENSER,
      resolvePayload,
    });

    expect(Object.keys(preflight).sort()).toEqual(PUBLIC_PENDING_APPROVAL_KEYS);
    expect(preflight).toMatchObject({
      id: '71',
      contract: 'controlled_dispense_witness_v1',
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventory,
      status: 'pending',
      requested_by: DISPENSER,
      payload: PAYLOAD,
    });
    expect(preflight.witness).toBeUndefined();

    expect(resolvePayload).toHaveBeenCalledWith(expect.objectContaining({
      tx: txMock,
      requestedBy: DISPENSER,
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventory,
    }));
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  });

  test('preflight refuses a wrong requester before canonical intent resolution', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([
      approvalRow({ status: 'pending', approved_by: [], decided_by: null }),
    ]);
    const resolvePayload = jest.fn();

    await expect(preflightControlledDispenseWitnessApproval({
      tenantId: TENANT,
      approvalId: 71,
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventory,
      requesterUid: PATIENT,
      resolvePayload,
    })).rejects.toMatchObject({
      code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_REQUESTER_MISMATCH',
    });
    expect(resolvePayload).not.toHaveBeenCalled();
  });

  test('preflight refuses a non-pending decision before canonical intent resolution', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([approvalRow()]);
    const resolvePayload = jest.fn();

    await expect(preflightControlledDispenseWitnessApproval({
      tenantId: TENANT,
      approvalId: 71,
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventory,
      requesterUid: DISPENSER,
      resolvePayload,
    })).rejects.toMatchObject({
      code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_NOT_PENDING',
    });
    expect(resolvePayload).not.toHaveBeenCalled();
  });

  test.each([
    ['approval', 'pending', async (payload) => approveControlledDispenseWitnessApproval({
      tenantId: TENANT,
      approvalId: 71,
      actorUid: WITNESS,
      payload,
    })],
    ['consumption', 'approved', async (payload) => consumeControlledDispenseWitnessApproval({
      tx: txMock,
      tenantId: TENANT,
      approvalId: 71,
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventoryDisposal,
      payload,
      requestedBy: DISPENSER,
    })],
  ])('disposal %s rejects a witness whose only active grant is another facility', async (
    _operation,
    status,
    invoke,
  ) => {
    const payload = {
      contract: 'pharmacy_inventory_disposal_v1',
      facility_id: FACILITY_B,
      inventory_item_id: 5,
      inventory_batch_id: 9,
      quantity: 1,
    };
    const row = approvalRow({
      status,
      approved_by: status === 'approved' ? [{ uid: WITNESS }] : [],
      decided_by: status === 'approved' ? WITNESS : null,
    }, {
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventoryDisposal,
      payload,
    });
    queryRawUnsafeMock.mockImplementation(async (sql, ...params) => {
      if (/FROM approvals/i.test(sql)) return [row];
      if (/FROM users u[\s\S]*JOIN staff s/i.test(sql)) {
        return [{ uid: WITNESS, name: 'Canonical Witness', role: 'PHARMACY_STAFF' }];
      }
      if (/FROM users actor/i.test(sql)) {
        return [{
          id: 17,
          uid: WITNESS,
          role: 'PHARMACY_STAFF',
          user_name: 'Canonical Witness',
          staff_name: 'Canonical Witness',
          staff_id: 19,
        }];
      }
      if (/FROM pharmacy_staff_facility_grants/i.test(sql)) {
        return Number(params[2]) === FACILITY_A ? [{ id: '91' }] : [];
      }
      return [];
    });

    await expect(invoke(payload)).rejects.toMatchObject({
      code: 'PHARMACY_FACILITY_GRANT_REQUIRED',
      statusCode: 403,
      details: { facility_id: FACILITY_B },
    });
    const grantRead = queryRawUnsafeMock.mock.calls.find(([sql]) => (
      /FROM pharmacy_staff_facility_grants/i.test(sql)
    ));
    expect(grantRead.slice(1)).toEqual([TENANT, WITNESS, FACILITY_B]);
    expect(recordApprovalDecisionMock).not.toHaveBeenCalled();
  });

  test('facility-bound clinical witnesses fail closed without canonical pharmacy custody', async () => {
    const payload = {
      contract: 'pharmacy_inventory_disposal_v1',
      facility_id: FACILITY_A,
      inventory_item_id: 5,
      inventory_batch_id: 9,
      quantity: 1,
    };
    queryRawUnsafeMock
      .mockResolvedValueOnce([approvalRow({
        status: 'pending', approved_by: [], decided_by: null,
      }, {
        scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventoryDisposal,
        payload,
      })])
      .mockResolvedValueOnce([{
        uid: WITNESS, name: 'Canonical Doctor', role: 'DOCTOR',
      }])
      .mockResolvedValueOnce([{
        id: 17,
        uid: WITNESS,
        role: 'DOCTOR',
        user_name: 'Canonical Doctor',
        staff_name: 'Canonical Doctor',
        staff_id: 19,
      }]);

    await expect(approveControlledDispenseWitnessApproval({
      tenantId: TENANT,
      approvalId: 71,
      actorUid: WITNESS,
      payload,
    })).rejects.toMatchObject({
      code: 'CONTROLLED_DISPENSE_WITNESS_ROLE_INELIGIBLE',
      statusCode: 400,
    });
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
    expect(recordApprovalDecisionMock).not.toHaveBeenCalled();
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

  test.each([
    ['requester facility grant', { requester_facility_grant_id: '502' }],
    ['prescription signature', { prescription_signed_at: '2026-08-30T10:05:00.000Z' }],
  ])('order approval cannot be reused after %s drift', async (_label, drift) => {
    const payload = {
      contract: 'pharmacy_order_inventory_dispense_witness_v1',
      facility_id: FACILITY_A,
      requester_facility_grant_id: '501',
      requester_facility_role: 'PHARMACY_STAFF',
      order_id: 73,
      inventory_item_id: 5,
      inventory_batch_id: 9,
      quantity: 1,
      prescriber_uid: PRESCRIBER,
      prescription_signed_at: '2026-08-30T10:00:00.000Z',
      prescription_locked_at: '2026-08-30T10:00:01.000Z',
    };
    queryRawUnsafeMock.mockResolvedValueOnce([
      approvalRow({}, {
        scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.pharmacyOrder,
        payload,
      }),
    ]);

    await expect(consumeControlledDispenseWitnessApproval({
      tx: txMock,
      tenantId: TENANT,
      approvalId: 71,
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.pharmacyOrder,
      payload: { ...payload, ...drift },
      requestedBy: DISPENSER,
    })).rejects.toMatchObject({
      code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_MISMATCH',
    });
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['grant revocation and regrant', {
      grantId: '92', name: 'Canonical Witness', role: 'PHARMACY_STAFF',
    }],
    ['canonical roster rename', {
      grantId: '91', name: 'Renamed Witness', role: 'PHARMACY_STAFF',
    }],
    ['canonical pharmacy-role drift', {
      grantId: '91', name: 'Canonical Witness', role: 'PHARMACY_INCHARGE',
    }],
  ])('facility-bound consumption rejects witness %s', async (_label, currentWitness) => {
    const payload = {
      contract: 'pharmacy_order_inventory_dispense_witness_v1',
      facility_id: FACILITY_A,
      requester_facility_grant_id: '501',
      requester_facility_role: 'PHARMACY_STAFF',
      order_id: 73,
      inventory_item_id: 5,
      inventory_batch_id: 9,
      quantity: 1,
    };
    const approved = approvalRow({}, {
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.pharmacyOrder,
      payload,
    });
    approved.metadata = {
      ...approved.metadata,
      witness_facility_grant_id: '91',
      approved_witness_name: 'Canonical Witness',
      approved_witness_role: 'PHARMACY_STAFF',
    };
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      if (/FROM approvals/i.test(sql)) return [approved];
      if (/FROM users u[\s\S]*JOIN staff s/i.test(sql)) {
        return [{ uid: WITNESS, name: currentWitness.name, role: currentWitness.role }];
      }
      if (/FROM users actor/i.test(sql)) {
        return [{
          id: 17,
          uid: WITNESS,
          role: currentWitness.role,
          user_name: currentWitness.name,
          staff_name: currentWitness.name,
          staff_id: 19,
        }];
      }
      if (/FROM pharmacy_staff_facility_grants/i.test(sql)) {
        return [{ id: currentWitness.grantId }];
      }
      return [];
    });

    await expect(consumeControlledDispenseWitnessApproval({
      tx: txMock,
      tenantId: TENANT,
      approvalId: 71,
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.pharmacyOrder,
      payload,
      requestedBy: DISPENSER,
    })).rejects.toMatchObject({
      code: 'CONTROLLED_DISPENSE_WITNESS_FACILITY_GRANT_MISMATCH',
    });
    expect(queryRawUnsafeMock.mock.calls.some(([sql]) => /'consumed_at'/i.test(sql))).toBe(false);
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

  test('consumed approval evidence cannot authorize a second mutation', async () => {
    const consumed = approvalRow();
    consumed.metadata = {
      ...consumed.metadata,
      consumed_at: new Date().toISOString(),
    };
    queryRawUnsafeMock.mockResolvedValueOnce([consumed]);

    await expect(consumeControlledDispenseWitnessApproval({
      tx: txMock,
      tenantId: TENANT,
      approvalId: 71,
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventory,
      payload: PAYLOAD,
      requestedBy: DISPENSER,
    })).rejects.toMatchObject({
      code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_CONSUMED',
      statusCode: 409,
    });
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  test('typed disposal approval cannot be replayed as a dispense approval', async () => {
    const disposalPayload = {
      contract: 'pharmacy_inventory_disposal_v1',
      facility_id: 11,
      inventory_item_id: 5,
      inventory_batch_id: 9,
      catalog_id: 13,
      supplier_id: 17,
      storage_location_id: 19,
      batch_number: 'B1',
      lot_number: null,
      expiry_date: '2027-01-01',
      source_batch_status: 'expired',
      quantity: 1,
      reason_code: 'expired_stock',
      disposition_method: 'incineration',
      authority_reference: null,
      notes: null,
    };
    expect(controlledDispenseApprovalFingerprint({
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventoryDisposal,
      payload: disposalPayload,
      requestedBy: DISPENSER,
    })).not.toBe(controlledDispenseApprovalFingerprint({
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventory,
      payload: disposalPayload,
      requestedBy: DISPENSER,
    }));

    queryRawUnsafeMock.mockResolvedValueOnce([
      approvalRow({}, {
        scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventoryDisposal,
        payload: disposalPayload,
      }),
    ]);
    await expect(consumeControlledDispenseWitnessApproval({
      tx: txMock,
      tenantId: TENANT,
      approvalId: 71,
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.inventory,
      payload: disposalPayload,
      requestedBy: DISPENSER,
    })).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_MISMATCH' });
  });
});

describe('dispenseControlledTx wiring', () => {
  const authorityRow = () => ({
    prescription_id: 31,
    prescription_number: 'RX-31',
    prescription_revision: 1,
    medications: [{
      catalog_id: 77,
      ordered_quantity: 5,
      dispensed_quantity: 0,
    }],
    patient_uid: PATIENT,
    patient_name: 'Canonical Patient',
    patient_phone: '9000000000',
    prescriber_uid: PRESCRIBER,
    prescriber_name: 'Canonical Prescriber',
    prescriber_registration: 'REG-31',
  });
  const performerRow = () => ({
    uid: DISPENSER,
    role: 'PHARMACY_INCHARGE',
    name: 'Canonical Pharmacist',
  });
  const itemRow = (scheduleClass = 'H1', isNarcotic = false) => ({
    id: 5,
    catalog_id: 77,
    facility_id: 11,
    schedule_class: scheduleClass,
    is_narcotic: isNarcotic,
    unit_label: 'tab',
  });
  const composerInput = (overrides = {}) => ({
    tenantId: TENANT,
    inventory_item_id: 5,
    inventory_batch_id: 9,
    quantity: 1,
    patient_uid: PATIENT,
    prescription_id: 31,
    prescription_line_index: 0,
    performed_by: DISPENSER,
    ...overrides,
  });
  const composerWitnessPayload = () => controlledDispenseWitnessPayload({
    inventory_item_id: 5,
    inventory_batch_id: 9,
    quantity: 1,
    patient_uid: PATIENT,
    patient_name: 'Canonical Patient',
    patient_phone: '9000000000',
    prescription_id: 31,
    prescription_line_index: 0,
    prescription_catalog_id: 77,
    prescription_number: 'RX-31',
    prescriber_uid: PRESCRIBER,
    prescriber_name: 'Canonical Prescriber',
    prescriber_registration: 'REG-31',
  });

  test.each([
    ['dispenseControlled', () => dispenseControlled(composerInput())],
    ['requestControlledDispenseWitnessApproval', () => (
      requestControlledDispenseWitnessApproval({
        ...composerInput(),
        requested_by: DISPENSER,
      })
    )],
    ['approveInventoryDispenseWitnessApproval', () => (
      approveInventoryDispenseWitnessApproval({
        tenantId: TENANT,
        approvalId: 71,
        actorUid: WITNESS,
        dispense: composerInput(),
      })
    )],
  ])('%s is a no-mutation public retirement tombstone', async (_name, invoke) => {
    await expect(invoke()).rejects.toMatchObject({
      code: 'INVENTORY_STANDALONE_CONTROLLED_DISPENSE_RETIRED',
      statusCode: 410,
    });
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  test('governed transaction composer requires a concrete batch before moving stock', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([authorityRow()])
      .mockResolvedValueOnce([performerRow()]);

    await expect(dispenseControlledTx(txMock, composerInput({
      inventory_batch_id: null,
    }))).rejects.toMatchObject({ code: 'INVENTORY_BATCH_REQUIRED' });
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  test('caller flags cannot bypass locked batch status validation', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([authorityRow()])
      .mockResolvedValueOnce([performerRow()])
      .mockResolvedValueOnce([itemRow()])
      .mockResolvedValueOnce([{
        id: 17,
        uid: DISPENSER,
        role: 'PHARMACY_INCHARGE',
        user_name: 'Canonical Pharmacist',
        staff_name: 'Canonical Pharmacist',
        staff_id: 19,
      }])
      .mockResolvedValueOnce([{ id: 23, granted_at: new Date() }])
      .mockResolvedValueOnce([{
        id: 9,
        inventory_item_id: 5,
        facility_id: 11,
        remaining_quantity: '10',
        status: 'quarantined',
        is_expired: false,
      }]);

    await expect(dispenseControlledTx(txMock, composerInput({
      require_usable_batch: false,
    }))).rejects.toMatchObject({ code: 'INVENTORY_BATCH_UNAVAILABLE' });
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  test('an unapproved Schedule X dispense rejects before any stock movement', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([authorityRow()])
      .mockResolvedValueOnce([performerRow()])
      .mockResolvedValueOnce([itemRow('X', true)])
      .mockResolvedValueOnce([]);

    await expect(dispenseControlledTx(txMock, composerInput({
      witness_approval_id: 71,
    }))).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_NOT_FOUND' });
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(4);
  });

  test('caller-selected witness fields cannot substitute for second-party approval', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([authorityRow()])
      .mockResolvedValueOnce([performerRow()])
      .mockResolvedValueOnce([itemRow('X', true)]);
    await expect(dispenseControlledTx(txMock, composerInput({
      witness_uid: WITNESS,
      witness_name: 'Caller Chosen',
    }))).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_INVALID' });
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(3);
  });

  test('the direct-dispense fingerprint is normalized before approval', () => {
    expect(controlledDispenseWitnessPayload({
      inventory_item_id: '5', inventory_batch_id: '9', quantity: '1',
    })).toEqual(PAYLOAD);
  });

  test('an expired witness approval rejects before any stock movement', async () => {
    // assertApprovalContract reads expires_at_epoch_ms (PR #881). This is the
    // only test that drives that gate with a past instant; the happy-path
    // fixture above keeps it 60s in the future.
    const expiredAt = Date.now() - 60_000;
    queryRawUnsafeMock
      .mockResolvedValueOnce([authorityRow()])
      .mockResolvedValueOnce([performerRow()])
      .mockResolvedValueOnce([itemRow('X', true)])
      .mockResolvedValueOnce([approvalRow({
        expires_at: new Date(expiredAt),
        expires_at_epoch_ms: BigInt(expiredAt),
      }, { payload: composerWitnessPayload() })]);

    await expect(dispenseControlledTx(txMock, composerInput({
      witness_approval_id: 71,
    }))).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_EXPIRED' });
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(4);
  });
});
