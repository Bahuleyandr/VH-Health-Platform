// apps/backend/src/tests/money-ledger-tax-refunds.deep.test.js
import { randomUUID } from 'node:crypto';
import prisma, { setTenantTx } from '../lib/prisma.js';
import * as billing from '../services/billing/billingV2Service.js';
import { getAccountBalancePaise } from '../services/billing/ledger/ledgerService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const cleanup = { invoiceIds: [], userUids: [] };

async function makeUser(role = 'PATIENT', name = 'Tax Refund Test') {
  const uid = randomUUID();
  const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5::uuid, NOW())`,
    uid, phone, name, role, TENANT,
  );
  cleanup.userUids.push(uid);
  return uid;
}
const makePatient = () => makeUser();
async function makeDraftInvoice(patientUid, unitPrice, gstRate) {
  const inv = await billing.createDraftInvoice({ patient_uid: patientUid, invoice_type: 'OP', tenantId: TENANT });
  await billing.addInvoiceItem(inv.id, { description: 'Consult', quantity: 1, unit_price: unitPrice, gst_rate: gstRate, tenantId: TENANT });
  cleanup.invoiceIds.push(inv.id);
  return inv.id;
}
const bal = (code, dims) => setTenantTx(TENANT, (tx) => getAccountBalancePaise(tx, code, dims));

afterAll(async () => {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
      const entryRows = await tx.$queryRawUnsafe(
        `SELECT DISTINCT entry_id AS id FROM ledger_postings
          WHERE invoice_id = ANY($1::int[]) OR patient_uid = ANY($2::uuid[])`,
        cleanup.invoiceIds,
        cleanup.userUids,
      );
      const entryIds = entryRows.map((row) => Number(row.id));
      if (entryIds.length) {
        await tx.$executeRawUnsafe(`DELETE FROM ledger_postings WHERE entry_id = ANY($1::bigint[])`, entryIds);
        await tx.$executeRawUnsafe(`DELETE FROM ledger_entries WHERE id = ANY($1::bigint[])`, entryIds);
      }
      if (cleanup.invoiceIds.length) {
        await tx.$executeRawUnsafe(`DELETE FROM billing_refunds WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      }
    });
    if (cleanup.invoiceIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_payments WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoice_items WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = ANY($1::int[])`, cleanup.invoiceIds);
    }
    if (cleanup.userUids.length) await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, cleanup.userUids);
  } catch { /* best-effort */ }
  await prisma.$disconnect().catch(() => {});
});

describe('Phase 3b — tax split + refunds', () => {
  it('issueInvoice with GST splits REVENUE and TAX_PAYABLE', async () => {
    const patient = await makePatient();
    const invoiceId = await makeDraftInvoice(patient, 1000, 18); // 1000 + 18% = 1180
    await billing.issueInvoice(invoiceId, { tenantId: TENANT });

    // AR = total (118000); REVENUE = 100000; TAX_PAYABLE = 18000
    expect(await bal('PATIENT_AR', { patient_uid: patient, invoice_id: invoiceId })).toBe(118000);
    // REVENUE/TAX are credit-normal: normal-direction balance is positive.
    const rev = await bal('REVENUE');
    const tax = await bal('TAX_PAYABLE');
    expect(rev).toBeGreaterThanOrEqual(100000);
    expect(tax).toBeGreaterThanOrEqual(18000);
  });

  it('refund lifecycle: approve credits REFUNDS_PAYABLE, pay clears it; AR restored', async () => {
    const patient = await makePatient();
    const approver = await makeUser('ADMIN', 'Tax Refund Approver');
    const payoutActor = await makeUser('CASHIER', 'Tax Refund Payout');
    const invoiceId = await makeDraftInvoice(patient, 500, 0); // 500, no tax
    await billing.issueInvoice(invoiceId, { tenantId: TENANT }); // AR 50000
    await billing.collectPayment({ invoice_id: invoiceId, amount: 500, mode: 'CASH', shift: 'MORNING', collected_by: patient, tenantId: TENANT });
    expect(await bal('PATIENT_AR', { patient_uid: patient, invoice_id: invoiceId })).toBe(0); // paid off

    const refund = await billing.raiseRefund({ patient_uid: patient, invoice_id: invoiceId, amount: 200, reason: 'overpay', mode: 'CHEQUE', tenantId: TENANT });
    const rpBefore = await bal('REFUNDS_PAYABLE', { patient_uid: patient });
    await billing.approveRefund(refund.id, { approved_by: approver, tenantId: TENANT });
    // approve: REFUNDS_PAYABLE +20000, PATIENT_AR restored to 20000
    expect(await bal('REFUNDS_PAYABLE', { patient_uid: patient })).toBe(rpBefore + 20000);
    expect(await bal('PATIENT_AR', { patient_uid: patient, invoice_id: invoiceId })).toBe(20000);

    await billing.markRefundPaid(refund.id, {
      paid_by: payoutActor,
      reference: `TAX-REFUND-${randomUUID()}`,
      tenantId: TENANT,
    });
    // pay: REFUNDS_PAYABLE back to its pre-approve level (liability cleared)
    expect(await bal('REFUNDS_PAYABLE', { patient_uid: patient })).toBe(rpBefore);
  });
});
