#!/usr/bin/env node
// Read-only production preflight for migrations 582-584's durable lab-ingest
// identity and required care-pathway governance pinning.
//
// The scan deliberately runs against the primary in a database-enforced,
// repeatable-read READ ONLY transaction. A replica can lag the final maintenance
// snapshot and therefore cannot prove that the migration's fail-closed predicates
// are clear. Report evidence is tenant-grouped and bounded; patient identifiers,
// raw OBX content, and raw message-control IDs are never emitted.

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Client } from 'pg';

export const ACKNOWLEDGEMENT_FLAG = '--ack-read-only-primary-scan';
export const DEFAULT_SAMPLE_LIMIT = 5;
export const MAX_SAMPLE_LIMIT = 25;
export const BLOCKED_EXIT_CODE = 2;
export const TARGET_POSTGRESQL_MAJOR = 18;
export const TARGET_MIGRATIONS = Object.freeze([
  '582_lab_oru_replay_idempotency.sql',
  '583_lab_astm_atomic_replay.sql',
  '584_care_pathway_governance_pinning.sql',
]);
export const PREREQUISITE_MIGRATIONS = Object.freeze([
  '580_care_pathway_execution_spine.sql',
  '581_lab_critical_alert_generations.sql',
]);
export const CUTOVER_MIGRATIONS = Object.freeze([
  ...PREREQUISITE_MIGRATIONS,
  ...TARGET_MIGRATIONS,
]);
export const FROZEN_CUTOVER_MIGRATION_ARTIFACTS = Object.freeze({
  '580_care_pathway_execution_spine.sql': Object.freeze({
    bytes: 246628,
    sha256: 'A41495FC511BD5238FE548E9185A1461715B47AA54607C7F42FF8AD79EDAA979',
  }),
  '581_lab_critical_alert_generations.sql': Object.freeze({
    bytes: 110528,
    sha256: '43AFB83D57E50E738540ADDCC02875C35826884B3D9D4D7B31BBAEBB77B61CB4',
  }),
  '582_lab_oru_replay_idempotency.sql': Object.freeze({
    bytes: 64558,
    sha256: 'F0CEA6E6EA63F9CF5932ACBD99EE9508A2E838D3715D09B969AED99E3A0E41F0',
  }),
  '583_lab_astm_atomic_replay.sql': Object.freeze({
    bytes: 177245,
    sha256: '7D1ABE4238FA95D4BAFBEA9E86052DF8C53CA8361FEFDCF407EA9E44E10919F1',
  }),
  '584_care_pathway_governance_pinning.sql': Object.freeze({
    bytes: 73446,
    sha256: 'F799232A9007CB3A69DEA11D7131C96913578E94BB8C62B9C1B6106921C31EB7',
  }),
});

function migrationArtifactsDirectory() {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'migrations',
  );
}

export function assertFrozenCutoverMigrationArtifacts(artifacts = {}) {
  const actualNames = Object.keys(artifacts).sort();
  const expectedNames = [...CUTOVER_MIGRATIONS].sort();
  if (!sameStrings(actualNames, expectedNames)) {
    throw new Error(
      `Frozen cutover migration artifact inventory mismatch: expected ${expectedNames.join(', ')}`,
    );
  }
  for (const name of CUTOVER_MIGRATIONS) {
    const expected = FROZEN_CUTOVER_MIGRATION_ARTIFACTS[name];
    const actual = artifacts[name] || {};
    if (
      actual.bytes !== expected.bytes
      || String(actual.sha256 || '').toUpperCase() !== expected.sha256
    ) {
      throw new Error(
        `Frozen cutover migration artifact mismatch for ${name}: expected ${expected.bytes} bytes / ${expected.sha256}, got ${actual.bytes ?? 'unknown'} bytes / ${actual.sha256 ?? 'unknown'}`,
      );
    }
  }
  return artifacts;
}

export async function verifyFrozenCutoverMigrationFiles({
  migrationsDirectory = migrationArtifactsDirectory(),
  readFileImpl = readFile,
} = {}) {
  const artifacts = {};
  for (const name of CUTOVER_MIGRATIONS) {
    const contents = await readFileImpl(join(migrationsDirectory, name));
    // Normalize CRLF before measuring/hashing so Windows autocrlf checkouts
    // verify identically to the LF git blobs these pins were frozen from
    // (verified 2026-07-28: the raw working-tree read on Windows yields
    // 253,110 bytes / 08A4C599… for migration 580 versus the pinned LF blob's
    // 246,628 / A41495FC…, failing local sweep chunk 104 while Linux CI
    // passes). Same idiom as the frozen-migration deep tests. A real content
    // change — including an appended newline — still alters bytes and sha256.
    const normalized = contents.toString('utf8').replace(/\r\n/g, '\n');
    artifacts[name] = {
      bytes: Buffer.byteLength(normalized, 'utf8'),
      sha256: createHash('sha256').update(normalized).digest('hex').toUpperCase(),
    };
  }
  return assertFrozenCutoverMigrationArtifacts(artifacts);
}

export const BEGIN_READ_ONLY_QUERY =
  'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY';
export const COMMIT_QUERY = 'COMMIT';
export const ROLLBACK_QUERY = 'ROLLBACK';

export const READ_ONLY_CHECK_QUERY = `
  SELECT current_setting('transaction_read_only') AS transaction_read_only,
         current_setting('transaction_isolation') AS transaction_isolation,
         current_setting('server_version_num') AS server_version_num,
         pg_is_in_recovery() AS pg_is_in_recovery,
         current_user AS audit_user,
         role.rolsuper AS audit_user_is_superuser,
         role.rolbypassrls AS audit_user_bypasses_rls
    FROM pg_roles AS role
   WHERE role.rolname = current_user
`;

export const TENANT_INVENTORY_QUERY = `
  SELECT tenant.id AS tenant_id
    FROM tenants AS tenant
   ORDER BY tenant.id
`;

export const MIGRATION_TRACKER_QUERY = `
  SELECT migration.name
    FROM _migrations AS migration
   ORDER BY migration.name
`;

export const SCHEMA_STATE_QUERY = `
  SELECT to_regclass('public.lab_oru_ingest_messages') IS NOT NULL
           AS oru_message_claim_table_exists,
         to_regclass('public.lab_result_ingest_commands') IS NOT NULL
           AS result_command_claim_table_exists,
         COUNT(*) FILTER (
           WHERE table_name = 'lab_results'
             AND column_name IN ('oru_ingest_message_id', 'ingest_command_id')
         )::int AS oru_result_claim_column_count,
         EXISTS (
           SELECT 1
             FROM pg_extension
            WHERE extname = 'pgcrypto'
         ) AS pgcrypto_installed,
         COUNT(*) FILTER (
           WHERE table_name = 'lab_interface_messages'
             AND column_name IN (
               'raw_message_sha256',
               'astm_message_sha256',
               'ingest_contract_version',
               'authenticated_actor_uid',
               'authenticated_actor_roles',
               'analyzer_binding_mode',
               'analyzer_binding_identity',
               'analyzer_sender_identity'
             )
         )::int AS astm_contract_column_count,
         COUNT(*) FILTER (
           WHERE table_name = 'lab_results'
             AND column_name IN ('interface_message_id', 'interface_result_index')
         )::int AS astm_result_link_column_count,
         COUNT(*) FILTER (
           WHERE (
             table_name = 'care_pathway_definition_governance'
             AND (
               (column_name = 'retired_by' AND data_type = 'uuid')
               OR (
                 column_name = 'retired_at'
                 AND data_type = 'timestamp with time zone'
                 AND datetime_precision = 6
               )
               OR (column_name = 'retirement_reason' AND data_type = 'text')
             )
             AND is_nullable = 'YES'
           )
         )::int AS care_pathway_governance_lifecycle_column_count,
         COUNT(*) FILTER (
           WHERE table_name = 'workflow_runs'
             AND (
               (
                 column_name = 'pathway_governance_id'
                 AND data_type = 'uuid'
               )
               OR (
                 column_name = 'pathway_definition_checksum'
                 AND data_type = 'character'
                 AND character_maximum_length = 64
               )
             )
             AND is_nullable = 'YES'
         )::int AS care_pathway_run_pin_column_count,
         COUNT(*) FILTER (
           WHERE table_name = 'care_pathway_instances'
             AND (
               (
                 column_name = 'workflow_definition_id'
                 AND data_type = 'integer'
               )
               OR (
                 column_name = 'definition_governance_id'
                 AND data_type = 'uuid'
               )
               OR (
                 column_name = 'definition_checksum'
                 AND data_type = 'character'
                 AND character_maximum_length = 64
               )
             )
             AND is_nullable = 'NO'
         )::int AS care_pathway_instance_pin_column_count,
         (
           SELECT COUNT(*)::int
             FROM pg_constraint AS con
            WHERE con.convalidated
              AND (
                (
                  con.conrelid = TO_REGCLASS(
                    'public.care_pathway_definition_governance'
                  )
                  AND (
                    (
                      con.conname =
                        'care_pathway_governance_retirement_evidence_check'
                      AND con.contype = 'c'
                    ) OR (
                      con.conname = 'fk_care_pathway_governance_retired_by'
                      AND con.contype = 'f'
                      AND con.confrelid = TO_REGCLASS('public.users')
                      AND ARRAY(
                        SELECT attr.attname::text
                          FROM UNNEST(con.conkey) WITH ORDINALITY
                            AS key(attnum, ordinal)
                          JOIN pg_attribute AS attr
                            ON attr.attrelid = con.conrelid
                           AND attr.attnum = key.attnum
                         ORDER BY key.ordinal
                      ) = ARRAY['tenant_id', 'retired_by']::text[]
                      AND ARRAY(
                        SELECT attr.attname::text
                          FROM UNNEST(con.confkey) WITH ORDINALITY
                            AS key(attnum, ordinal)
                          JOIN pg_attribute AS attr
                            ON attr.attrelid = con.confrelid
                           AND attr.attnum = key.attnum
                         ORDER BY key.ordinal
                      ) = ARRAY['tenant_id', 'uid']::text[]
                      AND con.condeferrable
                      AND con.condeferred
                    )
                  )
                ) OR (
                  con.conrelid = TO_REGCLASS('public.workflow_runs')
                  AND (
                    (
                      con.conname = 'workflow_runs_pathway_definition_pin_check'
                      AND con.contype = 'c'
                    ) OR (
                      con.conname = 'fk_workflow_runs_pathway_governance_pin'
                      AND con.contype = 'f'
                      AND con.confrelid = TO_REGCLASS(
                        'public.care_pathway_definition_governance'
                      )
                      AND ARRAY(
                        SELECT attr.attname::text
                          FROM UNNEST(con.conkey) WITH ORDINALITY
                            AS key(attnum, ordinal)
                          JOIN pg_attribute AS attr
                            ON attr.attrelid = con.conrelid
                           AND attr.attnum = key.attnum
                         ORDER BY key.ordinal
                      ) = ARRAY[
                        'tenant_id', 'pathway_governance_id',
                        'workflow_definition_id', 'pathway_definition_checksum'
                      ]::text[]
                      AND ARRAY(
                        SELECT attr.attname::text
                          FROM UNNEST(con.confkey) WITH ORDINALITY
                            AS key(attnum, ordinal)
                          JOIN pg_attribute AS attr
                            ON attr.attrelid = con.confrelid
                           AND attr.attnum = key.attnum
                         ORDER BY key.ordinal
                      ) = ARRAY[
                        'tenant_id', 'id', 'workflow_definition_id',
                        'definition_checksum'
                      ]::text[]
                      AND con.condeferrable
                      AND con.condeferred
                    )
                  )
                ) OR (
                  con.conrelid = TO_REGCLASS('public.care_pathway_instances')
                  AND (
                    (
                      con.conname =
                        'care_pathway_instances_definition_checksum_check'
                      AND con.contype = 'c'
                    ) OR (
                      con.conname =
                        'fk_care_pathway_instances_run_definition_pin'
                      AND con.contype = 'f'
                      AND con.confrelid = TO_REGCLASS('public.workflow_runs')
                      AND ARRAY(
                        SELECT attr.attname::text
                          FROM UNNEST(con.conkey) WITH ORDINALITY
                            AS key(attnum, ordinal)
                          JOIN pg_attribute AS attr
                            ON attr.attrelid = con.conrelid
                           AND attr.attnum = key.attnum
                         ORDER BY key.ordinal
                      ) = ARRAY[
                        'tenant_id', 'workflow_run_id', 'workflow_definition_id',
                        'definition_governance_id', 'definition_checksum'
                      ]::text[]
                      AND ARRAY(
                        SELECT attr.attname::text
                          FROM UNNEST(con.confkey) WITH ORDINALITY
                            AS key(attnum, ordinal)
                          JOIN pg_attribute AS attr
                            ON attr.attrelid = con.confrelid
                           AND attr.attnum = key.attnum
                         ORDER BY key.ordinal
                      ) = ARRAY[
                        'tenant_id', 'id', 'workflow_definition_id',
                        'pathway_governance_id', 'pathway_definition_checksum'
                      ]::text[]
                      AND con.condeferrable
                      AND con.condeferred
                    )
                  )
                )
              )
         ) AS care_pathway_governance_pin_constraint_count,
         (
           SELECT COUNT(*)::int
             FROM pg_index AS idx
            WHERE idx.indisvalid
              AND idx.indisready
              AND (
                (
                  idx.indexrelid = TO_REGCLASS(
                    'public.ux_care_pathway_governance_identity_pin'
                  )
                  AND idx.indrelid = TO_REGCLASS(
                    'public.care_pathway_definition_governance'
                  )
                  AND idx.indisunique
                ) OR (
                  idx.indexrelid = TO_REGCLASS(
                    'public.ux_workflow_runs_pathway_governance_pin'
                  )
                  AND idx.indrelid = TO_REGCLASS('public.workflow_runs')
                  AND idx.indisunique
                ) OR (
                  idx.indexrelid = TO_REGCLASS(
                    'public.idx_workflow_runs_governance_pin'
                  )
                  AND idx.indrelid = TO_REGCLASS('public.workflow_runs')
                ) OR (
                  idx.indexrelid = TO_REGCLASS(
                    'public.idx_care_pathway_instances_definition_pin'
                  )
                  AND idx.indrelid = TO_REGCLASS('public.care_pathway_instances')
                ) OR (
                  idx.indexrelid = TO_REGCLASS(
                    'public.ux_care_pathway_instances_run_definition_pin'
                  )
                  AND idx.indrelid = TO_REGCLASS('public.care_pathway_instances')
                  AND idx.indisunique
                ) OR (
                  idx.indexrelid = TO_REGCLASS(
                    'public.idx_care_pathway_governance_retired_by'
                  )
                  AND idx.indrelid = TO_REGCLASS(
                    'public.care_pathway_definition_governance'
                  )
                )
              )
              AND ARRAY(
                SELECT attr.attname::text
                  FROM UNNEST(idx.indkey) WITH ORDINALITY
                    AS key(attnum, ordinal)
                  JOIN pg_attribute AS attr
                    ON attr.attrelid = idx.indrelid
                   AND attr.attnum = key.attnum
                 WHERE key.ordinal <= idx.indnkeyatts
                 ORDER BY key.ordinal
              ) = CASE idx.indexrelid
                WHEN TO_REGCLASS('public.ux_care_pathway_governance_identity_pin')
                  THEN ARRAY[
                    'tenant_id', 'id', 'workflow_definition_id',
                    'definition_checksum'
                  ]::text[]
                WHEN TO_REGCLASS('public.ux_workflow_runs_pathway_governance_pin')
                  THEN ARRAY[
                    'tenant_id', 'id', 'workflow_definition_id',
                    'pathway_governance_id', 'pathway_definition_checksum'
                  ]::text[]
                WHEN TO_REGCLASS('public.idx_workflow_runs_governance_pin')
                  THEN ARRAY[
                    'tenant_id', 'pathway_governance_id',
                    'workflow_definition_id', 'pathway_definition_checksum'
                  ]::text[]
                WHEN TO_REGCLASS('public.idx_care_pathway_instances_definition_pin')
                  THEN ARRAY[
                    'tenant_id', 'workflow_run_id', 'workflow_definition_id',
                    'definition_governance_id', 'definition_checksum'
                  ]::text[]
                WHEN TO_REGCLASS('public.ux_care_pathway_instances_run_definition_pin')
                  THEN ARRAY[
                    'tenant_id', 'workflow_run_id', 'workflow_definition_id',
                    'definition_governance_id', 'definition_checksum'
                  ]::text[]
                WHEN TO_REGCLASS('public.idx_care_pathway_governance_retired_by')
                  THEN ARRAY['tenant_id', 'retired_by']::text[]
              END
              AND CASE idx.indexrelid
                WHEN TO_REGCLASS('public.idx_workflow_runs_governance_pin')
                  THEN PG_GET_EXPR(idx.indpred, idx.indrelid) =
                    '(pathway_governance_id IS NOT NULL)'
                WHEN TO_REGCLASS('public.idx_care_pathway_governance_retired_by')
                  THEN PG_GET_EXPR(idx.indpred, idx.indrelid) =
                    '(retired_by IS NOT NULL)'
                ELSE idx.indpred IS NULL
              END
         ) AS care_pathway_governance_pin_index_count,
         (
           SELECT COUNT(*)::int
            FROM pg_trigger AS trigger
            WHERE NOT trigger.tgisinternal
              AND trigger.tgenabled = 'O'
              AND (
                (
                  trigger.tgrelid = TO_REGCLASS(
                    'public.care_pathway_definition_governance'
                  )
                  AND trigger.tgname IN (
                    'trg_00_care_pathway_governance_serialization',
                    'trg_care_pathway_governance_non_patient_actors',
                    'trg_care_pathway_governance_approval_evidence',
                    'trg_care_pathway_governance_checksum_receipt',
                    'trg_care_pathway_governance_lifecycle',
                    'trg_care_pathway_governance_retirement_actor',
                    'trg_care_pathway_governance_retired_definition',
                    'trg_care_pathway_governance_run_companion'
                  )
                ) OR (
                  trigger.tgrelid = TO_REGCLASS('public.users')
                  AND trigger.tgname =
                    'trg_users_pathway_governance_non_patient_actors'
                ) OR (
                  trigger.tgrelid = TO_REGCLASS('public.approvals')
                  AND trigger.tgname IN (
                    'trg_approvals_pathway_governance_evidence',
                    'trg_approvals_pathway_governance_checksum_receipt',
                    'trg_approvals_pathway_governance_immutable'
                  )
                ) OR (
                  trigger.tgrelid = TO_REGCLASS('public.workflow_definitions')
                  AND trigger.tgname IN (
                    'trg_workflow_definitions_pathway_immutable',
                    'trg_workflow_definitions_pathway_retirement'
                  )
                ) OR (
                  trigger.tgrelid = TO_REGCLASS('public.workflow_runs')
                  AND trigger.tgname IN (
                    'trg_workflow_runs_pathway_governance_pin',
                    'trg_workflow_runs_pathway_companion'
                  )
                ) OR (
                  trigger.tgrelid = TO_REGCLASS('public.care_pathway_instances')
                  AND trigger.tgname IN (
                    'trg_care_pathway_instances_definition_pin_immutable',
                    'trg_care_pathway_instances_run_companion'
                  )
                ) OR (
                  trigger.tgrelid = TO_REGCLASS(
                    'public.care_pathway_transition_events'
                  )
                  AND trigger.tgname IN (
                    'trg_care_pathway_transition_requires_canonical_evidence',
                    'trg_care_pathway_transition_events_append_only',
                    'trg_care_pathway_creation_event_run_companion'
                  )
                ) OR (
                  trigger.tgrelid = TO_REGCLASS(
                    'public.clinical_timeline_events'
                  )
                  AND trigger.tgname =
                    'trg_clinical_timeline_pathway_creation_companion'
                ) OR (
                  trigger.tgrelid = TO_REGCLASS(
                    'public.clinical_audit_events'
                  )
                  AND trigger.tgname =
                    'trg_clinical_audit_pathway_creation_companion'
                )
              )
         ) AS care_pathway_governance_pin_trigger_count,
         (
           SELECT COUNT(*)::int
            FROM pg_trigger AS trigger
            WHERE NOT trigger.tgisinternal
              AND trigger.tgrelid = TO_REGCLASS('public.users')
              AND trigger.tgname = 'trg_users_pathway_governance_vote_actors'
         ) AS care_pathway_governance_revoked_trigger_count,
         COUNT(*) FILTER (
           WHERE table_name = 'lab_critical_alerts'
             AND column_name IN (
               'superseded_at',
               'superseded_by_alert_id',
               'superseded_by_signoff_id',
               'generation_signoff_id',
               'acknowledgement_task_id',
               'generation_metadata'
             )
         )::int AS critical_alert_generation_column_count,
         to_regclass('public.lab_critical_alert_acknowledgement_receipts')
            IS NOT NULL AS critical_alert_ack_receipt_table_exists,
         COUNT(*) FILTER (
           WHERE table_name = 'lab_critical_alert_acknowledgement_receipts'
             AND column_name IN (
               'tenant_id',
               'alert_id',
               'result_id',
               'patient_uid',
               'generation_signoff_id',
               'generation_state',
               'acknowledgement_task_id',
               'workflow_sla_instance_id',
               'task_comment_id',
               'timeline_event_id',
               'audit_event_id',
               'acknowledged_at',
               'acknowledged_by',
               'acknowledgement_authorization',
               'read_back_method',
               'task_status_at_ack',
               'comment_from_status',
               'sla_status_at_ack',
               'sla_completed_at',
               'sla_completed_via',
               'sla_completed_by_task',
               'sla_completed_by',
               'override_source',
               'override_id',
               'override_reason_sha256',
               'ack_contract_version',
               'created_at'
             )
         )::int AS critical_alert_ack_receipt_column_count,
         COUNT(*) FILTER (
           WHERE table_name = 'lab_critical_alert_acknowledgement_receipts'
             AND column_name = 'read_back_method'
             AND data_type = 'character varying'
             AND character_maximum_length = 160
         )::int AS critical_alert_ack_receipt_read_back_contract_column_count,
         (
           SELECT COUNT(*)::int
            FROM pg_trigger AS trigger
            WHERE NOT trigger.tgisinternal
              AND trigger.tgenabled <> 'D'
              AND (
                (
                  trigger.tgrelid = TO_REGCLASS(
                    'public.lab_critical_alert_acknowledgement_receipts'
                  )
                  AND trigger.tgname IN (
                    'trg_validate_lab_critical_alert_ack_receipt',
                    'trg_protect_lab_critical_alert_ack_receipt'
                  )
                ) OR (
                  trigger.tgrelid = TO_REGCLASS('public.task_comments')
                  AND trigger.tgname IN (
                    'trg_protect_lab_ack_receipt_task_comment',
                    'trg_validate_lab_critical_alert_ack_comment_set'
                  )
                ) OR (
                  trigger.tgrelid = TO_REGCLASS('public.clinical_timeline_events')
                  AND trigger.tgname = 'trg_protect_lab_ack_receipt_timeline'
                ) OR (
                  trigger.tgrelid = TO_REGCLASS('public.clinical_audit_events')
                  AND trigger.tgname = 'trg_protect_lab_ack_receipt_audit'
                )
              )
         ) AS critical_alert_ack_receipt_guard_trigger_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN (
       'lab_interface_messages',
       'lab_results',
       'lab_critical_alerts',
       'lab_critical_alert_acknowledgement_receipts',
       'care_pathway_definition_governance',
       'workflow_runs',
       'care_pathway_instances'
     )
`;

const VALID_LEGACY_IDENTITY = `
  result.hl7_message_id IS NOT NULL
  AND result.hl7_segment_index IS NOT NULL
  AND NULLIF(BTRIM(result.performed_by_lab), '') IS NOT NULL
  AND NULLIF(BTRIM(result.hl7_message_id), '') IS NOT NULL
  AND result.performed_by_lab = BTRIM(result.performed_by_lab)
  AND result.hl7_message_id = BTRIM(result.hl7_message_id)
  AND result.hl7_segment_index > 0
`;

function historicalLabAckContractQuery({ post581 }) {
  const alertGenerationColumns = post581
    ? `,
             alert.superseded_at,
             alert.superseded_by_alert_id,
             alert.superseded_by_signoff_id,
             alert.generation_signoff_id,
             alert.acknowledgement_task_id,
             alert.generation_metadata`
    : '';
  const acknowledgementReceiptColumns = post581
    ? `,
             ack_receipt.alert_id AS receipt_alert_id,
             ack_receipt.result_id AS receipt_result_id,
             ack_receipt.patient_uid AS receipt_patient_uid,
             ack_receipt.generation_signoff_id AS receipt_generation_signoff_id,
             ack_receipt.generation_state AS receipt_generation_state,
             ack_receipt.acknowledgement_task_id AS receipt_task_id,
             ack_receipt.workflow_sla_instance_id AS receipt_sla_id,
             ack_receipt.task_comment_id AS receipt_task_comment_id,
             ack_receipt.timeline_event_id AS receipt_timeline_event_id,
             ack_receipt.audit_event_id AS receipt_audit_event_id,
             ack_receipt.acknowledged_at AS receipt_acknowledged_at,
             ack_receipt.acknowledged_by AS receipt_acknowledged_by,
             ack_receipt.acknowledgement_authorization
               AS receipt_acknowledgement_authorization,
             ack_receipt.read_back_method AS receipt_read_back_method,
             ack_receipt.task_status_at_ack AS receipt_task_status_at_ack,
             ack_receipt.comment_from_status AS receipt_comment_from_status,
             ack_receipt.sla_status_at_ack AS receipt_sla_status_at_ack,
             ack_receipt.sla_completed_at AS receipt_sla_completed_at,
             ack_receipt.sla_completed_via AS receipt_sla_completed_via,
             ack_receipt.sla_completed_by_task AS receipt_sla_completed_by_task,
             ack_receipt.sla_completed_by AS receipt_sla_completed_by,
             ack_receipt.override_source AS receipt_override_source,
             ack_receipt.override_id AS receipt_override_id,
             ack_receipt.override_reason_sha256 AS receipt_override_reason_sha256,
             ack_receipt.ack_contract_version AS receipt_ack_contract_version`
    : '';
  const acknowledgementReceiptJoin = post581
    ? `
        LEFT JOIN lab_critical_alert_acknowledgement_receipts AS ack_receipt
          ON ack_receipt.tenant_id = alert.tenant_id
         AND ack_receipt.alert_id = alert.alert_id`
    : '';
  const receiptCommentScope = post581
    ? `
                  AND receipt.id = ack_receipt.task_comment_id
                  AND receipt.metadata->>'from' =
                        ack_receipt.comment_from_status`
    : '';
  const receiptTimelineScope = post581
    ? `
                  AND timeline.id = ack_receipt.timeline_event_id`
    : '';
  const receiptAuditScope = post581
    ? `
                  AND audit.id = ack_receipt.audit_event_id`
    : '';
  const taskCandidateScope = post581
    ? `
         AND (
           task.id = alert.acknowledgement_task_id
           OR task.metadata->>'lab_critical_alert_id' = alert.alert_id::text
           OR (
             alert.acknowledgement_task_id IS NULL
             AND task.metadata->>'lab_critical_alert_id' IS NULL
           )
         )`
    : '';
  const slaJoin = post581
    ? `sla.id = task.workflow_sla_instance_id`
    : `sla.id::text = LOWER(BTRIM(task.metadata->>'sla_instance_id'))`;
  const bindingPredicate = post581
    ? `
        rail.task_id = rail.acknowledgement_task_id
        AND rail.generation_metadata->>'acknowledgement_task_id' =
              rail.task_id::text
        AND rail.task_metadata->>'lab_critical_alert_id' = rail.alert_id::text
        AND rail.task_metadata->>'lab_alert_generation_signoff_id'
              IS NOT DISTINCT FROM rail.generation_signoff_id::text
        AND rail.task_metadata->>'lab_alert_generation_state' =
              rail.generation_metadata->>'corrected_state'
        AND NULLIF(rail.generation_metadata->>'corrected_state', '') IS NOT NULL
        AND (
          (
            rail.generation_signoff_id IS NULL
            AND rail.generation_metadata->>'kind' = 'initial_result_generation'
          ) OR (
            rail.generation_signoff_id IS NOT NULL
            AND rail.generation_metadata->>'kind' = 'corrected_result_generation'
          )
        )
        AND rail.task_sla_completion_semantics = 'acknowledgement'
        AND rail.task_workflow_sla_instance_id = rail.sla_id`
    : `
        rail.task_metadata->>'lab_critical_alert_id' = rail.alert_id::text
        AND rail.task_metadata->>'sla_key' = 'critical_result_ack'
        AND LOWER(BTRIM(rail.task_metadata->>'sla_instance_id')) =
              rail.sla_id::text`;
  const commentFromStatuses = post581
    ? "('open', 'overdue', 'blocked')"
    : "('open', 'overdue')";
  const allExactCommentCountColumn = post581
    ? `
             (
               SELECT COUNT(*)::int
                 FROM task_comments AS all_receipts
                WHERE all_receipts.tenant_id = alert.tenant_id
                  AND all_receipts.task_id = task.id
                  AND all_receipts.author_uid = alert.acknowledged_by
                  AND all_receipts.body_kind = 'state_change'
                  AND all_receipts.metadata->>'from' IN ${commentFromStatuses}
                  AND all_receipts.metadata->>'to' = 'in_progress'
                  AND all_receipts.metadata->>'acknowledged_at' =
                        task.metadata->>'acknowledged_at'
                  AND all_receipts.metadata->>'via' =
                        task.metadata->>'acknowledged_via'
                  AND all_receipts.metadata->>'ack_contract_version' = '2'
                  AND ABS(EXTRACT(EPOCH FROM (
                        all_receipts.created_at - alert.acknowledged_at
                      ))) <= 60
                  AND (
                    (
                      task.metadata->>'acknowledged_via' <> 'override'
                      AND NULLIF(
                            all_receipts.metadata->>'override_source',
                            ''
                          ) IS NULL
                      AND NULLIF(
                            all_receipts.metadata->>'override_id',
                            ''
                          ) IS NULL
                      AND NULLIF(
                            all_receipts.metadata->>'override_reason',
                            ''
                          ) IS NULL
                    ) OR (
                      task.metadata->>'acknowledged_via' = 'override'
                      AND all_receipts.metadata->>'override_source' =
                            task.metadata->>'acknowledge_override_source'
                      AND all_receipts.metadata->>'override_id' =
                            task.metadata->>'acknowledge_override_id'
                      AND all_receipts.metadata->>'override_reason' =
                            task.metadata->>'acknowledge_override_reason'
                    )
                  )
             ) AS all_exact_comment_count,`
    : '';
  const exactReceiptSupplementPredicate = post581
    ? `
               AND rail.all_exact_comment_count = 1`
    : '';
  const receiptSnapshotPredicate = post581
    ? `
        rail.receipt_alert_id = rail.alert_id
        AND rail.receipt_result_id = rail.result_id
        AND rail.receipt_patient_uid = rail.patient_uid
        AND rail.receipt_generation_signoff_id
              IS NOT DISTINCT FROM rail.generation_signoff_id
        AND rail.receipt_generation_state =
              rail.generation_metadata->>'corrected_state'
        AND rail.receipt_task_id = rail.task_id
        AND rail.receipt_task_id = rail.acknowledgement_task_id
        AND rail.receipt_sla_id = rail.sla_id
        AND rail.receipt_acknowledged_at = rail.acknowledged_at
        AND rail.receipt_acknowledged_by = rail.acknowledged_by
        AND rail.receipt_read_back_method
              IS NOT DISTINCT FROM rail.read_back_method
        AND rail.receipt_acknowledgement_authorization =
              rail.task_metadata->>'acknowledged_via'
        AND rail.receipt_task_status_at_ack IN ('in_progress', 'completed')
        AND rail.receipt_comment_from_status IN ('open', 'overdue', 'blocked')
        AND rail.receipt_sla_status_at_ack IN (
              'completed', 'breached', 'escalated'
            )
        AND rail.receipt_sla_completed_at = rail.acknowledged_at
        AND rail.receipt_sla_completed_via = 'task_ack'
        AND rail.receipt_sla_completed_by_task = rail.task_id
        AND rail.receipt_sla_completed_by = rail.acknowledged_by
        AND rail.receipt_ack_contract_version = 2
        AND (
          (
            rail.receipt_acknowledgement_authorization <> 'override'
            AND rail.receipt_override_source IS NULL
            AND rail.receipt_override_id IS NULL
            AND rail.receipt_override_reason_sha256 IS NULL
            AND NULLIF(
                  rail.task_metadata->>'acknowledge_override_source',
                  ''
                ) IS NULL
            AND NULLIF(
                  rail.task_metadata->>'acknowledge_override_id',
                  ''
                ) IS NULL
            AND NULLIF(
                  rail.task_metadata->>'acknowledge_override_reason',
                  ''
                ) IS NULL
          ) OR (
            rail.receipt_acknowledgement_authorization = 'override'
            AND rail.receipt_override_source = 'patient_access_break_glass'
            AND rail.receipt_override_source =
                  rail.task_metadata->>'acknowledge_override_source'
            AND rail.receipt_override_id =
                  rail.task_metadata->>'acknowledge_override_id'
            AND rail.receipt_override_reason_sha256 = ENCODE(public.DIGEST(
                  rail.task_metadata->>'acknowledge_override_reason',
                  'sha256'
                ), 'hex')
            AND rail.exact_override_authority
          )
        )`
    : 'TRUE';
  const slaClosurePredicate = post581
    ? `
        (${receiptSnapshotPredicate})
        AND (
          (
            rail.superseded_at IS NULL
            AND rail.superseded_by_alert_id IS NULL
            AND rail.superseded_by_signoff_id IS NULL
            AND rail.task_status = rail.receipt_task_status_at_ack
            AND rail.sla_status = rail.receipt_sla_status_at_ack
            AND rail.sla_completed_at = rail.receipt_sla_completed_at
            AND rail.sla_metadata->>'completed_via' =
                  rail.receipt_sla_completed_via
            AND rail.sla_metadata->>'completed_by_task' =
                  rail.receipt_sla_completed_by_task::text
            AND LOWER(rail.sla_metadata->>'completed_by') =
                  LOWER(rail.receipt_sla_completed_by::text)
            AND rail.sla_metadata->>'ack_contract_version' = '2'
          ) OR (
            rail.superseded_at IS NOT NULL
            AND rail.superseded_by_alert_id IS NOT NULL
            AND rail.superseded_by_signoff_id IS NOT NULL
          )
        )`
    : `
        rail.sla_status IN ('completed', 'breached', 'escalated')
        AND rail.sla_completed_at = rail.acknowledged_at
        AND rail.sla_metadata->>'completed_via' = 'task_ack'
        AND rail.sla_metadata->>'completed_by_task' = rail.task_id::text
        AND LOWER(rail.sla_metadata->>'completed_by') =
              LOWER(rail.acknowledged_by::text)
        AND rail.sla_metadata->>'ack_contract_version' = '2'`;
  const actionablePredicate = post581
    ? `
        rail.task_status IN ('open', 'blocked', 'overdue')
        OR (
          rail.superseded_at IS NULL
          AND rail.superseded_by_alert_id IS NULL
          AND rail.superseded_by_signoff_id IS NULL
          AND (
            rail.sla_completed_at IS NULL
            OR rail.sla_status IN ('active', 'cancelled')
          )
        )`
    : `
        rail.task_status IN ('open', 'blocked', 'overdue')
        OR rail.sla_completed_at IS NULL
        OR rail.sla_status IN ('active', 'cancelled')`;
  const weakReceiptPredicate = post581
    ? `
                    OR rail.receipt_ack_contract_version IS DISTINCT FROM 2
                    OR rail.all_exact_comment_count <> 1`
    : '';
  const contractBranch = post581 ? 'post_581' : 'pre_581';

  return `
    WITH alert_candidates AS (
      SELECT alert.id AS alert_id,
             alert.tenant_id,
             alert.patient_uid,
             alert.result_id,
             alert.fired_at,
             alert.acknowledged_at,
             alert.acknowledged_by,
             alert.read_back_method${alertGenerationColumns}
        FROM lab_critical_alerts AS alert
    ), rail_candidates AS (
      SELECT alert.*,
             task.id AS task_id,
             task.status AS task_status,
             task.metadata AS task_metadata,
             task.assigned_to_uid AS task_assigned_to_uid,
             task.assigned_to_role AS task_assigned_to_role,
             ${post581 ? 'task.workflow_sla_instance_id' : 'NULL::uuid'}
               AS task_workflow_sla_instance_id,
             ${post581 ? 'task.sla_completion_semantics' : 'NULL::text'}
               AS task_sla_completion_semantics,
             sla.id AS sla_id,
             sla.status AS sla_status,
             sla.completed_at AS sla_completed_at,
             sla.metadata AS sla_metadata${acknowledgementReceiptColumns},
             (
               SELECT COUNT(*)::int
                 FROM task_comments AS receipt
                WHERE receipt.tenant_id = alert.tenant_id
                  AND receipt.task_id = task.id
                  AND receipt.author_uid = alert.acknowledged_by
                  AND receipt.body_kind = 'state_change'
                  AND receipt.metadata->>'from' IN ${commentFromStatuses}
                  AND receipt.metadata->>'to' = 'in_progress'
                  AND receipt.metadata->>'acknowledged_at' =
                        task.metadata->>'acknowledged_at'
                  AND receipt.metadata->>'via' =
                        task.metadata->>'acknowledged_via'
                  AND receipt.metadata->>'ack_contract_version' = '2'
                  ${receiptCommentScope}
                  AND ABS(EXTRACT(EPOCH FROM (
                        receipt.created_at - alert.acknowledged_at
                      ))) <= 60
                  AND (
                    (
                      task.metadata->>'acknowledged_via' <> 'override'
                      AND NULLIF(receipt.metadata->>'override_source', '') IS NULL
                      AND NULLIF(receipt.metadata->>'override_id', '') IS NULL
                      AND NULLIF(receipt.metadata->>'override_reason', '') IS NULL
                    ) OR (
                      task.metadata->>'acknowledged_via' = 'override'
                      AND receipt.metadata->>'override_source' =
                            task.metadata->>'acknowledge_override_source'
                      AND receipt.metadata->>'override_id' =
                            task.metadata->>'acknowledge_override_id'
                      AND receipt.metadata->>'override_reason' =
                            task.metadata->>'acknowledge_override_reason'
                    )
                  )
             ) AS exact_comment_count,
             ${allExactCommentCountColumn}
             (
               SELECT COUNT(*)::int
                 FROM clinical_timeline_events AS timeline
                WHERE timeline.tenant_id = alert.tenant_id
                  AND timeline.patient_uid = alert.patient_uid
                  AND timeline.event_type = 'critical_result.acknowledged'
                  AND timeline.event_status = 'acknowledged'
                  AND timeline.source_table = 'lab_critical_alerts'
                  AND timeline.source_id = alert.alert_id::text
                  AND timeline.resource_type = 'critical_lab_alert'
                  AND timeline.resource_id = alert.alert_id::text
                  AND timeline.actor_uid = alert.acknowledged_by
                  AND timeline.occurred_at = alert.acknowledged_at
                  AND timeline.idempotency_key =
                        'lab_critical_alerts:' || alert.alert_id || ':acknowledged'
                  AND timeline.payload->'alert_id' = TO_JSONB(alert.alert_id)
                  AND timeline.payload->'result_id' = TO_JSONB(alert.result_id)
                  AND timeline.payload->>'acknowledgement_authorization' =
                        task.metadata->>'acknowledged_via'
                  AND timeline.payload->>'ack_contract_version' = '2'
                  ${receiptTimelineScope}
                  AND timeline.payload ? 'read_back_method'
                  AND timeline.payload->>'read_back_method'
                        IS NOT DISTINCT FROM alert.read_back_method
                  AND (
                    (
                      task.metadata->>'acknowledged_via' <> 'override'
                      AND timeline.payload->>'acknowledge_override_source' IS NULL
                      AND timeline.payload->>'acknowledge_override_id' IS NULL
                      AND timeline.payload->>'acknowledge_override_reason' IS NULL
                    ) OR (
                      task.metadata->>'acknowledged_via' = 'override'
                      AND timeline.payload->>'acknowledge_override_source' =
                            task.metadata->>'acknowledge_override_source'
                      AND timeline.payload->>'acknowledge_override_id' =
                            task.metadata->>'acknowledge_override_id'
                      AND timeline.payload->>'acknowledge_override_reason' =
                            task.metadata->>'acknowledge_override_reason'
                    )
                  )
             ) AS exact_timeline_count,
             (
               SELECT COUNT(*)::int
                 FROM clinical_audit_events AS audit
                WHERE audit.tenant_id = alert.tenant_id
                  AND audit.patient_uid = alert.patient_uid
                  AND audit.action = 'critical_result.acknowledged'
                  AND audit.action_status = 'success'
                  AND audit.resource_table = 'lab_critical_alerts'
                  AND audit.resource_id = alert.alert_id::text
                  AND audit.resource_type = 'critical_lab_alert'
                  AND audit.actor_uid = alert.acknowledged_by
                  AND audit.occurred_at = alert.acknowledged_at
                  AND audit.idempotency_key =
                        'lab_critical_alerts:' || alert.alert_id
                          || ':audit:acknowledged'
                  AND audit.metadata->>'ack_contract_version' = '2'
                  AND audit.after_state->>'ack_contract_version' = '2'
                  ${receiptAuditScope}
                  AND CASE
                        WHEN PG_INPUT_IS_VALID(
                               audit.after_state->>'acknowledged_at',
                               'timestamp with time zone'
                             )
                          THEN (
                            audit.after_state->>'acknowledged_at'
                          )::timestamptz = alert.acknowledged_at
                        ELSE FALSE
                      END
                  AND LOWER(audit.after_state->>'acknowledged_by') =
                        LOWER(alert.acknowledged_by::text)
                  AND audit.after_state ? 'read_back_method'
                  AND audit.after_state->>'read_back_method'
                        IS NOT DISTINCT FROM alert.read_back_method
             ) AS exact_audit_count,
             EXISTS (
               SELECT 1
                 FROM patient_access_break_glass AS break_glass
                WHERE task.metadata->>'acknowledged_via' = 'override'
                  AND task.metadata->>'acknowledge_override_source' =
                        'patient_access_break_glass'
                  AND task.metadata->>'acknowledge_override_id' ~ '^[1-9][0-9]*$'
                  AND break_glass.id::text =
                        task.metadata->>'acknowledge_override_id'
                  AND break_glass.tenant_id = alert.tenant_id
                  AND break_glass.patient_uid = alert.patient_uid
                  AND break_glass.actor_uid = alert.acknowledged_by
                  AND break_glass.reason =
                        task.metadata->>'acknowledge_override_reason'
                  AND NULLIF(BTRIM(break_glass.reason), '') IS NOT NULL
                  AND break_glass.started_at <= alert.acknowledged_at
                  AND break_glass.expires_at > alert.acknowledged_at
                  AND (
                    break_glass.ended_at IS NULL
                    OR break_glass.ended_at >= alert.acknowledged_at
                  )
                  AND COALESCE((
                    SELECT history.to_status
                      FROM patient_access_break_glass_status_history AS history
                     WHERE history.tenant_id = break_glass.tenant_id
                       AND history.break_glass_id = break_glass.id
                       AND history.created_at <= alert.acknowledged_at
                     ORDER BY history.created_at DESC, history.id DESC
                     LIMIT 1
                  ), break_glass.status) = 'active'
             ) AS exact_override_authority
        FROM alert_candidates AS alert
        LEFT JOIN tasks AS task
          ON task.tenant_id = alert.tenant_id
         AND task.patient_uid = alert.patient_uid
         AND task.related_resource_type = 'lab_result'
         AND task.related_resource_id = alert.result_id::text${taskCandidateScope}
        LEFT JOIN workflow_sla_instances AS sla
          ON sla.tenant_id = task.tenant_id
         AND ${slaJoin}${acknowledgementReceiptJoin}
    ), classified_rails AS (
      SELECT rail.*,
             (
               rail.task_id IS NOT NULL
               AND (
                 rail.task_status IN ('in_progress', 'completed')
                 OR NULLIF(rail.task_metadata->>'acknowledged_at', '') IS NOT NULL
                 OR NULLIF(rail.task_metadata->>'acknowledged_by', '') IS NOT NULL
                 OR NULLIF(rail.task_metadata->>'acknowledged_via', '') IS NOT NULL
                 OR rail.sla_completed_at IS NOT NULL
                 OR NULLIF(rail.sla_metadata->>'completed_via', '') IS NOT NULL
               )
             ) AS structural_task_ack,
             (
               rail.task_id IS NOT NULL
               AND (${bindingPredicate})
             ) AS exact_binding,
             (
               rail.task_id IS NOT NULL
               AND rail.acknowledged_at IS NOT NULL
               AND rail.acknowledged_by IS NOT NULL
               AND rail.acknowledged_at >= rail.fired_at
               AND (${bindingPredicate})
               AND rail.task_status IN ('in_progress', 'completed')
               AND rail.task_metadata->>'ack_contract_version' = '2'
               AND rail.task_metadata->>'acknowledged_via' IN (
                     'assignee', 'role', 'admin', 'override'
                   )
               AND LOWER(rail.task_metadata->>'acknowledged_by') =
                     LOWER(rail.acknowledged_by::text)
               AND rail.task_metadata->>'acknowledged_at' ~
                     '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
               AND CASE
                     WHEN PG_INPUT_IS_VALID(
                            rail.task_metadata->>'acknowledged_at',
                            'timestamp with time zone'
                          )
                       THEN (
                         rail.task_metadata->>'acknowledged_at'
                       )::timestamptz = rail.acknowledged_at
                     ELSE FALSE
                   END
               AND rail.sla_rule_code = 'critical_result_ack'
               AND rail.sla_source_table = 'lab_result'
               AND rail.sla_source_id = rail.result_id::text
               AND rail.sla_patient_uid = rail.patient_uid
               AND (${slaClosurePredicate})
               AND rail.exact_comment_count = 1
               ${exactReceiptSupplementPredicate}
               AND rail.exact_timeline_count = 1
               AND rail.exact_audit_count = 1
               AND (
                 (
                   rail.task_metadata->>'acknowledged_via' = 'assignee'
                   AND rail.task_assigned_to_uid = rail.acknowledged_by
                 ) OR (
                   rail.task_metadata->>'acknowledged_via' = 'role'
                   AND NULLIF(BTRIM(rail.task_assigned_to_role), '') IS NOT NULL
                 )
                 OR rail.task_metadata->>'acknowledged_via' = 'admin'
                 OR (
                   rail.task_metadata->>'acknowledged_via' = 'override'
                   AND rail.exact_override_authority
                 )
               )
             ) AS exact_contract,
             (
               rail.task_id IS NOT NULL
               AND (${actionablePredicate})
             ) AS actionable_candidate
        FROM (
          SELECT candidate.*,
                 sla.rule_code AS sla_rule_code,
                 sla.source_table AS sla_source_table,
                 sla.source_id AS sla_source_id,
                 sla.patient_uid AS sla_patient_uid
            FROM rail_candidates AS candidate
            LEFT JOIN workflow_sla_instances AS sla
              ON sla.tenant_id = candidate.tenant_id
             AND sla.id = candidate.sla_id
        ) AS rail
    ), rollups AS (
      SELECT rail.tenant_id,
             rail.alert_id,
             rail.patient_uid,
             rail.result_id,
             rail.fired_at,
             rail.acknowledged_at,
             rail.acknowledged_by,
             COUNT(rail.task_id)::int AS candidate_task_count,
             COUNT(*) FILTER (WHERE rail.exact_binding)::int AS bound_task_count,
             COUNT(*) FILTER (WHERE rail.structural_task_ack)::int
               AS structural_task_ack_count,
             COUNT(*) FILTER (WHERE rail.actionable_candidate)::int
               AS actionable_candidate_count,
             COUNT(*) FILTER (WHERE rail.exact_contract)::int
               AS exact_contract_count,
             COUNT(*) FILTER (
               WHERE rail.structural_task_ack
                 AND (
                   rail.task_metadata->>'ack_contract_version' IS DISTINCT FROM '2'
                   OR rail.sla_metadata->>'ack_contract_version' IS DISTINCT FROM '2'
                   OR rail.exact_comment_count <> 1
                    OR rail.exact_timeline_count <> 1
                    OR rail.exact_audit_count <> 1
                    ${weakReceiptPredicate}
                  )
             )::int AS unversioned_or_weak_contract_count,
             MIN(rail.task_id) AS sample_task_id,
             MIN(rail.sla_id::text)::uuid AS sample_sla_id
        FROM classified_rails AS rail
       GROUP BY rail.tenant_id,
                rail.alert_id,
                rail.patient_uid,
                rail.result_id,
                rail.fired_at,
                rail.acknowledged_at,
                rail.acknowledged_by
    ), findings AS (
      SELECT rollup.*,
             ARRAY_REMOVE(ARRAY[
               CASE WHEN (
                 rollup.acknowledged_at IS NULL
                 OR rollup.acknowledged_by IS NULL
                 OR rollup.acknowledged_at < rollup.fired_at
               ) THEN 'alert_ack_fields_weak_or_split' END,
               CASE WHEN rollup.bound_task_count = 0 THEN 'unbound' END,
               CASE WHEN rollup.bound_task_count > 1 THEN 'ambiguous_task' END,
               CASE WHEN (
                 rollup.structural_task_ack_count > 0
                 AND (
                   rollup.acknowledged_at IS NULL
                   OR rollup.acknowledged_by IS NULL
                 )
               ) THEN 'task_ack_alert_open_split' END,
               CASE WHEN rollup.actionable_candidate_count > 0
                 THEN 'actionable_after_ack' END,
               CASE WHEN rollup.unversioned_or_weak_contract_count > 0
                 THEN 'unversioned_or_weak_ack_contract' END,
               CASE WHEN rollup.exact_contract_count <> 1
                 THEN 'exact_ack_contract_mismatch' END
             ], NULL)::text[] AS blocking_reasons
        FROM rollups AS rollup
       WHERE (
         rollup.acknowledged_at IS NOT NULL
         OR rollup.acknowledged_by IS NOT NULL
         OR rollup.structural_task_ack_count > 0
       )
         AND NOT (
           rollup.acknowledged_at IS NOT NULL
           AND rollup.acknowledged_by IS NOT NULL
           AND rollup.acknowledged_at >= rollup.fired_at
           AND rollup.bound_task_count = 1
           AND rollup.structural_task_ack_count = 1
           AND rollup.exact_contract_count = 1
         )
    ), ranked AS (
      SELECT finding.*,
             COUNT(*) OVER (PARTITION BY finding.tenant_id)::bigint AS total_count,
             ROW_NUMBER() OVER (
               PARTITION BY finding.tenant_id
               ORDER BY finding.alert_id
             ) AS sample_rank
        FROM findings AS finding
    )
    SELECT ranked.tenant_id,
           'historical_lab_ack_contract_violations'::text AS issue_key,
           ranked.total_count,
           ranked.sample_rank,
           '${contractBranch}'::text AS contract_branch,
             ENCODE(DIGEST(CONCAT_WS(
               '|',
               'lab-ack-contract',
               ranked.tenant_id::text,
               ranked.alert_id::text,
               COALESCE(ranked.sample_task_id::text, '-'),
               COALESCE(ranked.sample_sla_id::text, '-'),
               COALESCE(EXTRACT(EPOCH FROM ranked.acknowledged_at)::text, '-')
           ), 'sha256'), 'hex') AS acknowledgement_contract_fingerprint,
           ranked.candidate_task_count,
           ranked.bound_task_count,
           ranked.structural_task_ack_count,
           ranked.actionable_candidate_count,
           ranked.exact_contract_count,
           ranked.unversioned_or_weak_contract_count,
           ranked.blocking_reasons
      FROM ranked
     WHERE ranked.sample_rank <= $1::int
     ORDER BY ranked.tenant_id, ranked.sample_rank
  `;
}

export const REPORT_QUERY_KEYS = Object.freeze([
  'identity_issues',
  'duplicate_identities',
  'sender_issues',
  'adoption_eligibility',
]);

export const PRE_581_ACK_REPORT_QUERY_KEYS = Object.freeze([
  'historical_lab_ack_contract_pre_581',
]);

export const POST_581_ACK_REPORT_QUERY_KEYS = Object.freeze([
  'historical_lab_ack_contract_post_581',
]);

export const POST_582_REPORT_QUERY_KEYS = Object.freeze([
  'oru_claim_source_readiness',
]);

export const PRE_583_REPORT_QUERY_KEYS = Object.freeze([
  'astm_duplicate_fingerprints',
  'astm_legacy_receipt_readiness',
]);

export const POST_583_REPORT_QUERY_KEYS = Object.freeze([
  'astm_duplicate_fingerprints',
  'astm_atomic_contract_readiness',
]);

export const POST_584_REPORT_QUERY_KEYS = Object.freeze([
  'care_pathway_governance_pinning_readiness',
]);

export const REPORT_QUERIES = Object.freeze({
  historical_lab_ack_contract_pre_581: historicalLabAckContractQuery({ post581: false }),
  historical_lab_ack_contract_post_581: historicalLabAckContractQuery({ post581: true }),
  identity_issues: `
    WITH replay_candidates AS (
      SELECT result.id,
             result.tenant_id,
             result.performed_by_lab,
             result.hl7_message_id,
             result.hl7_segment_index,
             CASE
               WHEN (
                 result.performed_by_lab IS NOT NULL
                 AND (
                   NULLIF(BTRIM(result.performed_by_lab), '') IS NULL
                   OR result.performed_by_lab IS DISTINCT FROM BTRIM(result.performed_by_lab)
                 )
               ) OR (
                 result.hl7_message_id IS NOT NULL
                 AND (
                   NULLIF(BTRIM(result.hl7_message_id), '') IS NULL
                   OR result.hl7_message_id IS DISTINCT FROM BTRIM(result.hl7_message_id)
                 )
               ) THEN 'whitespace_legacy_identities'
               WHEN (result.hl7_message_id IS NULL) <> (result.hl7_segment_index IS NULL)
                 OR (
                   result.hl7_message_id IS NOT NULL
                   AND (
                     result.performed_by_lab IS NULL
                     OR result.hl7_segment_index IS NULL
                     OR result.hl7_segment_index <= 0
                   )
                 ) THEN 'incomplete_legacy_identities'
               ELSE NULL
             END AS issue_key
       FROM lab_results AS result
       WHERE (
         result.hl7_message_id IS NOT NULL
         OR result.hl7_segment_index IS NOT NULL
       )
         AND (TO_JSONB(result)->>'oru_ingest_message_id') IS NULL
    ), ranked AS (
      SELECT candidate.*,
             COUNT(*) OVER (
               PARTITION BY candidate.tenant_id, candidate.issue_key
             )::bigint AS total_count,
             ROW_NUMBER() OVER (
               PARTITION BY candidate.tenant_id, candidate.issue_key
               ORDER BY candidate.id
             ) AS sample_rank
        FROM replay_candidates AS candidate
       WHERE candidate.issue_key IS NOT NULL
    )
    SELECT ranked.tenant_id,
           ranked.issue_key,
           ranked.total_count,
           ranked.sample_rank,
           SUBSTRING(
             MD5(ranked.tenant_id::text || ':lab_result:' || ranked.id::text)
             FROM 1 FOR 16
           ) AS lab_result_fingerprint,
           ranked.performed_by_lab AS sender_identity,
           CASE
             WHEN ranked.hl7_message_id IS NULL THEN NULL
             ELSE SUBSTRING(MD5(ranked.hl7_message_id) FROM 1 FOR 12)
           END AS message_id_fingerprint,
           ranked.hl7_segment_index,
           LENGTH(ranked.performed_by_lab) AS sender_length,
           LENGTH(BTRIM(ranked.performed_by_lab)) AS sender_trimmed_length,
           LENGTH(ranked.hl7_message_id) AS message_id_length,
           LENGTH(BTRIM(ranked.hl7_message_id)) AS message_id_trimmed_length
      FROM ranked
     WHERE ranked.sample_rank <= $1::int
     ORDER BY ranked.tenant_id, ranked.issue_key, ranked.sample_rank
  `,

  duplicate_identities: `
    WITH duplicate_groups AS (
      SELECT result.tenant_id,
             result.performed_by_lab AS sender_identity,
             result.hl7_message_id,
             result.hl7_segment_index,
             COUNT(*)::bigint AS row_count,
             (ARRAY_AGG(
               SUBSTRING(
                 MD5(result.tenant_id::text || ':lab_result:' || result.id::text)
                 FROM 1 FOR 16
               )
               ORDER BY result.id
             ))[1:$1::int] AS result_evidence_fingerprints
       FROM lab_results AS result
       WHERE result.performed_by_lab IS NOT NULL
         AND result.hl7_message_id IS NOT NULL
         AND result.hl7_segment_index IS NOT NULL
         AND (TO_JSONB(result)->>'oru_ingest_message_id') IS NULL
       GROUP BY result.tenant_id,
                result.performed_by_lab,
                result.hl7_message_id,
                result.hl7_segment_index
      HAVING COUNT(*) > 1
    ), ranked AS (
      SELECT duplicate_group.*,
             COUNT(*) OVER (
               PARTITION BY duplicate_group.tenant_id
             )::bigint AS total_count,
             ROW_NUMBER() OVER (
               PARTITION BY duplicate_group.tenant_id
               ORDER BY duplicate_group.sender_identity,
                        duplicate_group.hl7_message_id,
                        duplicate_group.hl7_segment_index
             ) AS sample_rank
        FROM duplicate_groups AS duplicate_group
    )
    SELECT ranked.tenant_id,
           'duplicate_legacy_identities'::text AS issue_key,
           ranked.total_count,
           ranked.sample_rank,
           ranked.sender_identity,
           SUBSTRING(MD5(ranked.hl7_message_id) FROM 1 FOR 12) AS message_id_fingerprint,
           ranked.hl7_segment_index,
           ranked.row_count,
           ranked.result_evidence_fingerprints
      FROM ranked
     WHERE ranked.sample_rank <= $1::int
     ORDER BY ranked.tenant_id, ranked.sample_rank
  `,

  sender_issues: `
    WITH legacy_senders AS (
      SELECT result.tenant_id,
             result.performed_by_lab AS sender_identity,
             COUNT(*)::bigint AS legacy_result_count,
             COUNT(DISTINCT result.hl7_message_id)::bigint AS legacy_message_count
       FROM lab_results AS result
       WHERE ${VALID_LEGACY_IDENTITY}
         AND (TO_JSONB(result)->>'oru_ingest_message_id') IS NULL
       GROUP BY result.tenant_id, result.performed_by_lab
    ), runtime_analyzers AS (
      SELECT analyzer.id,
             analyzer.tenant_id,
             analyzer.analyzer_code,
             analyzer.status,
             analyzer.interface_kind,
             analyzer.metadata
        FROM lab_analyzers AS analyzer
       WHERE analyzer.status = 'active'
         AND analyzer.interface_kind = 'hl7'
    ), configured_bindings AS (
      SELECT analyzer.tenant_id,
             analyzer.id AS analyzer_id,
             'api_client'::text AS binding_kind,
             LOWER(BTRIM(binding.value)) AS binding_value
        FROM runtime_analyzers AS analyzer
        CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS_TEXT(
          CASE
            WHEN JSONB_TYPEOF(analyzer.metadata->'hl7_api_client_ids') = 'array'
              THEN analyzer.metadata->'hl7_api_client_ids'
            ELSE '[]'::jsonb
          END
        ) AS binding(value)
       WHERE NULLIF(BTRIM(binding.value), '') IS NOT NULL
      UNION ALL
      SELECT analyzer.tenant_id,
             analyzer.id AS analyzer_id,
             'actor_uid'::text AS binding_kind,
             LOWER(BTRIM(binding.value)) AS binding_value
        FROM runtime_analyzers AS analyzer
        CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS_TEXT(
          CASE
            WHEN JSONB_TYPEOF(analyzer.metadata->'hl7_actor_uids') = 'array'
              THEN analyzer.metadata->'hl7_actor_uids'
            ELSE '[]'::jsonb
          END
        ) AS binding(value)
       WHERE NULLIF(BTRIM(binding.value), '') IS NOT NULL
    ), binding_fanout AS (
      SELECT binding.tenant_id,
             binding.binding_kind,
             binding.binding_value,
             COUNT(DISTINCT binding.analyzer_id)::int AS analyzer_count
        FROM configured_bindings AS binding
       GROUP BY binding.tenant_id, binding.binding_kind, binding.binding_value
    ), analyzer_binding_summary AS (
      SELECT analyzer.tenant_id,
             analyzer.id AS analyzer_id,
             COUNT(DISTINCT (binding.binding_kind, binding.binding_value))::int
               AS configured_binding_count,
             COUNT(DISTINCT (binding.binding_kind, binding.binding_value)) FILTER (
               WHERE fanout.analyzer_count = 1
             )::int AS unique_binding_count
        FROM runtime_analyzers AS analyzer
        LEFT JOIN configured_bindings AS binding
          ON binding.tenant_id = analyzer.tenant_id
         AND binding.analyzer_id = analyzer.id
        LEFT JOIN binding_fanout AS fanout
          ON fanout.tenant_id = binding.tenant_id
         AND fanout.binding_kind = binding.binding_kind
         AND fanout.binding_value = binding.binding_value
       GROUP BY analyzer.tenant_id, analyzer.id
    ), sender_mapping AS (
      SELECT sender.tenant_id,
             sender.sender_identity,
             sender.legacy_result_count,
             sender.legacy_message_count,
             exact_analyzer.id AS analyzer_id,
             exact_analyzer.interface_kind,
             exact_analyzer.status,
             COALESCE(binding_summary.configured_binding_count, 0) AS configured_binding_count,
             COALESCE(binding_summary.unique_binding_count, 0) AS unique_binding_count,
             normalized_match.normalized_match_count,
             normalized_match.normalized_candidates
        FROM legacy_senders AS sender
        LEFT JOIN lab_analyzers AS exact_analyzer
          ON exact_analyzer.tenant_id = sender.tenant_id
         AND exact_analyzer.analyzer_code = sender.sender_identity
        LEFT JOIN analyzer_binding_summary AS binding_summary
          ON binding_summary.tenant_id = exact_analyzer.tenant_id
         AND binding_summary.analyzer_id = exact_analyzer.id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS normalized_match_count,
                 (ARRAY_AGG(candidate.analyzer_code ORDER BY candidate.analyzer_code))[1:5]
                   AS normalized_candidates
            FROM lab_analyzers AS candidate
           WHERE candidate.tenant_id = sender.tenant_id
             AND LOWER(BTRIM(candidate.analyzer_code)) =
                   LOWER(BTRIM(sender.sender_identity))
        ) AS normalized_match ON TRUE
    ), classified AS (
      SELECT mapping.*,
             CASE
               WHEN mapping.analyzer_id IS NULL
                 AND mapping.normalized_match_count > 1
                 THEN 'ambiguous_hl7_senders'
               WHEN mapping.analyzer_id IS NULL
                 THEN 'unmapped_hl7_senders'
               WHEN mapping.interface_kind <> 'hl7'
                 THEN 'unmapped_hl7_senders'
               WHEN mapping.status <> 'active'
                 THEN 'inactive_hl7_senders'
               WHEN mapping.configured_binding_count = 0
                 THEN 'unmapped_hl7_senders'
               WHEN mapping.unique_binding_count = 0
                 THEN 'ambiguous_hl7_senders'
               ELSE NULL
             END AS issue_key,
             CASE
               WHEN mapping.analyzer_id IS NULL
                 AND mapping.normalized_match_count > 1
                 THEN 'multiple_normalized_analyzer_candidates'
               WHEN mapping.analyzer_id IS NULL
                 AND mapping.normalized_match_count = 1
                 THEN 'normalization_only_match_is_not_provenance'
               WHEN mapping.analyzer_id IS NULL
                 THEN 'no_exact_analyzer_code'
               WHEN mapping.interface_kind <> 'hl7'
                 THEN 'exact_analyzer_is_not_hl7'
               WHEN mapping.status <> 'active'
                 THEN 'exact_hl7_analyzer_is_not_active'
               WHEN mapping.configured_binding_count = 0
                 THEN 'no_trusted_channel_binding'
               WHEN mapping.unique_binding_count = 0
                 THEN 'all_trusted_channel_bindings_are_shared'
               ELSE NULL
             END AS reason
        FROM sender_mapping AS mapping
    ), ranked AS (
      SELECT classified.*,
             COUNT(*) OVER (
               PARTITION BY classified.tenant_id, classified.issue_key
             )::bigint AS total_count,
             ROW_NUMBER() OVER (
               PARTITION BY classified.tenant_id, classified.issue_key
               ORDER BY classified.sender_identity
             ) AS sample_rank
        FROM classified
       WHERE classified.issue_key IS NOT NULL
    )
    SELECT ranked.tenant_id,
           ranked.issue_key,
           ranked.total_count,
           ranked.sample_rank,
           ranked.sender_identity,
           ranked.reason,
           ranked.legacy_result_count,
           ranked.legacy_message_count,
           CASE
             WHEN ranked.analyzer_id IS NULL THEN NULL
             ELSE SUBSTRING(
               MD5(ranked.tenant_id::text || ':lab_analyzer:' || ranked.analyzer_id::text)
               FROM 1 FOR 16
             )
           END AS analyzer_channel_fingerprint,
           ranked.interface_kind,
           ranked.status,
           ranked.configured_binding_count,
           ranked.unique_binding_count,
           ranked.normalized_match_count,
           ranked.normalized_candidates
      FROM ranked
     WHERE ranked.sample_rank <= $1::int
     ORDER BY ranked.tenant_id, ranked.issue_key, ranked.sample_rank
  `,

  adoption_eligibility: `
    WITH valid_rows AS (
      SELECT result.id,
             result.tenant_id,
             result.performed_by_lab AS sender_identity,
             result.hl7_message_id,
             result.hl7_segment_index,
             result.patient_uid,
             result.booking_id,
             result.investigation_id,
             result.raw_obx,
             result.analyzer_id
       FROM lab_results AS result
       WHERE ${VALID_LEGACY_IDENTITY}
         AND (TO_JSONB(result)->>'oru_ingest_message_id') IS NULL
    ), message_groups AS (
      SELECT result.tenant_id,
             result.sender_identity,
             result.hl7_message_id,
             COUNT(*)::bigint AS result_count,
             COUNT(DISTINCT result.hl7_segment_index)::bigint AS segment_count,
             MIN(result.hl7_segment_index)::int AS first_segment_index,
             MAX(result.hl7_segment_index)::int AS last_segment_index,
             (ARRAY_AGG(
               SUBSTRING(
                 MD5(result.tenant_id::text || ':lab_result:' || result.id::text)
                 FROM 1 FOR 16
               )
               ORDER BY result.id
             ))[1:$1::int] AS result_evidence_fingerprints,
             BOOL_AND(result.patient_uid IS NOT NULL)
               AND COUNT(DISTINCT COALESCE(result.patient_uid::text, '<null>')) = 1
               AS patient_is_coherent,
             COUNT(DISTINCT COALESCE(result.booking_id::text, '<null>')) = 1
               AS booking_is_coherent,
             COUNT(DISTINCT COALESCE(result.investigation_id::text, '<null>')) = 1
               AS investigation_is_coherent,
             BOOL_AND(result.booking_id IS NULL AND result.investigation_id IS NULL)
               AS patient_only_unlinked,
             BOOL_AND(NULLIF(BTRIM(result.raw_obx), '') IS NOT NULL)
               AS raw_obx_is_present,
             BOOL_AND(
               result.analyzer_id IS NULL
               OR (analyzer.id IS NOT NULL AND result.analyzer_id = analyzer.id)
             ) AS analyzer_link_is_compatible,
             analyzer.id AS analyzer_id,
             analyzer.interface_kind,
             analyzer.status
        FROM valid_rows AS result
        LEFT JOIN lab_analyzers AS analyzer
          ON analyzer.tenant_id = result.tenant_id
         AND analyzer.analyzer_code = result.sender_identity
       GROUP BY result.tenant_id,
                result.sender_identity,
                result.hl7_message_id,
                analyzer.id,
                analyzer.interface_kind,
                analyzer.status
    ), classified AS (
      SELECT message_group.*,
             ARRAY_REMOVE(ARRAY[
               CASE WHEN message_group.result_count <> message_group.segment_count
                 THEN 'duplicate_segment_identity' END,
               CASE WHEN message_group.analyzer_id IS NULL
                 THEN 'no_exact_analyzer_code' END,
               CASE WHEN message_group.analyzer_id IS NOT NULL
                          AND message_group.interface_kind <> 'hl7'
                 THEN 'exact_analyzer_is_not_hl7' END,
               CASE WHEN message_group.analyzer_id IS NOT NULL
                          AND message_group.interface_kind = 'hl7'
                          AND message_group.status <> 'active'
                 THEN 'exact_hl7_analyzer_is_not_active' END,
               CASE WHEN NOT message_group.patient_is_coherent
                 THEN 'patient_identity_is_missing_or_mixed' END,
               CASE WHEN NOT message_group.booking_is_coherent
                 THEN 'booking_identity_is_mixed' END,
               CASE WHEN NOT message_group.investigation_is_coherent
                 THEN 'investigation_identity_is_mixed' END,
               CASE WHEN message_group.patient_only_unlinked
                 THEN 'patient_only_unlinked_source' END,
               CASE WHEN NOT message_group.patient_only_unlinked
                 THEN 'legacy_local_order_namespace_and_analyte_contract_unproven' END,
               CASE WHEN NOT message_group.raw_obx_is_present
                 THEN 'raw_obx_is_missing' END,
               CASE WHEN NOT message_group.analyzer_link_is_compatible
                 THEN 'analyzer_link_conflicts_with_sender' END
             ], NULL)::text[] AS blocking_reasons
        FROM message_groups AS message_group
    ), bucketed AS (
      SELECT classified.*,
             CASE
               WHEN CARDINALITY(classified.blocking_reasons) = 0 THEN 'eligible'
               WHEN CARDINALITY(classified.blocking_reasons) = 1
                 AND classified.blocking_reasons
                       @> ARRAY['patient_only_unlinked_source']::text[]
                 THEN 'patient_only_unlinked'
               WHEN CARDINALITY(classified.blocking_reasons) = 1
                 AND classified.blocking_reasons
                       @> ARRAY[
                         'legacy_local_order_namespace_and_analyte_contract_unproven'
                       ]::text[]
                 THEN 'legacy_local_order_contract_unproven'
               ELSE 'other_ineligible'
             END AS adoption_bucket
        FROM classified
    ), ranked AS (
      SELECT bucketed.*,
             bucketed.adoption_bucket = 'eligible' AS structurally_eligible,
             COUNT(*) OVER (
               PARTITION BY bucketed.tenant_id, bucketed.adoption_bucket
             )::bigint AS total_count,
             ROW_NUMBER() OVER (
               PARTITION BY bucketed.tenant_id, bucketed.adoption_bucket
               ORDER BY bucketed.sender_identity, bucketed.hl7_message_id
             ) AS sample_rank
        FROM bucketed
    )
    SELECT ranked.tenant_id,
           ranked.structurally_eligible,
           ranked.adoption_bucket,
           ranked.total_count,
           ranked.sample_rank,
           ranked.sender_identity,
           SUBSTRING(MD5(ranked.hl7_message_id) FROM 1 FOR 12) AS message_id_fingerprint,
           ranked.result_count,
           ranked.segment_count,
           ranked.first_segment_index,
           ranked.last_segment_index,
           ranked.result_evidence_fingerprints,
           ranked.blocking_reasons
      FROM ranked
     WHERE ranked.sample_rank <= $1::int
     ORDER BY ranked.tenant_id, ranked.structurally_eligible, ranked.sample_rank
  `,

  oru_claim_source_readiness: `
    WITH claims AS (
      SELECT claim.*,
             SUBSTRING(
               MD5(claim.tenant_id::text || ':oru_claim:' || claim.id::text)
               FROM 1 FOR 16
             ) AS claim_fingerprint,
             order_identity.orc_placer_order_id,
             order_identity.obr_placer_order_id,
             order_identity.obr_test_identity,
             order_identity.obx_test_codes,
             order_identity.orc_count,
             order_identity.obr_count,
             COALESCE(
               order_identity.orc_placer_order_id,
               order_identity.obr_placer_order_id
             ) AS external_order_identity
        FROM lab_oru_ingest_messages AS claim
        LEFT JOIN LATERAL (
          SELECT COUNT(*) FILTER (
                   WHERE SPLIT_PART(BTRIM(parsed.record), '|', 1) = 'ORC'
                 )::int AS orc_count,
                 COUNT(*) FILTER (
                   WHERE SPLIT_PART(BTRIM(parsed.record), '|', 1) = 'OBR'
                 )::int AS obr_count,
                 MAX(NULLIF(BTRIM(SPLIT_PART(BTRIM(parsed.record), '|', 3)), ''))
                   FILTER (
                     WHERE SPLIT_PART(BTRIM(parsed.record), '|', 1) = 'ORC'
                   ) AS orc_placer_order_id,
                 MAX(NULLIF(BTRIM(SPLIT_PART(BTRIM(parsed.record), '|', 3)), ''))
                   FILTER (
                     WHERE SPLIT_PART(BTRIM(parsed.record), '|', 1) = 'OBR'
                   ) AS obr_placer_order_id,
                 MAX(NULLIF(BTRIM(SPLIT_PART(BTRIM(parsed.record), '|', 5)), ''))
                   FILTER (
                     WHERE SPLIT_PART(BTRIM(parsed.record), '|', 1) = 'OBR'
                   ) AS obr_test_identity,
                 ARRAY_AGG(
                   NULLIF(BTRIM(SPLIT_PART(
                     SPLIT_PART(BTRIM(parsed.record), '|', 4),
                     '^',
                     1
                   )), '')
                   ORDER BY parsed.record_ordinal
                 ) FILTER (
                   WHERE SPLIT_PART(BTRIM(parsed.record), '|', 1) = 'OBX'
                 ) AS obx_test_codes
            FROM REGEXP_SPLIT_TO_TABLE(
                   claim.raw_message,
                   E'\\r\\n|\\r|\\n'
                 ) WITH ORDINALITY AS parsed(record, record_ordinal)
        ) AS order_identity ON TRUE
    ), facts AS (
      SELECT claim.*,
             COALESCE(linked.linked_result_count, 0) AS linked_result_count,
             COALESCE(linked.distinct_segment_count, 0) AS distinct_segment_count,
             COALESCE(linked.claim_identity_mismatch_count, 0)
               AS claim_identity_mismatch_count,
             COALESCE(linked.clinically_unlinked_result_count, 0)
               AS clinically_unlinked_result_count,
             COALESCE(linked.source_group_count, 0) AS source_group_count,
             COALESCE(linked.result_id_set_matches, FALSE) AS result_id_set_matches
        FROM claims AS claim
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::bigint AS linked_result_count,
                 COUNT(DISTINCT result.hl7_segment_index)::bigint
                   AS distinct_segment_count,
                 COUNT(*) FILTER (
                   WHERE result.performed_by_lab IS DISTINCT FROM
                           claim.trusted_sender_identity
                      OR result.hl7_message_id IS DISTINCT FROM
                           claim.message_control_id
                      OR result.analyzer_id IS NULL
                 )::bigint AS claim_identity_mismatch_count,
                 COUNT(*) FILTER (
                   WHERE result.booking_id IS NULL
                     AND result.investigation_id IS NULL
                 )::bigint AS clinically_unlinked_result_count,
                 COUNT(DISTINCT (
                   result.patient_uid,
                   COALESCE(result.booking_id::text, '<null>'),
                   COALESCE(result.investigation_id::text, '<null>')
                 ))::bigint AS source_group_count,
                 COALESCE(
                   ARRAY_AGG(result.id ORDER BY result.id) = (
                     SELECT ARRAY_AGG(claim_result_id ORDER BY claim_result_id)
                       FROM UNNEST(claim.result_ids) AS claim_result_id
                   ),
                   CARDINALITY(claim.result_ids) = 0
                 ) AS result_id_set_matches
            FROM lab_results AS result
           WHERE result.tenant_id = claim.tenant_id
             AND result.oru_ingest_message_id = claim.id
        ) AS linked ON TRUE
    ), classified AS (
      SELECT facts.*,
             CASE
               WHEN facts.external_order_identity IS NULL THEN 'missing'
               WHEN facts.external_order_identity ~*
                      '^[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)(e[+-]?[0-9]+)?$'
                 THEN 'bare_numeric'
               WHEN facts.external_order_identity ~ '^VHINV-[1-9][0-9]*$'
                 THEN CASE
                   WHEN LENGTH(SUBSTRING(facts.external_order_identity FROM 7)) < 10
                     OR (
                       LENGTH(SUBSTRING(facts.external_order_identity FROM 7)) = 10
                       AND SUBSTRING(facts.external_order_identity FROM 7) <=
                             '2147483647'
                     )
                     THEN 'vh_investigation'
                   ELSE 'malformed_or_unsupported_reserved'
                 END
               WHEN facts.external_order_identity ~* '^(VHINV|VHBOOK)'
                 THEN 'malformed_or_unsupported_reserved'
               ELSE 'external_unrecognized'
             END AS order_identity_kind,
             CASE
               WHEN facts.external_order_identity ~ '^VHINV-[1-9][0-9]*$'
                 THEN CASE
                   WHEN LENGTH(SUBSTRING(facts.external_order_identity FROM 7)) < 10
                     OR (
                       LENGTH(SUBSTRING(facts.external_order_identity FROM 7)) = 10
                       AND SUBSTRING(facts.external_order_identity FROM 7) <=
                             '2147483647'
                     )
                     THEN SUBSTRING(facts.external_order_identity FROM 7)::int
                   ELSE NULL
                 END
               ELSE NULL
             END AS local_investigation_id,
             (
               COALESCE(facts.orc_placer_order_id ~*
                 '^[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)(e[+-]?[0-9]+)?$', FALSE)
               OR COALESCE(facts.obr_placer_order_id ~*
                 '^[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)(e[+-]?[0-9]+)?$', FALSE)
             ) AS has_bare_numeric_order_identity,
             (
               COALESCE(
                 facts.orc_placer_order_id ~* '^(VHINV|VHBOOK)'
                 AND NOT (
                   facts.orc_placer_order_id ~ '^VHINV-[1-9][0-9]*$'
                   AND (
                     LENGTH(SUBSTRING(facts.orc_placer_order_id FROM 7)) < 10
                     OR (
                       LENGTH(SUBSTRING(facts.orc_placer_order_id FROM 7)) = 10
                       AND SUBSTRING(facts.orc_placer_order_id FROM 7) <=
                             '2147483647'
                     )
                   )
                 ),
                 FALSE
               )
               OR COALESCE(
                 facts.obr_placer_order_id ~* '^(VHINV|VHBOOK)'
                 AND NOT (
                   facts.obr_placer_order_id ~ '^VHINV-[1-9][0-9]*$'
                   AND (
                     LENGTH(SUBSTRING(facts.obr_placer_order_id FROM 7)) < 10
                     OR (
                       LENGTH(SUBSTRING(facts.obr_placer_order_id FROM 7)) = 10
                       AND SUBSTRING(facts.obr_placer_order_id FROM 7) <=
                             '2147483647'
                     )
                   )
                 ),
                 FALSE
               )
             ) AS has_malformed_reserved_order_identity,
             (
               facts.orc_placer_order_id IS NOT NULL
               AND facts.obr_placer_order_id IS NOT NULL
               AND facts.orc_placer_order_id IS DISTINCT FROM
                     facts.obr_placer_order_id
             ) AS order_identity_disagrees
        FROM facts
    ), source_checked AS (
      SELECT classified.*,
             COALESCE((
               classified.order_identity_kind = 'vh_investigation'
               AND NOT classified.order_identity_disagrees
               AND classified.orc_count <= 1
               AND classified.obr_count = 1
               AND investigation.id IS NOT NULL
               AND patient.uid IS NOT NULL
               AND UPPER(investigation.status) IN (
                     'REQUESTED', 'PENDING', 'SCHEDULED', 'COLLECTED',
                     'IN_PROGRESS'
                   )
               AND NULLIF(BTRIM(investigation.test_code), '') IS NOT NULL
               AND BTRIM(SPLIT_PART(classified.obr_test_identity, '^', 1)) =
                     BTRIM(investigation.test_code)
               AND CARDINALITY(COALESCE(
                     classified.obx_test_codes,
                     '{}'::text[]
                   )) = classified.obx_count
               AND NOT EXISTS (
                 SELECT 1
                   FROM UNNEST(COALESCE(
                          classified.obx_test_codes,
                          '{}'::text[]
                        )) AS obx_code
                  WHERE obx_code IS DISTINCT FROM BTRIM(investigation.test_code)
               )
               AND source_result.result_count = classified.obx_count
               AND source_result.source_link_mismatch_count = 0
               AND source_result.patient_mismatch_count = 0
               AND source_result.analyte_mismatch_count = 0
             ), FALSE) AS namespaced_source_contract_is_exact
        FROM classified
        LEFT JOIN investigations AS investigation
          ON investigation.tenant_id = classified.tenant_id
         AND investigation.id = classified.local_investigation_id
        LEFT JOIN users AS patient
          ON patient.tenant_id = investigation.tenant_id
         AND patient.uid = investigation.patient_uid
         AND patient.role = 'PATIENT'
         AND patient.is_active = TRUE
         AND patient.status = 'active'
         AND patient.is_deleted = FALSE
         AND (
           investigation.patient_id IS NULL
           OR investigation.patient_id = patient.id
         )
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::bigint AS result_count,
                 COUNT(*) FILTER (
                   WHERE result.booking_id IS NOT NULL
                      OR result.investigation_id IS DISTINCT FROM
                           classified.local_investigation_id
                 )::bigint AS source_link_mismatch_count,
                 COUNT(*) FILTER (
                   WHERE result.patient_uid IS DISTINCT FROM investigation.patient_uid
                 )::bigint AS patient_mismatch_count,
                 COUNT(*) FILTER (
                   WHERE result.test_code IS DISTINCT FROM BTRIM(investigation.test_code)
                 )::bigint AS analyte_mismatch_count
            FROM lab_results AS result
           WHERE result.tenant_id = classified.tenant_id
             AND result.oru_ingest_message_id = classified.id
        ) AS source_result ON TRUE
    ), findings AS (
      SELECT facts.tenant_id,
             facts.id,
             facts.claim_fingerprint,
             facts.status,
             facts.obx_count,
             facts.linked_result_count,
             facts.external_order_identity,
             facts.order_identity_kind,
             finding.issue_key,
             finding.blocking_reasons
        FROM source_checked AS facts
        CROSS JOIN LATERAL (
          VALUES
            (
              'oru_nonterminal_claims_at_maintenance_snapshot'::text,
              facts.status IS DISTINCT FROM 'completed',
              ARRAY['old_writers_not_fully_drained_or_claim_not_terminal']::text[]
            ),
            (
              'oru_completed_claim_integrity_violations'::text,
              facts.status = 'completed' AND (
                facts.completed_at IS NULL
                OR facts.linked_result_count IS DISTINCT FROM facts.obx_count
                OR facts.distinct_segment_count IS DISTINCT FROM facts.obx_count
                OR facts.claim_identity_mismatch_count <> 0
                OR facts.source_group_count <> 1
                OR NOT facts.result_id_set_matches
              ),
              ARRAY['completed_claim_does_not_exactly_own_its_obx_result_set']::text[]
            ),
            (
              'oru_orderless_completed_claims'::text,
              facts.status = 'completed'
                AND facts.clinically_unlinked_result_count > 0,
              ARRAY[
                'completed_claim_has_booking_and_investigation_both_null',
                'future_owner_governed_external_order_reconciliation_is_required'
              ]::text[]
            ),
            (
              'oru_bare_numeric_order_identity_claims'::text,
               facts.has_bare_numeric_order_identity,
              ARRAY[
                'bare_numeric_order_identity_has_no_attested_local_namespace',
                'never_infer_a_local_table_from_a_numeric_identifier'
              ]::text[]
            ),
            (
              'oru_malformed_reserved_order_identity_claims'::text,
               facts.has_malformed_reserved_order_identity,
              ARRAY[
                'reserved_order_namespace_is_malformed_or_unsupported',
                'only_canonical_vhinv_positive_int4_is_supported'
              ]::text[]
            ),
            (
              'oru_order_identity_disagreement_claims'::text,
              facts.order_identity_disagrees,
              ARRAY['orc_2_and_obr_2_order_identities_disagree']::text[]
            ),
            (
              'oru_namespaced_source_contract_violations'::text,
              facts.order_identity_kind = 'vh_investigation'
                AND NOT facts.namespaced_source_contract_is_exact,
              ARRAY[
                'vhinv_source_or_structured_order_analyte_contract_is_not_exact',
                'obr_4_and_every_obx_3_must_match_the_owned_investigation_test_code'
              ]::text[]
            ),
            (
              'oru_unattested_external_or_missing_local_links'::text,
              facts.order_identity_kind IN ('missing', 'external_unrecognized')
                AND facts.linked_result_count >
                      facts.clinically_unlinked_result_count,
              ARRAY[
                'external_or_missing_order_identity_was_claimed_as_a_local_link',
                'governed_external_order_mapping_is_not_implemented'
              ]::text[]
            )
        ) AS finding(issue_key, included, blocking_reasons)
       WHERE finding.included
    ), ranked AS (
      SELECT finding.*,
             COUNT(*) OVER (
               PARTITION BY finding.tenant_id, finding.issue_key
             )::bigint AS total_count,
             ROW_NUMBER() OVER (
               PARTITION BY finding.tenant_id, finding.issue_key
               ORDER BY finding.id
             ) AS sample_rank
        FROM findings AS finding
    )
    SELECT ranked.tenant_id,
           ranked.issue_key,
           ranked.total_count,
           ranked.sample_rank,
           ranked.claim_fingerprint,
           ranked.status,
           ranked.obx_count,
           ranked.linked_result_count,
           ranked.order_identity_kind AS external_order_identity_kind,
           CASE
             WHEN ranked.external_order_identity IS NULL THEN NULL
             ELSE SUBSTRING(
               MD5(
                 ranked.tenant_id::text
                 || ':external_order:'
                 || ranked.external_order_identity
               )
               FROM 1 FOR 16
             )
           END AS external_order_identity_fingerprint,
           ranked.blocking_reasons
      FROM ranked
     WHERE ranked.sample_rank <= $1::int
     ORDER BY ranked.tenant_id, ranked.issue_key, ranked.sample_rank
  `,

  astm_duplicate_fingerprints: `
    WITH fingerprinted AS (
      SELECT message.id,
             message.tenant_id,
             COALESCE(
               message.analyzer_id::text,
               'legacy:' || LOWER(NULLIF(BTRIM(message.analyzer_code), '')),
               '<legacy-unresolved>'
             ) AS analyzer_channel,
             message.protocol,
             ENCODE(
               DIGEST(
                 COALESCE((
                   SELECT STRING_AGG(
                            BTRIM(parsed.record),
                            CHR(13)
                            ORDER BY parsed.record_ordinal
                          )
                     FROM REGEXP_SPLIT_TO_TABLE(
                            message.raw_message,
                            E'\\r\\n|\\r|\\n'
                          ) WITH ORDINALITY
                          AS parsed(record, record_ordinal)
                    WHERE BTRIM(parsed.record) <> ''
                 ), ''),
                 'sha256'
               ),
               'hex'
             ) AS message_fingerprint
        FROM lab_interface_messages AS message
       WHERE message.direction = 'inbound'
         AND message.protocol = 'astm_e1394'
    ), duplicate_groups AS (
      SELECT receipt.tenant_id,
             receipt.analyzer_channel,
             receipt.protocol,
             receipt.message_fingerprint,
             COUNT(*)::bigint AS row_count,
             (ARRAY_AGG(
               SUBSTRING(
                 MD5(receipt.tenant_id::text || ':astm_receipt:' || receipt.id::text)
                 FROM 1 FOR 16
               )
               ORDER BY receipt.id
             ))[1:$1::int] AS receipt_evidence_fingerprints
        FROM fingerprinted AS receipt
       GROUP BY receipt.tenant_id,
                receipt.analyzer_channel,
                receipt.protocol,
                receipt.message_fingerprint
      HAVING COUNT(*) > 1
    ), ranked AS (
      SELECT duplicate_group.*,
             COUNT(*) OVER (
               PARTITION BY duplicate_group.tenant_id
             )::bigint AS total_count,
             ROW_NUMBER() OVER (
               PARTITION BY duplicate_group.tenant_id
               ORDER BY duplicate_group.analyzer_channel,
                        duplicate_group.message_fingerprint
             ) AS sample_rank
        FROM duplicate_groups AS duplicate_group
    )
    SELECT ranked.tenant_id,
           'astm_duplicate_receipt_groups'::text AS issue_key,
           ranked.total_count,
           ranked.sample_rank,
           SUBSTRING(
             MD5(ranked.tenant_id::text || ':astm_channel:' || ranked.analyzer_channel)
             FROM 1 FOR 16
           ) AS analyzer_channel_fingerprint,
           ranked.protocol,
           SUBSTRING(ranked.message_fingerprint FROM 1 FOR 16)
             AS canonical_message_fingerprint,
           ranked.row_count,
           ranked.receipt_evidence_fingerprints
      FROM ranked
     WHERE ranked.sample_rank <= $1::int
     ORDER BY ranked.tenant_id, ranked.sample_rank
  `,

  astm_legacy_receipt_readiness: `
    WITH inbound AS (
      SELECT message.*,
             SUBSTRING(
               MD5(message.tenant_id::text || ':astm_receipt:' || message.id::text)
               FROM 1 FOR 16
             ) AS receipt_fingerprint
        FROM lab_interface_messages AS message
       WHERE message.direction = 'inbound'
         AND message.protocol = 'astm_e1394'
    ), facts AS (
      SELECT message.*,
             specimen.id IS NOT NULL AS specimen_exists,
             specimen.booking_id AS specimen_booking_id,
             COALESCE(result_candidates.potential_result_count, 0)
               AS potential_result_count,
             COALESCE(result_candidates.potential_critical_result_count, 0)
               AS potential_critical_result_count,
             (
               message.status = 'ingested'
               AND message.analyzer_id IS NOT NULL
               AND message.result_count = 1
               AND message.specimen_id IS NOT NULL
               AND message.processed_at IS NOT NULL
               AND message.error IS NULL
               AND CASE
                     WHEN JSONB_TYPEOF(message.verdicts) = 'array'
                       THEN JSONB_ARRAY_LENGTH(message.verdicts) = message.result_count
                     ELSE FALSE
                   END
               AND specimen.id IS NOT NULL
             ) AS clone_rehearsal_candidate
        FROM inbound AS message
        LEFT JOIN lab_specimens AS specimen
          ON specimen.tenant_id = message.tenant_id
         AND specimen.id = message.specimen_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::bigint AS potential_result_count,
                 COUNT(*) FILTER (
                   WHERE result.is_critical = TRUE
                 )::bigint AS potential_critical_result_count
            FROM lab_results AS result
           WHERE result.tenant_id = message.tenant_id
             AND result.specimen_id = message.specimen_id
             AND result.analyzer_id = message.analyzer_id
             AND message.processed_at IS NOT NULL
             AND result.received_at >= message.created_at
             AND result.received_at <= message.processed_at
        ) AS result_candidates ON TRUE
    ), findings AS (
      SELECT facts.tenant_id,
             facts.id,
             facts.receipt_fingerprint,
             facts.status,
             facts.result_count,
             facts.potential_result_count,
             facts.potential_critical_result_count,
             finding.issue_key,
             finding.blocking_reasons
        FROM facts
        CROSS JOIN LATERAL (
          VALUES
            (
              'astm_legacy_nonterminal_receipts'::text,
              facts.status IS DISTINCT FROM 'ingested',
              ARRAY['pre_583_receipt_is_not_ingested']::text[]
            ),
            (
              'astm_legacy_analyzer_unresolved_receipts'::text,
              facts.analyzer_id IS NULL,
              ARRAY['analyzer_id_is_null']::text[]
            ),
            (
              'astm_legacy_adoption_ineligible_receipts'::text,
              facts.status = 'ingested'
                AND (
                  facts.result_count IS NULL
                  OR facts.result_count <= 0
                  OR facts.result_count <> 1
                  OR facts.specimen_id IS NULL
                  OR facts.processed_at IS NULL
                  OR facts.error IS NOT NULL
                  OR JSONB_TYPEOF(facts.verdicts) IS DISTINCT FROM 'array'
                  OR CASE
                       WHEN JSONB_TYPEOF(facts.verdicts) = 'array'
                         THEN JSONB_ARRAY_LENGTH(facts.verdicts)
                                IS DISTINCT FROM facts.result_count
                       ELSE TRUE
                     END
                  OR NOT facts.specimen_exists
                ),
              ARRAY_REMOVE(ARRAY[
                CASE WHEN facts.result_count IS NULL OR facts.result_count <= 0
                  THEN 'invalid_declared_result_count' END,
                CASE WHEN facts.result_count IS NOT NULL AND facts.result_count <> 1
                  THEN 'legacy_auto_adoption_requires_exactly_one_result' END,
                CASE WHEN facts.specimen_id IS NULL
                  THEN 'specimen_id_is_null' END,
                CASE WHEN facts.specimen_id IS NOT NULL AND NOT facts.specimen_exists
                  THEN 'referenced_specimen_is_missing' END,
                CASE WHEN facts.processed_at IS NULL
                  THEN 'processed_at_is_null' END,
                CASE WHEN facts.error IS NOT NULL
                  THEN 'ingested_receipt_has_error' END,
                CASE WHEN JSONB_TYPEOF(facts.verdicts) IS DISTINCT FROM 'array'
                  THEN 'verdicts_are_not_an_array' END,
                CASE
                  WHEN JSONB_TYPEOF(facts.verdicts) = 'array'
                    AND JSONB_ARRAY_LENGTH(facts.verdicts)
                          IS DISTINCT FROM facts.result_count
                    THEN 'verdict_cardinality_mismatch'
                END
              ], NULL)::text[]
            ),
            (
              'astm_orderless_clinically_unlinked_receipts'::text,
              facts.specimen_exists AND facts.specimen_booking_id IS NULL,
              ARRAY['specimen_has_no_local_booking_or_investigation_source']::text[]
            ),
            (
              'astm_no_potential_result_candidates'::text,
              facts.clone_rehearsal_candidate
                AND facts.potential_result_count = 0,
              ARRAY['no_unlinked_result_exists_in_the_receipt_specimen_analyzer_window']::text[]
            ),
            (
              'astm_legacy_adoption_clone_rehearsal_candidates'::text,
              facts.clone_rehearsal_candidate,
              ARRAY['exact_adoption_predicates_require_fresh_production_clone']::text[]
            ),
            (
              'astm_critical_rail_clone_rehearsal_candidates'::text,
              facts.clone_rehearsal_candidate,
              CASE
                WHEN facts.potential_critical_result_count > 0
                  THEN ARRAY[
                    'potential_critical_result_detected',
                    'exact_alert_task_sla_or_closed_ack_proof_requires_clone'
                  ]::text[]
                ELSE ARRAY[
                  'criticality_cannot_be_cleared_without_exact_result_adoption',
                  'exact_alert_task_sla_or_closed_ack_proof_requires_clone'
                ]::text[]
              END
            )
        ) AS finding(issue_key, included, blocking_reasons)
       WHERE finding.included
    ), ranked AS (
      SELECT finding.*,
             COUNT(*) OVER (
               PARTITION BY finding.tenant_id, finding.issue_key
             )::bigint AS total_count,
             ROW_NUMBER() OVER (
               PARTITION BY finding.tenant_id, finding.issue_key
               ORDER BY finding.id
             ) AS sample_rank
        FROM findings AS finding
    )
    SELECT ranked.tenant_id,
           ranked.issue_key,
           ranked.total_count,
           ranked.sample_rank,
           ranked.receipt_fingerprint,
           ranked.status,
           ranked.result_count,
           ranked.potential_result_count,
           ranked.potential_critical_result_count,
           ranked.blocking_reasons
      FROM ranked
     WHERE ranked.sample_rank <= $1::int
     ORDER BY ranked.tenant_id, ranked.issue_key, ranked.sample_rank
  `,

  astm_atomic_contract_readiness: `
    WITH inbound AS (
      SELECT message.*,
             SUBSTRING(
               MD5(message.tenant_id::text || ':astm_receipt:' || message.id::text)
               FROM 1 FOR 16
             ) AS receipt_fingerprint,
             ENCODE(DIGEST(message.raw_message, 'sha256'), 'hex')
               AS recomputed_raw_message_sha256,
             ENCODE(
               DIGEST(
                 COALESCE((
                   SELECT STRING_AGG(
                            BTRIM(parsed.record),
                            CHR(13)
                            ORDER BY parsed.record_ordinal
                          )
                     FROM REGEXP_SPLIT_TO_TABLE(
                            message.raw_message,
                            E'\\r\\n|\\r|\\n'
                          ) WITH ORDINALITY
                          AS parsed(record, record_ordinal)
                    WHERE BTRIM(parsed.record) <> ''
                 ), ''),
                 'sha256'
               ),
               'hex'
             ) AS recomputed_astm_message_sha256
        FROM lab_interface_messages AS message
       WHERE message.direction = 'inbound'
         AND message.protocol = 'astm_e1394'
    ), facts AS (
      SELECT message.*,
             specimen.id IS NOT NULL AS specimen_exists,
             specimen.booking_id AS specimen_booking_id,
             COALESCE(linked.linked_result_count, 0) AS linked_result_count,
             COALESCE(linked.linked_result_position_count, 0)
               AS linked_result_position_count,
             linked.first_result_position,
             linked.last_result_position,
             COALESCE(linked.source_mismatch_count, 0) AS source_mismatch_count,
             COALESCE(linked.clinically_unlinked_result_count, 0)
               AS clinically_unlinked_result_count,
             COALESCE(linked.critical_result_count, 0) AS critical_result_count,
             COALESCE(linked.critical_core_rail_drift_count, 0)
               AS critical_core_rail_drift_count,
             COALESCE(linked.generic_task_ack_alert_open_split_count, 0)
               AS generic_task_ack_alert_open_split_count
        FROM inbound AS message
        LEFT JOIN lab_specimens AS specimen
          ON specimen.tenant_id = message.tenant_id
         AND specimen.id = message.specimen_id
        LEFT JOIN investigation_bookings AS booking
          ON booking.tenant_id = specimen.tenant_id
         AND booking.id = specimen.booking_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::bigint AS linked_result_count,
                 COUNT(DISTINCT result.interface_result_index)::bigint
                   AS linked_result_position_count,
                 MIN(result.interface_result_index)::int AS first_result_position,
                 MAX(result.interface_result_index)::int AS last_result_position,
                 COUNT(*) FILTER (
                   WHERE result.specimen_id IS DISTINCT FROM message.specimen_id
                      OR result.patient_uid IS DISTINCT FROM specimen.patient_uid
                      OR result.booking_id IS DISTINCT FROM specimen.booking_id
                      OR result.investigation_id IS DISTINCT FROM booking.investigation_id
                      OR result.analyzer_id IS DISTINCT FROM message.analyzer_id
                 )::bigint AS source_mismatch_count,
                 COUNT(*) FILTER (
                   WHERE result.booking_id IS NULL
                     AND result.investigation_id IS NULL
                 )::bigint AS clinically_unlinked_result_count,
                 COUNT(*) FILTER (
                   WHERE result.is_critical = TRUE
                 )::bigint AS critical_result_count,
                 COUNT(*) FILTER (
                   WHERE result.is_critical = TRUE
                     AND (
                       COALESCE(rail.current_generation_count, 0) <> 1
                       OR COALESCE(rail.valid_current_rail_count, 0) <> 1
                     )
                 )::bigint AS critical_core_rail_drift_count,
                 COUNT(*) FILTER (
                   WHERE result.is_critical = TRUE
                     AND COALESCE(rail.generic_ack_split_count, 0) > 0
                 )::bigint AS generic_task_ack_alert_open_split_count
            FROM lab_results AS result
            LEFT JOIN LATERAL (
              WITH RECURSIVE generation_chain AS (
                SELECT alert.*,
                       ARRAY[alert.id]::integer[] AS traversal_path
                  FROM lab_critical_alerts AS alert
                 WHERE alert.tenant_id = result.tenant_id
                   AND alert.result_id = result.id
                   AND alert.patient_uid = result.patient_uid
                   AND alert.generation_signoff_id IS NULL
                   AND alert.generation_metadata->>'kind' =
                         'initial_result_generation'
                   AND alert.generation_metadata->>'acknowledgement_task_id' =
                         alert.acknowledgement_task_id::text
                   AND alert.generation_metadata->>'corrected_state' = 'critical'
                   AND alert.value_numeric IS NOT DISTINCT FROM result.value_numeric
                   AND alert.unit IS NOT DISTINCT FROM result.unit
                   AND alert.threshold_breached =
                         message.verdicts
                           -> (result.interface_result_index - 1)
                           -> 'threshold_assessment'
                           ->> 'breached_side'
                   AND TO_JSONB(alert.threshold_value) =
                         message.verdicts
                           -> (result.interface_result_index - 1)
                           -> 'threshold_assessment'
                           -> 'breached_value'
                   AND alert.generation_metadata->'active_threshold_id'
                         IS NOT DISTINCT FROM
                           message.verdicts
                             -> (result.interface_result_index - 1)
                             -> 'threshold_assessment'
                             -> 'threshold_id'
                   AND alert.generation_metadata->'active_threshold_low'
                         IS NOT DISTINCT FROM
                           message.verdicts
                             -> (result.interface_result_index - 1)
                             -> 'threshold_assessment'
                             -> 'critical_low'
                   AND alert.generation_metadata->'active_threshold_high'
                         IS NOT DISTINCT FROM
                           message.verdicts
                             -> (result.interface_result_index - 1)
                             -> 'threshold_assessment'
                             -> 'critical_high'
                   AND alert.generation_metadata->'threshold_evaluated_value'
                         IS NOT DISTINCT FROM
                           message.verdicts
                             -> (result.interface_result_index - 1)
                             -> 'threshold_assessment'
                             -> 'evaluated_value'
                   AND alert.generation_metadata->'threshold_value_conversion'
                         IS NOT DISTINCT FROM
                           message.verdicts
                             -> (result.interface_result_index - 1)
                             -> 'threshold_assessment'
                             -> 'conversion'
                   AND alert.fired_at >= result.received_at

                UNION ALL

                SELECT successor.*,
                       generation_chain.traversal_path || successor.id
                  FROM generation_chain
                  JOIN lab_critical_alerts AS successor
                    ON successor.tenant_id = generation_chain.tenant_id
                   AND successor.id = generation_chain.superseded_by_alert_id
                   AND successor.result_id = generation_chain.result_id
                   AND successor.patient_uid = generation_chain.patient_uid
                   AND successor.generation_signoff_id =
                         generation_chain.superseded_by_signoff_id
                  JOIN lab_pathologist_signoffs AS signoff
                    ON signoff.tenant_id = successor.tenant_id
                   AND signoff.id = successor.generation_signoff_id
                 WHERE generation_chain.superseded_at IS NOT NULL
                   AND generation_chain.superseded_by_alert_id IS NOT NULL
                   AND generation_chain.superseded_by_signoff_id IS NOT NULL
                   AND successor.fired_at > generation_chain.fired_at
                   AND successor.fired_at <= generation_chain.superseded_at
                   AND successor.generation_metadata->>'kind' =
                         'corrected_result_generation'
                   AND successor.generation_metadata->>'signoff_id' =
                         signoff.id::text
                   AND successor.generation_metadata->>'supersedes_alert_id' =
                         generation_chain.id::text
                   AND successor.generation_metadata->>'acknowledgement_task_id' =
                         successor.acknowledgement_task_id::text
                   AND successor.generation_metadata->>'corrected_state' IN (
                         'critical', 'within_active_critical_thresholds',
                         'threshold_unavailable', 'legacy_unclassified'
                       )
                   AND signoff.patient_uid = generation_chain.patient_uid
                   AND generation_chain.result_id = ANY(signoff.result_ids)
                   AND signoff.decision IN ('corrected', 'amended')
                   AND signoff.signed_at >= generation_chain.fired_at
                   AND signoff.signed_at <= successor.fired_at
                   AND NOT successor.id = ANY(generation_chain.traversal_path)
              ), current_generations AS (
                SELECT generation.*
                  FROM generation_chain AS generation
                 WHERE generation.superseded_at IS NULL
                   AND generation.superseded_by_alert_id IS NULL
                   AND generation.superseded_by_signoff_id IS NULL
              ), rail_state AS (
                SELECT current_alert.id,
                       (
                         SELECT COUNT(*)
                           FROM tasks AS task
                           JOIN workflow_sla_instances AS sla
                             ON sla.tenant_id = task.tenant_id
                            AND sla.id = task.workflow_sla_instance_id
                          WHERE task.tenant_id = current_alert.tenant_id
                            AND task.id = current_alert.acknowledgement_task_id
                            AND task.patient_uid = current_alert.patient_uid
                            AND task.related_resource_type = 'lab_result'
                            AND task.related_resource_id =
                                  current_alert.result_id::text
                            AND task.sla_completion_semantics = 'acknowledgement'
                            AND task.metadata->>'lab_critical_alert_id' =
                                  current_alert.id::text
                            AND task.metadata->>'lab_alert_generation_signoff_id'
                                  IS NOT DISTINCT FROM
                                    current_alert.generation_signoff_id::text
                            AND task.metadata->>'lab_alert_generation_state' =
                                  current_alert.generation_metadata
                                    ->>'corrected_state'
                            AND sla.rule_code = 'critical_result_ack'
                            AND sla.source_table = 'lab_result'
                            AND sla.source_id = current_alert.result_id::text
                            AND sla.patient_uid = current_alert.patient_uid
                            AND (
                              (
                                current_alert.acknowledged_at IS NULL
                                AND current_alert.acknowledged_by IS NULL
                                AND task.status IN ('open', 'blocked', 'overdue')
                                AND task.metadata->>'acknowledged_at' IS NULL
                                AND task.metadata->>'acknowledged_by' IS NULL
                                AND sla.status IN (
                                      'active', 'breached', 'escalated'
                                    )
                                AND sla.completed_at IS NULL
                              ) OR (
                                current_alert.acknowledged_at IS NOT NULL
                                AND current_alert.acknowledged_by IS NOT NULL
                                AND current_alert.acknowledged_at >=
                                      current_alert.fired_at
                                AND task.status IN ('in_progress', 'completed')
                                AND LOWER(task.metadata->>'acknowledged_by') =
                                      LOWER(current_alert.acknowledged_by::text)
                                AND task.metadata->>'acknowledged_via' IN (
                                      'assignee', 'role', 'admin', 'override'
                                    )
                                AND task.metadata->>'acknowledged_at' ~
                                      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
                                AND PG_INPUT_IS_VALID(
                                      task.metadata->>'acknowledged_at',
                                      'timestamp with time zone'
                                    )
                                AND (
                                      task.metadata->>'acknowledged_at'
                                    )::timestamptz = current_alert.acknowledged_at
                                AND sla.status IN (
                                      'completed', 'breached', 'escalated'
                                    )
                                AND sla.completed_at =
                                      current_alert.acknowledged_at
                                AND sla.metadata->>'completed_via' = 'task_ack'
                                AND sla.metadata->>'completed_by_task' =
                                      task.id::text
                                AND LOWER(sla.metadata->>'completed_by') =
                                      LOWER(current_alert.acknowledged_by::text)
                                AND 1 = (
                                  SELECT COUNT(*)
                                    FROM task_comments AS receipt
                                   WHERE receipt.tenant_id = task.tenant_id
                                     AND receipt.task_id = task.id
                                     AND receipt.author_uid =
                                           current_alert.acknowledged_by
                                     AND receipt.body_kind = 'state_change'
                                     AND receipt.metadata->>'to' = 'in_progress'
                                     AND receipt.metadata->>'acknowledged_at' =
                                           task.metadata->>'acknowledged_at'
                                     AND receipt.metadata->>'via' =
                                           task.metadata->>'acknowledged_via'
                                     AND receipt.created_at >= message.created_at
                                )
                                AND 1 = (
                                  SELECT COUNT(*)
                                    FROM clinical_timeline_events AS timeline
                                   WHERE timeline.tenant_id =
                                           current_alert.tenant_id
                                     AND timeline.patient_uid =
                                           current_alert.patient_uid
                                     AND timeline.event_type =
                                           'critical_result.acknowledged'
                                     AND timeline.event_status = 'acknowledged'
                                     AND timeline.source_table =
                                           'lab_critical_alerts'
                                     AND timeline.source_id =
                                           current_alert.id::text
                                     AND timeline.resource_type =
                                           'critical_lab_alert'
                                     AND timeline.resource_id =
                                           current_alert.id::text
                                     AND timeline.actor_uid =
                                           current_alert.acknowledged_by
                                     AND timeline.payload->'alert_id' =
                                           TO_JSONB(current_alert.id)
                                     AND timeline.payload->'result_id' =
                                           TO_JSONB(current_alert.result_id)
                                     AND timeline.payload
                                           ->>'acknowledgement_authorization' =
                                           task.metadata->>'acknowledged_via'
                                     AND timeline.payload ? 'read_back_method'
                                     AND timeline.payload->>'read_back_method'
                                           IS NOT DISTINCT FROM
                                           current_alert.read_back_method
                                     AND timeline.idempotency_key =
                                           'lab_critical_alerts:'
                                             || current_alert.id
                                             || ':acknowledged'
                                     AND timeline.occurred_at >= message.created_at
                                )
                                AND 1 = (
                                  SELECT COUNT(*)
                                    FROM clinical_audit_events AS audit
                                   WHERE audit.tenant_id =
                                           current_alert.tenant_id
                                     AND audit.patient_uid =
                                           current_alert.patient_uid
                                     AND audit.action =
                                           'critical_result.acknowledged'
                                     AND audit.action_status = 'success'
                                     AND audit.resource_table =
                                           'lab_critical_alerts'
                                     AND audit.resource_id =
                                           current_alert.id::text
                                     AND audit.resource_type =
                                           'critical_lab_alert'
                                     AND audit.actor_uid =
                                           current_alert.acknowledged_by
                                     AND audit.idempotency_key =
                                           'lab_critical_alerts:'
                                             || current_alert.id
                                             || ':audit:acknowledged'
                                     AND audit.occurred_at >= message.created_at
                                )
                              )
                            )
                       )::bigint AS exact_rail_count,
                       EXISTS (
                         SELECT 1
                           FROM tasks AS split_task
                           LEFT JOIN workflow_sla_instances AS split_sla
                             ON split_sla.tenant_id = split_task.tenant_id
                            AND split_sla.id =
                                  split_task.workflow_sla_instance_id
                          WHERE current_alert.acknowledged_at IS NULL
                            AND current_alert.acknowledged_by IS NULL
                            AND split_task.tenant_id = current_alert.tenant_id
                            AND split_task.id =
                                  current_alert.acknowledgement_task_id
                            AND (
                              split_task.status IN ('in_progress', 'completed')
                              OR split_task.metadata->>'acknowledged_at' IS NOT NULL
                              OR split_task.metadata->>'acknowledged_by' IS NOT NULL
                              OR split_sla.completed_at IS NOT NULL
                            )
                       ) AS generic_task_ack_alert_open_split
                  FROM current_generations AS current_alert
              )
              SELECT COUNT(*)::bigint AS current_generation_count,
                     COUNT(*) FILTER (
                       WHERE rail_state.exact_rail_count = 1
                         AND NOT rail_state.generic_task_ack_alert_open_split
                     )::bigint AS valid_current_rail_count,
                     COUNT(*) FILTER (
                       WHERE rail_state.generic_task_ack_alert_open_split
                     )::bigint AS generic_ack_split_count
                FROM rail_state
            ) AS rail ON TRUE
           WHERE result.tenant_id = message.tenant_id
             AND result.interface_message_id = message.id
        ) AS linked ON TRUE
    ), findings AS (
      SELECT facts.tenant_id,
             facts.id,
             facts.receipt_fingerprint,
             facts.status,
             facts.result_count,
             facts.linked_result_count,
             facts.critical_result_count,
             finding.issue_key,
             finding.blocking_reasons
        FROM facts
        CROSS JOIN LATERAL (
          VALUES
            (
              'astm_atomic_contract_violations'::text,
              (
                facts.analyzer_id IS NOT NULL
                AND NULLIF(BTRIM(facts.analyzer_code), '') IS NOT NULL
                AND facts.ingest_contract_version = 1
                AND facts.authenticated_actor_uid IS NOT NULL
                AND CARDINALITY(facts.authenticated_actor_roles) = 1
                AND facts.authenticated_actor_roles <@ ARRAY[
                      'LAB_STAFF', 'LAB_INCHARGE', 'PATHOLOGIST', 'ADMIN',
                      'SUPER_ADMIN', 'WEBHOOK_CLIENT', 'DEVICE_GATEWAY'
                    ]::text[]
                AND facts.analyzer_binding_mode IN (
                      'api_client', 'manual_import_actor'
                    )
                AND NULLIF(BTRIM(facts.analyzer_binding_identity), '') IS NOT NULL
                AND NULLIF(BTRIM(facts.analyzer_sender_identity), '') IS NOT NULL
                AND facts.status <> 'parsed'
              ) IS NOT TRUE,
              ARRAY['atomic_identity_check_is_not_true']::text[]
            ),
            (
              'astm_nonterminal_contract_receipts'::text,
              facts.status IS DISTINCT FROM 'failed'
                AND facts.status IS DISTINCT FROM 'ingested',
              ARRAY['maintenance_snapshot_contains_nonterminal_astm_receipt']::text[]
            ),
            (
              'astm_failed_receipt_contract_violations'::text,
              facts.status = 'failed' AND (
                facts.error IS NULL
                OR facts.processed_at IS NULL
                OR facts.result_count IS NOT NULL
                OR facts.specimen_id IS NOT NULL
                OR facts.verdicts IS NOT NULL
                OR facts.linked_result_count <> 0
              ),
              ARRAY['failed_receipt_carries_partial_or_incomplete_evidence']::text[]
            ),
            (
              'astm_ingested_durable_evidence_violations'::text,
              facts.status = 'ingested' AND (
                facts.result_count IS NULL
                OR facts.result_count <= 0
                OR facts.specimen_id IS NULL
                OR facts.processed_at IS NULL
                OR facts.error IS NOT NULL
                OR JSONB_TYPEOF(facts.verdicts) IS DISTINCT FROM 'array'
                OR CASE
                     WHEN JSONB_TYPEOF(facts.verdicts) = 'array'
                       THEN JSONB_ARRAY_LENGTH(facts.verdicts)
                              IS DISTINCT FROM facts.result_count
                     ELSE TRUE
                   END
                OR facts.linked_result_count IS DISTINCT FROM facts.result_count
                OR facts.linked_result_position_count
                     IS DISTINCT FROM facts.result_count
                OR facts.first_result_position IS DISTINCT FROM 1
                OR facts.last_result_position IS DISTINCT FROM facts.result_count
                OR facts.source_mismatch_count <> 0
              ),
              ARRAY['ingested_receipt_lacks_exact_terminal_or_linked_result_evidence']::text[]
            ),
            (
              'astm_message_fingerprint_drift'::text,
              facts.raw_message_sha256 IS DISTINCT FROM
                facts.recomputed_raw_message_sha256
                OR facts.astm_message_sha256 IS DISTINCT FROM
                   facts.recomputed_astm_message_sha256,
              ARRAY['stored_message_fingerprint_differs_from_recomputation']::text[]
            ),
            (
              'astm_orderless_clinically_unlinked_receipts'::text,
              facts.status = 'ingested' AND (
                facts.specimen_booking_id IS NULL
                OR facts.clinically_unlinked_result_count > 0
              ),
              ARRAY['receipt_or_result_has_no_local_booking_or_investigation_source']::text[]
            ),
            (
              'astm_critical_rail_core_drift'::text,
              facts.critical_core_rail_drift_count > 0,
              ARRAY[
                'critical_result_does_not_have_exactly_one_core_alert_task_sla_or_closed_ack_rail',
                'migration_commit_is_the_exact_full_metadata_proof'
              ]::text[]
            ),
            (
              'astm_generic_task_ack_alert_open_splits'::text,
              facts.generic_task_ack_alert_open_split_count > 0,
              ARRAY[
                'task_or_sla_ack_state_exists_while_current_alert_remains_open',
                'only_authoritative_alert_ack_with_canonical_receipts_can_close_the_rail'
              ]::text[]
            )
        ) AS finding(issue_key, included, blocking_reasons)
       WHERE finding.included
    ), ranked AS (
      SELECT finding.*,
             COUNT(*) OVER (
               PARTITION BY finding.tenant_id, finding.issue_key
             )::bigint AS total_count,
             ROW_NUMBER() OVER (
               PARTITION BY finding.tenant_id, finding.issue_key
               ORDER BY finding.id
             ) AS sample_rank
        FROM findings AS finding
    )
    SELECT ranked.tenant_id,
           ranked.issue_key,
           ranked.total_count,
           ranked.sample_rank,
           ranked.receipt_fingerprint,
           ranked.status,
           ranked.result_count,
           ranked.linked_result_count,
           ranked.critical_result_count,
           ranked.blocking_reasons
      FROM ranked
     WHERE ranked.sample_rank <= $1::int
     ORDER BY ranked.tenant_id, ranked.issue_key, ranked.sample_rank
  `,
  care_pathway_governance_pinning_readiness: `
    WITH governance_facts AS (
      SELECT governance.tenant_id,
             governance.id,
             governance.governance_status,
             governance.definition_checksum,
             governance.approved_at,
             governance.retired_by,
             governance.retired_at,
             governance.retirement_reason,
             governance.effective_until,
             governance.clinical_owner_uid,
             governance.operational_owner_uid,
             definition.is_active AS definition_is_active,
             approval.id AS approval_id,
             approval.metadata AS approval_metadata,
             clinical_owner.role AS clinical_owner_role,
             clinical_owner.is_active AS clinical_owner_is_active,
             operational_owner.role AS operational_owner_role,
             operational_owner.is_active AS operational_owner_is_active,
             ENCODE(DIGEST(CONCAT_WS(
               '|',
               'care-pathway-governance-584',
               governance.tenant_id::text,
               governance.id::text
             ), 'sha256'), 'hex') AS pin_fingerprint
        FROM care_pathway_definition_governance AS governance
        JOIN workflow_definitions AS definition
          ON definition.tenant_id = governance.tenant_id
         AND definition.id = governance.workflow_definition_id
        LEFT JOIN approvals AS approval
          ON approval.tenant_id = governance.tenant_id
         AND approval.id = governance.approval_id
        LEFT JOIN users AS clinical_owner
          ON clinical_owner.tenant_id = governance.tenant_id
         AND clinical_owner.uid = governance.clinical_owner_uid
        LEFT JOIN users AS operational_owner
          ON operational_owner.tenant_id = governance.tenant_id
         AND operational_owner.uid = governance.operational_owner_uid
       WHERE governance.governance_status IN ('approved', 'retired')
    ), run_facts AS (
      SELECT run.tenant_id,
             run.id,
             run.workflow_definition_id,
             run.workflow_key,
             run.workflow_version,
             run.pathway_governance_id,
             run.pathway_definition_checksum,
             governance.id AS governance_id,
             governance.governance_status,
             governance.definition_checksum AS governance_checksum,
             COALESCE(companion.companion_count, 0) AS companion_count,
             instance.id AS pathway_instance_id,
             instance.patient_uid,
             instance.pathway_key,
             instance.pathway_version,
             instance.workflow_definition_id AS instance_workflow_definition_id,
             instance.definition_governance_id AS instance_governance_id,
             instance.definition_checksum AS instance_checksum,
             instance.idempotency_key AS instance_idempotency_key,
             COALESCE(event.creation_count, 0) AS creation_count,
             COALESCE(event.exact_creation_count, 0) AS exact_creation_count,
             ENCODE(DIGEST(CONCAT_WS(
               '|',
               'care-pathway-run-584',
               run.tenant_id::text,
               run.id::text
             ), 'sha256'), 'hex') AS pin_fingerprint
        FROM workflow_runs AS run
        LEFT JOIN care_pathway_definition_governance AS governance
          ON governance.tenant_id = run.tenant_id
         AND governance.workflow_definition_id = run.workflow_definition_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::integer AS companion_count
            FROM care_pathway_instances AS candidate
           WHERE candidate.tenant_id = run.tenant_id
             AND candidate.workflow_run_id = run.id
        ) AS companion ON TRUE
        LEFT JOIN LATERAL (
          SELECT candidate.*
            FROM care_pathway_instances AS candidate
           WHERE candidate.tenant_id = run.tenant_id
             AND candidate.workflow_run_id = run.id
           ORDER BY candidate.id::text
           LIMIT 1
        ) AS instance ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::integer AS creation_count,
                 COUNT(*) FILTER (
                   WHERE creation.transition_scope = 'pathway'
                     AND creation.sequence_number = 1
                     AND creation.effect_ordinal = 0
                     AND creation.workflow_run_id = run.id
                     AND creation.patient_uid = instance.patient_uid
                     AND creation.idempotency_key = instance.idempotency_key
                     AND creation.canonical_timeline_event_id IS NOT NULL
                     AND creation.canonical_audit_event_id IS NOT NULL
                     AND jsonb_typeof(creation.event_payload->'event_id') = 'string'
                     AND creation.event_payload->>'event_id' = creation.id::text
                     AND jsonb_typeof(creation.event_payload->'tenant_id') = 'string'
                     AND creation.event_payload->>'tenant_id' = creation.tenant_id::text
                     AND jsonb_typeof(
                           creation.event_payload->'pathway_instance_id'
                         ) = 'string'
                     AND creation.event_payload->>'pathway_instance_id' =
                           creation.pathway_instance_id::text
                     AND jsonb_typeof(creation.event_payload->'patient_uid') = 'string'
                     AND creation.event_payload->>'patient_uid' =
                           creation.patient_uid::text
                     AND jsonb_typeof(
                           creation.event_payload->'workflow_run_id'
                         ) = 'number'
                     AND creation.event_payload->>'workflow_run_id' =
                           creation.workflow_run_id::text
                     AND jsonb_typeof(
                           creation.event_payload->'sequence_number'
                         ) = 'number'
                     AND creation.event_payload->>'sequence_number' = '1'
                     AND jsonb_typeof(
                           creation.event_payload->'transition_scope'
                         ) = 'string'
                     AND creation.event_payload->>'transition_scope' =
                           creation.transition_scope
                     AND jsonb_typeof(
                           creation.event_payload->'transition_key'
                         ) = 'string'
                     AND creation.event_payload->>'transition_key' =
                           creation.transition_key
                     AND jsonb_typeof(
                           creation.event_payload->'idempotency_key'
                         ) = 'string'
                     AND creation.event_payload->>'idempotency_key' =
                           creation.idempotency_key
                     AND jsonb_typeof(
                           creation.event_payload->'command_fingerprint'
                         ) = 'string'
                     AND creation.event_payload->>'command_fingerprint' =
                           creation.command_fingerprint::text
                     AND jsonb_typeof(
                           creation.event_payload->'effect_ordinal'
                         ) = 'number'
                     AND creation.event_payload->>'effect_ordinal' = '0'
                     AND jsonb_typeof(
                           creation.event_payload->'workflow_definition_id'
                         ) = 'number'
                     AND creation.event_payload->>'workflow_definition_id' =
                           run.workflow_definition_id::text
                     AND jsonb_typeof(
                           creation.event_payload->'governance_id'
                         ) = 'string'
                     AND creation.event_payload->>'governance_id' =
                           governance.id::text
                     AND jsonb_typeof(
                           creation.event_payload->'definition_checksum'
                         ) = 'string'
                     AND creation.event_payload->>'definition_checksum' =
                           run.pathway_definition_checksum::text
                     AND jsonb_typeof(
                           creation.metadata->'pathway_runtime'
                         ) = 'object'
                     AND jsonb_typeof(
                           creation.metadata #> ARRAY[
                             'pathway_runtime', 'definition_checksum'
                           ]
                         ) = 'string'
                     AND creation.metadata #>> ARRAY[
                           'pathway_runtime', 'definition_checksum'
                         ] = instance.definition_checksum::text
                     AND jsonb_typeof(
                           creation.metadata->'command_fingerprint'
                         ) = 'string'
                     AND creation.metadata->>'command_fingerprint' =
                           creation.command_fingerprint::text
                     AND jsonb_typeof(
                           creation.metadata->'effect_ordinal'
                         ) = 'number'
                     AND creation.metadata->>'effect_ordinal' = '0'
                     AND timeline.id IS NOT NULL
                     AND timeline.patient_uid = creation.patient_uid
                     AND timeline.encounter_id IS NOT DISTINCT FROM
                           instance.encounter_id
                     AND timeline.event_type = 'care_pathway.transition'
                     AND timeline.event_status = creation.transition_scope
                     AND timeline.source_table = 'care_pathway_transition_events'
                     AND timeline.source_id = creation.id::text
                     AND timeline.source_uid = creation.id
                     AND timeline.resource_type =
                           'care_pathway_transition_event'
                     AND timeline.resource_id = creation.id::text
                     AND timeline.actor_uid IS NOT DISTINCT FROM
                           creation.actor_uid
                     AND timeline.actor_role IS NOT DISTINCT FROM
                           creation.actor_role
                     AND timeline.occurred_at = creation.occurred_at
                     AND timeline.visible_to_patient = FALSE
                     AND timeline.payload = creation.event_payload
                     AND timeline.idempotency_key =
                           'care_pathway_transition_events:'
                           || creation.id::text || ':timeline'
                     AND audit.id IS NOT NULL
                     AND audit.patient_uid = creation.patient_uid
                     AND audit.encounter_id IS NOT DISTINCT FROM
                           instance.encounter_id
                     AND audit.action = 'care_pathway.transition'
                     AND audit.action_status = 'success'
                     AND audit.resource_type =
                           'care_pathway_transition_event'
                     AND audit.resource_table = 'care_pathway_transition_events'
                     AND audit.resource_id = creation.id::text
                     AND audit.actor_uid IS NOT DISTINCT FROM
                           creation.actor_uid
                     AND audit.actor_role IS NOT DISTINCT FROM
                           creation.actor_role
                     AND audit.before_state = creation.previous_state
                     AND audit.after_state = creation.new_state
                     AND audit.metadata = creation.metadata
                     AND audit.idempotency_key =
                           'care_pathway_transition_events:'
                           || creation.id::text || ':audit'
                     AND audit.occurred_at = creation.occurred_at
                 )::integer AS exact_creation_count
            FROM care_pathway_transition_events AS creation
            LEFT JOIN clinical_timeline_events AS timeline
              ON timeline.tenant_id = creation.tenant_id
             AND timeline.id = creation.canonical_timeline_event_id
            LEFT JOIN clinical_audit_events AS audit
              ON audit.tenant_id = creation.tenant_id
             AND audit.id = creation.canonical_audit_event_id
           WHERE creation.tenant_id = run.tenant_id
             AND creation.pathway_instance_id = instance.id
             AND creation.transition_key = 'pathway_instance_created'
        ) AS event ON TRUE
       WHERE governance.id IS NOT NULL
          OR run.pathway_governance_id IS NOT NULL
          OR run.pathway_definition_checksum IS NOT NULL
    ), findings AS (
      SELECT governance.tenant_id,
             governance.id::text AS entity_sort_key,
             'care_pathway_governance_approval_checksum_binding_violations'::text
               AS issue_key,
             governance.pin_fingerprint,
             governance.governance_status,
             NULL::integer AS companion_count,
             NULL::integer AS creation_count,
             NULL::integer AS exact_creation_count,
             ARRAY_REMOVE(ARRAY[
               CASE WHEN governance.approval_id IS NULL
                 THEN 'published_governance_has_no_bound_approval' END,
               CASE WHEN jsonb_typeof(
                 governance.approval_metadata -> 'care_pathway_definition_governance'
               ) IS DISTINCT FROM 'object'
                 THEN 'approval_checksum_receipt_is_not_an_object' END,
               CASE WHEN jsonb_typeof(
                 governance.approval_metadata #> ARRAY[
                   'care_pathway_definition_governance', 'definition_checksum'
                 ]
               ) IS DISTINCT FROM 'string'
                 THEN 'approval_checksum_receipt_is_not_a_json_string' END,
               CASE WHEN governance.approval_metadata #>> ARRAY[
                 'care_pathway_definition_governance', 'definition_checksum'
               ] IS DISTINCT FROM governance.definition_checksum::text
                 THEN 'approval_checksum_receipt_does_not_match_governance' END
             ], NULL)::text[] AS blocking_reasons
        FROM governance_facts AS governance
       WHERE governance.approval_id IS NULL
          OR jsonb_typeof(
               governance.approval_metadata -> 'care_pathway_definition_governance'
             ) IS DISTINCT FROM 'object'
          OR jsonb_typeof(
               governance.approval_metadata #> ARRAY[
                 'care_pathway_definition_governance', 'definition_checksum'
               ]
             ) IS DISTINCT FROM 'string'
          OR governance.approval_metadata #>> ARRAY[
               'care_pathway_definition_governance', 'definition_checksum'
             ] IS DISTINCT FROM governance.definition_checksum::text

      UNION ALL

      SELECT governance.tenant_id,
             governance.id::text,
             'care_pathway_governance_current_owner_eligibility_violations'::text,
             governance.pin_fingerprint,
             governance.governance_status,
             NULL::integer,
             NULL::integer,
             NULL::integer,
             ARRAY_REMOVE(ARRAY[
               CASE WHEN governance.governance_status = 'approved'
                          AND (
                            NULLIF(BTRIM(governance.clinical_owner_role), '')
                              IS NULL
                            OR UPPER(governance.clinical_owner_role) = 'PATIENT'
                            OR governance.clinical_owner_is_active
                                 IS DISTINCT FROM TRUE
                          )
                 THEN 'approved_governance_clinical_owner_is_not_active_non_patient'
               END,
               CASE WHEN governance.governance_status = 'approved'
                          AND (
                            NULLIF(BTRIM(governance.operational_owner_role), '')
                              IS NULL
                            OR UPPER(governance.operational_owner_role) = 'PATIENT'
                            OR governance.operational_owner_is_active
                                 IS DISTINCT FROM TRUE
                          )
                 THEN 'approved_governance_operational_owner_is_not_active_non_patient'
               END
             ], NULL)::text[]
        FROM governance_facts AS governance
       WHERE governance.governance_status = 'approved'
         AND (
           NULLIF(BTRIM(governance.clinical_owner_role), '') IS NULL
           OR UPPER(governance.clinical_owner_role) = 'PATIENT'
           OR governance.clinical_owner_is_active IS DISTINCT FROM TRUE
           OR NULLIF(BTRIM(governance.operational_owner_role), '') IS NULL
           OR UPPER(governance.operational_owner_role) = 'PATIENT'
           OR governance.operational_owner_is_active IS DISTINCT FROM TRUE
         )

      UNION ALL

      SELECT governance.tenant_id,
             governance.id::text,
             'care_pathway_governance_lifecycle_evidence_violations'::text,
             governance.pin_fingerprint,
             governance.governance_status,
             NULL::integer,
             NULL::integer,
             NULL::integer,
             ARRAY[
               'retired_governance_lacks_exact_actor_reason_chronology_or_disabled_definition'
             ]::text[]
        FROM governance_facts AS governance
       WHERE governance.governance_status = 'retired'
         AND (
           governance.retired_by IS NULL
           OR governance.retired_at IS NULL
           OR NULLIF(BTRIM(governance.retirement_reason), '') IS NULL
           OR governance.effective_until IS NULL
           OR governance.retired_at < governance.approved_at
           OR governance.effective_until > governance.retired_at
           OR governance.definition_is_active
         )

      UNION ALL

      SELECT run.tenant_id,
             run.id::text,
             'care_pathway_governed_run_orphan_violations'::text,
             run.pin_fingerprint,
             run.governance_status,
             run.companion_count,
             run.creation_count,
             run.exact_creation_count,
             ARRAY_REMOVE(ARRAY[
               CASE WHEN run.governance_id IS NULL
                 THEN 'ungoverned_run_carries_pathway_pins' END,
               CASE WHEN run.governance_id IS NOT NULL
                          AND run.governance_status NOT IN ('approved', 'retired')
                 THEN 'governed_run_is_not_published_or_retired' END,
               CASE WHEN run.governance_id IS NOT NULL
                          AND (
                            run.governance_checksum IS NULL
                            OR run.governance_checksum !~ '^[0-9a-f]{64}$'
                          )
                 THEN 'governance_checksum_is_not_canonical_sha256' END,
               CASE WHEN run.pathway_governance_id
                          IS DISTINCT FROM run.governance_id
                 THEN 'run_governance_pin_mismatch' END,
               CASE WHEN run.pathway_definition_checksum
                          IS DISTINCT FROM run.governance_checksum
                 THEN 'run_definition_checksum_pin_mismatch' END,
               CASE WHEN run.companion_count <> 1
                 THEN 'governed_run_requires_exactly_one_companion' END
             ], NULL)::text[]
        FROM run_facts AS run
       WHERE run.governance_id IS NULL
          OR run.governance_status NOT IN ('approved', 'retired')
          OR run.governance_checksum IS NULL
          OR run.governance_checksum !~ '^[0-9a-f]{64}$'
          OR run.pathway_governance_id IS DISTINCT FROM run.governance_id
          OR run.pathway_definition_checksum IS DISTINCT FROM run.governance_checksum
          OR run.companion_count <> 1

      UNION ALL

      SELECT run.tenant_id,
             run.id::text,
             'care_pathway_runtime_definition_pin_violations'::text,
             run.pin_fingerprint,
             run.governance_status,
             run.companion_count,
             run.creation_count,
             run.exact_creation_count,
             ARRAY_REMOVE(ARRAY[
               CASE WHEN run.pathway_instance_id IS NULL
                 THEN 'governed_run_has_no_pathway_companion' END,
               CASE WHEN run.pathway_key IS DISTINCT FROM run.workflow_key
                 THEN 'instance_pathway_key_does_not_match_run' END,
               CASE WHEN run.pathway_version IS DISTINCT FROM run.workflow_version
                 THEN 'instance_pathway_version_does_not_match_run' END,
               CASE WHEN run.instance_workflow_definition_id
                          IS DISTINCT FROM run.workflow_definition_id
                 THEN 'instance_workflow_definition_pin_mismatch' END,
               CASE WHEN run.instance_governance_id
                          IS DISTINCT FROM run.pathway_governance_id
                 THEN 'instance_governance_pin_mismatch' END,
               CASE WHEN run.instance_checksum
                          IS DISTINCT FROM run.pathway_definition_checksum
                 THEN 'instance_definition_checksum_pin_mismatch' END,
               CASE WHEN run.creation_count <> 1
                 THEN 'pathway_requires_one_creation_event' END,
               CASE WHEN run.exact_creation_count <> 1
                 THEN 'pathway_creation_event_identity_is_not_exact' END
             ], NULL)::text[]
        FROM run_facts AS run
       WHERE run.governance_id IS NOT NULL
         AND run.governance_status IN ('approved', 'retired')
         AND run.pathway_governance_id = run.governance_id
         AND run.pathway_definition_checksum = run.governance_checksum
         AND run.companion_count = 1
         AND (
           run.pathway_instance_id IS NULL
           OR run.pathway_key IS DISTINCT FROM run.workflow_key
           OR run.pathway_version IS DISTINCT FROM run.workflow_version
           OR run.instance_workflow_definition_id
                IS DISTINCT FROM run.workflow_definition_id
           OR run.instance_governance_id IS DISTINCT FROM run.pathway_governance_id
           OR run.instance_checksum IS DISTINCT FROM run.pathway_definition_checksum
           OR run.creation_count <> 1
           OR run.exact_creation_count <> 1
         )
    ), ranked AS (
      SELECT finding.*,
             COUNT(*) OVER (
               PARTITION BY finding.tenant_id, finding.issue_key
             )::bigint AS total_count,
             ROW_NUMBER() OVER (
               PARTITION BY finding.tenant_id, finding.issue_key
               ORDER BY finding.entity_sort_key
             ) AS sample_rank
        FROM findings AS finding
    )
    SELECT ranked.tenant_id,
           ranked.issue_key,
           ranked.total_count,
           ranked.sample_rank,
           ranked.pin_fingerprint,
           ranked.governance_status,
           ranked.companion_count,
           ranked.creation_count,
           ranked.exact_creation_count,
           ranked.blocking_reasons
      FROM ranked
     WHERE ranked.sample_rank <= $1::int
     ORDER BY ranked.tenant_id, ranked.issue_key, ranked.sample_rank
  `,
});

export const ORU_BLOCKER_SECTION_KEYS = Object.freeze([
  'incomplete_legacy_identities',
  'whitespace_legacy_identities',
  'duplicate_legacy_identities',
  'unmapped_hl7_senders',
  'ambiguous_hl7_senders',
  'inactive_hl7_senders',
  'patient_only_unlinked_message_groups',
  'legacy_local_order_contract_unproven_message_groups',
  'other_adoption_ineligible_message_groups',
]);

export const PRE_583_BLOCKER_SECTION_KEYS = Object.freeze([
  'astm_duplicate_receipt_groups',
  'astm_legacy_nonterminal_receipts',
  'astm_legacy_analyzer_unresolved_receipts',
  'astm_legacy_adoption_ineligible_receipts',
  'astm_no_potential_result_candidates',
  'astm_orderless_clinically_unlinked_receipts',
]);

export const POST_582_BLOCKER_SECTION_KEYS = Object.freeze([
  'oru_nonterminal_claims_at_maintenance_snapshot',
  'oru_completed_claim_integrity_violations',
  'oru_orderless_completed_claims',
  'oru_bare_numeric_order_identity_claims',
  'oru_malformed_reserved_order_identity_claims',
  'oru_order_identity_disagreement_claims',
  'oru_namespaced_source_contract_violations',
  'oru_unattested_external_or_missing_local_links',
]);

export const POST_583_BLOCKER_SECTION_KEYS = Object.freeze([
  'astm_duplicate_receipt_groups',
  'astm_atomic_contract_violations',
  'astm_nonterminal_contract_receipts',
  'astm_failed_receipt_contract_violations',
  'astm_ingested_durable_evidence_violations',
  'astm_message_fingerprint_drift',
  'astm_orderless_clinically_unlinked_receipts',
  'astm_critical_rail_core_drift',
  'astm_generic_task_ack_alert_open_splits',
]);

export const POST_584_BLOCKER_SECTION_KEYS = Object.freeze([
  'care_pathway_governance_approval_checksum_binding_violations',
  'care_pathway_governance_current_owner_eligibility_violations',
  'care_pathway_governance_lifecycle_evidence_violations',
  'care_pathway_governed_run_orphan_violations',
  'care_pathway_runtime_definition_pin_violations',
]);

export const PRE_583_EVIDENCE_SECTION_KEYS = Object.freeze([
  'astm_legacy_adoption_clone_rehearsal_candidates',
  'astm_critical_rail_clone_rehearsal_candidates',
]);

export const BLOCKER_SECTION_KEYS = Object.freeze([
  ...ORU_BLOCKER_SECTION_KEYS,
  ...POST_582_BLOCKER_SECTION_KEYS,
  ...new Set([
    ...PRE_583_BLOCKER_SECTION_KEYS,
    ...POST_583_BLOCKER_SECTION_KEYS,
  ]),
  ...POST_584_BLOCKER_SECTION_KEYS,
]);

function asCount(value) {
  const parsed = Number(value || 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid audit count: ${value}`);
  }
  return parsed;
}

function normalizedSample(row) {
  const sample = {};
  for (const [key, value] of Object.entries(row)) {
    if (
      [
        'tenant_id',
        'issue_key',
        'total_count',
        'sample_rank',
        'structurally_eligible',
        'adoption_bucket',
      ].includes(key)
    ) {
      continue;
    }
    if (typeof value === 'bigint') sample[key] = Number(value);
    else if (value instanceof Date) sample[key] = value.toISOString();
    else if (Array.isArray(value)) {
      sample[key] = value.map(item => (typeof item === 'bigint' ? Number(item) : item));
    } else sample[key] = value;
  }
  return sample;
}

function sectionFromRows(rows, tenantId, predicate = () => true) {
  const matches = (rows || [])
    .filter(row => String(row.tenant_id) === tenantId && predicate(row))
    .sort((a, b) => asCount(a.sample_rank) - asCount(b.sample_rank));
  return {
    count: matches.length ? Math.max(...matches.map(row => asCount(row.total_count))) : 0,
    samples: matches.map(normalizedSample),
  };
}

function issueSection(rows, tenantId, issueKey) {
  return sectionFromRows(rows, tenantId, row => row.issue_key === issueKey);
}

function globalIssueSection(rows, issueKey, sampleLimit) {
  const matches = (rows || [])
    .filter(row => row.issue_key === issueKey)
    .sort((left, right) => (
      String(left.tenant_id).localeCompare(String(right.tenant_id))
      || asCount(left.sample_rank) - asCount(right.sample_rank)
    ));
  const tenantCounts = new Map();
  for (const row of matches) {
    const tenantId = String(row.tenant_id);
    tenantCounts.set(
      tenantId,
      Math.max(tenantCounts.get(tenantId) || 0, asCount(row.total_count)),
    );
  }
  return {
    count: [...tenantCounts.values()].reduce((sum, count) => sum + count, 0),
    samples: matches.slice(0, sampleLimit).map(row => ({
      tenant_id: String(row.tenant_id),
      ...normalizedSample(row),
    })),
  };
}

export function schemaModeFromState(schemaState = {}) {
  const oruArtifacts = [
    schemaState.oru_message_claim_table_exists === true,
    schemaState.result_command_claim_table_exists === true,
    asCount(schemaState.oru_result_claim_column_count) === 2,
  ];
  const oruAbsent = oruArtifacts.every(value => value === false);
  const oruPresent = oruArtifacts.every(value => value === true);
  const astmColumnCount = asCount(schemaState.astm_contract_column_count);
  const astmResultLinkCount = asCount(schemaState.astm_result_link_column_count);
  const astmAbsent = astmColumnCount === 0 && astmResultLinkCount === 0;
  const astmPresent = astmColumnCount === 8 && astmResultLinkCount === 2;

  if ((!oruAbsent && !oruPresent) || (!astmAbsent && !astmPresent)) {
    throw new Error('Partial migration-582/583 schema detected; refusing a mixed-schema green result');
  }
  if (astmPresent && !oruPresent) {
    throw new Error('Migration-583 schema exists without the required migration-582 schema');
  }
  if (oruAbsent && astmAbsent) return 'pre_582_583';
  if (oruPresent && astmAbsent) return 'post_582_pre_583';
  return 'post_582_583';
}

export function criticalAlertSchemaModeFromState(schemaState = {}) {
  const generationColumnCount = asCount(
    schemaState.critical_alert_generation_column_count,
  );
  const receiptTableExists = schemaState.critical_alert_ack_receipt_table_exists === true;
  const receiptColumnCount = asCount(
    schemaState.critical_alert_ack_receipt_column_count,
  );
  const receiptGuardTriggerCount = asCount(
    schemaState.critical_alert_ack_receipt_guard_trigger_count,
  );
  const receiptReadBackContractColumnCount = asCount(
    schemaState.critical_alert_ack_receipt_read_back_contract_column_count,
  );
  if (
    generationColumnCount === 0
    && !receiptTableExists
    && receiptColumnCount === 0
    && receiptGuardTriggerCount === 0
    && receiptReadBackContractColumnCount === 0
  ) return 'pre_581';
  if (
    generationColumnCount === 6
    && receiptTableExists
    && receiptColumnCount === 27
    && receiptGuardTriggerCount === 6
    && receiptReadBackContractColumnCount === 1
  ) return 'post_581';
  throw new Error(
    'Partial migration-581 critical-alert schema detected; refusing a mixed-schema green result',
  );
}

export function carePathwayGovernanceSchemaModeFromState(schemaState = {}) {
  const lifecycleColumnCount = asCount(
    schemaState.care_pathway_governance_lifecycle_column_count,
  );
  const runPinColumnCount = asCount(
    schemaState.care_pathway_run_pin_column_count,
  );
  const instancePinColumnCount = asCount(
    schemaState.care_pathway_instance_pin_column_count,
  );
  const pinConstraintCount = asCount(
    schemaState.care_pathway_governance_pin_constraint_count,
  );
  const pinIndexCount = asCount(
    schemaState.care_pathway_governance_pin_index_count,
  );
  const pinTriggerCount = asCount(
    schemaState.care_pathway_governance_pin_trigger_count,
  );
  const revokedTriggerCount = asCount(
    schemaState.care_pathway_governance_revoked_trigger_count,
  );
  const pre584TriggerState = (
    pinTriggerCount === 0 && revokedTriggerCount === 0
  ) || (
    pinTriggerCount === 10 && revokedTriggerCount === 1
  );
  if (
    lifecycleColumnCount === 0
    && runPinColumnCount === 0
    && instancePinColumnCount === 0
    && pinConstraintCount === 0
    && pinIndexCount === 0
    && pre584TriggerState
  ) return 'pre_584';
  if (
    lifecycleColumnCount === 3
    && runPinColumnCount === 2
    && instancePinColumnCount === 3
    && pinConstraintCount === 6
    && pinIndexCount === 6
    && pinTriggerCount === 23
    && revokedTriggerCount === 0
  ) return 'post_584';
  throw new Error(
    'Partial migration-584 governance-pin schema detected; refusing a mixed-schema green result',
  );
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function buildMigrationState({
  migrationFileNames = [],
  migrationRows = [],
  schemaMode,
  governanceSchemaMode = 'pre_584',
} = {}) {
  const releaseMigrations = [...new Set(migrationFileNames)]
    .filter(name => typeof name === 'string' && name.endsWith('.sql'))
    .sort();
  if (!releaseMigrations.length) {
    throw new Error('Release migration inventory is empty; exact pending-set proof is unavailable');
  }
  for (const target of CUTOVER_MIGRATIONS) {
    if (!releaseMigrations.includes(target)) {
      throw new Error(`Release migration inventory is missing ${target}`);
    }
  }

  const tracked = new Set((migrationRows || []).map(row => row.name));
  const pending = releaseMigrations.filter(name => !tracked.has(name));
  const targetApplied = Object.fromEntries(
    CUTOVER_MIGRATIONS.map(name => [name, tracked.has(name)]),
  );
  const prerequisitesAppliedCount = PREREQUISITE_MIGRATIONS
    .filter(name => targetApplied[name]).length;
  const prerequisiteState = prerequisitesAppliedCount === 0
    ? 'bundled_580_584_cutover'
    : prerequisitesAppliedCount === PREREQUISITE_MIGRATIONS.length
      ? 'documented_580_581_prerequisite_release'
      : 'partial_prerequisite_state';
  let expectedPending;
  if (schemaMode === 'pre_582_583' && governanceSchemaMode === 'pre_584') {
    expectedPending = prerequisiteState === 'bundled_580_584_cutover'
      ? [...CUTOVER_MIGRATIONS]
      : prerequisiteState === 'documented_580_581_prerequisite_release'
        ? [...TARGET_MIGRATIONS]
        : [];
  } else if (schemaMode === 'post_582_pre_583' && governanceSchemaMode === 'pre_584') {
    expectedPending = TARGET_MIGRATIONS.slice(1);
  } else if (schemaMode === 'post_582_583' && governanceSchemaMode === 'pre_584') {
    expectedPending = TARGET_MIGRATIONS.slice(2);
  } else expectedPending = [];

  const targetTrackerCoherent = schemaMode === 'pre_582_583'
    && governanceSchemaMode === 'pre_584'
    ? !targetApplied[TARGET_MIGRATIONS[0]]
      && !targetApplied[TARGET_MIGRATIONS[1]]
      && !targetApplied[TARGET_MIGRATIONS[2]]
      && prerequisiteState !== 'partial_prerequisite_state'
    : schemaMode === 'post_582_pre_583' && governanceSchemaMode === 'pre_584'
      ? PREREQUISITE_MIGRATIONS.every(name => targetApplied[name])
        && targetApplied[TARGET_MIGRATIONS[0]]
        && !targetApplied[TARGET_MIGRATIONS[1]]
        && !targetApplied[TARGET_MIGRATIONS[2]]
      : schemaMode === 'post_582_583' && governanceSchemaMode === 'pre_584'
        ? CUTOVER_MIGRATIONS.slice(0, -1).every(name => targetApplied[name])
          && !targetApplied[TARGET_MIGRATIONS[2]]
        : schemaMode === 'post_582_583' && governanceSchemaMode === 'post_584'
          ? CUTOVER_MIGRATIONS.every(name => targetApplied[name])
          : false;
  const exactPendingSet = sameStrings(pending, [...expectedPending].sort());
  const combinedBatchState = (
    schemaMode === 'pre_582_583' && governanceSchemaMode === 'pre_584'
  ) || (
    schemaMode === 'post_582_583' && governanceSchemaMode === 'post_584'
  );

  return {
    release_migration_count: releaseMigrations.length,
    prerequisite_state: prerequisiteState,
    governance_schema_mode: governanceSchemaMode,
    target_applied: targetApplied,
    pending,
    expected_pending: expectedPending,
    exact_pending_set: exactPendingSet,
    target_tracker_coherent: targetTrackerCoherent,
    combined_batch_state: combinedBatchState,
    ready: exactPendingSet && targetTrackerCoherent && combinedBatchState,
  };
}

function blockerKeysForSchema(schemaMode, governanceSchemaMode) {
  const astmKeys = schemaMode === 'post_582_583'
    ? POST_583_BLOCKER_SECTION_KEYS
    : PRE_583_BLOCKER_SECTION_KEYS;
  const oruClaimKeys = schemaMode === 'pre_582_583'
    ? []
    : POST_582_BLOCKER_SECTION_KEYS;
  const governanceKeys = governanceSchemaMode === 'post_584'
    ? POST_584_BLOCKER_SECTION_KEYS
    : [];
  return [
    ...ORU_BLOCKER_SECTION_KEYS,
    ...oruClaimKeys,
    ...astmKeys,
    ...governanceKeys,
  ];
}

/** Build stable, bounded, tenant-grouped evidence from the SELECT-only query rows. */
export function buildAuditReport({
  tenantRows = [],
  rowsByQuery = {},
  readOnlyState = {},
  schemaState = {},
  schemaMode = schemaModeFromState(schemaState),
  criticalAlertSchemaMode = criticalAlertSchemaModeFromState(schemaState),
  governanceSchemaMode = carePathwayGovernanceSchemaModeFromState(schemaState),
  migrationState = {
    ready: false,
    pending: [],
    expected_pending: [],
    exact_pending_set: false,
    target_tracker_coherent: false,
    combined_batch_state: false,
  },
  migrationArtifacts = FROZEN_CUTOVER_MIGRATION_ARTIFACTS,
  sampleLimit = DEFAULT_SAMPLE_LIMIT,
  generatedAt = new Date().toISOString(),
} = {}) {
  const tenantIds = new Set((tenantRows || []).map(row => String(row.tenant_id)));
  for (const rows of Object.values(rowsByQuery)) {
    for (const row of rows || []) {
      if (row.tenant_id != null) tenantIds.add(String(row.tenant_id));
    }
  }

  const blockerSectionKeys = blockerKeysForSchema(schemaMode, governanceSchemaMode);
  const tenants = [...tenantIds].sort().map(tenantId => {
    const identityRows = rowsByQuery.identity_issues || [];
    const duplicateRows = rowsByQuery.duplicate_identities || [];
    const senderRows = rowsByQuery.sender_issues || [];
    const adoptionRows = rowsByQuery.adoption_eligibility || [];
    const supplementalRows = [
      ...(rowsByQuery.oru_claim_source_readiness || []),
      ...(rowsByQuery.astm_duplicate_fingerprints || []),
      ...(rowsByQuery.astm_legacy_receipt_readiness || []),
      ...(rowsByQuery.astm_atomic_contract_readiness || []),
      ...(rowsByQuery.care_pathway_governance_pinning_readiness || []),
    ];
    const blockers = {
      incomplete_legacy_identities: issueSection(
        identityRows,
        tenantId,
        'incomplete_legacy_identities',
      ),
      whitespace_legacy_identities: issueSection(
        identityRows,
        tenantId,
        'whitespace_legacy_identities',
      ),
      duplicate_legacy_identities: issueSection(
        duplicateRows,
        tenantId,
        'duplicate_legacy_identities',
      ),
      unmapped_hl7_senders: issueSection(
        senderRows,
        tenantId,
        'unmapped_hl7_senders',
      ),
      ambiguous_hl7_senders: issueSection(
        senderRows,
        tenantId,
        'ambiguous_hl7_senders',
      ),
      inactive_hl7_senders: issueSection(
        senderRows,
        tenantId,
        'inactive_hl7_senders',
      ),
      patient_only_unlinked_message_groups: sectionFromRows(
        adoptionRows,
        tenantId,
        row => row.adoption_bucket === 'patient_only_unlinked',
      ),
      legacy_local_order_contract_unproven_message_groups: sectionFromRows(
        adoptionRows,
        tenantId,
        row => row.adoption_bucket === 'legacy_local_order_contract_unproven',
      ),
      other_adoption_ineligible_message_groups: sectionFromRows(
        adoptionRows,
        tenantId,
        row => row.adoption_bucket === 'other_ineligible',
      ),
    };
    for (const key of blockerSectionKeys.slice(ORU_BLOCKER_SECTION_KEYS.length)) {
      blockers[key] = issueSection(supplementalRows, tenantId, key);
    }

    const ineligibleMessageGroups = {
      count: blockers.patient_only_unlinked_message_groups.count
        + blockers.legacy_local_order_contract_unproven_message_groups.count
        + blockers.other_adoption_ineligible_message_groups.count,
      samples: [
        ...blockers.patient_only_unlinked_message_groups.samples,
        ...blockers.legacy_local_order_contract_unproven_message_groups.samples,
        ...blockers.other_adoption_ineligible_message_groups.samples,
      ].slice(0, sampleLimit),
    };
    const adoption = {
      structurally_eligible_message_groups: sectionFromRows(
        adoptionRows,
        tenantId,
        row => row.structurally_eligible === true,
      ),
      ineligible_message_groups: ineligibleMessageGroups,
    };
    const astmEvidence = schemaMode === 'post_582_583'
      ? {}
      : Object.fromEntries(
          PRE_583_EVIDENCE_SECTION_KEYS.map(key => [
            key,
            issueSection(supplementalRows, tenantId, key),
          ]),
        );
    const blockingFindingCount = blockerSectionKeys.reduce(
      (sum, key) => sum + blockers[key].count,
      0,
    );
    return {
      tenant_id: tenantId,
      ready: blockingFindingCount === 0,
      blocking_finding_count: blockingFindingCount,
      blockers,
      oru_adoption: adoption,
      astm_evidence: astmEvidence,
    };
  });

  const totals = Object.fromEntries(
    blockerSectionKeys.map(key => [
      key,
      tenants.reduce((sum, tenant) => sum + tenant.blockers[key].count, 0),
    ]),
  );
  const tenantBlockingFindingCount = Object.values(totals)
    .reduce((sum, count) => sum + count, 0);
  const historicalAckRows = criticalAlertSchemaMode === 'post_581'
    ? rowsByQuery.historical_lab_ack_contract_post_581
    : rowsByQuery.historical_lab_ack_contract_pre_581;
  const historicalAckContractBlocker = globalIssueSection(
    historicalAckRows,
    'historical_lab_ack_contract_violations',
    sampleLimit,
  );
  const globalBlockers = {
    migration_inventory_or_tracker_mismatch: {
      count: migrationState.ready ? 0 : 1,
      expected_pending: migrationState.expected_pending,
      actual_pending: migrationState.pending,
      exact_pending_set: migrationState.exact_pending_set,
      target_tracker_coherent: migrationState.target_tracker_coherent,
      combined_batch_state: migrationState.combined_batch_state,
    },
    fresh_production_clone_migration_584_proof_pending: {
      count: schemaMode === 'post_582_583'
        && governanceSchemaMode === 'post_584'
        && migrationState.target_applied?.[TARGET_MIGRATIONS[2]] === true
        ? 0
        : 1,
      requirement:
        'Apply the exact release through migration 584 on a fresh production clone, then run this audit with post-583 lab schema and tracker-proven migration 584.',
    },
    historical_lab_ack_contract_violations: {
      ...historicalAckContractBlocker,
      schema_branch: criticalAlertSchemaMode,
      requirement:
        'Every structural critical-lab acknowledgement requires one exact version-2 alert/task/SLA/comment/timeline/audit contract. Post-581 closure also requires its typed immutable acknowledgement receipt; only that receipt may preserve a superseded predecessor SLA snapshot after legitimate successor rearm. Receipt-less, unversioned, weak, or split evidence is never auto-repaired.',
    },
  };
  const globalBlockingFindingCount = Object.values(globalBlockers)
    .reduce((sum, finding) => sum + finding.count, 0);
  const blockingFindingCount = tenantBlockingFindingCount + globalBlockingFindingCount;
  const eligibleGroupCount = tenants.reduce(
    (sum, tenant) => sum + tenant.oru_adoption.structurally_eligible_message_groups.count,
    0,
  );
  const astmAdoptionCandidateCount = tenants.reduce(
    (sum, tenant) => sum
      + (tenant.astm_evidence.astm_legacy_adoption_clone_rehearsal_candidates?.count || 0),
    0,
  );
  const cloneRehearsalInputReady = tenantBlockingFindingCount === 0
    && historicalAckContractBlocker.count === 0
    && migrationState.ready;
  const ready = blockingFindingCount === 0
    && schemaMode === 'post_582_583'
    && governanceSchemaMode === 'post_584';

  return {
    schema_version: 5,
    gate: 'migrations_582_584_lab_ingest_and_governance_readiness',
    generated_at: generatedAt,
    ready,
    clone_rehearsal_input_ready: cloneRehearsalInputReady,
    migration_batch_ready: ready,
    lab_ingest_cutover_ready: ready,
    care_pathway_production_activation_ready: false,
    // Fail-closed compatibility for schema <=4 consumers. This unqualified
    // field never authorizes runtime activation; use the scoped fields above.
    activation_ready: false,
    schema_mode: schemaMode,
    critical_alert_schema_mode: criticalAlertSchemaMode,
    care_pathway_governance_schema_mode: governanceSchemaMode,
    access_mode: 'primary_repeatable_read_read_only_transaction',
    sample_limit_per_tenant_per_section: sampleLimit,
    tenants_scanned: tenants.length,
    blocker_section_keys: blockerSectionKeys,
    snapshot: {
      transaction_read_only: readOnlyState.transaction_read_only ?? null,
      transaction_isolation: readOnlyState.transaction_isolation ?? null,
      server_version_num: readOnlyState.server_version_num ?? null,
      pg_is_in_recovery: readOnlyState.pg_is_in_recovery ?? null,
      audit_user: readOnlyState.audit_user ?? null,
      audit_user_is_superuser: readOnlyState.audit_user_is_superuser ?? null,
      audit_user_bypasses_rls: readOnlyState.audit_user_bypasses_rls ?? null,
    },
    schema_state: schemaState,
    migration_state: migrationState,
    frozen_cutover_migration_artifacts: migrationArtifacts,
    proof_boundaries: {
      oru_adoption_eligibility_is_structural_only: true,
      astm_exact_adoption_and_critical_rail_proof:
        schemaMode === 'post_582_583'
          ? 'satisfied_only_by_the_successful_migration_583_commit_on_this_snapshot'
          : 'requires_successful_migration_583_commit_on_a_fresh_production_clone',
      care_pathway_governance_pinning_proof:
        governanceSchemaMode === 'post_584'
          && migrationState.target_applied?.[TARGET_MIGRATIONS[2]] === true
          ? 'schema_and_tracker_prove_migration_584_applied_from_the_exact_release_inventory'
          : 'requires_successful_migration_584_commit_on_the_same_fresh_production_clone',
      care_pathway_canonical_link_identity_boundary:
        'post_584_query_reproves_exact_creation_event_timeline_and_audit_source_resource_actor_state_payload_metadata_time_and_idempotency_parity',
      care_pathway_publication_voter_eligibility_boundary:
        'post_584_first_publication_is_transactionally_checked;_migration_584_cannot_retroactively_prove_historical_active_non_patient_voter_state_without_an_immutable_receipt',
      care_pathway_production_activation_boundary:
        'always_false_in_this_gate;_care_pathway_runtime_activation_requires_the_separate_S1b_c_release_and_its_own_activation_authority',
      legacy_activation_ready_field:
        'deprecated_unqualified_schema_v4_compatibility_field_is_fail_closed_false',
      orderless_source_policy:
        'hard_activation_blocker_requiring_future_owner_governed_reconciliation_and_linkage_migration',
      oru_local_order_namespace_policy:
        'only_canonical_VHINV_positive_int4_is_local;_bare_numeric_and_reserved_VHBOOK_are_rejected;_external_identity_remains_unlinked_shadow_evidence',
      oru_ordered_analyte_policy:
        'VHINV_requires_exact_tenant_patient_resultable_investigation_and_byte_equal_investigation_test_code_OBR_4_and_every_OBX_3',
      historical_lab_ack_policy:
        'every_structural_ack_requires_one_exact_version_2_chain;_post_581_requires_the_typed_immutable_acknowledgement_receipt;_superseded_predecessor_SLA_closure_may_only_come_from_that_receipt;_no_automatic_repair_or_untyped_receipt_is_accepted',
      note:
        'A green pre-583 candidate is not provenance and does not make lab ingest cutover ready. Exact adoption, result linkage, corrected-generation critical rails, and canonical evidence are proved only by a successful migration-583 commit on a fresh production clone followed by this post-schema audit. This gate never authorizes care-pathway production runtime activation.',
    },
    blocking_finding_count: blockingFindingCount,
    tenant_blocking_finding_count: tenantBlockingFindingCount,
    global_blocking_finding_count: globalBlockingFindingCount,
    global_blockers: globalBlockers,
    totals,
    structurally_eligible_oru_message_group_count: eligibleGroupCount,
    astm_adoption_clone_rehearsal_candidate_count: astmAdoptionCandidateCount,
    tenants,
  };
}

function transactionIsReadOnly(value) {
  return value === true || value === 'on' || value === 'true' || value === '1';
}

function transactionIsolationIsRepeatableRead(value) {
  return String(value ?? '').trim().toLowerCase() === 'repeatable read';
}

function postgresMajorVersion(value) {
  const versionNumber = Number(value);
  if (!Number.isInteger(versionNumber) || versionNumber < 10_000) return null;
  return Math.trunc(versionNumber / 10_000);
}

/**
 * Collect one consistent all-tenant snapshot. Dependency injection keeps the
 * focused test database-free while BEGIN READ ONLY remains enforced in prod.
 */
export async function collectLabOruReplayReadiness({
  client,
  migrationFileNames,
  migrationArtifacts,
  sampleLimit = DEFAULT_SAMPLE_LIMIT,
  generatedAt,
} = {}) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('collectLabOruReplayReadiness requires a database client');
  }
  if (!Number.isInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > MAX_SAMPLE_LIMIT) {
    throw new Error(`sampleLimit must be an integer from 1 to ${MAX_SAMPLE_LIMIT}`);
  }
  if (!Array.isArray(migrationFileNames) || migrationFileNames.length === 0) {
    throw new Error('collectLabOruReplayReadiness requires the release migration inventory');
  }
  assertFrozenCutoverMigrationArtifacts(migrationArtifacts);
  let transactionOpen = false;
  try {
    await client.query(BEGIN_READ_ONLY_QUERY);
    transactionOpen = true;

    const stateResult = await client.query(READ_ONLY_CHECK_QUERY);
    const readOnlyState = stateResult.rows?.[0] || {};
    if (!transactionIsReadOnly(readOnlyState.transaction_read_only)) {
      throw new Error('Database transaction is writable; refusing migrations-582-584 readiness scan');
    }
    if (!transactionIsolationIsRepeatableRead(readOnlyState.transaction_isolation)) {
      throw new Error(
        'Database transaction isolation is not repeatable read; refusing migrations-582-584 readiness scan',
      );
    }
    const postgresMajor = postgresMajorVersion(readOnlyState.server_version_num);
    if (postgresMajor !== TARGET_POSTGRESQL_MAJOR) {
      throw new Error(
        `PostgreSQL major ${postgresMajor ?? 'unknown'} is unsupported; the production-clone/target gate requires PostgreSQL major ${TARGET_POSTGRESQL_MAJOR}`,
      );
    }
    if (readOnlyState.pg_is_in_recovery === true) {
      throw new Error('Audit connected to a recovery replica; a lagging snapshot cannot clear the cutover gate');
    }
    if (
      readOnlyState.audit_user_is_superuser !== true
      && readOnlyState.audit_user_bypasses_rls !== true
    ) {
      throw new Error(
        'Audit principal is not all-tenant privileged; rolsuper or rolbypassrls is required',
      );
    }

    const schemaResult = await client.query(SCHEMA_STATE_QUERY);
    const schemaState = schemaResult.rows?.[0] || {};
    const schemaMode = schemaModeFromState(schemaState);
    const criticalAlertSchemaMode = criticalAlertSchemaModeFromState(schemaState);
    const governanceSchemaMode = carePathwayGovernanceSchemaModeFromState(schemaState);
    if (schemaState.pgcrypto_installed !== true) {
      throw new Error(
        'pgcrypto is not installed; exact ASTM SHA-256 replay fingerprint evidence is unavailable',
      );
    }

    const migrationResult = await client.query(MIGRATION_TRACKER_QUERY);
    const migrationState = buildMigrationState({
      migrationFileNames,
      migrationRows: migrationResult.rows || [],
      schemaMode,
      governanceSchemaMode,
    });
    const migration581IsTracked = migrationState.target_applied[
      PREREQUISITE_MIGRATIONS[1]
    ];
    if ((criticalAlertSchemaMode === 'post_581') !== migration581IsTracked) {
      throw new Error(
        'Migration-581 tracker and critical-alert schema disagree; refusing an ambiguous acknowledgement-contract branch',
      );
    }
    const migration584IsTracked = migrationState.target_applied[TARGET_MIGRATIONS[2]];
    if ((governanceSchemaMode === 'post_584') !== migration584IsTracked) {
      throw new Error(
        'Migration-584 tracker and governance-pin schema disagree; refusing an ambiguous governance branch',
      );
    }

    const tenantResult = await client.query(TENANT_INVENTORY_QUERY);
    if ((tenantResult.rows || []).length === 0) {
      throw new Error(
        'All-tenant audit returned zero tenants; refusing an empty-scope green result',
      );
    }
    const rowsByQuery = {};
    const historicalAckQueryKeys = criticalAlertSchemaMode === 'post_581'
      ? POST_581_ACK_REPORT_QUERY_KEYS
      : PRE_581_ACK_REPORT_QUERY_KEYS;
    const astmQueryKeys = schemaMode === 'post_582_583'
      ? POST_583_REPORT_QUERY_KEYS
      : PRE_583_REPORT_QUERY_KEYS;
    const oruClaimQueryKeys = schemaMode === 'pre_582_583'
      ? []
      : POST_582_REPORT_QUERY_KEYS;
    const governanceQueryKeys = governanceSchemaMode === 'post_584'
      ? POST_584_REPORT_QUERY_KEYS
      : [];
    for (const key of [
      ...historicalAckQueryKeys,
      ...REPORT_QUERY_KEYS,
      ...oruClaimQueryKeys,
      ...astmQueryKeys,
      ...governanceQueryKeys,
    ]) {
      const result = await client.query(REPORT_QUERIES[key], [sampleLimit]);
      rowsByQuery[key] = result.rows || [];
    }
    const report = buildAuditReport({
      tenantRows: tenantResult.rows || [],
      rowsByQuery,
      readOnlyState,
      schemaState,
      schemaMode,
      criticalAlertSchemaMode,
      governanceSchemaMode,
      migrationState,
      migrationArtifacts,
      sampleLimit,
      generatedAt,
    });
    await client.query(COMMIT_QUERY);
    transactionOpen = false;
    return report;
  } catch (error) {
    if (transactionOpen) await client.query(ROLLBACK_QUERY).catch(() => {});
    throw error;
  }
}

export function parseArgs(argv) {
  const options = {
    acknowledged: false,
    json: false,
    help: false,
    sampleLimit: DEFAULT_SAMPLE_LIMIT,
  };
  for (const arg of argv) {
    if (arg === ACKNOWLEDGEMENT_FLAG) options.acknowledged = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--sample-limit=')) {
      options.sampleLimit = Number(arg.slice('--sample-limit='.length));
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (
    !Number.isInteger(options.sampleLimit)
    || options.sampleLimit < 1
    || options.sampleLimit > MAX_SAMPLE_LIMIT
  ) {
    throw new Error(`--sample-limit must be an integer from 1 to ${MAX_SAMPLE_LIMIT}`);
  }
  return options;
}

export function resolveConnectionString(env = process.env) {
  return env.LAB_ORU_AUDIT_DATABASE_URL
    || env.DATABASE_SUPERUSER_URL
    || null;
}

export function assertOperationalSafety({ acknowledged, env = process.env } = {}) {
  if (!acknowledged) {
    throw new Error(`Explicit operator acknowledgement required: ${ACKNOWLEDGEMENT_FLAG}`);
  }
  if (!resolveConnectionString(env)) {
    throw new Error(
      'LAB_ORU_AUDIT_DATABASE_URL or DATABASE_SUPERUSER_URL is required; ordinary DATABASE_URL fallback is forbidden',
    );
  }
}

export function auditExitCode(report) {
  return report?.ready === true ? 0 : BLOCKED_EXIT_CODE;
}

export async function resolveReleaseMigrationFiles({
  migrationsDirectory = migrationArtifactsDirectory(),
} = {}) {
  await verifyFrozenCutoverMigrationFiles({ migrationsDirectory });
  return (await readdir(migrationsDirectory))
    .filter(name => name.endsWith('.sql'))
    .sort();
}

function usage() {
  return [
    'Usage:',
    '  node scripts/audit-lab-oru-replay-readiness.mjs',
    `    ${ACKNOWLEDGEMENT_FLAG} [--json] [--sample-limit=${DEFAULT_SAMPLE_LIMIT}]`,
    '',
    'Runs the all-tenant, bounded migrations-582-584 pre/postflight on the primary',
    `inside a repeatable-read READ ONLY transaction on PostgreSQL ${TARGET_POSTGRESQL_MAJOR}.`,
    'The release migration inventory, database tracker, nonempty tenant inventory,',
    'schema mode, ORU sources, ASTM replay identity, and activation blockers must agree.',
    `Exit 0 = ready, ${BLOCKED_EXIT_CODE} = blockers found, 1 = audit execution failed.`,
  ].join('\n');
}

function writeTextReport(report) {
  process.stdout.write(
    `Migrations 582-584 lab ingest/governance readiness: ${report.ready ? 'READY' : 'BLOCKED'}\n`,
  );
  process.stdout.write(`  schema mode: ${report.schema_mode}\n`);
  process.stdout.write(
    `  care-pathway governance mode: ${report.care_pathway_governance_schema_mode}\n`,
  );
  process.stdout.write(
    `  clone-rehearsal input ready: ${report.clone_rehearsal_input_ready ? 'yes' : 'no'}\n`,
  );
  process.stdout.write(
    `  lab-ingest cutover ready: ${report.lab_ingest_cutover_ready ? 'yes' : 'no'}\n`,
  );
  process.stdout.write(
    `  care-pathway production activation ready: ${report.care_pathway_production_activation_ready ? 'yes' : 'no'} (requires S1b-c)\n`,
  );
  process.stdout.write(`  tenants scanned: ${report.tenants_scanned}\n`);
  process.stdout.write(
    `  historical lab ACK-contract violations: ${report.global_blockers.historical_lab_ack_contract_violations.count}\n`,
  );
  process.stdout.write(`  blocking findings: ${report.blocking_finding_count}\n`);
  process.stdout.write(
    `  structurally eligible legacy ORU groups: ${report.structurally_eligible_oru_message_group_count}\n`,
  );
  process.stdout.write(
    `  ASTM clone-rehearsal candidates: ${report.astm_adoption_clone_rehearsal_candidate_count}\n`,
  );
  process.stdout.write(
    `  exact pending migration set: ${report.migration_state.exact_pending_set ? 'yes' : 'no'}\n`,
  );
  for (const name of CUTOVER_MIGRATIONS) {
    const artifact = report.frozen_cutover_migration_artifacts[name];
    process.stdout.write(
      `  frozen ${name}: ${artifact.bytes} bytes / ${artifact.sha256}\n`,
    );
  }
  for (const tenant of report.tenants) {
    process.stdout.write(
      `  tenant ${tenant.tenant_id}: ${tenant.ready ? 'ready' : 'blocked'} `
        + `(${tenant.blocking_finding_count} finding(s))\n`,
    );
    for (const key of report.blocker_section_keys) {
      process.stdout.write(`    ${key}: ${tenant.blockers[key].count}\n`);
    }
  }
  process.stdout.write(
    '  Pre-schema READY permits rehearsal only; activation requires the exact fresh-clone tail through migration 584 and a READY post-schema report.\n',
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  assertOperationalSafety(options);
  const migrationFileNames = await resolveReleaseMigrationFiles();
  const migrationArtifacts = await verifyFrozenCutoverMigrationFiles();

  const client = new Client({
    connectionString: resolveConnectionString(process.env),
    application_name: 'lab-ingest-582-584-readiness-audit',
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
  });
  try {
    await client.connect();
    const report = await collectLabOruReplayReadiness({
      client,
      migrationFileNames,
      migrationArtifacts,
      sampleLimit: options.sampleLimit,
    });
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else writeTextReport(report);
    return auditExitCode(report);
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main()
    .then(exitCode => {
      process.exitCode = exitCode;
    })
    .catch(error => {
      process.stderr.write(`[lab-ingest-582-584-readiness] fatal: ${error.message}\n`);
      process.exitCode = 1;
    });
}
