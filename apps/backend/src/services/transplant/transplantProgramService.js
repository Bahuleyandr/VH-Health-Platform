import { setTenant, setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { hasActivePrivilege } from '../staff/credentialingService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { isTransplantProgramEnabled } from './transplantProgramFeatureService.js';

export const TRANSPLANT_ORGANS = ['heart', 'liver', 'lung', 'kidney', 'small_bowel', 'multivisceral'];
export const WAITLIST_STATUSES = ['listed', 'hold', 'inactive', 'removed', 'transplanted'];
export const COMMITTEE_DECISIONS = ['pending', 'approved', 'deferred', 'declined', 'listed', 'removed'];

export const TRANSPLANT_ACTION_PRIVILEGES = Object.freeze({
  program: 'transplant_coordinator',
  candidate: 'transplant_physician',
  waitlist: 'transplant_physician',
  donor_referral: 'transplant_coordinator',
  match_review: 'transplant_surgeon',
  committee_review: 'transplant_committee_member',
  immunosuppression: 'transplant_physician',
  notto_export: 'transplant_coordinator',
});

const TEXT_MAX = 8000;
const tenantOr = (tenantId) => requireTenantId(tenantId);

function cleanText(value, max = TEXT_MAX) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function maybeUuid(value, label = 'uid', { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function normalizeEnum(value, allowed, label, { required = false, fallback = null } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return fallback;
  }
  const text = String(value).trim().toLowerCase();
  if (!allowed.includes(text)) {
    throw AppError.badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return text;
}

function normalizeJsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

function normalizeJsonArray(value, label) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw AppError.badRequest(`${label} must be an array`);
  return value;
}

function normalizeStringArray(value, label, max = 120) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw AppError.badRequest(`${label} must be an array`);
  return value.map((item) => cleanText(item, max)).filter(Boolean);
}

function normalizeDate(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw AppError.badRequest(`${label} must be a YYYY-MM-DD date`);
  }
  return text;
}

function toWire(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toNumber === 'function') return value.toNumber();
  if (Array.isArray(value)) return value.map(toWire);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, toWire(val)]));
  }
  return value;
}

export function normalizeTransplantOrgan(value) {
  return normalizeEnum(value, TRANSPLANT_ORGANS, 'organ', { required: true });
}

export function normalizeRequiredOrgans(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw AppError.badRequest('required_organs must include at least one organ', 'TRANSPLANT_ORGANS_REQUIRED');
  }
  return [...new Set(value.map((organ) => normalizeTransplantOrgan(organ)))];
}

export function allowedWaitlistTargets(currentStatus) {
  if (!currentStatus) return ['listed', 'hold', 'inactive', 'removed'];
  const map = {
    listed: ['hold', 'inactive', 'removed', 'transplanted'],
    hold: ['listed', 'inactive', 'removed'],
    inactive: ['listed', 'removed'],
    removed: [],
    transplanted: [],
  };
  return map[currentStatus] || [];
}

export function assertWaitlistTransition(currentStatus, nextStatus) {
  const normalizedNext = normalizeEnum(nextStatus, WAITLIST_STATUSES, 'status', { required: true });
  const normalizedCurrent = currentStatus ? normalizeEnum(currentStatus, WAITLIST_STATUSES, 'current_status') : null;
  const allowed = allowedWaitlistTargets(normalizedCurrent);
  if (!allowed.includes(normalizedNext)) {
    throw AppError.invalidTransition(normalizedCurrent || 'unlisted', normalizedNext, allowed);
  }
  return normalizedNext;
}

export function committeeStatusFromDecision(decision) {
  const normalized = normalizeEnum(decision, COMMITTEE_DECISIONS, 'decision', { required: true });
  if (normalized === 'approved' || normalized === 'listed') return 'approved';
  if (normalized === 'deferred') return 'deferred';
  if (normalized === 'declined' || normalized === 'removed') return 'declined';
  return 'pending';
}

export function assertCommitteeDecisionState({ decision, affectsCandidate = true, candidateId = null } = {}) {
  const normalized = normalizeEnum(decision, COMMITTEE_DECISIONS, 'decision', { required: true });
  if (affectsCandidate && !candidateId) {
    throw AppError.badRequest('candidate_id is required when a committee review affects a candidate');
  }
  if (normalized === 'deferred' && !affectsCandidate) {
    throw AppError.badRequest('deferral decisions must be attached to a candidate');
  }
  return normalized;
}

export function hasNottoReleaseEvidence(row = {}) {
  const evidence = row.audit_evidence ?? row.auditEvidence;
  return Boolean(
    row.owner_reviewed_by
      && row.owner_reviewed_at
      && row.upload_reference_id
      && evidence
      && typeof evidence === 'object'
      && !Array.isArray(evidence)
      && Object.keys(evidence).length > 0,
  );
}

export function assertNottoReleaseEvidence(row = {}) {
  if (!hasNottoReleaseEvidence(row)) {
    throw AppError.conflict(
      'NOTTO export cannot be released without owner-reviewed evidence and an upload/reference id',
      'TRANSPLANT_NOTTO_EVIDENCE_REQUIRED',
    );
  }
  return true;
}

export function privilegeForTransplantAction(action) {
  const key = String(action || '').trim();
  const privilege = TRANSPLANT_ACTION_PRIVILEGES[key];
  if (!privilege) throw AppError.badRequest(`Unknown transplant action: ${key}`);
  return privilege;
}

export async function assertTransplantPrivilege(actorUid, action, { tenantId = null } = {}) {
  const privilegeName = privilegeForTransplantAction(action);
  const verdict = await hasActivePrivilege(maybeUuid(actorUid, 'actor_uid'), privilegeName, { tenantId: tenantOr(tenantId) });
  if (!verdict.allowed) {
    throw AppError.forbidden(
      `Staff member does not hold an active ${privilegeName} privilege`,
      'CLINICAL_PRIVILEGE_REQUIRED',
      { gate: 'transplant_program', privilege_key: privilegeName, reason: verdict.reason },
    );
  }
  return verdict;
}

async function assertFeatureEnabled(tenantId) {
  if (!(await isTransplantProgramEnabled(tenantId))) {
    throw AppError.forbidden(
      'Transplant program management is not enabled for this tenant',
      'TRANSPLANT_PROGRAM_DISABLED',
    );
  }
}

async function assertPatientInTenant(db, tenantId, patientUid) {
  const rows = await db.$queryRawUnsafe(
    `SELECT uid FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND role = 'PATIENT'
      LIMIT 1`,
    tenantId,
    maybeUuid(patientUid, 'patient_uid', { required: true }),
  );
  if (!rows.length) throw AppError.notFound('Patient not found', 'TRANSPLANT_PATIENT_NOT_FOUND');
}

async function loadProgram(db, tenantId, programId) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, tenant_id, organ, service_line, site, status
       FROM transplant_programs
      WHERE id = $1 AND tenant_id = $2::uuid
      LIMIT 1`,
    normalizeId(programId, 'program_id'),
    tenantId,
  );
  if (!rows[0]) throw AppError.notFound('Transplant program not found', 'TRANSPLANT_PROGRAM_NOT_FOUND');
  return rows[0];
}

async function loadCandidate(db, tenantId, candidateId) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, tenant_id, program_id, patient_uid, diagnosis, required_organs::text[] AS required_organs,
            listing_evaluation_status, committee_status, related_care_plan_id
       FROM transplant_candidates
      WHERE id = $1 AND tenant_id = $2::uuid
      LIMIT 1`,
    normalizeId(candidateId, 'candidate_id'),
    tenantId,
  );
  if (!rows[0]) throw AppError.notFound('Transplant candidate not found', 'TRANSPLANT_CANDIDATE_NOT_FOUND');
  return rows[0];
}

async function latestWaitlistStatus(db, tenantId, candidateId) {
  const rows = await db.$queryRawUnsafe(
    `SELECT status
       FROM transplant_waitlist_status_history
      WHERE tenant_id = $1::uuid
        AND candidate_id = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    tenantId,
    normalizeId(candidateId, 'candidate_id'),
  );
  return rows[0]?.status || null;
}

async function auditRegister(db, {
  tenantId, actorUid = null, actorRole = null, action, resource, resourceId, metadata = {},
}) {
  await db.$executeRawUnsafe(
    `INSERT INTO audit_logs (uid, role, action, resource, resource_id, metadata, created_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, NOW())`,
    maybeUuid(actorUid, 'actor_uid'),
    cleanText(actorRole, 80),
    action,
    resource,
    String(resourceId),
    JSON.stringify({ tenant_id: tenantId, ...metadata }),
  );
}

async function recordTransplantTimeline(db, {
  tenantId,
  patientUid,
  actorUid,
  actorRole,
  eventType,
  sourceTable,
  sourceId,
  summary,
  payload = {},
}) {
  return recordCanonicalClinicalEvent({
    tenantId,
    patientUid,
    actorUid,
    actorRole,
    eventType,
    eventStatus: 'recorded',
    sourceTable,
    sourceId: String(sourceId),
    resourceType: 'transplant_program',
    resourceTable: sourceTable,
    resourceId: String(sourceId),
    visibleToPatient: false,
    clinicalSummary: summary,
    payload: { program: 'transplant', ...payload },
    metadata: { program: 'transplant', ...payload },
    timelineIdempotencyKey: `transplant:${sourceTable}:${sourceId}:timeline`,
    auditIdempotencyKey: `transplant:${sourceTable}:${sourceId}:audit`,
  }, { db });
}

export async function createProgram({
  tenantId = null,
  organ,
  serviceLine,
  site,
  programOwnerUid = null,
  programOwnerRole = null,
  status = 'draft',
  nottoEvidenceOwnerUid = null,
  nottoEvidenceOwnerRole = null,
  nottoEvidenceReference = null,
  metadata = null,
} = {}, context = {}) {
  const tid = tenantOr(tenantId);
  await assertFeatureEnabled(tid);
  await assertTransplantPrivilege(context.actorUid, 'program', { tenantId: tid });
  const cleanOrgan = normalizeTransplantOrgan(organ);
  const cleanServiceLine = cleanText(serviceLine, 120);
  const cleanSite = cleanText(site, 160);
  if (!cleanServiceLine) throw AppError.badRequest('service_line is required');
  if (!cleanSite) throw AppError.badRequest('site is required');
  const cleanStatus = normalizeEnum(status, ['draft', 'active', 'paused', 'retired'], 'status', { fallback: 'draft' });

  const rows = await setTenantTx(tid, (tx) => tx.$queryRawUnsafe(
    `INSERT INTO transplant_programs
       (tenant_id, organ, service_line, site, program_owner_uid, program_owner_role,
        status, notto_evidence_owner_uid, notto_evidence_owner_role,
        notto_evidence_reference, metadata, created_by)
     VALUES ($1::uuid, $2::transplant_organ_type, $3, $4, $5::uuid, $6,
             $7, $8::uuid, $9, $10, $11::jsonb, $12::uuid)
     RETURNING id, tenant_id, organ, service_line, site, program_owner_uid,
               program_owner_role, status, notto_evidence_owner_uid,
               notto_evidence_owner_role, notto_evidence_reference,
               metadata, created_by, created_at, updated_at`,
    tid,
    cleanOrgan,
    cleanServiceLine,
    cleanSite,
    maybeUuid(programOwnerUid, 'program_owner_uid'),
    cleanText(programOwnerRole, 80),
    cleanStatus,
    maybeUuid(nottoEvidenceOwnerUid, 'notto_evidence_owner_uid'),
    cleanText(nottoEvidenceOwnerRole, 80),
    cleanText(nottoEvidenceReference),
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    maybeUuid(context.actorUid, 'actor_uid'),
  ));
  return toWire(rows[0]);
}

export async function createCandidate(programId, {
  tenantId = null,
  patientUid,
  diagnosis,
  requiredOrgans,
  listingEvaluationStatus = 'evaluation',
  committeeStatus = 'pending',
  contraindicationsSummary = null,
  relatedCarePlanId = null,
  metadata = null,
} = {}, context = {}) {
  const tid = tenantOr(tenantId);
  await assertFeatureEnabled(tid);
  await assertTransplantPrivilege(context.actorUid, 'candidate', { tenantId: tid });
  const cleanOrgans = normalizeRequiredOrgans(requiredOrgans);
  const cleanDiagnosis = cleanText(diagnosis);
  if (!cleanDiagnosis) throw AppError.badRequest('diagnosis is required');

  return toWire(await setTenantTx(tid, async (tx) => {
    await loadProgram(tx, tid, programId);
    await assertPatientInTenant(tx, tid, patientUid);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO transplant_candidates
         (tenant_id, program_id, patient_uid, diagnosis, required_organs,
          listing_evaluation_status, committee_status, contraindications_summary,
          related_care_plan_id, metadata, created_by)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5::transplant_organ_type[],
               $6, $7, $8, $9, $10::jsonb, $11::uuid)
       RETURNING id, tenant_id, program_id, patient_uid, diagnosis, required_organs::text[] AS required_organs,
                 listing_evaluation_status, committee_status,
                 contraindications_summary, related_care_plan_id, metadata,
                 created_by, created_at, updated_at`,
      tid,
      normalizeId(programId, 'program_id'),
      maybeUuid(patientUid, 'patient_uid', { required: true }),
      cleanDiagnosis,
      cleanOrgans,
      normalizeEnum(listingEvaluationStatus, ['referred', 'evaluation', 'committee_review', 'approved', 'listed', 'not_eligible', 'closed'], 'listing_evaluation_status', { fallback: 'evaluation' }),
      normalizeEnum(committeeStatus, ['not_required', 'pending', 'approved', 'deferred', 'declined'], 'committee_status', { fallback: 'pending' }),
      cleanText(contraindicationsSummary),
      relatedCarePlanId ? normalizeId(relatedCarePlanId, 'related_care_plan_id') : null,
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      maybeUuid(context.actorUid, 'actor_uid'),
    );
    const candidate = rows[0];
    const canonical = await recordTransplantTimeline(tx, {
      tenantId: tid,
      patientUid: candidate.patient_uid,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      eventType: 'transplant.candidate_evaluation_recorded',
      sourceTable: 'transplant_candidates',
      sourceId: candidate.id,
      summary: `Transplant evaluation recorded for ${cleanOrgans.join(', ')}`,
      payload: { candidate_id: candidate.id, program_id: candidate.program_id, required_organs: cleanOrgans },
    });
    return { ...candidate, timeline_event_id: canonical.timeline?.id || null, audit_event_id: canonical.audit?.id || null };
  }));
}

export async function recordWaitlistStatus(candidateId, {
  tenantId = null,
  status,
  reason = null,
  committeeReviewId = null,
  metadata = null,
} = {}, context = {}) {
  const tid = tenantOr(tenantId);
  await assertFeatureEnabled(tid);
  await assertTransplantPrivilege(context.actorUid, 'waitlist', { tenantId: tid });

  return toWire(await setTenantTx(tid, async (tx) => {
    const candidate = await loadCandidate(tx, tid, candidateId);
    const current = await latestWaitlistStatus(tx, tid, candidate.id);
    const next = assertWaitlistTransition(current, status);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO transplant_waitlist_status_history
         (tenant_id, candidate_id, status, reason, committee_review_id, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7::uuid)
       RETURNING id, tenant_id, candidate_id, status, reason, committee_review_id,
                 audit_event_id, timeline_event_id, metadata, created_by, created_at`,
      tid,
      candidate.id,
      next,
      cleanText(reason),
      committeeReviewId ? normalizeId(committeeReviewId, 'committee_review_id') : null,
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      maybeUuid(context.actorUid, 'actor_uid'),
    );
    const history = rows[0];
    await tx.$executeRawUnsafe(
      `UPDATE transplant_candidates
          SET listing_evaluation_status = CASE
                WHEN $3 = 'listed' THEN 'listed'
                WHEN $3 IN ('removed', 'transplanted') THEN 'closed'
                ELSE listing_evaluation_status
              END,
              updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2::uuid`,
      candidate.id,
      tid,
      next,
    );
    const canonical = await recordTransplantTimeline(tx, {
      tenantId: tid,
      patientUid: candidate.patient_uid,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      eventType: 'transplant.waitlist_status_changed',
      sourceTable: 'transplant_waitlist_status_history',
      sourceId: history.id,
      summary: `Transplant waitlist status changed to ${next}`,
      payload: { candidate_id: candidate.id, from_status: current, to_status: next },
    });
    await tx.$executeRawUnsafe(
      `UPDATE transplant_waitlist_status_history
          SET timeline_event_id = $1::uuid,
              audit_event_id = $2::uuid
        WHERE id = $3 AND tenant_id = $4::uuid`,
      canonical.timeline?.id || null,
      canonical.audit?.id || null,
      history.id,
      tid,
    );
    return { ...history, timeline_event_id: canonical.timeline?.id || null, audit_event_id: canonical.audit?.id || null };
  }));
}

export async function createDonorReferral({
  tenantId = null,
  programId,
  donorType,
  source,
  relationCategory = null,
  screeningSummary = null,
  documents = null,
  status = 'received',
  auditRegister: register = null,
} = {}, context = {}) {
  const tid = tenantOr(tenantId);
  await assertFeatureEnabled(tid);
  await assertTransplantPrivilege(context.actorUid, 'donor_referral', { tenantId: tid });
  const cleanSource = cleanText(source, 160);
  if (!cleanSource) throw AppError.badRequest('source is required');

  return toWire(await setTenantTx(tid, async (tx) => {
    await loadProgram(tx, tid, programId);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO transplant_donor_referrals
         (tenant_id, program_id, donor_type, source, relation_category,
          screening_summary, documents, status, audit_register, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10::uuid)
       RETURNING id, tenant_id, program_id, donor_type, source, relation_category,
                 screening_summary, documents, status, audit_register,
                 created_by, created_at, updated_at`,
      tid,
      normalizeId(programId, 'program_id'),
      normalizeEnum(donorType, ['living', 'deceased'], 'donor_type', { required: true }),
      cleanSource,
      cleanText(relationCategory, 80),
      cleanText(screeningSummary),
      JSON.stringify(normalizeJsonArray(documents, 'documents')),
      normalizeEnum(status, ['received', 'screening', 'eligible', 'declined', 'withdrawn', 'matched', 'closed'], 'status', { fallback: 'received' }),
      JSON.stringify(normalizeJsonObject(register, 'audit_register')),
      maybeUuid(context.actorUid, 'actor_uid'),
    );
    await auditRegister(tx, {
      tenantId: tid,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      action: 'TRANSPLANT_DONOR_REFERRAL_CREATED',
      resource: 'transplant_donor_referrals',
      resourceId: rows[0].id,
      metadata: { program_id: normalizeId(programId, 'program_id'), donor_type: donorType },
    });
    return rows[0];
  }));
}

export async function createMatchReview({
  tenantId = null,
  candidateId,
  donorReferralId,
  compatibilitySummary,
  crossmatchDocuments = null,
  chainOfCustody = null,
  riskFlags = null,
  decision = 'pending',
  decisionReason = null,
} = {}, context = {}) {
  const tid = tenantOr(tenantId);
  await assertFeatureEnabled(tid);
  await assertTransplantPrivilege(context.actorUid, 'match_review', { tenantId: tid });
  const cleanCompatibilitySummary = cleanText(compatibilitySummary);
  if (!cleanCompatibilitySummary) throw AppError.badRequest('compatibility_summary is required');

  return toWire(await setTenantTx(tid, async (tx) => {
    const candidate = await loadCandidate(tx, tid, candidateId);
    const donorRows = await tx.$queryRawUnsafe(
      `SELECT id FROM transplant_donor_referrals WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
      normalizeId(donorReferralId, 'donor_referral_id'),
      tid,
    );
    if (!donorRows[0]) throw AppError.notFound('Transplant donor referral not found', 'TRANSPLANT_DONOR_NOT_FOUND');
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO transplant_match_reviews
         (tenant_id, candidate_id, donor_referral_id, compatibility_summary,
          crossmatch_documents, chain_of_custody, risk_flags, decision,
          decision_reason, reviewed_by, reviewed_at, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, $7::text[], $8,
               $9, $10::uuid, NOW(), $10::uuid)
       RETURNING id, tenant_id, candidate_id, donor_referral_id, compatibility_summary,
                 crossmatch_documents, chain_of_custody, risk_flags, decision,
                 decision_reason, reviewed_by, reviewed_at, timeline_event_id,
                 audit_event_id, created_by, created_at, updated_at`,
      tid,
      candidate.id,
      normalizeId(donorReferralId, 'donor_referral_id'),
      cleanCompatibilitySummary,
      JSON.stringify(normalizeJsonArray(crossmatchDocuments, 'crossmatch_documents')),
      JSON.stringify(normalizeJsonObject(chainOfCustody, 'chain_of_custody')),
      normalizeStringArray(riskFlags, 'risk_flags'),
      normalizeEnum(decision, ['pending', 'accepted', 'declined', 'deferred'], 'decision', { fallback: 'pending' }),
      cleanText(decisionReason),
      maybeUuid(context.actorUid, 'actor_uid'),
    );
    const review = rows[0];
    const canonical = await recordTransplantTimeline(tx, {
      tenantId: tid,
      patientUid: candidate.patient_uid,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      eventType: 'transplant.match_review_recorded',
      sourceTable: 'transplant_match_reviews',
      sourceId: review.id,
      summary: `Transplant match review recorded: ${review.decision}`,
      payload: { candidate_id: candidate.id, donor_referral_id: normalizeId(donorReferralId, 'donor_referral_id') },
    });
    await tx.$executeRawUnsafe(
      `UPDATE transplant_match_reviews
          SET timeline_event_id = $1::uuid,
              audit_event_id = $2::uuid
        WHERE id = $3 AND tenant_id = $4::uuid`,
      canonical.timeline?.id || null,
      canonical.audit?.id || null,
      review.id,
      tid,
    );
    return { ...review, timeline_event_id: canonical.timeline?.id || null, audit_event_id: canonical.audit?.id || null };
  }));
}

export async function createCommitteeReview({
  tenantId = null,
  programId,
  candidateId = null,
  reviewDate = null,
  attendees = null,
  quorumPolicyReference,
  decision = 'pending',
  recommendations = null,
  deferralReason = null,
  affectsCandidate = true,
  metadata = null,
} = {}, context = {}) {
  const tid = tenantOr(tenantId);
  await assertFeatureEnabled(tid);
  await assertTransplantPrivilege(context.actorUid, 'committee_review', { tenantId: tid });
  const cleanDecision = assertCommitteeDecisionState({ decision, affectsCandidate, candidateId });
  const cleanQuorumReference = cleanText(quorumPolicyReference);
  if (!cleanQuorumReference) throw AppError.badRequest('quorum_policy_reference is required');

  return toWire(await setTenantTx(tid, async (tx) => {
    await loadProgram(tx, tid, programId);
    const candidate = candidateId ? await loadCandidate(tx, tid, candidateId) : null;
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO transplant_committee_reviews
         (tenant_id, program_id, candidate_id, review_date, attendees,
          quorum_policy_reference, decision, recommendations, deferral_reason,
          affects_candidate, metadata, created_by)
       VALUES ($1::uuid, $2, $3, COALESCE($4::date, CURRENT_DATE), $5::jsonb,
               $6, $7, $8, $9, $10, $11::jsonb, $12::uuid)
       RETURNING id, tenant_id, program_id, candidate_id, review_date, attendees,
                 quorum_policy_reference, decision, recommendations,
                 deferral_reason, affects_candidate, timeline_event_id,
                 audit_event_id, metadata, created_by, created_at, updated_at`,
      tid,
      normalizeId(programId, 'program_id'),
      candidateId ? normalizeId(candidateId, 'candidate_id') : null,
      normalizeDate(reviewDate, 'review_date'),
      JSON.stringify(normalizeJsonArray(attendees, 'attendees')),
      cleanQuorumReference,
      cleanDecision,
      cleanText(recommendations),
      cleanText(deferralReason),
      affectsCandidate !== false,
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      maybeUuid(context.actorUid, 'actor_uid'),
    );
    const review = rows[0];
    if (candidate && review.affects_candidate) {
      await tx.$executeRawUnsafe(
        `UPDATE transplant_candidates
            SET committee_status = $1,
                listing_evaluation_status = CASE
                  WHEN $2 IN ('approved', 'listed') THEN 'approved'
                  WHEN $2 = 'declined' THEN 'not_eligible'
                  ELSE listing_evaluation_status
                END,
                updated_at = NOW()
          WHERE id = $3 AND tenant_id = $4::uuid`,
        committeeStatusFromDecision(cleanDecision),
        cleanDecision,
        candidate.id,
        tid,
      );
      const canonical = await recordTransplantTimeline(tx, {
        tenantId: tid,
        patientUid: candidate.patient_uid,
        actorUid: context.actorUid,
        actorRole: context.actorRole,
        eventType: 'transplant.committee_decision_recorded',
        sourceTable: 'transplant_committee_reviews',
        sourceId: review.id,
        summary: `Transplant committee decision recorded: ${cleanDecision}`,
        payload: { candidate_id: candidate.id, program_id: normalizeId(programId, 'program_id'), decision: cleanDecision },
      });
      await tx.$executeRawUnsafe(
        `UPDATE transplant_committee_reviews
            SET timeline_event_id = $1::uuid,
                audit_event_id = $2::uuid
          WHERE id = $3 AND tenant_id = $4::uuid`,
        canonical.timeline?.id || null,
        canonical.audit?.id || null,
        review.id,
        tid,
      );
      return { ...review, timeline_event_id: canonical.timeline?.id || null, audit_event_id: canonical.audit?.id || null };
    }
    await auditRegister(tx, {
      tenantId: tid,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      action: 'TRANSPLANT_COMMITTEE_REVIEW_RECORDED',
      resource: 'transplant_committee_reviews',
      resourceId: review.id,
      metadata: { program_id: normalizeId(programId, 'program_id'), affects_candidate: false },
    });
    return review;
  }));
}

export async function createImmunosuppressionPlan(candidateId, {
  tenantId = null,
  regimenSummary,
  monitoringPlan,
  prescribingOwnerUid,
  downstreamMedicationLinks = null,
  status = 'draft',
  metadata = null,
} = {}, context = {}) {
  const tid = tenantOr(tenantId);
  await assertFeatureEnabled(tid);
  await assertTransplantPrivilege(context.actorUid, 'immunosuppression', { tenantId: tid });
  const cleanRegimenSummary = cleanText(regimenSummary);
  const cleanMonitoringPlan = cleanText(monitoringPlan);
  if (!cleanRegimenSummary) throw AppError.badRequest('regimen_summary is required');
  if (!cleanMonitoringPlan) throw AppError.badRequest('monitoring_plan is required');

  return toWire(await setTenantTx(tid, async (tx) => {
    const candidate = await loadCandidate(tx, tid, candidateId);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO transplant_immunosuppression_plans
         (tenant_id, candidate_id, patient_uid, regimen_summary, monitoring_plan,
          prescribing_owner_uid, downstream_medication_links, status, metadata,
          created_by, activated_at)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6::uuid, $7::jsonb, $8::varchar,
                $9::jsonb, $10::uuid, CASE WHEN $8::varchar = 'active'::varchar THEN NOW() ELSE NULL END)
       RETURNING id, tenant_id, candidate_id, patient_uid, regimen_summary,
                 monitoring_plan, prescribing_owner_uid, downstream_medication_links,
                 status, timeline_event_id, audit_event_id, metadata,
                 created_by, activated_at, created_at, updated_at`,
      tid,
      candidate.id,
      candidate.patient_uid,
      cleanRegimenSummary,
      cleanMonitoringPlan,
      maybeUuid(prescribingOwnerUid, 'prescribing_owner_uid', { required: true }),
      JSON.stringify(normalizeJsonArray(downstreamMedicationLinks, 'downstream_medication_links')),
      normalizeEnum(status, ['draft', 'active', 'on_hold', 'discontinued'], 'status', { fallback: 'draft' }),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      maybeUuid(context.actorUid, 'actor_uid'),
    );
    const plan = rows[0];
    const canonical = await recordTransplantTimeline(tx, {
      tenantId: tid,
      patientUid: candidate.patient_uid,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      eventType: 'transplant.immunosuppression_plan_recorded',
      sourceTable: 'transplant_immunosuppression_plans',
      sourceId: plan.id,
      summary: 'Transplant immunosuppression plan recorded',
      payload: { candidate_id: candidate.id, status: plan.status },
    });
    await tx.$executeRawUnsafe(
      `UPDATE transplant_immunosuppression_plans
          SET timeline_event_id = $1::uuid,
              audit_event_id = $2::uuid
        WHERE id = $3 AND tenant_id = $4::uuid`,
      canonical.timeline?.id || null,
      canonical.audit?.id || null,
      plan.id,
      tid,
    );
    return { ...plan, timeline_event_id: canonical.timeline?.id || null, audit_event_id: canonical.audit?.id || null };
  }));
}

export async function createNottoExport({
  tenantId = null,
  programId,
  candidateId = null,
  packageMetadata = null,
  ownerReviewedStatus = 'draft',
  ownerReviewedBy = null,
  ownerReviewedAt = null,
  uploadReferenceId = null,
  auditEvidence = null,
  metadata = null,
} = {}, context = {}) {
  const tid = tenantOr(tenantId);
  await assertFeatureEnabled(tid);
  await assertTransplantPrivilege(context.actorUid, 'notto_export', { tenantId: tid });
  const cleanStatus = normalizeEnum(ownerReviewedStatus, ['draft', 'pending_owner_review', 'owner_reviewed', 'released', 'rejected'], 'owner_reviewed_status', { fallback: 'draft' });
  const draft = {
    owner_reviewed_by: ownerReviewedBy,
    owner_reviewed_at: ownerReviewedAt,
    upload_reference_id: uploadReferenceId,
    audit_evidence: normalizeJsonObject(auditEvidence, 'audit_evidence'),
  };
  if (cleanStatus === 'released') assertNottoReleaseEvidence(draft);

  return toWire(await setTenantTx(tid, async (tx) => {
    await loadProgram(tx, tid, programId);
    if (candidateId) await loadCandidate(tx, tid, candidateId);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO transplant_notto_exports
         (tenant_id, program_id, candidate_id, package_metadata,
          owner_reviewed_status, owner_reviewed_by, owner_reviewed_at,
          upload_reference_id, audit_evidence, released_at, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4::jsonb, $5::varchar, $6::uuid, $7::timestamptz,
               $8, $9::jsonb, CASE WHEN $5::varchar = 'released'::varchar THEN NOW() ELSE NULL END,
               $10::jsonb, $11::uuid)
       RETURNING id, tenant_id, program_id, candidate_id, package_metadata,
                 owner_reviewed_status, owner_reviewed_by, owner_reviewed_at,
                 upload_reference_id, audit_evidence, released_at, metadata,
                 created_by, created_at, updated_at`,
      tid,
      normalizeId(programId, 'program_id'),
      candidateId ? normalizeId(candidateId, 'candidate_id') : null,
      JSON.stringify(normalizeJsonObject(packageMetadata, 'package_metadata')),
      cleanStatus,
      maybeUuid(ownerReviewedBy, 'owner_reviewed_by'),
      ownerReviewedAt || null,
      cleanText(uploadReferenceId),
      JSON.stringify(normalizeJsonObject(auditEvidence, 'audit_evidence')),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      maybeUuid(context.actorUid, 'actor_uid'),
    );
    await auditRegister(tx, {
      tenantId: tid,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      action: 'TRANSPLANT_NOTTO_EXPORT_CREATED',
      resource: 'transplant_notto_exports',
      resourceId: rows[0].id,
      metadata: { program_id: normalizeId(programId, 'program_id'), status: cleanStatus },
    });
    return rows[0];
  }));
}

export async function releaseNottoExport(exportId, {
  tenantId = null,
  uploadReferenceId,
  auditEvidence,
} = {}, context = {}) {
  const tid = tenantOr(tenantId);
  await assertFeatureEnabled(tid);
  await assertTransplantPrivilege(context.actorUid, 'notto_export', { tenantId: tid });
  const evidence = normalizeJsonObject(auditEvidence, 'audit_evidence');
  assertNottoReleaseEvidence({
    owner_reviewed_by: context.actorUid,
    owner_reviewed_at: new Date().toISOString(),
    upload_reference_id: uploadReferenceId,
    audit_evidence: evidence,
  });

  return toWire(await setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE transplant_notto_exports
          SET owner_reviewed_status = 'released',
              owner_reviewed_by = $1::uuid,
              owner_reviewed_at = NOW(),
              upload_reference_id = $2,
              audit_evidence = $3::jsonb,
              released_at = NOW(),
              updated_at = NOW()
        WHERE id = $4 AND tenant_id = $5::uuid
        RETURNING id, tenant_id, program_id, candidate_id, package_metadata,
                  owner_reviewed_status, owner_reviewed_by, owner_reviewed_at,
                  upload_reference_id, audit_evidence, released_at, metadata,
                  created_by, created_at, updated_at`,
      maybeUuid(context.actorUid, 'actor_uid'),
      cleanText(uploadReferenceId),
      JSON.stringify(evidence),
      normalizeId(exportId, 'export_id'),
      tid,
    );
    if (!rows[0]) throw AppError.notFound('NOTTO export not found', 'TRANSPLANT_NOTTO_EXPORT_NOT_FOUND');
    await auditRegister(tx, {
      tenantId: tid,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      action: 'TRANSPLANT_NOTTO_EXPORT_RELEASED',
      resource: 'transplant_notto_exports',
      resourceId: rows[0].id,
      metadata: { program_id: rows[0].program_id, owner_reviewed_status: 'released' },
    });
    return rows[0];
  }));
}

export async function getDashboard({ tenantId = null, limit = 100 } = {}) {
  const tid = tenantOr(tenantId);
  const enabled = await isTransplantProgramEnabled(tid);
  return toWire(await setTenant(tid, async (tx) => {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 200);
    const [programs, candidates, waitlist, committee, donors, exports] = await Promise.all([
      tx.$queryRawUnsafe(
        `SELECT id, organ, service_line, site, status, notto_evidence_reference, updated_at
           FROM transplant_programs
          WHERE tenant_id = $1::uuid
          ORDER BY organ, site
          LIMIT $2`,
        tid,
        safeLimit,
      ),
      tx.$queryRawUnsafe(
        `SELECT c.id, c.program_id, c.patient_uid, u.name AS patient_name,
                c.diagnosis, c.required_organs::text[] AS required_organs, c.listing_evaluation_status,
                c.committee_status, c.related_care_plan_id, c.updated_at
           FROM transplant_candidates c
           LEFT JOIN users u ON u.uid = c.patient_uid AND u.tenant_id = c.tenant_id
          WHERE c.tenant_id = $1::uuid
          ORDER BY c.updated_at DESC
          LIMIT $2`,
        tid,
        safeLimit,
      ),
      tx.$queryRawUnsafe(
        `SELECT DISTINCT ON (h.candidate_id)
                h.id, h.candidate_id, h.status, h.reason, h.created_at
           FROM transplant_waitlist_status_history h
          WHERE h.tenant_id = $1::uuid
          ORDER BY h.candidate_id, h.created_at DESC, h.id DESC
          LIMIT $2`,
        tid,
        safeLimit,
      ),
      tx.$queryRawUnsafe(
        `SELECT id, program_id, candidate_id, review_date, decision,
                quorum_policy_reference, affects_candidate, created_at
           FROM transplant_committee_reviews
          WHERE tenant_id = $1::uuid
          ORDER BY review_date DESC, id DESC
          LIMIT $2`,
        tid,
        safeLimit,
      ),
      tx.$queryRawUnsafe(
        `SELECT id, program_id, donor_type, source, relation_category, status, created_at
           FROM transplant_donor_referrals
          WHERE tenant_id = $1::uuid
          ORDER BY created_at DESC
          LIMIT $2`,
        tid,
        safeLimit,
      ),
      tx.$queryRawUnsafe(
        `SELECT id, program_id, candidate_id, owner_reviewed_status,
                upload_reference_id, created_at, released_at
           FROM transplant_notto_exports
          WHERE tenant_id = $1::uuid
          ORDER BY created_at DESC
          LIMIT $2`,
        tid,
        safeLimit,
      ),
    ]);
    return {
      enabled,
      programs,
      candidates,
      waitlist,
      committee_reviews: committee,
      donor_referrals: donors,
      notto_exports: exports,
      counts: {
        programs: programs.length,
        candidates: candidates.length,
        listed: waitlist.filter((row) => row.status === 'listed').length,
        committee_reviews: committee.length,
        donor_referrals: donors.length,
        notto_exports: exports.length,
      },
    };
  }, { readOnly: true }));
}

export default {
  createProgram,
  createCandidate,
  recordWaitlistStatus,
  createDonorReferral,
  createMatchReview,
  createCommitteeReview,
  createImmunosuppressionPlan,
  createNottoExport,
  releaseNottoExport,
  getDashboard,
  assertTransplantPrivilege,
};
