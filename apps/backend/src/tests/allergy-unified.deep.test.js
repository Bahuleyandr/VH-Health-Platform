/**
 * A10-over-HTTP (E5 follow-up) — unified allergies endpoint.
 *
 * The point of this surface: an UN-ADMITTED patient with allergies in the
 * structured store and the profile column must still get a non-empty
 * unified read for a legitimate care-team member. The summary sheet
 * previously read the admission-scoped command-board payload and showed
 * "No allergies recorded". Cleanup removes only rows seeded here;
 * clinical_audit_events is never touched.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'c4444444-4444-4444-8444-444444444a01';
const PATIENT_PHONE = '+919800000441';
const NURSE_UID = 'c4444444-4444-4444-8444-444444444a02';
const OTHER_NURSE_UID = 'c4444444-4444-4444-8444-444444444a03';

jest.setTimeout(60000);

function authed(role, uid) {
  const token = generateTestToken(role, { uid, id: 7202 });
  return {
    get: (path) => request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_access_audit_log WHERE patient_uid = $1::uuid`,
    PATIENT_UID
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM care_team_members WHERE patient_uid = $1::uuid`,
    PATIENT_UID
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM care_teams WHERE patient_uid = $1::uuid`,
    PATIENT_UID
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_allergies WHERE patient_uid = $1::uuid`,
    PATIENT_UID
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
    PATIENT_UID,
    NURSE_UID,
    OTHER_NURSE_UID
  ).catch(() => {});
}

describe('GET /api/v1/allergies/patient/:uid/unified', () => {
  const nurse = authed('NURSING_STAFF', NURSE_UID);
  const unrelatedNurse = authed('NURSING_STAFF', OTHER_NURSE_UID);
  const patient = authed('PATIENT', PATIENT_UID);
  let patientId;

  beforeAll(async () => {
    await cleanup();
    // Un-admitted patient: profile-column allergy + structured rows, NO
    // admissions row at all. Staff access is granted by care-team membership.
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, is_minor, allergies, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Allergy Unified Probe [test]', 'PATIENT', true, false, 'Dust mites, penicillin', $3::uuid, NOW())
       RETURNING id`,
      PATIENT_UID,
      PATIENT_PHONE,
      TENANT_ID
    );
    patientId = rows[0].id;

    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_allergies (patient_id, patient_uid, allergy_name, severity, is_active, tenant_id)
       VALUES ($1, $2::uuid, 'Penicillin', 'SEVERE', true, $3::uuid),
              ($1, $2::uuid, 'Ibuprofen', 'MODERATE', true, $3::uuid),
              ($1, $2::uuid, 'Latex', 'MILD', false, $3::uuid)`,
      patientId,
      PATIENT_UID,
      TENANT_ID
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, '+919800000442', 'Allergy Unified Nurse [test]', 'NURSING_STAFF', true, $2::uuid, NOW()),
              ($3::uuid, '+919800000443', 'Allergy Unified Other Nurse [test]', 'NURSING_STAFF', true, $2::uuid, NOW())`,
      NURSE_UID,
      TENANT_ID,
      OTHER_NURSE_UID
    );

    const careTeam = await prisma.$queryRawUnsafe(
      `INSERT INTO care_teams
         (tenant_id, patient_uid, team_kind, display_name, status, created_by, updated_at)
       VALUES ($1::uuid, $2::uuid, 'longitudinal', 'Allergy unified test care team', 'active', $3::uuid, NOW())
       RETURNING id`,
      TENANT_ID,
      PATIENT_UID,
      NURSE_UID
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO care_team_members
         (tenant_id, care_team_id, patient_uid, staff_uid, staff_role, member_name,
          relationship_kind, break_glass_allowed, created_by, updated_at)
       VALUES ($1::uuid, $2::int, $3::uuid, $4::uuid, 'NURSING_STAFF', 'Allergy Unified Nurse',
               'nurse', false, $4::uuid, NOW())`,
      TENANT_ID,
      careTeam[0].id,
      PATIENT_UID,
      NURSE_UID
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('returns the cross-store union for an UN-admitted patient', async () => {
    const response = await nurse.get(`/api/v1/allergies/patient/${PATIENT_UID}/unified`);
    expect(response.statusCode).toBe(200);

    const { allergies, count } = response.body.data;
    expect(count).toBe(allergies.length);

    const byName = new Map(allergies.map((a) => [a.allergen.toLowerCase(), a]));

    // Case-insensitive merge across stores: profile 'penicillin' +
    // structured 'Penicillin' → one row, severity kept, both sources listed.
    const penicillin = byName.get('penicillin');
    expect(penicillin).toBeTruthy();
    expect(penicillin.severity).toBe('SEVERE');
    expect(penicillin.sources).toEqual(
      expect.arrayContaining(['patient_allergies', 'users.allergies'])
    );

    expect(byName.get('ibuprofen')).toMatchObject({ severity: 'MODERATE' });
    expect(byName.get('dust mites')).toMatchObject({ sources: ['users.allergies'] });

    // Inactive structured rows stay out.
    expect(byName.has('latex')).toBe(false);
    expect(allergies).toHaveLength(3);
  });

  it('keeps unrelated nurses out of unadmitted patient allergies', async () => {
    const response = await unrelatedNurse.get(`/api/v1/allergies/patient/${PATIENT_UID}/unified`);
    expect(response.statusCode).toBe(403);
  });

  it('rejects non-UUID patient refs with 400', async () => {
    const response = await nurse.get('/api/v1/allergies/patient/12345/unified');
    expect(response.statusCode).toBe(400);
  });

  it('keeps patients out of the staff-gated surface', async () => {
    const response = await patient.get(`/api/v1/allergies/patient/${PATIENT_UID}/unified`);
    expect(response.statusCode).toBe(403);
  });
});
