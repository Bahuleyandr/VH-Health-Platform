// apps/backend/src/tests/money-ledger-cutover-reconcile.deep.test.js
import { randomUUID } from 'node:crypto';
import prisma, { setTenantTx } from '../lib/prisma.js';
import { getAccountBalancePaise } from '../services/billing/ledger/ledgerService.js';
import { applyArOpeningBalances, reconcileLedger } from '../services/billing/ledger/ledgerReconciliation.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const cleanup = { invoiceIds: [], patientUids: [] };

async function makePatient() {
  const uid = randomUUID();
  const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at) VALUES ($1::uuid,$2,'Recon Test','PATIENT',$3::uuid,NOW())`,
    uid, phone, TENANT,
  );
  cleanup.patientUids.push(uid);
  return uid;
}

// A pre-existing ISSUED invoice with a known amount_due, created directly (it
// has NO ledger AR — simulating an invoice from before Phase 2a).
async function makeIssuedInvoice(patientUid, total, due) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_invoices
       (patient_uid, invoice_type, status, subtotal, total_amount, amount_paid, amount_due, tenant_id, issued_at, invoice_number)
     VALUES ($1::uuid,'OP','ISSUED',$2::numeric,$2::numeric,$3::numeric,$4::numeric,$5::uuid,NOW(),$6)
     RETURNING id`,
    patientUid, total, (total - due), due, TENANT, `RC-${Math.floor(Math.random() * 1e9)}`,
  );
  cleanup.invoiceIds.push(rows[0].id);
  return rows[0].id;
}

afterAll(async () => {
  try {
    if (cleanup.invoiceIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = ANY($1::int[])`, cleanup.invoiceIds);
    }
    if (cleanup.patientUids.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, cleanup.patientUids);
    }
  } catch { /* best-effort */ }
  await prisma.$disconnect().catch(() => {});
});

describe('Phase 2b — cutover + reconciliation', () => {
  it('cutover seeds opening AR = amount_due for a pre-existing outstanding invoice, idempotently', async () => {
    const patient = await makePatient();
    const invoiceId = await makeIssuedInvoice(patient, 1000, 600); // total 1000, due 600

    const first = await applyArOpeningBalances(TENANT);
    expect(first.seeded).toBeGreaterThanOrEqual(1);
    const arPaise = await setTenantTx(TENANT, (tx) => getAccountBalancePaise(tx, 'PATIENT_AR', { invoice_id: invoiceId }));
    expect(arPaise).toBe(60000); // ₹600.00 opening receivable

    // re-run is a no-op (idempotency key opening-ar-<id>) — AR unchanged
    await applyArOpeningBalances(TENANT);
    const arPaise2 = await setTenantTx(TENANT, (tx) => getAccountBalancePaise(tx, 'PATIENT_AR', { invoice_id: invoiceId }));
    expect(arPaise2).toBe(60000);
  });

  it('reconcileLedger reports a seeded invoice as matched (not a mismatch / not unwired)', async () => {
    const patient = await makePatient();
    const invoiceId = await makeIssuedInvoice(patient, 500, 500);
    await applyArOpeningBalances(TENANT);

    const recon = await reconcileLedger(TENANT);
    expect(recon.mismatches.find((m) => m.invoiceId === invoiceId)).toBeUndefined();
    expect(recon.unwired.find((u) => u.invoiceId === invoiceId)).toBeUndefined();
    // ledger stays balanced overall
    expect(recon.trialBalancePaise).toBe(0);
  });

  it('reconcileLedger flags an outstanding invoice that has no ledger AR as unwired', async () => {
    const patient = await makePatient();
    const invoiceId = await makeIssuedInvoice(patient, 700, 700);
    // deliberately DO NOT run the cutover for this one
    const recon = await reconcileLedger(TENANT);
    expect(recon.unwired.find((u) => u.invoiceId === invoiceId)).toMatchObject({ expectedPaise: 70000 });
  });
});
