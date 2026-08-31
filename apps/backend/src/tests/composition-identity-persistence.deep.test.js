// src/tests/composition-identity-persistence.deep.test.js
//
// Phase 2 — persist SERVER-DERIVED composition identity into the two clinical
// write paths (IPD/CPOE createOrder + createOrdersBulk, and e-Rx create/update).
//
// CPOE medication orders bind the selected active catalog's high-confidence
// composition, strength components, form, route, and release identity before
// persistence. Conflicting caller identity is rejected rather than silently
// overlaid. The e-prescription assertions below retain their separate
// server-derived composition contract.
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
const EMPTY_PATIENT_UID = 'c1d00000-0000-4000-8000-00000000e001';
const EMPTY_DOCTOR_UID = 'c1d00000-0000-4000-8000-00000000e002';
const ENCOUNTER_ID = 'c1d00000-0000-4000-8000-00000000d003';
const EMPTY_ENCOUNTER_ID = 'c1d00000-0000-4000-8000-00000000e003';
const PATIENT_PHONE = '+919711000701';
const DOCTOR_PHONE = '+919711000702';
const EMPTY_PATIENT_PHONE = '+919711000703';
const EMPTY_DOCTOR_PHONE = '+919711000704';
const WARD_NAME = 'CIP Inpatient Ward';
const EMPTY_WARD_NAME = 'CIP Empty Tenant Ward';

jest.setTimeout(60000);

let patientId; // integer users.id
let doctorId; // integer users.id
let emptyPatientId;
let emptyDoctorId;
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
function makeReqRes(
  body,
  { role = 'DOCTOR', uid = DOCTOR_UID, id, tenantId = TENANT_ID } = {},
) {
  const req = {
    body,
    params: {},
    user: { role, uid, id },
    tenantId,
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
  for (const table of ['tasks', 'workflow_sla_instances']) {
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM ${table}
        WHERE patient_uid IN ($1::uuid, $2::uuid)`,
        PATIENT_UID,
        EMPTY_PATIENT_UID
      )
      .catch(() => {});
  }
  for (const table of [
    'ward_indent_inventory_allocations',
    'ward_indent_events',
    'ward_indent_items'
  ]) {
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM ${table}
        WHERE ward_indent_id IN (
          SELECT id FROM ward_indents
           WHERE patient_uid IN ($1::uuid, $2::uuid)
        )`,
        PATIENT_UID,
        EMPTY_PATIENT_UID
      )
      .catch(() => {});
  }
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM ward_indents
      WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID,
      EMPTY_PATIENT_UID
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(`DELETE FROM pharmacy_catalog WHERE name LIKE 'CIPTEST %'`)
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM prescription_safety_overrides WHERE patient_id = $1`,
      patientId ?? -1
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM e_prescriptions
      WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID,
      EMPTY_PATIENT_UID
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid AND source_table = 'clinical_orders'`,
      PATIENT_UID
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid AND resource_table = 'clinical_orders'`,
      PATIENT_UID
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM medication_safety_reviews WHERE patient_uid = $1::uuid`,
      PATIENT_UID
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(`DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`, PATIENT_UID)
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM admissions WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID,
      EMPTY_PATIENT_UID
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM beds WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID,
      EMPTY_PATIENT_UID
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM wards
      WHERE (tenant_id = $1::uuid AND name = $2)
         OR (tenant_id = $3::uuid AND name = $4)`,
      TENANT_ID,
      WARD_NAME,
      EMPTY_TENANT_ID,
      EMPTY_WARD_NAME
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM users
      WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
    PATIENT_UID,
    DOCTOR_UID,
    EMPTY_PATIENT_UID,
    EMPTY_DOCTOR_UID,
  ).catch(() => {});
}

describe('composition identity persistence (IPD createOrder/bulk + e-Rx create/update)', () => {
  beforeAll(async () => {
    await seedTenant(TENANT_ID, 'cip-tenant', 'CIP Tenant');
    await seedTenant(EMPTY_TENANT_ID, 'cip-empty-tenant', 'CIP Empty Tenant');

    await cleanup();

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
    const emptyPatient = await prisma.$queryRawUnsafe(
      `INSERT INTO users
         (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES
         ($1::uuid, $2, 'CIP Empty Tenant Patient [test]', 'PATIENT',
          true, $3::uuid, NOW())
       RETURNING id`,
      EMPTY_PATIENT_UID,
      EMPTY_PATIENT_PHONE,
      EMPTY_TENANT_ID,
    );
    emptyPatientId = Number(emptyPatient[0].id);
    const emptyDoctor = await prisma.$queryRawUnsafe(
      `INSERT INTO users
         (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES
         ($1::uuid, $2, 'CIP Empty Tenant Doctor [test]', 'DOCTOR',
          true, $3::uuid, NOW())
       RETURNING id`,
      EMPTY_DOCTOR_UID,
      EMPTY_DOCTOR_PHONE,
      EMPTY_TENANT_ID,
    );
    emptyDoctorId = Number(emptyDoctor[0].id);
    const mainWardId = Number(
      (
        await prisma.$queryRawUnsafe(
          `INSERT INTO wards (tenant_id, name, total_beds, created_at, updated_at)
       VALUES ($1::uuid, $2, 1, NOW(), NOW()) RETURNING id`,
          TENANT_ID,
          WARD_NAME
        )
      )[0].id
    );
    const emptyWardId = Number(
      (
        await prisma.$queryRawUnsafe(
          `INSERT INTO wards (tenant_id, name, total_beds, created_at, updated_at)
       VALUES ($1::uuid, $2, 1, NOW(), NOW()) RETURNING id`,
          EMPTY_TENANT_ID,
          EMPTY_WARD_NAME
        )
      )[0].id
    );
    const mainBedId = Number(
      (
        await prisma.$queryRawUnsafe(
          `INSERT INTO beds
         (tenant_id, ward_id, ward_name, bed_number, status, patient_uid,
          created_at, updated_at)
       VALUES ($1::uuid, $2::int, $3, 'CIP-BED-1', 'occupied', $4::uuid,
               NOW(), NOW()) RETURNING id`,
          TENANT_ID,
          mainWardId,
          WARD_NAME,
          PATIENT_UID
        )
      )[0].id
    );
    const emptyBedId = Number(
      (
        await prisma.$queryRawUnsafe(
          `INSERT INTO beds
         (tenant_id, ward_id, ward_name, bed_number, status, patient_uid,
          created_at, updated_at)
       VALUES ($1::uuid, $2::int, $3, 'CIP-EMPTY-1', 'occupied', $4::uuid,
               NOW(), NOW()) RETURNING id`,
          EMPTY_TENANT_ID,
          emptyWardId,
          EMPTY_WARD_NAME,
          EMPTY_PATIENT_UID
        )
      )[0].id
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, encounter_id, admitting_doctor, attending_doctor,
          bed_id, bed_number, ward, status, admitted_at, updated_at)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::uuid,
          $9::int, 'CIP-BED-1', $10, 'admitted', NOW(), NOW()),
         ($5::uuid, $6::uuid, $7::uuid, $8::uuid, $8::uuid,
          $11::int, 'CIP-EMPTY-1', $12, 'admitted', NOW(), NOW())`,
      TENANT_ID,
      PATIENT_UID,
      ENCOUNTER_ID,
      DOCTOR_UID,
      EMPTY_TENANT_ID,
      EMPTY_PATIENT_UID,
      EMPTY_ENCOUNTER_ID,
      EMPTY_DOCTOR_UID,
      mainBedId,
      WARD_NAME,
      emptyBedId,
      EMPTY_WARD_NAME
    );

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
          strength_components, form, form_key, release_key, route,
          composition_confidence, composition_source, updated_at)
       VALUES ('CIPTEST Augmentin 625', 'Amox+Clav', TRUE, $1::uuid, $2::int,
               '500mg+125mg', '625mg', $3::jsonb, 'Tablet', 'tablet', 'ir',
               'oral', 'high', 'parsed', NOW())`,
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
  it('IPD: createOrder binds the selected catalog clinical identity and dose', async () => {
    const result = await createOrder({
      patient_uid: PATIENT_UID,
      order_type: 'medication',
      encounter_id: ENCOUNTER_ID,
      details: {
        medication_name: 'CIPTEST Augmentin 625',
        catalog_id: augmentinId,
        composition_id: compositionId,
        dose: '1 tab',
        route: 'oral',
        strength: '500mg+125mg',
        form: 'Tablet',
        generic_name: 'Amox+Clav',
        frequency: 'BD',
        quantity_requested: 10,
        unit: 'tablet',
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

    // Server-derived canonical identity is persisted from the selected catalog.
    expect(details.composition_id).toBe(compositionId);
    expect(Array.isArray(details.strength_components)).toBe(true);
    expect(details.strength_components).toEqual([
      { ingredient: 'amoxicillin', value: '500', unit: 'mg' },
      { ingredient: 'clavulanic_acid', value: '125', unit: 'mg' },
    ]);
    expect(details.route).toBe('PO');
    expect(details.strength).toBe('500mg+125mg');
    expect(details.form).toBe('tablet');
    expect(details.generic_name).toBe('amox+clav');
    expect(details.catalog_authority.version).toBe('medication_catalog_authority_v1');
    expect(details.catalog_authority.prescribed.quantity_requested).toBe(10);
    expect(details.catalog_authority.prescribed.unit).toBe('tablet');
    expect(details.catalog_authority_sha256).toMatch(/^[0-9a-f]{64}$/);
    // Original details fields survive.
    expect(details.medication_name).toBe('CIPTEST Augmentin 625');
    expect(details.dose).toBe('1 tab');
    expect(details.frequency).toBe('BD');
    expect(Number(details.catalog_id)).toBe(augmentinId);
  });

  it('IPD: createOrder rejects caller composition identity that conflicts with catalog authority', async () => {
    await expect(createOrder({
      patient_uid: PATIENT_UID,
      order_type: 'medication',
      encounter_id: ENCOUNTER_ID,
      details: {
        medication_name: 'CIPTEST Augmentin 625',
        catalog_id: augmentinId,
        composition_id: 999999,
        dose: '1 tab',
        route: 'oral',
        quantity_requested: 10,
        unit: 'tablet',
      },
      ordered_by: DOCTOR_UID,
      tenantId: TENANT_ID,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CLINICAL_ORDER_MEDICATION_CATALOG_CLINICAL_IDENTITY_MISMATCH',
    });
  });

  it('IPD: createOrdersBulk binds the selected catalog identity on medication items', async () => {
    const results = await createOrdersBulk([
      { patient_uid: PATIENT_UID, order_type: 'investigation', details: { test_name: 'CBC' } },
      {
        patient_uid: PATIENT_UID,
        order_type: 'medication',
        encounter_id: ENCOUNTER_ID,
        details: {
          medication_name: 'CIPTEST Augmentin 625',
          catalog_id: augmentinId,
          composition_id: compositionId,
          dose: '1 tab',
          route: 'oral',
          quantity_requested: 10,
          unit: 'tablet',
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
    expect(Array.isArray(details.strength_components)).toBe(true);
    expect(details.route).toBe('PO');
    expect(details.strength).toBe('500mg+125mg');
    expect(details.generic_name).toBe('amox+clav');
    expect(details.catalog_authority_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(details.dose).toBe('1 tab');
  });

  it('IPD: a MAR-bound medication cannot bypass catalog authority', async () => {
    await expect(createOrder({
      patient_uid: PATIENT_UID,
      order_type: 'medication',
      encounter_id: ENCOUNTER_ID,
      details: {
        medication_name: 'Paracetamol 500 (free text)',
        dose: '1 tab',
        route: 'oral',
        quantity_requested: 10,
        unit: 'tablet',
      },
      ordered_by: DOCTOR_UID,
      tenantId: TENANT_ID,
    })).rejects.toMatchObject({
      code: 'CLINICAL_ORDER_MEDICATION_CATALOG_REQUIRED',
    });
  });

  it('IPD: fail-closes when catalog authority does not exist in the order tenant', async () => {
    const before = Number((await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM clinical_orders
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      EMPTY_TENANT_ID,
      EMPTY_PATIENT_UID,
    ))[0].count);
    await expect(createOrder({
      patient_uid: EMPTY_PATIENT_UID,
      order_type: 'medication',
      encounter_id: EMPTY_ENCOUNTER_ID,
      details: {
        medication_name: 'Ghost Drug',
        catalog_id: augmentinId, // real id, but EMPTY_TENANT_ID cannot resolve it
        composition_id: 999999, // client value — must be stripped (never trusted)
        dose: '1 tab',
        route: 'oral',
        quantity_requested: 10,
        unit: 'tablet',
      },
      ordered_by: EMPTY_DOCTOR_UID,
      tenantId: EMPTY_TENANT_ID,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CLINICAL_ORDER_MEDICATION_CATALOG_UNAVAILABLE',
    });
    expect(Number((await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM clinical_orders
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      EMPTY_TENANT_ID,
      EMPTY_PATIENT_UID,
    ))[0].count)).toBe(before);
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
      patient_id: emptyPatientId,
      doctor_id: emptyDoctorId,
      diagnosis: 'Guarded path',
      medications: [
        { catalog_id: augmentinId, name: 'Ghost', composition_id: 999999, dose: '1 tab' },
      ],
    }, {
      uid: EMPTY_DOCTOR_UID,
      id: emptyDoctorId,
      tenantId: EMPTY_TENANT_ID,
    });

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
