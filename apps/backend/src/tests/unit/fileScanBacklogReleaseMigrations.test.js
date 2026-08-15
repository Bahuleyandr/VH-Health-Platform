// Shape tests for migrations 675 + 676 (the file-scan fix wave).
//
// DB-backed verification is deferred to the deep suites; these pin the SQL
// text itself — the same precedent as vitalBoundsMigration.test.js — so the
// safety-critical properties of both files cannot drift silently:
//
//   675 releases ONLY the staff_message_attachments 'failed' backlog, with no
//   DDL (no ACCESS EXCLUSIVE lock), and never touches 'quarantined'.
//   676 adds the new scan_status columns with EXACTLY the 674 vocabulary,
//   backfills 'not_scanned', and disarms the armed 'PENDING'/'pending'
//   defaults instead of introducing new ones.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FILE_SCAN_STATUS } from '../../config/fileScanPolicy.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const sql675 = read('../../migrations/675_release_staff_message_attachment_failed_backlog.sql');
const sql676 = read('../../migrations/676_file_scan_status_columns_and_default_disarm.sql');

// The exact CHECK vocabulary of migration 674, which 675/676 must mirror.
const VOCAB_674 = "('pending', 'clean', 'quarantined', 'failed', 'not_scanned')";

function statements(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !/^(BEGIN|COMMIT)$/i.test(s));
}

describe('migration 675 — release the staff_message_attachments failed backlog', () => {
  it('is a single UPDATE scoped exactly to scan_status = failed', () => {
    const stmts = statements(sql675);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatch(/^UPDATE staff_message_attachments/);
    expect(stmts[0]).toContain("SET scan_status = 'not_scanned'");
    expect(stmts[0]).toContain("WHERE scan_status = 'failed'");
  });

  it('carries NO DDL — no ACCESS EXCLUSIVE lock is ever taken (the 674-F4 lesson)', () => {
    expect(sql675).not.toMatch(/ALTER TABLE|CREATE |DROP /);
  });

  it("never releases 'quarantined' or any table other than staff_message_attachments", () => {
    const stmts = statements(sql675);
    expect(stmts.join(' ')).not.toMatch(/quarantined/);
    expect(stmts.join(' ')).not.toMatch(/file_metadata|investigation_files|consent_signatures|investigation_bookings/);
  });

  it("writes the canonical vocabulary value, and documents why 'failed' here was never a threat finding", () => {
    expect(sql675).toContain(`'${FILE_SCAN_STATUS.NOT_SCANNED}'`);
    // The header must carry the safety rationale on the record.
    expect(sql675).toMatch(/refused infected files BEFORE storage/i);
    expect(sql675).toMatch(/never-looked-at/);
  });
});

describe('migration 676 — scan-status columns + default disarm', () => {
  it('adds scan_status columns for every previously-ungated store', () => {
    expect(sql676).toMatch(/ALTER TABLE investigation_files\s+ADD COLUMN IF NOT EXISTS scan_status VARCHAR\(30\)/);
    expect(sql676).toMatch(/ALTER TABLE consent_signatures\s+ADD COLUMN IF NOT EXISTS scan_status VARCHAR\(30\)/);
    expect(sql676).toMatch(/ADD COLUMN IF NOT EXISTS slip_photo_scan_status VARCHAR\(30\)/);
    expect(sql676).toMatch(/ADD COLUMN IF NOT EXISTS result_file_scan_status VARCHAR\(30\)/);
  });

  it('every CHECK constraint carries exactly the 674 vocabulary', () => {
    const checks = sql676.match(/CHECK \([\s\S]*?\)\);/g) || [];
    expect(checks.length).toBe(4);
    for (const check of checks) {
      expect(check.replace(/\s+/g, ' ')).toContain(VOCAB_674);
    }
  });

  it("backfills every pre-existing row to 'not_scanned' before SET NOT NULL", () => {
    expect(sql676).toMatch(/UPDATE investigation_files\s+SET scan_status = 'not_scanned'\s+WHERE scan_status IS NULL/);
    expect(sql676).toMatch(/UPDATE consent_signatures\s+SET scan_status = 'not_scanned'\s+WHERE scan_status IS NULL/);
    expect(sql676).toMatch(/SET slip_photo_scan_status = 'not_scanned'\s+WHERE slip_photo_key IS NOT NULL/);
    expect(sql676).toMatch(/SET result_file_scan_status = 'not_scanned'\s+WHERE result_file_key IS NOT NULL/);
    // 674's exact case/NULL/blank-tolerant predicate, re-run idempotently.
    expect(sql676).toContain("LOWER(TRIM(COALESCE(scan_status, ''))) IN ('pending', '')");
    // The file_metadata backfill (the one potentially-slow scan) must run
    // before any ACCESS EXCLUSIVE statement exists.
    const firstUpdate = sql676.indexOf('UPDATE file_metadata');
    const firstAlter = sql676.indexOf('ALTER TABLE');
    expect(firstUpdate).toBeGreaterThan(-1);
    expect(firstUpdate).toBeLessThan(firstAlter);
  });

  it('disarms the armed defaults and makes file_metadata.scan_status NOT NULL', () => {
    expect(sql676).toMatch(/ALTER TABLE file_metadata\s+ALTER COLUMN scan_status DROP DEFAULT/);
    expect(sql676).toMatch(/ALTER TABLE file_metadata\s+ALTER COLUMN scan_status SET NOT NULL/);
    expect(sql676).toMatch(/ALTER TABLE staff_message_attachments\s+ALTER COLUMN scan_status DROP DEFAULT/);
  });

  it('introduces NO new DEFAULT anywhere — a forgetful writer must fail loudly, not mint a blocked row', () => {
    const code = statements(sql676).join(';\n'); // comments stripped
    expect(code).not.toMatch(/SET DEFAULT/);
    expect(code).not.toMatch(/ADD COLUMN[^;]*DEFAULT/i);
  });
});
