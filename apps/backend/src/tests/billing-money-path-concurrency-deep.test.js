// src/tests/billing-money-path-concurrency-deep.test.js
//
// Deep (real-DB) tests for the audit 2026-06-18 §C-1 money-path fixes:
//   1. Idempotency / DB uniqueness → double payment with the same reference
//      collapses to ONE billing_payments row.
//   2. Atomicity + locking → concurrent advance settlements cannot overdraw
//      the advance balance (FOR UPDATE + `balance = balance - amt WHERE balance
//      >= amt`).
//   3. Concurrent invoice payments cannot over-collect past amount_due.
//   4. State-machine guards → illegal claim / prior-auth transitions rejected;
//      same-decision re-record is an idempotent no-op.
//   5. Refund bound → a refund cannot exceed what was actually paid.
//   6. Cross-tenant claim update blocked (tenant-scoped lookup).
//
// These run against the live dev Postgres (5433) — the concurrency assertions
// require a real engine (FOR UPDATE, the partial unique index from migration
// 317), so the prisma singleton is NOT mocked here.

import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import * as billing from '../services/billing/billingV2Service.js';
import billingService from '../services/billing/billingService.js';
import * as claims from '../services/insurance/claimsService.js';
import * as priorAuth from '../services/ai/priorAuthorizationService.js';

const TENANT_A = '00000000-0000-4000-8000-000000000001'; // default tenant (literal insert default)
const TENANT_B = '00000000-0000-4000-8000-0000000000b2';

// Track inserted ids for teardown.
const cleanup = { patientUids: [], invoiceIds: [], advanceIds: [], claimIds: [], priorAuthIds: [], policyIds: [], paymentRefs: [] };

async function makePatient(tenantId = TENANT_A) {
  const uid = randomUUID();
  const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at)
     VALUES ($1::uuid, $2, 'Money Path Test', 'PATIENT', $3::uuid, NOW())`,
    uid, phone, tenantId,
  );
  cleanup.patientUids.push(uid);
  return uid;
}

// Create an ISSUED invoice with a known total/due so payments can be collected.
async function makeIssuedInvoice(patientUid, total, tenantId = TENANT_A) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_invoices
       (patient_uid, invoice_type, status, subtotal, total_amount, amount_paid, amount_due, tenant_id)
     VALUES ($1::uuid, 'OP', 'ISSUED', $2::numeric, $2::numeric, 0, $2::numeric, $3::uuid)
     RETURNING id`,
    patientUid, total, tenantId,
  );
  cleanup.invoiceIds.push(rows[0].id);
  return rows[0].id;
}

async function makeActiveAdvance(patientUid, amount, tenantId = TENANT_A) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_advances
       (patient_uid, amount, balance, mode, status, tenant_id)
     VALUES ($1::uuid, $2::numeric, $2::numeric, 'CASH', 'ACTIVE', $3::uuid)
     RETURNING id`,
    patientUid, amount, tenantId,
  );
  cleanup.advanceIds.push(rows[0].id);
  return rows[0].id;
}

async function makePolicy(patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO insurance_policies (patient_uid, policy_number)
     VALUES ($1::uuid, $2)
     RETURNING id`,
    patientUid, `POL-${Math.floor(Math.random() * 1e9)}`,
  );
  cleanup.policyIds.push(rows[0].id);
  return rows[0].id;
}

async function makeTpaClaim(patientUid, policyId, status, tenantId = TENANT_A, { claimed = 1000, paymentRef = null } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO tpa_claims
       (claim_number, policy_id, patient_uid, total_billed, claimed_amount, claim_type, status, tenant_id, payment_reference)
     VALUES ($1, $2::int, $3::uuid, $4::numeric, $4::numeric, 'cashless', $5, $6::uuid, $7)
     RETURNING id`,
    `CLM-${Math.floor(Math.random() * 1e9)}`, policyId, patientUid, claimed, status, tenantId, paymentRef,
  );
  cleanup.claimIds.push(rows[0].id);
  return rows[0].id;
}

async function makePriorAuth(patientUid, status, tenantId = TENANT_A) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_prior_auth_requests
       (tenant_id, patient_uid, payer_name, procedure_code, medical_necessity, packet_draft, status)
     VALUES ($1::uuid, $2::uuid, 'Test Payer', 'PROC1', 'necessity', '{}'::jsonb, $3)
     RETURNING id`,
    tenantId, patientUid, status,
  );
  cleanup.priorAuthIds.push(rows[0].id);
  return rows[0].id;
}

afterAll(async () => {
  // Best-effort teardown in FK-safe order.
  try {
    if (cleanup.invoiceIds.length) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM billing_advance_settlements WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM billing_refunds WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM billing_payments WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds,
      );
    }
    if (cleanup.advanceIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_refunds WHERE advance_id = ANY($1::int[])`, cleanup.advanceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_advance_settlements WHERE advance_id = ANY($1::int[])`, cleanup.advanceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_advances WHERE id = ANY($1::int[])`, cleanup.advanceIds);
    }
    if (cleanup.invoiceIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = ANY($1::int[])`, cleanup.invoiceIds);
    }
    if (cleanup.claimIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM tpa_claim_correspondence WHERE claim_id = ANY($1::int[])`, cleanup.claimIds).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM tpa_claims WHERE id = ANY($1::int[])`, cleanup.claimIds);
    }
    if (cleanup.policyIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM insurance_policies WHERE id = ANY($1::int[])`, cleanup.policyIds);
    }
    if (cleanup.priorAuthIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_prior_auth_requests WHERE id = ANY($1::int[])`, cleanup.priorAuthIds);
    }
    if (cleanup.patientUids.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, cleanup.patientUids);
    }
  } catch {
    // teardown best-effort
  }
  await prisma.$disconnect().catch(() => {});
});

describe('Money-path C-1 fixes (deep)', () => {
  // ── Fix 1 + 4: idempotency / DB uniqueness on payments ────────────────
  describe('payment reference uniqueness (double-charge guard)', () => {
    it('rejects a second payment with the same (reference, mode) → one row only', async () => {
      const patient = await makePatient();
      const invoice = await makeIssuedInvoice(patient, 1000);
      const reference = `TXN-${randomUUID()}`;

      const first = await billing.collectPayment({
        invoice_id: invoice, amount: 400, mode: 'UPI', reference, tenantId: TENANT_A,
      });
      expect(first.id).toBeDefined();

      await expect(billing.collectPayment({
        invoice_id: invoice, amount: 400, mode: 'UPI', reference, tenantId: TENANT_A,
      })).rejects.toMatchObject({ code: 'DUPLICATE_PAYMENT_REFERENCE' });

      const rows = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM billing_payments WHERE invoice_id = $1::int AND reference = $2`,
        invoice, reference,
      );
      expect(rows[0].c).toBe(1);
    });

    it('still allows two reference-less CASH payments (no false idempotency)', async () => {
      const patient = await makePatient();
      const invoice = await makeIssuedInvoice(patient, 1000);
      const p1 = await billing.collectPayment({
        invoice_id: invoice, amount: 100, mode: 'CASH', shift: 'DAY', tenantId: TENANT_A,
      });
      const p2 = await billing.collectPayment({
        invoice_id: invoice, amount: 100, mode: 'CASH', shift: 'DAY', tenantId: TENANT_A,
      });
      expect(p1.id).not.toBe(p2.id);
    });
  });

  // ── Fix 2 + 3: atomicity + locking ────────────────────────────────────
  describe('concurrent invoice payments cannot over-collect', () => {
    it('two simultaneous payments for the full due → at most the due is collected', async () => {
      const patient = await makePatient();
      const invoice = await makeIssuedInvoice(patient, 500);

      // Both attempt the FULL due of 500 concurrently. With FOR UPDATE the
      // second sees amount_due=0 after the first commits and must reject.
      const results = await Promise.allSettled([
        billing.collectPayment({ invoice_id: invoice, amount: 500, mode: 'UPI', reference: `A-${randomUUID()}`, tenantId: TENANT_A }),
        billing.collectPayment({ invoice_id: invoice, amount: 500, mode: 'UPI', reference: `B-${randomUUID()}`, tenantId: TENANT_A }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBe(1);

      const inv = await prisma.$queryRawUnsafe(
        `SELECT amount_paid, amount_due, status FROM billing_invoices WHERE id = $1::int`, invoice,
      );
      expect(Number(inv[0].amount_paid)).toBeLessThanOrEqual(500.005);
      expect(Number(inv[0].amount_due)).toBeGreaterThanOrEqual(-0.005);
    });
  });

  describe('concurrent advance settlements cannot overdraw the balance', () => {
    it('two simultaneous settlements of the full balance → only one succeeds, balance never negative', async () => {
      const patient = await makePatient();
      const advance = await makeActiveAdvance(patient, 1000);
      const inv1 = await makeIssuedInvoice(patient, 1000);
      const inv2 = await makeIssuedInvoice(patient, 1000);

      const results = await Promise.allSettled([
        billing.settleAdvance({ tenantId: TENANT_A, advance_id: advance, invoice_id: inv1, amount: 1000 }),
        billing.settleAdvance({ tenantId: TENANT_A, advance_id: advance, invoice_id: inv2, amount: 1000 }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      // Exactly one full settlement may consume a 1000 balance.
      expect(fulfilled.length).toBe(1);

      const adv = await prisma.$queryRawUnsafe(
        `SELECT balance, status FROM billing_advances WHERE id = $1::int`, advance,
      );
      expect(Number(adv[0].balance)).toBeGreaterThanOrEqual(0);
      expect(Number(adv[0].balance)).toBeLessThanOrEqual(0.005);
      expect(adv[0].status).toBe('EXHAUSTED');
    });

    it('rejects a settlement that exceeds the advance balance', async () => {
      const patient = await makePatient();
      const advance = await makeActiveAdvance(patient, 100);
      const invoice = await makeIssuedInvoice(patient, 1000);
      await expect(billing.settleAdvance({
        tenantId: TENANT_A, advance_id: advance, invoice_id: invoice, amount: 500,
      })).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  // ── Fix 5: refund bound ───────────────────────────────────────────────
  describe('refund cannot exceed amount paid', () => {
    it('rejects an invoice refund larger than the paid amount', async () => {
      const patient = await makePatient();
      const invoice = await makeIssuedInvoice(patient, 1000);
      // Pay 300 so refundable headroom is 300.
      await billing.collectPayment({ invoice_id: invoice, amount: 300, mode: 'UPI', reference: `PAY-${randomUUID()}`, tenantId: TENANT_A });

      await expect(billing.raiseRefund({
        invoice_id: invoice, amount: 500, reason: 'overcharge', mode: 'UPI', tenantId: TENANT_A,
      })).rejects.toMatchObject({ code: 'BILLING_REFUND_EXCEEDS_PAID' });

      // A refund within the paid amount succeeds.
      const ok = await billing.raiseRefund({
        invoice_id: invoice, amount: 200, reason: 'partial overcharge', mode: 'UPI', tenantId: TENANT_A,
      });
      expect(ok.id).toBeDefined();

      // A second refund that, combined with the first, exceeds paid is rejected.
      await expect(billing.raiseRefund({
        invoice_id: invoice, amount: 200, reason: 'too much', mode: 'UPI', tenantId: TENANT_A,
      })).rejects.toMatchObject({ code: 'BILLING_REFUND_EXCEEDS_PAID' });
    });

    it('rejects an advance refund larger than the advance balance', async () => {
      const patient = await makePatient();
      const advance = await makeActiveAdvance(patient, 100);
      await expect(billing.raiseRefund({
        advance_id: advance, amount: 500, reason: 'refund', mode: 'CASH', tenantId: TENANT_A,
      })).rejects.toMatchObject({ code: 'BILLING_REFUND_EXCEEDS_ADVANCE_BALANCE' });
    });
  });

  // ── Fix 6: claim state-machine guards + idempotency ───────────────────
  describe('TPA claim state-machine guards', () => {
    it('rejects an illegal claim decision transition (paid → approved)', async () => {
      const patient = await makePatient();
      const policy = await makePolicy(patient);
      const claim = await makeTpaClaim(patient, policy, 'paid');
      await expect(claims.recordClaimDecision({
        tenantId: TENANT_A, id: claim, decision: 'approved',
      })).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    });

    it('allows a legal decision (submitted → approved) and is idempotent on re-record', async () => {
      const patient = await makePatient();
      const policy = await makePolicy(patient);
      const claim = await makeTpaClaim(patient, policy, 'submitted');

      const decided = await claims.recordClaimDecision({ tenantId: TENANT_A, id: claim, decision: 'approved', approved_amount: 800 });
      expect(decided.status).toBe('approved');

      // Re-record the same decision → idempotent no-op (no throw, no dup row).
      const again = await claims.recordClaimDecision({ tenantId: TENANT_A, id: claim, decision: 'approved', approved_amount: 800 });
      expect(again.status).toBe('approved');

      const corr = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM tpa_claim_correspondence WHERE claim_id = $1::int AND subject = 'Decision: approved'`, claim,
      );
      expect(corr[0].c).toBe(1); // only the first decision wrote correspondence
    });

    it('rejects a payment on a denied claim, and is idempotent on the same settlement reference', async () => {
      const patient = await makePatient();
      const policy = await makePolicy(patient);
      const denied = await makeTpaClaim(patient, policy, 'denied');
      await expect(claims.recordClaimPayment({
        tenantId: TENANT_A, id: denied, paid_amount: 100, payment_reference: 'X',
      })).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

      // Idempotent payment re-post on an already-paid claim with same ref.
      const paid = await makeTpaClaim(patient, policy, 'paid', TENANT_A, { claimed: 1000, paymentRef: 'UTR-123' });
      const res = await claims.recordClaimPayment({ tenantId: TENANT_A, id: paid, paid_amount: 1000, payment_reference: 'UTR-123' });
      expect(['paid', 'settled_partial']).toContain(res.status);
    });

    it('two simultaneous settlements (distinct refs) on the same claim → exactly one lands (M4)', async () => {
      const patient = await makePatient();
      const policy = await makePolicy(patient);
      const claim = await makeTpaClaim(patient, policy, 'approved', TENANT_A, { claimed: 1000 });

      // Two DIFFERENT settlement references posted concurrently. Without the row
      // lock both read status='approved', both pass FROM_STATES, and both write a
      // paid row (distinct-ref last-writer-wins → a double-settlement record).
      // With FOR UPDATE the loser serializes, re-reads status='paid', and is
      // rejected (paid is terminal).
      const results = await Promise.allSettled([
        claims.recordClaimPayment({ tenantId: TENANT_A, id: claim, paid_amount: 1000, payment_reference: 'UTR-A' }),
        claims.recordClaimPayment({ tenantId: TENANT_A, id: claim, paid_amount: 1000, payment_reference: 'UTR-B' }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

      // Exactly one settlement correspondence row — no double-write.
      const corr = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM tpa_claim_correspondence WHERE claim_id = $1::int AND subject = 'Settlement received'`,
        claim,
      );
      expect(corr[0].c).toBe(1);
    });
  });

  // ── Fix 6: prior-auth payer-decision guard ────────────────────────────
  describe('prior-auth payer-decision guard', () => {
    it('rejects a payer decision on a non-submitted prior auth', async () => {
      const patient = await makePatient();
      const draft = await makePriorAuth(patient, 'draft');
      await expect(priorAuth.recordPayerDecision({
        priorAuthId: draft, decision: 'approved', tenantId: TENANT_A,
      })).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    });

    it('allows approved from submitted and is idempotent on re-record', async () => {
      const patient = await makePatient();
      const submitted = await makePriorAuth(patient, 'submitted');
      const r1 = await priorAuth.recordPayerDecision({ priorAuthId: submitted, decision: 'approved', tenantId: TENANT_A });
      expect(r1.status).toBe('approved');
      const r2 = await priorAuth.recordPayerDecision({ priorAuthId: submitted, decision: 'approved', tenantId: TENANT_A });
      expect(r2.status).toBe('approved');
    });
  });

  // ── Fix 7: cross-tenant claim update blocked ──────────────────────────
  describe('cross-tenant claim update is blocked', () => {
    it('updateClaimStatus with a mismatched tenant returns notFound', async () => {
      const patient = await makePatient(TENANT_A);
      // insurance_claims (legacy billing surface) — seed directly in tenant A.
      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO insurance_claims
           (claim_number, patient_uid, insurance_provider, policy_number, claim_amount, status, tenant_id, updated_at)
         VALUES ($1, $2::uuid, 'Acme', 'POLX', 1000, 'submitted', $3::uuid, NOW())
         RETURNING id`,
        `ICLM-${Math.floor(Math.random() * 1e9)}`, patient, TENANT_A,
      );
      const claimId = rows[0].id;
      try {
        // Tenant B must NOT be able to update tenant A's claim.
        await expect(billingService.updateClaimStatus(
          claimId, 'approved', 500, { tenantId: TENANT_B },
        )).rejects.toMatchObject({ statusCode: 404 });

        // Tenant A succeeds (control).
        const ok = await billingService.updateClaimStatus(claimId, 'approved', 500, { tenantId: TENANT_A });
        expect(ok.status).toBe('approved');
      } finally {
        await prisma.$executeRawUnsafe(`DELETE FROM insurance_claims WHERE id = $1::int`, claimId).catch(() => {});
      }
    });
  });
});
