// W4 C5: every login path mints an access token carrying the right tenant_id.
// Covers the two gaps: admin (admins aren't in `users`, so resolveTenantIdForUid
// mis-defaulted to the default tenant) and patient OTP (bare generateToken, no
// tenant_id claim).
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import prisma from '../lib/prisma.js';
import { AuthService } from '../services/auth/authService.js';

const TENANT_A = 'a5c5a5c5-a5c5-4a5a-8a5a-a5c5a5c5a501';
const SFX = String(Date.now() % 100000).padStart(5, '0');
const ADMIN_UID = 'a5c5a5c5-ad00-4a5a-8a5a-a5c5a5c5ad01';
const PATIENT_UID = 'b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b001';
const ADMIN_USER = `w4c5-admin-${SFX}`;
// Idempotent under normalizePhone (already +-prefixed) so the seeded row and
// the directOtpLogin lookup match. 10 digits after +91.
const PATIENT_PHONE = `+9199${SFX}000`;

function decode(token) {
  return jwt.decode(token);
}

describe('W4 C5 — login tokens carry the right tenant_id', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
       VALUES ($1::uuid,$2,$3,'IN','DPDP','active','{}'::jsonb,NOW(),NOW()) ON CONFLICT (id) DO NOTHING`,
      TENANT_A, `w4c5-a-${SFX}`, 'W4 C5 Tenant A',
    );
    const hash = await bcrypt.hash('pw-correct-horse', 10);
    await prisma.$executeRawUnsafe(
      `INSERT INTO admins (uid, username, password_hash, role, status, tenant_id, totp_enabled, failed_login_attempts, created_at, updated_at)
       VALUES ($1::uuid,$2,$3,'ADMIN','active',$4::uuid,false,0,NOW(),NOW())
       ON CONFLICT (uid) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, password_hash = EXCLUDED.password_hash`,
      ADMIN_UID, ADMIN_USER, hash, TENANT_A,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, tenant_id, is_active, updated_at)
       VALUES ($1::uuid,$2,'W4 C5 Patient','PATIENT',$3::uuid,true,NOW())
       ON CONFLICT (uid) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, phone = EXCLUDED.phone`,
      PATIENT_UID, PATIENT_PHONE, TENANT_A,
    );
  }, 30000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM admins WHERE uid = $1::uuid`, ADMIN_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_A).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('admin login token carries the admin tenant_id (not the default)', async () => {
    const req = { hostname: 'localhost', headers: { 'user-agent': 'jest' }, ip: '127.0.0.1', connection: { remoteAddress: '127.0.0.1' } };
    const res = await AuthService.adminLogin(ADMIN_USER, 'pw-correct-horse', req, { deviceType: 'web' });
    expect(res.token).toBeTruthy();
    expect(decode(res.token).tenant_id).toBe(TENANT_A);
  });

  it('patient OTP (directOtpLogin) token carries the patient tenant_id', async () => {
    const res = await AuthService.directOtpLogin(PATIENT_PHONE);
    expect(res.token).toBeTruthy();
    expect(decode(res.token).tenant_id).toBe(TENANT_A);
  });
});
