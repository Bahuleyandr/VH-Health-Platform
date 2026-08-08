// Regression test for finding cluster H' D9.
//
// `submitClaim` enforced the cashless-final document packet
// (`FINAL_CASHLESS_REQUIRED_DOC_TYPES` = discharge_summary + final_bill)
// but never checked the underlying `discharge_summaries` row's status.
// A draft summary attached to the packet sailed through, the insurer
// received unauthorised draft documentation, and the case either
// bounced or settled against a draft that was later amended.
//
// The fix gates submit on the latest `discharge_summaries` row's
// status: must be `signed` or `delivered`. If no summary row exists
// at all, the gate stays quiet (auto-assemble pre-stages the
// placeholder; the operator handles the missing-summary case).
//
// Asserted:
//   * Draft discharge summary present → 400 DISCHARGE_SUMMARY_NOT_SIGNED.
//   * Signed discharge summary → submit succeeds.
//   * No summary row at all → existing auto-assemble path runs; the gate
//     stays quiet (we test by NOT raising the D9 code).
//
// Findings: d3df8c98, f6440157, 9c3e7848, 21d0b3df.

import prisma from '../lib/prisma.js';
import * as claims from '../services/insurance/claimsService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'd1111111-2222-4333-8444-eeeeeeee9909';
const STAMP = String(Date.now() % 100000).padStart(5, '0');

let policyId;
const createdClaimIds = [];
const createdInvoiceIds = [];
const createdSummaryIds = [];
const createdAdmissionIds = [];

// Sol Ultra #15 binds a claim's admission to a real tenant-scoped row, so
// the old fabricated admission ids now (correctly) reject at createClaim.
async function seedAdmission() {
  // Migration 640 allows only one active admission per patient — close any
  // prior fixture admission before seeding the next one. The earlier tests'
  // claims are already created/submitted, and the D9 gate reads the
  // discharge_summaries row, not the admission status, so discharging the
  // previous stay does not perturb them.
  await prisma.$executeRawUnsafe(
    `UPDATE admissions
        SET status = 'discharged', discharged_at = NOW()
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND status IN ('admitted', 'transferred')`,
    TENANT, PATIENT_UID,
  );
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO admissions (tenant_id, patient_uid, status, admitted_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'admitted', NOW(), NOW())
     RETURNING id`,
    TENANT, PATIENT_UID,
  );
  createdAdmissionIds.push(rows[0].id);
  return rows[0].id;
}

async function seedIssuedInvoice({ total, admissionId, idx }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_invoices
       (invoice_number, patient_uid, admission_id, invoice_type,
        subtotal, total_amount, amount_paid, amount_due, status, tenant_id)
     VALUES ($1, $2::uuid, $3::int, 'final',
             $4::numeric, $4::numeric, 0, $4::numeric, 'ISSUED', $5::uuid)
     RETURNING id`,
    `INV-D9-${STAMP}-${idx}`,
    PATIENT_UID, admissionId, total, TENANT,
  );
  createdInvoiceIds.push(rows[0].id);
  return rows[0].id;
}

async function seedDischargeSummary({ admissionId, status }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO discharge_summaries
       (admission_id, patient_uid, status, tenant_id)
     VALUES ($1::int, $2::uuid, $3, $4::uuid)
     RETURNING id`,
    admissionId, PATIENT_UID, status, TENANT,
  );
  createdSummaryIds.push(rows[0].id);
  return rows[0].id;
}

describe('submitClaim — unsigned discharge summary gate (H D9)', () => {
  beforeAll(async () => {
    const pol = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_policies
         (patient_uid, policy_number, status, tenant_id)
       VALUES ($1::uuid, $2, 'active', $3::uuid)
       RETURNING id`,
      PATIENT_UID, `POL-D9-${STAMP}`, TENANT,
    );
    policyId = pol[0].id;
  });

  afterAll(async () => {
    for (const id of createdClaimIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM tpa_claim_documents WHERE claim_id = $1::int`, id).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM tpa_claims WHERE id = $1::int`, id).catch(() => {});
    }
    for (const id of createdSummaryIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM discharge_summaries WHERE id = $1::int`, id).catch(() => {});
    }
    for (const id of createdInvoiceIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = $1::int`, id).catch(() => {});
    }
    for (const id of createdAdmissionIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE id = $1::int`, id).catch(() => {});
    }
    if (policyId) {
      await prisma.$executeRawUnsafe(`DELETE FROM insurance_policies WHERE id = $1::int`, policyId).catch(() => {});
    }
    await prisma.$disconnect().catch(() => {});
  });

  it('rejects cashless final submit when discharge summary is still in draft', async () => {
    const admissionId = await seedAdmission();
    const invoiceId = await seedIssuedInvoice({ total: 45000, admissionId, idx: 'draft' });
    await seedDischargeSummary({ admissionId, status: 'draft' });

    const claim = await claims.createClaim({
      tenantId: TENANT, policy_id: policyId, patient_uid: PATIENT_UID,
      admission_id: admissionId, invoice_id: invoiceId,
      claim_type: 'cashless', stage: 'final', total_billed: 45000,
    });
    createdClaimIds.push(claim.id);

    await expect(
      claims.submitClaim({ tenantId: TENANT, id: claim.id, submitted_by: null }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'DISCHARGE_SUMMARY_NOT_SIGNED',
    });
  });

  it('accepts cashless final submit when discharge summary is signed', async () => {
    const admissionId = await seedAdmission();
    const invoiceId = await seedIssuedInvoice({ total: 50000, admissionId, idx: 'signed' });
    await seedDischargeSummary({ admissionId, status: 'signed' });

    const claim = await claims.createClaim({
      tenantId: TENANT, policy_id: policyId, patient_uid: PATIENT_UID,
      admission_id: admissionId, invoice_id: invoiceId,
      claim_type: 'cashless', stage: 'final', total_billed: 50000,
    });
    createdClaimIds.push(claim.id);

    const submitted = await claims.submitClaim({
      tenantId: TENANT, id: claim.id, submitted_by: null,
    });
    expect(submitted.status).toBe('submitted');
  });

  it('accepts cashless final submit when no discharge summary row exists (gate stays quiet)', async () => {
    // No discharge_summaries row → my D9 gate does NOT fire (the
    // missing-summary case is handled by auto-assemble / coordinator
    // workflow, not this regression).
    const admissionId = await seedAdmission();
    const invoiceId = await seedIssuedInvoice({ total: 40000, admissionId, idx: 'none' });

    const claim = await claims.createClaim({
      tenantId: TENANT, policy_id: policyId, patient_uid: PATIENT_UID,
      admission_id: admissionId, invoice_id: invoiceId,
      claim_type: 'cashless', stage: 'final', total_billed: 40000,
    });
    createdClaimIds.push(claim.id);

    const submitted = await claims.submitClaim({
      tenantId: TENANT, id: claim.id, submitted_by: null,
    });
    expect(submitted.status).toBe('submitted');
  });
});
