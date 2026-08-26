const POSTGRES_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

// Publications are database-scoped. Dropping public CASCADE removes their
// table memberships but leaves an empty publication object behind, so the
// migration that owns each publication cannot recreate it on a clean reset.
// The unit test scans every migration and keeps this registry exhaustive.
export const TEST_DATABASE_RESET_PUBLICATIONS = Object.freeze([
  'vh_analytics_pub',
]);

function quoteIdentifier(value) {
  if (typeof value !== 'string' || !POSTGRES_IDENTIFIER.test(value)) {
    throw new TypeError(`Invalid PostgreSQL identifier: ${String(value)}`);
  }
  return `"${value.replaceAll('"', '""')}"`;
}

export function buildTestDatabaseSchemaResetSql(
  publications = TEST_DATABASE_RESET_PUBLICATIONS,
) {
  if (!Array.isArray(publications)) {
    throw new TypeError('Test database reset publications must be an array');
  }

  const publicationDrops = [...new Set(publications)]
    .map((publication) => `DROP PUBLICATION IF EXISTS ${quoteIdentifier(publication)};`)
    .join('\n');

  return `${publicationDrops}
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pgcrypto;`;
}
