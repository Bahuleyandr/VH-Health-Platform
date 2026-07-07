# NL-9 Engagement CRM Design

- Program: NL-9 Engagement CRM
- Status: survey-grounded design specification only
- Date: 2026-07-07
- Scope of this PR: documentation only; no migrations, code, seed data, generated schemas, or app assets

## Recommendation

Build NL-9 as a consent-first engagement spine that reuses the existing notification outbox, feedback, teleconsult, device gateway, and health-points substrates instead of creating a parallel communications product. The implementation should add per-tenant engagement settings, campaign/audience/recipient ledgers, NPS hardening, RPM enrollment/program tables, follow-up-loop records, and loyalty rule extensions in later code PRs. This design PR uses no migration numbers.

The roadmap defines NL-9 as "smart recall/outreach campaigns on WhatsApp rails, NPS analytics, RPM/home health program (device kit + `rpm agent` module), teleconsult follow-up loops, loyalty deepening (health points)" (`docs/NEXT_LEVEL_ROADMAP.md:216-218`). The same roadmap keeps AI decision support tenant-flagged and keeps patient-facing generation off until the required pilot evidence exists (`docs/NEXT_LEVEL_ROADMAP.md:21-22`). NL-9 should therefore be operational engagement, not autonomous patient-facing medicine.

## Invariants

1. **Consent gates every outbound patient touch.** Outbound campaign, recall, RPM, follow-up, NPS, WhatsApp, SMS, email, push, and voice delivery must check a current, tenant-scoped consent record before materializing a recipient. The existing `patient_consents` table records `patient_uid`, `consent_type`, `granted`, `status`, `granted_at`, `revoked_at`, `expires_at`, `purpose`, `data_categories`, and `version` (`apps/backend/src/migrations/000_baseline.sql:13494-13514`). The existing consent middleware also fails closed without tenant context (`apps/backend/src/middleware/consentMiddleware.js:80-86`) and queries active consent by patient, consent type, tenant, granted state, and non-revoked status (`apps/backend/src/middleware/consentMiddleware.js:88-97`).

2. **Outbound content is template-bound and PHI-minimized.** Campaigns may only use approved templates whose variables come from an allowlist per campaign type. Patient-facing message bodies must not include diagnosis text, raw lab values, inpatient note content, clinician free text, or AI-generated explanations. The current WhatsApp sender already redacts phone and body in logger mode and uses Twilio only when the production provider and credentials are configured (`apps/backend/src/utils/notifications/sendWhatsAppNotification.js:64-89`); NL-9 must preserve that discipline at the campaign layer.

3. **Tenant settings are explicit and disabled by default.** Campaign engines, NPS sends, RPM outreach, teleconsult follow-up loops, and loyalty marketing must be enabled per tenant with an acceptance snapshot. Migration 351 is the local pattern: a per-tenant settings table exists because global feature flags were insufficient, and the table carries `tenant_id`, `enabled`, `enabled_at`, `enabled_by`, and `acceptance_snapshot` (`apps/backend/src/migrations/351_composition_search_settings.sql:1-16`). NL-9 should copy this shape, including RLS/tenant isolation policy (`apps/backend/src/migrations/351_composition_search_settings.sql:18-25`).

4. **Rate limits are tenant-aware and channel-aware.** The current limiter keys include tenant identity (`apps/backend/src/middleware/rateLimitMiddleware.js:64-69`) and support tenant overrides from `tenants.settings.rateLimits[profile]` (`apps/backend/src/middleware/rateLimitMiddleware.js:133-170`). NL-9 must add campaign-level caps on top of those HTTP/API limiters: per-tenant daily send caps, per-patient cooldowns, channel quiet hours, retry caps, and an emergency brake.

5. **The notification outbox remains the delivery queue, not the engagement source of truth.** The outbox exists to persist send intent before delivery and support retry (`apps/backend/src/utils/notifications/notificationOutbox.js:11-18`). Its `queue` call stores type, recipient, phone, title, body, data, and channel in `notification_outbox` (`apps/backend/src/utils/notifications/notificationOutbox.js:22-37`), and the drain claims due rows for delivery (`apps/backend/src/utils/notifications/notificationOutbox.js:134-143`). It has no `tenant_id` column by design today (`apps/backend/src/migrations/320_notification_outbox_drain.sql:32-34`), so NL-9 campaign/audience/recipient tables must carry tenant identity and only use the outbox as the final send rail.

6. **NL-7 owns device ingestion transport.** RPM/home-health must not build another device gateway, public ingest route, vendor cloud bridge, or unauthenticated device API. The device gateway already forwards to backend `/api/v1/devices/vitals/resolve` and `/api/v1/devices/vitals/ingest` (`apps/device-gateway/src/backendClient.js:18-35`); the backend only accepts `patient_uid` from `DEVICE_GATEWAY` callers (`apps/backend/src/routes/emr/deviceVitalsRoutes.js:54-67`); and the service explicitly never guesses a patient from bed/location context (`apps/backend/src/services/emr/deviceVitalsService.js:3-7`).

7. **AI remains governed decision support.** The inventory has 99 governed modules, with patient-facing modules deliberately off by policy (`docs/CLINICAL_AI_MODULE_INVENTORY.md:10-14`, `docs/CLINICAL_AI_MODULE_INVENTORY.md:111-123`). Patient-facing modules must stay off pending an explicit go-patient-facing decision (`docs/CLINICAL_AI_MODULE_INVENTORY.md:247-252`). The roadmap calls out an `rpm agent`, but the current inventory exposes `virtual_ward_triage` as the nearest home-monitoring decision-support module (`docs/CLINICAL_AI_MODULE_INVENTORY.md:234`). NL-9 must register any future RPM agent through the same governed module and review path.

8. **Teleconsult follow-up stays appointment-bound.** NL-3 keeps teleconsults inside ordinary OP doctor/department queues, routes media through backend-minted tokens, and returns documentation to the OP note editor with OP-compatible params rather than new teleconsult note types (`apps/staff/CLAUDE.md:160-167`). Follow-up loops may schedule operational reminders and tasks, but they must not create parallel note, prescription, or consult documentation surfaces.

9. **Loyalty points are not medical advice.** Health points can reward completion, adherence, or education behaviors, but must not imply clinical safety, diagnose, triage, or pressure care choices. The current point engine is idempotent per activity/ref/tenant (`apps/backend/src/services/gamification/pointService.js:10-33`) and already distinguishes reward eligibility for step awards from self-declared entries (`apps/backend/src/services/gamification/pointService.js:235-265`); NL-9 should extend those controls instead of weakening them.

## Existing Substrate Verified

### Roadmap and Governance

- NL-9 is explicitly a CRM/engagement program with smart recall/outreach, WhatsApp rails, NPS analytics, RPM/home health, teleconsult follow-up loops, and health points (`docs/NEXT_LEVEL_ROADMAP.md:216-218`).
- Clinical AI remains per-tenant flagged, decision-support-only, and held off for patient-facing generation without pilot evidence (`docs/NEXT_LEVEL_ROADMAP.md:21-22`).
- The governed AI inventory marks patient-facing modules as built but off, including Voice Patient Assistant / IVR, Patient Communication Translation, and Virtual Ward Triage (`docs/CLINICAL_AI_MODULE_INVENTORY.md:113-123`).
- Deep-tier modules can fall back to deterministic templates unless deep-tier configuration and GPU support are present; callers must confirm `used_ai:true` before treating output as model-generated (`docs/CLINICAL_AI_MODULE_INVENTORY.md:82`). Engagement automation must therefore not depend on model output for delivery correctness.

### Notification, WhatsApp, and Template Rails

- Supported tenant notification channels already include push, email, in-app, WhatsApp, voice, SMS, and print (`apps/backend/src/utils/notifications/tenantNotificationChannels.js:1-8`).
- The dispatcher has a WhatsApp branch that requires a phone and sends title plus body (`apps/backend/src/utils/notifications/notificationDispatcher.js:117-127`) and an SMS fallback path that queues to the outbox (`apps/backend/src/utils/notifications/notificationDispatcher.js:149-166`).
- Preferred-channel mapping already supports app, SMS, print, and none (`apps/backend/src/utils/notifications/notificationDispatcher.js:200-217`). NL-9 can add campaign preferences and suppression decisions above this layer.
- The baseline schema has `notification_outbox` (`apps/backend/src/migrations/000_baseline.sql:12744-12761`) and `notification_templates` with title and message templates, type, priority, variables, and active status (`apps/backend/src/migrations/000_baseline.sql:12782-12797`).
- Scheduled notifications already exist and were introduced to send feedback requests two hours after appointment completion via a five-minute cron (`apps/backend/src/migrations/104_scheduled_notifications.sql:1-6`). That is a useful narrow precursor, not a full campaign engine.

### Consent Rails

- The consent table has enough fields to support engagement consent, but NL-9 needs precise consent types such as `marketing_whatsapp`, `care_reminder_whatsapp`, `rpm_monitoring`, `nps_survey`, and `teleconsult_followup` rather than one broad "engagement" grant (`apps/backend/src/migrations/000_baseline.sql:13494-13514`).
- Consent checks are audited with patient UID, consent type, and whether consent was found (`apps/backend/src/middleware/consentMiddleware.js:123-125`).
- The voice patient assistant already classifies consent freshness as missing, stale, fresh, or unknown (`apps/backend/src/services/ai/voicePatientAssistantIvrService.js:280-291`), which is the right vocabulary for campaign preflight and follow-up delivery.

### Feedback and NPS

- The current `feedback` table supports patient UID, phone, 1-5 rating, comment, category, department, doctor, appointment, anonymity, status, timestamps, and response status (`apps/backend/src/migrations/000_baseline.sql:9023-9039`).
- Patient and staff feedback routes include `/my-feedback`, `/my-stats`, `/dashboard`, `/recent`, `/analytics`, `/report`, feedback creation, and `/quick-rating` (`apps/backend/src/routes/feedbackRoutes.js:39-63`).
- The feedback service already returns average ratings, positive/negative/neutral buckets, category breakdowns, satisfaction trends, and recent feedback severity (`apps/backend/src/services/feedback/feedbackService.js:58-132`, `apps/backend/src/services/feedback/feedbackService.js:200-207`, `apps/backend/src/services/feedback/feedbackService.js:312-333`).
- The operational AI service expects `feedback.nps_score` for patient feedback summaries (`apps/backend/src/services/ai/tierHOperationalService.js:259-263`), and the Tier H module registration describes NPS-band shifts and recurring complaints (`apps/backend/src/migrations/139_tier_h_operational_forecasting_modules.sql:42-52`). A repo-wide search found `nps_score` only in that service and its unit test, not in migrations (`apps/backend/src/services/ai/tierHOperationalService.js:259`, `apps/backend/src/tests/unit/tierHOperationalService.test.js:174`). NL-9 must therefore add or verify the NPS field/schema before enabling NPS analytics.
- AI feedback summaries must never include patient names or phones (`apps/backend/src/services/ai/tierHOperationalService.js:269-274`), and sentiment classification must set `redact_flag` when PHI shapes are detected (`apps/backend/src/services/ai/tierHOperationalService.js:294-299`).

### RPM and Device/Home-Health Substrate

- The device gateway exists as an app whose package describes "MLLP ingress, durable spool, backend drain" (`apps/device-gateway/package.json:2-6`).
- The backend device route exposes `POST /api/v1/devices/vitals/ingest`, `GET /vitals/unverified`, verification, resolve, and association endpoints (`apps/backend/src/routes/emr/deviceVitalsRoutes.js:3-6`, `apps/backend/src/routes/emr/deviceVitalsRoutes.js:89-110`, `apps/backend/src/routes/emr/deviceVitalsRoutes.js:146-157`).
- NL-7's design holds device data inside the cluster, without external broker/cloud dependency; the gateway has no public ingress (`docs/superpowers/specs/2026-07-06-nl7-device-iot-gateway-design.md:224-230`).
- NL-7 already defines gateway metrics such as spool depth, oldest age, forward failures, and dead letters (`docs/superpowers/specs/2026-07-06-nl7-device-iot-gateway-design.md:234-238`) and PHI handling rules for raw device messages (`docs/superpowers/specs/2026-07-06-nl7-device-iot-gateway-design.md:242-245`).
- The RPM agent should be a clinical operations wrapper over enrollments, trends, escalation tasks, and Virtual Ward Triage style decision support. It must not own transport, raw parsing, device identity, or patient-device association.

### Teleconsult Follow-Up Substrate

- NL-3 chose LiveKit, appointment-bound teleconsult rows, short-TTL join tokens, explicit remote consent before join, and secure-message fallback tied to appointments (`docs/superpowers/specs/2026-07-05-nl3-teleconsultation-design.md:42`, `docs/superpowers/specs/2026-07-05-nl3-teleconsultation-design.md:95-98`, `docs/superpowers/specs/2026-07-05-nl3-teleconsultation-design.md:132-149`).
- Teleconsult AI loads tenant-scoped consults and chat transcripts (`apps/backend/src/services/ai/teleconsultAiService.js:65-87`), writes clinical AI reviews (`apps/backend/src/services/ai/teleconsultAiService.js:192-199`), and returns `decision_support_only: true` (`apps/backend/src/services/ai/teleconsultAiService.js:221-233`).
- Teleconsult note drafts include `plan.follow_up`, but the prompt explicitly says not to invent measurements or findings (`apps/backend/src/services/ai/teleconsultAiService.js:292-299`). NL-9 follow-up loops can read signed/approved follow-up facts, but they must not send unreviewed draft text.
- Patient routes already include appointment lobby and consult paths (`apps/patient/lib/core/navigation/app_router.dart:335-356`), join tokens (`apps/patient/lib/features/teleconsult/services/teleconsult_repository.dart:53-55`), and appointment-bound fallback messaging (`apps/patient/lib/features/teleconsult/services/teleconsult_repository.dart:66-72`).

### Loyalty and Patient Engagement Surfaces

- The patient app already exposes notifications, feedback history, and health points routes (`apps/patient/lib/core/navigation/app_router.dart:300`, `apps/patient/lib/core/navigation/app_router.dart:541`, `apps/patient/lib/core/navigation/app_router.dart:590-591`).
- Deep links are allowlisted for patient routes such as appointments, notifications, feedback history, ask-a-doubt, and health points; crafted notification routes must start with `/` and pass the allowlist (`apps/patient/lib/core/services/deep_link_service.dart:18-39`, `apps/patient/lib/core/services/deep_link_service.dart:84-89`).
- The dashboard health points widget shows total points, current tier, progress to next tier, and unclaimed rewards (`apps/patient/lib/features/dashboard/widgets/health_points_widget.dart:5-30`).
- The Health Points screen fetches `/gamification/summary`, `/gamification/milestones`, and wellness/steps surfaces, and can claim milestone rewards (`apps/patient/lib/features/gamification/screens/health_points_screen.dart:97-101`, `apps/patient/lib/features/gamification/screens/health_points_screen.dart:129-144`, `apps/patient/lib/features/gamification/screens/health_points_screen.dart:248`).
- Backend gamification routes cover summary, milestones, milestone claiming, and daily check-ins (`apps/backend/src/routes/gamification/gamificationRoutes.js:37-58`). The controller resolves tenant context for summary, milestone claims, wellness, insights, and check-ins (`apps/backend/src/controllers/gamification/gamificationController.js:13-22`, `apps/backend/src/controllers/gamification/gamificationController.js:126-144`, `apps/backend/src/controllers/gamification/gamificationController.js:192-233`).
- Baseline gamification tables include `health_milestone_claims`, `health_milestones`, and `health_point_ledger` (`apps/backend/src/migrations/000_baseline.sql:9397-9407`, `apps/backend/src/migrations/000_baseline.sql:9431-9441`, `apps/backend/src/migrations/000_baseline.sql:9468-9478`).

## Workstream Designs

### 1. Campaigns and Recall on WhatsApp Rails

**Product shape**

Create an admin/staff campaign builder for care reminders and recall campaigns, not open-ended marketing blasts. P1 campaign types:

- Appointment recall: missed appointment, due follow-up, chronic clinic revisit, vaccination visit, lab-review visit.
- Medication and prescription refill nudges, only when based on an existing prescription/refill workflow and approved template.
- Preventive care campaigns, only from tenant-approved cohort rules and approved template categories.
- RPM enrollment/re-engagement reminders, only for patients already enrolled or explicitly consented to RPM invitation outreach.
- NPS and feedback request campaigns, only after an eligible encounter and outside quiet hours.

**Data model additions**

Implementation should add 5-6 campaign foundation migrations:

1. `engagement_settings`: one row per tenant, disabled by default, copying the migration-351 pattern with `enabled`, `enabled_at`, `enabled_by`, `acceptance_snapshot`, channel caps, quiet hours, default consent-type mapping, and emergency stop.
2. `engagement_templates`: approved engagement template metadata that references existing `notification_templates` rather than duplicating message bodies. Add `template_kind`, `channel`, `approved_by`, `approved_at`, `variables_schema`, `phi_classification`, `locale`, and `retired_at`.
3. `engagement_campaigns`: tenant-scoped campaign header with `campaign_type`, `objective`, `status`, `template_id`, `channels`, `schedule_policy`, `rate_policy`, `created_by`, `approved_by`, and `approved_at`.
4. `engagement_audience_snapshots`: immutable cohort snapshot with cohort SQL/hash or source descriptor, materialized counts, eligibility counts, suppressed counts, source tables touched, and minimum cohort-size guard.
5. `engagement_campaign_recipients`: per-patient send ledger with patient UID, consent reference, channel, contact route, due time, status, suppression reason, outbox ID, idempotency key, retry count, and delivery audit metadata.
6. `engagement_suppression_events`: opt-out, complaint, cooldown, duplicate, deceased, tenant-emergency-stop, and manual suppression records. This table is also the audit anchor for why a patient did not receive a message.

Do not add another delivery queue. Delivery remains: campaign recipient due -> fresh consent check -> suppression/rate check -> `notification_outbox` row -> dispatcher -> provider. The campaign recipient row stores tenant and campaign context; the outbox stores delivery intent.

**State machine**

`draft -> dry_run -> pending_approval -> scheduled -> running -> paused -> completed -> archived`, with `cancelled` from any non-terminal state.

Rules:

- `draft` may edit copy and audience.
- `dry_run` materializes counts only; no outbox rows.
- `pending_approval` freezes template and audience hash.
- `scheduled/running` may not widen the audience; only pause, cancel, or reduce.
- Every transition writes an audit event with tenant, actor UID, previous status, next status, and reason.

**Consent and contactability**

For each recipient at materialization and again immediately before queueing:

1. Resolve tenant and patient UID.
2. Check required consent type by channel and campaign type. Missing, revoked, expired, stale, or unknown consent suppresses the recipient.
3. Check contact route and patient preference. `preferred_channel = none` suppresses, app-only routes may not leak to WhatsApp/SMS, and WhatsApp requires a normalized phone.
4. Check quiet hours, daily tenant cap, per-patient cooldown, campaign dedupe, and hard suppression list.
5. Queue only a template-bound message with approved variables.

**WhatsApp and SMS copy policy**

Allowed variable examples: first name or neutral salutation, appointment date/time window, clinic/department display name, generic call-to-action link, tenant support phone, opaque appointment/campaign token.

Disallowed variable examples: diagnosis, medication name, lab result, inpatient location, provider note text, AI explanation, raw NPS comment, remote consult transcript, internal queue status. A message may say "Your care team has a follow-up for you" but not "Your HbA1c is high" or "Your doctor noted poor compliance."

### 2. NPS Analytics and Service Recovery

**Product shape**

NPS should be a quality improvement workflow layered onto the existing feedback substrate:

- Patient receives a post-encounter NPS/feedback request after an eligible OP appointment, teleconsult, discharge follow-up, or RPM period milestone.
- Responses store NPS score, optional comment, encounter link, channel, and consent/source metadata.
- Analytics show NPS trend, response rate, promoter/passive/detractor mix, department/doctor/service-line breakdown, and urgent complaint queue.
- Low-score or urgent comments create service-recovery tasks for quality/admin staff, not automated clinical advice.

**Schema prerequisites**

The feedback table does not currently prove an `nps_score` column in migrations, while Tier H reads it. Implementation must first harden the schema by either:

- adding `nps_score smallint` with a 0-10 check constraint to `feedback`, or
- adding a dedicated `feedback_nps_responses` table linked to `feedback`, appointment, teleconsult, admission, or RPM episode.

Recommended: add `feedback_nps_responses` to avoid overloading 1-5 star ratings. Columns: tenant ID, patient UID, feedback ID nullable, encounter type/ref, score 0-10, channel, consent ID, comment ref/redaction metadata, submitted_at, source campaign recipient ID, and dedupe key.

Add 2-3 NPS migrations:

1. `feedback_nps_responses`.
2. `feedback_nps_rollups` for daily/weekly aggregate snapshots by tenant, department, doctor, encounter type, and channel.
3. `feedback_service_recovery_tasks` if no existing task table is suitable; otherwise add a typed task source to the existing operational task surface.

**AI use**

Use `patient_feedback_summary` and `sentiment_analysis` only for staff-facing quality summaries. Model output never feeds patient outbound copy directly. AI summary jobs should include source citations, omit patient names/phones, and keep raw comments behind permissioned drill-down. If `redact_flag` is true, show the feedback in the urgent queue with a redaction warning and require human review before exporting.

**NPS metric definition**

NPS = percentage of promoters minus percentage of detractors, where promoters are 9-10, passives are 7-8, and detractors are 0-6. Report response rate beside every NPS figure. Suppress slices below the tenant minimum sample threshold to reduce re-identification risk.

### 3. RPM and Home-Health Program

**Product shape**

Build RPM as a program enrollment and care-team workflow that sits on top of NL-7 device ingestion and governed AI:

- Staff enrolls a patient into an RPM program with consent, diagnosis/program category, assigned clinician, monitoring window, escalation plan, device kit, and communication plan.
- Device kit provisioning tracks shipped/issued/activated/returned/lost states and associates device identities through the NL-7 device registry/association seam.
- Observations flow through NL-7 and backend device vitals ingestion. NL-9 stores rollups, adherence, patient-reported check-ins, and program status.
- Staff dashboard shows adherence, last reading, trend flags, unresolved alerts, outreach history, and next follow-up.
- Patient app shows enrolled-program status, setup checklist, reading reminders, and contact options; it does not expose raw algorithmic triage claims.

**Data model additions**

Implementation should add 5-6 RPM migrations:

1. `rpm_programs`: tenant program catalog, condition/category, monitoring cadence, reading requirements, default thresholds reference, consent type, escalation policy, active status.
2. `rpm_enrollments`: patient UID, tenant, program ID, enrollment status, start/end dates, assigned team, consent ID, care plan reference, communication preference, and discharge/exit reason.
3. `rpm_device_kits`: enrollment ID, kit status, device registry IDs, shipping/issue/return metadata, activation events, and loss/damage notes.
4. `rpm_observation_rollups`: tenant/patient/enrollment/day or hour grain, expected readings, received readings, last reading time, missing-reading flag, and trend features. Raw device readings stay in NL-7/vitals tables.
5. `rpm_alerts` or typed clinical/operational tasks: missed readings, threshold trends, device offline, patient message requested, escalation state, assigned owner, due time, closed reason.
6. `rpm_agent_reviews`: governed AI review records if a dedicated `rpm_agent` module is registered; otherwise link to existing `clinical_ai_reviews` with `virtual_ward_triage` until a new module is approved.

**RPM agent boundary**

The roadmap names an `rpm agent` module, but the current inventory does not show a literal RPM module. The implementation should register an `rpm_agent` only through the governed module registry, with:

- surface: `virtual_ward` or `home_health`.
- risk: high.
- default: disabled.
- review roles: clinician, RPM nurse, admin.
- output: trend summary, adherence gap, suggested outreach priority, source citations.
- prohibition: no autonomous patient instruction, medication advice, emergency diagnosis, or outbound message drafting.

Until that module exists, use deterministic rules plus the existing `virtual_ward_triage` concept as the design reference. All alerting remains staff-facing.

### 4. Teleconsult Follow-Up Loops

**Product shape**

Create a follow-up-loop layer that listens to approved teleconsult completion facts and schedules consented follow-up touchpoints:

- Follow-up due after teleconsult: collect symptoms/check-in, remind about ordered investigation, prompt prescription pickup/refill, book OP follow-up, or open secure-message fallback.
- Staff sees pending follow-up tasks by patient/appointment/teleconsultation, due date, owner, and status.
- Patient receives only generic, template-bound outreach: "Please complete your follow-up for your recent consultation" with a safe deep link.
- Low-risk automated steps may send reminders; clinical escalation always creates a staff task.

**Data model additions**

Implementation should add 2-3 follow-up migrations:

1. `engagement_follow_up_loops`: tenant, source type/ref (`appointment`, `teleconsultation`, `rpm_enrollment`, `feedback_task`), patient UID, owner, loop type, status, consent type, due policy, and close reason.
2. `engagement_follow_up_steps`: loop ID, step kind, scheduled_at, completed_at, template ID, campaign recipient ID, staff task ID, result, and suppression reason.
3. Optional `engagement_follow_up_answers`: if patient check-ins are structured, store question IDs and coded answers only. Free text should go through existing secure messaging/feedback surfaces, not campaign records.

**Clinical boundary**

Follow-up loops may read signed encounter metadata and explicit follow-up due dates. They may not read or transmit unfinalized note drafts, raw teleconsult transcript text, or AI note draft fields. If `teleconsult_note_draft.plan.follow_up` is useful, it becomes eligible only after clinician approval and mapping into a structured follow-up order/task.

### 5. Loyalty and Health Points Deepening

**Product shape**

Extend health points from a passive dashboard feature into engagement nudges and program milestones:

- Award points for verified actions: completed appointment, on-time arrival, RPM reading adherence, daily check-in, verified step sync, NPS response, completing education material, and claiming a follow-up task.
- Show campaign-driven reward opportunities in the patient app using existing health points routes and deep links.
- Let tenants configure reward campaigns, but keep the core points ledger idempotent and auditable.

**Data model additions**

Implementation should add 2-3 loyalty migrations:

1. `engagement_point_rules`: tenant, rule key, trigger source, points, cooldown, reward eligibility requirements, active status, and audit metadata.
2. `engagement_reward_campaigns`: optional tenant-specific campaigns that bind milestones/rewards to engagement objectives without replacing `health_milestones`.
3. `engagement_point_award_audit`: only if the existing `health_point_ledger` cannot carry enough source metadata; otherwise add nullable engagement source fields in one migration.

**Guardrails**

- No points for self-reported clinical data unless verified or explicitly marked non-reward-eligible.
- No points for actions that could encourage unsafe care deferral or overuse.
- Points do not change clinical prioritization.
- Reward messages must pass the same consent/template/suppression pipeline as other outbound engagement.

## Phased Plan With Migration Counts

### P0 - Specification and Owner Alignment

- Migration count: 0.
- This PR only.
- Confirm owner decisions below: channel policy, consent taxonomy, campaign approvals, RPM pilot scope, NPS metric ownership, and reward economics.

### P1 - Engagement Foundation and Consent-Safe Campaigns

- Estimated migrations: 5-6.
- Add `engagement_settings`, `engagement_templates`, `engagement_campaigns`, `engagement_audience_snapshots`, `engagement_campaign_recipients`, and `engagement_suppression_events`.
- Implement dry-run counts, approval workflow, recipient materialization, consent/suppression checks, rate caps, and outbox queueing.
- Add first campaign types: appointment recall, no-show recall, feedback/NPS request, and generic follow-up reminder.
- Tests must prove missing/revoked/stale consent suppresses recipients and that outbox rows are never created on dry run.

### P2 - NPS Analytics and Service Recovery

- Estimated migrations: 2-3.
- Add NPS response schema, aggregate rollups, and service-recovery tasks or task source integration.
- Wire scheduled post-encounter NPS requests through P1 campaigns.
- Repair the `feedback.nps_score` gap by migrating to a dedicated NPS response table or adding the verified column before enabling Tier H summaries.
- Add dashboard slices with sample-size suppression and response-rate context.

### P3 - Teleconsult Follow-Up Loops

- Estimated migrations: 2-3.
- Add follow-up loop and step tables.
- Integrate with NL-3 teleconsult completion, secure-message fallback, and appointment routes.
- Create staff task and patient safe-link surfaces.
- Keep AI note draft content out of patient outbound copy unless clinician-approved into structured follow-up data.

### P4 - RPM/Home-Health Program

- Estimated migrations: 5-6.
- Add program, enrollment, device kit, rollup, alert/task, and governed-agent review links.
- Reuse NL-7 device gateway ingestion only.
- Register or design the governed `rpm_agent` module disabled-by-default, or explicitly map P4 to `virtual_ward_triage` until the module lands.
- Add nurse/staff RPM dashboard and patient enrollment/setup/check-in surfaces.

### P5 - Loyalty Deepening and Reward Governance

- Estimated migrations: 2-3.
- Add tenant point rules, reward campaigns, and source audit fields as needed.
- Expand patient health-points surfaces for safe reward opportunities.
- Add fraud/eligibility controls for verified actions, cooldowns, and tenant reward budgets.

Total estimated implementation migrations after this docs PR: 16-21, depending on whether existing task/audit tables can be reused for service recovery, RPM alerts, follow-up steps, and point award provenance.

## Test Strategy

### Docs PR Validation

- Run `git diff --check`.
- Confirm the diff is a single docs file under `docs/superpowers/specs/`.

### P1 Campaign Foundation Tests

- Unit: template variable allowlist rejects PHI fields and free-text clinical content.
- Unit: consent resolver returns suppressions for missing, revoked, expired, stale, unknown, and wrong-tenant consent.
- Unit: rate policy enforces tenant daily cap, per-patient cooldown, quiet hours, and emergency stop.
- Unit: idempotency key prevents duplicate recipient and outbox rows.
- Deep/backend: campaign dry run materializes counts only.
- Deep/backend: approved campaign queues outbox rows only for eligible recipients.
- Deep/backend: WhatsApp/SMS/email/push branches preserve template body and campaign metadata without logging PHI.
- Security: tenant A campaign cannot resolve tenant B patients, consents, templates, or recipient rows.

### P2 NPS Tests

- Unit: NPS buckets score 0-6 detractor, 7-8 passive, 9-10 promoter; invalid scores fail.
- Unit: rollup calculates NPS and response rate with sample-size suppression.
- Deep/backend: post-appointment scheduled NPS request checks consent and queues only one request.
- Deep/backend: urgent/low-score response creates exactly one service-recovery task.
- AI/service: patient feedback summary excludes names/phones and preserves citations; sentiment redaction flag is surfaced.
- Regression: existing 1-5 rating flows and quick-rating routes keep working.

### P3 Teleconsult Follow-Up Tests

- Unit: follow-up loop only accepts signed/approved source facts.
- Unit: unreviewed teleconsult AI draft fields cannot become outbound template variables.
- Deep/backend: completed teleconsult creates due follow-up step and safe patient deep link.
- Deep/backend: fallback secure message remains appointment-bound.
- Patient app: appointment detail/lobby/follow-up link paths stay allowlisted.

### P4 RPM Tests

- Unit: enrollment requires consent, active program, assigned team, and monitoring window.
- Unit: device kit lifecycle cannot skip from issued to returned without activation/exception metadata.
- Deep/backend: device reading enters through NL-7 ingest, updates rollup, and creates a staff-facing missed/threshold task.
- Deep/backend: direct non-gateway patient UID ingestion remains rejected.
- AI/service: RPM agent output is staff-facing, cited, disabled by default, and never used as patient message copy.
- Observability: gateway and RPM rollup metrics expose stale-readings, missed-readings, alert counts, and queue age without patient identifiers.

### P5 Loyalty Tests

- Unit: point rule cooldown and tenant scope prevent duplicate awards.
- Unit: self-declared/non-verified inputs cannot earn reward-eligible points.
- Deep/backend: campaign completion or NPS response can award points once when the rule is enabled.
- Patient app: health points summary, milestones, and claim flows remain intact.
- Abuse: reward budget and per-user daily point caps suppress excess awards and audit why.

## Owner Decisions

1. **Consent taxonomy.** Decide whether to add new consent types under `patient_consents` only, or introduce an engagement-specific consent view/table backed by `patient_consents`. Recommended: keep `patient_consents` as source of truth and add narrowly named consent types.
2. **WhatsApp policy and provider.** Confirm which campaign types may use WhatsApp, whether templates must match an approved provider template catalog, and whether Twilio remains the production provider.
3. **Campaign approval authority.** Decide who can approve audience + template combinations: admin only, department admin, quality officer, or doctor owner. Recommended: admin/quality approval for broad campaigns; doctor/team approval for care-team cohorts.
4. **Quiet hours and caps.** Set tenant default quiet hours, per-patient cooldown, daily send cap, and emergency stop owners.
5. **NPS ownership.** Decide whether quality/admin owns NPS rollups and service recovery, or whether department heads get scoped dashboards.
6. **NPS schema choice.** Choose between `feedback.nps_score` column hardening and a dedicated `feedback_nps_responses` table. Recommended: dedicated table.
7. **RPM pilot cohort.** Select first RPM program and device kit scope: hypertension, diabetes, post-discharge vitals, pregnancy BP, or another defined cohort. This drives thresholds, kit contents, and nurse workload.
8. **RPM agent module.** Decide whether to register a new `rpm_agent` module in P4 or keep P4 deterministic with `virtual_ward_triage`-style staff summaries until clinical governance approves a new module.
9. **Teleconsult follow-up triggers.** Decide which completion facts trigger loops: clinician-selected follow-up due date, prescription created, investigation ordered, fallback message unresolved, or patient low NPS after teleconsult.
10. **Reward economics.** Define point value, redemption liability, expiry, and whether tenants can create reward campaigns. Recommended: tenant-configurable rules within platform safety caps.
11. **Patient app copy.** Approve neutral patient-facing wording for recall, follow-up, RPM reminders, NPS, and rewards before any implementation queues outbound messages.

## Source Notes

- The spec surveyed the roadmap and build prompt intent in `docs/NEXT_LEVEL_ROADMAP.md:216-218`.
- Notification design is grounded in existing outbox, dispatcher, channel, WhatsApp, template, and scheduled-notification rails (`apps/backend/src/utils/notifications/notificationOutbox.js:11-18`, `apps/backend/src/utils/notifications/notificationDispatcher.js:117-127`, `apps/backend/src/utils/notifications/tenantNotificationChannels.js:1-8`, `apps/backend/src/migrations/000_baseline.sql:12744-12797`, `apps/backend/src/migrations/104_scheduled_notifications.sql:1-38`).
- Consent design is grounded in `patient_consents` and active-consent checks (`apps/backend/src/migrations/000_baseline.sql:13494-13514`, `apps/backend/src/middleware/consentMiddleware.js:80-97`).
- NPS design is grounded in current feedback routes/service, the baseline feedback table, and the discovered `nps_score` schema gap (`apps/backend/src/migrations/000_baseline.sql:9023-9039`, `apps/backend/src/routes/feedbackRoutes.js:39-63`, `apps/backend/src/services/feedback/feedbackService.js:58-132`, `apps/backend/src/services/ai/tierHOperationalService.js:259-274`).
- RPM design is grounded in the NL-7 device gateway and backend device vitals contract (`apps/device-gateway/src/backendClient.js:18-35`, `apps/backend/src/routes/emr/deviceVitalsRoutes.js:54-67`, `apps/backend/src/services/emr/deviceVitalsService.js:3-7`, `docs/superpowers/specs/2026-07-06-nl7-device-iot-gateway-design.md:224-245`).
- Teleconsult follow-up design is grounded in NL-3's appointment-bound teleconsult design and current patient/backend routes (`docs/superpowers/specs/2026-07-05-nl3-teleconsultation-design.md:95-149`, `apps/backend/src/services/ai/teleconsultAiService.js:221-299`, `apps/patient/lib/features/teleconsult/services/teleconsult_repository.dart:53-72`).
- Loyalty design is grounded in current health points patient surfaces, routes, tables, and point service (`apps/patient/lib/features/gamification/screens/health_points_screen.dart:97-144`, `apps/backend/src/routes/gamification/gamificationRoutes.js:37-58`, `apps/backend/src/migrations/000_baseline.sql:9397-9478`, `apps/backend/src/services/gamification/pointService.js:10-33`).
