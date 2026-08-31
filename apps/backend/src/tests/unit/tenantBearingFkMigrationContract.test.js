import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

// Re-audit I (tenancy sweep) — the tenant-bearing foreign-key invariant.
//
// WHY THIS FILE WAS REWRITTEN. Its first version regex-matched the TEXT of
// 729_tenant_bearing_fks_and_tenant_default_alignment.sql. Migrations here are
// forward-only and tracker-driven, so a published file is never edited again:
// those assertions could only ever restate what 729 already said, and no
// future table — however wrong — could make them fail. They pinned history,
// not the invariant.
//
// Its second version derived the census from prisma/schema.prisma's
// `@relation(...)` metadata, on the reasoning that `prisma db pull` makes that
// file a faithful projection of the live DDL. That reasoning no longer holds.
// MED-03 moved the datasource to `relationMode = "prisma"` and cut the schema
// down to a curated 24-relation budget that
// scripts/check-prisma-relation-budget.mjs now ENFORCES, precisely so a full
// client generation stays feasible; its own words are "Database foreign keys
// remain authoritative. Add Prisma relations only with a confirmed runtime
// consumer". Introspection under that flag reads no foreign keys at all, so
// the schema went from 2746 relation declarations to 20 and the census went
// empty — and an empty census makes the violation test below pass on every
// possible input, the exact failure mode this file exists to prevent.
//
// So this version reads the authority the branch itself names: pg_constraint
// in the migrated database the suite already runs against. That is the DDL,
// not a projection of it — no datasource flag, introspection setting, or
// re-pull can blind it, and it also sees keys Prisma never modelled. Applied
// against the committed migration chain it reproduces the exemption list
// below exactly: 982 live single-column tenant-bearing keys, 982 exemptions,
// zero offenders and zero stale entries.
//
// THE INVARIANT. A tenant-bearing table that references another tenant-bearing
// table through a SINGLE-column foreign key lets a row in tenant A name a
// parent row owned by tenant B and still satisfy the constraint. The house
// correction is to carry the tenant into the key —
// `FOREIGN KEY (tenant_id, child_col) REFERENCES parent (tenant_id, id)` —
// whose precedent is referrals.appointment_id (594:69-71).
//
// THE EXEMPTION LIST below is the population that already existed when 729
// landed. It only ever shrinks. Both directions fail: a violation missing from
// the list is a new instance of the defect, and a list entry that no longer
// names a single-column FK is a stale line that would let the same defect
// return at the same address and hide behind it — the reasoning
// scripts/check-openapi-lint-budget.mjs spells out for .spectral-baseline.txt.
//
// Adding an entry is a deliberate act that needs a written reason next to it.
// Removing one is what a conversion looks like.

const here = path.dirname(fileURLToPath(import.meta.url));
const backend = path.resolve(here, '../../..');
const migrationsDir = path.join(backend, 'src', 'migrations');
const schemaPath = path.join(backend, 'prisma', 'schema.prisma');

const schemaSource = fs.readFileSync(schemaPath, 'utf8');

// ---------------------------------------------------------------------------
// schema.prisma parsing. Only the shapes `prisma db pull` actually emits are
// handled: one model per `model <name> { ... }` block, one field per line.
// This still backs the `@@unique` and tenant-DEFAULT checks further down —
// those read column and index declarations, which introspection keeps under
// `relationMode = "prisma"`. The FK census does NOT come from here; see the
// live catalog section below.
// ---------------------------------------------------------------------------

function parseModels(source) {
  const models = new Map();
  const modelRe = /^model\s+([A-Za-z0-9_]+)\s*\{$([\s\S]*?)^\}$/gm;
  let match;
  while ((match = modelRe.exec(source)) !== null) {
    models.set(match[1], match[2]);
  }
  return models;
}

const MODELS = parseModels(schemaSource);

/** A model is tenant-bearing when it declares a scalar `tenant_id` field. */
const TENANT_BEARING = new Set(
  [...MODELS].filter(([, body]) => /^\s*tenant_id\s+\S/m.test(body)).map(([name]) => name),
);

// ---------------------------------------------------------------------------
// The live foreign-key catalog — the authority for the census.
// ---------------------------------------------------------------------------

/** pg_constraint.confdeltype / confupdtype, spelled as the DDL spells them. */
const REFERENTIAL_ACTION = new Map([
  ['a', 'NO ACTION'],
  ['r', 'RESTRICT'],
  ['c', 'CASCADE'],
  ['n', 'SET NULL'],
  ['d', 'SET DEFAULT'],
]);

/** Public-schema tables that carry a tenant_id column. */
let TENANT_BEARING_TABLES = new Set();
/** Every public-schema foreign key, described from its child side. */
let FOREIGN_KEYS = [];

const TENANT_BEARING_TABLES_SQL = `
  SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND EXISTS (
           SELECT 1
             FROM pg_attribute a
            WHERE a.attrelid = c.oid
              AND a.attname = 'tenant_id'
              AND a.attnum > 0
              AND NOT a.attisdropped
         )
`;

const FOREIGN_KEYS_SQL = `
  SELECT child.relname  AS child_table,
         parent.relname AS parent_table,
         con.conname    AS constraint_name,
         con.confdeltype AS on_delete,
         con.confupdtype AS on_update,
         (SELECT array_agg(a.attname::text ORDER BY k.ord)
            FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a
              ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS child_columns,
         (SELECT array_agg(a.attname::text ORDER BY k.ord)
            FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a
              ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS parent_columns
    FROM pg_constraint con
    JOIN pg_class child      ON child.oid = con.conrelid
    JOIN pg_namespace cn     ON cn.oid = child.relnamespace
    JOIN pg_class parent     ON parent.oid = con.confrelid
    JOIN pg_namespace pn     ON pn.oid = parent.relnamespace
   WHERE con.contype = 'f'
     AND cn.nspname = 'public'
     AND pn.nspname = 'public'
   ORDER BY child.relname, con.conname
`;

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    // Fail closed. Silently skipping would leave the census empty, which is
    // the one state in which every assertion in this file passes for free.
    throw new Error(
      'TEST_DATABASE_URL/DATABASE_URL is unset — the tenant-bearing FK census '
        + 'is read from pg_constraint and cannot be derived without the migrated database.',
    );
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const tables = await client.query(TENANT_BEARING_TABLES_SQL);
    TENANT_BEARING_TABLES = new Set(tables.rows.map((row) => row.table_name));

    const keys = await client.query(FOREIGN_KEYS_SQL);
    FOREIGN_KEYS = keys.rows.map((row) => {
      const fields = row.child_columns ?? [];
      const references = row.parent_columns ?? [];
      const onDelete = REFERENTIAL_ACTION.get(row.on_delete) ?? row.on_delete;
      const onUpdate = REFERENTIAL_ACTION.get(row.on_update) ?? row.on_update;
      return {
        model: row.child_table,
        target: row.parent_table,
        constraint: row.constraint_name,
        fields,
        references,
        onDelete,
        onUpdate,
        key: `${row.child_table}.${fields.join('+')}`,
        line: `CONSTRAINT ${row.constraint_name} FOREIGN KEY (${fields.join(', ')}) `
          + `REFERENCES ${row.parent_table} (${references.join(', ')}) `
          + `ON DELETE ${onDelete} ON UPDATE ${onUpdate}`,
      };
    });
  } finally {
    await client.end();
  }
}, 60000);

/** Every foreign key `table` declares on its own side of the key. */
function foreignKeysOf(table) {
  return FOREIGN_KEYS.filter((fk) => fk.model === table);
}

/**
 * The census: every FK from a tenant-bearing table to another tenant-bearing
 * table whose key does not include tenant_id. `tenants` itself is excluded —
 * `tenant_id -> tenants(id)` IS the tenant key, not a cross-tenant hazard.
 */
function singleColumnTenantBearingFks() {
  return FOREIGN_KEYS.filter((fk) => (
    TENANT_BEARING_TABLES.has(fk.model)
      && TENANT_BEARING_TABLES.has(fk.target)
      && fk.target !== 'tenants'
      && !fk.fields.includes('tenant_id')
  )).sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// Exemptions.
// ---------------------------------------------------------------------------

/**
 * The payment-gateway / SMS slate (migrations 693-699) ships eight more
 * instances of exactly the defect 729 corrects. They sit immediately below
 * 729's declared 700-727 scope and are deliberately deferred, not overlooked:
 * the four billing_* parents have no (tenant_id, id) unique, so converting
 * them means adding a unique index to the legacy money spine — a change that
 * needs its own migration and its own blast-radius review. The other four are
 * held with them so the slate converts as one unit. 729's header carries the
 * same list.
 *
 * gst_einvoice_documents.invoice_id (migration 738) is deferred with them for
 * the same money-spine reason: its parent is billing_invoices, which still has
 * no (tenant_id, id) unique, so the composite conversion waits on the same
 * unique-index-on-the-legacy-billing-spine work that blocks the four billing_*
 * parents above.
 */
const DEFERRED_PAYMENT_GATEWAY_AND_SMS = `
gst_einvoice_documents.invoice_id
payment_gateway_orders.billing_payment_id
payment_gateway_orders.invoice_id
payment_gateway_orders.payment_link_id
payment_gateway_orders.provider_config_id
payment_gateway_refunds.billing_refund_id
payment_gateway_refunds.gateway_order_id
payment_gateway_webhook_events.gateway_order_id
sms_template_registrations.provider_config_id
`;

/**
 * Everything that predates the 693-727 release train. Machine-derived from
 * prisma/schema.prisma at the commit that introduced 729 — a frozen baseline,
 * not a judgement that each entry is correct. Converting any of them is a
 * separate piece of work whose visible outcome is a line disappearing here.
 *
 * `singleColumnTenantBearingFks().map((fk) => fk.key)` above is the exact
 * derivation, so the current census can always be printed and diffed against
 * this block. Regenerating it wholesale is NOT a way to clear a failure: the
 * two tests below fail precisely so that a new violation gets converted and a
 * converted one gets pruned, by hand, with the reason recorded.
 */
const LEGACY_BASELINE = `
abdm_care_contexts.abha_profile_id
abdm_care_contexts.facility_mapping_id
abdm_consent_artifacts.consent_request_id
abdm_consent_requests.abha_profile_id
abdm_consents.patient_uid
abdm_data_requests.patient_uid
abdm_data_transfers.consent_artifact_id
abdm_webhook_events.related_artifact_id
abdm_webhook_events.related_request_id
abdm_webhook_events.related_transfer_id
admissions.from_er_visit_id
admissions.package_id
admissions.policy_id
advance_deductions.advance_id
advance_deductions.payslip_id
advance_deposits.admission_id
advance_deposits.parent_deposit_id
ambulance_position_events.ambulance_request_id
anesthesia_records.ot_schedule_id
annual_review_reminders.revision_id
annual_tax_summaries.staff_uid
ap_blocks.ap_case_id
ap_blocks.gross_record_id
ap_case_specimens.ap_case_id
ap_case_specimens.specimen_id
ap_cases.primary_specimen_id
ap_cases.source_investigation_id
ap_gross_records.ap_case_id
ap_report_addenda.ap_report_id
ap_reports.ap_case_id
ap_slides.ap_case_id
ap_slides.block_id
api_keys.api_client_id
appointment_documents.appointment_id
appointment_documents.doctor_id
appointment_documents.patient_id
appointment_documents.uploaded_by
appointment_queue_status_history.appointment_queue_id
appointment_slot_holds.appointment_id
appointment_slot_holds.patient_uid
appointment_status_history.appointment_id
appointment_status_history.changed_by
appointments.doctor_id
appointments.parent_appointment_id
appointments.patient_id
appointments.queue_id
attendance_disputes.resolved_by
attendance_disputes.reviewed_by
attendance_disputes.reviewed_by_uid
attendance_disputes.staff_id
attendance_disputes.staff_uid
attendance_logs.staff_id
attendance_regularization.reviewed_by
attendance_regularization.staff_id
attendant_passes.admission_id
bed_inspections.appointment_id
bed_inspections.chosen_bed_id
beds.patient_id
beds.ward_id
billing_advance_settlements.advance_id
billing_advance_settlements.invoice_id
billing_invoice_items.invoice_id
billing_payment_links.invoice_id
billing_payment_links.linked_payment_id
billing_payments.invoice_id
billing_refunds.advance_id
billing_refunds.invoice_id
biomed_calibration_certificates.biomed_device_id
biomed_calibration_certificates.work_order_id
biomed_maintenance_schedules.assigned_to_id
biomed_maintenance_schedules.biomed_device_id
biomed_maintenance_schedules.last_work_order_id
biomed_work_order_recipients.staff_id
biomed_work_order_recipients.work_order_id
biomed_work_order_updates.author_id
biomed_work_order_updates.work_order_id
biomed_work_orders.assigned_to_id
biomed_work_orders.biomed_device_id
biomed_work_orders.schedule_id
blood_requests.crossmatched_unit_id
blood_unit_discard_events.donation_event_id
blood_unit_discard_events.donor_id
blood_unit_discard_events.tti_test_id
blood_unit_discard_events.unit_id
blood_units.component_preparation_id
blood_units.donation_event_id
blood_units.donor_id
blood_units.parent_unit_id
blood_units.request_id
body_custody_events.death_record_id
body_custody_events.slot_id
burn_charts.admission_id
burn_charts.emergency_visit_id
burn_charts.mlc_record_id
burn_fluid_references.content_order_set_id
burn_fluid_worksheets.burn_chart_id
burn_fluid_worksheets.content_order_set_id
burn_fluid_worksheets.protocol_reference_id
burn_protocol_content_links.burn_chart_id
burn_protocol_content_links.content_order_set_id
burn_reassessment_media.burn_chart_id
burn_reassessment_media.reassessment_id
burn_reassessments.burn_chart_id
burn_wound_regions.burn_chart_id
burn_wound_regions.reference_id
care_plan_activities.care_plan_id
care_plan_activities.related_goal_id
care_plan_goals.care_plan_id
care_plan_review_log.care_plan_id
care_plans.superseded_by_id
care_team_member_status_history.care_team_id
care_team_member_status_history.care_team_member_id
care_team_members.care_team_id
care_team_status_history.care_team_id
cath_case_consumable_usage.audit_event_id
cath_case_consumable_usage.case_id
cath_case_consumable_usage.inventory_batch_id
cath_case_consumable_usage.inventory_movement_id
cath_case_consumable_usage.patient_uid
cath_case_consumable_usage.procedure_log_id
cath_case_consumable_usage.timeline_event_id
cath_case_schedule_links.case_id
cath_case_schedule_links.resource_booking_id
cath_case_schedule_links.resource_id
cath_complication_registry.audit_event_id
cath_complication_registry.case_id
cath_complication_registry.patient_uid
cath_complication_registry.procedure_log_id
cath_complication_registry.timeline_event_id
cath_consumable_catalog.inventory_item_id
cath_contrast_radiation_records.case_id
cath_contrast_radiation_records.patient_uid
cath_contrast_radiation_records.procedure_log_id
cath_device_links.case_id
cath_device_links.device_patient_association_id
cath_device_links.patient_uid
cath_device_links.procedure_log_id
cath_hemodynamic_summaries.case_id
cath_hemodynamic_summaries.patient_uid
cath_hemodynamic_summaries.procedure_log_id
cath_lab_cases.appointment_id
cath_lab_cases.audit_event_id
cath_lab_cases.encounter_id
cath_lab_cases.patient_uid
cath_lab_cases.sla_instance_id
cath_lab_cases.timeline_event_id
cath_lab_readiness_checks.case_id
cath_post_procedure_orders.audit_event_id
cath_post_procedure_orders.case_id
cath_post_procedure_orders.patient_uid
cath_post_procedure_orders.procedure_log_id
cath_post_procedure_orders.timeline_event_id
cath_procedure_logs.audit_event_id
cath_procedure_logs.case_id
cath_procedure_logs.encounter_id
cath_procedure_logs.patient_uid
cath_procedure_logs.timeline_event_id
cath_procedure_reports.case_id
cath_procedure_reports.encounter_id
cath_procedure_reports.patient_uid
cath_procedure_reports.procedure_log_id
cath_procedure_reports.template_id
cath_report_addenda.case_id
cath_report_addenda.encounter_id
cath_report_addenda.patient_uid
cath_report_addenda.report_id
cath_report_templates.supersedes_template_id
chair_bookings.chair_id
chair_bookings.cycle_id
chair_bookings.patient_uid
chat_session_messages.chat_session_id
chat_sessions.teleconsultation_id
chemo_administrations.cycle_id
chemo_administrations.protocol_drug_id
chemo_cycles.plan_id
chemo_protocol_drugs.protocol_id
chemo_treatment_plans.protocol_id
claim_denials.invoice_id
clinical_ai_acuity_staffing_forecasts.generation_id
clinical_ai_agent_health_reports.agent_registry_id
clinical_ai_agent_health_reports.generation_id
clinical_ai_antimicrobial_reviews.generation_id
clinical_ai_appeal_letters.claim_id
clinical_ai_appeal_letters.generation_id
clinical_ai_appeal_letters.prior_auth_id
clinical_ai_bed_turnover_predictions.generation_id
clinical_ai_biomed_maintenance_predictions.device_id
clinical_ai_biomed_maintenance_predictions.generation_id
clinical_ai_blood_bank_forecast_reviews.generation_id
clinical_ai_chart_gap_audits.generation_id
clinical_ai_command_center_snapshots.generation_id
clinical_ai_decision_memory.generation_id
clinical_ai_decision_memory.review_id
clinical_ai_ed_triage_predictions.generation_id
clinical_ai_explainability_reports.generation_id
clinical_ai_explainability_reports.source_generation_id
clinical_ai_family_updates.generation_id
clinical_ai_family_updates.source_generation_id
clinical_ai_federation_rounds.generation_id
clinical_ai_imaging_findings.study_id
clinical_ai_infection_control_audits.generation_id
clinical_ai_inventory_alerts.generation_id
clinical_ai_kg_edges.from_node_id
clinical_ai_kg_edges.to_node_id
clinical_ai_kg_health_reports.generation_id
clinical_ai_lab_autoverifications.generation_id
clinical_ai_lab_autoverifications.investigation_id
clinical_ai_labeling_annotations.generation_id
clinical_ai_labeling_annotations.task_id
clinical_ai_model_eval_runs.generation_id
clinical_ai_model_eval_runs.model_registry_id
clinical_ai_obstetric_risk_assessments.generation_id
clinical_ai_operational_alerts.generation_id
clinical_ai_ot_block_suggestions.generation_id
clinical_ai_pathway_bundle_audits.generation_id
clinical_ai_patient_timeline_snapshots.generation_id
clinical_ai_payer_variance_reviews.claim_id
clinical_ai_payer_variance_reviews.contract_id
clinical_ai_payer_variance_reviews.generation_id
clinical_ai_pediatric_dose_checks.generation_id
clinical_ai_pgx_advisories.generation_id
clinical_ai_policy_diffs.generation_id
clinical_ai_privacy_sentinel_audits.generation_id
clinical_ai_procurement_opportunities.generation_id
clinical_ai_prompt_assignments.experiment_id
clinical_ai_prompt_assignments.generation_id
clinical_ai_prompt_experiments.variant_a_prompt_id
clinical_ai_prompt_experiments.variant_b_prompt_id
clinical_ai_radiology_report_reviews.generation_id
clinical_ai_radiology_worklist_priorities.generation_id
clinical_ai_reviews.generation_id
clinical_ai_safety_reviews.generation_id
clinical_ai_security_anomalies.generation_id
clinical_ai_sepsis_bundle_audits.generation_id
clinical_ai_staff_burnout_reviews.generation_id
clinical_ai_synthetic_cases.generation_id
clinical_ai_task_candidates.generation_id
clinical_ai_teach_back_sessions.generation_id
clinical_ai_teach_back_sessions.source_generation_id
clinical_ai_training_modules.generation_id
clinical_ai_translations.source_generation_id
clinical_ai_ventilator_bundle_audits.generation_id
clinical_ai_voice_ivr_sessions.generation_id
clinical_ai_workflow_runs.parent_run_id
clinical_alerts.source_vitals_chart_id
clinical_continuity_paper_items.fact_id
clinical_continuity_patient_merge_decisions.merge_request_id
clinical_continuity_reconciliation_items.task_id
clinical_continuity_replay_effect_evidence.retrospective_fact_id
clinical_continuity_temporary_identities.merge_request_id
clinical_document_extraction_events.intake_id
clinical_document_intake.generation_id
clinical_notes.appointment_id
clinical_notes.parent_note_id
clinical_nursing_ambient_sessions.generation_id
clinical_order_set_applications.order_set_id
clinical_order_set_items.order_set_id
clinical_order_sets.import_batch_id
clinical_order_sets.superseded_by
clinical_trial_match_results.trial_id
cold_chain_blood_bank_review_flags.excursion_id
cold_chain_blood_bank_review_flags.unit_id
cold_chain_excursions.sla_instance_id
cold_chain_excursions.task_id
cold_chain_excursions.unit_id
cold_chain_readings.device_registry_id
cold_chain_readings.unit_id
cold_chain_units.biomed_device_id
cold_chain_units.device_registry_id
cold_chain_units.location_id
component_preparations.donation_event_id
component_preparations.donor_id
component_preparations.parent_unit_id
consent_signatures.consent_id
credential_document_uploads.staff_credential_id
credential_expiry_alerts.staff_credential_id
ctvs_case_overlays.anesthesia_record_id
ctvs_case_overlays.created_by
ctvs_case_overlays.evidence_owner_uid
ctvs_case_overlays.ot_schedule_id
ctvs_case_overlays.patient_uid
ctvs_case_overlays.updated_by
data_breaches.dpa_id
data_retention_policies.data_processing_activity_id
dental_procedures.finding_id
dental_tooth_findings.resolved_by_procedure_id
developer_portal_audit_events.api_client_id
developer_portal_audit_events.api_key_id
device_patient_associations.bed_id
device_patient_associations.device_registry_id
device_patient_associations.patient_uid
device_presence_logs.admission_id
device_presence_logs.patient_uid
device_registry.biomed_device_id
device_registry.location_id
device_vital_sample_observations.device_registry_id
device_vital_sample_observations.patient_uid
device_vital_suppression_counters.device_registry_id
device_vitals_control_ids.device_registry_id
device_vitals_control_ids.interface_message_id
dialysis_intra_obs.session_id
dialysis_machine_qa_logs.session_id
dialysis_prescriptions.dialysis_patient_id
dialysis_serology.dialysis_patient_id
dialysis_session_events.session_id
dialysis_sessions.dialysis_patient_id
dialysis_sessions.prescription_id
dialysis_sessions.vascular_access_id
dialyzer_reuse_register.dialysis_patient_id
dialyzer_reuse_register.session_id
dietary_meal_tickets.admission_id
dietary_meal_tickets.diet_order_id
dietary_meal_tickets.patient_uid
discharge_consults.admission_id
discharge_summary_sections.discharge_summary_id
doctors.user_id
donation_events.camp_id
donation_events.donor_id
donation_events.last_tti_test_id
donation_events.screening_id
donor_consents.donor_id
donor_deferrals.donor_id
donor_deferrals.screening_id
donor_screenings.donor_id
downtime_snapshots.ward_id
drug_composition_curation_queue.catalog_id
drug_return_lines.batch_id
ed_closure_evidence.ambulance_request_id
ed_closure_evidence.death_record_id
ed_closure_evidence.medication_reconciliation_id
ed_closure_evidence.mlc_record_id
ed_closure_evidence.patient_merge_request_id
ed_encounter_evidence.audit_event_id
ed_encounter_evidence.device_registry_id
ed_encounter_evidence.device_vital_sample_observation_id
ed_encounter_evidence.emergency_visit_id
ed_encounter_evidence.patient_uid
ed_encounter_evidence.timeline_event_id
ed_encounter_evidence.vitals_chart_id
ed_injury_diagram_attachments.audit_event_id
ed_injury_diagram_attachments.emergency_visit_id
ed_injury_diagram_attachments.mlc_record_id
ed_injury_diagram_attachments.patient_uid
ed_injury_diagram_attachments.trauma_survey_record_id
encryption_keys.rotated_from
engagement_audience_snapshots.campaign_id
engagement_campaign_recipients.audience_snapshot_id
engagement_campaign_recipients.campaign_id
engagement_campaign_recipients.consent_id
engagement_campaign_recipients.outbox_id
engagement_campaigns.template_id
engagement_follow_up_events.loop_id
engagement_follow_up_loops.appointment_id
engagement_follow_up_steps.loop_id
engagement_follow_up_steps.staff_task_id
engagement_suppression_events.campaign_id
engagement_templates.notification_template_id
facility_locations.parent_id
facility_rooms.location_id
family_members.linked_dependent_uid
family_members.patient_uid
federated_identities.provider_id
feedback_nps_responses.appointment_id
feedback_nps_responses.consent_id
feedback_nps_responses.feedback_id
feedback_nps_responses.patient_uid
fhir_vital_observation_sets.vitals_chart_id
follow_up_plans.care_plan_id
full_final_settlements.staff_uid
geofence_breaches.staff_id
geofence_breaches.staff_uid
hai_cases.admission_id
hai_cases.infection_case_id
hai_cases.patient_uid
hand_hygiene_moments.audit_id
help_center_categories.parent_category_id
housekeeping_logs.staff_id
housekeeping_logs.staff_uid
housekeeping_logs.verified_by
housekeeping_logs.verified_by_uid
housekeeping_logs.zone_id
housekeeping_request_recipients.request_id
housekeeping_request_recipients.staff_id
housekeeping_request_recipients.staff_uid
housekeeping_request_updates.author_id
housekeeping_request_updates.author_uid
housekeeping_request_updates.request_id
housekeeping_requests.assigned_by
housekeeping_requests.assigned_by_uid
housekeeping_requests.assigned_to
housekeeping_requests.assigned_to_uid
housekeeping_requests.bed_id
housekeeping_requests.requester_id
housekeeping_requests.requester_uid
housekeeping_requests.verified_by
housekeeping_requests.verified_by_uid
housekeeping_requests.zone_id
hr_activity_logs.staff_id
icu_assessments.icu_admission_id
icu_chart_audit_events.icu_admission_id
icu_chart_audit_events.patient_uid
icu_daily_bundles.icu_admission_id
icu_device_observation_links.device_association_id
icu_device_observation_links.device_registry_id
icu_device_observation_links.icu_admission_id
icu_device_observation_links.patient_uid
icu_device_observation_links.sample_observation_id
icu_device_observation_links.vitals_chart_id
icu_flowsheet_entries.icu_admission_id
icu_line_tube_drain_events.admission_id
icu_line_tube_drain_events.device_presence_log_id
icu_line_tube_drain_events.icu_admission_id
icu_line_tube_drain_events.patient_uid
icu_scoring_outputs.icu_admission_id
icu_scoring_outputs.patient_uid
icu_scoring_outputs.policy_version_id
icu_ventilation_episodes.admission_id
icu_ventilation_episodes.icu_admission_id
icu_ventilation_episodes.patient_uid
icu_weaning_trials.icu_admission_id
icu_weaning_trials.patient_uid
icu_weaning_trials.ventilation_episode_id
identity_audit_events.provider_id
identity_saml_replay_cache.provider_id
incident_reports.assigned_to
incident_reports.patient_uid
incident_reports.reporter_id
incident_reports.resolved_by
instrument_sets.current_sterilization_load_id
instrument_sets.last_passed_load_id
insurance_claim_caps.claim_id
insurance_claim_caps.tpa_claim_id
insurance_claims.parent_claim_id
insurance_policies.payer_id
insurance_policies.tpa_id
insurance_preauth.parent_preauth_id
insurance_preauth.policy_id
insurance_preauth_responses.preauth_id
integration_credentials.integration_id
integration_logs.integration_id
intraop_notes.ot_schedule_id
investigation_booking_history.booking_id
investigation_bookings.appointment_id
investigation_bookings.investigation_id
investigation_bookings.patient_id
investigation_bookings.phlebotomist_id
investigations.patient_id
investigations.requested_by
investment_declarations.staff_uid
isolation_order_checklist_items.isolation_order_id
isolation_orders.admission_id
isolation_orders.infection_case_id
isolation_orders.patient_uid
isolation_orders.terminal_clean_request_id
knowledge_access_policies.knowledge_base_id
knowledge_chunks.document_id
knowledge_chunks.knowledge_base_id
knowledge_documents.knowledge_base_id
knowledge_import_batches.knowledge_base_id
knowledge_retrieval_logs.chunk_id
knowledge_retrieval_logs.knowledge_base_id
lab_analyzer_qc_runs.analyzer_id
lab_analyzers.location_id
lab_interface_messages.analyzer_id
lab_interface_messages.specimen_id
lab_results.analyzer_id
lab_results.investigation_id
lab_results.qc_run_id
lab_results.specimen_id
lab_specimen_status_history.specimen_id
learning_assignments.module_id
learning_completions.assignment_id
learning_completions.module_id
leave_applications.staff_id
leave_encashments.fnf_id
leave_encashments.payslip_id
leave_encashments.staff_uid
ledger_balances.account_id
ledger_entries.reverses_entry_id
ledger_postings.account_id
ledger_postings.entry_id
linen_laundry_cycle_items.cycle_id
linen_laundry_cycle_items.item_type_id
linen_laundry_cycles.housekeeping_request_id
linen_laundry_cycles.ward_id
linen_ward_par_levels.item_type_id
linen_ward_par_levels.last_cycle_id
linen_ward_par_levels.ward_id
maternity_anc_visits.pregnancy_id
maternity_apgar_scores.newborn_id
maternity_deliveries.labor_admission_id
maternity_deliveries.pregnancy_id
maternity_fetal_kicks.pregnancy_id
maternity_labor_admissions.pregnancy_id
maternity_newborns.delivery_id
maternity_partograph_entries.labor_admission_id
maternity_postnatal_visits.delivery_id
maternity_postnatal_visits.newborn_id
maternity_supplements.pregnancy_id
medical_records.created_by
medical_records.deleted_by
medical_records.doctor_id
medical_records.patient_id
medical_records.updated_by
medication_reconciliation_items.reconciliation_id
medication_reconciliation_items.safety_review_id
medication_reminders.patient_uid
mfa_backup_codes.mfa_device_id
mfa_challenges.mfa_device_id
micro_isolates.order_id
micro_sensitivities.isolate_id
migration_acceptance_reports.commit_batch_id
migration_acceptance_reports.job_id
migration_commit_batches.job_id
migration_commit_records.commit_batch_id
migration_commit_records.import_record_id
migration_commit_records.job_id
migration_hl7_adt_batches.job_id
migration_hl7_adt_messages.commit_batch_id
migration_hl7_adt_messages.hl7_batch_id
migration_import_records.job_id
migration_import_records.mapping_profile_id
migration_import_records.source_file_id
migration_merge_queue_items.commit_batch_id
migration_merge_queue_items.import_record_id
migration_merge_queue_items.job_id
migration_rehearsal_reports.job_id
migration_source_files.job_id
migration_validation_findings.import_record_id
migration_validation_findings.job_id
migration_validation_findings.source_file_id
mis_report_deliveries.schedule_id
mlc_completeness_audit_events.actor_uid
mlc_completeness_audit_events.mlc_completeness_review_id
mlc_completeness_audit_events.mlc_record_id
mlc_completeness_audit_events.patient_uid
mlc_completeness_reviews.audit_event_id
mlc_completeness_reviews.certificate_signer_uid
mlc_completeness_reviews.emergency_visit_id
mlc_completeness_reviews.mlc_record_id
mlc_completeness_reviews.patient_uid
mlc_completeness_reviews.reviewed_by_uid
mlc_completeness_reviews.timeline_event_id
mlc_records.emergency_visit_id
mortality_reviews.death_record_id
mortuary_slots.current_death_record_id
mortuary_slots.location_id
newborn_immunisations.newborn_id
newborn_immunisations.vaccine_catalogue_id
news2_scores.superseded_by_id
news2_scores.vitals_chart_id
nhcx_messages.claim_id
nhcx_messages.policy_id
nhcx_messages.preauth_id
nicu_admission_newborn_links.icu_admission_id
nicu_admission_newborn_links.newborn_id
nicu_admission_newborn_links.patient_uid
nicu_cardiorespiratory_events.device_registry_id
nicu_cardiorespiratory_events.icu_admission_id
nicu_cardiorespiratory_events.patient_uid
nicu_cardiorespiratory_events.sample_observation_id
nicu_feed_fluid_entries.admission_id
nicu_feed_fluid_entries.device_registry_id
nicu_feed_fluid_entries.icu_admission_id
nicu_feed_fluid_entries.patient_uid
nicu_feed_fluid_entries.sample_observation_id
nicu_jaundice_phototherapy_events.device_registry_id
nicu_jaundice_phototherapy_events.icu_admission_id
nicu_jaundice_phototherapy_events.patient_uid
nicu_jaundice_phototherapy_events.sample_observation_id
nicu_picu_scoring_outputs.icu_admission_id
nicu_picu_scoring_outputs.patient_uid
nicu_picu_scoring_outputs.score_definition_id
nicu_respiratory_support_observations.device_registry_id
nicu_respiratory_support_observations.icu_admission_id
nicu_respiratory_support_observations.patient_uid
nicu_respiratory_support_observations.sample_observation_id
nicu_respiratory_support_observations.ventilation_episode_id
nicu_thermal_environment_observations.device_registry_id
nicu_thermal_environment_observations.icu_admission_id
nicu_thermal_environment_observations.patient_uid
nicu_thermal_environment_observations.sample_observation_id
notification_events.notification_id
nuclear_medicine_orders.appointment_id
nuclear_medicine_orders.canonical_timeline_event_id
nuclear_medicine_orders.encounter_id
nuclear_medicine_orders.patient_uid
nuclear_medicine_orders.referral_id
oncology_diagnoses.canonical_timeline_event_id
oncology_diagnoses.encounter_id
oncology_diagnoses.pathology_case_id
oncology_diagnoses.pathology_report_id
oncology_registry_exports.clinical_audit_event_id
oncology_staging_records.canonical_timeline_event_id
oncology_staging_records.diagnosis_id
oncology_staging_records.encounter_id
oncology_toxicity_events.canonical_timeline_event_id
oncology_toxicity_events.chemo_administration_id
oncology_toxicity_events.chemo_cycle_id
oncology_toxicity_events.chemo_plan_id
oncology_toxicity_events.diagnosis_id
oncology_toxicity_events.encounter_id
ophthalmic_biometry.appointment_id
ophthalmic_biometry.encounter_id
ophthalmic_biometry.exam_id
ophthalmic_exams.appointment_id
ophthalmic_exams.encounter_id
ophthalmic_imaging_attachments.exam_id
ophthalmic_refractions.exam_id
order_set_review_events.order_set_id
outbreak_episode_cases.admission_id
outbreak_episode_cases.episode_id
outbreak_episode_cases.infection_case_id
outbreak_episode_cases.patient_uid
overtime_requests.approved_by
overtime_requests.approved_by_uid
overtime_requests.staff_id
overtime_requests.staff_uid
package_items.package_id
patient_access_audit_log.break_glass_id
patient_access_audit_log.care_team_id
patient_access_break_glass_status_history.break_glass_id
patient_chat_messages.conversation_id
patient_flow_checkins.appointment_id
patient_flow_checkins.kiosk_session_id
patient_flow_checkins.patient_uid
patient_flow_checkins.queue_id
patient_immunisations.newborn_immunisation_id
patient_immunisations.vaccine_catalogue_id
patient_merge_requests.candidate_id
patient_message_threads.related_invoice_id
patient_messages.thread_id
patient_records.patient_id
payer_tariff_links.payer_id
payer_tariff_links.tariff_plan_id
payer_tariff_links.tpa_id
payment_transactions.invoice_id
payroll_runs.generated_by
payroll_runs.locked_by
payslip_queries.payslip_id
payslip_query_replies.query_id
pcpndt_form_f.machine_id
pcpndt_form_f.sonologist_id
perfusion_device_links.created_by
perfusion_device_links.device_patient_association_id
perfusion_device_links.patient_uid
perfusion_device_links.perfusion_record_id
perfusion_records.anesthesia_record_id
perfusion_records.ctvs_case_overlay_id
perfusion_records.evidence_owner_uid
perfusion_records.ot_schedule_id
perfusion_records.patient_uid
perfusion_records.perfusionist_uid
perfusion_records.recorded_by
perfusion_signoffs.anesthesia_reviewed_by
perfusion_signoffs.evidence_owner_uid
perfusion_signoffs.finalized_by
perfusion_signoffs.ot_schedule_id
perfusion_signoffs.patient_uid
perfusion_signoffs.perfusion_record_id
perfusion_signoffs.perfusionist_signed_by
perfusion_signoffs.surgeon_reviewed_by
pharmacy_counter_sale_allocations.counter_sale_line_id
pharmacy_counter_sale_allocations.inventory_batch_id
pharmacy_counter_sale_allocations.movement_id
pharmacy_counter_sale_allocations.return_movement_id
pharmacy_counter_sale_lines.counter_sale_id
pharmacy_counter_sale_lines.inventory_item_id
pharmacy_counter_sales.invoice_id
pharmacy_counter_sales.patient_uid
pharmacy_counter_sales.void_refund_id
pharmacy_expiry_alerts.inventory_batch_id
pharmacy_expiry_alerts.inventory_item_id
pharmacy_goods_receipt_items.goods_receipt_id
pharmacy_goods_receipt_items.inventory_batch_id
pharmacy_goods_receipt_items.inventory_item_id
pharmacy_goods_receipt_items.purchase_order_item_id
pharmacy_goods_receipts.purchase_order_id
pharmacy_goods_receipts.supplier_id
pharmacy_inventory_batches.inventory_item_id
pharmacy_inventory_batches.supplier_id
pharmacy_inventory_items.catalog_id
pharmacy_inventory_items.default_supplier_id
pharmacy_order_history.changed_by
pharmacy_order_history.order_id
pharmacy_orders.dispensed_by
pharmacy_orders.patient_id
pharmacy_orders.prescribed_by
pharmacy_purchase_order_items.inventory_item_id
pharmacy_purchase_order_items.purchase_order_id
pharmacy_purchase_orders.supplier_id
pharmacy_stock_movements.inventory_batch_id
pharmacy_stock_movements.inventory_item_id
pharmacy_substitutes.primary_item_id
pharmacy_substitutes.substitute_item_id
physio_assessments.care_plan_id
physio_assessments.follow_up_plan_id
physio_assessments.referral_id
physio_outcome_scores.assessment_id
physio_outcome_scores.care_plan_id
physio_outcome_scores.session_id
physio_sessions.assessment_id
physio_sessions.care_plan_id
physio_sessions.follow_up_plan_id
pmjay_cases.beneficiary_id
pmjay_cases.package_id
porter_transport_task_recipients.staff_id
porter_transport_task_recipients.staff_uid
porter_transport_task_recipients.task_id
porter_transport_task_updates.author_id
porter_transport_task_updates.author_uid
porter_transport_task_updates.task_id
porter_transport_tasks.accepted_by
porter_transport_tasks.admission_id
porter_transport_tasks.appointment_id
porter_transport_tasks.assigned_porter_id
porter_transport_tasks.assigned_porter_uid
porter_transport_tasks.cancelled_by
porter_transport_tasks.completed_by
porter_transport_tasks.created_by
porter_transport_tasks.destination_zone_id
porter_transport_tasks.patient_uid
porter_transport_tasks.picked_up_by
porter_transport_tasks.pickup_zone_id
porter_transport_tasks.requested_by
porter_transport_tasks.requester_id
porter_transport_tasks.sla_instance_id
porter_transport_tasks.updated_by
porter_transport_tasks.verified_by
porter_transport_tasks.verifier_id
porter_transport_zone_assignments.assigned_by
porter_transport_zone_assignments.staff_id
porter_transport_zone_assignments.staff_uid
porter_transport_zone_assignments.zone_id
postop_complication_alerts.ot_schedule_id
postop_notes.ot_schedule_id
prehospital_device_links.ambulance_request_id
prehospital_device_links.device_patient_association_id
prehospital_device_links.device_registry_id
prehospital_device_links.handover_id
prehospital_handover_acceptances.handover_id
prehospital_handover_events.handover_id
prehospital_handovers.ambulance_request_id
prehospital_handovers.emergency_visit_id
prehospital_handovers.partner_config_id
preop_checklists.ot_schedule_id
prescription_safety_overrides.prescription_id
provider_availability_template_audit.template_id
provider_availability_template_exceptions.template_id
provider_availability_templates.room_resource_id
queue_display_profiles.department_id
radiation_oncology_referrals.canonical_timeline_event_id
radiation_oncology_referrals.diagnosis_id
radiation_oncology_referrals.encounter_id
radiation_oncology_referrals.patient_uid
radiation_oncology_referrals.staging_record_id
radiation_safety_evidence.clinical_audit_event_id
radiation_safety_evidence.related_nuclear_order_id
radiation_safety_evidence.related_plan_ref_id
radiation_safety_evidence.related_referral_id
radioisotope_administration_records.canonical_timeline_event_id
radioisotope_administration_records.encounter_id
radioisotope_administration_records.order_id
radioisotope_administration_records.patient_uid
radiology_orders.template_id
radiology_peer_reviews.radiology_order_id
radiotherapy_fraction_schedules.appointment_id
radiotherapy_fraction_schedules.canonical_timeline_event_id
radiotherapy_fraction_schedules.encounter_id
radiotherapy_fraction_schedules.patient_uid
radiotherapy_fraction_schedules.plan_ref_id
radiotherapy_fraction_schedules.referral_id
radiotherapy_plan_refs.canonical_timeline_event_id
radiotherapy_plan_refs.encounter_id
radiotherapy_plan_refs.patient_uid
radiotherapy_plan_refs.referral_id
referrals.accepted_by
referrals.patient_uid
referrals.referred_to_doctor
referrals.referring_doctor
remote_prescriptions.teleconsultation_id
report_updates.author_id
research_crf_forms.registry_id
research_crf_responses.enrollment_id
research_crf_responses.form_id
research_enrollments.match_id
research_enrollments.registry_id
research_registries.trial_id
resource_bookings.resource_id
resuscitation_device_links.clinical_alert_id
resuscitation_device_links.device_association_id
resuscitation_device_links.device_registry_id
resuscitation_device_links.patient_uid
resuscitation_device_links.resuscitation_event_id
resuscitation_device_links.timeline_entry_id
resuscitation_device_links.vitals_chart_id
resuscitation_event_timeline.patient_uid
resuscitation_event_timeline.resuscitation_event_id
resuscitation_events.admission_id
resuscitation_events.emergency_visit_id
resuscitation_events.encounter_id
resuscitation_events.patient_uid
resuscitation_events.trigger_clinical_alert_id
resuscitation_events.trigger_vitals_chart_id
resuscitation_medication_links.mar_administration_id
resuscitation_medication_links.patient_uid
resuscitation_medication_links.resuscitation_event_id
resuscitation_medication_links.timeline_entry_id
resuscitation_qa_reviews.patient_uid
resuscitation_qa_reviews.resuscitation_event_id
resuscitation_team_roles.patient_uid
resuscitation_team_roles.resuscitation_event_id
salary_advances.approved_by
salary_advances.staff_uid
salary_arrears.payslip_id
salary_arrears.revision_id
salary_arrears.staff_uid
salary_revisions.admin_signed_by
salary_revisions.hr_signed_by
salary_revisions.proposed_by
salary_revisions.rejected_by
salary_revisions.staff_uid
scheduling_overbook_audit_events.appointment_id
scheduling_overbook_audit_events.policy_id
scheduling_resource_compatibility.resource_id
scheduling_resource_compatibility.template_id
set_issue_log.instrument_set_id
set_issue_log.ot_schedule_id
set_issue_log.sterilization_load_id
siem_export_delivery_attempts.event_id
siem_export_delivery_attempts.target_id
smart_access_tokens.authz_code_id
smart_access_tokens.parent_token_id
smart_access_tokens.smart_app_id
smart_authz_codes.smart_app_id
smart_launch_contexts.smart_app_id
staff.user_id
staff_attendance.staff_id
staff_breaks.attendance_id
staff_breaks.staff_id
staff_breaks.staff_uid
staff_commute_profile_audit.commute_profile_id
staff_credentials.privilege_catalog_id
staff_grievances.assigned_to
staff_grievances.reporter_id
staff_grievances.resolved_by
staff_leave_forecast_audit.run_id
staff_leave_forecast_runs.generation_id
staff_leave_forecast_scores.run_id
staff_leave_forecast_shift_risks.run_id
staff_message_attachments.message_id
staff_message_attachments.thread_id
staff_message_thread_participants.thread_id
staff_messages.thread_id
staff_onboarding_tasks.staff_id
staff_performance_reviews.staff_id
staff_salary.staff_uid
staff_shift_roster_assignment_audit.assignment_id
staff_shift_roster_assignment_audit.roster_id
staff_shift_roster_assignments.roster_id
staff_shift_swap_request_audit.swap_request_id
staff_shift_swap_requests.counterparty_assignment_id
staff_shift_swap_requests.requester_assignment_id
stemi_activations.canonical_audit_event_id
stemi_activations.canonical_timeline_event_id
stemi_activations.cath_case_id
stemi_activations.emergency_visit_id
stemi_activations.encounter_id
stemi_activations.patient_uid
stemi_activations.prehospital_handover_id
stemi_pathway_events.activation_id
stemi_pathway_events.canonical_audit_event_id
stemi_pathway_events.canonical_timeline_event_id
stemi_pathway_events.encounter_id
stemi_pathway_events.patient_uid
stemi_pathway_events.workflow_sla_instance_id
stemi_team_notifications.activation_id
stemi_team_notifications.canonical_audit_event_id
stemi_team_notifications.canonical_timeline_event_id
stemi_team_notifications.notification_outbox_id
stemi_team_notifications.staff_id
stemi_team_notifications.staff_uid
stroke_activations.canonical_timeline_event_id
stroke_activations.encounter_id
stroke_activations.patient_uid
stroke_nihss_assessments.activation_id
stroke_nihss_assessments.canonical_timeline_event_id
stroke_nihss_assessments.encounter_id
stroke_nihss_assessments.patient_uid
stroke_pathway_events.activation_id
stroke_pathway_events.canonical_timeline_event_id
stroke_pathway_events.encounter_id
stroke_pathway_events.patient_uid
stroke_thrombolysis_decisions.activation_id
stroke_thrombolysis_decisions.canonical_timeline_event_id
stroke_thrombolysis_decisions.encounter_id
stroke_thrombolysis_decisions.patient_uid
surgical_implants.cath_case_id
surgical_implants.cath_usage_id
surgical_implants.ot_schedule_id
surgical_safety_checklists.ot_schedule_id
tariff_items.tariff_plan_id
teleconsultations.appointment_id
tenant_idp_role_mappings.provider_id
tour_events.tour_id
tpa_claim_correspondence.claim_id
tpa_claim_correspondence.preauth_id
tpa_claim_documents.claim_id
tpa_claim_documents.preauth_id
tpa_claim_line_decisions.claim_id
tpa_claim_line_decisions.invoice_item_id
tpa_claims.invoice_id
tpa_claims.parent_claim_id
tpa_claims.policy_id
tpa_claims.preauth_id
tpas.parent_payer_id
transfusion_reactions.request_id
transfusion_reactions.unit_id
transfusion_verifications.request_id
transfusion_verifications.unit_id
transplant_candidates.program_id
transplant_candidates.related_care_plan_id
transplant_committee_reviews.candidate_id
transplant_committee_reviews.program_id
transplant_donor_referrals.program_id
transplant_immunosuppression_plans.candidate_id
transplant_match_reviews.candidate_id
transplant_match_reviews.donor_referral_id
transplant_notto_exports.candidate_id
transplant_notto_exports.program_id
transplant_waitlist_status_history.candidate_id
transplant_waitlist_status_history.committee_review_id
trauma_activation_team_roles.trauma_activation_id
trauma_activations.admission_id
trauma_activations.audit_event_id
trauma_activations.emergency_visit_id
trauma_activations.patient_uid
trauma_activations.timeline_event_id
trauma_survey_records.audit_event_id
trauma_survey_records.emergency_visit_id
trauma_survey_records.patient_uid
trauma_survey_records.timeline_event_id
trauma_survey_records.trauma_activation_id
trauma_timeline_events.audit_event_id
trauma_timeline_events.emergency_visit_id
trauma_timeline_events.patient_uid
trauma_timeline_events.timeline_event_id
trauma_timeline_events.trauma_activation_id
triage_assessments.emergency_visit_id
tti_tests.donation_event_id
tti_tests.donor_id
tti_tests.repeat_parent_id
tumor_board_cases.ap_report_id
tumor_board_cases.canonical_timeline_event_id
tumor_board_cases.diagnosis_id
tumor_board_cases.meeting_id
tumor_board_cases.radiology_order_id
tumor_board_cases.staging_record_id
tumor_board_recommendations.canonical_timeline_event_id
tumor_board_recommendations.chemo_plan_id
tumor_board_recommendations.tumor_board_case_id
users.guardian_user_id
vascular_access.dialysis_patient_id
video_sessions.teleconsultation_id
virtual_ward_check_ins.enrollment_id
virtual_ward_escalations.check_in_id
virtual_ward_escalations.enrollment_id
ward_indent_items.ward_indent_id
ward_indents.ward_id
wards.department_id
webhook_deliveries.subscription_id
webhook_subscriptions.integration_id
webhook_subscriptions.signing_credential_id
`;

function parseExemptionBlock(block) {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

const DEFERRED_LIST = parseExemptionBlock(DEFERRED_PAYMENT_GATEWAY_AND_SMS);
const LEGACY_LIST = parseExemptionBlock(LEGACY_BASELINE);
const EXEMPTIONS = new Set([...DEFERRED_LIST, ...LEGACY_LIST]);

// ---------------------------------------------------------------------------

describe('tenant-bearing FK invariant, asserted against the current schema', () => {
  test('schema.prisma parses into the shape the schema-derived checks depend on', () => {
    // A parser that silently matched nothing would make the `@@unique` and
    // tenant-DEFAULT assertions vacuously pass.
    expect(MODELS.size).toBeGreaterThan(800);
    expect(TENANT_BEARING.size).toBeGreaterThan(800);
    expect(TENANT_BEARING.has('appointments')).toBe(true);
    expect(TENANT_BEARING.has('abdm_patient_share_intakes')).toBe(true);
    // Global reference data must not be counted as tenant-bearing, or the
    // census would demand a tenant column that does not exist.
    expect(TENANT_BEARING.has('investigation_test_catalog')).toBe(false);
    expect(TENANT_BEARING.has('drug_kb_sources')).toBe(false);
  });

  test('the live FK catalog loads into the shape the census depends on', () => {
    // The reason this file was rewritten a second time: a census that reads
    // nothing makes the violation test below pass on every possible input.
    // Nothing here may be inferred from the catalog itself — each bound is a
    // floor the migrated database has already cleared.
    expect(TENANT_BEARING_TABLES.size).toBeGreaterThan(800);
    expect(FOREIGN_KEYS.length).toBeGreaterThan(2000);
    expect(singleColumnTenantBearingFks().length).toBeGreaterThan(900);
    expect(TENANT_BEARING_TABLES.has('appointments')).toBe(true);
    expect(TENANT_BEARING_TABLES.has('abdm_patient_share_intakes')).toBe(true);
    // Global reference data carries no tenant column and must not be counted.
    expect(TENANT_BEARING_TABLES.has('investigation_test_catalog')).toBe(false);
    expect(TENANT_BEARING_TABLES.has('drug_kb_sources')).toBe(false);
    // Composite keys must survive the read intact, or every converted key
    // would read back as a violation.
    expect(foreignKeysOf('referrals').find((fk) => fk.fields.includes('appointment_id')))
      .toMatchObject({ fields: ['tenant_id', 'appointment_id'], target: 'appointments' });
  });

  test('no tenant-bearing table reaches another one through a new single-column FK', () => {
    const offenders = singleColumnTenantBearingFks()
      .filter((fk) => !EXEMPTIONS.has(fk.key))
      .map((fk) => `${fk.key} -> ${fk.target}(${fk.references.join(', ')})  [${fk.line}]`);

    // Each of these lets a row in tenant A name a parent owned by tenant B.
    // Convert it to FOREIGN KEY (tenant_id, <col>) REFERENCES <parent>
    // (tenant_id, id) — adding the parent-side (tenant_id, id) unique first if
    // it has none, and naming the column on any ON DELETE SET NULL because
    // tenant_id is NOT NULL. The alternative is a line on the exemption list
    // above, which needs a written reason beside it.
    expect(offenders).toEqual([]);
  });

  test('every exemption still names a real single-column FK, so the list cannot go stale', () => {
    const live = new Set(singleColumnTenantBearingFks().map((fk) => fk.key));
    const stale = [...EXEMPTIONS].filter((key) => !live.has(key)).sort();

    // A converted FK must have its exemption pruned in the same change.
    // Leaving the line behind would let the same defect return at the same
    // address and hide behind it.
    expect(stale).toEqual([]);
  });

  test('the exemption list has no duplicate or overlapping entries', () => {
    const combined = [...DEFERRED_LIST, ...LEGACY_LIST];
    const seen = new Set();
    const duplicates = combined.filter((key) => (seen.has(key) ? true : (seen.add(key), false)));
    expect(duplicates).toEqual([]);
    expect(EXEMPTIONS.size).toBe(combined.length);
  });
});

describe('the keys migration 729 converted are composite in the current schema', () => {
  // Asserted through the live catalog rather than 729's SQL text: this stays
  // true only while the live DDL stays converted, and would fail if a later
  // migration reverted one. The referential actions are named as the DDL
  // names them, not in Prisma's `SetNull`/`NoAction` spelling, because
  // pg_constraint is now what answers.
  const CONVERTED = [
    {
      model: 'abdm_patient_share_intakes',
      constraint: 'fk_abdm_share_intake_linked_appointment',
      fields: ['tenant_id', 'linked_appointment_id'],
      target: 'appointments',
      onDelete: 'SET NULL',
    },
    {
      model: 'abdm_hiu_fetch_sessions',
      constraint: 'fk_abdm_hiu_fetch_consent_artifact',
      fields: ['tenant_id', 'consent_artifact_id'],
      target: 'abdm_consent_artifacts',
      onDelete: 'SET NULL',
    },
    {
      model: 'abdm_hiu_fetch_sessions',
      constraint: 'fk_abdm_hiu_fetch_data_transfer',
      fields: ['tenant_id', 'data_transfer_id'],
      target: 'abdm_data_transfers',
      onDelete: 'SET NULL',
    },
    {
      model: 'uhi_transactions',
      constraint: 'fk_uhi_txn_appointment',
      fields: ['tenant_id', 'appointment_id'],
      target: 'appointments',
      onDelete: 'SET NULL',
    },
    {
      model: 'drug_kb_catalog_links',
      constraint: 'fk_drug_kb_catalog_links_catalog',
      fields: ['tenant_id', 'pharmacy_catalog_id'],
      target: 'pharmacy_catalog',
      onDelete: 'CASCADE',
    },
  ];

  test.each(CONVERTED)(
    '$constraint carries the tenant into the key',
    ({ model, constraint, fields, target, onDelete }) => {
      const rel = foreignKeysOf(model).find((r) => r.constraint === constraint);
      expect(rel).toBeDefined();
      expect(rel.fields).toEqual(fields);
      expect(rel.references).toEqual(['tenant_id', 'id']);
      expect(rel.target).toBe(target);
      expect(rel.onDelete).toBe(onDelete);
      // Re-homing a parent row to another tenant must fail while children
      // exist, rather than silently dragging them across the boundary.
      expect(rel.onUpdate).toBe('NO ACTION');
    },
  );

  test('each parent 729 widened publishes the (tenant_id, id) unique its key targets', () => {
    for (const [model, indexName] of [
      ['pharmacy_catalog', 'ux_pharmacy_catalog_tenant_id'],
      ['abdm_consent_artifacts', 'ux_abdm_consent_artifacts_tenant_id'],
      ['abdm_data_transfers', 'ux_abdm_data_transfers_tenant_id'],
    ]) {
      expect(MODELS.get(model)).toContain(
        `@@unique([tenant_id, id], map: "${indexName}")`,
      );
    }
  });
});

describe('a composite tenant-bearing FK never uses a bare ON DELETE SET NULL', () => {
  // A bare SET NULL on a composite FK nulls EVERY referencing column, and
  // tenant_id is NOT NULL — so deleting the parent fails with 23502 instead of
  // orphaning the child (the bug 706 was written to fix). PostgreSQL 15+
  // accepts a column list; this rule applies to every migration file, present
  // and future, so a new one written the old way fails here.
  const CLAUSE =
    /(?:CONSTRAINT\s+([A-Za-z0-9_]+)\s+)?FOREIGN\s+KEY\s*\(\s*tenant_id\s*,[^)]*\)\s*REFERENCES\s+[A-Za-z0-9_."]+\s*(?:\([^)]*\))?\s*((?:ON\s+(?:DELETE|UPDATE)\s+(?:NO\s+ACTION|RESTRICT|CASCADE|SET\s+DEFAULT|SET\s+NULL(?:\s*\([^)]*\))?)\s*)*)/gi;

  /**
   * Both entries predate the rule and are already corrected forward by a later
   * migration; the test below proves that correction still exists rather than
   * taking the claim on trust.
   */
  const CORRECTED_FORWARD = [
    { file: '702_abdm_patient_share_intakes.sql', constraint: 'fk_abdm_share_intake_patient' },
    { file: '704_facility_asset_register.sql', constraint: 'fk_facility_asset_events_asset' },
  ];

  function migrationFiles() {
    return fs
      .readdirSync(migrationsDir)
      .filter((name) => /^\d{3}_.*\.sql$/.test(name))
      .sort();
  }

  function readMigration(name) {
    return fs.readFileSync(path.join(migrationsDir, name), 'utf8');
  }

  /** Comments quote SQL freely; scanning them produces phantom findings. */
  function stripSqlComments(sql) {
    return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  }

  function bareCompositeSetNulls() {
    const found = [];
    for (const name of migrationFiles()) {
      const sql = stripSqlComments(readMigration(name));
      let match;
      CLAUSE.lastIndex = 0;
      while ((match = CLAUSE.exec(sql)) !== null) {
        if (/ON\s+DELETE\s+SET\s+NULL(?!\s*\()/i.test(match[2] || '')) {
          found.push({ file: name, constraint: match[1] || null });
        }
      }
    }
    return found;
  }

  test('the clause scanner actually matches the corpus', () => {
    // Guards against a regex that quietly stops matching and turns the rule
    // below into a no-op.
    let clauses = 0;
    for (const name of migrationFiles()) {
      const sql = stripSqlComments(readMigration(name));
      CLAUSE.lastIndex = 0;
      while (CLAUSE.exec(sql) !== null) clauses += 1;
    }
    expect(clauses).toBeGreaterThan(400);
  });

  test('no migration declares one outside the two corrected-forward exemptions', () => {
    const exempt = new Set(CORRECTED_FORWARD.map((e) => `${e.file}:${e.constraint}`));
    const offenders = bareCompositeSetNulls()
      .map((hit) => `${hit.file}:${hit.constraint}`)
      .filter((key) => !exempt.has(key));
    expect(offenders).toEqual([]);
  });

  test('each exempt clause is rebuilt with a column list by a later migration', () => {
    for (const { file, constraint } of CORRECTED_FORWARD) {
      const from = Number(file.slice(0, 3));
      const fixes = migrationFiles()
        .filter((name) => Number(name.slice(0, 3)) > from)
        .filter((name) => {
          const sql = stripSqlComments(readMigration(name));
          const rebuild = new RegExp(
            `ADD\\s+CONSTRAINT\\s+${constraint}\\b[\\s\\S]{0,400}?ON\\s+DELETE\\s+SET\\s+NULL\\s*\\(`,
            'i',
          );
          return rebuild.test(sql);
        });
      expect(fixes.length).toBeGreaterThan(0);
    }
  });
});

describe('the legacy hardcoded tenant DEFAULT stays retired', () => {
  const DEFAULT_TENANT_UUID = '00000000-0000-4000-8000-000000000001';

  // Broadened from the single exact literal the first version of this file
  // matched. That string pinned one rendering — `::uuid` lower case, exactly
  // one space after DEFAULT — so the same default spelled `::UUID`, wrapped
  // across lines, or written as a CAST walked straight past the census.
  // Anchoring on DEFAULT immediately before the literal is what keeps the
  // GUC-reading COALESCE out: that idiom carries the very same UUID as its
  // fallback ARGUMENT, and is the correct form, not a violation.
  const HARDCODED_DEFAULT =
    /DEFAULT\s+(?:'00000000-0000-4000-8000-000000000001'\s*(?:::\s*uuid)?|CAST\s*\(\s*'00000000-0000-4000-8000-000000000001'\s+AS\s+uuid\s*\))/i;

  function readMigration(name) {
    return fs.readFileSync(path.join(migrationsDir, name), 'utf8');
  }

  test('the broadened pattern accepts the spellings the old exact-string check missed', () => {
    expect(HARDCODED_DEFAULT.test(`DEFAULT '${DEFAULT_TENANT_UUID}'::uuid`)).toBe(true);
    expect(HARDCODED_DEFAULT.test(`DEFAULT '${DEFAULT_TENANT_UUID}'::UUID`)).toBe(true);
    expect(HARDCODED_DEFAULT.test(`DEFAULT   '${DEFAULT_TENANT_UUID}' :: uuid`)).toBe(true);
    expect(HARDCODED_DEFAULT.test(`DEFAULT\n  '${DEFAULT_TENANT_UUID}'`)).toBe(true);
    expect(HARDCODED_DEFAULT.test(`DEFAULT CAST('${DEFAULT_TENANT_UUID}' AS uuid)`)).toBe(true);
    // The GUC-reading idiom names the same UUID as its fallback and must not
    // be flagged.
    expect(
      HARDCODED_DEFAULT.test(
        `DEFAULT COALESCE((NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid, '${DEFAULT_TENANT_UUID}'::uuid)`,
      ),
    ).toBe(false);
  });

  test('no migration numbered 400 or above declares it, apart from the corrected 721', () => {
    // Migrations are applied once and tracked, so a published file is never
    // edited in place — 721 keeps the hardcoded default it shipped with and
    // 729 corrects the column forward. It is the ONLY grandfathered entry; a
    // new one means a fresh table shipped with the legacy idiom.
    const GRANDFATHERED = new Set(['721_lab_analyzer_code_mappings.sql']);
    const offenders = fs
      .readdirSync(migrationsDir)
      .filter((name) => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) >= 400)
      .filter((name) => HARDCODED_DEFAULT.test(readMigration(name)))
      .filter((name) => !GRANDFATHERED.has(name));

    expect(offenders).toEqual([]);
  });

  test('only the four pre-400 tables still carry it in the live schema', () => {
    // The migration-text check above cannot see the accumulated result, and
    // the accumulated result is what actually governs an INSERT that omits
    // tenant_id: it lands on the default tenant and then trips the table's own
    // RLS WITH CHECK as a 42501 rather than a useful error.
    const carriers = [...MODELS]
      .filter(([, body]) => {
        const field = body.split('\n').find((line) => /^\s*tenant_id\s+\S/.test(line));
        return Boolean(field) && field.includes(DEFAULT_TENANT_UUID) && !/COALESCE/i.test(field);
      })
      .map(([name]) => name)
      .sort();

    expect(carriers).toEqual([
      'appointment_archive', // 346
      'ledger_accounts', // 342
      'ledger_balances', // 345
      'reconciliation_checks', // 349
    ]);
  });

  test('lab_analyzer_code_mappings now reads the request tenant from the GUC', () => {
    const body = MODELS.get('lab_analyzer_code_mappings');
    expect(body).toBeDefined();
    expect(body).toMatch(
      /tenant_id\s+String\s+@default\(dbgenerated\("COALESCE\(\(NULLIF\(NULLIF\(current_setting\('app\.current_tenant_id'::text, true\), ''::text\), 'bypass'::text\)\)::uuid, '00000000-0000-4000-8000-000000000001'::uuid\)"\)\)/,
    );
  });
});
