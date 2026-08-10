// C-M5 — nursing assessments (NEWS2 / Braden / Morse / sepsis screen) must
// join the canonical clinical timeline (docs/CANONICAL_CLINICAL_TIMELINE.md):
// detail row + one clinical_timeline_events row + one clinical_audit_events
// row in the SAME tenant-scoped transaction. Previously recordAssessment was a
// single INSERT on plain prisma — even a POSITIVE sepsis screen left zero
// timeline/audit footprint (the only surfacing was the pull-based
// overdue-or-high-risk dashboard).
//
// Also pins that a positive sepsis screen is VISIBLE on the timeline (summary,
// payload.sepsis_screen_positive, sepsis-screen-positive tag) and that a NEWS2
// assessment with no caller-supplied scale locks the patient-level resolved
// scale (users.news2_spo2_scale, migration 646) into the stored inputs.
//
// Mechanism mirrors canonical-timeline-atomicity.deep.test.js (module-mocked
// canonical writer, real Postgres tx). Self-skips without a DB.

import { jest } from '@jest/globals';

const canonicalControl = { mode: 'real', throwError: null, seenDbIsTx: null, seenTenantId: null };
const recordCanonicalSpy = jest.fn(async (input, options) => {
  const db = options?.db;
  canonicalControl.seenDbIsTx = !!(db && typeof db.$queryRawUnsafe === 'function' && db !== globalPrisma);
  canonicalControl.seenTenantId = input.tenantId ?? input.tenant_id ?? null;

  if (canonicalControl.mode === 'throw') {
    throw canonicalControl.throwError || new Error('forced canonical event failure');
  }

  const tenantId = input.tenantId || input.tenant_id || '00000000-0000-4000-8000-000000000001';
  const sourceId = String(input.sourceId ?? input.source_id ?? '');
  const idemBase = `nursing-canonical:${input.eventType}:${sourceId}:${Date.now()}:${Math.random()}`;
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
  recordCanonicalClinicalEvent: recordCanonicalSpy,
  recordClinicalAuditEvent: jest.fn(),
  currentCanonicalTransactionRevision: jest.fn().mockResolvedValue(1),
}));

const prismaModule = await import('../lib/prisma.js');
const prisma = prismaModule.default;
const globalPrisma = prisma;
const { recordAssessment } = await import('../services/clinical/nursingAssessmentService.js');

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

// Real NON-default tenant: the canonical rows must carry the route-resolved
// tenant, not the emit funnel's DEFAULT_TENANT_ID fallback.
const TENANT_ID = 'a6420000-0000-4000-8000-0000000000b1';
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'a6420000-0000-4000-8000-0000000000a1';
const SCALE2_PATIENT_UID = 'a6420000-0000-4000-8000-0000000000a2';
const NURSE_UID = 'a6420000-0000-4000-8000-0000000000a3';
const PATIENT_PHONE = `9142${String(Date.now() % 1000000).padStart(6, '0')}`;

async function assessmentRows(patientUid) {
  return prisma.$queryRawUnsafe(
    `SELECT id, assessment_kind, band, total_score, inputs, tenant_id::text AS tenant_id
       FROM nursing_assessments WHERE patient_uid = $1::uuid ORDER BY id`,
    patientUid,
  );
}

async function cleanup() {
  for (const uid of [PATIENT_UID, SCALE2_PATIENT_UID]) {
    await prisma.$executeRawUnsafe(`DELETE FROM tasks WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM workflow_sla_instances WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`, uid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM nursing_assessments WHERE patient_uid = $1::uuid`, uid).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
    PATIENT_UID, SCALE2_PATIENT_UID, NURSE_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_ID).catch(() => {});
}

d('Nursing assessment write — canonical timeline + tx + sepsis visibility (C-M5)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'nursing-canonical-t', 'Nursing Canonical Tenant')`,
      TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Nursing Canonical Patient', 'PATIENT', true, $3::uuid, NOW())`,
      PATIENT_UID, PATIENT_PHONE, TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, news2_spo2_scale, updated_at)
       VALUES ($1::uuid, $2, 'Nursing Scale2 Patient', 'PATIENT', true, $3::uuid, 2, NOW())`,
      SCALE2_PATIENT_UID, `${PATIENT_PHONE}1`, TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Nursing Canonical Nurse', 'NURSING_STAFF', true, $3::uuid, NOW())`,
      NURSE_UID, `${PATIENT_PHONE}2`, TENANT_ID,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  beforeEach(() => {
    canonicalControl.mode = 'real';
    canonicalControl.throwError = null;
    canonicalControl.seenDbIsTx = null;
    canonicalControl.seenTenantId = null;
    recordCanonicalSpy.mockClear();
  });

  test('success: detail row + exactly one timeline + one audit row, all under the route tenant', async () => {
    const saved = await recordAssessment({
      tenantId: TENANT_ID,
      patient_uid: PATIENT_UID,
      assessment_kind: 'braden',
      inputs: { sensory: 2, moisture: 2, activity: 2, mobility: 2, nutrition: 2, friction: 1 },
      assessed_by: NURSE_UID,
    });
    expect(saved?.id).toBeTruthy();
    expect(saved.band).toBe('high_risk'); // total 11

    expect(recordCanonicalSpy).toHaveBeenCalledTimes(1);
    expect(canonicalControl.seenDbIsTx).toBe(true);
    expect(canonicalControl.seenTenantId).toBe(TENANT_ID);
    const emitted = recordCanonicalSpy.mock.calls[0][0];
    expect(emitted).toMatchObject({
      eventType: 'nursing_assessment.recorded',
      eventSubtype: 'braden',
      sourceTable: 'nursing_assessments',
      resourceType: 'nursing_assessment',
      patientUid: PATIENT_UID,
      actorUid: NURSE_UID,
    });

    const rows = await assessmentRows(PATIENT_UID);
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(TENANT_ID);
    expect(rows[0].tenant_id).not.toBe(DEFAULT_TENANT_ID);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id FROM clinical_timeline_events
        WHERE source_table = 'nursing_assessments' AND source_id = $1`,
      String(saved.id),
    );
    const audit = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id FROM clinical_audit_events
        WHERE resource_table = 'nursing_assessments' AND resource_id = $1`,
      String(saved.id),
    );
    expect(timeline).toHaveLength(1);
    expect(audit).toHaveLength(1);
    expect(timeline[0].tenant_id).toBe(TENANT_ID);
    expect(audit[0].tenant_id).toBe(TENANT_ID);
  });

  test('a POSITIVE sepsis screen is visible on the timeline (summary, payload, tag)', async () => {
    const saved = await recordAssessment({
      tenantId: TENANT_ID,
      patient_uid: PATIENT_UID,
      assessment_kind: 'sepsis_screen',
      inputs: { rr_over_22: true, altered_mentation: true, source_suspected: true },
      assessed_by: NURSE_UID,
    });
    expect(saved.band).toBe('septic_shock_risk');

    const emitted = recordCanonicalSpy.mock.calls[0][0];
    expect(emitted.eventSubtype).toBe('sepsis_screen');
    expect(emitted.summary).toMatch(/Sepsis screen POSITIVE/);
    expect(emitted.summary).toMatch(/septic_shock_risk/);
    expect(emitted.payload.sepsis_screen_positive).toBe(true);
    expect(emitted.tags).toContain('sepsis-screen-positive');
  });

  test('a NEGATIVE sepsis screen is recorded without the positive marker', async () => {
    await recordAssessment({
      tenantId: TENANT_ID,
      patient_uid: PATIENT_UID,
      assessment_kind: 'sepsis_screen',
      inputs: {},
      assessed_by: NURSE_UID,
    });
    const emitted = recordCanonicalSpy.mock.calls[0][0];
    expect(emitted.payload.sepsis_screen_positive).toBe(false);
    expect(emitted.tags).not.toContain('sepsis-screen-positive');
    expect(emitted.summary).toMatch(/no_concern/);
  });

  test('canonical emit failure rolls back the assessment detail row (atomicity)', async () => {
    const before = (await assessmentRows(PATIENT_UID)).length;

    canonicalControl.mode = 'throw';
    canonicalControl.throwError = new Error('simulated timeline insert failure');

    await expect(recordAssessment({
      tenantId: TENANT_ID,
      patient_uid: PATIENT_UID,
      assessment_kind: 'sepsis_screen',
      inputs: { rr_over_22: true, hr_over_90: true, source_suspected: true },
      assessed_by: NURSE_UID,
    })).rejects.toThrow(/simulated timeline insert failure/);

    expect(recordCanonicalSpy).toHaveBeenCalledTimes(1);
    expect(canonicalControl.seenDbIsTx).toBe(true);
    const after = (await assessmentRows(PATIENT_UID)).length;
    expect(after).toBe(before);
  });

  // Audit 2026-08-10 — NEWS2 nursing-path parity with the vitals path. The
  // escalation-task half lives in
  // nursing-assessment-news2-escalation.deep.test.js (it needs the REAL
  // canonical platform service for startWorkflowSla; this file mocks it).
  test('a zero-parameter NEWS2 is a 400, not a fabricated "total 0 / low" row', async () => {
    const before = (await assessmentRows(PATIENT_UID)).length;
    await expect(recordAssessment({
      tenantId: TENANT_ID,
      patient_uid: PATIENT_UID,
      assessment_kind: 'news2',
      inputs: {},
      assessed_by: NURSE_UID,
    })).rejects.toMatchObject({ statusCode: 400 });
    expect((await assessmentRows(PATIENT_UID)).length).toBe(before);
  });

  test('a partial NEWS2 persists the partial marker + missing params (migration 652)', async () => {
    const saved = await recordAssessment({
      tenantId: TENANT_ID,
      patient_uid: PATIENT_UID,
      assessment_kind: 'news2',
      inputs: { rr: 16, spo2: 97, spo2_scale: 1 },
      assessed_by: NURSE_UID,
    });
    const rows = await prisma.$queryRawUnsafe(
      `SELECT partial_score, missing_params FROM nursing_assessments WHERE id = $1::int`,
      saved.id,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].partial_score).toBe(true);
    expect(rows[0].missing_params).toEqual(
      expect.arrayContaining(['temperature', 'systolic_bp', 'heart_rate', 'consciousness']),
    );
  });

  test('NEWS2 with no caller scale locks the patient-level Scale-2 flag into the stored inputs', async () => {
    const saved = await recordAssessment({
      tenantId: TENANT_ID,
      patient_uid: SCALE2_PATIENT_UID,
      assessment_kind: 'news2',
      // Room air, SpO2 97, everything else normal — on Scale 2 this must be 0.
      inputs: { rr: 16, spo2: 97, supplemental_o2: false, temp_c: 37, sbp: 120, hr: 72, consciousness: 'awake' },
      assessed_by: NURSE_UID,
    });
    expect(Number(saved.total_score)).toBe(0);
    expect(saved.band).toBe('low');

    const rows = await assessmentRows(SCALE2_PATIENT_UID);
    expect(rows).toHaveLength(1);
    const inputs = typeof rows[0].inputs === 'string' ? JSON.parse(rows[0].inputs) : rows[0].inputs;
    expect(inputs.spo2_scale).toBe(2);
  });
});
