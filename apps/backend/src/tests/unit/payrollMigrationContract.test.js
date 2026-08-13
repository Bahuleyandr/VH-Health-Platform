import { readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL('../../migrations/669_payroll_attempt_document_delivery.sql', import.meta.url),
  'utf8',
);
const tenantKekProvider = readFileSync(
  new URL('../../services/security/tenantKekProvider.js', import.meta.url),
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

test('legacy signed-unissued payroll and mutable cross-attempt identity fail closed', () => {
  expect(migration).toContain('signed legacy payroll contains an unissued payslip');
  expect(migration).toMatch(
    /FOREIGN KEY \(tenant_id, payslip_id, payroll_run_id, attempt_token, staff_uid\)/,
  );
  expect(migration).toContain("WHERE status IS DISTINCT FROM 'superseded'");
});
