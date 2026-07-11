import crypto from 'node:crypto';
import { setTenant, setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import {
  canEditCathReport,
  canOpenCathViewer,
  canSignCathReport,
  canViewCathReport,
} from '../../utils/roleHelpers.js';
import {
  recordCanonicalClinicalEvent,
  recordClinicalAuditEvent,
} from './canonicalClinicalPlatformService.js';
import { assertPrivilegeForGate } from '../staff/credentialingService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { buildViewerUrl, getPacsConfig } from '../radiology/pacsService.js';

export const CATH_REPORT_TYPES = Object.freeze([
  'angiogram',
  'ptca',
  'ppi',
  'device_implant',
  'ep_study',
  'procedure_note',
  'other',
]);

export const CATH_REPORT_STATUSES = Object.freeze(['draft', 'preliminary', 'signed']);
export const CATH_REPORT_TRANSITIONS = Object.freeze({
  draft: ['preliminary'],
  preliminary: ['signed'],
  signed: [],
});

const DICOM_STUDY_UID_RE = /^[0-9]+(?:\.[0-9]+)+$/;

const REPORT_RETURNING = `id, tenant_id, case_id, procedure_log_id, patient_uid,
  encounter_id, report_type, template_id, template_version, narrative_sections,
  coded_fields, findings_summary, status, viewer_study_accession, preliminary_by,
  preliminary_at, signed_by, signed_at, created_by, updated_by, created_at,
  updated_at, metadata`;

function tenantOr(value) {
  return requireTenantId(value);
}

function cleanText(value, max = 8000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`, 'CATH_REPORT_BAD_ID');
  }
  return parsed;
}

function maybeUuid(value, label = 'uid', { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`, 'CATH_REPORT_ACTOR_REQUIRED');
    return null;
  }
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`, 'CATH_REPORT_BAD_UUID');
  }
  return text;
}

function normalizeReportType(value) {
  const reportType = cleanText(value, 40)?.toLowerCase();
  if (!reportType || !CATH_REPORT_TYPES.includes(reportType)) {
    throw AppError.badRequest(
      `report_type must be one of: ${CATH_REPORT_TYPES.join(', ')}`,
      'CATH_REPORT_TYPE_INVALID',
    );
  }
  return reportType;
}

function normalizeJsonArray(value, label, fallback = []) {
  if (value === null || value === undefined) return fallback;
  if (!Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON array`, 'CATH_REPORT_JSON_INVALID');
  }
  return value;
}

function normalizeJsonObject(value, label, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`, 'CATH_REPORT_JSON_INVALID');
  }
  return value;
}

function normalizeDbValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value?.toNumber === 'function') return value.toNumber();
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(normalizeDbValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeDbValue(entry)]),
    );
  }
  return value;
}

function contextRoles(context = {}) {
  return [
    context.actorRole,
    context.rawRole,
    ...(Array.isArray(context.actorRoles) ? context.actorRoles : []),
  ].filter(Boolean);
}

function requireContextRole(context, predicate, message, code) {
  if (!contextRoles(context).some((role) => predicate(role))) {
    throw AppError.forbidden(message, code);
  }
}

function requireReadAccess(context) {
  requireContextRole(
    context,
    canViewCathReport,
    'Cath report read access is required',
    'CATH_REPORT_READ_FORBIDDEN',
  );
}

function requireEditAccess(context) {
  requireContextRole(
    context,
    canEditCathReport,
    'Cath report draft/edit access is required',
    'CATH_REPORT_EDIT_FORBIDDEN',
  );
}

function requireSignAccess(context) {
  requireContextRole(
    context,
    canSignCathReport,
    'Cath report sign-off requires a doctor role',
    'CATH_REPORT_SIGNER_REQUIRED',
  );
}

function requireViewerAccess(context) {
  requireContextRole(
    context,
    canOpenCathViewer,
    'Cath image viewer access is required',
    'CATH_REPORT_VIEWER_FORBIDDEN',
  );
}

function deriveFindingsSummary(sections, explicitValue) {
  if (explicitValue !== undefined) return cleanText(explicitValue);
  const findings = sections.find((section) => {
    const key = cleanText(section?.key ?? section?.section_key ?? section?.title, 120);
    return key?.toLowerCase().replace(/[^a-z0-9]+/g, '_') === 'findings';
  });
  return cleanText(findings?.text ?? findings?.value ?? findings?.content ?? findings?.narrative);
}

export function validateReportTransition(from, to) {
  const target = cleanText(to, 20)?.toLowerCase();
  const allowed = CATH_REPORT_TRANSITIONS[from] || [];
  if (!target || !allowed.includes(target)) {
    throw AppError.invalidTransition(from, target, allowed);
  }
  return target;
}

function auditKey(context, action, resourceId) {
  const requestScope = cleanText(context?.requestId, 180) || crypto.randomUUID();
  const key = `cath_report:${resourceId}:${action}:${requestScope}`;
  if (key.length <= 220) return key;
  const digest = crypto.createHash('sha256').update(key).digest('hex');
  return `cath_report:${String(resourceId).slice(0, 40)}:${String(action).slice(0, 60)}:${digest}`;
}

async function writeAudit(db, report, action, context = {}, metadata = {}, resourceId = null) {
  const audit = await recordClinicalAuditEvent({
    tenantId: report.tenant_id,
    patientUid: report.patient_uid,
    encounterId: report.encounter_id,
    action,
    actionStatus: 'success',
    actorUid: context.actorUid,
    actorRole: context.actorRole,
    resourceType: 'cath_report',
    resourceTable: 'cath_procedure_reports',
    resourceId: String(resourceId ?? report.id),
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: {
      case_id: normalizeDbValue(report.case_id),
      report_type: report.report_type,
      report_status: report.status,
      ...metadata,
    },
    idempotencyKey: auditKey(context, action, resourceId ?? report.id),
  }, { db });
  if (!audit?.id) {
    throw AppError.internal(
      'Required cath report audit event could not be recorded',
      'CATH_REPORT_AUDIT_REQUIRED',
    );
  }
  return audit;
}

async function caseById(db, tenantId, caseId, { lock = false } = {}) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, encounter_id, requested_procedure,
            status, actual_end_at, planned_start_at
       FROM cath_lab_cases
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
      ${lock ? 'FOR UPDATE' : ''}
      LIMIT 1`,
    tenantOr(tenantId),
    normalizeId(caseId, 'case_id'),
  );
  if (!rows.length) throw AppError.notFound('Cath-lab case not found', 'CATH_LAB_CASE_NOT_FOUND');
  return rows[0];
}

async function templateById(db, tenantId, templateId, { activeOnly = true, lock = false } = {}) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, tenant_id, template_code, name, report_type, sections,
            coded_fields_schema, version, is_active, supersedes_template_id,
            created_by, created_at, updated_at, metadata
       FROM cath_report_templates
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
        ${activeOnly ? 'AND is_active = TRUE' : ''}
      ${lock ? 'FOR UPDATE' : ''}
      LIMIT 1`,
    tenantOr(tenantId),
    normalizeId(templateId, 'template_id'),
  );
  if (!rows.length) {
    throw AppError.notFound('Cath report template not found', 'CATH_REPORT_TEMPLATE_NOT_FOUND');
  }
  return rows[0];
}

async function assertProcedureLogForCase(db, tenantId, caseId, procedureLogId) {
  if (procedureLogId === null || procedureLogId === undefined || procedureLogId === '') return null;
  const rows = await db.$queryRawUnsafe(
    `SELECT id, tenant_id, case_id, patient_uid, encounter_id, procedure_type,
            findings_summary, operators, started_at, ended_at, status
       FROM cath_procedure_logs
      WHERE tenant_id = $1::uuid
        AND case_id = $2::bigint
        AND id = $3::bigint
      LIMIT 1`,
    tenantOr(tenantId),
    normalizeId(caseId, 'case_id'),
    normalizeId(procedureLogId, 'procedure_log_id'),
  );
  if (!rows.length) {
    throw AppError.badRequest(
      'procedure_log_id must belong to the selected cath-lab case',
      'CATH_REPORT_PROCEDURE_LOG_MISMATCH',
    );
  }
  return rows[0];
}

async function reportById(db, tenantId, reportId, { lock = false } = {}) {
  const rows = await db.$queryRawUnsafe(
    `SELECT ${REPORT_RETURNING}
       FROM cath_procedure_reports
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
      ${lock ? 'FOR UPDATE' : ''}
      LIMIT 1`,
    tenantOr(tenantId),
    normalizeId(reportId, 'report_id'),
  );
  if (!rows.length) throw AppError.notFound('Cath report not found', 'CATH_REPORT_NOT_FOUND');
  return rows[0];
}

async function loadReportDetail(db, tenantId, reportId) {
  const report = await reportById(db, tenantId, reportId);
  const addenda = await db.$queryRawUnsafe(
    `SELECT addendum.id, addendum.tenant_id, addendum.report_id,
            addendum.case_id, addendum.patient_uid, addendum.encounter_id,
            addendum.author_uid, author.name AS author_name,
            author.role AS author_role, addendum.reason, addendum.narrative,
            addendum.created_at, addendum.metadata
       FROM cath_report_addenda addendum
       LEFT JOIN users author
         ON author.tenant_id = addendum.tenant_id
        AND author.uid = addendum.author_uid
      WHERE addendum.tenant_id = $1::uuid
        AND addendum.report_id = $2::bigint
      ORDER BY addendum.created_at ASC, addendum.id ASC`,
    tenantOr(tenantId),
    normalizeId(reportId, 'report_id'),
  );
  const identities = await db.$queryRawUnsafe(
    `SELECT
        (SELECT name FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid LIMIT 1) AS patient_name,
        (SELECT name FROM users WHERE tenant_id = $1::uuid AND uid = $3::uuid LIMIT 1) AS signed_by_name,
        (SELECT role FROM users WHERE tenant_id = $1::uuid AND uid = $3::uuid LIMIT 1) AS signed_by_role`,
    tenantOr(tenantId),
    report.patient_uid,
    report.signed_by,
  );
  const procedureContext = await db.$queryRawUnsafe(
    `SELECT c.requested_procedure,
            p.procedure_type,
            p.started_at AS procedure_started_at,
            p.ended_at AS procedure_ended_at,
            p.operators AS procedure_operators,
            t.template_code,
            t.name AS template_name
       FROM cath_lab_cases c
       JOIN cath_report_templates t
         ON t.tenant_id = c.tenant_id
        AND t.id = $3::bigint
       LEFT JOIN cath_procedure_logs p
         ON p.tenant_id = c.tenant_id
        AND p.id = $4::bigint
      WHERE c.tenant_id = $1::uuid
        AND c.id = $2::bigint
      LIMIT 1`,
    tenantOr(tenantId),
    report.case_id,
    report.template_id,
    report.procedure_log_id,
  );
  return normalizeDbValue({
    ...report,
    patient_name: identities[0]?.patient_name || null,
    signed_by_name: identities[0]?.signed_by_name || null,
    signed_by_role: identities[0]?.signed_by_role || null,
    requested_procedure: procedureContext[0]?.requested_procedure || null,
    procedure_type: procedureContext[0]?.procedure_type || null,
    procedure_started_at: procedureContext[0]?.procedure_started_at || null,
    procedure_ended_at: procedureContext[0]?.procedure_ended_at || null,
    procedure_operators: procedureContext[0]?.procedure_operators || [],
    template_code: procedureContext[0]?.template_code || null,
    template_name: procedureContext[0]?.template_name || null,
    addenda,
  });
}

export async function listReportTemplates(filters = {}, context = {}) {
  requireReadAccess(context);
  const tenantId = tenantOr(filters.tenantId || filters.tenant_id);
  const params = [tenantId];
  const conditions = ['tenant_id = $1::uuid'];
  if (filters.report_type || filters.reportType) {
    params.push(normalizeReportType(filters.report_type || filters.reportType));
    conditions.push(`report_type = $${params.length}`);
  }
  if (filters.activeOnly !== false) conditions.push('is_active = TRUE');
  return setTenant(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, tenant_id, template_code, name, report_type, sections,
              coded_fields_schema, version, is_active, supersedes_template_id,
              created_by, created_at, updated_at, metadata
         FROM cath_report_templates
        WHERE ${conditions.join(' AND ')}
        ORDER BY report_type, name, version DESC`,
      ...params,
    );
    return normalizeDbValue(rows);
  }, { readOnly: true });
}

export async function supersedeReportTemplate(templateId, input = {}, context = {}) {
  requireEditAccess(context);
  const tenantId = tenantOr(input.tenantId || input.tenant_id);
  const actorUid = maybeUuid(context.actorUid, 'actorUid', { required: true });
  return setTenantTx(tenantId, async (tx) => {
    const current = await templateById(tx, tenantId, templateId, { activeOnly: false, lock: true });
    if (!current.is_active) {
      throw AppError.conflict('Only the active template version can be superseded', 'CATH_TEMPLATE_INACTIVE');
    }
    const versionRows = await tx.$queryRawUnsafe(
      `SELECT COALESCE(MAX(version), 0)::int + 1 AS next_version
         FROM cath_report_templates
        WHERE tenant_id = $1::uuid
          AND template_code = $2`,
      tenantId,
      current.template_code,
    );
    const nextVersion = Number(versionRows[0]?.next_version || current.version + 1);
    await tx.$queryRawUnsafe(
      `UPDATE cath_report_templates
          SET is_active = FALSE,
              superseded_at = NOW(),
              superseded_by = $3::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      tenantId,
      current.id,
      actorUid,
    );
    const sections = normalizeJsonArray(input.sections, 'sections', current.sections);
    const codedSchema = normalizeJsonObject(
      input.coded_fields_schema ?? input.codedFieldsSchema,
      'coded_fields_schema',
      current.coded_fields_schema,
    );
    const metadata = {
      ...normalizeJsonObject(current.metadata, 'current.metadata', {}),
      ...normalizeJsonObject(input.metadata, 'metadata', {}),
    };
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_report_templates
         (tenant_id, template_code, name, report_type, sections,
          coded_fields_schema, version, is_active, supersedes_template_id,
          created_by, metadata)
       VALUES ($1::uuid, $2, $3, $4, $5::jsonb,
               $6::jsonb, $7::int, TRUE, $8::bigint, $9::uuid, $10::jsonb)
       RETURNING id, tenant_id, template_code, name, report_type, sections,
                 coded_fields_schema, version, is_active, supersedes_template_id,
                 created_by, created_at, updated_at, metadata`,
      tenantId,
      current.template_code,
      cleanText(input.name, 160) || current.name,
      current.report_type,
      JSON.stringify(sections),
      JSON.stringify(codedSchema),
      nextVersion,
      current.id,
      actorUid,
      JSON.stringify(metadata),
    );
    return normalizeDbValue(rows[0]);
  });
}

export async function createReport(caseId, input = {}, context = {}) {
  requireEditAccess(context);
  const tenantId = tenantOr(input.tenantId || input.tenant_id);
  const actorUid = maybeUuid(context.actorUid, 'actorUid', { required: true });
  const sections = normalizeJsonArray(
    input.narrative_sections ?? input.narrativeSections,
    'narrative_sections',
    [],
  );
  const codedFields = normalizeJsonObject(
    input.coded_fields ?? input.codedFields,
    'coded_fields',
    {},
  );
  const metadata = normalizeJsonObject(input.metadata, 'metadata', {});

  return setTenantTx(tenantId, async (tx) => {
    const cathCase = await caseById(tx, tenantId, caseId, { lock: true });
    const template = await templateById(
      tx,
      tenantId,
      input.template_id ?? input.templateId,
      { activeOnly: true },
    );
    const reportType = input.report_type || input.reportType
      ? normalizeReportType(input.report_type || input.reportType)
      : template.report_type;
    if (reportType !== template.report_type) {
      throw AppError.badRequest(
        'report_type must match the selected template',
        'CATH_REPORT_TEMPLATE_TYPE_MISMATCH',
      );
    }
    const procedure = await assertProcedureLogForCase(
      tx,
      tenantId,
      cathCase.id,
      input.procedure_log_id ?? input.procedureLogId,
    );
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_procedure_reports
         (tenant_id, case_id, procedure_log_id, patient_uid, encounter_id,
          report_type, template_id, template_version, narrative_sections,
          coded_fields, findings_summary, status, viewer_study_accession,
          created_by, updated_by, metadata)
       VALUES ($1::uuid, $2::bigint, $3::bigint, $4::uuid, $5::uuid,
               $6, $7::bigint, $8::int, $9::jsonb,
               $10::jsonb, $11, 'draft', $12, $13::uuid, $13::uuid, $14::jsonb)
       RETURNING ${REPORT_RETURNING}`,
      tenantId,
      cathCase.id,
      procedure?.id || null,
      cathCase.patient_uid,
      cathCase.encounter_id,
      reportType,
      template.id,
      template.version,
      JSON.stringify(sections),
      JSON.stringify(codedFields),
      deriveFindingsSummary(sections, input.findings_summary ?? input.findingsSummary),
      cleanText(input.viewer_study_accession ?? input.viewerStudyAccession, 160),
      actorUid,
      JSON.stringify(metadata),
    );
    const report = rows[0];
    await writeAudit(tx, report, 'cath_lab.report_created', context, {
      template_id: normalizeDbValue(template.id),
      template_version: template.version,
    });
    return normalizeDbValue({ ...report, addenda: [] });
  });
}

export async function listReports(caseId, options = {}, context = {}) {
  requireReadAccess(context);
  const tenantId = tenantOr(options.tenantId || options.tenant_id);
  return setTenantTx(tenantId, async (tx) => {
    await caseById(tx, tenantId, caseId);
    const rows = await tx.$queryRawUnsafe(
      `SELECT r.id, r.tenant_id, r.case_id, r.procedure_log_id, r.patient_uid,
              r.encounter_id, r.report_type, r.template_id, r.template_version,
              r.narrative_sections, r.coded_fields, r.findings_summary, r.status,
              r.viewer_study_accession, r.preliminary_by, r.preliminary_at,
              r.signed_by, r.signed_at, r.created_by, r.updated_by, r.created_at,
              r.updated_at, r.metadata, t.template_code, t.name AS template_name,
              signer.name AS signed_by_name, signer.role AS signed_by_role,
              tat.procedure_ended_at, tat.procedure_to_signed_minutes,
              tat.current_elapsed_minutes, addendum_data.addenda,
              jsonb_array_length(addendum_data.addenda)::int AS addenda_count
         FROM cath_procedure_reports r
         JOIN cath_report_templates t
           ON t.tenant_id = r.tenant_id AND t.id = r.template_id
         LEFT JOIN users signer
           ON signer.tenant_id = r.tenant_id AND signer.uid = r.signed_by
         LEFT JOIN cath_report_tat_metrics tat
           ON tat.tenant_id = r.tenant_id AND tat.report_id = r.id
         LEFT JOIN LATERAL (
           SELECT COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'id', addendum.id,
                 'tenant_id', addendum.tenant_id,
                 'report_id', addendum.report_id,
                 'case_id', addendum.case_id,
                 'patient_uid', addendum.patient_uid,
                 'encounter_id', addendum.encounter_id,
                 'author_uid', addendum.author_uid,
                 'author_name', author.name,
                 'author_role', author.role,
                 'reason', addendum.reason,
                 'narrative', addendum.narrative,
                 'created_at', addendum.created_at,
                 'metadata', addendum.metadata
               ) ORDER BY addendum.created_at ASC, addendum.id ASC
             ),
             '[]'::jsonb
           ) AS addenda
             FROM cath_report_addenda addendum
             LEFT JOIN users author
               ON author.tenant_id = addendum.tenant_id
              AND author.uid = addendum.author_uid
            WHERE addendum.tenant_id = r.tenant_id
              AND addendum.report_id = r.id
         ) addendum_data ON TRUE
        WHERE r.tenant_id = $1::uuid
          AND r.case_id = $2::bigint
        ORDER BY r.created_at DESC, r.id DESC`,
      tenantId,
      normalizeId(caseId, 'case_id'),
    );
    for (const report of rows) {
      await writeAudit(tx, report, 'cath_lab.report_viewed', context, {
        view: 'case_report_list',
      });
    }
    return normalizeDbValue(rows);
  });
}

export async function getReport(reportId, options = {}, context = {}) {
  requireReadAccess(context);
  const tenantId = tenantOr(options.tenantId || options.tenant_id);
  return setTenantTx(tenantId, async (tx) => {
    const report = await loadReportDetail(tx, tenantId, reportId);
    await writeAudit(tx, report, 'cath_lab.report_viewed', context, { view: 'report_detail' });
    return report;
  });
}

export async function updateReport(reportId, input = {}, context = {}) {
  requireEditAccess(context);
  const tenantId = tenantOr(input.tenantId || input.tenant_id);
  const actorUid = maybeUuid(context.actorUid, 'actorUid', { required: true });
  const hasSections = Object.hasOwn(input, 'narrative_sections') || Object.hasOwn(input, 'narrativeSections');
  const hasCodedFields = Object.hasOwn(input, 'coded_fields') || Object.hasOwn(input, 'codedFields');
  const hasFindings = Object.hasOwn(input, 'findings_summary') || Object.hasOwn(input, 'findingsSummary');
  const hasViewer = Object.hasOwn(input, 'viewer_study_accession') || Object.hasOwn(input, 'viewerStudyAccession');
  const hasMetadata = Object.hasOwn(input, 'metadata');
  if (![hasSections, hasCodedFields, hasFindings, hasViewer, hasMetadata].some(Boolean)) {
    throw AppError.badRequest('No editable report fields were supplied', 'CATH_REPORT_NO_CHANGES');
  }

  return setTenantTx(tenantId, async (tx) => {
    const current = await reportById(tx, tenantId, reportId, { lock: true });
    if (current.status === 'signed') {
      throw AppError.conflict(
        'Signed cath reports are immutable; append an addendum instead',
        'CATH_REPORT_SIGNED_IMMUTABLE',
      );
    }
    const sections = hasSections
      ? normalizeJsonArray(input.narrative_sections ?? input.narrativeSections, 'narrative_sections')
      : current.narrative_sections;
    const codedFields = hasCodedFields
      ? normalizeJsonObject(input.coded_fields ?? input.codedFields, 'coded_fields')
      : current.coded_fields;
    const findingsSummary = hasFindings || hasSections
      ? deriveFindingsSummary(sections, hasFindings ? (input.findings_summary ?? input.findingsSummary) : undefined)
      : current.findings_summary;
    const viewerAccession = hasViewer
      ? cleanText(input.viewer_study_accession ?? input.viewerStudyAccession, 160)
      : current.viewer_study_accession;
    const metadata = hasMetadata
      ? normalizeJsonObject(input.metadata, 'metadata')
      : current.metadata;
    const rows = await tx.$queryRawUnsafe(
      `UPDATE cath_procedure_reports
          SET narrative_sections = $3::jsonb,
              coded_fields = $4::jsonb,
              findings_summary = $5,
              viewer_study_accession = $6,
              metadata = $7::jsonb,
              updated_by = $8::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
        RETURNING ${REPORT_RETURNING}`,
      tenantId,
      current.id,
      JSON.stringify(sections),
      JSON.stringify(codedFields),
      findingsSummary,
      viewerAccession,
      JSON.stringify(metadata),
      actorUid,
    );
    const report = rows[0];
    await writeAudit(tx, report, 'cath_lab.report_edited', context, {
      changed_fields: [
        hasSections && 'narrative_sections',
        hasCodedFields && 'coded_fields',
        (hasFindings || hasSections) && 'findings_summary',
        hasViewer && 'viewer_study_accession',
        hasMetadata && 'metadata',
      ].filter(Boolean),
    });
    return normalizeDbValue(report);
  });
}

export async function markReportPreliminary(reportId, input = {}, context = {}) {
  requireEditAccess(context);
  const tenantId = tenantOr(input.tenantId || input.tenant_id);
  const actorUid = maybeUuid(context.actorUid, 'actorUid', { required: true });
  return setTenantTx(tenantId, async (tx) => {
    const current = await reportById(tx, tenantId, reportId, { lock: true });
    validateReportTransition(current.status, 'preliminary');
    const rows = await tx.$queryRawUnsafe(
      `UPDATE cath_procedure_reports
          SET status = 'preliminary',
              preliminary_by = $3::uuid,
              preliminary_at = NOW(),
              updated_by = $3::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
        RETURNING ${REPORT_RETURNING}`,
      tenantId,
      current.id,
      actorUid,
    );
    const report = rows[0];
    await writeAudit(tx, report, 'cath_lab.report_preliminary', context, {
      before_status: current.status,
      after_status: report.status,
    });
    return normalizeDbValue(report);
  });
}

export async function signReport(reportId, input = {}, context = {}) {
  requireSignAccess(context);
  const tenantId = tenantOr(input.tenantId || input.tenant_id);
  const actorUid = maybeUuid(context.actorUid, 'actorUid', { required: true });
  await assertPrivilegeForGate({
    staffUid: actorUid,
    privilegeName: 'cath_report_signing',
    tenantId,
    gate: 'cath_report_signing',
    enabled: true,
  });

  return setTenantTx(tenantId, async (tx) => {
    const current = await reportById(tx, tenantId, reportId, { lock: true });
    validateReportTransition(current.status, 'signed');
    const rows = await tx.$queryRawUnsafe(
      `UPDATE cath_procedure_reports
          SET status = 'signed',
              signed_by = $3::uuid,
              signed_at = NOW(),
              updated_by = $3::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
        RETURNING ${REPORT_RETURNING}`,
      tenantId,
      current.id,
      actorUid,
    );
    const report = rows[0];
    const canonical = await recordCanonicalClinicalEvent({
      tenantId,
      patientUid: report.patient_uid,
      encounterId: report.encounter_id,
      eventType: 'cath_lab.report_signed',
      eventStatus: 'signed',
      sourceTable: 'cath_procedure_reports',
      sourceId: String(report.id),
      resourceType: 'cath_report',
      resourceTable: 'cath_procedure_reports',
      resourceId: String(report.id),
      actorUid,
      actorRole: context.actorRole,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      occurredAt: report.signed_at,
      summary: `Cath ${report.report_type} report signed`,
      payload: {
        case_id: normalizeDbValue(report.case_id),
        procedure_log_id: normalizeDbValue(report.procedure_log_id),
        report_type: report.report_type,
        template_id: normalizeDbValue(report.template_id),
        template_version: report.template_version,
      },
      beforeState: { status: current.status },
      afterState: { status: 'signed' },
      tags: ['cath_lab', 'cath_report', 'nl13_p1b'],
      timelineIdempotencyKey: `cath_procedure_reports:${report.id}:signed`,
      auditIdempotencyKey: `cath_procedure_reports:${report.id}:audit:signed`,
    }, { db: tx });
    if (!canonical?.timeline?.id || !canonical?.audit?.id) {
      throw AppError.internal(
        'Required cath report timeline and audit events could not be recorded',
        'CATH_REPORT_CANONICAL_EVENT_REQUIRED',
      );
    }
    return normalizeDbValue(report);
  });
}

export async function addReportAddendum(reportId, input = {}, context = {}) {
  requireSignAccess(context);
  const tenantId = tenantOr(input.tenantId || input.tenant_id);
  const actorUid = maybeUuid(context.actorUid, 'actorUid', { required: true });
  const reason = cleanText(input.reason);
  const narrative = cleanText(input.narrative ?? input.addendum ?? input.addendum_text);
  if (!reason) throw AppError.badRequest('reason is required', 'CATH_REPORT_ADDENDUM_REASON_REQUIRED');
  if (!narrative) {
    throw AppError.badRequest('narrative is required', 'CATH_REPORT_ADDENDUM_NARRATIVE_REQUIRED');
  }
  const metadata = normalizeJsonObject(input.metadata, 'metadata', {});

  return setTenantTx(tenantId, async (tx) => {
    const report = await reportById(tx, tenantId, reportId, { lock: true });
    if (report.status !== 'signed') {
      throw AppError.badRequest(
        'Addenda can only be appended to signed cath reports',
        'CATH_REPORT_ADDENDUM_REQUIRES_SIGNED',
      );
    }
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_report_addenda
         (tenant_id, report_id, case_id, patient_uid, encounter_id,
          author_uid, reason, narrative, metadata)
       VALUES ($1::uuid, $2::bigint, $3::bigint, $4::uuid, $5::uuid,
               $6::uuid, $7, $8, $9::jsonb)
       RETURNING id, tenant_id, report_id, case_id, patient_uid, encounter_id,
                 author_uid, reason, narrative, created_at, metadata`,
      tenantId,
      report.id,
      report.case_id,
      report.patient_uid,
      report.encounter_id,
      actorUid,
      reason,
      narrative,
      JSON.stringify(metadata),
    );
    const addendum = rows[0];
    const canonical = await recordCanonicalClinicalEvent({
      tenantId,
      patientUid: report.patient_uid,
      encounterId: report.encounter_id,
      eventType: 'cath_lab.report_addendum',
      eventStatus: 'signed',
      sourceTable: 'cath_report_addenda',
      sourceId: String(addendum.id),
      resourceType: 'cath_report_addendum',
      resourceTable: 'cath_report_addenda',
      resourceId: String(addendum.id),
      actorUid,
      actorRole: context.actorRole,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      occurredAt: addendum.created_at,
      summary: `Addendum appended to cath ${report.report_type} report`,
      payload: {
        report_id: normalizeDbValue(report.id),
        case_id: normalizeDbValue(report.case_id),
        report_type: report.report_type,
        reason,
      },
      tags: ['cath_lab', 'cath_report', 'addendum', 'nl13_p1b'],
      timelineIdempotencyKey: `cath_report_addenda:${addendum.id}:created`,
      auditIdempotencyKey: `cath_report_addenda:${addendum.id}:audit:created`,
    }, { db: tx });
    if (!canonical?.timeline?.id || !canonical?.audit?.id) {
      throw AppError.internal(
        'Required cath report addendum timeline and audit events could not be recorded',
        'CATH_REPORT_CANONICAL_EVENT_REQUIRED',
      );
    }
    return normalizeDbValue(addendum);
  });
}

export async function getSignedReportForPdf(reportId, options = {}, context = {}) {
  requireReadAccess(context);
  const tenantId = tenantOr(options.tenantId || options.tenant_id);
  return setTenantTx(tenantId, async (tx) => {
    const report = await loadReportDetail(tx, tenantId, reportId);
    if (report.status !== 'signed') {
      throw AppError.conflict(
        'Only signed cath reports can be rendered as PDF',
        'CATH_REPORT_PDF_REQUIRES_SIGNED',
      );
    }
    await writeAudit(tx, report, 'cath_lab.report_pdf_viewed', context, { view: 'pdf' });
    return report;
  });
}

export async function resolveCaseViewerLink(caseId, options = {}, context = {}) {
  requireViewerAccess(context);
  const tenantId = tenantOr(options.tenantId || options.tenant_id);
  return setTenantTx(tenantId, async (tx) => {
    const cathCase = await caseById(tx, tenantId, caseId);
    const reportRows = await tx.$queryRawUnsafe(
      `SELECT id, report_type, status, viewer_study_accession, updated_at
         FROM cath_procedure_reports
        WHERE tenant_id = $1::uuid
          AND case_id = $2::bigint
          AND viewer_study_accession IS NOT NULL
        ORDER BY CASE status WHEN 'signed' THEN 0 WHEN 'preliminary' THEN 1 ELSE 2 END,
                 updated_at DESC, id DESC
        LIMIT 1`,
      tenantId,
      cathCase.id,
    );
    const linkRows = await tx.$queryRawUnsafe(
      `SELECT id, external_accession_id, metadata, attached_at
         FROM cath_device_links
        WHERE tenant_id = $1::uuid
          AND case_id = $2::bigint
          AND link_type = 'angiography_accession'
        ORDER BY attached_at DESC, id DESC
        LIMIT 1`,
      tenantId,
      cathCase.id,
    );
    const reportLink = reportRows[0] || null;
    const deviceLink = linkRows[0] || null;
    const accession = cleanText(
      reportLink?.viewer_study_accession
      || deviceLink?.metadata?.study_instance_uid
      || deviceLink?.external_accession_id,
      160,
    );
    const config = getPacsConfig();
    let viewerUrl = null;
    let viewerStatus;
    if (!config.enabled) {
      viewerStatus = 'pacs_not_configured';
    } else if (!accession) {
      viewerStatus = 'study_not_linked';
    } else if (!DICOM_STUDY_UID_RE.test(accession)) {
      viewerStatus = 'invalid_study_uid';
    } else {
      viewerUrl = buildViewerUrl(accession);
      viewerStatus = viewerUrl ? 'available' : 'viewer_not_configured';
    }
    const auditSubject = {
      tenant_id: cathCase.tenant_id,
      patient_uid: cathCase.patient_uid,
      encounter_id: cathCase.encounter_id,
      case_id: cathCase.id,
      report_type: reportLink?.report_type || null,
      status: reportLink?.status || null,
      id: reportLink?.id || `case-${cathCase.id}`,
    };
    await writeAudit(
      tx,
      auditSubject,
      'cath_lab.viewer_link_resolved',
      context,
      {
        viewer_status: viewerStatus,
        source: reportLink ? 'report' : (deviceLink ? 'cath_device_link' : null),
        report_id: reportLink ? normalizeDbValue(reportLink.id) : null,
        device_link_id: deviceLink ? normalizeDbValue(deviceLink.id) : null,
      },
      `case:${cathCase.id}`,
    );
    return {
      viewer_url: viewerUrl,
      viewer_status: viewerStatus,
      study_accession: accession,
      source: reportLink ? 'report' : (deviceLink ? 'cath_device_link' : null),
    };
  });
}

export const __testing__ = {
  auditKey,
  deriveFindingsSummary,
  normalizeDbValue,
};

export default {
  listReportTemplates,
  supersedeReportTemplate,
  createReport,
  listReports,
  getReport,
  updateReport,
  markReportPreliminary,
  signReport,
  addReportAddendum,
  getSignedReportForPdf,
  resolveCaseViewerLink,
};
