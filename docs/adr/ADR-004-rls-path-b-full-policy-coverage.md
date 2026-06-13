# ADR-004 — RLS Path B: Full Policy Coverage (283 Tables) + Non-Superuser Runtime Role

**Date:** 2026-06-13
**Status:** Accepted
**Deciders:** Platform lead (Bahuleyandr)
**Source:** `docs/GAP_ANALYSIS_TENANT_RLS.md`; `docs/PLATFORM_AUDIT_2026-06-13.md` — DB-1, INF-4/INF-8; commit `635734cb`, `aa3f5d86`

---

## Context

The platform's RLS posture at 2026-06-13 audit:

- Migration 075 had added RLS policies on 11 tables.
- Roughly 70–80 of ~267 `tenant_id` tables carried a policy; ~200 had no enforcement.
- Production connected to Postgres as the `vhhealth` superuser. Superusers bypass all
  non-FORCE RLS — the policies on those 11 tables were therefore not enforced in prod (INF-4).
- The `vhhealth_runtime` NOSUPERUSER NOBYPASSRLS role existed only in the Dalekdefender
  test overlay; production had no equivalent (INF-8).
- Interactive `$transaction` callbacks did not propagate the `SET LOCAL app.current_tenant_id`
  GUC (SEC-3), and the read-replica path was not scoped.

Two RLS paths were evaluated:

**Path A** — Application-layer enforcement only. Add `WHERE tenant_id = $currentTenant`
to every raw SQL query; keep the superuser connection. No DDL migration needed.

**Path B** — Full DB-layer FORCE RLS on all `tenant_id` tables + non-superuser runtime role.
- Migrate every table that carries `tenant_id` to a `FORCE ROW SECURITY` policy.
- Provision a NOSUPERUSER NOBYPASSRLS role (`vhhealth_runtime`) and connect with it in prod.
- The GUC `app.current_tenant_id` is set per-request; the policy enforces it at the DB layer.
- Fix `$transaction` + replica setTenant to propagate the GUC.

## Decision

**Path B: full DB-layer FORCE RLS + non-superuser runtime role.**

Path A (application-layer only) was rejected because:
- A single missing `WHERE` clause (developer error, ORM bypass, migration script) leaks
  cross-tenant PHI — no defense-in-depth.
- It does not address the superuser bypass; the existing 11-table policies remain ineffective.
- DPDP/NABH auditors expect DB-layer isolation, not application-trust.

Path B shipped:
- 283 tables received `ENABLE ROW SECURITY; FORCE ROW SECURITY; CREATE POLICY` covering
  `SELECT`, `INSERT`, `UPDATE`, `DELETE` with `current_setting('app.current_tenant_id')`.
- `rls-runtime-role.sql` provisions `vhhealth_runtime` with NOSUPERUSER NOBYPASSRLS LOGIN;
  existing infra migrations reference it; the prod overlay was updated to use it.
- `setTenant()` in `src/lib/prisma.js` updated to propagate to interactive `$transaction`
  callbacks and the read-replica client.
- A blocking cross-tenant HTTP gate (`test(rls)`, commit `c6c9d41e`) rejects cross-tenant
  PHI and financial reads with 403; this gate runs in CI and blocks merge if it regresses.

## Consequences

**Positive:**
- Defense-in-depth: a missing application-layer WHERE clause cannot leak cross-tenant PHI;
  the DB-layer policy will block it.
- The `cross-tenant-rls` journey is now testable deterministically in CI.
- DPDP/NABH audit evidence: DB-layer isolation with policy text is inspectable.
- `/health/metrics` `tenant_rls.ok=true` monitoring confirms the GUC is live per-request.

**Negative / risks:**
- 283-table policy rollout is the largest single migration surface in the project's history.
  A policy bug on a high-traffic table (e.g. `appointments`) could cause 0-row returns for
  all reads if the GUC is unset. Mitigation: CI gate with superuser + runtime-role pair;
  `logTenantRlsRolePosture()` check in backend health endpoint.
- The non-superuser role cannot run DDL (migrations must still use the superuser role at
  deploy time). CI setup documented: `ci-setup-db` must run as a BYPASSRLS-capable role.
- Single-tenant prod today: a GUC that resolves to `DEFAULT_TENANT_ID` on every request
  is functionally equivalent to no isolation — the policy is enforced but the single tenant
  matches every row. This is correct and safe; the benefit activates at tenant #2.

**Residual work (operational):**
- Confirm `vhhealth_runtime` is in use in the prod overlay (not just Dalekdefender).
- Verify `logTenantRlsRolePosture()` is green in prod logs after next deploy.
- Add the deep test proving a tenant-B JWT cannot read tenant-A PHI through live staff routes
  (WS1 follow-up item, per `docs/EPIC_LEVEL_ROADMAP.md` §A2).
