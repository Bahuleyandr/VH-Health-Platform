/**
 * Migration 260 — canonical care-team access + lab specimen/analyzer/QC.
 * Verifies tenant scope, audit fields, lifecycle history, indexes, and
 * lab_results linkage expected by the admin governance services.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../migrations/260_care_team_patient_access_lab_specimen_qc.sql',
);

const TABLES = [
  'appointment_queues',
  'appointment_queue_status_history',
  'care_teams',
  'care_team_members',
  'care_team_member_status_history',
  'care_team_status_history',
  'patient_access_break_glass',
  'patient_access_break_glass_status_history',
  'patient_access_audit_log',
  'lab_specimens',
  'lab_specimen_status_history',
  'lab_analyzers',
  'lab_analyzer_status_history',
  'lab_analyzer_qc_runs',
];

function tableBlock(sql, table) {
  const match = sql.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`, 'i'),
  );
  return match?.[0] || '';
}

describe('migration 260 — care-team access and lab specimen/QC governance', () => {
  let sql;
  beforeAll(() => {
    sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  });

  it('exists with non-trivial body and transaction wrapper', () => {
    expect(sql.length).toBeGreaterThan(8000);
    expect(sql).toMatch(/^\s*BEGIN;[\s\S]*COMMIT;\s*$/m);
  });

  it.each(TABLES.map((table) => [table]))('declares %s with IF NOT EXISTS', (table) => {
    expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'));
  });

  it('all new tables are tenant-scoped', () => {
    const declarations = sql.match(/CREATE TABLE IF NOT EXISTS \w+/gi) || [];
    expect(declarations).toHaveLength(TABLES.length);
    for (const table of TABLES) {
      expect(tableBlock(sql, table)).toMatch(/tenant_id\s+UUID NOT NULL REFERENCES tenants\(id\)/i);
    }
  });

  it('all new tables carry audit fields', () => {
    for (const table of TABLES) {
      const block = tableBlock(sql, table);
      expect(block).toMatch(/created_by\s+UUID/i);
      expect(block).toMatch(/updated_by\s+UUID/i);
      expect(block).toMatch(/created_at\s+TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i);
      expect(block).toMatch(/updated_at\s+TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i);
    }
  });

  it('care-team patient access has membership, break-glass, and audit primitives', () => {
    expect(tableBlock(sql, 'care_teams')).toMatch(/patient_uid\s+UUID NOT NULL/i);
    expect(tableBlock(sql, 'care_team_members')).toMatch(/CONSTRAINT chk_care_team_member_identity/i);
    expect(tableBlock(sql, 'patient_access_break_glass')).toMatch(/reason\s+TEXT NOT NULL/i);
    expect(tableBlock(sql, 'patient_access_break_glass')).toMatch(/chk_break_glass_reason_minimum/i);
    expect(tableBlock(sql, 'patient_access_audit_log')).toMatch(/access_source\s+VARCHAR\(40\) NOT NULL/i);
    expect(sql).toMatch(/idx_patient_access_audit_patient_time/i);
  });

  it('appointment queues are first-class and link back to appointments', () => {
    expect(tableBlock(sql, 'appointment_queues')).toMatch(/queue_date\s+DATE NOT NULL/i);
    expect(tableBlock(sql, 'appointment_queues')).toMatch(/queue_kind\s+VARCHAR\(40\) NOT NULL/i);
    expect(tableBlock(sql, 'appointment_queue_status_history')).toMatch(/to_status\s+VARCHAR\(20\) NOT NULL/i);
    expect(sql).toMatch(/ALTER TABLE appointments[\s\S]*ADD COLUMN IF NOT EXISTS queue_id INTEGER REFERENCES appointment_queues/i);
    expect(sql).toMatch(/idx_appointments_queue_id/i);
  });

  it('clinically meaningful lifecycle tables record status history', () => {
    expect(tableBlock(sql, 'appointment_queue_status_history')).toMatch(/to_status\s+VARCHAR\(20\) NOT NULL/i);
    expect(tableBlock(sql, 'care_team_status_history')).toMatch(/from_status\s+VARCHAR\(20\)/i);
    expect(tableBlock(sql, 'care_team_status_history')).toMatch(/to_status\s+VARCHAR\(20\) NOT NULL/i);
    expect(tableBlock(sql, 'care_team_member_status_history')).toMatch(/to_status\s+VARCHAR\(20\) NOT NULL/i);
    expect(tableBlock(sql, 'patient_access_break_glass_status_history')).toMatch(/to_status\s+VARCHAR\(20\) NOT NULL/i);
    expect(tableBlock(sql, 'lab_specimen_status_history')).toMatch(/to_status\s+VARCHAR\(30\) NOT NULL/i);
    expect(tableBlock(sql, 'lab_analyzer_status_history')).toMatch(/to_status\s+VARCHAR\(30\) NOT NULL/i);
  });

  it('lab specimen, analyzer, and QC entities have constrained status vocabularies', () => {
    expect(tableBlock(sql, 'lab_specimens')).toMatch(/'ordered', 'collected', 'in_transit', 'received'/);
    expect(tableBlock(sql, 'lab_analyzers')).toMatch(/'active', 'maintenance', 'offline', 'retired'/);
    expect(tableBlock(sql, 'lab_analyzer_qc_runs')).toMatch(/'pending', 'passed', 'failed', 'warning'/);
  });

  it('lab_results links back to specimen, analyzer, and QC run', () => {
    expect(sql).toMatch(/ALTER TABLE lab_results[\s\S]*ADD COLUMN IF NOT EXISTS specimen_id INTEGER REFERENCES lab_specimens/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS analyzer_id INTEGER REFERENCES lab_analyzers/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS qc_run_id INTEGER REFERENCES lab_analyzer_qc_runs/i);
    expect(sql).toMatch(/idx_lab_results_specimen/i);
    expect(sql).toMatch(/idx_lab_results_analyzer/i);
  });

  it('declares hot-path indexes for care-team and lab governance queries', () => {
    const expected = [
      /idx_care_teams_tenant_patient_status/i,
      /idx_appointment_queues_date_status/i,
      /idx_care_team_members_patient_staff/i,
      /idx_break_glass_active_patient/i,
      /idx_lab_specimens_patient_time/i,
      /idx_lab_specimens_status_priority/i,
      /idx_lab_analyzers_tenant_status/i,
      /idx_lab_qc_runs_analyzer_time/i,
    ];
    for (const re of expected) expect(sql).toMatch(re);
  });
});
