import { createHash, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';

import { Client } from 'pg';

import prisma from '../lib/prisma.js';
import {
  authorizeExternalRecoveryOperabilityResume,
  listExternalRecoveryOperabilityWorkbench,
  registerExternalRecoveryOperabilityOffset,
} from '../services/downtime/externalRecoveryOperabilityService.js';
import {
  EXTERNAL_RECOVERY_OPERABILITY_SCHEMA,
  parseExternalRecoveryRegister,
  parseExternalRecoveryResume,
} from '../validators/externalRecoveryOperabilitySchemas.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = randomUUID();
const OTHER_TENANT_ID = randomUUID();
const ACTOR_UID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);
const RETENTION_UNTIL = '2033-08-05T00:00:00.000Z';

function ownerDatabaseUrl(value) {
  if (!value) return value;
  const url = new URL(value);
  if (url.hostname === '127.0.0.1' && url.port === '55432') {
    url.username = 'postgres';
    url.password = '';
  }
  return url.toString();
}

function registration(partition, overrides = {}) {
  return parseExternalRecoveryRegister({
    interface_family: 'I01',
    source_partition: partition,
    generation: 1,
    initial_position: '10',
    initial_token: `token-10-${partition}`,
    retained_from_position: '1',
    retained_from_token: `token-1-${partition}`,
    policy_version: 'c-d8-v1',
    policy_signature: `policy-${partition}`,
    retention_policy: 'clinical-lab-730d',
    retention_until: RETENTION_UNTIL,
    owner_evidence_reference: `owner:${partition}`,
    owner_evidence_signature: `owner-signature:${partition}`,
    reason_code: 'initial_marker_reconciled',
    reason_detail: 'The owner verified this exact retained marker and source partition.',
    ...overrides,
  });
}

function register(partition, {
  idempotencyKey = `register-${partition.replaceAll('/', '-')}`,
  parsed,
} = {}) {
  return registerExternalRecoveryOperabilityOffset({
    tenantId: TENANT_ID,
    actorUid: ACTOR_UID,
    actorRole: 'ADMIN',
    requestId: `request-${idempotencyKey}`,
    idempotencyKey,
    parsed: parsed || registration(partition),
  });
}

async function resumeInput(offsetId, partition) {
  const workbench = await listExternalRecoveryOperabilityWorkbench({
    tenantId: TENANT_ID,
    actorUid: ACTOR_UID,
    actorRole: 'ADMIN',
    filters: { interfaceFamily: 'I01' },
  });
  const offset = workbench.offsets.find(item => item.offset_id === offsetId);
  expect(offset).toBeDefined();
  return parseExternalRecoveryResume({
    expected_state_fingerprint: offset.state_fingerprint,
    resume_cutoff_position: '11',
    resume_cutoff_token: `token-11-${partition}`,
    owner_evidence_reference: `resume-owner:${partition}`,
    owner_evidence_signature: `resume-signature:${partition}`,
    reason_code: 'resume_cutoff_reconciled',
    reason_detail: 'The owner verified this exact cutoff marker and retained source count.',
  });
}

function resume(offsetId, partition, parsed, idempotencyKey = `resume-${partition}`) {
  return authorizeExternalRecoveryOperabilityResume({
    tenantId: TENANT_ID,
    actorUid: ACTOR_UID,
    actorRole: 'ADMIN',
    requestId: `request-${idempotencyKey}`,
    idempotencyKey,
    offsetId,
    parsed,
  });
}

async function expectFailure(client, operation, expectedCodes) {
  await client.query('SAVEPOINT expected_external_recovery_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_external_recovery_failure');
  await client.query('RELEASE SAVEPOINT expected_external_recovery_failure');
  expect(failure).toBeDefined();
  expect(expectedCodes).toContain(failure.code);
  return failure;
}

describeIfDb('migration 628 external-recovery operability authority', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'C6.1 external-recovery operability tenant'),
              ($3::uuid, $4::text, 'C6.1 external-recovery other tenant')`,
      TENANT_ID,
      `c61-operability-${SUFFIX}`,
      OTHER_TENANT_ID,
      `c61-operability-other-${SUFFIX}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, email, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $2::uuid, $3::text, $4::text,
          'C6.1 external-recovery administrator', 'ADMIN', TRUE, 'active', NOW())`,
      ACTOR_UID,
      TENANT_ID,
      `97${SUFFIX.slice(0, 10)}`,
      `c61-operability-${SUFFIX}@example.test`,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('occupies only migration slot 628 and forces RLS on every evidence table', async () => {
    const migrations = readdirSync(new URL('../migrations/', import.meta.url))
      .filter(name => /^628_.*\.sql$/.test(name));
    expect(migrations).toEqual(['628_external_recovery_operability.sql']);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname IN (
          'external_recovery_operability_actions',
          'external_recovery_critical_review_obligations',
          'external_recovery_critical_review_acknowledgements'
        )
        ORDER BY relname`,
    );
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });

  test('exact registration retries do not append a second offset, action, or audit', async () => {
    const partition = `i01/exact/${SUFFIX}`;
    const parsed = registration(partition);
    const first = await register(partition, { idempotencyKey: `exact-a-${SUFFIX}`, parsed });
    const duplicate = await register(partition, { idempotencyKey: `exact-b-${SUFFIX}`, parsed });
    expect(first).toMatchObject({ disposition: 'applied', recovery_state: 'paused' });
    expect(duplicate).toMatchObject({
      disposition: 'exact_duplicate',
      action_id: first.action_id,
      offset_id: first.offset_id,
    });
    const counts = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::integer FROM event_consumer_offsets
           WHERE tenant_id = $1::uuid AND source_partition = $2::text) AS offsets,
         (SELECT COUNT(*)::integer FROM external_recovery_operability_actions
           WHERE tenant_id = $1::uuid AND offset_id = $3::uuid
             AND action = 'register_offset' AND outcome = 'applied') AS actions,
         (SELECT COUNT(*)::integer FROM clinical_audit_events
           WHERE tenant_id = $1::uuid
             AND resource_type = 'external_recovery_operability_action'
             AND resource_id = $4::text) AS audits`,
      TENANT_ID,
      partition,
      first.offset_id,
      first.action_id,
    );
    expect(counts[0]).toEqual({ offsets: 1, actions: 1, audits: 1 });

    const drifted = registration(partition, {
      reason_detail: 'The owner supplied a different reason for the already claimed effect.',
    });
    await expect(register(partition, {
      idempotencyKey: `exact-a-${SUFFIX}`,
      parsed: drifted,
    })).rejects.toMatchObject({ code: 'EXTERNAL_RECOVERY_OPERABILITY_IDEMPOTENCY_DRIFT' });
    const audits = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS count
         FROM clinical_audit_events
        WHERE tenant_id = $1::uuid
          AND resource_type = 'external_recovery_operability_action'
          AND resource_id = $2::text`,
      TENANT_ID,
      first.action_id,
    );
    expect(audits[0].count).toBe(1);
  });

  test('I25 registration derives capture and target cursor classes from exact partitions', async () => {
    const capturePartition = 'siem:audit_log:security:capture';
    const targetPartition = `siem:audit_log:security:target:${Number.parseInt(SUFFIX.slice(0, 6), 16) + 1}`;
    const capture = await register(capturePartition, {
      idempotencyKey: `i25-capture-${SUFFIX}`,
      parsed: registration(capturePartition, { interface_family: 'I25' }),
    });
    const target = await register(targetPartition, {
      idempotencyKey: `i25-target-${SUFFIX}`,
      parsed: registration(targetPartition, { interface_family: 'I25' }),
    });

    const offsets = await prisma.$queryRawUnsafe(
      `SELECT offset_id, direction, source_partition, cursor_kind
         FROM event_consumer_offsets
        WHERE tenant_id = $1::uuid
          AND offset_id IN ($2::uuid, $3::uuid)
        ORDER BY source_partition`,
      TENANT_ID,
      capture.offset_id,
      target.offset_id,
    );
    expect(offsets).toEqual([
      {
        offset_id: capture.offset_id,
        direction: 'outbound',
        source_partition: capturePartition,
        cursor_kind: 'capture_into_event_ledger',
      },
      {
        offset_id: target.offset_id,
        direction: 'outbound',
        source_partition: targetPartition,
        cursor_kind: 'per_target_positive_ack',
      },
    ]);
  });

  test('concurrent exact registration and resume converge on one applied receipt', async () => {
    const partition = `i01/concurrent/${SUFFIX}`;
    const parsed = registration(partition);
    const registrations = await Promise.all([
      register(partition, { idempotencyKey: `concurrent-register-${SUFFIX}`, parsed }),
      register(partition, { idempotencyKey: `concurrent-register-${SUFFIX}`, parsed }),
    ]);
    expect(registrations.map(row => row.disposition).sort())
      .toEqual(['applied', 'exact_duplicate']);
    expect(new Set(registrations.map(row => row.action_id)).size).toBe(1);
    expect(new Set(registrations.map(row => row.offset_id)).size).toBe(1);

    const offsetId = registrations[0].offset_id;
    const parsedResume = await resumeInput(offsetId, partition);
    const resumes = await Promise.all([
      resume(offsetId, partition, parsedResume, `concurrent-resume-${SUFFIX}`),
      resume(offsetId, partition, parsedResume, `concurrent-resume-${SUFFIX}`),
    ]);
    expect(resumes.map(row => row.disposition).sort())
      .toEqual(['applied', 'exact_duplicate']);
    expect(new Set(resumes.map(row => row.action_id)).size).toBe(1);
    const evidence = await prisma.$queryRawUnsafe(
      `SELECT target_offset.recovery_state,
              COUNT(action.id)::integer AS applied_actions,
              COUNT(DISTINCT audit.id)::integer AS audits
         FROM event_consumer_offsets AS target_offset
         JOIN external_recovery_operability_actions AS action
           ON action.tenant_id = target_offset.tenant_id
          AND action.offset_id = target_offset.offset_id
           AND action.outcome = 'applied'
         LEFT JOIN clinical_audit_events AS audit
           ON audit.tenant_id = action.tenant_id
          AND audit.resource_id = action.id::text
        WHERE target_offset.tenant_id = $1::uuid
          AND target_offset.offset_id = $2::uuid
        GROUP BY target_offset.recovery_state`,
      TENANT_ID,
      offsetId,
    );
    expect(evidence[0]).toEqual({
      recovery_state: 'replaying',
      applied_actions: 2,
      audits: 2,
    });
  }, 30_000);

  test('a privileged application role cannot forge registration or resume with raw SQL', async () => {
    const partition = `i01/raw-pg/${SUFFIX}`;
    const registered = await register(partition);
    const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
    await client.connect();
    try {
      const availableRole = await client.query(
        `SELECT CASE
           WHEN to_regrole('vhhealth_runtime') IS NOT NULL THEN 'vhhealth_runtime'
           WHEN to_regrole('vhhealth_app') IS NOT NULL THEN 'vhhealth_app'
         END AS role_name`,
      );
      const roleName = availableRole.rows[0].role_name;
      expect(['vhhealth_app', 'vhhealth_runtime']).toContain(roleName);
      const privileges = await client.query(
        `SELECT table_name,
                has_table_privilege($1::text, 'public.' || table_name, 'SELECT') AS can_select,
                has_table_privilege($1::text, 'public.' || table_name, 'INSERT') AS can_insert,
                has_table_privilege($1::text, 'public.' || table_name, 'UPDATE') AS can_update,
                has_table_privilege($1::text, 'public.' || table_name, 'DELETE') AS can_delete,
                has_table_privilege($1::text, 'public.' || table_name, 'TRUNCATE') AS can_truncate
           FROM (VALUES
             ('external_recovery_operability_actions'),
             ('external_recovery_critical_review_obligations'),
             ('external_recovery_critical_review_acknowledgements')
           ) AS evidence(table_name)
          ORDER BY table_name`,
        [roleName],
      );
      expect(privileges.rows).toHaveLength(3);
      for (const row of privileges.rows) {
        expect(row).toMatchObject({
          can_select: true,
          can_insert: false,
          can_update: false,
          can_delete: false,
          can_truncate: false,
        });
      }
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${roleName}`);
      await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [TENANT_ID]);

      const forgedPartition = `i01/forged-function/${SUFFIX}`;
      const ownerSignature = `forged-owner-signature:${SUFFIX}`;
      const policySignature = `forged-policy-signature:${SUFFIX}`;
      const digest = value => createHash('sha256').update(value).digest('hex');
      await expectFailure(client, () => client.query(
        'SELECT public.external_recovery_operability_register_offset($1::jsonb)',
        [JSON.stringify({
          action: 'register_offset',
          action_id: randomUUID(),
          offset_id: randomUUID(),
          tenant_id: TENANT_ID,
          actor_uid: ACTOR_UID,
          actor_role: 'ADMIN',
          interface_family: 'I01',
          facility_scope: 'tenant',
          facility_id: null,
          subpath: null,
          protocol: null,
          direction: 'inbound',
          source_partition: forgedPartition,
          generation: 1,
          command_class: 'register_paused_offset',
          initial_position: '10',
          initial_token: 'forged-token-10',
          retained_from_position: '1',
          retained_from_token: 'forged-token-1',
          action_version: 1,
          binding_version: 1,
          schema_id: EXTERNAL_RECOVERY_OPERABILITY_SCHEMA.id,
          schema_version: EXTERNAL_RECOVERY_OPERABILITY_SCHEMA.version,
          schema_checksum: EXTERNAL_RECOVERY_OPERABILITY_SCHEMA.checksum,
          effect_identity: '0'.repeat(64),
          command_fingerprint: '1'.repeat(64),
          idempotency_key_sha256: digest(`forged-key:${SUFFIX}`),
          reason_code: 'initial_marker_reconciled',
          reason_detail: 'A raw database caller supplied syntactically valid but forged hashes.',
          owner_evidence_reference: `forged-owner:${SUFFIX}`,
          owner_evidence_signature: ownerSignature,
          owner_evidence_signature_sha256: digest(ownerSignature),
          policy_version: 'c-d8-v1',
          policy_signature: policySignature,
          policy_signature_sha256: digest(policySignature),
          retention_policy: 'clinical-lab-730d',
          retention_until: RETENTION_UNTIL,
          audit_event_id: randomUUID(),
        })],
      ), ['23514']);

      await expectFailure(client, () => client.query(
        `INSERT INTO event_consumer_offsets
           (offset_id, scope_kind, tenant_id, facility_scope, interface_family,
            direction, source_partition, consumer_key, generation, cursor_kind,
            high_water_position, high_water_token, recovery_state,
            policy_version, policy_signature, retention_policy, retention_until)
         VALUES ($1::uuid, 'external_interface', $2::uuid, 'tenant', 'I01',
                 'inbound', $3::text, 'external:I01', 1,
                 'monotonic_position_and_predecessor', 10, 'forged-token', 'paused',
                 'c-d8-v1', 'forged', 'clinical-lab-730d', $4::timestamptz)`,
        [randomUUID(), TENANT_ID, `i01/forged/${SUFFIX}`, RETENTION_UNTIL],
      ), ['42501']);

      await client.query(
        "SELECT set_config('app.external_recovery_operability_action_id', $1::text, true)",
        [registered.action_id],
      );
      await expectFailure(client, () => client.query(
        `UPDATE event_consumer_offsets
            SET recovery_state = 'replaying', resume_cutoff_position = 11,
                resume_cutoff_token = 'forged-resume'
          WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
        [TENANT_ID, registered.offset_id],
      ), ['42501']);

      await expectFailure(client, () => client.query(
        `INSERT INTO external_recovery_operability_actions
           (id, tenant_id, action, outcome, actor_uid, actor_role, receipt)
         VALUES ($1::uuid, $2::uuid, 'authorize_resume', 'refused_scope',
                 $3::uuid, 'ADMIN', '{}'::jsonb)`,
        [randomUUID(), TENANT_ID, ACTOR_UID],
      ), ['42501']);
      await expectFailure(client, () => client.query(
        'INSERT INTO external_recovery_critical_review_obligations DEFAULT VALUES',
      ), ['42501']);
      await expectFailure(client, () => client.query(
        'INSERT INTO external_recovery_critical_review_acknowledgements DEFAULT VALUES',
      ), ['42501']);
      await expectFailure(client, () => client.query(
        `UPDATE external_recovery_operability_actions SET receipt = '{}'::jsonb
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [TENANT_ID, registered.action_id],
      ), ['42501']);
      await expectFailure(client, () => client.query(
        `TRUNCATE external_recovery_operability_actions,
                  external_recovery_critical_review_obligations,
                  external_recovery_critical_review_acknowledgements`,
      ), ['42501']);

      await client.query(
        "SELECT set_config('app.current_tenant_id', $1::text, true)",
        [OTHER_TENANT_ID],
      );
      const hidden = await client.query(
        `SELECT COUNT(*)::integer AS count
           FROM external_recovery_operability_actions
          WHERE id = $1::uuid`,
        [registered.action_id],
      );
      expect(hidden.rows[0].count).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.query('RESET ROLE').catch(() => {});
      await client.end();
    }

    const state = await prisma.$queryRawUnsafe(
      `SELECT recovery_state, resume_cutoff_position, resume_cutoff_token
         FROM event_consumer_offsets
        WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
      TENANT_ID,
      registered.offset_id,
    );
    expect(state[0]).toEqual({
      recovery_state: 'paused',
      resume_cutoff_position: null,
      resume_cutoff_token: null,
    });
  });
});
