import prisma from '../lib/prisma.js';
import {
  CONTRACT_VERSION,
  resolveDialysisIsolation,
} from '../services/clinical/dialysisIsolationResolver.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';
const TENANT = '76700000-0000-4000-8000-000000000002';
const OTHER_TENANT = '76700000-0000-4000-8000-000000000003';
const ACTOR = '76700000-0000-4000-8000-0000000000ff';
const DEFAULT_PROBE = '76700000-0000-4000-8000-000000000012';
const PATIENTS = Object.freeze({
  legacyPositive: '76700000-0000-4000-8000-00000000000a',
  legacyNegative: '76700000-0000-4000-8000-00000000000b',
  evidenceClear: '76700000-0000-4000-8000-00000000000c',
  newerPending: '76700000-0000-4000-8000-00000000000d',
  voidedFallsBack: '76700000-0000-4000-8000-00000000000e',
  voidedWithoutFallback: '76700000-0000-4000-8000-00000000000f',
  serologyClear: '76700000-0000-4000-8000-000000000010',
  reactiveLatches: '76700000-0000-4000-8000-000000000011',
});
const PATIENT_UIDS = Object.values(PATIENTS);
const USER_UIDS = [...PATIENT_UIDS, ACTOR, DEFAULT_PROBE];

async function clean() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_bloodborne_markers
      WHERE tenant_id = $1::uuid AND patient_uid = ANY($2::uuid[])`,
    TENANT, PATIENT_UIDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM dialysis_patients
      WHERE tenant_id = $1::uuid AND patient_uid = ANY($2::uuid[])`,
    TENANT, PATIENT_UIDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE tenant_id = $1::uuid AND uid = ANY($2::uuid[])`,
    TENANT, USER_UIDS,
  ).catch(() => {});
}

async function marker(patientUid, markerName, result, testedOn, { voided = false } = {}) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO patient_bloodborne_markers
       (tenant_id, patient_uid, marker, result, tested_on, source, recorded_by,
        voided_at, voided_by, void_reason)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, 'clinical_declaration', $6::uuid,
             CASE WHEN $7::boolean THEN NOW() ELSE NULL END,
             CASE WHEN $7::boolean THEN $6::uuid ELSE NULL END,
             CASE WHEN $7::boolean THEN 'entered_in_error' ELSE NULL END)`,
    TENANT, patientUid, markerName, result, testedOn, ACTOR, voided,
  );
}

d('Phase 1 dialysis isolation resolver against tenant data', () => {
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, 'dialysis-isolation-767', 'Dialysis Isolation 767')
       ON CONFLICT (id) DO NOTHING`,
      TENANT,
    );
    expect(USER_UIDS).toHaveLength(10);
    for (const [index, uid] of USER_UIDS.entries()) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO users
           (uid, tenant_id, phone, name, role, is_active, status, registered_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, TRUE, 'active', NOW(), NOW())
         ON CONFLICT (uid) DO UPDATE SET is_active = TRUE, status = 'active', updated_at = NOW()`,
        uid,
        TENANT,
        `7670000${String(index).padStart(2, '0')}`,
        `Isolation 767 ${index}`,
        uid === ACTOR ? 'ADMIN' : 'PATIENT',
      );
    }

    for (const uid of PATIENT_UIDS) {
      const legacyHbsagPositive = [PATIENTS.legacyPositive, PATIENTS.voidedFallsBack].includes(uid);
      await prisma.$executeRawUnsafe(
        `INSERT INTO dialysis_patients
           (tenant_id, patient_uid, modality, status, hbsag_status, hcv_status, hiv_status)
         VALUES ($1::uuid, $2::uuid, 'hd', 'active', $3, 'negative', 'negative')`,
        TENANT, uid, legacyHbsagPositive ? 'positive' : 'negative',
      );
    }

    for (const markerName of ['hbsag', 'hcv', 'hiv']) {
      await marker(PATIENTS.evidenceClear, markerName, 'non_reactive', '2026-09-01');
      await marker(PATIENTS.newerPending, markerName, 'non_reactive', '2026-08-01');
    }
    await marker(PATIENTS.newerPending, 'hiv', 'pending', '2026-09-02');
    await marker(PATIENTS.voidedFallsBack, 'hbsag', 'reactive', '2026-09-03', { voided: true });
    await marker(PATIENTS.voidedWithoutFallback, 'hbsag', 'reactive', '2026-09-03', { voided: true });
    await marker(PATIENTS.reactiveLatches, 'hcv', 'reactive', '2026-01-01');
    await marker(PATIENTS.reactiveLatches, 'hcv', 'non_reactive', '2026-09-04');

    const serologyPatient = await prisma.$queryRawUnsafe(
      `SELECT id FROM dialysis_patients WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT, PATIENTS.serologyClear,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO dialysis_serology
         (tenant_id, dialysis_patient_id, test_date, hbsag, anti_hcv, hiv)
       VALUES ($1::uuid, $2::int, '2026-09-05', 'negative', 'negative', 'negative')`,
      TENANT, Number(serologyPatient[0].id),
    );
  }, 30000);

  afterAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe('DELETE FROM tenants WHERE id = $1::uuid', TENANT).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('the fixture population is non-empty, exact, and belongs to a non-default tenant', async () => {
    expect(PATIENT_UIDS).toHaveLength(8);
    expect(TENANT).not.toBe(DEFAULT_TENANT);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id, patient_uid::text AS patient_uid
         FROM dialysis_patients
        WHERE tenant_id = $1::uuid AND patient_uid = ANY($2::uuid[])`,
      TENANT, PATIENT_UIDS,
    );
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((row) => row.tenant_id))).toEqual(new Set([TENANT]));
  });

  it('defaults omitted legacy declarations to unknown in the migrated database', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO dialysis_patients (tenant_id, patient_uid, modality, status)
       VALUES ($1::uuid, $2::uuid, 'hd', 'active')
       RETURNING hbsag_status, hcv_status, hiv_status`,
      TENANT, DEFAULT_PROBE,
    );
    expect(rows).toEqual([{
      hbsag_status: 'unknown', hcv_status: 'unknown', hiv_status: 'unknown',
    }]);
    await prisma.$executeRawUnsafe(
      'DELETE FROM dialysis_patients WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid',
      TENANT, DEFAULT_PROBE,
    );
  });

  it('rejects a serology row whose tenant does not own its dialysis parent', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, 'dialysis-isolation-767-other', 'Dialysis Isolation 767 Other')
       ON CONFLICT (id) DO NOTHING`,
      OTHER_TENANT,
    );
    const [parent] = await prisma.$queryRawUnsafe(
      `SELECT id FROM dialysis_patients
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT, PATIENTS.legacyNegative,
    );
    let failure;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO dialysis_serology
           (tenant_id, dialysis_patient_id, test_date, hbsag, anti_hcv, hiv)
         VALUES ($1::uuid, $2::int, '2026-09-06', 'negative', 'negative', 'negative')`,
        OTHER_TENANT, Number(parent.id),
      );
    } catch (error) {
      failure = error;
    } finally {
      await prisma.$executeRawUnsafe(
        'DELETE FROM tenants WHERE id = $1::uuid', OTHER_TENANT,
      ).catch(() => {});
    }
    expect(failure).toBeDefined();
    expect(String(failure?.message)).toContain('fk_dialysis_serology_tenant_patient');
  });

  it('resolves every asymmetric and live-evidence arm in one batch', async () => {
    const decisions = await resolveDialysisIsolation({
      tenantId: TENANT,
      patientUids: PATIENT_UIDS,
      db: prisma,
      contractVersion: CONTRACT_VERSION,
      includeMarkers: true,
      includeIsolationClass: true,
    });
    expect(decisions.size).toBe(8);
    expect(decisions.get(PATIENTS.legacyPositive)).toMatchObject({
      status: 'restricted', evidence: 'legacy_declaration', isolation_class: 'hbsag',
    });
    expect(decisions.get(PATIENTS.legacyNegative)).toMatchObject({
      status: 'unknown', evidence: 'none', isolation_class: null,
    });
    expect(decisions.get(PATIENTS.evidenceClear)).toMatchObject({
      status: 'clear', evidence: 'marker', evidence_dated_on: '2026-09-01', isolation_class: null,
    });
    expect(decisions.get(PATIENTS.newerPending).status).toBe('unknown');
    expect(decisions.get(PATIENTS.voidedFallsBack)).toMatchObject({
      status: 'restricted', evidence: 'legacy_declaration', isolation_class: 'hbsag', markers: [],
    });
    expect(decisions.get(PATIENTS.voidedWithoutFallback)).toMatchObject({
      status: 'unknown', evidence: 'none', isolation_class: null, markers: [],
    });
    expect(decisions.get(PATIENTS.serologyClear)).toMatchObject({
      status: 'clear', evidence: 'marker', evidence_dated_on: '2026-09-05', isolation_class: null,
    });
    expect(decisions.get(PATIENTS.reactiveLatches)).toMatchObject({
      status: 'restricted', evidence: 'marker', isolation_class: 'hcv',
    });
  });
});
