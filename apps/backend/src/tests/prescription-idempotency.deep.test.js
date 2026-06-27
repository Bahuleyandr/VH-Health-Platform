// e-Rx prescription-create idempotency (offline-drain dedup, required:false).
//
// POST /prescriptions/create stays required:false. The OFFLINE queue always sends a
// stable Idempotency-Key, and the idempotency middleware dedups any KEYED request
// regardless of the required flag — so a redrain of a lost-2xx cannot create a second
// prescription. Proven here: same key+body twice -> 201 both times, the 2nd is a cached
// REPLAY (identical body), and exactly ONE e_prescriptions row.
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';
import { API_KEY, generateTestToken } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'a7e50003-0001-4a7e-8a7e-a7e500030001';
const DOCTOR_UID = 'a7e50003-0002-4a7e-8a7e-a7e500030002';
let patientId;
let doctorId;

function doctor() {
  const t = generateTestToken('DOCTOR', { uid: DOCTOR_UID, id: 770881, deviceType: 'desktop', tenant_id: TENANT_ID });
  return { post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}
const D = doctor();

function rxBody() {
  return {
    patient_id: patientId,
    doctor_id: doctorId,
    diagnosis: 'Fever',
    clinical_notes: null,
    medications: [{
      name: 'Paracetamol', medication_name: 'Paracetamol', strength: '500mg',
      dosage: '1 tab', frequency: 'BD', route: 'oral', duration: '5 days', days: 5,
      quantity: '10', refills: 0,
    }],
  };
}

async function rxCount() {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS n FROM e_prescriptions WHERE patient_id = $1', patientId);
  return Number(rows[0]?.n ?? 0);
}

async function clean() {
  if (patientId) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM prescription_safety_overrides WHERE prescription_id IN (SELECT id FROM e_prescriptions WHERE patient_id = $1)`, patientId).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM e_prescriptions WHERE patient_id = $1`, patientId).catch(() => {});
  }
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID).catch(() => {});
}

d('e-Rx prescription-create idempotency (offline-drain dedup, required:false)', () => {
  beforeAll(async () => {
    await clean();
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid,'9330000031','eRx Idem Patient','PATIENT',true,$2::uuid,NOW()) RETURNING id`,
      PATIENT_UID, TENANT_ID);
    patientId = p[0].id;
    const dr = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid,'9330000032','eRx Idem Doctor','DOCTOR',true,$2::uuid,NOW()) RETURNING id`,
      DOCTOR_UID, TENANT_ID);
    doctorId = dr[0].id;
  }, 60000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 60000);
  beforeEach(async () => {
    if (patientId) await prisma.$executeRawUnsafe(`DELETE FROM e_prescriptions WHERE patient_id = $1`, patientId).catch(() => {});
  });

  it('replays the same key+body: 201 twice, identical cached body, exactly one row', async () => {
    // Run-unique key: idempotency_keys rows persist 24h, so a FIXED key would replay a
    // cached response pointing at a since-deleted prescription on a re-run.
    const key = `erx-idem-${Date.now()}`;
    const first = await D.post('/api/v1/prescriptions/create').set('Idempotency-Key', key).send(rxBody());
    expect(first.statusCode).toBe(201);

    const second = await D.post('/api/v1/prescriptions/create').set('Idempotency-Key', key).send(rxBody());
    expect(second.statusCode).toBe(201);
    // The replay returns the ORIGINAL cached response verbatim (same requestId, same id).
    expect(second.body).toEqual(first.body);
    expect(await rxCount()).toBe(1);
  });
});
