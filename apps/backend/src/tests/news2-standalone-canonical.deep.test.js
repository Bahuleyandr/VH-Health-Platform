// C-L4 — the STANDALONE NEWS2 write (recordNEWS2, POST /clinical/news2/record)
// must join the canonical clinical timeline (docs/CANONICAL_CLINICAL_TIMELINE.md):
// detail row + one clinical_timeline_events row + one clinical_audit_events row
// in the SAME transaction, carrying the patient's REAL tenant (previously the
// row was written on plain prisma — no canonical rows, no tx, and the
// news2_scores tenant column default-stamped DEFAULT_TENANT_ID).
//
// Also pins the C-M7 patient-level scale resolution end-to-end: a patient whose
// users.news2_spo2_scale flag (migration 646) is 2, on room air with SpO2 97,
// persists spo2_scale=2 and total_score=0 — NOT a 3-point red parameter.
//
// Mechanism mirrors canonical-timeline-atomicity.deep.test.js: the canonical
// platform service is module-mocked so we can (a) assert the emit runs on the
// tx client with an EXPLICIT tenantId and (b) arm it to throw and prove the
// news2_scores row rolls back. Needs the test Postgres; self-skips without it.

import { jest } from '@jest/globals';

const canonicalControl = { mode: 'real', throwError: null, seenDbIsTx: null, seenTenantId: null };
const recordCanonicalSpy = jest.fn(async (input, options) => {
  const db = options?.db;
  canonicalControl.seenDbIsTx = !!(db && typeof db.$queryRawUnsafe === 'function' && db !== globalPrisma);
  canonicalControl.seenTenantId = input.tenantId ?? input.tenant_id ?? null;

  if (canonicalControl.mode === 'throw') {
    throw canonicalControl.throwError || new Error('forced canonical event failure');
  }

  // Success path: write one timeline + one audit row ON THE SAME tx so they
  // commit atomically with the detail row — with the tenant the service passed.
  const tenantId = input.tenantId || input.tenant_id || '00000000-0000-4000-8000-000000000001';
  const sourceId = String(input.sourceId ?? input.source_id ?? '');
  const idemBase = `news2-standalone:${input.eventType}:${sourceId}:${Date.now()}:${Math.random()}`;
  const timeline = await db.$queryRawUnsafe(
    `INSERT INTO clinical_timeline_events
       (tenant_id, patient_uid, event_type, source_table, source_id, resource_type, resource_id, idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    tenantId, input.patientUid || input.patient_uid, input.eventType,
    input.sourceTable || input.source_table, sourceId,
    input.resourceType || input.resource_type,
    String(input.resourceId ?? input.resource_id ?? ''), `${idemBase}:tl`,
  );
  const audit = await db.$queryRawUnsafe(
    `INSERT INTO clinical_audit_events
       (tenant_id, patient_uid, action, resource_table, resource_id, idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
     RETURNING *`,
    tenantId, input.patientUid || input.patient_uid, input.action || input.eventType,
    input.sourceTable || input.source_table, sourceId, `${idemBase}:au`,
  );
  return { timeline: timeline[0] || null, audit: audit[0] || null };
});

jest.unstable_mockModule('../services/clinical/canonicalClinicalPlatformService.js', () => ({
  cancelWorkflowSla: jest.fn(),
  recordCanonicalClinicalEvent: recordCanonicalSpy,
  recordClinicalAuditEvent: jest.fn(),
  currentCanonicalTransactionRevision: jest.fn().mockResolvedValue(1),
  startWorkflowSla: jest.fn(async () => ({ id: 'sla-mock' })),
}));

const prismaModule = await import('../lib/prisma.js');
const prisma = prismaModule.default;
const globalPrisma = prisma;
const { recordNEWS2 } = await import('../services/clinical/news2Service.js');

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

// A real, NON-default tenant — proves the tenant flows from the patient row,
// not from the DEFAULT_TENANT_ID fallback in the emit funnel.
const TENANT_ID = 'a6410000-0000-4000-8000-0000000000b1';
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'a6410000-0000-4000-8000-0000000000a1';
const SCALE2_PATIENT_UID = 'a6410000-0000-4000-8000-0000000000a2';
const RECORDER_UID = 'a6410000-0000-4000-8000-0000000000a3';
const PATIENT_PHONE = `9141${String(Date.now() % 1000000).padStart(6, '0')}`;

// Dead-normal vitals → total 0, no escalation task machinery in this suite.
const NORMAL_VITALS = {
  respiration_rate: 16, spo2: 98, temperature: 37,
  systolic_bp: 120, heart_rate: 72, consciousness: 'A',
};

async function news2Rows(patientUid) {
  return prisma.$queryRawUnsafe(
    `SELECT id, tenant_id::text AS tenant_id, spo2_scale, total_score, clinical_risk
       FROM news2_scores WHERE patient_uid = $1::uuid ORDER BY id`,
    patientUid,
  );
}

async function cleanup() {
  for (const uid of [PATIENT_UID, SCALE2_PATIENT_UID]) {
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM news2_scores WHERE patient_uid = $1::uuid`, uid).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
    PATIENT_UID, SCALE2_PATIENT_UID, RECORDER_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_ID).catch(() => {});
}

d('Standalone NEWS2 write — canonical timeline + tenant + patient-level scale (C-L4/C-M7)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'news2-canonical-t', 'NEWS2 Canonical Tenant')`,
      TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'NEWS2 Canonical Patient', 'PATIENT', true, $3::uuid, NOW())`,
      PATIENT_UID, PATIENT_PHONE, TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, news2_spo2_scale, updated_at)
       VALUES ($1::uuid, $2, 'NEWS2 Scale2 Patient', 'PATIENT', true, $3::uuid, 2, NOW())`,
      SCALE2_PATIENT_UID, `${PATIENT_PHONE}1`, TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'NEWS2 Canonical Nurse', 'NURSING_STAFF', true, $3::uuid, NOW())`,
      RECORDER_UID, `${PATIENT_PHONE}2`, TENANT_ID,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 60_000);

  beforeEach(() => {
    canonicalControl.mode = 'real';
    canonicalControl.throwError = null;
    canonicalControl.seenDbIsTx = null;
    canonicalControl.seenTenantId = null;
    recordCanonicalSpy.mockClear();
  });

  test('success: detail row + exactly one timeline + one audit row, all under the patient tenant', async () => {
    const record = await recordNEWS2(PATIENT_UID, NORMAL_VITALS, RECORDER_UID);
    expect(record?.id).toBeTruthy();

    // The canonical emit ran ON THE TX with an EXPLICIT tenant (not the
    // emit-funnel DEFAULT_TENANT_ID fallback).
    expect(recordCanonicalSpy).toHaveBeenCalledTimes(1);
    expect(canonicalControl.seenDbIsTx).toBe(true);
    expect(canonicalControl.seenTenantId).toBe(TENANT_ID);
    const emitted = recordCanonicalSpy.mock.calls[0][0];
    expect(emitted).toMatchObject({
      eventType: 'news2.recorded',
      sourceTable: 'news2_scores',
      resourceType: 'news2_score',
      patientUid: PATIENT_UID,
    });
    expect(emitted.payload.spo2_scale).toBe(1);

    // Detail row stamped with the patient's real tenant (setTenantTx GUC).
    const rows = await news2Rows(PATIENT_UID);
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(TENANT_ID);
    expect(rows[0].tenant_id).not.toBe(DEFAULT_TENANT_ID);

    // Exactly one timeline + one audit row for this score, same tenant.
    const timeline = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id FROM clinical_timeline_events
        WHERE source_table = 'news2_scores' AND source_id = $1`,
      String(record.id),
    );
    const audit = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id FROM clinical_audit_events
        WHERE resource_table = 'news2_scores' AND resource_id = $1`,
      String(record.id),
    );
    expect(timeline).toHaveLength(1);
    expect(audit).toHaveLength(1);
    expect(timeline[0].tenant_id).toBe(TENANT_ID);
    expect(audit[0].tenant_id).toBe(TENANT_ID);
  });

  test('canonical emit failure rolls back the news2_scores detail row (atomicity)', async () => {
    const before = (await news2Rows(PATIENT_UID)).length;

    canonicalControl.mode = 'throw';
    canonicalControl.throwError = new Error('simulated timeline insert failure');

    await expect(recordNEWS2(PATIENT_UID, NORMAL_VITALS, RECORDER_UID))
      .rejects.toThrow(/simulated timeline insert failure/);

    expect(recordCanonicalSpy).toHaveBeenCalledTimes(1);
    expect(canonicalControl.seenDbIsTx).toBe(true);
    const after = (await news2Rows(PATIENT_UID)).length;
    expect(after).toBe(before);
  });

  test('patient-level Scale-2 flag resolves when the caller sends no spo2_scale — room-air SpO2 97 is NOT a red', async () => {
    const record = await recordNEWS2(
      SCALE2_PATIENT_UID,
      { ...NORMAL_VITALS, spo2: 97, supplemental_o2: false },
      RECORDER_UID,
    );
    expect(record?.id).toBeTruthy();

    const rows = await news2Rows(SCALE2_PATIENT_UID);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].spo2_scale)).toBe(2);
    expect(Number(rows[0].total_score)).toBe(0);
    expect(rows[0].clinical_risk).toBe('low');
    expect(recordCanonicalSpy.mock.calls[0][0].payload.spo2_scale).toBe(2);
  });

  test('an explicit caller-supplied spo2_scale still wins over the patient flag', async () => {
    const record = await recordNEWS2(
      SCALE2_PATIENT_UID,
      { ...NORMAL_VITALS, spo2: 96, spo2_scale: 1 },
      RECORDER_UID,
    );
    const rows = await news2Rows(SCALE2_PATIENT_UID);
    const row = rows.find((r) => Number(r.id) === Number(record.id));
    expect(Number(row.spo2_scale)).toBe(1);
    expect(Number(row.total_score)).toBe(0); // 96 on Scale 1 → 0
  });

  test('an invalid spo2_scale is rejected with 400 before anything persists', async () => {
    const before = (await news2Rows(PATIENT_UID)).length;
    await expect(recordNEWS2(PATIENT_UID, { ...NORMAL_VITALS, spo2_scale: 7 }, RECORDER_UID))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(recordCanonicalSpy).not.toHaveBeenCalled();
    expect((await news2Rows(PATIENT_UID)).length).toBe(before);
  });
});
