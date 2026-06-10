// Roadmap D4 — NABH indicator pack deep round-trip + CSV shape.

import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';
import { packToCsv, INDICATOR_CODES } from '../services/quality/nabhIndicatorService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const PHONE = `+9199920${String(Date.now() % 10000).padStart(4, '0')}`;
const FROM = '2026-03-01';
const TO = '2026-03-31';
let patientUid;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM nabh_indicator_snapshots WHERE period_start = $1::date AND period_end = $2::date`,
    FROM, TO,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM admissions WHERE ward = 'D4TEST Ward'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = 'D4TEST Patient'`).catch(() => {});
}

d('NABH indicators — deep round-trip (roadmap D4)', () => {
  beforeAll(async () => {
    await cleanup();
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, 'D4TEST Patient', 'PATIENT', true, NOW()) RETURNING uid`,
      PHONE,
    );
    patientUid = p[0].uid;
    // One routine discharge + one LAMA inside the period → 50% AMA/LAMA.
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions (patient_uid, allergies, status, ward, bed_number, admitted_at, discharged_at, discharge_type, created_at, updated_at)
       VALUES ($1::uuid, '{}', 'discharged', 'D4TEST Ward', 'D4-01', '2026-03-02', '2026-03-05', 'routine', NOW(), NOW()),
              ($1::uuid, '{}', 'discharged', 'D4TEST Ward', 'D4-02', '2026-03-10', '2026-03-12', 'LAMA', NOW(), NOW())`,
      patientUid,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('computes the pack with isolated, schema-tolerant indicators', async () => {
    const res = await authClient('QUALITY_OFFICER')
      .get('/api/v1/quality/nabh/indicators')
      .query({ from: FROM, to: TO });
    expect(res.status).toBe(200);
    const pack = res.body.data;
    expect(pack.indicators.map((i) => i.code).sort()).toEqual([...INDICATOR_CODES].sort());

    const ama = pack.indicators.find((i) => i.code === 'ama_lama_discharge_pct');
    expect(ama.available).toBe(true);
    expect(ama.numerator).toBe(1);
    expect(ama.denominator).toBe(2);
    expect(ama.value).toBe(50);

    const hai = pack.indicators.find((i) => i.code === 'hai_rate_per_1000_patient_days');
    expect(hai.available).toBe(true);
    expect(Number(hai.denominator)).toBeGreaterThan(0); // patient-days from the two stays
  });

  test('CSV export is assessor-shaped', async () => {
    const res = await authClient('ADMIN')
      .get('/api/v1/quality/nabh/indicators')
      .query({ from: FROM, to: TO, format: 'csv' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('indicator_code,label,value,unit,numerator,denominator,period_start,period_end,available');
    expect(lines.length).toBe(INDICATOR_CODES.length + 1);
  });

  test('snapshots persist and list; nurses blocked', async () => {
    const snap = await authClient('CMO')
      .post('/api/v1/quality/nabh/snapshots')
      .send({ from: FROM, to: TO });
    expect(snap.status).toBe(201);
    expect(snap.body.data.snapshot_saved).toBeGreaterThanOrEqual(4);

    const list = await authClient('QUALITY_OFFICER')
      .get('/api/v1/quality/nabh/snapshots')
      .query({ from: FROM, to: TO });
    expect(list.status).toBe(200);
    expect(list.body.data.count).toBeGreaterThanOrEqual(4);

    const nurse = await authClient('NURSING_STAFF')
      .get('/api/v1/quality/nabh/indicators')
      .query({ from: FROM, to: TO });
    expect(nurse.status).toBe(403);
  });

  test('packToCsv escapes embedded commas/quotes (pure)', () => {
    const csv = packToCsv({
      period: { from: FROM, to: TO },
      indicators: [{ code: 'x', label: 'Label, with "quotes"', value: 1, unit: '%', numerator: 1, denominator: 2, available: true }],
    });
    expect(csv.split('\n')[1]).toContain('"Label, with ""quotes"""');
  });

  test('inverted period is a clean 400', async () => {
    const res = await authClient('ADMIN')
      .get('/api/v1/quality/nabh/indicators')
      .query({ from: TO, to: FROM });
    expect(res.status).toBe(400);
  });
});
