// Regression test for finding cluster H' D8 (870ff6a9 + 5953f182).
//
// When the TPA desk flags `billing_invoice_items.tpa_decision =
// 'non_payable'` (via the existing recordInvoiceItemTpaDecision
// flow), those line totals are the insurer-adjudicated non-payable
// amounts. A claim posted against that invoice MUST carry the
// derived non_payable_amount so claimed_amount math reflects what
// the insurer will actually settle. Pre-fix the caller had to compute
// non_payable manually (and usually didn't), so a final cashless
// claim posted `non_payable_amount=0` even when the invoice carried
// ₹X,000 of already-decided non-payable lines. The insurer then
// bounced or partially-approved the claim, and the patient was billed
// for amounts that should have been written off the claim up-front.
//
// Fix: `createClaim` now sums the invoice's non_payable line totals
// and uses that derived value (overriding any caller-supplied
// non_payable_amount). If the lookup fails the caller's value is
// preserved with a warning log.
//
// Asserts:
//   * Invoice with ₹2,500 of non_payable lines → claim's
//     `non_payable_amount` is 2500 (NOT the caller's 0).
//   * Invoice with no non_payable lines + no caller value → 0.
//   * Caller-supplied non_payable_amount is overridden by the
//     invoice-derived value when the invoice has non-payable lines.

import prisma from '../lib/prisma.js';
import * as claims from '../services/insurance/claimsService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'e2222222-3333-4444-8555-cccccccc8801';
const STAMP = String(Date.now() % 100000).padStart(5, '0');

let policyId;
const createdClaimIds = [];
const createdInvoiceIds = [];

async function seedInvoice({ total, idx }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_invoices
       (invoice_number, patient_uid, invoice_type,
        subtotal, total_amount, amount_paid, amount_due, status, tenant_id)
     VALUES ($1, $2::uuid, 'final',
             $3::numeric, $3::numeric, 0, $3::numeric, 'ISSUED', $4::uuid)
     RETURNING id`,
    `INV-D8-${STAMP}-${idx}`, PATIENT_UID, total, TENANT,
  );
  createdInvoiceIds.push(rows[0].id);
  return rows[0].id;
}

async function addInvoiceLine({ invoiceId, lineTotal, tpaDecision }) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO billing_invoice_items
       (invoice_id, service_code, description, quantity, unit_price,
        line_subtotal, line_total, tpa_decision, source_ref_type)
     VALUES ($1::int, 'ROOM', 'Room charge', 1, $2::numeric,
             $2::numeric, $2::numeric, $3, 'package')`,
    invoiceId, lineTotal, tpaDecision,
  );
}

describe('createClaim — invoice non_payable derivation (H D8)', () => {
  beforeAll(async () => {
    // Migration 753 gave createClaim real funding authority: it now
    // serialises on the claim's patient through
    // lockInsuranceFundingPatientTx → resolvePharmacyFundingPatientUidTx,
    // which demands patient_uid resolve to exactly ONE `users` row in this
    // tenant that is role='PATIENT', is_active, status='active', not deleted
    // and not merged. A fabricated uid with no users row is refused with 409
    // PHARMACY_FUNDING_PATIENT_IDENTITY_MISMATCH, so the fixture has to
    // register the patient the way real registration does before it can hang
    // a policy, an invoice and a claim off them.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, status, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Claim Non-Payable Test Patient', 'PATIENT', true, 'active', $3::uuid, NOW())
       ON CONFLICT (uid) DO UPDATE
          SET is_active = true, status = 'active', is_deleted = false,
              merged_into_uid = NULL, updated_at = NOW()`,
      PATIENT_UID,
      `9601${Date.now() % 1000000}`.slice(0, 10),
      TENANT,
    );

    const pol = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_policies
         (patient_uid, policy_number, status, tenant_id)
       VALUES ($1::uuid, $2, 'active', $3::uuid)
       RETURNING id`,
      PATIENT_UID, `POL-D8-${STAMP}`, TENANT,
    );
    policyId = pol[0].id;
  });

  afterAll(async () => {
    for (const id of createdClaimIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM tpa_claims WHERE id = $1::int`, id).catch(() => {});
    }
    for (const id of createdInvoiceIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoice_items WHERE invoice_id = $1::int`, id).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = $1::int`, id).catch(() => {});
    }
    if (policyId) {
      await prisma.$executeRawUnsafe(`DELETE FROM insurance_policies WHERE id = $1::int`, policyId).catch(() => {});
    }
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }, 120_000);

  it('derives non_payable_amount from invoice line tpa_decision=non_payable totals', async () => {
    const invoiceId = await seedInvoice({ total: 100000, idx: 'with-np' });
    // 75000 payable + 25000 non_payable = 100000 total.
    await addInvoiceLine({ invoiceId, lineTotal: 75000, tpaDecision: 'payable' });
    await addInvoiceLine({ invoiceId, lineTotal: 25000, tpaDecision: 'non_payable' });

    const claim = await claims.createClaim({
      tenantId: TENANT, policy_id: policyId, patient_uid: PATIENT_UID,
      invoice_id: invoiceId, claim_type: 'cashless', stage: 'final',
      total_billed: 100000, non_payable_amount: 0, // caller forgot to set it
    });
    createdClaimIds.push(claim.id);
    expect(Number(claim.non_payable_amount)).toBe(25000);
    // claimed_amount derived from billed − copay − non_payable = 75000.
    expect(Number(claim.claimed_amount)).toBe(75000);
  });

  it('overrides a wrong caller-supplied non_payable_amount when invoice has the truth', async () => {
    const invoiceId = await seedInvoice({ total: 50000, idx: 'override' });
    await addInvoiceLine({ invoiceId, lineTotal: 40000, tpaDecision: 'payable' });
    await addInvoiceLine({ invoiceId, lineTotal: 10000, tpaDecision: 'non_payable' });

    const claim = await claims.createClaim({
      tenantId: TENANT, policy_id: policyId, patient_uid: PATIENT_UID,
      invoice_id: invoiceId, claim_type: 'cashless', stage: 'final',
      total_billed: 50000, non_payable_amount: 999, // caller said 999 (wrong)
    });
    createdClaimIds.push(claim.id);
    // Invoice-derived 10000 wins over caller's 999.
    expect(Number(claim.non_payable_amount)).toBe(10000);
  });

  it('keeps non_payable_amount at the caller value when invoice has no non_payable lines', async () => {
    const invoiceId = await seedInvoice({ total: 30000, idx: 'no-np' });
    await addInvoiceLine({ invoiceId, lineTotal: 30000, tpaDecision: 'payable' });

    const claim = await claims.createClaim({
      tenantId: TENANT, policy_id: policyId, patient_uid: PATIENT_UID,
      invoice_id: invoiceId, claim_type: 'cashless', stage: 'final',
      total_billed: 30000, non_payable_amount: 0,
    });
    createdClaimIds.push(claim.id);
    // No non_payable lines → invoice contributes 0 → caller's 0 stays.
    expect(Number(claim.non_payable_amount)).toBe(0);
  });
});
