// HL7 /receive per-tenant-secret patient-tenant equality (CAN-021).
//
// When the inbound message is authenticated by a PER-TENANT secret (resolved
// from the receiving facility), the named patient MUST belong to that tenant —
// a tenant-A feed cannot write clinical rows into a tenant-B patient. The
// legacy shared-secret path (hl7-receive-tenant-binding) is unaffected.
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';

import prisma from '../lib/prisma.js';
import hl7Routes from '../routes/hl7/hl7Routes.js';
import { upsertInteropSecret } from '../services/interop/tenantInteropSecretService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const SECRET = 'hl7-can021-per-tenant-secret';
const FACILITY = 'VHFAC-CAN021';
const TENANT_A = 'c0de0210-0000-4000-8000-00000000a001';
const TENANT_B = 'c0de0210-0000-4000-8000-00000000b001';
const PATIENT_A = 'c0de0210-0000-4000-8000-0000000007a1'; // in tenant A
const PATIENT_B = 'c0de0210-0000-4000-8000-0000000007b1'; // in tenant B

function buildApp({ apiClientTenantId = null } = {}) {
  const app = express();
  app.use(express.json());
  if (apiClientTenantId) {
    app.use((req, _res, next) => {
      req.apiClientTenantId = apiClientTenantId;
      next();
    });
  }
  app.use('/api/v1/hl7', hl7Routes);
  return app;
}

function signHeaders({ message, controlId }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const requestId = `hl7-${controlId}-${Date.now()}`;
  const signature = crypto.createHmac('sha256', SECRET)
    .update(`${timestamp}.${requestId}.${message}`)
    .digest('hex');
  return {
    'x-hl7-signature': `sha256=${signature}`,
    'x-hl7-timestamp': String(timestamp),
    'x-hl7-message-id': requestId,
  };
}

function adt(patientUid, controlId) {
  return [
    `MSH|^~\\&|SENDER|SFAC|VH|${FACILITY}|20260101120000||ADT^A01|${controlId}|P|2.5`,
    `PID|1||${patientUid}||HL7 EqTest||19900101|M|||Addr|||+919000210701`,
    'PV1|1|I|WARD-3^^^|||||',
  ].join('\r');
}

async function cleanup() {
  await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid IN ($1::uuid,$2::uuid)`, PATIENT_A, PATIENT_B).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM interop_replay_guard WHERE namespace = 'hl7-inbound'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM tenant_interop_secrets WHERE sender_identifier = $1`, FACILITY).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid)`, PATIENT_A, PATIENT_B).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id IN ($1::uuid,$2::uuid)`, TENANT_A, TENANT_B).catch(() => {});
}

d('HL7 /receive per-tenant patient equality (CAN-021)', () => {
  let app;
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid,'hl7-eq-a','HL7 Eq A'),($2::uuid,'hl7-eq-b','HL7 Eq B')
       ON CONFLICT (id) DO NOTHING`, TENANT_A, TENANT_B);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at) VALUES
        ($1::uuid,$3::uuid,'+919000210701','Pat A','PATIENT',true,NOW()),
        ($2::uuid,$4::uuid,'+919000210702','Pat B','PATIENT',true,NOW())`,
      PATIENT_A, PATIENT_B, TENANT_A, TENANT_B);
    // Per-tenant inbound secret: the receiving facility maps to TENANT A.
    await upsertInteropSecret({ tenantId: TENANT_A, kind: 'hl7_inbound', senderIdentifier: FACILITY, secret: SECRET });
    app = buildApp();
  }, 30000);
  afterAll(async () => { await cleanup(); }, 30000);

  it('rejects a tenant-A-authenticated message naming a tenant-B patient', async () => {
    const controlId = `EQB${Date.now()}`;
    const message = adt(PATIENT_B, controlId);
    const res = await request(app).post('/api/v1/hl7/receive').set(signHeaders({ message, controlId })).send({ message });
    expect(res.status).toBe(404);
    expect(res.text).toContain('MSA|AE');
    const rows = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_B);
    expect(rows[0].n).toBe(0); // nothing written to tenant B
  });

  it('accepts a tenant-A-authenticated message naming a tenant-A patient', async () => {
    const controlId = `EQA${Date.now()}`;
    const message = adt(PATIENT_A, controlId);
    const res = await request(app).post('/api/v1/hl7/receive').set(signHeaders({ message, controlId })).send({ message });
    expect(res.status).toBe(200);
    expect(res.text).toContain('MSA|AA');
    const rows = await prisma.$queryRawUnsafe(`SELECT tenant_id::text AS tenant_id FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_A);
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it('rejects a tenant-B DB API credential before consuming tenant-A replay state', async () => {
    const mismatchedApp = buildApp({ apiClientTenantId: TENANT_B });
    const matchingApp = buildApp({ apiClientTenantId: TENANT_A });
    const controlId = `EQKEY${Date.now()}`;
    const message = adt(PATIENT_A, controlId);
    const headers = signHeaders({ message, controlId });
    const sharedReplayRequestId = [
      headers['x-hl7-message-id'],
      headers['x-hl7-timestamp'],
      headers['x-hl7-signature'].replace(/^sha256=/i, ''),
    ].join(':');
    await prisma.$executeRawUnsafe(
      'DELETE FROM admissions WHERE patient_uid = $1::uuid',
      PATIENT_A,
    );
    const beforeAdmissions = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM admissions WHERE patient_uid = $1::uuid`,
      PATIENT_A,
    );
    const res = await request(mismatchedApp)
      .post('/api/v1/hl7/receive')
      .set(headers)
      .send({ message });

    expect(res.status).toBe(401);
    expect(res.text).toContain('MSA|AR');
    const replayRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM interop_replay_guard
        WHERE namespace = 'hl7-inbound'
          AND request_id = $1`,
      sharedReplayRequestId,
    );
    expect(replayRows[0].count).toBe(0);
    const admissions = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM admissions WHERE patient_uid = $1::uuid`,
      PATIENT_A,
    );
    expect(admissions[0].count).toBe(beforeAdmissions[0].count);

    // The denied credential must not poison the process-local replay cache.
    // Reusing the exact signed envelope with the matching credential should
    // still claim replay state and perform the mutation once.
    const accepted = await request(matchingApp)
      .post('/api/v1/hl7/receive')
      .set(headers)
      .send({ message });
    expect(accepted.status).toBe(200);
    expect(accepted.text).toContain('MSA|AA');

    const afterAccepted = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int
            FROM admissions
           WHERE patient_uid = $1::uuid) AS admission_count,
         (SELECT COUNT(*)::int
            FROM interop_replay_guard
           WHERE namespace = 'hl7-inbound'
             AND request_id = $2) AS replay_count`,
      PATIENT_A,
      sharedReplayRequestId,
    );
    expect(afterAccepted[0]).toEqual({ admission_count: 1, replay_count: 1 });
  });
});
