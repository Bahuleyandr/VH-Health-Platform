import { authClient } from '../testClient.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const RUN_KEY = `inventory-witness-mount-${process.pid}-${Date.now()}`;
const APPROVE_PATHS = [
  '/api/v1/pharmacy/inventory/v2/controlled-dispense/witness-approvals/not-an-id/approve',
  '/api/v1/pharmacy-orders/inventory/v2/controlled-dispense/witness-approvals/not-an-id/approve',
];

function client(role) {
  return authClient(role, { tenant_id: TENANT });
}

describe('inventory controlled-dispense witness app mount', () => {
  it.each(APPROVE_PATHS)('lets a declared clinical witness role reach %s', async (path) => {
    const response = await client('DOCTOR').post(path)
      .set('Idempotency-Key', `${RUN_KEY}-${path.includes('pharmacy-orders') ? 'orders' : 'alias'}`)
      .send({
      dispense: { inventory_item_id: 17, quantity: 1 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body.code).toBe('INVENTORY_BATCH_REQUIRED');
  });

  it('requires an idempotency key after the clinical witness reaches the approval route', async () => {
    const response = await client('DOCTOR').post(APPROVE_PATHS[0]).send({
      dispense: { inventory_item_id: 17, quantity: 1 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body.message).toMatch(/Idempotency-Key/);
  });

  it('denies an unrelated role before the approval router', async () => {
    const response = await client('RECEPTIONIST').post(APPROVE_PATHS[0]).send({
      dispense: { inventory_item_id: 17, quantity: 1 },
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
