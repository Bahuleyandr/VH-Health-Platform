// AI-2 (WS5 B5.1) authorization proof — DB-backed.
//
// getPublishedAiOutputForPatient() is the single sanctioned read path for
// surfacing a clinical AI output to a patient. This test seeds every NON-
// publishable shape alongside the one publishable shape and proves the
// non-publishable rows are NEVER returned:
//
//   * accepted review + draft generation        → PUBLISHED (the only one)
//   * accepted review + FAILED generation        → withheld (dead-lettered)
//   * pending review + draft generation          → withheld (not signed off)
//   * rejected review + draft generation         → withheld
//   * edited(=not accepted) review + draft       → withheld
//   * accepted review, WRONG tenant              → withheld (tenant scope)
//   * accepted review, WRONG patient             → withheld (patient scope)
//
// It also proves the reviewer-edited draft is what gets published, and that
// internal artefacts (safety_flags, reviewer identity, metadata) are stripped.

import prisma from '../lib/prisma.js';
import { getPublishedAiOutputForPatient } from '../services/ai/clinicalAiWorkflowService.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
// A second real tenant (exists in the QA DB) so the cross-tenant row
// satisfies the tenant_id FK while still being a DIFFERENT tenant.
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const PATIENT_UID = 'c2222222-2222-4222-8222-2222220000a1';
const OTHER_PATIENT_UID = 'c2222222-2222-4222-8222-2222220000a2';
const MODULE_KEY = 'lab_patient_explanation';

async function insertGeneration({ tenantId = TENANT_ID, patientUid = PATIENT_UID, status, draft, citations = [], safetyFlags = [] }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_generations
       (tenant_id, patient_uid, task_type, module_key, provider, model, prompt_version,
        status, used_ai, safety_flags, citations, draft, metadata, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $3, 'template', 'test-model', 'v1',
             $4, false, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, NOW(), NOW())
     RETURNING id`,
    tenantId,
    patientUid,
    MODULE_KEY,
    status,
    JSON.stringify(safetyFlags),
    JSON.stringify(citations),
    JSON.stringify(draft),
    JSON.stringify({ model_tier: 'quick', secret_internal: 'must-not-leak' })
  );
  return rows[0].id;
}

async function insertReview({ tenantId = TENANT_ID, patientUid = PATIENT_UID, generationId, decision, editedDraft = null }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_reviews
       (tenant_id, generation_id, module_key, patient_uid, decision, edited_draft,
        reviewer_uid, reviewer_role, reviewer_note, metadata, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6::jsonb,
             $7::uuid, 'DOCTOR', 'reviewer private note', '{}'::jsonb, NOW(), NOW())
     RETURNING id`,
    tenantId,
    generationId,
    MODULE_KEY,
    patientUid,
    decision,
    editedDraft ? JSON.stringify(editedDraft) : null,
    PATIENT_UID // reuse a uid value for reviewer_uid; arbitrary
  );
  return rows[0].id;
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_ai_reviews WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID, OTHER_PATIENT_UID
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_ai_generations WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID, OTHER_PATIENT_UID
  ).catch(() => {});
}

describe('getPublishedAiOutputForPatient (AI-2 accepted-only enforcement)', () => {
  const seeded = {};

  beforeAll(async () => {
    await cleanup();

    // 1. The ONE publishable row: accepted review + draft generation.
    seeded.acceptedGenId = await insertGeneration({
      status: 'draft',
      draft: { explanation_summary: 'Your blood test is normal.', key_points: [] },
      citations: [{ source_type: 'lab', source_id: 'L1', label: 'CBC' }],
      safetyFlags: [{ severity: 'low', code: 'RAG_UNAVAILABLE' }],
    });
    seeded.acceptedReviewId = await insertReview({
      generationId: seeded.acceptedGenId,
      decision: 'accepted',
    });

    // 2. accepted review but FAILED generation (dead-lettered) → withheld.
    seeded.failedGenId = await insertGeneration({
      status: 'failed',
      draft: { explanation_summary: 'LEAKED FAILED DRAFT' },
    });
    await insertReview({ generationId: seeded.failedGenId, decision: 'accepted' });

    // 3. pending review + draft → withheld.
    seeded.pendingGenId = await insertGeneration({
      status: 'draft',
      draft: { explanation_summary: 'LEAKED PENDING DRAFT' },
    });
    await insertReview({ generationId: seeded.pendingGenId, decision: 'pending' });

    // 4. rejected review + draft → withheld.
    seeded.rejectedGenId = await insertGeneration({
      status: 'draft',
      draft: { explanation_summary: 'LEAKED REJECTED DRAFT' },
    });
    await insertReview({ generationId: seeded.rejectedGenId, decision: 'rejected' });

    // 5. edited (not 'accepted') review + draft → withheld.
    seeded.editedOnlyGenId = await insertGeneration({
      status: 'draft',
      draft: { explanation_summary: 'LEAKED EDITED-ONLY DRAFT' },
    });
    await insertReview({
      generationId: seeded.editedOnlyGenId,
      decision: 'edited',
      editedDraft: { explanation_summary: 'edited but not accepted' },
    });

    // 6. accepted review but WRONG tenant → withheld.
    seeded.otherTenantGenId = await insertGeneration({
      tenantId: OTHER_TENANT_ID,
      status: 'draft',
      draft: { explanation_summary: 'LEAKED CROSS-TENANT DRAFT' },
    });
    await insertReview({
      tenantId: OTHER_TENANT_ID,
      generationId: seeded.otherTenantGenId,
      decision: 'accepted',
    });

    // 7. accepted review but WRONG patient → withheld.
    seeded.otherPatientGenId = await insertGeneration({
      patientUid: OTHER_PATIENT_UID,
      status: 'draft',
      draft: { explanation_summary: 'LEAKED CROSS-PATIENT DRAFT' },
    });
    await insertReview({
      patientUid: OTHER_PATIENT_UID,
      generationId: seeded.otherPatientGenId,
      decision: 'accepted',
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('returns ONLY the accepted + published(draft) generation for the patient', async () => {
    const { outputs, count } = await getPublishedAiOutputForPatient({
      patientUid: PATIENT_UID,
      tenantId: TENANT_ID,
    });
    expect(count).toBe(1);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].generation_id).toBe(seeded.acceptedGenId);
    expect(outputs[0].review_id).toBe(seeded.acceptedReviewId);
    expect(outputs[0].output.explanation_summary).toBe('Your blood test is normal.');
  });

  it('never returns failed / pending / rejected / edited-only rows', async () => {
    const { outputs } = await getPublishedAiOutputForPatient({
      patientUid: PATIENT_UID,
      tenantId: TENANT_ID,
    });
    const serialized = JSON.stringify(outputs);
    expect(serialized).not.toMatch(/LEAKED FAILED DRAFT/);
    expect(serialized).not.toMatch(/LEAKED PENDING DRAFT/);
    expect(serialized).not.toMatch(/LEAKED REJECTED DRAFT/);
    expect(serialized).not.toMatch(/LEAKED EDITED-ONLY DRAFT/);
    const returnedGenIds = outputs.map((o) => o.generation_id);
    expect(returnedGenIds).not.toContain(seeded.failedGenId);
    expect(returnedGenIds).not.toContain(seeded.pendingGenId);
    expect(returnedGenIds).not.toContain(seeded.rejectedGenId);
    expect(returnedGenIds).not.toContain(seeded.editedOnlyGenId);
  });

  it('enforces tenant scope — never returns another tenant\'s accepted row', async () => {
    const { outputs } = await getPublishedAiOutputForPatient({
      patientUid: PATIENT_UID,
      tenantId: TENANT_ID,
    });
    expect(JSON.stringify(outputs)).not.toMatch(/LEAKED CROSS-TENANT DRAFT/);
    expect(outputs.map((o) => o.generation_id)).not.toContain(seeded.otherTenantGenId);
  });

  it('enforces patient scope — never returns another patient\'s accepted row', async () => {
    const { outputs } = await getPublishedAiOutputForPatient({
      patientUid: PATIENT_UID,
      tenantId: TENANT_ID,
    });
    expect(JSON.stringify(outputs)).not.toMatch(/LEAKED CROSS-PATIENT DRAFT/);
    expect(outputs.map((o) => o.generation_id)).not.toContain(seeded.otherPatientGenId);
  });

  it('publishes the reviewer-edited draft when an accepted review edited it', async () => {
    // Seed an accepted review whose generation was edited at sign-off.
    const genId = await insertGeneration({
      status: 'accepted',
      draft: { explanation_summary: 'ORIGINAL pre-edit text' },
    });
    await insertReview({
      generationId: genId,
      decision: 'accepted',
      editedDraft: { explanation_summary: 'EDITED approved text' },
    });

    const { outputs } = await getPublishedAiOutputForPatient({
      patientUid: PATIENT_UID,
      tenantId: TENANT_ID,
    });
    const edited = outputs.find((o) => o.generation_id === genId);
    expect(edited).toBeTruthy();
    expect(edited.output.explanation_summary).toBe('EDITED approved text');
    expect(JSON.stringify(outputs)).not.toMatch(/ORIGINAL pre-edit text/);
  });

  it('strips internal fields (safety_flags, reviewer identity, raw metadata)', async () => {
    const { outputs } = await getPublishedAiOutputForPatient({
      patientUid: PATIENT_UID,
      tenantId: TENANT_ID,
    });
    const published = outputs.find((o) => o.generation_id === seeded.acceptedGenId);
    expect(published).toBeTruthy();
    // Allowed published keys only.
    expect(Object.keys(published).sort()).toEqual(
      ['generation_id', 'model_tier', 'module_key', 'output', 'patient_uid', 'published_at', 'review_id', 'source_citations'].sort()
    );
    expect(published).not.toHaveProperty('safety_flags');
    expect(published).not.toHaveProperty('reviewer_uid');
    expect(published).not.toHaveProperty('reviewer_note');
    expect(published).not.toHaveProperty('metadata');
    expect(published).not.toHaveProperty('status');
    // The internal metadata sentinel must never appear anywhere in the output.
    expect(JSON.stringify(outputs)).not.toMatch(/must-not-leak/);
    expect(JSON.stringify(outputs)).not.toMatch(/reviewer private note/);
  });

  it('filters by moduleKey when supplied', async () => {
    const matching = await getPublishedAiOutputForPatient({
      patientUid: PATIENT_UID,
      tenantId: TENANT_ID,
      moduleKey: MODULE_KEY,
    });
    expect(matching.count).toBeGreaterThanOrEqual(1);

    const nonMatching = await getPublishedAiOutputForPatient({
      patientUid: PATIENT_UID,
      tenantId: TENANT_ID,
      moduleKey: 'some_other_module',
    });
    expect(nonMatching.count).toBe(0);
  });

  it('rejects missing patientUid and missing tenant scope', async () => {
    await expect(getPublishedAiOutputForPatient({ tenantId: TENANT_ID }))
      .rejects.toMatchObject({ code: 'CLINICAL_AI_PUBLISHED_PATIENT_REQUIRED' });
    await expect(getPublishedAiOutputForPatient({ patientUid: PATIENT_UID, tenantId: null }))
      .rejects.toMatchObject({ code: 'CLINICAL_AI_PUBLISHED_TENANT_REQUIRED' });
  });
});
