import { authClient } from './testClient.js';

describe('Debug API', () => {
  it('fails closed for the debug namespace outside production admin flow', async () => {
    const client = authClient('ADMIN');
    // Mounted at /api/v1/debug/* (routes/infrastructure/index.js). The old
    // test hit /api/v1/debug-sentry, which 404s — its catch-all status set
    // masked that the route was never exercised. The infrastructure mount
    // sits before the global JWT layer; outside production the admin gate
    // does not populate req.user, so the namespace RBAC fails closed: 401.
    const res = await client.get('/api/v1/debug/debug-sentry');
    expect(res.statusCode).toBe(401);
  });
});
