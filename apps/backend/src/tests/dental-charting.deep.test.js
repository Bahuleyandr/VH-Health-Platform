// Roadmap D7 — dental charting deep round-trip.
//
// FDI-validated tooth findings → odontogram chart → procedure planned
// against a finding → completion auto-resolves the finding → manual
// resolution requires a note. Timeline events at every clinical write.

import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';
import { isValidFdiTooth } from '../services/clinical/dentalService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TEST_NAME = 'D7TEST DentalPatient';
let patientUid;
let cariesFindingId;
let mobilityFindingId;
let procedureId;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM dental_procedures WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)`, TEST_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM dental_tooth_findings WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)`, TEST_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)`, TEST_NAME,
  ).catch(() => {});
  // clinical_audit_events is append-only — the C4 hash chain must never
  // have holes, so test cleanup deliberately leaves audit rows in place.
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = $1`, TEST_NAME).catch(() => {});
}

describe('FDI tooth notation validator (unit)', () => {
  test('accepts permanent (11-48) and deciduous (51-85) ranges', () => {
    expect(isValidFdiTooth('11')).toBe(true);
    expect(isValidFdiTooth('48')).toBe(true);
    expect(isValidFdiTooth('36')).toBe(true);
    expect(isValidFdiTooth('55')).toBe(true);
    expect(isValidFdiTooth('85')).toBe(true);
  });
  test('rejects out-of-range positions and junk', () => {
    expect(isValidFdiTooth('19')).toBe(false);  // no 9th permanent tooth
    expect(isValidFdiTooth('56')).toBe(false);  // deciduous max 5
    expect(isValidFdiTooth('90')).toBe(false);
    expect(isValidFdiTooth('1')).toBe(false);
    expect(isValidFdiTooth('AB')).toBe(false);
    expect(isValidFdiTooth(null)).toBe(false);
  });
});

d('Dental charting — deep round-trip (roadmap D7)', () => {
  const dentist = authClient('DOCTOR');

  beforeAll(async () => {
    await cleanup();
    const u = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, $2, 'PATIENT', true, NOW()) RETURNING uid`,
      `+9198855${String(Date.now() % 10000).padStart(4, '0')}`,
      TEST_NAME,
    );
    patientUid = u[0].uid;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('records findings with FDI + surface validation', async () => {
    const caries = await dentist.post('/api/v1/dental/findings').send({
      patient_uid: patientUid,
      tooth_fdi: '36',
      surface: 'occlusal',
      finding: 'caries',
      severity: 'moderate',
    });
    expect(caries.status).toBe(201);
    cariesFindingId = caries.body.data.finding.id;

    const mobility = await dentist.post('/api/v1/dental/findings').send({
      patient_uid: patientUid,
      tooth_fdi: '31',
      finding: 'mobility_grade_2',
    });
    expect(mobility.status).toBe(201);
    mobilityFindingId = mobility.body.data.finding.id;

    const badTooth = await dentist.post('/api/v1/dental/findings').send({
      patient_uid: patientUid, tooth_fdi: '19', finding: 'caries',
    });
    expect(badTooth.status).toBe(400);

    const badSurface = await dentist.post('/api/v1/dental/findings').send({
      patient_uid: patientUid, tooth_fdi: '36', surface: 'sideways', finding: 'caries',
    });
    expect(badSurface.status).toBe(400);

    const badFinding = await dentist.post('/api/v1/dental/findings').send({
      patient_uid: patientUid, tooth_fdi: '36', finding: 'cavity_vibes',
    });
    expect(badFinding.status).toBe(400);

    const events = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
       WHERE patient_uid = $1::uuid AND event_type = 'dental.finding_recorded'`,
      patientUid,
    );
    expect(events.length).toBe(2);
  });

  test('odontogram chart groups active findings by tooth', async () => {
    const res = await dentist.get(`/api/v1/dental/patients/${patientUid}/chart`);
    expect(res.status).toBe(200);
    const { chart } = res.body.data;
    expect(chart.active_finding_count).toBe(2);
    expect(chart.teeth['36'].findings[0].finding).toBe('caries');
    expect(chart.teeth['31'].findings[0].finding).toBe('mobility_grade_2');
  });

  test('plans a procedure against the caries finding; patient mismatch is blocked', async () => {
    const res = await dentist.post('/api/v1/dental/procedures').send({
      patient_uid: patientUid,
      tooth_fdi: '36',
      surface: 'occlusal',
      finding_id: cariesFindingId,
      procedure_name: 'Composite restoration',
      procedure_code: 'D2391',
    });
    expect(res.status).toBe(201);
    procedureId = res.body.data.procedure.id;
    expect(res.body.data.procedure.status).toBe('planned');

    const otherPatient = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, 'D7TEST OtherDental', 'PATIENT', true, NOW()) RETURNING uid`,
      `+9198856${String(Date.now() % 10000).padStart(4, '0')}`,
    );
    const mismatch = await dentist.post('/api/v1/dental/procedures').send({
      patient_uid: otherPatient[0].uid,
      finding_id: cariesFindingId,
      procedure_name: 'Wrong patient procedure',
    });
    expect(mismatch.status).toBe(400);
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = 'D7TEST OtherDental'`).catch(() => {});
  });

  test('completing the procedure auto-resolves the linked finding', async () => {
    const res = await dentist.post(`/api/v1/dental/procedures/${procedureId}/complete`).send({
      materials: 'A2 composite',
      anesthesia: '2% lignocaine with adrenaline',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.procedure.status).toBe('completed');

    const finding = await prisma.$queryRawUnsafe(
      `SELECT status, resolved_by_procedure_id, resolution_note FROM dental_tooth_findings WHERE id = $1`,
      cariesFindingId,
    );
    expect(finding[0].status).toBe('resolved');
    expect(finding[0].resolved_by_procedure_id).toBe(procedureId);
    expect(finding[0].resolution_note).toContain('Composite restoration');

    const chart = await dentist.get(`/api/v1/dental/patients/${patientUid}/chart`);
    expect(chart.body.data.chart.active_finding_count).toBe(1);

    const events = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
       WHERE patient_uid = $1::uuid AND event_type = 'dental.procedure_completed'`,
      patientUid,
    );
    expect(events.length).toBe(1);

    const again = await dentist.post(`/api/v1/dental/procedures/${procedureId}/complete`).send({});
    expect(again.status).toBe(400);
  });

  test('manual resolution requires a note; cancellation requires a reason', async () => {
    const noNote = await dentist.post(`/api/v1/dental/findings/${mobilityFindingId}/resolve`).send({});
    expect(noNote.status).toBe(400);

    const res = await dentist.post(`/api/v1/dental/findings/${mobilityFindingId}/resolve`).send({
      resolution_note: 'Splinting completed elsewhere; mobility resolved on review',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.finding.status).toBe('resolved');

    const plan = await dentist.post('/api/v1/dental/procedures').send({
      patient_uid: patientUid, procedure_name: 'Full mouth scaling',
    });
    const noReason = await dentist.post(`/api/v1/dental/procedures/${plan.body.data.procedure.id}/cancel`).send({});
    expect(noReason.status).toBe(400);
    const cancelled = await dentist.post(`/api/v1/dental/procedures/${plan.body.data.procedure.id}/cancel`).send({
      reason: 'Patient deferred',
    });
    expect(cancelled.status).toBe(200);
  });
});
