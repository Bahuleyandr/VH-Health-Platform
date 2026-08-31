import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SEEDER_PATH = path.resolve(
  __dirname,
  '../../../scripts/seed-comprehensive-test-data.mjs',
);

/**
 * The seeder is prettier-formatted under apps/backend/.prettierrc, whose
 * `arrowParens: "avoid"` drops the parentheses around a single parameter —
 * `ctx => ...`, not `(ctx) => ...`. Binding on one rendering made these
 * assertions fail the moment the file was formatted, so match either form and
 * pin the substance instead: the named column, on its own (a `\b` before it
 * keeps `classification_signed_by` from satisfying a `signed_by` check), taking
 * the signing doctor's uid and nothing longer.
 */
function signedByDoctor(column) {
  return new RegExp(`\\b${column}: \\(?ctx\\)? => ctx\\.doctor\\.uid(?![\\w.])`);
}

function overrideBlock(source, table, nextTable) {
  const pattern = new RegExp(
    `\\n  ${table}: \\{([\\s\\S]*?)(?=\\n  ${nextTable}: \\{)`,
  );
  return source.match(pattern)?.[1] || '';
}

describe('structured Radiology/AP comprehensive seed overrides', () => {
  let blocks;

  beforeAll(() => {
    const source = fs.readFileSync(SEEDER_PATH, 'utf8');
    blocks = {
      radiology: overrideBlock(source, 'radiology_orders', 'radiology_report_addenda'),
      radiologyAddendum: overrideBlock(source, 'radiology_report_addenda', 'ap_reports'),
      pathology: overrideBlock(source, 'ap_reports', 'ap_report_addenda'),
      pathologyAddendum: overrideBlock(source, 'ap_report_addenda', 'workflow_sla_instances'),
    };
  });

  it.each([
    ['Radiology', 'radiology', 'radiology', '0', 'report_signed_off_by'],
    ['AP', 'pathology', 'ap', '2', 'signed_by'],
  ])('seeds a complete version-one %s specialist sign-off', (
    _label,
    key,
    idempotencyPrefix,
    hashDigit,
    sourceSignerColumn,
  ) => {
    expect(blocks[key]).toMatch(/result_classification: 'normal'/);
    expect(blocks[key]).toMatch(/classification_basis: JSON\.stringify\(\{ explicit_normal_flag: true, seed: true \}\)/);
    expect(blocks[key]).toMatch(/report_generation_version: 1/);
    expect(blocks[key]).toMatch(signedByDoctor(sourceSignerColumn));
    expect(blocks[key]).toMatch(signedByDoctor('classification_signed_by'));
    expect(blocks[key]).toContain(
      `signoff_idempotency_key: 'seed-${idempotencyPrefix}-signoff-v1'`,
    );
    expect(blocks[key]).toContain(`signoff_request_sha256: '${hashDigit}'.repeat(64)`);
  });

  it.each([
    ['Radiology', 'radiologyAddendum', 'radiology', '1', 'signed_by'],
    ['AP', 'pathologyAddendum', 'ap', '3', 'addendum_by'],
  ])('seeds a complete version-two %s addendum', (
    _label,
    key,
    idempotencyPrefix,
    hashDigit,
    signerColumn,
  ) => {
    expect(blocks[key]).toMatch(/generation_version: 2/);
    expect(blocks[key]).toMatch(/previous_classification: 'normal'/);
    expect(blocks[key]).toMatch(/result_classification: 'normal'/);
    expect(blocks[key]).toMatch(/clinical_significance: 'unchanged'/);
    expect(blocks[key]).toMatch(signedByDoctor(signerColumn));
    expect(blocks[key]).toContain(
      `idempotency_key: 'seed-${idempotencyPrefix}-addendum-v2'`,
    );
    expect(blocks[key]).toContain(`request_sha256: '${hashDigit}'.repeat(64)`);
  });
});
