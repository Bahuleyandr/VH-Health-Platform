// WS-C / audit 2026-06-22 H2 + H3 — money writes must be locked, atomic, and
// idempotent.
//
// H2: legacy V1 billingService.recordPayment read the invoice OUTSIDE the tx
//     with no FOR UPDATE and no unique on transaction_ref, so a replayed payment
//     double-charged the invoice + created a duplicate payment_transactions row.
// H3: pmjayService.transition(claim_paid) ran the status flip and the
//     family-floater increment as two un-transactional statements with no lock
//     and no paid<=approved guard.

import prisma from '../lib/prisma.js';
import billingService from '../services/billing/billingService.js';
import { transition } from '../services/insurance/pmjayService.js';

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '00000000-0000-4000-8000-0000000c1c01';

async function exec(sql, ...p) { return prisma.$executeRawUnsafe(sql, ...p); }
async function q(sql, ...p) {
  const r = await prisma.$queryRawUnsafe(sql, ...p);
  return Array.isArray(r) ? r : [];
}

d('Money writes: lock + idempotency (audit H2/H3)', () => {
  beforeAll(async () => {
    await exec(
      `INSERT INTO users (uid, phone, name, role, is_active, status, tenant_id, updated_at)
       VALUES ($1::uuid, '8770111222', 'Money Test Patient', 'PATIENT', true, 'active', $2::uuid, NOW())
       ON CONFLICT (uid) DO NOTHING`,
      PATIENT, TENANT,
    );
  });

  afterAll(async () => {
    await exec(`DELETE FROM payment_transactions WHERE transaction_ref LIKE 'MTEST-%'`).catch(() => {});
    await exec(`DELETE FROM invoices WHERE invoice_number LIKE 'MTEST-%'`).catch(() => {});
    await exec(`DELETE FROM pmjay_cases WHERE case_number LIKE 'MTEST-%'`).catch(() => {});
    await exec(`DELETE FROM pmjay_beneficiaries WHERE beneficiary_id LIKE 'MTEST-%'`).catch(() => {});
    await exec(`DELETE FROM pmjay_packages WHERE package_code LIKE 'MTEST-%'`).catch(() => {});
    await exec(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  describe('H2 — recordPayment idempotency + lock', () => {
    async function seedInvoice(total) {
      const rows = await q(
        `INSERT INTO invoices (invoice_number, patient_uid, type, items, subtotal, total_amount, paid_amount, payment_status, tenant_id, updated_at)
         VALUES ($1, $2::uuid, 'consultation', '[]'::jsonb, $3, $3, 0, 'pending', $4::uuid, NOW())
         RETURNING id`,
        `MTEST-INV-${Date.now()}`, PATIENT, total, TENANT,
      );
      return Number(rows[0].id);
    }

    it('a replayed payment (same transaction_ref) is refused and does NOT double-charge', async () => {
      const invoiceId = await seedInvoice(1000);

      const first = await billingService.recordPayment(invoiceId, 500, 'cash', null, 'MTEST-REF-1', TENANT);
      expect(first.invoice.paid_amount).toBeDefined();

      await expect(
        billingService.recordPayment(invoiceId, 500, 'cash', null, 'MTEST-REF-1', TENANT),
      ).rejects.toMatchObject({ statusCode: 409, code: 'DUPLICATE_PAYMENT_REF' });

      // The invoice must reflect exactly one 500 payment, not two.
      const [inv] = await q(`SELECT paid_amount, payment_status FROM invoices WHERE id = $1`, invoiceId);
      expect(Number(inv.paid_amount)).toBe(500);
      const [{ n }] = await q(
        `SELECT COUNT(*)::int AS n FROM payment_transactions WHERE invoice_id = $1 AND transaction_ref = 'MTEST-REF-1'`,
        invoiceId,
      );
      expect(Number(n)).toBe(1);
    });

    it('rejects an overpayment beyond the remaining balance', async () => {
      const invoiceId = await seedInvoice(300);
      await expect(
        billingService.recordPayment(invoiceId, 400, 'cash', null, 'MTEST-REF-OVER', TENANT),
      ).rejects.toMatchObject({ statusCode: 400 });
      const [inv] = await q(`SELECT paid_amount FROM invoices WHERE id = $1`, invoiceId);
      expect(Number(inv.paid_amount)).toBe(0);
    });
  });

  describe('H3 — PMJAY claim_paid guard + atomic floater', () => {
    async function seedCase({ approved }) {
      const pkg = await q(
        `INSERT INTO pmjay_packages (scheme_code, package_code, procedure_name, package_rate, tenant_id, updated_at)
         VALUES ('PMJAY', $1, 'MTEST Procedure', 20000, $2::uuid, NOW()) RETURNING id`,
        `MTEST-PKG-${Date.now()}`, TENANT,
      );
      const ben = await q(
        `INSERT INTO pmjay_beneficiaries (patient_uid, scheme_code, beneficiary_id, cumulative_used, tenant_id, updated_at)
         VALUES ($1::uuid, 'PMJAY', $2, 0, $3::uuid, NOW()) RETURNING id`,
        PATIENT, `MTEST-${Date.now()}`, TENANT,
      );
      const cse = await q(
        `INSERT INTO pmjay_cases (case_number, beneficiary_id, patient_uid, package_id, primary_diagnosis,
                                  locked_package_rate, approved_amount, status, tenant_id, updated_at)
         VALUES ($1, $2::int, $3::uuid, $4::int, 'MTEST dx', 20000, $5, 'claim_approved', $6::uuid, NOW())
         RETURNING id`,
        `MTEST-CASE-${Date.now()}`, Number(ben[0].id), PATIENT, Number(pkg[0].id), approved, TENANT,
      );
      return { caseId: Number(cse[0].id), beneficiaryId: Number(ben[0].id) };
    }

    it('refuses paid_amount > approved_amount and leaves the case unpaid', async () => {
      const { caseId, beneficiaryId } = await seedCase({ approved: 20000 });

      await expect(
        transition({ tenantId: TENANT, id: caseId, status: 'claim_paid', paid_amount: 25000 }),
      ).rejects.toMatchObject({ statusCode: 400, code: 'PMJAY_PAYMENT_EXCEEDS_APPROVED' });

      const [c] = await q(`SELECT status FROM pmjay_cases WHERE id = $1`, caseId);
      expect(c.status).toBe('claim_approved');
      const [b] = await q(`SELECT cumulative_used FROM pmjay_beneficiaries WHERE id = $1`, beneficiaryId);
      expect(Number(b.cumulative_used)).toBe(0);
    });

    it('a valid claim_paid bumps the floater exactly once and is not re-payable', async () => {
      const { caseId, beneficiaryId } = await seedCase({ approved: 20000 });

      await transition({ tenantId: TENANT, id: caseId, status: 'claim_paid', paid_amount: 18000, payment_reference: 'MTEST-PR-1' });

      const [c] = await q(`SELECT status, paid_amount FROM pmjay_cases WHERE id = $1`, caseId);
      expect(c.status).toBe('claim_paid');
      expect(Number(c.paid_amount)).toBe(18000);
      const [b] = await q(`SELECT cumulative_used FROM pmjay_beneficiaries WHERE id = $1`, beneficiaryId);
      expect(Number(b.cumulative_used)).toBe(18000);

      // Re-attempting claim_paid is rejected by the state machine as an invalid
      // transition (claim_paid only allows claim_closed) — idempotent, so the
      // floater must not be double-counted.
      await expect(
        transition({ tenantId: TENANT, id: caseId, status: 'claim_paid', paid_amount: 18000 }),
      ).rejects.toMatchObject({ statusCode: 400 });
      const [b2] = await q(`SELECT cumulative_used FROM pmjay_beneficiaries WHERE id = $1`, beneficiaryId);
      expect(Number(b2.cumulative_used)).toBe(18000);
    });
  });
});
