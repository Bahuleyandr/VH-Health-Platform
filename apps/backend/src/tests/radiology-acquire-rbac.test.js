// Regression test for finding 2026-05-22-dynamic-acute-abdomen-radiology-tech-b90c70d2.
//
// `POST /api/v1/radiology/:id/acquire` accepted any role on the
// module's outer mount (ADMIN / SUPER_ADMIN / DOCTOR / NURSING_STAFF /
// RADIOLOGY_STAFF). An ADMIN token could mark a STAT CT acquired,
// stamp the admin's uid as `acquired_by`/`tech_uid`, and accept the
// request-body `tech_name` verbatim — no license-tied tech identity.
// For a severe acute-abdomen image that's a medico-legal break:
// no verifiable technologist on the chain of custody.
//
// Fix: inner-RBAC at the acquire route restricts to RADIOLOGY_STAFF
// only, and acquisition stamps canonical staff/HPR identity instead of
// trusting request-body free text. Read paths (worklist, report) still
// serve the broader mount.

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const PATIENT_UID = 'ce000000-0000-4000-8000-000000000a01';
const DOCTOR_UID  = 'ce000000-0000-4000-8000-000000000a02';
const RAD_TECH_UID = 'ce000000-0000-4000-8000-000000000a03';
const ADMIN_UID   = 'ce000000-0000-4000-8000-000000000a04';
const NURSE_UID   = 'ce000000-0000-4000-8000-000000000a05';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const API_KEY = process.env.API_KEY || 'test-api-key';

function client(role, uid, intId) {
  const token = generateTestToken(role, { uid, id: intId });
  return {
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

describe('radiology acquire — inner RBAC limits to RADIOLOGY_STAFF (b90c70d2)', () => {
  let orderId;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM radiology_orders WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM abdm_practitioner_mappings WHERE staff_uid = $1::uuid`, RAD_TECH_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM staff WHERE user_id = $1::uuid`, RAD_TECH_UID).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)`,
      PATIENT_UID, DOCTOR_UID, RAD_TECH_UID, ADMIN_UID, NURSE_UID,
    ).catch(() => {});

    const seedUsers = [
      [PATIENT_UID, '9000880001', 'Rad RBAC Patient', 'PATIENT'],
      [DOCTOR_UID,  '9000880002', 'Dr. Rad RBAC', 'DOCTOR'],
      [RAD_TECH_UID, '9000880003', 'Rad Tech RBAC', 'RADIOLOGY_STAFF'],
      [ADMIN_UID,   '9000880004', 'Admin RBAC', 'ADMIN'],
      [NURSE_UID,   '9000880005', 'Nurse RBAC', 'NURSING_STAFF'],
    ];
    for (const [uid, phone, name, role] of seedUsers) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
         VALUES ($1::uuid, $2, $3, $4, true, NOW())`,
        uid, phone, name, role,
      );
    }

    await prisma.$executeRawUnsafe(
      `INSERT INTO staff
         (user_id, employee_id, name, designation, department, skills,
          certifications, is_active, archived, created_at, updated_at)
       VALUES ($1::uuid, 'RAD-D51', 'Rad Tech Canonical', 'Radiology Technologist',
               'Radiology', ARRAY[]::text[], ARRAY[]::text[], true, false, NOW(), NOW())`,
      RAD_TECH_UID,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO abdm_practitioner_mappings
         (tenant_id, staff_uid, hpr_id, full_name, specialty, council_name,
          registration_number, registration_year, qualification, status, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'HPR-D51-RAD-TECH', 'Rad Tech HPR',
               'Radiology', 'Tamil Nadu Paramedical Council', 'RAD-LIC-D51',
               2026, 'BSc Radiography', 'verified', '{}'::jsonb, NOW(), NOW())`,
      TENANT_ID, RAD_TECH_UID,
    );

    const order = await prisma.$queryRawUnsafe(
      `INSERT INTO radiology_orders
         (patient_uid, modality, body_part, clinical_indication,
          priority, status, ordered_by, created_at, updated_at)
       VALUES ($1::uuid, 'ct', 'Abdomen', 'STAT — acute abdomen',
               'stat', 'ordered', $2::uuid, NOW(), NOW())
       RETURNING id`,
      PATIENT_UID, DOCTOR_UID);
    orderId = order[0].id;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM radiology_orders WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM abdm_practitioner_mappings WHERE staff_uid = $1::uuid`, RAD_TECH_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM staff WHERE user_id = $1::uuid`, RAD_TECH_UID).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)`,
      PATIENT_UID, DOCTOR_UID, RAD_TECH_UID, ADMIN_UID, NURSE_UID,
    ).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('rejects ADMIN acquire with 403 (the repro)', async () => {
    const res = await client('ADMIN', ADMIN_UID, 1).post(`/api/v1/radiology/${orderId}/acquire`)
      .send({ tech_name: 'Test Admin, acting radiology tech for QA' });
    expect(res.statusCode).toBe(403);
    expect(String(res.body?.message ?? '')).toMatch(/radiology technologist/i);
  });

  it('rejects DOCTOR acquire with 403', async () => {
    const res = await client('DOCTOR', DOCTOR_UID, 2).post(`/api/v1/radiology/${orderId}/acquire`)
      .send({});
    expect(res.statusCode).toBe(403);
  });

  it('rejects NURSING_STAFF acquire with 403', async () => {
    const res = await client('NURSING_STAFF', NURSE_UID, 3).post(`/api/v1/radiology/${orderId}/acquire`)
      .send({});
    expect(res.statusCode).toBe(403);
  });

  it('ALLOWS RADIOLOGY_STAFF acquire (200) and stamps canonical tech identity/license', async () => {
    const res = await client('RADIOLOGY_STAFF', RAD_TECH_UID, 4).post(`/api/v1/radiology/${orderId}/acquire`)
      .send({ tech_name: 'Spoofed Free Text', tech_license_number: 'FAKE-LIC-D51' });
    expect(res.statusCode).toBe(200);
    expect(res.body?.data?.acquired_by).toBe(RAD_TECH_UID);
    expect(res.body?.data?.tech_uid).toBe(RAD_TECH_UID);
    expect(res.body?.data?.acquired_by_name).toBe('Rad Tech Canonical');
    expect(res.body?.data?.tech_name).toBe('Rad Tech Canonical');
    expect(res.body?.data?.tech_license_number).toBe('RAD-LIC-D51');

    const row = await prisma.$queryRawUnsafe(
      `SELECT acquired_by, acquired_by_name, tech_uid, tech_name, tech_license_number
         FROM radiology_orders
        WHERE id = $1`,
      orderId,
    );
    expect(row[0].acquired_by).toBe(RAD_TECH_UID);
    expect(row[0].tech_uid).toBe(RAD_TECH_UID);
    expect(row[0].tech_name).toBe('Rad Tech Canonical');
    expect(row[0].tech_license_number).toBe('RAD-LIC-D51');
  });
});
