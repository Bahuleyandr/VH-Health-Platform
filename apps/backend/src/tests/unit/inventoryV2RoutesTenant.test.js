import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT = '00000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '00000000-0000-4000-8000-000000000099';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const WITNESS = '22222222-2222-4222-8222-222222222222';
const recordMovementMock = jest.fn(async (input) => input);
const dispenseControlledMock = jest.fn(async (input) => input);
const requestWitnessApprovalMock = jest.fn(async (input) => input);
const approveWitnessApprovalMock = jest.fn(async (input) => input);
const requestMovementWitnessApprovalMock = jest.fn(async (input) => input);
const approveMovementWitnessApprovalMock = jest.fn(async (input) => input);
const authenticateWitnessMock = jest.fn(async ({ tenantId }) => ({
  uid: WITNESS,
  tenantId,
}));
const idempotencyScopes = [];
let actorRole = 'PHARMACY_STAFF';

jest.unstable_mockModule('../../services/pharmacy/inventoryV2Service.js', () => ({
  CONTROLLED_DISPENSE_WITNESS_ROLES: ['PHARMACY_STAFF', 'DOCTOR'],
  approveInventoryDispenseWitnessApproval: approveWitnessApprovalMock,
  approveInventoryMovementWitnessApproval: approveMovementWitnessApprovalMock,
  createItem: jest.fn(),
  dispenseControlled: dispenseControlledMock,
  listBatches: jest.fn(),
  listExpiryAlerts: jest.fn(),
  listItems: jest.fn(),
  listScheduleRegister: jest.fn(),
  recordMovement: recordMovementMock,
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
  recordMovementMock.mockClear();
  dispenseControlledMock.mockClear();
  requestWitnessApprovalMock.mockClear();
  approveWitnessApprovalMock.mockClear();
  requestMovementWitnessApprovalMock.mockClear();
  approveMovementWitnessApprovalMock.mockClear();
  authenticateWitnessMock.mockClear();
});

describe('pharmacy inventory route tenant boundary', () => {
  test('canonicalizes every idempotent mutation across inventory aliases', () => {
    const byScope = (scope) => idempotencyScopes.find((options) => options.scope === scope);
    expect(byScope('pharmacy_inventory_movement').requestPathForIdempotency)
      .toBe('/api/v1/pharmacy-orders/inventory/v2/movements');
    expect(byScope('pharmacy_inventory_movement_witness_request').requestPathForIdempotency)
      .toBe('/api/v1/pharmacy-orders/inventory/v2/movements/witness-approvals');
    expect(byScope('pharmacy_inventory_witness_request').requestPathForIdempotency)
      .toBe('/api/v1/pharmacy-orders/inventory/v2/controlled-dispense/witness-approvals');
    expect(byScope('pharmacy_inventory_controlled_dispense').requestPathForIdempotency)
      .toBe('/api/v1/pharmacy-orders/inventory/v2/controlled-dispense');

    const controlledApprovalPath = byScope(
      'pharmacy_inventory_witness_approval',
    ).requestPathForIdempotency;
    const movementApprovalPath = byScope(
      'pharmacy_inventory_movement_witness_approval',
    ).requestPathForIdempotency;
    expect(controlledApprovalPath({ params: { id: '71' } })).toBe(
      '/api/v1/pharmacy-orders/inventory/v2/controlled-dispense/witness-approvals/71/approve',
    );
    expect(movementApprovalPath({ params: { id: '91' } })).toBe(
      '/api/v1/pharmacy-orders/inventory/v2/movements/witness-approvals/91/approve',
    );
    expect(movementApprovalPath({ params: { id: '92' } }))
      .not.toBe(movementApprovalPath({ params: { id: '91' } }));
  });

  test.each([
    ['pharmacy_inventory_witness_approval', 'dispense'],
    ['pharmacy_inventory_movement_witness_approval', 'movement'],
  ])('canonical approval path preserves the non-secret %s body projection', (scope, intentKey) => {
    const options = idempotencyScopes.find((candidate) => candidate.scope === scope);
    const intent = { inventory_item_id: 17, inventory_batch_id: 29, quantity: 1 };
    const project = (overrides = {}) => options.requestBodyForIdempotency({
      body: {
        employeeId: 'NURSE-002',
        password: 'first-secret',
        [intentKey]: intent,
        ...overrides,
      },
    });

    expect(project({ password: 'changed-secret' })).toEqual(project());
    expect(project({ employeeId: 'NURSE-003' })).not.toEqual(project());
    expect(project({ [intentKey]: { ...intent, quantity: 2 } })).not.toEqual(project());
    expect(JSON.stringify(project())).not.toContain('first-secret');
  });

  test('pins stock movements to the authenticated tenant', async () => {
    const response = await request(app)
      .post('/api/v1/pharmacy/inventory/v2/movements')
      .send({
        tenantId: OTHER_TENANT,
        inventory_item_id: 17,
        movement_kind: 'issue',
        quantity: 1,
      });

    expect(response.statusCode).toBe(200);
    expect(recordMovementMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      performed_by: ACTOR,
      performed_by_name: 'Pharmacist',
    }));
    expect(idempotencyScopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        required: true,
        scope: 'pharmacy_inventory_movement',
        retainOnServerError: true,
      }),
    ]));
  });

  test('pins controlled dispensing to the authenticated tenant', async () => {
    const response = await request(app)
      .post('/api/v1/pharmacy/inventory/v2/controlled-dispense')
      .send({
        tenantId: OTHER_TENANT,
      inventory_item_id: 17,
      quantity: 1,
      performed_by_name: 'Caller Supplied',
      });

    expect(response.statusCode).toBe(200);
    expect(dispenseControlledMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      performed_by: ACTOR,
      performed_by_name: 'Pharmacist',
    }));
    expect(idempotencyScopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        required: true,
        scope: 'pharmacy_inventory_controlled_dispense',
        retainOnServerError: true,
      }),
    ]));
  });

  test('canonical PHARMACIST can execute the inventory-backed dispense leg', async () => {
    actorRole = 'PHARMACIST';
    const response = await request(app)
      .post('/api/v1/pharmacy/inventory/v2/controlled-dispense')
      .send({ inventory_item_id: 17, inventory_batch_id: 29, quantity: 1 });

    expect(response.statusCode).toBe(200);
    expect(dispenseControlledMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      performed_by: ACTOR,
    }));
  });

  test('binds generic movement witness creation and decision to authenticated identities', async () => {
    expect(idempotencyScopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        required: true,
        scope: 'pharmacy_inventory_movement_witness_request',
        retainOnServerError: true,
      }),
      expect.objectContaining({
        required: true,
        scope: 'pharmacy_inventory_movement_witness_approval',
        retainOnServerError: true,
      }),
    ]));
    const approvalIdempotency = idempotencyScopes.find(
      ({ scope }) => scope === 'pharmacy_inventory_movement_witness_approval',
    );
    const projectedApproval = approvalIdempotency.requestBodyForIdempotency({
      body: {
        employeeId: ' nurse-002 ',
        password: 'witness-secret',
        movement: { inventory_item_id: 17, movement_kind: 'dispose', quantity: 1 },
      },
    });
    expect(projectedApproval).toEqual({
      credentialMode: 'staff_password',
      employeeId: 'NURSE-002',
      movement: { inventory_item_id: 17, movement_kind: 'dispose', quantity: 1 },
    });
    expect(JSON.stringify(projectedApproval)).not.toContain('witness-secret');

    const requestResponse = await request(app)
      .post('/api/v1/pharmacy/inventory/v2/movements/witness-approvals')
      .send({
        tenantId: OTHER_TENANT,
        requested_by: 'caller-selected',
        inventory_item_id: 17,
        inventory_batch_id: 29,
        movement_kind: 'dispose',
        quantity: 1,
      });
    expect(requestResponse.statusCode).toBe(200);
    expect(requestMovementWitnessApprovalMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      requested_by: ACTOR,
    }));

    const approvalResponse = await request(app)
      .post('/api/v1/pharmacy/inventory/v2/movements/witness-approvals/91/approve')
      .send({
        employeeId: 'NURSE-002',
        password: 'witness-secret',
        movement: {
          inventory_item_id: 17,
          inventory_batch_id: 29,
          movement_kind: 'dispose',
          quantity: 1,
        },
      });
    expect(approvalResponse.statusCode).toBe(200);
    expect(approveMovementWitnessApprovalMock).toHaveBeenCalledWith({
      tenantId: TENANT,
      approvalId: '91',
      actorUid: WITNESS,
      requesterUid: ACTOR,
      movement: {
        inventory_item_id: 17,
        inventory_batch_id: 29,
        movement_kind: 'dispose',
        quantity: 1,
      },
    });
  });

  test('binds witness approval creation and decision to authenticated identities', async () => {
    expect(idempotencyScopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        required: true,
        scope: 'pharmacy_inventory_witness_request',
        retainOnServerError: true,
      }),
      expect.objectContaining({
        required: true,
        scope: 'pharmacy_inventory_witness_approval',
        retainOnServerError: true,
      }),
    ]));
    const approvalIdempotency = idempotencyScopes.find(
      ({ scope }) => scope === 'pharmacy_inventory_witness_approval',
    );
    const projectedApproval = approvalIdempotency.requestBodyForIdempotency({
      body: {
        actorUid: 'caller-selected',
        employeeId: ' nurse-002 ',
        password: 'witness-secret',
        dispense: { inventory_item_id: 17, quantity: 1 },
      },
    });
    expect(projectedApproval).toEqual({
      credentialMode: 'staff_password',
      employeeId: 'NURSE-002',
      dispense: { inventory_item_id: 17, quantity: 1 },
    });
    expect(JSON.stringify(projectedApproval)).not.toContain('witness-secret');
    const requestResponse = await request(app)
      .post('/api/v1/pharmacy/inventory/v2/controlled-dispense/witness-approvals')
      .send({ tenantId: OTHER_TENANT, requested_by: 'caller-selected', inventory_item_id: 17 });
    expect(requestResponse.statusCode).toBe(200);
    expect(requestWitnessApprovalMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      requested_by: ACTOR,
    }));

    const approvalResponse = await request(app)
      .post('/api/v1/pharmacy/inventory/v2/controlled-dispense/witness-approvals/71/approve')
      .send({
        actorUid: 'caller-selected',
        employeeId: 'NURSE-002',
        password: 'witness-secret',
        tenantId: OTHER_TENANT,
        dispense: { inventory_item_id: 17, quantity: 1 },
      });
    expect(approvalResponse.statusCode).toBe(200);
    expect(authenticateWitnessMock).toHaveBeenCalledWith({
      employeeId: 'NURSE-002',
      password: 'witness-secret',
      tenantId: TENANT,
      req: expect.objectContaining({ user: expect.objectContaining({ uid: ACTOR }) }),
    });
    expect(approveWitnessApprovalMock).toHaveBeenCalledWith({
      tenantId: TENANT,
      approvalId: '71',
      actorUid: WITNESS,
      requesterUid: ACTOR,
      dispense: { inventory_item_id: 17, quantity: 1 },
    });
  });

  test('an eligible witness bearer may approve without a seller-hosted credential challenge', async () => {
    actorRole = 'DOCTOR';
    const response = await request(app)
      .post('/api/v1/pharmacy/inventory/v2/controlled-dispense/witness-approvals/72/approve')
      .send({ dispense: { inventory_item_id: 17, quantity: 1 } });
    expect(response.statusCode).toBe(200);
    expect(authenticateWitnessMock).not.toHaveBeenCalled();
    expect(approveWitnessApprovalMock).toHaveBeenCalledWith({
      tenantId: TENANT,
      approvalId: '72',
      actorUid: ACTOR,
      requesterUid: null,
      dispense: { inventory_item_id: 17, quantity: 1 },
    });
  });

  test('a credential result from another tenant fails before approval', async () => {
    authenticateWitnessMock.mockResolvedValueOnce({
      uid: WITNESS,
      tenantId: OTHER_TENANT,
    });
    const response = await request(app)
      .post('/api/v1/pharmacy/inventory/v2/controlled-dispense/witness-approvals/73/approve')
      .send({
        employeeId: 'NURSE-002',
        password: 'witness-secret',
        dispense: { inventory_item_id: 17, quantity: 1 },
      });
    expect(response.statusCode).toBe(403);
    expect(approveWitnessApprovalMock).not.toHaveBeenCalled();
  });
});
