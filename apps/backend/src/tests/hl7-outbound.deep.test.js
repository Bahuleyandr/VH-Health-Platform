// Roadmap C2 — outbound HL7v2 feeds deep round-trip.
//
// Spins a local HTTP receiver, subscribes it, emits ADT/ORU through the
// hook-facing service functions, runs the delivery worker, and asserts:
// delivery with the HL7 content type, retry/backoff on failures, and the
// management surface without the retired generic replay authority.

import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import prisma, { setTenantTx } from '../lib/prisma.js';
import getClient, { authClient } from './testClient.js';
import {
  emitAdmissionAdt,
  emitSignedResultsOru,
  emitTransferAdt,
  deliverPendingFeedMessages,
} from '../services/hl7/hl7OutboundService.js';
import { generateACK, parseHL7 } from '../services/hl7/hl7Parser.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TEST_TENANT_ID = randomUUID();
const SUFFIX = TEST_TENANT_ID.slice(0, 8);
const DENIED_QUERY_SENTINEL = `C2TEST-DENIED-${SUFFIX}`;
const ENDPOINT_QUERY_SENTINEL = `C2TEST-ENDPOINT-${SUFFIX}`;
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
    const missingApiKey = await getClient().get('/api/v1/hl7-feeds/subscriptions');
    expect(missingApiKey.status).toBe(401);
    expect(missingApiKey.body).toEqual({ error: 'Missing API Key in request headers' });

    const nurse = await tenantAuthClient('NURSING_STAFF')
      .post('/api/v1/hl7-feeds/subscriptions')
      .send({ name: 'C2TEST nope', endpoint_url: `${baseUrl}/ok` });
    expect(nurse.status).toBe(403);
    const nurseList = await tenantAuthClient('NURSING_STAFF')
      .get('/api/v1/hl7-feeds/subscriptions')
      .query({ authHeader: DENIED_QUERY_SENTINEL });
    expect(nurseList.status).toBe(403);

    const badUrl = await tenantAuthClient('ADMIN')
      .post('/api/v1/hl7-feeds/subscriptions')
      .send({ name: 'C2TEST bad', endpoint_url: 'mllp://1.2.3.4:2575' });
    expect(badUrl.status).toBe(400);

    const ok = await tenantAuthClient('INTEGRATION_ADMIN')
      .post('/api/v1/hl7-feeds/subscriptions')
      .send({ name: 'C2TEST receiver', endpoint_url: `${baseUrl}/ok`, message_types: ['ADT^A01', 'ORU^R01'] });
    expect(ok.status).toBe(201);
    expect(ok.body.data.subscription.tenant_id).toBe(TEST_TENANT_ID);
    expect(ok.body.data.subscription.auth_header_configured).toBe(false);

    const flaky = await tenantAuthClient('ADMIN')
      .post('/api/v1/hl7-feeds/subscriptions')
      .send({ name: 'C2TEST flaky', endpoint_url: `${baseUrl}/fail`, message_types: ['ADT^A01'] });
    expect(flaky.status).toBe(201);
    expect(flaky.body.data.subscription.tenant_id).toBe(TEST_TENANT_ID);
  });

  test('credential-bearing receiver URLs fail closed without storage, audit, or response leakage', async () => {
    const rejected = await tenantAuthClient('INTEGRATION_ADMIN')
      .post('/api/v1/hl7-feeds/subscriptions')
      .send({
        name: 'C2TEST unsafe query receiver',
        endpoint_url: `${baseUrl}/ok?api_key=${ENDPOINT_QUERY_SENTINEL}`,
      });
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe('HL7_FEED_CREDENTIAL_QUERY_FORBIDDEN');
    expect(JSON.stringify(rejected.body)).not.toContain(ENDPOINT_QUERY_SENTINEL);

    const [stored] = await setTenantTx(TEST_TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM hl7_feed_subscriptions
        WHERE tenant_id = $1::uuid AND name = 'C2TEST unsafe query receiver'`,
      TEST_TENANT_ID,
    ));
    expect(stored.count).toBe(0);

    let auditEvidence = { matching_rows: 0, leaked_rows: 0 };
    for (let attempt = 0; attempt < 20 && auditEvidence.matching_rows < 1; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
      [auditEvidence] = await setTenantTx(TEST_TENANT_ID, tx => tx.$queryRawUnsafe(
        `SELECT COUNT(*) FILTER (
                  WHERE COALESCE(request_summary, '') LIKE '%C2TEST unsafe query receiver%'
                )::int AS matching_rows,
                COUNT(*) FILTER (
                  WHERE COALESCE(request_summary, '') LIKE $2
                )::int AS leaked_rows
           FROM audit_log
          WHERE tenant_id = $1::uuid
            AND path = '/api/v1/hl7-feeds/subscriptions'
            AND method = 'POST'`,
        TEST_TENANT_ID,
        `%${ENDPOINT_QUERY_SENTINEL}%`,
      ));
    }
    expect(auditEvidence.matching_rows).toBeGreaterThanOrEqual(1);
    expect(auditEvidence.leaked_rows).toBe(0);

    await setTenantTx(TEST_TENANT_ID, tx => tx.$executeRawUnsafe(
      `INSERT INTO hl7_feed_subscriptions
         (tenant_id, name, endpoint_url, message_types, is_active)
       VALUES ($1::uuid, 'C2TEST legacy query receiver', $2, ARRAY['ADT^A03']::text[], false)`,
      TEST_TENANT_ID,
      `${baseUrl}/ok?api_key=${ENDPOINT_QUERY_SENTINEL}&tenant=one`,
    ));
    const listed = await tenantAuthClient('ADMIN').get('/api/v1/hl7-feeds/subscriptions');
    expect(listed.status).toBe(200);
    const legacy = listed.body.data.subscriptions.find(
      row => row.name === 'C2TEST legacy query receiver',
    );
    expect(legacy.endpoint_url).toContain('api_key=%5BREDACTED%5D&tenant=one');
    expect(() => new URL(legacy.endpoint_url)).not.toThrow();
    expect(JSON.stringify(listed.body)).not.toContain(ENDPOINT_QUERY_SENTINEL);
  });

  test('role-denial security evidence is tenant-attributed and query-redacted', async () => {
    let evidence = { audit_rows: 0, leaked_rows: 0 };
    for (let attempt = 0; attempt < 20 && evidence.audit_rows < 2; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
      [evidence] = await setTenantTx(TEST_TENANT_ID, tx => tx.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS audit_rows,
                COUNT(*) FILTER (WHERE path LIKE $2)::int AS leaked_rows
           FROM audit_log
          WHERE tenant_id = $1::uuid
            AND module = 'security'
            AND action = 'PERMISSION_DENIED'
            AND path LIKE '/api/v1/hl7-feeds/subscriptions%'`,
        TEST_TENANT_ID,
        `%${DENIED_QUERY_SENTINEL}%`,
      ));
    }
    expect(evidence.audit_rows).toBeGreaterThanOrEqual(2);
    expect(evidence.leaked_rows).toBe(0);
  });

  test('upsert omission preserves encrypted credentials and scope; explicit values clear or rotate', async () => {
    const firstSecret = `Bearer C2TEST-FIRST-${randomUUID()}`;
    const secondSecret = `Bearer C2TEST-SECOND-${randomUUID()}`;
    const client = tenantAuthClient('INTEGRATION_ADMIN');

    const created = await client
      .post('/api/v1/hl7-feeds/subscriptions')
      .send({
        name: 'C2TEST credential presence',
        endpoint_url: `${baseUrl}/ok`,
        auth_header: firstSecret,
        message_types: ['ADT^A03'],
      });
    expect(created.status).toBe(201);
    expect(created.body.data.subscription.auth_header_configured).toBe(true);
    expect(JSON.stringify(created.body)).not.toContain(firstSecret);

    const storedAfterCreate = await setTenantTx(TEST_TENANT_ID, async tx => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT auth_header, message_types
           FROM hl7_feed_subscriptions
          WHERE tenant_id = $1::uuid AND name = 'C2TEST credential presence'`,
        TEST_TENANT_ID,
      );
      return rows[0];
    });
    expect(storedAfterCreate.auth_header).toMatch(/^enc:v2:/);
    expect(storedAfterCreate.auth_header).not.toContain(firstSecret);
    expect(storedAfterCreate.message_types).toEqual(['ADT^A03']);

    const omitted = await client
      .post('/api/v1/hl7-feeds/subscriptions')
      .send({
        name: 'C2TEST credential presence',
        endpoint_url: `${baseUrl}/ok`,
      });
    expect(omitted.status).toBe(201);
    expect(omitted.body.data.subscription.auth_header_configured).toBe(true);
    expect(omitted.body.data.subscription.message_types).toEqual(['ADT^A03']);

    const storedAfterOmission = await setTenantTx(TEST_TENANT_ID, async tx => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT auth_header, message_types
           FROM hl7_feed_subscriptions
          WHERE tenant_id = $1::uuid AND name = 'C2TEST credential presence'`,
        TEST_TENANT_ID,
      );
      return rows[0];
    });
    expect(storedAfterOmission.auth_header).toBe(storedAfterCreate.auth_header);
    expect(storedAfterOmission.message_types).toEqual(['ADT^A03']);

    const cleared = await client
      .post('/api/v1/hl7-feeds/subscriptions')
      .send({
        name: 'C2TEST credential presence',
        endpoint_url: `${baseUrl}/ok`,
        auth_header: null,
        message_types: ['ORM^O01'],
      });
    expect(cleared.status).toBe(201);
    expect(cleared.body.data.subscription.auth_header_configured).toBe(false);
    expect(cleared.body.data.subscription.message_types).toEqual(['ORM^O01']);

    const rotated = await client
      .post('/api/v1/hl7-feeds/subscriptions')
      .send({
        name: 'C2TEST credential presence',
        endpoint_url: `${baseUrl}/ok`,
        auth_header: secondSecret,
      });
    expect(rotated.status).toBe(201);
    expect(rotated.body.data.subscription.auth_header_configured).toBe(true);
    expect(rotated.body.data.subscription.message_types).toEqual(['ORM^O01']);
    expect(JSON.stringify(rotated.body)).not.toContain(secondSecret);

    const storedAfterRotation = await setTenantTx(TEST_TENANT_ID, async tx => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT auth_header, message_types
           FROM hl7_feed_subscriptions
          WHERE tenant_id = $1::uuid AND name = 'C2TEST credential presence'`,
        TEST_TENANT_ID,
      );
      return rows[0];
    });
    expect(storedAfterRotation.auth_header).toMatch(/^enc:v2:/);
    expect(storedAfterRotation.auth_header).not.toBe(storedAfterCreate.auth_header);
    expect(storedAfterRotation.auth_header).not.toContain(secondSecret);
    expect(storedAfterRotation.message_types).toEqual(['ORM^O01']);

    const listed = await client.get('/api/v1/hl7-feeds/subscriptions');
    expect(listed.status).toBe(200);
    const listedSubscription = listed.body.data.subscriptions.find(
      row => row.name === 'C2TEST credential presence',
    );
    expect(listedSubscription.auth_header_configured).toBe(true);
    expect(Object.hasOwn(listedSubscription, 'auth_header')).toBe(false);
    expect(JSON.stringify(listed.body)).not.toContain(firstSecret);
    expect(JSON.stringify(listed.body)).not.toContain(secondSecret);

    let auditEvidence = { audit_rows: 0, leaked_rows: 0 };
    for (let attempt = 0; attempt < 20 && auditEvidence.audit_rows < 4; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
      [auditEvidence] = await setTenantTx(TEST_TENANT_ID, tx => tx.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS audit_rows,
                COUNT(*) FILTER (
                  WHERE COALESCE(request_summary, '') LIKE $2
                     OR COALESCE(request_summary, '') LIKE $3
                )::int AS leaked_rows
           FROM audit_log
          WHERE tenant_id = $1::uuid
            AND path = '/api/v1/hl7-feeds/subscriptions'
            AND method = 'POST'`,
        TEST_TENANT_ID,
        `%${firstSecret}%`,
        `%${secondSecret}%`,
      ));
    }
    expect(auditEvidence.audit_rows).toBeGreaterThanOrEqual(4);
    expect(auditEvidence.leaked_rows).toBe(0);

    const deactivated = await client
      .delete(`/api/v1/hl7-feeds/subscriptions/${listedSubscription.id}`);
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.data.subscription.is_active).toBe(false);
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

  test('transfer emission queues ADT^A02 once per bed move, with both locations', async () => {
    // The type must be subscribable through the public management route, not
    // just internally emittable.
    const created = await tenantAuthClient('ADMIN')
      .post('/api/v1/hl7-feeds/subscriptions')
      .send({
        name: 'C2TEST transfers',
        endpoint_url: `${baseUrl}/ok`,
        message_types: ['ADT^A02'],
      });
    expect(created.status).toBe(201);
    expect(created.body.data.subscription.message_types).toEqual(['ADT^A02']);

    const moved = {
      id: 424242,
      patient_uid: patientUid,
      tenant_id: TEST_TENANT_ID,
      ward: 'C2TEST ICU',
      bed_number: 'C2-ICU-1',
      admitted_at: new Date(),
    };

    const firstMove = await emitTransferAdt(moved, {
      transferId: 90001,
      priorWard: 'C2TEST Ward',
      priorBedNumber: 'C2-01',
    });
    expect(firstMove).toBe(1); // only the transfers subscription listens

    // A SECOND move of the SAME admission must also emit. Keyed on the
    // admission it would collide with the first A02 and silently vanish.
    const secondMove = await emitTransferAdt(
      { ...moved, ward: 'C2TEST HDU', bed_number: 'C2-HDU-4' },
      { transferId: 90002, priorWard: 'C2TEST ICU', priorBedNumber: 'C2-ICU-1' },
    );
    expect(secondMove).toBe(1);

    const rows = await setTenantTx(TEST_TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT m.source_table, m.source_id, m.source_event_key, m.hl7_payload,
              m.status, m.transport_state, m.acknowledgement_state, m.send_authority
         FROM hl7_outbound_messages m
         JOIN hl7_feed_subscriptions s
           ON s.tenant_id = m.tenant_id AND s.id = m.subscription_id
        WHERE m.tenant_id = $1::uuid
          AND s.name = 'C2TEST transfers' AND m.message_type = 'ADT^A02'
        ORDER BY m.source_id`,
      TEST_TENANT_ID,
    ));
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.source_event_key)).toEqual([
      'bed_transfers:90001',
      'bed_transfers:90002',
    ]);
    for (const row of rows) {
      expect(row.source_table).toBe('bed_transfers');
      expect(row.hl7_payload).toContain('ADT^A02');
      // Queued only — the four I04 planes start neutral. A queued A02 is not
      // a sent one; the ledger decides that from a correlated MSA|AA.
      expect(row).toMatchObject({
        status: 'queued',
        transport_state: 'not_attempted',
        acknowledgement_state: 'pending',
        send_authority: 'authorized',
      });
    }
    const pv1First = rows[0].hl7_payload.split('\r').find(seg => seg.startsWith('PV1|')).split('|');
    expect(pv1First[3]).toBe('C2TEST ICU^C2-ICU-1');
    expect(pv1First[6]).toBe('C2TEST Ward^C2-01');
    const pv1Second = rows[1].hl7_payload.split('\r').find(seg => seg.startsWith('PV1|')).split('|');
    expect(pv1Second[3]).toBe('C2TEST HDU^C2-HDU-4');
    expect(pv1Second[6]).toBe('C2TEST ICU^C2-ICU-1');
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
