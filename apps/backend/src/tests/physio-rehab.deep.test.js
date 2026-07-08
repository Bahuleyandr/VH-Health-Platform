// NL6-11 — physiotherapy/rehab deep walk.
//
// Discharge follow-up referral intake → structured assessment → rehab
// care_plan → completed session → outcome trend + patient timeline linkage.

import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_UID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_NAME = 'NL611 PhysioPatient';
let patientUid;
let followUpPlanId;
let assessmentId;
let carePlanId;
let sessionId;

const physio = () => authClient('PHYSIOTHERAPIST', { uid: ACTOR_UID, tenant_id: TENANT_ID });

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM physio_outcome_scores WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)`,
    TEST_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM physio_sessions WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)`,
    TEST_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM physio_assessments WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)`,
    TEST_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM follow_up_plans WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)`,
    TEST_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM care_plan_review_log
      WHERE care_plan_id IN (
        SELECT id FROM care_plans WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)
      )`,
    TEST_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM care_plans WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)`,
    TEST_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid IN (SELECT uid FROM users WHERE name = $1)`,
    TEST_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = $1`, TEST_NAME).catch(() => {});
}

d('Physiotherapy rehab foundation — deep round-trip (NL6-11)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, 'default', 'Default Tenant')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_ID,
    );
    const patient = await prisma.$queryRawUnsafe(
      `INSERT INTO users (tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, $3, 'PATIENT', true, NOW())
       RETURNING uid`,
      TENANT_ID,
      `+9198711${String(Date.now() % 10000).padStart(4, '0')}`,
      TEST_NAME,
    );
    patientUid = patient[0].uid;

    const followUp = await prisma.$queryRawUnsafe(
      `INSERT INTO follow_up_plans
         (tenant_id, patient_uid, origin_kind, origin_resource_type, origin_resource_id,
          due_at, appointment_status, reason, status, metadata, created_by)
       VALUES
         ($1::uuid, $2::uuid, 'discharge', 'discharge_summary', 'DS-NL611',
          NOW() + INTERVAL '1 day', 'pending', 'Physiotherapy discharge mobilisation review',
          'open', $3::jsonb, $4::uuid)
       RETURNING id`,
      TENANT_ID,
      patientUid,
      JSON.stringify({ consult_type: 'physiotherapy', origin: 'discharge' }),
      ACTOR_UID,
    );
    followUpPlanId = followUp[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('physiotherapist can read the referral worklist; reception cannot', async () => {
    const ok = await physio().get('/api/v1/physio/worklist');
    expect(ok.status).toBe(200);
    expect(ok.body.data.worklist.some((row) => row.follow_up_plan_id === followUpPlanId)).toBe(true);

    const denied = await authClient('RECEPTIONIST', { tenant_id: TENANT_ID }).get('/api/v1/physio/worklist');
    expect(denied.status).toBe(403);
  });

  test('records assessment, starts rehab care plan, completes session, and trends outcomes', async () => {
    const assessment = await physio().post('/api/v1/physio/assessments').send({
      patient_uid: patientUid,
      follow_up_plan_id: followUpPlanId,
      assessment_kind: 'initial',
      mobility_status: 'assisted_transfer',
      pain_score: 6,
      rom_measures: [{ joint: 'knee', movement: 'flexion', degrees: 92, pain_score: 4 }],
      strength_measures: [{ label: 'quadriceps', test: 'mmt', grade: '3/5' }],
      functional_limitations: ['Needs assistance for sit-to-stand'],
      baseline_outcome_score: 52,
      notes: 'Post-discharge mobility baseline',
    });
    expect(assessment.status).toBe(201);
    assessmentId = assessment.body.data.assessment.id;
    expect(assessment.body.data.assessment.follow_up_plan_id).toBe(followUpPlanId);

    const plan = await physio().post('/api/v1/physio/therapy-plans').send({
      patient_uid: patientUid,
      follow_up_plan_id: followUpPlanId,
      assessment_id: assessmentId,
      display_name: 'Post-discharge gait rehab',
      goal_summary: 'Independent transfers and walker-supported gait',
    });
    expect(plan.status).toBe(201);
    carePlanId = plan.body.data.care_plan.id;
    expect(plan.body.data.care_plan.plan_kind).toBe('rehab');
    expect(plan.body.data.care_plan.care_team_role).toBe('PHYSIOTHERAPIST');

    const linkRows = await prisma.$queryRawUnsafe(
      `SELECT f.care_plan_id AS follow_up_plan_id_link, a.care_plan_id AS assessment_plan_id
         FROM follow_up_plans f
         JOIN physio_assessments a
           ON a.tenant_id = f.tenant_id
          AND a.id = $3
        WHERE f.tenant_id = $1::uuid
          AND f.id = $2`,
      TENANT_ID,
      followUpPlanId,
      assessmentId,
    );
    expect(linkRows[0].follow_up_plan_id_link).toBe(carePlanId);
    expect(linkRows[0].assessment_plan_id).toBe(carePlanId);

    const session = await physio().post('/api/v1/physio/sessions').send({
      patient_uid: patientUid,
      care_plan_id: carePlanId,
      assessment_id: assessmentId,
      follow_up_plan_id: followUpPlanId,
      session_status: 'completed',
      session_type: 'gait_training',
      duration_minutes: 35,
      pain_score_before: 6,
      pain_score_after: 4,
      rom_entries: [{ joint: 'knee', movement: 'flexion', degrees: 102 }],
      exercise_entries: [{ label: 'sit-to-stand', sets: 2, reps: 8 }],
      outcome_score: 66,
      notes: 'Tolerated gait training with walker',
    });
    expect(session.status).toBe(201);
    sessionId = session.body.data.session.id;
    expect(Number(session.body.data.outcome.score_value)).toBe(66);

    const outcome = await physio().post('/api/v1/physio/outcomes').send({
      patient_uid: patientUid,
      care_plan_id: carePlanId,
      assessment_id: assessmentId,
      session_id: sessionId,
      score_kind: 'functional',
      score_label: 'Functional mobility score',
      score_value: 78,
    });
    expect(outcome.status).toBe(201);

    const trend = await physio().get(`/api/v1/physio/care-plans/${carePlanId}/outcomes?score_kind=functional`);
    expect(trend.status).toBe(200);
    expect(trend.body.data.trend).toMatchObject({
      count: 2,
      first_score: 66,
      latest_score: 78,
      change: 12,
      direction: 'improved',
    });

    const events = await prisma.$queryRawUnsafe(
      `SELECT event_type, visible_to_patient
         FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND event_type LIKE 'physio.%'
        ORDER BY created_at, id`,
      TENANT_ID,
      patientUid,
    );
    expect(events.map((row) => row.event_type)).toEqual(expect.arrayContaining([
      'physio.assessment_recorded',
      'physio.therapy_plan_started',
      'physio.session_completed',
      'physio.outcome_score_recorded',
    ]));
    expect(events.every((row) => row.visible_to_patient === true)).toBe(true);
  });
});
