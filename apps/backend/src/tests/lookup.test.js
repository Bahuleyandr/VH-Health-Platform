import { authClient } from './testClient.js';

const client = authClient('ADMIN');

// The lookup router is nested under /api/v1/users/lookup (routes/user/index.js),
// but its root path is shadowed by the earlier-mounted GET /users/:identifier,
// which swallows "lookup" as an identifier (uuid cast → 500). The two-segment
// /lookup/advanced path escapes the shadow and reaches the same controller.
// The old suite hit /api/v1/lookup — a path that never existed; its catch-all
// status set (404 tolerated) kept it green forever.
describe('User Lookup API', () => {
  // Register a user through the real path so the lookups below have a
  // guaranteed hit — the suite must not depend on what other suites created.
  const phone = `9${Date.now().toString().slice(-9)}`;
  const name = `Lookup Tester ${phone}`;

  beforeAll(async () => {
    const res = await client.post('/api/v1/users/profile').send({
      phone,
      name,
      gender: 'MALE',
      role: 'PATIENT',
    });
    expect(res.statusCode).toBe(200);
  });

  it('fails without query parameters', async () => {
    const res = await client.get('/api/v1/users/lookup/advanced');
    // Known controller gap (R9 follow-up): the missing-parameter guard throws
    // a plain Error, which the controller's catch-all surfaces as 500 instead
    // of 400. Tighten to 400 when the service throws AppError.badRequest.
    expect(res.statusCode).toBe(500);
  });

  it('should lookup user by phone', async () => {
    const res = await client.get(`/api/v1/users/lookup/advanced?phone=${phone}`);
    expect(res.statusCode).toBe(200);
    expect(res.body?.data?.users?.length).toBe(1);
  });

  it('should lookup user by name', async () => {
    const res = await client.get(`/api/v1/users/lookup/advanced?name=${encodeURIComponent(name)}`);
    expect(res.statusCode).toBe(200);
    expect(res.body?.data?.users?.length).toBeGreaterThanOrEqual(1);
  });
});
