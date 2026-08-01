// ABDM consent-scope clamp (#1).
//
// handleDataRequest previously passed the REQUEST's hiTypes / dateRange straight
// through (the granted consent was only a fallback when the request omitted a
// field), so a misbehaving / over-broad HIU could pull data TYPES or a DATE
// RANGE the patient never consented to. The fix clamps the request to the
// grant: HI types are intersected with the grant's set, and the window is
// clamped to the grant's [from, to]. This proves an over-broad request is
// narrowed to the consented scope before it is persisted / processed.
//
// Needs the test Postgres (DATABASE_URL / TEST_DATABASE_URL, default
// 127.0.0.1:55432 db vhhealth_test). Self-skips when unconfigured.

import prisma from '../lib/prisma.js';
import abdmService from '../services/abdm/abdmService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const PATIENT_UID = 'a1b40000-0000-4000-8000-0000000001a1';
const PATIENT_PHONE = '+919000010101';
const CONSENT_ID = 'a1b40000-0000-4000-8000-0000000001c1';
const TXN_ID = 'a1b40000-0000-4000-8000-0000000001f1';

// Grant: only Prescription, window Jan 10–20 2026.
const GRANT_FROM = '2026-01-10';
const GRANT_TO = '2026-01-20';
// Request asks for MORE: an extra HI type + a wider window.
const REQ_FROM = '2026-01-01';
const REQ_TO = '2026-01-31';

async function cleanup() {
  await prisma.$executeRawUnsafe(`DELETE FROM abdm_data_requests WHERE transaction_id = $1`, TXN_ID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM abdm_consents WHERE consent_id = $1`, CONSENT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT_UID).catch(() => {});
}

d('ABDM consent-scope clamp (#1)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'ABDM Clamp Patient', 'PATIENT', true, NOW())`,
      PATIENT_UID, PATIENT_PHONE,
    );
    // Expiry must stay ahead of the run date: handleDataRequest hard-expires
    // the consent (CONSENT_EXPIRED) once expiry_date < NOW(), so a fixed
    // calendar expiry would flip this suite red when real time crossed it.
    await prisma.$queryRawUnsafe(
      `INSERT INTO abdm_consents
         (consent_id, patient_uid, hip_id, hiu_id, purpose, hi_types,
          date_range_from, date_range_to, expiry_date, status, requester_name, created_at)
       VALUES ($1, $2::uuid, 'HIP-TEST', 'HIU-TEST', 'CAREMGT', $3,
               $4::date, $5::date, (NOW() + interval '365 days')::date, 'GRANTED', 'Test HIU', NOW())`,
      CONSENT_ID, PATIENT_UID, ['Prescription'], GRANT_FROM, GRANT_TO,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('clamps an over-broad request to the granted HI types + date window', async () => {
    await abdmService.handleDataRequest({
      transactionId: TXN_ID,
      consentId: CONSENT_ID,
      hiTypes: ['Prescription', 'DiagnosticReport'], // DiagnosticReport NOT granted
      dateRange: { from: REQ_FROM, to: REQ_TO }, // wider than the grant
      keyMaterial: null,
      dataPushUrl: null,
    });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT hi_types, date_range_from, date_range_to
         FROM abdm_data_requests WHERE transaction_id = $1 LIMIT 1`,
      TXN_ID,
    );
    expect(rows.length).toBe(1);
    const persisted = rows[0];

    // HI types narrowed to the consented intersection — the non-consented
    // DiagnosticReport is dropped.
    const hiTypes = Array.isArray(persisted.hi_types) ? persisted.hi_types : [];
    expect(hiTypes).toEqual(['Prescription']);

    // Date window clamped INWARD to the grant: start no earlier than the
    // request's wider start, end no later than the request's wider end.
    expect(new Date(persisted.date_range_from).getTime())
      .toBeGreaterThan(new Date(REQ_FROM).getTime());
    expect(new Date(persisted.date_range_to).getTime())
      .toBeLessThan(new Date(REQ_TO).getTime());
  });
});
