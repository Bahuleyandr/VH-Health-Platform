// Roadmap B1 — BCMA closed loop deep round-trip.
//
// Covers the pharmacist clinical-verification gate (verify → preparing,
// blockers → override-with-reason, rejected orders frozen), med-pack
// barcode + label, the scan-first MAR policy (bare administer 409s,
// override audited), exact ward-batch identity, and wristband printing.
//
// FIXTURE AUTHORITY (migration 753). Every pharmacy row this suite seeds now
// has to satisfy the facility-custody contract the migration declares, and
// every pharmacy call has to arrive with the authority the routes now demand:
//
//   • pharmacy_orders — chk_pharmacy_orders_facility_progression_753 refuses a
//     non-terminal order with a NULL facility_id, so the fixture orders name
//     this suite's own facility. authority_origin is also stamped
//     ('patient_manual', matching zero linked e_prescriptions): a NULL origin
//     fails closed in pharmacistVerificationService's linkage gate, which is
//     the deliberate migration-753 behaviour, not something to seed around.
//   • pharmacy_inventory_items / _batches — batches are facility-scoped to
//     their item (fk_pharmacy_batches_item_facility_753) and in_stock stock
//     needs an exact active storage location
//     (chk_pharmacy_batches_usable_storage_supply_753 plus
//     trg_pharmacy_batch_storage_authority_supply_753).
//   • wards — createWardIndent now refuses a ward with no active facility
//     (WARD_INDENT_FACILITY_REQUIRED), and reserve/approve/issue each assert a
//     pharmacy_staff_facility_grants row for the acting pharmacist.
//   • the /verify, /preparing and /dispense-counter routes require an
//     Idempotency-Key (orderDispenseIdempotency, required: true), and the
//     acting pharmacist must be a real users + staff row holding an active
//     facility grant — so the pharmacy calls act as B1TEST Pharmacist
//     (PHARMACY_INCHARGE, which is also the only role allowed to break-glass
//     override) rather than the shared harness identity.
//
// The delivery/counter split below is a contract change, not a convenience:
// markPreparing refuses a counter order (PHARMACY_ORDER_WRONG_DELIVERY_FLOW)
// and markCounterDispensed refuses a delivery one, so the preparing cases and
// the counter-dispense case need their own fixture orders. No case was
// dropped.

import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import app from '../app.js';
import prisma, { setTenantTx } from '../lib/prisma.js';
import { authClient, API_KEY, generateTestToken } from './testClient.js';
import { __resetDrugKbCache } from '../services/clinical/drugKnowledgeBaseService.js';
import { renderWristbandAllergyStrip } from '../routes/clinical/bcmaRoutes.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';
import { reconcileMarSupplyOverride } from '../services/clinical/marSupplyService.js';
import { verifyOrder } from '../services/emr/orderEntryService.js';
import {
  approveWardIndent,
  createWardIndent,
  issueWardIndent,
  receiveWardIndent,
  reserveWardIndent,
} from '../services/ipd/ipdSupportService.js';
import { bindMedicationOrderCatalogAuthority } from '../services/ipd/wardIndentWorkflowService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
jest.setTimeout(60_000);

const PHONE = `+9199907${String(Date.now() % 10000).padStart(5, '0')}`;
const NURSE_UID = 'b1b1b1b1-1111-4111-8111-b1b1b1b1fd01';
const DOCTOR_UID = 'b1b1b1b1-1111-4111-8111-b1b1b1b1fd02';
const PHARMACIST_UID = 'b1b1b1b1-1111-4111-8111-b1b1b1b1fd03';
const RUN = `${process.pid}-${Date.now()}`;
const BATCH_BARCODE = `B1-BATCH-${RUN}`;
const COMPOSITION_KEYS = Object.freeze({
  paracetamol: `b1test_mar_paracetamol_${RUN}`,
  sildenafil: `b1test_mar_sildenafil_${RUN}`,
  isosorbide: `b1test_mar_isosorbide_${RUN}`,
  cetirizine: `b1test_mar_cetirizine_${RUN}`,
});
const CATALOG_NAMES = Object.freeze({
  paracetamol: `B1TEST MAR Catalog Paracetamol ${RUN}`,
  sildenafil: `B1TEST MAR Catalog Sildenafil ${RUN}`,
  isosorbide: `B1TEST MAR Catalog Isosorbide ${RUN}`,
  cetirizine: `B1TEST MAR Catalog Cetirizine ${RUN}`,
});
// Non-default facility (`is_default=FALSE`) so it never collides with
// uq_facility_default, a partial UNIQUE on (tenant_id) WHERE is_default.
const FACILITY_CODE = `B1TEST-FACILITY-${RUN}`;
const STORAGE_LOCATION_CODE = `B1TEST-STORE-${RUN}`;
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

// The pharmacy lifecycle routes resolve facility custody from the ACTING
// staff member (assertPharmacyFacilityGrant needs a live users row, an active
// staff row and an active grant whose role matches the JWT), so the pharmacy
// calls cannot use the shared harness identity any more.
const pharmacistClient = () => {
  const token = generateTestToken('PHARMACY_INCHARGE', { uid: PHARMACIST_UID });
  return {
    get: (path) => request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (path) => request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
};

// Every order-lifecycle POST now runs through requireIdempotencyKey({
// required: true }), and the key is scoped to path + canonical body — so each
// call in this suite carries its OWN key rather than replaying a neighbour's.
function pharmacistPostWithKey(path, key) {
  return pharmacistClient().post(path).set('Idempotency-Key', key);
}

let patientId;
let patientUid;
let cleanOrderId; // delivery order with benign items — verify → preparing
let counterOrderId; // counter order — the counter-dispense verification gate
let riskyOrderId; // order whose items trip a KB contraindication
let maId; // scheduled MAR row for scan-policy tests
let clinicalOrderId;
let wardIndentId;
let wardIndentItemId;
let wardIndentStateVersion;
let catalogId;
let sildenafilCatalogId;
let isosorbideCatalogId;
let cetirizineCatalogId;
let cleanPackBarcode;
let inventoryItemId;
let inventoryBatchId;
let facilityId;
let storageLocationId;

async function createGovernedClinicalProduct({
  compositionKey,
  compositionLabel,
  ingredient,
  catalogName,
  genericName,
  strength,
  strengthKey,
  strengthValue,
}) {
  const composition = (await prisma.$queryRawUnsafe(
    `INSERT INTO drug_compositions
       (composition_key, display_label, active_ingredients, source)
     VALUES ($1::text, $2::text, ARRAY[$3::text], 'parsed')
     RETURNING id`,
    compositionKey,
    compositionLabel,
    ingredient,
  ))[0];
  return (await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_catalog
       (tenant_id, name, generic_name, composition_id,
        composition_confidence, composition_source,
        strength, strength_key, strength_components,
        form, form_key, release_key, route,
        is_active, is_available, in_stock, stock_quantity, updated_at)
     VALUES ($1::uuid, $2::text, $3::text, $4::int,
             'high', 'test_fixture',
             $5::text, $6::text, $7::jsonb,
             'tablet', 'tablet', 'immediate', 'oral',
             TRUE, TRUE, TRUE, 50, NOW())
     RETURNING id, name, generic_name, composition_id,
               composition_confidence, composition_source,
               strength, strength_key, strength_components,
               form, form_key, release_key, route`,
    DEFAULT_TENANT_ID,
    catalogName,
    genericName,
    Number(composition.id),
    strength,
    strengthKey,
    JSON.stringify([{ ingredient, value: strengthValue, unit: 'mg' }]),
  ))[0];
}

async function cleanup() {
  // These three tables need BOTH escapes at once, which is why they cannot ride
  // along in the plain replica transaction below:
  //   • tenant context — each carries a RESTRICTIVE tenant_context_required RLS
  //     policy, and app_current_tenant_id_uuid() is NULL outside setTenantTx, so
  //     an untenanted delete matches nothing. session_replication_role='replica'
  //     suppresses triggers and FK actions but never row-level security.
  //   • replica role — pharmacy_order_command_receipts and the grant events are
  //     append-only through BEFORE DELETE triggers, and the receipts' FK to
  //     pharmacy_orders is ON DELETE CASCADE, so leaving them behind would make
  //     the pharmacy_orders delete further down raise 23514 and silently strand
  //     every fixture order (and with it the facility, ON DELETE RESTRICT).
  await setTenantTx(DEFAULT_TENANT_ID, async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    await tx.$executeRawUnsafe(
      `DELETE FROM pharmacy_order_command_receipts
        WHERE tenant_id = $1::uuid
          AND pharmacy_order_id IN (
            SELECT id FROM pharmacy_orders
             WHERE tenant_id = $1::uuid AND patient_name = 'B1TEST Patient'
          )`,
      DEFAULT_TENANT_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM pharmacy_staff_facility_grant_events
        WHERE tenant_id = $1::uuid
          AND grant_id IN (
            SELECT id FROM pharmacy_staff_facility_grants
             WHERE tenant_id = $1::uuid AND grant_source = 'b1_test_fixture'
          )`,
      DEFAULT_TENANT_ID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM pharmacy_staff_facility_grants
        WHERE tenant_id = $1::uuid AND grant_source = 'b1_test_fixture'`,
      DEFAULT_TENANT_ID,
    );
  }).catch(() => {});
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
      // 'b1-%', not 'b1-mar-%': the pharmacy order lifecycle now requires an
      // Idempotency-Key on every verify / preparing / counter-dispense call, so
      // this suite's keys are no longer only the MAR ones.
      `DELETE FROM idempotency_keys
        WHERE tenant_id = $1::uuid
          AND user_uid IN ($2::uuid, $3::uuid, $4::uuid)
          AND request_key LIKE 'b1-%'`,
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
      `DELETE FROM admissions
        WHERE tenant_id = $1::uuid AND ward LIKE 'B1TEST MAR Ward%'`,
      DEFAULT_TENANT_ID,
    ).catch(() => {});
    await tx.$executeRawUnsafe(
      `DELETE FROM beds
        WHERE tenant_id = $1::uuid AND ward_name LIKE 'B1TEST MAR Ward%'`,
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
    `DELETE FROM pharmacy_catalog
      WHERE tenant_id = $1::uuid
        AND name IN ($2::text, $3::text, $4::text, $5::text)`,
    DEFAULT_TENANT_ID,
    CATALOG_NAMES.paracetamol,
    CATALOG_NAMES.sildenafil,
    CATALOG_NAMES.isosorbide,
    CATALOG_NAMES.cetirizine,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM drug_compositions
      WHERE composition_key IN ($1::text, $2::text, $3::text, $4::text)`,
    COMPOSITION_KEYS.paracetamol,
    COMPOSITION_KEYS.sildenafil,
    COMPOSITION_KEYS.isosorbide,
    COMPOSITION_KEYS.cetirizine,
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
  // Facility custody LAST, and only ever this suite's own codes: every 753
  // facility foreign key (orders, wards, inventory items, batches, locations)
  // is ON DELETE RESTRICT, so the facility can only go once every dependant
  // above has gone.
  await prisma.$executeRawUnsafe(
    `DELETE FROM facility_locations
      WHERE tenant_id = $1::uuid AND location_code LIKE 'B1TEST-STORE-%'`,
    DEFAULT_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM facilities
      WHERE tenant_id = $1::uuid AND facility_code LIKE 'B1TEST-FACILITY-%'`,
    DEFAULT_TENANT_ID,
  ).catch(() => {});
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

    // Facility custody comes FIRST: every pharmacy fixture below (orders,
    // inventory item, batch, ward) is bound to it by a migration-753 composite
    // (tenant_id, facility_id, …) foreign key or CHECK.
    const facility = await prisma.$queryRawUnsafe(
      `INSERT INTO facilities (tenant_id, facility_code, display_name, status, is_default)
       VALUES ($1::uuid, $2::text, 'B1TEST BCMA Facility', 'active', FALSE)
       RETURNING id`,
      DEFAULT_TENANT_ID, FACILITY_CODE,
    );
    facilityId = Number(facility[0].id);
    const storageLocation = await prisma.$queryRawUnsafe(
      `INSERT INTO facility_locations
         (tenant_id, facility_id, location_code, display_name, status)
       VALUES ($1::uuid, $2::int, $3::text, 'B1TEST BCMA Store', 'active')
       RETURNING id`,
      DEFAULT_TENANT_ID, facilityId, STORAGE_LOCATION_CODE,
    );
    storageLocationId = Number(storageLocation[0].id);

    // Verification resolves every order line through a positive same-tenant
    // catalog id, then locks its governed non-empty composition. Seed that
    // authority before any pharmacy order so no line ever exists as free text.
    const catalog = await createGovernedClinicalProduct({
      compositionKey: COMPOSITION_KEYS.paracetamol,
      compositionLabel: 'B1TEST paracetamol composition',
      ingredient: 'paracetamol',
      catalogName: CATALOG_NAMES.paracetamol,
      genericName: 'paracetamol',
      strength: '500 mg',
      strengthKey: '500mg',
      strengthValue: 500,
    });
    const sildenafilCatalog = await createGovernedClinicalProduct({
      compositionKey: COMPOSITION_KEYS.sildenafil,
      compositionLabel: 'B1TEST sildenafil composition',
      ingredient: 'sildenafil',
      catalogName: CATALOG_NAMES.sildenafil,
      genericName: 'sildenafil',
      strength: '50 mg',
      strengthKey: '50mg',
      strengthValue: 50,
    });
    const isosorbideCatalog = await createGovernedClinicalProduct({
      compositionKey: COMPOSITION_KEYS.isosorbide,
      compositionLabel: 'B1TEST isosorbide composition',
      ingredient: 'isosorbide',
      catalogName: CATALOG_NAMES.isosorbide,
      genericName: 'isosorbide',
      strength: '10 mg',
      strengthKey: '10mg',
      strengthValue: 10,
    });
    const cetirizineCatalog = await createGovernedClinicalProduct({
      compositionKey: COMPOSITION_KEYS.cetirizine,
      compositionLabel: 'B1TEST cetirizine composition',
      ingredient: 'cetirizine',
      catalogName: CATALOG_NAMES.cetirizine,
      genericName: 'cetirizine',
      strength: '10 mg',
      strengthKey: '10mg',
      strengthValue: 10,
    });
    catalogId = Number(catalog.id);
    sildenafilCatalogId = Number(sildenafilCatalog.id);
    isosorbideCatalogId = Number(isosorbideCatalog.id);
    cetirizineCatalogId = Number(cetirizineCatalog.id);

    // The clean order walks the DELIVERY lifecycle (verify → preparing);
    // markPreparing refuses a counter order outright, so the counter gate gets
    // its own fixture below.
    const clean = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_orders (tenant_id, facility_id, authority_origin, patient_id, patient_name, phone, order_note, status, delivery_type, items_list, dispensed_medications, total_amount, updated_at)
       VALUES ($3::uuid, $4::int, 'patient_manual', $1, 'B1TEST Patient', $2, 'B1TEST order', 'CONFIRMED', 'delivery',
               $5::jsonb, '[]'::jsonb, 20, NOW())
       RETURNING id`,
      patientId,
      PHONE,
      DEFAULT_TENANT_ID,
      facilityId,
      JSON.stringify([{
        catalog_id: Number(catalog.id),
        name: 'B1TEST Paracetamol 500mg',
        dose: '500mg',
        frequency: 'TDS',
        qty: 10,
        price: 2,
      }]),
    );
    cleanOrderId = Number(clean[0].id);

    const counter = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_orders (tenant_id, facility_id, authority_origin, patient_id, patient_name, phone, order_note, status, delivery_type, items_list, dispensed_medications, total_amount, updated_at)
       VALUES ($3::uuid, $4::int, 'patient_manual', $1, 'B1TEST Patient', $2, 'B1TEST order', 'CONFIRMED', 'counter',
               $5::jsonb, '[]'::jsonb, 20, NOW())
       RETURNING id`,
      patientId,
      PHONE,
      DEFAULT_TENANT_ID,
      facilityId,
      JSON.stringify([{
        catalog_id: Number(catalog.id),
        name: 'B1TEST Paracetamol 500mg',
        dose: '500mg',
        frequency: 'TDS',
        qty: 10,
        price: 2,
      }]),
    );
    counterOrderId = Number(counter[0].id);

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
               '{}'::text[], '{}'::text[], TRUE, FALSE, NOW(), NOW()),
              ($1::uuid, $4::uuid, $5::text, 'B1TEST Pharmacist', 'Pharmacist',
               '{}'::text[], '{}'::text[], TRUE, FALSE, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      DEFAULT_TENANT_ID,
      DOCTOR_UID,
      `B1-DOC-${RUN}`,
      PHARMACIST_UID,
      `B1-PHARM-${RUN}`,
    );
    // assertPharmacyFacilityGrant demands a live staff row AND exactly one
    // active grant for the exact facility — the pharmacy order lifecycle, the
    // counter-dispense staging and the ward-indent reserve/approve/issue
    // transitions all run through it. grant_reason has a 10..500 char CHECK.
    await setTenantTx(DEFAULT_TENANT_ID, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO pharmacy_staff_facility_grants
         (tenant_id, facility_id, staff_uid, status, grant_source,
          grant_reason, granted_by)
       VALUES ($1::uuid, $2::int, $3::uuid, 'active', 'b1_test_fixture',
               'B1TEST BCMA closed-loop pharmacy facility authority fixture', $3::uuid)`,
      DEFAULT_TENANT_ID,
      facilityId,
      PHARMACIST_UID,
    ));

    // facility_id is not decoration: reserveWardIndentInventoryTx resolves the
    // Inventory V2 mapping through the INDENT's facility, and
    // fk_pharmacy_batches_item_facility_753 binds the batch to
    // (tenant_id, facility_id, inventory_item_id).
    const inventoryItem = (await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, facility_id, sku_code, display_name, catalog_id, form, strength,
          unit_label, schedule_class, is_narcotic, status, metadata)
       VALUES ($1::uuid, $4::int, $2::text, 'B1TEST Paracetamol 500mg', $3::int,
               'tablet', '500 mg', 'tablet', 'OTC', FALSE, 'active', '{}'::jsonb)
       RETURNING id`,
      DEFAULT_TENANT_ID,
      `B1-MAR-SKU-${RUN}`,
      Number(catalog.id),
      facilityId,
    ))[0];
    inventoryItemId = Number(inventoryItem.id);
    // in_stock stock needs an EXACT active storage location:
    // chk_pharmacy_batches_usable_storage_supply_753 plus the
    // trg_pharmacy_batch_storage_authority_supply_753 BEFORE-INSERT trigger,
    // which also re-checks that the location is active in this facility.
    const batch = (await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, facility_id, storage_location_id,
          batch_number, lot_number, expiry_date,
          received_quantity, remaining_quantity, status, metadata)
       VALUES ($1::uuid, $2::int, $6::int, $7::int, $3::text, $4::text,
               (CURRENT_DATE + INTERVAL '365 days')::date,
                20, 20, 'in_stock', jsonb_build_object('barcode', $5::text))
       RETURNING id`,
      DEFAULT_TENANT_ID,
      Number(inventoryItem.id),
      `B1-MAR-BATCH-${RUN}`,
      `B1-MAR-LOT-${RUN}`,
      BATCH_BARCODE,
      facilityId,
      storageLocationId,
    ))[0];
    inventoryBatchId = Number(batch.id);
    // createWardIndent refuses a pharmacy indent whose ward has no active
    // facility (WARD_INDENT_FACILITY_REQUIRED), and pins that facility onto
    // the indent — which is what the reserve/approve/issue grant checks read.
    const ward = (await prisma.$queryRawUnsafe(
      `INSERT INTO wards (tenant_id, facility_id, name, total_beds, created_at, updated_at)
       VALUES ($1::uuid, $3::int, $2::text, 10, NOW(), NOW())
       RETURNING id`,
      DEFAULT_TENANT_ID,
      `B1TEST MAR Ward ${RUN}`,
      facilityId,
    ))[0];
    const encounterId = randomUUID();
    const bedNumber = `B1-MAR-${RUN}`.slice(0, 20);
    const bed = (await prisma.$queryRawUnsafe(
      `INSERT INTO beds
         (tenant_id, ward_id, ward_name, bed_number, status, patient_uid,
          created_at, updated_at)
       VALUES ($1::uuid, $2::int, $3::text, $4::text, 'occupied', $5::uuid,
               NOW(), NOW())
       RETURNING id`,
      DEFAULT_TENANT_ID,
      Number(ward.id),
      `B1TEST MAR Ward ${RUN}`,
      bedNumber,
      patientUid,
    ))[0];
    const admission = (await prisma.$queryRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, encounter_id, allergies, status, admitted_at,
          ward, bed_id, bed_number, created_by, attending_doctor, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, '{}', 'admitted', NOW(),
               $4::text, $5::int, $6::text, $7::uuid, $8::uuid, NOW(), NOW())
       RETURNING id`,
      DEFAULT_TENANT_ID,
      patientUid,
      encounterId,
      `B1TEST MAR Ward ${RUN}`,
      Number(bed.id),
      bedNumber,
      NURSE_UID,
      DOCTOR_UID,
    ))[0];
    const clinicalOrderDetails = bindMedicationOrderCatalogAuthority({
      catalog_id: Number(catalog.id),
      dose: '500mg',
      route: 'oral',
      strength: '500 mg',
      strength_key: '500mg',
      form: 'tablet',
      form_key: 'tablet',
      quantity_requested: 20,
      unit: 'tablet',
    }, catalog, { phase: 'create' });
    const order = (await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_orders
         (tenant_id, order_number, patient_uid, encounter_id, order_type, status,
           ordered_by, route, details, updated_at)
       VALUES ($1::uuid, $2::text, $3::uuid, $4::uuid,
                'medication', 'ordered', $5::uuid,
                'oral', $6::jsonb, NOW())
       RETURNING id`,
      DEFAULT_TENANT_ID,
      `B1-MAR-ORDER-${RUN}`,
      patientUid,
      encounterId,
      DOCTOR_UID,
      JSON.stringify(clinicalOrderDetails),
    ))[0];
    clinicalOrderId = Number(order.id);
    await verifyOrder(clinicalOrderId, PHARMACIST_UID, {
      tenantId: DEFAULT_TENANT_ID,
      actorRole: 'PHARMACY_INCHARGE',
      idempotencyKey: `b1-mar-verify-${RUN}`,
    });
    const indent = await createWardIndent({
      wardId: Number(ward.id),
      admissionId: Number(admission.id),
      encounterId,
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
    // reserve / approve / issue each run assertPharmacyFacilityGrant against
    // the indent's pinned facility. Passing actorRole makes that check strict
    // (the DB role must equal the claimed one) instead of role-agnostic.
    const reserved = await reserveWardIndent({
      indentId: wardIndentId,
      reservedBy: PHARMACIST_UID,
      actorRole: 'PHARMACY_INCHARGE',
      expectedVersion: indent.state_version,
      commandKey: `b1-mar-reserve-${RUN}`,
      tenantId: DEFAULT_TENANT_ID,
    });
    const approved = await approveWardIndent({
      indentId: wardIndentId,
      approvedBy: PHARMACIST_UID,
      actorRole: 'PHARMACY_INCHARGE',
      expectedVersion: reserved.state_version,
      commandKey: `b1-mar-approve-${RUN}`,
      tenantId: DEFAULT_TENANT_ID,
    });
    const issued = await issueWardIndent({
      indentId: wardIndentId,
      issuedBy: PHARMACIST_UID,
      actorRole: 'PHARMACY_INCHARGE',
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
    const res = await pharmacistPostWithKey(
      `/api/v1/pharmacy/orders/${cleanOrderId}/preparing`,
      `b1-preparing-blocked-${cleanOrderId}`,
    );
    expect(res.status).toBe(409);
    // The verification gate, not the delivery-flow gate: cleanOrderId IS a
    // delivery order, so PHARMACY_ORDER_WRONG_DELIVERY_FLOW cannot fire here.
    expect(res.body.code).toBe('PHARMACY_VERIFICATION_REQUIRED');
  });

  test('counter dispense is blocked until verification clears', async () => {
    const res = await pharmacistClient()
      .post(`/api/v1/pharmacy/orders/${counterOrderId}/dispense-counter`)
      .set('Idempotency-Key', `b1-counter-blocked-${counterOrderId}`)
      .send({ payment_mode: 'cash', amount_collected: 20 });
    expect(res.status).toBe(409);
    // stageCounterFundingAuthority asserts cleared verification BEFORE any
    // funding is materialized, so this must be the verification refusal and
    // never PHARMACY_COUNTER_FUNDING_REQUIRED.
    expect(res.body.code).toBe('PHARMACY_VERIFICATION_REQUIRED');
  });

  test('clean order verifies; preparing then proceeds; safety event lands on the timeline', async () => {
    const verify = await pharmacistPostWithKey(
      `/api/v1/pharmacy/orders/${cleanOrderId}/verify`,
      `b1-verify-clean-${cleanOrderId}`,
    ).send({ decision: 'verified', notes: 'B1TEST reviewed against allergies/KB' });
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

    const preparing = await pharmacistPostWithKey(
      `/api/v1/pharmacy/orders/${cleanOrderId}/preparing`,
      `b1-preparing-cleared-${cleanOrderId}`,
    );
    expect(preparing.status).toBe(200);
  });

  test('pack label issues a stable VHMP barcode after verification', async () => {
    const label = await authClient('PHARMACY_STAFF').get(`/api/v1/pharmacy/orders/${cleanOrderId}/pack-label`);
    expect(label.status).toBe(200);
    cleanPackBarcode = label.body.data.pack_barcode;
    expect(cleanPackBarcode).toMatch(/^VHMP-\d+-[0-9A-F]{8}$/);
    expect(label.body.data.items[0].name).toBe(CATALOG_NAMES.paracetamol);

    const again = await authClient('PHARMACY_STAFF').get(`/api/v1/pharmacy/orders/${cleanOrderId}/pack-label`);
    expect(again.body.data.pack_barcode).toBe(cleanPackBarcode);
  });

  test('risky order: verify refused with blockers; override requires a reason and records reviews', async () => {
    // Create the contraindicated pair only for this scenario. Keeping it out
    // of beforeAll prevents patient-wide active-therapy reconciliation from
    // treating the future risky order as evidence against the clean order.
    const risky = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_orders (tenant_id, facility_id, authority_origin, patient_id, patient_name, phone, order_note, status, delivery_type, items_list, dispensed_medications, total_amount, updated_at)
       VALUES ($3::uuid, $4::int, 'patient_manual', $1, 'B1TEST Patient', $2, 'B1TEST order', 'CONFIRMED', 'counter',
               $5::jsonb, '[]'::jsonb, 250, NOW())
       RETURNING id`,
      patientId,
      PHONE,
      DEFAULT_TENANT_ID,
      facilityId,
      JSON.stringify([
        {
          catalog_id: sildenafilCatalogId,
          name: 'Tab Sildenafil 50mg',
          dose: '50mg',
          frequency: 'OD',
          qty: 4,
          price: 50,
        },
        {
          catalog_id: isosorbideCatalogId,
          name: 'Sorbitrate (isosorbide) 10mg',
          dose: '10mg',
          frequency: 'BD',
          qty: 10,
          price: 5,
        },
      ]),
    );
    riskyOrderId = Number(risky[0].id);

    const verify = await pharmacistPostWithKey(
      `/api/v1/pharmacy/orders/${riskyOrderId}/verify`,
      `b1-verify-risky-${riskyOrderId}`,
    ).send({ decision: 'verified' });
    expect(verify.status).toBe(409);
    expect(verify.body.code).toBe('PHARMACY_VERIFY_BLOCKERS_PRESENT');
    expect(verify.body.details.blockers.length).toBeGreaterThanOrEqual(1);

    const badOverride = await pharmacistPostWithKey(
      `/api/v1/pharmacy/orders/${riskyOrderId}/verify`,
      `b1-override-short-${riskyOrderId}`,
    ).send({ decision: 'override', override_reason: 'short' });
    expect(badOverride.status).toBe(400);

    const override = await pharmacistPostWithKey(
      `/api/v1/pharmacy/orders/${riskyOrderId}/verify`,
      `b1-override-reasoned-${riskyOrderId}`,
    ).send({
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
    const packBarcode = cleanPackBarcode;
    expect(packBarcode).toMatch(/^VHMP-\d+-[0-9A-F]{8}$/);

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
    // A delivery order, so the 409 below can only be the verification freeze
    // and never markPreparing's counter/delivery flow guard.
    const blocked = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_orders (tenant_id, facility_id, authority_origin, patient_id, patient_name, phone, order_note, status, delivery_type, items_list, dispensed_medications, total_amount, updated_at)
       VALUES ($3::uuid, $4::int, 'patient_manual', $1, 'B1TEST Patient', $2, 'B1TEST order', 'CONFIRMED', 'delivery',
               $5::jsonb, '[]'::jsonb, 5, NOW())
       RETURNING id`,
      patientId,
      PHONE,
      DEFAULT_TENANT_ID,
      facilityId,
      JSON.stringify([{
        catalog_id: cetirizineCatalogId,
        name: 'B1TEST Cetirizine 10mg',
        dose: '10mg',
        qty: 5,
        price: 1,
      }]),
    );
    const rejectId = Number(blocked[0].id);
    const reject = await pharmacistPostWithKey(
      `/api/v1/pharmacy/orders/${rejectId}/verify`,
      `b1-verify-rejected-${rejectId}`,
    ).send({ decision: 'rejected', notes: 'B1TEST illegible strength — back to prescriber' });
    expect(reject.status).toBe(200);
    // chk_pharmacy_orders_rejected_hold_753 only tolerates a rejected
    // verification on a held/terminal order, so the reject must have parked the
    // order on ON_HOLD rather than leaving it CONFIRMED.
    expect(reject.body.data.order.status).toBe('ON_HOLD');

    const preparing = await pharmacistPostWithKey(
      `/api/v1/pharmacy/orders/${rejectId}/preparing`,
      `b1-preparing-rejected-${rejectId}`,
    );
    expect(preparing.status).toBe(409);
    expect(preparing.body.code).toBe('PHARMACY_VERIFICATION_REQUIRED');
  });
});
