#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { CARE_TEAM_GOVERNED_RECORD_TYPES } from '../src/config/careTeamGovernedRecordTypes.js';

export const DEFAULT_WINDOW_DAYS = 7;
export const READY_EXIT_CODE = 0;
export const BLOCKED_EXIT_CODE = 2;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_MODES = new Set(['off', 'shadow', 'enforce']);

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseArgs(argv) {
  const args = {
    tenantId: null,
    windowDays: DEFAULT_WINDOW_DAYS,
    output: null,
    advisory: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tenant-id') args.tenantId = argv[++i] || null;
    else if (arg.startsWith('--tenant-id=')) args.tenantId = arg.slice('--tenant-id='.length);
    else if (arg === '--window-days') args.windowDays = positiveInt(argv[++i], NaN);
    else if (arg.startsWith('--window-days=')) {
      args.windowDays = positiveInt(arg.slice('--window-days='.length), NaN);
    } else if (arg === '--output') args.output = argv[++i] || null;
    else if (arg.startsWith('--output=')) args.output = arg.slice('--output='.length);
    else if (arg === '--advisory') args.advisory = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.tenantId && !UUID_RE.test(args.tenantId)) {
    throw new Error(`Invalid --tenant-id UUID: ${args.tenantId}`);
  }
  if (!Number.isInteger(args.windowDays) || args.windowDays < 2 || args.windowDays > 90) {
    throw new Error('--window-days must be an integer between 2 and 90');
  }
  return args;
}

function count(row, key) {
  const value = Number(row?.[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return VALID_MODES.has(mode) ? mode : null;
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))].sort();
}

export function evaluateTenantReadiness(row, { deploymentMode = 'shadow' } = {}) {
  const tenantModeConfigured = row.tenant_mode_configured === true
    || row.tenant_mode_configured === 'true';
  const tenantMode = normalizeMode(row.tenant_mode);
  const fallbackMode = normalizeMode(deploymentMode);
  const effectiveMode = tenantModeConfigured ? tenantMode : fallbackMode;
  const observedRecordTypes = stringArray(row.observed_record_types);
  const missingRecordTypes = CARE_TEAM_GOVERNED_RECORD_TYPES
    .filter((recordType) => !observedRecordTypes.includes(recordType));
  const blockers = [];

  if (tenantModeConfigured && !tenantMode) blockers.push('CARE_TEAM_MODE_INVALID');
  if (!effectiveMode) blockers.push('CARE_TEAM_MODE_UNAVAILABLE');
  if (effectiveMode === 'off') blockers.push('CARE_TEAM_ABAC_DISABLED');
  if (count(row, 'shadow_first_half_decisions') === 0) blockers.push('SHADOW_WINDOW_FIRST_HALF_EMPTY');
  if (count(row, 'shadow_second_half_decisions') === 0) blockers.push('SHADOW_WINDOW_SECOND_HALF_EMPTY');
  if (missingRecordTypes.length > 0) blockers.push('SHADOW_RECORD_TYPE_COVERAGE_INCOMPLETE');
  if (count(row, 'shadow_denials') > 0) blockers.push('SHADOW_DENIALS_REQUIRE_REVIEW');
  if (count(row, 'appointments_missing_membership') > 0) blockers.push('APPOINTMENT_CARE_TEAM_INCOMPLETE');
  if (count(row, 'admission_doctors_missing_membership') > 0) blockers.push('ADMISSION_CARE_TEAM_INCOMPLETE');
  if (count(row, 'stale_episode_care_teams') > 0) blockers.push('STALE_EPISODE_CARE_TEAM_AUTHORITY');
  if (count(row, 'malformed_context_free_care_teams') > 0) blockers.push('MALFORMED_CONTEXT_FREE_CARE_TEAM');
  if (count(row, 'break_glass_exercises') === 0) blockers.push('BREAK_GLASS_EXERCISE_MISSING');
  if (count(row, 'active_break_glass_sessions') > 0) blockers.push('BREAK_GLASS_SESSION_ACTIVE');

  return {
    tenant_id: row.tenant_id,
    slug: row.slug,
    status: row.status,
    configured_mode_present: tenantModeConfigured,
    configured_mode_raw: row.tenant_mode ?? null,
    configured_mode: tenantMode,
    effective_mode: effectiveMode,
    mode_source: tenantModeConfigured ? 'tenant_settings' : 'deployment_fallback',
    evidence: {
      shadow_decisions: count(row, 'shadow_decisions'),
      shadow_first_half_decisions: count(row, 'shadow_first_half_decisions'),
      shadow_second_half_decisions: count(row, 'shadow_second_half_decisions'),
      shadow_denials: count(row, 'shadow_denials'),
      expected_record_types: [...CARE_TEAM_GOVERNED_RECORD_TYPES],
      observed_record_types: observedRecordTypes,
      missing_record_types: missingRecordTypes,
      appointments_missing_membership: count(row, 'appointments_missing_membership'),
      admission_doctors_missing_membership: count(row, 'admission_doctors_missing_membership'),
      stale_episode_care_teams: count(row, 'stale_episode_care_teams'),
      malformed_context_free_care_teams: count(row, 'malformed_context_free_care_teams'),
      break_glass_exercises: count(row, 'break_glass_exercises'),
      active_break_glass_sessions: count(row, 'active_break_glass_sessions'),
      first_shadow_at: row.first_shadow_at ?? null,
      last_shadow_at: row.last_shadow_at ?? null,
    },
    blockers,
    ready_for_owner_review: blockers.length === 0,
  };
}

export function buildReport(rows, {
  windowDays = DEFAULT_WINDOW_DAYS,
  deploymentMode = 'shadow',
  tenantId = null,
} = {}) {
  const tenants = rows.map((row) => evaluateTenantReadiness(row, { deploymentMode }));
  const ready = tenants.filter((tenant) => tenant.ready_for_owner_review).length;
  return {
    gate: 'care_team_enforcement_readiness',
    generated_at: new Date().toISOString(),
    observation_window_days: windowDays,
    requested_tenant_id: tenantId,
    deployment_fallback_mode: normalizeMode(deploymentMode),
    tenant_count: tenants.length,
    ready_for_owner_review_count: ready,
    blocked_count: tenants.length - ready,
    all_tenants_ready_for_owner_review: tenants.length > 0 && ready === tenants.length,
    tenants,
    limitations: [
      'This SELECT-only gate does not change tenant enforcement mode.',
      'Record-type coverage does not prove that every URL sharing that policy was exercised; route-by-route evidence remains an owner review item.',
      'Patient-unresolved and database-write-failure audits use the durable file fallback; any fallback entry in the window must block owner approval.',
      'An owner must still review denial reasons and prove the enforce response is not a patient-existence oracle.',
      'A break-glass exercise requires activation, PHI access through the override, and a terminal lifecycle transition.',
    ],
  };
}

export const READINESS_QUERY = `
WITH requested AS (
  SELECT $1::uuid AS tenant_id, $2::int AS window_days
),
tenant_scope AS (
  SELECT t.id AS tenant_id, t.slug, t.status,
         t.settings ? 'care_team_enforcement_mode' AS tenant_mode_configured,
         NULLIF(LOWER(BTRIM(t.settings ->> 'care_team_enforcement_mode')), '') AS tenant_mode
    FROM tenants t, requested r
   WHERE t.status = 'active'
     AND (r.tenant_id IS NULL OR t.id = r.tenant_id)
),
shadow AS (
  SELECT a.tenant_id,
         COUNT(*) FILTER (
           WHERE a.metadata ->> 'shadow_mode' = 'true'
             AND a.created_at >= NOW() - (r.window_days * INTERVAL '1 day')
         )::int AS shadow_decisions,
         COUNT(*) FILTER (
           WHERE a.metadata ->> 'shadow_mode' = 'true'
             AND a.created_at >= NOW() - (r.window_days * INTERVAL '1 day')
             AND a.created_at < NOW() - ((r.window_days / 2.0) * INTERVAL '1 day')
         )::int AS shadow_first_half_decisions,
         COUNT(*) FILTER (
           WHERE a.metadata ->> 'shadow_mode' = 'true'
             AND a.created_at >= NOW() - ((r.window_days / 2.0) * INTERVAL '1 day')
         )::int AS shadow_second_half_decisions,
         COUNT(*) FILTER (
           WHERE a.metadata ->> 'shadow_mode' = 'true'
             AND a.access_decision = 'deny'
             AND a.created_at >= NOW() - (r.window_days * INTERVAL '1 day')
         )::int AS shadow_denials,
         MIN(a.created_at) FILTER (
           WHERE a.metadata ->> 'shadow_mode' = 'true'
             AND a.created_at >= NOW() - (r.window_days * INTERVAL '1 day')
         ) AS first_shadow_at,
         MAX(a.created_at) FILTER (
           WHERE a.metadata ->> 'shadow_mode' = 'true'
             AND a.created_at >= NOW() - (r.window_days * INTERVAL '1 day')
         ) AS last_shadow_at,
         COALESCE(
           ARRAY_AGG(DISTINCT a.metadata ->> 'record_type') FILTER (
             WHERE a.metadata ->> 'shadow_mode' = 'true'
               AND a.created_at >= NOW() - (r.window_days * INTERVAL '1 day')
               AND NULLIF(BTRIM(a.metadata ->> 'record_type'), '') IS NOT NULL
           ),
           ARRAY[]::text[]
         ) AS observed_record_types
    FROM tenant_scope tenant
    JOIN patient_access_audit_log a ON a.tenant_id = tenant.tenant_id
    CROSS JOIN requested r
   WHERE a.created_at >= NOW() - (r.window_days * INTERVAL '1 day')
   GROUP BY a.tenant_id
),
appointment_gaps AS (
  SELECT a.tenant_id, COUNT(*)::int AS appointments_missing_membership
    FROM tenant_scope tenant
    JOIN appointments a ON a.tenant_id = tenant.tenant_id
    JOIN users patient ON patient.id = a.patient_id AND patient.tenant_id = a.tenant_id
    JOIN users doctor ON doctor.id = a.doctor_id AND doctor.tenant_id = a.tenant_id
   WHERE a.doctor_id IS NOT NULL
     AND UPPER(BTRIM(COALESCE(a.status, ''))) NOT IN ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
     AND a.appointment_date BETWEEN CURRENT_DATE - 30 AND CURRENT_DATE + 30
     AND NOT EXISTS (
       SELECT 1
         FROM care_teams team
         JOIN care_team_members member
           ON member.tenant_id = team.tenant_id
          AND member.care_team_id = team.id
          AND member.patient_uid = team.patient_uid
          AND member.status = 'active'
          AND member.active_from <= NOW()
          AND (member.active_until IS NULL OR member.active_until >= NOW())
          AND (member.staff_id = doctor.id OR member.staff_uid = doctor.uid)
        WHERE team.tenant_id = a.tenant_id
          AND team.patient_uid = patient.uid
          AND team.appointment_id = a.id
          AND team.status = 'active'
     )
   GROUP BY a.tenant_id
),
admission_relationships AS (
  SELECT admission.tenant_id, admission.id, admission.patient_uid, doctor_uid
    FROM tenant_scope tenant
    JOIN admissions admission ON admission.tenant_id = tenant.tenant_id
    CROSS JOIN LATERAL (
      SELECT DISTINCT doctor_uid
        FROM unnest(ARRAY[admission.admitting_doctor, admission.attending_doctor]) AS doctors(doctor_uid)
       WHERE doctor_uid IS NOT NULL
    ) doctors
   WHERE LOWER(BTRIM(COALESCE(admission.status, ''))) IN ('admitted', 'transferred')
),
admission_gaps AS (
  SELECT relationship.tenant_id, COUNT(*)::int AS admission_doctors_missing_membership
    FROM admission_relationships relationship
   WHERE NOT EXISTS (
     SELECT 1
       FROM care_teams team
       JOIN care_team_members member
         ON member.tenant_id = team.tenant_id
        AND member.care_team_id = team.id
        AND member.patient_uid = team.patient_uid
        AND member.staff_uid = relationship.doctor_uid
        AND member.status = 'active'
        AND member.active_from <= NOW()
        AND (member.active_until IS NULL OR member.active_until >= NOW())
      WHERE team.tenant_id = relationship.tenant_id
        AND team.patient_uid = relationship.patient_uid
        AND team.admission_id = relationship.id
        AND team.status = 'active'
   )
   GROUP BY relationship.tenant_id
),
stale_episode_teams AS (
  SELECT team.tenant_id, COUNT(*)::int AS stale_episode_care_teams
    FROM tenant_scope tenant
    JOIN care_teams team
      ON team.tenant_id = tenant.tenant_id
     AND team.status = 'active'
   WHERE (
       team.appointment_id IS NOT NULL
       AND (
         team.admission_id IS NOT NULL
         OR NOT EXISTS (
           SELECT 1
             FROM appointments appointment
             JOIN users patient
               ON patient.tenant_id = appointment.tenant_id
              AND patient.id = appointment.patient_id
            WHERE appointment.tenant_id = team.tenant_id
              AND appointment.id = team.appointment_id
              AND patient.uid = team.patient_uid
              AND UPPER(BTRIM(COALESCE(appointment.status, ''))) NOT IN (
                'CANCELLED', 'NO_SHOW', 'RESCHEDULED'
              )
              AND appointment.appointment_date >= (CURRENT_DATE - INTERVAL '30 days')
              AND appointment.appointment_date <= (CURRENT_DATE + INTERVAL '30 days')
         )
       )
     )
     OR (
       team.admission_id IS NOT NULL
       AND (
         team.appointment_id IS NOT NULL
         OR NOT EXISTS (
           SELECT 1
             FROM admissions admission
            WHERE admission.tenant_id = team.tenant_id
              AND admission.id = team.admission_id
              AND admission.patient_uid = team.patient_uid
              AND LOWER(BTRIM(COALESCE(admission.status, ''))) IN ('admitted', 'transferred')
         )
       )
     )
   GROUP BY team.tenant_id
),
malformed_context_free_teams AS (
  SELECT team.tenant_id, COUNT(*)::int AS malformed_context_free_care_teams
    FROM tenant_scope tenant
    JOIN care_teams team
      ON team.tenant_id = tenant.tenant_id
     AND team.status = 'active'
   WHERE team.appointment_id IS NULL
     AND team.admission_id IS NULL
     AND LOWER(BTRIM(COALESCE(team.team_kind, ''))) <> 'longitudinal'
   GROUP BY team.tenant_id
),
break_glass AS (
  SELECT tenant.tenant_id,
         COUNT(DISTINCT bg.id) FILTER (
           WHERE bg.status IN ('ended', 'expired', 'revoked')
             AND bg.started_at >= NOW() - (r.window_days * INTERVAL '1 day')
             AND audit_access.id IS NOT NULL
             AND terminal.id IS NOT NULL
         )::int AS break_glass_exercises,
         COUNT(DISTINCT bg.id) FILTER (
           WHERE bg.status = 'active'
             AND (bg.expires_at IS NULL OR bg.expires_at > NOW())
         )::int AS active_break_glass_sessions
    FROM tenant_scope tenant
    CROSS JOIN requested r
    LEFT JOIN patient_access_break_glass bg ON bg.tenant_id = tenant.tenant_id
    LEFT JOIN patient_access_audit_log audit_access
      ON audit_access.tenant_id = bg.tenant_id
     AND audit_access.break_glass_id = bg.id
     AND audit_access.access_source = 'break_glass'
    LEFT JOIN patient_access_break_glass_status_history terminal
      ON terminal.tenant_id = bg.tenant_id
     AND terminal.break_glass_id = bg.id
     AND terminal.to_status IN ('ended', 'expired', 'revoked')
   GROUP BY tenant.tenant_id
)
SELECT tenant.tenant_id::text AS tenant_id, tenant.slug, tenant.status,
       tenant.tenant_mode_configured, tenant.tenant_mode,
       COALESCE(shadow.shadow_decisions, 0) AS shadow_decisions,
       COALESCE(shadow.shadow_first_half_decisions, 0) AS shadow_first_half_decisions,
       COALESCE(shadow.shadow_second_half_decisions, 0) AS shadow_second_half_decisions,
       COALESCE(shadow.shadow_denials, 0) AS shadow_denials,
       shadow.first_shadow_at, shadow.last_shadow_at,
       COALESCE(shadow.observed_record_types, ARRAY[]::text[]) AS observed_record_types,
       COALESCE(appointment_gaps.appointments_missing_membership, 0) AS appointments_missing_membership,
       COALESCE(admission_gaps.admission_doctors_missing_membership, 0) AS admission_doctors_missing_membership,
       COALESCE(stale_episode_teams.stale_episode_care_teams, 0) AS stale_episode_care_teams,
       COALESCE(malformed_context_free_teams.malformed_context_free_care_teams, 0) AS malformed_context_free_care_teams,
       COALESCE(break_glass.break_glass_exercises, 0) AS break_glass_exercises,
       COALESCE(break_glass.active_break_glass_sessions, 0) AS active_break_glass_sessions
  FROM tenant_scope tenant
  LEFT JOIN shadow ON shadow.tenant_id = tenant.tenant_id
  LEFT JOIN appointment_gaps ON appointment_gaps.tenant_id = tenant.tenant_id
  LEFT JOIN admission_gaps ON admission_gaps.tenant_id = tenant.tenant_id
  LEFT JOIN stale_episode_teams ON stale_episode_teams.tenant_id = tenant.tenant_id
  LEFT JOIN malformed_context_free_teams ON malformed_context_free_teams.tenant_id = tenant.tenant_id
  LEFT JOIN break_glass ON break_glass.tenant_id = tenant.tenant_id
 ORDER BY tenant.slug`;

export async function collectReadiness(client, args) {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const posture = await client.query(
      "SELECT current_setting('transaction_read_only') AS transaction_read_only",
    );
    if (posture.rows[0]?.transaction_read_only !== 'on') {
      throw new Error('Database transaction is writable; refusing care-team readiness scan');
    }
    const result = await client.query(READINESS_QUERY, [args.tenantId, args.windowDays]);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export function auditExitCode(report) {
  return report?.all_tenants_ready_for_owner_review ? READY_EXIT_CODE : BLOCKED_EXIT_CODE;
}

function printUsage() {
  process.stdout.write(`Usage:
  node -r dotenv/config scripts/audit-care-team-enforcement-readiness.mjs [options]

Options:
  --tenant-id <uuid>   Check one active tenant; otherwise inventory all active tenants.
  --window-days <n>    Shadow and break-glass evidence window, 2-90 (default 7).
  --output <path>      Write the machine-readable JSON report.
  --advisory           Always exit 0 while preserving the blocked verdict.
`);
}

function printReport(report) {
  process.stdout.write(`Care-team enforcement readiness: ${report.all_tenants_ready_for_owner_review ? 'READY FOR OWNER REVIEW' : 'BLOCKED'}\n`);
  process.stdout.write(`Tenants: ${report.tenant_count}; ready: ${report.ready_for_owner_review_count}; blocked: ${report.blocked_count}\n`);
  for (const tenant of report.tenants) {
    process.stdout.write(
      `- ${tenant.slug} (${tenant.tenant_id}): ${tenant.ready_for_owner_review ? 'READY FOR OWNER REVIEW' : `BLOCKED [${tenant.blockers.join(', ')}]`}\n`,
    );
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return READY_EXIT_CODE;
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const deploymentMode = process.env.CARE_TEAM_ENFORCEMENT_MODE || 'shadow';
  if (!normalizeMode(deploymentMode)) {
    throw new Error('CARE_TEAM_ENFORCEMENT_MODE must be off, shadow, or enforce');
  }

  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    application_name: 'care-team-enforcement-readiness',
  });
  await client.connect();
  try {
    const rows = await collectReadiness(client, args);
    const report = buildReport(rows, {
      windowDays: args.windowDays,
      deploymentMode,
      tenantId: args.tenantId,
    });
    if (args.output) {
      const output = path.resolve(args.output);
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    printReport(report);
    return args.advisory ? READY_EXIT_CODE : auditExitCode(report);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`[care-team-enforcement-readiness] fatal: ${error.message}\n`);
    process.exitCode = 1;
  });
}
