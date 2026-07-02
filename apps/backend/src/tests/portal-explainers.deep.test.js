import request from 'supertest';

import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const MODULE_KEY = 'lab_patient_explanation';
const PATIENT_UID = 'ea100000-0000-4000-8000-000000000001';
const OTHER_PATIENT_UID = 'ea100000-0000-4000-8000-000000000002';
const SUFFIX = String(Date.now() % 100000).padStart(5, '0');

let patientToken;
let acceptedReviewId;
let pendingReviewId;
let rejectedReviewId;
let otherPatientReviewId;

function patientClient() {
  return {
    get: (path) => request(app)
      .get(path)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${patientToken}`),
  };
}

async function setModuleEnabled(enabled) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO clinical_ai_tenant_modules
       (tenant_id, module_key, enabled, settings, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, '{}'::jsonb, NOW(), NOW())
     ON CONFLICT (tenant_id, module_key)
     DO UPDATE SET enabled = $3, updated_at = NOW()`,
    TENANT_ID,
    MODULE_KEY,
    Boolean(enabled),
  );
}

async function insertGeneration({
  patientUid = PATIENT_UID,
  status = 'accepted',
  summary,
}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_generations
       (tenant_id, patient_uid, task_type, module_key, provider, model,
        prompt_version, status, used_ai, citations, draft, metadata,
        created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $3, 'template', 'test-model',
             'v1', $4, false, $5::jsonb, $6::jsonb, $7::jsonb,
             NOW(), NOW())
     RETURNING id`,
    TENANT_ID,
    patientUid,
    MODULE_KEY,
    status,
    JSON.stringify([{ source_type: 'lab', source_id: 'CBC', label: 'CBC' }]),
    JSON.stringify({ explanation_summary: summary, key_points: [] }),
    JSON.stringify({ model_tier: 'quick' }),
  );
  return rows[0].id;
}

async function insertReview({
  patientUid = PATIENT_UID,
  generationId,
  decision,
}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_reviews
       (tenant_id, generation_id, module_key, patient_uid, decision,
        reviewer_uid, reviewer_role, reviewer_note, metadata, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4::uuid, $5,
             $6::uuid, 'DOCTOR', 'reviewed for patient visibility', '{}'::jsonb, NOW(), NOW())
     RETURNING id`,
    TENANT_ID,
    generationId,
    MODULE_KEY,
    patientUid,
    decision,
    patientUid,
  );
  return rows[0].id;
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_ai_reviews WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID,
    OTHER_PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_ai_generations WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID,
    OTHER_PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_ai_tenant_modules
      WHERE tenant_id = $1::uuid AND module_key = $2`,
    TENANT_ID,
    MODULE_KEY,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID,
    OTHER_PATIENT_UID,
  ).catch(() => {});
}

describe('Portal explainers — accepted patient read surface', () => {
  beforeAll(async () => {
    await cleanup();
    const users = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Portal Explainer Patient', 'PATIENT', true, $5::uuid, NOW()),
              ($3::uuid, $4, 'Portal Explainer Other Patient', 'PATIENT', true, $5::uuid, NOW())
       RETURNING uid, id`,
      PATIENT_UID,
      `98000${SUFFIX}`,
      OTHER_PATIENT_UID,
      `98100${SUFFIX}`,
      TENANT_ID,
    );
    patientToken = generateTestToken('PATIENT', {
      uid: PATIENT_UID,
      id: users.find((u) => String(u.uid) === PATIENT_UID)?.id,
    });

    await setModuleEnabled(true);

    const acceptedGenId = await insertGeneration({
      summary: 'Accepted explainer visible to patient.',
    });
    acceptedReviewId = await insertReview({
      generationId: acceptedGenId,
      decision: 'accepted',
    });

    const pendingGenId = await insertGeneration({
      summary: 'Pending explainer must stay hidden.',
    });
    pendingReviewId = await insertReview({
      generationId: pendingGenId,
      decision: 'pending',
    });

    const rejectedGenId = await insertGeneration({
      summary: 'Rejected explainer must stay hidden.',
    });
    rejectedReviewId = await insertReview({
      generationId: rejectedGenId,
      decision: 'rejected',
    });

    const otherGenId = await insertGeneration({
      patientUid: OTHER_PATIENT_UID,
      summary: 'Other patient explainer must not leak.',
    });
    otherPatientReviewId = await insertReview({
      patientUid: OTHER_PATIENT_UID,
      generationId: otherGenId,
      decision: 'accepted',
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('lists only accepted explainers for the authenticated patient', async () => {
    const res = await patientClient().get('/api/v1/portal/explainers');

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    const ids = res.body.data.map((row) => row.review_id);
    expect(ids).toContain(acceptedReviewId);
    expect(ids).not.toContain(pendingReviewId);
    expect(ids).not.toContain(rejectedReviewId);
    expect(ids).not.toContain(otherPatientReviewId);
    const accepted = res.body.data.find((row) => row.review_id === acceptedReviewId);
    expect(accepted).toMatchObject({
      module_key: MODULE_KEY,
      module_name: 'Lab Result Patient Explanation',
    });
    expect(accepted.draft.explanation_summary).toMatch(/accepted explainer/i);
  });

  it('returns the accepted explainer detail', async () => {
    const res = await patientClient().get(`/api/v1/portal/explainers/${acceptedReviewId}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.review_id).toBe(acceptedReviewId);
    expect(res.body.data.draft.explanation_summary).toMatch(/accepted explainer/i);
  });

  it('404s another patient accepted row', async () => {
    const res = await patientClient().get(`/api/v1/portal/explainers/${otherPatientReviewId}`);

    expect(res.statusCode).toBe(404);
  });

  it('returns an empty list, not 403, when the tenant module is disabled', async () => {
    await setModuleEnabled(false);

    const res = await patientClient().get('/api/v1/portal/explainers');

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
  });
});
