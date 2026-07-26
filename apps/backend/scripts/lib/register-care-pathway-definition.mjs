import process from 'node:process';

import { Client } from 'pg';
import {
  PATHWAY_NAMED_CLINICIAN_ROLES,
} from '../../src/config/routeRolePolicy.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PATHWAY_NAMED_CLINICIAN_ROLE_SET = new Set(
  PATHWAY_NAMED_CLINICIAN_ROLES.map((role) => String(role).toUpperCase()),
);

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

function requiredText(name, max = 240) {
  const value = String(argumentValue(name) || '').trim();
  if (!value || value.length > max) throw new Error(`--${name} is required`);
  return value;
}

export function carePathwayRegistrationDatabaseUrl() {
  const value = process.env.CARE_PATHWAY_REGISTRATION_DATABASE_URL
    || process.env.DATABASE_URL
    || process.env.TEST_DATABASE_URL;
  if (!value) throw new Error('A database URL is required');
  return value;
}

async function requireActiveActors(client, tenantId, actorUids) {
  const result = await client.query(
    `SELECT uid::text, UPPER(COALESCE(role, '')) AS role
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = ANY($2::uuid[])
        AND is_active = TRUE
        AND LOWER(COALESCE(status, 'active')) = 'active'
      FOR SHARE`,
    [tenantId, actorUids],
  );
  const found = new Set(result.rows.map((row) => row.uid));
  if (actorUids.some((uid) => !found.has(uid))) {
    throw new Error('Every owner and approver must be an active user in the tenant');
  }
  return new Map(result.rows.map((row) => [row.uid, row.role]));
}

export function assertCarePathwayRegistrationActorRoles(actors, {
  clinicalOwnerUid,
  operationalOwnerUid,
  approverUid,
} = {}) {
  if (!PATHWAY_NAMED_CLINICIAN_ROLE_SET.has(actors.get(clinicalOwnerUid))) {
    throw new Error(
      'The clinical owner must have a canonical named-clinician role',
    );
  }
  if (actors.get(operationalOwnerUid) === 'PATIENT') {
    throw new Error('The operational owner must be an active non-patient tenant user');
  }
  if (!['ADMIN', 'SUPER_ADMIN'].includes(actors.get(approverUid))) {
    throw new Error('The definition approver must be an active ADMIN or SUPER_ADMIN');
  }
}

export function assertExistingCarePathwayRegistrationMatch(existing, {
  clinicalOwnerUid,
  operationalOwnerUid,
  approverUid,
  visibilityPolicyRef,
} = {}) {
  const mismatches = [];
  if (String(existing.clinical_owner_uid || '').toLowerCase() !== clinicalOwnerUid) {
    mismatches.push('clinical_owner_uid');
  }
  if (String(existing.operational_owner_uid || '').toLowerCase() !== operationalOwnerUid) {
    mismatches.push('operational_owner_uid');
  }
  if (String(existing.approved_by || '').toLowerCase() !== approverUid) {
    mismatches.push('approved_by');
  }
  if (existing.patient_visibility_policy_ref !== visibilityPolicyRef) {
    mismatches.push('patient_visibility_policy_ref');
  }
  if (existing.approval_receipt_matches !== true) {
    mismatches.push('approval_receipt');
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Existing approved definition conflicts with requested governance: ${mismatches.join(', ')}`,
    );
  }
}

export async function registerCarePathwayDefinition({
  definition,
  compiled,
  displayName,
  label,
} = {}) {
  const tenantId = requireUuid('tenant-id');
  const clinicalOwnerUid = requireUuid('clinical-owner-uid');
  const operationalOwnerUid = requireUuid('operational-owner-uid');
  const approverUid = requireUuid('approver-uid');
  const visibilityPolicyRef = requiredText('patient-visibility-policy-ref');
  const apply = hasFlag('apply');
  if (apply && !hasFlag('acknowledge-owner-sign-off')) {
    throw new Error('--apply also requires --acknowledge-owner-sign-off');
  }
  const connectionString = carePathwayRegistrationDatabaseUrl();
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1::text, true)`, [tenantId]);
    const actors = await requireActiveActors(client, tenantId, [
      clinicalOwnerUid,
      operationalOwnerUid,
      approverUid,
    ]);
    assertCarePathwayRegistrationActorRoles(actors, {
      clinicalOwnerUid,
      operationalOwnerUid,
      approverUid,
    });

    const existing = await client.query(
      `SELECT definition.id AS workflow_definition_id,
              governance.id AS governance_id,
              governance.clinical_owner_uid::text,
              governance.operational_owner_uid::text,
              governance.approved_by::text,
              governance.patient_visibility_policy_ref,
              (
                governance.approval_id IS NOT NULL
                AND approval.id = governance.approval_id
                AND approval.approval_kind = 'care_pathway_definition_governance'
                AND approval.subject_resource_type = 'care_pathway_definition'
                AND approval.subject_resource_id = definition.id::text
                AND approval.required_approvers = 1
                AND approval.required_role = 'ADMIN'
                AND approval.status = 'approved'
                AND approval.decided_by = $5::uuid
                AND approval.decided_at IS NOT NULL
                AND approval.created_by = $5::uuid
                AND jsonb_typeof(approval.approved_by) = 'array'
                AND jsonb_array_length(approval.approved_by) = 1
                AND approval.approved_by -> 0 ->> 'uid' = $5::text
                AND NULLIF(approval.approved_by -> 0 ->> 'at', '') IS NOT NULL
                AND approval.metadata #>> ARRAY[
                      'care_pathway_definition_governance',
                      'definition_checksum'
                    ] = $4::text
              ) AS approval_receipt_matches
         FROM workflow_definitions AS definition
         JOIN care_pathway_definition_governance AS governance
           ON governance.tenant_id = definition.tenant_id
          AND governance.workflow_definition_id = definition.id
         JOIN approvals AS approval
           ON approval.tenant_id = governance.tenant_id
          AND approval.id = governance.approval_id
        WHERE definition.tenant_id = $1::uuid
          AND definition.workflow_key = $2::text
          AND definition.version = $3::integer
          AND definition.is_active = TRUE
          AND governance.governance_status = 'approved'
          AND governance.approved_at IS NOT NULL
          AND governance.definition_checksum = $4::text
        LIMIT 2
        FOR SHARE OF definition, governance, approval`,
      [
        tenantId,
        compiled.workflow_key,
        compiled.version,
        compiled.checksum,
        approverUid,
      ],
    );
    if (existing.rows.length > 1) {
      throw new Error(`More than one approved ${label} definition is active`);
    }
    if (existing.rows[0]) {
      assertExistingCarePathwayRegistrationMatch(existing.rows[0], {
        clinicalOwnerUid,
        operationalOwnerUid,
        approverUid,
        visibilityPolicyRef,
      });
      await client.query('ROLLBACK');
      process.stdout.write(`${JSON.stringify({
        mode: 'existing',
        tenant_id: tenantId,
        pathway_key: compiled.workflow_key,
        definition_checksum: compiled.checksum,
        workflow_definition_id: Number(existing.rows[0].workflow_definition_id),
        governance_id: existing.rows[0].governance_id,
      }, null, 2)}\n`);
      return;
    }

    const conflict = await client.query(
      `SELECT id
         FROM workflow_definitions
        WHERE tenant_id = $1::uuid
          AND workflow_key = $2::text
          AND version = $3::integer
          AND is_active = TRUE`,
      [tenantId, compiled.workflow_key, compiled.version],
    );
    if (conflict.rows.length > 0) {
      throw new Error(`An unmatched active ${label} definition already exists`);
    }
    if (!apply) {
      await client.query('ROLLBACK');
      process.stdout.write(`${JSON.stringify({
        mode: 'dry_run',
        tenant_id: tenantId,
        pathway_key: compiled.workflow_key,
        definition_version: compiled.version,
        definition_checksum: compiled.checksum,
        patient_visibility_policy_ref: visibilityPolicyRef,
      }, null, 2)}\n`);
      return;
    }

    const insertedDefinition = await client.query(
      `INSERT INTO workflow_definitions
         (tenant_id, workflow_key, version, display_name, steps, triggers,
          defaults, is_active, created_by)
       VALUES
         ($1::uuid, $2::text, $3::integer, $4::text, $5::jsonb, $6::jsonb,
          $7::jsonb, TRUE, $8::uuid)
       RETURNING id`,
      [
        tenantId,
        compiled.workflow_key,
        compiled.version,
        displayName,
        JSON.stringify(definition.steps),
        JSON.stringify(definition.triggers),
        JSON.stringify(definition.defaults),
        operationalOwnerUid,
      ],
    );
    const definitionId = Number(insertedDefinition.rows[0].id);
    const approval = await client.query(
      `INSERT INTO approvals
         (tenant_id, approval_kind, subject_resource_type, subject_resource_id,
          required_approvers, required_role, status, approved_by, decided_by,
          decided_at, created_by, metadata)
       VALUES
         ($1::uuid, 'care_pathway_definition_governance',
          'care_pathway_definition', $2::text, 1, 'ADMIN', 'approved',
          jsonb_build_array(jsonb_build_object('uid', $3::text, 'at', NOW())),
          $3::uuid, NOW(), $3::uuid,
          jsonb_build_object(
            'care_pathway_definition_governance',
            jsonb_build_object('definition_checksum', $4::text)
          ))
       RETURNING id`,
      [tenantId, String(definitionId), approverUid, compiled.checksum],
    );
    const governance = await client.query(
      `INSERT INTO care_pathway_definition_governance
         (tenant_id, workflow_definition_id, clinical_owner_uid,
          operational_owner_uid, governance_status, approval_id, approved_by,
          approved_at, patient_visibility_policy_ref, definition_checksum)
       VALUES
         ($1::uuid, $2::integer, $3::uuid, $4::uuid, 'approved', $5::integer,
          $6::uuid, NOW(), $7::text, $8::text)
       RETURNING id`,
      [
        tenantId,
        definitionId,
        clinicalOwnerUid,
        operationalOwnerUid,
        Number(approval.rows[0].id),
        approverUid,
        visibilityPolicyRef,
        compiled.checksum,
      ],
    );
    await client.query('COMMIT');
    process.stdout.write(`${JSON.stringify({
      mode: 'applied',
      tenant_id: tenantId,
      pathway_key: compiled.workflow_key,
      definition_checksum: compiled.checksum,
      workflow_definition_id: definitionId,
      governance_id: governance.rows[0].id,
    }, null, 2)}\n`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

export default registerCarePathwayDefinition;
