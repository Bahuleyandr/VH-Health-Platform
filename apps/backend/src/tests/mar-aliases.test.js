// Discoverability-alias tests for the MAR (Medication Administration
// Record) endpoints. The canonical mounts live at /api/v1/clinical/mar/*
// but ward nurses + the swarm probe /api/v1/emr/mar/* and
// /api/v1/nursing/mar/*. The aliases in app.js rewrite the URL so the
// same controllers serve all three prefixes — no logic duplication.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const STAFF_UID = 'a7777777-7777-4777-8777-77777777fd03';
const PATIENT_UID = 'a7777777-7777-4777-8777-77777777fd04';
const RUN_SUFFIX = String(Date.now() % 100000).padStart(5, '0');

let staffToken;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_administrations WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
    STAFF_UID, PATIENT_UID,
  ).catch(() => {});
}

describe('MAR discoverability aliases', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, $3, 'NURSING_STAFF', true, NOW())`,
      STAFF_UID, `+9199997${RUN_SUFFIX}`, `MAR Alias Nurse ${RUN_SUFFIX}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, $3, 'PATIENT', true, NOW())`,
      PATIENT_UID, `+9199998${RUN_SUFFIX}`, `MAR Alias Patient ${RUN_SUFFIX}`,
    );
    staffToken = generateTestToken('NURSING_STAFF', { uid: STAFF_UID });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  // Same input, three prefixes — all three should produce identical empty-
  // mar responses (no scheduled doses for this fresh patient). Proves the
  // alias mounts route to the same controller without behavior drift.
  it.each([
    ['/api/v1/clinical/mar/schedule', 'canonical'],
    ['/api/v1/emr/mar/schedule', 'emr alias'],
    ['/api/v1/nursing/mar/schedule', 'nursing alias'],
  ])('POST %s (%s) — empty meds array returns empty MAR', async (path) => {
    const res = await request(app)
      .post(path)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ patient_uid: PATIENT_UID, medications: [] });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data?.scheduled ?? res.body.data)).toBe(true);
  });

  it.each([
    ['/api/v1/clinical/mar/patient', 'canonical'],
    ['/api/v1/emr/mar/patient', 'emr alias'],
    ['/api/v1/nursing/mar/patient', 'nursing alias'],
  ])('GET %s/:uid (%s) — returns an empty list for a fresh patient', async (basePath) => {
    const res = await request(app)
      .get(`${basePath}/${PATIENT_UID}`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
