// apps/backend/src/tests/money-ledger-reports.deep.test.js
import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import * as billing from '../services/billing/billingV2Service.js';
import {
  trialBalance, arAging, insurerAging, cashPosition, dailyCollection,
} from '../services/billing/ledger/ledgerReportsService.js';
import { assertData } from './helpers/assertSchema.js';

// Own, distinct tenant so this suite's derived-id ledger idempotency keys
// (issue-inv-*, payment-*) live under a unique (tenant_id, idempotency_key)
// space, and the RLS-scoped GL reports (trialBalance/arAging/cashPosition/…)
// read ONLY this suite's ledger rows — no cross-suite collision or bleed when
// the three money-ledger deep suites share one DB in the same CI chunk.
const TENANT = '00000000-0000-4000-8000-0000000003a2';
const cleanup = { invoiceIds: [], patientUids: [] };

beforeAll(async () => {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'ledger-reports-tenant', 'Ledger Reports Test') ON CONFLICT (id) DO NOTHING`,
    TENANT,
  );
});

async function makePatient() {
  const uid = randomUUID();
  const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at) VALUES ($1::uuid,$2,'Rpt Test','PATIENT',$3::uuid,NOW())`,
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

afterAll(async () => {
  try {
    if (cleanup.invoiceIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_payments WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoice_items WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = ANY($1::int[])`, cleanup.invoiceIds);
    }
    if (cleanup.patientUids.length) await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, cleanup.patientUids);
  } catch { /* best-effort */ }
  await prisma.$disconnect().catch(() => {});
});

describe('Phase 5a — GL report functions', () => {
  it('trialBalance returns per-account balances and is balanced (signed total 0)', async () => {
    const patient = await makePatient();
    await makeIssuedInvoice(patient, 1000); // posts AR + REVENUE
    const tb = await trialBalance(TENANT);
    assertData('TrialBalance', tb);
    expect(tb.balanced).toBe(true);
    expect(tb.signedTotalPaise).toBe(0);
    const ar = tb.accounts.find((a) => a.code === 'PATIENT_AR');
    expect(ar).toBeDefined();
    expect(ar.balancePaise).toBeGreaterThanOrEqual(100000);
  });

  it('arAging buckets outstanding PATIENT_AR by invoice age (fresh invoice in 0-30)', async () => {
    const patient = await makePatient();
    const invId = await makeIssuedInvoice(patient, 500); // AR 50000, issued now
    const aging = await arAging(TENANT);
    assertData('AgingReport', aging);
    const b = aging.buckets.find((x) => x.bucket === '0-30');
    expect(b).toBeDefined();
    expect(b.totalPaise).toBeGreaterThanOrEqual(50000);
    expect(aging.grandTotalPaise).toBeGreaterThanOrEqual(50000);
    expect(aging.buckets.find((x) => x.bucket === '90+').totalPaise).toBeGreaterThanOrEqual(0);
    expect(invId).toBeGreaterThan(0);
  });

  it('cashPosition returns CASH and BANK totals; collecting cash increases CASH', async () => {
    const patient = await makePatient();
    const invId = await makeIssuedInvoice(patient, 400);
    await billing.collectPayment({ invoice_id: invId, amount: 400, mode: 'CASH', shift: 'MORNING', collected_by: patient, tenantId: TENANT });
    const cp = await cashPosition(TENANT);
    assertData('CashPosition', cp);
    expect(cp.cashTotalPaise).toBeGreaterThanOrEqual(40000);
    expect(typeof cp.bankTotalPaise).toBe('number');
  });

  it('dailyCollection sums CASH/BANK receipts by day for today', async () => {
    const patient = await makePatient();
    const invId = await makeIssuedInvoice(patient, 600);
    await billing.collectPayment({ invoice_id: invId, amount: 600, mode: 'CASH', shift: 'MORNING', collected_by: patient, tenantId: TENANT });
    const today = (await prisma.$queryRawUnsafe(`SELECT CURRENT_DATE::text AS d`))[0].d;
    const dc = await dailyCollection(TENANT, { from: today, to: today });
    assertData('DailyCollection', dc);
    const row = dc.days.find((d) => d.day === today);
    expect(row).toBeDefined();
    expect(row.collectedPaise).toBeGreaterThanOrEqual(60000);
  });

  it('insurerAging returns the four buckets (empty-safe)', async () => {
    const aging = await insurerAging(TENANT);
    assertData('AgingReport', aging);
    expect(aging.buckets.map((b) => b.bucket)).toEqual(['0-30', '31-60', '61-90', '90+']);
    expect(typeof aging.grandTotalPaise).toBe('number');
  });
});
