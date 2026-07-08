import fs from 'node:fs';
import path from 'node:path';

const MIGRATION_DIR = path.resolve(process.cwd(), 'src/migrations');

function readMigration(name) {
  return fs.readFileSync(path.join(MIGRATION_DIR, name), 'utf8');
}

describe('NL11-S1 migration toolkit migrations', () => {
  it('uses only the assigned 424-426 migration block for toolkit tables', () => {
    const mig424 = readMigration('424_migration_toolkit_jobs_files.sql');
    const mig425 = readMigration('425_migration_toolkit_mappings_records.sql');
    const mig426 = readMigration('426_migration_toolkit_findings_reports.sql');

    expect(mig424).toMatch(/CREATE TABLE IF NOT EXISTS migration_import_jobs/i);
    expect(mig424).toMatch(/CREATE TABLE IF NOT EXISTS migration_source_files/i);
    expect(mig425).toMatch(/CREATE TABLE IF NOT EXISTS migration_mapping_profiles/i);
    expect(mig425).toMatch(/CREATE TABLE IF NOT EXISTS migration_import_records/i);
    expect(mig426).toMatch(/CREATE TABLE IF NOT EXISTS migration_validation_findings/i);
    expect(mig426).toMatch(/CREATE TABLE IF NOT EXISTS migration_rehearsal_reports/i);
  });

  it('keeps the P1 schema tenant-scoped, RLS-forced, and rehearsal-only', () => {
    const sql = [
      readMigration('424_migration_toolkit_jobs_files.sql'),
      readMigration('425_migration_toolkit_mappings_records.sql'),
      readMigration('426_migration_toolkit_findings_reports.sql'),
    ].join('\n');

    for (const table of [
      'migration_import_jobs',
      'migration_source_files',
      'migration_mapping_profiles',
      'migration_import_records',
      'migration_validation_findings',
      'migration_rehearsal_reports',
    ]) {
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(`CREATE POLICY tenant_isolation ON ${table}`);
    }

    expect(sql).toMatch(/authoritative_write_enabled BOOLEAN NOT NULL DEFAULT FALSE/i);
    expect(sql).toMatch(/CHECK \(dry_run_only IS TRUE AND authoritative_write_enabled IS FALSE\)/i);
    expect(sql).toMatch(/raw_content_stored/i);
  });
});

describe('NL11-S9 migration toolkit P2 migrations', () => {
  it('uses only the assigned 443-445 migration block for commit, ADT, and acceptance tables', () => {
    const mig443 = readMigration('443_migration_toolkit_commit_batches.sql');
    const mig444 = readMigration('444_migration_toolkit_hl7_adt_batches.sql');
    const mig445 = readMigration('445_migration_toolkit_acceptance_merge_queue.sql');

    expect(mig443).toMatch(/CREATE TABLE IF NOT EXISTS migration_commit_batches/i);
    expect(mig443).toMatch(/CREATE TABLE IF NOT EXISTS migration_commit_records/i);
    expect(mig444).toMatch(/CREATE TABLE IF NOT EXISTS migration_hl7_adt_batches/i);
    expect(mig444).toMatch(/CREATE TABLE IF NOT EXISTS migration_hl7_adt_messages/i);
    expect(mig445).toMatch(/CREATE TABLE IF NOT EXISTS migration_merge_queue_items/i);
    expect(mig445).toMatch(/CREATE TABLE IF NOT EXISTS migration_acceptance_reports/i);
  });

  it('keeps P2 tables tenant-scoped, RLS-forced, and replayable', () => {
    const sql = [
      readMigration('443_migration_toolkit_commit_batches.sql'),
      readMigration('444_migration_toolkit_hl7_adt_batches.sql'),
      readMigration('445_migration_toolkit_acceptance_merge_queue.sql'),
    ].join('\n');

    for (const table of [
      'migration_commit_batches',
      'migration_commit_records',
      'migration_hl7_adt_batches',
      'migration_hl7_adt_messages',
      'migration_merge_queue_items',
      'migration_acceptance_reports',
    ]) {
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(`CREATE POLICY tenant_isolation ON ${table}`);
    }

    expect(sql).toMatch(/ux_migration_commit_batches_idempotency/i);
    expect(sql).toMatch(/ux_migration_commit_records_idempotency/i);
    expect(sql).toMatch(/ux_migration_hl7_adt_batches_idempotency/i);
    expect(sql).toMatch(/rollback_proof/i);
    expect(sql).toMatch(/replay_proof/i);
  });
});
