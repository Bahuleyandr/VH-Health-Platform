// Roadmap C2 — outbound HL7v2 feeds deep round-trip.
//
// Spins a local HTTP receiver, subscribes it, emits ADT/ORU through the
// hook-facing service functions, runs the delivery worker, and asserts:
// delivery with the HL7 content type, retry/backoff on failures, replay,
// and RBAC on the management surface.

import http from 'node:http';
import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';
import {
  emitAdmissionAdt,
  emitSignedResultsOru,
  deliverPendingFeedMessages,
} from '../services/hl7/hl7OutboundService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TEST_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const PHONE = `+9199916${String(Date.now() % 10000).padStart(4, '0')}`;
let patientUid;
let server;
let baseUrl;
const received = [];
const tenantAuthClient = (role = 'ADMIN') => authClient(role, { tenant_id: TEST_TENANT_ID });

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM hl7_outbound_messages
      WHERE tenant_id = $1::uuid
         OR subscription_id IN (
              SELECT id FROM hl7_feed_subscriptions
               WHERE tenant_id = $1::uuid OR name LIKE 'C2TEST%'
            )`,
    TEST_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM hl7_feed_subscriptions WHERE tenant_id = $1::uuid OR name LIKE 'C2TEST%'`,
    TEST_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM lab_results
      WHERE test_name = 'C2TEST-GLU'
         OR patient_uid IN (SELECT uid FROM users WHERE tenant_id = $1::uuid)`,
    TEST_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE tenant_id = $1::uuid OR name = 'C2TEST Patient'`,
    TEST_TENANT_ID,
  ).catch(() => {});
}

d('Outbound HL7v2 feeds — deep round-trip (roadmap C2)', () => {
  beforeAll(async () => {
    // This suite delivers to a local http.Server on 127.0.0.1, which the H4
    // SSRF guard (utils/ssrfGuard.js) correctly blocks by default. The
    // test-only escape hatch below disables the private-address checks; it
    // is hard-refused in production. The guard's own coverage lives in
    // hl7-ssrf-guard.test.js (which keeps this var unset).
    process.env.HL7_FEED_ALLOW_PRIVATE_TARGETS = 'true';
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, created_at, updated_at)
       VALUES ($1::uuid, 'c2test-hl7', 'C2TEST HL7', 'IN', 'DPDP', 'active', NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET status = 'active', updated_at = NOW()`,
      TEST_TENANT_ID,
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
          res.statusCode = 500;
          res.end('no');
        } else {
          res.statusCode = 200;
          res.end('ACK');
        }
      });
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    delete process.env.HL7_FEED_ALLOW_PRIVATE_TARGETS;
    await cleanup();
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

    const rows = await prisma.$queryRawUnsafe(
      `SELECT m.message_type, m.status, m.hl7_payload FROM hl7_outbound_messages m
        JOIN hl7_feed_subscriptions s ON s.id = m.subscription_id
       WHERE s.name LIKE 'C2TEST%'`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.message_type).toBe('ADT^A01');
      expect(row.status).toBe('queued');
      expect(row.hl7_payload.startsWith('MSH|')).toBe(true);
      expect(row.hl7_payload).toContain('ADT^A01');
    }
  });

  test('delivery worker: success → sent with HL7 content type; failure → backoff', async () => {
    const stats = await deliverPendingFeedMessages({ limit: 10, tenantId: TEST_TENANT_ID });
    expect(stats.picked).toBe(2);
    expect(stats.sent).toBe(1);
    expect(stats.failed).toBe(1);

    const okHit = received.find((r) => r.url === '/ok');
    expect(okHit).toBeDefined();
    expect(okHit.contentType).toBe('x-application/hl7-v2+er7');
    expect(okHit.body.startsWith('MSH|')).toBe(true);

    const failedRows = await prisma.$queryRawUnsafe(
      `SELECT m.status, m.attempts, m.last_error, m.next_attempt_at > NOW() AS backoff_future
         FROM hl7_outbound_messages m
         JOIN hl7_feed_subscriptions s ON s.id = m.subscription_id
        WHERE s.name = 'C2TEST flaky'`,
    );
    expect(failedRows[0].status).toBe('failed');
    expect(failedRows[0].attempts).toBe(1);
    expect(failedRows[0].last_error).toMatch(/HTTP 500/);
    expect(failedRows[0].backoff_future).toBe(true);
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

    const rows = await prisma.$queryRawUnsafe(
      `SELECT m.hl7_payload FROM hl7_outbound_messages m
        JOIN hl7_feed_subscriptions s ON s.id = m.subscription_id
       WHERE s.name = 'C2TEST receiver' AND m.message_type = 'ORU^R01'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].hl7_payload).toContain('ORU^R01');
    expect(rows[0].hl7_payload).toContain('OBX|1|');
    expect(rows[0].hl7_payload).toContain('7.2');
  });

  test('message list + replay surface', async () => {
    const list = await tenantAuthClient('ADMIN')
      .get('/api/v1/hl7-feeds/messages')
      .query({ status: 'failed' });
    expect(list.status).toBe(200);
    const failed = list.body.data.messages.find((m) => m.subscription_name === 'C2TEST flaky');
    expect(failed).toBeDefined();

    const replay = await tenantAuthClient('ADMIN').post(`/api/v1/hl7-feeds/messages/${failed.id}/replay`);
    expect(replay.status).toBe(200);
    expect(replay.body.data.message.status).toBe('queued');

    const nurse = await tenantAuthClient('NURSING_STAFF').post(`/api/v1/hl7-feeds/messages/${failed.id}/replay`);
    expect(nurse.status).toBe(403);
  });
});
