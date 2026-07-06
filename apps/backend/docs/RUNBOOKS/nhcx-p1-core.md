# NHCX P1 Core Runbook

Status: P1 backend core is implemented but disabled by default. Treat all
gateway endpoint names, profile URLs, and JWE/signature details as design-target
until the live NHCX/NRCeS sandbox package is locked by the operator.

## Scope

Implemented P1 surfaces:

- Exchange envelope: `nhcx_messages` migration `359_nhcx_messages.sql`.
- Tenant config: `tenants.settings.nhcx`.
- Tenant secret kinds in `tenant_interop_secrets`:
  - `nhcx_api_token`
  - `nhcx_jwe_private_key`
  - `nhcx_callback_secret`
- FHIR builders:
  - CoverageEligibilityRequest bundle from `insurance_policies`.
  - Preauth Claim bundle from `insurance_preauth`.
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
- Local mock exchange and smoke script.

Not implemented in P1:

- Final claim `/claim/submit`.
- Communication/attachments.
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
- `POST /api/v1/admin/nhcx/dispatch-now`
- `GET /api/v1/admin/nhcx/messages`
- `GET /api/v1/admin/nhcx/messages/:id`
- `POST /api/v1/admin/nhcx/messages/:id/redrive`

Public callback endpoints:

- `POST /api/v1/integrations/nhcx/coverageeligibility/on_check`
- `POST /api/v1/integrations/nhcx/preauth/on_submit`

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
- `/__admin/requests`

Set these optional env vars to make the mock post callbacks:

```bash
NHCX_MOCK_CALLBACK_BASE_URL=http://127.0.0.1:4000/api/v1/integrations/nhcx/
NHCX_MOCK_CALLBACK_SECRET=test-callback-secret
NHCX_MOCK_JWE_SECRET=test-jwe-secret-32-byte-minimum
```

## Verification

Focused P1 unit/regression slice:

```bash
node --experimental-vm-modules --max-old-space-size=4096 node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/tests/unit/nhcxFhirProfileService.test.js src/tests/unit/nhcxOutboundDispatcherService.test.js src/tests/unit/nhcxInboundCallbackService.test.js src/tests/unit/nhcxCallbackRoutes.test.js src/tests/unit/nhcxP1Regression.test.js
```

Mock smoke:

```bash
npm run smoke:nhcx:mock
```

Before live enablement, re-run schema drift, OpenAPI sync/check, lint, full
backend CI, and a live sandbox certification smoke with owner-provided NHCX
credentials.
