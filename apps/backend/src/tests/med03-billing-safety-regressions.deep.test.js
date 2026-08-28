import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import prisma from '../lib/prisma.js';
import {
  applyBillingCreditNote,
  approveBillingCreditNote,
  listBillingCreditNotes,
} from '../services/billing/billingCreditNoteService.js';
import {
  addInvoiceItem,
  collectPayment,
  createDraftInvoice,
  issueInvoice,
  removeInvoiceItem,
} from '../services/billing/billingV2Service.js';
import {
  approveWardIndent,
  createWardIndent,
  issueWardIndent,
  receiveWardIndent,
  reconcileWardIndent,
  requestWardIndentReturn,
  reserveWardIndent,
} from '../services/ipd/ipdSupportService.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb('MED-03 billing safety regressions', () => {
  const tenantId = randomUUID();
  const requester = randomUUID();
  const pharmacist = randomUUID();
  const receiver = randomUUID();
  const billingOwner = randomUUID();
  const admin = randomUUID();
  const patient = randomUUID();
  const otherPatient = randomUUID();
  const issueRacePatient = randomUUID();
  const run = `${process.pid}-${Date.now()}`;
  let previousLedgerMode;
  let wardId;
  let catalogId;

  async function cleanupTenant() {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      for (const table of [
        'payment_gateway_webhook_events',
        'payment_gateway_refunds',
        'payment_gateway_orders',
        'payment_gateway_provider_configs',
        'ledger_postings',
        'ledger_entries',
        'ledger_balances',
        'ledger_accounts',
        'idempotency_keys',
        'task_comments',
        'tasks',
        'notification_outbox',
        'workflow_sla_instances',
        'billing_credit_note_events',
        'billing_credit_notes',
        'billing_refunds',
        'tpa_claims',
        'insurance_preauth',
        'insurance_policies',
        'ward_indent_financial_events',
        'ward_indent_inventory_movement_links',
        'ward_indent_inventory_allocations',
        'ward_indent_inventory_receipt_events',
        'ward_indent_events',
        'clinical_timeline_events',
        'clinical_audit_events',
        'billing_payments',
        'billing_invoice_items',
        'billing_invoices',
        'pharmacy_schedule_register',
        'pharmacy_stock_movements',
        'pharmacy_inventory_batches',
        'pharmacy_inventory_items',
        'ward_indent_items',
        'ward_indents',
        'admissions',
        'pharmacy_catalog',
        'wards',
        'audit_logs',
        'users',
      ]) {
        await tx.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = $1::uuid`,
          tenantId,
        );
      }
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'origin'`);
      await tx.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = $1::uuid`,
        tenantId,
      );
    }, { timeout: 30_000 });
  }

  async function createWardCharge(label) {
    const indent = await createWardIndent({
      wardId,
      patientUid: patient,
      indentType: 'pharmacy',
      items: [{
        pharmacy_catalog_id: catalogId,
        item_name: 'Caller text is not authoritative',
        quantity_requested: 2,
      }],
      requestedBy: requester,
      commandKey: `${label}-create-${run}`,
      tenantId,
    });
    const reserved = await reserveWardIndent({
      indentId: indent.id,
      reservedBy: pharmacist,
      expectedVersion: 1,
      commandKey: `${label}-reserve-${run}`,
      tenantId,
    });
    const approved = await approveWardIndent({
      indentId: indent.id,
      approvedBy: pharmacist,
      expectedVersion: reserved.state_version,
      commandKey: `${label}-approve-indent-${run}`,
      tenantId,
    });
    const issued = await issueWardIndent({
      indentId: indent.id,
      issuedBy: pharmacist,
      expectedVersion: approved.state_version,
      commandKey: `${label}-issue-indent-${run}`,
      tenantId,
    });
    const chargeRows = await prisma.$queryRawUnsafe(
      `SELECT invoice_id
         FROM ward_indent_financial_events
        WHERE tenant_id = $1::uuid
          AND ward_indent_id = $2::int
          AND event_kind = 'charge'`,
      tenantId,
      Number(indent.id),
    );
    expect(chargeRows).toHaveLength(1);
    return { indent, issued, invoiceId: Number(chargeRows[0].invoice_id) };
  }

  async function applyReturnedUnitCredit(label, charge, { refundMode = null } = {}) {
    const received = await receiveWardIndent({
      indentId: charge.indent.id,
      receivedBy: receiver,
      expectedVersion: charge.issued.state_version,
      commandKey: `${label}-receive-${run}`,
      tenantId,
    });
    const returnPending = await requestWardIndentReturn({
      indentId: charge.indent.id,
      requestedBy: receiver,
      itemQuantitiesReturned: [{
        item_id: charge.indent.items[0].id,
        quantity_returned: 1,
      }],
      reason: 'One unused unit returned to its exact batch',
      expectedVersion: received.state_version,
      commandKey: `${label}-return-${run}`,
      tenantId,
    });
    await reconcileWardIndent({
      indentId: charge.indent.id,
      reconciledBy: pharmacist,
      reason: 'Exact batch return reconciled',
      expectedVersion: returnPending.state_version,
      commandKey: `${label}-reconcile-${run}`,
      tenantId,
    });

    const note = (await listBillingCreditNotes({ tenantId }))
      .find((candidate) => Number(candidate.ward_indent_id) === Number(charge.indent.id));
    expect(note).toMatchObject({
      invoice_id: charge.invoiceId,
      amount_minor: 1250,
    });
    if (note.status === 'applied') {
      return { note, applied: note };
    }
    expect(note.status).toBe('pending');
    await approveBillingCreditNote(note.id, {
      tenantId,
      approvedBy: billingOwner,
      commandKey: `${label}-approve-credit-${run}`,
    });
    const applied = await applyBillingCreditNote(note.id, {
      tenantId,
      appliedBy: billingOwner,
      refundMode,
      commandKey: `${label}-apply-credit-${run}`,
    });
    return { note, applied };
  }

  async function seedFinalCashlessClaim(invoiceId, totalAmount) {
    const policy = (await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_policies
         (tenant_id, patient_uid, policy_number, status, created_by)
       VALUES ($1::uuid, $2::uuid, $3::text, 'active', $4::uuid)
       RETURNING id`,
      tenantId,
      patient,
      `MED03-POLICY-${run}`,
      billingOwner,
    ))[0];
    const preauth = (await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_preauth
         (tenant_id, policy_id, patient_uid, preauth_number,
          primary_diagnosis, expected_cost, status, sanctioned_amount,
          sanctioned_at, created_by)
       VALUES ($1::uuid, $2::int, $3::uuid, $4::text,
               'Medication benefit', $5::numeric, 'approved', $5::numeric,
               NOW(), $6::uuid)
       RETURNING id`,
      tenantId,
      Number(policy.id),
      patient,
      `MED03-PREAUTH-${run}`,
      totalAmount,
      billingOwner,
    ))[0];
    await prisma.$executeRawUnsafe(
      `INSERT INTO tpa_claims
         (tenant_id, claim_number, policy_id, preauth_id, invoice_id,
          patient_uid, claim_type, stage, total_billed, claimed_amount,
          status, submitted_at, submitted_by, created_by)
       VALUES ($1::uuid, $2::text, $3::int, $4::int, $5::int,
               $6::uuid, 'cashless', 'final', $7::numeric, $7::numeric,
               'submitted', NOW(), $8::uuid, $8::uuid)`,
      tenantId,
      `MED03-CLAIM-${run}`,
      Number(policy.id),
      Number(preauth.id),
      Number(invoiceId),
      patient,
      totalAmount,
      billingOwner,
    );
  }

  beforeAll(async () => {
    previousLedgerMode = process.env.LEDGER_AUTHORITATIVE_MODE;
    process.env.LEDGER_AUTHORITATIVE_MODE = 'enforce';
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid, $2::text, 'MED-03 Billing Safety', 'IN', 'active', NOW(), NOW())`,
      tenantId,
      `med03-billing-safety-${run}`,
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
          ($1::uuid, $9::uuid, 'Request Nurse', 'IP_STAFF_NURSE', TRUE, 'active', NOW()),
          ($2::uuid, $9::uuid, 'Pharmacist', 'PHARMACY_INCHARGE', TRUE, 'active', NOW()),
          ($3::uuid, $9::uuid, 'Receipt Nurse', 'NURSING_INCHARGE', TRUE, 'active', NOW()),
          ($4::uuid, $9::uuid, 'Billing Owner', 'BILLING_INCHARGE', TRUE, 'active', NOW()),
          ($5::uuid, $9::uuid, 'Admin Approver', 'ADMIN', TRUE, 'active', NOW()),
          ($6::uuid, $9::uuid, 'Patient', 'PATIENT', TRUE, 'active', NOW()),
          ($7::uuid, $9::uuid, 'Other Patient', 'PATIENT', TRUE, 'active', NOW()),
          ($8::uuid, $9::uuid, 'Issue Race Patient', 'PATIENT', TRUE, 'active', NOW())`,
      requester,
      pharmacist,
      receiver,
      billingOwner,
      admin,
      patient,
      otherPatient,
      issueRacePatient,
      tenantId,
    );
    wardId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO wards (tenant_id, name, total_beds, created_at, updated_at)
       VALUES ($1::uuid, $2::text, 10, NOW(), NOW())
       RETURNING id`,
      tenantId,
      `MED-03 Billing Safety Ward ${run}`,
    ))[0].id);
    catalogId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, is_active, stock_quantity, unit_price, price, updated_at)
       VALUES ($1::uuid, $2::text, TRUE, 20, 12.50, 12.50, NOW())
       RETURNING id`,
      tenantId,
      `MED-03 Billing Safety Medicine ${run}`,
    ))[0].id);
    const inventoryItemId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, catalog_id, unit_label,
          schedule_class, is_narcotic)
       VALUES ($1::uuid, $2::text, $3::text, $4::int, 'unit', 'OTC', FALSE)
       RETURNING id`,
      tenantId,
      `MED03-BILLING-${run}`,
      `MED-03 Billing Safety Medicine ${run}`,
      catalogId,
    ))[0].id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, expiry_date,
          received_quantity, remaining_quantity, status)
       VALUES ($1::uuid, $2::int, $3::text,
               (NOW() + INTERVAL '365 days')::date, 20, 20, 'in_stock')`,
      tenantId,
      inventoryItemId,
      `MED03-BILLING-BATCH-${run}`,
    );
  });

  afterAll(async () => {
    try {
      await cleanupTenant();
    } finally {
      if (previousLedgerMode === undefined) delete process.env.LEDGER_AUTHORITATIVE_MODE;
      else process.env.LEDGER_AUTHORITATIVE_MODE = previousLedgerMode;
      await prisma.$disconnect().catch(() => {});
    }
  }, 30_000);

  test('insurance medication credits fail before creating an uncloseable refund obligation', async () => {
    const charge = await createWardCharge('insurance-refund');
    const invoice = await issueInvoice(charge.invoiceId, { tenantId });
    await seedFinalCashlessClaim(charge.invoiceId, Number(invoice.total_amount));
    await collectPayment({
      invoice_id: charge.invoiceId,
      amount: Number(invoice.total_amount),
      mode: 'INSURANCE',
      reference: `MED03-INSURANCE-SOURCE-${run}`,
      collected_by: billingOwner,
      tenantId,
    });
    await expect(applyReturnedUnitCredit(
      'insurance-refund',
      charge,
      { refundMode: 'INSURANCE' },
    )).rejects.toMatchObject({ statusCode: 400 });

    const note = (await listBillingCreditNotes({ tenantId }))
      .find((candidate) => Number(candidate.ward_indent_id) === Number(charge.indent.id));
    expect(note).toMatchObject({
      status: 'approved',
      refund_id: null,
      refund_obligation_minor: 0,
    });
    expect((await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM billing_refunds
        WHERE tenant_id = $1::uuid
          AND invoice_id = $2::int`,
      tenantId,
      charge.invoiceId,
    ))[0].count).toBe(0);
  }, 60_000);

  test('draft medication credit issues only the net receivable and revenue in enforce mode', async () => {
    const charge = await createWardCharge('draft-credit');
    const beforeCredit = (await prisma.$queryRawUnsafe(
      `SELECT status, total_amount, credit_note_amount, amount_due
         FROM billing_invoices
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      tenantId,
      charge.invoiceId,
    ))[0];
    expect(beforeCredit.status).toBe('DRAFT');
    expect(Number(beforeCredit.total_amount)).toBe(25);

    const { note, applied } = await applyReturnedUnitCredit('draft-credit', charge);
    expect(applied).toMatchObject({
      status: 'applied',
      receivable_credit_minor: 1250,
      refund_obligation_minor: 0,
      refund_id: null,
    });
    expect((await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM ledger_entries
        WHERE tenant_id = $1::uuid
          AND idempotency_key IN ($2::text, $3::text)`,
      tenantId,
      `ward-medication-credit-${note.id}`,
      `issue-inv-${charge.invoiceId}`,
    ))[0].count).toBe(0);

    await issueInvoice(charge.invoiceId, { tenantId });
    const persisted = (await prisma.$queryRawUnsafe(
      `SELECT status, total_amount, credit_note_amount, amount_due
         FROM billing_invoices
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      tenantId,
      charge.invoiceId,
    ))[0];
    expect(persisted.status).toBe('ISSUED');
    expect(Number(persisted.total_amount)).toBe(25);
    expect(Number(persisted.credit_note_amount)).toBe(12.5);
    expect(Number(persisted.amount_due)).toBe(12.5);

    const entries = await prisma.$queryRawUnsafe(
      `SELECT id, entry_type
         FROM ledger_entries
        WHERE tenant_id = $1::uuid AND idempotency_key = $2::text`,
      tenantId,
      `issue-inv-${charge.invoiceId}`,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].entry_type).toBe('INVOICE_ISSUE');
    const postings = await prisma.$queryRawUnsafe(
      `SELECT account.code, posting.amount_paise::text,
              posting.patient_uid::text, posting.invoice_id
         FROM ledger_postings posting
         JOIN ledger_accounts account
           ON account.id = posting.account_id
        WHERE posting.tenant_id = $1::uuid
          AND posting.entry_id = $2::bigint
        ORDER BY account.code`,
      tenantId,
      entries[0].id,
    );
    expect(postings.map((posting) => ({
      code: posting.code,
      amountPaise: Number(posting.amount_paise),
      patientUid: posting.patient_uid,
      invoiceId: posting.invoice_id == null ? null : Number(posting.invoice_id),
    }))).toEqual([
      {
        code: 'PATIENT_AR',
        amountPaise: 1250,
        patientUid: patient,
        invoiceId: charge.invoiceId,
      },
      {
        code: 'REVENUE',
        amountPaise: -1250,
        patientUid: null,
        invoiceId: null,
      },
    ]);
    expect(postings.reduce(
      (sum, posting) => sum + Number(posting.amount_paise),
      0,
    )).toBe(0);
    expect((await prisma.$queryRawUnsafe(
      `SELECT COALESCE(SUM(posting.amount_paise), 0)::text AS net
         FROM ledger_postings posting
         JOIN ledger_accounts account
           ON account.id = posting.account_id
        WHERE posting.tenant_id = $1::uuid
          AND posting.invoice_id = $2::int
          AND account.code = 'PATIENT_AR'`,
      tenantId,
      charge.invoiceId,
    ))[0].net).toBe('1250');
    expect((await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM ledger_entries
        WHERE tenant_id = $1::uuid
          AND idempotency_key = $2::text`,
      tenantId,
      `ward-medication-credit-${note.id}`,
    ))[0].count).toBe(0);
  }, 60_000);

  test('a close transaction that wins the admission lock prevents a concurrent item removal', async () => {
    const admission = (await prisma.$queryRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, status, ward, created_by, admitted_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'admitted', $3::text, $4::uuid, NOW(), NOW())
       RETURNING id`,
      tenantId,
      patient,
      `MED-03 Close Race Ward ${run}`,
      requester,
    ))[0];
    const invoice = await createDraftInvoice({
      patient_uid: patient,
      admission_id: Number(admission.id),
      invoice_type: 'IP',
      created_by: billingOwner,
      tenantId,
    });
    const item = await addInvoiceItem(invoice.id, {
      description: 'Admission-scoped medication charge',
      quantity: 1,
      unit_price: 100,
      gst_rate: 0,
      tenantId,
    });
    const invoiceBefore = (await prisma.$queryRawUnsafe(
      `SELECT subtotal, total_amount, amount_due
         FROM billing_invoices
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      tenantId,
      Number(invoice.id),
    ))[0];

    let removalOutcomePromise;
    let observedAdmissionLockWait = false;
    const blocker = new Client({ connectionString: databaseUrl });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        `SELECT id
           FROM admissions
          WHERE tenant_id = $1::uuid AND id = $2::int
          FOR UPDATE`,
        [tenantId, Number(admission.id)],
      );
      removalOutcomePromise = removeInvoiceItem(invoice.id, item.id, { tenantId })
        .then((value) => ({ status: 'fulfilled', value }))
        .catch((reason) => ({ status: 'rejected', reason }));

      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !observedAdmissionLockWait) {
        const waiting = await blocker.query(
          `SELECT EXISTS (
             SELECT 1
              FROM pg_stat_activity
             WHERE datname = current_database()
               AND pid <> pg_backend_pid()
                AND pg_backend_pid() = ANY(pg_blocking_pids(pid))
           ) AS waiting`,
        );
        observedAdmissionLockWait = Boolean(waiting.rows[0].waiting);
        if (!observedAdmissionLockWait) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      await blocker.query(
        `UPDATE admissions
            SET billing_closed_at = NOW(), updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        [tenantId, Number(admission.id)],
      );
      await blocker.query('COMMIT');
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      await blocker.end();
    }

    const removalOutcome = await removalOutcomePromise;
    expect(observedAdmissionLockWait).toBe(true);
    expect(removalOutcome.status).toBe('rejected');
    expect(removalOutcome.reason).toMatchObject({
      statusCode: 409,
      code: 'BILLING_CLOSED',
    });
    expect((await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM billing_invoice_items
        WHERE tenant_id = $1::uuid
          AND invoice_id = $2::int
          AND id = $3::int`,
      tenantId,
      Number(invoice.id),
      Number(item.id),
    ))[0].count).toBe(1);
    expect((await prisma.$queryRawUnsafe(
      `SELECT subtotal, total_amount, amount_due
         FROM billing_invoices
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      tenantId,
      Number(invoice.id),
    ))[0]).toEqual(invoiceBefore);
  }, 30_000);

  test('rejects a draft invoice whose admission belongs to another patient', async () => {
    const admission = (await prisma.$queryRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, status, ward, created_by, admitted_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'admitted', $3::text, $4::uuid, NOW(), NOW())
       RETURNING id`,
      tenantId,
      otherPatient,
      `MED-03 Cross Patient Ward ${run}`,
      requester,
    ))[0];

    await expect(createDraftInvoice({
      patient_uid: patient,
      admission_id: Number(admission.id),
      invoice_type: 'IP',
      created_by: billingOwner,
      tenantId,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'BILLING_ADMISSION_PATIENT_MISMATCH',
    });
    expect((await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM billing_invoices
        WHERE tenant_id = $1::uuid
          AND admission_id = $2::int`,
      tenantId,
      Number(admission.id),
    ))[0].count).toBe(0);
  }, 30_000);

  test('a close transaction that wins the admission lock prevents concurrent invoice issue', async () => {
    const admission = (await prisma.$queryRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, status, ward, created_by, admitted_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'admitted', $3::text, $4::uuid, NOW(), NOW())
       RETURNING id`,
      tenantId,
      issueRacePatient,
      `MED-03 Issue Close Race Ward ${run}`,
      requester,
    ))[0];
    const invoice = await createDraftInvoice({
      patient_uid: issueRacePatient,
      admission_id: Number(admission.id),
      invoice_type: 'IP',
      created_by: billingOwner,
      tenantId,
    });
    await addInvoiceItem(invoice.id, {
      description: 'Admission-scoped medication charge awaiting issue',
      quantity: 1,
      unit_price: 100,
      gst_rate: 0,
      tenantId,
    });

    let issueOutcomePromise;
    let observedAdmissionLockWait = false;
    const blocker = new Client({ connectionString: databaseUrl });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        `SELECT id
           FROM admissions
          WHERE tenant_id = $1::uuid AND id = $2::int
          FOR UPDATE`,
        [tenantId, Number(admission.id)],
      );
      issueOutcomePromise = issueInvoice(invoice.id, { tenantId })
        .then((value) => ({ status: 'fulfilled', value }))
        .catch((reason) => ({ status: 'rejected', reason }));

      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !observedAdmissionLockWait) {
        const waiting = await blocker.query(
          `SELECT EXISTS (
             SELECT 1
              FROM pg_stat_activity
             WHERE datname = current_database()
               AND pid <> pg_backend_pid()
                AND pg_backend_pid() = ANY(pg_blocking_pids(pid))
           ) AS waiting`,
        );
        observedAdmissionLockWait = Boolean(waiting.rows[0].waiting);
        if (!observedAdmissionLockWait) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      await blocker.query(
        `UPDATE admissions
            SET billing_closed_at = NOW(), updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        [tenantId, Number(admission.id)],
      );
      await blocker.query('COMMIT');
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      await blocker.end();
    }

    const issueOutcome = await issueOutcomePromise;
    expect(observedAdmissionLockWait).toBe(true);
    expect(issueOutcome.status).toBe('rejected');
    expect(issueOutcome.reason).toMatchObject({
      statusCode: 409,
      code: 'BILLING_CLOSED',
    });
    expect((await prisma.$queryRawUnsafe(
      `SELECT status, issued_at, invoice_number
         FROM billing_invoices
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      tenantId,
      Number(invoice.id),
    ))[0]).toMatchObject({
      status: 'DRAFT',
      issued_at: null,
      invoice_number: null,
    });
  }, 30_000);
});
