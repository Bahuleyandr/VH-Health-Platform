import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import {
  approveWardIndent,
  approveWardIndentSubstitution,
  closeWardIndent,
  createWardIndent,
  issueWardIndent,
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
import { deleteWithAuditBypass } from './helpers/auditBypass.js';

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

describeIfDb('MED-01 authoritative ward-indent state machine', () => {
  let wardId;
  let plain;
  let shortSupply;
  let substitute;
  let controlled;
  let unclassified;

  async function cleanup() {
    await deleteWithAuditBypass(
      prisma,
      `DELETE FROM ward_indent_events WHERE tenant_id = $1::uuid`,
      TENANT,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid AND source_table = 'ward_indents'`,
      TENANT,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid AND source_table = 'ward_indents'`,
      TENANT,
    ).catch(() => {});
    await deleteWithAuditBypass(
      prisma,
      `DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid AND resource_table = 'ward_indents'`,
      TENANT,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM ward_indents WHERE tenant_id = $1::uuid`,
      TENANT,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_schedule_register WHERE tenant_id = $1::uuid`,
      TENANT,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_stock_movements WHERE tenant_id = $1::uuid`,
      TENANT,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_inventory_batches WHERE tenant_id = $1::uuid`,
      TENANT,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_inventory_items WHERE tenant_id = $1::uuid`,
      TENANT,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_catalog WHERE tenant_id = $1::uuid`,
      TENANT,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM wards WHERE tenant_id = $1::uuid`,
      TENANT,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_orders WHERE tenant_id = $1::uuid`,
      TENANT,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE tenant_id = $1::uuid`,
      TENANT,
    ).catch(() => {});
  }

  async function seedCatalog(name, stock, {
    scheduleClass = 'OTC',
    withBatch = false,
  } = {}) {
    const catalog = (await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, is_active, stock_quantity, unit_price, price, updated_at)
       VALUES ($1::uuid, $2, TRUE, $3, 12.50, 12.50, NOW())
       RETURNING id, name`,
      TENANT,
      name,
      stock,
    ))[0];
    const inventory = (await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, catalog_id, unit_label,
          schedule_class, is_narcotic)
       VALUES ($1::uuid, $2, $3, $4, 'unit', $5, FALSE)
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
                 20, 20, 'in_stock')
         RETURNING id`,
        TENANT,
        Number(inventory.id),
        `MED01-BATCH-${RUN}`,
      ))[0].id);
    }
    return {
      catalogId: Number(catalog.id),
      inventoryItemId: Number(inventory.id),
      batchId,
      name,
    };
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
    plain = await seedCatalog(`MED-01 Plain ${RUN}`, 100);
    shortSupply = await seedCatalog(`MED-01 Short ${RUN}`, 1);
    substitute = await seedCatalog(`MED-01 Substitute ${RUN}`, 100);
    controlled = await seedCatalog(`MED-01 H1 ${RUN}`, 20, {
      scheduleClass: 'H1',
      withBatch: true,
    });
    const unclassifiedRow = (await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, is_active, stock_quantity, unit_price, price, updated_at)
       VALUES ($1::uuid, $2, TRUE, 10, 5, 5, NOW())
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
      indentType: 'pharmacy',
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

  test('fails closed before reservation for unclassified catalog and free-text lines', async () => {
    const unclassifiedIndent = await createWardIndent({
      wardId,
      indentType: 'pharmacy',
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
    })).rejects.toMatchObject({
      code: 'WARD_INDENT_CONTROLLED_CLASSIFICATION_UNRESOLVED',
    });

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
         (tenant_id, order_number, patient_uid, order_type, status, details, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, 'medication', 'ordered', '{}'::jsonb, NOW())
       RETURNING id`,
      TENANT,
      `MED-01-CROSS-PATIENT-${RUN}`,
      OTHER_PATIENT,
    ))[0];
    await expect(createWardIndent({
      wardId,
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

  test('closes the short-supply substitution loop with prescriber evidence', async () => {
    const indent = await createWardIndent({
      wardId,
      patientUid: PATIENT,
      indentType: 'pharmacy',
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

  test('requires statutory handoff and patient-linked return evidence for Schedule H1', async () => {
    const indent = await createWardIndent({
      wardId,
      patientUid: PATIENT,
      indentType: 'pharmacy',
      items: [{
        pharmacy_catalog_id: controlled.catalogId,
        item_name: controlled.name,
        quantity_requested: 2,
      }],
      requestedBy: REQUESTER,
      commandKey: `controlled-create-${RUN}`,
      tenantId: TENANT,
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
});
