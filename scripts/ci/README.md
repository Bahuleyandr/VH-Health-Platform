# Repository CI checks

CI checks live in this directory and the GitHub reusable workflows. GitHub is
the sole hosted CI authority; authorized local runs reuse first-party scripts
but do not replace protected GitHub evidence.

Use the orchestrator:

```powershell
node scripts/ci/run.mjs
node scripts/ci/run.mjs --only=security,backend
node scripts/ci/run.mjs --skip=flutter
node scripts/ci/run.mjs --install
node scripts/ci/run.mjs --install --include-smoke
node scripts/ci/run.mjs --install --changed-on-branch-push
```

Stages:

- `security`: whitespace check, applied-migration immutability guard,
  service-account secret scan, gitleaks worktree and commit-range scans.
  `check-migration-immutability.mjs` compares every file under
  `apps/backend/src/migrations` against its blob at the merge-base with main and
  fails on a changed or deleted one — new files are fine. It lives in this
  stage, not `backend`, because `security` is the only stage every canonical
  plan selects, and a guard against unvalidated changes reaching a live database
  must not itself be skippable by tier routing. It is also the one migration
  defect CI is structurally blind to: CI databases are fresh, so the runtime
  checksum guard in `runMigrations.js` can only ever fire against a long-lived
  one. Escape hatch: `scripts/ci/migration-amendment-allowlist.json` (read its
  header first — it authorises one checksum transition, and it does **not**
  bypass the runtime check).
- `contracts`: cross-stack contract checks that belong to no single app. Today
  that is `check-client-paths.mjs`, which asserts every API path the clients
  call resolves to an operation the backend actually serves. Dependency-free and
  a couple of seconds, so it runs before the multi-minute stages.
- `backend`: backend audit/lint/OpenAPI/DB guardrails/Jest via `npm run ci`.
- `fhir`: FHIR R4 sample validation, with golden samples treated as strict.
- `admin`: admin audit/lint/type-check/test/build/Clinical AI bundle check.
- `flutter`: workspace `dart pub get`, Melos bootstrap, format, analyze, test.
- `infra`: Kubernetes manifest validation + Kyverno Enforce readiness contract
  + held operator lifecycle source contract + bounded Helm source inventory + Kustomize-controlled production image
  registry proof (`scripts/check-kyverno-enforce-readiness.mjs`,
  `scripts/check-prod-helm-image-inventory.mjs`,
  `scripts/check-prod-digests-pinned.mjs`). The digest guard inventories
  workload `image`, CRD `imageName`, operator/config `*Image`, and the three
  scheduled-restore-proof-synthesized runtime fields, rejects non-immutable active references,
  and verifies each unique digest against its live registry. The all-zero hold
  is limited to six exact workload occurrences. Longhorn,
  kube-prometheus-stack, and Loki chart-generated images are not rendered by
  this gate; a separate fail-closed check holds their exact chart repositories,
  revisions, and values sources for activation-time rendered image review.
  The operator lifecycle contract separately hashes the four held operator
  chart archives and verifies all nine pinned operator images. Its live mode
  also blocks platform sync on missing or unhealthy Applications, CRDs, or
  controllers.
- `smoke`: local QA orchestrator with role and desktop smoke coverage.

## GitHub pull-request merge boundary

Ordinary non-main pushes use the affected-stack tier of `.github/workflows/ci.yml`.
After the source tree is final, create and push one empty marker commit; the
`[full-ci]` subject selects the exhaustive matrix and attaches both required
`Merge Gate` and `Full Merge Gate` contexts to that final pull-request head:

```powershell
git commit --allow-empty -m "ci: run final canonical gate [full-ci]"
git push
```

Do not push another commit after the marker unless you intend to invalidate
both results and create a new marker. `workflow_dispatch` is retained for
diagnosis, not as the pull-request merge boundary.

## Client API path contract

`check-client-paths.mjs` closes the direction the OpenAPI pipeline never
covered. `generate-openapi.mjs` boots the live app, so the spec is a faithful
census of what the server serves — but nothing asserted that clients only call
paths in it. The 2026-08-09 audit found nine admin-portal calls to operations
present in neither the spec nor Express; they 404 in production, and one was
pinned by a jest test asserting the same wrong path.

```powershell
node scripts/ci/check-client-paths.mjs            # gate
node scripts/ci/check-client-paths.mjs --verbose  # + per-source breakdown
node scripts/ci/check-client-paths.mjs --json     # machine-readable
node --test scripts/ci/check-client-paths.test.mjs
```

It extracts literal paths from `apps/admin/src`, `apps/{patient,staff}/lib`,
`packages/vhhealth_core/lib`, and `apps/device-gateway/src`, resolves them the
way each runtime does, and set-differences them against
`apps/backend/src/docs/openapi.json`.

Three things about it are load-bearing:

- **It is method-aware.** Three of the audit's nine call a path that exists in
  the spec but only for a different verb. Express 404s an unserved method
  exactly as it 404s an unknown path, so a path-only gate waves them through —
  as the pre-existing `api-config-spec-subset.test.ts` does.
- **Each client stack resolves paths differently.** Admin sends a path that
  `toApiV1Endpoint` rewrites and then prefixes (`/admin/users` is served as
  `/api/v1/users`); the mirror of that rewrite table is pinned against
  `apps/admin/src/lib/api/core.ts` by a test, so the two cannot drift silently.
  Admin browser calls are also checked against the literal prefix table in
  `apps/admin/src/app/api/proxy/[...path]/route.ts`; a backend operation is not
  considered reachable when the runtime proxy would reject it first.
  Dart sends a bare suffix, because `ApiConfig.baseUrl` already ends in
  `/api/v1`.
- **Dart extraction is anchored on the call site, never on literal shape.**
  GoRouter route names are syntactically identical to API suffixes, so a
  shape-based scan would report navigation as broken API calls.

Non-API strings are excluded by rule, not by allowlist: Next.js local routes
live under `/api/<not v1>`, plus `/ws`, `/api-docs`, static assets, page routes,
and policy globs. Declaration-only router mount bases pass by rule, but an
actual call with a known method must resolve to an operation. Rewrite-backed
runtime aliases are mapped to their canonical spec operations so their exact
path and method are still checked. `client-path-allowlist.json` is reserved for
exact, method-scoped operations the backend genuinely serves but the spec omits
(currently the flag-gated dev-auth route), and every entry must name the mount
that serves it.

## GitHub workflow coverage

The owner permanently retired Forgejo delivery and mirroring on 2026-09-30.
Root `.github/workflows/` contains the only hosted workflows. Wrappers should
prepare the runner and call reusable jobs or first-party scripts. There is no
Forgejo retry, mirror-parity or signing-key provisioning prerequisite. See
[`FORGEJO_RETIREMENT.md`](../../docs/FORGEJO_RETIREMENT.md) for the retained-check
mapping and external containment boundary.

- `ci.yml` supplies the tiered canonical gate; `all.yml` is the scheduled/manual
  full sweep. The backend reusable retains Prisma relation-budget validation
  and SQL-column/schema drift; the infrastructure reusable retains the Redis HA
  contract. PostgreSQL service images are digest-pinned. The separate PG18
  canary requires an approved exact PG18 digest before its service starts.
- `secret-scan.yml` retains service-account, Gitleaks and optional GitGuardian
  checks. Backend/admin reusables enforce high-severity npm audits; the separate
  GitHub Dependency Review action remains advisory.
- `security-sweep.yml` is reusable/manual and is called by canonical CI and
  `all.yml`. Both backend and Admin npm audits block in every canonical tier.
  Repository-wide fixable HIGH/CRITICAL vulnerability/secret findings
  block in Trivy; OSV, broad and all-severity focused Semgrep, and
  misconfiguration reports remain advisory. Canonical security separately
  enforces the focused ERROR-severity Semgrep rules.
- `container-supply-chain.yml` is reusable/manual and called by the full gate,
  affected backend/admin/Flutter/infrastructure plans and the full sweep. It
  builds backend/admin/staff-web locally, blocks on fixable HIGH/CRITICAL image
  vulnerabilities and secrets, and produces advisory SBOM/misconfiguration
  reports. It does not publish or sign images.
- `smoke-e2e.yml` retains isolated backend/admin/API smoke coverage;
  `ci-warehouse.yml` retains the migration-built dbt and warehouse render gate.
  Hosted checks below are separate from these isolated CI environments.
- Release, staging distribution, digest pinning and Dalekdefender deployment
  remain in their existing GitHub workflows, subject to their actual triggers
  and separate execution authority. Release image builds require source
  ancestry on main. Source validation does not authorize those external effects.
- [Dependency updates](../../docs/qa/dependency-updates.md) use GitHub Dependabot.
  Kubernetes manifest-image updater parity remains held for owner disposition.

Hosted `post-deploy-smoke.yml` and `trial-readiness-smoke.yml` are manual only.
Both require `authorized_by`, `authority_ref`, `api_origin` and an exact
40-character `expected_commit`; post-deploy additionally requires `admin_origin`.
The shared `manual-smoke-preflight.mjs` validates the inputs and deployed
revision before credential-bearing probes. Selected Sentry events stay held
if any required target check fails. `include_sentry` and `include_creates` default to
false; create probes additionally require `writes_authority_ref`. Actual target,
test-identity and effect approval must exist before dispatch. These gates do
not grant authority or establish successful execution on their own.

The retired public key at `infra/forgejo/signing/cosign.pub` is historical
verification evidence only, not an active signer or admission key. GitHub
container releases use their OIDC identity. INF-006 / PR #872 remains held for
external credential and automation containment receipts in
[`RELEASE_READINESS.md`](../../docs/RELEASE_READINESS.md); source retirement does
not disable remote jobs, revoke credentials or authorize a live policy sync.

Branch-push optimization:

- Pull requests, `main`, and manual dispatches run the full default stage set.
- Non-main branch pushes may pass `--changed-on-branch-push`; the orchestrator
  then maps changed files to the smallest safe stage set.
- `security` always runs in changed-file mode.
- CI/workflow changes, unknown risky paths, or an empty diff fall back to the
  full default gate.

Local CI caches:

- If `VH_CI_CACHE_DIR` is set, the orchestrator uses it for npm, pub, gitleaks,
  FHIR validator, and Kubernetes validator caches.
- Use an isolated, owned cache directory for the authorized runner; do not
  depend on a Forgejo runner or modify a shared runner's mounts.
- FHIR validation requires Java 17; `scripts/ci/fhir.mjs` keeps a Linux
  install fallback for fresh hosts.
- FHIR validation runs with local terminology mode (`-tx n/a`) so branch CI does
  not block on `tx.fhir.org` latency or outages.
