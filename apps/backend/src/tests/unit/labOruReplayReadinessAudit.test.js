import { jest } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import {
  ACKNOWLEDGEMENT_FLAG,
  BEGIN_READ_ONLY_QUERY,
  BLOCKED_EXIT_CODE,
  COMMIT_QUERY,
  CUTOVER_MIGRATIONS,
  FROZEN_CUTOVER_MIGRATION_ARTIFACTS,
  MIGRATION_TRACKER_QUERY,
  POST_581_ACK_REPORT_QUERY_KEYS,
  POST_582_REPORT_QUERY_KEYS,
  POST_583_REPORT_QUERY_KEYS,
  POST_584_REPORT_QUERY_KEYS,
  PRE_581_ACK_REPORT_QUERY_KEYS,
  PRE_583_REPORT_QUERY_KEYS,
  READ_ONLY_CHECK_QUERY,
  REPORT_QUERIES,
  REPORT_QUERY_KEYS,
  ROLLBACK_QUERY,
  SCHEMA_STATE_QUERY,
  TENANT_INVENTORY_QUERY,
  TARGET_MIGRATIONS,
  assertOperationalSafety,
  assertFrozenCutoverMigrationArtifacts,
  auditExitCode,
  buildAuditReport,
  buildMigrationState,
  carePathwayGovernanceSchemaModeFromState,
  collectLabOruReplayReadiness,
  criticalAlertSchemaModeFromState,
  parseArgs,
  resolveConnectionString,
  schemaModeFromState,
  verifyFrozenCutoverMigrationFiles,
} from '../../../scripts/audit-lab-oru-replay-readiness.mjs';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function collectReadiness(options) {
  return collectLabOruReplayReadiness({
    migrationArtifacts: FROZEN_CUTOVER_MIGRATION_ARTIFACTS,
    ...options,
  });
}

function schemaState(
  mode,
  criticalAlertMode = mode === 'pre_582_583' ? 'pre_581' : 'post_581',
  governanceMode = mode === 'post_582_583' ? 'post_584' : 'pre_584',
) {
  const criticalAlertGenerationColumnCount = criticalAlertMode === 'post_581' ? 6 : 0;
  const governanceState = governanceMode === 'post_584'
    ? {
        care_pathway_governance_lifecycle_column_count: 3,
        care_pathway_run_pin_column_count: 2,
        care_pathway_instance_pin_column_count: 3,
        care_pathway_governance_pin_constraint_count: 6,
        care_pathway_governance_pin_index_count: 6,
        care_pathway_governance_pin_trigger_count: 23,
        care_pathway_governance_revoked_trigger_count: 0,
      }
    : {
        care_pathway_governance_lifecycle_column_count: 0,
        care_pathway_run_pin_column_count: 0,
        care_pathway_instance_pin_column_count: 0,
        care_pathway_governance_pin_constraint_count: 0,
        care_pathway_governance_pin_index_count: 0,
        care_pathway_governance_pin_trigger_count:
          criticalAlertMode === 'post_581' ? 10 : 0,
        care_pathway_governance_revoked_trigger_count:
          criticalAlertMode === 'post_581' ? 1 : 0,
      };
  if (mode === 'pre_582_583') {
    return {
      oru_message_claim_table_exists: false,
      result_command_claim_table_exists: false,
      oru_result_claim_column_count: 0,
      pgcrypto_installed: true,
      astm_contract_column_count: 0,
      astm_result_link_column_count: 0,
      critical_alert_generation_column_count: criticalAlertGenerationColumnCount,
      critical_alert_ack_receipt_table_exists: criticalAlertMode === 'post_581',
      critical_alert_ack_receipt_column_count: criticalAlertMode === 'post_581' ? 27 : 0,
      critical_alert_ack_receipt_guard_trigger_count:
        criticalAlertMode === 'post_581' ? 6 : 0,
      critical_alert_ack_receipt_read_back_contract_column_count:
        criticalAlertMode === 'post_581' ? 1 : 0,
      ...governanceState,
    };
  }
  if (mode === 'post_582_pre_583') {
    return {
      oru_message_claim_table_exists: true,
      result_command_claim_table_exists: true,
      oru_result_claim_column_count: 2,
      pgcrypto_installed: true,
      astm_contract_column_count: 0,
      astm_result_link_column_count: 0,
      critical_alert_generation_column_count: criticalAlertGenerationColumnCount,
      critical_alert_ack_receipt_table_exists: criticalAlertMode === 'post_581',
      critical_alert_ack_receipt_column_count: criticalAlertMode === 'post_581' ? 27 : 0,
      critical_alert_ack_receipt_guard_trigger_count:
        criticalAlertMode === 'post_581' ? 6 : 0,
      critical_alert_ack_receipt_read_back_contract_column_count:
        criticalAlertMode === 'post_581' ? 1 : 0,
      ...governanceState,
    };
  }
  return {
    oru_message_claim_table_exists: true,
    result_command_claim_table_exists: true,
    oru_result_claim_column_count: 2,
    pgcrypto_installed: true,
    astm_contract_column_count: 8,
    astm_result_link_column_count: 2,
    critical_alert_generation_column_count: criticalAlertGenerationColumnCount,
    critical_alert_ack_receipt_table_exists: criticalAlertMode === 'post_581',
    critical_alert_ack_receipt_column_count: criticalAlertMode === 'post_581' ? 27 : 0,
    critical_alert_ack_receipt_guard_trigger_count:
      criticalAlertMode === 'post_581' ? 6 : 0,
    critical_alert_ack_receipt_read_back_contract_column_count:
      criticalAlertMode === 'post_581' ? 1 : 0,
    ...governanceState,
  };
}

function readOnlyState(overrides = {}) {
  return {
    transaction_read_only: 'on',
    transaction_isolation: 'repeatable read',
    server_version_num: '180000',
    pg_is_in_recovery: false,
    audit_user: 'migration_owner',
    audit_user_is_superuser: true,
    audit_user_bypasses_rls: false,
    ...overrides,
  };
}

function makeClient({
  mode = 'pre_582_583',
  criticalAlertMode = mode === 'pre_582_583' ? 'pre_581' : 'post_581',
  governanceMode = mode === 'post_582_583' ? 'post_584' : 'pre_584',
  state = readOnlyState(),
  tenants = [{ tenant_id: TENANT_A }],
  migrationRows = [],
  rowsByQuery = {},
} = {}) {
  const calls = [];
  return {
    calls,
    query: jest.fn(async (sql) => {
      calls.push(sql);
      if (sql === BEGIN_READ_ONLY_QUERY || sql === COMMIT_QUERY || sql === ROLLBACK_QUERY) {
        return { rows: [] };
      }
      if (sql === READ_ONLY_CHECK_QUERY) return { rows: [state] };
      if (sql === SCHEMA_STATE_QUERY) {
        return { rows: [schemaState(mode, criticalAlertMode, governanceMode)] };
      }
      if (sql === MIGRATION_TRACKER_QUERY) return { rows: migrationRows };
      if (sql === TENANT_INVENTORY_QUERY) return { rows: tenants };
      const key = Object.keys(REPORT_QUERIES).find(candidate => REPORT_QUERIES[candidate] === sql);
      if (key) return { rows: rowsByQuery[key] || [] };
      throw new Error(`Unexpected SQL in test: ${sql}`);
    }),
  };
}

describe('migrations 582-584 lab-ingest and governance readiness audit', () => {
  describe('operator and connection safety', () => {
    it('requires acknowledgement and an explicitly privileged audit DSN', () => {
      expect(() => assertOperationalSafety({
        acknowledged: false,
        env: { DATABASE_SUPERUSER_URL: 'postgres://owner' },
      })).toThrow(ACKNOWLEDGEMENT_FLAG);
      expect(() => assertOperationalSafety({
        acknowledged: true,
        env: { DATABASE_URL: 'postgres://ordinary' },
      })).toThrow('ordinary DATABASE_URL fallback is forbidden');
      expect(resolveConnectionString({
        DATABASE_URL: 'postgres://ordinary',
        LAB_ORU_AUDIT_DATABASE_URL: 'postgres://audit',
      })).toBe('postgres://audit');
    });

    it('has no tenant-filtered or empty-install mode and validates the sample bound', () => {
      expect(parseArgs([
        ACKNOWLEDGEMENT_FLAG,
        '--json',
        '--sample-limit=7',
      ])).toEqual({
        acknowledged: true,
        json: true,
        help: false,
        sampleLimit: 7,
      });
      expect(() => parseArgs([`--tenant=${TENANT_A}`])).toThrow('Unknown argument');
      expect(() => parseArgs(['--allow-empty-install'])).toThrow('Unknown argument');
      expect(() => parseArgs(['--sample-limit=0'])).toThrow('--sample-limit');
    });
  });

  describe('schema and release migration state', () => {
    it('pins the exact frozen 580-584 files and rejects inventory or byte tampering', async () => {
      await expect(verifyFrozenCutoverMigrationFiles()).resolves.toEqual(
        FROZEN_CUTOVER_MIGRATION_ARTIFACTS,
      );
      expect(() => assertFrozenCutoverMigrationArtifacts({
        ...FROZEN_CUTOVER_MIGRATION_ARTIFACTS,
        '585_unapproved_tail.sql': { bytes: 1, sha256: '00' },
      })).toThrow('artifact inventory mismatch');
      await expect(verifyFrozenCutoverMigrationFiles({
        readFileImpl: async path => {
          const contents = await readFile(path);
          return basename(path) === '584_care_pathway_governance_pinning.sql'
            ? Buffer.concat([contents, Buffer.from('\n')])
            : contents;
        },
      })).rejects.toThrow('artifact mismatch for 584_care_pathway_governance_pinning.sql');
    });

    it('accepts only fully pre, fully post-582, or fully post-583 schemas', () => {
      expect(schemaModeFromState(schemaState('pre_582_583'))).toBe('pre_582_583');
      expect(schemaModeFromState(schemaState('post_582_pre_583')))
        .toBe('post_582_pre_583');
      expect(schemaModeFromState(schemaState('post_582_583'))).toBe('post_582_583');
      expect(() => schemaModeFromState({
        ...schemaState('pre_582_583'),
        astm_contract_column_count: 1,
      })).toThrow('Partial migration-582/583 schema');
    });

    it('selects only a fully pre-581 or post-581 critical-alert schema', () => {
      expect(criticalAlertSchemaModeFromState(schemaState('pre_582_583', 'pre_581')))
        .toBe('pre_581');
      expect(criticalAlertSchemaModeFromState(schemaState('pre_582_583', 'post_581')))
        .toBe('post_581');
      expect(() => criticalAlertSchemaModeFromState({
        ...schemaState('pre_582_583', 'pre_581'),
        critical_alert_generation_column_count: 1,
      })).toThrow('Partial migration-581 critical-alert schema');
      expect(() => criticalAlertSchemaModeFromState({
        ...schemaState('pre_582_583', 'pre_581'),
        critical_alert_ack_receipt_table_exists: true,
      })).toThrow('Partial migration-581 critical-alert schema');
      expect(() => criticalAlertSchemaModeFromState({
        ...schemaState('pre_582_583', 'post_581'),
        critical_alert_ack_receipt_read_back_contract_column_count: 0,
      })).toThrow('Partial migration-581 critical-alert schema');
      expect(SCHEMA_STATE_QUERY).toContain("character_maximum_length = 160");
    });

    it('selects only a fully pre-584 or exact post-584 governance-pin schema', () => {
      expect(carePathwayGovernanceSchemaModeFromState(
        schemaState('pre_582_583', 'pre_581', 'pre_584'),
      )).toBe('pre_584');
      expect(carePathwayGovernanceSchemaModeFromState(
        schemaState('pre_582_583', 'post_581', 'pre_584'),
      )).toBe('pre_584');
      expect(carePathwayGovernanceSchemaModeFromState(
        schemaState('post_582_583', 'post_581', 'post_584'),
      )).toBe('post_584');
      expect(SCHEMA_STATE_QUERY).toContain(
        "'public.ux_care_pathway_instances_run_definition_pin'",
      );
      expect(SCHEMA_STATE_QUERY).toContain(
        "'trg_00_care_pathway_governance_serialization'",
      );
      expect(SCHEMA_STATE_QUERY).toContain(
        "'trg_clinical_timeline_pathway_creation_companion'",
      );
      expect(SCHEMA_STATE_QUERY).toContain(
        "'trg_clinical_audit_pathway_creation_companion'",
      );
      expect(SCHEMA_STATE_QUERY).toContain(
        "trigger.tgname = 'trg_users_pathway_governance_vote_actors'",
      );
      expect(() => carePathwayGovernanceSchemaModeFromState({
        ...schemaState('post_582_583', 'post_581', 'post_584'),
        care_pathway_instance_pin_column_count: 2,
      })).toThrow('Partial migration-584 governance-pin schema');
      expect(() => carePathwayGovernanceSchemaModeFromState({
        ...schemaState('post_582_583', 'post_581', 'post_584'),
        care_pathway_governance_revoked_trigger_count: 1,
      })).toThrow('Partial migration-584 governance-pin schema');
    });

    it('accepts the bundled 580-584 tail or a tracker-proven 580/581 prerequisite release', () => {
      const bundled = buildMigrationState({
        migrationFileNames: CUTOVER_MIGRATIONS,
        migrationRows: [],
        schemaMode: 'pre_582_583',
      });
      expect(bundled).toMatchObject({
        prerequisite_state: 'bundled_580_584_cutover',
        pending: CUTOVER_MIGRATIONS,
        expected_pending: CUTOVER_MIGRATIONS,
        ready: true,
      });

      const staged = buildMigrationState({
        migrationFileNames: CUTOVER_MIGRATIONS,
        migrationRows: CUTOVER_MIGRATIONS.slice(0, 2).map(name => ({ name })),
        schemaMode: 'pre_582_583',
      });
      expect(staged).toMatchObject({
        prerequisite_state: 'documented_580_581_prerequisite_release',
        pending: TARGET_MIGRATIONS,
        expected_pending: TARGET_MIGRATIONS,
        ready: true,
      });
    });

    it('rejects partial prerequisites and unrelated pending release migrations', () => {
      const partial = buildMigrationState({
        migrationFileNames: CUTOVER_MIGRATIONS,
        migrationRows: [{ name: CUTOVER_MIGRATIONS[0] }],
        schemaMode: 'pre_582_583',
      });
      expect(partial.ready).toBe(false);
      expect(partial.prerequisite_state).toBe('partial_prerequisite_state');

      const unrelated = buildMigrationState({
        migrationFileNames: ['579_unexpected.sql', ...CUTOVER_MIGRATIONS],
        migrationRows: [],
        schemaMode: 'pre_582_583',
      });
      expect(unrelated.ready).toBe(false);
      expect(unrelated.pending).toContain('579_unexpected.sql');
    });

    it('never allows the lab pair to silently omit core migration 584', () => {
      expect(() => buildMigrationState({
        migrationFileNames: CUTOVER_MIGRATIONS.slice(0, -1),
        migrationRows: [],
        schemaMode: 'pre_582_583',
      })).toThrow('Release migration inventory is missing 584_care_pathway_governance_pinning.sql');

      const postLabPreGovernance = buildMigrationState({
        migrationFileNames: CUTOVER_MIGRATIONS,
        migrationRows: CUTOVER_MIGRATIONS.slice(0, -1).map(name => ({ name })),
        schemaMode: 'post_582_583',
      });
      expect(postLabPreGovernance).toMatchObject({
        pending: ['584_care_pathway_governance_pinning.sql'],
        expected_pending: ['584_care_pathway_governance_pinning.sql'],
        exact_pending_set: true,
        target_tracker_coherent: true,
        combined_batch_state: false,
        ready: false,
      });

      const impossiblePreinstalledGovernance = buildMigrationState({
        migrationFileNames: CUTOVER_MIGRATIONS,
        migrationRows: [{ name: '584_care_pathway_governance_pinning.sql' }],
        schemaMode: 'pre_582_583',
      });
      expect(impossiblePreinstalledGovernance).toMatchObject({
        target_tracker_coherent: false,
        ready: false,
      });
    });
  });

  describe('SELECT-only evidence contracts', () => {
    it('defines every routed report query as SELECT-only SQL', () => {
      const routedKeys = [
        ...PRE_581_ACK_REPORT_QUERY_KEYS,
        ...POST_581_ACK_REPORT_QUERY_KEYS,
        ...REPORT_QUERY_KEYS,
        ...POST_582_REPORT_QUERY_KEYS,
        ...PRE_583_REPORT_QUERY_KEYS,
        ...POST_583_REPORT_QUERY_KEYS,
        ...POST_584_REPORT_QUERY_KEYS,
      ];
      expect(new Set(routedKeys)).toEqual(new Set(Object.keys(REPORT_QUERIES)));
      for (const sql of [
        TENANT_INVENTORY_QUERY,
        MIGRATION_TRACKER_QUERY,
        SCHEMA_STATE_QUERY,
        ...Object.values(REPORT_QUERIES),
      ]) {
        expect(sql.trim()).toMatch(/^(SELECT|WITH)\b/i);
        expect(sql).not.toMatch(
          /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|MERGE|COPY)\b/i,
        );
      }
    });

    it('branches the historical ACK-v2 proof without referencing post-581 columns early', () => {
      const pre = REPORT_QUERIES.historical_lab_ack_contract_pre_581;
      const post = REPORT_QUERIES.historical_lab_ack_contract_post_581;

      expect(pre).toContain("task.metadata->>'sla_instance_id'");
      expect(pre).toContain("task_metadata->>'sla_key' = 'critical_result_ack'");
      expect(pre).not.toContain('alert.acknowledgement_task_id');
      expect(pre).not.toContain('lab_critical_alert_acknowledgement_receipts');
      expect(post).toContain('task.id = alert.acknowledgement_task_id');
      expect(post).toContain("generation_metadata->>'acknowledgement_task_id'");
      expect(post).toContain('lab_critical_alert_acknowledgement_receipts');
      expect(post).toContain('receipt_ack_contract_version = 2');
      expect(post).toContain('receipt.id = ack_receipt.task_comment_id');
      expect(post).toContain('all_exact_comment_count = 1');
      expect(post).toContain('timeline.id = ack_receipt.timeline_event_id');
      expect(post).toContain('audit.id = ack_receipt.audit_event_id');
      expect(post).toContain('rail.superseded_at IS NOT NULL');
      expect(post).toContain('rail.sla_status = rail.receipt_sla_status_at_ack');
      for (const sql of [pre, post]) {
        expect(sql).toContain("task_metadata->>'ack_contract_version' = '2'");
        expect(sql).toContain("sla_metadata->>'ack_contract_version' = '2'");
        expect(sql).toContain("receipt.metadata->>'ack_contract_version' = '2'");
        expect(sql).toContain("timeline.payload->>'ack_contract_version' = '2'");
        expect(sql).toContain("audit.metadata->>'ack_contract_version' = '2'");
        expect(sql).toContain("audit.after_state->>'ack_contract_version' = '2'");
        expect(sql).toContain("'task_ack_alert_open_split'");
        expect(sql).toContain("'unversioned_or_weak_ack_contract'");
        expect(sql).toContain('acknowledgement_contract_fingerprint');
        expect(sql).toContain('rail.task_assigned_to_uid = rail.acknowledged_by');
        expect(sql).not.toContain('SELECT ranked.patient_uid');
        expect(sql).not.toContain('SELECT ranked.result_id');
      }
    });

    it('matches the migration-583 canonical ASTM replay namespace without raw IDs', () => {
      const sql = REPORT_QUERIES.astm_duplicate_fingerprints;
      expect(sql).toContain("STRING_AGG(");
      expect(sql).toContain('CHR(13)');
      expect(sql).toContain("'legacy:' || LOWER(NULLIF(BTRIM(message.analyzer_code), ''))");
      expect(sql).toContain("'<legacy-unresolved>'");
      expect(sql).toContain("'sha256'");
      expect(sql).toContain('receipt_evidence_fingerprints');
      expect(sql).not.toMatch(/\breceipt_ids\b|\blab_result_ids\b/);
    });

    it('keeps orderless ORU and ASTM sources as hard, fingerprinted blockers', () => {
      expect(REPORT_QUERIES.adoption_eligibility)
        .toContain("'patient_only_unlinked_source'");
      expect(REPORT_QUERIES.adoption_eligibility)
        .toContain("'legacy_local_order_namespace_and_analyte_contract_unproven'");
      expect(REPORT_QUERIES.oru_claim_source_readiness)
        .toContain("'oru_orderless_completed_claims'");
      expect(REPORT_QUERIES.oru_claim_source_readiness)
        .toContain('external_order_identity_fingerprint');
      expect(REPORT_QUERIES.astm_legacy_receipt_readiness)
        .toContain("'astm_orderless_clinically_unlinked_receipts'");
      expect(REPORT_QUERIES.astm_atomic_contract_readiness)
        .toContain("'astm_orderless_clinically_unlinked_receipts'");
    });

    it('blocks unsafe ORU order namespaces and unproved structured analyte links', () => {
      const sql = REPORT_QUERIES.oru_claim_source_readiness;
      expect(sql).toContain("'bare_numeric'");
      expect(sql).toContain("'^VHINV-[1-9][0-9]*$'");
      expect(sql).toContain("'malformed_or_unsupported_reserved'");
      expect(sql).toContain("'oru_bare_numeric_order_identity_claims'");
      expect(sql).toContain("'oru_malformed_reserved_order_identity_claims'");
      expect(sql).toContain("'oru_order_identity_disagreement_claims'");
      expect(sql).toContain("'oru_namespaced_source_contract_violations'");
      expect(sql).toContain("'oru_unattested_external_or_missing_local_links'");
      expect(sql).toContain('has_bare_numeric_order_identity');
      expect(sql).toContain('has_malformed_reserved_order_identity');
      expect(sql).toContain("'^(VHINV|VHBOOK)'");
      expect(sql).toContain('AND NOT classified.order_identity_disagrees');
      expect(sql).toContain('investigation.test_code');
      expect(sql).toContain("BTRIM(SPLIT_PART(classified.obr_test_identity, '^', 1))");
      expect(sql).toContain('BTRIM(investigation.test_code)');
      expect(sql).toContain('classified.obr_test_identity');
      expect(sql).toContain('classified.obx_test_codes');
      expect(sql).not.toContain("THEN 'positive_integer'");
      expect(sql).not.toMatch(/external_order_identity FROM 7\s*\)::numeric/);
    });

    it('follows one or many corrected generations to one exact current ACK rail', () => {
      const sql = REPORT_QUERIES.astm_atomic_contract_readiness;
      expect(sql).toContain('WITH RECURSIVE generation_chain AS');
      expect(sql).toContain('UNION ALL');
      expect(sql).toContain("'corrected_result_generation'");
      expect(sql).toContain("signoff.decision IN ('corrected', 'amended')");
      expect(sql).toContain('NOT successor.id = ANY(generation_chain.traversal_path)');
      expect(sql).toContain('current_generation_count');
      expect(sql).toContain('valid_current_rail_count');
      expect(sql).toContain("task.status IN ('open', 'blocked', 'overdue')");
      expect(sql).toContain("sla.metadata->>'completed_via' = 'task_ack'");
      expect(sql).toContain("receipt.metadata->>'via'");
      expect(sql).toContain("timeline.event_type =");
      expect(sql).toContain("audit.action_status = 'success'");
      expect(sql).toContain('generic_task_ack_alert_open_split');
      expect(sql).toContain("'astm_generic_task_ack_alert_open_splits'");
    });

    it('proves post-584 governance existence, typed pins, and exact creation evidence', () => {
      const sql = REPORT_QUERIES.care_pathway_governance_pinning_readiness;
      expect(sql).toContain('governance.workflow_definition_id = run.workflow_definition_id');
      expect(sql).toContain('run.pathway_governance_id IS NOT NULL');
      expect(sql).toContain('run.pathway_definition_checksum IS NOT NULL');
      expect(sql).toContain("'ungoverned_run_carries_pathway_pins'");
      expect(sql).toContain("'governed_run_requires_exactly_one_companion'");
      expect(sql).toContain('instance.definition_governance_id');
      expect(sql).toContain("creation.transition_key = 'pathway_instance_created'");
      expect(sql).toContain("creation.event_payload->>'idempotency_key'");
      expect(sql).toMatch(
        /jsonb_typeof\(\s*creation\.event_payload->'governance_id'/,
      );
      expect(sql).toMatch(
        /jsonb_typeof\(\s*creation\.event_payload->'definition_checksum'/,
      );
      expect(sql).toMatch(
        /jsonb_typeof\(\s*creation\.metadata->'command_fingerprint'/,
      );
      expect(sql).toContain("timeline.source_table = 'care_pathway_transition_events'");
      expect(sql).toContain('timeline.payload = creation.event_payload');
      expect(sql).toContain("audit.resource_table = 'care_pathway_transition_events'");
      expect(sql).toContain('audit.metadata = creation.metadata');
      expect(sql).toContain("'care_pathway_governance_approval_checksum_binding_violations'");
      expect(sql).toContain(
        "'care_pathway_governance_current_owner_eligibility_violations'",
      );
      expect(sql).toContain('clinical_owner.is_active');
      expect(sql).toContain('operational_owner.is_active');
      expect(sql).toContain("'care_pathway_governed_run_orphan_violations'");
      expect(sql).toContain("'care_pathway_runtime_definition_pin_violations'");
      expect(sql).toContain('pin_fingerprint');
      expect(sql).not.toContain('SELECT ranked.patient_uid');
      expect(sql).not.toContain('SELECT ranked.pathway_instance_id');
    });
  });

  describe('transactional collection', () => {
    it('runs the pre-583 query set and cannot green activation before clone proof', async () => {
      const client = makeClient();
      const report = await collectReadiness({
        client,
        migrationFileNames: CUTOVER_MIGRATIONS,
        generatedAt: '2026-07-19T00:00:00.000Z',
      });
      expect(client.calls).toEqual([
        BEGIN_READ_ONLY_QUERY,
        READ_ONLY_CHECK_QUERY,
        SCHEMA_STATE_QUERY,
        MIGRATION_TRACKER_QUERY,
        TENANT_INVENTORY_QUERY,
        ...PRE_581_ACK_REPORT_QUERY_KEYS.map(key => REPORT_QUERIES[key]),
        ...REPORT_QUERY_KEYS.map(key => REPORT_QUERIES[key]),
        ...PRE_583_REPORT_QUERY_KEYS.map(key => REPORT_QUERIES[key]),
        COMMIT_QUERY,
      ]);
      expect(report).toMatchObject({
        schema_mode: 'pre_582_583',
        clone_rehearsal_input_ready: true,
        migration_batch_ready: false,
        lab_ingest_cutover_ready: false,
        care_pathway_production_activation_ready: false,
        activation_ready: false,
        ready: false,
      });
      expect(auditExitCode(report)).toBe(BLOCKED_EXIT_CODE);
    });

    it('runs claimed-ORU and post-583 checks after the exact cutover is tracked', async () => {
      const migrationRows = CUTOVER_MIGRATIONS.map(name => ({ name }));
      const client = makeClient({ mode: 'post_582_583', migrationRows });
      const report = await collectReadiness({
        client,
        migrationFileNames: CUTOVER_MIGRATIONS,
      });
      expect(client.calls).toEqual([
        BEGIN_READ_ONLY_QUERY,
        READ_ONLY_CHECK_QUERY,
        SCHEMA_STATE_QUERY,
        MIGRATION_TRACKER_QUERY,
        TENANT_INVENTORY_QUERY,
        ...POST_581_ACK_REPORT_QUERY_KEYS.map(key => REPORT_QUERIES[key]),
        ...REPORT_QUERY_KEYS.map(key => REPORT_QUERIES[key]),
        ...POST_582_REPORT_QUERY_KEYS.map(key => REPORT_QUERIES[key]),
        ...POST_583_REPORT_QUERY_KEYS.map(key => REPORT_QUERIES[key]),
        ...POST_584_REPORT_QUERY_KEYS.map(key => REPORT_QUERIES[key]),
        COMMIT_QUERY,
      ]);
      expect(report).toMatchObject({
        schema_mode: 'post_582_583',
        ready: true,
        migration_batch_ready: true,
        lab_ingest_cutover_ready: true,
        care_pathway_production_activation_ready: false,
        activation_ready: false,
      });
      expect(auditExitCode(report)).toBe(0);
    });

    it('blocks the post-lab/pre-governance state and does not route post-584 SQL early', async () => {
      const migrationRows = CUTOVER_MIGRATIONS.slice(0, -1).map(name => ({ name }));
      const client = makeClient({
        mode: 'post_582_583',
        governanceMode: 'pre_584',
        migrationRows,
      });
      const report = await collectReadiness({
        client,
        migrationFileNames: CUTOVER_MIGRATIONS,
      });
      expect(client.calls).not.toContain(
        REPORT_QUERIES.care_pathway_governance_pinning_readiness,
      );
      expect(report).toMatchObject({
        care_pathway_governance_schema_mode: 'pre_584',
        migration_batch_ready: false,
        lab_ingest_cutover_ready: false,
        care_pathway_production_activation_ready: false,
        activation_ready: false,
        ready: false,
      });
      expect(report.global_blockers.fresh_production_clone_migration_584_proof_pending.count)
        .toBe(1);
    });

    it('rejects migration-584 tracker/schema branch disagreement', async () => {
      const client = makeClient({
        mode: 'post_582_583',
        governanceMode: 'post_584',
        migrationRows: CUTOVER_MIGRATIONS.slice(0, -1).map(name => ({ name })),
      });
      await expect(collectReadiness({
        client,
        migrationFileNames: CUTOVER_MIGRATIONS,
      })).rejects.toThrow('Migration-584 tracker and governance-pin schema disagree');
      expect(client.calls.at(-1)).toBe(ROLLBACK_QUERY);
    });

    it('rejects a hidden-by-RLS principal before schema, inventory, or report queries', async () => {
      const client = makeClient({
        state: readOnlyState({
          audit_user_is_superuser: false,
          audit_user_bypasses_rls: false,
        }),
      });
      await expect(collectReadiness({
        client,
        migrationFileNames: CUTOVER_MIGRATIONS,
      })).rejects.toThrow('not all-tenant privileged');
      expect(client.calls).toEqual([
        BEGIN_READ_ONLY_QUERY,
        READ_ONLY_CHECK_QUERY,
        ROLLBACK_QUERY,
      ]);
    });

    it('rejects a migration-581 tracker/schema branch mismatch', async () => {
      const client = makeClient({ criticalAlertMode: 'post_581' });
      await expect(collectReadiness({
        client,
        migrationFileNames: CUTOVER_MIGRATIONS,
      })).rejects.toThrow('Migration-581 tracker and critical-alert schema disagree');
      expect(client.calls).toEqual([
        BEGIN_READ_ONLY_QUERY,
        READ_ONLY_CHECK_QUERY,
        SCHEMA_STATE_QUERY,
        MIGRATION_TRACKER_QUERY,
        ROLLBACK_QUERY,
      ]);
    });

    it.each([
      'read committed',
      'serializable',
    ])('rejects transaction isolation %s', async (transactionIsolation) => {
      const client = makeClient({
        state: readOnlyState({ transaction_isolation: transactionIsolation }),
      });
      await expect(collectReadiness({
        client,
        migrationFileNames: CUTOVER_MIGRATIONS,
      })).rejects.toThrow('transaction isolation is not repeatable read');
      expect(client.calls).toEqual([
        BEGIN_READ_ONLY_QUERY,
        READ_ONLY_CHECK_QUERY,
        ROLLBACK_QUERY,
      ]);
    });

    it.each([
      { serverVersionNum: '170005', major: 17 },
      { serverVersionNum: '190000', major: 19 },
    ])('rejects PostgreSQL $major for the PostgreSQL 18 target gate', async ({
      serverVersionNum,
      major,
    }) => {
      const client = makeClient({
        state: readOnlyState({ server_version_num: serverVersionNum }),
      });
      await expect(collectReadiness({
        client,
        migrationFileNames: CUTOVER_MIGRATIONS,
      })).rejects.toThrow(
        `PostgreSQL major ${major} is unsupported; the production-clone/target gate requires PostgreSQL major 18`,
      );
      expect(client.calls).toEqual([
        BEGIN_READ_ONLY_QUERY,
        READ_ONLY_CHECK_QUERY,
        ROLLBACK_QUERY,
      ]);
    });

    it('accepts PostgreSQL 18 for the production-clone/target gate', async () => {
      const client = makeClient({
        state: readOnlyState({ server_version_num: '180004' }),
      });
      const report = await collectReadiness({
        client,
        migrationFileNames: CUTOVER_MIGRATIONS,
      });
      expect(report.snapshot.server_version_num).toBe('180004');
      expect(client.calls.at(-1)).toBe(COMMIT_QUERY);
    });

    it('rejects a recovery replica', async () => {
      const replica = makeClient({ state: readOnlyState({ pg_is_in_recovery: true }) });
      await expect(collectReadiness({
        client: replica,
        migrationFileNames: CUTOVER_MIGRATIONS,
      })).rejects.toThrow('recovery replica');
    });

    it('unconditionally rejects a zero-tenant inventory', async () => {
      const empty = makeClient({ tenants: [] });
      await expect(collectReadiness({
        client: empty,
        migrationFileNames: CUTOVER_MIGRATIONS,
      })).rejects.toThrow('zero tenants');
      expect(empty.calls.at(-1)).toBe(ROLLBACK_QUERY);
    });
  });

  describe('tenant grouped report', () => {
    it('makes historical split or unversioned ACK evidence a bounded global blocker', () => {
      const migrationState = buildMigrationState({
        migrationFileNames: CUTOVER_MIGRATIONS,
        migrationRows: [],
        schemaMode: 'pre_582_583',
      });
      const report = buildAuditReport({
        tenantRows: [{ tenant_id: TENANT_A }],
        schemaState: schemaState('pre_582_583', 'pre_581'),
        schemaMode: 'pre_582_583',
        criticalAlertSchemaMode: 'pre_581',
        migrationState,
        sampleLimit: 1,
        rowsByQuery: {
          historical_lab_ack_contract_pre_581: [{
            tenant_id: TENANT_A,
            issue_key: 'historical_lab_ack_contract_violations',
            total_count: 2,
            sample_rank: 1,
            contract_branch: 'pre_581',
            acknowledgement_contract_fingerprint: 'ack-fingerprint',
            blocking_reasons: ['unversioned_or_weak_ack_contract'],
          }],
        },
      });

      expect(report.clone_rehearsal_input_ready).toBe(false);
      expect(report.schema_version).toBe(5);
      expect(report.global_blockers.historical_lab_ack_contract_violations)
        .toMatchObject({
          count: 2,
          schema_branch: 'pre_581',
          samples: [{
            tenant_id: TENANT_A,
            acknowledgement_contract_fingerprint: 'ack-fingerprint',
          }],
        });
    });

    it('blocks clinically unlinked ORU and ASTM rows without emitting raw clinical IDs', () => {
      const migrationState = buildMigrationState({
        migrationFileNames: CUTOVER_MIGRATIONS,
        migrationRows: [],
        schemaMode: 'pre_582_583',
      });
      const report = buildAuditReport({
        tenantRows: [{ tenant_id: TENANT_A }],
        schemaState: schemaState('pre_582_583'),
        schemaMode: 'pre_582_583',
        migrationState,
        rowsByQuery: {
          adoption_eligibility: [{
            tenant_id: TENANT_A,
            structurally_eligible: false,
            adoption_bucket: 'patient_only_unlinked',
            total_count: 1,
            sample_rank: 1,
            message_id_fingerprint: 'oru-fingerprint',
            blocking_reasons: ['patient_only_unlinked_source'],
          }],
          astm_legacy_receipt_readiness: [{
            tenant_id: TENANT_A,
            issue_key: 'astm_orderless_clinically_unlinked_receipts',
            total_count: 1,
            sample_rank: 1,
            receipt_fingerprint: 'astm-fingerprint',
            blocking_reasons: ['specimen_has_no_local_booking_or_investigation_source'],
          }],
        },
      });
      expect(report.clone_rehearsal_input_ready).toBe(false);
      expect(report.tenants[0].blockers.patient_only_unlinked_message_groups.count).toBe(1);
      expect(
        report.tenants[0].blockers.astm_orderless_clinically_unlinked_receipts.count,
      ).toBe(1);
      expect(JSON.stringify(report)).not.toMatch(/patient_uid|raw_obx|raw_message|lab_result_ids/);
    });

    it('routes legacy-unproved and post-582 namespace/analyte findings into activation blockers', () => {
      const migrationRows = CUTOVER_MIGRATIONS.map(name => ({ name }));
      const migrationState = buildMigrationState({
        migrationFileNames: CUTOVER_MIGRATIONS,
        migrationRows,
        schemaMode: 'post_582_583',
        governanceSchemaMode: 'post_584',
      });
      const report = buildAuditReport({
        tenantRows: [{ tenant_id: TENANT_A }],
        schemaState: schemaState('post_582_583'),
        schemaMode: 'post_582_583',
        criticalAlertSchemaMode: 'post_581',
        migrationState,
        rowsByQuery: {
          adoption_eligibility: [{
            tenant_id: TENANT_A,
            structurally_eligible: false,
            adoption_bucket: 'legacy_local_order_contract_unproven',
            total_count: 1,
            sample_rank: 1,
            message_id_fingerprint: 'legacy-order-fingerprint',
            blocking_reasons: [
              'legacy_local_order_namespace_and_analyte_contract_unproven',
            ],
          }],
          oru_claim_source_readiness: [{
            tenant_id: TENANT_A,
            issue_key: 'oru_bare_numeric_order_identity_claims',
            total_count: 2,
            sample_rank: 1,
            claim_fingerprint: 'bare-order-fingerprint',
            blocking_reasons: [
              'bare_numeric_order_identity_has_no_attested_local_namespace',
            ],
          }, {
            tenant_id: TENANT_A,
            issue_key: 'oru_namespaced_source_contract_violations',
            total_count: 1,
            sample_rank: 1,
            claim_fingerprint: 'analyte-fingerprint',
            blocking_reasons: [
              'vhinv_source_or_structured_order_analyte_contract_is_not_exact',
            ],
          }],
        },
      });

      expect(report.ready).toBe(false);
      expect(report.activation_ready).toBe(false);
      expect(report.lab_ingest_cutover_ready).toBe(false);
      expect(report.care_pathway_production_activation_ready).toBe(false);
      expect(report.clone_rehearsal_input_ready).toBe(false);
      expect(report.totals).toMatchObject({
        legacy_local_order_contract_unproven_message_groups: 1,
        oru_bare_numeric_order_identity_claims: 2,
        oru_namespaced_source_contract_violations: 1,
      });
      expect(report.tenants[0].blocking_finding_count).toBe(4);
    });

    it('routes bounded post-584 governance findings without raw runtime identities', () => {
      const migrationRows = CUTOVER_MIGRATIONS.map(name => ({ name }));
      const migrationState = buildMigrationState({
        migrationFileNames: CUTOVER_MIGRATIONS,
        migrationRows,
        schemaMode: 'post_582_583',
        governanceSchemaMode: 'post_584',
      });
      const report = buildAuditReport({
        tenantRows: [{ tenant_id: TENANT_A }],
        schemaState: schemaState('post_582_583'),
        schemaMode: 'post_582_583',
        criticalAlertSchemaMode: 'post_581',
        governanceSchemaMode: 'post_584',
        migrationState,
        rowsByQuery: {
          care_pathway_governance_pinning_readiness: [{
            tenant_id: TENANT_A,
            issue_key: 'care_pathway_governed_run_orphan_violations',
            total_count: 1,
            sample_rank: 1,
            pin_fingerprint: 'governance-run-fingerprint',
            governance_status: 'approved',
            companion_count: 0,
            creation_count: 0,
            exact_creation_count: 0,
            blocking_reasons: ['governed_run_requires_exactly_one_companion'],
          }, {
            tenant_id: TENANT_A,
            issue_key: 'care_pathway_governance_current_owner_eligibility_violations',
            total_count: 1,
            sample_rank: 1,
            pin_fingerprint: 'governance-owner-fingerprint',
            governance_status: 'approved',
            companion_count: null,
            creation_count: null,
            exact_creation_count: null,
            blocking_reasons: [
              'approved_governance_clinical_owner_is_not_active_non_patient',
            ],
          }],
        },
      });

      expect(report.ready).toBe(false);
      expect(report.activation_ready).toBe(false);
      expect(report.lab_ingest_cutover_ready).toBe(false);
      expect(report.care_pathway_production_activation_ready).toBe(false);
      expect(report.totals.care_pathway_governed_run_orphan_violations).toBe(1);
      expect(report.totals.care_pathway_governance_current_owner_eligibility_violations)
        .toBe(1);
      expect(report.tenants[0].blockers.care_pathway_governed_run_orphan_violations)
        .toMatchObject({
          count: 1,
          samples: [{ pin_fingerprint: 'governance-run-fingerprint' }],
        });
      expect(JSON.stringify(report)).not.toMatch(
        /workflow_run_id|pathway_instance_id|patient_uid|definition_governance_id/,
      );
    });
  });
});
