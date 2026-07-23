#!/usr/bin/env node

import process from 'node:process';

import { Client } from 'pg';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_PATHWAY_KEYS = new Set([
  'diagnostics_order_to_action',
  'referral_request_to_closure',
  'op_contact_to_recovery',
  'inpatient_admission_to_recovery',
  'emergency_arrival_to_aftercare',
  'surgery_decision_to_recovery',
]);
const ALLOWED_MODES = new Set(['off', 'shadow']);
const ADMIN_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);

function argumentValue(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function requireUuid(name) {
  const value = String(argumentValue(name) || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(value)) throw new Error(`--${name} must be an exact UUID`);
  return value;
}

function requiredText(name, max = 500) {
  const value = String(argumentValue(name) || '').trim();
  if (!value || value.length > max) throw new Error(`--${name} is required`);
  return value;
}

function databaseUrl() {
  const value = process.env.CARE_PATHWAY_MODE_DATABASE_URL
    || process.env.DATABASE_URL
    || process.env.TEST_DATABASE_URL;
  if (!value) throw new Error('A database URL is required');
  return value;
}

async function main() {
  const tenantId = requireUuid('tenant-id');
  const actorUid = requireUuid('actor-uid');
  const pathwayKey = requiredText('pathway-key', 100);
  const mode = requiredText('mode', 16).toLowerCase();
  const reason = requiredText('reason');
  const apply = hasFlag('apply');
  if (!CANONICAL_PATHWAY_KEYS.has(pathwayKey)) {
    throw new Error('--pathway-key must be one of the six canonical pathway keys');
  }
  if (!ALLOWED_MODES.has(mode)) {
    throw new Error('--mode must be off or shadow; this tool cannot activate a pathway');
  }
  if (apply && !hasFlag('acknowledge-shadow-observation')) {
    throw new Error('--apply also requires --acknowledge-shadow-observation');
  }

  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
    const actor = await client.query(
      `SELECT uid::text, UPPER(COALESCE(role, '')) AS role
         FROM users
        WHERE tenant_id = $1::uuid
          AND uid = $2::uuid
          AND is_active = TRUE
          AND LOWER(COALESCE(status, 'active')) = 'active'
        FOR SHARE`,
      [tenantId, actorUid],
    );
    if (!actor.rows[0] || !ADMIN_ROLES.has(actor.rows[0].role)) {
      throw new Error('The actor must be an active ADMIN or SUPER_ADMIN in the tenant');
    }
    const tenant = await client.query(
      `SELECT settings,
              COALESCE(settings #>> ARRAY['care_pathways', $2::text], 'off') AS previous_mode
         FROM tenants
        WHERE id = $1::uuid
        FOR UPDATE`,
      [tenantId, pathwayKey],
    );
    if (!tenant.rows[0]) throw new Error('Tenant was not found');
    const previousMode = tenant.rows[0].previous_mode;
    if (!apply) {
      await client.query('ROLLBACK');
      process.stdout.write(`${JSON.stringify({
        mode: 'dry_run',
        tenant_id: tenantId,
        pathway_key: pathwayKey,
        previous_mode: previousMode,
        requested_mode: mode,
        actor_uid: actorUid,
        reason,
      }, null, 2)}\n`);
      return;
    }

    await client.query(
      `UPDATE tenants
          SET settings = jsonb_set(
                CASE WHEN jsonb_typeof(settings) = 'object' THEN settings ELSE '{}'::jsonb END,
                ARRAY['care_pathways'],
                (
                  CASE
                    WHEN jsonb_typeof(settings -> 'care_pathways') = 'object'
                    THEN settings -> 'care_pathways'
                    ELSE '{}'::jsonb
                  END
                ) || jsonb_build_object($2::text, $3::text),
                TRUE
              ),
              updated_at = NOW()
        WHERE id = $1::uuid`,
      [tenantId, pathwayKey, mode],
    );
    await client.query(
      `INSERT INTO audit_logs
         (tenant_id, uid, role, actor_uid, action, resource, resource_id, metadata)
       VALUES
         ($1::uuid, $2::uuid, $3::text, $2::uuid,
          'CARE_PATHWAY_MODE_CHANGED', 'care_pathway', $4::text,
          jsonb_build_object(
            'previous_mode', $5::text,
            'new_mode', $6::text,
            'reason', $7::text,
            'source', 'set-care-pathway-shadow-mode.mjs'
          ))`,
      [tenantId, actorUid, actor.rows[0].role, pathwayKey, previousMode, mode, reason],
    );
    await client.query('COMMIT');
    process.stdout.write(`${JSON.stringify({
      mode: 'applied',
      tenant_id: tenantId,
      pathway_key: pathwayKey,
      previous_mode: previousMode,
      current_mode: mode,
      actor_uid: actorUid,
      reason,
    }, null, 2)}\n`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
