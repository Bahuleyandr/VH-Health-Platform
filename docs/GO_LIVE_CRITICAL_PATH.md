# Go-Live Critical Path

> **One-page evidence sequence.** This page orders the existing runbooks; it is
> an index, not activation authority and not a declaration that engineering,
> external authority, or live-system work is complete.
>
> _Last reconciled: 2026-09-02 (`github/main` @ `a4ffe9860`). Current posture:
> **STOP / not production-pilot-ready.** See
> [`GO_LIVE_READINESS_GAP_MATRIX.md`](GO_LIVE_READINESS_GAP_MATRIX.md). Re-anchor
> this status to the exact release SHA before use._

## Current posture (start here)

- **Release authority = HELD.** PR #872 (`INF-006`) remains open/draft and
  explicitly requires an out-of-band containment ceremony before merge or
  release use. OWNER-INPUT — release authority receipt: ______.
- **Single-tenant fallback remains configured.** Do not call multi-tenant
  isolation live until the tenant/RLS evidence in the activation checklist is
  complete.
- **Care-team access = shadow.** The ABAC enforce flip is telemetry- and
  clinical-owner-gated. Repository code does not supply the observation or
  activation authority. See [`CARETEAM_ABAC_DESIGN.md`](CARETEAM_ABAC_DESIGN.md).
- **Deploy = GitOps.** A plain `main` push does NOT deploy. Go-live = build/tag container images → bump the digest pins in `infra/kubernetes/apps/kustomization.yaml` (via `scripts/update-prod-digests.mjs`) → an operator manually syncs the `vhhealth-apps` ArgoCD Application (no auto-sync). See [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md).
- **Migrations = fail-closed PreSync.** Payroll-754 owner acceptance is blank,
  inventory-753 readiness migration 756 is absent, and two design dispositions
  remain open. An image rollback cannot undo a forward schema/data change.
- **Monitoring = unactivated.** Templates and routing validation exist; G1
  stays open until owner inputs, ciphertext inclusion, exact manual sync, live
  delivery/acknowledgement/resolution, off-site Watchdog, and rollback evidence
  are retained.

## The sequence

| # | Step | Runbook | Depends on | Status |
|---|---|---|---|---|
| 0 | **Release and owner authority** | [`GO_LIVE_READINESS_GAP_MATRIX.md`](GO_LIVE_READINESS_GAP_MATRIX.md) | — | **HELD — OWNER-INPUT** |
| A | **Provision and qualify infrastructure** (RKE2, CNPG, ingress, tunnel, signed pins, reviewed manual sync) | [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md) | 0 | **OPEN — live evidence** |
| B | **Phase-0 security owner actions** (Sealed-Secrets keys, API keys, JWT secret, CSP/origin/admin CIDRs) | [`PHASE0_OPERATOR_ACTIONS_2026-06-10.md`](PHASE0_OPERATOR_ACTIONS_2026-06-10.md) | 0, A | **OPEN — secrets/owners** |
| C | **Migration, DB hardening, and first DR restore drill** | [`GO_LIVE_ACTIVATION_CHECKLIST.md`](GO_LIVE_ACTIVATION_CHECKLIST.md) · [`PRODUCTION_DB_HARDENING.md`](PRODUCTION_DB_HARDENING.md) · [`DR_RESTORE_DRILL.md`](DR_RESTORE_DRILL.md) | A, B | **STOP — migration/restore gates** |
| D | **G1 observability activation** (owner map, sealed config, manual sync, scrape-to-resolution and Watchdog proof) | [`GO_LIVE_ACTIVATION_CHECKLIST.md`](GO_LIVE_ACTIVATION_CHECKLIST.md) · [`runbooks/C1_3_MONITORING_LIVE_DRILL.md`](runbooks/C1_3_MONITORING_LIVE_DRILL.md) | A, B | **OPEN — live delivery proof** |
| E | **India/compliance gates** | [`india-deployment-readiness.md`](india-deployment-readiness.md) · [`ABDM_READINESS.md`](ABDM_READINESS.md) | A–D | **OPEN — external owners** |
| F | **Multi-tenant cutover** *(only when approved)* | [`TENANT_ONBOARDING_RUNBOOK.md`](TENANT_ONBOARDING_RUNBOOK.md) | A–E | **OPEN — operator evidence** |
| G | **Care-team enforce flip** *(telemetry-gated)* | [`CARETEAM_ABAC_DESIGN.md`](CARETEAM_ABAC_DESIGN.md) | A, D, post-pilot telemetry | **OPEN — clinical owner** |

### Optional / future (not on the first-trial path)

- **Vault Transit auto-unseal + secret rotation** — repository configuration
  exists, but the prod overlay patch is **commented out** in
  `overlays/prod/kustomization.yaml` and no live qualification is asserted.
  Sealed Secrets is the documented interim path. Run
  [`VAULT_SECRET_ROTATION_RUNBOOK.md`](VAULT_SECRET_ROTATION_RUNBOOK.md) only
  after owner authorization and the vault-bootstrap init sequence.
- **Clinical-AI model wiring** — modules are template-by-default; the per-tenant deep-model rollout (local Ollama GPU node + enablement) is operator work, deferred LAST. See [`PER_TENANT_ROLLOUT_PLAYBOOK.md`](PER_TENANT_ROLLOUT_PLAYBOOK.md) and `check-clinical-ai-readiness.mjs`.
- **First trial (single-tenant pilot)** scope: [`FIRST_TRIAL_DEPLOYMENT_READINESS.md`](FIRST_TRIAL_DEPLOYMENT_READINESS.md) + [`PILOT_STAFF_WORKFLOW_SCENARIOS.md`](PILOT_STAFF_WORKFLOW_SCENARIOS.md).

## Completion language

Merged code, a validated template, a green CI run, or a prepared runbook may be
described as repository preparation evidence only. It must not be summarized as
"ready", "live", "deployed", or "complete" unless the exact release and target
environment carry the owner and live-system receipts required by
[`GO_LIVE_ACTIVATION_CHECKLIST.md`](GO_LIVE_ACTIVATION_CHECKLIST.md).
