// MEDIUM (audit 2026-06-18 §4) — NEWS2 persistence must be ATOMIC with the
// vitals write, and a high-NEWS2 (>=5) escalation failure must be LOUD.
//
// Defects:
//   * recordNEWS2 ran OUTSIDE the vitals transaction in a warn-catch, so a
//     news2_scores row could be lost while the vitals row committed.
//   * It only computed when RR+SpO2+SBP+HR were ALL present (partial sets
//     silently produced no score).
//   * A >=5 escalation failure was swallowed (logger.error + continue).
//
// Fixes proven here against the real recordVitals path + real DB:
//   1. A full vitals set persists a news2_scores row IN THE SAME transaction as
//      the vitals row (atomic): when the canonical timeline write is armed to
//      throw, BOTH the vitals row AND the news2_scores row roll back.
//   2. A PARTIAL vitals set (no SBP) still computes + persists a NEWS2 score
//      (previously skipped entirely).
//   3. Success persists exactly one news2_scores row per vitals write.
//
// (The ">=5 escalation failure is loud" branch is unit-tested deterministically
// in src/tests/unit/news2EscalationLoud.test.js — faulting the outbox there is
// cleaner than from the full integration path.)
//
// Mechanism: the canonical platform service is module-mocked (mirrors
// canonical-timeline-atomicity.deep.test.js) so we can arm the timeline write to
// throw and prove rollback. Self-isolating fixtures.

import { jest } from '@jest/globals';

const canonicalControl = { mode: 'real', throwError: null };
const recordCanonicalSpy = jest.fn(async (input, options) => {
  const db = options?.db;
  if (canonicalControl.mode === 'throw') {
    throw canonicalControl.throwError || new Error('forced canonical event failure');
  }
  const tenantId = input.tenantId || input.tenant_id || '00000000-0000-4000-8000-000000000001';
  const sourceId = String(input.sourceId ?? input.source_id ?? '');
  const idemBase = `news2-atomic:${input.eventType}:${sourceId}:${Date.now()}:${Math.random()}`;
  await db.$queryRawUnsafe(
    `INSERT INTO clinical_timeline_events
       (tenant_id, patient_uid, event_type, source_table, source_id, resource_type, resource_id, idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)`,
    tenantId, input.patientUid || input.patient_uid, input.eventType,
    input.sourceTable || input.source_table, sourceId,
    input.resourceType || input.resource_type,
    String(input.resourceId ?? input.resource_id ?? ''), `${idemBase}:tl`,
  );
  await db.$queryRawUnsafe(
    `INSERT INTO clinical_audit_events
       (tenant_id, patient_uid, action, resource_table, resource_id, idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
    tenantId, input.patientUid || input.patient_uid, input.action || input.eventType,
    input.sourceTable || input.source_table, sourceId, `${idemBase}:au`,
  );
  return { timeline: null, audit: null };
});

jest.unstable_mockModule('../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalSpy,
}));

const prismaModule = await import('../lib/prisma.js');
const prisma = prismaModule.default;
const { recordVitals } = await import('../services/emr/vitalsChartService.js');

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'e2520000-0000-4000-8000-0000000000a2';
const RECORDER_UID = 'e2520000-0000-4000-8000-0000000000a3';
const PATIENT_PHONE = `9130${String(Date.now() % 1000000).padStart(6, '0')}`;

async function news2Count() {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS n FROM news2_scores WHERE patient_uid = $1::uuid',
    PATIENT_UID,
  );
  return Number(rows[0]?.n ?? 0);
}
async function vitalsCount() {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS n FROM vitals_chart WHERE patient_uid = $1::uuid',
    PATIENT_UID,
  );
  return Number(rows[0]?.n ?? 0);
}

async function cleanup() {
  await prisma.$executeRawUnsafe(`DELETE FROM news2_scores WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  const u = await prisma.$queryRawUnsafe(`SELECT id FROM users WHERE uid = $1::uuid`, PATIENT_UID).catch(() => []);
  if (u.length) {
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_alerts WHERE patient_id = $1`, u[0].id).catch(() => {});
  }
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, RECORDER_UID).catch(() => {});
}

d('NEWS2 atomic-in-vitals-tx + partial score (MEDIUM §4)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'NEWS2 Atomic Patient', 'PATIENT', true, $3::uuid, NOW())`,
      PATIENT_UID, PATIENT_PHONE, TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'NEWS2 Atomic Nurse', 'NURSING_STAFF', true, $3::uuid, NOW())`,
      RECORDER_UID, `${PATIENT_PHONE}1`, TENANT_ID,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  beforeEach(() => {
    canonicalControl.mode = 'real';
    canonicalControl.throwError = null;
    recordCanonicalSpy.mockClear();
  });

  test('news2_scores is written inside the vitals tx — rolls back with the vitals row', async () => {
    const beforeV = await vitalsCount();
    const beforeN = await news2Count();

    canonicalControl.mode = 'throw';
    canonicalControl.throwError = new Error('simulated timeline insert failure');

    await expect(recordVitals({
      patient_uid: PATIENT_UID,
      recorded_by: RECORDER_UID,
      respiratory_rate: 22,
      spo2: 93,
      systolic_bp: 108,
      heart_rate: 105,
      temperature: 37.5,
      tenant_id: TENANT_ID,
    })).rejects.toThrow(/simulated timeline insert failure/);

    // BOTH the vitals row and the news2 row rolled back (atomic).
    expect(await vitalsCount()).toBe(beforeV);
    expect(await news2Count()).toBe(beforeN);
  });

  test('a full vitals set persists exactly one news2_scores row on success', async () => {
    const beforeN = await news2Count();
    const result = await recordVitals({
      patient_uid: PATIENT_UID,
      recorded_by: RECORDER_UID,
      respiratory_rate: 18,
      spo2: 96,
      systolic_bp: 122,
      heart_rate: 84,
      temperature: 36.9,
      tenant_id: TENANT_ID,
    });
    expect(result?.vitals?.id).toBeTruthy();
    expect(result?.news2).toBeTruthy();
    expect(await news2Count()).toBe(beforeN + 1);
  });

  test('a PARTIAL vitals set (no systolic_bp) still computes + persists a NEWS2 score', async () => {
    const beforeN = await news2Count();
    // SpO2 90 (scale1 → 3), RR 22 (→ 2), HR 100 (→ 1) — alarming, but no SBP.
    const result = await recordVitals({
      patient_uid: PATIENT_UID,
      recorded_by: RECORDER_UID,
      respiratory_rate: 22,
      spo2: 90,
      heart_rate: 100,
      tenant_id: TENANT_ID,
    });
    expect(result?.vitals?.id).toBeTruthy();
    // Previously skipped (SBP absent) — now a partial NEWS2 is recorded.
    expect(result?.news2).toBeTruthy();
    expect(await news2Count()).toBe(beforeN + 1);
  });
});
