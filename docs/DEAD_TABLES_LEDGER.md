# Dead-table ledger

Tables with migrations but **zero runtime readers or writers**, found by the
2026-08-14 findings pass (services/scheduler/WS/Prisma P3 #1) and re-verified
against `origin/main` 48e3e73e on 2026-08-15. Two dispositions:

- **Dropped** — no inbound FK from a live table, no dependent view, no data
  value. Removed by `apps/backend/src/migrations/673_drop_dead_tables.sql`
  (schema.prisma regenerated via `prisma db pull` in the same commit).
- **Retained** — FK-entangled with live rows, or a deliberately designed
  future-facing slot. Kept in schema; recorded here so the next audit does not
  re-litigate them from scratch. If a retained table is still unused when its
  named condition is met (or clearly abandoned), drop it then.

## Dropped (migration 673)

| Table | Created | Evidence |
|---|---|---|
| `problem_episode_links` | 306 | Problem-list adjunct; no reader/writer anywhere in `src/`. |
| `problem_list_snapshots` | 306 | Same family; never wired. |
| `lab_analyzer_status_history` | 260 | Analyzer status audit trail; no INSERT anywhere. |
| `external_system_mappings` | 115 | Pre-interface-engine mapping table; superseded by the `interop_*` stack. |
| `icu_daily_chart_summaries` | 502 | ICU chart rollup; never written. |
| `icu_chart_ui_preferences` | 501/535 | Per-user ICU chart layout prefs; the UI was never built. |

All six carried only **outbound** FKs (into `tenants`, `users`,
`integrations`, `lab_analyzers`, `patient_problems`, `icu_admissions`) and fed
no view — verified via `pg_constraint`/`pg_depend` on a fully migrated DB.
Migration-shape unit tests (`clinicalGovernanceMigration.test.js`,
`integrationWebhookMigration.test.js`, …) pin the ORIGINAL migration texts and
are unaffected by a later DROP.

## Retained — do not drop without re-reading this

| Table | Created | Why retained |
|---|---|---|
| `learning_assignments` | 472 | **Live FK dependent**: `learning_completions.assignment_id` references it, and `adoptionService.js` writes that column (`INSERT INTO learning_completions … assignment_id = COALESCE(EXCLUDED.assignment_id, …)`). Nothing yet creates assignment rows, but dropping the table means dropping a column a live write path touches. |
| `icu_chart_policy_versions` | 495 | **Live FK dependent**: `icu_scoring_outputs.policy_version_id` references it and `icuChartingService.js` inserts that column (today always NULL — no INSERT into the policy table exists, so the value can only be NULL or fail the FK). The policy-versioning design slot is real; dropping requires first removing the column from a live clinical write path. |
| `smart_fhir_write_resource_plan` | 463 | Designed write-plan ledger for SMART-on-FHIR write scopes (currently read-only surface is live). Future-facing by design. |
| `ed_injury_diagram_attachments` | 523 | The ED trauma/MLC flow stores only an `injury_diagram_marked` boolean (`edTraumaMlcService.js`); this table is the designed evidence store that boolean should eventually point at. Future-facing feature slot. |
| `interop_worker_leases` | 477/611 | Real lease state lives on per-message columns (`interfaceEngineService.js` claim/lease logic). The table was deliberately retained and re-covered by migration 611's fail-closed RLS layer (`interop_explicit_context`), and the I05 recovery deep tests (`interfaceEngineHl7v2RecoveryMigration.deep.test.js`) assert its policies as part of the adapted-ledger contract. Treated as a reserved scale-out slot of the continuity substrate; dropping it would edit the C6.1 contract tests for zero operational gain. |

## Second stratum — recorded 2026-08-23 (once-over), drop pending live-DB check

Fourteen further tables with zero references anywhere in src/, scripts/,
apps/admin, apps/device-gateway, infra/continuity-edge, or packages/ —
verified including the grep-invisibility traps (no dynamic table-name
construction, no baseline triggers, no view consumers, no cross-stack
readers). Thirteen are baseline-era (000_baseline.sql, predating numbered
migrations, which is why the 2026-08-14 pass missed them); RLS policies were
added over them by 335/336. The fourteenth, `appointment_archive`, died when
its only writer was retired with a 410 (`appointmentAdminRoutes.js` —
APPOINTMENT_HARD_DELETE_RETIRED); only test cleanup touches it now.

`batch_upload_logs`, `bulk_operation_logs`, `file_access_logs`,
`medical_activity_logs`, `pharmacy_activity_logs`, `system_alerts`,
`user_action_logs`, `user_status_history`, `user_deactivation_log`,
`user_reactivation_log`, `investigation_templates`,
`investigation_template_tests`, `qa_seed_meta`, `appointment_archive` (346).

Per the migration-673 procedure, an actual DROP needs a
`pg_constraint`/`pg_depend` + row-count check on a live migrated DB first —
this entry records the finding so the next schema-hygiene pass starts here.
