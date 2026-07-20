// C-4 (interop) — HL7 /receive inbound tenant binding.
//
// loadHl7Patient resolved the patient by uid with NO tenant scope, then wrote
// admissions / investigations / lab-results on plain prisma (GUC unset). Under
// RLS that means the write lands via the permissive branch and the tenant_id
// column DEFAULT (literal default tenant) can stamp a NON-default patient's
// clinical row into the WRONG tenant — cross-tenant clinical-integrity injection
// under one shared HL7_INBOUND_SHARED_SECRET.
//
// The fix scopes the resolve + every write under the patient's own tenant via
// setTenant(tenant, …). This proves ADT remains tenant-bound and that the
// legacy HMAC-only ORU writer is rejected without creating a partial result;
// analyzer results must use the authenticated lab-ingest contract.
//
// Needs the test Postgres. Self-skips when unconfigured.

import crypto from 'crypto';
import express from 'express';
import request from 'supertest';

import prisma from '../lib/prisma.js';
import hl7Routes from '../routes/hl7/hl7Routes.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const SECRET = 'hl7-tenant-binding-test-secret';
const TENANT_B = 'b7100000-0000-4000-8000-00000000b001';
const TENANT_SLUG = 'hl7-tenant-binding-b';
const PATIENT_UID = 'b7100000-0000-4000-8000-0000000007b1';
const PATIENT_PHONE = '+919000070701';

function buildApp() {
  const app = express();
  app.use(express.json());
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

async function cleanup() {
  await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM investigations WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM interop_replay_guard WHERE namespace = 'hl7-inbound'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_B).catch(() => {});
}

d('HL7 /receive tenant binding (C-4)', () => {
  let app;
  let prevSecret;

  beforeAll(async () => {
    prevSecret = process.env.HL7_INBOUND_SHARED_SECRET;
    process.env.HL7_INBOUND_SHARED_SECRET = SECRET;
    await cleanup();
    // A dedicated NON-default tenant for this test.
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, 'HL7 Tenant Binding B')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_B, TENANT_SLUG,
    );
    // Patient lives in that NON-default tenant.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'HL7 Tenant Patient', 'PATIENT', true, NOW())`,
      PATIENT_UID, TENANT_B, PATIENT_PHONE,
    );
    app = buildApp();
  }, 30000);

  afterAll(async () => {
    await cleanup();
    if (prevSecret === undefined) delete process.env.HL7_INBOUND_SHARED_SECRET;
    else process.env.HL7_INBOUND_SHARED_SECRET = prevSecret;
    // prisma.$disconnect() is handled by the global jest teardown.
  }, 30000);

  test('ADT^A01 admission is written under the patient tenant, not the default', async () => {
    const controlId = `ADT${Date.now()}`;
    const message = [
      `MSH|^~\\&|SENDER|SFAC|VH|VHFAC|20260101120000||ADT^A01|${controlId}|P|2.5`,
      `PID|1||${PATIENT_UID}||HL7 Tenant Patient||19900101|M|||Addr|||${PATIENT_PHONE}`,
      'PV1|1|I|WARD-3^^^|||||',
    ].join('\r');

    const res = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signHeaders({ message, controlId }))
      .send({ message });

    expect(res.status).toBe(200);
    expect(res.text).toContain('MSA|AA');

    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id, status FROM admissions WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_B);
  });

  test('ORU^R01 is rejected without a legacy investigation/result write', async () => {
    const controlId = `ORU${Date.now()}`;
    const message = [
      `MSH|^~\\&|LAB|LFAC|VH|VHFAC|20260101130000||ORU^R01|${controlId}|P|2.5`,
      `PID|1||${PATIENT_UID}||HL7 Tenant Patient||19900101|M|||Addr|||${PATIENT_PHONE}`,
      'OBR|1||ORDER-1|CBC^Complete Blood Count|||20260101130000',
      'OBX|1|NM|718-7^Hemoglobin||13.5|g/dL|13-17|N|||F',
    ].join('\r');

    const res = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signHeaders({ message, controlId }))
      .send({ message });

    expect(res.status).toBe(200);
    expect(res.text).toContain('MSA|AE');
    expect(res.text).toContain('Use authenticated lab ORU ingestion');

    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id, status FROM investigations WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    expect(rows).toHaveLength(0);
  });

  test('an unknown patient is rejected with an HL7 AE (not written to any tenant)', async () => {
    const controlId = `ADT404${Date.now()}`;
    const unknownUid = 'b7100000-0000-4000-8000-000000000404';
    const message = [
      `MSH|^~\\&|SENDER|SFAC|VH|VHFAC|20260101120000||ADT^A01|${controlId}|P|2.5`,
      `PID|1||${unknownUid}||No Such Patient||19900101|M`,
      'PV1|1|I|WARD-1^^^|||||',
    ].join('\r');

    const res = await request(app)
      .post('/api/v1/hl7/receive')
      .set(signHeaders({ message, controlId }))
      .send({ message });

    expect(res.status).toBe(404);
    expect(res.text).toContain('MSA|AE');
  });
});
