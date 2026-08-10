import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';

const verifyIdTokenMock = jest.fn();
const revokeRefreshTokensMock = jest.fn();

jest.unstable_mockModule('../utils/firebaseAdmin.js', () => ({
  default: {
    auth: () => ({
      verifyIdToken: verifyIdTokenMock,
      revokeRefreshTokens: revokeRefreshTokensMock
    })
  }
}));

const { default: prisma } = await import('../lib/prisma.js');
const { UserService } = await import('../services/user/userService.js');
const { authenticateWithFirebase } = await import('../services/auth/firebaseAuthService.js');

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';

const makeReq = () => ({
  hostname: 'localhost',
  headers: { 'user-agent': 'jest-account-deletion' },
  connection: { remoteAddress: '127.0.0.1' }
});

function makePhone() {
  const suffix = String(Math.floor(Math.random() * 100000000)).padStart(8, '0');
  return `+9198${suffix}`;
}

async function seedPatient() {
  const uid = randomUUID();
  const phone = makePhone();
  const firebaseUid = `fb-delete-${uid}`;

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (
       uid, tenant_id, phone, firebase_uid, name, email, address, role,
       is_active, status, phone_search_hash, phone_encrypted, name_encrypted,
       address_encrypted, device_token, emergency_contact, guardian_name,
       guardian_phone, guardian_relationship, pan_number, abha_address,
       abha_number, updated_at
     )
     VALUES (
       $1::uuid, $2::uuid, $3, $4, 'Delete Me', 'delete-me@example.test',
       'Old Address', 'PATIENT', true, 'active', repeat('a', 64),
       'encrypted-phone', 'encrypted-name', 'encrypted-address', 'device-token',
       '{"phone":"+919900000000"}'::jsonb, 'Guardian', '+919900000001',
       'parent', 'ABCDE1234F', 'patient@abdm', '91-1234-5678-9012', NOW()
     )
     RETURNING id, uid, tenant_id, phone, firebase_uid`,
    uid,
    DEFAULT_TENANT,
    phone,
    firebaseUid
  );

  await prisma.$executeRawUnsafe(
    `INSERT INTO user_devices (
       user_uid, tenant_id, device_id, device_name, platform, fcm_token, last_active, updated_at
     )
     VALUES ($1::uuid, $2::uuid, $3, 'Test phone', 'android', 'fcm-before-delete', NOW(), NOW())`,
    uid,
    DEFAULT_TENANT,
    `device-${uid}`
  );

  return rows[0];
}

async function cleanupPatient(uid) {
  await prisma
    .$executeRawUnsafe('DELETE FROM admissions WHERE patient_uid = $1::uuid', uid)
    .catch(() => {});
  await prisma
    .$executeRawUnsafe('DELETE FROM user_devices WHERE user_uid = $1::uuid', uid)
    .catch(() => {});
  await prisma
    .$executeRawUnsafe('DELETE FROM invalidated_tokens WHERE jti = $1', `user:${uid}`)
    .catch(() => {});
  await prisma.$executeRawUnsafe('DELETE FROM users WHERE uid = $1::uuid', uid).catch(() => {});
}

d('patient account deletion', () => {
  const seededUids = [];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    for (const uid of seededUids.splice(0)) {
      await cleanupPatient(uid);
    }
  });

  afterAll(async () => {
    await prisma.$disconnect().catch(() => {});
  });

  test('anonymizes identity, audits, revokes local sessions, and blocks re-login', async () => {
    const patient = await seedPatient();
    seededUids.push(patient.uid);

    const authTime = Math.floor(Date.now() / 1000);
    const result = await UserService.deleteOwnAccount({
      user: { uid: patient.uid, role: 'PATIENT' },
      firebaseIdToken: 'fresh-firebase-id-token',
      requestId: 'jest-account-delete',
      ipAddress: '127.0.0.1',
      userAgent: 'jest',
      verifyFreshReauth: async () => ({
        uid: patient.firebase_uid,
        phone_number: patient.phone,
        auth_time: authTime
      })
    });

    expect(result).toMatchObject({
      uid: patient.uid,
      deleted: true,
      clinicalRecordsRetained: true
    });

    const users = await prisma.$queryRawUnsafe(
      `SELECT phone, name, email, address, phone_search_hash, phone_encrypted,
              name_encrypted, address_encrypted, device_token, emergency_contact,
              guardian_name, guardian_phone, pan_number, abha_address, abha_number,
              is_active, status, is_deleted, deleted_at, firebase_uid
         FROM users
        WHERE uid = $1::uuid`,
      patient.uid
    );
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      phone: null,
      name: null,
      email: null,
      address: null,
      phone_search_hash: null,
      phone_encrypted: null,
      name_encrypted: null,
      address_encrypted: null,
      device_token: null,
      emergency_contact: null,
      guardian_name: null,
      guardian_phone: null,
      pan_number: null,
      abha_address: null,
      abha_number: null,
      is_active: false,
      status: 'deleted',
      is_deleted: true,
      firebase_uid: patient.firebase_uid
    });
    expect(users[0].deleted_at).toBeTruthy();

    const auditRows = await prisma.$queryRawUnsafe(
      `SELECT action, actor_uid, resource_table, after_state, metadata
         FROM clinical_audit_events
        WHERE idempotency_key = $1`,
      `patient-account-deletion:${patient.uid}`
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'PATIENT_ACCOUNT_DELETED',
      actor_uid: patient.uid,
      resource_table: 'users'
    });
    expect(auditRows[0].after_state).toMatchObject({ is_deleted: true });
    expect(auditRows[0].metadata).toMatchObject({ local_sessions_revoked: true });

    const revokeRows = await prisma.$queryRawUnsafe(
      `SELECT reason FROM invalidated_tokens WHERE jti = $1`,
      `user:${patient.uid}`
    );
    expect(revokeRows).toHaveLength(1);
    // revokeAllUserTokens writes its default reason since the durable-store
    // revocation rework (db78cc56): the account-deletion path passes no
    // per-call reason, so the marker row carries 'revoke_all'.
    expect(revokeRows[0].reason).toBe('revoke_all');

    const deviceRows = await prisma.$queryRawUnsafe(
      `SELECT fcm_token FROM user_devices WHERE user_uid = $1::uuid`,
      patient.uid
    );
    expect(deviceRows).toEqual([expect.objectContaining({ fcm_token: null })]);

    verifyIdTokenMock.mockResolvedValue({
      uid: patient.firebase_uid,
      phone_number: patient.phone,
      auth_time: authTime
    });
    await expect(
      authenticateWithFirebase('fresh-firebase-id-token', null, makeReq(), { deviceType: 'mobile' })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'ACCOUNT_DELETED'
    });
  });

  test('blocks deletion while an active admission is open', async () => {
    const patient = await seedPatient();
    seededUids.push(patient.uid);

    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions (
         tenant_id, patient_uid, status, allergies, admitted_at, updated_at
       )
       VALUES ($1::uuid, $2::uuid, 'admitted', ARRAY[]::text[], NOW(), NOW())`,
      DEFAULT_TENANT,
      patient.uid
    );

    await expect(
      UserService.deleteOwnAccount({
        user: { uid: patient.uid, role: 'PATIENT' },
        firebaseIdToken: 'fresh-firebase-id-token',
        verifyFreshReauth: async () => ({
          uid: patient.firebase_uid,
          phone_number: patient.phone,
          auth_time: Math.floor(Date.now() / 1000)
        })
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'ACTIVE_ADMISSION_BLOCKS_ACCOUNT_DELETION'
    });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT is_deleted, phone, status FROM users WHERE uid = $1::uuid`,
      patient.uid
    );
    expect(rows).toEqual([
      expect.objectContaining({
        is_deleted: false,
        phone: patient.phone,
        status: 'active'
      })
    ]);
  });
});
