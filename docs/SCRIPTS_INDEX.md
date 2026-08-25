# Operator Script Index

This is the operator-facing catalog for scripts that can change tenant state,
security posture, ledger posture, QA database state, or clinical-AI readiness.
Run them from the repository root unless the script notes otherwise.

The repository has **two** script trees and this file covers both:

- `apps/backend/scripts/` — the go-live, PHI, ledger, and seed entrypoints.
  Catalogued in the three sections immediately below, with prerequisites and
  failure modes per script.
- `scripts/` at the repository root — infrastructure, supply-chain, secret-scan,
  QA-harness, and smoke entrypoints. Catalogued in
  [Repository-Root `scripts/`](#repository-root-scripts) below.

Until 2026-08-25 this file indexed only the first tree, so root-level scripts
that plainly sit inside the declared scope — `qa-reset.mjs` (drops and rebuilds
the QA database), `seed-qa-tenant.mjs`, `update-prod-digests.mjs`,
`bootstrap-sealed-secrets.sh` — were invisible to anyone reading it as the
catalog. See [How this index is derived](#how-this-index-is-derived) for the
commands that regenerate the root list, and run them rather than editing the
prose when a script is added or removed.

## Production And Go-Live Scripts

| Script | Purpose | Run Context | Prerequisites | Failure Modes |
| --- | --- | --- | --- | --- |
| `apps/backend/scripts/onboard-tenant.mjs` | Idempotently creates or updates a tenant row, branding, per-tenant KEK, and bootstrap tenant `ADMIN`; prints the tenant API/admin hosts and client build defines. | New-tenant onboarding or rerun after partial onboarding failure. Supports `--dry-run`. | `DATABASE_URL`, field-encryption KEK secrets (`FIELD_ENCRYPTION_MASTER_KEK` plus `FIELD_ENCRYPTION_KEK` or fallback), tenant slug/name, wildcard DNS/TLS plan. | Invalid slug/name exits before writes; missing encryption keys fail KEK provisioning; DB errors can leave an earlier idempotent step complete and later steps pending, so rerun after fixing the cause. |
| `apps/backend/scripts/runtime-role-cutover-drill.mjs` | Staging drill for the production non-superuser runtime DB role and RLS cutover; creates a scratch DB, applies migrations, creates runtime roles, proves RLS enforcement, and tears down. | Pre-go-live rehearsal against local QA Postgres on `127.0.0.1:55432`; never against production. | QA Postgres running, usually via `node apps/backend/scripts/qa-cluster-up.mjs`; local `pg` binaries and migrations available. | Fails if Postgres is down, pgvector cannot be provisioned by the expected superuser bootstrap path, migrations fail, runtime roles are superuser/bypassrls, or tenant RLS checks leak or block incorrectly. |
| `apps/backend/scripts/ledger-opening-balance-cutover.mjs` | One-time idempotent cutover that seeds opening patient AR ledger entries for every tenant's outstanding invoices. | After Phase-2a ledger wiring is deployed, before any authoritative ledger flip. | `DATABASE_URL` pointing at the target DB; tenant/invoice data present; ledger migrations deployed. | Per-tenant failures are logged and the script continues; rerun is safe because each invoice has a stable idempotency key. Investigate any tenant `FAILED` line before flip. |
| `apps/backend/scripts/ledger-reconciliation-evidence.mjs` | Read-only evidence report over `reconciliation_checks`; prints per-tenant `FLIP-READY` / `NOT-READY` verdicts for `ledger_authoritative_mode='enforce'`. | Before considering an authoritative ledger flip; optionally pass a tenant UUID. | `DATABASE_URL`; reconciliation cron must have recorded enough sweeps. Optional `LEDGER_FLIP_MIN_CLEAN_STREAK` and `LEDGER_FLIP_MIN_SPAN_DAYS`. | No rows means no evidence yet; non-ready verdict means do not flip. Query failures or stale reconciliation data indicate the evidence gate is not usable. |
| `apps/backend/scripts/check-clinical-ai-readiness.mjs` | Verifies a clinical-AI module is actually using a model (`used_ai=true`) and not silently falling back to a deterministic template. | Before trusting or enabling a module for a tenant, especially local Ollama/deep-tier rollout. | `DATABASE_URL`, provider env (`CLINICAL_AI_PROVIDER`, `CLINICAL_AI_BASE_URL`, `CLINICAL_AI_MODEL`, optional `CLINICAL_AI_DEEP_*`), and a generous `CLINICAL_AI_TIMEOUT_MS=120000` for cold local models. | Exit `1` for provider/model not ready, model not pulled, template fallback, or timeout; exit `2` for usage errors. Treat `used_ai=false` as not ready. |
| `apps/backend/scripts/loadtest-500bed-evidence.mjs` | Builds the NL12-S3 500-bed evidence bundle from a k6 summary plus optional Prometheus snapshots and Grafana dashboard links. It is read-only and writes under `output/loadtest/`. | After an owner-approved 500-bed k6 run against production-shaped infrastructure with synthetic data only. | `LOADTEST_500BED_CONFIRM=I_HAVE_APPROVAL_AND_SYNTHETIC_DATA`, `TARGET_ENVIRONMENT`, `OWNER_APPROVED_BY`, `SYNTHETIC_POOL_ID`, `LOADTEST_WINDOW_START`, `LOADTEST_WINDOW_END`; optional `K6_SUMMARY_JSON`, `PROMETHEUS_URL`, `PROMETHEUS_BEARER_TOKEN`, `GRAFANA_URL`. | Exits before writing if approval or required metadata is missing. If `PROMETHEUS_URL` is supplied and any snapshot query fails, it writes the partial bundle and exits non-zero. |
| `apps/backend/scripts/dr-cross-site-preflight.mjs` | Read-only NL12-S7 package and operator-input preflight for cross-site DR promotion readiness. | Before a cross-site DR tabletop, drill, or promotion PR evidence capture. Use `--operator-ready` only after the DR site, network path, storage jurisdiction, RPO/RTO approver, DNS owner, replica mode, drill window, and backup-reader secret reference are assigned. | Repo docs present. For `--operator-ready`: `DR_SITE_NAME`, `DR_NETWORK_PATH`, `DR_STORAGE_JURISDICTION`, `DR_RPO_RTO_APPROVER`, `DR_DNS_FAILOVER_OWNER`, `DR_REPLICA_MODE`, `DR_DRILL_WINDOW`, `DR_BACKUP_READER_SECRET_REF`; optional `DR_RPO_MINUTES`, `DR_RTO_MINUTES`. | Exits non-zero if the DR package is incomplete, operator fields are missing under `--operator-ready`, replica mode is invalid, or RPO/RTO exceed current runbook ceilings. It never prints secret values. |
| `apps/backend/scripts/phi-backfill.mjs` | Idempotently encrypts legacy plaintext PHI into migration-132 `*_encrypted` shadow columns and computes phone search hashes. | Post-migration backfill or rerun after partial PHI encryption. Supports `--dry-run`, `--batch-size`, and `--table`. | `DATABASE_URL`, `KMS_MASTER_KEY`, `PHI_SEARCH_HASH_KEY`; schema with PHI shadow columns. | Exits for missing keys; skips tables not migrated; row-level update failures are logged. Rerun after resolving bad rows or schema drift. |
| `apps/backend/scripts/phi-rewrap-tenant-keks.mjs` | Rewraps existing `enc:v2` field-encrypted values from global KEK to each tenant KEK for crypto-shred coverage. | Tenant crypto migration or rerun after interrupted rewrap. Supports `--tenant`, `--table`, and `--dry-run`. | `DATABASE_URL`, `FIELD_ENCRYPTION_MASTER_KEK`, active tenant KEKs in `encryption_keys`. | No active KEKs means no-op; missing manifest tables/columns are skipped; decryption/rewrap failures abort and should be investigated before rerun. |

## QA And Local Test Harness

| Script | Purpose | Run Context | Prerequisites | Failure Modes |
| --- | --- | --- | --- | --- |
| `apps/backend/scripts/qa-cluster-up.mjs` | Starts or verifies the local QA Postgres cluster, creates `vhhealth_test` and `qa_writer`, applies raw SQL migrations, and provisions RLS test roles. | First command before backend deep tests on this Windows host or local QA workflows. | Initialized PGDATA at the configured path, PostgreSQL binaries, free IPv4 port `55432`; run `ensure-test-db.mjs` first if PGDATA is missing. | Fails fast for missing PGDATA, non-UTF8 DB, bind/permission errors, migration failure, or role provisioning failure. Check the printed logfile tail. |
| `apps/backend/scripts/smoke-teleconsult-token.mjs` | Operator-only NL-3 teleconsult smoke that provisions patient and clinician join tokens for an existing synthetic `TELE` appointment, records synthetic consent, and verifies TTL, grants, recording-off posture, and non-PHI token metadata. Pair the output with `apps/backend/scripts/teleconsult-smoke-join.html` for the manual two-device media smoke in the runbook. | Local/staging activation rehearsal only. Run from `apps/backend`; never wire into CI and never use production PHI. | `TELECONSULT_SMOKE_CONFIRM=I_UNDERSTAND_THIS_WRITES_FIXTURES`, `DATABASE_URL`, `LIVEKIT_ENABLED=true`, `LIVEKIT_SERVER_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `--tenant-id`, and `--appointment-id`; the HTML join page also needs a hospital-approved LiveKit browser SDK URL. | Exits if confirmation/env is missing, the appointment is not `TELE`, consent/token metadata fails the allowlist, tokens carry recording grants, patient/clinician rooms differ, or DB/SFU config is unavailable. |
| `apps/backend/scripts/test/nhcx-mock-exchange.mjs` | Starts the inert/mock-first NHCX loopback exchange for CoverageEligibility, preauth submit, claim submit, claim status, Communication response, and PaymentNotice endpoints; records protected headers, payload hashes, request counts, and optional deterministic signed callbacks including CommunicationRequest query and PaymentNotice review variants. | Local NHCX P1/P2/P3/P4 verification only. Run from `apps/backend` with `npm run nhcx:mock`; never treat as a live NHCX sandbox substitute. | Optional `NHCX_MOCK_PORT`, `NHCX_MOCK_HOST`, `NHCX_MOCK_CALLBACK_BASE_URL`, `NHCX_MOCK_CALLBACK_SECRET`, and `NHCX_MOCK_JWE_SECRET`. Use `NHCX_GATEWAY_ALLOW_PRIVATE_TARGETS=true` only for local loopback dispatch tests. Claim submit callbacks can be selected with `x-nhcx-mock-outcome: approve`, `partial`, `deny`, or `query`; `query` emits `/communication/request`. PaymentNotice variants use `full`, `short`, or `duplicate`. | Callback posting is skipped when callback env is absent; invalid JWE/callback secrets or unreachable callback base URL fail callback delivery while preserving recorded request evidence. |
| `apps/backend/scripts/test/smoke-nhcx-mock-exchange.mjs` | Smoke-checks the NHCX mock exchange by driving deterministic eligibility, preauth, claim submit approval, claim submit query, claim status, Communication response, and full/short/duplicate PaymentNotice requests through the loopback server, then asserts request and callback correlation continuity. | Local CI/operator smoke for the P1/P2/P3/P4 mock rail. Run from `apps/backend` with `npm run smoke:nhcx:mock`. | Backend dependencies installed. No live NHCX credentials required; the smoke starts and tears down its own loopback mock server plus callback sink. | Exits non-zero if the mock cannot bind, an expected endpoint is not accepted, a payload hash is missing, callback continuity fails, `/communication/request` or `/paymentnotice/request` emission/acceptance fails, duplicate PaymentNotice evidence is missing, or recorded request counts do not match the expected nine-call flow. |
| `apps/backend/scripts/smoke-voice-transcribe.mjs` | Operator smoke for the configurable OpenAI-compatible STT path; uploads a tiny local audio fixture, asserts a non-empty transcript, and records the configured `stt_provider`. | Local dictation/STT readiness check before enabling staff dictation against a local faster-whisper-compatible service. | `STT_PROVIDER=openai-compatible`, `STT_BASE_URL`, `STT_MODEL`, `STT_TIMEOUT_MS` at least `60000`; optional `STT_LANGUAGE`, `STT_PROMPT`, and `STT_API_KEY`. Pass an audio file path as the script argument. | Exits if STT remains `none`, the endpoint is unreachable, the response has an empty transcript, or the provider/model metadata does not round-trip. |

The staff dictation default is intentionally `STT_PROVIDER=none`. Do not treat a
green UI as proof of transcription readiness until the voice-transcribe smoke has
passed against the exact local or staging STT endpoint planned for operators.

## Seed Family

These scripts create synthetic data and are test/QA tools unless the script
explicitly documents a production-safe use. Synthetic seed entrypoints refuse
`NODE_ENV=production` even when `VH_ALLOW_NON_TEST_DATA_SEED=true`. Outside
production they require local `vhhealth_test`, unless that override explicitly
marks an intentional disposable database.

| Script | Purpose | Run Context | Prerequisites | Failure Modes |
| --- | --- | --- | --- | --- |
| `apps/backend/scripts/seed-test-staff-accounts.mjs` | Idempotently seeds staff logins across the staff-role matrix (`EMP-1001` onward). | Local/disposable QA staff-app testing. | Local `vhhealth_test` or non-production `VH_ALLOW_NON_TEST_DATA_SEED=true`; optional `VH_TEST_STAFF_PASSWORD`. | Refuses production before loading Prisma; never prints the password; changing the `EMP-NNN` format breaks staff-app login validation. |
| `apps/backend/scripts/seed-sprint-fixtures.mjs` | Idempotently seeds representative sprint 1-10 data for billing, lab, insurance, OT, maternity, and patient messaging. | E2E/Playwright fixtures. | Local `vhhealth_test` or non-production `VH_ALLOW_NON_TEST_DATA_SEED=true`. | Refuses production and unapproved targets; fixture SQL drift or missing tables abort the run. |
| `apps/backend/scripts/seed-smoke-admin-totp.mjs` | Enrolls a known TOTP secret for the seeded `admin` super-admin and prints the plaintext secret for smoke E2E. | Admin route-crawl smoke setup only. | Local `vhhealth_test` or non-production `VH_ALLOW_NON_TEST_DATA_SEED=true`; `TOTP_ENCRYPTION_KEY`; exactly one seeded `admin` row. | Refuses production; exits if env is missing or the update count is not exactly one; stdout is consumed by CI, so keep logs on stderr. |
| `apps/backend/scripts/seed-icd10-local.mjs` | Seeds ICD-10 catalog rows and federates them into `terminology_concepts` when present. | Local terminology/clinical-coding tests. | Local `vhhealth_test` or non-production `VH_ALLOW_NON_TEST_DATA_SEED=true`; ICD10 seed data module present. | Refuses production; individual code insert failures are counted; terminology federation is best-effort and logs skips. |
| `apps/backend/scripts/seed-departments-doctors-local.mjs` | Seeds common departments and doctor profiles. | Local/demo scheduling and OPD workflows. | Local `vhhealth_test` or non-production `VH_ALLOW_NON_TEST_DATA_SEED=true`; user/doctor/department schema present. | Refuses production; runs in one transaction and rolls back on insert/update error. |
| `apps/backend/scripts/seed-current-bed-structure.mjs` | Seeds the current VH inpatient bed/ward/zone structure and cleans legacy seed beds when safe. | Local QA bed-management, housekeeping, and admission workflows. | Local `vhhealth_test` or non-production `VH_ALLOW_NON_TEST_DATA_SEED=true`. | Refuses production and unapproved targets; cleanup skips active admissions but schema drift aborts. |
| `apps/backend/scripts/seed-comprehensive-test-data.mjs` | Broad local test-data bootstrap, including beds, users, staff/admin passwords, and special-case workflow tables that generic seeding cannot satisfy. | Full local backend/admin/staff test environments. | Local `vhhealth_test` or non-production `VH_ALLOW_NON_TEST_DATA_SEED=true`; optional `VH_TEST_STAFF_PASSWORD` / `VH_TEST_ADMIN_PASSWORD`. | Refuses production and unapproved targets; table constraints and missing columns are the usual failure points. |
| `apps/backend/scripts/demo-tenant-scenario-pack.mjs` | Generates the NL11-S6 deterministic sales-demo scenario pack ledger, persona journeys, safe-reset plan, and tour-anchor artifact. It does not apply database writes in P1. | Local demo/test rehearsal only. Run from the repository root or via `npm --prefix apps/backend run demo:tenant-pack`. | `DATABASE_URL` or `TEST_DATABASE_URL` must target a loopback VH Health dev/test/demo database; optional `--tenant-slug`, `--tenant-id`, `--seed`, `--scenario-date`, `--out-dir`, `--reset`, and `--json`. | Refuses non-local or unexpected database URLs, fails if the generated-login smoke fails, or if the deterministic no-PHI scan detects non-demo contact, hospital-id, or patient-name content. |
| `apps/backend/scripts/seed-clinical-ai-preflight-reviewers.mjs` | Derives enabled clinical-AI modules' `reviewRoles` and seeds missing active reviewer users for a tenant. | Clinical-AI rollout preflight on smoke/test DBs. | Local `vhhealth_test` or non-production `VH_ALLOW_NON_TEST_DATA_SEED=true`; optional `--tenant <uuid>`. | Refuses production unconditionally and fails on clinical-AI schema drift. |
| `apps/backend/scripts/reconcile-clinical-ai-catalog.mjs` | Dry-runs or applies cleanup for duplicate `clinical_ai_modules.module_key` rows, keeping the newest-updated row per key and restoring the catalog primary key when applying. | Operator repair after partial seed/migration reruns or CrashLoop duplicate catalog incidents. Default is `--dry-run`; use `--apply` only during a change window. | `DATABASE_URL`; run the dry-run first and capture the duplicate report. Migration 353 should be deployed so the primary-key invariant remains enforced. | Missing DB URL exits; apply runs in one transaction and rolls back on delete/constraint failures. If duplicates remain or the pkey cannot be restored, do not continue clinical-AI rollout. |

## Repository-Root `scripts/`

Every executable at the top level of `scripts/` is listed here — all 45 of them,
derived from the filesystem, not curated. The **Scope** column marks the ones
inside this file's declared scope (tenant state, security posture, ledger
posture, QA database state, clinical-AI readiness); `—` means build, formatting,
codegen, or launcher tooling that changes none of those. The completeness of the
list is the guarantee; the scope marking is a reading of each script and may be
argued with — what must never happen again is a root script being absent
entirely.

Unless a row says otherwise, run these from the repository root.

| Script | Scope | Purpose | Run context / sharp edges |
| --- | --- | --- | --- |
| `bootstrap-sealed-secrets.sh` | ✅ | Renders or applies the Sealed Secrets controller bootstrap under `infra/kubernetes/base/sealed-secrets`. | `--check` renders and validates; `--apply` mutates the cluster. Take `--check` first. |
| `build-staff-windows-update.ps1` | — | Builds a Windows MSIX / App Installer update for the Staff app. | Release packaging on the Windows box. |
| `build-tenant-client.sh` | ✅ | Builds patient + staff Flutter artifacts for ONE tenant, stamping subdomain and tenant identity via `--dart-define`. | Per-tenant client builds (multi-tenancy W6/W7). Flavors, signing, and per-tenant Firebase config are operator-wired — see `docs/TENANT_ONBOARDING_RUNBOOK.md` Part B4. A mis-stamped build points real users at another tenant's host. |
| `check-c1-1-manifest-contract.mjs` | ✅ | Pins the CNPG/backup manifest contract for the production cluster (operator, plugin, and Postgres image expectations). | `EXPECTED_ACTIVE_PG_IMAGE` (the PG 17 image the live cluster runs) is a deliberate **all-zero fail-closed placeholder** — the operator captures the real digest off the running cluster (`docs/CNPG_POSTGRES_18_QUALIFICATION.md` §1). It is meant to fail until then; do not "fix" it by pinning the PG 18 digest. |
| `check-clinical-ai-tenant-preflight.ps1` | ✅ | Read-only Clinical AI tenant rollout preflight. | Run before enabling a clinical-AI module for a tenant. Read-only. |
| `check-docs-plugin-versions.mjs` | — | Docs-vs-pubspec drift guard for Flutter plugin versions. | Runs in the Flutter workspace CI job. |
| `check-forgejo-supply-chain-pins.mjs` | ✅ | Fails when a Forgejo workflow references an action by anything but a 40-hex commit, or an image by anything but a `sha256:` digest. | Supply-chain immutability gate. A green run prints "Forgejo supply-chain pins are immutable." |
| `check-kyverno-enforce-readiness.mjs` | ✅ | Static and (with `--live`) operator-live readiness checks for the Kyverno image-signature admission policy. | `--live` talks to the cluster. Flipping Kyverno to enforce without this is how unsigned images reach a node. |
| `check-lockfile-libc.mjs` | — | Fails when an app's `package-lock.json` loses the `libc` constraints on its linux glibc/musl variants. | `node scripts/check-lockfile-libc.mjs <backend\|admin\|device-gateway>`. Exists because npm 11 strips `libc`, which lands glibc binaries in an Alpine image. |
| `check-prod-digests-pinned.mjs` | ✅ | Renders every Kustomize-controlled production root and fails on any image that is not digest-pinned. | The gate behind "a merge is inert until an operator syncs". |
| `check-prod-helm-image-inventory.mjs` | ✅ | Fails closed when the separately rendered Helm image surface changes. | Pairs with the Kustomize check above; Helm-sourced images are not covered by it. |
| `check-zero-trust-network-pack.mjs` | ✅ | Validates the zero-trust access policy and NetworkPolicy pack. | Static validation of the committed pack. |
| `codegen.mjs` | — | Dart OpenAPI codegen driver for `packages/vhhealth_core`, with an explicit dropped-operation report. | Targets `vhhealth_core` only — the sole workspace member with real codegen. |
| `dart-format-check.mjs` | — | Formats or checks every tracked `.dart` file. | `--write` to fix. |
| `generate-staff-role-contract.mjs` | — | Generates the dependency-free staff role/presentation contract consumed by the Staff shell. | Runs in the Flutter CI job, where backend `node_modules` are absent. **Authorization never uses this map** — generated raw-role route sets remain authoritative. |
| `generate-vital-bounds.mjs` | — | Generates `vital_plausibility_bounds.g.dart` from the backend clinical bounds modules. | `--check` is wired into `npm --prefix apps/backend run lint`. Clinical constants: regenerate, never hand-edit the `.g.dart`. |
| `ggshield-scan.mjs` | ✅ | Runs GitGuardian over the worktree or a commit range. | `--optional` (or `GGSHIELD_OPTIONAL=1`) downgrades a missing binary to a skip. GitGuardian pins findings to COMMITS, so a rewritten history can change the verdict. |
| `gitleaks-scan.mjs` | ✅ | Runs gitleaks over the worktree or a commit range. | Honours `GITLEAKS_BIN`; falls back to `D:\Dev\Tools\gitleaks` on Windows. |
| `local-ci.mjs` | — | Local CI spine — delegates to `scripts/ci/run.mjs` with Python UTF-8 mode forced for child tools. | The local equivalent of the canonical gate. Forces `PYTHONUTF8=1` so semgrep survives Windows cp1252. |
| `mock-ollama-readiness-server.mjs` | ✅ | Persistent mock Ollama daemon for the clinical-AI rollout-preflight smoke. | A green preflight against this mock proves wiring, **not** model readiness. |
| `operator-lifecycle-preflight.mjs` | ✅ | Static contract plus live-state preflight for the ArgoCD application lifecycle (Applications, CRDs, Deployments). | Reuses the digest verifier from `check-prod-digests-pinned.mjs`. Run before an operator sync. |
| `qa-maestro.mjs` | ✅ | Runs the Maestro flows under `apps/{patient,staff}/.maestro/` as one orchestrator stage. | Needs the Maestro CLI plus a booted emulator or attached device. iOS is out of scope. |
| `qa-orchestrator.mjs` | ✅ | Drives a full QA pass: probes backend `:5206` / admin `:3201`, runs `qa-reset.mjs`, then the PowerShell smokes, writing `qa-runs/<run_id>/summary.json`. | **Calls `qa-reset.mjs`, so it destroys the local QA database.** Stage selection via `--stages`. |
| `qa-playwright.mjs` | ✅ | Runs the admin Playwright suite as one orchestrator stage into `qa-runs/<run_id>/ui-admin/`. | Defaults to `http://127.0.0.1:3201`; override with `PLAYWRIGHT_BASE_URL`, `QA_PW_PROJECT`, `QA_PW_GREP`. |
| `qa-reset.mjs` | ✅ | **Destructive.** Tears the local QA database down to a known-good baseline, then reseeds (comprehensive data, staff accounts `EMP-1001..`, QA edge-case fixtures). | Six guardrails (host, db name, `NODE_ENV`, role, env confirm, advisory lock) and **no flag bypasses any of them** — fix the environment, do not fork the script. |
| `scan-secrets.mjs` | ✅ | Fails the working tree on service-account private-key material. | Wired into `npm --prefix apps/backend run lint` as `secrets:scan`. Inside any `.claude` directory only the `skills` subtree is scanned. |
| `sealed-secrets-bootstrap-smoke.mjs` | ✅ | Smoke for the Sealed Secrets bootstrap render, reusing `validate-sealed-secrets-bootstrap.mjs`. | `--auto` or `--require-cluster`. |
| `seed-dev-env.mjs` | ✅ | Writes `apps/backend/.env` and `apps/admin/.env.local` with freshly generated secrets **only when they are missing**. Idempotent. | Local dev only. Production secrets must come from SealedSecrets / External Secrets — see `docs/DEPLOYMENT_GUIDE.md#secrets`. |
| `seed-local-hands-on-hospital-data.mjs` | ✅ | Additive, idempotent clinical fixtures for the Staff app (bed board, doctor-scoped appointments, case sheet, notes, vitals, discharge hub). | Local `vhhealth_test` only, after migrations and baseline seeds. Guarded by `assertSyntheticSeedTarget`. |
| `seed-qa-tenant.mjs` | ✅ | QA-only edge-case fixtures layered on top of the comprehensive seed: timezone-boundary appointment, Unicode patient name, multi-year history, long strings, NULL-friendly columns. | Runs AFTER `apps/backend/scripts/seed-comprehensive-test-data.mjs`. All inserts idempotent. |
| `smoke-admin-crud.ps1` | ✅ | Local admin dashboard CRUD smoke matrix through the admin proxy. | **Writes** through the admin proxy — point it at a disposable database. |
| `smoke-clinical-ai-local-ollama.ps1` | ✅ | Clinical-AI local-Ollama deep-tier smoke against the backend. | Confirms a module actually used a model rather than a deterministic template. |
| `smoke-clinical-ai-pilot-evidence.ps1` | ✅ | Clinical-AI pilot evidence-pack smoke against the backend. | Produces the evidence an enablement decision is meant to rest on. |
| `smoke-patient-routing.ps1` | ✅ | Local patient-portal API wiring smoke matrix. | Against a local backend with synthetic data only. |
| `smoke-staff-clinical-safety.ps1` | ✅ | Local staff clinical-safety API smoke matrix. | Against a local backend with synthetic data only. |
| `smoke-staff-desktop.ps1` | ✅ | Staff Flutter desktop smoke against a live backend. | Needs the built Windows Staff app. |
| `smoke-staff-role-workflows.ps1` | ✅ | Live staff-role workflow smoke matrix against a reachable backend. | Uses the seeded `EMP-NNNN` role matrix; **never** point at production. |
| `smoke-staff-routing.ps1` | ✅ | Local staff-portal API wiring smoke matrix. | Against a local backend with synthetic data only. |
| `start-local-staff-stack.ps1` | — | Starts the local hands-on Staff stack. | Launcher; the stack it starts is what touches the QA database. |
| `update-local-staff-windows-app.ps1` | — | Rebuilds and updates the local Windows Staff app without a reinstall. | Dev-box convenience. |
| `update-prod-digests.mjs` | ✅ | Rewrites `infra/kubernetes/apps/kustomization.yaml` with verified image digests and writes a verification evidence file. | Supports a dry run that reports without writing evidence. The written digests are what ArgoCD will roll out on the next operator sync. |
| `validate-cert-pin-set.mjs` | ✅ | Validates the release certificate pin set (including an owner-approved 300s clock skew). | Release security configuration gate; fails with `release security configuration invalid: …`. |
| `validate-kubernetes-manifests.mjs` | ✅ | kubeconform validation with a **full-GVK allowlist** for repository-owned and operator-installed CRDs. | Deliberately not `-ignore-missing-schemas`: a misspelled custom resource must fail rather than be hidden. |
| `validate-patient-minimum-version-trust.mjs` | ✅ | Validates the patient minimum-version policy signing-key trust (current/next key ids and public keys). | Refuses equal current/next key ids and half-supplied key pairs. |
| `validate-sealed-secrets-bootstrap.mjs` | ✅ | Validates a rendered Sealed Secrets bootstrap YAML. | `node scripts/validate-sealed-secrets-bootstrap.mjs <rendered.yaml>`; also imported by the smoke above. |

### Deliberately not indexed

- `scripts/ci/` (19 modules, 12 `*.test.mjs`, a README and an allowlist JSON) — the CI harness the workflows
  call (`canonical-plan.mjs`, `stage-selection.mjs`, `check-client-paths.mjs`,
  `run-affected-backend-tests.mjs`, …). These are invoked by `ci.yml` and
  `local-ci.mjs`, not by an operator. `scripts/ci/README.md` documents them.
- `scripts/lib/resolve-dev-tool.ps1` and `scripts/security/check-infra-security-controls.mjs`
  — helper modules called by the entrypoints above.
- Every `scripts/*.test.mjs` — `node --test` unit tests for the scripts beside
  them. Individual workflows run named ones; none is an operator entrypoint.

### How this index is derived

The root list above is the output of this, one row per file:

```bash
# the 45 indexed entrypoints
find scripts -maxdepth 1 -type f ! -name '*.test.mjs' | sort
# what was excluded, and why it is excluded
find scripts/ci scripts/lib scripts/security -type f | sort
find scripts -maxdepth 1 -name '*.test.mjs' | sort
```

When a root script is added or removed, re-run the first command and reconcile
the table against it. Do not adjust the prose count by hand — the count is
`find scripts -maxdepth 1 -type f ! -name '*.test.mjs' | wc -l`.

There is **no CI gate** enforcing this reconciliation. One was considered and
not built: the root `*.test.mjs` files are invoked individually by name from
specific workflows, so a new guard would have had to be wired into a workflow to
run at all, and an unwired guard is worse than none. Treat the commands above as
the manual step in any PR that adds or deletes a root script.

## Operator Rules

- Prefer dry runs where offered before changing production-like state.
- Never run seed scripts against production unless the script and the change plan explicitly allow it.
- Capture command output in the incident/change ticket; many of these scripts are the audit evidence for a later governed mode flip.
- If a script reports partial tenant failure, fix the root cause and rerun the same script rather than hand-editing rows.
