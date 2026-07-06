# NL-2 NHCX Claims Exchange Design

**Date:** 2026-07-05
**Status:** P1 shipped; P2 claim cycle in review as inert/mock-first design-target implementation
**Program:** NL-2 NHCX claims exchange
**Surface:** backend insurance/TPA workflow, FHIR/profile tooling, admin tariff master

## Non-Goals

This document proposes no application code, migrations, generated clients, or UI
changes. It is the decision record for a later implementation plan.

The `insurance_claims` and `tpa_claims` tables remain deliberately separate.
`insurance_claims` is the legacy billing-driven claim surface behind billing
routes. `tpa_claims` is the TPA cashless/reimbursement workflow behind
`/api/v1/insurance/*` and `claimsService.js`. NHCX must ride the
`tpa_claims` / `insurance_preauth` spine and must not consolidate the two claim
families.

## Source Snapshot and Version Risk

NHCX is described by the NRCeS ABDM FHIR Implementation Guide and the HCX
protocol documents. As of this design pass on 2026-07-06:

- NRCeS exposes an active ABDM FHIR IG `7.0.0`, generated 2026-06-26, with NHCX
  profiles for ClaimBundle, ClaimResponseBundle, CoverageEligibilityRequest/
  Response bundles, InsurancePlanBundle, TaskBundle, Claim, ClaimResponse,
  Communication, CommunicationRequest, CoverageEligibilityRequest/Response,
  InsurancePlan, PaymentNotice, PaymentReconciliation, and Task.
- The public HCX protocol docs present v0.9 pages for asynchronous exchange
  APIs, protocol headers, registry APIs, API token security, and JWE payload
  encryption. Some pages are marked "last updated 1 year ago"; NHCX production
  sandbox behavior may have moved ahead of those pages.

Owner verification is required before build starts: lock the exact NHCX/NRCeS
package version, sandbox OpenAPI bundle, participant onboarding guide,
certificate/JWE requirements, callback URL contract, and dummy payer behavior
from the live NHCX portal. Treat every endpoint/header name below as a design
target until checked against the live NHCX documents.

Primary references read for this design:

- NRCeS NHCX Profiles: https://www.nrces.in/preview/ndhm/fhir/r4/hcx-profile.html
- HCX API structure: https://docs.hcxprotocol.io/hcx-technical-specifications/open-protocol/key-components-building-blocks/api-structure
- HCX primary flow APIs: https://docs.hcxprotocol.io/hcx-technical-specifications/open-protocol/key-components-building-blocks/api-structure/primary-flow-apis
- HCX domain data models: https://docs.hcxprotocol.io/hcx-domain-specifications/domain-data-models
- HCX message structure: https://docs.hcxprotocol.io/hcx-technical-specifications/open-protocol/key-components-building-blocks/message-structure
- HCX registries: https://docs.hcxprotocol.io/hcx-technical-specifications/open-protocol/registries
- HCX registry APIs: https://docs.hcxprotocol.io/hcx-technical-specifications/open-protocol/key-components-building-blocks/api-structure/registry-apis
- HCX API security: https://docs.hcxprotocol.io/hcx-technical-specifications/open-protocol/data-security-and-privacy/api-security
- HCX message security and integrity: https://docs.hcxprotocol.io/hcx-technical-specifications/open-protocol/data-security-and-privacy/message-security-and-integrity

## Protocol Summary

NHCX/HCX is an asynchronous claims-exchange rail for providers, payors,
processors, and TPAs. The exchange routes messages by participant registry code
and protocol headers. The domain payload is a FHIR R4 eObject, typically inside
an NHCX/HCX profiled Bundle, encrypted as a JWE so the exchange can route and
audit without reading the clinical/financial payload.

The public HCX API pattern is:

`https://<server>/<version>/<resource>/<action|on_action>`

Primary cycles relevant to VH Health:

- Coverage eligibility: provider sends `/coverageeligibility/check`; payor
  responds asynchronously to `/coverageeligibility/on_check`. Payloads use
  CoverageEligibilityRequest and CoverageEligibilityResponse bundles.
- Preauth: provider sends `/preauth/submit`; payor responds to
  `/preauth/on_submit`. Payload is a Claim Request Bundle with
  `Claim.use = preauthorization`; response is a ClaimResponse Bundle with
  `ClaimResponse.use = preauthorization`.
- Claim: provider sends `/claim/submit`; payor responds to `/claim/on_submit`.
  Payload is a Claim Request Bundle with `Claim.use = claim`; response is a
  ClaimResponse Bundle with `ClaimResponse.use = claim`.
- Communication and attachments: payors can request more information through
  `/communication/request`; providers respond with Communication payloads.
  HCX Task supports status checks and status responses.
- Payment notice: payor sends `/paymentnotice/request`; provider acknowledges
  through the corresponding callback/response flow. Payload uses PaymentNotice
  and usually PaymentReconciliation.

Headers to persist in every message envelope include sender/recipient registry
codes, `x-hcx-api_call_id`, `x-hcx-correlation_id`, optional
`x-hcx-workflow_id`, timestamp, operational status, redirect target, and
error/debug details. The design should map `x-hcx-workflow_id` to the admission
or episode, `x-hcx-correlation_id` to the NHCX cycle, and `x-hcx-api_call_id`
to idempotent individual requests.

## Existing Spine

Local surfaces read for this design:

- `docs/NEXT_LEVEL_ROADMAP.md`: NL-2 is explicitly design-first and requires an
  NHCX FHIR claim/preauth/communication cycle on the `tpa_claims` /
  `insurance_preauth` spine, registry enrolment ops, tariff-master UI, and the
  existing `insurance_claims`/`tpa_claims` split.
- `apps/backend/CLAUDE.md`: the split between `insurance_claims` and
  `tpa_claims` is binding.
- `apps/backend/src/migrations/153_insurance_claims_workflow.sql`: defines
  `insurance_policies`, `insurance_preauth`, `insurance_preauth_responses`,
  `tpa_claims`, `tpa_claim_documents`, `tpa_claim_correspondence`, and the
  claim aging view.
- `apps/backend/src/migrations/218_tpa_claims_settled_partial.sql`: preserves
  partial settlements through `settled_partial` and `disallowed_amount`.
- `apps/backend/src/migrations/221_tpa_claims_stage_hierarchy.sql`: adds
  `stage` and `parent_claim_id` for preauth/enhancement/final/reimbursement
  chain reconstruction.
- `apps/backend/src/migrations/227_insurance_preauth_submit_sla.sql`: adds the
  submission SLA surface for draft preauths.
- `apps/backend/src/services/insurance/claimsService.js`: owns policy,
  preauth, preauth response, claim, claim decision, claim payment, documents,
  correspondence, warnings, and ledger shift behavior.
- `apps/backend/src/migrations/124_abdm_hip_hiu.sql` and ABDM routes/services:
  provide the callback, signature, tenant binding, and webhook-event patterns
  NHCX should mirror.
- `apps/backend/src/services/fhir`: provides the current FHIR R4 adapter and
  validator posture.
- `apps/backend/src/migrations/115_integration_webhook_registry.sql`,
  `eventOutboxService.js`, `webhookDeliveryService.js`, and `scheduler.js`:
  provide durable outbox, retry, backoff, and dead-letter mechanics.

The source of truth stays:

- `insurance_preauth` for planned/emergency/enhancement preauthorization.
- `insurance_preauth_responses` for payer decisions, queries, denials,
  sanctioned amounts, caps, and raw payer payloads.
- `tpa_claims` for cashless/reimbursement claim lifecycle.
- `tpa_claim_documents` and `tpa_claim_correspondence` for supporting packets
  and exchange communications.
- Existing ledger behavior for `INSURANCE_AR`, untouched except for a later
  reviewed payment-notice hook.

## Proposed Exchange Envelope

Add a later migration for a tenant-scoped, RLS-forced `nhcx_messages` table.
This table is an exchange envelope, not a second claim workflow.

Conceptual fields:

- `id`
- `tenant_id`
- `environment`: `sandbox` or `production`
- `direction`: `outbound` or `inbound`
- `cycle`: `eligibility`, `preauth`, `claim`, `communication`, `task`,
  `payment_notice`
- `endpoint`: for example `coverageeligibility/check`, `preauth/on_submit`
- `participant_code_self`
- `participant_code_counterparty`
- `hcx_api_call_id`
- `hcx_correlation_id`
- `hcx_workflow_id`
- `hcx_status`
- `claim_id` nullable FK to `tpa_claims`
- `preauth_id` nullable FK to `insurance_preauth`
- `policy_id` nullable FK to `insurance_policies`
- `patient_uid`
- `admission_id`
- `domain_resource_type`: `CoverageEligibilityRequest`, `Claim`,
  `ClaimResponse`, `Communication`, `PaymentNotice`, etc.
- `profile_url` and `profile_version`
- `payload_hash`
- `protected_headers`
- `payload_ciphertext` or object-storage reference for the raw JWE
- `payload_plaintext_ref` only for short-lived debug/test capture, disabled in
  production unless explicitly owner-approved
- `signature_verified`
- `registry_key_id` / `certificate_thumbprint`
- `status`: `pending`, `accepted`, `sent`, `processed`, `duplicate`,
  `failed`, `dead`, `rejected`, `manual_review`
- `attempt_count`, `last_error`, `next_retry_at`
- `received_at`, `sent_at`, `processed_at`, `created_at`, `updated_at`

Idempotency mirrors `abdm_webhook_events`:

- Unique `(tenant_id, hcx_api_call_id, environment)` where available.
- Unique `(tenant_id, hcx_correlation_id, endpoint, direction, payload_hash,
  environment)` as a safety net for callbacks that reuse or omit api-call ids.
- Inbound callbacks first authenticate, resolve tenant, insert/claim the
  `nhcx_messages` row, and only then mutate `insurance_preauth` or
  `tpa_claims`.
- A duplicate callback returns the protocol-level accepted response and leaves
  workflow rows unchanged.
- Failed validation is recorded on the envelope and routed to manual review
  instead of losing the exchange evidence.

RLS posture:

- `tenant_id uuid NOT NULL`
- `ENABLE ROW LEVEL SECURITY`
- `FORCE ROW LEVEL SECURITY`
- canonical `tenant_isolation` policy using `app_current_tenant_id_uuid()`
- no permissive cross-tenant lookup except the pre-HMAC participant-code
  resolver pattern used by ABDM callback secrets

## Callback and Crypto Pattern

NHCX callbacks should reuse the ABDM callback shape where the protocols match:

1. Rate-limit the public callback mount before DB/crypto work.
2. Resolve tenant from the presented NHCX participant/sender identifier before
   secret or private-key lookup.
3. Load per-tenant credentials from the `tenant_interop_secrets` pattern.
4. Verify API token/JWT or gateway signature as required by the live NHCX
   sandbox contract.
5. Enforce freshness and replay protection using the signed-request replay
   pattern where applicable.
6. Decrypt/verify JWE only after tenant and participant are known.
7. Insert/claim `nhcx_messages` for idempotency.
8. Validate FHIR profile conformance.
9. Apply the domain mutation or mark manual review.

Credential material should never be global-only in production. Required
per-tenant records likely include:

- NHCX participant code for provider/HIP/HFR mapping.
- Sandbox and production gateway base URLs.
- Participant API-token credentials or token-generation secret.
- JWE private key/certificate chain for inbound decryption.
- Counterparty public-key cache metadata from registry lookups.
- Callback verification secret or signing certificate if the live sandbox uses
  detached signatures in addition to JWE integrity.

Store secrets encrypted like `tenant_interop_secrets.secret_ciphertext`.
Participant code must be globally unique for pre-auth tenant resolution, just as
ABDM callback secrets use `kind + sender_identifier`.

## FHIR Generation and Validation

The existing FHIR module is useful but not sufficient for NHCX financial
profiles. Current `fhirValidator.js` is a lightweight R4 conformance checker
that validates required fields and enums, returns OperationOutcome on invalid
single-resource outbound responses, and logs bundle issues for permissive
search/export paths. NHCX needs an extra profile layer:

- Add a future `nhcxFhirProfileService` that composes the existing mappers with
  NHCX-specific builders for CoverageEligibilityRequest/Response, Claim,
  ClaimResponse, Communication, CommunicationRequest, Task, PaymentNotice, and
  PaymentReconciliation.
- Keep internal IDs stable and explicit:
  - `insurance_preauth.id` -> Claim.identifier and Claim.related/focus for
    preauthorization.
  - `tpa_claims.id` -> Claim.identifier for final/reimbursement claims.
  - `admission_id` -> Encounter reference and `x-hcx-workflow_id`.
  - `insurance_policies.policy_number` -> Coverage.identifier.
  - `tpa_claim_documents` -> DocumentReference/attachments.
- Generate bundles from deterministic snapshots of workflow rows, not live
  mutable object references. Persist `payload_hash` before dispatch.
- Validation posture:
  - Inbound: informational plus safety gates. Record all profile issues on
    `nhcx_messages`; reject only if tenant/auth/decryption/idempotency fails or
    the payload is structurally impossible to map.
  - Outbound: strict. Do not enqueue an NHCX outbound message if the profiled
    FHIR bundle fails required NHCX profile validation.
  - Deep tests should run the official validator package or HAPI/HL7 validator
    against committed NHCX sample bundles once the owner locks the package.

## Workflow Mapping

### Eligibility

Eligibility requests originate from `insurance_policies` plus patient/admission
context. Store each outbound CoverageEligibilityRequest in `nhcx_messages` with
`cycle = eligibility`, `policy_id`, optional `admission_id`, and the HCX
correlation/workflow ids. CoverageEligibilityResponse updates policy metadata
only after manual review unless the response is a clear plan/coverage detail
that does not change adjudication.

### Preauth

`insurance_preauth` remains the workflow source of truth:

- Draft row created locally.
- NHCX submit emits a Claim Request Bundle with `Claim.use = preauthorization`.
- Successful gateway acceptance updates only exchange metadata
  (`submission_channel = 'nhcx'`, `tpa_reference_id` if provided, and envelope
  state).
- Payor callback creates an `insurance_preauth_responses` row and then applies
  the existing status transition (`queried`, `approved`, `partially_approved`,
  `denied`) through the claims service.
- Enhancements use `insurance_preauth.parent_preauth_id` and
  `request_type = 'enhancement'`, not child rows in `tpa_claims` and not
  billing-side `insurance_claims`.

### Claim

`tpa_claims` remains the source of truth for final cashless and reimbursement
claims:

- Existing packet assembly gates remain mandatory.
- Outbound `/claim/submit` uses Claim Request Bundle with `Claim.use = claim`.
- Inbound ClaimResponse maps to `recordClaimDecision` when it is a true
  adjudication result.
- A callback that asks for more data maps to `tpa_claim_correspondence` and
  `status = queried`; it must not bypass existing document gates.
- `insurance_claims` is never probed as a fallback for NHCX message handling.

### Communication and Attachments

NHCX CommunicationRequest maps to `tpa_claim_correspondence` with
`direction = inbound`, `channel = nhcx`, and links to either `preauth_id` or
`claim_id`. Provider responses map to outbound Communication bundles and
optionally attach existing `tpa_claim_documents`.

Attachment handling must reuse existing R2/document safety:

- Never expose reusable raw storage URLs to NHCX.
- Include only documents explicitly selected or required by the packet builder.
- Persist document references in `tpa_claim_documents`; keep binary payload
  packaging and NHCX attachment-size behavior behind the future profile layer.

### Payment Notice

PaymentNotice/PaymentReconciliation is inbound payor evidence, not an automatic
settlement command in v1.

P4 may create a finance review task and prefill a settlement draft for
`recordClaimPayment`, but finance must approve before status or ledger changes.
This protects the current ledger behavior where `INSURANCE_AR` shifts are tied
to reviewed claim decisions/payments.

## Tariff-Master Admin UI Companion

The roadmap flags the tariff/rate-card editor as a companion deliverable. The
backend substrate already exists:

- `tariff_plans`
- `tariff_items`
- `payer_tariff_links`
- `/api/v1/admin/billing-masters/tariff-plans`
- `/api/v1/admin/billing-masters/tariff-items`
- `/api/v1/admin/billing-masters/payer-tariff-links`
- price resolution and payer/TPA master routes

The missing UI should be scoped to:

- list/create/edit tariff plans with default plan, currency, dates, and status
- bulk import/export tariff items by service code, kind, unit, tax, effective
  dates, and metadata
- payer/TPA to tariff-plan linking with primary plan and date windows
- diff view between current and proposed rate cards
- approval/publish workflow for finance admin before a rate card becomes active
- NHCX readiness checks showing missing payer link, missing service code, stale
  tariff, or unpriced room/package items

The UI is not the NHCX exchange. It makes outbound claim amounts defensible and
reduces avoidable payor queries. It must not auto-adjust existing invoices or
claims without explicit finance action.

## Failure, Retry, and Dead-Letter

NHCX outbound intent should reuse the existing durable delivery posture:

- Write a business event to `event_outbox` after the local workflow row commits.
- A dedicated NHCX dispatcher or an adapter over the webhook delivery pipeline
  claims due rows with `FOR UPDATE SKIP LOCKED`.
- Build/sign/encrypt the NHCX JWE at dispatch time using current credentials.
- Call the NHCX gateway with SSRF-safe outbound fetch and the configured
  allowlist.
- Persist every attempt to `nhcx_messages` and/or a delivery-attempt child table
  with HTTP status, response excerpt, request id, and error.
- Use the same backoff ladder and terminal dead-letter semantics as
  `eventOutboxService` / `webhookDeliveryService` (7 attempts, then terminal
  `failed`/`dead` for admin redrive).
- Admin redrive must revalidate the current workflow snapshot and regenerate the
  JWE; it must not resend stale plaintext.

Inbound failures are not retried by the provider. They are recorded on
`nhcx_messages` and surfaced for manual repair. Duplicate inbound callbacks are
safe no-ops.

## Manual in v1

Keep these manual in the first NHCX release:

- adjudication decisions when the response is ambiguous, partial, redirected,
  structurally invalid, or payer-text-only
- final claim packet selection when the required documentation set is unclear
- communication response wording and attachment selection
- settlement reconciliation and payment posting
- ledger write-off, disallowance acceptance, or patient balance transfer
- payer contract variance actions and appeal generation

The existing `INSURANCE_AR` ledger flow remains untouched. NHCX can prefill and
audit; it cannot settle money without finance review in v1.

## Phased Plan

### P1 - Eligibility and Preauth Outbound

Deliver:

- per-tenant NHCX credentials/enrolment configuration
- `nhcx_messages` envelope and idempotent inbound callback pattern
- CoverageEligibilityRequest outbound and CoverageEligibilityResponse inbound
- Preauth Claim Request outbound for `insurance_preauth`
- ClaimResponse inbound mapped to `insurance_preauth_responses`
- no claim cycle, no payment notice, no ledger changes

Deep tests:

- build official/sample CoverageEligibilityRequest and preauth bundles and run
  lightweight plus official validator checks
- duplicate `/coverageeligibility/on_check` callback is idempotent
- duplicate `/preauth/on_submit` callback does not double-write responses
- callback for tenant A cannot update tenant B preauth
- outbound strict validation blocks enqueue on missing required NHCX profile
  fields
- mock exchange server accepts `/coverageeligibility/check` and
  `/preauth/submit`, records headers/JWE, and posts deterministic callbacks

Implementation note 2026-07-06:

- P1 backend core is implemented inert behind `NHCX_ENABLED=false`.
- The exchange envelope is `nhcx_messages` migration `359_nhcx_messages.sql`.
- Tenant enrolment/config lives under `tenants.settings.nhcx`; secret kinds are
  `nhcx_api_token`, `nhcx_jwe_private_key`, and `nhcx_callback_secret`.
- Outbound admin endpoints live under `/api/v1/admin/nhcx/*`; callbacks live
  under `/api/v1/integrations/nhcx/*`.
- Local mock scripts are `npm run nhcx:mock` and `npm run smoke:nhcx:mock`.
- Operator must still lock the live NHCX/NRCeS version, sandbox OpenAPI,
  callback auth, and certificate/JWE requirements before enabling the flag.

### P2 - Claim Cycle

Deliver:

- `/claim/submit` outbound for `tpa_claims`
- ClaimResponse inbound mapped through existing claim decision transitions
- claim status query/task support if required by the locked sandbox docs
- no payment posting

Deep tests:

- cashless final claim with documents emits Claim Bundle and preserves
  `tpa_claims.stage`
- reimbursement claim uses the same `tpa_claims` surface and never touches
  `insurance_claims`
- duplicate ClaimResponse is idempotent
- invalid transition is rejected and recorded on `nhcx_messages`
- partial approval and denial preserve `approved_amount`,
  `disallowed_amount`, and denial reason semantics

Implementation note 2026-07-06:

- P2 backend claim-cycle support is implemented for review behind
  `NHCX_ENABLED=false`.
- Outbound `/claim/submit` builds Claim Request bundles with `Claim.use =
  claim` from deterministic `tpa_claims` snapshots and selected
  `tpa_claim_documents` as DocumentReference stubs.
- Claim submit reuses `claimsService.submitClaim`, so cashless-final packet,
  final-bill, room-cap, and signed-discharge-summary gates remain mandatory.
- Inbound `/claim/on_submit` inserts the `nhcx_messages` envelope before
  workflow mutation, maps true ClaimResponse adjudications through
  `recordClaimDecision`, maps information requests to `queried`, and sends
  ambiguous responses to `manual_review`.
- Task-based claim status check/response is present as a mock-target seam and
  does not mutate `tpa_claims`.
- PaymentNotice, settlements, and ledger posting remain out of scope for P2.
- Operator must still lock the live NHCX/NRCeS version, sandbox OpenAPI,
  callback auth, and certificate/JWE requirements before enabling the flag.

### P3 - Communications and Attachments

Deliver:

- inbound CommunicationRequest -> `tpa_claim_correspondence`
- outbound Communication response with selected `tpa_claim_documents`
- attachment packaging policy and size/type enforcement based on live NHCX docs
- admin/workbench UI affordance for "respond to NHCX query"

Deep tests:

- payor query creates correspondence and moves preauth/claim to `queried` only
  through allowed transitions
- selected attachments must belong to the same tenant and same claim/preauth
- duplicate communication callback does not duplicate correspondence
- unsupported attachment types route to manual review
- mock exchange validates correlation id continuity across request/response

### P4 - Payment Notice to Ledger Review Hook

Deliver:

- inbound PaymentNotice/PaymentReconciliation capture
- finance review queue that links notice to `tpa_claims`
- prefilled settlement draft for existing `recordClaimPayment`
- explicit reviewer approval before ledger/status mutation

Deep tests:

- PaymentNotice alone does not change `tpa_claims.status`
- PaymentNotice alone does not post ledger entries
- approved finance action calls the existing settlement path and preserves
  payer mismatch guardrails
- duplicate notice is idempotent
- short-pay notice routes to `settled_partial` only after reviewer approval

## Mock Exchange Precedent

Follow the local Ollama smoke precedent:

- provide a small Node mock exchange server for deep tests and local smoke
- expose deterministic endpoints for check/submit/on_submit/paymentnotice
- record received protected headers and payload hashes
- offer helper endpoints for test assertions, similar to the mock Ollama hit
  counter
- keep the mock in scripts/test space, not in application runtime
- run it on loopback with explicit port selection and clean teardown

This gives deterministic NHCX evidence without requiring sandbox availability
for every CI pass. Separate sandbox certification tests should run only when
owner-provided credentials are present.

## Owner Decisions Before Build

- Which live NHCX/NRCeS version and sandbox OpenAPI package is authoritative?
- Which participant codes map to each VH Health tenant/facility?
- Who owns NHCX sandbox enrolment and production onboarding?
- What certificates/keys are required for JWE, signatures, and callback
  verification?
- Where will certificate private keys be generated, rotated, backed up, and
  escrowed?
- Which gateway URLs and callback URLs are approved for sandbox and production?
- Which payer/TPA participants are in the pilot, and do their identifiers map to
  current `payers` / `tpas` master rows?
- What attachment size/type limits must the packet builder enforce?
- What is the retention policy for encrypted JWE payloads and decrypted debug
  artifacts?
- What is the finance approval policy for PaymentNotice settlement drafts?
- Who approves tariff-card changes and payer tariff links?
- Is a live NHCX sandbox certification smoke required before NL-2 can be marked
  shipped?

## Acceptance Boundary

NL-2 implementation can be considered ready to start only after the owner locks
the protocol version, credentials, sandbox participant details, and tariff UI
scope. Implementation is complete only when every phase ships through PRs with
deep tests, mock-exchange smoke evidence, and docs updated with the exact live
NHCX version used.
