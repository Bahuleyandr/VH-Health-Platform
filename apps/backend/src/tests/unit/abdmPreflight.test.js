import { jest } from '@jest/globals';

import { checkCanonicalAbhaDuplicates } from '../../../scripts/lib/abdmPreflight.mjs';

describe('ABDM migration preflight', () => {
  test('checks canonical ABHA duplicates per tenant without returning identifiers', async () => {
    const query = jest.fn(async () => ({
      rows: [{ duplicate_groups: 2, duplicate_rows: 5 }],
    }));

    await expect(checkCanonicalAbhaDuplicates({ query })).resolves.toEqual({
      duplicateGroups: 2,
      duplicateRows: 5,
    });

    const sql = query.mock.calls[0][0];
    expect(sql).toMatch(/GROUP BY tenant_id, regexp_replace\(abha_number, '-', '', 'g'\)/i);
    expect(sql).toMatch(/HAVING count\(\*\) > 1/i);
    expect(sql).not.toMatch(/SELECT\s+tenant_id\s*,\s*canonical_abha/i);
  });

  test('reports a clean database as zero duplicate groups', async () => {
    const query = jest.fn(async () => ({
      rows: [{ duplicate_groups: 0, duplicate_rows: 0 }],
    }));

    await expect(checkCanonicalAbhaDuplicates({ query })).resolves.toEqual({
      duplicateGroups: 0,
      duplicateRows: 0,
    });
  });
});
