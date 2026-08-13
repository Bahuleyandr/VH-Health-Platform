#!/usr/bin/env node
import prisma, { ensureTenantRlsRuntimeRoleGrants } from '../src/lib/prisma.js';
import logger from '../src/logging/logger.js';

let failed = false;
try {
  const result = await ensureTenantRlsRuntimeRoleGrants();
  if (result.skipped || result.error) {
    throw new Error(result.error || `runtime role grant pass skipped: ${result.reason}`);
  }
  const roles = await prisma.$queryRawUnsafe(
    `SELECT app.rolname AS app_role,
            runtime.rolname AS runtime_role,
            runtime.rolcanlogin AS runtime_can_login,
            runtime.rolsuper AS runtime_superuser,
            runtime.rolbypassrls AS runtime_bypasses_rls,
            pg_has_role('vhhealth_runtime', $1::name, 'member') AS runtime_is_member,
            has_schema_privilege('vhhealth_runtime', 'public', 'USAGE') AS runtime_schema_usage,
            has_table_privilege('vhhealth_runtime', 'public._migrations', 'SELECT') AS runtime_tracker_read
       FROM pg_roles AS app
       CROSS JOIN pg_roles AS runtime
      WHERE app.rolname = $1::name
        AND runtime.rolname = 'vhhealth_runtime'`,
    result.role,
  );
  const posture = roles[0];
  if (!posture
    || posture.runtime_can_login !== true
    || posture.runtime_superuser === true
    || posture.runtime_bypasses_rls === true
    || posture.runtime_is_member !== true
    || posture.runtime_schema_usage !== true
    || posture.runtime_tracker_read !== true) {
    throw new Error('runtime roles are absent, unsafe, or cannot read the migration tracker');
  }
  logger.info('Runtime role grants completed under the migration owner', { role: result.role });
} catch (err) {
  failed = true;
  logger.error('Runtime role grant pass failed', { error: err?.message });
} finally {
  await prisma.$disconnect().catch(() => {});
}

if (failed) process.exitCode = 1;
