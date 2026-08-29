import { randomUUID } from 'node:crypto';

import {
  approveWardIndent,
  createWardIndent,
  issueWardIndent,
  receiveWardIndent,
  reserveWardIndent,
} from '../../services/ipd/ipdSupportService.js';
import { verifyOrder } from '../../services/emr/orderEntryService.js';
import { bindMedicationOrderCatalogAuthority } from '../../services/ipd/wardIndentWorkflowService.js';

function compact(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, '');
}

export async function seedReceivedMedicationSupply({
  prisma,
  tenantId,
  patientUid,
  requesterUid,
  prescriberUid = requesterUid,
  pharmacistUid,
  receiverUid,
  run,
  medications,
}) {
  const wardId = Number((await prisma.$queryRawUnsafe(
    `INSERT INTO wards (tenant_id, name, total_beds, created_at, updated_at)
     VALUES ($1::uuid, $2::text, 10, NOW(), NOW())
     RETURNING id`,
    tenantId,
    `MAR fixture ward ${run}`,
  ))[0].id);
  const encounterId = randomUUID();
  const bedNumber = `MAR-${run}`.slice(0, 50);
  const bedId = Number((await prisma.$queryRawUnsafe(
    `INSERT INTO beds
       (tenant_id, ward_id, ward_name, bed_number, status, patient_uid,
        created_at, updated_at)
     VALUES ($1::uuid, $2::int, $3::text, $4::text, 'occupied', $5::uuid,
             NOW(), NOW())
     RETURNING id`,
    tenantId,
    wardId,
    `MAR fixture ward ${run}`,
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
    tenantId,
    patientUid,
    encounterId,
    bedId,
    bedNumber,
    `MAR fixture ward ${run}`,
    requesterUid,
  ))[0].id);

  const products = {};
  const compositionId = Number((await prisma.$queryRawUnsafe(
    `INSERT INTO drug_compositions
       (composition_key, display_label, active_ingredients, source)
     VALUES
       ('mar_medication_evidence_fixture_v1', 'MAR medication evidence fixture',
        ARRAY['fixture_ingredient']::text[], 'test_fixture')
     ON CONFLICT (composition_key) DO UPDATE
       SET display_label = EXCLUDED.display_label
     RETURNING id`,
  ))[0].id);
  for (const [index, medication] of medications.entries()) {
    const strengthKey = medication.strengthKey || compact(medication.strength);
    const formKey = medication.formKey || compact(medication.form);
    const quantity = medication.quantity || 20;
    const strengthComponents = medication.strengthComponents || [{
      ingredient: 'fixture_ingredient',
      value: String(index + 1),
      unit: 'fixture_unit',
    }];
    const catalog = (await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, generic_name, is_active, stock_quantity, unit_price, price,
          composition_id, composition_confidence, composition_source,
          strength, strength_key, strength_components,
          form, form_key, release_key, route, updated_at)
       VALUES ($1::uuid, $2::text, $2::text, TRUE, $3::numeric, 1.00, 1.00,
                $4::int, 'high', 'test_fixture',
                $5::text, $6::text, $7::jsonb,
                $8::text, $9::text, 'immediate_release', $10::text, NOW())
       RETURNING id, name, generic_name, composition_id, composition_confidence,
                 composition_source, strength, strength_key, strength_components,
                 form, form_key, release_key, route`,
      tenantId,
      medication.name,
      quantity,
      compositionId,
      medication.strength,
      strengthKey,
      JSON.stringify(strengthComponents),
      medication.form,
      formKey,
      medication.route,
    ))[0];
    const catalogId = Number(catalog.id);
    const inventoryItemId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, catalog_id, strength, form,
          unit_label, schedule_class, is_narcotic)
       VALUES ($1::uuid, $2::text, $3::text, $4::int, $5::text, $6::text,
               'each', 'OTC', FALSE)
       RETURNING id`,
      tenantId,
      `MAR-${run}-${index}`.slice(0, 80),
      medication.name,
      catalogId,
      medication.strength,
      medication.form,
    ))[0].id);
    const batchNumber = (medication.batchNumber || `MAR-BATCH-${run}-${index}`).slice(0, 100);
    const inventoryBatchId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, expiry_date,
          received_quantity, remaining_quantity, status)
       VALUES ($1::uuid, $2::int, $3::text, (NOW() + INTERVAL '365 days')::date,
               $4::numeric, $4::numeric, 'in_stock')
       RETURNING id`,
      tenantId,
      inventoryItemId,
      batchNumber,
      quantity,
    ))[0].id);
    const orderDetails = bindMedicationOrderCatalogAuthority({
      catalog_id: catalogId,
      dose: medication.dose,
      route: medication.route,
      strength: medication.strength,
      strength_key: strengthKey,
      form: medication.form,
      form_key: formKey,
      quantity_requested: quantity,
      unit: 'each',
    }, catalog);
    const clinicalOrderId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_orders
         (tenant_id, order_number, patient_uid, encounter_id, order_type, status,
          ordered_by, details, route, updated_at)
       VALUES ($1::uuid, $2::text, $3::uuid, $4::uuid, 'medication', 'ordered',
               $5::uuid, $6::jsonb, $7::text, NOW())
       RETURNING id`,
      tenantId,
      `MAR-FIX-${run}-${index}`.slice(0, 80),
      patientUid,
      encounterId,
      prescriberUid,
       JSON.stringify(orderDetails),
      medication.route,
    ))[0].id);
    await verifyOrder(clinicalOrderId, pharmacistUid, {
      tenantId,
      actorRole: 'PHARMACY_INCHARGE',
      idempotencyKey: `mar-fixture-verify-${run}-${index}`,
    });
    products[medication.key] = {
      ...medication,
      strengthKey,
      formKey,
      quantity,
      catalogId,
      inventoryItemId,
      inventoryBatchId,
      batchNumber,
      clinicalOrderId,
    };
  }

  const indent = await createWardIndent({
    wardId,
    admissionId,
    encounterId,
    patientUid,
    indentType: 'pharmacy',
    items: Object.values(products).map((product) => ({
      pharmacy_catalog_id: product.catalogId,
      clinical_order_id: product.clinicalOrderId,
      item_name: product.name,
      quantity_requested: product.quantity,
    })),
    requestedBy: requesterUid,
    commandKey: `mar-fixture-create-${run}`,
    tenantId,
  });
  const reserved = await reserveWardIndent({
    indentId: indent.id,
    reservedBy: pharmacistUid,
    expectedVersion: indent.state_version,
    commandKey: `mar-fixture-reserve-${run}`,
    tenantId,
  });
  const approved = await approveWardIndent({
    indentId: indent.id,
    approvedBy: pharmacistUid,
    expectedVersion: reserved.state_version,
    commandKey: `mar-fixture-approve-${run}`,
    tenantId,
  });
  const issued = await issueWardIndent({
    indentId: indent.id,
    issuedBy: pharmacistUid,
    expectedVersion: approved.state_version,
    commandKey: `mar-fixture-issue-${run}`,
    tenantId,
  });
  const received = await receiveWardIndent({
    indentId: indent.id,
    receivedBy: receiverUid,
    expectedVersion: issued.state_version,
    commandKey: `mar-fixture-receive-${run}`,
    tenantId,
  });

  return {
    wardId,
    bedId,
    admissionId,
    encounterId,
    indentId: Number(indent.id),
    received,
    products,
  };
}
