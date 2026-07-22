import { randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import radiologyService from '../../services/radiology/radiologyService.js';
import pathologyService from '../../services/pathology/pathologyService.js';
import {
  closeNormalDiagnosticGenerationIfEligible,
  recordDoctorDiagnosticDisposition,
  reopenNormalDiagnosticGeneration,
} from '../../services/diagnostics/diagnosticResultActionService.js';
import {
  createLabDiagnosticGenerationTx,
  createSharedInvestigationGenerationTx,
} from '../../services/diagnostics/diagnosticResultGenerationService.js';
import { runDiagnosticNormalReleaseSweep } from '../../services/diagnostics/diagnosticNormalReleaseSweepService.js';
import {
  createPathwayActivationEvidenceCapabilityForTests,
} from '../../services/pathways/pathwayExecutorService.js';
import {
  DIAGNOSTIC_ACTION_SLA_RULE_CODE,
  DIAGNOSTICS_ORDER_TO_ACTION_DEFINITION,
  compileDiagnosticsOrderToActionDefinition,
} from '../../services/pathways/diagnosticsPathwayDefinition.js';
import { projectDiagnosticPathwayEvent } from '../../services/pathways/diagnosticPathwayProjector.js';
import { COMMON_PATHWAY_RECONCILIATION_CHECKS } from '../../services/pathways/pathwayReconciliationChecks.js';
import { releaseResultNow } from '../../services/portal/portalAccessService.js';
import { workflowRuntimeRegistry } from '../../services/workflow/workflowRuntimeRegistry.js';
import { getInvestigationById } from '../../services/investigation/investigationService.js';
import { acknowledgeTask } from '../../services/workflow/taskService.js';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const activationCapability = createPathwayActivationEvidenceCapabilityForTests();

function token() {
  return randomUUID().replaceAll('-', '');
}

async function seedGovernedDiagnosticsFixture() {
  const tenantId = randomUUID();
  const patientUid = randomUUID();
  const doctorUid = randomUUID();
  const otherDoctorUid = randomUUID();
  const approverUid = randomUUID();
  const radiologistUid = randomUUID();
  const pathologistUid = randomUUID();
  const compiled = compileDiagnosticsOrderToActionDefinition();
  return setTenantTx(tenantId, async (tx) => {
    await tx.$queryRawUnsafe(
      `INSERT INTO tenants (id, slug, name, settings)
       VALUES ($1::uuid, $2::text, 'Diagnostic action deep test',
               jsonb_build_object(
                 'care_pathways', jsonb_build_object('diagnostics_order_to_action', 'active')
               ))`,
      tenantId,
      `diagnostic-actions-${token()}`,
    );
    await tx.$queryRawUnsafe(
      `INSERT INTO users (uid, tenant_id, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $7::uuid, 'Diagnostic Patient', 'PATIENT', TRUE, 'active', NOW()),
         ($2::uuid, $7::uuid, 'Ordering Doctor', 'DOCTOR', TRUE, 'active', NOW()),
         ($3::uuid, $7::uuid, 'Other Doctor', 'DOCTOR', TRUE, 'active', NOW()),
         ($4::uuid, $7::uuid, 'Governance Approver', 'ADMIN', TRUE, 'active', NOW()),
         ($5::uuid, $7::uuid, 'Diagnostic Radiologist', 'RADIOLOGIST', TRUE, 'active', NOW()),
         ($6::uuid, $7::uuid, 'Diagnostic Pathologist', 'PATHOLOGIST', TRUE, 'active', NOW())`,
      patientUid,
      doctorUid,
      otherDoctorUid,
      approverUid,
      radiologistUid,
      pathologistUid,
      tenantId,
    );
    const definitions = await tx.$queryRawUnsafe(
      `INSERT INTO workflow_definitions
         (tenant_id, workflow_key, version, display_name, steps, triggers, defaults,
          is_active, created_by)
       VALUES
         ($1::uuid, $2::text, $3::integer, 'Diagnostics order to action test',
          $4::jsonb, $5::jsonb, $6::jsonb, TRUE, $7::uuid)
       RETURNING id`,
      tenantId,
      compiled.workflow_key,
      compiled.version,
      JSON.stringify(DIAGNOSTICS_ORDER_TO_ACTION_DEFINITION.steps),
      JSON.stringify(DIAGNOSTICS_ORDER_TO_ACTION_DEFINITION.triggers),
      JSON.stringify(DIAGNOSTICS_ORDER_TO_ACTION_DEFINITION.defaults),
      doctorUid,
    );
    const definitionId = Number(definitions[0].id);
    const decidedAt = new Date(Date.now() - 120_000);
    const approvedAt = new Date(Date.now() - 60_000);
    const approvals = await tx.$queryRawUnsafe(
      `INSERT INTO approvals
         (tenant_id, approval_kind, subject_resource_type, subject_resource_id,
          required_approvers, required_role, status, approved_by, decided_by,
          decided_at, created_by, metadata)
       VALUES
         ($1::uuid, 'care_pathway_definition_governance', 'care_pathway_definition',
          $2::text, 1, 'ADMIN', 'approved', $3::jsonb, $4::uuid,
          $5::timestamptz, $4::uuid,
          jsonb_build_object(
            'care_pathway_definition_governance',
            jsonb_build_object('definition_checksum', $6::text)
          ))
       RETURNING id`,
      tenantId,
      String(definitionId),
      JSON.stringify([{ uid: approverUid, at: decidedAt.toISOString() }]),
      approverUid,
      decidedAt.toISOString(),
      compiled.checksum,
    );
    await tx.$queryRawUnsafe(
      `INSERT INTO care_pathway_definition_governance
         (tenant_id, workflow_definition_id, clinical_owner_uid, operational_owner_uid,
          governance_status, approval_id, approved_by, approved_at,
          patient_visibility_policy_ref, definition_checksum)
       VALUES
         ($1::uuid, $2::integer, $3::uuid, $3::uuid, 'approved', $4::integer,
          $5::uuid, $6::timestamptz, 'staff_only_test_policy', $7::text)`,
      tenantId,
      definitionId,
      doctorUid,
      Number(approvals[0].id),
      approverUid,
      approvedAt.toISOString(),
      compiled.checksum,
    );
    await tx.$queryRawUnsafe(
      `INSERT INTO workflow_sla_rules
         (tenant_id, rule_code, title, trigger_event_type, target_minutes,
          severity, owner_role_codes, escalation_role_codes, enabled, metadata)
       VALUES
         ($1::uuid, $2::text, 'Synthetic diagnostic action evidence',
          'diagnostic.result.generation_signed', 30, 'high', ARRAY['DOCTOR']::text[],
          ARRAY['ADMIN']::text[], TRUE, '{"synthetic_test_only":true}'::jsonb)`,
      tenantId,
      DIAGNOSTIC_ACTION_SLA_RULE_CODE,
    );
    const patients = await tx.$queryRawUnsafe(
      `SELECT id FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      tenantId,
      patientUid,
    );
    const investigations = await tx.$queryRawUnsafe(
      `INSERT INTO investigations
         (tenant_id, phone, patient_id, patient_uid, test_name, test_type, status,
          requested_by, requested_at, result_version, results, verified_by,
          verified_at, updated_at)
       VALUES
         ($1::uuid, $2::text, $3::integer, $4::uuid, 'Synthetic shared diagnostic',
          'CARDIOLOGY', 'COMPLETED', $5::uuid, NOW(), 1,
          '{"measurement":{"value":"12","unit":"ms","abnormal_flag":"H"}}'::jsonb,
          $5::uuid, NOW(), NOW())
       RETURNING *`,
      tenantId,
      `98${token().slice(0, 8)}`,
      Number(patients[0].id),
      patientUid,
      doctorUid,
    );
    return {
      tenantId,
      patientUid,
      doctorUid,
      otherDoctorUid,
      radiologistUid,
      pathologistUid,
      investigation: investigations[0],
    };
  });
}

async function createGeneration(fixture, investigation = fixture.investigation) {
  return setTenantTx(fixture.tenantId, (tx) => createSharedInvestigationGenerationTx({
    tx,
    tenantId: fixture.tenantId,
    investigation,
    signerRole: 'DOCTOR',
  }));
}

async function createNormalLabGeneration(fixture, { released = true } = {}) {
  return setTenantTx(fixture.tenantId, async (tx) => {
    const results = await tx.$queryRawUnsafe(
      `INSERT INTO lab_results
         (tenant_id, patient_uid, investigation_id, test_code, test_name,
          value_numeric, unit, reference_range, reference_range_low,
          reference_range_high, abnormal_flag, is_critical, status,
          signed_off_at, signed_off_by, release_hold, released_to_patient_at,
          updated_at)
       VALUES
         ($1::uuid, $2::uuid, $3::integer, 'S2BN', 'Synthetic normal result',
          8, 'ms', '5-10', 5, 10, 'N', FALSE, 'final', NOW(), $4::uuid,
          FALSE, $5::timestamptz, NOW())
       RETURNING *`,
      fixture.tenantId,
      fixture.patientUid,
      Number(fixture.investigation.id),
      fixture.doctorUid,
      released ? new Date().toISOString() : null,
    );
    const signoffs = await tx.$queryRawUnsafe(
      `INSERT INTO lab_pathologist_signoffs
         (tenant_id, patient_uid, result_ids, signed_off_by,
          signed_off_by_name, decision, signed_at)
       VALUES
         ($1::uuid, $2::uuid, $3::integer[], $4::uuid,
          'Ordering Doctor', 'verified', NOW())
       RETURNING *`,
      fixture.tenantId,
      fixture.patientUid,
      [Number(results[0].id)],
      fixture.doctorUid,
    );
    const generation = await createLabDiagnosticGenerationTx({
      tx,
      tenantId: fixture.tenantId,
      patientUid: fixture.patientUid,
      episode: {
        type: 'investigation',
        id: Number(fixture.investigation.id),
        key: `investigation:${fixture.investigation.id}`,
      },
      signoff: signoffs[0],
      signerRole: 'DOCTOR',
      panelRows: results,
    });
    return Object.freeze({ ...generation, lab_result_id: Number(results[0].id) });
  });
}

async function projectGeneration(fixture, generation) {
  return setTenantTx(fixture.tenantId, async (tx) => {
    const events = await tx.$queryRawUnsafe(
      `SELECT * FROM event_outbox
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      fixture.tenantId,
      generation.event_id,
    );
    return projectDiagnosticPathwayEvent({
      tx,
      consumerKey: 'care_pathway_projector',
      generation: 2,
      tenantId: fixture.tenantId,
      event: events[0],
      registry: workflowRuntimeRegistry,
      activationEvidenceCapability: activationCapability,
    });
  });
}

async function loadActionTask(fixture, generationId) {
  return setTenantTx(fixture.tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT task.*, pathway.id AS pathway_instance_id,
              pathway.workflow_run_id, step.id AS workflow_step_id
         FROM care_pathway_instances AS pathway
         JOIN workflow_runs AS run
           ON run.tenant_id = pathway.tenant_id AND run.id = pathway.workflow_run_id
         JOIN workflow_steps AS step
           ON step.tenant_id = run.tenant_id
          AND step.workflow_run_id = run.id
          AND step.step_key = 'record_doctor_action'
         JOIN tasks AS task
           ON task.tenant_id = step.tenant_id
          AND task.workflow_run_id = step.workflow_run_id
          AND task.workflow_step_id = step.id
        WHERE pathway.tenant_id = $1::uuid
          AND pathway.source_episode_id = $2::text
        ORDER BY pathway.created_at DESC
        LIMIT 1`,
      fixture.tenantId,
      String(generationId),
    );
    return rows[0] || null;
  });
}

async function loadCriticalAcknowledgement(fixture, generationId) {
  return setTenantTx(fixture.tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT generation.critical_acknowledgement_task_id AS task_id,
              generation.critical_acknowledgement_sla_id AS sla_id,
              task.status AS task_status,
              task.assigned_to_uid,
              task.assigned_to_role,
              task.related_resource_type,
              task.related_resource_id,
              task.metadata AS task_metadata,
              sla.status AS sla_status,
              sla.completed_at AS sla_completed_at
         FROM diagnostic_result_generations AS generation
         LEFT JOIN tasks AS task
           ON task.tenant_id = generation.tenant_id
          AND task.id = generation.critical_acknowledgement_task_id
         LEFT JOIN workflow_sla_instances AS sla
           ON sla.tenant_id = generation.tenant_id
          AND sla.id = generation.critical_acknowledgement_sla_id
        WHERE generation.tenant_id = $1::uuid
          AND generation.id = $2::uuid
        LIMIT 1`,
      fixture.tenantId,
      generationId,
    );
    return rows[0] || null;
  });
}

function doctorActionInput(generation, task, prefix) {
  return {
    tenantId: generation.tenant_id,
    generationId: String(generation.id),
    taskId: Number(task.id),
    disposition: 'no_action',
    clinicalNote: 'Reviewed the complete signed diagnostic generation and recorded the decision.',
    reason: 'Synthetic journey evidence does not require a real downstream clinical resource.',
    generationSnapshotSha256: generation.snapshot_sha256,
    idempotencyKey: `${prefix}-${token()}`,
    attested: true,
    activationEvidenceCapability: activationCapability,
  };
}

const namedDoctorActor = (fixture) => ({
  actorUid: fixture.doctorUid,
  actorName: 'Ordering Doctor',
  actorRole: 'DOCTOR',
  actorRoles: ['DOCTOR'],
});

d('diagnostic result action pathway', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('rejects an oversized shared-result snapshot instead of truncating a later critical item', async () => {
    const fixture = await seedGovernedDiagnosticsFixture();
    const results = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [
      `measurement_${index + 1}`,
      {
        value: String(index + 1),
        abnormal_flag: index === 100 ? 'HH' : 'N',
      },
    ]));
    const investigation = await setTenantTx(fixture.tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE investigations
            SET results = $3::jsonb, verified_at = NOW(), updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::integer
          RETURNING *`,
        fixture.tenantId,
        Number(fixture.investigation.id),
        JSON.stringify(results),
      );
      return rows[0];
    });

    await expect(createGeneration(fixture, investigation)).rejects.toMatchObject({
      code: 'DIAGNOSTIC_RESULT_ITEM_LIMIT_EXCEEDED',
    });
    const generations = await setTenantTx(fixture.tenantId, (tx) => tx.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS count
         FROM diagnostic_result_generations
        WHERE tenant_id = $1::uuid AND investigation_id = $2::integer`,
      fixture.tenantId,
      Number(fixture.investigation.id),
    ));
    expect(generations[0].count).toBe(0);
  });

  it('creates a fresh exact-owner critical acknowledgement window for every radiology amendment', async () => {
    const fixture = await seedGovernedDiagnosticsFixture();
    const order = await setTenantTx(fixture.tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO radiology_orders
           (tenant_id, patient_uid, modality, body_part, clinical_indication,
            priority, status, ordered_by, radiologist, report,
            report_completed_at, structured_report, created_at, updated_at)
         VALUES
           ($1::uuid, $2::uuid, 'ct', 'chest', 'Synthetic pathway journey',
            'urgent', 'completed', $3::uuid, $4::uuid,
            'Initial signed report content', NOW(),
            '{"sections":[]}'::jsonb, NOW(), NOW())
         RETURNING *`,
        fixture.tenantId,
        fixture.patientUid,
        fixture.doctorUid,
        fixture.radiologistUid,
      );
      return rows[0];
    });

    const signoffInput = {
      signed_off_by: fixture.radiologistUid,
      result_classification: 'critical',
      classification_basis: { source: 'radiologist_attestation', code: 'journey_initial' },
      idempotencyKey: `radiology-signoff-${token()}`,
      tenantId: fixture.tenantId,
      actorRole: 'RADIOLOGIST',
    };
    const signedAttempts = await Promise.all([
      radiologyService.signOffReport(order.id, signoffInput),
      radiologyService.signOffReport(order.id, signoffInput),
    ]);
    expect(signedAttempts.map((entry) => entry.diagnostic_generation.replayed).sort())
      .toEqual([false, true]);
    const signed = signedAttempts[0];
    const firstGeneration = signed.diagnostic_generation;
    const firstAck = await loadCriticalAcknowledgement(fixture, firstGeneration.id);
    expect(firstAck).toMatchObject({
      task_status: 'open',
      assigned_to_uid: fixture.doctorUid,
      assigned_to_role: null,
      related_resource_type: 'diagnostic_result_generation',
      related_resource_id: firstGeneration.id,
      sla_status: 'active',
    });

    await projectGeneration(fixture, firstGeneration);
    const firstActionTask = await loadActionTask(fixture, firstGeneration.id);
    await expect(recordDoctorDiagnosticDisposition(
      doctorActionInput(firstGeneration, firstActionTask, 'radiology-before-ack'),
      namedDoctorActor(fixture),
    )).rejects.toMatchObject({ code: 'DIAGNOSTIC_CRITICAL_ACK_REQUIRED' });

    await acknowledgeTask({
      tenantId: fixture.tenantId,
      id: Number(firstAck.task_id),
      actorUid: fixture.doctorUid,
      actorRoles: ['DOCTOR'],
      actorPrimaryRole: 'DOCTOR',
      actorRawRole: 'DOCTOR',
    });
    const acknowledged = await loadCriticalAcknowledgement(fixture, firstGeneration.id);
    expect(acknowledged.task_status).toBe('in_progress');
    expect(acknowledged.sla_completed_at).toBeTruthy();
    expect(acknowledged.task_metadata).toMatchObject({
      acknowledged_by: fixture.doctorUid,
      acknowledged_via: 'assignee',
    });

    const addendumInput = {
      addendum: 'A newly reviewed image confirms the critical finding.',
      addendum_by: fixture.radiologistUid,
      result_classification: 'critical',
      classification_basis: { source: 'radiologist_attestation', code: 'journey_addendum' },
      clinical_significance: 'worsened',
      idempotencyKey: `radiology-addendum-${token()}`,
      tenantId: fixture.tenantId,
      actorRole: 'RADIOLOGIST',
    };
    const amendmentAttempts = await Promise.all([
      radiologyService.appendReportAddendum(order.id, addendumInput),
      radiologyService.appendReportAddendum(order.id, addendumInput),
    ]);
    expect(amendmentAttempts.map((entry) => entry.diagnostic_generation.replayed).sort())
      .toEqual([false, true]);
    expect(amendmentAttempts[0].addendum.id).toBe(amendmentAttempts[1].addendum.id);
    expect(amendmentAttempts[0].addendum).not.toHaveProperty('idempotency_key');
    expect(amendmentAttempts[0].addendum).not.toHaveProperty('request_sha256');
    const amended = amendmentAttempts[0];
    const successor = amended.diagnostic_generation;
    expect(successor).toMatchObject({
      source_kind: 'radiology_report',
      source_version: 2,
      predecessor_generation_id: firstGeneration.id,
    });
    const secondAck = await loadCriticalAcknowledgement(fixture, successor.id);
    expect(secondAck).toMatchObject({
      task_status: 'open',
      assigned_to_uid: fixture.doctorUid,
      assigned_to_role: null,
      related_resource_id: successor.id,
      sla_status: 'active',
    });
    expect(Number(secondAck.task_id)).not.toBe(Number(firstAck.task_id));
    expect(String(secondAck.sla_id)).not.toBe(String(firstAck.sla_id));

    const projected = await projectGeneration(fixture, successor);
    expect(projected.predecessor_supersession).toMatchObject({ superseded: true });
    const supersededAck = await loadCriticalAcknowledgement(fixture, firstGeneration.id);
    expect(supersededAck.task_status).toBe('completed');
    expect(supersededAck.sla_completed_at).toBeTruthy();

    const corrected = await radiologyService.appendReportAddendum(order.id, {
      addendum: 'Correction: specialist review now classifies the complete report as normal.',
      addendum_by: fixture.radiologistUid,
      result_classification: 'normal',
      classification_basis: { source: 'radiologist_attestation', code: 'journey_correction' },
      clinical_significance: 'corrected',
      idempotencyKey: `radiology-correction-${token()}`,
      tenantId: fixture.tenantId,
      actorRole: 'RADIOLOGIST',
    });
    expect(corrected.diagnostic_generation).toMatchObject({
      source_version: 3,
      classification: 'normal',
      predecessor_generation_id: successor.id,
      critical_acknowledgement_task_id: null,
      critical_acknowledgement_sla_id: null,
    });
    const olderAddendumReplay = await radiologyService.appendReportAddendum(
      order.id,
      addendumInput,
    );
    expect(olderAddendumReplay.diagnostic_generation).toMatchObject({
      id: successor.id,
      source_version: 2,
      replayed: true,
    });
    const correctedProjection = await projectGeneration(fixture, corrected.diagnostic_generation);
    expect(correctedProjection.predecessor_supersession).toMatchObject({ superseded: true });
    const supersededSecondAck = await loadCriticalAcknowledgement(fixture, successor.id);
    expect(supersededSecondAck.task_status).toBe('completed');
    expect(supersededSecondAck.sla_completed_at).toBeTruthy();
    const acknowledgementCheck = COMMON_PATHWAY_RECONCILIATION_CHECKS.find(
      (check) => check.id === 'diagnostic_structured_ack_evidence',
    );
    const reconciled = await setTenantTx(fixture.tenantId, (tx) => acknowledgementCheck.run({
      tx,
      tenantId: fixture.tenantId,
      pathwayKey: 'diagnostics_order_to_action',
    }));
    expect(reconciled.finding_count).toBe(0);
  });

  it('uses explicit specialist classification in shadow mode without creating acknowledgement work', async () => {
    const fixture = await seedGovernedDiagnosticsFixture();
    await setTenantTx(fixture.tenantId, (tx) => tx.$executeRawUnsafe(
      `UPDATE tenants
          SET settings = jsonb_set(
                settings,
                '{care_pathways,diagnostics_order_to_action}',
                '"shadow"'::jsonb,
                TRUE
              )
        WHERE id = $1::uuid`,
      fixture.tenantId,
    ));
    const order = await setTenantTx(fixture.tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO radiology_orders
           (tenant_id, patient_uid, modality, body_part, clinical_indication,
            priority, status, ordered_by, radiologist, report,
            report_completed_at, structured_report, created_at, updated_at)
         VALUES
           ($1::uuid, $2::uuid, 'ct', 'brain', 'Possible severe acute finding',
            'stat', 'completed', $3::uuid, $4::uuid,
            'Free text says critical and urgent but is not classification evidence.', NOW(),
            '{"sections":[{"text":"AI HIGH RISK"}]}'::jsonb, NOW(), NOW())
         RETURNING *`,
        fixture.tenantId,
        fixture.patientUid,
        fixture.doctorUid,
        fixture.radiologistUid,
      );
      return rows[0];
    });
    const signed = await radiologyService.signOffReport(order.id, {
      signed_off_by: fixture.radiologistUid,
      result_classification: 'normal',
      classification_basis: { source: 'radiologist_attestation', code: 'shadow_normal' },
      idempotencyKey: `radiology-shadow-signoff-${token()}`,
      tenantId: fixture.tenantId,
      actorRole: 'RADIOLOGIST',
    });
    expect(signed.diagnostic_generation).toMatchObject({
      classification: 'normal',
      critical_acknowledgement_task_id: null,
      critical_acknowledgement_sla_id: null,
    });

    const amended = await radiologyService.appendReportAddendum(order.id, {
      addendum: 'Benign wording; only the signed structured declaration marks this critical.',
      addendum_by: fixture.radiologistUid,
      result_classification: 'critical',
      classification_basis: { source: 'radiologist_attestation', code: 'shadow_critical' },
      clinical_significance: 'new_finding',
      idempotencyKey: `radiology-shadow-addendum-${token()}`,
      tenantId: fixture.tenantId,
      actorRole: 'RADIOLOGIST',
    });
    expect(amended.diagnostic_generation).toMatchObject({
      source_version: 2,
      classification: 'critical',
      predecessor_generation_id: signed.diagnostic_generation.id,
      critical_acknowledgement_task_id: null,
      critical_acknowledgement_sla_id: null,
    });
    const linkedTasks = await setTenantTx(fixture.tenantId, (tx) => tx.$queryRawUnsafe(
      `SELECT id FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'diagnostic_result_generation'
          AND related_resource_id IN ($2::text, $3::text)`,
      fixture.tenantId,
      signed.diagnostic_generation.id,
      amended.diagnostic_generation.id,
    ));
    expect(linkedTasks).toHaveLength(0);
  });

  it('routes an indeterminate radiology report to named-doctor action without a critical SLA', async () => {
    const fixture = await seedGovernedDiagnosticsFixture();
    const order = await setTenantTx(fixture.tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO radiology_orders
           (tenant_id, patient_uid, modality, body_part, clinical_indication,
            priority, status, ordered_by, radiologist, report,
            report_completed_at, structured_report, created_at, updated_at)
         VALUES
           ($1::uuid, $2::uuid, 'xray', 'chest', 'Uncertain finding journey',
            'routine', 'completed', $3::uuid, $4::uuid,
            'Signed report requires clinical correlation.', NOW(),
            '{"sections":[]}'::jsonb, NOW(), NOW())
         RETURNING *`,
        fixture.tenantId,
        fixture.patientUid,
        fixture.doctorUid,
        fixture.radiologistUid,
      );
      return rows[0];
    });
    const signed = await radiologyService.signOffReport(order.id, {
      signed_off_by: fixture.radiologistUid,
      result_classification: 'indeterminate',
      classification_basis: { source: 'radiologist_attestation', code: 'journey_indeterminate' },
      idempotencyKey: `radiology-indeterminate-${token()}`,
      tenantId: fixture.tenantId,
      actorRole: 'RADIOLOGIST',
    });
    expect(signed.diagnostic_generation).toMatchObject({
      classification: 'indeterminate',
      critical_acknowledgement_task_id: null,
      critical_acknowledgement_sla_id: null,
    });
    await projectGeneration(fixture, signed.diagnostic_generation);
    const task = await loadActionTask(fixture, signed.diagnostic_generation.id);
    expect(task).toMatchObject({
      status: 'open',
      assigned_to_uid: fixture.doctorUid,
      assigned_to_role: null,
      sla_completion_semantics: 'domain_evidence',
    });
  });

  it('routes an abnormal AP report to doctor cross-sign and gives its critical addendum a new acknowledgement task', async () => {
    const fixture = await seedGovernedDiagnosticsFixture();
    const report = await setTenantTx(fixture.tenantId, async (tx) => {
      const cases = await tx.$queryRawUnsafe(
        `INSERT INTO ap_cases
           (tenant_id, case_number, patient_uid, source_investigation_id,
            case_kind, priority, status, clinical_history, accessioned_by)
         VALUES
           ($1::uuid, $2::text, $3::uuid, $4::integer,
            'histopathology', 'urgent', 'reported', 'Synthetic pathway journey', $5::uuid)
         RETURNING *`,
        fixture.tenantId,
        `AP-JOURNEY-${token()}`,
        fixture.patientUid,
        Number(fixture.investigation.id),
        fixture.pathologistUid,
      );
      const reports = await tx.$queryRawUnsafe(
        `INSERT INTO ap_reports
           (tenant_id, ap_case_id, report_status, gross_text, microscopic_text,
            diagnosis_text, synoptic_fields, malignancy_flag, report_author_uid)
         VALUES
           ($1::uuid, $2::bigint, 'draft', 'Synthetic gross description',
            'Synthetic microscopy', 'Synthetic diagnostic interpretation',
            '{"journey":true}'::jsonb, 'not_assessed', $3::uuid)
         RETURNING *`,
        fixture.tenantId,
        cases[0].id,
        fixture.pathologistUid,
      );
      return reports[0];
    });

    const signoffInput = {
      result_classification: 'abnormal',
      classification_basis: { source: 'pathologist_attestation', code: 'journey_initial' },
      idempotencyKey: `ap-signoff-${token()}`,
    };
    const signerContext = {
      tenantId: fixture.tenantId,
      actorUid: fixture.pathologistUid,
      actorRole: 'PATHOLOGIST',
    };
    const signed = await pathologyService.signOffReport(report.id, signoffInput, signerContext);
    const signedReplay = await pathologyService.signOffReport(report.id, signoffInput, signerContext);
    expect(signed).not.toHaveProperty('signoff_idempotency_key');
    expect(signed).not.toHaveProperty('signoff_request_sha256');
    expect(signedReplay.diagnostic_generation).toMatchObject({
      id: signed.diagnostic_generation.id,
      replayed: true,
    });
    const firstGeneration = signed.diagnostic_generation;
    expect(firstGeneration).toMatchObject({
      source_kind: 'anatomical_pathology_report',
      source_version: 1,
      ordering_owner_uid: fixture.doctorUid,
      critical_acknowledgement_task_id: null,
    });
    await projectGeneration(fixture, firstGeneration);
    const actionTask = await loadActionTask(fixture, firstGeneration.id);
    const crossSign = await recordDoctorDiagnosticDisposition(
      doctorActionInput(firstGeneration, actionTask, 'ap-abnormal-cross-sign'),
      namedDoctorActor(fixture),
    );
    expect(crossSign).toMatchObject({
      generation_id: firstGeneration.id,
      action_kind: 'doctor_disposition',
      pathway: { clinical_status: 'completed' },
    });

    const addendumInput = {
      addendum_text: 'The signed addendum records a new critical finding.',
      result_classification: 'critical',
      classification_basis: { source: 'pathologist_attestation', code: 'journey_addendum' },
      clinical_significance: 'new_finding',
      idempotencyKey: `ap-addendum-${token()}`,
    };
    const amended = await pathologyService.appendAddendum(report.id, addendumInput, signerContext);
    const amendedReplay = await pathologyService.appendAddendum(
      report.id,
      addendumInput,
      signerContext,
    );
    expect(amendedReplay.diagnostic_generation).toMatchObject({
      id: amended.diagnostic_generation.id,
      replayed: true,
    });
    expect(amended.addendum).not.toHaveProperty('idempotency_key');
    expect(amended.addendum).not.toHaveProperty('request_sha256');
    const successor = amended.diagnostic_generation;
    expect(successor).toMatchObject({
      source_kind: 'anatomical_pathology_report',
      source_version: 2,
      predecessor_generation_id: firstGeneration.id,
      ordering_owner_uid: fixture.doctorUid,
    });
    const criticalAck = await loadCriticalAcknowledgement(fixture, successor.id);
    expect(criticalAck).toMatchObject({
      task_status: 'open',
      assigned_to_uid: fixture.doctorUid,
      assigned_to_role: null,
      related_resource_id: successor.id,
      sla_status: 'active',
    });
    await projectGeneration(fixture, successor);
    const successorActionTask = await loadActionTask(fixture, successor.id);
    await expect(recordDoctorDiagnosticDisposition(
      doctorActionInput(successor, successorActionTask, 'ap-critical-before-ack'),
      namedDoctorActor(fixture),
    )).rejects.toMatchObject({ code: 'DIAGNOSTIC_CRITICAL_ACK_REQUIRED' });

    const laterAddendum = await pathologyService.appendAddendum(report.id, {
      addendum_text: 'A later signed addendum preserves the abnormal classification.',
      result_classification: 'abnormal',
      classification_basis: { source: 'pathologist_attestation', code: 'journey_later' },
      clinical_significance: 'improved',
      idempotencyKey: `ap-later-addendum-${token()}`,
    }, signerContext);
    expect(laterAddendum.diagnostic_generation.source_version).toBe(3);
    const olderAddendumReplay = await pathologyService.appendAddendum(
      report.id,
      addendumInput,
      signerContext,
    );
    expect(olderAddendumReplay.diagnostic_generation).toMatchObject({
      id: successor.id,
      source_version: 2,
      replayed: true,
    });
  });

  it('rolls back active AP sign-off when no named ordering doctor can be resolved', async () => {
    const fixture = await seedGovernedDiagnosticsFixture();
    const report = await setTenantTx(fixture.tenantId, async (tx) => {
      const cases = await tx.$queryRawUnsafe(
        `INSERT INTO ap_cases
           (tenant_id, case_number, patient_uid, case_kind, priority,
            status, clinical_history, accessioned_by)
         VALUES
           ($1::uuid, $2::text, $3::uuid, 'histopathology', 'urgent',
            'reported', 'No linked orderer journey', $4::uuid)
         RETURNING *`,
        fixture.tenantId,
        `AP-NO-OWNER-${token()}`,
        fixture.patientUid,
        fixture.pathologistUid,
      );
      const reports = await tx.$queryRawUnsafe(
        `INSERT INTO ap_reports
           (tenant_id, ap_case_id, report_status, gross_text, microscopic_text,
            diagnosis_text, synoptic_fields, malignancy_flag, report_author_uid)
         VALUES
           ($1::uuid, $2::bigint, 'draft', 'Synthetic gross description',
            'Synthetic microscopy', 'Signed abnormal diagnosis',
            '{"journey":true}'::jsonb, 'not_assessed', $3::uuid)
         RETURNING *`,
        fixture.tenantId,
        cases[0].id,
        fixture.pathologistUid,
      );
      return reports[0];
    });

    await expect(pathologyService.signOffReport(report.id, {
      result_classification: 'abnormal',
      classification_basis: { source: 'pathologist_attestation', code: 'missing_owner' },
      idempotencyKey: `ap-no-owner-${token()}`,
    }, {
      tenantId: fixture.tenantId,
      actorUid: fixture.pathologistUid,
      actorRole: 'PATHOLOGIST',
    })).rejects.toMatchObject({ code: 'PATHWAY_NAMED_OWNER_UNAVAILABLE' });

    const evidence = await setTenantTx(fixture.tenantId, (tx) => tx.$queryRawUnsafe(
      `SELECT report.signed_at, report.result_classification,
              COUNT(generation.id)::integer AS generation_count
         FROM ap_reports AS report
         LEFT JOIN diagnostic_result_generations AS generation
           ON generation.tenant_id = report.tenant_id
          AND generation.ap_report_id = report.id
        WHERE report.tenant_id = $1::uuid AND report.id = $2::bigint
        GROUP BY report.id`,
      fixture.tenantId,
      report.id,
    ));
    expect(evidence[0]).toMatchObject({
      signed_at: null,
      result_classification: null,
      generation_count: 0,
    });
  });

  it('requires explicit attestation and allows only the named doctor to seal domain evidence', async () => {
    const fixture = await seedGovernedDiagnosticsFixture();
    const generation = await createGeneration(fixture);
    expect(generation.classification).toBe('abnormal');
    const projected = await projectGeneration(fixture, generation);
    const task = await loadActionTask(fixture, generation.id);
    expect(projected.pathway_instance_id).toBeTruthy();
    expect(task).toMatchObject({
      status: 'open',
      assigned_to_uid: fixture.doctorUid,
      assigned_to_role: null,
      sla_completion_semantics: 'domain_evidence',
    });

    const actionInput = {
      tenantId: fixture.tenantId,
      generationId: String(generation.id),
      taskId: Number(task.id),
      disposition: 'no_action',
      clinicalNote: 'Reviewed the complete signed generation; no intervention is indicated.',
      reason: 'Finding is clinically explained by the documented baseline.',
      generationSnapshotSha256: generation.snapshot_sha256,
      idempotencyKey: `diagnostic-action-${token()}`,
      activationEvidenceCapability: activationCapability,
    };
    await expect(recordDoctorDiagnosticDisposition(
      actionInput,
      { actorUid: fixture.doctorUid, actorRole: 'DOCTOR', actorRoles: ['DOCTOR'] },
    )).rejects.toMatchObject({ code: 'DIAGNOSTIC_ACTION_ATTESTATION_REQUIRED' });
    await expect(recordDoctorDiagnosticDisposition(
      { ...actionInput, attested: true },
      { actorUid: fixture.otherDoctorUid, actorRole: 'DOCTOR', actorRoles: ['DOCTOR'] },
    )).rejects.toMatchObject({ statusCode: 403 });

    const actor = {
      actorUid: fixture.doctorUid,
      actorName: 'Ordering Doctor',
      actorRole: 'DOCTOR',
      actorRoles: ['DOCTOR'],
    };
    const concurrent = await Promise.all([
      recordDoctorDiagnosticDisposition(
        { ...actionInput, attested: true },
        actor,
      ),
      recordDoctorDiagnosticDisposition(
        { ...actionInput, attested: true },
        actor,
      ),
    ]);
    expect(concurrent.filter((entry) => entry.replayed === false)).toHaveLength(1);
    expect(concurrent.filter((entry) => entry.replayed === true)).toHaveLength(1);
    const receipt = concurrent.find((entry) => entry.replayed === false);
    expect(receipt).toMatchObject({
      generation_id: String(generation.id),
      task_id: Number(task.id),
      action_kind: 'doctor_disposition',
      disposition: 'no_action',
      replayed: false,
      pathway: { clinical_status: 'completed' },
    });
    expect(receipt.signature_id).toBeTruthy();

    const replay = await recordDoctorDiagnosticDisposition(
      { ...actionInput, attested: true },
      actor,
    );
    expect(replay).toMatchObject({ id: receipt.id, replayed: true });

    const evidence = await setTenantTx(fixture.tenantId, (tx) => tx.$queryRawUnsafe(
      `SELECT action.id, signature.id AS signature_id, task.status AS task_status,
              sla.completed_at, pathway.clinical_status
         FROM diagnostic_result_actions AS action
         JOIN clinical_document_signatures AS signature
           ON signature.tenant_id = action.tenant_id AND signature.id = action.signature_id
         JOIN tasks AS task
           ON task.tenant_id = action.tenant_id AND task.id = action.task_id
         JOIN workflow_sla_instances AS sla
           ON sla.tenant_id = task.tenant_id AND sla.id = task.workflow_sla_instance_id
         JOIN care_pathway_instances AS pathway
           ON pathway.tenant_id = action.tenant_id AND pathway.id = action.pathway_instance_id
        WHERE action.tenant_id = $1::uuid AND action.id = $2::uuid`,
      fixture.tenantId,
      receipt.id,
    ));
    expect(evidence[0]).toMatchObject({
      task_status: 'completed',
      clinical_status: 'completed',
    });
    expect(evidence[0].completed_at).toBeTruthy();
    expect(String(evidence[0].signature_id)).toBe(receipt.signature_id);
    const counts = await setTenantTx(fixture.tenantId, (tx) => tx.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS action_count
         FROM diagnostic_result_actions
        WHERE tenant_id = $1::uuid AND generation_id = $2::uuid
          AND action_kind = 'doctor_disposition'`,
      fixture.tenantId,
      generation.id,
    ));
    expect(counts[0].action_count).toBe(1);
    await expect(setTenantTx(fixture.tenantId, (tx) => tx.$executeRawUnsafe(
      `UPDATE diagnostic_result_generations
          SET classification = 'normal'
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      fixture.tenantId,
      generation.id,
    ))).rejects.toThrow(/append-only/i);
    await expect(setTenantTx(fixture.tenantId, (tx) => tx.$executeRawUnsafe(
      `UPDATE diagnostic_result_actions
          SET clinical_note = 'mutated'
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      fixture.tenantId,
      receipt.id,
    ))).rejects.toThrow(/append-only/i);
    await expect(setTenantTx(fixture.tenantId, (tx) => tx.$executeRawUnsafe(
      `DELETE FROM diagnostic_result_generation_items
        WHERE tenant_id = $1::uuid AND generation_id = $2::uuid`,
      fixture.tenantId,
      generation.id,
    ))).rejects.toThrow(/append-only/i);
    const diagnosticChecks = COMMON_PATHWAY_RECONCILIATION_CHECKS.filter(
      (check) => check.id.startsWith('diagnostic_'),
    );
    const reconciled = await setTenantTx(fixture.tenantId, async (tx) => Promise.all(
      diagnosticChecks.map((check) => check.run({
        tx,
        tenantId: fixture.tenantId,
        pathwayKey: 'diagnostics_order_to_action',
      })),
    ));
    expect(reconciled).toHaveLength(5);
    expect(reconciled.every((row) => row.finding_count === 0)).toBe(true);
  });

  it('supersedes an obsolete action obligation before routing the corrected generation', async () => {
    const fixture = await seedGovernedDiagnosticsFixture();
    const predecessor = await createGeneration(fixture);
    await projectGeneration(fixture, predecessor);
    const priorTask = await loadActionTask(fixture, predecessor.id);

    const correctedInvestigation = await setTenantTx(fixture.tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE investigations
            SET result_version = 2,
                results = '{"measurement":{"value":"8","unit":"ms","abnormal_flag":"N"}}'::jsonb,
                verified_at = NOW(), updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::integer
          RETURNING *`,
        fixture.tenantId,
        Number(fixture.investigation.id),
      );
      return rows[0];
    });
    const successor = await createGeneration(fixture, correctedInvestigation);
    expect(successor.predecessor_generation_id).toBe(predecessor.id);
    const projected = await projectGeneration(fixture, successor);
    expect(projected.predecessor_supersession).toMatchObject({
      superseded: true,
      pathway_advanced: true,
      pathway_status: 'completed',
    });

    const rows = await setTenantTx(fixture.tenantId, (tx) => tx.$queryRawUnsafe(
      `SELECT task.status AS task_status, sla.completed_at,
              pathway.clinical_status, action.superseding_generation_id
         FROM tasks AS task
         JOIN workflow_sla_instances AS sla
           ON sla.tenant_id = task.tenant_id AND sla.id = task.workflow_sla_instance_id
         JOIN care_pathway_instances AS pathway
           ON pathway.tenant_id = task.tenant_id AND pathway.workflow_run_id = task.workflow_run_id
         JOIN diagnostic_result_actions AS action
           ON action.tenant_id = pathway.tenant_id
          AND action.generation_id = $3::uuid
          AND action.action_kind = 'generation_superseded'
        WHERE task.tenant_id = $1::uuid AND task.id = $2::bigint`,
      fixture.tenantId,
      Number(priorTask.id),
      predecessor.id,
    ));
    expect(rows[0]).toMatchObject({
      task_status: 'completed',
      clinical_status: 'completed',
      superseding_generation_id: successor.id,
    });
    expect(rows[0].completed_at).toBeTruthy();
  });

  it('routes a normal shared result to release wait and fails closed without a release adapter', async () => {
    const fixture = await seedGovernedDiagnosticsFixture();
    const normalInvestigation = await setTenantTx(fixture.tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE investigations
            SET results = '{"measurement":{"value":"8","unit":"ms","abnormal_flag":"N"}}'::jsonb,
                verified_at = NOW(), updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::integer
          RETURNING *`,
        fixture.tenantId,
        Number(fixture.investigation.id),
      );
      return rows[0];
    });
    const generation = await createGeneration(fixture, normalInvestigation);
    expect(generation.classification).toBe('normal');
    const projected = await projectGeneration(fixture, generation);
    const closure = await closeNormalDiagnosticGenerationIfEligible({
      tenantId: fixture.tenantId,
      generationId: String(generation.id),
      activationEvidenceCapability: activationCapability,
    });
    expect(projected.pathway_instance_id).toBeTruthy();
    expect(closure).toMatchObject({
      generation_id: String(generation.id),
      closed: false,
      outcome: 'unsupported_source',
    });
  });

  it('auto-closes a released normal lab generation and preserves closure through doctor reopen', async () => {
    const fixture = await seedGovernedDiagnosticsFixture();
    const generation = await createNormalLabGeneration(fixture, { released: false });
    expect(generation.classification).toBe('normal');
    await projectGeneration(fixture, generation);

    await releaseResultNow(generation.lab_result_id, {
      tenantId: fixture.tenantId,
      actorUid: fixture.doctorUid,
      actorRole: 'DOCTOR',
      actorRoles: ['DOCTOR'],
      actorRawRole: 'DOCTOR',
    });
    const eligibilityEvents = await setTenantTx(
      fixture.tenantId,
      (tx) => tx.$queryRawUnsafe(
        `SELECT id FROM event_outbox
          WHERE tenant_id = $1::uuid
            AND event_type = 'diagnostic.result.release_became_eligible'
            AND aggregate_id = $2::text`,
        fixture.tenantId,
        String(generation.id),
      ),
    );
    expect(eligibilityEvents).toHaveLength(1);

    const sweep = await runDiagnosticNormalReleaseSweep({
      tenantId: fixture.tenantId,
      activationEvidenceCapability: activationCapability,
    });
    expect(sweep).toMatchObject({ candidates: 1, closed: 1, deferred: 0, errors: 0 });
    const closure = await closeNormalDiagnosticGenerationIfEligible({
      tenantId: fixture.tenantId,
      generationId: String(generation.id),
      activationEvidenceCapability: activationCapability,
    });
    expect(closure).toMatchObject({
      generation_id: String(generation.id),
      action_kind: 'normal_auto_closed',
      replayed: true,
    });
    const ownerDetail = await getInvestigationById(
      fixture.investigation.id,
      'DOCTOR',
      fixture.doctorUid,
      fixture.tenantId,
    );
    expect(ownerDetail.diagnostic_review).toMatchObject({
      generation_id: String(generation.id),
      classification: 'normal',
      normal_auto_closed_action_id: closure.id,
      can_reopen: true,
    });
    const otherDoctorDetail = await getInvestigationById(
      fixture.investigation.id,
      'DOCTOR',
      fixture.otherDoctorUid,
      fixture.tenantId,
    );
    expect(otherDoctorDetail.diagnostic_review.can_reopen).toBe(false);

    const reopened = await reopenNormalDiagnosticGeneration({
      tenantId: fixture.tenantId,
      generationId: String(generation.id),
      reason: 'Doctor elected to re-review this otherwise normal result.',
      idempotencyKey: `diagnostic-reopen-${token()}`,
      activationEvidenceCapability: activationCapability,
    }, {
      actorUid: fixture.doctorUid,
      actorName: 'Ordering Doctor',
      actorRole: 'DOCTOR',
      actorRoles: ['DOCTOR'],
    });
    expect(reopened).toMatchObject({
      action_kind: 'doctor_reopened',
      replayed: false,
    });
    const reopenedDetail = await getInvestigationById(
      fixture.investigation.id,
      'DOCTOR',
      fixture.doctorUid,
      fixture.tenantId,
    );
    expect(reopenedDetail.diagnostic_review).toMatchObject({
      latest_reopened_action_id: reopened.id,
      can_reopen: false,
    });
    await expect(reopenNormalDiagnosticGeneration({
      tenantId: fixture.tenantId,
      generationId: String(generation.id),
      reason: 'A second reopen must not create an unclosable duplicate obligation.',
      idempotencyKey: `diagnostic-reopen-second-${token()}`,
      activationEvidenceCapability: activationCapability,
    }, {
      actorUid: fixture.doctorUid,
      actorName: 'Ordering Doctor',
      actorRole: 'DOCTOR',
      actorRoles: ['DOCTOR'],
    })).rejects.toMatchObject({ code: 'DIAGNOSTIC_REOPEN_NOT_ACTIONABLE' });
    const task = await loadActionTask(fixture, generation.id);
    expect(task).toMatchObject({
      status: 'open',
      assigned_to_uid: fixture.doctorUid,
      sla_completion_semantics: 'domain_evidence',
    });
    const disposition = await recordDoctorDiagnosticDisposition({
      tenantId: fixture.tenantId,
      generationId: String(generation.id),
      taskId: Number(task.id),
      disposition: 'no_action',
      clinicalNote: 'Re-reviewed the complete generation after discretionary reopen.',
      reason: 'No new intervention is indicated after re-review.',
      generationSnapshotSha256: generation.snapshot_sha256,
      idempotencyKey: `diagnostic-reopen-action-${token()}`,
      attested: true,
      activationEvidenceCapability: activationCapability,
    }, {
      actorUid: fixture.doctorUid,
      actorName: 'Ordering Doctor',
      actorRole: 'DOCTOR',
      actorRoles: ['DOCTOR'],
    });
    expect(disposition).toMatchObject({
      action_kind: 'doctor_disposition',
      pathway: { clinical_status: 'completed' },
    });
    const preserved = await setTenantTx(fixture.tenantId, (tx) => tx.$queryRawUnsafe(
      `SELECT action_kind, predecessor_action_id
         FROM diagnostic_result_actions
        WHERE tenant_id = $1::uuid AND generation_id = $2::uuid
        ORDER BY occurred_at, id`,
      fixture.tenantId,
      generation.id,
    ));
    expect(preserved.map((row) => row.action_kind)).toEqual([
      'normal_auto_closed',
      'doctor_reopened',
      'doctor_disposition',
    ]);
    expect(String(preserved[1].predecessor_action_id)).toBe(closure.id);
  });
});
