import { createHash } from 'node:crypto';

import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';
import { API_KEY, generateTestToken } from './testClient.js';
import { grantPharmacyFacilityAuthority } from '../services/pharmacy/pharmacyFacilityAuthorityService.js';
import { validatePrescriptionSafety } from '../utils/clinical/prescriptionSafetyCheck.js';

const PATIENT_UID = 'a5555555-5555-4555-8555-555555555a01';
const DOCTOR_UID = 'a5555555-5555-4555-8555-555555555a02';
const STAFF_UID = 'a5555555-5555-4555-8555-555555555a03';
// The pharmacy actor is its own identity. Facility custody checks the DB role
// of the acting user against the role on its token, so the nurse fixture above
// cannot double as the pharmacist who places and dispenses the orders.
const PHARMACIST_UID = 'a5555555-5555-4555-8555-555555555a04';
const GRANT_ADMIN_UID = 'a5555555-5555-4555-8555-555555555a05';
// A clinical-safety override at pharmacy verification is break-glass authority
// reserved to the pharmacy in-charge; the counter pharmacist cannot self-grant
// it (PHARMACY_VERIFY_OVERRIDE_FORBIDDEN).
const PHARMACY_INCHARGE_UID = 'a5555555-5555-4555-8555-555555555a06';
const PEDIATRIC_PARACETAMOL_NAME = 'Paracetamol Syrup 125mg/5ml Test';
const FACILITY_CODE = 'PRESCRIPTION-DEEP-FACILITY';
// The duplicate-active-medicine screen reads the canonical active-therapy
// snapshot, which admits a prescription only when its line resolves to an
// active tenant catalog item, a governed composition, and a deterministic
// drug-knowledge identity. Ondansetron is a seeded KB molecule, so the fixture
// can express a genuinely governed active therapy.
const DUPLICATE_MED_NAME = 'Ondansetron 1 mg Duplicate Test';
const DUPLICATE_MED_INGREDIENT = 'ondansetron';
// Two brands of the same governed composition, strength, form, release and
// route — the only kind of counter substitution the order path will authorise.
const PRESCRIBED_BRAND_NAME = 'Paracetamol Syrup 125mg/5ml Brand A Test';
const SUBSTITUTE_BRAND_NAME = 'Paracetamol Syrup 125mg/5ml Brand B Test';
// Every catalog row this file creates. Each test drops its own on the way out,
// but only if it got that far — listing them here keeps a failed run from
// leaving rows that crowd the ranked alternative list on the next one.
const FIXTURE_CATALOG_NAMES = [
  PEDIATRIC_PARACETAMOL_NAME,
  DUPLICATE_MED_NAME,
  'Paracetamol Syrup 125mg/5ml Aarav Test',
  'Paracetamol Syrup 125mg/5ml Recalc Test',
  'Paracetamol 500mg Tablet Qty Test',
  'Amoxicillin 500mg Tablet Ack Test',
  PRESCRIBED_BRAND_NAME,
  SUBSTITUTE_BRAND_NAME,
];

// An ACTIVE inventory item must name the facility that holds custody of it and
// the catalog item it is stock of; an in-stock batch must additionally name the
// facility and the storage location it physically sits in
// (chk_pharmacy_inventory_items_active_authority_753,
// chk_pharmacy_batches_usable_authority_753 and
// chk_pharmacy_batches_usable_storage_supply_753). Stock with no custody is
// exactly what those checks exist to refuse.
async function seedInventoryV2ForCatalog(catalogId, quantity, { facilityId, storageLocationId }) {
  const catalogs = await prisma.$queryRawUnsafe(
    `SELECT tenant_id, name FROM pharmacy_catalog WHERE id=$1::int`,
    Number(catalogId),
  );
  const catalog = catalogs[0];
  const items = await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_inventory_items
       (tenant_id, facility_id, sku_code, display_name, catalog_id)
     VALUES ($1::uuid, $5::int, $2, $3, $4::int)
     RETURNING id`,
    catalog.tenant_id,
    `PRESCRIPTION-DEEP-${catalogId}`,
    catalog.name,
    Number(catalogId),
    Number(facilityId),
  );
  const itemId = Number(items[0].id);
  await prisma.$executeRawUnsafe(
    `INSERT INTO pharmacy_inventory_batches
       (tenant_id, facility_id, storage_location_id, inventory_item_id, batch_number,
        expiry_date, received_quantity, remaining_quantity, status)
     VALUES ($1::uuid, $5::int, $6::int, $2::int, $3, (NOW()+INTERVAL '1 year')::date,
        $4::numeric, $4::numeric, 'in_stock')`,
    catalog.tenant_id,
    itemId,
    `PRESCRIPTION-DEEP-BATCH-${catalogId}`,
    quantity,
    Number(facilityId),
    Number(storageLocationId),
  );
  return itemId;
}

function staffAs(id) {
  const token = generateTestToken('NURSING_STAFF', {
    uid: STAFF_UID,
    id,
    phone: '9000050003'
  });
  return {
    post: path =>
      request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`)
  };
}

function doctorAs(id) {
  const token = generateTestToken('DOCTOR', {
    uid: DOCTOR_UID,
    id,
    phone: '9000050002'
  });
  return {
    post: path =>
      request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`)
  };
}

function clientAs(role, uid, id) {
  const token = generateTestToken(role, { uid, id });
  return {
    get: path => request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: path => request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

// A catalog row a pharmacist may verify and dispense has to resolve to a
// governed composition with a deterministic drug-knowledge identity. Without it
// verification refuses (PHARMACY_VERIFY_COMPOSITION_AUTHORITY_UNAVAILABLE) and
// every later safety screen for this patient inherits an
// ACTIVE_THERAPY_IDENTITY_UNRESOLVED blocker from the order the row produced.
// The ingredients used here (paracetamol, amoxicillin) are seeded KB molecules.
async function governCatalogIdentity(catalogId, { ingredient, strengthKey, formKey, route }) {
  const composition = await prisma.$queryRawUnsafe(
    `INSERT INTO drug_compositions
       (composition_key, display_label, active_ingredients, source)
     VALUES ($1, $2, ARRAY[$3]::text[], 'curated')
     ON CONFLICT (composition_key) DO UPDATE
       SET active_ingredients = EXCLUDED.active_ingredients
     RETURNING id`,
    `prescription_deep_${ingredient}`,
    `Prescription deep ${ingredient}`,
    ingredient,
  );
  await prisma.$executeRawUnsafe(
    `UPDATE pharmacy_catalog
        SET composition_id = $2::int,
            composition_confidence = 'high',
            composition_source = 'test_fixture',
            strength_key = $3,
            form_key = $4,
            release_key = 'ir',
            route = $5,
            updated_at = NOW()
      WHERE id = $1::int`,
    Number(catalogId),
    Number(composition[0].id),
    strengthKey,
    formKey,
    route,
  );
  return Number(catalogId);
}

// Sign and lock through the real endpoint. A first pharmacy order can only be
// placed from a signed prescription, and signing is also what pins each line's
// catalog clinical identity — a hand-stamped signed_at would be rejected at
// order time as a post-signature identity change.
async function signRx(rxId, doctorId) {
  const res = await doctorAs(doctorId).post(`/api/v1/prescriptions/${rxId}/sign`).send({});
  expect(res.statusCode).toBe(200);
  return res;
}

async function cleanupFixtures(patientId, doctorId) {
  await prisma.$executeRawUnsafe(
    `DELETE FROM pharmacy_stock_movements
      WHERE inventory_item_id IN (
        SELECT id FROM pharmacy_inventory_items WHERE sku_code LIKE 'PRESCRIPTION-DEEP-%'
      )`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM pharmacy_inventory_batches
      WHERE inventory_item_id IN (
        SELECT id FROM pharmacy_inventory_items WHERE sku_code LIKE 'PRESCRIPTION-DEEP-%'
      )`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM pharmacy_inventory_items WHERE sku_code LIKE 'PRESCRIPTION-DEEP-%'`,
  ).catch(() => {});
  // The facility, its grant and the two identities the grant is bound to are
  // deliberately NOT torn down. Grant events are append-only (a trigger refuses
  // DELETE) and the grant pins its facility and both user rows with ON DELETE
  // RESTRICT, so the custody chain is seeded idempotently and re-used instead.
  const existingUsers = await prisma
    .$queryRawUnsafe(
      `SELECT id, uid::text AS uid
     FROM users
     WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID,
      DOCTOR_UID,
      STAFF_UID
    )
    .catch(() => []);
  const resolvedPatientId = patientId || existingUsers.find(row => row.uid === PATIENT_UID)?.id;
  const resolvedDoctorId = doctorId || existingUsers.find(row => row.uid === DOCTOR_UID)?.id;

  if (resolvedPatientId || resolvedDoctorId) {
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM follow_up_plans WHERE patient_uid = $1::uuid`,
        PATIENT_UID
      )
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(`DELETE FROM medication_reminders WHERE patient_uid = $1::uuid`, PATIENT_UID)
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(`DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`, PATIENT_UID)
      .catch(() => {});
    // pharmacy_order_command_receipts are append-only — a trigger refuses the
    // DELETE their order's own removal cascades into — so fixture teardown runs
    // with triggers off, the same way the other pharmacy deep suites do. This
    // is teardown of rows this file created; no guard is relaxed for the code
    // under test.
    await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(
          `DELETE FROM pharmacy_order_command_receipts
            WHERE pharmacy_order_id IN (
              SELECT id FROM pharmacy_orders WHERE patient_id = $1 OR patient_id = $2
            )`,
          resolvedPatientId || -1,
          resolvedDoctorId || -1
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM pharmacy_order_history
            WHERE order_id IN (
              SELECT id FROM pharmacy_orders WHERE patient_id = $1 OR patient_id = $2
            )`,
          resolvedPatientId || -1,
          resolvedDoctorId || -1
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM pharmacy_orders WHERE patient_id = $1 OR patient_id = $2`,
          resolvedPatientId || -1,
          resolvedDoctorId || -1
        );
      })
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM prescription_safety_overrides
       WHERE patient_id = $1 OR doctor_id = $2`,
        resolvedPatientId || -1,
        resolvedDoctorId || -1
      )
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM e_prescriptions
       WHERE patient_id = $1 OR doctor_id = $2`,
        resolvedPatientId || -1,
        resolvedDoctorId || -1
      )
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM pharmacy_orders
          WHERE patient_id = $1 OR patient_id = $2`,
        resolvedPatientId || -1,
        resolvedDoctorId || -1
      )
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM appointments
       WHERE patient_id = $1 OR doctor_id = $2`,
        resolvedPatientId || -1,
        resolvedDoctorId || -1
      )
      .catch(() => {});
  }
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM pharmacy_catalog WHERE name = ANY($1::text[])`,
      FIXTURE_CATALOG_NAMES
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(`DELETE FROM lab_results WHERE patient_uid = $1::uuid`, PATIENT_UID)
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID,
      DOCTOR_UID,
      STAFF_UID
    )
    .catch(() => {});
}

describe('E-prescriptions — deep integration', () => {
  let patientId;
  let doctorId;
  let staffId;
  let pharmacistId;
  let inchargeId;
  let facilityId;
  let storageLocationId;
  let tenantId;
  let duplicateCatalogId;

  // A pharmacist client bound to the fixture facility grant.
  const pharmacyAs = () => clientAs('PHARMACY_STAFF', PHARMACIST_UID, pharmacistId);
  const pharmacyInchargeAs = () => clientAs('PHARMACY_INCHARGE', PHARMACY_INCHARGE_UID, inchargeId);

  beforeAll(async () => {
    await cleanupFixtures();
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, birthday, is_active, updated_at)
       VALUES
         ($1::uuid, '9000050001', 'Prescription Test Patient', 'PATIENT', CURRENT_DATE - INTERVAL '2 years', true, NOW()),
         ($2::uuid, '9000050002', 'Prescription Test Doctor', 'DOCTOR', NULL, true, NOW()),
         ($3::uuid, '9000050003', 'Prescription Test Nurse', 'NURSING_STAFF', NULL, true, NOW()),
         ($4::uuid, '9000050004', 'Prescription Test Pharmacist', 'PHARMACY_STAFF', NULL, true, NOW()),
         ($5::uuid, '9000050005', 'Prescription Test Admin', 'ADMIN', NULL, true, NOW()),
         ($6::uuid, '9000050006', 'Prescription Test Pharmacy Incharge', 'PHARMACY_INCHARGE', NULL, true, NOW())
       ON CONFLICT (uid) DO UPDATE SET
         phone = EXCLUDED.phone,
         name = EXCLUDED.name,
         role = EXCLUDED.role,
         birthday = EXCLUDED.birthday,
         is_active = EXCLUDED.is_active,
         updated_at = NOW()
       RETURNING id, uid`,
      PATIENT_UID,
      DOCTOR_UID,
      STAFF_UID,
      PHARMACIST_UID,
      GRANT_ADMIN_UID,
      PHARMACY_INCHARGE_UID
    );
    patientId = rows.find(row => row.uid === PATIENT_UID).id;
    doctorId = rows.find(row => row.uid === DOCTOR_UID).id;
    staffId = rows.find(row => row.uid === STAFF_UID).id;
    pharmacistId = rows.find(row => row.uid === PHARMACIST_UID).id;
    inchargeId = rows.find(row => row.uid === PHARMACY_INCHARGE_UID).id;

    tenantId = (await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id FROM users WHERE uid = $1::uuid`,
      PATIENT_UID
    ))[0].tenant_id;

    // Facility custody. Migration 753 makes a pharmacy order impossible without
    // an active facility and an active grant binding the placing actor to it,
    // and there is no admin bypass. The facility is deliberately not the tenant
    // default: every request names it, so this suite cannot make a second
    // default appear for anything else sharing the database.
    facilityId = Number(
      (await prisma.$queryRawUnsafe(
        `INSERT INTO facilities (tenant_id, facility_code, display_name, status, is_default)
         VALUES ($1::uuid, $2, 'Prescription Deep Pharmacy', 'active', FALSE)
         ON CONFLICT (tenant_id, facility_code) DO UPDATE SET status = 'active'
         RETURNING id`,
        tenantId,
        FACILITY_CODE
      ))[0].id
    );
    storageLocationId = Number(
      (await prisma.$queryRawUnsafe(
        `INSERT INTO facility_locations
           (tenant_id, facility_id, location_code, display_name, location_kind, status)
         VALUES ($1::uuid, $2::int, $3, 'Prescription Deep Store', 'pharmacy', 'active')
         ON CONFLICT (facility_id, location_code) DO UPDATE SET status = 'active'
         RETURNING id`,
        tenantId,
        facilityId,
        'PRESCRIPTION-DEEP-STORE'
      ))[0].id
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff
         (tenant_id, user_id, employee_id, name, designation, skills,
          certifications, is_active, archived, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'PRESCRIPTION-DEEP-PH', 'Prescription Test Pharmacist',
               'Pharmacist', '{}'::text[], '{}'::text[], TRUE, FALSE, NOW(), NOW())
       ON CONFLICT (tenant_id, user_id) WHERE user_id IS NOT NULL DO UPDATE SET
         is_active = TRUE, archived = FALSE, updated_at = NOW()`,
      tenantId,
      PHARMACIST_UID
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff
         (tenant_id, user_id, employee_id, name, designation, skills,
          certifications, is_active, archived, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'PRESCRIPTION-DEEP-IC', 'Prescription Test Pharmacy Incharge',
               'Pharmacy In-charge', '{}'::text[], '{}'::text[], TRUE, FALSE, NOW(), NOW())
       ON CONFLICT (tenant_id, user_id) WHERE user_id IS NOT NULL DO UPDATE SET
         is_active = TRUE, archived = FALSE, updated_at = NOW()`,
      tenantId,
      PHARMACY_INCHARGE_UID
    );
    // Stable command keys: on a re-used database the grant already exists, and
    // replaying the same command returns its receipt instead of colliding.
    await grantPharmacyFacilityAuthority({
      tenantId,
      facilityId,
      staffUid: PHARMACIST_UID,
      actorUid: GRANT_ADMIN_UID,
      actorRole: 'ADMIN',
      reason: 'Prescription deep fixture pharmacy facility authority',
      commandKey: `prescription-deep-facility-grant-${FACILITY_CODE}`,
    });
    await grantPharmacyFacilityAuthority({
      tenantId,
      facilityId,
      staffUid: PHARMACY_INCHARGE_UID,
      actorUid: GRANT_ADMIN_UID,
      actorRole: 'ADMIN',
      reason: 'Prescription deep fixture pharmacy in-charge facility authority',
      commandKey: `prescription-deep-facility-grant-incharge-${FACILITY_CODE}`,
    });

    // Governed identity for the duplicate-active-medicine fixture drug.
    const duplicateComposition = await prisma.$queryRawUnsafe(
      `INSERT INTO drug_compositions
         (composition_key, display_label, active_ingredients, source)
       VALUES ($1, $2, ARRAY[$3]::text[], 'curated')
       ON CONFLICT (composition_key) DO UPDATE
         SET active_ingredients = EXCLUDED.active_ingredients
       RETURNING id`,
      `prescription_deep_${DUPLICATE_MED_INGREDIENT}`,
      `Prescription deep ${DUPLICATE_MED_INGREDIENT}`,
      DUPLICATE_MED_INGREDIENT
    );
    duplicateCatalogId = Number(
      (await prisma.$queryRawUnsafe(
        `INSERT INTO pharmacy_catalog
           (tenant_id, name, generic_name, is_active, stock_quantity, unit_price, price,
            composition_id, composition_confidence, composition_source,
            strength, strength_key, form, form_key, release_key, route, updated_at)
         VALUES ($1::uuid, $2, $3, TRUE, 50, 4.00, 4.00, $4::int, 'high', 'test_fixture',
                 '1 mg', '1 mg', 'tablet', 'tablet', 'ir', 'Oral', NOW())
         RETURNING id`,
        tenantId,
        DUPLICATE_MED_NAME,
        DUPLICATE_MED_INGREDIENT,
        Number(duplicateComposition[0].id)
      ))[0].id
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO vitals_chart (patient_uid, weight_kg, recorded_by, recorded_at)
       VALUES ($1::uuid, 12.5, $2::uuid, NOW())`,
      PATIENT_UID,
      STAFF_UID,
    );
  });

  // Counter dispense is funding-gated: the handler stages the authoritative
  // dispense lines, materialises the draft invoice + finance recovery task, and
  // then refuses with 409 PHARMACY_COUNTER_FUNDING_REQUIRED until a posted
  // payment covers the exact order version and items hash. The fixture pays
  // before it dispenses, binding to the identity the refusal itself hands back
  // rather than recomputing it. The allocation row written here is the row
  // allocatePostedPharmacyPaymentsTx would have written and still has to satisfy
  // chk_pharmacy_payment_allocation_authority_753 and every composite tenant FK,
  // so the funding authority is proved, not bypassed. Same recipe as
  // pharmacy-route-contract-d57.
  async function fundCounterOrder(orderId, dispenseBody) {
    const primed = await pharmacyAs()
      .post(`/api/v1/pharmacy/orders/${orderId}/dispense-counter`)
      .set('Idempotency-Key', `deep-fund-prime-${orderId}`)
      .send(dispenseBody);
    expect(primed.statusCode).toBe(409);
    expect(primed.body.code).toBe('PHARMACY_COUNTER_FUNDING_REQUIRED');
    const recovery = primed.body.details.funding_recovery;

    const paymentRows = await prisma.$queryRawUnsafe(
      `INSERT INTO billing_payments
         (tenant_id, invoice_id, patient_uid, amount, mode, reference,
          collected_by, collected_at, reversed)
       VALUES ($1::uuid, $2::int, $3::uuid, $4::numeric, 'CASH', $5, $6::uuid, NOW(), FALSE)
       RETURNING id`,
      tenantId,
      Number(recovery.invoice_id),
      PATIENT_UID,
      Number(recovery.amount_outstanding),
      `PRESCRIPTION-DEEP-PAY-${orderId}`,
      GRANT_ADMIN_UID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO pharmacy_payment_allocations
         (tenant_id, pharmacy_order_id, invoice_id, invoice_item_id,
          billing_payment_id, source_authority_version, source_authority_sha256,
          allocated_amount, allocation_command_sha256, allocated_by, evidence)
       VALUES ($1::uuid, $2::int, $3::int, $4::int, $5::int, $6::int, $7,
               $8::numeric, $9, $10::uuid, $11::jsonb)`,
      tenantId,
      orderId,
      Number(recovery.invoice_id),
      Number(recovery.invoice_item_id),
      Number(paymentRows[0].id),
      Number(recovery.order_version),
      String(recovery.order_items_sha256),
      Number(recovery.amount_outstanding),
      createHash('sha256').update(`prescription-deep-funding:${orderId}`).digest('hex'),
      GRANT_ADMIN_UID,
      JSON.stringify({
        contract: 'pharmacy_payment_allocation_v1',
        payment_amount: Number(recovery.amount_outstanding),
        payment_previously_allocated: 0,
      }),
    );
  }

  // Creating a prescription also syncs patient medication reminders, and a
  // reminder row is an active-therapy source that carries no catalog column at
  // all — so it can only ever resolve as identity-unresolved and, left behind,
  // it would make every later case in this file inherit a blocker raised by a
  // sibling test's side effect. Each test therefore starts from the reminder
  // state it creates itself; the reminder-sync case still asserts its own row.
  beforeEach(async () => {
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM medication_reminders WHERE patient_uid = $1::uuid`,
        PATIENT_UID
      )
      .catch(() => {});
  });

  afterAll(async () => {
    await cleanupFixtures(patientId, doctorId);
    await prisma.$disconnect().catch(() => {});
  });

  it('checks duplicate active medicines from the current jsonb prescription schema', async () => {
    // Signed, locked and catalog-pinned: the duplicate screen now reads the
    // canonical active-therapy snapshot, which only admits a prescription whose
    // clinician actually signed it and whose line resolves to a tenant catalog
    // item with a governed composition. An unsigned draft is not therapy the
    // patient is on, and an identity-free line fails closed instead.
    await prisma.$executeRawUnsafe(
      `INSERT INTO e_prescriptions
         (patient_id, patient_uid, doctor_id, medications, follow_up_date, status, created_by,
          lifecycle_status, signed_at, locked_at)
       VALUES ($1, $5::uuid, $2, $3::jsonb, CURRENT_DATE + INTERVAL '7 days', 'active', $4,
               'signed', NOW(), NOW())`,
      patientId,
      doctorId,
      JSON.stringify([{ name: DUPLICATE_MED_NAME, dosage: '1mg', catalog_id: duplicateCatalogId }]),
      staffId,
      PATIENT_UID
    );

    const safety = await validatePrescriptionSafety(
      patientId,
      [{ name: DUPLICATE_MED_NAME, dosage: '1mg', catalog_id: duplicateCatalogId }],
      { tenantId },
    );

    expect(safety.safe).toBe(true);
    expect(safety.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'DUPLICATE_MEDICATION',
          medication: DUPLICATE_MED_NAME
        })
      ])
    );
  });

  it('blocks inconsistent paediatric syrup mg/ml dose text', async () => {
    const safety = await validatePrescriptionSafety(patientId, [
      {
        name: 'Paracetamol syrup 125mg/5ml',
        dosage: '187.5 mg (5 ml)',
        dose: '187.5 mg (5 ml)',
        frequency: 'q6h PRN fever',
        route: 'oral',
      },
    ], { tenantId });

    expect(safety.safe).toBe(false);
    expect(safety.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'PAEDIATRIC_LIQUID_DOSE_MISMATCH',
          expected_ml: 7.5,
          entered_ml: 5,
        }),
      ]),
    );
  });

  it('allows a valid paediatric mg/kg syrup dose with matching ml instruction', async () => {
    const safety = await validatePrescriptionSafety(patientId, [
      {
        name: 'Paracetamol syrup 125mg/5ml',
        dosage: '15 mg/kg = 7.5 ml',
        dose: '15 mg/kg = 7.5 ml',
        frequency: 'q6h PRN fever',
        route: 'oral',
      },
    ], { tenantId });

    expect(safety.safe).toBe(true);
    expect(safety.blockers).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'PAEDIATRIC_LIQUID_DOSE_MISMATCH' }),
        expect.objectContaining({ type: 'PAEDIATRIC_DOSE_HIGH' }),
      ]),
    );
  });

  it('blocks excessive paediatric mg/kg syrup doses even when the ml math matches', async () => {
    const safety = await validatePrescriptionSafety(patientId, [
      {
        name: 'Paracetamol syrup 125mg/5ml',
        dosage: '30 mg/kg = 15 ml',
        dose: '30 mg/kg = 15 ml',
        frequency: 'q6h PRN fever',
        route: 'oral',
      },
    ], { tenantId });

    expect(safety.safe).toBe(false);
    expect(safety.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'PAEDIATRIC_DOSE_HIGH',
          entered_dose_mg: 375,
        }),
      ]),
    );
  });

  it('blocks renal-risk medicines when severe eGFR evidence exists in lab_results', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO lab_results
         (tenant_id, patient_uid, patient_name, test_code, test_name, value_numeric, unit, status, received_at)
       VALUES
         ('00000000-0000-4000-8000-000000000001'::uuid, $1::uuid, 'Prescription Test Patient',
          'EGFR', 'eGFR', 22, 'mL/min/1.73m2', 'final', NOW())`,
      PATIENT_UID,
    );

    const safety = await validatePrescriptionSafety(patientId, [
      { name: 'Nitrofurantoin 100mg', dosage: '100mg', frequency: 'BD', duration: '5 days' },
    ], { tenantId });

    expect(safety.safe).toBe(false);
    expect(safety.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'RENAL_MEDICATION_REVIEW',
          medication: 'Nitrofurantoin 100mg',
          latest_egfr: 22,
        }),
      ]),
    );
  });

  it('creates a structured prescription with medications and vitals stored as jsonb', async () => {
    const res = await doctorAs(doctorId)
      .post('/api/v1/prescriptions/create')
      .send({
        patient_id: patientId,
        doctor_id: doctorId,
        diagnosis: 'Seasonal allergy',
        clinical_notes: 'No respiratory distress.',
        medications: [
          {
            name: 'Cetirizine',
            dosage: '10mg',
            frequency: 'OD',
            duration: '5 days',
            route: 'Oral',
            instructions: 'After food',
            qty: 5
          }
        ],
        vitals: { pulse: 72, spo2: 99 },
        follow_up_date: '2026-05-13',
        follow_up_notes: 'Review if symptoms persist.'
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.data.patient_id).toBe(patientId);
    expect(res.body.data.doctor_id).toBe(doctorId);
    expect(res.body.data.medications[0].name).toBe('Cetirizine');

    const stored = await prisma.$queryRawUnsafe(
      `SELECT jsonb_typeof(medications) AS medications_type,
              jsonb_typeof(vitals) AS vitals_type,
              medications->0->>'name' AS medication_name,
              vitals->>'pulse' AS pulse
       FROM e_prescriptions
       WHERE id = $1`,
      res.body.data.id
    );

    expect(stored[0]).toMatchObject({
      medications_type: 'array',
      vitals_type: 'object',
      medication_name: 'Cetirizine',
      pulse: '72'
    });
  });

  it('returns patient-facing prescription safety context without integer-param 500s', async () => {
    const rxRows = await prisma.$queryRawUnsafe(
      `INSERT INTO e_prescriptions
         (patient_id, doctor_id, medications, diagnosis, status, created_by)
       VALUES ($1::int, $2::int, $3::jsonb, 'Paediatric fever', 'active', $4::int)
       RETURNING id`,
      patientId,
      doctorId,
      JSON.stringify([{ name: 'Paracetamol syrup 125mg/5ml', dosage: '125 mg (5 ml)', route: 'oral' }]),
      staffId,
    );

    const patient = clientAs('PATIENT', PATIENT_UID, patientId);
    const res = await patient.get(`/api/v1/prescriptions/${rxRows[0].id}/safety`);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      indication: 'Paediatric fever',
      warnings: expect.any(Array),
      blockers: expect.any(Array),
      overrides: expect.any(Array),
    });
  });

  it('blocks nursing staff from creating doctor-only prescriptions', async () => {
    const res = await staffAs(staffId)
      .post('/api/v1/prescriptions/create')
      .send({
        patient_id: patientId,
        doctor_id: doctorId,
        diagnosis: 'Nurse-created prescription attempt',
        medications: [
          {
            name: 'Cetirizine',
            dosage: '10mg',
            frequency: 'OD',
            duration: '5 days',
          }
        ],
      });

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ success: false, error: 'Forbidden' });
  });

  it('records durable follow-up work without inventing an appointment slot', async () => {
    const res = await doctorAs(doctorId)
      .post('/api/v1/prescriptions/create')
      .send({
        patient_id: patientId,
        doctor_id: doctorId,
        // No appointment_id — mimics the discharge desk
        diagnosis: 'IPD discharge — electrolyte review',
        clinical_notes: 'Review serum electrolytes; repeat CBC.',
        medications: [
          { name: 'Tab Pan-40', dosage: '40mg', frequency: 'OD', duration: '7 days' },
          { name: 'Syp K-Lyte', dosage: '15mL', frequency: 'TDS', duration: '5 days' }
        ],
        follow_up_date: '2026-05-20',
        follow_up_notes: 'Review in 1 week. Repeat serum electrolytes.'
      });

    expect(res.statusCode).toBe(201);
    const prescriptionId = res.body.data.id;
    expect(prescriptionId).toBeTruthy();

    const linked = await prisma.$queryRawUnsafe(
      `SELECT ep.appointment_id,
              follow_up.origin_resource_type,
              follow_up.origin_resource_id,
              follow_up.due_at::date::text AS due_date,
              follow_up.appointment_id AS follow_up_appointment_id,
              follow_up.appointment_status,
              follow_up.status,
              follow_up.metadata
         FROM e_prescriptions AS ep
         JOIN follow_up_plans AS follow_up
           ON follow_up.tenant_id = ep.tenant_id
          AND follow_up.patient_uid = ep.patient_uid
          AND follow_up.origin_resource_type = 'e_prescription'
          AND follow_up.origin_resource_id = ep.id::text
        WHERE ep.id = $1`,
      prescriptionId
    );
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({
      appointment_id: null,
      origin_resource_type: 'e_prescription',
      origin_resource_id: String(prescriptionId),
      due_date: '2026-05-20',
      follow_up_appointment_id: null,
      appointment_status: 'pending',
      status: 'open',
      metadata: expect.objectContaining({
        prescription_id: prescriptionId,
        due_precision: 'date',
        appointment_slot_required: true,
      }),
    });
  });

  it('lets pharmacy map a generic pediatric prescription to an explicit syrup catalog selection', async () => {
    const catalogRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, category, unit_price, price, pack_size,
          requires_prescription, in_stock, is_active, is_available,
          stock_quantity, stock, reorder_level, description, updated_at)
       VALUES
         ($1, 'Paracetamol', 'analgesic', 35.00, 35.00, '60 ml bottle',
          true, true, true, true, 50, 50, 10,
          'Regression fixture for paediatric syrup substitution', NOW())
       RETURNING id`,
      PEDIATRIC_PARACETAMOL_NAME
    );
    await governCatalogIdentity(catalogRows[0].id, {
      ingredient: 'paracetamol', strengthKey: '125 mg/5 ml', formKey: 'syrup', route: 'Oral',
    });

    const rxRows = await prisma.$queryRawUnsafe(
      `INSERT INTO e_prescriptions
         (patient_id, patient_uid, doctor_id, doctor_uid, medications, status, created_by)
       VALUES ($1, $5::uuid, $2, $6::uuid, $3::jsonb, 'active', $4)
       RETURNING id`,
      patientId,
      doctorId,
      JSON.stringify([
        {
          name: 'Paracetamol',
          dosage: 'Syrup 125 mg/5 mL: 7.5 mL',
          frequency: 'QID',
          duration: '3 days',
          route: 'Oral',
          instructions: 'Give 7.5 ml by mouth every 6 hours as needed for fever. Max 4 doses/day. Weight 12.5 kg x 15 mg/kg = 187.5 mg.',
          qty: 1,
        },
      ]),
      staffId,
      PATIENT_UID,
      DOCTOR_UID
    );

    await signRx(rxRows[0].id, doctorId);

    const unmapped = await pharmacyAs()
      .post(`/api/v1/prescriptions/${rxRows[0].id}/order-pharmacy`)
      .set('Idempotency-Key', `deep-unmapped-${rxRows[0].id}`)
      .send({ delivery_type: 'counter', facility_id: facilityId });
    expect(unmapped.statusCode).toBe(400);
    expect(unmapped.body.details?.code).toBe('ITEM_NOT_IN_CATALOG');
    expect(unmapped.body.details?.suggestions?.Paracetamol?.length).toBeGreaterThan(0);

    const mapped = await pharmacyAs()
      .post(`/api/v1/prescriptions/${rxRows[0].id}/order-pharmacy`)
      .set('Idempotency-Key', `deep-mapped-${rxRows[0].id}`)
      .send({
        delivery_type: 'counter',
        facility_id: facilityId,
        catalog_overrides: {
          Paracetamol: catalogRows[0].id,
        },
      });
    expect(mapped.statusCode).toBe(200);
    expect(mapped.body.data.id).toBeDefined();

    const orderRows = await prisma.$queryRawUnsafe(
      `SELECT items_list, total_amount
         FROM pharmacy_orders
        WHERE id = $1`,
      mapped.body.data.id
    );
    expect(Number(orderRows[0].total_amount)).toBe(35);
    expect(orderRows[0].items_list[0].order_line_index).toBe(0);
    expect(orderRows[0].items_list[0].prescription_line_index).toBe(0);
    expect(orderRows[0].items_list[0].catalog_id).toBe(catalogRows[0].id);
    expect(orderRows[0].items_list[0].catalog_name).toBe(PEDIATRIC_PARACETAMOL_NAME);
    expect(orderRows[0].items_list[0].substitution).toMatchObject({
      requested_name: 'Paracetamol',
      catalog_name: PEDIATRIC_PARACETAMOL_NAME,
      explicit: true,
    });
    expect(orderRows[0].items_list[0]).toMatchObject({
      dispensed_quantity_ml: 7.5,
      child_weight_kg: 12.5,
    });
    expect(orderRows[0].items_list[0].measuring_instruction).toMatch(/medicine cup/i);

    const pharmacy = pharmacyAs();
    // B1: pharmacist clinical verification now gates counter dispense.
    const verified = await pharmacy
      .post(`/api/v1/pharmacy/orders/${mapped.body.data.id}/verify`)
      .set('Idempotency-Key', `deep-verify-${mapped.body.data.id}`)
      .send({ decision: 'verified' });
    expect(verified.statusCode).toBe(200);

    const unpaid = await pharmacy
      .post(`/api/v1/pharmacy/orders/${mapped.body.data.id}/dispense-counter`)
      .set('Idempotency-Key', `pediatric-unpaid-${mapped.body.data.id}`)
      .send({});
    expect(unpaid.statusCode).toBe(400);
    // The refusal now names the missing payment mode explicitly, and carries the
    // code on the envelope rather than inside details.
    expect(unpaid.body.code).toBe('PHARMACY_COUNTER_PAYMENT_MODE_REQUIRED');

    await seedInventoryV2ForCatalog(catalogRows[0].id, 50, { facilityId, storageLocationId });

    // Stock leaving the shelf is bound to the identity the PRESCRIBER pinned,
    // not to the one the counter chose: a dispense line has to resolve to a
    // prescription line whose own catalog_id it matches. This prescription was
    // free text, so it has no such identity and the counter cannot supply one
    // on the prescriber's behalf — the order stands, the dispense does not.
    // Funding is settled first so the refusal is provably about that identity
    // and not about money. The catalog-pinned twin below carries the rest of
    // the counter journey.
    const freeTextBody = { payment_mode: 'cash', amount_collected: 35 };
    await fundCounterOrder(mapped.body.data.id, freeTextBody);
    const unresolvable = await pharmacy
      .post(`/api/v1/pharmacy/orders/${mapped.body.data.id}/dispense-counter`)
      .set('Idempotency-Key', `pediatric-freetext-${mapped.body.data.id}`)
      .send(freeTextBody);
    expect(unresolvable.statusCode).toBe(409);
    expect(unresolvable.body.code).toBe('PHARMACY_ORDER_PRESCRIPTION_LINE_UNRESOLVED');
    expect(unresolvable.body.details).toMatchObject({
      order_line_index: 0,
      prescription_line_index: 0,
    });
    const stillPending = await prisma.$queryRawUnsafe(
      `SELECT status FROM pharmacy_orders WHERE id = $1`, mapped.body.data.id);
    expect(stillPending[0].status).toBe('PENDING');
  });

  // The counter journey the case above can no longer finish, on a prescription
  // the prescriber pinned to a catalog item: the pharmacist substitutes an
  // equivalent brand (same governed composition, strength, form, release and
  // route), pays, dispenses, and the label plus the patient's own prescription
  // list reflect the weight-based volume that actually left the shelf.
  it('dispenses a catalog-pinned pediatric syrup substitution at the counter', async () => {
    const prescribedRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, category, unit_price, price, pack_size,
          requires_prescription, in_stock, is_active, is_available,
          stock_quantity, stock, reorder_level, description, updated_at)
       VALUES ($1, 'Paracetamol', 'analgesic', 35.00, 35.00, '60 ml bottle',
          true, true, true, true, 50, 50, 10, 'Prescribed brand fixture', NOW())
       RETURNING id`,
      PRESCRIBED_BRAND_NAME,
    );
    const substituteRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, category, unit_price, price, pack_size,
          requires_prescription, in_stock, is_active, is_available,
          stock_quantity, stock, reorder_level, description, updated_at)
       VALUES ($1, 'Paracetamol', 'analgesic', 35.00, 35.00, '60 ml bottle',
          true, true, true, true, 50, 50, 10, 'Equivalent brand fixture', NOW())
       RETURNING id`,
      SUBSTITUTE_BRAND_NAME,
    );
    const identity = {
      ingredient: 'paracetamol', strengthKey: '125 mg/5 ml', formKey: 'syrup', route: 'Oral',
    };
    await governCatalogIdentity(prescribedRows[0].id, identity);
    await governCatalogIdentity(substituteRows[0].id, identity);

    const rxRows = await prisma.$queryRawUnsafe(
      `INSERT INTO e_prescriptions
         (patient_id, patient_uid, doctor_id, doctor_uid, medications, status, created_by)
       VALUES ($1, $5::uuid, $2, $6::uuid, $3::jsonb, 'active', $4) RETURNING id`,
      patientId, doctorId,
      JSON.stringify([{
        name: PRESCRIBED_BRAND_NAME,
        catalog_id: prescribedRows[0].id,
        dosage: 'Syrup 125 mg/5 mL: 7.5 mL',
        frequency: 'QID',
        duration: '3 days',
        route: 'Oral',
        instructions: 'Give 7.5 ml by mouth every 6 hours as needed for fever. Max 4 doses/day. Weight 12.5 kg x 15 mg/kg = 187.5 mg.',
        qty: 1,
      }]),
      staffId,
      PATIENT_UID,
      DOCTOR_UID,
    );
    await signRx(rxRows[0].id, doctorId);

    const mapped = await pharmacyAs()
      .post(`/api/v1/prescriptions/${rxRows[0].id}/order-pharmacy`)
      .set('Idempotency-Key', `deep-pinned-${rxRows[0].id}`)
      .send({
        delivery_type: 'counter',
        facility_id: facilityId,
        catalog_overrides: { [PRESCRIBED_BRAND_NAME]: substituteRows[0].id },
      });
    expect(mapped.statusCode).toBe(200);
    const orderId = mapped.body.data.id;
    const orderRows = await prisma.$queryRawUnsafe(
      `SELECT items_list, total_amount FROM pharmacy_orders WHERE id = $1`, orderId);
    expect(Number(orderRows[0].total_amount)).toBe(35);
    expect(orderRows[0].items_list[0]).toMatchObject({
      order_line_index: 0,
      prescription_line_index: 0,
      catalog_id: substituteRows[0].id,
      catalog_name: SUBSTITUTE_BRAND_NAME,
      dispensed_quantity_ml: 7.5,
      child_weight_kg: 12.5,
    });

    const pharmacy = pharmacyAs();
    const verified = await pharmacy
      .post(`/api/v1/pharmacy/orders/${orderId}/verify`)
      .set('Idempotency-Key', `deep-verify-pinned-${orderId}`)
      .send({ decision: 'verified' });
    expect(verified.statusCode).toBe(200);

    const unpaidPinned = await pharmacy
      .post(`/api/v1/pharmacy/orders/${orderId}/dispense-counter`)
      .set('Idempotency-Key', `pinned-unpaid-${orderId}`)
      .send({});
    expect(unpaidPinned.statusCode).toBe(400);
    expect(unpaidPinned.body.code).toBe('PHARMACY_COUNTER_PAYMENT_MODE_REQUIRED');

    await seedInventoryV2ForCatalog(substituteRows[0].id, 50, { facilityId, storageLocationId });

    const paidBody = { payment_mode: 'cash', amount_collected: 35 };
    await fundCounterOrder(orderId, paidBody);
    const paid = await pharmacy
      .post(`/api/v1/pharmacy/orders/${orderId}/dispense-counter`)
      .set('Idempotency-Key', `pinned-paid-${orderId}`)
      .send(paidBody);
    expect(paid.statusCode).toBe(200);
    expect(paid.body.data.payment_status).toBe('paid');

    const detail = await pharmacy.get(`/api/v1/pharmacy/orders/${orderId}/detail`);
    expect(detail.statusCode).toBe(200);
    const labelItem = detail.body.data.order.dispense_label.items[0];
    expect(labelItem.child_weight_kg).toBe(12.5);
    expect(labelItem.dispensed_quantity_ml).toBe(7.5);
    expect(labelItem.measuring_instruction).toMatch(/oral syringe/i);

    const patient = clientAs('PATIENT', PATIENT_UID, patientId);
    const patientList = await patient.get('/api/v1/prescriptions/patient/my');
    expect(patientList.statusCode).toBe(200);
    const patientRx = patientList.body.data.find((row) => row.id === rxRows[0].id);
    expect(patientRx).toMatchObject({
      pharmacy_order_id: orderId,
      pharmacy_order_status: 'DISPENSED',
      pharmacy_payment_status: 'paid',
      pharmacy_partial_dispense: false,
    });
    expect(Number(patientRx.pharmacy_amount_collected)).toBe(35);
    const fulfilledRx = await prisma.$queryRawUnsafe(
      `SELECT status, pharmacy_order_id FROM e_prescriptions WHERE id = $1`, rxRows[0].id);
    expect(fulfilledRx[0]).toMatchObject({ status: 'fulfilled', pharmacy_order_id: orderId });
  });

  // Finding 2026-05-22-pediatric-opd-pharmacy-f346bf82: the clinician wrote
  // the dose VOLUME ("7.5ml") before the concentration ("125mg/5ml") and named
  // the child's weight without a "weight:" keyword ("for 12.5kg child"). The
  // old order-pharmacy parser grabbed the trailing "5ml" of the concentration
  // as the dose and left child_weight_kg null, so the counter label read
  // "Measure 5 ml" — a ~33% underdose of a weight-based fever medicine. The
  // dose must derive from the recorded weight × mg/kg ÷ concentration = 7.5 mL,
  // and child_weight_kg must resolve from the patient's charted weight.
  it('derives the pediatric liquid dose from weight, not the concentration mL denominator', async () => {
    const catalogRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, category, unit_price, price, pack_size,
          requires_prescription, in_stock, is_active, is_available,
          stock_quantity, stock, reorder_level, description, updated_at)
       VALUES
         ('Paracetamol Syrup 125mg/5ml Aarav Test', 'Paracetamol', 'analgesic', 35.00, 35.00, '60 ml bottle',
          true, true, true, true, 50, 50, 10, 'f346bf82 weight-based dose fixture', NOW())
       RETURNING id`,
    );
    await governCatalogIdentity(catalogRows[0].id, {
      ingredient: 'paracetamol', strengthKey: '125 mg/5 ml', formKey: 'syrup', route: 'Oral',
    });
    // Dose text mirrors the finding exactly: dose mL BEFORE the concentration,
    // weight named WITHOUT a "weight:" keyword. No explicit dispensed_quantity_ml
    // or child_weight_kg — both must be derived. The patient fixture already
    // has a charted weight of 12.5 kg (vitals_chart in beforeAll).
    const rxRows = await prisma.$queryRawUnsafe(
      `INSERT INTO e_prescriptions
         (patient_id, patient_uid, doctor_id, doctor_uid, medications, status, created_by)
       VALUES ($1, $5::uuid, $2, $6::uuid, $3::jsonb, 'active', $4) RETURNING id`,
      patientId, doctorId,
      // catalog_id pins the prescribed formulation. A pharmacist may only
      // re-point a line at a catalog item that is provably the same
      // formulation and strength; naming the prescribed item makes the
      // override an identity confirmation instead of an unprovable free-text
      // mapping, and leaves the dose-text parsing this case is about untouched.
      JSON.stringify([{
        name: 'Paracetamol Syrup 125mg/5ml',
        catalog_id: catalogRows[0].id,
        dose: '187.5mg = 7.5ml of 125mg/5ml syrup',
        dosage: '187.5mg = 7.5ml of 125mg/5ml syrup',
        frequency: 'QID', duration: '3 days', route: 'Oral',
        instructions: 'Dose calculated at 15mg/kg for 12.5kg child',
      }]),
      staffId,
      PATIENT_UID,
      DOCTOR_UID,
    );
    await signRx(rxRows[0].id, doctorId);
    const mapped = await pharmacyAs()
      .post(`/api/v1/prescriptions/${rxRows[0].id}/order-pharmacy`)
      .set('Idempotency-Key', `deep-weight-${rxRows[0].id}`)
      .send({
        delivery_type: 'counter',
        facility_id: facilityId,
        catalog_overrides: { 'Paracetamol Syrup 125mg/5ml': catalogRows[0].id },
      });
    expect(mapped.statusCode).toBe(200);
    const orderRows = await prisma.$queryRawUnsafe(
      `SELECT items_list FROM pharmacy_orders WHERE id = $1`, mapped.body.data.id);
    const item = orderRows[0].items_list[0];
    // The fix: 7.5 mL (15 mg/kg × 12.5 kg = 187.5 mg ÷ 25 mg/mL), NOT the
    // buggy flat 5 mL lifted from the concentration denominator.
    expect(item.dispensed_quantity_ml).toBe(7.5);
    expect(item.dispensed_quantity_ml).not.toBe(5);
    // child_weight_kg resolved from the charted vital (no keyword in the text).
    expect(item.child_weight_kg).toBe(12.5);
    // The label must instruct 7.5 ml, never a standalone 5 ml. The negative
    // guard requires the "5" not be preceded by a digit/decimal point so it
    // doesn't false-match the "5" inside "7.5".
    expect(item.measuring_instruction).toMatch(/7\.5 ml/i);
    expect(item.measuring_instruction).not.toMatch(/(?:^|[^.\d])5\s*ml/i);
    expect(item.label_instruction).toMatch(/7\.5 ml/i);

    // No per-case teardown: the order carries append-only command receipts, so
    // deleting it here silently fails and dropping its catalog row would leave
    // the surviving order pointing at an identity that can no longer resolve —
    // which then fails every later safety screen for this patient closed. The
    // suite-level cleanup owns all of it.
  });

  it('refuses a counter substitution to a different concentration', async () => {
    // Finding 2026-05-21-walk-in-opd-pharmacy-c05e2adb: prescribed 3.75 mL of
    // 250mg/5mL (187.5 mg); keeping 3.75 mL of a 125mg/5mL bottle is a 50%
    // paediatric underdose. The order path used to accept the swap and rescale
    // the volume to 7.5 mL; it now refuses the swap outright, because a
    // different concentration is by definition not a same-formulation
    // equivalent and only the prescriber may re-issue against the stocked
    // strength. Refusing is strictly stronger than rescaling: the underdose is
    // impossible either way, and here the pharmacist can no longer decide on
    // their own that two strengths are interchangeable.
    const catalogRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, category, unit_price, price, pack_size,
          requires_prescription, in_stock, is_active, is_available,
          stock_quantity, stock, reorder_level, description, updated_at)
       VALUES
         ('Paracetamol Syrup 125mg/5ml Recalc Test', 'Paracetamol', 'analgesic', 35.00, 35.00, '60 ml bottle',
          true, true, true, true, 50, 50, 10, 'Recalc substitution fixture', NOW())
       RETURNING id`,
    );
    await governCatalogIdentity(catalogRows[0].id, {
      ingredient: 'paracetamol', strengthKey: '125 mg/5 ml', formKey: 'syrup', route: 'Oral',
    });
    const rxRows = await prisma.$queryRawUnsafe(
      `INSERT INTO e_prescriptions
         (patient_id, patient_uid, doctor_id, doctor_uid, medications, status, created_by)
       VALUES ($1, $5::uuid, $2, $6::uuid, $3::jsonb, 'active', $4) RETURNING id`,
      patientId, doctorId,
      JSON.stringify([{
        name: 'Paracetamol 250mg/5mL syrup',
        dosage: 'Syrup 250 mg/5 mL: 3.75 mL',
        frequency: 'QID', duration: '3 days', route: 'Oral',
        instructions: 'Give 3.75 ml every 6 hours. Weight 12.5 kg.',
        qty: 1,
      }]),
      staffId,
      PATIENT_UID,
      DOCTOR_UID,
    );
    await signRx(rxRows[0].id, doctorId);
    const ordersBefore = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM pharmacy_orders WHERE patient_id = $1`,
      patientId);
    const mapped = await pharmacyAs()
      .post(`/api/v1/prescriptions/${rxRows[0].id}/order-pharmacy`)
      .set('Idempotency-Key', `deep-recalc-${rxRows[0].id}`)
      .send({
        delivery_type: 'counter',
        facility_id: facilityId,
        catalog_overrides: { 'Paracetamol 250mg/5mL syrup': catalogRows[0].id },
      });
    expect(mapped.statusCode).toBe(409);
    expect(mapped.body.code).toBe('PRESCRIPTION_CATALOG_CANONICALIZATION_REQUIRED');
    expect(mapped.body.details).toMatchObject({
      order_line_index: 0,
      medication_name: 'Paracetamol 250mg/5mL syrup',
      recovery_action: 'prescriber_canonicalize_catalog_item',
    });
    // Refusal means refusal: no order row was written, and the prescription is
    // left exactly as the prescriber signed it.
    const ordersAfter = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM pharmacy_orders WHERE patient_id = $1`,
      patientId);
    expect(ordersAfter[0].count).toBe(ordersBefore[0].count);
    const rxAfter = await prisma.$queryRawUnsafe(
      `SELECT status, pharmacy_order_id, pharmacy_opted FROM e_prescriptions WHERE id = $1`,
      rxRows[0].id);
    expect(rxAfter[0]).toMatchObject({
      status: 'active', pharmacy_order_id: null, pharmacy_opted: false,
    });

    // Nothing downstream exists to hold this one, and a signed free-text line
    // with no catalog identity is itself an unresolvable active therapy — leave
    // it behind and every later safety screen for this patient fails closed on
    // a prescription this case deliberately never got dispensed.
    await prisma.$executeRawUnsafe(
      `DELETE FROM e_prescriptions WHERE id = $1`, rxRows[0].id).catch(() => {});
  });

  // Finding 2026-05-21-walk-in-opd-pharmacy-1646bc24 (+ 938226ba / b5f42707):
  // a TDS×3-day tablet Rx with no explicit quantity must (1) derive qty=9 from
  // frequency×duration instead of silently defaulting to 1, (2) NOT carry the
  // liquid "measure with an oral syringe" instruction, and (3) at dispense
  // time, reject a quantity that does not match the ordered count unless the
  // pharmacist explicitly acknowledges the mismatch.
  it('derives tablet quantity from frequency×duration and gates the dispense quantity mismatch', async () => {
    const TABLET_NAME = 'Paracetamol 500mg Tablet Qty Test';
    const catalogRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, category, unit_price, price, pack_size,
          requires_prescription, in_stock, is_active, is_available,
          stock_quantity, stock, reorder_level, description, updated_at)
       VALUES
         ($1, 'Paracetamol', 'analgesic', 12.00, 12.00, '10 tablets',
          true, true, true, true, 100, 100, 10, 'Tablet qty-guard fixture', NOW())
       RETURNING id`,
      TABLET_NAME,
    );
    const catalogId = catalogRows[0].id;
    await governCatalogIdentity(catalogId, {
      ingredient: 'paracetamol', strengthKey: '500 mg', formKey: 'tablet', route: 'Oral',
    });

    // Rx: 1-1-1 (TDS) for 3 days, NO explicit quantity → clinically 9 tablets.
    const rxRows = await prisma.$queryRawUnsafe(
      `INSERT INTO e_prescriptions
         (patient_id, patient_uid, doctor_id, doctor_uid, medications, status, created_by)
       VALUES ($1, $5::uuid, $2, $6::uuid, $3::jsonb, 'active', $4) RETURNING id`,
      patientId, doctorId,
      // catalog_id pins the prescribed formulation — see the note on the
      // weight-based case above. The quantity is still deliberately absent.
      JSON.stringify([{
        name: 'Paracetamol 500 mg',
        catalog_id: catalogId,
        dosage: '500 mg', strength: '500 mg',
        frequency: '1-1-1', duration: '3 days', route: 'Oral',
        instructions: 'After food',
        // deliberately no qty / quantity
      }]),
      staffId,
      PATIENT_UID,
      DOCTOR_UID,
    );

    await signRx(rxRows[0].id, doctorId);
    const mapped = await pharmacyAs()
      .post(`/api/v1/prescriptions/${rxRows[0].id}/order-pharmacy`)
      .set('Idempotency-Key', `deep-tablet-${rxRows[0].id}`)
      .send({
        delivery_type: 'counter',
        facility_id: facilityId,
        catalog_overrides: { 'Paracetamol 500 mg': catalogId },
      });
    expect(mapped.statusCode).toBe(200);
    const orderId = mapped.body.data.id;

    const orderRows = await prisma.$queryRawUnsafe(
      `SELECT items_list, total_amount FROM pharmacy_orders WHERE id = $1`, orderId);
    const item = orderRows[0].items_list[0];
    // (1) qty derived to 9, not silently 1.
    expect(item.qty).toBe(9);
    expect(item.quantity_source).toBe('derived_frequency_duration');
    expect(item.quantity_needs_confirmation).toBe(false);
    expect(Number(orderRows[0].total_amount)).toBe(108);
    // (2) a tablet must NOT get liquid mL instructions / dose-conversion warning.
    expect(item.dispensed_quantity_ml).toBeNull();
    expect(item.measuring_instruction).toBeNull();
    expect(item.substitution?.dose_conversion_required).toBeUndefined();

    const pharmacy = pharmacyAs();
    // B1: pharmacist clinical verification gates counter dispense. The
    // shared fixture patient is paediatric, so a 500mg adult tablet trips
    // the paediatric-dose blocker — plain 'verified' must refuse, and the
    // pharmacist proceeds through the audited override path.
    const refused = await pharmacy
      .post(`/api/v1/pharmacy/orders/${orderId}/verify`)
      .set('Idempotency-Key', `deep-verify-refused-${orderId}`)
      .send({ decision: 'verified' });
    expect(refused.statusCode).toBe(409);
    const verified = await pharmacyInchargeAs()
      .post(`/api/v1/pharmacy/orders/${orderId}/verify`)
      .set('Idempotency-Key', `deep-verify-tablet-${orderId}`)
      .send({ decision: 'override', override_reason: 'Test fixture: quantity-guard scenario, dose reviewed' });
    expect(verified.statusCode).toBe(200);

    await seedInventoryV2ForCatalog(catalogId, 100, { facilityId, storageLocationId });

    // (3a) Dispensing a quantity that mismatches the ordered 9 is blocked.
    const overDispense = await pharmacy
      .post(`/api/v1/pharmacy/orders/${orderId}/dispense-counter`)
      .set('Idempotency-Key', `quantity-over-${orderId}`)
      .send({
        payment_mode: 'cash', amount_collected: 144,
        dispensed_items: [{ order_line_index: 0, catalog_id: catalogId, name: 'Paracetamol', dispensed_qty: 12 }],
      });
    expect(overDispense.statusCode).toBe(400);
    // The refusal code is on the envelope; details still carries the per-line
    // mismatch evidence.
    expect(overDispense.body.code).toBe('DISPENSE_QUANTITY_MISMATCH');
    expect(overDispense.body.details?.mismatches?.[0]).toMatchObject({
      ordered_qty: 9, dispensed_qty: 12, kind: 'over_dispense',
    });

    // (3b) Even the exact ordered quantity cannot leave the shelf: stock movement
    // is authorised against the quantity the PRESCRIBER wrote, and this line
    // deliberately carries none — the order-time derivation is a counter
    // convenience, not prescribing authority. Refusing here is strictly stronger
    // than dispensing on a guessed count; the clean end-to-end counter dispense
    // is proved on the catalog-pinned syrup case above.
    const matchedBody = {
      payment_mode: 'cash', amount_collected: 108,
      dispensed_items: [{ order_line_index: 0, catalog_id: catalogId, name: 'Paracetamol', dispensed_qty: 9 }],
    };
    await fundCounterOrder(orderId, matchedBody);
    const matched = await pharmacy
      .post(`/api/v1/pharmacy/orders/${orderId}/dispense-counter`)
      .set('Idempotency-Key', `quantity-match-${orderId}`)
      .send(matchedBody);
    expect(matched.statusCode).toBe(400);
    expect(matched.body.code).toBe('PHARMACY_DISPENSE_QUANTITY_INVALID');
    expect(matched.body.message).toMatch(/prescription\.medications\[0\]\.quantity/);
    const unfulfilledRx = await prisma.$queryRawUnsafe(
      `SELECT status FROM e_prescriptions WHERE id = $1`, rxRows[0].id);
    expect(unfulfilledRx[0].status).toBe('pharmacy_linked');
    const stillPendingOrder = await prisma.$queryRawUnsafe(
      `SELECT status FROM pharmacy_orders WHERE id = $1`, orderId);
    expect(stillPendingOrder[0].status).toBe('PENDING');

    // No per-case teardown: the order carries append-only command receipts, so
    // deleting it here silently fails and dropping its catalog row would leave
    // the surviving order pointing at an identity that can no longer resolve —
    // which then fails every later safety screen for this patient closed. The
    // suite-level cleanup owns all of it.
  });

  // Companion to 1646bc24: acknowledging a shortfall used to turn the quantity
  // guard into a confirmation gate. It is now a hard block — the remainder needs
  // its own governed order, funding and cap authority before any of the supply
  // moves.
  it('refuses a short counter dispense even when the pharmacist acknowledges it', async () => {
    const TABLET_NAME = 'Amoxicillin 500mg Tablet Ack Test';
    const catalogRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, category, unit_price, price, pack_size,
          requires_prescription, in_stock, is_active, is_available,
          stock_quantity, stock, reorder_level, description, updated_at)
       VALUES
         ($1, 'Amoxicillin', 'antibiotic', 10.00, 10.00, '10 tablets',
          true, true, true, true, 100, 100, 10, 'Ack-mismatch fixture', NOW())
       RETURNING id`,
      TABLET_NAME,
    );
    const catalogId = catalogRows[0].id;
    await governCatalogIdentity(catalogId, {
      ingredient: 'amoxicillin', strengthKey: '500 mg', formKey: 'tablet', route: 'Oral',
    });

    // Explicit qty=10 (BD × 5 days), pharmacist dispenses 9 with acknowledgement.
    const rxRows = await prisma.$queryRawUnsafe(
      `INSERT INTO e_prescriptions
         (patient_id, patient_uid, doctor_id, doctor_uid, medications, status, created_by)
       VALUES ($1, $5::uuid, $2, $6::uuid, $3::jsonb, 'active', $4) RETURNING id`,
      patientId, doctorId,
      JSON.stringify([{
        name: 'Amoxicillin 500 mg', catalog_id: catalogId,
        dosage: '500 mg', strength: '500 mg',
        frequency: 'BD', duration: '5 days', route: 'Oral', qty: 10,
      }]),
      staffId,
      PATIENT_UID,
      DOCTOR_UID,
    );
    await signRx(rxRows[0].id, doctorId);
    const mapped = await pharmacyAs()
      .post(`/api/v1/prescriptions/${rxRows[0].id}/order-pharmacy`)
      .set('Idempotency-Key', `deep-ack-${rxRows[0].id}`)
      .send({
        delivery_type: 'counter',
        facility_id: facilityId,
        catalog_overrides: { 'Amoxicillin 500 mg': catalogId },
      });
    expect(mapped.statusCode).toBe(200);
    const orderId = mapped.body.data.id;
    const orderRows = await prisma.$queryRawUnsafe(
      `SELECT items_list FROM pharmacy_orders WHERE id = $1`, orderId);
    expect(orderRows[0].items_list[0].qty).toBe(10);
    expect(orderRows[0].items_list[0].quantity_source).toBe('explicit');

    const pharmacy = pharmacyAs();
    // B1: pharmacist clinical verification gates counter dispense (override
    // path — paediatric fixture patient + adult tablet trips the dose blocker).
    const verified = await pharmacyInchargeAs()
      .post(`/api/v1/pharmacy/orders/${orderId}/verify`)
      .set('Idempotency-Key', `deep-verify-ack-${orderId}`)
      .send({ decision: 'override', override_reason: 'Test fixture: ack-mismatch scenario, dose reviewed' });
    expect(verified.statusCode).toBe(200);

    await seedInventoryV2ForCatalog(catalogId, 100, { facilityId, storageLocationId });

    // Unacknowledged short-supply with no partial intent is blocked.
    const blocked = await pharmacy
      .post(`/api/v1/pharmacy/orders/${orderId}/dispense-counter`)
      .set('Idempotency-Key', `quantity-blocked-${orderId}`)
      .send({
        payment_mode: 'cash', amount_collected: 90,
        dispensed_items: [{ order_line_index: 0, catalog_id: catalogId, name: 'Amoxicillin', dispensed_qty: 9 }],
      });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.body.code).toBe('DISPENSE_QUANTITY_MISMATCH');

    // Acknowledging the shortfall is no longer enough on its own: a short
    // counter dispense is blocked until the remainder has its own governed
    // order, funding and cap authority. That is strictly stronger than the old
    // behaviour, which billed and part-fulfilled the prescription on the
    // pharmacist's say-so and left the balance owed to nobody.
    const ackedBody = {
      payment_mode: 'cash', amount_collected: 90,
      quantity_mismatch_acknowledged: true,
      mismatch_reason: 'One blister short in stock; patient to collect balance tomorrow',
      dispensed_items: [{ order_line_index: 0, catalog_id: catalogId, name: 'Amoxicillin', dispensed_qty: 9 }],
    };
    const acked = await pharmacy
      .post(`/api/v1/pharmacy/orders/${orderId}/dispense-counter`)
      .set('Idempotency-Key', `quantity-acked-${orderId}`)
      .send(ackedBody);
    expect(acked.statusCode).toBe(409);
    expect(acked.body.code).toBe('PHARMACY_PARTIAL_DISPENSE_FUNDING_SPLIT_REQUIRED');
    // Nothing moved: no stock, no bill, no partial fulfilment.
    const partialRx = await prisma.$queryRawUnsafe(
      `SELECT status, pharmacy_order_id FROM e_prescriptions WHERE id = $1`, rxRows[0].id);
    expect(partialRx[0]).toMatchObject({ status: 'pharmacy_linked', pharmacy_order_id: orderId });
    const orderAfter = await prisma.$queryRawUnsafe(
      `SELECT status FROM pharmacy_orders WHERE id = $1`, orderId);
    expect(orderAfter[0].status).toBe('PENDING');
    const history = await prisma.$queryRawUnsafe(
      `SELECT notes FROM pharmacy_order_history
        WHERE order_id = $1 AND to_status = 'DISPENSED'`, orderId);
    expect(history).toHaveLength(0);

    // No per-case teardown: the order carries append-only command receipts, so
    // deleting it here silently fails and dropping its catalog row would leave
    // the surviving order pointing at an identity that can no longer resolve —
    // which then fails every later safety screen for this patient closed. The
    // suite-level cleanup owns all of it.
  });

  it('creates medication reminders from a q6h paediatric prescription', async () => {
    const res = await doctorAs(doctorId)
      .post('/api/v1/prescriptions/create')
      .send({
        patient_id: patientId,
        doctor_id: doctorId,
        diagnosis: 'Viral fever',
        clinical_notes: 'Hydration advice given.',
        medications: [
          {
            name: 'Paracetamol syrup 125mg/5ml',
            dosage: '187.5 mg (7.5 ml)',
            dose: '187.5 mg (7.5 ml)',
            frequency: 'q6h PRN fever',
            duration: '3 days',
            route: 'oral',
            instructions: 'Give 7.5 ml by mouth every 6 hours as needed for fever. Max 4 doses/day.',
            max_doses_per_day: 4,
          },
        ],
      });

    expect(res.statusCode).toBe(201);
    const reminders = await prisma.$queryRawUnsafe(
      `SELECT medication_name, dosage, frequency, reminder_times, notes
         FROM medication_reminders
        WHERE patient_uid = $1::uuid
          AND medication_name ILIKE 'Paracetamol%'
          AND is_active = true
        ORDER BY created_at DESC
        LIMIT 1`,
      PATIENT_UID,
    );
    expect(reminders).toHaveLength(1);
    expect(reminders[0].frequency).toBe('four_times_daily');
    expect(reminders[0].reminder_times).toEqual(['06:00', '12:00', '18:00', '00:00']);
    expect(reminders[0].notes).toMatch(/Max 4 doses\/day/i);
  });
});
