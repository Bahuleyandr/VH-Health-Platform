import crypto from 'node:crypto';
import { jest } from '@jest/globals';

import prisma from '../lib/prisma.js';
import { purgeInterfaceEngineTestData } from './helpers/interfaceEngineEvidenceCleanup.js';
import {
  activateChannelVersion,
  createChannel,
  createChannelVersion,
  createReplayBatch,
  createSystem,
  createTransformTest,
  dispatchOutboundMessages,
  enqueueOutboundMessage,
  getMessage,
  listMessages,
  receiveHttpHl7Message,
  runTransformTest,
} from '../services/interfaceEngine/interfaceEngineService.js';
import { upsertInteropSecret } from '../services/interop/tenantInteropSecretService.js';
import { _transport } from '../utils/ssrfGuard.js';

process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY || 'interface-engine-test-field-key-32chars';
process.env.FIELD_KEK_LOCAL_SECRET = process.env.FIELD_KEK_LOCAL_SECRET || 'interface-engine-test-kek-key-32chars';
process.env.HL7_FEED_ALLOW_PRIVATE_TARGETS = 'true';

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
let originalFetch;

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
  const sourceSystem = await createSystem({
    tenantId: TENANT_A,
    systemKey: `his-source-${SFX}`,
    displayName: 'HIS inbound source',
    kind: 'his',
    direction: 'inbound',
    status: 'active',
    allowedSourceIps: ['127.0.0.0/8'],
  });
  const channel = await createChannel({
    tenantId: TENANT_A,
    channelKey: `his-adt-${SFX}`,
    displayName: 'HIS ADT inbound test',
    sourceSystemId: sourceSystem.id,
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
    maxAttempts: 2,
    retryPolicy: {
      backoff: 'fixed',
      initialDelaySeconds: 1,
      maxDelaySeconds: 1,
      jitterRatio: 0,
    },
  });
  const version = await createChannelVersion({
    tenantId: TENANT_A,
    channelId: channel.id,
    connectorConfig: { endpointUrl: 'http://127.0.0.1:39999/hl7' },
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
    originalFetch = _transport.fetch;
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
      _transport.fetch = originalFetch;
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

    expect(accepted.status).toBe('transformed');
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
        receipt_status: 'previewed',
        payload_sha256: accepted.payload_hash,
      }),
    ]);
    await expect(prisma.$executeRawUnsafe(
      `UPDATE interop_messages
          SET status = 'delivered'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT_A,
      accepted.id,
    )).rejects.toThrow(/preview-only interface messages cannot be marked delivered/);

    await expect(receiveHttpHl7Message({
      channelKey: inboundChannel.channel_key,
      message: HL7_A,
      headers,
      sourceIp: '127.0.0.1',
    })).rejects.toMatchObject({ code: 'INTEROP_HL7_REPLAY' });
  }, 30000);

  it('enforces the source IP policy before consuming signed request replay state', async () => {
    const requestId = `req-source-${SFX}`;
    const headers = sign(SECRET_A, HL7_A, requestId);
    await expect(receiveHttpHl7Message({
      channelKey: inboundChannel.channel_key,
      message: HL7_A,
      headers,
      sourceIp: '10.0.0.8',
    })).rejects.toMatchObject({ code: 'INTEROP_SOURCE_IP_NOT_ALLOWED' });
    await expect(receiveHttpHl7Message({
      channelKey: inboundChannel.channel_key,
      message: HL7_A,
      headers,
      sourceIp: null,
    })).rejects.toMatchObject({ code: 'INTEROP_SOURCE_IP_REQUIRED' });
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

  it('refuses activation for draft-only connectors and missing outbound endpoints', async () => {
    const cases = [
      {
        key: `manual-${SFX}`,
        connectorKind: 'manual_upload',
        direction: 'inbound',
        protocol: 'csv',
        connectorConfig: {},
        code: 'INTEROP_CONNECTOR_RUNTIME_UNSUPPORTED',
        payload: 'patient_id,name\n1,Test',
      },
      {
        key: `http-no-endpoint-${SFX}`,
        connectorKind: 'http_outbound',
        direction: 'outbound',
        protocol: 'json',
        connectorConfig: {},
        code: 'INTEROP_OUTBOUND_URL_REQUIRED',
        payload: '{"kind":"test"}',
      },
    ];
    for (const item of cases) {
      const channel = await createChannel({
        tenantId: TENANT_A,
        channelKey: item.key,
        displayName: item.key,
        direction: item.direction,
        connectorKind: item.connectorKind,
        protocol: item.protocol,
        authKind: 'none',
      });
      const version = await createChannelVersion({
        tenantId: TENANT_A,
        channelId: channel.id,
        connectorConfig: item.connectorConfig,
        transformDsl: {},
      });
      const fixture = await createTransformTest({
        tenantId: TENANT_A,
        channelVersionId: version.id,
        name: `Activation fixture ${item.key}`,
        inputPayload: item.payload,
        expectedOutput: {},
      });
      await expect(runTransformTest({ tenantId: TENANT_A, testId: fixture.id }))
        .resolves.toMatchObject({ last_run_status: 'passed' });
      await expect(activateChannelVersion({
        tenantId: TENANT_A,
        channelVersionId: version.id,
      })).rejects.toMatchObject({ code: item.code });
    }
  }, 30000);

  it('delivers only after a correlated positive acknowledgement and sends a stable idempotency key', async () => {
    const requestHeaders = [];
    _transport.fetch = jest.fn(async (_url, options) => {
      requestHeaders.push(options.headers);
      return new Response(
        `MSH|^~\\&|LIS|LIS|VH|VH|202607080931||ACK|ACK-${SFX}|P|2.5\rMSA|AA|OUT-${SFX}`,
        { status: 200 },
      );
    });
    const message = await enqueueOutboundMessage({
      tenantId: TENANT_A,
      channelId: outboundChannel.id,
      payload: `MSH|^~\\&|VH|VH|LIS|LIS|202607080930||ORU^R01|OUT-${SFX}|P|2.5`,
      messageType: 'ORU^R01',
    });
    expect(message.status).toBe('queued');
    await expect(prisma.$executeRawUnsafe(
      `UPDATE interop_messages
          SET status = 'delivered'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT_A,
      message.id,
    )).rejects.toThrow(/outbound interface delivery requires an accepted same-message receipt/);
    await expect(enqueueOutboundMessage({
      tenantId: TENANT_A,
      channelId: outboundChannel.id,
      protocol: 'json',
      payload: '{"kind":"wrong-protocol"}',
    })).rejects.toMatchObject({ code: 'INTEROP_OUTBOUND_PROTOCOL_MISMATCH' });

    const ticks = await Promise.all([
      dispatchOutboundMessages({ tenantId: TENANT_A, batchSize: 10 }),
      dispatchOutboundMessages({ tenantId: TENANT_A, batchSize: 10 }),
    ]);
    expect(ticks.reduce((total, stats) => ({
      picked: total.picked + stats.picked,
      delivered: total.delivered + stats.delivered,
      held: total.held + stats.held,
    }), { picked: 0, delivered: 0, held: 0 })).toEqual({
      picked: 1,
      delivered: 1,
      held: 0,
    });
    expect(_transport.fetch).toHaveBeenCalledTimes(1);
    expect(requestHeaders[0]).toMatchObject({
      'Idempotency-Key': `vh-interop:${TENANT_A}:${message.id}:${message.payload_hash}`,
      'X-VH-Interop-Message-Id': String(message.id),
    });
    const delivered = await getMessage({ tenantId: TENANT_A, id: message.id });
    expect(delivered).toMatchObject({ status: 'delivered', last_delivery_outcome: 'accepted' });
    expect(delivered.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: 'outbound', receipt_status: 'accepted' }),
    ]));
  }, 30000);

  it('honors retry policy and replay queues only a definitively retryable delivery', async () => {
    _transport.fetch = jest.fn(async () => new Response('', { status: 429 }));
    const message = await enqueueOutboundMessage({
      tenantId: TENANT_A,
      channelId: outboundChannel.id,
      payload: `MSH|^~\\&|VH|VH|LIS|LIS|202607080930||ORU^R01|RETRY-${SFX}|P|2.5`,
      messageType: 'ORU^R01',
    });

    const first = await dispatchOutboundMessages({ tenantId: TENANT_A, batchSize: 10 });
    expect(first).toMatchObject({ picked: 1, retry_scheduled: 1, held: 0 });
    const failed = await getMessage({ tenantId: TENANT_A, id: message.id });
    expect(failed).toMatchObject({
      status: 'failed',
      last_delivery_outcome: 'definitive_retryable',
      last_delivery_response_status: 429,
    });
    expect(failed.retry_at).not.toBeNull();

    const replay = await createReplayBatch({
      tenantId: TENANT_A,
      channelId: outboundChannel.id,
      reason: 'Retry after the downstream rate limit was confirmed.',
      mode: 'retry_delivery',
      selectionFilter: { statuses: ['failed'], limit: 10 },
    });
    expect(replay).toMatchObject({
      status: 'completed',
      selected_count: 1,
      queued_count: 1,
      skipped_count: 0,
    });

    const queued = await getMessage({ tenantId: TENANT_A, id: message.id });
    expect(queued).toMatchObject({ status: 'queued', retry_at: null });
    await expect(createReplayBatch({
      tenantId: TENANT_A,
      channelId: outboundChannel.id,
      reason: 'Unsupported replay must not claim success.',
      mode: 'redeliver_external',
    })).rejects.toMatchObject({ code: 'INTEROP_REPLAY_MODE_UNSUPPORTED' });

    const second = await dispatchOutboundMessages({ tenantId: TENANT_A, batchSize: 10 });
    expect(second).toMatchObject({ picked: 1, dead: 1, retry_scheduled: 0 });
    const dead = await getMessage({ tenantId: TENANT_A, id: message.id });
    expect(dead).toMatchObject({ status: 'dead', last_delivery_outcome: 'definitive_retryable' });
  }, 30000);

  it('quarantines an ambiguous transport outcome and does not send it twice', async () => {
    _transport.fetch = jest.fn(async () => {
      throw new Error('socket closed after request write');
    });
    const message = await enqueueOutboundMessage({
      tenantId: TENANT_A,
      channelId: outboundChannel.id,
      payload: `MSH|^~\\&|VH|VH|LIS|LIS|202607080930||ORU^R01|AMB-${SFX}|P|2.5`,
      messageType: 'ORU^R01',
    });
    const first = await dispatchOutboundMessages({ tenantId: TENANT_A, batchSize: 10 });
    expect(first).toMatchObject({ picked: 1, ambiguous: 1, held: 1 });

    const listed = await listMessages({ tenantId: TENANT_A, channelId: outboundChannel.id, status: 'quarantined' });
    expect(listed.count).toBe(1);
    expect(listed.messages[0]).toMatchObject({
      send_authority: 'held',
      owner_reconciliation_required: true,
      last_delivery_outcome: 'ambiguous',
      delivery_claim_generation: 1,
      delivery_claimed_at: null,
      delivery_lease_expires_at: null,
    });

    const second = await dispatchOutboundMessages({ tenantId: TENANT_A, batchSize: 10 });
    expect(second.picked).toBe(0);
    expect(_transport.fetch).toHaveBeenCalledTimes(1);
    expect(listed.messages[0].id).toBe(message.id);
  }, 30000);
});
