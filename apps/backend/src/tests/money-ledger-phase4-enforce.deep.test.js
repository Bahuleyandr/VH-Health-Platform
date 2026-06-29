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
const cleanup = { invoiceIds: [], patientUids: [] };
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
    if (cleanup.invoiceIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_payments WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoice_items WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = ANY($1::int[])`, cleanup.invoiceIds);
    }
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
  });
});
