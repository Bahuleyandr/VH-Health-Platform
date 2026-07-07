# NL-8 Patient-Flow Suite Design

- Date: 2026-07-07
- Program: NL-8 Patient-flow suite
- Status: Design for review - build not started
- Scope: Specification only. This document does not implement application code, database migrations, Kubernetes manifests, or client screens.
- Recommendation: Build NL-8 as five slices on the existing appointment, queue, realtime, housekeeping, scheduling, and clinical-AI substrates: P1 kiosk self-check-in, P2 PHI-free queue displays, P3 porter and patient-transport tasks, P4 scheduling 2.0, and P5 predictive census/LOS on the command centre.

## 1. Context and Binding Invariants

The roadmap asks NL-8 to ship kiosk self-check-in, queue TV token boards, porter/transport tasks, scheduling 2.0, and predictive census/LOS on the command centre (`docs/NEXT_LEVEL_ROADMAP.md:211-214`). The kickoff prompt repeats that scope, requires a docs-only single-file spec, and explicitly bans application code, migrations, and manifests in this PR (`docs/superpowers/build-prompts/wave-c-nl8-kickoff.md:3-5`).

Binding invariants for this design:

1. **Patient identity never forks.** Kiosk flows use the patient Firebase OTP -> backend JWT path, and supervised front-desk flows use the existing receptionist walk-in and duplicate-detection rails. The patient app documents Firebase phone OTP, backend `/auth/firebase/firebase-login`, JWT storage, profile completion, and bearer auth for subsequent API calls (`apps/patient/CLAUDE.md:149-157`); the backend Firebase controller accepts a Firebase `idToken` and returns the backend auth result (`apps/backend/src/controllers/auth/firebaseAuthController.js:8-18`). Front-desk registration is already role-gated and tenant-bound to the authenticated user, not `x-tenant-id` (`apps/backend/src/controllers/appointment/appointmentWorkflowController.js:1207-1232`).
2. **Public displays are PHI-free by default.** The kickoff makes PHI-free token boards a first-class requirement and leaves name-masking policy as an owner decision (`docs/superpowers/build-prompts/wave-c-nl8-kickoff.md:9`). Display payloads therefore expose queue labels, token/visit numbers, room/counter, status, and timestamps, not patient names, phones, identifiers, reasons, or diagnoses.
3. **Canonical timeline rules still apply.** Any successful patient-facing clinical write must commit the detail row, one `clinical_timeline_events` row, one `clinical_audit_events` row, any applicable SLA row, and any medication-safety review in one transaction; failure of any write rolls back the workflow (`docs/CANONICAL_CLINICAL_TIMELINE.md:73-95`). NL-8 check-in and transport detail rows must respect that invariant when they become patient-facing clinical/operational events; pure display refreshes do not create timeline events.
4. **New PHI tables copy the current RLS shape.** Migration 356 shows the required PHI-table pattern: `tenant_id UUID NOT NULL` with the GUC-aware default, tenant FK, ENABLE and FORCE ROW LEVEL SECURITY, and the `tenant_isolation` policy (`apps/backend/src/migrations/356_consent_signatures.sql:13-69`). `_worker-common.md` repeats that new PHI tables must copy the migration-356 boilerplate and write explicit `tenant_id` through `setTenant`/`setTenantTx` (`docs/superpowers/build-prompts/_worker-common.md:46-49`).
5. **Rollout flags are per tenant, not global.** Migration 351 states that the global `feature_flags` table is insufficient for tenant-specific readiness and defines a per-tenant flag table with RLS (`apps/backend/src/migrations/351_composition_search_settings.sql:1-37`). NL-8 rollout settings should copy that pattern for kiosk, public display, porter, scheduling-2.0, and census tiles.
6. **Deploy remains held and zero-inbound.** The playbook says deploy is HELD, everything lands inert/flagged, and new Kubernetes manifests stay unreferenced until the operator track opens (`docs/superpowers/NEXT_LEVEL_EXECUTION_PLAYBOOK.md:63-64`). The platform runs behind Cloudflare Tunnel -> ingress-nginx -> Service with zero inbound firewall ports (`CLAUDE.md:145-151`). NL-8 clients must use existing HTTPS/WSS entrypoints; no new public listener, LAN daemon, or firewall opening belongs in the first build.
7. **Program boundaries are explicit.** NL-7 owns device/LAN transport, NL-9 owns outreach/recall, NL-11 owns white-label/theming, and NL-12 owns the accessibility completion program (`docs/superpowers/build-prompts/wave-c-nl8-kickoff.md:9`, `docs/NEXT_LEVEL_ROADMAP.md:216-232`). NL-8 can define display accessibility contracts and theming seams, but it should not build the shared design system, recall campaigns, device transport layer, or certification-grade accessibility program.

## 2. Existing Substrate Verified

### 2.1 Appointment Queue, Tokens, and Wait Time

The backend already has `appointment_queues` with tenant, queue date, queue kind, department, doctor, status, check-in windows, metadata, queue status history, and `appointments.queue_id` (`apps/backend/src/migrations/260_care_team_patient_access_lab_specimen_qc.sql:32-101`). The queue service derives `queue_kind` from appointment type/department/doctor, reuses or creates the active queue, attaches `queue_id` to the appointment, and writes queue status history on creation (`apps/backend/src/services/appointment/appointmentQueueService.js:47-61`, `apps/backend/src/services/appointment/appointmentQueueService.js:103-220`).

Walk-in registration already creates scoped token numbers and visit numbers before insert, auto-assigns a least-loaded doctor when possible, detects same-day duplicate appointments, inserts the confirmed appointment with tenant and token metadata, and then calls `ensureAppointmentQueueForAppointment` with `source: 'walk_in'` (`apps/backend/src/controllers/appointment/appointmentWorkflowController.js:1857-2034`). Wait-time helpers compute average consult time from status history, calculate patient queue position from token order, and expose token number, queue position, patients ahead, and ETA (`apps/backend/src/services/appointment/waitTimeService.js:14-93`). Queue-position fan-out already recomputes downstream patients on status changes such as in-progress, completed, cancelled, no-show, and rescheduled (`apps/backend/src/controllers/appointment/appointmentStatusController.js:14-15`, `apps/backend/src/controllers/appointment/appointmentStatusController.js:33-49`).

### 2.2 Front-Desk Identity, EMPI, and Patient Auth

The walk-in controller is already heavily hardened for real front-desk intake: it limits registration to receptionist/admission/admin roles, binds created rows to the authenticated tenant, accepts DOB/gender aliases, captures guardian/legal-ID fields, supports unidentified emergency mode, captures payer/category/scheme/lab-only/allergy/chronic-medication fields, and normalizes phones before dedupe/insert (`apps/backend/src/controllers/appointment/appointmentWorkflowController.js:1207-1339`, `apps/backend/src/controllers/appointment/appointmentWorkflowController.js:1423-1540`). Minor registrations require guardian legal ID or a linked adult guardian, and minors using a guardian phone must not merge onto the guardian's patient row (`apps/backend/src/controllers/appointment/appointmentWorkflowController.js:1479-1540`).

The duplicate-detection service is decision-support only, never auto-merges, and routes candidates to an admin-approved merge path (`apps/backend/src/services/patient/patientDedupeService.js:1-18`). Registration duplicate candidates use tenant-scoped patient rows and signals from ABHA, phone last 10 digits, exact name, and birthday, with mobile/insurance/employee identifiers treated as lower-confidence because family reuse is legitimate (`apps/backend/src/services/patient/patientDedupeService.js:141-250`). Kiosk P1 should therefore reuse the duplicate-warning posture, not create a parallel self-service merge.

### 2.3 Realtime Board Recipe

The realtime channel catalog already includes `staff:appointments`, patient queue and appointment channels, and many staff/admin board channels; channel auth gates staff, clinical, admin, and patient namespaces separately (`apps/backend/src/utils/websocket/channelAuth.js:9-17`, `apps/backend/src/utils/websocket/channelAuth.js:81-107`). Domain emitters are the intended wrapper around raw websocket primitives (`apps/backend/src/utils/websocket/realtimeEmitter.js:1-5`), with appointment/queue invalidation already broadcasting `staff:appointments` as a PHI-free `{kind, at}` nudge (`apps/backend/src/utils/websocket/realtimeEmitter.js:305-312`). Patient queue position is sent directly to the patient user, not broadcast on a public board (`apps/backend/src/utils/websocket/realtimeEmitter.js:146-159`).

Admin already has a reusable realtime invalidation hook that subscribes to a channel, invalidates query keys on each event, and keeps a slow poll fallback for at-most-once delivery (`apps/admin/src/hooks/useRealtimeInvalidation.ts:3-40`). NL-8 queue displays should use this recipe for authenticated staff/admin boards, but unauthenticated TV displays must not subscribe to `staff:appointments` until a display-token auth path and display-scoped channel namespace exist.

### 2.4 Housekeeping Dispatch and SLA Pattern

Housekeeping dispatch is the closest existing porter-work-order pattern. It defines active request statuses and SLA targets, with bed-cleaning high/urgent tasks aligned to a 30-minute canonical workflow SLA (`apps/backend/src/services/staff/housekeepingTaskDispatchService.js:7-18`). Recipient resolution combines roster assignments, active delegations, and housekeeping incharges, dedupes recipients, persists `housekeeping_request_recipients`, sends staff notifications, and marks recipients notified (`apps/backend/src/services/staff/housekeepingTaskDispatchService.js:241-333`).

`createBedCleaningRequest` resolves bed context and requester, computes recipients, sets status/open-assigned state, calculates `sla_due_at`, dedupes an existing active cleaning request for the bed, inserts the housekeeping request when needed, fans out notifications, writes updates, and emits a canonical operational bridge event (`apps/backend/src/services/staff/housekeepingTaskDispatchService.js:449-609`). The escalation engine runs every two minutes, evaluates overdue tasks and breached workflow SLA instances, fires configured actions once per tier, and keeps all writes tenant-scoped (`apps/backend/src/services/workflow/escalationEngineService.js:1-38`). The notification outbox persists pending notification intent and has retry/claim semantics for safe draining (`apps/backend/src/utils/notifications/notificationOutbox.js:11-19`, `apps/backend/src/utils/notifications/notificationOutbox.js:112-129`).

### 2.5 Scheduling 2.0 Substrate

Migration 285 already created recurring provider availability templates, provider leaves, appointment waitlist, and bookable resources/resource bookings for rooms and equipment (`apps/backend/src/migrations/285_scheduling_optimization.sql:1-15`, `apps/backend/src/migrations/285_scheduling_optimization.sql:19-127`). It also enabled RLS on the PHI-bearing waitlist and bookings tables (`apps/backend/src/migrations/285_scheduling_optimization.sql:128-156`).

The scheduling service already expands template slots, auto-blocks leave days, calculates overbook allowance from no-show risk scores, manages waitlist offers by priority/FIFO, creates bookable resources, and serializes resource bookings with an overlap check inside `setTenantTx` (`apps/backend/src/services/scheduling/schedulingOptimizationService.js:75-87`, `apps/backend/src/services/scheduling/schedulingOptimizationService.js:135-221`, `apps/backend/src/services/scheduling/schedulingOptimizationService.js:224-336`, `apps/backend/src/services/scheduling/schedulingOptimizationService.js:339-420`). NL-8 scheduling 2.0 should deepen this substrate rather than build a new calendar engine.

The NL-6 infusion-chair prompt deliberately keeps oncology chair scheduling slot-based and says not to build generic resource-calendar machinery because that belongs to NL-8 scheduling 2.0 (`docs/superpowers/build-prompts/nl6-10-infusion-chairs.md:14-18`). The NL-6 departmental plan likewise marks infusion chairs as `infusion_chairs` plus `chair_bookings` keyed to `chemo_cycles.scheduled_date`, not a replacement for the generic `resource_bookings` table (`docs/superpowers/specs/2026-07-06-nl6-departmental-completion-plan.md:673-681`).

### 2.6 Forecast and Command-Centre Substrate

The roadmap says predictive census/LOS/no-show still needs to be surfaced operationally, while Tier H models already exist (`docs/NEXT_LEVEL_ROADMAP.md:136-141`). The clinical-AI inventory lists operations modules for acuity staffing forecast, appointment no-show predictor, bed discharge forecast, hospital command center, housekeeping/bed-turnover optimizer, and OT scheduling/operations modules (`docs/CLINICAL_AI_MODULE_INVENTORY.md:182-188`).

`getBedForecast` is already enabled by `bed_discharge_forecast`, reads admitted patients by tenant and optional ward, estimates remaining hours from `expected_los_days`, returns 24h/48h discharge flags and counts, and persists the forecast under tenant RLS in `clinical_ai_bed_forecasts` (`apps/backend/src/services/ai/clinicalAiWorkflowService.js:1301-1352`). The admin forecast route exposes `/admin/forecast/beds`, audits bed forecast generation, and returns admitted count plus 24h/48h discharge counts (`apps/backend/src/routes/admin/forecastRoutes.js:45-63`). The admin forecast panel already calls `getBedDischargeForecast` and renders admitted patients, 24h discharges, 48h discharges, remaining hours, and flags (`apps/admin/src/lib/api/clinicalAiModules.ts:1803-1808`, `apps/admin/src/app/(with-auth)/dashboard/clinical-ai/components/coreModulePanels/ForecastWorkbenchPanel.tsx:886-1024`).

The existing hospital command center table takes six-department operational snapshots, including bed occupancy/discharge-ready wait/admission queue and housekeeping turnover, classifies each department and a hospital-wide command status, and is explicitly review-only with no automatic diversion, staffing, transfer, OR, or bed reassignment (`apps/backend/src/migrations/066_hospital_command_center.sql:1-14`, `apps/backend/src/migrations/066_hospital_command_center.sql:49-78`). Its admin panel lists pending command-center snapshots for duty-officer review and exposes accept/defer/edit/reject decisions (`apps/admin/src/app/(with-auth)/dashboard/clinical-ai/components/deferredModulePanels/HospitalCommandCenterPanel.tsx:181-200`). NL-8 P5 should bridge the bed/LOS forecast into that operational surface; it should not create another AI governance plane.

### 2.7 Flutter Web and Display Substrate

The staff Flutter web Dockerfile already builds a release web bundle with `VH_BASE_URL` and other dart-defines, copies only the build output into an nginx runner, runs as non-root on port 8080, and is explicitly the LAN variant (`apps/staff/Dockerfile.web:1-19`, `apps/staff/Dockerfile.web:60-100`). The staff-web kustomization says the same Flutter source tree is built with `flutter build web`, packaged by `apps/staff/Dockerfile.web`, and served behind the LAN-only `nginx-internal` IngressClass at `clinical.<hospital>.local` (`infra/kubernetes/apps/staff-web/kustomization.yaml:4-13`). The app-tier kustomization already includes `staff-web` and documents digest-pinned staff-web release images (`infra/kubernetes/apps/kustomization.yaml:7-13`, `infra/kubernetes/apps/kustomization.yaml:21-42`).

The patient app initializes Firebase and App Check, but its current App Check comment says the web provider is not used by the mobile patient app and is listed to surface accidental web-build config errors (`apps/patient/lib/main.dart:66-92`). That means NL-8 kiosk should choose intentionally between a supervised staff-web/tablet flow, a dedicated patient-kiosk web build with its own attestation/auth choices, or a native/tablet patient-app mode; it should not assume the mobile patient app is already production-web-ready.

## 3. Workstream Designs

### P1. Kiosk Self-Check-In

**User outcome.** A patient arriving for an existing appointment can verify identity, confirm or update safe demographic fields, complete required check-in acknowledgements, receive the correct queue/token state, and be routed to front desk when the data is ambiguous.

**Backend shape.**

- Add a tenant-scoped `patient_flow_checkins` detail table for appointment-bound check-ins: `tenant_id`, `appointment_id`, `patient_uid`, `queue_id`, `checkin_channel` (`kiosk_self`, `kiosk_supervised`, `patient_app`, `front_desk`), `identity_method` (`firebase_otp`, `staff_supervised`, `qr_plus_otp`), `status`, token/visit snapshot, profile delta summary, duplicate-candidate count, acknowledgement/consent references, `checked_in_at`, `checked_in_by`, and metadata. This table is PHI-bearing and must copy the migration-356 RLS pattern (`apps/backend/src/migrations/356_consent_signatures.sql:13-69`).
- Add a small `patient_flow_kiosk_sessions` or `kiosk_devices` table only if the product chooses persistent kiosk registration; otherwise use signed short-lived kiosk session tokens derived from staff/admin configuration. The first build should not require NL-7 device transport because the kiosk is a browser/tablet client over existing HTTPS (`CLAUDE.md:145-151`, `docs/superpowers/build-prompts/wave-c-nl8-kickoff.md:9`).
- Expose a patient-authenticated check-in endpoint that accepts only backend JWT identity from Firebase login, never raw phone/name/DOB as proof of identity (`apps/patient/CLAUDE.md:149-157`, `apps/backend/src/controllers/auth/firebaseAuthController.js:8-18`).
- Expose a supervised staff check-in endpoint for reception/admission roles that reuses front-desk RBAC and tenant binding (`apps/backend/src/controllers/appointment/appointmentWorkflowController.js:1207-1232`).
- Reuse `findRegistrationDuplicateCandidates` before accepting profile deltas; if medium/high duplicate candidates exist, store the check-in attempt and route the patient to front desk rather than auto-merging or auto-overwriting identity data (`apps/backend/src/services/patient/patientDedupeService.js:141-250`).
- Attach the check-in to the existing queue with `ensureAppointmentQueueForAppointment` and then emit a PHI-free `staff:appointments` invalidation plus patient-specific queue-position update (`apps/backend/src/services/appointment/appointmentQueueService.js:103-220`, `apps/backend/src/utils/websocket/realtimeEmitter.js:146-159`, `apps/backend/src/utils/websocket/realtimeEmitter.js:305-312`).
- Do not overload `appointments.status = IN_PROGRESS` for arrival. Existing queue waits treat `CONFIRMED` and `SCHEDULED` as waiting and `IN_PROGRESS` as clinician-started (`apps/backend/src/services/appointment/waitTimeService.js:31-49`, `apps/backend/src/controllers/appointment/appointmentStatusController.js:14-15`). P1 should record arrival in the new check-in table and expose "checked in" in queue/display APIs unless the appointment status enum is deliberately expanded everywhere.

**Client shape.**

- Preferred first build: a Flutter web/tablet kiosk mode using the existing Flutter workspace and staff-web deployment pattern, but with a product decision on whether the kiosk runs as supervised staff-web, dedicated patient-kiosk web, or patient-app tablet mode (`apps/staff/Dockerfile.web:1-19`, `apps/patient/lib/main.dart:88-92`).
- Kiosk copy should be minimal: phone OTP or QR plus OTP, appointment match, demographic confirmation, consent/acknowledgement, token/queue result, and front-desk handoff state. It must not show duplicate candidates or PHI from other patients.

**Migration count estimate.** 2 migrations: one for `patient_flow_checkins` plus audit/indexes/RLS, one optional for kiosk-device/session settings and per-tenant enablement. Exact numbers come from the playbook registry at build launch, not from filesystem numbering (`docs/superpowers/build-prompts/wave-c-nl8-kickoff.md:10`, `docs/superpowers/NEXT_LEVEL_EXECUTION_PLAYBOOK.md:104-129`).

### P2. Queue TV Display App

**User outcome.** Waiting areas can show live queue/token progress without exposing PHI, while staff/admin boards can continue using authenticated realtime channels.

**Backend shape.**

- Add `queue_display_profiles` for tenant, queue filter, display name, location, optional department/doctor, display mode, language, accessibility size, masked-name policy, and active/inactive state. Use a per-tenant rollout/settings table patterned after migration 351, not global `feature_flags` (`apps/backend/src/migrations/351_composition_search_settings.sql:1-37`).
- Add `queue_display_sessions` only if display devices need revocable signed tokens and heartbeat/last-seen state. Display tokens should scope to one profile and should not grant staff websocket access.
- Add a PHI-free display endpoint that returns `queue_label`, token/visit display value, counter/room, display status, ETA bucket if approved, and `last_updated_at`. It should derive from the existing queue/token/wait-time substrate (`apps/backend/src/migrations/260_care_team_patient_access_lab_specimen_qc.sql:32-101`, `apps/backend/src/services/appointment/waitTimeService.js:70-93`).
- For staff/admin queue screens, reuse `staff:appointments` invalidation and the existing React Query hook (`apps/backend/src/utils/websocket/realtimeEmitter.js:305-312`, `apps/admin/src/hooks/useRealtimeInvalidation.ts:3-40`). For unauthenticated public TV screens, start with short polling plus cache headers; add a display-scoped websocket namespace only after channel auth supports signed display sessions.
- Public board payloads must be token-first. Names are hidden unless the owner explicitly approves a masking policy, and even then the payload should carry only a pre-rendered masked display label, not raw name/phone/identifier (`docs/superpowers/build-prompts/wave-c-nl8-kickoff.md:9`).

**Client/deploy shape.**

- First implementation can be a small admin/staff-web route rendered in display mode or a separate static Flutter web bundle; either way it uses the existing HTTPS ingress and no new inbound ports (`CLAUDE.md:145-151`, `apps/staff/Dockerfile.web:87-100`).
- Accessibility knobs for text size, contrast, motion, and audio announcements belong in the NL-8 display contract, while the broader automation/font-scaling program belongs to NL-12 (`docs/superpowers/build-prompts/wave-d-nl12-kickoff.md:5-11`).

**Migration count estimate.** 1-2 migrations: profiles/settings first; sessions only if the owner chooses device-token management.

### P3. Porter and Patient-Transport Tasks

**User outcome.** Wards, front desk, diagnostics, discharge hub, and command centre can request, assign, track, escalate, and close patient transport without using housekeeping tables for a different workforce.

**Backend shape.**

- Add tenant-scoped `porter_transport_tasks`, `porter_transport_task_recipients`, and `porter_transport_task_updates`, mirroring the housekeeping lifecycle and fan-out shape but not reusing `housekeeping_requests` for porters. Housekeeping has request statuses, recipients, updates, fan-out, and SLA due dates already (`apps/backend/src/services/staff/housekeepingTaskDispatchService.js:7-18`, `apps/backend/src/services/staff/housekeepingTaskDispatchService.js:412-609`).
- Task fields should include `source_type` (`appointment_checkin`, `admission`, `discharge`, `imaging`, `lab`, `bed_transfer`, `manual`), `source_id`, `patient_uid`, `admission_id`, pickup/destination location IDs and display labels, priority/urgency, mobility/infection/isolation flags, requested/accepted/picked-up/completed timestamps, assigned porter, verifier, cancellation reason, and `sla_due_at`.
- Reuse recipient-resolution concepts from housekeeping: current roster, delegation, incharge fallback, dedupe, persisted recipients, and staff notifications (`apps/backend/src/services/staff/housekeepingTaskDispatchService.js:241-333`). Do not assume the same roster table is enough; porters may need their own role/zone taxonomy.
- Use `workflow_sla_instances` plus the escalation engine for overdue transport tasks; the engine already evaluates breached SLA instances, fires tiered actions once, and keeps writes tenant-scoped (`apps/backend/src/services/workflow/escalationEngineService.js:19-38`).
- Persist notification intent through the outbox for retries and multi-replica safety (`apps/backend/src/utils/notifications/notificationOutbox.js:11-19`, `apps/backend/src/utils/notifications/notificationOutbox.js:112-129`).
- Patient-linked transport lifecycle events that are visible in the patient's care movement should create audit/timeline/SLA records in one transaction; pure recipient refreshes and notification retries should not create patient timeline events (`docs/CANONICAL_CLINICAL_TIMELINE.md:73-95`).
- Keep NL-6 boundaries intact: the NL-6 plan says NL-8 owns porter/transport and scheduling 2.0, while mortuary stays at custody/release records rather than transport dispatch (`docs/superpowers/specs/2026-07-06-nl6-departmental-completion-plan.md:24-31`).

**Realtime/admin shape.**

- Add `staff:transport` or `staff:patient-flow` to `CHANNEL_CATALOG` only with the same staff-role channel model as existing boards (`apps/backend/src/utils/websocket/channelAuth.js:81-107`).
- Provide board invalidation payloads as `{kind, at}` and force clients to refetch, matching the established board pattern (`apps/backend/src/utils/websocket/realtimeEmitter.js:242-312`, `apps/admin/src/hooks/useRealtimeInvalidation.ts:3-40`).

**Migration count estimate.** 2-3 migrations: core transport task tables, SLA/routing/settings, and optional roster/zone taxonomy if existing staff roster tables cannot express porter dispatch.

### P4. Scheduling 2.0

**User outcome.** Scheduling becomes a first-class appointment, provider, waitlist, overbook, and resource-booking workflow rather than a collection of isolated helper functions.

**Backend shape.**

- Extend the existing provider-template substrate with exception/holiday rules, template versions, appointment-type/service constraints, location/counter/room compatibility, and an audit trail for template changes. The existing tables already model templates, leaves, waitlists, and rooms/equipment bookings (`apps/backend/src/migrations/285_scheduling_optimization.sql:19-127`).
- Add short-lived `appointment_slot_holds` with idempotency key, expiry, source channel, and user/session so kiosk, patient app, staff, and call-centre flows cannot double-book the same displayed slot during checkout.
- Add tenant-scoped `scheduling_overbook_policies` that cap no-show-fed overbooking by department/provider/visit type. The current service computes allowance from no-show scores and a max fraction; NL-8 should make the policy reviewable and auditable, not hard-coded only (`apps/backend/src/services/scheduling/schedulingOptimizationService.js:75-87`, `apps/backend/src/services/scheduling/schedulingOptimizationService.js:203-219`).
- Deepen `appointment_waitlist` from "offer freed slot" into an operational queue with expiry, patient notification state, source channel, and front-desk override reason. The current service already offers free slots by priority and FIFO (`apps/backend/src/services/scheduling/schedulingOptimizationService.js:224-336`).
- Keep resource conflict checks server-side and serialized. The current `bookResource` path locks the resource, checks overlap, and inserts inside `setTenantTx` (`apps/backend/src/services/scheduling/schedulingOptimizationService.js:355-405`).
- Respect the oncology chair precedent: N6-10 chair booking remains slot-based against chemo cycles; NL-8 generic resource booking can interoperate later, but should not rewrite oncology chair scheduling while it is landing in a separate workstream (`docs/superpowers/build-prompts/nl6-10-infusion-chairs.md:14-18`).

**Client shape.**

- Staff/admin scheduling screens should show provider templates, leave blocks, resource clashes, waitlist offers, and overbook rationale in one flow. Kiosk and patient surfaces should see only bookable choices and confirmation, not policy internals.
- Every route/API change must update OpenAPI and generated clients according to `_worker-common.md` (`docs/superpowers/build-prompts/_worker-common.md:20-29`).

**Migration count estimate.** 2-4 migrations: policy/settings, slot holds, template exceptions/versioning, and optional waitlist notification state.

### P5. Predictive Census/LOS on Command Centre

**User outcome.** The command centre sees bed census pressure, likely 24h/48h discharges, LOS remaining, and patient-flow recommendations as decision-support signals beside existing operations snapshots.

**Backend shape.**

- First reuse `getBedForecast` and `clinical_ai_bed_forecasts` instead of creating a second bed forecast engine. It already requires the `bed_discharge_forecast` module, returns admitted counts, 24h/48h discharge counts, per-patient remaining hours, and persists under tenant RLS (`apps/backend/src/services/ai/clinicalAiWorkflowService.js:1301-1352`).
- Add a command-centre bridge that rolls up current bed forecast, queue pressure, transport backlog, housekeeping turnover backlog, and scheduling/no-show signals into the existing `hospital_command_center` review model. The command-centre migration already defines beds, ED, OR, housekeeping, radiology, and pharmacy snapshots as review-only decision support (`apps/backend/src/migrations/066_hospital_command_center.sql:1-14`, `apps/backend/src/migrations/066_hospital_command_center.sql:49-78`).
- Surface forecast freshness, source modules, confidence bands, and "decision support only" copy in the admin panel. The existing panel already renders bed forecast KPIs and patient rows; the command-center panel already supports review decisions (`apps/admin/src/app/(with-auth)/dashboard/clinical-ai/components/coreModulePanels/ForecastWorkbenchPanel.tsx:920-1024`, `apps/admin/src/app/(with-auth)/dashboard/clinical-ai/components/deferredModulePanels/HospitalCommandCenterPanel.tsx:181-200`).
- Do not auto-discharge, auto-transfer, auto-call staff, auto-reassign beds, or auto-dispatch porters from model output. Existing command-centre and acuity-staffing migrations explicitly state review-only, no auto-trigger posture (`apps/backend/src/migrations/066_hospital_command_center.sql:11-13`, `apps/backend/src/migrations/072_acuity_staffing_forecast.sql:11-12`).

**Migration count estimate.** 0-1 migration: zero if the build can use existing `clinical_ai_bed_forecasts` and `clinical_ai_command_center_snapshots`; one if the command centre needs a non-AI patient-flow summary/cache table or per-tenant NL-8 forecast settings.

## 4. Phased Plan

Migration numbers are not assigned in this spec. The playbook registry is the allocation authority, and the current table leaves `424+` unassigned for future launches (`docs/superpowers/NEXT_LEVEL_EXECUTION_PLAYBOOK.md:104-129`). Build prompts must record exact numbers at launch.

| Phase | Slice | Build goal | Migration count estimate |
|---|---|---|---|
| P1 | Kiosk self-check-in | Authenticated/supervised appointment check-in, queue attach, duplicate handoff, token result | 2 |
| P2 | Queue TV display | PHI-free queue-display profiles and display endpoint; optional display-token sessions | 1-2 |
| P3 | Porter/transport tasks | Transport task lifecycle, recipients, SLA/escalation, board invalidation | 2-3 |
| P4 | Scheduling 2.0 | Slot holds, template exceptions, overbook policies, waitlist deepening, resource conflict UI/API | 2-4 |
| P5 | Census/LOS command centre | Bed forecast bridge into command-centre review surface | 0-1 |

## 5. Test Strategy for Build PRs

Backend tests:

- Kiosk check-in: patient Firebase JWT accepted; raw phone/DOB identity rejected; staff-supervised check-in role-gated; cross-tenant appointment rejected; duplicate candidates route to front desk; same-day duplicate appointment warning is preserved.
- Queue display: public display endpoint returns no patient name, phone, UID, identifier, DOB, reason, diagnosis, or notes; token/visit display values are stable; disabled profile/token returns 403; staff board still uses `staff:appointments` invalidation.
- Porter transport: create/assign/accept/pick-up/complete/cancel lifecycle; duplicate task guard for same source; SLA due calculation; recipient dedupe; escalation/outbox retries; patient timeline/audit/SLA written atomically only for patient-visible movement states.
- Scheduling 2.0: slot-hold idempotency and expiry; provider leave/template exception blocking; overbook policy caps; waitlist offer expiry; resource overlap rejection under concurrent transactions; oncology chair scheduling unaffected.
- Forecast/command centre: bed forecast freshness and tenant scope; command-centre bridge review-only; no automatic discharge, bed reassignment, staffing, or porter dispatch from model output.

Client tests:

- Admin/staff queue display and transport board tests should assert PHI redaction, live/poll fallback state, and empty/error states.
- Flutter kiosk tests should cover OTP/session handoff, duplicate/front-desk handoff, token success, all supported languages, and large text display.
- Staff-app strings must land in all five `intl_*.arb` files when Flutter text changes (`docs/superpowers/build-prompts/_worker-common.md:26-27`).

Gates:

- Backend route/schema changes require backend tests plus OpenAPI generate/check and generated client sync when Flutter consumes the API (`docs/superpowers/build-prompts/_worker-common.md:20-29`).
- Raw SQL build slices require raw-param lint, PHI tenant-id checks, schema drift checks, and Prisma regeneration from a scratch database only (`docs/superpowers/build-prompts/_worker-common.md:31-49`).
- Docs-only spec PR validation is limited to scope cleanliness and markdown/diff sanity; this PR intentionally runs no app tests because it changes no app code.

## 6. Owner Decisions

1. **Public display identity policy.** Default is token-only. Decide whether any masked name or initials are allowed, and if so which departments can enable it.
2. **Kiosk auth mode.** Choose self-service Firebase OTP, QR plus OTP, supervised staff tablet, or a mix by department. The current patient app is mobile-first and warns that its web App Check provider is not used by the mobile patient app (`apps/patient/lib/main.dart:88-92`).
3. **Kiosk hardware and printing.** Decide whether tokens are printed, SMS/push-only, QR-only, or displayed after check-in. Device procurement is an operator decision; NL-8 should not build an NL-7-style device transport.
4. **Profile update authority.** Decide which demographic fields a kiosk can update immediately, which require front-desk approval, and which are read-only.
5. **Display hosting.** Choose whether queue TVs run as an admin/staff-web display route or a separate static Flutter web bundle. Both must stay behind existing HTTPS/LAN ingress and zero-inbound posture (`CLAUDE.md:145-151`).
6. **Porter role and SLA taxonomy.** Decide porter roles, zones, shift roster source, escalation tiers, and expected pickup/completion targets per source type.
7. **Scheduling overbook policy.** Decide department/provider caps, who can override no-show-fed overbooking, and what audit evidence is required.
8. **Forecast governance.** Decide who owns census/LOS forecast review, freshness thresholds, and when a stale forecast must be hidden rather than shown with a warning.
9. **NL-11/NL-12 handoff.** Decide the minimum display theming/accessibility contract for NL-8 now, while leaving shared design tokens and accessibility automation to NL-11/NL-12.

## 7. Source Notes

- NL-8 prompt and worker rules: `docs/superpowers/build-prompts/wave-c-nl8-kickoff.md:3-11`, `docs/superpowers/build-prompts/_worker-common.md:20-79`.
- Roadmap and playbook state: `docs/NEXT_LEVEL_ROADMAP.md:136-151`, `docs/NEXT_LEVEL_ROADMAP.md:211-232`, `docs/superpowers/NEXT_LEVEL_EXECUTION_PLAYBOOK.md:33-79`, `docs/superpowers/NEXT_LEVEL_EXECUTION_PLAYBOOK.md:104-129`.
- Timeline, RLS, flags, and deployment invariants: `docs/CANONICAL_CLINICAL_TIMELINE.md:73-95`, `apps/backend/src/migrations/356_consent_signatures.sql:13-69`, `apps/backend/src/migrations/351_composition_search_settings.sql:1-37`, `CLAUDE.md:145-151`.
- Queue, token, wait-time, and realtime evidence: `apps/backend/src/migrations/260_care_team_patient_access_lab_specimen_qc.sql:32-101`, `apps/backend/src/services/appointment/appointmentQueueService.js:47-220`, `apps/backend/src/controllers/appointment/appointmentWorkflowController.js:1857-2034`, `apps/backend/src/services/appointment/waitTimeService.js:14-125`, `apps/backend/src/controllers/appointment/appointmentStatusController.js:14-130`, `apps/backend/src/utils/websocket/channelAuth.js:9-107`, `apps/backend/src/utils/websocket/realtimeEmitter.js:1-159`, `apps/backend/src/utils/websocket/realtimeEmitter.js:242-312`, `apps/admin/src/hooks/useRealtimeInvalidation.ts:3-40`.
- Identity and dedupe evidence: `apps/patient/CLAUDE.md:149-217`, `apps/backend/src/controllers/auth/firebaseAuthController.js:8-18`, `apps/backend/src/controllers/appointment/appointmentWorkflowController.js:1207-1540`, `apps/backend/src/services/patient/patientDedupeService.js:1-250`.
- Dispatch, scheduling, and forecast evidence: `apps/backend/src/services/staff/housekeepingTaskDispatchService.js:7-609`, `apps/backend/src/services/workflow/escalationEngineService.js:1-38`, `apps/backend/src/utils/notifications/notificationOutbox.js:11-129`, `apps/backend/src/migrations/285_scheduling_optimization.sql:1-156`, `apps/backend/src/services/scheduling/schedulingOptimizationService.js:75-420`, `docs/superpowers/build-prompts/nl6-10-infusion-chairs.md:14-18`, `apps/backend/src/services/ai/clinicalAiWorkflowService.js:1301-1352`, `apps/backend/src/routes/admin/forecastRoutes.js:45-63`, `apps/backend/src/migrations/066_hospital_command_center.sql:1-78`, `apps/backend/src/migrations/072_acuity_staffing_forecast.sql:1-12`.
- Flutter web, public-display, and accessibility evidence: `apps/staff/Dockerfile.web:1-100`, `infra/kubernetes/apps/staff-web/kustomization.yaml:4-13`, `infra/kubernetes/apps/kustomization.yaml:7-42`, `apps/patient/lib/main.dart:66-92`, `docs/superpowers/build-prompts/wave-d-nl12-kickoff.md:5-11`.
