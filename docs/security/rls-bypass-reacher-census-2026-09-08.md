# RLS bypass-reacher census — 2026-09-08

Source revision: `0d9254cec08bc388811f0cad95e34529e564aa8a`. Exact normalized source and migration SHA-256 manifests are in the adjacent JSON pin.

**Census only: no policy changes, conversions, completed dispositions or runtime acceptance claims.** Every entry is PENDING with an intended disposition and future module PR. A closure must reduce K to zero for its table and carry the disposition tests in that same PR.

Static conservative enumeration. PENDING includes paths whose context, activation, historical ledger or dynamic dispatch still needs disposition proof. No job was invoked and no disposition is accepted here.

## Reproduction and counting predicates

Run from apps/backend: `node scripts/rls-bypass-reacher-census.mjs --check`. Regenerate intentionally with `--write`. The source reader parses JavaScript and follows imported functions, callbacks, SQL wrappers and immutable SQL/handler maps; it never imports the application or connects to a database. The JSON stores the resolved SQL, physical sink, all origins and representative call paths for each statement.

- ENTRY POINTS: actual AST call expressions named runWithSuperAdmin, withJobLock or withReplicaLocalJobGuard. Definitions and comments do not count. A callback argument may be forwarded by a helper; registered jobs supply the concrete callback roots.
- JOBS: every registerCron call in src/utils/scheduler.js, across all feature guards, with its unique literal job name and resolved callback. These are potential source registrations, not simultaneously active jobs. Registration in a loop or function fails generation until expanded; this source has neither. No invoked-job count is claimed.
- RUNTIME REACHING STATEMENTS: distinct table + SQL origin (line and column), through registered jobs, explicit bypass callbacks, bare transaction callbacks, timers, module initialization/startup, and read-only clients. Repeated paths/contexts are merged into one entry. Tenant-switched and timer-inherited paths remain candidates pending proof. Plain request-path receiver calls alone are not census roots.
- ADMINISTRATIVE STATEMENTS: expand the migration runner using its actual splitStatements parser. One SQL statement is one entry; deferred function bodies are conservative candidates, not claimed executions at CREATE FUNCTION time. Catalog-driven EXECUTE statements expand to every target table pending ledger/role proof. This administrative set is shown separately from runtime jobs and included in N so unknown migration dispatch cannot create a false empty pin.
- SQL tables: resolve FROM/JOIN/UPDATE/INTO/LOCK/TRUNCATE relation tokens and target Prisma model operations, including SQL passed through wrappers. Dynamic fragments retain every possible target; CTE names do not count as relations. Generation-specific projector handlers are expanded to all imported handlers; generation/event filtering remains pending proof.

Lexical planning predicates (src excluding tests): 29 lines in 6 files match `runWithSuperAdmin\(`; 83 scheduler lines match `withJobLock\(`. These include comments/definitions and are not reaching statements.

Measured populations: **108 entry-point calls; 83 registered jobs; 8383 database-call/source-statement records; 14507 split migration statements.** Entry points by kind: runWithSuperAdmin=25, withJobLock=82, withReplicaLocalJobGuard=1.

## Table pins (users first)

The 22 relations are the unique tenant-bearing tables at the original 22 confirmed findings; the global investigation_test_catalog is excluded. Shared users, emergency_visits, maternity_pregnancies and report_updates are included in the census. Their module labels assign future disposition ownership; this document does not authorize an early policy closure.

| Table | Runtime candidates | Administrative candidates | N reachers = M dispositioned + K pending | Owning module PR |
|---|---:|---:|---|---|
| users | 226 | 176 | 402 reachers = 0 dispositioned + 402 pending | feat/rls-t2-appointments |
| housekeeping_logs | 4 | 27 | 31 reachers = 0 dispositioned + 31 pending | feat/rls-t2-housekeeping |
| housekeeping_floor_assignments | 3 | 26 | 29 reachers = 0 dispositioned + 29 pending | feat/rls-t2-housekeeping |
| housekeeping_zones | 2 | 33 | 35 reachers = 0 dispositioned + 35 pending | feat/rls-t2-housekeeping |
| staff | 24 | 42 | 66 reachers = 0 dispositioned + 66 pending | feat/rls-t2-staff-admin |
| housekeeping_requests | 7 | 28 | 35 reachers = 0 dispositioned + 35 pending | feat/rls-t2-housekeeping |
| doctors | 14 | 31 | 45 reachers = 0 dispositioned + 45 pending | feat/rls-t2-appointments |
| investigations | 13 | 35 | 48 reachers = 0 dispositioned + 48 pending | feat/rls-t2-investigations |
| investigation_bookings | 3 | 31 | 34 reachers = 0 dispositioned + 34 pending | feat/rls-t2-investigations |
| appointment_queues | 2 | 31 | 33 reachers = 0 dispositioned + 33 pending | feat/rls-t2-appointments |
| appointments | 38 | 46 | 84 reachers = 0 dispositioned + 84 pending | feat/rls-t2-appointments |
| emergency_visits | 4 | 35 | 39 reachers = 0 dispositioned + 39 pending | feat/rls-t2-appointments |
| maternity_pregnancies | 1 | 29 | 30 reachers = 0 dispositioned + 30 pending | feat/rls-t2-appointments |
| staff_performance_reviews | 0 | 26 | 26 reachers = 0 dispositioned + 26 pending | feat/rls-t2-staff-admin |
| leave_applications | 3 | 26 | 29 reachers = 0 dispositioned + 29 pending | feat/rls-t2-staff-admin |
| staff_attendance | 1 | 26 | 27 reachers = 0 dispositioned + 27 pending | feat/rls-t2-staff-admin |
| incident_reports | 0 | 26 | 26 reachers = 0 dispositioned + 26 pending | feat/rls-t2-staff-admin |
| report_updates | 0 | 26 | 26 reachers = 0 dispositioned + 26 pending | feat/rls-t2-staff-admin |
| staff_grievances | 0 | 26 | 26 reachers = 0 dispositioned + 26 pending | feat/rls-t2-staff-admin |
| wards | 4 | 46 | 50 reachers = 0 dispositioned + 50 pending | feat/rls-t2-wards-consent-roster-rx |
| patient_data_rights_requests | 0 | 26 | 26 reachers = 0 dispositioned + 26 pending | feat/rls-t2-wards-consent-roster-rx |
| e_prescriptions | 5 | 44 | 49 reachers = 0 dispositioned + 49 pending | feat/rls-t2-wards-consent-roster-rx |

An empty runtime set means the complete nonempty registered-job/root population produced no table statement; the source-table candidate count is printed below for comparison. It does not excuse pending administrative entries or establish unreachability for closure.

## Connection roles and direct pg consumers

These are deployment declarations and source paths, not a live credential inspection. Any configured DSN override must be verified in the owning closure PR. The census executes no database query.

| Consumer | DSN and declared role | BYPASSRLS | Table reach / proof still required |
|---|---|---|---|
| additional imported pg module: scripts/backfill-drug-compositions.mjs:1 | explicit connectionString or DATABASE_URL or TEST_DATABASE_URL; actual connection role requires query | environment-dependent; unverified | Imported by pharmacyOrderController for its pure parser helper. Direct backfill calls at lines 5/21/30/43 only address drug_compositions, pharmacy_catalog and drug_composition_curation_queue; no target-table intersection. Source scan counts this separately from the four imports within src. |
| prisma / bare transaction clients | DATABASE_URL: declared vhhealth_runtime; wrapped transactions SET LOCAL ROLE vhhealth_app | false for both declared runtime roles | infra/kubernetes/apps/backend/configmap.yaml:231-247; infra/kubernetes/base/cnpg/cluster.yaml:225-240; src/lib/prisma.js:628-642. Bare tx sites remain enumerated pending context proof. |
| prismaReadOnly (all sites, including setTenant readOnly wrappers) | DATABASE_READ_URL override, otherwise primary DATABASE_URL; actual override role requires connection query | unknown for override; false for declared primary fallback | src/lib/prisma.js:583-601. Census includes read-only queries even when a request path normally supplies ALS. |
| direct pg: src/utils/scheduler.js:9 | SCHEDULER_LOCK_DATABASE_URL override or DATABASE_URL (declared vhhealth_runtime) | unknown for override; false for declared primary fallback | withDbAdvisoryLock:109/124 only pg_try_advisory_lock/pg_advisory_unlock. Callback SQL is traced separately; no target-table SQL on the lock connection. |
| direct pg: src/services/clinical/bloodborneMarkerReconciliationService.js:78 | SCHEDULER_LOCK_DATABASE_URL override or DATABASE_URL (declared vhhealth_runtime) | unknown for override; false for declared primary fallback | withReconciliationJobLock:665/678 only advisory lock/unlock. Callback Prisma SQL is traced separately. |
| direct pg: src/utils/migrations/runMigrations.js:5 | DATABASE_URL; declared owner migration job uses vhhealth, app uses vhhealth_runtime with RUN_MIGRATIONS=false | true for declared migration owner; false for declared application role | createNoTransactionClient:228; runStatements:213; applyNoTransactionMigration.js:runPgStatements. Expanded SQL statements appear in the administrative appendix. cnpg/cluster.yaml:275-286 and backend/configmap.yaml:247 are declarations, not live proof. |
| direct pg: src/scripts/security/audit-secret-encryption.js:11 | operator DATABASE_URL; actual connection role requires query | environment-dependent; unverified | SECRET_COLUMNS:23 enumerates integration_credentials, smart_apps, hl7_feed_subscriptions, teleconsult_provider_configs and mfa_devices; query:98 checks information_schema and query:141 scans those five tables. Intersection with these 22 tables is empty. |

Required role query on each actual connection, with enforcement enabled in each disposition test:

```sql
SELECT current_user, rolsuper, rolbypassrls
FROM pg_catalog.pg_roles WHERE rolname = current_user;
SELECT name, checksum FROM public._migrations ORDER BY name;
```

The second query must reconcile to the migration manifest before a historical administrative candidate can be proven unreachable; stored routine bodies additionally require caller/context proof. No such proof is claimed by this census.

## Registered jobs

| Job | Registration | Wrapper | Schedule | Registration conditions |
|---|---|---|---|---|
| purge-logs | apps/backend/src/utils/scheduler.js:629 | withJobLock | '0 0 * * *' | process.env.NODE_ENV !== 'test' |
| canary-checks | apps/backend/src/utils/scheduler.js:639 | withJobLock | '*/5 * * * *' | process.env.NODE_ENV !== 'test' |
| idempotency-keys-sweep | apps/backend/src/utils/scheduler.js:647 | withJobLock | '15 * * * *' | process.env.NODE_ENV !== 'test' |
| ledger-reconciliation | apps/backend/src/utils/scheduler.js:658 | withJobLock | '*/30 * * * *' | process.env.NODE_ENV !== 'test' |
| swagger-validation | apps/backend/src/utils/scheduler.js:680 | withJobLock | '0 0 * * *' | process.env.NODE_ENV !== 'test' |
| archive-migration | apps/backend/src/utils/scheduler.js:701 | withJobLock | '0 2 1 * *' | process.env.NODE_ENV !== 'test' |
| r2-cleanup | apps/backend/src/utils/scheduler.js:709 | withJobLock | '0 3 1 * *' | process.env.NODE_ENV !== 'test' |
| purge-archives | apps/backend/src/utils/scheduler.js:714 | withJobLock | '0 3 * * 0' | process.env.NODE_ENV !== 'test' |
| timed-reminders | apps/backend/src/utils/scheduler.js:724 | withJobLock | '0 * * * *' | process.env.NODE_ENV !== 'test' |
| dietary-meal-ticket-generation | apps/backend/src/utils/scheduler.js:734 | withJobLock | '30 23 * * *' | process.env.NODE_ENV !== 'test' |
| process-scheduled-notifications | apps/backend/src/utils/scheduler.js:743 | withJobLock | '*/5 * * * *' | process.env.NODE_ENV !== 'test' |
| drug-chart-missing-sla | apps/backend/src/utils/scheduler.js:750 | withJobLock | '*/5 * * * *' | process.env.NODE_ENV !== 'test' |
| workflow-sla-overdue-sweep | apps/backend/src/utils/scheduler.js:759 | withJobLock | '*/5 * * * *' | process.env.NODE_ENV !== 'test' |
| ward-indent-notification-coverage-recovery | apps/backend/src/utils/scheduler.js:770 | withJobLock | '*/5 * * * *' | process.env.NODE_ENV !== 'test' |
| clinical-alert-delivery-obligation-recovery | apps/backend/src/utils/scheduler.js:781 | withJobLock | '*/5 * * * *' | process.env.NODE_ENV !== 'test' |
| mar-medication-exception-reconciliation | apps/backend/src/utils/scheduler.js:792 | withJobLock | '*/5 * * * *' | process.env.NODE_ENV !== 'test' |
| cath-inventory-shortfall-assignment-recovery | apps/backend/src/utils/scheduler.js:810 | withJobLock | '*/5 * * * *' | process.env.NODE_ENV !== 'test' |
| counter-sale-void-reconciliation | apps/backend/src/utils/scheduler.js:824 | withJobLock | '*/5 * * * *' | process.env.NODE_ENV !== 'test' |
| gateway-refund-reconciliation-notification | apps/backend/src/utils/scheduler.js:839 | withJobLock | '*/5 * * * *' | process.env.NODE_ENV !== 'test' |
| retry-failed-notifications | apps/backend/src/utils/scheduler.js:851 | withJobLock | '*/5 * * * *' | process.env.NODE_ENV !== 'test' |
| notification-outbox-drain | apps/backend/src/utils/scheduler.js:858 | withJobLock | '*/2 * * * *' | process.env.NODE_ENV !== 'test' |
| notification-outbox-auto-replay | apps/backend/src/utils/scheduler.js:886 | withJobLock | '*/15 * * * *' | process.env.NODE_ENV !== 'test' AND notificationOutboxAutoReplayEnabled(process.env) |
| fhir-vital-effects-recovery | apps/backend/src/utils/scheduler.js:902 | withJobLock | '*/2 * * * *' | process.env.NODE_ENV !== 'test' |
| biomed-cmms-maintenance-sweep | apps/backend/src/utils/scheduler.js:906 | withJobLock | '*/5 * * * *' | process.env.NODE_ENV !== 'test' |
| event-outbox-drain | apps/backend/src/utils/scheduler.js:921 | withJobLock | '*/2 * * * *' | process.env.NODE_ENV !== 'test' |
| event-outbox-stale-lease-reaper | apps/backend/src/utils/scheduler.js:925 | withJobLock | '*/5 * * * *' | process.env.NODE_ENV !== 'test' |
| pathway-projector-shadow | apps/backend/src/utils/scheduler.js:935 | withJobLock | '*/2 * * * *' | process.env.NODE_ENV !== 'test' |
| diagnostic-normal-release-sweep | apps/backend/src/utils/scheduler.js:946 | withJobLock | '*/2 * * * *' | process.env.NODE_ENV !== 'test' |
| diagnostic-result-patient-notification | apps/backend/src/utils/scheduler.js:961 | withJobLock | '*/2 * * * *' | process.env.NODE_ENV !== 'test' |
| pathway-projector-stale-lease-reaper | apps/backend/src/utils/scheduler.js:974 | withJobLock | '*/5 * * * *' | process.env.NODE_ENV !== 'test' |
| care-pathway-reconciliation | apps/backend/src/utils/scheduler.js:984 | withJobLock | pathwayReconciliationCron() | process.env.NODE_ENV !== 'test' |
| unread-critical-notification-escalation | apps/backend/src/utils/scheduler.js:994 | withJobLock | '*/10 * * * *' | process.env.NODE_ENV !== 'test' |
| sos-alert-age-escalation | apps/backend/src/utils/scheduler.js:1014 | withJobLock | '*/2 * * * *' | process.env.NODE_ENV !== 'test' AND String(process.env.SOS_ALERT_AGE_ESCALATION_ENABLED ?? 'true').toLowerCase() !== 'false' |
| escalate-stuck-orders | apps/backend/src/utils/scheduler.js:1028 | withJobLock | '*/30 * * * *' | process.env.NODE_ENV !== 'test' |
| operational-alert-sweep | apps/backend/src/utils/scheduler.js:1034 | withJobLock | '*/30 * * * *' | process.env.NODE_ENV !== 'test' AND String(process.env.CLINICAL_AI_OPERATIONAL_ALERTS_ENABLED \|\| '').toLowerCase() === 'true' |
| revenue-cycle-tracker-sweep | apps/backend/src/utils/scheduler.js:1046 | withJobLock | '*/5 * * * *' | process.env.NODE_ENV !== 'test' AND String(process.env.REVENUE_CYCLE_TRACKER_ENABLED \|\| '').toLowerCase() === 'true' |
| coding-suggestion-batch | apps/backend/src/utils/scheduler.js:1060 | withJobLock | '45 1 * * *' | process.env.NODE_ENV !== 'test' AND String(process.env.CLINICAL_AI_CODING_BATCH_ENABLED \|\| '').toLowerCase() === 'true' |
| ward-downtime-pack-output-probe | apps/backend/src/utils/scheduler.js:1085 | withReplicaLocalJobGuard | '*/5 * * * *' | process.env.NODE_ENV !== 'test' |
| siem-export-sweep | apps/backend/src/utils/scheduler.js:1102 | withJobLock | '*/5 * * * *' | process.env.NODE_ENV !== 'test' AND String(process.env.SIEM_EXPORT_SCHEDULER_ENABLED \|\| '').toLowerCase() === 'true' |
| hl7-outbound-feeds | apps/backend/src/utils/scheduler.js:1113 | withJobLock | '*/2 * * * *' | process.env.NODE_ENV !== 'test' |
| interface-engine-outbound-dispatch | apps/backend/src/utils/scheduler.js:1122 | withJobLock | '* * * * *' | process.env.NODE_ENV !== 'test' |
| waitlist-auto-fill | apps/backend/src/utils/scheduler.js:1131 | withJobLock | '*/10 * * * *' | process.env.NODE_ENV !== 'test' |
| credential-expiry-radar | apps/backend/src/utils/scheduler.js:1137 | withJobLock | '30 6 * * *' | process.env.NODE_ENV !== 'test' |
| reap-stale-visits | apps/backend/src/utils/scheduler.js:1145 | withJobLock | '*/15 * * * *' | process.env.NODE_ENV !== 'test' |
| referral-recovery-sweep | apps/backend/src/utils/scheduler.js:1152 | withJobLock | '*/15 * * * *' | process.env.NODE_ENV !== 'test' |
| abdm-stuck-data-request-sweep | apps/backend/src/utils/scheduler.js:1167 | withJobLock | '*/15 * * * *' | process.env.NODE_ENV !== 'test' |
| abha-enrolment-expiry | apps/backend/src/utils/scheduler.js:1178 | withJobLock | '*/5 * * * *' | process.env.NODE_ENV !== 'test' |
| abdm-share-intake-expiry | apps/backend/src/utils/scheduler.js:1186 | withJobLock | '*/5 * * * *' | process.env.NODE_ENV !== 'test' |
| abdm-hiu-fetch-expiry | apps/backend/src/utils/scheduler.js:1194 | withJobLock | '*/5 * * * *' | process.env.NODE_ENV !== 'test' |
| mis-report-schedule-dispatch | apps/backend/src/utils/scheduler.js:1211 | withJobLock | '10 * * * *' | process.env.NODE_ENV !== 'test' |
| expire-bed-inspections | apps/backend/src/utils/scheduler.js:1229 | withJobLock | '0 * * * *' | process.env.NODE_ENV !== 'test' |
| bed-cleaning-dispatch-sweep | apps/backend/src/utils/scheduler.js:1238 | withJobLock | '*/10 * * * *' | process.env.NODE_ENV !== 'test' |
| expire-break-glass | apps/backend/src/utils/scheduler.js:1258 | withJobLock | '*/5 * * * *' | process.env.NODE_ENV !== 'test' |
| audit-chain-verify | apps/backend/src/utils/scheduler.js:1274 | withJobLock | '0 * * * *' | process.env.NODE_ENV !== 'test' |
| results-inbox-escalation | apps/backend/src/utils/scheduler.js:1296 | withJobLock | '*/2 * * * *' | process.env.NODE_ENV !== 'test' |
| investigation-notifications | apps/backend/src/utils/scheduler.js:1301 | withJobLock | '0 9 * * *' | process.env.NODE_ENV !== 'test' |
| roster-deadline-escalation | apps/backend/src/utils/scheduler.js:1306 | withJobLock | process.env.ROSTER_NEXT_WEEK_DEADLINE_CRON \|\| '0 17 * * 5' | process.env.NODE_ENV !== 'test' |
| shift-swap-expiry | apps/backend/src/utils/scheduler.js:1317 | withJobLock | '20 * * * *' | process.env.NODE_ENV !== 'test' |
| payment-gateway-order-expiry | apps/backend/src/utils/scheduler.js:1328 | withJobLock | '*/15 * * * *' | process.env.NODE_ENV !== 'test' |
| payment-gateway-refund-recovery | apps/backend/src/utils/scheduler.js:1338 | withJobLock | '*/5 * * * *' | process.env.NODE_ENV !== 'test' |
| ambulance-position-retention | apps/backend/src/utils/scheduler.js:1353 | withJobLock | '25 * * * *' | process.env.NODE_ENV !== 'test' |
| purge-audit-logs | apps/backend/src/utils/scheduler.js:1363 | withJobLock | '30 3 * * *' | process.env.NODE_ENV !== 'test' |
| purge-staff-messages | apps/backend/src/utils/scheduler.js:1383 | withJobLock | '32 3 * * *' | process.env.NODE_ENV !== 'test' |
| purge-expired-note-drafts | apps/backend/src/utils/scheduler.js:1390 | withJobLock | '38 3 * * *' | process.env.NODE_ENV !== 'test' |
| purge-invalidated-tokens | apps/backend/src/utils/scheduler.js:1397 | withJobLock | '35 3 * * *' | process.env.NODE_ENV !== 'test' |
| purge-expired-otps | apps/backend/src/utils/scheduler.js:1408 | withJobLock | '40 3 * * *' | process.env.NODE_ENV !== 'test' |
| purge-file-deletion-log | apps/backend/src/utils/scheduler.js:1417 | withJobLock | '45 3 * * *' | process.env.NODE_ENV !== 'test' |
| purge-housekeeping-photos | apps/backend/src/utils/scheduler.js:1426 | withJobLock | '50 3 * * *' | process.env.NODE_ENV !== 'test' |
| purge-expired-ambient-audio | apps/backend/src/utils/scheduler.js:1435 | withJobLock | '52 3 * * *' | process.env.NODE_ENV !== 'test' |
| admin-kpi-tick | apps/backend/src/utils/scheduler.js:1459 | withJobLock | '*/30 * * * * *' | process.env.NODE_ENV !== 'test' |
| daily-ops-tick | apps/backend/src/utils/scheduler.js:1461 | withJobLock | '0 * * * * *' | process.env.NODE_ENV !== 'test' |
| teleconsult-ops-tick | apps/backend/src/utils/scheduler.js:1463 | withJobLock | '15 * * * * *' | process.env.NODE_ENV !== 'test' |
| clinical-ai-workflow-resume | apps/backend/src/utils/scheduler.js:1471 | withJobLock | '*/30 * * * * *' | process.env.NODE_ENV !== 'test' |
| clinical-ai-prior-auth-appeal-start | apps/backend/src/utils/scheduler.js:1478 | withJobLock | '*/60 * * * * *' | process.env.NODE_ENV !== 'test' |
| webhook-delivery-dispatch | apps/backend/src/utils/scheduler.js:1484 | withJobLock | '*/30 * * * * *' | process.env.NODE_ENV !== 'test' |
| webhook-reap-stale-inflight | apps/backend/src/utils/scheduler.js:1492 | withJobLock | '*/5 * * * *' | process.env.NODE_ENV !== 'test' |
| nhcx-outbound-dispatch | apps/backend/src/utils/scheduler.js:1500 | withJobLock | '*/30 * * * * *' | process.env.NODE_ENV !== 'test' |
| nhcx-reap-stale-sent | apps/backend/src/utils/scheduler.js:1506 | withJobLock | '*/5 * * * *' | process.env.NODE_ENV !== 'test' |
| salary-revision-workflow-worker | apps/backend/src/utils/scheduler.js:1763 | withJobLock | '* * * * *' | process.env.NODE_ENV !== 'test' |
| monthly-payroll | apps/backend/src/utils/scheduler.js:1800 | withJobLock | '0 6 1 * *' | process.env.NODE_ENV !== 'test' AND process.env.ENABLE_AUTOMATED_PAYROLL_CRONS === 'true' |
| annual-salary-review | apps/backend/src/utils/scheduler.js:1808 | withJobLock | '0 8 1 12 *' | process.env.NODE_ENV !== 'test' AND process.env.ENABLE_AUTOMATED_PAYROLL_CRONS === 'true' |
| trial-catalog-sync | apps/backend/src/utils/scheduler.js:1820 | withJobLock | '30 2 * * 1' | process.env.NODE_ENV !== 'test' |
| knowledge-corpus-refresh | apps/backend/src/utils/scheduler.js:1850 | withJobLock | process.env.KNOWLEDGE_CORPUS_REFRESH_CRON \|\| '15 3 * * 1' | process.env.NODE_ENV !== 'test' |

## users

**402 reachers = 0 dispositioned + 402 pending.** 1328 source statement candidates reference this table before root tracing. Module PR: `feat/rls-t2-appointments`.

| Statement | Contexts | Entry/job origins | PENDING intended disposition |
|---|---|---|---|
| apps/backend/src/controllers/health/patientHealthController.js:578:27:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/controllers/health/patientHealthController.js:884:28:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:97 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/middleware/jwtMiddleware.js:396:18:$queryRawUnsafe | pre-global-tenant-route | residual:pre-global-tenant-route:apps/backend/src/app.js:1057; residual:pre-global-tenant-route:apps/backend/src/routes/health/clientReadinessRoutes.js:17; residual:pre-global-tenant-route:apps/backend/src/routes/health/clientReadinessRoutes.js:28; residual:pre-global-tenant-route:apps/backend/src/routes/health/index.js:60; residual:pre-global-tenant-route:apps/backend/src/routes/health/patientReadinessRoutes.js:14; residual:pre-global-tenant-route:apps/backend/src/routes/infrastructure/index.js:20; residual:pre-global-tenant-route:apps/backend/src/routes/infrastructure/index.js:21; residual:pre-global-tenant-route:apps/backend/src/routes/infrastructure/index.js:22; residual:pre-global-tenant-route:apps/backend/src/routes/infrastructure/rbacRoutes.js:47 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/middleware/jwtMiddleware.js:44:22:$queryRawUnsafe | pre-global-tenant-route | residual:pre-global-tenant-route:apps/backend/src/app.js:1057; residual:pre-global-tenant-route:apps/backend/src/routes/health/clientReadinessRoutes.js:17; residual:pre-global-tenant-route:apps/backend/src/routes/health/clientReadinessRoutes.js:28; residual:pre-global-tenant-route:apps/backend/src/routes/health/index.js:60; residual:pre-global-tenant-route:apps/backend/src/routes/health/patientReadinessRoutes.js:14; residual:pre-global-tenant-route:apps/backend/src/routes/infrastructure/index.js:20; residual:pre-global-tenant-route:apps/backend/src/routes/infrastructure/index.js:21; residual:pre-global-tenant-route:apps/backend/src/routes/infrastructure/index.js:22; residual:pre-global-tenant-route:apps/backend/src/routes/infrastructure/rbacRoutes.js:47 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/routes/fhir/fhirRoutes.js:118:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1101; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1150; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1270 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/routes/fhir/fhirRoutes.js:726:7:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:703 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/routes/fhir/fhirRoutes.js:858:24:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:847 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/routes/fhir/fhirRoutes.js:907:24:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:879 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/routes/pharmacy/wardIndentPatientGuards.js:28:22:$queryRawUnsafe | module-initializer | residual:module-initializer:apps/backend/src/routes/ipd/ipdSupportRoutes.js:374; residual:module-initializer:apps/backend/src/routes/ipd/ipdSupportRoutes.js:397; residual:module-initializer:apps/backend/src/routes/ipd/ipdSupportRoutes.js:436; residual:module-initializer:apps/backend/src/routes/pharmacy/wardIndentRoutes.js:263; residual:module-initializer:apps/backend/src/routes/pharmacy/wardIndentRoutes.js:284 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/routes/pharmacy/wardIndentPatientGuards.js:49:24:$queryRawUnsafe | module-initializer | residual:module-initializer:apps/backend/src/routes/ipd/ipdSupportRoutes.js:112; residual:module-initializer:apps/backend/src/routes/pharmacy/wardIndentRoutes.js:67 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/scripts/test-prisma-render.js:18:23:findMany | module-initializer | residual:module-initializer:apps/backend/src/scripts/test-prisma-render.js:27 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/abdm/abdmHiuService.js:1344:33:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/abdm/abdmRoutes.js:494 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/abdm/abdmHiuService.js:1574:39:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/abdm/abdmRoutes.js:494 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/abdm/abdmHiuService.js:1994:53:$queryRawUnsafe | tenant | job:abdm-hiu-fetch-expiry | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/abdm/abdmHiuService.js:2017:28:$queryRawUnsafe | tenant | job:abdm-hiu-fetch-expiry | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/abdm/abdmHiuService.js:2083:27:$queryRawUnsafe | tenant | job:abdm-hiu-fetch-expiry | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/abdm/abdmService.js:1718:34:$queryRawUnsafe | pre-global-tenant-route, tenant | residual:pre-global-tenant-route:apps/backend/src/routes/abdm/abdmRoutes.js:321 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/abdm/abdmService.js:847:24:$queryRawUnsafe | pre-global-tenant-route | residual:pre-global-tenant-route:apps/backend/src/routes/abdm/abdmRoutes.js:222 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/abdm/abhaEnrolmentService.js:445:26:$queryRawUnsafe | module-initializer | residual:module-initializer:apps/backend/src/routes/abdm/abdmEnrolmentRoutes.js:139; residual:module-initializer:apps/backend/src/routes/abdm/abdmEnrolmentRoutes.js:154 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/abdm/abhaEnrolmentService.js:652:27:$queryRawUnsafe | tenant | residual:module-initializer:apps/backend/src/routes/abdm/abdmEnrolmentRoutes.js:139; residual:module-initializer:apps/backend/src/routes/abdm/abdmEnrolmentRoutes.js:154 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/abdm/abhaEnrolmentService.js:728:27:$queryRawUnsafe | tenant | residual:module-initializer:apps/backend/src/routes/abdm/abdmEnrolmentRoutes.js:139; residual:module-initializer:apps/backend/src/routes/abdm/abdmEnrolmentRoutes.js:154 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/ai/deidentificationService.js:218:19:findUnique | tenant | job:coding-suggestion-batch | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/ai/operationalAlertService.js:110:30:$queryRawUnsafe | tenant | job:operational-alert-sweep | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/appointment/appointmentLifecycleService.js:165:27:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/appointment/appointmentLifecycleService.js:236:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/appointment/appointmentPatientIdentityService.js:104:18:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/appointment/appointmentPatientIdentityService.js:129:18:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/appointment/appointmentPatientIdentityService.js:82:18:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/appointment/appointmentQueueService.js:66:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/appointment/opChildResourceEventService.js:123:22:$queryRawUnsafe | tenant | job:pathway-projector-shadow; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/appointment/opPathwayWorkService.js:154:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/appointment/opPathwayWorkService.js:240:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/appointment/opPathwayWorkService.js:303:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/appointment/opPathwayWorkService.js:944:31:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/auth/authService.js:66:38:create | bare-transaction | residual:bare-transaction:apps/backend/src/services/auth/authService.js:74 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/auth/firebaseAuthService.js:108:via:apps/backend/src/services/auth/firebaseAuthService.js:34:24:$queryRawUnsafe (sink: apps/backend/src/services/auth/firebaseAuthService.js:34:24:$queryRawUnsafe) | read-only-client | residual:read-only-client:apps/backend/src/services/auth/firebaseAuthService.js:108 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/auth/firebaseAuthService.js:185:via:apps/backend/src/services/auth/firebaseAuthService.js:38:9:$executeRawUnsafe (sink: apps/backend/src/services/auth/firebaseAuthService.js:38:9:$executeRawUnsafe) | read-only-client | residual:read-only-client:apps/backend/src/services/auth/firebaseAuthService.js:185 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/auth/firebaseAuthService.js:190:via:apps/backend/src/services/auth/firebaseAuthService.js:38:9:$executeRawUnsafe (sink: apps/backend/src/services/auth/firebaseAuthService.js:38:9:$executeRawUnsafe) | read-only-client | residual:read-only-client:apps/backend/src/services/auth/firebaseAuthService.js:190 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/auth/firebaseAuthService.js:281:via:apps/backend/src/services/auth/firebaseAuthService.js:34:24:$queryRawUnsafe (sink: apps/backend/src/services/auth/firebaseAuthService.js:34:24:$queryRawUnsafe) | read-only-client | residual:read-only-client:apps/backend/src/services/auth/firebaseAuthService.js:281 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/auth/firebaseAuthService.js:351:via:apps/backend/src/services/auth/firebaseAuthService.js:34:24:$queryRawUnsafe (sink: apps/backend/src/services/auth/firebaseAuthService.js:34:24:$queryRawUnsafe) | read-only-client | residual:read-only-client:apps/backend/src/services/auth/firebaseAuthService.js:351 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/auth/firebaseAuthService.js:367:via:apps/backend/src/services/auth/firebaseAuthService.js:38:9:$executeRawUnsafe (sink: apps/backend/src/services/auth/firebaseAuthService.js:38:9:$executeRawUnsafe) | read-only-client | residual:read-only-client:apps/backend/src/services/auth/firebaseAuthService.js:367 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/auth/firebaseAuthService.js:434:via:apps/backend/src/services/auth/firebaseAuthService.js:34:24:$queryRawUnsafe (sink: apps/backend/src/services/auth/firebaseAuthService.js:34:24:$queryRawUnsafe) | read-only-client, tenant | residual:read-only-client:apps/backend/src/services/auth/firebaseAuthService.js:434; residual:read-only-transaction:apps/backend/src/services/auth/firebaseAuthService.js:434 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/auth/firebaseAuthService.js:477:via:apps/backend/src/services/auth/firebaseAuthService.js:34:24:$queryRawUnsafe (sink: apps/backend/src/services/auth/firebaseAuthService.js:34:24:$queryRawUnsafe) | read-only-client | residual:read-only-client:apps/backend/src/services/auth/firebaseAuthService.js:477 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/auth/firebaseAuthService.js:494:via:apps/backend/src/services/auth/firebaseAuthService.js:38:9:$executeRawUnsafe (sink: apps/backend/src/services/auth/firebaseAuthService.js:38:9:$executeRawUnsafe) | read-only-client | residual:read-only-client:apps/backend/src/services/auth/firebaseAuthService.js:494 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/auth/firebaseAuthService.js:529:via:apps/backend/src/services/auth/firebaseAuthService.js:34:24:$queryRawUnsafe (sink: apps/backend/src/services/auth/firebaseAuthService.js:34:24:$queryRawUnsafe) | read-only-client | residual:read-only-client:apps/backend/src/services/auth/firebaseAuthService.js:529 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/auth/firebaseAuthService.js:560:via:apps/backend/src/services/auth/firebaseAuthService.js:34:24:$queryRawUnsafe (sink: apps/backend/src/services/auth/firebaseAuthService.js:34:24:$queryRawUnsafe) | read-only-client | residual:read-only-client:apps/backend/src/services/auth/firebaseAuthService.js:560 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/auth/firebaseAuthService.js:646:via:apps/backend/src/services/auth/firebaseAuthService.js:34:24:$queryRawUnsafe (sink: apps/backend/src/services/auth/firebaseAuthService.js:34:24:$queryRawUnsafe) | read-only-client | residual:read-only-client:apps/backend/src/services/auth/firebaseAuthService.js:646 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/auth/firebaseAuthService.js:661:via:apps/backend/src/services/auth/firebaseAuthService.js:34:24:$queryRawUnsafe (sink: apps/backend/src/services/auth/firebaseAuthService.js:34:24:$queryRawUnsafe) | read-only-client | residual:read-only-client:apps/backend/src/services/auth/firebaseAuthService.js:661 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/auth/firebaseAuthService.js:78:via:apps/backend/src/services/auth/firebaseAuthService.js:34:24:$queryRawUnsafe (sink: apps/backend/src/services/auth/firebaseAuthService.js:34:24:$queryRawUnsafe) | read-only-client | residual:read-only-client:apps/backend/src/services/auth/firebaseAuthService.js:78 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/auth/scimProvisioningService.js:1143:66:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:18 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/auth/scimProvisioningService.js:1150:61:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:18 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/auth/scimProvisioningService.js:484:59:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:20; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:22; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:23 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/auth/scimProvisioningService.js:506:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:19; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:21; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:22; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:23 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/auth/scimProvisioningService.js:542:24:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:19; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:21; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:22; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:23 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/auth/scimProvisioningService.js:566:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:19; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:21; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:22; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:23 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/auth/scimProvisioningService.js:727:11:$executeRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1150; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:19; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:21; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:22; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:23 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/auth/scimProvisioningService.js:826:30:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:19; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:21; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:22; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:23 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/auth/scimProvisioningService.js:898:11:$executeRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:19; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:21; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:22; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:23 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/billing/billingV2Service.js:815:22:$queryRawUnsafe | tenant | job:payment-gateway-refund-recovery; residual:pre-global-tenant-route:apps/backend/src/routes/billing/paymentGatewayWebhookRoutes.js:43 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/billing/gatewayRefundRecoveryService.js:106:28:$queryRawUnsafe | tenant | job:payment-gateway-refund-recovery; residual:pre-global-tenant-route:apps/backend/src/routes/billing/paymentGatewayWebhookRoutes.js:43 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/billing/gatewayRefundRecoveryService.js:937:38:$queryRawUnsafe | tenant | job:payment-gateway-refund-recovery | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/billing/paymentGatewayService.js:1554:33:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1702; job:gateway-refund-reconciliation-notification; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/biomed/biomedCmmsService.js:270:22:$queryRawUnsafe | tenant | job:biomed-cmms-maintenance-sweep | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/biomed/biomedCmmsService.js:317:24:$queryRawUnsafe | tenant | job:biomed-cmms-maintenance-sweep | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/biomed/biomedCmmsService.js:330:10:$queryRawUnsafe | tenant | job:biomed-cmms-maintenance-sweep | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/biomed/biomedCmmsService.js:416:24:$queryRawUnsafe | tenant | job:biomed-cmms-maintenance-sweep | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/biomed/biomedCmmsService.js:437:24:$queryRawUnsafe | tenant | job:biomed-cmms-maintenance-sweep | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/biomed/biomedCmmsService.js:461:24:$queryRawUnsafe | tenant | job:biomed-cmms-maintenance-sweep | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/cds/deteriorationEarlyWarningService.js:47:19:findUnique | tenant | job:fhir-vital-effects-recovery; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/clinical/allergySourceService.js:127:25:$queryRawUnsafe | tenant | job:dietary-meal-ticket-generation | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/clinical/cathLabService.js:3954:10:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1676; job:cath-inventory-shortfall-assignment-recovery; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/clinical/cathLabService.js:4024:22:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1676; job:cath-inventory-shortfall-assignment-recovery; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/clinical/clinicalAlertDeliveryObligationService.js:1862:34:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1643; job:clinical-alert-delivery-obligation-recovery; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/clinical/drugChartSlaService.js:137:10:$queryRawUnsafe | bypass, tenant | entry:apps/backend/src/utils/scheduler.js:1618; job:drug-chart-missing-sla; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/clinical/drugChartSlaService.js:214:10:$queryRawUnsafe | bypass, tenant | entry:apps/backend/src/utils/scheduler.js:1618; job:drug-chart-missing-sla; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/clinical/drugChartSlaService.js:250:10:$queryRawUnsafe | bypass, tenant | entry:apps/backend/src/utils/scheduler.js:1618; job:drug-chart-missing-sla; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/clinical/drugChartSlaService.js:311:10:$queryRawUnsafe | bypass, tenant | entry:apps/backend/src/utils/scheduler.js:1618; job:drug-chart-missing-sla; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/clinical/drugChartSlaService.js:384:23:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1618; job:drug-chart-missing-sla; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/clinical/marMedicationExceptionService.js:108:22:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1656; job:mar-medication-exception-reconciliation; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/clinical/marMedicationExceptionService.js:148:22:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1656; job:mar-medication-exception-reconciliation; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/clinical/marMedicationExceptionService.js:543:34:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1656; job:mar-medication-exception-reconciliation; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/clinical/mergedPatientReadUnion.js:83:24:$queryRawUnsafe | tenant | job:pathway-projector-shadow; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/clinical/news2Service.js:59:22:$queryRawUnsafe | tenant | job:fhir-vital-effects-recovery; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/clinical/news2Service.js:774:22:$queryRawUnsafe | tenant | job:fhir-vital-effects-recovery; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/clinical/problemListService.js:152:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1101 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/clinical/resuscitationEventService.js:477:19:$queryRawUnsafe | tenant | job:fhir-vital-effects-recovery; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/compliance/auditAccountabilityService.js:206:22:$queryRawUnsafe | read-only-client | residual:read-only-client:apps/backend/src/services/compliance/auditAccountabilityService.js:206 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/compliance/auditAccountabilityService.js:232:22:$queryRawUnsafe | read-only-client | residual:read-only-client:apps/backend/src/services/compliance/auditAccountabilityService.js:232 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/compliance/auditAccountabilityService.js:264:22:$queryRawUnsafe | read-only-client | residual:read-only-client:apps/backend/src/services/compliance/auditAccountabilityService.js:264 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/department/departmentService.js:304:26:$queryRawUnsafe | pre-global-tenant-route | residual:pre-global-tenant-route:apps/backend/src/app.js:1054 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/devices/coldChainService.js:487:28:$queryRawUnsafe | pre-global-tenant-route | residual:pre-global-tenant-route:apps/backend/src/routes/coldChainRoutes.js:33 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/diagnostics/diagnosticResultPatientNotificationService.js:115:24:$queryRawUnsafe | tenant | job:diagnostic-result-patient-notification | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/dietary/kitchenService.js:525:24:$queryRawUnsafe | tenant | job:dietary-meal-ticket-generation | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/doctor/adminDoctorService.js:30:10:$queryRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/doctor/adminDoctorService.js:356; residual:bare-transaction:apps/backend/src/services/doctor/adminDoctorService.js:444; residual:bare-transaction:apps/backend/src/services/doctor/adminDoctorService.js:521 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/doctor/adminDoctorService.js:524:35:$queryRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/doctor/adminDoctorService.js:521 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/doctor/adminDoctorService.js:563:42:$queryRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/doctor/adminDoctorService.js:521 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/doctor/doctorRefService.js:56:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1101; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/downtime/clinicalContinuityDeviceLossService.js:204:22:$queryRawUnsafe | tenant | residual:read-only-transaction:apps/backend/src/services/downtime/clinicalContinuityDeviceLossService.js:270 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/ed/edClosureRecoveryService.js:1221:22:$queryRawUnsafe | tenant | job:pathway-projector-shadow | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/emr/cdsEngine.js:154:25:findUnique | tenant | job:fhir-vital-effects-recovery; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/emr/clinicalTimelineService.js:125:10:findUnique | tenant | job:coding-suggestion-batch | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/emr/clinicalTimelineService.js:739:63:findMany | tenant | job:coding-suggestion-batch | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/emr/vitalsChartService.js:127:24:findUnique | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/emr/vitalsChartService.js:142:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/emr/vitalsChartService.js:1472:9:findUnique | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/emr/vitalsChartService.js:1473:9:findUnique | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/emr/vitalsChartService.js:170:24:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/emr/vitalsChartService.js:498:27:findUnique | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/emr/vitalsChartService.js:883:36:findUnique | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/emr/vitalsChartService.js:987:66:$queryRawUnsafe | tenant | job:fhir-vital-effects-recovery; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/engagement/engagementCampaignService.js:662:22:$queryRawUnsafe | tenant | residual:read-only-transaction:apps/backend/src/services/engagement/engagementCampaignService.js:1315 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/feedback/npsService.js:210:30:$queryRawUnsafe | read-only-client | residual:read-only-client:apps/backend/src/services/feedback/npsService.js:210 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/feedback/npsService.js:404:29:$queryRawUnsafe | read-only-client | residual:read-only-client:apps/backend/src/services/feedback/npsService.js:404 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/feedback/npsService.js:441:27:$queryRawUnsafe | read-only-client | residual:read-only-client:apps/backend/src/services/feedback/npsService.js:441 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/fhir/fhirAllergyIntoleranceService.js:569:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1270 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/fhir/fhirAllergyIntoleranceService.js:723:58:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1382; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:703 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/gdpr/dataErasureService.js:182:31:updateMany | bare-transaction | residual:bare-transaction:apps/backend/src/services/gdpr/dataErasureService.js:180 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/health/patientHealthService.js:24:29:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:38; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:43; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:48; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:53 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/import/patientDataImport.js:1571:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/insurance/claimsService.js:1211:25:findUnique | pre-global-tenant-route | residual:pre-global-tenant-route:apps/backend/src/routes/nhcx/nhcxCallbackRoutes.js:148; residual:pre-global-tenant-route:apps/backend/src/routes/nhcx/nhcxCallbackRoutes.js:149; residual:pre-global-tenant-route:apps/backend/src/routes/nhcx/nhcxCallbackRoutes.js:150; residual:pre-global-tenant-route:apps/backend/src/routes/nhcx/nhcxCallbackRoutes.js:151; residual:pre-global-tenant-route:apps/backend/src/routes/nhcx/nhcxCallbackRoutes.js:152; residual:pre-global-tenant-route:apps/backend/src/routes/nhcx/nhcxCallbackRoutes.js:153 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/integrations/externalHl7InboundRecoveryService.js:769:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1150 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/integrations/externalLabRecoveryService.js:410:24:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1150 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/integrations/externalLabRecoveryService.js:429:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1150 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/integrations/externalLabRecoveryService.js:468:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1150 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/integrations/externalScimRecoveryService.js:179:24:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1150 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/integrations/externalVitalsRecoveryService.js:361:29:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1150 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/ipd/wardIndentObligationService.js:205:10:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1630; job:ward-indent-notification-coverage-recovery; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/ipd/wardIndentWorkflowService.js:299:27:$queryRawUnsafe | tenant | residual:read-only-transaction:apps/backend/src/services/ipd/wardIndentWorkflowService.js:4523 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/ipd/wardIndentWorkflowService.js:359:27:$queryRawUnsafe | tenant | residual:read-only-transaction:apps/backend/src/services/ipd/wardIndentWorkflowService.js:4523 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/lab/labClosedLoopService.js:430:27:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1150 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/lab/labCriticalThresholdService.js:205:24:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1150 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/lab/labResultsService.js:700:27:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1150 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/lab/labThresholdExceptionService.js:130:28:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1150 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/nhcx/nhcxFhirProfileService.js:192:22:$queryRawUnsafe | bypass | job:nhcx-outbound-dispatch | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/nhcx/nhcxFhirProfileService.js:239:22:$queryRawUnsafe | bypass | job:nhcx-outbound-dispatch | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/nhcx/nhcxFhirProfileService.js:284:22:$queryRawUnsafe | bypass | job:nhcx-outbound-dispatch | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/notification/notificationService.js:197:via:apps/backend/src/services/notification/notificationService.js:30:24:$queryRawUnsafe (sink: apps/backend/src/services/notification/notificationService.js:30:24:$queryRawUnsafe) | tenant | job:sos-alert-age-escalation | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/notification/notificationService.js:970:via:apps/backend/src/services/notification/notificationService.js:30:24:$queryRawUnsafe (sink: apps/backend/src/services/notification/notificationService.js:30:24:$queryRawUnsafe) | tenant | job:sos-alert-age-escalation | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/notification/staffNotificationService.js:109:22:$queryRawUnsafe | bypass, tenant | entry:apps/backend/src/utils/scheduler.js:1715; entry:apps/backend/src/utils/scheduler.js:1736; job:bed-cleaning-dispatch-sweep; job:results-inbox-escalation; job:sos-alert-age-escalation; job:timed-reminders; job:unread-critical-notification-escalation; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/notification/staffNotificationService.js:198:22:$queryRawUnsafe | bypass, tenant | entry:apps/backend/src/utils/scheduler.js:1715; entry:apps/backend/src/utils/scheduler.js:1736; job:bed-cleaning-dispatch-sweep; job:results-inbox-escalation; job:sos-alert-age-escalation; job:timed-reminders; job:unread-critical-notification-escalation; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/pathways/carePathwayResourceReferenceService.js:467:22:$queryRawUnsafe | tenant | job:pathway-projector-shadow | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/pathways/opPathwayProjector.js:65:22:$queryRawUnsafe | tenant | job:pathway-projector-shadow | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/pathways/pathwayRuntimePersistence.js:71:29:$queryRawUnsafe | tenant | job:diagnostic-normal-release-sweep; job:pathway-projector-shadow | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/patient/patientIdentifierService.js:395:25:findMany | tenant | job:coding-suggestion-batch | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/patientFlow/porterTransportService.js:469:10:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1736; job:results-inbox-escalation; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/patientFlow/porterTransportService.js:535:10:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1736; job:results-inbox-escalation; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/patientFlow/porterTransportService.js:570:22:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1736; job:results-inbox-escalation; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/pharmacy/counterSaleService.js:1657:38:$queryRawUnsafe | tenant | residual:read-only-transaction:apps/backend/src/services/pharmacy/counterSaleService.js:1657 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/pharmacy/counterSaleService.js:1956:26:$executeRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1689; job:counter-sale-void-reconciliation; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/pharmacy/counterSaleService.js:196:26:$queryRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/pharmacy/counterSaleService.js:232 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/pharmacy/counterSaleService.js:206:26:$queryRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/pharmacy/counterSaleService.js:232 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/pharmacy/counterSaleService.js:218:22:$queryRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/pharmacy/counterSaleService.js:232 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/pharmacy/counterSaleService.js:2331:9:$executeRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1689; job:counter-sale-void-reconciliation; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/pharmacy/counterSaleService.js:331:38:$queryRawUnsafe | tenant | residual:read-only-transaction:apps/backend/src/services/pharmacy/counterSaleService.js:331 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/pharmacy/pharmacyCapService.js:111:22:$queryRawUnsafe | tenant | job:nhcx-outbound-dispatch; job:nhcx-reap-stale-sent; residual:pre-global-tenant-route:apps/backend/src/routes/billing/paymentGatewayWebhookRoutes.js:43; residual:pre-global-tenant-route:apps/backend/src/routes/nhcx/nhcxCallbackRoutes.js:148; residual:pre-global-tenant-route:apps/backend/src/routes/nhcx/nhcxCallbackRoutes.js:149; residual:pre-global-tenant-route:apps/backend/src/routes/nhcx/nhcxCallbackRoutes.js:150; residual:pre-global-tenant-route:apps/backend/src/routes/nhcx/nhcxCallbackRoutes.js:151; residual:pre-global-tenant-route:apps/backend/src/routes/nhcx/nhcxCallbackRoutes.js:152; residual:pre-global-tenant-route:apps/backend/src/routes/nhcx/nhcxCallbackRoutes.js:153 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/pharmacy/pharmacyFacilityAuthorityService.js:274:24:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1689; job:counter-sale-void-reconciliation; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:read-only-transaction:apps/backend/src/services/ipd/wardIndentMedicationClosureService.js:243; residual:read-only-transaction:apps/backend/src/services/pharmacy/counterSaleService.js:1566; residual:read-only-transaction:apps/backend/src/services/pharmacy/counterSaleService.js:269; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/results/resultsInboxService.js:53:24:$queryRawUnsafe | bypass, tenant | entry:apps/backend/src/utils/scheduler.js:1736; job:fhir-vital-effects-recovery; job:results-inbox-escalation; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95; startup:apps/backend/src/bin/www.js:118 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/scheduling/schedulingOptimizationService.js:65:22:$queryRawUnsafe | bypass | job:waitlist-auto-fill | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/security/accessDecisionService.js:1126:22:$queryRawUnsafe | bypass, pre-global-tenant-route, startup, tenant | entry:apps/backend/src/utils/scheduler.js:1520; entry:apps/backend/src/utils/scheduler.js:1523; entry:apps/backend/src/utils/scheduler.js:1526; entry:apps/backend/src/utils/scheduler.js:1736; job:admin-kpi-tick; job:daily-ops-tick; job:fhir-vital-effects-recovery; job:results-inbox-escalation; job:teleconsult-ops-tick; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:pre-global-tenant-route:apps/backend/src/routes/coldChainRoutes.js:33; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:703; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:847; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95; startup:apps/backend/src/bin/www.js:118; startup:apps/backend/src/bin/www.js:287 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/security/accessDecisionService.js:1231:22:$queryRawUnsafe | bypass, pre-global-tenant-route, startup, tenant | entry:apps/backend/src/utils/scheduler.js:1520; entry:apps/backend/src/utils/scheduler.js:1523; entry:apps/backend/src/utils/scheduler.js:1526; entry:apps/backend/src/utils/scheduler.js:1736; job:admin-kpi-tick; job:daily-ops-tick; job:fhir-vital-effects-recovery; job:results-inbox-escalation; job:teleconsult-ops-tick; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:pre-global-tenant-route:apps/backend/src/routes/coldChainRoutes.js:33; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:703; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:847; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95; startup:apps/backend/src/bin/www.js:118; startup:apps/backend/src/bin/www.js:287 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/security/accessDecisionService.js:1299:22:$queryRawUnsafe | bypass, pre-global-tenant-route, startup, tenant | entry:apps/backend/src/utils/scheduler.js:1520; entry:apps/backend/src/utils/scheduler.js:1523; entry:apps/backend/src/utils/scheduler.js:1526; entry:apps/backend/src/utils/scheduler.js:1736; job:admin-kpi-tick; job:daily-ops-tick; job:fhir-vital-effects-recovery; job:results-inbox-escalation; job:teleconsult-ops-tick; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:pre-global-tenant-route:apps/backend/src/routes/coldChainRoutes.js:33; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:703; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:847; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95; startup:apps/backend/src/bin/www.js:118; startup:apps/backend/src/bin/www.js:287 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/security/accessDecisionService.js:1436:22:$queryRawUnsafe | bypass, pre-global-tenant-route, startup, tenant | entry:apps/backend/src/utils/scheduler.js:1520; entry:apps/backend/src/utils/scheduler.js:1523; entry:apps/backend/src/utils/scheduler.js:1526; entry:apps/backend/src/utils/scheduler.js:1736; job:admin-kpi-tick; job:daily-ops-tick; job:fhir-vital-effects-recovery; job:results-inbox-escalation; job:teleconsult-ops-tick; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:pre-global-tenant-route:apps/backend/src/routes/coldChainRoutes.js:33; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:703; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:847; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95; startup:apps/backend/src/bin/www.js:118; startup:apps/backend/src/bin/www.js:287 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/security/accessDecisionService.js:1558:22:$queryRawUnsafe | bypass, pre-global-tenant-route, startup, tenant | entry:apps/backend/src/utils/scheduler.js:1520; entry:apps/backend/src/utils/scheduler.js:1523; entry:apps/backend/src/utils/scheduler.js:1526; entry:apps/backend/src/utils/scheduler.js:1736; job:admin-kpi-tick; job:daily-ops-tick; job:fhir-vital-effects-recovery; job:results-inbox-escalation; job:teleconsult-ops-tick; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:pre-global-tenant-route:apps/backend/src/routes/coldChainRoutes.js:33; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:703; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:847; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95; startup:apps/backend/src/bin/www.js:118; startup:apps/backend/src/bin/www.js:287 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/security/accessDecisionService.js:1641:22:$queryRawUnsafe | bypass, pre-global-tenant-route, startup, tenant | entry:apps/backend/src/utils/scheduler.js:1520; entry:apps/backend/src/utils/scheduler.js:1523; entry:apps/backend/src/utils/scheduler.js:1526; entry:apps/backend/src/utils/scheduler.js:1736; job:admin-kpi-tick; job:daily-ops-tick; job:fhir-vital-effects-recovery; job:results-inbox-escalation; job:teleconsult-ops-tick; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:pre-global-tenant-route:apps/backend/src/routes/coldChainRoutes.js:33; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:703; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:847; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95; startup:apps/backend/src/bin/www.js:118; startup:apps/backend/src/bin/www.js:287 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/security/accessDecisionService.js:1759:22:$queryRawUnsafe | bypass, pre-global-tenant-route, startup, tenant | entry:apps/backend/src/utils/scheduler.js:1520; entry:apps/backend/src/utils/scheduler.js:1523; entry:apps/backend/src/utils/scheduler.js:1526; entry:apps/backend/src/utils/scheduler.js:1736; job:admin-kpi-tick; job:daily-ops-tick; job:fhir-vital-effects-recovery; job:results-inbox-escalation; job:teleconsult-ops-tick; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:pre-global-tenant-route:apps/backend/src/routes/coldChainRoutes.js:33; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:703; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:847; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95; startup:apps/backend/src/bin/www.js:118; startup:apps/backend/src/bin/www.js:287 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/security/accessDecisionService.js:1854:22:$queryRawUnsafe | bypass, pre-global-tenant-route, startup, tenant | entry:apps/backend/src/utils/scheduler.js:1520; entry:apps/backend/src/utils/scheduler.js:1523; entry:apps/backend/src/utils/scheduler.js:1526; entry:apps/backend/src/utils/scheduler.js:1736; job:admin-kpi-tick; job:daily-ops-tick; job:fhir-vital-effects-recovery; job:results-inbox-escalation; job:teleconsult-ops-tick; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:pre-global-tenant-route:apps/backend/src/routes/coldChainRoutes.js:33; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:703; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:847; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95; startup:apps/backend/src/bin/www.js:118; startup:apps/backend/src/bin/www.js:287 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/security/accessDecisionService.js:1941:22:$queryRawUnsafe | bypass, pre-global-tenant-route, startup, tenant | entry:apps/backend/src/utils/scheduler.js:1520; entry:apps/backend/src/utils/scheduler.js:1523; entry:apps/backend/src/utils/scheduler.js:1526; entry:apps/backend/src/utils/scheduler.js:1736; job:admin-kpi-tick; job:daily-ops-tick; job:fhir-vital-effects-recovery; job:results-inbox-escalation; job:teleconsult-ops-tick; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:pre-global-tenant-route:apps/backend/src/routes/coldChainRoutes.js:33; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:703; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:847; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95; startup:apps/backend/src/bin/www.js:118; startup:apps/backend/src/bin/www.js:287 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/security/accessDecisionService.js:336:22:$queryRawUnsafe | bypass, pre-global-tenant-route, startup, tenant | entry:apps/backend/src/utils/scheduler.js:1520; entry:apps/backend/src/utils/scheduler.js:1523; entry:apps/backend/src/utils/scheduler.js:1526; entry:apps/backend/src/utils/scheduler.js:1736; job:admin-kpi-tick; job:daily-ops-tick; job:fhir-vital-effects-recovery; job:results-inbox-escalation; job:teleconsult-ops-tick; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:pre-global-tenant-route:apps/backend/src/routes/coldChainRoutes.js:33; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:703; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:847; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95; startup:apps/backend/src/bin/www.js:118; startup:apps/backend/src/bin/www.js:287 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/staff/bulkSalaryRevisionService.js:987:30:$queryRawUnsafe | tenant | job:salary-revision-workflow-worker | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/staff/credentialingService.js:626:28:$queryRawUnsafe | bypass | job:credential-expiry-radar | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/staff/housekeepingTaskDispatchService.js:132:10:$queryRawUnsafe | tenant | job:bed-cleaning-dispatch-sweep | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/staff/housekeepingTaskDispatchService.js:186:10:$queryRawUnsafe | tenant | job:bed-cleaning-dispatch-sweep | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/staff/housekeepingTaskDispatchService.js:223:10:$queryRawUnsafe | tenant | job:bed-cleaning-dispatch-sweep | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/staff/housekeepingTaskDispatchService.js:72:24:$queryRawUnsafe | tenant | job:bed-cleaning-dispatch-sweep | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/staff/housekeepingTaskDispatchService.js:85:30:$queryRawUnsafe | tenant | job:bed-cleaning-dispatch-sweep | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/staff/hr/leaveService.js:330:37:findFirst | bare-transaction | residual:bare-transaction:apps/backend/src/services/staff/hr/leaveService.js:290 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/staff/onCallRosterService.js:245:13:$executeRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/staff/onCallRosterService.js:209 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/staff/onCallRosterService.js:340:13:$executeRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/staff/onCallRosterService.js:293 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/staff/payrollService.js:1032:25:$queryRawUnsafe | tenant | job:monthly-payroll | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/staff/payrollService.js:234:26:$queryRawUnsafe | tenant | job:monthly-payroll | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/staff/payrollService.js:254:25:$queryRawUnsafe | tenant | job:monthly-payroll | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/staff/payrollService.js:3786:31:$queryRawUnsafe | bypass | job:salary-revision-workflow-worker | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/staff/payrollService.js:3808:28:$queryRawUnsafe | bypass | job:salary-revision-workflow-worker | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/staff/payrollService.js:527:31:$queryRawUnsafe | tenant | job:monthly-payroll | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/staff/payrollService.js:884:35:$queryRawUnsafe | tenant | job:monthly-payroll | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/staff/rosterBoardService.js:1266:13:$executeRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/staff/rosterBoardService.js:1153; residual:bare-transaction:apps/backend/src/services/staff/rosterBoardService.js:1387 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/staff/rosterDeadlineService.js:151:22:$queryRawUnsafe | bypass, tenant | entry:apps/backend/src/utils/scheduler.js:1728; job:roster-deadline-escalation; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/staff/rosterDeadlineService.js:90:10:$queryRawUnsafe | bypass, tenant | entry:apps/backend/src/utils/scheduler.js:1728; job:roster-deadline-escalation; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/staff/salaryRevisionActivationService.js:249:28:$queryRawUnsafe | tenant | job:salary-revision-workflow-worker | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/staff/shiftSwapService.js:164:22:$queryRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/staff/shiftSwapService.js:274; residual:bare-transaction:apps/backend/src/services/staff/shiftSwapService.js:505; residual:bare-transaction:apps/backend/src/services/staff/shiftSwapService.js:557; residual:bare-transaction:apps/backend/src/services/staff/shiftSwapService.js:671 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/staff/shiftSwapService.js:90:22:$queryRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/staff/shiftSwapService.js:671 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/tenant/tenantService.js:276:24:$queryRawUnsafe | pre-global-tenant-route | residual:pre-global-tenant-route:apps/backend/src/app.js:1063; residual:pre-global-tenant-route:apps/backend/src/routes/health/clientReadinessRoutes.js:17; residual:pre-global-tenant-route:apps/backend/src/routes/health/clientReadinessRoutes.js:28; residual:pre-global-tenant-route:apps/backend/src/routes/health/index.js:60; residual:pre-global-tenant-route:apps/backend/src/routes/health/patientReadinessRoutes.js:14; residual:pre-global-tenant-route:apps/backend/src/routes/infrastructure/rbacRoutes.js:47 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/transplant/transplantProgramService.js:910:7:$queryRawUnsafe | tenant | residual:read-only-transaction:apps/backend/src/services/transplant/transplantProgramService.js:898 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/uhi/uhiAdapterService.js:215:10:$queryRawUnsafe | pre-global-tenant-route | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/uhi/uhiAdapterService.js:471:26:$queryRawUnsafe | pre-global-tenant-route | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/uhi/uhiAdapterService.js:619:24:$queryRawUnsafe | pre-global-tenant-route | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/workflow/escalationEngineService.js:297:22:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1736; job:results-inbox-escalation; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/workflow/escalationEngineService.js:427:13:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1736; job:results-inbox-escalation; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/workflow/escalationEngineService.js:464:13:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1736; job:results-inbox-escalation; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/workflow/escalationEngineService.js:495:22:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1736; job:results-inbox-escalation; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/workflow/taskService.js:5069:30:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1676; job:cath-inventory-shortfall-assignment-recovery; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/workflow/workflowHumanOwnerService.js:160:22:$queryRawUnsafe | bypass, tenant | entry:apps/backend/src/utils/scheduler.js:1736; job:diagnostic-normal-release-sweep; job:fhir-vital-effects-recovery; job:pathway-projector-shadow; job:results-inbox-escalation; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95; startup:apps/backend/src/bin/www.js:118 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/workflow/workflowHumanOwnerService.js:83:22:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1676; job:cath-inventory-shortfall-assignment-recovery; job:diagnostic-normal-release-sweep; job:pathway-projector-shadow; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/clinical/vitalSignMonitor.js:129:24:$queryRawUnsafe | tenant | job:fhir-vital-effects-recovery; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/clinical/vitalSignMonitor.js:332:30:$queryRawUnsafe | tenant | job:fhir-vital-effects-recovery; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/clinical/vitalSignMonitor.js:61:15:$queryRawUnsafe | tenant | job:fhir-vital-effects-recovery; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/clinical/vitalSignMonitor.js:71:15:$queryRawUnsafe | tenant | job:fhir-vital-effects-recovery; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/notifications/appointmentReminderJob.js:105:10:$queryRawUnsafe | tenant | job:timed-reminders; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:read-only-transaction:apps/backend/src/utils/notifications/appointmentReminderJob.js:159; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/notifications/clinicalAlertFanout.js:54:23:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1643; job:clinical-alert-delivery-obligation-recovery; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:read-only-transaction:apps/backend/src/utils/notifications/clinicalAlertFanout.js:67; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/notifications/InvestigationNotificationJob.js:15:26:$queryRawUnsafe | bypass, tenant | entry:apps/backend/src/utils/scheduler.js:1723; job:investigation-notifications; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/utils/notifications/notificationDispatcher.js:143:15:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1581; job:fhir-vital-effects-recovery; job:notification-outbox-drain; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/notifications/notificationDispatcher.js:150:15:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1581; job:fhir-vital-effects-recovery; job:notification-outbox-drain; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/notifications/notificationOutbox.js:125:24:$queryRawUnsafe | bypass, pre-global-tenant-route, tenant | entry:apps/backend/src/utils/scheduler.js:1581; entry:apps/backend/src/utils/scheduler.js:1630; entry:apps/backend/src/utils/scheduler.js:1656; entry:apps/backend/src/utils/scheduler.js:1702; entry:apps/backend/src/utils/scheduler.js:1723; entry:apps/backend/src/utils/scheduler.js:1736; job:biomed-cmms-maintenance-sweep; job:credential-expiry-radar; job:fhir-vital-effects-recovery; job:gateway-refund-reconciliation-notification; job:investigation-notifications; job:mar-medication-exception-reconciliation; job:monthly-payroll; job:notification-outbox-auto-replay; job:notification-outbox-drain; job:operational-alert-sweep; job:payment-gateway-refund-recovery; job:process-scheduled-notifications; job:results-inbox-escalation; job:retry-failed-notifications; job:timed-reminders; job:ward-indent-notification-coverage-recovery; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:pre-global-tenant-route:apps/backend/src/routes/billing/paymentGatewayWebhookRoutes.js:43; residual:pre-global-tenant-route:apps/backend/src/routes/coldChainRoutes.js:33; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1150; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95; startup:apps/backend/src/bin/www.js:118 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/utils/notifications/notificationOutboxDelivery.js:101:26:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1581; job:notification-outbox-drain; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/notifications/notificationOutboxDelivery.js:124:26:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1581; job:notification-outbox-drain; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/notifications/notificationOutboxDelivery.js:65:via:apps/backend/src/utils/notifications/notificationOutboxDelivery.js:60:11:$queryRawUnsafe (sink: apps/backend/src/utils/notifications/notificationOutboxDelivery.js:60:11:$queryRawUnsafe) | tenant | residual:tenant:apps/backend/src/utils/notifications/notificationOutboxDelivery.js:65 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/notifications/patientNotificationFeed.js:91:22:$queryRawUnsafe | tenant | job:diagnostic-result-patient-notification; job:process-scheduled-notifications; job:timed-reminders; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/notifications/sendPushNotification.js:205:21:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1581; entry:apps/backend/src/utils/scheduler.js:1723; job:escalate-stuck-orders; job:fhir-vital-effects-recovery; job:investigation-notifications; job:notification-outbox-drain; job:retry-failed-notifications; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/notifications/stuckOrderEscalation.js:89:26:$queryRawUnsafe | tenant | job:escalate-stuck-orders | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/schemaHealthCheck.js:58:7:count | module-initializer, startup | residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/utils/tokenBlacklist.js:428:28:$queryRawUnsafe | bare-transaction, tenant | residual:bare-transaction:apps/backend/src/controllers/auth/adminAuthController.js:455; residual:bare-transaction:apps/backend/src/services/auth/authService.js:542; residual:bare-transaction:apps/backend/src/services/auth/authService.js:667; residual:bare-transaction:apps/backend/src/services/auth/authService.js:933; residual:bare-transaction:apps/backend/src/services/gdpr/dataErasureService.js:180; residual:bare-transaction:apps/backend/src/utils/tokenBlacklist.js:396; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1150; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:19; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:21; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:22; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:23 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/utils/tokenBlacklist.js:638:24:$queryRawUnsafe | pre-global-tenant-route, startup | residual:pre-global-tenant-route:apps/backend/src/app.js:1057; residual:pre-global-tenant-route:apps/backend/src/routes/health/clientReadinessRoutes.js:17; residual:pre-global-tenant-route:apps/backend/src/routes/health/clientReadinessRoutes.js:28; residual:pre-global-tenant-route:apps/backend/src/routes/health/index.js:60; residual:pre-global-tenant-route:apps/backend/src/routes/health/patientReadinessRoutes.js:14; residual:pre-global-tenant-route:apps/backend/src/routes/infrastructure/index.js:20; residual:pre-global-tenant-route:apps/backend/src/routes/infrastructure/index.js:21; residual:pre-global-tenant-route:apps/backend/src/routes/infrastructure/index.js:22; residual:pre-global-tenant-route:apps/backend/src/routes/infrastructure/rbacRoutes.js:47; startup:apps/backend/src/bin/www.js:287 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/utils/tokenBlacklist.js:843:15:$queryRawUnsafe | pre-global-tenant-route, startup | residual:pre-global-tenant-route:apps/backend/src/app.js:1057; residual:pre-global-tenant-route:apps/backend/src/routes/health/clientReadinessRoutes.js:17; residual:pre-global-tenant-route:apps/backend/src/routes/health/clientReadinessRoutes.js:28; residual:pre-global-tenant-route:apps/backend/src/routes/health/index.js:60; residual:pre-global-tenant-route:apps/backend/src/routes/health/patientReadinessRoutes.js:14; residual:pre-global-tenant-route:apps/backend/src/routes/infrastructure/index.js:20; residual:pre-global-tenant-route:apps/backend/src/routes/infrastructure/index.js:21; residual:pre-global-tenant-route:apps/backend/src/routes/infrastructure/index.js:22; residual:pre-global-tenant-route:apps/backend/src/routes/infrastructure/rbacRoutes.js:47; startup:apps/backend/src/bin/www.js:287 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/utils/websocket/realtimeEmitter.js:101:11:$queryRawUnsafe | tenant | job:fhir-vital-effects-recovery; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/websocket/wsServer.js:222:25:$queryRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/utils/websocket/wsServer.js:221; startup:apps/backend/src/bin/www.js:287 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/utils/websocket/wsServer.js:274:24:$queryRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/utils/websocket/wsServer.js:273; startup:apps/backend/src/bin/www.js:287 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |

Administrative entries (176); each is **PENDING → proven-unreachable**, owned by `feat/rls-t2-appointments`. The shared statement catalog below resolves each ID to its source SQL; the JSON repeats each table-specific disposition explicitly.

- `apps/backend/src/migrations/013_multi_tenant_foundation.sql:statement-4`
- `apps/backend/src/migrations/075_tenant_rls_policies.sql:statement-2`
- `apps/backend/src/migrations/082_investigations_fk_constraints.sql:statement-1`
- `apps/backend/src/migrations/176_eprescriptions_uid_columns.sql:statement-3`
- `apps/backend/src/migrations/176_eprescriptions_uid_columns.sql:statement-4`
- `apps/backend/src/migrations/202_walkin_demographics_guardian_minor.sql:statement-4`
- `apps/backend/src/migrations/205_e_prescriptions_uid_backfill.sql:statement-1`
- `apps/backend/src/migrations/205_e_prescriptions_uid_backfill.sql:statement-2`
- `apps/backend/src/migrations/233_doctor_profile_user_role_repair.sql:statement-2`
- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-15`
- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-21`
- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-27`
- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-28`
- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-3`
- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-34`
- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-40`
- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-45`
- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-9`
- `apps/backend/src/migrations/237_force_rls_phi_tables.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-3`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-4`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-5`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-2`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-3`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-4`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-5`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-6`
- `apps/backend/src/migrations/261_backfill_appointment_queues.sql:statement-2`
- `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:statement-2`
- `apps/backend/src/migrations/295_analytics_publication.sql:statement-2`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-11`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-13`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-14`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:statement-3`
- `apps/backend/src/migrations/310_tenant_id_guc_default.sql:statement-2`
- `apps/backend/src/migrations/324_audit_chain_hardening.sql:statement-3`
- `apps/backend/src/migrations/329_doc_number_uniques_per_tenant.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-5`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-6`
- `apps/backend/src/migrations/331_patient_phi_top_level_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-3`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-6`
- `apps/backend/src/migrations/335_audit_activity_logs_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/377_radiology_tat_metrics.sql:statement-9`
- `apps/backend/src/migrations/580_care_pathway_execution_spine.sql:statement-104`
- `apps/backend/src/migrations/580_care_pathway_execution_spine.sql:statement-109`
- `apps/backend/src/migrations/580_care_pathway_execution_spine.sql:statement-148`
- `apps/backend/src/migrations/580_care_pathway_execution_spine.sql:statement-149`
- `apps/backend/src/migrations/580_care_pathway_execution_spine.sql:statement-152`
- `apps/backend/src/migrations/580_care_pathway_execution_spine.sql:statement-155`
- `apps/backend/src/migrations/580_care_pathway_execution_spine.sql:statement-29`
- `apps/backend/src/migrations/580_care_pathway_execution_spine.sql:statement-42`
- `apps/backend/src/migrations/580_care_pathway_execution_spine.sql:statement-45`
- `apps/backend/src/migrations/580_care_pathway_execution_spine.sql:statement-5`
- `apps/backend/src/migrations/583_lab_astm_atomic_replay.sql:statement-20`
- `apps/backend/src/migrations/583_lab_astm_atomic_replay.sql:statement-33`
- `apps/backend/src/migrations/583_lab_astm_atomic_replay.sql:statement-34`
- `apps/backend/src/migrations/584_care_pathway_governance_pinning.sql:statement-29`
- `apps/backend/src/migrations/584_care_pathway_governance_pinning.sql:statement-38`
- `apps/backend/src/migrations/584_care_pathway_governance_pinning.sql:statement-41`
- `apps/backend/src/migrations/584_care_pathway_governance_pinning.sql:statement-48`
- `apps/backend/src/migrations/585_care_pathway_exclusive_owner_integrity.sql:statement-13`
- `apps/backend/src/migrations/585_care_pathway_exclusive_owner_integrity.sql:statement-14`
- `apps/backend/src/migrations/585_care_pathway_exclusive_owner_integrity.sql:statement-17`
- `apps/backend/src/migrations/585_care_pathway_exclusive_owner_integrity.sql:statement-18`
- `apps/backend/src/migrations/585_care_pathway_exclusive_owner_integrity.sql:statement-19`
- `apps/backend/src/migrations/586_care_pathway_owner_acceptance.sql:statement-19`
- `apps/backend/src/migrations/594_referral_closed_loop.sql:statement-5`
- `apps/backend/src/migrations/595_care_pathways_op_inpatient.sql:statement-21`
- `apps/backend/src/migrations/595_care_pathways_op_inpatient.sql:statement-46`
- `apps/backend/src/migrations/595_care_pathways_op_inpatient.sql:statement-58`
- `apps/backend/src/migrations/595_care_pathways_op_inpatient.sql:statement-66`
- `apps/backend/src/migrations/596_care_pathways_ed_destination_handoff.sql:statement-13`
- `apps/backend/src/migrations/596_care_pathways_ed_destination_handoff.sql:statement-18`
- `apps/backend/src/migrations/597_care_pathways_ed_closure_recovery.sql:statement-14`
- `apps/backend/src/migrations/597_care_pathways_ed_closure_recovery.sql:statement-28`
- `apps/backend/src/migrations/600_clinical_continuity_pack_governance.sql:statement-36`
- `apps/backend/src/migrations/600_clinical_continuity_pack_governance.sql:statement-38`
- `apps/backend/src/migrations/601_clinical_continuity_edge_access.sql:statement-21`
- `apps/backend/src/migrations/604_clinical_continuity_facility_context.sql:statement-29`
- `apps/backend/src/migrations/617_scim_identity_recovery.sql:statement-10`
- `apps/backend/src/migrations/624_clinical_continuity_held_message_release.sql:statement-36`
- `apps/backend/src/migrations/624_clinical_continuity_held_message_release.sql:statement-37`
- `apps/backend/src/migrations/628_external_recovery_operability.sql:statement-36`
- `apps/backend/src/migrations/628_external_recovery_operability.sql:statement-37`
- `apps/backend/src/migrations/628_external_recovery_operability.sql:statement-38`
- `apps/backend/src/migrations/628_external_recovery_operability.sql:statement-40`
- `apps/backend/src/migrations/630_clinical_continuity_incident_packet_provisioning.sql:statement-27`
- `apps/backend/src/migrations/631_hl7_inbound_recovery.sql:statement-14`
- `apps/backend/src/migrations/631_hl7_inbound_recovery.sql:statement-7`
- `apps/backend/src/migrations/632_clinical_continuity_activation_transition_governance.sql:statement-45`
- `apps/backend/src/migrations/632_clinical_continuity_activation_transition_governance.sql:statement-46`
- `apps/backend/src/migrations/632_clinical_continuity_activation_transition_governance.sql:statement-47`
- `apps/backend/src/migrations/647_users_abha_number_tenant_unique.sql:statement-1`
- `apps/backend/src/migrations/661_notification_device_global_handoff.sql:statement-1`
- `apps/backend/src/migrations/663_notification_authority_epoch.sql:statement-5`
- `apps/backend/src/migrations/663_notification_authority_epoch.sql:statement-6`
- `apps/backend/src/migrations/664_payroll_tenant_integrity.sql:statement-3`
- `apps/backend/src/migrations/668_scheduler_truth_and_notification_tenant_integrity.sql:statement-34`
- `apps/backend/src/migrations/669_payroll_attempt_document_delivery.sql:statement-3`
- `apps/backend/src/migrations/710_facility_asset_runtime_constraints.sql:statement-10`
- `apps/backend/src/migrations/710_facility_asset_runtime_constraints.sql:statement-7`
- `apps/backend/src/migrations/741_ward_indent_authoritative_state_machine.sql:statement-4`
- `apps/backend/src/migrations/744_medication_inventory_billing_mar_closure.sql:statement-244`
- `apps/backend/src/migrations/744_medication_inventory_billing_mar_closure.sql:statement-29`
- `apps/backend/src/migrations/744_medication_inventory_billing_mar_closure.sql:statement-33`
- `apps/backend/src/migrations/744_medication_inventory_billing_mar_closure.sql:statement-37`
- `apps/backend/src/migrations/744_medication_inventory_billing_mar_closure.sql:statement-4`
- `apps/backend/src/migrations/744_medication_inventory_billing_mar_closure.sql:statement-6`
- `apps/backend/src/migrations/745_clinical_alert_delivery_obligations.sql:statement-28`
- `apps/backend/src/migrations/745_clinical_alert_delivery_obligations.sql:statement-39`
- `apps/backend/src/migrations/745_clinical_alert_delivery_obligations.sql:statement-40`
- `apps/backend/src/migrations/745_clinical_alert_delivery_obligations.sql:statement-46`
- `apps/backend/src/migrations/745_clinical_alert_delivery_obligations.sql:statement-9`
- `apps/backend/src/migrations/746_pharmacy_counter_sale_void_obligations.sql:statement-17`
- `apps/backend/src/migrations/746_pharmacy_counter_sale_void_obligations.sql:statement-19`
- `apps/backend/src/migrations/747_billing_cash_refund_drawer_reconciliation.sql:statement-26`
- `apps/backend/src/migrations/748_cath_inventory_shortfall_recovery.sql:statement-10`
- `apps/backend/src/migrations/748_cath_inventory_shortfall_recovery.sql:statement-17`
- `apps/backend/src/migrations/752_payment_gateway_refund_recovery.sql:statement-35`
- `apps/backend/src/migrations/752_payment_gateway_refund_recovery.sql:statement-7`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-147`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-149`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-291`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-294`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-341`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-342`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-375`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-48`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-76`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-93`
- `apps/backend/src/migrations/754_salary_revision_tenant_reconciliation.sql:statement-138`
- `apps/backend/src/migrations/754_salary_revision_tenant_reconciliation.sql:statement-179`
- `apps/backend/src/migrations/754_salary_revision_tenant_reconciliation.sql:statement-20`
- `apps/backend/src/migrations/754_salary_revision_tenant_reconciliation.sql:statement-25`
- `apps/backend/src/migrations/754_salary_revision_tenant_reconciliation.sql:statement-29`
- `apps/backend/src/migrations/755_clinical_import_receipt_and_history_immutability.sql:statement-12`
- `apps/backend/src/migrations/755_clinical_import_receipt_and_history_immutability.sql:statement-14`
- `apps/backend/src/migrations/755_clinical_import_receipt_and_history_immutability.sql:statement-19`
- `apps/backend/src/migrations/755_clinical_import_receipt_and_history_immutability.sql:statement-22`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-10`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-11`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-13`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-16`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-18`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-19`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-31`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-33`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-34`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-48`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-57`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-58`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-59`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-6`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-8`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-81`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-87`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-88`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-89`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-9`
- `apps/backend/src/migrations/759_fix_escalation_snapshot_guard_case.sql:statement-2`
- `apps/backend/src/migrations/759_fix_escalation_snapshot_guard_case.sql:statement-3`
- `apps/backend/src/migrations/760_clinical_import_authority_custody_and_reconciliation.sql:statement-11`
- `apps/backend/src/migrations/760_clinical_import_authority_custody_and_reconciliation.sql:statement-22`
- `apps/backend/src/migrations/760_clinical_import_authority_custody_and_reconciliation.sql:statement-24`
- `apps/backend/src/migrations/760_clinical_import_authority_custody_and_reconciliation.sql:statement-25`
- `apps/backend/src/migrations/760_clinical_import_authority_custody_and_reconciliation.sql:statement-26`
- `apps/backend/src/migrations/760_clinical_import_authority_custody_and_reconciliation.sql:statement-27`
- `apps/backend/src/migrations/760_clinical_import_authority_custody_and_reconciliation.sql:statement-29`
- `apps/backend/src/migrations/761_fix_clinical_alert_recovery_snapshot_rule_codes.sql:statement-2`
- `apps/backend/src/migrations/765_cath_device_reuse.sql:statement-31`

## housekeeping_logs

**31 reachers = 0 dispositioned + 31 pending.** 11 source statement candidates reference this table before root tracing. Module PR: `feat/rls-t2-housekeeping`.

| Statement | Contexts | Entry/job origins | PENDING intended disposition |
|---|---|---|---|
| apps/backend/src/utils/housekeepingPurgeJob.js:34:35:$queryRawUnsafe | bypass | job:purge-housekeeping-photos | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/utils/housekeepingPurgeJob.js:44:15:$queryRawUnsafe | bypass | job:purge-housekeeping-photos | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/utils/housekeepingPurgeJob.js:56:37:$queryRawUnsafe | bypass | job:purge-housekeeping-photos | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/utils/housekeepingPurgeJob.js:66:15:$queryRawUnsafe | bypass | job:purge-housekeeping-photos | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |

Administrative entries (27); each is **PENDING → proven-unreachable**, owned by `feat/rls-t2-housekeeping`. The shared statement catalog below resolves each ID to its source SQL; the JSON repeats each table-specific disposition explicitly.

- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-45`
- `apps/backend/src/migrations/237_force_rls_phi_tables.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-3`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-5`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-2`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-3`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-6`
- `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:statement-2`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-11`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-13`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-14`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:statement-3`
- `apps/backend/src/migrations/310_tenant_id_guc_default.sql:statement-2`
- `apps/backend/src/migrations/324_audit_chain_hardening.sql:statement-3`
- `apps/backend/src/migrations/329_doc_number_uniques_per_tenant.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-5`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-6`
- `apps/backend/src/migrations/331_patient_phi_top_level_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-3`
- `apps/backend/src/migrations/335_audit_activity_logs_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/741_ward_indent_authoritative_state_machine.sql:statement-4`

## housekeeping_floor_assignments

**29 reachers = 0 dispositioned + 29 pending.** 10 source statement candidates reference this table before root tracing. Module PR: `feat/rls-t2-housekeeping`.

| Statement | Contexts | Entry/job origins | PENDING intended disposition |
|---|---|---|---|
| apps/backend/src/services/staff/housekeepingTaskDispatchService.js:186:10:$queryRawUnsafe | tenant | job:bed-cleaning-dispatch-sweep | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/staff/rosterBoardService.js:1476:13:$executeRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/staff/rosterBoardService.js:1417 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/staff/rosterBoardService.js:1487:36:$queryRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/staff/rosterBoardService.js:1417 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |

Administrative entries (26); each is **PENDING → proven-unreachable**, owned by `feat/rls-t2-housekeeping`. The shared statement catalog below resolves each ID to its source SQL; the JSON repeats each table-specific disposition explicitly.

- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-45`
- `apps/backend/src/migrations/237_force_rls_phi_tables.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-3`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-5`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-2`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-3`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-6`
- `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:statement-2`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-11`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-13`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-14`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:statement-3`
- `apps/backend/src/migrations/310_tenant_id_guc_default.sql:statement-2`
- `apps/backend/src/migrations/324_audit_chain_hardening.sql:statement-3`
- `apps/backend/src/migrations/329_doc_number_uniques_per_tenant.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-5`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-6`
- `apps/backend/src/migrations/331_patient_phi_top_level_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-3`
- `apps/backend/src/migrations/335_audit_activity_logs_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/741_ward_indent_authoritative_state_machine.sql:statement-4`

## housekeeping_zones

**35 reachers = 0 dispositioned + 35 pending.** 22 source statement candidates reference this table before root tracing. Module PR: `feat/rls-t2-housekeeping`.

| Statement | Contexts | Entry/job origins | PENDING intended disposition |
|---|---|---|---|
| apps/backend/src/services/staff/housekeepingTaskDispatchService.js:186:10:$queryRawUnsafe | tenant | job:bed-cleaning-dispatch-sweep | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/staff/housekeepingTaskDispatchService.js:241:22:$queryRawUnsafe | tenant | job:bed-cleaning-dispatch-sweep | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |

Administrative entries (33); each is **PENDING → proven-unreachable**, owned by `feat/rls-t2-housekeeping`. The shared statement catalog below resolves each ID to its source SQL; the JSON repeats each table-specific disposition explicitly.

- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-45`
- `apps/backend/src/migrations/237_force_rls_phi_tables.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-3`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-5`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-2`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-3`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-6`
- `apps/backend/src/migrations/252_seed_housekeeping_floor_zones.sql:statement-2`
- `apps/backend/src/migrations/255_seed_current_bed_structure.sql:statement-8`
- `apps/backend/src/migrations/255_seed_current_bed_structure.sql:statement-9`
- `apps/backend/src/migrations/257_seed_er_beds.sql:statement-4`
- `apps/backend/src/migrations/257_seed_er_beds.sql:statement-5`
- `apps/backend/src/migrations/258_seed_day_care_dialysis_beds.sql:statement-5`
- `apps/backend/src/migrations/258_seed_day_care_dialysis_beds.sql:statement-6`
- `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:statement-2`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-11`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-13`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-14`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:statement-3`
- `apps/backend/src/migrations/310_tenant_id_guc_default.sql:statement-2`
- `apps/backend/src/migrations/324_audit_chain_hardening.sql:statement-3`
- `apps/backend/src/migrations/329_doc_number_uniques_per_tenant.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-5`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-6`
- `apps/backend/src/migrations/331_patient_phi_top_level_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-3`
- `apps/backend/src/migrations/335_audit_activity_logs_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/741_ward_indent_authoritative_state_machine.sql:statement-4`

## staff

**66 reachers = 0 dispositioned + 66 pending.** 185 source statement candidates reference this table before root tracing. Module PR: `feat/rls-t2-staff-admin`.

| Statement | Contexts | Entry/job origins | PENDING intended disposition |
|---|---|---|---|
| apps/backend/src/services/auth/scimProvisioningService.js:1143:66:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:18 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/auth/scimProvisioningService.js:1150:61:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:18 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/auth/scimProvisioningService.js:484:59:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:20; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:22; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:23 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/auth/scimProvisioningService.js:506:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:19; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:21; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:22; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:23 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/auth/scimProvisioningService.js:542:24:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:19; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:21; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:22; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:23 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/auth/scimProvisioningService.js:566:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:19; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:21; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:22; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:23 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/auth/scimProvisioningService.js:739:11:$executeRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1150; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:19; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:21; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:22; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:23 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/auth/scimProvisioningService.js:845:31:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:19; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:21; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:22; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:23 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/auth/scimProvisioningService.js:922:11:$executeRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:19; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:21; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:22; residual:pre-global-tenant-route:apps/backend/src/routes/scimRoutes.js:23 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/clinical/cathLabService.js:3954:10:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1676; job:cath-inventory-shortfall-assignment-recovery; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/clinical/cathLabService.js:4024:22:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1676; job:cath-inventory-shortfall-assignment-recovery; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/downtime/clinicalContinuityDeviceLossService.js:204:22:$queryRawUnsafe | tenant | residual:read-only-transaction:apps/backend/src/services/downtime/clinicalContinuityDeviceLossService.js:270 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/emr/clinicalTimelineService.js:759:45:findMany | tenant | job:coding-suggestion-batch | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/integrations/externalScimRecoveryService.js:179:24:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1150 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/ipd/wardIndentWorkflowService.js:299:27:$queryRawUnsafe | tenant | residual:read-only-transaction:apps/backend/src/services/ipd/wardIndentWorkflowService.js:4523 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/ipd/wardIndentWorkflowService.js:359:27:$queryRawUnsafe | tenant | residual:read-only-transaction:apps/backend/src/services/ipd/wardIndentWorkflowService.js:4523 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/notification/staffNotificationService.js:109:22:$queryRawUnsafe | bypass, tenant | entry:apps/backend/src/utils/scheduler.js:1715; entry:apps/backend/src/utils/scheduler.js:1736; job:bed-cleaning-dispatch-sweep; job:results-inbox-escalation; job:sos-alert-age-escalation; job:timed-reminders; job:unread-critical-notification-escalation; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/pharmacy/counterSaleService.js:1657:38:$queryRawUnsafe | tenant | residual:read-only-transaction:apps/backend/src/services/pharmacy/counterSaleService.js:1657 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/pharmacy/counterSaleService.js:331:38:$queryRawUnsafe | tenant | residual:read-only-transaction:apps/backend/src/services/pharmacy/counterSaleService.js:331 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/pharmacy/pharmacyFacilityAuthorityService.js:274:24:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1689; job:counter-sale-void-reconciliation; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:read-only-transaction:apps/backend/src/services/ipd/wardIndentMedicationClosureService.js:243; residual:read-only-transaction:apps/backend/src/services/pharmacy/counterSaleService.js:1566; residual:read-only-transaction:apps/backend/src/services/pharmacy/counterSaleService.js:269; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/staff/payrollService.js:1032:25:$queryRawUnsafe | tenant | job:monthly-payroll | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/staff/payrollService.js:884:35:$queryRawUnsafe | tenant | job:monthly-payroll | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/workflow/escalationEngineService.js:297:22:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1736; job:results-inbox-escalation; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/schemaHealthCheck.js:61:7:count | module-initializer, startup | residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |

Administrative entries (42); each is **PENDING → proven-unreachable**, owned by `feat/rls-t2-staff-admin`. The shared statement catalog below resolves each ID to its source SQL; the JSON repeats each table-specific disposition explicitly.

- `apps/backend/src/migrations/077_fix_dev_schema_drift.sql:statement-3`
- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-45`
- `apps/backend/src/migrations/237_force_rls_phi_tables.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-3`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-5`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-2`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-3`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-6`
- `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:statement-2`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-11`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-13`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-14`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:statement-3`
- `apps/backend/src/migrations/310_tenant_id_guc_default.sql:statement-2`
- `apps/backend/src/migrations/324_audit_chain_hardening.sql:statement-3`
- `apps/backend/src/migrations/329_doc_number_uniques_per_tenant.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-5`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-6`
- `apps/backend/src/migrations/331_patient_phi_top_level_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-3`
- `apps/backend/src/migrations/335_audit_activity_logs_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/617_scim_identity_recovery.sql:statement-10`
- `apps/backend/src/migrations/669_payroll_attempt_document_delivery.sql:statement-3`
- `apps/backend/src/migrations/741_ward_indent_authoritative_state_machine.sql:statement-4`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-291`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-294`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-48`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-16`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-18`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-19`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-34`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-48`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-6`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-81`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-87`
- `apps/backend/src/migrations/765_cath_device_reuse.sql:statement-31`

## housekeeping_requests

**35 reachers = 0 dispositioned + 35 pending.** 31 source statement candidates reference this table before root tracing. Module PR: `feat/rls-t2-housekeeping`.

| Statement | Contexts | Entry/job origins | PENDING intended disposition |
|---|---|---|---|
| apps/backend/src/services/staff/housekeepingTaskDispatchService.js:387:22:$queryRawUnsafe | tenant | job:bed-cleaning-dispatch-sweep | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/staff/housekeepingTaskDispatchService.js:581:33:$queryRawUnsafe | tenant | job:bed-cleaning-dispatch-sweep | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/staff/housekeepingTaskDispatchService.js:707:22:$queryRawUnsafe | tenant | job:bed-cleaning-dispatch-sweep | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/housekeepingPurgeJob.js:114:15:$queryRawUnsafe | bypass | job:purge-housekeeping-photos | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/utils/housekeepingPurgeJob.js:122:29:$queryRawUnsafe | bypass | job:purge-housekeeping-photos | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/utils/housekeepingPurgeJob.js:132:15:$queryRawUnsafe | bypass | job:purge-housekeeping-photos | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/utils/housekeepingPurgeJob.js:81:36:$queryRawUnsafe | bypass | job:purge-housekeeping-photos | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |

Administrative entries (28); each is **PENDING → proven-unreachable**, owned by `feat/rls-t2-housekeeping`. The shared statement catalog below resolves each ID to its source SQL; the JSON repeats each table-specific disposition explicitly.

- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-45`
- `apps/backend/src/migrations/237_force_rls_phi_tables.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-3`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-5`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-2`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-3`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-6`
- `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:statement-2`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-11`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-13`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-14`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:statement-3`
- `apps/backend/src/migrations/310_tenant_id_guc_default.sql:statement-2`
- `apps/backend/src/migrations/324_audit_chain_hardening.sql:statement-3`
- `apps/backend/src/migrations/329_doc_number_uniques_per_tenant.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-5`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-6`
- `apps/backend/src/migrations/331_patient_phi_top_level_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-3`
- `apps/backend/src/migrations/335_audit_activity_logs_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/645_housekeeping_request_bed_linkage.sql:statement-6`
- `apps/backend/src/migrations/741_ward_indent_authoritative_state_machine.sql:statement-4`

## doctors

**45 reachers = 0 dispositioned + 45 pending.** 140 source statement candidates reference this table before root tracing. Module PR: `feat/rls-t2-appointments`.

| Statement | Contexts | Entry/job origins | PENDING intended disposition |
|---|---|---|---|
| apps/backend/src/services/appointment/appointmentQueueService.js:66:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/department/departmentService.js:304:26:$queryRawUnsafe | pre-global-tenant-route | residual:pre-global-tenant-route:apps/backend/src/app.js:1054 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/doctor/adminDoctorService.js:365:42:$queryRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/doctor/adminDoctorService.js:356 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/doctor/adminDoctorService.js:445:34:$queryRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/doctor/adminDoctorService.js:444 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/doctor/adminDoctorService.js:474:30:$queryRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/doctor/adminDoctorService.js:444 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/doctor/adminDoctorService.js:524:35:$queryRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/doctor/adminDoctorService.js:521 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/doctor/adminDoctorService.js:591:15:$executeRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/doctor/adminDoctorService.js:521 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/doctor/doctorRefService.js:56:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1101; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/emr/clinicalTimelineService.js:748:43:findMany | tenant | job:coding-suggestion-batch | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/notification/staffNotificationService.js:109:22:$queryRawUnsafe | bypass, tenant | entry:apps/backend/src/utils/scheduler.js:1715; entry:apps/backend/src/utils/scheduler.js:1736; job:bed-cleaning-dispatch-sweep; job:results-inbox-escalation; job:sos-alert-age-escalation; job:timed-reminders; job:unread-critical-notification-escalation; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/security/accessDecisionService.js:1299:22:$queryRawUnsafe | bypass, pre-global-tenant-route, startup, tenant | entry:apps/backend/src/utils/scheduler.js:1520; entry:apps/backend/src/utils/scheduler.js:1523; entry:apps/backend/src/utils/scheduler.js:1526; entry:apps/backend/src/utils/scheduler.js:1736; job:admin-kpi-tick; job:daily-ops-tick; job:fhir-vital-effects-recovery; job:results-inbox-escalation; job:teleconsult-ops-tick; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:pre-global-tenant-route:apps/backend/src/routes/coldChainRoutes.js:33; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:703; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:847; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95; startup:apps/backend/src/bin/www.js:118; startup:apps/backend/src/bin/www.js:287 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/uhi/uhiAdapterService.js:215:10:$queryRawUnsafe | pre-global-tenant-route | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/uhi/uhiAdapterService.js:687:25:$queryRawUnsafe | pre-global-tenant-route | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/utils/notifications/appointmentReminderJob.js:105:10:$queryRawUnsafe | tenant | job:timed-reminders; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:read-only-transaction:apps/backend/src/utils/notifications/appointmentReminderJob.js:159; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |

Administrative entries (31); each is **PENDING → proven-unreachable**, owned by `feat/rls-t2-appointments`. The shared statement catalog below resolves each ID to its source SQL; the JSON repeats each table-specific disposition explicitly.

- `apps/backend/src/migrations/189_paediatric_subsystem_polish.sql:statement-4`
- `apps/backend/src/migrations/233_doctor_profile_user_role_repair.sql:statement-2`
- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-45`
- `apps/backend/src/migrations/237_force_rls_phi_tables.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-3`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-5`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-2`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-3`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-6`
- `apps/backend/src/migrations/261_backfill_appointment_queues.sql:statement-2`
- `apps/backend/src/migrations/261_backfill_appointment_queues.sql:statement-3`
- `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:statement-2`
- `apps/backend/src/migrations/295_analytics_publication.sql:statement-2`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-11`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-13`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-14`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:statement-3`
- `apps/backend/src/migrations/310_tenant_id_guc_default.sql:statement-2`
- `apps/backend/src/migrations/324_audit_chain_hardening.sql:statement-3`
- `apps/backend/src/migrations/329_doc_number_uniques_per_tenant.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-5`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-6`
- `apps/backend/src/migrations/331_patient_phi_top_level_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-3`
- `apps/backend/src/migrations/335_audit_activity_logs_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/741_ward_indent_authoritative_state_machine.sql:statement-4`

## investigations

**48 reachers = 0 dispositioned + 48 pending.** 131 source statement candidates reference this table before root tracing. Module PR: `feat/rls-t2-investigations`.

| Statement | Contexts | Entry/job origins | PENDING intended disposition |
|---|---|---|---|
| apps/backend/src/routes/fhir/fhirRoutes.js:1365:24:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1346 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/routes/fhir/fhirRoutes.js:772:via:apps/backend/src/routes/fhir/fhirRoutes.js:534:18:$queryRawUnsafe (sink: apps/backend/src/routes/fhir/fhirRoutes.js:534:18:$queryRawUnsafe) | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:703 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/appointment/opChildResourceEventService.js:177:22:$queryRawUnsafe | tenant | job:pathway-projector-shadow; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/appointment/opChildResourceEventService.js:355:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/compliance/auditAccountabilityService.js:394:5:$queryRawUnsafe | read-only-client | residual:read-only-client:apps/backend/src/services/compliance/auditAccountabilityService.js:394 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/emr/clinicalTimelineService.js:491:63:findMany | tenant | job:coding-suggestion-batch | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/integrations/externalLabRecoveryService.js:429:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1150 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/integrations/externalLabRecoveryService.js:468:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1150 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/lab/labCriticalThresholdService.js:205:24:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1150 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/pathways/carePathwayResourceReferenceService.js:467:22:$queryRawUnsafe | tenant | job:pathway-projector-shadow | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/pathways/inpatientPathwayProjector.js:148:22:$queryRawUnsafe | tenant | job:pathway-projector-shadow | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/notifications/InvestigationNotificationJob.js:15:26:$queryRawUnsafe | bypass, tenant | entry:apps/backend/src/utils/scheduler.js:1723; job:investigation-notifications; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/utils/notifications/InvestigationNotificationJob.js:98:33:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1723; job:investigation-notifications; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |

Administrative entries (35); each is **PENDING → proven-unreachable**, owned by `feat/rls-t2-investigations`. The shared statement catalog below resolves each ID to its source SQL; the JSON repeats each table-specific disposition explicitly.

- `apps/backend/src/migrations/009_future_proof_clinical_ai.sql:statement-23`
- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-34`
- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-35`
- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-45`
- `apps/backend/src/migrations/237_force_rls_phi_tables.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-3`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-5`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-2`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-3`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-6`
- `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:statement-2`
- `apps/backend/src/migrations/295_analytics_publication.sql:statement-2`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-11`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-13`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-14`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:statement-3`
- `apps/backend/src/migrations/310_tenant_id_guc_default.sql:statement-2`
- `apps/backend/src/migrations/324_audit_chain_hardening.sql:statement-3`
- `apps/backend/src/migrations/329_doc_number_uniques_per_tenant.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-5`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-6`
- `apps/backend/src/migrations/331_patient_phi_top_level_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-3`
- `apps/backend/src/migrations/335_audit_activity_logs_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/580_care_pathway_execution_spine.sql:statement-152`
- `apps/backend/src/migrations/580_care_pathway_execution_spine.sql:statement-45`
- `apps/backend/src/migrations/583_lab_astm_atomic_replay.sql:statement-20`
- `apps/backend/src/migrations/583_lab_astm_atomic_replay.sql:statement-33`
- `apps/backend/src/migrations/583_lab_astm_atomic_replay.sql:statement-34`
- `apps/backend/src/migrations/741_ward_indent_authoritative_state_machine.sql:statement-4`

## investigation_bookings

**34 reachers = 0 dispositioned + 34 pending.** 34 source statement candidates reference this table before root tracing. Module PR: `feat/rls-t2-investigations`.

| Statement | Contexts | Entry/job origins | PENDING intended disposition |
|---|---|---|---|
| apps/backend/src/services/integrations/externalLabRecoveryService.js:468:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1150 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/lab/labCriticalThresholdService.js:205:24:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1150 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/notifications/stuckOrderEscalation.js:73:37:$queryRawUnsafe | tenant | job:escalate-stuck-orders | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |

Administrative entries (31); each is **PENDING → proven-unreachable**, owned by `feat/rls-t2-investigations`. The shared statement catalog below resolves each ID to its source SQL; the JSON repeats each table-specific disposition explicitly.

- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-45`
- `apps/backend/src/migrations/237_force_rls_phi_tables.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-3`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-5`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-2`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-3`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-6`
- `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:statement-2`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-11`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-13`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-14`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:statement-3`
- `apps/backend/src/migrations/310_tenant_id_guc_default.sql:statement-2`
- `apps/backend/src/migrations/324_audit_chain_hardening.sql:statement-3`
- `apps/backend/src/migrations/329_doc_number_uniques_per_tenant.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-5`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-6`
- `apps/backend/src/migrations/331_patient_phi_top_level_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-3`
- `apps/backend/src/migrations/335_audit_activity_logs_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/583_lab_astm_atomic_replay.sql:statement-20`
- `apps/backend/src/migrations/583_lab_astm_atomic_replay.sql:statement-33`
- `apps/backend/src/migrations/583_lab_astm_atomic_replay.sql:statement-34`
- `apps/backend/src/migrations/676_file_scan_status_columns_and_default_disarm.sql:statement-13`
- `apps/backend/src/migrations/676_file_scan_status_columns_and_default_disarm.sql:statement-14`
- `apps/backend/src/migrations/741_ward_indent_authoritative_state_machine.sql:statement-4`

## appointment_queues

**33 reachers = 0 dispositioned + 33 pending.** 7 source statement candidates reference this table before root tracing. Module PR: `feat/rls-t2-appointments`.

| Statement | Contexts | Entry/job origins | PENDING intended disposition |
|---|---|---|---|
| apps/backend/src/services/appointment/appointmentQueueService.js:146:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/lab/labCriticalThresholdService.js:205:24:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1150 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |

Administrative entries (31); each is **PENDING → proven-unreachable**, owned by `feat/rls-t2-appointments`. The shared statement catalog below resolves each ID to its source SQL; the JSON repeats each table-specific disposition explicitly.

- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-45`
- `apps/backend/src/migrations/237_force_rls_phi_tables.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-3`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-5`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-2`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-3`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-6`
- `apps/backend/src/migrations/261_backfill_appointment_queues.sql:statement-2`
- `apps/backend/src/migrations/261_backfill_appointment_queues.sql:statement-3`
- `apps/backend/src/migrations/261_backfill_appointment_queues.sql:statement-4`
- `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:statement-2`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-11`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-13`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-14`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:statement-3`
- `apps/backend/src/migrations/310_tenant_id_guc_default.sql:statement-2`
- `apps/backend/src/migrations/324_audit_chain_hardening.sql:statement-3`
- `apps/backend/src/migrations/329_doc_number_uniques_per_tenant.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-5`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-6`
- `apps/backend/src/migrations/331_patient_phi_top_level_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-3`
- `apps/backend/src/migrations/335_audit_activity_logs_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/598_facility_tenant_fk_integrity.sql:statement-15`
- `apps/backend/src/migrations/598_facility_tenant_fk_integrity.sql:statement-8`
- `apps/backend/src/migrations/741_ward_indent_authoritative_state_machine.sql:statement-4`

## appointments

**84 reachers = 0 dispositioned + 84 pending.** 214 source statement candidates reference this table before root tracing. Module PR: `feat/rls-t2-appointments`.

| Statement | Contexts | Entry/job origins | PENDING intended disposition |
|---|---|---|---|
| apps/backend/src/routes/fhir/fhirRoutes.js:927:24:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:921 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/abdm/abdmService.js:1718:34:$queryRawUnsafe | pre-global-tenant-route, tenant | residual:pre-global-tenant-route:apps/backend/src/routes/abdm/abdmRoutes.js:321 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/appointment/appointmentLifecycleService.js:236:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/appointment/appointmentLifecycleService.js:395:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/appointment/appointmentQueueService.js:196:9:$executeRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/appointment/appointmentReaperService.js:102:31:$queryRawUnsafe | bypass | entry:apps/backend/src/services/appointment/appointmentReaperService.js:55; job:reap-stale-visits | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/appointment/appointmentReaperService.js:66:30:$queryRawUnsafe | bypass | entry:apps/backend/src/services/appointment/appointmentReaperService.js:55; job:reap-stale-visits | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/appointment/appointmentService.js:178:19:$queryRaw | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/appointment/appointmentService.js:196:28:$queryRaw | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/appointment/opChildResourceEventService.js:123:22:$queryRawUnsafe | tenant | job:pathway-projector-shadow; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/appointment/opPathwayWorkService.js:154:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/appointment/opPathwayWorkService.js:303:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/dashboards/snapshotService.js:15:22:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1523; job:daily-ops-tick | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/doctor/adminDoctorService.js:27:9:$executeRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/doctor/adminDoctorService.js:356; residual:bare-transaction:apps/backend/src/services/doctor/adminDoctorService.js:444; residual:bare-transaction:apps/backend/src/services/doctor/adminDoctorService.js:521 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/doctor/adminDoctorService.js:30:10:$queryRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/doctor/adminDoctorService.js:356; residual:bare-transaction:apps/backend/src/services/doctor/adminDoctorService.js:444; residual:bare-transaction:apps/backend/src/services/doctor/adminDoctorService.js:521 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/doctor/adminDoctorService.js:372:17:$queryRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/doctor/adminDoctorService.js:356 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/doctor/adminDoctorService.js:487:43:$queryRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/doctor/adminDoctorService.js:444 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/doctor/adminDoctorService.js:572:19:$executeRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/doctor/adminDoctorService.js:521 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/doctor/adminDoctorService.js:580:19:$executeRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/doctor/adminDoctorService.js:521 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/emr/vitalsChartService.js:247:24:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/emr/vitalsChartService.js:262:35:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/health/healthRecordService.js:43:23:findFirst | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:38; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:43; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:48; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:53 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/lab/labCriticalThresholdService.js:205:24:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1150 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/pathways/carePathwayResourceReferenceService.js:467:22:$queryRawUnsafe | tenant | job:pathway-projector-shadow | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/pathways/opPathwayProjector.js:65:22:$queryRawUnsafe | tenant | job:pathway-projector-shadow | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/referral/referralRecoverySweepService.js:26:30:$queryRawUnsafe | tenant | job:referral-recovery-sweep | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/scheduling/schedulingOptimizationService.js:466:5:$queryRawUnsafe | bypass | job:waitlist-auto-fill | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/security/accessDecisionService.js:1231:22:$queryRawUnsafe | bypass, pre-global-tenant-route, startup, tenant | entry:apps/backend/src/utils/scheduler.js:1520; entry:apps/backend/src/utils/scheduler.js:1523; entry:apps/backend/src/utils/scheduler.js:1526; entry:apps/backend/src/utils/scheduler.js:1736; job:admin-kpi-tick; job:daily-ops-tick; job:fhir-vital-effects-recovery; job:results-inbox-escalation; job:teleconsult-ops-tick; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:pre-global-tenant-route:apps/backend/src/routes/coldChainRoutes.js:33; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:703; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:847; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95; startup:apps/backend/src/bin/www.js:118; startup:apps/backend/src/bin/www.js:287 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/security/accessDecisionService.js:1854:22:$queryRawUnsafe | bypass, pre-global-tenant-route, startup, tenant | entry:apps/backend/src/utils/scheduler.js:1520; entry:apps/backend/src/utils/scheduler.js:1523; entry:apps/backend/src/utils/scheduler.js:1526; entry:apps/backend/src/utils/scheduler.js:1736; job:admin-kpi-tick; job:daily-ops-tick; job:fhir-vital-effects-recovery; job:results-inbox-escalation; job:teleconsult-ops-tick; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:pre-global-tenant-route:apps/backend/src/routes/coldChainRoutes.js:33; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:703; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:847; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95; startup:apps/backend/src/bin/www.js:118; startup:apps/backend/src/bin/www.js:287 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/uhi/uhiAdapterService.js:234:22:$queryRawUnsafe | pre-global-tenant-route | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/uhi/uhiAdapterService.js:535:22:$queryRawUnsafe | pre-global-tenant-route | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/uhi/uhiAdapterService.js:619:24:$queryRawUnsafe | pre-global-tenant-route | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/utils/kpiAggregator.js:75:24:$queryRawUnsafe | tenant | entry:apps/backend/src/utils/scheduler.js:1520; job:admin-kpi-tick | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/notifications/appointmentReminderJob.js:105:10:$queryRawUnsafe | tenant | job:timed-reminders; residual:module-initializer:apps/backend/src/bin/www.js:372; residual:read-only-transaction:apps/backend/src/utils/notifications/appointmentReminderJob.js:159; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/notifications/appointmentReminderJob.js:44:33:$queryRawUnsafe | tenant | job:timed-reminders; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/notifications/appointmentReminderJob.js:68:32:$queryRawUnsafe | tenant | job:timed-reminders; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/notifications/stuckOrderEscalation.js:52:35:$queryRawUnsafe | tenant | job:escalate-stuck-orders | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/utils/schemaHealthCheck.js:62:7:count | module-initializer, startup | residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |

Administrative entries (46); each is **PENDING → proven-unreachable**, owned by `feat/rls-t2-appointments`. The shared statement catalog below resolves each ID to its source SQL; the JSON repeats each table-specific disposition explicitly.

- `apps/backend/src/migrations/000_baseline.sql:statement-148`
- `apps/backend/src/migrations/000_baseline.sql:statement-149`
- `apps/backend/src/migrations/000_baseline.sql:statement-153`
- `apps/backend/src/migrations/157_bi_dashboards.sql:statement-2`
- `apps/backend/src/migrations/157_bi_dashboards.sql:statement-4`
- `apps/backend/src/migrations/157_bi_dashboards.sql:statement-7`
- `apps/backend/src/migrations/220_appointments_uid_default.sql:statement-2`
- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-3`
- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-4`
- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-45`
- `apps/backend/src/migrations/237_force_rls_phi_tables.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-3`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-5`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-2`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-3`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-6`
- `apps/backend/src/migrations/261_backfill_appointment_queues.sql:statement-2`
- `apps/backend/src/migrations/261_backfill_appointment_queues.sql:statement-3`
- `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:statement-2`
- `apps/backend/src/migrations/295_analytics_publication.sql:statement-2`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-11`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-13`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-14`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:statement-3`
- `apps/backend/src/migrations/310_tenant_id_guc_default.sql:statement-2`
- `apps/backend/src/migrations/322_appointments_double_booking.sql:statement-2`
- `apps/backend/src/migrations/324_audit_chain_hardening.sql:statement-3`
- `apps/backend/src/migrations/329_doc_number_uniques_per_tenant.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-5`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-6`
- `apps/backend/src/migrations/331_patient_phi_top_level_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-3`
- `apps/backend/src/migrations/335_audit_activity_logs_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/581_lab_critical_alert_generations.sql:statement-99`
- `apps/backend/src/migrations/595_care_pathways_op_inpatient.sql:statement-21`
- `apps/backend/src/migrations/595_care_pathways_op_inpatient.sql:statement-46`
- `apps/backend/src/migrations/595_care_pathways_op_inpatient.sql:statement-58`
- `apps/backend/src/migrations/729_tenant_bearing_fks_and_tenant_default_alignment.sql:statement-2`
- `apps/backend/src/migrations/729_tenant_bearing_fks_and_tenant_default_alignment.sql:statement-3`
- `apps/backend/src/migrations/741_ward_indent_authoritative_state_machine.sql:statement-4`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-149`

## emergency_visits

**39 reachers = 0 dispositioned + 39 pending.** 47 source statement candidates reference this table before root tracing. Module PR: `feat/rls-t2-appointments`.

| Statement | Contexts | Entry/job origins | PENDING intended disposition |
|---|---|---|---|
| apps/backend/src/services/ed/edClosureRecoveryService.js:1221:22:$queryRawUnsafe | tenant | job:pathway-projector-shadow | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/emr/vitalsChartService.js:210:24:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/emr/vitalsChartService.js:225:24:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/pathways/emergencyPathwayProjector.js:50:22:$queryRawUnsafe | tenant | job:pathway-projector-shadow | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |

Administrative entries (35); each is **PENDING → proven-unreachable**, owned by `feat/rls-t2-appointments`. The shared statement catalog below resolves each ID to its source SQL; the JSON repeats each table-specific disposition explicitly.

- `apps/backend/src/migrations/224_emergency_icu_continuation.sql:statement-5`
- `apps/backend/src/migrations/233_ensure_ed_tables_exist.sql:statement-4`
- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-45`
- `apps/backend/src/migrations/237_force_rls_phi_tables.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-3`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-5`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-2`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-3`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-6`
- `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:statement-2`
- `apps/backend/src/migrations/295_analytics_publication.sql:statement-2`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-11`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-13`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-14`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:statement-3`
- `apps/backend/src/migrations/310_tenant_id_guc_default.sql:statement-2`
- `apps/backend/src/migrations/324_audit_chain_hardening.sql:statement-3`
- `apps/backend/src/migrations/329_doc_number_uniques_per_tenant.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-5`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-6`
- `apps/backend/src/migrations/331_patient_phi_top_level_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-3`
- `apps/backend/src/migrations/335_audit_activity_logs_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/596_care_pathways_ed_destination_handoff.sql:statement-13`
- `apps/backend/src/migrations/597_care_pathways_ed_closure_recovery.sql:statement-14`
- `apps/backend/src/migrations/597_care_pathways_ed_closure_recovery.sql:statement-18`
- `apps/backend/src/migrations/597_care_pathways_ed_closure_recovery.sql:statement-28`
- `apps/backend/src/migrations/600_clinical_continuity_pack_governance.sql:statement-9`
- `apps/backend/src/migrations/741_ward_indent_authoritative_state_machine.sql:statement-4`
- `apps/backend/src/migrations/745_clinical_alert_delivery_obligations.sql:statement-9`

## maternity_pregnancies

**30 reachers = 0 dispositioned + 30 pending.** 41 source statement candidates reference this table before root tracing. Module PR: `feat/rls-t2-appointments`.

| Statement | Contexts | Entry/job origins | PENDING intended disposition |
|---|---|---|---|
| apps/backend/src/utils/clinical/vitalSignMonitor.js:129:24:$queryRawUnsafe | tenant | job:fhir-vital-effects-recovery; residual:pre-global-tenant-route:apps/backend/src/routes/fhir/fhirRoutes.js:1224; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:76; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:94; residual:pre-global-tenant-route:apps/backend/src/routes/health/protectedRoutes.js:95 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |

Administrative entries (29); each is **PENDING → proven-unreachable**, owned by `feat/rls-t2-appointments`. The shared statement catalog below resolves each ID to its source SQL; the JSON repeats each table-specific disposition explicitly.

- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-45`
- `apps/backend/src/migrations/237_force_rls_phi_tables.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-3`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-5`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-2`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-3`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-6`
- `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:statement-2`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-11`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-13`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-14`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:statement-3`
- `apps/backend/src/migrations/310_tenant_id_guc_default.sql:statement-2`
- `apps/backend/src/migrations/324_audit_chain_hardening.sql:statement-3`
- `apps/backend/src/migrations/329_doc_number_uniques_per_tenant.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-5`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-6`
- `apps/backend/src/migrations/331_patient_phi_top_level_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-3`
- `apps/backend/src/migrations/335_audit_activity_logs_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/741_ward_indent_authoritative_state_machine.sql:statement-4`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-147`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-149`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-13`

## staff_performance_reviews

**26 reachers = 0 dispositioned + 26 pending.** 13 source statement candidates reference this table before root tracing. Module PR: `feat/rls-t2-staff-admin`.

| Statement | Contexts | Entry/job origins | PENDING intended disposition |
|---|---|---|---|
| none | no runtime root reached the table | all registered jobs and residual roots traced | administrative entries below remain PENDING |

Administrative entries (26); each is **PENDING → proven-unreachable**, owned by `feat/rls-t2-staff-admin`. The shared statement catalog below resolves each ID to its source SQL; the JSON repeats each table-specific disposition explicitly.

- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-45`
- `apps/backend/src/migrations/237_force_rls_phi_tables.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-3`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-5`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-2`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-3`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-6`
- `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:statement-2`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-11`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-13`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-14`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:statement-3`
- `apps/backend/src/migrations/310_tenant_id_guc_default.sql:statement-2`
- `apps/backend/src/migrations/324_audit_chain_hardening.sql:statement-3`
- `apps/backend/src/migrations/329_doc_number_uniques_per_tenant.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-5`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-6`
- `apps/backend/src/migrations/331_patient_phi_top_level_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-3`
- `apps/backend/src/migrations/335_audit_activity_logs_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/741_ward_indent_authoritative_state_machine.sql:statement-4`

## leave_applications

**29 reachers = 0 dispositioned + 29 pending.** 31 source statement candidates reference this table before root tracing. Module PR: `feat/rls-t2-staff-admin`.

| Statement | Contexts | Entry/job origins | PENDING intended disposition |
|---|---|---|---|
| apps/backend/src/services/staff/hr/leaveService.js:291:38:create | bare-transaction | residual:bare-transaction:apps/backend/src/services/staff/hr/leaveService.js:290 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/staff/payrollService.js:234:26:$queryRawUnsafe | tenant | job:monthly-payroll | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/staff/shiftSwapService.js:617:23:$queryRawUnsafe | bare-transaction | residual:bare-transaction:apps/backend/src/services/staff/shiftSwapService.js:671 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |

Administrative entries (26); each is **PENDING → proven-unreachable**, owned by `feat/rls-t2-staff-admin`. The shared statement catalog below resolves each ID to its source SQL; the JSON repeats each table-specific disposition explicitly.

- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-45`
- `apps/backend/src/migrations/237_force_rls_phi_tables.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-3`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-5`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-2`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-3`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-6`
- `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:statement-2`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-11`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-13`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-14`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:statement-3`
- `apps/backend/src/migrations/310_tenant_id_guc_default.sql:statement-2`
- `apps/backend/src/migrations/324_audit_chain_hardening.sql:statement-3`
- `apps/backend/src/migrations/329_doc_number_uniques_per_tenant.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-5`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-6`
- `apps/backend/src/migrations/331_patient_phi_top_level_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-3`
- `apps/backend/src/migrations/335_audit_activity_logs_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/741_ward_indent_authoritative_state_machine.sql:statement-4`

## staff_attendance

**27 reachers = 0 dispositioned + 27 pending.** 56 source statement candidates reference this table before root tracing. Module PR: `feat/rls-t2-staff-admin`.

| Statement | Contexts | Entry/job origins | PENDING intended disposition |
|---|---|---|---|
| apps/backend/src/services/staff/payrollService.js:215:24:$queryRawUnsafe | tenant | job:monthly-payroll | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |

Administrative entries (26); each is **PENDING → proven-unreachable**, owned by `feat/rls-t2-staff-admin`. The shared statement catalog below resolves each ID to its source SQL; the JSON repeats each table-specific disposition explicitly.

- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-45`
- `apps/backend/src/migrations/237_force_rls_phi_tables.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-3`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-5`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-2`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-3`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-6`
- `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:statement-2`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-11`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-13`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-14`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:statement-3`
- `apps/backend/src/migrations/310_tenant_id_guc_default.sql:statement-2`
- `apps/backend/src/migrations/324_audit_chain_hardening.sql:statement-3`
- `apps/backend/src/migrations/329_doc_number_uniques_per_tenant.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-5`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-6`
- `apps/backend/src/migrations/331_patient_phi_top_level_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-3`
- `apps/backend/src/migrations/335_audit_activity_logs_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/741_ward_indent_authoritative_state_machine.sql:statement-4`

## incident_reports

**26 reachers = 0 dispositioned + 26 pending.** 19 source statement candidates reference this table before root tracing. Module PR: `feat/rls-t2-staff-admin`.

| Statement | Contexts | Entry/job origins | PENDING intended disposition |
|---|---|---|---|
| none | no runtime root reached the table | all registered jobs and residual roots traced | administrative entries below remain PENDING |

Administrative entries (26); each is **PENDING → proven-unreachable**, owned by `feat/rls-t2-staff-admin`. The shared statement catalog below resolves each ID to its source SQL; the JSON repeats each table-specific disposition explicitly.

- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-45`
- `apps/backend/src/migrations/237_force_rls_phi_tables.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-3`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-5`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-2`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-3`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-6`
- `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:statement-2`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-11`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-13`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-14`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:statement-3`
- `apps/backend/src/migrations/310_tenant_id_guc_default.sql:statement-2`
- `apps/backend/src/migrations/324_audit_chain_hardening.sql:statement-3`
- `apps/backend/src/migrations/329_doc_number_uniques_per_tenant.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-5`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-6`
- `apps/backend/src/migrations/331_patient_phi_top_level_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-3`
- `apps/backend/src/migrations/335_audit_activity_logs_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/741_ward_indent_authoritative_state_machine.sql:statement-4`

## report_updates

**26 reachers = 0 dispositioned + 26 pending.** 17 source statement candidates reference this table before root tracing. Module PR: `feat/rls-t2-staff-admin`.

| Statement | Contexts | Entry/job origins | PENDING intended disposition |
|---|---|---|---|
| none | no runtime root reached the table | all registered jobs and residual roots traced | administrative entries below remain PENDING |

Administrative entries (26); each is **PENDING → proven-unreachable**, owned by `feat/rls-t2-staff-admin`. The shared statement catalog below resolves each ID to its source SQL; the JSON repeats each table-specific disposition explicitly.

- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-45`
- `apps/backend/src/migrations/237_force_rls_phi_tables.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-3`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-5`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-2`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-3`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-6`
- `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:statement-2`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-11`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-13`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-14`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:statement-3`
- `apps/backend/src/migrations/310_tenant_id_guc_default.sql:statement-2`
- `apps/backend/src/migrations/324_audit_chain_hardening.sql:statement-3`
- `apps/backend/src/migrations/329_doc_number_uniques_per_tenant.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-5`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-6`
- `apps/backend/src/migrations/331_patient_phi_top_level_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-3`
- `apps/backend/src/migrations/335_audit_activity_logs_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/741_ward_indent_authoritative_state_machine.sql:statement-4`

## staff_grievances

**26 reachers = 0 dispositioned + 26 pending.** 18 source statement candidates reference this table before root tracing. Module PR: `feat/rls-t2-staff-admin`.

| Statement | Contexts | Entry/job origins | PENDING intended disposition |
|---|---|---|---|
| none | no runtime root reached the table | all registered jobs and residual roots traced | administrative entries below remain PENDING |

Administrative entries (26); each is **PENDING → proven-unreachable**, owned by `feat/rls-t2-staff-admin`. The shared statement catalog below resolves each ID to its source SQL; the JSON repeats each table-specific disposition explicitly.

- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-45`
- `apps/backend/src/migrations/237_force_rls_phi_tables.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-3`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-5`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-2`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-3`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-6`
- `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:statement-2`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-11`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-13`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-14`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:statement-3`
- `apps/backend/src/migrations/310_tenant_id_guc_default.sql:statement-2`
- `apps/backend/src/migrations/324_audit_chain_hardening.sql:statement-3`
- `apps/backend/src/migrations/329_doc_number_uniques_per_tenant.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-5`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-6`
- `apps/backend/src/migrations/331_patient_phi_top_level_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-3`
- `apps/backend/src/migrations/335_audit_activity_logs_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/741_ward_indent_authoritative_state_machine.sql:statement-4`

## wards

**50 reachers = 0 dispositioned + 50 pending.** 42 source statement candidates reference this table before root tracing. Module PR: `feat/rls-t2-wards-consent-roster-rx`.

| Statement | Contexts | Entry/job origins | PENDING intended disposition |
|---|---|---|---|
| apps/backend/src/services/clinical/drugChartSlaService.js:137:10:$queryRawUnsafe | bypass, tenant | entry:apps/backend/src/utils/scheduler.js:1618; job:drug-chart-missing-sla; residual:module-initializer:apps/backend/src/bin/www.js:372; startup:apps/backend/src/bin/www.js:118 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/downtime/wardDowntimePackOutputProbe.js:131:18:$queryRawUnsafe | bypass | job:ward-downtime-pack-output-probe | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/downtime/wardDowntimePackOutputProbe.js:177:35:$queryRawUnsafe | bypass | job:ward-downtime-pack-output-probe | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/staff/housekeepingTaskDispatchService.js:107:22:$queryRawUnsafe | tenant | job:bed-cleaning-dispatch-sweep | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |

Administrative entries (46); each is **PENDING → proven-unreachable**, owned by `feat/rls-t2-wards-consent-roster-rx`. The shared statement catalog below resolves each ID to its source SQL; the JSON repeats each table-specific disposition explicitly.

- `apps/backend/src/migrations/191_seed_essentials.sql:statement-2`
- `apps/backend/src/migrations/191_seed_essentials.sql:statement-3`
- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-45`
- `apps/backend/src/migrations/237_force_rls_phi_tables.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-3`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-5`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-2`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-3`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-6`
- `apps/backend/src/migrations/252_seed_housekeeping_floor_zones.sql:statement-2`
- `apps/backend/src/migrations/255_seed_current_bed_structure.sql:statement-11`
- `apps/backend/src/migrations/255_seed_current_bed_structure.sql:statement-4`
- `apps/backend/src/migrations/255_seed_current_bed_structure.sql:statement-5`
- `apps/backend/src/migrations/255_seed_current_bed_structure.sql:statement-6`
- `apps/backend/src/migrations/255_seed_current_bed_structure.sql:statement-7`
- `apps/backend/src/migrations/257_seed_er_beds.sql:statement-2`
- `apps/backend/src/migrations/257_seed_er_beds.sql:statement-3`
- `apps/backend/src/migrations/258_seed_day_care_dialysis_beds.sql:statement-2`
- `apps/backend/src/migrations/258_seed_day_care_dialysis_beds.sql:statement-3`
- `apps/backend/src/migrations/258_seed_day_care_dialysis_beds.sql:statement-4`
- `apps/backend/src/migrations/259_normalize_day_care_bed_numbers.sql:statement-2`
- `apps/backend/src/migrations/259_normalize_day_care_bed_numbers.sql:statement-3`
- `apps/backend/src/migrations/259_normalize_day_care_bed_numbers.sql:statement-4`
- `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:statement-2`
- `apps/backend/src/migrations/295_analytics_publication.sql:statement-2`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-11`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-13`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-14`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:statement-3`
- `apps/backend/src/migrations/310_tenant_id_guc_default.sql:statement-2`
- `apps/backend/src/migrations/324_audit_chain_hardening.sql:statement-3`
- `apps/backend/src/migrations/329_doc_number_uniques_per_tenant.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-5`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-6`
- `apps/backend/src/migrations/331_patient_phi_top_level_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-3`
- `apps/backend/src/migrations/335_audit_activity_logs_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/600_clinical_continuity_pack_governance.sql:statement-9`
- `apps/backend/src/migrations/741_ward_indent_authoritative_state_machine.sql:statement-4`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-64`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-66`

## patient_data_rights_requests

**26 reachers = 0 dispositioned + 26 pending.** 4 source statement candidates reference this table before root tracing. Module PR: `feat/rls-t2-wards-consent-roster-rx`.

| Statement | Contexts | Entry/job origins | PENDING intended disposition |
|---|---|---|---|
| none | no runtime root reached the table | all registered jobs and residual roots traced | administrative entries below remain PENDING |

Administrative entries (26); each is **PENDING → proven-unreachable**, owned by `feat/rls-t2-wards-consent-roster-rx`. The shared statement catalog below resolves each ID to its source SQL; the JSON repeats each table-specific disposition explicitly.

- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-45`
- `apps/backend/src/migrations/237_force_rls_phi_tables.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-3`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-5`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-2`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-3`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-6`
- `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:statement-2`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-11`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-13`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-14`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:statement-3`
- `apps/backend/src/migrations/310_tenant_id_guc_default.sql:statement-2`
- `apps/backend/src/migrations/324_audit_chain_hardening.sql:statement-3`
- `apps/backend/src/migrations/329_doc_number_uniques_per_tenant.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-5`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-6`
- `apps/backend/src/migrations/331_patient_phi_top_level_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-3`
- `apps/backend/src/migrations/335_audit_activity_logs_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/741_ward_indent_authoritative_state_machine.sql:statement-4`

## e_prescriptions

**49 reachers = 0 dispositioned + 49 pending.** 78 source statement candidates reference this table before root tracing. Module PR: `feat/rls-t2-wards-consent-roster-rx`.

| Statement | Contexts | Entry/job origins | PENDING intended disposition |
|---|---|---|---|
| apps/backend/src/services/appointment/opChildResourceEventService.js:177:22:$queryRawUnsafe | tenant | job:pathway-projector-shadow; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/appointment/opChildResourceEventService.js:355:22:$queryRawUnsafe | tenant | residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:264; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:265; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:266; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:267; residual:pre-global-tenant-route:apps/backend/src/routes/uhi/uhiRoutes.js:268 | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/compliance/auditAccountabilityService.js:394:5:$queryRawUnsafe | read-only-client | residual:read-only-client:apps/backend/src/services/compliance/auditAccountabilityService.js:394 | converted; Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app. |
| apps/backend/src/services/emr/clinicalTimelineService.js:439:64:findMany | tenant | job:coding-suggestion-batch | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |
| apps/backend/src/services/pathways/carePathwayResourceReferenceService.js:467:22:$queryRawUnsafe | tenant | job:pathway-projector-shadow | proven-unreachable; The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app. |

Administrative entries (44); each is **PENDING → proven-unreachable**, owned by `feat/rls-t2-wards-consent-roster-rx`. The shared statement catalog below resolves each ID to its source SQL; the JSON repeats each table-specific disposition explicitly.

- `apps/backend/src/migrations/176_eprescriptions_uid_columns.sql:statement-3`
- `apps/backend/src/migrations/176_eprescriptions_uid_columns.sql:statement-4`
- `apps/backend/src/migrations/205_e_prescriptions_uid_backfill.sql:statement-1`
- `apps/backend/src/migrations/205_e_prescriptions_uid_backfill.sql:statement-2`
- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-27`
- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-28`
- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-29`
- `apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-45`
- `apps/backend/src/migrations/237_force_rls_phi_tables.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-2`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-3`
- `apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-5`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-2`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-3`
- `apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-6`
- `apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:statement-2`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-11`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-13`
- `apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-14`
- `apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:statement-3`
- `apps/backend/src/migrations/310_tenant_id_guc_default.sql:statement-2`
- `apps/backend/src/migrations/324_audit_chain_hardening.sql:statement-3`
- `apps/backend/src/migrations/326_perf_unique_indexes.sql:statement-6`
- `apps/backend/src/migrations/329_doc_number_uniques_per_tenant.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-5`
- `apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-6`
- `apps/backend/src/migrations/331_patient_phi_top_level_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-2`
- `apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-3`
- `apps/backend/src/migrations/335_audit_activity_logs_tenant_rls.sql:statement-3`
- `apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-2`
- `apps/backend/src/migrations/741_ward_indent_authoritative_state_machine.sql:statement-4`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-11`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-149`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-70`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-72`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-74`
- `apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-76`
- `apps/backend/src/migrations/755_clinical_import_receipt_and_history_immutability.sql:statement-14`
- `apps/backend/src/migrations/755_clinical_import_receipt_and_history_immutability.sql:statement-22`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-11`
- `apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-59`

## Administrative statement catalog

| Statement | Source line | Possible target tables | Catalog expansion | SQL preview (full SQL and hash in JSON) |
|---|---:|---|---|---|
| apps/backend/src/migrations/000_baseline.sql:statement-148 | 2063 | appointments | resolved references | -- -- Name: bi_daily_ops_snapshot; Type: VIEW; Schema: public; Owner: - --  CREATE VIEW public.bi_daily_ops_snapshot AS  SELECT CURRENT_DATE AS d,     ( SELECT (count(*))::integer  |
| apps/backend/src/migrations/000_baseline.sql:statement-149 | 2094 | appointments | resolved references | -- -- Name: bi_doctor_productivity_30d; Type: VIEW; Schema: public; Owner: - --  CREATE VIEW public.bi_doctor_productivity_30d AS  SELECT doctor_id,     doctor_name,     (count(*)) |
| apps/backend/src/migrations/000_baseline.sql:statement-153 | 2182 | appointments | resolved references | -- -- Name: bi_opd_daily; Type: VIEW; Schema: public; Owner: - --  CREATE VIEW public.bi_opd_daily AS  SELECT appointment_date AS d,     doctor_id,     doctor_name,     (count(*)): |
| apps/backend/src/migrations/009_future_proof_clinical_ai.sql:statement-23 | 246 | investigations | resolved references | UPDATE investigations SET patient_uid = uid WHERE patient_uid IS NULL AND uid IS NOT NULL |
| apps/backend/src/migrations/013_multi_tenant_foundation.sql:statement-4 | 44 | users | resolved references | UPDATE users SET tenant_id = '00000000-0000-4000-8000-000000000001' WHERE tenant_id IS NULL |
| apps/backend/src/migrations/075_tenant_rls_policies.sql:statement-2 | 34 | users | resolved references | DO $$ DECLARE   t text;   tables text[] := ARRAY[     'users',     'clinical_ai_tenant_modules',     'clinical_ai_generations',     'clinical_ai_prompts',     'clinical_ai_reviews' |
| apps/backend/src/migrations/077_fix_dev_schema_drift.sql:statement-3 | 43 | staff | resolved references | -- Backfill shift_type from the legacy `shift` column so existing rows answer -- both query shapes while code converges. UPDATE staff SET shift_type = shift WHERE shift_type IS NUL |
| apps/backend/src/migrations/082_investigations_fk_constraints.sql:statement-1 | 1 | users | resolved references | -- 082_investigations_fk_constraints.sql -- -- Adds FK constraints on investigations so Prisma introspection (`db pull`) -- produces declared relations — which in turn lets us migr |
| apps/backend/src/migrations/157_bi_dashboards.sql:statement-2 | 23 | appointments | resolved references | -- ── 1. Daily OPD volume ───────────────────────────────────────────── CREATE OR REPLACE VIEW bi_opd_daily AS SELECT   appointment_date AS d,   doctor_id, doctor_name,   COUNT(*): |
| apps/backend/src/migrations/157_bi_dashboards.sql:statement-4 | 56 | appointments | resolved references | -- ── 3. Doctor productivity (rolling 30 days) ─────────────────────── CREATE OR REPLACE VIEW bi_doctor_productivity_30d AS SELECT   doctor_id, doctor_name,   COUNT(*)::int AS opd_ |
| apps/backend/src/migrations/157_bi_dashboards.sql:statement-7 | 104 | appointments | resolved references | -- ── 6. Daily ops snapshot ────────────────────────────────────────── -- The "morning huddle" view — one row per day with the headline -- numbers everyone wants at 8 am. CREATE OR |
| apps/backend/src/migrations/176_eprescriptions_uid_columns.sql:statement-3 | 26 | e_prescriptions, users | resolved references | -- Backfill from int FKs. Safe to run repeatedly: the WHERE clause -- only updates rows where the uid column is still null. UPDATE e_prescriptions ep    SET patient_uid = u.uid   F |
| apps/backend/src/migrations/176_eprescriptions_uid_columns.sql:statement-4 | 34 | e_prescriptions, users | resolved references | UPDATE e_prescriptions ep    SET doctor_uid = u.uid   FROM users u  WHERE ep.doctor_uid IS NULL    AND u.id = ep.doctor_id |
| apps/backend/src/migrations/189_paediatric_subsystem_polish.sql:statement-4 | 35 | doctors | resolved references | -- Backfill: doctors flagged as paediatricians by specialty get -- 'paediatric'. Everyone else stays 'all' (the conservative default). UPDATE doctors    SET age_range = 'paediatric |
| apps/backend/src/migrations/191_seed_essentials.sql:statement-2 | 13 | wards | resolved references | -- ── 1. ICU + CCU + semi-private + private + deluxe wards + beds ───── INSERT INTO wards (name, floor, total_beds, attendant_pass_color, attendant_pass_screening_level) SELECT v.n |
| apps/backend/src/migrations/191_seed_essentials.sql:statement-3 | 26 | wards | resolved references | -- ── 2. Beds for each newly-seeded ward ────────────────────────────── DO $$ DECLARE   ward_rec RECORD;   bed_count INTEGER;   i INTEGER;   prefix TEXT;   bed_type_val TEXT; BEGIN |
| apps/backend/src/migrations/202_walkin_demographics_guardian_minor.sql:statement-4 | 75 | users | resolved references | -- Backfill: anyone with a birthday < 18 years before today gets flagged -- as a minor. Cheap to compute once; the walk-in path keeps it in sync -- on insert / on birthday update.  |
| apps/backend/src/migrations/205_e_prescriptions_uid_backfill.sql:statement-1 | 1 | e_prescriptions, users | resolved references | -- Backfill patient_uid / doctor_uid on e_prescriptions rows created -- before commit 04dadb6f added the write-side resolution. Every -- prescription where the uuid columns are NUL |
| apps/backend/src/migrations/205_e_prescriptions_uid_backfill.sql:statement-2 | 16 | e_prescriptions, users | resolved references | UPDATE e_prescriptions p    SET doctor_uid = u.uid   FROM users u  WHERE p.doctor_uid IS NULL    AND p.doctor_id IS NOT NULL    AND u.id = p.doctor_id |
| apps/backend/src/migrations/220_appointments_uid_default.sql:statement-2 | 19 | appointments | resolved references | UPDATE public.appointments    SET uid = gen_random_uuid()  WHERE uid IS NULL |
| apps/backend/src/migrations/224_emergency_icu_continuation.sql:statement-5 | 45 | emergency_visits | resolved references | -- Backfill every existing row so the column can go NOT NULL. UPDATE emergency_visits    SET encounter_id = gen_random_uuid()  WHERE encounter_id IS NULL |
| apps/backend/src/migrations/233_doctor_profile_user_role_repair.sql:statement-2 | 13 | doctors, users | resolved references | UPDATE users u        SET role = 'DOCTOR',            name = COALESCE(NULLIF(u.name, ''), d.name),            is_active = true,            status = 'active',            updated_at  |
| apps/backend/src/migrations/233_ensure_ed_tables_exist.sql:statement-4 | 57 | emergency_visits | resolved references | UPDATE emergency_visits    SET encounter_id = gen_random_uuid()  WHERE encounter_id IS NULL |
| apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-15 | 100 | users | resolved references | UPDATE clinical_notes c    SET tenant_id = COALESCE(u.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)   FROM users u  WHERE c.tenant_id IS NULL    AND u.uid = c.patient_ui |
| apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-21 | 123 | users | resolved references | UPDATE prescriptions p    SET tenant_id = COALESCE(u.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)   FROM users u  WHERE p.tenant_id IS NULL    AND u.uid = p.patient_uid |
| apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-27 | 146 | e_prescriptions, users | resolved references | UPDATE e_prescriptions e    SET tenant_id = COALESCE(u.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)   FROM users u  WHERE e.tenant_id IS NULL    AND e.patient_uid IS NO |
| apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-28 | 152 | e_prescriptions, users | resolved references | UPDATE e_prescriptions e    SET tenant_id = COALESCE(u.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)   FROM users u  WHERE e.tenant_id IS NULL    AND u.id = e.patient_id |
| apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-29 | 157 | e_prescriptions | resolved references | UPDATE e_prescriptions    SET tenant_id = '00000000-0000-4000-8000-000000000001'::uuid  WHERE tenant_id IS NULL |
| apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-3 | 54 | appointments, users | resolved references | UPDATE appointments a    SET tenant_id = COALESCE(u.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)   FROM users u  WHERE a.tenant_id IS NULL    AND u.id = a.patient_id |
| apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-34 | 175 | investigations, users | resolved references | UPDATE investigations i    SET tenant_id = COALESCE(u.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)   FROM users u  WHERE i.tenant_id IS NULL    AND u.id = i.patient_id |
| apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-35 | 180 | investigations | resolved references | UPDATE investigations    SET tenant_id = '00000000-0000-4000-8000-000000000001'::uuid  WHERE tenant_id IS NULL |
| apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-4 | 59 | appointments | resolved references | UPDATE appointments    SET tenant_id = '00000000-0000-4000-8000-000000000001'::uuid  WHERE tenant_id IS NULL |
| apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-40 | 198 | users | resolved references | UPDATE vitals_chart v    SET tenant_id = COALESCE(u.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)   FROM users u  WHERE v.tenant_id IS NULL    AND u.uid = v.patient_uid |
| apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-45 | 218 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | -- --------------------------------------------------------------------------- -- 2. ENABLE RLS + tenant_isolation policy on the eight Phase-1 PHI tables. --    Reuses the app_curr |
| apps/backend/src/migrations/236_tenant_rls_phi_phase_1.sql:statement-9 | 77 | users | resolved references | UPDATE admissions a    SET tenant_id = COALESCE(u.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)   FROM users u  WHERE a.tenant_id IS NULL    AND u.uid = a.patient_uid |
| apps/backend/src/migrations/237_force_rls_phi_tables.sql:statement-2 | 26 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | DO $$ DECLARE   t text;   phi_tables text[] := ARRAY[     'appointments',     'admissions',     'clinical_notes',     'prescriptions',     'e_prescriptions',     'investigations',  |
| apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-2 | 31 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | -- --------------------------------------------------------------------------- -- Helper: bulk-apply tenant_id column + FK + index for a given linkage. -- ------------------------- |
| apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-3 | 82 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | -- patient_id → users.id set DO $$ DECLARE   t text;   -- medical_records.patient_id is actually a UUID column despite the   -- name; it FKs to users.uid, not users.id. Handled sep |
| apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-4 | 130 | users | resolved references | -- medical_records: patient_id is UUID → users.uid (legacy naming). DO $$ BEGIN   IF EXISTS (     SELECT 1 FROM information_schema.tables      WHERE table_schema = 'public' AND tab |
| apps/backend/src/migrations/238_tenant_rls_phi_phase_2b.sql:statement-5 | 158 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | -- --------------------------------------------------------------------------- -- ENABLE RLS + FORCE + tenant_isolation policy on all 13 Phase-2b tables. -- Reuses app_current_tena |
| apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-2 | 48 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | -- --------------------------------------------------------------------------- -- Group 1: patient_uid → users.uid (23 tables) -- -------------------------------------------------- |
| apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-3 | 103 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | -- --------------------------------------------------------------------------- -- Group 2: patient_id → users.id (2 tables) -- ----------------------------------------------------- |
| apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-4 | 151 | users | resolved references | -- --------------------------------------------------------------------------- -- Group 3: beds — both patient_uid (uuid) AND patient_id (int). -- patient_uid is the canonical FK ( |
| apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-5 | 190 | users | resolved references | -- --------------------------------------------------------------------------- -- Group 4: hipaa_access_log — the access audit log itself. -- Tenant-scope to the subject_uid (the p |
| apps/backend/src/migrations/239_tenant_rls_phi_phase_2c.sql:statement-6 | 232 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | -- --------------------------------------------------------------------------- -- ENABLE RLS + FORCE + tenant_isolation policy on all 27 Phase-2c tables. -- Reuses app_current_tena |
| apps/backend/src/migrations/252_seed_housekeeping_floor_zones.sql:statement-2 | 9 | housekeeping_zones, wards | resolved references | INSERT INTO housekeeping_zones (name, zone_type, floor, building, is_active) SELECT src.name,        'floor',        src.floor,        src.building,        true   FROM (     SELECT |
| apps/backend/src/migrations/255_seed_current_bed_structure.sql:statement-11 | 204 | wards | resolved references | DELETE FROM wards w  WHERE LOWER(w.name) = ANY(ARRAY[    'general ward', 'icu', 'ccu', 'semi-private', 'private', 'deluxe', 'day care'  ])    AND NOT EXISTS (SELECT 1 FROM beds b W |
| apps/backend/src/migrations/255_seed_current_bed_structure.sql:statement-4 | 96 | wards | resolved references | WITH seed_wards AS (   SELECT ward_name, floor, COUNT(*)::int AS total_beds     FROM vh_current_bed_seed    GROUP BY ward_name, floor ) UPDATE wards w    SET floor = sw.floor,      |
| apps/backend/src/migrations/255_seed_current_bed_structure.sql:statement-5 | 112 | wards | resolved references | WITH seed_wards AS (   SELECT ward_name, floor, COUNT(*)::int AS total_beds     FROM vh_current_bed_seed    GROUP BY ward_name, floor ) INSERT INTO wards   (name, floor, total_beds |
| apps/backend/src/migrations/255_seed_current_bed_structure.sql:statement-6 | 131 | wards | resolved references | UPDATE beds b    SET ward_id = w.id,        ward_name = s.ward_name,        floor = s.floor,        bed_type = s.bed_type,        notes = CASE          WHEN b.patient_id IS NULL AN |
| apps/backend/src/migrations/255_seed_current_bed_structure.sql:statement-7 | 150 | wards | resolved references | INSERT INTO beds   (ward_id, ward_name, bed_number, status, bed_type, floor, notes, tenant_id, created_at, updated_at) SELECT w.id,        s.ward_name,        s.bed_number,         |
| apps/backend/src/migrations/255_seed_current_bed_structure.sql:statement-8 | 169 | housekeeping_zones | resolved references | INSERT INTO housekeeping_zones   (name, zone_type, floor, building, is_active, created_at, updated_at) SELECT DISTINCT s.ward_name, 'floor', s.floor::text, s.building, TRUE, NOW(), |
| apps/backend/src/migrations/255_seed_current_bed_structure.sql:statement-9 | 180 | housekeeping_zones | resolved references | UPDATE housekeeping_zones hz    SET floor = s.floor::text,        building = s.building,        is_active = TRUE,        updated_at = NOW()   FROM (     SELECT DISTINCT ward_name,  |
| apps/backend/src/migrations/257_seed_er_beds.sql:statement-2 | 8 | wards | resolved references | WITH er_ward AS (   INSERT INTO wards     (name, floor, total_beds, attendant_pass_color, attendant_pass_screening_level, created_at, updated_at)   SELECT 'ER', 0, 10, 'orange', 's |
| apps/backend/src/migrations/257_seed_er_beds.sql:statement-3 | 60 | wards | resolved references | WITH target_ward AS (   SELECT id FROM wards WHERE LOWER(name) = 'er' LIMIT 1 ), seed_beds AS (   SELECT 'ER-' \|\| n::text AS bed_number   FROM generate_series(1, 10) AS n ) INSERT  |
| apps/backend/src/migrations/257_seed_er_beds.sql:statement-4 | 85 | housekeeping_zones | resolved references | INSERT INTO housekeeping_zones   (name, zone_type, floor, building, is_active, created_at, updated_at) SELECT 'ER', 'floor', '0', 'Emergency', TRUE, NOW(), NOW() WHERE NOT EXISTS ( |
| apps/backend/src/migrations/257_seed_er_beds.sql:statement-5 | 95 | housekeeping_zones | resolved references | UPDATE housekeeping_zones    SET floor = '0',        building = 'Emergency',        is_active = TRUE,        updated_at = NOW()  WHERE LOWER(name) = 'er'    AND LOWER(zone_type) =  |
| apps/backend/src/migrations/258_seed_day_care_dialysis_beds.sql:statement-2 | 8 | wards | resolved references | WITH requested_wards AS (   SELECT *   FROM (VALUES     ('Day Care'::text, 0::int, 10::int, 'Day Care'::text, 'day_care'::text, 'Day Care Bed'::text, 'DC'::text),     ('Dialysis':: |
| apps/backend/src/migrations/258_seed_day_care_dialysis_beds.sql:statement-3 | 34 | wards | resolved references | WITH requested_wards AS (   SELECT *   FROM (VALUES     ('Day Care'::text, 0::int, 10::int, 'Day Care'::text, 'day_care'::text, 'Day Care Bed'::text, 'DC'::text),     ('Dialysis':: |
| apps/backend/src/migrations/258_seed_day_care_dialysis_beds.sql:statement-4 | 73 | wards | resolved references | WITH requested_wards AS (   SELECT *   FROM (VALUES     ('Day Care'::text, 0::int, 10::int, 'Day Care'::text, 'day_care'::text, 'Day Care Bed'::text, 'DC'::text),     ('Dialysis':: |
| apps/backend/src/migrations/258_seed_day_care_dialysis_beds.sql:statement-5 | 114 | housekeeping_zones | resolved references | WITH requested_wards AS (   SELECT *   FROM (VALUES     ('Day Care'::text, 0::text, 'Day Care'::text),     ('Dialysis'::text, 0::text, 'Dialysis Unit'::text)   ) AS rw(name, floor, |
| apps/backend/src/migrations/258_seed_day_care_dialysis_beds.sql:statement-6 | 132 | housekeeping_zones | resolved references | WITH requested_wards AS (   SELECT *   FROM (VALUES     ('Day Care'::text, 0::text, 'Day Care'::text),     ('Dialysis'::text, 0::text, 'Dialysis Unit'::text)   ) AS rw(name, floor, |
| apps/backend/src/migrations/259_normalize_day_care_bed_numbers.sql:statement-2 | 9 | wards | resolved references | WITH day_care_ward AS (   SELECT id FROM wards WHERE LOWER(name) = 'day care' LIMIT 1 ), renamed AS (   UPDATE beds b      SET bed_number = regexp_replace(b.bed_number, '^DC-0+([1- |
| apps/backend/src/migrations/259_normalize_day_care_bed_numbers.sql:statement-3 | 43 | wards | resolved references | UPDATE wards    SET floor = 0,        total_beds = 10,        attendant_pass_screening_level = COALESCE(attendant_pass_screening_level, 'standard'),        updated_at = NOW()  WHER |
| apps/backend/src/migrations/259_normalize_day_care_bed_numbers.sql:statement-4 | 50 | wards | resolved references | WITH target_ward AS (   SELECT id FROM wards WHERE LOWER(name) = 'day care' LIMIT 1 ), seed_beds AS (   SELECT 'DC-' \|\| n::text AS bed_number     FROM generate_series(1, 10) AS n ) |
| apps/backend/src/migrations/261_backfill_appointment_queues.sql:statement-2 | 10 | appointment_queues, appointments, doctors, users | resolved references | WITH appointment_context AS (   SELECT DISTINCT     a.tenant_id,     a.appointment_date::date AS queue_date,     CASE       WHEN UPPER(COALESCE(a.visit_type, '')) = 'EMERGENCY'     |
| apps/backend/src/migrations/261_backfill_appointment_queues.sql:statement-3 | 107 | appointment_queues, appointments, doctors | resolved references | WITH appointment_context AS (   SELECT     a.id AS appointment_id,     a.tenant_id,     a.appointment_date::date AS queue_date,     CASE       WHEN UPPER(COALESCE(a.visit_type, '') |
| apps/backend/src/migrations/261_backfill_appointment_queues.sql:statement-4 | 154 | appointment_queues | resolved references | INSERT INTO appointment_queue_status_history (   tenant_id, appointment_queue_id, from_status, to_status,   reason, metadata, created_at, updated_at ) SELECT   q.tenant_id,   q.id, |
| apps/backend/src/migrations/272_force_rls_remaining_tenant_tables.sql:statement-2 | 34 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | DO $$ DECLARE   r RECORD;   forced int := 0; BEGIN   FOR r IN     SELECT p.schemaname, p.tablename       FROM pg_policies p       JOIN pg_class c      ON c.relname = p.tablename    |
| apps/backend/src/migrations/295_analytics_publication.sql:statement-2 | 39 | appointments, doctors, emergency_visits, investigations, users, wards | resolved references | DO $$ DECLARE   t text;   pub_tables text[] := ARRAY[     'admissions', 'appointments', 'emergency_visits', 'icu_admissions',     'ot_schedules', 'bed_transfers', 'beds', 'wards',  |
| apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-11 | 117 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | CREATE OR REPLACE FUNCTION public._vh_archive_schema_drift_column(   p_table text,   p_column text,   p_reason text ) RETURNS integer LANGUAGE plpgsql AS $$ DECLARE   v_inserted in |
| apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-13 | 209 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | CREATE OR REPLACE FUNCTION public._vh_drop_schema_drift_column(   p_table text,   p_column text ) RETURNS void LANGUAGE plpgsql AS $$ BEGIN   IF EXISTS (     SELECT 1       FROM in |
| apps/backend/src/migrations/299_live_schema_drift_archive.sql:statement-14 | 229 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | CREATE OR REPLACE FUNCTION public._vh_drop_empty_schema_drift_column(   p_table text,   p_column text ) RETURNS void LANGUAGE plpgsql AS $$ DECLARE   v_count integer := 0; BEGIN    |
| apps/backend/src/migrations/304_tenant_rls_policy_coverage.sql:statement-3 | 109 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | -- --------------------------------------------------------------------------- -- ENABLE + FORCE RLS, install tenant_isolation policy (if absent), and create -- a tenant_id index ( |
| apps/backend/src/migrations/310_tenant_id_guc_default.sql:statement-2 | 74 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | -- --------------------------------------------------------------------------- -- Rewrite the DEFAULT on tenant_id for every policied base table so the -- default reads the request |
| apps/backend/src/migrations/322_appointments_double_booking.sql:statement-2 | 79 | appointments | resolved references | -- Pre-flight: refuse to apply if existing ACTIVE rows already collide under the -- exact predicate the unique index will use, so the index build never fails with -- an unactionabl |
| apps/backend/src/migrations/324_audit_chain_hardening.sql:statement-3 | 75 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | -- Attach the guard to each audit table that exists. One BEFORE UPDATE OR DELETE -- trigger per table; INSERT is never touched, so the append path is unaffected. DO $$ DECLARE   t  |
| apps/backend/src/migrations/326_perf_unique_indexes.sql:statement-6 | 79 | e_prescriptions | resolved references | -- --------------------------------------------------------------------------- -- (2a) e_prescriptions.prescription_number — tenant-scoped partial unique. -- ---------------------- |
| apps/backend/src/migrations/329_doc_number_uniques_per_tenant.sql:statement-2 | 48 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | DO $$ DECLARE   rec       RECORD;   new_name  text;   actual_is_constraint boolean;   clash_tenant text;   clash_value text;   clash_count bigint;   collision_rows bigint; BEGIN    |
| apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-2 | 45 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | -- --------------------------------------------------------------------------- -- Step 1: add tenant_id to all 14 tables (idempotent). -- ------------------------------------------ |
| apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-5 | 79 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | -- --------------------------------------------------------------------------- -- Step 3: coerce every remaining NULL (the 12 staff tables + any billing -- orphan) to the default t |
| apps/backend/src/migrations/330_payroll_salary_tenant_rls.sql:statement-6 | 118 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | -- --------------------------------------------------------------------------- -- Step 4: ENABLE + FORCE RLS + canonical tenant_isolation policy on all 14. -- --------------------- |
| apps/backend/src/migrations/331_patient_phi_top_level_tenant_rls.sql:statement-2 | 25 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | DO $$ DECLARE   t text;   tbls text[] := ARRAY['consultations','health_records','sos_alerts'];   default_expr text := $def$COALESCE(NULLIF(NULLIF(current_setting('app.current_tenan |
| apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-2 | 30 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | -- --------------------------------------------------------------------------- -- Pattern A on the 4 directory tables (default-tenant backfill). -- -------------------------------- |
| apps/backend/src/migrations/332_clinical_directory_tenant_rls.sql:statement-3 | 84 | staff | resolved references | -- --------------------------------------------------------------------------- -- staff.employee_id — add the per-tenant uniqueness contract (new). -- ----------------------------- |
| apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-2 | 47 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | -- --------------------------------------------------------------------------- -- Part 1: Pattern A on the 5 phone/user-keyed auth tables. -- -------------------------------------- |
| apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-3 | 98 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | -- ENABLE + FORCE RLS + tenant_isolation policy. Kept as a FOREACH-over-ARRAY -- loop (NOT folded into the VALUES loop above) so the static -- check-phi-tenant-id guard — which har |
| apps/backend/src/migrations/333_per_tenant_patient_identity.sql:statement-6 | 143 | users | resolved references | -- firebase_uid: add the per-tenant identity unique (new; partial — exempts -- the NULLs of users who never linked a Firebase account). DO $$ DECLARE clash RECORD; BEGIN   SELECT t |
| apps/backend/src/migrations/335_audit_activity_logs_tenant_rls.sql:statement-3 | 38 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | DO $$ DECLARE   t text;   tbls text[] := ARRAY[     'admin_activity_logs','audit_log','audit_logs','file_access_logs','file_metadata',     'hr_activity_logs','medical_activity_logs |
| apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-2 | 57 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | DO $$ DECLARE   t text;   tbls text[] := ARRAY[     'annual_review_reminders', 'anomalies', 'api_access_logs', 'appointment_status_history',     'attendance_disputes', 'attendance_ |
| apps/backend/src/migrations/336_medium_tail_tenant_rls.sql:statement-3 | 130 | housekeeping_logs, housekeeping_requests | resolved references | -- --------------------------------------------------------------------------- -- Pattern B — tenant-scope the genuinely-global uniques on these tables. -- ------------------------ |
| apps/backend/src/migrations/377_radiology_tat_metrics.sql:statement-9 | 106 | users | resolved references | CREATE OR REPLACE VIEW radiology_tat_metrics AS SELECT   ro.tenant_id,   ro.id AS radiology_order_id,   ro.patient_uid,   u.id AS patient_id,   ro.modality,   ro.body_part,   COALE |
| apps/backend/src/migrations/580_care_pathway_execution_spine.sql:statement-104 | 3866 | users | resolved references | CREATE OR REPLACE FUNCTION care_pathway_assert_governance_actors(   target_tenant_id UUID,   target_governance_id UUID ) RETURNS void LANGUAGE plpgsql AS $$ DECLARE   governance_re |
| apps/backend/src/migrations/580_care_pathway_execution_spine.sql:statement-109 | 3999 | users | resolved references | CREATE OR REPLACE FUNCTION care_pathway_assert_governance_approval(   target_tenant_id UUID,   target_governance_id UUID ) RETURNS void LANGUAGE plpgsql AS $$ DECLARE   governance_ |
| apps/backend/src/migrations/580_care_pathway_execution_spine.sql:statement-148 | 4702 | users | resolved references | -- A terminal typed task is not itself proof that its clinical obligation was -- satisfied. Validate the durable receipt that stopped the linked clock. This -- second deferred inva |
| apps/backend/src/migrations/580_care_pathway_execution_spine.sql:statement-149 | 5370 | users | resolved references | -- A draining mortuary replica completes the typed task through the generic -- task transition after it records the release event. Promote that legacy SLA -- write to the canonical |
| apps/backend/src/migrations/580_care_pathway_execution_spine.sql:statement-152 | 5512 | investigations, users | resolved references | -- Old critical-result and mortuary producers can commit a newly started SLA -- before their separate task transaction. During the two-release drain, -- materialize those marker-fr |
| apps/backend/src/migrations/580_care_pathway_execution_spine.sql:statement-155 | 5870 | users | resolved references | CREATE OR REPLACE FUNCTION care_pathway_assert_human_sla_task_obligation(   target_tenant_id UUID,   target_sla_id UUID ) RETURNS void LANGUAGE plpgsql AS $$ DECLARE   sla_record w |
| apps/backend/src/migrations/580_care_pathway_execution_spine.sql:statement-29 | 1256 | users | resolved references | -- PR #607 shipped authenticated acknowledgement receipts before this typed -- contract. Those rows carry the actor on both the task and the SLA, but the -- SLA uses the legacy key |
| apps/backend/src/migrations/580_care_pathway_execution_spine.sql:statement-42 | 2317 | users | resolved references | -- During the two-release window a PR #607 replica still writes an authorized -- task receipt first, then completes the SLA with legacy `acknowledged_by` and -- an independent Post |
| apps/backend/src/migrations/580_care_pathway_execution_spine.sql:statement-45 | 2516 | investigations, users | resolved references | CREATE OR REPLACE FUNCTION workflow_sla_materialize_legacy_critical_rearm_task() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE   old_history JSONB;   new_history JSONB;   newly_pe |
| apps/backend/src/migrations/580_care_pathway_execution_spine.sql:statement-5 | 158 | users | resolved references | DO $care_pathway_human_sla_task_preflight$ DECLARE   inconsistent_obligation_count INTEGER; BEGIN   WITH known_human_slas AS (     SELECT sla.*,            CASE              WHEN s |
| apps/backend/src/migrations/581_lab_critical_alert_generations.sql:statement-99 | 2727 | appointments | resolved references | CREATE OR REPLACE VIEW bi_daily_ops_snapshot AS SELECT   CURRENT_DATE AS d,   (SELECT COUNT(*)::int FROM appointments     WHERE appointment_date = CURRENT_DATE) AS opd_today,   (SE |
| apps/backend/src/migrations/583_lab_astm_atomic_replay.sql:statement-20 | 970 | investigation_bookings, investigations, users | resolved references | -- Adopt a legacy ingested receipt only when the old rows themselves prove one -- exact ordered result set. The window must not overlap another receipt on the -- same analyzer/spec |
| apps/backend/src/migrations/583_lab_astm_atomic_replay.sql:statement-33 | 2234 | investigation_bookings, investigations, users | resolved references | CREATE OR REPLACE FUNCTION lab_interface_assert_astm_current_authorization(   target_tenant_id UUID,   target_message_id INTEGER ) RETURNS VOID LANGUAGE plpgsql SET search_path = p |
| apps/backend/src/migrations/583_lab_astm_atomic_replay.sql:statement-34 | 2582 | investigation_bookings, investigations, users | resolved references | CREATE OR REPLACE FUNCTION lab_interface_assert_astm_ingested_complete(   target_tenant_id UUID,   target_message_id INTEGER ) RETURNS VOID LANGUAGE plpgsql SET search_path = publi |
| apps/backend/src/migrations/584_care_pathway_governance_pinning.sql:statement-29 | 486 | users | resolved references | CREATE OR REPLACE FUNCTION care_pathway_lock_governance_users(   target_tenant_id UUID,   target_user_uids UUID[] ) RETURNS void LANGUAGE plpgsql AS $$ BEGIN   PERFORM actor.uid    |
| apps/backend/src/migrations/584_care_pathway_governance_pinning.sql:statement-38 | 764 | users | resolved references | -- Publication captures approver and voter eligibility at the decision point. -- After publication, the immutable receipt remains valid even if those people -- later change roles o |
| apps/backend/src/migrations/584_care_pathway_governance_pinning.sql:statement-41 | 1015 | users | resolved references | CREATE OR REPLACE FUNCTION care_pathway_assert_governance_publication_approval(   target_tenant_id UUID,   target_governance_id UUID ) RETURNS void LANGUAGE plpgsql AS $$ DECLARE   |
| apps/backend/src/migrations/584_care_pathway_governance_pinning.sql:statement-48 | 1288 | users | resolved references | CREATE OR REPLACE FUNCTION care_pathway_assert_retirement_actor(   target_tenant_id UUID,   target_governance_id UUID ) RETURNS void LANGUAGE plpgsql AS $$ DECLARE   retirement_act |
| apps/backend/src/migrations/585_care_pathway_exclusive_owner_integrity.sql:statement-13 | 252 | users | resolved references | CREATE OR REPLACE FUNCTION care_pathway_named_owner_is_viable(   target_tenant_id UUID,   target_owner_uid UUID,   obligation_rule_code TEXT ) RETURNS BOOLEAN LANGUAGE sql STABLE A |
| apps/backend/src/migrations/585_care_pathway_exclusive_owner_integrity.sql:statement-14 | 279 | users | resolved references | CREATE OR REPLACE FUNCTION care_pathway_named_clinician_is_viable(   target_tenant_id UUID,   target_owner_uid UUID ) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$   SELECT target_tena |
| apps/backend/src/migrations/585_care_pathway_exclusive_owner_integrity.sql:statement-17 | 378 | users | resolved references | CREATE OR REPLACE FUNCTION care_pathway_assert_live_instance_owner(   target_tenant_id UUID,   target_pathway_instance_id UUID ) RETURNS void LANGUAGE plpgsql AS $$ DECLARE   pathw |
| apps/backend/src/migrations/585_care_pathway_exclusive_owner_integrity.sql:statement-18 | 441 | users | resolved references | CREATE OR REPLACE FUNCTION care_pathway_assert_actionable_task_owner(   target_tenant_id UUID,   target_task_id INTEGER ) RETURNS void LANGUAGE plpgsql AS $$ DECLARE   obligation R |
| apps/backend/src/migrations/585_care_pathway_exclusive_owner_integrity.sql:statement-19 | 621 | users | resolved references | -- Migration 580's deferred receipt triggers remain installed and call this -- assertion at commit. Specialize its named-owner check for governed pathway -- SLAs so clinical accoun |
| apps/backend/src/migrations/586_care_pathway_owner_acceptance.sql:statement-19 | 611 | users | resolved references | -- Actionable tasks move with the live owner, but a completed SLA remains an -- immutable historical receipt for the clinician or queue that owned its -- clock. Migration 585 enfor |
| apps/backend/src/migrations/594_referral_closed_loop.sql:statement-5 | 30 | users | resolved references | UPDATE referrals    SET current_owner_uid = referring_doctor  WHERE current_owner_uid IS NULL    AND EXISTS (      SELECT 1        FROM users       WHERE users.tenant_id = referral |
| apps/backend/src/migrations/595_care_pathways_op_inpatient.sql:statement-21 | 471 | appointments, users | resolved references | CREATE OR REPLACE FUNCTION s4_assert_op_to_inpatient_transfer(   target_tenant_id UUID,   target_handoff_id UUID,   enforce_request_owner BOOLEAN DEFAULT TRUE ) RETURNS void LANGUA |
| apps/backend/src/migrations/595_care_pathways_op_inpatient.sql:statement-46 | 1040 | appointments, users | resolved references | CREATE OR REPLACE FUNCTION s4_validate_admission_source_link() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE   source_patient_uid UUID;   source_pathway RECORD;   source_handoff R |
| apps/backend/src/migrations/595_care_pathways_op_inpatient.sql:statement-58 | 1511 | appointments, users | resolved references | CREATE OR REPLACE FUNCTION s4_validate_op_closure_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE   appointment_patient_uid UUID;   follow_up_record RECORD;   handoff_rec |
| apps/backend/src/migrations/595_care_pathways_op_inpatient.sql:statement-66 | 1845 | users | resolved references | CREATE OR REPLACE FUNCTION s4_validate_primary_physician_assignment() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE   admission_record RECORD;   previous_assignment RECORD;   hand |
| apps/backend/src/migrations/596_care_pathways_ed_destination_handoff.sql:statement-13 | 229 | emergency_visits, users | resolved references | CREATE OR REPLACE FUNCTION s5_assert_ed_destination_handoff(   target_tenant_id UUID,   target_handoff_id UUID ) RETURNS void LANGUAGE plpgsql AS $$ DECLARE   transfer RECORD;   ac |
| apps/backend/src/migrations/596_care_pathways_ed_destination_handoff.sql:statement-18 | 472 | users | resolved references | CREATE OR REPLACE FUNCTION s5_enforce_ed_destination_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE   pathway_mode TEXT;   accepted_handoff RECORD; BEGIN   IF NEW.stat |
| apps/backend/src/migrations/597_care_pathways_ed_closure_recovery.sql:statement-14 | 437 | emergency_visits, users | resolved references | CREATE OR REPLACE FUNCTION s5_validate_ed_closure_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE   visit_record RECORD;   follow_up_record RECORD;   medication_record RE |
| apps/backend/src/migrations/597_care_pathways_ed_closure_recovery.sql:statement-18 | 836 | emergency_visits | resolved references | CREATE OR REPLACE FUNCTION s5_ed_closure_task_constraint() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE   visit_id INTEGER;   pathway_id UUID;   binding RECORD; BEGIN   IF NEW.ta |
| apps/backend/src/migrations/597_care_pathways_ed_closure_recovery.sql:statement-28 | 1056 | emergency_visits, users | resolved references | CREATE OR REPLACE FUNCTION s5_assert_ed_destination_handoff_v2(   target_tenant_id UUID,   target_handoff_id UUID ) RETURNS void LANGUAGE plpgsql AS $$ DECLARE   transfer RECORD;   |
| apps/backend/src/migrations/598_facility_tenant_fk_integrity.sql:statement-15 | 232 | appointment_queues | resolved references | -- --------------------------------------------------------------------------- -- 5. Drop the superseded single-column facility_id FKs. Matched by shape --    (single-column FK on  |
| apps/backend/src/migrations/598_facility_tenant_fk_integrity.sql:statement-8 | 157 | appointment_queues | resolved references | -- --------------------------------------------------------------------------- -- 3. Report pre-existing cross-tenant rows; abort (loudly, deleting --    nothing) before VALIDATE i |
| apps/backend/src/migrations/600_clinical_continuity_pack_governance.sql:statement-36 | 950 | users | resolved references | CREATE OR REPLACE FUNCTION clinical_continuity_assert_policy_approval(   target_tenant_id UUID,   target_policy_id UUID ) RETURNS void LANGUAGE plpgsql AS $$ DECLARE   policy_recor |
| apps/backend/src/migrations/600_clinical_continuity_pack_governance.sql:statement-38 | 1142 | users | resolved references | CREATE OR REPLACE FUNCTION clinical_continuity_policy_guard_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN   IF TG_OP = 'DELETE' THEN     RAISE EXCEPTION 'clinical contin |
| apps/backend/src/migrations/600_clinical_continuity_pack_governance.sql:statement-9 | 66 | emergency_visits, wards | resolved references | DO $cc_facility_preflight$ DECLARE   bad_wards BIGINT;   bad_ed BIGINT;   ward_samples TEXT;   ed_samples TEXT; BEGIN   SELECT COUNT(*),          (            SELECT string_agg(    |
| apps/backend/src/migrations/601_clinical_continuity_edge_access.sql:statement-21 | 267 | users | resolved references | DO $cc_edge_preflight$ DECLARE   bad_grants BIGINT;   bad_revocations BIGINT;   bad_receipts BIGINT;   grant_samples TEXT;   revocation_samples TEXT;   receipt_samples TEXT; BEGIN  |
| apps/backend/src/migrations/604_clinical_continuity_facility_context.sql:statement-29 | 452 | users | resolved references | UPDATE staff_devices AS device    SET user_uid = app_user.uid   FROM users AS app_user  WHERE device.user_uid IS NULL    AND device.staff_id = app_user.id    AND device.tenant_id = |
| apps/backend/src/migrations/617_scim_identity_recovery.sql:statement-10 | 185 | staff, users | resolved references | CREATE OR REPLACE FUNCTION public.validate_scim_provisioning_command() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$ DECLARE   inbox RECORD;   identit |
| apps/backend/src/migrations/624_clinical_continuity_held_message_release.sql:statement-36 | 1246 | users | resolved references | CREATE FUNCTION public.clinical_continuity_held_release_attest(   p_tenant_id UUID,   p_facility_id INTEGER,   p_decision JSONB ) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SE |
| apps/backend/src/migrations/624_clinical_continuity_held_message_release.sql:statement-37 | 1379 | users | resolved references | CREATE FUNCTION public.clinical_continuity_held_message_release(   p_tenant_id UUID,   p_facility_id INTEGER,   p_command JSONB ) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SE |
| apps/backend/src/migrations/628_external_recovery_operability.sql:statement-36 | 634 | users | resolved references | CREATE FUNCTION public.external_recovery_operability_register_offset(p_command JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ DE |
| apps/backend/src/migrations/628_external_recovery_operability.sql:statement-37 | 967 | users | resolved references | CREATE FUNCTION public.external_recovery_operability_authorize_resume(p_command JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ D |
| apps/backend/src/migrations/628_external_recovery_operability.sql:statement-38 | 1306 | users | resolved references | CREATE FUNCTION public.external_recovery_operability_record_refusal(p_command JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ DEC |
| apps/backend/src/migrations/628_external_recovery_operability.sql:statement-40 | 1524 | users | resolved references | CREATE FUNCTION public.external_recovery_critical_review_acknowledge(p_command JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ DE |
| apps/backend/src/migrations/630_clinical_continuity_incident_packet_provisioning.sql:statement-27 | 445 | users | resolved references | CREATE OR REPLACE FUNCTION public.cc_packet_assert_actor(   p_tenant_id UUID, p_actor_uid UUID, p_actor_role TEXT ) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = |
| apps/backend/src/migrations/631_hl7_inbound_recovery.sql:statement-14 | 680 | users | resolved references | CREATE FUNCTION public.validate_hl7_inbound_recovery_receipt() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ DECLARE   inbox public. |
| apps/backend/src/migrations/631_hl7_inbound_recovery.sql:statement-7 | 68 | users | resolved references | CREATE OR REPLACE FUNCTION public.external_recovery_operability_register_offset(p_command JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_te |
| apps/backend/src/migrations/632_clinical_continuity_activation_transition_governance.sql:statement-45 | 920 | users | resolved references | CREATE FUNCTION public.clinical_continuity_activation_advance_intent(p_command JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ DE |
| apps/backend/src/migrations/632_clinical_continuity_activation_transition_governance.sql:statement-46 | 1099 | users | resolved references | CREATE FUNCTION public.clinical_continuity_activation_advance_countersign(p_command JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS  |
| apps/backend/src/migrations/632_clinical_continuity_activation_transition_governance.sql:statement-47 | 1328 | users | resolved references | CREATE FUNCTION public.clinical_continuity_activation_halt(p_command JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ DECLARE   te |
| apps/backend/src/migrations/645_housekeeping_request_bed_linkage.sql:statement-6 | 45 | housekeeping_requests | resolved references | UPDATE housekeeping_requests hr    SET bed_id = b.id   FROM beds b  WHERE hr.bed_id IS NULL    AND hr.request_type = 'bed_cleaning'    AND hr.description ~ 'bed_id=[0-9]+\.'    --  |
| apps/backend/src/migrations/647_users_abha_number_tenant_unique.sql:statement-1 | 1 | users | resolved references | -- Migration 647: tenant-scoped canonical ABHA number uniqueness. -- -- @no-transaction -- @statement_timeout: 0 -- -- The linkage service stores new ABHA numbers in 2-4-4-4 hyphen |
| apps/backend/src/migrations/661_notification_device_global_handoff.sql:statement-1 | 1 | users | resolved references | -- Migration 661: Atomically hand notification-device ownership between accounts. -- user_devices remains under the forced restrictive policy installed by 604.  CREATE OR REPLACE F |
| apps/backend/src/migrations/663_notification_authority_epoch.sql:statement-5 | 14 | users | resolved references | CREATE OR REPLACE FUNCTION public.notification_device_handoff(   p_tenant_id UUID,   p_user_uid UUID,   p_device_id TEXT,   p_fcm_token TEXT,   p_device_name TEXT,   p_platform TEX |
| apps/backend/src/migrations/663_notification_authority_epoch.sql:statement-6 | 199 | users | resolved references | CREATE OR REPLACE FUNCTION public.revoke_notification_authority(   p_tenant_id UUID,   p_user_uid UUID ) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_cata |
| apps/backend/src/migrations/664_payroll_tenant_integrity.sql:statement-3 | 6 | users | resolved references | DO $$ BEGIN   IF EXISTS (     SELECT 1       FROM public.payslips AS payslip       JOIN public.payroll_runs AS payroll_run ON payroll_run.id = payslip.payroll_run_id      WHERE pay |
| apps/backend/src/migrations/668_scheduler_truth_and_notification_tenant_integrity.sql:statement-34 | 555 | users | resolved references | -- --------------------------------------------------------------------------- -- 3. Repair historical tenant drift, in committed chunks. -- --    A notification's owning tenant is |
| apps/backend/src/migrations/669_payroll_attempt_document_delivery.sql:statement-3 | 16 | staff, users | resolved references | DO $$ DECLARE   clash record; BEGIN   SELECT tenant_id, user_id, count(*) AS row_count     INTO clash     FROM public.staff    WHERE user_id IS NOT NULL    GROUP BY tenant_id, user |
| apps/backend/src/migrations/676_file_scan_status_columns_and_default_disarm.sql:statement-13 | 136 | investigation_bookings | resolved references | UPDATE investigation_bookings    SET slip_photo_scan_status = 'not_scanned'  WHERE slip_photo_key IS NOT NULL    AND slip_photo_scan_status IS NULL |
| apps/backend/src/migrations/676_file_scan_status_columns_and_default_disarm.sql:statement-14 | 141 | investigation_bookings | resolved references | UPDATE investigation_bookings    SET result_file_scan_status = 'not_scanned'  WHERE result_file_key IS NOT NULL    AND result_file_scan_status IS NULL |
| apps/backend/src/migrations/710_facility_asset_runtime_constraints.sql:statement-10 | 111 | users | resolved references | -- The composite FK proves tenant ownership but cannot express the runtime -- eligibility rule. Keep the database boundary aligned with the service: -- assignments to PATIENT or in |
| apps/backend/src/migrations/710_facility_asset_runtime_constraints.sql:statement-7 | 40 | users | resolved references | -- A retained 704 database could contain a cross-tenant, inactive, patient, or -- role-less custodian because the original table had no relationship backstop. -- Clear it before ma |
| apps/backend/src/migrations/729_tenant_bearing_fks_and_tenant_default_alignment.sql:statement-2 | 114 | appointments | resolved references | -- --------------------------------------------------------------------------- -- Preflights — no cross-tenant row may exist before the keys tighten. -- --------------------------- |
| apps/backend/src/migrations/729_tenant_bearing_fks_and_tenant_default_alignment.sql:statement-3 | 141 | appointments | resolved references | DO $share_intake_appointment_preflight$ DECLARE   offending BIGINT; BEGIN   SELECT COUNT(*) INTO offending     FROM abdm_patient_share_intakes i    WHERE i.linked_appointment_id IS |
| apps/backend/src/migrations/741_ward_indent_authoritative_state_machine.sql:statement-4 | 44 | users, housekeeping_logs, housekeeping_floor_assignments, housekeeping_zones, staff, housekeeping_requests, doctors, investigations, investigation_bookings, appointment_queues, appointments, emergency_visits, maternity_pregnancies, staff_performance_reviews, leave_applications, staff_attendance, incident_reports, report_updates, staff_grievances, wards, patient_data_rights_requests, e_prescriptions | all 22; pending proof | -- The inline migration-174 CHECK is absent on databases bootstrapped from the -- current baseline, but can still exist on older upgraded databases. Drop only -- checks whose expre |
| apps/backend/src/migrations/744_medication_inventory_billing_mar_closure.sql:statement-244 | 5213 | users | resolved references | CREATE OR REPLACE FUNCTION care_pathway_assert_task_sla_completion_receipt(   target_tenant_id UUID,   target_task_id INTEGER ) RETURNS void LANGUAGE plpgsql SET search_path = pg_c |
| apps/backend/src/migrations/744_medication_inventory_billing_mar_closure.sql:statement-29 | 480 | users | resolved references | CREATE OR REPLACE FUNCTION mar_medication_exception_event_actor_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$ DECLARE   medication_ |
| apps/backend/src/migrations/744_medication_inventory_billing_mar_closure.sql:statement-33 | 741 | users | resolved references | CREATE OR REPLACE FUNCTION mar_medication_exception_case_receipt_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$ DECLARE   current_ca |
| apps/backend/src/migrations/744_medication_inventory_billing_mar_closure.sql:statement-37 | 1484 | users | resolved references | CREATE OR REPLACE FUNCTION mar_medication_exception_escalation_snapshot_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$ DECLARE   exc |
| apps/backend/src/migrations/744_medication_inventory_billing_mar_closure.sql:statement-4 | 36 | users | resolved references | -- Older hold writes used administered_by for the holding nurse. Preserve that -- attribution only when it still resolves to an active tenant identity, then -- clear administered_b |
| apps/backend/src/migrations/744_medication_inventory_billing_mar_closure.sql:statement-6 | 56 | users | resolved references | UPDATE medication_administrations administration    SET missed_by = administration.administered_by  WHERE LOWER(administration.status) = 'missed'    AND administration.administered |
| apps/backend/src/migrations/745_clinical_alert_delivery_obligations.sql:statement-28 | 949 | users | resolved references | CREATE OR REPLACE FUNCTION public.clinical_alert_delivery_recovery_action_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$ DECLARE   r |
| apps/backend/src/migrations/745_clinical_alert_delivery_obligations.sql:statement-39 | 1399 | users | resolved references | CREATE OR REPLACE FUNCTION public.clinical_alert_delivery_assert_recipient_coverage_gap(   target_tenant_id UUID,   target_obligation_id BIGINT ) RETURNS void LANGUAGE plpgsql SET  |
| apps/backend/src/migrations/745_clinical_alert_delivery_obligations.sql:statement-40 | 1468 | users | resolved references | CREATE OR REPLACE FUNCTION public.clinical_alert_delivery_recovery_task_case_constraint() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$ DEC |
| apps/backend/src/migrations/745_clinical_alert_delivery_obligations.sql:statement-46 | 2139 | users | resolved references | CREATE OR REPLACE FUNCTION public.clinical_alert_delivery_recovery_escalation_snapshot_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn |
| apps/backend/src/migrations/745_clinical_alert_delivery_obligations.sql:statement-9 | 171 | emergency_visits, users | resolved references | CREATE OR REPLACE FUNCTION public.clinical_alert_delivery_obligation_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$ DECLARE   matching_outbox_co |
| apps/backend/src/migrations/746_pharmacy_counter_sale_void_obligations.sql:statement-17 | 201 | users | resolved references | CREATE OR REPLACE FUNCTION counter_sale_void_request_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$ DECLARE   bound_refund billing_r |
| apps/backend/src/migrations/746_pharmacy_counter_sale_void_obligations.sql:statement-19 | 491 | users | resolved references | CREATE OR REPLACE FUNCTION counter_sale_void_refund_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$ DECLARE   request_row pharmacy_co |
| apps/backend/src/migrations/747_billing_cash_refund_drawer_reconciliation.sql:statement-26 | 546 | users | resolved references | CREATE OR REPLACE FUNCTION billing_refund_payout_guard_747() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$ DECLARE   drawer_row cash_drawer |
| apps/backend/src/migrations/748_cath_inventory_shortfall_recovery.sql:statement-10 | 143 | users | resolved references | CREATE OR REPLACE FUNCTION public.cath_inventory_shortfall_task_sync() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $cath_inventory_shortfall_t |
| apps/backend/src/migrations/748_cath_inventory_shortfall_recovery.sql:statement-17 | 491 | users | resolved references | CREATE OR REPLACE FUNCTION public.cath_inventory_shortfall_assert_contract(   target_tenant_id UUID,   target_usage_id BIGINT ) RETURNS void LANGUAGE plpgsql SET search_path = pg_c |
| apps/backend/src/migrations/752_payment_gateway_refund_recovery.sql:statement-35 | 941 | users | resolved references | -- Resource-side mutation must not be able to detach or falsify the deferred -- task/SLA contract after its task row has already passed validation. CREATE OR REPLACE FUNCTION payme |
| apps/backend/src/migrations/752_payment_gateway_refund_recovery.sql:statement-7 | 88 | users | resolved references | -- Historical rows also predate the four-eyes execution contract. Park every -- unresolved leg that cannot prove a same-tenant initiator, independent -- approver, and post-approval |
| apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-11 | 189 | e_prescriptions | resolved references | -- Authority origin is stamped only where the evidence proves it: a linked -- e_prescriptions row, or a patient-uploaded prescription photo key. An order -- with neither has no pro |
| apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-147 | 2293 | maternity_pregnancies, users | resolved references | CREATE OR REPLACE FUNCTION public.bump_pharmacy_patient_safety_version_753() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ DECLARE   pay |
| apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-149 | 2446 | appointments, e_prescriptions, maternity_pregnancies, users | resolved references | DO $med03$ DECLARE   source_table TEXT; BEGIN   FOREACH source_table IN ARRAY ARRAY[     'users', 'patient_allergies', 'allergies', 'admissions', 'appointments',     'clinical_note |
| apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-291 | 3841 | staff, users | resolved references | INSERT INTO pharmacy_inventory_authority_recovery_worklist (   tenant_id, entity_type, entity_id, inventory_item_id, facility_id,   reason_code, authority_snapshot ) SELECT usage.t |
| apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-294 | 4344 | staff, users | resolved references | CREATE OR REPLACE FUNCTION public.cath_inventory_authority_assert_contract_753(   target_tenant_id UUID,   target_usage_id BIGINT ) RETURNS void LANGUAGE plpgsql SET search_path =  |
| apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-341 | 5110 | users | resolved references | INSERT INTO tasks (   tenant_id,task_kind,title,description,patient_uid,related_resource_type,   related_resource_id,priority,status,assigned_to_role,metadata ) SELECT duplicate.te |
| apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-342 | 5147 | users | resolved references | INSERT INTO pharmacy_funding_reconciliation_cases (   tenant_id,facility_id,patient_uid,pharmacy_order_id,task_id,   task_resource_type,task_resource_id,snapshot_sha256,snapshot )  |
| apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-375 | 5607 | users | resolved references | CREATE OR REPLACE FUNCTION public.enforce_nhcx_projection_command_753() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN   IF TG_OP='DELETE' THEN     RAISE EXCEPTION 'NHCX projection c |
| apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-48 | 695 | staff, users | resolved references | INSERT INTO pharmacy_inventory_authority_recovery_worklist (   tenant_id, entity_type, entity_id, reason_code, authority_snapshot ) SELECT actor.tenant_id, 'staff_facility_grant',  |
| apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-64 | 951 | wards | resolved references | UPDATE ward_indents indent    SET facility_id=ward.facility_id,        facility_authority_version=1,        updated_at=NOW()   FROM wards ward  WHERE ward.tenant_id=indent.tenant_i |
| apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-66 | 975 | wards | resolved references | INSERT INTO pharmacy_inventory_authority_recovery_worklist (   tenant_id, entity_type, entity_id, facility_id, reason_code, authority_snapshot ) SELECT indent.tenant_id, 'ward_inde |
| apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-70 | 1095 | e_prescriptions | resolved references | WITH ranked_links AS (   SELECT ep.tenant_id, ep.id, ep.pharmacy_order_id,          ROW_NUMBER() OVER (            PARTITION BY ep.tenant_id, ep.pharmacy_order_id            ORDER  |
| apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-72 | 1145 | e_prescriptions | resolved references | UPDATE e_prescriptions ep    SET pharmacy_order_id=NULL,        updated_at=NOW()  WHERE EXISTS (    SELECT 1      FROM pharmacy_inventory_authority_recovery_worklist recovery     W |
| apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-74 | 1171 | e_prescriptions | resolved references | -- Governed replacement for the removed authority_origin backfill: orders with -- neither a linked e-prescription nor a prescription photo keep a NULL origin -- and are worklisted  |
| apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-76 | 1219 | e_prescriptions, users | resolved references | INSERT INTO pharmacy_inventory_authority_recovery_worklist (   tenant_id, entity_type, entity_id, reason_code, authority_snapshot ) SELECT ep.tenant_id, 'e_prescription', ep.id, 'P |
| apps/backend/src/migrations/753_pharmacy_order_inventory_authority.sql:statement-93 | 1615 | users | resolved references | INSERT INTO pharmacy_inventory_authority_recovery_worklist (   tenant_id, entity_type, entity_id, facility_id, reason_code, authority_snapshot ) SELECT po.tenant_id, 'pharmacy_orde |
| apps/backend/src/migrations/754_salary_revision_tenant_reconciliation.sql:statement-138 | 2229 | users | resolved references | CREATE TEMP TABLE bulk_revision_jobs_754_identity ON COMMIT DROP AS SELECT job.id, job.tenant_id AS observed_tenant_id,        creator.tenant_id AS creator_tenant_id,        hr_sig |
| apps/backend/src/migrations/754_salary_revision_tenant_reconciliation.sql:statement-179 | 3093 | users | resolved references | INSERT INTO salary_revision_payables (   tenant_id, revision_id, staff_uid, payable_type, amount, status,   reconciliation_reason, reconciliation_evidence ) SELECT revision.tenant_ |
| apps/backend/src/migrations/754_salary_revision_tenant_reconciliation.sql:statement-20 | 532 | users | resolved references | CREATE TEMP TABLE salary_revision_754_classification ON COMMIT DROP AS WITH identity_evidence AS (   SELECT     revision.id,     revision.revision_number,     revision.tenant_id AS |
| apps/backend/src/migrations/754_salary_revision_tenant_reconciliation.sql:statement-25 | 919 | users | resolved references | CREATE TEMP TABLE salary_arrears_754_classification ON COMMIT DROP AS SELECT   arrears.id,   arrears.tenant_id AS observed_tenant_id,   arrears.staff_uid,   arrears.revision_id AS  |
| apps/backend/src/migrations/754_salary_revision_tenant_reconciliation.sql:statement-29 | 1062 | users | resolved references | CREATE TEMP TABLE annual_review_reminders_754_classification ON COMMIT DROP AS SELECT   reminder.id,   reminder.tenant_id AS observed_tenant_id,   reminder.staff_uid,   reminder.re |
| apps/backend/src/migrations/755_clinical_import_receipt_and_history_immutability.sql:statement-12 | 183 | users | resolved references | CREATE OR REPLACE FUNCTION clinical_import_document_authority_guard_755() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ BEGIN   IF NO |
| apps/backend/src/migrations/755_clinical_import_receipt_and_history_immutability.sql:statement-14 | 248 | e_prescriptions, users | resolved references | CREATE OR REPLACE FUNCTION clinical_import_resource_authority_guard_755() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ DECLARE   doc |
| apps/backend/src/migrations/755_clinical_import_receipt_and_history_immutability.sql:statement-19 | 554 | users | resolved references | CREATE OR REPLACE FUNCTION clinical_import_history_immutable_755() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ BEGIN   IF OLD.lifec |
| apps/backend/src/migrations/755_clinical_import_receipt_and_history_immutability.sql:statement-22 | 621 | e_prescriptions, users | resolved references | CREATE OR REPLACE FUNCTION clinical_import_history_receipt_guard_755() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ DECLARE   import |
| apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-10 | 2207 | users | resolved references | CREATE OR REPLACE FUNCTION public.build_pharmacy_advance_reservation_plan_753(target_tenant_id uuid, target_terminal_patient_uid uuid, target_patient_uid_family uuid[], target_phar |
| apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-11 | 2951 | e_prescriptions, users | resolved references | CREATE OR REPLACE FUNCTION public.build_pharmacy_substitution_authority_753(target_tenant_id uuid, target_terminal_patient_uid uuid, target_patient_uid_family uuid[], target_pharma |
| apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-13 | 3613 | maternity_pregnancies, users | resolved references | CREATE OR REPLACE FUNCTION public.bump_pharmacy_patient_safety_version_753()  RETURNS trigger  LANGUAGE plpgsql  SECURITY DEFINER  SET search_path TO 'public', 'pg_temp' AS $functi |
| apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-16 | 4042 | staff, users | resolved references | CREATE OR REPLACE FUNCTION public.cath_inventory_authority_assert_contract_753(target_tenant_id uuid, target_usage_id bigint)  RETURNS void  LANGUAGE plpgsql  SET search_path TO 'p |
| apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-18 | 4420 | staff, users | resolved references | CREATE OR REPLACE FUNCTION public.complete_pharmacy_funding_command_753(target_tenant_id uuid, target_command_id bigint, target_actor_uid uuid, target_response_body jsonb)  RETURNS |
| apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-19 | 4926 | staff, users | resolved references | CREATE OR REPLACE FUNCTION public.convert_pharmacy_advance_settlement_753(target_tenant_id uuid, target_settlement_receipt_id bigint, target_actor_uid uuid)  RETURNS TABLE(id bigin |
| apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-31 | 6033 | users | resolved references | CREATE OR REPLACE FUNCTION public.enforce_nhcx_projection_command_753()  RETURNS trigger  LANGUAGE plpgsql AS $function$ BEGIN   IF TG_OP='DELETE' THEN     RAISE EXCEPTION 'NHCX pr |
| apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-33 | 6113 | users | resolved references | CREATE OR REPLACE FUNCTION public.enforce_pharmacy_advance_allocation_authority_753()  RETURNS trigger  LANGUAGE plpgsql  SET search_path TO 'public', 'pg_temp' AS $function$ DECLA |
| apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-34 | 6347 | staff, users | resolved references | CREATE OR REPLACE FUNCTION public.enforce_pharmacy_advance_approval_amount_753()  RETURNS trigger  LANGUAGE plpgsql  SECURITY DEFINER  SET search_path TO 'public', 'pg_temp'  SET r |
| apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-48 | 8092 | staff, users | resolved references | CREATE OR REPLACE FUNCTION public.enforce_pharmacy_funding_receipt_pair_753()  RETURNS trigger  LANGUAGE plpgsql  SET search_path TO 'public', 'pg_temp' AS $function$ DECLARE   app |
| apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-57 | 9276 | users | resolved references | CREATE OR REPLACE FUNCTION public.lock_pharmacy_advance_reservation_sources_753(target_tenant_id uuid, target_terminal_patient_uid uuid, target_pharmacy_order_id integer, target_in |
| apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-58 | 9424 | users | resolved references | CREATE OR REPLACE FUNCTION public.lock_pharmacy_funding_command_order_753()  RETURNS trigger  LANGUAGE plpgsql  SECURITY DEFINER  SET search_path TO 'public', 'pg_temp'  SET row_se |
| apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-59 | 9547 | e_prescriptions, users | resolved references | CREATE OR REPLACE FUNCTION public.lock_pharmacy_substitution_sources_753(target_tenant_id uuid, target_terminal_patient_uid uuid, target_pharmacy_order_id integer, target_invoice_i |
| apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-6 | 302 | staff, users | resolved references | CREATE OR REPLACE FUNCTION public.assert_pharmacy_advance_consumption_receipt_753(target_tenant_id uuid, target_consumption_receipt_id bigint)  RETURNS void  LANGUAGE plpgsql  SECU |
| apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-8 | 1251 | users | resolved references | CREATE OR REPLACE FUNCTION public.assert_pharmacy_advance_release_receipt_753(target_tenant_id uuid, target_release_receipt_id bigint)  RETURNS void  LANGUAGE plpgsql  SECURITY DEF |
| apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-81 | 10767 | staff, users | resolved references | CREATE OR REPLACE FUNCTION public.preview_pharmacy_advance_reservation_753(target_tenant_id uuid, target_pharmacy_order_id integer, target_selector jsonb, target_proposer_uid uuid, |
| apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-87 | 11005 | staff, users | resolved references | CREATE OR REPLACE FUNCTION public.reserve_pharmacy_advance_allocations_753(target_tenant_id uuid, target_approval_receipt_id bigint, target_approver_uid uuid)  RETURNS jsonb  LANGU |
| apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-88 | 11515 | users | resolved references | CREATE OR REPLACE FUNCTION public.resolve_billing_patient_family_753(target_tenant_id uuid, target_terminal_uid uuid)  RETURNS uuid[]  LANGUAGE plpgsql  SECURITY DEFINER  SET searc |
| apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-89 | 11583 | users | resolved references | CREATE OR REPLACE FUNCTION public.resolve_billing_patient_terminal_753(target_tenant_id uuid, target_patient_uid uuid)  RETURNS uuid  LANGUAGE plpgsql  SECURITY DEFINER  SET search |
| apps/backend/src/migrations/758_pharmacy_advance_funding_authority.sql:statement-9 | 1623 | users | resolved references | CREATE OR REPLACE FUNCTION public.assert_pharmacy_advance_settlement_receipt_753(target_tenant_id uuid, target_settlement_receipt_id bigint)  RETURNS void  LANGUAGE plpgsql  SECURI |
| apps/backend/src/migrations/759_fix_escalation_snapshot_guard_case.sql:statement-2 | 33 | users | resolved references | -- ---- mar_medication_exception_escalation_snapshot_guard (originally shipped in 744_medication_inventory_billing_mar_closure.sql) ---- CREATE OR REPLACE FUNCTION mar_medication_e |
| apps/backend/src/migrations/759_fix_escalation_snapshot_guard_case.sql:statement-3 | 233 | users | resolved references | -- ---- clinical_alert_delivery_recovery_escalation_snapshot_guard (originally shipped in 745_clinical_alert_delivery_obligations.sql) ---- CREATE OR REPLACE FUNCTION public.clinic |
| apps/backend/src/migrations/760_clinical_import_authority_custody_and_reconciliation.sql:statement-11 | 218 | users | resolved references | -- Keep operational imported medication history movable only inside the -- approved patient-merge transaction. The explicit negative merge guard lets -- the runtime preflight prove |
| apps/backend/src/migrations/760_clinical_import_authority_custody_and_reconciliation.sql:statement-22 | 486 | users | resolved references | CREATE OR REPLACE FUNCTION public.clinical_import_authority_event_guard_760() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ DECLARE   |
| apps/backend/src/migrations/760_clinical_import_authority_custody_and_reconciliation.sql:statement-24 | 622 | users | resolved references | CREATE OR REPLACE FUNCTION public.lock_clinical_import_authority_760(   target_tenant_id uuid,   target_grant_id uuid,   target_patient_uid uuid,   target_facility_id integer,   ta |
| apps/backend/src/migrations/760_clinical_import_authority_custody_and_reconciliation.sql:statement-25 | 701 | users | resolved references | CREATE OR REPLACE FUNCTION public.clinical_import_document_authority_guard_755() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ DECLAR |
| apps/backend/src/migrations/760_clinical_import_authority_custody_and_reconciliation.sql:statement-26 | 893 | users | resolved references | CREATE OR REPLACE FUNCTION public.clinical_import_reconciliation_item_guard_760() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ BEGIN |
| apps/backend/src/migrations/760_clinical_import_authority_custody_and_reconciliation.sql:statement-27 | 934 | users | resolved references | CREATE OR REPLACE FUNCTION public.clinical_import_active_patient_survivor_760(   target_tenant_id uuid,   target_patient_uid uuid ) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINE |
| apps/backend/src/migrations/760_clinical_import_authority_custody_and_reconciliation.sql:statement-29 | 1070 | users | resolved references | CREATE OR REPLACE FUNCTION public.clinical_import_reconciliation_event_guard_760() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ DECL |
| apps/backend/src/migrations/761_fix_clinical_alert_recovery_snapshot_rule_codes.sql:statement-2 | 3 | users | resolved references | -- Migration 759 repaired this function's plpgsql syntax but retained rule codes -- that are not emitted by the clinical alert delivery recovery workflow. Replace -- the function f |
| apps/backend/src/migrations/765_cath_device_reuse.sql:statement-31 | 462 | staff, users | resolved references | -- --------------------------------------------------------------------------- -- 7. Re-declare the 753 assert function (body copied from 758 + the reused branch) -- -------------- |

## Source dispatch boundaries

The JSON also enumerates indirect callback calls encountered on the source trace. Callback arguments and defaults are followed at their callers; the immutable projector registry is expanded explicitly. These are source-analysis boundaries, not empirical dispatch evidence or accepted unreachability dispositions. Two unresolved migration SQL dispatchers are expanded by the administrative statement catalog; any other unresolved reachable raw SQL stops generation.

- apps/backend/src/middleware/apiVersionMiddleware.js:17: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/lib/redis.js:234: reject — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/lib/redis.js:324: onReconnect — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/prometheusMiddleware.js:181: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/prometheusMiddleware.js:192: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/lib/prisma.js:642: fn — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/auditLog.js:744: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/corsMiddleware.js:146: applyCors — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/workflow/workflowHumanOwnerService.js:176: rolePredicate — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/workflow/workflowDefinitionCompiler.js:186: resolver — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/pathways/pathwayExecutorService.js:583: fn — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/pathways/pathwayExecutorService.js:587: fn — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/utils/notifications/notificationDispatcher.js:121: factory — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/clinical/canonicalOperationalBridgeService.js:67: task — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/emr/clinicalTimelineService.js:29: fn — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/utils/ssrfGuard.js:328: _transport.fetch — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/observability/reliabilityMetrics.js:396: operation — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/utils/websocket/wsRedisAdapter.js:155: resolve — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/utils/websocket/wsRedisAdapter.js:187: deliverBroadcast — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/utils/websocket/wsRedisAdapter.js:190: deliverUser — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/utils/websocket/wsRedisAdapter.js:382: localFallback — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/utils/websocket/wsRedisAdapter.js:386: localFallback — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/utils/websocket/wsRedisAdapter.js:402: deliverBroadcast — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/utils/websocket/wsRedisAdapter.js:443: deliverUser — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/utils/websocket/wsServer.js:41: fn — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/utils/websocket/wsServer.js:137: getClient — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/utils/websocket/wsServer.js:261: registerClient — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/utils/websocket/wsServer.js:335: registerClient — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/utils/websocket/wsServer.js:344: registerClient — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/utils/websocket/wsServer.js:860: deliver — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/utils/tokenBlacklist.js:138: fn — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/jwtMiddleware.js:342: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/jwtMiddleware.js:668: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/infrastructureAccessMiddleware.js:119: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/infrastructureAccessMiddleware.js:138: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/infrastructureAccessMiddleware.js:155: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/infrastructureAccessMiddleware.js:158: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/tenantContextMiddleware.js:156: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/tenantContextMiddleware.js:177: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/tenantContextMiddleware.js:198: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/tenantContextMiddleware.js:215: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/tenantContextMiddleware.js:246: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/tenantContextMiddleware.js:267: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/tenantContextMiddleware.js:271: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/tenantContextMiddleware.js:285: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/tenantRlsMiddleware.js:32: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/utils/r2Storage.js:111: fn — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/loggingMiddleware.js:25: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/phiAccessMiddleware.js:118: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/phiAccessMiddleware.js:147: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/phiAccessMiddleware.js:157: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/phiAccessMiddleware.js:167: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/fhirPatientContext.js:79: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/fhirPatientContext.js:96: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/fhirPatientContext.js:100: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/fhirPatientContext.js:102: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/fhirPatientContext.js:104: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/rateLimitMiddleware.js:357: probeLimiterMw — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/rateLimitMiddleware.js:358: generalLimiterMw — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/rateLimitMiddleware.js:478: adminRateLimiter — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/rateLimitMiddleware.js:491: staffRateLimiter — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/rateLimitMiddleware.js:495: patientRateLimiter — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/rateLimitMiddleware.js:498: genericLimiter — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/requestIdMiddleware.js:6: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/sentryScopeMiddleware.js:36: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/selfHealingMiddleware.js:23: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/validateApiKey.js:75: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/validateApiKey.js:97: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/cacheControlMiddleware.js:10: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/abdm/abdmRoutes.js:103: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/abdm/abdmRoutes.js:213: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/abdm/abdmRoutes.js:313: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/abdm/abdmRoutes.js:380: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/abdm/abdmRoutes.js:397: run — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/abdm/abdmRoutes.js:404: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/abdm/abdmEnrolmentRoutes.js:35: run — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/abdm/abdmEnrolmentRoutes.js:41: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/abdm/abdmEnrolmentRoutes.js:71: resolveTargetUid — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/abdm/abdmEnrolmentRoutes.js:90: resolveTargetUid — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/abdm/abdmEnrolmentRoutes.js:109: resolveTargetUid — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/abdm/abdmEnrolmentRoutes.js:126: resolveTargetUid — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/appointment/appointmentLifecycleService.js:455: authorize — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/appointment/appointmentLifecycleService.js:473: resolveIdempotent — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/appointment/appointmentLifecycleService.js:508: mutate — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/appointment/appointmentLifecycleService.js:532: eventPayload — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/uhi/uhiRoutes.js:75: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/uhi/uhiRoutes.js:192: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/terminology/whoIcdClient.js:72: fetchImpl — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/terminology/whoIcdClient.js:95: now — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/terminology/whoIcdClient.js:118: now — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/nhcx/nhcxInboundCallbackService.js:662: runtimeResolver — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/nhcx/nhcxInboundCallbackService.js:665: decryptPayload — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/nhcx/nhcxCallbackRoutes.js:61: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/nhcx/nhcxCallbackRoutes.js:119: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/nhcx/nhcxCallbackRoutes.js:144: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/interfaceEngine/interfaceEngineIngressRoutes.js:50: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/auditLogger.js:14: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/identityValidator.js:23: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/identityValidator.js:30: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/identityValidator.js:35: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/identityValidator.js:59: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/auth/scimProvisioningService.js:23: fn — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/ai/hallucinationDefenses.js:337: validate — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/emr/vitalsChartService.js:700: beforeWrite — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/emr/vitalsChartService.js:829: beforeCommit — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/emr/vitalsChartService.js:858: onNews2EffectsCompleted — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/emr/vitalsChartService.js:906: onClinicalAlertsPersisted — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/emr/vitalsChartService.js:955: deferPostCommitEffects — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/emr/vitalsChartService.js:1047: beforeClinicalEffects — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/emr/vitalsChartService.js:1133: onNews2EffectsCompleted — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/emr/vitalsChartService.js:1155: onClinicalAlertsPersisted — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/import/patientDataImport.js:3022: beforeFhirVitalWrite — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/security/siemExportService.js:788: fetchImpl — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/security/siemExportService.js:832: mkdirImpl — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/security/siemExportService.js:836: writeFileImpl — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/idempotencyMiddleware.js:45: requestPathForIdempotency — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/idempotencyMiddleware.js:107: onlyWhen — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/idempotencyMiddleware.js:107: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/idempotencyMiddleware.js:110: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/idempotencyMiddleware.js:120: requestBodyForIdempotency — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/idempotencyMiddleware.js:142: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/idempotencyMiddleware.js:154: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/idempotencyMiddleware.js:179: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/idempotencyMiddleware.js:200: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/idempotencyMiddleware.js:202: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/idempotencyMiddleware.js:260: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/clinical/marMedicationExceptionService.js:314: createTaskTx — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/clinical/clinicalAlertDeliveryObligationService.js:1298: resolveRecipients — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/rejectMobileClinicalWriteMiddleware.js:99: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/rejectMobileClinicalWriteMiddleware.js:113: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/downtime/clinicalContinuityFacilityContextService.js:325: policyLoader — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/ai/workflowGraphRunner.js:394: node — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/ai/workflowGraphRunner.js:397: reject — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/ai/workflowGraphRunner.js:400: node — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/ai/documentOcrAdapter.js:161: reject — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/ai/trialCatalogSyncService.js:191: fetchImpl — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/ai/trialCatalogSyncService.js:217: fetchImpl — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/auth/authService.js:49: fn — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/pharmacy/wardIndentPatientGuards.js:46: readIndentId — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/pharmacy/wardIndentPatientGuards.js:96: readAdmissionId — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/configRoutes.js:113: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/health/clientReadinessService.js:18: clock — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/health/patientReadinessService.js:12: clock — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/scripts/lib/migrationChecksum.mjs:12: readSql — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/authenticatedTenantContext.js:24: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/middleware/authenticatedTenantContext.js:26: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/infrastructure/rbacRoutes.js:48: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/fhir/fhirRoutes.js:242: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/fhir/fhirRoutes.js:360: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/fhir/fhirRoutes.js:364: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/fhir/fhirRoutes.js:434: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/fhir/fhirRoutes.js:436: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/fhir/fhirRoutes.js:474: fn — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/smartFhir/publicSmartFhirRoutes.js:34: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/smartFhir/publicSmartFhirRoutes.js:36: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/smartFhir/publicSmartFhirRoutes.js:122: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/smartFhir/publicSmartFhirRoutes.js:156: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/smartFhir/publicSmartFhirRoutes.js:172: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/hl7/hl7InboundIngressGate.js:98: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/hl7/hl7IngressRateLimit.js:56: middleware — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/hl7/hl7IngressRateLimit.js:60: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/hl7/hl7IngressRateLimit.js:70: middleware — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/routes/hl7/hl7IngressRateLimit.js:87: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/gdpr/dataErasureService.js:24: fn — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/notification/smsDeliveryStatusService.js:208: onAuthenticated — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/notification/smsDeliveryStatusService.js:294: onAuthenticated — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/app.js:430: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/app.js:447: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/app.js:448: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/app.js:594: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/app.js:709: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/app.js:714: parser — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/app.js:717: middleware — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/app.js:721: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/app.js:731: middleware — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/app.js:830: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/app.js:839: next — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/utils/tenantFanout.js:416: writeReceipt — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/utils/tenantFanout.js:529: perTenantFn — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/utils/tenantFanout.js:692: fleetFn — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/utils/notifications/stuckOrderEscalation.js:114: sendPushNotification — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/services/events/pathwayProjectorService.js:549: handler — All function imports in the frozen generation-specific pathway projector registry; generation/event filters remain pending proof.
- apps/backend/src/utils/scheduler.js:120: fn — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.
- apps/backend/src/utils/scheduler.js:1557: task — Indirect callback: source callback arguments/defaults are traced at their callers; no empirical dispatch claim.

## Closure acceptance remains outstanding

K = 0 for the table, exact list and count, disposition tests in the same closure PR; each test explicitly enables AUTH_ENFORCE_TENANT_RLS=true and AUTH_TENANT_RLS_RUNTIME_ROLE=vhhealth_app and asserts current_user/rolsuper/rolbypassrls, population first and nonzero job work.

No three-run runtime mutation is asserted here. The census mutation removes one users entry from the expected pin, requires exactly the users row to fail while the other 21 pass, then restores the file and verifies its SHA-256. Runtime conversion, migration-736 routine and unreachability tests belong in the owning module PR. The restrictive policy retains the plan4NewRelationRlsContextMatrix shape.
