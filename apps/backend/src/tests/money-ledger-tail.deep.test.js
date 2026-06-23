// apps/backend/src/tests/money-ledger-tail.deep.test.js
//
// Ledger movement-completeness tail: (1) markPaymentLinkPaid (collectPayment via
// a caller-owned tx) posts a BANK payment; (2) reversing an INSURANCE settlement
// restores INSURANCE_AR.
import { randomUUID } from 'node:crypto';
import prisma, { setTenantTx } from '../lib/prisma.js';
import * as billing from '../services/billing/billingV2Service.js';
import * as claims from '../services/insurance/claimsService.js';
import { createPaymentLink, markPaymentLinkPaid } from '../services/billing/paymentLinkService.js';
import { getAccountBalancePaise } from '../services/billing/ledger/ledgerService.js';

// createPaymentLink builds a UPI-intent URL and requires these.
process.env.HOSPITAL_UPI_VPA = process.env.HOSPITAL_UPI_VPA || 'test@upi';
process.env.HOSPITAL_NAME = process.env.HOSPITAL_NAME || 'Test Hospital';

const TENANT = '00000000-0000-4000-8000-000000000001';
const cleanup = { invoiceIds: [], claimIds: [], preauthIds: [], policyIds: [], patientUids: [] };

async function makePatient() {
  const uid = randomUUID();
  const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at) VALUES ($1::uuid,$2,'Tail Test','PATIENT',$3::uuid,NOW())`,
    uid, phone, TENANT,
  );
  cleanup.patientUids.push(uid);
  return uid;
}
async function makeIssuedInvoice(patientUid, total) {
  const inv = await billing.createDraftInvoice({ patient_uid: patientUid, invoice_type: 'OP', tenantId: TENANT });
  await billing.addInvoiceItem(inv.id, { description: 'Svc', quantity: 1, unit_price: total, gst_rate: 0, tenantId: TENANT });
  await billing.issueInvoice(inv.id, { tenantId: TENANT });
  cleanup.invoiceIds.push(inv.id);
  return inv.id;
}
async function makePolicy(p) {
  const r = await prisma.$queryRawUnsafe(`INSERT INTO insurance_policies (patient_uid, policy_number) VALUES ($1::uuid,$2) RETURNING id`, p, `POL-${Math.floor(Math.random() * 1e9)}`);
  cleanup.policyIds.push(r[0].id); return r[0].id;
}
async function makePreauth(p, pol) {
  const r = await prisma.$queryRawUnsafe(`INSERT INTO insurance_preauth (policy_id, patient_uid, preauth_number, primary_diagnosis, expected_cost) VALUES ($1::int,$2::uuid,$3,'dx',1000) RETURNING id`, pol, p, `PA-${Math.floor(Math.random() * 1e9)}`);
  cleanup.preauthIds.push(r[0].id); return r[0].id;
}
async function makeSubmittedClaim(p, pol, pre, inv, claimed) {
  const r = await prisma.$queryRawUnsafe(
    `INSERT INTO tpa_claims (claim_number, policy_id, preauth_id, patient_uid, invoice_id, total_billed, claimed_amount, claim_type, status, tenant_id)
     VALUES ($1,$2::int,$3::int,$4::uuid,$5::int,$6::numeric,$6::numeric,'cashless','submitted',$7::uuid) RETURNING id`,
    `CLM-${Math.floor(Math.random() * 1e9)}`, pol, pre, p, inv, claimed, TENANT,
  );
  cleanup.claimIds.push(r[0].id); return r[0].id;
}
const bal = (code, dims) => setTenantTx(TENANT, (tx) => getAccountBalancePaise(tx, code, dims));

afterAll(async () => {
  try {
    if (cleanup.claimIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM tpa_claim_correspondence WHERE claim_id = ANY($1::int[])`, cleanup.claimIds).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM tpa_claims WHERE id = ANY($1::int[])`, cleanup.claimIds);
    }
    if (cleanup.preauthIds.length) await prisma.$executeRawUnsafe(`DELETE FROM insurance_preauth WHERE id = ANY($1::int[])`, cleanup.preauthIds);
    if (cleanup.invoiceIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_payment_links WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM billing_payments WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoice_items WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = ANY($1::int[])`, cleanup.invoiceIds);
    }
    if (cleanup.policyIds.length) await prisma.$executeRawUnsafe(`DELETE FROM insurance_policies WHERE id = ANY($1::int[])`, cleanup.policyIds);
    if (cleanup.patientUids.length) await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, cleanup.patientUids);
  } catch { /* best-effort */ }
  await prisma.$disconnect().catch(() => {});
});

describe('Ledger tail — movement completeness', () => {
  it('markPaymentLinkPaid posts a BANK payment crediting PATIENT_AR', async () => {
    const patient = await makePatient();
    const invoiceId = await makeIssuedInvoice(patient, 1000); // AR 100000
    const link = await createPaymentLink({ tenantId: TENANT, invoice_id: invoiceId, patient_uid: patient, amount: 300 });
    await markPaymentLinkPaid({ tenantId: TENANT, link_token: link.link_token, paid_via: 'upi', paid_reference: `UPI-${randomUUID()}` });

    expect(await bal('PATIENT_AR', { patient_uid: patient, invoice_id: invoiceId })).toBe(70000); // 100000 - 30000
    expect(await bal('BANK')).toBeGreaterThanOrEqual(30000);
  });

  it('reversing an INSURANCE settlement restores INSURANCE_AR', async () => {
    const patient = await makePatient();
    const invoiceId = await makeIssuedInvoice(patient, 1000); // AR 100000
    const policyId = await makePolicy(patient);
    const preauthId = await makePreauth(patient, policyId);
    const claimId = await makeSubmittedClaim(patient, policyId, preauthId, invoiceId, 1000);

    await claims.recordClaimDecision({ tenantId: TENANT, id: claimId, decision: 'approved', approved_amount: 800 });
    const pay = await billing.collectPayment({ invoice_id: invoiceId, patient_uid: patient, amount: 800, mode: 'INSURANCE', tenantId: TENANT });
    expect(await bal('INSURANCE_AR', { invoice_id: invoiceId })).toBe(0); // settled

    await billing.reversePayment(pay.id, { reversed_by: patient, reason: 'insurer clawback', tenantId: TENANT });
    expect(await bal('INSURANCE_AR', { invoice_id: invoiceId })).toBe(80000); // insurer debt restored
  });
});
