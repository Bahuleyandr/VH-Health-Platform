import fs from 'node:fs';
import path from 'node:path';

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
}));

const {
  createImportJob,
  profileSourceFile,
  rehearseImportJob,
  __testing__,
} = await import('../../services/migrationToolkit/migrationToolkitService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const USER_UID = '11111111-1111-4111-8111-111111111111';
const FIXTURE_DIR = path.resolve(process.cwd(), 'src/tests/fixtures/migration-toolkit');

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

function sqlText(call) {
  return String(call?.[0] || '').replace(/\s+/g, ' ').trim();
}

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

describe('migrationToolkitService CSV rehearsal', () => {
  it('creates tenant-scoped dry-run jobs', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 42,
      tenant_id: TENANT,
      job_name: 'Legacy HIS rehearsal',
      import_kind: 'mixed',
      dry_run_only: true,
      authoritative_write_enabled: false,
    }]);

    const row = await createImportJob({
      tenantId: TENANT,
      jobName: 'Legacy HIS rehearsal',
      importKind: 'mixed',
      createdBy: USER_UID,
    });

    expect(row.id).toBe(42);
    expect(row.dry_run_only).toBe(true);
    expect(queryUnsafeMock.mock.calls[0][1]).toBe(TENANT);
    expect(sqlText(queryUnsafeMock.mock.calls[0])).toMatch(/INSERT INTO migration_import_jobs/);
  });

  it('profiles source files without persisting raw CSV or unredacted PHI samples', async () => {
    queryUnsafeMock.mockImplementation((sql, ...params) => {
      const text = String(sql);
      if (/FROM migration_import_jobs/i.test(text)) {
        return Promise.resolve([{ id: 42, tenant_id: TENANT, import_kind: 'mixed' }]);
      }
      if (/INSERT INTO migration_source_files/i.test(text)) {
        return Promise.resolve([{
          id: 7,
          tenant_id: params[0],
          job_id: params[1],
          file_kind: params[2],
          source_filename: params[3],
          content_sha256: params[4],
          row_count: params[7],
          sample_rows_redacted: JSON.parse(params[10]),
          storage_contract: JSON.parse(params[11]),
        }]);
      }
      return Promise.resolve([]);
    });

    const row = await profileSourceFile({
      tenantId: TENANT,
      jobId: 42,
      fileKind: 'patient',
      sourceFilename: 'patients.csv',
      csvText: fixture('patients-duplicate.csv'),
      uploadedBy: USER_UID,
    });

    expect(row.row_count).toBe(2);
    expect(row.storage_contract.raw_content_stored).toBe(false);
    expect(JSON.stringify(row.sample_rows_redacted)).not.toContain('Asha Rao');
    expect(JSON.stringify(row.sample_rows_redacted)).not.toContain('9812345678');
    expect(row.sample_rows_redacted[0].values.name).toBe('[redacted]');
  });

  it('generates PHI-redacted duplicate findings and no-write proof', async () => {
    let recordId = 100;
    let findingId = 200;

    queryUnsafeMock.mockImplementation((sql, ...params) => {
      const text = String(sql);
      if (/FROM migration_import_jobs/i.test(text)) {
        return Promise.resolve([{ id: 42, tenant_id: TENANT, import_kind: 'mixed', status: 'draft' }]);
      }
      if (/DELETE FROM/i.test(text) || /UPDATE migration_import_jobs/i.test(text)) {
        return Promise.resolve([]);
      }
      if (/INSERT INTO migration_source_files/i.test(text)) {
        return Promise.resolve([{
          id: 7,
          tenant_id: params[0],
          job_id: params[1],
          file_kind: params[2],
          source_filename: params[3],
          content_sha256: params[4],
          row_count: params[7],
        }]);
      }
      if (/SELECT phone FROM users/i.test(text)) {
        return Promise.resolve([]);
      }
      if (/INSERT INTO migration_import_records/i.test(text)) {
        recordId += 1;
        return Promise.resolve([{
          id: recordId,
          uid: `record-${recordId}`,
          validation_state: params[9],
          duplicate_candidate: params[10],
        }]);
      }
      if (/INSERT INTO migration_validation_findings/i.test(text)) {
        findingId += 1;
        return Promise.resolve([{
          id: findingId,
          uid: `finding-${findingId}`,
          finding_code: params[4],
          severity: params[5],
          target_kind: params[6],
          field_name: params[7],
          source_row_number: params[8],
          message_redacted: params[9],
          remediation_hint: params[10],
          metadata: JSON.parse(params[11]),
        }]);
      }
      if (/INSERT INTO migration_rehearsal_reports/i.test(text)) {
        return Promise.resolve([{
          id: 88,
          tenant_id: params[0],
          job_id: params[1],
          status: params[2],
          phi_redacted: true,
          summary: JSON.parse(params[3]),
          validation_summary: JSON.parse(params[4]),
          duplicate_summary: JSON.parse(params[5]),
          no_write_proof: JSON.parse(params[6]),
        }]);
      }
      return Promise.resolve([]);
    });

    const result = await rehearseImportJob({
      tenantId: TENANT,
      jobId: 42,
      generatedBy: USER_UID,
      files: [{
        file_kind: 'patient',
        source_filename: 'patients.csv',
        csv_text: fixture('patients-duplicate.csv'),
      }],
    });

    expect(result.report.phi_redacted).toBe(true);
    expect(result.report.no_write_proof.authoritative_write_enabled).toBe(false);
    expect(result.report.no_write_proof.authoritative_tables_blocked).toContain('users');
    expect(result.report.validation_summary.by_severity.warning).toBeGreaterThan(0);
    expect(result.report.duplicate_summary.duplicate_groups).toBeGreaterThan(0);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Asha Rao');
    expect(serialized).not.toContain('9812345678');
    expect(result.findings.map((finding) => finding.finding_code)).toContain('PATIENT_DUPLICATE_IN_FILE');

    const sql = queryUnsafeMock.mock.calls.map(sqlText).join('\n');
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\s+INTO?\s+(users|appointments|patient_encounters|invoices|ledger_entries|payment_transactions)\b/i);
    expect(sql).toMatch(/INSERT INTO migration_import_records/);
    expect(sql).toMatch(/INSERT INTO migration_rehearsal_reports/);
  });

  it('validates opening AR rows without ledger writes', () => {
    const profile = __testing__.buildCsvProfile({
      csvText: fixture('opening-ar-invalid.csv'),
      sourceFilename: 'opening-ar.csv',
      fileKind: 'opening_ar',
    });
    const second = profile.parsed.rows[1];
    const canonical = __testing__.canonicalizeRow('opening_ar', second.row, {});
    const findings = __testing__.validateCanonicalRow('opening_ar', canonical, second.rowNumber);

    expect(canonical.amount_due_number).toBeNull();
    expect(findings.map((finding) => finding.finding_code)).toContain('OPENING_AR_AMOUNT_INVALID');
    expect(profile.storageContract.raw_content_stored).toBe(false);
  });
});
