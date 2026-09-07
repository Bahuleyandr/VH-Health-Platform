// Every INSERT in dialysisService.js names tenant_id explicitly.
//
// Two of the nine did not (dialysis_serology, vascular_access) and relied on the
// column DEFAULT — COALESCE(the transaction-local GUC, DEFAULT_TENANT_ID) —
// which on a plain client stamps the DEFAULT tenant onto every other tenant's
// row. The deep suite proves the two fixed rows carry the right tenant; this
// pin stops a TENTH insert being added without one, which is how the first two
// got there.
//
// It is a source pin rather than a behavioural test on purpose: a new INSERT
// with no test of its own would pass every behavioural suite in the repo.
import fs from 'node:fs';
import path from 'node:path';

const SERVICE = path.join(process.cwd(), 'src/services/clinical/dialysisService.js');

// INSERT INTO <table> ( <column list> ) — the column list is what must name it.
const INSERT_RE = /INSERT\s+INTO\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gis;

function inserts(source) {
  const out = [];
  for (const m of source.matchAll(INSERT_RE)) {
    out.push({
      table: m[1].toLowerCase(),
      columns: m[2].replace(/\s+/g, ' ').trim(),
      line: source.slice(0, m.index).split('\n').length,
    });
  }
  return out;
}

describe('dialysisService INSERTs bind tenant_id rather than inheriting the column default', () => {
  const source = fs.readFileSync(SERVICE, 'utf8');
  const found = inserts(source);

  it('the scan has a population — the regex still matches this file', () => {
    // Without this the assertion below passes vacuously the day someone
    // reformats an INSERT so the pattern stops matching, and the pin goes
    // quiet while claiming to hold. Nine today; a tenth is fine, zero is not,
    // and a DROP is worth a second look at why.
    expect(found.length).toBeGreaterThanOrEqual(9);
    expect(found.map((i) => i.table)).toEqual(expect.arrayContaining([
      'dialysis_serology', 'vascular_access', 'dialysis_intra_obs', 'dialysis_sessions',
    ]));
  });

  it('every INSERT names tenant_id in its column list', () => {
    const missing = found
      .filter((i) => !/\btenant_id\b/i.test(i.columns))
      .map((i) => `${i.table} (line ${i.line})`);
    // If this fails on a new INSERT: bind the tenant explicitly, e.g.
    // `tenant_id` in the column list and `tenantOr(tenantId)` in the params.
    // Do NOT rely on the column DEFAULT — outside a tenant transaction it
    // resolves to DEFAULT_TENANT_ID regardless of whose row this is.
    expect(missing).toEqual([]);
  });

  it('the two that were fixed bind a uuid parameter, not a bare default', () => {
    // Guards the shape of the fix, not just the presence of the word: a
    // `tenant_id` column named but bound to DEFAULT would satisfy the test
    // above while changing nothing.
    for (const table of ['dialysis_serology', 'vascular_access']) {
      const stmt = found.find((i) => i.table === table);
      expect(stmt).toBeDefined();
      const after = source.slice(source.indexOf(`INSERT INTO ${table}`));
      const values = after.slice(0, after.indexOf('RETURNING'));
      expect(values).toMatch(/\$\d+::uuid/);
    }
  });
});
