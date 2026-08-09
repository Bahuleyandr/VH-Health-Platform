// A-M2 (Phase-3 Medium) — the LEGACY discharge-summary path
// (dischargeSummaryGenerator save/sign over clinical_notes, the D2-cascade
// path the staff-app discharge hub uses) wrote the event_outbox row and the
// legacy audit_logs row but ZERO canonical rows, so a saved/signed discharge
// summary was invisible to the canonical patient timeline
// (docs/CANONICAL_CLINICAL_TIMELINE.md invariant).
//
// Proven here against the real dischargeSummaryGenerator + real QA DB:
//   1. saveDischargeSummary writes the draft note AND one
//      clinical_timeline_events + one clinical_audit_events row in the SAME tx.
//   2. A second save emits a NEW canonical pair (amendable fingerprint + :tx:
//      keys — a fixed key would silently absorb the re-save).
//   3. A forced canonical-emit failure ROLLS THE SAVE BACK — no draft note, no
//      outbox row, no canonical rows (the timeline pair is required, not
//      best-effort).
//   4. signDischargeSummary flips is_signed AND writes the signed canonical
//      pair in the same tx (insert-once fixed keys).
//   5. A forced canonical-emit failure on sign ROLLS THE SIGNATURE BACK — the
//      note stays unsigned, summary_signed_at stays null, no signed canonical
//      rows survive.
//
// Self-isolating fixtures (unique tenant + patient + author + admission).

import { jest } from '@jest/globals';
import { randomUUID } from 'crypto';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

// Force the IN-TX canonical emit to throw on demand; delegate to the real
// implementation otherwise. Mock must register BEFORE the service imports it.
const ctl = { forceCanonicalFail: false };
const actualCanonical = await import('../services/clinical/canonicalClinicalPlatformService.js');
jest.unstable_mockModule('../services/clinical/canonicalClinicalPlatformService.js', () => ({
  ...actualCanonical,
  recordCanonicalClinicalEvent: async (...args) => {
    if (ctl.forceCanonicalFail) throw new Error('forced canonical emit failure (test)');
    return actualCanonical.recordCanonicalClinicalEvent(...args);
  },
}));

const prisma = (await import('../lib/prisma.js')).default;
const generator = await import('../services/emr/dischargeSummaryGenerator.js');

const TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const DOCTOR_UID = randomUUID();
const ENCOUNTER_ID = randomUUID();
const PATIENT_PHONE = `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const DOCTOR_PHONE = `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

const SUMMARY = { diagnosis: 'CAP, resolved', course: 'Uneventful recovery on oral antibiotics.' };

let admissionId = null;

async function draftNoteRows() {
  return prisma.$queryRawUnsafe(
    `SELECT id, is_signed FROM clinical_notes
      WHERE encounter_id = $1::uuid AND note_type = 'discharge' AND is_addendum = false`,
    ENCOUNTER_ID,
  );
}
async function timelineEvents(eventType) {
  return prisma.$queryRawUnsafe(
    `SELECT id, event_type, event_status, source_table, source_id, patient_uid, tenant_id, idempotency_key
       FROM clinical_timeline_events
      WHERE patient_uid = $1::uuid AND event_type = $2
      ORDER BY id`,
    PATIENT_UID, eventType,
  );
}
async function auditEvents(action) {
  return prisma.$queryRawUnsafe(
    `SELECT id, action, resource_table, resource_id, idempotency_key
       FROM clinical_audit_events
      WHERE patient_uid = $1::uuid AND action = $2
      ORDER BY id`,
    PATIENT_UID, action,
  );
}
async function outboxRows(eventType) {
  return prisma.$queryRawUnsafe(
    `SELECT id FROM event_outbox WHERE tenant_id = $1::uuid AND event_type = $2`,
    TENANT_ID, eventType,
  );
}
async function admissionRow() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, summary_signed_at FROM admissions WHERE id = $1`, admissionId,
  );
  return rows[0];
}

async function cleanupPerTest() {
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM event_outbox WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_notes WHERE encounter_id = $1::uuid`, ENCOUNTER_ID).catch(() => {});
  if (admissionId) {
    await prisma.$executeRawUnsafe(
      `UPDATE admissions SET summary_signed_at = NULL, summary_first_edit_at = NULL WHERE id = $1`,
      admissionId,
    ).catch(() => {});
  }
}
async function cleanup() {
  await cleanupPerTest();
  await prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE uid = $1::uuid`, DOCTOR_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_ID).catch(() => {});
}

d('Legacy discharge summary save/sign → canonical timeline+audit pair (A-M2)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, 'Discharge Canonical Generator Tenant')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_ID, `disch-gen-canon-${TENANT_ID.slice(0, 8)}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Discharge Canon Patient', 'PATIENT', true, $3::uuid, NOW())`,
      PATIENT_UID, PATIENT_PHONE, TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Dr Canon Generator', 'DOCTOR', true, $3::uuid, NOW())`,
      DOCTOR_UID, DOCTOR_PHONE, TENANT_ID,
    );
    const adm = await prisma.$queryRawUnsafe(
      `INSERT INTO admissions (tenant_id, patient_uid, encounter_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid) RETURNING id`,
      TENANT_ID, PATIENT_UID, ENCOUNTER_ID,
    );
    admissionId = adm[0].id;
  }, 60_000);

  beforeEach(async () => {
    // Fresh: no draft note, no canonical/outbox rows, admission stamps reset,
    // so the save path takes the CREATE branch and counts start from zero.
    await cleanupPerTest();
  });

  afterEach(() => {
    ctl.forceCanonicalFail = false;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('saveDischargeSummary writes the draft note AND exactly one canonical timeline+audit pair in one tx', async () => {
    const result = await generator.saveDischargeSummary(admissionId, SUMMARY, DOCTOR_UID, 'DOCTOR', TENANT_ID);
    expect(result.action).toBe('created');

    const tl = await timelineEvents('discharge_summary.saved');
    expect(tl).toHaveLength(1);
    expect(tl[0].source_table).toBe('clinical_notes');
    expect(String(tl[0].source_id)).toBe(String(result.noteId));
    expect(String(tl[0].patient_uid)).toBe(PATIENT_UID);
    expect(String(tl[0].tenant_id)).toBe(TENANT_ID);
    expect(tl[0].event_status).toBe('draft');

    const au = await auditEvents('discharge_summary.saved');
    expect(au).toHaveLength(1);
    expect(au[0].resource_table).toBe('clinical_notes');
    expect(String(au[0].resource_id)).toBe(String(result.noteId));
  }, 30_000);

  it('a second save emits a NEW canonical pair (amendable fingerprint + :tx: keys, not absorbed)', async () => {
    const first = await generator.saveDischargeSummary(admissionId, SUMMARY, DOCTOR_UID, 'DOCTOR', TENANT_ID);
    expect(first.action).toBe('created');
    const second = await generator.saveDischargeSummary(
      admissionId, { ...SUMMARY, course: 'Amended course.' }, DOCTOR_UID, 'DOCTOR', TENANT_ID,
    );
    expect(second.action).toBe('updated');
    expect(String(second.noteId)).toBe(String(first.noteId));

    const tl = await timelineEvents('discharge_summary.saved');
    expect(tl).toHaveLength(2);
    expect(tl[0].idempotency_key).not.toBe(tl[1].idempotency_key);
    const au = await auditEvents('discharge_summary.saved');
    expect(au).toHaveLength(2);
    expect(au[0].idempotency_key).not.toBe(au[1].idempotency_key);
  }, 30_000);

  it('a failing IN-TX canonical emit rolls the save back (no note, no outbox row, no canonical rows)', async () => {
    ctl.forceCanonicalFail = true;
    await expect(generator.saveDischargeSummary(admissionId, SUMMARY, DOCTOR_UID, 'DOCTOR', TENANT_ID))
      .rejects.toThrow(/forced canonical emit failure/);

    expect(await draftNoteRows()).toHaveLength(0);
    expect(await outboxRows('clinical_document.discharge_summary.saved')).toHaveLength(0);
    expect(await timelineEvents('discharge_summary.saved')).toHaveLength(0);
    expect(await auditEvents('discharge_summary.saved')).toHaveLength(0);
  }, 30_000);

  it('signDischargeSummary flips is_signed AND writes exactly one signed canonical pair in one tx', async () => {
    const saved = await generator.saveDischargeSummary(admissionId, SUMMARY, DOCTOR_UID, 'DOCTOR', TENANT_ID);
    const signed = await generator.signDischargeSummary(admissionId, DOCTOR_UID, TENANT_ID);
    expect(signed.signed).toBe(true);
    expect(String(signed.noteId)).toBe(String(saved.noteId));

    const notes = await draftNoteRows();
    expect(notes).toHaveLength(1);
    expect(notes[0].is_signed).toBe(true);

    const tl = await timelineEvents('discharge_summary.signed');
    expect(tl).toHaveLength(1);
    expect(tl[0].source_table).toBe('clinical_notes');
    expect(String(tl[0].source_id)).toBe(String(saved.noteId));
    expect(tl[0].event_status).toBe('signed');
    expect(tl[0].idempotency_key).toBe(`clinical_notes:${saved.noteId}:discharge_summary_signed`);

    const au = await auditEvents('discharge_summary.signed');
    expect(au).toHaveLength(1);
    expect(String(au[0].resource_id)).toBe(String(saved.noteId));

    const adm = await admissionRow();
    expect(adm.summary_signed_at).not.toBeNull();
  }, 30_000);

  it('a failing IN-TX canonical emit rolls the signature back (note unsigned, no stamp, no signed canonical rows)', async () => {
    const saved = await generator.saveDischargeSummary(admissionId, SUMMARY, DOCTOR_UID, 'DOCTOR', TENANT_ID);
    expect(saved.noteId).toBeTruthy();

    ctl.forceCanonicalFail = true;
    await expect(generator.signDischargeSummary(admissionId, DOCTOR_UID, TENANT_ID))
      .rejects.toThrow(/forced canonical emit failure/);

    const notes = await draftNoteRows();
    expect(notes).toHaveLength(1);
    expect(notes[0].is_signed).toBe(false);
    expect(await outboxRows('clinical_document.discharge_summary.signed')).toHaveLength(0);
    expect(await timelineEvents('discharge_summary.signed')).toHaveLength(0);
    expect(await auditEvents('discharge_summary.signed')).toHaveLength(0);

    const adm = await admissionRow();
    expect(adm.summary_signed_at).toBeNull();
  }, 30_000);
});
