// Regression test for finding cluster H' D17.
//
// `POST /api/v1/appointments/walk-in` accepted `chronic_medications`
// (and the `current_medications` / `existing_medications` aliases) in
// the payload but the receptionist value was silently dropped — the
// new users row was created with an empty `chronic_medications` jsonb
// default. The first consult therefore showed no chronic-med list,
// the doctor stopped a long-running statin without realising it was
// chronic, and the discharge summary had no "continue Metformin" line.
// Migration 209 added the column (`users.chronic_medications JSONB`)
// for the discharge reconciliation; this fix wires the walk-in
// controller to actually populate it.
//
// Findings: 56a203d0, 16e99276, 313b7af0.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const RECEPTIONIST_UID = 'd6666666-aaaa-4bbb-8ccc-dddddddd0011';
let receptionistId;
let receptionistToken;

const STAMP = String(Date.now() % 100000).padStart(5, '0');
const PHONE_STRUCTURED = `96770${STAMP}`;
const PHONE_FREETEXT = `96771${STAMP}`;
const PHONE_NONE = `96772${STAMP}`;

async function cleanup(phones) {
  if (!phones.length) return;
  const variants = phones.flatMap((p) => [p, `+91${p}`]);
  const userRows = await prisma
    .$queryRawUnsafe(
      `SELECT id FROM users WHERE phone = ANY($1::text[])`,
      variants,
    )
    .catch(() => []);
  const ids = userRows.map((r) => r.id);
  if (ids.length > 0) {
    await prisma
      .$executeRawUnsafe(`DELETE FROM appointments WHERE patient_id = ANY($1::int[])`, ids)
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(`DELETE FROM users WHERE id = ANY($1::int[])`, ids)
      .catch(() => {});
  }
}

describe('POST /appointments/walk-in — chronic_medications capture (D17)', () => {
  beforeAll(async () => {
    await cleanup([PHONE_STRUCTURED, PHONE_FREETEXT, PHONE_NONE]);
    // Seed the receptionist user so the appointment_status_history
    // INSERT (which carries the actor's user id under the FK
    // `appt_status_hist_user_fk`) doesn't 23503 on the CI DB. We
    // explicitly delete-then-insert to dodge any prior-run leak.
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = $1::uuid`,
      RECEPTIONIST_UID,
    ).catch(() => {});
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9700100011', 'D17 Receptionist', 'RECEPTIONIST', true, NOW())
       RETURNING id`,
      RECEPTIONIST_UID,
    );
    receptionistId = rows[0].id;
    receptionistToken = generateTestToken('RECEPTIONIST', {
      uid: RECEPTIONIST_UID, id: receptionistId,
    });
  });

  afterAll(async () => {
    await cleanup([PHONE_STRUCTURED, PHONE_FREETEXT, PHONE_NONE]);
    await prisma
      .$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, RECEPTIONIST_UID)
      .catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('persists a structured chronic_medications array supplied at registration', async () => {
    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .send({
        patient_name: 'D17 Structured',
        patient_phone: PHONE_STRUCTURED,
        patient_gender: 'M',
        reason: 'Chest pain',
        chronic_medications: [
          { name: 'Metformin', dose: '500mg', frequency: 'BD', indication: 'Type 2 DM' },
          { name: 'Atorvastatin', dose: '20mg', frequency: 'OD' },
        ],
      });
    expect(res.statusCode).toBe(200);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT chronic_medications, chronic_medications_updated_at
         FROM users WHERE id = $1::int`,
      res.body.data.patient_id,
    );
    expect(Array.isArray(rows[0].chronic_medications)).toBe(true);
    expect(rows[0].chronic_medications).toHaveLength(2);
    expect(rows[0].chronic_medications[0]).toEqual(
      expect.objectContaining({ name: 'Metformin', dose: '500mg', frequency: 'BD', indication: 'Type 2 DM' }),
    );
    expect(rows[0].chronic_medications_updated_at).toBeTruthy();
  });

  it('parses a free-text comma list into structured name-only entries', async () => {
    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .send({
        patient_name: 'D17 Free-text',
        patient_phone: PHONE_FREETEXT,
        patient_gender: 'F',
        reason: 'Headache',
        // Common receptionist-dialog free-text shape under either alias.
        current_medications: 'Levothyroxine, Vitamin D3, Calcium',
      });
    expect(res.statusCode).toBe(200);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT chronic_medications FROM users WHERE id = $1::int`,
      res.body.data.patient_id,
    );
    const meds = rows[0].chronic_medications;
    expect(Array.isArray(meds)).toBe(true);
    expect(meds).toHaveLength(3);
    expect(meds.map((m) => m.name)).toEqual(['Levothyroxine', 'Vitamin D3', 'Calcium']);
  });

  it('leaves chronic_medications as the default empty array when caller omits the field', async () => {
    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .send({
        patient_name: 'D17 Nothing',
        patient_phone: PHONE_NONE,
        patient_gender: 'M',
        reason: 'Sore throat',
      });
    expect(res.statusCode).toBe(200);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT chronic_medications, chronic_medications_updated_at
         FROM users WHERE id = $1::int`,
      res.body.data.patient_id,
    );
    expect(rows[0].chronic_medications).toEqual([]);
    expect(rows[0].chronic_medications_updated_at).toBeNull();
  });
});
