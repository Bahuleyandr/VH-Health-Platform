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
import admissionService from '../services/emr/admissionService.js';
import { cancelOrder, verifyOrder } from '../services/emr/orderEntryService.js';
import { bindMedicationOrderCatalogAuthority } from '../services/ipd/wardIndentWorkflowService.js';
import { dispenseControlledTx } from '../services/pharmacy/inventoryV2Service.js';
import { pharmacyCommandRequestSha256 } from '../services/pharmacy/pharmacyOrderCommandReceiptService.js';
import {
  assertPharmacyFacilityGrant,
  grantPharmacyFacilityAuthority,
} from '../services/pharmacy/pharmacyFacilityAuthorityService.js';
import { seedMedicationFacilityAuthority } from './helpers/medicationEvidenceFixture.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-0000a7410001';
const REQUESTER = 'a7410000-0000-4000-8000-000000000001';
const PHARMACIST = 'a7410000-0000-4000-8000-000000000002';
const RECEIVER = 'a7410000-0000-4000-8000-000000000003';
const DOCTOR = 'a7410000-0000-4000-8000-000000000004';
const PATIENT = 'a7410000-0000-4000-8000-000000000005';
const OTHER_PATIENT = 'a7410000-0000-4000-8000-000000000006';
const ADMIN = 'a7410000-0000-4000-8000-000000000007';
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
  let facilityId;
  let storageLocationId;
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
        'e_prescriptions',
        'pharmacy_staff_facility_grant_events',
        'pharmacy_staff_facility_grants',
        'pharmacy_inventory_batches',
        'pharmacy_inventory_items',
        'ward_indent_items',
        'ward_indents',
        'admissions',
        'clinical_orders',
        'pharmacy_catalog',
        'beds',
        'wards',
        'staff',
        'facility_locations',
        'facilities',
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
         (tenant_id, facility_id, sku_code, display_name, catalog_id, unit_label,
          schedule_class, is_narcotic)
       VALUES ($1::uuid, $6::int, $2, $3, $4, 'each', $5, FALSE)
       RETURNING id`,
      TENANT,
      `MED01-${RUN}-${catalog.id}`,
      name,
      Number(catalog.id),
      scheduleClass,
      facilityId,
    ))[0];
    let batchId = null;
    if (withBatch) {
      batchId = Number((await prisma.$queryRawUnsafe(
        `INSERT INTO pharmacy_inventory_batches
           (tenant_id, inventory_item_id, facility_id, storage_location_id,
            batch_number, expiry_date,
            received_quantity, remaining_quantity, status)
         VALUES ($1::uuid, $2, $5::int, $6::int, $3,
                 (NOW() + INTERVAL '365 days')::date,
                 $4, $4, 'in_stock')
         RETURNING id`,
        TENANT,
        Number(inventory.id),
        `MED01-BATCH-${RUN}`,
        stock,
        facilityId,
        storageLocationId,
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

  // Upgraded databases can retain valid pre-link dispenses after the public
  // standalone route is retired; reconstruct those immutable rows without
  // claiming the current ward allocation.
  async function seedHistoricalControlledHandoffEvidence({
    referenceId,
    quantity,
    count,
    key,
    patientUid = PATIENT,
  }) {
    return prisma.$transaction(async (tx) => {
      await assertPharmacyFacilityGrant(tx, {
        tenantId: TENANT,
        facilityId,
        actorUid: PHARMACIST,
        actorRole: 'PHARMACY_INCHARGE',
        forUpdate: true,
      });
      const patient = (await tx.$queryRawUnsafe(
        `SELECT id
           FROM users
          WHERE tenant_id = $1::uuid AND uid = $2::uuid
            AND role = 'PATIENT' AND is_active = TRUE AND status = 'active'`,
        TENANT,
        patientUid,
      ))[0];
      const prescriptionId = Number((await tx.$queryRawUnsafe(
        `INSERT INTO e_prescriptions
           (tenant_id, patient_id, patient_uid, doctor_uid, medications, status,
            lifecycle_status, signed_at, signed_by, prescription_number,
            created_at, updated_at)
         VALUES ($1::uuid, $2::int, $3::uuid, $4::uuid, $5::jsonb, 'active',
                 'signed', NOW(), $4::uuid, $6::text, NOW(), NOW())
         RETURNING id`,
        TENANT,
        Number(patient.id),
        patientUid,
        DOCTOR,
        JSON.stringify([{
          catalog_id: controlled.catalogId,
          name: controlled.name,
          quantity: quantity * count,
          ordered_quantity: quantity * count,
          dispensed_quantity: 0,
          remaining_quantity: quantity * count,
        }]),
        `MED01-HISTORY-${key}-${RUN}`.slice(0, 80),
      ))[0].id);
      const evidence = [];
      for (let index = 0; index < count; index += 1) {
        const result = await dispenseControlledTx(tx, {
          tenantId: TENANT,
          inventory_item_id: controlled.inventoryItemId,
          inventory_batch_id: controlled.batchId,
          quantity,
          patient_uid: patientUid,
          prescription_id: prescriptionId,
          prescription_line_index: 0,
          performed_by: PHARMACIST,
          reference_id: referenceId,
          notes: `Historical unclaimed ward handoff evidence ${index + 1}`,
        });
        evidence.push({
          movementId: Number(result.movement.id),
          registerId: Number(result.register_entry.id),
        });
      }
      return evidence;
    });
  }

  async function rewriteHistoricalRegisterFacilityForFixture(registerId, nextFacilityId) {
    await prisma.$transaction(async (tx) => {
      // Test-only reconstruction of pre-upgrade corruption; runtime evidence remains append-only.
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      await tx.$executeRawUnsafe(
        `UPDATE pharmacy_schedule_register
            SET facility_id = $3::int
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        TENANT,
        Number(registerId),
        nextFacilityId,
      );
    });
  }

  async function createControlledMedicationIndent({
    patientUid = PATIENT,
    admissionId = medicationAdmissionId,
    encounterId = medicationEncounterId,
    catalog = controlled,
    quantity = 1,
    lineCount = 1,
    key,
  }) {
    const orderIds = [];
    for (let index = 0; index < lineCount; index += 1) {
      const lineKey = lineCount === 1 ? key : `${key}-${index + 1}`;
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
        `MED-01-${lineKey}-${RUN}`.slice(0, 80),
        patientUid,
        encounterId,
        DOCTOR,
        JSON.stringify(details),
      ))[0];
      await verifyOrder(Number(order.id), PHARMACIST, {
        tenantId: TENANT,
        actorRole: 'PHARMACY_INCHARGE',
        idempotencyKey: `med01-verify-${lineKey}-${RUN}`,
      });
      orderIds.push(Number(order.id));
    }
    return createWardIndent({
      wardId,
      admissionId,
      encounterId,
      patientUid,
      indentType: 'consumables',
      items: orderIds.map((orderId) => ({
        pharmacy_catalog_id: catalog.catalogId,
        clinical_order_id: orderId,
        item_name: catalog.name,
        quantity_requested: quantity,
      })),
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
       VALUES
         ($1::uuid, $3::uuid, 'Other Ward Patient', 'PATIENT', TRUE, 'active', NOW()),
         ($2::uuid, $3::uuid, 'Facility Grant Administrator', 'ADMIN', TRUE, 'active', NOW())`,
      OTHER_PATIENT,
      ADMIN,
      TENANT,
    );
    const authority = await seedMedicationFacilityAuthority({
      prisma,
      tenantId: TENANT,
      pharmacistUid: PHARMACIST,
      grantAdminUid: ADMIN,
      run: `med01-${RUN}`,
    });
    facilityId = authority.facilityId;
    storageLocationId = authority.storageLocationId;
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff
         (tenant_id, user_id, employee_id, name, designation, skills,
          certifications, is_active, archived, created_at, updated_at)
       VALUES
         ($1::uuid, $2::uuid, $4::text, 'Receiving Nurse', 'Nursing Incharge',
          '{}'::text[], '{}'::text[], TRUE, FALSE, NOW(), NOW()),
         ($1::uuid, $3::uuid, $5::text, 'Prescriber', 'Doctor',
          '{}'::text[], '{}'::text[], TRUE, FALSE, NOW(), NOW()),
         ($1::uuid, $6::uuid, $7::text, 'Facility Grant Administrator', 'Administrator',
          '{}'::text[], '{}'::text[], TRUE, FALSE, NOW(), NOW())`,
      TENANT,
      RECEIVER,
      DOCTOR,
      `MED01-RECEIVER-${RUN}`.slice(0, 50),
      `MED01-DOCTOR-${RUN}`.slice(0, 50),
      ADMIN,
      `MED01-ADMIN-${RUN}`.slice(0, 50),
    );
    await grantPharmacyFacilityAuthority({
      tenantId: TENANT,
      facilityId,
      staffUid: ADMIN,
      actorUid: ADMIN,
      actorRole: 'ADMIN',
      reason: 'Explicit non-dispensing facility grant for ward recovery denial coverage',
      commandKey: `med01-admin-facility-grant-${RUN}`,
    });
    wardId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO wards (tenant_id, facility_id, name, total_beds, created_at, updated_at)
       VALUES ($1::uuid, $3::int, $2, 10, NOW(), NOW()) RETURNING id`,
      TENANT,
      `MED-01 Ward ${RUN}`,
      facilityId,
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
    const stockBeforeHandoff = Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      controlled.batchId,
    ))[0].remaining_quantity);
    const handoff = await recordWardIndentControlledHandoff({
      indentId: indent.id,
      recordedBy: PHARMACIST,
      itemEvidence: [{ item_id: controlledLine.id }],
      expectedVersion: approval.state_version,
      commandKey: `med01-controlled-handoff-multi-${RUN}`,
      tenantId: TENANT,
      actorRole: 'PHARMACY_INCHARGE',
    });
    expect(handoff.status).toBe('approved');
    expect(handoff.state_version).toBe(4);
    const handedOffControlledLine = handoff.items.find(
      item => Number(item.id) === Number(controlledLine.id)
    );
    const controlledMovementId = Number(handedOffControlledLine.controlled_movement_id);
    const controlledRegisterId = Number(handedOffControlledLine.controlled_register_id);
    expect(controlledMovementId).toBeGreaterThan(0);
    expect(controlledRegisterId).toBeGreaterThan(0);
    expect(Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      controlled.batchId,
    ))[0].remaining_quantity)).toBe(stockBeforeHandoff - 1);

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
    const controlledAllocation = allocations.find(
      row => Number(row.clinical_order_id) === Number(orderRows[0].id)
    );
    expect(controlledAllocation).toMatchObject({ status: 'issued' });
    expect(Number(controlledAllocation.issued_quantity)).toBe(1);
    expect(
      allocations.find(row => Number(row.clinical_order_id) === Number(orderRows[1].id))
    ).toMatchObject({ status: 'released' });
    expect(
      allocations.find(row => Number(row.clinical_order_id) === Number(orderRows[2].id))
    ).toMatchObject({ status: 'reserved' });
    const projectedItems = await prisma.$queryRawUnsafe(
      `SELECT clinical_order_id, controlled_movement_id, controlled_register_id,
              fulfilment_status
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
      controlled_movement_id: controlledMovementId,
      controlled_register_id: controlledRegisterId,
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
    const controlledLineage = await prisma.$queryRawUnsafe(
      `SELECT movement_link.movement_purpose, movement_link.quantity,
              movement_link.stock_movement_id, movement_link.controlled_register_id,
              movement.reference_id, register_entry.patient_uid
         FROM ward_indent_inventory_movement_links movement_link
         JOIN ward_indent_inventory_allocations allocation
           ON allocation.tenant_id = movement_link.tenant_id
          AND allocation.id = movement_link.allocation_id
         JOIN pharmacy_stock_movements movement
           ON movement.tenant_id = movement_link.tenant_id
          AND movement.id = movement_link.stock_movement_id
         JOIN pharmacy_schedule_register register_entry
           ON register_entry.tenant_id = movement_link.tenant_id
          AND register_entry.id = movement_link.controlled_register_id
        WHERE allocation.tenant_id = $1::uuid
          AND allocation.ward_indent_id = $2::int
          AND allocation.ward_indent_item_id = $3::int`,
      TENANT,
      Number(indent.id),
      Number(controlledLine.id),
    );
    expect(controlledLineage).toHaveLength(1);
    expect(controlledLineage[0]).toMatchObject({
      movement_purpose: 'issue',
      stock_movement_id: controlledMovementId,
      controlled_register_id: controlledRegisterId,
      reference_id: controlledLine.controlled_reference_id,
      patient_uid: PATIENT,
    });
    expect(Number(controlledLineage[0].quantity)).toBe(1);
  }, 60_000);

  test('atomically records statutory H1 handoff and return lineage without duplicate stock', async () => {
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

    const loadBatchStock = async () => Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      controlled.batchId,
    ))[0].remaining_quantity);
    const batchStockBefore = await loadBatchStock();
    const handoff = await recordWardIndentControlledHandoff({
      indentId: indent.id,
      recordedBy: PHARMACIST,
      itemEvidence: [{
        item_id: line.id,
      }],
      expectedVersion: 3,
      commandKey: `controlled-handoff-${RUN}`,
      tenantId: TENANT,
      actorRole: 'PHARMACY_INCHARGE',
    });
    expect(handoff.status).toBe('approved');
    expect(handoff.state_version).toBe(4);
    expect(handoff.workflow.pending_controlled_handoff_evidence).toEqual([]);
    const handedOffLine = handoff.items.find(item => Number(item.id) === Number(line.id));
    const issueMovementId = Number(handedOffLine.controlled_movement_id);
    const issueRegisterId = Number(handedOffLine.controlled_register_id);
    expect(issueMovementId).toBeGreaterThan(0);
    expect(issueRegisterId).toBeGreaterThan(0);
    const stockAfterHandoff = await loadBatchStock();
    expect(stockAfterHandoff).toBe(batchStockBefore - 2);

    const issued = await issueWardIndent({
      indentId: indent.id,
      issuedBy: PHARMACIST,
      expectedVersion: 4,
      commandKey: `controlled-issue-${RUN}`,
      tenantId: TENANT,
      actorRole: 'PHARMACY_INCHARGE',
    });
    expect(issued.status).toBe('issued');
    expect(issued.state_version).toBe(5);
    expect(await loadBatchStock()).toBe(stockAfterHandoff);
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

    const returnReference = `ward-indent-return:${indent.id}:item:${line.id}`;
    const loadReturnEffects = async () => (await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int
            FROM pharmacy_stock_movements movement
           WHERE movement.tenant_id = $1::uuid
             AND movement.reference_type = 'ward_indent_return'
             AND movement.reference_id = $3::text) AS movement_count,
         (SELECT COUNT(*)::int
            FROM pharmacy_schedule_register register_entry
            JOIN pharmacy_stock_movements movement
              ON movement.tenant_id = register_entry.tenant_id
             AND movement.id = register_entry.reference_movement_id
           WHERE movement.tenant_id = $1::uuid
             AND movement.reference_type = 'ward_indent_return'
             AND movement.reference_id = $3::text) AS register_count,
         (SELECT COUNT(*)::int
            FROM ward_indent_inventory_movement_links movement_link
            JOIN ward_indent_inventory_allocations allocation
              ON allocation.tenant_id = movement_link.tenant_id
             AND allocation.id = movement_link.allocation_id
           WHERE allocation.tenant_id = $1::uuid
             AND allocation.ward_indent_id = $2::int
             AND movement_link.movement_purpose = 'return') AS link_count,
         (SELECT remaining_quantity
            FROM pharmacy_inventory_batches
           WHERE tenant_id = $1::uuid AND id = $4::int) AS remaining_quantity`,
      TENANT,
      Number(indent.id),
      returnReference,
      controlled.batchId,
    ))[0];

    await expect(reconcileWardIndent({
      indentId: indent.id,
      reconciledBy: RECEIVER,
      reason: 'Rollback probe after automatic controlled return evidence',
      itemReconciliations: [{
        item_id: line.id,
        quantity_variance_resolved: 1,
        disposition: 'documented_exception',
        note: 'Intentional invalid variance proves controlled return rollback',
      }],
      expectedVersion: 7,
      commandKey: `controlled-return-rollback-${RUN}`,
      tenantId: TENANT,
    })).rejects.toMatchObject({
      statusCode: 400,
      message: `Item ${line.id} has no unresolved receipt variance`,
    });
    const rollbackState = await getWardIndent(indent.id, { tenantId: TENANT });
    expect(rollbackState).toMatchObject({ status: 'return_pending', state_version: 7 });
    const rollbackLine = rollbackState.items.find(item => Number(item.id) === Number(line.id));
    expect(rollbackLine.controlled_return_movement_id).toBeNull();
    expect(rollbackLine.controlled_return_register_id).toBeNull();
    const rollbackEffects = await loadReturnEffects();
    expect(rollbackEffects).toMatchObject({
      movement_count: 0,
      register_count: 0,
      link_count: 0,
    });
    expect(Number(rollbackEffects.remaining_quantity)).toBe(stockAfterHandoff);

    const reconcileInput = {
      indentId: indent.id,
      reconciledBy: RECEIVER,
      reason: 'Controlled return entered through governed ward reconciliation',
      expectedVersion: 7,
      commandKey: `controlled-reconcile-${RUN}`,
      tenantId: TENANT,
    };
    const reconciled = await reconcileWardIndent(reconcileInput);
    expect(reconciled.status).toBe('reconciled');
    expect(reconciled.state_version).toBe(8);
    const reconciledLine = reconciled.items.find(item => Number(item.id) === Number(line.id));
    const returnMovementId = Number(reconciledLine.controlled_return_movement_id);
    const returnRegisterId = Number(reconciledLine.controlled_return_register_id);
    expect(returnMovementId).toBeGreaterThan(0);
    expect(returnRegisterId).toBeGreaterThan(0);
    expect(reconciled.workflow.events[0].details.controlled_return_references).toEqual([{
      item_id: line.id,
      movement_id: returnMovementId,
      register_id: returnRegisterId,
    }]);

    const replayed = await reconcileWardIndent(reconcileInput);
    expect(replayed.state_version).toBe(8);
    expect(replayed.workflow.events.filter(event => event.action === 'reconciled')).toHaveLength(1);
    expect(replayed.items.find(item => Number(item.id) === Number(line.id))).toMatchObject({
      controlled_return_movement_id: returnMovementId,
      controlled_return_register_id: returnRegisterId,
    });

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
      state_version: 9,
      closure_outcome: 'returned_reconciled',
    });
    const evidence = await prisma.$queryRawUnsafe(
      `SELECT movement_link.movement_purpose,
              movement_link.quantity AS linked_quantity,
              movement_link.stock_movement_id,
              movement_link.controlled_register_id,
              allocation.inventory_batch_id,
              allocation.issued_quantity,
              allocation.received_quantity,
              allocation.returned_quantity,
              movement.movement_kind AS stock_movement_kind,
              movement.quantity_delta,
              movement.reference_type,
              movement.reference_id,
              movement.metadata->>'source_register_id' AS source_register_id,
              register_entry.movement_kind AS register_movement_kind,
              register_entry.quantity AS register_quantity,
              register_entry.running_balance,
              register_entry.patient_uid,
              register_entry.prescription_number,
              register_entry.prescriber_uid,
              batch.remaining_quantity
         FROM ward_indent_inventory_movement_links movement_link
         JOIN ward_indent_inventory_allocations allocation
           ON allocation.tenant_id = movement_link.tenant_id
          AND allocation.id = movement_link.allocation_id
         JOIN pharmacy_stock_movements movement
           ON movement.tenant_id = movement_link.tenant_id
          AND movement.id = movement_link.stock_movement_id
         JOIN pharmacy_schedule_register register_entry
           ON register_entry.tenant_id = movement_link.tenant_id
          AND register_entry.id = movement_link.controlled_register_id
         JOIN pharmacy_inventory_batches batch
           ON batch.tenant_id = allocation.tenant_id
          AND batch.id = allocation.inventory_batch_id
        WHERE allocation.tenant_id = $1::uuid
          AND allocation.ward_indent_id = $2::int
        ORDER BY movement_link.id`,
      TENANT,
      Number(indent.id),
    );
    expect(evidence).toHaveLength(2);
    expect(evidence.map(row => row.movement_purpose)).toEqual(['issue', 'return']);
    expect(evidence.map(row => Number(row.linked_quantity))).toEqual([2, 1]);
    expect(evidence.map(row => row.stock_movement_kind)).toEqual(['issue', 'return']);
    expect(evidence.map(row => Number(row.quantity_delta))).toEqual([-2, 1]);
    expect(evidence.map(row => row.register_movement_kind)).toEqual(['dispense', 'return']);
    expect(evidence.map(row => Number(row.register_quantity))).toEqual([2, 1]);
    expect(evidence.map(row => Number(row.inventory_batch_id)))
      .toEqual([controlled.batchId, controlled.batchId]);
    expect(evidence.every((row) => row.patient_uid === PATIENT)).toBe(true);
    expect(evidence.map(row => row.reference_type))
      .toEqual(['controlled_dispense', 'ward_indent_return']);
    expect(evidence.map(row => row.reference_id))
      .toEqual([line.controlled_reference_id, returnReference]);
    expect(Number(evidence[0].stock_movement_id)).toBe(issueMovementId);
    expect(Number(evidence[0].controlled_register_id)).toBe(issueRegisterId);
    expect(Number(evidence[1].stock_movement_id)).toBe(returnMovementId);
    expect(Number(evidence[1].controlled_register_id)).toBe(returnRegisterId);
    expect(Number(evidence[1].source_register_id)).toBe(issueRegisterId);
    expect(evidence[1].prescription_number).toBe(evidence[0].prescription_number);
    expect(evidence[1].prescriber_uid).toBe(evidence[0].prescriber_uid);
    expect(evidence[1].prescriber_uid).toBe(DOCTOR);
    expect(Number(evidence[0].running_balance)).toBe(stockAfterHandoff);
    expect(Number(evidence[1].running_balance)).toBe(batchStockBefore - 1);
    expect(Number(evidence[1].issued_quantity)).toBe(2);
    expect(Number(evidence[1].received_quantity)).toBe(2);
    expect(Number(evidence[1].returned_quantity)).toBe(1);
    expect(Number(evidence[1].remaining_quantity)).toBe(batchStockBefore - 1);
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
    const stockBeforeHandoff = Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      controlled.batchId,
    ))[0].remaining_quantity);
    const handoff = await recordWardIndentControlledHandoff({
      indentId: indent.id,
      recordedBy: PHARMACIST,
      itemEvidence: [{ item_id: line.id }],
      expectedVersion: approval.state_version,
      commandKey: `controlled-custody-handoff-${RUN}`,
      tenantId: TENANT,
      actorRole: 'PHARMACY_INCHARGE',
    });
    expect(handoff.status).toBe('approved');
    expect(handoff.state_version).toBe(4);
    const handedOffLine = handoff.items.find(item => Number(item.id) === Number(line.id));
    const controlledMovementId = Number(handedOffLine.controlled_movement_id);
    const controlledRegisterId = Number(handedOffLine.controlled_register_id);
    expect(controlledMovementId).toBeGreaterThan(0);
    expect(controlledRegisterId).toBeGreaterThan(0);
    const stockAfterHandoff = Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      controlled.batchId,
    ))[0].remaining_quantity);
    expect(stockAfterHandoff).toBe(stockBeforeHandoff - 1);

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
      actorRole: 'PHARMACY_INCHARGE',
    });
    expect(issued.status).toBe('issued');
    expect(issued.state_version).toBe(5);
    expect(Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      controlled.batchId,
    ))[0].remaining_quantity)).toBe(stockAfterHandoff);
    const custodyLineage = await prisma.$queryRawUnsafe(
      `SELECT movement_link.movement_purpose, movement_link.quantity,
              movement_link.stock_movement_id, movement_link.controlled_register_id,
              movement.reference_id, register_entry.patient_uid
         FROM ward_indent_inventory_movement_links movement_link
         JOIN ward_indent_inventory_allocations allocation
           ON allocation.tenant_id = movement_link.tenant_id
          AND allocation.id = movement_link.allocation_id
         JOIN pharmacy_stock_movements movement
           ON movement.tenant_id = movement_link.tenant_id
          AND movement.id = movement_link.stock_movement_id
         JOIN pharmacy_schedule_register register_entry
           ON register_entry.tenant_id = movement_link.tenant_id
          AND register_entry.id = movement_link.controlled_register_id
        WHERE allocation.tenant_id = $1::uuid
          AND allocation.ward_indent_id = $2::int`,
      TENANT,
      Number(indent.id),
    );
    expect(custodyLineage).toHaveLength(1);
    expect(custodyLineage[0]).toMatchObject({
      movement_purpose: 'issue',
      stock_movement_id: controlledMovementId,
      controlled_register_id: controlledRegisterId,
      reference_id: line.controlled_reference_id,
      patient_uid: OTHER_PATIENT,
    });
    expect(Number(custodyLineage[0].quantity)).toBe(1);
    const discharge = await admissionService.markForDischarge(
      admission.admissionId,
      REQUESTER,
      'IP_STAFF_NURSE',
      { tenantId: TENANT },
    );
    expect(Number(discharge.admission.id)).toBe(admission.admissionId);
    const closedAdmission = (await prisma.$queryRawUnsafe(
      `SELECT billing_closed_at, discharge_initiated_at
         FROM admissions
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      admission.admissionId,
    ))[0];
    expect(closedAdmission.billing_closed_at).toBeTruthy();
    expect(closedAdmission.discharge_initiated_at).toBeTruthy();
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

  test('migration rejects a patientless statutory entry for a governed controlled handoff', async () => {
    const indent = await createControlledMedicationIndent({
      quantity: 1,
      key: 'patientless-ddl',
    });
    const reserved = await reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACIST,
      expectedVersion: indent.state_version,
      commandKey: `patientless-ddl-reserve-${RUN}`,
      tenantId: TENANT,
    });
    const approval = await approveWardIndent({
      indentId: indent.id,
      approvedBy: PHARMACIST,
      expectedVersion: reserved.state_version,
      commandKey: `patientless-ddl-approve-${RUN}`,
      tenantId: TENANT,
    });
    const line = approval.items[0];
    const handoff = await recordWardIndentControlledHandoff({
      indentId: indent.id,
      recordedBy: PHARMACIST,
      itemEvidence: [{ item_id: line.id }],
      expectedVersion: approval.state_version,
      commandKey: `patientless-ddl-handoff-${RUN}`,
      tenantId: TENANT,
      actorRole: 'PHARMACY_INCHARGE',
    });
    const handedOffLine = handoff.items.find(item => Number(item.id) === Number(line.id));
    const movementId = Number(handedOffLine.controlled_movement_id);
    const registerId = Number(handedOffLine.controlled_register_id);
    expect(handoff).toMatchObject({ status: 'approved', state_version: 4 });
    expect(line.controlled_reference_id)
      .toBe(`ward-indent:${indent.id}:item:${line.id}`);
    expect(movementId).toBeGreaterThan(0);
    expect(registerId).toBeGreaterThan(0);

    let failure;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO pharmacy_schedule_register
           (tenant_id, inventory_item_id, inventory_batch_id, schedule_class,
            movement_kind, quantity, unit_label, running_balance,
            patient_uid, patient_name, patient_phone,
            prescription_id, prescription_number,
            prescriber_uid, prescriber_name, prescriber_registration,
            performed_by, performed_by_name, witness_uid, witness_name,
            reference_movement_id, notes)
         SELECT tenant_id, inventory_item_id, inventory_batch_id, schedule_class,
                movement_kind, quantity, unit_label, running_balance,
                NULL::uuid, patient_name, patient_phone,
                prescription_id, prescription_number,
                prescriber_uid, prescriber_name, prescriber_registration,
                performed_by, performed_by_name, witness_uid, witness_name,
                reference_movement_id, notes
           FROM pharmacy_schedule_register
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        TENANT,
        registerId,
      );
    } catch (error) {
      failure = error;
    }
    expect(sqlState(failure)).toBe('23514');
    expect(databaseMessage(failure))
      .toMatch(/chk_controlled_ward_dispense_patient_required|patient-linked statutory register/i);
    const patientGuardEffects = (await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int
            FROM pharmacy_stock_movements movement
           WHERE movement.tenant_id = $1::uuid
             AND movement.reference_type = 'controlled_dispense'
             AND movement.reference_id = $4::text) AS movement_count,
         (SELECT COUNT(*)::int
            FROM pharmacy_schedule_register register_entry
            JOIN pharmacy_stock_movements movement
              ON movement.tenant_id = register_entry.tenant_id
             AND movement.id = register_entry.reference_movement_id
           WHERE movement.tenant_id = $1::uuid
             AND movement.reference_type = 'controlled_dispense'
             AND movement.reference_id = $4::text) AS register_count,
         (SELECT COUNT(*)::int
            FROM ward_indent_inventory_movement_links movement_link
            JOIN ward_indent_inventory_allocations allocation
              ON allocation.tenant_id = movement_link.tenant_id
             AND allocation.id = movement_link.allocation_id
           WHERE allocation.tenant_id = $1::uuid
             AND allocation.ward_indent_id = $2::int
             AND allocation.ward_indent_item_id = $3::int
             AND movement_link.movement_purpose = 'issue') AS link_count`,
      TENANT,
      Number(indent.id),
      Number(line.id),
      line.controlled_reference_id,
    ))[0];
    expect(patientGuardEffects).toEqual({
      movement_count: 1,
      register_count: 1,
      link_count: 1,
    });
    const afterRejectedEntry = await getWardIndent(indent.id, { tenantId: TENANT });
    expect(afterRejectedEntry).toMatchObject({ status: 'approved', state_version: 4 });
    expect(afterRejectedEntry.items.find(
      item => Number(item.id) === Number(line.id)
    )).toMatchObject({
      controlled_movement_id: movementId,
      controlled_register_id: registerId,
    });
    expect(afterRejectedEntry.workflow.events.filter(
      event => event.action === 'controlled_handoff_recorded'
    )).toHaveLength(1);
    const preservedLineage = await prisma.$queryRawUnsafe(
      `SELECT movement_link.movement_purpose, movement_link.stock_movement_id,
              movement_link.controlled_register_id, register_entry.patient_uid
         FROM ward_indent_inventory_movement_links movement_link
         JOIN ward_indent_inventory_allocations allocation
           ON allocation.tenant_id = movement_link.tenant_id
          AND allocation.id = movement_link.allocation_id
         JOIN pharmacy_schedule_register register_entry
           ON register_entry.tenant_id = movement_link.tenant_id
          AND register_entry.id = movement_link.controlled_register_id
        WHERE allocation.tenant_id = $1::uuid
          AND allocation.ward_indent_id = $2::int`,
      TENANT,
      Number(indent.id),
    );
    expect(preservedLineage).toEqual([expect.objectContaining({
      movement_purpose: 'issue',
      stock_movement_id: movementId,
      controlled_register_id: registerId,
      patient_uid: PATIENT,
    })]);
  }, 60_000);

  test('prevents ambiguous controlled handoff through one replayable exact lineage', async () => {
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
    const pending = await getWardIndent(indent.id, { tenantId: TENANT });
    expect(pending.workflow.pending_controlled_handoff_evidence).toEqual([{
      item_id: line.id,
      reference_id: line.controlled_reference_id,
      status: 'missing',
      candidate_count: 0,
      same_reference_movement_count: 0,
    }]);
    const stockBefore = Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      controlled.batchId,
    ))[0].remaining_quantity);
    const handoffInput = {
      indentId: indent.id,
      recordedBy: PHARMACIST,
      itemEvidence: [{ item_id: line.id }],
      expectedVersion: approval.state_version,
      commandKey: `ambiguous-handoff-${RUN}`,
      tenantId: TENANT,
      actorRole: 'PHARMACY_INCHARGE',
    };
    const handoff = await recordWardIndentControlledHandoff(handoffInput);
    const handedOffLine = handoff.items.find(item => Number(item.id) === Number(line.id));
    const movementId = Number(handedOffLine.controlled_movement_id);
    const registerId = Number(handedOffLine.controlled_register_id);
    expect(handoff).toMatchObject({ status: 'approved', state_version: 4 });
    expect(movementId).toBeGreaterThan(0);
    expect(registerId).toBeGreaterThan(0);

    const replayed = await recordWardIndentControlledHandoff(handoffInput);
    expect(replayed.state_version).toBe(handoff.state_version);
    expect(replayed.status).toBe('approved');
    expect(replayed.items.find(item => Number(item.id) === Number(line.id))).toMatchObject({
      controlled_movement_id: movementId,
      controlled_register_id: registerId,
    });
    await expect(recordWardIndentControlledHandoff({
      ...handoffInput,
      commandKey: `ambiguous-competing-handoff-${RUN}`,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'WARD_INDENT_INVALID_TRANSITION',
    });

    const afterCompetingCommand = await getWardIndent(indent.id, { tenantId: TENANT });
    expect(afterCompetingCommand).toMatchObject({ status: 'approved', state_version: 4 });
    expect(afterCompetingCommand.items.find(
      item => Number(item.id) === Number(line.id)
    )).toMatchObject({
      controlled_movement_id: movementId,
      controlled_register_id: registerId,
    });
    expect(afterCompetingCommand.workflow.events.filter(
      event => event.action === 'controlled_handoff_recorded'
    )).toHaveLength(1);

    const exactEffects = (await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int
            FROM pharmacy_stock_movements movement
           WHERE movement.tenant_id = $1::uuid
             AND movement.reference_type = 'controlled_dispense'
             AND movement.reference_id = $4::text) AS movement_count,
         (SELECT COUNT(*)::int
            FROM pharmacy_schedule_register register_entry
            JOIN pharmacy_stock_movements movement
              ON movement.tenant_id = register_entry.tenant_id
             AND movement.id = register_entry.reference_movement_id
           WHERE movement.tenant_id = $1::uuid
             AND movement.reference_type = 'controlled_dispense'
             AND movement.reference_id = $4::text) AS register_count,
         (SELECT COUNT(*)::int
            FROM ward_indent_inventory_movement_links movement_link
            JOIN ward_indent_inventory_allocations allocation
              ON allocation.tenant_id = movement_link.tenant_id
             AND allocation.id = movement_link.allocation_id
           WHERE allocation.tenant_id = $1::uuid
             AND allocation.ward_indent_id = $2::int
             AND allocation.ward_indent_item_id = $3::int
             AND movement_link.movement_purpose = 'issue') AS link_count`,
      TENANT,
      Number(indent.id),
      Number(line.id),
      line.controlled_reference_id,
    ))[0];
    expect(exactEffects).toEqual({
      movement_count: 1,
      register_count: 1,
      link_count: 1,
    });

    const exactLineage = await prisma.$queryRawUnsafe(
      `SELECT movement_link.movement_purpose, movement_link.quantity,
              movement_link.stock_movement_id, movement_link.controlled_register_id,
              movement.reference_type, movement.reference_id,
              register_entry.patient_uid
         FROM ward_indent_inventory_movement_links movement_link
         JOIN ward_indent_inventory_allocations allocation
           ON allocation.tenant_id = movement_link.tenant_id
          AND allocation.id = movement_link.allocation_id
         JOIN pharmacy_stock_movements movement
           ON movement.tenant_id = movement_link.tenant_id
          AND movement.id = movement_link.stock_movement_id
         JOIN pharmacy_schedule_register register_entry
           ON register_entry.tenant_id = movement_link.tenant_id
          AND register_entry.id = movement_link.controlled_register_id
        WHERE allocation.tenant_id = $1::uuid
          AND allocation.ward_indent_id = $2::int`,
      TENANT,
      Number(indent.id),
    );
    expect(exactLineage).toHaveLength(1);
    expect(exactLineage[0]).toMatchObject({
      movement_purpose: 'issue',
      stock_movement_id: movementId,
      controlled_register_id: registerId,
      reference_type: 'controlled_dispense',
      reference_id: line.controlled_reference_id,
      patient_uid: PATIENT,
    });
    expect(Number(exactLineage[0].quantity)).toBe(1);
    expect(Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      controlled.batchId,
    ))[0].remaining_quantity)).toBe(stockBefore - 1);
  }, 60_000);

  test('reconciles one valid historical controlled handoff without another stock movement', async () => {
    const indent = await createControlledMedicationIndent({
      quantity: 1,
      key: 'historical-unique',
    });
    const reserved = await reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACIST,
      expectedVersion: indent.state_version,
      commandKey: `historical-unique-reserve-${RUN}`,
      tenantId: TENANT,
    });
    const approval = await approveWardIndent({
      indentId: indent.id,
      approvedBy: PHARMACIST,
      expectedVersion: reserved.state_version,
      commandKey: `historical-unique-approve-${RUN}`,
      tenantId: TENANT,
    });
    const line = approval.items[0];
    const stockBefore = Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      controlled.batchId,
    ))[0].remaining_quantity);
    const [historicalEvidence] = await seedHistoricalControlledHandoffEvidence({
      referenceId: line.controlled_reference_id,
      quantity: 1,
      count: 1,
      key: line.id,
    });
    expect(Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      controlled.batchId,
    ))[0].remaining_quantity)).toBe(stockBefore - 1);

    const recoverable = await getWardIndent(indent.id, { tenantId: TENANT });
    expect(recoverable.workflow.pending_controlled_handoff_evidence).toEqual([
      expect.objectContaining({
        item_id: line.id,
        status: 'available',
        candidate_count: 1,
        same_reference_movement_count: 1,
        movement_id: historicalEvidence.movementId,
        register_id: historicalEvidence.registerId,
        evidence: [expect.objectContaining({
          movement_id: historicalEvidence.movementId,
          register_ids: [historicalEvidence.registerId],
          issues: [],
        })],
      }),
    ]);
    const recoverableEvidence = recoverable.workflow.pending_controlled_handoff_evidence[0];
    const freshHandoffInput = {
      indentId: indent.id,
      recordedBy: PHARMACIST,
      itemEvidence: [{ item_id: line.id }],
      expectedVersion: approval.state_version,
      commandKey: `historical-unique-unselected-${RUN}`,
      tenantId: TENANT,
      actorRole: 'PHARMACY_INCHARGE',
    };
    await expect(recordWardIndentControlledHandoff(freshHandoffInput)).rejects.toMatchObject({
      statusCode: 409,
      code: 'WARD_INDENT_CONTROLLED_RECOVERY_SELECTION_REQUIRED',
      details: {
        items: [expect.objectContaining({
          item_id: line.id,
          movement_id: historicalEvidence.movementId,
          register_id: historicalEvidence.registerId,
        })],
      },
    });

    const historicalRecovery = {
      movement_id: historicalEvidence.movementId,
      register_id: historicalEvidence.registerId,
      reason: 'Verified an upgraded pre-link dispense against exact statutory custody',
    };
    await expect(recordWardIndentControlledHandoff({
      ...freshHandoffInput,
      recordedBy: ADMIN,
      actorRole: 'ADMIN',
      commandKey: `historical-unique-admin-recovery-${RUN}`,
      itemEvidence: [{ item_id: line.id, historical_recovery: historicalRecovery }],
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'WARD_INDENT_PHARMACY_CUSTODY_ROLE_REQUIRED',
      details: {
        required_roles: ['PHARMACY_STAFF', 'PHARMACY_INCHARGE'],
      },
    });

    const handoff = await recordWardIndentControlledHandoff({
      indentId: indent.id,
      recordedBy: PHARMACIST,
      itemEvidence: [{ item_id: line.id, historical_recovery: historicalRecovery }],
      expectedVersion: approval.state_version,
      commandKey: `historical-unique-handoff-${RUN}`,
      tenantId: TENANT,
      actorRole: 'PHARMACY_INCHARGE',
    });
    expect(handoff).toMatchObject({ status: 'approved', state_version: 4 });
    expect(handoff.workflow.pending_controlled_handoff_evidence).toEqual([]);
    expect(handoff.items.find(item => Number(item.id) === Number(line.id))).toMatchObject({
      controlled_movement_id: historicalEvidence.movementId,
      controlled_register_id: historicalEvidence.registerId,
      quantity_issued: 1,
      fulfilment_status: 'controlled_handoff_recorded',
    });
    const handoffEvent = handoff.workflow.events.find(
      event => event.action === 'controlled_handoff_recorded'
    );
    expect(handoffEvent.details).toMatchObject({
      controlled_item_count: 1,
      recovered_controlled_item_count: 1,
      created_controlled_item_count: 0,
      controlled_recovery_receipts: [expect.objectContaining({
        contract: 'ward_controlled_handoff_recovery_v1',
        disposition: 'historical_exact_pair_linked',
        ward_indent_id: indent.id,
        ward_indent_item_id: line.id,
        allocation_id: recoverableEvidence.allocation_id,
        movement_id: historicalEvidence.movementId,
        register_id: historicalEvidence.registerId,
        reference_id: line.controlled_reference_id,
        facility_id: facilityId,
        inventory_item_id: controlled.inventoryItemId,
        inventory_batch_id: controlled.batchId,
        catalog_id: controlled.catalogId,
        quantity: 1,
        patient_uid: PATIENT,
        recovered_by: PHARMACIST,
        recovered_by_role: 'PHARMACY_INCHARGE',
        recovery_reason: historicalRecovery.reason,
        receipt_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      })],
    });
    const recoveryReceipt = handoffEvent.details.controlled_recovery_receipts[0];
    const { receipt_sha256: receiptSha256, ...receiptPayload } = recoveryReceipt;
    expect(receiptSha256).toBe(pharmacyCommandRequestSha256(receiptPayload));
    expect(Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      controlled.batchId,
    ))[0].remaining_quantity)).toBe(stockBefore - 1);

    const lineage = await prisma.$queryRawUnsafe(
      `SELECT movement_link.stock_movement_id, movement_link.controlled_register_id,
              movement_link.movement_purpose, movement_link.quantity,
              allocation.issued_quantity, allocation.status AS allocation_status,
              movement.reference_type, movement.reference_id,
              register_entry.patient_uid
         FROM ward_indent_inventory_movement_links movement_link
         JOIN ward_indent_inventory_allocations allocation
           ON allocation.tenant_id = movement_link.tenant_id
          AND allocation.id = movement_link.allocation_id
         JOIN pharmacy_stock_movements movement
           ON movement.tenant_id = movement_link.tenant_id
          AND movement.id = movement_link.stock_movement_id
         JOIN pharmacy_schedule_register register_entry
           ON register_entry.tenant_id = movement_link.tenant_id
          AND register_entry.id = movement_link.controlled_register_id
        WHERE allocation.tenant_id = $1::uuid
          AND allocation.ward_indent_id = $2::int
          AND allocation.ward_indent_item_id = $3::int`,
      TENANT,
      Number(indent.id),
      Number(line.id),
    );
    expect(lineage).toHaveLength(1);
    expect(lineage[0]).toMatchObject({
      stock_movement_id: historicalEvidence.movementId,
      controlled_register_id: historicalEvidence.registerId,
      movement_purpose: 'issue',
      allocation_status: 'issued',
      reference_type: 'controlled_dispense',
      reference_id: line.controlled_reference_id,
      patient_uid: PATIENT,
    });
    expect(Number(lineage[0].quantity)).toBe(1);
    expect(Number(lineage[0].issued_quantity)).toBe(1);
  }, 60_000);

  test('keeps duplicate historical controlled custody behind external reconciliation', async () => {
    const indent = await createControlledMedicationIndent({
      quantity: 1,
      key: 'historical-ambiguous',
    });
    const reserved = await reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACIST,
      expectedVersion: indent.state_version,
      commandKey: `historical-ambiguous-reserve-${RUN}`,
      tenantId: TENANT,
    });
    const approval = await approveWardIndent({
      indentId: indent.id,
      approvedBy: PHARMACIST,
      expectedVersion: reserved.state_version,
      commandKey: `historical-ambiguous-approve-${RUN}`,
      tenantId: TENANT,
    });
    const line = approval.items[0];
    expect(approval).toMatchObject({
      status: 'controlled_handoff_required',
      state_version: 3,
    });
    const stockBefore = Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      controlled.batchId,
    ))[0].remaining_quantity);

    const historicalEvidence = await seedHistoricalControlledHandoffEvidence({
      referenceId: line.controlled_reference_id,
      quantity: 1,
      count: 2,
      key: line.id,
    });
    expect(historicalEvidence).toHaveLength(2);
    expect(new Set(historicalEvidence.map(entry => entry.movementId)).size).toBe(2);
    expect(new Set(historicalEvidence.map(entry => entry.registerId)).size).toBe(2);

    const historical = await getWardIndent(indent.id, { tenantId: TENANT });
    expect(historical).toMatchObject({
      status: 'controlled_handoff_required',
      state_version: 3,
    });
    expect(historical.items.find(item => Number(item.id) === Number(line.id))).toMatchObject({
      controlled_movement_id: null,
      controlled_register_id: null,
      quantity_issued: 0,
    });
    expect(historical.workflow.events.filter(
      event => event.action === 'controlled_handoff_recorded'
    )).toHaveLength(0);
    expect(historical.workflow.pending_controlled_handoff_evidence).toEqual([
      expect.objectContaining({
        item_id: line.id,
        status: 'corrupt',
        candidate_count: 2,
        same_reference_movement_count: 2,
        evidence: expect.arrayContaining(historicalEvidence.map((entry) => (
          expect.objectContaining({
            movement_id: entry.movementId,
            register_ids: [entry.registerId],
            issues: expect.arrayContaining(['SAME_REFERENCE_MOVEMENT_COLLISION']),
          })
        ))),
      }),
    ]);

    await expect(recordWardIndentControlledHandoff({
      indentId: indent.id,
      recordedBy: PHARMACIST,
      itemEvidence: [{
        item_id: line.id,
        historical_recovery: {
          movement_id: historicalEvidence[0].movementId,
          register_id: historicalEvidence[0].registerId,
          reason: 'Attempted exact selection must not hide a duplicate stock decrement',
        },
      }],
      expectedVersion: approval.state_version,
      commandKey: `historical-ambiguous-handoff-${RUN}`,
      tenantId: TENANT,
      actorRole: 'PHARMACY_INCHARGE',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'WARD_INDENT_CONTROLLED_CUSTODY_RECONCILIATION_REQUIRED',
      details: {
        reconciliation_gate: 'external_controlled_custody_reconciliation_required',
        items: [expect.objectContaining({
          item_id: line.id,
          status: 'corrupt',
          same_reference_movement_count: 2,
        })],
      },
    });
    const afterRejectedHandoff = await getWardIndent(indent.id, { tenantId: TENANT });
    expect(afterRejectedHandoff).toMatchObject({
      status: 'controlled_handoff_required',
      state_version: 3,
    });
    expect(afterRejectedHandoff.items.find(
      item => Number(item.id) === Number(line.id)
    )).toMatchObject({
      controlled_movement_id: null,
      controlled_register_id: null,
      quantity_issued: 0,
    });
    expect(afterRejectedHandoff.workflow.events.filter(
      event => event.action === 'controlled_handoff_recorded'
    )).toHaveLength(0);
    expect(afterRejectedHandoff.workflow.pending_controlled_handoff_evidence).toEqual([
      expect.objectContaining({
        item_id: line.id,
        status: 'corrupt',
        candidate_count: 2,
        same_reference_movement_count: 2,
      }),
    ]);

    const evidenceRows = await prisma.$queryRawUnsafe(
      `SELECT movement.id AS movement_id, register_entry.id AS register_id,
              movement.quantity_delta, register_entry.quantity AS register_quantity,
              movement.reference_type, movement.reference_id,
              register_entry.patient_uid,
              (SELECT COUNT(*)::int
                 FROM ward_indent_inventory_movement_links movement_link
                WHERE movement_link.tenant_id = movement.tenant_id
                  AND movement_link.stock_movement_id = movement.id) AS link_count
         FROM pharmacy_stock_movements movement
         JOIN pharmacy_schedule_register register_entry
           ON register_entry.tenant_id = movement.tenant_id
          AND register_entry.reference_movement_id = movement.id
        WHERE movement.tenant_id = $1::uuid
          AND movement.reference_type = 'controlled_dispense'
          AND movement.reference_id = $2::text
        ORDER BY movement.id`,
      TENANT,
      line.controlled_reference_id,
    );
    expect(evidenceRows).toHaveLength(2);
    expect(evidenceRows.map(row => Number(row.movement_id)))
      .toEqual(historicalEvidence.map(entry => entry.movementId));
    expect(evidenceRows.map(row => Number(row.register_id)))
      .toEqual(historicalEvidence.map(entry => entry.registerId));
    expect(evidenceRows.every(row => Number(row.quantity_delta) === -1)).toBe(true);
    expect(evidenceRows.every(row => Number(row.register_quantity) === 1)).toBe(true);
    expect(evidenceRows.every(row => row.reference_type === 'controlled_dispense')).toBe(true);
    expect(evidenceRows.every(row => row.reference_id === line.controlled_reference_id)).toBe(true);
    expect(evidenceRows.every(row => row.patient_uid === PATIENT)).toBe(true);
    expect(evidenceRows.every(row => Number(row.link_count) === 0)).toBe(true);
    expect(Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      controlled.batchId,
    ))[0].remaining_quantity)).toBe(stockBefore - 2);
  }, 60_000);

  test('does not turn a wrong-patient historical reference into a second decrement', async () => {
    const indent = await createControlledMedicationIndent({
      quantity: 1,
      key: 'historical-wrong-patient',
    });
    const reserved = await reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACIST,
      expectedVersion: indent.state_version,
      commandKey: `historical-wrong-patient-reserve-${RUN}`,
      tenantId: TENANT,
    });
    const approval = await approveWardIndent({
      indentId: indent.id,
      approvedBy: PHARMACIST,
      expectedVersion: reserved.state_version,
      commandKey: `historical-wrong-patient-approve-${RUN}`,
      tenantId: TENANT,
    });
    const line = approval.items[0];
    const stockBefore = Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      controlled.batchId,
    ))[0].remaining_quantity);
    const [malformed] = await seedHistoricalControlledHandoffEvidence({
      referenceId: line.controlled_reference_id,
      quantity: 1,
      count: 1,
      key: `wrong-patient-${line.id}`,
      patientUid: OTHER_PATIENT,
    });

    const classified = await getWardIndent(indent.id, { tenantId: TENANT });
    expect(classified.workflow.pending_controlled_handoff_evidence).toEqual([
      expect.objectContaining({
        item_id: line.id,
        status: 'corrupt',
        candidate_count: 0,
        same_reference_movement_count: 1,
        evidence: [expect.objectContaining({
          movement_id: malformed.movementId,
          register_ids: [malformed.registerId],
          issues: expect.arrayContaining(['REGISTER_PATIENT_MISMATCH']),
          registers: [expect.objectContaining({
            register_id: malformed.registerId,
            patient_uid: OTHER_PATIENT,
          })],
        })],
      }),
    ]);
    await expect(recordWardIndentControlledHandoff({
      indentId: indent.id,
      recordedBy: PHARMACIST,
      itemEvidence: [{ item_id: line.id }],
      expectedVersion: approval.state_version,
      commandKey: `historical-wrong-patient-handoff-${RUN}`,
      tenantId: TENANT,
      actorRole: 'PHARMACY_INCHARGE',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'WARD_INDENT_CONTROLLED_CUSTODY_RECONCILIATION_REQUIRED',
      details: {
        items: [expect.objectContaining({
          item_id: line.id,
          status: 'corrupt',
          evidence: [expect.objectContaining({
            movement_id: malformed.movementId,
            register_ids: [malformed.registerId],
          })],
        })],
      },
    });
    const after = await getWardIndent(indent.id, { tenantId: TENANT });
    expect(after).toMatchObject({
      status: 'controlled_handoff_required',
      state_version: approval.state_version,
    });
    expect(after.workflow.events.filter(
      event => event.action === 'controlled_handoff_recorded'
    )).toHaveLength(0);
    expect(Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      controlled.batchId,
    ))[0].remaining_quantity)).toBe(stockBefore - 1);
  }, 60_000);

  test('keeps null and wrong-facility historical registers behind reconciliation', async () => {
    const indent = await createControlledMedicationIndent({
      quantity: 1,
      key: 'historical-register-facility',
    });
    const reserved = await reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACIST,
      expectedVersion: indent.state_version,
      commandKey: `historical-register-facility-reserve-${RUN}`,
      tenantId: TENANT,
    });
    const approval = await approveWardIndent({
      indentId: indent.id,
      approvedBy: PHARMACIST,
      expectedVersion: reserved.state_version,
      commandKey: `historical-register-facility-approve-${RUN}`,
      tenantId: TENANT,
    });
    const line = approval.items[0];
    const stockBefore = Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      controlled.batchId,
    ))[0].remaining_quantity);
    const [malformed] = await seedHistoricalControlledHandoffEvidence({
      referenceId: line.controlled_reference_id,
      quantity: 1,
      count: 1,
      key: `register-facility-${line.id}`,
    });
    const wrongFacilityId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO facilities
         (tenant_id, facility_code, display_name, status, is_default)
       VALUES ($1::uuid, $2::text, $3::text, 'active', FALSE)
       RETURNING id`,
      TENANT,
      `MED01-WRONG-FACILITY-${RUN}`.slice(0, 80),
      `MED-01 wrong facility ${RUN}`.slice(0, 255),
    ))[0].id);

    for (const [label, registerFacilityId] of [
      ['null', null],
      ['wrong', wrongFacilityId],
    ]) {
      await rewriteHistoricalRegisterFacilityForFixture(
        malformed.registerId,
        registerFacilityId,
      );
      const classified = await getWardIndent(indent.id, { tenantId: TENANT });
      expect(classified.workflow.pending_controlled_handoff_evidence).toEqual([
        expect.objectContaining({
          item_id: line.id,
          status: 'corrupt',
          candidate_count: 0,
          same_reference_movement_count: 1,
          evidence: [expect.objectContaining({
            movement_id: malformed.movementId,
            register_ids: [malformed.registerId],
            issues: expect.arrayContaining(['REGISTER_FACILITY_MISMATCH']),
            registers: [expect.objectContaining({
              register_id: malformed.registerId,
              facility_id: registerFacilityId,
            })],
          })],
        }),
      ]);
      await expect(recordWardIndentControlledHandoff({
        indentId: indent.id,
        recordedBy: PHARMACIST,
        itemEvidence: [{ item_id: line.id }],
        expectedVersion: approval.state_version,
        commandKey: `historical-register-${label}-facility-handoff-${RUN}`,
        tenantId: TENANT,
        actorRole: 'PHARMACY_INCHARGE',
      })).rejects.toMatchObject({
        statusCode: 409,
        code: 'WARD_INDENT_CONTROLLED_CUSTODY_RECONCILIATION_REQUIRED',
        details: {
          reconciliation_gate: 'external_controlled_custody_reconciliation_required',
          items: [expect.objectContaining({
            item_id: line.id,
            status: 'corrupt',
            evidence: [expect.objectContaining({
              movement_id: malformed.movementId,
              register_ids: [malformed.registerId],
              issues: expect.arrayContaining(['REGISTER_FACILITY_MISMATCH']),
            })],
          })],
        },
      });
      const after = await getWardIndent(indent.id, { tenantId: TENANT });
      expect(after).toMatchObject({
        status: 'controlled_handoff_required',
        state_version: approval.state_version,
      });
      expect(after.items[0]).toMatchObject({
        controlled_movement_id: null,
        controlled_register_id: null,
        quantity_issued: 0,
      });
      expect(after.workflow.events.filter(
        event => event.action === 'controlled_handoff_recorded'
      )).toHaveLength(0);
      expect(Number((await prisma.$queryRawUnsafe(
        `SELECT remaining_quantity
           FROM pharmacy_inventory_batches
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        TENANT,
        controlled.batchId,
      ))[0].remaining_quantity)).toBe(stockBefore - 1);
    }
  }, 60_000);

  test('classifies mixed prelinked and unlinked pending lines without a second decrement', async () => {
    const indent = await createControlledMedicationIndent({
      quantity: 1,
      lineCount: 2,
      key: 'historical-prelinked-pending',
    });
    const reserved = await reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACIST,
      expectedVersion: indent.state_version,
      commandKey: `historical-prelinked-pending-reserve-${RUN}`,
      tenantId: TENANT,
    });
    const approval = await approveWardIndent({
      indentId: indent.id,
      approvedBy: PHARMACIST,
      expectedVersion: reserved.state_version,
      commandKey: `historical-prelinked-pending-approve-${RUN}`,
      tenantId: TENANT,
    });
    const [prelinkedLine, unlinkedLine] = approval.items;
    const stockBefore = Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      controlled.batchId,
    ))[0].remaining_quantity);
    const [prelinked] = await seedHistoricalControlledHandoffEvidence({
      referenceId: prelinkedLine.controlled_reference_id,
      quantity: 1,
      count: 1,
      key: `prelinked-pending-${prelinkedLine.id}`,
    });
    await prisma.ward_indent_items.update({
      where: { id: Number(prelinkedLine.id) },
      data: {
        controlled_movement_id: prelinked.movementId,
        controlled_register_id: prelinked.registerId,
        updated_at: new Date(),
      },
    });

    const classified = await getWardIndent(indent.id, { tenantId: TENANT });
    expect(classified.workflow.pending_controlled_handoff_evidence).toEqual([
      expect.objectContaining({
        item_id: prelinkedLine.id,
        status: 'corrupt',
        candidate_count: 0,
        same_reference_movement_count: 1,
        controlled_movement_id: prelinked.movementId,
        controlled_register_id: prelinked.registerId,
        issues: ['WARD_ITEM_PRELINKED_IN_PENDING_STATE'],
        evidence: [expect.objectContaining({
          movement_id: prelinked.movementId,
          register_ids: [prelinked.registerId],
          controlled_movement_id: prelinked.movementId,
          controlled_register_id: prelinked.registerId,
          claimed_ward_indent_items: [{
            ward_indent_id: indent.id,
            ward_indent_item_id: prelinkedLine.id,
          }],
          issues: expect.arrayContaining([
            'EVIDENCE_ALREADY_CLAIMED',
            'WARD_ITEM_PRELINKED_IN_PENDING_STATE',
          ]),
        })],
      }),
      expect.objectContaining({
        item_id: unlinkedLine.id,
        reference_id: unlinkedLine.controlled_reference_id,
        status: 'missing',
        candidate_count: 0,
        same_reference_movement_count: 0,
      }),
    ]);
    await expect(recordWardIndentControlledHandoff({
      indentId: indent.id,
      recordedBy: PHARMACIST,
      itemEvidence: [
        { item_id: prelinkedLine.id },
        { item_id: unlinkedLine.id },
      ],
      expectedVersion: approval.state_version,
      commandKey: `historical-prelinked-pending-handoff-${RUN}`,
      tenantId: TENANT,
      actorRole: 'PHARMACY_INCHARGE',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'WARD_INDENT_CONTROLLED_CUSTODY_RECONCILIATION_REQUIRED',
    });
    const after = await getWardIndent(indent.id, { tenantId: TENANT });
    expect(after).toMatchObject({
      status: 'controlled_handoff_required',
      state_version: approval.state_version,
    });
    expect(after.items.find(
      item => Number(item.id) === Number(prelinkedLine.id)
    )).toMatchObject({
      controlled_movement_id: prelinked.movementId,
      controlled_register_id: prelinked.registerId,
      quantity_issued: 0,
    });
    expect(after.items.find(
      item => Number(item.id) === Number(unlinkedLine.id)
    )).toMatchObject({
      controlled_movement_id: null,
      controlled_register_id: null,
      quantity_issued: 0,
    });
    expect(Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      controlled.batchId,
    ))[0].remaining_quantity)).toBe(stockBefore - 1);
  }, 60_000);

  test('does not relink a same-reference pair already claimed by another ward item', async () => {
    const indent = await createControlledMedicationIndent({
      quantity: 1,
      key: 'historical-claimed-target',
    });
    const reserved = await reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACIST,
      expectedVersion: indent.state_version,
      commandKey: `historical-claimed-target-reserve-${RUN}`,
      tenantId: TENANT,
    });
    const approval = await approveWardIndent({
      indentId: indent.id,
      approvedBy: PHARMACIST,
      expectedVersion: reserved.state_version,
      commandKey: `historical-claimed-target-approve-${RUN}`,
      tenantId: TENANT,
    });
    const line = approval.items[0];
    const stockBefore = Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      controlled.batchId,
    ))[0].remaining_quantity);
    const [claimedEvidence] = await seedHistoricalControlledHandoffEvidence({
      referenceId: line.controlled_reference_id,
      quantity: 1,
      count: 1,
      key: `claimed-${line.id}`,
    });
    const claimant = await createControlledMedicationIndent({
      quantity: 1,
      key: 'historical-claimant',
    });
    const claimantReserved = await reserveWardIndent({
      indentId: claimant.id,
      reservedBy: PHARMACIST,
      expectedVersion: claimant.state_version,
      commandKey: `historical-claimant-reserve-${RUN}`,
      tenantId: TENANT,
    });
    const claimantApproval = await approveWardIndent({
      indentId: claimant.id,
      approvedBy: PHARMACIST,
      expectedVersion: claimantReserved.state_version,
      commandKey: `historical-claimant-approve-${RUN}`,
      tenantId: TENANT,
    });
    const claimantLine = claimantApproval.items[0];
    await prisma.ward_indent_items.update({
      where: { id: Number(claimantLine.id) },
      data: {
        controlled_movement_id: claimedEvidence.movementId,
        controlled_register_id: claimedEvidence.registerId,
        updated_at: new Date(),
      },
    });

    const classified = await getWardIndent(indent.id, { tenantId: TENANT });
    expect(classified.workflow.pending_controlled_handoff_evidence).toEqual([
      expect.objectContaining({
        item_id: line.id,
        status: 'corrupt',
        candidate_count: 0,
        same_reference_movement_count: 1,
        evidence: [expect.objectContaining({
          movement_id: claimedEvidence.movementId,
          register_ids: [claimedEvidence.registerId],
          issues: expect.arrayContaining(['EVIDENCE_ALREADY_CLAIMED']),
          claimed_ward_indent_items: [{
            ward_indent_id: claimant.id,
            ward_indent_item_id: claimantLine.id,
          }],
        })],
      }),
    ]);
    await expect(recordWardIndentControlledHandoff({
      indentId: indent.id,
      recordedBy: PHARMACIST,
      itemEvidence: [{
        item_id: line.id,
        historical_recovery: {
          movement_id: claimedEvidence.movementId,
          register_id: claimedEvidence.registerId,
          reason: 'Claim collision must remain externally reconcilable',
        },
      }],
      expectedVersion: approval.state_version,
      commandKey: `historical-claimed-target-handoff-${RUN}`,
      tenantId: TENANT,
      actorRole: 'PHARMACY_INCHARGE',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'WARD_INDENT_CONTROLLED_CUSTODY_RECONCILIATION_REQUIRED',
    });
    expect(Number((await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      controlled.batchId,
    ))[0].remaining_quantity)).toBe(stockBefore - 1);
    expect((await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS link_count
         FROM ward_indent_inventory_movement_links movement_link
        WHERE movement_link.tenant_id = $1::uuid
          AND movement_link.stock_movement_id = $2::int`,
      TENANT,
      claimedEvidence.movementId,
    ))[0].link_count).toBe(0);
  }, 60_000);

  test('pages every open indent and finds overdue work beyond the first 200 rows', async () => {
    const pageWardId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO wards (tenant_id, facility_id, name, total_beds, created_at, updated_at)
       VALUES ($1::uuid, $3::int, $2, 10, NOW(), NOW()) RETURNING id`,
      TENANT,
      `MED-02 Pagination Ward ${RUN}`,
      facilityId,
    ))[0].id);
    const inserted = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO ward_indents
           (tenant_id, indent_number, ward_id, ward_name, facility_id,
            indent_type, status,
            requested_by, requested_at, patient_uid, owner_role_codes,
            active_sla_source_id, last_transition_at, created_at, updated_at)
         SELECT $1::uuid,
                $2 || '-' || sequence::text,
                $3::int,
                'MED-02 Pagination Ward',
                $7::int,
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
        facilityId,
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
