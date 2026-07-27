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
  seedWardWithBeds,
} from './_journeyHarness.js';
import { setTenantTx } from '../../lib/prisma.js';
import {
  EMERGENCY_ARRIVAL_TO_AFTERCARE_DEFINITION,
  compileEmergencyArrivalToAftercareDefinition,
} from '../../services/pathways/emergencyPathwayDefinition.js';
import { projectEmergencyPathwayEvent } from '../../services/pathways/emergencyPathwayProjector.js';
import { createPathwayActivationEvidenceCapabilityForTests } from '../../services/pathways/pathwayExecutorService.js';

const RUN = runSuffix();
const ADMIN_UID = `c5100001-0000-4000-8000-${RUN.padStart(12, '0')}`;
const ED_DOCTOR_UID = `c5100002-0000-4000-8000-${RUN.padStart(12, '0')}`;
const RECEIVING_NURSE_UID = `c5100003-0000-4000-8000-${RUN.padStart(12, '0')}`;
const PATIENT_UID = `c5100004-0000-4000-8000-${RUN.padStart(12, '0')}`;
const DEPARTMENT = `J-ED-Handoff-${RUN}`;
const WARD_NAME = `J-ED-Handoff-Ward-${RUN}`;
const BED_NUMBER = `JEDH-${RUN}`;
const ADMIN_PHONE = `+9196601${RUN}`;
const DOCTOR_PHONE = `+9196602${RUN}`;
const NURSE_PHONE = `+9196603${RUN}`;
const PATIENT_PHONE = `+9196604${RUN}`;
const PATHWAY_KEY = 'emergency_arrival_to_aftercare';
const compiledEmergencyDefinition =
  compileEmergencyArrivalToAftercareDefinition();
const activationCapability =
  createPathwayActivationEvidenceCapabilityForTests();

jest.setTimeout(60_000);

async function seedGovernedEmergencyDefinition() {
  const existing = await prisma.$queryRawUnsafe(
    `SELECT definition.id,
            governance.id AS governance_id,
            governance.approval_id,
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
    compiledEmergencyDefinition.workflow_key,
    compiledEmergencyDefinition.version,
    JSON.stringify(EMERGENCY_ARRIVAL_TO_AFTERCARE_DEFINITION.steps),
    JSON.stringify(EMERGENCY_ARRIVAL_TO_AFTERCARE_DEFINITION.triggers),
    JSON.stringify(EMERGENCY_ARRIVAL_TO_AFTERCARE_DEFINITION.defaults),
    compiledEmergencyDefinition.checksum,
  );
  if (
    existing.length > 1
    || (existing[0] && existing[0].exact_fixture !== true)
  ) {
    throw new Error(
      'Default tenant has a conflicting emergency pathway definition fixture',
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
      compiledEmergencyDefinition.workflow_key,
      compiledEmergencyDefinition.version,
      `Emergency arrival-to-destination journey ${RUN}`,
      JSON.stringify(EMERGENCY_ARRIVAL_TO_AFTERCARE_DEFINITION.steps),
      JSON.stringify(EMERGENCY_ARRIVAL_TO_AFTERCARE_DEFINITION.triggers),
      JSON.stringify(EMERGENCY_ARRIVAL_TO_AFTERCARE_DEFINITION.defaults),
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
      compiledEmergencyDefinition.checksum,
    );
    const governance = await tx.$queryRawUnsafe(
      `INSERT INTO care_pathway_definition_governance
         (tenant_id, workflow_definition_id, clinical_owner_uid,
          operational_owner_uid, governance_status, approval_id, approved_by,
          approved_at, patient_visibility_policy_ref, definition_checksum)
       VALUES
         ($1::uuid, $2::integer, $3::uuid, $3::uuid, 'approved', $4::integer,
          $5::uuid, NOW(), 'staff_only_test_policy', $6::text)
       RETURNING id`,
      DEFAULT_TENANT,
      definitionId,
      ED_DOCTOR_UID,
      Number(approvals[0].id),
      ADMIN_UID,
      compiledEmergencyDefinition.checksum,
    );
    return {
      id: definitionId,
      governance_id: governance[0].id,
      approval_id: Number(approvals[0].id),
      exact_fixture: true,
    };
  });
}

async function activateEmergencyPathway() {
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

async function restoreTenantSettings(settings) {
  await prisma.$executeRawUnsafe(
    `UPDATE tenants SET settings = $2::jsonb, updated_at = NOW()
      WHERE id = $1::uuid`,
    DEFAULT_TENANT,
    JSON.stringify(settings || {}),
  );
}

async function projectLatestEmergencyEvent(
  emergencyVisitId,
  eventType,
  toStatus,
) {
  return setTenantTx(DEFAULT_TENANT, async tx => {
    const events = await tx.$queryRawUnsafe(
      `SELECT *
         FROM event_outbox
        WHERE tenant_id = $1::uuid
          AND event_type = $2::text
          AND aggregate_type = 'emergency_visit'
          AND aggregate_id = $3::integer::text
          AND payload ->> 'emergency_visit_id' = $3::integer::text
          AND payload ->> 'to_status' = $4::text
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
      generation: 5,
      tenantId: DEFAULT_TENANT,
      event: events[0],
      activationEvidenceCapability: activationCapability,
    });
  });
}

describeJourney('Journey: ED destination handoff to admission', () => {
  let admin;
  let doctor;
  let receivingNurse;
  let bedId;
  let emergencyVisitId;
  let pathwayInstanceId;
  let handoffId;
  let settingsBefore;

  beforeAll(async () => {
    const adminRow = await seedUser({
      uid: ADMIN_UID,
      phone: ADMIN_PHONE,
      name: `ED Journey Admin ${RUN}`,
      role: 'ADMIN',
    });
    const doctorRow = await seedDoctor({
      uid: ED_DOCTOR_UID,
      phone: DOCTOR_PHONE,
      name: `Dr ED Owner ${RUN}`,
      department: DEPARTMENT,
    });
    const nurseRow = await seedUser({
      uid: RECEIVING_NURSE_UID,
      phone: NURSE_PHONE,
      name: `Receiving Nurse ${RUN}`,
      role: 'NURSING_STAFF',
    });
    await seedUser({
      uid: PATIENT_UID,
      phone: PATIENT_PHONE,
      name: `ED Handoff Patient ${RUN}`,
      role: 'PATIENT',
    });
    await seedTreatmentConsent(PATIENT_UID);
    const ward = await seedWardWithBeds({
      wardName: WARD_NAME,
      bedNumbers: [BED_NUMBER],
    });
    [bedId] = ward.bedIds;

    admin = roleClient('ADMIN', { uid: ADMIN_UID, id: adminRow.id });
    doctor = roleClient('DOCTOR', {
      uid: ED_DOCTOR_UID,
      id: doctorRow.userId,
      phone: DOCTOR_PHONE,
    });
    receivingNurse = roleClient('NURSING_STAFF', {
      uid: RECEIVING_NURSE_UID,
      id: nurseRow.id,
      phone: NURSE_PHONE,
    });
    await grantCareTeam({
      patientUid: PATIENT_UID,
      staffUid: ED_DOCTOR_UID,
      staffRole: 'DOCTOR',
      memberName: `Dr ED Owner ${RUN}`,
    });
    await seedGovernedEmergencyDefinition();
    settingsBefore = await activateEmergencyPathway();
  });

  afterAll(async () => {
    try {
      if (settingsBefore !== undefined) {
        await restoreTenantSettings(settingsBefore);
      }
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  });

  it('requires exact receiving-role acceptance before linked admission closes the ED pathway', async () => {
    const created = await doctor.post('/api/v1/ed/visits').send({
      visit_number: `ED-HANDOFF-${RUN}`,
      patient_uid: PATIENT_UID,
      attending_doctor_uid: ED_DOCTOR_UID,
      arrival_mode: 'walk_in',
      chief_complaint: 'Requires monitored ward admission',
    });
    expect(created.statusCode).toBe(201);
    expect(created.body.data).toMatchObject({
      patient_uid: PATIENT_UID,
      attending_doctor_uid: ED_DOCTOR_UID,
      status: 'arriving',
      pathway_mode: 'active',
    });
    emergencyVisitId = Number(created.body.data.id);

    const projectedArrival = await projectLatestEmergencyEvent(
      emergencyVisitId,
      'emergency.visit.created',
      'arriving',
    );
    pathwayInstanceId = projectedArrival.pathway_instance_id;
    expect(pathwayInstanceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    for (const nextStatus of [
      'in_triage',
      'in_treatment',
      'awaiting_disposition',
    ]) {
      const transitioned = await doctor
        .patch(`/api/v1/ed/visits/${emergencyVisitId}/transition`)
        .send({ next_status: nextStatus });
      expect(transitioned.statusCode).toBe(200);
      expect(transitioned.body.data.status).toBe(nextStatus);
      await projectLatestEmergencyEvent(
        emergencyVisitId,
        'emergency.visit.transitioned',
        nextStatus,
      );
    }

    const requested = await doctor
      .post(`/api/v1/ed/visits/${emergencyVisitId}/destination-handoffs`)
      .set('Idempotency-Key', `ed-handoff-request-${RUN}`)
      .send({
        destination: 'ward',
        intended_recipient_role: 'NURSING_STAFF',
        reason: 'Accept monitored ward care responsibility',
      });
    expect(requested.statusCode).toBe(201);
    expect(requested.body.data).toMatchObject({
      replayed: false,
      handoff: {
        status: 'requested',
        destination: 'ward',
        intended_recipient_role: 'NURSING_STAFF',
      },
      task: {
        task_kind: 'ed_destination_handoff_review',
        priority: 'high',
        status: 'open',
        assigned_to_role: 'NURSING_STAFF',
      },
      destination_source: {
        emergency_visit_id: emergencyVisitId,
        source_pathway_instance_id: pathwayInstanceId,
      },
    });
    expect(requested.body.data.task).not.toHaveProperty('due_at');
    expect(JSON.stringify(requested.body.data)).not.toContain(PATIENT_UID);
    handoffId = requested.body.data.handoff.id;

    const requestReplay = await doctor
      .post(`/api/v1/ed/visits/${emergencyVisitId}/destination-handoffs`)
      .set('Idempotency-Key', `ed-handoff-request-${RUN}`)
      .send({
        destination: 'ward',
        intended_recipient_role: 'NURSING_STAFF',
        reason: 'Accept monitored ward care responsibility',
      });
    expect(requestReplay.statusCode).toBe(200);
    expect(requestReplay.body.data).toMatchObject({
      replayed: true,
      handoff: { id: handoffId, status: 'requested' },
    });

    const queue = await receivingNurse
      .get('/api/v1/ed/destination-handoffs?status=requested');
    expect(queue.statusCode).toBe(200);
    expect(queue.body.data).toMatchObject({
      actor_role: 'NURSING_STAFF',
      count: 1,
      handoffs: [{
        id: handoffId,
        emergency_visit_id: emergencyVisitId,
        can_decide: true,
        can_reroute: false,
      }],
    });

    const missingSourceAdmission = await admin.post('/api/v1/emr/admit').send({
      patient_uid: PATIENT_UID,
      admitting_doctor: ED_DOCTOR_UID,
      admission_type: 'emergency',
      priority: 'urgent',
      bed_id: bedId,
      from_er_visit_id: emergencyVisitId,
    });
    expect(missingSourceAdmission.statusCode).toBe(409);
    expect(missingSourceAdmission.body.code).toBe(
      'ED_ADMISSION_SOURCE_HANDOFF_REQUIRED',
    );

    const accepted = await receivingNurse
      .post(
        `/api/v1/ed/visits/${emergencyVisitId}/destination-handoffs/${handoffId}/decisions`,
      )
      .set('Idempotency-Key', `ed-handoff-accept-${RUN}`)
      .send({ decision: 'accept' });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.body.data).toMatchObject({
      replayed: false,
      handoff: {
        id: handoffId,
        status: 'accepted',
        accepted_by_uid: RECEIVING_NURSE_UID,
      },
      task: { status: 'completed' },
      destination_source: {
        emergency_visit_id: emergencyVisitId,
        source_pathway_instance_id: pathwayInstanceId,
        source_handoff_id: handoffId,
      },
    });

    const admitted = await admin.post('/api/v1/emr/admit').send({
      patient_uid: PATIENT_UID,
      admitting_doctor: ED_DOCTOR_UID,
      attending_doctor: ED_DOCTOR_UID,
      admission_type: 'emergency',
      priority: 'urgent',
      bed_id: bedId,
      from_er_visit_id: emergencyVisitId,
      source_pathway_instance_id: pathwayInstanceId,
      source_handoff_id: handoffId,
    });
    expect(admitted.statusCode).toBe(201);
    const admission = admitted.body.data?.admission;
    expect(admission).toMatchObject({
      patient_uid: PATIENT_UID,
      from_er_visit_id: emergencyVisitId,
      source_pathway_instance_id: pathwayInstanceId,
      source_handoff_id: handoffId,
      attending_doctor: ED_DOCTOR_UID,
    });

    await projectLatestEmergencyEvent(
      emergencyVisitId,
      'emergency.visit.destination_closed',
      'admitted',
    );
    const finalRows = await prisma.$queryRawUnsafe(
      `SELECT pathway.clinical_status,
              pathway.closed_at,
              run.status AS run_status,
              visit.status AS visit_status,
              visit.disposition,
              admission.source_pathway_instance_id,
              admission.source_handoff_id
         FROM care_pathway_instances AS pathway
         JOIN workflow_runs AS run
           ON run.tenant_id = pathway.tenant_id
          AND run.id = pathway.workflow_run_id
         JOIN emergency_visits AS visit
           ON visit.tenant_id = pathway.tenant_id
          AND visit.id::text = pathway.source_episode_id
         JOIN admissions AS admission
           ON admission.tenant_id = pathway.tenant_id
          AND admission.from_er_visit_id = visit.id
        WHERE pathway.tenant_id = $1::uuid
          AND pathway.id = $2::uuid
          AND admission.id = $3::integer`,
      DEFAULT_TENANT,
      pathwayInstanceId,
      Number(admission.id),
    );
    expect(finalRows).toHaveLength(1);
    expect(finalRows[0]).toMatchObject({
      clinical_status: 'completed',
      run_status: 'completed',
      visit_status: 'admitted',
      disposition: 'admitted',
      source_pathway_instance_id: pathwayInstanceId,
      source_handoff_id: handoffId,
    });
    expect(finalRows[0].closed_at).not.toBeNull();
  });
});
