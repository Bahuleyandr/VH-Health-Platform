import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seederPath = path.resolve(__dirname, '../../../scripts/seed-comprehensive-test-data.mjs');

describe('C3.2a comprehensive seed boundary', () => {
  test('keeps edge grants, revocations, and log receipts intentionally empty', () => {
    const source = fs.readFileSync(seederPath, 'utf8');

    expect(source).toContain('const INTENTIONALLY_EMPTY_TABLES = new Set([');
    expect(source).toContain("'clinical_continuity_edge_access_grants'");
    expect(source).toContain("'clinical_continuity_edge_access_revocations'");
    expect(source).toContain("'clinical_continuity_edge_log_receipts'");
    expect(source).toContain('!INTENTIONALLY_EMPTY_TABLES.has(table)');
    expect(source).toContain('intentionallyEmptyAppTables: intentionallyEmpty');
  });
});
