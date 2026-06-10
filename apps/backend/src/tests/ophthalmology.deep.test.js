// Roadmap D7 — ophthalmology deep round-trip.
//
// Per-eye exam (VA notations validated, IOP requires a method, >21 mmHg
// raises the glaucoma alert + distinct timeline event) → refractions
// (sphere/cyl/axis/add validated; axis required with non-zero cylinder;
// one per exam × eye × type) → history with latest glasses prescription.

import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';
import { normalizeVaNotation, validateRefraction } from '../services/clinical/ophthalmologyService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TEST_NAME = 'D7TEST OphthoPatient';
let patientUid;
let examId;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM ophthalmic_exams WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)`, TEST_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)`, TEST_NAME,
  ).catch(() => {});
  // clinical_audit_events is append-only — the C4 hash chain must never
  // have holes, so test cleanup deliberately leaves audit rows in place.
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = $1`, TEST_NAME).catch(() => {});
}

describe('ophthalmology validators (unit)', () => {
  test('accepts Snellen metric, CF/HM/PL/NPL, and near notations', () => {
    expect(normalizeVaNotation('6/6')).toBe('6/6');
    expect(normalizeVaNotation('6/36')).toBe('6/36');
    expect(normalizeVaNotation('3/60')).toBe('3/60');
    expect(normalizeVaNotation('cf 2m')).toBe('CF 2M');
    expect(normalizeVaNotation('HM')).toBe('HM');
    expect(normalizeVaNotation('npl')).toBe('NPL');
    expect(normalizeVaNotation('N6')).toBe('N6');
    expect(normalizeVaNotation(null)).toBeNull();
  });
  test('rejects junk notations', () => {
    expect(normalizeVaNotation('20/20')).toBeUndefined();   // imperial not used here
    expect(normalizeVaNotation('6/7')).toBeUndefined();
    expect(normalizeVaNotation('blind')).toBeUndefined();
  });
  test('refraction validation: axis required with cylinder, ranges enforced', () => {
    expect(validateRefraction({ sphere: -2.5, cylinder: -0.75, axis: 90 })).toEqual([]);
    expect(validateRefraction({ sphere: -2.5, cylinder: -0.75 })).toContain('axis is required when cylinder is non-zero');
    expect(validateRefraction({ sphere: -40 })[0]).toContain('sphere');
    expect(validateRefraction({ sphere: 0, axis: 200 })[0]).toContain('axis');
    expect(validateRefraction({ sphere: 0, addPower: 5 })[0]).toContain('add');
  });
});

d('Ophthalmology — deep round-trip (roadmap D7)', () => {
  const ophthalmologist = authClient('DOCTOR');

  beforeAll(async () => {
    await cleanup();
    const u = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, $2, 'PATIENT', true, NOW()) RETURNING uid`,
      `+9198866${String(Date.now() % 10000).padStart(4, '0')}`,
      TEST_NAME,
    );
    patientUid = u[0].uid;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('records a comprehensive exam with an IOP alert above 21 mmHg', async () => {
    const badVa = await ophthalmologist.post('/api/v1/ophthalmology/exams').send({
      patient_uid: patientUid, od_va_unaided: '20/40',
    });
    expect(badVa.status).toBe(400);

    const noMethod = await ophthalmologist.post('/api/v1/ophthalmology/exams').send({
      patient_uid: patientUid, od_iop_mmhg: 18,
    });
    expect(noMethod.status).toBe(400);

    const res = await ophthalmologist.post('/api/v1/ophthalmology/exams').send({
      patient_uid: patientUid,
      exam_type: 'comprehensive',
      od_va_unaided: '6/18',
      os_va_unaided: '6/12',
      od_va_pinhole: '6/9',
      os_va_pinhole: '6/9',
      od_iop_mmhg: 26.5,
      os_iop_mmhg: 17,
      iop_method: 'gat',
      od_lens_status: 'ns_grade_2',
      os_lens_status: 'ns_grade_1',
      od_anterior_segment: 'Quiet AC, pupil RRR',
      od_posterior_segment: 'CDR 0.7, NRR thinning',
      diagnosis: 'Suspect POAG OD; immature senile cataract OU',
    });
    expect(res.status).toBe(201);
    examId = res.body.data.exam.id;
    expect(res.body.data.exam.iop_alert).toBe(true);
    expect(res.body.data.exam.od_va_unaided).toBe('6/18');

    const alertEvents = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
       WHERE patient_uid = $1::uuid AND event_type = 'ophtho.exam_recorded_iop_alert'`,
      patientUid,
    );
    expect(alertEvents.length).toBe(1);
  });

  test('normal-IOP exams do not alert', async () => {
    const res = await ophthalmologist.post('/api/v1/ophthalmology/exams').send({
      patient_uid: patientUid,
      exam_type: 'iop_check',
      od_iop_mmhg: 16,
      os_iop_mmhg: 15,
      iop_method: 'nct',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.exam.iop_alert).toBe(false);
  });

  test('records refractions per eye with validation + uniqueness', async () => {
    const od = await ophthalmologist.post(`/api/v1/ophthalmology/exams/${examId}/refractions`).send({
      eye: 'od', refraction_type: 'final_glasses',
      sphere: -2.25, cylinder: -0.75, axis: 90, add_power: 1.5,
      va_with_correction: '6/6',
    });
    expect(od.status).toBe(201);

    const os = await ophthalmologist.post(`/api/v1/ophthalmology/exams/${examId}/refractions`).send({
      eye: 'os', refraction_type: 'final_glasses',
      sphere: -1.75, cylinder: -0.5, axis: 85, add_power: 1.5,
      va_with_correction: '6/6',
    });
    expect(os.status).toBe(201);

    const dupe = await ophthalmologist.post(`/api/v1/ophthalmology/exams/${examId}/refractions`).send({
      eye: 'od', refraction_type: 'final_glasses', sphere: -2.0,
    });
    expect(dupe.status).toBe(409);

    const noAxis = await ophthalmologist.post(`/api/v1/ophthalmology/exams/${examId}/refractions`).send({
      eye: 'od', refraction_type: 'manifest', sphere: -2.25, cylinder: -0.75,
    });
    expect(noAxis.status).toBe(400);

    const badEye = await ophthalmologist.post(`/api/v1/ophthalmology/exams/${examId}/refractions`).send({
      eye: 'both', sphere: -2,
    });
    expect(badEye.status).toBe(400);
  });

  test('history rolls up exams with refractions and surfaces latest glasses', async () => {
    const res = await ophthalmologist.get(`/api/v1/ophthalmology/patients/${patientUid}/history`);
    expect(res.status).toBe(200);
    const { exams, latest_glasses } = res.body.data;
    expect(exams).toHaveLength(2);
    const comprehensive = exams.find((e) => e.id === examId);
    expect(comprehensive.refractions).toHaveLength(2);
    expect(latest_glasses).toHaveLength(2);
    expect(latest_glasses.every((g) => g.refraction_type === 'final_glasses')).toBe(true);
  });
});
