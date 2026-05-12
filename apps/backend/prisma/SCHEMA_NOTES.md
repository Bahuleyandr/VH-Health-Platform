# Schema Design Notes

> Context extracted from `apps/backend/prisma/schema.prisma` before the
> 2026-05-12 regeneration via `prisma db pull`. `prisma db pull` strips
> `//` comments, so the design intent / migration references / finding IDs
> that lived in the schema are preserved here instead.

Organized by Prisma model. For each, the doc comments are listed with the
declaration they were attached to. Look these up when touching a model and
you're unsure what the columns mean or which migration added them.

## migrations

## abdm_care_contexts

## abdm_consent_artifacts

## abdm_consent_requests

## abdm_consents

## abdm_data_requests

## abdm_data_transfers

## abdm_facility_mappings

## abdm_practitioner_mappings

## abdm_webhook_events

## abha_profiles

## admin_activity_logs

## admins

## admissions

### from_er_visit_id

ER linkage. When a patient is admitted from the emergency department,
from_er_visit_id points back at emergency_visits.id; er_arrival_at is
the original door-time so SLA / door-to-bed reports don't need a join.
Migration 170. See finding
2026-05-08-emergency-walk-in-doctor-admit-no-er-visit-linkage.

### bed_pending_since

Bedless-emergency tracker. Set when an admission is created without
a bed under the emergency exception (admission_type='emergency' AND
priority='emergent'). Migration 171. Once a bed is assigned later
via /admissions/:id/assign-bed, the bed_transfers row carries the
assignment timestamp; bed_pending_since stays as the historical
anchor for SLA / door-to-bed reports.

### room_category

Agreed-room-category at admit time (migration 177). Tariff +
TPA pre-auth use this, NOT the assigned bed's bed_type, because
the patient is billed at the agreed rate even while waiting for
their preferred category to free up. See finding
2026-05-08-inpatient-admission-admission-no-semiprivate-room-category.

### emergency_consent_bypass_at

B-4 — emergency consent bypass tracking (migration 182). Set when
admitPatient fires under emergency + emergent priority and the
active-treatment-consent check is overridden by implied-consent
doctrine. Powers the post-stabilisation consent-capture worklist.

### discharge_pdf_key

B-6 — discharge summary PDF persistence (migration 183). NULL
until the post-signoff persisted-PDF path runs the first time;
thereafter, the R2 object key for the immutable snapshot.

### discharge_initiated_at

Discharge cascade lifecycle markers (migration 173). T0..T4.
discharged_at (existing) is T4 = patient physically left.

### advance_deposits

IPD support subsystem (migration 174).

## discharge_consults

## advance_deductions

## allergies

## ambulance_requests

## anesthesia_records

## annual_review_reminders

## annual_tax_summaries

## anomalies

## api_access_logs

## api_clients

## api_keys

## appointment_documents

## appointment_status_history

## appointments

## approvals

## attendance_logs

## audit_log

## audit_logs

## auth_logs

## automation_rules

## batch_upload_logs

## bed_transfers

## beds

### admission_id

Denormalized back-link to the active admission. Populated on admit /
assign-bed / transfer; cleared on discharge / transfer-out.
Migration 172. See finding
2026-05-08-inpatient-admission-admission-bed-not-back-linked.

## blood_banks

## blood_requests

## bulk_operation_logs

## bulk_revision_jobs

## canary_checks

## care_plan_activities

## care_plan_goals

## care_plan_review_log

## care_plans

## cds_alerts

## chat_session_messages

## chat_sessions

## claim_denials

## clinical_ai_acuity_staffing_forecasts

## clinical_ai_agent_health_reports

## clinical_ai_agent_registry

## clinical_ai_antimicrobial_reviews

## clinical_ai_appeal_letters

## clinical_ai_approvals

## clinical_ai_bed_forecasts

## clinical_ai_bed_turnover_predictions

## clinical_ai_biomed_devices

## clinical_ai_biomed_maintenance_predictions

## clinical_ai_blood_bank_forecast_reviews

## clinical_ai_blood_bank_inventory_snapshots

## clinical_ai_break_glass_sessions

## clinical_ai_canary_cases

## clinical_ai_canary_runs

## clinical_ai_charge_capture_audits

## clinical_ai_chart_gap_audits

## clinical_ai_command_center_snapshots

## clinical_ai_context_snapshots

## clinical_ai_decision_memory

## clinical_ai_deterioration_snapshots

## clinical_ai_ed_triage_predictions

## clinical_ai_explainability_reports

## clinical_ai_family_updates

## clinical_ai_federation_rounds

## clinical_ai_federation_sites

## clinical_ai_generations

## clinical_ai_guardrails

## clinical_ai_imaging_findings

## clinical_ai_imaging_studies

## clinical_ai_infection_control_audits

## clinical_ai_inventory_alerts

## clinical_ai_kg_edges

## clinical_ai_kg_health_reports

## clinical_ai_kg_nodes

## clinical_ai_lab_autoverifications

## clinical_ai_labeling_annotations

## clinical_ai_labeling_tasks

## clinical_ai_model_eval_runs

## clinical_ai_model_registry

## clinical_ai_modules

## clinical_ai_no_show_predictions

## clinical_ai_obstetric_risk_assessments

## clinical_ai_ot_block_suggestions

## clinical_ai_ot_duration_predictions

## clinical_ai_pathway_bundle_audits

## clinical_ai_patient_genotypes

## clinical_ai_patient_timeline_snapshots

## clinical_ai_payer_contracts

## clinical_ai_payer_variance_reviews

## clinical_ai_pediatric_dose_checks

## clinical_ai_pgx_advisories

## clinical_ai_pharmacy_forecasts

## clinical_ai_policy_diffs

## clinical_ai_polypharmacy_reviews

## clinical_ai_prior_auth_requests

## clinical_ai_privacy_sentinel_audits

## clinical_ai_procurement_opportunities

## clinical_ai_prompt_assignments

## clinical_ai_prompt_experiments

## clinical_ai_prompts

## clinical_ai_radiology_report_reviews

## clinical_ai_radiology_worklist_priorities

## clinical_ai_rca_drafts

## clinical_ai_reviews

## clinical_ai_roi_snapshots

## clinical_ai_safety_reviews

## clinical_ai_security_anomalies

## clinical_ai_self_healing_runs

## clinical_ai_sepsis_bundle_audits

## clinical_ai_staff_burnout_reviews

## clinical_ai_synthetic_cases

## clinical_ai_task_candidates

## clinical_ai_teach_back_sessions

## clinical_ai_tenant_modules

## clinical_ai_training_modules

## clinical_ai_translations

## clinical_ai_trial_sync_runs

## clinical_ai_ventilator_bundle_audits

## clinical_ai_voice_ivr_sessions

## clinical_ai_workflow_runs

## clinical_alerts

## clinical_ambient_encounters

## clinical_document_extraction_events

## clinical_document_intake

## clinical_longitudinal_risk

## clinical_notes

## clinical_nursing_ambient_sessions

## clinical_orders

## clinical_protocols

## clinical_trial_match_results

## clinical_trials_catalog

## clinical_voice_notes

## consultations

## data_breaches

## data_processing_activities

## data_retention_policies

## department_audit_log

## departments

## devices

## diagnoses

## diet_orders

## doctors

### age_range

E-9 — paediatric / adult / all (migration 189). Powers the
/doctors?ageRange=paediatric filter on the paeds OPD list.

## downtime_snapshots

## drug_interactions

## e_prescriptions

## emergency_visits

### admissions

Back-relation for admissions.from_er_visit_id (migration 170).

## encryption_keys

## escalation_rules

## event_outbox

## external_system_mappings

## facilities

## facility_locations

## facility_rooms

## failed_notifications

## fall_risk_assessments

## family_members

## feedback

## file_access_logs

## file_deletion_log

## file_metadata

## follow_up_plans

## full_final_settlements

## gdpr_erasure_log

## growth_charts

## health_milestone_claims

## health_milestones

## health_point_ledger

## health_records

## hipaa_access_log

## hospitals

## hr_activity_logs

## icd10_codes

## icd_cpt_map

## idempotency_keys

## incident_reports

## infection_cases

## insurance_claims

### insurance_claim_caps

A11 — per-category caps (migration 178). Structured equivalent of
the jsonb caps merged into documents by batch 9.

## insurance_claim_caps

### (model-level)

A11 — structured per-category caps for TPA / insurance claims
(migration 178).

## intake_output

## integration_credentials

## integration_logs

## integrations

## intraop_notes

## invalidated_tokens

## investigation_booking_history

## investigation_bookings

## investigation_files

## investigation_template_tests

## investigation_templates

## investigation_test_catalog

## investigations

### previous_results

E-5 — result versioning (migration 185). previous_results holds
an array of prior snapshots; result_version increments on each
re-submit. collected_at + collected_by track the COLLECTED state.

## investment_declarations

## invoices

## leave_applications

## leave_balance_overrides

## leave_encashments

## leave_types

## legal_holds

## medical_activity_logs

## medical_records

## medication_administrations

## medication_reminders

## medications

## mfa_backup_codes

## mfa_challenges

## mfa_devices

## mlc_records

## news2_scores

## notification_delivery_log

## notification_outbox

## notification_templates

## notifications

## numbering_series

## nurse_handovers

## ot_schedules

## otp_logs

## otp_sessions

## package_items

## packages

## pain_assessments

## password_reset_otps

## patient_allergies

## patient_chat_conversations

## patient_chat_messages

## patient_consents

## patient_data_rights_requests

## patient_duplicate_candidates

## patient_feedback

## patient_identifiers

## patient_merge_requests

## patient_records

## patient_vitals

## payer_tariff_links

## payers

## payment_transactions

## payroll_runs

## payslip_queries

## payslip_query_replies

## payslips

## pharmacies

## pharmacy_activity_logs

## pharmacy_catalog

## pharmacy_expiry_alerts

## pharmacy_goods_receipt_items

## pharmacy_goods_receipts

## pharmacy_inventory_batches

## pharmacy_inventory_items

## pharmacy_order_history

## pharmacy_orders

## pharmacy_purchase_order_items

## pharmacy_purchase_orders

## pharmacy_stock_movements

## pharmacy_substitutes

## pharmacy_suppliers

## postop_complication_alerts

## postop_notes

## preop_checklists

## prescription_safety_overrides

## prescriptions

## quality_incidents

## radiology_orders

## referrals

## remote_prescriptions

## replacement_requests

## report_updates

## salary_advances

## salary_arrears

## salary_revisions

## scheduled_notifications

## service_catalog

## sla_definitions

## smart_access_tokens

## smart_apps

## smart_authz_codes

## sos_alerts

## staff

## staff_attendance

## staff_auth_sessions

## staff_devices

## staff_grievances

## staff_messages

## staff_onboarding_tasks

## staff_performance_reviews

## staff_roster_preferences

## staff_roster_runs

## staff_salary

## staff_shift_assignments

## staff_shifts

## step_profiles

## step_rewards

## step_sessions

## surgical_implants

## surgical_safety_checklists

## system_alerts

## tariff_items

## tariff_plans

## task_comments

## tasks

## teleconsult_provider_configs

## teleconsultations

## tenants

## tpas

## triage_assessments

## user_action_logs

## user_deactivation_log

## user_devices

## user_reactivation_log

## user_role_audit

## user_sessions

## user_status_history

## users

### guardian_name

E-9 — guardian fields for paediatric / minor patients (migration 189).
Captured at walk-in registration; updatable via PUT /users/:uid.

## video_sessions

## virtual_ward_check_ins

## virtual_ward_enrollments

## virtual_ward_escalations

## vitals_chart

## wards

### attendant_pass_color

Attendant-pass color + screening level snapshot for the IPD support
subsystem (migration 174). Per project decision 2026-05-09: deluxe /
ICU get distinctive colours + relaxed screening; general wards keep a
generic colour + standard/strict screening.

## advance_deposits

### (model-level)

IPD support subsystem (migration 174). Per project decision 2026-05-09.

advance_deposits — money collected against an admission's eventual
final bill. Receipt series RCT-YYYYMM-NNNN, distinct from invoices.
Refunds are sibling negative-amount rows pointing at parent_deposit_id
so the trail is auditable.

## attendant_passes

### (model-level)

attendant_passes — 2 per admission, auto-issued at admit. Pass color
snapshotted from ward at issue time. Expires at discharge.

## ward_indents

### (model-level)

ward_indents — pharmacy/stores → ward consumables flow.
State machine: requested → approved → issued → received (rejected as terminal).

## ward_indent_items

## webhook_deliveries

## webhook_subscriptions

## workflow_definitions

## workflow_runs

## workflow_steps

## attendance_disputes

## attendance_regularization

## billing_advance_settlements

## billing_advances

## billing_invoice_counter

## billing_invoice_items

## billing_invoices

## billing_payment_links

## billing_payments

## billing_refunds

## billing_service_master

## clinical_order_set_applications

## clinical_order_set_items

## clinical_order_sets

## feature_flags

## geofence_breaches

## housekeeping_logs

## housekeeping_request_updates

## housekeeping_requests

## housekeeping_zones

## insurance_policies

## insurance_preauth

## insurance_preauth_counter

## insurance_preauth_responses

## lab_critical_alerts

## lab_critical_thresholds

## lab_pathologist_signoffs

## lab_results

### panel_id

Panel grouping (architectural item A5 / migration 175). Multiple
analytes from the same panel entry session share a panel_id;
panel_code is the template (CBC | LIPID | RFT | THYROID …) so
reports + trend queries can group by it.

## lab_reference_ranges

### (model-level)

Tenant-configurable normal ranges with sex + age applicability
(architectural item A5 / migration 175). Lookup picks the most
specific match. Critical thresholds co-located so a single read
returns normal + critical bounds for a test.

## maternity_anc_visits

## maternity_apgar_scores

## maternity_deliveries

## maternity_labor_admissions

## maternity_newborns

## maternity_partograph_entries

## maternity_postnatal_visits

## maternity_pregnancies

## or_procedure_catalog

## or_rooms

## overtime_requests

## patient_message_threads

## patient_messages

## pharmacy_expiry_scan_cache

## pharmacy_schedule_register

## smart_phrases

## staff_breaks

## tpa_claim_correspondence

## tpa_claim_counter

## tpa_claim_documents

## tpa_claims
