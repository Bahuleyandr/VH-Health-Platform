# NHCX P1/P2/P3 Core Runbook

Status: P1 backend core is implemented and P2 claim-cycle plus P3
communication/attachment support are in review, but the integration is still
disabled by default. Treat all
gateway endpoint names, profile URLs, and JWE/signature details as design-target
until the live NHCX/NRCeS sandbox package is locked by the operator.

## Scope

Implemented P1/P2/P3 surfaces:

- Exchange envelope: `nhcx_messages` migration `359_nhcx_messages.sql`.
- Tenant config: `tenants.settings.nhcx`.
- Tenant secret kinds in `tenant_interop_secrets`:
  - `nhcx_api_token`
  - `nhcx_jwe_private_key`
  - `nhcx_callback_secret`
- FHIR builders:
  - CoverageEligibilityRequest bundle from `insurance_policies`.
  - Preauth Claim bundle from `insurance_preauth`.
  - Final/reimbursement Claim bundle from `tpa_claims`.
  - Communication response bundle from `tpa_claim_correspondence` plus
    explicitly selected `tpa_claim_documents`.
  - Task bundle for claim status checks.
- Outbound dispatcher:
  - JWE compact encryption with `jose`.
  - SSRF-safe gateway fetch.
  - 7-attempt backoff and terminal dead/rejected state.
  - Admin redrive regenerates the current workflow snapshot and clears stale JWE.
- Inbound callbacks:
  - Rate limit before DB/crypto.
  - Tenant resolved by NHCX participant code.
  - Tenant callback-secret HMAC plus shared replay guard.
  - JWE decrypt, idempotent `nhcx_messages` insert, FHIR profile warnings.
  - Preauth `ClaimResponse` maps through `recordPreauthResponse`.
  - Claim `ClaimResponse` maps through `recordClaimDecision` with NHCX
    correspondence metadata and ledger shifting disabled.
  - Bare Task status callbacks are persisted on `nhcx_messages` only and do not
    mutate claim workflow state.
  - CommunicationRequest callbacks map to inbound `tpa_claim_correspondence`
    rows (`direction='inbound'`, `channel='nhcx'`) and move linked
    claim/preauth rows to `queried` only through allowed transitions.
- Local mock exchange and smoke script.

P2 claim-cycle guardrails:

- NHCX uses only the `tpa_claims` / `insurance_preauth` spine.
- Claim submit calls the existing `claimsService.submitClaim` path, so prepared
  state, packet assembly, final-bill, room-cap, and signed-discharge-summary
  gates remain load-bearing.
- Outbound Claim bundles are strictly validated before enqueue.
- ClaimResponse duplicates are no-op callbacks after the idempotent envelope
  insert.
- Ambiguous or unmappable ClaimResponses land in `manual_review`; no payer
  verdict is guessed.
- PaymentNotice and settlement remain out of scope; NHCX P2 does not post
  payments.

P3 communication/attachment guardrails:

- Communication rides only the `tpa_claims` / `insurance_preauth` spine.
- Inbound CommunicationRequest mapping is correlation-id based; unmappable or
  unsupported attachment payloads land in `manual_review`.
- Outbound responses are drafted from an inbound NHCX correspondence row and
  persisted as outbound correspondence before enqueue.
- Only explicitly selected `tpa_claim_documents` for the same tenant and same
  claim/preauth target are packaged.
- No reusable raw R2/S3/document storage URLs are exposed to NHCX. FHIR
  attachment references use internal URNs such as
  `urn:vhhealth:tpa-claim-document:<id>`.
- Attachment MIME and size limits are env-configurable design-target seams; the
  operator must confirm final values against live NHCX docs before enablement.

Not implemented in P3:

- PaymentNotice/payment reconciliation.
- Ledger mutation.
- Tariff-master admin UI.
- Live sandbox certification.

## Feature Flag

`NHCX_ENABLED=false` is the default and keeps the exchange inert. With the flag
off, the scheduler does not dispatch and admin enqueue paths reject instead of
calling a gateway.

Relevant env vars:

```bash
NHCX_ENABLED=false
NHCX_CREDENTIAL_CACHE_TTL_MS=60000
NHCX_GATEWAY_HOST_ALLOWLIST=
NHCX_GATEWAY_ALLOW_PRIVATE_TARGETS=false
NHCX_COMM_ATTACHMENT_ALLOWED_MIME_TYPES=application/pdf,image/jpeg,image/png,text/plain
NHCX_COMM_ATTACHMENT_MAX_BYTES=5242880
NHCX_COMM_ATTACHMENT_TOTAL_MAX_BYTES=20971520
```

Use `NHCX_GATEWAY_ALLOW_PRIVATE_TARGETS=true` only for non-production local mock
testing against loopback.

## Admin Setup

Tenant enrolment endpoints are SUPER_ADMIN step-up protected:

- `GET /api/v1/admin/tenants/:tenantId/nhcx-config`
- `PATCH /api/v1/admin/tenants/:tenantId/nhcx-config`
- `POST /api/v1/admin/tenants/:tenantId/nhcx-secrets`

Minimal config shape:

```json
{
  "enabled": true,
  "environment": "sandbox",
  "participant_code": "VH-NHCX-PROVIDER",
  "counterparty_participant_code": "PAYER-NHCX-MOCK",
  "sandbox_gateway_base_url": "https://gateway.example/v0.9"
}
```

Store each secret with `kind`, `participant_code`, and `secret`. The API returns
only masked metadata.

## Operations

Admin NHCX endpoints:

- `POST /api/v1/admin/nhcx/eligibility/check`
- `POST /api/v1/admin/nhcx/preauth/:preauthId/submit`
- `POST /api/v1/admin/nhcx/claim/:claimId/submit`
- `POST /api/v1/admin/nhcx/claim/:claimId/status`
- `GET /api/v1/admin/nhcx/communication/workbench?claim_id=...`
- `GET /api/v1/admin/nhcx/communication/workbench?preauth_id=...`
- `POST /api/v1/admin/nhcx/communication/:correspondenceId/respond`
- `POST /api/v1/admin/nhcx/dispatch-now`
- `GET /api/v1/admin/nhcx/messages`
- `GET /api/v1/admin/nhcx/messages/:id`
- `POST /api/v1/admin/nhcx/messages/:id/redrive`

Public callback endpoints:

- `POST /api/v1/integrations/nhcx/coverageeligibility/on_check`
- `POST /api/v1/integrations/nhcx/preauth/on_submit`
- `POST /api/v1/integrations/nhcx/claim/on_submit`
- `POST /api/v1/integrations/nhcx/claim/on_status`
- `POST /api/v1/integrations/nhcx/communication/request`

Callback authentication currently requires a tenant-scoped HMAC signature with
headers:

- `x-hcx-recipient_code`
- `x-hcx-sender_code`
- `x-hcx-timestamp`
- `x-hcx-request-id`
- `x-nhcx-signature`

This is the design-target seam until the live gateway signature/JWT contract is
confirmed.

## Local Mock

Start the mock exchange:

```bash
npm run nhcx:mock
```

Run the mock smoke:

```bash
npm run smoke:nhcx:mock
```

The mock accepts:

- `/v0.9/coverageeligibility/check`
- `/v0.9/preauth/submit`
- `/v0.9/claim/submit`
- `/v0.9/claim/status`
- `/v0.9/communication/request`
- `/__admin/requests`

For `claim/submit`, pass `x-nhcx-mock-outcome: approve`, `partial`, `deny`, or
`query` to choose the deterministic callback variant. `query` emits a
CommunicationRequest callback to `/communication/request`; the same mock endpoint
accepts the provider's outbound Communication response and records correlation
continuity.

Set these optional env vars to make the mock post callbacks:

```bash
NHCX_MOCK_CALLBACK_BASE_URL=http://127.0.0.1:4000/api/v1/integrations/nhcx/
NHCX_MOCK_CALLBACK_SECRET=test-callback-secret
NHCX_MOCK_JWE_SECRET=test-jwe-secret-32-byte-minimum
```

## Verification

Focused P1/P2/P3 unit/regression slice:

```bash
node --experimental-vm-modules --max-old-space-size=4096 node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/tests/unit/nhcxFhirProfileService.test.js src/tests/unit/nhcxClaimFhirProfileService.test.js src/tests/unit/nhcxOutboundDispatcherService.test.js src/tests/unit/nhcxInboundCallbackService.test.js src/tests/unit/nhcxCommunicationP3.deep.test.js src/tests/unit/nhcxCallbackRoutes.test.js src/tests/unit/nhcxP1Regression.test.js
```

Mock smoke:

```bash
npm run smoke:nhcx:mock
```

Before live enablement, re-run schema drift, OpenAPI sync/check, lint, full
backend CI, and a live sandbox certification smoke with owner-provided NHCX
credentials.
