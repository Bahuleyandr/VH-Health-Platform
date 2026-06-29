# Go-Live Critical Path

> **One-page operator sequence.** Everything substantial is **code-complete and merged to `main`** — go-live is now **operator execution**, not engineering. This doc orders the existing runbooks with their dependencies so an operator runs them in the right sequence. Each step links the authoritative runbook; this page is the index, not the detail.
>
> _Last reconciled: 2026-06-29 (`main` @ `bf9d225a`). Live work tracker: [`ROADMAP.md`](ROADMAP.md) §0._

## Current posture (start here)

- **Single-tenant.** The backend runs with `ALLOW_DEFAULT_TENANT=true`; multi-tenant isolation is NOT yet active (it's code-complete — Phase F below).
- **Care-team access = shadow.** The ABAC guards are shipped but default to `shadow` mode (log-only). The `CAN-011` shadow→enforce flip is **telemetry-gated** — the sole remaining *security* go-live item, and an operator/observability decision, not code. See [`CARETEAM_ABAC_DESIGN.md`](CARETEAM_ABAC_DESIGN.md).
- **Deploy = GitOps.** A plain `main` push does NOT deploy. Go-live = build/tag container images → bump the digest pins in `infra/kubernetes/overlays/prod/kustomization.yaml` → ArgoCD syncs. See [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md).

## The sequence

| # | Step | Runbook | Depends on | Status |
|---|---|---|---|---|
| A | **Provision + deploy infra** (RKE2 cluster, CNPG Postgres, ingress, Cloudflare Tunnel, build/sign/pin images, ArgoCD sync) | [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md) | — | code-complete · operator |
| B | **Phase-0 security operator actions** (Sealed-Secrets keys, API keys, JWT secret, CSP/origin allowlists, etc.) | [`PHASE0_OPERATOR_ACTIONS_2026-06-10.md`](PHASE0_OPERATOR_ACTIONS_2026-06-10.md) | A | operator |
| C | **DB hardening + first DR restore drill** (verify backups/PITR, run the automated drill, R2 versioning + lifecycle + write-only key, commit evidence to `docs/qa-findings/`) | [`PRODUCTION_DB_HARDENING.md`](PRODUCTION_DB_HARDENING.md) · [`DR_RESTORE_DRILL.md`](DR_RESTORE_DRILL.md) | A, B | drill automation shipped · execution pending |
| D | **Observability activation** (Alertmanager route secrets — Discord/PagerDuty, confirm Grafana dashboards-as-code sidecar import, deadman proof) | [`RUNBOOK_ONCALL.md`](RUNBOOK_ONCALL.md) · ROADMAP §0 #8 | A | alert-tier code-complete · operator |
| E | **India / compliance gates** (DPDP, ABDM, CERT-In 180-day log retention — the Loki 180d config is in `loki-values.yaml`, awaiting this sync) | [`india-deployment-readiness.md`](india-deployment-readiness.md) · [`ABDM_READINESS.md`](ABDM_READINESS.md) | A–D | code/config done · counsel sign-off pending |
| F | **Multi-tenant cutover** *(only when going multi-tenant)* — wildcard DNS/TLS, per-tenant `<slug>-api` subdomains, run `onboard-tenant.mjs` per tenant, then flip `ALLOW_DEFAULT_TENANT=false` | [`TENANT_ONBOARDING_RUNBOOK.md`](TENANT_ONBOARDING_RUNBOOK.md) | A–E | code-complete (W1–W7) · operator |
| G | **Care-team enforce flip** *(telemetry-gated)* — after observing shadow-mode `careTeamModeGoverned` telemetry shows no legitimate-access denials, flip the default from `shadow` to `enforce` | [`CARETEAM_ABAC_DESIGN.md`](CARETEAM_ABAC_DESIGN.md) | A, post-pilot telemetry | code-complete · telemetry-gated |

### Optional / future (not on the first-trial path)

- **Vault Transit auto-unseal + secret rotation** — Vault is code-complete but its prod overlay patch is **commented out** in `overlays/prod/kustomization.yaml` (operator-gated). Sealed Secrets covers the interim. Run [`VAULT_SECRET_ROTATION_RUNBOOK.md`](VAULT_SECRET_ROTATION_RUNBOOK.md) only after the vault-bootstrap init sequence.
- **Clinical-AI model wiring** — modules are template-by-default; the per-tenant deep-model rollout (local Ollama GPU node + enablement) is operator work, deferred LAST. See [`PER_TENANT_ROLLOUT_PLAYBOOK.md`](PER_TENANT_ROLLOUT_PLAYBOOK.md) and `check-clinical-ai-readiness.mjs`.
- **First trial (single-tenant pilot)** scope: [`FIRST_TRIAL_DEPLOYMENT_READINESS.md`](FIRST_TRIAL_DEPLOYMENT_READINESS.md) + [`PILOT_STAFF_WORKFLOW_SCENARIOS.md`](PILOT_STAFF_WORKFLOW_SCENARIOS.md).

## What is NOT a blocker (code-complete, on `main`)

The S-tier program, full multi-tenancy (W1–W7), the OpenAPI contract pipeline, the observability alert tier, the offline-first clinical-write trilogy (MAR/CPOE/e-Rx), the real-time dashboards epic (13 admin boards), the clinical-AI substrate (5 features + CDS surfacing), and the full 2026-06-27 security-audit remediation (57 findings) are all merged. The remaining work is the operator sequence above. See [`ROADMAP.md`](ROADMAP.md) §0 for the live tracker and [`GO_LIVE_ACTIVATION_CHECKLIST.md`](GO_LIVE_ACTIVATION_CHECKLIST.md) for the detailed activation checklist.
