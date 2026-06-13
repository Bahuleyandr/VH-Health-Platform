# ADR-001 — Tenant Model: Single-Tenant Hardening AND Multi-Tenant RLS in Parallel

**Date:** 2026-06-13
**Status:** Accepted
**Deciders:** Platform lead (Bahuleyandr)
**Source:** `docs/S_TIER_ROADMAP.md` — Decisions §1; `docs/PLATFORM_AUDIT_2026-06-13.md` — INF-4/DB-1

---

## Context

The platform launched single-tenant (one hospital) in India. The original plan deferred
multi-tenant RLS until a second customer was imminent. As of 2026-06-13, the audit found:

- ~70–80 of ~267 `tenant_id` tables had RLS policies (DB-1).
- Production connects as the `vhhealth` superuser, which bypasses non-FORCE RLS (INF-4/INF-8).
- The `vhhealth_runtime` NOSUPERUSER role existed only in the Dalekdefender test overlay.
- Interactive `$transaction` callbacks and the read-replica path were not auto-scoped (SEC-3).

Three options were considered:

1. **Single-tenant only** — keep the status quo; harden operational controls for the
   one-tenant India deployment. Defer RLS until tenant #2 is contracted.
2. **Full multi-tenant first** — pause all other work to complete RLS coverage, then resume.
3. **Both in parallel** — continue single-tenant hardening (non-superuser role, audit controls)
   while simultaneously completing full RLS coverage (all 283 tables), in the same WS1 window.

## Decision

**Option 3: both in parallel.**

Run single-tenant hardening (non-superuser runtime role, denied-PHI audit, image-signature gate)
and full multi-tenant RLS coverage (283 tables, FORCE policy, blocking cross-tenant HTTP gate)
concurrently in the WS1 batch (2026-06-16–24). No additional development time is consumed
because the two streams touch different files. The cost of retrofitting later — once a second
tenant is provisioned — would be significantly higher (live migration of PHI tables under load,
no test coverage of cross-tenant isolation).

## Consequences

**Positive:**
- Production is protected against cross-tenant PHI leak before any second tenant onboards.
- The `cross-tenant-rls` journey (one of the 11 milestone journeys) becomes testable
  deterministically in CI from WS1 onward.
- Audit/compliance posture (DPDP, NABH) is improved by demonstrating proactive isolation.

**Negative / risks:**
- RLS policy rollout across 283 tables is a large migration surface; each policy must be
  verified not to break single-tenant queries (mitigated: existing `cross-tenant-rls`
  CI gate rejects regressions; `vhhealth_runtime` role is tested before prod deploy).
- Short-term: two parallel streams increase review load during WS1.

**Mitigations shipped:**
- `fix(db): full multi-tenant RLS policy coverage on 283 tables` (commit `635734cb`, 2026-06-13).
- `fix(infra): non-superuser DB role + wire image-signature gate` (commit `aa3f5d86`, 2026-06-13).
- `fix(db): tenant-scope interactive transactions + replica-aware setTenant` (commit `f33efa39`, 2026-06-13).
- `test(rls): blocking cross-tenant HTTP gate across PHI/financial routes` (commit `c6c9d41e`, 2026-06-13).
