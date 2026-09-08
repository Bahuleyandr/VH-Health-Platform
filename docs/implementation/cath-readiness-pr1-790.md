# Cath readiness PR 1 — additive schema and held approval path

Design authority: owner design sign-off dated **2026-09-08**, design head
**ae35b393f30e9d0bcfeca5c2e63842d63b4fff13**, scope **design only**.
This is not implementation, activation, merge, deployment or tenant clinical/legal
consent-policy approval. The confirmed five-PR split has four binding conditions,
restated here as repository requirements:

1. PR 2 proves disabled-path byte equality for every changed shared route and
   function, covering serialized responses, persisted rows and emitted events.
   Its generated manifest pins count and membership against an independent
   enumeration of the Git diff. Generator and checker must not share their walk,
   extension filter or parser; MJS files, barrel registrations and Prisma delegate
   calls cannot silently fall outside the proof.
2. The capability fails closed: absent, empty or malformed configuration means
   disabled. A test evaluates the actual shipped configuration and proves disabled.
3. PR 1 keeps the approval path unmounted until PR 5, proves existing callers cannot
   reach the widened signer type through a counted caller census, and executes the
   actual route, canonical audit writer, paired-ID signer, persisted signature and
   verification chain in its own tests.
4. PR 5 executes rollback demonstrations for missing signed manifests and changed
   source hashes, refusing partial evidence. Both of its migrations claim fresh
   numbers from 790–799 and name both numbers in the PR title.

## Main after this PR alone

Migration **790** adds two empty relations, nullable attempt clocks and evidence
columns, compatible case defaults, scoped log revision keys and an audit recording
index. It does not assign historical evidence to attempts, backfill, reset clinical
data or enforce new Start rules on existing cases. `actual_start_at` and cancellation
end times are untouched. The legacy cath implementation still runs, including its
existing readiness behaviour. This PR does not activate the non-restrictive redesign.

The two new relations are `cath_lab_attempt_readiness_records` and
`cath_lab_consent_policy_versions`. Both have ENABLE/FORCE RLS, the unchanged
permissive platform tenant-match policy and restrictive `tenant_context_required`
with exactly `app_current_tenant_id_uuid() IS NOT NULL`. No existing relation gains
a restrictive policy. Existing-table restrictive closures belong to the RLS tranche
lane (Astra, migrations 780–789). The actual application role is `vhhealth_app`; malformed
context deliberately denies by error 22P02, while unset/empty/bypass deny by policy.
The literal `bypass` is unsupported. Runtime grant repair registers only the two new
relations, preserving their no-delete/no-truncate grants after late role creation.

The approval router has **zero production imports or mounts**, not an environment
switch. Neither absent, empty, malformed nor truthy configuration can mount it.
Only tests mount the actual router directly. Production mounting is held until PR 5
and requires that PR's separately reviewed cutover controls. No new Start, consent,
time-out, reopen, report or history route is added here.

The real approval route validates JWT, SUPER_ADMIN and MFA. Inside the actual tenant
transaction, it locks an active, TOTP-enabled platform administrator (`admins` row
with `tenant_id IS NULL`) and checks every manifest tenant exists and is active.
Tenant-bound administrators cannot use a SUPER_ADMIN token to substitute for this
persisted platform authority. It records the exact tenant scope in the immutable
canonical approval audit, preallocates a signature ID, and passes **both** IDs to
the existing signer's unchanged paired-identity guard. The fixed approval type
hashes PostgreSQL UTF-8 `jsonb::text` of exactly `{schema, rows}`. The real verifier
checks the stored signature and the receipt verifier checks audit action, outcome,
actor, chain hash, document/audit binding, tenant and exact content.

`verifyCathMigrationApprovalTx` verifies **approval integrity**, not migration
eligibility. It performs no migration or clinical mutation. PR 5 must additionally
recompute the complete issue population, owned log identities and source hashes
under cutover locks, reject missing/stale/partial material, and show rollback.
R7-5 in this PR covers the approval-material boundary, not the deferred full
classifier/enforcement acceptance. Consent policy tables are empty; clinical/legal
policy governance remains required before activation. Policy identity protection
is a data invariant, not proof of Start consent enforcement.

## Signed-design terms and physical schema names

These are name mappings, not changes to the signed design's semantics. PRs 2–5,
queries, Staff contracts and the report must use the same mapping; do not create a
second physical column under the design term.

| Signed design term | Physical column introduced by migration 790 | Meaning |
| --- | --- | --- |
| `start_recorded_at` on the Start audit row | `audit_logs.cath_start_recorded_at` | Bound server Start recording instant; nullable until a future Start writer supplies it; report month/index basis |
| `last_accepted_evidence` | `cath_case_lab_readiness_items.accepted_evidence` | Retained full internal accepted evidence; server-only, not a public projection |
| `supersedes_procedure_log_id` | `cath_procedure_logs.supersedes_log_id` | Same-tenant/case/attempt revision parent; not a cross-attempt reference |

## Approval residency: current behavior and PR-5 precondition

The signed design requires explicit platform-wide authority for every manifest
tenant. It does **not** specify a platform storage tenant, per-manifest-tenant
receipts, or the requesting tenant as the residency boundary. Platform authority
must not be presented as approval to copy one tenant's clinical decision material
into another tenant's audit/export domain.

PR 1 currently chooses the **requesting token's tenant** in
`approveCathMigrationDispositions`: `setTenantTx(context.tenantId)` stores both the
approval audit and signature there. A multi-tenant manifest therefore puts tenant
B's case IDs, source hashes and decision material in tenant A's
`clinical_audit_events.after_state` when A is the requesting tenant. Those bytes
are resident in A's audit/retention/export domain; the audience and export behavior
of every future evidence-detail reader must be reviewed before mounting. There is
no separate platform-tenant store in this implementation. Verification under A's
scope succeeds; `verifyCathMigrationApprovalTx` under B's scope refuses that receipt.
R7-5 tests both the multi-tenant approval and wrong-tenant receipt refusal. This is
current behavior, not a claim that its residency model was signed off.

The recommended PR-5 model is **per-manifest-tenant approvals**, retaining each
tenant's decision material and receipt in that tenant's own scope while requiring
the same stepped-up platform authority. This recommendation requires an explicit
owner/governance scope decision before production mounting; it is not a new design
approval. PR 5 must settle the residency, authorized readers, retention/export and
cross-tenant orchestration contracts and test them through the real writer and
verifier before any mount. Until then the zero-production-import/mount condition
remains mandatory. No residency or verification code changes are made in PR 1.

## Caller census

`apps/backend/scripts/cath-pr1-caller-census.mjs` generates the committed JSON
manifest. There are **7 signing call sites**: **5 existing external callers**, the
existing internal wrapper call and **1 new held approval caller**.

| Existing caller | Permitted effective type / exclusion |
| --- | --- |
| `encounterRoutes` | Literal `encounter` |
| `integrityRoutes` | Dynamic input reaches `signDocument`, which rejects the approval type before document lookup |
| `diagnosticResultActionService` | Literal `diagnostic_result_action` |
| `inpatientPathwayDomainService` | Literal `diagnostic_result_action` |
| `referralClosedLoopService` | Literal `referral_response` |
| Internal `signDocument` to `signDocumentTx` | Same rejecting public wrapper; cannot supply paired approval identities |

The only new caller is `approveCathMigrationDispositions`. Public signature listing
and verification also reject this held approval type. The census is a regression
inventory, not a universal proof against arbitrary future program shapes. It walks
JS/MJS/CJS, resolves named aliases, pins count and membership, and rejects synthetic
default imports, dynamic imports, re-exports and spread inputs. An independent
flat source search proves zero production approval-router imports. Actual HTTP
tests prove generic signing refusal and the production approval URL's 404 with an
entitled authenticated caller; the legacy cath route returns 200 as positive control.

## Acceptance and deliberate-failure protocol

Every name below is a top-level Jest full name. Select exactly one with `-t
'^FULL NAME$'`; the evidence runner records the literal anchored pattern, source
hashes, selected full name, pass/fail counts, runtime suite failures, exit code and
the intended assertion. Each receipt must show unmodified: one pass; mutated: the
same one test fails at its intended assertion; restored: one pass. Setup/compilation
failures do not count. Receipts and working harness remain outside the repository.

| Full name | Deliberate mutation / intended failure |
| --- | --- |
| R5-8 attempt table is fail-closed under vhhealth_app | Change restrictive qual to TRUE; exact deparsed predicate assertion fails. Full two-relation matrix includes read/write positive control, unset, empty, wrong tenant, bypass and malformed 22P02. |
| R9-1 approval persists and verifies through the real signer | Omit signatureId only; completed real approval response fails at 201 assertion. No audit/signer/verifier adapter is used. |
| R7-5 migration approval rejects null and stale decision material | Treat null decision rows as empty; null-material 400 assertion fails. Also tests role/MFA/platform authority, multi-tenant scope, changed content and wrong-tenant receipts. |
| R8-5 approval and policy identity are enforceable | Permit DELETE in identity trigger; deletion-refusal assertion fails. Also tests immutable rules, revocation and exact-version FK. |
| PR1 expansion preserves legacy cancellation and nullable clocks | Default clinical clock from server clock; null-clinical-time assertion fails. |
| PR1 attempt snapshots and log revision scope are structural invariants | Drop composite revision parent FK; cross-attempt parent refusal fails. Also tests frozen snapshots and unique child. |
| R9-9 each implementation PR leaves main coherent alone | Mount held router in actual app; production request becomes 201 instead of 404. Legacy route is the entitled positive control. |
| PR1 caller census isolates the widened signer from all existing callers | Change the existing encounter caller to approval type; census membership fails. |
| PR1 production registry has no approval or v2 routes | Import/mount approval router; independent zero-import assertion fails. Generated OpenAPI retains the legacy cath route and no new v2 routes. |

The complete 51-anchor redesign acceptance remains a later train gate; these nine
PR-1 checks do not claim that later backend/client/cutover behaviour is implemented.
PR 2 must meet the exhaustive disabled-path byte-equality census, checked against an
independent diff enumeration. Its capability must fail closed in shipped config.
PR 5 needs two newly allocated 790–799 migration numbers and executed rollback
receipts. Each subsequent PR begins only after the preceding PR is actually MERGED.
