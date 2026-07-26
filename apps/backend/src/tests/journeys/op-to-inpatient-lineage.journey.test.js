import { jest } from '@jest/globals';

import {
  DEFAULT_TENANT,
  describeJourney,
  hospitalDateOffset,
  prisma,
  roleClient,
  runSuffix,
  seedDoctor,
  seedTreatmentConsent,
  seedUser,
  seedWardWithBeds,
} from './_journeyHarness.js';
import { setTenantTx } from '../../lib/prisma.js';
import appointmentService from '../../services/appointment/appointmentService.js';
import {
  createPathwayActivationEvidenceCapabilityForTests,
} from '../../services/pathways/pathwayExecutorService.js';
import {
  OP_CONTACT_TO_RECOVERY_DEFINITION,
  compileOpContactToRecoveryDefinition,
} from '../../services/pathways/opPathwayDefinition.js';
import { projectOpPathwayEvent } from '../../services/pathways/opPathwayProjector.js';

const RUN = runSuffix();
const ADMIN_UID = `c4100001-0000-4000-8000-${RUN.padStart(12, '0')}`;
const SENDER_UID = `c4100002-0000-4000-8000-${RUN.padStart(12, '0')}`;
const RECIPIENT_UID = `c4100003-0000-4000-8000-${RUN.padStart(12, '0')}`;
const PATIENT_UID = `c4100004-0000-4000-8000-${RUN.padStart(12, '0')}`;
const DEPARTMENT = `J-OP-IP-${RUN}`;
const WARD_NAME = `J-OP-IP-Ward-${RUN}`;
const BED_NUMBER = `J-OP-IP-Bed-${RUN}`;
const PATIENT_PHONE = `96501${RUN}`;
const ADMIN_PHONE = `+9196502${RUN}`;
const SENDER_PHONE = `+9196503${RUN}`;
const RECIPIENT_PHONE = `+9196504${RUN}`;
const OP_PATHWAY_KEY = 'op_contact_to_recovery';
const INPATIENT_PATHWAY_KEY = 'inpatient_admission_to_recovery';
const compiledOpDefinition = compileOpContactToRecoveryDefinition();
const activationCapability = createPathwayActivationEvidenceCapabilityForTests();

jest.setTimeout(60_000);

async function seedGovernedOpDefinition() {
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
    compiledOpDefinition.workflow_key,
    compiledOpDefinition.version,
    JSON.stringify(OP_CONTACT_TO_RECOVERY_DEFINITION.steps),
    JSON.stringify(OP_CONTACT_TO_RECOVERY_DEFINITION.triggers),
    JSON.stringify(OP_CONTACT_TO_RECOVERY_DEFINITION.defaults),
    compiledOpDefinition.checksum,
  );
  if (existing.length > 1 || (existing[0] && existing[0].exact_fixture !== true)) {
    throw new Error('Default tenant has a conflicting OP pathway definition fixture');
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
      compiledOpDefinition.workflow_key,
      compiledOpDefinition.version,
      `OP contact-to-inpatient journey ${RUN}`,
      JSON.stringify(OP_CONTACT_TO_RECOVERY_DEFINITION.steps),
      JSON.stringify(OP_CONTACT_TO_RECOVERY_DEFINITION.triggers),
      JSON.stringify(OP_CONTACT_TO_RECOVERY_DEFINITION.defaults),
      SENDER_UID,
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
      compiledOpDefinition.checksum,
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
      SENDER_UID,
      Number(approvals[0].id),
      ADMIN_UID,
      compiledOpDefinition.checksum,
    );
    return {
      id: definitionId,
      governance_id: governance[0].id,
      approval_id: Number(approvals[0].id),
      exact_fixture: true,
    };
  });
}

async function activatePathways() {
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
               || jsonb_build_object(
                    $2::text, 'active'::text,
                    $3::text, 'active'::text
                  )
             ),
            updated_at = NOW()
      WHERE id = $1::uuid`,
    DEFAULT_TENANT,
    OP_PATHWAY_KEY,
    INPATIENT_PATHWAY_KEY,
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

async function projectLatestOpEvent(appointmentId, eventType) {
  return setTenantTx(DEFAULT_TENANT, async tx => {
    const events = await tx.$queryRawUnsafe(
      `SELECT *
         FROM event_outbox
        WHERE tenant_id = $1::uuid
          AND event_type = $2::text
          AND aggregate_type = 'appointment'
          AND aggregate_id = $3::text
          AND payload ->> 'appointment_id' = $3::text
        ORDER BY id DESC
        LIMIT 1`,
      DEFAULT_TENANT,
      eventType,
      String(appointmentId),
    );
    expect(events).toHaveLength(1);
    return projectOpPathwayEvent({
      tx,
      consumerKey: 'care_pathway_projector',
      generation: 4,
      tenantId: DEFAULT_TENANT,
      event: events[0],
      activationEvidenceCapability: activationCapability,
    });
  });
}

describeJourney('Journey: OP-to-inpatient exact lineage', () => {
  let admin;
  let sender;
  let recipient;
  let adminId;
  let senderId;
  let recipientId;
  let patientId;
  let bedId;
  let appointmentId;
  let pathwayInstanceId;
  let acceptedHandoffId;
  let admissionId;
  let settingsBefore;

  beforeAll(async () => {
    const adminRow = await seedUser({
      uid: ADMIN_UID,
      phone: ADMIN_PHONE,
      name: `Journey Admin ${RUN}`,
      role: 'ADMIN',
    });
    const senderRow = await seedDoctor({
      uid: SENDER_UID,
      phone: SENDER_PHONE,
      name: `Dr OP Sender ${RUN}`,
      department: DEPARTMENT,
    });
    const recipientRow = await seedDoctor({
      uid: RECIPIENT_UID,
      phone: RECIPIENT_PHONE,
      name: `Dr IP Recipient ${RUN}`,
      department: DEPARTMENT,
    });
    const patientRow = await seedUser({
      uid: PATIENT_UID,
      phone: `+91${PATIENT_PHONE}`,
      name: `OP IP Patient ${RUN}`,
      role: 'PATIENT',
    });
    adminId = adminRow.id;
    senderId = senderRow.userId;
    recipientId = recipientRow.userId;
    patientId = patientRow.id;
    await seedTreatmentConsent(PATIENT_UID);
    const ward = await seedWardWithBeds({
      wardName: WARD_NAME,
      bedNumbers: [BED_NUMBER],
    });
    [bedId] = ward.bedIds;

    admin = roleClient('ADMIN', { uid: ADMIN_UID, id: adminId });
    sender = roleClient('DOCTOR', {
      uid: SENDER_UID,
      id: senderId,
      phone: SENDER_PHONE,
    });
    recipient = roleClient('DOCTOR', {
      uid: RECIPIENT_UID,
      id: recipientId,
      phone: RECIPIENT_PHONE,
    });

    await seedGovernedOpDefinition();
    settingsBefore = await activatePathways();
  });

  afterAll(async () => {
    // The exact lineage graph is intentionally immutable, including in tests.
    // The isolated CI/scratch database owns fixture reclamation; this suite
    // only restores the tenant control-plane setting it changed.
    try {
      if (settingsBefore !== undefined) {
        await restoreTenantSettings(settingsBefore);
      }
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  });

  it('projects, transfers, admits, and closes without patient/time inference', async () => {
    const appointmentDate = await hospitalDateOffset(1);
    const created = await appointmentService.createAppointment({
      patient_id: patientId,
      doctor_id: senderId,
      appointment_date: appointmentDate,
      appointment_time: '10:20',
      reason: 'Admission review',
      department: DEPARTMENT,
      visit_type: 'NEW',
      tenant_id: DEFAULT_TENANT,
    }, {
      actorUid: SENDER_UID,
      actorId: senderId,
      actorRole: 'DOCTOR',
      source: 'journey_op_to_inpatient',
    });
    appointmentId = Number(created.id);

    const immediateComplete = await sender
      .post(`/api/v1/appointments/${appointmentId}/complete`)
      .send({ notes: 'Must wait for exact OP projection' });
    expect(immediateComplete.statusCode).toBe(409);
    expect(immediateComplete.body.code).toBe('APPOINTMENT_PATHWAY_WORK_BLOCKED');
    const stillScheduled = await prisma.$queryRawUnsafe(
      `SELECT status FROM appointments
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      DEFAULT_TENANT,
      appointmentId,
    );
    expect(stillScheduled[0].status).toBe('SCHEDULED');

    const projected = await projectLatestOpEvent(
      appointmentId,
      'appointment.created',
    );
    pathwayInstanceId = projected.pathway_instance_id;
    expect(pathwayInstanceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const advised = await sender
      .post(`/api/v1/appointments/${appointmentId}/advise-admission`)
      .send({ note: 'Named inpatient physician review required' });
    expect(advised.statusCode).toBe(200);

    const requestAttempts = await Promise.all([
      sender
        .post(`/api/v1/appointments/${appointmentId}/inpatient-transfer-requests`)
        .set('Idempotency-Key', `journey-transfer-request-a-${RUN}`)
        .send({
          intended_recipient_uid: RECIPIENT_UID,
          reason: 'Accept inpatient clinical ownership',
        }),
      sender
        .post(`/api/v1/appointments/${appointmentId}/inpatient-transfer-requests`)
        .set('Idempotency-Key', `journey-transfer-request-b-${RUN}`)
        .send({
          intended_recipient_uid: RECIPIENT_UID,
          reason: 'Accept inpatient clinical ownership',
        }),
    ]);
    const requestWinner = requestAttempts.find(response => response.statusCode === 201);
    const requestLoser = requestAttempts.find(response => response.statusCode === 409);
    expect(requestWinner).toBeDefined();
    expect(requestLoser).toBeDefined();
    const requestData = requestWinner.body.data;
    expect(Object.keys(requestData).sort()).toEqual([
      'admission_source',
      'handoff',
      'replayed',
      'task',
      'transition',
    ]);
    expect(JSON.stringify(requestData)).not.toContain(PATIENT_UID);
    const requestKey = requestAttempts[0] === requestWinner
      ? `journey-transfer-request-a-${RUN}`
      : `journey-transfer-request-b-${RUN}`;
    const handoffId = requestData.handoff.id;
    expect(requestData.admission_source).toMatchObject({
      appointment_id: appointmentId,
      source_pathway_instance_id: pathwayInstanceId,
      source_handoff_id: handoffId,
      accepted_recipient_uid: null,
    });
    const requestReplay = await sender
      .post(`/api/v1/appointments/${appointmentId}/inpatient-transfer-requests`)
      .set('Idempotency-Key', requestKey)
      .send({
        intended_recipient_uid: RECIPIENT_UID,
        reason: 'Accept inpatient clinical ownership',
      });
    expect(requestReplay.statusCode).toBe(200);
    expect(requestReplay.body.data).toMatchObject({
      replayed: true,
      handoff: { id: handoffId, status: 'requested' },
    });

    const acceptAttempts = await Promise.all([
      recipient
        .post(
          `/api/v1/appointments/${appointmentId}/inpatient-transfer-requests/${handoffId}/accept`,
        )
        .set('Idempotency-Key', `journey-transfer-accept-a-${RUN}`)
        .send({}),
      recipient
        .post(
          `/api/v1/appointments/${appointmentId}/inpatient-transfer-requests/${handoffId}/accept`,
        )
        .set('Idempotency-Key', `journey-transfer-accept-b-${RUN}`)
        .send({}),
    ]);
    const acceptWinner = acceptAttempts.find(response => response.statusCode === 200);
    const acceptLoser = acceptAttempts.find(response => response.statusCode === 409);
    expect(acceptWinner).toBeDefined();
    expect(acceptLoser).toBeDefined();
    const acceptData = acceptWinner.body.data;
    acceptedHandoffId = acceptData.handoff.id;
    expect(acceptData).toMatchObject({
      replayed: false,
      handoff: { id: handoffId, status: 'accepted' },
      task: { id: requestData.task.id, status: 'completed' },
      admission_source: {
        appointment_id: appointmentId,
        source_pathway_instance_id: pathwayInstanceId,
        source_handoff_id: handoffId,
        accepted_recipient_uid: RECIPIENT_UID,
      },
    });
    expect(JSON.stringify(acceptData)).not.toContain(PATIENT_UID);
    const acceptKey = acceptAttempts[0] === acceptWinner
      ? `journey-transfer-accept-a-${RUN}`
      : `journey-transfer-accept-b-${RUN}`;
    const acceptReplay = await recipient
      .post(
        `/api/v1/appointments/${appointmentId}/inpatient-transfer-requests/${handoffId}/accept`,
      )
      .set('Idempotency-Key', acceptKey)
      .send({});
    expect(acceptReplay.statusCode).toBe(200);
    expect(acceptReplay.body.data).toMatchObject({
      replayed: true,
      handoff: { id: handoffId, status: 'accepted' },
    });

    const omittedSource = await admin.post('/api/v1/emr/admit').send({
      patient_uid: PATIENT_UID,
      admitting_doctor: SENDER_UID,
      admission_advice_id: appointmentId,
      chief_complaint: 'Requires inpatient care',
      admitting_diagnosis: 'Observation after OP review',
      admission_type: 'elective',
      priority: 'routine',
      department: DEPARTMENT,
      bed_id: bedId,
      code_status: 'full_code',
    });
    expect(omittedSource.statusCode).toBe(409);
    expect(omittedSource.body.code).toBe('INPATIENT_SOURCE_TRANSFER_REQUIRED');

    const admitted = await admin.post('/api/v1/emr/admit').send({
      patient_uid: PATIENT_UID,
      admitting_doctor: SENDER_UID,
      admission_advice_id: appointmentId,
      source_pathway_instance_id: pathwayInstanceId,
      source_handoff_id: handoffId,
      chief_complaint: 'Requires inpatient care',
      admitting_diagnosis: 'Observation after OP review',
      admission_type: 'elective',
      priority: 'routine',
      department: DEPARTMENT,
      bed_id: bedId,
      code_status: 'full_code',
    });
    expect(admitted.statusCode).toBe(201);
    const admission = admitted.body.data?.admission;
    admissionId = Number(admission?.id);
    expect(admission).toMatchObject({
      id: admissionId,
      attending_doctor: RECIPIENT_UID,
      source_appointment_id: appointmentId,
      source_pathway_instance_id: pathwayInstanceId,
      source_handoff_id: handoffId,
    });

    const sourceRows = await prisma.$queryRawUnsafe(
      `SELECT source_appointment_id, source_pathway_instance_id,
              source_handoff_id, attending_doctor
         FROM admissions
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      DEFAULT_TENANT,
      admissionId,
    );
    expect(sourceRows[0]).toMatchObject({
      source_appointment_id: appointmentId,
      source_pathway_instance_id: pathwayInstanceId,
      source_handoff_id: handoffId,
      attending_doctor: RECIPIENT_UID,
    });
    const assignments = await prisma.$queryRawUnsafe(
      `SELECT physician_uid, assignment_source
         FROM inpatient_primary_physician_assignments
        WHERE tenant_id = $1::uuid
          AND admission_id = $2::integer
          AND patient_uid = $3::uuid
        ORDER BY assignment_version`,
      DEFAULT_TENANT,
      admissionId,
      PATIENT_UID,
    );
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      physician_uid: RECIPIENT_UID,
      assignment_source: 'attending_physician',
    });

    const completed = await sender
      .post(`/api/v1/appointments/${appointmentId}/complete`)
      .send({ notes: 'Transferred to the accepted inpatient owner' });
    expect(completed.statusCode).toBe(200);
    await projectLatestOpEvent(appointmentId, 'appointment.completed');

    const closurePayload = {
      follow_up_required: false,
      patient_safe_next_steps: [{
        label: 'Continue care with the inpatient team',
        explanation: 'Your accepted inpatient doctor will guide the next steps.',
        status: 'in_progress',
        patient_action: 'Follow the inpatient team instructions.',
        route_token: 'health',
      }],
      closure_basis: 'accepted_transfer',
      accepted_handoff_id: acceptedHandoffId,
      idempotency_key: `journey-op-closure-${RUN}`,
    };
    const closure = await sender
      .post(`/api/v1/appointments/${appointmentId}/closure-evidence`)
      .send(closurePayload);
    expect(closure.statusCode).toBe(201);
    expect(closure.body.data).toMatchObject({
      replayed: false,
      closure_evidence: {
        revision: 1,
        clinician_uid: SENDER_UID,
        follow_up_required: false,
        follow_up_plan_id: null,
        closure_basis: 'accepted_transfer',
        accepted_handoff_id: handoffId,
      },
    });
    const closureReplay = await sender
      .post(`/api/v1/appointments/${appointmentId}/closure-evidence`)
      .send(closurePayload);
    expect(closureReplay.statusCode).toBe(200);
    expect(closureReplay.body.data).toMatchObject({
      replayed: true,
      closure_evidence: { id: closure.body.data.closure_evidence.id },
    });
    await projectLatestOpEvent(
      appointmentId,
      'appointment.closure_evidence_recorded',
    );

    const finalOpRows = await prisma.$queryRawUnsafe(
      `SELECT clinical_status, owning_clinician_uid
         FROM care_pathway_instances
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND patient_uid = $3::uuid
          AND source_episode_type = 'appointment'
          AND source_episode_id = $4::text`,
      DEFAULT_TENANT,
      pathwayInstanceId,
      PATIENT_UID,
      String(appointmentId),
    );
    expect(finalOpRows).toHaveLength(1);
    expect(finalOpRows[0]).toMatchObject({
      clinical_status: 'completed',
      owning_clinician_uid: SENDER_UID,
    });
    const transferCounts = await prisma.$queryRawUnsafe(
      `SELECT
          COUNT(*)::integer AS handoff_count,
          COUNT(DISTINCT task_id)::integer AS task_count
         FROM care_handoff_instances
        WHERE tenant_id = $1::uuid
          AND sending_pathway_instance_id = $2::uuid
          AND handoff_type = 'op_to_inpatient_transfer'`,
      DEFAULT_TENANT,
      pathwayInstanceId,
    );
    expect(transferCounts[0]).toEqual({
      handoff_count: 1,
      task_count: 1,
    });
    const transitionCounts = await prisma.$queryRawUnsafe(
      `SELECT transition_key, COUNT(*)::integer AS count
         FROM care_pathway_transition_events
        WHERE tenant_id = $1::uuid
          AND pathway_instance_id = $2::uuid
          AND transition_key IN (
            'op_to_inpatient_transfer_requested',
            'op_to_inpatient_transfer_accepted'
          )
        GROUP BY transition_key`,
      DEFAULT_TENANT,
      pathwayInstanceId,
    );
    expect(
      Object.fromEntries(
        transitionCounts.map(row => [row.transition_key, row.count]),
      ),
    ).toEqual({
      op_to_inpatient_transfer_requested: 1,
      op_to_inpatient_transfer_accepted: 1,
    });
  });
});
