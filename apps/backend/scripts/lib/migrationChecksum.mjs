import { createHash } from 'node:crypto';

export function migrationChecksum(sql) {
  return createHash('sha256')
    .update(String(sql ?? '').replace(/\r\n/g, '\n'), 'utf8')
    .digest('hex');
}

export function buildMigrationChecksumManifest(files, readSql) {
  return files.map((name) => ({
    name,
    checksum: migrationChecksum(readSql(name)),
  }));
}

export function evaluateMigrationChecksums(manifest, executedRows) {
  const expectedByName = new Map(manifest.map((entry) => [entry.name, entry.checksum]));
  const rows = Array.isArray(executedRows) ? executedRows : executedRows?.rows ?? [];
  const missing = [];
  const drift = [];

  for (const row of rows) {
    const expected = expectedByName.get(row?.name);
    if (!expected) continue;
    if (row.checksum == null || row.checksum === '') {
      missing.push({ name: row.name, expected });
    } else if (row.checksum !== expected) {
      drift.push({ name: row.name, recorded: row.checksum, expected });
    }
  }

  return {
    current: missing.length === 0 && drift.length === 0,
    missing,
    drift,
  };
}
