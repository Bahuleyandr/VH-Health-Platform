/**
 * Patient duplicate detection (Phase A2 PR2).
 *
 * Scans patient_identifiers for cases where two ACTIVE identifier rows
 * with the same (identifier_type, identifier_value) belong to different
 * patient_uids — the strongest signal of a duplicate-record problem.
 * Each pair is written to patient_duplicate_candidates with status='open'
 * unless an open / merged candidate already exists for the same pair.
 *
 * The audit calls out three additional detection signals (name + DOB,
 * phonetic name match, mobile match without identifier collision). They
 * land as future passes — the v1 detector keeps the false-positive rate
 * close to zero by sticking to identifier collisions.
 *
 * Decision-support only: the detector NEVER auto-merges. Candidates
 * surface to the dedupe queue where an admin requests + approves a
 * merge through patientMergeService.
 */

import crypto from 'crypto';

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_REGISTRATION_LIMIT = 5;

const CANDIDATE_STATUSES = ['open', 'merged', 'rejected_not_duplicate', 'expired'];

const IDENTIFIER_CONFIDENCE_BY_TYPE = {
  abha: 95,
  abha_address: 95,
  aadhaar_token: 95,
  national_id: 92,
  passport: 90,
  mrn: 88,
  uhid: 88,
  insurance: 80,
  tpa_card: 75,
  employee_id: 70,
  external_emr: 80,
  mobile: 70,
  driving_license: 75,
  other: 60,
};

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function normalizeLimit(value, fallback = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
}

function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function last10Phone(value) {
  const digits = digitsOnly(value);
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function normalizePersonName(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeDateText(value) {
  const raw = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function normalizeAbha(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw.length >= 4 ? raw : null;
}

function maskAbha(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const at = raw.indexOf('@');
  if (at > 1) {
    return `${raw.slice(0, 2)}***${raw.slice(at)}`;
  }
  return raw.length <= 4 ? '****' : `${raw.slice(0, 2)}***${raw.slice(-2)}`;
}

function confidenceBand(score) {
  const value = Number(score || 0);
  if (value >= 90) return 'high';
  if (value >= 75) return 'medium';
  return 'low';
}

function publicRegistrationCandidate(row) {
  const score = Number(row.confidence_score || 0);
  return {
    id: row.id,
    uid: row.uid,
    name: row.name,
    phone: row.phone,
    gender: row.gender,
    birthday: row.birthday,
    age: row.age,
    hospital_number: row.hospital_number,
    profile_picture: row.profile_picture,
    abha_masked: row.abha_masked ?? maskAbha(row.abha_address),
    confidence_score: score,
    confidence_band: confidenceBand(score),
    match_signals: row.match_signals || {},
  };
}

/**
 * Confidence is keyed by the strongest matching identifier type. ABHA,
 * Aadhaar, and national IDs are unique by construction so collisions on
 * those types score highest; mobile / insurance / employee_id score
 * lower because those values legitimately can be reused (one phone,
 * many family members on a TPA card, etc).
 */
export function confidenceForIdentifierType(type) {
  return IDENTIFIER_CONFIDENCE_BY_TYPE[String(type || '').toLowerCase()] ?? 60;
}

export async function findRegistrationDuplicateCandidates({
  tenantId = null,
  name = null,
  phone = null,
  birthday = null,
  abhaAddress = null,
  limit = DEFAULT_REGISTRATION_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const nameKey = normalizePersonName(name) || null;
  const phoneKey = last10Phone(phone);
  const birthdayKey = normalizeDateText(birthday);
  const abhaKey = normalizeAbha(abhaAddress);
  const safeLimit = normalizeLimit(limit, DEFAULT_REGISTRATION_LIMIT, 10);

  if (!nameKey && !phoneKey && !abhaKey) {
    return { candidates: [], count: 0 };
  }

  const rows = await prisma.$queryRawUnsafe(
    `WITH input AS (
       SELECT $2::text AS name_key,
              $3::text AS phone_last10,
              $4::date AS birthday,
              $5::text AS abha_key
     )
     SELECT u.id, u.uid, u.name, u.phone, u.gender, u.birthday,
            u.abha_address, u.profile_picture,
            COALESCE(hn.identifier_value, 'VH-' || LPAD(u.id::text, 6, '0')) AS hospital_number,
            CASE WHEN u.birthday IS NOT NULL
                 THEN DATE_PART('year', AGE(u.birthday))::int
            END AS age,
            CASE
              WHEN input.abha_key IS NOT NULL
                   AND LOWER(COALESCE(u.abha_address, '')) = input.abha_key THEN 96
              WHEN input.phone_last10 IS NOT NULL
                   AND RIGHT(REGEXP_REPLACE(COALESCE(u.phone, ''), '\\D', '', 'g'), 10) = input.phone_last10 THEN 92
              WHEN input.name_key IS NOT NULL
                   AND LOWER(REGEXP_REPLACE(COALESCE(u.name, ''), '\\s+', ' ', 'g')) = input.name_key
                   AND input.birthday IS NOT NULL
                   AND u.birthday = input.birthday THEN 86
              WHEN input.name_key IS NOT NULL
                   AND LOWER(REGEXP_REPLACE(COALESCE(u.name, ''), '\\s+', ' ', 'g')) = input.name_key THEN 76
              ELSE 60
            END AS confidence_score,
            jsonb_strip_nulls(jsonb_build_object(
              'abha_address', CASE
                WHEN input.abha_key IS NOT NULL
                 AND LOWER(COALESCE(u.abha_address, '')) = input.abha_key
                THEN true END,
              'phone_last10', CASE
                WHEN input.phone_last10 IS NOT NULL
                 AND RIGHT(REGEXP_REPLACE(COALESCE(u.phone, ''), '\\D', '', 'g'), 10) = input.phone_last10
                THEN true END,
              'name_exact', CASE
                WHEN input.name_key IS NOT NULL
                 AND LOWER(REGEXP_REPLACE(COALESCE(u.name, ''), '\\s+', ' ', 'g')) = input.name_key
                THEN true END,
              'birthday_exact', CASE
                WHEN input.birthday IS NOT NULL AND u.birthday = input.birthday
                THEN true END
            )) AS match_signals
       FROM users u
       CROSS JOIN input
       LEFT JOIN LATERAL (
         SELECT pi.identifier_value
           FROM patient_identifiers pi
          WHERE pi.tenant_id = u.tenant_id
            AND pi.patient_uid = u.uid
            AND pi.identifier_type IN ('mrn', 'uhid')
            AND pi.status = 'active'
          ORDER BY pi.is_primary DESC,
                   CASE pi.identifier_type WHEN 'mrn' THEN 0 WHEN 'uhid' THEN 1 ELSE 2 END,
                   pi.created_at ASC
          LIMIT 1
       ) hn ON TRUE
      WHERE u.tenant_id = $1::uuid
        AND u.role = 'PATIENT'
        AND u.is_active = true
        AND (
          (input.abha_key IS NOT NULL AND LOWER(COALESCE(u.abha_address, '')) = input.abha_key)
          OR (input.phone_last10 IS NOT NULL
              AND RIGHT(REGEXP_REPLACE(COALESCE(u.phone, ''), '\\D', '', 'g'), 10) = input.phone_last10)
          OR (input.name_key IS NOT NULL
              AND LOWER(REGEXP_REPLACE(COALESCE(u.name, ''), '\\s+', ' ', 'g')) = input.name_key
              AND (input.birthday IS NULL OR u.birthday IS NULL OR u.birthday = input.birthday))
        )
      ORDER BY confidence_score DESC, u.registered_at DESC NULLS LAST, u.name ASC
      LIMIT $6`,
    tid,
    nameKey,
    phoneKey,
    birthdayKey,
    abhaKey,
    safeLimit,
  );

  const candidates = rows.map(publicRegistrationCandidate);
  return { candidates, count: candidates.length };
}

export async function recordRegistrationDuplicateOverride({
  tenantId = null,
  newPatientUid,
  candidates = [],
  decidedBy = null,
  reason,
  // Optional transaction client: callers that create the patient row and the
  // override evidence atomically (registerFromShareIntake) pass their tx so
  // the evidence commits or rolls back WITH the registration.
  db = prisma,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const newUid = maybeUuid(newPatientUid, 'newPatientUid');
  const decisionNote = String(reason ?? '').trim();
  if (!newUid || candidates.length === 0 || decisionNote.length < 10) {
    return { recorded: 0 };
  }

  let recorded = 0;
  for (const candidate of candidates) {
    const existingUid = maybeUuid(candidate.uid, 'candidate uid');
    if (!existingUid || existingUid === newUid) continue;
    const [primaryUid, secondaryUid] = [existingUid, newUid].sort();
    try {
      const rows = await db.$queryRawUnsafe(
        `INSERT INTO patient_duplicate_candidates
           (tenant_id, primary_uid, secondary_uid, confidence_score,
            match_signals, detected_by, status, decided_by, decided_at,
            decision_note, metadata)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb,
                 'front_desk_registration', 'rejected_not_duplicate',
                 $6::uuid, NOW(), $7,
                 jsonb_build_object(
                   'source', 'front_desk_registration',
                   'override_reason', $7::text,
                   'new_patient_uid', $8::text
                 ))
         ON CONFLICT (tenant_id, primary_uid, secondary_uid)
         DO UPDATE SET
           confidence_score = GREATEST(patient_duplicate_candidates.confidence_score, EXCLUDED.confidence_score),
           match_signals = EXCLUDED.match_signals,
           detected_by = EXCLUDED.detected_by,
           status = 'rejected_not_duplicate',
           decided_by = EXCLUDED.decided_by,
           decided_at = NOW(),
           decision_note = EXCLUDED.decision_note,
           metadata = COALESCE(patient_duplicate_candidates.metadata, '{}'::jsonb) || EXCLUDED.metadata,
           updated_at = NOW()
         RETURNING id`,
        tid,
        primaryUid,
        secondaryUid,
        Number(candidate.confidence_score || 60),
        JSON.stringify(candidate.match_signals || {}),
        decidedBy || null,
        decisionNote,
        newUid,
      );
      if (rows[0]) recorded += 1;
    } catch (err) {
      if (db !== prisma) {
        // Transactional caller: a failed statement has already aborted the
        // underlying Postgres tx — swallowing it here would only poison the
        // next tx statement (CLAUDE.md Phase-1 rule). Let the tx roll back.
        throw err;
      }
      if (isMissingSchemaError(err)) {
        return { recorded, halted: true, reason: 'patient_duplicate_candidates_unavailable' };
      }
      logger.warn('patient duplicate override record failed', { error: err.message });
    }
  }
  return { recorded };
}

/**
 * Run a fresh detection pass. Each invocation gets a unique
 * detection_run_id so admins can group candidates that came from the
 * same scan.
 *
 * @returns { run_id, scanned_pairs, candidates_inserted, candidates_skipped, halted? }
 */
export async function detectIdentifierCollisions({
  tenantId = null,
  limit = 200,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 200, 1), 5_000);
  const runId = crypto.randomUUID();

  let pairs;
  try {
    pairs = await prisma.$queryRawUnsafe(
      `SELECT
         a.identifier_type        AS identifier_type,
         a.identifier_value       AS identifier_value,
         LEAST(a.patient_uid::text, b.patient_uid::text)::uuid    AS primary_uid,
         GREATEST(a.patient_uid::text, b.patient_uid::text)::uuid AS secondary_uid,
         COUNT(*)                 AS hit_count
       FROM patient_identifiers a
       JOIN patient_identifiers b
         ON a.tenant_id = b.tenant_id
        AND a.identifier_type = b.identifier_type
        AND a.identifier_value = b.identifier_value
        AND a.patient_uid < b.patient_uid
       WHERE a.tenant_id = $1::uuid
         AND a.status = 'active'
         AND b.status = 'active'
       GROUP BY a.identifier_type, a.identifier_value, primary_uid, secondary_uid
       LIMIT $2`,
      tid, safeLimit,
    );
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return { run_id: runId, halted: true, reason: 'patient_identifiers_unavailable' };
    }
    throw err;
  }

  if (!pairs.length) {
    return { run_id: runId, scanned_pairs: 0, candidates_inserted: 0, candidates_skipped: 0 };
  }

  // Aggregate per (primary, secondary) pair across all colliding identifier
  // types so a couple matching on BOTH abha + mobile produces a single
  // candidate row with a combined match_signals payload.
  const grouped = new Map();
  for (const row of pairs) {
    const key = `${row.primary_uid}::${row.secondary_uid}`;
    const score = confidenceForIdentifierType(row.identifier_type);
    const entry = grouped.get(key) ?? {
      primary_uid: row.primary_uid,
      secondary_uid: row.secondary_uid,
      max_confidence: 0,
      signals: [],
    };
    entry.max_confidence = Math.max(entry.max_confidence, score);
    entry.signals.push({
      identifier_type: row.identifier_type,
      identifier_value_match: true,
      hit_count: Number(row.hit_count || 1),
    });
    grouped.set(key, entry);
  }

  let inserted = 0;
  let skipped = 0;
  for (const entry of grouped.values()) {
    try {
      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO patient_duplicate_candidates
           (tenant_id, primary_uid, secondary_uid, confidence_score,
            match_signals, detected_by, detection_run_id, status, metadata)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb,
                 'identifier_collision', $6::uuid, 'open', '{}'::jsonb)
         ON CONFLICT (tenant_id, primary_uid, secondary_uid)
         DO UPDATE SET
           -- Re-detection refreshes signals + bumps confidence if higher
           -- but ONLY when the previous decision is still open. Decided
           -- pairs (merged / rejected_not_duplicate) are left alone so the
           -- detector doesn't undo a human verdict.
           confidence_score = GREATEST(patient_duplicate_candidates.confidence_score, EXCLUDED.confidence_score),
           match_signals = EXCLUDED.match_signals,
           detection_run_id = EXCLUDED.detection_run_id,
           updated_at = NOW()
         WHERE patient_duplicate_candidates.status = 'open'
         RETURNING id, status`,
        tid, entry.primary_uid, entry.secondary_uid,
        entry.max_confidence, JSON.stringify(entry.signals), runId,
      );
      if (rows[0]) inserted += 1;
      else skipped += 1;
    } catch (err) {
      if (isMissingSchemaError(err)) {
        return { run_id: runId, halted: true, reason: 'patient_duplicate_candidates_unavailable' };
      }
      logger.warn('patient_duplicate_candidates insert failed', { error: err.message });
      skipped += 1;
    }
  }

  return {
    run_id: runId,
    scanned_pairs: grouped.size,
    candidates_inserted: inserted,
    candidates_skipped: skipped,
    halted: false,
  };
}

export async function listDuplicateCandidates({
  tenantId = null,
  status = 'open',
  detectionRunId = null,
  minConfidence = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    if (!CANDIDATE_STATUSES.includes(String(status))) {
      throw AppError.badRequest(`status must be one of: ${CANDIDATE_STATUSES.join(', ')}`);
    }
    params.push(status);
    filters.push(`status = $${params.length}`);
  }
  if (detectionRunId) {
    params.push(maybeUuid(detectionRunId, 'detection_run_id'));
    filters.push(`detection_run_id = $${params.length}`);
  }
  if (minConfidence != null) {
    const threshold = Number.parseFloat(minConfidence);
    if (Number.isFinite(threshold)) {
      params.push(threshold);
      filters.push(`confidence_score >= $${params.length}`);
    }
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, primary_uid, secondary_uid, confidence_score,
              match_signals, detected_by, detection_run_id, status,
              decided_by, decided_at, decision_note, metadata,
              created_at, updated_at
       FROM patient_duplicate_candidates
       WHERE ${filters.join(' AND ')}
       ORDER BY confidence_score DESC, created_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { candidates: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { candidates: [], count: 0 };
    throw err;
  }
}

export async function getDuplicateCandidate({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const cid = normalizeId(id, 'candidate id');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, primary_uid, secondary_uid, confidence_score,
            match_signals, detected_by, detection_run_id, status,
            decided_by, decided_at, decision_note, metadata,
            created_at, updated_at
     FROM patient_duplicate_candidates
     WHERE id = $1 AND tenant_id = $2::uuid
     LIMIT 1`,
    cid, tid,
  );
  if (!rows[0]) throw AppError.notFound('Duplicate candidate not found');
  return rows[0];
}

export async function markCandidateNotDuplicate({
  tenantId = null,
  id,
  decidedBy = null,
  decisionNote = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cid = normalizeId(id, 'candidate id');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE patient_duplicate_candidates
     SET status = 'rejected_not_duplicate',
         decided_by = $3::uuid,
         decided_at = NOW(),
         decision_note = $4,
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2::uuid AND status = 'open'
     RETURNING id, primary_uid, secondary_uid, status, decision_note,
               decided_by, decided_at`,
    cid, tid, decidedBy, decisionNote,
  );
  if (!rows[0]) throw AppError.notFound('Open duplicate candidate not found');
  return rows[0];
}

export const __testing__ = {
  CANDIDATE_STATUSES,
  IDENTIFIER_CONFIDENCE_BY_TYPE,
  confidenceForIdentifierType,
};

export default {
  confidenceForIdentifierType,
  detectIdentifierCollisions,
  findRegistrationDuplicateCandidates,
  getDuplicateCandidate,
  listDuplicateCandidates,
  markCandidateNotDuplicate,
  recordRegistrationDuplicateOverride,
};
