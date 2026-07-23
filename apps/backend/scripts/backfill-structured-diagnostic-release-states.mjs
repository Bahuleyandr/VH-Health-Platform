import process from 'node:process';

import { Client } from 'pg';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`--${name} must be an exact UUID`);
  }
  return value;
}

function requiredText(name, max = 500) {
  const value = String(argumentValue(name) || '').trim();
  if (!value || value.length > max) throw new Error(`--${name} is required`);
  return value;
}

function connectionString() {
  const value = process.env.STRUCTURED_DIAGNOSTIC_BACKFILL_DATABASE_URL
    || process.env.DATABASE_URL
    || process.env.TEST_DATABASE_URL;
  if (!value) throw new Error('A database URL is required');
  return value;
}

async function loadCounts(client, tenantId) {
  const rows = await client.query(
    `SELECT
       (SELECT COUNT(*)::integer
          FROM diagnostic_result_generations AS generation
          LEFT JOIN diagnostic_result_release_states AS release_state
            ON release_state.tenant_id = generation.tenant_id
           AND release_state.generation_id = generation.id
         WHERE generation.tenant_id = $1::uuid
           AND generation.source_kind IN ('radiology_report', 'anatomical_pathology_report')
           AND release_state.generation_id IS NULL) AS missing_release_states,
       (SELECT COUNT(*)::integer
          FROM radiology_orders
         WHERE tenant_id = $1::uuid
           AND report_signed_off_at IS NOT NULL
           AND result_classification IS NULL) AS legacy_radiology_reports,
       (SELECT COUNT(*)::integer
          FROM ap_reports
         WHERE tenant_id = $1::uuid
           AND signed_at IS NOT NULL
           AND result_classification IS NULL) AS legacy_ap_reports,
       (SELECT COUNT(*)::integer
          FROM ap_report_addenda
         WHERE tenant_id = $1::uuid
           AND generation_version IS NULL) AS legacy_ap_addenda`,
    [tenantId],
  );
  return rows.rows[0];
}

async function main() {
  const tenantId = requireUuid('tenant-id');
  const actorUid = requireUuid('actor-uid');
  const reason = requiredText('reason');
  const apply = hasFlag('apply');
  if (apply && !hasFlag('acknowledge-patient-visibility')) {
    throw new Error('--apply also requires --acknowledge-patient-visibility');
  }

  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1::text, true)`, [tenantId]);
    const actor = await client.query(
      `SELECT UPPER(COALESCE(role, '')) AS role
         FROM users
        WHERE tenant_id = $1::uuid
          AND uid = $2::uuid
          AND is_active = TRUE
          AND LOWER(COALESCE(status, 'active')) = 'active'
          AND UPPER(COALESCE(role, '')) IN ('ADMIN', 'SUPER_ADMIN')
        FOR SHARE`,
      [tenantId, actorUid],
    );
    if (!actor.rows[0]) {
      throw new Error('The actor must be an active ADMIN or SUPER_ADMIN in the tenant');
    }
    const before = await loadCounts(client, tenantId);
    let inserted = 0;
    if (apply) {
      const result = await client.query(
        `INSERT INTO diagnostic_result_release_states
           (generation_id, tenant_id, patient_uid)
         SELECT generation.id, generation.tenant_id, generation.patient_uid
           FROM diagnostic_result_generations AS generation
           LEFT JOIN diagnostic_result_release_states AS release_state
             ON release_state.tenant_id = generation.tenant_id
            AND release_state.generation_id = generation.id
          WHERE generation.tenant_id = $1::uuid
            AND generation.source_kind IN ('radiology_report', 'anatomical_pathology_report')
            AND release_state.generation_id IS NULL
         ON CONFLICT (generation_id) DO NOTHING`,
        [tenantId],
      );
      inserted = result.rowCount;
      await client.query(
        `INSERT INTO audit_logs
           (tenant_id, uid, role, actor_uid, action, resource, resource_id, metadata)
         VALUES
           ($1::uuid, $2::uuid, $3::text, $2::uuid,
            'STRUCTURED_DIAGNOSTIC_RELEASE_STATE_BACKFILL',
            'diagnostic_result_release_states', $1::text,
            jsonb_build_object(
              'reason', $4::text,
              'missing_release_states_before', $5::integer,
              'inserted_release_states', $6::integer,
              'legacy_radiology_reports', $7::integer,
              'legacy_anatomical_pathology_reports', $8::integer,
              'legacy_anatomical_pathology_addenda', $9::integer,
              'patient_visibility_acknowledged', TRUE,
              'patient_notifications_sent', 0,
              'source', 'backfill-structured-diagnostic-release-states.mjs'
            ))`,
        [
          tenantId,
          actorUid,
          actor.rows[0].role,
          reason,
          Number(before.missing_release_states),
          inserted,
          Number(before.legacy_radiology_reports),
          Number(before.legacy_ap_reports),
          Number(before.legacy_ap_addenda),
        ],
      );
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
    }

    process.stdout.write(`${JSON.stringify({
      mode: apply ? 'applied' : 'dry_run',
      tenant_id: tenantId,
      actor_uid: actorUid,
      reason,
      missing_release_states: Number(before.missing_release_states),
      inserted_release_states: inserted,
      unrepairable_without_clinical_classification: {
        radiology_reports: Number(before.legacy_radiology_reports),
        anatomical_pathology_reports: Number(before.legacy_ap_reports),
        anatomical_pathology_addenda: Number(before.legacy_ap_addenda),
      },
      patient_notifications_sent: 0,
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
