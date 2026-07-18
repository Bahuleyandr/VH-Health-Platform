/**
 * Phase B2 — verifies migration 118 declares the nine tables
 * (workflow_definitions / workflow_runs / workflow_steps / tasks /
 * task_comments / approvals / escalation_rules / sla_definitions /
 * automation_rules) with the constraints the service relies on.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../migrations/118_tasks_workflow_foundation.sql',
);
const HARDENING_MIGRATION_PATH = path.resolve(
  __dirname,
  '../../migrations/579_workflow_runtime_hardening.sql',
);

describe('migration 118 — tasks / workflow / approval foundation', () => {
  let sql;
  beforeAll(() => {
    sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  });

  it('exists with non-trivial body', () => {
    expect(sql.length).toBeGreaterThan(2500);
  });

  it('is wrapped in a transaction', () => {
    expect(sql).toMatch(/^\s*BEGIN;[\s\S]*COMMIT;\s*$/m);
  });

  it.each([
    ['workflow_definitions'],
    ['workflow_runs'],
    ['workflow_steps'],
    ['tasks'],
    ['task_comments'],
    ['approvals'],
    ['escalation_rules'],
    ['sla_definitions'],
    ['automation_rules'],
  ])('declares %s with IF NOT EXISTS', (table) => {
    expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'));
  });

  it('every table is tenant-scoped', () => {
    const tables = sql.match(/CREATE TABLE IF NOT EXISTS \w+/gi) || [];
    expect(tables.length).toBe(9);
    const tenantRefs = sql.match(/tenant_id\s+UUID NOT NULL REFERENCES tenants\(id\)/gi) || [];
    expect(tenantRefs.length).toBe(9);
  });

  it('tasks allow-lists 9 task_kind values', () => {
    const kinds = ['general', 'follow_up', 'review', 'escalation', 'verification', 'admin', 'consent', 'investigation', 'other'];
    for (const k of kinds) expect(sql).toMatch(new RegExp(`'${k}'`));
  });

  it('tasks allow-lists 4 priority levels + 6 statuses', () => {
    expect(sql).toMatch(/CHECK \(priority IN \('low', 'normal', 'high', 'critical'\)\)/i);
    expect(sql).toMatch(/CHECK \(status IN \('open', 'in_progress', 'blocked', 'completed', 'cancelled', 'overdue'\)\)/i);
  });

  it('workflow_runs allow-lists 6 statuses', () => {
    expect(sql).toMatch(/CHECK \(status IN \('started', 'running', 'blocked', 'completed', 'cancelled', 'failed'\)\)/i);
  });

  it('workflow_steps allow-lists step_kind including ai_call', () => {
    expect(sql).toMatch(/CHECK \(step_kind IN \('task', 'approval', 'automation', 'wait', 'subworkflow', 'ai_call'\)\)/i);
  });

  it('approvals allow-lists 5 statuses', () => {
    expect(sql).toMatch(/CHECK \(status IN \('pending', 'approved', 'rejected', 'cancelled', 'expired'\)\)/i);
  });

  it('escalation_rules allow-lists 5 action kinds + 4 trigger conditions', () => {
    expect(sql).toMatch(/CHECK \(action_kind IN \('notify', 'reassign', 'escalate_priority', 'auto_resolve', 'webhook'\)\)/i);
    expect(sql).toMatch(/CHECK \(trigger_condition IN \(\s*'sla_breach', 'no_progress_after', 'pending_too_long', 'on_status_change'\s*\)\)/i);
  });

  it('sla_definitions enforces (tenant, sla_key) uniqueness', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS sla_definitions[\s\S]*UNIQUE \(tenant_id, sla_key\)/i);
  });

  it('workflow_steps unique on (workflow_run_id, step_key)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS workflow_steps[\s\S]*UNIQUE \(workflow_run_id, step_key\)/i);
  });

  it('workflow_definitions unique on (tenant_id, workflow_key, version)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS workflow_definitions[\s\S]*UNIQUE \(tenant_id, workflow_key, version\)/i);
  });

  it('tasks indexes hot paths (status, priority, due_at, assigned)', () => {
    const expected = [
      /idx_tasks_tenant_status/i,
      /idx_tasks_assigned/i,
      /idx_tasks_role/i,
      /idx_tasks_patient/i,
      /idx_tasks_workflow/i,
      /idx_tasks_due/i,
    ];
    for (const re of expected) expect(sql).toMatch(re);
  });

  it('tasks due-date index is partial (status in open|in_progress|blocked)', () => {
    expect(sql).toMatch(/idx_tasks_due[\s\S]*WHERE due_at IS NOT NULL AND status IN \('open', 'in_progress', 'blocked'\)/i);
  });
});

describe('migration 579 — tenant-safe dormant workflow runtime', () => {
  let sql;
  beforeAll(() => {
    sql = fs.readFileSync(HARDENING_MIGRATION_PATH, 'utf8');
  });

  it('exists with a transactional, non-trivial body', () => {
    expect(sql.length).toBeGreaterThan(4000);
    expect(sql).toMatch(/^\s*(?:--[^\n]*\n)*\s*BEGIN;[\s\S]*COMMIT;\s*$/m);
  });

  it.each([
    ['workflow_runs', 'workflow_definition_id', 'workflow_definitions'],
    ['workflow_steps', 'workflow_run_id', 'workflow_runs'],
    ['tasks', 'workflow_run_id', 'workflow_runs'],
    ['tasks', 'workflow_step_id', 'workflow_steps'],
    ['tasks', 'parent_task_id', 'tasks'],
    ['task_comments', 'task_id', 'tasks'],
    ['approvals', 'workflow_run_id', 'workflow_runs'],
    ['approvals', 'task_id', 'tasks'],
  ])('fails closed on a cross-tenant %s.%s link to %s', (child, column, parent) => {
    expect(sql).toMatch(new RegExp(
      `FROM\\s+${child}\\s+AS child[\\s\\S]*?JOIN\\s+${parent}\\s+AS parent[\\s\\S]*?parent\\.id = child\\.${column}[\\s\\S]*?child\\.tenant_id IS DISTINCT FROM parent\\.tenant_id[\\s\\S]*?RAISE EXCEPTION[\\s\\S]*?${child}\\.${column} crosses tenants`,
      'i',
    ));
  });

  it.each([
    ['workflow_definitions', 'ux_workflow_definitions_tenant_id'],
    ['workflow_runs', 'ux_workflow_runs_tenant_id'],
    ['workflow_steps', 'ux_workflow_steps_tenant_id'],
    ['tasks', 'ux_tasks_tenant_id'],
  ])('adds a tenant/id unique key to %s', (table, index) => {
    expect(sql).toMatch(new RegExp(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${index}\\s+ON ${table} \\(tenant_id, id\\)`,
      'i',
    ));
  });

  it.each([
    ['workflow_runs', 'workflow_definition_id', 'workflow_definitions', 'SET NULL \\(workflow_definition_id\\)'],
    ['workflow_steps', 'workflow_run_id', 'workflow_runs', 'CASCADE'],
    ['tasks', 'workflow_run_id', 'workflow_runs', 'SET NULL \\(workflow_run_id\\)'],
    ['tasks', 'workflow_step_id', 'workflow_steps', 'SET NULL \\(workflow_step_id\\)'],
    ['tasks', 'parent_task_id', 'tasks', 'SET NULL \\(parent_task_id\\)'],
    ['task_comments', 'task_id', 'tasks', 'CASCADE'],
    ['approvals', 'workflow_run_id', 'workflow_runs', 'SET NULL \\(workflow_run_id\\)'],
    ['approvals', 'task_id', 'tasks', 'SET NULL \\(task_id\\)'],
  ])(
    'tenant-qualifies %s.%s and preserves its delete behavior',
    (child, column, parent, deleteBehavior) => {
      expect(sql).toMatch(new RegExp(
        `ALTER TABLE ${child}[\\s\\S]*?FOREIGN KEY \\(tenant_id, ${column}\\)[\\s\\S]*?REFERENCES ${parent} \\(tenant_id, id\\)[\\s\\S]*?ON DELETE ${deleteBehavior}`,
        'i',
      ));
    },
  );

  it('makes only newly inserted workflow definitions inactive by default', () => {
    expect(sql).toMatch(/ALTER TABLE workflow_definitions\s+ALTER COLUMN is_active SET DEFAULT false;/i);
    expect(sql).not.toMatch(/\bUPDATE\s+workflow_definitions\b/i);
  });

  it('does not create or seed workflow data', () => {
    expect(sql).not.toMatch(/\bCREATE TABLE\b/i);
    expect(sql).not.toMatch(/\bINSERT\s+INTO\s+(workflow_definitions|workflow_runs|workflow_steps|tasks|approvals)\b/i);
  });
});
