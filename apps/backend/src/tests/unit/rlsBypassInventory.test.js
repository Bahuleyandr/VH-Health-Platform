import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { collectCatalog, parseCatalog, reachableBypassRoles, renderInventory } from '../../../scripts/rls-bypass-inventory.mjs';
import { CONFIRMED_SITES, owningModule, parseModelTables, relocateSites, scanWriters, tableReferences } from '../../../scripts/lib/rlsInventorySource.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/rls-inventory-catalog.json', import.meta.url), 'utf8'));
const clone = () => structuredClone(fixture);

describe('RLS bypass catalog inventory', () => {
  it('classifies actual restrictive flags by schema and preserves scoped policy limitations', () => {
    const report = parseCatalog(clone());
    expect(report.tables).toHaveLength(5);
    expect(report.tables.filter((table) => !table.restrictive.length).map((table) => table.key)).toEqual([
      'public.open_rows', 'public.misleading_name',
    ]);
    expect(report.tables.find((table) => table.key === 'public.closed_rows').restrictive[0]).toMatchObject({
      policyname: 'explicit_tenant_context_753', with_check: null,
    });
    expect(report.tables.find((table) => table.key === 'public.insert_only')).toMatchObject({
      rls_enabled: false, force_rls: false,
      restrictive: [expect.objectContaining({ cmd: 'INSERT', roles: ['vhhealth_app'], with_check: 'true' })],
    });
  });

  it('parses false strings as false and distinguishes SET ROLE from inherited membership', () => {
    const report = parseCatalog(clone());
    expect(report.roles.find((role) => role.rolname === 'maintenance')).toMatchObject({ rolsuper: false, rolbypassrls: true });
    expect(report.tables.find((table) => table.tablename === 'misleading_name').force_rls).toBe(false);
    expect(reachableBypassRoles('operator', report.roles, report.memberships)).toEqual(['maintenance']);
    expect(reachableBypassRoles('vhhealth_app', report.roles, report.memberships)).toEqual([]);
    report.memberships.push({ member: 'maintenance', role: 'operator', set_option: true });
    expect(reachableBypassRoles('operator', report.roles, report.memberships)).toEqual(['maintenance']);
  });

  it.each(['tables', 'roles'])('refuses an empty %s population', (key) => {
    const empty = clone();
    empty[key] = [];
    expect(() => parseCatalog(empty)).toThrow('nonempty role/table populations');
  });

  it('refuses malformed flags and duplicate relation identities', () => {
    const bad = clone();
    bad.roles[0].rolsuper = 'unknown';
    expect(() => parseCatalog(bad)).toThrow('Invalid catalog boolean');
    const duplicate = clone();
    duplicate.tables.push(duplicate.tables[0]);
    expect(() => parseCatalog(duplicate)).toThrow('Duplicate tenant table rows');
  });

  it('collects catalog rows in one read-only transaction and rolls back on failure', async () => {
    const statements = [];
    const client = { query: jest.fn(async (sql) => {
      statements.push(sql);
      if (sql.includes('pg_catalog.pg_roles ORDER')) { throw new Error('catalog access denied'); }
      return { rows: clone().metadata };
    }) };
    await expect(collectCatalog(client)).rejects.toThrow('catalog access denied');
    expect(statements[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements.every((sql) => /^(?:BEGIN|SELECT|ROLLBACK)/.test(sql))).toBe(true);
  });

  it('renders the measured population, absent named roles, FORCE risks and unresolved decisions', () => {
    const report = parseCatalog(clone());
    const source = { writers: new Map(), sites: [], roleUses: new Map(), bypassUses: [], migrationRoles: new Map() };
    const text = renderInventory(report, source, { date: '2026-09-08', revision: 'fixture-sha' });
    expect(text).toContain('| Tenant-bearing tables | 5 |');
    expect(text).toContain('| Without any RESTRICTIVE policy | 2 |');
    expect(text).toContain('| vhhealth_runtime | ABSENT from target cluster |');
    expect(text).toContain('| public.misleading_name | owner | yes / no | yes | no | none | owner to decide |');
    expect(text).toContain('UNASSIGNED — no static writer located (2)');
    expect(text).toContain('Presence alone does not prove');
    expect(text).not.toContain('postgresql://');
  });
});

describe('RLS audit source inventory', () => {
  it('relocates declarations, methods and inline routes without matching comments or other functions', () => {
    const file = 'apps/backend/src/routes/sample.js';
    const source = [
      '// export const target = async () => { UPDATE wrong SET value = 1; }',
      'export const target = async () => {',
      '  return db.query(`UPDATE public.rows SET value = 1 WHERE id = $1 RETURNING id`);',
      '};',
      'class Service { async remove() { return db.query("DELETE FROM rows WHERE id = $1"); } }',
      "router.patch('/data-rights/:id', async () => db.query('UPDATE requests SET x = 1'));",
    ].join('\n');
    const definitions = [
      { file, symbol: 'target', match: /UPDATE public.rows/ },
      { file, symbol: 'remove', match: /DELETE FROM rows/ },
      { file, symbol: 'PATCH /data-rights/:id', match: /UPDATE requests/ },
    ];
    const results = relocateSites(new Map([[file, source]]), definitions);
    expect(results.map((entry) => entry.line)).toEqual([2, 5, 6]);
    expect(results[0]).toMatchObject({ statementLines: [3], tables: ['public.rows'] });
    expect(() => relocateSites(new Map([[file, source]]), [{ file, symbol: 'absent', match: /UPDATE/ }])).toThrow('Expected one symbol');
    expect(() => relocateSites(new Map([[file, source]]), [{ file, symbol: 'target', match: /DELETE/ }])).toThrow('No audit statement');
  });

  it('records raw SQL and model writers while separating readers and retaining shared ownership', () => {
    const models = parseModelTables('model WardRow {\n id Int\n @@map("wards")\n}\n');
    const sources = new Map([
      ['apps/backend/src/services/bed/service.js', 'db.query(`UPDATE wards SET name = $1`);'],
      ['apps/backend/src/services/staff/roster.js', 'prisma.wardRow.update({ where: { id: 1 } });'],
      ['apps/backend/src/controllers/bed/read.js', 'db.query("SELECT id FROM wards");'],
    ]);
    const writers = scanWriters(sources, models).get('public.wards');
    expect(writers).toHaveLength(2);
    expect(owningModule(writers)).toBe('apps/backend/src/services/bed + apps/backend/src/services/staff');
    expect(tableReferences('SELECT w.id FROM "custom"."wards" w JOIN users u ON true')).toEqual(['custom.wards', 'public.users']);
    expect(tableReferences('SELECT id FROM wards', true)).toEqual([]);
    expect(tableReferences('/* UPDATE decoy SET x = 1 */ UPDATE wards SET name = $1', true)).toEqual(['public.wards']);
  });

  it('excludes CTE names and EXTRACT operands from the catalog-backed table list', () => {
    const file = 'apps/backend/src/services/report.js';
    const sources = new Map([[file, 'function report() { return db.query(`WITH recent AS (SELECT EXTRACT(EPOCH FROM w.created_at) FROM wards w) SELECT * FROM recent`); }']]);
    const [entry] = relocateSites(sources, [{ file, symbol: 'report', match: /WITH recent/ }], new Set(['public.wards']));
    expect(entry.tables).toEqual(['public.wards']);
  });

  it('relocates all 22 approved groups on the checkout and retains the three SLA aggregates', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
    const sources = new Map(CONFIRMED_SITES.map((entry) => [entry.file, readFileSync(path.join(root, entry.file), 'utf8')]));
    const located = relocateSites(sources);
    expect(located).toHaveLength(22);
    expect(located.every((entry) => entry.line > 0 && entry.statementLines.length > 0 && entry.tables.length > 0)).toBe(true);
    expect(located.find((entry) => entry.auditLine === 574).statementLines).toHaveLength(3);
    expect(located.find((entry) => entry.symbol === 'getAllCleaningLogs').statementLines).toHaveLength(2);
  });
});
