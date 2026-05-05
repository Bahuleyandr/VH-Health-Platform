# Backend Documentation Index

Current operational docs live here plus in the root `docs/` directory. Prefer
the root release and schema guardrail docs for current gates; some older backend
documents are preserved as historical snapshots and are labelled below.

## Current

| Document | Purpose |
| --- | --- |
| [`API_DOCUMENTATION.md`](./API_DOCUMENTATION.md) | Backend API reference. |
| [`CI_REQUIRED_CHECKS.md`](./CI_REQUIRED_CHECKS.md) | Required-check notes and local fallback context. |
| [`DB-REBUILD-GUIDE.md`](./DB-REBUILD-GUIDE.md) | Rebuild a database from migrations. |
| [`DB-MIGRATION-MANIFEST.md`](./DB-MIGRATION-MANIFEST.md) | Migration inventory. Raw SQL migrations live in `../src/migrations`. |
| [`DB-MIGRATION-PLAN.md`](./DB-MIGRATION-PLAN.md) | Production DB migration plan. |
| [`DISASTER-RECOVERY.md`](./DISASTER-RECOVERY.md) | Disaster recovery notes. |
| [`RUNBOOKS/README.md`](./RUNBOOKS/README.md) | Operational runbook index. |

## Cross-Stack Docs

| Document | Purpose |
| --- | --- |
| [`../../../docs/DB_SCHEMA_GUARDRAILS.md`](../../../docs/DB_SCHEMA_GUARDRAILS.md) | Current schema drift and seed guardrails. |
| [`../../../docs/RELEASE_READINESS.md`](../../../docs/RELEASE_READINESS.md) | Local release/CI gate. |
| [`../../../docs/DEPLOYMENT_GUIDE.md`](../../../docs/DEPLOYMENT_GUIDE.md) | Kubernetes and deployment runbook. |
| [`../../../docs/PLATFORM_REMEDIATION_PLAN.md`](../../../docs/PLATFORM_REMEDIATION_PLAN.md) | Remediation tracker. |

## Historical Snapshots

| Document | Notes |
| --- | --- |
| [`DB-SCHEMA-REFERENCE.md`](./DB-SCHEMA-REFERENCE.md) | Snapshot from 2026-04-04. Useful for comparison, not a live schema source. |
| [`RELEASE_NOTES_2026-04.md`](./RELEASE_NOTES_2026-04.md) | April 2026 release summary. |

Obsolete per-app roadmaps, coverage snapshots, and cross-repo convention notes
were removed because they pointed at archived repositories or completed scratch
plans. Use the current root docs above for new work.
