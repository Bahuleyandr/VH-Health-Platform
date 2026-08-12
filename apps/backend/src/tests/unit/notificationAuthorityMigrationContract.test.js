import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitStatements } from '../../utils/migrations/splitStatements.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration = readFileSync(
  join(root, 'migrations', '663_notification_authority_epoch.sql'),
  'utf8',
);

describe('migration 663 notification authority contract', () => {
  it('is consumable by the production migration statement splitter', () => {
    const statements = splitStatements(migration);
    expect(statements).toHaveLength(11);
    expect(statements.at(-1)).toMatch(/COMMENT ON FUNCTION public\.revoke_notification_authority/);
  });

  it('preserves rows and forced RLS while revoking both token projections', () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS notification_epoch BIGINT NOT NULL DEFAULT 0/);
    expect(migration).toMatch(/notification_epoch = target_device\.notification_epoch \+ 1/);
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.revoke_notification_authority/);
    expect(migration).toMatch(/LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/);
    expect(migration).toMatch(/current_setting\('app\.current_tenant_id', true\)/);
    expect(migration).toMatch(/'notification-user:' \|\| p_tenant_id::TEXT \|\| ':' \|\| p_user_uid::TEXT/);
    expect(migration).toMatch(/'notification-device:' \|\| device\.device_id/);
    expect(migration).toMatch(/'notification-token:' \|\| device\.fcm_token/);
    expect(migration).toMatch(/ORDER BY candidate\.key/);
    expect(migration).toMatch(/UPDATE public\.users[\s\S]*SET device_token = NULL/);
    expect(migration).toMatch(/UPDATE public\.user_devices[\s\S]*SET fcm_token = NULL/);
    expect(migration).not.toMatch(/DELETE FROM public\.user_devices/i);
    expect(migration).not.toMatch(/(?:NO FORCE|DISABLE) ROW LEVEL SECURITY/i);
    expect(migration).not.toMatch(/DROP POLICY|CREATE POLICY/i);
    expect(migration).toMatch(/rolsuper OR role\.rolbypassrls/);
    expect(migration).toMatch(/REVOKE ALL PRIVILEGES[\s\S]*FROM PUBLIC/);
    expect(migration).toMatch(/ARRAY\['vhhealth_app', 'vhhealth_runtime'\]/);
  });
});
