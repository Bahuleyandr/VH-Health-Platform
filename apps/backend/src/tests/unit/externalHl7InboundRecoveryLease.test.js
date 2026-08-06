import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const PATIENT_UID = '22222222-2222-4222-8222-222222222222';
const OFFSET_ID = '33333333-3333-4333-8333-333333333333';
const INBOX_ID = '44444444-4444-4444-8444-444444444444';
const CREDENTIAL_ID = '42';
const FACILITY = 'I03-LEASE-RECV';
const STOP_AFTER_LEASE_CAPTURE = new Error('stop after lease capture');

const enqueueExternalRecoveryItem = jest.fn(async () => ({
  duplicate: false,
  inbox_id: INBOX_ID,
  status: 'pending',
}));
const processNextItemTx = jest.fn(async () => {
  throw STOP_AFTER_LEASE_CAPTURE;
});
const canonicalCommandFingerprint = value => createHash('sha256')
  .update(JSON.stringify(value))
  .digest('hex');

const offset = Object.freeze({
  offset_id: OFFSET_ID,
  facility_scope: 'tenant',
  facility_id: null,
  interface_family: 'I03',
  direction: 'inbound',
  consumer_key: 'external:I03',
  cursor_kind: 'monotonic_position_and_predecessor',
  source_partition: `i03/credential/${CREDENTIAL_ID}/family/adt`,
  generation: 1,
  high_water_position: '10',
  high_water_token: 'a'.repeat(64),
  recovery_state: 'replaying',
  policy_version: 'i03-lease-test-v1',
  policy_signature: 'i03-lease-test-signature',
  retention_policy: 'i03-lease-test-retention',
  retention_until: '2028-08-06T00:00:00.000Z',
});

const setTenantTx = jest.fn(async (_tenantId, callback) => callback({
  $queryRawUnsafe: jest.fn(async (sql) => {
    if (String(sql).includes('FROM event_consumer_offsets')) return [offset];
    throw new Error(`Unexpected I03 lease test query: ${String(sql).slice(0, 80)}`);
  }),
}));

const actualPrismaModule = await import('../../lib/prisma.js');
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  ...actualPrismaModule,
  setTenantTx,
}));
jest.unstable_mockModule(
  '../../services/integrations/externalInterfaceRecoveryService.js',
  () => ({
    canonicalCommandFingerprint,
    enqueueExternalRecoveryItem,
    processNextItemTx,
    quarantineI03RecoveryEvidenceConflictTx: jest.fn(),
  }),
);

const {
  I03_RECOVERY_SCHEMA,
  i03DuplicateKey,
  i03SourceToken,
  sha256Utf8,
  submitHl7InboundRecovery,
} = await import('../../services/integrations/externalHl7InboundRecoveryService.js');

function fixture() {
  const controlId = 'I03-LEASE-1';
  const occurrence = '20260806103045+0530';
  const message = [
    `MSH|^~\\&|EXT|SRC|VH|${FACILITY}|${occurrence}||ADT^A01|${controlId}|P|2.5|1042`,
    `EVN|A01|${occurrence}`,
    `PID|1||${PATIENT_UID}`,
    'PV1|1|I|WARD-3',
  ].join('\r');
  const sourcePartition = offset.source_partition;
  const predecessorToken = offset.high_water_token;
  const sourcePosition = '11';
  const messageSha256 = sha256Utf8(message);
  const duplicateKey = i03DuplicateKey({
    tenantId: TENANT_ID,
    signingCredentialId: CREDENTIAL_ID,
    messageFamily: 'adt',
    messageType: 'ADT',
    triggerEvent: 'A01',
    messageControlId: controlId,
  });
  const recovery = {
    schema: I03_RECOVERY_SCHEMA,
    interface_family: 'I03',
    arrival_class: 'recovery_backlog',
    tenant_id: TENANT_ID,
    signing_credential_id: CREDENTIAL_ID,
    offset_id: OFFSET_ID,
    source_partition: sourcePartition,
    generation: 1,
    source_position: sourcePosition,
    source_token: i03SourceToken({
      tenantId: TENANT_ID,
      sourcePartition,
      generation: 1,
      sourcePosition,
      predecessorToken,
      duplicateKey,
      messageSha256,
    }),
    predecessor_token: predecessorToken,
    duplicate_key: duplicateKey,
    message_family: 'adt',
    message_type: 'ADT',
    trigger_event: 'A01',
    message_control_id: controlId,
    message_sha256: messageSha256,
    source_observed_at: '2026-08-06T10:30:45+05:30',
    source_received_at: '2026-08-06T10:30:45.500+05:30',
    clock_evidence: {
      source_clock_id: 'i03-lease-clock',
      synchronized_at: '2026-08-06T10:29:00+05:30',
      maximum_error_ms: 1000,
    },
  };
  return { message, recovery };
}

describe('I03 recovery lease authority', () => {
  test('mints a server UUID for the worker and exposes no sender lease input', async () => {
    const { message, recovery } = fixture();
    expect(Object.hasOwn(recovery, 'lease_owner')).toBe(false);

    await expect(submitHl7InboundRecovery({
      message,
      recovery,
      credentialSnapshot: Object.freeze({
        id: CREDENTIAL_ID,
        tenant_id: TENANT_ID,
        kind: 'hl7_inbound',
        sender_identifier: FACILITY,
        status: 'active',
        secret: 'not-used-by-the-canonical-service',
      }),
    })).rejects.toBe(STOP_AFTER_LEASE_CAPTURE);

    expect(processNextItemTx).toHaveBeenCalledTimes(1);
    const workerInput = processNextItemTx.mock.calls[0][0];
    expect(workerInput.leaseOwner).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(JSON.stringify(recovery)).not.toContain(workerInput.leaseOwner);
    expect(workerInput.command).toEqual({ message, recovery });
  });
});
