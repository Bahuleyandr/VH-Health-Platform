/**
 * Phase C3 — verifies migration 122 declares the five care-plan + follow-up
 * tables with the constraints + indexes the service relies on.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../migrations/122_care_plan_followup.sql',
);

describe('migration 122 — care plan + follow-up foundation', () => {
  let sql;
  beforeAll(() => {
    sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  });

  it('exists with non-trivial body', () => {
    expect(sql.length).toBeGreaterThan(2000);
  });

  it('is wrapped in a transaction', () => {
    expect(sql).toMatch(/^\s*BEGIN;[\s\S]*COMMIT;\s*$/m);
  });

  it.each([
    ['care_plans'], ['care_plan_goals'], ['care_plan_activities'],
    ['follow_up_plans'], ['care_plan_review_log'],
  ])('declares %s with IF NOT EXISTS', (table) => {
    expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'));
  });

  it('all 5 tables tenant-scoped', () => {
    const tables = sql.match(/CREATE TABLE IF NOT EXISTS \w+/gi) || [];
    expect(tables.length).toBe(5);
    const tenantRefs = sql.match(/tenant_id\s+UUID NOT NULL REFERENCES tenants\(id\)/gi) || [];
    expect(tenantRefs.length).toBe(5);
  });

  it('care_plans allow-lists 12 plan_kind + 8 statuses + has window CHECK', () => {
    const kinds = ['general', 'chronic_disease', 'post_surgical', 'palliative',
      'pediatric', 'pregnancy', 'mental_health', 'rehab', 'preventive',
      'oncology', 'transplant', 'other'];
    for (const k of kinds) expect(sql).toMatch(new RegExp(`'${k}'`));
    const statuses = ['draft', 'active', 'paused', 'completed', 'cancelled', 'archived', 'on_hold', 'superseded'];
    for (const s of statuses) expect(sql).toMatch(new RegExp(`'${s}'`));
    expect(sql).toMatch(/chk_care_plan_window CHECK \(\s*target_end_date IS NULL OR start_date IS NULL OR target_end_date >= start_date\s*\)/i);
  });

  it('care_plans supports superseded_by_id self-reference', () => {
    expect(sql).toMatch(/superseded_by_id\s+INTEGER REFERENCES care_plans\(id\)/i);
  });

  it('care_plan_goals allow-lists 9 goal_kinds + 4 priorities + 6 statuses', () => {
    const goalKinds = ['clinical_target', 'lifestyle', 'medication_adherence', 'symptom_control',
      'self_management', 'education', 'screening', 'milestone', 'other'];
    for (const k of goalKinds) expect(sql).toMatch(new RegExp(`'${k}'`));
    expect(sql).toMatch(/CHECK \(priority IN \('low', 'normal', 'high', 'critical'\)\)/i);
    expect(sql).toMatch(/CHECK \(status IN \('planned', 'in_progress', 'achieved', 'not_achieved', 'cancelled', 'on_hold'\)\)/i);
  });

  it('care_plan_activities allow-lists 6 schedule_kind values', () => {
    expect(sql).toMatch(/CHECK \(schedule_kind IN \('one_time', 'daily', 'weekly', 'monthly', 'on_event', 'as_needed'\)\)/i);
  });

  it('care_plan_activities partial due-index', () => {
    expect(sql).toMatch(/idx_care_plan_activities_tenant_due[\s\S]*WHERE next_due_at IS NOT NULL AND status IN \('planned', 'in_progress', 'overdue'\)/i);
  });

  it('follow_up_plans allow-lists 9 origin_kind + 6 statuses + 5 appointment_status values', () => {
    const origins = ['consultation', 'discharge', 'ot_case', 'er_visit', 'admission',
      'investigation', 'teleconsult', 'manual', 'other'];
    for (const o of origins) expect(sql).toMatch(new RegExp(`'${o}'`));
    const statuses = ['open', 'scheduled', 'completed', 'cancelled', 'overdue', 'lost_to_followup'];
    for (const s of statuses) expect(sql).toMatch(new RegExp(`'${s}'`));
    expect(sql).toMatch(/CHECK \(appointment_status IN \('pending', 'scheduled', 'completed', 'cancelled', 'no_show'\)\)/i);
  });

  it('follow_up_plans partial overdue index', () => {
    expect(sql).toMatch(/idx_follow_up_overdue[\s\S]*WHERE status = 'open' AND due_at IS NOT NULL/i);
  });

  it('care_plan_review_log allow-lists 12 event_kind values', () => {
    const kinds = ['created', 'reviewed', 'updated', 'goal_added', 'goal_completed',
      'activity_added', 'paused', 'resumed', 'completed', 'cancelled',
      'superseded', 'comment'];
    for (const k of kinds) expect(sql).toMatch(new RegExp(`'${k}'`));
  });
});
