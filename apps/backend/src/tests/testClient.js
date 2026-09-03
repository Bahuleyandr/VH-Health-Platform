import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../app.js';

// ✅ Ensure .env.local is loaded first
dotenv.config({ path: '.env.local' });

export const API_KEY = process.env.API_KEY || 'test-api-key';

/**
 * Generate a test JWT token with the given role (default: ADMIN for maximum access)
 */
export function generateTestToken(role = 'ADMIN', overrides = {}) {
  const secret = process.env.JWT_SECRET || 'test-jwt-secret';
  return jwt.sign(
    {
      uid: '550e8400-e29b-41d4-a716-446655440000',
      id: 1,
      phone: '9876543210',
      role,
      // Every real auth realm stamps deviceType at login. Staff clinical-write
      // routes are desktop/tablet-only (rejectMobileClinicalWrite), so staff
      // tokens default to 'desktop'. The PATIENT app is mobile and is NOT a
      // staff clinical write, so patient tokens default to 'mobile' — this makes
      // the journey gate exercise the REAL patient contract instead of masking a
      // device-gated patient route (see finding
      // 2026-06-17-patient-investigation-booking-mobile-blocked). Override
      // deviceType per test as needed.
      deviceType: role === 'PATIENT' ? 'mobile' : 'desktop',
      ...overrides
    },
    secret,
    { expiresIn: '1h' }
  );
}

export const AUTH_TOKEN = `Bearer ${generateTestToken('ADMIN')}`;

export const TEST_DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Seed a LIVE identity row for a synthetic test uid.
 *
 * Authentication now fails closed when a token's subject does not resolve to a
 * live `users`/`admins` row (see `isUserTokensRevoked`). A suite that mints a
 * token for an invented uid and never inserts the row therefore gets 401
 * TOKEN_REVOKED before the route's own authz gate is ever reached — which
 * silently turns an authorization test into an authentication test. Real
 * requests always carry a real identity, so seeding one makes the fixture match
 * production rather than relaxing the gate.
 *
 * Idempotent, and re-livens a row a previous test retired.
 *
 * @param {string} uid the uuid the suite mints tokens for
 * @param {object} [options]
 * @param {string} [options.role='ADMIN'] role stamped on the row. Liveness does
 *   not depend on it; the token's own role claim drives authorization.
 * @param {string} [options.tenantId] defaults to the default tenant
 * @param {string} [options.name]
 */
export async function ensureTestIdentity(uid, options = {}) {
  const {
    role = 'ADMIN',
    tenantId = TEST_DEFAULT_TENANT_ID,
    name = `Test identity ${String(uid).slice(0, 8)}`,
    // Pass this when the suite keys behaviour off the identity's phone (a
    // self-service profile write resolves the caller by phone, not by uid).
    phone: explicitPhone = null,
  } = options;
  const { default: prisma } = await import('../lib/prisma.js');

  // Re-liven first: if the row already exists we must not invent a phone for
  // it, and this also repairs a row an earlier test retired.
  const relivened = await prisma.$executeRawUnsafe(
    `UPDATE users
        SET is_active = TRUE,
            status = 'active',
            is_deleted = FALSE,
            deleted_at = NULL,
            merged_into_uid = NULL,
            updated_at = NOW()
      WHERE uid = $1::uuid`,
    String(uid),
  );
  if (Number(relivened) > 0) return;

  // users.tenant_id is FK-bound to tenants. A suite that creates its own
  // tenants does so in its own beforeAll, which runs AFTER this one, so fall
  // back to the default tenant rather than 23503. Liveness does not depend on
  // which tenant the identity row sits in — only on the row existing and being
  // active — and the token still carries the suite's own tenant claim.
  const tenantRows = await prisma.$queryRawUnsafe(
    'SELECT 1 FROM tenants WHERE id = $1::uuid LIMIT 1',
    tenantId,
  );
  const resolvedTenantId = tenantRows.length ? tenantId : TEST_DEFAULT_TENANT_ID;

  // phone is UNIQUE per tenant (uniq_users_tenant_phone) and capped at 15
  // chars, so derive it from the WHOLE uid — the last few hex digits are not
  // distinctive across this repo's synthetic uids ('...00000000d001' recurs).
  // A salt loop covers the residual chance of colliding with a seeded patient.
  const numeric = BigInt(`0x${String(uid).replace(/-/g, '')}`);
  for (let salt = 0; salt < 20; salt++) {
    const phone = explicitPhone
      ?? `9${String((numeric + BigInt(salt)) % 1000000000n).padStart(9, '0')}`;
    if (explicitPhone && salt > 0) {
      throw new Error(`ensureTestIdentity: phone ${explicitPhone} is already taken`);
    }
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO users (uid, phone, name, role, is_active, status, tenant_id, registered_at, updated_at)
         VALUES ($1::uuid, $2, $3, $4, TRUE, 'active', $5::uuid, NOW(), NOW())
         ON CONFLICT (uid) DO UPDATE
            SET is_active = TRUE,
                status = 'active',
                is_deleted = FALSE,
                deleted_at = NULL,
                merged_into_uid = NULL,
                updated_at = NOW()`,
        String(uid), phone, name, role, resolvedTenantId,
      );
      return;
    } catch (err) {
      const duplicatePhone = String(err?.message || '').includes('uniq_users_tenant_phone');
      if (!duplicatePhone) throw err;
    }
  }
  throw new Error(`ensureTestIdentity: could not allocate a unique phone for ${uid}`);
}

/**
 * Returns a SuperTest client ready to make requests
 * @returns {SuperTest<Test>}
 */
export default function getClient() {
  return request(app);
}

/**
 * Returns a SuperTest client with API key + JWT auth pre-configured
 * Use this for routes that require authentication
 * @param {string} role - JWT role (default: ADMIN)
 */
export function authClient(role = 'ADMIN', overrides = {}) {
  const token = generateTestToken(role, overrides);
  return {
    get: (path) => request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (path) => request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (path) => request(app).put(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    patch: (path) => request(app).patch(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    delete: (path) => request(app).delete(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}
