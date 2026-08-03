import crypto from 'node:crypto';

import prisma from '../lib/prisma.js';
import { purgeInterfaceEngineTestData } from './helpers/interfaceEngineEvidenceCleanup.js';
import {
  activateChannelVersion,
  createChannel,
  createChannelVersion,
  createReplayBatch,
  createTransformTest,
  dispatchOutboundMessages,
  enqueueOutboundMessage,
  getMessage,
  listMessages,
  receiveHttpHl7Message,
  runTransformTest,
} from '../services/interfaceEngine/interfaceEngineService.js';
import { upsertInteropSecret } from '../services/interop/tenantInteropSecretService.js';

process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY || 'interface-engine-test-field-key-32chars';
process.env.FIELD_KEK_LOCAL_SECRET = process.env.FIELD_KEK_LOCAL_SECRET || 'interface-engine-test-kek-key-32chars';

const SFX = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
const TENANT_A = 'a7500000-0000-4000-8000-0000000000a1';
const TENANT_B = 'b7500000-0000-4000-8000-0000000000b2';
const RECEIVER_A = `VH_ENGINE_A_${SFX}`;
const RECEIVER_B = `VH_ENGINE_B_${SFX}`;
const SECRET_A = `secret-a-${SFX}`;
const SECRET_B = `secret-b-${SFX}`;
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const HL7_A = `MSH|^~\\&|ACME_HIS|ACME_FAC|VH|${RECEIVER_A}|202607080930||ADT^A01|CTRL-${SFX}|P|2.5\rPID|||${PATIENT_UID}||KUMAR^Asha\rPV1||I|WARD^101^A||||DR01`;
let inboundChannel;
let outboundChannel;

function sign(secret, payload, requestId = `req-${SFX}`) {
  const timestamp = String(Date.now());
  const signature = crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${requestId}.${payload}`)
    .digest('hex');
  return {
    'x-hl7-timestamp': timestamp,
    'x-hl7-message-id': requestId,
    'x-hl7-signature': signature,
  };
}

async function ensureTenant(id, slug) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    id,
    slug,
    `Interface Engine ${slug}`,
  );
}

async function createActiveInboundChannel() {
  const channel = await createChannel({
    tenantId: TENANT_A,
    channelKey: `his-adt-${SFX}`,
    displayName: 'HIS ADT inbound test',
    direction: 'inbound',
    connectorKind: 'http_inbound',
    protocol: 'hl7v2',
    messageTypes: ['ADT^A01'],
    authSenderIdentifier: RECEIVER_A,
    maxAttempts: 2,
  });
  const version = await createChannelVersion({
    tenantId: TENANT_A,
    channelId: channel.id,
    transformDsl: {
      kind: 'hl7v2-to-backend-adapter',
      output: {
        patientUid: { select: 'PID.3' },
        messageType: { select: 'MSH.9' },
        controlId: { select: 'MSH.10' },
      },
      validate: [
        { path: 'patientUid', required: true },
        { path: 'controlId', required: true },
      ],
      emit: { adapter: 'backend.interop.preview' },
    },
    routingPolicy: { adapter: 'backend.interop.preview' },
  });
  const fixture = await createTransformTest({
    tenantId: TENANT_A,
    channelVersionId: version.id,
    name: `ADT fixture ${SFX}`,
    messageType: 'ADT^A01',
    inputPayload: HL7_A,
    expectedOutput: {
      patientUid: PATIENT_UID,
      messageType: 'ADT^A01',
      controlId: `CTRL-${SFX}`,
    },
  });
  const run = await runTransformTest({ tenantId: TENANT_A, testId: fixture.id });
  expect(run.last_run_status).toBe('passed');
  await activateChannelVersion({
    tenantId: TENANT_A,
    channelVersionId: version.id,
    actorUid: null,
  });
  return channel;
}

async function createActiveOutboundChannel() {
  const channel = await createChannel({
    tenantId: TENANT_A,
    channelKey: `lis-out-${SFX}`,
    displayName: 'LIS outbound test',
    direction: 'outbound',
    connectorKind: 'http_outbound',
    protocol: 'hl7v2',
    messageTypes: ['ORU^R01'],
    authKind: 'none',
    maxAttempts: 1,
  });
  const version = await createChannelVersion({
    tenantId: TENANT_A,
    channelId: channel.id,
    connectorConfig: {},
    transformDsl: {},
  });
  const fixture = await createTransformTest({
    tenantId: TENANT_A,
    channelVersionId: version.id,
    name: `Outbound fixture ${SFX}`,
    messageType: 'ORU^R01',
    inputPayload: `MSH|^~\\&|VH|VH|LIS|LIS|202607080930||ORU^R01|OUT-${SFX}|P|2.5`,
    expectedOutput: {},
  });
  await runTransformTest({ tenantId: TENANT_A, testId: fixture.id });
  await activateChannelVersion({
    tenantId: TENANT_A,
    channelVersionId: version.id,
    actorUid: null,
  });
  return channel;
}

describe('NL11-S11 interface engine runtime', () => {
  beforeAll(async () => {
    expect(await purgeInterfaceEngineTestData(prisma, [TENANT_A, TENANT_B]))
      .toEqual(expect.objectContaining({ total: 0 }));
    await ensureTenant(TENANT_A, `ie-a-${SFX}`);
    await ensureTenant(TENANT_B, `ie-b-${SFX}`);
    await upsertInteropSecret({
      tenantId: TENANT_A,
      kind: 'hl7_inbound',
      senderIdentifier: RECEIVER_A,
      secret: SECRET_A,
    });
    await upsertInteropSecret({
      tenantId: TENANT_B,
      kind: 'hl7_inbound',
      senderIdentifier: RECEIVER_B,
      secret: SECRET_B,
    });
    inboundChannel = await createActiveInboundChannel();
    outboundChannel = await createActiveOutboundChannel();
  }, 30000);

  afterAll(async () => {
    try {
      expect(await purgeInterfaceEngineTestData(prisma, [TENANT_A, TENANT_B]))
        .toEqual(expect.objectContaining({ total: 0 }));
    } finally {
      await prisma.$disconnect();
    }
  }, 30000);

  it('accepts a signed HL7 message, stores only redacted previews, and rejects replay', async () => {
    const headers = sign(SECRET_A, HL7_A, `req-in-${SFX}`);

    const accepted = await receiveHttpHl7Message({
      channelKey: inboundChannel.channel_key,
      message: HL7_A,
      headers,
      sourceIp: '127.0.0.1',
    });

    expect(accepted.status).toBe('delivered');
    expect(accepted.message_type).toBe('ADT^A01');
    expect(accepted.redacted_preview).toContain(`CTRL-${SFX}`);
    expect(accepted.redacted_preview).not.toContain('Asha');

    const detail = await getMessage({ tenantId: TENANT_A, id: accepted.id });
    expect(detail).not.toHaveProperty('raw_payload_ciphertext');
    expect(detail.attempts.map((attempt) => attempt.phase)).toEqual(
      expect.arrayContaining(['receive', 'parse', 'transform', 'deliver_backend']),
    );
    expect(detail.receipts).toEqual([
      expect.objectContaining({
        protocol: 'hl7v2',
        direction: 'inbound',
        adapter_key: 'backend.interop.preview',
        receipt_status: 'accepted',
        payload_sha256: accepted.payload_hash,
      }),
    ]);

    await expect(receiveHttpHl7Message({
      channelKey: inboundChannel.channel_key,
      message: HL7_A,
      headers,
      sourceIp: '127.0.0.1',
    })).rejects.toMatchObject({ code: 'INTEROP_HL7_REPLAY' });
  }, 30000);

  it('fails closed when the signed receiver maps to another tenant', async () => {
    const wrongTenantMessage = HL7_A.replace(RECEIVER_A, RECEIVER_B);
    await expect(receiveHttpHl7Message({
      channelKey: `his-adt-${SFX}`,
      message: wrongTenantMessage,
      headers: sign(SECRET_B, wrongTenantMessage, `req-x-${SFX}`),
      sourceIp: '127.0.0.1',
    })).rejects.toMatchObject({ statusCode: 404 });
  }, 30000);

  it('holds outbound delivery for owner reconciliation when the connector lacks a safe endpoint', async () => {
    const message = await enqueueOutboundMessage({
      tenantId: TENANT_A,
      channelId: outboundChannel.id,
      payload: `MSH|^~\\&|VH|VH|LIS|LIS|202607080930||ORU^R01|OUT-${SFX}|P|2.5`,
      messageType: 'ORU^R01',
    });
    expect(message.status).toBe('queued');

    const stats = await dispatchOutboundMessages({ tenantId: TENANT_A, batchSize: 10 });
    expect(stats).toMatchObject({ picked: 1, held: 1 });

    const listed = await listMessages({ tenantId: TENANT_A, channelId: outboundChannel.id, status: 'quarantined' });
    expect(listed.count).toBe(1);
    expect(listed.messages[0].last_error_code).toBe('INTEROP_OUTBOUND_URL_REQUIRED');
    expect(listed.messages[0]).toMatchObject({
      send_authority: 'held',
      owner_reconciliation_required: true,
      delivery_claim_generation: 1,
      delivery_claimed_at: null,
      delivery_lease_expires_at: null,
    });

    const replay = await createReplayBatch({
      tenantId: TENANT_A,
      channelId: outboundChannel.id,
      reason: 'Owner requested a reconciliation review without authorizing a resend.',
      mode: 'redeliver_external',
      selectionFilter: { statuses: ['quarantined'], limit: 10 },
    });
    expect(replay.safe_summary).toMatch(/Held 1 message/);
    const stillHeld = await listMessages({
      tenantId: TENANT_A,
      channelId: outboundChannel.id,
      status: 'quarantined',
    });
    expect(stillHeld.count).toBe(1);
  }, 30000);
});
