// Audit A2 (event-outbox) — SAVING a draft discharge summary
// (dischargeSummaryGenerator.saveDischargeSummary, the clinical_notes draft path)
// emits clinical_document.discharge_summary.saved, which downstream efficiency
// dashboards + the canonical clinical timeline key off. The event_outbox row is
// now written INSIDE the save transaction with an explicit tenantId (was
// post-commit best-effort + no tenant, so a crash between COMMIT and the publish
// dropped the saved event, and the row landed on the default-tenant literal).
//
// Proven here against the real dischargeSummaryGenerator + real QA DB:
//   1. saveDischargeSummary creates the draft clinical_notes row AND writes the
//      clinical_document.discharge_summary.saved event_outbox row in one tx; the
//      outbox row carries the correct tenant_id + aggregate (note) linkage.
//   2. A forced IN-TX outbox-publish failure ROLLS THE SAVE BACK — no draft note
//      survives and NO outbox row survives (the distinguishing guarantee: pre-fix
//      the create was committed before the post-commit publish and could not be
//      undone, and the row carried the default tenant, not this admission's).
//
// Self-isolating fixtures (unique tenant + patient + author + admission).

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
const AUTHOR_UID = randomUUID();
const ENCOUNTER_ID = randomUUID();
const PATIENT_PHONE = `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const AUTHOR_PHONE = `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

const SUMMARY = { diagnosis: 'CAP, resolved', course: 'Uneventful recovery on oral antibiotics.' };

let admissionId = null;

async function draftNoteRows() {
  return prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, is_signed FROM clinical_notes
      WHERE encounter_id = $1::uuid AND note_type = 'discharge' AND is_addendum = false`,
    ENCOUNTER_ID,
  );
}
async function savedOutboxRows() {
  return prisma.$queryRawUnsafe(
    `SELECT id, event_type, aggregate_type, aggregate_id, tenant_id
       FROM event_outbox
      WHERE tenant_id = $1::uuid AND event_type = 'clinical_document.discharge_summary.saved'`,
    TENANT_ID,
  );
}

async function cleanupNotesAndOutbox() {
  await prisma.$executeRawUnsafe(`DELETE FROM event_outbox WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_notes WHERE encounter_id = $1::uuid`, ENCOUNTER_ID).catch(() => {});
}
async function cleanup() {
  await cleanupNotesAndOutbox();
  await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, AUTHOR_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_ID).catch(() => {});
}

d('Discharge save → event_outbox atomicity (audit A2)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, 'Discharge Save Outbox Tenant')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_ID, `disch-save-${TENANT_ID.slice(0, 8)}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Discharge Save Patient', 'PATIENT', true, $3::uuid, NOW())`,
      PATIENT_UID, PATIENT_PHONE, TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Dr Save Test', 'DOCTOR', true, $3::uuid, NOW())`,
      AUTHOR_UID, AUTHOR_PHONE, TENANT_ID,
    );
    const adm = await prisma.$queryRawUnsafe(
      `INSERT INTO admissions (tenant_id, patient_uid, encounter_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid) RETURNING id`,
      TENANT_ID, PATIENT_UID, ENCOUNTER_ID,
    );
    admissionId = adm[0].id;
  }, 60_000);

  beforeEach(async () => {
    // Fresh: no draft note + clean outbox per test so the save path takes the
    // CREATE branch and assertions are not polluted by a prior run.
    await cleanupNotesAndOutbox();
  });

  afterEach(() => {
    ctl.forceOutboxFail = false;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('saveDischargeSummary creates the draft note AND writes the saved event_outbox row in one tenant tx', async () => {
    const result = await generator.saveDischargeSummary(admissionId, SUMMARY, AUTHOR_UID, 'DOCTOR', TENANT_ID);
    expect(result.action).toBe('created');

    const notes = await draftNoteRows();
    expect(notes).toHaveLength(1);
    expect(String(notes[0].id)).toBe(String(result.noteId));
    expect(notes[0].is_signed).toBe(false);
    // The draft note is now scoped to the admission's tenant (was the default
    // literal pre-fix because the create ran with no tenant context).
    expect(String(notes[0].tenant_id)).toBe(TENANT_ID);

    const outbox = await savedOutboxRows();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].aggregate_type).toBe('clinical_note');
    expect(String(outbox[0].aggregate_id)).toBe(String(result.noteId));
    expect(String(outbox[0].tenant_id)).toBe(TENANT_ID);
  }, 30_000);

  it('A2: a failing IN-TX outbox publish rolls the save back (no draft note, no outbox row)', async () => {
    ctl.forceOutboxFail = true;
    await expect(generator.saveDischargeSummary(admissionId, SUMMARY, AUTHOR_UID, 'DOCTOR', TENANT_ID))
      .rejects.toThrow(/forced outbox publish failure/);

    // The clinical_notes create must roll back with the failed in-tx publish.
    expect(await draftNoteRows()).toHaveLength(0);
    expect(await savedOutboxRows()).toHaveLength(0);
  }, 30_000);
});
