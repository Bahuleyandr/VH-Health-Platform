import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const fault = { step: null };
const actualPrismaModule = await import('../lib/prisma.js');
const actualFieldEncryption = await import('../utils/fieldEncryption.js');

function ownerDatabaseUrl(value) {
  const url = new URL(value);
  if (url.hostname === '127.0.0.1' && url.port === '55432') {
    url.username = 'postgres';
    url.password = '';
  }
  return url.toString();
}

function faultingTx(tx) {
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property === '$queryRawUnsafe' || property === '$executeRawUnsafe') {
        return async (sql, ...params) => {
          const statement = String(sql).replace(/\s+/g, ' ').trim();
          if (fault.step === 'task' && /INSERT INTO tasks\b/i.test(statement)) {
            throw new Error('injected I03 task persistence failure');
          }
          if (fault.step === 'receipt' && /INSERT INTO hl7_inbound_recovery_receipts\b/i.test(statement)) {
            throw new Error('injected I03 receipt persistence failure');
          }
          if (fault.step === 'terminal'
            && /UPDATE pathway_projector_inbox SET status = 'handled'/i.test(statement)) {
            throw new Error('injected I03 terminal persistence failure');
          }
          if (fault.step === 'cursor'
            && /UPDATE event_consumer_offsets SET high_water_position/i.test(statement)) {
            throw new Error('injected I03 cursor persistence failure');
          }
          if (fault.step === 'quarantine'
            && /UPDATE event_consumer_offsets SET recovery_state = 'reconciliation_required_source_gap'/i.test(statement)) {
            throw new Error('injected I03 quarantine transition failure');
          }
          return target[property](sql, ...params);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

jest.unstable_mockModule('../lib/prisma.js', () => ({
  ...actualPrismaModule,
  setTenantTx: (tenantId, callback, options) => actualPrismaModule.setTenantTx(
    tenantId,
    tx => callback(faultingTx(tx)),
    options,
  ),
}));

jest.unstable_mockModule('../utils/fieldEncryption.js', () => ({
  ...actualFieldEncryption,
  encryptField: (plaintext, options) => {
    if (fault.step === 'ack' && String(plaintext).includes('MSA|AA|')) {
      throw new Error('injected I03 ACK encryption failure');
    }
    return actualFieldEncryption.encryptField(plaintext, options);
  },
}));

const prismaModule = await import('../lib/prisma.js');
const prisma = prismaModule.default;
const { setTenantTx } = prismaModule;
const {
  I03_RECOVERY_SCHEMA,
  enqueueHl7InboundRecovery,
  i03DuplicateKey,
  i03SourceToken,
  sha256Utf8,
  submitHl7InboundRecovery,
} = await import('../services/integrations/externalHl7InboundRecoveryService.js');
const { processNextItemTx } = await import('../services/integrations/externalInterfaceRecoveryService.js');
const {
  resolveInteropCredentialSnapshot,
  upsertInteropSecret,
} = await import('../services/interop/tenantInteropSecretService.js');
const {
  activeTenantKeyId,
  cryptoShredTenant,
  provisionTenantKek,
  resetTenantKekCacheForTesting,
  tenantKeyId,
} = await import('../services/security/tenantKekProvider.js');
const { getKekProvider } = await import('../utils/fieldKeyProvider.js');
const {
  authorizeExternalRecoveryResume,
  registerExternalRecoveryOffset,
} = await import('./helpers/externalRecoveryOperabilityTestHelper.js');

const TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);
const FACILITY = `I03-ATOMIC-${SUFFIX}`;
const SECRET = `i03-atomic-secret-${SUFFIX}`;
const INITIAL_TOKEN = sha256Utf8(`i03-atomic-${SUFFIX}-10`);

let credential;
let offset;
let message;
let recovery;
let prepared;

function operation() {
  return {
    tenantId: TENANT_ID,
    offsetId: offset.offset_id,
    interfaceFamily: 'I03',
    sourcePartition: recovery.source_partition,
    generation: recovery.generation,
    sourcePosition: recovery.source_position,
    sourceToken: recovery.source_token,
    predecessorToken: recovery.predecessor_token,
    duplicateKey: recovery.duplicate_key,
    command: prepared.command,
    commandFingerprint: prepared.messageSha256,
    leaseOwner: randomUUID(),
  };
}

// Put the tenant back on a known-good KEK using only the sanctioned path: retire
// every existing version through the crypto-shred, then provision the NEXT
// version. Key material is never overwritten in place and no key id is ever
// reused (migration 672 refuses both at the database).
async function replaceTenantKekFixture() {
  resetTenantKekCacheForTesting();
  await cryptoShredTenant(TENANT_ID);
  await provisionTenantKek(TENANT_ID);
}

// Land the tenant's CURRENT KEK in a state where the row is present and active
// but its material cannot be unwrapped (e.g. wrapped under a master KEK this
// process does not hold). That is a new version, not an edit of the live one.
async function stampUnwrappableTenantKekVersion() {
  const [row] = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(MAX((substring(key_id from '^t:.+:v([0-9]+)$'))::int), 0) + 1 AS next_version
       FROM encryption_keys
      WHERE tenant_id = $1::uuid
        AND key_id ~ ('^t:' || tenant_id::text || ':v[0-9]+$')`,
    TENANT_ID,
  );
  const nextVersion = Number(row.next_version);
  const keyId = tenantKeyId(TENANT_ID, nextVersion);
  await prisma.$executeRawUnsafe(
    `INSERT INTO encryption_keys
       (tenant_id, key_id, provider, algorithm, status, wrapped_key_material,
        activated_at, created_at, updated_at)
     VALUES ($1::uuid, $2::text, 'local-tenant', 'aes-256-gcm', 'active',
             'not-a-valid-wrapped-kek', NOW(), NOW(), NOW())`,
    TENANT_ID,
    keyId,
  );
  resetTenantKekCacheForTesting();
  for (let version = 1; version <= nextVersion; version += 1) {
    getKekProvider().evictKek(tenantKeyId(TENANT_ID, version));
  }
  return keyId;
}

async function atomicState() {
  const rows = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
    `SELECT
       (SELECT COUNT(*)::integer FROM hl7_inbound_recovery_receipts
         WHERE tenant_id = $1::uuid) AS receipts,
       (SELECT COUNT(*)::integer FROM tasks
         WHERE tenant_id = $1::uuid
           AND related_resource_type = 'hl7_inbound_recovery_receipt') AS tasks,
       i.status, i.attempts, i.lease_owner::text, i.pending_task_id,
       o.high_water_position::text, o.high_water_token, o.recovery_state
      FROM pathway_projector_inbox i
      JOIN event_consumer_offsets o
        ON o.tenant_id = i.tenant_id AND o.offset_id = i.offset_id
     WHERE i.tenant_id = $1::uuid
       AND i.scope_kind = 'external_interface'
       AND i.interface_family = 'I03'
       AND i.source_partition = $2::text`,
    TENANT_ID,
    recovery.source_partition,
  ));
  return rows[0];
}

describeIfDb('I03 receipt/task/ACK/terminal/cursor atomicity', () => {
  beforeAll(async () => {
    fault.step = null;
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'I03 atomicity tenant')`,
      TENANT_ID,
      `i03-atomic-${SUFFIX}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::text, 'I03 atomic patient',
               'PATIENT', TRUE, 'active', NOW())`,
      PATIENT_UID,
      TENANT_ID,
      `90${SUFFIX.slice(0, 10)}`,
    );
    await replaceTenantKekFixture();
    await upsertInteropSecret({
      tenantId: TENANT_ID,
      kind: 'hl7_inbound',
      senderIdentifier: FACILITY,
      secret: SECRET,
    });
    credential = await resolveInteropCredentialSnapshot('hl7_inbound', FACILITY);
    const sourcePartition = `i03/credential/${credential.id}/family/adt`;
    offset = await registerExternalRecoveryOffset({
      tenantId: TENANT_ID,
      interfaceFamily: 'I03',
      sourcePartition,
      initialPosition: '10',
      initialToken: INITIAL_TOKEN,
      retainedFromPosition: '10',
      retainedFromToken: INITIAL_TOKEN,
      policyVersion: 'c6-1-i03-atomic-v1',
      policySignature: `i03-atomic-signature-${SUFFIX}`,
      retentionPolicy: 'hl7-clinical-recovery-730d',
      retentionUntil: '2029-08-06T00:00:00.000Z',
    });
    const controlId = `I03-ATOMIC-${SUFFIX}`;
    const occurrence = '20260806103045.123456+0530';
    message = [
      `MSH|^~\\&|EXT|SRC|VH|${FACILITY}|${occurrence}||ADT^A01|${controlId}|P|2.5|1042`,
      `EVN|A01|${occurrence}`,
      `PID|1||${PATIENT_UID}`,
      'PV1|1|I|WARD-3',
    ].join('\r');
    const messageSha256 = sha256Utf8(message);
    const duplicateKey = i03DuplicateKey({
      tenantId: TENANT_ID,
      signingCredentialId: credential.id,
      messageFamily: 'adt',
      messageType: 'ADT',
      triggerEvent: 'A01',
      messageControlId: controlId,
    });
    recovery = {
      schema: I03_RECOVERY_SCHEMA,
      interface_family: 'I03',
      arrival_class: 'recovery_backlog',
      tenant_id: TENANT_ID,
      signing_credential_id: credential.id,
      offset_id: offset.offset_id,
      source_partition: sourcePartition,
      generation: 1,
      source_position: '11',
      source_token: '',
      predecessor_token: INITIAL_TOKEN,
      duplicate_key: duplicateKey,
      message_family: 'adt',
      message_type: 'ADT',
      trigger_event: 'A01',
      message_control_id: controlId,
      message_sha256: messageSha256,
      source_observed_at: '2026-08-06T10:30:45.123456+05:30',
      source_received_at: '2026-08-06T10:30:45.123999+05:30',
      clock_evidence: {
        source_clock_id: `i03-atomic-${SUFFIX}`,
        synchronized_at: '2026-08-06T10:29:00+05:30',
        maximum_error_ms: 1000,
      },
    };
    recovery.source_token = i03SourceToken({
      tenantId: TENANT_ID,
      sourcePartition,
      generation: 1,
      sourcePosition: '11',
      predecessorToken: INITIAL_TOKEN,
      duplicateKey,
      messageSha256,
    });
    await authorizeExternalRecoveryResume({
      tenantId: TENANT_ID,
      offsetId: offset.offset_id,
      interfaceFamily: 'I03',
      resumeCutoffPosition: '11',
      resumeCutoffToken: recovery.source_token,
    });
    ({ prepared } = await enqueueHl7InboundRecovery({
      message,
      recovery,
      credentialSnapshot: credential,
    }));
  }, 60_000);

  afterAll(async () => {
    fault.step = null;
    const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL session_replication_role = 'replica'`);
      for (const sql of [
        `DELETE FROM hl7_inbound_recovery_receipts WHERE tenant_id = $1::uuid`,
        `DELETE FROM tasks WHERE tenant_id = $1::uuid`,
        `DELETE FROM pathway_projector_inbox WHERE tenant_id = $1::uuid`,
        `DELETE FROM event_consumer_offsets WHERE tenant_id = $1::uuid`,
        `DELETE FROM external_recovery_operability_actions WHERE tenant_id = $1::uuid`,
        `DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid`,
        `DELETE FROM tenant_interop_secrets WHERE tenant_id = $1::uuid`,
        `DELETE FROM encryption_keys WHERE tenant_id = $1::uuid`,
        `DELETE FROM users WHERE tenant_id = $1::uuid`,
        `DELETE FROM tenants WHERE id = $1::uuid`,
      ]) {
        await client.query(sql, [TENANT_ID]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await client.end();
    }
    await prisma.$disconnect().catch(() => {});
  }, 60_000);

  test('rolls back claim, review work, receipt, and cursor when the tenant KEK is missing', async () => {
    fault.step = null;
    await cryptoShredTenant(TENANT_ID);
    await expect(processNextItemTx(operation())).rejects.toMatchObject({
      code: 'HL7_I03_RECOVERY_TENANT_KEK_REQUIRED',
      statusCode: 500,
    });
    expect(await atomicState()).toEqual({
      receipts: 0,
      tasks: 0,
      status: 'pending',
      attempts: 0,
      lease_owner: null,
      pending_task_id: null,
      high_water_position: '10',
      high_water_token: INITIAL_TOKEN,
      recovery_state: 'replaying',
    });
    await replaceTenantKekFixture();
  }, 60_000);

  test('rolls back the canonical transaction when the tenant KEK cannot be unwrapped', async () => {
    fault.step = null;
    await stampUnwrappableTenantKekVersion();
    await expect(processNextItemTx(operation())).rejects.toMatchObject({
      code: 'HL7_I03_RECOVERY_TENANT_KEK_REQUIRED',
      statusCode: 500,
    });
    expect(await atomicState()).toEqual({
      receipts: 0,
      tasks: 0,
      status: 'pending',
      attempts: 0,
      lease_owner: null,
      pending_task_id: null,
      high_water_position: '10',
      high_water_token: INITIAL_TOKEN,
      recovery_state: 'replaying',
    });
    await replaceTenantKekFixture();
  }, 60_000);

  test('does not partially quarantine an identity collision when the offset transition fails', async () => {
    const changedMessage = `${message}\rNTE|1||changed collision evidence`;
    const messageSha256 = sha256Utf8(changedMessage);
    const changedRecovery = {
      ...recovery,
      message_sha256: messageSha256,
      source_token: i03SourceToken({
        tenantId: TENANT_ID,
        sourcePartition: recovery.source_partition,
        generation: recovery.generation,
        sourcePosition: recovery.source_position,
        predecessorToken: recovery.predecessor_token,
        duplicateKey: recovery.duplicate_key,
        messageSha256,
      }),
    };
    fault.step = 'quarantine';
    await expect(enqueueHl7InboundRecovery({
      message: changedMessage,
      recovery: changedRecovery,
      credentialSnapshot: credential,
    })).rejects.toThrow('injected I03 quarantine transition failure');
    fault.step = null;
    expect(await atomicState()).toEqual({
      receipts: 0,
      tasks: 0,
      status: 'pending',
      attempts: 0,
      lease_owner: null,
      pending_task_id: null,
      high_water_position: '10',
      high_water_token: INITIAL_TOKEN,
      recovery_state: 'replaying',
    });
    const count = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS count
         FROM pathway_projector_inbox
        WHERE tenant_id = $1::uuid AND source_partition = $2::text`,
      TENANT_ID,
      recovery.source_partition,
    ));
    expect(count).toEqual([{ count: 1 }]);
  }, 60_000);

  test.each(['task', 'ack', 'receipt', 'terminal', 'cursor'])(
    'rolls back the complete canonical transaction when %s persistence fails',
    async (step) => {
      fault.step = step;
      await expect(processNextItemTx(operation())).rejects.toThrow(
        new RegExp(`injected I03 ${step}`, 'i'),
      );
      fault.step = null;
      expect(await atomicState()).toEqual({
        receipts: 0,
        tasks: 0,
        status: 'pending',
        attempts: 0,
        lease_owner: null,
        pending_task_id: null,
        high_water_position: '10',
        high_water_token: INITIAL_TOKEN,
        recovery_state: 'replaying',
      });
    },
    60_000,
  );

  test('retries Phase 1.5 atomically after its durable lease expires', async () => {
    const crashedOwner = randomUUID();
    await setTenantTx(TENANT_ID, tx => tx.$executeRawUnsafe(
      `UPDATE pathway_projector_inbox
          SET lease_owner = $3::uuid,
              lease_expires_at = NOW() - INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND source_partition = $2::text`,
      TENANT_ID,
      recovery.source_partition,
      crashedOwner,
    ));
    fault.step = 'receipt';
    await expect(submitHl7InboundRecovery({
      message,
      recovery,
      credentialSnapshot: credential,
    })).rejects.toThrow('injected I03 receipt persistence failure');
    fault.step = null;
    expect(await atomicState()).toEqual({
      receipts: 0,
      tasks: 0,
      status: 'pending',
      attempts: 0,
      lease_owner: expect.stringMatching(/^[0-9a-f-]{36}$/),
      pending_task_id: null,
      high_water_position: '10',
      high_water_token: INITIAL_TOKEN,
      recovery_state: 'replaying',
    });

    await setTenantTx(TENANT_ID, tx => tx.$executeRawUnsafe(
      `UPDATE pathway_projector_inbox
          SET lease_expires_at = NOW() - INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND source_partition = $2::text`,
      TENANT_ID,
      recovery.source_partition,
    ));
    const result = await submitHl7InboundRecovery({
      message,
      recovery,
      credentialSnapshot: credential,
    });
    const exactRetry = await submitHl7InboundRecovery({
      message,
      recovery,
      credentialSnapshot: credential,
    });
    expect(result).toMatchObject({
      httpStatus: 200,
      duplicate: true,
      receiptId: expect.stringMatching(/^[1-9][0-9]*$/),
    });
    expect(result.ack).toContain('MSA|AA');
    expect(exactRetry).toMatchObject({
      httpStatus: result.httpStatus,
      duplicate: true,
      receiptId: result.receiptId,
      ack: result.ack,
    });
    expect(await atomicState()).toEqual({
      receipts: 1,
      tasks: 1,
      status: 'handled',
      attempts: 1,
      lease_owner: null,
      pending_task_id: expect.any(Number),
      high_water_position: '11',
      high_water_token: recovery.source_token,
      recovery_state: 'ready',
    });
    const evidence = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT payload_ciphertext, ack_ciphertext
         FROM hl7_inbound_recovery_receipts
        WHERE tenant_id = $1::uuid AND source_partition = $2::text`,
      TENANT_ID,
      recovery.source_partition,
    ));
    expect(evidence).toHaveLength(1);
    // Wrapped under THIS tenant's KEK (never the global one) — at whichever
    // version the tenant currently holds, since a shredded tenant is
    // re-provisioned onto the next one.
    const currentTenantKeyId = await activeTenantKeyId(TENANT_ID);
    expect(currentTenantKeyId).toMatch(new RegExp(`^t:${TENANT_ID}:v\\d+$`));
    expect(actualFieldEncryption.getKeyId(evidence[0].payload_ciphertext))
      .toBe(currentTenantKeyId);
    expect(actualFieldEncryption.getKeyId(evidence[0].ack_ciphertext))
      .toBe(currentTenantKeyId);
  }, 60_000);

});
