/**
 * G3 outcome instrumentation — deep round trip.
 *
 * Seeds a synthetic module's generations/reviews/safety-reviews, AI-assisted
 * and baseline signed notes, and medication-safety findings, then asserts the
 * exact numbers the control-plane scoreboard endpoint reports. Uses unique
 * module/note/review-type keys so concurrent suite traffic cannot pollute the
 * grouped counts. Cleanup removes ONLY rows seeded here — clinical_audit_events
 * is append-only by design and is never touched.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const MODULE_KEY = 'g3_scoreboard_probe';
const NOTE_TYPE = 'g3_probe_note';
const MED_REVIEW_TYPE = 'g3_probe_check';
const PATIENT_UID = 'c3333333-3333-4333-8333-333333333a01';
const DOCTOR_UID = 'c3333333-3333-4333-8333-333333333a02';
const ADMIN_UID = 'c3333333-3333-4333-8333-333333333a03';

jest.setTimeout(60000);

function authed(role, uid) {
  const token = generateTestToken(role, { uid, id: 7102 });
  return {
    get: (path) => request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function insertGeneration({ usedAi, draft = {}, createdAtSql = 'NOW()' }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_generations
       (tenant_id, patient_uid, task_type, module_key, provider, model, prompt_version,
        source_hash, status, used_ai, safety_flags, citations, draft,
        prompt_tokens, completion_tokens, total_tokens, metadata, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $3, 'template', 'seed', 'v1',
             $4, 'draft', $5, '[]'::jsonb, '[]'::jsonb, $6::jsonb,
             0, 0, 0, '{"test_seed": true}'::jsonb, ${createdAtSql}, ${createdAtSql})
     RETURNING id`,
    TENANT_ID,
    PATIENT_UID,
    MODULE_KEY,
    `g3-probe-${Math.random().toString(36).slice(2)}`,
    usedAi,
    JSON.stringify(draft)
  );
  return rows[0].id;
}

async function insertReview({ generationId, decision, editedDraft = null }) {
  const decided = decision !== 'pending';
  await prisma.$executeRawUnsafe(
    `INSERT INTO clinical_ai_reviews
       (tenant_id, generation_id, module_key, patient_uid, decision, edited_draft,
        metadata, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6::jsonb, '{"test_seed": true}'::jsonb,
             ${decided ? "NOW() - INTERVAL '30 minutes'" : 'NOW()'}, NOW())`,
    TENANT_ID,
    generationId,
    MODULE_KEY,
    PATIENT_UID,
    decision,
    editedDraft ? JSON.stringify(editedDraft) : null
  );
}

async function insertSafetyReview({ generationId, status }) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO clinical_ai_safety_reviews
       (tenant_id, generation_id, module_key, status, findings, citation_coverage_pct, created_at)
     VALUES ($1::uuid, $2, $3, $4, '[]'::jsonb, 100, NOW())`,
    TENANT_ID,
    generationId,
    MODULE_KEY,
    status
  );
}

async function insertNote({ aiGenerationId = null, createdHoursAgo, signedHoursAgo }) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO clinical_notes
       (tenant_id, patient_uid, note_type, title, content, is_signed, signed_at, signed_by,
        ai_generation_id, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, 'G3 probe note [test]', '{}'::jsonb, true,
             NOW() - ($4::int * INTERVAL '1 hour'), $5::uuid,
             $6, NOW() - ($7::int * INTERVAL '1 hour'), NOW())`,
    TENANT_ID,
    PATIENT_UID,
    NOTE_TYPE,
    signedHoursAgo,
    DOCTOR_UID,
    aiGenerationId,
    createdHoursAgo
  );
}

async function insertMedicationSafetyReview({ overrideRequired, overridden }) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO medication_safety_reviews
       (tenant_id, patient_uid, review_type, severity, status, message,
        override_required, override_reason, overridden_by, overridden_at,
        payload, created_by, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, 'warning', 'G3 probe finding [test]',
             $5, $6, $7::uuid, ${overridden ? 'NOW()' : 'NULL'},
             '{"test_seed": true}'::jsonb, $8::uuid, NOW(), NOW())`,
    TENANT_ID,
    PATIENT_UID,
    MED_REVIEW_TYPE,
    overrideRequired ? 'critical' : 'info',
    overrideRequired,
    overridden ? 'Clinically reviewed, proceeding [test]' : null,
    overridden ? DOCTOR_UID : null,
    DOCTOR_UID
  );
}

describe('AI outcome scoreboard (G3)', () => {
  const admin = authed('ADMIN', ADMIN_UID);
  const doctor = authed('DOCTOR', DOCTOR_UID);

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled)
       VALUES ($1, 'G3 Scoreboard Probe [test]', 'Synthetic module for the scoreboard deep test', false)
       ON CONFLICT (module_key) DO NOTHING`,
      MODULE_KEY
    );

    // g1 accepted but safety-blocked → flag overridden by the human.
    const g1 = await insertGeneration({ usedAi: true });
    await insertReview({ generationId: g1, decision: 'accepted' });
    await insertSafetyReview({ generationId: g1, status: 'blocked' });

    // g2 edited (with edited_draft) and safety-flagged → flag confirmed.
    const g2 = await insertGeneration({ usedAi: true, draft: { summary: 'alpha beta gamma delta' } });
    await insertReview({
      generationId: g2,
      decision: 'edited',
      editedDraft: { summary: 'alpha beta gamma echo' },
    });
    await insertSafetyReview({ generationId: g2, status: 'needs_review' });

    // g3 rejected by the human but passed by the safety reviewer → missed reject.
    const g3 = await insertGeneration({ usedAi: false });
    await insertReview({ generationId: g3, decision: 'rejected' });
    await insertSafetyReview({ generationId: g3, status: 'passed' });

    // g4 still pending, safety-flagged → flagged but undecided.
    const g4 = await insertGeneration({ usedAi: false });
    await insertReview({ generationId: g4, decision: 'pending' });
    await insertSafetyReview({ generationId: g4, status: 'needs_review' });

    // Outside the 90-day window — must not be counted.
    await insertGeneration({ usedAi: true, createdAtSql: "NOW() - INTERVAL '200 days'" });

    // Time-to-sign: two AI-assisted notes signed in 60 minutes vs two
    // baseline notes (same note_type, no ai_generation_id) signed in 120.
    await insertNote({ aiGenerationId: g1, createdHoursAgo: 2, signedHoursAgo: 1 });
    await insertNote({ aiGenerationId: g2, createdHoursAgo: 2, signedHoursAgo: 1 });
    await insertNote({ aiGenerationId: null, createdHoursAgo: 3, signedHoursAgo: 1 });
    await insertNote({ aiGenerationId: null, createdHoursAgo: 3, signedHoursAgo: 1 });

    // Medication safety: one info finding, two blockers, one of them overridden.
    await insertMedicationSafetyReview({ overrideRequired: false, overridden: false });
    await insertMedicationSafetyReview({ overrideRequired: true, overridden: false });
    await insertMedicationSafetyReview({ overrideRequired: true, overridden: true });
  });

  afterAll(async () => {
    // Own seeded rows only — never clinical_audit_events (append-only C4 chain).
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_notes WHERE tenant_id = $1::uuid AND note_type = $2`,
      TENANT_ID,
      NOTE_TYPE
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM medication_safety_reviews WHERE tenant_id = $1::uuid AND review_type = $2`,
      TENANT_ID,
      MED_REVIEW_TYPE
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_ai_safety_reviews WHERE tenant_id = $1::uuid AND module_key = $2`,
      TENANT_ID,
      MODULE_KEY
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_ai_reviews WHERE tenant_id = $1::uuid AND module_key = $2`,
      TENANT_ID,
      MODULE_KEY
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_ai_generations WHERE tenant_id = $1::uuid AND module_key = $2`,
      TENANT_ID,
      MODULE_KEY
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_ai_modules WHERE module_key = $1`,
      MODULE_KEY
    ).catch(() => {});
    await prisma.$disconnect();
  });

  it('rejects clinical (non-control) roles at the control mount', async () => {
    const response = await doctor.get('/api/v1/clinical-ai/control/outcome-scoreboard');
    expect(response.statusCode).toBe(403);
  });

  it('computes the per-module scoreboard with exact counts and honest null rates', async () => {
    const response = await admin.get(
      `/api/v1/clinical-ai/control/outcome-scoreboard?period_days=90&module_key=${MODULE_KEY}`
    );
    expect(response.statusCode).toBe(200);

    const data = response.body.data;
    expect(data.module_key).toBe(MODULE_KEY);
    expect(data.period_days).toBe(90);
    expect(data.decision_support_only).toBe(true);
    expect(data.read_only).toBe(true);
    expect(data.definitions).toHaveProperty('acceptance_rate_pct');

    expect(data.modules).toHaveLength(1);
    const row = data.modules[0];
    expect(row.module_key).toBe(MODULE_KEY);
    expect(row.display_name).toBe('G3 Scoreboard Probe [test]');
    expect(row.enabled).toBe(false);

    // The 200-day-old generation is outside the window.
    expect(row.generations).toEqual({ total: 4, ai_generated: 2, fallback: 2 });

    expect(row.reviews.total).toBe(4);
    expect(row.reviews.decided).toBe(3);
    expect(row.reviews.pending).toBe(1);
    expect(row.reviews.accepted).toBe(1);
    expect(row.reviews.edited).toBe(1);
    expect(row.reviews.rejected).toBe(1);
    expect(row.reviews.acceptance_rate_pct).toBe(33.3);
    expect(row.reviews.used_rate_pct).toBe(66.7);
    expect(row.reviews.avg_review_latency_minutes).toBeGreaterThan(20);
    expect(row.reviews.avg_review_latency_minutes).toBeLessThan(40);

    // One edited draft: 1 substituted word out of 4 → 25%.
    expect(row.edits.sample_count).toBe(1);
    expect(row.edits.mean_edit_distance_pct).toBe(25);
    expect(row.edits.median_edit_distance_pct).toBe(25);

    // 3 flagged (g1 blocked, g2 + g4 needs_review); g1 + g2 decided;
    // g2 confirmed (edited), g1 overridden (accepted); g3 missed reject.
    expect(row.safety.flagged_total).toBe(3);
    expect(row.safety.flagged_decided).toBe(2);
    expect(row.safety.flagged_confirmed).toBe(1);
    expect(row.safety.flagged_overridden).toBe(1);
    expect(row.safety.flag_precision_pct).toBe(50);
    expect(row.safety.flag_override_rate_pct).toBe(50);
    expect(row.safety.missed_reject_count).toBe(1);

    // AI notes signed in ~60 min vs ~120 min baseline → delta ~ -60.
    expect(row.time_to_sign).toHaveLength(1);
    const tts = row.time_to_sign[0];
    expect(tts.note_type).toBe(NOTE_TYPE);
    expect(tts.ai_signed_count).toBe(2);
    expect(tts.baseline_signed_count).toBe(2);
    expect(tts.ai_median_minutes).toBeGreaterThan(55);
    expect(tts.ai_median_minutes).toBeLessThan(65);
    expect(tts.baseline_median_minutes).toBeGreaterThan(115);
    expect(tts.baseline_median_minutes).toBeLessThan(125);
    expect(tts.median_delta_minutes).toBeGreaterThan(-65);
    expect(tts.median_delta_minutes).toBeLessThan(-55);

    // Medication-safety findings are tenant-wide; assert on our probe type.
    const medRow = data.medication_safety.by_type.find((r) => r.review_type === MED_REVIEW_TYPE);
    expect(medRow).toBeTruthy();
    expect(medRow.finding_count).toBe(3);
    expect(medRow.critical_count).toBe(2);
    expect(medRow.blocker_count).toBe(2);
    expect(medRow.overridden_count).toBe(1);
    expect(medRow.override_rate_pct).toBe(50);
  });

  it('serves the same scoreboard on the legacy admin alias', async () => {
    const response = await admin.get(
      `/api/v1/admin/clinical-ai/outcome-scoreboard?module_key=${MODULE_KEY}`
    );
    expect(response.statusCode).toBe(200);
    expect(response.body.data.modules).toHaveLength(1);
    expect(response.body.data.modules[0].module_key).toBe(MODULE_KEY);
  });
});
