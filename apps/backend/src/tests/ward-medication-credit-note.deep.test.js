import { randomUUID } from 'node:crypto';

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
} from '../services/billing/billingCreditNoteService.js';
import { issueInvoice } from '../services/billing/billingV2Service.js';
import { administerWithScan } from '../services/clinical/marFiveRightsService.js';
import { holdMedication, recordMissed } from '../services/clinical/marService.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb('MED-03 ward medication credit-note closure', () => {
  const tenantId = randomUUID();
  const requester = randomUUID();
  const pharmacist = randomUUID();
  const receiver = randomUUID();
  const billingOwner = randomUUID();
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
         ($1::uuid, $6::uuid, 'Request Nurse', 'IP_STAFF_NURSE', TRUE, 'active', NOW()),
         ($2::uuid, $6::uuid, 'Pharmacist', 'PHARMACY_INCHARGE', TRUE, 'active', NOW()),
         ($3::uuid, $6::uuid, 'Receipt Nurse', 'NURSING_INCHARGE', TRUE, 'active', NOW()),
         ($4::uuid, $6::uuid, 'Billing Owner', 'BILLING_INCHARGE', TRUE, 'active', NOW()),
         ($5::uuid, $6::uuid, 'Patient', 'PATIENT', TRUE, 'active', NOW())`,
      requester,
      pharmacist,
      receiver,
      billingOwner,
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
         (tenant_id, name, is_active, stock_quantity, unit_price, price, updated_at)
       VALUES ($1::uuid, $2::text, TRUE, 20, 12.50, 12.50, NOW())
       RETURNING id`,
      tenantId,
      `MED-03 Credit Medicine ${run}`,
    ))[0].id);
    const inventoryItemId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, catalog_id, unit_label, schedule_class, is_narcotic)
       VALUES ($1::uuid, $2::text, $3::text, $4::int, 'unit', 'OTC', FALSE)
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

  test('creates an owned pending adjustment, evidence-completes review, and applies receivable credit', async () => {
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
      sla_completion_semantics: 'domain_evidence',
      rule_code: 'ward_indent_credit_note_review',
    });
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

    const approvedNote = await approveBillingCreditNote(pending[0].id, {
      tenantId,
      approvedBy: billingOwner,
      commandKey: `credit-approve-${run}`,
    });
    expect(approvedNote.status).toBe('approved');
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
        kind: 'billing_credit_note_decision',
        decision: 'approved',
      },
    });

    const applied = await applyBillingCreditNote(pending[0].id, {
      tenantId,
      appliedBy: billingOwner,
      commandKey: `credit-apply-${run}`,
    });
    expect(applied).toMatchObject({
      status: 'applied',
      receivable_credit_minor: 1250,
      refund_obligation_minor: 0,
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

  test('atomically receipts a scanned administration and replays only the exact command', async () => {
    const order = (await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_orders
         (tenant_id, order_number, patient_uid, order_type, status,
          ordered_by, details, updated_at)
       VALUES ($1::uuid, $2::text, $3::uuid, 'medication', 'ordered',
               $4::uuid, '{}'::jsonb, NOW())
       RETURNING id`,
      tenantId,
      `MED03-MAR-${run}`,
      patient,
      requester,
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
      scanned_barcode: `MED-03 Credit Medicine ${run}`,
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
    const administrations = await prisma.$queryRawUnsafe(
      `INSERT INTO medication_administrations
         (tenant_id, patient_uid, medication_name, dose, route,
          scheduled_time, status)
       VALUES
         ($1::uuid, $2::uuid, $3::text, '1 unit', 'oral',
          NOW() + INTERVAL '3 hours', 'scheduled'),
         ($1::uuid, $2::uuid, $4::text, '1 unit', 'oral',
          NOW() + INTERVAL '4 hours', 'scheduled')
       RETURNING id, medication_name`,
      tenantId,
      patient,
      `MED-03 Miss ${run}`,
      `MED-03 Hold ${run}`,
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
