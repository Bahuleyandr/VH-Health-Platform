// Roadmap D3 — credentialing & privileging deep round-trip.

import prisma from '../lib/prisma.js';
import { authClient, ensureTestIdentity } from './testClient.js';
import { hasActivePrivilege } from '../services/staff/credentialingService.js';
import theatreService from '../services/theatre/theatreService.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

let staffUid;
let patientUid;
// A second, independent approver identity (authClient uses a fixed uid per
// token, so a genuine two-person approval needs a distinct uid override).
const APPROVER_UID = '550e8400-e29b-41d4-a716-4466554400aa';

function datePlus(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events
      WHERE patient_uid IN (SELECT uid FROM users WHERE name IN ('D3TEST Patient'))`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events
      WHERE metadata->>'patient_uid' IN (
        SELECT uid::text FROM users WHERE name IN ('D3TEST Patient')
      )`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM ot_schedules WHERE patient_uid IN (SELECT uid FROM users WHERE name = 'D3TEST Patient')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM credential_expiry_alerts WHERE staff_uid IN (SELECT uid FROM users WHERE name = 'D3TEST Doctor')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM credential_document_uploads WHERE staff_uid IN (SELECT uid FROM users WHERE name = 'D3TEST Doctor')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM approvals
      WHERE approval_kind = 'credential_privilege_grant'
        AND metadata->>'staff_uid' IN (
          SELECT uid::text FROM users WHERE name = 'D3TEST Doctor'
        )`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM staff_credentials WHERE staff_uid IN (SELECT uid FROM users WHERE name = 'D3TEST Doctor')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name IN ('D3TEST Doctor', 'D3TEST Patient')`).catch(() => {});
}

d('Credentialing & privileging — deep round-trip (roadmap D3)', () => {
  // Authentication fails closed when a token's subject has no live identity
  // row, so an invented uid 401s before this suite's authz gate is reached.
  beforeAll(async () => {
    await ensureTestIdentity(APPROVER_UID);
  });
  const originalTheatreGate = process.env.THEATRE_REQUIRE_PRIMARY_SURGEON_PRIVILEGE;

  beforeAll(async () => {
    await cleanup();
    const s = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1, 'D3TEST Doctor', 'DOCTOR', true, $2::uuid, NOW()) RETURNING uid`,
      `+9199921${String(Date.now() % 10000).padStart(4, '0')}`,
      DEFAULT_TENANT_ID,
    );
    staffUid = s[0].uid;
    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1, 'D3TEST Patient', 'PATIENT', true, $2::uuid, NOW()) RETURNING uid`,
      `+9199922${String(Date.now() % 10000).padStart(4, '0')}`,
      DEFAULT_TENANT_ID,
    );
    patientUid = p[0].uid;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  afterEach(() => {
    if (originalTheatreGate === undefined) {
      delete process.env.THEATRE_REQUIRE_PRIMARY_SURGEON_PRIVILEGE;
    } else {
      process.env.THEATRE_REQUIRE_PRIMARY_SURGEON_PRIVILEGE = originalTheatreGate;
    }
  });

  test('privileges flow only through request → approval; direct add is blocked; doctors cannot self-manage', async () => {
    // A rank-and-file doctor cannot manage credentials at all.
    const doctor = await authClient('DOCTOR')
      .post('/api/v1/credentials')
      .send({ staff_uid: staffUid, credential_type: 'privilege', name: 'CHEMO_ADMINISTER' });
    expect(doctor.status).toBe(403);

    // Ordinary evidence (registration) is direct-entry by an admin.
    const reg = await authClient('ADMIN')
      .post('/api/v1/credentials')
      .send({
        staff_uid: staffUid, credential_type: 'registration', name: 'TN Medical Council Registration',
        registration_number: 'TNMC-D3-1234', valid_until: '2026-07-01',
      });
    expect(reg.status).toBe(201);

    // A PRIVILEGE cannot be recorded directly — it must go through approval.
    const directPriv = await authClient('ADMIN')
      .post('/api/v1/credentials')
      .send({ staff_uid: staffUid, credential_type: 'privilege', name: 'CHEMO_ADMINISTER', valid_until: '2030-01-01' });
    expect(directPriv.status).toBe(400);
    expect(JSON.stringify(directPriv.body)).toContain('CRED_PRIVILEGE_REQUIRES_APPROVAL');

    // Two-person grant: requested by one manager, approved by a DIFFERENT person.
    const request = await authClient('ADMIN')
      .post('/api/v1/credentials/privilege-requests')
      .send({ staff_uid: staffUid, privilege: 'CHEMO_ADMINISTER', valid_until: '2030-01-01' });
    expect(request.status).toBe(201);
    const approve = await authClient('MEDICAL_SUPERINTENDENT', { uid: APPROVER_UID })
      .post(`/api/v1/credentials/approvals/${request.body.data.approval.id}/decide`)
      .send({ decision: 'approved' });
    expect(approve.status).toBe(200);
    expect((await hasActivePrivilege(staffUid, 'chemo_administer')).allowed).toBe(true);
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
    const privRow = list.body.data.credentials.find((c) => c.name === 'chemo_administration');
    const revoke = await authClient('ADMIN')
      .patch(`/api/v1/credentials/${privRow.id}/status`)
      .send({ status: 'revoked', notes: 'D3TEST revoked' });
    expect(revoke.status).toBe(200);
    expect((await hasActivePrivilege(staffUid, 'CHEMO_ADMINISTER')).allowed).toBe(false);
  });

  test('two-person integrity: self-approval blocked; privilege cannot be re-activated via status change', async () => {
    const req = await authClient('ADMIN')
      .post('/api/v1/credentials/privilege-requests')
      .send({ staff_uid: staffUid, privilege: 'anesthesia_finalize', valid_until: '2030-01-01' });
    expect(req.status).toBe(201);

    // The SAME person who requested cannot approve it.
    const selfApprove = await authClient('ADMIN')
      .post(`/api/v1/credentials/approvals/${req.body.data.approval.id}/decide`)
      .send({ decision: 'approved' });
    expect(selfApprove.status).toBe(403);
    expect(JSON.stringify(selfApprove.body)).toContain('CRED_SELF_APPROVAL_FORBIDDEN');

    // An independent approver can (the approval stays pending after the block).
    const approve = await authClient('CMO', { uid: APPROVER_UID })
      .post(`/api/v1/credentials/approvals/${req.body.data.approval.id}/decide`)
      .send({ decision: 'approved' });
    expect(approve.status).toBe(200);

    // The privilege may be suspended, but NOT re-activated via a status change.
    const list = await authClient('ADMIN').get(`/api/v1/credentials/staff/${staffUid}`);
    const anesPriv = list.body.data.credentials.find((c) => c.name === 'anesthesia_finalize');
    expect(anesPriv).toBeDefined();
    const suspend = await authClient('ADMIN')
      .patch(`/api/v1/credentials/${anesPriv.id}/status`)
      .send({ status: 'suspended' });
    expect(suspend.status).toBe(200);
    const reactivate = await authClient('ADMIN')
      .patch(`/api/v1/credentials/${anesPriv.id}/status`)
      .send({ status: 'active' });
    expect(reactivate.status).toBe(403);
    expect(JSON.stringify(reactivate.body)).toContain('CRED_PRIVILEGE_ACTIVATION_VIA_APPROVAL');
  });

  test('expiry radar lists the registration expiring within 60 days', async () => {
    const res = await authClient('ADMIN').get('/api/v1/credentials/expiring').query({ days: 60 });
    expect(res.status).toBe(200);
    const row = res.body.data.credentials.find((c) => c.registration_number === 'TNMC-D3-1234');
    expect(row).toBeDefined();
    expect(row.staff_name).toBe('D3TEST Doctor');
  });

  test('grant approval activates theatre gate; revoke blocks; flag off bypasses', async () => {
    const request = await authClient('ADMIN')
      .post('/api/v1/credentials/privilege-requests')
      .send({
        staff_uid: staffUid,
        privilege: 'primary_surgeon',
        valid_until: '2030-01-01',
      });
    expect(request.status).toBe(201);

    const approval = await authClient('MEDICAL_SUPERINTENDENT', { uid: APPROVER_UID })
      .post(`/api/v1/credentials/approvals/${request.body.data.approval.id}/decide`)
      .send({ decision: 'approved' });
    expect(approval.status).toBe(200);

    process.env.THEATRE_REQUIRE_PRIMARY_SURGEON_PRIVILEGE = 'true';
    const scheduled = await theatreService.scheduleSurgery({
      tenantId: DEFAULT_TENANT_ID,
      patient_uid: patientUid,
      surgeon: staffUid,
      procedure_name: 'D3TEST laparoscopic cholecystectomy',
      ot_room: `D3TEST-${Date.now()}`,
      scheduled_date: datePlus(14),
      scheduled_time: '09:00',
      estimated_duration: 45,
    });
    expect(scheduled.id).toBeDefined();

    const list = await authClient('ADMIN').get(`/api/v1/credentials/staff/${staffUid}`);
    const privRow = list.body.data.credentials.find((c) => c.name === 'primary_surgeon');
    expect(privRow).toBeDefined();
    const revoke = await authClient('ADMIN')
      .patch(`/api/v1/credentials/${privRow.id}/status`)
      .send({ status: 'revoked', notes: 'D3TEST revoke primary surgeon' });
    expect(revoke.status).toBe(200);

    await expect(theatreService.scheduleSurgery({
      tenantId: DEFAULT_TENANT_ID,
      patient_uid: patientUid,
      surgeon: staffUid,
      procedure_name: 'D3TEST blocked case',
      ot_room: `D3TEST-BLOCK-${Date.now()}`,
      scheduled_date: datePlus(15),
      scheduled_time: '10:00',
      estimated_duration: 30,
    })).rejects.toMatchObject({ code: 'CLINICAL_PRIVILEGE_REQUIRED' });

    process.env.THEATRE_REQUIRE_PRIMARY_SURGEON_PRIVILEGE = '';
    const bypass = await theatreService.scheduleSurgery({
      tenantId: DEFAULT_TENANT_ID,
      patient_uid: patientUid,
      surgeon: staffUid,
      procedure_name: 'D3TEST flag-off case',
      ot_room: `D3TEST-OFF-${Date.now()}`,
      scheduled_date: datePlus(16),
      scheduled_time: '11:00',
      estimated_duration: 30,
    });
    expect(bypass.id).toBeDefined();
  });
});
