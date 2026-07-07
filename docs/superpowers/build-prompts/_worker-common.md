# Worker common rules — read this with every build prompt

Every build prompt in this directory assumes ALL of the following. Violations block merge.

## Workspace setup (template — substitute WORKTREE-NAME and BRANCH from your prompt)
```bash
MAIN="D:/Dev/Projects/VH Health/VH-Health-Platform"     # coordinator's clone; read-only for you
WT="D:/Dev/_codex/worktrees/WORKTREE-NAME"
git -C "$MAIN" fetch github
git -C "$MAIN" worktree add "$WT" -b BRANCH github/main
cp "$MAIN/apps/backend/.env" "$WT/apps/backend/.env"
cd "$WT" && npm --prefix apps/backend install
# add when your prompt touches them:
npm --prefix apps/admin install        # admin portal work
dart pub get                           # Flutter workspace / melos codegen
```
NEVER work in, commit in, or switch branches of `$MAIN` itself (shared-checkout contamination
history — PR #427). Your worktree is your world.

## Gates you must pass locally before the PR
- Backend: `node apps/backend/scripts/run-ci-jest.mjs` (chunked; needs dev Postgres on `:5433` —
  start per `apps/backend/CLAUDE.md`: `pg_ctl -D "D:/Dev/Tools/pgdata-vhhealth" -o "-p 5433" start`).
- Any route change: `npm run openapi:generate && npm run openapi:check` in `apps/backend`;
  commit `src/docs/openapi.json`. Flutter-consumed APIs: `melos run codegen`, commit generated Dart.
- Admin: `npm run lint && npm run type-check` inside `apps/admin` (NOT raw `npx tsc`).
- Flutter: `melos run analyze && melos run test`; every user-facing string in ALL five
  `intl_*.arb` files (the i18n guard fails CI otherwise).
- Raw SQL: spread args to `$queryRawUnsafe` (never an array); `::type` casts on params inside
  `jsonb_build_object/array`; `npm run lint:raw-params`.

## Migrations
- Bare DDL at `apps/backend/src/migrations/NNN_*.sql`. Use ONLY the migration numbers your
  prompt assigns (the playbook §5 registry is the allocation authority — never ls-and-take;
  parallel workers hold adjacent blocks).
- **★ Schema regeneration LAW (2026-07-07, learned from PR #458's red CI): regenerate
  `schema.prisma` ONLY from a disposable scratch database built from YOUR OWN worktree's
  migrations — NEVER from the shared QA/dev DB, which may contain OTHER workers' migrations
  and silently contaminates your schema with models your branch lacks.** Recipe:
  `psql <server>/postgres -c "CREATE DATABASE my_scratch;"` →
  `psql .../my_scratch -c "CREATE EXTENSION IF NOT EXISTS vector;" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"`
  (the baseline requires both) → `DATABASE_URL=.../my_scratch node scripts/ci-setup-db.mjs` →
  `DATABASE_URL=.../my_scratch npx prisma db pull` → `npx prisma generate` → drop the scratch DB.
  Commit `prisma/schema.prisma` TOGETHER with the `.sql`. Then
  `node apps/backend/scripts/check-phi-tenant-id.mjs` and
  `node apps/backend/scripts/check-schema-drift.mjs`.
- New PHI tables: copy the mig-356 RLS boilerplate exactly (tenant_id UUID NOT NULL with the
  GUC-aware default, ENABLE + FORCE ROW LEVEL SECURITY, `tenant_isolation` policy, FK to
  tenants). Service writes go through `setTenant`/`setTenantTx` with EXPLICIT tenant_id on
  inserts — the GUC default silently stamps the literal default tenant otherwise.

## Platform invariants
- **★ Wire-shaping LAW (2026-07-07, from PR #460's smoke failure): Postgres NUMERIC columns
  fetched via `prisma.$queryRawUnsafe` come back as Prisma `Decimal` OBJECTS. Any
  response-shaping/normalizer helper MUST convert them (`typeof v.toNumber === 'function'`
  → `v.toNumber()`) BEFORE JSON serialization — a generic `Object.entries` clone
  destructures them into `{s,e,d}` internals and crashes React clients. If your service
  returns NUMERIC/DECIMAL columns, add the guard and a smoke-level assertion.
- Canonical clinical timeline (`docs/CANONICAL_CLINICAL_TIMELINE.md`): every patient-facing
  clinical write = detail row + `clinical_timeline_events` + `clinical_audit_events` in ONE
  transaction. Non-patient subjects (donors, staff credentials, machine QA) use audit/register
  trails, not patient timeline events.
- Deploy is HELD: ship inert behind flags; k8s manifests land unreferenced by the root
  kustomization. Per-tenant flags copy the mig-351 `composition_search_settings` +
  `compositionFeatureService` pattern (per-tenant cache, fail-closed) — the global
  `feature_flags` table is NOT tenant-scoped.
- Never commit licensed/redistribution-restricted content (SNOMED RF2, LOINC releases, vendor
  drug-KB exports, IAP tables unless the playbook decision log says cleared). Synthetic
  fixtures only in CI.
- Conventions: `success()`/`error()` response helpers, `AppError`, roleHelpers (never inline
  role arrays), `phiAccessLogger` on PHI routes, Winston logger, parameterized SQL, no
  `err.message` to clients. Full checklist in `apps/backend/CLAUDE.md`.

## Deliverable
Push your branch to `github`; open a PR against `main` on `Bahuleyandr/VH-Health-Platform`
titled per your prompt. PR body = **build ledger**: scope delivered · invariants held ·
migration numbers used · exact test commands run + pass counts · anything deferred and why.
ALL checks green (`gh pr checks` exits 1 spuriously — re-query; don't trust `--watch`).
**STOP after opening the PR.** The coordinator content-verifies and merges. Do not merge,
do not push to main, do not touch other workers' branches or reservations.
