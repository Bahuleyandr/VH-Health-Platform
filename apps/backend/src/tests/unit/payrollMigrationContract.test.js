import { readdirSync, readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL('../../migrations/669_payroll_attempt_document_delivery.sql', import.meta.url),
  'utf8',
);
const tenantKekProvider = readFileSync(
  new URL('../../services/security/tenantKekProvider.js', import.meta.url),
  'utf8',
);
const kekVersioningMigration = readFileSync(
  new URL('../../migrations/672_tenant_kek_versioned_reprovision.sql', import.meta.url),
  'utf8',
);

test('migration fails ambiguous staff identity before adding authoritative uniqueness', () => {
  const duplicatePreflight = migration.indexOf('resolve the authoritative staff identity before migration 669');
  const uniqueIndex = migration.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS ux_staff_tenant_user_identity');

  expect(duplicatePreflight).toBeGreaterThan(0);
  expect(uniqueIndex).toBeGreaterThan(duplicatePreflight);
  expect(migration).not.toMatch(/DELETE\s+FROM\s+public\.staff\b/i);
});

test('attempt and document ledgers are fail-closed and immutable', () => {
  expect(migration).toContain('AS RESTRICTIVE');
  expect(migration).toContain("current_setting('app.current_tenant_id', true) <> 'bypass'");
  expect(migration).toContain('NEW.credential_ciphertext IS DISTINCT FROM OLD.credential_ciphertext');
  expect(migration).toContain('NEW.object_token IS DISTINCT FROM OLD.object_token');
  expect(migration).toContain("status IN ('prepared', 'uploaded', 'delivery_queued', 'notification_accepted')");
  expect(migration).toContain('UNIQUE (tenant_id, notification_outbox_id)');
  expect(migration).toContain('tenant v1 KEK material is immutable; use a versioned rotation path');
});

test('tenant KEK provisioning cannot overwrite material under the fixed v1 key id', () => {
  expect(tenantKekProvider).toContain('ON CONFLICT (tenant_id, key_id) DO NOTHING');
  expect(tenantKekProvider).not.toMatch(
    /ON CONFLICT \(tenant_id, key_id\) DO UPDATE SET\s+wrapped_key_material/i,
  );
});

test('672 makes tenant KEK material write-once for EVERY version, not just v1', () => {
  expect(readdirSync(new URL('../../migrations/', import.meta.url)).filter(name => name.startsWith('672_')))
    .toEqual(['672_tenant_kek_versioned_reprovision.sql']);
  expect(kekVersioningMigration).toContain("SET LOCAL lock_timeout = '10s'");
  expect(kekVersioningMigration).toContain("SET LOCAL statement_timeout = '60s'");
  // Version-generic: 669 only ever matched `t:<tenant>:v1`, so a rotation would
  // have left later versions unguarded.
  expect(kekVersioningMigration).toContain("OLD.key_id ~ ('^t:' || OLD.tenant_id::text || ':v[0-9]+$')");
  // Clearing (the crypto-shred) is the ONLY permitted material transition; both
  // replacing live material and refilling a shredded row are refused.
  expect(kekVersioningMigration).toContain(
    'OLD.wrapped_key_material IS DISTINCT FROM NEW.wrapped_key_material',
  );
  expect(kekVersioningMigration).toContain('NEW.wrapped_key_material IS NOT NULL');
  expect(kekVersioningMigration).not.toContain('OLD.wrapped_key_material IS NOT NULL');
  expect(kekVersioningMigration).toContain('tenant KEK material is immutable');
});

test('crypto-shred clears every version and re-provisioning allocates the next one', () => {
  // The shred must NULL the material (status alone would leave it recoverable)
  // across all versions of the tenant's key.
  expect(tenantKekProvider).toMatch(/UPDATE encryption_keys[\s\S]*wrapped_key_material = NULL/);
  expect(tenantKekProvider).toMatch(
    /UPDATE encryption_keys[\s\S]*key_id ~ \('\^t:' \|\| tenant_id::text \|\| ':v\[0-9\]\+\$'\)/,
  );
  // Re-provision allocates predecessor.version + 1 rather than reusing a key id.
  expect(tenantKekProvider).toContain('const version = (predecessor?.version ?? 0) + 1;');
  expect(tenantKekProvider).toContain('tenantKeyId(tenantId, version)');
});

test('legacy signed-unissued payroll and mutable cross-attempt identity fail closed', () => {
  expect(migration).toContain('signed legacy payroll contains an unissued payslip');
  expect(migration).toMatch(
    /FOREIGN KEY \(tenant_id, payslip_id, payroll_run_id, attempt_token, staff_uid\)/,
  );
  expect(migration).toContain("WHERE status IS DISTINCT FROM 'superseded'");
});
