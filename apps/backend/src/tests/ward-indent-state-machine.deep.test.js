import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import {
  approveWardIndent,
  approveWardIndentSubstitution,
  closeWardIndent,
  createWardIndent,
  getWardIndent,
  issueWardIndent,
  listWardIndentPage,
  markWardIndentShortSupply,
  proposeWardIndentSubstitution,
  receiveWardIndent,
  reconcileWardIndent,
  recordWardIndentControlledHandoff,
  reportWardIndentDiscrepancy,
  requestWardIndentReturn,
  reserveWardIndent,
} from '../services/ipd/ipdSupportService.js';
import {
  dispenseControlled,
  recordMovement,
} from '../services/pharmacy/inventoryV2Service.js';
import admissionService from '../services/emr/admissionService.js';
import { cancelOrder, verifyOrder } from '../services/emr/orderEntryService.js';
import { bindMedicationOrderCatalogAuthority } from '../services/ipd/wardIndentWorkflowService.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-0000a7410001';
const REQUESTER = 'a7410000-0000-4000-8000-000000000001';
const PHARMACIST = 'a7410000-0000-4000-8000-000000000002';
const RECEIVER = 'a7410000-0000-4000-8000-000000000003';
const DOCTOR = 'a7410000-0000-4000-8000-000000000004';
const PATIENT = 'a7410000-0000-4000-8000-000000000005';
const OTHER_PATIENT = 'a7410000-0000-4000-8000-000000000006';
const RUN = `${process.pid}-${Date.now()}`;

function sqlState(error) {
  return error?.meta?.driverAdapterError?.cause?.code
    || error?.meta?.driverAdapterError?.cause?.originalCode
    || error?.meta?.code
    || error?.code
    || null;
}

function databaseMessage(error) {
  return [
    error?.message,
    error?.meta?.message,
    error?.meta?.driverAdapterError?.cause?.message,
    error?.meta?.driverAdapterError?.cause?.originalMessage,
  ].filter(Boolean).join(' ');
}

describeIfDb('MED-01 authoritative ward-indent state machine', () => {
  let wardId;
  let medicationAdmissionId;
  let medicationEncounterId;
  let plain;
  let shortSupply;
  let substitute;
  let controlled;
  let medicationShortSupply;
  let medicationSubstitute;
  let medicationIncompatibleSubstitute;
  let unclassified;
  let medicationCompositionId;
  let unrelatedCompositionId;

  async function cleanup() {
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
        'mar_supply_reconciliation_links',
        'mar_supply_consumptions',
        'medication_administrations',
        'ward_indent_inventory_receipt_events',
        'ward_indent_inventory_movement_links',
        'ward_indent_inventory_allocations',
        'ward_indent_events',
        'clinical_timeline_events',
        'clinical_audit_events',
        'billing_invoice_items',
        'billing_invoices',
        'discharge_consults',
        'clinical_notes',
        'pharmacy_schedule_register',
        'pharmacy_stock_movements',
        'pharmacy_inventory_batches',
        'pharmacy_inventory_items',
        'ward_indent_items',
        'ward_indents',
        'admissions',
        'clinical_orders',
        'pharmacy_catalog',
        'beds',
        'wards',
        'users',
      ]) {
        await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, TENANT);
      }
      await tx.$executeRawUnsafe(
        `DELETE FROM drug_compositions WHERE composition_key IN ($1::text, $2::text)`,
        `med01-paracetamol-${RUN}`,
        `med01-ceftriaxone-${RUN}`,
      );
    });
  }

  async function seedCatalog(name, stock, {
    scheduleClass = null,
    withBatch = true,
    medication = false,
    genericName = null,
    strength = null,
    form = null,
    route = null,
    compositionId = null,
  } = {}) {
    const effectiveCompositionId = medication
      ? (compositionId || medicationCompositionId)
      : null;
    const effectiveStrength = medication ? (strength || '1 each') : strength;
    const effectiveForm = medication ? (form || 'tablet') : form;
    const effectiveRoute = medication ? (route || 'oral') : route;
    const catalog = (await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, category, requires_prescription, is_active,
          generic_name, composition_id, composition_source, composition_confidence,
          strength, strength_key, strength_components,
          form, form_key, release_key, route,
          stock_quantity, unit_price, price, updated_at)
       VALUES ($1::uuid, $2, $4::text, $5::boolean, TRUE,
               $6::text, $7::int, 'curated', 'high',
               $8::text, lower(regexp_replace($8::text, '\\s+', '', 'g')),
               jsonb_build_array(jsonb_build_object(
                 'ingredient', lower(COALESCE($6::text, $2::text)),
                 'value', regexp_replace($8::text, '[^0-9.]', '', 'g'),
                 'unit', COALESCE(NULLIF(regexp_replace($8::text, '[0-9.\\s]', '', 'g'), ''), 'each')
               )),
               $9::text, lower($9::text), 'ir', $10::text,
               $3, 12.50, 12.50, NOW())
       RETURNING id, name, generic_name, composition_id, composition_source,
                 composition_confidence, strength, strength_key, strength_components,
                 form, form_key, release_key, route, is_active`,
      TENANT,
      name,
      stock,
      medication ? 'medication' : 'ward_supply',
      medication,
      genericName,
      effectiveCompositionId,
      effectiveStrength,
      effectiveForm,
      effectiveRoute,
    ))[0];
    const inventory = (await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, catalog_id, unit_label,
          schedule_class, is_narcotic)
       VALUES ($1::uuid, $2, $3, $4, 'each', $5, FALSE)
       RETURNING id`,
      TENANT,
      `MED01-${RUN}-${catalog.id}`,
      name,
      Number(catalog.id),
      scheduleClass,
    ))[0];
    let batchId = null;
    if (withBatch) {
      batchId = Number((await prisma.$queryRawUnsafe(
        `INSERT INTO pharmacy_inventory_batches
           (tenant_id, inventory_item_id, batch_number, expiry_date,
            received_quantity, remaining_quantity, status)
         VALUES ($1::uuid, $2, $3, (NOW() + INTERVAL '365 days')::date,
                 $4, $4, 'in_stock')
         RETURNING id`,
        TENANT,
        Number(inventory.id),
        `MED01-BATCH-${RUN}`,
        stock,
      ))[0].id);
    }
    return {
      catalogId: Number(catalog.id),
      inventoryItemId: Number(inventory.id),
      batchId,
      name,
      ...catalog,
    };
  }

  async function seedMedicationAdmission(patientUid, key) {
    const encounterId = randomUUID();
    const wardName = `MED-01 Ward ${RUN}`;
    const bedNumber = `MED01-${key}-${RUN}`.slice(0, 50);
    const bedId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO beds
         (tenant_id, ward_id, ward_name, bed_number, status, patient_uid,
          created_at, updated_at)
       VALUES ($1::uuid, $2::int, $3::text, $4::text, 'occupied', $5::uuid,
               NOW(), NOW())
       RETURNING id`,
      TENANT,
      wardId,
      wardName,
      bedNumber,
      patientUid,
    ))[0].id);
    const admissionId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, encounter_id, bed_id, bed_number, ward,
          status, admitted_at, created_by, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::int, $5::text, $6::text,
               'admitted', NOW(), $7::uuid, NOW())
       RETURNING id`,
      TENANT,
      patientUid,
      encounterId,
      bedId,
      bedNumber,
      wardName,
      REQUESTER,
    ))[0].id);
    return { admissionId, encounterId };
  }

  async function createControlledMedicationIndent({
    patientUid = PATIENT,
    admissionId = medicationAdmissionId,
    encounterId = medicationEncounterId,
    catalog = controlled,
    quantity = 1,
    key,
  }) {
    const details = bindMedicationOrderCatalogAuthority({
      medication_name: catalog.name,
      catalog_id: catalog.catalogId,
      dose: catalog.strength,
      route: catalog.route,
      quantity_requested: quantity,
      unit: 'each',
    }, { ...catalog, id: catalog.catalogId }, { phase: 'create' });
    const order = (await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_orders
         (tenant_id, order_number, patient_uid, encounter_id, order_type,
          status, ordered_by, details, updated_at)
       VALUES ($1::uuid, $2::text, $3::uuid, $4::uuid, 'medication',
               'ordered', $5::uuid,
               $6::jsonb, NOW())
       RETURNING id`,
      TENANT,
      `MED-01-${key}-${RUN}`.slice(0, 80),
      patientUid,
      encounterId,
      DOCTOR,
      JSON.stringify(details),
    ))[0];
    await verifyOrder(Number(order.id), PHARMACIST, {
      tenantId: TENANT,
      actorRole: 'PHARMACY_INCHARGE',
      idempotencyKey: `med01-verify-${key}-${RUN}`,
    });
    return createWardIndent({
      wardId,
      admissionId,
      encounterId,
      patientUid,
      indentType: 'consumables',
      items: [{
        pharmacy_catalog_id: catalog.catalogId,
        clinical_order_id: Number(order.id),
        item_name: catalog.name,
        quantity_requested: quantity,
      }],
      requestedBy: REQUESTER,
      commandKey: `med01-create-${key}-${RUN}`,
      tenantId: TENANT,
    });
  }

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid, $2, 'MED-01 Test', 'IN', 'active', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      TENANT,
      `med01-${RUN}`,
    );
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $6::uuid, 'Request Nurse', 'IP_STAFF_NURSE', TRUE, 'active', NOW()),
         ($2::uuid, $6::uuid, 'Issuing Pharmacist', 'PHARMACY_INCHARGE', TRUE, 'active', NOW()),
         ($3::uuid, $6::uuid, 'Receiving Nurse', 'NURSING_INCHARGE', TRUE, 'active', NOW()),
         ($4::uuid, $6::uuid, 'Prescriber', 'DOCTOR', TRUE, 'active', NOW()),
         ($5::uuid, $6::uuid, 'Ward Patient', 'PATIENT', TRUE, 'active', NOW())`,
      REQUESTER,
      PHARMACIST,
      RECEIVER,
      DOCTOR,
      PATIENT,
      TENANT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, name, role, is_active, status, updated_at)
       VALUES ($1::uuid, $2::uuid, 'Other Ward Patient', 'PATIENT', TRUE, 'active', NOW())`,
      OTHER_PATIENT,
      TENANT,
    );
    wardId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO wards (tenant_id, name, total_beds, created_at, updated_at)
       VALUES ($1::uuid, $2, 10, NOW(), NOW()) RETURNING id`,
      TENANT,
      `MED-01 Ward ${RUN}`,
    ))[0].id);
    medicationCompositionId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO drug_compositions
         (composition_key, display_label, active_ingredients, source)
       VALUES ($1::text, 'Paracetamol', ARRAY['paracetamol'], 'curated')
       RETURNING id`,
      `med01-paracetamol-${RUN}`,
    ))[0].id);
    unrelatedCompositionId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO drug_compositions
         (composition_key, display_label, active_ingredients, source)
       VALUES ($1::text, 'Ceftriaxone', ARRAY['ceftriaxone'], 'curated')
       RETURNING id`,
      `med01-ceftriaxone-${RUN}`,
    ))[0].id);
    ({
      admissionId: medicationAdmissionId,
      encounterId: medicationEncounterId,
    } = await seedMedicationAdmission(PATIENT, 'base'));
    plain = await seedCatalog(`MED-01 Plain ${RUN}`, 100);
    shortSupply = await seedCatalog(`MED-01 Short ${RUN}`, 1);
    substitute = await seedCatalog(`MED-01 Substitute ${RUN}`, 100);
    controlled = await seedCatalog(`MED-01 H1 ${RUN}`, 20, {
      scheduleClass: 'H1',
      withBatch: true,
      medication: true,
    });
    medicationShortSupply = await seedCatalog(`MED-01 Medication Short ${RUN}`, 1, {
      scheduleClass: 'OTC',
      medication: true,
      genericName: 'Paracetamol',
      strength: '500 mg',
      form: 'tablet',
      route: 'oral',
    });
    medicationSubstitute = await seedCatalog(`MED-01 Medication Substitute ${RUN}`, 20, {
      scheduleClass: 'OTC',
      medication: true,
      genericName: 'Paracetamol',
      strength: '500 mg',
      form: 'tablet',
      route: 'oral',
    });
    medicationIncompatibleSubstitute = await seedCatalog(
      `MED-01 Unrelated Medication ${RUN}`,
      20,
      {
        scheduleClass: 'OTC',
        medication: true,
        genericName: 'Ceftriaxone',
        strength: '1 g',
        form: 'injection',
        route: 'intravenous',
        compositionId: unrelatedCompositionId,
      },
    );
    const unclassifiedRow = (await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, category, requires_prescription, is_active,
          stock_quantity, unit_price, price, updated_at)
       VALUES ($1::uuid, $2, 'ward_supply', FALSE, TRUE, 10, 5, 5, NOW())
       RETURNING id, name`,
      TENANT,
      `MED-01 Unclassified ${RUN}`,
    ))[0];
    unclassified = {
      catalogId: Number(unclassifiedRow.id),
      name: unclassifiedRow.name,
    };
  });

  afterAll(async () => {
    await cleanup();
    if (typeof prisma.$disconnect === 'function') await prisma.$disconnect();
  });

  test('serializes reservation, replays commands, reconciles partial receipt, and closes', async () => {
    const createInput = {
      wardId,
      patientUid: PATIENT,
      indentType: 'consumables',
      items: [{
        pharmacy_catalog_id: plain.catalogId,
        item_name: 'Caller-controlled name',
        quantity_requested: 5,
        unit_price: 9999,
      }],
      requestedBy: REQUESTER,
      commandKey: `normal-create-${RUN}`,
      tenantId: TENANT,
    };
    const indent = await createWardIndent(createInput);
    const replayedCreate = await createWardIndent(createInput);
    expect(replayedCreate.id).toBe(indent.id);
    expect(indent.items[0]).toMatchObject({ item_name: plain.name });
    expect(Number(indent.items[0].unit_price)).toBe(12.5);

    const reservationKeys = [`normal-reserve-a-${RUN}`, `normal-reserve-b-${RUN}`];
    const attempts = await Promise.allSettled(reservationKeys.map((commandKey) => reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACIST,
      expectedVersion: 1,
      commandKey,
      tenantId: TENANT,
    })));
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const winningIndex = attempts.findIndex((result) => result.status === 'fulfilled');
    const reserved = attempts[winningIndex].value;
    expect(reserved).toMatchObject({ status: 'reserved', state_version: 2 });

    const replayedReserve = await reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACIST,
      expectedVersion: 1,
      commandKey: reservationKeys[winningIndex],
      tenantId: TENANT,
    });
    expect(replayedReserve).toMatchObject({ status: 'reserved', state_version: 2 });
    expect(replayedReserve.workflow.events).toHaveLength(2);

    const approved = await approveWardIndent({
      indentId: indent.id,
      approvedBy: PHARMACIST,
      expectedVersion: 2,
      commandKey: `normal-approve-${RUN}`,
      tenantId: TENANT,
    });
    expect(approved.status).toBe('approved');
    const issued = await issueWardIndent({
      indentId: indent.id,
      issuedBy: PHARMACIST,
      expectedVersion: 3,
      commandKey: `normal-issue-${RUN}`,
      tenantId: TENANT,
    });
    expect(issued.status).toBe('issued');
    await expect(receiveWardIndent({
      indentId: indent.id,
      receivedBy: PHARMACIST,
      expectedVersion: 4,
      commandKey: `normal-self-receive-${RUN}`,
      tenantId: TENANT,
    })).rejects.toMatchObject({ code: 'WARD_INDENT_RECEIPT_ACTOR_MUST_DIFFER' });

    const partial = await receiveWardIndent({
      indentId: indent.id,
      receivedBy: RECEIVER,
      itemQuantitiesReceived: [{ item_id: indent.items[0].id, quantity_received: 2 }],
      expectedVersion: 4,
      commandKey: `normal-partial-${RUN}`,
      tenantId: TENANT,
    });
    expect(partial.status).toBe('partially_received');
    const receiptEvidence = await prisma.$queryRawUnsafe(
      `SELECT event.quantity_delta, event.ward_indent_state_version, event.received_by,
              allocation.received_quantity
         FROM ward_indent_inventory_receipt_events event
         JOIN ward_indent_inventory_allocations allocation
           ON allocation.tenant_id = event.tenant_id
          AND allocation.id = event.inventory_allocation_id
        WHERE event.tenant_id = $1::uuid
          AND event.ward_indent_id = $2::int
        ORDER BY event.id`,
      TENANT,
      Number(indent.id),
    );
    expect(receiptEvidence).toHaveLength(1);
    expect(receiptEvidence[0]).toMatchObject({
      ward_indent_state_version: 5,
      received_by: RECEIVER,
    });
    expect(Number(receiptEvidence[0].quantity_delta)).toBe(2);
    expect(Number(receiptEvidence[0].received_quantity)).toBe(2);
    const discrepancy = await reportWardIndentDiscrepancy({
      indentId: indent.id,
      reportedBy: RECEIVER,
      reason: 'Three units missing at ward handoff',
      expectedVersion: 5,
      commandKey: `normal-discrepancy-${RUN}`,
      tenantId: TENANT,
    });
    expect(discrepancy.status).toBe('reconciliation_required');
    const reconciled = await reconcileWardIndent({
      indentId: indent.id,
      reconciledBy: RECEIVER,
      reason: 'Transit count variance reviewed',
      itemReconciliations: [{
        item_id: indent.items[0].id,
        quantity_variance_resolved: 3,
        disposition: 'transit_shortage',
        note: 'Pharmacy and ward count sheet signed',
      }],
      expectedVersion: 6,
      commandKey: `normal-reconcile-${RUN}`,
      tenantId: TENANT,
    });
    expect(reconciled.status).toBe('reconciled');
    const closed = await closeWardIndent({
      indentId: indent.id,
      closedBy: RECEIVER,
      reason: 'Variance accounted for',
      expectedVersion: 7,
      commandKey: `normal-close-${RUN}`,
      tenantId: TENANT,
    });
    expect(closed).toMatchObject({
      status: 'closed',
      state_version: 8,
      closure_outcome: 'variance_reconciled',
      active_sla_source_id: null,
    });
    expect(closed.workflow.events).toHaveLength(8);
    expect(Number(closed.items[0].quantity_received)).toBe(2);
    expect(Number(closed.items[0].quantity_variance_resolved)).toBe(3);
    const canonical = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND source_table = 'ward_indents'
          AND source_id = $2`,
      TENANT,
      String(indent.id),
    );
    expect(canonical[0].count).toBe(8);
  }, 60_000);

  test('serializes different indents competing for the same exact batch', async () => {
    const competing = await seedCatalog(`MED-03 Reservation Race ${RUN}`, 5);
    const indents = await Promise.all(['a', 'b'].map((suffix) => createWardIndent({
      wardId,
      patientUid: PATIENT,
      indentType: 'consumables',
      items: [{
        pharmacy_catalog_id: competing.catalogId,
        item_name: competing.name,
        quantity_requested: 4,
      }],
      requestedBy: REQUESTER,
      commandKey: `reservation-race-create-${suffix}-${RUN}`,
      tenantId: TENANT,
    })));

    const attempts = await Promise.allSettled(indents.map((indent, index) => reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACIST,
      expectedVersion: 1,
      commandKey: `reservation-race-reserve-${index}-${RUN}`,
      tenantId: TENANT,
    })));
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({
      code: 'WARD_INDENT_INSUFFICIENT_EXACT_BATCH_STOCK',
    });

    const reservations = await prisma.$queryRawUnsafe(
      `SELECT COALESCE(SUM(reserved_quantity - issued_quantity), 0)::numeric AS total
         FROM ward_indent_inventory_allocations
        WHERE tenant_id = $1::uuid
          AND inventory_batch_id = $2::int
          AND status = ANY($3::text[])`,
      TENANT,
      competing.batchId,
      ['reserved', 'partially_issued', 'issued'],
    );
    expect(Number(reservations[0].total)).toBe(4);
    expect(Number(reservations[0].total)).toBeLessThanOrEqual(5);
  }, 60_000);

  test('rejects a legacy unlinked pharmacy indent before inventory and billing issue', async () => {
    const indent = await createWardIndent({
      wardId,
      patientUid: PATIENT,
      indentType: 'consumables',
      items: [{
        pharmacy_catalog_id: plain.catalogId,
        item_name: plain.name,
        quantity_requested: 1,
      }],
      requestedBy: REQUESTER,
      commandKey: `legacy-unlinked-create-${RUN}`,
      tenantId: TENANT,
    });
    const reserved = await reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACIST,
      expectedVersion: indent.state_version,
      commandKey: `legacy-unlinked-reserve-${RUN}`,
      tenantId: TENANT,
    });
    const approved = await approveWardIndent({
      indentId: indent.id,
      approvedBy: PHARMACIST,
      expectedVersion: reserved.state_version,
      commandKey: `legacy-unlinked-approve-${RUN}`,
      tenantId: TENANT,
    });
    await prisma.$executeRawUnsafe(
      `UPDATE ward_indents
          SET indent_type = 'pharmacy', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT,
      Number(indent.id),
    );
    const stockBefore = Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT,
      plain.batchId,
    ))[0].remaining_quantity);

    await expect(issueWardIndent({
      indentId: indent.id,
      issuedBy: PHARMACIST,
      expectedVersion: approved.state_version,
      commandKey: `legacy-unlinked-issue-${RUN}`,
      tenantId: TENANT,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'WARD_INDENT_CLINICAL_ORDER_REQUIRED',
    });
    expect(Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT,
      plain.batchId,
    ))[0].remaining_quantity)).toBe(stockBefore);
    expect(await prisma.$queryRawUnsafe(
      `SELECT id
         FROM ward_indent_financial_events
        WHERE tenant_id = $1::uuid AND ward_indent_id = $2::integer`,
      TENANT,
      Number(indent.id),
    )).toHaveLength(0);
  }, 60_000);

  test('reuses one draft invoice when different indents issue concurrently', async () => {
    const admission = { id: medicationAdmissionId };
    const specialtyDrafts = await prisma.$queryRawUnsafe(
      `INSERT INTO billing_invoices
         (tenant_id, patient_uid, admission_id, invoice_type, status,
          department, created_by, notes)
       VALUES
         ($1::uuid, $2::uuid, $3::int, 'OP', 'DRAFT', NULL, $4::uuid,
          'Unrelated outpatient draft'),
         ($1::uuid, $2::uuid, $3::int, 'IP', 'DRAFT', 'Cath Lab', $4::uuid,
          'Department-owned Cath Lab draft')
       RETURNING id, invoice_type, department`,
      TENANT,
      PATIENT,
      Number(admission.id),
      REQUESTER,
    );
    const catalogs = await Promise.all([
      seedCatalog(`MED-03 Invoice Race A ${RUN}`, 10),
      seedCatalog(`MED-03 Invoice Race B ${RUN}`, 10),
    ]);
    const indents = await Promise.all(catalogs.map((catalog, index) => createWardIndent({
      wardId,
      admissionId: Number(admission.id),
      patientUid: PATIENT,
      indentType: 'consumables',
      items: [{
        pharmacy_catalog_id: catalog.catalogId,
        item_name: catalog.name,
        quantity_requested: 2,
      }],
      requestedBy: REQUESTER,
      commandKey: `invoice-race-create-${index}-${RUN}`,
      tenantId: TENANT,
    })));
    await Promise.all(indents.map((indent, index) => reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACIST,
      expectedVersion: 1,
      commandKey: `invoice-race-reserve-${index}-${RUN}`,
      tenantId: TENANT,
    })));
    await Promise.all(indents.map((indent, index) => approveWardIndent({
      indentId: indent.id,
      approvedBy: PHARMACIST,
      expectedVersion: 2,
      commandKey: `invoice-race-approve-${index}-${RUN}`,
      tenantId: TENANT,
    })));

    const issued = await Promise.all(indents.map((indent, index) => issueWardIndent({
      indentId: indent.id,
      issuedBy: PHARMACIST,
      expectedVersion: 3,
      commandKey: `invoice-race-issue-${index}-${RUN}`,
      tenantId: TENANT,
    })));
    expect(issued.map((row) => row.status)).toEqual(['issued', 'issued']);

    const invoices = await prisma.$queryRawUnsafe(
      `SELECT invoice.id, COUNT(item.id)::int AS item_count
         FROM billing_invoices invoice
         JOIN billing_invoice_items item
           ON item.tenant_id = invoice.tenant_id
          AND item.invoice_id = invoice.id
        WHERE invoice.tenant_id = $1::uuid
          AND invoice.patient_uid = $2::uuid
          AND invoice.admission_id = $3::int
          AND invoice.status = 'DRAFT'
          AND item.source_ref_type = 'ward_indent_item'
          AND item.source_ref_id = ANY($4::bigint[])
        GROUP BY invoice.id
        ORDER BY invoice.id`,
      TENANT,
      PATIENT,
      Number(admission.id),
      indents.map((indent) => BigInt(indent.items[0].id)),
    );
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ item_count: 2 });
    const allDrafts = await prisma.$queryRawUnsafe(
      `SELECT invoice.id, invoice.invoice_type, invoice.department,
              COUNT(item.id)::int AS item_count
         FROM billing_invoices invoice
         LEFT JOIN billing_invoice_items item
           ON item.tenant_id = invoice.tenant_id
          AND item.invoice_id = invoice.id
        WHERE invoice.tenant_id = $1::uuid
          AND invoice.patient_uid = $2::uuid
          AND invoice.admission_id = $3::int
          AND invoice.status = 'DRAFT'
        GROUP BY invoice.id, invoice.invoice_type, invoice.department
        ORDER BY invoice.id`,
      TENANT,
      PATIENT,
      Number(admission.id),
    );
    expect(allDrafts).toHaveLength(3);
    const seededIds = new Set(specialtyDrafts.map((row) => Number(row.id)));
    expect(allDrafts.filter((row) => seededIds.has(Number(row.id))))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ invoice_type: 'OP', department: null, item_count: 0 }),
        expect.objectContaining({ invoice_type: 'IP', department: 'Cath Lab', item_count: 0 }),
      ]));
    expect(allDrafts.filter((row) => !seededIds.has(Number(row.id))))
      .toEqual([
        expect.objectContaining({ invoice_type: 'IP', department: null, item_count: 2 }),
      ]);
  }, 60_000);

  test('fails closed before reservation for unclassified catalog and free-text lines', async () => {
    const unclassifiedIndent = await createWardIndent({
      wardId,
      indentType: 'consumables',
      items: [{
        pharmacy_catalog_id: unclassified.catalogId,
        item_name: unclassified.name,
        quantity_requested: 2,
      }],
      requestedBy: REQUESTER,
      commandKey: `unclassified-create-${RUN}`,
      tenantId: TENANT,
    });
    await expect(reserveWardIndent({
      indentId: unclassifiedIndent.id,
      reservedBy: PHARMACIST,
      expectedVersion: 1,
      commandKey: `unclassified-reserve-${RUN}`,
      tenantId: TENANT,
    })).rejects.toMatchObject({ code: 'WARD_INDENT_INVENTORY_MAPPING_REQUIRED' });

    const freeTextIndent = await createWardIndent({
      wardId,
      indentType: 'consumables',
      items: [{ item_name: 'Uncatalogued ward supply', quantity_requested: 1 }],
      requestedBy: REQUESTER,
      commandKey: `free-text-create-${RUN}`,
      tenantId: TENANT,
    });
    await expect(reserveWardIndent({
      indentId: freeTextIndent.id,
      reservedBy: PHARMACIST,
      expectedVersion: 1,
      commandKey: `free-text-reserve-${RUN}`,
      tenantId: TENANT,
    })).rejects.toMatchObject({
      code: 'WARD_INDENT_CATALOG_LINK_REQUIRED',
    });

    const targetIndentIds = [unclassifiedIndent.id, freeTextIndent.id];
    const stateRows = await prisma.$queryRawUnsafe(
      `SELECT id, status
         FROM ward_indents
        WHERE id = ANY($1::int[])
        ORDER BY id`,
      targetIndentIds,
    );
    expect(stateRows.map((row) => row.status)).toEqual(['requested', 'requested']);
    const stock = await prisma.$queryRawUnsafe(
      `SELECT stock_quantity FROM pharmacy_catalog WHERE id = $1::int`,
      unclassified.catalogId,
    );
    expect(Number(stock[0].stock_quantity)).toBe(10);
  });

  test('rejects a typed clinical-order link owned by another patient', async () => {
    const order = (await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_orders
         (tenant_id, order_number, patient_uid, encounter_id, order_type, status,
          details, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, 'medication', 'ordered',
               jsonb_build_object(
                 'catalog_id', $5::int,
                 'quantity_requested', 1,
                 'unit', 'each'
               ), NOW())
       RETURNING id`,
      TENANT,
      `MED-01-CROSS-PATIENT-${RUN}`,
      OTHER_PATIENT,
      medicationEncounterId,
      plain.catalogId,
    ))[0];
    await expect(createWardIndent({
      wardId,
      admissionId: medicationAdmissionId,
      encounterId: medicationEncounterId,
      patientUid: PATIENT,
      indentType: 'pharmacy',
      items: [{
        pharmacy_catalog_id: plain.catalogId,
        clinical_order_id: Number(order.id),
        item_name: plain.name,
        quantity_requested: 1,
      }],
      requestedBy: REQUESTER,
      commandKey: `cross-patient-create-${RUN}`,
      tenantId: TENANT,
    })).rejects.toMatchObject({
      code: 'WARD_INDENT_CLINICAL_ORDER_PATIENT_MISMATCH',
    });
  });

  test('requires active admission context and a non-null exact order encounter', async () => {
    async function insertOrder(orderNumber, encounterId) {
      return (await prisma.$queryRawUnsafe(
        `INSERT INTO clinical_orders
           (tenant_id, order_number, patient_uid, encounter_id, order_type, status,
            details, updated_at)
         VALUES ($1::uuid, $2::text, $3::uuid, $4::uuid, 'medication', 'ordered',
                 jsonb_build_object(
                   'catalog_id', $5::int,
                   'quantity_requested', 1,
                   'unit', 'each'
                 ), NOW())
         RETURNING id`,
        TENANT,
        orderNumber,
        PATIENT,
        encounterId,
        plain.catalogId,
      ))[0];
    }
    const activeOrder = await insertOrder(`MED-01-NO-ADMISSION-${RUN}`, medicationEncounterId);
    await expect(createWardIndent({
      wardId,
      patientUid: PATIENT,
      indentType: 'consumables',
      items: [{
        pharmacy_catalog_id: plain.catalogId,
        clinical_order_id: Number(activeOrder.id),
        quantity_requested: 1,
      }],
      requestedBy: REQUESTER,
      commandKey: `bound-admission-required-${RUN}`,
      tenantId: TENANT,
    })).rejects.toMatchObject({
      code: 'WARD_INDENT_ADMISSION_REQUIRED',
      statusCode: 400,
    });

    const nullEncounterOrder = await insertOrder(`MED-01-NULL-ENCOUNTER-${RUN}`, null);
    await expect(createWardIndent({
      wardId,
      admissionId: medicationAdmissionId,
      encounterId: medicationEncounterId,
      patientUid: PATIENT,
      indentType: 'consumables',
      items: [{
        pharmacy_catalog_id: plain.catalogId,
        clinical_order_id: Number(nullEncounterOrder.id),
        quantity_requested: 1,
      }],
      requestedBy: REQUESTER,
      commandKey: `bound-null-encounter-${RUN}`,
      tenantId: TENANT,
    })).rejects.toMatchObject({
      code: 'WARD_INDENT_CLINICAL_ORDER_ENCOUNTER_MISMATCH',
      statusCode: 400,
    });
  });

  test('server-binds linked manual indents to the ordered catalog, quantity, and unit', async () => {
    const order = (await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_orders
         (tenant_id, order_number, patient_uid, encounter_id, order_type, status,
          details, updated_at)
       VALUES ($1::uuid, $2::text, $3::uuid, $4::uuid, 'medication', 'ordered',
               jsonb_build_object(
                 'medication_name', $5::text,
                 'catalog_id', $6::int,
                 'quantity_requested', 2,
                 'unit', 'tablet'
               ), NOW())
       RETURNING id`,
      TENANT,
      `MED-01-BOUND-${RUN}`,
      PATIENT,
      medicationEncounterId,
      medicationSubstitute.name,
      medicationSubstitute.catalogId,
    ))[0];
    const base = {
      wardId,
      admissionId: medicationAdmissionId,
      encounterId: medicationEncounterId,
      patientUid: PATIENT,
      indentType: 'pharmacy',
      requestedBy: REQUESTER,
      tenantId: TENANT,
    };
    await expect(createWardIndent({
      ...base,
      items: [{
        pharmacy_catalog_id: shortSupply.catalogId,
        clinical_order_id: Number(order.id),
        quantity_requested: 2,
      }],
      commandKey: `bound-catalog-mismatch-${RUN}`,
    })).rejects.toMatchObject({
      code: 'WARD_INDENT_CLINICAL_ORDER_CATALOG_MISMATCH',
      statusCode: 409,
    });
    await expect(createWardIndent({
      ...base,
      items: [{
        clinical_order_id: Number(order.id),
        item_name: medicationSubstitute.name,
        quantity_requested: 3,
      }],
      commandKey: `bound-quantity-mismatch-${RUN}`,
    })).rejects.toMatchObject({
      code: 'WARD_INDENT_CLINICAL_ORDER_QUANTITY_MISMATCH',
      statusCode: 409,
    });
    await expect(createWardIndent({
      ...base,
      items: [{
        clinical_order_id: Number(order.id),
        item_name: medicationSubstitute.name,
        quantity_requested: 2,
        unit: 'vial',
      }],
      commandKey: `bound-unit-mismatch-${RUN}`,
    })).rejects.toMatchObject({
      code: 'WARD_INDENT_CLINICAL_ORDER_UNIT_MISMATCH',
      statusCode: 409,
    });

    const indent = await createWardIndent({
      ...base,
      items: [{
        clinical_order_id: Number(order.id),
        item_name: 'Caller-projected drug-chart name',
        quantity_requested: 2,
      }],
      commandKey: `bound-derived-${RUN}`,
    });
    expect(indent.items[0]).toMatchObject({
      pharmacy_catalog_id: medicationSubstitute.catalogId,
      quantity_requested: 2,
      unit: 'tablet',
    });
  });

  test('fails closed when a linked order lacks any canonical supply-binding field', async () => {
    const order = (await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_orders
         (tenant_id, order_number, patient_uid, encounter_id, order_type, status,
          details, updated_at)
       VALUES ($1::uuid, $2::text, $3::uuid, $4::uuid, 'medication', 'ordered',
               jsonb_build_object('medication_name', $5::text), NOW())
       RETURNING id`,
      TENANT,
      `MED-01-INCOMPLETE-BOUND-${RUN}`,
      PATIENT,
      medicationEncounterId,
      plain.name,
    ))[0];
    const create = (commandKey) => createWardIndent({
      wardId,
      admissionId: medicationAdmissionId,
      encounterId: medicationEncounterId,
      patientUid: PATIENT,
      indentType: 'pharmacy',
      requestedBy: REQUESTER,
      tenantId: TENANT,
      commandKey,
      items: [{
        pharmacy_catalog_id: plain.catalogId,
        clinical_order_id: Number(order.id),
        item_name: plain.name,
        quantity_requested: 2,
        unit: 'tablet',
      }],
    });

    await expect(create(`bound-missing-catalog-${RUN}`)).rejects.toMatchObject({
      code: 'WARD_INDENT_CLINICAL_ORDER_CATALOG_REQUIRED',
      statusCode: 409,
    });
    await prisma.$executeRawUnsafe(
      `UPDATE clinical_orders
          SET details = details || jsonb_build_object('catalog_id', $1::int)
        WHERE tenant_id = $2::uuid AND id = $3::int`,
      plain.catalogId,
      TENANT,
      Number(order.id),
    );
    await expect(create(`bound-missing-quantity-${RUN}`)).rejects.toMatchObject({
      code: 'WARD_INDENT_CLINICAL_ORDER_QUANTITY_REQUIRED',
      statusCode: 409,
    });
    await prisma.$executeRawUnsafe(
      `UPDATE clinical_orders
          SET details = details || '{"quantity_requested":2}'::jsonb
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      Number(order.id),
    );
    await expect(create(`bound-missing-unit-${RUN}`)).rejects.toMatchObject({
      code: 'WARD_INDENT_CLINICAL_ORDER_UNIT_REQUIRED',
      statusCode: 409,
    });
  });

  test('closes the short-supply substitution loop with prescriber evidence', async () => {
    const indent = await createWardIndent({
      wardId,
      patientUid: PATIENT,
      indentType: 'consumables',
      items: [{
        pharmacy_catalog_id: shortSupply.catalogId,
        item_name: shortSupply.name,
        quantity_requested: 5,
      }, {
        pharmacy_catalog_id: plain.catalogId,
        item_name: plain.name,
        quantity_requested: 2,
      }],
      requestedBy: REQUESTER,
      commandKey: `sub-create-${RUN}`,
      tenantId: TENANT,
    });
    const short = await markWardIndentShortSupply({
      indentId: indent.id,
      markedBy: PHARMACIST,
      reason: 'Only one pack remains',
      itemQuantitiesAvailable: [
        { item_id: indent.items[0].id, quantity_available: 1 },
        { item_id: indent.items[1].id, quantity_available: 2 },
      ],
      expectedVersion: 1,
      commandKey: `sub-short-${RUN}`,
      tenantId: TENANT,
    });
    expect(short.status).toBe('short_supply');
    await expect(proposeWardIndentSubstitution({
      indentId: indent.id,
      proposedBy: PHARMACIST,
      substitutions: [{
        item_id: indent.items[1].id,
        substitute_catalog_id: substitute.catalogId,
        quantity: 2,
        reason: 'Attempted change to a fully reserved line',
      }],
      expectedVersion: 2,
      commandKey: `sub-propose-full-${RUN}`,
      tenantId: TENANT,
    })).rejects.toMatchObject({ code: 'WARD_INDENT_SUBSTITUTION_NOT_SHORT_SUPPLIED' });
    const proposed = await proposeWardIndentSubstitution({
      indentId: indent.id,
      proposedBy: PHARMACIST,
      substitutions: [{
        item_id: indent.items[0].id,
        substitute_catalog_id: substitute.catalogId,
        quantity: 5,
        reason: 'Equivalent stocked formulation',
      }],
      expectedVersion: 2,
      commandKey: `sub-propose-${RUN}`,
      tenantId: TENANT,
    });
    expect(proposed.status).toBe('substitution_pending');
    const authorized = await approveWardIndentSubstitution({
      indentId: indent.id,
      decidedBy: DOCTOR,
      expectedVersion: 3,
      commandKey: `sub-authorize-${RUN}`,
      tenantId: TENANT,
    });
    expect(authorized.status).toBe('reserved');
    expect(authorized.items[0]).toMatchObject({
      pharmacy_catalog_id: substitute.catalogId,
      original_pharmacy_catalog_id: shortSupply.catalogId,
      substitution_status: 'approved',
    });
    expect(authorized.items[0].item_name).toBe(substitute.name);
  }, 60_000);

  test('rejects incompatible medication products and rechecks exact compatibility through issue', async () => {
    const indent = await createControlledMedicationIndent({
      catalog: medicationShortSupply,
      quantity: 5,
      key: 'medication-substitution',
    });
    const short = await markWardIndentShortSupply({
      indentId: indent.id,
      markedBy: PHARMACIST,
      reason: 'Original medication stock is insufficient',
      itemQuantitiesAvailable: [{ item_id: indent.items[0].id, quantity_available: 1 }],
      expectedVersion: 1,
      commandKey: `med-sub-short-${RUN}`,
      tenantId: TENANT,
    });
    await expect(proposeWardIndentSubstitution({
      indentId: indent.id,
      proposedBy: PHARMACIST,
      substitutions: [{
        item_id: indent.items[0].id,
        substitute_catalog_id: medicationIncompatibleSubstitute.catalogId,
        quantity: 5,
        reason: 'Unrelated medicine must never enter prescriber approval',
      }],
      expectedVersion: short.state_version,
      commandKey: `med-sub-incompatible-propose-${RUN}`,
      tenantId: TENANT,
    })).rejects.toMatchObject({
      code: 'WARD_INDENT_MEDICATION_SUBSTITUTION_INCOMPATIBLE',
      statusCode: 409,
      details: expect.objectContaining({
        phase: 'proposal',
        mismatched_dimensions: expect.arrayContaining([
          'composition_id',
          'strength',
          'dosage_form',
          'route',
        ]),
      }),
    });
    const proposed = await proposeWardIndentSubstitution({
      indentId: indent.id,
      proposedBy: PHARMACIST,
      substitutions: [{
        item_id: indent.items[0].id,
        substitute_catalog_id: medicationSubstitute.catalogId,
        quantity: 5,
        reason: 'Equivalent medication formulation confirmed for prescriber review',
      }],
      expectedVersion: short.state_version,
      commandKey: `med-sub-propose-${RUN}`,
      tenantId: TENANT,
    });
    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_catalog
          SET route = 'intravenous', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      medicationSubstitute.catalogId,
    );
    await expect(approveWardIndentSubstitution({
      indentId: indent.id,
      decidedBy: DOCTOR,
      expectedVersion: proposed.state_version,
      commandKey: `med-sub-incompatible-approve-${RUN}`,
      tenantId: TENANT,
    })).rejects.toMatchObject({
      code: 'WARD_INDENT_MEDICATION_SUBSTITUTION_INCOMPATIBLE',
      statusCode: 409,
      details: expect.objectContaining({
        phase: 'approval',
        mismatched_dimensions: expect.arrayContaining(['route']),
      }),
    });
    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_catalog
          SET route = 'oral', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      medicationSubstitute.catalogId,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE users SET is_active = FALSE, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      TENANT,
      DOCTOR,
    );
    await expect(approveWardIndentSubstitution({
      indentId: indent.id,
      decidedBy: DOCTOR,
      expectedVersion: proposed.state_version,
      commandKey: `med-sub-inactive-prescriber-${RUN}`,
      tenantId: TENANT,
    })).rejects.toMatchObject({
      code: 'WARD_INDENT_SUBSTITUTION_ACTIVE_PRESCRIBER_REQUIRED',
      statusCode: 403,
    });
    await prisma.$executeRawUnsafe(
      `UPDATE users SET is_active = TRUE, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      TENANT,
      DOCTOR,
    );
    const authorized = await approveWardIndentSubstitution({
      indentId: indent.id,
      decidedBy: DOCTOR,
      expectedVersion: proposed.state_version,
      commandKey: `med-sub-authorize-${RUN}`,
      tenantId: TENANT,
    });
    expect(authorized.items[0]).toMatchObject({
      pharmacy_catalog_id: medicationSubstitute.catalogId,
      original_pharmacy_catalog_id: medicationShortSupply.catalogId,
      clinical_order_id: indent.items[0].clinical_order_id,
      substitution_status: 'approved',
      substitution_decided_by: DOCTOR,
    });
    const approved = await approveWardIndent({
      indentId: indent.id,
      approvedBy: PHARMACIST,
      expectedVersion: authorized.state_version,
      commandKey: `med-sub-approve-${RUN}`,
      tenantId: TENANT,
    });
    const stockBeforeRejectedIssue = Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      medicationSubstitute.batchId,
    ))[0].remaining_quantity);
    const invoicesBeforeRejectedIssue = Number((await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM billing_invoices
        WHERE tenant_id = $1::uuid AND admission_id = $2::int`,
      TENANT,
      medicationAdmissionId,
    ))[0].count);
    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_catalog
          SET strength = '1000 mg', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      medicationSubstitute.catalogId,
    );
    await expect(issueWardIndent({
      indentId: indent.id,
      issuedBy: PHARMACIST,
      expectedVersion: approved.state_version,
      commandKey: `med-sub-incompatible-issue-${RUN}`,
      tenantId: TENANT,
    })).rejects.toMatchObject({
      code: 'WARD_INDENT_MEDICATION_SUBSTITUTION_INCOMPATIBLE',
      statusCode: 409,
      details: expect.objectContaining({
        phase: 'issue',
        mismatched_dimensions: expect.arrayContaining(['strength']),
      }),
    });
    expect(Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      medicationSubstitute.batchId,
    ))[0].remaining_quantity)).toBe(stockBeforeRejectedIssue);
    expect(Number((await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM billing_invoices
        WHERE tenant_id = $1::uuid AND admission_id = $2::int`,
      TENANT,
      medicationAdmissionId,
    ))[0].count)).toBe(invoicesBeforeRejectedIssue);
    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_catalog
          SET strength = '500 mg', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      medicationSubstitute.catalogId,
    );
    const issued = await issueWardIndent({
      indentId: indent.id,
      issuedBy: PHARMACIST,
      expectedVersion: approved.state_version,
      commandKey: `med-sub-compatible-issue-${RUN}`,
      tenantId: TENANT,
    });
    expect(issued.status).toBe('issued');
    expect(issued.items[0]).toMatchObject({
      pharmacy_catalog_id: medicationSubstitute.catalogId,
      original_pharmacy_catalog_id: medicationShortSupply.catalogId,
      substitution_status: 'approved',
    });
    const issuedEvent = issued.workflow.events.find((event) => event.action === 'issued');
    expect(issuedEvent.details.medication_substitution_compatibility).toEqual([
      expect.objectContaining({
        item_id: indent.items[0].id,
        original_catalog_id: medicationShortSupply.catalogId,
        substitute_catalog_id: medicationSubstitute.catalogId,
        compatibility_rule: 'same_high_confidence_composition_exact_strength_components_form_route_release_v2',
        provenance: expect.objectContaining({
          original: expect.objectContaining({
            composition_id: medicationCompositionId,
            composition_confidence: 'high',
          }),
          substitute: expect.objectContaining({
            composition_id: medicationCompositionId,
            composition_confidence: 'high',
          }),
        }),
        provenance_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
  }, 60_000);

  test('aborts issue when the authoritative order catalog is reclassified as non-medication', async () => {
    const catalog = await seedCatalog(`MED-01 Reclassified ${RUN}`, 8, {
      scheduleClass: 'OTC',
      medication: true,
    });
    const indent = await createControlledMedicationIndent({
      catalog,
      quantity: 2,
      key: 'catalog-reclassified-before-issue',
    });
    const reserved = await reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACIST,
      expectedVersion: indent.state_version,
      commandKey: `reclassified-reserve-${RUN}`,
      tenantId: TENANT,
    });
    const approved = await approveWardIndent({
      indentId: indent.id,
      approvedBy: PHARMACIST,
      expectedVersion: reserved.state_version,
      commandKey: `reclassified-approve-${RUN}`,
      tenantId: TENANT,
    });
    const stockBefore = Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT,
      catalog.batchId,
    ))[0].remaining_quantity);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE pharmacy_catalog
            SET category = 'ward_supply',
                requires_prescription = FALSE,
                composition_id = NULL,
                strength = NULL,
                form = NULL,
                route = NULL,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        TENANT,
        catalog.catalogId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE pharmacy_inventory_items
            SET composition_id = NULL,
                strength = NULL,
                form = NULL,
                schedule_class = NULL,
                is_narcotic = FALSE,
                metadata = '{}'::jsonb
          WHERE tenant_id = $1::uuid AND catalog_id = $2::int`,
        TENANT,
        catalog.catalogId,
      );
    });

    await expect(issueWardIndent({
      indentId: indent.id,
      issuedBy: PHARMACIST,
      expectedVersion: approved.state_version,
      commandKey: `reclassified-issue-${RUN}`,
      tenantId: TENANT,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'WARD_INDENT_MEDICATION_CATALOG_CLASSIFICATION_MISMATCH',
    });
    expect(Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT,
      catalog.batchId,
    ))[0].remaining_quantity)).toBe(stockBefore);
    expect(await prisma.$queryRawUnsafe(
      `SELECT id
         FROM ward_indent_financial_events
        WHERE tenant_id = $1::uuid AND ward_indent_id = $2::integer`,
      TENANT,
      Number(indent.id),
    )).toHaveLength(0);
  }, 60_000);

  test('aborts before inventory or billing when the linked order became terminal', async () => {
    const catalog = await seedCatalog(`MED-03 Terminal Order ${RUN}`, 8, {
      scheduleClass: 'OTC',
      medication: true,
    });
    const indent = await createControlledMedicationIndent({
      catalog,
      quantity: 2,
      key: 'terminal-before-issue',
    });
    const reserved = await reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACIST,
      expectedVersion: indent.state_version,
      commandKey: `terminal-before-issue-reserve-${RUN}`,
      tenantId: TENANT,
    });
    const approved = await approveWardIndent({
      indentId: indent.id,
      approvedBy: PHARMACIST,
      expectedVersion: reserved.state_version,
      commandKey: `terminal-before-issue-approve-${RUN}`,
      tenantId: TENANT,
    });
    const cancelledOrder = await cancelOrder(
      Number(indent.items[0].clinical_order_id),
      DOCTOR,
      'Medication no longer indicated',
    );
    expect(cancelledOrder.ward_indent_terminal_projection).toMatchObject({
      disposition: 'cancelled',
      ward_indent_id: Number(indent.id),
      ward_indent_status: 'cancelled',
      remaining_active_clinical_order_ids: []
    });
    const cancelledIndent = await getWardIndent(indent.id, { tenantId: TENANT });
    expect(cancelledIndent).toMatchObject({
      status: 'cancelled',
      active_sla_source_id: null,
      items: [
        expect.objectContaining({
          fulfilment_status: 'cancelled',
          quantity_reserved: 0,
          quantity_approved: 0
        })
      ]
    });
    const released = await prisma.$queryRawUnsafe(
      `SELECT status, issued_quantity
         FROM ward_indent_inventory_allocations
        WHERE tenant_id = $1::uuid AND ward_indent_id = $2::int`,
      TENANT,
      Number(indent.id)
    );
    expect(released.length).toBeGreaterThan(0);
    expect(
      released.every(row => row.status === 'released' && Number(row.issued_quantity) === 0)
    ).toBe(true);
    expect(
      await prisma.$queryRawUnsafe(
        `SELECT id FROM tasks
        WHERE tenant_id = $1::uuid
          AND metadata->>'ward_indent_id' = $2::text
          AND status = ANY($3::text[])`,
        TENANT,
        String(indent.id),
        ['open', 'in_progress', 'blocked', 'overdue']
      )
    ).toHaveLength(0);
    expect(
      await prisma.$queryRawUnsafe(
        `SELECT id FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND source_table = 'ward_indents'
          AND source_id LIKE $2
          AND completed_at IS NULL`,
        TENANT,
        `ward-indent:${indent.id}:%`
      )
    ).toHaveLength(0);
    const stockBefore = Number(
      (
        await prisma.$queryRawUnsafe(
          `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      catalog.batchId,
    ))[0].remaining_quantity);

    await expect(
      issueWardIndent({
        indentId: indent.id,
        issuedBy: PHARMACIST,
        expectedVersion: approved.state_version,
        commandKey: `terminal-before-issue-attempt-${RUN}`,
        tenantId: TENANT
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      Number(
        (
          await prisma.$queryRawUnsafe(
            `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      catalog.batchId,
    ))[0].remaining_quantity)).toBe(stockBefore);
    expect(await prisma.$queryRawUnsafe(
      `SELECT id
         FROM ward_indent_financial_events
        WHERE tenant_id = $1::uuid AND ward_indent_id = $2::int`,
      TENANT,
      Number(indent.id),
    )).toHaveLength(0);
  }, 60_000);

  test('terminal order with issued custody opens reconciliation without stock return or credit', async () => {
    const catalog = await seedCatalog(`MED-03 Issued Terminal ${RUN}`, 8, {
      scheduleClass: 'OTC',
      medication: true
    });
    const indent = await createControlledMedicationIndent({
      catalog,
      quantity: 2,
      key: 'issued-terminal'
    });
    const reserved = await reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACIST,
      expectedVersion: indent.state_version,
      commandKey: `issued-terminal-reserve-${RUN}`,
      tenantId: TENANT
    });
    const approved = await approveWardIndent({
      indentId: indent.id,
      approvedBy: PHARMACIST,
      expectedVersion: reserved.state_version,
      commandKey: `issued-terminal-approve-${RUN}`,
      tenantId: TENANT
    });
    const issued = await issueWardIndent({
      indentId: indent.id,
      issuedBy: PHARMACIST,
      expectedVersion: approved.state_version,
      commandKey: `issued-terminal-issue-${RUN}`,
      tenantId: TENANT
    });
    expect(issued.status).toBe('issued');
    const stockAfterIssue = Number(
      (
        await prisma.$queryRawUnsafe(
          `SELECT remaining_quantity FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
          TENANT,
          catalog.batchId
        )
      )[0].remaining_quantity
    );
    const financialBefore = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM ward_indent_financial_events
        WHERE tenant_id = $1::uuid AND ward_indent_id = $2::int`,
      TENANT,
      Number(indent.id)
    );
    expect(financialBefore.length).toBeGreaterThan(0);

    const cancelledOrder = await cancelOrder(
      Number(indent.items[0].clinical_order_id),
      DOCTOR,
      'Therapy stopped after issue; reconcile ward custody'
    );
    expect(cancelledOrder.ward_indent_terminal_projection).toMatchObject({
      disposition: 'reconciliation_required',
      ward_indent_id: Number(indent.id),
      ward_indent_status: 'reconciliation_required'
    });
    const projected = await getWardIndent(indent.id, { tenantId: TENANT });
    expect(projected).toMatchObject({ status: 'reconciliation_required' });
    expect(
      Number(
        (
          await prisma.$queryRawUnsafe(
            `SELECT remaining_quantity FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
            TENANT,
            catalog.batchId
          )
        )[0].remaining_quantity
      )
    ).toBe(stockAfterIssue);
    expect(
      await prisma.$queryRawUnsafe(
        `SELECT id, status FROM ward_indent_financial_events
        WHERE tenant_id = $1::uuid AND ward_indent_id = $2::int
        ORDER BY id`,
        TENANT,
        Number(indent.id)
      )
    ).toEqual(financialBefore);
    expect(
      await prisma.$queryRawUnsafe(
        `SELECT id FROM billing_credit_notes
        WHERE tenant_id = $1::uuid
          AND source_financial_event_id IN (
            SELECT id FROM ward_indent_financial_events
             WHERE tenant_id = $1::uuid AND ward_indent_id = $2::int
          )`,
        TENANT,
        Number(indent.id)
      )
    ).toHaveLength(0);
    expect(
      (
        await prisma.$queryRawUnsafe(
          `SELECT COUNT(*)::int AS count FROM tasks
        WHERE tenant_id = $1::uuid
          AND metadata->>'ward_indent_id' = $2::text
          AND status = ANY($3::text[])`,
          TENANT,
          String(indent.id),
          ['open', 'in_progress', 'blocked', 'overdue']
        )
      )[0].count
    ).toBe(1);
    expect(
      (
        await prisma.$queryRawUnsafe(
          `SELECT COUNT(*)::int AS count FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND source_table = 'ward_indents'
          AND source_id = $2
          AND completed_at IS NULL`,
          TENANT,
          projected.active_sla_source_id
        )
      )[0].count
    ).toBe(1);
  }, 60_000);

  test('ward-transition failure rolls back the terminal order and reservation release together', async () => {
    const catalog = await seedCatalog(`MED-03 Terminal Rollback ${RUN}`, 8, {
      scheduleClass: 'OTC',
      medication: true
    });
    const indent = await createControlledMedicationIndent({
      catalog,
      quantity: 2,
      key: 'terminal-rollback'
    });
    await reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACIST,
      expectedVersion: indent.state_version,
      commandKey: `terminal-rollback-reserve-${RUN}`,
      tenantId: TENANT
    });
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS test_med03_terminal_ward_rollback ON ward_indent_events'
    );
    await prisma.$executeRawUnsafe(
      'DROP FUNCTION IF EXISTS public.test_med03_terminal_ward_rollback()'
    );
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION public.test_med03_terminal_ward_rollback()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.ward_indent_id = ${Number(indent.id)} AND NEW.action = 'cancelled' THEN
           RAISE EXCEPTION 'forced terminal ward rollback' USING ERRCODE = 'P0001';
         END IF;
         RETURN NEW;
       END $$`
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER test_med03_terminal_ward_rollback
       BEFORE INSERT ON ward_indent_events
       FOR EACH ROW EXECUTE FUNCTION public.test_med03_terminal_ward_rollback()`
    );
    try {
      await expect(
        cancelOrder(
          Number(indent.items[0].clinical_order_id),
          DOCTOR,
          'Force the shared transaction to roll back'
        )
      ).rejects.toThrow(/forced terminal ward rollback/i);
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS test_med03_terminal_ward_rollback ON ward_indent_events'
      );
      await prisma.$executeRawUnsafe(
        'DROP FUNCTION IF EXISTS public.test_med03_terminal_ward_rollback()'
      );
    }
    expect(
      await prisma.clinical_orders.findUnique({
        where: { id: Number(indent.items[0].clinical_order_id) },
        select: { status: true }
      })
    ).toEqual({ status: 'verified' });
    expect(await getWardIndent(indent.id, { tenantId: TENANT })).toMatchObject({
      status: 'reserved'
    });
    expect(
      (
        await prisma.$queryRawUnsafe(
          `SELECT COUNT(*)::int AS count
         FROM ward_indent_inventory_allocations
        WHERE tenant_id = $1::uuid
          AND ward_indent_id = $2::int
          AND status = 'reserved'`,
          TENANT,
          Number(indent.id)
        )
      )[0].count
    ).toBeGreaterThan(0);
  }, 60_000);

  test('terminal projection releases later unissued lines while mixed controlled custody remains in reconciliation', async () => {
    const regularCatalog = await seedCatalog(`MED-03 Multi-line Terminal ${RUN}`, 8, {
      scheduleClass: 'OTC',
      medication: true
    });
    const controlledDetails = bindMedicationOrderCatalogAuthority(
      {
        medication_name: controlled.name,
        catalog_id: controlled.catalogId,
        dose: controlled.strength,
        route: controlled.route,
        quantity_requested: 1,
        unit: 'each'
      },
      { ...controlled, id: controlled.catalogId },
      { phase: 'create' }
    );
    const regularDetails = bindMedicationOrderCatalogAuthority(
      {
        medication_name: regularCatalog.name,
        catalog_id: regularCatalog.catalogId,
        dose: regularCatalog.strength,
        route: regularCatalog.route,
        quantity_requested: 1,
        unit: 'each'
      },
      { ...regularCatalog, id: regularCatalog.catalogId },
      { phase: 'create' }
    );
    const orderRows = (
      await prisma.$queryRawUnsafe(
        `INSERT INTO clinical_orders
         (tenant_id, order_number, patient_uid, encounter_id, order_type,
          status, ordered_by, details, updated_at)
       VALUES
         ($1::uuid, $2, $3::uuid, $4::uuid, 'medication', 'ordered',
          $5::uuid, $6::jsonb, NOW()),
         ($1::uuid, $7, $3::uuid, $4::uuid, 'medication', 'ordered',
          $5::uuid, $8::jsonb, NOW()),
         ($1::uuid, $9, $3::uuid, $4::uuid, 'medication', 'ordered',
          $5::uuid, $8::jsonb, NOW())
       RETURNING id`,
        TENANT,
        `MED-01-multi-stop-${RUN}`.slice(0, 80),
        PATIENT,
        medicationEncounterId,
        DOCTOR,
        JSON.stringify(controlledDetails),
        `MED-01-multi-unissued-${RUN}`.slice(0, 80),
        JSON.stringify(regularDetails),
        `MED-01-multi-still-active-${RUN}`.slice(0, 80)
      )
    ).sort((left, right) => Number(left.id) - Number(right.id));
    for (const [index, row] of orderRows.entries()) {
      await verifyOrder(Number(row.id), PHARMACIST, {
        tenantId: TENANT,
        actorRole: 'PHARMACY_INCHARGE',
        idempotencyKey: `med01-verify-multi-${index}-${RUN}`
      });
    }
    const indent = await createWardIndent({
      wardId,
      admissionId: medicationAdmissionId,
      encounterId: medicationEncounterId,
      patientUid: PATIENT,
      indentType: 'consumables',
      items: orderRows.map((row, index) => ({
        pharmacy_catalog_id: index === 0 ? controlled.catalogId : regularCatalog.catalogId,
        clinical_order_id: Number(row.id),
        item_name: index === 0 ? controlled.name : regularCatalog.name,
        quantity_requested: 1
      })),
      requestedBy: REQUESTER,
      commandKey: `med01-create-multi-${RUN}`,
      tenantId: TENANT
    });
    const reserved = await reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACIST,
      expectedVersion: indent.state_version,
      commandKey: `med01-reserve-multi-${RUN}`,
      tenantId: TENANT
    });
    const approval = await approveWardIndent({
      indentId: indent.id,
      approvedBy: PHARMACIST,
      expectedVersion: reserved.state_version,
      commandKey: `med01-approve-multi-${RUN}`,
      tenantId: TENANT
    });
    expect(approval.status).toBe('controlled_handoff_required');
    const controlledLine = approval.items.find(
      item => Number(item.clinical_order_id) === Number(orderRows[0].id)
    );
    const dispense = await dispenseControlled({
      tenantId: TENANT,
      inventory_item_id: controlled.inventoryItemId,
      inventory_batch_id: controlled.batchId,
      quantity: 1,
      patient_uid: PATIENT,
      patient_name: 'Ward Patient',
      performed_by: PHARMACIST,
      performed_by_name: 'Issuing Pharmacist',
      reference_id: controlledLine.controlled_reference_id
    });
    const handoff = await recordWardIndentControlledHandoff({
      indentId: indent.id,
      recordedBy: PHARMACIST,
      itemEvidence: [
        {
          item_id: controlledLine.id,
          movement_id: dispense.movement.id,
          register_id: dispense.register_entry.id
        }
      ],
      expectedVersion: approval.state_version,
      commandKey: `med01-controlled-handoff-multi-${RUN}`,
      tenantId: TENANT
    });
    expect(handoff.status).toBe('approved');

    const cancelled = await cancelOrder(
      Number(orderRows[0].id),
      DOCTOR,
      'Stop the issued controlled medication line'
    );
    expect(cancelled.ward_indent_terminal_projection).toMatchObject({
      disposition: 'reconciliation_required',
      remaining_active_clinical_order_ids: [
        Number(orderRows[1].id),
        Number(orderRows[2].id)
      ]
    });
    const secondCancelled = await cancelOrder(
      Number(orderRows[1].id),
      DOCTOR,
      'Stop the second medication line while reconciliation remains open'
    );
    expect(secondCancelled.ward_indent_terminal_projection).toMatchObject({
      disposition: 'reconciliation_required',
      remaining_active_clinical_order_ids: [Number(orderRows[2].id)]
    });
    const allocations = await prisma.$queryRawUnsafe(
      `SELECT item.clinical_order_id, allocation.status,
              allocation.reserved_quantity, allocation.issued_quantity
         FROM ward_indent_inventory_allocations allocation
         JOIN ward_indent_items item
           ON item.tenant_id = allocation.tenant_id
          AND item.id = allocation.ward_indent_item_id
        WHERE allocation.tenant_id = $1::uuid
          AND allocation.ward_indent_id = $2::int
        ORDER BY item.clinical_order_id`,
      TENANT,
      Number(indent.id)
    );
    expect(allocations).toHaveLength(3);
    expect(
      allocations.find(row => Number(row.clinical_order_id) === Number(orderRows[0].id))
    ).toMatchObject({ status: 'released' });
    expect(
      allocations.find(row => Number(row.clinical_order_id) === Number(orderRows[1].id))
    ).toMatchObject({ status: 'released' });
    expect(
      allocations.find(row => Number(row.clinical_order_id) === Number(orderRows[2].id))
    ).toMatchObject({ status: 'reserved' });
    const projectedItems = await prisma.$queryRawUnsafe(
      `SELECT clinical_order_id, controlled_movement_id, fulfilment_status
         FROM ward_indent_items
        WHERE tenant_id = $1::uuid
          AND ward_indent_id = $2::int
        ORDER BY clinical_order_id`,
      TENANT,
      Number(indent.id)
    );
    expect(
      projectedItems.find(row => Number(row.clinical_order_id) === Number(orderRows[0].id))
    ).toMatchObject({
      controlled_movement_id: dispense.movement.id,
      fulfilment_status: 'reconciliation_required'
    });
    expect(
      projectedItems.find(row => Number(row.clinical_order_id) === Number(orderRows[1].id))
    ).toMatchObject({ fulfilment_status: 'reconciliation_required' });
    expect(
      projectedItems.find(row => Number(row.clinical_order_id) === Number(orderRows[2].id))
    ).toMatchObject({ fulfilment_status: 'approved' });
    const activeOrder = await prisma.clinical_orders.findUnique({
      where: { id: Number(orderRows[2].id) },
      select: { status: true }
    });
    expect(activeOrder.status).toBe('verified');
  }, 60_000);

  test('requires statutory handoff and patient-linked return evidence for Schedule H1', async () => {
    const indent = await createControlledMedicationIndent({
      quantity: 2,
      key: 'controlled',
    });
    await reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACIST,
      expectedVersion: 1,
      commandKey: `controlled-reserve-${RUN}`,
      tenantId: TENANT,
    });
    const approval = await approveWardIndent({
      indentId: indent.id,
      approvedBy: PHARMACIST,
      expectedVersion: 2,
      commandKey: `controlled-approve-${RUN}`,
      tenantId: TENANT,
    });
    expect(approval.status).toBe('controlled_handoff_required');
    const line = approval.items[0];
    await expect(issueWardIndent({
      indentId: indent.id,
      issuedBy: PHARMACIST,
      commandKey: `controlled-premature-issue-${RUN}`,
      tenantId: TENANT,
    })).rejects.toMatchObject({ code: 'WARD_INDENT_INVALID_TRANSITION' });

    const dispense = await dispenseControlled({
      tenantId: TENANT,
      inventory_item_id: controlled.inventoryItemId,
      inventory_batch_id: controlled.batchId,
      quantity: 2,
      patient_uid: PATIENT,
      patient_name: 'Ward Patient',
      performed_by: PHARMACIST,
      performed_by_name: 'Issuing Pharmacist',
      reference_id: line.controlled_reference_id,
    });
    const recoverable = await getWardIndent(indent.id, { tenantId: TENANT });
    expect(recoverable.workflow.pending_controlled_handoff_evidence).toEqual([{
      item_id: line.id,
      status: 'available',
      candidate_count: 1,
      movement_id: dispense.movement.id,
      register_id: dispense.register_entry.id,
    }]);
    const handoff = await recordWardIndentControlledHandoff({
      indentId: indent.id,
      recordedBy: PHARMACIST,
      itemEvidence: [{
        item_id: line.id,
        movement_id: dispense.movement.id,
        register_id: dispense.register_entry.id,
      }],
      expectedVersion: 3,
      commandKey: `controlled-handoff-${RUN}`,
      tenantId: TENANT,
    });
    expect(handoff.status).toBe('approved');
    expect(handoff.workflow.pending_controlled_handoff_evidence).toEqual([]);
    await issueWardIndent({
      indentId: indent.id,
      issuedBy: PHARMACIST,
      expectedVersion: 4,
      commandKey: `controlled-issue-${RUN}`,
      tenantId: TENANT,
    });
    await receiveWardIndent({
      indentId: indent.id,
      receivedBy: RECEIVER,
      expectedVersion: 5,
      commandKey: `controlled-receive-${RUN}`,
      tenantId: TENANT,
    });
    const returned = await requestWardIndentReturn({
      indentId: indent.id,
      requestedBy: RECEIVER,
      itemQuantitiesReturned: [{ item_id: line.id, quantity_returned: 1 }],
      reason: 'One unit unused',
      expectedVersion: 6,
      commandKey: `controlled-return-request-${RUN}`,
      tenantId: TENANT,
    });
    expect(returned.status).toBe('return_pending');
    await expect(reconcileWardIndent({
      indentId: indent.id,
      reconciledBy: RECEIVER,
      reason: 'Return attempted without custody evidence',
      expectedVersion: 7,
      commandKey: `controlled-return-no-evidence-${RUN}`,
      tenantId: TENANT,
    })).rejects.toThrow('Controlled return evidence is required');

    const returnEvidence = await recordMovement({
      tenantId: TENANT,
      inventory_item_id: controlled.inventoryItemId,
      inventory_batch_id: controlled.batchId,
      movement_kind: 'return',
      quantity: 1,
      patient_uid: PATIENT,
      reference_type: 'ward_indent_return',
      reference_id: `ward-indent-return:${indent.id}:item:${line.id}`,
      performed_by: PHARMACIST,
      performed_by_name: 'Issuing Pharmacist',
    });
    const reconciled = await reconcileWardIndent({
      indentId: indent.id,
      reconciledBy: RECEIVER,
      reason: 'Controlled return entered in statutory register',
      controlledReturnEvidence: [{
        item_id: line.id,
        movement_id: returnEvidence.movement.id,
        register_id: returnEvidence.register_entry.id,
      }],
      expectedVersion: 7,
      commandKey: `controlled-reconcile-${RUN}`,
      tenantId: TENANT,
    });
    expect(reconciled.status).toBe('reconciled');
    expect(reconciled.items[0]).toMatchObject({
      controlled_return_movement_id: returnEvidence.movement.id,
      controlled_return_register_id: returnEvidence.register_entry.id,
    });
    expect(reconciled.workflow.events[0].details.controlled_return_references).toEqual([{
      item_id: line.id,
      movement_id: returnEvidence.movement.id,
      register_id: returnEvidence.register_entry.id,
    }]);
    const closed = await closeWardIndent({
      indentId: indent.id,
      closedBy: RECEIVER,
      reason: 'Controlled return complete',
      expectedVersion: 8,
      commandKey: `controlled-close-${RUN}`,
      tenantId: TENANT,
    });
    expect(closed).toMatchObject({
      status: 'closed',
      closure_outcome: 'returned_reconciled',
    });
    const evidence = await prisma.$queryRawUnsafe(
      `SELECT register_entry.movement_kind, register_entry.patient_uid,
              movement.reference_type, batch.remaining_quantity
         FROM pharmacy_schedule_register register_entry
         JOIN pharmacy_stock_movements movement
           ON movement.tenant_id = register_entry.tenant_id
          AND movement.id = register_entry.reference_movement_id
         JOIN pharmacy_inventory_batches batch
           ON batch.tenant_id = register_entry.tenant_id
          AND batch.id = register_entry.inventory_batch_id
        WHERE register_entry.tenant_id = $1::uuid
          AND register_entry.inventory_item_id = $2::int
        ORDER BY register_entry.id`,
      TENANT,
      controlled.inventoryItemId,
    );
    expect(evidence.map((row) => row.movement_kind)).toEqual(['dispense', 'return']);
    expect(evidence.every((row) => row.patient_uid === PATIENT)).toBe(true);
    expect(evidence[1].reference_type).toBe('ward_indent_return');
    expect(Number(evidence[1].remaining_quantity)).toBe(19);
  }, 60_000);

  test('keeps admission billing open until committed controlled custody reaches issue', async () => {
    const admission = await seedMedicationAdmission(OTHER_PATIENT, 'controlled-custody');
    const indent = await createControlledMedicationIndent({
      patientUid: OTHER_PATIENT,
      admissionId: admission.admissionId,
      encounterId: admission.encounterId,
      quantity: 1,
      key: 'controlled-custody',
    });
    const reserved = await reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACIST,
      expectedVersion: 1,
      commandKey: `controlled-custody-reserve-${RUN}`,
      tenantId: TENANT,
    });
    const approval = await approveWardIndent({
      indentId: indent.id,
      approvedBy: PHARMACIST,
      expectedVersion: reserved.state_version,
      commandKey: `controlled-custody-approve-${RUN}`,
      tenantId: TENANT,
    });
    const line = approval.items[0];
    const dispense = await dispenseControlled({
      tenantId: TENANT,
      inventory_item_id: controlled.inventoryItemId,
      inventory_batch_id: controlled.batchId,
      quantity: 1,
      patient_uid: OTHER_PATIENT,
      patient_name: 'Other Ward Patient',
      performed_by: PHARMACIST,
      performed_by_name: 'Issuing Pharmacist',
      reference_id: line.controlled_reference_id,
    });
    const handoff = await recordWardIndentControlledHandoff({
      indentId: indent.id,
      recordedBy: PHARMACIST,
      itemEvidence: [{
        item_id: line.id,
        movement_id: dispense.movement.id,
        register_id: dispense.register_entry.id,
      }],
      expectedVersion: approval.state_version,
      commandKey: `controlled-custody-handoff-${RUN}`,
      tenantId: TENANT,
    });
    expect(handoff.status).toBe('approved');

    await expect(admissionService.markForDischarge(
      admission.admissionId,
      REQUESTER,
      'IP_STAFF_NURSE',
      { tenantId: TENANT },
    )).rejects.toMatchObject({
      statusCode: 409,
      code: 'ADMISSION_CONTROLLED_WARD_CUSTODY_OPEN',
    });
    expect((await prisma.$queryRawUnsafe(
      `SELECT billing_closed_at, discharge_initiated_at
         FROM admissions
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      admission.admissionId,
    ))[0]).toMatchObject({
      billing_closed_at: null,
      discharge_initiated_at: null,
    });

    const issued = await issueWardIndent({
      indentId: indent.id,
      issuedBy: PHARMACIST,
      expectedVersion: handoff.state_version,
      commandKey: `controlled-custody-issue-${RUN}`,
      tenantId: TENANT,
    });
    expect(issued.status).toBe('issued');
    const discharge = await admissionService.markForDischarge(
      admission.admissionId,
      REQUESTER,
      'IP_STAFF_NURSE',
      { tenantId: TENANT },
    );
    expect(Number(discharge.admission.id)).toBe(admission.admissionId);
    expect((await prisma.$queryRawUnsafe(
      `SELECT billing_closed_at
         FROM admissions
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      admission.admissionId,
    ))[0].billing_closed_at).toBeTruthy();
  }, 60_000);

  test('keeps patientless non-controlled ward-stock approval available', async () => {
    const indent = await createWardIndent({
      wardId,
      patientUid: null,
      indentType: 'consumables',
      items: [{
        pharmacy_catalog_id: plain.catalogId,
        item_name: plain.name,
        quantity_requested: 1,
      }],
      requestedBy: REQUESTER,
      commandKey: `patientless-plain-create-${RUN}`,
      tenantId: TENANT,
    });
    const reserved = await reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACIST,
      expectedVersion: 1,
      commandKey: `patientless-plain-reserve-${RUN}`,
      tenantId: TENANT,
    });
    const approved = await approveWardIndent({
      indentId: indent.id,
      approvedBy: PHARMACIST,
      expectedVersion: reserved.state_version,
      commandKey: `patientless-plain-approve-${RUN}`,
      tenantId: TENANT,
    });

    expect(approved).toMatchObject({
      patient_uid: null,
      status: 'approved',
    });
    expect(approved.items[0].controlled_reference_id).toBeNull();
  }, 60_000);

  test('rejects patientless controlled medication before a ward indent is created', async () => {
    await expect(createWardIndent({
      wardId,
      patientUid: null,
      indentType: 'consumables',
      items: [{
        pharmacy_catalog_id: controlled.catalogId,
        item_name: controlled.name,
        quantity_requested: 1,
      }],
      requestedBy: REQUESTER,
      commandKey: `patientless-controlled-create-${RUN}`,
      tenantId: TENANT,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'WARD_INDENT_CLINICAL_ORDER_REQUIRED',
    });
  }, 60_000);

  test('migration rejects a patientless controlled statutory dispense with SQLSTATE 23514', async () => {
    let failure;
    try {
      await dispenseControlled({
        tenantId: TENANT,
        inventory_item_id: controlled.inventoryItemId,
        inventory_batch_id: controlled.batchId,
        quantity: 1,
        patient_uid: null,
        performed_by: PHARMACIST,
        performed_by_name: 'Issuing Pharmacist',
        reference_id: `patientless-ddl-${RUN}`,
      });
    } catch (error) {
      failure = error;
    }
    expect(sqlState(failure)).toBe('23514');
    expect(databaseMessage(failure))
      .toMatch(/chk_controlled_ward_dispense_patient_required|patient-linked statutory register/i);
  }, 60_000);

  test('fails controlled-handoff recovery closed when matching evidence is ambiguous', async () => {
    const indent = await createControlledMedicationIndent({
      quantity: 1,
      key: 'ambiguous',
    });
    await reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACIST,
      expectedVersion: 1,
      commandKey: `ambiguous-reserve-${RUN}`,
      tenantId: TENANT,
    });
    const approval = await approveWardIndent({
      indentId: indent.id,
      approvedBy: PHARMACIST,
      expectedVersion: 2,
      commandKey: `ambiguous-approve-${RUN}`,
      tenantId: TENANT,
    });
    const line = approval.items[0];
    for (let index = 0; index < 2; index += 1) {
      await dispenseControlled({
        tenantId: TENANT,
        inventory_item_id: controlled.inventoryItemId,
        inventory_batch_id: controlled.batchId,
        quantity: 1,
        patient_uid: PATIENT,
        patient_name: 'Ward Patient',
        performed_by: PHARMACIST,
        performed_by_name: 'Issuing Pharmacist',
        reference_id: line.controlled_reference_id,
      });
    }

    const ambiguous = await getWardIndent(indent.id, { tenantId: TENANT });
    expect(ambiguous.workflow.pending_controlled_handoff_evidence).toEqual([{
      item_id: line.id,
      status: 'ambiguous',
      candidate_count: 2,
    }]);
  }, 60_000);

  test('pages every open indent and finds overdue work beyond the first 200 rows', async () => {
    const pageWardId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO wards (tenant_id, name, total_beds, created_at, updated_at)
       VALUES ($1::uuid, $2, 10, NOW(), NOW()) RETURNING id`,
      TENANT,
      `MED-02 Pagination Ward ${RUN}`,
    ))[0].id);
    const inserted = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO ward_indents
           (tenant_id, indent_number, ward_id, ward_name, indent_type, status,
            requested_by, requested_at, patient_uid, owner_role_codes,
            active_sla_source_id, last_transition_at, created_at, updated_at)
         SELECT $1::uuid,
                $2 || '-' || sequence::text,
                $3::int,
                'MED-02 Pagination Ward',
                'pharmacy',
                'requested',
                $4::uuid,
                TIMESTAMPTZ '2026-08-27T12:00:00.000Z'
                  - (sequence * INTERVAL '1 minute'),
                $5::uuid,
                ARRAY['PHARMACY_STAFF']::text[],
                $6 || ':' || sequence::text,
                TIMESTAMPTZ '2026-08-27T12:00:00.000Z'
                  - (sequence * INTERVAL '1 minute'),
                NOW(),
                NOW()
           FROM generate_series(1, 205) AS sequence
         RETURNING id, requested_at, active_sla_source_id`,
        TENANT,
        `MED02-PAGE-${RUN}`,
        pageWardId,
        REQUESTER,
        PATIENT,
        `ward-indent-page:${RUN}`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO ward_indent_events
           (tenant_id, ward_indent_id, state_version, action, from_status,
            to_status, actor_uid, owner_role_codes, details, occurred_at)
         SELECT indent.tenant_id, indent.id, 1, 'created', NULL, 'requested',
                $3::uuid, indent.owner_role_codes,
                '{"med_02_pagination_fixture":true}'::jsonb,
                indent.requested_at
           FROM ward_indents indent
          WHERE indent.tenant_id = $1::uuid
            AND indent.ward_id = $2::int`,
        TENANT,
        pageWardId,
        REQUESTER,
      );
      return rows;
    });
    const oldest = inserted.reduce((left, right) => (
      left.requested_at < right.requested_at ? left : right
    ));
    await prisma.$executeRawUnsafe(
      `INSERT INTO workflow_sla_instances
         (tenant_id, rule_code, patient_uid, source_table, source_id, status,
          started_at, due_at, breached_at, assigned_role_codes)
       VALUES ($1::uuid, 'ward_indent_pharmacy_response', $2::uuid,
               'ward_indents', $3, 'breached', NOW() - INTERVAL '4 hours',
               NOW() - INTERVAL '3 hours', NOW() - INTERVAL '3 hours',
               ARRAY['PHARMACY_STAFF']::text[])`,
      TENANT,
      PATIENT,
      oldest.active_sla_source_id,
    );

    const first = await listWardIndentPage({
      tenantId: TENANT,
      wardId: pageWardId,
      worklist: 'open',
      limit: 100,
    });
    const second = await listWardIndentPage({
      tenantId: TENANT,
      wardId: pageWardId,
      worklist: 'open',
      beforeRequestedAt: first.pagination.before_requested_at,
      beforeId: first.pagination.before_id,
      limit: 100,
    });
    const third = await listWardIndentPage({
      tenantId: TENANT,
      wardId: pageWardId,
      worklist: 'open',
      beforeRequestedAt: second.pagination.before_requested_at,
      beforeId: second.pagination.before_id,
      limit: 100,
    });
    const ids = [...first.items, ...second.items, ...third.items].map((row) => row.id);
    expect([first.items.length, second.items.length, third.items.length]).toEqual([100, 100, 5]);
    expect(new Set(ids).size).toBe(205);
    expect(first.pagination.has_more).toBe(true);
    expect(second.pagination.has_more).toBe(true);
    expect(third.pagination.has_more).toBe(false);

    const pharmacyOwned = await listWardIndentPage({
      tenantId: TENANT,
      wardId: pageWardId,
      worklist: 'owned',
      actorRoleCodes: ['PHARMACY_STAFF'],
      limit: 100,
    });
    const nursingOwned = await listWardIndentPage({
      tenantId: TENANT,
      wardId: pageWardId,
      worklist: 'owned',
      actorRoleCodes: ['NURSING_STAFF'],
      limit: 100,
    });
    expect(pharmacyOwned.items).toHaveLength(100);
    expect(pharmacyOwned.pagination.has_more).toBe(true);
    expect(nursingOwned.items).toEqual([]);

    const overdue = await listWardIndentPage({
      tenantId: TENANT,
      wardId: pageWardId,
      worklist: 'overdue',
      limit: 10,
    });
    expect(overdue.items.map((row) => row.id)).toEqual([oldest.id]);
    expect(overdue.items[0].workflow.active_slas[0].status).toBe('breached');
  }, 60_000);
});
