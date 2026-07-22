import { randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
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
         ($1::uuid, $5::uuid, 'Diagnostic Patient', 'PATIENT', TRUE, 'active', NOW()),
         ($2::uuid, $5::uuid, 'Ordering Doctor', 'DOCTOR', TRUE, 'active', NOW()),
         ($3::uuid, $5::uuid, 'Other Doctor', 'DOCTOR', TRUE, 'active', NOW()),
         ($4::uuid, $5::uuid, 'Governance Approver', 'ADMIN', TRUE, 'active', NOW())`,
      patientUid,
      doctorUid,
      otherDoctorUid,
      approverUid,
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
    expect(reconciled).toHaveLength(4);
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
