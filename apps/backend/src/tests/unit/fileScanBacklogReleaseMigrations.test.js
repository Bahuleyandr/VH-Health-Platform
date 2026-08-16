// Shape tests for migrations 675 + 676 (the file-scan fix wave) and 691
// (676's deferred contract half).
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
const sql691 = read('../../migrations/691_file_scan_status_drop_transitional_defaults.sql');

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
    //
    // Measured on the comment-stripped STATEMENT list rather than the raw
    // file: the header documents the expand/contract obligation using real
    // SQL, so a raw indexOf('ALTER TABLE') matches prose instead of an
    // executed statement. Statement order is what lock discipline is about.
    const code676 = statements(sql676).join(';\n');
    const firstUpdate = code676.indexOf('UPDATE file_metadata');
    const firstAlter = code676.indexOf('ALTER TABLE');
    expect(firstUpdate).toBeGreaterThan(-1);
    expect(firstAlter).toBeGreaterThan(-1);
    expect(firstUpdate).toBeLessThan(firstAlter);
  });

  it('disarms the armed defaults and makes file_metadata.scan_status NOT NULL', () => {
    expect(sql676).toMatch(/ALTER TABLE file_metadata\s+ALTER COLUMN scan_status DROP DEFAULT/);
    expect(sql676).toMatch(/ALTER TABLE file_metadata\s+ALTER COLUMN scan_status SET NOT NULL/);
    expect(sql676).toMatch(/ALTER TABLE staff_message_attachments\s+ALTER COLUMN scan_status DROP DEFAULT/);
  });

  it('introduces NO ARMED default — a default may never mint a permanently-blocked row', () => {
    const code = statements(sql676).join(';\n'); // comments stripped

    // #871's blackhole was a DEFAULT of 'pending' (or blank): a writer that
    // forgot the column minted a row no gate would ever release. That class of
    // default must never reappear, and no already-disarmed column may be
    // re-armed via SET DEFAULT.
    expect(code).not.toMatch(/SET DEFAULT/);
    expect(code).not.toMatch(/DEFAULT\s+'(pending|quarantined|failed|)'/i);
  });

  it('carries EXACTLY the two transitional expand-phase defaults, both released-state', () => {
    const code = statements(sql676).join(';\n'); // comments stripped

    // The two brand-new NOT NULL columns need a default for the duration of a
    // rolling deploy — the previous image's writers cannot emit a column their
    // Prisma client predates, so a NOT NULL with no default 23502s consent
    // capture and investigation-file upload on every not-yet-rolled replica.
    // 'not_scanned' is the RELEASED state, so this is not #871's hazard.
    expect(code).toMatch(
      /ALTER TABLE investigation_files\s+ADD COLUMN IF NOT EXISTS scan_status VARCHAR\(30\) DEFAULT 'not_scanned'/,
    );
    expect(code).toMatch(
      /ALTER TABLE consent_signatures\s+ADD COLUMN IF NOT EXISTS scan_status VARCHAR\(30\) DEFAULT 'not_scanned'/,
    );

    // EXACTLY two — a third would mean a new column slipped in unreviewed.
    const added = code.match(/ADD COLUMN[^;]*DEFAULT/gi) || [];
    expect(added).toHaveLength(2);

    // The investigation_bookings pair stays deliberately default-free: those
    // columns are nullable with IS NULL-tolerant CHECKs, so no writer breaks.
    expect(code).not.toMatch(/slip_photo_scan_status VARCHAR\(30\) DEFAULT/);
    expect(code).not.toMatch(/result_file_scan_status VARCHAR\(30\) DEFAULT/);
  });

  it('records the contract obligation to drop those defaults in a LATER release', () => {
    // The expand half is only safe if the contract half actually happens. A
    // migration in THIS batch would run inside the same PreSync transaction
    // and defeat the purpose, so the obligation lives in the header — pinned
    // here so it cannot be quietly dropped along with the comment.
    expect(sql676).toMatch(/CONTRACT OBLIGATION/);
    expect(sql676).toMatch(/ALTER TABLE investigation_files\s+ALTER COLUMN scan_status DROP DEFAULT/);
    expect(sql676).toMatch(/ALTER TABLE consent_signatures\s+ALTER COLUMN scan_status DROP DEFAULT/);
    expect(sql676).toMatch(/NEXT release after the fleet is/i);

    // ...and the obligation must still be OUTSTANDING: if a real DROP DEFAULT
    // for these two ever lands in this file it would run in the same PreSync
    // transaction as the ADD, so the executable statements must not contain it.
    const code = statements(sql676).join(';\n');
    expect(code).not.toMatch(/investigation_files\s+ALTER COLUMN scan_status DROP DEFAULT/);
    expect(code).not.toMatch(/consent_signatures\s+ALTER COLUMN scan_status DROP DEFAULT/);
  });
});

describe('migration 691 — the contract half of 676: drop the transitional defaults', () => {
  it('is exactly two executable statements, both catalog-only DROP DEFAULTs', () => {
    const stmts = statements(sql691);
    expect(stmts).toHaveLength(2);
    expect(stmts[0].replace(/\s+/g, ' ')).toBe(
      'ALTER TABLE investigation_files ALTER COLUMN scan_status DROP DEFAULT',
    );
    expect(stmts[1].replace(/\s+/g, ' ')).toBe(
      'ALTER TABLE consent_signatures ALTER COLUMN scan_status DROP DEFAULT',
    );
  });

  it('never re-arms a default and touches no other table', () => {
    const code = statements(sql691).join(';\n');
    expect(code).not.toMatch(/SET DEFAULT/i);
    expect(code).not.toMatch(/UPDATE /i);
    expect(code).not.toMatch(
      /file_metadata|staff_message_attachments|investigation_bookings|slip_photo_scan_status|result_file_scan_status/,
    );
  });

  it('documents itself as the deferred contract half of 676, shipped in a later release', () => {
    // 676's header owes exactly these two DROP DEFAULTs to "the NEXT release
    // after the fleet is fully rolled" — a separate file is the point: the
    // same PreSync transaction as 676 would defeat the transitional default.
    expect(sql691).toMatch(/CONTRACT half of migration 676/);
    expect(sql691).toMatch(/fails loudly at INSERT time \(23502\)/);
  });
});
