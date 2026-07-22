import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { jest } from '@jest/globals';

import { getClinicalAccountabilityRoleCodes } from '../../config/rolePolicyGraph.js';
import {
  ACKNOWLEDGEMENT_FLAG,
  BEGIN_READ_ONLY_QUERY,
  BLOCKED_EXIT_CODE,
  CLINICAL_ACCOUNTABILITY_ROLE_CODES,
  COMMIT_QUERY,
  LEGACY_EMPTY_SLA_OWNER_RULE_CODES,
  MIGRATION_TRACKER_QUERY,
  OWNER_ISSUE_KEYS,
  OWNER_REPORT_QUERY,
  OWNER_INTEGRITY_MIGRATION,
  PREREQUISITE_MIGRATIONS,
  READ_ONLY_CHECK_QUERY,
  ROLLBACK_QUERY,
  SCHEMA_STATE_QUERY,
  TARGET_MIGRATION,
  TENANT_INVENTORY_QUERY,
  assertOperationalSafety,
  auditExitCode,
  buildMigrationState,
  buildOwnerRoutingReport,
  collectOwnerRoutingReadiness,
  ownerSchemaModeFromState,
  parseArgs,
  resolveConnectionString,
} from '../../../scripts/audit-care-pathway-owner-routing-readiness.mjs';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GENERATED_AT = '2026-07-21T00:00:00.000Z';
const OWNER_ACCEPTANCE_MIGRATION_SQL = readFileSync(
  new URL('../../migrations/586_care_pathway_owner_acceptance.sql', import.meta.url),
  'utf8',
).replaceAll('\r', '');

function migrationFunctionBodyMd5(functionName) {
  const declaration = `CREATE OR REPLACE FUNCTION ${functionName}(`;
  const declarationStart = OWNER_ACCEPTANCE_MIGRATION_SQL.indexOf(declaration);
  const bodyStart = OWNER_ACCEPTANCE_MIGRATION_SQL.indexOf('AS $$', declarationStart);
  const bodyEnd = OWNER_ACCEPTANCE_MIGRATION_SQL.indexOf('$$;', bodyStart);
  if (declarationStart < 0 || bodyStart < 0 || bodyEnd < 0) {
    throw new Error(`Migration function body not found: ${functionName}`);
  }
  return createHash('md5')
    .update(OWNER_ACCEPTANCE_MIGRATION_SQL.slice(bodyStart + 5, bodyEnd))
    .digest('hex');
}

function primaryState(overrides = {}) {
  return {
    transaction_read_only: 'on',
    transaction_isolation: 'repeatable read',
    pg_is_in_recovery: false,
    audit_user: 'care_pathway_owner_auditor',
    audit_user_is_superuser: true,
    audit_user_bypasses_rls: false,
    ...overrides,
  };
}

function pre585Schema(overrides = {}) {
  return {
    pathway_instance_table_exists: true,
    tasks_table_exists: true,
    workflow_sla_table_exists: true,
    workflow_steps_table_exists: true,
    route_role_function_exists: true,
    governance_pin_function_exists: true,
    prerequisite_column_count: 29,
    owner_function_count: 0,
    owner_trigger_count: 0,
    deferred_owner_fk_count: 0,
    patient_access_audit_source_is_pre_585: true,
    patient_access_audit_source_is_post_585: false,
    patient_access_audit_source_is_post_586: false,
    tasks_task_kind_is_absent_pre_586: false,
    tasks_task_kind_is_pre_586: true,
    tasks_task_kind_is_post_586: false,
    actionable_owner_function_is_pre_586: false,
    actionable_owner_function_is_post_586: false,
    owner_acceptance_columns_are_post_586: false,
    owner_acceptance_fk_is_post_586: false,
    owner_acceptance_check_is_post_586: false,
    owner_acceptance_indexes_are_post_586: false,
    owner_acceptance_functions_are_post_586: false,
    owner_acceptance_triggers_are_post_586: false,
    owner_acceptance_artifact_presence_count: 0,
    ...overrides,
  };
}

function post585Schema(overrides = {}) {
  return pre585Schema({
    owner_function_count: 12,
    owner_trigger_count: 7,
    deferred_owner_fk_count: 1,
    patient_access_audit_source_is_pre_585: false,
    patient_access_audit_source_is_post_585: true,
    actionable_owner_function_is_pre_586: true,
    ...overrides,
  });
}

function post586Schema(overrides = {}) {
  return post585Schema({
    patient_access_audit_source_is_post_585: false,
    patient_access_audit_source_is_post_586: true,
    tasks_task_kind_is_pre_586: false,
    tasks_task_kind_is_post_586: true,
    actionable_owner_function_is_pre_586: false,
    actionable_owner_function_is_post_586: true,
    owner_acceptance_columns_are_post_586: true,
    owner_acceptance_fk_is_post_586: true,
    owner_acceptance_check_is_post_586: true,
    owner_acceptance_indexes_are_post_586: true,
    owner_acceptance_functions_are_post_586: true,
    owner_acceptance_triggers_are_post_586: true,
    owner_acceptance_artifact_presence_count: 17,
    ...overrides,
  });
}

function migrationRows({
  ownerApplied = false,
  targetApplied = false,
  omitPrerequisite = null,
} = {}) {
  const rows = PREREQUISITE_MIGRATIONS
    .filter(name => name !== omitPrerequisite)
    .map(name => ({ name }));
  if (ownerApplied) rows.push({ name: OWNER_INTEGRITY_MIGRATION });
  if (targetApplied) rows.push({ name: TARGET_MIGRATION });
  return rows;
}

function makeClient({
  state = primaryState(),
  schemaState = pre585Schema(),
  trackedRows = migrationRows(),
  tenantRows = [{ tenant_id: TENANT_A }],
  ownerRows = [],
} = {}) {
  return {
    query: jest.fn(async (sql) => {
      if (sql === READ_ONLY_CHECK_QUERY) return { rows: [state] };
      if (sql === SCHEMA_STATE_QUERY) return { rows: [schemaState] };
      if (sql === MIGRATION_TRACKER_QUERY) return { rows: trackedRows };
      if (sql === TENANT_INVENTORY_QUERY) return { rows: tenantRows };
      if (sql === OWNER_REPORT_QUERY) return { rows: ownerRows };
      return { rows: [] };
    }),
  };
}

describe('care-pathway exclusive owner-routing readiness audit', () => {
  describe('operator safety', () => {
    it('requires an acknowledgement and a dedicated or privileged connection', () => {
      expect(() => assertOperationalSafety({
        acknowledged: false,
        env: { DATABASE_SUPERUSER_URL: 'postgres://owner' },
      })).toThrow(ACKNOWLEDGEMENT_FLAG);
      expect(() => assertOperationalSafety({
        acknowledged: true,
        env: { DATABASE_URL: 'postgres://ordinary' },
      })).toThrow('ordinary DATABASE_URL fallback is forbidden');
      expect(resolveConnectionString({ DATABASE_URL: 'postgres://ordinary' })).toBeNull();
      expect(resolveConnectionString({
        CARE_PATHWAY_OWNER_AUDIT_DATABASE_URL: 'postgres://auditor',
        DATABASE_SUPERUSER_URL: 'postgres://owner',
      })).toBe('postgres://auditor');
    });

    it('accepts only the bounded all-tenant CLI surface', () => {
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
      expect(() => parseArgs(['--tenant', TENANT_A])).toThrow('Unknown argument');
      expect(() => parseArgs(['--sample-limit=0'])).toThrow('--sample-limit');
    });
  });

  describe('schema and tracker modes', () => {
    it('distinguishes missing prerequisites, both exact migration boundaries, and partial states', () => {
      expect(ownerSchemaModeFromState(pre585Schema({
        prerequisite_column_count: 28,
      }))).toBe('prerequisites_missing_or_partial');
      expect(ownerSchemaModeFromState(pre585Schema())).toBe('pre_585');
      expect(ownerSchemaModeFromState(pre585Schema({
        tasks_task_kind_is_absent_pre_586: true,
        tasks_task_kind_is_pre_586: false,
      }))).toBe('pre_585');
      expect(ownerSchemaModeFromState(post585Schema())).toBe('post_585_pre_586');
      expect(ownerSchemaModeFromState(post586Schema())).toBe('post_586');
      expect(ownerSchemaModeFromState(pre585Schema({
        patient_access_audit_source_is_pre_585: false,
      }))).toBe('partial_585');
      expect(ownerSchemaModeFromState(post585Schema({
        patient_access_audit_source_is_pre_585: true,
        patient_access_audit_source_is_post_585: false,
      }))).toBe('partial_585');
      expect(ownerSchemaModeFromState(post585Schema({
        patient_access_audit_source_is_post_586: true,
      }))).toBe('partial_586');
      expect(ownerSchemaModeFromState(pre585Schema({
        owner_function_count: 11,
        owner_trigger_count: 7,
        deferred_owner_fk_count: 1,
      }))).toBe('partial_585');
    });

    it.each([
      'owner_acceptance_columns_are_post_586',
      'owner_acceptance_fk_is_post_586',
      'owner_acceptance_check_is_post_586',
      'owner_acceptance_indexes_are_post_586',
      'owner_acceptance_functions_are_post_586',
      'owner_acceptance_triggers_are_post_586',
      'tasks_task_kind_is_post_586',
      'actionable_owner_function_is_post_586',
      'patient_access_audit_source_is_post_586',
    ])('fails a post-586 schema with a missing or mutated %s artifact', (field) => {
      expect(ownerSchemaModeFromState(post586Schema({ [field]: false })))
        .toBe('partial_586');
    });

    it('requires the exact complete named owner-acceptance artifact set', () => {
      expect(ownerSchemaModeFromState(post586Schema({
        owner_acceptance_artifact_presence_count: 16,
      }))).toBe('partial_586');
      expect(ownerSchemaModeFromState(post586Schema({
        owner_acceptance_artifact_presence_count: 18,
      }))).toBe('partial_586');
    });

    it('requires tracker state to agree with the exact schema branch', () => {
      expect(buildMigrationState({
        migrationRows: migrationRows(),
        schemaMode: 'pre_585',
      })).toMatchObject({
        prerequisites_complete: true,
        target_applied: false,
        tracker_coherent: true,
      });
      expect(buildMigrationState({
        migrationRows: migrationRows({ ownerApplied: true }),
        schemaMode: 'post_585_pre_586',
      })).toMatchObject({
        prerequisites_complete: true,
        owner_integrity_applied: true,
        target_applied: false,
        tracker_coherent: true,
      });
      expect(buildMigrationState({
        migrationRows: migrationRows({
          ownerApplied: true,
          targetApplied: true,
          omitPrerequisite: PREREQUISITE_MIGRATIONS[2],
        }),
        schemaMode: 'post_586',
      }).tracker_coherent).toBe(false);
      expect(buildMigrationState({
        migrationRows: migrationRows({ ownerApplied: true, targetApplied: true }),
        schemaMode: 'pre_585',
      }).tracker_coherent).toBe(false);
      expect(buildMigrationState({
        migrationRows: migrationRows({ ownerApplied: true, targetApplied: true }),
        schemaMode: 'post_586',
      })).toMatchObject({
        owner_integrity_applied: true,
        target_applied: true,
        tracker_coherent: true,
      });
      expect(buildMigrationState({
        migrationRows: migrationRows({ targetApplied: true }),
        schemaMode: 'post_586',
      }).tracker_coherent).toBe(false);
    });
  });

  describe('migration-585 predicate parity and evidence safety', () => {
    it('requires the exact pre-585, post-585, and full post-586 patient-access source whitelists', () => {
      expect(SCHEMA_STATE_QUERY).toContain(
        "'unknown'::character varying])::text[]))$$",
      );
      expect(SCHEMA_STATE_QUERY).toContain(
        "'unknown'::character varying, 'care_pathway_owner'::character varying])::text[]))$$",
      );
      expect(SCHEMA_STATE_QUERY).toContain(
        "'care_pathway_owner'::character varying, 'care_pathway_transfer_recipient'::character varying, 'care_pathway_transfer_decline_recipient'::character varying, 'care_pathway_role_queue_claimant'::character varying])::text[]))$$",
      );
      expect(SCHEMA_STATE_QUERY).toContain('constraint_state.convalidated');
      expect(SCHEMA_STATE_QUERY).toContain('NOT constraint_state.connoinherit');
      expect(SCHEMA_STATE_QUERY).toContain(
        'patient_access_audit_source_is_post_585',
      );
      expect(SCHEMA_STATE_QUERY).toContain(
        'patient_access_audit_source_is_post_586',
      );
      expect(SCHEMA_STATE_QUERY).not.toMatch(
        /pg_get_expr\([\s\S]*?\)\s+(?:LIKE|ILIKE)\s+[\s\S]*care_pathway_(?:owner|transfer_recipient|transfer_decline_recipient|role_queue_claimant)/i,
      );
    });

    it('pins the complete migration-586 schema tuple without fuzzy catalog matching', () => {
      for (const artifact of [
        'tasks_task_kind_is_absent_pre_586',
        'tasks_task_kind_is_post_586',
        'actionable_owner_function_is_post_586',
        'owner_acceptance_columns_are_post_586',
        'owner_acceptance_fk_is_post_586',
        'owner_acceptance_check_is_post_586',
        'owner_acceptance_indexes_are_post_586',
        'owner_acceptance_functions_are_post_586',
        'owner_acceptance_triggers_are_post_586',
        'owner_acceptance_artifact_presence_count',
      ]) expect(SCHEMA_STATE_QUERY).toContain(artifact);
      for (const objectName of [
        'fk_care_handoff_accepted_by_tenant',
        'care_handoff_covering_transfer_check',
        'ux_care_handoff_one_live_covering_transfer',
        'idx_care_handoff_covering_recipient',
        'idx_care_handoff_accepted_by',
        'care_pathway_assert_covering_transfer',
        'care_pathway_block_covering_transfer_mutation',
        'care_pathway_covering_transfer_row_constraint',
        'care_pathway_covering_transfer_pathway_dependency',
        'care_pathway_covering_transfer_task_dependency',
        'trg_care_handoff_covering_transfer_immutable',
        'trg_care_handoff_covering_transfer_invariant',
        'trg_care_pathway_instances_covering_transfer_dependency',
        'trg_tasks_covering_transfer_dependency',
      ]) expect(SCHEMA_STATE_QUERY).toContain(objectName);
      expect(SCHEMA_STATE_QUERY).toContain('owner_acceptance_artifact_presence_count');
      expect(SCHEMA_STATE_QUERY).not.toMatch(/\b(?:LIKE|ILIKE)\b/i);
    });

    it('pins the readiness function hashes to the exact migration-586 bodies', () => {
      for (const functionName of [
        'care_pathway_assert_actionable_task_owner',
        'care_pathway_assert_covering_transfer',
        'care_pathway_block_covering_transfer_mutation',
        'care_pathway_covering_transfer_row_constraint',
        'care_pathway_covering_transfer_pathway_dependency',
        'care_pathway_covering_transfer_task_dependency',
      ]) {
        expect(SCHEMA_STATE_QUERY).toContain(
          migrationFunctionBodyMd5(functionName),
        );
      }
    });

    it('uses the canonical role-policy clinical group for named accountability', () => {
      expect([...CLINICAL_ACCOUNTABILITY_ROLE_CODES].sort()).toEqual(
        [...getClinicalAccountabilityRoleCodes()].sort(),
      );
      expect(CLINICAL_ACCOUNTABILITY_ROLE_CODES).toHaveLength(32);
      expect(CLINICAL_ACCOUNTABILITY_ROLE_CODES).toContain('RADIOLOGIST');
      expect(CLINICAL_ACCOUNTABILITY_ROLE_CODES).not.toContain('ADMIN');
      expect(CLINICAL_ACCOUNTABILITY_ROLE_CODES).not.toContain('SUPER_ADMIN');
    });

    it('classifies pathway UID owners by clinical accountability and typed-rail UID owners by route policy', () => {
      const ownerViabilityCase = OWNER_REPORT_QUERY.match(
        /CASE\s+WHEN guarded\.assigned_to_uid IS NOT NULL THEN[\s\S]*?END AS has_valid_exclusive_owner/,
      )?.[0];

      expect(ownerViabilityCase).toBeDefined();
      expect(ownerViabilityCase).toMatch(
        /guarded\.is_pathway_task\s+AND UPPER\(BTRIM\(owner\.role\)\) = ANY\([\s\S]*?'RADIOLOGIST'/,
      );
      expect(ownerViabilityCase).toMatch(
        /NOT guarded\.is_pathway_task\s+AND care_pathway_is_route_actionable_human_role\(\s*owner\.role,\s*guarded\.obligation_rule_code/,
      );
    });

    it('allows legacy empty SLA owners only for critical-result and mortuary rails', () => {
      expect(LEGACY_EMPTY_SLA_OWNER_RULE_CODES).toEqual([
        'critical_result_ack',
        'mortuary_unclaimed_body',
      ]);
      expect(LEGACY_EMPTY_SLA_OWNER_RULE_CODES).not.toContain(
        'cold_chain_excursion_ack',
      );

      const slaOwnerCase = OWNER_REPORT_QUERY.match(
        /CASE\s+WHEN guarded\.sla_id IS NULL THEN[\s\S]*?END AS matches_sla_owner/,
      )?.[0];
      const emptyOwnerBranch = slaOwnerCase?.match(
        /WHEN guarded\.sla_owner_uid IS NULL[\s\S]*?= 0\s+THEN[\s\S]*?(?=WHEN guarded\.sla_owner_uid IS NOT NULL)/,
      )?.[0];

      expect(emptyOwnerBranch).toBeDefined();
      expect(emptyOwnerBranch).toContain('NOT guarded.is_pathway_task');
      expect(emptyOwnerBranch).toContain('guarded.obligation_rule_code IN');
      expect(emptyOwnerBranch).toContain("'critical_result_ack'");
      expect(emptyOwnerBranch).toContain("'mortuary_unclaimed_body'");
      expect(emptyOwnerBranch).not.toContain("'cold_chain_excursion_ack'");
    });

    it('uses the same scoped, exclusive CASE semantics as migration 585', () => {
      const sql = OWNER_REPORT_QUERY;
      expect(sql).toContain("task.status IN ('open', 'in_progress', 'blocked', 'overdue')");
      expect(sql).toContain(
        "task.sla_completion_semantics IN ('acknowledgement', 'domain_evidence')",
      );
      for (const ruleCode of [
        'critical_result_ack',
        'cold_chain_excursion_ack',
        'mortuary_unclaimed_body',
      ]) expect(sql).toContain(`'${ruleCode}'`);
      expect(sql).toContain("sla.status IN ('active', 'breached', 'escalated')");
      expect(sql).toContain('WHEN guarded.assigned_to_uid IS NOT NULL THEN');
      expect(sql).toContain('guarded.assigned_to_role IS NULL');
      expect(sql).toContain("LOWER(COALESCE(owner.status, '')) = 'active'");
      expect(sql).toContain('owner.is_deleted IS FALSE');
      expect(sql).toContain('owner.deleted_at IS NULL');
      expect(sql).toContain('care_pathway_is_route_actionable_human_role(');
      expect(sql).toContain('WHEN guarded.pathway_owner_uid IS NOT NULL THEN');
      expect(sql).toContain(
        'guarded.assigned_to_uid IS NOT DISTINCT FROM guarded.pathway_owner_uid',
      );
      expect(sql).toContain("NULLIF(BTRIM(step.assigned_role), '')");
      expect(sql).toContain("NULLIF(BTRIM(pathway.accountable_role), '')");
      expect(sql).toContain('UPPER(BTRIM(guarded.resolved_stage_role))');
      expect(sql).toContain('IS NOT DISTINCT FROM');
      expect(sql).toContain("COALESCE(NULLIF(BTRIM(sla.rule_code), ''), 'care_pathway_stage')");
      expect(sql).toContain('CARDINALITY(');
      expect(sql).toContain(') = 1');
      expect(sql).toContain('guarded.sla_owner_roles[1]');
      expect(sql).toContain('= ANY(');
      expect(sql).toContain('FROM UNNEST(');
      expect(sql).toContain("'BLOOD_BANK_TECHNICIAN'");
      expect(sql).not.toMatch(
        /UPPER\(BTRIM\(owner\.role\)\) = ANY\([\s\S]*?'ADMIN'/,
      );
    });

    it('reports every preflight class with bounded non-PHI fingerprints', () => {
      for (const issueKey of OWNER_ISSUE_KEYS) {
        expect(OWNER_REPORT_QUERY).toContain(`'${issueKey}'`);
      }
      expect(OWNER_REPORT_QUERY).toContain('COUNT(*) OVER');
      expect(OWNER_REPORT_QUERY).toContain('ROW_NUMBER() OVER');
      expect(OWNER_REPORT_QUERY).toContain(
        'SUBSTRING(MD5(ranked.evidence_seed) FROM 1 FOR 16)',
      );
      expect(OWNER_REPORT_QUERY).toContain('ranked.sample_rank <= $1::integer');
      expect(OWNER_REPORT_QUERY.trim()).toMatch(/^WITH\b/i);
      expect(OWNER_REPORT_QUERY).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|MERGE|COPY|CALL|DO|LOCK)\b/i,
      );
      expect(OWNER_REPORT_QUERY).not.toMatch(/\bFOR\s+(UPDATE|SHARE)\b/i);
      expect(OWNER_REPORT_QUERY).not.toMatch(/SELECT\s+(?:\w+\.)?\*/i);
      expect(OWNER_REPORT_QUERY).not.toMatch(
        /SELECT[\s\S]*\b(task_id|patient_uid|assigned_to_uid|pathway_owner_uid)\b[\s,]*\n?\s*FROM ranked/i,
      );
    });
  });

  describe('deterministic report', () => {
    it('keeps all tenants, strips raw identifiers, and never marks activation ready', () => {
      const ownerRows = [
        {
          tenant_id: TENANT_B,
          issue_key: 'task_owner_dual_assignment',
          total_count: '2',
          sample_rank: 2,
          evidence_fingerprint: 'bbbbbbbbbbbbbbbb',
          task_status: 'open',
          task_id: 92,
          assigned_to_uid: 'raw-owner-never-emit',
        },
        {
          tenant_id: TENANT_B,
          issue_key: 'task_owner_dual_assignment',
          total_count: 2n,
          sample_rank: 1,
          evidence_fingerprint: 'aaaaaaaaaaaaaaaa',
          task_status: 'open',
          patient_uid: 'raw-patient-never-emit',
        },
      ];
      const migrationState = buildMigrationState({
        migrationRows: migrationRows(),
        schemaMode: 'pre_585',
      });
      const args = {
        tenantRows: [{ tenant_id: TENANT_B }, { tenant_id: TENANT_A }],
        ownerRows,
        readOnlyState: primaryState(),
        schemaState: pre585Schema(),
        schemaMode: 'pre_585',
        migrationState,
        sampleLimit: 2,
        generatedAt: GENERATED_AT,
      };
      const report = buildOwnerRoutingReport(args);
      const reversed = buildOwnerRoutingReport({
        ...args,
        tenantRows: [...args.tenantRows].reverse(),
        ownerRows: [...ownerRows].reverse(),
      });

      expect(reversed).toEqual(report);
      expect(report.tenants.map(tenant => tenant.tenant_id)).toEqual([TENANT_A, TENANT_B]);
      expect(report.tenants[1].blockers.task_owner_dual_assignment).toEqual({
        count: 2,
        samples: [
          { evidence_fingerprint: 'aaaaaaaaaaaaaaaa', task_status: 'open' },
          { evidence_fingerprint: 'bbbbbbbbbbbbbbbb', task_status: 'open' },
        ],
      });
      expect(report.owner_routing_ready).toBe(false);
      expect(report.care_pathway_production_activation_ready).toBe(false);
      const serialized = JSON.stringify(report);
      for (const forbidden of [
        'task_id',
        'patient_uid',
        'assigned_to_uid',
        'raw-owner-never-emit',
        'raw-patient-never-emit',
      ]) expect(serialized).not.toContain(forbidden);
    });

    it('fails closed when prerequisites, 585 schema, or tracker are incoherent', () => {
      const report = buildOwnerRoutingReport({
        tenantRows: [{ tenant_id: TENANT_A }],
        schemaState: pre585Schema({ prerequisite_column_count: 28 }),
        schemaMode: 'prerequisites_missing_or_partial',
        migrationState: buildMigrationState({
          migrationRows: migrationRows(),
          schemaMode: 'prerequisites_missing_or_partial',
        }),
        generatedAt: GENERATED_AT,
      });
      expect(report.owner_routing_ready).toBe(false);
      expect(report.global_blockers).toEqual({
        prerequisite_schema_missing_or_partial: 1,
        migration_585_schema_partial: 0,
        migration_586_schema_partial: 0,
        migration_tracker_schema_mismatch: 1,
      });
      expect(auditExitCode(report)).toBe(BLOCKED_EXIT_CODE);
    });
  });

  describe('database-enforced snapshot', () => {
    it.each([
      ['pre_585', pre585Schema(), migrationRows()],
      [
        'post_585_pre_586',
        post585Schema(),
        migrationRows({ ownerApplied: true }),
      ],
      [
        'post_586',
        post586Schema(),
        migrationRows({ ownerApplied: true, targetApplied: true }),
      ],
    ])('runs a coherent %s scan in one all-tenant read-only snapshot', async (
      schemaMode,
      schemaState,
      trackedRows,
    ) => {
      const client = makeClient({ schemaState, trackedRows });
      const report = await collectOwnerRoutingReadiness({
        client,
        sampleLimit: 4,
        generatedAt: GENERATED_AT,
      });

      expect(client.query.mock.calls.map(call => call[0])).toEqual([
        BEGIN_READ_ONLY_QUERY,
        READ_ONLY_CHECK_QUERY,
        SCHEMA_STATE_QUERY,
        MIGRATION_TRACKER_QUERY,
        TENANT_INVENTORY_QUERY,
        OWNER_REPORT_QUERY,
        COMMIT_QUERY,
      ]);
      expect(client.query.mock.calls[5][1]).toEqual([4]);
      expect(report.schema_mode).toBe(schemaMode);
      expect(report.owner_routing_ready).toBe(true);
      expect(report.care_pathway_production_activation_ready).toBe(false);
    });

    it('reports absent prerequisites as blocked without executing owner SQL', async () => {
      const client = makeClient({
        schemaState: pre585Schema({ prerequisite_column_count: 28 }),
      });
      const report = await collectOwnerRoutingReadiness({
        client,
        generatedAt: GENERATED_AT,
      });
      expect(client.query.mock.calls.map(call => call[0])).toEqual([
        BEGIN_READ_ONLY_QUERY,
        READ_ONLY_CHECK_QUERY,
        SCHEMA_STATE_QUERY,
        MIGRATION_TRACKER_QUERY,
        TENANT_INVENTORY_QUERY,
        COMMIT_QUERY,
      ]);
      expect(report.owner_routing_ready).toBe(false);
      expect(report.schema_mode).toBe('prerequisites_missing_or_partial');
    });

    it.each([
      ['writable transaction', { transaction_read_only: 'off' }, 'writable'],
      ['wrong isolation', { transaction_isolation: 'read committed' }, 'repeatable read'],
      ['recovery replica', { pg_is_in_recovery: true }, 'recovery replica'],
      [
        'ordinary RLS role',
        { audit_user_is_superuser: false, audit_user_bypasses_rls: false },
        'all-tenant privileged',
      ],
    ])('rejects a %s before schema inspection', async (_label, override, message) => {
      const client = makeClient({ state: primaryState(override) });
      await expect(collectOwnerRoutingReadiness({ client })).rejects.toThrow(message);
      expect(client.query.mock.calls.map(call => call[0])).toEqual([
        BEGIN_READ_ONLY_QUERY,
        READ_ONLY_CHECK_QUERY,
        ROLLBACK_QUERY,
      ]);
    });

    it('rejects a zero-tenant false green', async () => {
      const client = makeClient({ tenantRows: [] });
      await expect(collectOwnerRoutingReadiness({ client })).rejects.toThrow('zero tenants');
      expect(client.query.mock.calls.at(-1)[0]).toBe(ROLLBACK_QUERY);
    });
  });

  it('returns zero only for an explicitly owner-ready report', () => {
    expect(auditExitCode({ owner_routing_ready: true })).toBe(0);
    expect(auditExitCode({ owner_routing_ready: false })).toBe(BLOCKED_EXIT_CODE);
    expect(auditExitCode(undefined)).toBe(BLOCKED_EXIT_CODE);
  });
});
