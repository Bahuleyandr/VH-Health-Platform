// Regression for swarm D59.
//
// A cashless final TPA claim is an auditable payer packet. It must not be
// accepted against a final invoice whose billable lines are all free-text
// manual rows, because the insurer cannot trace the charge back to the
// order/indent/package/admission event that produced it.

import prisma from '../lib/prisma.js';
import * as claims from '../services/insurance/claimsService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'd5900000-0000-4000-8000-000000000001';
const RUN_SUFFIX = String(Date.now() % 100000).padStart(5, '0');

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

async function seedIssuedInvoice({ admissionId, sourceRefType, sourceRefId }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_invoices
       (invoice_number, patient_uid, admission_id, invoice_type,
        subtotal, total_amount, amount_paid, amount_due, status, tenant_id)
     VALUES ($1, $2::uuid, $3::int, 'IP',
             125, 125, 0, 125, 'ISSUED', $4::uuid)
     RETURNING id`,
    `INV-D59-${RUN_SUFFIX}-${createdInvoiceIds.length}`,
    PATIENT_UID,
    admissionId,
    TENANT,
  );
  const invoiceId = rows[0].id;
  createdInvoiceIds.push(invoiceId);
  await prisma.$executeRawUnsafe(
    `INSERT INTO billing_invoice_items
       (invoice_id, description, category, quantity, unit_price, gst_rate,
        line_subtotal, cgst_amount, sgst_amount, igst_amount, line_total,
        source_ref_type, source_ref_id)
     VALUES ($1::int, 'Final pharmacy consumables', 'pharmacy', 1, 125, 0,
             125, 0, 0, 0, 125, $2, $3::int)`,
    invoiceId,
    sourceRefType,
    sourceRefId,
  );
  return invoiceId;
}

describe('TPA final claim invoice line traceability (D59)', () => {
  beforeAll(async () => {
    const pol = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_policies
         (patient_uid, policy_number, status, tenant_id)
       VALUES ($1::uuid, $2, 'active', $3::uuid)
       RETURNING id`,
      PATIENT_UID,
      `POL-D59-${RUN_SUFFIX}`,
      TENANT,
    );
    policyId = pol[0].id;
  });

  afterAll(async () => {
    for (const id of createdClaimIds) {
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

  it('rejects a final cashless claim when billable invoice lines are manual', async () => {
    const admissionId = await seedAdmission();
    const invoiceId = await seedIssuedInvoice({
      admissionId,
      sourceRefType: 'manual',
      sourceRefId: null,
    });

    await expect(
      claims.createClaim({
        tenantId: TENANT,
        policy_id: policyId,
        patient_uid: PATIENT_UID,
        admission_id: admissionId,
        invoice_id: invoiceId,
        claim_type: 'cashless',
        stage: 'final',
        total_billed: 125,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'TPA_INVOICE_LINE_TRACE_REQUIRED',
      details: {
        invoice_id: invoiceId,
        untraceable_count: 1,
      },
    });
  });

  it('allows a final cashless claim when invoice lines carry source refs', async () => {
    const admissionId = await seedAdmission();
    const invoiceId = await seedIssuedInvoice({
      admissionId,
      sourceRefType: 'ward_indent',
      sourceRefId: 12345,
    });

    const claim = await claims.createClaim({
      tenantId: TENANT,
      policy_id: policyId,
      patient_uid: PATIENT_UID,
      admission_id: admissionId,
      invoice_id: invoiceId,
      claim_type: 'cashless',
      stage: 'final',
      total_billed: 125,
    });
    createdClaimIds.push(claim.id);
    expect(Number(claim.total_billed)).toBe(125);
    expect(Number(claim.claimed_amount)).toBe(125);
  });
});
