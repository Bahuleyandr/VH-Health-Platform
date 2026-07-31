# C4.2 action registry and backend enforcement — design delta

**Status:** implementation record; inert and flag-gated
**Authority:** implementation plan §7 C4.2, design §5.4 and §6.2, the frozen
[C0.2 action census](./c0-2-action-route-inventory.md#6-proposed-default-deny-registry),
and countersigned decision C-D3 in the
[owner dossier](./c0-4-owner-decision-dossier.md#c-d3--offline-action-matrix)
**Base re-derived at kickoff:** `dfac4c7202f49037f3407a705064be3c1945b3f0`
**Migration:** `602_clinical_continuity_action_registry.sql` (`601` was occupied)
**Activation:** none

## 1. Decision and boundary

C4.2 extends the C3.1 clinical-continuity policy document from the closed v2
language to a closed v3 language. It reuses the existing RFC 8785 JCS
canonicalization, SHA-256 policy checksum, Ed25519 signature, encryption-key
registry, approval, revocation, supersession, effective-window, and
anti-rollback machinery. There is no second policy, signature, key, or approval
mechanism.

Policy schemas v1 and v2 can never authorize action capture. They remain valid
for the C3 pack and C3.2 edge purposes for which they were defined, but the
action evaluator requires a verified policy-schema v3 document and an exact
action-registry row binding.

The frozen C0.2 §6 table is code-tested as the source of truth: 17 stable action
IDs become catalogue entries and the eighteenth `unknown` row remains a
non-executable fail-closed fallback. C-D3 is implemented, not reinterpreted.

## 2. Registry storage and signed contract

Migration 602 adds three nullable bindings to the existing
`clinical_continuity_policy_versions` table:

- `action_registry_schema_version`
- `action_registry_version`
- `action_registry_checksum`

All three must be absent outside policy schema v3 and present for schema v3.
The row values must exactly match the canonical `policyDocument.actionRegistry`
values. The registry issue and expiry times must exactly equal the policy
effective window, and a capture policy has a finite expiry. Database guards
make the registry binding immutable, reject a version rollback, reject a
checksum change without a higher registry version, and reject a higher version
with unchanged content. Approval metadata must bind the registry schema,
version, checksum, and C-D3 decision ID in addition to the existing policy
checksum and countersignature.

Each of the 17 entries is a closed canonical object with:

- stable action ID, domain/facility scope, action version, action checksum, and
  C-D3 approval evidence;
- allowed roles and required server-derived capability groups;
- required actor, tenant, facility, patient, encounter/appointment/admission,
  item, and capture-session identity as applicable;
- required cached source IDs and maximum age;
- explicit draft, observation, order-draft, physical-action, or unbounded
  classification and a separate capture-ready boolean;
- witness and break-glass posture;
- idempotency fingerprint and optimistic-concurrency contract;
- occurrence-time, late-arrival, SLA, and notification rules;
- a replay binding ID and disposition;
- named conflict and quarantine owners with `needs_review` as durable
  disposition.

The policy checksum covers the registry checksum, the registry checksum covers
the full action array and compatibility rules, and each action checksum covers
its complete action contract. Exact checks at every layer prevent a valid
outer signature from masking substituted inner content.

## 3. Authoritative server binding

The signed registry carries `replayEndpoint.bindingId`; it never carries an
HTTP method, executable URL, route parameter, handler name, or caller-selected
endpoint. The client action envelope likewise carries only the stable action ID
and pinned signed-authority claims.

Backend modules register executable actions with the exact JavaScript handler
reference, exact JSON-schema object reference, method, router path, and full
route template. At boot, `assertClinicalContinuityActionBindings()` runs
unconditionally, independent of
`CLINICAL_CONTINUITY_ACTION_REGISTRY_ENABLED`. It compares the mounted
registrations with a closed server-owned expectation and fails boot on:

- a typoed, duplicate, missing, or unexpected action;
- a binding-ID, method, route, handler-reference, or schema-reference mismatch;
- an executable registration for a default-deny entry; or
- overlapping discriminators for multiple actions on the same route.

Every failure names the offending action ID. The only executable C4.2 bindings
are:

| Action ID | Server binding |
|---|---|
| `emr.nursing_note.draft.store` | `PUT /api/v1/emr/notes/draft`, named draft handler, nursing-draft v1 schema |
| `emr.op_note.draft.store` | `PUT /api/v1/emr/notes/draft`, the same named draft handler, disjoint OP-draft v1 schema |

Seven server-owned negative aliases map the current prescription, inpatient
order, MAR, specimen, transfusion, generic note, and vital routes to their
approved default-deny action IDs for safe route-template audit classification.
They do not create executable bindings.

## 4. Signed audience and capture envelope

The existing C3.1 signing payload remains authoritative for tenant, facility,
policy checksum and version, policy signing key ID and public-key hash,
effective issue/expiry window, superseded policy ID, revoked-key set, and
revocation epoch. Policy v3 adds the registry's allowed roles/capabilities,
device postures, action schema/version/checksum, and per-posture minimum app
version under that same signed document.

At replay, the client must pin policy ID/version/checksum, signing key ID,
effective window, supersession ID, revocation epoch, registry
version/checksum, and action version/checksum/schema version/schema checksum.
The backend compares those claims with the freshly verified current or exact
historical signed policy and its compiled catalogue entry. A missing or
mismatched claim is refused. Roles and capability groups are derived from the
authenticated actor and the server role-policy graph; method, route, handler,
and schema are derived from the server binding registry.

## 5. Evaluation and rollout

The environment flag defaults to false. When false, the middleware is inert;
the boot assertion still runs. When true, only requests carrying a continuity
action ID enter evaluation. Ordinary online calls are unchanged.

The first facility policy is `shadow`. Shadow records compatibility and
clinical-review evidence without converting those review outcomes into route
authorization. Security-envelope failures are never shadow-permissive:
unknown actions, missing/non-executable bindings, non-v3 authority, signed
audience mismatches, unsupported device posture, malformed app versions, and
clients below the signed minimum safe version are refused.

Later enforcement is exact, never global: a verified v3 policy must name
`activation.mode = enforce` and the exact facility/action set in
`enforcedActionIds`. An action outside that set is refused. C4.2 does not
activate such a policy or place any facility in capture mode.

Current and captured policy rows are loaded inside one tenant-scoped
`RepeatableRead` transaction. A policy that was valid at capture time but is
now expired or superseded can proceed only through one exact current-registry
compatibility row. Compatibility matches policy ID/version/checksum, signing
key, effective window, supersession ID, revocation epoch, registry
version/checksum, action version/checksum, schema version/checksum, and maximum
capture age. Wildcards do not exist. Missing rules and explicit review rules
produce owned `needs_review`. A captured policy whose key is now compromised
or revoked also produces owned `needs_review`, never automatic replay.

Denied, would-deny, and review decisions are audited without clinical payload,
patient identity, idempotency key, or resource-bearing URL. The audit object is
built from a fixed key list and format/enumeration validators; caller objects
are never spread or passed through. The insert runs inside `setTenantTx` and
deliberately omits `audit_logs.tenant_id`; the column default stamps the active
`app.current_tenant_id`, matching the existing audit convention and preventing
an explicit value from disagreeing with the transaction GUC.

`audit_logs` is tenant-scoped with `ENABLE ROW LEVEL SECURITY`, `FORCE ROW
LEVEL SECURITY`, and migration 335's canonical `tenant_isolation` policy. That
policy is the permissive Pattern-A form: with a valid tenant GUC it isolates
tenants, but unset, empty, and `bypass` tenant GUC values match all rows.
`clinical_continuity_policy_versions` deliberately has the stricter C3.1
restrictive policy layered over Pattern A, so those three contexts match no
continuity-policy rows. C4.2 does not claim that the restrictive behavior also
applies to `audit_logs`.

## 6. HTTP/OpenAPI decision

C4.2 adds no HTTP route and changes no existing method or path. It extracts the
existing note-draft handler into a named controller, mounts it at the same
`PUT /api/v1/emr/notes/draft` route, and adds authenticated middleware plus
read-only operator validation. No OpenAPI source or generated file is in the
ledger.

Therefore C4.2 can build in parallel with C2.2 PR #652. Its current ledger has
zero overlap with #652. Both `npm run openapi:check` and
`npm run openapi:check-core` remain mandatory negative proof; any drift stops
the slice rather than regenerating OpenAPI.

## 7. Tenant, integrity, privilege, and retention

C4.2 creates no table. It extends a table that already has non-null tenant and
facility scope, the composite facility/tenant foreign key backed by
`ux_facilities_tenant_id`, tenant-aware policy-version uniqueness, forced RLS,
the restrictive explicit-context policy, and read-only application-role
grants. Migration 602 reasserts forced RLS and the restrictive policy's
presence, adds a tenant/facility-prefixed registry index, and revokes its
trigger functions from public and application roles.

There is no action-payload store or replay receipt in this slice. Registry
retention follows the append-only policy-version lifecycle and existing C3.1
retention design. Decision evidence uses the existing `audit_logs` retention
regime and contains no PHI payload. Tests cover cross-tenant and non-owner
worker visibility on the extended table. PR #656 owns the separate deep test
of the existing audit-log tenant-RLS posture and is not duplicated here.

## 8. File ledger

Expected implementation files are limited to:

- `apps/backend/prisma/schema.prisma`
- `apps/backend/package.json`
- `apps/backend/scripts/check-clinical-continuity-action-registry.mjs`
- `apps/backend/src/app.js`
- `apps/backend/src/config/clinicalContinuityActionCatalog.js`
- `apps/backend/src/config/downtimeConfig.js`
- `apps/backend/src/controllers/emr/clinicalNoteDraftController.js`
- `apps/backend/src/middleware/clinicalContinuityActionPolicyMiddleware.js`
- `apps/backend/src/migrations/602_clinical_continuity_action_registry.sql`
- `apps/backend/src/routes/emr/clinicalNotesRoutes.js`
- `apps/backend/src/services/downtime/clinicalContinuityActionBindingRegistry.js`
- `apps/backend/src/services/downtime/clinicalContinuityActionRegistryService.js`
- `apps/backend/src/services/downtime/clinicalContinuityPolicyService.js`
- `apps/backend/src/tests/deep/clinicalContinuityActionRegistryMigration.deep.test.js`
- `apps/backend/src/tests/unit/clinicalContinuityActionAudit.test.js`
- `apps/backend/src/tests/unit/clinicalContinuityActionBindingRegistry.test.js`
- `apps/backend/src/tests/unit/clinicalContinuityActionPolicyMiddleware.test.js`
- `apps/backend/src/tests/unit/clinicalContinuityActionRegistryService.test.js`
- `apps/backend/src/tests/unit/clinicalContinuityPolicyService.test.js`
- `apps/backend/src/tests/unit/configEnv.test.js`
- `apps/backend/src/tests/unit/downtimeConfigGovernance.test.js`
- `apps/backend/src/utils/validateEnv.js`
- `apps/backend/src/validators/clinicalContinuityActionSchemas.js`
- this design record

## 9. Explicit non-goals

- no Staff, Patient, or shared client changes (C4.1/C4.3);
- no replay receipts or recovered-action ledger (C5.1);
- no activation, facility enablement, or capture policy publication;
- no policy, registry, approval, or key generation;
- no new HTTP route, method, or OpenAPI contract;
- no executable binding to current prescription, CPOE, MAR, specimen,
  transfusion, generic note-create, or vital routes; and
- no reinterpretation of C-D3.
