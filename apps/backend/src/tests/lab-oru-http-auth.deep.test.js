import { randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';
import request from 'supertest';

import app from '../app.js';
import prisma from '../lib/prisma.js';
import { issueApiKey, upsertApiClient } from '../services/auth/apiClientService.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIfTestDb = databaseUrl ? describe : describe.skip;
const RUN_ID = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const ACTOR_A = randomUUID();
const ACTOR_B = randomUUID();
const DELETED_ACTOR_A = randomUUID();
const PATIENT_A = randomUUID();
const ANALYZER_A = `ORU-HTTP-${RUN_ID}-A`;
const ANALYZER_B = `ORU-HTTP-${RUN_ID}-B`;
const TEST_CODE = `HTTP${RUN_ID}`;

let actorAId;
let actorBId;
let deletedActorAId;
let investigationId;
let keyA;
let keyB;
let wrongAnalyzerKey;
let unboundKey;

function phoneFor(seed) {
  const numeric = Number.parseInt(seed.replaceAll('-', '').slice(0, 8), 16);
  return `+91${String(numeric).padStart(10, '0').slice(-10)}`;
}

function tokenFor({ uid, id, tenantId }) {
  return jwt.sign(
    {
      uid,
      id,
      phone: phoneFor(uid),
      role: 'LAB_STAFF',
      tenant_id: tenantId,
      deviceType: 'desktop',
    },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function messageFor({ controlId, sender = ANALYZER_A } = {}) {
  return [
    `MSH|^~\\&|${sender}|LAB|VH|VH|20260719120000||ORU^R01|${controlId}|P|2.5`,
    `PID|1||${PATIENT_A}||Patient^HTTP`,
    `OBR|1|VHINV-${investigationId}||${TEST_CODE}^HTTP authentication test`,
    `OBX|1|NM|${TEST_CODE}^HTTP authentication test||4.1|mmol/L|3.5-5.1|N|||F`,
  ].join('\r');
}

function postWithCredentials(path, { key, token, body }) {
  return request(app)
    .post(path)
    .set('x-api-key', key)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

async function artifactCounts(controlId, sender = ANALYZER_A) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT
       (SELECT COUNT(*)::int FROM lab_oru_ingest_messages AS claim
         WHERE claim.tenant_id = $1::uuid
           AND claim.trusted_sender_identity = $2
           AND claim.message_control_id = $3) AS claims,
       (SELECT COUNT(*)::int FROM lab_results AS result
         WHERE result.tenant_id = $1::uuid
           AND result.performed_by_lab = $2
           AND result.hl7_message_id = $3) AS results,
       (SELECT COUNT(*)::int
          FROM lab_critical_alerts AS alert
          JOIN lab_results AS result
            ON result.tenant_id = alert.tenant_id
           AND result.id = alert.result_id
         WHERE result.tenant_id = $1::uuid
           AND result.performed_by_lab = $2
           AND result.hl7_message_id = $3) AS alerts,
       (SELECT COUNT(*)::int
          FROM tasks AS task
          JOIN lab_results AS result
            ON result.tenant_id = task.tenant_id
           AND task.related_resource_type = 'lab_result'
           AND task.related_resource_id = result.id::text
         WHERE result.tenant_id = $1::uuid
           AND result.performed_by_lab = $2
           AND result.hl7_message_id = $3) AS tasks,
       (SELECT COUNT(*)::int
          FROM workflow_sla_instances AS sla
          JOIN lab_results AS result
            ON result.tenant_id = sla.tenant_id
           AND sla.source_table = 'lab_result'
           AND sla.source_id = result.id::text
         WHERE result.tenant_id = $1::uuid
           AND result.performed_by_lab = $2
           AND result.hl7_message_id = $3) AS slas,
       (SELECT COUNT(*)::int
          FROM clinical_timeline_events AS timeline
          JOIN lab_results AS result
            ON result.tenant_id = timeline.tenant_id
           AND timeline.source_table = 'lab_results'
           AND timeline.source_id = result.id::text
         WHERE result.tenant_id = $1::uuid
           AND result.performed_by_lab = $2
           AND result.hl7_message_id = $3) AS timelines,
       (SELECT COUNT(*)::int
          FROM clinical_audit_events AS audit
          JOIN lab_results AS result
            ON result.tenant_id = audit.tenant_id
           AND audit.resource_table = 'lab_results'
           AND audit.resource_id = result.id::text
         WHERE result.tenant_id = $1::uuid
           AND result.performed_by_lab = $2
           AND result.hl7_message_id = $3) AS audits`,
    TENANT_A,
    sender,
    controlId,
  );
  return rows[0];
}

describeIfTestDb('HL7 ORU composed HTTP authentication and transaction boundary', () => {
  beforeAll(async () => {
    await prisma.$queryRawUnsafe(
      `INSERT INTO tenants
         (id, slug, name, region, compliance_profile, status, settings,
          created_at, updated_at)
       VALUES
         ($1::uuid, $3, 'ORU HTTP tenant A', 'IN', 'DPDP', 'active', '{}'::jsonb,
          NOW(), NOW()),
         ($2::uuid, $4, 'ORU HTTP tenant B', 'IN', 'DPDP', 'active', '{}'::jsonb,
          NOW(), NOW())`,
      TENANT_A,
      TENANT_B,
      `oru-http-${RUN_ID.toLowerCase()}-a`,
      `oru-http-${RUN_ID.toLowerCase()}-b`,
    );

    const clientA = await upsertApiClient({
      tenantId: TENANT_A,
      clientCode: `oru-http-${RUN_ID.toLowerCase()}-a`,
      displayName: 'ORU HTTP analyzer A',
    });
    const clientB = await upsertApiClient({
      tenantId: TENANT_B,
      clientCode: `oru-http-${RUN_ID.toLowerCase()}-tenant-b`,
      displayName: 'ORU HTTP tenant B client',
    });
    const clientWrong = await upsertApiClient({
      tenantId: TENANT_A,
      clientCode: `oru-http-${RUN_ID.toLowerCase()}-wrong`,
      displayName: 'ORU HTTP analyzer B client',
    });
    const clientUnbound = await upsertApiClient({
      tenantId: TENANT_A,
      clientCode: `oru-http-${RUN_ID.toLowerCase()}-unbound`,
      displayName: 'ORU HTTP unbound client',
    });
    ({ plaintext: keyA } = await issueApiKey({
      tenantId: TENANT_A,
      apiClientId: clientA.id,
      displayName: 'ORU HTTP analyzer A key',
    }));
    ({ plaintext: keyB } = await issueApiKey({
      tenantId: TENANT_B,
      apiClientId: clientB.id,
      displayName: 'ORU HTTP tenant B key',
    }));
    ({ plaintext: wrongAnalyzerKey } = await issueApiKey({
      tenantId: TENANT_A,
      apiClientId: clientWrong.id,
      displayName: 'ORU HTTP analyzer B key',
    }));
    ({ plaintext: unboundKey } = await issueApiKey({
      tenantId: TENANT_A,
      apiClientId: clientUnbound.id,
      displayName: 'ORU HTTP unbound key',
    }));

    const users = await prisma.$queryRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, is_active, status, is_deleted, updated_at)
       VALUES
         ($1::uuid, $5::uuid, $7, 'ORU HTTP actor A', 'LAB_STAFF', true, 'active', false, NOW()),
         ($2::uuid, $6::uuid, $8, 'ORU HTTP actor B', 'LAB_STAFF', true, 'active', false, NOW()),
         ($3::uuid, $5::uuid, $9, 'ORU HTTP deleted actor', 'LAB_STAFF', true, 'active', true, NOW()),
         ($4::uuid, $5::uuid, $10, 'ORU HTTP patient A', 'PATIENT', true, 'active', false, NOW())
       RETURNING id, uid`,
      ACTOR_A,
      ACTOR_B,
      DELETED_ACTOR_A,
      PATIENT_A,
      TENANT_A,
      TENANT_B,
      phoneFor(ACTOR_A),
      phoneFor(ACTOR_B),
      phoneFor(DELETED_ACTOR_A),
      phoneFor(PATIENT_A),
    );
    actorAId = Number(users.find(row => row.uid === ACTOR_A).id);
    actorBId = Number(users.find(row => row.uid === ACTOR_B).id);
    deletedActorAId = Number(users.find(row => row.uid === DELETED_ACTOR_A).id);
    const patientAId = Number(users.find(row => row.uid === PATIENT_A).id);

    await prisma.$queryRawUnsafe(
      `INSERT INTO lab_analyzers
         (tenant_id, analyzer_code, display_name, interface_kind, status, metadata,
          created_at, updated_at)
       VALUES
         ($1::uuid, $3, $3, 'hl7', 'active',
          jsonb_build_object('hl7_actor_uids', jsonb_build_array($5::text),
                             'hl7_api_client_ids', jsonb_build_array($7::text)),
          NOW(), NOW()),
         ($1::uuid, $4, $4, 'hl7', 'active',
          jsonb_build_object('hl7_api_client_ids', jsonb_build_array($8::text)),
          NOW(), NOW()),
         ($2::uuid, $3, $3, 'hl7', 'active',
          jsonb_build_object('hl7_actor_uids', jsonb_build_array($6::text),
                             'hl7_api_client_ids', jsonb_build_array($9::text)),
          NOW(), NOW())`,
      TENANT_A,
      TENANT_B,
      ANALYZER_A,
      ANALYZER_B,
      ACTOR_A,
      ACTOR_B,
      String(clientA.id),
      String(clientWrong.id),
      String(clientB.id),
    );

    const investigations = await prisma.$queryRawUnsafe(
      `INSERT INTO investigations
         (tenant_id, patient_id, patient_uid, phone, test_name, test_code, test_type,
          status, priority, requested_by, requested_at, updated_at)
        VALUES ($1::uuid, $2::int, $3::uuid, $4, $5, $6, 'blood',
                'REQUESTED', 'ROUTINE', $7::uuid, NOW(), NOW())
        RETURNING id`,
      TENANT_A,
      patientAId,
      PATIENT_A,
      phoneFor(PATIENT_A),
      `${TEST_CODE} HTTP authentication test`,
      TEST_CODE,
      ACTOR_A,
    );
    investigationId = Number(investigations[0].id);
  }, 30000);

  afterAll(async () => {
    await prisma.$disconnect().catch(() => {});
  });

  it('accepts the exact tenant key, JWT actor, and analyzer binding and replays once', async () => {
    const controlId = `SUCCESS-${RUN_ID}`;
    const message = messageFor({ controlId });
    const token = tokenFor({ uid: ACTOR_A, id: actorAId, tenantId: TENANT_A });

    const first = await postWithCredentials('/api/v1/lab/oru/ingest', {
      key: keyA,
      token,
      body: { message },
    });
    expect(first.statusCode).toBe(200);
    expect(first.body?.data).toMatchObject({
      replayed: false,
      bookingId: null,
      investigationId,
    });
    expect(first.body?.data?.results).toHaveLength(1);

    const replay = await postWithCredentials('/api/v1/lab/oru/ingest', {
      key: keyA,
      token,
      body: { message },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body?.data).toMatchObject({
      replayed: true,
      claimId: first.body.data.claimId,
      bookingId: null,
      investigationId,
    });
    expect(replay.body?.data?.results.map(result => Number(result.id)))
      .toEqual(first.body.data.results.map(result => Number(result.id)));
    expect(await artifactCounts(controlId)).toEqual({
      claims: 1,
      results: 1,
      alerts: 0,
      tasks: 0,
      slas: 0,
      timelines: 1,
      audits: 1,
    });
  }, 30000);

  it.each([
    {
      label: 'cross-tenant API key and JWT',
      key: () => keyA,
      token: () => tokenFor({ uid: ACTOR_B, id: actorBId, tenantId: TENANT_B }),
      expectedCode: 'TENANT_API_CLIENT_MISMATCH',
    },
    {
      label: 'same-tenant unbound API key',
      key: () => unboundKey,
      token: () => tokenFor({ uid: ACTOR_A, id: actorAId, tenantId: TENANT_A }),
      expectedCode: 'LAB_ORU_ANALYZER_UNTRUSTED',
    },
    {
      label: 'API key bound to a different analyzer',
      key: () => wrongAnalyzerKey,
      token: () => tokenFor({ uid: ACTOR_A, id: actorAId, tenantId: TENANT_A }),
      expectedCode: 'LAB_ORU_ANALYZER_UNTRUSTED',
    },
    {
      label: 'deleted DB actor',
      key: () => keyA,
      token: () => tokenFor({
        uid: DELETED_ACTOR_A,
        id: deletedActorAId,
        tenantId: TENANT_A,
      }),
      expectedCode: 'LAB_ORU_ACTOR_NOT_AUTHORIZED',
    },
  ])('rejects $label before any clinical write', async ({ label, key, token, expectedCode }) => {
    const controlId = `DENY-${label.replaceAll(/[^A-Za-z0-9]/g, '').slice(0, 24)}-${RUN_ID}`;
    const response = await postWithCredentials('/api/v1/lab/oru/ingest', {
      key: key(),
      token: token(),
      body: { message: messageFor({ controlId }) },
    });
    expect(response.statusCode).toBe(403);
    expect(response.body?.code).toBe(expectedCode);
    expect(JSON.stringify(response.body)).not.toContain(PATIENT_A);
    expect(await artifactCounts(controlId)).toEqual({
      claims: 0,
      results: 0,
      alerts: 0,
      tasks: 0,
      slas: 0,
      timelines: 0,
      audits: 0,
    });
  }, 30000);

  it('rejects HL7 on the legacy generic interface route before either receipt ledger writes', async () => {
    const controlId = `GENERIC-${RUN_ID}`;
    const message = messageFor({ controlId });
    const response = await postWithCredentials('/api/v1/lab/interface/ingest', {
      key: keyA,
      token: tokenFor({ uid: ACTOR_A, id: actorAId, tenantId: TENANT_A }),
      body: { protocol: 'hl7v2', analyzer_code: ANALYZER_A, message },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body?.code).toBe('LAB_INTERFACE_HL7_ROUTE_REQUIRED');
    expect(await artifactCounts(controlId)).toEqual({
      claims: 0,
      results: 0,
      alerts: 0,
      tasks: 0,
      slas: 0,
      timelines: 0,
      audits: 0,
    });
    const interfaceRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM lab_interface_messages
        WHERE tenant_id = $1::uuid AND raw_message = $2`,
      TENANT_A,
      message,
    );
    expect(interfaceRows[0].count).toBe(0);
  }, 30000);

  it('keeps the tenant-B key scoped to its own tenant', async () => {
    const controlId = `TENANTB-${RUN_ID}`;
    const response = await postWithCredentials('/api/v1/lab/oru/ingest', {
      key: keyB,
      token: tokenFor({ uid: ACTOR_A, id: actorAId, tenantId: TENANT_A }),
      body: { message: messageFor({ controlId }) },
    });
    expect(response.statusCode).toBe(403);
    expect(response.body?.code).toBe('TENANT_API_CLIENT_MISMATCH');
    expect(await artifactCounts(controlId)).toEqual({
      claims: 0,
      results: 0,
      alerts: 0,
      tasks: 0,
      slas: 0,
      timelines: 0,
      audits: 0,
    });
  }, 30000);
});
