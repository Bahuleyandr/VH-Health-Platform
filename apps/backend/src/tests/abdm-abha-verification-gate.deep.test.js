// ABHA verification gate (migration 653) — squat scenario end-to-end.
//
// Before 653, with ABDM disabled any authenticated patient could claim any
// well-formed ABHA number and migration 647's unique index made the claim
// permanent — the rightful holder was locked out with ABHA_ALREADY_LINKED and
// no unlink path exists. The gate makes verification, not claim order, decide
// ownership:
//   - a PENDING claim never blocks another patient from claiming the number
//   - only a gateway-VERIFIED link owns the tenant-unique slot
//   - the loser of a verify race gets 409 and stays pending
//   - inbound ABDM callbacks and the staff lookup resolve verified links only
//
// ABDM is enabled via env BEFORE any import (config is read at module load)
// and the gateway module is mocked, so verifyABHA can be scripted while the
// rest of the stack (service, prisma, canonical audit) runs for real against
// the test Postgres. Self-skips when unconfigured.

import { jest } from '@jest/globals';

process.env.ABDM_ENABLED = 'true';
process.env.ABDM_HIP_ID = 'gate-test-hip';
process.env.ABDM_CALLBACK_SECRET = 'x'.repeat(64);

const verifyABHA = jest.fn();
jest.unstable_mockModule('../services/abdm/abdmGateway.js', () => ({
  default: { verifyABHA },
}));

const { default: prisma } = await import('../lib/prisma.js');
const { default: abdmService } = await import('../services/abdm/abdmService.js');

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const SQUATTER_UID = '65300000-0000-4000-8000-00000000000a';
const OWNER_UID = '65300000-0000-4000-8000-00000000000b';
const PROMOTE_UID = '65300000-0000-4000-8000-00000000000c';
const SQUATTER_PHONE = '+919000653001';
const OWNER_PHONE = '+919000653002';
const PROMOTE_PHONE = '+919000653003';
// The contested number (canonical spelling) and a pending-only one.
const CONTESTED_ABHA = '65-3000-0000-0001';
const PENDING_ONLY_ABHA = '65-3000-0000-0002';

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
    SQUATTER_UID, OWNER_UID, PROMOTE_UID,
  ).catch(() => {});
}

d('ABHA verification gate (migration 653)', () => {
  beforeAll(async () => {
    await cleanup();
    // The squatter claimed the contested number while ABDM was disabled — a
    // pre-gate claim, so it sits at 'pending' exactly like migration 653
    // leaves every existing row.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, abha_number, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'Gate Squatter', 'PATIENT', true, $4, NOW())`,
      SQUATTER_UID, TENANT_ID, SQUATTER_PHONE, CONTESTED_ABHA,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'Gate Rightful Owner', 'PATIENT', true, NOW())`,
      OWNER_UID, TENANT_ID, OWNER_PHONE,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, abha_number, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'Gate Promote Target', 'PATIENT', true, $4, NOW())`,
      PROMOTE_UID, TENANT_ID, PROMOTE_PHONE, PENDING_ONLY_ABHA,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  beforeEach(() => {
    verifyABHA.mockReset();
  });

  test('squat end-to-end: a pending squat never blocks the rightful owner, and verification decides ownership', async () => {
    // The squatter's claim really is pending.
    const squatRows = await prisma.$queryRawUnsafe(
      `SELECT abha_verification_status FROM users WHERE uid = $1::uuid`,
      SQUATTER_UID,
    );
    expect(squatRows[0].abha_verification_status).toBe('pending');

    // The rightful owner claims the SAME number: the squatter's pending claim
    // does not block, the gateway verifies, and the link mints VERIFIED.
    verifyABHA.mockResolvedValueOnce({ verified: true });
    const ownerLink = await abdmService.registerABHA(
      OWNER_UID, CONTESTED_ABHA, null, { tenantId: TENANT_ID },
    );
    expect(ownerLink).toMatchObject({
      linked: true,
      abhaNumber: CONTESTED_ABHA,
      verification_status: 'verified',
    });
    expect(ownerLink.abha_verified_at).not.toBeNull();

    // The squatter now tries to verify their stale pending claim: the gateway
    // may even say yes, but the verified slot is taken — 409, still pending.
    verifyABHA.mockResolvedValueOnce({ verified: true });
    await expect(
      abdmService.verifyLinkedAbha(SQUATTER_UID, { tenantId: TENANT_ID }),
    ).rejects.toMatchObject({ code: 'ABHA_ALREADY_LINKED', statusCode: 409 });

    const afterRows = await prisma.$queryRawUnsafe(
      `SELECT uid::text AS uid, abha_verification_status FROM users
        WHERE uid IN ($1::uuid, $2::uuid) ORDER BY uid`,
      SQUATTER_UID, OWNER_UID,
    );
    const byUid = Object.fromEntries(afterRows.map((r) => [r.uid, r.abha_verification_status]));
    expect(byUid[SQUATTER_UID]).toBe('pending');
    expect(byUid[OWNER_UID]).toBe('verified');

    // The ABHA_LINKED audit row for the owner's verified link was written in
    // the same transaction as the users UPDATE.
    const audit = await prisma.$queryRawUnsafe(
      `SELECT action, metadata FROM clinical_audit_events
        WHERE patient_uid = $1::uuid AND action = 'ABHA_LINKED'
        ORDER BY occurred_at DESC LIMIT 1`,
      OWNER_UID,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({
      verification_status: 'verified',
      gateway_verification_ran: true,
    });
  });

  test('the verify endpoint promotes a pending link and writes the ABHA_VERIFIED audit row', async () => {
    verifyABHA.mockResolvedValueOnce({ verified: true });

    const result = await abdmService.verifyLinkedAbha(PROMOTE_UID, { tenantId: TENANT_ID });

    expect(result).toMatchObject({
      linked: true,
      abhaNumber: PENDING_ONLY_ABHA,
      verification_status: 'verified',
    });
    expect(result.abha_verified_at).not.toBeNull();
    expect(verifyABHA).toHaveBeenCalledWith(PENDING_ONLY_ABHA);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT abha_verification_status, abha_verified_at FROM users WHERE uid = $1::uuid`,
      PROMOTE_UID,
    );
    expect(rows[0].abha_verification_status).toBe('verified');
    expect(rows[0].abha_verified_at).not.toBeNull();

    const audit = await prisma.$queryRawUnsafe(
      `SELECT action FROM clinical_audit_events
        WHERE patient_uid = $1::uuid AND action = 'ABHA_VERIFIED'`,
      PROMOTE_UID,
    );
    expect(audit).toHaveLength(1);

    // Verifying again is an idempotent no-op (no second gateway call).
    verifyABHA.mockClear();
    const again = await abdmService.verifyLinkedAbha(PROMOTE_UID, { tenantId: TENANT_ID });
    expect(again.verification_status).toBe('verified');
    expect(verifyABHA).not.toHaveBeenCalled();
  });

  test('an inbound callback does not resolve a pending link', async () => {
    // The squatter's contested claim is pending (previous test) — the inbound
    // resolver must treat the number as unknown for them; it resolves the
    // VERIFIED holder instead.
    const resolved = await abdmService._resolvePatientTenantByAbha(CONTESTED_ABHA);
    expect(String(resolved.patientUid)).toBe(OWNER_UID);

    // A number that exists only as a pending claim resolves to nobody. The
    // promote-target was verified above, so park a fresh pending claim on the
    // squatter's row for this assertion.
    await prisma.$executeRawUnsafe(
      `UPDATE users SET abha_number = $1, abha_verification_status = 'pending', abha_verified_at = NULL
        WHERE uid = $2::uuid`,
      '65-3000-0000-0003', SQUATTER_UID,
    );
    await expect(
      abdmService._resolvePatientTenantByAbha('65-3000-0000-0003'),
    ).rejects.toMatchObject({ code: 'ABDM_PATIENT_NOT_FOUND', statusCode: 404 });
  });

  test('getPatientByABHA ignores pending links', async () => {
    // 65-3000-0000-0003 is on file as a pending claim (previous test).
    await expect(
      abdmService.getPatientByABHA('65-3000-0000-0003', { tenantId: TENANT_ID }),
    ).rejects.toMatchObject({ code: 'ABHA_NOT_FOUND', statusCode: 404 });

    // The verified holder of the contested number still resolves.
    const patient = await abdmService.getPatientByABHA(CONTESTED_ABHA, { tenantId: TENANT_ID });
    expect(String(patient.uid)).toBe(OWNER_UID);
  });
});
