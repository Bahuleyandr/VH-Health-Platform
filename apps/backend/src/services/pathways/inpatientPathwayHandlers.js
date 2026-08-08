import { mergedPatientUidsSubquery } from '../clinical/mergedPatientReadUnion.js';

function admissionIdFromInstance(instance) {
  if (instance?.source_episode_type !== 'admission') return null;
  const parsed = Number.parseInt(instance.source_episode_id, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function loadInpatientPathwayEvidence({ tx, tenantId, instance }) {
  const admissionId = admissionIdFromInstance(instance);
  if (!admissionId) return { admission_found: false };
  const rows = await tx.$queryRawUnsafe(
    `SELECT admission.id,
            admission.patient_uid,
            admission.encounter_id,
            LOWER(BTRIM(COALESCE(admission.status, ''))) AS admission_status,
            admission.discharge_initiated_at,
            admission.discharge_drugs_dispensed_at,
            admission.discharged_at,
            admission.prior_admission_id,
            assignment.id AS primary_assignment_id,
            assignment.physician_uid AS primary_physician_uid,
            assignment.assignment_version,
            care_pathway_named_clinician_is_viable(
              admission.tenant_id,
              assignment.physician_uid
            ) AS primary_physician_is_viable,
            summary.id AS discharge_summary_id,
            summary.signed_at AS discharge_summary_signed_at,
            summary.patient_guardian_instructions_section_id,
            summary.escalation_contact_section_id,
            summary.required_equipment_home_care_section_id,
            summary.discharge_destination_section_id,
            summary.transport_plan_section_id,
            COALESCE(consult_rollup.pending_count, 0)::integer AS pending_consult_count,
            COALESCE(invoice_rollup.finalized_count, 0)::integer AS finalized_invoice_count,
            COALESCE(invoice_rollup.unpaid_count, 0)::integer AS unpaid_invoice_count,
            medication_reconciliation.id AS medication_reconciliation_id,
            medication_reconciliation.completed_at AS medication_reconciliation_completed_at,
            medication_reconciliation.take_home_list_recorded,
            follow_up.id AS follow_up_plan_id,
            follow_up.appointment_id AS follow_up_appointment_id,
            follow_up.appointment_status AS follow_up_appointment_status,
            follow_up_exception.timeline_id AS follow_up_exception_timeline_id,
            follow_up_exception.audit_id AS follow_up_exception_audit_id,
            COALESCE(
              pending_result_rollup.unhanded_count,
              0
            )::integer AS unhanded_pending_result_count,
            COALESCE(
              pending_result_rollup.invalid_handoff_count,
              0
            )::integer AS invalid_pending_result_handoff_count,
            COALESCE(
              pending_result_rollup.unresolved_safety_action_count,
              0
            )::integer AS unresolved_diagnostic_safety_action_count,
            COALESCE(
              diagnostic_lineage_rollup.expected_source_count,
              0
            )::integer AS diagnostic_lineage_expected_source_count,
            COALESCE(
              diagnostic_lineage_rollup.current_reference_count,
              0
            )::integer AS diagnostic_lineage_current_reference_count,
            COALESCE(
              diagnostic_lineage_rollup.missing_reference_count,
              0
            )::integer AS diagnostic_lineage_missing_reference_count,
            COALESCE(
              diagnostic_lineage_rollup.orphan_reference_count,
              0
            )::integer AS diagnostic_lineage_orphan_reference_count,
            COALESCE(
              contact_rollup.contact_count,
              0
            )::integer AS post_discharge_contact_count
       FROM admissions AS admission
       LEFT JOIN LATERAL (
         SELECT candidate.id,
                candidate.physician_uid,
                candidate.assignment_version
           FROM inpatient_primary_physician_assignments AS candidate
          WHERE candidate.tenant_id = admission.tenant_id
            AND candidate.admission_id = admission.id
            AND candidate.patient_uid = admission.patient_uid
          ORDER BY candidate.assignment_version DESC, candidate.recorded_at DESC
          LIMIT 1
       ) AS assignment ON TRUE
       LEFT JOIN LATERAL (
         SELECT candidate.id,
                candidate.signed_at,
                closure.patient_guardian_instructions_section_id,
                closure.escalation_contact_section_id,
                closure.required_equipment_home_care_section_id,
                closure.discharge_destination_section_id,
                closure.transport_plan_section_id
           FROM discharge_summaries AS candidate
           LEFT JOIN LATERAL (
             SELECT
               MAX(section.id) FILTER (
                 WHERE LOWER(section.section_key) = 'patient_guardian_instructions'
                   AND NULLIF(BTRIM(section.body), '') IS NOT NULL
                   AND STRPOS(LOWER(section.body), '[placeholder') = 0
               ) AS patient_guardian_instructions_section_id,
               MAX(section.id) FILTER (
                 WHERE LOWER(section.section_key) = 'escalation_contact'
                   AND NULLIF(BTRIM(section.body), '') IS NOT NULL
                   AND STRPOS(LOWER(section.body), '[placeholder') = 0
               ) AS escalation_contact_section_id,
               MAX(section.id) FILTER (
                 WHERE LOWER(section.section_key) = 'required_equipment_home_care'
                   AND NULLIF(BTRIM(section.body), '') IS NOT NULL
                   AND STRPOS(LOWER(section.body), '[placeholder') = 0
               ) AS required_equipment_home_care_section_id,
               MAX(section.id) FILTER (
                 WHERE LOWER(section.section_key) = 'discharge_destination'
                   AND NULLIF(BTRIM(section.body), '') IS NOT NULL
                   AND STRPOS(LOWER(section.body), '[placeholder') = 0
               ) AS discharge_destination_section_id,
               MAX(section.id) FILTER (
                 WHERE LOWER(section.section_key) = 'transport_plan'
                   AND NULLIF(BTRIM(section.body), '') IS NOT NULL
                   AND STRPOS(LOWER(section.body), '[placeholder') = 0
               ) AS transport_plan_section_id
              FROM discharge_summary_sections AS section
             WHERE section.discharge_summary_id = candidate.id
           ) AS closure ON TRUE
          WHERE candidate.tenant_id = admission.tenant_id
            AND candidate.admission_id = admission.id
            AND candidate.patient_uid = admission.patient_uid
            AND candidate.status IN ('signed', 'delivered')
            AND candidate.signed_at IS NOT NULL
            AND candidate.signed_by IS NOT NULL
          ORDER BY candidate.signed_at DESC, candidate.id DESC
          LIMIT 1
       ) AS summary ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (
                  WHERE consult.completed_at IS NULL
                ) AS pending_count
           FROM discharge_consults AS consult
          WHERE consult.tenant_id = admission.tenant_id
            AND consult.admission_id = admission.id
            AND consult.patient_uid = admission.patient_uid
       ) AS consult_rollup ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (
                  WHERE invoice.status IN ('ISSUED', 'PARTIAL', 'PAID')
                ) AS finalized_count,
                COUNT(*) FILTER (
                  WHERE COALESCE(invoice.status, '') NOT IN (
                    'PAID',
                    'VOID',
                    'paid',
                    'written_off',
                    'cancelled'
                  )
                    AND COALESCE(invoice.amount_due, 0) > 0
                ) AS unpaid_count
           FROM billing_invoices AS invoice
          WHERE invoice.tenant_id = admission.tenant_id
            AND invoice.admission_id = admission.id
       ) AS invoice_rollup ON TRUE
       LEFT JOIN LATERAL (
         SELECT reconciliation.id,
                reconciliation.completed_at,
                (
                  jsonb_typeof(reconciliation.metadata -> 'take_home_list') = 'array'
                ) AS take_home_list_recorded
           FROM medication_reconciliations AS reconciliation
          WHERE reconciliation.tenant_id = admission.tenant_id
            AND reconciliation.admission_id = admission.id
            AND reconciliation.patient_uid = admission.patient_uid
            AND reconciliation.rec_type = 'discharge'
            AND reconciliation.status = 'completed'
            AND reconciliation.completed_at IS NOT NULL
            AND reconciliation.completed_by IS NOT NULL
          ORDER BY reconciliation.completed_at DESC, reconciliation.id DESC
          LIMIT 1
       ) AS medication_reconciliation ON TRUE
       LEFT JOIN LATERAL (
         SELECT plan.id, plan.appointment_id, plan.appointment_status
           FROM follow_up_plans AS plan
           JOIN appointments AS appointment
             ON appointment.tenant_id = plan.tenant_id
            AND appointment.id = plan.appointment_id
            AND appointment.patient_id = (
              SELECT patient.id
                FROM users AS patient
               WHERE patient.tenant_id = admission.tenant_id
                 AND patient.uid = admission.patient_uid
               LIMIT 1
            )
          WHERE plan.tenant_id = admission.tenant_id
            AND plan.patient_uid = admission.patient_uid
            AND plan.origin_kind = 'admission'
            AND plan.origin_resource_type = 'admission'
            AND plan.origin_resource_id = admission.id::text
            AND plan.appointment_id IS NOT NULL
            AND plan.status IN ('open', 'scheduled')
            AND UPPER(BTRIM(appointment.status)) NOT IN (
              'CANCELLED',
              'NO_SHOW',
              'RESCHEDULED'
            )
          ORDER BY plan.created_at DESC, plan.id DESC
          LIMIT 1
       ) AS follow_up ON TRUE
       LEFT JOIN LATERAL (
         -- Merged-uid union: the exception may predate a patient merge and
         -- stay recorded under a uid merged into this admission's patient
         -- (append-only timeline/audit are never re-pointed).
         SELECT timeline.id AS timeline_id, audit.id AS audit_id
           FROM clinical_timeline_events AS timeline
           JOIN clinical_audit_events AS audit
             ON audit.tenant_id = timeline.tenant_id
            AND audit.patient_uid = timeline.patient_uid
            AND audit.encounter_id IS NOT DISTINCT FROM timeline.encounter_id
            AND audit.action = 'discharge.follow_up_exception_recorded'
            AND audit.resource_table = 'admissions'
            AND audit.resource_id = admission.id::text
            AND NULLIF(BTRIM(audit.metadata ->> 'reason'), '') IS NOT NULL
          WHERE timeline.tenant_id = admission.tenant_id
            AND timeline.patient_uid IN (
              ${mergedPatientUidsSubquery('admission.tenant_id', 'admission.patient_uid')}
            )
            AND timeline.event_type = 'discharge.follow_up_exception_recorded'
            AND timeline.source_table = 'admissions'
            AND timeline.source_id = admission.id::text
            AND NULLIF(BTRIM(timeline.payload ->> 'reason'), '') IS NOT NULL
          ORDER BY timeline.occurred_at DESC, timeline.id DESC
          LIMIT 1
       ) AS follow_up_exception ON TRUE
       LEFT JOIN LATERAL (
         WITH exact_sources(
           resource_type,
           resource_id,
           terminal,
           requires_safety_action,
           safety_action_complete
         ) AS (
           SELECT 'investigation'::text,
                  source.id::text,
                  UPPER(COALESCE(source.status, '')) IN ('COMPLETED', 'CANCELLED'),
                  FALSE,
                  FALSE
             FROM investigations AS source
            WHERE source.tenant_id = admission.tenant_id
              AND source.admission_id = admission.id
              AND source.patient_uid = admission.patient_uid
           UNION ALL
           SELECT 'lab_result'::text,
                  source.id::text,
                  (
                    LOWER(COALESCE(source.status, '')) IN
                      ('final', 'corrected', 'amended', 'verified')
                    AND source.signed_off_at IS NOT NULL
                  ),
                  FALSE,
                  FALSE
             FROM lab_results AS source
            WHERE source.tenant_id = admission.tenant_id
              AND source.admission_id = admission.id
              AND source.patient_uid = admission.patient_uid
           UNION ALL
           SELECT 'radiology_order'::text,
                  source.id::text,
                  (
                    LOWER(COALESCE(source.status, '')) = 'cancelled'
                    OR source.report_signed_off_at IS NOT NULL
                  ),
                  FALSE,
                  FALSE
             FROM radiology_orders AS source
            WHERE source.tenant_id = admission.tenant_id
              AND source.admission_id = admission.id
              AND source.patient_uid = admission.patient_uid
           UNION ALL
           SELECT 'anatomical_pathology_case'::text,
                  source.id::text,
                  LOWER(COALESCE(source.status, '')) IN
                    ('signed', 'signed_out', 'amended', 'cancelled', 'closed'),
                  FALSE,
                  FALSE
             FROM ap_cases AS source
            WHERE source.tenant_id = admission.tenant_id
              AND source.admission_id = admission.id
              AND source.patient_uid = admission.patient_uid
           UNION ALL
           SELECT 'diagnostic_result_generation'::text,
                  source.id::text,
                  (
                    source.classification = 'normal'
                    OR EXISTS (
                      SELECT 1
                        FROM diagnostic_result_actions AS action
                       WHERE action.tenant_id = source.tenant_id
                         AND action.generation_id = source.id
                         AND action.action_kind IN (
                           'doctor_disposition',
                           'generation_superseded'
                         )
                    )
                  ),
                  source.classification IN ('critical', 'abnormal', 'indeterminate'),
                  EXISTS (
                    SELECT 1
                      FROM diagnostic_result_actions AS action
                     WHERE action.tenant_id = source.tenant_id
                       AND action.generation_id = source.id
                       AND action.action_kind IN (
                         'doctor_disposition',
                         'generation_superseded'
                       )
                  )
             FROM diagnostic_result_generations AS source
            WHERE source.tenant_id = admission.tenant_id
              AND source.admission_id = admission.id
              AND source.patient_uid = admission.patient_uid
         ),
         current_references AS (
           SELECT reference.id,
                  reference.resource_type,
                  reference.resource_id
             FROM care_pathway_resource_references AS reference
            WHERE reference.tenant_id = admission.tenant_id
              AND reference.pathway_instance_id = $3::uuid
              AND reference.patient_uid = admission.patient_uid
              AND reference.relationship_kind = 'child_action'
              AND reference.resource_type IN (
                'investigation',
                'lab_result',
                'radiology_order',
                'anatomical_pathology_case',
                'diagnostic_result_generation'
              )
              AND reference.evidence_state <> 'superseded'
              AND NOT EXISTS (
                SELECT 1
                  FROM care_pathway_resource_references AS successor
                 WHERE successor.tenant_id = reference.tenant_id
                   AND successor.superseded_reference_id = reference.id
              )
         )
         SELECT COUNT(*) FILTER (
                  WHERE source.terminal IS NOT TRUE
                    AND handoff.id IS NULL
                ) AS unhanded_count,
                 COUNT(*) FILTER (
                  WHERE source.terminal IS NOT TRUE
                    AND handoff.id IS NOT NULL
                    AND (
                      handoff.resource_reference_id IS DISTINCT FROM reference.id
                      OR handoff.source_type IS DISTINCT FROM reference.resource_type
                      OR handoff.source_id IS DISTINCT FROM reference.resource_id
                      OR handoff.primary_physician_assignment_id
                           IS DISTINCT FROM assignment.id
                      OR handoff.named_physician_uid
                           IS DISTINCT FROM assignment.physician_uid
                      OR handoff.discharge_summary_id IS DISTINCT FROM summary.id
                      OR handoff.summary_included_at IS NULL
                      OR handoff.summary_inclusion_timeline_event_id IS NULL
                      OR handoff.task_id IS NULL
                      OR owner_task.id IS NULL
                      OR owner_task.assigned_to_uid
                           IS DISTINCT FROM assignment.physician_uid
                      OR owner_task.assigned_to_role IS NOT NULL
                    )
                 ) AS invalid_handoff_count
                 ,
                 COUNT(*) FILTER (
                  WHERE source.requires_safety_action IS TRUE
                    AND source.safety_action_complete IS NOT TRUE
                 ) AS unresolved_safety_action_count
           FROM exact_sources AS source
           LEFT JOIN current_references AS reference
             ON reference.resource_type = source.resource_type
            AND reference.resource_id = source.resource_id
           LEFT JOIN discharge_pending_result_handoffs AS handoff
             ON handoff.tenant_id = admission.tenant_id
             AND handoff.resource_reference_id = reference.id
             AND handoff.admission_id = admission.id
             AND handoff.patient_uid = admission.patient_uid
            AND handoff.handoff_state <> 'superseded'
           LEFT JOIN tasks AS owner_task
             ON owner_task.tenant_id = handoff.tenant_id
             AND owner_task.id = handoff.task_id
       ) AS pending_result_rollup ON TRUE
       LEFT JOIN LATERAL (
         WITH exact_sources(resource_type, resource_id) AS (
           SELECT 'investigation'::text, source.id::text
             FROM investigations AS source
            WHERE source.tenant_id = admission.tenant_id
              AND source.admission_id = admission.id
              AND source.patient_uid = admission.patient_uid
           UNION ALL
           SELECT 'lab_result'::text, source.id::text
             FROM lab_results AS source
            WHERE source.tenant_id = admission.tenant_id
              AND source.admission_id = admission.id
              AND source.patient_uid = admission.patient_uid
           UNION ALL
           SELECT 'radiology_order'::text, source.id::text
             FROM radiology_orders AS source
            WHERE source.tenant_id = admission.tenant_id
              AND source.admission_id = admission.id
              AND source.patient_uid = admission.patient_uid
           UNION ALL
           SELECT 'anatomical_pathology_case'::text, source.id::text
             FROM ap_cases AS source
            WHERE source.tenant_id = admission.tenant_id
              AND source.admission_id = admission.id
              AND source.patient_uid = admission.patient_uid
           UNION ALL
           SELECT 'diagnostic_result_generation'::text, source.id::text
             FROM diagnostic_result_generations AS source
            WHERE source.tenant_id = admission.tenant_id
              AND source.admission_id = admission.id
              AND source.patient_uid = admission.patient_uid
         ),
         current_references AS (
           SELECT reference.resource_type, reference.resource_id
             FROM care_pathway_resource_references AS reference
            WHERE reference.tenant_id = admission.tenant_id
              AND reference.pathway_instance_id = $3::uuid
              AND reference.patient_uid = admission.patient_uid
              AND reference.relationship_kind = 'child_action'
              AND reference.resource_type IN (
                'investigation',
                'lab_result',
                'radiology_order',
                'anatomical_pathology_case',
                'diagnostic_result_generation'
              )
              AND reference.evidence_state <> 'superseded'
              AND NOT EXISTS (
                SELECT 1
                  FROM care_pathway_resource_references AS successor
                 WHERE successor.tenant_id = reference.tenant_id
                   AND successor.superseded_reference_id = reference.id
              )
         )
         SELECT (SELECT COUNT(*) FROM exact_sources) AS expected_source_count,
                (SELECT COUNT(*) FROM current_references) AS current_reference_count,
                (
                  SELECT COUNT(*)
                    FROM exact_sources AS source
                    LEFT JOIN current_references AS reference
                      ON reference.resource_type = source.resource_type
                     AND reference.resource_id = source.resource_id
                   WHERE reference.resource_id IS NULL
                ) AS missing_reference_count,
                (
                  SELECT COUNT(*)
                    FROM current_references AS reference
                    LEFT JOIN exact_sources AS source
                      ON source.resource_type = reference.resource_type
                     AND source.resource_id = reference.resource_id
                   WHERE source.resource_id IS NULL
                ) AS orphan_reference_count
       ) AS diagnostic_lineage_rollup ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS contact_count
           FROM post_discharge_contact_events AS contact
          WHERE contact.tenant_id = admission.tenant_id
            AND contact.admission_id = admission.id
            AND contact.patient_uid = admission.patient_uid
       ) AS contact_rollup ON TRUE
      WHERE admission.tenant_id = $1::uuid
        AND admission.id = $2::integer
      LIMIT 1`,
    tenantId,
    admissionId,
    instance.id,
  );
  const row = rows[0];
  if (!row) return { admission_found: false };
  return {
    admission_found: true,
    admission_id: Number(row.id),
    patient_uid: row.patient_uid ? String(row.patient_uid) : null,
    encounter_id: row.encounter_id ? String(row.encounter_id) : null,
    admission_status: row.admission_status,
    discharge_planning_started: Boolean(row.discharge_initiated_at),
    discharge_drugs_dispensed: Boolean(row.discharge_drugs_dispensed_at),
    discharged_at_recorded: Boolean(row.discharged_at),
    readmission_linked: row.prior_admission_id != null,
    primary_assignment_id: row.primary_assignment_id
      ? String(row.primary_assignment_id)
      : null,
    primary_physician_uid: row.primary_physician_uid
      ? String(row.primary_physician_uid)
      : null,
    primary_assignment_version: row.assignment_version == null
      ? null
      : Number(row.assignment_version),
    primary_physician_is_viable: row.primary_physician_is_viable === true,
    discharge_summary_id: row.discharge_summary_id == null
      ? null
      : Number(row.discharge_summary_id),
    discharge_summary_signed: Boolean(row.discharge_summary_signed_at),
    patient_guardian_instructions_section_id:
      row.patient_guardian_instructions_section_id == null
        ? null
        : Number(row.patient_guardian_instructions_section_id),
    escalation_contact_section_id: row.escalation_contact_section_id == null
      ? null
      : Number(row.escalation_contact_section_id),
    required_equipment_home_care_section_id:
      row.required_equipment_home_care_section_id == null
        ? null
        : Number(row.required_equipment_home_care_section_id),
    discharge_destination_section_id: row.discharge_destination_section_id == null
      ? null
      : Number(row.discharge_destination_section_id),
    transport_plan_section_id: row.transport_plan_section_id == null
      ? null
      : Number(row.transport_plan_section_id),
    patient_guardian_instructions_recorded:
      row.patient_guardian_instructions_section_id != null,
    escalation_contact_recorded: row.escalation_contact_section_id != null,
    equipment_home_care_plan_recorded:
      row.required_equipment_home_care_section_id != null,
    discharge_destination_recorded: row.discharge_destination_section_id != null,
    transport_plan_recorded: row.transport_plan_section_id != null,
    pending_consult_count: Number(row.pending_consult_count || 0),
    finalized_invoice_count: Number(row.finalized_invoice_count || 0),
    unpaid_invoice_count: Number(row.unpaid_invoice_count || 0),
    medication_reconciliation_id: row.medication_reconciliation_id
      ? String(row.medication_reconciliation_id)
      : null,
    medication_reconciliation_completed: Boolean(
      row.medication_reconciliation_completed_at
      && row.take_home_list_recorded,
    ),
    follow_up_plan_id: row.follow_up_plan_id == null
      ? null
      : Number(row.follow_up_plan_id),
    follow_up_appointment_id: row.follow_up_appointment_id == null
      ? null
      : Number(row.follow_up_appointment_id),
    follow_up_exception_recorded: Boolean(
      row.follow_up_exception_timeline_id && row.follow_up_exception_audit_id,
    ),
    unhanded_pending_result_count: Number(row.unhanded_pending_result_count || 0),
    invalid_pending_result_handoff_count: Number(
      row.invalid_pending_result_handoff_count || 0,
    ),
    unresolved_diagnostic_safety_action_count: Number(
      row.unresolved_diagnostic_safety_action_count || 0,
    ),
    diagnostic_lineage_expected_source_count: Number(
      row.diagnostic_lineage_expected_source_count || 0,
    ),
    diagnostic_lineage_current_reference_count: Number(
      row.diagnostic_lineage_current_reference_count || 0,
    ),
    diagnostic_lineage_missing_reference_count: Number(
      row.diagnostic_lineage_missing_reference_count || 0,
    ),
    diagnostic_lineage_orphan_reference_count: Number(
      row.diagnostic_lineage_orphan_reference_count || 0,
    ),
    diagnostic_lineage_complete:
      Number(row.diagnostic_lineage_missing_reference_count || 0) === 0
      && Number(row.diagnostic_lineage_orphan_reference_count || 0) === 0
      && Number(row.diagnostic_lineage_expected_source_count || 0)
        === Number(row.diagnostic_lineage_current_reference_count || 0),
    post_discharge_contact_count: Number(row.post_discharge_contact_count || 0),
  };
}

export const INPATIENT_PATHWAY_RUNTIME_HANDLERS = Object.freeze({
  acceptedAdmission: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze(['blocked', 'satisfied']),
    loadEvidence: loadInpatientPathwayEvidence,
    async evaluate({ loadedEvidence }) {
      return {
        decision: loadedEvidence.admission_found
          && loadedEvidence.patient_uid
          && loadedEvidence.primary_assignment_id
          && loadedEvidence.primary_physician_uid
          && loadedEvidence.primary_physician_is_viable
          ? 'satisfied'
          : 'blocked',
        evidence: loadedEvidence,
      };
    },
  }),
  dischargePlanning: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze(['blocked', 'satisfied']),
    loadEvidence: loadInpatientPathwayEvidence,
    async evaluate({ loadedEvidence }) {
      return {
        decision: loadedEvidence.discharge_planning_started ? 'satisfied' : 'blocked',
        evidence: loadedEvidence,
      };
    },
  }),
  readinessWork: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze(['blocked', 'satisfied']),
    loadEvidence: loadInpatientPathwayEvidence,
    async evaluate({ loadedEvidence }) {
      return {
        decision: loadedEvidence.discharge_summary_signed
          && loadedEvidence.discharge_drugs_dispensed
          && loadedEvidence.pending_consult_count === 0
          && loadedEvidence.finalized_invoice_count > 0
          && loadedEvidence.unpaid_invoice_count === 0
          ? 'satisfied'
          : 'blocked',
        evidence: loadedEvidence,
      };
    },
  }),
  dischargeEvidence: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze(['blocked', 'satisfied']),
    loadEvidence: loadInpatientPathwayEvidence,
    async evaluate({ loadedEvidence }) {
      return {
        decision: loadedEvidence.primary_physician_is_viable
          && loadedEvidence.discharge_summary_signed
          && loadedEvidence.patient_guardian_instructions_recorded
          && loadedEvidence.escalation_contact_recorded
          && loadedEvidence.equipment_home_care_plan_recorded
          && loadedEvidence.discharge_destination_recorded
          && loadedEvidence.transport_plan_recorded
          && loadedEvidence.medication_reconciliation_completed
          && (
            loadedEvidence.follow_up_appointment_id
            || loadedEvidence.follow_up_exception_recorded
          )
          && loadedEvidence.unhanded_pending_result_count === 0
          && loadedEvidence.invalid_pending_result_handoff_count === 0
          && loadedEvidence.unresolved_diagnostic_safety_action_count === 0
          && loadedEvidence.diagnostic_lineage_complete
          ? 'satisfied'
          : 'blocked',
        evidence: loadedEvidence,
      };
    },
  }),
  dischargeCompletion: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze(['blocked', 'satisfied']),
    loadEvidence: loadInpatientPathwayEvidence,
    async evaluate({ loadedEvidence }) {
      const exceptionalDeparture = ['lama', 'expired'].includes(
        loadedEvidence.admission_status,
      );
      return {
        decision: loadedEvidence.admission_status === 'discharged'
          && loadedEvidence.discharged_at_recorded
          ? 'satisfied'
          : 'blocked',
        evidence: {
          ...loadedEvidence,
          exceptional_departure_requires_governed_reconciliation: exceptionalDeparture,
        },
      };
    },
  }),
  postDischargeContact: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze(['blocked', 'satisfied']),
    loadEvidence: loadInpatientPathwayEvidence,
    async evaluate({ loadedEvidence, tasks, handoffs }) {
      const exceptionalDeparture = ['lama', 'expired'].includes(
        loadedEvidence.admission_status,
      );
      const required = tasks.some((task) => (
        task.status !== 'cancelled'
        && task.related_resource_type === 'post_discharge_contact'
      ));
      const acceptedTransfer = handoffs.some((handoff) => (
        handoff.status === 'accepted'
        && handoff.source_resource_type === 'post_discharge_contact'
      ));
      return {
        decision: exceptionalDeparture
          ? 'blocked'
          : (
            !required
            || loadedEvidence.post_discharge_contact_count > 0
            || acceptedTransfer
              ? 'satisfied'
              : 'blocked'
          ),
        evidence: {
          ...loadedEvidence,
          contact_required_by_registered_work: required,
          accepted_contact_transfer: acceptedTransfer,
          exceptional_departure_requires_governed_reconciliation: exceptionalDeparture,
        },
      };
    },
  }),
  finalize: Object.freeze({
    stepKinds: Object.freeze(['automation']),
    async execute({ instance }) {
      return {
        finalized: true,
        source_episode_type: instance.source_episode_type,
        source_episode_id: instance.source_episode_id,
      };
    },
  }),
});

export default INPATIENT_PATHWAY_RUNTIME_HANDLERS;
