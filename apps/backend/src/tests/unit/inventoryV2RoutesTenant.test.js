import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT = '00000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '00000000-0000-4000-8000-000000000099';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const WITNESS = '22222222-2222-4222-8222-222222222222';
const disposeInventoryBatchMock = jest.fn(async (input) => input);
const requestDisposalWitnessApprovalMock = jest.fn(async (input) => input);
const preflightDisposalWitnessApprovalMock = jest.fn(async (input) => input);
const approveDisposalWitnessApprovalMock = jest.fn(async (input) => input);
const recordMovementMock = jest.fn(async (input) => input);
const dispenseControlledMock = jest.fn(async (input) => input);
const requestWitnessApprovalMock = jest.fn(async (input) => input);
const approveWitnessApprovalMock = jest.fn(async (input) => input);
const requestMovementWitnessApprovalMock = jest.fn(async (input) => input);
const approveMovementWitnessApprovalMock = jest.fn(async (input) => input);
const authenticateWitnessMock = jest.fn(async ({ tenantId }) => ({
  uid: WITNESS,
  tenantId,
  role: 'PHARMACY_STAFF',
}));
const idempotencyScopes = [];
let actorRole = 'PHARMACY_STAFF';

jest.unstable_mockModule('../../services/pharmacy/inventoryV2Service.js', () => ({
  CONTROLLED_DISPENSE_WITNESS_ROLES: ['PHARMACY_STAFF', 'DOCTOR'],
  FACILITY_BOUND_CONTROLLED_DISPENSE_WITNESS_ROLES: [
    'PHARMACY_STAFF',
    'PHARMACY_INCHARGE',
  ],
  approveInventoryDisposalWitnessApproval: approveDisposalWitnessApprovalMock,
  approveInventoryDispenseWitnessApproval: approveWitnessApprovalMock,
  approveInventoryMovementWitnessApproval: approveMovementWitnessApprovalMock,
  createItem: jest.fn(),
  disposeInventoryBatch: disposeInventoryBatchMock,
  dispenseControlled: dispenseControlledMock,
  listBatches: jest.fn(),
  listExpiryAlerts: jest.fn(),
  listItems: jest.fn(),
  listScheduleRegister: jest.fn(),
  preflightInventoryDisposalWitnessApproval: preflightDisposalWitnessApprovalMock,
  recordMovement: recordMovementMock,
  requestInventoryDisposalWitnessApproval: requestDisposalWitnessApprovalMock,
  requestControlledDispenseWitnessApproval: requestWitnessApprovalMock,
  requestControlledMovementWitnessApproval: requestMovementWitnessApprovalMock,
  runExpiryScan: jest.fn(),
  tenantOf: () => TENANT,
}));
jest.unstable_mockModule('../../services/auth/staffAuthService.js', () => ({
  StaffAuthService: {
    authenticateControlledDispenseWitness: authenticateWitnessMock,
  },
}));
jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: (options) => {
    idempotencyScopes.push(options);
    return (_req, _res, next) => next();
  },
}));

const {
  default: inventoryRoutes,
  PHARMACY_INVENTORY_DISPOSAL_APPROVAL_HOST_ROLES,
  pharmacyInventoryDisposalWitnessApprovalRoutes,
  pharmacyInventoryMovementWitnessApprovalRoutes,
  pharmacyInventoryWitnessApprovalRoutes,
} = await import(
  '../../routes/pharmacy/inventoryV2Routes.js'
);

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { uid: ACTOR, name: 'Pharmacist', role: actorRole };
  next();
});
app.use(
  '/api/v1/pharmacy/inventory/v2/disposals/witness-approvals/:id/approve',
  pharmacyInventoryDisposalWitnessApprovalRoutes,
);
app.use(
  '/api/v1/pharmacy/inventory/v2/controlled-dispense/witness-approvals/:id/approve',
  pharmacyInventoryWitnessApprovalRoutes,
);
app.use(
  '/api/v1/pharmacy/inventory/v2/movements/witness-approvals/:id/approve',
  pharmacyInventoryMovementWitnessApprovalRoutes,
);
app.use('/api/v1/pharmacy/inventory/v2', inventoryRoutes);

beforeEach(() => {
  actorRole = 'PHARMACY_STAFF';
  disposeInventoryBatchMock.mockClear();
  requestDisposalWitnessApprovalMock.mockClear();
  preflightDisposalWitnessApprovalMock.mockReset();
  preflightDisposalWitnessApprovalMock.mockImplementation(async (input) => input);
  approveDisposalWitnessApprovalMock.mockClear();
  recordMovementMock.mockClear();
  dispenseControlledMock.mockClear();
  requestWitnessApprovalMock.mockClear();
  approveWitnessApprovalMock.mockClear();
  requestMovementWitnessApprovalMock.mockClear();
  approveMovementWitnessApprovalMock.mockClear();
  authenticateWitnessMock.mockClear();
});

describe('pharmacy inventory route tenant boundary', () => {
  test('keeps disposal operators able to host an independent password step-up', () => {
    expect(PHARMACY_INVENTORY_DISPOSAL_APPROVAL_HOST_ROLES).toEqual([
      'PHARMACY_STAFF',
      'PHARMACY_INCHARGE',
    ]);
    expect(PHARMACY_INVENTORY_DISPOSAL_APPROVAL_HOST_ROLES).not.toContain('DOCTOR');
    expect(PHARMACY_INVENTORY_DISPOSAL_APPROVAL_HOST_ROLES).not.toContain('NURSING_STAFF');
    expect(PHARMACY_INVENTORY_DISPOSAL_APPROVAL_HOST_ROLES).not.toContain('ADMIN');
    expect(PHARMACY_INVENTORY_DISPOSAL_APPROVAL_HOST_ROLES)
      .not.toContain('STORES_PURCHASE_INCHARGE');
  });

  test('canonicalizes every idempotent mutation across inventory aliases', () => {
    const byScope = (scope) => idempotencyScopes.find((options) => options.scope === scope);
    expect(byScope('pharmacy_inventory_disposal').requestPathForIdempotency)
      .toBe('/api/v1/pharmacy-orders/inventory/v2/disposals');
    expect(byScope('pharmacy_inventory_disposal_witness_request').requestPathForIdempotency)
      .toBe('/api/v1/pharmacy-orders/inventory/v2/disposals/witness-approvals');

    const approvalPath = byScope(
      'pharmacy_inventory_disposal_witness_approval',
    ).requestPathForIdempotency;
    expect(approvalPath({ params: { id: '71' } })).toBe(
      '/api/v1/pharmacy-orders/inventory/v2/disposals/witness-approvals/71/approve',
    );
    expect(approvalPath({ params: { id: '72' } }))
      .not.toBe(approvalPath({ params: { id: '71' } }));
    for (const retiredScope of [
      'pharmacy_inventory_movement',
      'pharmacy_inventory_movement_witness_request',
      'pharmacy_inventory_witness_request',
      'pharmacy_inventory_controlled_dispense',
    ]) {
      expect(byScope(retiredScope)).toBeUndefined();
    }
  });

  test('canonical disposal approval preserves intent but excludes the witness password', () => {
    const options = idempotencyScopes.find(
      (candidate) => candidate.scope === 'pharmacy_inventory_disposal_witness_approval',
    );
    const intent = {
      facility_id: 3,
      inventory_item_id: 17,
      inventory_batch_id: 29,
      quantity: 1,
      reason_code: 'damaged',
      disposition_method: 'authorized_incineration',
    };
    const project = (overrides = {}) => options.requestBodyForIdempotency({
      body: {
        employeeId: 'NURSE-002',
        password: 'first-secret',
        disposal: intent,
        ...overrides,
      },
    });

    expect(project({ password: 'changed-secret' })).toEqual(project());
    expect(project({ employeeId: 'NURSE-003' })).not.toEqual(project());
    expect(project({ disposal: { ...intent, quantity: 2 } })).not.toEqual(project());
    expect(JSON.stringify(project())).not.toContain('first-secret');
  });

  test('pins typed disposal to authenticated custody and forwards only its public intent', async () => {
    const response = await request(app)
      .post('/api/v1/pharmacy/inventory/v2/disposals')
      .set('Idempotency-Key', 'dispose-17')
      .send({
        facility_id: 3,
        inventory_item_id: 17,
        inventory_batch_id: 29,
        quantity: 1,
        reason_code: 'damaged',
        disposition_method: 'authorized_incineration',
      });

    expect(response.statusCode).toBe(200);
    const input = disposeInventoryBatchMock.mock.calls[0][0];
    expect(input).toMatchObject({
      tenantId: TENANT,
      facility_id: 3,
      inventory_item_id: 17,
      inventory_batch_id: 29,
      quantity: 1,
      reason_code: 'damaged',
      disposition_method: 'authorized_incineration',
      performed_by: ACTOR,
      actorRole: 'PHARMACY_STAFF',
      commandKey: 'dispose-17',
    });
    expect(idempotencyScopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        required: true,
        scope: 'pharmacy_inventory_disposal',
        retainOnServerError: true,
        durableDomainReceipt: true,
      }),
    ]));
  });

  test.each([
    ['movement_kind', 'receive'],
    ['performed_by', 'caller-selected'],
    ['witness_uid', 'caller-selected'],
    ['facility_authority', 'caller-selected'],
    ['tenantId', OTHER_TENANT],
  ])('rejects caller-selected disposal authority field %s', async (field, value) => {
    const response = await request(app)
      .post('/api/v1/pharmacy/inventory/v2/disposals')
      .send({ [field]: value });
    expect(response.statusCode).toBe(400);
    expect(response.body.code).toBe('INVENTORY_DISPOSAL_CALLER_AUTHORITY_REJECTED');
    expect(disposeInventoryBatchMock).not.toHaveBeenCalled();
  });

  test.each([
    'PHARMACIST',
    'STORES_PURCHASE_INCHARGE',
    'DELIVERY_STAFF',
    'ADMIN',
    'SUPER_ADMIN',
  ])('does not invent disposal authority for %s', async (role) => {
    actorRole = role;
    const response = await request(app).post('/api/v1/pharmacy/inventory/v2/disposals').send({});
    expect(response.statusCode).toBe(403);
    expect(disposeInventoryBatchMock).not.toHaveBeenCalled();
  });

  test('binds disposal witness creation and password decision to server identities', async () => {
    const disposal = {
      facility_id: 3,
      inventory_item_id: 17,
      inventory_batch_id: 29,
      quantity: 1,
      reason_code: 'damaged',
      disposition_method: 'authorized_incineration',
    };
    const requestResponse = await request(app)
      .post('/api/v1/pharmacy/inventory/v2/disposals/witness-approvals')
      .set('Idempotency-Key', 'dispose-witness-request')
      .send({
        ...disposal,
      });
    expect(requestResponse.statusCode).toBe(200);
    const requestInput = requestDisposalWitnessApprovalMock.mock.calls[0][0];
    expect(requestInput).toMatchObject({
      ...disposal,
      tenantId: TENANT,
      requested_by: ACTOR,
      actorRole: 'PHARMACY_STAFF',
    });

    const approvalResponse = await request(app)
      .post('/api/v1/pharmacy/inventory/v2/disposals/witness-approvals/71/approve')
      .set('Idempotency-Key', 'dispose-witness-approve')
      .send({
        employeeId: 'PHARM-002',
        password: 'witness-secret',
        disposal,
      });
    expect(approvalResponse.statusCode).toBe(200);
    expect(authenticateWitnessMock).toHaveBeenCalledWith({
      employeeId: 'PHARM-002',
      password: 'witness-secret',
      tenantId: TENANT,
      req: expect.objectContaining({ user: expect.objectContaining({ uid: ACTOR }) }),
    });
    expect(preflightDisposalWitnessApprovalMock).toHaveBeenCalledWith({
      tenantId: TENANT,
      approvalId: '71',
      requesterUid: ACTOR,
      disposal: expect.objectContaining(disposal),
    });
    expect(preflightDisposalWitnessApprovalMock.mock.invocationCallOrder[0])
      .toBeLessThan(authenticateWitnessMock.mock.invocationCallOrder[0]);
    expect(approveDisposalWitnessApprovalMock).toHaveBeenCalledWith({
      tenantId: TENANT,
      approvalId: '71',
      actorUid: WITNESS,
      actorRole: 'PHARMACY_STAFF',
      requesterUid: ACTOR,
      disposal: expect.objectContaining(disposal),
    });
  });

  test('an eligible pharmacy-custody witness bearer approves without a password projection', async () => {
    actorRole = 'PHARMACY_INCHARGE';
    const response = await request(app)
      .post('/api/v1/pharmacy/inventory/v2/disposals/witness-approvals/72/approve')
      .set('Idempotency-Key', 'dispose-witness-bearer')
      .send({
        disposal: {
          facility_id: 3,
          inventory_item_id: 17,
          inventory_batch_id: 29,
          quantity: 1,
          reason_code: 'damaged',
          disposition_method: 'authorized_incineration',
        },
      });
    expect(response.statusCode).toBe(200);
    expect(authenticateWitnessMock).not.toHaveBeenCalled();
    expect(approveDisposalWitnessApprovalMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      approvalId: '72',
      actorUid: ACTOR,
      actorRole: 'PHARMACY_INCHARGE',
      requesterUid: null,
    }));
  });

  test('clinical roles cannot host the facility-bound disposal witness contract', async () => {
    actorRole = 'DOCTOR';
    const response = await request(app)
      .post('/api/v1/pharmacy/inventory/v2/disposals/witness-approvals/72/approve')
      .send({ disposal: {} });
    expect(response.statusCode).toBe(403);
    expect(preflightDisposalWitnessApprovalMock).not.toHaveBeenCalled();
    expect(authenticateWitnessMock).not.toHaveBeenCalled();
    expect(approveDisposalWitnessApprovalMock).not.toHaveBeenCalled();
  });

  test('invalid disposal approval evidence is rejected before staff password auth', async () => {
    const error = Object.assign(new Error('Approval does not match'), {
      statusCode: 409,
      code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_MISMATCH',
    });
    preflightDisposalWitnessApprovalMock.mockRejectedValueOnce(error);
    const response = await request(app)
      .post('/api/v1/pharmacy/inventory/v2/disposals/witness-approvals/999/approve')
      .send({ employeeId: 'PHARM-002', password: 'wrong-secret', disposal: {} });
    expect(response.statusCode).toBe(409);
    expect(authenticateWitnessMock).not.toHaveBeenCalled();
    expect(approveDisposalWitnessApprovalMock).not.toHaveBeenCalled();
  });

  test.each([
    ['/movements', 'INVENTORY_GENERIC_MOVEMENT_RETIRED'],
    ['/movements/witness-approvals', 'INVENTORY_GENERIC_MOVEMENT_RETIRED'],
    ['/movements/witness-approvals/91/approve', 'INVENTORY_GENERIC_MOVEMENT_RETIRED'],
    ['/controlled-dispense', 'INVENTORY_STANDALONE_CONTROLLED_DISPENSE_RETIRED'],
    [
      '/controlled-dispense/witness-approvals',
      'INVENTORY_STANDALONE_CONTROLLED_DISPENSE_RETIRED',
    ],
    [
      '/controlled-dispense/witness-approvals/71/approve',
      'INVENTORY_STANDALONE_CONTROLLED_DISPENSE_RETIRED',
    ],
  ])('keeps retired mutation %s as an explicit 410 tombstone', async (suffix, code) => {
    const response = await request(app).post(`/api/v1/pharmacy/inventory/v2${suffix}`).send({});
    expect(response.statusCode).toBe(410);
    expect(response.body.code).toBe(code);
  });

  test('rejects a witness credential authenticated in another tenant', async () => {
    authenticateWitnessMock.mockResolvedValueOnce({
      uid: WITNESS,
      tenantId: OTHER_TENANT,
      role: 'PHARMACY_STAFF',
    });
    const response = await request(app)
      .post('/api/v1/pharmacy/inventory/v2/disposals/witness-approvals/73/approve')
      .send({ employeeId: 'PHARM-002', password: 'witness-secret', disposal: {} });
    expect(response.statusCode).toBe(403);
    expect(approveDisposalWitnessApprovalMock).not.toHaveBeenCalled();
  });
});
