import prisma, { setTenantTx } from '../lib/prisma.js';
import {
  createFhirAllergyIntolerance,
  listFhirAllergyIntolerances,
} from '../services/fhir/fhirAllergyIntoleranceService.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

const TENANT_A = 'fa110000-0000-4000-8000-000000000001';
const TENANT_B = 'fb110000-0000-4000-8000-000000000001';
const PATIENT_A = 'fa110000-0000-4000-8000-000000000002';
const PATIENT_B = 'fb110000-0000-4000-8000-000000000002';

async function cleanupTenant(tenantId, patientUid) {
  await setTenantTx(tenantId, async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
    const receipts = await tx.$queryRawUnsafe(
      `SELECT timeline_event_id::text, audit_event_id::text
         FROM fhir_allergy_intolerance_receipts
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid`,
      tenantId,
      patientUid,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM fhir_allergy_intolerance_receipts
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid`,
      tenantId,
      patientUid,
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
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      tenantId,
      patientUid,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      tenantId,
      patientUid,
    );
  });
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id = $1::uuid`,
    tenantId,
  );
}

async function cleanup() {
  await cleanupTenant(TENANT_A, PATIENT_A).catch(() => {});
  await cleanupTenant(TENANT_B, PATIENT_B).catch(() => {});
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
         ($3::uuid, $4::uuid, '+919811100013', 'FHIR Allergy Patient B', 'PATIENT', true, NOW())`,
      PATIENT_A,
      TENANT_A,
      PATIENT_B,
      TENANT_B,
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
});
