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
import { createNote, updateNote, signNote } from '../services/emr/clinicalNotesService.js';
import { serializeReliabilityMetrics } from '../observability/reliabilityMetrics.js';

// Read a no-label counter's current value from the /metrics exposition text
// (0 before its first inc — a Counter emits no sample line until then). Used to
// assert the note-draft operational counters move (or don't) at the two sites.
function counterValue(name) {
  const m = serializeReliabilityMetrics().match(new RegExp(`^${name} (\\d+)$`, 'm'));
  return m ? Number(m[1]) : 0;
}

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

  it('purgeExpiredNoteDrafts deletes only past-TTL drafts (and increments the janitor counter by the deleted count)', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO note_drafts (tenant_id, author_uid, patient_uid, appointment_id, note_type, content, expires_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 101, 'progress', '{}'::jsonb, NOW() - INTERVAL '1 hour')`,
      TENANT, AUTHOR_A, PATIENT_UID,
    );
    await upsertNoteDraft({
      tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID, appointmentId: 102,
      noteType: 'progress', content: {},
    });
    const janitorBefore = counterValue('note_draft_janitor_deletions_total');
    const removed = await purgeExpiredNoteDrafts();
    expect(await draftCount('appointment_id = 101')).toBe(0); // expired → gone
    expect(await draftCount('appointment_id = 102')).toBe(1); // live → kept
    // The janitor counter advanced by exactly the number of rows it deleted
    // (≥1 for our seeded expired draft).
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(counterValue('note_draft_janitor_deletions_total') - janitorBefore).toBe(removed);
  });

  it('a validation-rejected upsert (400) does NOT increment note_draft_save_errors_total', async () => {
    const before = counterValue('note_draft_save_errors_total');
    // A deliberate 400 (array content → NOTE_DRAFT_CONTENT_INVALID) — client
    // fault, thrown before the DB write, so it must NOT count as a save error.
    await expect(
      upsertNoteDraft({
        tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID,
        appointmentId: null, noteType: NOTE_TYPE, content: ['not', 'an', 'object'],
      }),
    ).rejects.toMatchObject({ name: 'AppError', statusCode: 400 });
    expect(counterValue('note_draft_save_errors_total')).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Input-validation hardening — draft path was LAXER than the canonical note
// path (external review). Draft input is now tightened to match the canonical
// path's stricter object requirement + a serialized-size cap, and a malformed
// appointment_id is rejected outright instead of silently collapsing into the
// null-appointment context. note_type stays deliberately BROAD (no whitelist —
// the route maps loose nursing UI codes to a canonical type only at finalize).
d('note_drafts input validation (deep)', () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  // Helper: assert an async call rejects with an AppError of the given
  // HTTP status + machine code (exact, not a range).
  async function expectAppError(fn, statusCode, code) {
    let thrown = null;
    try {
      await fn();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect(thrown.name).toBe('AppError');
    expect(thrown.statusCode).toBe(statusCode);
    expect(thrown.code).toBe(code);
  }

  describe('malformed appointment_id is rejected (not silently nulled)', () => {
    it.each(['not-a-number', '12x'])(
      'upsert with appointment_id=%p → 400 NOTE_DRAFT_APPOINTMENT_INVALID',
      async (bad) => {
        await expectAppError(
          () => upsertNoteDraft({
            tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID,
            appointmentId: bad, noteType: NOTE_TYPE, content: { chief: 'x' },
          }),
          400,
          'NOTE_DRAFT_APPOINTMENT_INVALID',
        );
        // and it did NOT collapse into a null-appointment draft row
        expect(await draftCount('appointment_id IS NULL')).toBe(0);
      },
    );

    it('normAppointmentId is shared — GET with a malformed appointment_id also rejects', async () => {
      await expectAppError(
        () => getNoteDraft({
          tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID,
          appointmentId: 'not-a-number', noteType: NOTE_TYPE,
        }),
        400,
        'NOTE_DRAFT_APPOINTMENT_INVALID',
      );
    });

    it('normAppointmentId is shared — DELETE with a malformed appointment_id also rejects', async () => {
      await expectAppError(
        () => deleteNoteDraft({
          tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID,
          appointmentId: '12x', noteType: NOTE_TYPE,
        }),
        400,
        'NOTE_DRAFT_APPOINTMENT_INVALID',
      );
    });

    it('a zero / non-positive appointment_id is rejected (0 is the COALESCE sentinel)', async () => {
      await expectAppError(
        () => upsertNoteDraft({
          tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID,
          appointmentId: 0, noteType: NOTE_TYPE, content: { chief: 'x' },
        }),
        400,
        'NOTE_DRAFT_APPOINTMENT_INVALID',
      );
    });

    // int4 UPPER-bound guard. A numeric-but-out-of-range appointment_id
    // (> 2147483647) parses to a positive integer and used to pass validation,
    // reach the `$4::int` bind, and fail at Postgres with 22003 (numeric out of
    // range) — surfacing as a 500 AND incrementing note_draft_save_errors_total
    // (whose HELP scopes it to UNEXPECTED DB/write failures). An out-of-range
    // client input is a deliberate client fault of exactly the class this
    // validator rejects with a 400, so it must be a 400 (client fault) and must
    // NOT touch the save-error counter. Because normAppointmentId runs BEFORE the
    // counted DB-write try-block, the pre-DB throw guarantees both.
    it.each([3000000000, '3000000000', 2147483648])(
      'upsert with an out-of-range appointment_id=%p → 400 NOTE_DRAFT_APPOINTMENT_INVALID (int4 upper bound), no 500 / 22003',
      async (bad) => {
        const before = counterValue('note_draft_save_errors_total');
        await expectAppError(
          () => upsertNoteDraft({
            tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID,
            appointmentId: bad, noteType: NOTE_TYPE, content: { chief: 'x' },
          }),
          400,
          'NOTE_DRAFT_APPOINTMENT_INVALID',
        );
        // Pre-DB throw ⇒ the save-error counter is untouched (delta 0) — the
        // out-of-range input never reaches the counted DB write.
        expect(counterValue('note_draft_save_errors_total') - before).toBe(0);
        // and it did NOT collapse into a null-appointment draft row either
        expect(await draftCount('appointment_id IS NULL')).toBe(0);
      },
    );

    it('the int4 max itself (2147483647) is a VALID appointment_id → accepted', async () => {
      const row = await upsertNoteDraft({
        tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID,
        appointmentId: 2147483647, noteType: NOTE_TYPE, content: { chief: 'edge' },
      });
      expect(row?.id).toBeTruthy();
      expect(await draftCount('appointment_id = 2147483647')).toBe(1);
    });
  });

  describe('content must be a plain JSON object', () => {
    it('content as an ARRAY → 400 NOTE_DRAFT_CONTENT_INVALID', async () => {
      await expectAppError(
        () => upsertNoteDraft({
          tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID,
          appointmentId: null, noteType: NOTE_TYPE, content: ['a', 'b'],
        }),
        400,
        'NOTE_DRAFT_CONTENT_INVALID',
      );
    });

    it('content as a scalar string → 400 NOTE_DRAFT_CONTENT_INVALID', async () => {
      await expectAppError(
        () => upsertNoteDraft({
          tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID,
          appointmentId: null, noteType: NOTE_TYPE, content: 'just a string',
        }),
        400,
        'NOTE_DRAFT_CONTENT_INVALID',
      );
    });

    it('content as a scalar number → 400 NOTE_DRAFT_CONTENT_INVALID', async () => {
      await expectAppError(
        () => upsertNoteDraft({
          tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID,
          appointmentId: null, noteType: NOTE_TYPE, content: 42,
        }),
        400,
        'NOTE_DRAFT_CONTENT_INVALID',
      );
    });
  });

  describe('serialized-size cap', () => {
    it('content whose JSON.stringify exceeds ~256 KB → 400 NOTE_DRAFT_CONTENT_TOO_LARGE', async () => {
      const big = { body: 'x'.repeat(300 * 1024) }; // > 256 KB serialized
      await expectAppError(
        () => upsertNoteDraft({
          tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID,
          appointmentId: null, noteType: NOTE_TYPE, content: big,
        }),
        400,
        'NOTE_DRAFT_CONTENT_TOO_LARGE',
      );
      // rejected BEFORE the DB upsert — no row written
      expect(await draftCount('appointment_id IS NULL')).toBe(0);
    });
  });

  describe('legitimate drafts still pass (no over-tightening)', () => {
    it('valid object content + appointment_id null → OK', async () => {
      const row = await upsertNoteDraft({
        tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID,
        appointmentId: null, noteType: NOTE_TYPE, content: { chief: 'ok' },
      });
      expect(row?.id).toBeTruthy();
    });

    it('valid object content + a valid integer appointment_id (and numeric string) → OK', async () => {
      const rowInt = await upsertNoteDraft({
        tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID,
        appointmentId: 4242, noteType: NOTE_TYPE, content: { chief: 'ok' },
      });
      expect(rowInt?.id).toBeTruthy();
      expect(await draftCount('appointment_id = 4242')).toBe(1);

      const rowStr = await upsertNoteDraft({
        tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID,
        appointmentId: '4343', noteType: NOTE_TYPE, content: { chief: 'ok' },
      });
      expect(rowStr?.id).toBeTruthy();
      expect(await draftCount('appointment_id = 4343')).toBe(1);
    });

    it('a JSON-string content that parses to an object → OK (parsed, not rejected)', async () => {
      const row = await upsertNoteDraft({
        tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID,
        appointmentId: 5151, noteType: NOTE_TYPE, content: '{"chief":"parsed"}',
      });
      expect(row?.id).toBeTruthy();
      const loaded = await getNoteDraft({
        tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID,
        appointmentId: 5151, noteType: NOTE_TYPE,
      });
      expect(loaded.content).toEqual({ chief: 'parsed' });
    });

    it('a LOOSE note_type (e.g. "shift handover") is STILL accepted — no whitelist', async () => {
      const row = await upsertNoteDraft({
        tenantId: TENANT, authorUid: AUTHOR_A, patientUid: PATIENT_UID,
        appointmentId: null, noteType: 'shift handover', content: { note: 'in progress' },
      });
      expect(row?.id).toBeTruthy();
      expect(await draftCount("note_type = 'shift handover'")).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Finalize-clear parity across the write path — createNote already clears the
// matching draft post-commit; updateNote + signNote must do the same
// (defense-in-depth). A draft created AFTER the first save would otherwise be
// orphaned until the 14-day TTL janitor. These cases seed a real note via
// createNote, drop a FRESH draft for the same (author, patient, appointment,
// note_type) context, then finalize via updateNote / signNote and assert the
// draft is gone — while proving the finalize still succeeds when no draft
// exists (best-effort) and never touches an UNRELATED context's draft.
const FT_TENANT = '00000000-0000-4000-8000-000000000001';
const FT_PATIENT_UID = 'd2a70000-0000-4000-8000-00000000f101';
const FT_DOCTOR_UID = 'd2a70000-0000-4000-8000-00000000f1d1';
const FT_ADMIN_UID = 'd2a70000-0000-4000-8000-00000000f1a9';
const FT_PATIENT_PHONE = '+919000900101';
const FT_DOCTOR_PHONE = '+919000900102';
const FT_NOTE_TYPE = 'op_consultation';
const FT_CONTENT = {
  chief_complaint: 'Cough x3 days',
  history: 'No fever',
  examination: 'Chest clear',
  diagnosis: 'URTI',
  plan: 'Rest, fluids',
};

async function ftSeedUser(uid, phone, role, name) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid, $2, $3, $4, true, NOW()) RETURNING id`,
    uid, phone, name, role,
  );
  return rows[0].id;
}

// doctor_id is intentionally NULL so the assigned-clinician guard is a no-op —
// the note author (the doctor) may still create/revise the unsigned OP note.
async function ftSeedAppointment(patientId, status) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO appointments
       (uid, phone, patient_id, doctor_id, appointment_date, appointment_time,
        status, department, tenant_id, updated_at)
     VALUES (gen_random_uuid(), $1, $2::int, NULL, CURRENT_DATE, '10:00',
             $3, 'General Medicine', $4::uuid, NOW())
     RETURNING id`,
    FT_PATIENT_PHONE, patientId, status, FT_TENANT,
  );
  return rows[0].id;
}

async function ftDraftCount(predicate, ...params) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM note_drafts WHERE patient_uid = $1::uuid AND ${predicate}`,
    FT_PATIENT_UID,
    ...params,
  );
  return Number(rows[0]?.n ?? 0);
}

async function ftCleanup() {
  await prisma.$executeRawUnsafe(
    'DELETE FROM note_drafts WHERE patient_uid = $1::uuid', FT_PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    'DELETE FROM clinical_notes WHERE patient_uid = $1::uuid', FT_PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    'DELETE FROM appointments WHERE phone = $1', FT_PATIENT_PHONE,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    'DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)',
    FT_PATIENT_UID, FT_DOCTOR_UID, FT_ADMIN_UID,
  ).catch(() => {});
}

d('finalize clears the matching draft on updateNote + signNote (deep)', () => {
  let patientId;

  beforeAll(async () => {
    await ftCleanup();
    patientId = await ftSeedUser(FT_PATIENT_UID, FT_PATIENT_PHONE, 'PATIENT', 'FT Patient');
    await ftSeedUser(FT_DOCTOR_UID, FT_DOCTOR_PHONE, 'DOCTOR', 'FT Doctor');
    await ftSeedUser(FT_ADMIN_UID, '+919000900103', 'SUPER_ADMIN', 'FT Admin');
  });

  afterAll(async () => {
    await ftCleanup();
    await prisma.$disconnect();
  });

  // Fresh note per test so the OP one-note-per-appointment guard never fires
  // across cases. Returns the created note id + its appointment id.
  async function createOpNote() {
    const apptId = await ftSeedAppointment(patientId, 'CONFIRMED');
    const note = await createNote({
      appointment_id: apptId,
      patient_uid: FT_PATIENT_UID,
      author_uid: FT_DOCTOR_UID,
      author_role: 'DOCTOR',
      note_type: FT_NOTE_TYPE,
      content: FT_CONTENT,
      tenant_id: FT_TENANT,
    });
    return { noteId: note.id, apptId };
  }

  it('updateNote clears the matching draft (created after the first save)', async () => {
    const { noteId, apptId } = await createOpNote();
    // A draft the clinician kept typing into after the note was first saved.
    await upsertNoteDraft({
      tenantId: FT_TENANT, authorUid: FT_DOCTOR_UID, patientUid: FT_PATIENT_UID,
      appointmentId: apptId, noteType: FT_NOTE_TYPE, content: { chief_complaint: 'still typing' },
    });
    expect(await ftDraftCount('appointment_id = $2::int', apptId)).toBe(1);

    await updateNote(
      noteId,
      { ...FT_CONTENT, plan: 'Rest, fluids, review in 3 days' },
      FT_DOCTOR_UID,
      'DOCTOR',
      { uid: FT_DOCTOR_UID, role: 'DOCTOR' },
      FT_TENANT,
    );

    expect(await ftDraftCount('appointment_id = $2::int', apptId)).toBe(0);
  });

  it('signNote clears the matching draft (created after the first save)', async () => {
    const { noteId, apptId } = await createOpNote();
    await upsertNoteDraft({
      tenantId: FT_TENANT, authorUid: FT_DOCTOR_UID, patientUid: FT_PATIENT_UID,
      appointmentId: apptId, noteType: FT_NOTE_TYPE, content: { chief_complaint: 'still typing' },
    });
    expect(await ftDraftCount('appointment_id = $2::int', apptId)).toBe(1);

    await signNote(noteId, FT_DOCTOR_UID, { uid: FT_DOCTOR_UID, role: 'DOCTOR' }, FT_TENANT);

    expect(await ftDraftCount('appointment_id = $2::int', apptId)).toBe(0);
  });

  it('updateNote still succeeds when NO draft exists (best-effort clear never blocks)', async () => {
    const { noteId, apptId } = await createOpNote();
    // createNote already cleared any draft for this context; none exists now.
    expect(await ftDraftCount('appointment_id = $2::int', apptId)).toBe(0);

    const updated = await updateNote(
      noteId,
      { ...FT_CONTENT, plan: 'Updated plan' },
      FT_DOCTOR_UID,
      'DOCTOR',
      { uid: FT_DOCTOR_UID, role: 'DOCTOR' },
      FT_TENANT,
    );
    expect(String(updated.id)).toBe(String(noteId));
    expect(updated.version).toBe(2); // rewrite bumped the version → finalize succeeded
  });

  it('signNote still succeeds when NO draft exists (best-effort clear never blocks)', async () => {
    const { noteId, apptId } = await createOpNote();
    expect(await ftDraftCount('appointment_id = $2::int', apptId)).toBe(0);

    const signed = await signNote(noteId, FT_DOCTOR_UID, { uid: FT_DOCTOR_UID, role: 'DOCTOR' }, FT_TENANT);
    expect(signed.is_signed).toBe(true);
  });

  it('finalize does NOT delete an UNRELATED draft (different note_type context)', async () => {
    const { noteId, apptId } = await createOpNote();
    // A draft for the SAME author/patient/appointment but a DIFFERENT note_type —
    // must survive the op_consultation finalize (context-scoped delete).
    await upsertNoteDraft({
      tenantId: FT_TENANT, authorUid: FT_DOCTOR_UID, patientUid: FT_PATIENT_UID,
      appointmentId: apptId, noteType: 'progress', content: { summary: 'unrelated draft' },
    });
    expect(await ftDraftCount("note_type = 'progress'")).toBe(1);

    await signNote(noteId, FT_DOCTOR_UID, { uid: FT_DOCTOR_UID, role: 'DOCTOR' }, FT_TENANT);

    // The unrelated 'progress' draft is untouched.
    expect(await ftDraftCount("note_type = 'progress'")).toBe(1);
  });
});
