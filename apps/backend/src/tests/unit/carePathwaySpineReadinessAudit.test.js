import { jest } from '@jest/globals';

import {
  ACKNOWLEDGEMENT_FLAG,
  BEGIN_READ_ONLY_QUERY,
  BLOCKED_EXIT_CODE,
  COMMIT_QUERY,
  ISSUE_KEYS,
  READ_ONLY_CHECK_QUERY,
  REPORT_QUERIES,
  REPORT_QUERY_KEYS,
  ROLLBACK_QUERY,
  TENANT_INVENTORY_QUERY,
  assertOperationalSafety,
  auditExitCode,
  buildAuditReport,
  collectCarePathwaySpineReadiness,
  parseArgs,
  resolveConnectionString,
} from '../../../scripts/audit-care-pathway-spine-readiness.mjs';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GENERATED_AT = '2026-07-19T00:00:00.000Z';

function primaryState(overrides = {}) {
  return {
    transaction_read_only: 'on',
    transaction_isolation: 'repeatable read',
    pg_is_in_recovery: false,
    audit_user: 'care_pathway_auditor',
    audit_user_is_superuser: true,
    audit_user_bypasses_rls: false,
    ...overrides,
  };
}

function makeClient({ state = primaryState(), tenantRows = [], rowsByQuery = {} } = {}) {
  return {
    query: jest.fn(async sql => {
      if (sql === READ_ONLY_CHECK_QUERY) return { rows: [state] };
      if (sql === TENANT_INVENTORY_QUERY) return { rows: tenantRows };
      for (const key of REPORT_QUERY_KEYS) {
        if (sql === REPORT_QUERIES[key]) return { rows: rowsByQuery[key] || [] };
      }
      return { rows: [] };
    }),
  };
}

function emptyRowsByQuery() {
  return Object.fromEntries(REPORT_QUERY_KEYS.map(key => [key, []]));
}

describe('migration 580 care-pathway execution-spine readiness audit', () => {
  describe('operator and connection safety', () => {
    it('requires explicit acknowledgement and never falls back to ordinary DATABASE_URL', () => {
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
        DATABASE_URL: 'postgres://ordinary',
        CARE_PATHWAY_AUDIT_DATABASE_URL: 'postgres://auditor',
      })).toBe('postgres://auditor');
      expect(() => assertOperationalSafety({
        acknowledged: true,
        env: { DATABASE_SUPERUSER_URL: 'postgres://owner' },
      })).not.toThrow();
    });

    it('has no tenant-sampled or empty-install CLI escape hatch', () => {
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
      expect(() => parseArgs(['--tenant', TENANT_A])).toThrow('Unknown argument: --tenant');
      expect(() => parseArgs(['--allow-empty-install'])).toThrow(
        'Unknown argument: --allow-empty-install',
      );
      expect(() => parseArgs(['--sample-limit=0'])).toThrow('--sample-limit');
    });
  });

  describe('opening-preflight SQL parity and evidence safety', () => {
    const combinedSql = Object.values(REPORT_QUERIES).join('\n');

    it('defines every opening blocker as SELECT-only, bounded, non-locking evidence', () => {
      expect(Object.keys(REPORT_QUERIES)).toEqual(REPORT_QUERY_KEYS);
      expect(new Set(ISSUE_KEYS).size).toBe(ISSUE_KEYS.length);
      for (const issueKey of ISSUE_KEYS) expect(combinedSql).toContain(`'${issueKey}'`);

      for (const sql of [TENANT_INVENTORY_QUERY, ...Object.values(REPORT_QUERIES)]) {
        expect(sql.trim()).toMatch(/^(SELECT|WITH)\b/i);
        expect(sql).not.toMatch(
          /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|MERGE|COPY|CALL|DO|LOCK)\b/i,
        );
        expect(sql).not.toMatch(/\bFOR\s+(UPDATE|SHARE)\b/i);
        expect(sql).not.toMatch(/SELECT\s+(?:\w+\.)?\*/i);
      }
      for (const sql of Object.values(REPORT_QUERIES)) {
        expect(sql).toContain('COUNT(*) OVER');
        expect(sql).toContain('ROW_NUMBER() OVER');
        expect(sql).toContain('SUBSTRING(MD5(ranked.evidence_seed) FROM 1 FOR 16)');
        expect(sql).toContain('ranked.sample_rank <= $1::int');
        expect(sql).not.toMatch(/SELECT[\s\S]*\b(patient_uid|related_resource_id|task_id)\b[\s,]*\n?\s*FROM ranked/i);
      }
    });

    it('matches the opening task-link and policy-missing mortuary exception predicates', () => {
      const sql = REPORT_QUERIES.task_sla_links;
      expect(sql).toContain("BTRIM(task.metadata->>'sla_instance_id') ~*");
      expect(sql).toContain("'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'");
      expect(sql).toContain('LEFT JOIN workflow_sla_instances AS sla');
      expect(sql).toContain('ON sla.id::text = LOWER(metadata_link.sla_instance_id)');
      expect(sql).toContain('resolved_tenant_id IS DISTINCT FROM link.tenant_id');
      expect(sql).toContain('link.sla_key IS DISTINCT FROM link.resolved_rule_code');
      expect(sql).toContain("task.status IN ('open', 'in_progress', 'blocked', 'overdue')");
      expect(sql).toContain("task.metadata->>'requested_sla_key' = 'mortuary_unclaimed_body'");
      expect(sql).toContain("task.metadata->>'sla_policy_status' = 'missing'");
      expect(sql).toContain('task.due_at IS NULL');
      expect(sql).toContain('FROM death_records AS death_record');
    });

    it('matches the exact human-obligation ownership and terminal receipt rules', () => {
      const sql = REPORT_QUERIES.human_obligations;
      for (const rule of [
        'critical_result_ack',
        'cold_chain_excursion_ack',
        'mortuary_unclaimed_body',
      ]) expect(sql).toContain(`'${rule}'`);
      for (const role of [
        'SUPER_ADMIN',
        'DIALYSIS_TECHNICIAN',
        'MEDICAL_RECORDS',
        'ER_STAFF',
        'PHARMACIST',
      ]) expect(sql).toContain(`'${role}'`);
      expect(sql).toContain("task.task_kind = 'review'");
      expect(sql).toContain('task.patient_uid IS NOT DISTINCT FROM sla.patient_uid');
      expect(sql).toContain('owner.is_active = TRUE');
      expect(sql).toContain('UPPER(BTRIM(owner.role)) = ANY(sla.actionable_roles)');
      expect(sql).toContain('UPPER(BTRIM(task.assigned_to_role)) = ANY(sla.actionable_roles)');
      expect(sql).toContain("task.id::text = sla.metadata->>'completed_by_task'");
      expect(sql).toContain('assessed.actionable_count <> 1');
      expect(sql).toContain('assessed.current_receipt_count <> 1');
    });

    it('matches acknowledgement lifecycle and exact historical-deadline predicates', () => {
      const sql = REPORT_QUERIES.acknowledgement_lifecycle;
      expect(sql.trim()).toMatch(/^WITH RECURSIVE acknowledgement_links/i);
      expect(sql).toContain('chain.depth < 100');
      expect(sql).toContain('NOT predecessor.task_id = ANY(chain.visited_task_ids)');
      expect(sql).toContain("history.receipt->>'prior_completed_by_task'");
      expect(sql).toContain("history.receipt->>'database_authored_by'");
      expect(sql).toContain("IS DISTINCT FROM 'migration_580_rolling_compat'");
      expect(sql).toContain("history.receipt->>'compatibility_state' = 'linked'");
      expect(sql).toContain('receipt.created_at >= chain.task_created_at');
      expect(sql).toContain("pg_input_is_valid(prior_due_at_text, 'timestamp with time zone')");
      expect(sql).toContain('assessed.task_due_at IS DISTINCT FROM');
      expect(sql).toContain('verified_edge.root_task_id = assessed.task_id');
    });

    it('matches corrected/amended rearm lineage and terminal-unlinked predecessor predicates', () => {
      const sql = REPORT_QUERIES.corrected_result_lineage;
      expect(sql).toContain("sla.rule_code = 'critical_result_ack'");
      expect(sql).toContain("sla.source_table = 'lab_result'");
      expect(sql).toContain("signoff.decision IN ('corrected', 'amended')");
      expect(sql).toContain('signoff.signed_at > COALESCE(');
      expect(sql).toContain('signoff.signed_at <= successor.created_at');
      expect(sql).toContain('BOOL_OR(edge.valid_edge) AS has_valid_edge');
      expect(sql).toContain("sla.metadata->>'completed_by_task'");
      expect(sql).toContain("NULLIF(BTRIM(predecessor.metadata->>'sla_instance_id'), '') IS NULL");
      expect(sql).toContain('successor.id > predecessor.id');
    });

    it('matches workflow graph, source, deadline, mortuary, and duplicate-resource predicates', () => {
      const graphSql = REPORT_QUERIES.workflow_graph;
      expect(graphSql).toContain('run.workflow_key IS DISTINCT FROM definition.workflow_key');
      expect(graphSql).toContain('run.workflow_version IS DISTINCT FROM definition.version');
      expect(graphSql).toContain('step.step_key = run.current_step_key');
      expect(graphSql).toContain('GROUP BY step.tenant_id, step.workflow_run_id, step.ordering');
      expect(graphSql).toContain("step.status IN ('in_progress', 'blocked')");
      expect(graphSql).toContain('step.workflow_run_id IS DISTINCT FROM task.workflow_run_id');
      expect(graphSql).toContain('task.workflow_run_id IS DISTINCT FROM approval.workflow_run_id');
      expect(graphSql).toContain('parent.workflow_run_id IS DISTINCT FROM child.workflow_run_id');
      expect(graphSql).toContain("task.status IN ('open', 'in_progress', 'blocked', 'overdue')");
      expect(graphSql).toContain('HAVING COUNT(*) > 1');

      const sourceSql = REPORT_QUERIES.source_deadline_mortuary;
      expect(sourceSql).toContain("linked.source_table IS NOT DISTINCT FROM 'workflow_steps'");
      expect(sourceSql).toContain('linked.source_id IS NOT DISTINCT FROM linked.workflow_step_id::text');
      expect(sourceSql).toContain("linked.source_table IS NOT DISTINCT FROM 'death_records'");
      expect(sourceSql).toContain('linked.due_at IS NULL');
      expect(sourceSql).toContain('FROM death_records AS death_record');
      expect(sourceSql).toContain('FROM body_custody_events AS evidence');
      expect(sourceSql).toContain("evidence.event_type = 'release'");
    });

    it('does not claim migration-only post-lock race closure', () => {
      expect(combinedSql).not.toContain('care_pathway_post_lock_compatibility_check');
      expect(combinedSql).not.toContain('pending_successor');
      expect(combinedSql).not.toContain('task_materialization_contract');
      expect(combinedSql).not.toContain('task.workflow_sla_instance_id');
    });
  });

  describe('deterministic all-tenant report', () => {
    it('keeps empty tenants, stable counts, bounded samples, and strips raw identifiers', () => {
      const rowsByQuery = {
        ...emptyRowsByQuery(),
        task_sla_links: [
          {
            tenant_id: TENANT_B,
            issue_key: 'missing_task_sla_links',
            total_count: '2',
            sample_rank: 2,
            evidence_fingerprint: 'bbbbbbbbbbbbbbbb',
            rule_code: 'critical_result_ack',
            task_id: 9002,
            patient_uid: 'raw-patient-never-emit',
          },
          {
            tenant_id: TENANT_B,
            issue_key: 'missing_task_sla_links',
            total_count: 2n,
            sample_rank: 1,
            evidence_fingerprint: 'aaaaaaaaaaaaaaaa',
            rule_code: 'critical_result_ack',
            related_resource_id: 'raw-resource-never-emit',
          },
        ],
        human_obligations: [{
          tenant_id: TENANT_B,
          issue_key: 'human_sla_missing_exact_actionable_task',
          total_count: '3',
          sample_rank: 1,
          evidence_fingerprint: 'cccccccccccccccc',
          rule_code: 'mortuary_unclaimed_body',
          sla_status: 'active',
          detail: 'actionable_count_must_equal_one',
          observed_count: 0,
          sla_id: 'raw-sla-never-emit',
        }],
      };
      const reversedRows = Object.fromEntries(
        Object.entries(rowsByQuery)
          .reverse()
          .map(([key, rows]) => [key, [...rows].reverse()]),
      );
      const args = {
        tenantRows: [{ tenant_id: TENANT_B }, { tenant_id: TENANT_A }],
        readOnlyState: primaryState(),
        sampleLimit: 2,
        generatedAt: GENERATED_AT,
      };
      const first = buildAuditReport({ ...args, rowsByQuery });
      const second = buildAuditReport({
        ...args,
        tenantRows: [...args.tenantRows].reverse(),
        rowsByQuery: reversedRows,
      });

      expect(second).toEqual(first);
      expect(first.tenants.map(tenant => tenant.tenant_id)).toEqual([TENANT_A, TENANT_B]);
      expect(first.tenants[0]).toMatchObject({
        tenant_id: TENANT_A,
        ready: true,
        blocking_finding_count: 0,
      });
      expect(first.tenants[1].blockers.missing_task_sla_links).toEqual({
        count: 2,
        samples: [
          {
            evidence_fingerprint: 'aaaaaaaaaaaaaaaa',
            rule_code: 'critical_result_ack',
          },
          {
            evidence_fingerprint: 'bbbbbbbbbbbbbbbb',
            rule_code: 'critical_result_ack',
          },
        ],
      });
      expect(first.blocking_finding_count).toBe(5);
      expect(first.ready).toBe(false);
      expect(first.proof_boundary).toEqual({
        opening_fail_closed_predicates_only: true,
        post_lock_race_closure_included: false,
        post_lock_race_closure_authority:
          'migration_580_commit_on_the_drained_production_clone_and_primary',
      });
      const serialized = JSON.stringify(first);
      for (const forbidden of [
        'task_id',
        'patient_uid',
        'related_resource_id',
        'sla_id',
        'raw-patient-never-emit',
        'raw-resource-never-emit',
        'raw-sla-never-emit',
      ]) expect(serialized).not.toContain(forbidden);
    });
  });

  describe('database-enforced snapshot and false-green rejection', () => {
    it('runs every report in one primary repeatable-read READ ONLY snapshot', async () => {
      const client = makeClient({
        state: primaryState({
          audit_user_is_superuser: false,
          audit_user_bypasses_rls: true,
        }),
        tenantRows: [{ tenant_id: TENANT_A }],
        rowsByQuery: emptyRowsByQuery(),
      });

      const report = await collectCarePathwaySpineReadiness({
        client,
        sampleLimit: 4,
        generatedAt: GENERATED_AT,
      });

      expect(client.query.mock.calls.map(call => call[0])).toEqual([
        BEGIN_READ_ONLY_QUERY,
        READ_ONLY_CHECK_QUERY,
        TENANT_INVENTORY_QUERY,
        ...REPORT_QUERY_KEYS.map(key => REPORT_QUERIES[key]),
        COMMIT_QUERY,
      ]);
      for (const call of client.query.mock.calls.slice(3, -1)) {
        expect(call[1]).toEqual([4]);
      }
      expect(report.ready).toBe(true);
      expect(report.tenants_scanned).toBe(1);
      expect(report.snapshot.audit_user_bypasses_rls).toBe(true);
    });

    it.each([
      [
        'writable transaction',
        { transaction_read_only: 'off' },
        'transaction is writable',
      ],
      [
        'wrong isolation',
        { transaction_isolation: 'read committed' },
        'not repeatable read',
      ],
      [
        'recovery replica',
        { pg_is_in_recovery: true },
        'recovery replica',
      ],
      [
        'ordinary RLS role',
        { audit_user_is_superuser: false, audit_user_bypasses_rls: false },
        'rolsuper or rolbypassrls is required',
      ],
    ])('rejects %s before tenant inventory or report SQL', async (_label, override, message) => {
      const client = makeClient({
        state: primaryState(override),
        tenantRows: [{ tenant_id: TENANT_A }],
      });

      await expect(collectCarePathwaySpineReadiness({ client })).rejects.toThrow(message);
      expect(client.query.mock.calls.map(call => call[0])).toEqual([
        BEGIN_READ_ONLY_QUERY,
        READ_ONLY_CHECK_QUERY,
        ROLLBACK_QUERY,
      ]);
    });

    it('rejects a zero-tenant/RLS-hidden false green before report SQL', async () => {
      const client = makeClient({ state: primaryState(), tenantRows: [] });

      await expect(collectCarePathwaySpineReadiness({ client })).rejects.toThrow(
        'zero tenants',
      );
      expect(client.query.mock.calls.map(call => call[0])).toEqual([
        BEGIN_READ_ONLY_QUERY,
        READ_ONLY_CHECK_QUERY,
        TENANT_INVENTORY_QUERY,
        ROLLBACK_QUERY,
      ]);
    });
  });

  it('returns exit 2 for blockers and zero only for an explicitly ready report', () => {
    expect(auditExitCode({ ready: false })).toBe(BLOCKED_EXIT_CODE);
    expect(auditExitCode({ ready: true })).toBe(0);
    expect(auditExitCode(undefined)).toBe(BLOCKED_EXIT_CODE);
  });
});
