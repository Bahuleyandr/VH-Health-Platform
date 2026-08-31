// Regression test for finding
// 2026-05-09-tpa-insurance-claim-billing-caps-table-split
//
// Pre-fix: POST /api/v1/insurance/claims/:id/caps returned 404 for
// every live TPA claim because `claimCapsService` queried
// `insurance_claims` (legacy table) but the Sprint 5 TPA workflow
// writes to `tpa_claims`. `insurance_claim_caps.claim_id` was a hard
// FK to the legacy table — caps simply could not be stored against
// a TPA claim, so structured per-category caps (pharmacy 15000,
// room semi-private) were unenforceable at invoice time.
//
// Fix: migration 197 makes `claim_id` nullable, adds a `tpa_claim_id`
// FK to `tpa_claims`, and a CHECK + two partial unique indexes so
// exactly one parent is set per row. `claimCapsService.resolveClaimTarget`
// probes both tables and writes to the correct column, preferring
// the TPA side when both ids exist (the route surface is the TPA
// workflow at /api/v1/insurance/*).

import { authClient } from './testClient.js';
import prisma from '../lib/prisma.js';

const PATIENT_UID = 'f1111111-1111-4111-8111-aaaaaaaa1102';
const TENANT = '00000000-0000-4000-8000-000000000001';
const POLICY_NUMBER = `POL-CAPS-${Date.now() % 100000}`;
const CLAIM_NUMBER = `CL-CAPS-${Date.now() % 100000}`;

describe('Claim caps API supports both insurance_claims and tpa_claims', () => {
  const admin = authClient('ADMIN');
  let policyId;
  let tpaClaimId;

  beforeAll(async () => {
    // Migration 753 gave the cap write path real funding authority:
    // setClaimCaps / deleteCap now serialize on the claim's patient through
    // resolvePharmacyFundingPatientUidTx, which demands that patient_uid
    // resolve to exactly ONE active PATIENT row in this tenant. A fabricated
    // uid with no `users` row is refused with 409
    // PHARMACY_FUNDING_PATIENT_IDENTITY_MISMATCH, so the fixture has to
    // register the patient the way the real TPA workflow does before it can
    // hang a policy and a claim off them.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at, tenant_id)
       VALUES ($1::uuid, $2, 'Claim Caps Test Patient', 'PATIENT', true, NOW(), $3::uuid)
       ON CONFLICT (uid) DO UPDATE SET updated_at = NOW()`,
      PATIENT_UID,
      `9776${Date.now() % 1000000}`.slice(0, 10),
      TENANT
    );

    const policyRows = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_policies
         (patient_uid, policy_number, status, tenant_id)
       VALUES ($1::uuid, $2, 'active', $3::uuid)
       RETURNING id`,
      PATIENT_UID,
      POLICY_NUMBER,
      TENANT
    );
    policyId = policyRows[0].id;

    const claimRows = await prisma.$queryRawUnsafe(
      `INSERT INTO tpa_claims
         (claim_number, policy_id, patient_uid, claim_type,
          total_billed, claimed_amount, status, tenant_id)
       VALUES ($1, $2::int, $3::uuid, 'cashless',
               58000, 58000, 'submitted', $4::uuid)
       RETURNING id`,
      CLAIM_NUMBER,
      policyId,
      PATIENT_UID,
      TENANT
    );
    tpaClaimId = claimRows[0].id;
  });

  afterAll(async () => {
    if (tpaClaimId) {
      await prisma
        .$executeRawUnsafe(`DELETE FROM tpa_claims WHERE id = $1::int`, tpaClaimId)
        .catch(() => {});
    }
    if (policyId) {
      await prisma
        .$executeRawUnsafe(
          `DELETE FROM insurance_policies WHERE id = $1::int`,
          policyId
        )
        .catch(() => {});
    }
    await prisma
      .$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT_UID)
      .catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }, 120_000);

  it('POST caps against a tpa_claims id persists to tpa_claim_id column', async () => {
    const res = await admin
      .post(`/api/v1/insurance/claims/${tpaClaimId}/caps`)
      .send({
        caps: [
          { category: 'pharmacy', max_amount: 15000, source: 'tpa_preauth' },
          { category: 'room_rent', max_amount: 3500, source: 'tpa_preauth' },
        ],
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT claim_id, tpa_claim_id, category, max_amount
         FROM insurance_claim_caps
        WHERE tpa_claim_id = $1::int
        ORDER BY category`,
      tpaClaimId
    );
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.claim_id).toBeNull();
      expect(Number(row.tpa_claim_id)).toBe(tpaClaimId);
    }
    expect(rows.map((r) => r.category).sort()).toEqual(['pharmacy', 'room_rent']);
  });

  it('GET caps returns the rows stored against the TPA claim', async () => {
    const res = await admin.get(`/api/v1/insurance/claims/${tpaClaimId}/caps`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    const categories = res.body.data.map((c) => c.category).sort();
    expect(categories).toEqual(expect.arrayContaining(['pharmacy', 'room_rent']));
  });

  it('caps-apply preview uses the TPA-side caps', async () => {
    const res = await admin
      .post(`/api/v1/insurance/claims/${tpaClaimId}/caps/apply`)
      .send({
        lines: [
          { category: 'pharmacy', amount: 12000 },
          { category: 'pharmacy', amount: 8000 },
          { category: 'consultation', amount: 1500 },
        ],
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.any_breached).toBe(true);
    expect(res.body.data.total_uncapped).toBe(21500);
    expect(res.body.data.total_capped).toBe(16500); // pharmacy capped at 15k + 1.5k consultation
  });

  it('DELETE cap removes the right row scoped to the TPA claim', async () => {
    const res = await admin.delete(
      `/api/v1/insurance/claims/${tpaClaimId}/caps/room_rent`
    );
    expect(res.statusCode).toBe(200);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT category FROM insurance_claim_caps
        WHERE tpa_claim_id = $1::int`,
      tpaClaimId
    );
    expect(rows.map((r) => r.category)).toEqual(['pharmacy']);
  });

  it('returns 404 for an id that exists in neither claims table', async () => {
    const res = await admin
      .post(`/api/v1/insurance/claims/9999999/caps`)
      .send({ caps: [{ category: 'pharmacy', max_amount: 1000 }] });
    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
