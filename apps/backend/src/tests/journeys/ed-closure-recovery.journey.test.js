import { jest } from '@jest/globals';

import {
  DEFAULT_TENANT,
  describeJourney,
  grantCareTeam,
  prisma,
  roleClient,
  runSuffix,
  seedDoctor,
  seedTreatmentConsent,
  seedUser,
} from './_journeyHarness.js';
import { setTenantTx } from '../../lib/prisma.js';
import {
  EMERGENCY_ARRIVAL_TO_AFTERCARE_DEFINITION_V2,
  compileEmergencyArrivalToAftercareDefinitionV2,
} from '../../services/pathways/emergencyPathwayDefinition.js';
import { projectEmergencyPathwayEvent } from '../../services/pathways/emergencyPathwayProjector.js';
import { createPathwayActivationEvidenceCapabilityForTests } from '../../services/pathways/pathwayExecutorService.js';

const RUN = runSuffix();
const ADMIN_UID = `c5200001-0000-4000-8000-${RUN.padStart(12, '0')}`;
const ED_DOCTOR_UID = `c5200002-0000-4000-8000-${RUN.padStart(12, '0')}`;
const PATIENT_UID = `c5200003-0000-4000-8000-${RUN.padStart(12, '0')}`;
const ADMIN_PHONE = `+9196611${RUN}`;
const DOCTOR_PHONE = `+9196612${RUN}`;
const PATIENT_PHONE = `+9196613${RUN}`;
const DEPARTMENT = `J-ED-Closure-${RUN}`;
const PATHWAY_KEY = 'emergency_arrival_to_aftercare';
const compiledDefinition = compileEmergencyArrivalToAftercareDefinitionV2();
const activationCapability =
  createPathwayActivationEvidenceCapabilityForTests();

jest.setTimeout(90_000);

async function seedGovernedDefinition() {
  const existing = await prisma.$queryRawUnsafe(
    `SELECT definition.id,
            governance.id AS governance_id,
            (
              definition.steps = $4::jsonb
              AND definition.triggers = $5::jsonb
              AND definition.defaults = $6::jsonb
              AND definition.is_active = TRUE
              AND governance.governance_status = 'approved'
              AND governance.approved_at IS NOT NULL
              AND governance.definition_checksum = $7::text
              AND approval.status = 'approved'
              AND approval.decided_at IS NOT NULL
            ) AS exact_fixture
       FROM workflow_definitions AS definition
       JOIN care_pathway_definition_governance AS governance
         ON governance.tenant_id = definition.tenant_id
        AND governance.workflow_definition_id = definition.id
       JOIN approvals AS approval
         ON approval.tenant_id = governance.tenant_id
        AND approval.id = governance.approval_id
      WHERE definition.tenant_id = $1::uuid
        AND definition.workflow_key = $2::text
        AND definition.version = $3::integer
      LIMIT 2`,
    DEFAULT_TENANT,
    compiledDefinition.workflow_key,
    compiledDefinition.version,
    JSON.stringify(EMERGENCY_ARRIVAL_TO_AFTERCARE_DEFINITION_V2.steps),
    JSON.stringify(EMERGENCY_ARRIVAL_TO_AFTERCARE_DEFINITION_V2.triggers),
    JSON.stringify(EMERGENCY_ARRIVAL_TO_AFTERCARE_DEFINITION_V2.defaults),
    compiledDefinition.checksum,
  );
  if (
    existing.length > 1
    || (existing[0] && existing[0].exact_fixture !== true)
  ) {
    throw new Error(
      'Default tenant has a conflicting emergency pathway v2 fixture',
    );
  }
  if (existing[0]) return existing[0];

  return setTenantTx(DEFAULT_TENANT, async tx => {
    const definitions = await tx.$queryRawUnsafe(
      `INSERT INTO workflow_definitions
         (tenant_id, workflow_key, version, display_name, steps, triggers,
          defaults, is_active, created_by)
       VALUES
         ($1::uuid, $2::text, $3::integer, $4::text, $5::jsonb, $6::jsonb,
          $7::jsonb, TRUE, $8::uuid)
       RETURNING id`,
      DEFAULT_TENANT,
      compiledDefinition.workflow_key,
      compiledDefinition.version,
      `Emergency closure and recovery journey ${RUN}`,
      JSON.stringify(EMERGENCY_ARRIVAL_TO_AFTERCARE_DEFINITION_V2.steps),
      JSON.stringify(EMERGENCY_ARRIVAL_TO_AFTERCARE_DEFINITION_V2.triggers),
      JSON.stringify(EMERGENCY_ARRIVAL_TO_AFTERCARE_DEFINITION_V2.defaults),
      ED_DOCTOR_UID,
    );
    const definitionId = Number(definitions[0].id);
    const approvals = await tx.$queryRawUnsafe(
      `INSERT INTO approvals
         (tenant_id, approval_kind, subject_resource_type, subject_resource_id,
          required_approvers, required_role, status, approved_by, decided_by,
          decided_at, created_by, metadata)
       VALUES
         ($1::uuid, 'care_pathway_definition_governance',
          'care_pathway_definition', $2::text, 1, 'ADMIN', 'approved',
          jsonb_build_array(jsonb_build_object('uid', $3::text, 'at', NOW())),
          $3::uuid, NOW(), $3::uuid,
          jsonb_build_object(
            'care_pathway_definition_governance',
            jsonb_build_object('definition_checksum', $4::text)
          ))
       RETURNING id`,
      DEFAULT_TENANT,
      String(definitionId),
      ADMIN_UID,
      compiledDefinition.checksum,
    );
    const governance = await tx.$queryRawUnsafe(
      `INSERT INTO care_pathway_definition_governance
         (tenant_id, workflow_definition_id, clinical_owner_uid,
          operational_owner_uid, governance_status, approval_id, approved_by,
          approved_at, patient_visibility_policy_ref, definition_checksum)
       VALUES
         ($1::uuid, $2::integer, $3::uuid, $3::uuid, 'approved', $4::integer,
          $5::uuid, NOW(), 'released_ed_aftercare_test_policy', $6::text)
       RETURNING id`,
      DEFAULT_TENANT,
      definitionId,
      ED_DOCTOR_UID,
      Number(approvals[0].id),
      ADMIN_UID,
      compiledDefinition.checksum,
    );
    return {
      id: definitionId,
      governance_id: governance[0].id,
      exact_fixture: true,
    };
  });
}

async function activatePathway() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT settings FROM tenants WHERE id = $1::uuid`,
    DEFAULT_TENANT,
  );
  await prisma.$executeRawUnsafe(
    `UPDATE tenants
        SET settings = COALESCE(settings, '{}'::jsonb)
          || jsonb_build_object(
               'care_pathways',
               COALESCE(
                 CASE
                   WHEN jsonb_typeof(settings -> 'care_pathways') = 'object'
                   THEN settings -> 'care_pathways'
                 END,
                 '{}'::jsonb
               )
               || jsonb_build_object($2::text, 'active'::text)
             ),
            updated_at = NOW()
      WHERE id = $1::uuid`,
    DEFAULT_TENANT,
    PATHWAY_KEY,
  );
  return rows[0]?.settings;
}

async function restoreSettings(settings) {
  await prisma.$executeRawUnsafe(
    `UPDATE tenants SET settings = $2::jsonb, updated_at = NOW()
      WHERE id = $1::uuid`,
    DEFAULT_TENANT,
    JSON.stringify(settings || {}),
  );
}

async function projectLatestEvent(emergencyVisitId, eventType, toStatus = null) {
  return setTenantTx(DEFAULT_TENANT, async tx => {
    const events = await tx.$queryRawUnsafe(
      `SELECT *
         FROM event_outbox
        WHERE tenant_id = $1::uuid
          AND event_type = $2::text
          AND aggregate_type = 'emergency_visit'
          AND aggregate_id = $3::integer::text
          AND payload ->> 'emergency_visit_id' = $3::integer::text
          AND ($4::text IS NULL OR payload ->> 'to_status' = $4::text)
        ORDER BY id DESC
        LIMIT 1`,
      DEFAULT_TENANT,
      eventType,
      emergencyVisitId,
      toStatus,
    );
    expect(events).toHaveLength(1);
    return projectEmergencyPathwayEvent({
      tx,
      consumerKey: 'care_pathway_projector',
      generation: 6,
      tenantId: DEFAULT_TENANT,
      event: events[0],
      activationEvidenceCapability: activationCapability,
    });
  });
}

describeJourney('Journey: ED discharge closure and patient aftercare', () => {
  let doctor;
  let patient;
  let emergencyVisitId;
  let pathwayInstanceId;
  let settingsBefore;

  beforeAll(async () => {
    await seedUser({
      uid: ADMIN_UID,
      phone: ADMIN_PHONE,
      name: `ED Closure Admin ${RUN}`,
      role: 'ADMIN',
    });
    const doctorRow = await seedDoctor({
      uid: ED_DOCTOR_UID,
      phone: DOCTOR_PHONE,
      name: `Dr ED Closure ${RUN}`,
      department: DEPARTMENT,
    });
    const patientRow = await seedUser({
      uid: PATIENT_UID,
      phone: PATIENT_PHONE,
      name: `ED Closure Patient ${RUN}`,
      role: 'PATIENT',
    });
    await seedTreatmentConsent(PATIENT_UID);
    await grantCareTeam({
      patientUid: PATIENT_UID,
      staffUid: ED_DOCTOR_UID,
      staffRole: 'DOCTOR',
      memberName: `Dr ED Closure ${RUN}`,
    });
    doctor = roleClient('DOCTOR', {
      uid: ED_DOCTOR_UID,
      id: doctorRow.userId,
      phone: DOCTOR_PHONE,
    });
    patient = roleClient('PATIENT', {
      uid: PATIENT_UID,
      id: patientRow.id,
      phone: PATIENT_PHONE,
    });
    await seedGovernedDefinition();
    settingsBefore = await activatePathway();
  });

  afterAll(async () => {
    try {
      if (settingsBefore !== undefined) {
        await restoreSettings(settingsBefore);
      }
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  });

  it('blocks discharge until exact evidence, completes its task, and releases only safe next steps', async () => {
    const created = await doctor.post('/api/v1/ed/visits').send({
      visit_number: `ED-CLOSURE-${RUN}`,
      patient_uid: PATIENT_UID,
      attending_doctor_uid: ED_DOCTOR_UID,
      arrival_mode: 'walk_in',
      chief_complaint: 'Review and discharge when safe',
    });
    expect(created.statusCode).toBe(201);
    emergencyVisitId = Number(created.body.data.id);

    const projectedArrival = await projectLatestEvent(
      emergencyVisitId,
      'emergency.visit.created',
      'arriving',
    );
    pathwayInstanceId = projectedArrival.pathway_instance_id;

    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, patient_uid,
          related_resource_type, related_resource_id, priority,
          assigned_to_uid, sla_completion_semantics, metadata)
       VALUES
         ($1::uuid, 'ed_closure_review', 'Forged ED closure review',
          $2::uuid, 'emergency_visit_closure', $3::integer::text, 'normal',
          $4::uuid, 'none',
          jsonb_build_object(
            'task_contract', 'ed_closure_review_v1',
            'emergency_visit_id', $3::integer,
            'canonical_encounter_id', $5::text,
            'care_pathway_instance_id', $6::text,
            'created_by_system_key', 'emergency.pathway_projector.v2'
          ))`,
      DEFAULT_TENANT,
      PATIENT_UID,
      emergencyVisitId,
      ADMIN_UID,
      created.body.data.encounter_id,
      pathwayInstanceId,
    )).rejects.toThrow(/ED closure review task binding is noncanonical/);

    for (const nextStatus of [
      'in_triage',
      'in_treatment',
      'awaiting_disposition',
    ]) {
      const transitioned = await doctor
        .patch(`/api/v1/ed/visits/${emergencyVisitId}/transition`)
        .send({ next_status: nextStatus });
      expect(transitioned.statusCode).toBe(200);
      await projectLatestEvent(
        emergencyVisitId,
        'emergency.visit.transitioned',
        nextStatus,
      );
    }

    const tasksBefore = await prisma.$queryRawUnsafe(
      `SELECT id, status, task_kind, assigned_to_uid, assigned_to_role,
              due_at, workflow_sla_instance_id, sla_completion_semantics,
              metadata
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'emergency_visit_closure'
          AND related_resource_id = $2::integer::text
        ORDER BY id DESC
        LIMIT 1`,
      DEFAULT_TENANT,
      emergencyVisitId,
    );
    expect(tasksBefore).toHaveLength(1);
    expect(tasksBefore[0]).toMatchObject({
      status: 'open',
      task_kind: 'ed_closure_review',
      assigned_to_uid: ED_DOCTOR_UID,
      assigned_to_role: null,
      due_at: null,
      workflow_sla_instance_id: null,
      sla_completion_semantics: 'none',
      metadata: expect.objectContaining({
        task_contract: 'ed_closure_review_v1',
        care_pathway_instance_id: pathwayInstanceId,
      }),
    });

    const premature = await doctor
      .patch(`/api/v1/ed/visits/${emergencyVisitId}/transition`)
      .send({ next_status: 'discharged' });
    expect(premature.statusCode).toBeGreaterThanOrEqual(400);
    const unchanged = await prisma.$queryRawUnsafe(
      `SELECT status FROM emergency_visits
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      DEFAULT_TENANT,
      emergencyVisitId,
    );
    expect(unchanged[0].status).toBe('awaiting_disposition');

    const followUps = await prisma.$queryRawUnsafe(
      `INSERT INTO follow_up_plans
         (tenant_id, patient_uid, origin_kind, origin_resource_type,
          origin_resource_id, reason, status, due_at, created_by)
       VALUES
         ($1::uuid, $2::uuid, 'er_visit', 'emergency_visit',
          $3::integer::text, 'Review after ED discharge', 'scheduled',
          NOW() + INTERVAL '3 days', $4::uuid)
       RETURNING id`,
      DEFAULT_TENANT,
      PATIENT_UID,
      emergencyVisitId,
      ED_DOCTOR_UID,
    );
    const closure = await doctor
      .post(`/api/v1/ed/visits/${emergencyVisitId}/closure-evidence`)
      .set('Idempotency-Key', `ed-discharge-closure-${RUN}`)
      .send({
        closure_kind: 'discharge',
        follow_up_required: true,
        follow_up_plan_id: Number(followUps[0].id),
        patient_safe_next_steps: [{
          label: 'Attend your ED follow-up',
          explanation: 'Please attend the scheduled review.',
          status: 'scheduled',
          patient_action: 'Open appointments',
          route_token: 'appointments',
        }],
        medication_not_applicable_reason: 'No medicines were prescribed',
        identity_resolution_status: 'verified',
      });
    expect(closure.statusCode).toBe(201);
    expect(closure.body.data).toMatchObject({
      replayed: false,
      closure_evidence: {
        closure_kind: 'discharge',
        evidence_revision: 1,
        patient_visibility_status: 'released',
      },
    });

    const discharged = await doctor
      .patch(`/api/v1/ed/visits/${emergencyVisitId}/transition`)
      .send({ next_status: 'discharged' });
    expect(discharged.statusCode).toBe(200);
    expect(discharged.body.data.status).toBe('discharged');
    await projectLatestEvent(
      emergencyVisitId,
      'emergency.visit.transitioned',
      'discharged',
    );

    const closed = await prisma.$queryRawUnsafe(
      `SELECT pathway.clinical_status,
              pathway.closed_at,
              run.status AS run_status,
              task.status AS task_status
         FROM care_pathway_instances AS pathway
         JOIN workflow_runs AS run
           ON run.tenant_id = pathway.tenant_id
          AND run.id = pathway.workflow_run_id
         JOIN tasks AS task
           ON task.tenant_id = pathway.tenant_id
          AND task.related_resource_type = 'emergency_visit_closure'
          AND task.related_resource_id = pathway.source_episode_id
        WHERE pathway.tenant_id = $1::uuid
          AND pathway.id = $2::uuid
        ORDER BY task.id DESC
        LIMIT 1`,
      DEFAULT_TENANT,
      pathwayInstanceId,
    );
    expect(closed[0]).toMatchObject({
      clinical_status: 'completed',
      run_status: 'completed',
      task_status: 'completed',
    });
    expect(closed[0].closed_at).not.toBeNull();

    const whatsNext = await patient.get('/api/v1/patient/care-plans/whats-next');
    expect(whatsNext.statusCode).toBe(200);
    expect(whatsNext.body.data.next_steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Attend your ED follow-up',
          explanation: 'Please attend the scheduled review.',
          status: 'scheduled',
          route_token: 'appointments',
        }),
      ]),
    );
    expect(JSON.stringify(whatsNext.body.data)).not.toMatch(
      /risk_summary|staff_notes|mlc_record_id|death_record_id/,
    );
  });
});
