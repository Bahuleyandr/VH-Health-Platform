import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildTestDatabaseSchemaResetSql,
  TEST_DATABASE_RESET_PUBLICATIONS,
} from '../../../scripts/lib/testDatabaseReset.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(testDir, '..', '..', 'migrations');

function migrationPublicationNames() {
  const names = new Set();
  for (const filename of fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(migrationsDir, filename), 'utf8')
      .replace(/--.*$/gm, '');
    for (const match of sql.matchAll(/\bCREATE\s+PUBLICATION\s+"?([A-Za-z_][A-Za-z0-9_$]{0,62})"?/gi)) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

describe('disposable test database reset', () => {
  it('drops every migration-managed publication before recreating public', () => {
    expect([...TEST_DATABASE_RESET_PUBLICATIONS].sort()).toEqual(migrationPublicationNames());

    const sql = buildTestDatabaseSchemaResetSql();
    const publicationDrop = sql.indexOf('DROP PUBLICATION IF EXISTS "vh_analytics_pub";');
    const schemaDrop = sql.indexOf('DROP SCHEMA IF EXISTS public CASCADE;');

    expect(publicationDrop).toBeGreaterThanOrEqual(0);
    expect(schemaDrop).toBeGreaterThan(publicationDrop);
    expect(sql).toContain('CREATE SCHEMA public;');
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
  });

  it('deduplicates safe names and rejects an injectable identifier', () => {
    const sql = buildTestDatabaseSchemaResetSql(['vh_analytics_pub', 'vh_analytics_pub']);
    expect(sql.match(/DROP PUBLICATION/g)).toHaveLength(1);
    expect(() => buildTestDatabaseSchemaResetSql(['vh_analytics_pub; DROP DATABASE postgres']))
      .toThrow('Invalid PostgreSQL identifier');
  });
});
