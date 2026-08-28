// Roadmap B1 — BCMA closed loop deep round-trip.
//
// Covers the pharmacist clinical-verification gate (verify → preparing,
// blockers → override-with-reason, rejected orders frozen), med-pack
// barcode + label, the scan-first MAR policy (bare administer 409s,
// override audited), exact ward-batch identity, and wristband printing.

import request from 'supertest';
import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { authClient, API_KEY, generateTestToken } from './testClient.js';
import { __resetDrugKbCache } from '../services/clinical/drugKnowledgeBaseService.js';
import { renderWristbandAllergyStrip } from '../routes/clinical/bcmaRoutes.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';
import { reconcileMarSupplyOverride } from '../services/clinical/marSupplyService.js';
import {
  approveWardIndent,
  createWardIndent,
  issueWardIndent,
  receiveWardIndent,
  reserveWardIndent,
} from '../services/ipd/ipdSupportService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
jest.setTimeout(60_000);

const PHONE = `+9199907${String(Date.now() % 10000).padStart(5, '0')}`;
const NURSE_UID = 'b1b1b1b1-1111-4111-8111-b1b1b1b1fd01';
const DOCTOR_UID = 'b1b1b1b1-1111-4111-8111-b1b1b1b1fd02';
const PHARMACIST_UID = 'b1b1b1b1-1111-4111-8111-b1b1b1b1fd03';
const RUN = `${process.pid}-${Date.now()}`;
const BATCH_BARCODE = `B1-BATCH-${RUN}`;
// MAR routes sit behind the patient-access guard: the acting staff member
// must exist in users and hold a care relationship (admission context).
const nurseClient = () => {
  const token = generateTestToken('NURSING_STAFF', { uid: NURSE_UID });
  return {
    get: (path) => request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (path) => request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
};

function nursePostWithKey(path, key) {
  return nurseClient().post(path).set('Idempotency-Key', key);
}

function doctorPostWithKey(path, key) {
  const token = generateTestToken('DOCTOR', { uid: DOCTOR_UID });
  return request(app)
    .post(path)
    .set('x-api-key', API_KEY)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key);
}

let patientId;
let patientUid;
let cleanOrderId; // order with benign items
let riskyOrderId; // order whose items trip a KB contraindication
let maId; // scheduled MAR row for scan-policy tests
let clinicalOrderId;
let wardIndentId;
let wardIndentItemId;
let wardIndentStateVersion;
let catalogId;
let inventoryItemId;
let inventoryBatchId;

async function cleanup() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    await tx.$executeRawUnsafe(
      `DO $cleanup$
       BEGIN
         IF to_regclass('public.mar_supply_reconciliation_command_receipts') IS NOT NULL THEN
           DELETE FROM mar_supply_reconciliation_command_receipts
            WHERE tenant_id = '${DEFAULT_TENANT_ID}'::uuid
              AND medication_administration_id IN (
                SELECT id FROM medication_administrations
                 WHERE tenant_id = '${DEFAULT_TENANT_ID}'::uuid
                   AND medication_name LIKE 'B1TEST%'
              );
         END IF;
       END
      $cleanup$`,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM mar_supply_reconciliation_links
        WHERE tenant_id = $1::uuid
          AND unmatched_consumption_id IN (
            SELECT id FROM mar_supply_consumptions
             WHERE tenant_id = $1::uuid
               AND medication_administration_id IN (
                 SELECT id FROM medication_administrations
                  WHERE tenant_id = $1::uuid AND medication_name LIKE 'B1TEST%'
               )
          )`,
      DEFAULT_TENANT_ID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM idempotency_keys
        WHERE tenant_id = $1::uuid
          AND user_uid IN ($2::uuid, $3::uuid, $4::uuid)
          AND request_key LIKE 'b1-mar-%'`,
      DEFAULT_TENANT_ID,
      NURSE_UID,
      DOCTOR_UID,
      PHARMACIST_UID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM notification_outbox
        WHERE tenant_id = $1::uuid
          AND payload->>'exception_case_id' IN (
            SELECT exception_case.id::text
              FROM mar_medication_exception_cases exception_case
              JOIN medication_administrations administration
                ON administration.tenant_id = exception_case.tenant_id
               AND administration.id = exception_case.medication_administration_id
             WHERE exception_case.tenant_id = $1::uuid
               AND administration.medication_name LIKE 'B1TEST%'
          )`,
      DEFAULT_TENANT_ID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM mar_medication_exception_events
        WHERE tenant_id = $1::uuid
          AND medication_administration_id IN (
            SELECT id FROM medication_administrations
             WHERE tenant_id = $1::uuid AND medication_name LIKE 'B1TEST%'
          )`,
      DEFAULT_TENANT_ID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND source_table = 'mar_medication_exception_cases'
          AND source_id IN (
            SELECT exception_case.id::text
              FROM mar_medication_exception_cases exception_case
              JOIN medication_administrations administration
                ON administration.tenant_id = exception_case.tenant_id
               AND administration.id = exception_case.medication_administration_id
             WHERE exception_case.tenant_id = $1::uuid
               AND administration.medication_name LIKE 'B1TEST%'
          )`,
      DEFAULT_TENANT_ID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'mar_medication_exception_cases'
          AND related_resource_id IN (
            SELECT exception_case.id::text
              FROM mar_medication_exception_cases exception_case
              JOIN medication_administrations administration
                ON administration.tenant_id = exception_case.tenant_id
               AND administration.id = exception_case.medication_administration_id
             WHERE exception_case.tenant_id = $1::uuid
               AND administration.medication_name LIKE 'B1TEST%'
          )`,
      DEFAULT_TENANT_ID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM mar_medication_exception_cases
        WHERE tenant_id = $1::uuid
          AND medication_administration_id IN (
            SELECT id FROM medication_administrations
             WHERE tenant_id = $1::uuid AND medication_name LIKE 'B1TEST%'
          )`,
      DEFAULT_TENANT_ID,
    ).catch(() => {});
    for (const table of [
      'mar_administration_command_receipts',
      'mar_transition_command_receipts',
      'mar_supply_consumptions',
    ]) {
      await tx.$executeRawUnsafe(
        `DELETE FROM ${table}
          WHERE tenant_id = $1::uuid
            AND medication_administration_id IN (
              SELECT id FROM medication_administrations
               WHERE tenant_id = $1::uuid AND medication_name LIKE 'B1TEST%'
            )`,
        DEFAULT_TENANT_ID,
      ).catch(() => {});
    }
    await tx.$executeRawUnsafe(
      `DELETE FROM ward_indent_inventory_receipt_events
        WHERE tenant_id = $1::uuid
          AND received_by = $2::uuid
          AND command_key LIKE '%b1-mar-receive-%'`,
      DEFAULT_TENANT_ID,
      NURSE_UID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM notification_outbox
        WHERE tenant_id = $1::uuid
          AND source_event_key LIKE 'mar-supply:%'
          AND payload->>'medication_administration_id' IN (
            SELECT id::text FROM medication_administrations
             WHERE tenant_id = $1::uuid AND medication_name LIKE 'B1TEST%'
          )`,
      DEFAULT_TENANT_ID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND id IN (
            SELECT workflow_sla_instance_id
              FROM tasks
             WHERE tenant_id = $1::uuid
               AND related_resource_type = 'medication_administrations'
               AND related_resource_id IN (
                 SELECT id::text FROM medication_administrations
                  WHERE tenant_id = $1::uuid AND medication_name LIKE 'B1TEST%'
               )
          )`,
      DEFAULT_TENANT_ID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'medication_administrations'
          AND related_resource_id IN (
            SELECT id::text FROM medication_administrations
             WHERE tenant_id = $1::uuid AND medication_name LIKE 'B1TEST%'
          )`,
      DEFAULT_TENANT_ID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM pharmacy_stock_movements
        WHERE tenant_id = $1::uuid
          AND performed_by = $2::uuid
          AND reference_type = 'ward_indent_allocation'`,
      DEFAULT_TENANT_ID,
      PHARMACIST_UID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM billing_invoice_items
        WHERE tenant_id = $1::uuid
          AND id IN (
            SELECT invoice_item_id
              FROM ward_indent_financial_events
             WHERE tenant_id = $1::uuid
               AND actor_uid = $2::uuid
               AND invoice_item_id IS NOT NULL
          )`,
      DEFAULT_TENANT_ID,
      PHARMACIST_UID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM billing_invoices
        WHERE tenant_id = $1::uuid
          AND id IN (
            SELECT invoice_id
              FROM ward_indent_financial_events
             WHERE tenant_id = $1::uuid
               AND actor_uid = $2::uuid
               AND invoice_id IS NOT NULL
          )`,
      DEFAULT_TENANT_ID,
      PHARMACIST_UID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM ward_indent_financial_events
        WHERE tenant_id = $1::uuid AND actor_uid = $2::uuid`,
      DEFAULT_TENANT_ID,
      PHARMACIST_UID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM ward_indent_inventory_movement_links
        WHERE tenant_id = $1::uuid
          AND allocation_id IN (
            SELECT allocation.id
              FROM ward_indent_inventory_allocations allocation
              JOIN ward_indent_items item
                ON item.tenant_id = allocation.tenant_id
               AND item.id = allocation.ward_indent_item_id
              JOIN clinical_orders clinical_order
                ON clinical_order.tenant_id = item.tenant_id
               AND clinical_order.id = item.clinical_order_id
             WHERE allocation.tenant_id = $1::uuid
               AND clinical_order.order_number LIKE 'B1-MAR-%'
          )`,
      DEFAULT_TENANT_ID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM ward_indent_inventory_allocations
        WHERE tenant_id = $1::uuid
          AND ward_indent_id IN (
            SELECT item.ward_indent_id
              FROM ward_indent_items item
              JOIN clinical_orders clinical_order
                ON clinical_order.tenant_id = item.tenant_id
               AND clinical_order.id = item.clinical_order_id
             WHERE item.tenant_id = $1::uuid
               AND clinical_order.order_number LIKE 'B1-MAR-%'
          )`,
      DEFAULT_TENANT_ID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM ward_indent_events
        WHERE tenant_id = $1::uuid
          AND ward_indent_id IN (
            SELECT item.ward_indent_id
              FROM ward_indent_items item
              JOIN clinical_orders clinical_order
                ON clinical_order.tenant_id = item.tenant_id
               AND clinical_order.id = item.clinical_order_id
             WHERE item.tenant_id = $1::uuid
               AND clinical_order.order_number LIKE 'B1-MAR-%'
          )`,
      DEFAULT_TENANT_ID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM ward_indent_items
        WHERE tenant_id = $1::uuid
          AND ward_indent_id IN (
            SELECT item.ward_indent_id
              FROM ward_indent_items item
              JOIN clinical_orders clinical_order
                ON clinical_order.tenant_id = item.tenant_id
               AND clinical_order.id = item.clinical_order_id
             WHERE item.tenant_id = $1::uuid
               AND clinical_order.order_number LIKE 'B1-MAR-%'
          )`,
      DEFAULT_TENANT_ID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM ward_indents
        WHERE tenant_id = $1::uuid
          AND id NOT IN (
            SELECT ward_indent_id FROM ward_indent_items WHERE tenant_id = $1::uuid
          )
          AND requested_by = $2::uuid
          AND ward_id IN (
            SELECT id FROM wards
             WHERE tenant_id = $1::uuid AND name LIKE 'B1TEST MAR Ward%'
          )`,
      DEFAULT_TENANT_ID,
      NURSE_UID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM medication_administrations
        WHERE tenant_id = $1::uuid AND medication_name LIKE 'B1TEST%'`,
      DEFAULT_TENANT_ID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_orders
        WHERE tenant_id = $1::uuid AND order_number LIKE 'B1-MAR-%'`,
      DEFAULT_TENANT_ID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND batch_number LIKE 'B1-MAR-%'`,
      DEFAULT_TENANT_ID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM pharmacy_inventory_items
        WHERE tenant_id = $1::uuid AND sku_code LIKE 'B1-MAR-%'`,
      DEFAULT_TENANT_ID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM pharmacy_catalog
        WHERE tenant_id = $1::uuid AND name LIKE 'B1TEST MAR Catalog%'`,
      DEFAULT_TENANT_ID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM wards
        WHERE tenant_id = $1::uuid AND name LIKE 'B1TEST MAR Ward%'`,
      DEFAULT_TENANT_ID,
    ).catch(() => {});
  }).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_administrations WHERE medication_name LIKE 'B1TEST%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_safety_reviews WHERE patient_uid IN (SELECT uid FROM users WHERE name = 'B1TEST Patient')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM pharmacy_order_history WHERE order_id IN (SELECT id FROM pharmacy_orders WHERE patient_name = 'B1TEST Patient')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM pharmacy_orders WHERE patient_name = 'B1TEST Patient'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM admissions WHERE ward = 'B1TEST Ward'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_access_audit_log WHERE patient_uid IN (SELECT uid FROM users WHERE name LIKE 'B1TEST%')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM staff WHERE tenant_id = $1::uuid AND user_id IN ($2::uuid, $3::uuid, $4::uuid)`,
    DEFAULT_TENANT_ID,
    NURSE_UID,
    DOCTOR_UID,
    PHARMACIST_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name LIKE 'B1TEST%'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, NURSE_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, DOCTOR_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PHARMACIST_UID).catch(() => {});
}

async function createMarAdministration({
  scheduledOffsetHours = 0,
  status = 'scheduled',
  dose = '500mg',
  route = 'oral',
  supplyQuantity = 1,
} = {}) {
  const scheduledAt = new Date(Date.now() + scheduledOffsetHours * 60 * 60 * 1000).toISOString();
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO medication_administrations
       (tenant_id, patient_uid, medication_name, dose, route, scheduled_time,
        status, clinical_order_id, supply_quantity_per_dose)
     VALUES ($1::uuid, $2::uuid, 'B1TEST Paracetamol 500mg', $6::text,
             $7::text, $3::timestamptz, $4::text, $5::int, $8::numeric)
     RETURNING id`,
    DEFAULT_TENANT_ID,
    patientUid,
    scheduledAt,
    status,
    clinicalOrderId,
    dose,
    route,
    supplyQuantity,
  );
  return Number(rows[0].id);
}

d('BCMA closed loop — deep round-trip (roadmap B1)', () => {
  beforeAll(async () => {
    await cleanup();
    __resetDrugKbCache();

    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, birthday, gender, updated_at)
       VALUES ($1, 'B1TEST Patient', 'PATIENT', true, '1985-05-05', 'male', NOW()) RETURNING id, uid`,
      PHONE,
    );
    patientId = Number(p[0].id);
    patientUid = p[0].uid;

    const clean = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_orders (patient_id, patient_name, phone, order_note, status, delivery_type, items_list, total_amount, updated_at)
       VALUES ($1, 'B1TEST Patient', $2, 'B1TEST order', 'CONFIRMED', 'counter',
               '[{"name":"B1TEST Paracetamol 500mg","dose":"500mg","frequency":"TDS","qty":10,"price":2}]'::jsonb, 20, NOW())
       RETURNING id`,
      patientId, PHONE,
    );
    cleanOrderId = Number(clean[0].id);

    const risky = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_orders (patient_id, patient_name, phone, order_note, status, delivery_type, items_list, total_amount, updated_at)
       VALUES ($1, 'B1TEST Patient', $2, 'B1TEST order', 'CONFIRMED', 'counter',
               '[{"name":"Tab Sildenafil 50mg","dose":"50mg","frequency":"OD","qty":4,"price":50},
                 {"name":"Sorbitrate (isosorbide) 10mg","dose":"10mg","frequency":"BD","qty":10,"price":5}]'::jsonb, 250, NOW())
       RETURNING id`,
      patientId, PHONE,
    );
    riskyOrderId = Number(risky[0].id);

    // Acting nurse must exist in users for the access-decision layer.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'B1TEST Nurse', 'NURSING_STAFF', true, NOW())
       ON CONFLICT (uid) DO NOTHING`,
      NURSE_UID, `+9199908${String(Date.now() % 10000).padStart(5, '0')}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, status, updated_at)
       VALUES ($1::uuid, $2, 'B1TEST Prescriber', 'DOCTOR', true, 'active', NOW())
       ON CONFLICT (uid) DO NOTHING`,
      DOCTOR_UID,
      `+9199909${String(Date.now() % 10000).padStart(5, '0')}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, status, updated_at)
       VALUES ($1::uuid, $2, 'B1TEST Pharmacist', 'PHARMACY_INCHARGE', true, 'active', NOW())
       ON CONFLICT (uid) DO NOTHING`,
      PHARMACIST_UID,
      `+9199910${String(Date.now() % 10000).padStart(5, '0')}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff
         (tenant_id, user_id, employee_id, name, designation, skills,
          certifications, is_active, archived, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::text, 'B1TEST Prescriber', 'Doctor',
               '{}'::text[], '{}'::text[], TRUE, FALSE, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      DEFAULT_TENANT_ID,
      DOCTOR_UID,
      `B1-DOC-${RUN}`,
    );

    // Active admission — gives the MAR access guard an admission-context
    // care relationship for this patient (BCMA is an inpatient loop).
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions
         (patient_uid, allergies, status, admitted_at, ward, bed_number,
          created_by, attending_doctor, created_at, updated_at)
       VALUES ($1::uuid, '{}', 'admitted', NOW(), 'B1TEST Ward', 'B1T-01',
               $2::uuid, $3::uuid, NOW(), NOW())`,
      patientUid, NURSE_UID, DOCTOR_UID,
    );

    const catalog = (await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, strength, strength_key, form, form_key, route,
          is_active, is_available, in_stock, stock_quantity, updated_at)
       VALUES ($1::uuid, $2::text, '500 mg', '500mg', 'tablet', 'tablet',
               'oral', TRUE, TRUE, TRUE, 50, NOW())
       RETURNING id`,
      DEFAULT_TENANT_ID,
      `B1TEST MAR Catalog ${RUN}`,
    ))[0];
    catalogId = Number(catalog.id);
    const inventoryItem = (await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, catalog_id, form, strength,
          unit_label, schedule_class, is_narcotic, status, metadata)
       VALUES ($1::uuid, $2::text, 'B1TEST Paracetamol 500mg', $3::int,
               'tablet', '500 mg', 'tablet', 'OTC', FALSE, 'active', '{}'::jsonb)
       RETURNING id`,
      DEFAULT_TENANT_ID,
      `B1-MAR-SKU-${RUN}`,
      Number(catalog.id),
    ))[0];
    inventoryItemId = Number(inventoryItem.id);
    const batch = (await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, lot_number, expiry_date,
          received_quantity, remaining_quantity, status, metadata)
       VALUES ($1::uuid, $2::int, $3::text, $4::text,
               (CURRENT_DATE + INTERVAL '365 days')::date,
                20, 20, 'in_stock', jsonb_build_object('barcode', $5::text))
       RETURNING id`,
      DEFAULT_TENANT_ID,
      Number(inventoryItem.id),
      `B1-MAR-BATCH-${RUN}`,
      `B1-MAR-LOT-${RUN}`,
      BATCH_BARCODE,
    ))[0];
    inventoryBatchId = Number(batch.id);
    const ward = (await prisma.$queryRawUnsafe(
      `INSERT INTO wards (tenant_id, name, total_beds, created_at, updated_at)
       VALUES ($1::uuid, $2::text, 10, NOW(), NOW())
       RETURNING id`,
      DEFAULT_TENANT_ID,
      `B1TEST MAR Ward ${RUN}`,
    ))[0];
    const order = (await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_orders
         (tenant_id, order_number, patient_uid, order_type, status, ordered_by,
          route, details, updated_at)
       VALUES ($1::uuid, $2::text, $3::uuid, 'medication', 'ordered', $4::uuid,
               'oral', jsonb_build_object(
                 'catalog_id', $5::int,
                 'medication_name', 'B1TEST Paracetamol 500mg',
                 'dose', '500mg',
                 'route', 'oral',
                 'strength', '500 mg',
                 'strength_key', '500mg',
                 'form', 'tablet',
                 'form_key', 'tablet'
               ), NOW())
       RETURNING id`,
      DEFAULT_TENANT_ID,
      `B1-MAR-ORDER-${RUN}`,
      patientUid,
      DOCTOR_UID,
      Number(catalog.id),
    ))[0];
    clinicalOrderId = Number(order.id);
    const indent = await createWardIndent({
      wardId: Number(ward.id),
      patientUid,
      indentType: 'pharmacy',
      items: [{
        pharmacy_catalog_id: Number(catalog.id),
        clinical_order_id: clinicalOrderId,
        item_name: 'Caller name is not authoritative',
        quantity_requested: 20,
      }],
      requestedBy: NURSE_UID,
      commandKey: `b1-mar-create-${RUN}`,
      tenantId: DEFAULT_TENANT_ID,
    });
    wardIndentId = Number(indent.id);
    const [indentItem] = await prisma.$queryRawUnsafe(
      `SELECT id FROM ward_indent_items
        WHERE tenant_id = $1::uuid AND ward_indent_id = $2::int
        LIMIT 1`,
      DEFAULT_TENANT_ID,
      wardIndentId,
    );
    wardIndentItemId = Number(indentItem.id);
    const reserved = await reserveWardIndent({
      indentId: wardIndentId,
      reservedBy: PHARMACIST_UID,
      expectedVersion: indent.state_version,
      commandKey: `b1-mar-reserve-${RUN}`,
      tenantId: DEFAULT_TENANT_ID,
    });
    const approved = await approveWardIndent({
      indentId: wardIndentId,
      approvedBy: PHARMACIST_UID,
      expectedVersion: reserved.state_version,
      commandKey: `b1-mar-approve-${RUN}`,
      tenantId: DEFAULT_TENANT_ID,
    });
    const issued = await issueWardIndent({
      indentId: wardIndentId,
      issuedBy: PHARMACIST_UID,
      expectedVersion: approved.state_version,
      commandKey: `b1-mar-issue-${RUN}`,
      tenantId: DEFAULT_TENANT_ID,
    });
    const received = await receiveWardIndent({
      indentId: wardIndentId,
      receivedBy: NURSE_UID,
      itemQuantitiesReceived: [{ item_id: wardIndentItemId, quantity_received: 5 }],
      expectedVersion: issued.state_version,
      commandKey: `b1-mar-receive-${RUN}`,
      tenantId: DEFAULT_TENANT_ID,
    });
    wardIndentStateVersion = received.state_version;

    const ma = await prisma.$queryRawUnsafe(
      `INSERT INTO medication_administrations
         (tenant_id, patient_uid, medication_name, dose, route, scheduled_time,
          status, clinical_order_id, supply_quantity_per_dose)
       VALUES ($1::uuid, $2::uuid, 'B1TEST Paracetamol 500mg', '500mg',
               'oral', NOW(), 'scheduled', $3::int, 1)
       RETURNING id`,
      DEFAULT_TENANT_ID,
      patientUid,
      clinicalOrderId,
    );
    maId = Number(ma[0].id);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('PREPARING is blocked until pharmacist verification clears', async () => {
    const res = await authClient('PHARMACY_STAFF').post(`/api/v1/pharmacy/orders/${cleanOrderId}/preparing`);
    expect(res.status).toBe(409);
  });

  test('counter dispense is blocked until verification clears', async () => {
    const res = await authClient('PHARMACY_STAFF')
      .post(`/api/v1/pharmacy/orders/${cleanOrderId}/dispense-counter`)
      .send({ payment_mode: 'cash', amount_collected: 20 });
    expect(res.status).toBe(409);
  });

  test('clean order verifies; preparing then proceeds; safety event lands on the timeline', async () => {
    const verify = await authClient('PHARMACY_STAFF')
      .post(`/api/v1/pharmacy/orders/${cleanOrderId}/verify`)
      .send({ decision: 'verified', notes: 'B1TEST reviewed against allergies/KB' });
    expect(verify.status).toBe(200);
    expect(verify.body.data.order.clinical_verification_status).toBe('verified');
    expect(verify.body.data.safety.blockers).toHaveLength(0);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
        WHERE source_table = 'pharmacy_orders' AND source_id = $1
          AND event_type = 'pharmacy.order_clinically_verified'`,
      String(cleanOrderId),
    );
    expect(timeline.length).toBeGreaterThanOrEqual(1);

    const preparing = await authClient('PHARMACY_STAFF').post(`/api/v1/pharmacy/orders/${cleanOrderId}/preparing`);
    expect(preparing.status).toBe(200);
  });

  test('risky order: verify refused with blockers; override requires a reason and records reviews', async () => {
    const verify = await authClient('PHARMACY_STAFF')
      .post(`/api/v1/pharmacy/orders/${riskyOrderId}/verify`)
      .send({ decision: 'verified' });
    expect(verify.status).toBe(409);
    expect(verify.body.details.blockers.length).toBeGreaterThanOrEqual(1);

    const badOverride = await authClient('PHARMACY_STAFF')
      .post(`/api/v1/pharmacy/orders/${riskyOrderId}/verify`)
      .send({ decision: 'override', override_reason: 'short' });
    expect(badOverride.status).toBe(400);

    const override = await authClient('PHARMACY_STAFF')
      .post(`/api/v1/pharmacy/orders/${riskyOrderId}/verify`)
      .send({
        decision: 'override',
        override_reason: 'B1TEST cardiologist confirmed nitrate stopped 48h ago',
      });
    expect(override.status).toBe(200);
    expect(override.body.data.order.clinical_verification_status).toBe('override');

    const reviews = await prisma.$queryRawUnsafe(
      `SELECT review_type, status, override_reason FROM medication_safety_reviews
        WHERE patient_uid = $1::uuid AND override_reason LIKE 'B1TEST%'`,
      patientUid,
    );
    expect(reviews.length).toBeGreaterThanOrEqual(1);
    expect(reviews.some((r) => r.status === 'overridden')).toBe(true);
  });

  test('pack label issues a stable VHMP barcode after verification', async () => {
    const label = await authClient('PHARMACY_STAFF').get(`/api/v1/pharmacy/orders/${cleanOrderId}/pack-label`);
    expect(label.status).toBe(200);
    expect(label.body.data.pack_barcode).toMatch(/^VHMP-\d+-[0-9A-F]{8}$/);
    expect(label.body.data.items[0].name).toContain('B1TEST Paracetamol');

    const again = await authClient('PHARMACY_STAFF').get(`/api/v1/pharmacy/orders/${cleanOrderId}/pack-label`);
    expect(again.body.data.pack_barcode).toBe(label.body.data.pack_barcode);
  });

  test('MAR: bare administer 409s under scan-first policy; override is persisted + audited', async () => {
    const bare = await nursePostWithKey(
      `/api/v1/clinical/mar/${maId}/administer`,
      `b1-mar-bare-${RUN}`,
    ).send({});
    expect(bare.status).toBe(409);

    const withReason = await nursePostWithKey(
      `/api/v1/clinical/mar/${maId}/administer`,
      `b1-mar-override-${RUN}`,
    )
      .send({ override_reason: 'B1TEST scanner battery dead, identity verified verbally' });
    expect(withReason.status).toBe(200);
    expect(withReason.body.data.override_reason).toMatch(/scanner battery dead/);

    // C-M1: the no-scan override is a medication-safety override and must land
    // a medication_safety_reviews row in the same transaction (canonical
    // invariant item 5) — status 'overridden' with the documented reason.
    const reviews = await prisma.$queryRawUnsafe(
      `SELECT review_type, status, override_required, override_reason
         FROM medication_safety_reviews
        WHERE patient_uid = $1::uuid AND review_type = 'bcma_no_scan_override'
          AND payload->>'medication_administration_id' = $2`,
      patientUid, String(maId),
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0].status).toBe('overridden');
    expect(reviews[0].override_required).toBe(true);
    expect(reviews[0].override_reason).toMatch(/scanner battery dead/);
  });

  test('MAR supply reconciliation stores and replays one durable whole-command receipt', async () => {
    const reconciliationMaId = await createMarAdministration({
      scheduledOffsetHours: 6,
      supplyQuantity: 5,
    });
    const unmatched = await nursePostWithKey(
      `/api/v1/clinical/mar/${reconciliationMaId}/administer`,
      `b1-mar-reconcile-source-${RUN}`,
    ).send({
      override_reason: 'B1TEST scanner downtime administration documented at bedside',
      supply_override_reason: 'B1TEST received substitution awaits ward acknowledgement and exact stock reconciliation',
    });
    expect(unmatched.status).toBe(200);
    const received = await receiveWardIndent({
      indentId: wardIndentId,
      receivedBy: NURSE_UID,
      itemQuantitiesReceived: [{ item_id: wardIndentItemId, quantity_received: 20 }],
      expectedVersion: wardIndentStateVersion,
      commandKey: `b1-mar-receive-remainder-${RUN}`,
      tenantId: DEFAULT_TENANT_ID,
    });
    wardIndentStateVersion = received.state_version;

    const [consumption] = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM mar_supply_consumptions
        WHERE tenant_id = $1::uuid
          AND medication_administration_id = $2::int
          AND evidence_status = 'unmatched_override'
        LIMIT 1`,
      DEFAULT_TENANT_ID,
      reconciliationMaId,
    );
    const [allocation] = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM ward_indent_inventory_allocations
        WHERE tenant_id = $1::uuid
          AND ward_indent_id = $2::int
        LIMIT 1`,
      DEFAULT_TENANT_ID,
      wardIndentId,
    );
    expect(consumption).toBeDefined();
    expect(allocation).toBeDefined();

    const commandKey = `b1-mar-reconcile-${RUN}`;
    const options = {
      tenantId: DEFAULT_TENANT_ID,
      reconciledBy: NURSE_UID,
      commandKey,
      expectedMedicationAdministrationId: reconciliationMaId,
    };
    const recorded = await reconcileMarSupplyOverride(
      consumption.id,
      [
        { inventory_allocation_id: allocation.id, quantity: 0.25 },
        { inventory_allocation_id: allocation.id, quantity: 4.75 },
      ],
      options,
    );
    const replay = await reconcileMarSupplyOverride(
      consumption.id,
      [{ inventory_allocation_id: allocation.id, quantity: 5 }],
      options,
    );
    expect(replay).toEqual(recorded);

    const receipts = await prisma.$queryRawUnsafe(
      `SELECT command_key, request_body_sha256, response_data
         FROM mar_supply_reconciliation_command_receipts
        WHERE tenant_id = $1::uuid AND command_key = $2::text`,
      DEFAULT_TENANT_ID,
      commandKey,
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0].request_body_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipts[0].response_data).toEqual(recorded);

    await expect(reconcileMarSupplyOverride(
      consumption.id,
      [{ inventory_allocation_id: allocation.id, quantity: 4.5 }],
      options,
    )).rejects.toMatchObject({
      statusCode: 422,
      code: 'MAR_SUPPLY_RECONCILIATION_COMMAND_MISMATCH',
    });
  });

  test('C-M1: a soft-right (time) override with scan records one overridden safety review per failed right', async () => {
    // Dose scheduled 3 hours ago — right-time fails (±60 min window); patient
    // and drug scans match, so only the soft right blocks.
    const lateId = await createMarAdministration({ scheduledOffsetHours: -3 });

    const noOverride = await nursePostWithKey(
      `/api/v1/clinical/mar/${lateId}/administer-with-scan`,
      `b1-mar-late-blocked-${RUN}`,
    )
      .send({
        scanned_patient_uid: patientUid,
        scanned_barcode: BATCH_BARCODE,
      });
    expect(noOverride.status).toBe(409);

    const overridden = await nursePostWithKey(
      `/api/v1/clinical/mar/${lateId}/administer-with-scan`,
      `b1-mar-late-override-${RUN}`,
    )
      .send({
        scanned_patient_uid: patientUid,
        scanned_barcode: BATCH_BARCODE,
        override_reason: 'B1TEST dose delayed in theatre recovery, charge nurse approved late administration',
      });
    expect(overridden.status).toBe(200);
    expect(overridden.body.data.status).toBe('administered');

    const reviews = await prisma.$queryRawUnsafe(
      `SELECT review_type, status, severity, override_required, override_reason, payload
         FROM medication_safety_reviews
        WHERE patient_uid = $1::uuid
          AND payload->>'medication_administration_id' = $2`,
      patientUid, String(lateId),
    );
    expect(reviews).toHaveLength(1); // exactly one failed right → exactly one finding
    expect(reviews[0].review_type).toBe('bcma_right_time');
    expect(reviews[0].status).toBe('overridden');
    expect(reviews[0].override_required).toBe(true);
    expect(reviews[0].override_reason).toMatch(/theatre recovery/);
    const payload = typeof reviews[0].payload === 'string' ? JSON.parse(reviews[0].payload) : reviews[0].payload;
    expect(Math.abs(Number(payload.minutes_from_scheduled))).toBeGreaterThan(60);
  });

  test('C-M1: a clean all-rights-passed scan administration records no safety review', async () => {
    const cleanMaId = await createMarAdministration();

    const res = await nursePostWithKey(
      `/api/v1/clinical/mar/${cleanMaId}/administer-with-scan`,
      `b1-mar-clean-${RUN}`,
    )
      .send({
        scanned_patient_uid: patientUid,
        scanned_barcode: BATCH_BARCODE,
      });
    expect(res.status).toBe(200);

    const reviews = await prisma.$queryRawUnsafe(
      `SELECT id FROM medication_safety_reviews
        WHERE patient_uid = $1::uuid
          AND payload->>'medication_administration_id' = $2`,
      patientUid, String(cleanMaId),
    );
    expect(reviews).toHaveLength(0);
  });

  test('B4.2: a mismatched patient scan is a NON-overridable hard-stop (audit F-H1)', async () => {
    // Fresh scheduled row for this patient.
    const scanMaId = await createMarAdministration();

    // Mismatched wristband UID (NURSE_UID is a real user but not this MA's
    // patient) with no override → wrong-patient hard-stop, 409 MAR_PATIENT_MISMATCH.
    const mismatch = await nursePostWithKey(
      `/api/v1/clinical/mar/${scanMaId}/administer-with-scan`,
      `b1-mar-patient-mismatch-${RUN}`,
    )
      .send({
        scanned_patient_uid: NURSE_UID,
        scanned_barcode: BATCH_BARCODE,
      });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe('MAR_PATIENT_MISMATCH');

    // The canonical BCMA never-event: the SAME wrong-patient scan WITH a
    // documented override must STILL be refused — wrong-patient is not a
    // justify-and-proceed. The order must remain unadministered.
    const overridden = await nursePostWithKey(
      `/api/v1/clinical/mar/${scanMaId}/administer-with-scan`,
      `b1-mar-patient-mismatch-override-${RUN}`,
    )
      .send({
        scanned_patient_uid: NURSE_UID,
        scanned_barcode: BATCH_BARCODE,
        override_reason: 'B1TEST wristband unreadable; identity confirmed verbally + ID band',
      });
    expect(overridden.status).toBe(409);
    expect(overridden.body.code).toBe('MAR_PATIENT_MISMATCH');

    // Defence-in-depth: confirm the row was never flipped to administered.
    const after = await prisma.$queryRawUnsafe(
      `SELECT status FROM medication_administrations WHERE id = $1`,
      scanMaId,
    );
    expect(after[0].status).toBe('scheduled');
  });

  test('held dose stays blocked until a prescriber releases it; release replay is exact and changed body conflicts', async () => {
    const heldMaId = await createMarAdministration();
    const held = await nursePostWithKey(
      `/api/v1/clinical/mar/${heldMaId}/hold`,
      `b1-mar-hold-${RUN}`,
    ).send({ reason: 'B1TEST awaiting prescriber review after blood-pressure change' });
    expect(held.status).toBe(200);
    expect(held.body.data).toMatchObject({
      id: heldMaId,
      status: 'held',
      held_by: NURSE_UID,
    });

    const blocked = await nursePostWithKey(
      `/api/v1/clinical/mar/${heldMaId}/administer-with-scan`,
      `b1-mar-held-blocked-${RUN}`,
    ).send({
      scanned_patient_uid: patientUid,
      scanned_barcode: BATCH_BARCODE,
      override_reason: 'B1TEST bedside staff cannot override a prescriber hold',
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('MAR_HOLD_RELEASE_REQUIRED');

    const releaseKey = `b1-mar-release-hold-${RUN}`;
    const releaseBody = {
      reason: 'B1TEST prescriber reviewed observations and approved this scheduled dose',
    };
    const released = await doctorPostWithKey(
      `/api/v1/clinical/mar/${heldMaId}/release-hold`,
      releaseKey,
    ).send(releaseBody);
    expect(released.status).toBe(200);
    expect(released.body.data).toMatchObject({
      id: heldMaId,
      status: 'scheduled',
      hold_reason: 'B1TEST awaiting prescriber review after blood-pressure change',
      held_by: NURSE_UID,
    });

    const replay = await doctorPostWithKey(
      `/api/v1/clinical/mar/${heldMaId}/release-hold`,
      releaseKey,
    ).send(releaseBody);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(released.body);

    const changedBody = await doctorPostWithKey(
      `/api/v1/clinical/mar/${heldMaId}/release-hold`,
      releaseKey,
    ).send({ reason: 'B1TEST a different prescriber release rationale' });
    expect(changedBody.status).toBe(422);

    const events = await prisma.$queryRawUnsafe(
      `SELECT event_type, payload
         FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND source_table = 'medication_administrations'
          AND source_id = $2::text
          AND event_type = 'mar.hold_released'`,
      DEFAULT_TENANT_ID,
      String(heldMaId),
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      release_reason: releaseBody.reason,
      held_reason: 'B1TEST awaiting prescriber review after blood-pressure change',
    });
  });

  test('5-rights rejects product-pack evidence and accepts the exact eligible ward batch', async () => {
    const verifyMaId = await createMarAdministration();
    const labelRes = await authClient('PHARMACY_STAFF').get(`/api/v1/pharmacy/orders/${cleanOrderId}/pack-label`);
    const packBarcode = labelRes.body.data.pack_barcode;

    const productOnly = await nurseClient()
      .post('/api/v1/clinical/mar/verify')
      .send({
        ma_id: verifyMaId,
        scanned_patient_uid: patientUid,
        scanned_barcode: packBarcode,
      });
    expect(productOnly.status).toBe(200);
    expect(productOnly.body.data.rights.drug).toBe(false);
    expect(productOnly.body.data.context.identityFailure).toBe('authoritative_batch_barcode_mismatch');

    const exactBatch = await nurseClient()
      .post('/api/v1/clinical/mar/verify')
      .send({
        ma_id: verifyMaId,
        scanned_patient_uid: patientUid,
        scanned_barcode: BATCH_BARCODE,
      });
    expect(exactBatch.status).toBe(200);
    expect(exactBatch.body.data.rights).toMatchObject({
      patient: true,
      drug: true,
      dose: true,
      route: true,
    });
    expect(exactBatch.body.data.context.drugMatchMode).toBe('inventory_batch_barcode');
  });

  test('last-unit issue keeps a depleted central batch administerable from received ward custody', async () => {
    const batch = (await prisma.$queryRawUnsafe(
      `SELECT status, remaining_quantity
         FROM pharmacy_inventory_batches
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      DEFAULT_TENANT_ID,
      inventoryBatchId,
    ))[0];
    expect(batch.status).toBe('depleted');
    expect(Number(batch.remaining_quantity)).toBe(0);

    const allocation = (await prisma.$queryRawUnsafe(
      `SELECT id, received_quantity, consumed_quantity, returned_quantity
         FROM ward_indent_inventory_allocations
        WHERE tenant_id = $1::uuid
          AND ward_indent_item_id = $2::int
          AND inventory_batch_id = $3::int`,
      DEFAULT_TENANT_ID,
      wardIndentItemId,
      inventoryBatchId,
    ))[0];
    expect(Number(allocation.received_quantity)
      - Number(allocation.consumed_quantity)
      - Number(allocation.returned_quantity)).toBeGreaterThan(0);

    const depletedMaId = await createMarAdministration();
    const verify = await nurseClient()
      .post('/api/v1/clinical/mar/verify')
      .send({
        ma_id: depletedMaId,
        scanned_patient_uid: patientUid,
        scanned_barcode: BATCH_BARCODE,
      });
    expect(verify.status).toBe(200);
    expect(verify.body.data.rights).toMatchObject({
      patient: true,
      drug: true,
      dose: true,
      route: true,
    });
    expect(verify.body.data.context).toMatchObject({
      batchStatus: 'depleted',
      identityFailure: null,
    });

    const administered = await nursePostWithKey(
      `/api/v1/clinical/mar/${depletedMaId}/administer-with-scan`,
      `b1-mar-depleted-ward-custody-${RUN}`,
    ).send({
      scanned_patient_uid: patientUid,
      scanned_barcode: BATCH_BARCODE,
    });
    expect(administered.status).toBe(200);
    expect(administered.body.data).toMatchObject({
      id: depletedMaId,
      status: 'administered',
    });
    const consumptions = await prisma.$queryRawUnsafe(
      `SELECT inventory_allocation_id, inventory_batch_id, ward_indent_item_id, quantity
         FROM mar_supply_consumptions
        WHERE tenant_id = $1::uuid
          AND medication_administration_id = $2::bigint`,
      DEFAULT_TENANT_ID,
      depletedMaId,
    );
    expect(consumptions).toHaveLength(1);
    expect(Number(consumptions[0].inventory_allocation_id)).toBe(Number(allocation.id));
    expect(consumptions[0].inventory_batch_id).toBe(inventoryBatchId);
    expect(consumptions[0].ward_indent_item_id).toBe(wardIndentItemId);
    expect(Number(consumptions[0].quantity)).toBe(1);
  });

  test('structured strength, form, dose, and route evidence must agree exactly', async () => {
    const originalDetails = (await prisma.$queryRawUnsafe(
      `SELECT details
         FROM clinical_orders
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      DEFAULT_TENANT_ID,
      clinicalOrderId,
    ))[0].details;
    const verify = (maId) => nurseClient()
      .post('/api/v1/clinical/mar/verify')
      .send({
        ma_id: maId,
        scanned_patient_uid: patientUid,
        scanned_barcode: BATCH_BARCODE,
      });

    try {
      const identityMaId = await createMarAdministration();
      await prisma.$executeRawUnsafe(
        `UPDATE clinical_orders
            SET details = jsonb_set(details, '{strength_key}', '"250mg"'::jsonb),
                updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        DEFAULT_TENANT_ID,
        clinicalOrderId,
      );
      const strengthMismatch = await verify(identityMaId);
      expect(strengthMismatch.body.data.rights.drug).toBe(false);
      expect(strengthMismatch.body.data.context.identityFailure)
        .toBe('strength_evidence_mismatch_or_missing');

      await prisma.$executeRawUnsafe(
        `UPDATE clinical_orders
            SET details = jsonb_set(
              jsonb_set($3::jsonb, '{strength}', '"1.0 mg"'::jsonb),
              '{strength_key}', '"1.0mg"'::jsonb
            ), updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        DEFAULT_TENANT_ID,
        clinicalOrderId,
        JSON.stringify(originalDetails),
      );
      await prisma.$executeRawUnsafe(
        `UPDATE pharmacy_catalog
            SET strength = '10 mg', strength_key = '10mg', updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        DEFAULT_TENANT_ID,
        catalogId,
      );
      await prisma.$executeRawUnsafe(
        `UPDATE pharmacy_inventory_items
            SET strength = '10 mg', updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        DEFAULT_TENANT_ID,
        inventoryItemId,
      );
      const decimalCollision = await verify(identityMaId);
      expect(decimalCollision.body.data.rights.drug).toBe(false);
      expect(decimalCollision.body.data.context.identityFailure)
        .toBe('strength_evidence_mismatch_or_missing');

      await prisma.$executeRawUnsafe(
        `UPDATE clinical_orders
            SET details = jsonb_set($3::jsonb, '{form_key}', '"liquid"'::jsonb),
                updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        DEFAULT_TENANT_ID,
        clinicalOrderId,
        JSON.stringify(originalDetails),
      );
      await prisma.$executeRawUnsafe(
        `UPDATE pharmacy_catalog
            SET strength = '500 mg', strength_key = '500mg', updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        DEFAULT_TENANT_ID,
        catalogId,
      );
      await prisma.$executeRawUnsafe(
        `UPDATE pharmacy_inventory_items
            SET strength = '500 mg', updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        DEFAULT_TENANT_ID,
        inventoryItemId,
      );
      const formMismatch = await verify(identityMaId);
      expect(formMismatch.body.data.rights.drug).toBe(false);
      expect(formMismatch.body.data.context.identityFailure)
        .toBe('form_evidence_mismatch_or_missing');

      await prisma.$executeRawUnsafe(
        `UPDATE clinical_orders
            SET details = $3::jsonb, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        DEFAULT_TENANT_ID,
        clinicalOrderId,
        JSON.stringify(originalDetails),
      );
      const doseMismatch = await verify(await createMarAdministration({ dose: '250mg' }));
      expect(doseMismatch.body.data.rights).toMatchObject({ drug: true, dose: false });

      const routeMismatch = await verify(await createMarAdministration({ route: 'iv' }));
      expect(routeMismatch.body.data.rights).toMatchObject({ drug: true, route: false });

      await prisma.$executeRawUnsafe(
        `UPDATE pharmacy_catalog
            SET route = NULL, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        DEFAULT_TENANT_ID,
        catalogId,
      );
      const missingRouteMaId = await createMarAdministration();
      const missingRoute = await verify(missingRouteMaId);
      expect(missingRoute.body.data.rights).toMatchObject({ drug: true, route: false });
      const missingRouteOverride = await nursePostWithKey(
        `/api/v1/clinical/mar/${missingRouteMaId}/administer-with-scan`,
        `b1-mar-route-evidence-blocked-${RUN}`,
      ).send({
        scanned_patient_uid: patientUid,
        scanned_barcode: BATCH_BARCODE,
        override_reason: 'B1TEST missing catalog route cannot be overridden at bedside',
      });
      expect(missingRouteOverride.status).toBe(409);
      expect(missingRouteOverride.body.code).toBe('MAR_ROUTE_MISMATCH');

      await prisma.$executeRawUnsafe(
        `UPDATE pharmacy_catalog
            SET route = 'oral', updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        DEFAULT_TENANT_ID,
        catalogId,
      );
      const doseHardStopMaId = await createMarAdministration({ dose: '250mg' });
      const doseOverride = await nursePostWithKey(
        `/api/v1/clinical/mar/${doseHardStopMaId}/administer-with-scan`,
        `b1-mar-dose-mismatch-blocked-${RUN}`,
      ).send({
        scanned_patient_uid: patientUid,
        scanned_barcode: BATCH_BARCODE,
        override_reason: 'B1TEST dose mismatch cannot be overridden at bedside',
      });
      expect(doseOverride.status).toBe(409);
      expect(doseOverride.body.code).toBe('MAR_DOSE_MISMATCH');
    } finally {
      await prisma.$executeRawUnsafe(
        `UPDATE clinical_orders
            SET details = $3::jsonb, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        DEFAULT_TENANT_ID,
        clinicalOrderId,
        JSON.stringify(originalDetails),
      );
      await prisma.$executeRawUnsafe(
        `UPDATE pharmacy_catalog
            SET strength = '500 mg', strength_key = '500mg', form = 'tablet',
                form_key = 'tablet', route = 'oral', updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        DEFAULT_TENANT_ID,
        catalogId,
      );
      await prisma.$executeRawUnsafe(
        `UPDATE pharmacy_inventory_items
            SET strength = '500 mg', form = 'tablet', updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        DEFAULT_TENANT_ID,
        inventoryItemId,
      );
    }
  });

  test('recalled, quarantined, and expired exact batches fail closed even with an override', async () => {
    const unsafeMaId = await createMarAdministration();
    const verifyUnsafe = () => nurseClient()
      .post('/api/v1/clinical/mar/verify')
      .send({
        ma_id: unsafeMaId,
        scanned_patient_uid: patientUid,
        scanned_barcode: BATCH_BARCODE,
      });

    for (const status of ['quarantined', 'recalled']) {
      await prisma.$executeRawUnsafe(
        `UPDATE pharmacy_inventory_batches
            SET status = $3::text, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        DEFAULT_TENANT_ID,
        inventoryBatchId,
        status,
      );
      const result = await verifyUnsafe();
      expect(result.status).toBe(200);
      expect(result.body.data.rights.drug).toBe(false);
      expect(result.body.data.context.identityFailure).toBe(`batch_${status}`);
      const blocked = await nursePostWithKey(
        `/api/v1/clinical/mar/${unsafeMaId}/administer-with-scan`,
        `b1-mar-${status}-blocked-${RUN}`,
      ).send({
        scanned_patient_uid: patientUid,
        scanned_barcode: BATCH_BARCODE,
        override_reason: `B1TEST a ${status} batch can never be overridden`,
      });
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('MAR_BATCH_UNAVAILABLE');
    }

    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_inventory_batches
          SET status = 'depleted', expiry_date = (CURRENT_DATE - INTERVAL '1 day')::date,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      DEFAULT_TENANT_ID,
      inventoryBatchId,
    );
    const expired = await verifyUnsafe();
    expect(expired.status).toBe(200);
    expect(expired.body.data.rights.drug).toBe(false);
    expect(expired.body.data.context.identityFailure).toBe('batch_expired');
    const expiredBlocked = await nursePostWithKey(
      `/api/v1/clinical/mar/${unsafeMaId}/administer-with-scan`,
      `b1-mar-expired-blocked-${RUN}`,
    ).send({
      scanned_patient_uid: patientUid,
      scanned_barcode: BATCH_BARCODE,
      override_reason: 'B1TEST an expired batch can never be overridden',
    });
    expect(expiredBlocked.status).toBe(409);
    expect(expiredBlocked.body.code).toBe('MAR_BATCH_UNAVAILABLE');

    const [unchangedAdministration, consumptionCount] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT status
           FROM medication_administrations
          WHERE tenant_id = $1::uuid AND id = $2::bigint`,
        DEFAULT_TENANT_ID,
        unsafeMaId,
      ),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count
           FROM mar_supply_consumptions
          WHERE tenant_id = $1::uuid
            AND medication_administration_id = $2::bigint`,
        DEFAULT_TENANT_ID,
        unsafeMaId,
      ),
    ]);
    expect(unchangedAdministration[0].status).toBe('scheduled');
    expect(Number(consumptionCount[0].count)).toBe(0);

    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_inventory_batches
          SET status = 'depleted', expiry_date = (CURRENT_DATE + INTERVAL '365 days')::date,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      DEFAULT_TENANT_ID,
      inventoryBatchId,
    );
  });

  test('Schedule X bedside administration requires an independent active clinical witness', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_inventory_items
          SET schedule_class = 'X', is_narcotic = TRUE, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      DEFAULT_TENANT_ID,
      inventoryItemId,
    );
    const controlledMaId = await createMarAdministration();
    const body = {
      scanned_patient_uid: patientUid,
      scanned_barcode: BATCH_BARCODE,
    };

    const missing = await nursePostWithKey(
      `/api/v1/clinical/mar/${controlledMaId}/administer-with-scan`,
      `b1-mar-controlled-missing-${RUN}`,
    ).send(body);
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe('MAR_CONTROLLED_WITNESS_REQUIRED');

    const selfWitness = await nursePostWithKey(
      `/api/v1/clinical/mar/${controlledMaId}/administer-with-scan`,
      `b1-mar-controlled-self-${RUN}`,
    ).send({ ...body, witness_uid: NURSE_UID });
    expect(selfWitness.status).toBe(409);
    expect(selfWitness.body.code).toBe('MAR_CONTROLLED_WITNESS_SEPARATION_REQUIRED');

    const unauthorized = await nursePostWithKey(
      `/api/v1/clinical/mar/${controlledMaId}/administer-with-scan`,
      `b1-mar-controlled-unauthorized-${RUN}`,
    ).send({ ...body, witness_uid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    expect(unauthorized.status).toBe(409);
    expect(unauthorized.body.code).toBe('MAR_CONTROLLED_WITNESS_NOT_AUTHORIZED');

    const witnessed = await nursePostWithKey(
      `/api/v1/clinical/mar/${controlledMaId}/administer-with-scan`,
      `b1-mar-controlled-witnessed-${RUN}`,
    ).send({ ...body, witness_uid: DOCTOR_UID });
    expect(witnessed.status).toBe(200);
    expect(witnessed.body.data).toMatchObject({
      id: controlledMaId,
      status: 'administered',
      witness_uid: DOCTOR_UID,
      supply_state: {
        controlled_witness: {
          uid: DOCTOR_UID,
          role: 'DOCTOR',
        },
      },
    });
  });

  test('wristband JSON + printable HTML with Code 39 of the patient UID', async () => {
    const json = await nurseClient().get(`/api/v1/bcma/wristband/${patientUid}`);
    expect(json.status).toBe(200);
    expect(json.body.data.barcode_payload).toBe(patientUid);
    expect(json.body.data.barcode_symbology).toBe('code39');
    expect(json.body.data.patient.name).toBe('B1TEST Patient');
    // C-M8: a successful end-to-end lookup is a VERIFIED result.
    expect(json.body.data.allergies_status).toBe('ok');

    const html = await nurseClient()
      .get(`/api/v1/bcma/wristband/${patientUid}?format=html`);
    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toMatch(/text\/html/);
    expect(html.text).toContain('<svg');
    expect(html.text).toContain(patientUid.toUpperCase());
    // Verified-none renders the (grey) no-known-allergies strip, never the
    // verify-manually warning.
    expect(html.text).toContain('No known allergies recorded');
    expect(html.text).not.toContain('verify manually');

    // Re-audit lane J: the band's `?autoprint=1` trigger is an inline
    // <script>, and the app-wide helmet policy is `script-src 'self'` with no
    // 'unsafe-inline' — so the browser silently refused to run it and
    // autoprint never fired on ANY path. The response now carries its own
    // policy admitting exactly that one script by hash. The digest is taken
    // from the HTML actually received, so any drift between the hashed
    // constant and the rendered script fails right here.
    const inlineScript = html.text.match(/<script>([\s\S]*?)<\/script>/);
    expect(inlineScript).not.toBeNull();
    const scriptDigest = createHash('sha256').update(inlineScript[1], 'utf8').digest('base64');
    const csp = html.headers['content-security-policy'];
    expect(csp).toContain(`script-src 'sha256-${scriptDigest}'`);
    expect(csp).toContain("default-src 'none'");
    // Hash, never a blanket inline allowance.
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);

    // The JSON variant is not a document and keeps the app-wide policy.
    expect(json.headers['content-security-policy']).not.toContain("default-src 'none'");
  });

  test('C-M8: wristband renders known allergens when a source has them', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_allergies (patient_id, patient_uid, allergy_name, severity, is_active)
       VALUES ($1, $2::uuid, 'B1TEST-Penicillin', 'SEVERE', true)`,
      patientId, patientUid,
    );
    try {
      const json = await nurseClient().get(`/api/v1/bcma/wristband/${patientUid}`);
      expect(json.status).toBe(200);
      expect(json.body.data.allergies_status).toBe('ok');
      expect(json.body.data.allergies.map((a) => a.allergen)).toContain('B1TEST-Penicillin');

      const html = await nurseClient().get(`/api/v1/bcma/wristband/${patientUid}?format=html`);
      expect(html.text).toContain('ALLERGIES: B1TEST-Penicillin');
      expect(html.text).not.toContain('No known allergies recorded');
    } finally {
      await prisma.$executeRawUnsafe(
        `DELETE FROM patient_allergies WHERE patient_uid = $1::uuid AND allergy_name = 'B1TEST-Penicillin'`,
        patientUid,
      ).catch(() => {});
    }
  });

  test('C-M8: a failed allergy lookup renders the verify-manually strip, never the false verified-none', () => {
    // The failure branch cannot be forced through the live DB, so pin the
    // exported strip renderer directly (the route feeds it
    // detailed.sourcesFailed.length > 0 || !patientResolved).
    const failedEmpty = renderWristbandAllergyStrip([], true);
    expect(failedEmpty).toContain('ALLERGY STATUS UNAVAILABLE');
    expect(failedEmpty).toContain('verify manually');
    expect(failedEmpty).not.toContain('No known allergies recorded');
    expect(failedEmpty).not.toContain('class="allergies none"'); // loud style, not the grey one

    // Partial failure: show what IS known AND the unavailable warning.
    const failedPartial = renderWristbandAllergyStrip([{ allergen: 'Penicillin' }], true);
    expect(failedPartial).toContain('ALLERGIES: Penicillin');
    expect(failedPartial).toContain('ADDITIONAL ALLERGY SOURCES UNAVAILABLE');

    // Verified-none keeps the existing wording.
    expect(renderWristbandAllergyStrip([], false)).toContain('No known allergies recorded');
  });

  test('rejected orders cannot progress', async () => {
    const blocked = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_orders (patient_id, patient_name, phone, order_note, status, delivery_type, items_list, total_amount, updated_at)
       VALUES ($1, 'B1TEST Patient', $2, 'B1TEST order', 'CONFIRMED', 'counter',
               '[{"name":"B1TEST Cetirizine 10mg","dose":"10mg","qty":5,"price":1}]'::jsonb, 5, NOW())
       RETURNING id`,
      patientId, PHONE,
    );
    const rejectId = Number(blocked[0].id);
    const reject = await authClient('PHARMACY_STAFF')
      .post(`/api/v1/pharmacy/orders/${rejectId}/verify`)
      .send({ decision: 'rejected', notes: 'B1TEST illegible strength — back to prescriber' });
    expect(reject.status).toBe(200);

    const preparing = await authClient('PHARMACY_STAFF').post(`/api/v1/pharmacy/orders/${rejectId}/preparing`);
    expect(preparing.status).toBe(409);
  });
});
