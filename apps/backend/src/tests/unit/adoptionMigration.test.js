import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_471 = path.resolve(__dirname, '../../migrations/471_learning_manuals_help_tours.sql');
const MIGRATION_472 = path.resolve(__dirname, '../../migrations/472_learning_completions_evidence.sql');

describe('migrations 471-472 - Manuals/Tours/LMS P1', () => {
  let migration471;
  let migration472;

  beforeAll(() => {
    migration471 = fs.readFileSync(MIGRATION_471, 'utf8');
    migration472 = fs.readFileSync(MIGRATION_472, 'utf8');
  });

  it('uses only the assigned migration block for adoption catalog and evidence tables', () => {
    expect(migration471).toMatch(/CREATE TABLE IF NOT EXISTS help_center_categories/i);
    expect(migration471).toMatch(/CREATE TABLE IF NOT EXISTS learning_modules/i);
    expect(migration471).toMatch(/CREATE TABLE IF NOT EXISTS tour_definitions/i);
    expect(migration472).toMatch(/CREATE TABLE IF NOT EXISTS learning_assignments/i);
    expect(migration472).toMatch(/CREATE TABLE IF NOT EXISTS learning_completions/i);
    expect(migration472).toMatch(/CREATE TABLE IF NOT EXISTS tour_events/i);
    expect(migration472).toMatch(/CREATE TABLE IF NOT EXISTS training_evidence_ledger/i);
  });

  it('forces tenant RLS on every new tenant-scoped table', () => {
    const sql = `${migration471}\n${migration472}`;
    for (const table of [
      'help_center_categories',
      'learning_modules',
      'tour_definitions',
      'learning_assignments',
      'learning_completions',
      'tour_events',
      'training_evidence_ledger',
    ]) {
      expect(sql).toContain(`'${table}'`);
      expect(sql).toContain(`FOREIGN KEY (tenant_id) REFERENCES tenants(id)`);
    }
    expect(sql).toContain("ALTER TABLE %I ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE %I FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("CREATE POLICY tenant_isolation ON %I");
  });

  it('keeps the slice lightweight and no-PHI', () => {
    expect(migration471).toMatch(/learning_modules_no_phi_check[\s\S]*CHECK \(no_phi IS TRUE\)/i);
    expect(migration471).toContain("'role_manual'");
    expect(migration471).not.toMatch(/quiz_questions|course_authoring|scorm|xapi/i);
    expect(migration472).toContain('NABH_STAFF_CONFIDENTIALITY_TRAINING');
    expect(migration472).toMatch(/training_evidence_ledger_verified_check/i);
  });
});
