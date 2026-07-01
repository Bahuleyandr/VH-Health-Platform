// src/tests/composition-identity-persistence.deep.test.js
//
// Phase 2 — persist SERVER-DERIVED composition identity into the two clinical
// write paths (IPD/CPOE createOrder + createOrdersBulk, and e-Rx create/update).
//
// The invariant under test: whenever a medication write carries a `catalog_id`
// and the server can resolve a composition identity for it, the PERSISTED
// payload (clinical_orders.details / e_prescriptions.medications) carries the
// SERVER-derived CANONICAL composition identity (composition_id, active_ingredients,
// strength_key/form_key/release_key, composition_confidence, strength_components,
// composition_key/label) — never a client-sent `composition_id`. A bogus client
// composition_id (999999) must be OVERWRITTEN by the real one.
//
// INERTNESS: the overlay must NOT touch the four clinician-entered clinical
// free-text fields — `strength`, `form`, `route`, `generic_name`. A doctor who
// sets route:'IV' (or overrides strength/form) keeps their value verbatim even
// when the catalog column differs or is NULL. This keeps the always-on persist
// path from changing what MAR/e-Rx-PDF/drug-chart/pharmacist readers see.
//
// The enrichment is always-on when a catalog_id is present (NOT flag-gated) and
// is guarded so a resolution failure leaves the original payload untouched and
// the write still succeeds.
//
// Model: real DB + real createOrder / real controller handlers. The QA test DB
// runs as superuser (RLS bypassed) — fine for tests: we seed tenant-scoped rows
// directly. Patient has NO allergy so CDS does not block the create.

import { jest } from '@jest/globals';
import prisma from '../lib/prisma.js';
import { createOrder, createOrdersBulk } from '../services/emr/orderEntryService.js';
import {
  createPrescription,
  updatePrescription,
} from '../controllers/prescription/ePrescriptionController.js';

const TENANT_ID = '00000000-0000-4000-8000-00000c1d0001';
const EMPTY_TENANT_ID = '00000000-0000-4000-8000-00000c1d0002'; // no catalog rows → enrich resolves nothing

const PATIENT_UID = 'c1d00000-0000-4000-8000-00000000d001'; // NO-allergy patient
const DOCTOR_UID = 'c1d00000-0000-4000-8000-00000000d002';
const PATIENT_PHONE = '+919711000701';
const DOCTOR_PHONE = '+919711000702';

jest.setTimeout(60000);

let patientId; // integer users.id
let doctorId; // integer users.id
let compositionId; // amoxicillin+clavulanic_acid composition
let augmentinId; // high-confidence catalog row (that composition)

// ── helpers ────────────────────────────────────────────────────────────────
async function seedTenant(id, slug, name) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, $3) ON CONFLICT (id) DO NOTHING`,
    id, slug, name,
  );
}

async function catalogId(name) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM pharmacy_catalog WHERE name = $1 LIMIT 1`,
    name,
  );
  return Number(rows[0].id);
}

// Build a minimal Express-style req/res pair for the controller handlers.
function makeReqRes(body, { role = 'DOCTOR', uid = DOCTOR_UID, id } = {}) {
  const req = {
    body,
    params: {},
    user: { role, uid, id },
    tenantId: TENANT_ID,
  };
  const res = {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.payload = obj;
      return this;
    },
  };
  return { req, res };
}

async function readPersistedRxMedications(prescriptionId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT medications FROM e_prescriptions WHERE id = $1`,
    prescriptionId,
  );
  const meds = rows[0].medications;
  return typeof meds === 'string' ? JSON.parse(meds) : meds;
}

async function cleanup() {
  await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_catalog WHERE name LIKE 'CIPTEST %'`).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM prescription_safety_overrides WHERE patient_id = $1`, patientId ?? -1,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM e_prescriptions WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid AND source_table = 'clinical_orders'`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid AND resource_table = 'clinical_orders'`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_safety_reviews WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID,
  ).catch(() => {});
}

describe('composition identity persistence (IPD createOrder/bulk + e-Rx create/update)', () => {
  beforeAll(async () => {
    await seedTenant(TENANT_ID, 'cip-tenant', 'CIP Tenant');
    await seedTenant(EMPTY_TENANT_ID, 'cip-empty-tenant', 'CIP Empty Tenant');

    // Ensure users cleared before seeding (patientId/doctorId not yet known here).
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_catalog WHERE name LIKE 'CIPTEST %'`).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM e_prescriptions WHERE patient_uid = $1::uuid`, PATIENT_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`, PATIENT_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID,
    ).catch(() => {});

    // NO-allergy patient so CDS does not block the medication create.
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'CIP NoAllergy Patient [test]', 'PATIENT', true, $3::uuid, NOW())
       RETURNING id`,
      PATIENT_UID, PATIENT_PHONE, TENANT_ID,
    );
    patientId = Number(p[0].id);

    const d = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'CIP Doctor [test]', 'DOCTOR', true, $3::uuid, NOW())
       RETURNING id`,
      DOCTOR_UID, DOCTOR_PHONE, TENANT_ID,
    );
    doctorId = Number(d[0].id);

    // Composition (amoxicillin + clavulanic acid).
    const comp = await prisma.$queryRawUnsafe(
      `INSERT INTO drug_compositions (composition_key, display_label, active_ingredients, source)
       VALUES ('ciptest_amoxicillin+clavulanic_acid', 'Amoxicillin + Clavulanic Acid',
               ARRAY['amoxicillin','clavulanic_acid']::text[], 'parsed')
       ON CONFLICT (composition_key) DO UPDATE SET display_label = EXCLUDED.display_label
       RETURNING id`,
    );
    compositionId = Number(comp[0].id);

    // High-confidence catalog row with strength/form populated.
    await prisma.$executeRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, is_active, tenant_id, composition_id, strength, strength_key,
          strength_components, form, form_key, route, composition_confidence, composition_source, updated_at)
       VALUES ('CIPTEST Augmentin 625', 'Amox+Clav', TRUE, $1::uuid, $2::int,
               '500mg+125mg', '625mg', $3::jsonb, 'Tablet', 'tablet', 'oral', 'high', 'parsed', NOW())`,
      TENANT_ID, compositionId,
      JSON.stringify([{ ingredient: 'amoxicillin', value: 500, unit: 'mg' }, { ingredient: 'clavulanic_acid', value: 125, unit: 'mg' }]),
    );
    augmentinId = await catalogId('CIPTEST Augmentin 625');
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  // ── IPD (CPOE) createOrder ────────────────────────────────────────────────
  it('IPD: createOrder persists server-derived CANONICAL identity; bogus client composition_id overwritten; clinician route/strength/form/generic_name PRESERVED', async () => {
    const result = await createOrder({
      patient_uid: PATIENT_UID,
      order_type: 'medication',
      encounter_id: null,
      details: {
        medication_name: 'Augmentin 625',
        catalog_id: augmentinId,
        composition_id: 999999, // bogus client value — must be overwritten
        dose: '1 tab',
        route: 'IV', // clinician value DIFFERS from catalog 'oral' — must be preserved
        strength: '875mg+125mg', // clinician override of catalog '500mg+125mg'
        form: 'Injection', // clinician override of catalog 'Tablet'
        generic_name: 'clinician amox+clav', // clinician override of catalog 'Amox+Clav'
        frequency: 'BD',
      },
      ordered_by: DOCTOR_UID,
      tenantId: TENANT_ID,
    });

    const orderId = Number(result.order.id);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT details FROM clinical_orders WHERE id = $1`, orderId,
    );
    const details = typeof rows[0].details === 'string'
      ? JSON.parse(rows[0].details)
      : rows[0].details;

    // Server-derived CANONICAL identity — bogus 999999 overwritten with the real one.
    expect(details.composition_id).toBe(compositionId);
    expect(details.composition_id).not.toBe(999999);
    expect(Array.isArray(details.strength_components)).toBe(true);
    expect(details.strength_components).toEqual([
      { ingredient: 'amoxicillin', value: 500, unit: 'mg' },
      { ingredient: 'clavulanic_acid', value: 125, unit: 'mg' },
    ]);
    // Inertness: clinician clinical free-text PRESERVED verbatim — NOT
    // overwritten by the catalog's route/strength/form/generic_name.
    expect(details.route).toBe('IV');
    expect(details.strength).toBe('875mg+125mg');
    expect(details.form).toBe('Injection');
    expect(details.generic_name).toBe('clinician amox+clav');
    // Original details fields survive.
    expect(details.medication_name).toBe('Augmentin 625');
    expect(details.dose).toBe('1 tab');
    expect(details.frequency).toBe('BD');
    expect(Number(details.catalog_id)).toBe(augmentinId);
  });

  it('IPD: createOrdersBulk persists server-derived CANONICAL identity on the medication item; clinician route preserved', async () => {
    const results = await createOrdersBulk([
      { patient_uid: PATIENT_UID, order_type: 'investigation', details: { test_name: 'CBC' } },
      {
        patient_uid: PATIENT_UID,
        order_type: 'medication',
        details: {
          medication_name: 'Augmentin 625',
          catalog_id: augmentinId,
          composition_id: 999999,
          dose: '1 tab',
          route: 'IV', // differs from catalog 'oral' — must be preserved
        },
      },
    ], { ordered_by: DOCTOR_UID, tenantId: TENANT_ID });

    const medOrder = results.find((r) => r.order.order_type === 'medication');
    const rows = await prisma.$queryRawUnsafe(
      `SELECT details FROM clinical_orders WHERE id = $1`, Number(medOrder.order.id),
    );
    const details = typeof rows[0].details === 'string'
      ? JSON.parse(rows[0].details)
      : rows[0].details;
    // Server-derived canonical identity set.
    expect(details.composition_id).toBe(compositionId);
    expect(details.composition_id).not.toBe(999999);
    expect(Array.isArray(details.strength_components)).toBe(true);
    // Clinician route preserved (not overwritten by catalog 'oral').
    expect(details.route).toBe('IV');
    // The clinician did not send strength/generic_name; the inert overlay does
    // NOT fabricate them from the catalog.
    expect(details).not.toHaveProperty('strength');
    expect(details).not.toHaveProperty('generic_name');
    expect(details.dose).toBe('1 tab');
  });

  it('IPD: an order with NO catalog_id saves normally with no fabricated composition fields', async () => {
    const result = await createOrder({
      patient_uid: PATIENT_UID,
      order_type: 'medication',
      encounter_id: null,
      details: {
        medication_name: 'Paracetamol 500 (free text)',
        dose: '1 tab',
        route: 'oral',
      },
      ordered_by: DOCTOR_UID,
      tenantId: TENANT_ID,
    });
    const rows = await prisma.$queryRawUnsafe(
      `SELECT details FROM clinical_orders WHERE id = $1`, Number(result.order.id),
    );
    const details = typeof rows[0].details === 'string'
      ? JSON.parse(rows[0].details)
      : rows[0].details;
    expect(details.medication_name).toBe('Paracetamol 500 (free text)');
    expect(details).not.toHaveProperty('composition_id');
    expect(details).not.toHaveProperty('strength_key');
    expect(details).not.toHaveProperty('generic_name');
  });

  it('IPD: guarded — a catalog_id under an empty tenant resolves nothing; write succeeds, client composition_id stripped, no fields fabricated', async () => {
    const result = await createOrder({
      patient_uid: PATIENT_UID,
      order_type: 'medication',
      encounter_id: null,
      details: {
        medication_name: 'Ghost Drug',
        catalog_id: augmentinId, // real id, but EMPTY_TENANT_ID cannot resolve it
        composition_id: 999999, // client value — must be stripped (never trusted)
        dose: '1 tab',
      },
      ordered_by: DOCTOR_UID,
      tenantId: EMPTY_TENANT_ID,
    });
    const rows = await prisma.$queryRawUnsafe(
      `SELECT details FROM clinical_orders WHERE id = $1`, Number(result.order.id),
    );
    const details = typeof rows[0].details === 'string'
      ? JSON.parse(rows[0].details)
      : rows[0].details;
    // Write succeeded, original non-identity fields survive.
    expect(details.medication_name).toBe('Ghost Drug');
    expect(details.dose).toBe('1 tab');
    // Client composition_id was stripped (never trusted) and no server value overlaid.
    expect(details.composition_id).toBeUndefined();
    expect(details).not.toHaveProperty('generic_name');
    // Clean up under EMPTY_TENANT_ID (superuser test DB → direct delete).
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_orders WHERE id = $1`, Number(result.order.id),
    ).catch(() => {});
  });

  // ── e-Rx create ───────────────────────────────────────────────────────────
  it('e-Rx CREATE persists server-derived CANONICAL identity; bogus client composition_id overwritten; clinician strength/form/route/generic_name PRESERVED', async () => {
    const { req, res } = makeReqRes({
      patient_id: patientId,
      doctor_id: doctorId,
      diagnosis: 'URTI',
      medications: [
        {
          catalog_id: augmentinId,
          name: 'Augmentin 625',
          composition_id: 999999, // bogus client value
          dose: '1 tab',
          frequency: 'BD',
          route: 'IV', // differs from catalog 'oral' — must be preserved
          strength: '875mg+125mg', // clinician override of catalog '500mg+125mg'
          form: 'Injection', // clinician override of catalog 'Tablet'
          generic_name: 'clinician amox+clav', // clinician override of catalog 'Amox+Clav'
        },
      ],
    }, { id: doctorId });

    await createPrescription(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.payload?.success).toBe(true);
    const prescriptionId = res.payload.data.id;

    const meds = await readPersistedRxMedications(prescriptionId);
    expect(meds.length).toBe(1);
    const med = meds[0];
    // Server-derived canonical identity — bogus overwritten with the real one.
    expect(med.composition_id).toBe(compositionId);
    expect(med.composition_id).not.toBe(999999);
    expect(Array.isArray(med.strength_components)).toBe(true);
    // Inertness: clinician clinical free-text PRESERVED verbatim.
    expect(med.route).toBe('IV');
    expect(med.strength).toBe('875mg+125mg');
    expect(med.form).toBe('Injection');
    expect(med.generic_name).toBe('clinician amox+clav');
    // Original med fields survive.
    expect(med.name).toBe('Augmentin 625');
    expect(med.dose).toBe('1 tab');
    expect(med.frequency).toBe('BD');
    expect(Number(med.catalog_id)).toBe(augmentinId);
  });

  it('e-Rx CREATE: a med with NO catalog_id saves normally with no fabricated composition fields', async () => {
    const { req, res } = makeReqRes({
      patient_id: patientId,
      doctor_id: doctorId,
      diagnosis: 'Fever',
      medications: [
        { name: 'Paracetamol 500 (free text)', dose: '1 tab', frequency: 'TDS' },
      ],
    }, { id: doctorId });

    await createPrescription(req, res);
    expect(res.statusCode).toBe(201);
    const meds = await readPersistedRxMedications(res.payload.data.id);
    expect(meds[0].name).toBe('Paracetamol 500 (free text)');
    expect(meds[0]).not.toHaveProperty('composition_id');
    expect(meds[0]).not.toHaveProperty('generic_name');
  });

  it('e-Rx CREATE: guarded — a catalog_id under an empty tenant resolves nothing; persist succeeds, client composition_id stripped', async () => {
    const { req, res } = makeReqRes({
      patient_id: patientId,
      doctor_id: doctorId,
      diagnosis: 'Guarded path',
      medications: [
        { catalog_id: augmentinId, name: 'Ghost', composition_id: 999999, dose: '1 tab' },
      ],
    }, { id: doctorId });
    // Force the empty tenant so enrichment resolves nothing.
    req.tenantId = EMPTY_TENANT_ID;

    await createPrescription(req, res);
    expect(res.statusCode).toBe(201);
    const meds = await readPersistedRxMedications(res.payload.data.id);
    expect(meds[0].name).toBe('Ghost');
    expect(meds[0].dose).toBe('1 tab');
    // Client composition_id was stripped and no server value overlaid.
    expect(meds[0].composition_id).toBeUndefined();
    expect(meds[0]).not.toHaveProperty('generic_name');
  });

  // ── e-Rx update ───────────────────────────────────────────────────────────
  it('e-Rx UPDATE persists server-derived composition identity; bogus client composition_id overwritten', async () => {
    // Seed a plain draft prescription owned by the doctor (no catalog_id yet).
    const { req: createReq, res: createRes } = makeReqRes({
      patient_id: patientId,
      doctor_id: doctorId,
      diagnosis: 'to-update',
      medications: [{ name: 'Placeholder', dose: '1 tab' }],
    }, { id: doctorId });
    await createPrescription(createReq, createRes);
    expect(createRes.statusCode).toBe(201);
    const prescriptionId = createRes.payload.data.id;

    // Now UPDATE with a catalog_id + bogus composition_id + a clinician route override.
    const { req, res } = makeReqRes({
      medications: [
        {
          catalog_id: augmentinId,
          name: 'Augmentin 625',
          composition_id: 999999,
          dose: '2 tab',
          route: 'IV', // differs from catalog 'oral' — must be preserved
        },
      ],
    }, { id: doctorId });
    req.params.id = String(prescriptionId);

    await updatePrescription(req, res);
    expect(res.statusCode).toBe(200);

    const meds = await readPersistedRxMedications(prescriptionId);
    expect(meds.length).toBe(1);
    // Server-derived canonical identity set.
    expect(meds[0].composition_id).toBe(compositionId);
    expect(meds[0].composition_id).not.toBe(999999);
    expect(Array.isArray(meds[0].strength_components)).toBe(true);
    // Clinician route preserved; unsent strength/generic_name not fabricated.
    expect(meds[0].route).toBe('IV');
    expect(meds[0]).not.toHaveProperty('strength');
    expect(meds[0]).not.toHaveProperty('generic_name');
    expect(meds[0].name).toBe('Augmentin 625');
    expect(meds[0].dose).toBe('2 tab');
  });
});
