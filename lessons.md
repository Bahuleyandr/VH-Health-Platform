# Lessons — VH Health Platform

Durable rules learned from production / CI / triage cycles. Add entries
with date headers. Each entry should be a single rule with concrete
evidence (commit hash, finding ID, CI run, etc.) so future readers can
verify it for themselves.

---

## 2026-05-12 cycle (5-wave manual triage + chip orchestration)

### Phase 0 / 1 / 1.5 / 2 transaction boundary rule

Pre-flight lookups (admission state, readiness gate probes, FK existence
checks) belong **OUTSIDE** `prisma.$transaction`. A try/catch swallowing
a Prisma error inside a `$transaction` callback aborts the underlying
Postgres transaction silently; the next `tx.*` call then fails with
`current transaction is aborted, commands ignored until end of
transaction block` and surfaces as a generic 500.

The shape that works:

- **Phase 0 — pre-flight (plain `prisma`):** lookups that may legitimately
  return zero rows. P2025 → `AppError.notFound`, no 500.
- **Phase 1 — atomic (`prisma.$transaction`):** state mutations + audit
  log. **No** best-effort calls inside. Every `tx.*` call must succeed
  or the whole block must roll back cleanly.
- **Phase 1.5 — post-commit best-effort (plain `prisma`):** TPA
  placeholder, housekeeping ticket, downstream alerts. Each wrapped in
  its own try/catch and uses `prisma`, never `tx`. Failure is logged but
  never blocks the Phase 1 commit.
- **Phase 2 — slow/external:** LLM calls, PDF generation, external API
  fan-out. Failure is recoverable via a separate endpoint.

Applied to: `markForDischarge` (`f9bbecba`),
`markDischargeDrugsDispensed` (`d032f6d0`), `dischargePatient`
(`1c2dfe8a` + `80e0ec5f`), `collectAdvanceDeposit` (`bfbb3d76`).

### Variable-form raw-params is a lint blind spot

`npm run lint:raw-params` catches inline array literals
(`prisma.$queryRawUnsafe(sql, [a, b])`) but **not** the variable form
(`prisma.$queryRawUnsafe(sql, params)` where `params` is an array). That
form passes lint and silently binds the whole array as `$1`, leaving
every `$2+` placeholder unbound.

Wave 1.5 found 8 such sites in `appointmentAdminRoutes.js` that had
survived multiple lint runs (commit `d27d79b9`). When reviewing any
raw-SQL change, grep for `(sql, \w+\)` and verify either:
- The variable is spread at the call site (`...params`), OR
- The function signature already spreads it before passing in.

The lint script's regex should eventually be extended to flag bare
identifiers named `params`/`values`/`args`, but until then this is a
manual review checkpoint.

### Schema regeneration requires a clean, fully-migrated DB

`prisma db pull` against a dev DB that is missing prior migrations
silently strips models for tables that don't exist there. The only
safe regen path:

1. Spin a fresh `pgvector/pgvector:pg16` Docker container.
2. Apply all migrations via `apps/backend/scripts/ci-setup-db.mjs`.
3. Run `prisma db pull` from a `node:22` container on the same Docker
   network — WSL2 localhost TCP forwarding is unreliable for Prisma's
   client, but inter-container DNS via `--network` works reliably.
4. Commit the regenerated `prisma/schema.prisma` together with the
   migration that necessitated the regen.

Hand-editing `schema.prisma` for a single new model is acceptable only
when the new table has no cross-model relations and no new indexes
beyond the PK. Otherwise full regen is mandatory — the schema-drift
check (`scripts/check-schema-drift.mjs`) will fail CI if the committed
file disagrees with `prisma db pull` against a migrated DB.

Wave 4 chips hand-edited the schema with aspirational columns/indexes/
cascades, producing the 2026-05-13 morning's drift-fix commit
`b60cdb02`.

---

## 2026-06-14 cycle (autonomous S-tier WS0–WS8 completion — RLS Batch 3, B1.2/B2.5/B3.2/B4.2/B5.5)

### Append-only audit chain: never delete mid-chain rows in test cleanup

`clinical_audit_events` is a GLOBAL per-tenant append-only hash chain
(migration 282 trigger). Any test cleanup that `DELETE`s rows (e.g. by
`patient_uid`) permanently breaks the chain for every later run —
`document-integrity.deep` verifies full-chain linkage and fails
non-deterministically once enough gaps accumulate (it bit us 3× before the
root cause was found). Two-part fix (`5a2b676e`): (1) remove the
`DELETE FROM clinical_audit_events` from `_journeyHarness.js` cleanup —
orphaned-by-patient audit rows are harmless and prod never deletes audit rows
either; (2) the verifying suite self-isolates by resetting only the
default-tenant chain in its own `beforeAll` (it runs under
`JEST_CI_ISOLATED_TESTS`, so this is safe). Generalises: an integrity test over
a globally-shared append-only structure must own an isolated slice.

### A coverage pass is a bug-finder, not a metric exercise — and never assert the buggy shape

Raising B3.2 coverage to ≥80% surfaced two real production bugs narrower tests
had missed for months: `adminOtpService.query()` returns `{rows, rowCount}` but
4 callers indexed it as the rows array → `forceSendOtp` 500'd on *every* admin
force-send (success branch unreachable); `prescriptionSafetyCheck` with an
empty med name made `allergyName.includes('')` always true → a spurious
severe-allergy HARD BLOCKER on any prescription for any patient with a recorded
allergy (`8042dfa7`). Rule for coverage work: when a branch is only reachable
via a bug, FIX the source first, then assert the correct behaviour. Never write
an assertion that documents/accepts the buggy shape to cover the line — that
cements the bug as "tested".

### setTenantTx conversion: unit-test mocks must delegate the named export

When converting a service from `prisma.$transaction` to `setTenantTx`, the
test's `jest.unstable_mockModule('../../lib/prisma.js', ...)` must export
`setTenantTx` (and `setTenant`/`runTenantScopedTransaction`/`pickTenantClient`)
as NAMED exports that delegate to the per-test tx:
`setTenantTx: async (_t, fn) => fn(txMock)` (or `=> transactionMock(fn)` when
the test asserts on `transactionMock`). Missing it = an ESM-link failure
(`setTenantTx is not a function`) that surfaces in a random chunk by mtime
order. For a large conversion batch, do a ONE-TIME sweep of all prisma mocks
first (`14f6452e` — 149-file sweep) so no wave breaks tests.

### Multi-tenant RLS is three layers — all three must be wired

(1) the prisma proxy auto-scopes single-statement raws + model-API calls under
`AUTH_ENFORCE_TENANT_RLS` (`maybeRunUnderTenant`/`wrapModelDelegate`); (2)
interactive `$transaction` callbacks BYPASS the proxy → must be converted to
`setTenantTx(tenantId, cb)` (no lint rule — only an adversarial audit of every
`$transaction` site finds them; Batch 3 = 47 sites); (3) policied `tenant_id`
column DEFAULTs must be GUC-reading, not the literal default, or an INSERT that
omits `tenant_id` 42501s under a non-default tenant (migration 310:
`COALESCE(NULLIF(NULLIF(current_setting('app.current_tenant_id',true),''),'bypass')::uuid, <default>)`).
Single-tenant is safe with all three gaps present; they become exploitable the
moment a 2nd tenant onboards.

### RLS membership: verify against the live DB, not migration greps

Grepping migrations for `tenant_id`/policy names produced both false positives
and false negatives during the audit. Ground truth is the live DB —
`SELECT relname FROM pg_class WHERE relrowsecurity=true` joined with
`information_schema.columns WHERE column_name='tenant_id'`. Use it before
deciding whether a `$transaction` needs `setTenantTx` (the housekeeping tables
looked policied by name but were not; several looked unpoliced but were).

### req.tenantId, never req.user.tenant_id, in controllers

`req.user.tenant_id` is the optional raw JWT claim (absent on older tokens,
stale after tenant reassignment). `req.tenantId` is the authoritative
middleware-resolved tenant. Passing `req.user.tenant_id` is a silent
miscategorisation that passes tests and only misroutes PHI in edge cases
(caught by adversarial verify in Batch 0a, `3b032995`).

### Distinguish environmental test failures from code regressions

Two signatures are infra, not code: (a) a chunk that dies with NO test output
and a non-1 exit (e.g. exit 4) = the process was killed (OOM / external SIGKILL)
— don't read the suite's logic. (b) 100+ failures in one chunk all reading
`Database circuit breaker is open` = the QA DB was down at runner startup; the
first 5 connection failures trip the breaker (`CIRCUIT_BREAKER_THRESHOLD=5`, a
module singleton) and every later query in that process fails fast. Resolution:
`node scripts/qa-cluster-up.mjs` + re-run — do not chase the cascade. (The
breaker only trips on connection failures; schema errors like 42P01 are in its
ignore-set, so a real schema regression looks different.)

---

## 2026-06-14 (first push to remotes — GHA CI surfaced 6 failures a green local suite hid)

The full in-our-control roadmap was green on the LOCAL chunked runner, but the
first push to `main` lit GHA red. Local-green ≠ CI-green here: GHA runs SAST
(CodeQL + Semgrep) + `npm audit` + a CLEAN-DB test pass + per-env image BUILDS on
top of the test suite. The six failures and their durable lessons:

### A clean-DB test pass catches fixture rows a dirty local QA DB supplies
`getPublishedAiOutputForPatient.deep` seeded a cross-tenant row against a tenant
UUID (`2222…`) that nothing in the CI seed creates → FK `23503` (8 tests). It
false-passed locally only because a prior sprint-fixtures run had left that row in
the shared QA DB. Rule: a test must seed every row it depends on in its own
`beforeAll` (idempotent upsert + guarded `afterAll`) — never assume a tenant/parent
row "already exists". CI's clean DB is the source of truth, not the dev QA DB.

### Flipping a SAST/lint gate to BLOCKING requires first proving it runs clean
B3.4 removed `continue-on-error` from the Semgrep + CodeQL steps, but neither had
ever actually passed: `.semgrep.yml` was malformed (8/16 rules invalid → exit 7
before scanning anything), and CodeQL's analyze step died on a missing
`actions: read` perm AFTER a successful scan. A gate made blocking while broken =
guaranteed red. Pair every "make it blocking" with one green run of that exact
command.

### `semgrep scan` is NOT blocking by default — gate on severity
`semgrep scan` exits 0 even with findings; only `--error` (or `semgrep ci`) fails
on them. Best gate: `--error --severity ERROR` so high-signal ERROR rules block
while advisory WARNING rules (e.g. a `Math.random` non-crypto FP, weak-hash)
report without failing — honouring the ruleset's own severities and avoiding
`nosemgrep` source noise. CodeQL on a PRIVATE repo also needs `actions: read` in
the job perms (workflow-run lookup) or analyze fails post-scan (precedent:
`release-images.yml`).

### A build-time security guard must reach EVERY image builder, not just prod
SEC-8 made the admin `next build` refuse to build in production without
`NEXT_PUBLIC_ALLOWED_ORIGIN`. Prod's `release-images.yml` passed it, but the Admin
Portal CI build and the dalekdefender deploy did not → both red (the CI one hid
behind an earlier `npm audit` failure — fix-one-reveal-the-next). Adding a
build-time/prod-only guard = audit ALL build sites (CI compile + every per-env
deploy workflow) for the new required build-arg in the SAME change.

### `npm audit` gates move under you
Admin CI went red on a NEWLY-published esbuild advisory (dev-only, transitive via
`tsx`) with zero code change — `npm audit --audit-level=high` is a moving target.
`npm audit fix` (lockfile-only transitive bump, 0.28.0→0.28.1) clears it; expect
this class of red on any repo with an audit gate.
