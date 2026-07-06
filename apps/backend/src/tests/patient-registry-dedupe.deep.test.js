import request from 'supertest';

import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const STAFF_UID = '77777777-7777-4777-8777-77777777fd04';
const EXISTING_UID = '88888888-8888-4888-8888-88888888fd04';
const RUN_SUFFIX = String(Date.now() % 100000).padStart(5, '0');
const EXISTING_PHONE = `98881${RUN_SUFFIX}`;
const NEW_PHONE = `98882${RUN_SUFFIX}`;
const PHONE_FORMS = [
  EXISTING_PHONE,
  `+91${EXISTING_PHONE}`,
  NEW_PHONE,
  `+91${NEW_PHONE}`,
];

function client() {
  const token = generateTestToken('RECEPTIONIST', {
    uid: STAFF_UID,
    id: 777004,
    tenantId: TENANT_ID,
    tenant_id: TENANT_ID,
  });
  return {
    post: (path) => request(app)
      .post(path)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`),
  };
}

async function cleanupFixtures() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid
       FROM users
      WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)
         OR phone = ANY($4::text[])`,
    STAFF_UID,
    EXISTING_UID,
    '99999999-9999-4999-8999-99999999fd04',
    PHONE_FORMS,
  ).catch(() => []);
  const uids = rows.map((row) => row.uid);
  if (uids.length > 0) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM patient_duplicate_candidates
        WHERE primary_uid = ANY($1::uuid[])
           OR secondary_uid = ANY($1::uuid[])`,
      uids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM audit_logs
        WHERE uid = $1::uuid
           OR actor_uid = $1::uuid
           OR resource_id = ANY($2::text[])`,
      STAFF_UID,
      uids.map(String),
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM users
      WHERE uid = $1::uuid
         OR uid = $2::uuid
         OR phone = ANY($3::text[])`,
    STAFF_UID,
    EXISTING_UID,
    PHONE_FORMS,
  ).catch(() => {});
}

describe('POST /api/v1/patients registration dedupe', () => {
  beforeAll(async () => {
    await cleanupFixtures();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, phone, name, role, is_active, tenant_id, birthday, gender,
          abha_address, registered_at, updated_at)
       VALUES
         ($1::uuid, $2, 'NL4 Near Match Patient', 'PATIENT', true, $3::uuid,
          '1990-04-12'::date, 'female', 'nearmatch@abdm', NOW(), NOW()),
         ($4::uuid, '+919888800404', 'NL4 Front Desk Staff', 'RECEPTIONIST',
          true, $3::uuid, NULL, NULL, NULL, NOW(), NOW())`,
      EXISTING_UID,
      `+91${EXISTING_PHONE}`,
      TENANT_ID,
      STAFF_UID,
    );
  });

  afterAll(async () => {
    await cleanupFixtures();
  });

  it('blocks a seeded near-match and audits create-anyway reason', async () => {
    const first = await client().post('/api/v1/patients').send({
      name: 'NL4 Near Match Patient',
      phone: NEW_PHONE,
      birthday: '1990-04-12',
      gender: 'Female',
    });

    expect(first.status).toBe(409);
    expect(first.body).toMatchObject({
      success: false,
      code: 'PATIENT_DUPLICATE_REVIEW_REQUIRED',
      details: {
        duplicate_review_required: true,
        candidates: [{
          uid: EXISTING_UID,
          confidence_band: 'medium',
          abha_masked: 'ne***@abdm',
        }],
      },
    });

    const create = await client().post('/api/v1/patients').send({
      name: 'NL4 Near Match Patient',
      phone: NEW_PHONE,
      birthday: '1990-04-12',
      gender: 'Female',
      duplicate_override_reason: 'Verified separate patient with government ID',
    });

    expect(create.status).toBe(201);
    const newUid = create.body.data.patient.uid;
    expect(create.body.data.patient.phone).toBe(`+91${NEW_PHONE}`);

    const auditRows = await prisma.$queryRawUnsafe(
      `SELECT action, metadata
         FROM audit_logs
        WHERE action = 'FRONT_OFFICE_PATIENT_DUPLICATE_OVERRIDE'
          AND resource_id = $1
        ORDER BY id DESC
        LIMIT 1`,
      newUid,
    );
    expect(auditRows[0]).toBeTruthy();
    expect(auditRows[0].metadata.reason).toBe(
      'Verified separate patient with government ID',
    );

    const [primaryUid, secondaryUid] = [EXISTING_UID, newUid].sort();
    const candidateRows = await prisma.$queryRawUnsafe(
      `SELECT status, decision_note, decided_by
         FROM patient_duplicate_candidates
        WHERE tenant_id = $1::uuid
          AND primary_uid = $2::uuid
          AND secondary_uid = $3::uuid
        LIMIT 1`,
      TENANT_ID,
      primaryUid,
      secondaryUid,
    );
    expect(candidateRows[0]).toMatchObject({
      status: 'rejected_not_duplicate',
      decision_note: 'Verified separate patient with government ID',
      decided_by: STAFF_UID,
    });
  });
});
