// HL7_INBOUND_ENABLED is authoritative over the I03 inbound ingress.
//
// Audit 2026-08-13: the flag was declared "false" in the production configmap
// and read NOWHERE except as a Joi schema key. `app.js` mounted the HL7 router
// unconditionally, so a deployment that declared HL7 ingress off still
// accepted signed HL7v2 messages against (a) an ACTIVE DB-backed
// `tenant_interop_secrets` credential and (b) a RETAINED legacy
// `HL7_INBOUND_SHARED_SECRET`.
//
// The hazard this suite pins is precisely that pair: **flag off WITH a valid
// credential must be refused**. Proving refusal alone would prove nothing — a
// broken fixture also refuses — so every refusal here is bracketed by the
// SAME credential and the SAME message shape succeeding while the flag is on.
// That is what makes the flag, and not the fixture, the cause.
//
// It also pins the two properties that make the gate fail-closed rather than
// decorative: nothing is consumed while off (no admission row, no durable
// replay-guard row — i.e. the gate runs ahead of credential consumption), and
// only the exact string 'true' enables ingress.
//
// Review follow-up (the second describe below): being refused is not enough —
// the refusal must COST the sender. The gate was mounted in app.js ahead of
// `app.use('/api/v1/hl7', hl7Routes)`, so it short-circuited before the router's
// limiter ever ran: a disabled POST /api/v1/hl7/receive was an un-rate-limited
// 403 that also wrote one warn line per request. That half drives
// mountHl7Interface() — the exact function app.js calls — because the defect
// was in the mount ORDER, which the bare router below cannot expose.

import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

import { RATE_LIMIT_PROFILES } from '../config/rateLimitProfiles.js';
import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import hl7Routes from '../routes/hl7/hl7Routes.js';
import {
  isHl7InboundIngressEnabled,
  assertHl7InboundIngressEnabled,
  hl7InboundIngressGate,
  HL7_INBOUND_DISABLED_CODE,
  __resetHl7InboundRefusalLogWindow,
} from '../routes/hl7/hl7InboundIngressGate.js';
import { mountHl7Interface } from '../routes/hl7/mountHl7Interface.js';
import {
  resolveInteropCredentialSnapshot,
  upsertInteropSecret,
} from '../services/interop/tenantInteropSecretService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const DB_SECRET = 'hl7-inbound-disabled-db-backed-secret-32chars';
const LEGACY_SECRET = 'hl7-inbound-disabled-legacy-shared-secret-32chars';
const FACILITY = 'VHFAC-INBOUND-GATE';
const LEGACY_FACILITY = 'VHFAC-INBOUND-GATE-LEGACY';
const TENANT_ID = 'd15ab1ed-0000-4000-8000-00000000a001';
const PATIENT_UID = 'd15ab1ed-0000-4000-8000-0000000007a1';

let previousFlag;
let previousLegacySecret;
let previousReceivingFacility;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/hl7', hl7Routes);
  return app;
}

function signHeaders({ message, controlId, secret }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const requestId = `hl7-gate-${controlId}-${Date.now()}-${Math.random()}`;
  const signature = crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${requestId}.${message}`)
    .digest('hex');
  return {
    'x-hl7-signature': `sha256=${signature}`,
    'x-hl7-timestamp': String(timestamp),
    'x-hl7-message-id': requestId,
  };
}

function replayRequestIdFor(headers) {
  return [
    headers['x-hl7-message-id'],
    headers['x-hl7-timestamp'],
    headers['x-hl7-signature'].replace(/^sha256=/i, ''),
  ].join(':');
}

function adt(controlId, { facility = FACILITY, patientUid = PATIENT_UID } = {}) {
  return [
    `MSH|^~\\&|SENDER|SFAC|VH|${facility}|20260101120000||ADT^A01|${controlId}|P|2.5`,
    `PID|1||${patientUid}||HL7 GateTest||19900101|M|||Addr|||+919000330701`,
    'PV1|1|I|WARD-9^^^|||||',
  ].join('\r');
}

async function countReplayGuard(requestId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count
       FROM interop_replay_guard
      WHERE namespace = 'hl7-inbound' AND request_id = $1::text`,
    requestId,
  );
  return rows[0].count;
}

async function countAdmissions() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count FROM admissions WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  );
  return rows[0].count;
}

async function cleanup() {
  const receipts = await prisma.$queryRawUnsafe(
    `SELECT timeline_event_id::text, audit_event_id::text
       FROM hl7_inbound_clinical_receipts
      WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => []);
  await prisma.$executeRawUnsafe(
    `DELETE FROM hl7_inbound_clinical_receipts WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  for (const receipt of receipts) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events WHERE id = $1::uuid`,
      receipt.audit_event_id,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE id = $1::uuid`,
      receipt.timeline_event_id,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM admissions WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM interop_replay_guard WHERE namespace = 'hl7-inbound'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenant_interop_secrets WHERE sender_identifier = $1`,
    FACILITY,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id = $1::uuid`,
    TENANT_ID,
  ).catch(() => {});
}

d('HL7_INBOUND_ENABLED is authoritative over I03 ingress', () => {
  let app;

  beforeAll(async () => {
    previousFlag = process.env.HL7_INBOUND_ENABLED;
    previousLegacySecret = process.env.HL7_INBOUND_SHARED_SECRET;
    previousReceivingFacility = process.env.HL7_RECEIVING_FACILITY;
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid,'hl7-gate-a','HL7 Gate A')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid,$2::uuid,'+919000330701','Gate Patient','PATIENT',true,NOW())`,
      PATIENT_UID,
      TENANT_ID,
    );
    // An ACTIVE DB-backed inbound credential — exactly the credential the
    // audit says survives declaring the interface off.
    await upsertInteropSecret({
      tenantId: TENANT_ID,
      kind: 'hl7_inbound',
      senderIdentifier: FACILITY,
      secret: DB_SECRET,
    });
    const snapshot = await resolveInteropCredentialSnapshot('hl7_inbound', FACILITY);
    expect(snapshot).toMatchObject({ tenant_id: TENANT_ID, secret: DB_SECRET });
    app = buildApp();
  }, 30000);

  afterAll(async () => {
    await cleanup();
    if (previousFlag === undefined) delete process.env.HL7_INBOUND_ENABLED;
    else process.env.HL7_INBOUND_ENABLED = previousFlag;
    if (previousLegacySecret === undefined) delete process.env.HL7_INBOUND_SHARED_SECRET;
    else process.env.HL7_INBOUND_SHARED_SECRET = previousLegacySecret;
    if (previousReceivingFacility === undefined) delete process.env.HL7_RECEIVING_FACILITY;
    else process.env.HL7_RECEIVING_FACILITY = previousReceivingFacility;
  }, 30000);

  it('refuses an ACTIVE DB-backed credential while the flag is off, and accepts the identical credential once it is on', async () => {
    // ---- flag OFF, valid DB-backed credential ----------------------------
    process.env.HL7_INBOUND_ENABLED = 'false';
    const offControlId = `GATEOFF${Date.now()}`;
    const offMessage = adt(offControlId);
    const offHeaders = signHeaders({
      message: offMessage,
      controlId: offControlId,
      secret: DB_SECRET,
    });
    const admissionsBefore = await countAdmissions();

    const refused = await request(app)
      .post('/api/v1/hl7/receive')
      .set(offHeaders)
      .send({ message: offMessage });

    expect(refused.status).toBe(403);
    expect(refused.headers['content-type']).toContain('application/hl7-v2');
    expect(refused.text).toContain('MSA|AR');
    expect(refused.text).not.toContain('MSA|AA');
    // Nothing consumed: the gate runs ahead of credential resolution, so the
    // signed envelope is still unused and no clinical row was written.
    expect(await countReplayGuard(replayRequestIdFor(offHeaders))).toBe(0);
    expect(await countAdmissions()).toBe(admissionsBefore);

    // ---- flag ON, SAME credential, same message shape --------------------
    // This half is what makes the refusal above attributable to the flag: the
    // credential is demonstrably able to authenticate and drive a clinical
    // write the moment the interface is declared on.
    process.env.HL7_INBOUND_ENABLED = 'true';
    const onControlId = `GATEON${Date.now()}`;
    const onMessage = adt(onControlId);
    const onHeaders = signHeaders({
      message: onMessage,
      controlId: onControlId,
      secret: DB_SECRET,
    });

    const accepted = await request(app)
      .post('/api/v1/hl7/receive')
      .set(onHeaders)
      .send({ message: onMessage });

    expect(accepted.status).toBe(200);
    expect(accepted.text).toContain('MSA|AA');
    expect(await countAdmissions()).toBe(admissionsBefore + 1);
    expect(await countReplayGuard(replayRequestIdFor(onHeaders))).toBe(1);
  }, 30000);

  it('refuses a RETAINED legacy shared secret while the flag is off, and authenticates it once the flag is on', async () => {
    // The legacy env credential is the second way "off" used to mean nothing:
    // the shared secret outlives the flag in the Sealed Secret.
    process.env.HL7_INBOUND_SHARED_SECRET = LEGACY_SECRET;
    delete process.env.HL7_RECEIVING_FACILITY;

    process.env.HL7_INBOUND_ENABLED = 'false';
    const offControlId = `LEGACYOFF${Date.now()}`;
    const offMessage = adt(offControlId, {
      facility: LEGACY_FACILITY,
      patientUid: PATIENT_UID,
    });
    const offHeaders = signHeaders({
      message: offMessage,
      controlId: offControlId,
      secret: LEGACY_SECRET,
    });

    const refused = await request(app)
      .post('/api/v1/hl7/receive')
      .set(offHeaders)
      .send({ message: offMessage });

    expect(refused.status).toBe(403);
    expect(refused.text).toContain('MSA|AR');
    expect(await countReplayGuard(replayRequestIdFor(offHeaders))).toBe(0);

    // Flag on: the very same secret now authenticates. The message is then
    // refused for an unrelated, LATER reason — the patient belongs to a
    // non-default tenant and the shared-secret path is confined to the default
    // tenant (loadHl7Patient) — which is exactly the point: 404
    // "not registered" is only reachable AFTER the HMAC has been accepted, so
    // it proves the credential was valid all along.
    process.env.HL7_INBOUND_ENABLED = 'true';
    const onControlId = `LEGACYON${Date.now()}`;
    const onMessage = adt(onControlId, {
      facility: LEGACY_FACILITY,
      patientUid: PATIENT_UID,
    });
    const onHeaders = signHeaders({
      message: onMessage,
      controlId: onControlId,
      secret: LEGACY_SECRET,
    });

    const authenticated = await request(app)
      .post('/api/v1/hl7/receive')
      .set(onHeaders)
      .send({ message: onMessage });

    expect(authenticated.status).toBe(404);
    expect(authenticated.text).toContain('MSA|AE');
    expect(authenticated.text).toContain('not registered at this facility');
    expect(await countReplayGuard(replayRequestIdFor(onHeaders))).toBe(1);
  }, 30000);

  it('refuses a signed I03 recovery submission while the flag is off', async () => {
    process.env.HL7_INBOUND_ENABLED = 'false';
    const controlId = `GATEREC${Date.now()}`;
    const message = adt(controlId);
    const headers = signHeaders({ message, controlId, secret: DB_SECRET });

    const refused = await request(app)
      .post('/api/v1/hl7/receive')
      .set(headers)
      .send({ message, recovery: { generation: 1 } });

    expect(refused.status).toBe(403);
    expect(refused.text).toContain('MSA|AR');
    expect(await countReplayGuard(replayRequestIdFor(headers))).toBe(0);
  }, 30000);

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['false', 'false'],
    ['TRUE (wrong case)', 'TRUE'],
    ['1', '1'],
    ['yes', 'yes'],
    ['true with padding', ' true '],
  ])('treats HL7_INBOUND_ENABLED=%s as OFF', async (_label, value) => {
    if (value === undefined) delete process.env.HL7_INBOUND_ENABLED;
    else process.env.HL7_INBOUND_ENABLED = value;

    expect(isHl7InboundIngressEnabled()).toBe(false);
    expect(() => assertHl7InboundIngressEnabled()).toThrow(
      expect.objectContaining({ code: HL7_INBOUND_DISABLED_CODE, statusCode: 403 }),
    );

    const controlId = `GATESPELL${Date.now()}${Math.round(Math.random() * 1000)}`;
    const message = adt(controlId);
    const headers = signHeaders({ message, controlId, secret: DB_SECRET });
    const refused = await request(app)
      .post('/api/v1/hl7/receive')
      .set(headers)
      .send({ message });

    expect(refused.status).toBe(403);
    expect(refused.text).toContain('MSA|AR');
    expect(await countReplayGuard(replayRequestIdFor(headers))).toBe(0);
  }, 30000);

  it('leaves the non-ingress HL7 surface alone while ingress is off', async () => {
    process.env.HL7_INBOUND_ENABLED = 'false';
    // /capability is static metadata, not ingress, and /generate is outbound
    // export behind its own JWT + RBAC. Gating them on an INBOUND flag would
    // be a different (and untrue) claim.
    const capability = await request(app).get('/api/v1/hl7/capability');
    expect(capability.status).toBe(200);
    expect(capability.body).toMatchObject({ hl7Version: '2.5' });

    const generate = await request(app)
      .post('/api/v1/hl7/generate')
      .send({ event_type: 'ADT_A01', admission_id: 1 });
    // Refused by JWT auth, NOT by the inbound gate.
    expect(generate.status).toBe(401);
  }, 30000);
});

// ---------------------------------------------------------------------------
// A refusal must cost the sender.
//
// These drive `mountHl7Interface()` — the function app.js calls, holding all
// three `app.use` statements — rather than the bare router above, because the
// defect was in the MOUNT ORDER: the app-level ingress gate answered before
// `app.use('/api/v1/hl7', hl7Routes)` could reach the router's limiter, so
// `hl7Routes.js`'s "registered AFTER the limiter on purpose" comment described a
// layer that was dead in production. A test against the router alone cannot see
// that, since the router's own ordering was always correct.
//
// The enabled path is the other half of the contract: the fix must not simply
// stack a second limiter in front of the router's, because express-rate-limit
// counts per invocation — two invocations per request would silently halve the
// quota. With max=2 that is directly observable: single-counting 429s on the
// THIRD request, double-counting on the second.
// ---------------------------------------------------------------------------
const RATE_LIMIT_BURST_MAX = 2;
// One bucket per burst. The generic limiter's MemoryStore lives for the whole
// process and its window is 15 minutes, so the two bursts must not share a key.
const RATE_LIMIT_BUCKET_DISABLED = `hl7-gate-off-burst-${crypto.randomUUID()}`;
const RATE_LIMIT_BUCKET_ENABLED = `hl7-gate-on-burst-${crypto.randomUUID()}`;

function buildProductionMountApp() {
  const app = express();
  app.use(express.json());
  mountHl7Interface(app);
  return app;
}

d('a disabled I03 ingress is rate limited at the production mount', () => {
  let mountedApp;
  let previousBurstFlag;
  let previousEnforceInTest;
  let previousMax;

  async function burst(bucketKey, count, controlIdPrefix) {
    const responses = [];
    for (let attempt = 0; attempt < count; attempt += 1) {
      // Sequential on purpose: the assertions below are about the ORDER in
      // which the limiter starts refusing, so the requests must be ordered.
      // The x-api-key header is the limiter's bucket selector (see
      // defaultKeyGenerator) — a unique value per test keeps the two bursts
      // from sharing one counter. No API-key VALIDATION happens on this app;
      // validateApiKey is mounted globally in app.js, above this router.
      responses.push(await request(mountedApp)
        .post('/api/v1/hl7/receive')
        .set('x-api-key', bucketKey)
        .set('x-forwarded-for', '203.0.113.44')
        .send({ message: adt(`${controlIdPrefix}${attempt}`) }));
    }
    return responses;
  }

  beforeAll(() => {
    mountedApp = buildProductionMountApp();
    previousBurstFlag = process.env.HL7_INBOUND_ENABLED;
    previousEnforceInTest = RATE_LIMIT_PROFILES.default.enforceInTest;
    previousMax = RATE_LIMIT_PROFILES.default.max;
    // The generic limiter is skipped under NODE_ENV=test unless its profile
    // opts in; both knobs are read per request, so flipping them here is
    // enough (same seam as hl7-receive-body-limit.test.js).
    RATE_LIMIT_PROFILES.default.enforceInTest = true;
    RATE_LIMIT_PROFILES.default.max = RATE_LIMIT_BURST_MAX;
  });

  beforeEach(() => {
    __resetHl7InboundRefusalLogWindow();
  });

  afterAll(() => {
    RATE_LIMIT_PROFILES.default.enforceInTest = previousEnforceInTest;
    RATE_LIMIT_PROFILES.default.max = previousMax;
    if (previousBurstFlag === undefined) delete process.env.HL7_INBOUND_ENABLED;
    else process.env.HL7_INBOUND_ENABLED = previousBurstFlag;
  });

  it('burns quota while refused: the disabled path turns into 429, not an unbounded stream of 403s', async () => {
    process.env.HL7_INBOUND_ENABLED = 'false';
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const responses = await burst(
        RATE_LIMIT_BUCKET_DISABLED,
        RATE_LIMIT_BURST_MAX + 2,
        'GATEBURSTOFF',
      );

      // Refused, refused, then throttled — the refusal path is not free.
      expect(responses.map(response => response.status)).toEqual([403, 403, 429, 429]);
      expect(responses[0].headers['content-type']).toContain('application/hl7-v2');
      expect(responses[0].text).toContain('MSA|AR');
      expect(responses[1].text).toContain('MSA|AR');
      // Non-recovery requests keep the limiter's ordinary JSON envelope.
      expect(responses[2].body).toMatchObject({ success: false, code: 'RATE_LIMITED' });
      expect(responses[3].body).toMatchObject({ success: false, code: 'RATE_LIMITED' });
      // Past the limit the gate is not even reached, so nothing is logged and
      // no ACK is generated on the attacker's behalf.
      expect(responses[3].headers['content-type']).not.toContain('application/hl7-v2');

      // Log volume is bounded twice over: the limiter caps how many requests
      // reach the gate, and the gate itself writes at most one refusal line per
      // window. Four requests => one line.
      const refusalLogs = warnSpy.mock.calls.filter(
        ([message]) => message === 'HL7 inbound ingress refused: interface is disabled',
      );
      expect(refusalLogs).toHaveLength(1);
      expect(refusalLogs[0][1]).toMatchObject({
        code: HL7_INBOUND_DISABLED_CODE,
        suppressedSinceLastLog: 0,
      });
    } finally {
      warnSpy.mockRestore();
    }
  }, 30000);

  it('samples the refusal log rather than dropping refusals: the next window reports what it stood for', () => {
    // Drives the gate directly — the limiter is proved above; this is about the
    // sampler's own bookkeeping, which needs the clock to cross a window.
    process.env.HL7_INBOUND_ENABLED = 'false';
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    jest.useFakeTimers();
    const refusalLines = () => warnSpy.mock.calls.filter(
      ([message]) => message === 'HL7 inbound ingress refused: interface is disabled',
    );
    const refuse = (requestId) => {
      const res = {
        setHeader() {},
        status() { return this; },
        send() { return this; },
      };
      hl7InboundIngressGate({ id: requestId }, res, () => {
        throw new Error('the gate must not call next() while the interface is off');
      });
    };

    try {
      refuse('window-1-first');
      refuse('window-1-second');
      refuse('window-1-third');
      expect(refusalLines()).toHaveLength(1);
      expect(refusalLines()[0][1]).toMatchObject({ suppressedSinceLastLog: 0 });

      jest.advanceTimersByTime(60_000);
      refuse('window-2-first');
      expect(refusalLines()).toHaveLength(2);
      expect(refusalLines()[1][1]).toMatchObject({ suppressedSinceLastLog: 2 });
    } finally {
      jest.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  it('limits the ENABLED path exactly once — the fix does not double-count the quota', async () => {
    process.env.HL7_INBOUND_ENABLED = 'true';
    const responses = await burst(
      RATE_LIMIT_BUCKET_ENABLED,
      RATE_LIMIT_BURST_MAX + 1,
      'GATEBURSTON',
    );

    // Unsigned messages, so each request is refused by the authenticity check —
    // 401 AR, generated only AFTER the request has passed the gate. That is what
    // makes these three requests real traffic on the enabled path.
    expect(responses[0].status).toBe(401);
    expect(responses[0].text).toContain('MSA|AR');
    // The discriminator: with the same limiter invoked at both the app mount and
    // inside the router, max=2 would already be spent here.
    expect(responses[1].status).toBe(401);
    expect(responses[1].text).toContain('MSA|AR');
    // Exactly one token per request => the third is the first throttled one,
    // identical to the pre-existing behaviour pinned by hl7-receive-body-limit.
    expect(responses[2].status).toBe(429);
    expect(responses[2].body).toMatchObject({ success: false, code: 'RATE_LIMITED' });
  }, 30000);
});
