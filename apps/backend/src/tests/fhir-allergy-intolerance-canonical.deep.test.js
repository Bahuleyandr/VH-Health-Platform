import prisma, { setTenantTx } from '../lib/prisma.js';
import {
  createFhirAllergyIntolerance,
  listFhirAllergyIntolerances,
} from '../services/fhir/fhirAllergyIntoleranceService.js';
import { toFhirAllergyIntolerance } from '../services/fhir/fhirAdapter.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

const TENANT_A = 'fa110000-0000-4000-8000-000000000001';
const TENANT_B = 'fb110000-0000-4000-8000-000000000001';
const PATIENT_A = 'fa110000-0000-4000-8000-000000000002';
const PATIENT_B = 'fb110000-0000-4000-8000-000000000002';
const PATIENT_A_ALT = 'fa110000-0000-4000-8000-000000000003';
const STAFF_A = 'fa110000-0000-4000-8000-000000000004';
const UNRESOLVED_A = 'fa110000-0000-4000-8000-000000000099';

async function cleanupTenant(tenantId) {
  await setTenantTx(tenantId, async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
    const receipts = await tx.$queryRawUnsafe(
      `SELECT timeline_event_id::text, audit_event_id::text
        FROM fhir_allergy_intolerance_receipts
        WHERE tenant_id = $1::uuid`,
      tenantId,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM fhir_allergy_intolerance_receipts
        WHERE tenant_id = $1::uuid`,
      tenantId,
    );
    for (const receipt of receipts) {
      await tx.$executeRawUnsafe(
        `DELETE FROM clinical_audit_events
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        tenantId,
        receipt.audit_event_id,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM clinical_timeline_events
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        tenantId,
        receipt.timeline_event_id,
      );
    }
    await tx.$executeRawUnsafe(
      `DELETE FROM patient_allergies
        WHERE tenant_id = $1::uuid`,
      tenantId,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM allergies WHERE tenant_id = $1::uuid`,
      tenantId,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM users WHERE tenant_id = $1::uuid`,
      tenantId,
    );
  });
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id = $1::uuid`,
    tenantId,
  );
}

async function cleanup() {
  await cleanupTenant(TENANT_A).catch(() => {});
  await cleanupTenant(TENANT_B).catch(() => {});
}

d('FHIR AllergyIntolerance canonical tenant contract', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES
         ($1::uuid, 'fhir-allergy-canonical-a', 'FHIR Allergy Canonical A'),
         ($2::uuid, 'fhir-allergy-canonical-b', 'FHIR Allergy Canonical B')`,
      TENANT_A,
      TENANT_B,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, $2::uuid, '+919811100012', 'FHIR Allergy Patient A', 'PATIENT', true, NOW()),
         ($3::uuid, $4::uuid, '+919811100013', 'FHIR Allergy Patient B', 'PATIENT', true, NOW()),
         ($5::uuid, $2::uuid, '+919811100014', 'FHIR Allergy Patient A Alt', 'PATIENT', true, NOW()),
         ($6::uuid, $2::uuid, '+919811100015', 'FHIR Allergy Staff A', 'DOCTOR', true, NOW())`,
      PATIENT_A,
      TENANT_A,
      PATIENT_B,
      TENANT_B,
      PATIENT_A_ALT,
      STAFF_A,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  }, 30_000);

  it('deduplicates semantic retries and keeps each tenant reader isolated', async () => {
    const firstA = await createFhirAllergyIntolerance({
      tenantId: TENANT_A,
      patientUid: PATIENT_A,
      allergen: 'Canonical Penicillin',
      severity: 'SEVERE',
      reaction: 'Anaphylaxis',
    });
    expect(firstA.created).toBe(true);
    expect(firstA.duplicate).toBe(false);

    const retryA = await createFhirAllergyIntolerance({
      tenantId: TENANT_A,
      patientUid: PATIENT_A,
      allergen: '  CANONICAL   PENICILLIN ',
      severity: 'severe',
      reaction: 'ANAPHYLAXIS',
    });
    expect(retryA.created).toBe(false);
    expect(retryA.duplicate).toBe(true);
    expect(retryA.allergy.id).toBe(firstA.allergy.id);

    await expect(createFhirAllergyIntolerance({
      tenantId: TENANT_A,
      patientUid: PATIENT_A,
      allergen: 'Canonical Penicillin',
      severity: 'SEVERE',
      reaction: 'Rash',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'FHIR_ALLERGY_RECEIPT_IDENTITY_DRIFT',
    });

    const firstB = await createFhirAllergyIntolerance({
      tenantId: TENANT_B,
      patientUid: PATIENT_B,
      allergen: 'Canonical Penicillin',
      severity: 'MILD',
      reaction: 'Rash',
    });
    expect(firstB.created).toBe(true);

    const tenantAResources = await listFhirAllergyIntolerances({ tenantId: TENANT_A });
    const tenantBResources = await listFhirAllergyIntolerances({ tenantId: TENANT_B });
    const crossTenantResources = await listFhirAllergyIntolerances({
      tenantId: TENANT_A,
      patientUid: PATIENT_B,
    });

    expect(tenantAResources).toEqual([
      expect.objectContaining({ id: firstA.allergy.id, patient_uid: PATIENT_A }),
    ]);
    expect(tenantBResources).toEqual([
      expect.objectContaining({ id: firstB.allergy.id, patient_uid: PATIENT_B }),
    ]);
    expect(crossTenantResources).toEqual([]);

    const evidence = await Promise.all([
      [TENANT_A, PATIENT_A],
      [TENANT_B, PATIENT_B],
    ].map(([tenantId, patientUid]) => setTenantTx(tenantId, (tx) => tx.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM patient_allergies
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid) AS detail_count,
         (SELECT COUNT(*)::int FROM fhir_allergy_intolerance_receipts
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid) AS receipt_count,
         (SELECT COUNT(*)::int FROM clinical_timeline_events
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
             AND event_type = 'allergy.recorded') AS timeline_count,
         (SELECT COUNT(*)::int FROM clinical_audit_events
           WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
             AND action = 'allergy.recorded') AS audit_count`,
      tenantId,
      patientUid,
    ))));
    expect(evidence.map(([row]) => row)).toEqual([
      { detail_count: 1, receipt_count: 1, timeline_count: 1, audit_count: 1 },
      { detail_count: 1, receipt_count: 1, timeline_count: 1, audit_count: 1 },
    ]);
  });

  it('rolls the detail and canonical pair back when patient ownership crosses tenants', async () => {
    await expect(createFhirAllergyIntolerance({
      tenantId: TENANT_A,
      patientUid: PATIENT_B,
      allergen: 'Cross Tenant Marker',
      severity: 'MILD',
    })).rejects.toBeDefined();

    const rows = await setTenantTx(TENANT_A, (tx) => tx.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM patient_allergies
           WHERE tenant_id = $1::uuid AND allergy_name = 'Cross Tenant Marker') AS detail_count,
         (SELECT COUNT(*)::int FROM clinical_timeline_events
           WHERE tenant_id = $1::uuid
             AND clinical_summary = 'Allergy recorded: Cross Tenant Marker') AS timeline_count,
         (SELECT COUNT(*)::int FROM clinical_audit_events
           WHERE tenant_id = $1::uuid
             AND after_state ->> 'allergy_name' = 'Cross Tenant Marker') AS audit_count`,
      TENANT_A,
    ));
    expect(rows[0]).toEqual({ detail_count: 0, timeline_count: 0, audit_count: 0 });
  });

  it('serializes concurrent semantic duplicates into one atomic canonical write', async () => {
    const results = await Promise.all([
      createFhirAllergyIntolerance({
        tenantId: TENANT_A,
        patientUid: PATIENT_A,
        allergen: 'Concurrent Shellfish Marker',
        severity: 'MODERATE',
        reaction: 'Hives',
      }),
      createFhirAllergyIntolerance({
        tenantId: TENANT_A,
        patientUid: PATIENT_A,
        allergen: 'Concurrent Shellfish Marker',
        severity: 'MODERATE',
        reaction: 'Hives',
      }),
    ]);
    expect(results.map(result => result.created).sort()).toEqual([false, true]);

    const [counts] = await setTenantTx(TENANT_A, (tx) => tx.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM patient_allergies
           WHERE tenant_id = $1::uuid
             AND allergy_name = 'Concurrent Shellfish Marker') AS details,
         (SELECT COUNT(*)::int FROM fhir_allergy_intolerance_receipts receipt
           JOIN patient_allergies allergy
             ON allergy.tenant_id = receipt.tenant_id
            AND allergy.id = receipt.allergy_id
          WHERE receipt.tenant_id = $1::uuid
            AND allergy.allergy_name = 'Concurrent Shellfish Marker') AS receipts,
         (SELECT COUNT(*)::int FROM clinical_timeline_events
           WHERE tenant_id = $1::uuid
             AND clinical_summary = 'Allergy recorded: Concurrent Shellfish Marker') AS timelines,
         (SELECT COUNT(*)::int FROM clinical_audit_events
           WHERE tenant_id = $1::uuid
             AND after_state ->> 'allergy_name' = 'Concurrent Shellfish Marker') AS audits`,
      TENANT_A,
    ));
    expect(counts).toEqual({ details: 1, receipts: 1, timelines: 1, audits: 1 });
  });

  it('rejects staff subjects and non-active creates inside the mutation service', async () => {
    await expect(createFhirAllergyIntolerance({
      tenantId: TENANT_A,
      patientUid: STAFF_A,
      allergen: 'Staff Allergy Marker',
      severity: 'MILD',
    })).rejects.toMatchObject({
      statusCode: 404,
      code: 'FHIR_ALLERGY_PATIENT_INVALID',
    });
    await expect(createFhirAllergyIntolerance({
      tenantId: TENANT_A,
      patientUid: PATIENT_A,
      allergen: 'Resolved Create Marker',
      severity: 'MILD',
      clinicalStatus: ' resolved ',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'FHIR_ALLERGY_LIFECYCLE_UNSUPPORTED',
    });

    const [counts] = await setTenantTx(TENANT_A, (tx) => tx.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM patient_allergies
        WHERE tenant_id = $1::uuid
          AND allergy_name IN ('Staff Allergy Marker', 'Resolved Create Marker')`,
      TENANT_A,
    ));
    expect(counts.count).toBe(0);
  });

  it('fails closed on mis-attributed allergy identities and quarantines unattributable ones', async () => {
    const insertStructured = async (patientUid, patientId, name) => setTenantTx(
      TENANT_A,
      async (tx) => {
        const [row] = await tx.$queryRawUnsafe(
          `INSERT INTO patient_allergies
             (tenant_id, patient_uid, patient_id, allergy_name, severity, is_active)
           VALUES ($1::uuid, $2::uuid, $3::integer, $4, 'MILD', true)
           RETURNING id`,
          TENANT_A,
          patientUid,
          patientId,
          name,
        );
        return row.id;
      },
    );
    const removeStructured = id => setTenantTx(TENANT_A, (tx) => tx.$executeRawUnsafe(
      `DELETE FROM patient_allergies WHERE tenant_id = $1::uuid AND id = $2`,
      TENANT_A,
      id,
    ));

    let invalidId = await insertStructured(STAFF_A, null, 'Staff Read Marker');
    await expect(listFhirAllergyIntolerances({ tenantId: TENANT_A })).rejects.toMatchObject({
      code: 'FHIR_ALLERGY_PATIENT_INVALID',
    });
    await removeStructured(invalidId);

    invalidId = await insertStructured(UNRESOLVED_A, null, 'Unresolved Read Marker');
    await expect(listFhirAllergyIntolerances({ tenantId: TENANT_A })).rejects.toMatchObject({
      code: 'FHIR_ALLERGY_PATIENT_UNRESOLVED',
    });
    await removeStructured(invalidId);

    const [alternate] = await setTenantTx(TENANT_A, (tx) => tx.$queryRawUnsafe(
      `SELECT id FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      TENANT_A,
      PATIENT_A_ALT,
    ));
    invalidId = await insertStructured(PATIENT_A, alternate.id, 'Conflicting Read Marker');
    await expect(listFhirAllergyIntolerances({ tenantId: TENANT_A })).rejects.toMatchObject({
      code: 'FHIR_ALLERGY_PATIENT_IDENTITY_CONFLICT',
    });
    await removeStructured(invalidId);

    // ...and a row that states NO patient is a different case entirely: it
    // claims nobody, so there is no mis-attribution to fail closed on. Both
    // `patient_allergies` key columns are nullable and legacy rows predate the
    // uid key, so this shape is reachable with real data — refusing on it hid
    // every patient's allergy list in the tenant behind a 500.
    const unattributableId = await insertStructured(null, null, 'Unattributable Read Marker');
    const neighbourId = await insertStructured(PATIENT_A, null, 'Unattributable Neighbour Marker');
    const served = await listFhirAllergyIntolerances({ tenantId: TENANT_A, limit: 1000 });
    expect(served.some(row => row.allergen === 'Unattributable Read Marker')).toBe(false);
    // The rest of the tenant is still served, and every served row still
    // carries a patient.
    expect(served.some(row => row.allergen === 'Unattributable Neighbour Marker')).toBe(true);
    for (const row of served) {
      expect(row.patient_uid).toMatch(/^[0-9a-f-]{36}$/i);
    }
    await removeStructured(neighbourId);
    await removeStructured(unattributableId);

    // Same disposition for the other unrenderable shape: a legacy row that
    // names no substance. `allergies.allergen` and `.name` are both nullable, so
    // an import can land one, and it carries nothing the prescription-safety
    // gate would have used either (allergySourceService drops blank allergens).
    const [nameless] = await setTenantTx(TENANT_A, (tx) => tx.$queryRawUnsafe(
      `INSERT INTO allergies (tenant_id, patient_uid, allergen, name, status)
       VALUES ($1::uuid, $2::uuid, NULL, NULL, 'active')
       RETURNING id`,
      TENANT_A,
      PATIENT_A,
    ));
    const stillServed = await listFhirAllergyIntolerances({ tenantId: TENANT_A, limit: 1000 });
    expect(stillServed.length).toBeGreaterThan(0);
    for (const row of stillServed) {
      expect(String(row.allergen || '').trim()).not.toBe('');
    }
    await setTenantTx(TENANT_A, (tx) => tx.$executeRawUnsafe(
      `DELETE FROM allergies WHERE tenant_id = $1::uuid AND id = $2`,
      TENANT_A,
      nameless.id,
    ));
  });

  it('normalizes legacy status variants and preserves numeric legacy identities', async () => {
    const structuredDedupe = await createFhirAllergyIntolerance({
      tenantId: TENANT_A,
      patientUid: PATIENT_A,
      allergen: 'Legacy Dedupe Marker',
      severity: 'SEVERE',
      reaction: 'Structured anaphylaxis',
    });
    const inserted = await setTenantTx(TENANT_A, (tx) => tx.$queryRawUnsafe(
      `INSERT INTO allergies
         (tenant_id, patient_uid, allergen, severity, reaction, status, created_at, recorded_at)
       VALUES
         ($1::uuid, $2::uuid, 'Legacy Dedupe Marker', 'SEVERE', 'Legacy anaphylaxis', 'active', NOW(), NOW()),
         ($1::uuid, $2::uuid, 'Legacy Numeric Marker', 'MILD', 'Legacy rash', ' ACTIVE ', NOW(), NOW()),
         ($1::uuid, $2::uuid, 'Legacy Resolved Upper', 'MILD', NULL, 'RESOLVED', NOW(), NOW()),
         ($1::uuid, $2::uuid, 'Legacy Inactive Spaced', 'MILD', NULL, ' inactive ', NOW(), NOW()),
         ($1::uuid, $2::uuid, 'Legacy Error Mixed', 'MILD', NULL, ' Entered-In-Error ', NOW(), NOW())
       RETURNING id, allergen`,
      TENANT_A,
      PATIENT_A,
    ));

    const resources = await listFhirAllergyIntolerances({
      tenantId: TENANT_A,
      patientUid: PATIENT_A,
    });
    const numericRow = inserted.find(row => row.allergen === 'Legacy Numeric Marker');
    const numericResource = resources.find(row => row.allergen === 'Legacy Numeric Marker');
    expect(numericResource.id).toBe(String(numericRow.id));
    expect(toFhirAllergyIntolerance(numericResource)).toEqual(expect.objectContaining({
      id: String(numericRow.id),
      identifier: expect.arrayContaining([
        { system: 'urn:vhhealth:allergy', value: String(numericRow.id) },
      ]),
    }));

    const deduped = resources.find(row => row.allergen === 'Legacy Dedupe Marker');
    const legacyDedupe = inserted.find(row => row.allergen === 'Legacy Dedupe Marker');
    expect(deduped.id).toBe(structuredDedupe.allergy.id);
    expect(deduped.identifiers).toEqual(expect.arrayContaining([
      { system: 'urn:vhhealth:allergy', value: String(legacyDedupe.id) },
    ]));
    const returnedAllergens = new Set(resources.map(row => row.allergen));
    expect(returnedAllergens.has('Legacy Resolved Upper')).toBe(false);
    expect(returnedAllergens.has('Legacy Inactive Spaced')).toBe(false);
    expect(returnedAllergens.has('Legacy Error Mixed')).toBe(false);
  });
});
