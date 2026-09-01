import { randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../lib/prisma.js';
import { reconcileLedger } from '../services/billing/ledger/ledgerReconciliation.js';
import { postLedgerEntry } from '../services/billing/ledger/ledgerService.js';
import {
  postInvoiceIssueEntry,
  postPaymentEntry,
  postWardMedicationCreditEntry,
} from '../services/billing/ledger/ledgerPostings.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb('MED-03 medication-credit ledger reconciliation', () => {
  const tenantId = randomUUID();
  const patientUid = randomUUID();
  const actorUid = randomUUID();
  const run = `${process.pid}-${Date.now()}`;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid, $2::text, 'MED-03 Ledger Reconciliation', 'IN', 'active', NOW(), NOW())`,
      tenantId,
      `med03-ledger-reconcile-${run}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO ledger_accounts (tenant_id, code, type, description)
         SELECT $1::uuid, code, type, description
           FROM ledger_accounts
          WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
        ON CONFLICT (tenant_id, code) DO NOTHING`,
      tenantId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $3::uuid, 'Medication Credit Patient', 'PATIENT', TRUE, 'active', NOW()),
         ($2::uuid, $3::uuid, 'Medication Credit Billing Owner', 'BILLING_INCHARGE', TRUE, 'active', NOW())`,
      patientUid,
      actorUid,
      tenantId,
    );
  });

  afterAll(async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      for (const table of [
        'ledger_balances',
        'ledger_postings',
        'ledger_entries',
        'billing_credit_note_events',
        'billing_credit_notes',
        'billing_refunds',
        'billing_payments',
        'billing_invoices',
        'ledger_accounts',
        'users',
      ]) {
        await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, tenantId);
      }
      await tx.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, tenantId);
    });
    await prisma.$disconnect().catch(() => {});
  });

  async function createInvoice({ status, total, paid, credit, due }) {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO billing_invoices
         (patient_uid, invoice_type, status, subtotal, total_amount,
          credit_note_amount, amount_paid, amount_due, tenant_id, issued_at, invoice_number)
       VALUES
         ($1::uuid, 'IP', $2::text, $3::numeric, $3::numeric,
          $4::numeric, $5::numeric, $6::numeric, $7::uuid, NOW(), $8::text)
       RETURNING id`,
      patientUid,
      status,
      total,
      credit,
      paid,
      due,
      tenantId,
      `MED03-RECON-${run}-${Math.floor(Math.random() * 1e9)}`,
    );
    return Number(rows[0].id);
  }

  async function recordPayment({ invoiceId, amount }) {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO billing_payments
         (invoice_id, patient_uid, amount, mode, collected_by, shift, tenant_id)
       VALUES ($1::int, $2::uuid, $3::numeric, 'CASH', $4::uuid, 'MORNING', $5::uuid)
       RETURNING id, invoice_id, patient_uid, amount, mode, reversed`,
      invoiceId,
      patientUid,
      amount,
      actorUid,
      tenantId,
    );
    await postPaymentEntry({ payment: rows[0], tenantId });
  }

  async function createAppliedCredit({
    invoiceId,
    amountMinor,
    receivableMinor,
    refundMinor,
    autoAppliedDraft = false,
  }) {
    let refundId = null;
    if (refundMinor > 0) {
      refundId = Number((await prisma.$queryRawUnsafe(
        `INSERT INTO billing_refunds
           (patient_uid, invoice_id, amount, reason, mode, approval_status, raised_by, tenant_id)
         VALUES ($1::uuid, $2::int, $3::numeric / 100, 'Medication credit obligation',
                 'CASH', 'PENDING', $4::uuid, $5::uuid)
         RETURNING id`,
        patientUid,
        invoiceId,
        refundMinor,
        actorUid,
        tenantId,
      ))[0].id);
    }
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO billing_credit_notes
           (tenant_id, credit_note_number, invoice_id, patient_uid,
            source_financial_event_id, amount_minor, currency, reason, status,
            raised_by, approved_by, approved_at, applied_by, applied_at,
            application_key, receivable_credit_minor, refund_obligation_minor, refund_id)
         VALUES
           ($1::uuid, $2::text, $3::int, $4::uuid,
            $5::bigint, $6::bigint, 'INR', 'Medication reconciliation credit', 'applied',
            $7::uuid, $7::uuid, NOW(), $7::uuid, NOW(),
            $8::text, $9::bigint, $10::bigint, $11::int)
         RETURNING id, source_financial_event_id`,
        tenantId,
        `CN-MED03-RECON-${run}-${Math.floor(Math.random() * 1e9)}`,
        invoiceId,
        patientUid,
        BigInt(8_000_000_000 + Math.floor(Math.random() * 1_000_000)),
        BigInt(amountMinor),
        actorUid,
        `med03-reconcile-apply-${run}-${Math.floor(Math.random() * 1e9)}`,
        BigInt(receivableMinor),
        BigInt(refundMinor),
        refundId,
      );
      if (autoAppliedDraft) {
        const hashColumn = await tx.$queryRawUnsafe(
          `SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'billing_credit_note_events'
              AND column_name = 'request_body_sha256'`,
        );
        const commandKey = `med03-reconcile-draft-raised-${run}-${rows[0].id}`;
        if (hashColumn.length) {
          await tx.$executeRawUnsafe(
            `INSERT INTO billing_credit_note_events
               (tenant_id, credit_note_id, event_type, actor_uid, command_key,
                request_body_sha256, details)
             VALUES
               ($1::uuid, $2::bigint, 'raised', $3::uuid, $4::text,
                $5::text, '{"auto_applied_draft":true}'::jsonb)`,
            tenantId,
            rows[0].id,
            actorUid,
            commandKey,
            '0'.repeat(64),
          );
        } else {
          await tx.$executeRawUnsafe(
            `INSERT INTO billing_credit_note_events
               (tenant_id, credit_note_id, event_type, actor_uid, command_key, details)
             VALUES
               ($1::uuid, $2::bigint, 'raised', $3::uuid, $4::text,
                '{"auto_applied_draft":true}'::jsonb)`,
            tenantId,
            rows[0].id,
            actorUid,
            commandKey,
          );
        }
      }
      return {
        id: String(rows[0].id),
        sourceFinancialEventId: String(rows[0].source_financial_event_id),
      };
    });
  }

  test('reports a missing medication-credit post on a paid invoice', async () => {
    const invoiceId = await createInvoice({
      status: 'PAID',
      total: 500,
      paid: 500,
      credit: 50,
      due: 0,
    });
    await postInvoiceIssueEntry({
      invoice: {
        id: invoiceId,
        patient_uid: patientUid,
        total_amount: '500.00',
        tax_amount: '0.00',
      },
      tenantId,
    });
    await recordPayment({ invoiceId, amount: 500 });
    const credit = await createAppliedCredit({
      invoiceId,
      amountMinor: 5000,
      receivableMinor: 0,
      refundMinor: 5000,
    });

    const result = await reconcileLedger(tenantId, { mode: 'shadow' });
    const drift = result.eventsDrift.find((item) => item.creditNoteId === credit.id);

    expect(drift).toMatchObject({
      kind: 'WARD_MEDICATION_CREDIT',
      invoiceId,
      invoiceStatus: 'PAID',
      entryId: null,
      reasons: ['missing_entry'],
      expectedEntryType: 'WARD_MEDICATION_CREDIT',
      expectedIdempotencyKey: `ward-medication-credit-${credit.id}`,
    });
    expect(drift.expectedLines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountCode: 'REVENUE', amountPaise: '5000' }),
      expect.objectContaining({ accountCode: 'REFUNDS_PAYABLE', amountPaise: '-5000' }),
    ]));
  });

  test('reports the exact split drift on a partially paid invoice', async () => {
    const invoiceId = await createInvoice({
      status: 'PARTIAL',
      total: 1000,
      paid: 400,
      credit: 100,
      due: 500,
    });
    await postInvoiceIssueEntry({
      invoice: {
        id: invoiceId,
        patient_uid: patientUid,
        total_amount: '1000.00',
        tax_amount: '0.00',
      },
      tenantId,
    });
    await recordPayment({ invoiceId, amount: 400 });
    const credit = await createAppliedCredit({
      invoiceId,
      amountMinor: 10000,
      receivableMinor: 10000,
      refundMinor: 0,
    });
    await setTenantTx(tenantId, (tx) => postLedgerEntry(tx, {
      entryType: 'WARD_MEDICATION_CREDIT',
      idempotencyKey: `ward-medication-credit-${credit.id}`,
      metadata: {
        credit_note_id: credit.id,
        source_financial_event_id: credit.sourceFinancialEventId,
      },
      lines: [
        { accountCode: 'REVENUE', amountPaise: 10000 },
        {
          accountCode: 'PATIENT_AR',
          amountPaise: -9000,
          patient_uid: patientUid,
          invoice_id: invoiceId,
        },
        { accountCode: 'REFUNDS_PAYABLE', amountPaise: -1000, patient_uid: patientUid },
      ],
    }));

    const result = await reconcileLedger(tenantId, { mode: 'shadow' });
    const drift = result.eventsDrift.find((item) => item.creditNoteId === credit.id);

    expect(drift).toMatchObject({
      kind: 'WARD_MEDICATION_CREDIT',
      invoiceId,
      invoiceStatus: 'PARTIAL',
      reasons: ['posting_split_mismatch'],
      expectedEntryType: 'WARD_MEDICATION_CREDIT',
      actualEntryType: 'WARD_MEDICATION_CREDIT',
    });
    expect(drift.expectedLines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountCode: 'PATIENT_AR', amountPaise: '-10000' }),
    ]));
    expect(drift.actualLines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountCode: 'PATIENT_AR', amountPaise: '-9000' }),
      expect.objectContaining({ accountCode: 'REFUNDS_PAYABLE', amountPaise: '-1000' }),
    ]));
  });

  test('accepts an exact post-issue medication-credit entry and split', async () => {
    const invoiceId = await createInvoice({
      status: 'ISSUED',
      total: 100,
      paid: 0,
      credit: 10,
      due: 90,
    });
    await postInvoiceIssueEntry({
      invoice: {
        id: invoiceId,
        patient_uid: patientUid,
        total_amount: '100.00',
        tax_amount: '0.00',
      },
      tenantId,
    });
    const credit = await createAppliedCredit({
      invoiceId,
      amountMinor: 1000,
      receivableMinor: 1000,
      refundMinor: 0,
    });
    await postWardMedicationCreditEntry({
      creditNote: {
        id: credit.id,
        invoice_id: invoiceId,
        patient_uid: patientUid,
        source_financial_event_id: credit.sourceFinancialEventId,
        amount_minor: 1000,
        receivable_credit_minor: 1000,
        refund_obligation_minor: 0,
      },
      tenantId,
    });

    const result = await reconcileLedger(tenantId, { mode: 'shadow' });

    expect(result.mismatches.find((item) => item.invoiceId === invoiceId)).toBeUndefined();
    expect(result.unwired.find((item) => item.invoiceId === invoiceId)).toBeUndefined();
    expect(result.eventsDrift.find((item) => item.creditNoteId === credit.id)).toBeUndefined();
    expect(result.eventsDrift.find((item) => item.invoiceId === invoiceId)).toBeUndefined();
  });

  test('accepts a draft-applied credit represented once in the net invoice-issue entry', async () => {
    const invoiceId = await createInvoice({
      status: 'ISSUED',
      total: 100,
      paid: 0,
      credit: 20,
      due: 80,
    });
    await postInvoiceIssueEntry({
      invoice: {
        id: invoiceId,
        patient_uid: patientUid,
        total_amount: '80.00',
        tax_amount: '0.00',
      },
      tenantId,
    });
    const credit = await createAppliedCredit({
      invoiceId,
      amountMinor: 2000,
      receivableMinor: 2000,
      refundMinor: 0,
      autoAppliedDraft: true,
    });

    const result = await reconcileLedger(tenantId, { mode: 'shadow' });

    expect(result.mismatches.find((item) => item.invoiceId === invoiceId)).toBeUndefined();
    expect(result.unwired.find((item) => item.invoiceId === invoiceId)).toBeUndefined();
    expect(result.eventsDrift.find((item) => item.creditNoteId === credit.id)).toBeUndefined();
    expect(result.eventsDrift.find((item) => item.invoiceId === invoiceId)).toBeUndefined();
  });
});
