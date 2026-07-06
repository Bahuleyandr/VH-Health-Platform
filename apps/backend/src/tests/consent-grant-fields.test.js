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
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
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
  const pngSignature = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    'base64',
  );

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

  it('captures consent signature uploads as immutable version rows and audits capture', async () => {
    const grant = await admin.post('/api/v1/consent/grant').send({
      patient_uid: PATIENT_UID,
      consent_type: 'telehealth',
      consent_method: 'signature',
      notes: 'Telehealth signature capture test',
    });
    expect(grant.statusCode).toBe(201);
    const consentId = grant.body.data.id;

    const first = await admin
      .post(`/api/v1/consent/${consentId}/signatures`)
      .field('signature_role', 'patient')
      .field('signer_name', 'Consent Test Patient')
      .attach('file', pngSignature, {
        filename: 'patient-signature.png',
        contentType: 'image/png',
      });
    expect(first.statusCode).toBe(201);
    expect(first.body.data).toMatchObject({
      consent_id: consentId,
      patient_uid: PATIENT_UID,
      signature_role: 'patient',
      version: 1,
      mime_type: 'image/png',
    });

    const second = await admin
      .post(`/api/v1/consent/${consentId}/signatures`)
      .field('signature_role', 'patient')
      .attach('file', pngSignature, {
        filename: 'patient-signature-v2.png',
        contentType: 'image/png',
      });
    expect(second.statusCode).toBe(201);
    expect(second.body.data.version).toBe(2);
    expect(second.body.data.storage_key).not.toBe(first.body.data.storage_key);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT signature_role, version, sha256_hash
         FROM consent_signatures
        WHERE consent_id = $1::int
        ORDER BY version ASC`,
      consentId,
    );
    expect(rows.map((row) => row.version)).toEqual([1, 2]);
    expect(rows.every((row) => row.signature_role === 'patient')).toBe(true);
    expect(rows.every((row) => String(row.sha256_hash || '').length === 64)).toBe(true);

    const audit = await prisma.$queryRawUnsafe(
      `SELECT action, resource, resource_id, metadata
         FROM audit_logs
        WHERE resource = 'patient_consent'
          AND resource_id = $1
          AND action = 'CONSENT_SIGNATURE_CAPTURED'
        ORDER BY id DESC
        LIMIT 1`,
      String(consentId),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({
      consent_id: consentId,
      patient_uid: PATIENT_UID,
      signature_role: 'patient',
      version: 2,
    });

    const pdf = await admin.get(`/api/v1/consent/${consentId}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    expect(pdf.body.slice(0, 4).toString()).toBe('%PDF');
  });

  it('rejects signature uploads whose bytes do not match their image type', async () => {
    const grant = await admin.post('/api/v1/consent/grant').send({
      patient_uid: PATIENT_UID,
      consent_type: 'research',
      consent_method: 'signature',
    });
    expect(grant.statusCode).toBe(201);

    const res = await admin
      .post(`/api/v1/consent/${grant.body.data.id}/signatures`)
      .field('signature_role', 'patient')
      .attach('file', Buffer.from('not a png'), {
        filename: 'not-a-signature.png',
        contentType: 'image/png',
      });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.message || '')).toMatch(/content does not match/i);
  });
});
