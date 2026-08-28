import { createHash, randomUUID } from 'node:crypto';

import prisma from '../lib/prisma.js';
import {
  approveWardIndent,
  createWardIndent,
  issueWardIndent,
  receiveWardIndent,
  reconcileWardIndent,
  requestWardIndentReturn,
  reserveWardIndent,
} from '../services/ipd/ipdSupportService.js';
import {
  applyBillingCreditNote,
  approveBillingCreditNote,
  listBillingCreditNotes,
  rejectBillingCreditNote,
} from '../services/billing/billingCreditNoteService.js';
import {
  approveRefund,
  collectPayment,
  issueInvoice,
  markRefundPaid,
  rejectRefund,
} from '../services/billing/billingV2Service.js';
import { administerWithScan } from '../services/clinical/marFiveRightsService.js';
import { holdMedication, recordMissed } from '../services/clinical/marService.js';
import { acknowledgeTask, claimInboxTask } from '../services/workflow/taskService.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

function sqlState(error) {
  return error?.meta?.code
    || error?.meta?.driverAdapterError?.cause?.code
    || error?.meta?.driverAdapterError?.cause?.originalCode
    || error?.code;
}

describeIfDb('MED-03 ward medication credit-note closure', () => {
  const tenantId = randomUUID();
  const requester = randomUUID();
  const pharmacist = randomUUID();
  const receiver = randomUUID();
  const billingOwner = randomUUID();
  const financeOwner = randomUUID();
  const admin = randomUUID();
  const patient = randomUUID();
  const run = `${process.pid}-${Date.now()}`;
  let wardId;
  let catalogId;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid, $2::text, 'MED-03 Credit Test', 'IN', 'active', NOW(), NOW())`,
      tenantId,
      `med03-credit-${run}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $8::uuid, 'Request Nurse', 'IP_STAFF_NURSE', TRUE, 'active', NOW()),
         ($2::uuid, $8::uuid, 'Pharmacist', 'PHARMACY_INCHARGE', TRUE, 'active', NOW()),
         ($3::uuid, $8::uuid, 'Receipt Nurse', 'NURSING_INCHARGE', TRUE, 'active', NOW()),
         ($4::uuid, $8::uuid, 'Billing Owner', 'BILLING_INCHARGE', TRUE, 'active', NOW()),
         ($5::uuid, $8::uuid, 'Finance Owner', 'FINANCE_INCHARGE', TRUE, 'active', NOW()),
         ($6::uuid, $8::uuid, 'Admin Approver', 'ADMIN', TRUE, 'active', NOW()),
         ($7::uuid, $8::uuid, 'Patient', 'PATIENT', TRUE, 'active', NOW())`,
      requester,
      pharmacist,
      receiver,
      billingOwner,
      financeOwner,
      admin,
      patient,
      tenantId,
    );
    wardId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO wards (tenant_id, name, total_beds, created_at, updated_at)
       VALUES ($1::uuid, $2::text, 10, NOW(), NOW())
       RETURNING id`,
      tenantId,
      `MED-03 Credit Ward ${run}`,
    ))[0].id);
    catalogId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, is_active, stock_quantity, unit_price, price,
          strength, strength_key, form, form_key, route, updated_at)
       VALUES ($1::uuid, $2::text, TRUE, 20, 12.50, 12.50,
               '500 mg', '500mg', 'tablet', 'tablet', 'oral', NOW())
       RETURNING id`,
      tenantId,
      `MED-03 Credit Medicine ${run}`,
    ))[0].id);
    const inventoryItemId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, catalog_id, strength, form,
          unit_label, schedule_class, is_narcotic)
       VALUES ($1::uuid, $2::text, $3::text, $4::int, '500 mg', 'tablet',
               'unit', 'OTC', FALSE)
       RETURNING id`,
      tenantId,
      `MED03-CREDIT-${run}`,
      `MED-03 Credit Medicine ${run}`,
      catalogId,
    ))[0].id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, expiry_date,
          received_quantity, remaining_quantity, status)
       VALUES ($1::uuid, $2::int, $3::text, (NOW() + INTERVAL '365 days')::date,
               20, 20, 'in_stock')`,
      tenantId,
      inventoryItemId,
      `MED03-CREDIT-BATCH-${run}`,
    );
  });

  afterAll(async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      for (const table of [
        'idempotency_keys',
        'task_comments',
        'tasks',
        'notification_outbox',
        'workflow_sla_instances',
        'billing_credit_note_events',
        'billing_credit_notes',
        'billing_refunds',
        'ward_indent_financial_events',
        'mar_administration_command_receipts',
        'mar_transition_command_receipts',
        'mar_supply_consumptions',
        'medication_administrations',
        'ward_indent_inventory_movement_links',
        'ward_indent_inventory_allocations',
        'ward_indent_events',
        'clinical_timeline_events',
        'clinical_audit_events',
        'billing_payments',
        'billing_invoice_items',
        'billing_invoices',
        'pharmacy_stock_movements',
        'pharmacy_inventory_batches',
        'pharmacy_inventory_items',
        'ward_indent_items',
        'ward_indents',
        'clinical_orders',
        'pharmacy_catalog',
        'wards',
        'users',
      ]) {
        await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, tenantId);
      }
      await tx.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, tenantId);
    });
    if (typeof prisma.$disconnect === 'function') await prisma.$disconnect();
  });

  test('keeps ownership through approval and evidence-completes only after application', async () => {
    const created = await createWardIndent({
      wardId,
      patientUid: patient,
      indentType: 'pharmacy',
      items: [{
        pharmacy_catalog_id: catalogId,
        item_name: 'Caller name is not authoritative',
        quantity_requested: 2,
      }],
      requestedBy: requester,
      commandKey: `create-${run}`,
      tenantId,
    });
    const reserved = await reserveWardIndent({
      indentId: created.id,
      reservedBy: pharmacist,
      expectedVersion: 1,
      commandKey: `reserve-${run}`,
      tenantId,
    });
    const approved = await approveWardIndent({
      indentId: created.id,
      approvedBy: pharmacist,
      expectedVersion: reserved.state_version,
      commandKey: `approve-${run}`,
      tenantId,
    });
    const issued = await issueWardIndent({
      indentId: created.id,
      issuedBy: pharmacist,
      expectedVersion: approved.state_version,
      commandKey: `issue-${run}`,
      tenantId,
    });
    const charge = (await prisma.$queryRawUnsafe(
      `SELECT invoice_id
         FROM ward_indent_financial_events
        WHERE tenant_id = $1::uuid
          AND ward_indent_id = $2::int
          AND event_kind = 'charge'
        LIMIT 1`,
      tenantId,
      Number(created.id),
    ))[0];
    await issueInvoice(Number(charge.invoice_id), { tenantId });
    const received = await receiveWardIndent({
      indentId: created.id,
      receivedBy: receiver,
      expectedVersion: issued.state_version,
      commandKey: `receive-${run}`,
      tenantId,
    });
    const returnPending = await requestWardIndentReturn({
      indentId: created.id,
      requestedBy: receiver,
      itemQuantitiesReturned: [{ item_id: created.items[0].id, quantity_returned: 1 }],
      reason: 'One unit unused',
      expectedVersion: received.state_version,
      commandKey: `return-${run}`,
      tenantId,
    });
    await reconcileWardIndent({
      indentId: created.id,
      reconciledBy: pharmacist,
      reason: 'Unused stock returned to exact batch',
      expectedVersion: returnPending.state_version,
      commandKey: `reconcile-${run}`,
      tenantId,
    });

    const pending = await listBillingCreditNotes({ tenantId, status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      ward_indent_id: created.id,
      invoice_id: Number(charge.invoice_id),
      amount_minor: 1250,
    });
    const taskRows = await prisma.$queryRawUnsafe(
      `SELECT task.id, task.status, task.assigned_to_role,
              task.sla_completion_semantics, task.workflow_sla_instance_id,
              task.metadata->'owner_role_codes' AS owner_role_codes,
              sla.rule_code, sla.due_at
         FROM tasks task
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid
          AND task.metadata->>'obligation_kind' = 'credit_note_review'
          AND task.metadata->>'credit_note_id' = $2::text`,
      tenantId,
      String(pending[0].id),
    );
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]).toMatchObject({
      status: 'open',
      assigned_to_role: 'BILLING_INCHARGE',
      owner_role_codes: ['BILLING_INCHARGE', 'FINANCE_INCHARGE'],
      sla_completion_semantics: 'domain_evidence',
      rule_code: 'ward_indent_credit_note_review',
    });
    expect(Number(pending[0].task_id)).toBe(Number(taskRows[0].id));
    expect((await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND source_table = 'billing_credit_notes'
          AND source_id = $2::text
          AND rule_code = 'ward_indent_credit_note_review'`,
      tenantId,
      String(pending[0].id),
    ))[0].count).toBe(1);
    expect((await prisma.$queryRawUnsafe(
      `SELECT id
         FROM notification_outbox
        WHERE tenant_id = $1::uuid
          AND recipient_id = (
            SELECT id::text FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid
          )
          AND payload->>'credit_note_id' = $3::text`,
      tenantId,
      billingOwner,
      String(pending[0].id),
    ))).toHaveLength(1);

    await claimInboxTask({
      tenantId,
      id: Number(taskRows[0].id),
      actorUid: billingOwner,
      actorRoles: ['BILLING_INCHARGE'],
      actorPrimaryRole: 'BILLING_INCHARGE',
      actorRawRole: 'BILLING_INCHARGE',
      idempotencyKey: `credit-review-claim-${run}`,
    });
    const acknowledgedReview = await acknowledgeTask({
      tenantId,
      id: Number(taskRows[0].id),
      actorUid: billingOwner,
      actorRoles: ['BILLING_INCHARGE'],
      actorPrimaryRole: 'BILLING_INCHARGE',
      actorRawRole: 'BILLING_INCHARGE',
    });
    expect(acknowledgedReview).toMatchObject({
      status: 'in_progress',
      assigned_to_uid: billingOwner,
      metadata: {
        acknowledged_by: billingOwner,
        role_claimed_by: billingOwner,
      },
    });

    const approvedAttempts = await Promise.all(Array.from({ length: 4 }, () => (
      approveBillingCreditNote(pending[0].id, {
        tenantId,
        approvedBy: billingOwner,
        commandKey: `credit-approve-${run}`,
      })
    )));
    const approvedNote = approvedAttempts[0];
    expect(approvedAttempts).toEqual(Array(4).fill(approvedNote));
    expect(approvedNote.status).toBe('approved');
    const applicationTask = (await prisma.$queryRawUnsafe(
      `SELECT task.status, task.title, task.metadata AS task_metadata,
              sla.completed_at, sla.metadata AS sla_metadata
         FROM tasks task
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid
          AND task.id = $2::int`,
      tenantId,
      Number(taskRows[0].id),
    ))[0];
    expect(applicationTask).toMatchObject({
      status: 'in_progress',
      title: 'Apply approved ward medication credit note',
      completed_at: null,
      task_metadata: {
        evidence_kind: 'billing_credit_note_application',
        credit_note_stage: 'approved',
        acknowledged_by: billingOwner,
        role_claimed_by: billingOwner,
      },
    });

    const applicationAttempts = await Promise.all(Array.from({ length: 4 }, () => (
      applyBillingCreditNote(pending[0].id, {
        tenantId,
        appliedBy: billingOwner,
        commandKey: `credit-apply-${run}`,
      })
    )));
    const applied = applicationAttempts[0];
    expect(applicationAttempts).toEqual(Array(4).fill(applied));
    expect(applied).toMatchObject({
      status: 'applied',
      receivable_credit_minor: 1250,
      refund_obligation_minor: 0,
    });
    await expect(approveBillingCreditNote(pending[0].id, {
      tenantId,
      approvedBy: billingOwner,
      commandKey: `credit-approve-${run}`,
    })).resolves.toEqual(applied);
    const completedTask = (await prisma.$queryRawUnsafe(
      `SELECT task.status, sla.completed_at, sla.metadata
         FROM tasks task
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid
          AND task.id = $2::int`,
      tenantId,
      Number(taskRows[0].id),
    ))[0];
    expect(completedTask.status).toBe('completed');
    expect(completedTask.completed_at).not.toBeNull();
    expect(completedTask.metadata).toMatchObject({
      completed_via: 'domain_evidence',
      completion_evidence: {
        kind: 'billing_credit_note_application',
        event_type: 'applied',
      },
    });
    const invoice = (await prisma.$queryRawUnsafe(
      `SELECT credit_note_amount, amount_due
         FROM billing_invoices
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      tenantId,
      Number(charge.invoice_id),
    ))[0];
    expect(Number(invoice.credit_note_amount)).toBe(12.5);
    expect(Number(invoice.amount_due)).toBe(12.5);
  });

  test('binds rejection command replay to the normalized reason and original actor', async () => {
    const created = await createWardIndent({
      wardId,
      patientUid: patient,
      indentType: 'pharmacy',
      items: [{
        pharmacy_catalog_id: catalogId,
        item_name: 'Caller name is not authoritative',
        quantity_requested: 2,
      }],
      requestedBy: requester,
      commandKey: `reject-create-${run}`,
      tenantId,
    });
    const reserved = await reserveWardIndent({
      indentId: created.id,
      reservedBy: pharmacist,
      expectedVersion: 1,
      commandKey: `reject-reserve-${run}`,
      tenantId,
    });
    const approved = await approveWardIndent({
      indentId: created.id,
      approvedBy: pharmacist,
      expectedVersion: reserved.state_version,
      commandKey: `reject-indent-approve-${run}`,
      tenantId,
    });
    const issued = await issueWardIndent({
      indentId: created.id,
      issuedBy: pharmacist,
      expectedVersion: approved.state_version,
      commandKey: `reject-issue-${run}`,
      tenantId,
    });
    const charge = (await prisma.$queryRawUnsafe(
      `SELECT invoice_id
         FROM ward_indent_financial_events
        WHERE tenant_id = $1::uuid
          AND ward_indent_id = $2::int
          AND event_kind = 'charge'
        LIMIT 1`,
      tenantId,
      Number(created.id),
    ))[0];
    await issueInvoice(Number(charge.invoice_id), { tenantId });
    const received = await receiveWardIndent({
      indentId: created.id,
      receivedBy: receiver,
      expectedVersion: issued.state_version,
      commandKey: `reject-receive-${run}`,
      tenantId,
    });
    const returnPending = await requestWardIndentReturn({
      indentId: created.id,
      requestedBy: receiver,
      itemQuantitiesReturned: [{ item_id: created.items[0].id, quantity_returned: 1 }],
      reason: 'Credit requires separate finance review',
      expectedVersion: received.state_version,
      commandKey: `reject-return-${run}`,
      tenantId,
    });
    await reconcileWardIndent({
      indentId: created.id,
      reconciledBy: pharmacist,
      reason: 'Returned batch reconciled before finance rejection',
      expectedVersion: returnPending.state_version,
      commandKey: `reject-reconcile-${run}`,
      tenantId,
    });
    const pending = (await listBillingCreditNotes({ tenantId, status: 'pending' }))
      .find((note) => Number(note.ward_indent_id) === Number(created.id));
    expect(pending).toBeDefined();

    const forgedCommandKey = `forged-approve-${run}`;
    const encodedForgedKey = `billing-credit-note:${pending.id}:approve:${forgedCommandKey}`;
    const emptyRequestHash = createHash('sha256').update('{}').digest('hex');
    let prematureEventError;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO billing_credit_note_events
           (tenant_id, credit_note_id, event_type, actor_uid, command_key,
            request_body_sha256, details)
         VALUES ($1::uuid, $2::bigint, 'approved', $3::uuid, $4::text,
                 $5::text, '{}'::jsonb)`,
        tenantId,
        BigInt(pending.id),
        billingOwner,
        `${encodedForgedKey}:blocked`,
        emptyRequestHash,
      );
    } catch (error) {
      prematureEventError = error;
    }
    expect(sqlState(prematureEventError)).toBe('23514');

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      await tx.$executeRawUnsafe(
        `INSERT INTO billing_credit_note_events
           (tenant_id, credit_note_id, event_type, actor_uid, command_key,
            request_body_sha256, details)
         VALUES ($1::uuid, $2::bigint, 'approved', $3::uuid, $4::text,
                 $5::text, '{}'::jsonb)`,
        tenantId,
        BigInt(pending.id),
        billingOwner,
        encodedForgedKey,
        emptyRequestHash,
      );
    });
    await expect(approveBillingCreditNote(pending.id, {
      tenantId,
      approvedBy: billingOwner,
      commandKey: forgedCommandKey,
    })).rejects.toMatchObject({
      code: 'BILLING_CREDIT_NOTE_IDEMPOTENCY_STATE_CONFLICT',
      statusCode: 409,
    });

    const commandKey = `credit-reject-${run}`;
    const rejected = await rejectBillingCreditNote(pending.id, {
      tenantId,
      rejectedBy: billingOwner,
      rejectionReason: 'Duplicate charge already corrected',
      commandKey,
    });
    await expect(rejectBillingCreditNote(pending.id, {
      tenantId,
      rejectedBy: billingOwner,
      rejectionReason: '  Duplicate charge already corrected  ',
      commandKey,
    })).resolves.toEqual(rejected);
    await expect(rejectBillingCreditNote(pending.id, {
      tenantId,
      rejectedBy: billingOwner,
      rejectionReason: 'Different clinical justification',
      commandKey,
    })).rejects.toMatchObject({
      code: 'BILLING_CREDIT_NOTE_IDEMPOTENCY_PAYLOAD_CONFLICT',
      statusCode: 409,
    });
    await expect(rejectBillingCreditNote(pending.id, {
      tenantId,
      rejectedBy: requester,
      rejectionReason: 'Different clinical justification',
      commandKey,
    })).rejects.toMatchObject({
      code: 'BILLING_CREDIT_NOTE_IDEMPOTENCY_ACTOR_CONFLICT',
      statusCode: 409,
    });
  });

  test('keeps the same owned SLA open until a paid-invoice credit refund is settled', async () => {
    const created = await createWardIndent({
      wardId,
      patientUid: patient,
      indentType: 'pharmacy',
      items: [{
        pharmacy_catalog_id: catalogId,
        item_name: 'Caller name is not authoritative',
        quantity_requested: 2,
      }],
      requestedBy: requester,
      commandKey: `refund-create-${run}`,
      tenantId,
    });
    const reserved = await reserveWardIndent({
      indentId: created.id,
      reservedBy: pharmacist,
      expectedVersion: 1,
      commandKey: `refund-reserve-${run}`,
      tenantId,
    });
    const approved = await approveWardIndent({
      indentId: created.id,
      approvedBy: pharmacist,
      expectedVersion: reserved.state_version,
      commandKey: `refund-approve-indent-${run}`,
      tenantId,
    });
    const issued = await issueWardIndent({
      indentId: created.id,
      issuedBy: pharmacist,
      expectedVersion: approved.state_version,
      commandKey: `refund-issue-${run}`,
      tenantId,
    });
    const charge = (await prisma.$queryRawUnsafe(
      `SELECT invoice_id
         FROM ward_indent_financial_events
        WHERE tenant_id = $1::uuid
          AND ward_indent_id = $2::int
          AND event_kind = 'charge'
        LIMIT 1`,
      tenantId,
      Number(created.id),
    ))[0];
    const invoice = await issueInvoice(Number(charge.invoice_id), { tenantId });
    await collectPayment({
      invoice_id: Number(charge.invoice_id),
      amount: Number(invoice.total_amount),
      mode: 'CHEQUE',
      reference: `MED03-REFUND-PAYMENT-${run}`,
      collected_by: billingOwner,
      tenantId,
    });
    const received = await receiveWardIndent({
      indentId: created.id,
      receivedBy: receiver,
      expectedVersion: issued.state_version,
      commandKey: `refund-receive-${run}`,
      tenantId,
    });
    const returnPending = await requestWardIndentReturn({
      indentId: created.id,
      requestedBy: receiver,
      itemQuantitiesReturned: [{ item_id: created.items[0].id, quantity_returned: 1 }],
      reason: 'One paid unit was unused',
      expectedVersion: received.state_version,
      commandKey: `refund-return-${run}`,
      tenantId,
    });
    await reconcileWardIndent({
      indentId: created.id,
      reconciledBy: pharmacist,
      reason: 'Paid unused stock returned to the exact batch',
      expectedVersion: returnPending.state_version,
      commandKey: `refund-reconcile-${run}`,
      tenantId,
    });

    const pending = (await listBillingCreditNotes({ tenantId, status: 'pending' }))
      .find((note) => Number(note.ward_indent_id) === Number(created.id));
    expect(pending).toMatchObject({
      invoice_id: Number(charge.invoice_id),
      amount_minor: 1250,
    });
    await approveBillingCreditNote(pending.id, {
      tenantId,
      approvedBy: billingOwner,
      commandKey: `refund-credit-approve-${run}`,
    });
    await expect(applyBillingCreditNote(pending.id, {
      tenantId,
      appliedBy: billingOwner,
      refundMode: 'CASH',
      commandKey: `refund-credit-apply-mismatched-tender-${run}`,
    })).rejects.toMatchObject({
      code: 'BILLING_CREDIT_NOTE_REFUND_TENDER_MISMATCH',
      statusCode: 409,
    });
    const applied = await applyBillingCreditNote(pending.id, {
      tenantId,
      appliedBy: billingOwner,
      refundMode: 'CHEQUE',
      commandKey: `refund-credit-apply-${run}`,
    });
    expect(applied).toMatchObject({
      status: 'applied',
      receivable_credit_minor: 0,
      refund_obligation_minor: 1250,
    });
    let mismatchedApplicationEventError;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO billing_credit_note_events
           (tenant_id, credit_note_id, event_type, actor_uid, command_key,
            request_body_sha256, details)
         VALUES ($1::uuid, $2::bigint, 'applied', $3::uuid, $4::text,
                 $5::text, '{}'::jsonb)`,
        tenantId,
        BigInt(pending.id),
        billingOwner,
        `billing-credit-note:${pending.id}:apply:wrong-key-${run}`,
        createHash('sha256').update('{}').digest('hex'),
      );
    } catch (error) {
      mismatchedApplicationEventError = error;
    }
    expect(sqlState(mismatchedApplicationEventError)).toBe('23514');
    await expect(applyBillingCreditNote(pending.id, {
      tenantId,
      appliedBy: billingOwner,
      refundMode: 'CHEQUE',
      commandKey: `refund-credit-apply-${run}`,
    })).resolves.toEqual(applied);
    await expect(applyBillingCreditNote(pending.id, {
      tenantId,
      appliedBy: billingOwner,
      refundMode: 'CASH',
      commandKey: `refund-credit-apply-${run}`,
    })).rejects.toMatchObject({
      code: 'BILLING_CREDIT_NOTE_IDEMPOTENCY_PAYLOAD_CONFLICT',
      statusCode: 409,
    });
    const refundId = Number(applied.refund_id);
    expect(refundId).toBeGreaterThan(0);
    const [pendingRefund] = await prisma.$queryRawUnsafe(
      `SELECT approval_status, reference
         FROM billing_refunds
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      tenantId,
      refundId,
    );
    expect(pendingRefund).toEqual({
      approval_status: 'PENDING',
      reference: null,
    });
    const otherApplied = (await prisma.$queryRawUnsafe(
      `SELECT id
         FROM billing_credit_notes
        WHERE tenant_id = $1::uuid
          AND id <> $2::bigint
          AND status = 'applied'
          AND refund_id IS NULL
        ORDER BY id
        LIMIT 1`,
      tenantId,
      BigInt(pending.id),
    ))[0];
    expect(otherApplied).toBeDefined();
    let duplicateRefundError;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(
          `UPDATE billing_credit_notes
              SET receivable_credit_minor = 0,
                  refund_obligation_minor = amount_minor,
                  refund_id = $1::int
            WHERE tenant_id = $2::uuid AND id = $3::bigint`,
          refundId,
          tenantId,
          otherApplied.id,
        );
      });
    } catch (error) {
      duplicateRefundError = error;
    }
    expect(sqlState(duplicateRefundError)).toBe('23505');

    const ownershipRows = await prisma.$queryRawUnsafe(
      `SELECT task.id, task.status, task.title, task.assigned_to_uid,
              task.assigned_to_role,
              task.metadata AS task_metadata, sla.completed_at,
              sla.assigned_role_codes
         FROM tasks task
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid
          AND task.metadata->>'obligation_kind' = 'credit_note_review'
          AND task.metadata->>'credit_note_id' = $2::text`,
      tenantId,
      String(pending.id),
    );
    expect(ownershipRows).toHaveLength(1);
    expect(ownershipRows[0]).toMatchObject({
      status: 'open',
      title: 'Authorize ward medication credit refund',
      assigned_to_uid: null,
      assigned_to_role: 'ADMIN',
      assigned_role_codes: ['ADMIN', 'SUPER_ADMIN'],
      completed_at: null,
      task_metadata: {
        evidence_kind: 'billing_credit_note_refund_paid',
        credit_note_stage: 'refund_approval',
        owner_role_codes: ['ADMIN', 'SUPER_ADMIN'],
        ownership_stage_version: 2,
        refund_id: refundId,
      },
    });
    expect(ownershipRows[0].task_metadata).not.toHaveProperty('acknowledged_by');
    expect(ownershipRows[0].task_metadata).not.toHaveProperty('role_claimed_by');
    expect((await prisma.$queryRawUnsafe(
      `SELECT id
         FROM notification_outbox
        WHERE tenant_id = $1::uuid
          AND recipient_id = (
            SELECT id::text FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid
          )
          AND payload->>'refund_id' = $3::text`,
      tenantId,
      admin,
      String(refundId),
    ))).toHaveLength(1);

    await claimInboxTask({
      tenantId,
      id: Number(ownershipRows[0].id),
      actorUid: admin,
      actorRoles: ['ADMIN'],
      actorPrimaryRole: 'ADMIN',
      actorRawRole: 'ADMIN',
      idempotencyKey: `refund-approval-claim-${run}`,
    });
    const acknowledgedApproval = await acknowledgeTask({
      tenantId,
      id: Number(ownershipRows[0].id),
      actorUid: admin,
      actorRoles: ['ADMIN'],
      actorPrimaryRole: 'ADMIN',
      actorRawRole: 'ADMIN',
    });
    expect(acknowledgedApproval).toMatchObject({
      status: 'in_progress',
      assigned_to_uid: admin,
      metadata: {
        acknowledged_by: admin,
        role_claimed_by: admin,
      },
    });

    await expect(rejectRefund(refundId, {
      rejected_by: admin,
      rejection_reason: 'Unsafe attempt to erase an owed patient balance',
      tenantId,
    })).rejects.toMatchObject({
      code: 'BILLING_CREDIT_NOTE_REFUND_REJECTION_FORBIDDEN',
      statusCode: 409,
    });
    const approvedRefund = await approveRefund(refundId, {
      approved_by: admin,
      tenantId,
    });
    expect(approvedRefund.approval_status).toBe('APPROVED');
    const payoutOwnership = (await prisma.$queryRawUnsafe(
      `SELECT task.status, task.title, task.assigned_to_uid,
              task.assigned_to_role,
              task.metadata AS task_metadata, sla.completed_at,
              sla.assigned_role_codes
         FROM tasks task
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid AND task.id = $2::int`,
      tenantId,
      Number(ownershipRows[0].id),
    ))[0];
    expect(payoutOwnership).toMatchObject({
      status: 'open',
      title: 'Settle approved ward medication credit refund',
      assigned_to_uid: null,
      assigned_to_role: 'FINANCE_INCHARGE',
      assigned_role_codes: ['BILLING_INCHARGE', 'FINANCE_INCHARGE'],
      completed_at: null,
      task_metadata: {
        evidence_kind: 'billing_credit_note_refund_paid',
        credit_note_stage: 'refund_payout',
        owner_role_codes: ['BILLING_INCHARGE', 'FINANCE_INCHARGE'],
        ownership_stage_version: 3,
        refund_id: refundId,
      },
    });
    expect(payoutOwnership.task_metadata).not.toHaveProperty('acknowledged_by');
    expect(payoutOwnership.task_metadata).not.toHaveProperty('role_claimed_by');
    expect((await prisma.$queryRawUnsafe(
      `SELECT id
         FROM notification_outbox
        WHERE tenant_id = $1::uuid
          AND recipient_id = (
            SELECT id::text FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid
          )
          AND payload->>'refund_id' = $3::text`,
      tenantId,
      billingOwner,
      String(refundId),
    )).length).toBeGreaterThanOrEqual(1);

    await claimInboxTask({
      tenantId,
      id: Number(ownershipRows[0].id),
      actorUid: financeOwner,
      actorRoles: ['FINANCE_INCHARGE'],
      actorPrimaryRole: 'FINANCE_INCHARGE',
      actorRawRole: 'FINANCE_INCHARGE',
      idempotencyKey: `refund-payout-claim-${run}`,
    });
    const acknowledgedPayout = await acknowledgeTask({
      tenantId,
      id: Number(ownershipRows[0].id),
      actorUid: financeOwner,
      actorRoles: ['FINANCE_INCHARGE'],
      actorPrimaryRole: 'FINANCE_INCHARGE',
      actorRawRole: 'FINANCE_INCHARGE',
    });
    expect(acknowledgedPayout).toMatchObject({
      status: 'in_progress',
      assigned_to_uid: financeOwner,
      metadata: {
        acknowledged_by: financeOwner,
        role_claimed_by: financeOwner,
      },
    });

    const handoffHistory = await prisma.$queryRawUnsafe(
      `SELECT metadata
         FROM task_comments
        WHERE tenant_id = $1::uuid
          AND task_id = $2::int
          AND metadata->>'ownership_rearmed' = 'true'
        ORDER BY id`,
      tenantId,
      Number(ownershipRows[0].id),
    );
    expect(handoffHistory).toHaveLength(2);
    expect(handoffHistory[0].metadata).toMatchObject({
      ownership_stage_version: 2,
      prior_status: 'in_progress',
      prior_acknowledgement: { acknowledged_by: billingOwner },
      prior_role_claim: { role_claimed_by: billingOwner },
    });
    expect(handoffHistory[1].metadata).toMatchObject({
      ownership_stage_version: 3,
      prior_status: 'in_progress',
      prior_acknowledgement: { acknowledged_by: admin },
      prior_role_claim: { role_claimed_by: admin },
    });

    const paidRefund = await markRefundPaid(refundId, {
      paid_by: financeOwner,
      reference: `MED03-MANUAL-PAYOUT-${run}`,
      tenantId,
    });
    expect(paidRefund).toMatchObject({
      approval_status: 'PAID',
      payout_rail: 'manual',
    });
    const completed = (await prisma.$queryRawUnsafe(
      `SELECT task.status, sla.completed_at, sla.metadata
         FROM tasks task
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid AND task.id = $2::int`,
      tenantId,
      Number(ownershipRows[0].id),
    ))[0];
    expect(completed.status).toBe('completed');
    expect(completed.completed_at).not.toBeNull();
    expect(completed.metadata).toMatchObject({
      completed_via: 'domain_evidence',
      completed_by: financeOwner,
      completion_evidence: {
        kind: 'billing_credit_note_refund_paid',
        resource_type: 'billing_refund',
        resource_id: String(refundId),
      },
    });
  });

  test('applies later valid paid-invoice credits after a large paid refund and under concurrency', async () => {
    const cases = [
      { label: 'large', issuedQuantity: 9, returnedQuantity: 8, amountMinor: 10000 },
      { label: 'sequential', issuedQuantity: 2, returnedQuantity: 1, amountMinor: 1250 },
      { label: 'concurrent-a', issuedQuantity: 2, returnedQuantity: 1, amountMinor: 1250 },
      { label: 'concurrent-b', issuedQuantity: 2, returnedQuantity: 1, amountMinor: 1250 },
    ];

    for (const scenario of cases) {
      const created = await createWardIndent({
        wardId,
        patientUid: patient,
        indentType: 'pharmacy',
        items: [{
          pharmacy_catalog_id: catalogId,
          item_name: 'Caller name is not authoritative',
          quantity_requested: scenario.issuedQuantity,
        }],
        requestedBy: requester,
        commandKey: `multi-create-${scenario.label}-${run}`,
        tenantId,
      });
      const reserved = await reserveWardIndent({
        indentId: created.id,
        reservedBy: pharmacist,
        expectedVersion: 1,
        commandKey: `multi-reserve-${scenario.label}-${run}`,
        tenantId,
      });
      const approved = await approveWardIndent({
        indentId: created.id,
        approvedBy: pharmacist,
        expectedVersion: reserved.state_version,
        commandKey: `multi-approve-${scenario.label}-${run}`,
        tenantId,
      });
      const issued = await issueWardIndent({
        indentId: created.id,
        issuedBy: pharmacist,
        expectedVersion: approved.state_version,
        commandKey: `multi-issue-${scenario.label}-${run}`,
        tenantId,
      });
      scenario.indent = created;
      scenario.issued = issued;
    }

    const chargeRows = await prisma.$queryRawUnsafe(
      `SELECT ward_indent_id, invoice_id, amount_minor
         FROM ward_indent_financial_events
        WHERE tenant_id = $1::uuid
          AND ward_indent_id = ANY($2::int[])
          AND event_kind = 'charge'
        ORDER BY ward_indent_id`,
      tenantId,
      cases.map((scenario) => Number(scenario.indent.id)),
    );
    expect(chargeRows).toHaveLength(4);
    expect(new Set(chargeRows.map((row) => Number(row.invoice_id))).size).toBe(1);
    const invoiceId = Number(chargeRows[0].invoice_id);
    expect(chargeRows.reduce((sum, row) => sum + Number(row.amount_minor), 0)).toBe(18750);

    const invoice = await issueInvoice(invoiceId, { tenantId });
    expect(Number(invoice.total_amount)).toBe(187.5);
    await collectPayment({
      invoice_id: invoiceId,
      amount: 100,
      mode: 'CHEQUE',
      reference: `MED03-MULTI-CREDIT-CHEQUE-${run}`,
      collected_by: billingOwner,
      tenantId,
    });
    await collectPayment({
      invoice_id: invoiceId,
      amount: 87.5,
      mode: 'DD',
      reference: `MED03-MULTI-CREDIT-DD-${run}`,
      collected_by: billingOwner,
      tenantId,
    });

    for (const scenario of cases) {
      const received = await receiveWardIndent({
        indentId: scenario.indent.id,
        receivedBy: receiver,
        expectedVersion: scenario.issued.state_version,
        commandKey: `multi-receive-${scenario.label}-${run}`,
        tenantId,
      });
      const returnPending = await requestWardIndentReturn({
        indentId: scenario.indent.id,
        requestedBy: receiver,
        itemQuantitiesReturned: [{
          item_id: scenario.indent.items[0].id,
          quantity_returned: scenario.returnedQuantity,
        }],
        reason: `Paid unused stock returned for ${scenario.label}`,
        expectedVersion: received.state_version,
        commandKey: `multi-return-${scenario.label}-${run}`,
        tenantId,
      });
      await reconcileWardIndent({
        indentId: scenario.indent.id,
        reconciledBy: pharmacist,
        reason: `Exact paid batch reconciled for ${scenario.label}`,
        expectedVersion: returnPending.state_version,
        commandKey: `multi-reconcile-${scenario.label}-${run}`,
        tenantId,
      });
    }

    const indentIds = new Set(cases.map((scenario) => Number(scenario.indent.id)));
    const pending = (await listBillingCreditNotes({ tenantId, status: 'pending' }))
      .filter((note) => indentIds.has(Number(note.ward_indent_id)));
    expect(pending).toHaveLength(4);
    for (const note of pending) {
      await approveBillingCreditNote(note.id, {
        tenantId,
        approvedBy: billingOwner,
        commandKey: `multi-credit-approve-${note.id}-${run}`,
      });
    }

    const large = pending.find((note) => Number(note.amount_minor) === 10000);
    const smaller = pending
      .filter((note) => Number(note.amount_minor) === 1250)
      .sort((a, b) => Number(a.id) - Number(b.id));
    expect(large).toBeDefined();
    expect(smaller).toHaveLength(3);

    const firstApplied = await applyBillingCreditNote(large.id, {
      tenantId,
      appliedBy: billingOwner,
      refundMode: 'CHEQUE',
      commandKey: `multi-credit-apply-large-${run}`,
    });
    expect(firstApplied).toMatchObject({
      status: 'applied',
      receivable_credit_minor: 0,
      refund_obligation_minor: 10000,
    });
    await approveRefund(firstApplied.refund_id, { approved_by: admin, tenantId });
    await markRefundPaid(firstApplied.refund_id, {
      paid_by: billingOwner,
      reference: `MED03-MULTI-CREDIT-PAID-${run}`,
      tenantId,
    });

    await expect(applyBillingCreditNote(smaller[0].id, {
      tenantId,
      appliedBy: billingOwner,
      refundMode: 'CHEQUE',
      commandKey: `multi-credit-apply-mismatched-${run}`,
    })).rejects.toMatchObject({
      code: 'BILLING_CREDIT_NOTE_REFUND_TENDER_MISMATCH',
      statusCode: 409,
    });

    const sequential = await applyBillingCreditNote(smaller[0].id, {
      tenantId,
      appliedBy: billingOwner,
      refundMode: 'DD',
      commandKey: `multi-credit-apply-sequential-${run}`,
    });
    expect(sequential).toMatchObject({
      status: 'applied',
      receivable_credit_minor: 0,
      refund_obligation_minor: 1250,
    });

    const concurrent = await Promise.all(smaller.slice(1).map((note) => (
      applyBillingCreditNote(note.id, {
        tenantId,
        appliedBy: billingOwner,
        refundMode: 'DD',
        commandKey: `multi-credit-apply-concurrent-${note.id}-${run}`,
      })
    )));
    expect(concurrent).toHaveLength(2);
    expect(concurrent).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'applied',
        receivable_credit_minor: 0,
        refund_obligation_minor: 1250,
      }),
      expect.objectContaining({
        status: 'applied',
        receivable_credit_minor: 0,
        refund_obligation_minor: 1250,
      }),
    ]));

    const persistedNotes = await prisma.$queryRawUnsafe(
      `SELECT id, status, receivable_credit_minor, refund_obligation_minor, refund_id
         FROM billing_credit_notes
        WHERE tenant_id = $1::uuid
          AND id = ANY($2::bigint[])
        ORDER BY id`,
      tenantId,
      pending.map((note) => BigInt(note.id)),
    );
    expect(persistedNotes).toHaveLength(4);
    expect(persistedNotes.every((note) => note.status === 'applied')).toBe(true);
    expect(persistedNotes.every((note) => Number(note.receivable_credit_minor) === 0)).toBe(true);
    expect(persistedNotes.reduce(
      (sum, note) => sum + Number(note.refund_obligation_minor),
      0,
    )).toBe(13750);
    expect(new Set(persistedNotes.map((note) => Number(note.refund_id))).size).toBe(4);

    const refunds = await prisma.$queryRawUnsafe(
      `SELECT id, amount, approval_status
         FROM billing_refunds
        WHERE tenant_id = $1::uuid
          AND invoice_id = $2::int
        ORDER BY id`,
      tenantId,
      invoiceId,
    );
    expect(refunds).toHaveLength(4);
    expect(refunds.map((refund) => refund.approval_status)).toEqual([
      'PAID',
      'PENDING',
      'PENDING',
      'PENDING',
    ]);
    expect(refunds.reduce((sum, refund) => sum + Number(refund.amount), 0)).toBe(137.5);

    const persistedInvoice = (await prisma.$queryRawUnsafe(
      `SELECT total_amount, amount_paid, credit_note_amount, amount_due
         FROM billing_invoices
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      tenantId,
      invoiceId,
    ))[0];
    expect(Number(persistedInvoice.total_amount)).toBe(187.5);
    expect(Number(persistedInvoice.amount_paid)).toBe(87.5);
    expect(Number(persistedInvoice.credit_note_amount)).toBe(137.5);
    expect(Number(persistedInvoice.amount_due)).toBe(0);
  });

  test('atomically receipts a scanned administration and replays only the exact command', async () => {
    const order = (await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_orders
         (tenant_id, order_number, patient_uid, order_type, status,
          ordered_by, details, route, updated_at)
       VALUES ($1::uuid, $2::text, $3::uuid, 'medication', 'ordered',
               $4::uuid, $5::jsonb, 'oral', NOW())
       RETURNING id`,
      tenantId,
      `MED03-MAR-${run}`,
      patient,
      requester,
      JSON.stringify({
        catalog_id: catalogId,
        dose: '1 unit',
        route: 'oral',
        strength: '500 mg',
        strength_key: '500mg',
        form: 'tablet',
        form_key: 'tablet',
      }),
    ))[0];
    const indent = await createWardIndent({
      wardId,
      patientUid: patient,
      indentType: 'pharmacy',
      items: [{
        pharmacy_catalog_id: catalogId,
        clinical_order_id: Number(order.id),
        item_name: 'Caller name is not authoritative',
        quantity_requested: 2,
      }],
      requestedBy: requester,
      commandKey: `mar-create-${run}`,
      tenantId,
    });
    const reserved = await reserveWardIndent({
      indentId: indent.id,
      reservedBy: pharmacist,
      expectedVersion: 1,
      commandKey: `mar-reserve-${run}`,
      tenantId,
    });
    const approved = await approveWardIndent({
      indentId: indent.id,
      approvedBy: pharmacist,
      expectedVersion: reserved.state_version,
      commandKey: `mar-approve-${run}`,
      tenantId,
    });
    const issued = await issueWardIndent({
      indentId: indent.id,
      issuedBy: pharmacist,
      expectedVersion: approved.state_version,
      commandKey: `mar-issue-${run}`,
      tenantId,
    });
    await receiveWardIndent({
      indentId: indent.id,
      receivedBy: receiver,
      expectedVersion: issued.state_version,
      commandKey: `mar-receive-${run}`,
      tenantId,
    });

    const administration = (await prisma.$queryRawUnsafe(
      `INSERT INTO medication_administrations
         (tenant_id, patient_uid, medication_name, dose, route,
          scheduled_time, status, clinical_order_id, supply_quantity_per_dose)
       VALUES ($1::uuid, $2::uuid, $3::text, '1 unit', 'oral', NOW(),
               'scheduled', $4::int, 1)
       RETURNING id`,
      tenantId,
      patient,
      `MED-03 Credit Medicine ${run}`,
      Number(order.id),
    ))[0];
    const commandKey = `mar-administer-${run}`;
    const requestFingerprint = 'c'.repeat(64);
    const requestPath = `/api/v1/clinical/mar/${administration.id}/administer-with-scan`;
    const claim = (await prisma.$queryRawUnsafe(
      `INSERT INTO idempotency_keys
         (tenant_id, user_uid, request_key, request_method, request_path,
          request_body_hash, status)
       VALUES ($1::uuid, $2::uuid, $3::text, 'POST', $4::text,
               $5::char(64), 'in_flight')
       RETURNING id`,
      tenantId,
      receiver,
      commandKey,
      requestPath,
      requestFingerprint,
    ))[0];

    const first = await administerWithScan({
      ma_id: Number(administration.id),
      scanned_patient_uid: patient,
      scanned_barcode: `MED03-CREDIT-BATCH-${run}`,
      administeredBy: receiver,
      commandKey,
      requestFingerprint,
      httpIdempotencyClaimId: Number(claim.id),
      requestId: `med03-mar-${run}`,
      tenantId,
    });
    expect(first).toMatchObject({
      id: Number(administration.id),
      status: 'administered',
      supply_state: { status: 'matched' },
    });
    const finalizedClaim = (await prisma.$queryRawUnsafe(
      `SELECT status, response_status, response_body
         FROM idempotency_keys
        WHERE id = $1::int`,
      Number(claim.id),
    ))[0];
    expect(finalizedClaim).toMatchObject({
      status: 'complete',
      response_status: 200,
      response_body: {
        success: true,
        requestId: `med03-mar-${run}`,
        data: { id: Number(administration.id), status: 'administered' },
      },
    });

    const replay = await administerWithScan({
      ma_id: Number(administration.id),
      scanned_patient_uid: patient,
      scanned_barcode: `MED-03 Credit Medicine ${run}`,
      administeredBy: receiver,
      commandKey,
      requestFingerprint,
      tenantId,
    });
    expect(replay).toEqual(JSON.parse(JSON.stringify(first)));
    expect((await prisma.$queryRawUnsafe(
      `SELECT id
         FROM mar_administration_command_receipts
        WHERE tenant_id = $1::uuid
          AND medication_administration_id = $2::int`,
      tenantId,
      Number(administration.id),
    ))).toHaveLength(1);
    expect((await prisma.$queryRawUnsafe(
      `SELECT id
         FROM mar_supply_consumptions
        WHERE tenant_id = $1::uuid
          AND medication_administration_id = $2::int`,
      tenantId,
      Number(administration.id),
    ))).toHaveLength(1);

    await expect(administerWithScan({
      ma_id: Number(administration.id),
      scanned_patient_uid: patient,
      scanned_barcode: `MED-03 Credit Medicine ${run}`,
      administeredBy: receiver,
      commandKey,
      requestFingerprint: 'd'.repeat(64),
      tenantId,
    })).rejects.toMatchObject({
      statusCode: 422,
      code: 'MAR_ADMINISTRATION_COMMAND_MISMATCH',
    });
  });

  test('records miss and hold attribution once and replays their atomic receipts', async () => {
    const exceptionOrder = (await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_orders
         (tenant_id, order_number, patient_uid, order_type, status,
          ordered_by, details, route, updated_at)
       VALUES ($1::uuid, $2::text, $3::uuid, 'medication', 'ordered',
               $4::uuid, $5::jsonb, 'oral', NOW())
       RETURNING id`,
      tenantId,
      `MED03-MAR-EXCEPTION-${run}`,
      patient,
      requester,
      JSON.stringify({
        medication_name: `MED-03 Exception Medicine ${run}`,
        dose: '1 unit',
        route: 'oral',
      }),
    ))[0];
    const administrations = await prisma.$queryRawUnsafe(
      `INSERT INTO medication_administrations
         (tenant_id, patient_uid, medication_name, dose, route,
          scheduled_time, status, clinical_order_id)
       VALUES
         ($1::uuid, $2::uuid, $3::text, '1 unit', 'oral',
          NOW() + INTERVAL '3 hours', 'scheduled', $5::int),
         ($1::uuid, $2::uuid, $4::text, '1 unit', 'oral',
          NOW() + INTERVAL '4 hours', 'scheduled', $5::int)
       RETURNING id, medication_name`,
      tenantId,
      patient,
      `MED-03 Miss ${run}`,
      `MED-03 Hold ${run}`,
      Number(exceptionOrder.id),
    );
    const missedId = Number(
      administrations.find((row) => row.medication_name.includes('Miss')).id,
    );
    const heldId = Number(
      administrations.find((row) => row.medication_name.includes('Hold')).id,
    );

    const cases = [
      {
        id: missedId,
        action: 'missed',
        scope: 'mar_miss',
        key: `mar-miss-${run}`,
        fingerprint: 'e'.repeat(64),
        requestPath: `/api/v1/clinical/mar/${missedId}/miss`,
        message: 'Missed medication recorded',
        invoke: (options) => recordMissed(
          missedId,
          'Patient declined after counselling',
          receiver,
          options,
        ),
      },
      {
        id: heldId,
        action: 'held',
        scope: 'mar_hold',
        key: `mar-hold-${run}`,
        fingerprint: 'f'.repeat(64),
        requestPath: `/api/v1/clinical/mar/${heldId}/hold`,
        message: 'Medication held',
        invoke: (options) => holdMedication(
          heldId,
          'Awaiting prescriber review',
          receiver,
          options,
        ),
      },
    ];

    for (const transition of cases) {
      const claim = (await prisma.$queryRawUnsafe(
        `INSERT INTO idempotency_keys
           (tenant_id, user_uid, request_key, request_method, request_path,
            request_body_hash, status)
         VALUES ($1::uuid, $2::uuid, $3::text, 'POST', $4::text,
                 $5::char(64), 'in_flight')
         RETURNING id`,
        tenantId,
        receiver,
        transition.key,
        transition.requestPath,
        transition.fingerprint,
      ))[0];
      const first = await transition.invoke({
        commandKey: transition.key,
        requestFingerprint: transition.fingerprint,
        httpIdempotencyClaimId: Number(claim.id),
        requestId: `request-${transition.key}`,
        tenantId,
      });
      expect(first).toMatchObject({ id: transition.id, status: transition.action });

      const replay = await transition.invoke({
        commandKey: transition.key,
        requestFingerprint: transition.fingerprint,
        tenantId,
      });
      expect(replay).toEqual(first);

      const stored = await prisma.$queryRawUnsafe(
        `SELECT response_data, actor_uid::text, command_scope, transition_action
           FROM mar_transition_command_receipts
          WHERE tenant_id = $1::uuid
            AND medication_administration_id = $2::integer`,
        tenantId,
        transition.id,
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        actor_uid: receiver,
        command_scope: transition.scope,
        transition_action: transition.action,
        response_data: first,
      });

      const finalized = (await prisma.$queryRawUnsafe(
        `SELECT status, response_status, response_body
           FROM idempotency_keys
          WHERE id = $1::integer`,
        Number(claim.id),
      ))[0];
      expect(finalized).toMatchObject({
        status: 'complete',
        response_status: 200,
        response_body: {
          success: true,
          message: transition.message,
          requestId: `request-${transition.key}`,
          data: first,
        },
      });

      await expect(transition.invoke({
        commandKey: transition.key,
        requestFingerprint: 'a'.repeat(64),
        tenantId,
      })).rejects.toMatchObject({
        statusCode: 422,
        code: 'MAR_TRANSITION_COMMAND_MISMATCH',
      });
    }

    const projected = await prisma.$queryRawUnsafe(
      `SELECT id, status, administered_by::text, held_by::text, held_at,
              missed_by::text, missed_at
         FROM medication_administrations
        WHERE tenant_id = $1::uuid
          AND id = ANY($2::integer[])
        ORDER BY id`,
      tenantId,
      [missedId, heldId],
    );
    const missed = projected.find((row) => Number(row.id) === missedId);
    const held = projected.find((row) => Number(row.id) === heldId);
    expect(missed).toMatchObject({
      status: 'missed',
      administered_by: null,
      missed_by: receiver,
    });
    expect(missed.missed_at).not.toBeNull();
    expect(held).toMatchObject({
      status: 'held',
      administered_by: null,
      held_by: receiver,
    });
    expect(held.held_at).not.toBeNull();

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE vhhealth_runtime');
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_tenant_id', $1::text, true)`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE mar_transition_command_receipts
            SET response_data = response_data || '{"tampered":true}'::jsonb
          WHERE tenant_id = $1::uuid
            AND medication_administration_id = $2::integer`,
        tenantId,
        heldId,
      );
    })).rejects.toThrow(/permission denied|append-only/i);
  });
});
