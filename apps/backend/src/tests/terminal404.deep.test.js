// M19 (audit 2026-06-22): an unmatched route previously fell through to Express's
// default HTML "Cannot GET /x", breaking the JSON envelope. The terminal 404
// handler must return the standard envelope instead.

import { authClient } from './testClient.js';

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;

d('terminal 404 handler (M19)', () => {
  it('returns a JSON envelope (not HTML) for an unmatched API route', async () => {
    const res = await authClient('ADMIN').get('/api/v1/__no_such_route_xyz__');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toMatchObject({ success: false, code: 'NOT_FOUND' });
    // Must not be Express's default HTML body.
    expect(typeof res.body).toBe('object');
  });

  it('returns the JSON 404 envelope for an unmatched non-API path too', async () => {
    const res = await authClient('ADMIN').get('/__totally_unmatched__');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: 'NOT_FOUND' });
  });
});
