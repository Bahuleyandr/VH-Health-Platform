/**
 * ICU lifecycle canonical-pair + DB backstop pins (re-review 2026-08-10
 * H1 / CLIN-3 / CLIN-4, migration 648).
 *
 * - createAdmission / code-status flips / discharge persist the detail row
 *   PLUS one clinical_timeline_events row and one clinical_audit_events row
 *   in the same transaction (docs/CANONICAL_CLINICAL_TIMELINE.md).
 * - Code-status (DNR) history is append-only in icu_code_status_history —
 *   flips are recorded, exact retries absorb without a second row.
 * - Discharge has a state guard: a second discharge is a 409, not a silent
 *   re-stamp.
 * - Migration 648's NOT VALID CHECK constraints reject implausible flowsheet
 *   and assessment values even when the app layer is bypassed.
 */
import { randomUUID } from 'crypto';
import prisma from '../lib/prisma.js';
import {
  createAdmission,
  updateAdmissionCodeStatus,
  dischargeAdmission,
} from '../services/clinical/icuService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = randomUUID();
const ACTOR_UID = randomUUID();

function pgErrorCode(err) {
  if (!err) return null;
  if (err.meta?.code) return String(err.meta.code);
  if (err.code && /^\d/.test(String(err.code))) return String(err.code);
  return /violates check constraint/i.test(err.message || '') ? '23514' : null;
}

async function timelineRows(admissionId) {
  return prisma.$queryRawUnsafe(
    `SELECT event_type, idempotency_key FROM clinical_timeline_events
      WHERE source_table = 'icu_admissions' AND source_id = $1
      ORDER BY id`,
    String(admissionId),
  );
}

async function auditRows(admissionId) {
  return prisma.$queryRawUnsafe(
    `SELECT action, idempotency_key FROM clinical_audit_events
      WHERE resource_table = 'icu_admissions' AND resource_id = $1
      ORDER BY id`,
    String(admissionId),
  );
}

d('ICU lifecycle canonical events + migration 648 backstops', () => {
  const createdAdmissionIds = [];

  async function cleanup() {
    if (createdAdmissionIds.length) {
      const ids = createdAdmissionIds.map(Number);
      await prisma.$executeRawUnsafe(
        `DELETE FROM clinical_timeline_events
          WHERE source_table = 'icu_admissions' AND source_id = ANY($1::text[])`,
        ids.map(String),
      ).catch(() => {});
      await prisma.$executeRawUnsafe(
        `DELETE FROM clinical_audit_events
          WHERE resource_table = 'icu_admissions' AND resource_id = ANY($1::text[])`,
        ids.map(String),
      ).catch(() => {});
      await prisma.$executeRawUnsafe(
        `DELETE FROM icu_code_status_history WHERE icu_admission_id = ANY($1::int[])`,
        ids,
      ).catch(() => {});
      await prisma.$executeRawUnsafe(
        `DELETE FROM icu_flowsheet_entries WHERE icu_admission_id = ANY($1::int[])`,
        ids,
      ).catch(() => {});
      await prisma.$executeRawUnsafe(
        `DELETE FROM icu_assessments WHERE icu_admission_id = ANY($1::int[])`,
        ids,
      ).catch(() => {});
      await prisma.$executeRawUnsafe(
        `DELETE FROM icu_admissions WHERE id = ANY($1::int[])`,
        ids,
      ).catch(() => {});
    }
  }

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function admit(extra = {}) {
    const row = await createAdmission({
      tenantId: DEFAULT_TENANT,
      actorUid: ACTOR_UID,
      actorRole: 'DOCTOR',
      patient_uid: PATIENT_UID,
      unit_code: 'MICU',
      ...extra,
    });
    createdAdmissionIds.push(row.id);
    return row;
  }

  it('createAdmission persists the canonical timeline+audit pair in the same tx', async () => {
    const adm = await admit();
    const timeline = await timelineRows(adm.id);
    const audit = await auditRows(adm.id);
    expect(timeline.map((r) => r.event_type)).toContain('icu.admission_created');
    expect(timeline.find((r) => r.event_type === 'icu.admission_created').idempotency_key)
      .toBe(`icu_admissions:${adm.id}:icu.admission_created`);
    expect(audit.map((r) => r.action)).toContain('icu.admission_created');
  });

  it('a DNR flip appends history + canonical pair; an exact retry absorbs', async () => {
    const adm = await admit();
    const flipped = await updateAdmissionCodeStatus({
      tenantId: DEFAULT_TENANT, id: adm.id, code_status: 'dnr', set_by: ACTOR_UID,
    });
    expect(flipped.code_status).toBe('dnr');

    // Retry with the same status: effective-state no-op.
    await updateAdmissionCodeStatus({
      tenantId: DEFAULT_TENANT, id: adm.id, code_status: 'dnr', set_by: ACTOR_UID,
    });

    const history = await prisma.$queryRawUnsafe(
      `SELECT previous_code_status, new_code_status FROM icu_code_status_history
        WHERE icu_admission_id = $1 ORDER BY id`,
      adm.id,
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ previous_code_status: 'full_code', new_code_status: 'dnr' });

    const timeline = await timelineRows(adm.id);
    expect(timeline.filter((r) => r.event_type === 'icu.code_status_changed')).toHaveLength(1);

    // Reversal appends a second history row and a second canonical revision.
    await updateAdmissionCodeStatus({
      tenantId: DEFAULT_TENANT, id: adm.id, code_status: 'full_code', set_by: ACTOR_UID,
    });
    const history2 = await prisma.$queryRawUnsafe(
      `SELECT new_code_status FROM icu_code_status_history WHERE icu_admission_id = $1 ORDER BY id`,
      adm.id,
    );
    expect(history2.map((r) => r.new_code_status)).toEqual(['dnr', 'full_code']);
    const timeline2 = await timelineRows(adm.id);
    expect(timeline2.filter((r) => r.event_type === 'icu.code_status_changed')).toHaveLength(2);
  });

  it('discharge emits the canonical pair once and blocks a second discharge with 409', async () => {
    const adm = await admit();
    const closed = await dischargeAdmission({
      tenantId: DEFAULT_TENANT, id: adm.id, disposition: 'ward', actorUid: ACTOR_UID,
    });
    expect(closed.status).toBe('discharged');

    const timeline = await timelineRows(adm.id);
    expect(timeline.filter((r) => r.event_type === 'icu.discharged')).toHaveLength(1);

    await expect(dischargeAdmission({
      tenantId: DEFAULT_TENANT, id: adm.id, disposition: 'ward', actorUid: ACTOR_UID,
    })).rejects.toMatchObject({ statusCode: 409, code: 'ICU_ADMISSION_NOT_ACTIVE' });

    // Still exactly one canonical discharge event.
    const timelineAfter = await timelineRows(adm.id);
    expect(timelineAfter.filter((r) => r.event_type === 'icu.discharged')).toHaveLength(1);
  });

  it('an ICU death is its own canonical event type', async () => {
    const adm = await admit();
    await dischargeAdmission({
      tenantId: DEFAULT_TENANT, id: adm.id, disposition: 'expired', actorUid: ACTOR_UID,
    });
    const timeline = await timelineRows(adm.id);
    expect(timeline.map((r) => r.event_type)).toContain('icu.death_recorded');
  });

  it('DB backstop: a direct flowsheet INSERT with spo2 990 violates the 648 CHECK', async () => {
    const adm = await admit();
    let code = null;
    try {
      await prisma.$queryRawUnsafe(
        `INSERT INTO icu_flowsheet_entries (icu_admission_id, spo2, tenant_id)
         VALUES ($1, 990, $2::uuid) RETURNING id`,
        adm.id, DEFAULT_TENANT,
      );
    } catch (err) {
      code = pgErrorCode(err);
    }
    expect(code).toBe('23514');
  });

  it('DB backstop: a direct assessment INSERT with SOFA sub-score 9 violates the 648 CHECK', async () => {
    const adm = await admit();
    let code = null;
    try {
      await prisma.$queryRawUnsafe(
        `INSERT INTO icu_assessments (icu_admission_id, assessment_kind, sofa_resp, tenant_id)
         VALUES ($1, 'sofa', 9, $2::uuid) RETURNING id`,
        adm.id, DEFAULT_TENANT,
      );
    } catch (err) {
      code = pgErrorCode(err);
    }
    expect(code).toBe('23514');
  });
});
