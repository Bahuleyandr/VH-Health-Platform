// Roadmap D3 — credentialing & privileging deep round-trip.

import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';
import { hasActivePrivilege } from '../services/staff/credentialingService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

let staffUid;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM staff_credentials WHERE staff_uid IN (SELECT uid FROM users WHERE name = 'D3TEST Doctor')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = 'D3TEST Doctor'`).catch(() => {});
}

d('Credentialing & privileging — deep round-trip (roadmap D3)', () => {
  beforeAll(async () => {
    await cleanup();
    const s = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, updated_at)
       VALUES ($1, 'D3TEST Doctor', 'DOCTOR', true, NOW()) RETURNING uid`,
      `+9199921${String(Date.now() % 10000).padStart(4, '0')}`,
    );
    staffUid = s[0].uid;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('records registration + privilege; doctors cannot self-manage', async () => {
    const doctor = await authClient('DOCTOR')
      .post('/api/v1/credentials')
      .send({ staff_uid: staffUid, credential_type: 'privilege', name: 'CHEMO_ADMINISTER' });
    expect(doctor.status).toBe(403);

    const reg = await authClient('ADMIN')
      .post('/api/v1/credentials')
      .send({
        staff_uid: staffUid, credential_type: 'registration', name: 'TN Medical Council Registration',
        registration_number: 'TNMC-D3-1234', valid_until: '2026-07-01',
      });
    expect(reg.status).toBe(201);

    const priv = await authClient('ADMIN')
      .post('/api/v1/credentials')
      .send({ staff_uid: staffUid, credential_type: 'privilege', name: 'CHEMO_ADMINISTER', valid_until: '2030-01-01' });
    expect(priv.status).toBe(201);

    const dup = await authClient('ADMIN')
      .post('/api/v1/credentials')
      .send({ staff_uid: staffUid, credential_type: 'privilege', name: 'CHEMO_ADMINISTER' });
    expect(dup.status).toBe(409);
  });

  test('privilege check: held, case-insensitive, not-held, revoked', async () => {
    expect((await hasActivePrivilege(staffUid, 'chemo_administer')).allowed).toBe(true);
    expect((await hasActivePrivilege(staffUid, 'OT_OPERATE')).allowed).toBe(false);

    const check = await authClient('DOCTOR')
      .get('/api/v1/credentials/check')
      .query({ staff_uid: staffUid, privilege: 'CHEMO_ADMINISTER' });
    expect(check.status).toBe(200);
    expect(check.body.data.allowed).toBe(true);

    const list = await authClient('ADMIN').get(`/api/v1/credentials/staff/${staffUid}`);
    const privRow = list.body.data.credentials.find((c) => c.name === 'CHEMO_ADMINISTER');
    const revoke = await authClient('ADMIN')
      .patch(`/api/v1/credentials/${privRow.id}/status`)
      .send({ status: 'revoked', notes: 'D3TEST revoked' });
    expect(revoke.status).toBe(200);
    expect((await hasActivePrivilege(staffUid, 'CHEMO_ADMINISTER')).allowed).toBe(false);
  });

  test('expiry radar lists the registration expiring within 60 days', async () => {
    const res = await authClient('ADMIN').get('/api/v1/credentials/expiring').query({ days: 60 });
    expect(res.status).toBe(200);
    const row = res.body.data.credentials.find((c) => c.registration_number === 'TNMC-D3-1234');
    expect(row).toBeDefined();
    expect(row.staff_name).toBe('D3TEST Doctor');
  });
});
