// apps/backend/src/tests/money-ledger-insurance.deep.test.js
import { randomUUID } from 'node:crypto';
import prisma, { setTenantTx } from '../lib/prisma.js';
import * as billing from '../services/billing/billingV2Service.js';
import * as claims from '../services/insurance/claimsService.js';
import { getAccountBalancePaise } from '../services/billing/ledger/ledgerService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const cleanup = { invoiceIds: [], claimIds: [], preauthIds: [], policyIds: [], patientUids: [] };

async function makePatient() {
  const uid = randomUUID();
  const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at) VALUES ($1::uuid,$2,'Ins Test','PATIENT',$3::uuid,NOW())`,
    uid, phone, TENANT,
  );
  cleanup.patientUids.push(uid);
  return uid;
}
async function makeIssuedInvoice(patientUid, total) {
  const inv = await billing.createDraftInvoice({ patient_uid: patientUid, invoice_type: 'OP', tenantId: TENANT });
  await billing.addInvoiceItem(inv.id, { description: 'Procedure', quantity: 1, unit_price: total, gst_rate: 0, tenantId: TENANT });
  await billing.issueInvoice(inv.id, { tenantId: TENANT });
  cleanup.invoiceIds.push(inv.id);
  return inv.id;
}
async function makePolicy(patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO insurance_policies (patient_uid, policy_number) VALUES ($1::uuid, $2) RETURNING id`,
    patientUid, `POL-${Math.floor(Math.random() * 1e9)}`,
  );
  cleanup.policyIds.push(rows[0].id);
  return rows[0].id;
}
async function makePreauth(patientUid, policyId) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO insurance_preauth (policy_id, patient_uid, preauth_number, primary_diagnosis, expected_cost)
     VALUES ($1::int, $2::uuid, $3, 'Test dx', 1000) RETURNING id`,
    policyId, patientUid, `PA-${Math.floor(Math.random() * 1e9)}`,
  );
  cleanup.preauthIds.push(rows[0].id);
  return rows[0].id;
}
async function makeSubmittedClaim(patientUid, policyId, preauthId, invoiceId, claimed) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO tpa_claims (claim_number, policy_id, preauth_id, patient_uid, invoice_id, total_billed, claimed_amount, claim_type, status, tenant_id)
     VALUES ($1, $2::int, $3::int, $4::uuid, $5::int, $6::numeric, $6::numeric, 'cashless', 'submitted', $7::uuid)
     RETURNING id`,
    `CLM-${Math.floor(Math.random() * 1e9)}`, policyId, preauthId, patientUid, invoiceId, claimed, TENANT,
  );
  cleanup.claimIds.push(rows[0].id);
  return rows[0].id;
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
      await prisma.$executeRawUnsafe(`DELETE FROM billing_payments WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoice_items WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = ANY($1::int[])`, cleanup.invoiceIds);
    }
    if (cleanup.policyIds.length) await prisma.$executeRawUnsafe(`DELETE FROM insurance_policies WHERE id = ANY($1::int[])`, cleanup.policyIds);
    if (cleanup.patientUids.length) await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, cleanup.patientUids);
  } catch { /* best-effort */ }
  await prisma.$disconnect().catch(() => {});
});

describe('Phase 3c — insurance two-step', () => {
  it('approve shifts AR→INSURANCE_AR; insurer payment clears INSURANCE_AR', async () => {
    const patient = await makePatient();
    const invoiceId = await makeIssuedInvoice(patient, 1000);   // AR 100000
    const policyId = await makePolicy(patient);
    const preauthId = await makePreauth(patient, policyId);
    const claimId = await makeSubmittedClaim(patient, policyId, preauthId, invoiceId, 1000);

    // insurer approves ₹800 of the ₹1000 bill
    await claims.recordClaimDecision({ tenantId: TENANT, id: claimId, decision: 'approved', approved_amount: 800 });
    expect(await bal('INSURANCE_AR', { invoice_id: invoiceId })).toBe(80000); // insurer owes 800
    expect(await bal('PATIENT_AR', { patient_uid: patient, invoice_id: invoiceId })).toBe(20000); // patient owes the rest

    // insurer pays the ₹800 against the invoice
    await billing.collectPayment({ invoice_id: invoiceId, patient_uid: patient, amount: 800, mode: 'INSURANCE', tenantId: TENANT });
    expect(await bal('INSURANCE_AR', { invoice_id: invoiceId })).toBe(0);     // insurer debt cleared
    expect(await bal('PATIENT_AR', { patient_uid: patient, invoice_id: invoiceId })).toBe(20000); // unchanged (not double-credited)
    expect(await bal('BANK')).toBeGreaterThanOrEqual(80000);
  });
});
