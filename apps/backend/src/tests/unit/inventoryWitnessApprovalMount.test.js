import { authClient } from '../testClient.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const RUN_KEY = `inventory-witness-mount-${process.pid}-${Date.now()}`;
const DISPOSAL_APPROVE_PATHS = [
  '/api/v1/pharmacy/inventory/v2/disposals/witness-approvals/not-an-id/approve',
  '/api/v1/pharmacy-orders/inventory/v2/disposals/witness-approvals/not-an-id/approve',
];
const RETIRED_DISPENSE_APPROVE_PATHS = [
  '/api/v1/pharmacy/inventory/v2/controlled-dispense/witness-approvals/not-an-id/approve',
  '/api/v1/pharmacy-orders/inventory/v2/controlled-dispense/witness-approvals/not-an-id/approve',
];
const RETIRED_MOVEMENT_APPROVE_PATHS = [
  '/api/v1/pharmacy/inventory/v2/movements/witness-approvals/not-an-id/approve',
  '/api/v1/pharmacy-orders/inventory/v2/movements/witness-approvals/not-an-id/approve',
];

function client(role) {
  return authClient(role, { tenant_id: TENANT });
}

describe('typed inventory-disposal witness app mount', () => {
  it.each(DISPOSAL_APPROVE_PATHS)('denies a clinical role at facility-bound route %s', async (path) => {
    const response = await client('DOCTOR').post(path)
      .set('Idempotency-Key', `${RUN_KEY}-${path.includes('pharmacy-orders') ? 'orders' : 'alias'}`)
      .send({
        disposal: { inventory_item_id: 17, quantity: 1 },
      });
    expect(response.statusCode).toBe(403);
  });

  it.each(['PHARMACY_STAFF', 'PHARMACY_INCHARGE'])(
    'lets disposal operator %s host the approval route for password step-up',
    async (role) => {
      const response = await client(role).post(DISPOSAL_APPROVE_PATHS[0])
        .set('Idempotency-Key', `${RUN_KEY}-operator-${role.toLowerCase()}`)
        .send({ disposal: { inventory_item_id: 17, quantity: 1 } });
      expect(response.statusCode).toBe(400);
      expect(response.body.code).toBe('INVENTORY_DISPOSAL_INPUT_INVALID');
    },
  );

  it.each(RETIRED_MOVEMENT_APPROVE_PATHS)(
    'keeps the generic movement approval tombstone reachable at %s',
    async (path) => {
      const response = await client('DOCTOR').post(path).send({});
      expect(response.statusCode).toBe(410);
      expect(response.body.code).toBe('INVENTORY_GENERIC_MOVEMENT_RETIRED');
    },
  );

  it.each(RETIRED_DISPENSE_APPROVE_PATHS)(
    'keeps the standalone controlled-dispense approval tombstone reachable at %s',
    async (path) => {
      const response = await client('DOCTOR').post(path).send({});
      expect(response.statusCode).toBe(410);
      expect(response.body.code).toBe('INVENTORY_STANDALONE_CONTROLLED_DISPENSE_RETIRED');
    },
  );

  it('requires an idempotency key after a pharmacy witness reaches the approval route', async () => {
    const response = await client('PHARMACY_STAFF').post(DISPOSAL_APPROVE_PATHS[0]).send({
      disposal: { inventory_item_id: 17, quantity: 1 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body.message).toMatch(/Idempotency-Key/);
  });

  it('requires an idempotency key for final typed disposal', async () => {
    const path = '/api/v1/pharmacy/inventory/v2/disposals';
    const response = await client('PHARMACY_STAFF').post(path).send({
      facility_id: 3,
      inventory_item_id: 17,
      inventory_batch_id: 29,
      quantity: 1,
      reason_code: 'damaged',
      disposition_method: 'authorized_incineration',
    });
    expect(response.statusCode).toBe(400);
    expect(response.body.message).toMatch(/Idempotency-Key/);
  });

  it.each([
    ['/api/v1/pharmacy/inventory/v2/movements', 'INVENTORY_GENERIC_MOVEMENT_RETIRED'],
    [
      '/api/v1/pharmacy/inventory/v2/controlled-dispense',
      'INVENTORY_STANDALONE_CONTROLLED_DISPENSE_RETIRED',
    ],
  ])('publishes retired final mutation %s as 410 without idempotency preconditions', async (
    path,
    code,
  ) => {
    const response = await client('PHARMACY_STAFF').post(path).send({});
    expect(response.statusCode).toBe(410);
    expect(response.body.code).toBe(code);
  });

  it('denies an unrelated role before the approval router', async () => {
    const response = await client('RECEPTIONIST').post(DISPOSAL_APPROVE_PATHS[0]).send({
      disposal: { inventory_item_id: 17, quantity: 1 },
    });
    expect(response.statusCode).toBe(403);
  });

  it('does not grant a clinical witness access to the rest of inventory', async () => {
    const response = await client('DOCTOR').get('/api/v1/pharmacy/inventory/v2/items');
    expect(response.statusCode).toBe(403);
  });

  it('preserves pharmacy and supply access to ordinary inventory routes', async () => {
    for (const role of ['PHARMACY_STAFF', 'STORES_PURCHASE_INCHARGE']) {
      const response = await client(role).get('/api/v1/pharmacy/inventory/v2/items?limit=1');
      expect(response.statusCode).toBe(200);
    }
  });
});
