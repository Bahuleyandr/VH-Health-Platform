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

## Milestone / Roadmap

**[`ROADMAP.md`](ROADMAP.md) is the single source of truth for pending work.** The
older planning docs (the 2026-06-16 goal, S-tier, epic roadmap, execution log,
remediation trackers, AI-gap backlog, clinical-AI plans, tenant-RLS gap analysis)
were consolidated into it on 2026-06-22 and moved to [`archive/`](archive/).

| Topic | Document | Notes |
| --- | --- | --- |
| Pending work (consolidated) | [`ROADMAP.md`](ROADMAP.md) | What's left + links to the live runbooks; **start here** |
| Pilot staff workflow scenarios | [`PILOT_STAFF_WORKFLOW_SCENARIOS.md`](PILOT_STAFF_WORKFLOW_SCENARIOS.md) | Real-world workflow coverage for pilot |
| Archived planning docs | [`archive/`](archive/) | Point-in-time roadmaps / logs (provenance only) |

## Architecture

| Topic | Document |
| --- | --- |
| System architecture (single entry point) | [`SYSTEM-ARCHITECTURE.md`](SYSTEM-ARCHITECTURE.md) |
| Canonical clinical timeline | [`CANONICAL_CLINICAL_TIMELINE.md`](CANONICAL_CLINICAL_TIMELINE.md) |
| Analytics warehouse | [`ANALYTICS_WAREHOUSE.md`](ANALYTICS_WAREHOUSE.md) |
| Flutter plugin major migrations | [`FLUTTER_PLUGIN_MAJOR_MIGRATIONS.md`](FLUTTER_PLUGIN_MAJOR_MIGRATIONS.md) |

## Deployment, Database, And DR

| Topic | Document |
| --- | --- |
| Deployment runbook (end-to-end) | [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md) |
| Hardware requirements | [`HARDWARE_REQUIREMENTS.md`](HARDWARE_REQUIREMENTS.md) |
| India go-live readiness | [`india-deployment-readiness.md`](india-deployment-readiness.md) |
| DB schema guardrails | [`DB_SCHEMA_GUARDRAILS.md`](DB_SCHEMA_GUARDRAILS.md) |
| Production DB hardening | [`PRODUCTION_DB_HARDENING.md`](PRODUCTION_DB_HARDENING.md) |
| Downtime procedure | [`DOWNTIME_PROCEDURE.md`](DOWNTIME_PROCEDURE.md) |
| DR restore drill evidence | [`DR_RESTORE_DRILL.md`](DR_RESTORE_DRILL.md) |
| Live Dalekdefender drift remediation | [`LIVE_DALEKDEFENDER_DRIFT_REMEDIATION.md`](archive/LIVE_DALEKDEFENDER_DRIFT_REMEDIATION.md) |
| Per-tenant rollout playbook | [`PER_TENANT_ROLLOUT_PLAYBOOK.md`](PER_TENANT_ROLLOUT_PLAYBOOK.md) |

## Security And Compliance

| Topic | Document | Notes |
| --- | --- | --- |
| Security hardening checklist | [`SECURITY_HARDENING_CHECKLIST.md`](SECURITY_HARDENING_CHECKLIST.md) | Authoritative gate checklist |
| Operator-only remediation steps | [`PHASE0_OPERATOR_ACTIONS_2026-06-10.md`](PHASE0_OPERATOR_ACTIONS_2026-06-10.md) | Infrastructure-side actions |
| ABDM readiness | [`ABDM_READINESS.md`](ABDM_READINESS.md) | ABDM / NDHM compliance |
| Tenant/RLS gap analysis | [`GAP_ANALYSIS_TENANT_RLS.md`](archive/GAP_ANALYSIS_TENANT_RLS.md) | Row-level security coverage |
| Pentest readiness | [`PENTEST_READINESS.md`](PENTEST_READINESS.md) | Point-in-time; do not edit |
| Security controls self-assessment | [`SECURITY_CONTROLS_SELFASSESSMENT.md`](SECURITY_CONTROLS_SELFASSESSMENT.md) | Point-in-time; do not edit |
| Security audit snapshot (2026-06-10) | [`PLATFORM_SECURITY_AUDIT_2026-06-10.md`](PLATFORM_SECURITY_AUDIT_2026-06-10.md) | Snapshot; evidence only |
| Remediation work order snapshot | [`REMEDIATION_WORK_ORDER_2026-06-10.md`](archive/REMEDIATION_WORK_ORDER_2026-06-10.md) | Snapshot; evidence only |

## Clinical AI And Product

| Topic | Document |
| --- | --- |
| Clinical AI rollout plan | [`CLINICAL_AI_ROLLOUT_PLAN.md`](archive/CLINICAL_AI_ROLLOUT_PLAN.md) |
| AI feature gap backlog | [`AI_FEATURE_GAP_BACKLOG.md`](archive/AI_FEATURE_GAP_BACKLOG.md) |
| Healthcare AI spec audit | [`HEALTHCARE_AI_SPEC_AUDIT.md`](HEALTHCARE_AI_SPEC_AUDIT.md) |

## Smoke, QA, And Evidence

| Topic | Document | Notes |
| --- | --- | --- |
| Smoke E2E journeys | [`SMOKE_E2E_JOURNEYS.md`](SMOKE_E2E_JOURNEYS.md) | Journey coverage map |
| First trial deployment readiness | [`FIRST_TRIAL_DEPLOYMENT_READINESS.md`](FIRST_TRIAL_DEPLOYMENT_READINESS.md) | Pre-trial gate evidence |
| Staff role workflow sweep | [`STAFF_ROLE_WORKFLOW_SWEEP.md`](STAFF_ROLE_WORKFLOW_SWEEP.md) | Snapshot evidence |
| Platform audit (2026-06-13) | [`PLATFORM_AUDIT_2026-06-13.md`](PLATFORM_AUDIT_2026-06-13.md) | Point-in-time; do not edit |
| Patient Play Store submission | [`PATIENT_PLAY_STORE_SUBMISSION.md`](PATIENT_PLAY_STORE_SUBMISSION.md) | Play Store readiness checklist |
| QA findings archive | [`qa-findings/README.md`](qa-findings/README.md) | Agent-driven QA outputs |

## Operational Investigations And Analyses

These documents capture specific investigations or analyses. They are evidence documents; do not edit them after the fact.

| Topic | Document |
| --- | --- |
| NUL byte vitals investigation | [`NUL_BYTE_VITALS_INVESTIGATION.md`](NUL_BYTE_VITALS_INVESTIGATION.md) |
| Mobile list consistency audit | [`MOBILE_LIST_CONSISTENCY_AUDIT.md`](MOBILE_LIST_CONSISTENCY_AUDIT.md) |
| UI table/list consistency audit | [`UI_TABLE_LIST_CONSISTENCY_AUDIT.md`](UI_TABLE_LIST_CONSISTENCY_AUDIT.md) |
| Translation review tracker | [`TRANSLATION_REVIEW_TRACKER.md`](TRANSLATION_REVIEW_TRACKER.md) |
| India deployability controls | [`india-deployment-readiness.md`](india-deployment-readiness.md) |

## Maintenance Notes

- Do not add hand-maintained API endpoint inventories. The current API source is
  `apps/backend/src/docs/swagger.yaml` plus `npm run swagger:validate`.
- Do not add static schema dumps as current DB documentation. Use
  `docs/DB_SCHEMA_GUARDRAILS.md` and the backend contract scripts.
- Keep dated audit reports if they are evidence, but label them as snapshots
  and point new work at the current runbooks above.
- Documents marked "Point-in-time; do not edit" (`S_TIER_ROADMAP.md`,
  `PLATFORM_AUDIT_2026-06-13.md`, `PENTEST_READINESS.md`,
  `SECURITY_CONTROLS_SELFASSESSMENT.md`) are live-managed snapshots;
  updates must come from the process that generated them, not manual edits.
