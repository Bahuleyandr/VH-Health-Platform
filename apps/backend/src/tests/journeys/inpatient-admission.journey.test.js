// Journey: inpatient-admission (swarm journey #5) — deterministic in-CI replacement.
//
// A patient is admitted to a ward bed and the ward team runs the first shift.
// Flow through the REAL API surface across roles:
//   1. Admissions desk (ADMIN) admits the patient to a bed, naming the
//      admitting doctor (canonical: admission.created; bed → occupied).
//   2. Ward nurse records admission vitals (canonical: vitals.recorded).
//   3. Ward nurse records an intake/output entry (canonical: io.recorded).
//   4. Admitting doctor places a routine inpatient order bundle via bulk order
//      (canonical: order.created per order), scoped to the admission encounter.
//   5. Admitting doctor writes the admission H&P note (canonical: note.created).
//   6. The doctor orders a pending diagnostic with exact admission lineage.
//   7. The team opens discharge planning while LAMA/death remain ungated.
//   8. Named-owner handoff, formal medication reconciliation, and an audited
//      follow-up exception satisfy the accountable evidence contract.
//   9. A structured summary is signed and includes the pending result.
//  10. Existing discharge work clears, the patient leaves, and the bed enters
//      cleaning.
//  11. The pending diagnostic returns, then a direct corrected successor
//      re-arms the append-only named-owner action.
//  12. The named physician records the post-discharge recovery contact.
//
// Assertions: admit RBAC (a non-clinical GENERAL role cannot admit; missing
// consent on a non-emergency admit is blocked), bed state change, the
// admission state machine, governed pathway projection, exact diagnostic and
// discharge-evidence lineage, and the canonical clinical-timeline invariant on
// every clinical write through the recovery-contact stop.
//
// Deterministic: per-run clinical fixtures plus one reusable immutable
// governed definition; admitting-doctor relationship + nurse care-team
// authorise the clinical writes; no time-of-day dependence.

import { jest } from '@jest/globals';

import {
  describeJourney,
  roleClient,
  runSuffix,
  seedUser,
  seedDoctor,
  seedTreatmentConsent,
  seedWardWithBeds,
  grantCareTeam,
  assertCanonicalClinicalWrite,
  CANONICAL_EVENTS,
  DEFAULT_TENANT,
  prisma,
} from './_journeyHarness.js';
import { setTenantTx } from '../../lib/prisma.js';
import {
  createPathwayActivationEvidenceCapabilityForTests,
} from '../../services/pathways/pathwayExecutorService.js';
import {
  INPATIENT_ADMISSION_TO_RECOVERY_DEFINITION,
  compileInpatientAdmissionToRecoveryDefinition,
} from '../../services/pathways/inpatientPathwayDefinition.js';
import { projectInpatientPathwayEvent } from '../../services/pathways/inpatientPathwayProjector.js';
import {
  DIAGNOSTIC_ACTION_SLA_RULE_CODE,
  DIAGNOSTICS_ORDER_TO_ACTION_DEFINITION,
  compileDiagnosticsOrderToActionDefinition,
} from '../../services/pathways/diagnosticsPathwayDefinition.js';
import { projectDiagnosticPathwayEvent } from '../../services/pathways/diagnosticPathwayProjector.js';
import {
  closeNormalDiagnosticGenerationIfEligible,
  recordDoctorDiagnosticDisposition,
  reopenNormalDiagnosticGeneration,
} from '../../services/diagnostics/diagnosticResultActionService.js';
import {
  createLabDiagnosticGenerationTx,
} from '../../services/diagnostics/diagnosticResultGenerationService.js';
import { releaseResultNow } from '../../services/portal/portalAccessService.js';

const RUN = runSuffix();
const ADMIN_UID = `b3010001-0000-4000-8000-${RUN.padStart(12, '0')}`;
const DOCTOR_UID = `b3010002-0000-4000-8000-${RUN.padStart(12, '0')}`;
const NURSE_UID = `b3010003-0000-4000-8000-${RUN.padStart(12, '0')}`;
const PATIENT_UID = `b3010004-0000-4000-8000-${RUN.padStart(12, '0')}`;
const NOCONSENT_UID = `b3010005-0000-4000-8000-${RUN.padStart(12, '0')}`;
const COVERING_DOCTOR_UID = `b3010006-0000-4000-8000-${RUN.padStart(12, '0')}`;
const WARD_NAME = `JWard-${RUN}`;
const BED_A = `JBED-A-${RUN}`;
const BED_B = `JBED-B-${RUN}`;
const DEPARTMENT = `JInpatient-${RUN}`;
const PATIENT_PHONE = `96401${RUN}`;
const NOCONSENT_PHONE = `96402${RUN}`;
const DOCTOR_PHONE = `+9196403${RUN}`;
const NURSE_PHONE = `+9196404${RUN}`;
const COVERING_DOCTOR_PHONE = `+9196405${RUN}`;
const PATHWAY_KEY = 'inpatient_admission_to_recovery';
const DIAGNOSTIC_PATHWAY_KEY = 'diagnostics_order_to_action';
const SUMMARY_TEMPLATE_CODE = `J-IPD-${RUN}`;
const PENDING_RESULT_LABEL = `Sputum culture pending (${RUN})`;
const GOVERNANCE_OWNER_UID = 'b3ff0001-0000-4000-8000-000000000001';
const GOVERNANCE_APPROVER_UID = 'b3ff0002-0000-4000-8000-000000000002';
const DISCHARGE_CLOSURE_SECTIONS = Object.freeze([
  Object.freeze({
    section_key: 'patient_guardian_instructions',
    section_title: 'Patient / Guardian Instructions',
    display_order: 900,
    body: 'Complete the oral antibiotic course, hydrate, mobilise as tolerated, and use the breathing exercises taught on the ward.',
    blocker: 'PATIENT_GUARDIAN_INSTRUCTIONS_REQUIRED',
  }),
  Object.freeze({
    section_key: 'escalation_contact',
    section_title: 'Escalation Contact',
    display_order: 901,
    body: 'Call the hospital respiratory service at the number printed on the discharge pack for fever, worsening breathlessness, or confusion.',
    blocker: 'ESCALATION_CONTACT_REQUIRED',
  }),
  Object.freeze({
    section_key: 'required_equipment_home_care',
    section_title: 'Required Equipment / Home Care',
    display_order: 902,
    body: 'None required.',
    blocker: 'EQUIPMENT_HOME_CARE_PLAN_REQUIRED',
  }),
  Object.freeze({
    section_key: 'discharge_destination',
    section_title: 'Discharge Destination',
    display_order: 903,
    body: 'Home with family support.',
    blocker: 'DISCHARGE_DESTINATION_REQUIRED',
  }),
  Object.freeze({
    section_key: 'transport_plan',
    section_title: 'Transport Plan',
    display_order: 904,
    body: 'Family will provide private transport from the ward.',
    blocker: 'TRANSPORT_PLAN_REQUIRED',
  }),
]);
const activationCapability = createPathwayActivationEvidenceCapabilityForTests();
const compiledInpatientDefinition = compileInpatientAdmissionToRecoveryDefinition();
const compiledDiagnosticDefinition = compileDiagnosticsOrderToActionDefinition();

jest.setTimeout(120_000);

async function seedGovernedDefinition({
  compiledDefinition,
  rawDefinition,
  displayName,
}) {
  const existing = await prisma.$queryRawUnsafe(
    `SELECT definition.id,
            governance.id AS governance_id,
            governance.definition_checksum,
            approval.id AS approval_id,
            (
              definition.steps = $4::jsonb
              AND definition.triggers = $5::jsonb
              AND definition.defaults = $6::jsonb
              AND definition.is_active = TRUE
              AND governance.governance_status = 'approved'
              AND governance.approved_at IS NOT NULL
              AND governance.definition_checksum = $7::text
              AND approval.approval_kind = 'care_pathway_definition_governance'
              AND approval.subject_resource_type = 'care_pathway_definition'
              AND approval.subject_resource_id = definition.id::text
              AND approval.status = 'approved'
              AND approval.decided_at IS NOT NULL
              AND approval.metadata #>> ARRAY[
                    'care_pathway_definition_governance',
                    'definition_checksum'
                  ] = $7::text
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
    JSON.stringify(rawDefinition.steps),
    JSON.stringify(rawDefinition.triggers),
    JSON.stringify(rawDefinition.defaults),
    compiledDefinition.checksum,
  );
  if (existing.length > 1 || (existing[0] && existing[0].exact_fixture !== true)) {
    throw new Error(
      `Default tenant has a conflicting ${compiledDefinition.workflow_key} definition fixture`,
    );
  }
  if (existing[0]) return existing[0];

  // Published governance is immutable by design, so its actors and definition
  // are stable reusable fixtures rather than per-run rows that cleanup would
  // later be unable to delete.
  await seedUser({
    uid: GOVERNANCE_OWNER_UID,
    phone: null,
    name: 'Inpatient Pathway Governance Owner',
    role: 'DOCTOR',
  });
  await seedUser({
    uid: GOVERNANCE_APPROVER_UID,
    phone: null,
    name: 'Inpatient Pathway Governance Approver',
    role: 'ADMIN',
  });
  const inserted = await setTenantTx(DEFAULT_TENANT, async (tx) => {
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
      displayName,
      JSON.stringify(rawDefinition.steps),
      JSON.stringify(rawDefinition.triggers),
      JSON.stringify(rawDefinition.defaults),
      GOVERNANCE_OWNER_UID,
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
      GOVERNANCE_APPROVER_UID,
      compiledDefinition.checksum,
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
      GOVERNANCE_OWNER_UID,
      Number(approvals[0].id),
      GOVERNANCE_APPROVER_UID,
      compiledDefinition.checksum,
    );
    return {
      id: definitionId,
      approval_id: Number(approvals[0].id),
      governance_id: governance[0].id,
      exact_fixture: true,
    };
  });
  return inserted;
}

async function activateJourneyPathways() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT settings FROM tenants WHERE id = $1::uuid`,
    DEFAULT_TENANT,
  );
  if (!rows[0]) throw new Error('Default test tenant is unavailable');
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
    PATHWAY_KEY,
    DIAGNOSTIC_PATHWAY_KEY,
  );
  return rows[0].settings;
}

async function restoreTenantSettings(settings) {
  await prisma.$executeRawUnsafe(
    `UPDATE tenants
        SET settings = $2::jsonb,
            updated_at = NOW()
      WHERE id = $1::uuid`,
    DEFAULT_TENANT,
    JSON.stringify(settings),
  );
}

async function seedDischargeSummaryTemplate() {
  const sections = [
    {
      section_key: 'diagnosis',
      section_title: 'Diagnosis',
      display_order: 1,
      default_body: 'Community-acquired pneumonia, clinically improved.',
    },
    {
      section_key: 'discharge_medications',
      section_title: 'Discharge medications',
      display_order: 2,
      default_body: 'No take-home medicines after formal medication reconciliation.',
    },
    {
      section_key: 'pending_results',
      section_title: 'Pending results',
      display_order: 3,
      default_body: 'Pending diagnostic result ownership will be completed before sign-off.',
    },
    {
      section_key: 'follow_up',
      section_title: 'Follow-up',
      display_order: 4,
      default_body: 'Follow-up exception documented in the admission audit trail.',
    },
    ...DISCHARGE_CLOSURE_SECTIONS.map((section) => ({
      section_key: section.section_key,
      section_title: section.section_title,
      display_order: section.display_order,
    })),
  ];
  await prisma.$executeRawUnsafe(
    `INSERT INTO discharge_summary_templates
       (tenant_id, code, display_name, specialty, sections, active, updated_at)
     VALUES
       ($1::uuid, $2::text, $3::text, 'general_medicine', $4::jsonb, TRUE, NOW())
     ON CONFLICT (tenant_id, code)
     DO UPDATE SET display_name = EXCLUDED.display_name,
                   specialty = EXCLUDED.specialty,
                   sections = EXCLUDED.sections,
                   active = TRUE,
                   updated_at = NOW()`,
    DEFAULT_TENANT,
    SUMMARY_TEMPLATE_CODE,
    `Journey inpatient discharge ${RUN}`,
    JSON.stringify(sections),
  );
}

async function seedDiagnosticActionSlaRule() {
  const existing = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM workflow_sla_rules
      WHERE tenant_id = $1::uuid
        AND rule_code = $2::text
      LIMIT 2`,
    DEFAULT_TENANT,
    DIAGNOSTIC_ACTION_SLA_RULE_CODE,
  );
  if (existing.length > 1) {
    throw new Error('Default tenant has ambiguous diagnostic action SLA fixtures');
  }
  if (existing[0]) return existing[0];
  const inserted = await prisma.$queryRawUnsafe(
    `INSERT INTO workflow_sla_rules
       (tenant_id, rule_code, title, trigger_event_type, target_minutes,
        severity, owner_role_codes, escalation_role_codes, enabled, metadata)
     VALUES
       ($1::uuid, $2::text, 'Journey diagnostic action review',
        'diagnostic.result.generation_signed', 30, 'high',
        ARRAY['DOCTOR']::text[], ARRAY['ADMIN']::text[], TRUE,
        '{"synthetic_test_only":true}'::jsonb)
     RETURNING id`,
    DEFAULT_TENANT,
    DIAGNOSTIC_ACTION_SLA_RULE_CODE,
  );
  return inserted[0];
}

async function projectLatestInpatientEvent(admissionId, eventType, aggregateId = null) {
  return setTenantTx(DEFAULT_TENANT, async (tx) => {
    const events = await tx.$queryRawUnsafe(
      `SELECT *
         FROM event_outbox
        WHERE tenant_id = $1::uuid
          AND event_type = $2::text
          AND payload ->> 'admission_id' = $3::text
          AND ($4::text IS NULL OR aggregate_id = $4::text)
        ORDER BY id DESC
        LIMIT 1`,
      DEFAULT_TENANT,
      eventType,
      String(admissionId),
      aggregateId == null ? null : String(aggregateId),
    );
    expect(events).toHaveLength(1);
    return projectInpatientPathwayEvent({
      tx,
      consumerKey: 'care_pathway_projector',
      generation: 4,
      tenantId: DEFAULT_TENANT,
      event: events[0],
      activationEvidenceCapability: activationCapability,
    });
  });
}

async function projectDiagnosticGeneration(generationId) {
  return setTenantTx(DEFAULT_TENANT, async (tx) => {
    const events = await tx.$queryRawUnsafe(
      `SELECT outbox.*
         FROM event_outbox AS outbox
        WHERE outbox.tenant_id = $1::uuid
          AND outbox.aggregate_type = 'diagnostic_result_generation'
          AND outbox.aggregate_id = $2::text
        ORDER BY outbox.id DESC
        LIMIT 1`,
      DEFAULT_TENANT,
      generationId,
    );
    expect(events).toHaveLength(1);
    return projectDiagnosticPathwayEvent({
      tx,
      consumerKey: 'care_pathway_projector',
      generation: 3,
      tenantId: DEFAULT_TENANT,
      event: events[0],
      activationEvidenceCapability: activationCapability,
    });
  });
}

async function createNormalLabGeneration({
  investigationId,
  admissionId,
}) {
  return setTenantTx(DEFAULT_TENANT, async (tx) => {
    const results = await tx.$queryRawUnsafe(
      `INSERT INTO lab_results
         (tenant_id, patient_uid, admission_id, investigation_id,
          test_code, test_name, value_text, unit, reference_range,
          abnormal_flag, is_critical, status, signed_off_at, signed_off_by,
          release_hold, updated_at)
       VALUES
         ($1::uuid, $2::uuid, $3::integer, $4::integer,
          'SPUTCULT-N', 'Sputum culture correction', 'Normal respiratory flora',
          NULL, 'Normal respiratory flora', 'N', FALSE, 'final', NOW(), $5::uuid,
          FALSE, NOW())
       RETURNING *`,
      DEFAULT_TENANT,
      PATIENT_UID,
      admissionId,
      investigationId,
      DOCTOR_UID,
    );
    const signoffs = await tx.$queryRawUnsafe(
      `INSERT INTO lab_pathologist_signoffs
         (tenant_id, patient_uid, result_ids, signed_off_by,
          signed_off_by_name, decision, signed_at)
       VALUES
         ($1::uuid, $2::uuid, $3::integer[], $4::uuid,
          $5::text, 'verified', NOW())
       RETURNING *`,
      DEFAULT_TENANT,
      PATIENT_UID,
      [Number(results[0].id)],
      DOCTOR_UID,
      `Dr Ward ${RUN}`,
    );
    const generation = await createLabDiagnosticGenerationTx({
      tx,
      tenantId: DEFAULT_TENANT,
      patientUid: PATIENT_UID,
      episode: {
        type: 'investigation',
        id: investigationId,
        key: `investigation:${investigationId}`,
      },
      signoff: signoffs[0],
      signerRole: 'DOCTOR',
      panelRows: results,
    });
    return Object.freeze({
      ...generation,
      lab_result_id: Number(results[0].id),
    });
  });
}

async function diagnosticActionTask(generationId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT task.*,
            pathway.id AS pathway_instance_id,
            pathway.workflow_run_id,
            step.id AS workflow_step_id
       FROM care_pathway_instances AS pathway
       JOIN workflow_runs AS run
         ON run.tenant_id = pathway.tenant_id
        AND run.id = pathway.workflow_run_id
       JOIN workflow_steps AS step
         ON step.tenant_id = run.tenant_id
        AND step.workflow_run_id = run.id
        AND step.step_key = 'record_doctor_action'
       JOIN tasks AS task
         ON task.tenant_id = step.tenant_id
        AND task.workflow_run_id = step.workflow_run_id
        AND task.workflow_step_id = step.id
      WHERE pathway.tenant_id = $1::uuid
        AND pathway.pathway_key = $2::text
        AND pathway.source_episode_type = 'diagnostic_result_generation'
        AND pathway.source_episode_id = $3::text
      ORDER BY pathway.created_at DESC
      LIMIT 1`,
    DEFAULT_TENANT,
    DIAGNOSTIC_PATHWAY_KEY,
    generationId,
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

function rulesReadiness(response) {
  return response.body.data?.rules_readiness
    || response.body.data?.draft?.rules_readiness;
}

async function pendingResultOwnerActionEvidence(handoffId) {
  return prisma.$queryRawUnsafe(
    `SELECT action.id,
            action.handoff_id,
            action.admission_id,
            action.patient_uid,
            action.generation_id,
            action.predecessor_generation_id,
            action.predecessor_owner_action_id,
            action.predecessor_resolution_action_id,
            action.rearm_source_action_id,
            action.task_id,
            action.owner_uid,
            action.source_outbox_event_id,
            action.canonical_timeline_event_id,
            action.canonical_audit_event_id,
            action.recorded_at,
            NOT EXISTS (
              SELECT 1
                FROM discharge_pending_result_owner_actions AS successor
               WHERE successor.tenant_id = action.tenant_id
                 AND successor.handoff_id = action.handoff_id
                  AND successor.predecessor_owner_action_id = action.id
            ) AS is_current,
            generation.source_kind,
            generation.source_table,
            generation.source_episode_type,
            generation.source_episode_key,
            generation.source_version,
            generation.investigation_id,
            generation.ordering_owner_uid,
            generation.owner_source,
            generation.signer_uid,
            generation.signer_role,
            generation.classification,
            generation.item_count,
            task.task_kind,
            task.parent_task_id,
            task.related_resource_type,
            task.related_resource_id,
            task.patient_uid AS task_patient_uid,
            task.assigned_to_uid,
            task.assigned_to_role,
            task.created_by AS task_created_by,
            task.status AS task_status,
            task.completed_at AS task_completed_at,
            task.cancelled_at AS task_cancelled_at,
            task.cancellation_reason AS task_cancellation_reason,
            task.created_at AS task_created_at,
            task.updated_at AS task_updated_at,
            parent_task.status AS parent_task_status,
            parent_task.completed_at AS parent_task_completed_at,
            parent_task.cancelled_at AS parent_task_cancelled_at,
            timeline.event_type AS timeline_event_type,
            timeline.event_status AS timeline_event_status,
            timeline.source_table AS timeline_source_table,
            timeline.source_id AS timeline_source_id,
            timeline.resource_type AS timeline_resource_type,
            timeline.resource_id AS timeline_resource_id,
            timeline.payload ->> 'admission_id' AS timeline_admission_id,
            timeline.payload ->> 'handoff_id' AS timeline_handoff_id,
            timeline.payload ->> 'generation_id' AS timeline_generation_id,
            timeline.payload ->> 'predecessor_generation_id'
              AS timeline_predecessor_generation_id,
            audit.action AS audit_action,
            audit.action_status AS audit_action_status,
            audit.resource_table AS audit_resource_table,
            audit.resource_id AS audit_resource_id,
            outbox.event_type AS outbox_event_type,
            outbox.aggregate_type AS outbox_aggregate_type,
            outbox.aggregate_id AS outbox_aggregate_id,
            outbox.payload ->> 'generation_id' AS outbox_generation_id,
            outbox.payload ->> 'predecessor_generation_id'
              AS outbox_predecessor_generation_id
       FROM discharge_pending_result_owner_actions AS action
       JOIN diagnostic_result_generations AS generation
         ON generation.tenant_id = action.tenant_id
        AND generation.id = action.generation_id
        AND generation.patient_uid = action.patient_uid
        AND generation.admission_id = action.admission_id
        JOIN tasks AS task
         ON task.tenant_id = action.tenant_id
         AND task.id = action.task_id
       LEFT JOIN tasks AS parent_task
         ON parent_task.tenant_id = task.tenant_id
        AND parent_task.id = task.parent_task_id
       JOIN clinical_timeline_events AS timeline
         ON timeline.tenant_id = action.tenant_id
        AND timeline.id = action.canonical_timeline_event_id
       JOIN clinical_audit_events AS audit
         ON audit.tenant_id = action.tenant_id
        AND audit.id = action.canonical_audit_event_id
       JOIN event_outbox AS outbox
         ON outbox.tenant_id = action.tenant_id
        AND outbox.id = action.source_outbox_event_id
      WHERE action.tenant_id = $1::uuid
        AND action.handoff_id = $2::uuid
      ORDER BY generation.source_version ASC, action.recorded_at ASC, action.id ASC`,
    DEFAULT_TENANT,
    handoffId,
  );
}

async function ownerTransferStateSnapshot({
  admissionId,
  pathwayInstanceId,
  pendingResultHandoffId,
}) {
  const [core, transfers, ownerActions, assignments] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT admission.status AS admission_status,
              admission.attending_doctor,
              pathway.owning_clinician_uid,
              pending.handoff_state,
              pending.result_status,
              pending.named_physician_uid,
              pending.task_id::text AS tracking_task_id,
              pending.resolution_generation_id,
              pending.resolution_action_id,
              tracking.status AS tracking_status,
              tracking.completed_at::text AS tracking_completed_at
         FROM admissions AS admission
         JOIN care_pathway_instances AS pathway
           ON pathway.tenant_id = admission.tenant_id
          AND pathway.id = $3::uuid
         JOIN discharge_pending_result_handoffs AS pending
           ON pending.tenant_id = admission.tenant_id
          AND pending.id = $4::uuid
         JOIN tasks AS tracking
           ON tracking.tenant_id = pending.tenant_id
          AND tracking.id = pending.task_id
        WHERE admission.tenant_id = $1::uuid
          AND admission.id = $2::integer`,
      DEFAULT_TENANT,
      admissionId,
      pathwayInstanceId,
      pendingResultHandoffId,
    ),
    prisma.$queryRawUnsafe(
      `SELECT handoff.id,
              handoff.status,
              handoff.sender_uid,
              handoff.intended_recipient_uid,
              handoff.accepted_by_uid,
              handoff.accepted_at::text AS accepted_at,
              handoff.task_id::text AS task_id,
              task.status AS task_status,
              task.completed_at::text AS task_completed_at,
              task.cancelled_at::text AS task_cancelled_at
         FROM care_handoff_instances AS handoff
         JOIN tasks AS task
           ON task.tenant_id = handoff.tenant_id
          AND task.id = handoff.task_id
        WHERE handoff.tenant_id = $1::uuid
          AND handoff.sending_pathway_instance_id = $2::uuid
          AND handoff.handoff_type = 'covering_clinician_reassignment'
        ORDER BY handoff.created_at, handoff.id`,
      DEFAULT_TENANT,
      pathwayInstanceId,
    ),
    prisma.$queryRawUnsafe(
      `SELECT action.id,
              action.generation_id,
              action.predecessor_generation_id,
              action.predecessor_owner_action_id,
              action.predecessor_resolution_action_id,
              action.rearm_source_action_id,
              action.owner_uid,
              action.task_id::text AS task_id,
              task.status AS task_status,
              task.completed_at::text AS task_completed_at,
              task.parent_task_id::text AS parent_task_id
         FROM discharge_pending_result_owner_actions AS action
         JOIN tasks AS task
           ON task.tenant_id = action.tenant_id
          AND task.id = action.task_id
        WHERE action.tenant_id = $1::uuid
          AND action.handoff_id = $2::uuid
        ORDER BY action.recorded_at, action.id`,
      DEFAULT_TENANT,
      pendingResultHandoffId,
    ),
    prisma.$queryRawUnsafe(
      `SELECT assignment.id,
              assignment.assignment_version,
              assignment.physician_uid,
              assignment.assignment_source,
              assignment.accepted_handoff_id,
              assignment.supersedes_assignment_id
         FROM inpatient_primary_physician_assignments AS assignment
        WHERE assignment.tenant_id = $1::uuid
          AND assignment.admission_id = $2::integer
        ORDER BY assignment.assignment_version`,
      DEFAULT_TENANT,
      admissionId,
    ),
  ]);
  return { core, transfers, ownerActions, assignments };
}

describeJourney('Journey: inpatient-admission', () => {
  let admin;
  let doctor;
  let coveringDoctor;
  let nurse;
  let general;
  let doctorUserId;
  let coveringDoctorUserId;
  let patientId;
  let bedAId;
  let bedBId;
  let admissionId;
  let admissionEncounterId;
  let tenantSettingsBefore;
  let workflowDefinitionId;
  let pathwayGovernanceId;
  let pathwayApprovalId;
  let pathwayInstanceId;
  let investigationId;
  let resourceReferenceId;
  let pendingResultHandoffId;
  let pendingResultTrackingTaskId;
  let structuredSummaryId;
  let medicationReconciliationId;
  let initialGenerationId;
  let correctedGenerationId;
  let initialGenerationSnapshotSha256;
  let initialDiagnosticTaskId;
  let initialOwnerActionId;
  let initialOwnerActionTaskId;
  let firstTransferHandoffId;
  let firstTransferTaskId;
  let secondTransferHandoffId;
  let secondTransferTaskId;
  let initialDisposition;
  let initialCrossSignRequest;
  let initialCrossSignResolution;

  beforeAll(async () => {
    const adminRow = await seedUser({ uid: ADMIN_UID, phone: `+9196400${RUN}`, name: `Adm Officer ${RUN}`, role: 'ADMIN' });
    const doc = await seedDoctor({ uid: DOCTOR_UID, phone: DOCTOR_PHONE, name: `Dr Ward ${RUN}`, department: DEPARTMENT });
    doctorUserId = doc.userId;
    const coveringDoc = await seedDoctor({
      uid: COVERING_DOCTOR_UID,
      phone: COVERING_DOCTOR_PHONE,
      name: `Dr Covering ${RUN}`,
      department: DEPARTMENT,
    });
    coveringDoctorUserId = coveringDoc.userId;
    const nurseRow = await seedUser({ uid: NURSE_UID, phone: NURSE_PHONE, name: `Ward Nurse ${RUN}`, role: 'NURSING_STAFF' });

    const patient = await seedUser({ uid: PATIENT_UID, phone: `+91${PATIENT_PHONE}`, name: `Inpatient ${RUN}`, role: 'PATIENT' });
    patientId = patient.id;
    await seedTreatmentConsent(PATIENT_UID);

    // A second patient deliberately WITHOUT consent, to prove the consent gate.
    await seedUser({ uid: NOCONSENT_UID, phone: `+91${NOCONSENT_PHONE}`, name: `NoConsent ${RUN}`, role: 'PATIENT' });

    const ward = await seedWardWithBeds({ wardName: WARD_NAME, bedNumbers: [BED_A, BED_B] });
    [bedAId, bedBId] = ward.bedIds;

    admin = roleClient('ADMIN', { uid: ADMIN_UID, id: adminRow.id });
    doctor = roleClient('DOCTOR', { uid: DOCTOR_UID, id: doctorUserId, phone: DOCTOR_PHONE });
    coveringDoctor = roleClient('DOCTOR', {
      uid: COVERING_DOCTOR_UID,
      id: coveringDoctorUserId,
      phone: COVERING_DOCTOR_PHONE,
    });
    nurse = roleClient('NURSING_STAFF', { uid: NURSE_UID, id: nurseRow.id, phone: NURSE_PHONE });
    general = roleClient('GENERAL', { uid: ADMIN_UID, id: adminRow.id });

    // Keep both clinicians on the longitudinal care team so the nurse can write
    // during admission and the named physician can record recovery contact
    // after the admission relationship becomes historical.
    await grantCareTeam({ patientUid: PATIENT_UID, staffUid: NURSE_UID, staffRole: 'NURSING_STAFF', memberName: `Inpatient ${RUN}` });
    await grantCareTeam({ patientUid: PATIENT_UID, staffUid: DOCTOR_UID, staffRole: 'DOCTOR', memberName: `Inpatient ${RUN}` });
    await grantCareTeam({ patientUid: PATIENT_UID, staffUid: COVERING_DOCTOR_UID, staffRole: 'DOCTOR', memberName: `Inpatient ${RUN}` });

    await seedDiagnosticActionSlaRule();
    const governedDefinition = await seedGovernedDefinition({
      compiledDefinition: compiledInpatientDefinition,
      rawDefinition: INPATIENT_ADMISSION_TO_RECOVERY_DEFINITION,
      displayName: 'Inpatient admission to recovery journey',
    });
    workflowDefinitionId = Number(governedDefinition.id);
    pathwayGovernanceId = governedDefinition.governance_id;
    pathwayApprovalId = Number(governedDefinition.approval_id);
    await seedGovernedDefinition({
      compiledDefinition: compiledDiagnosticDefinition,
      rawDefinition: DIAGNOSTICS_ORDER_TO_ACTION_DEFINITION,
      displayName: 'Diagnostics order to action journey',
    });
    tenantSettingsBefore = await activateJourneyPathways();
    await seedDischargeSummaryTemplate();
  });

  afterAll(async () => {
    // Pathway transitions and diagnostic generations are intentionally
    // append-only, including in tests. The isolated CI/scratch database owns
    // fixture reclamation; this suite only restores the tenant control-plane
    // setting it changed.
    try {
      if (tenantSettingsBefore !== undefined) {
        await restoreTenantSettings(tenantSettingsBefore);
      }
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  });

  describe('Step 1 — admissions desk admits the patient', () => {
    it('forbids a non-clinical GENERAL role from admitting', async () => {
      const res = await general.post('/api/v1/emr/admit').send({ patient_uid: PATIENT_UID });
      expect(res.statusCode).toBe(403);
    });

    it('blocks a non-emergency admit when the patient has no active consent', async () => {
      const res = await admin.post('/api/v1/emr/admit').send({
        patient_uid: NOCONSENT_UID,
        admitting_doctor: DOCTOR_UID,
        chief_complaint: 'Elective workup',
        admission_type: 'elective',
        priority: 'routine',
        bed_id: bedBId,
      });
      expect(res.statusCode).toBe(403);
      expect(String(res.body.code || res.body.message || '')).toMatch(/consent/i);
    });

    it('admits the consented patient to a bed and writes the canonical admission triple', async () => {
      const res = await admin.post('/api/v1/emr/admit').send({
        patient_uid: PATIENT_UID,
        admitting_doctor: DOCTOR_UID,
        chief_complaint: 'Community-acquired pneumonia, hypoxic',
        admitting_diagnosis: 'CAP',
        admission_type: 'elective',
        priority: 'routine',
        department: DEPARTMENT,
        bed_id: bedAId,
        code_status: 'full_code',
      });
      expect(res.statusCode).toBe(201);
      admissionId = res.body.data?.admission?.id;
      admissionEncounterId = res.body.data?.admission?.encounter_id;
      expect(admissionId).toBeDefined();
      expect(admissionEncounterId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );

      // Bed is now occupied by this admission.
      const bed = await prisma.$queryRawUnsafe(`SELECT status FROM beds WHERE id = $1`, bedAId);
      expect(String(bed[0].status).toLowerCase()).toBe('occupied');

      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.admissionCreated, sourceId: admissionId, patientUid: PATIENT_UID,
      });

      const encounters = await prisma.$queryRawUnsafe(
        `SELECT encounter.id,
                encounter.tenant_id,
                encounter.patient_uid,
                encounter.encounter_type,
                encounter.status,
                encounter.admission_id,
                encounter.admission_encounter_id,
                encounter.primary_doctor_uid,
                encounter.created_by,
                encounter.updated_by
           FROM patient_encounters AS encounter
          WHERE encounter.tenant_id = $1::uuid
            AND encounter.id = $2::uuid
            AND encounter.admission_id = $3::integer`,
        DEFAULT_TENANT,
        admissionEncounterId,
        admissionId,
      );
      expect(encounters).toHaveLength(1);
      expect(encounters[0]).toMatchObject({
        id: admissionEncounterId,
        tenant_id: DEFAULT_TENANT,
        patient_uid: PATIENT_UID,
        encounter_type: 'ip',
        status: 'active',
        admission_id: admissionId,
        admission_encounter_id: admissionEncounterId,
        primary_doctor_uid: DOCTOR_UID,
        created_by: ADMIN_UID,
        updated_by: ADMIN_UID,
      });

      await projectLatestInpatientEvent(admissionId, 'admission.created', admissionId);
      const assignments = await prisma.$queryRawUnsafe(
        `SELECT assignment.id,
                assignment.admission_id,
                assignment.patient_uid,
                assignment.assignment_version,
                assignment.physician_uid,
                assignment.assignment_source,
                assignment.canonical_timeline_event_id,
                assignment.canonical_audit_event_id
           FROM inpatient_primary_physician_assignments AS assignment
          WHERE assignment.tenant_id = $1::uuid
            AND assignment.admission_id = $2::integer
            AND assignment.patient_uid = $3::uuid`,
        DEFAULT_TENANT,
        admissionId,
        PATIENT_UID,
      );
      expect(assignments).toHaveLength(1);
      expect(assignments[0]).toMatchObject({
        admission_id: admissionId,
        patient_uid: PATIENT_UID,
        assignment_version: 1,
        physician_uid: DOCTOR_UID,
        assignment_source: 'admitting_physician',
      });
      expect(assignments[0].canonical_timeline_event_id).toBeTruthy();
      expect(assignments[0].canonical_audit_event_id).toBeTruthy();

      const pathways = await prisma.$queryRawUnsafe(
        `SELECT pathway.id,
                pathway.patient_uid,
                pathway.source_episode_type,
                pathway.source_episode_id,
                pathway.owning_clinician_uid,
                pathway.workflow_definition_id,
                pathway.definition_governance_id,
                pathway.definition_checksum,
                definition.version AS definition_version,
                definition.steps AS definition_steps,
                governance.approval_id,
                governance.governance_status,
                governance.definition_checksum AS governance_checksum,
                approval.status AS approval_status,
                reference.id AS root_reference_id
           FROM care_pathway_instances AS pathway
           JOIN workflow_definitions AS definition
             ON definition.tenant_id = pathway.tenant_id
            AND definition.id = pathway.workflow_definition_id
           JOIN care_pathway_definition_governance AS governance
             ON governance.tenant_id = pathway.tenant_id
            AND governance.id = pathway.definition_governance_id
            AND governance.workflow_definition_id = definition.id
           JOIN approvals AS approval
             ON approval.tenant_id = governance.tenant_id
            AND approval.id = governance.approval_id
           JOIN care_pathway_resource_references AS reference
             ON reference.tenant_id = pathway.tenant_id
            AND reference.pathway_instance_id = pathway.id
            AND reference.patient_uid = pathway.patient_uid
            AND reference.resource_type = 'admission'
            AND reference.resource_id = $2::text
            AND reference.relationship_kind = 'closure_evidence'
            AND reference.evidence_state = 'open'
          WHERE pathway.tenant_id = $1::uuid
            AND pathway.pathway_key = $3::text
            AND pathway.source_episode_type = 'admission'
            AND pathway.source_episode_id = $2::text`,
        DEFAULT_TENANT,
        String(admissionId),
        PATHWAY_KEY,
      );
      expect(pathways).toHaveLength(1);
      expect(pathways[0]).toMatchObject({
        patient_uid: PATIENT_UID,
        source_episode_type: 'admission',
        source_episode_id: String(admissionId),
        owning_clinician_uid: DOCTOR_UID,
        workflow_definition_id: workflowDefinitionId,
        definition_governance_id: pathwayGovernanceId,
        definition_checksum: compiledInpatientDefinition.checksum,
        definition_version: compiledInpatientDefinition.version,
        approval_id: pathwayApprovalId,
        governance_status: 'approved',
        governance_checksum: compiledInpatientDefinition.checksum,
        approval_status: 'approved',
      });
      expect(pathways[0].definition_steps).toEqual(
        INPATIENT_ADMISSION_TO_RECOVERY_DEFINITION.steps,
      );
      expect(pathways[0].root_reference_id).toBeTruthy();
      pathwayInstanceId = pathways[0].id;
    });
  });

  describe('Step 2 — ward nurse records admission vitals', () => {
    it('records vitals and writes the canonical vitals triple', async () => {
      const res = await nurse.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID,
        heart_rate: 104,
        systolic_bp: 110,
        diastolic_bp: 70,
        temperature: 38.9,
        spo2: 91,
        respiratory_rate: 26,
      });
      expect(res.statusCode).toBe(201);
      const vitalsId = res.body.data?.vitals?.id;
      expect(vitalsId).toBeTruthy();
      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.vitalsRecorded, sourceId: vitalsId, patientUid: PATIENT_UID,
      });
    });
  });

  describe('Step 3 — ward nurse records intake/output', () => {
    it('records an I/O entry and writes the canonical io triple', async () => {
      const res = await nurse.post('/api/v1/emr/io').send({
        patient_uid: PATIENT_UID,
        io_type: 'intake',
        category: 'iv',
        amount_ml: 500,
        description: 'NS bolus',
      });
      expect(res.statusCode).toBe(201);
      const ioId = res.body.data?.id || res.body.data?.io?.id || res.body.data?.entry?.id;
      expect(ioId).toBeTruthy();
      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.ioRecorded, sourceId: ioId, patientUid: PATIENT_UID,
      });
    });
  });

  describe('Step 4 — admitting doctor places the admission order bundle', () => {
    it('creates a bulk order set and writes a canonical order triple per order', async () => {
      const res = await doctor.post('/api/v1/emr/orders/bulk').send({
        orders: [
          {
            patient_uid: PATIENT_UID,
            order_type: 'investigation',
            priority: 'routine',
            details: { test_name: 'Chest X-ray PA', reason: 'CAP' },
          },
          {
            patient_uid: PATIENT_UID,
            order_type: 'nursing',
            priority: 'routine',
            details: { description: 'O2 to keep SpO2 >= 94%', frequency: 'continuous' },
          },
        ],
      });
      expect(res.statusCode).toBe(201);
      const created = res.body.data;
      expect(Array.isArray(created)).toBe(true);
      expect(created.length).toBe(2);

      for (const item of created) {
        // Bulk returns { order, cds_warnings } per item.
        const orderId = item.order?.id ?? item.id;
        expect(orderId).toBeTruthy();
        await assertCanonicalClinicalWrite({
          event: CANONICAL_EVENTS.orderCreated, sourceId: orderId, patientUid: PATIENT_UID,
        });
      }
    });
  });

  describe('Step 5 — admitting doctor writes the admission note', () => {
    it('creates an admission_note and writes the canonical note triple', async () => {
      const res = await doctor.post('/api/v1/emr/notes').send({
        patient_uid: PATIENT_UID,
        note_type: 'admission_note',
        content: {
          chief_complaint: 'Fever and breathlessness x 4 days',
          history_of_present_illness: 'Productive cough, pleuritic chest pain, hypoxia on arrival.',
          assessment: 'Community-acquired pneumonia, CURB-65 2.',
          plan: 'IV antibiotics, O2, CXR, monitor sats; reassess in 24h.',
        },
      });
      expect(res.statusCode).toBe(201);
      const noteId = res.body.data.id;
      expect(res.body.data.note_type).toBe('admission_note');
      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.noteCreated, sourceId: noteId, patientUid: PATIENT_UID,
      });
    });

    it('canonical timeline carries the inpatient admission events', async () => {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT event_type FROM clinical_timeline_events WHERE patient_uid = $1::uuid`,
        PATIENT_UID);
      const types = rows.map((r) => r.event_type);
      expect(types).toEqual(expect.arrayContaining([
        'admission.created', 'vitals.recorded', 'io.recorded', 'order.created', 'note.created',
      ]));
    });
  });

  describe('Step 6 — exact pending diagnostic lineage is projected', () => {
    it('orders an admission-scoped pending investigation and projects its child reference', async () => {
      const res = await doctor.post('/api/v1/investigations/order').send({
        patient_id: patientId,
        admission_id: admissionId,
        test_name: 'Sputum culture and sensitivity',
        type: 'LAB',
        priority: 'NORMAL',
        notes: 'Pending at discharge; ordering physician remains accountable for review.',
      });
      expect(res.statusCode).toBe(200);
      const investigation = res.body.data?.investigation;
      expect(investigation).toMatchObject({
        patient_id: patientId,
        patient_uid: PATIENT_UID,
        admission_id: admissionId,
        test_name: 'Sputum culture and sensitivity',
        test_type: 'LAB',
        status: 'REQUESTED',
      });
      investigationId = investigation.id;

      await assertCanonicalClinicalWrite({
        event: { eventType: 'investigation.ordered', sourceTable: 'investigations' },
        sourceId: investigationId,
        patientUid: PATIENT_UID,
      });
      await projectLatestInpatientEvent(
        admissionId,
        'admission.diagnostic_resource_linked',
        admissionId,
      );

      const references = await prisma.$queryRawUnsafe(
        `SELECT reference.id,
                reference.pathway_instance_id,
                reference.patient_uid,
                reference.resource_type,
                reference.resource_id,
                reference.relationship_kind,
                reference.evidence_state,
                reference.canonical_timeline_event_id,
                reference.canonical_audit_event_id
           FROM care_pathway_resource_references AS reference
          WHERE reference.tenant_id = $1::uuid
            AND reference.pathway_instance_id = $2::uuid
            AND reference.patient_uid = $3::uuid
            AND reference.resource_type = 'investigation'
            AND reference.resource_id = $4::text
            AND reference.relationship_kind = 'child_action'
            AND reference.evidence_state <> 'superseded'
            AND NOT EXISTS (
              SELECT 1
                FROM care_pathway_resource_references AS successor
               WHERE successor.tenant_id = reference.tenant_id
                 AND successor.superseded_reference_id = reference.id
            )`,
        DEFAULT_TENANT,
        pathwayInstanceId,
        PATIENT_UID,
        String(investigationId),
      );
      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({
        pathway_instance_id: pathwayInstanceId,
        patient_uid: PATIENT_UID,
        resource_type: 'investigation',
        resource_id: String(investigationId),
        relationship_kind: 'child_action',
        evidence_state: 'open',
      });
      expect(references[0].canonical_timeline_event_id).toBeTruthy();
      expect(references[0].canonical_audit_event_id).toBeTruthy();
      resourceReferenceId = references[0].id;

      const pending = await doctor.get(`/api/v1/emr/${admissionId}/pending-results`);
      expect(pending.statusCode).toBe(200);
      expect(pending.body.data).toMatchObject({
        mode: 'active',
        primary_physician_assignment: {
          physician_uid: DOCTOR_UID,
        },
        pending_results: {
          projection_ready: true,
          pathway_instance_id: pathwayInstanceId,
          references_found: 1,
          references_expected: 1,
          missing_reference_count: 0,
          unresolved_reference_count: 0,
        },
      });
      expect(pending.body.data.pending_results.items).toEqual([
        expect.objectContaining({
          resource_reference_id: resourceReferenceId,
          source_type: 'investigation',
          source_id: String(investigationId),
          current_status: 'REQUESTED',
          exact_lineage: true,
          blocking: true,
          blocker_codes: expect.arrayContaining(['PENDING_RESULT_HANDOFF_MISSING']),
          primary_physician: expect.objectContaining({ uid: DOCTOR_UID }),
        }),
      ]);
    });
  });

  describe('Step 7 — discharge planning opens without changing LAMA/death semantics', () => {
    it.each(['lama', 'expired'])(
      'keeps %s outside the planned-discharge readiness gate',
      async (dischargeType) => {
        const res = await doctor.get(
          `/api/v1/emr/${admissionId}/discharge-readiness?discharge_type=${dischargeType}`,
        );
        expect(res.statusCode).toBe(200);
        const readiness = rulesReadiness(res);
        expect(readiness).toMatchObject({
          admission_id: admissionId,
          discharge_type: dischargeType,
          admission_status: 'admitted',
          gated: false,
          transition_allowed: true,
          ready: true,
          blockers: [],
        });
      },
    );

    it('marks the admission for discharge and exposes the active evidence blockers', async () => {
      const marked = await doctor
        .post(`/api/v1/emr/${admissionId}/mark-for-discharge`)
        .send({});
      expect(marked.statusCode).toBe(201);
      expect(marked.body.data?.admission?.id).toBe(admissionId);
      expect(marked.body.data?.consults).toHaveLength(5);
      expect(marked.body.data.consults.map((row) => row.consult_type).sort()).toEqual([
        'billing',
        'dietary',
        'family_counselling',
        'pharmacy',
        'physiotherapy',
      ]);
      await projectLatestInpatientEvent(admissionId, 'discharge.workflow_opened');

      const res = await doctor.get(
        `/api/v1/emr/${admissionId}/discharge-readiness?discharge_type=home`,
      );
      expect(res.statusCode).toBe(200);
      const readiness = rulesReadiness(res);
      expect(readiness).toMatchObject({
        admission_id: admissionId,
        discharge_type: 'home',
        gated: true,
        ready: false,
        pathway_mode: 'active',
      });
      const blockerTypes = readiness.blockers.map((blocker) => blocker.type);
      expect(blockerTypes).toEqual(expect.arrayContaining([
        'DRUGS_NOT_DISPENSED',
        'DISCHARGE_CONSULTS_PENDING',
        'NO_INVOICE',
        'STRUCTURED_SUMMARY_NOT_SIGNED',
        'FORMAL_DISCHARGE_MEDICATION_RECONCILIATION_REQUIRED',
        'ADMISSION_FOLLOW_UP_OR_EXCEPTION_REQUIRED',
        'PENDING_RESULT_HANDOFF_INCOMPLETE',
      ]));
    });
  });

  describe('Step 8 — accountable discharge evidence is recorded', () => {
    it('records the exact named-physician handoff for the pending investigation', async () => {
      const res = await doctor
        .post(`/api/v1/emr/${admissionId}/pending-result-handoffs`)
        .send({
          resource_reference_id: resourceReferenceId,
          source_type: 'investigation',
          source_id: String(investigationId),
          patient_safe_label: PENDING_RESULT_LABEL,
          idempotency_key: `journey-pending-result-${RUN}`,
        });
      expect(res.statusCode).toBe(201);
      const handoff = res.body.data?.handoff;
      expect(handoff).toMatchObject({
        admission_id: admissionId,
        resource_reference_id: resourceReferenceId,
        source_type: 'investigation',
        source_id: String(investigationId),
        patient_safe_label: PENDING_RESULT_LABEL,
        named_physician_uid: DOCTOR_UID,
        handoff_state: 'pending',
        discharge_summary_id: null,
      });
      expect(handoff.task_id).toBeTruthy();
      pendingResultHandoffId = handoff.id;
      pendingResultTrackingTaskId = Number(handoff.task_id);
      await projectLatestInpatientEvent(
        admissionId,
        'discharge.pending_result_handoff_recorded',
        pendingResultHandoffId,
      );

      const evidence = await prisma.$queryRawUnsafe(
        `SELECT handoff.id,
                handoff.admission_id,
                handoff.patient_uid,
                handoff.resource_reference_id,
                handoff.primary_physician_assignment_id,
                handoff.named_physician_uid,
                handoff.task_id,
                task.assigned_to_uid,
                task.related_resource_type,
                task.related_resource_id,
                task.status
           FROM discharge_pending_result_handoffs AS handoff
           JOIN tasks AS task
             ON task.tenant_id = handoff.tenant_id
            AND task.id = handoff.task_id
          WHERE handoff.tenant_id = $1::uuid
            AND handoff.id = $2::uuid`,
        DEFAULT_TENANT,
        pendingResultHandoffId,
      );
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({
        id: pendingResultHandoffId,
        admission_id: admissionId,
        patient_uid: PATIENT_UID,
        resource_reference_id: resourceReferenceId,
        named_physician_uid: DOCTOR_UID,
        assigned_to_uid: DOCTOR_UID,
        related_resource_type: 'discharge_pending_result_handoff',
        related_resource_id: pendingResultHandoffId,
        status: 'open',
      });
    });

    it('completes formal discharge medication reconciliation with an empty JSON take-home list', async () => {
      const started = await doctor.post('/api/v1/med-rec/start').send({
        patient_uid: PATIENT_UID,
        admission_id: admissionId,
        rec_type: 'discharge',
        notes: 'No home or inpatient medicines require continuation.',
      });
      expect(started.statusCode).toBe(201);
      medicationReconciliationId = started.body.data?.reconciliation?.id;
      expect(medicationReconciliationId).toBeTruthy();
      expect(started.body.data.reconciliation).toMatchObject({
        patient_uid: PATIENT_UID,
        admission_id: admissionId,
        rec_type: 'discharge',
        status: 'in_progress',
        items: [],
      });

      const completed = await doctor
        .post(`/api/v1/med-rec/${medicationReconciliationId}/complete`)
        .send({});
      expect(completed.statusCode).toBe(200);
      expect(completed.body.data?.reconciliation).toMatchObject({
        id: medicationReconciliationId,
        patient_uid: PATIENT_UID,
        admission_id: admissionId,
        rec_type: 'discharge',
        status: 'completed',
        items: [],
        take_home_list: [],
      });
      await assertCanonicalClinicalWrite({
        event: {
          eventType: 'medrec.completed',
          sourceTable: 'medication_reconciliations',
        },
        sourceId: medicationReconciliationId,
        patientUid: PATIENT_UID,
      });

      const rows = await prisma.$queryRawUnsafe(
        `SELECT id,
                tenant_id,
                patient_uid,
                admission_id,
                rec_type,
                status,
                completed_by,
                completed_at,
                metadata -> 'take_home_list' AS take_home_list,
                jsonb_typeof(metadata -> 'take_home_list') AS take_home_list_type
           FROM medication_reconciliations
          WHERE id = $1::uuid`,
        medicationReconciliationId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: medicationReconciliationId,
        tenant_id: DEFAULT_TENANT,
        patient_uid: PATIENT_UID,
        admission_id: admissionId,
        rec_type: 'discharge',
        status: 'completed',
        completed_by: DOCTOR_UID,
        take_home_list: [],
        take_home_list_type: 'array',
      });
      expect(rows[0].completed_at).toBeTruthy();
    });

    it('records an admission-scoped audited follow-up exception', async () => {
      const reason = 'No separate appointment is needed; the named physician will review the pending result directly.';
      const res = await doctor
        .post(`/api/v1/emr/${admissionId}/follow-up-exception`)
        .send({
          reason,
          idempotency_key: `journey-follow-up-exception-${RUN}`,
        });
      expect(res.statusCode).toBe(201);
      const exception = res.body.data?.exception;
      expect(exception).toMatchObject({ admission_id: admissionId, reason });
      expect(exception.canonical_timeline_event_id).toBeTruthy();
      expect(exception.canonical_audit_event_id).toBeTruthy();

      const rows = await prisma.$queryRawUnsafe(
        `SELECT timeline.id AS timeline_id,
                timeline.event_type,
                timeline.source_table,
                timeline.source_id,
                timeline.payload ->> 'admission_id' AS timeline_admission_id,
                timeline.payload ->> 'reason' AS timeline_reason,
                audit.id AS audit_id,
                audit.action,
                audit.resource_table,
                audit.resource_id,
                audit.metadata ->> 'admission_id' AS audit_admission_id,
                audit.metadata ->> 'reason' AS audit_reason
           FROM clinical_timeline_events AS timeline
           JOIN clinical_audit_events AS audit
             ON audit.tenant_id = timeline.tenant_id
            AND audit.id = $3::uuid
          WHERE timeline.tenant_id = $1::uuid
            AND timeline.id = $2::uuid`,
        DEFAULT_TENANT,
        exception.canonical_timeline_event_id,
        exception.canonical_audit_event_id,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        timeline_id: exception.canonical_timeline_event_id,
        event_type: 'discharge.follow_up_exception_recorded',
        source_table: 'admissions',
        source_id: String(admissionId),
        timeline_admission_id: String(admissionId),
        timeline_reason: reason,
        audit_id: exception.canonical_audit_event_id,
        action: 'discharge.follow_up_exception_recorded',
        resource_table: 'admissions',
        resource_id: String(admissionId),
        audit_admission_id: String(admissionId),
        audit_reason: reason,
      });
    });
  });

  async function submitAndProjectInitialAbnormalGeneration() {
    const initialResult = await doctor
      .put(`/api/v1/investigations/${investigationId}/results`)
      .send({
        results: {
          culture: {
            name: 'Sputum culture',
            value: 'Methicillin-sensitive Staphylococcus aureus',
            abnormal_flag: 'A',
          },
        },
        interpretation: 'Abnormal growth requires a signed ordering-clinician disposition.',
      });
    expect(initialResult.statusCode).toBe(200);
    expect(initialResult.body.data?.investigation).toMatchObject({
      id: investigationId,
      patient_id: patientId,
      patient_uid: PATIENT_UID,
      admission_id: admissionId,
      status: 'COMPLETED',
      result_version: 1,
      diagnostic_classification: 'abnormal',
    });
    initialGenerationId = initialResult.body.data.investigation.diagnostic_generation_id;
    initialGenerationSnapshotSha256 = initialResult.body.data.investigation
      .diagnostic_generation_snapshot_sha256;
    expect(initialGenerationId).toBeTruthy();
    expect(initialGenerationSnapshotSha256).toMatch(/^[0-9a-f]{64}$/);

    await projectDiagnosticGeneration(initialGenerationId);
    const diagnosticTask = await diagnosticActionTask(initialGenerationId);
    initialDiagnosticTaskId = Number(diagnosticTask.id);
    expect(diagnosticTask).toMatchObject({
      status: 'open',
      assigned_to_uid: DOCTOR_UID,
      related_resource_type: 'care_pathway_instance',
      related_resource_id: diagnosticTask.pathway_instance_id,
      sla_completion_semantics: 'domain_evidence',
    });
    expect(initialDiagnosticTaskId).toBeGreaterThan(0);
    expect(diagnosticTask.workflow_sla_instance_id).toBeTruthy();

    await projectLatestInpatientEvent(
      admissionId,
      'admission.diagnostic_resource_linked',
      admissionId,
    );
    await projectLatestInpatientEvent(
      admissionId,
      'discharge.pending_result_available',
      pendingResultHandoffId,
    );

    const initialEvidence = await pendingResultOwnerActionEvidence(
      pendingResultHandoffId,
    );
    expect(initialEvidence).toHaveLength(1);
    expect(initialEvidence[0]).toMatchObject({
      handoff_id: pendingResultHandoffId,
      admission_id: admissionId,
      patient_uid: PATIENT_UID,
      generation_id: initialGenerationId,
      predecessor_generation_id: null,
      predecessor_owner_action_id: null,
      predecessor_resolution_action_id: null,
      rearm_source_action_id: null,
      owner_uid: COVERING_DOCTOR_UID,
      is_current: true,
      source_kind: 'shared_investigation',
      source_table: 'investigations',
      source_episode_type: 'investigation',
      source_episode_key: `investigation:${investigationId}`,
      investigation_id: investigationId,
      ordering_owner_uid: DOCTOR_UID,
      owner_source: 'named_orderer',
      signer_uid: DOCTOR_UID,
      signer_role: 'DOCTOR',
      classification: 'abnormal',
      item_count: 1,
      task_kind: 'review',
      parent_task_id: pendingResultTrackingTaskId,
      assigned_to_uid: COVERING_DOCTOR_UID,
      task_status: 'open',
      task_completed_at: null,
      parent_task_status: 'open',
      parent_task_completed_at: null,
      timeline_event_type: 'discharge.pending_result_available',
      timeline_event_status: 'result_available',
      timeline_generation_id: initialGenerationId,
    });
    initialOwnerActionId = initialEvidence[0].id;
    initialOwnerActionTaskId = Number(initialEvidence[0].task_id);
    expect(initialOwnerActionId).toBeTruthy();
    expect(initialOwnerActionTaskId).toBeGreaterThan(0);
    expect(Number(initialEvidence[0].source_version)).toBe(1);

    const generationRows = await prisma.$queryRawUnsafe(
      `SELECT id, snapshot_sha256, classification, source_version,
                ordering_owner_uid, predecessor_generation_id
           FROM diagnostic_result_generations
          WHERE tenant_id = $1::uuid
            AND id = $2::uuid
            AND patient_uid = $3::uuid
            AND admission_id = $4::integer`,
      DEFAULT_TENANT,
      initialGenerationId,
      PATIENT_UID,
      admissionId,
    );
    expect(generationRows).toEqual([expect.objectContaining({
      id: initialGenerationId,
      snapshot_sha256: initialGenerationSnapshotSha256,
      classification: 'abnormal',
      ordering_owner_uid: DOCTOR_UID,
      predecessor_generation_id: null,
    })]);
    expect(Number(generationRows[0].source_version)).toBe(1);
  }

  describe('Step 9 — the investigation remains genuinely pending before discharge', () => {
    it('preserves the exact named-owner handoff without inventing a result generation', async () => {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT investigation.status,
                handoff.handoff_state,
                handoff.result_status,
                handoff.named_physician_uid,
                tracking.status AS tracking_status,
                tracking.assigned_to_uid,
                COUNT(owner_action.id)::integer AS owner_action_count,
                COUNT(generation.id)::integer AS generation_count
           FROM investigations AS investigation
           JOIN discharge_pending_result_handoffs AS handoff
             ON handoff.tenant_id = investigation.tenant_id
            AND handoff.admission_id = investigation.admission_id
            AND handoff.patient_uid = investigation.patient_uid
            AND handoff.source_type = 'investigation'
            AND handoff.source_id = investigation.id::text
           JOIN tasks AS tracking
             ON tracking.tenant_id = handoff.tenant_id
            AND tracking.id = handoff.task_id
           LEFT JOIN discharge_pending_result_owner_actions AS owner_action
             ON owner_action.tenant_id = handoff.tenant_id
            AND owner_action.handoff_id = handoff.id
           LEFT JOIN diagnostic_result_generations AS generation
             ON generation.tenant_id = investigation.tenant_id
            AND generation.investigation_id = investigation.id
          WHERE investigation.tenant_id = $1::uuid
            AND investigation.id = $2::integer
            AND handoff.id = $3::uuid
          GROUP BY investigation.status, handoff.handoff_state, handoff.result_status,
                   handoff.named_physician_uid, tracking.status, tracking.assigned_to_uid`,
        DEFAULT_TENANT,
        investigationId,
        pendingResultHandoffId,
      );
      expect(rows).toEqual([expect.objectContaining({
        status: 'REQUESTED',
        handoff_state: 'pending',
        result_status: 'REQUESTED',
        named_physician_uid: DOCTOR_UID,
        tracking_status: 'open',
        assigned_to_uid: DOCTOR_UID,
        owner_action_count: 0,
        generation_count: 0,
      })]);
    });
  });

  describe('Step 10 — live wait-stage ownership transfer converges inpatient work', () => {
    it('accepts one transfer, updates the attending, and cancels a second request', async () => {
      const liveStep = await prisma.$queryRawUnsafe(
        `SELECT run.current_step_key, step.step_kind
           FROM care_pathway_instances AS pathway
           JOIN workflow_runs AS run
             ON run.tenant_id = pathway.tenant_id
            AND run.id = pathway.workflow_run_id
           JOIN workflow_steps AS step
             ON step.tenant_id = run.tenant_id
            AND step.workflow_run_id = run.id
            AND step.step_key = run.current_step_key
          WHERE pathway.tenant_id = $1::uuid
            AND pathway.id = $2::uuid
            AND pathway.patient_uid = $3::uuid`,
        DEFAULT_TENANT,
        pathwayInstanceId,
        PATIENT_UID,
      );
      expect(liveStep).toHaveLength(1);
      expect(liveStep[0].step_kind).toBe('wait');
      expect([
        'observe_accepted_admission',
        'observe_discharge_planning',
        'await_existing_readiness_work',
        'await_discharge_evidence',
        'observe_discharge',
        'await_post_discharge_contact',
      ]).toContain(liveStep[0].current_step_key);

      const firstRequestBody = {
        covering_clinician_uid: COVERING_DOCTOR_UID,
        reason: 'Cover discharge result follow-up while the ordering clinician is off service.',
      };
      const firstRequestKey = `journey-owner-transfer-request-${RUN}`;
      const requested = await doctor
        .post(`/api/v1/care-pathways/instances/${pathwayInstanceId}/owner-transfer-requests`)
        .set('Idempotency-Key', firstRequestKey)
        .send(firstRequestBody);
      expect(requested.statusCode).toBe(201);
      expect(requested.body.data).toMatchObject({
        replayed: false,
        instance: {
          id: pathwayInstanceId,
          owning_clinician_uid: DOCTOR_UID,
        },
        handoff: {
          sender_uid: DOCTOR_UID,
          intended_recipient_uid: COVERING_DOCTOR_UID,
          status: 'requested',
          sending_step_key: liveStep[0].current_step_key,
        },
        task: {
          task_kind: 'pathway_owner_transfer_review',
          status: 'open',
          assigned_to_uid: COVERING_DOCTOR_UID,
          metadata: {
            canonical_encounter_id: admissionEncounterId,
            care_pathway_instance_id: pathwayInstanceId,
          },
        },
      });
      firstTransferHandoffId = requested.body.data.handoff.id;
      firstTransferTaskId = Number(requested.body.data.task.id);
      expect(firstTransferHandoffId).toBeTruthy();
      expect(firstTransferTaskId).toBeGreaterThan(0);

      const requestReplay = await doctor
        .post(`/api/v1/care-pathways/instances/${pathwayInstanceId}/owner-transfer-requests`)
        .set('Idempotency-Key', firstRequestKey)
        .send(firstRequestBody);
      expect(requestReplay.statusCode).toBe(200);
      expect(requestReplay.body.data).toMatchObject({
        replayed: true,
        handoff: { id: firstTransferHandoffId, status: 'requested' },
        task: {
          id: firstTransferTaskId,
          status: 'open',
          metadata: {
            canonical_encounter_id: admissionEncounterId,
            care_pathway_instance_id: pathwayInstanceId,
          },
        },
      });

      const firstAcceptKey = `journey-owner-transfer-accept-${RUN}`;
      const accepted = await coveringDoctor
        .post(`/api/v1/care-pathways/handoffs/${firstTransferHandoffId}/accept`)
        .set('Idempotency-Key', firstAcceptKey)
        .send({});
      expect(accepted.statusCode).toBe(200);
      expect(accepted.body.data).toMatchObject({
        replayed: false,
        instance: {
          id: pathwayInstanceId,
          owning_clinician_uid: COVERING_DOCTOR_UID,
        },
        handoff: {
          id: firstTransferHandoffId,
          status: 'accepted',
          accepted_by_uid: COVERING_DOCTOR_UID,
        },
        task: {
          id: firstTransferTaskId,
          status: 'completed',
          metadata: {
            canonical_encounter_id: admissionEncounterId,
            care_pathway_instance_id: pathwayInstanceId,
          },
        },
      });
      expect(accepted.body.data.task.completed_at).toBeTruthy();

      const attending = await coveringDoctor
        .put(`/api/v1/emr/${admissionId}/attending-doctor`)
        .send({
          doctor_uid: COVERING_DOCTOR_UID,
          accepted_handoff_id: firstTransferHandoffId,
        });
      expect(attending.statusCode).toBe(200);
      expect(attending.body.data?.admission).toMatchObject({
        id: admissionId,
        attending_doctor: COVERING_DOCTOR_UID,
      });

      const converged = await prisma.$queryRawUnsafe(
        `SELECT admission.attending_doctor,
                pathway.owning_clinician_uid,
                handoff.named_physician_uid,
                handoff.primary_physician_assignment_id,
                tracking.assigned_to_uid AS tracking_assigned_to_uid,
                tracking.status AS tracking_status,
                assignment.assignment_version,
                assignment.physician_uid,
                assignment.assignment_source,
                assignment.accepted_handoff_id,
                assignment.canonical_timeline_event_id,
                assignment.canonical_audit_event_id,
                transfer.status AS transfer_status,
                transfer.accepted_by_uid,
                transfer_task.status AS transfer_task_status,
                transfer_task.completed_at AS transfer_task_completed_at
           FROM admissions AS admission
           JOIN care_pathway_instances AS pathway
             ON pathway.tenant_id = admission.tenant_id
            AND pathway.id = $4::uuid
           JOIN discharge_pending_result_handoffs AS handoff
             ON handoff.tenant_id = admission.tenant_id
            AND handoff.id = $5::uuid
           JOIN tasks AS tracking
              ON tracking.tenant_id = handoff.tenant_id
             AND tracking.id = handoff.task_id
           JOIN inpatient_primary_physician_assignments AS assignment
             ON assignment.tenant_id = handoff.tenant_id
            AND assignment.id = handoff.primary_physician_assignment_id
           JOIN care_handoff_instances AS transfer
              ON transfer.tenant_id = admission.tenant_id
             AND transfer.id = $6::uuid
           JOIN tasks AS transfer_task
             ON transfer_task.tenant_id = transfer.tenant_id
            AND transfer_task.id = transfer.task_id
          WHERE admission.tenant_id = $1::uuid
            AND admission.id = $2::integer
            AND admission.patient_uid = $3::uuid`,
        DEFAULT_TENANT,
        admissionId,
        PATIENT_UID,
        pathwayInstanceId,
        pendingResultHandoffId,
        firstTransferHandoffId,
      );
      expect(converged).toHaveLength(1);
      expect(converged[0]).toMatchObject({
        attending_doctor: COVERING_DOCTOR_UID,
        owning_clinician_uid: COVERING_DOCTOR_UID,
        named_physician_uid: COVERING_DOCTOR_UID,
        tracking_assigned_to_uid: COVERING_DOCTOR_UID,
        tracking_status: 'open',
        assignment_version: 2,
        physician_uid: COVERING_DOCTOR_UID,
        assignment_source: 'accepted_covering_handoff',
        accepted_handoff_id: firstTransferHandoffId,
        transfer_status: 'accepted',
        accepted_by_uid: COVERING_DOCTOR_UID,
        transfer_task_status: 'completed',
      });
      expect(converged[0].primary_physician_assignment_id).toBeTruthy();
      expect(converged[0].canonical_timeline_event_id).toBeTruthy();
      expect(converged[0].canonical_audit_event_id).toBeTruthy();
      expect(converged[0].transfer_task_completed_at).toBeTruthy();

      const secondRequest = await coveringDoctor
        .post(`/api/v1/care-pathways/instances/${pathwayInstanceId}/owner-transfer-requests`)
        .set('Idempotency-Key', `journey-terminal-transfer-request-${RUN}`)
        .send({
          covering_clinician_uid: DOCTOR_UID,
          reason: 'Prepare a possible return of coverage after discharge work is completed.',
        });
      expect(secondRequest.statusCode).toBe(201);
      expect(secondRequest.body.data).toMatchObject({
        replayed: false,
        instance: {
          id: pathwayInstanceId,
          owning_clinician_uid: COVERING_DOCTOR_UID,
        },
        handoff: {
          sender_uid: COVERING_DOCTOR_UID,
          intended_recipient_uid: DOCTOR_UID,
          status: 'requested',
        },
        task: {
          task_kind: 'pathway_owner_transfer_review',
          status: 'open',
          assigned_to_uid: DOCTOR_UID,
        },
      });
      secondTransferHandoffId = secondRequest.body.data.handoff.id;
      secondTransferTaskId = Number(secondRequest.body.data.task.id);
      expect(secondTransferHandoffId).toBeTruthy();
      expect(secondTransferTaskId).toBeGreaterThan(0);

      const cancelled = await coveringDoctor
        .post(`/api/v1/care-pathways/handoffs/${secondTransferHandoffId}/cancel`)
        .set('Idempotency-Key', `journey-terminal-transfer-cancel-${RUN}`)
        .send({
          reason: 'The covering clinician will retain ownership through result follow-up.',
        });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.body.data).toMatchObject({
        replayed: false,
        instance: {
          id: pathwayInstanceId,
          owning_clinician_uid: COVERING_DOCTOR_UID,
        },
        handoff: {
          id: secondTransferHandoffId,
          sender_uid: COVERING_DOCTOR_UID,
          intended_recipient_uid: DOCTOR_UID,
          status: 'cancelled',
        },
        task: {
          id: secondTransferTaskId,
          status: 'cancelled',
        },
      });
    });
  });

  describe('Step 11 — the structured signed summary closes pending-result disclosure', () => {
    it('signs a structured summary that names the pending result and its owner', async () => {
      const created = await coveringDoctor.post('/api/v1/discharge-summaries').send({
        admission_id: admissionId,
        patient_uid: PATIENT_UID,
        patient_name: `Inpatient ${RUN}`,
        age_years: 42,
        sex: 'male',
        primary_diagnosis: 'Community-acquired pneumonia',
        template_code: SUMMARY_TEMPLATE_CODE,
      });
      expect(created.statusCode).toBe(200);
      structuredSummaryId = created.body.data?.id;
      expect(structuredSummaryId).toBeTruthy();
      expect(created.body.data).toMatchObject({
        admission_id: admissionId,
        patient_uid: PATIENT_UID,
        status: 'draft',
      });

      const pendingResultBody = `${PENDING_RESULT_LABEL}: status REQUESTED. `
        + `Named owner Dr Covering ${RUN} (${COVERING_DOCTOR_UID}) will review and communicate the result after discharge.`;
      const updated = await coveringDoctor
        .patch(`/api/v1/discharge-summaries/${structuredSummaryId}/sections/pending_results`)
        .send({ body: pendingResultBody });
      expect(updated.statusCode).toBe(200);
      expect(updated.body.data?.sections).toEqual(expect.arrayContaining([
        expect.objectContaining({
          section_key: 'pending_results',
          body: pendingResultBody,
        }),
      ]));

      for (const closureSection of DISCHARGE_CLOSURE_SECTIONS) {
        const closureUpdated = await coveringDoctor
          .patch(
            `/api/v1/discharge-summaries/${structuredSummaryId}/sections/`
            + closureSection.section_key,
          )
          .send({ body: closureSection.body });
        expect(closureUpdated.statusCode).toBe(200);
        expect(closureUpdated.body.data?.sections).toEqual(expect.arrayContaining([
          expect.objectContaining({
            section_key: closureSection.section_key,
            body: closureSection.body,
          }),
        ]));
      }

      const ready = await coveringDoctor
        .post(`/api/v1/discharge-summaries/${structuredSummaryId}/ready`)
        .send({});
      expect(ready.statusCode).toBe(200);
      expect(ready.body.data?.status).toBe('ready_for_signoff');

      const signed = await coveringDoctor
        .post(`/api/v1/discharge-summaries/${structuredSummaryId}/sign`)
        .send({
          signed_by_name: `Dr Covering ${RUN}`,
          signed_by_reg: `JREG-${RUN}`,
        });
      expect(signed.statusCode).toBe(200);
      expect(signed.body.data).toMatchObject({
        id: structuredSummaryId,
        admission_id: admissionId,
        patient_uid: PATIENT_UID,
        status: 'signed',
        signed_by: COVERING_DOCTOR_UID,
        signed_by_name: `Dr Covering ${RUN}`,
        signed_by_reg: `JREG-${RUN}`,
      });
      expect(signed.body.data.signed_at).toBeTruthy();
      await assertCanonicalClinicalWrite({
        event: {
          eventType: 'discharge_summary.signed',
          sourceTable: 'discharge_summaries',
        },
        sourceId: structuredSummaryId,
        patientUid: PATIENT_UID,
      });
      await projectLatestInpatientEvent(
        admissionId,
        'clinical_document.discharge_summary.signed',
        structuredSummaryId,
      );

      const included = await coveringDoctor
        .put(
          `/api/v1/emr/${admissionId}/pending-result-handoffs/`
          + `${pendingResultHandoffId}/summary-inclusion`,
        )
        .send({ discharge_summary_id: structuredSummaryId });
      expect(included.statusCode).toBe(200);
      expect(included.body.data?.handoff).toMatchObject({
        id: pendingResultHandoffId,
        admission_id: admissionId,
        discharge_summary_id: structuredSummaryId,
      });
      expect(included.body.data.handoff.summary_included_at).toBeTruthy();

      const rows = await prisma.$queryRawUnsafe(
        `SELECT handoff.discharge_summary_id,
                handoff.summary_included_at,
                handoff.summary_inclusion_timeline_event_id,
                section.body AS pending_result_body
           FROM discharge_pending_result_handoffs AS handoff
           JOIN discharge_summary_sections AS section
             ON section.discharge_summary_id = handoff.discharge_summary_id
            AND section.section_key = 'pending_results'
          WHERE handoff.tenant_id = $1::uuid
            AND handoff.id = $2::uuid`,
        DEFAULT_TENANT,
        pendingResultHandoffId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        discharge_summary_id: structuredSummaryId,
        pending_result_body: pendingResultBody,
      });
      expect(rows[0].summary_included_at).toBeTruthy();
      expect(rows[0].summary_inclusion_timeline_event_id).toBeTruthy();

      const pending = await coveringDoctor.get(`/api/v1/emr/${admissionId}/pending-results`);
      expect(pending.statusCode).toBe(200);
      const item = pending.body.data?.pending_results?.items?.[0];
      expect(item).toMatchObject({
        resource_reference_id: resourceReferenceId,
        source_type: 'investigation',
        source_id: String(investigationId),
        named_owner: expect.objectContaining({ uid: COVERING_DOCTOR_UID }),
        handoff: expect.objectContaining({
          id: pendingResultHandoffId,
          named_physician_uid: COVERING_DOCTOR_UID,
          summary_id: structuredSummaryId,
        }),
        handoff_complete_warning: true,
        handoff_complete: true,
        summary_included: true,
        blocking: false,
        blocker_codes: [],
      });
      expect(pending.body.data.active_blockers).toEqual([]);
    });
  });

  describe('Step 12 — planned home discharge clears every gate', () => {
    it('finishes the existing cascade and discharges the patient to bed recovery', async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO billing_invoices
           (tenant_id, invoice_number, patient_uid, admission_id, doctor_uid,
            department, invoice_type, subtotal, total_amount, amount_paid,
            amount_due, status, created_by, issued_at, updated_at)
         VALUES
           ($1::uuid, $2::text, $3::uuid, $4::integer, $5::uuid,
            $6::text, 'IP', 0, 0, 0, 0, 'PAID', $7::uuid, NOW(), NOW())`,
        DEFAULT_TENANT,
        `JIPD-${RUN}`,
        PATIENT_UID,
        admissionId,
        COVERING_DOCTOR_UID,
        DEPARTMENT,
        ADMIN_UID,
      );

      const drugs = await admin
        .post(`/api/v1/emr/${admissionId}/mark-drugs-dispensed`)
        .send({});
      expect(drugs.statusCode).toBe(200);
      expect(drugs.body.data?.admission?.id).toBe(admissionId);
      const drugEvidence = await prisma.$queryRawUnsafe(
        `SELECT discharge_drugs_dispensed_at
           FROM admissions
          WHERE tenant_id = $1::uuid
            AND id = $2::integer
            AND patient_uid = $3::uuid`,
        DEFAULT_TENANT,
        admissionId,
        PATIENT_UID,
      );
      expect(drugEvidence[0]?.discharge_drugs_dispensed_at).toBeTruthy();
      await projectLatestInpatientEvent(admissionId, 'discharge.drugs_dispensed');

      for (const consultType of [
        'dietary',
        'family_counselling',
        'pharmacy',
        'physiotherapy',
        'billing',
      ]) {
        const completed = await admin
          .post(`/api/v1/emr/${admissionId}/consults/${consultType}/complete`)
          .send({ notes: `${consultType} discharge evidence completed in journey ${RUN}` });
        expect(completed.statusCode).toBe(200);
        const consult = completed.body.data?.consult;
        expect(consult).toMatchObject({
          admission_id: admissionId,
          patient_uid: PATIENT_UID,
          consult_type: consultType,
          completed_by: ADMIN_UID,
        });
        expect(consult.completed_at).toBeTruthy();
        await projectLatestInpatientEvent(
          admissionId,
          'discharge.work_item_completed',
          consult.id,
        );
      }

      const readinessRes = await coveringDoctor.get(
        `/api/v1/emr/${admissionId}/discharge-readiness?discharge_type=home`,
      );
      expect(readinessRes.statusCode).toBe(200);
      const readiness = rulesReadiness(readinessRes);
      expect(readiness).toMatchObject({
        admission_id: admissionId,
        discharge_type: 'home',
        admission_status: 'admitted',
        gated: true,
        transition_allowed: true,
        ready: true,
        blocker_count: 0,
        blockers: [],
        pathway_mode: 'active',
        checklist: {
          marked_for_discharge: true,
          discharge_summary_signed: true,
          discharge_work_items_completed: true,
          discharge_drugs_dispensed: true,
          finalized_invoice_exists: true,
          invoice_balance_clear: true,
          structured_summary_signed: true,
          patient_guardian_instructions_recorded: true,
          escalation_contact_recorded: true,
          equipment_home_care_plan_recorded: true,
          discharge_destination_recorded: true,
          transport_plan_recorded: true,
          formal_medication_reconciliation_completed: true,
          admission_follow_up_or_exception: true,
          pending_result_projection_ready: true,
          pending_result_handoffs_complete: true,
        },
      });

      // The normal home-readiness contract is completely green at this point.
      // Fault-inject one persisted blank at a time so each real final-discharge
      // attempt proves the exact legacy/corrupt signed-section blocker alone.
      for (const closureSection of DISCHARGE_CLOSURE_SECTIONS) {
        await setTenantTx(DEFAULT_TENANT, async (tx) => {
          const changed = await tx.$executeRawUnsafe(
            `UPDATE discharge_summary_sections
                SET body = NULL
              WHERE discharge_summary_id = $1::integer
                AND section_key = $2::text`,
            structuredSummaryId,
            closureSection.section_key,
          );
          expect(changed).toBe(1);
        });
        try {
          const blocked = await admin
            .post(`/api/v1/emr/${admissionId}/discharge`)
            .send({
              discharge_type: 'home',
              discharge_summary: `Fault-injection probe for ${closureSection.section_key}`,
            });
          expect(blocked.statusCode).toBe(400);
          expect(blocked.body.code || blocked.body.details?.code || '').toBe(
            'DISCHARGE_NOT_READY',
          );
          expect(
            (blocked.body.details?.blockers || []).map((blocker) => blocker.type),
          ).toEqual([closureSection.blocker]);

          const admission = await prisma.$queryRawUnsafe(
            `SELECT status, discharged_at
               FROM admissions
              WHERE tenant_id = $1::uuid
                AND id = $2::integer
                AND patient_uid = $3::uuid`,
            DEFAULT_TENANT,
            admissionId,
            PATIENT_UID,
          );
          expect(admission).toEqual([{
            status: 'admitted',
            discharged_at: null,
          }]);
        } finally {
          await setTenantTx(DEFAULT_TENANT, async (tx) => {
            const restored = await tx.$executeRawUnsafe(
              `UPDATE discharge_summary_sections
                  SET body = $3::text
                WHERE discharge_summary_id = $1::integer
                  AND section_key = $2::text`,
              structuredSummaryId,
              closureSection.section_key,
              closureSection.body,
            );
            expect(restored).toBe(1);
          });
        }
      }

      const deferredExternalTransfer = await admin
        .post(`/api/v1/emr/${admissionId}/discharge`)
        .send({
          discharge_type: 'transfer',
          discharge_summary: 'External-facility transfer branch must remain governed and deferred.',
        });
      expect(deferredExternalTransfer.statusCode).toBe(400);
      expect(
        deferredExternalTransfer.body.code
        || deferredExternalTransfer.body.details?.code
        || '',
      ).toBe('DISCHARGE_NOT_READY');
      expect(
        (deferredExternalTransfer.body.details?.blockers || [])
          .map((blocker) => blocker.type),
      ).toContain('EXTERNAL_TRANSFER_BRANCH_DEFERRED');

      const admissionAfterDeferredTransfer = await prisma.$queryRawUnsafe(
        `SELECT status, discharged_at
           FROM admissions
          WHERE tenant_id = $1::uuid
            AND id = $2::integer`,
        DEFAULT_TENANT,
        admissionId,
      );
      expect(admissionAfterDeferredTransfer).toEqual([{
        status: 'admitted',
        discharged_at: null,
      }]);

      const discharged = await admin
        .post(`/api/v1/emr/${admissionId}/discharge`)
        .send({
          discharge_type: 'home',
          discharge_summary: 'Structured signed summary; pending result ownership and follow-up exception recorded.',
        });
      expect(discharged.statusCode).toBe(200);
      expect(discharged.body.data?.admission).toMatchObject({
        id: admissionId,
        patient_uid: PATIENT_UID,
        status: 'discharged',
      });
      expect(discharged.body.data.admission.discharged_at).toBeTruthy();

      const beds = await prisma.$queryRawUnsafe(
        `SELECT status, patient_uid, admission_id
           FROM beds
          WHERE id = $1::integer`,
        bedAId,
      );
      expect(beds).toHaveLength(1);
      expect(String(beds[0].status).toLowerCase()).toBe('cleaning');
      expect(beds[0].patient_uid).toBeNull();
      expect(beds[0].admission_id).toBeNull();

      await projectLatestInpatientEvent(admissionId, 'discharge.completed');
    });
  });

  describe('Step 13 — terminal owner-transfer work is replayable but cannot advance', () => {
    it('replays historical requests and acceptances before rejecting new terminal mutations', async () => {
      const before = await ownerTransferStateSnapshot({
        admissionId,
        pathwayInstanceId,
        pendingResultHandoffId,
      });

      const requestReplay = await coveringDoctor
        .post(`/api/v1/care-pathways/instances/${pathwayInstanceId}/owner-transfer-requests`)
        .set('Idempotency-Key', `journey-terminal-transfer-request-${RUN}`)
        .send({
          covering_clinician_uid: DOCTOR_UID,
          reason: 'Prepare a possible return of coverage after discharge work is completed.',
        });
      expect(requestReplay.statusCode).toBe(200);
      expect(requestReplay.body.data).toMatchObject({
        replayed: true,
        instance: {
          id: pathwayInstanceId,
          owning_clinician_uid: COVERING_DOCTOR_UID,
        },
        handoff: {
          id: secondTransferHandoffId,
          status: 'cancelled',
        },
        task: {
          id: secondTransferTaskId,
          status: 'cancelled',
        },
      });

      const cancellationReplay = await coveringDoctor
        .post(`/api/v1/care-pathways/handoffs/${secondTransferHandoffId}/cancel`)
        .set('Idempotency-Key', `journey-terminal-transfer-cancel-${RUN}`)
        .send({
          reason: 'The covering clinician will retain ownership through result follow-up.',
        });
      expect(cancellationReplay.statusCode).toBe(200);
      expect(cancellationReplay.body.data).toMatchObject({
        replayed: true,
        instance: {
          id: pathwayInstanceId,
          owning_clinician_uid: COVERING_DOCTOR_UID,
        },
        handoff: {
          id: secondTransferHandoffId,
          status: 'cancelled',
        },
        task: {
          id: secondTransferTaskId,
          status: 'cancelled',
        },
      });

      const acceptanceReplay = await coveringDoctor
        .post(`/api/v1/care-pathways/handoffs/${firstTransferHandoffId}/accept`)
        .set('Idempotency-Key', `journey-owner-transfer-accept-${RUN}`)
        .send({});
      expect(acceptanceReplay.statusCode).toBe(200);
      expect(acceptanceReplay.body.data).toMatchObject({
        replayed: true,
        instance: {
          id: pathwayInstanceId,
          owning_clinician_uid: COVERING_DOCTOR_UID,
        },
        handoff: {
          id: firstTransferHandoffId,
          status: 'accepted',
          accepted_by_uid: COVERING_DOCTOR_UID,
        },
        task: {
          id: firstTransferTaskId,
          status: 'completed',
        },
      });
      expect(acceptanceReplay.body.data.task.completed_at).toBeTruthy();

      const newRequest = await coveringDoctor
        .post(`/api/v1/care-pathways/instances/${pathwayInstanceId}/owner-transfer-requests`)
        .set('Idempotency-Key', `journey-terminal-transfer-new-${RUN}`)
        .send({
          covering_clinician_uid: DOCTOR_UID,
          reason: 'This brand-new transfer must fail after discharge.',
        });
      expect(newRequest.statusCode).toBe(409);
      expect(newRequest.body.code).toBe(
        'INPATIENT_POST_DISCHARGE_OWNER_TRANSFER_UNSUPPORTED',
      );

      const newAcceptance = await doctor
        .post(`/api/v1/care-pathways/handoffs/${secondTransferHandoffId}/accept`)
        .set('Idempotency-Key', `journey-terminal-transfer-accept-new-${RUN}`)
        .send({});
      expect(newAcceptance.statusCode).toBe(409);
      expect(newAcceptance.body.code).toBe(
        'INPATIENT_POST_DISCHARGE_OWNER_TRANSFER_UNSUPPORTED',
      );

      const after = await ownerTransferStateSnapshot({
        admissionId,
        pathwayInstanceId,
        pendingResultHandoffId,
      });
      expect(after).toEqual(before);
    });
  });

  describe('Step 14 — different-owner disposition requires named-owner cross-sign', () => {
    it('keeps the handoff live after ordering-owner disposition, then settles both tasks', async () => {
      await submitAndProjectInitialAbnormalGeneration();

      initialDisposition = await recordDoctorDiagnosticDisposition({
        tenantId: DEFAULT_TENANT,
        generationId: initialGenerationId,
        taskId: initialDiagnosticTaskId,
        disposition: 'no_action',
        clinicalNote: 'Reviewed the complete abnormal sputum generation after discharge.',
        reason: 'The patient is clinically improving and no treatment change is indicated.',
        generationSnapshotSha256: initialGenerationSnapshotSha256,
        idempotencyKey: `journey-initial-doctor-disposition-${RUN}`,
        attested: true,
        activationEvidenceCapability: activationCapability,
      }, {
        actorUid: DOCTOR_UID,
        actorName: `Dr Ward ${RUN}`,
        actorRole: 'DOCTOR',
        actorRoles: ['DOCTOR'],
      });
      expect(initialDisposition).toMatchObject({
        generation_id: initialGenerationId,
        task_id: initialDiagnosticTaskId,
        action_kind: 'doctor_disposition',
        disposition: 'no_action',
        replayed: false,
        pathway: {
          clinical_status: 'completed',
          replayed: false,
        },
      });
      expect(initialDisposition.id).toBeTruthy();
      expect(initialDisposition.signature_id).toBeTruthy();
      expect(initialDisposition.request_sha256).toMatch(/^[0-9a-f]{64}$/);

      const afterDisposition = await prisma.$queryRawUnsafe(
        `SELECT handoff.handoff_state,
                handoff.result_status,
                handoff.resolution_action_id,
                handoff.resolved_at,
                handoff.resolved_by_uid,
                action.action_kind,
                action.actor_uid,
                action.signature_id,
                action.generation_snapshot_sha256,
                child.status AS child_status,
                child.completed_at AS child_completed_at,
                parent.status AS parent_status,
                parent.completed_at AS parent_completed_at
           FROM discharge_pending_result_handoffs AS handoff
           JOIN discharge_pending_result_owner_actions AS owner_action
             ON owner_action.tenant_id = handoff.tenant_id
            AND owner_action.id = $5::uuid
           JOIN tasks AS child
             ON child.tenant_id = owner_action.tenant_id
            AND child.id = owner_action.task_id
           JOIN tasks AS parent
             ON parent.tenant_id = child.tenant_id
            AND parent.id = child.parent_task_id
           JOIN diagnostic_result_actions AS action
             ON action.tenant_id = handoff.tenant_id
            AND action.id = $6::uuid
          WHERE handoff.tenant_id = $1::uuid
            AND handoff.id = $2::uuid
            AND handoff.admission_id = $3::integer
            AND handoff.patient_uid = $4::uuid`,
        DEFAULT_TENANT,
        pendingResultHandoffId,
        admissionId,
        PATIENT_UID,
        initialOwnerActionId,
        initialDisposition.id,
      );
      expect(afterDisposition).toEqual([expect.objectContaining({
        handoff_state: 'result_available',
        result_status: 'available',
        resolution_action_id: null,
        resolved_at: null,
        resolved_by_uid: null,
        action_kind: 'doctor_disposition',
        actor_uid: DOCTOR_UID,
        signature_id: initialDisposition.signature_id,
        generation_snapshot_sha256: initialGenerationSnapshotSha256,
        child_status: 'open',
        child_completed_at: null,
        parent_status: 'open',
        parent_completed_at: null,
      })]);

      initialCrossSignRequest = {
        generation_id: initialGenerationId,
        diagnostic_action_id: initialDisposition.id,
        generation_snapshot_sha256: initialGenerationSnapshotSha256,
        attested: true,
      };
      const crossSigned = await coveringDoctor
        .post(
          `/api/v1/emr/${admissionId}/pending-result-handoffs/`
          + `${pendingResultHandoffId}/cross-sign`,
        )
        .set('Idempotency-Key', `journey-initial-cross-sign-${RUN}`)
        .send(initialCrossSignRequest);
      expect(crossSigned.statusCode).toBe(200);
      initialCrossSignResolution = crossSigned.body.data?.resolution;
      expect(initialCrossSignResolution).toMatchObject({
        admission_id: admissionId,
        handoff_id: pendingResultHandoffId,
        generation_id: initialGenerationId,
        diagnostic_action_id: initialDisposition.id,
        pathway_instance_id: pathwayInstanceId,
        owner_action_id: initialOwnerActionId,
        action_task_id: initialOwnerActionTaskId,
        tracking_task_id: pendingResultTrackingTaskId,
        handoff_state: 'resolved',
        current_handoff_state: 'resolved',
        generation_snapshot_sha256: initialGenerationSnapshotSha256,
        replayed: false,
      });
      expect(initialCrossSignResolution.id).toBeTruthy();
      expect(initialCrossSignResolution.resolution_action_id).toBe(
        initialCrossSignResolution.id,
      );
      expect(initialCrossSignResolution.signature_id).toBeTruthy();
      expect(initialCrossSignResolution.request_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(initialCrossSignResolution.canonical_timeline_event_id).toBeTruthy();
      expect(initialCrossSignResolution.canonical_audit_event_id).toBeTruthy();

      const settled = await prisma.$queryRawUnsafe(
        `SELECT handoff.handoff_state,
                handoff.result_status,
                handoff.resolution_action_id,
                handoff.resolved_by_uid,
                resolution.action_kind,
                resolution.predecessor_action_id,
                resolution.actor_uid,
                resolution.signature_id,
                child.status AS child_status,
                child.completed_at AS child_completed_at,
                parent.status AS parent_status,
                parent.completed_at AS parent_completed_at
           FROM discharge_pending_result_handoffs AS handoff
           JOIN diagnostic_result_actions AS resolution
             ON resolution.tenant_id = handoff.tenant_id
            AND resolution.id = handoff.resolution_action_id
           JOIN discharge_pending_result_owner_actions AS owner_action
             ON owner_action.tenant_id = handoff.tenant_id
            AND owner_action.id = $5::uuid
           JOIN tasks AS child
             ON child.tenant_id = owner_action.tenant_id
            AND child.id = owner_action.task_id
           JOIN tasks AS parent
             ON parent.tenant_id = child.tenant_id
            AND parent.id = child.parent_task_id
          WHERE handoff.tenant_id = $1::uuid
            AND handoff.id = $2::uuid
            AND handoff.admission_id = $3::integer
            AND handoff.patient_uid = $4::uuid`,
        DEFAULT_TENANT,
        pendingResultHandoffId,
        admissionId,
        PATIENT_UID,
        initialOwnerActionId,
      );
      expect(settled).toEqual([expect.objectContaining({
        handoff_state: 'resolved',
        result_status: 'reviewed',
        resolution_action_id: initialCrossSignResolution.id,
        resolved_by_uid: COVERING_DOCTOR_UID,
        action_kind: 'discharge_owner_cross_sign',
        predecessor_action_id: initialDisposition.id,
        actor_uid: COVERING_DOCTOR_UID,
        signature_id: initialCrossSignResolution.signature_id,
        child_status: 'completed',
        parent_status: 'completed',
      })]);
      expect(settled[0].child_completed_at).toBeTruthy();
      expect(settled[0].parent_completed_at).toBeTruthy();
    });

    it('replays the exact named-owner cross-sign without duplicating settlement', async () => {
      const before = await pendingResultOwnerActionEvidence(pendingResultHandoffId);
      const replay = await coveringDoctor
        .post(
          `/api/v1/emr/${admissionId}/pending-result-handoffs/`
          + `${pendingResultHandoffId}/cross-sign`,
        )
        .set('Idempotency-Key', `journey-initial-cross-sign-${RUN}`)
        .send(initialCrossSignRequest);
      expect(replay.statusCode).toBe(200);
      expect(replay.body.data?.resolution).toMatchObject({
        id: initialCrossSignResolution.id,
        resolution_action_id: initialCrossSignResolution.id,
        admission_id: admissionId,
        handoff_id: pendingResultHandoffId,
        generation_id: initialGenerationId,
        diagnostic_action_id: initialDisposition.id,
        owner_action_id: initialOwnerActionId,
        action_task_id: initialOwnerActionTaskId,
        tracking_task_id: pendingResultTrackingTaskId,
        handoff_state: 'resolved',
        current_handoff_state: 'resolved',
        request_sha256: initialCrossSignResolution.request_sha256,
        replayed: true,
      });
      expect(await pendingResultOwnerActionEvidence(pendingResultHandoffId)).toEqual(before);
    });
  });

  describe('Step 15 — corrected and same-generation work rearm append-only tasks', () => {
    it('rearms a corrected successor without mutating its completed predecessor', async () => {
      const settledInitialEvidence = await pendingResultOwnerActionEvidence(
        pendingResultHandoffId,
      );
      expect(settledInitialEvidence).toHaveLength(1);
      expect(settledInitialEvidence[0]).toMatchObject({
        id: initialOwnerActionId,
        generation_id: initialGenerationId,
        predecessor_generation_id: null,
        predecessor_owner_action_id: null,
        predecessor_resolution_action_id: null,
        rearm_source_action_id: null,
        owner_uid: COVERING_DOCTOR_UID,
        task_id: initialOwnerActionTaskId,
        assigned_to_uid: COVERING_DOCTOR_UID,
        task_status: 'completed',
        parent_task_id: pendingResultTrackingTaskId,
        parent_task_status: 'completed',
        is_current: true,
      });
      expect(settledInitialEvidence[0].task_completed_at).toBeTruthy();
      expect(settledInitialEvidence[0].parent_task_completed_at).toBeTruthy();

      const correctedResult = await doctor
        .put(`/api/v1/investigations/${investigationId}/results`)
        .send({
          results: {
            culture: {
              name: 'Sputum culture',
              value: 'Normal respiratory flora',
              abnormal_flag: 'N',
            },
          },
          interpretation: 'Corrected report: normal respiratory flora only.',
          re_run: true,
          re_run_reason: 'Corrected organism wording after verifier review',
        });
      expect(correctedResult.statusCode).toBe(200);
      expect(correctedResult.body.data?.investigation).toMatchObject({
        id: investigationId,
        patient_id: patientId,
        patient_uid: PATIENT_UID,
        admission_id: admissionId,
        status: 'COMPLETED',
        result_version: 2,
        diagnostic_classification: 'normal',
      });
      correctedGenerationId = correctedResult.body.data.investigation
        .diagnostic_generation_id;
      expect(correctedGenerationId).toBeTruthy();
      expect(correctedGenerationId).not.toBe(initialGenerationId);

      await projectLatestInpatientEvent(
        admissionId,
        'admission.diagnostic_resource_linked',
        admissionId,
      );
      await projectLatestInpatientEvent(
        admissionId,
        'discharge.pending_result_available',
        pendingResultHandoffId,
      );

      const correctedEvidence = await pendingResultOwnerActionEvidence(
        pendingResultHandoffId,
      );
      expect(correctedEvidence).toHaveLength(2);
      expect(correctedEvidence[0]).toMatchObject({
        id: initialOwnerActionId,
        generation_id: initialGenerationId,
        predecessor_generation_id: null,
        predecessor_owner_action_id: null,
        predecessor_resolution_action_id: null,
        rearm_source_action_id: null,
        is_current: false,
        task_id: initialOwnerActionTaskId,
        owner_uid: COVERING_DOCTOR_UID,
        assigned_to_uid: COVERING_DOCTOR_UID,
        task_status: 'completed',
        parent_task_id: pendingResultTrackingTaskId,
        parent_task_status: 'completed',
      });
      expect(correctedEvidence[0].task_completed_at).toEqual(
        settledInitialEvidence[0].task_completed_at,
      );
      expect(correctedEvidence[0].parent_task_completed_at).toEqual(
        settledInitialEvidence[0].parent_task_completed_at,
      );
      expect(correctedEvidence[0].canonical_timeline_event_id).toBe(
        settledInitialEvidence[0].canonical_timeline_event_id,
      );
      expect(correctedEvidence[0].canonical_audit_event_id).toBe(
        settledInitialEvidence[0].canonical_audit_event_id,
      );

      expect(correctedEvidence[1]).toMatchObject({
        handoff_id: pendingResultHandoffId,
        admission_id: admissionId,
        patient_uid: PATIENT_UID,
        generation_id: correctedGenerationId,
        predecessor_generation_id: initialGenerationId,
        predecessor_owner_action_id: initialOwnerActionId,
        predecessor_resolution_action_id: initialCrossSignResolution.id,
        rearm_source_action_id: null,
        owner_uid: COVERING_DOCTOR_UID,
        is_current: true,
        source_kind: 'shared_investigation',
        source_table: 'investigations',
        source_episode_type: 'investigation',
        source_episode_key: `investigation:${investigationId}`,
        investigation_id: investigationId,
        ordering_owner_uid: DOCTOR_UID,
        owner_source: 'named_orderer',
        signer_uid: DOCTOR_UID,
        signer_role: 'DOCTOR',
        classification: 'normal',
        item_count: 1,
        task_kind: 'review',
        related_resource_type: 'discharge_pending_result_action',
        related_resource_id: `${pendingResultHandoffId}:${correctedGenerationId}`,
        task_patient_uid: PATIENT_UID,
        assigned_to_uid: COVERING_DOCTOR_UID,
        assigned_to_role: null,
        task_created_by: DOCTOR_UID,
        task_status: 'open',
        task_completed_at: null,
        task_cancelled_at: null,
        task_cancellation_reason: null,
        parent_task_status: 'open',
        parent_task_completed_at: null,
        timeline_event_type: 'discharge.pending_result_available',
        timeline_event_status: 'result_rearmed',
        timeline_source_table: 'discharge_pending_result_handoffs',
        timeline_source_id: pendingResultHandoffId,
        timeline_resource_type: 'diagnostic_result_generation',
        timeline_resource_id: correctedGenerationId,
        timeline_admission_id: String(admissionId),
        timeline_handoff_id: pendingResultHandoffId,
        timeline_generation_id: correctedGenerationId,
        timeline_predecessor_generation_id: initialGenerationId,
        audit_action: 'discharge.pending_result_available',
        audit_action_status: 'success',
        audit_resource_table: 'discharge_pending_result_handoffs',
        audit_resource_id: correctedGenerationId,
        outbox_event_type: 'discharge.pending_result_available',
        outbox_aggregate_type: 'discharge_pending_result_handoff',
        outbox_aggregate_id: pendingResultHandoffId,
        outbox_generation_id: correctedGenerationId,
        outbox_predecessor_generation_id: initialGenerationId,
      });
      expect(Number(correctedEvidence[1].source_version)).toBe(2);
      expect(Number(correctedEvidence[1].task_id)).toBeGreaterThan(0);
      expect(Number(correctedEvidence[1].task_id)).not.toBe(
        Number(correctedEvidence[0].task_id),
      );
      expect(Number(correctedEvidence[1].parent_task_id)).not.toBe(
        pendingResultTrackingTaskId,
      );
      expect(correctedEvidence[1].recorded_at).toBeTruthy();
      const correctedOwnerActionId = correctedEvidence[1].id;
      const correctedActionTaskId = Number(correctedEvidence[1].task_id);
      const correctedTrackingTaskId = Number(correctedEvidence[1].parent_task_id);
      const correctedSnapshotSha256 = correctedResult.body.data.investigation
        .diagnostic_generation_snapshot_sha256;
      expect(correctedSnapshotSha256).toMatch(/^[0-9a-f]{64}$/);

      const handoffRows = await prisma.$queryRawUnsafe(
        `SELECT handoff_state, result_status, resolution_generation_id,
                resolution_action_id, resolved_at, resolved_by_uid,
                task_id
           FROM discharge_pending_result_handoffs
          WHERE tenant_id = $1::uuid
            AND id = $2::uuid
            AND admission_id = $3::integer
            AND patient_uid = $4::uuid`,
        DEFAULT_TENANT,
        pendingResultHandoffId,
        admissionId,
        PATIENT_UID,
      );
      expect(handoffRows).toEqual([
        expect.objectContaining({
          handoff_state: 'result_available',
          result_status: 'available',
          resolution_generation_id: initialGenerationId,
          resolution_action_id: null,
          resolved_at: null,
          resolved_by_uid: null,
          task_id: correctedTrackingTaskId,
        }),
      ]);

      const correctedReplay = await coveringDoctor
        .post(
          `/api/v1/emr/${admissionId}/pending-result-handoffs/`
          + `${pendingResultHandoffId}/result-available`,
        )
        .send({ generation_id: correctedGenerationId });
      expect(correctedReplay.statusCode).toBe(200);
      expect(correctedReplay.body.data).toMatchObject({
        handoff: {
          id: pendingResultHandoffId,
          admission_id: admissionId,
          handoff_state: 'result_available',
          result_status: 'available',
          resolution_generation_id: initialGenerationId,
          resolution_action_id: null,
        },
        action_task: {
          id: correctedActionTaskId,
          status: 'open',
          assigned_to_uid: COVERING_DOCTOR_UID,
          related_resource_type: 'discharge_pending_result_action',
          related_resource_id: `${pendingResultHandoffId}:${correctedGenerationId}`,
          parent_task_id: correctedTrackingTaskId,
        },
        owner_action: {
          id: correctedOwnerActionId,
          handoff_id: pendingResultHandoffId,
          generation_id: correctedGenerationId,
          predecessor_generation_id: initialGenerationId,
          predecessor_owner_action_id: initialOwnerActionId,
          predecessor_resolution_action_id: initialCrossSignResolution.id,
          rearm_source_action_id: null,
          task_id: correctedActionTaskId,
          owner_uid: COVERING_DOCTOR_UID,
        },
        ordering_owner_obligation_preserved: true,
      });
      expect(await pendingResultOwnerActionEvidence(pendingResultHandoffId))
        .toEqual(correctedEvidence);

      const exactGenerations = await prisma.$queryRawUnsafe(
        `SELECT generation.id,
                 generation.source_version,
                 generation.predecessor_generation_id,
                 generation.snapshot_sha256 AS generation_snapshot_sha256,
                 item.source_version AS item_source_version,
                 item.value_snapshot,
                 item.item_snapshot_sha256
            FROM diagnostic_result_generations AS generation
            JOIN diagnostic_result_generation_items AS item
              ON item.tenant_id = generation.tenant_id
             AND item.patient_uid = generation.patient_uid
             AND item.generation_id = generation.id
           WHERE generation.tenant_id = $1::uuid
             AND generation.patient_uid = $2::uuid
             AND generation.admission_id = $3::integer
            AND generation.source_kind = 'shared_investigation'
            AND generation.source_episode_key = $4::text
          ORDER BY generation.source_version ASC`,
        DEFAULT_TENANT,
        PATIENT_UID,
        admissionId,
        `investigation:${investigationId}`,
      );
      expect(exactGenerations.map((generation) => ({
        id: generation.id,
        source_version: Number(generation.source_version),
        predecessor_generation_id: generation.predecessor_generation_id,
        item_source_version: Number(generation.item_source_version),
        value_snapshot: generation.value_snapshot,
        generation_snapshot_sha256: generation.generation_snapshot_sha256,
        item_snapshot_sha256: generation.item_snapshot_sha256,
      }))).toEqual([
        {
          id: initialGenerationId,
          source_version: 1,
          predecessor_generation_id: null,
          item_source_version: 1,
          value_snapshot: {
            value: 'Methicillin-sensitive Staphylococcus aureus',
            unit: null,
            reference_range: null,
          },
          generation_snapshot_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          item_snapshot_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        {
          id: correctedGenerationId,
          source_version: 2,
          predecessor_generation_id: initialGenerationId,
          item_source_version: 2,
          value_snapshot: {
            value: 'Normal respiratory flora',
            unit: null,
            reference_range: null,
          },
          generation_snapshot_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          item_snapshot_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ]);
      expect(exactGenerations[1].generation_snapshot_sha256).not.toBe(
        exactGenerations[0].generation_snapshot_sha256,
      );
      expect(exactGenerations[1].item_snapshot_sha256).not.toBe(
        exactGenerations[0].item_snapshot_sha256,
      );

      await projectDiagnosticGeneration(correctedGenerationId);
      const unsupportedClosure = await closeNormalDiagnosticGenerationIfEligible({
        tenantId: DEFAULT_TENANT,
        generationId: correctedGenerationId,
        activationEvidenceCapability: activationCapability,
      });
      expect(unsupportedClosure).toMatchObject({
        generation_id: correctedGenerationId,
        closed: false,
        outcome: 'unsupported_source',
        release_decision: {
          outcome: 'unsupported_source',
          policy: 'lab_result_visibility.v1',
          generation_id: correctedGenerationId,
        },
      });

      const correctedDiagnosticWork = await prisma.$queryRawUnsafe(
        `SELECT pathway.clinical_status,
                run.current_step_key,
                step.status AS step_status,
                task.id AS task_id
           FROM care_pathway_instances AS pathway
           JOIN workflow_runs AS run
             ON run.tenant_id = pathway.tenant_id
            AND run.id = pathway.workflow_run_id
           JOIN workflow_steps AS step
             ON step.tenant_id = run.tenant_id
            AND step.workflow_run_id = run.id
            AND step.step_key = run.current_step_key
           LEFT JOIN tasks AS task
             ON task.tenant_id = step.tenant_id
            AND task.workflow_run_id = step.workflow_run_id
            AND task.workflow_step_id = step.id
          WHERE pathway.tenant_id = $1::uuid
            AND pathway.pathway_key = $2::text
            AND pathway.source_episode_type = 'diagnostic_result_generation'
            AND pathway.source_episode_id = $3::text`,
        DEFAULT_TENANT,
        DIAGNOSTIC_PATHWAY_KEY,
        correctedGenerationId,
      );
      expect(correctedDiagnosticWork).toEqual([{
        clinical_status: 'active',
        current_step_key: 'await_normal_release_closure',
        step_status: 'blocked',
        task_id: null,
      }]);

      const rearmedCorrectedEvidence = await pendingResultOwnerActionEvidence(
        pendingResultHandoffId,
      );
      expect(rearmedCorrectedEvidence).toHaveLength(2);
      expect(rearmedCorrectedEvidence[0]).toMatchObject({
        id: initialOwnerActionId,
        generation_id: initialGenerationId,
        task_status: 'completed',
        parent_task_status: 'completed',
        is_current: false,
      });
      expect(rearmedCorrectedEvidence[1]).toMatchObject({
        id: correctedOwnerActionId,
        generation_id: correctedGenerationId,
        predecessor_generation_id: initialGenerationId,
        predecessor_owner_action_id: initialOwnerActionId,
        predecessor_resolution_action_id: initialCrossSignResolution.id,
        task_id: correctedActionTaskId,
        task_status: 'open',
        parent_task_id: correctedTrackingTaskId,
        parent_task_status: 'open',
        is_current: true,
      });
      expect(rearmedCorrectedEvidence[1].task_completed_at).toBeNull();
      expect(rearmedCorrectedEvidence[1].parent_task_completed_at).toBeNull();

      const normalOrder = await doctor.post('/api/v1/investigations/order').send({
        patient_id: patientId,
        test_name: 'Post-discharge normal blood count',
        type: 'LAB',
        priority: 'NORMAL',
        notes: 'Separate released normal-result policy proof.',
      });
      expect(normalOrder.statusCode).toBe(200);
      const normalInvestigation = normalOrder.body.data?.investigation;
      expect(normalInvestigation).toMatchObject({
        patient_id: patientId,
        patient_uid: PATIENT_UID,
        test_name: 'Post-discharge normal blood count',
        test_type: 'LAB',
        status: 'REQUESTED',
      });
      expect(normalInvestigation.admission_id).toBeNull();

      const normalGeneration = await createNormalLabGeneration({
        investigationId: Number(normalInvestigation.id),
        admissionId: null,
      });
      const normalGenerationId = String(normalGeneration.id);
      expect(normalGeneration).toMatchObject({
        source_kind: 'lab_panel',
        source_episode_type: 'investigation',
        source_episode_key: `investigation:${normalInvestigation.id}`,
        classification: 'normal',
        admission_id: null,
      });
      await projectDiagnosticGeneration(normalGenerationId);
      const releasedResult = await releaseResultNow(normalGeneration.lab_result_id, {
        tenantId: DEFAULT_TENANT,
        actorUid: DOCTOR_UID,
        actorRole: 'DOCTOR',
        actorRoles: ['DOCTOR'],
        actorRawRole: 'DOCTOR',
      });
      expect(releasedResult.released_to_patient_at).toBeTruthy();
      expect(releasedResult.release_hold).toBe(false);

      const normalClosure = await closeNormalDiagnosticGenerationIfEligible({
        tenantId: DEFAULT_TENANT,
        generationId: normalGenerationId,
        activationEvidenceCapability: activationCapability,
      });
      expect(normalClosure).toMatchObject({
        generation_id: normalGenerationId,
        action_kind: 'normal_auto_closed',
        replayed: false,
        pathway: {
          clinical_status: 'completed',
          replayed: false,
        },
      });
      expect(normalClosure.id).toBeTruthy();
      expect(normalClosure.signature_id).toBeNull();
      expect(normalClosure.request_sha256).toMatch(/^[0-9a-f]{64}$/);

      const reopened = await reopenNormalDiagnosticGeneration({
        tenantId: DEFAULT_TENANT,
        generationId: normalGenerationId,
        reason: 'Ordering clinician requires one same-generation review after normal auto-close.',
        idempotencyKey: `journey-normal-doctor-reopen-${RUN}`,
        activationEvidenceCapability: activationCapability,
      }, {
        actorUid: DOCTOR_UID,
        actorName: `Dr Ward ${RUN}`,
        actorRole: 'DOCTOR',
        actorRoles: ['DOCTOR'],
      });
      expect(reopened).toMatchObject({
        generation_id: normalGenerationId,
        action_kind: 'doctor_reopened',
        replayed: false,
      });
      expect(reopened.id).toBeTruthy();
      expect(reopened.signature_id).toBeNull();

      expect(await pendingResultOwnerActionEvidence(pendingResultHandoffId))
        .toEqual(rearmedCorrectedEvidence);

      const reopenActionRows = await prisma.$queryRawUnsafe(
        `SELECT id, action_kind, generation_id, pathway_instance_id, task_id,
                predecessor_action_id, actor_uid, generation_snapshot_sha256,
                canonical_timeline_event_id, canonical_audit_event_id
           FROM diagnostic_result_actions
          WHERE tenant_id = $1::uuid
            AND id = $2::uuid
            AND generation_id = $3::uuid`,
        DEFAULT_TENANT,
        reopened.id,
        normalGenerationId,
      );
      expect(reopenActionRows).toEqual([expect.objectContaining({
        id: reopened.id,
        action_kind: 'doctor_reopened',
        generation_id: normalGenerationId,
        task_id: null,
        predecessor_action_id: normalClosure.id,
        actor_uid: DOCTOR_UID,
        generation_snapshot_sha256: normalGeneration.snapshot_sha256,
      })]);
      expect(reopenActionRows[0].pathway_instance_id).toBeTruthy();
      expect(reopenActionRows[0].canonical_timeline_event_id).toBeTruthy();
      expect(reopenActionRows[0].canonical_audit_event_id).toBeTruthy();

      const beforeHistoricalReplay = await ownerTransferStateSnapshot({
        admissionId,
        pathwayInstanceId,
        pendingResultHandoffId,
      });
      const historicalReplay = await coveringDoctor
        .post(
          `/api/v1/emr/${admissionId}/pending-result-handoffs/`
          + `${pendingResultHandoffId}/cross-sign`,
        )
        .set('Idempotency-Key', `journey-initial-cross-sign-${RUN}`)
        .send(initialCrossSignRequest);
      expect(historicalReplay.statusCode).toBe(200);
      expect(historicalReplay.body.data?.resolution).toMatchObject({
        id: initialCrossSignResolution.id,
        resolution_action_id: initialCrossSignResolution.id,
        handoff_id: pendingResultHandoffId,
        generation_id: initialGenerationId,
        diagnostic_action_id: initialDisposition.id,
        owner_action_id: initialOwnerActionId,
        action_task_id: initialOwnerActionTaskId,
        tracking_task_id: pendingResultTrackingTaskId,
        handoff_state: 'resolved',
        current_handoff_state: 'result_available',
        request_sha256: initialCrossSignResolution.request_sha256,
        replayed: true,
      });
      const afterHistoricalReplay = await ownerTransferStateSnapshot({
        admissionId,
        pathwayInstanceId,
        pendingResultHandoffId,
      });
      expect(afterHistoricalReplay).toEqual(beforeHistoricalReplay);
      expect(afterHistoricalReplay.core).toEqual([expect.objectContaining({
        handoff_state: 'result_available',
        result_status: 'available',
        named_physician_uid: COVERING_DOCTOR_UID,
        tracking_task_id: String(correctedTrackingTaskId),
        tracking_status: 'open',
        resolution_action_id: null,
      })]);
      expect(afterHistoricalReplay.core[0].tracking_completed_at).toBeNull();
      expect(afterHistoricalReplay.ownerActions.at(-1)).toMatchObject({
        id: correctedOwnerActionId,
        generation_id: correctedGenerationId,
        predecessor_owner_action_id: initialOwnerActionId,
        predecessor_resolution_action_id: initialCrossSignResolution.id,
        rearm_source_action_id: null,
        task_id: String(correctedActionTaskId),
        task_status: 'open',
        parent_task_id: String(correctedTrackingTaskId),
      });
      expect(afterHistoricalReplay.ownerActions.at(-1).task_completed_at).toBeNull();

      const pathwayBeforeContact = await prisma.$queryRawUnsafe(
        `SELECT clinical_status, closed_at
           FROM care_pathway_instances
          WHERE tenant_id = $1::uuid
            AND id = $2::uuid`,
        DEFAULT_TENANT,
        pathwayInstanceId,
      );
      expect(pathwayBeforeContact).toEqual([
        expect.objectContaining({
          clinical_status: 'completed',
        }),
      ]);
      expect(pathwayBeforeContact[0].closed_at).toBeTruthy();
    });
  });

  describe('Step 16 — post-discharge recovery contact is the journey stop', () => {
    it('records one real contact outcome without inventing a scheduling policy', async () => {
      const summary = 'Patient reports improving breathlessness and understands that the corrected sputum result is available for named-physician review.';
      const res = await coveringDoctor
        .post(`/api/v1/emr/${admissionId}/post-discharge-contacts`)
        .send({
          event_kind: 'outcome',
          contact_source: 'manual',
          contact_channel: 'phone',
          patient_safe_summary: summary,
          outcome_code: 'reached_improving',
          idempotency_key: `journey-post-discharge-contact-${RUN}`,
        });
      expect(res.statusCode).toBe(201);
      const contact = res.body.data?.contact;
      expect(contact).toMatchObject({
        admission_id: admissionId,
        event_kind: 'outcome',
        contact_source: 'manual',
        contact_channel: 'phone',
        outcome_code: 'reached_improving',
        patient_safe_summary: summary,
        policy_rule_code: null,
      });
      expect(contact.id).toBeTruthy();
      expect(contact.occurred_at).toBeTruthy();
      expect(contact.recorded_at).toBeTruthy();

      const rows = await prisma.$queryRawUnsafe(
        `SELECT contact.id,
                contact.tenant_id,
                contact.admission_id,
                contact.patient_uid,
                contact.recorded_by_uid,
                contact.recorded_by_system_key,
                contact.canonical_timeline_event_id,
                contact.canonical_audit_event_id,
                timeline.event_type,
                timeline.source_table,
                timeline.source_id,
                audit.action,
                audit.resource_table,
                audit.resource_id
           FROM post_discharge_contact_events AS contact
           JOIN clinical_timeline_events AS timeline
             ON timeline.tenant_id = contact.tenant_id
            AND timeline.id = contact.canonical_timeline_event_id
           JOIN clinical_audit_events AS audit
             ON audit.tenant_id = contact.tenant_id
            AND audit.id = contact.canonical_audit_event_id
          WHERE contact.tenant_id = $1::uuid
            AND contact.id = $2::uuid`,
        DEFAULT_TENANT,
        contact.id,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: contact.id,
        tenant_id: DEFAULT_TENANT,
        admission_id: admissionId,
        patient_uid: PATIENT_UID,
        recorded_by_uid: COVERING_DOCTOR_UID,
        recorded_by_system_key: null,
        event_type: 'post_discharge.contact_recorded',
        source_table: 'post_discharge_contact_events',
        source_id: contact.id,
        action: 'post_discharge.contact_recorded',
        resource_table: 'post_discharge_contact_events',
        resource_id: contact.id,
      });
      expect(rows[0].canonical_timeline_event_id).toBeTruthy();
      expect(rows[0].canonical_audit_event_id).toBeTruthy();

      await projectLatestInpatientEvent(
        admissionId,
        'post_discharge.contact_recorded',
        contact.id,
      );

      const listed = await doctor
        .get(`/api/v1/emr/${admissionId}/post-discharge-contacts`);
      expect(listed.statusCode).toBe(200);
      expect(listed.body.data).toMatchObject({ count: 1 });
      expect(listed.body.data.contacts).toEqual([
        expect.objectContaining({
          id: contact.id,
          admission_id: admissionId,
          event_kind: 'outcome',
          contact_source: 'manual',
          contact_channel: 'phone',
          outcome_code: 'reached_improving',
          patient_safe_summary: summary,
        }),
      ]);

      const pathways = await prisma.$queryRawUnsafe(
        `SELECT clinical_status, completion_outcome, closed_at
           FROM care_pathway_instances
          WHERE tenant_id = $1::uuid
            AND id = $2::uuid`,
        DEFAULT_TENANT,
        pathwayInstanceId,
      );
      expect(pathways).toHaveLength(1);
      expect(pathways[0]).toMatchObject({
        clinical_status: 'completed',
        completion_outcome: 'workflow_completed',
      });
      expect(pathways[0].closed_at).toBeTruthy();
    });
  });
});
