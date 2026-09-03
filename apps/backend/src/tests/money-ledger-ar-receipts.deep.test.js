// apps/backend/src/tests/money-ledger-ar-receipts.deep.test.js
//
// Phase 2a: prove issueInvoice + collectPayment post-commit ledger entries that
// mirror the legacy billing_invoices AR. Real DB (no mocks).
import { randomUUID } from 'node:crypto';
import prisma, { setTenantTx } from '../lib/prisma.js';
import * as billing from '../services/billing/billingV2Service.js';
import { getAccountBalancePaise } from '../services/billing/ledger/ledgerService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const cleanup = { invoiceIds: [], patientUids: [] };

async function makePatient() {
  const uid = randomUUID();
  const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at) VALUES ($1::uuid,$2,'Ledger AR Test','PATIENT',$3::uuid,NOW())`,
    uid, phone, TENANT,
  );
  cleanup.patientUids.push(uid);
  return uid;
}

// Create a DRAFT invoice with one item so issueInvoice can transition it.
async function makeDraftInvoice(patientUid, total) {
  const inv = await billing.createDraftInvoice({ patient_uid: patientUid, invoice_type: 'OP', tenantId: TENANT });
  await billing.addInvoiceItem(inv.id, { description: 'Consult', quantity: 1, unit_price: total, gst_rate: 0, tenantId: TENANT });
  cleanup.invoiceIds.push(inv.id);
  return inv.id;
}

afterAll(async () => {
  try {
    if (cleanup.invoiceIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_payments WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoice_items WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = ANY($1::int[])`, cleanup.invoiceIds);
    }
    if (cleanup.patientUids.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, cleanup.patientUids);
    }
  } catch { /* best-effort teardown */ }
  await prisma.$disconnect().catch(() => {});
});

const arBalance = (invoiceId, patientUid) =>
  setTenantTx(TENANT, (tx) => getAccountBalancePaise(tx, TENANT, 'PATIENT_AR', { patient_uid: patientUid, invoice_id: invoiceId }));

describe('Phase 2a — ledger mirrors legacy AR', () => {
  it('issueInvoice posts AR; collectPayment reduces it; ledger == legacy amount_due', async () => {
    const patient = await makePatient();
    const invoiceId = await makeDraftInvoice(patient, 1000); // ₹1000

    await billing.issueInvoice(invoiceId, { tenantId: TENANT });
    // ledger AR for this invoice = 100000 paise (debit)
    expect(await arBalance(invoiceId, patient)).toBe(100000);

    // pay ₹400 cash
    await billing.collectPayment({
      invoice_id: invoiceId, amount: 400, mode: 'CASH', shift: 'MORNING', collected_by: patient, tenantId: TENANT,
    });
    expect(await arBalance(invoiceId, patient)).toBe(60000); // 100000 - 40000

    // ledger CASH debit increased by at least this payment
    const cash = await setTenantTx(TENANT, (tx) => getAccountBalancePaise(tx, TENANT, 'CASH'));
    expect(cash).toBeGreaterThanOrEqual(40000);

    // ledger AR (60000 paise = ₹600.00) matches the legacy invoice amount_due
    const inv = await prisma.$queryRawUnsafe(`SELECT amount_due FROM billing_invoices WHERE id=$1::int`, invoiceId);
    expect(Math.round(Number(inv[0].amount_due) * 100)).toBe(60000);
  });
});
