// Regression test for finding H' D72 (3edd5127).
//
// `GET /api/v1/appointments/patient/:patient_id` IDOR-blocked any
// PATIENT requesting a `:patient_id` that wasn't their own. The
// guardian app, on tap-into-dependent, then either:
//   (a) sent the guardian's id (got the guardian's appointments
//       instead of the dependent's — invisible),
//   (b) sent the dependent's id (got 403 forbidden).
// Neither produced the dependent's appointment list. The patient
// portal's "my dependents → view appointments" tab was completely
// broken.
//
// Fix: PATIENTs may now request another patient's appointments when
// the target's `users.guardian_user_id` matches the requester's id
// AND the target's row is active. Guardians acting on behalf of a
// minor follow the dependents-deep model (users row's
// guardian_user_id FK) already populated by walkin / dependentService
// link flows.
//
// Asserts:
//   * Guardian can list a linked dependent's appointments → 200.
//   * Guardian cannot list a NON-linked patient's appointments → 403.
//   * Patient still gets their own appointments → 200.
//   * Inactive dependent → 403 (cannot mask a deactivated row).

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const STAMP = String(Date.now() % 100000).padStart(5, '0');
const GUARDIAN_UID = 'a8888888-7777-4666-8555-aaaaaaaa9912';
const DEPENDENT_UID = 'a8888888-7777-4666-8555-aaaaaaaa9913';
const INACTIVE_DEPENDENT_UID = 'a8888888-7777-4666-8555-aaaaaaaa9914';
const STRANGER_UID = 'a8888888-7777-4666-8555-aaaaaaaa9915';

let guardianId;
let dependentId;
let inactiveDependentId;
let strangerId;
let guardianToken;

describe('GET /appointments/patient/:patient_id — guardian dependent visibility (H D72)', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      GUARDIAN_UID, DEPENDENT_UID, INACTIVE_DEPENDENT_UID, STRANGER_UID,
    ).catch(() => {});

    const guardian = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9800100${STAMP.slice(-2)}', 'Guardian D72', 'PATIENT', true, NOW())
       RETURNING id`,
      GUARDIAN_UID,
    );
    guardianId = guardian[0].id;
    guardianToken = generateTestToken('PATIENT', { uid: GUARDIAN_UID, id: guardianId });

    const dep = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, guardian_user_id, updated_at)
       VALUES ($1::uuid, '9800200${STAMP.slice(-2)}', 'Dep D72', 'PATIENT', true, $2::int, NOW())
       RETURNING id`,
      DEPENDENT_UID, guardianId,
    );
    dependentId = dep[0].id;

    const inactive = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, guardian_user_id, updated_at)
       VALUES ($1::uuid, '9800300${STAMP.slice(-2)}', 'Inactive Dep D72', 'PATIENT', false, $2::int, NOW())
       RETURNING id`,
      INACTIVE_DEPENDENT_UID, guardianId,
    );
    inactiveDependentId = inactive[0].id;

    const stranger = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9800400${STAMP.slice(-2)}', 'Stranger D72', 'PATIENT', true, NOW())
       RETURNING id`,
      STRANGER_UID,
    );
    strangerId = stranger[0].id;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE id IN ($1::int, $2::int, $3::int, $4::int)`,
      guardianId, dependentId, inactiveDependentId, strangerId,
    ).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('allows a PATIENT-guardian to read a linked dependent\'s appointment list', async () => {
    const res = await request(app)
      .get(`/api/v1/appointments/patient/${dependentId}`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${guardianToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.patient_id).toBe(String(dependentId));
  });

  it('still lets a PATIENT read their OWN appointment list (backward-compatible)', async () => {
    const res = await request(app)
      .get(`/api/v1/appointments/patient/${guardianId}`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${guardianToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.patient_id).toBe(String(guardianId));
  });

  it('returns 403 when the target is NOT a linked dependent', async () => {
    const res = await request(app)
      .get(`/api/v1/appointments/patient/${strangerId}`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${guardianToken}`);
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 when the linked dependent has been deactivated', async () => {
    const res = await request(app)
      .get(`/api/v1/appointments/patient/${inactiveDependentId}`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${guardianToken}`);
    expect(res.statusCode).toBe(403);
  });
});
