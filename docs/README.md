# Documentation Index

This directory is the current front door for VH Health Platform documentation.
Use this index before following older deep links: dated audits and generated
reports are retained as evidence, not as the source of truth for current
operations.

## Start Here

| Topic | Document |
| --- | --- |
| Release gate | [`RELEASE_READINESS.md`](RELEASE_READINESS.md) |
| Deployment runbook | [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md) |
| India go-live readiness | [`india-deployment-readiness.md`](india-deployment-readiness.md) |
| Backend docs index | [`../apps/backend/docs/README.md`](../apps/backend/docs/README.md) |
| Architecture | [`SYSTEM-ARCHITECTURE.md`](SYSTEM-ARCHITECTURE.md) |
| On-call runbook | [`RUNBOOK_ONCALL.md`](RUNBOOK_ONCALL.md) |

## Deployment, Database, And DR

| Topic | Document |
| --- | --- |
| DB schema guardrails | [`DB_SCHEMA_GUARDRAILS.md`](DB_SCHEMA_GUARDRAILS.md) |
| Production DB hardening | [`PRODUCTION_DB_HARDENING.md`](PRODUCTION_DB_HARDENING.md) |
| Live Dalekdefender drift evidence | [`LIVE_DALEKDEFENDER_DRIFT_REMEDIATION.md`](LIVE_DALEKDEFENDER_DRIFT_REMEDIATION.md) |
| DR restore drill evidence | [`DR_RESTORE_DRILL.md`](DR_RESTORE_DRILL.md) |
| Downtime procedure | [`DOWNTIME_PROCEDURE.md`](DOWNTIME_PROCEDURE.md) |
| Hardware requirements | [`HARDWARE_REQUIREMENTS.md`](HARDWARE_REQUIREMENTS.md) |

## Security And Compliance

| Topic | Document |
| --- | --- |
| Security hardening checklist | [`SECURITY_HARDENING_CHECKLIST.md`](SECURITY_HARDENING_CHECKLIST.md) |
| Security remediation tracker | [`PLATFORM_REMEDIATION_PLAN.md`](PLATFORM_REMEDIATION_PLAN.md) |
| Operator-only remediation steps | [`PHASE0_OPERATOR_ACTIONS_2026-06-10.md`](PHASE0_OPERATOR_ACTIONS_2026-06-10.md) |
| ABDM readiness | [`ABDM_READINESS.md`](ABDM_READINESS.md) |
| Tenant/RLS gap analysis | [`GAP_ANALYSIS_TENANT_RLS.md`](GAP_ANALYSIS_TENANT_RLS.md) |
| Security audit snapshot | [`PLATFORM_SECURITY_AUDIT_2026-06-10.md`](PLATFORM_SECURITY_AUDIT_2026-06-10.md) |
| Remediation work order snapshot | [`REMEDIATION_WORK_ORDER_2026-06-10.md`](REMEDIATION_WORK_ORDER_2026-06-10.md) |

## Product, Clinical AI, And Roadmap

| Topic | Document |
| --- | --- |
| Epic roadmap | [`EPIC_LEVEL_ROADMAP.md`](EPIC_LEVEL_ROADMAP.md) |
| Execution log | [`ROADMAP_EXECUTION_LOG.md`](ROADMAP_EXECUTION_LOG.md) |
| Clinical AI rollout | [`CLINICAL_AI_ROLLOUT_PLAN.md`](CLINICAL_AI_ROLLOUT_PLAN.md) |
| AI feature backlog | [`AI_FEATURE_GAP_BACKLOG.md`](AI_FEATURE_GAP_BACKLOG.md) |
| Healthcare AI spec audit | [`HEALTHCARE_AI_SPEC_AUDIT.md`](HEALTHCARE_AI_SPEC_AUDIT.md) |
| Analytics warehouse | [`ANALYTICS_WAREHOUSE.md`](ANALYTICS_WAREHOUSE.md) |

## Smoke And Evidence

| Topic | Document |
| --- | --- |
| Smoke journeys | [`SMOKE_E2E_JOURNEYS.md`](SMOKE_E2E_JOURNEYS.md) |
| First trial readiness | [`FIRST_TRIAL_DEPLOYMENT_READINESS.md`](FIRST_TRIAL_DEPLOYMENT_READINESS.md) |
| Staff workflow evidence snapshot | [`STAFF_ROLE_WORKFLOW_SWEEP.md`](STAFF_ROLE_WORKFLOW_SWEEP.md) |
| QA findings archive | [`qa-findings/README.md`](qa-findings/README.md) |

## Maintenance Notes

- Do not add hand-maintained API endpoint inventories. The current API source is
  `apps/backend/src/docs/swagger.yaml` plus `npm run swagger:validate`.
- Do not add static schema dumps as current DB documentation. Use
  `docs/DB_SCHEMA_GUARDRAILS.md` and the backend contract scripts.
- Keep dated audit reports if they are evidence, but label them as snapshots
  and point new work at the current runbooks above.
