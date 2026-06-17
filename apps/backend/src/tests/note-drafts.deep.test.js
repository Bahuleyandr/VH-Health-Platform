// note_drafts autosave store — deep integration (clinical-notes autosave).
//
// LOAD-BEARING invariant (design spec §7 + migration 314): the draft path is a
// clinician's private scratchpad that emits ZERO canonical clinical events. This
// suite upserts/reads/deletes drafts against real Postgres and asserts the
// patient's clinical_timeline_events + clinical_audit_events counts NEVER move —
// plus upsert idempotency, author-scoping, the finalize-clear hook, and expiry.
//
// Needs the test Postgres (DATABASE_URL / TEST_DATABASE_URL, default
// 127.0.0.1:55432 db vhhealth_test). Self-skips when unconfigured (mirrors the
// other *.deep.test.js suites).

import {
  upsertNoteDraft,
  getNoteDraft,
  deleteNoteDraft,
  clearDraftForFinalizedNote,
  purgeExpiredNoteDrafts,
} from '../services/emr/clinicalNoteDraftService.js';

const prisma = (await import('../lib/prisma.js')).default;

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'd2a70000-0000-4000-8000-00000000d101';
const AUTHOR_A = 'd2a70000-0000-4000-8000-00000000d1a1';
const AUTHOR_B = 'd2a70000-0000-4000-8000-00000000d1b2';
const NOTE_TYPE = 'op_consultation';

async function draftCount(predicate, ...params) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM note_drafts WHERE patient_uid = $1::uuid AND ${predicate}`,
    PATIENT_UID,
    ...params,
  );
  return Number(rows[0]?.n ?? 0);
}

async function patientEventCounts() {
  const tl = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS n FROM clinical_timeline_events WHERE patient_uid = $1::uuid',
    PATIENT_UID,
  );
  const au = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS n FROM clinical_audit_events WHERE patient_uid = $1::uuid',
    PATIENT_UID,
  );
  return { timeline: Number(tl[0]?.n ?? 0), audit: Number(au[0]?.n ?? 0) };
}

async function cleanup() {
  await prisma.$executeRawUnsafe('DELETE FROM note_drafts WHERE patient_uid = $1::uuid', PATIENT_UID).catch(() => {});
}

d('note_drafts autosave store (deep)', () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it('upsert creates exactly one row; a second upsert for the same context updates it (no duplicate)', async () => {
    const first = await upsertNoteDraft({
      tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID,
      appointmentId: null, noteType: NOTE_TYPE, content: { chief: 'cough' },
    });
    expect(first?.id).toBeTruthy();
    expect(await draftCount("author_uid = $2::uuid AND note_type = 'op_consultation'", AUTHOR_A)).toBe(1);

    const second = await upsertNoteDraft({
      tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID,
      appointmentId: null, noteType: NOTE_TYPE, content: { chief: 'cough x3 days', plan: 'rest' },
    });
    expect(String(second.id)).toBe(String(first.id)); // same row, not a duplicate
    expect(await draftCount("author_uid = $2::uuid AND note_type = 'op_consultation'", AUTHOR_A)).toBe(1);

    const loaded = await getNoteDraft({
      tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID, appointmentId: null, noteType: NOTE_TYPE,
    });
    expect(loaded.content).toEqual({ chief: 'cough x3 days', plan: 'rest' });
  });

  it('getNoteDraft is author-scoped — a different author sees nothing', async () => {
    const mine = await getNoteDraft({
      tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID, appointmentId: null, noteType: NOTE_TYPE,
    });
    expect(mine).not.toBeNull();

    const theirs = await getNoteDraft({
      tenantId: TENANT, authorUid: AUTHOR_B, patientUid: PATIENT_UID, appointmentId: null, noteType: NOTE_TYPE,
    });
    expect(theirs).toBeNull();
  });

  it('LOAD-BEARING: the draft path emits ZERO canonical timeline/audit events', async () => {
    const before = await patientEventCounts();
    await upsertNoteDraft({
      tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID, appointmentId: null,
      noteType: 'progress', content: { body: 'in-progress' },
    });
    await getNoteDraft({
      tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID, appointmentId: null, noteType: 'progress',
    });
    await deleteNoteDraft({
      tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID, appointmentId: null, noteType: 'progress',
    });
    const after = await patientEventCounts();
    expect(after.timeline).toBe(before.timeline);
    expect(after.audit).toBe(before.audit);
  });

  it('deleteNoteDraft removes the draft and is idempotent', async () => {
    const removed = await deleteNoteDraft({
      tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID, appointmentId: null, noteType: NOTE_TYPE,
    });
    expect(removed).toBe(1);
    expect(await draftCount("author_uid = $2::uuid AND note_type = 'op_consultation'", AUTHOR_A)).toBe(0);

    const again = await deleteNoteDraft({
      tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID, appointmentId: null, noteType: NOTE_TYPE,
    });
    expect(again).toBe(0);
  });

  it('clearDraftForFinalizedNote (the finalize hook) drops the matching draft', async () => {
    await upsertNoteDraft({
      tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID, appointmentId: 77,
      noteType: NOTE_TYPE, content: { chief: 'x' },
    });
    expect(await draftCount('appointment_id = 77')).toBe(1);
    await clearDraftForFinalizedNote({
      tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID, appointmentId: 77, noteType: NOTE_TYPE,
    });
    expect(await draftCount('appointment_id = 77')).toBe(0);
  });

  it('purgeExpiredNoteDrafts deletes only past-TTL drafts', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO note_drafts (tenant_id, author_uid, patient_uid, appointment_id, note_type, content, expires_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 101, 'progress', '{}'::jsonb, NOW() - INTERVAL '1 hour')`,
      TENANT, AUTHOR_A, PATIENT_UID,
    );
    await upsertNoteDraft({
      tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID, appointmentId: 102,
      noteType: 'progress', content: {},
    });
    await purgeExpiredNoteDrafts();
    expect(await draftCount('appointment_id = 101')).toBe(0); // expired → gone
    expect(await draftCount('appointment_id = 102')).toBe(1); // live → kept
  });
});
