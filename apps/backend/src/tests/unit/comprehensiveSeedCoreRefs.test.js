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
});
