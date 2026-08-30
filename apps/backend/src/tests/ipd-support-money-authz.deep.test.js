// Phase-3 deep-review fixes — IPD support money/authz/canonical paths,
// proven against a real DB:
//
//   1. (B-M3) refundAdvanceDeposit locks the parent deposit FOR UPDATE and
//      recomputes the refunded total in-tx: an over-refund — including the
//      one produced by two concurrent refunds racing the same balance —
//      is rejected 409 DEPOSIT_REFUND_EXCEEDS_BALANCE, never double-paid
//      and never a generic 500.
//   2. (B-M4) /api/v1/ipd operations carry per-route requireRole guards:
//      refund payout is finance/cashier-only, ward-indent issue is
//      pharmacy-only, pass revoke is admission/ward-leadership-only.
//   3. (B-M5) issuing a patient-linked ward indent requires durable order
//      verification evidence, then writes exactly one clinical timeline row
//      and one clinical audit row without mutating the clinical-order state.

import { randomUUID } from 'crypto';
import request from 'supertest';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const app = (await import('../app.js')).default;
const prisma = (await import('../lib/prisma.js')).default;
const ipdSupportService = (await import('../services/ipd/ipdSupportService.js')).default;
const { verifyOrder } = await import('../services/emr/orderEntryService.js');
const { bindMedicationOrderCatalogAuthority } = await import(
  '../services/ipd/wardIndentWorkflowService.js'
);
const { API_KEY, generateTestToken } = await import('./testClient.js');
const { deleteWithAuditBypass } = await import('./helpers/auditBypass.js');
const { seedMedicationFacilityAuthority } = await import('./helpers/medicationEvidenceFixture.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const SUFFIX = String(Date.now() % 100000).padStart(5, '0');

const PATIENT_UID = randomUUID();
const BILLING_UID = randomUUID();
const RECEPTIONIST_UID = randomUUID();
const NURSE_UID = randomUUID();
const PHARMACY_UID = randomUUID();
const ADMISSION_OFFICER_UID = randomUUID();
const ADMIN_UID = randomUUID();
const PRESCRIBER_UID = randomUUID();

const WARD_NAME = `BM-WARD-${SUFFIX}`;
const INVENTORY_SKU_PREFIX = `BM-INV-${SUFFIX}`;
const CATALOG_NAME_PREFIX = `BM-CATALOG-${SUFFIX}`;
const AUTHORITY_RUN = `ipd-money-${SUFFIX}-${PHARMACY_UID.slice(0, 8)}`;
const FACILITY_CODE = `MAR-FIX-FACILITY-${AUTHORITY_RUN}`.slice(0, 80);
const CEFTRIAXONE_COMPOSITION_KEY = `bm-ceftriaxone-${AUTHORITY_RUN}`.slice(0, 255);

let wardId;
let admissionId;
let encounterId;
let facilityId;
let storageLocationId;
let gauzeCatalog;
let ceftriaxoneCatalog;
let bedsheetCatalog;

function phone() {
  return `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
}

function client(role, uid) {
  const token = generateTestToken(role, { uid, tenant_id: TENANT });
  const auth = (req) => req
    .set('x-api-key', API_KEY)
    .set('Authorization', `Bearer ${token}`);
  return {
    get: (path) => auth(request(app).get(path)),
    post: (path) => auth(request(app).post(path)),
  };
}

async function seedUser({ uid, role, name }) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2, $3, $4, true, $5::uuid, NOW())`,
    uid, phone(), name, role, TENANT,
  );
}

async function seedDeposit(amount) {
  return ipdSupportService.collectAdvanceDeposit({
    admissionId,
    amount,
    paymentMethod: 'cash',
    collectedBy: BILLING_UID,
    tenantId: TENANT,
  });
}

async function seedClassifiedCatalog({
  name,
  sku,
  scheduleClass = null,
  withBatch = false,
  facilityId: catalogFacilityId,
  storageLocationId: catalogStorageLocationId,
  medicationIdentity = null,
}) {
  const identity = medicationIdentity || {};
  const catalogRows = await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_catalog
       (name, category, requires_prescription, is_active, tenant_id,
        generic_name, composition_id, composition_source, composition_confidence,
        strength, strength_key, strength_components, form, form_key, release_key, route,
        stock_quantity, updated_at)
     VALUES ($1, $3::text, $4::boolean, TRUE, $2::uuid,
             $5::text, $6::int, $7::text, $8::text,
             $9::text, $10::text, $11::jsonb, $12::text, $13::text, $14::text, $15::text,
             100, NOW())
     RETURNING id, name, generic_name, composition_id, composition_source,
               composition_confidence, strength, strength_key, strength_components,
               form, form_key, release_key, route, is_active`,
    name,
    TENANT,
    scheduleClass ? 'medication' : 'ward_supply',
    Boolean(scheduleClass),
    identity.genericName || null,
    identity.compositionId || null,
    identity.compositionSource || null,
    identity.compositionConfidence || null,
    identity.strength || null,
    identity.strengthKey || null,
    medicationIdentity ? JSON.stringify(identity.strengthComponents) : null,
    identity.form || null,
    identity.formKey || null,
    identity.releaseKey || null,
    identity.route || null,
  );
  const catalog = { ...catalogRows[0], id: Number(catalogRows[0].id) };
  const catalogId = catalog.id;
  const inventoryRows = await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_inventory_items
       (tenant_id, facility_id, sku_code, display_name, catalog_id, schedule_class, is_narcotic)
     VALUES ($1::uuid, $6::int, $2, $3, $4, $5, FALSE)
     RETURNING id`,
    TENANT, sku, name, catalogId, scheduleClass, catalogFacilityId,
  );
  const inventoryItemId = Number(inventoryRows[0].id);
  let batchId = null;
  if (withBatch) {
    const batchRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, facility_id, storage_location_id,
          batch_number, expiry_date, received_quantity, remaining_quantity, status)
       VALUES ($1::uuid, $2::int, $4::int, $5::int,
               $3, (NOW() + INTERVAL '365 days')::date, 100, 100, 'in_stock')
       RETURNING id`,
      TENANT,
      inventoryItemId,
      `${sku}-BATCH`,
      catalogFacilityId,
      catalogStorageLocationId,
    );
    batchId = Number(batchRows[0].id);
  }
  return { ...catalog, catalogId, inventoryItemId, batchId };
}

async function cleanup() {
  let fixtureInvoiceItemIds = [];
  let fixtureInvoiceIds = [];
  await prisma.$transaction(async (tx) => {
    const fixtureBillingRows = await tx.$queryRawUnsafe(
      `SELECT invoice_item.id AS invoice_item_id, invoice_item.invoice_id
         FROM billing_invoice_items invoice_item
         JOIN billing_invoices invoice
           ON invoice.tenant_id = invoice_item.tenant_id
          AND invoice.id = invoice_item.invoice_id
         JOIN ward_indent_items indent_item
           ON indent_item.tenant_id = invoice_item.tenant_id
          AND indent_item.id = invoice_item.source_ref_id
         JOIN ward_indents indent
           ON indent.tenant_id = indent_item.tenant_id
          AND indent.id = indent_item.ward_indent_id
        WHERE invoice_item.tenant_id = $1::uuid
          AND invoice_item.source_ref_type = 'ward_indent_item'
          AND (indent.patient_uid = $2::uuid OR indent.ward_name = $3::text)
        ORDER BY invoice_item.id
        FOR UPDATE OF invoice_item, invoice`,
      TENANT,
      PATIENT_UID,
      WARD_NAME,
    );
    fixtureInvoiceItemIds = fixtureBillingRows.map((row) => Number(row.invoice_item_id));
    fixtureInvoiceIds = [...new Set(fixtureBillingRows.map((row) => Number(row.invoice_id)))];
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
    await tx.$executeRawUnsafe(
      `DELETE FROM ward_indent_inventory_receipt_events
        WHERE tenant_id = $1::uuid
          AND ward_indent_id IN (
            SELECT id FROM ward_indents
             WHERE patient_uid = $2::uuid OR ward_name = $3
          )`,
      TENANT, PATIENT_UID, WARD_NAME,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM ward_indent_inventory_movement_links
        WHERE tenant_id = $1::uuid
          AND allocation_id IN (
            SELECT allocation.id
              FROM ward_indent_inventory_allocations allocation
              JOIN ward_indents indent
                ON indent.tenant_id = allocation.tenant_id
               AND indent.id = allocation.ward_indent_id
             WHERE allocation.tenant_id = $1::uuid
               AND (indent.patient_uid = $2::uuid OR indent.ward_name = $3)
          )`,
      TENANT, PATIENT_UID, WARD_NAME,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM ward_indent_financial_events
        WHERE tenant_id = $1::uuid
          AND ward_indent_id IN (
            SELECT id FROM ward_indents
             WHERE patient_uid = $2::uuid OR ward_name = $3
          )`,
      TENANT, PATIENT_UID, WARD_NAME,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM ward_indent_inventory_allocations
        WHERE tenant_id = $1::uuid
          AND ward_indent_id IN (
            SELECT id FROM ward_indents
             WHERE patient_uid = $2::uuid OR ward_name = $3
          )`,
      TENANT, PATIENT_UID, WARD_NAME,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM ward_indent_events WHERE ward_indent_id IN (
         SELECT id FROM ward_indents WHERE patient_uid = $1::uuid OR ward_name = $2)`,
      PATIENT_UID, WARD_NAME,
    );
    const fixtureOutboxRows = await tx.$queryRawUnsafe(
      `SELECT outbox.id
         FROM notification_outbox outbox
        WHERE outbox.tenant_id = $1::uuid
          AND outbox.payload->>'ward_indent_id' IN (
            SELECT indent.id::text
              FROM ward_indents indent
             WHERE indent.tenant_id = $1::uuid
               AND (indent.patient_uid = $2::uuid OR indent.ward_name = $3::text)
          )
        ORDER BY outbox.id
        FOR UPDATE OF outbox`,
      TENANT,
      PATIENT_UID,
      WARD_NAME,
    );
    const fixtureOutboxIds = fixtureOutboxRows.map((row) => Number(row.id));
    if (fixtureOutboxIds.length > 0) {
      await tx.$executeRawUnsafe(
        `DELETE FROM notification_provider_receipts
          WHERE tenant_id = $1::uuid
            AND notification_outbox_id = ANY($2::int[])`,
        TENANT,
        fixtureOutboxIds,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM notification_delivery_attempts
          WHERE tenant_id = $1::uuid
            AND notification_outbox_id = ANY($2::int[])`,
        TENANT,
        fixtureOutboxIds,
      );
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
      await tx.$executeRawUnsafe(
        `DELETE FROM notification_outbox
          WHERE tenant_id = $1::uuid
            AND id = ANY($2::int[])`,
        TENANT,
        fixtureOutboxIds,
      );
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
    }
    await tx.$executeRawUnsafe(
      `DELETE FROM task_comments
        WHERE task_id IN (
          SELECT task.id
            FROM tasks task
            JOIN workflow_sla_instances sla
              ON sla.tenant_id = task.tenant_id
             AND sla.id = task.workflow_sla_instance_id
           WHERE sla.source_table = 'ward_indents'
             AND sla.source_id IN (
               SELECT id::text FROM ward_indents
                WHERE patient_uid = $1::uuid OR ward_name = $2
             )
        )`,
      PATIENT_UID, WARD_NAME,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM tasks
        WHERE workflow_sla_instance_id IN (
          SELECT id FROM workflow_sla_instances
           WHERE source_table = 'ward_indents'
             AND source_id IN (
               SELECT id::text FROM ward_indents
                WHERE patient_uid = $1::uuid OR ward_name = $2
             )
        )`,
      PATIENT_UID, WARD_NAME,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances
        WHERE source_table = 'ward_indents'
          AND source_id IN (
            SELECT id::text FROM ward_indents
             WHERE patient_uid = $1::uuid OR ward_name = $2
          )`,
      PATIENT_UID, WARD_NAME,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM pharmacy_schedule_register
        WHERE tenant_id = $1::uuid
          AND inventory_item_id IN (
            SELECT id FROM pharmacy_inventory_items
             WHERE tenant_id = $1::uuid AND sku_code LIKE $2
          )`,
      TENANT, `${INVENTORY_SKU_PREFIX}-%`,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM pharmacy_stock_movements
        WHERE tenant_id = $1::uuid
          AND inventory_item_id IN (
            SELECT id FROM pharmacy_inventory_items
             WHERE tenant_id = $1::uuid AND sku_code LIKE $2
          )`,
      TENANT, `${INVENTORY_SKU_PREFIX}-%`,
    );
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
  });
  if (fixtureInvoiceIds.length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `DELETE FROM billing_invoice_items
          WHERE tenant_id = $1::uuid
            AND source_ref_type = 'ward_indent_item'
            AND id = ANY($2::int[])`,
        TENANT,
        fixtureInvoiceItemIds,
      );
      const deletedInvoices = await tx.$executeRawUnsafe(
        `DELETE FROM billing_invoices invoice
          WHERE invoice.tenant_id = $1::uuid
            AND invoice.patient_uid = $2::uuid
            AND invoice.id = ANY($3::int[])
            AND NOT EXISTS (
              SELECT 1
                FROM billing_invoice_items invoice_item
               WHERE invoice_item.tenant_id = invoice.tenant_id
                 AND invoice_item.invoice_id = invoice.id
            )`,
        TENANT,
        PATIENT_UID,
        fixtureInvoiceIds,
      );
      if (Number(deletedInvoices) !== fixtureInvoiceIds.length) {
        throw new Error('Fixture ward-indent invoices retain unexpected billing projections');
      }
    });
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await deleteWithAuditBypass(
    prisma,
    `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM ward_indent_items WHERE ward_indent_id IN (
       SELECT id FROM ward_indents WHERE patient_uid = $1::uuid OR ward_name = $2)`,
    PATIENT_UID, WARD_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM ward_indents WHERE patient_uid = $1::uuid OR ward_name = $2`,
    PATIENT_UID, WARD_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM billing_advances WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM advance_deposits WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM attendant_passes WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM beds WHERE tenant_id = $1::uuid AND ward_name = $2::text`,
    TENANT, WARD_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM wards WHERE name = $1`, WARD_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM pharmacy_inventory_batches
      WHERE tenant_id = $1::uuid
        AND inventory_item_id IN (
          SELECT id FROM pharmacy_inventory_items
           WHERE tenant_id = $1::uuid AND sku_code LIKE $2
        )`,
    TENANT, `${INVENTORY_SKU_PREFIX}-%`,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM pharmacy_inventory_items
      WHERE tenant_id = $1::uuid AND sku_code LIKE $2`,
    TENANT, `${INVENTORY_SKU_PREFIX}-%`,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM pharmacy_catalog
      WHERE tenant_id = $1::uuid AND name LIKE $2`,
    TENANT, `${CATALOG_NAME_PREFIX} %`,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM drug_compositions WHERE composition_key = $1::text`,
    CEFTRIAXONE_COMPOSITION_KEY,
  );
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
    await tx.$executeRawUnsafe(
      `DELETE FROM pharmacy_staff_facility_grant_events
        WHERE tenant_id = $1::uuid
          AND grant_id IN (
            SELECT id FROM pharmacy_staff_facility_grants
             WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid
          )`,
      TENANT,
      PHARMACY_UID,
    );
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
    await tx.$executeRawUnsafe(
      `DELETE FROM pharmacy_staff_facility_grants
        WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid`,
      TENANT,
      PHARMACY_UID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM staff
        WHERE tenant_id = $1::uuid AND user_id = ANY($2::uuid[])`,
      TENANT,
      [PHARMACY_UID, PRESCRIBER_UID],
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM facility_locations
        WHERE tenant_id = $1::uuid
          AND facility_id IN (
            SELECT id FROM facilities
             WHERE tenant_id = $1::uuid AND facility_code = $2::text
          )`,
      TENANT,
      FACILITY_CODE,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM facilities
        WHERE tenant_id = $1::uuid AND facility_code = $2::text`,
      TENANT,
      FACILITY_CODE,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM users
        WHERE tenant_id = $1::uuid AND uid = ANY($2::uuid[])`,
      TENANT,
      [
        PATIENT_UID,
        BILLING_UID,
        RECEPTIONIST_UID,
        NURSE_UID,
        PHARMACY_UID,
        ADMISSION_OFFICER_UID,
        ADMIN_UID,
        PRESCRIBER_UID,
      ],
    );
  });
}

d('Phase-3 IPD support fixes: refund race, per-route authz, ward-indent canonicals (deep)', () => {
  beforeAll(async () => {
    await cleanup();
    await seedUser({ uid: PATIENT_UID, role: 'PATIENT', name: 'BM Patient' });
    await seedUser({ uid: BILLING_UID, role: 'BILLING_STAFF', name: 'BM Billing' });
    await seedUser({ uid: RECEPTIONIST_UID, role: 'RECEPTIONIST', name: 'BM Receptionist' });
    await seedUser({ uid: NURSE_UID, role: 'IP_STAFF_NURSE', name: 'BM Nurse' });
    await seedUser({ uid: PHARMACY_UID, role: 'PHARMACY_STAFF', name: 'BM Pharmacist' });
    await seedUser({ uid: ADMISSION_OFFICER_UID, role: 'ADMISSION_OFFICER', name: 'BM Admission Officer' });
    await seedUser({ uid: ADMIN_UID, role: 'ADMIN', name: 'BM Facility Grant Admin' });
    await seedUser({ uid: PRESCRIBER_UID, role: 'DOCTOR', name: 'BM Prescriber' });
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff
         (tenant_id, user_id, employee_id, name, designation, skills,
          certifications, is_active, archived, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::text, 'BM Prescriber', 'Doctor',
               '{}'::text[], '{}'::text[], TRUE, FALSE, NOW(), NOW())`,
      TENANT,
      PRESCRIBER_UID,
      `BM-DOCTOR-${SUFFIX}`,
    );

    const authority = await seedMedicationFacilityAuthority({
      prisma,
      tenantId: TENANT,
      pharmacistUid: PHARMACY_UID,
      grantAdminUid: ADMIN_UID,
      run: AUTHORITY_RUN,
    });
    facilityId = authority.facilityId;
    storageLocationId = authority.storageLocationId;

    const wardRows = await prisma.$queryRawUnsafe(
      `INSERT INTO wards (tenant_id, facility_id, name, floor, total_beds)
       VALUES ($1::uuid, $2::int, $3, 1, 2)
       RETURNING id`,
      TENANT,
      facilityId,
      WARD_NAME,
    );
    wardId = wardRows[0].id;

    encounterId = randomUUID();
    const bedRows = await prisma.$queryRawUnsafe(
      `INSERT INTO beds
         (tenant_id, ward_id, ward_name, bed_number, status, patient_uid,
          created_at, updated_at)
       VALUES ($1::uuid, $2::int, $3::text, $4::text, 'occupied', $5::uuid,
               NOW(), NOW())
       RETURNING id`,
      TENANT,
      Number(wardId),
      WARD_NAME,
      `BM-BED-${SUFFIX}`,
      PATIENT_UID,
    );

    const admissionRows = await prisma.$queryRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, encounter_id, bed_id, bed_number, status,
          ward, admitted_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::int, $5::text,
               'admitted', $6::text, NOW(), NOW())
       RETURNING id`,
      TENANT,
      PATIENT_UID,
      encounterId,
      Number(bedRows[0].id),
      `BM-BED-${SUFFIX}`,
      WARD_NAME,
    );
    admissionId = admissionRows[0].id;

    const ceftriaxoneCompositionId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO drug_compositions
         (composition_key, display_label, active_ingredients, source)
       VALUES ($1::text, 'Ceftriaxone', ARRAY['ceftriaxone']::text[], 'curated')
       RETURNING id`,
      CEFTRIAXONE_COMPOSITION_KEY,
    ))[0].id);

    // Every positive line must have a same-tenant inventory classification.
    gauzeCatalog = await seedClassifiedCatalog({
      name: `${CATALOG_NAME_PREFIX} Gauze roll`,
      sku: `${INVENTORY_SKU_PREFIX}-GAUZE`,
      withBatch: true,
      facilityId,
      storageLocationId,
    });
    ceftriaxoneCatalog = await seedClassifiedCatalog({
      name: `${CATALOG_NAME_PREFIX} Ceftriaxone 1g`,
      sku: `${INVENTORY_SKU_PREFIX}-CEFTRIAXONE`,
      scheduleClass: 'H',
      withBatch: true,
      facilityId,
      storageLocationId,
      medicationIdentity: {
        genericName: 'Ceftriaxone',
        compositionId: ceftriaxoneCompositionId,
        compositionSource: 'test_fixture',
        compositionConfidence: 'high',
        strength: '1 g',
        strengthKey: '1g',
        strengthComponents: [{ ingredient: 'ceftriaxone', value: '1', unit: 'g' }],
        form: 'powder for injection',
        formKey: 'powder_for_injection',
        releaseKey: 'ir',
        route: 'IV',
      },
    });
    bedsheetCatalog = await seedClassifiedCatalog({
      name: `${CATALOG_NAME_PREFIX} Bedsheet`,
      sku: `${INVENTORY_SKU_PREFIX}-BEDSHEET`,
      withBatch: true,
      facilityId,
      storageLocationId,
    });
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 120_000);

  // ── B-M3: over-refund guard is race-safe and 409s ─────────────────────────

  it('rejects a sequential over-refund with 409 DEPOSIT_REFUND_EXCEEDS_BALANCE', async () => {
    const deposit = await seedDeposit(100);

    const first = await ipdSupportService.refundAdvanceDeposit({
      parentDepositId: deposit.id,
      refundAmount: 60,
      paymentMethod: 'cash',
      refundedBy: BILLING_UID,
      tenantId: TENANT,
    });
    expect(Number(first.amount)).toBe(-60);
    expect(first.is_refund).toBe(true);

    await expect(
      ipdSupportService.refundAdvanceDeposit({
        parentDepositId: deposit.id,
        refundAmount: 50,
        paymentMethod: 'cash',
        refundedBy: BILLING_UID,
        tenantId: TENANT,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEPOSIT_REFUND_EXCEEDS_BALANCE',
    });

    // Only the one refund row exists.
    const refunds = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM advance_deposits
        WHERE parent_deposit_id = $1::int AND is_refund = true`,
      deposit.id,
    );
    expect(refunds[0].n).toBe(1);
  }, 60_000);

  it('serializes two concurrent refunds on the same deposit — one pays, one 409s, never both', async () => {
    const deposit = await seedDeposit(100);

    const results = await Promise.allSettled([
      ipdSupportService.refundAdvanceDeposit({
        parentDepositId: deposit.id,
        refundAmount: 80,
        paymentMethod: 'cash',
        refundedBy: BILLING_UID,
        tenantId: TENANT,
      }),
      ipdSupportService.refundAdvanceDeposit({
        parentDepositId: deposit.id,
        refundAmount: 80,
        paymentMethod: 'cash',
        refundedBy: BILLING_UID,
        tenantId: TENANT,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({
      statusCode: 409,
      code: 'DEPOSIT_REFUND_EXCEEDS_BALANCE',
    });

    // Exactly one payout committed — the deposit was not double-refunded.
    const agg = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::numeric AS total
         FROM advance_deposits
        WHERE parent_deposit_id = $1::int AND is_refund = true`,
      deposit.id,
    );
    expect(agg[0].n).toBe(1);
    expect(Number(agg[0].total)).toBe(-80);
  }, 60_000);

  // ── B-M4: per-route authz on the /api/v1/ipd surface ──────────────────────

  it('refund payout: RECEPTIONIST (mount union, non-finance) gets 403; BILLING_STAFF passes and refunds', async () => {
    const deposit = await seedDeposit(40);

    const denied = await client('RECEPTIONIST', RECEPTIONIST_UID)
      .post(`/api/v1/ipd/advance-deposits/${deposit.id}/refund`)
      .send({ refund_amount: 10, payment_method: 'cash' });
    expect(denied.statusCode).toBe(403);

    const allowed = await client('BILLING_STAFF', BILLING_UID)
      .post(`/api/v1/ipd/advance-deposits/${deposit.id}/refund`)
      .send({ refund_amount: 10, payment_method: 'cash' });
    expect(allowed.statusCode).toBe(201);
    expect(Number(allowed.body.data.refund.amount)).toBe(-10);
  }, 60_000);

  it('deposit collection: IP_STAFF_NURSE gets 403; RECEPTIONIST passes', async () => {
    const denied = await client('IP_STAFF_NURSE', NURSE_UID)
      .post(`/api/v1/ipd/admissions/${admissionId}/advance-deposits`)
      .send({ amount: 10, payment_method: 'cash' });
    expect(denied.statusCode).toBe(403);

    const allowed = await client('RECEPTIONIST', RECEPTIONIST_UID)
      .post(`/api/v1/ipd/admissions/${admissionId}/advance-deposits`)
      .send({ amount: 10, payment_method: 'cash' });
    expect(allowed.statusCode).toBe(201);
  }, 60_000);

  it('ward-indent issue: RECEPTIONIST and IP_STAFF_NURSE get 403; PHARMACY_STAFF passes', async () => {
    const indent = await ipdSupportService.createWardIndent({
      wardId,
      indentType: 'consumables',
      items: [{
        item_name: 'Gauze roll',
        quantity_requested: 5,
        pharmacy_catalog_id: gauzeCatalog.catalogId,
      }],
      requestedBy: NURSE_UID,
      commandKey: `bm5-authz-create-${SUFFIX}`,
      tenantId: TENANT,
    });
    await ipdSupportService.reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACY_UID,
      actorRole: 'PHARMACY_STAFF',
      commandKey: `bm5-authz-reserve-${SUFFIX}`,
      tenantId: TENANT,
    });
    await ipdSupportService.approveWardIndent({
      indentId: indent.id,
      approvedBy: PHARMACY_UID,
      actorRole: 'PHARMACY_STAFF',
      commandKey: `bm5-authz-approve-${SUFFIX}`,
      tenantId: TENANT,
    });

    const deniedReception = await client('RECEPTIONIST', RECEPTIONIST_UID)
      .post(`/api/v1/ipd/ward-indents/${indent.id}/issue`)
      .send({});
    expect(deniedReception.statusCode).toBe(403);

    const deniedNurse = await client('IP_STAFF_NURSE', NURSE_UID)
      .post(`/api/v1/ipd/ward-indents/${indent.id}/issue`)
      .send({});
    expect(deniedNurse.statusCode).toBe(403);

    const allowed = await client('PHARMACY_STAFF', PHARMACY_UID)
      .post(`/api/v1/ipd/ward-indents/${indent.id}/issue`)
      .set('idempotency-key', `bm5-authz-issue-${SUFFIX}`)
      .send({});
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body.data.indent.status).toBe('issued');
  }, 60_000);

  it('attendant-pass revoke: PHARMACY_STAFF gets 403; ADMISSION_OFFICER passes', async () => {
    const passRows = await prisma.$queryRawUnsafe(
      `INSERT INTO attendant_passes
         (admission_id, patient_uid, pass_number, pass_index, issued_by, tenant_id)
       VALUES ($1::int, $2::uuid, $3, 99, $4::uuid, $5::uuid)
       RETURNING id`,
      admissionId, PATIENT_UID, `AP-TEST-${SUFFIX}`, ADMISSION_OFFICER_UID, TENANT,
    );
    const passId = passRows[0].id;

    const denied = await client('PHARMACY_STAFF', PHARMACY_UID)
      .post(`/api/v1/ipd/attendant-passes/${passId}/revoke`)
      .send({ reason: 'should not be allowed' });
    expect(denied.statusCode).toBe(403);

    const allowed = await client('ADMISSION_OFFICER', ADMISSION_OFFICER_UID)
      .post(`/api/v1/ipd/attendant-passes/${passId}/revoke`)
      .send({ reason: 'lost pass' });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body.data.pass.status).toBe('revoked');
  }, 60_000);

  // ── B-M5: ward-indent issue writes canonical timeline + audit rows ────────

  it('requires preverified clinical-order evidence and writes one ward-issue timeline + audit row', async () => {
    const orderDetails = bindMedicationOrderCatalogAuthority({
      medication_name: ceftriaxoneCatalog.name,
      catalog_id: ceftriaxoneCatalog.catalogId,
      dose: '1 g',
      route: ceftriaxoneCatalog.route,
      strength: ceftriaxoneCatalog.strength,
      strength_key: ceftriaxoneCatalog.strength_key,
      form: ceftriaxoneCatalog.form,
      form_key: ceftriaxoneCatalog.form_key,
      release_key: ceftriaxoneCatalog.release_key,
      quantity_requested: 2,
      unit: 'vial',
    }, ceftriaxoneCatalog, { phase: 'create' });
    const orderRows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_orders
         (order_number, encounter_id, patient_uid, order_type, status, ordered_by,
          details, route, tenant_id)
       VALUES ($1, $2::uuid, $3::uuid, 'medication', 'ordered', $4::uuid,
               $5::jsonb, $6::text, $7::uuid)
       RETURNING id`,
      `ORD-BM5-${SUFFIX}`,
      encounterId,
      PATIENT_UID,
      PRESCRIBER_UID,
      JSON.stringify(orderDetails),
      ceftriaxoneCatalog.route,
      TENANT,
    );
    const clinicalOrderId = orderRows[0].id;

    const indent = await ipdSupportService.createWardIndent({
      wardId,
      admissionId,
      encounterId,
      patientUid: PATIENT_UID,
      indentType: 'pharmacy',
      items: [{
        item_name: 'Ceftriaxone 1g',
        quantity_requested: 2,
        pharmacy_catalog_id: ceftriaxoneCatalog.catalogId,
        clinical_order_id: clinicalOrderId,
        notes: `clinical_order_id:${clinicalOrderId}; order_number:ORD-BM5-${SUFFIX}`,
      }],
      requestedBy: NURSE_UID,
      commandKey: `bm5-patient-create-${SUFFIX}`,
      tenantId: TENANT,
    });
    await ipdSupportService.reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACY_UID,
      actorRole: 'PHARMACY_STAFF',
      commandKey: `bm5-patient-reserve-${SUFFIX}`,
      tenantId: TENANT,
    });
    const approval = await ipdSupportService.approveWardIndent({
      indentId: indent.id,
      approvedBy: PHARMACY_UID,
      actorRole: 'PHARMACY_STAFF',
      commandKey: `bm5-patient-approve-${SUFFIX}`,
      tenantId: TENANT,
    });
    expect(approval.status).toBe('controlled_handoff_required');
    const line = approval.items[0];
    await ipdSupportService.recordWardIndentControlledHandoff({
      indentId: indent.id,
      recordedBy: PHARMACY_UID,
      actorRole: 'PHARMACY_STAFF',
      itemEvidence: [{
        item_id: line.id,
      }],
      commandKey: `bm5-patient-handoff-${SUFFIX}`,
      tenantId: TENANT,
    });
    const loadIssueEffects = async () => (await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int
            FROM ward_indent_inventory_movement_links movement_link
            JOIN ward_indent_inventory_allocations allocation
              ON allocation.tenant_id = movement_link.tenant_id
             AND allocation.id = movement_link.allocation_id
           WHERE allocation.tenant_id = $1::uuid
             AND allocation.ward_indent_id = $2::int
             AND movement_link.movement_purpose = 'issue') AS issue_movements,
         (SELECT COUNT(*)::int
            FROM billing_invoice_items invoice_item
            JOIN ward_indent_items indent_item
              ON indent_item.tenant_id = invoice_item.tenant_id
             AND indent_item.id = invoice_item.source_ref_id
           WHERE invoice_item.tenant_id = $1::uuid
             AND invoice_item.source_ref_type = 'ward_indent_item'
             AND indent_item.ward_indent_id = $2::int) AS billing_lines`,
      TENANT,
      Number(indent.id),
    ))[0];
    const handoffEffects = await loadIssueEffects();
    expect(handoffEffects).toEqual({ issue_movements: 1, billing_lines: 0 });
    await expect(ipdSupportService.issueWardIndent({
      indentId: indent.id,
      issuedBy: PHARMACY_UID,
      actorRole: 'PHARMACY_STAFF',
      commandKey: `bm5-patient-premature-issue-${SUFFIX}`,
      tenantId: TENANT,
    })).rejects.toMatchObject({
      code: 'MEDICATION_ORDER_VERIFICATION_REQUIRED',
      statusCode: 409,
    });
    const preVerificationEffects = await loadIssueEffects();
    expect(preVerificationEffects).toEqual(handoffEffects);
    await verifyOrder(clinicalOrderId, PHARMACY_UID, {
      tenantId: TENANT,
      actorRole: 'PHARMACY_STAFF',
      idempotencyKey: `bm5-patient-verify-${SUFFIX}`,
    });
    const issued = await ipdSupportService.issueWardIndent({
      indentId: indent.id,
      issuedBy: PHARMACY_UID,
      actorRole: 'PHARMACY_STAFF',
      commandKey: `bm5-patient-issue-${SUFFIX}`,
      tenantId: TENANT,
    });
    expect(issued.status).toBe('issued');

    const order = await prisma.$queryRawUnsafe(
      `SELECT status, verified_by FROM clinical_orders WHERE id = $1::int`,
      clinicalOrderId,
    );
    expect(order[0].status).toBe('verified');
    expect(order[0].verified_by).toBe(PHARMACY_UID);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT patient_uid, event_type, event_status, actor_uid, payload
         FROM clinical_timeline_events
        WHERE idempotency_key = $1`,
      `ward_indents:${indent.id}:transition:5`,
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0].patient_uid).toBe(PATIENT_UID);
    expect(timeline[0].event_type).toBe('ward_indent.issued');
    expect(timeline[0].event_status).toBe('issued');
    expect(timeline[0].actor_uid).toBe(PHARMACY_UID);
    expect(timeline[0].payload.verified_clinical_order_ids).toContain(clinicalOrderId);

    const audit = await prisma.$queryRawUnsafe(
      `SELECT patient_uid, action, actor_uid
         FROM clinical_audit_events
        WHERE idempotency_key = $1`,
      `ward_indents:${indent.id}:audit:transition:5`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].patient_uid).toBe(PATIENT_UID);
    expect(audit[0].action).toBe('ward_indent.issued');
    expect(audit[0].actor_uid).toBe(PHARMACY_UID);
  }, 60_000);

  it('closes a patientless ward-stock return with exact inventory evidence and no billing rows', async () => {
    const indent = await ipdSupportService.createWardIndent({
      wardId,
      indentType: 'consumables',
      items: [{
        item_name: 'Bedsheet',
        quantity_requested: 10,
        pharmacy_catalog_id: bedsheetCatalog.catalogId,
      }],
      requestedBy: NURSE_UID,
      commandKey: `bm5-stock-create-${SUFFIX}`,
      tenantId: TENANT,
    });
    await ipdSupportService.reserveWardIndent({
      indentId: indent.id,
      reservedBy: PHARMACY_UID,
      actorRole: 'PHARMACY_STAFF',
      commandKey: `bm5-stock-reserve-${SUFFIX}`,
      tenantId: TENANT,
    });
    await ipdSupportService.approveWardIndent({
      indentId: indent.id,
      approvedBy: PHARMACY_UID,
      actorRole: 'PHARMACY_STAFF',
      commandKey: `bm5-stock-approve-${SUFFIX}`,
      tenantId: TENANT,
    });
    const issued = await ipdSupportService.issueWardIndent({
      indentId: indent.id,
      issuedBy: PHARMACY_UID,
      actorRole: 'PHARMACY_STAFF',
      commandKey: `bm5-stock-issue-${SUFFIX}`,
      tenantId: TENANT,
    });
    expect(issued.status).toBe('issued');

    const received = await ipdSupportService.receiveWardIndent({
      indentId: indent.id,
      receivedBy: NURSE_UID,
      expectedVersion: 4,
      commandKey: `bm5-stock-receive-${SUFFIX}`,
      tenantId: TENANT,
    });
    expect(received).toMatchObject({ status: 'received', state_version: 5 });

    const returnPending = await ipdSupportService.requestWardIndentReturn({
      indentId: indent.id,
      requestedBy: NURSE_UID,
      itemQuantitiesReturned: [{
        item_id: indent.items[0].id,
        quantity_returned: 4,
      }],
      reason: 'Four unused bedsheets returned to pharmacy',
      expectedVersion: 5,
      commandKey: `bm5-stock-return-request-${SUFFIX}`,
      tenantId: TENANT,
    });
    expect(returnPending).toMatchObject({ status: 'return_pending', state_version: 6 });

    const allocation = (await prisma.$queryRawUnsafe(
      `SELECT id, inventory_batch_id, issued_quantity, received_quantity,
              returned_quantity, status
         FROM ward_indent_inventory_allocations
        WHERE tenant_id = $1::uuid
          AND ward_indent_id = $2::int
          AND ward_indent_item_id = $3::int`,
      TENANT,
      Number(indent.id),
      Number(indent.items[0].id),
    ))[0];
    expect(allocation).toMatchObject({ status: 'issued' });
    expect([
      Number(allocation.issued_quantity),
      Number(allocation.received_quantity),
      Number(allocation.returned_quantity),
    ]).toEqual([10, 10, 0]);

    const unknownAllocationId = BigInt(allocation.id) + 999999999n;
    await expect(ipdSupportService.reconcileWardIndent({
      indentId: indent.id,
      reconciledBy: NURSE_UID,
      reason: 'Invalid allocation selection must roll back atomically',
      allocationReturns: [{
        allocation_id: allocation.id,
        quantity: 4,
      }, {
        allocation_id: unknownAllocationId,
        quantity: 1,
      }],
      expectedVersion: 6,
      commandKey: `bm5-stock-invalid-reconcile-${SUFFIX}`,
      tenantId: TENANT,
    })).rejects.toThrow(`Allocation return ${unknownAllocationId} does not belong to this ward indent`);

    const afterRejectedReturn = (await prisma.$queryRawUnsafe(
      `SELECT indent.status, indent.state_version, item.quantity_returned,
              allocation.returned_quantity,
              batch.remaining_quantity,
              COUNT(return_link.id)::int AS return_link_count
         FROM ward_indents indent
         JOIN ward_indent_items item
           ON item.tenant_id = indent.tenant_id
          AND item.ward_indent_id = indent.id
         JOIN ward_indent_inventory_allocations allocation
           ON allocation.tenant_id = item.tenant_id
          AND allocation.ward_indent_item_id = item.id
         JOIN pharmacy_inventory_batches batch
           ON batch.tenant_id = allocation.tenant_id
          AND batch.id = allocation.inventory_batch_id
         LEFT JOIN ward_indent_inventory_movement_links return_link
           ON return_link.tenant_id = allocation.tenant_id
          AND return_link.allocation_id = allocation.id
          AND return_link.movement_purpose = 'return'
        WHERE indent.tenant_id = $1::uuid
          AND indent.id = $2::int
        GROUP BY indent.status, indent.state_version, item.quantity_returned,
                 allocation.returned_quantity, batch.remaining_quantity`,
      TENANT,
      Number(indent.id),
    ))[0];
    expect(afterRejectedReturn).toMatchObject({
      status: 'return_pending',
      state_version: 6,
      return_link_count: 0,
    });
    expect([
      Number(afterRejectedReturn.quantity_returned),
      Number(afterRejectedReturn.returned_quantity),
      Number(afterRejectedReturn.remaining_quantity),
    ]).toEqual([0, 0, 90]);

    const reconciled = await ipdSupportService.reconcileWardIndent({
      indentId: indent.id,
      reconciledBy: NURSE_UID,
      reason: 'Unused ward stock returned against its exact batch',
      allocationReturns: [{
        allocation_id: allocation.id,
        quantity: 4,
      }],
      expectedVersion: 6,
      commandKey: `bm5-stock-reconcile-${SUFFIX}`,
      tenantId: TENANT,
    });
    expect(reconciled).toMatchObject({ status: 'reconciled', state_version: 7 });
    expect(reconciled.workflow.events[0].details).toMatchObject({ returned_item_count: 1 });

    const closed = await ipdSupportService.closeWardIndent({
      indentId: indent.id,
      closedBy: NURSE_UID,
      reason: 'Ward-stock return fully reconciled',
      expectedVersion: 7,
      commandKey: `bm5-stock-close-${SUFFIX}`,
      tenantId: TENANT,
    });
    expect(closed).toMatchObject({
      status: 'closed',
      state_version: 8,
      closure_outcome: 'returned_reconciled',
    });

    const inventoryEvidence = await prisma.$queryRawUnsafe(
      `SELECT link.movement_purpose, link.quantity,
              movement.movement_kind, movement.reference_type, movement.reference_id
         FROM ward_indent_inventory_movement_links link
         JOIN ward_indent_inventory_allocations allocation
           ON allocation.tenant_id = link.tenant_id
          AND allocation.id = link.allocation_id
         JOIN pharmacy_stock_movements movement
           ON movement.tenant_id = link.tenant_id
          AND movement.id = link.stock_movement_id
        WHERE allocation.tenant_id = $1::uuid
          AND allocation.ward_indent_id = $2::int
        ORDER BY link.id`,
      TENANT,
      Number(indent.id),
    );
    expect(inventoryEvidence.map((row) => ({
      purpose: row.movement_purpose,
      quantity: Number(row.quantity),
      kind: row.movement_kind,
      reference_type: row.reference_type,
      reference_id: row.reference_id,
    }))).toEqual([{
      purpose: 'issue',
      quantity: 10,
      kind: 'issue',
      reference_type: 'ward_indent_allocation',
      reference_id: String(allocation.id),
    }, {
      purpose: 'return',
      quantity: 4,
      kind: 'return',
      reference_type: 'ward_indent_return_allocation',
      reference_id: String(allocation.id),
    }]);

    const projectedInventory = (await prisma.$queryRawUnsafe(
      `SELECT allocation.issued_quantity, allocation.received_quantity,
              allocation.returned_quantity, batch.remaining_quantity,
              catalog.stock_quantity
         FROM ward_indent_inventory_allocations allocation
         JOIN pharmacy_inventory_batches batch
           ON batch.tenant_id = allocation.tenant_id
          AND batch.id = allocation.inventory_batch_id
         JOIN pharmacy_inventory_items inventory
           ON inventory.tenant_id = allocation.tenant_id
          AND inventory.id = allocation.inventory_item_id
         JOIN pharmacy_catalog catalog
           ON catalog.tenant_id = inventory.tenant_id
          AND catalog.id = inventory.catalog_id
        WHERE allocation.tenant_id = $1::uuid
          AND allocation.ward_indent_id = $2::int`,
      TENANT,
      Number(indent.id),
    ))[0];
    expect([
      Number(projectedInventory.issued_quantity),
      Number(projectedInventory.received_quantity),
      Number(projectedInventory.returned_quantity),
      Number(projectedInventory.remaining_quantity),
      Number(projectedInventory.stock_quantity),
    ]).toEqual([10, 10, 4, 94, 94]);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n
         FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND source_table = 'ward_indents'
          AND source_id = $2`,
      TENANT,
      String(indent.id),
    );
    expect(rows[0].n).toBe(0);

    const financialRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n
         FROM ward_indent_financial_events
        WHERE tenant_id = $1::uuid
          AND ward_indent_id = $2::int`,
      TENANT,
      Number(indent.id),
    );
    expect(financialRows[0].n).toBe(0);

    const creditNoteRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n
         FROM billing_credit_notes note
         JOIN ward_indent_financial_events financial
           ON financial.tenant_id = note.tenant_id
          AND financial.id = note.source_financial_event_id
        WHERE financial.tenant_id = $1::uuid
          AND financial.ward_indent_id = $2::int`,
      TENANT,
      Number(indent.id),
    );
    expect(creditNoteRows[0].n).toBe(0);

    const billingRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n
         FROM billing_invoice_items invoice_item
         JOIN ward_indent_items indent_item
           ON indent_item.tenant_id = invoice_item.tenant_id
          AND indent_item.id = invoice_item.source_ref_id
        WHERE invoice_item.tenant_id = $1::uuid
          AND invoice_item.source_ref_type = 'ward_indent_item'
          AND indent_item.ward_indent_id = $2::int`,
      TENANT,
      Number(indent.id),
    );
    expect(billingRows[0].n).toBe(0);
  }, 60_000);
});
