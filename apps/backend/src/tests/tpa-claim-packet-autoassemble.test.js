// Regression test for finding
// 2026-05-21-tpa-insurance-claim-discharge-9746f26c (+ f9ef3054, 54ede17f)
//
// submitClaim enforces a cashless final-claim packet
// (FINAL_CASHLESS_REQUIRED_DOC_TYPES = discharge_summary + final_bill) but
// nothing attached those documents — the discharge summary and final bill
// existed as records yet were never written to tpa_claim_documents, so
// every cashless final claim hit the "missing required document types"
// gate with no way for the coordinator to get past it.
//
// The fix adds ensureClaimDocumentBundle (mirroring the pre-auth submit
// assembler), which attaches the discharge summary + final bill as virtual
// vh:// references before the gate runs — but only for records that exist
// (it never fabricates a doc for a null admission/invoice).

import prisma from '../lib/prisma.js';
import * as claims from '../services/insurance/claimsService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'f4444444-4444-4444-8444-dddddddd4401';

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

async function seedIssuedInvoice({ total, admissionId }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_invoices
       (invoice_number, patient_uid, admission_id, invoice_type,
        subtotal, total_amount, amount_paid, amount_due, status, tenant_id)
     VALUES ($1, $2::uuid, $3::int, 'final',
             $4::numeric, $4::numeric, 0, $4::numeric, 'ISSUED', $5::uuid)
     RETURNING id`,
    `INV-PKT-${Date.now() % 100000}-${createdInvoiceIds.length}`,
    PATIENT_UID, admissionId, total, TENANT,
  );
  createdInvoiceIds.push(rows[0].id);
  return rows[0].id;
}

describe('TPA claim packet auto-assembly at submit (9746f26c)', () => {
  beforeAll(async () => {
    // Migration 753 gave createClaim real funding authority: it serialises on
    // the claim's patient through lockInsuranceFundingPatientTx →
    // resolvePharmacyFundingPatientUidTx, which demands patient_uid resolve to
    // exactly ONE `users` row in this tenant that is role='PATIENT',
    // is_active, status='active', not deleted and not merged. A fabricated uid
    // with no users row is refused with 409
    // PHARMACY_FUNDING_PATIENT_IDENTITY_MISMATCH, so register the patient the
    // way real registration does before hanging an admission, an invoice and a
    // claim off them.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, status, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'TPA Claim Packet Test Patient', 'PATIENT', true, 'active', $3::uuid, NOW())
       ON CONFLICT (uid) DO UPDATE
          SET is_active = true, status = 'active', is_deleted = false,
              merged_into_uid = NULL, updated_at = NOW()`,
      PATIENT_UID,
      `9602${Date.now() % 1000000}`.slice(0, 10),
      TENANT,
    );

    const pol = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_policies
         (patient_uid, policy_number, status, tenant_id)
       VALUES ($1::uuid, $2, 'active', $3::uuid)
       RETURNING id`,
      PATIENT_UID, `POL-PKT-${Date.now() % 100000}`, TENANT,
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
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }, 120_000);

  it('auto-assembles discharge_summary + final_bill so a cashless final claim can submit with no pre-attached docs', async () => {
    const admissionId = await seedAdmission();
    const invoiceId = await seedIssuedInvoice({ total: 50000, admissionId });
    const claim = await claims.createClaim({
      tenantId: TENANT, policy_id: policyId, patient_uid: PATIENT_UID,
      admission_id: admissionId, invoice_id: invoiceId, claim_type: 'cashless',
      stage: 'final', total_billed: 50000,
    });
    createdClaimIds.push(claim.id);

    const submitted = await claims.submitClaim({
      tenantId: TENANT, id: claim.id, submitted_by: null,
    });
    expect(submitted.status).toBe('submitted');

    const bundle = await claims.getClaimBundle({ tenantId: TENANT, id: claim.id });
    const types = bundle.documents.map((d) => d.doc_type).sort();
    expect(types).toEqual(['discharge_summary', 'final_bill']);
  });

  it('refuses a cashless FINAL claim with no invoice outright (CLAIM_FINAL_INVOICE_REQUIRED)', async () => {
    // MED-03 closed the state this suite used to seed for the "absent
    // backing records" case: a final cashless claim is the exact bill, so
    // createClaim now demands invoice_id up front rather than letting a
    // bill-less claim reach the packet gate. Pin that here, so the stage
    // change in the next case is anchored to a stated product rule instead
    // of looking like the fixture drifting away from an inconvenient guard.
    await expect(
      claims.createClaim({
        tenantId: TENANT, policy_id: policyId, patient_uid: PATIENT_UID,
        claim_type: 'cashless', stage: 'final', total_billed: 12000,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'CLAIM_FINAL_INVOICE_REQUIRED' });
  });

  it('does NOT fabricate a packet when the backing records are absent (no admission, no invoice)', async () => {
    // Stage 'enhancement' rather than 'final': a mid-stay cashless
    // enhancement genuinely has no discharge summary and no final invoice
    // yet, which is precisely the "backing records absent" shape this case
    // exists to cover — and unlike a final claim it is still a reachable
    // state after CLAIM_FINAL_INVOICE_REQUIRED. The assembler skip logic
    // (`requires: 'admission'` / `requires: 'invoice'`) and the empty-packet
    // gate are both stage-independent, so the assertion is unchanged.
    const claim = await claims.createClaim({
      tenantId: TENANT, policy_id: policyId, patient_uid: PATIENT_UID,
      claim_type: 'cashless', stage: 'enhancement', total_billed: 12000,
    });
    createdClaimIds.push(claim.id);

    await expect(
      claims.submitClaim({ tenantId: TENANT, id: claim.id, submitted_by: null }),
    ).rejects.toThrow(/at least one supporting document/i);

    const bundle = await claims.getClaimBundle({ tenantId: TENANT, id: claim.id });
    expect(bundle.documents.length).toBe(0);
  });

  it('is idempotent — a pre-attached discharge_summary is not duplicated', async () => {
    const admissionId = await seedAdmission();
    const invoiceId = await seedIssuedInvoice({ total: 32000, admissionId });
    const claim = await claims.createClaim({
      tenantId: TENANT, policy_id: policyId, patient_uid: PATIENT_UID,
      admission_id: admissionId, invoice_id: invoiceId, claim_type: 'cashless',
      stage: 'final', total_billed: 32000,
    });
    createdClaimIds.push(claim.id);

    // Coordinator hand-attached the discharge summary already.
    await claims.attachDocument({
      claim_id: claim.id, doc_type: 'discharge_summary',
      file_name: 'hand-uploaded.pdf', file_url: 'vh://manual/discharge',
      mime_type: 'application/pdf',
    });

    const submitted = await claims.submitClaim({
      tenantId: TENANT, id: claim.id, submitted_by: null,
    });
    expect(submitted.status).toBe('submitted');

    const bundle = await claims.getClaimBundle({ tenantId: TENANT, id: claim.id });
    const dischargeDocs = bundle.documents.filter((d) => d.doc_type === 'discharge_summary');
    const finalBillDocs = bundle.documents.filter((d) => d.doc_type === 'final_bill');
    expect(dischargeDocs.length).toBe(1); // not duplicated
    expect(finalBillDocs.length).toBe(1); // auto-added
  });
});
