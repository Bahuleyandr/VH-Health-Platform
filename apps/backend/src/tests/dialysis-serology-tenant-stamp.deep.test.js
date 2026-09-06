// Dialysis serology + vascular access carry their OWN tenant's id.
//
// Both INSERTs omitted tenant_id and let the column DEFAULT supply it:
//
//   COALESCE(current_setting('app.current_tenant_id', true), DEFAULT_TENANT_ID)
//
// The GUC is transaction-local and these run on a plain `prisma` client outside
// one, so every non-default tenant's serology and vascular-access row was
// stamped with the DEFAULT tenant's id. Both functions already HAD the tenant —
// recordSerology scopes its sibling `UPDATE dialysis_patients ... AND tenant_id
// = $5::uuid` correctly — they simply forgot it on one statement each.
//
// WHY IT IS WORTH A DEEP TEST RATHER THAN A SHRUG. Nothing reads either table
// by tenant today; reads key on dialysis_patient_id behind an in-tenant patient
// lookup, so the mis-stamp is currently invisible. The isolation resolver
// (Phase 1 / migration 767) makes marker evidence the AUTHORITY for the
// isolation decision and reads it PER TENANT. Against mis-stamped rows a
// tenant-scoped read misses that tenant's own markers, and a marker-positive
// dialysis patient resolves `clear` instead of `restricted` — fail-open on a
// bloodborne isolation decision. This test exists so 767 cannot be built on
// that ground.
import { recordSerology, addAccess } from '../services/clinical/dialysisService.js';
import prisma from '../lib/prisma.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

// TENANT_A is the DEFAULT tenant — the id the column default falls back to.
// The fixture patient belongs to TENANT_B precisely so that "stamped with the
// default" and "stamped correctly" are DIFFERENT values; on a default-tenant
// patient this test would pass against the unfixed code.
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '5e401f00-0000-4000-8000-0000000000b2';
const PATIENT_UID = '5e401f00-0000-4000-8000-0000000000a2';

let patientId;

async function clean() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM dialysis_patients WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
}

d('Dialysis serology and vascular access are stamped with their own tenant', () => {
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, 'serology-tenant-stamp-b', 'Serology Tenant B')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_B,
    );
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO dialysis_patients (tenant_id, patient_uid, modality, status)
       VALUES ($1::uuid, $2::uuid, 'hd', 'active') RETURNING id`,
      TENANT_B, PATIENT_UID,
    );
    patientId = Number(rows[0].id);
  }, 30000);

  afterAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_B).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('the fixture patient really belongs to a NON-default tenant', async () => {
    // Without this the assertions below could pass vacuously: on a default-tenant
    // patient the buggy default produces the right answer for the wrong reason.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id FROM dialysis_patients WHERE id = $1`, patientId,
    );
    expect(rows[0].tenant_id).toBe(TENANT_B);
    expect(rows[0].tenant_id).not.toBe(TENANT_A);
  });

  it('a serology result is stamped with the patient\'s tenant, not the default', async () => {
    const row = await recordSerology({
      tenantId: TENANT_B,
      dialysis_patient_id: patientId,
      hbsag: 'positive',
      anti_hcv: 'negative',
      hiv: 'negative',
    });
    const stored = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id, hbsag FROM dialysis_serology WHERE id = $1`,
      Number(row.id),
    );
    expect(stored[0].hbsag).toBe('positive');
    expect(stored[0].tenant_id).toBe(TENANT_B);
  });

  it('the positive marker still promotes the patient status in the SAME tenant', async () => {
    // The sibling write was already scoped; this pins that the fix did not
    // disturb it, and that both halves agree about which tenant they are in.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id, hbsag_status FROM dialysis_patients WHERE id = $1`,
      patientId,
    );
    expect(rows[0].hbsag_status).toBe('positive');
    expect(rows[0].tenant_id).toBe(TENANT_B);
  });

  it('a vascular access row is stamped with the patient\'s tenant, not the default', async () => {
    const row = await addAccess({
      tenantId: TENANT_B,
      dialysis_patient_id: patientId,
      access_type: 'avf_radiocephalic',
      created_date: '2026-01-15',
    });
    const stored = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id, access_type FROM vascular_access WHERE id = $1`,
      Number(row.id),
    );
    expect(stored[0].access_type).toBe('avf_radiocephalic');
    expect(stored[0].tenant_id).toBe(TENANT_B);
  });

  it('no row this tenant wrote landed under the default tenant', async () => {
    // The direct statement of the defect: a sweep for orphans rather than a
    // per-row assertion, so a THIRD table added to this flow is caught too.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT 'serology' AS src, COUNT(*)::int AS n FROM dialysis_serology
        WHERE dialysis_patient_id = $1 AND tenant_id <> $2::uuid
       UNION ALL
       SELECT 'vascular_access', COUNT(*)::int FROM vascular_access
        WHERE dialysis_patient_id = $1 AND tenant_id <> $2::uuid`,
      patientId, TENANT_B,
    );
    expect(rows.map((r) => [r.src, Number(r.n)]))
      .toEqual([['serology', 0], ['vascular_access', 0]]);
  });
});
