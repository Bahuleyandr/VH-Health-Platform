#!/usr/bin/env node
import prisma, { ensureTenantRlsRuntimeRoleGrants } from '../src/lib/prisma.js';
import logger from '../src/logging/logger.js';

// Single-DSN environments (the dalekdefender rig's hand-run copy of the
// PreSync Job, local QA) have no runtime role configured and no
// vhhealth_runtime login role in the database at all. Only that exact
// configuration-absent skip is tolerable, and only on explicit opt-in — the
// canonical PreSync Job does not set this, so production still fails closed
// if the configmap ever loses AUTH_TENANT_RLS_RUNTIME_ROLE. An unsafe role
// name, a grant error, or a bad posture always fails regardless of the knob.
const tolerateMissingRole = process.env.RUNTIME_ROLE_GRANTS_OPTIONAL === 'true';

let failed = false;
try {
  const result = await ensureTenantRlsRuntimeRoleGrants();
  if (result.skipped && result.reason === 'no_runtime_role_configured' && tolerateMissingRole) {
    logger.warn(
      'Runtime role grant pass skipped: no runtime role configured and RUNTIME_ROLE_GRANTS_OPTIONAL=true — RLS runtime-role posture NOT verified',
      { reason: result.reason },
    );
  } else {
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
              has_table_privilege($1::name, 'public._migrations', 'SELECT') AS app_tracker_read,
              has_table_privilege($1::name, 'public._migrations', 'INSERT') AS app_tracker_insert,
              has_table_privilege($1::name, 'public._migrations', 'UPDATE') AS app_tracker_update,
              has_table_privilege($1::name, 'public._migrations', 'DELETE') AS app_tracker_delete,
              has_table_privilege($1::name, 'public._migrations', 'TRUNCATE') AS app_tracker_truncate,
              has_table_privilege('vhhealth_runtime', 'public._migrations', 'SELECT') AS runtime_tracker_read,
              has_table_privilege('vhhealth_runtime', 'public._migrations', 'INSERT') AS runtime_tracker_insert,
              has_table_privilege('vhhealth_runtime', 'public._migrations', 'UPDATE') AS runtime_tracker_update,
              has_table_privilege('vhhealth_runtime', 'public._migrations', 'DELETE') AS runtime_tracker_delete,
              has_table_privilege('vhhealth_runtime', 'public._migrations', 'TRUNCATE') AS runtime_tracker_truncate,
              has_sequence_privilege($1::name, 'public._migrations_id_seq', 'USAGE') AS app_tracker_sequence,
              has_sequence_privilege('vhhealth_runtime', 'public._migrations_id_seq', 'USAGE') AS runtime_tracker_sequence
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
      || posture.app_tracker_read !== true
      || posture.runtime_tracker_read !== true
      || posture.app_tracker_insert === true
      || posture.app_tracker_update === true
      || posture.app_tracker_delete === true
      || posture.app_tracker_truncate === true
      || posture.runtime_tracker_insert === true
      || posture.runtime_tracker_update === true
      || posture.runtime_tracker_delete === true
      || posture.runtime_tracker_truncate === true
      || posture.app_tracker_sequence === true
      || posture.runtime_tracker_sequence === true) {
      throw new Error('runtime roles are absent, unsafe, or have write access to the migration tracker');
    }
    logger.info('Runtime role grants completed under the migration owner', { role: result.role });
  }
} catch (err) {
  failed = true;
  logger.error('Runtime role grant pass failed', { error: err?.message });
} finally {
  await prisma.$disconnect().catch(() => {});
}

if (failed) process.exitCode = 1;
