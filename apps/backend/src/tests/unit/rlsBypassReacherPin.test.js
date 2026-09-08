import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTablePin } from '../../../scripts/lib/rlsBypassReacherPin.mjs';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const expected = JSON.parse(
  readFileSync(
    path.join(backend, '../../docs/security/rls-bypass-reacher-pin-2026-09-08.json'),
    'utf8'
  )
);
let actual;
beforeAll(() => {
  actual = JSON.parse(
    execFileSync(
      process.execPath,
      ['--max-old-space-size=4096', 'scripts/rls-bypass-reacher-census.mjs', '--json'],
      {
        cwd: backend,
        encoding: 'utf8',
        timeout: 600000,
        maxBuffer: 32 * 1024 * 1024
      }
    )
  );
}, 610000);

it.each(expected.tables.map(row => row.table))(
  '%s pins the exact statement list, disposition owner and N = M + K',
  table => {
    expect(() =>
      assertTablePin(
        actual.tables.find(row => row.table === table),
        expected.tables.find(row => row.table === table)
      )
    ).not.toThrow();
  }
);

it('measures a nonempty entry/job population and pins every registration', () => {
  expect(actual.tables).toHaveLength(22);
  expect(actual.registrations.length).toBeGreaterThan(0);
  expect(actual.registrations).toEqual(expected.registrations);
  expect(actual.entryPoints).toEqual(expected.entryPoints);
  expect(actual.counts.sources).toBe(expected.counts.sources);
  expect(actual.sourceManifest).toEqual(expected.sourceManifest);
  expect(actual.directPgImports).toEqual(expected.directPgImports);
  expect(
    actual.directPgImports.filter(row => row.file.startsWith('apps/backend/src/'))
  ).toHaveLength(4);
  expect(actual.counts.sql).toBeGreaterThan(0);
  expect(actual.migrationStatementPopulation).toBeGreaterThan(0);
});

it('keeps census status distinct from completed runtime dispositions', () => {
  expect(actual.kind).toBe('CENSUS_ONLY');
  for (const table of actual.tables) {
    expect(table.dispositioned).toBe(0);
    expect(table.sourceTableStatementCandidates).toBeGreaterThan(0);
    expect(table.entries.every(entry => entry.status === 'PENDING')).toBe(true);
  }
});
