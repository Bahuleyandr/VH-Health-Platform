import process from 'node:process';

import { Client } from 'pg';

import { PATHWAY_NAMED_CLINICIAN_ROLES } from '../src/config/routeRolePolicy.js';

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
  if (!UUID_PATTERN.test(value)) throw new Error(`--${name} must be an exact UUID`);
  return value;
}

function requiredText(name, max = 500) {
  const value = String(argumentValue(name) || '').trim();
  if (!value || value.length > max) throw new Error(`--${name} is required`);
  return value;
}

function databaseUrl() {
  const value = process.env.REFERRAL_TASK_BACKFILL_DATABASE_URL
    || process.env.DATABASE_URL
    || process.env.TEST_DATABASE_URL;
  if (!value) throw new Error('A database URL is required');
  return value;
}

async function requireAdministrator(client, tenantId, actorUid) {
  const result = await client.query(
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
  if (!result.rows[0]) throw new Error('The actor must be an active ADMIN or SUPER_ADMIN in the tenant');
  return result.rows[0].role;
}

async function loadCounts(client, tenantId, eligibleRoles) {
  const result = await client.query(
    `WITH open_referral AS (
       SELECT referral.*,
              EXISTS (
                SELECT 1
                  FROM users AS receiver
                  JOIN doctors AS doctor
                    ON doctor.user_id = receiver.id
                   AND COALESCE(doctor.is_active, TRUE) = TRUE
                 WHERE receiver.tenant_id = referral.tenant_id
                   AND receiver.uid = referral.referred_to_doctor
                   AND receiver.is_active = TRUE
                   AND LOWER(COALESCE(receiver.status, 'active')) = 'active'
                   AND receiver.is_deleted IS FALSE
                   AND UPPER(receiver.role) = ANY($2::text[])
              ) AS receiver_available,
              EXISTS (
                SELECT 1 FROM workflow_sla_instances AS sla
                 WHERE sla.tenant_id = referral.tenant_id
                   AND sla.rule_code = 'referral_response'
                   AND sla.source_table = 'referrals'
                   AND sla.source_id = referral.id::text
                   AND sla.status IN ('active', 'breached', 'escalated')
                   AND sla.completed_at IS NULL
                   AND sla.due_at IS NOT NULL
              ) AS clock_available,
              EXISTS (
                SELECT 1 FROM workflow_sla_instances AS sla
                 WHERE sla.tenant_id = referral.tenant_id
                   AND sla.rule_code = 'referral_response'
                   AND sla.source_table = 'referrals'
                   AND sla.source_id = referral.id::text
                   AND sla.status = 'completed'
                   AND sla.completed_at IS NOT NULL
                   AND sla.due_at IS NOT NULL
                   AND sla.metadata ->> 'completed_by_action' = 'seen'
              ) AS seen_clock_rearmable,
              EXISTS (
                SELECT 1 FROM tasks AS task
                 WHERE task.tenant_id = referral.tenant_id
                   AND task.related_resource_type = 'referrals'
                   AND task.related_resource_id = referral.id::text
                   AND task.status IN ('open', 'in_progress', 'blocked', 'overdue')
              ) AS task_available
         FROM referrals AS referral
        WHERE referral.tenant_id = $1::uuid
          AND LOWER(COALESCE(referral.referral_type, 'internal')) = 'internal'
          AND referral.status = 'pending'
          AND COALESCE(referral.closure_status, 'open') = 'open'
     )
     SELECT COUNT(*)::integer AS open_pending,
            COUNT(*) FILTER (WHERE referred_to_doctor IS NULL)::integer AS missing_named_receiver,
            COUNT(*) FILTER (
              WHERE referred_to_doctor IS NOT NULL AND NOT receiver_available
            )::integer AS unavailable_named_receiver,
            COUNT(*) FILTER (
              WHERE receiver_available AND NOT clock_available AND NOT seen_clock_rearmable
            )::integer AS missing_response_clock,
            COUNT(*) FILTER (
              WHERE receiver_available AND seen_clock_rearmable
            )::integer AS rearmable_seen_response_clock,
            COUNT(*) FILTER (
              WHERE receiver_available AND (clock_available OR seen_clock_rearmable)
                AND task_available
            )::integer AS already_tasked,
            COUNT(*) FILTER (
              WHERE receiver_available AND (clock_available OR seen_clock_rearmable)
                AND NOT task_available
            )::integer AS eligible
       FROM open_referral`,
    [tenantId, eligibleRoles],
  );
  return result.rows[0];
}

async function main() {
  const tenantId = requireUuid('tenant-id');
  const actorUid = requireUuid('actor-uid');
  const reason = requiredText('reason');
  const apply = hasFlag('apply');
  if (apply && !hasFlag('acknowledge-safe-referral-backfill')) {
    throw new Error('--apply also requires --acknowledge-safe-referral-backfill');
  }
  const eligibleRoles = PATHWAY_NAMED_CLINICIAN_ROLES.map((role) => String(role).toUpperCase());
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1::text, true)`, [tenantId]);
    const actorRole = await requireAdministrator(client, tenantId, actorUid);
    const counts = await loadCounts(client, tenantId, eligibleRoles);
    let inserted = 0;
    let rearmed = 0;
    if (apply) {
      const rearmResult = await client.query(
        `UPDATE workflow_sla_instances AS sla
            SET status = CASE WHEN sla.due_at <= NOW() THEN 'breached' ELSE 'active' END,
                completed_at = NULL,
                breached_at = CASE
                  WHEN sla.due_at <= NOW() THEN COALESCE(sla.breached_at, NOW())
                  ELSE NULL
                END,
                escalated_at = CASE WHEN sla.due_at <= NOW() THEN sla.escalated_at ELSE NULL END,
                assigned_user_uid = referral.referred_to_doctor,
                assigned_role_codes = ARRAY[]::text[],
                metadata = (COALESCE(sla.metadata, '{}'::jsonb)
                  - 'completed_by' - 'completed_by_action' - 'completed_via'
                  - 'acknowledged_by' - 'completion_evidence')
                  || jsonb_build_object(
                    'rearmed_at', NOW(),
                    'rearm_reason', $3::text,
                    'rearm_source', 'backfill-referral-receiver-tasks.mjs'
                  ),
                updated_at = NOW()
           FROM referrals AS referral
           JOIN users AS receiver
             ON receiver.tenant_id = referral.tenant_id
            AND receiver.uid = referral.referred_to_doctor
            AND receiver.is_active = TRUE
            AND LOWER(COALESCE(receiver.status, 'active')) = 'active'
            AND receiver.is_deleted IS FALSE
            AND UPPER(receiver.role) = ANY($2::text[])
           JOIN doctors AS doctor
             ON doctor.user_id = receiver.id
            AND COALESCE(doctor.is_active, TRUE) = TRUE
          WHERE referral.tenant_id = $1::uuid
            AND LOWER(COALESCE(referral.referral_type, 'internal')) = 'internal'
            AND referral.status = 'pending'
            AND COALESCE(referral.closure_status, 'open') = 'open'
            AND sla.tenant_id = referral.tenant_id
            AND sla.rule_code = 'referral_response'
            AND sla.source_table = 'referrals'
            AND sla.source_id = referral.id::text
            AND sla.status = 'completed'
            AND sla.completed_at IS NOT NULL
            AND sla.due_at IS NOT NULL
            AND sla.metadata ->> 'completed_by_action' = 'seen'`,
        [tenantId, eligibleRoles, reason],
      );
      rearmed = rearmResult.rowCount;
      const result = await client.query(
        `INSERT INTO tasks
           (tenant_id, task_kind, title, description, patient_uid,
            related_resource_type, related_resource_id, priority, status,
            assigned_to_uid, created_by, due_at, workflow_sla_instance_id,
            sla_completion_semantics, metadata)
         SELECT referral.tenant_id,
                'review',
                'Acknowledge referral ' || referral.referral_number,
                'Review the referral and accept, decline, or reroute it.',
                referral.patient_uid,
                'referrals',
                referral.id::text,
                CASE LOWER(COALESCE(referral.urgency, 'routine'))
                  WHEN 'emergency' THEN 'critical'
                  WHEN 'urgent' THEN 'high'
                  ELSE 'normal'
                END,
                'open',
                referral.referred_to_doctor,
                $3::uuid,
                sla.due_at,
                sla.id,
                'acknowledgement',
                jsonb_build_object(
                  'referral_stage', 'receiver_acknowledgement',
                  'referral_number', referral.referral_number,
                  'backfilled_at', NOW(),
                  'backfill_reason', $4::text,
                  'source', 'backfill-referral-receiver-tasks.mjs'
                )
           FROM referrals AS referral
           JOIN users AS receiver
             ON receiver.tenant_id = referral.tenant_id
            AND receiver.uid = referral.referred_to_doctor
            AND receiver.is_active = TRUE
            AND LOWER(COALESCE(receiver.status, 'active')) = 'active'
            AND receiver.is_deleted IS FALSE
            AND UPPER(receiver.role) = ANY($2::text[])
           JOIN doctors AS doctor
             ON doctor.user_id = receiver.id
            AND COALESCE(doctor.is_active, TRUE) = TRUE
           JOIN workflow_sla_instances AS sla
             ON sla.tenant_id = referral.tenant_id
            AND sla.rule_code = 'referral_response'
            AND sla.source_table = 'referrals'
            AND sla.source_id = referral.id::text
            AND sla.status IN ('active', 'breached', 'escalated')
            AND sla.completed_at IS NULL
            AND sla.due_at IS NOT NULL
          WHERE referral.tenant_id = $1::uuid
            AND LOWER(COALESCE(referral.referral_type, 'internal')) = 'internal'
            AND referral.status = 'pending'
            AND COALESCE(referral.closure_status, 'open') = 'open'
         ON CONFLICT (tenant_id, related_resource_type, related_resource_id)
           WHERE status IN ('open', 'in_progress', 'blocked', 'overdue')
             AND related_resource_type IS NOT NULL
             AND related_resource_id IS NOT NULL
         DO NOTHING`,
        [tenantId, eligibleRoles, actorUid, reason],
      );
      inserted = result.rowCount;
      await client.query(
        `INSERT INTO audit_logs
           (tenant_id, uid, role, actor_uid, action, resource, resource_id, metadata)
         VALUES ($1::uuid, $2::uuid, $3::text, $2::uuid,
           'REFERRAL_RECEIVER_TASK_BACKFILL', 'tasks', $1::text,
           jsonb_build_object(
             'reason', $4::text,
             'eligible_before', $5::integer,
             'inserted_tasks', $6::integer,
             'rearmed_seen_response_clocks', $7::integer,
             'missing_named_receiver', $8::integer,
             'unavailable_named_receiver', $9::integer,
             'missing_response_clock', $10::integer,
             'already_tasked', $11::integer,
             'patient_notifications_sent', 0,
             'source', 'backfill-referral-receiver-tasks.mjs'
           ))`,
        [
          tenantId,
          actorUid,
          actorRole,
          reason,
          Number(counts.eligible),
          inserted,
          rearmed,
          Number(counts.missing_named_receiver),
          Number(counts.unavailable_named_receiver),
          Number(counts.missing_response_clock),
          Number(counts.already_tasked),
        ],
      );
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
    }
    process.stdout.write(`${JSON.stringify({
      mode: apply ? 'applied' : 'dry_run',
      tenant_id: tenantId,
      reason,
      ...Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)])),
      rearmed_seen_response_clocks: rearmed,
      inserted_tasks: inserted,
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
