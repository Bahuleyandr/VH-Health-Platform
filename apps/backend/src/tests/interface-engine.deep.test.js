import crypto from 'node:crypto';
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import prisma from '../lib/prisma.js';
import interfaceEngineIngressRoutes from '../routes/interfaceEngine/interfaceEngineIngressRoutes.js';
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
import { isTrustedIngressProxy } from '../utils/trustedProxy.js';

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

function ingressApp() {
  const app = express();
  app.set('trust proxy', isTrustedIngressProxy);
  app.use(express.json());
  app.use('/api/v1/interface-engine', interfaceEngineIngressRoutes);
  return app;
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

// Audit 2026-08-13: this fixture used to ACTIVATE this channel. It no longer
// can, and that is the fix. `http_inbound` may only carry hl7v2, and hl7v2's
// only registered backend adapter is the forbidden preview adapter, so no
// inbound version can name a canonical backend adapter — activation is
// refused at the service boundary and by both database triggers. The channel
// and version are still built here (draft) because several tests assert what
// is refused and what the ingress does with a channel that cannot go active.
async function createInboundChannelCandidate() {
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
    authKind: 'tenant_interop_secret',
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
    },
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
  // Transform validation still works end to end — the refusal below is about
  // DELIVERY capability, not about the version being malformed.
  await expect(activateChannelVersion({
    tenantId: TENANT_A,
    channelVersionId: version.id,
    actorUid: null,
  })).rejects.toMatchObject({ code: 'INTEROP_CANONICAL_BACKEND_ADAPTER_UNAVAILABLE' });
  return { ...channel, version_id: version.id };
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
  return { ...channel, status: 'active', active_version_id: version.id };
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
    inboundChannel = await createInboundChannelCandidate();
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

  // Audit 2026-08-13 — what these four tests used to assert.
  //
  // They exercised an ACTIVE `http_inbound` channel that carried no backend
  // adapter: signed ingest, replay rejection, source-IP policy, and
  // cross-tenant receiver binding, all terminating truthfully at
  // `status = 'transformed'` with no receipt and a 409 at the ingress.
  //
  // That state is exactly the defect. `http_inbound` may only carry hl7v2, and
  // hl7v2's only registered backend adapter is `backend.interop.preview`,
  // which the activation guards already forbid. So an inbound channel could be
  // approved as `active` in three configurations, none of which can deliver:
  // naming the preview adapter (already refused), naming an adapter key no
  // adapter implements (every message dies at `deliver_backend`), or naming no
  // adapter at all (the case below — silently inert, 409 forever). Activation
  // now requires a CANONICAL backend adapter at the service boundary and at
  // both database triggers, which makes inbound activation unavailable until
  // such an adapter is registered.
  //
  // Consequence to be explicit about: with no channel able to reach `active`,
  // the guards INSIDE receiveHttpHl7Message that those four tests reached
  // through an active channel (replay, source-IP allowlist, proxy trust,
  // receiver/tenant binding) sit behind `loadChannel({ activeOnly: true })` and
  // are no longer reachable from an integration test. Their primitives keep
  // unit coverage in src/tests/unit/interfaceEngineRuntimePolicy.test.js
  // (isSourceIpAllowed, normalizeAllowedSourceRanges) and the equivalent
  // signed-request / replay guards stay covered end to end on the I03 path
  // (hl7-receive-tenant-equality.deep.test.js, hl7-inbound-recovery.deep.test.js).

  it('refuses inbound activation with no canonical backend adapter at the service and both database boundaries', async () => {
    // Service boundary: proven by createInboundChannelCandidate() in beforeAll,
    // re-asserted here so the refusal is visible in this test's own output.
    await expect(activateChannelVersion({
      tenantId: TENANT_A,
      channelVersionId: inboundChannel.version_id,
      actorUid: null,
    })).rejects.toMatchObject({ code: 'INTEROP_CANONICAL_BACKEND_ADAPTER_UNAVAILABLE' });

    // Database boundary 1 — the version trigger, reached by bypassing the
    // service entirely.
    await expect(prisma.$executeRawUnsafe(
      `UPDATE interop_channel_versions
          SET status = 'active'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT_A,
      inboundChannel.version_id,
    )).rejects.toThrow(/no canonical backend adapter is registered for this protocol/);

    // Database boundary 2 — the channel trigger. Note what this actually
    // proves: the channel cannot go active either. It stops on the trigger's
    // EARLIER requirement (its active version is not active, because the
    // version trigger above refused it), so the channel trigger's own
    // canonical-adapter branch is not the clause that fires here. That branch
    // is unreachable for hl7v2 by construction — reaching it needs an active
    // hl7v2 inbound version, which cannot exist — and it is carried so the
    // channel boundary opens together with the version boundary the day a
    // canonical hl7v2 adapter is registered. Do not read this assertion as
    // coverage of that branch.
    await expect(prisma.$executeRawUnsafe(
      `UPDATE interop_channels
          SET status = 'active', active_version_id = $2::integer
        WHERE tenant_id = $1::uuid AND id = $3::integer`,
      TENANT_A,
      inboundChannel.version_id,
      inboundChannel.id,
    )).rejects.toThrow(/active interface-engine channel must reference its active version/);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT channel.status AS channel_status, version.status AS version_status
         FROM interop_channels AS channel
         JOIN interop_channel_versions AS version
           ON version.tenant_id = channel.tenant_id AND version.channel_id = channel.id
        WHERE channel.tenant_id = $1::uuid AND channel.id = $2::integer`,
      TENANT_A,
      inboundChannel.id,
    );
    expect(rows[0]).toMatchObject({ channel_status: 'draft' });
    expect(rows[0].version_status).not.toBe('active');
  }, 30000);

  it('refuses inbound activation that names a backend adapter no adapter implements', async () => {
    const channel = await createChannel({
      tenantId: TENANT_A,
      channelKey: `unregistered-adapter-${SFX}`,
      displayName: 'Unregistered backend adapter candidate',
      sourceSystemId: inboundChannel.source_system_id,
      direction: 'inbound',
      connectorKind: 'http_inbound',
      protocol: 'hl7v2',
      messageTypes: ['ADT^A01'],
      authKind: 'tenant_interop_secret',
      authSenderIdentifier: `UNREG_${SFX}`,
    });
    const version = await createChannelVersion({
      tenantId: TENANT_A,
      channelId: channel.id,
      transformDsl: {
        kind: 'hl7v2-to-backend-adapter',
        output: {
          patientUid: { select: 'PID.3' },
          controlId: { select: 'MSH.10' },
        },
        // Plausible, spelled like a real key, implemented by nothing. Before
        // the fix this activated and then failed on every single message with
        // INTEROP_BACKEND_ADAPTER_UNREGISTERED at deliver_backend.
        emit: { adapter: 'backend.interop.hl7v2' },
      },
      routingPolicy: { adapter: 'backend.interop.hl7v2' },
    });
    const fixture = await createTransformTest({
      tenantId: TENANT_A,
      channelVersionId: version.id,
      name: `Unregistered fixture ${SFX}`,
      messageType: 'ADT^A01',
      inputPayload: HL7_A,
      expectedOutput: {
        patientUid: PATIENT_UID,
        controlId: `CTRL-${SFX}`,
      },
    });
    await expect(runTransformTest({ tenantId: TENANT_A, testId: fixture.id }))
      .resolves.toMatchObject({ last_run_status: 'passed' });

    await expect(activateChannelVersion({
      tenantId: TENANT_A,
      channelVersionId: version.id,
      actorUid: null,
    })).rejects.toMatchObject({ code: 'INTEROP_CANONICAL_BACKEND_ADAPTER_UNAVAILABLE' });

    await expect(prisma.$executeRawUnsafe(
      `UPDATE interop_channel_versions
          SET status = 'active'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT_A,
      version.id,
    )).rejects.toThrow(/canonical backend adapter/);
  }, 30000);

  it('accepts no HL7 ingress at all while no inbound channel can be active', async () => {
    // A correctly signed message from an allowlisted source against a real
    // tenant credential. Before the fix this was ingested, stored (encrypted
    // PHI) and answered 409 forever; now there is no active channel to receive
    // it and nothing is persisted.
    const headers = sign(SECRET_A, HL7_A, `req-in-${SFX}`);
    await expect(receiveHttpHl7Message({
      channelKey: inboundChannel.channel_key,
      message: HL7_A,
      headers,
      sourceIp: '127.0.0.1',
    })).rejects.toMatchObject({ statusCode: 404 });

    const overHttp = await request(ingressApp())
      .post(`/api/v1/interface-engine/channels/${inboundChannel.channel_key}/hl7`)
      .set(headers)
      .send({ message: HL7_A });
    expect(overHttp.status).toBe(404);
    expect(overHttp.text).not.toContain('MSA|AA');

    const stored = await listMessages({
      tenantId: TENANT_A,
      channelId: inboundChannel.id,
    });
    expect(stored.messages).toEqual([]);
  }, 30000);


  it('keeps the preview adapter available for validation tests but rejects service, database, and delivery activation', async () => {
    const channel = await createChannel({
      tenantId: TENANT_A,
      channelKey: `preview-${SFX}`,
      displayName: 'Preview-only inbound candidate',
      sourceSystemId: inboundChannel.source_system_id,
      direction: 'inbound',
      connectorKind: 'http_inbound',
      protocol: 'hl7v2',
      messageTypes: ['ADT^A01'],
      authKind: 'tenant_interop_secret',
      authSenderIdentifier: `PREVIEW_${SFX}`,
    });
    const version = await createChannelVersion({
      tenantId: TENANT_A,
      channelId: channel.id,
      transformDsl: {
        kind: 'hl7v2-to-backend-adapter',
        output: {
          patientUid: { select: 'PID.3' },
          controlId: { select: 'MSH.10' },
        },
        emit: { adapter: 'backend.interop.preview' },
      },
      routingPolicy: { adapter: 'backend.interop.preview' },
    });
    const fixture = await createTransformTest({
      tenantId: TENANT_A,
      channelVersionId: version.id,
      name: `Preview fixture ${SFX}`,
      messageType: 'ADT^A01',
      inputPayload: HL7_A,
      expectedOutput: {
        patientUid: PATIENT_UID,
        controlId: `CTRL-${SFX}`,
      },
    });
    await expect(runTransformTest({ tenantId: TENANT_A, testId: fixture.id }))
      .resolves.toMatchObject({ last_run_status: 'passed' });
    await expect(activateChannelVersion({
      tenantId: TENANT_A,
      channelVersionId: version.id,
    })).rejects.toMatchObject({ code: 'INTEROP_PREVIEW_ACTIVATION_FORBIDDEN' });
    await prisma.$executeRawUnsafe(
      `UPDATE interop_channel_versions
          SET transform_dsl = jsonb_set(transform_dsl, '{emit,adapter}', '""'::jsonb)
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT_A,
      version.id,
    );
    await expect(prisma.$executeRawUnsafe(
      `UPDATE interop_channel_versions
          SET status = 'active'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT_A,
      version.id,
    )).rejects.toThrow(/preview-only inbound versions cannot be activated/);
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO interop_messages
         (tenant_id, channel_id, channel_version_id, direction, protocol,
          external_control_id, payload_hash, status)
       VALUES ($1::uuid, $2::integer, $3::integer, 'inbound', 'hl7v2',
               $4, $5, 'delivered')`,
      TENANT_A,
      channel.id,
      version.id,
      `PREVIEW-INSERT-${SFX}`,
      'a'.repeat(64),
    )).rejects.toThrow(/preview-only interface messages cannot be marked delivered/);
  }, 30000);

  it('activates only implemented direction and authentication contracts', async () => {
    // The inbound candidate is deliberately NOT active — no canonical hl7v2
    // backend adapter exists, so http_inbound activation is unavailable.
    expect(inboundChannel).toMatchObject({
      status: 'draft',
      auth_kind: 'tenant_interop_secret',
    });
    expect(outboundChannel).toMatchObject({
      status: 'active',
      auth_kind: 'none',
    });
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
      {
        key: `http-secret-${SFX}`,
        connectorKind: 'http_outbound',
        direction: 'outbound',
        protocol: 'json',
        authKind: 'tenant_interop_secret',
        connectorConfig: { endpointUrl: 'http://127.0.0.1:39999/json' },
        code: 'INTEROP_OUTBOUND_AUTH_UNSUPPORTED',
        payload: '{"kind":"test"}',
      },
      {
        key: `http-internal-${SFX}`,
        connectorKind: 'http_outbound',
        direction: 'outbound',
        protocol: 'json',
        authKind: 'internal',
        connectorConfig: { endpointUrl: 'http://127.0.0.1:39999/json' },
        code: 'INTEROP_OUTBOUND_AUTH_UNSUPPORTED',
        payload: '{"kind":"test"}',
      },
      {
        key: `in-none-${SFX}`,
        connectorKind: 'http_inbound',
        direction: 'inbound',
        protocol: 'hl7v2',
        authKind: 'none',
        sourceSystemId: inboundChannel.source_system_id,
        connectorConfig: {},
        code: 'INTEROP_INBOUND_AUTH_UNSUPPORTED',
        payload: HL7_A,
      },
      {
        key: `in-internal-${SFX}`,
        connectorKind: 'http_inbound',
        direction: 'inbound',
        protocol: 'hl7v2',
        authKind: 'internal',
        sourceSystemId: inboundChannel.source_system_id,
        connectorConfig: {},
        code: 'INTEROP_INBOUND_AUTH_UNSUPPORTED',
        payload: HL7_A,
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
        authKind: item.authKind || 'none',
        sourceSystemId: item.sourceSystemId || null,
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
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO interop_messages
         (tenant_id, channel_id, channel_version_id, direction, protocol,
          external_control_id, payload_hash, status)
       VALUES ($1::uuid, $2::integer, $3::integer, 'outbound', 'hl7v2',
               $4, $5, 'delivered')`,
      TENANT_A,
      outboundChannel.id,
      outboundChannel.active_version_id,
      `OUT-INSERT-${SFX}`,
      'b'.repeat(64),
    )).rejects.toThrow(/outbound interface delivery requires an accepted same-message receipt/);
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
    expect(requestHeaders[0]).not.toHaveProperty('Authorization');
    const delivered = await getMessage({ tenantId: TENANT_A, id: message.id });
    expect(delivered).toMatchObject({ status: 'delivered', last_delivery_outcome: 'accepted' });
    expect(delivered.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: 'outbound', receipt_status: 'accepted' }),
    ]));
  }, 30000);

  it('does not claim a remaining outbound message after the channel is paused', async () => {
    const first = await enqueueOutboundMessage({
      tenantId: TENANT_A,
      channelId: outboundChannel.id,
      payload: `MSH|^~\\&|VH|VH|LIS|LIS|202607080930||ORU^R01|PAUSE-A-${SFX}|P|2.5`,
      messageType: 'ORU^R01',
    });
    const second = await enqueueOutboundMessage({
      tenantId: TENANT_A,
      channelId: outboundChannel.id,
      payload: `MSH|^~\\&|VH|VH|LIS|LIS|202607080930||ORU^R01|PAUSE-B-${SFX}|P|2.5`,
      messageType: 'ORU^R01',
    });
    let networkCalls = 0;
    _transport.fetch = jest.fn(async (_url, options) => {
      networkCalls += 1;
      if (networkCalls === 1) {
        await prisma.$executeRawUnsafe(
          `UPDATE interop_channels
              SET status = 'paused', updated_at = NOW()
            WHERE tenant_id = $1::uuid AND id = $2::integer`,
          TENANT_A,
          outboundChannel.id,
        );
      }
      const controlId = String(options.body).split('|')[9];
      return new Response(
        `MSH|^~\\&|LIS|LIS|VH|VH|202607080931||ACK|ACK-${SFX}|P|2.5\rMSA|AA|${controlId}`,
        { status: 200 },
      );
    });

    let tick;
    let messages;
    try {
      tick = await dispatchOutboundMessages({ tenantId: TENANT_A, batchSize: 10 });
      messages = await Promise.all([
        getMessage({ tenantId: TENANT_A, id: first.id }),
        getMessage({ tenantId: TENANT_A, id: second.id }),
      ]);
    } finally {
      await prisma.$executeRawUnsafe(
        `UPDATE interop_channels
            SET status = 'active', updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::integer`,
        TENANT_A,
        outboundChannel.id,
      );
      await prisma.$executeRawUnsafe(
        `UPDATE interop_messages
            SET status = 'dead',
                send_authority = 'held',
                owner_reconciliation_required = true,
                last_delivery_outcome = 'definitive_permanent',
                last_error_code = 'INTEROP_TEST_FIXTURE_RETIRED',
                last_error_safe = 'Race-test fixture retired before later dispatch tests',
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = ANY($2::integer[])
            AND status = 'queued'`,
        TENANT_A,
        [first.id, second.id],
      );
    }

    expect(tick).toMatchObject({ picked: 1, delivered: 1 });
    expect(_transport.fetch).toHaveBeenCalledTimes(1);
    expect(messages.filter(message => message.status === 'delivered')).toHaveLength(1);
    const queued = messages.filter(message => message.status === 'queued');
    expect(queued).toHaveLength(1);
    expect(queued[0].attempts.map(attempt => attempt.phase)).not.toContain('deliver_external');
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
