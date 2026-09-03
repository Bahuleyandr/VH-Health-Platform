import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../scripts/seed-comprehensive-test-data.mjs'),
  'utf8',
);

describe('comprehensive seed core references', () => {
  test('materializes the DOCTOR profile before appointment references are read', () => {
    const doctorProfile = source.indexOf("if (role === 'DOCTOR')");
    const firstCoreRefsRead = source.indexOf('const refs = await getCoreRefs()');

    expect(doctorProfile).toBeGreaterThan(0);
    expect(doctorProfile).toBeLessThan(firstCoreRefsRead);
    expect(source).toContain('INSERT INTO doctors');
    expect(source).toContain('AND user_id = $2::integer');
    expect(source).toContain('AND tenant_id = $5::uuid');
  });

  test('defers missing foreign-key parents instead of inventing typed identifiers', () => {
    const fkResolver = source.slice(
      source.indexOf('async function fkValue'),
      source.indexOf('async function rowForTable'),
    );

    expect(fkResolver).toContain('return undefined;');
    expect(fkResolver).not.toContain("foreign_column_name === 'id'");
    expect(source).toContain('Seed dependency ${fk.foreign_table_name}.${fk.foreign_column_name} is empty');
  });

  test('forces deferred constraints and rejects incomplete seeds before commit', () => {
    const finalization = source.slice(
      source.lastIndexOf('const finalSweep = await seedRemainingTables()'),
      source.lastIndexOf("console.log(JSON.stringify"),
    );

    expect(finalization).toContain("await client.query('SET CONSTRAINTS ALL IMMEDIATE')");
    expect(finalization).toContain('assertComprehensiveSeedComplete(summary)');
    expect(finalization.indexOf('assertComprehensiveSeedComplete(summary)'))
      .toBeLessThan(finalization.indexOf("await client.query('COMMIT')"));
    expect(source).toContain('summary.emptyAppTables.length > 0');
    expect(source).toContain('summary.failed.map');
  });

  test('uses UUID seed values for UUID claim tokens', () => {
    expect(source).toContain(
      "return column.udt_name === 'uuid' ? ctx.generatedUuid : ctx.invoiceId;",
    );
  });

  test('derives event types from CHECK definitions instead of pinning them', () => {
    // body_custody_events, facility_asset_events and pharmacy_funding_decision_events
    // used to pin event_type in TABLE_COLUMN_SEED_OVERRIDES because checkedValue()
    // returned whichever definition the catalog listed first. The column-bound
    // module derives 'receive', 'created' and 'LINE_MATERIALIZED' from the
    // definitions alone (see comprehensiveSeedCheckedValue.test.js), so the pins
    // are gone and must not come back.
    expect(source).toContain(
      "import { columnBoundValue } from './lib/checkConstraintValues.mjs';",
    );
    expect(source).toContain(
      'return columnBoundValue(checksByTable.get(table) || [], column.column_name);',
    );
    expect(source).not.toMatch(/facility_asset_events:\s*\{/);
    expect(source).not.toMatch(/body_custody_events:\s*\{/);
    expect(source).not.toMatch(/event_type: 'LINE_MATERIALIZED'/);
  });
});
