// Roadmap C2 — outbound HL7v2 feeds deep round-trip.
//
// Spins a local HTTP receiver, subscribes it, emits ADT/ORU through the
// hook-facing service functions, runs the delivery worker, and asserts:
// delivery with the HL7 content type, retry/backoff on failures, and the
// management surface without the retired generic replay authority.

import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import prisma, { setTenantTx } from '../lib/prisma.js';
import { authClient } from './testClient.js';
import {
  emitAdmissionAdt,
  emitSignedResultsOru,
  deliverPendingFeedMessages,
} from '../services/hl7/hl7OutboundService.js';
import { generateACK, parseHL7 } from '../services/hl7/hl7Parser.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TEST_TENANT_ID = randomUUID();
const SUFFIX = TEST_TENANT_ID.slice(0, 8);
const PHONE = `+9199916${String(Date.now() % 10000).padStart(4, '0')}`;
let patientUid;
let server;
let baseUrl;
const received = [];
const tenantAuthClient = (role = 'ADMIN') => authClient(role, { tenant_id: TEST_TENANT_ID });

d('Outbound HL7v2 feeds — deep round-trip (roadmap C2)', () => {
  beforeAll(async () => {
    // This suite delivers to a local http.Server on 127.0.0.1, which the H4
    // SSRF guard (utils/ssrfGuard.js) correctly blocks by default. The
    // test-only escape hatch below disables the private-address checks; it
    // is hard-refused in production. The guard's own coverage lives in
    // hl7-ssrf-guard.test.js (which keeps this var unset).
    process.env.HL7_FEED_ALLOW_PRIVATE_TARGETS = 'true';
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, created_at, updated_at)
       VALUES ($1::uuid, $2::text, 'C2TEST HL7', 'IN', 'DPDP', 'active', NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET status = 'active', updated_at = NOW()`,
      TEST_TENANT_ID,
      `c2test-hl7-${SUFFIX}`,
    );
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (tenant_id, phone, name, role, is_active, gender, birthday, updated_at)
       VALUES ($1::uuid, $2, 'C2TEST Patient', 'PATIENT', true, 'female', '1990-02-02', NOW()) RETURNING uid`,
      TEST_TENANT_ID,
      PHONE,
    );
    patientUid = p[0].uid;

    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        received.push({ url: req.url, body, contentType: req.headers['content-type'] });
        if (req.url === '/fail') {
          const controlId = parseHL7(body).msh.messageControlId;
          res.statusCode = 200;
          res.end(generateACK(controlId, 'AE', 'downstream validation rejected'));
        } else {
          const controlId = parseHL7(body).msh.messageControlId;
          res.statusCode = 200;
          res.end(generateACK(controlId, 'AA', 'accepted'));
        }
      });
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    delete process.env.HL7_FEED_ALLOW_PRIVATE_TARGETS;
    await new Promise((resolve) => { server.close(resolve); });
    await prisma.$disconnect();
  });

  test('subscription management: integration-admin only; validation enforced', async () => {
    const nurse = await tenantAuthClient('NURSING_STAFF')
      .post('/api/v1/hl7-feeds/subscriptions')
      .send({ name: 'C2TEST nope', endpoint_url: `${baseUrl}/ok` });
    expect(nurse.status).toBe(403);

    const badUrl = await tenantAuthClient('ADMIN')
      .post('/api/v1/hl7-feeds/subscriptions')
      .send({ name: 'C2TEST bad', endpoint_url: 'mllp://1.2.3.4:2575' });
    expect(badUrl.status).toBe(400);

    const ok = await tenantAuthClient('ADMIN')
      .post('/api/v1/hl7-feeds/subscriptions')
      .send({ name: 'C2TEST receiver', endpoint_url: `${baseUrl}/ok`, message_types: ['ADT^A01', 'ORU^R01'] });
    expect(ok.status).toBe(201);
    expect(ok.body.data.subscription.tenant_id).toBe(TEST_TENANT_ID);

    const flaky = await tenantAuthClient('ADMIN')
      .post('/api/v1/hl7-feeds/subscriptions')
      .send({ name: 'C2TEST flaky', endpoint_url: `${baseUrl}/fail`, message_types: ['ADT^A01'] });
    expect(flaky.status).toBe(201);
    expect(flaky.body.data.subscription.tenant_id).toBe(TEST_TENANT_ID);
  });

  test('admission emission fans out to matching subscriptions only', async () => {
    const queued = await emitAdmissionAdt({
      id: 424242,
      patient_uid: patientUid,
      ward: 'C2TEST Ward',
      bed_number: 'C2-01',
      admitted_at: new Date(),
    });
    expect(queued).toBe(2); // both subscriptions listen for ADT^A01

    const rows = await setTenantTx(TEST_TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT m.message_type, m.status, m.hl7_payload FROM hl7_outbound_messages m
        JOIN hl7_feed_subscriptions s
          ON s.tenant_id = m.tenant_id AND s.id = m.subscription_id
       WHERE m.tenant_id = $1::uuid AND s.name LIKE 'C2TEST%'`,
      TEST_TENANT_ID,
    ));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.message_type).toBe('ADT^A01');
      expect(row.status).toBe('queued');
      expect(row.hl7_payload.startsWith('MSH|')).toBe(true);
      expect(row.hl7_payload).toContain('ADT^A01');
    }
  });

  test('delivery worker requires a correlated MSA|AA and holds ambiguous transport', async () => {
    const stats = await deliverPendingFeedMessages({ limit: 10, tenantId: TEST_TENANT_ID });
    expect(stats.picked).toBe(2);
    expect(stats.acknowledged).toBe(1);
    expect(stats.rejected).toBe(1);

    const okHit = received.find((r) => r.url === '/ok');
    expect(okHit).toBeDefined();
    expect(okHit.contentType).toBe('x-application/hl7-v2+er7');
    expect(okHit.body.startsWith('MSH|')).toBe(true);

    const failedRows = await setTenantTx(TEST_TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT m.status, m.attempts, m.last_error, m.transport_state,
              m.acknowledgement_state, m.send_authority,
              result.http_status, cursor.state AS cursor_state,
              cursor.last_contiguous_message_id
         FROM hl7_outbound_messages m
         JOIN hl7_feed_subscriptions s
           ON s.tenant_id = m.tenant_id AND s.id = m.subscription_id
         JOIN hl7_outbound_transport_attempts AS attempt
           ON attempt.tenant_id = m.tenant_id AND attempt.message_id = m.id
         JOIN hl7_outbound_transport_results AS result
           ON result.tenant_id = attempt.tenant_id
          AND result.attempt_id = attempt.attempt_id
         JOIN hl7_outbound_delivery_cursors AS cursor
           ON cursor.tenant_id = m.tenant_id
          AND cursor.subscription_id = m.subscription_id
        WHERE m.tenant_id = $1::uuid AND s.name = 'C2TEST flaky'`,
      TEST_TENANT_ID,
    ));
    expect(failedRows[0].status).toBe('reconciliation_required');
    expect(failedRows[0].attempts).toBe(1);
    expect(failedRows[0]).toMatchObject({
      transport_state: 'http_response',
      acknowledgement_state: 'ae',
      send_authority: 'held_owner_reconciliation',
      http_status: 200,
      cursor_state: 'paused_rejected',
      last_contiguous_message_id: null,
    });

    const accepted = await setTenantTx(TEST_TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT message.status, message.transport_state,
              message.acknowledgement_state, message.send_authority,
              message.hl7_payload, message.payload_sha256,
              cursor.last_contiguous_message_id,
              acknowledgement.msa_code,
              acknowledgement.correlation_matches
         FROM hl7_outbound_messages AS message
         JOIN hl7_feed_subscriptions AS subscription
           ON subscription.tenant_id = message.tenant_id
          AND subscription.id = message.subscription_id
         JOIN hl7_outbound_delivery_cursors AS cursor
           ON cursor.tenant_id = message.tenant_id
          AND cursor.subscription_id = message.subscription_id
         JOIN hl7_outbound_acknowledgements AS acknowledgement
           ON acknowledgement.tenant_id = message.tenant_id
          AND acknowledgement.message_id = message.id
        WHERE message.tenant_id = $1::uuid AND subscription.name = 'C2TEST receiver'
          AND message.message_type = 'ADT^A01'`,
      TEST_TENANT_ID,
    ));
    expect(accepted[0]).toMatchObject({
      status: 'sent',
      transport_state: 'http_response',
      acknowledgement_state: 'aa',
      send_authority: 'authorized',
      msa_code: 'AA',
      correlation_matches: true,
    });
    expect(accepted[0].last_contiguous_message_id).toBeDefined();
    expect(okHit.body).toBe(accepted[0].hl7_payload);
    expect(accepted[0].payload_sha256).toBe(
      createHash('sha256').update(okHit.body, 'utf8').digest('hex'),
    );

    const secondPass = await deliverPendingFeedMessages({ limit: 10, tenantId: TEST_TENANT_ID });
    expect(secondPass.picked).toBe(0);
  });

  test('ORU emission at signoff carries OBX segments', async () => {
    const r = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_results (tenant_id, patient_uid, test_code, test_name, value_numeric, unit, status)
       VALUES ($1::uuid, $2::uuid, 'C2GLU', 'C2TEST-GLU', 7.2, 'mmol/L', 'final')
       RETURNING id`,
      TEST_TENANT_ID,
      patientUid,
    );
    const queued = await emitSignedResultsOru({
      resultIds: [Number(r[0].id)],
      patientUid,
      tenantId: TEST_TENANT_ID,
    });
    expect(queued).toBe(1); // only the /ok receiver listens for ORU^R01

    const rows = await setTenantTx(TEST_TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT m.hl7_payload FROM hl7_outbound_messages m
        JOIN hl7_feed_subscriptions s
          ON s.tenant_id = m.tenant_id AND s.id = m.subscription_id
       WHERE m.tenant_id = $1::uuid
         AND s.name = 'C2TEST receiver' AND m.message_type = 'ORU^R01'`,
      TEST_TENANT_ID,
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0].hl7_payload).toContain('ORU^R01');
    expect(rows[0].hl7_payload).toContain('OBX|1|');
    expect(rows[0].hl7_payload).toContain('7.2');
  });

  test('message list remains available while the retired generic replay route cannot release', async () => {
    const list = await tenantAuthClient('ADMIN')
      .get('/api/v1/hl7-feeds/messages')
      .query({ status: 'reconciliation_required' });
    expect(list.status).toBe(200);
    const failed = list.body.data.messages.find((m) => m.subscription_name === 'C2TEST flaky');
    expect(failed).toBeDefined();

    const before = await setTenantTx(TEST_TENANT_ID, async tx => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT status, send_authority, owner_release_client_event_id::text
           FROM hl7_outbound_messages
          WHERE tenant_id = $1::uuid AND id = $2::integer`,
        TEST_TENANT_ID,
        failed.id,
      );
      return rows[0];
    });

    const replay = await tenantAuthClient('ADMIN')
      .post(`/api/v1/hl7-feeds/messages/${failed.id}/replay`)
      .send({ owner_reason: 'Interface owner reviewed the receiver log and authorized one retry.' });
    expect(replay.status).toBe(404);

    const after = await setTenantTx(TEST_TENANT_ID, async tx => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT status, send_authority, owner_release_client_event_id::text
           FROM hl7_outbound_messages
          WHERE tenant_id = $1::uuid AND id = $2::integer`,
        TEST_TENANT_ID,
        failed.id,
      );
      return rows[0];
    });
    expect(before).toMatchObject({
      status: 'reconciliation_required',
      send_authority: 'held_owner_reconciliation',
      owner_release_client_event_id: null,
    });
    expect(after).toEqual(before);
  });
});
