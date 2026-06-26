// Audit A2 (event-outbox) — signing a discharge summary
// (dischargeSummaryGenerator.signDischargeSummary, the clinical_notes path) is a
// SAFETY/medico-legal-critical state event (records release, billing, ABDM push
// all key off clinical_document.discharge_summary.signed). The event_outbox row
// is now written INSIDE the sign $transaction (was post-commit best-effort, so a
// crash between COMMIT and the publish dropped the signed event).
//
// Proven here against the real dischargeSummaryGenerator + real QA DB:
//   1. signDischargeSummary flips clinical_notes.is_signed AND writes the
//      clinical_document.discharge_summary.signed event_outbox row in one tx; the
//      outbox row carries the correct tenant_id + aggregate (note) linkage.
//   2. A forced IN-TX outbox-publish failure ROLLS THE SIGNATURE BACK — the note
//      stays unsigned and NO outbox row survives (the distinguishing guarantee:
//      pre-fix the publish was post-commit and could not undo the signature).
//
// Self-isolating fixtures (unique tenant + patient + admission + draft note).

import { jest } from '@jest/globals';
import { randomUUID } from 'crypto';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

// Force the IN-TX outbox publish to throw on demand; delegate to the real
// implementation otherwise. Mock must register BEFORE the service imports it.
const ctl = { forceOutboxFail: false };
const actualOutbox = await import('../services/events/eventOutboxService.js');
jest.unstable_mockModule('../services/events/eventOutboxService.js', () => ({
  ...actualOutbox,
  publishEvent: async (...args) => {
    if (ctl.forceOutboxFail) throw new Error('forced outbox publish failure (test)');
    return actualOutbox.publishEvent(...args);
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

let admissionId = null;
let noteId = null;

async function noteRow() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, is_signed FROM clinical_notes WHERE id = $1`, noteId,
  );
  return rows[0];
}
async function signedOutboxRows() {
  return prisma.$queryRawUnsafe(
    `SELECT id, event_type, aggregate_type, aggregate_id, tenant_id
       FROM event_outbox
      WHERE tenant_id = $1::uuid AND event_type = 'clinical_document.discharge_summary.signed'`,
    TENANT_ID,
  );
}

async function seedDraftNote() {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_notes
       (tenant_id, encounter_id, patient_uid, author_uid, author_role, note_type,
        title, content, version, is_addendum, is_signed)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'DOCTOR', 'discharge',
        'Draft discharge summary', $5::jsonb, 1, false, false)
     RETURNING id`,
    TENANT_ID, ENCOUNTER_ID, PATIENT_UID, DOCTOR_UID,
    JSON.stringify({ is_signed: false, diagnosis: 'CAP, resolved' }),
  );
  return rows[0].id;
}

async function cleanupNotesAndOutbox() {
  await prisma.$executeRawUnsafe(`DELETE FROM event_outbox WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_notes WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
}
async function cleanup() {
  await cleanupNotesAndOutbox();
  await prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE uid = $1::uuid`, DOCTOR_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_ID).catch(() => {});
}

d('Discharge sign → event_outbox atomicity (audit A2)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, 'Discharge Sign Outbox Tenant')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_ID, `disch-sign-${TENANT_ID.slice(0, 8)}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Discharge Sign Patient', 'PATIENT', true, $3::uuid, NOW())`,
      PATIENT_UID, PATIENT_PHONE, TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Dr Sign Test', 'DOCTOR', true, $3::uuid, NOW())`,
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
    // Fresh draft note + clean outbox per test so the sign path has an unsigned
    // target and assertions are not polluted by a prior run.
    await cleanupNotesAndOutbox();
    noteId = await seedDraftNote();
  });

  afterEach(() => {
    ctl.forceOutboxFail = false;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('signDischargeSummary flips is_signed AND writes the signed event_outbox row in one tx', async () => {
    const result = await generator.signDischargeSummary(admissionId, DOCTOR_UID, TENANT_ID);
    expect(String(result.noteId)).toBe(String(noteId));

    expect((await noteRow()).is_signed).toBe(true);

    const outbox = await signedOutboxRows();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].aggregate_type).toBe('clinical_note');
    expect(String(outbox[0].aggregate_id)).toBe(String(noteId));
    expect(String(outbox[0].tenant_id)).toBe(TENANT_ID);
  }, 30_000);

  it('A2: a failing IN-TX outbox publish rolls the signature back (note stays unsigned, no outbox row)', async () => {
    ctl.forceOutboxFail = true;
    await expect(generator.signDischargeSummary(admissionId, DOCTOR_UID, TENANT_ID))
      .rejects.toThrow(/forced outbox publish failure/);

    // The is_signed flip + ai-generation status + audit log must all roll back
    // with the failed in-tx publish.
    expect((await noteRow()).is_signed).toBe(false);
    expect(await signedOutboxRows()).toHaveLength(0);
  }, 30_000);
});
