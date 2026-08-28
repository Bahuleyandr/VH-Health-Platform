import { randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../lib/prisma.js';
import { createWardIndent } from '../services/ipd/ipdSupportService.js';
import {
  materializeBillingCreditNoteObligationTx,
  materializeMarSupplyReconciliationObligationTx,
  reconcileWardIndentNotificationCoverageTx,
  sweepWardIndentNotificationCoverage,
} from '../services/ipd/wardIndentObligationService.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-0000a7440101';
const OTHER_TENANT = '00000000-0000-4000-8000-0000a7440102';
const REQUESTER = 'a7440100-0000-4000-8000-000000000001';
const PATIENT = 'a7440100-0000-4000-8000-000000000002';
const RECIPIENT = 'a7440100-0000-4000-8000-000000000003';
const OTHER_RECIPIENT = 'a7440100-0000-4000-8000-000000000004';
const CREDIT_RECIPIENT = 'a7440100-0000-4000-8000-000000000005';
const MAR_RECIPIENT = 'a7440100-0000-4000-8000-000000000006';
const RUN = `${process.pid}-${Date.now()}`;

describeIfDb('MED-03 ward-indent notification coverage recovery', () => {
  let wardId;
  let catalogId;

  async function cleanupTenant(tenantId) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      for (const table of [
        'idempotency_keys',
        'task_comments',
        'tasks',
        'notification_outbox',
        'workflow_sla_instances',
        'ward_indent_events',
        'clinical_timeline_events',
        'clinical_audit_events',
        'ward_indent_items',
        'ward_indents',
        'pharmacy_catalog',
        'wards',
        'users',
      ]) {
        await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, tenantId);
      }
    });
  }

  beforeAll(async () => {
    for (const [tenantId, slug, name] of [
      [TENANT, `med03-coverage-${RUN}`, 'MED-03 Coverage Test'],
      [OTHER_TENANT, `med03-coverage-other-${RUN}`, 'MED-03 Coverage Other'],
    ]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
         VALUES ($1::uuid, $2::text, $3::text, 'IN', 'active', NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        tenantId,
        slug,
        name,
      );
      await cleanupTenant(tenantId);
    }

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $3::uuid, 'Coverage Requester', 'IP_STAFF_NURSE', TRUE, 'active', NOW()),
         ($2::uuid, $3::uuid, 'Coverage Patient', 'PATIENT', TRUE, 'active', NOW())`,
      REQUESTER,
      PATIENT,
      TENANT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, name, role, is_active, status, updated_at)
       VALUES ($1::uuid, $2::uuid, 'Other Tenant Pharmacist',
               'PHARMACY_INCHARGE', TRUE, 'active', NOW())`,
      OTHER_RECIPIENT,
      OTHER_TENANT,
    );
    wardId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO wards (tenant_id, name, total_beds, created_at, updated_at)
       VALUES ($1::uuid, $2::text, 10, NOW(), NOW())
       RETURNING id`,
      TENANT,
      `MED-03 Coverage Ward ${RUN}`,
    ))[0].id);
    catalogId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, is_active, stock_quantity, unit_price, price, updated_at)
       VALUES ($1::uuid, $2::text, TRUE, 10, 12.50, 12.50, NOW())
       RETURNING id`,
      TENANT,
      `MED-03 Coverage Medicine ${RUN}`,
    ))[0].id);
  }, 30000);

  afterAll(async () => {
    await cleanupTenant(TENANT);
    await cleanupTenant(OTHER_TENANT);
    await prisma.$executeRawUnsafe(
      `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
      TENANT,
      OTHER_TENANT,
    );
    if (typeof prisma.$disconnect === 'function') await prisma.$disconnect();
  }, 30000);

  test('waits for same-tenant recipients, then concurrent and repeated sweeps recover once', async () => {
    const indent = await createWardIndent({
      wardId,
      patientUid: PATIENT,
      indentType: 'pharmacy',
      items: [{ pharmacy_catalog_id: catalogId, quantity_requested: 1 }],
      requestedBy: REQUESTER,
      commandKey: `coverage-create-${RUN}-${randomUUID()}`,
      tenantId: TENANT,
    });
    expect(indent).toMatchObject({ status: 'requested', state_version: 1 });

    const gaps = await prisma.$queryRawUnsafe(
      `SELECT id, status, workflow_sla_instance_id, metadata
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND metadata->>'task_contract' = 'ward_medication_obligation_v1'
          AND metadata->>'obligation_kind' = 'notification_coverage'
        ORDER BY id`,
      TENANT,
    );
    expect(gaps).toHaveLength(1);
    const gap = gaps[0];
    const originalTaskId = Number(gap.metadata.notification_intent.data.task_id);
    expect(originalTaskId).toBeGreaterThan(0);
    expect(originalTaskId).not.toBe(Number(gap.id));
    expect(gap.metadata).toMatchObject({
      deep_link: `/pharmacy?tab=ward-indents&indent_id=${indent.id}`,
      notification_intent: {
        type: 'ward_indent_request',
        title: 'Review ward medication request',
        body: `Ward indent ${indent.indent_number} requires action.`,
        source_event_key: `ward-indent:${indent.id}:v1:ward_indent_request`,
        template_version: 'ward_indent_request.v1',
        data: {
          task_id: originalTaskId,
          ward_indent_id: Number(indent.id),
          deep_link: `/pharmacy?tab=ward-indents&indent_id=${indent.id}`,
        },
      },
    });

    const unavailable = await sweepWardIndentNotificationCoverage({
      tenantId: TENANT,
      limit: 1000,
    });
    expect(unavailable).toMatchObject({
      scanned: 1,
      recovered: 0,
      awaitingRecipients: 1,
      limit: 100,
    });
    expect((await prisma.$queryRawUnsafe(
      `SELECT status FROM tasks WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      Number(gap.id),
    ))[0].status).toBe('open');
    expect(await prisma.$queryRawUnsafe(
      `SELECT id
         FROM notification_outbox
        WHERE tenant_id = $1::uuid
          AND payload->>'coverage_task_id' = $2::text`,
      OTHER_TENANT,
      String(gap.id),
    )).toHaveLength(0);

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, name, role, is_active, status, updated_at)
       VALUES ($1::uuid, $2::uuid, 'Coverage Pharmacist',
               'PHARMACY_INCHARGE', TRUE, 'active', NOW())`,
      RECIPIENT,
      TENANT,
    );

    const concurrent = await Promise.all([
      sweepWardIndentNotificationCoverage({ tenantId: TENANT, limit: 1 }),
      sweepWardIndentNotificationCoverage({ tenantId: TENANT, limit: 1 }),
    ]);
    expect(concurrent.reduce((sum, result) => sum + result.recovered, 0)).toBe(1);

    const outbox = await prisma.$queryRawUnsafe(
      `SELECT id, recipient_id, type, title, body, payload, source_event_key,
              template_version
         FROM notification_outbox
        WHERE tenant_id = $1::uuid
          AND payload->>'coverage_task_id' = $2::text
        ORDER BY id`,
      TENANT,
      String(gap.id),
    );
    expect(outbox).toHaveLength(1);
    expect(String(outbox[0].recipient_id)).toBe(String((await prisma.$queryRawUnsafe(
      `SELECT id FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      TENANT,
      RECIPIENT,
    ))[0].id));
    expect(outbox[0].payload).toMatchObject({
      coverage_task_id: Number(gap.id),
      recovery_source: 'ward-indent-notification-coverage-recovery.v1',
      recovery_actor_uid: RECIPIENT,
      ward_indent_id: Number(indent.id),
      deep_link: `/pharmacy?tab=ward-indents&indent_id=${indent.id}`,
      task_id: originalTaskId,
      kind: 'ward_indent_request',
    });
    expect(outbox[0]).toMatchObject({
      type: 'ward_indent_request',
      title: 'Review ward medication request',
      body: `Ward indent ${indent.indent_number} requires action.`,
      source_event_key: `ward-indent:${indent.id}:v1:ward_indent_request`,
      template_version: 'ward_indent_request.v1',
    });

    const completed = (await prisma.$queryRawUnsafe(
      `SELECT task.status, sla.status AS sla_status, sla.completed_at,
              sla.metadata->>'completed_by' AS completed_by,
              sla.metadata->'completion_evidence' AS completion_evidence
         FROM tasks task
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid
          AND task.id = $2::int`,
      TENANT,
      Number(gap.id),
    ))[0];
    expect(completed).toMatchObject({
      status: 'completed',
      sla_status: 'completed',
      completed_by: RECIPIENT,
    });
    expect(completed.completed_at).not.toBeNull();
    expect(completed.completion_evidence).toMatchObject({
      kind: 'notification_coverage_restored',
      resource_type: 'notification_outbox',
      resource_id: String(outbox[0].id),
    });

    const repeated = await sweepWardIndentNotificationCoverage({ tenantId: TENANT, limit: 1 });
    expect(repeated).toMatchObject({ scanned: 0, recovered: 0, awaitingRecipients: 0 });
    expect(await prisma.$queryRawUnsafe(
      `SELECT id
         FROM notification_outbox
        WHERE tenant_id = $1::uuid
          AND payload->>'coverage_task_id' = $2::text`,
      TENANT,
      String(gap.id),
    )).toHaveLength(1);

    const unchangedIndent = (await prisma.$queryRawUnsafe(
      `SELECT status, state_version
         FROM ward_indents
        WHERE tenant_id = $1::uuid
          AND id = $2::int`,
      TENANT,
      Number(indent.id),
    ))[0];
    expect(unchangedIndent).toMatchObject({ status: 'requested', state_version: 1 });
  });

  test('recovers the exact finance credit-note notification after roster restoration', async () => {
    const indent = (await prisma.$queryRawUnsafe(
      `SELECT wi.*, item.id AS ward_indent_item_id,
              event.id AS source_event_id
         FROM ward_indents wi
         JOIN ward_indent_items item
           ON item.tenant_id = wi.tenant_id
          AND item.ward_indent_id = wi.id
         JOIN LATERAL (
           SELECT id
             FROM ward_indent_events
            WHERE tenant_id = wi.tenant_id
              AND ward_indent_id = wi.id
            ORDER BY state_version ASC, id ASC
            LIMIT 1
         ) event ON TRUE
        WHERE wi.tenant_id = $1::uuid
        ORDER BY wi.id ASC
        LIMIT 1`,
      TENANT,
    ))[0];
    const creditNoteId = '74401001';
    const invoiceId = 74401002;
    const creditNumber = `WMCN-${RUN}`;

    const task = await setTenantTx(TENANT, (tx) => materializeBillingCreditNoteObligationTx(tx, {
      creditNote: {
        id: creditNoteId,
        status: 'pending',
        tenant_id: TENANT,
        patient_uid: PATIENT,
        encounter_id: null,
        ward_indent_id: Number(indent.id),
        ward_indent_item_id: Number(indent.ward_indent_item_id),
        invoice_id: invoiceId,
        source_financial_event_id: '74401003',
        credit_note_number: creditNumber,
        indent_number: indent.indent_number,
        ward_indent_status: indent.status,
        ward_indent_state_version: Number(indent.state_version),
      },
      actorUid: REQUESTER,
      sourceEvent: { id: String(indent.source_event_id) },
    }));
    expect(Number(task.id)).toBeGreaterThan(0);

    const gap = (await prisma.$queryRawUnsafe(
      `SELECT id, metadata
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND metadata->>'obligation_kind' = 'notification_coverage'
          AND metadata->'notification_intent'->>'type' = 'ward_indent_credit_note_review'
          AND status = ANY($2::text[])
        ORDER BY id DESC
        LIMIT 1`,
      TENANT,
      ['open', 'in_progress', 'blocked', 'overdue'],
    ))[0];
    expect(gap.metadata.notification_intent).toMatchObject({
      type: 'ward_indent_credit_note_review',
      title: 'Ward medication credit note requires review',
      body: `Credit note ${creditNumber} requires a finance decision.`,
      source_event_key: `billing-credit-note:${creditNoteId}:raised`,
      template_version: 'ward_indent_credit_note_review.v1',
      data: {
        task_id: Number(task.id),
        credit_note_id: creditNoteId,
        invoice_id: invoiceId,
        ward_indent_id: Number(indent.id),
        deep_link: `/billing/credit-notes/${creditNoteId}`,
      },
    });

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, name, role, is_active, status, updated_at)
       VALUES ($1::uuid, $2::uuid, 'Coverage Finance Incharge',
               'BILLING_INCHARGE', TRUE, 'active', NOW())`,
      CREDIT_RECIPIENT,
      TENANT,
    );
    const recovered = await sweepWardIndentNotificationCoverage({ tenantId: TENANT, limit: 100 });
    expect(recovered.recoveredTaskIds).toContain(Number(gap.id));

    const outbox = (await prisma.$queryRawUnsafe(
      `SELECT type, title, body, payload, source_event_key, template_version
         FROM notification_outbox
        WHERE tenant_id = $1::uuid
          AND payload->>'coverage_task_id' = $2::text`,
      TENANT,
      String(gap.id),
    ))[0];
    expect(outbox).toMatchObject({
      type: 'ward_indent_credit_note_review',
      title: 'Ward medication credit note requires review',
      body: `Credit note ${creditNumber} requires a finance decision.`,
      source_event_key: `billing-credit-note:${creditNoteId}:raised`,
      template_version: 'ward_indent_credit_note_review.v1',
    });
    expect(outbox.payload).toMatchObject({
      task_id: Number(task.id),
      credit_note_id: creditNoteId,
      invoice_id: invoiceId,
      ward_indent_id: Number(indent.id),
      deep_link: `/billing/credit-notes/${creditNoteId}`,
      coverage_task_id: Number(gap.id),
    });
  });

  test('recovers the exact MAR supply notification after roster restoration', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE users
          SET is_active = FALSE,
              status = 'inactive',
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND role = 'PHARMACY_INCHARGE'`,
      TENANT,
    );
    const indent = (await prisma.$queryRawUnsafe(
      `SELECT wi.*, item.id AS ward_indent_item_id
         FROM ward_indents wi
         JOIN ward_indent_items item
           ON item.tenant_id = wi.tenant_id
          AND item.ward_indent_id = wi.id
        WHERE wi.tenant_id = $1::uuid
        ORDER BY wi.id ASC
        LIMIT 1`,
      TENANT,
    ))[0];
    const administrationId = 74401011;
    const clinicalOrderId = 74401012;

    const task = await setTenantTx(TENANT, (tx) => materializeMarSupplyReconciliationObligationTx(tx, {
      administration: {
        id: administrationId,
        tenant_id: TENANT,
        patient_uid: PATIENT,
        clinical_order_id: clinicalOrderId,
      },
      wardItem: { id: Number(indent.ward_indent_item_id) },
      indent,
      actorUid: REQUESTER,
      overrideReason: 'Emergency administration documented during temporary ward-stock outage.',
    }));
    expect(Number(task.id)).toBeGreaterThan(0);

    const gap = (await prisma.$queryRawUnsafe(
      `SELECT id, metadata
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND metadata->>'obligation_kind' = 'notification_coverage'
          AND metadata->'notification_intent'->>'type' = 'ward_indent_mar_supply_reconciliation'
          AND status = ANY($2::text[])
        ORDER BY id DESC
        LIMIT 1`,
      TENANT,
      ['open', 'in_progress', 'blocked', 'overdue'],
    ))[0];
    expect(gap.metadata.notification_intent).toMatchObject({
      type: 'ward_indent_mar_supply_reconciliation',
      title: 'MAR administration requires supply reconciliation',
      body: `Administration ${administrationId} must be matched to exact received ward stock.`,
      source_event_key: `mar-supply:${administrationId}:unmatched`,
      template_version: 'ward_indent_mar_supply_reconciliation.v1',
      data: {
        task_id: Number(task.id),
        medication_administration_id: administrationId,
        clinical_order_id: clinicalOrderId,
        ward_indent_id: Number(indent.id),
        ward_indent_item_id: Number(indent.ward_indent_item_id),
        deep_link: `/clinical/mar/${administrationId}?supply-reconciliation=1`,
      },
    });

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, name, role, is_active, status, updated_at)
       VALUES ($1::uuid, $2::uuid, 'Coverage Nursing Incharge',
               'NURSING_INCHARGE', TRUE, 'active', NOW())`,
      MAR_RECIPIENT,
      TENANT,
    );
    const recovered = await sweepWardIndentNotificationCoverage({ tenantId: TENANT, limit: 100 });
    expect(recovered.recoveredTaskIds).toContain(Number(gap.id));

    const outbox = (await prisma.$queryRawUnsafe(
      `SELECT type, title, body, payload, source_event_key, template_version
         FROM notification_outbox
        WHERE tenant_id = $1::uuid
          AND payload->>'coverage_task_id' = $2::text`,
      TENANT,
      String(gap.id),
    ))[0];
    expect(outbox).toMatchObject({
      type: 'ward_indent_mar_supply_reconciliation',
      title: 'MAR administration requires supply reconciliation',
      body: `Administration ${administrationId} must be matched to exact received ward stock.`,
      source_event_key: `mar-supply:${administrationId}:unmatched`,
      template_version: 'ward_indent_mar_supply_reconciliation.v1',
    });
    expect(outbox.payload).toMatchObject({
      task_id: Number(task.id),
      medication_administration_id: administrationId,
      clinical_order_id: clinicalOrderId,
      ward_indent_id: Number(indent.id),
      ward_indent_item_id: Number(indent.ward_indent_item_id),
      deep_link: `/clinical/mar/${administrationId}?supply-reconciliation=1`,
      coverage_task_id: Number(gap.id),
    });
  });

  test('places an unreconstructable pre-upgrade intent on manual hold without blocking recovery', async () => {
    const indent = await createWardIndent({
      wardId,
      patientUid: PATIENT,
      indentType: 'pharmacy',
      items: [{ pharmacy_catalog_id: catalogId, quantity_requested: 1 }],
      requestedBy: REQUESTER,
      commandKey: `legacy-coverage-create-${RUN}-${randomUUID()}`,
      tenantId: TENANT,
    });
    const gap = (await prisma.$queryRawUnsafe(
      `SELECT id
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND metadata->>'obligation_kind' = 'notification_coverage'
          AND metadata->>'ward_indent_id' = $2::text
          AND status = ANY($3::text[])
        ORDER BY id DESC
        LIMIT 1`,
      TENANT,
      String(indent.id),
      ['open', 'in_progress', 'blocked', 'overdue'],
    ))[0];
    expect(Number(gap.id)).toBeGreaterThan(0);
    await prisma.$executeRawUnsafe(
      `UPDATE tasks
          SET metadata = metadata - 'notification_intent'
        WHERE tenant_id = $1::uuid
          AND id = $2::int`,
      TENANT,
      Number(gap.id),
    );
    await prisma.$executeRawUnsafe(
      `UPDATE users
          SET is_active = TRUE,
              status = 'active',
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND uid = $2::uuid`,
      TENANT,
      RECIPIENT,
    );

    await expect(setTenantTx(TENANT, (tx) => reconcileWardIndentNotificationCoverageTx(tx, {
      tenantId: TENANT,
      indent,
      actorUid: REQUESTER,
    }))).resolves.toEqual([]);

    const held = (await prisma.$queryRawUnsafe(
      `SELECT status, metadata
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND id = $2::int`,
      TENANT,
      Number(gap.id),
    ))[0];
    expect(held).toMatchObject({ status: 'blocked' });
    expect(held.metadata).toMatchObject({
      notification_recovery_status: 'manual_hold',
      notification_recovery_hold_code: 'WARD_MEDICATION_COVERAGE_INTENT_INVALID',
    });
    expect(held.metadata.notification_recovery_held_at).toEqual(expect.any(String));

    const sweep = await sweepWardIndentNotificationCoverage({ tenantId: TENANT, limit: 100 });
    expect(sweep).toMatchObject({ scanned: 0, recovered: 0, held: 0 });
    expect(await prisma.$queryRawUnsafe(
      `SELECT id
         FROM notification_outbox
        WHERE tenant_id = $1::uuid
          AND payload->>'coverage_task_id' = $2::text`,
      TENANT,
      String(gap.id),
    )).toHaveLength(0);
  });
});
