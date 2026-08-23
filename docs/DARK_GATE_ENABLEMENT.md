# Dark-gate enablement runbook

How to take the three highest-value dark-shipped integrations live: payment
gateway (Razorpay), SMS (MSG91/Twilio with TRAI DLT), and the ABDM sandbox
legs. Every gate in this platform follows the same fail-closed pattern:

```
effective = env kill switch  AND  tenants.settings flag  AND  provider config row
```

All three layers are visible per tenant in the SUPER_ADMIN **Integrations &
Gates** console (`/dashboard/integration-gates`, backed by
`GET /api/v1/admin/integration-gates`), which also names the layer currently
holding a feature dark. Secrets are write-only everywhere: reads return
`has_*` presence booleans, never values.

Tenant flags are stored in the `tenants.settings` JSONB and written through
`PATCH /api/v1/admin/tenants/:tenantId` (SUPER_ADMIN + step-up). The PATCH
**replaces** the generic settings object, so always send the full current
settings with just your key changed — the console's toggle buttons do this
merge for you. Env switches live in the backend deployment configmap
(`infra/kubernetes/apps/backend/`); changing them is an ArgoCD deploy + sync,
not an API call.

When a new gate darkens endpoints that an admin dashboard page still calls on
load, add a matching entry to `EXPECTED_DARK_GATE_RESPONSES` in
`apps/admin/e2e/route-crawl.spec.ts` — otherwise the nightly Smoke E2E route
crawl flags the intended 503/403 and breaks.

---

## 1. Payment gateway — sandbox → live (Razorpay)

Resolution logic: `apps/backend/src/services/billing/paymentGatewayService.js`
(`resolveGatewayContext`). All three layers AND together; a non-`dry_run`
provider additionally requires complete credentials
(`key_id` + `key_secret` + `webhook_secret`), otherwise the context reports
`credentials_incomplete` and the feature stays dark.

### Layers

| Layer | Setting | How |
|---|---|---|
| Env | `PAYMENT_GATEWAY_ENABLED=true` | backend configmap + ArgoCD sync |
| Tenant flag | `settings.paymentGateway.enabled=true` | console toggle, or `PATCH /api/v1/admin/tenants/:tenantId` |
| Config row | enabled `payment_gateway_provider_configs` row | `PUT /api/v1/billing/gateway/config` (ADMIN role, tenant server-resolved) |

### Sandbox bring-up

1. Create a Razorpay **test-mode** key pair in the Razorpay dashboard.
2. `PUT /api/v1/billing/gateway/config` with:
   ```json
   {
     "provider": "razorpay",
     "environment": "sandbox",
     "enabled": true,
     "key_id": "rzp_test_…",
     "key_secret": "<test key secret>",
     "webhook_secret": "<webhook signing secret you choose>",
     "accepted_methods": ["upi", "card"]
   }
   ```
   The response includes `webhook_path` (`/webhooks/payments/<token>` — an
   opaque per-tenant routing token minted once and stable thereafter).
3. In the Razorpay dashboard, register the webhook URL
   `https://api.vhhealth.app/webhooks/payments/<token>` with the same
   webhook secret, subscribing at least `payment.captured` and
   `refund.processed`.
4. Set `PAYMENT_GATEWAY_ENABLED=true` and flip the tenant flag.
5. `dry_run` note: a `provider: "dry_run"` config row works with **no
   credentials** — use it to exercise the order → paid → ledger spine before
   any Razorpay account exists.

### Verification (sandbox)

1. `POST /api/v1/billing/gateway/orders` (requires an `Idempotency-Key`
   header) against a test invoice/payment link → order created with a
   provider order id.
2. Pay it with a Razorpay test instrument; confirm the `payment.captured`
   webhook lands (delivery is HMAC-verified, replay-safe) and the invoice
   books a `billing_payments` row with `reference = provider_payment_id`.
3. `POST /api/v1/billing/gateway/refunds` (finance/cashier/admin roles +
   `Idempotency-Key`) → confirm `refund.processed` webhook and ledger effect.
4. Drill the reconciliation queues:
   `GET /api/v1/billing/gateway/reconciliation` and
   `GET /api/v1/billing/gateway/refund-reconciliation` should be empty; if a
   webhook was dropped, resolve via
   `POST /api/v1/billing/gateway/orders/:id/reconcile`.

### Going live

Repeat step 2 with `environment: "production"` and **live-mode** keys, keep
`enabled: true` on exactly the intended row, re-register the production
webhook, and re-run one end-to-end payment + refund with a small real amount.
No code change is involved at any point.

---

## 2. SMS — MSG91 / Twilio with TRAI DLT

Resolution logic: `apps/backend/src/utils/notifications/smsProviders/index.js`
(`resolveSmsProviderContext`). Order: env kill switch → tenant flag →
tenant config row → env-credential fallback → dry-run logger. DLT is
fail-closed for every real provider: a template kind with no active
registration terminally rejects with `dlt_template_not_registered` — the
platform never sends an unregistered template.

### Layers

| Layer | Setting | How |
|---|---|---|
| Env | `SMS_PROVIDER` — `logger` is the deployment-wide kill switch (everything dry-runs); `msg91`/`twilio` also enables the env-credential fallback | backend configmap |
| Tenant flag | `settings.sms.enabled=true` | console toggle, or tenant PATCH |
| Config row | enabled `sms_provider_configs` row + DLT template registrations | `PUT /api/v1/admin/notifications/sms/config`, `POST /api/v1/admin/notifications/sms/templates` |

### Operator-side DLT registration (external, has lead time — start first)

TRAI's DLT regime is a regulatory prerequisite, done on a DLT registrar
portal (Vodafone/Jio/Airtel/BSNL portals), not in this platform:

1. Register the hospital as a **Principal Entity** → yields the
   **DLT entity ID** (`dlt_entity_id`).
2. Register the **sender ID** (6-char alphanumeric header, e.g. `VHHOSP`).
3. Register each message **content template** (OTP, appointment reminder,
   alert…) → each yields a **DLT content template ID**. Variables must match
   the platform's rendered outbox templates exactly.
4. If using MSG91: link the DLT entity + templates to the MSG91 account and
   note MSG91's flow/template ids (`provider_template_id`).

### Platform bring-up

1. `PUT /api/v1/admin/notifications/sms/config`:
   ```json
   {
     "provider": "msg91",
     "enabled": true,
     "sender_id": "VHHOSP",
     "dlt_entity_id": "<principal entity id>",
     "auth_key": "<MSG91 auth key>"
   }
   ```
   (Twilio instead: `provider: "twilio"`, `account_sid` required, and the
   deployment needs a valid `PUBLIC_BASE_URL` for status callbacks.)
   If the response mints a DLR callback token it is returned **exactly
   once** as `callback_token` + `dlr_path`; configure it at the provider and
   store it now — only its hash is retained.
2. Register every template kind the outbox sends:
   `POST /api/v1/admin/notifications/sms/templates` with
   `{ "template_key": "<outbox template key>", "dlt_template_id": "…",
   "provider_template_id": "…" }`.
3. Flip the tenant flag (`settings.sms.enabled=true`).
4. Set `SMS_PROVIDER=msg91` (or `twilio`) in the deployment — anything but
   `logger` opens the kill switch.

### Verification

1. Trigger a low-risk send (e.g. an appointment reminder for a test
   patient). Watch the notification outbox: the row must go
   `PENDING → CLAIMED → SENT`, and `SENT` is only possible with an
   acknowledged `notification_provider_receipts` row — a send call alone is
   not delivery.
2. Confirm a delivery receipt arrives on the DLR callback
   (`/webhooks/sms/dlr/<token>` or `/webhooks/sms/twilio-status/<token>`).
3. Negative check: a template kind you deliberately did NOT register must
   dead-letter with `dlt_template_not_registered` (fail-closed proof).
4. The console's SMS row should now read `ON` with the active template count.

---

## 3. ABDM — sandbox legs (ABHA enrolment, Scan & Share, thin HIU)

Resolution logic: `apps/backend/src/config/abdmConfig.js` (env) +
`apps/backend/src/services/tenant/tenantSettingsService.js`
(`getAbdmEnrolmentSettings`, `getAbdmHiuSettings`). The gateway defaults to
the ABDM **sandbox** (`X-CM-ID: sbx`, `https://dev.abdm.gov.in/...`,
`https://abhasbx.abdm.gov.in/abha/api/v3`) unless `ABDM_ENVIRONMENT=production`.
Scan & Share intake rides the enrolment/HIP gating — it has no flag of its own.

### Layers

| Leg | Env | Tenant flag |
|---|---|---|
| ABHA enrolment | `ABDM_ENABLED=true` | `settings.abdmEnrolment.enabled=true` |
| Scan & Share | same | rides enrolment |
| Thin HIU | same | `settings.abdmHiu.enabled=true` |

### Sandbox bring-up

1. Obtain ABDM sandbox credentials (client id/secret + HIP registration)
   from the ABDM sandbox portal.
2. Set in the deployment env:
   - `ABDM_ENABLED=true`
   - `ABDM_CLIENT_ID`, `ABDM_CLIENT_SECRET`
   - `ABDM_HIP_ID`, `ABDM_HIP_NAME` (and `ABDM_HIU_ID` if it differs —
     defaults to the HIP id)
   - `ABDM_CALLBACK_URL`, `ABDM_CALLBACK_SECRET`
   - leave `ABDM_ENVIRONMENT` unset → sandbox gateway + `X-CM-ID: sbx`.
3. Flip `settings.abdmEnrolment.enabled=true` (and `settings.abdmHiu.enabled`
   if the HIU leg is in scope) for the pilot tenant.

### Verification (sandbox)

1. **Enrolment**: run the front-desk ABHA enrolment OTP flow for a test
   Aadhaar-linked mobile; the session should reach `enrolled`/`linked` with
   an ABHA number. A disabled tenant flag must return
   `ABDM_ENROLMENT_DISABLED` (403); a disabled env must return
   `ABDM_NOT_ENABLED` (503) — both are the gates working.
2. **Scan & Share**: scan a counter QR in the sandbox app and confirm the
   share intake creates the registration/token entry.
3. **Thin HIU**: issue one consent request and fetch one bundle; confirm
   page evidence lands (migration 714's reconciliation covers this).
4. The console's ABDM rows should read `ON · sandbox`. Record results in
   `docs/ABDM_READINESS.md`.

---

## 4. Facility asset register

Resolution logic: `apps/backend/src/services/facility/facilityAssetService.js`
(`requireFacilityAssetsEnabled`) + `tenantSettingsService.js`
(`getFacilityAssetsSettings`). Two layers only — no provider config row and no
credentials. Fail closed: with the env switch off every
`/api/v1/facility/assets*` call returns `FACILITY_ASSETS_NOT_ENABLED` (503);
with the tenant flag off it returns `FACILITY_ASSETS_DISABLED` (403).

### Layers

| Layer | Setting | How |
|---|---|---|
| Env | `FACILITY_ASSETS_ENABLED=true` | backend configmap + ArgoCD sync |
| Tenant flag | `settings.facilityAssets.enabled=true` | console toggle, or `PATCH /api/v1/admin/tenants/:tenantId` |

### Bring-up + verification

1. Set `FACILITY_ASSETS_ENABLED=true` and flip the tenant flag (console row
   "Facility asset register").
2. `GET /api/v1/facility/assets` as a facility-operations role returns the
   (initially empty) register; register one asset, transition it
   `active → under_repair → active`, and confirm each mutation appends a
   `facility_asset_events` row plus an `audit_logs` row.
3. Negative check: flip the tenant flag back off — every call must return
   `FACILITY_ASSETS_DISABLED` (403); that is the gate working.

---

## 5. PHI shadow-column envelope encryption

**Posture: DORMANT by configuration, and deliberately so.**

This one does not follow the three-layer pattern above — there is no env kill
switch, no tenant flag and no config row. It is armed purely by the *presence*
of two secrets, which is exactly why it went unnoticed: both were read at
runtime and declared in no manifest, so "off" and "forgotten" were
indistinguishable (2026-08-23 once-over). The backend now prints its resolved
state on every boot:

```
🔐 PHI shadow-column envelope encryption: DORMANT by configuration
   (KMS_MASTER_KEY + PHI_SEARCH_HASH_KEY both unset) …
```

### What exists today

Migration 132 (`132_phi_column_rotation.sql`) added shadow columns beside the
highest-PHI plaintext columns:

| Table | Shadow columns |
|---|---|
| `users` | `name_encrypted`, `phone_encrypted`, `address_encrypted`, `phone_search_hash` |
| `medical_records` | `description_encrypted`, `diagnosis_encrypted`, `treatment_encrypted` |

The migration header describes a four-step rollout. **Only step 1 is wired.**

| Step | State |
|---|---|
| 1. Dual-write on every insert/update | wired — `userService.writePhiShadows`, `recordService.writeRecordPhiShadows` |
| 2. Backfill existing rows | never run — `apps/backend/scripts/phi-backfill.mjs` |
| 3. Flip reads to encrypted-first | **not built** — `phiColumnEncryption.readWithFallback` / `decryptColumn` have zero production callers |
| 4. Drop the plaintext columns | not built |

Because step 3 does not exist, the plaintext columns remain authoritative for
every read and the shadow columns are write-only. Nothing is lost by leaving
the subsystem dormant, and arming it without steps 2-4 produces partly
encrypted tables that no reader consumes.

The one shadow column any code reads today is `users.phone_search_hash`, and
only as *evidence*: account deletion records whether a hash existed
(`beforeState.hadPhoneSearchHash`) and then NULLs it with the other identity
columns. No lookup path filters on it.

### Layers

| Layer | Setting | How |
|---|---|---|
| Secret | `KMS_MASTER_KEY` — exactly 32 base64-decoded bytes | seal into `vhhealth-backend-env` |
| Secret | `PHI_SEARCH_HASH_KEY` — ≥16 base64-decoded bytes, a **different** value | seal into `vhhealth-backend-env` |
| Optional | `KMS_PROVIDER` (only `env` is accepted), `KMS_KEY_ID` (default `env-default`) | backend configmap |

Both secrets are listed, commented out, in
`infra/kubernetes/apps/backend/sealed-secret.yaml.example`.

**They must be sealed together.** `validateEnv.js` refuses to boot when
exactly one is set: the dual-write call sites catch a missing-key error and
log a warning, so a half-armed deployment writes `users.phone_encrypted` while
silently leaving `users.phone_search_hash` NULL.

### Before arming — two things to fix first

1. **`users.phone` shadows are written on CREATE only.**
   `writePhiShadows` guards the phone branch with `isCreate`, and the update
   path (`userService.js:316`) does not pass it. A phone number changed after
   registration leaves `phone_encrypted` and `phone_search_hash` holding the
   *old* value. Harmless while nothing reads them; a correctness bug the
   moment step 3 lands. Fix this before any read or lookup path uses them.
2. **`KMS_KEY_ID` is write-once.** `EnvKmsProvider.unwrapDek` rejects an
   envelope whose `kid` does not match the configured id
   (`KMS_KID_MISMATCH`). Pick the id before the first write and do not change
   it; there is no rotation path for it today.

### Bring-up

1. Generate two independent values:
   `openssl rand -base64 32` (KMS_MASTER_KEY) and again for
   PHI_SEARCH_HASH_KEY. Never reuse one for both — the separation is what
   stops the deterministic hash from revealing the wrap key.
2. Add both to the plaintext `vhhealth-backend-env` Secret, re-seal, and sync
   (procedure: `docs/DEPLOYMENT_GUIDE.md` §5).
3. Restart the backend and confirm the boot line reads
   `PHI shadow-column envelope encryption: ARMED`. A half-armed seal will
   crash-loop the pod with a message naming the missing key — that is the
   gate working.
4. Run the backfill with the same two values in the environment:
   ```bash
   node apps/backend/scripts/phi-backfill.mjs --dry-run
   node apps/backend/scripts/phi-backfill.mjs --batch-size 500
   ```
   It is idempotent and only touches rows whose encrypted column is NULL.
5. Verify: no `PHI shadow-column encrypt skipped` or
   `medical_records PHI shadow encrypt skipped` warnings in pod logs after a
   user or record write, and `SELECT count(*) FROM users WHERE name IS NOT
   NULL AND name_encrypted IS NULL` returns 0.

> `scripts/rebuild-search-hashes.mjs` is a **different** system
> (`FIELD_SEARCH_HMAC_KEY`, `utils/fieldEncryption.js`) and has no targets
> today. It does not rebuild `phone_search_hash`; `phi-backfill.mjs` does.

---

## 6. Client force-upgrade gates

**Posture: DISABLED by choice (`0`), for both apps.**

`GET /api/v1/config` publishes `min_patient_version_code` and
`min_staff_version_code`; both Flutter apps ship the client half
(`apps/patient/lib/core/services/minimum_version_gate_service.dart`,
`apps/staff/lib/core/services/minimum_version_gate_service.dart`). The route
coerces anything unusable to `0`, which disables the gate — so a typo used to
fail silently open. Both names are now declared in the backend configmap as
the literal string `"0"`, and the backend prints the resolved state at boot:

```
📱 Client force-upgrade gates (GET /api/v1/config): patient=DISABLED (0), staff=DISABLED (0)
```

Leave the ConfigMap values as `"0"`, never empty — an empty string fails the
Joi number check and the pod will not start.

### Staff gate — arming

Safe to set on its own. Every staff build implements the unsigned comparison
and fails open when `/config` is unusable, so there is no signed envelope.

1. Confirm the minimum acceptable staff build number is already published and
   installable from your distribution channel.
2. Set `MIN_STAFF_VERSION_CODE: "<build>"` in
   `infra/kubernetes/apps/backend/configmap.yaml`, commit, sync, restart.
3. Verify `curl -s https://api.vhhealth.app/api/v1/config` returns the new
   `min_staff_version_code`, and that a staff build below it shows the
   blocking upgrade screen while one above it does not.

### Patient gate — arming (COUPLED, refuses to boot half-configured)

A non-zero `MIN_PATIENT_VERSION_CODE` **requires** a valid signed
`PATIENT_MINIMUM_VERSION_POLICY_JSON`. `validateEnv.js` checks both presence
and structural validity and exits 1 otherwise, because patient builds already
in the field fail closed on a minimum they cannot verify: a bare non-zero code
burns their 24h bootstrap grace and then blocks **every** install — including
installs already above the code, and including their SOS path.

1. Mint the envelope offline:
   `npm run patient:min-version:sign -- …`
   (`apps/backend/scripts/sign-patient-minimum-version-policy.mjs`). The
   matching public key must already be stamped into shipped patient builds.
2. Seal `PATIENT_MINIMUM_VERSION_POLICY_JSON` into `vhhealth-backend-env`.
3. Only then set `MIN_PATIENT_VERSION_CODE` in the configmap and sync.
4. Verify `/api/v1/config` returns both `min_patient_version_code` and a
   `minimum_version_policy` object. If the policy object is missing, roll the
   code back to `"0"` immediately — that response shape is the bricking one.

---

### Explicitly out of scope

- **UHI** stays dark (flagged lowest-value/droppable at merge).
- LiveKit, `FILE_SCAN_POLICY` (needs clamd), continuity C-D14, and ambulance
  GPS are operator/hardware-blocked; the console surfaces them read-only.
- **`FIELD_ENCRYPTION_MASTER_KEK`** is not a gate — it is a missing secret for
  features that are already live. Without it, payroll runs, payslip-password
  reveal, HL7 I03 inbound recovery and the admin PHI re-wrap return 500, and
  tenant onboarding cannot provision a tenant KEK. Provisioning procedure:
  `docs/DEPLOYMENT_GUIDE.md` §5.4 and `docs/TENANT_ONBOARDING_RUNBOOK.md`.
