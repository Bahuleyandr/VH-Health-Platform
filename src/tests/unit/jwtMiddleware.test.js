// Unit tests for jwtMiddleware — locks in the contract that `req.user` carries
// `{ uid, role, roles?, phone?, email?, id? }`. The `id` surface was added
// 2026-04-14 after an audit found 100+ call sites doing `String(user.id)` against
// an always-undefined field. Broken IDOR checks in appointments + elsewhere.

import jwt from 'jsonwebtoken';
import jwtMiddleware from '../../middleware/jwtMiddleware.js';

const SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-ci-must-be-at-least-32-chars';

function makeReq(tokenPayload, extraHeaders = {}) {
  const token = jwt.sign(tokenPayload, SECRET, { expiresIn: '1h' });
  return {
    headers: { authorization: `Bearer ${token}`, ...extraHeaders },
    connection: { remoteAddress: '127.0.0.1' },
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
  };
  return res;
}

describe('jwtMiddleware.req.user shape', () => {
  it('surfaces uid + role + id when all three are present on the token', async () => {
    const req = makeReq({
      uid: 'a0000000-0000-4000-8000-000000000001',
      id: 42,
      role: 'DOCTOR',
      phone: '+919000000000',
      email: 'doc@test.local',
    });
    const res = makeRes();
    let nextCalled = false;
    await jwtMiddleware(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(req.user).toMatchObject({
      uid: 'a0000000-0000-4000-8000-000000000001',
      id: 42,
      role: 'DOCTOR',
      phone: '+919000000000',
      email: 'doc@test.local',
    });
  });

  it('normalizes SUPER_ADMIN → ADMIN', async () => {
    const req = makeReq({ uid: 'a0000000-0000-4000-8000-000000000002', id: 1, role: 'SUPER_ADMIN' });
    const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(req.user.role).toBe('ADMIN');
  });

  it('normalizes NURSE → NURSING_STAFF', async () => {
    const req = makeReq({ uid: 'a0000000-0000-4000-8000-000000000003', id: 2, role: 'NURSE' });
    const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(req.user.role).toBe('NURSING_STAFF');
  });

  it('sets id to null when the token is uid-only', async () => {
    const req = makeReq({ uid: 'a0000000-0000-4000-8000-000000000004', role: 'PATIENT' });
    const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(req.user.uid).toBe('a0000000-0000-4000-8000-000000000004');
    expect(req.user.id).toBeNull();
  });

  it('accepts userId claim as a fallback for id', async () => {
    const req = makeReq({ uid: 'a0000000-0000-4000-8000-000000000005', userId: 99, role: 'PATIENT' });
    const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(req.user.id).toBe(99);
  });

  it('rejects missing Authorization header with 401', async () => {
    const req = { headers: {}, connection: { remoteAddress: '127.0.0.1' } };
    const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(401);
    expect(res.body?.success).toBe(false);
  });

  it('rejects malformed Authorization header with 401', async () => {
    const req = { headers: { authorization: 'Basic abc' }, connection: { remoteAddress: '127.0.0.1' } };
    const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const tampered = jwt.sign({ uid: 'x', role: 'PATIENT' }, 'wrong-secret', { expiresIn: '1h' });
    const req = { headers: { authorization: `Bearer ${tampered}` }, connection: { remoteAddress: '127.0.0.1' } };
    const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token with no uid-like claim with 400', async () => {
    const req = makeReq({ role: 'PATIENT' }); // no uid/sub/id
    const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(400);
  });
});
