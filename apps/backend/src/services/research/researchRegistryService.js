// src/services/research/researchRegistryService.js
//
// Roadmap D6 — research/registry capture (RDC-lite).
//
// Registries (optionally pinned to the AI trial-matcher catalog), versioned
// CRF form definitions, pseudonymous enrollments, and structured responses
// bound to clinical data. Field definitions may declare a `binding` that
// auto-pulls the value from clinical stores at capture time; every
// auto-filled value records provenance in `autofilled`. Exports are
// de-identified by default (subject codes, never name/phone; patient_uid
// only with include_phi).
//
// Timeline invariant: enrollment, withdrawal, and CRF submission write the
// canonical clinical event pair in the same transaction as the detail row.

import ExcelJS from 'exceljs';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';

const FIELD_TYPES = ['text', 'number', 'boolean', 'date', 'select'];
const BINDING_SOURCES = ['vitals_latest', 'lab_latest', 'demographics'];
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

// Whitelisted vitals_chart columns a binding may pull — never interpolate
// caller input into SQL outside this map.
const VITALS_BINDABLE = new Set([
  'heart_rate', 'systolic_bp', 'diastolic_bp', 'temperature', 'spo2',
  'respiratory_rate', 'blood_glucose', 'pain_score', 'weight_kg',
  'height_cm', 'gcs_score',
]);
const DEMOGRAPHIC_BINDABLE = new Set(['gender', 'age_years']);

function normalizeTenantId(tenantId) {
  return tenantId || DEFAULT_TENANT_ID;
}

// ─────────────────────────────── registries ───────────────────────────────

export async function createRegistry({
  code, title, kind = 'registry', trialId = null, description = null,
  principalInvestigatorUid = null,
}, { actorUid = null, tenantId = DEFAULT_TENANT_ID } = {}) {
  const scopedTenantId = normalizeTenantId(tenantId);
  const trimmedCode = String(code || '').trim().toUpperCase();
  if (!trimmedCode || !/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(trimmedCode)) {
    throw AppError.badRequest('Registry code must be 2-40 chars of A-Z, 0-9, dash/underscore', 'RESEARCH_CODE_INVALID');
  }
  if (!title || !String(title).trim()) {
    throw AppError.badRequest('Registry title is required', 'RESEARCH_TITLE_REQUIRED');
  }
  if (!['trial', 'registry', 'audit'].includes(kind)) {
    throw AppError.badRequest('kind must be trial, registry, or audit', 'RESEARCH_KIND_INVALID');
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO research_registries (tenant_id, code, title, kind, trial_id, description, principal_investigator_uid, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8::uuid)
       RETURNING id, tenant_id, code, title, kind, trial_id, status, created_at`,
      scopedTenantId,
      trimmedCode,
      String(title).trim(),
      kind,
      trialId ? Number(trialId) : null,
      description || null,
      principalInvestigatorUid || null,
      actorUid,
    );
    return rows[0];
  } catch (err) {
    if (String(err.message).includes('uq_research_registries_code')) {
      throw AppError.conflict(`Registry code ${trimmedCode} already exists`, 'RESEARCH_CODE_TAKEN');
    }
    throw err;
  }
}

export async function listRegistries({ status = null, tenantId = DEFAULT_TENANT_ID } = {}) {
  const scopedTenantId = normalizeTenantId(tenantId);
  const params = [scopedTenantId];
  let where = 'WHERE r.tenant_id = $1::uuid';
  if (status) {
    params.push(status);
    where += ` AND r.status = $2`;
  }
  return prisma.$queryRawUnsafe(
    `SELECT r.id, r.code, r.title, r.kind, r.trial_id, r.status,
            r.principal_investigator_uid, r.created_at,
            (SELECT COUNT(*)::int FROM research_enrollments e
              WHERE e.tenant_id = r.tenant_id AND e.registry_id = r.id AND e.status IN ('screening', 'enrolled')) AS active_enrollments,
            (SELECT COUNT(*)::int FROM research_crf_forms f
              WHERE f.tenant_id = r.tenant_id AND f.registry_id = r.id AND f.status = 'published') AS published_forms
     FROM research_registries r
     ${where}
     ORDER BY r.created_at DESC`,
    ...params,
  );
}

async function getRegistry(registryId, tenantId = DEFAULT_TENANT_ID) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, code, title, kind, status
       FROM research_registries
      WHERE id = $1
        AND tenant_id = $2::uuid`,
    Number(registryId),
    normalizeTenantId(tenantId),
  );
  if (!rows.length) throw AppError.notFound('Registry not found', 'RESEARCH_REGISTRY_NOT_FOUND');
  return rows[0];
}

// ─────────────────────────────── CRF forms ────────────────────────────────

function validateFieldSchema(fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw AppError.badRequest('fields must be a non-empty array of field definitions', 'RESEARCH_FIELDS_REQUIRED');
  }
  const seen = new Set();
  for (const f of fields) {
    const key = String(f?.key || '').trim();
    if (!key || !/^[a-z][a-z0-9_]{0,59}$/.test(key)) {
      throw AppError.badRequest(`Field key "${key}" must be snake_case (a-z, 0-9, _)`, 'RESEARCH_FIELD_KEY_INVALID');
    }
    if (seen.has(key)) {
      throw AppError.badRequest(`Duplicate field key "${key}"`, 'RESEARCH_FIELD_KEY_DUPLICATE');
    }
    seen.add(key);
    if (!FIELD_TYPES.includes(f.type)) {
      throw AppError.badRequest(`Field "${key}" type must be one of ${FIELD_TYPES.join(', ')}`, 'RESEARCH_FIELD_TYPE_INVALID');
    }
    if (!f.label || !String(f.label).trim()) {
      throw AppError.badRequest(`Field "${key}" needs a label`, 'RESEARCH_FIELD_LABEL_REQUIRED');
    }
    if (f.type === 'select' && (!Array.isArray(f.options) || f.options.length === 0)) {
      throw AppError.badRequest(`Select field "${key}" needs options[]`, 'RESEARCH_FIELD_OPTIONS_REQUIRED');
    }
    if (f.binding) {
      if (!BINDING_SOURCES.includes(f.binding.source)) {
        throw AppError.badRequest(`Field "${key}" binding source must be one of ${BINDING_SOURCES.join(', ')}`, 'RESEARCH_BINDING_SOURCE_INVALID');
      }
      if (f.binding.source === 'vitals_latest' && !VITALS_BINDABLE.has(f.binding.column)) {
        throw AppError.badRequest(`Field "${key}" vitals binding column must be one of ${[...VITALS_BINDABLE].join(', ')}`, 'RESEARCH_BINDING_COLUMN_INVALID');
      }
      if (f.binding.source === 'demographics' && !DEMOGRAPHIC_BINDABLE.has(f.binding.column)) {
        throw AppError.badRequest(`Field "${key}" demographics binding column must be gender or age_years`, 'RESEARCH_BINDING_COLUMN_INVALID');
      }
      if (f.binding.source === 'lab_latest' && !String(f.binding.test_name || f.binding.loinc_code || '').trim()) {
        throw AppError.badRequest(`Field "${key}" lab binding needs test_name or loinc_code`, 'RESEARCH_BINDING_TEST_REQUIRED');
      }
    }
  }
  return fields.map((f) => ({
    key: String(f.key).trim(),
    label: String(f.label).trim(),
    type: f.type,
    required: Boolean(f.required),
    options: f.type === 'select' ? f.options.map(String) : undefined,
    min: f.type === 'number' && f.min !== undefined ? Number(f.min) : undefined,
    max: f.type === 'number' && f.max !== undefined ? Number(f.max) : undefined,
    unit: f.unit ? String(f.unit) : undefined,
    binding: f.binding || undefined,
  }));
}

export async function createCrfForm(registryId, { name, fields }, { actorUid = null, tenantId = DEFAULT_TENANT_ID } = {}) {
  const scopedTenantId = normalizeTenantId(tenantId);
  const registry = await getRegistry(registryId, scopedTenantId);
  const trimmedName = String(name || '').trim();
  if (!trimmedName) throw AppError.badRequest('Form name is required', 'RESEARCH_FORM_NAME_REQUIRED');
  const schema = validateFieldSchema(fields);

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO research_crf_forms (tenant_id, registry_id, name, version, field_schema, created_by)
     VALUES ($1::uuid, $2, $3::varchar,
             COALESCE((SELECT MAX(version) FROM research_crf_forms WHERE tenant_id = $1::uuid AND registry_id = $2 AND name = $3::varchar), 0) + 1,
             $4::jsonb, $5::uuid)
     RETURNING id, tenant_id, registry_id, name, version, status, field_schema, created_at`,
    scopedTenantId,
    registry.id,
    trimmedName,
    JSON.stringify(schema),
    actorUid,
  );
  return rows[0];
}

export async function publishCrfForm(formId, { tenantId = DEFAULT_TENANT_ID } = {}) {
  const scopedTenantId = normalizeTenantId(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE research_crf_forms SET status = 'published', published_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2::uuid AND status = 'draft'
     RETURNING id, tenant_id, registry_id, name, version, status, published_at`,
    Number(formId),
    scopedTenantId,
  );
  if (!rows.length) {
    const existing = await prisma.$queryRawUnsafe(
      `SELECT status FROM research_crf_forms WHERE id = $1 AND tenant_id = $2::uuid`,
      Number(formId),
      scopedTenantId,
    );
    if (!existing.length) throw AppError.notFound('CRF form not found', 'RESEARCH_FORM_NOT_FOUND');
    throw AppError.invalidTransition(existing[0].status, 'published', ['draft']);
  }
  return rows[0];
}

export async function listForms(registryId, { status = null, tenantId = DEFAULT_TENANT_ID } = {}) {
  const params = [Number(registryId), normalizeTenantId(tenantId)];
  let where = 'WHERE registry_id = $1 AND tenant_id = $2::uuid';
  if (status) {
    params.push(status);
    where += ` AND status = $3`;
  }
  return prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, registry_id, name, version, status, field_schema, published_at, created_at
     FROM research_crf_forms ${where}
     ORDER BY name, version DESC`,
    ...params,
  );
}

// ─────────────────────────────── enrollment ───────────────────────────────

export async function enrollPatient(registryId, {
  patientUid, subjectCode = null, matchId = null, consentRef = null, status = 'enrolled',
}, { actorUid = null, actorRole = null, tenantId = DEFAULT_TENANT_ID } = {}) {
  const scopedTenantId = normalizeTenantId(tenantId);
  const registry = await getRegistry(registryId, scopedTenantId);
  if (registry.status !== 'active') {
    throw AppError.invalidTransition(registry.status, 'enrolling', ['active']);
  }
  if (!patientUid) throw AppError.badRequest('patient_uid is required', 'RESEARCH_PATIENT_REQUIRED');
  if (!['screening', 'enrolled'].includes(status)) {
    throw AppError.badRequest('Enrollment status must start as screening or enrolled', 'RESEARCH_STATUS_INVALID');
  }
  const patient = await prisma.$queryRawUnsafe(
    `SELECT uid FROM users WHERE uid = $1::uuid AND tenant_id = $2::uuid AND role = 'PATIENT' LIMIT 1`,
    patientUid,
    scopedTenantId,
  );
  if (!patient.length) throw AppError.notFound('Patient not found', 'RESEARCH_PATIENT_NOT_FOUND');
  if (consentRef) {
    const consentRows = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM patient_consents
        WHERE id::text = $1
          AND patient_uid = $2::uuid
          AND tenant_id = $3::uuid
          AND granted = true
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1`,
      String(consentRef),
      patientUid,
      scopedTenantId,
    );
    if (!consentRows.length) {
      throw AppError.badRequest('consent_ref must reference an active consent for this patient and tenant', 'RESEARCH_CONSENT_REF_INVALID');
    }
  }

  try {
    return await setTenantTx(scopedTenantId, async (tx) => {
      const inserted = await tx.$queryRawUnsafe(
        `INSERT INTO research_enrollments
           (tenant_id, registry_id, patient_uid, subject_code, status, match_id, consent_ref, enrolled_by)
         VALUES ($1::uuid, $2, $3::uuid, COALESCE($4, 'PENDING-' || gen_random_uuid()), $5, $6, $7, $8::uuid)
         RETURNING id, tenant_id, registry_id, patient_uid, subject_code, status, enrolled_at`,
        scopedTenantId,
        registry.id,
        patientUid,
        subjectCode ? String(subjectCode).trim() : null,
        status,
        matchId ? Number(matchId) : null,
        consentRef || null,
        actorUid,
      );
      let enrollment = inserted[0];

      if (!subjectCode) {
        const updated = await tx.$queryRawUnsafe(
          `UPDATE research_enrollments
           SET subject_code = $2 || '-' || LPAD($3::text, 4, '0')
           WHERE id = $1 AND tenant_id = $4::uuid
           RETURNING id, tenant_id, registry_id, patient_uid, subject_code, status, enrolled_at`,
          enrollment.id,
          registry.code,
          String(enrollment.id),
          scopedTenantId,
        );
        enrollment = updated[0];
      }

      await recordCanonicalClinicalEvent({
        tenantId: scopedTenantId,
        patientUid,
        eventType: 'research.enrolled',
        sourceTable: 'research_enrollments',
        sourceId: enrollment.id,
        actorUid,
        actorRole,
        summary: `Enrolled in ${registry.kind} ${registry.code} as ${enrollment.subject_code}`,
        payload: { registry_id: registry.id, registry_code: registry.code, subject_code: enrollment.subject_code, match_id: matchId },
      }, { db: tx });

      return enrollment;
    });
  } catch (err) {
    if (String(err.message).includes('uq_research_enrollments_live')) {
      throw AppError.conflict('Patient already has a live enrollment in this registry', 'RESEARCH_ALREADY_ENROLLED');
    }
    if (String(err.message).includes('uq_research_enrollments_subject')) {
      throw AppError.conflict('Subject code already used in this registry', 'RESEARCH_SUBJECT_CODE_TAKEN');
    }
    throw err;
  }
}

export async function withdrawEnrollment(enrollmentId, { reason }, { actorUid = null, actorRole = null, tenantId = DEFAULT_TENANT_ID } = {}) {
  const scopedTenantId = normalizeTenantId(tenantId);
  if (!reason || !String(reason).trim()) {
    throw AppError.badRequest('Withdrawal reason is required', 'RESEARCH_WITHDRAW_REASON_REQUIRED');
  }
  return setTenantTx(scopedTenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE research_enrollments
       SET status = 'withdrawn', withdrawn_at = NOW(), withdrawal_reason = $2, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $3::uuid AND status IN ('screening', 'enrolled')
       RETURNING id, tenant_id, registry_id, patient_uid, subject_code, status, withdrawn_at`,
      Number(enrollmentId),
      String(reason).trim(),
      scopedTenantId,
    );
    if (!rows.length) {
      const existing = await tx.$queryRawUnsafe(
        `SELECT status FROM research_enrollments WHERE id = $1 AND tenant_id = $2::uuid`,
        Number(enrollmentId),
        scopedTenantId,
      );
      if (!existing.length) throw AppError.notFound('Enrollment not found', 'RESEARCH_ENROLLMENT_NOT_FOUND');
      throw AppError.invalidTransition(existing[0].status, 'withdrawn', ['screening', 'enrolled']);
    }
    const enrollment = rows[0];

    await recordCanonicalClinicalEvent({
      tenantId: scopedTenantId,
      patientUid: enrollment.patient_uid,
      eventType: 'research.withdrawn',
      sourceTable: 'research_enrollments',
      sourceId: enrollment.id,
      actorUid,
      actorRole,
      summary: `Withdrawn from registry enrollment ${enrollment.subject_code}`,
      payload: { registry_id: enrollment.registry_id, subject_code: enrollment.subject_code, reason: String(reason).trim() },
    }, { db: tx });

    return enrollment;
  });
}

export async function listEnrollments(registryId, { status = null, tenantId = DEFAULT_TENANT_ID } = {}) {
  const params = [Number(registryId), normalizeTenantId(tenantId)];
  let where = 'WHERE e.registry_id = $1 AND e.tenant_id = $2::uuid';
  if (status) {
    params.push(status);
    where += ` AND e.status = $3`;
  }
  return prisma.$queryRawUnsafe(
    `SELECT e.id, e.tenant_id, e.registry_id, e.patient_uid, e.subject_code, e.status, e.match_id,
            e.consent_ref, e.enrolled_at, e.withdrawn_at,
            (SELECT COUNT(*)::int FROM research_crf_responses r WHERE r.tenant_id = e.tenant_id AND r.enrollment_id = e.id) AS response_count
     FROM research_enrollments e
     ${where}
     ORDER BY e.enrolled_at DESC`,
    ...params,
  );
}

// ─────────────────────────── binding resolution ───────────────────────────

async function resolveBinding(binding, patientUid, tenantId = DEFAULT_TENANT_ID, db = prisma) {
  const scopedTenantId = normalizeTenantId(tenantId);
  if (binding.source === 'vitals_latest') {
    const column = binding.column;
    if (!VITALS_BINDABLE.has(column)) return null; // schema validated at create; belt-and-braces
    const rows = await db.$queryRawUnsafe(
      `SELECT ${column} AS value, recorded_at FROM vitals_chart
       WHERE patient_uid = $1::uuid
         AND tenant_id = $2::uuid
         AND ${column} IS NOT NULL
       ORDER BY recorded_at DESC LIMIT 1`,
      patientUid,
      scopedTenantId,
    );
    if (!rows.length) return null;
    return { value: Number(rows[0].value), detail: `vitals_chart.${column} @ ${rows[0].recorded_at?.toISOString?.() || rows[0].recorded_at}` };
  }
  if (binding.source === 'lab_latest') {
    const byLoinc = Boolean(binding.loinc_code);
    const rows = await db.$queryRawUnsafe(
      `SELECT value_numeric, value_text, unit, created_at FROM lab_results
       WHERE patient_uid = $1::uuid
         AND tenant_id = $2::uuid
         AND ${byLoinc ? 'loinc_code = $3' : 'LOWER(test_name) = LOWER($3)'}
       ORDER BY created_at DESC LIMIT 1`,
      patientUid,
      scopedTenantId,
      byLoinc ? String(binding.loinc_code) : String(binding.test_name),
    );
    if (!rows.length) return null;
    const value = rows[0].value_numeric !== null && rows[0].value_numeric !== undefined
      ? Number(rows[0].value_numeric)
      : rows[0].value_text;
    return { value, detail: `lab_results ${byLoinc ? binding.loinc_code : binding.test_name} @ ${rows[0].created_at?.toISOString?.() || rows[0].created_at}` };
  }
  if (binding.source === 'demographics') {
    const rows = await db.$queryRawUnsafe(
      `SELECT gender, birthday
         FROM users
        WHERE uid = $1::uuid
          AND tenant_id = $2::uuid
          AND role = 'PATIENT'
        LIMIT 1`,
      patientUid,
      scopedTenantId,
    );
    if (!rows.length) return null;
    if (binding.column === 'gender') {
      return rows[0].gender ? { value: rows[0].gender, detail: 'users.gender' } : null;
    }
    if (binding.column === 'age_years' && rows[0].birthday) {
      const age = Math.floor((Date.now() - new Date(rows[0].birthday).getTime()) / (365.25 * 24 * 3600 * 1000));
      return { value: age, detail: `users.birthday (${new Date(rows[0].birthday).toISOString().slice(0, 10)})` };
    }
    return null;
  }
  return null;
}

function validateResponseData(schema, data) {
  const errors = [];
  const clean = {};
  for (const field of schema) {
    const raw = data[field.key];
    const absent = raw === undefined || raw === null || raw === '';
    if (absent) {
      if (field.required) errors.push(`${field.key} is required`);
      continue;
    }
    switch (field.type) {
      case 'number': {
        const n = Number(raw);
        if (!Number.isFinite(n)) { errors.push(`${field.key} must be a number`); break; }
        if (field.min !== undefined && n < field.min) errors.push(`${field.key} below minimum ${field.min}`);
        if (field.max !== undefined && n > field.max) errors.push(`${field.key} above maximum ${field.max}`);
        clean[field.key] = n;
        break;
      }
      case 'boolean':
        if (typeof raw !== 'boolean' && !['true', 'false'].includes(String(raw))) {
          errors.push(`${field.key} must be boolean`);
        } else clean[field.key] = typeof raw === 'boolean' ? raw : raw === 'true';
        break;
      case 'date': {
        const dt = new Date(raw);
        if (Number.isNaN(dt.getTime())) errors.push(`${field.key} must be a valid date`);
        else clean[field.key] = dt.toISOString().slice(0, 10);
        break;
      }
      case 'select':
        if (!field.options.includes(String(raw))) errors.push(`${field.key} must be one of ${field.options.join(', ')}`);
        else clean[field.key] = String(raw);
        break;
      default:
        clean[field.key] = String(raw);
    }
  }
  return { errors, clean };
}

// ──────────────────────────────── responses ───────────────────────────────

export async function captureCrfResponse(formId, {
  enrollmentId, visitLabel = 'baseline', data = {}, autofill = true,
}, { actorUid = null, tenantId = DEFAULT_TENANT_ID } = {}) {
  const scopedTenantId = normalizeTenantId(tenantId);
  const forms = await prisma.$queryRawUnsafe(
    `SELECT f.id, f.tenant_id, f.registry_id, f.name, f.version, f.status, f.field_schema
     FROM research_crf_forms f WHERE f.id = $1 AND f.tenant_id = $2::uuid`,
    Number(formId),
    scopedTenantId,
  );
  if (!forms.length) throw AppError.notFound('CRF form not found', 'RESEARCH_FORM_NOT_FOUND');
  const form = forms[0];
  if (form.status !== 'published') {
    throw AppError.badRequest('Responses can only be captured against published forms', 'RESEARCH_FORM_NOT_PUBLISHED');
  }

  const enrollments = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, registry_id, patient_uid, subject_code, status
       FROM research_enrollments
      WHERE id = $1
        AND tenant_id = $2::uuid`,
    Number(enrollmentId),
    scopedTenantId,
  );
  if (!enrollments.length) throw AppError.notFound('Enrollment not found', 'RESEARCH_ENROLLMENT_NOT_FOUND');
  const enrollment = enrollments[0];
  if (enrollment.registry_id !== form.registry_id) {
    throw AppError.badRequest('Enrollment belongs to a different registry than the form', 'RESEARCH_REGISTRY_MISMATCH');
  }
  if (!['screening', 'enrolled'].includes(enrollment.status)) {
    throw AppError.invalidTransition(enrollment.status, 'capturing CRF data', ['screening', 'enrolled']);
  }

  const schema = Array.isArray(form.field_schema) ? form.field_schema : JSON.parse(form.field_schema || '[]');

  // Auto-pull bound fields the caller did not supply.
  const autofilled = {};
  const merged = { ...data };
  if (autofill) {
    for (const field of schema) {
      if (!field.binding) continue;
      if (merged[field.key] !== undefined && merged[field.key] !== null && merged[field.key] !== '') continue;
      try {
        const resolved = await resolveBinding(field.binding, enrollment.patient_uid, scopedTenantId);
        if (resolved !== null) {
          merged[field.key] = resolved.value;
          autofilled[field.key] = {
            source: field.binding.source,
            detail: resolved.detail,
            value: resolved.value,
            resolved_at: new Date().toISOString(),
          };
        }
      } catch (err) {
        logger.warn('CRF binding resolution failed; field left blank', {
          formId: form.id, field: field.key, error: err.message,
        });
      }
    }
  }

  // Draft saves tolerate missing required fields (submission enforces).
  const { errors, clean } = validateResponseData(schema, merged);
  const typeErrors = errors.filter((e) => !e.endsWith('is required'));
  if (typeErrors.length) {
    throw AppError.badRequest('CRF data failed validation', 'RESEARCH_DATA_INVALID', { errors: typeErrors });
  }

  const existing = await prisma.$queryRawUnsafe(
    `SELECT id, status FROM research_crf_responses
     WHERE enrollment_id = $1 AND form_id = $2 AND visit_label = $3 AND tenant_id = $4::uuid`,
    enrollment.id, form.id, String(visitLabel).trim(), scopedTenantId,
  );
  if (existing.length && existing[0].status !== 'draft') {
    throw AppError.invalidTransition(existing[0].status, 'draft edit', ['draft']);
  }

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO research_crf_responses
       (tenant_id, form_id, enrollment_id, visit_label, data, autofilled, recorded_by)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, $7::uuid)
     ON CONFLICT (enrollment_id, form_id, visit_label)
     DO UPDATE SET data = EXCLUDED.data, autofilled = EXCLUDED.autofilled,
                   recorded_by = EXCLUDED.recorded_by, updated_at = NOW()
     RETURNING id, tenant_id, form_id, enrollment_id, visit_label, data, autofilled, status, created_at, updated_at`,
    scopedTenantId,
    form.id,
    enrollment.id,
    String(visitLabel).trim(),
    JSON.stringify(clean),
    JSON.stringify(autofilled),
    actorUid,
  );
  return { ...rows[0], missing_required: errors.filter((e) => e.endsWith('is required')) };
}

export async function submitCrfResponse(responseId, { actorUid = null, actorRole = null, tenantId = DEFAULT_TENANT_ID } = {}) {
  const scopedTenantId = normalizeTenantId(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT r.id, r.tenant_id, r.status, r.data, r.visit_label, r.form_id, r.enrollment_id,
            f.field_schema, f.name AS form_name, f.version AS form_version, f.registry_id,
            e.patient_uid, e.subject_code
     FROM research_crf_responses r
     JOIN research_crf_forms f ON f.id = r.form_id AND f.tenant_id = r.tenant_id
     JOIN research_enrollments e ON e.id = r.enrollment_id AND e.tenant_id = r.tenant_id
     WHERE r.id = $1
       AND r.tenant_id = $2::uuid`,
    Number(responseId),
    scopedTenantId,
  );
  if (!rows.length) throw AppError.notFound('CRF response not found', 'RESEARCH_RESPONSE_NOT_FOUND');
  const response = rows[0];
  if (response.status !== 'draft') {
    throw AppError.invalidTransition(response.status, 'submitted', ['draft']);
  }

  const schema = Array.isArray(response.field_schema) ? response.field_schema : JSON.parse(response.field_schema || '[]');
  const dataObj = typeof response.data === 'object' && response.data !== null ? response.data : JSON.parse(response.data || '{}');
  const { errors } = validateResponseData(schema, dataObj);
  if (errors.length) {
    throw AppError.badRequest('CRF response incomplete', 'RESEARCH_RESPONSE_INCOMPLETE', { errors });
  }

  return setTenantTx(scopedTenantId, async (tx) => {
    const updated = await tx.$queryRawUnsafe(
      `UPDATE research_crf_responses
       SET status = 'submitted', submitted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2::uuid AND status = 'draft'
       RETURNING id, tenant_id, form_id, enrollment_id, visit_label, status, submitted_at`,
      response.id,
      scopedTenantId,
    );
    if (!updated.length) throw AppError.conflict('Response state changed concurrently', 'RESEARCH_RESPONSE_RACE');

    await recordCanonicalClinicalEvent({
      tenantId: scopedTenantId,
      patientUid: response.patient_uid,
      eventType: 'research.crf_submitted',
      sourceTable: 'research_crf_responses',
      sourceId: response.id,
      actorUid,
      actorRole,
      summary: `CRF ${response.form_name} v${response.form_version} (${response.visit_label}) submitted for ${response.subject_code}`,
      payload: {
        registry_id: response.registry_id,
        form_id: response.form_id,
        visit_label: response.visit_label,
        subject_code: response.subject_code,
      },
    }, { db: tx });

    return updated[0];
  });
}

export async function verifyCrfResponse(responseId, { actorUid = null, tenantId = DEFAULT_TENANT_ID } = {}) {
  const scopedTenantId = normalizeTenantId(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE research_crf_responses
     SET status = 'verified', verified_by = $2::uuid, verified_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND tenant_id = $3::uuid AND status = 'submitted'
     RETURNING id, tenant_id, status, verified_by, verified_at`,
    Number(responseId),
    actorUid,
    scopedTenantId,
  );
  if (!rows.length) {
    const existing = await prisma.$queryRawUnsafe(
      `SELECT status FROM research_crf_responses WHERE id = $1 AND tenant_id = $2::uuid`,
      Number(responseId),
      scopedTenantId,
    );
    if (!existing.length) throw AppError.notFound('CRF response not found', 'RESEARCH_RESPONSE_NOT_FOUND');
    throw AppError.invalidTransition(existing[0].status, 'verified', ['submitted']);
  }
  return rows[0];
}

// ───────────────────────────────── export ─────────────────────────────────

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportRegistry(registryId, { format = 'csv', includePhi = false, deidentify = false, salt = null, tenantId = DEFAULT_TENANT_ID } = {}) {
  const scopedTenantId = normalizeTenantId(tenantId);
  const registry = await getRegistry(registryId, scopedTenantId);
  if (!['csv', 'xlsx'].includes(format)) {
    throw AppError.badRequest('format must be csv or xlsx', 'RESEARCH_EXPORT_FORMAT_INVALID');
  }

  // De-identification is fail-closed: it must NEVER also emit the raw patient_uid
  // column, so it forces includePhi off. The de-id service is lazy-imported here
  // (not at module top) so this module's eager import graph stays unchanged —
  // several suites mock ../../lib/prisma.js and a new eager import could break them.
  if (deidentify) includePhi = false;
  const deidMod = deidentify ? await import('../ai/deidentificationService.js') : null;
  // Fetch each patient's chart-anchored identifiers at most once per export.
  const idCache = new Map();
  const idsFor = async (uid) => {
    if (!idCache.has(uid)) {
      idCache.set(uid, await deidMod.collectKnownIdentifiers(uid, { tenantId: scopedTenantId }));
    }
    return idCache.get(uid);
  };
  let deidResidual = 0;

  const rows = await prisma.$queryRawUnsafe(
    `SELECT e.subject_code, e.status AS enrollment_status, e.enrolled_at, e.patient_uid,
            f.name AS form_name, f.version AS form_version,
            r.visit_label, r.status AS response_status, r.data, r.autofilled, r.submitted_at
     FROM research_crf_responses r
     JOIN research_enrollments e ON e.id = r.enrollment_id AND e.tenant_id = r.tenant_id
     JOIN research_crf_forms f ON f.id = r.form_id AND f.tenant_id = r.tenant_id
     WHERE e.registry_id = $1
       AND r.tenant_id = $2::uuid
     ORDER BY e.subject_code, f.name, f.version, r.visit_label`,
    registry.id,
    scopedTenantId,
  );

  // Union of field keys across the registry's forms keeps one flat grid.
  const forms = await listForms(registry.id, { tenantId: scopedTenantId });
  const fieldKeys = [];
  for (const form of forms) {
    const schema = Array.isArray(form.field_schema) ? form.field_schema : JSON.parse(form.field_schema || '[]');
    for (const f of schema) if (!fieldKeys.includes(f.key)) fieldKeys.push(f.key);
  }

  const baseHeaders = ['subject_code', 'enrollment_status', 'form', 'form_version', 'visit', 'response_status', 'submitted_at'];
  if (includePhi) baseHeaders.splice(1, 0, 'patient_uid');
  const headers = [...baseHeaders, ...fieldKeys, 'autofilled_fields'];

  const grid = [];
  for (const row of rows) {
    const dataObj = typeof row.data === 'object' && row.data !== null ? row.data : JSON.parse(row.data || '{}');
    const autoObj = typeof row.autofilled === 'object' && row.autofilled !== null ? row.autofilled : JSON.parse(row.autofilled || '{}');
    const record = {
      subject_code: row.subject_code,
      enrollment_status: row.enrollment_status,
      form: row.form_name,
      form_version: row.form_version,
      visit: row.visit_label,
      response_status: row.response_status,
      submitted_at: row.submitted_at ? new Date(row.submitted_at).toISOString() : '',
      autofilled_fields: Object.keys(autoObj).join(';'),
    };
    if (includePhi) record.patient_uid = row.patient_uid;
    for (const key of fieldKeys) {
      const value = dataObj[key] !== undefined ? dataObj[key] : '';
      if (deidentify && typeof value === 'string' && value !== '') {
        const result = deidMod.deidentifyText(value, {
          knownIdentifiers: await idsFor(row.patient_uid),
          mode: 'pseudonymize',
          salt,
        });
        if (result.residualFlags.length > 0) deidResidual += 1;
        record[key] = result.text;
      } else {
        record[key] = value;
      }
    }
    grid.push(record);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'csv') {
    const lines = [headers.join(',')];
    for (const record of grid) lines.push(headers.map((h) => csvEscape(record[h])).join(','));
    return {
      filename: `${registry.code}-export-${stamp}.csv`,
      contentType: 'text/csv; charset=utf-8',
      buffer: Buffer.from(lines.join('\r\n'), 'utf8'),
      rowCount: grid.length,
      deidResidual,
    };
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(registry.code.slice(0, 28));
  sheet.columns = headers.map((h) => ({ header: h, key: h, width: Math.max(12, h.length + 2) }));
  sheet.getRow(1).font = { bold: true };
  for (const record of grid) sheet.addRow(record);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return {
    filename: `${registry.code}-export-${stamp}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer,
    rowCount: grid.length,
    deidResidual,
  };
}

export default {
  createRegistry,
  listRegistries,
  createCrfForm,
  publishCrfForm,
  listForms,
  enrollPatient,
  withdrawEnrollment,
  listEnrollments,
  captureCrfResponse,
  submitCrfResponse,
  verifyCrfResponse,
  exportRegistry,
};
