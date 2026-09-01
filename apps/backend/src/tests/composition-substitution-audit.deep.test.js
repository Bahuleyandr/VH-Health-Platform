// src/tests/composition-substitution-audit.deep.test.js
//
// Phase 2 — persisted-only brand-substitution audit.
//
// When a saved prescription (e-Rx) or medication order (IPD/CPOE) carries a
// chosen brand (`catalog_id`) that differs from the originally-selected brand
// (`original_catalog_id`), a `clinical_audit_events` row with
// action='medication.brand_substitution' is written — post-persist, best-effort.
//
// The security invariant under test: the before/after BRAND + COMPOSITION text
// in the audit row is SERVER-RESOLVED from the tenant-scoped `pharmacy_catalog`
// rows (keyed by the two catalog ids), NEVER lifted from any client-supplied
// brand/composition text. And:
//   - no substitution (original absent, or original == final) → NO audit row;
//   - an unresolvable original/final id (wrong tenant / missing) → NO audit row
//     (skipped, not fabricated), and the save still succeeds;
//   - the save always persists + returns success even if the audit path fails.
//
// Model: real DB + real createOrder / real controller handlers. The QA test DB
// runs as superuser (RLS bypassed) — fine for tests: we seed tenant-scoped rows
// directly. Patient has NO allergy so CDS does not block the create.

import { jest } from '@jest/globals';
import prisma from '../lib/prisma.js';
import { createOrder } from '../services/emr/orderEntryService.js';
import {
  createPrescription,
  updatePrescription,
} from '../controllers/prescription/ePrescriptionController.js';

const TENANT_ID = '00000000-0000-4000-8000-00000c5a0001';
const OTHER_TENANT_ID = '00000000-0000-4000-8000-00000c5a0002'; // holds a catalog row the audit tenant can't resolve

const PATIENT_UID = 'c5a00000-0000-4000-8000-00000000d001'; // NO-allergy patient
const DOCTOR_UID = 'c5a00000-0000-4000-8000-00000000d002';
const ENCOUNTER_ID = 'c5a00000-0000-4000-8000-00000000d003';
const PATIENT_PHONE = '+919712000701';
const DOCTOR_PHONE = '+919712000702';
const WARD_NAME = 'CSA Inpatient Ward';

jest.setTimeout(60000);

let patientId; // integer users.id
let doctorId; // integer users.id
let compositionId; // amoxicillin+clavulanic_acid composition
let originalCatalogId; // ORIGINAL high-confidence brand (same composition)
let finalCatalogId; // FINAL high-confidence brand (same composition)
let otherTenantCatalogId; // a catalog row under OTHER_TENANT_ID — unresolvable from TENANT_ID

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

function makeReqRes(body, { role = 'DOCTOR', uid = DOCTOR_UID, id } = {}) {
  const req = {
    body,
    params: {},
    id: 'req-brand-sub-test',
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

async function readSubstitutionAudits({ resourceTable, resourceId }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT action, action_status, actor_uid, resource_type, resource_table, resource_id,
            before_state, after_state, metadata
       FROM clinical_audit_events
      WHERE action = 'medication.brand_substitution'
        AND resource_table = $1
        AND resource_id = $2`,
    resourceTable, String(resourceId),
  );
  return rows.map((r) => ({
    ...r,
    before_state: typeof r.before_state === 'string' ? JSON.parse(r.before_state) : r.before_state,
    after_state: typeof r.after_state === 'string' ? JSON.parse(r.after_state) : r.after_state,
    metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata,
  }));
}

async function cleanup() {
  for (const table of ['tasks', 'workflow_sla_instances']) {
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM ${table} WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
        TENANT_ID,
        PATIENT_UID
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
        WHERE tenant_id = $1::uuid
          AND ward_indent_id IN (
            SELECT id FROM ward_indents
             WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
          )`,
        TENANT_ID,
        PATIENT_UID
      )
      .catch(() => {});
  }
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM ward_indents WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT_ID,
      PATIENT_UID
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(`DELETE FROM pharmacy_catalog WHERE name LIKE 'CSATEST %'`)
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM prescription_safety_overrides WHERE patient_id = $1`,
      patientId ?? -1
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`,
      PATIENT_UID
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`,
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
    .$executeRawUnsafe(`DELETE FROM e_prescriptions WHERE patient_uid = $1::uuid`, PATIENT_UID)
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(`DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`, PATIENT_UID)
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_UID)
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM beds WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT_ID,
      PATIENT_UID
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM wards WHERE tenant_id = $1::uuid AND name = $2`,
      TENANT_ID,
      WARD_NAME
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID,
      DOCTOR_UID
    )
    .catch(() => {});
}

describe('brand-substitution audit (persisted-only, server-resolved)', () => {
  beforeAll(async () => {
    await seedTenant(TENANT_ID, 'csa-tenant', 'CSA Tenant');
    await seedTenant(OTHER_TENANT_ID, 'csa-other-tenant', 'CSA Other Tenant');

    await cleanup();

    // NO-allergy patient so CDS does not block the medication create.
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'CSA NoAllergy Patient [test]', 'PATIENT', true, $3::uuid, NOW())
       RETURNING id`,
      PATIENT_UID, PATIENT_PHONE, TENANT_ID,
    );
    patientId = Number(p[0].id);

    const d = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'CSA Doctor [test]', 'DOCTOR', true, $3::uuid, NOW())
       RETURNING id`,
      DOCTOR_UID, DOCTOR_PHONE, TENANT_ID,
    );
    doctorId = Number(d[0].id);
    const wardId = Number(
      (
        await prisma.$queryRawUnsafe(
          `INSERT INTO wards (tenant_id, name, total_beds, created_at, updated_at)
       VALUES ($1::uuid, $2, 1, NOW(), NOW()) RETURNING id`,
          TENANT_ID,
          WARD_NAME
        )
      )[0].id
    );
    const bedId = Number(
      (
        await prisma.$queryRawUnsafe(
          `INSERT INTO beds
         (tenant_id, ward_id, ward_name, bed_number, status, patient_uid,
          created_at, updated_at)
       VALUES ($1::uuid, $2::int, $3, 'CSA-BED-1', 'occupied', $4::uuid,
               NOW(), NOW()) RETURNING id`,
          TENANT_ID,
          wardId,
          WARD_NAME,
          PATIENT_UID
        )
      )[0].id
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, encounter_id, admitting_doctor, attending_doctor,
          bed_id, bed_number, ward, status, admitted_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::uuid,
               $5::int, 'CSA-BED-1', $6, 'admitted', NOW(), NOW())`,
      TENANT_ID,
      PATIENT_UID,
      ENCOUNTER_ID,
      DOCTOR_UID,
      bedId,
      WARD_NAME
    );

    // Composition (amoxicillin + clavulanic acid) shared by both brands.
    const comp = await prisma.$queryRawUnsafe(
      `INSERT INTO drug_compositions (composition_key, display_label, active_ingredients, source)
       VALUES ('csatest_amoxicillin+clavulanic_acid', 'Amoxicillin + Clavulanic Acid',
               ARRAY['amoxicillin','clavulanic_acid']::text[], 'parsed')
       ON CONFLICT (composition_key) DO UPDATE SET display_label = EXCLUDED.display_label
       RETURNING id`,
    );
    compositionId = Number(comp[0].id);

    // Two high-confidence brands of the SAME composition — ORIGINAL + FINAL.
    await prisma.$executeRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, is_active, tenant_id, composition_id, strength, strength_key,
          strength_components, form, form_key, release_key, route,
          composition_confidence, composition_source, updated_at)
       VALUES ('CSATEST Augmentin 625', 'Amox+Clav', TRUE, $1::uuid, $2::int,
               '500mg+125mg', '625mg',
               '[{"ingredient":"amoxicillin","value":500,"unit":"mg"},{"ingredient":"clavulanic_acid","value":125,"unit":"mg"}]'::jsonb,
               'Tablet', 'tablet', 'ir', 'oral', 'high', 'parsed', NOW())`,
      TENANT_ID, compositionId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, is_active, tenant_id, composition_id, strength, strength_key,
          strength_components, form, form_key, release_key, route,
          composition_confidence, composition_source, updated_at)
       VALUES ('CSATEST Clavam 625', 'Amox+Clav', TRUE, $1::uuid, $2::int,
               '500mg+125mg', '625mg',
               '[{"ingredient":"amoxicillin","value":500,"unit":"mg"},{"ingredient":"clavulanic_acid","value":125,"unit":"mg"}]'::jsonb,
               'Tablet', 'tablet', 'ir', 'oral', 'high', 'parsed', NOW())`,
      TENANT_ID, compositionId,
    );
    originalCatalogId = await catalogId('CSATEST Augmentin 625');
    finalCatalogId = await catalogId('CSATEST Clavam 625');

    // A catalog row under the OTHER tenant — a real id that TENANT_ID cannot resolve.
    await prisma.$executeRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, is_active, tenant_id, composition_id, strength, form, route,
          composition_confidence, composition_source, updated_at)
       VALUES ('CSATEST Foreign Brand', 'Amox+Clav', TRUE, $1::uuid, $2::int,
               '500mg+125mg', 'Tablet', 'oral', 'high', 'parsed', NOW())`,
      OTHER_TENANT_ID, compositionId,
    );
    otherTenantCatalogId = await catalogId('CSATEST Foreign Brand');
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  // ── e-Rx substitution ──────────────────────────────────────────────────────
  it('e-Rx: a substituted brand writes a server-resolved brand_substitution audit row', async () => {
    const { req, res } = makeReqRes({
      patient_id: patientId,
      doctor_id: doctorId,
      diagnosis: 'URTI',
      medications: [
        {
          catalog_id: finalCatalogId,
          original_catalog_id: originalCatalogId,
          // Attacker-controlled brand/composition text — MUST NOT appear in the audit.
          name: 'Augmentin 625',
          brand_name: 'CLIENT FORGED BRAND',
          composition_label: 'CLIENT FORGED COMPOSITION',
          substitution_reason: 'out of stock',
          dose: '1 tab',
          frequency: 'BD',
        },
      ],
    }, { id: doctorId });

    await createPrescription(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.payload?.success).toBe(true);
    const prescriptionId = res.payload.data.id;

    const audits = await readSubstitutionAudits({
      resourceTable: 'e_prescriptions',
      resourceId: prescriptionId,
    });
    expect(audits.length).toBe(1);
    const a = audits[0];

    expect(a.action).toBe('medication.brand_substitution');
    expect(a.action_status).toBe('success');
    expect(a.resource_type).toBe('medication_brand_substitution');
    expect(a.resource_table).toBe('e_prescriptions');
    expect(String(a.resource_id)).toBe(String(prescriptionId));
    expect(a.actor_uid).toBe(DOCTOR_UID);

    // before/after brand names are SERVER-RESOLVED from the catalog rows — never
    // the client-forged text.
    expect(a.before_state.brand_name).toBe('CSATEST Augmentin 625');
    expect(a.before_state.catalog_id).toBe(originalCatalogId);
    expect(a.before_state.composition_id).toBe(compositionId);
    expect(a.before_state.composition_label).toBe('Amoxicillin + Clavulanic Acid');

    expect(a.after_state.brand_name).toBe('CSATEST Clavam 625');
    expect(a.after_state.catalog_id).toBe(finalCatalogId);
    expect(a.after_state.composition_id).toBe(compositionId);

    // Forged text never made it in.
    expect(JSON.stringify(a.before_state)).not.toContain('CLIENT FORGED');
    expect(JSON.stringify(a.after_state)).not.toContain('CLIENT FORGED');

    // Metadata surface + reason + the two ids.
    expect(a.metadata.surface).toBe('prescription');
    expect(a.metadata.reason).toBe('out of stock');
    expect(a.metadata.original_catalog_id).toBe(originalCatalogId);
    expect(a.metadata.final_catalog_id).toBe(finalCatalogId);
  });

  // ── e-Rx: no substitution ───────────────────────────────────────────────────
  it('e-Rx: no original_catalog_id → no brand_substitution audit row', async () => {
    const { req, res } = makeReqRes({
      patient_id: patientId,
      doctor_id: doctorId,
      diagnosis: 'no-sub',
      medications: [
        { catalog_id: finalCatalogId, name: 'Clavam 625', dose: '1 tab', frequency: 'BD' },
      ],
    }, { id: doctorId });

    await createPrescription(req, res);
    expect(res.statusCode).toBe(201);
    const audits = await readSubstitutionAudits({
      resourceTable: 'e_prescriptions',
      resourceId: res.payload.data.id,
    });
    expect(audits.length).toBe(0);
  });

  it('e-Rx: original_catalog_id equal to catalog_id → no brand_substitution audit row', async () => {
    const { req, res } = makeReqRes({
      patient_id: patientId,
      doctor_id: doctorId,
      diagnosis: 'equal-ids',
      medications: [
        {
          catalog_id: finalCatalogId,
          original_catalog_id: finalCatalogId, // same → not a substitution
          name: 'Clavam 625',
          dose: '1 tab',
        },
      ],
    }, { id: doctorId });

    await createPrescription(req, res);
    expect(res.statusCode).toBe(201);
    const audits = await readSubstitutionAudits({
      resourceTable: 'e_prescriptions',
      resourceId: res.payload.data.id,
    });
    expect(audits.length).toBe(0);
  });

  // ── e-Rx: unresolvable original id ──────────────────────────────────────────
  it('e-Rx: an unresolvable original_catalog_id (wrong tenant) → no audit, save still succeeds', async () => {
    const { req, res } = makeReqRes({
      patient_id: patientId,
      doctor_id: doctorId,
      diagnosis: 'unresolvable-original',
      medications: [
        {
          catalog_id: finalCatalogId,
          original_catalog_id: otherTenantCatalogId, // real id, but wrong tenant → cannot resolve
          name: 'Clavam 625',
          dose: '1 tab',
        },
      ],
    }, { id: doctorId });

    await createPrescription(req, res);
    // Save still succeeds…
    expect(res.statusCode).toBe(201);
    expect(res.payload?.success).toBe(true);
    // …but no fabricated audit row.
    const audits = await readSubstitutionAudits({
      resourceTable: 'e_prescriptions',
      resourceId: res.payload.data.id,
    });
    expect(audits.length).toBe(0);
  });

  // ── e-Rx UPDATE substitution ────────────────────────────────────────────────
  it('e-Rx UPDATE: a substituted brand writes a brand_substitution audit row', async () => {
    const { req: createReq, res: createRes } = makeReqRes({
      patient_id: patientId,
      doctor_id: doctorId,
      diagnosis: 'to-update-sub',
      medications: [{ name: 'Placeholder', dose: '1 tab' }],
    }, { id: doctorId });
    await createPrescription(createReq, createRes);
    expect(createRes.statusCode).toBe(201);
    const prescriptionId = createRes.payload.data.id;

    const { req, res } = makeReqRes({
      medications: [
        {
          catalog_id: finalCatalogId,
          original_catalog_id: originalCatalogId,
          name: 'Clavam 625',
          dose: '2 tab',
        },
      ],
    }, { id: doctorId });
    req.params.id = String(prescriptionId);

    await updatePrescription(req, res);
    expect(res.statusCode).toBe(200);

    const audits = await readSubstitutionAudits({
      resourceTable: 'e_prescriptions',
      resourceId: prescriptionId,
    });
    expect(audits.length).toBe(1);
    expect(audits[0].before_state.brand_name).toBe('CSATEST Augmentin 625');
    expect(audits[0].after_state.brand_name).toBe('CSATEST Clavam 625');
    expect(audits[0].metadata.surface).toBe('prescription');
  });

  // ── IPD substitution ────────────────────────────────────────────────────────
  it('IPD: a substituted brand order writes a drug_chart brand_substitution audit row', async () => {
    const result = await createOrder({
      patient_uid: PATIENT_UID,
      order_type: 'medication',
      encounter_id: ENCOUNTER_ID,
      details: {
        medication_name: 'CSATEST Clavam 625',
        catalog_id: finalCatalogId,
        original_catalog_id: originalCatalogId,
        brand_name: 'CLIENT FORGED BRAND',
        substitution_reason: 'formulary preference',
        dose: '1 tab',
        route: 'oral',
        frequency: 'BD',
        quantity_requested: 10,
        unit: 'tablet',
      },
      ordered_by: DOCTOR_UID,
      tenantId: TENANT_ID,
    });
    const orderId = Number(result.order.id);

    const audits = await readSubstitutionAudits({
      resourceTable: 'clinical_orders',
      resourceId: orderId,
    });
    expect(audits.length).toBe(1);
    const a = audits[0];
    expect(a.resource_table).toBe('clinical_orders');
    expect(String(a.resource_id)).toBe(String(orderId));
    expect(a.before_state.brand_name).toBe('CSATEST Augmentin 625');
    expect(a.after_state.brand_name).toBe('CSATEST Clavam 625');
    expect(a.before_state.composition_id).toBe(compositionId);
    expect(a.metadata.surface).toBe('drug_chart');
    expect(a.metadata.reason).toBe('formulary preference');
    expect(a.metadata.original_catalog_id).toBe(originalCatalogId);
    expect(a.metadata.final_catalog_id).toBe(finalCatalogId);
    expect(JSON.stringify(a.before_state)).not.toContain('CLIENT FORGED');
  });

  it('IPD: no substitution (no original_catalog_id) → no brand_substitution audit row', async () => {
    const result = await createOrder({
      patient_uid: PATIENT_UID,
      order_type: 'medication',
      encounter_id: ENCOUNTER_ID,
      details: {
        medication_name: 'CSATEST Clavam 625',
        catalog_id: finalCatalogId,
        dose: '1 tab',
        route: 'oral',
        quantity_requested: 10,
        unit: 'tablet',
      },
      ordered_by: DOCTOR_UID,
      tenantId: TENANT_ID,
    });
    const audits = await readSubstitutionAudits({
      resourceTable: 'clinical_orders',
      resourceId: Number(result.order.id),
    });
    expect(audits.length).toBe(0);
  });
});
