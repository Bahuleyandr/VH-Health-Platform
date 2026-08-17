// Canonical clinical timeline ATOMICITY — deep integration (B0.5 / BA-1).
//
// The platform's non-negotiable invariant (docs/CANONICAL_CLINICAL_TIMELINE.md,
// root CLAUDE.md "Canonical clinical timeline invariant"): every successful
// patient-facing clinical write must persist the detail row + one
// clinical_timeline_events row + one clinical_audit_events row IN THE SAME
// transaction, rolling back ALL if any fails.
//
// This test proves the transaction boundary on a representative clinical write
// (vitals — vitalsChartService.recordVitals): when the canonical event write
// throws, the vitals_chart detail row must NOT persist (full rollback); on
// success the detail row + its canonical timeline + audit rows must all exist.
//
// Mechanism: the canonical platform service is module-mocked so we control
// recordCanonicalClinicalEvent. The mock receives the SAME transaction client
// (options.db === tx) the service is supposed to thread through; on the success
// path it performs the real timeline + audit INSERTs ON THAT tx (so they
// commit atomically with the detail row), and on the armed-failure path it
// throws. prisma.$transaction and prisma.vitals_chart.create are the real thing
// throughout, so rollback is the genuine Postgres transaction rollback. The
// mock asserts options.db is a transaction-scoped raw client — which is the
// whole point of the fix (the canonical write must run on tx, not global
// prisma). We deliberately do NOT delegate to the real module here: importing
// the real module from inside its own mock factory recurses infinitely.
//
// Needs the test Postgres (DATABASE_URL / TEST_DATABASE_URL, default
// 127.0.0.1:55432 db vhhealth_test). When the DB is unreachable the suite
// self-skips (mirrors device-vitals.deep.test.js).

import { jest } from '@jest/globals';

// Toggle + spy controlling the mocked canonical event writer.
const canonicalControl = { mode: 'real', throwError: null, seenDbIsTx: null };
const recordCanonicalSpy = jest.fn(async (input, options) => {
  const db = options?.db;
  // The service MUST thread the transaction client through to the canonical
  // write — record whether it did so the rollback test can assert on it.
  canonicalControl.seenDbIsTx = !!(db && typeof db.$queryRawUnsafe === 'function' && db !== globalPrisma);

  if (canonicalControl.mode === 'throw') {
    throw canonicalControl.throwError || new Error('forced canonical event failure');
  }

  // Success path: write one timeline row + one audit row on the SAME tx so
  // they commit atomically with the detail row (mirrors the real helper's
  // two INSERTs into clinical_timeline_events + clinical_audit_events).
  const tenantId = input.tenantId || input.tenant_id || '00000000-0000-4000-8000-000000000001';
  const sourceId = String(input.sourceId ?? input.source_id ?? '');
  const idemBase = `atomicity-test:${input.eventType}:${sourceId}:${Date.now()}:${Math.random()}`;
  const timeline = await db.$queryRawUnsafe(
    `INSERT INTO clinical_timeline_events
       (tenant_id, patient_uid, event_type, source_table, source_id, resource_type, resource_id, idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    tenantId,
    input.patientUid || input.patient_uid,
    input.eventType,
    input.sourceTable || input.source_table,
    sourceId,
    input.resourceType || input.resource_type,
    String(input.resourceId ?? input.resource_id ?? ''),
    `${idemBase}:tl`,
  );
  const audit = await db.$queryRawUnsafe(
    `INSERT INTO clinical_audit_events
       (tenant_id, patient_uid, action, resource_table, resource_id, idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
     RETURNING *`,
    tenantId,
    input.patientUid || input.patient_uid,
    input.action || input.eventType,
    input.sourceTable || input.source_table,
    sourceId,
    `${idemBase}:au`,
  );
  return { timeline: timeline[0] || null, audit: audit[0] || null };
});

jest.unstable_mockModule('../services/clinical/canonicalClinicalPlatformService.js', () => ({
  cancelWorkflowSla: jest.fn(),
  recordCanonicalClinicalEvent: recordCanonicalSpy,
  recordClinicalAuditEvent: jest.fn(),
  currentCanonicalTransactionRevision: jest.fn().mockResolvedValue(1),
}));

const prismaModule = await import('../lib/prisma.js');
const prisma = prismaModule.default;
const globalPrisma = prisma;
const { recordVitals } = await import('../services/emr/vitalsChartService.js');

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const PATIENT_UID = 'c1a70000-0000-4000-8000-00000000a101';
const RECORDER_UID = 'c1a70000-0000-4000-8000-00000000a102';
const PATIENT_PHONE = `9100${String(Date.now() % 1000000).padStart(6, '0')}`;

async function vitalsRowCount() {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS n FROM vitals_chart WHERE patient_uid = $1::uuid',
    PATIENT_UID,
  );
  return Number(rows[0]?.n ?? 0);
}

async function timelineRowsForVital(vitalsId) {
  return prisma.$queryRawUnsafe(
    `SELECT id FROM clinical_timeline_events
      WHERE source_table = 'vitals_chart' AND source_id = $1`,
    String(vitalsId),
  );
}

async function auditRowsForVital(vitalsId) {
  return prisma.$queryRawUnsafe(
    `SELECT id FROM clinical_audit_events
      WHERE resource_table = 'vitals_chart' AND resource_id = $1`,
    String(vitalsId),
  );
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid AND source_table = 'vitals_chart'`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid AND resource_table = 'vitals_chart'`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM news2_scores WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  // clinical_alerts is keyed by int patient_id — resolve then delete.
  const existing = await prisma.$queryRawUnsafe(`SELECT id FROM users WHERE uid = $1::uuid`, PATIENT_UID).catch(() => []);
  if (existing.length) {
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_alerts WHERE patient_id = $1`, existing[0].id).catch(() => {});
  }
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, RECORDER_UID).catch(() => {});
}

d('Canonical clinical timeline atomicity — vitals write (BA-1)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'Atomicity Test Patient', 'PATIENT', true, NOW())`,
      PATIENT_UID, PATIENT_PHONE,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'Atomicity Test Nurse', 'NURSING_STAFF', true, NOW())`,
      RECORDER_UID, `${PATIENT_PHONE}1`,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  beforeEach(() => {
    canonicalControl.mode = 'real';
    canonicalControl.throwError = null;
    canonicalControl.seenDbIsTx = null;
    recordCanonicalSpy.mockClear();
  });

  test('canonical event failure rolls back the vitals detail row (no orphan detail)', async () => {
    const before = await vitalsRowCount();

    canonicalControl.mode = 'throw';
    canonicalControl.throwError = new Error('simulated clinical_timeline_events insert failure');

    await expect(recordVitals({
      patient_uid: PATIENT_UID,
      recorded_by: RECORDER_UID,
      heart_rate: 88,
      systolic_bp: 120,
      diastolic_bp: 80,
      spo2: 98,
    })).rejects.toThrow(/simulated clinical_timeline_events insert failure/);

    // The detail row must NOT have persisted — the whole transaction rolled back.
    const after = await vitalsRowCount();
    expect(after).toBe(before);

    // And the canonical writer was actually reached, on the transaction client
    // (the fix threads tx through — without that the detail row would have been
    // committed before the canonical write ran, and rollback could not undo it).
    expect(recordCanonicalSpy).toHaveBeenCalledTimes(1);
    expect(canonicalControl.seenDbIsTx).toBe(true);
  });

  test('success path persists detail + timeline + audit rows together', async () => {
    canonicalControl.mode = 'real';

    const result = await recordVitals({
      patient_uid: PATIENT_UID,
      recorded_by: RECORDER_UID,
      heart_rate: 76,
      systolic_bp: 118,
      diastolic_bp: 78,
      spo2: 99,
      respiratory_rate: 16,
      temperature: 36.8,
    });

    const vitalsId = result?.vitals?.id;
    expect(vitalsId).toBeTruthy();

    // Detail row exists.
    const detail = await prisma.$queryRawUnsafe(
      'SELECT id, heart_rate FROM vitals_chart WHERE id = $1',
      Number(vitalsId),
    );
    expect(detail).toHaveLength(1);
    expect(Number(detail[0].heart_rate)).toBe(76);

    // Exactly one canonical timeline row + one audit row for this detail row.
    const timeline = await timelineRowsForVital(vitalsId);
    const audit = await auditRowsForVital(vitalsId);
    expect(timeline).toHaveLength(1);
    expect(audit).toHaveLength(1);
  });

  test('a second vitals write after a rolled-back one still succeeds (no aborted-tx leakage)', async () => {
    // Arm a failure, trigger the rollback path.
    canonicalControl.mode = 'throw';
    await expect(recordVitals({
      patient_uid: PATIENT_UID,
      recorded_by: RECORDER_UID,
      heart_rate: 101,
      spo2: 95,
    })).rejects.toThrow();

    // Now a clean write must commit normally — proves the rollback left no
    // poisoned connection / aborted-transaction state behind.
    canonicalControl.mode = 'real';
    const ok = await recordVitals({
      patient_uid: PATIENT_UID,
      recorded_by: RECORDER_UID,
      heart_rate: 72,
      spo2: 97,
    });
    expect(ok?.vitals?.id).toBeTruthy();
    const timeline = await timelineRowsForVital(ok.vitals.id);
    expect(timeline).toHaveLength(1);
  });
});
