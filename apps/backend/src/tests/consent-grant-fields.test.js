// Regression tests for the Stage-5 consent-capture cluster.
//
// Findings:
//   2026-05-09-inpatient-admission-admission-no-thumbprint-consent-illiterate
//     — POST /consent/grant accepted only consent_type + free-text notes.
//       An illiterate patient's thumbprint/verbal consent had no
//       structured method field and no witness field, leaving the grant
//       medico-legally contestable (NABH requires both on record).
//   2026-05-09-inpatient-admission-admission-no-cmchis-flag-no-tamil-consent
//     — no way to record which language the consent form was presented
//       in. (The translated form *text* is out of scope — that needs
//       legal/translation review.)
//   2026-05-09-surgical-day-care-admission-consent-no-preop-carryover
//     — `procedure` is now a valid consent_type so a pre-op consent can
//       be recorded ahead of the admission day.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const PATIENT_UID = 'a7777777-7777-4777-8777-77777777fe01';
const WITNESS_UID = 'a7777777-7777-4777-8777-77777777fe02';
const PATIENT_PHONE = '9666100001';

function adminClient() {
  const token = generateTestToken('ADMIN');
  return {
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function cleanupFixtures() {
  await prisma
    .$executeRawUnsafe(`DELETE FROM patient_consents WHERE patient_uid = $1::uuid`, PATIENT_UID)
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID,
      WITNESS_UID,
    )
    .catch(() => {});
}

describe('POST /consent/grant — Stage-5 consent method + witness + form language', () => {
  const admin = adminClient();

  beforeAll(async () => {
    await cleanupFixtures();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, $3, 'Consent Test Patient', 'PATIENT', true, NOW()),
         ($2::uuid, '9666100002', 'Consent Test Witness', 'NURSING_STAFF', true, NOW())`,
      PATIENT_UID,
      WITNESS_UID,
      PATIENT_PHONE,
    );
  });

  afterAll(async () => {
    await cleanupFixtures();
    await prisma.$disconnect().catch(() => {});
  });

  it('records a thumbprint consent with witness + form language for an illiterate patient', async () => {
    const res = await admin.post('/api/v1/consent/grant').send({
      patient_uid: PATIENT_UID,
      consent_type: 'treatment',
      consent_method: 'thumbprint',
      witness_name: 'Kamala (spouse)',
      witness_uid: WITNESS_UID,
      form_language: 'ta',
      notes: 'Consent terms read aloud in Tamil; patient affixed left thumb impression.',
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.data).toMatchObject({
      consent_method: 'thumbprint',
      witness_name: 'Kamala (spouse)',
      witness_uid: WITNESS_UID,
      form_language: 'ta',
    });

    const row = await prisma.$queryRawUnsafe(
      `SELECT consent_method, witness_name, witness_uid, form_language
         FROM patient_consents WHERE id = $1`,
      res.body.data.id,
    );
    expect(row[0]).toMatchObject({
      consent_method: 'thumbprint',
      witness_name: 'Kamala (spouse)',
      witness_uid: WITNESS_UID,
      form_language: 'ta',
    });
  });

  it('accepts a pre-op `procedure` consent and defaults consent_method to signature', async () => {
    const res = await admin.post('/api/v1/consent/grant').send({
      patient_uid: PATIENT_UID,
      consent_type: 'procedure',
      purpose: 'Pre-op consent — left eye cataract / phacoemulsification',
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.data.consent_type).toBe('procedure');
    expect(res.body.data.consent_method).toBe('signature');
  });

  it('rejects a thumbprint consent with no witness_name', async () => {
    const res = await admin.post('/api/v1/consent/grant').send({
      patient_uid: PATIENT_UID,
      consent_type: 'general',
      consent_method: 'thumbprint',
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.message || '')).toMatch(/witness_name/i);
  });

  it('rejects an unknown consent_method', async () => {
    const res = await admin.post('/api/v1/consent/grant').send({
      patient_uid: PATIENT_UID,
      consent_type: 'general',
      consent_method: 'fingerprint_scan',
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.message || '')).toMatch(/consent_method/i);
  });

  it('rejects a malformed witness_uid', async () => {
    const res = await admin.post('/api/v1/consent/grant').send({
      patient_uid: PATIENT_UID,
      consent_type: 'general',
      consent_method: 'verbal',
      witness_name: 'Some Witness',
      witness_uid: 'not-a-uuid',
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.message || '')).toMatch(/witness_uid/i);
  });
});
