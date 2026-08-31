import { authClient } from '../testClient.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const RUN_KEY = `counter-witness-mount-${process.pid}-${Date.now()}`;
const APPROVE_PATHS = [
  '/api/v1/pharmacy/counter-sales/witness-approvals/not-an-id/approve',
  '/api/v1/pharmacy-orders/counter-sales/witness-approvals/not-an-id/approve',
];

function client(role) {
  return authClient(role, { tenant_id: TENANT });
}

describe('counter-sale witness app mount', () => {
  it.each(APPROVE_PATHS)('lets MEDICAL_SUPERINTENDENT reach %s', async (path) => {
    const response = await client('MEDICAL_SUPERINTENDENT').post(path)
      .set('Idempotency-Key', `${RUN_KEY}-${path.includes('pharmacy-orders') ? 'orders' : 'alias'}`)
      .send({ sale: { lines: [] } });
    expect(response.statusCode).toBe(400);
    expect(response.body.message).toMatch(/At least one sale line is required/);
  });

  it('denies an unrelated role before the approval router', async () => {
    const response = await client('RECEPTIONIST').post(APPROVE_PATHS[0])
      .set('Idempotency-Key', `${RUN_KEY}-unrelated`)
      .send({ sale: { lines: [] } });
    expect(response.statusCode).toBe(403);
  });

  it('does not grant MEDICAL_SUPERINTENDENT access to ordinary counter sales', async () => {
    const response = await client('MEDICAL_SUPERINTENDENT')
      .get('/api/v1/pharmacy/counter-sales/items');
    expect(response.statusCode).toBe(403);
  });

  // The pick list is now facility-scoped: the role gate still admits pharmacy,
  // and the request then fails on the missing custody scope rather than on the
  // mount. A 403 here would mean the role gate had regressed; the exact 400
  // below is what proves it did not.
  it('preserves pharmacy access to ordinary counter-sale routes', async () => {
    const response = await client('PHARMACY_STAFF')
      .get('/api/v1/pharmacy/counter-sales/items?limit=1');
    expect(response.statusCode).toBe(400);
    expect(response.body.code).toBe('COUNTER_SALE_FACILITY_REQUIRED');
  });
});
