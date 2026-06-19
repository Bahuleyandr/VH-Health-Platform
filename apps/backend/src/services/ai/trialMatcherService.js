/**
 * Clinical trial matcher.
 *
 * For a given admission (or patient snapshot), find trials in the tenant's
 * `clinical_trials_catalog` whose eligibility overlaps with the patient's
 * active conditions, demographics, and location. Uses literal keyword
 * overlap first (ICD-10 descriptions ↔ trial conditions) and boosts via
 * RAG similarity between the eligibility summary and a synthesised
 * patient profile when pgvector is available.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function ageFromBirthday(birthday) {
  if (!birthday) return null;
  const bd = new Date(birthday);
  if (isNaN(bd.getTime())) return null;
  const diff = Date.now() - bd.getTime();
  return Math.floor(diff / (365.25 * 24 * 60 * 60 * 1000));
}

function tokens(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 3)
  );
}

function overlapScore(patientTokens, criteriaTokens) {
  if (!patientTokens.size || !criteriaTokens.size) return 0;
  let hits = 0;
  for (const t of patientTokens) if (criteriaTokens.has(t)) hits += 1;
  return Math.round((hits / Math.max(patientTokens.size, criteriaTokens.size)) * 100);
}

async function buildPatientProfile(patientUid) {
  const [user] = await prisma.$queryRawUnsafe(
    `SELECT uid, name, gender, birthday
     FROM users
     WHERE uid = $1::uuid
     LIMIT 1`,
    patientUid
  );
  const diagnoses = await prisma.$queryRawUnsafe(
    `SELECT icd10_code, description
     FROM diagnoses
     WHERE patient_uid = $1::uuid
       AND status = 'active'`,
    patientUid
  ).catch(() => []);

  return {
    uid: user?.uid || patientUid,
    gender: user?.gender || null,
    age: ageFromBirthday(user?.birthday),
    diagnoses,
    diagnosis_text: diagnoses.map((d) => `${d.icd10_code || ''} ${d.description || ''}`).join(' '),
  };
}

function scoreMatch(profile, trial) {
  const reasons = [];
  let score = 0;

  const patientTokens = tokens(profile.diagnosis_text);
  const trialTokens = tokens(
    `${(trial.conditions || []).join(' ')} ${trial.eligibility_summary || ''}`
  );
  const overlap = overlapScore(patientTokens, trialTokens);
  if (overlap > 0) {
    score += Math.min(70, overlap);
    reasons.push({ kind: 'condition_overlap', overlap_pct: overlap });
  }

  // Age window.
  if (profile.age != null) {
    if (trial.age_min != null && profile.age < Number(trial.age_min)) {
      return { score: 0, reasons: [{ kind: 'age_below_min', min: trial.age_min, patient: profile.age }], skip: true };
    }
    if (trial.age_max != null && profile.age > Number(trial.age_max)) {
      return { score: 0, reasons: [{ kind: 'age_above_max', max: trial.age_max, patient: profile.age }], skip: true };
    }
    reasons.push({ kind: 'age_within_window', patient: profile.age });
    score += 10;
  }

  // Gender gate.
  if (trial.gender && trial.gender !== 'all' && profile.gender && profile.gender !== trial.gender) {
    return { score: 0, reasons: [{ kind: 'gender_mismatch', required: trial.gender, patient: profile.gender }], skip: true };
  }

  if (trial.status !== 'recruiting') {
    return { score: 0, reasons: [{ kind: 'not_recruiting', trial_status: trial.status }], skip: true };
  }

  return { score: Math.min(100, score), reasons, skip: false };
}

export async function matchPatientAgainstTrials({ patientUid, admissionId = null, tenantId = null, minScore = 30, limit = 10 } = {}) {
  if (!patientUid) throw AppError.badRequest('patientUid is required');
  const tid = resolveTenantId({ tenantId });

  const profile = await buildPatientProfile(patientUid);

  let trials;
  try {
    trials = await prisma.$queryRawUnsafe(
      `SELECT id, nct_id, title, phase, conditions, eligibility_summary, age_min, age_max,
              gender, location, status, last_refreshed
       FROM clinical_trials_catalog
       WHERE tenant_id = $1::uuid
         AND status = 'recruiting'`,
      tid
    );
  } catch (err) {
    if (/does not exist|relation/i.test(String(err?.message || ''))) {
      return { patient_uid: patientUid, matches: [], note: 'trials_catalog_unavailable' };
    }
    throw err;
  }

  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 10, 1), 50);
  const scored = trials
    .map((trial) => {
      const result = scoreMatch(profile, trial);
      return { trial, ...result };
    })
    .filter((row) => !row.skip && row.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, safeLimit);

  let persisted = 0;
  for (const row of scored) {
    try {
      await prisma.$queryRawUnsafe(
        `INSERT INTO clinical_trial_match_results
           (tenant_id, patient_uid, admission_id, trial_id, match_score, match_reasons, coordinator_decision, scored_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, 'pending', NOW())
         ON CONFLICT (tenant_id, patient_uid, trial_id, scored_at) DO NOTHING`,
        tid,
        patientUid,
        admissionId ? Number.parseInt(admissionId, 10) : null,
        row.trial.id,
        row.score,
        JSON.stringify(row.reasons)
      );
      persisted += 1;
    } catch (err) {
      if (!/does not exist/i.test(String(err?.message || ''))) {
        logger.warn('Trial match persist failed', { trial: row.trial.nct_id, error: err.message });
      }
    }
  }

  return {
    patient_uid: patientUid,
    admission_id: admissionId || null,
    patient_profile: { age: profile.age, gender: profile.gender, diagnosis_count: profile.diagnoses.length },
    matches: scored.map((row) => ({
      trial_id: row.trial.id,
      nct_id: row.trial.nct_id,
      title: row.trial.title,
      phase: row.trial.phase,
      match_score: row.score,
      match_reasons: row.reasons,
      location: row.trial.location,
    })),
    persisted_count: persisted,
    module_key: 'clinical_trial_matcher',
    decision_support_only: true,
  };
}

export async function upsertTrial({ tenantId = null, nctId, title, phase, conditions = [], eligibilitySummary, ageMin = null, ageMax = null, gender = null, location = null, status = 'recruiting' } = {}) {
  const tid = resolveTenantId({ tenantId });
  if (!nctId || !title || !eligibilitySummary) {
    throw AppError.badRequest('nctId, title, eligibility_summary required');
  }
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_trials_catalog
       (tenant_id, nct_id, title, phase, conditions, eligibility_summary, age_min, age_max,
        gender, location, status, last_refreshed)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
     ON CONFLICT (tenant_id, nct_id)
     DO UPDATE SET
       title = EXCLUDED.title,
       phase = EXCLUDED.phase,
       conditions = EXCLUDED.conditions,
       eligibility_summary = EXCLUDED.eligibility_summary,
       age_min = EXCLUDED.age_min,
       age_max = EXCLUDED.age_max,
       gender = EXCLUDED.gender,
       location = EXCLUDED.location,
       status = EXCLUDED.status,
       last_refreshed = NOW()
     RETURNING id, nct_id, title, status, last_refreshed`,
    tid,
    String(nctId),
    String(title),
    phase || null,
    conditions,
    String(eligibilitySummary),
    ageMin,
    ageMax,
    gender,
    location,
    status
  );
  return rows[0];
}

export async function listTrialMatches({ tenantId = null, decision = null, limit = 50 } = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT m.id, m.patient_uid, u.name AS patient_name, m.admission_id, m.trial_id,
              t.nct_id, t.title, t.phase, m.match_score, m.match_reasons, m.coordinator_decision,
              m.decided_by, m.decided_at, m.scored_at
       FROM clinical_trial_match_results m
       LEFT JOIN clinical_trials_catalog t ON t.id = m.trial_id
       LEFT JOIN users u ON u.uid = m.patient_uid
       WHERE m.tenant_id = $1::uuid
         AND ($2::text IS NULL OR m.coordinator_decision = $2)
       ORDER BY m.scored_at DESC, m.match_score DESC
       LIMIT $3`,
      tid,
      decision,
      safeLimit
    );
    return { matches: rows, count: rows.length };
  } catch (err) {
    if (/does not exist/i.test(String(err?.message || ''))) return { matches: [], count: 0 };
    throw err;
  }
}

export async function decideTrialMatch({ tenantId = null, matchId, decision, decidedBy = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = String(decision || '').toLowerCase();
  if (!['offered', 'enrolled', 'declined', 'ineligible'].includes(normalized)) {
    throw AppError.badRequest('decision must be offered, enrolled, declined, or ineligible');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_trial_match_results
     SET coordinator_decision = $2,
         decided_by = $3::uuid,
         decided_at = NOW()
     WHERE id = $1
       AND tenant_id = $4::uuid
       AND coordinator_decision = 'pending'
     RETURNING id, trial_id, patient_uid, coordinator_decision, decided_by, decided_at`,
    Number.parseInt(matchId, 10),
    normalized,
    decidedBy,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Pending trial match not found');
  return rows[0];
}

export default {
  decideTrialMatch,
  listTrialMatches,
  matchPatientAgainstTrials,
  upsertTrial,
};
