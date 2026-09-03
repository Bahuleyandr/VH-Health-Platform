// apps/backend/src/tests/money-ledger-advances-reversal.deep.test.js
import { randomUUID } from 'node:crypto';
import prisma, { setTenantTx } from '../lib/prisma.js';
import * as billing from '../services/billing/billingV2Service.js';
import { getAccountBalancePaise } from '../services/billing/ledger/ledgerService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const cleanup = { invoiceIds: [], advanceIds: [], patientUids: [] };

async function makePatient() {
  const uid = randomUUID();
  const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at) VALUES ($1::uuid,$2,'Adv Test','PATIENT',$3::uuid,NOW())`,
    uid, phone, TENANT,
  );
  cleanup.patientUids.push(uid);
  return uid;
}
async function makeDraftInvoice(patientUid, total) {
  const inv = await billing.createDraftInvoice({ patient_uid: patientUid, invoice_type: 'OP', tenantId: TENANT });
  await billing.addInvoiceItem(inv.id, { description: 'Consult', quantity: 1, unit_price: total, gst_rate: 0, tenantId: TENANT });
  cleanup.invoiceIds.push(inv.id);
  return inv.id;
}
const bal = (code, dims) => setTenantTx(TENANT, (tx) => getAccountBalancePaise(tx, TENANT, code, dims));

afterAll(async () => {
  try {
    if (cleanup.invoiceIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_advance_settlements WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_payments WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoice_items WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = ANY($1::int[])`, cleanup.invoiceIds);
    }
    if (cleanup.advanceIds.length) await prisma.$executeRawUnsafe(`DELETE FROM billing_advances WHERE id = ANY($1::int[])`, cleanup.advanceIds);
    if (cleanup.patientUids.length) await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, cleanup.patientUids);
  } catch { /* best-effort */ }
  await prisma.$disconnect().catch(() => {});
});

describe('Phase 3a — advances + reversal', () => {
  it('collectAdvance credits PATIENT_ADVANCE; settleAdvance moves it to PATIENT_AR', async () => {
    const patient = await makePatient();
    const invoiceId = await makeDraftInvoice(patient, 1000);
    await billing.issueInvoice(invoiceId, { tenantId: TENANT }); // AR = 100000

    const adv = await billing.collectAdvance({ patient_uid: patient, amount: 1000, mode: 'CASH', tenantId: TENANT });
    cleanup.advanceIds.push(adv.id);
    expect(await bal('PATIENT_ADVANCE', { advance_id: adv.id })).toBe(100000); // liability +₹1000

    await billing.settleAdvance({ tenantId: TENANT, advance_id: adv.id, invoice_id: invoiceId, amount: 400 });
    expect(await bal('PATIENT_ADVANCE', { advance_id: adv.id })).toBe(60000); // ₹600 left
    expect(await bal('PATIENT_AR', { patient_uid: patient, invoice_id: invoiceId })).toBe(60000); // AR 100000-40000
  });

  it('reversePayment restores PATIENT_AR (credits CASH back)', async () => {
    const patient = await makePatient();
    const invoiceId = await makeDraftInvoice(patient, 500);
    await billing.issueInvoice(invoiceId, { tenantId: TENANT }); // AR 50000
    const pay = await billing.collectPayment({ invoice_id: invoiceId, amount: 200, mode: 'CASH', shift: 'MORNING', collected_by: patient, tenantId: TENANT });
    expect(await bal('PATIENT_AR', { patient_uid: patient, invoice_id: invoiceId })).toBe(30000); // 50000-20000

    await billing.reversePayment(pay.id, { reversed_by: patient, reason: 'test reversal', tenantId: TENANT });
    expect(await bal('PATIENT_AR', { patient_uid: patient, invoice_id: invoiceId })).toBe(50000); // restored
  });
});
