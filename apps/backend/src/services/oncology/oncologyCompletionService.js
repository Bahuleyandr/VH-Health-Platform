import prisma, { setTenant, setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { istDateString } from '../../utils/dateUtils.js';
import {
  recordCanonicalClinicalEvent,
  recordClinicalAuditEvent,
} from '../clinical/canonicalClinicalPlatformService.js';
import { requireTenantId } from '../tenant/tenantService.js';

const REFRESH_INTERVAL_MS = 60 * 1000;
const enabledCache = new Map();
const tenantOr = (tenantId) => requireTenantId(tenantId);

const TNM_RULES = Object.freeze({
  T: /^(?:[cpyra]{0,2})?T(?:X|0|is|mi|1[abcd]?|2[abcd]?|3[abcd]?|4[abcd]?)$/i,
  N: /^(?:[cpyra]{0,2})?N(?:X|0|1[abc]?|2[abc]?|3[abc]?)$/i,
  M: /^(?:[cpyra]{0,2})?M(?:X|0|1[abc]?)$/i,
});

const CASE_TRANSITIONS = Object.freeze({
  queued: new Set(['in_review', 'recommended', 'deferred', 'cancelled']),
  in_review: new Set(['recommended', 'deferred', 'cancelled']),
  deferred: new Set(['queued', 'cancelled']),
  recommended: new Set([]),
  cancelled: new Set([]),
});

const RECOMMENDATION_STATUSES = new Set(['proposed', 'accepted', 'deferred', 'completed', 'cancelled']);
const RECOMMENDATION_TYPES = new Set([
  'systemic_therapy',
  'radiation',
  'surgery',
  'diagnostics',
  'palliative',
  'surveillance',
  'trial',
  'supportive_care',
  'other',
]);
const TOXICITY_ACTIONS = new Set(['none', 'monitor', 'supportive_care', 'dose_delay', 'dose_reduce', 'withhold', 'stop', 'admit', 'other']);
const MALIGNANCY_FLAGS_FOR_DIAGNOSIS = new Set(['malignant', 'suspicious', 'premalignant']);

function text(value, fallback = null) {
  const clean = value == null ? '' : String(value).trim();
  return clean || fallback;
}

function integer(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${name} must be a positive integer`, 'ONCOLOGY_ID_INVALID');
  }
  return parsed;
}

function json(value, fallback) {
  if (value === undefined || value === null) return JSON.stringify(fallback);
  return JSON.stringify(value);
}

function dateOnly(value, name) {
  const clean = text(value);
  if (!clean) return null;
  const parsed = new Date(clean);
  if (!Number.isFinite(parsed.getTime())) {
    throw AppError.badRequest(`${name} must be a valid date`, 'ONCOLOGY_DATE_INVALID');
  }
  return parsed.toISOString().slice(0, 10);
}

function futureOrTodayDate(value, name, now = new Date()) {
  const clean = dateOnly(value, name);
  if (!clean) return null;
  if (clean < istDateString(now)) {
    throw AppError.badRequest(`${name} cannot be in the past`, 'ONCOLOGY_DUE_DATE_PAST');
  }
  return clean;
}

function limit(value, fallback = 50, max = 200) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, max));
}

export function validateTnmCategory(kind, value) {
  const cleanKind = String(kind || '').trim().toUpperCase();
  const cleanValue = text(value);
  if (!cleanValue) return null;
  const rule = TNM_RULES[cleanKind];
  if (!rule || !rule.test(cleanValue)) {
    throw AppError.badRequest(`${cleanKind || 'TNM'} category is malformed`, 'ONCOLOGY_TNM_INVALID');
  }
  return cleanValue;
}

export function normalizeCtcaeGrade(value) {
  const grade = Number.parseInt(value, 10);
  if (!Number.isInteger(grade) || grade < 1 || grade > 5) {
    throw AppError.badRequest('ctcae_grade must be an integer from 1 to 5', 'ONCOLOGY_CTCAE_GRADE_INVALID');
  }
  return grade;
}

export function assertOwnerSourceMetadata({ source, version, edition, attachmentRefs = [] } = {}, code = 'ONCOLOGY_OWNER_SOURCE_REQUIRED') {
  const cleanSource = text(source);
  const cleanVersion = text(version);
  const cleanEdition = edition === undefined ? undefined : text(edition);
  if (!cleanSource || !cleanVersion || cleanEdition === null) {
    throw AppError.badRequest(
      'Owner-sourced source, version, and edition metadata are required before clinical sign-off',
      code,
    );
  }
  if (!Array.isArray(attachmentRefs)) {
    throw AppError.badRequest('source attachment refs must be an array', 'ONCOLOGY_SOURCE_REFS_INVALID');
  }
  return {
    source: cleanSource,
    version: cleanVersion,
    edition: cleanEdition,
    attachmentRefs,
  };
}

export function transitionTumorBoardCaseState(current, next) {
  const from = String(current || '').trim().toLowerCase();
  const to = String(next || '').trim().toLowerCase();
  const allowed = CASE_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) {
    throw AppError.invalidTransition(from || 'unknown', to || 'unknown', allowed ? [...allowed] : []);
  }
  return to;
}

export function normalizeRecommendationDueDate(value, now = new Date()) {
  const dueDate = futureOrTodayDate(value, 'due_date', now);
  if (!dueDate) {
    throw AppError.badRequest('due_date is required for tumor board recommendations', 'ONCOLOGY_RECOMMENDATION_DUE_DATE_REQUIRED');
  }
  return dueDate;
}

export function normalizeChemoLink({ chemoPlanId = null, chemoCycleId = null, chemoAdministrationId = null } = {}) {
  return {
    chemoPlanId: chemoPlanId == null || chemoPlanId === '' ? null : integer(chemoPlanId, 'chemo_plan_id'),
    chemoCycleId: chemoCycleId == null || chemoCycleId === '' ? null : integer(chemoCycleId, 'chemo_cycle_id'),
    chemoAdministrationId: chemoAdministrationId == null || chemoAdministrationId === '' ? null : integer(chemoAdministrationId, 'chemo_administration_id'),
  };
}

async function assertPatientInTenant(db, tenantId, patientUid) {
  if (!patientUid) throw AppError.badRequest('patient_uid is required', 'ONCOLOGY_PATIENT_REQUIRED');
  const rows = await db.$queryRawUnsafe(
    `SELECT uid FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND role = 'PATIENT'
      LIMIT 1`,
    tenantOr(tenantId),
    patientUid,
  );
  if (!rows.length) throw AppError.notFound('Patient not found', 'ONCOLOGY_PATIENT_NOT_FOUND');
}

async function getCompletionSettingRow(tenantId, db = prisma) {
  const rows = await db.$queryRawUnsafe(
    `SELECT tenant_id, enabled, enabled_at, enabled_by, owner_source_policy_ref,
            tumor_board_quorum_policy_ref, acceptance_snapshot, created_at, updated_at
       FROM oncology_completion_settings
      WHERE tenant_id = $1::uuid`,
    tenantOr(tenantId),
  );
  return rows[0] || {
    tenant_id: tenantOr(tenantId),
    enabled: false,
    enabled_at: null,
    enabled_by: null,
    owner_source_policy_ref: null,
    tumor_board_quorum_policy_ref: null,
    acceptance_snapshot: null,
    created_at: null,
    updated_at: null,
  };
}

export async function getOncologyCompletionSettings({ tenantId } = {}) {
  return setTenant(tenantOr(tenantId), (tx) => getCompletionSettingRow(tenantId, tx));
}

export async function isOncologyCompletionEnabled(tenantId) {
  if (!tenantId) return false;
  const key = String(tenantId);
  const cached = enabledCache.get(key);
  if (cached && Date.now() - cached.fetchedAt <= REFRESH_INTERVAL_MS) return cached.value;
  try {
    const row = await getOncologyCompletionSettings({ tenantId });
    const value = row.enabled === true;
    enabledCache.set(key, { value, fetchedAt: Date.now() });
    return value;
  } catch (err) {
    logger.warn(`isOncologyCompletionEnabled failed for tenant ${tenantId}: ${err.message}`);
    return false;
  }
}

async function assertCompletionEnabled(tenantId) {
  if (!(await isOncologyCompletionEnabled(tenantId))) {
    throw AppError.forbidden('Oncology completion suite is disabled for this tenant', 'ONCOLOGY_COMPLETION_DISABLED');
  }
}

export async function setOncologyCompletionSettings({
  tenantId,
  enabled,
  ownerSourcePolicyRef = null,
  tumorBoardQuorumPolicyRef = null,
  acceptanceSnapshot = null,
}, { actorUid = null, actorRole = null } = {}) {
  const enabledBool = enabled === true;
  const row = await setTenantTx(tenantOr(tenantId), async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO oncology_completion_settings
         (tenant_id, enabled, enabled_at, enabled_by, owner_source_policy_ref,
          tumor_board_quorum_policy_ref, acceptance_snapshot, updated_at)
       VALUES (
         $1::uuid, $2,
         CASE WHEN $2 THEN NOW() ELSE NULL END,
         CASE WHEN $2 THEN $3::uuid ELSE NULL END,
         $4, $5, $6::jsonb, NOW()
       )
       ON CONFLICT (tenant_id) DO UPDATE SET
         enabled = $2,
         enabled_at = CASE WHEN $2 THEN NOW() ELSE oncology_completion_settings.enabled_at END,
         enabled_by = CASE WHEN $2 THEN $3::uuid ELSE oncology_completion_settings.enabled_by END,
         owner_source_policy_ref = COALESCE($4, oncology_completion_settings.owner_source_policy_ref),
         tumor_board_quorum_policy_ref = COALESCE($5, oncology_completion_settings.tumor_board_quorum_policy_ref),
         acceptance_snapshot = CASE WHEN $2 THEN $6::jsonb ELSE oncology_completion_settings.acceptance_snapshot END,
         updated_at = NOW()
       RETURNING tenant_id, enabled, enabled_at, enabled_by, owner_source_policy_ref,
                 tumor_board_quorum_policy_ref, acceptance_snapshot, created_at, updated_at`,
      tenantOr(tenantId),
      enabledBool,
      actorUid,
      text(ownerSourcePolicyRef),
      text(tumorBoardQuorumPolicyRef),
      json(acceptanceSnapshot, null),
    );

    await recordClinicalAuditEvent({
      tenantId: tenantOr(tenantId),
      action: enabledBool ? 'oncology.completion_enabled' : 'oncology.completion_disabled',
      actorUid,
      actorRole,
      resourceType: 'oncology_completion_settings',
      resourceTable: 'oncology_completion_settings',
      resourceId: tenantOr(tenantId),
      metadata: {
        owner_source_policy_ref: ownerSourcePolicyRef,
        tumor_board_quorum_policy_ref: tumorBoardQuorumPolicyRef,
      },
      idempotencyKey: `oncology_completion_settings:${tenantOr(tenantId)}:${enabledBool}:${Date.now()}`,
    }, { db: tx });
    return rows[0];
  });
  enabledCache.set(String(tenantId), { value: enabledBool, fetchedAt: Date.now() });
  return row;
}

async function loadPathologyReport(db, tenantId, pathologyReportId) {
  if (!pathologyReportId) return null;
  const rows = await db.$queryRawUnsafe(
    `SELECT r.id, r.ap_case_id, r.malignancy_flag, r.synoptic_fields,
            c.patient_uid, c.encounter_id
       FROM ap_reports r
       JOIN ap_cases c ON c.id = r.ap_case_id
      WHERE r.id = $1::bigint
        AND r.tenant_id = $2::uuid
        AND c.tenant_id = $2::uuid
      LIMIT 1`,
    integer(pathologyReportId, 'pathology_report_id'),
    tenantOr(tenantId),
  );
  if (!rows.length) throw AppError.notFound('Pathology report not found', 'ONCOLOGY_PATHOLOGY_REPORT_NOT_FOUND');
  return rows[0];
}

async function loadDiagnosis(db, tenantId, diagnosisId) {
  const rows = await db.$queryRawUnsafe(
    `SELECT *
       FROM oncology_diagnoses
      WHERE id = $1::bigint
        AND tenant_id = $2::uuid
      LIMIT 1`,
    integer(diagnosisId, 'diagnosis_id'),
    tenantOr(tenantId),
  );
  if (!rows.length) throw AppError.notFound('Oncology diagnosis not found', 'ONCOLOGY_DIAGNOSIS_NOT_FOUND');
  return rows[0];
}

async function loadTumorBoardCase(db, tenantId, caseId) {
  const rows = await db.$queryRawUnsafe(
    `SELECT *
       FROM tumor_board_cases
      WHERE id = $1::bigint
        AND tenant_id = $2::uuid
      LIMIT 1`,
    integer(caseId, 'case_id'),
    tenantOr(tenantId),
  );
  if (!rows.length) throw AppError.notFound('Tumor board case not found', 'ONCOLOGY_TUMOR_BOARD_CASE_NOT_FOUND');
  return rows[0];
}

async function assertChemoPlanForPatient(db, tenantId, planId, patientUid) {
  if (!planId) return;
  const rows = await db.$queryRawUnsafe(
    `SELECT id FROM chemo_treatment_plans
      WHERE id = $1::int
        AND tenant_id = $2::uuid
        AND patient_uid = $3::uuid
      LIMIT 1`,
    integer(planId, 'chemo_plan_id'),
    tenantOr(tenantId),
    patientUid,
  );
  if (!rows.length) throw AppError.badRequest('chemo_plan_id does not belong to this patient', 'ONCOLOGY_CHEMO_PLAN_MISMATCH');
}

async function emitAndLink(tx, tableName, row, event) {
  const result = await recordCanonicalClinicalEvent(event, { db: tx });
  const timelineId = result?.timeline?.id || null;
  if (timelineId) {
    await tx.$queryRawUnsafe(
      `UPDATE ${tableName}
          SET canonical_timeline_event_id = $1::uuid,
              updated_at = NOW()
        WHERE id = $2::bigint
          AND tenant_id = $3::uuid`,
      timelineId,
      row.id,
      event.tenantId,
    );
  }
  return { ...row, canonical_timeline_event_id: timelineId || row.canonical_timeline_event_id || null };
}

export async function createOncologyDiagnosis({
  tenantId,
  patientUid,
  encounterId = null,
  cancerSite,
  morphology = null,
  laterality = null,
  diagnosisDate = null,
  pathologyReportId = null,
  malignancyFlagSource = null,
  sourceEvidenceRefs = [],
}, { actorUid = null, actorRole = null } = {}) {
  await assertCompletionEnabled(tenantId);
  const cleanCancerSite = text(cancerSite);
  if (!cleanCancerSite) throw AppError.badRequest('cancer_site is required', 'ONCOLOGY_CANCER_SITE_REQUIRED');

  return setTenantTx(tenantOr(tenantId), async (tx) => {
    const report = await loadPathologyReport(tx, tenantId, pathologyReportId);
    const effectivePatientUid = patientUid || report?.patient_uid;
    await assertPatientInTenant(tx, tenantId, effectivePatientUid);
    if (report && String(report.patient_uid) !== String(effectivePatientUid)) {
      throw AppError.badRequest('Pathology report patient does not match diagnosis patient', 'ONCOLOGY_PATHOLOGY_PATIENT_MISMATCH');
    }
    const flag = text(report?.malignancy_flag);
    if (report && !MALIGNANCY_FLAGS_FOR_DIAGNOSIS.has(flag)) {
      throw AppError.badRequest('Pathology malignancy flag is not eligible for oncology diagnosis creation', 'ONCOLOGY_PATHOLOGY_FLAG_NOT_MALIGNANT');
    }

    const evidenceRefs = Array.isArray(sourceEvidenceRefs) ? [...sourceEvidenceRefs] : [];
    if (report) {
      evidenceRefs.push({ source_table: 'ap_reports', source_id: report.id, malignancy_flag: report.malignancy_flag });
    }

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO oncology_diagnoses
         (tenant_id, patient_uid, encounter_id, cancer_site, morphology, laterality,
          diagnosis_date, pathology_report_id, pathology_case_id, malignancy_flag_source,
          malignancy_flag, synoptic_snapshot, source_evidence_refs, created_by, updated_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, COALESCE($7::date, CURRENT_DATE),
               $8::bigint, $9::bigint, $10, $11, $12::jsonb, $13::jsonb, $14::uuid, $14::uuid)
       RETURNING *`,
      tenantOr(tenantId),
      effectivePatientUid,
      encounterId || report?.encounter_id || null,
      cleanCancerSite,
      text(morphology),
      text(laterality),
      diagnosisDate ? dateOnly(diagnosisDate, 'diagnosis_date') : null,
      report?.id || pathologyReportId || null,
      report?.ap_case_id || null,
      text(malignancyFlagSource, report ? 'ap_malignancy_flag' : 'manual_owner_source'),
      flag,
      json(report?.synoptic_fields || {}, {}),
      json(evidenceRefs, []),
      actorUid,
    );
    const diagnosis = rows[0];
    return emitAndLink(tx, 'oncology_diagnoses', diagnosis, {
      tenantId: tenantOr(tenantId),
      patientUid: effectivePatientUid,
      encounterId: diagnosis.encounter_id,
      eventType: 'oncology.diagnosis_created',
      sourceTable: 'oncology_diagnoses',
      sourceId: diagnosis.id,
      actorUid,
      actorRole,
      summary: `Oncology diagnosis recorded: ${diagnosis.cancer_site}`,
      payload: {
        cancer_site: diagnosis.cancer_site,
        pathology_report_id: diagnosis.pathology_report_id,
        malignancy_flag: diagnosis.malignancy_flag,
      },
      tags: ['oncology', 'diagnosis'],
      timelineIdempotencyKey: `oncology_diagnoses:${diagnosis.id}:created`,
      auditIdempotencyKey: `oncology_diagnoses:${diagnosis.id}:audit:created`,
    });
  });
}

export async function listOncologyDiagnoses({ tenantId, patientUid = null, limit: rawLimit = 50 } = {}) {
  return setTenant(tenantOr(tenantId), (tx) => {
    const params = [tenantOr(tenantId)];
    const where = ['d.tenant_id = $1::uuid'];
    let idx = 2;
    if (patientUid) {
      where.push(`d.patient_uid = $${idx++}::uuid`);
      params.push(patientUid);
    }
    params.push(limit(rawLimit));
    return tx.$queryRawUnsafe(
      `SELECT d.*,
              s.id AS latest_staging_id,
              s.t_category AS latest_t_category,
              s.n_category AS latest_n_category,
              s.m_category AS latest_m_category,
              s.clinical_stage AS latest_clinical_stage,
              s.pathologic_stage AS latest_pathologic_stage,
              s.verification_status AS latest_staging_status
         FROM oncology_diagnoses d
         LEFT JOIN LATERAL (
           SELECT *
             FROM oncology_staging_records s
            WHERE s.tenant_id = d.tenant_id
              AND s.diagnosis_id = d.id
            ORDER BY s.created_at DESC
            LIMIT 1
         ) s ON TRUE
        WHERE ${where.join(' AND ')}
        ORDER BY d.diagnosis_date DESC, d.id DESC
        LIMIT $${idx}::int`,
      ...params,
    );
  });
}

export async function createStagingRecord(diagnosisId, {
  tenantId,
  tCategory = null,
  nCategory = null,
  mCategory = null,
  clinicalStage = null,
  pathologicStage = null,
  ajccEdition = null,
  stagingSource = null,
  stagingSourceVersion = null,
  stagingSourceAttachmentRefs = [],
  verify = false,
  verificationNote = null,
}, { actorUid = null, actorRole = null } = {}) {
  await assertCompletionEnabled(tenantId);
  const t = validateTnmCategory('T', tCategory);
  const n = validateTnmCategory('N', nCategory);
  const m = validateTnmCategory('M', mCategory);
  if (!t && !n && !m && !clinicalStage && !pathologicStage) {
    throw AppError.badRequest('At least one TNM or stage field is required', 'ONCOLOGY_STAGE_FIELDS_REQUIRED');
  }
  if (verify) {
    assertOwnerSourceMetadata({
      source: stagingSource,
      version: stagingSourceVersion,
      edition: ajccEdition,
      attachmentRefs: stagingSourceAttachmentRefs,
    }, 'ONCOLOGY_STAGING_SOURCE_REQUIRED');
  }

  return setTenantTx(tenantOr(tenantId), async (tx) => {
    const diagnosis = await loadDiagnosis(tx, tenantId, diagnosisId);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO oncology_staging_records
         (tenant_id, diagnosis_id, patient_uid, encounter_id, t_category, n_category, m_category,
          clinical_stage, pathologic_stage, ajcc_edition, staging_source, staging_source_version,
          staging_source_attachment_refs, assessor_uid, assessor_role, verification_status,
          verified_by, verified_at, verification_note)
       VALUES ($1::uuid, $2::bigint, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12,
               $13::jsonb, $14::uuid, $15, $16::text, $17::uuid, CASE WHEN $16::text = 'verified' THEN NOW() ELSE NULL END, $18)
       RETURNING *`,
      tenantOr(tenantId),
      diagnosis.id,
      diagnosis.patient_uid,
      diagnosis.encounter_id,
      t,
      n,
      m,
      text(clinicalStage),
      text(pathologicStage),
      text(ajccEdition),
      text(stagingSource),
      text(stagingSourceVersion),
      json(stagingSourceAttachmentRefs, []),
      actorUid,
      actorRole,
      verify ? 'verified' : 'draft',
      verify ? actorUid : null,
      text(verificationNote),
    );
    const record = rows[0];
    return emitAndLink(tx, 'oncology_staging_records', record, {
      tenantId: tenantOr(tenantId),
      patientUid: diagnosis.patient_uid,
      encounterId: diagnosis.encounter_id,
      eventType: verify ? 'oncology.staging_verified' : 'oncology.staging_recorded',
      sourceTable: 'oncology_staging_records',
      sourceId: record.id,
      actorUid,
      actorRole,
      summary: `Oncology staging ${verify ? 'verified' : 'recorded'} for ${diagnosis.cancer_site}`,
      payload: {
        diagnosis_id: diagnosis.id,
        t_category: t,
        n_category: n,
        m_category: m,
        clinical_stage: record.clinical_stage,
        pathologic_stage: record.pathologic_stage,
        ajcc_edition: record.ajcc_edition,
        staging_source_version: record.staging_source_version,
      },
      tags: ['oncology', 'staging'],
      timelineIdempotencyKey: `oncology_staging_records:${record.id}:${verify ? 'verified' : 'recorded'}`,
      auditIdempotencyKey: `oncology_staging_records:${record.id}:audit:${verify ? 'verified' : 'recorded'}`,
    });
  });
}

export async function signStagingRecord(stagingRecordId, {
  tenantId,
  verificationNote = null,
}, { actorUid = null, actorRole = null } = {}) {
  await assertCompletionEnabled(tenantId);
  return setTenantTx(tenantOr(tenantId), async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT s.*, d.cancer_site
         FROM oncology_staging_records s
         JOIN oncology_diagnoses d ON d.id = s.diagnosis_id AND d.tenant_id = s.tenant_id
        WHERE s.id = $1::bigint
          AND s.tenant_id = $2::uuid
        LIMIT 1`,
      integer(stagingRecordId, 'staging_record_id'),
      tenantOr(tenantId),
    );
    if (!rows.length) throw AppError.notFound('Oncology staging record not found', 'ONCOLOGY_STAGING_NOT_FOUND');
    const record = rows[0];
    assertOwnerSourceMetadata({
      source: record.staging_source,
      version: record.staging_source_version,
      edition: record.ajcc_edition,
      attachmentRefs: record.staging_source_attachment_refs || [],
    }, 'ONCOLOGY_STAGING_SOURCE_REQUIRED');
    if (record.verification_status === 'verified') return record;

    const updatedRows = await tx.$queryRawUnsafe(
      `UPDATE oncology_staging_records
          SET verification_status = 'verified',
              verified_by = $3::uuid,
              verified_at = NOW(),
              verification_note = COALESCE($4, verification_note),
              updated_at = NOW()
        WHERE id = $1::bigint
          AND tenant_id = $2::uuid
        RETURNING *`,
      record.id,
      tenantOr(tenantId),
      actorUid,
      text(verificationNote),
    );
    const updated = updatedRows[0];
    return emitAndLink(tx, 'oncology_staging_records', updated, {
      tenantId: tenantOr(tenantId),
      patientUid: updated.patient_uid,
      encounterId: updated.encounter_id,
      eventType: 'oncology.staging_verified',
      sourceTable: 'oncology_staging_records',
      sourceId: updated.id,
      actorUid,
      actorRole,
      summary: `Oncology staging verified for ${record.cancer_site}`,
      payload: {
        diagnosis_id: updated.diagnosis_id,
        ajcc_edition: updated.ajcc_edition,
        staging_source_version: updated.staging_source_version,
      },
      tags: ['oncology', 'staging'],
      timelineIdempotencyKey: `oncology_staging_records:${updated.id}:verified`,
      auditIdempotencyKey: `oncology_staging_records:${updated.id}:audit:verified`,
    });
  });
}

export async function createToxicityEvent({
  tenantId,
  patientUid,
  encounterId = null,
  diagnosisId = null,
  toxicityTerm,
  ctcaeGrade,
  ctcaeSource = null,
  ctcaeSourceVersion = null,
  ctcaeSourceAttachmentRefs = [],
  attribution = null,
  actionTaken = 'monitor',
  clinicalNote = null,
  chemoPlanId = null,
  chemoCycleId = null,
  chemoAdministrationId = null,
  signoff = false,
}, { actorUid = null, actorRole = null } = {}) {
  await assertCompletionEnabled(tenantId);
  const term = text(toxicityTerm);
  if (!term) throw AppError.badRequest('toxicity_term is required', 'ONCOLOGY_TOXICITY_TERM_REQUIRED');
  const grade = normalizeCtcaeGrade(ctcaeGrade);
  const action = text(actionTaken, 'monitor').toLowerCase();
  if (!TOXICITY_ACTIONS.has(action)) throw AppError.badRequest('action_taken is not supported', 'ONCOLOGY_TOXICITY_ACTION_INVALID');
  if (signoff) {
    assertOwnerSourceMetadata({
      source: ctcaeSource,
      version: ctcaeSourceVersion,
      edition: 'CTCAE',
      attachmentRefs: ctcaeSourceAttachmentRefs,
    }, 'ONCOLOGY_CTCAE_SOURCE_REQUIRED');
  }
  const chemoLink = normalizeChemoLink({ chemoPlanId, chemoCycleId, chemoAdministrationId });

  return setTenantTx(tenantOr(tenantId), async (tx) => {
    let effectivePatientUid = patientUid;
    let effectiveEncounterId = encounterId;
    if (diagnosisId) {
      const diagnosis = await loadDiagnosis(tx, tenantId, diagnosisId);
      effectivePatientUid = effectivePatientUid || diagnosis.patient_uid;
      effectiveEncounterId = effectiveEncounterId || diagnosis.encounter_id;
    }
    await assertPatientInTenant(tx, tenantId, effectivePatientUid);
    await assertChemoPlanForPatient(tx, tenantId, chemoLink.chemoPlanId, effectivePatientUid);

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO oncology_toxicity_events
         (tenant_id, patient_uid, encounter_id, diagnosis_id, chemo_plan_id, chemo_cycle_id,
          chemo_administration_id, toxicity_term, ctcae_grade, ctcae_source, ctcae_source_version,
          ctcae_source_attachment_refs, attribution, action_taken, clinical_note, signoff_status,
          captured_by, signed_by, signed_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::int, $6::int, $7::int,
               $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16::text, $17::uuid, $18::uuid,
               CASE WHEN $16::text = 'signed' THEN NOW() ELSE NULL END)
       RETURNING *`,
      tenantOr(tenantId),
      effectivePatientUid,
      effectiveEncounterId || null,
      diagnosisId || null,
      chemoLink.chemoPlanId,
      chemoLink.chemoCycleId,
      chemoLink.chemoAdministrationId,
      term,
      grade,
      text(ctcaeSource),
      text(ctcaeSourceVersion),
      json(ctcaeSourceAttachmentRefs, []),
      text(attribution),
      action,
      text(clinicalNote),
      signoff ? 'signed' : 'draft',
      actorUid,
      signoff ? actorUid : null,
    );
    const event = rows[0];
    return emitAndLink(tx, 'oncology_toxicity_events', event, {
      tenantId: tenantOr(tenantId),
      patientUid: effectivePatientUid,
      encounterId: effectiveEncounterId,
      eventType: signoff ? 'oncology.toxicity_signed' : 'oncology.toxicity_recorded',
      sourceTable: 'oncology_toxicity_events',
      sourceId: event.id,
      actorUid,
      actorRole,
      summary: `CTCAE grade ${grade} toxicity recorded: ${term}`,
      payload: {
        diagnosis_id: diagnosisId,
        toxicity_term: term,
        ctcae_grade: grade,
        action_taken: action,
        chemo_plan_id: chemoLink.chemoPlanId,
        chemo_cycle_id: chemoLink.chemoCycleId,
        chemo_administration_id: chemoLink.chemoAdministrationId,
      },
      tags: ['oncology', 'ctcae', 'toxicity'],
      timelineIdempotencyKey: `oncology_toxicity_events:${event.id}:${signoff ? 'signed' : 'recorded'}`,
      auditIdempotencyKey: `oncology_toxicity_events:${event.id}:audit:${signoff ? 'signed' : 'recorded'}`,
    });
  });
}

export async function listToxicityEvents({ tenantId, patientUid = null, limit: rawLimit = 50 } = {}) {
  return setTenant(tenantOr(tenantId), (tx) => {
    const params = [tenantOr(tenantId)];
    const where = ['t.tenant_id = $1::uuid'];
    let idx = 2;
    if (patientUid) {
      where.push(`t.patient_uid = $${idx++}::uuid`);
      params.push(patientUid);
    }
    params.push(limit(rawLimit));
    return tx.$queryRawUnsafe(
      `SELECT t.*, u.name AS patient_name
         FROM oncology_toxicity_events t
         LEFT JOIN users u ON u.uid = t.patient_uid AND u.tenant_id = t.tenant_id
        WHERE ${where.join(' AND ')}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT $${idx}::int`,
      ...params,
    );
  });
}

export async function signToxicityEvent(toxicityEventId, {
  tenantId,
}, { actorUid = null, actorRole = null } = {}) {
  await assertCompletionEnabled(tenantId);
  return setTenantTx(tenantOr(tenantId), async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT *
         FROM oncology_toxicity_events
        WHERE id = $1::bigint
          AND tenant_id = $2::uuid
        LIMIT 1`,
      integer(toxicityEventId, 'toxicity_event_id'),
      tenantOr(tenantId),
    );
    if (!rows.length) throw AppError.notFound('Toxicity event not found', 'ONCOLOGY_TOXICITY_NOT_FOUND');
    const event = rows[0];
    assertOwnerSourceMetadata({
      source: event.ctcae_source,
      version: event.ctcae_source_version,
      edition: 'CTCAE',
      attachmentRefs: event.ctcae_source_attachment_refs || [],
    }, 'ONCOLOGY_CTCAE_SOURCE_REQUIRED');
    if (event.signoff_status === 'signed') return event;
    const updatedRows = await tx.$queryRawUnsafe(
      `UPDATE oncology_toxicity_events
          SET signoff_status = 'signed',
              signed_by = $3::uuid,
              signed_at = NOW(),
              updated_at = NOW()
        WHERE id = $1::bigint
          AND tenant_id = $2::uuid
        RETURNING *`,
      event.id,
      tenantOr(tenantId),
      actorUid,
    );
    const updated = updatedRows[0];
    return emitAndLink(tx, 'oncology_toxicity_events', updated, {
      tenantId: tenantOr(tenantId),
      patientUid: updated.patient_uid,
      encounterId: updated.encounter_id,
      eventType: 'oncology.toxicity_signed',
      sourceTable: 'oncology_toxicity_events',
      sourceId: updated.id,
      actorUid,
      actorRole,
      summary: `CTCAE grade ${updated.ctcae_grade} toxicity signed: ${updated.toxicity_term}`,
      payload: {
        toxicity_term: updated.toxicity_term,
        ctcae_grade: updated.ctcae_grade,
        ctcae_source_version: updated.ctcae_source_version,
      },
      tags: ['oncology', 'ctcae', 'toxicity'],
      timelineIdempotencyKey: `oncology_toxicity_events:${updated.id}:signed`,
      auditIdempotencyKey: `oncology_toxicity_events:${updated.id}:audit:signed`,
    });
  });
}

export async function createTumorBoardMeeting({
  tenantId,
  serviceLine,
  meetingDate,
  chairUid = null,
  attendeeUids = [],
  externalAttendees = [],
  quorumReference,
  status = 'scheduled',
  notes = null,
}, { actorUid = null, actorRole = null } = {}) {
  await assertCompletionEnabled(tenantId);
  const service = text(serviceLine);
  if (!service) throw AppError.badRequest('service_line is required', 'ONCOLOGY_SERVICE_LINE_REQUIRED');
  if (!text(quorumReference)) throw AppError.badRequest('quorum_reference is required', 'ONCOLOGY_QUORUM_REQUIRED');
  const meetingAt = new Date(meetingDate);
  if (!Number.isFinite(meetingAt.getTime())) throw AppError.badRequest('meeting_date must be a valid date-time', 'ONCOLOGY_MEETING_DATE_INVALID');
  return setTenantTx(tenantOr(tenantId), async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO tumor_board_meetings
         (tenant_id, service_line, meeting_date, chair_uid, attendee_uids, external_attendees,
          quorum_reference, status, notes, created_by)
       VALUES ($1::uuid, $2, $3::timestamptz, $4::uuid, $5::uuid[], $6::jsonb, $7, $8, $9, $10::uuid)
       RETURNING *`,
      tenantOr(tenantId),
      service,
      meetingAt.toISOString(),
      chairUid || null,
      Array.isArray(attendeeUids) ? attendeeUids : [],
      json(Array.isArray(externalAttendees) ? externalAttendees : [], []),
      text(quorumReference),
      text(status, 'scheduled'),
      text(notes),
      actorUid,
    );
    const meeting = rows[0];
    await recordClinicalAuditEvent({
      tenantId: tenantOr(tenantId),
      action: 'oncology.tumor_board_meeting_created',
      actorUid,
      actorRole,
      resourceType: 'tumor_board_meeting',
      resourceTable: 'tumor_board_meetings',
      resourceId: meeting.id,
      metadata: { service_line: service, meeting_date: meeting.meeting_date, quorum_reference: meeting.quorum_reference },
      idempotencyKey: `tumor_board_meetings:${meeting.id}:audit:created`,
    }, { db: tx });
    return meeting;
  });
}

export async function createTumorBoardCase({
  tenantId,
  diagnosisId,
  meetingId = null,
  stagingRecordId = null,
  apReportId = null,
  radiologyOrderId = null,
  question,
  priority = 'routine',
  discussionState = 'queued',
}, { actorUid = null, actorRole = null } = {}) {
  await assertCompletionEnabled(tenantId);
  const cleanQuestion = text(question);
  if (!cleanQuestion) throw AppError.badRequest('question is required', 'ONCOLOGY_TUMOR_BOARD_QUESTION_REQUIRED');

  return setTenantTx(tenantOr(tenantId), async (tx) => {
    const diagnosis = await loadDiagnosis(tx, tenantId, diagnosisId);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO tumor_board_cases
         (tenant_id, patient_uid, meeting_id, diagnosis_id, staging_record_id, ap_report_id,
          radiology_order_id, question, priority, discussion_state, presented_by, created_by)
       VALUES ($1::uuid, $2::uuid, $3::bigint, $4::bigint, $5::bigint, $6::bigint,
               $7::int, $8, $9, $10, $11::uuid, $11::uuid)
       RETURNING *`,
      tenantOr(tenantId),
      diagnosis.patient_uid,
      meetingId || null,
      diagnosis.id,
      stagingRecordId || null,
      apReportId || diagnosis.pathology_report_id || null,
      radiologyOrderId || null,
      cleanQuestion,
      text(priority, 'routine').toLowerCase(),
      text(discussionState, 'queued').toLowerCase(),
      actorUid,
    );
    const boardCase = rows[0];
    return emitAndLink(tx, 'tumor_board_cases', boardCase, {
      tenantId: tenantOr(tenantId),
      patientUid: diagnosis.patient_uid,
      encounterId: diagnosis.encounter_id,
      eventType: 'oncology.tumor_board_case_created',
      sourceTable: 'tumor_board_cases',
      sourceId: boardCase.id,
      actorUid,
      actorRole,
      summary: `Tumor board case queued: ${diagnosis.cancer_site}`,
      payload: {
        diagnosis_id: diagnosis.id,
        meeting_id: meetingId,
        staging_record_id: stagingRecordId,
        priority: boardCase.priority,
        question: cleanQuestion,
      },
      tags: ['oncology', 'tumor_board'],
      timelineIdempotencyKey: `tumor_board_cases:${boardCase.id}:created`,
      auditIdempotencyKey: `tumor_board_cases:${boardCase.id}:audit:created`,
    });
  });
}

export async function listTumorBoardQueue({ tenantId, state = null, limit: rawLimit = 50 } = {}) {
  return setTenant(tenantOr(tenantId), (tx) => {
    const params = [tenantOr(tenantId)];
    const where = ['c.tenant_id = $1::uuid'];
    let idx = 2;
    if (state) {
      where.push(`c.discussion_state = $${idx++}`);
      params.push(text(state));
    } else {
      where.push("c.discussion_state IN ('queued', 'in_review', 'deferred')");
    }
    params.push(limit(rawLimit));
    return tx.$queryRawUnsafe(
      `SELECT c.*,
              d.cancer_site,
              d.diagnosis_date,
              u.name AS patient_name,
              s.t_category,
              s.n_category,
              s.m_category,
              s.clinical_stage,
              s.pathologic_stage,
              COUNT(r.id)::int AS recommendation_count
         FROM tumor_board_cases c
         JOIN oncology_diagnoses d ON d.id = c.diagnosis_id AND d.tenant_id = c.tenant_id
         LEFT JOIN users u ON u.uid = c.patient_uid AND u.tenant_id = c.tenant_id
         LEFT JOIN oncology_staging_records s ON s.id = c.staging_record_id AND s.tenant_id = c.tenant_id
         LEFT JOIN tumor_board_recommendations r ON r.tumor_board_case_id = c.id AND r.tenant_id = c.tenant_id
        WHERE ${where.join(' AND ')}
        GROUP BY c.id, d.cancer_site, d.diagnosis_date, u.name, s.t_category, s.n_category,
                 s.m_category, s.clinical_stage, s.pathologic_stage
        ORDER BY
          CASE c.priority WHEN 'expedite' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END,
          c.created_at
        LIMIT $${idx}::int`,
      ...params,
    );
  });
}

export async function updateTumorBoardCaseState(caseId, {
  tenantId,
  state,
  discussionSummary = null,
}, { actorUid = null, actorRole = null } = {}) {
  await assertCompletionEnabled(tenantId);
  return setTenantTx(tenantOr(tenantId), async (tx) => {
    const boardCase = await loadTumorBoardCase(tx, tenantId, caseId);
    const next = transitionTumorBoardCaseState(boardCase.discussion_state, state);
    const rows = await tx.$queryRawUnsafe(
      `UPDATE tumor_board_cases
          SET discussion_state = $3,
              discussion_summary = COALESCE($4, discussion_summary),
              updated_at = NOW()
        WHERE id = $1::bigint
          AND tenant_id = $2::uuid
        RETURNING *`,
      boardCase.id,
      tenantOr(tenantId),
      next,
      text(discussionSummary),
    );
    const updated = rows[0];
    return emitAndLink(tx, 'tumor_board_cases', updated, {
      tenantId: tenantOr(tenantId),
      patientUid: updated.patient_uid,
      eventType: 'oncology.tumor_board_case_state_changed',
      sourceTable: 'tumor_board_cases',
      sourceId: updated.id,
      actorUid,
      actorRole,
      summary: `Tumor board case moved to ${next.replace('_', ' ')}`,
      payload: { from: boardCase.discussion_state, to: next, discussion_summary: text(discussionSummary) },
      tags: ['oncology', 'tumor_board'],
      timelineIdempotencyKey: `tumor_board_cases:${updated.id}:state:${next}`,
      auditIdempotencyKey: `tumor_board_cases:${updated.id}:audit:state:${next}`,
    });
  });
}

export async function createTumorBoardRecommendation(caseId, {
  tenantId,
  recommendationType,
  recommendationText,
  responsibleOwnerUid = null,
  dueDate,
  chemoPlanId = null,
}, { actorUid = null, actorRole = null } = {}) {
  await assertCompletionEnabled(tenantId);
  const typeValue = text(recommendationType, 'other').toLowerCase();
  if (!RECOMMENDATION_TYPES.has(typeValue)) {
    throw AppError.badRequest('recommendation_type is not supported', 'ONCOLOGY_RECOMMENDATION_TYPE_INVALID');
  }
  const body = text(recommendationText);
  if (!body) throw AppError.badRequest('recommendation_text is required', 'ONCOLOGY_RECOMMENDATION_TEXT_REQUIRED');
  const due = normalizeRecommendationDueDate(dueDate);

  return setTenantTx(tenantOr(tenantId), async (tx) => {
    const boardCase = await loadTumorBoardCase(tx, tenantId, caseId);
    await assertChemoPlanForPatient(tx, tenantId, chemoPlanId, boardCase.patient_uid);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO tumor_board_recommendations
         (tenant_id, patient_uid, tumor_board_case_id, recommendation_type, recommendation_text,
          responsible_owner_uid, due_date, chemo_plan_id, created_by)
       VALUES ($1::uuid, $2::uuid, $3::bigint, $4, $5, $6::uuid, $7::date, $8::int, $9::uuid)
       RETURNING *`,
      tenantOr(tenantId),
      boardCase.patient_uid,
      boardCase.id,
      typeValue,
      body,
      responsibleOwnerUid || null,
      due,
      chemoPlanId || null,
      actorUid,
    );
    const recommendation = rows[0];
    if (boardCase.discussion_state !== 'recommended') {
      const next = transitionTumorBoardCaseState(boardCase.discussion_state, 'recommended');
      await tx.$queryRawUnsafe(
        `UPDATE tumor_board_cases
            SET discussion_state = $3,
                updated_at = NOW()
          WHERE id = $1::bigint
            AND tenant_id = $2::uuid`,
        boardCase.id,
        tenantOr(tenantId),
        next,
      );
    }
    return emitAndLink(tx, 'tumor_board_recommendations', recommendation, {
      tenantId: tenantOr(tenantId),
      patientUid: boardCase.patient_uid,
      eventType: 'oncology.tumor_board_recommendation_created',
      sourceTable: 'tumor_board_recommendations',
      sourceId: recommendation.id,
      actorUid,
      actorRole,
      summary: `Tumor board recommendation: ${typeValue.replace('_', ' ')}`,
      payload: {
        tumor_board_case_id: boardCase.id,
        recommendation_type: typeValue,
        due_date: due,
        chemo_plan_id: chemoPlanId,
      },
      tags: ['oncology', 'tumor_board', 'recommendation'],
      timelineIdempotencyKey: `tumor_board_recommendations:${recommendation.id}:created`,
      auditIdempotencyKey: `tumor_board_recommendations:${recommendation.id}:audit:created`,
    });
  });
}

export async function updateTumorBoardRecommendationStatus(recommendationId, {
  tenantId,
  status,
  acceptanceNote = null,
  deferReason = null,
}, { actorUid = null, actorRole = null } = {}) {
  await assertCompletionEnabled(tenantId);
  const cleanStatus = text(status, '').toLowerCase();
  if (!RECOMMENDATION_STATUSES.has(cleanStatus)) {
    throw AppError.badRequest('status is not supported', 'ONCOLOGY_RECOMMENDATION_STATUS_INVALID');
  }
  if (cleanStatus === 'deferred' && !text(deferReason)) {
    throw AppError.badRequest('defer_reason is required when deferring a recommendation', 'ONCOLOGY_DEFER_REASON_REQUIRED');
  }
  return setTenantTx(tenantOr(tenantId), async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE tumor_board_recommendations
          SET status = $3,
              acceptance_note = CASE WHEN $3 = 'accepted' THEN $4 ELSE acceptance_note END,
              defer_reason = CASE WHEN $3 = 'deferred' THEN $5 ELSE defer_reason END,
              updated_at = NOW()
        WHERE id = $1::bigint
          AND tenant_id = $2::uuid
        RETURNING *`,
      integer(recommendationId, 'recommendation_id'),
      tenantOr(tenantId),
      cleanStatus,
      text(acceptanceNote),
      text(deferReason),
    );
    if (!rows.length) throw AppError.notFound('Tumor board recommendation not found', 'ONCOLOGY_RECOMMENDATION_NOT_FOUND');
    const recommendation = rows[0];
    return emitAndLink(tx, 'tumor_board_recommendations', recommendation, {
      tenantId: tenantOr(tenantId),
      patientUid: recommendation.patient_uid,
      eventType: 'oncology.tumor_board_recommendation_status_changed',
      sourceTable: 'tumor_board_recommendations',
      sourceId: recommendation.id,
      actorUid,
      actorRole,
      summary: `Tumor board recommendation ${cleanStatus}`,
      payload: { status: cleanStatus, acceptance_note: text(acceptanceNote), defer_reason: text(deferReason) },
      tags: ['oncology', 'tumor_board', 'recommendation'],
      timelineIdempotencyKey: `tumor_board_recommendations:${recommendation.id}:status:${cleanStatus}`,
      auditIdempotencyKey: `tumor_board_recommendations:${recommendation.id}:audit:status:${cleanStatus}`,
    });
  });
}

export async function createRegistryExport({
  tenantId,
  registryName,
  exportPeriodStart,
  exportPeriodEnd,
  evidenceRefs = [],
  filterSnapshot = {},
  rowCount = 0,
}, { actorUid = null, actorRole = null } = {}) {
  await assertCompletionEnabled(tenantId);
  const name = text(registryName);
  if (!name) throw AppError.badRequest('registry_name is required', 'ONCOLOGY_REGISTRY_NAME_REQUIRED');
  const start = dateOnly(exportPeriodStart, 'export_period_start');
  const end = dateOnly(exportPeriodEnd, 'export_period_end');
  if (!start || !end || end < start) {
    throw AppError.badRequest('export period is invalid', 'ONCOLOGY_REGISTRY_PERIOD_INVALID');
  }
  return setTenantTx(tenantOr(tenantId), async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO oncology_registry_exports
         (tenant_id, registry_name, export_period_start, export_period_end,
          evidence_refs, filter_snapshot, row_count, created_by)
       VALUES ($1::uuid, $2, $3::date, $4::date, $5::jsonb, $6::jsonb, $7::int, $8::uuid)
       RETURNING *`,
      tenantOr(tenantId),
      name,
      start,
      end,
      json(evidenceRefs, []),
      json(filterSnapshot, {}),
      Math.max(0, Number.parseInt(rowCount, 10) || 0),
      actorUid,
    );
    const exportRow = rows[0];
    const audit = await recordClinicalAuditEvent({
      tenantId: tenantOr(tenantId),
      action: 'oncology.registry_export_created',
      actorUid,
      actorRole,
      resourceType: 'oncology_registry_export',
      resourceTable: 'oncology_registry_exports',
      resourceId: exportRow.id,
      metadata: { registry_name: name, export_period_start: start, export_period_end: end, row_count: exportRow.row_count },
      idempotencyKey: `oncology_registry_exports:${exportRow.id}:audit:created`,
    }, { db: tx });
    if (audit?.id) {
      const updatedRows = await tx.$queryRawUnsafe(
        `UPDATE oncology_registry_exports
            SET clinical_audit_event_id = $3::uuid,
                updated_at = NOW()
          WHERE id = $1::bigint
            AND tenant_id = $2::uuid
          RETURNING *`,
        exportRow.id,
        tenantOr(tenantId),
        audit.id,
      );
      return updatedRows[0];
    }
    return exportRow;
  });
}

export async function reviewRegistryExport(registryExportId, {
  tenantId,
  reviewNote = null,
  release = false,
}, { actorUid = null, actorRole = null } = {}) {
  await assertCompletionEnabled(tenantId);
  return setTenantTx(tenantOr(tenantId), async (tx) => {
    const status = release ? 'released' : 'reviewed';
    const rows = await tx.$queryRawUnsafe(
      `UPDATE oncology_registry_exports
          SET export_status = $3,
              reviewed_by = $4::uuid,
              reviewed_at = NOW(),
              review_note = $5,
              updated_at = NOW()
        WHERE id = $1::bigint
          AND tenant_id = $2::uuid
        RETURNING *`,
      integer(registryExportId, 'registry_export_id'),
      tenantOr(tenantId),
      status,
      actorUid,
      text(reviewNote),
    );
    if (!rows.length) throw AppError.notFound('Oncology registry export not found', 'ONCOLOGY_REGISTRY_EXPORT_NOT_FOUND');
    const exportRow = rows[0];
    await recordClinicalAuditEvent({
      tenantId: tenantOr(tenantId),
      action: release ? 'oncology.registry_export_released' : 'oncology.registry_export_reviewed',
      actorUid,
      actorRole,
      resourceType: 'oncology_registry_export',
      resourceTable: 'oncology_registry_exports',
      resourceId: exportRow.id,
      metadata: { registry_name: exportRow.registry_name, export_status: status },
      idempotencyKey: `oncology_registry_exports:${exportRow.id}:audit:${status}`,
    }, { db: tx });
    return exportRow;
  });
}
