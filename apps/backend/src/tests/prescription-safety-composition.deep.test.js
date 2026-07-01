// src/tests/prescription-safety-composition.deep.test.js
//
// Phase 2 — composition allergy + same-composition duplicate block in
// validatePrescriptionSafety. Server-enriched from catalog_id, GATED behind the
// per-tenant composition-search flag, and GUARDED so it can never disturb the
// existing name-based allergy / duplicate checks nor block prescribing when the
// feature is off/unavailable.
//
// The QA test DB runs as superuser (RLS bypassed) — fine for tests: we seed
// tenant-scoped rows directly and pass { tenantId } to drive the gated path.

import { jest } from '@jest/globals';
import prisma from '../lib/prisma.js';
import { validatePrescriptionSafety } from '../utils/clinical/prescriptionSafetyCheck.js';
import { createOrder } from '../services/emr/orderEntryService.js';
import { setCompositionSearchEnabled } from '../services/pharmacy/compositionFeatureService.js';

// Enabled tenant (composition search ON) and a disabled tenant (no settings row).
const TENANT_ON = '00000000-0000-4000-8000-00000c5a0001';
const TENANT_OFF = '00000000-0000-4000-8000-00000c5a0002';

// Patient uids/phones unique to this suite.
const PATIENT_UID = 'c5a00000-0000-4000-8000-00000000a001'; // amoxicillin-allergic patient
const PATIENT_PENI_UID = 'c5a00000-0000-4000-8000-00000000a002'; // penicillin-allergic patient
const DOCTOR_UID = 'c5a00000-0000-4000-8000-00000000a003'; // orderer for the IPD createOrder test
const PATIENT_PHONE = '+919700000501';
const PATIENT_PENI_PHONE = '+919700000502';
const DOCTOR_PHONE = '+919700000503';

jest.setTimeout(60000);

// ── helpers ───────────────────────────────────────────────────────────────
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

describe('validatePrescriptionSafety — composition allergy + same-composition duplicate (Phase 2)', () => {
  let patientId; // integer users.id for the amoxicillin-allergic patient
  let peniPatientId; // integer users.id for the penicillin-allergic patient
  let compositionId; // amoxicillin + clavulanic_acid
  let augmentinId; // catalog id (tenant ON, high-confidence, that composition)
  let clavamId; // catalog id (tenant ON, high-confidence, that composition)
  let paracetamolId; // catalog id (tenant ON, different composition, high-confidence)

  beforeAll(async () => {
    await seedTenant(TENANT_ON, 'psc-tenant-on', 'PSC Tenant ON');
    await seedTenant(TENANT_OFF, 'psc-tenant-off', 'PSC Tenant OFF');

    // Clean any prior run.
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_catalog WHERE name LIKE 'PSCTEST %'`).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM patient_allergies WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID, PATIENT_PENI_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM e_prescriptions WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID, PATIENT_PENI_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_orders WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID, PATIENT_PENI_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID, PATIENT_PENI_UID, DOCTOR_UID,
    ).catch(() => {});

    // Patient A — recorded amoxicillin allergy (structured store).
    const p1 = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'PSC Amoxicillin Patient [test]', 'PATIENT', true, $3::uuid, NOW())
       RETURNING id`,
      PATIENT_UID, PATIENT_PHONE, TENANT_ON,
    );
    patientId = Number(p1[0].id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_allergies (patient_id, patient_uid, allergy_name, severity, is_active, tenant_id)
       VALUES ($1, $2::uuid, 'Amoxicillin', 'SEVERE', true, $3::uuid)`,
      patientId, PATIENT_UID, TENANT_ON,
    );

    // Patient B — recorded penicillin allergy (beta-lactam cross-reactivity check).
    const p2 = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'PSC Penicillin Patient [test]', 'PATIENT', true, $3::uuid, NOW())
       RETURNING id`,
      PATIENT_PENI_UID, PATIENT_PENI_PHONE, TENANT_ON,
    );
    peniPatientId = Number(p2[0].id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_allergies (patient_id, patient_uid, allergy_name, severity, is_active, tenant_id)
       VALUES ($1, $2::uuid, 'Penicillin', 'SEVERE', true, $3::uuid)`,
      peniPatientId, PATIENT_PENI_UID, TENANT_ON,
    );

    // Doctor — orderer for the createOrder (IPD CDS) path test.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'PSC Doctor [test]', 'DOCTOR', true, $3::uuid, NOW())`,
      DOCTOR_UID, DOCTOR_PHONE, TENANT_ON,
    );

    // Global composition (amoxicillin + clavulanic acid).
    const comp = await prisma.$queryRawUnsafe(
      `INSERT INTO drug_compositions (composition_key, display_label, active_ingredients, source)
       VALUES ('amoxicillin+clavulanic_acid', 'Amoxicillin + Clavulanic Acid',
               ARRAY['amoxicillin','clavulanic_acid']::text[], 'parsed')
       ON CONFLICT (composition_key) DO UPDATE SET display_label = EXCLUDED.display_label
       RETURNING id`,
    );
    compositionId = Number(comp[0].id);

    // Catalog rows under TENANT_ON. Augmentin + Clavam share the composition
    // (both high confidence); Paracetamol is a different composition.
    // NOTE: the BRAND names deliberately do NOT contain "amoxicillin" so the
    // name-based allergy loop cannot fire — only the composition (molecule)
    // path can catch these, which is exactly what we are testing.
    await prisma.$executeRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, is_active, tenant_id, composition_id, strength, strength_key,
          form, form_key, route, composition_confidence, composition_source, updated_at)
       VALUES ('PSCTEST Augmentin 625', 'Amox+Clav', TRUE, $1::uuid, $2::int,
               '500mg+125mg', '625mg', 'Tablet', 'tablet', 'oral', 'high', 'parsed', NOW())`,
      TENANT_ON, compositionId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, is_active, tenant_id, composition_id, strength, strength_key,
          form, form_key, route, composition_confidence, composition_source, updated_at)
       VALUES ('PSCTEST Clavam 625', 'Amox+Clav', TRUE, $1::uuid, $2::int,
               '500mg+125mg', '625mg', 'Tablet', 'tablet', 'oral', 'high', 'parsed', NOW())`,
      TENANT_ON, compositionId,
    );

    // Paracetamol composition (different molecule set).
    const paraComp = await prisma.$queryRawUnsafe(
      `INSERT INTO drug_compositions (composition_key, display_label, active_ingredients, source)
       VALUES ('paracetamol', 'Paracetamol', ARRAY['paracetamol']::text[], 'parsed')
       ON CONFLICT (composition_key) DO UPDATE SET display_label = EXCLUDED.display_label
       RETURNING id`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, is_active, tenant_id, composition_id, strength, strength_key,
          form, form_key, route, composition_confidence, composition_source, updated_at)
       VALUES ('PSCTEST Calpol 500', 'Paracetamol', TRUE, $1::uuid, $2::int,
               '500mg', '500mg', 'Tablet', 'tablet', 'oral', 'high', 'parsed', NOW())`,
      TENANT_ON, Number(paraComp[0].id),
    );

    augmentinId = await catalogId('PSCTEST Augmentin 625');
    clavamId = await catalogId('PSCTEST Clavam 625');
    paracetamolId = await catalogId('PSCTEST Calpol 500');

    // Enable composition search for TENANT_ON only.
    await setCompositionSearchEnabled(TENANT_ON, true, { actorUid: null, snapshot: { coverage: 1 } });
    // Make sure TENANT_OFF is really off (no row).
    await prisma.$executeRawUnsafe(
      `DELETE FROM composition_search_settings WHERE tenant_id = $1::uuid`,
      TENANT_OFF,
    ).catch(() => {});
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_catalog WHERE name LIKE 'PSCTEST %'`).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM patient_allergies WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID, PATIENT_PENI_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM e_prescriptions WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID, PATIENT_PENI_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE patient_uid IN ($1::uuid, $2::uuid) AND source_table = 'clinical_orders'`,
      PATIENT_UID, PATIENT_PENI_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events WHERE patient_uid IN ($1::uuid, $2::uuid) AND resource_table = 'clinical_orders'`,
      PATIENT_UID, PATIENT_PENI_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_orders WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID, PATIENT_PENI_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM composition_search_settings WHERE tenant_id IN ($1::uuid, $2::uuid)`,
      TENANT_ON, TENANT_OFF,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID, PATIENT_PENI_UID, DOCTOR_UID,
    ).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  // 1. Composition allergy — brand-only submission trips on the molecule.
  it('flags COMPOSITION_ALLERGY_CONFLICT when a brand (by catalog_id) contains the allergen molecule', async () => {
    const res = await validatePrescriptionSafety(
      patientId,
      [{ catalog_id: clavamId, name: 'Clavam 625' }],
      { tenantId: TENANT_ON },
    );

    const all = [...res.warnings, ...res.blockers];
    const compAllergy = all.filter((i) => i.type === 'COMPOSITION_ALLERGY_CONFLICT');
    expect(compAllergy.length).toBe(1);
    const issue = compAllergy[0];
    expect(issue.molecule).toBe('amoxicillin');
    expect(String(issue.medication)).toContain('Clavam');
    expect(String(issue.allergy).toLowerCase()).toContain('amoxicillin');
    // Message names BOTH molecule and brand.
    expect(issue.message).toContain('amoxicillin');
    expect(issue.message).toContain('Clavam');
    // SEVERE allergy → this composition conflict is a BLOCKER.
    expect(res.blockers.some((b) => b.type === 'COMPOSITION_ALLERGY_CONFLICT')).toBe(true);
    expect(res.safe).toBe(false);
  });

  // 1b. Beta-lactam cross-reactivity — penicillin allergy catches amoxicillin molecule.
  it('trips COMPOSITION_ALLERGY_CONFLICT via beta-lactam cross-reactivity (penicillin allergy ↔ amoxicillin molecule)', async () => {
    const res = await validatePrescriptionSafety(
      peniPatientId,
      [{ catalog_id: augmentinId, name: 'Augmentin 625' }],
      { tenantId: TENANT_ON },
    );
    const compAllergy = [...res.warnings, ...res.blockers].filter(
      (i) => i.type === 'COMPOSITION_ALLERGY_CONFLICT',
    );
    expect(compAllergy.length).toBe(1);
    expect(compAllergy[0].molecule).toBe('amoxicillin');
    expect(String(compAllergy[0].allergy).toLowerCase()).toContain('penicillin');
  });

  // 2. A client-sent bogus composition_id is ignored (server derives from catalog_id).
  it('ignores a client-sent bogus composition_id and derives identity from catalog_id', async () => {
    const res = await validatePrescriptionSafety(
      patientId,
      [{
        catalog_id: clavamId,
        name: 'Clavam 625',
        composition_id: 999999,
        active_ingredients: ['ibuprofen'],
      }],
      { tenantId: TENANT_ON },
    );
    const all = [...res.warnings, ...res.blockers];
    const compAllergy = all.filter((i) => i.type === 'COMPOSITION_ALLERGY_CONFLICT');
    // Still fires on the REAL molecule (amoxicillin), not the forged 'ibuprofen'.
    expect(compAllergy.length).toBe(1);
    expect(compAllergy[0].molecule).toBe('amoxicillin');
    // The bogus id / molecule never influences the result.
    expect(JSON.stringify(all)).not.toContain('999999');
    expect(JSON.stringify(all)).not.toContain('ibuprofen');
  });

  // 3. Duplicate — both meds submitted in the same request share a composition.
  it('flags DUPLICATE_COMPOSITION (source submitted) for two submitted meds sharing a composition', async () => {
    // Use the penicillin patient so the amoxicillin allergy is by cross-reactivity
    // only and we can cleanly observe the duplicate finding regardless.
    const res = await validatePrescriptionSafety(
      peniPatientId,
      [
        { catalog_id: augmentinId, name: 'Augmentin 625' },
        { catalog_id: clavamId, name: 'Clavam 625' },
      ],
      { tenantId: TENANT_ON },
    );
    const dup = res.warnings.filter((w) => w.type === 'DUPLICATE_COMPOSITION');
    expect(dup.length).toBe(1);
    expect(dup[0].source).toBe('submitted');
    const brands = `${dup[0].medication} ${dup[0].message}`;
    expect(brands).toContain('Augmentin');
    expect(brands).toContain('Clavam');
    // Duplicate is a warning, never a blocker.
    expect(res.blockers.some((b) => b.type === 'DUPLICATE_COMPOSITION')).toBe(false);
  });

  // 4. Duplicate — active e-Rx already carries the same composition.
  it('flags DUPLICATE_COMPOSITION (source active_prescription) against an active e-Rx med', async () => {
    // Seed an active e-Rx whose medications JSONB carries a catalog_id of that composition.
    await prisma.$executeRawUnsafe(
      `INSERT INTO e_prescriptions
         (patient_id, patient_uid, status, medications, tenant_id, created_at, updated_at)
       VALUES ($1, $2::uuid, 'active',
               $3::jsonb, $4::uuid, NOW(), NOW())`,
      peniPatientId,
      PATIENT_PENI_UID,
      JSON.stringify([{ catalog_id: augmentinId, name: 'Augmentin 625' }]),
      TENANT_ON,
    );

    const res = await validatePrescriptionSafety(
      peniPatientId,
      [{ catalog_id: clavamId, name: 'Clavam 625' }],
      { tenantId: TENANT_ON },
    );
    const dup = res.warnings.filter(
      (w) => w.type === 'DUPLICATE_COMPOSITION' && w.source === 'active_prescription',
    );
    expect(dup.length).toBe(1);
    expect(String(dup[0].medication)).toContain('Clavam');
    expect(dup[0].message).toContain('Augmentin');
  });

  // 5. Duplicate — active inpatient (clinical_orders) medication order.
  it('flags DUPLICATE_COMPOSITION (source inpatient_order) against an active IPD medication order', async () => {
    // Remove the e-Rx seeded in test 4 so it does not also match here.
    await prisma.$executeRawUnsafe(
      `DELETE FROM e_prescriptions WHERE patient_uid = $1::uuid`,
      PATIENT_PENI_UID,
    );
    // Seed an active clinical_orders medication order carrying the composition catalog_id.
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_orders
         (order_number, patient_uid, order_type, status, details, tenant_id, created_at, updated_at)
       VALUES ($1, $2::uuid, 'medication', 'ordered', $3::jsonb, $4::uuid, NOW(), NOW())`,
      `PSCTEST-ORD-${Date.now()}`,
      PATIENT_PENI_UID,
      JSON.stringify({ catalog_id: augmentinId, medication_name: 'Augmentin 625' }),
      TENANT_ON,
    );

    const res = await validatePrescriptionSafety(
      peniPatientId,
      [{ catalog_id: clavamId, name: 'Clavam 625' }],
      { tenantId: TENANT_ON },
    );
    const dup = res.warnings.filter(
      (w) => w.type === 'DUPLICATE_COMPOSITION' && w.source === 'inpatient_order',
    );
    expect(dup.length).toBe(1);
    expect(String(dup[0].medication)).toContain('Clavam');
    expect(dup[0].message).toContain('Augmentin');
  });

  // 6a. Gated OFF via tenantId omitted — no composition issues, name-based still works.
  it('does NOT run composition checks when tenantId is omitted (2-arg call), but name-based checks still fire', async () => {
    // Free-text amoxicillin (name contains the allergen) → name-based ALLERGY_CONFLICT.
    const res = await validatePrescriptionSafety(patientId, [
      { name: 'Amoxicillin 500' },
    ]);
    const all = [...res.warnings, ...res.blockers];
    expect(all.some((i) => i.type === 'COMPOSITION_ALLERGY_CONFLICT')).toBe(false);
    expect(all.some((i) => i.type === 'DUPLICATE_COMPOSITION')).toBe(false);
    // Existing name-based allergy still fires (severe → blocker).
    expect(res.blockers.some((b) => b.type === 'ALLERGY_CONFLICT')).toBe(true);
    expect(res.safe).toBe(false);
    // Shape unchanged.
    expect(res).toHaveProperty('safe');
    expect(res).toHaveProperty('warnings');
    expect(res).toHaveProperty('blockers');
  });

  // 6b. Gated OFF via a tenant whose flag is not enabled. The composition
  //     allergy path would trip on Clavam (amoxicillin molecule) if it ran;
  //     with the flag OFF it must NOT — and, since the brand "Clavam" never
  //     contains "amoxicillin", the name-based allergy loop cannot fire either,
  //     so there is NO COMPOSITION_ALLERGY_CONFLICT and NO name-based
  //     ALLERGY_CONFLICT for this med. (The separate group-based Drug-KB
  //     engine may still flag its own ALLERGY_CROSS_SENSITIVITY_KB — that is
  //     pre-existing behaviour independent of the composition flag.)
  it('does NOT run composition checks for a tenant whose flag is disabled', async () => {
    const res = await validatePrescriptionSafety(
      patientId,
      [{ catalog_id: clavamId, name: 'Clavam 625' }],
      { tenantId: TENANT_OFF },
    );
    const all = [...res.warnings, ...res.blockers];
    expect(all.some((i) => i.type === 'COMPOSITION_ALLERGY_CONFLICT')).toBe(false);
    expect(all.some((i) => i.type === 'DUPLICATE_COMPOSITION')).toBe(false);
    // The name-based substring allergy loop also cannot fire (brand has no
    // "amoxicillin" token) — proving the composition path was the only thing
    // that could have caught this molecule, and it was correctly skipped.
    expect(all.some((i) => i.type === 'ALLERGY_CONFLICT')).toBe(false);
  });

  // 6d. Gated OFF, isolated: a same-composition duplicate that WOULD trip with
  //     the flag ON produces nothing when the tenant is disabled, and does not
  //     block prescribing (Paracetamol brand — no allergy, no KB class hit).
  it('does NOT flag a same-composition duplicate for a disabled tenant, and does not block', async () => {
    const res = await validatePrescriptionSafety(
      patientId,
      [
        { catalog_id: paracetamolId, name: 'Calpol 500' },
        { catalog_id: paracetamolId, name: 'Calpol 500 (dup)' },
      ],
      { tenantId: TENANT_OFF },
    );
    const all = [...res.warnings, ...res.blockers];
    expect(all.some((i) => i.type === 'DUPLICATE_COMPOSITION')).toBe(false);
    expect(all.some((i) => i.type === 'COMPOSITION_ALLERGY_CONFLICT')).toBe(false);
    expect(res.safe).toBe(true);
  });

  // 6c. Existing name-based DUPLICATE_MEDICATION still works with the flag ON.
  it('keeps the existing name-based DUPLICATE_MEDICATION behaviour with composition ON', async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM e_prescriptions WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO e_prescriptions
         (patient_id, patient_uid, status, medications, medication_name, tenant_id, created_at, updated_at)
       VALUES ($1, $2::uuid, 'active', $3::jsonb, 'Metformin 500', $4::uuid, NOW(), NOW())`,
      patientId,
      PATIENT_UID,
      JSON.stringify([{ name: 'Metformin 500' }]),
      TENANT_ON,
    );
    const res = await validatePrescriptionSafety(
      patientId,
      [{ name: 'Metformin 500' }],
      { tenantId: TENANT_ON },
    );
    expect(res.warnings.some((w) => w.type === 'DUPLICATE_MEDICATION')).toBe(true);
    await prisma.$executeRawUnsafe(
      `DELETE FROM e_prescriptions WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
  });

  // 7. Guarded — an enabled tenant with an empty catalog (unresolvable catalog_id)
  //    yields no composition issues and does not disturb name-based results / shape.
  it('is guarded: an unresolvable catalog_id under an enabled tenant yields no composition issues, no throw', async () => {
    const res = await validatePrescriptionSafety(
      patientId,
      [{ catalog_id: 987654321, name: 'Ghost Drug' }], // id does not exist
      { tenantId: TENANT_ON },
    );
    const all = [...res.warnings, ...res.blockers];
    expect(all.some((i) => i.type === 'COMPOSITION_ALLERGY_CONFLICT')).toBe(false);
    expect(all.some((i) => i.type === 'DUPLICATE_COMPOSITION')).toBe(false);
    expect(all.some((i) => i.type === 'SAFETY_CHECK_ERROR')).toBe(false);
    // No name match, no allergy → safe.
    expect(res.safe).toBe(true);
    expect(res).toHaveProperty('safe');
    expect(res).toHaveProperty('warnings');
    expect(res).toHaveProperty('blockers');
  });

  // 7b. Dedup — a brand whose NAME already trips the name-based allergy loop must
  //     not be double-flagged by the composition path for the same allergen.
  it('dedups: a name-based ALLERGY_CONFLICT is not double-flagged as COMPOSITION_ALLERGY_CONFLICT for the same pair', async () => {
    // Seed a catalog row whose brand name literally contains "amoxicillin" so the
    // name-based loop fires, then confirm the composition path skips that pair.
    await prisma.$executeRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, is_active, tenant_id, composition_id, strength_key,
          form_key, route, composition_confidence, composition_source, updated_at)
       VALUES ('PSCTEST Amoxicillin Brand', 'Amox+Clav', TRUE, $1::uuid, $2::int,
               '625mg', 'tablet', 'oral', 'high', 'parsed', NOW())`,
      TENANT_ON, compositionId,
    );
    const amoxBrandId = await catalogId('PSCTEST Amoxicillin Brand');
    const res = await validatePrescriptionSafety(
      patientId,
      [{ catalog_id: amoxBrandId, name: 'PSCTEST Amoxicillin Brand' }],
      { tenantId: TENANT_ON },
    );
    const nameBased = [...res.warnings, ...res.blockers].filter(
      (i) => i.type === 'ALLERGY_CONFLICT'
        && String(i.medication).toLowerCase().includes('amoxicillin'),
    );
    const compBased = [...res.warnings, ...res.blockers].filter(
      (i) => i.type === 'COMPOSITION_ALLERGY_CONFLICT'
        && String(i.medication).toLowerCase().includes('amoxicillin'),
    );
    expect(nameBased.length).toBeGreaterThanOrEqual(1);
    // Same (brand, amoxicillin) pair already flagged by the name-based loop → composition path dedups it.
    expect(compBased.length).toBe(0);
  });

  // 8. IPD (drug-chart) path through the REAL runCDSChecks/createOrder pipeline.
  //    This is the end-to-end proof of the fix: an inpatient medication order
  //    whose details.catalog_id points at the amox+clav composition — with a
  //    brand name (medication_name) that does NOT contain "amoxicillin" — must
  //    now trip the composition allergy for the amoxicillin-allergic patient.
  //    createOrder threads tenantId → runCDSChecks → validatePrescriptionSafety,
  //    and runCDSChecks now copies details.catalog_id onto the med it screens,
  //    so the enrich step resolves the high-confidence composition. The SEVERE
  //    allergy → COMPOSITION_ALLERGY_CONFLICT blocker → createOrder rejects with
  //    a CDS_BLOCKER. BEFORE the fix, catalog_id was dropped, the composition
  //    never resolved, and the order was created with no composition finding.
  it('blocks a drug-chart order via createOrder when details.catalog_id resolves an allergen composition (IPD runCDSChecks path)', async () => {
    let thrown = null;
    let created = null;
    try {
      created = await createOrder({
        patient_uid: PATIENT_UID,
        order_type: 'medication',
        encounter_id: null,
        details: {
          medication_name: 'Clavam 625', // brand — no "amoxicillin" token
          catalog_id: clavamId,
          dose: '1 tab',
          route: 'oral',
        },
        ordered_by: DOCTOR_UID,
        tenantId: TENANT_ON,
      });
    } catch (err) {
      thrown = err;
    }
    // Must have thrown a CDS_BLOCKER (not created the order).
    expect(created).toBeNull();
    expect(thrown).not.toBeNull();
    expect(thrown.code).toBe('CDS_BLOCKER');
    const blockers = thrown.details?.blockers || [];
    const compAllergy = blockers.filter((b) => b.type === 'COMPOSITION_ALLERGY_CONFLICT');
    expect(compAllergy.length).toBe(1);
    expect(compAllergy[0].molecule).toBe('amoxicillin');
    expect(String(compAllergy[0].medication)).toContain('Clavam');
    // Defensive: no order row was written for the blocked create.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM clinical_orders WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  // 9. Low-confidence active-side row does NOT emit DUPLICATE_COMPOSITION.
  //    Locks in "high-confidence on BOTH sides" — a medium/low-confidence
  //    catalog row on the ACTIVE (existing e-Rx / IPD) side must be ignored
  //    even though it shares the composition with a submitted high-confidence
  //    brand.
  it('does NOT flag DUPLICATE_COMPOSITION when the active-side catalog row is not high confidence', async () => {
    // Seed a MEDIUM-confidence catalog row for the same composition under TENANT_ON.
    await prisma.$executeRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, is_active, tenant_id, composition_id, strength, strength_key,
          form, form_key, route, composition_confidence, composition_source, updated_at)
       VALUES ('PSCTEST Medium Augmentin', 'Amox+Clav', TRUE, $1::uuid, $2::int,
               '500mg+125mg', '625mg', 'Tablet', 'tablet', 'oral', 'medium', 'parsed', NOW())`,
      TENANT_ON, compositionId,
    );
    const mediumId = await catalogId('PSCTEST Medium Augmentin');

    // Clean any leftover active meds for the penicillin patient, then seed an
    // active e-Rx carrying the MEDIUM-confidence catalog_id.
    await prisma.$executeRawUnsafe(
      `DELETE FROM e_prescriptions WHERE patient_uid = $1::uuid`,
      PATIENT_PENI_UID,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`,
      PATIENT_PENI_UID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO e_prescriptions
         (patient_id, patient_uid, status, medications, tenant_id, created_at, updated_at)
       VALUES ($1, $2::uuid, 'active', $3::jsonb, $4::uuid, NOW(), NOW())`,
      peniPatientId,
      PATIENT_PENI_UID,
      JSON.stringify([{ catalog_id: mediumId, name: 'Medium Augmentin' }]),
      TENANT_ON,
    );

    // Submit a HIGH-confidence same-composition brand. The active side is
    // medium-confidence → no DUPLICATE_COMPOSITION.
    const res = await validatePrescriptionSafety(
      peniPatientId,
      [{ catalog_id: clavamId, name: 'Clavam 625' }],
      { tenantId: TENANT_ON },
    );
    expect(res.warnings.some((w) => w.type === 'DUPLICATE_COMPOSITION')).toBe(false);

    await prisma.$executeRawUnsafe(
      `DELETE FROM e_prescriptions WHERE patient_uid = $1::uuid`,
      PATIENT_PENI_UID,
    );
  });

  // 10. Defensive dedup type-filter: a prior issue of a DIFFERENT type that
  //     happens to carry a matching medication+allergen must NOT suppress a
  //     real COMPOSITION_ALLERGY_CONFLICT. We simulate this by verifying the
  //     composition allergy still fires when the ONLY prior matching-pair issue
  //     is the KB's ALLERGY_CROSS_SENSITIVITY_KB (a non-ALLERGY_CONFLICT type).
  //     Using the amoxicillin-allergic patient + Clavam: the KB engine emits
  //     ALLERGY_CROSS_SENSITIVITY_KB (medication='Clavam 625', allergy='Amoxicillin'),
  //     and the composition path must still emit its own conflict because the
  //     dedup now filters on ALLERGY_CONFLICT-family types only.
  it('does NOT let a different-type prior issue (KB cross-sensitivity) suppress COMPOSITION_ALLERGY_CONFLICT', async () => {
    const res = await validatePrescriptionSafety(
      patientId,
      [{ catalog_id: clavamId, name: 'Clavam 625' }],
      { tenantId: TENANT_ON },
    );
    const all = [...res.warnings, ...res.blockers];
    // The KB cross-sensitivity fires for the same (medication, allergen) pair...
    expect(all.some((i) => i.type === 'ALLERGY_CROSS_SENSITIVITY_KB'
      && String(i.medication).includes('Clavam'))).toBe(true);
    // ...and the composition path is NOT suppressed by it.
    expect(all.some((i) => i.type === 'COMPOSITION_ALLERGY_CONFLICT'
      && i.molecule === 'amoxicillin')).toBe(true);
  });
});
