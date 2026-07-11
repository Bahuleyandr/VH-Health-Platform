import fs from 'node:fs';
import path from 'node:path';

const MIGRATION_DIR = path.resolve(process.cwd(), 'src/migrations');
const MIGRATIONS = [
  '518_tenant_ed_policy.sql',
  '519_trauma_activations.sql',
  '520_trauma_survey_records.sql',
  '521_trauma_timeline_and_ed_evidence.sql',
  '522_mlc_completeness_audit.sql',
  '523_ed_injury_diagram_attachments.sql',
];

function readMigration(name) {
  return fs.readFileSync(path.join(MIGRATION_DIR, name), 'utf8');
}

describe('NL14 P2 ED trauma and MLC migrations', () => {
  it('uses the assigned 518-523 migration block only for this scope', () => {
    for (const name of MIGRATIONS) {
      expect(fs.existsSync(path.join(MIGRATION_DIR, name))).toBe(true);
    }
  });

  it('keeps every PHI table tenant-scoped with forced RLS and tenant isolation', () => {
    const sql = MIGRATIONS.map(readMigration).join('\n');

    for (const table of [
      'tenant_ed_policies',
      'trauma_activations',
      'trauma_activation_team_roles',
      'trauma_survey_records',
      'trauma_timeline_events',
      'ed_encounter_evidence',
      'mlc_completeness_reviews',
      'mlc_completeness_audit_events',
      'ed_injury_diagram_attachments',
    ]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'i'));
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(`DROP POLICY IF EXISTS tenant_isolation ON ${table}`);
      expect(sql).toContain(`CREATE POLICY tenant_isolation ON ${table}`);
    }

    expect(sql).toMatch(/current_setting\('app\.current_tenant_id', true\)/);
  });

  it('keeps policy activation and MLC certification human-gated', () => {
    const policySql = readMigration('518_tenant_ed_policy.sql');
    const mlcSql = readMigration('522_mlc_completeness_audit.sql');

    expect(policySql).toMatch(/active BOOLEAN NOT NULL DEFAULT FALSE/i);
    expect(policySql).toMatch(/CHECK \(\s*active = FALSE\s*OR \(\s*canonical_triage_scale IS NOT NULL[\s\S]*reviewer_uid IS NOT NULL[\s\S]*reviewed_at IS NOT NULL[\s\S]*activated_at IS NOT NULL[\s\S]*\)\s*\)/i);
    expect(mlcSql).toMatch(/certification_blocked BOOLEAN NOT NULL DEFAULT TRUE/i);
    expect(mlcSql).toMatch(/certificate_signer_uid UUID REFERENCES users\(uid\)/i);
    expect(mlcSql).toMatch(/reviewed_by_uid UUID REFERENCES users\(uid\)/i);
  });
});
