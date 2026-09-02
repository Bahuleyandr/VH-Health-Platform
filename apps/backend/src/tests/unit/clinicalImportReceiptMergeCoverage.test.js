import { readFileSync } from 'node:fs';

function source(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

describe('clinical import receipt patient-merge coverage', () => {
  const mergeService = source('services/patient/patientMergeService.js');
  const migration755 = source('migrations/755_clinical_import_receipt_and_history_immutability.sql');

  test('certifies both immutable receipt tables for merged-family reads', () => {
    const coveredSet = mergeService.match(
      /const MERGE_READ_UNION_COVERED_TABLES = new Set\(\[([\s\S]*?)\n\]\);/,
    );
    expect(coveredSet).not.toBeNull();
    expect(coveredSet[1]).toContain("'clinical_import_document_receipts'");
    expect(coveredSet[1]).toContain("'clinical_import_resource_receipts'");
  });

  test('keeps receipt provenance update-blocked and skipped by the merge sweep', () => {
    expect(migration755).toMatch(
      /CREATE TRIGGER clinical_import_document_receipt_append_only_755[\s\S]*BEFORE UPDATE OR DELETE ON clinical_import_document_receipts[\s\S]*clinical_import_receipt_append_only_755\(\)/,
    );
    expect(migration755).toMatch(
      /CREATE TRIGGER clinical_import_resource_receipt_append_only_755[\s\S]*BEFORE UPDATE OR DELETE ON clinical_import_resource_receipts[\s\S]*clinical_import_receipt_append_only_755\(\)/,
    );
    expect(mergeService).toMatch(
      /if \(target\.update_blocked\) \{[\s\S]*updateBlockedSkipped\.push\(`\$\{table\}\.\$\{column\}`\);[\s\S]*continue;/,
    );
    expect(mergeService).toMatch(
      /target\.update_blocked[\s\S]*MERGE_READ_UNION_COVERED_TABLES\.has\(target\.table_name\)/,
    );
  });
});
