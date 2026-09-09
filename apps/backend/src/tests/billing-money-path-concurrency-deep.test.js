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
// These run against a configured disposable Postgres — the concurrency assertions
// require a real engine (FOR UPDATE, the partial unique index from migration
// 317), so the prisma singleton is NOT mocked here.

import { randomUUID } from 'node:crypto';
import prisma, { setTenantTx } from '../lib/prisma.js';
import * as billing from '../services/billing/billingV2Service.js';
import billingService from '../services/billing/billingService.js';
import * as claims from '../services/insurance/claimsService.js';
import * as priorAuth from '../services/ai/priorAuthorizationService.js';

const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const ACCOUNT_CODES = ['BANK', 'CASH', 'PATIENT_ADVANCE', 'PATIENT_AR', 'REFUNDS_PAYABLE', 'REVENUE'];

// Immutable financial history stays in these isolated tenants until the test DB is dropped.
const fixtures = { patientUids: [], invoiceIds: [], advanceIds: [], claimIds: [], priorAuthIds: [], policyIds: [], legacyClaimIds: [], settlements: [] };

beforeAll(async () => {
  const accounts = await setTenantTx(DEFAULT_TENANT, (tx) => tx.$queryRawUnsafe(
    `SELECT code, type, description FROM ledger_accounts
      WHERE tenant_id = $1::uuid AND code = ANY($2::text[]) ORDER BY code`,
    DEFAULT_TENANT, ACCOUNT_CODES,
  ));
  expect(accounts.map((account) => account.code)).toEqual(ACCOUNT_CODES);
  for (const tenantId of [TENANT_A, TENANT_B]) {
    await setTenantTx(tenantId, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, 'Money Path Test')`,
        tenantId, `money-path-${tenantId}`,
      );
      for (const account of accounts) {
        await tx.$executeRawUnsafe(
          `INSERT INTO ledger_accounts (tenant_id, code, type, description)
           VALUES ($1::uuid, $2, $3, $4)`,
          tenantId, account.code, account.type, account.description,
        );
      }
      const copied = await tx.$queryRawUnsafe(
        `SELECT code, type, description FROM ledger_accounts WHERE tenant_id = $1::uuid ORDER BY code`,
        tenantId,
      );
      expect(copied).toEqual(accounts);
    });
  }
});

async function assertLedgerEntry(tenantId, key, type) {
  const rows = await setTenantTx(tenantId, (tx) => tx.$queryRawUnsafe(
    `SELECT entry.entry_type, count(posting.id)::int AS posting_count,
            COALESCE(sum(posting.amount_paise), 0)::text AS net_paise
       FROM ledger_entries entry
       LEFT JOIN ledger_postings posting ON posting.entry_id = entry.id
      WHERE entry.tenant_id = $1::uuid AND entry.idempotency_key = $2
      GROUP BY entry.id, entry.entry_type`,
    tenantId, key,
  ));
  expect(rows).toHaveLength(1);
  expect(rows[0].entry_type).toBe(type);
  expect(rows[0].posting_count).toBeGreaterThanOrEqual(2);
  expect(rows[0].net_paise).toBe('0');
}

async function makePatient(tenantId = TENANT_A) {
  const uid = randomUUID();
  const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
  await setTenantTx(tenantId, (tx) => tx.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, tenant_id, is_active, status, is_deleted, updated_at)
     VALUES ($1::uuid, $2, 'Money Path Test', 'PATIENT', $3::uuid, true, 'active', false, NOW())`,
    uid, phone, tenantId,
  ));
  fixtures.patientUids.push(uid);
  return uid;
}

// Create an ISSUED invoice with a known total/due so payments can be collected.
async function makeIssuedInvoice(patientUid, total, tenantId = TENANT_A) {
  const invoice = await billing.createDraftInvoice({ patient_uid: patientUid, invoice_type: 'OP', tenantId });
  fixtures.invoiceIds.push(invoice.id);
  await billing.addInvoiceItem(invoice.id, {
    description: 'Money Path Test', quantity: 1, unit_price: total, gst_rate: 0, tenantId,
  });
  await billing.issueInvoice(invoice.id, { tenantId });
  await assertLedgerEntry(tenantId, `issue-inv-${invoice.id}`, 'INVOICE_ISSUE');
  return invoice.id;
}

async function makeActiveAdvance(patientUid, amount, tenantId = TENANT_A) {
  const advance = await billing.collectAdvance({ patient_uid: patientUid, amount, mode: 'CASH', tenantId });
  fixtures.advanceIds.push(advance.id);
  await assertLedgerEntry(tenantId, `advance-${advance.id}`, 'ADVANCE_COLLECT');
  return advance.id;
}

async function makePolicy(patientUid, tenantId = TENANT_A) {
  const rows = await setTenantTx(tenantId, (tx) => tx.$queryRawUnsafe(
    `INSERT INTO insurance_policies (patient_uid, policy_number, tenant_id)
     VALUES ($1::uuid, $2, $3::uuid)
     RETURNING id`,
    patientUid, `POL-${Math.floor(Math.random() * 1e9)}`, tenantId,
  ));
  fixtures.policyIds.push(rows[0].id);
  return rows[0].id;
}

async function makeTpaClaim(patientUid, policyId, status, tenantId = TENANT_A, { claimed = 1000, paymentRef = null } = {}) {
  const rows = await setTenantTx(tenantId, (tx) => tx.$queryRawUnsafe(
    `INSERT INTO tpa_claims
       (claim_number, policy_id, patient_uid, total_billed, claimed_amount, claim_type, status, tenant_id, payment_reference)
     VALUES ($1, $2::int, $3::uuid, $4::numeric, $4::numeric, 'cashless', $5, $6::uuid, $7)
     RETURNING id`,
    `CLM-${Math.floor(Math.random() * 1e9)}`, policyId, patientUid, claimed, status, tenantId, paymentRef,
  ));
  fixtures.claimIds.push(rows[0].id);
  return rows[0].id;
}

async function makePriorAuth(patientUid, status, tenantId = TENANT_A) {
  const rows = await setTenantTx(tenantId, (tx) => tx.$queryRawUnsafe(
    `INSERT INTO clinical_ai_prior_auth_requests
       (tenant_id, patient_uid, payer_name, procedure_code, medical_necessity, packet_draft, status)
     VALUES ($1::uuid, $2::uuid, 'Test Payer', 'PROC1', 'necessity', '{}'::jsonb, $3)
     RETURNING id`,
    tenantId, patientUid, status,
  ));
  fixtures.priorAuthIds.push(rows[0].id);
  return rows[0].id;
}

async function readFixtureIdentities(tenantId) {
  return setTenantTx(tenantId, (tx) => tx.$queryRawUnsafe(
    `SELECT 'patientUids' AS kind, uid::text AS id FROM users
      WHERE tenant_id = $1::uuid AND uid = ANY($2::uuid[])
     UNION ALL SELECT 'invoiceIds', id::text FROM billing_invoices
      WHERE tenant_id = $1::uuid AND id = ANY($3::int[])
     UNION ALL SELECT 'advanceIds', id::text FROM billing_advances
      WHERE tenant_id = $1::uuid AND id = ANY($4::int[])
     UNION ALL SELECT 'claimIds', id::text FROM tpa_claims
      WHERE tenant_id = $1::uuid AND id = ANY($5::int[])
     UNION ALL SELECT 'priorAuthIds', id::text FROM clinical_ai_prior_auth_requests
      WHERE tenant_id = $1::uuid AND id = ANY($6::int[])
     UNION ALL SELECT 'policyIds', id::text FROM insurance_policies
      WHERE tenant_id = $1::uuid AND id = ANY($7::int[])
     UNION ALL SELECT 'legacyClaimIds', id::text FROM insurance_claims
      WHERE tenant_id = $1::uuid AND id = ANY($8::int[])`,
    tenantId, fixtures.patientUids, fixtures.invoiceIds, fixtures.advanceIds,
    fixtures.claimIds, fixtures.priorAuthIds, fixtures.policyIds, fixtures.legacyClaimIds,
  ));
}

async function readMoneyEffects(tenantId) {
  return setTenantTx(tenantId, (tx) => tx.$queryRawUnsafe(
    `SELECT 'payment-' || id AS key, 'PAYMENT' AS type FROM billing_payments
      WHERE tenant_id = $1::uuid AND patient_uid = ANY($2::uuid[])
     UNION ALL SELECT 'advance-settle-' || id, 'ADVANCE_SETTLE' FROM billing_advance_settlements
      WHERE tenant_id = $1::uuid AND advance_id = ANY($3::int[])
     UNION ALL SELECT 'refund-approve-' || id, 'REFUND_APPROVE' FROM billing_refunds
      WHERE tenant_id = $1::uuid AND patient_uid = ANY($2::uuid[]) AND approval_status IN ('APPROVED', 'PAID')
     UNION ALL SELECT 'refund-paid-' || id, 'REFUND_PAID' FROM billing_refunds
      WHERE tenant_id = $1::uuid AND patient_uid = ANY($2::uuid[]) AND approval_status = 'PAID'`,
    tenantId, fixtures.patientUids, fixtures.advanceIds,
  ));
}

afterAll(async () => {
  try {
    const retained = await readFixtureIdentities(TENANT_A);
    const expected = Object.entries(fixtures)
      .filter(([kind]) => kind !== 'settlements')
      .flatMap(([kind, ids]) => ids.map((id) => `${kind}:${id}`));
    expect(expected.length).toBeGreaterThan(0);
    expect(retained.map(({ kind, id }) => `${kind}:${id}`).sort()).toEqual(expected.sort());
    expect(await readFixtureIdentities(DEFAULT_TENANT)).toEqual([]);
    expect(await readMoneyEffects(DEFAULT_TENANT)).toEqual([]);

    const invoices = await setTenantTx(TENANT_A, (tx) => tx.$queryRawUnsafe(
      `SELECT id, invoice_number, issued_at FROM billing_invoices
        WHERE tenant_id = $1::uuid AND id = ANY($2::int[])`,
      TENANT_A, fixtures.invoiceIds,
    ));
    expect(new Set(invoices.map((invoice) => invoice.invoice_number)).size).toBe(invoices.length);
    for (const invoice of invoices) {
      expect(invoice.invoice_number).toEqual(expect.stringMatching(/\S/));
      expect(invoice.issued_at).toBeInstanceOf(Date);
      await assertLedgerEntry(TENANT_A, `issue-inv-${invoice.id}`, 'INVOICE_ISSUE');
    }
    for (const advanceId of fixtures.advanceIds) {
      await assertLedgerEntry(TENANT_A, `advance-${advanceId}`, 'ADVANCE_COLLECT');
    }
    const settlements = await setTenantTx(TENANT_A, (tx) => tx.$queryRawUnsafe(
      `SELECT id, tenant_id, advance_id, invoice_id, amount::text AS amount
         FROM billing_advance_settlements
        WHERE tenant_id = $1::uuid AND advance_id = ANY($2::int[]) ORDER BY id`,
      TENANT_A, fixtures.advanceIds,
    ));
    expect(fixtures.settlements).toHaveLength(1);
    expect(settlements).toEqual(fixtures.settlements);
    const effects = await readMoneyEffects(TENANT_A);
    expect(new Set(effects.map((effect) => effect.type))).toEqual(new Set([
      'PAYMENT', 'ADVANCE_SETTLE', 'REFUND_APPROVE', 'REFUND_PAID',
    ]));
    expect(effects).toContainEqual({ key: `advance-settle-${settlements[0].id}`, type: 'ADVANCE_SETTLE' });
    for (const effect of effects) {
      await assertLedgerEntry(TENANT_A, effect.key, effect.type);
    }
  } finally {
    await prisma.$disconnect();
  }
}, 30000);

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
      const settlement = fulfilled[0].value;
      fixtures.settlements.push({
        id: settlement.id, tenant_id: TENANT_A, advance_id: advance,
        invoice_id: settlement.invoice_id, amount: Number(settlement.amount).toFixed(2),
      });

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

    it('keeps gross-receipt headroom after an earlier refund is paid', async () => {
      const patient = await makePatient();
      const approver = await makePatient();
      const payoutActor = await makePatient();
      const invoice = await makeIssuedInvoice(patient, 1000);
      await billing.collectPayment({
        invoice_id: invoice,
        amount: 600,
        mode: 'UPI',
        reference: `HEADROOM-PAY-${randomUUID()}`,
        tenantId: TENANT_A,
      });

      const first = await billing.raiseRefund({
        invoice_id: invoice,
        amount: 200,
        reason: 'First settled partial refund',
        mode: 'CHEQUE',
        raised_by: patient,
        tenantId: TENANT_A,
      });
      await billing.approveRefund(first.id, { approved_by: approver, tenantId: TENANT_A });
      await billing.markRefundPaid(first.id, {
        paid_by: payoutActor,
        reference: `HEADROOM-PAID-${randomUUID()}`,
        tenantId: TENANT_A,
      });

      const later = await billing.raiseRefund({
        invoice_id: invoice,
        amount: 300,
        reason: 'Later valid partial refund',
        mode: 'CASH',
        raised_by: patient,
        tenantId: TENANT_A,
      });
      await billing.approveRefund(later.id, { approved_by: approver, tenantId: TENANT_A });

      await expect(billing.raiseRefund({
        invoice_id: invoice,
        amount: 101,
        reason: 'Aggregate refund exceeds receipts',
        mode: 'CASH',
        raised_by: patient,
        tenantId: TENANT_A,
      })).rejects.toMatchObject({
        code: 'BILLING_REFUND_EXCEEDS_PAID',
        details: {
          gross_paid: 600,
          prior_refunds: 500,
          refundable: 100,
        },
      });

      const persisted = await prisma.$queryRawUnsafe(
        `SELECT id, amount::double precision AS amount, approval_status
           FROM billing_refunds
          WHERE invoice_id = $1::int
          ORDER BY id`,
        invoice,
      );
      expect(persisted).toEqual([
        { id: first.id, amount: 200, approval_status: 'PAID' },
        { id: later.id, amount: 300, approval_status: 'APPROVED' },
      ]);
      expect(persisted.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(500);
    });

    it('reserves sequential advance-refund headroom across pending and approved states', async () => {
      const patient = await makePatient();
      const advance = await makeActiveAdvance(patient, 1000);
      const first = await billing.raiseRefund({
        advance_id: advance,
        amount: 400,
        reason: 'First advance return',
        mode: 'CASH',
        raised_by: patient,
        tenantId: TENANT_A,
      });
      const second = await billing.raiseRefund({
        advance_id: advance,
        amount: 350,
        reason: 'Second advance return',
        mode: 'CASH',
        raised_by: patient,
        tenantId: TENANT_A,
      });

      await expect(billing.raiseRefund({
        advance_id: advance,
        amount: 251,
        reason: 'Pending aggregate exceeds balance',
        mode: 'CASH',
        raised_by: patient,
        tenantId: TENANT_A,
      })).rejects.toMatchObject({
        code: 'BILLING_REFUND_EXCEEDS_ADVANCE_BALANCE',
        details: { reserved_refunds: 750, refundable: 250 },
      });

      await billing.approveRefund(first.id, { approved_by: patient, tenantId: TENANT_A });
      const final = await billing.raiseRefund({
        advance_id: advance,
        amount: 250,
        reason: 'Exact remaining advance balance',
        mode: 'CASH',
        raised_by: patient,
        tenantId: TENANT_A,
      });
      await expect(billing.raiseRefund({
        advance_id: advance,
        amount: 0.01,
        reason: 'No aggregate headroom remains',
        mode: 'CASH',
        raised_by: patient,
        tenantId: TENANT_A,
      })).rejects.toMatchObject({
        code: 'BILLING_REFUND_EXCEEDS_ADVANCE_BALANCE',
        details: { refundable: 0 },
      });

      const persisted = await prisma.$queryRawUnsafe(
        `SELECT id, amount::double precision AS amount, approval_status
           FROM billing_refunds
          WHERE advance_id = $1::int
          ORDER BY id`,
        advance,
      );
      expect(persisted).toEqual([
        { id: first.id, amount: 400, approval_status: 'APPROVED' },
        { id: second.id, amount: 350, approval_status: 'PENDING' },
        { id: final.id, amount: 250, approval_status: 'PENDING' },
      ]);
      expect(persisted.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(1000);
    });

    it('serializes concurrent advance refunds behind an approved reservation', async () => {
      const patient = await makePatient();
      const advance = await makeActiveAdvance(patient, 1000);
      const approved = await billing.raiseRefund({
        advance_id: advance,
        amount: 400,
        reason: 'Approved reservation',
        mode: 'CASH',
        raised_by: patient,
        tenantId: TENANT_A,
      });
      await billing.approveRefund(approved.id, { approved_by: patient, tenantId: TENANT_A });

      const results = await Promise.allSettled([
        billing.raiseRefund({
          advance_id: advance,
          amount: 400,
          reason: 'Concurrent reservation A',
          mode: 'CASH',
          raised_by: patient,
          tenantId: TENANT_A,
        }),
        billing.raiseRefund({
          advance_id: advance,
          amount: 400,
          reason: 'Concurrent reservation B',
          mode: 'CASH',
          raised_by: patient,
          tenantId: TENANT_A,
        }),
      ]);
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({
        code: 'BILLING_REFUND_EXCEEDS_ADVANCE_BALANCE',
        details: { refundable: 200 },
      });

      const persisted = await prisma.$queryRawUnsafe(
        `SELECT amount, approval_status
           FROM billing_refunds
          WHERE advance_id = $1::int
          ORDER BY id`,
        advance,
      );
      expect(persisted).toHaveLength(2);
      expect(persisted.map((row) => row.approval_status)).toEqual(['APPROVED', 'PENDING']);
      expect(persisted.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(800);
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
      const rows = await setTenantTx(TENANT_A, (tx) => tx.$queryRawUnsafe(
        `INSERT INTO insurance_claims
           (claim_number, patient_uid, insurance_provider, policy_number, claim_amount, status, tenant_id, updated_at)
         VALUES ($1, $2::uuid, 'Acme', 'POLX', 1000, 'submitted', $3::uuid, NOW())
         RETURNING id`,
        `ICLM-${Math.floor(Math.random() * 1e9)}`, patient, TENANT_A,
      ));
      const claimId = rows[0].id;
      fixtures.legacyClaimIds.push(claimId);
      // Tenant B must NOT be able to update tenant A's claim.
      await expect(billingService.updateClaimStatus(
        claimId, 'approved', 500, { tenantId: TENANT_B },
      )).rejects.toMatchObject({ statusCode: 404 });

      // Tenant A succeeds (control).
      const ok = await billingService.updateClaimStatus(claimId, 'approved', 500, { tenantId: TENANT_A });
      expect(ok.status).toBe('approved');
    });
  });
});
