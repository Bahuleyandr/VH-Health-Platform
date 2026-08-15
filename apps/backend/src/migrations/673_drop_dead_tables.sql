-- Migration 673: drop six dead tables (2026-08-14 findings, services P3 #1).
--
-- Each table below had migrations but ZERO runtime readers or writers at
-- origin/main 48e3e73e — re-verified by repo-wide grep over src/ (services,
-- routes, utils, scripts; migration files and migration-shape tests excluded,
-- since those pin the ORIGINAL migration texts and are unaffected by a later
-- DROP). None has an inbound foreign key from a live table and none feeds a
-- view (verified against pg_constraint / pg_depend on a fully migrated DB):
--
--   problem_episode_links       (306) — problem-list adjunct, never wired
--   problem_list_snapshots      (306) — problem-list adjunct, never wired
--   lab_analyzer_status_history (260) — analyzer status audit, never written
--   external_system_mappings    (115) — pre-interface-engine mapping table,
--                                       superseded by the interop_* stack
--   icu_daily_chart_summaries   (502) — ICU rollup, never written
--   icu_chart_ui_preferences    (501/535) — per-user chart prefs, UI never built
--
-- Deliberately NOT dropped (FK-entangled with live rows or designed
-- future-facing slots): learning_assignments, icu_chart_policy_versions,
-- smart_fhir_write_resource_plan, ed_injury_diagram_attachments,
-- interop_worker_leases. See docs/DEAD_TABLES_LEDGER.md for the evidence.
--
-- DROP TABLE removes each table's own outbound FKs, indexes, triggers and
-- RLS policies with it; there are no inbound dependencies to cascade.

DROP TABLE IF EXISTS problem_episode_links;
DROP TABLE IF EXISTS problem_list_snapshots;
DROP TABLE IF EXISTS lab_analyzer_status_history;
DROP TABLE IF EXISTS external_system_mappings;
DROP TABLE IF EXISTS icu_daily_chart_summaries;
DROP TABLE IF EXISTS icu_chart_ui_preferences;
