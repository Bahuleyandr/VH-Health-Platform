import fs from 'node:fs';
import path from 'node:path';

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const executeUnsafeMock = jest.fn();
const setTenantTxMock = jest.fn();
const postLedgerEntryMock = jest.fn();

const txMock = { $queryRawUnsafe: queryUnsafeMock, $executeRawUnsafe: executeUnsafeMock };
const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../services/billing/ledger/ledgerService.js', () => ({
  postLedgerEntry: postLedgerEntryMock,
}));

const {
  commitImportJob,
  createImportJob,
  importHl7AdtBatch,
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
  executeUnsafeMock.mockReset();
  postLedgerEntryMock.mockReset();
  postLedgerEntryMock.mockResolvedValue({ entryId: 9001 });
  setTenantTxMock.mockReset();
  setTenantTxMock.mockImplementation(async (tenantId, fn) => fn(txMock));
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

function installCommitMock({ phoneConflict = false, replayBatch = false } = {}) {
  let sourceFileId = 10;
  let importRecordId = 100;
  let commitRecordId = 300;
  queryUnsafeMock.mockImplementation((sql, ...params) => {
    const text = String(sql);
    if (/FROM migration_import_jobs/i.test(text)) {
      return Promise.resolve([{
        id: 42,
        tenant_id: TENANT,
        import_kind: 'mixed',
        status: 'report_ready',
      }]);
    }
    if (/INSERT INTO migration_source_files/i.test(text)) {
      sourceFileId += 1;
      return Promise.resolve([{
        id: sourceFileId,
        tenant_id: params[0],
        job_id: params[1],
        file_kind: params[2],
        source_filename: params[3],
        content_sha256: params[4],
        row_count: params[7],
      }]);
    }
    if (/SELECT phone\s+FROM users/i.test(text)) {
      return Promise.resolve(phoneConflict ? [{ phone: '9812345678' }] : []);
    }
    if (/INSERT INTO migration_import_records/i.test(text)) {
      importRecordId += 1;
      return Promise.resolve([{
        id: importRecordId,
        uid: `record-${importRecordId}`,
        validation_state: params[9],
        duplicate_candidate: params[10],
      }]);
    }
    if (/INSERT INTO migration_validation_findings/i.test(text)) {
      return Promise.resolve([{
        id: 201,
        uid: 'finding-201',
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
    if (/FROM migration_commit_batches/i.test(text)) {
      return Promise.resolve(replayBatch ? [{
        id: 501,
        uid: 'batch-501',
        tenant_id: TENANT,
        job_id: 42,
        status: 'committed',
        idempotency_key: 'commit-42',
        acceptance_summary: { total: 3 },
        opening_balance_totals: { amount_paise: 120050 },
        rollback_plan: {},
        replay_proof: {},
        committed_at: new Date().toISOString(),
      }] : []);
    }
    if (/INSERT INTO migration_commit_batches/i.test(text)) {
      return Promise.resolve([{
        id: 501,
        uid: 'batch-501',
        tenant_id: params[0],
        job_id: params[1],
        status: 'committing',
        idempotency_key: params[2],
        acceptance_summary: {},
        opening_balance_totals: {},
        rollback_plan: {},
        replay_proof: {},
        committed_at: new Date().toISOString(),
      }]);
    }
    if (/FROM migration_acceptance_reports/i.test(text)) {
      return Promise.resolve([{
        id: 601,
        uid: 'report-601',
        tenant_id: TENANT,
        job_id: 42,
        commit_batch_id: 501,
        status: 'accepted',
        phi_redacted: true,
        report_json: { replayed: true },
        acceptance_summary: { total: 3 },
        opening_balance_totals: { amount_paise: 120050 },
        rollback_proof: {},
        replay_proof: {},
      }]);
    }
    if (/FROM patient_identifiers/i.test(text)) return Promise.resolve([]);
    if (/SELECT uid, id\s+FROM users/i.test(text)) {
      return Promise.resolve(phoneConflict ? [{
        uid: '22222222-2222-4222-8222-222222222222',
        id: 222,
      }] : []);
    }
    if (/INSERT INTO users/i.test(text)) {
      return Promise.resolve([{ uid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', id: 777 }]);
    }
    if (/INSERT INTO patient_identifiers/i.test(text)) {
      return Promise.resolve([{ id: 800, patient_uid: params[1] }]);
    }
    if (/INSERT INTO migration_merge_queue_items/i.test(text)) {
      return Promise.resolve([{
        id: 901,
        uid: 'merge-901',
        tenant_id: params[0],
        job_id: params[1],
        commit_batch_id: params[2],
        import_record_id: params[3],
        conflict_kind: params[4],
        source_patient_key: params[5],
        candidate_patient_uid: params[6],
        imported_patient_uid: params[7],
        status: 'review_required',
        review_payload_redacted: JSON.parse(params[8]),
      }]);
    }
    if (/FROM admissions/i.test(text)) return Promise.resolve([]);
    if (/INSERT INTO admissions/i.test(text)) {
      return Promise.resolve([{ id: 701, encounter_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }]);
    }
    if (/FROM patient_encounters/i.test(text)) return Promise.resolve([]);
    if (/INSERT INTO patient_encounters/i.test(text)) {
      return Promise.resolve([{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }]);
    }
    if (/FROM billing_invoices/i.test(text)) return Promise.resolve([]);
    if (/INSERT INTO billing_invoices/i.test(text)) {
      return Promise.resolve([{ id: 801, amount_due: '1200.50', total_amount: '1200.50' }]);
    }
    if (/FROM ledger_entries/i.test(text)) return Promise.resolve([]);
    if (/INSERT INTO migration_commit_records/i.test(text)) {
      commitRecordId += 1;
      return Promise.resolve([{
        id: commitRecordId,
        uid: `commit-record-${commitRecordId}`,
        tenant_id: params[0],
        commit_batch_id: params[1],
        job_id: params[2],
        import_record_id: params[3],
        target_kind: params[4],
        source_key: params[5],
        row_hash: params[6],
        status: params[7],
        action: params[8],
        target_table: params[9],
        target_id: params[10],
        target_uid: params[11],
        idempotency_key: params[12],
        rollback_payload: JSON.parse(params[13]),
        replay_proof: JSON.parse(params[14]),
        error_redacted: params[15],
        metadata: JSON.parse(params[16]),
      }]);
    }
    if (/UPDATE migration_commit_batches/i.test(text)) return Promise.resolve([]);
    if (/UPDATE migration_import_jobs/i.test(text)) return Promise.resolve([]);
    if (/INSERT INTO migration_acceptance_reports/i.test(text)) {
      return Promise.resolve([{
        id: 601,
        uid: 'report-601',
        tenant_id: params[0],
        job_id: params[1],
        commit_batch_id: params[2],
        status: 'accepted',
        phi_redacted: true,
        report_json: JSON.parse(params[3]),
        acceptance_summary: JSON.parse(params[4]),
        opening_balance_totals: JSON.parse(params[5]),
        rollback_proof: JSON.parse(params[6]),
        replay_proof: JSON.parse(params[7]),
        generated_by: params[8],
      }]);
    }
    return Promise.resolve([]);
  });
}

describe('migrationToolkitService commit path', () => {
  it('commits patients, encounters, and opening AR with replay and ledger proof', async () => {
    installCommitMock();

    const result = await commitImportJob({
      tenantId: TENANT,
      jobId: 42,
      idempotencyKey: 'commit-42',
      committedBy: USER_UID,
      files: [
        { file_kind: 'patient', source_filename: 'patients.csv', csv_text: fixture('patients-valid.csv') },
        { file_kind: 'encounter', source_filename: 'encounters.csv', csv_text: fixture('encounters-valid.csv') },
        { file_kind: 'opening_ar', source_filename: 'opening-ar.csv', csv_text: fixture('opening-ar-valid.csv') },
      ],
    });

    expect(result.report.phi_redacted).toBe(true);
    expect(result.report.opening_balance_totals.amount_paise).toBe(120050);
    expect(result.records.map((record) => record.target_kind)).toEqual(['patient', 'encounter', 'opening_ar']);
    expect(postLedgerEntryMock).toHaveBeenCalledTimes(1);
    expect(postLedgerEntryMock.mock.calls[0][1]).toMatchObject({
      tenantId: TENANT,
      entryType: 'OPENING_BALANCE',
      idempotencyKey: 'migration-opening-ar-42-BILL-1001',
    });
    const lines = postLedgerEntryMock.mock.calls[0][1].lines;
    expect(lines.reduce((sum, line) => sum + line.amountPaise, 0)).toBe(0);

    const sql = queryUnsafeMock.mock.calls.map(sqlText).join('\n');
    expect(sql).toMatch(/INSERT INTO users/);
    expect(sql).toMatch(/INSERT INTO patient_identifiers/);
    expect(sql).toMatch(/INSERT INTO admissions/);
    expect(sql).toMatch(/INSERT INTO patient_encounters/);
    expect(sql).toMatch(/INSERT INTO billing_invoices/);
    expect(sql).toMatch(/INSERT INTO migration_acceptance_reports/);
  });

  it('replays an existing committed batch without authoritative writes', async () => {
    installCommitMock({ replayBatch: true });

    const result = await commitImportJob({
      tenantId: TENANT,
      jobId: 42,
      idempotencyKey: 'commit-42',
      committedBy: USER_UID,
      files: [
        { file_kind: 'patient', source_filename: 'patients.csv', csv_text: fixture('patients-valid.csv') },
      ],
    });

    expect(result.replayed).toBe(true);
    const sql = queryUnsafeMock.mock.calls.map(sqlText).join('\n');
    expect(sql).not.toMatch(/INSERT INTO users/);
    expect(sql).not.toMatch(/INSERT INTO billing_invoices/);
    expect(postLedgerEntryMock).not.toHaveBeenCalled();
  });

  it('queues merge review instead of silently overwriting an existing phone match', async () => {
    installCommitMock({ phoneConflict: true });

    const result = await commitImportJob({
      tenantId: TENANT,
      jobId: 42,
      idempotencyKey: 'commit-conflict',
      committedBy: USER_UID,
      files: [
        { file_kind: 'patient', source_filename: 'patients.csv', csv_text: fixture('patients-valid.csv') },
      ],
    });

    expect(result.records[0]).toMatchObject({
      target_kind: 'patient',
      status: 'conflict',
      action: 'queued_conflict',
    });
    const sql = queryUnsafeMock.mock.calls.map(sqlText).join('\n');
    expect(sql).toMatch(/INSERT INTO migration_merge_queue_items/);
    expect(sql).not.toMatch(/INSERT INTO users/);
  });
});

describe('migrationToolkitService HL7 ADT import', () => {
  it('parses ADT batches and feeds the shared commit path', async () => {
    installCommitMock();
    queryUnsafeMock.mockImplementation((sql, ...params) => {
      const text = String(sql);
      if (/FROM migration_import_jobs/i.test(text)) {
        return Promise.resolve([{ id: 42, tenant_id: TENANT, import_kind: 'hl7_adt', status: 'report_ready' }]);
      }
      if (/FROM migration_hl7_adt_batches/i.test(text)) return Promise.resolve([]);
      if (/INSERT INTO migration_hl7_adt_batches/i.test(text)) {
        return Promise.resolve([{
          id: 55,
          uid: 'hl7-batch-55',
          tenant_id: params[0],
          job_id: params[1],
          status: 'processing',
          idempotency_key: params[5],
          summary: JSON.parse(params[7]),
          accepted_count: 0,
          rejected_count: 0,
        }]);
      }
      if (/INSERT INTO migration_hl7_adt_messages/i.test(text)) return Promise.resolve([]);
      if (/UPDATE migration_hl7_adt_batches/i.test(text)) return Promise.resolve([]);
      if (/UPDATE migration_hl7_adt_messages/i.test(text)) return Promise.resolve([]);
      return installCommitMockReturn(sql, params);
    });

    function installCommitMockReturn(sql, params) {
      const text = String(sql);
      if (/FROM migration_commit_batches/i.test(text)) return Promise.resolve([]);
      if (/INSERT INTO migration_commit_batches/i.test(text)) {
        return Promise.resolve([{
          id: 501,
          uid: 'batch-501',
          tenant_id: params[0],
          job_id: params[1],
          status: 'committing',
          idempotency_key: params[2],
          acceptance_summary: {},
          opening_balance_totals: {},
          rollback_plan: {},
          replay_proof: {},
          committed_at: new Date().toISOString(),
        }]);
      }
      if (/FROM patient_identifiers/i.test(text)) return Promise.resolve([]);
      if (/SELECT uid, id\s+FROM users/i.test(text)) return Promise.resolve([]);
      if (/INSERT INTO users/i.test(text)) return Promise.resolve([{ uid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', id: 777 }]);
      if (/INSERT INTO patient_identifiers/i.test(text)) return Promise.resolve([{ id: 800, patient_uid: params[1] }]);
      if (/FROM admissions/i.test(text)) return Promise.resolve([]);
      if (/INSERT INTO admissions/i.test(text)) return Promise.resolve([{ id: 701, encounter_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }]);
      if (/FROM patient_encounters/i.test(text)) return Promise.resolve([]);
      if (/INSERT INTO patient_encounters/i.test(text)) return Promise.resolve([{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }]);
      if (/INSERT INTO migration_commit_records/i.test(text)) {
        return Promise.resolve([{
          id: 301 + queryUnsafeMock.mock.calls.length,
          uid: 'commit-record',
          tenant_id: params[0],
          commit_batch_id: params[1],
          job_id: params[2],
          import_record_id: params[3],
          target_kind: params[4],
          source_key: params[5],
          row_hash: params[6],
          status: params[7],
          action: params[8],
          target_table: params[9],
          target_id: params[10],
          target_uid: params[11],
          idempotency_key: params[12],
          rollback_payload: JSON.parse(params[13]),
          replay_proof: JSON.parse(params[14]),
          error_redacted: params[15],
          metadata: JSON.parse(params[16]),
        }]);
      }
      if (/UPDATE migration_commit_batches/i.test(text)) return Promise.resolve([]);
      if (/UPDATE migration_import_jobs/i.test(text)) return Promise.resolve([]);
      if (/INSERT INTO migration_acceptance_reports/i.test(text)) {
        return Promise.resolve([{
          id: 601,
          uid: 'report-601',
          tenant_id: params[0],
          job_id: params[1],
          commit_batch_id: params[2],
          status: 'accepted',
          phi_redacted: true,
          report_json: JSON.parse(params[3]),
          acceptance_summary: JSON.parse(params[4]),
          opening_balance_totals: JSON.parse(params[5]),
          rollback_proof: JSON.parse(params[6]),
          replay_proof: JSON.parse(params[7]),
          generated_by: params[8],
        }]);
      }
      return Promise.resolve([]);
    }

    const result = await importHl7AdtBatch({
      tenantId: TENANT,
      jobId: 42,
      idempotencyKey: 'adt-batch-42',
      committedBy: USER_UID,
      messages: [fixture('adt-a01.hl7')],
    });

    expect(result.hl7_batch.status).toBe('committed');
    expect(result.records.map((record) => record.target_kind)).toEqual(['patient', 'encounter']);
    const sql = queryUnsafeMock.mock.calls.map(sqlText).join('\n');
    expect(sql).toMatch(/INSERT INTO migration_hl7_adt_batches/);
    expect(sql).toMatch(/INSERT INTO migration_hl7_adt_messages/);
    expect(sql).toMatch(/INSERT INTO admissions/);
  });
});
