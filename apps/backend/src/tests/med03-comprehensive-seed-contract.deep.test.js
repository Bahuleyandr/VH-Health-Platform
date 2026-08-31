import { createHash } from 'node:crypto';

import prisma from '../lib/prisma.js';
import { fingerprintMarAdministrationRequest } from '../services/clinical/marAdministrationCommandService.js';
import { fingerprintMarTransitionRequest } from '../services/clinical/marTransitionCommandService.js';
import { renderedIntentHash } from '../utils/notifications/notificationOutbox.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const INDENT_NUMBER = 'VH-SEED-MED03-INDENT-001';
const ORDER_NUMBER = 'VH-SEED-MED03-ORDER-001';
const INVOICE_NUMBER = 'VH-SEED-MED03-INV-0001';
const CATALOG_NAME = 'VH-SEED-MED03 Paracetamol 500 mg tablet';
const SKU = 'VH-SEED-MED03-PARA500';
const BATCH_NUMBER = 'VH-SEED-MED03-BATCH-001';
const LOT_NUMBER = 'VH-SEED-MED03-LOT-001';
const COUNTER_SALE_VOID_COMMAND = 'seed-med03-counter-sale-void-v1';
const OFFLINE_REFUND_REFERENCE = 'VH-SEED-MED03-OFFLINE-REFUND-001';

function asNumber(value) {
  return Number(value);
}

function stageOccurrenceKey(sourceId) {
  const digest = createHash('sha256')
    .update(`${TENANT_ID}:${sourceId}`, 'utf8')
    .digest('hex');
  return `ward-medication-obligation:${digest}`;
}

function marExceptionOccurrenceKey(caseId) {
  const digest = createHash('sha256')
    .update(`${TENANT_ID}:mar-medication-exception:${caseId}`, 'utf8')
    .digest('hex');
  return `mar-medication-exception:${digest}`;
}

function jsonHash(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function expectCanonicalOutbox(row) {
  expect(row.status).toBe('PENDING');
  expect(row.channel).toBe('inapp');
  expect(row.recipient_id).toMatch(/^[1-9][0-9]*$/);
  expect(row.recipient_key).toBe(`id:${row.recipient_id}`);
  expect(row.rendered_intent_hash).toBe(renderedIntentHash({
    type: row.type,
    channel: row.channel,
    recipient_id: row.recipient_id,
    recipient_phone: row.recipient_phone,
    template_version: row.template_version,
    title: row.title,
    body: row.body,
    payload: row.payload || {},
  }));
}

function reconciliationRequestHash({ consumptionId, administrationId, links }) {
  const normalized = {
    consumption_id: String(consumptionId),
    expected_medication_administration_id: Number(administrationId),
    allocations: links
      .map((link) => ({
        inventory_allocation_id: String(link.inventory_allocation_id),
        quantity: Number(link.quantity).toFixed(4),
      }))
      .sort((left, right) => (
        BigInt(left.inventory_allocation_id) < BigInt(right.inventory_allocation_id) ? -1 : 1
      )),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

describeIfDb('MED-03 comprehensive seed production journey', () => {
  let journey;

  beforeAll(async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT indent.id AS ward_indent_id,
              indent.patient_uid::text,
              indent.encounter_id::text,
              indent.admission_id,
              indent.status AS ward_indent_status,
              indent.state_version,
              item.id AS ward_indent_item_id,
              item.clinical_order_id,
              item.pharmacy_catalog_id,
              clinical_order.details AS clinical_order_details
         FROM ward_indents indent
         JOIN ward_indent_items item
           ON item.tenant_id = indent.tenant_id
          AND item.ward_indent_id = indent.id
         JOIN clinical_orders clinical_order
           ON clinical_order.tenant_id = item.tenant_id
          AND clinical_order.id = item.clinical_order_id
        WHERE indent.tenant_id = $1::uuid
          AND indent.indent_number = $2::text
          AND clinical_order.order_number = $3::text`,
      TENANT_ID,
      INDENT_NUMBER,
      ORDER_NUMBER,
    );
    if (rows.length !== 1) {
      throw new Error(
        `Expected one fully seeded ${INDENT_NUMBER} journey, found ${rows.length}`,
      );
    }
    journey = rows[0];
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('preserves the exact v1 requested through v7 reconciled actor sequence', async () => {
    expect(journey).toMatchObject({
      ward_indent_status: 'reconciled',
      state_version: 7,
    });

    const events = await prisma.$queryRawUnsafe(
      `SELECT event.state_version, event.action, event.from_status,
              event.to_status, event.actor_uid::text, actor.role,
              event.command_key, event.occurred_at
         FROM ward_indent_events event
         JOIN users actor
           ON actor.tenant_id = event.tenant_id
          AND actor.uid = event.actor_uid
        WHERE event.tenant_id = $1::uuid
          AND event.ward_indent_id = $2::int
        ORDER BY event.state_version`,
      TENANT_ID,
      asNumber(journey.ward_indent_id),
    );

    expect(events.map((event) => ({
      version: event.state_version,
      action: event.action,
      from: event.from_status,
      to: event.to_status,
      role: event.role,
    }))).toEqual([
      {
        version: 1,
        action: 'requested',
        from: null,
        to: 'requested',
        role: 'NURSING_INCHARGE',
      },
      {
        version: 2,
        action: 'reserved',
        from: 'requested',
        to: 'reserved',
        role: 'PHARMACY_INCHARGE',
      },
      {
        version: 3,
        action: 'approved',
        from: 'reserved',
        to: 'approved',
        role: 'PHARMACY_INCHARGE',
      },
      {
        version: 4,
        action: 'issued',
        from: 'approved',
        to: 'issued',
        role: 'PHARMACY_INCHARGE',
      },
      {
        version: 5,
        action: 'receipt_recorded',
        from: 'issued',
        to: 'received',
        role: 'NURSING_INCHARGE',
      },
      {
        version: 6,
        action: 'return_requested',
        from: 'received',
        to: 'return_pending',
        role: 'NURSING_INCHARGE',
      },
      {
        version: 7,
        action: 'reconciled',
        from: 'return_pending',
        to: 'reconciled',
        role: 'PHARMACY_INCHARGE',
      },
    ]);
    expect(new Set(events.map((event) => event.command_key)).size).toBe(7);
    expect(events.every((event) => event.command_key?.startsWith('seed-med03-'))).toBe(true);
    for (let index = 1; index < events.length; index += 1) {
      expect(new Date(events[index].occurred_at).getTime())
        .toBeGreaterThan(new Date(events[index - 1].occurred_at).getTime());
    }
  });

  test('materializes four reusable ward state task identities and seven exact intents', async () => {
    const indentId = asNumber(journey.ward_indent_id);
    const expectedStages = [
      {
        sourceId: `ward-indent:${indentId}:v1`,
        rule: 'ward_indent_pharmacy_response',
        state: 'reserved',
        version: 2,
        slaStatus: 'completed',
        taskStatus: 'completed',
      },
      {
        sourceId: `ward-indent:${indentId}:v3`,
        rule: 'ward_indent_pharmacy_issue',
        state: 'approved',
        version: 3,
        slaStatus: 'completed',
        taskStatus: 'completed',
      },
      {
        sourceId: `ward-indent:${indentId}:v4`,
        rule: 'ward_indent_ward_receipt',
        state: 'issued',
        version: 4,
        slaStatus: 'completed',
        taskStatus: 'completed',
      },
      {
        sourceId: `ward-indent:${indentId}:v5`,
        rule: 'ward_indent_reconciliation',
        state: 'reconciled',
        version: 7,
        slaStatus: 'active',
        taskStatus: 'open',
      },
    ];
    const sourceIds = expectedStages.map((stage) => stage.sourceId);
    const stages = await prisma.$queryRawUnsafe(
      `SELECT sla.id::text AS sla_id, sla.source_id, sla.rule_code,
              sla.status AS sla_status, sla.completed_at, sla.due_at AS sla_due_at,
              task.id AS task_id, task.status AS task_status,
              task.encounter_id, task.due_at AS task_due_at,
              task.sla_completion_semantics,
              task.related_resource_id, task.workflow_sla_instance_id::text,
              task.stage_occurrence_key, task.metadata
         FROM workflow_sla_instances sla
         JOIN tasks task
           ON task.tenant_id = sla.tenant_id
          AND task.workflow_sla_instance_id = sla.id
        WHERE sla.tenant_id = $1::uuid
          AND sla.source_table = 'ward_indents'
          AND sla.source_id = ANY($2::text[])
        ORDER BY sla.source_id`,
      TENANT_ID,
      sourceIds,
    );
    expect(stages).toHaveLength(4);

    const tasksBySource = new Map();
    for (const expected of expectedStages) {
      const stage = stages.find((row) => row.source_id === expected.sourceId);
      expect(stage).toBeDefined();
      expect(stage).toMatchObject({
        source_id: expected.sourceId,
        rule_code: expected.rule,
        sla_status: expected.slaStatus,
        task_status: expected.taskStatus,
        encounter_id: null,
        sla_completion_semantics: 'domain_evidence',
        related_resource_id: expected.sourceId,
        workflow_sla_instance_id: stage.sla_id,
        stage_occurrence_key: stageOccurrenceKey(expected.sourceId),
      });
      expect(stage.metadata).toMatchObject({
        task_contract: 'ward_medication_obligation_v1',
        med_03: true,
        obligation_kind: 'ward_indent_state',
        evidence_kind: 'ward_indent_transition',
        ward_indent_id: indentId,
        current_state: expected.state,
        state_version: expected.version,
      });
      expect(new Date(stage.task_due_at).toISOString())
        .toBe(new Date(stage.sla_due_at).toISOString());
      if (expected.slaStatus === 'completed') expect(stage.completed_at).not.toBeNull();
      else expect(stage.completed_at).toBeNull();
      tasksBySource.set(expected.sourceId, asNumber(stage.task_id));
    }

    const expectedIntents = [
      [1, 'ward_indent_request', sourceIds[0], 'PHARMACY_INCHARGE'],
      [2, 'ward_indent_reserved', sourceIds[0], 'PHARMACY_INCHARGE'],
      [3, 'ward_indent_approved', sourceIds[1], 'PHARMACY_INCHARGE'],
      [4, 'ward_indent_issued', sourceIds[2], 'NURSING_INCHARGE'],
      [5, 'ward_indent_received', sourceIds[3], null],
      [6, 'ward_indent_return_pending', sourceIds[3], null],
      [7, 'ward_indent_reconciled', sourceIds[3], null],
    ];
    const intents = await prisma.$queryRawUnsafe(
      `SELECT outbox.type, outbox.recipient_id, outbox.recipient_phone,
              outbox.title, outbox.body, outbox.payload, outbox.status,
              outbox.channel, outbox.source_event_key, outbox.recipient_key,
              outbox.template_version, outbox.rendered_intent_hash::text,
              recipient.role AS recipient_role
         FROM notification_outbox outbox
         JOIN users recipient
           ON recipient.tenant_id = outbox.tenant_id
          AND recipient.id::text = outbox.recipient_id
        WHERE outbox.tenant_id = $1::uuid
          AND outbox.source_event_key LIKE $2::text
        ORDER BY outbox.source_event_key`,
      TENANT_ID,
      `ward-indent:${indentId}:v%`,
    );
    expect(intents).toHaveLength(7);

    for (const [version, type, taskSourceId, exactRole] of expectedIntents) {
      const sourceEventKey = `ward-indent:${indentId}:v${version}:${type}`;
      const intent = intents.find((row) => row.source_event_key === sourceEventKey);
      expect(intent).toBeDefined();
      expect(intent).toMatchObject({
        type,
        template_version: `${type}.v1`,
      });
      expect(intent.payload).toMatchObject({
        kind: type,
        task_id: tasksBySource.get(taskSourceId),
        ward_indent_id: indentId,
        ward_indent_item_id: null,
        state_version: version,
      });
      if (exactRole) expect(intent.recipient_role).toBe(exactRole);
      else expect(['PHARMACY_INCHARGE', 'NURSING_INCHARGE']).toContain(intent.recipient_role);
      expectCanonicalOutbox(intent);
    }
  });

  test('keeps prescribed product, ward custody, exact batch, and stock movements aligned', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT catalog.id AS catalog_id, catalog.name AS catalog_name,
              catalog.generic_name, catalog.unit_price, catalog.price,
              catalog.strength, catalog.strength_key, catalog.form,
              catalog.form_key, catalog.route,
              clinical_order.details AS order_details,
              item.id AS ward_indent_item_id,
              item.pharmacy_catalog_id, item.original_pharmacy_catalog_id,
              item.clinical_order_id, item.item_name, item.unit_price,
              inventory_item.id AS inventory_item_id,
              inventory_item.sku_code, inventory_item.display_name,
              inventory_item.catalog_id AS inventory_catalog_id,
              inventory_item.strength AS inventory_strength,
              inventory_item.form AS inventory_form,
              batch.id AS inventory_batch_id, batch.batch_number,
              batch.lot_number, batch.metadata AS batch_metadata,
              batch.received_quantity AS batch_received_quantity,
              batch.remaining_quantity,
              allocation.id AS allocation_id, allocation.status AS allocation_status,
              allocation.reserved_quantity, allocation.issued_quantity,
              allocation.received_quantity, allocation.consumed_quantity,
              allocation.returned_quantity
         FROM clinical_orders clinical_order
         JOIN ward_indent_items item
           ON item.tenant_id = clinical_order.tenant_id
          AND item.clinical_order_id = clinical_order.id
         JOIN pharmacy_catalog catalog
           ON catalog.tenant_id = item.tenant_id
          AND catalog.id = item.pharmacy_catalog_id
         JOIN ward_indent_inventory_allocations allocation
           ON allocation.tenant_id = item.tenant_id
          AND allocation.ward_indent_item_id = item.id
         JOIN pharmacy_inventory_items inventory_item
           ON inventory_item.tenant_id = allocation.tenant_id
          AND inventory_item.id = allocation.inventory_item_id
         JOIN pharmacy_inventory_batches batch
           ON batch.tenant_id = allocation.tenant_id
          AND batch.id = allocation.inventory_batch_id
        WHERE clinical_order.tenant_id = $1::uuid
          AND clinical_order.order_number = $2::text`,
      TENANT_ID,
      ORDER_NUMBER,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      catalog_name: CATALOG_NAME,
      generic_name: 'Paracetamol',
      strength: '500 mg',
      strength_key: '500mg',
      form: 'tablet',
      form_key: 'tablet',
      route: 'oral',
      sku_code: SKU,
      batch_number: BATCH_NUMBER,
      lot_number: LOT_NUMBER,
      allocation_status: 'reconciled',
    });
    expect(asNumber(row.unit_price)).toBe(10);
    expect(asNumber(row.price)).toBe(10);
    expect(asNumber(row.pharmacy_catalog_id)).toBe(asNumber(row.catalog_id));
    expect(asNumber(row.original_pharmacy_catalog_id)).toBe(asNumber(row.catalog_id));
    expect(asNumber(row.inventory_catalog_id)).toBe(asNumber(row.catalog_id));
    expect(asNumber(row.clinical_order_id)).toBe(asNumber(journey.clinical_order_id));
    expect(row.order_details).toMatchObject({
      catalog_id: asNumber(row.catalog_id),
      dose: '500 mg',
      strength: '500 mg',
      strength_key: '500mg',
      form: 'tablet',
      form_key: 'tablet',
      route: 'oral',
      frequency: 'QID',
      duration_days: 1,
    });
    expect(asNumber(row.reserved_quantity)).toBe(3);
    expect(asNumber(row.issued_quantity)).toBe(3);
    expect(asNumber(row.received_quantity)).toBe(3);
    expect(asNumber(row.consumed_quantity)).toBe(2);
    expect(asNumber(row.returned_quantity)).toBe(1);
    expect(asNumber(row.batch_received_quantity)).toBe(10);
    expect(asNumber(row.remaining_quantity)).toBe(8);

    const movements = await prisma.$queryRawUnsafe(
      `SELECT link.movement_purpose, link.quantity,
              link.ward_indent_state_version, movement.quantity_delta,
              movement.inventory_item_id, movement.inventory_batch_id,
              actor.role
         FROM ward_indent_inventory_movement_links link
         JOIN pharmacy_stock_movements movement
           ON movement.tenant_id = link.tenant_id
          AND movement.id = link.stock_movement_id
         JOIN users actor
           ON actor.tenant_id = link.tenant_id
          AND actor.uid = link.linked_by
        WHERE link.tenant_id = $1::uuid
          AND link.allocation_id = $2::bigint
        ORDER BY link.ward_indent_state_version`,
      TENANT_ID,
      row.allocation_id,
    );
    expect(movements.map((movement) => ({
      purpose: movement.movement_purpose,
      quantity: asNumber(movement.quantity),
      version: movement.ward_indent_state_version,
      delta: asNumber(movement.quantity_delta),
      role: movement.role,
    }))).toEqual([
      {
        purpose: 'issue',
        quantity: 3,
        version: 4,
        delta: -3,
        role: 'PHARMACY_INCHARGE',
      },
      {
        purpose: 'return',
        quantity: 1,
        version: 7,
        delta: 1,
        role: 'PHARMACY_INCHARGE',
      },
    ]);
    expect(movements.every(
      (movement) => asNumber(movement.inventory_item_id) === asNumber(row.inventory_item_id)
        && asNumber(movement.inventory_batch_id) === asNumber(row.inventory_batch_id),
    )).toBe(true);

    const receipts = await prisma.$queryRawUnsafe(
      `SELECT receipt.ward_indent_state_version, receipt.quantity_delta,
              receipt.inventory_allocation_id, receipt.inventory_batch_id,
              actor.role
         FROM ward_indent_inventory_receipt_events receipt
         JOIN users actor
           ON actor.tenant_id = receipt.tenant_id
          AND actor.uid = receipt.received_by
        WHERE receipt.tenant_id = $1::uuid
          AND receipt.inventory_allocation_id = $2::bigint`,
      TENANT_ID,
      row.allocation_id,
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      ward_indent_state_version: 5,
      role: 'NURSING_INCHARGE',
    });
    expect(asNumber(receipts[0].quantity_delta)).toBe(3);
    expect(String(receipts[0].inventory_allocation_id)).toBe(String(row.allocation_id));
    expect(asNumber(receipts[0].inventory_batch_id)).toBe(asNumber(row.inventory_batch_id));
  });

  test('records a legitimate pre-receipt no-scan override and reconciles it after receipt', async () => {
    const administrations = await prisma.$queryRawUnsafe(
      `SELECT administration.id, administration.status,
              administration.scheduled_time, administration.administered_at,
              administration.administered_by::text,
              administration.held_by::text, administration.held_at,
              administration.missed_by::text, administration.missed_at,
              administration.scanned_patient_uid::text,
              administration.scanned_barcode,
              administration.patient_scanned_at,
              administration.medication_scanned_at,
              administration.rights_passed,
              administration.all_rights_passed,
              administration.override_reason,
              administration.hold_reason,
              administration.refusal_reason,
              administration.notes,
              administration.witness_uid::text,
              administration.supply_quantity_per_dose
         FROM medication_administrations administration
        WHERE administration.tenant_id = $1::uuid
          AND administration.clinical_order_id = $2::int
        ORDER BY administration.scheduled_time, administration.id`,
      TENANT_ID,
      asNumber(journey.clinical_order_id),
    );
    expect(administrations).toHaveLength(4);
    for (let index = 1; index < administrations.length; index += 1) {
      const spacing = new Date(administrations[index].scheduled_time).getTime()
        - new Date(administrations[index - 1].scheduled_time).getTime();
      expect(spacing).toBe(6 * 60 * 60 * 1000);
    }
    expect(administrations.map((administration) => administration.status)).toEqual([
      'administered',
      'administered',
      'held',
      'missed',
    ]);
    expect(administrations.every(
      (administration) => asNumber(administration.supply_quantity_per_dose) === 1,
    )).toBe(true);

    const noScan = administrations.find((administration) => (
      administration.status === 'administered' && administration.scanned_barcode == null
    ));
    const scanned = administrations.find((administration) => administration.scanned_barcode != null);
    const held = administrations.find((administration) => administration.status === 'held');
    const missed = administrations.find((administration) => administration.status === 'missed');
    expect(noScan).toBeDefined();
    expect(scanned).toBeDefined();
    expect(held).toBeDefined();
    expect(missed).toBeDefined();

    expect(noScan).toMatchObject({
      scanned_patient_uid: null,
      scanned_barcode: null,
      patient_scanned_at: null,
      medication_scanned_at: null,
      rights_passed: null,
      all_rights_passed: null,
    });
    expect(noScan.override_reason?.trim().length).toBeGreaterThanOrEqual(5);
    expect(scanned).toMatchObject({
      scanned_patient_uid: journey.patient_uid,
      rights_passed: {
        patient: true,
        drug: true,
        dose: true,
        route: true,
        time: true,
      },
      all_rights_passed: true,
      override_reason: null,
    });
    expect(scanned.patient_scanned_at).not.toBeNull();
    expect(scanned.medication_scanned_at).not.toBeNull();
    expect(new Date(scanned.patient_scanned_at).getTime())
      .toBeLessThanOrEqual(new Date(scanned.medication_scanned_at).getTime());

    const custody = await prisma.$queryRawUnsafe(
      `SELECT consumption.id, consumption.medication_administration_id,
              consumption.inventory_allocation_id,
              consumption.inventory_batch_id, consumption.quantity,
              consumption.evidence_status, consumption.administration_mode,
              consumption.command_key, consumption.recorded_by::text,
              consumption.override_reason, consumption.override_recorded_at,
              consumption.reconciliation_task_id, consumption.created_at,
              actor.role
         FROM mar_supply_consumptions consumption
         JOIN users actor
           ON actor.tenant_id = consumption.tenant_id
          AND actor.uid = consumption.recorded_by
        WHERE consumption.tenant_id = $1::uuid
          AND consumption.clinical_order_id = $2::int
        ORDER BY consumption.created_at, consumption.id`,
      TENANT_ID,
      asNumber(journey.clinical_order_id),
    );
    expect(custody).toHaveLength(2);
    const unmatched = custody.find((row) => row.evidence_status === 'unmatched_override');
    const matched = custody.find((row) => row.evidence_status === 'matched');
    expect(unmatched).toMatchObject({
      medication_administration_id: noScan.id,
      inventory_allocation_id: null,
      inventory_batch_id: null,
      administration_mode: 'online_no_scan',
      role: 'NURSING_INCHARGE',
    });
    expect(asNumber(unmatched.quantity)).toBe(1);
    expect(unmatched.override_reason?.trim().length).toBeGreaterThanOrEqual(5);
    expect(unmatched.override_recorded_at).not.toBeNull();
    expect(unmatched.reconciliation_task_id).not.toBeNull();
    expect(matched).toMatchObject({
      medication_administration_id: scanned.id,
      evidence_status: 'matched',
      administration_mode: 'online_barcode_scan',
      role: 'NURSING_INCHARGE',
    });
    expect(matched.inventory_allocation_id).not.toBeNull();
    expect(matched.inventory_batch_id).not.toBeNull();
    expect(asNumber(matched.quantity)).toBe(1);

    const receipt = (await prisma.$queryRawUnsafe(
      `SELECT created_at
         FROM ward_indent_inventory_receipt_events
        WHERE tenant_id = $1::uuid
          AND ward_indent_id = $2::int
          AND ward_indent_state_version = 5`,
      TENANT_ID,
      asNumber(journey.ward_indent_id),
    ))[0];
    expect(receipt).toBeDefined();
    expect(new Date(noScan.administered_at).getTime())
      .toBeLessThan(new Date(receipt.created_at).getTime());
    expect(new Date(unmatched.created_at).getTime())
      .toBeLessThan(new Date(receipt.created_at).getTime());
    expect(new Date(scanned.administered_at).getTime())
      .toBeGreaterThan(new Date(receipt.created_at).getTime());

    const links = await prisma.$queryRawUnsafe(
      `SELECT link.id, link.unmatched_consumption_id,
              link.inventory_allocation_id, link.inventory_batch_id,
              link.quantity, link.command_key, link.reconciled_by::text,
              link.created_at, actor.role
         FROM mar_supply_reconciliation_links link
         JOIN users actor
           ON actor.tenant_id = link.tenant_id
          AND actor.uid = link.reconciled_by
        WHERE link.tenant_id = $1::uuid
          AND link.unmatched_consumption_id = $2::bigint
        ORDER BY link.inventory_allocation_id, link.id`,
      TENANT_ID,
      unmatched.id,
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      unmatched_consumption_id: unmatched.id,
      inventory_allocation_id: matched.inventory_allocation_id,
      inventory_batch_id: matched.inventory_batch_id,
      role: 'PHARMACY_INCHARGE',
    });
    expect(asNumber(links[0].quantity)).toBe(1);
    expect(new Date(links[0].created_at).getTime())
      .toBeGreaterThan(new Date(receipt.created_at).getTime());

    const batch = (await prisma.$queryRawUnsafe(
      `SELECT batch.batch_number, batch.lot_number, batch.metadata
         FROM pharmacy_inventory_batches batch
        WHERE batch.tenant_id = $1::uuid
          AND batch.id = $2::int`,
      TENANT_ID,
      asNumber(matched.inventory_batch_id),
    ))[0];
    const authoritativeBarcodes = [
      batch.metadata?.barcode,
      batch.metadata?.gtin,
      batch.metadata?.qr_code,
      batch.batch_number,
      batch.lot_number,
    ].filter(Boolean);
    expect(authoritativeBarcodes).toContain(scanned.scanned_barcode);

    const safetyReviews = await prisma.$queryRawUnsafe(
      `SELECT review_type, severity, status, override_required,
              override_reason, overridden_by::text, overridden_at, payload
         FROM medication_safety_reviews
        WHERE tenant_id = $1::uuid
          AND clinical_order_id = $2::int
          AND review_type = 'bcma_no_scan_override'`,
      TENANT_ID,
      asNumber(journey.clinical_order_id),
    );
    expect(safetyReviews).toHaveLength(1);
    expect(safetyReviews[0]).toMatchObject({
      review_type: 'bcma_no_scan_override',
      severity: 'medium',
      status: 'overridden',
      override_required: true,
      override_reason: noScan.override_reason,
      overridden_by: noScan.administered_by,
    });
    expect(safetyReviews[0].overridden_at).not.toBeNull();
    expect(String(
      safetyReviews[0].payload.medication_administration_id
        ?? safetyReviews[0].payload.ma_id,
    )).toBe(String(noScan.id));

    const administrationReceipts = await prisma.$queryRawUnsafe(
      `SELECT receipt.medication_administration_id,
              receipt.actor_uid::text, receipt.command_scope,
              receipt.command_key, receipt.request_body_sha256::text,
              receipt.administration_mode, receipt.response_data
         FROM mar_administration_command_receipts receipt
        WHERE receipt.tenant_id = $1::uuid
          AND receipt.medication_administration_id = ANY($2::int[])
        ORDER BY receipt.medication_administration_id`,
      TENANT_ID,
      [noScan.id, scanned.id],
    );
    expect(administrationReceipts).toHaveLength(2);
    for (const commandReceipt of administrationReceipts) {
      const administration = commandReceipt.medication_administration_id === noScan.id
        ? noScan
        : scanned;
      const supply = commandReceipt.medication_administration_id === noScan.id
        ? unmatched
        : matched;
      const expectedBody = commandReceipt.command_scope === 'mar_administer_scan'
        ? {
          scanned_patient_uid: administration.scanned_patient_uid,
          scanned_barcode: administration.scanned_barcode,
          witness_uid: administration.witness_uid,
          override_reason: administration.override_reason,
          supply_override_reason: null,
          supply_quantity: null,
        }
        : {
          notes: administration.notes,
          witness_uid: administration.witness_uid,
          override_reason: administration.override_reason,
          supply_override_reason: supply.override_reason,
          supply_quantity: null,
        };
      expect(commandReceipt.request_body_sha256)
        .toBe(fingerprintMarAdministrationRequest(expectedBody));
      expect(commandReceipt.response_data).toMatchObject({
        id: administration.id,
        status: 'administered',
      });
      expect(commandReceipt.actor_uid).toBe(administration.administered_by);
      expect(commandReceipt.administration_mode).toBe(supply.administration_mode);
    }

    const reconciliationReceipts = await prisma.$queryRawUnsafe(
      `SELECT unmatched_consumption_id, medication_administration_id,
              actor_uid::text, command_key, request_body_sha256::text,
              response_data
         FROM mar_supply_reconciliation_command_receipts
        WHERE tenant_id = $1::uuid
          AND unmatched_consumption_id = $2::bigint`,
      TENANT_ID,
      unmatched.id,
    );
    expect(reconciliationReceipts).toHaveLength(1);
    expect(reconciliationReceipts[0].request_body_sha256).toBe(reconciliationRequestHash({
      consumptionId: unmatched.id,
      administrationId: noScan.id,
      links,
    }));
    expect(reconciliationReceipts[0].response_data).toMatchObject({
      consumption: { id: asNumber(unmatched.id) },
      reconciled_quantity: 1,
      outstanding_quantity: 0,
    });
    expect(reconciliationReceipts[0].response_data.links).toEqual([
      expect.objectContaining({ id: asNumber(links[0].id) }),
    ]);

    const transitionReceipts = await prisma.$queryRawUnsafe(
      `SELECT receipt.medication_administration_id,
              receipt.actor_uid::text, receipt.command_scope,
              receipt.transition_action, receipt.request_body_sha256::text,
              receipt.response_data, actor.role
         FROM mar_transition_command_receipts receipt
         JOIN users actor
           ON actor.tenant_id = receipt.tenant_id
          AND actor.uid = receipt.actor_uid
        WHERE receipt.tenant_id = $1::uuid
          AND receipt.medication_administration_id = ANY($2::int[])
        ORDER BY receipt.transition_action`,
      TENANT_ID,
      [held.id, missed.id],
    );
    expect(transitionReceipts).toHaveLength(2);
    for (const transition of transitionReceipts) {
      const administration = transition.transition_action === 'held' ? held : missed;
      const reason = transition.transition_action === 'held'
        ? administration.hold_reason
        : administration.notes;
      expect(transition).toMatchObject({
        medication_administration_id: administration.id,
        actor_uid: transition.transition_action === 'held'
          ? administration.held_by
          : administration.missed_by,
        role: 'NURSING_INCHARGE',
        response_data: {
          id: administration.id,
          status: transition.transition_action,
        },
      });
      expect(transition.request_body_sha256)
        .toBe(fingerprintMarTransitionRequest({ reason }));
    }

    const marTaskRows = await prisma.$queryRawUnsafe(
      `SELECT task.id, task.status, task.assigned_to_uid::text,
              task.assigned_to_role, task.stage_occurrence_key,
              task.workflow_sla_instance_id::text, task.metadata,
              sla.id::text AS sla_id, sla.status AS sla_status,
              sla.completed_at, sla.rule_code, sla.source_table, sla.source_id
         FROM tasks task
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid
          AND task.id = $2::int`,
      TENANT_ID,
      asNumber(unmatched.reconciliation_task_id),
    );
    expect(marTaskRows).toHaveLength(1);
    const marTask = marTaskRows[0];
    expect(marTask).toMatchObject({
      status: 'completed',
      assigned_to_role: 'PHARMACY_INCHARGE',
      workflow_sla_instance_id: marTask.sla_id,
      sla_status: 'completed',
      rule_code: 'ward_indent_mar_supply_reconciliation',
      source_table: 'medication_administrations',
      source_id: String(noScan.id),
      stage_occurrence_key: stageOccurrenceKey(`mar-supply:${noScan.id}`),
    });
    expect(marTask.completed_at).not.toBeNull();
    expect(marTask.metadata).toMatchObject({
      task_contract: 'ward_medication_obligation_v1',
      med_03: true,
      obligation_kind: 'mar_supply_reconciliation',
      evidence_kind: 'mar_supply_reconciled',
      medication_administration_id: noScan.id,
    });

    const marOutboxRows = await prisma.$queryRawUnsafe(
      `SELECT outbox.type, outbox.recipient_id, outbox.recipient_phone,
              outbox.title, outbox.body, outbox.payload, outbox.status,
              outbox.channel, outbox.source_event_key, outbox.recipient_key,
              outbox.template_version, outbox.rendered_intent_hash::text,
              recipient.role AS recipient_role
         FROM notification_outbox outbox
         JOIN users recipient
           ON recipient.tenant_id = outbox.tenant_id
          AND recipient.id::text = outbox.recipient_id
        WHERE outbox.tenant_id = $1::uuid
          AND outbox.source_event_key = $2::text`,
      TENANT_ID,
      `mar-supply:${noScan.id}:unmatched`,
    );
    expect(marOutboxRows).toHaveLength(1);
    expect(marOutboxRows[0]).toMatchObject({
      type: 'ward_indent_mar_supply_reconciliation',
      template_version: 'ward_indent_mar_supply_reconciliation.v1',
      recipient_role: 'PHARMACY_INCHARGE',
      payload: {
        kind: 'ward_indent_mar_supply_reconciliation',
        task_id: asNumber(marTask.id),
        medication_administration_id: noScan.id,
      },
    });
    expectCanonicalOutbox(marOutboxRows[0]);
  });

  test('governs every held or missed dose and closes only the bounded missed review', async () => {
    const exceptionRows = await prisma.$queryRawUnsafe(
      `SELECT administration.id AS medication_administration_id,
              administration.status AS administration_status,
              administration.patient_uid::text,
              administration.clinical_order_id,
              administration.held_by::text, administration.held_at,
              administration.hold_reason,
              administration.missed_by::text, administration.missed_at,
              administration.refusal_reason, administration.notes,
              clinical_order.status AS clinical_order_status,
              clinical_order.ordered_by::text,
              clinical_order.encounter_id::text AS clinical_order_encounter_id,
              exception_case.id::text AS exception_case_id,
              exception_case.exception_kind, exception_case.status AS case_status,
              exception_case.reason AS case_reason,
              exception_case.raised_by::text, exception_case.raised_at,
              exception_case.assigned_prescriber_uid::text,
              exception_case.task_id,
              exception_case.workflow_sla_instance_id::text,
              exception_case.notification_coverage_status,
              exception_case.notified_at, exception_case.resolution_kind,
              exception_case.resolution_event_id::text,
              exception_case.resolved_by::text, exception_case.resolved_at,
              raiser.role AS raised_by_role,
              prescriber.id AS assigned_prescriber_id,
              prescriber.role AS assigned_prescriber_role,
              task.id AS typed_task_id,
              task.workflow_sla_instance_id::text AS task_workflow_sla_instance_id,
              task.task_kind, task.title AS task_title,
              task.description AS task_description,
              task.patient_uid::text AS task_patient_uid,
              task.encounter_id AS task_encounter_id,
              task.related_resource_type, task.related_resource_id,
              task.priority AS task_priority, task.status AS task_status,
              task.assigned_to_uid::text, task.assigned_to_role,
              task.created_by::text AS task_created_by,
              task.due_at AS task_due_at, task.completed_at AS task_completed_at,
              task.sla_completion_semantics, task.stage_occurrence_key,
              task.metadata AS task_metadata,
              sla.rule_code, sla.patient_uid::text AS sla_patient_uid,
              sla.encounter_id::text AS sla_encounter_id,
              sla.source_table, sla.source_id, sla.status AS sla_status,
              sla.priority AS sla_priority, sla.started_at, sla.due_at AS sla_due_at,
              sla.completed_at AS sla_completed_at, sla.breached_at,
              sla.assigned_role_codes, sla.assigned_user_uid::text,
              sla.metadata AS sla_metadata,
              transition.command_scope AS transition_command_scope,
              transition.transition_action,
              transition.command_key AS transition_command_key,
              transition.request_body_sha256::text AS transition_request_hash
         FROM medication_administrations administration
         JOIN clinical_orders clinical_order
           ON clinical_order.tenant_id = administration.tenant_id
          AND clinical_order.id = administration.clinical_order_id
         LEFT JOIN mar_medication_exception_cases exception_case
           ON exception_case.tenant_id = administration.tenant_id
          AND exception_case.medication_administration_id = administration.id
         LEFT JOIN users raiser
           ON raiser.tenant_id = exception_case.tenant_id
          AND raiser.uid = exception_case.raised_by
         LEFT JOIN users prescriber
           ON prescriber.tenant_id = exception_case.tenant_id
          AND prescriber.uid = exception_case.assigned_prescriber_uid
         LEFT JOIN tasks task
           ON task.tenant_id = exception_case.tenant_id
          AND task.id = exception_case.task_id
         LEFT JOIN workflow_sla_instances sla
           ON sla.tenant_id = exception_case.tenant_id
          AND sla.id = exception_case.workflow_sla_instance_id
         LEFT JOIN mar_transition_command_receipts transition
           ON transition.tenant_id = administration.tenant_id
          AND transition.medication_administration_id = administration.id
        WHERE administration.tenant_id = $1::uuid
          AND administration.clinical_order_id = $2::int
          AND LOWER(administration.status) IN ('held', 'missed')
        ORDER BY administration.scheduled_time, administration.id`,
      TENANT_ID,
      asNumber(journey.clinical_order_id),
    );
    expect(exceptionRows).toHaveLength(2);

    const held = exceptionRows.find((row) => row.administration_status === 'held');
    const missed = exceptionRows.find((row) => row.administration_status === 'missed');
    expect(held).toBeDefined();
    expect(missed).toBeDefined();

    const expectedPrescriberRoles = [
      'DOCTOR',
      'DUTY_DOCTOR',
      'CONSULTANT',
      'JUNIOR_DOCTOR',
      'RESIDENT',
    ];
    for (const row of exceptionRows) {
      const attributionUid = row.exception_kind === 'held' ? row.held_by : row.missed_by;
      const attributionAt = row.exception_kind === 'held' ? row.held_at : row.missed_at;
      const recordedReason = row.exception_kind === 'held' ? row.hold_reason : row.notes;
      expect(row.exception_case_id).toMatch(/^[1-9][0-9]*$/);
      expect(row).toMatchObject({
        patient_uid: journey.patient_uid,
        clinical_order_id: journey.clinical_order_id,
        clinical_order_status: 'verified',
        clinical_order_encounter_id: journey.encounter_id,
        case_reason: recordedReason,
        raised_by: attributionUid,
        raised_by_role: 'NURSING_INCHARGE',
        assigned_prescriber_uid: row.ordered_by,
        task_kind: 'review',
        task_description:
          'Record an explicit prescriber disposition. This task cannot change a medication order.',
        task_patient_uid: journey.patient_uid,
        task_encounter_id: null,
        related_resource_type: 'mar_medication_exception_cases',
        related_resource_id: row.exception_case_id,
        task_priority: 'critical',
        assigned_to_uid: row.assigned_prescriber_uid,
        assigned_to_role: null,
        task_created_by: attributionUid,
        typed_task_id: row.task_id,
        task_workflow_sla_instance_id: row.workflow_sla_instance_id,
        sla_completion_semantics: 'domain_evidence',
        stage_occurrence_key: marExceptionOccurrenceKey(row.exception_case_id),
        workflow_sla_instance_id: row.workflow_sla_instance_id,
        rule_code: 'mar_medication_exception_review',
        sla_patient_uid: journey.patient_uid,
        sla_encounter_id: row.clinical_order_encounter_id,
        source_table: 'mar_medication_exception_cases',
        source_id: row.exception_case_id,
        sla_priority: 'critical',
        assigned_role_codes: expectedPrescriberRoles,
        assigned_user_uid: row.assigned_prescriber_uid,
        notification_coverage_status: 'notified',
        transition_action: row.exception_kind,
      });
      expect(expectedPrescriberRoles).toContain(row.assigned_prescriber_role);
      expect(new Date(row.raised_at).toISOString()).toBe(new Date(attributionAt).toISOString());
      expect(new Date(row.started_at).toISOString()).toBe(new Date(row.raised_at).toISOString());
      expect(new Date(row.sla_due_at).getTime() - new Date(row.started_at).getTime())
        .toBe(15 * 60 * 1000);
      expect(new Date(row.task_due_at).toISOString()).toBe(new Date(row.sla_due_at).toISOString());
      expect(row.notified_at).not.toBeNull();
      expect(row.task_metadata).toMatchObject({
        task_contract: 'mar_medication_exception_v1',
        med_03: true,
        sla_key: 'mar_medication_exception_review',
        sla_instance_id: row.workflow_sla_instance_id,
        canonical_encounter_id: row.clinical_order_encounter_id,
        exception_case_id: asNumber(row.exception_case_id),
        medication_administration_id: row.medication_administration_id,
        clinical_order_id: journey.clinical_order_id,
        exception_kind: row.exception_kind,
        evidence_kind: 'mar_medication_exception_resolution',
        deep_link: `/mar/due?exception_id=${asNumber(row.exception_case_id)}`,
      });
      expect(row.sla_metadata).toMatchObject({
        med_03: true,
        exception_case_id: asNumber(row.exception_case_id),
        medication_administration_id: row.medication_administration_id,
        exception_kind: row.exception_kind,
      });
    }

    expect(held).toMatchObject({
      exception_kind: 'held',
      case_status: 'open',
      task_title: 'Review held medication dose',
      task_status: 'open',
      sla_status: 'active',
      sla_completed_at: null,
      breached_at: null,
      resolution_kind: null,
      resolution_event_id: null,
      resolved_by: null,
      resolved_at: null,
      transition_command_scope: 'mar_hold',
      transition_command_key: 'seed-med03-mar-hold-v1',
    });
    expect(new Date(held.sla_due_at).getTime()).toBeLessThan(Date.now());

    expect(missed).toMatchObject({
      exception_kind: 'missed',
      refusal_reason: null,
      case_status: 'resolved',
      task_title: 'Review missed medication dose',
      task_status: 'completed',
      sla_status: 'completed',
      resolution_kind: 'reviewed_no_replacement',
      resolved_by: missed.assigned_prescriber_uid,
      transition_command_scope: 'mar_miss',
      transition_command_key: 'seed-med03-mar-miss-v1',
    });
    expect(missed.resolution_event_id).toMatch(/^[1-9][0-9]*$/);
    expect(new Date(missed.resolved_at).getTime() - new Date(missed.raised_at).getTime())
      .toBe(5 * 60 * 1000);
    expect(new Date(missed.task_completed_at).toISOString())
      .toBe(new Date(missed.resolved_at).toISOString());
    expect(new Date(missed.sla_completed_at).toISOString())
      .toBe(new Date(missed.resolved_at).toISOString());
    expect(missed.sla_metadata).toMatchObject({
      completed_via: 'domain_evidence',
      completed_by_task: String(missed.task_id),
      completed_by: missed.assigned_prescriber_uid,
      completion_evidence: {
        kind: 'mar_medication_exception_resolution',
        resource_type: 'mar_medication_exception_event',
        resource_id: missed.resolution_event_id,
        occurred_at: new Date(missed.resolved_at).toISOString(),
        recorded_at: new Date(missed.resolved_at).toISOString(),
        disposition: 'reviewed_no_replacement',
        actor_uid: missed.assigned_prescriber_uid,
      },
    });

    const completionComments = await prisma.$queryRawUnsafe(
      `SELECT comment.author_uid::text, comment.body, comment.body_kind,
              comment.metadata, comment.created_at
         FROM task_comments comment
        WHERE comment.tenant_id = $1::uuid
          AND comment.task_id = $2::int
          AND comment.metadata->>'completion_via' = 'domain_evidence'`,
      TENANT_ID,
      asNumber(missed.task_id),
    );
    expect(completionComments).toHaveLength(1);
    expect(completionComments[0]).toMatchObject({
      author_uid: missed.assigned_prescriber_uid,
      body_kind: 'state_change',
      metadata: {
        to: 'completed',
        completion_via: 'domain_evidence',
        evidence: missed.sla_metadata.completion_evidence,
      },
    });
    expect(completionComments[0].body).toContain(
      `mar_medication_exception_resolution:${missed.resolution_event_id}`,
    );
    expect(new Date(completionComments[0].created_at).toISOString())
      .toBe(new Date(missed.resolved_at).toISOString());

    const caseIds = exceptionRows.map((row) => asNumber(row.exception_case_id));
    const events = await prisma.$queryRawUnsafe(
      `SELECT event.id::text, event.exception_case_id::text,
              event.medication_administration_id, event.event_type,
              event.disposition, event.actor_uid::text, event.actor_role,
              event.reason, event.replacement_clinical_order_id,
              event.command_key, event.request_fingerprint::text,
              event.occurred_at, event.payload
         FROM mar_medication_exception_events event
        WHERE event.tenant_id = $1::uuid
          AND event.exception_case_id = ANY($2::bigint[])
        ORDER BY event.exception_case_id, event.occurred_at, event.id`,
      TENANT_ID,
      caseIds,
    );
    expect(events).toHaveLength(3);

    for (const row of exceptionRows) {
      const caseEvents = events.filter((event) => (
        event.exception_case_id === row.exception_case_id
      ));
      const raisedEvent = caseEvents.find((event) => event.event_type === 'raised');
      expect(raisedEvent).toMatchObject({
        medication_administration_id: row.medication_administration_id,
        disposition: null,
        actor_uid: row.raised_by,
        actor_role: 'NURSING_INCHARGE',
        reason: row.case_reason,
        replacement_clinical_order_id: null,
        command_key: row.transition_command_key,
        request_fingerprint: row.transition_request_hash,
        payload: {
          clinical_order_id: journey.clinical_order_id,
          clinical_order_status: 'ordered',
        },
      });
      expect(new Date(raisedEvent.occurred_at).toISOString())
        .toBe(new Date(row.raised_at).toISOString());
      if (row.exception_kind === 'held') expect(caseEvents).toHaveLength(1);
    }

    const missedResolutionReason =
      'Prescriber reviewed the missed dose; no replacement dose was ordered.';
    const resolvedEvent = events.find((event) => event.event_type === 'resolved');
    expect(resolvedEvent).toMatchObject({
      id: missed.resolution_event_id,
      exception_case_id: missed.exception_case_id,
      medication_administration_id: missed.medication_administration_id,
      disposition: 'reviewed_no_replacement',
      actor_uid: missed.assigned_prescriber_uid,
      actor_role: missed.assigned_prescriber_role,
      reason: missedResolutionReason,
      replacement_clinical_order_id: null,
      command_key: 'seed-med03-mar-exception-missed-disposition-v1',
      payload: {
        clinical_order_id: journey.clinical_order_id,
        clinical_order_status: 'ordered',
        replacement_clinical_order_status: null,
      },
    });
    expect(resolvedEvent.request_fingerprint).toBe(jsonHash({
      exception_case_id: asNumber(missed.exception_case_id),
      disposition: 'reviewed_no_replacement',
      reason: missedResolutionReason,
      replacement_clinical_order_id: null,
    }));
    expect(new Date(resolvedEvent.occurred_at).toISOString())
      .toBe(new Date(missed.resolved_at).toISOString());

    const intents = await prisma.$queryRawUnsafe(
      `SELECT outbox.type, outbox.recipient_id, outbox.recipient_phone,
              outbox.title, outbox.body, outbox.payload, outbox.status,
              outbox.channel, outbox.source_event_key, outbox.recipient_key,
              outbox.template_version, outbox.rendered_intent_hash::text,
              recipient.uid::text AS recipient_uid, recipient.role AS recipient_role
         FROM notification_outbox outbox
         JOIN users recipient
           ON recipient.tenant_id = outbox.tenant_id
          AND recipient.id::text = outbox.recipient_id
        WHERE outbox.tenant_id = $1::uuid
          AND outbox.type = 'mar_medication_exception'
          AND outbox.payload->>'exception_case_id' = ANY($2::text[])
        ORDER BY (outbox.payload->>'exception_case_id')::bigint`,
      TENANT_ID,
      exceptionRows.map((row) => row.exception_case_id),
    );
    expect(intents).toHaveLength(2);
    for (const row of exceptionRows) {
      const raisedEvent = events.find((event) => (
        event.exception_case_id === row.exception_case_id && event.event_type === 'raised'
      ));
      const intent = intents.find((candidate) => (
        String(candidate.payload.exception_case_id) === row.exception_case_id
      ));
      expect(intent).toMatchObject({
        type: 'mar_medication_exception',
        title: 'Medication dose requires prescriber review',
        body: 'A held or missed inpatient medication dose requires a governed clinical disposition.',
        source_event_key: `mar-exception:${row.exception_case_id}:raised:${raisedEvent.id}`,
        template_version: 'mar-medication-exception.v1',
        recipient_id: String(row.assigned_prescriber_id),
        recipient_uid: row.assigned_prescriber_uid,
        recipient_role: row.assigned_prescriber_role,
        payload: {
          kind: 'mar_medication_exception',
          task_id: asNumber(row.task_id),
          exception_case_id: asNumber(row.exception_case_id),
          medication_administration_id: row.medication_administration_id,
          deep_link: `/mar/due?exception_id=${asNumber(row.exception_case_id)}`,
        },
      });
      expectCanonicalOutbox(intent);
    }

    const orphaned = await prisma.$queryRawUnsafe(
      `SELECT administration.id
         FROM medication_administrations administration
        WHERE administration.tenant_id = $1::uuid
          AND LOWER(administration.status) IN ('held', 'missed')
          AND NOT EXISTS (
            SELECT 1
              FROM mar_medication_exception_cases exception_case
              JOIN tasks task
                ON task.tenant_id = exception_case.tenant_id
               AND task.id = exception_case.task_id
              JOIN workflow_sla_instances sla
                ON sla.tenant_id = exception_case.tenant_id
               AND sla.id = exception_case.workflow_sla_instance_id
              JOIN mar_medication_exception_events raised_event
                ON raised_event.tenant_id = exception_case.tenant_id
               AND raised_event.exception_case_id = exception_case.id
               AND raised_event.medication_administration_id = administration.id
               AND raised_event.event_type = 'raised'
             WHERE exception_case.tenant_id = administration.tenant_id
               AND exception_case.medication_administration_id = administration.id
               AND exception_case.patient_uid = administration.patient_uid
               AND exception_case.clinical_order_id = administration.clinical_order_id
               AND exception_case.exception_kind = LOWER(administration.status)
               AND exception_case.notification_coverage_status <> 'pending'
               AND task.metadata->>'task_contract' = 'mar_medication_exception_v1'
               AND task.related_resource_type = 'mar_medication_exception_cases'
               AND task.related_resource_id = exception_case.id::text
               AND task.workflow_sla_instance_id = sla.id
               AND sla.rule_code = 'mar_medication_exception_review'
               AND sla.source_table = task.related_resource_type
               AND sla.source_id = task.related_resource_id
               AND (
                 (
                   exception_case.status = 'open'
                   AND task.status IN ('open', 'in_progress', 'blocked', 'overdue')
                   AND sla.status IN ('active', 'breached', 'escalated')
                   AND sla.completed_at IS NULL
                 )
                 OR (
                   exception_case.status = 'resolved'
                   AND task.status = 'completed'
                   AND sla.completed_at IS NOT NULL
                   AND EXISTS (
                     SELECT 1
                       FROM mar_medication_exception_events resolution_event
                      WHERE resolution_event.tenant_id = exception_case.tenant_id
                        AND resolution_event.id = exception_case.resolution_event_id
                        AND resolution_event.exception_case_id = exception_case.id
                        AND resolution_event.event_type = 'resolved'
                        AND resolution_event.disposition = exception_case.resolution_kind
                        AND resolution_event.actor_uid = exception_case.resolved_by
                   )
                 )
               )
               AND (
                 (
                   exception_case.notification_coverage_status = 'notified'
                   AND EXISTS (
                     SELECT 1
                       FROM notification_outbox outbox
                      WHERE outbox.tenant_id = exception_case.tenant_id
                        AND outbox.type = 'mar_medication_exception'
                        AND outbox.source_event_key =
                              'mar-exception:' || exception_case.id::text
                              || ':raised:' || raised_event.id::text
                        AND outbox.payload->>'task_id' = task.id::text
                        AND outbox.payload->>'exception_case_id' = exception_case.id::text
                        AND outbox.payload->>'medication_administration_id' =
                              administration.id::text
                   )
                 )
                 OR (
                   exception_case.notification_coverage_status = 'coverage_gap'
                   AND EXISTS (
                     SELECT 1
                       FROM mar_medication_exception_events coverage_event
                      WHERE coverage_event.tenant_id = exception_case.tenant_id
                        AND coverage_event.exception_case_id = exception_case.id
                        AND coverage_event.event_type = 'notification_coverage_gap'
                   )
                 )
               )
          )`,
      TENANT_ID,
    );
    expect(orphaned).toEqual([]);
  });

  test('keeps a balanced issued INR 30 invoice and an actionable pending INR 10 credit', async () => {
    const invoices = await prisma.$queryRawUnsafe(
      `SELECT invoice.id, invoice.patient_uid::text, invoice.admission_id,
              invoice.subtotal, invoice.total_amount, invoice.amount_paid,
              invoice.amount_due, invoice.credit_note_amount, invoice.status,
              invoice.issued_at, invoice.created_by::text,
              line.id AS invoice_item_id, line.service_code, line.category, line.quantity,
              line.unit_price, line.line_subtotal, line.line_total,
              line.source_ref_type, line.source_ref_id
         FROM billing_invoices invoice
         JOIN billing_invoice_items line
           ON line.tenant_id = invoice.tenant_id
          AND line.invoice_id = invoice.id
        WHERE invoice.tenant_id = $1::uuid
          AND invoice.invoice_number = $2::text`,
      TENANT_ID,
      INVOICE_NUMBER,
    );
    expect(invoices).toHaveLength(1);
    const invoice = invoices[0];
    expect(invoice).toMatchObject({
      patient_uid: journey.patient_uid,
      admission_id: journey.admission_id,
      status: 'ISSUED',
      category: 'pharmacy',
      service_code: `WARD-MED-${journey.ward_indent_item_id}`,
      source_ref_type: 'ward_indent_item',
    });
    expect(invoice.issued_at).not.toBeNull();
    expect(asNumber(invoice.subtotal)).toBe(30);
    expect(asNumber(invoice.total_amount)).toBe(30);
    expect(asNumber(invoice.amount_paid)).toBe(0);
    expect(asNumber(invoice.amount_due)).toBe(30);
    expect(asNumber(invoice.credit_note_amount)).toBe(0);
    expect(asNumber(invoice.quantity)).toBe(3);
    expect(asNumber(invoice.unit_price)).toBe(10);
    expect(asNumber(invoice.line_subtotal)).toBe(30);
    expect(asNumber(invoice.line_total)).toBe(30);
    expect(asNumber(invoice.source_ref_id)).toBe(asNumber(journey.ward_indent_item_id));

    const financialEvents = await prisma.$queryRawUnsafe(
      `SELECT event.id, event.event_kind, event.quantity,
              event.unit_price_minor::text, event.amount_minor::text,
              event.original_event_id, event.invoice_id,
              event.invoice_item_id, event.ward_indent_state_version,
              event.pricing_snapshot, event.actor_uid::text, actor.role
         FROM ward_indent_financial_events event
         JOIN users actor
           ON actor.tenant_id = event.tenant_id
          AND actor.uid = event.actor_uid
        WHERE event.tenant_id = $1::uuid
          AND event.ward_indent_id = $2::int
        ORDER BY event.ward_indent_state_version, event.id`,
      TENANT_ID,
      asNumber(journey.ward_indent_id),
    );
    expect(financialEvents).toHaveLength(2);
    const charge = financialEvents[0];
    const credit = financialEvents[1];
    expect(charge).toMatchObject({
      event_kind: 'charge',
      original_event_id: null,
      invoice_id: invoice.id,
      invoice_item_id: invoice.invoice_item_id,
      ward_indent_state_version: 4,
      role: 'PHARMACY_INCHARGE',
    });
    expect(asNumber(charge.quantity)).toBe(3);
    expect(asNumber(charge.unit_price_minor)).toBe(1000);
    expect(asNumber(charge.amount_minor)).toBe(3000);
    expect(charge.pricing_snapshot).toMatchObject({
      source: 'ward_indent_approved_price',
      catalog_id: asNumber(journey.pharmacy_catalog_id),
      catalog_name: CATALOG_NAME,
      unit_price_minor: 1000,
      currency: 'INR',
      gst_rate: 0,
    });
    expect(credit).toMatchObject({
      event_kind: 'credit',
      original_event_id: charge.id,
      invoice_id: invoice.id,
      invoice_item_id: invoice.invoice_item_id,
      ward_indent_state_version: 7,
      role: 'PHARMACY_INCHARGE',
    });
    expect(asNumber(credit.quantity)).toBe(1);
    expect(asNumber(credit.unit_price_minor)).toBe(1000);
    expect(asNumber(credit.amount_minor)).toBe(-1000);
    expect(credit.pricing_snapshot).toMatchObject({
      source: 'ward_indent_approved_price',
      catalog_id: asNumber(journey.pharmacy_catalog_id),
      unit_price_minor: 1000,
      currency: 'INR',
      original_charge_event_id: String(charge.id),
    });

    const entries = await prisma.$queryRawUnsafe(
      `SELECT id, entry_type, idempotency_key, created_by::text, metadata
         FROM ledger_entries
        WHERE tenant_id = $1::uuid
          AND idempotency_key = $2::text`,
      TENANT_ID,
      `issue-inv-${invoice.id}`,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entry_type: 'INVOICE_ISSUE',
      idempotency_key: `issue-inv-${invoice.id}`,
    });
    const postings = await prisma.$queryRawUnsafe(
      `SELECT account.code, posting.amount_paise::text,
              posting.patient_uid::text, posting.invoice_id
         FROM ledger_postings posting
         JOIN ledger_accounts account
           ON account.id = posting.account_id
        WHERE posting.tenant_id = $1::uuid
          AND posting.entry_id = $2::bigint
        ORDER BY account.code`,
      TENANT_ID,
      entries[0].id,
    );
    expect(postings.map((posting) => ({
      code: posting.code,
      amountPaise: asNumber(posting.amount_paise),
      patientUid: posting.patient_uid,
      invoiceId: posting.invoice_id == null ? null : asNumber(posting.invoice_id),
    }))).toEqual([
      {
        code: 'PATIENT_AR',
        amountPaise: 3000,
        patientUid: journey.patient_uid,
        invoiceId: invoice.id,
      },
      {
        code: 'REVENUE',
        amountPaise: -3000,
        patientUid: null,
        invoiceId: null,
      },
    ]);
    expect(postings.reduce(
      (sum, posting) => sum + asNumber(posting.amount_paise),
      0,
    )).toBe(0);

    const creditNotes = await prisma.$queryRawUnsafe(
      `SELECT note.id, note.credit_note_number, note.invoice_id,
              note.patient_uid::text, note.source_financial_event_id,
              note.amount_minor::text, note.currency, note.status,
              note.task_id, note.raised_by::text, note.raised_at,
              note.approved_by::text, note.rejected_by::text,
              note.applied_by::text, note.application_key,
              note.receivable_credit_minor::text,
              note.refund_obligation_minor::text, note.refund_id,
              actor.role AS raised_by_role
         FROM billing_credit_notes note
         JOIN users actor
           ON actor.tenant_id = note.tenant_id
          AND actor.uid = note.raised_by
        WHERE note.tenant_id = $1::uuid
          AND note.invoice_id = $2::int`,
      TENANT_ID,
      asNumber(invoice.id),
    );
    expect(creditNotes).toHaveLength(1);
    const creditNote = creditNotes[0];
    expect(creditNote).toMatchObject({
      credit_note_number: `CN-WI-${credit.id}`,
      invoice_id: invoice.id,
      patient_uid: journey.patient_uid,
      source_financial_event_id: credit.id,
      currency: 'INR',
      status: 'pending',
      approved_by: null,
      rejected_by: null,
      applied_by: null,
      application_key: null,
      refund_id: null,
      raised_by_role: 'PHARMACY_INCHARGE',
    });
    expect(asNumber(creditNote.amount_minor)).toBe(1000);
    expect(asNumber(creditNote.receivable_credit_minor)).toBe(0);
    expect(asNumber(creditNote.refund_obligation_minor)).toBe(0);

    const creditEvents = await prisma.$queryRawUnsafe(
      `SELECT event.event_type, event.actor_uid::text, event.command_key,
              event.request_body_sha256::text, event.details, actor.role
         FROM billing_credit_note_events event
         JOIN users actor
           ON actor.tenant_id = event.tenant_id
          AND actor.uid = event.actor_uid
        WHERE event.tenant_id = $1::uuid
          AND event.credit_note_id = $2::bigint`,
      TENANT_ID,
      creditNote.id,
    );
    expect(creditEvents).toHaveLength(1);
    const creditEvent = creditEvents[0];
    expect(creditEvent).toMatchObject({
      event_type: 'raised',
      role: 'PHARMACY_INCHARGE',
      details: {
        source_financial_event_id: String(credit.id),
        auto_applied_draft: false,
      },
    });
    expect(creditEvent.command_key).toMatch(/:raised$/);
    expect(creditEvent.request_body_sha256).toBe(createHash('sha256')
      .update(canonicalJson({
        event_type: 'raised',
        details: creditEvent.details,
      }))
      .digest('hex'));

    const creditTasks = await prisma.$queryRawUnsafe(
      `SELECT task.id, task.status, task.assigned_to_role,
              task.encounter_id, task.due_at, task.stage_occurrence_key,
              task.sla_completion_semantics, task.related_resource_type,
              task.related_resource_id, task.metadata,
              task.workflow_sla_instance_id::text,
              sla.id::text AS sla_id, sla.status AS sla_status,
              sla.rule_code, sla.source_table, sla.source_id,
              sla.completed_at, sla.due_at AS sla_due_at
         FROM tasks task
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid
          AND task.id = $2::int`,
      TENANT_ID,
      asNumber(creditNote.task_id),
    );
    expect(creditTasks).toHaveLength(1);
    const creditTask = creditTasks[0];
    expect(creditTask).toMatchObject({
      status: 'open',
      assigned_to_role: 'BILLING_INCHARGE',
      encounter_id: null,
      sla_completion_semantics: 'domain_evidence',
      related_resource_type: 'billing_credit_notes',
      related_resource_id: String(creditNote.id),
      stage_occurrence_key: stageOccurrenceKey(`credit-note:${creditNote.id}`),
      workflow_sla_instance_id: creditTask.sla_id,
      sla_status: 'active',
      rule_code: 'ward_indent_credit_note_review',
      source_table: 'billing_credit_notes',
      source_id: String(creditNote.id),
      completed_at: null,
    });
    expect(new Date(creditTask.due_at).toISOString())
      .toBe(new Date(creditTask.sla_due_at).toISOString());
    expect(new Date(creditTask.due_at).getTime()).toBeGreaterThan(Date.now());
    expect(creditTask.metadata).toMatchObject({
      task_contract: 'ward_medication_obligation_v1',
      med_03: true,
      obligation_kind: 'credit_note_review',
      evidence_kind: 'billing_credit_note_decision',
      owner_role_codes: ['BILLING_INCHARGE', 'FINANCE_INCHARGE'],
      credit_note_id: String(creditNote.id),
      invoice_id: invoice.id,
    });

    const creditOutboxRows = await prisma.$queryRawUnsafe(
      `SELECT outbox.type, outbox.recipient_id, outbox.recipient_phone,
              outbox.title, outbox.body, outbox.payload, outbox.status,
              outbox.channel, outbox.source_event_key, outbox.recipient_key,
              outbox.template_version, outbox.rendered_intent_hash::text,
              recipient.role AS recipient_role
         FROM notification_outbox outbox
         JOIN users recipient
           ON recipient.tenant_id = outbox.tenant_id
          AND recipient.id::text = outbox.recipient_id
        WHERE outbox.tenant_id = $1::uuid
          AND outbox.source_event_key = $2::text`,
      TENANT_ID,
      `billing-credit-note:${creditNote.id}:raised`,
    );
    expect(creditOutboxRows).toHaveLength(1);
    expect(creditOutboxRows[0]).toMatchObject({
      type: 'ward_indent_credit_note_review',
      template_version: 'ward_indent_credit_note_review.v1',
      recipient_role: 'BILLING_INCHARGE',
      payload: {
        kind: 'ward_indent_credit_note_review',
        task_id: asNumber(creditTask.id),
        credit_note_id: String(creditNote.id),
        invoice_id: invoice.id,
      },
    });
    expectCanonicalOutbox(creditOutboxRows[0]);

    const creditLedgerCount = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM ledger_entries
        WHERE tenant_id = $1::uuid
          AND idempotency_key = $2::text`,
      TENANT_ID,
      `ward-medication-credit-${creditNote.id}`,
    );
    expect(creditLedgerCount[0].count).toBe(0);
  });

  test('closes an independently approved offline electronic refund with exact provider evidence', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT refund.id, refund.patient_uid::text, refund.invoice_id,
              refund.amount, refund.mode, refund.approval_status,
              refund.approved_by::text, refund.paid_by::text,
              refund.payout_rail, refund.reference,
              refund.gateway_refund_id, refund.cash_drawer_session_id,
              refund.offline_electronic_evidence_id::text,
              invoice.invoice_number, invoice.status AS invoice_status,
              invoice.total_amount, invoice.amount_paid, invoice.amount_due,
              payment.id AS payment_id, payment.mode AS payment_mode,
              payment.amount AS payment_amount, payment.reference AS payment_reference,
              evidence.id::text AS evidence_id, evidence.mode AS evidence_mode,
              evidence.amount AS evidence_amount, evidence.provider_name,
              evidence.original_payment_reference,
              evidence.provider_refund_reference, evidence.provider_refunded_at,
              evidence.recorded_at, evidence.recorded_by::text,
              approver.role AS approver_role, payer.role AS payer_role
         FROM billing_refunds refund
         JOIN billing_invoices invoice
           ON invoice.tenant_id = refund.tenant_id
          AND invoice.id = refund.invoice_id
         JOIN billing_refund_offline_electronic_evidence evidence
           ON evidence.tenant_id = refund.tenant_id
          AND evidence.refund_id = refund.id
          AND evidence.id = refund.offline_electronic_evidence_id
         JOIN billing_payments payment
           ON payment.tenant_id = evidence.tenant_id
          AND payment.id = evidence.original_payment_id
         JOIN users approver
           ON approver.tenant_id = refund.tenant_id
          AND approver.uid = refund.approved_by
         JOIN users payer
           ON payer.tenant_id = refund.tenant_id
          AND payer.uid = refund.paid_by
        WHERE refund.tenant_id = $1::uuid
          AND evidence.provider_refund_reference = $2::text`,
      TENANT_ID,
      OFFLINE_REFUND_REFERENCE,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      patient_uid: journey.patient_uid,
      mode: 'CARD',
      approval_status: 'PAID',
      payout_rail: 'offline_electronic',
      reference: OFFLINE_REFUND_REFERENCE,
      gateway_refund_id: null,
      cash_drawer_session_id: null,
      invoice_number: 'VH-SEED-MED03-OFFLINE-INV-0001',
      invoice_status: 'PAID',
      payment_mode: 'CARD',
      payment_reference: 'VH-SEED-MED03-CARD-CAPTURE-001',
      evidence_mode: 'CARD',
      provider_name: 'VH Synthetic Acquirer',
      original_payment_reference: 'VH-SEED-MED03-CARD-CAPTURE-001',
      provider_refund_reference: OFFLINE_REFUND_REFERENCE,
      approver_role: 'ADMIN',
      payer_role: 'CASHIER',
    });
    expect(asNumber(row.amount)).toBe(25);
    expect(asNumber(row.total_amount)).toBe(25);
    expect(asNumber(row.amount_paid)).toBe(25);
    expect(asNumber(row.amount_due)).toBe(0);
    expect(asNumber(row.payment_amount)).toBe(25);
    expect(asNumber(row.evidence_amount)).toBe(25);
    expect(row.offline_electronic_evidence_id).toBe(row.evidence_id);
    expect(row.recorded_by).toBe(row.paid_by);
    expect(row.paid_by).not.toBe(row.approved_by);
    expect(new Date(row.provider_refunded_at).getTime())
      .toBeLessThanOrEqual(new Date(row.recorded_at).getTime());
  });

  test('terminally closes the counter-sale void, stock return, task, SLA, and drawer', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT request.id::text AS request_id, request.status AS request_status,
              request.task_stage, request.disposition, request.requested_by::text,
              request.reconciled_by::text, request.reconciliation_source,
              sale.id::text AS sale_id, sale.status AS sale_status,
              sale.invoice_id, sale.total_amount, sale.payment_mode,
              sale.void_refund_id, sale.voided_by::text, sale.void_reason,
              refund.id AS refund_id, refund.approval_status,
              refund.approved_by::text, refund.paid_by::text,
              refund.payout_rail, refund.reference AS refund_reference,
              refund.cash_drawer_session_id::text,
              requester.role AS requester_role,
              approver.role AS approver_role, payer.role AS payer_role,
              reconciler.role AS reconciler_role,
              task.id AS task_id, task.status AS task_status,
              task.assigned_to_role, task.sla_completion_semantics,
              task.related_resource_type, task.related_resource_id,
              task.completed_at AS task_completed_at, task.metadata AS task_metadata,
              sla.id::text AS sla_id, sla.status AS sla_status,
              sla.source_table, sla.source_id,
              sla.completed_at AS sla_completed_at, sla.metadata AS sla_metadata,
              drawer.status AS drawer_status, drawer.opening_float,
              drawer.counted_total, drawer.cash_inflow_total,
              drawer.cash_refund_total, drawer.system_total, drawer.variance,
              drawer.reviewed_by::text,
              allocation.id::text AS allocation_id,
              allocation.movement_id, allocation.return_movement_id,
              issue.quantity_delta AS issue_delta,
              returned.quantity_delta AS return_delta,
              issue.inventory_batch_id AS issue_batch_id,
              returned.inventory_batch_id AS return_batch_id,
              returned.reference_type AS return_reference_type,
              returned.reference_id AS return_reference_id,
              counter_sale_void_has_paid_evidence(request.id) AS paid_evidence
         FROM pharmacy_counter_sale_void_requests request
         JOIN pharmacy_counter_sales sale
           ON sale.tenant_id = request.tenant_id
          AND sale.id = request.counter_sale_id
         JOIN billing_refunds refund
           ON refund.tenant_id = request.tenant_id
          AND refund.id = request.refund_id
          AND refund.counter_sale_void_request_id = request.id
         JOIN users requester
           ON requester.tenant_id = request.tenant_id
          AND requester.uid = request.requested_by
         JOIN users approver
           ON approver.tenant_id = refund.tenant_id
          AND approver.uid = refund.approved_by
         JOIN users payer
           ON payer.tenant_id = refund.tenant_id
          AND payer.uid = refund.paid_by
         JOIN users reconciler
           ON reconciler.tenant_id = request.tenant_id
          AND reconciler.uid = request.reconciled_by
         JOIN tasks task
           ON task.tenant_id = request.tenant_id
          AND task.id = request.task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = request.tenant_id
          AND sla.id = request.workflow_sla_instance_id
          AND sla.id = task.workflow_sla_instance_id
         JOIN cash_drawer_sessions drawer
           ON drawer.tenant_id = refund.tenant_id
          AND drawer.id = refund.cash_drawer_session_id
         JOIN pharmacy_counter_sale_lines line
           ON line.tenant_id = sale.tenant_id
          AND line.counter_sale_id = sale.id
         JOIN pharmacy_counter_sale_allocations allocation
           ON allocation.tenant_id = line.tenant_id
          AND allocation.counter_sale_line_id = line.id
         JOIN pharmacy_stock_movements issue
           ON issue.tenant_id = allocation.tenant_id
          AND issue.id = allocation.movement_id
         JOIN pharmacy_stock_movements returned
           ON returned.tenant_id = allocation.tenant_id
          AND returned.id = allocation.return_movement_id
        WHERE request.tenant_id = $1::uuid
          AND request.command_key = $2::text`,
      TENANT_ID,
      COUNTER_SALE_VOID_COMMAND,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      request_status: 'COMPLETED',
      task_stage: 'completed',
      disposition: 'NEVER_HANDED_OVER',
      reconciliation_source: 'manual',
      sale_status: 'VOIDED',
      payment_mode: 'CASH',
      approval_status: 'PAID',
      payout_rail: 'manual',
      refund_reference: 'VH-SEED-MED03-CASH-REFUND-001',
      requester_role: 'PHARMACY_INCHARGE',
      approver_role: 'ADMIN',
      payer_role: 'CASHIER',
      reconciler_role: 'PHARMACY_INCHARGE',
      task_status: 'completed',
      assigned_to_role: 'PHARMACY_INCHARGE',
      sla_completion_semantics: 'domain_evidence',
      related_resource_type: 'pharmacy_counter_sale_void_requests',
      drawer_status: 'reviewed',
      return_reference_type: 'pharmacy_counter_sale_void',
      paid_evidence: true,
    });
    expect(asNumber(row.total_amount)).toBe(10);
    expect(row.void_refund_id).toBe(row.refund_id);
    expect(row.voided_by).toBe(row.requested_by);
    expect(row.reconciled_by).toBe(row.requested_by);
    expect(row.paid_by).not.toBe(row.requested_by);
    expect(row.paid_by).not.toBe(row.approved_by);
    expect(row.related_resource_id).toBe(row.request_id);
    expect(row.source_table).toBe(row.related_resource_type);
    expect(row.source_id).toBe(row.request_id);
    expect(new Date(row.task_completed_at).toISOString())
      .toBe(new Date(row.sla_completed_at).toISOString());
    expect(row.task_metadata).toMatchObject({
      task_contract: 'counter_sale_void_refund_v1',
      evidence_kind: 'counter_sale_void_completed',
      counter_sale_void_request_id: row.request_id,
      counter_sale_id: row.sale_id,
      refund_id: row.refund_id,
      invoice_id: row.invoice_id,
      task_stage: 'completed',
      completion_via: 'domain_evidence',
      completion_evidence: {
        kind: 'counter_sale_void_completed',
        resource_type: 'pharmacy_counter_sale_void_requests',
        resource_id: row.request_id,
      },
    });
    expect(row.sla_metadata).toMatchObject({
      completed_via: 'domain_evidence',
      completed_by_task: row.task_id,
      completed_by: row.reconciled_by,
      completion_evidence: {
        kind: 'counter_sale_void_completed',
        resource_type: 'pharmacy_counter_sale_void_requests',
        resource_id: row.request_id,
      },
    });
    expect(['completed', 'breached', 'escalated']).toContain(row.sla_status);
    expect(asNumber(row.opening_float)).toBe(500);
    expect(asNumber(row.counted_total)).toBe(500);
    expect(asNumber(row.cash_inflow_total)).toBe(10);
    expect(asNumber(row.cash_refund_total)).toBe(10);
    expect(asNumber(row.system_total)).toBe(0);
    expect(asNumber(row.variance)).toBe(0);
    expect(row.reviewed_by).toBe(row.paid_by);
    expect(asNumber(row.issue_delta)).toBe(-1);
    expect(asNumber(row.return_delta)).toBe(1);
    expect(row.return_movement_id).not.toBeNull();
    expect(row.issue_batch_id).toBe(row.return_batch_id);
    expect(row.return_reference_id).toBe(row.sale_id);
  });
});
