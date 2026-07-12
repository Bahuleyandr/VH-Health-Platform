// Regression guard for Sol Ultra audit #17: login mints a distinct
// type:'refresh' JWT (30-day, same subject/role, revocable jti) for the
// /auth/*/refresh endpoint only. The global jwtMiddleware validated signature,
// expiry and revocation but never rejected token kind, so a copied refresh
// token could be replayed directly as a full access bearer for its remaining
// lifetime — skipping refresh rotation and session-state checks.
//
// The guard fires immediately after signature verification (before any
// revocation/DB lookup), so this test needs no database.
import jwt from 'jsonwebtoken';
import jwtMiddleware from '../../middleware/jwtMiddleware.js';

const SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-ci-must-be-at-least-32-chars';

function makeReq(payload) {
  const token = jwt.sign(payload, SECRET, { expiresIn: '30d' });
  return {
    headers: { authorization: `Bearer ${token}` },
    connection: { remoteAddress: '127.0.0.1' },
  };
}
function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
  };
}

describe('jwtMiddleware refresh-token rejection (Sol Ultra #17)', () => {
  it('rejects a type:refresh token presented as an access bearer with 401', async () => {
    const req = makeReq({
      uid: 'a0000000-0000-4000-8000-0000000ref17',
      id: 5,
      role: 'DOCTOR',
      type: 'refresh',
    });
    const res = makeRes();
    let nextCalled = false;
    await jwtMiddleware(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body?.code).toBe('TOKEN_INVALID');
  });
});
