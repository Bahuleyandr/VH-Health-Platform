// ambientAudioRetention.deep.test.js
//
// Verifies that purgeExpiredAmbientAudio() only deletes rows whose
// retention_until < CURRENT_DATE across all three ambient audio tables:
//   • clinical_ambient_encounters     (migration 027, 30-day default)
//   • clinical_voice_notes             (migration 016, 30-day default)
//   • clinical_nursing_ambient_sessions (migration 042, 365-day default)
//
// Seeds one expired row + one live row per table, calls the purge function,
// then asserts:
//   - expired rows are gone (count = 0)
//   - live rows are untouched (count = 1)
//   - returned counts match actual deletes
//
// Requires the QA Postgres at 127.0.0.1:55432 (DATABASE_URL / TEST_DATABASE_URL).
// Self-skips when the DB is not configured.

import { purgeExpiredAmbientAudio } from '../services/ai/ambientDocumentationService.js';

const prisma = (await import('../lib/prisma.js')).default;

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'd2a70000-0000-4000-8000-00000000abe1';

// Helpers -------------------------------------------------------------------

async function rowCount(table, whereExtra = '') {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE patient_uid = $1::uuid${whereExtra}`,
    PATIENT_UID,
  );
  return Number(rows[0]?.n ?? 0);
}

async function cleanupAll() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_ambient_encounters WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_voice_notes WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_nursing_ambient_sessions WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
}

// ---------------------------------------------------------------------------

d('purgeExpiredAmbientAudio (deep)', () => {
  beforeAll(cleanupAll);
  afterAll(cleanupAll);

  it('deletes only past-retention_until rows from clinical_ambient_encounters', async () => {
    // expired: retention_until yesterday
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_ambient_encounters
         (tenant_id, patient_uid, recording_started_at, stt_provider, retention_until)
       VALUES ($1::uuid, $2::uuid, NOW(), 'none', CURRENT_DATE - INTERVAL '1 day')`,
      TENANT, PATIENT_UID,
    );
    // live: retention_until tomorrow (default = +30 days, force tomorrow for clarity)
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_ambient_encounters
         (tenant_id, patient_uid, recording_started_at, stt_provider, retention_until)
       VALUES ($1::uuid, $2::uuid, NOW(), 'none', CURRENT_DATE + INTERVAL '1 day')`,
      TENANT, PATIENT_UID,
    );

    expect(await rowCount('clinical_ambient_encounters')).toBe(2);

    const counts = await purgeExpiredAmbientAudio();

    expect(counts.ambientEncounters).toBe(1);
    expect(await rowCount(
      'clinical_ambient_encounters',
      ' AND retention_until < CURRENT_DATE',
    )).toBe(0); // expired gone
    expect(await rowCount(
      'clinical_ambient_encounters',
      ' AND retention_until >= CURRENT_DATE',
    )).toBe(1); // live kept
  });

  it('deletes only past-retention_until rows from clinical_voice_notes', async () => {
    // expired
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_voice_notes
         (tenant_id, patient_uid, stt_provider, retention_until)
       VALUES ($1::uuid, $2::uuid, 'none', CURRENT_DATE - INTERVAL '1 day')`,
      TENANT, PATIENT_UID,
    );
    // live
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_voice_notes
         (tenant_id, patient_uid, stt_provider, retention_until)
       VALUES ($1::uuid, $2::uuid, 'none', CURRENT_DATE + INTERVAL '1 day')`,
      TENANT, PATIENT_UID,
    );

    expect(await rowCount('clinical_voice_notes')).toBe(2);

    const counts = await purgeExpiredAmbientAudio();

    expect(counts.voiceNotes).toBe(1);
    expect(await rowCount(
      'clinical_voice_notes',
      ' AND retention_until < CURRENT_DATE',
    )).toBe(0);
    expect(await rowCount(
      'clinical_voice_notes',
      ' AND retention_until >= CURRENT_DATE',
    )).toBe(1);
  });

  it('deletes only past-retention_until rows from clinical_nursing_ambient_sessions', async () => {
    // expired
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_nursing_ambient_sessions
         (tenant_id, patient_uid, recording_started_at, stt_provider, retention_until)
       VALUES ($1::uuid, $2::uuid, NOW(), 'none', CURRENT_DATE - INTERVAL '1 day')`,
      TENANT, PATIENT_UID,
    );
    // live
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_nursing_ambient_sessions
         (tenant_id, patient_uid, recording_started_at, stt_provider, retention_until)
       VALUES ($1::uuid, $2::uuid, NOW(), 'none', CURRENT_DATE + INTERVAL '1 day')`,
      TENANT, PATIENT_UID,
    );

    expect(await rowCount('clinical_nursing_ambient_sessions')).toBe(2);

    const counts = await purgeExpiredAmbientAudio();

    expect(counts.nursingAmbientSessions).toBe(1);
    expect(await rowCount(
      'clinical_nursing_ambient_sessions',
      ' AND retention_until < CURRENT_DATE',
    )).toBe(0);
    expect(await rowCount(
      'clinical_nursing_ambient_sessions',
      ' AND retention_until >= CURRENT_DATE',
    )).toBe(1);
  });

  it('returns zero counts when nothing is expired (idempotency check)', async () => {
    // Only live rows remain after prior tests
    const counts = await purgeExpiredAmbientAudio();
    expect(counts.ambientEncounters).toBe(0);
    expect(counts.voiceNotes).toBe(0);
    expect(counts.nursingAmbientSessions).toBe(0);
  });
});
