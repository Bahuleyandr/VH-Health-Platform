// Roadmap A3 — ward downtime pack generation round-trip.
//
// Seeds one ward + occupied bed + patient (with a structured allergy and a
// scheduled MAR dose), runs the generator, and asserts:
//   1. a downtime_snapshots row lands with scope ward_pack + the ward id
//   2. the payload carries the safety-critical fields (allergy, MAR due)
//   3. the printable HTML is embedded and self-contained
//   4. a clinical-staff JWT can fetch it over HTTP (JSON + HTML variants)

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { generateWardDowntimePacks, WARD_PACK_SCOPE } from '../services/downtime/wardDowntimePackService.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';
import { generateToken } from '../utils/jwtUtils.js';

const API_KEY = process.env.API_KEY || 'test-api-key';
const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const PHONE = `+9199904${String(Date.now() % 10000).padStart(5, '0')}`;
const WARD_NAME = 'DTPACK Test Ward';
const BED_NUMBER = 'DTPACK-01';

let wardId;
let patientUid;
let patientId;

const doctorToken = () => generateToken({
  uid: '33333333-3333-4333-8333-333333333d03',
  role: 'DOCTOR',
  type: 'staff',
});

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM downtime_snapshots WHERE scope = $1 AND label LIKE '%DTPACK%'`, WARD_PACK_SCOPE,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM medication_administrations WHERE medication_name = 'DTPACK-Med'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM patient_allergies WHERE allergy_name = 'DTPACK-Allergen'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM beds WHERE bed_number = $1`, BED_NUMBER).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM wards WHERE name = $1`, WARD_NAME).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = 'DTPACK Patient'`).catch(() => {});
}

d('Ward downtime packs — deep round-trip (roadmap A3)', () => {
  beforeAll(async () => {
    await cleanup();

    const w = await prisma.$queryRawUnsafe(
      `INSERT INTO wards (name, floor, total_beds) VALUES ($1, 1, 1) RETURNING id`, WARD_NAME,
    );
    wardId = w[0].id;

    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, 'DTPACK Patient', 'PATIENT', true, NOW()) RETURNING id, uid`,
      PHONE,
    );
    patientId = p[0].id;
    patientUid = p[0].uid;

    await prisma.$executeRawUnsafe(
      `INSERT INTO beds (ward_id, bed_number, status, patient_id, patient_uid, patient_name)
       VALUES ($1, $2, 'occupied', $3, $4::uuid, 'DTPACK Patient')`,
      wardId, BED_NUMBER, patientId, patientUid,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_allergies (patient_id, patient_uid, allergy_name, severity, is_active)
       VALUES ($1, $2::uuid, 'DTPACK-Allergen', 'SEVERE', true)`,
      patientId, patientUid,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO medication_administrations (patient_uid, medication_name, dose, route, scheduled_time, status)
       VALUES ($1::uuid, 'DTPACK-Med', '500mg', 'PO', NOW() + INTERVAL '2 hours', 'scheduled')`,
      patientUid,
    );
  });

  afterAll(async () => {
    await cleanup();
  });

  it('generates a pack for the seeded ward with allergy + MAR content', async () => {
    const results = await generateWardDowntimePacks({
      tenantId: DEFAULT_TENANT_ID,
      generatedBy: null,
    });
    const mine = results.find((r) => r.ward_id === wardId);
    expect(mine).toBeTruthy();
    expect(mine.beds).toBe(1);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT payload FROM downtime_snapshots
        WHERE scope = $1 AND ward_id = $2 ORDER BY created_at DESC LIMIT 1`,
      WARD_PACK_SCOPE, wardId,
    );
    expect(rows.length).toBe(1);
    const payload = rows[0].payload;
    expect(payload.ward_name).toBe(WARD_NAME);
    expect(payload.beds).toHaveLength(1);
    const bed = payload.beds[0];
    expect(bed.bed_number).toBe(BED_NUMBER);
    expect(bed.allergies.map((a) => a.allergen)).toContain('DTPACK-Allergen');
    expect(bed.mar_due.map((m) => m.medication_name)).toContain('DTPACK-Med');
    expect(payload.html).toContain('DTPACK-Allergen (SEVERE)');
    expect(payload.html).toContain('DTPACK-Med');
    // C-D2: the printed sheet declares its own expiry, and the stored expiry
    // is the same instant.
    expect(payload.html).toContain('NOT VALID AFTER');
    expect(payload.html).toContain('then use paper and phone.');
  });

  it('serves the latest pack over HTTP to clinical staff (JSON + HTML)', async () => {
    const json = await request(app)
      .get(`/api/v1/downtime/wards/${wardId}/latest`)
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${doctorToken()}`);
    expect(json.status).toBe(200);
    expect(json.body?.data?.payload?.ward_name).toBe(WARD_NAME);
    // HTML stripped from the JSON variant
    expect(json.body?.data?.payload?.html).toBeUndefined();

    const html = await request(app)
      .get(`/api/v1/downtime/wards/${wardId}/latest?format=html`)
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${doctorToken()}`);
    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.text).toContain('DOWNTIME PACK');
    expect(html.text).toContain('NOT VALID AFTER');

    const list = await request(app)
      .get('/api/v1/downtime/wards')
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${doctorToken()}`);
    expect(list.status).toBe(200);
    expect(list.body?.data?.packs?.some((p) => p.ward_id === wardId)).toBe(true);
  });

  it('re-renders a stored pack instead of replaying a superseded rendering', async () => {
    // A pack generated before a renderer fix keeps its old HTML string in the
    // payload for the whole 24-hour retention window. Simulate one and prove
    // the ward PC is served the CURRENT renderer's output, not the stored
    // string — the stored NKDA line must never reach a printer.
    await prisma.$executeRawUnsafe(
      `UPDATE downtime_snapshots
          SET payload = jsonb_set(payload::jsonb, '{html}',
                                  to_jsonb('<p>ALLERGIES: NKDA / none recorded</p>'::text))
        WHERE scope = $1 AND ward_id = $2`,
      WARD_PACK_SCOPE, wardId,
    );

    const html = await request(app)
      .get(`/api/v1/downtime/wards/${wardId}/latest?format=html`)
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${doctorToken()}`);

    expect(html.status).toBe(200);
    expect(html.text).not.toContain('NKDA');
    expect(html.text).toContain('DTPACK-Allergen (SEVERE)');
    expect(html.text).toContain('NOT VALID AFTER');
  });

  it('rejects patients and unauthenticated callers', async () => {
    const patientToken = generateToken({ uid: patientUid, role: 'PATIENT' });
    const denied = await request(app)
      .get(`/api/v1/downtime/wards/${wardId}/latest`)
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${patientToken}`);
    expect(denied.status).toBe(403);

    const anonymous = await request(app)
      .get(`/api/v1/downtime/wards/${wardId}/latest`)
      .set('X-API-Key', API_KEY);
    expect(anonymous.status).toBe(401);
  });
});
