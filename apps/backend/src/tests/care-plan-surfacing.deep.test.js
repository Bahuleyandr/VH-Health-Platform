import request from 'supertest';

import app from '../app.js';
import prisma from '../lib/prisma.js';
import { deleteWithAuditBypass } from './helpers/auditBypass.js';
import { API_KEY, generateTestToken } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'c4b20000-0000-4000-8000-000000000201';
const DOCTOR_UID = 'c4b20000-0000-4000-8000-000000000202';
const OTHER_DOCTOR_UID = 'c4b20000-0000-4000-8000-000000000203';

function auth(role, overrides = {}) {
  const token = generateTestToken(role, {
    tenant_id: TENANT_ID,
    tenantId: TENANT_ID,
    ...overrides,
  });
  return {
    get: (path) => request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (path) => request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    patch: (path) => request(app).patch(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function cleanup() {
  await deleteWithAuditBypass(
    prisma,
    `DELETE FROM patient_access_audit_log WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM care_plan_review_log
      WHERE care_plan_id IN (SELECT id FROM care_plans WHERE patient_uid = $1::uuid)`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM care_plan_activities
      WHERE care_plan_id IN (SELECT id FROM care_plans WHERE patient_uid = $1::uuid)`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM care_plan_goals
      WHERE care_plan_id IN (SELECT id FROM care_plans WHERE patient_uid = $1::uuid)`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM follow_up_plans WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM care_plans WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM care_team_members WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM care_teams WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
    PATIENT_UID,
    DOCTOR_UID,
    OTHER_DOCTOR_UID,
  ).catch(() => {});
}

d('Batch 4 item 2 — care-plan surfacing', () => {
  let doctorId;
  let visiblePlanId;
  let hiddenPlanId;
  let patientGoalId;
  let managedGoalId;
  let activityId;
  let previousMode;

  beforeAll(async () => {
    previousMode = process.env.CARE_TEAM_ENFORCEMENT_MODE;
    delete process.env.CARE_TEAM_ENFORCEMENT_MODE;
    await cleanup();

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, '+919400000201', 'Care Plan Surfacing Patient', 'PATIENT', true, $2::uuid, NOW())`,
      PATIENT_UID,
      TENANT_ID,
    );
    const doctorRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, '+919400000202', 'Dr Care Plan Surfacing', 'DOCTOR', true, $2::uuid, NOW())
       RETURNING id`,
      DOCTOR_UID,
      TENANT_ID,
    );
    doctorId = Number(doctorRows[0].id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, '+919400000203', 'Dr Care Plan Unrelated', 'DOCTOR', true, $2::uuid, NOW())`,
      OTHER_DOCTOR_UID,
      TENANT_ID,
    );

    const careTeam = await prisma.$queryRawUnsafe(
      `INSERT INTO care_teams
         (tenant_id, patient_uid, team_kind, display_name, status, created_by, updated_at)
       VALUES ($1::uuid, $2::uuid, 'longitudinal', 'Care plan surfacing team', 'active', $3::uuid, NOW())
       RETURNING id`,
      TENANT_ID,
      PATIENT_UID,
      DOCTOR_UID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO care_team_members
         (tenant_id, care_team_id, patient_uid, staff_uid, staff_role, member_name,
          relationship_kind, break_glass_allowed, created_by, updated_at)
       VALUES ($1::uuid, $2::int, $3::uuid, $4::uuid, 'DOCTOR', 'Dr Care Plan Surfacing',
               'attending_doctor', true, $4::uuid, NOW())`,
      TENANT_ID,
      careTeam[0].id,
      PATIENT_UID,
      DOCTOR_UID,
    );

    const visiblePlan = await prisma.$queryRawUnsafe(
      `INSERT INTO care_plans
         (tenant_id, patient_uid, plan_kind, primary_condition, display_name,
          description, status, start_date, primary_doctor_uid, is_patient_visible,
          metadata, created_by, updated_at)
       VALUES ($1::uuid, $2::uuid, 'chronic_disease', 'Diabetes', 'Diabetes care plan',
          'Patient-visible diabetes plan', 'active',
          (NOW() AT TIME ZONE 'Asia/Kolkata')::date, $3::uuid, TRUE,
          '{}'::jsonb, $3::uuid, NOW())
       RETURNING id`,
      TENANT_ID,
      PATIENT_UID,
      DOCTOR_UID,
    );
    visiblePlanId = Number(visiblePlan[0].id);

    const hiddenPlan = await prisma.$queryRawUnsafe(
      `INSERT INTO care_plans
         (tenant_id, patient_uid, plan_kind, primary_condition, display_name,
          description, status, start_date, primary_doctor_uid, is_patient_visible,
          metadata, created_by, updated_at)
       VALUES ($1::uuid, $2::uuid, 'general', 'Internal review', 'Hidden plan',
          'Staff-only plan', 'active',
          (NOW() AT TIME ZONE 'Asia/Kolkata')::date, $3::uuid, FALSE,
          '{}'::jsonb, $3::uuid, NOW())
       RETURNING id`,
      TENANT_ID,
      PATIENT_UID,
      DOCTOR_UID,
    );
    hiddenPlanId = Number(hiddenPlan[0].id);

    const patientGoalRows = await prisma.$queryRawUnsafe(
      `INSERT INTO care_plan_goals
         (tenant_id, care_plan_id, patient_uid, goal_kind, description,
          measurement_label, target_value, current_value, target_due_date,
          priority, status, metadata, updated_at)
       VALUES ($1::uuid, $2::int, $3::uuid, 'clinical_target', 'Keep fasting sugar under 110',
          'Fasting sugar', '110', '128',
          ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + INTERVAL '14 days')::date,
          'high', 'in_progress', '{}'::jsonb, NOW())
       RETURNING id`,
      TENANT_ID,
      visiblePlanId,
      PATIENT_UID,
    );
    patientGoalId = Number(patientGoalRows[0].id);

    const managedGoalRows = await prisma.$queryRawUnsafe(
      `INSERT INTO care_plan_goals
         (tenant_id, care_plan_id, patient_uid, goal_kind, description,
          measurement_label, target_value, current_value, target_due_date,
          priority, status, metadata, updated_at)
       VALUES ($1::uuid, $2::int, $3::uuid, 'lifestyle', 'Walk after dinner',
          'Walks', '5 days', '2 days',
          ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + INTERVAL '10 days')::date,
          'normal', 'in_progress', '{}'::jsonb, NOW())
       RETURNING id`,
      TENANT_ID,
      visiblePlanId,
      PATIENT_UID,
    );
    managedGoalId = Number(managedGoalRows[0].id);

    await prisma.$executeRawUnsafe(
      `INSERT INTO care_plan_goals
         (tenant_id, care_plan_id, patient_uid, goal_kind, description,
          priority, status, metadata, updated_at)
       VALUES ($1::uuid, $2::int, $3::uuid, 'education', 'Hidden education goal',
          'normal', 'planned', '{}'::jsonb, NOW())`,
      TENANT_ID,
      hiddenPlanId,
      PATIENT_UID,
    );

    const activityRows = await prisma.$queryRawUnsafe(
      `INSERT INTO care_plan_activities
         (tenant_id, care_plan_id, patient_uid, activity_kind, title,
          description, schedule_kind, status, is_patient_facing, metadata, updated_at)
       VALUES ($1::uuid, $2::int, $3::uuid, 'task', 'Review diet diary',
          'Discuss adherence and meal timing', 'weekly', 'planned', TRUE, '{}'::jsonb, NOW())
       RETURNING id`,
      TENANT_ID,
      visiblePlanId,
      PATIENT_UID,
    );
    activityId = Number(activityRows[0].id);

    await prisma.$executeRawUnsafe(
      `INSERT INTO follow_up_plans
         (tenant_id, patient_uid, origin_kind, doctor_uid, care_plan_id, due_at,
          reason, status, appointment_status, metadata, created_by, updated_at)
       VALUES ($1::uuid, $2::uuid, 'manual', $3::uuid, $4::int,
          NOW() + INTERVAL '7 days', 'Diabetes review', 'open', 'pending',
          '{}'::jsonb, $3::uuid, NOW())`,
      TENANT_ID,
      PATIENT_UID,
      DOCTOR_UID,
      visiblePlanId,
    );
  }, 30000);

  afterAll(async () => {
    if (previousMode === undefined) delete process.env.CARE_TEAM_ENFORCEMENT_MODE;
    else process.env.CARE_TEAM_ENFORCEMENT_MODE = previousMode;
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('staff can read bundled care plans and the governed guard writes allow audit', async () => {
    const res = await auth('DOCTOR', { uid: DOCTOR_UID, id: doctorId })
      .get(`/api/v1/staff/patients/${PATIENT_UID}/care-plans`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.care_plans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: visiblePlanId,
          goals: expect.arrayContaining([
            expect.objectContaining({ id: patientGoalId, description: 'Keep fasting sugar under 110' }),
          ]),
          activities: expect.arrayContaining([
            expect.objectContaining({ id: activityId, title: 'Review diet diary' }),
          ]),
        }),
      ]),
    );

    const auditRows = await prisma.$queryRawUnsafe(
      `SELECT access_decision, access_source, metadata->>'record_type' AS record_type
         FROM patient_access_audit_log
        WHERE patient_uid = $1::uuid AND actor_uid = $2::uuid
        ORDER BY created_at DESC
        LIMIT 1`,
      PATIENT_UID,
      DOCTOR_UID,
    );
    expect(auditRows[0]).toMatchObject({
      access_decision: 'allow',
      access_source: 'care_team',
      record_type: 'CARE_PLAN',
    });
  });

  it('staff can manage goals and activities through ID-scoped care-team guarded routes', async () => {
    const doctor = auth('DOCTOR', { uid: DOCTOR_UID, id: doctorId });

    const goalRes = await doctor
      .patch(`/api/v1/staff/care-plans/goals/${managedGoalId}/progress`)
      .send({ status: 'achieved', current_value: '104' });
    expect(goalRes.statusCode).toBe(200);
    expect(goalRes.body.data.status).toBe('achieved');
    expect(goalRes.body.data.current_value).toBe('104');

    const activityRes = await doctor
      .patch(`/api/v1/staff/care-plans/activities/${activityId}/complete`)
      .send({ status: 'completed' });
    expect(activityRes.statusCode).toBe(200);
    expect(activityRes.body.data.status).toBe('completed');
  });

  it('default shadow mode does not block unrelated staff but records the would-be denial', async () => {
    await deleteWithAuditBypass(
      prisma,
      `DELETE FROM patient_access_audit_log WHERE patient_uid = $1::uuid AND actor_uid = $2::uuid`,
      PATIENT_UID,
      OTHER_DOCTOR_UID,
    );

    const res = await auth('DOCTOR', { uid: OTHER_DOCTOR_UID })
      .get(`/api/v1/staff/care-plans/${visiblePlanId}`);

    expect(res.statusCode).toBe(200);
    const auditRows = await prisma.$queryRawUnsafe(
      `SELECT access_decision, metadata->>'shadow_mode' AS shadow_mode
         FROM patient_access_audit_log
        WHERE patient_uid = $1::uuid AND actor_uid = $2::uuid
        ORDER BY created_at DESC
        LIMIT 1`,
      PATIENT_UID,
      OTHER_DOCTOR_UID,
    );
    expect(auditRows[0]?.access_decision).toBe('deny');
    expect(auditRows[0]?.shadow_mode).toBe('true');
  });

  it('patient portal what-next only returns visible active goals plus open follow-ups', async () => {
    const res = await auth('PATIENT', { uid: PATIENT_UID })
      .get('/api/v1/portal/care-plans/whats-next');

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.goals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: patientGoalId,
        care_plan_id: visiblePlanId,
        care_plan_name: 'Diabetes care plan',
        description: 'Keep fasting sugar under 110',
      }),
    ]));
    expect(res.body.data.goals).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ care_plan_id: hiddenPlanId }),
      ]),
    );
    expect(res.body.data.follow_ups).toEqual([
      expect.objectContaining({
        care_plan_id: visiblePlanId,
        reason: 'Diabetes review',
        status: 'open',
      }),
    ]);
  });
});
