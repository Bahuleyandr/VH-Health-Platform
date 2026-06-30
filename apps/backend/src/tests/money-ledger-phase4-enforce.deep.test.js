// apps/backend/src/tests/money-ledger-phase4-enforce.deep.test.js
//
// Phase 4 (enforce mode): prove that when a tenant's ledger_authoritative_mode is
// 'enforce', collectPayment posts the ledger entry INSIDE the payment tx (same-tx
// atomic) — the ledger PATIENT_AR / CASH balances move together with the legacy
// billing write, and the PAYMENT entry exists. Real DB, no mocks. Mode is forced
// via the LEDGER_AUTHORITATIVE_MODE env override.
import { randomUUID } from 'node:crypto';
import prisma, { setTenantTx } from '../lib/prisma.js';
import * as billing from '../services/billing/billingV2Service.js';
import { getAccountBalancePaise } from '../services/billing/ledger/ledgerService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const cleanup = { invoiceIds: [], advanceIds: [], refundIds: [], patientUids: [] };
let prevMode;

beforeAll(() => {
  prevMode = process.env.LEDGER_AUTHORITATIVE_MODE;
  process.env.LEDGER_AUTHORITATIVE_MODE = 'enforce';
});

async function makePatient() {
  const uid = randomUUID();
  const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at) VALUES ($1::uuid,$2,'P4 Enforce','PATIENT',$3::uuid,NOW())`,
    uid, phone, TENANT,
  );
  cleanup.patientUids.push(uid);
  return uid;
}
async function makeIssuedInvoice(patientUid, total) {
  const inv = await billing.createDraftInvoice({ patient_uid: patientUid, invoice_type: 'OP', tenantId: TENANT });
  await billing.addInvoiceItem(inv.id, { description: 'Consult', quantity: 1, unit_price: total, gst_rate: 0, tenantId: TENANT });
  await billing.issueInvoice(inv.id, { tenantId: TENANT });
  cleanup.invoiceIds.push(inv.id);
  return inv.id;
}
const bal = (code, dims) => setTenantTx(TENANT, (tx) => getAccountBalancePaise(tx, code, dims));

afterAll(async () => {
  try {
    // Remove the ledger entries this test posted (append-only → audit_bypass);
    // leave ledger_balances intact (see money-ledger-insurance.deep.test.js).
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
      const entryRows = await tx.$queryRawUnsafe(
        `SELECT DISTINCT entry_id AS id FROM ledger_postings
          WHERE invoice_id = ANY($1::int[]) OR patient_uid = ANY($2::uuid[])`,
        cleanup.invoiceIds, cleanup.patientUids,
      );
      const entryIds = entryRows.map((r) => Number(r.id));
      if (entryIds.length) {
        await tx.$executeRawUnsafe(`DELETE FROM ledger_postings WHERE entry_id = ANY($1::bigint[])`, entryIds);
        await tx.$executeRawUnsafe(`DELETE FROM ledger_entries WHERE id = ANY($1::bigint[])`, entryIds);
      }
    });
    if (cleanup.advanceIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_advance_settlements WHERE advance_id = ANY($1::int[])`, cleanup.advanceIds);
    }
    if (cleanup.refundIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_refunds WHERE id = ANY($1::int[])`, cleanup.refundIds);
    }
    if (cleanup.invoiceIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_payments WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoice_items WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = ANY($1::int[])`, cleanup.invoiceIds);
    }
    if (cleanup.advanceIds.length) await prisma.$executeRawUnsafe(`DELETE FROM billing_advances WHERE id = ANY($1::int[])`, cleanup.advanceIds);
    if (cleanup.patientUids.length) await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, cleanup.patientUids);
  } catch { /* best-effort teardown */ }
  if (prevMode === undefined) delete process.env.LEDGER_AUTHORITATIVE_MODE;
  else process.env.LEDGER_AUTHORITATIVE_MODE = prevMode;
  await prisma.$disconnect().catch(() => {});
});

describe('Phase 4 enforce — collectPayment posts the ledger in the same tx', () => {
  it('PATIENT_AR drops, CASH rises, and a PAYMENT entry exists after a real payment', async () => {
    const patient = await makePatient();
    const invoiceId = await makeIssuedInvoice(patient, 1000); // AR 100000
    expect(await bal('PATIENT_AR', { patient_uid: patient, invoice_id: invoiceId })).toBe(100000);

    const payment = await billing.collectPayment({
      invoice_id: invoiceId, amount: 400, mode: 'CASH', shift: 'MORNING', collected_by: patient, tenantId: TENANT,
    });

    // legacy write present
    const payRows = await prisma.$queryRawUnsafe(`SELECT id FROM billing_payments WHERE id = $1::int`, Number(payment.id));
    expect(payRows.length).toBe(1);
    // ledger moved in the SAME tx as the payment
    expect(await bal('PATIENT_AR', { patient_uid: patient, invoice_id: invoiceId })).toBe(60000); // 100000 - 40000
    expect(await bal('CASH')).toBeGreaterThanOrEqual(40000);
    // the PAYMENT entry exists under its idempotency key
    const entry = await prisma.$queryRawUnsafe(`SELECT id FROM ledger_entries WHERE idempotency_key = $1`, `payment-${payment.id}`);
    expect(entry.length).toBe(1);

    // Phase 4-3: the legacy cache columns are now DERIVED from the ledger
    // (amount_due = (PATIENT_AR + INSURANCE_AR)/100), not the Σ(payments) recompute.
    const invRow = await prisma.$queryRawUnsafe(
      `SELECT amount_due, amount_paid, status FROM billing_invoices WHERE id = $1::int`, Number(invoiceId),
    );
    expect(Number(invRow[0].amount_due)).toBe(600);   // ledger PATIENT_AR 60000 paise / 100
    expect(Number(invRow[0].amount_paid)).toBe(400);  // total 1000 - due 600
    expect(invRow[0].status).toBe('PARTIAL');
  });

  it('advance collect + settle: advance balance and invoice due are derived from the ledger', async () => {
    const patient = await makePatient();
    const invoiceId = await makeIssuedInvoice(patient, 1000); // AR 100000

    // collect a ₹500 advance — balance derived from PATIENT_ADVANCE
    const advance = await billing.collectAdvance({ patient_uid: patient, amount: 500, mode: 'CASH', tenantId: TENANT });
    cleanup.advanceIds.push(advance.id);
    expect(await bal('PATIENT_ADVANCE', { advance_id: advance.id, patient_uid: patient })).toBe(50000);
    const advRow1 = await prisma.$queryRawUnsafe(`SELECT balance, status FROM billing_advances WHERE id = $1::int`, Number(advance.id));
    expect(Number(advRow1[0].balance)).toBe(500);

    // settle ₹300 of it against the invoice — both columns derived from the ledger
    await billing.settleAdvance({ tenantId: TENANT, advance_id: advance.id, invoice_id: invoiceId, amount: 300 });
    expect(await bal('PATIENT_ADVANCE', { advance_id: advance.id, patient_uid: patient })).toBe(20000);
    const advRow2 = await prisma.$queryRawUnsafe(`SELECT balance, status FROM billing_advances WHERE id = $1::int`, Number(advance.id));
    expect(Number(advRow2[0].balance)).toBe(200);   // 500 - 300, derived from PATIENT_ADVANCE
    expect(advRow2[0].status).toBe('ACTIVE');        // non-zero balance keeps the current status
    const invRow = await prisma.$queryRawUnsafe(`SELECT amount_due, amount_paid FROM billing_invoices WHERE id = $1::int`, Number(invoiceId));
    expect(Number(invRow[0].amount_due)).toBe(700);  // PATIENT_AR 100000 - 30000 = 70000 → ₹700
    expect(Number(invRow[0].amount_paid)).toBe(300);
  });

  it('refund (invoice): receivable restored at APPROVE (ledger timing), derived into amount_due; payout unchanged', async () => {
    const patient = await makePatient();
    const invoiceId = await makeIssuedInvoice(patient, 1000); // AR 100000
    await billing.collectPayment({ invoice_id: invoiceId, amount: 500, mode: 'CASH', shift: 'MORNING', collected_by: patient, tenantId: TENANT });
    let invRow = await prisma.$queryRawUnsafe(`SELECT amount_due FROM billing_invoices WHERE id = $1::int`, Number(invoiceId));
    expect(Number(invRow[0].amount_due)).toBe(500); // PATIENT_AR 50000 → ₹500

    const refund = await billing.raiseRefund({ patient_uid: patient, invoice_id: invoiceId, amount: 200, reason: 'overpay', mode: 'CASH', tenantId: TENANT });
    cleanup.refundIds.push(refund.id);

    // APPROVE: ledger restores PATIENT_AR (+200) → derived amount_due rises to 700 (ledger timing).
    await billing.approveRefund(refund.id, { tenantId: TENANT });
    expect(await bal('PATIENT_AR', { patient_uid: patient, invoice_id: invoiceId })).toBe(70000);
    invRow = await prisma.$queryRawUnsafe(`SELECT amount_due FROM billing_invoices WHERE id = $1::int`, Number(invoiceId));
    expect(Number(invRow[0].amount_due)).toBe(700);

    // PAYOUT: REFUND_PAID clears REFUNDS_PAYABLE to cash; amount_due unchanged (no double reduction).
    await billing.markRefundPaid(refund.id, { tenantId: TENANT });
    expect(await bal('REFUNDS_PAYABLE', { patient_uid: patient })).toBe(0);
    invRow = await prisma.$queryRawUnsafe(`SELECT amount_due FROM billing_invoices WHERE id = $1::int`, Number(invoiceId));
    expect(Number(invRow[0].amount_due)).toBe(700);
    const refRow = await prisma.$queryRawUnsafe(`SELECT approval_status FROM billing_refunds WHERE id = $1::int`, Number(refund.id));
    expect(refRow[0].approval_status).toBe('PAID');
  });
});
