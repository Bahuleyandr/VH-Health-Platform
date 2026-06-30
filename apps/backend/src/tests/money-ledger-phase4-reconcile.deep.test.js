// apps/backend/src/tests/money-ledger-phase4-reconcile.deep.test.js
//
// Phase 4-4: reconcileLedger drift handling is MODE-SCOPED. Under 'enforce' the
// ledger is authoritative, so any drift is a financial-integrity incident → a
// HARD ALERT (Sentry fatal + the ledger_reconciliation_drift_total metric). Under
// 'shadow'/'off' it stays an informational log (the strangler default). Real DB
// for the billing rows; only Sentry and the drift metric are mocked (to observe).
import { jest } from '@jest/globals';

const captureException = jest.fn();
jest.unstable_mockModule('../utils/sentry.js', () => ({ default: { captureException }, captureException }));
const recordLedgerReconciliationDrift = jest.fn();
jest.unstable_mockModule('../observability/reliabilityMetrics.js', () => ({ recordLedgerReconciliationDrift }));

const { randomUUID } = await import('node:crypto');
const prismaMod = await import('../lib/prisma.js');
const prisma = prismaMod.default;
const { reconcileLedger, persistReconciliationCheck } = await import('../services/billing/ledger/ledgerReconciliation.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const cleanup = { invoiceIds: [], patientUids: [] };

async function makePatient() {
  const uid = randomUUID();
  const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at) VALUES ($1::uuid,$2,'P4 Recon','PATIENT',$3::uuid,NOW())`,
    uid, phone, TENANT,
  );
  cleanup.patientUids.push(uid);
  return uid;
}
// An ISSUED invoice with amount_due but NO ledger entry → reconcile flags 'unwired' (drift).
async function makeUnwiredInvoice(patientUid, due) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_invoices
       (patient_uid, invoice_type, status, subtotal, total_amount, amount_paid, amount_due, tenant_id, issued_at, invoice_number)
     VALUES ($1::uuid,'OP','ISSUED',$2::numeric,$2::numeric,0,$2::numeric,$3::uuid,NOW(),$4)
     RETURNING id`,
    patientUid, due, TENANT, `RCA-${Math.floor(Math.random() * 1e9)}`,
  );
  cleanup.invoiceIds.push(rows[0].id);
  return rows[0].id;
}

afterEach(() => { captureException.mockClear(); recordLedgerReconciliationDrift.mockClear(); });

afterAll(async () => {
  try {
    if (cleanup.invoiceIds.length) await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = ANY($1::int[])`, cleanup.invoiceIds);
    if (cleanup.patientUids.length) await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, cleanup.patientUids);
  } catch { /* best-effort */ }
  await prisma.$disconnect().catch(() => {});
});

describe('Phase 4-4 — reconcile drift alerting is mode-scoped', () => {
  it('enforce: drift raises a Sentry fatal + the drift metric', async () => {
    const patient = await makePatient();
    const invoiceId = await makeUnwiredInvoice(patient, 700);
    const recon = await reconcileLedger(TENANT, { mode: 'enforce' });
    expect(recon.unwired.find((u) => u.invoiceId === invoiceId)).toBeTruthy();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0][1]).toMatchObject({ level: 'fatal', tags: { subsystem: 'billing_ledger' } });
    expect(recordLedgerReconciliationDrift).toHaveBeenCalled();
  });

  it('shadow: the same drift only warns — no Sentry fatal, no metric', async () => {
    const patient = await makePatient();
    const invoiceId = await makeUnwiredInvoice(patient, 700);
    const recon = await reconcileLedger(TENANT, { mode: 'shadow' });
    expect(recon.unwired.find((u) => u.invoiceId === invoiceId)).toBeTruthy();
    expect(captureException).not.toHaveBeenCalled();
    expect(recordLedgerReconciliationDrift).not.toHaveBeenCalled();
  });

  it('persistReconciliationCheck appends an evidence row; passed reflects drift', async () => {
    await persistReconciliationCheck(TENANT, { mismatches: [], unwired: [], eventsDrift: [], trialBalancePaise: 0 }, 'enforce');
    await persistReconciliationCheck(TENANT, { mismatches: [{ invoiceId: 1 }], unwired: [], eventsDrift: [], trialBalancePaise: 0 }, 'enforce');
    const evRows = await prisma.$queryRawUnsafe(
      `SELECT passed, mismatch_count, mode FROM reconciliation_checks WHERE tenant_id = $1::uuid ORDER BY id DESC LIMIT 2`, TENANT,
    );
    expect(evRows.length).toBe(2);
    expect(evRows[0].passed).toBe(false);            // most recent = the drifted sweep
    expect(Number(evRows[0].mismatch_count)).toBe(1);
    expect(evRows[0].mode).toBe('enforce');
    expect(evRows[1].passed).toBe(true);             // the clean sweep
  });
});
