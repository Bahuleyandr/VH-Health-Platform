// Regression test for finding
// 2026-05-22-tpa-insurance-claim-billing-7239f4be
//
// A final cashless TPA claim was anchored to an INTERIM IPD invoice (₹76k)
// while the full final bill for the admission was higher (₹80k). Because
// interim and final IPD invoices share invoice_type='IP' (the interim-ness
// lives only in free-text notes), assertIssuedFinalCashlessInvoice happily
// accepted the interim invoice: status was ISSUED, patient/admission matched,
// and total_billed equalled the interim total. The claim's claimed_amount was
// then pinned to ₹76k, so recordClaimDecision's approved≤claimed guard
// rejected the genuine ₹78k insurer settlement — the cashier could not
// reconcile the advice and risked under-claiming the payer.
//
// The fix extends assertIssuedFinalCashlessInvoice: a final cashless claim is
// rejected (CLAIM_INVOICE_NOT_FINAL) when another live (ISSUED/PARTIAL/PAID,
// non-voided) invoice for the same admission has a strictly greater
// total_amount — i.e. the claim is anchored to a stale interim bill instead
// of the final one. Re-anchoring to the larger final invoice lets the claim
// reach the full final bill (and #154's claimed≤total_billed guard stays
// consistent because the final invoice total IS the bill total).

import prisma from '../lib/prisma.js';
import * as claims from '../services/insurance/claimsService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'f4444444-4444-4444-8444-dddddddd5501';

const createdClaimIds = [];
const createdInvoiceIds = [];
const createdAdmissionIds = [];

// Sol Ultra #15 binds a claim's admission to a real tenant-scoped row, so
// fabricated admission ids now (correctly) reject at createClaim.
async function seedAdmission() {
  // Migration 640 allows only one active admission per patient — close any
  // prior fixture admission before seeding the next one.
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
let policyId;

async function seedIssuedInvoice({ total, admissionId, status = 'ISSUED', invoiceType = 'IP' }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_invoices
       (invoice_number, patient_uid, admission_id, invoice_type,
        subtotal, total_amount, amount_paid, amount_due, status, tenant_id)
     VALUES ($1, $2::uuid, $3::int, $4,
             $5::numeric, $5::numeric, 0, $5::numeric, $6, $7::uuid)
     RETURNING id`,
    `INV-BASIS-${Date.now() % 100000}-${createdInvoiceIds.length}`,
    PATIENT_UID, admissionId, invoiceType, total, status, TENANT,
  );
  createdInvoiceIds.push(rows[0].id);
  return rows[0].id;
}

describe('TPA final-claim invoice basis (interim vs final bill, 7239f4be)', () => {
  beforeAll(async () => {
    const pol = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_policies
         (patient_uid, policy_number, status, tenant_id)
       VALUES ($1::uuid, $2, 'active', $3::uuid)
       RETURNING id`,
      PATIENT_UID, `POL-BASIS-${Date.now() % 100000}`, TENANT,
    );
    policyId = pol[0].id;
  });

  afterAll(async () => {
    for (const id of createdClaimIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM tpa_claim_documents WHERE claim_id = $1::int`, id).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM tpa_claims WHERE id = $1::int`, id).catch(() => {});
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

  it('rejects createClaim when the final cashless claim is anchored to an interim invoice and a larger final invoice exists', async () => {
    const admissionId = await seedAdmission();
    // Interim IPD bill (₹76k) and the full final bill (₹80k) — both ISSUED,
    // both invoice_type='IP', same admission. Mirrors the finding.
    const interimId = await seedIssuedInvoice({ total: 76000, admissionId });
    await seedIssuedInvoice({ total: 80000, admissionId });

    await expect(
      claims.createClaim({
        tenantId: TENANT, policy_id: policyId, patient_uid: PATIENT_UID,
        admission_id: admissionId, invoice_id: interimId, claim_type: 'cashless',
        stage: 'final', total_billed: 76000,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'CLAIM_INVOICE_NOT_FINAL',
      message: expect.stringMatching(/anchored to interim invoice/i),
    });
  });

  it('allows the final cashless claim anchored to the FINAL invoice and is not capped at the interim amount', async () => {
    const admissionId = await seedAdmission();
    await seedIssuedInvoice({ total: 76000, admissionId }); // interim, lower
    const finalId = await seedIssuedInvoice({ total: 80000, admissionId }); // final, full bill

    const claim = await claims.createClaim({
      tenantId: TENANT, policy_id: policyId, patient_uid: PATIENT_UID,
      admission_id: admissionId, invoice_id: finalId, claim_type: 'cashless',
      stage: 'final', total_billed: 80000,
    });
    createdClaimIds.push(claim.id);

    // The claim is anchored to the ₹80k final bill — claimed_amount reaches
    // the full final total, not the interim ₹76k. A ₹78k partial-approval
    // settlement is now within claimed_amount.
    expect(Number(claim.total_billed)).toBe(80000);
    expect(Number(claim.claimed_amount)).toBe(80000);

    // Advance to 'submitted' so we can record the insurer decision (the
    // submit-packet flow is covered separately; here we exercise the
    // approved≤claimed reconciliation against the full final-bill basis).
    await prisma.$executeRawUnsafe(
      `UPDATE tpa_claims SET status = 'submitted' WHERE id = $1::int`,
      claim.id,
    );

    const decided = await claims.recordClaimDecision({
      tenantId: TENANT, id: claim.id, decision: 'partially_approved',
      approved_amount: 78000,
      denial_reason: 'TPA disallowed INR 2000 consumable from INR 80000 final claim',
    });
    expect(decided.status).toBe('partially_approved');
    expect(Number(decided.approved_amount)).toBe(78000);
  });

  it('does NOT false-positive when the linked invoice is the only/largest invoice for the admission', async () => {
    const admissionId = await seedAdmission();
    // A lower interim that was later VOIDED + a smaller PARTIAL must not
    // block: neither is a live invoice with a greater total than the final.
    await seedIssuedInvoice({ total: 90000, admissionId, status: 'VOID' });
    await seedIssuedInvoice({ total: 40000, admissionId, status: 'PARTIAL' });
    const finalId = await seedIssuedInvoice({ total: 80000, admissionId });

    const claim = await claims.createClaim({
      tenantId: TENANT, policy_id: policyId, patient_uid: PATIENT_UID,
      admission_id: admissionId, invoice_id: finalId, claim_type: 'cashless',
      stage: 'final', total_billed: 80000,
    });
    createdClaimIds.push(claim.id);
    expect(Number(claim.total_billed)).toBe(80000);
  });

  it('rejects at submitClaim too when a prepared final claim is still anchored to the interim invoice', async () => {
    const admissionId = await seedAdmission();
    const interimId = await seedIssuedInvoice({ total: 76000, admissionId });
    const finalId = await seedIssuedInvoice({ total: 80000, admissionId });

    // Create the claim against the FINAL bill so createClaim passes, then
    // re-point it at the interim invoice (simulating a stale linkage) and
    // exercise the submit-time guard.
    const claim = await claims.createClaim({
      tenantId: TENANT, policy_id: policyId, patient_uid: PATIENT_UID,
      admission_id: admissionId, invoice_id: finalId, claim_type: 'cashless',
      stage: 'final', total_billed: 80000,
    });
    createdClaimIds.push(claim.id);
    await prisma.$executeRawUnsafe(
      `UPDATE tpa_claims SET invoice_id = $1::int, total_billed = 76000 WHERE id = $2::int`,
      interimId, claim.id,
    );

    await expect(
      claims.submitClaim({ tenantId: TENANT, id: claim.id, submitted_by: null }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'CLAIM_INVOICE_NOT_FINAL',
    });
  });
});
