# NL-3 Teleconsultation Design

- Date: 2026-07-05
- Program: NL-3 Teleconsultation
- Status: Design proposal, deploy held
- Scope: Specification only. This document does not implement application code, database migrations, Kubernetes manifests, or client screens.
- Recommendation: Self-host LiveKit on the hospital-owned RKE2 footprint, with Cloudflare Tunnel/ingress used for HTTPS/WSS signaling only and hospital-operated TURN/SFU media paths exposed through an approved L4 edge.

## 1. Context and Binding Invariants

The NL-3 roadmap calls for self-hosted teleconsultation where PHI media never leaves the hospital-controlled deployment, rooms and tokens are provisioned from the migration-117 telemedicine entities, recording is default-off, consent gates are explicit, and degraded mode is honest about video/audio/chat state.

Two existing product boundaries are binding for this design:

- Consultation documentation must use the existing OP note path. No teleconsult-specific clinical note writer should be added. The clinician surface must deep-link into the current OP appointment-bound note flow with `appointment_id` and an OP-compatible note type such as `op_consultation`.
- The patient portal demarcation must hold. Patient-visible consult documentation remains limited to signed, appointment-bound OP consultation notes. In-hospital, inpatient, nursing, procedure, and discharge-source notes must not become visible because a teleconsult happened.

Repository evidence used for this design:

- `docs/NEXT_LEVEL_ROADMAP.md`: NL-3 requirements and the patient-visible note invariant.
- `apps/backend/src/migrations/117_telemedicine_foundation.sql`: `teleconsultations`, `video_sessions`, `chat_sessions`, `chat_session_messages`, `remote_prescriptions`, and `teleconsult_provider_configs`.
- `apps/backend/src/services/telemedicine/telemedicineService.js`: current provider-agnostic telemedicine service, consent recording, status transitions, video-session lifecycle, chat-session lifecycle, and remote-prescription linking.
- `apps/backend/src/routes/admin/telemedicineRoutes.js`: current admin route surface for teleconsultations, video sessions, chats, prescriptions, and provider configs.
- `apps/backend/src/services/appointment/appointmentService.js` and appointment workflow controllers/routes: `visit_type = 'TELE'` is already accepted and appointment queue materialization already exists.
- `apps/backend/src/services/emr/clinicalNotesService.js`: OP appointment session gate, duplicate appointment-note protection, assigned clinician controls, signature flow, and canonical OP encounter handling.
- `apps/backend/src/services/portal/patientPortalService.js` and `apps/backend/src/services/recordService.js`: signed appointment-bound consultation note visibility rules.
- `apps/backend/src/migrations/158_patient_secure_messaging.sql`: secure patient-care-team messaging threads with optional `related_appointment_id`.
- `git show 9f346f0a^:apps/staff/lib/features/telemedicine/screens/telemedicine_screen.dart`: the removed staff app telemedicine stub was only a placeholder, not a reusable implementation.

## 2. SFU Selection

### Comparison

| Option | On-prem RKE2 deployability behind current ingress/Tunnel topology | Flutter client maturity | Recording off by default | Resource footprint on 3-node RKE2 | Assessment |
| --- | --- | --- | --- | --- | --- |
| LiveKit | Strongest fit. Official Kubernetes/Helm guidance exists, Redis is a normal production dependency, and the API can sit behind HTTPS/WSS ingress. WebRTC media still needs host networking or an L4/public edge; Cloudflare Tunnel is not the media path. | Strong. `livekit_client` is the official Flutter SDK with Android, iOS, web, macOS, Windows, and Linux support. | Strong. Recording is an explicit Egress feature/API and can remain undeployed. Join tokens can omit recording grants. | Moderate and controllable. Start with one LiveKit pod per node or one active pod while validating edge routing. Initial requests can fit inside the 3-node RKE2 baseline if recording workers are not deployed. Bandwidth, not CPU, is the main limit. | Recommended. Best balance of self-hosting, SDK quality, API integration, and recording control. |
| mediasoup | Technically viable but not a packaged conferencing server. It is a low-level Node.js module plus worker subprocesses, so VH Health would own signaling, room management, token semantics, recording orchestration, and client glue. | Weakest for this project. Flutter support appears community-maintained and less mature than LiveKit or Jitsi. | Strong by omission. Recording is DIY, typically through FFmpeg/GStreamer/plain transports, so nothing records unless VH Health builds it. | Potentially smallest raw SFU footprint, but shifted into custom service complexity, operational ownership, and longer validation. | Do not pick for NL-3 MVP. Useful only if VH Health later wants to own a bespoke media platform. |
| Jitsi | Self-hosted deployment is proven, but official docs emphasize Debian/Docker-style installs. Kubernetes usually means community charts and multiple moving parts: web, Prosody, Jicofo, JVB, and optional Jibri. HTTPS/WSS can use ingress; UDP media still needs direct edge exposure. | Good. Official Flutter SDK exposes join, hang up, mute, video, screen share, and chat controls. | Good but heavier. Recording requires Jibri infrastructure and explicit enablement. Keep it absent for MVP. | Heavier than LiveKit for an embedded appointment workflow. JVB plus control-plane services are workable, but Jibri recording is expensive and should not run on the base cluster by default. | Good fallback for off-the-shelf meeting UX, but too meeting-suite oriented for appointment-bound OP documentation. |

### Recommendation

Pick LiveKit for the NL-3 self-hosted SFU, subject to owner sign-off on the L4/TURN edge. It gives VH Health an embeddable media layer, official Flutter support, server-side token grants, on-prem operation, explicit recording controls, and a clean path to connect rooms to migration-117 `teleconsultations` and `video_sessions`.

The existing migration-117 `video_sessions.provider` CHECK constraint currently names `zoom`, `daily`, `jitsi`, `twilio`, `agora`, `webrtc_native`, and `other`. P1 should add a deliberate `livekit` provider value rather than hiding LiveKit under `other`; until that migration is implemented, this document remains a design artifact only.

## 3. PHI and Network Posture

### Media Boundary

Media must stay on-prem. The MVP must not use LiveKit Cloud, Jitsi Meet hosted service, Twilio, Agora, Daily, Zoom media relay, or any other third-party SFU/TURN relay. Patient and clinician audio/video packets should terminate on hospital-operated LiveKit/TURN infrastructure.

The existing Cloudflare Tunnel and ingress topology remains useful for:

- Backend APIs that mint join tokens.
- LiveKit HTTPS/WSS signaling, if routed as an HTTP service through `teleconsult.vhhealth.app`.
- Admin/staff/patient app HTTP traffic.

It must not be treated as the public media relay for normal patient WebRTC traffic. WebRTC UDP, TCP fallback, and TURN need an owner-approved hospital edge path, such as a public IP/L4 load balancer, firewall NAT to selected RKE2 nodes, or a DMZ-hosted TURN tier owned by VH Health.

### TURN Strategy

Patients outside the hospital network should use hospital-operated TURN when direct peer-to-SFU connectivity is blocked.

Proposed policy:

- Primary: direct WebRTC UDP from patient device to the LiveKit SFU on hospital-owned public IP/L4 edge.
- Secondary: hospital-operated TURN over UDP, preferably on an allowed public port approved by network/security.
- Tertiary: TURN/TLS on TCP 443 or 5349 for restrictive patient networks.
- Final fallback: audio-only, then secure messaging chat tied to the appointment.

Implementation choice to decide in P1:

- LiveKit embedded TURN can be used for a compact first deployment.
- Dedicated coturn can be used if network/security wants stricter isolation, independent scaling, or a DMZ boundary.

In both cases, no third-party relay credentials should be configured for production. Logs must avoid names, diagnoses, raw tokens, URLs with tokens, or full SDP bodies. Operational telemetry can record opaque room IDs, teleconsultation IDs, participant roles, packet-loss summaries, join failures, and final modality.

## 4. Room and Token Provisioning

### Entity Mapping

Migration-117 already provides the right ownership spine:

- One scheduled video consult maps to one `teleconsultations` row.
- Each LiveKit room maps to the active `teleconsultations.id`.
- The LiveKit room name should be opaque, for example `tc_{tenant_hash}_{teleconsultation_id}_{random_suffix}`. It must not include patient names, phone numbers, diagnoses, or department names.
- The room/provider binding should be represented by one `video_sessions` row with `provider = 'livekit'`, `external_session_id = <livekit room name>`, `recording_status = 'disabled'`, and provider metadata for non-PHI technical state.
- Existing `chat_sessions` may hold teleconsult-specific fallback state, but the durable patient-care-team fallback should use the existing secure messaging tables from migration 158 with `related_appointment_id`.
- Existing `remote_prescriptions` can link a teleconsultation to the prescription created by the current e-prescription flow.

### Provisioning Service Contract

P1 should add a backend provisioning service that wraps `telemedicineService` rather than letting clients talk directly to the SFU. Suggested contract:

- `ensureTeleconsultationForAppointment(appointment_id)`: creates or returns a `teleconsultations` row when the appointment is a teleconsult appointment.
- `ensureVideoSession(teleconsultation_id)`: creates or returns the LiveKit `video_sessions` row and room binding.
- `recordTeleconsultConsent(teleconsultation_id, participant_uid, consent_payload)`: records remote consult consent before join.
- `issueJoinToken(teleconsultation_id, participant_uid, role)`: returns `{ server_url, room_name, participant_token, expires_at }`.

Tokens must be short-lived, preferably 5 to 10 minutes, and refreshable only through the backend after authorization is rechecked. Token creation must validate:

- Tenant scope.
- Appointment relationship.
- Patient self-access or assigned/authorized clinician access.
- Teleconsultation status is `scheduled`, `waiting`, or `in_progress`.
- The appointment is not cancelled, no-show, rescheduled, or otherwise terminal.
- Required consent has been captured before media join.

### Role Grants

Use LiveKit grants narrowly:

- `patient`: may join the room, publish camera/mic/data, and subscribe. No room admin, recording, or broad metadata mutation.
- `clinician`: may join, publish camera/mic/screen/data, subscribe, and perform limited room moderation. Recording grant remains absent unless a future recording policy explicitly enables it for that session.
- `observer`: may join and subscribe only by default. Publishing requires an explicit clinical workflow reason and audit trail.

Participant identity should be role-prefixed and opaque, for example `patient:{uid}` or `clinician:{uid}`. Token metadata can include `tenant_id`, `teleconsultation_id`, `appointment_id`, and `role`; it must not include diagnosis, free-text reason, phone, email, or note content.

## 5. End-to-End Flow

### 5.1 Booking and Queue

Teleconsultation should enter through the existing appointment system, not through a raw meeting-link feature.

1. Patient or staff chooses a teleconsult appointment type. The backend should use the existing `visit_type = 'TELE'` path unless product decides a separate appointment type field is needed.
2. Existing slot, duplicate, doctor/department, and tenant checks continue to run through the appointment service.
3. Appointment queue materialization continues through `ensureAppointmentQueueForAppointment`. P4 can decide whether teleconsult appointments remain in doctor/department queues with a teleconsult badge or receive a dedicated queue kind.
4. The teleconsultation row is created from the appointment and remains appointment-bound.

### 5.2 Patient Lobby

The patient app should join only from the appointment card or appointment detail screen. The lobby should:

- Confirm identity and show the scheduled doctor/department.
- Run camera, microphone, speaker/headphone, and network checks.
- Show honest readiness state such as "Video ready", "Audio only recommended", or "Secure chat fallback available".
- Capture teleconsult consent before requesting a media token.
- Request a short-TTL join token from the backend.
- Move the teleconsultation to `waiting` when the patient is ready.

Pre-consult questionnaire data, if used, belongs in `teleconsultations.pre_consult_form` or a linked clinical intake record. It must not be embedded into SFU room names or client token metadata.

### 5.3 Consult

The consult surface uses LiveKit for video/audio and the existing secure messaging workflow as the durable chat fallback.

- Live video is the primary modality.
- Audio-only is the first degraded modality.
- Secure messaging with `related_appointment_id` is the durable fallback when media is unavailable or the patient cannot continue by audio.
- LiveKit data channels may be used only for ephemeral in-call controls, typing state, or quality notices. Clinical chat content that should persist should use the secure messaging path.
- Clinician start moves the teleconsultation to `in_progress`.
- Clinician end can complete the `video_sessions` row. Completing the clinical appointment remains an explicit clinical workflow action and should not be inferred solely from media disconnect.

### 5.4 Consultation Note

The clinician documents through the existing OP note flow:

1. Staff consult surface opens the current OP note editor with `appointment_id`, patient, clinician, and an OP-compatible note type such as `op_consultation`.
2. `clinicalNotesService` enforces appointment ownership, assigned-clinician/supervisor access, same-day open OP session rules, terminal status blocking, and duplicate OP appointment-note protection.
3. Signing the note uses the existing signature and canonical OP encounter behavior.
4. Patient visibility continues through the existing portal rule: signed, appointment-bound OP consultation notes only.

This design intentionally does not add a new patient-visible note category, does not create inpatient notes, and does not widen portal allowlists.

### 5.5 e-Rx and Payment

Prescriptions should use the existing e-prescription/prescription flow already tied to OP consultation context. When a prescription is issued from a teleconsult, the telemedicine service can create a `remote_prescriptions` link for audit and analytics, but prescription authoring remains owned by the current clinical prescribing surface.

If payment is required:

- Use existing billing and payment-link services.
- Link payment to the invoice/appointment according to current billing rules.
- Send the payment link through the existing SMS/WhatsApp/email mechanisms.
- Do not let the telemedicine service become a parallel billing engine.

## 6. Consent and Recording Policy

### Consent Gate

Consent is required before media join. At minimum, the consent screen should capture:

- Patient identity confirmation.
- Consent to remote video/audio consultation.
- Acknowledgement that connectivity may degrade to audio or secure messaging.
- Acknowledgement of emergency limitations and instructions for urgent care.
- Prescription, payment, and follow-up terms where applicable.
- Recording state, explicitly saying recording is off for MVP.

The backend should store `remote_consent_id` and `remote_consent_signed_at` on `teleconsultations`, with the consent artifact stored in the consent system or consent table selected by the existing governance model.

### Recording Default

Recording is off by default. P1 and P2 should not deploy LiveKit Egress, Jibri, FFmpeg recorders, or any other recording worker. Tokens must not include recording grants, and `video_sessions.recording_status` should remain `disabled`.

If recording is ever enabled later, the policy must be approved before deployment:

- Per-session recording consent from the patient and all clinically required participants.
- Clear in-room recording indicator before and during recording.
- `teleconsultations.recording_consent = true` only for that session.
- `video_sessions.recording_status` transitions audited from requested to active to completed or failed.
- Storage in hospital-owned encrypted object storage, not third-party media storage.
- Default retention no longer than 30 days unless legal, clinical governance, or explicit patient-record policy extends it.
- Access restricted to authorized clinical/HIM roles with audit logs on every access.
- Deletion job and legal-hold behavior defined before any recorder is enabled.

## 7. Bandwidth Degradation Ladder

The UX should be honest about modality. It should not pretend a video consult occurred when the session actually completed by audio or secure messaging.

Suggested ladder:

1. Full video with adaptive bitrate and active-speaker layout.
2. Reduced video resolution/frame rate.
3. Disable remote non-active video tiles.
4. Audio-only.
5. Secure messaging fallback tied to the appointment.
6. Reschedule or convert to in-person if clinical safety requires it.

The consult surface should show plain state changes:

- "Video is unstable; switching to lower quality."
- "Video unavailable; continuing by audio."
- "Audio unavailable; continuing in secure chat."
- "Connection could not support remote consultation; reschedule or route to clinic."

Persist technical summaries in non-PHI metadata, such as final modality, join failures, approximate packet loss bucket, average bitrate bucket, and whether TURN was used. These metrics help operations without leaking clinical content.

## 8. Infra Manifests Sketch - Deploy Held

No manifests should be added by this design PR. P1 can introduce held manifests under:

`infra/kubernetes/base/telemedicine/`

Suggested held resources:

- `namespace.yaml`: `vhhealth-telemedicine` or the platform namespace selected by operations.
- `livekit-config.yaml`: LiveKit config with Redis, RTC port range, TURN settings, and metrics.
- `livekit-secret.yaml`: sealed/external secret for API key and API secret.
- `livekit-daemonset.yaml` or `livekit-deployment.yaml`: host-networked LiveKit pods with one pod per node. A DaemonSet matches the one-pod-per-node guidance; a one-replica Deployment is acceptable for the first manual smoke if network routing is not ready for multi-node media.
- `livekit-service.yaml`: ClusterIP for API/WSS signaling through ingress.
- `livekit-ingress.yaml`: `teleconsult.vhhealth.app` for HTTPS/WSS signaling. This can route through existing ingress and Cloudflare Tunnel.
- `turn-service.yaml`: only if using dedicated coturn; otherwise configure LiveKit embedded TURN.
- `network-policy.yaml`: allow backend to call LiveKit API, ingress to reach LiveKit signaling, LiveKit to reach Redis/CoreDNS, and explicit public media/TURN exposure. Deny third-party media relay egress.
- `servicemonitor.yaml`: metrics scraping and alerts for room creation failures, join failures, high relay use, packet loss, and CPU/bandwidth pressure.
- `kustomization.yaml`: not referenced by the root base until owner sign-off.

Initial sizing for the 3-node RKE2 baseline:

- LiveKit pod request: `cpu: 500m`, `memory: 1Gi`.
- LiveKit pod limit: `cpu: 2`, `memory: 4Gi`.
- Dedicated coturn request, if used: `cpu: 100m`, `memory: 128Mi`.
- Dedicated coturn limit, if used: `cpu: 500m`, `memory: 512Mi`.
- Recording/Egress worker: replicas `0` or absent. If later enabled, size separately at no less than `cpu: 2`, `memory: 2Gi` per active recorder and revisit node capacity.

Port and edge notes:

- HTTPS/WSS signaling can use the existing ingress/Tunnel topology.
- RTC UDP/TCP and TURN require hospital-owned L4 exposure.
- Start with a narrow UDP media range sized for expected concurrency, then widen only with firewall approval.
- The root `infra/kubernetes/base/kustomization.yaml` should not include telemedicine until the SFU pick, TURN egress policy, and manual smoke are approved.

## 9. Phased Plan and Test Strategy

### P1 - Backend Provisioning, Held Infra, Browser Smoke

- Add `livekit` provider support in schema/service definitions.
- Implement the provisioning service around `teleconsultations` and `video_sessions`.
- Implement short-TTL token issuing with patient, clinician, and observer roles.
- Implement consent-required-before-token behavior.
- Add held Kubernetes manifests under `infra/kubernetes/base/telemedicine`.
- Add a browser-based manual smoke page or script for staging/manual use only.
- Add automated tests with a mocked SFU API/token signer. Do not use live media in CI.

### P2 - Patient App Join Flow

- Add teleconsult appointment entry point from appointment cards/details.
- Add lobby, device checks, consent, token request, LiveKit Flutter join, audio-only fallback, and secure messaging fallback.
- Ensure no patient can join by raw room name or stale URL.
- Exercise patient portal note visibility after a signed OP note.

### P3 - Staff App Consult Surface

- Add clinician consult room surface in the staff app.
- Add queue badges/statuses for waiting/in-progress teleconsults.
- Add OP note deep-link using the existing appointment-bound note flow.
- Add e-Rx launch point using the existing prescription flow.
- Add end-consult behavior that closes media without bypassing appointment completion rules.

### P4 - Scheduling, Queue, Billing, and Operations Integration

- Add teleconsult-specific scheduling templates if required.
- Decide whether teleconsult appointments need a dedicated queue kind or remain doctor/department queue items with badges.
- Add operational dashboards for join failures, TURN use, final modality, and consent/recording status.
- Integrate post-consult payment-link workflow where applicable.
- Add runbooks for TURN/firewall failures and manual media smoke.

### Test Strategy

CI must not open real media sessions. Follow the mock-service precedent used by the local Ollama smoke:

- Unit tests for token TTL, grants, role mapping, no recording grants, and PHI-minimized metadata.
- Integration tests for appointment booking to teleconsultation to video session provisioning.
- Authorization tests for patient self-access, assigned clinician access, observer restrictions, terminal appointments, and cross-tenant denial.
- Consent tests proving token issuance is blocked until consent is recorded.
- OP note regression tests proving teleconsult documentation still uses the existing appointment-bound OP note gate.
- Patient portal regression tests proving only signed appointment-bound consultation notes are visible.
- Secure messaging fallback tests using `related_appointment_id`.
- Mock LiveKit API tests for room create, room lookup, participant token response, and failure modes.

One manual media smoke should be documented before deploy:

- Two devices on different networks, including one outside the hospital network.
- Patient lobby consent and join.
- Clinician join.
- Video and audio success.
- TURN path verified on a restrictive network or mobile data.
- Deliberate degradation to audio-only and secure messaging.
- OP note creation/signing through existing flow.
- Patient portal visibility of only the signed appointment-bound note.
- e-Rx and payment-link workflow checked if applicable.

## 10. Owner Decisions

1. SFU pick sign-off: approve LiveKit as the self-hosted SFU for NL-3, or explicitly choose Jitsi/mediasoup with the tradeoffs above.
2. TURN egress policy: decide public IP/L4 load balancer/NAT model, allowed UDP/TCP ports, domain/cert ownership, and whether to use LiveKit embedded TURN or dedicated coturn.
3. Staff join surface timing: decide whether the clinician join surface belongs in P3 staff app work, or whether a desktop workbench join path is required before or during P4. Recommendation: P3 should include the staff app clinician consult surface because OP note and prescription workflows already live there.
4. Recording governance: confirm recording remains off for MVP and name the governance owner for any future recording retention policy.
5. Queue model: decide whether `visit_type = 'TELE'` remains a badge on existing doctor/department queues or gets a dedicated teleconsult queue kind in P4.

## 11. Source Notes

Primary external references checked for current SFU and tunnel behavior:

- LiveKit Kubernetes deployment: https://docs.livekit.io/transport/self-hosting/kubernetes/
- LiveKit self-hosted deployment and ports: https://docs.livekit.io/transport/self-hosting/deployment/
- LiveKit Flutter SDK: https://docs.livekit.io/reference/client-sdk-flutter/
- LiveKit token grants: https://docs.livekit.io/frontends/reference/tokens-grants/
- LiveKit server-side token endpoint pattern: https://docs.livekit.io/frontends/build/authentication/endpoint/
- LiveKit RoomComposite/web Egress recording: https://docs.livekit.io/transport/media/ingress-egress/egress/composite-recording/
- mediasoup design: https://mediasoup.org/documentation/v3/mediasoup/design/
- mediasoup client/server model: https://mediasoup.org/documentation/v3/communication-between-client-and-server/
- mediasoup Flutter package listing: https://pub.dev/packages/mediasoup_client_flutter/versions
- Jitsi self-host quickstart: https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-quickstart/
- Jitsi Docker/Jibri recording configuration: https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-docker/
- Jitsi Flutter SDK: https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-flutter-sdk/
- Cloudflare Tunnel supported service protocols: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/
