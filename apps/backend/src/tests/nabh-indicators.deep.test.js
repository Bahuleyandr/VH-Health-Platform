// Roadmap D4 — NABH indicator pack deep round-trip + CSV shape.

import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';
import { packToCsv, packToPdfBuffer, INDICATOR_CODES } from '../services/quality/nabhIndicatorService.js';

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
    `DELETE FROM quality_incidents WHERE incident_number LIKE 'D4TEST-RCA-%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM feedback WHERE phone = $1`,
    PHONE,
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
    await prisma.$executeRawUnsafe(
      `INSERT INTO feedback (phone, rating, comment, category, created_at, updated_at)
       VALUES ($1, 5, 'D4TEST great', 'GENERAL', '2026-03-06', NOW()),
              ($1, 3, 'D4TEST ok', 'GENERAL', '2026-03-07', NOW())`,
      PHONE,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO quality_incidents
         (incident_number, reported_by, patient_uid, incident_type, severity, description,
          date_occurred, status, root_cause, corrective_action, preventive_action, resolved_at)
       VALUES
         ('D4TEST-RCA-1', '550e8400-e29b-41d4-a716-446655440000'::uuid, $1::uuid, 'fall',
          'sentinel', 'D4TEST sentinel incident', '2026-03-08', 'closed',
          'Process gap', 'Checklist updated', 'Monthly audit', '2026-03-10'),
         ('D4TEST-RCA-2', '550e8400-e29b-41d4-a716-446655440000'::uuid, $1::uuid, 'near_miss',
          'major', 'D4TEST major incident', '2026-03-09', 'investigating',
          NULL, NULL, NULL, NULL)`,
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

    const satisfaction = pack.indicators.find((i) => i.code === 'patient_satisfaction_positive_pct');
    expect(satisfaction.available).toBe(true);
    expect(satisfaction.numerator).toBe(1);
    expect(satisfaction.denominator).toBe(2);
    expect(satisfaction.value).toBe(50);

    const rca = pack.indicators.find((i) => i.code === 'rca_completion_pct');
    expect(rca.available).toBe(true);
    expect(rca.numerator).toBe(1);
    expect(rca.denominator).toBe(2);
    expect(rca.value).toBe(50);
    expect(rca.details.rca_required_scope).toContain('major, sentinel');
  });

  test('CSV export is assessor-shaped', async () => {
    const res = await authClient('ADMIN')
      .get('/api/v1/quality/nabh/indicators')
      .query({ from: FROM, to: TO, format: 'csv' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('indicator_code,label,value,unit,numerator,denominator,period_start,period_end,available,definition_status,evidence_control,source_tables,assessor_note');
    expect(lines.length).toBe(INDICATOR_CODES.length + 1);
    expect(res.text).toContain('pending_assessor_format');
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

  test('freezes a period pack and exports assessor-ready JSON, CSV, and PDF', async () => {
    const freeze = await authClient('CMO')
      .post('/api/v1/quality/nabh/period-pack')
      .send({ from: FROM, to: TO });
    expect(freeze.status).toBe(201);
    expect(freeze.body.data.pack_type).toBe('NABH_PERIOD_PACK');
    expect(freeze.body.data.export_contract.canonical_format_status).toBe('pending_assessor_format');
    expect(freeze.body.data.evidence_attachment.control_code).toBe('NABH_AUDIT_EXPORT');
    expect(freeze.body.data.snapshot_saved).toBe(INDICATOR_CODES.length);
    expect(freeze.body.data.missing_indicator_codes).toEqual([]);

    const json = await authClient('QUALITY_OFFICER')
      .get('/api/v1/quality/nabh/period-pack')
      .query({ from: FROM, to: TO });
    expect(json.status).toBe(200);
    expect(json.body.data.status).toBe('frozen');
    expect(json.body.data.indicator_count).toBe(INDICATOR_CODES.length);

    const csv = await authClient('QUALITY_OFFICER')
      .get('/api/v1/quality/nabh/period-pack')
      .query({ from: FROM, to: TO, format: 'csv' });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-disposition']).toContain('nabh-period-pack');
    expect(csv.text).toContain('NABH_AUDIT_EXPORT');

    const pdfBuffer = await packToPdfBuffer(json.body.data);
    expect(pdfBuffer.subarray(0, 4).toString('utf8')).toBe('%PDF');
  });

  test('packToCsv escapes embedded commas/quotes (pure)', () => {
    const csv = packToCsv({
      period: { from: FROM, to: TO },
      export_contract: { canonical_format_status: 'pending_assessor_format' },
      indicators: [{ code: 'x', label: 'Label, with "quotes"', value: 1, unit: '%', numerator: 1, denominator: 2, available: true, definition: { source_tables: ['a'], assessor_note: 'note' }, details: {} }],
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
