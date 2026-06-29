// apps/backend/src/tests/money-ledger-phase4-atomicity.deep.test.js
//
// Phase 4 atomicity: with the ledger post forced to FAIL, the per-tenant mode
// controls whether the money write survives.
//   - enforce: the ledger post runs INSIDE the payment tx, so its failure rolls
//     back the whole payment (no billing_payments row).
//   - shadow:  the ledger post runs post-commit best-effort, so its failure is
//     swallowed and the payment persists (= today's behavior).
// Real DB for the billing writes; only ledgerService.postLedgerEntry is mocked
// (to throw), which the posting wrappers call transitively.
import { jest } from '@jest/globals';

const postLedgerEntry = jest.fn(async () => { throw new Error('injected ledger failure'); });
const getAccountBalancePaise = jest.fn(async () => 0);
jest.unstable_mockModule('../services/billing/ledger/ledgerService.js', () => ({
  postLedgerEntry,
  getAccountBalancePaise,
  default: { postLedgerEntry, getAccountBalancePaise },
}));

const { randomUUID } = await import('node:crypto');
const prismaMod = await import('../lib/prisma.js');
const prisma = prismaMod.default;
const billing = await import('../services/billing/billingV2Service.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const cleanup = { invoiceIds: [], patientUids: [] };
let prevMode;

beforeEach(() => { prevMode = process.env.LEDGER_AUTHORITATIVE_MODE; });
afterEach(() => {
  if (prevMode === undefined) delete process.env.LEDGER_AUTHORITATIVE_MODE;
  else process.env.LEDGER_AUTHORITATIVE_MODE = prevMode;
});

async function makePatient() {
  const uid = randomUUID();
  const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at) VALUES ($1::uuid,$2,'P4 Atomicity','PATIENT',$3::uuid,NOW())`,
    uid, phone, TENANT,
  );
  cleanup.patientUids.push(uid);
  return uid;
}
async function makeIssuedInvoice(patientUid, total) {
  const inv = await billing.createDraftInvoice({ patient_uid: patientUid, invoice_type: 'OP', tenantId: TENANT });
  await billing.addInvoiceItem(inv.id, { description: 'Consult', quantity: 1, unit_price: total, gst_rate: 0, tenantId: TENANT });
  await billing.issueInvoice(inv.id, { tenantId: TENANT }); // ledger post here is mocked-throw → swallowed (post-commit), invoice still issues
  cleanup.invoiceIds.push(inv.id);
  return inv.id;
}
const paymentCount = (invoiceId) =>
  prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM billing_payments WHERE invoice_id = $1::int`, Number(invoiceId)).then((r) => r[0].n);

afterAll(async () => {
  try {
    if (cleanup.invoiceIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_payments WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoice_items WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = ANY($1::int[])`, cleanup.invoiceIds);
    }
    if (cleanup.patientUids.length) await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, cleanup.patientUids);
  } catch { /* best-effort teardown */ }
  await prisma.$disconnect().catch(() => {});
});

describe('Phase 4 atomicity — failing ledger post handled by mode', () => {
  it('enforce: a failing ledger post ROLLS BACK the payment (no billing_payments row)', async () => {
    process.env.LEDGER_AUTHORITATIVE_MODE = 'enforce';
    const patient = await makePatient();
    const invoiceId = await makeIssuedInvoice(patient, 1000);
    await expect(billing.collectPayment({
      invoice_id: invoiceId, amount: 400, mode: 'CASH', shift: 'MORNING', collected_by: patient, tenantId: TENANT,
    })).rejects.toThrow();
    expect(await paymentCount(invoiceId)).toBe(0); // rolled back with the failed ledger post
  });

  it('shadow: a failing ledger post is SWALLOWED; the payment persists', async () => {
    process.env.LEDGER_AUTHORITATIVE_MODE = 'shadow';
    const patient = await makePatient();
    const invoiceId = await makeIssuedInvoice(patient, 1000);
    const payment = await billing.collectPayment({
      invoice_id: invoiceId, amount: 400, mode: 'CASH', shift: 'MORNING', collected_by: patient, tenantId: TENANT,
    });
    expect(payment?.id).toBeTruthy();
    expect(await paymentCount(invoiceId)).toBe(1); // committed despite the ledger failure
  });
});
