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
