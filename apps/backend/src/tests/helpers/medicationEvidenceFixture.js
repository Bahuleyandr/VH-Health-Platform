import {
  approveWardIndent,
  createWardIndent,
  issueWardIndent,
  receiveWardIndent,
  reserveWardIndent,
} from '../../services/ipd/ipdSupportService.js';

function compact(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, '');
}

export async function seedReceivedMedicationSupply({
  prisma,
  tenantId,
  patientUid,
  requesterUid,
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

  const products = {};
  for (const [index, medication] of medications.entries()) {
    const strengthKey = medication.strengthKey || compact(medication.strength);
    const formKey = medication.formKey || compact(medication.form);
    const quantity = medication.quantity || 20;
    const catalogId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, is_active, stock_quantity, unit_price, price,
          strength, strength_key, form, form_key, route, updated_at)
       VALUES ($1::uuid, $2::text, TRUE, $3::numeric, 1.00, 1.00,
               $4::text, $5::text, $6::text, $7::text, $8::text, NOW())
       RETURNING id`,
      tenantId,
      medication.name,
      quantity,
      medication.strength,
      strengthKey,
      medication.form,
      formKey,
      medication.route,
    ))[0].id);
    const inventoryItemId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, catalog_id, strength, form,
          unit_label, schedule_class, is_narcotic)
       VALUES ($1::uuid, $2::text, $3::text, $4::int, $5::text, $6::text,
               'unit', 'OTC', FALSE)
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
    const clinicalOrderId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_orders
         (tenant_id, order_number, patient_uid, order_type, status,
          ordered_by, details, route, updated_at)
       VALUES ($1::uuid, $2::text, $3::uuid, 'medication', 'ordered',
               $4::uuid, $5::jsonb, $6::text, NOW())
       RETURNING id`,
      tenantId,
      `MAR-FIX-${run}-${index}`.slice(0, 80),
      patientUid,
      requesterUid,
      JSON.stringify({
        catalog_id: catalogId,
        dose: medication.dose,
        route: medication.route,
        strength: medication.strength,
        strength_key: strengthKey,
        form: medication.form,
        form_key: formKey,
      }),
      medication.route,
    ))[0].id);
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

  return { wardId, indentId: Number(indent.id), received, products };
}
