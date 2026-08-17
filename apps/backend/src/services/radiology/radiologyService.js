// src/services/radiology/radiologyService.js

import crypto from 'node:crypto';
import prisma, { setTenant, setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { recordCanonicalClinicalEvent, recordMedicationSafetyReviews } from '../clinical/canonicalClinicalPlatformService.js';
import {
  assertContrastOrderAllowed,
  hasExplicitContrastStudySignal,
  isContrastPresumedModality,
  validateRadiologyContrastSafety,
} from '../../utils/clinical/contrastAllergyCheck.js';
import { publishInpatientDiagnosticResourceLinkedTx } from '../emr/inpatientPathwayDomainService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { AppError } from '../../utils/AppError.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import { sha256ClinicalJson } from '../diagnostics/diagnosticClassification.js';
import {
  createRadiologyDiagnosticGenerationTx,
  normalizeDiagnosticIdempotencyKey,
  normalizeStructuredAddendumSignificance,
  normalizeStructuredClassificationBasis,
  normalizeStructuredResultClassification,
} from '../diagnostics/structuredReportDiagnosticGenerationService.js';

const VALID_MODALITIES = ['xray', 'ct', 'mri', 'ultrasound', 'mammography', 'fluoroscopy'];
const VALID_PRIORITIES = ['routine', 'urgent', 'stat'];
const PEER_REVIEW_OUTCOMES = ['no_change', 'minor_addendum', 'major_addendum', 'learning_case', 'quality_discussion'];
const DEFAULT_PEER_REVIEW_SAMPLE_RATE = 0.02;

const MODALITY_ALIASES = {
  usg: 'ultrasound', us: 'ultrasound', sonography: 'ultrasound',
  ekg: 'xray',
  'x-ray': 'xray', xr: 'xray',
  mr: 'mri',
  mammo: 'mammography', mg: 'mammography',
  fluoro: 'fluoroscopy',
};
const PRIORITY_ALIASES = {
  emergency: 'stat', emergent: 'stat',
  high: 'urgent',
  normal: 'routine', low: 'routine',
};

const RAD_RETURNING = `id, patient_uid, encounter_id, admission_id, modality, body_part, clinical_indication,
    priority, status, ordered_by, radiologist, report, report_completed_at,
    report_signed_off_at, report_signed_off_by, acquired_at, acquired_by,
    acquired_by_name, tech_uid, tech_name, tech_license_number,
    pacs_study_instance_uid, acquisition_evidence, template_id, structured_report,
    result_classification, classification_basis, report_generation_version,
    classification_signed_by, classification_signed_at,
    contrast_planned, contrast_agent, contrast_allergy_screen,
    contrast_override_reason, contrast_override_by, contrast_override_at,
    tenant_id, notes, created_at, updated_at`;

const RAD_CURRENT_READ_PROJECTION = `ro.id, ro.patient_uid, ro.encounter_id, ro.modality,
    ro.body_part, ro.clinical_indication, ro.priority, ro.status, ro.ordered_by,
    ro.radiologist, ro.report, ro.report_completed_at, ro.report_signed_off_at,
    ro.report_signed_off_by, ro.acquired_at, ro.acquired_by, ro.acquired_by_name,
    ro.tech_uid, ro.tech_name, ro.tech_license_number, ro.pacs_study_instance_uid,
    ro.acquisition_evidence, ro.template_id, ro.structured_report,
    COALESCE(latest_addendum.result_classification, ro.result_classification) AS result_classification,
    COALESCE(latest_addendum.classification_basis, ro.classification_basis) AS classification_basis,
    COALESCE(latest_addendum.generation_version, ro.report_generation_version) AS report_generation_version,
    COALESCE(latest_addendum.signed_by, ro.classification_signed_by) AS classification_signed_by,
    COALESCE(latest_addendum.signed_at, ro.classification_signed_at) AS classification_signed_at,
    latest_addendum.clinical_significance AS latest_clinical_significance,
    latest_addendum.id AS latest_addendum_id,
    latest_generation.id AS diagnostic_generation_id,
    release_state.release_hold AS patient_release_hold,
    release_state.release_hold_reason AS patient_release_hold_reason,
    release_state.release_hold_at AS patient_release_hold_at,
    release_state.released_to_patient_at,
    release_state.state_version AS patient_release_state_version,
    EXISTS (
      SELECT 1
        FROM diagnostic_result_actions patient_release_action
       WHERE patient_release_action.tenant_id = ro.tenant_id
         AND patient_release_action.generation_id = latest_generation.id
         AND patient_release_action.action_kind = 'doctor_disposition'
    ) AS patient_release_doctor_reviewed,
    EXISTS (
      SELECT 1
        FROM diagnostic_result_actions patient_release_closed
       WHERE patient_release_closed.tenant_id = ro.tenant_id
         AND patient_release_closed.generation_id = latest_generation.id
         AND patient_release_closed.action_kind = 'normal_auto_closed'
    ) AS patient_release_auto_closed,
    ro.contrast_planned, ro.contrast_agent, ro.contrast_allergy_screen,
    ro.contrast_override_reason, ro.contrast_override_by, ro.contrast_override_at,
    ro.tenant_id, ro.notes, ro.created_at, ro.updated_at`;

const RAD_LATEST_ADDENDUM_JOIN = `LEFT JOIN LATERAL (
    SELECT addendum.id, addendum.generation_version, addendum.result_classification,
           addendum.classification_basis, addendum.clinical_significance,
           addendum.signed_by, addendum.signed_at
      FROM radiology_report_addenda addendum
     WHERE addendum.tenant_id = ro.tenant_id
       AND addendum.radiology_order_id = ro.id
     ORDER BY addendum.generation_version DESC, addendum.id DESC
     LIMIT 1
  ) latest_addendum ON TRUE`;

const RAD_LATEST_GENERATION_JOIN = `LEFT JOIN LATERAL (
    SELECT generation.id, generation.classification
      FROM diagnostic_result_generations generation
     WHERE generation.tenant_id = ro.tenant_id
       AND generation.source_kind = 'radiology_report'
       AND generation.radiology_order_id = ro.id
     ORDER BY generation.source_version DESC, generation.id DESC
     LIMIT 1
  ) latest_generation ON TRUE
  LEFT JOIN diagnostic_result_release_states release_state
    ON release_state.tenant_id = ro.tenant_id
   AND release_state.generation_id = latest_generation.id`;

function tenantOr(value) {
  return requireTenantId(value);
}

function normaliseModality(raw) {
  if (!raw) return raw;
  const k = String(raw).trim().toLowerCase().replace(/\s+/g, '_');
  if (VALID_MODALITIES.includes(k)) return k;
  return MODALITY_ALIASES[k] || k;
}

function normalisePriority(raw) {
  if (!raw) return raw;
  const k = String(raw).trim().toLowerCase();
  if (VALID_PRIORITIES.includes(k)) return k;
  return PRIORITY_ALIASES[k] || k;
}

function requireIntId(id) {
  const n = parseInt(id, 10);
  if (!Number.isFinite(n)) throw AppError.badRequest('Invalid id — must be an integer');
  return n;
}

function cleanOptionalText(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function firstClean(...values) {
  for (const value of values) {
    const cleaned = cleanOptionalText(value);
    if (cleaned) return cleaned;
  }
  return null;
}

function positiveIntOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function safeJsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeWireValue(value) {
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (value instanceof Date || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalizeWireValue);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeWireValue(entry)]));
}

function sectionKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function sectionTitleFromKey(key) {
  return String(key || '')
    .split('_')
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ') || 'Section';
}

function normalizeSection(section, index = 0) {
  if (section == null) return null;
  if (typeof section === 'string') {
    const text = cleanOptionalText(section);
    return text ? { key: `section_${index + 1}`, title: `Section ${index + 1}`, text } : null;
  }
  if (typeof section !== 'object') return null;
  const key = sectionKey(section.key ?? section.section_key ?? section.id ?? section.title ?? `section_${index + 1}`);
  const title = cleanOptionalText(section.title ?? section.label) || sectionTitleFromKey(key);
  const text = cleanOptionalText(section.text ?? section.value ?? section.content ?? section.narrative);
  if (!key || !text) return null;
  return { key, title, text };
}

function normalizeSections(rawSections) {
  if (Array.isArray(rawSections)) {
    return rawSections.map(normalizeSection).filter(Boolean);
  }
  if (rawSections && typeof rawSections === 'object') {
    return Object.entries(rawSections)
      .map(([key, value], index) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return normalizeSection({ key, ...value }, index);
        }
        return normalizeSection({ key, text: value }, index);
      })
      .filter(Boolean);
  }
  return [];
}

function upsertSection(sections, key, title, text) {
  const cleaned = cleanOptionalText(text);
  if (!cleaned) return;
  const normalizedKey = sectionKey(key);
  const existing = sections.find((section) => section.key === normalizedKey);
  if (existing) {
    existing.title = title;
    existing.text = cleaned;
  } else {
    sections.push({ key: normalizedKey, title, text: cleaned });
  }
}

function orderedTemplateSections(template) {
  const sections = Array.isArray(template?.sections) ? template.sections : [];
  return sections
    .map((section, index) => ({
      key: sectionKey(section.key ?? section.section_key ?? section.title ?? `section_${index + 1}`),
      title: cleanOptionalText(section.title ?? section.label) || sectionTitleFromKey(section.key ?? `section_${index + 1}`),
      order: Number.isFinite(Number(section.order)) ? Number(section.order) : index + 1,
    }))
    .filter((section) => section.key)
    .sort((a, b) => a.order - b.order);
}

export function renderRadiologyStructuredReport(data = {}, { template = null } = {}) {
  const rawStructured = safeJsonObject(data.structured_report ?? data.structuredReport);
  const sections = normalizeSections(rawStructured.sections ?? data.sections);
  upsertSection(sections, 'findings', 'Findings', data.findings ?? rawStructured.findings);
  upsertSection(sections, 'impression', 'Impression', data.impression ?? rawStructured.impression);
  const templateId = positiveIntOrNull(template?.id ?? data.template_id ?? data.templateId);

  const narrative = cleanOptionalText(
    rawStructured.narrative ?? rawStructured.report ?? data.report,
  );
  const codedFields = safeJsonObject(
    rawStructured.coded_fields ?? rawStructured.codedFields ?? data.coded_fields ?? data.codedFields,
  );
  const templateSections = orderedTemplateSections(template);
  const byKey = new Map(sections.map((section) => [section.key, section]));
  const renderedSections = [];
  const used = new Set();

  for (const def of templateSections) {
    const section = byKey.get(def.key);
    if (!section) continue;
    renderedSections.push({ ...section, title: section.title || def.title });
    used.add(section.key);
  }
  for (const section of sections) {
    if (!used.has(section.key)) renderedSections.push(section);
  }

  const parts = renderedSections.map((section) => `${section.title}:\n${section.text}`);
  if (narrative) parts.push(narrative);
  const text = parts.join('\n\n');
  if (!text) {
    throw AppError.badRequest('Missing required fields: report or structured_report.sections');
  }

  return {
    text,
    structuredReport: {
      template_id: templateId,
      template_code: template?.template_code ?? null,
      template_name: template?.name ?? null,
      sections: renderedSections,
      coded_fields: codedFields,
      narrative,
      rendered_text: text,
    },
    templateId,
  };
}

function minutesBetween(start, end) {
  if (!start || !end) return null;
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 60000);
}

export function computeRadiologyTatMetric(row = {}, now = new Date()) {
  const orderedAt = row.ordered_at ?? row.created_at;
  const signedAt = row.signed_at ?? row.report_signed_off_at;
  const reportedAt = row.reported_at ?? row.report_completed_at;
  const elapsedEnd = signedAt || now;
  const currentElapsed = minutesBetween(orderedAt, elapsedEnd);
  const warning = Number(row.warning_minutes ?? row.target_minutes);
  const critical = Number(row.critical_minutes ?? warning);

  return {
    ordered_to_acquired_minutes: minutesBetween(orderedAt, row.acquired_at),
    acquired_to_reported_minutes: minutesBetween(row.acquired_at, reportedAt),
    reported_to_signed_minutes: minutesBetween(reportedAt, signedAt),
    ordered_to_signed_minutes: minutesBetween(orderedAt, signedAt),
    current_elapsed_minutes: currentElapsed,
    threshold_breached: Number.isFinite(currentElapsed) && Number.isFinite(warning) ? currentElapsed >= warning : false,
    alert_severity: Number.isFinite(currentElapsed) && Number.isFinite(warning) && currentElapsed >= warning
      ? (Number.isFinite(critical) && currentElapsed >= critical ? 'CRITICAL' : 'WARNING')
      : null,
  };
}

export function deterministicSampleScore(seed, orderId) {
  const digest = crypto.createHash('sha256').update(`${seed || 'radiology-peer-review'}:${orderId}`).digest('hex');
  const bucket = Number.parseInt(digest.slice(0, 12), 16);
  return bucket / 0xffffffffffff;
}

export function pickDeterministicSignedReportSample(rows = [], { seed = 'radiology-peer-review', samplingRate = DEFAULT_PEER_REVIEW_SAMPLE_RATE, limit = 25 } = {}) {
  const rate = Math.min(1, Math.max(0, Number(samplingRate ?? DEFAULT_PEER_REVIEW_SAMPLE_RATE)));
  return [...rows]
    .map((row) => ({ ...row, sample_score: deterministicSampleScore(seed, row.id ?? row.radiology_order_id) }))
    .filter((row) => row.sample_score < rate)
    .sort((a, b) => a.sample_score - b.sample_score || Number(a.id ?? a.radiology_order_id) - Number(b.id ?? b.radiology_order_id))
    .slice(0, Math.max(1, Number(limit) || 25));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveEncounterIdForRadiology(rawEncounterId, patientUid, tenantId = null, { db = prisma } = {}) {
  if (rawEncounterId == null || rawEncounterId === '') return null;
  const raw = String(rawEncounterId).trim();
  if (UUID_RE.test(raw)) {
    // Tenant + patient scoped: an encounter uuid belonging to another tenant
    // or another patient must not resolve (group-1 tenant-shape sweep).
    const scopedTenantId = requireTenantId(tenantId);
    const rows = await db.$queryRawUnsafe(
        `SELECT id FROM admissions
          WHERE encounter_id = $1::uuid
            AND tenant_id = $2::uuid
            AND patient_uid = $3::uuid
          LIMIT 1`,
        raw,
        scopedTenantId,
        patientUid,
    );
    if (rows.length) return Number(rows[0].id);
    logger.warn('Radiology order: encounter_id uuid did not match any admission for this tenant and patient; storing null', {
      encounter_id: raw, patient_uid: patientUid,
    });
    return null;
  }
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  logger.warn('Radiology order: encounter_id is neither uuid nor integer; storing null', {
    encounter_id: raw, patient_uid: patientUid,
  });
  return null;
}

async function resolveCanonicalEncounterUuid(db, order) {
  if (!order?.encounter_id) return null;
  const rows = await db.$queryRawUnsafe(
      `SELECT encounter_id
         FROM admissions
        WHERE id = $1::int
          AND patient_uid = $2::uuid
          AND tenant_id = $3::uuid
        LIMIT 1`,
      Number(order.encounter_id),
      order.patient_uid,
      order.tenant_id,
  );
  return rows[0]?.encounter_id || null;
}

async function emitRadiologyCanonicalEvent(db, order, eventType, {
  actorUid = null, actorRole = null, summary, payload = {}, beforeStatus = null, afterStatus = null, occurredAt = null,
}) {
  const eventAt = occurredAt || order.updated_at || order.created_at || new Date().toISOString();
  const encounterId = await resolveCanonicalEncounterUuid(db, order);
  return recordCanonicalClinicalEvent({
    tenantId: order.tenant_id,
    patientUid: order.patient_uid,
    encounterId,
    eventType,
    eventStatus: afterStatus || order.status,
    sourceTable: 'radiology_orders',
    sourceId: String(order.id),
    resourceType: 'radiology_order',
    resourceTable: 'radiology_orders',
    resourceId: String(order.id),
    actorUid,
    actorRole,
    occurredAt: eventAt,
    summary,
    payload: {
      radiology_order_id: order.id,
      modality: order.modality,
      body_part: order.body_part,
      priority: order.priority,
      ...payload,
    },
    beforeState: beforeStatus ? { status: beforeStatus } : null,
    afterState: afterStatus ? { status: afterStatus } : null,
    tags: ['radiology'],
    timelineIdempotencyKey: `radiology_orders:${order.id}:${eventType}:${new Date(eventAt).toISOString()}`,
    auditIdempotencyKey: `radiology_orders:${order.id}:audit:${eventType}:${new Date(eventAt).toISOString()}`,
  }, { db });
}

async function resolveAcquiringTechnologist(techUid, fallbackName, fallbackLicenseNumber, tenantId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT
        u.uid,
        u.name AS user_name,
        s.name AS staff_name,
        hpr.full_name AS hpr_full_name,
        hpr.registration_number
       FROM users u
       LEFT JOIN staff s
         ON s.user_id = u.uid
        AND COALESCE(s.archived, false) = false
       LEFT JOIN LATERAL (
         SELECT full_name, registration_number, status, updated_at
           FROM abdm_practitioner_mappings apm
          WHERE apm.staff_uid = u.uid
            AND apm.tenant_id = u.tenant_id
            AND NULLIF(BTRIM(apm.registration_number), '') IS NOT NULL
          ORDER BY
            CASE apm.status
              WHEN 'verified' THEN 1
              WHEN 'pending' THEN 2
              WHEN 'unverified' THEN 3
              ELSE 4
            END,
            apm.updated_at DESC NULLS LAST
          LIMIT 1
       ) hpr ON true
      WHERE u.uid = $1::uuid
        AND u.tenant_id = $2::uuid
        AND UPPER(COALESCE(u.role, '')) = 'RADIOLOGY_STAFF'
        AND COALESCE(u.is_active, true) = true
      LIMIT 1`,
    techUid,
    tenantId,
  );

  if (rows.length === 0) {
    throw AppError.forbidden(
      'Only an active radiology technologist may acquire a radiology study',
      'RADIOLOGY_TECH_REQUIRED',
    );
  }

  const row = rows[0];
  return {
    techName:
      cleanOptionalText(row.staff_name)
      || cleanOptionalText(row.hpr_full_name)
      || cleanOptionalText(row.user_name)
      || cleanOptionalText(fallbackName),
    techLicenseNumber:
      cleanOptionalText(row.registration_number)
      || cleanOptionalText(fallbackLicenseNumber),
  };
}

function normalizeAcquisitionEvidence(raw = {}) {
  const nested =
    raw?.acquisition_evidence && typeof raw.acquisition_evidence === 'object' && !Array.isArray(raw.acquisition_evidence)
      ? raw.acquisition_evidence
      : {};

  const pacsStudyInstanceUid = firstClean(
    raw.pacs_study_instance_uid,
    raw.study_instance_uid,
    raw.studyInstanceUid,
    nested.pacs_study_instance_uid,
    nested.study_instance_uid,
    nested.studyInstanceUid,
  );
  const pacsUrl = firstClean(raw.pacs_url, raw.pacsUrl, nested.pacs_url, nested.pacsUrl);
  const storageKey = firstClean(
    raw.storage_key,
    raw.image_storage_key,
    raw.file_key,
    raw.storageKey,
    nested.storage_key,
    nested.image_storage_key,
    nested.file_key,
    nested.storageKey,
  );
  const imageUrl = firstClean(
    raw.image_url,
    raw.file_url,
    raw.attachment_url,
    raw.imageUrl,
    nested.image_url,
    nested.file_url,
    nested.attachment_url,
    nested.imageUrl,
  );
  const attachmentId = firstClean(raw.attachment_id, raw.attachmentId, nested.attachment_id, nested.attachmentId);
  const sourceSystem = firstClean(raw.source_system, raw.sourceSystem, nested.source_system, nested.sourceSystem);
  const seriesCount = positiveIntOrNull(raw.series_count ?? raw.seriesCount ?? nested.series_count ?? nested.seriesCount);
  const instanceCount = positiveIntOrNull(raw.instance_count ?? raw.instanceCount ?? nested.instance_count ?? nested.instanceCount);

  if (!pacsStudyInstanceUid && !pacsUrl && !storageKey && !imageUrl && !attachmentId) {
    throw AppError.badRequest(
      'PACS study UID or image attachment evidence is required before marking a radiology study acquired',
      'RADIOLOGY_ACQUISITION_EVIDENCE_REQUIRED',
    );
  }

  const evidence = { recorded_at: new Date().toISOString() };
  if (pacsStudyInstanceUid) evidence.pacs_study_instance_uid = pacsStudyInstanceUid;
  if (pacsUrl) evidence.pacs_url = pacsUrl;
  if (storageKey) evidence.storage_key = storageKey;
  if (imageUrl) evidence.image_url = imageUrl;
  if (attachmentId) evidence.attachment_id = attachmentId;
  if (sourceSystem) evidence.source_system = sourceSystem;
  if (seriesCount) evidence.series_count = seriesCount;
  if (instanceCount) evidence.instance_count = instanceCount;
  if (raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)) {
    evidence.metadata = raw.metadata;
  }

  return { pacsStudyInstanceUid, evidence };
}

async function loadTemplate(db, tenantId, templateId) {
  const id = positiveIntOrNull(templateId);
  if (!id) return null;
  const rows = await db.$queryRawUnsafe(
    `SELECT id, tenant_id, template_code, name, modality, body_part, sections, coded_fields_schema
       FROM radiology_report_templates
      WHERE id = $1::bigint AND tenant_id = $2::uuid AND is_active = TRUE
      LIMIT 1`,
    id,
    tenantId,
  );
  if (!rows.length) throw AppError.notFound('Radiology report template not found', 'RADIOLOGY_TEMPLATE_NOT_FOUND');
  return rows[0];
}

async function maybeEmitTatAlert(db, metric) {
  if (!metric?.threshold_breached || !metric.patient_id) return null;
  const prefix = `Radiology TAT breach for order #${metric.radiology_order_id}:`;
  const existing = await db.$queryRawUnsafe(
    `SELECT id FROM clinical_alerts
      WHERE tenant_id = $1::uuid
        AND patient_id = $2::int
        AND alert_type = 'RADIOLOGY_TAT_BREACH'
        AND acknowledged_at IS NULL
        AND message LIKE $3
      LIMIT 1`,
    metric.tenant_id,
    Number(metric.patient_id),
    `${prefix}%`,
  );
  if (existing.length) return existing[0];

  const rows = await db.$queryRawUnsafe(
    `INSERT INTO clinical_alerts
       (tenant_id, patient_id, alert_type, vital_name, vital_value, severity, message, created_at)
     VALUES ($1::uuid, $2::int, 'RADIOLOGY_TAT_BREACH', 'radiology_tat_minutes',
             $3::numeric, $4, $5, NOW())
     RETURNING id, severity, message`,
    metric.tenant_id,
    Number(metric.patient_id),
    Number(metric.current_elapsed_minutes ?? 0),
    metric.alert_severity || 'WARNING',
    `${prefix} ${metric.current_elapsed_minutes} minutes elapsed; threshold ${metric.warning_minutes} minutes (${metric.priority}, ${metric.modality}).`,
  );
  return rows[0] || null;
}

// Contrast intent parsed off an order create/amend payload — DERIVED
// SERVER-SIDE by default (PR #875 R9: screening opt-in on a request field no
// shipped client sent made the gate inert).
//
//   explicit true / named agent  → contrast planned ('explicit'/'agent_named')
//   explicit false               → contrast negated ('explicitly_negated');
//                                  contradicts a named agent → 400
//   omitted                      → presumed for CT/MRI/fluoroscopy
//                                  ('modality_presumed'); not presumed for
//                                  plain xray/ultrasound/mammography
//                                  ('modality_not_presumed')
//
// So a contrast-capable order created by ANY client is screened without the
// client opting in, and only an explicit contrast_planned: false skips the
// gate. A named agent still implies a contrast study (the migration-678 CHECK
// `chk_radiology_contrast_agent_implies_planned` enforces the same rule at
// the DB).
function parseContrastIntent(data = {}, modality = null) {
  const contrastAgent = cleanOptionalText(data.contrast_agent ?? data.contrastAgent);
  const rawPlanned = data.contrast_planned ?? data.contrastPlanned;
  if (rawPlanned === false || rawPlanned === 'false') {
    if (contrastAgent || hasExplicitContrastStudySignal(data)) {
      throw AppError.badRequest(
        'contrast_planned cannot be false when the order names a contrast agent or contrast-enhanced study',
        'RADIOLOGY_CONTRAST_INTENT_CONTRADICTION',
      );
    }
    return { contrastPlanned: false, contrastAgent: null, intentSource: 'explicitly_negated' };
  }
  if (rawPlanned === true || rawPlanned === 'true') {
    return { contrastPlanned: true, contrastAgent, intentSource: 'explicit' };
  }
  if (contrastAgent) {
    return { contrastPlanned: true, contrastAgent, intentSource: 'agent_named' };
  }
  if (hasExplicitContrastStudySignal(data)) {
    return { contrastPlanned: true, contrastAgent: null, intentSource: 'study_text' };
  }
  if (isContrastPresumedModality(modality)) {
    return { contrastPlanned: true, contrastAgent: null, intentSource: 'modality_presumed' };
  }
  return { contrastPlanned: false, contrastAgent: null, intentSource: 'modality_not_presumed' };
}

const DERIVED_CONTRAST_INTENT_SOURCES = new Set([
  'explicit',
  'agent_named',
  'study_text',
  'modality_presumed',
  'explicitly_negated',
  'modality_not_presumed',
]);

function contrastIntentForCreate(data, modality, context = {}) {
  const parsed = parseContrastIntent(data, modality);
  const authoritative = context.contrastIntent;
  if (authoritative == null) return parsed;
  const contrastAgent = cleanOptionalText(authoritative.contrastAgent);
  if (
    typeof authoritative.contrastPlanned !== 'boolean'
    || !DERIVED_CONTRAST_INTENT_SOURCES.has(authoritative.intentSource)
    || parsed.contrastPlanned !== authoritative.contrastPlanned
    || parsed.contrastAgent !== contrastAgent
  ) {
    throw AppError.conflict(
      'Materialized radiology contrast intent contradicts the clinical order',
      'RADIOLOGY_CONTRAST_INTENT_CONTRADICTION',
    );
  }
  return {
    contrastPlanned: authoritative.contrastPlanned,
    contrastAgent,
    intentSource: authoritative.intentSource,
  };
}

// Evidence blob persisted to radiology_orders.contrast_allergy_screen — the
// immutable record of what the screen knew when the order was placed/amended.
// Always records the derived contrast intent; when a screen ran it records
// the screen's completion status (completed/degraded/failed), which allergy
// sources failed, findings, and any acknowledged override. Prior evidence is
// APPEND-ONLY: amendments push the previous blob into `history`, never
// overwrite it (PR #875 R11).
function buildContrastScreenEvidence(screen, override, {
  intentSource = null, contrastPlanned = null, history = [], cleared = null,
} = {}) {
  const base = {
    ...(contrastPlanned == null ? {} : { contrast_planned: contrastPlanned }),
    ...(intentSource ? { intent_source: intentSource } : {}),
    ...(cleared ? { cleared } : {}),
    ...(history.length ? { history } : {}),
  };
  if (!screen) {
    // No screen ran (non-contrast order). Persist the intent derivation —
    // and the clearing evidence on amendment — but nothing else.
    return Object.keys(base).length ? { ...base, recorded_at: new Date().toISOString() } : {};
  }
  return {
    ...base,
    screened_at: screen.screened_at,
    status: screen.status,
    sources_failed: screen.sources_failed,
    agent_class: screen.agent_class,
    safe: screen.safe,
    blockers: screen.blockers,
    warnings: screen.warnings,
    renal: screen.renal,
    override: override ? { reason: override.reason, approved_by: override.approvedBy } : null,
  };
}

// Append-only evidence history: the previous contrast_allergy_screen blob
// (minus its own nested history, which is carried forward flat) becomes a
// history entry stamped with who superseded it and when. Prior overrides and
// screen findings therefore survive every amendment in the JSONB.
function buildContrastEvidenceHistory(priorEvidenceRaw, { actorUid, priorOverride = null } = {}) {
  const priorEvidence = safeJsonObject(priorEvidenceRaw);
  const { history: priorHistory, ...priorCurrent } = priorEvidence;
  const carried = Array.isArray(priorHistory) ? [...priorHistory] : [];
  if (Object.keys(priorCurrent).length === 0 && !priorOverride) return carried;
  carried.push({
    ...priorCurrent,
    // Belt-and-braces: if the columns held an override the blob missed,
    // preserve it here so clearing the columns never erases the record.
    ...(priorOverride && !priorCurrent.override ? { override: priorOverride } : {}),
    superseded_at: new Date().toISOString(),
    superseded_by: actorUid || null,
  });
  return carried;
}

// Canonical-invariant leg: contrast safety findings/overrides land in
// medication_safety_reviews (the platform's safety-finding vehicle) in the
// SAME transaction as the order write. recordMedicationSafetyReviews is
// per-row best-effort and never throws.
async function recordContrastSafetyReviews(tx, { tenantId, order, screen, override, actorUid }) {
  if (!screen || (screen.blockers.length === 0 && screen.warnings.length === 0)) return;
  const tagIssue = (issue) => ({ ...issue, radiology_order_id: order.id, source_table: 'radiology_orders' });
  await recordMedicationSafetyReviews({
    tenantId,
    patientUid: order.patient_uid,
    safety: {
      safe: screen.safe,
      blockers: screen.blockers.map(tagIssue),
      warnings: screen.warnings.map(tagIssue),
    },
    override: override ? { reason: override.reason, approvedBy: override.approvedBy } : null,
    actorUid,
  }, { db: tx });
}

class RadiologyService {
  async createOrder(data, context = {}) {
    const tenantId = tenantOr(context.tenantId || data.tenantId || data.tenant_id);
    const patient_uid = data.patient_uid;
    const encounter_id = data.encounter_id;
    const explicitAdmissionId = positiveIntOrNull(data.admission_id ?? data.admissionId);
    const body_part = data.body_part;
    const clinical_indication = data.clinical_indication ?? data.clinical_notes ?? null;
    const ordered_by = data.ordered_by ?? data.doctor_id ?? null;
    const notes = data.notes ?? null;
    const modality = normaliseModality(data.modality);
    const priority = normalisePriority(data.priority || 'routine');

    if (!patient_uid || !modality || !body_part || !clinical_indication || !ordered_by) {
      throw AppError.badRequest(
        'Missing required fields: patient_uid, modality, body_part, ' +
        'clinical_indication (or clinical_notes), ordered_by (or doctor_id)',
      );
    }
    if (!VALID_MODALITIES.includes(modality)) {
      throw AppError.badRequest(
        `Invalid modality "${data.modality}". Must be one of: ${VALID_MODALITIES.join(', ')} ` +
        `(aliases accepted: USG/US/sonography, X-ray/XR, MR, mammo/MG, fluoro)`,
      );
    }
    if (!VALID_PRIORITIES.includes(priority)) {
      throw AppError.badRequest(
        `Invalid priority "${data.priority}". Must be one of: ${VALID_PRIORITIES.join(', ')} ` +
        `(aliases accepted: emergency/emergent->stat, high->urgent, normal/low->routine)`,
      );
    }

    // ── Contrast/allergy screen (Phase 0 pre-flight, plain prisma) ──
    // Mirrors the CDS hard-block in ePrescriptionController.createPrescription:
    // a contrast study is screened against the patient's unified active
    // allergies; a contrast-relevant hit blocks (409
    // RADIOLOGY_CONTRAST_ALLERGY_BLOCKED) unless an explicit override with
    // reason is supplied. Contrast intent is derived server-side: CT/MRI/
    // fluoroscopy orders are presumed contrast-planned (and therefore always
    // screened) unless the client explicitly negates with
    // contrast_planned: false.
    const { contrastPlanned, contrastAgent, intentSource } = contrastIntentForCreate(
      data,
      modality,
      context,
    );
    let contrastScreen = null;
    let contrastOverride = null;
    if (contrastPlanned) {
      contrastScreen = await validateRadiologyContrastSafety({
        patientUid: patient_uid,
        modality,
        contrastAgent,
      }, { db: context.tx || prisma });
      contrastOverride = assertContrastOrderAllowed(
        contrastScreen,
        data.override ?? (data.contrast_override_reason
          ? { reason: data.contrast_override_reason, approvedBy: data.contrast_override_by }
          : null),
        ordered_by,
      );
      if (contrastOverride) {
        logger.warn('Radiology contrast allergy override used', {
          patient_uid,
          modality,
          contrast_agent: contrastAgent,
          blockers: contrastScreen.blockers.length,
          approved_by: contrastOverride.approvedBy,
        });
      }
    }

    const resolvedEncounterId = await resolveEncounterIdForRadiology(
      encounter_id,
      patient_uid,
      tenantId,
      { db: context.tx || prisma },
    );
    const persist = async (tx) => {
      // Validate EVERY admission reference (explicit admission_id AND an
      // integer-supplied encounter_id) against this tenant + patient before
      // persisting either — an unvalidated candidate must never be stored as
      // radiology_orders.encounter_id pointing at another tenant's admission
      // (group-1 tenant-shape sweep, PR #875 R1 class).
      const candidateIds = [...new Set([explicitAdmissionId, resolvedEncounterId].filter(Boolean))];
      const admissionRows = candidateIds.length
        ? await tx.$queryRawUnsafe(
          `SELECT id
             FROM admissions
            WHERE tenant_id = $1::uuid
              AND id = ANY($2::integer[])
              AND patient_uid = $3::uuid
            FOR SHARE`,
          tenantId,
          candidateIds,
          patient_uid,
        )
        : [];
      const validatedIds = new Set(admissionRows.map((row) => Number(row.id)));
      if (explicitAdmissionId && !validatedIds.has(explicitAdmissionId)) {
        throw AppError.conflict(
          'Radiology admission does not belong to this tenant and patient',
          'RADIOLOGY_ADMISSION_MISMATCH',
        );
      }
      let persistedEncounterId = resolvedEncounterId;
      if (resolvedEncounterId && !validatedIds.has(Number(resolvedEncounterId))) {
        logger.warn('Radiology order: encounter_id does not match a tenant/patient admission; storing null', {
          encounter_id: resolvedEncounterId, patient_uid,
        });
        persistedEncounterId = null;
      }
      const admissionId = (explicitAdmissionId && validatedIds.has(explicitAdmissionId))
        ? explicitAdmissionId
        : (persistedEncounterId ?? null);
      const result = await tx.$queryRawUnsafe(
        `INSERT INTO radiology_orders
          (patient_uid, encounter_id, admission_id, modality, body_part, clinical_indication,
           priority, status, ordered_by, notes, tenant_id,
           contrast_planned, contrast_agent, contrast_allergy_screen,
           contrast_override_reason, contrast_override_by, contrast_override_at,
           created_at, updated_at)
         VALUES ($1::uuid, $2::int, $3::int, $4, $5, $6, $7, 'ordered', $8::uuid, $9, $10::uuid,
                 $11::boolean, $12, $13::jsonb,
                 $14, $15::uuid, CASE WHEN $14::text IS NOT NULL THEN NOW() ELSE NULL END,
                 NOW(), NOW())
         RETURNING ${RAD_RETURNING}`,
        patient_uid, persistedEncounterId, admissionId, modality, body_part, clinical_indication,
        priority, ordered_by, notes || null, tenantId,
        contrastPlanned, contrastAgent,
        JSON.stringify(buildContrastScreenEvidence(contrastScreen, contrastOverride, {
          intentSource, contrastPlanned,
        })),
        contrastOverride?.reason ?? null, contrastOverride?.approvedBy ?? null,
      );
      const row = result[0];
      await recordContrastSafetyReviews(tx, {
        tenantId,
        order: row,
        screen: contrastScreen,
        override: contrastOverride,
        actorUid: ordered_by,
      });
      const canonical = await emitRadiologyCanonicalEvent(tx, row, 'radiology.order_created', {
        actorUid: ordered_by,
        actorRole: context.actorRole || data.actorRole || null,
        summary: `Radiology ${modality} order created for ${body_part}`,
        payload: {
          clinical_indication,
          contrast_planned: contrastPlanned,
          contrast_agent: contrastAgent,
          contrast_intent_source: intentSource,
          contrast_screen_status: contrastScreen ? contrastScreen.status : null,
          contrast_allergy_blockers: contrastScreen ? contrastScreen.blockers.length : 0,
          contrast_allergy_override: Boolean(contrastOverride),
        },
        afterStatus: 'ordered',
        occurredAt: row.created_at,
      });
      if (row.admission_id != null) {
        await publishInpatientDiagnosticResourceLinkedTx({
          tx,
          tenantId,
          admissionId: row.admission_id,
          patientUid: row.patient_uid,
          resourceType: 'radiology_order',
          resourceId: row.id,
          canonicalTimelineEventId: canonical.timeline.id,
          canonicalAuditEventId: canonical.audit.id,
          occurredAt: row.created_at,
        });
      }
      return row;
    };
    const order = context.tx
      ? await persist(context.tx)
      : await setTenantTx(tenantId, persist);

    logger.info('Radiology order created', { orderId: order.id, modality, patient_uid });
    return normalizeWireValue(order);
  }

  /**
   * Amend an order's contrast plan before acquisition (the protocolling step:
   * an order placed without contrast is later protocolled to contrast, or
   * vice versa). Runs the same allergy screen + acknowledged-override gate as
   * createOrder. Only allowed while the study is still 'ordered' — once the
   * tech has acquired (or the order is completed/cancelled) the contrast
   * decision is history, not a plan.
   */
  async setContrastPlan(id, data = {}, context = {}) {
    const tenantId = tenantOr(context.tenantId || data.tenantId || data.tenant_id);
    const actorUid = context.actorUid || data.actorUid || null;
    if (!actorUid) throw AppError.badRequest('Authenticated actor is required');

    // Amendment intent is EXPLICIT-ONLY: an omitted contrast_planned (and no
    // agent) is refused rather than derived or read as "clear" — an empty PUT
    // body must never silently erase a contrast plan, its screen evidence, or
    // an acknowledged override (PR #875 R11).
    const rawPlanned = data.contrast_planned ?? data.contrastPlanned;
    const rawAgent = cleanOptionalText(data.contrast_agent ?? data.contrastAgent);
    if (rawPlanned == null && !rawAgent) {
      throw AppError.badRequest(
        'contrast_planned (or contrast_agent) is required — an empty amendment would erase the recorded contrast plan. To clear contrast, send contrast_planned: false with a reason.',
        'RADIOLOGY_CONTRAST_PLAN_REQUIRED',
      );
    }
    const { contrastPlanned, contrastAgent, intentSource } = parseContrastIntent(data);

    // Phase 0 pre-flight on plain prisma: order lookup + allergy screen.
    const preflight = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, modality, body_part, status, contrast_planned, contrast_agent
         FROM radiology_orders
        WHERE id = $1::int AND tenant_id = $2::uuid
        LIMIT 1`,
      requireIntId(id),
      tenantId,
    );
    if (preflight.length === 0) throw AppError.notFound('Radiology order not found');
    if (preflight[0].status !== 'ordered') {
      throw AppError.conflict(
        `Contrast plan can only be amended while the order is awaiting acquisition (status is '${preflight[0].status}')`,
        'RADIOLOGY_CONTRAST_PLAN_LOCKED',
      );
    }

    // Clearing an existing contrast plan requires an explicit reason — the
    // clearing is itself a clinical decision and must be attributable.
    const clearReason = cleanOptionalText(data.reason ?? data.clear_reason ?? data.clearReason);
    const isClearing = preflight[0].contrast_planned === true && !contrastPlanned;
    if (isClearing && (!clearReason || clearReason.length < 5)) {
      throw AppError.badRequest(
        'Clearing a recorded contrast plan requires a reason (at least 5 characters)',
        'RADIOLOGY_CONTRAST_CLEAR_REASON_REQUIRED',
      );
    }

    let contrastScreen = null;
    let contrastOverride = null;
    if (contrastPlanned) {
      contrastScreen = await validateRadiologyContrastSafety({
        patientUid: preflight[0].patient_uid,
        modality: preflight[0].modality,
        contrastAgent,
      });
      contrastOverride = assertContrastOrderAllowed(
        contrastScreen,
        data.override ?? (data.contrast_override_reason
          ? { reason: data.contrast_override_reason, approvedBy: data.contrast_override_by }
          : null),
        actorUid,
      );
      if (contrastOverride) {
        logger.warn('Radiology contrast allergy override used (contrast plan amendment)', {
          radiology_order_id: preflight[0].id,
          patient_uid: preflight[0].patient_uid,
          contrast_agent: contrastAgent,
          blockers: contrastScreen.blockers.length,
          approved_by: contrastOverride.approvedBy,
        });
      }
    }

    const order = await setTenantTx(tenantId, async (tx) => {
      const existing = await tx.$queryRawUnsafe(
        `SELECT id, tenant_id, patient_uid, encounter_id, status, contrast_planned, contrast_agent,
                contrast_allergy_screen, contrast_override_reason, contrast_override_by, contrast_override_at
           FROM radiology_orders
          WHERE id = $1::int AND tenant_id = $2::uuid
          FOR UPDATE`,
        requireIntId(id),
        tenantId,
      );
      if (existing.length === 0) throw AppError.notFound('Radiology order not found');
      if (existing[0].status !== 'ordered') {
        throw AppError.conflict(
          `Contrast plan can only be amended while the order is awaiting acquisition (status is '${existing[0].status}')`,
          'RADIOLOGY_CONTRAST_PLAN_LOCKED',
        );
      }
      // Append-only evidence: the prior screen blob (and any override the
      // columns held) survives every amendment inside `history`. The override
      // COLUMNS reflect only the CURRENT plan (the migration-678 paired CHECK
      // forbids override columns on a non-contrast order), so the JSONB is
      // where the historical record lives.
      const priorOverride = existing[0].contrast_override_reason
        ? {
          reason: existing[0].contrast_override_reason,
          approved_by: existing[0].contrast_override_by,
          approved_at: existing[0].contrast_override_at,
        }
        : null;
      const evidenceHistory = buildContrastEvidenceHistory(existing[0].contrast_allergy_screen, {
        actorUid,
        priorOverride,
      });
      const clearingNow = existing[0].contrast_planned === true && !contrastPlanned;
      const result = await tx.$queryRawUnsafe(
        `UPDATE radiology_orders
            SET contrast_planned = $1::boolean,
                contrast_agent = $2,
                contrast_allergy_screen = $3::jsonb,
                contrast_override_reason = $4,
                contrast_override_by = $5::uuid,
                contrast_override_at = CASE WHEN $4::text IS NOT NULL THEN NOW() ELSE NULL END,
                updated_at = NOW()
          WHERE id = $6::int AND tenant_id = $7::uuid
          RETURNING ${RAD_RETURNING}`,
        contrastPlanned,
        contrastAgent,
        JSON.stringify(buildContrastScreenEvidence(contrastScreen, contrastOverride, {
          intentSource,
          contrastPlanned,
          history: evidenceHistory,
          cleared: clearingNow
            ? { reason: clearReason, by: actorUid, at: new Date().toISOString() }
            : null,
        })),
        contrastOverride?.reason ?? null,
        contrastOverride?.approvedBy ?? null,
        requireIntId(id),
        tenantId,
      );
      const row = result[0];
      await recordContrastSafetyReviews(tx, {
        tenantId,
        order: row,
        screen: contrastScreen,
        override: contrastOverride,
        actorUid,
      });
      await emitRadiologyCanonicalEvent(tx, row, 'radiology.contrast_plan_updated', {
        actorUid,
        actorRole: context.actorRole || null,
        summary: contrastPlanned
          ? `Contrast planned for radiology ${row.modality} ${row.body_part}${contrastAgent ? ` (${contrastAgent})` : ''}`
          : `Contrast removed from radiology ${row.modality} ${row.body_part} plan`,
        payload: {
          contrast_planned: contrastPlanned,
          contrast_agent: contrastAgent,
          contrast_intent_source: intentSource,
          contrast_screen_status: contrastScreen ? contrastScreen.status : null,
          previous_contrast_planned: existing[0].contrast_planned,
          previous_contrast_agent: existing[0].contrast_agent,
          contrast_allergy_blockers: contrastScreen ? contrastScreen.blockers.length : 0,
          contrast_allergy_override: Boolean(contrastOverride),
          // What a clearing removed — the timeline must say what was erased
          // from the ACTIVE plan (the evidence itself lives on in history).
          ...(clearingNow
            ? {
              cleared_reason: clearReason,
              cleared_contrast_agent: existing[0].contrast_agent,
              cleared_had_override: Boolean(priorOverride),
              cleared_override_reason: priorOverride?.reason ?? null,
            }
            : {}),
        },
        beforeStatus: existing[0].status,
        afterStatus: existing[0].status,
        occurredAt: row.updated_at,
      });
      return row;
    });

    logger.info('Radiology contrast plan updated', {
      orderId: order.id,
      contrast_planned: contrastPlanned,
      contrast_agent: contrastAgent,
      override_used: Boolean(contrastOverride),
    });
    return normalizeWireValue(order);
  }

  async getWorklist(filters = {}) {
    const tenantId = tenantOr(filters.tenantId || filters.tenant_id);
    const { status, modality, priority } = filters;
    const listQuery = parseListQuery(filters, {
      defaultLimit: 50,
      maxLimit: 200,
      defaultSortBy: 'created_at',
    });
    return setTenant(tenantId, async (tx) => {
      const conditions = ['ro.tenant_id = $1::uuid'];
      const params = [tenantId];

      if (status) {
        params.push(status);
        conditions.push(`ro.status = $${params.length}`);
      }
      if (modality) {
        params.push(normaliseModality(modality));
        conditions.push(`ro.modality = $${params.length}`);
      }
      if (priority) {
        params.push(normalisePriority(priority));
        conditions.push(`ro.priority = $${params.length}`);
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;
      const countResult = await tx.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count FROM radiology_orders ro ${whereClause}`,
        ...params,
      );
      const total = parseInt(countResult[0].count, 10);

      params.push(listQuery.limit);
      params.push(listQuery.offset);

      const result = await tx.$queryRawUnsafe(
        `SELECT ${RAD_CURRENT_READ_PROJECTION}
         FROM radiology_orders ro
         ${RAD_LATEST_ADDENDUM_JOIN}
         ${RAD_LATEST_GENERATION_JOIN}
         ${whereClause}
         ORDER BY
           CASE ro.priority WHEN 'stat' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END,
           ro.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        ...params,
      );
      const pagination = buildPagination(total, listQuery.page, listQuery.limit);
      return { orders: normalizeWireValue(result), pagination };
    }, { readOnly: true });
  }

  async listReportTemplates(filters = {}) {
    const tenantId = tenantOr(filters.tenantId || filters.tenant_id);
    const params = [tenantId];
    const conditions = ['tenant_id = $1::uuid'];
    if (filters.modality) {
      params.push(normaliseModality(filters.modality));
      conditions.push(`modality = $${params.length}`);
    }
    if (filters.body_part || filters.bodyPart) {
      params.push(String(filters.body_part || filters.bodyPart).trim().toLowerCase());
      conditions.push(`LOWER(body_part) = $${params.length}`);
    }
    if (filters.activeOnly !== false) conditions.push('is_active = TRUE');
    return setTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT id, tenant_id, template_code, name, modality, body_part, sections,
                coded_fields_schema, is_active, created_at, updated_at
           FROM radiology_report_templates
          WHERE ${conditions.join(' AND ')}
          ORDER BY modality, body_part NULLS LAST, name`,
        ...params,
      );
      return normalizeWireValue(rows);
    }, { readOnly: true });
  }

  async submitReport(id, data, context = {}) {
    const tenantId = tenantOr(context.tenantId || data.tenantId || data.tenant_id);
    const reportedBy = data.reported_by;
    if (!reportedBy) throw AppError.badRequest('Missing required field: reported_by');

    const order = await setTenantTx(tenantId, async (tx) => {
      const existing = await tx.$queryRawUnsafe(
        `SELECT id, tenant_id, patient_uid, encounter_id, status, report_signed_off_at
           FROM radiology_orders
          WHERE id = $1::int AND tenant_id = $2::uuid
          FOR UPDATE`,
        requireIntId(id),
        tenantId,
      );
      if (existing.length === 0) throw AppError.notFound('Radiology order not found');
      if (existing[0].status === 'cancelled') {
        throw AppError.badRequest('Cannot submit report for a cancelled order');
      }
      if (existing[0].report_signed_off_at) {
        throw AppError.conflict(
          `Report has been signed off at ${existing[0].report_signed_off_at.toISOString?.() ?? existing[0].report_signed_off_at} — overwrites are not permitted. Issue an addendum instead.`,
          'REPORT_SIGNED_OFF',
        );
      }

      const template = await loadTemplate(tx, tenantId, data.template_id ?? data.templateId);
      const rendered = renderRadiologyStructuredReport(data, { template });
      const result = await tx.$queryRawUnsafe(
        `UPDATE radiology_orders
            SET report = $1,
                radiologist = $2::uuid,
                report_completed_at = NOW(),
                status = 'completed',
                template_id = $3::bigint,
                structured_report = $4::jsonb,
                updated_at = NOW()
          WHERE id = $5::int AND tenant_id = $6::uuid
          RETURNING ${RAD_RETURNING}`,
        rendered.text,
        reportedBy,
        rendered.templateId || null,
        JSON.stringify(rendered.structuredReport),
        requireIntId(id),
        tenantId,
      );
      const row = result[0];
      await emitRadiologyCanonicalEvent(tx, row, 'radiology.report_submitted', {
        actorUid: reportedBy,
        actorRole: context.actorRole || data.actorRole || null,
        summary: `Radiology report submitted for ${row.modality} ${row.body_part}`,
        payload: {
          template_id: rendered.templateId,
          section_keys: rendered.structuredReport.sections.map((section) => section.key),
        },
        beforeStatus: existing[0].status,
        afterStatus: 'completed',
        occurredAt: row.report_completed_at,
      });
      return row;
    });

    logger.info('Radiology report submitted', { orderId: id, reported_by: reportedBy });
    return normalizeWireValue(order);
  }

  async getPatientHistory(patientUid, filters = {}) {
    const tenantId = tenantOr(filters.tenantId || filters.tenant_id);
    const listQuery = parseListQuery(filters, {
      defaultLimit: 20,
      maxLimit: 100,
      defaultSortBy: 'created_at',
    });

    return setTenant(tenantId, async (tx) => {
      const countResult = await tx.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count
           FROM radiology_orders
          WHERE patient_uid = $1::uuid AND tenant_id = $2::uuid`,
        patientUid,
        tenantId,
      );
      const total = parseInt(countResult[0].count, 10);

      const result = await tx.$queryRawUnsafe(
        `SELECT ${RAD_CURRENT_READ_PROJECTION}
           FROM radiology_orders ro
           ${RAD_LATEST_ADDENDUM_JOIN}
           ${RAD_LATEST_GENERATION_JOIN}
          WHERE ro.patient_uid = $1::uuid AND ro.tenant_id = $2::uuid
          ORDER BY ro.created_at DESC
          LIMIT $3 OFFSET $4`,
        patientUid,
        tenantId,
        listQuery.limit,
        listQuery.offset,
      );
      const pagination = buildPagination(total, listQuery.page, listQuery.limit);
      return { orders: normalizeWireValue(result), pagination };
    }, { readOnly: true });
  }

  async getOrderDetail(id, filters = {}) {
    const tenantId = tenantOr(filters.tenantId || filters.tenant_id);
    const detail = await setTenant(tenantId, async (tx) => {
      const result = await tx.$queryRawUnsafe(
        `SELECT ${RAD_CURRENT_READ_PROJECTION}
           FROM radiology_orders ro
           ${RAD_LATEST_ADDENDUM_JOIN}
           ${RAD_LATEST_GENERATION_JOIN}
          WHERE ro.id = $1::int AND ro.tenant_id = $2::uuid`,
        requireIntId(id),
        tenantId,
      );
      if (result.length === 0) throw AppError.notFound('Radiology order not found');
      const addenda = await tx.$queryRawUnsafe(
        `SELECT id, radiology_order_id, generation_version, addendum_text,
                previous_classification, result_classification,
                classification_basis, clinical_significance, signed_by,
                signed_at, metadata, created_at
           FROM radiology_report_addenda
          WHERE tenant_id = $1::uuid
            AND radiology_order_id = $2::int
          ORDER BY generation_version ASC, id ASC`,
        tenantId,
        requireIntId(id),
      );
      return { ...result[0], addenda };
    }, { readOnly: true });
    return normalizeWireValue(detail);
  }

  async markAcquired(id, { tech_uid, tech_name, tech_license_number, acquisition_evidence, tenantId, actorRole } = {}) {
    const scopedTenantId = tenantOr(tenantId);
    if (!tech_uid) throw AppError.badRequest('tech_uid is required');
    const evidence = normalizeAcquisitionEvidence(acquisition_evidence);
    const techIdentity = await resolveAcquiringTechnologist(
      tech_uid,
      tech_name,
      tech_license_number,
      scopedTenantId,
    );

    const order = await setTenantTx(scopedTenantId, async (tx) => {
      const existing = await tx.$queryRawUnsafe(
        `SELECT id, tenant_id, patient_uid, encounter_id, status
           FROM radiology_orders
          WHERE id = $1::int AND tenant_id = $2::uuid`,
        requireIntId(id),
        scopedTenantId,
      );
      if (existing.length === 0) throw AppError.notFound('Radiology order not found');
      if (existing[0].status === 'cancelled') {
        throw AppError.badRequest('Cannot acquire a cancelled order');
      }
      if (existing[0].status === 'completed') {
        throw AppError.badRequest('Cannot acquire — order is already completed');
      }
      const result = await tx.$queryRawUnsafe(
        `UPDATE radiology_orders
            SET status = 'acquired',
                acquired_at = NOW(),
                acquired_by = $1::uuid,
                acquired_by_name = $2,
                tech_uid = COALESCE(tech_uid, $1::uuid),
                tech_name = COALESCE(tech_name, $2),
                tech_license_number = COALESCE(tech_license_number, $3),
                pacs_study_instance_uid = COALESCE(pacs_study_instance_uid, $4),
                acquisition_evidence = COALESCE(acquisition_evidence, '{}'::jsonb) || $5::jsonb,
                updated_at = NOW()
          WHERE id = $6::int AND tenant_id = $7::uuid
          RETURNING ${RAD_RETURNING}`,
        tech_uid,
        techIdentity.techName,
        techIdentity.techLicenseNumber,
        evidence.pacsStudyInstanceUid,
        JSON.stringify(evidence.evidence),
        requireIntId(id),
        scopedTenantId,
      );
      const row = result[0];
      await emitRadiologyCanonicalEvent(tx, row, 'radiology.study_acquired', {
        actorUid: tech_uid,
        actorRole,
        summary: `Radiology ${row.modality} study acquired for ${row.body_part}`,
        payload: { pacs_study_instance_uid: evidence.pacsStudyInstanceUid },
        beforeStatus: existing[0].status,
        afterStatus: 'acquired',
        occurredAt: row.acquired_at,
      });
      return row;
    });

    logger.info('Radiology order acquired', { orderId: id, tech_uid });
    return normalizeWireValue(order);
  }

  async appendReportAddendum(id, {
    addendum,
    addendum_by,
    result_classification,
    classification_basis,
    clinical_significance,
    idempotencyKey: rawIdempotencyKey,
    tenantId,
    actorRole,
  } = {}) {
    const scopedTenantId = tenantOr(tenantId);
    if (!addendum || typeof addendum !== 'string' || !addendum.trim()) {
      throw AppError.badRequest('addendum text is required');
    }
    if (!addendum_by) throw AppError.badRequest('addendum_by is required');
    if (!actorRole) throw AppError.badRequest('Authenticated signer role is required');
    const cleanAddendum = String(addendum).trim();
    const classification = normalizeStructuredResultClassification(result_classification);
    const classificationBasis = normalizeStructuredClassificationBasis(classification_basis);
    const significance = normalizeStructuredAddendumSignificance(clinical_significance);
    const idempotencyKey = normalizeDiagnosticIdempotencyKey(rawIdempotencyKey);
    const requestSha256 = sha256ClinicalJson({
      radiology_order_id: String(requireIntId(id)),
      addendum_text: cleanAddendum,
      signer_uid: String(addendum_by),
      result_classification: classification,
      classification_basis: classificationBasis,
      clinical_significance: significance,
    });

    const result = await setTenantTx(scopedTenantId, async (tx) => {
      const existing = await tx.$queryRawUnsafe(
        `SELECT ${RAD_RETURNING}
           FROM radiology_orders
          WHERE id = $1::int AND tenant_id = $2::uuid
          FOR UPDATE`,
        requireIntId(id),
        scopedTenantId,
      );
      if (existing.length === 0) throw AppError.notFound('Radiology order not found');
      if (existing[0].status === 'cancelled') {
        throw AppError.badRequest('Cannot append addendum to a cancelled order');
      }
      if (!existing[0].report_signed_off_at) {
        throw AppError.badRequest(
          'Addendum is for amending a signed report. The report is not signed off yet — use submitReport to revise the draft.',
          'REPORT_NOT_SIGNED_OFF',
        );
      }
      if (!existing[0].result_classification || Number(existing[0].report_generation_version) !== 1) {
        throw AppError.conflict(
          'Signed report has no structured initial classification; reconcile it before adding an amendment',
          'DIAGNOSTIC_SOURCE_RECONCILIATION_REQUIRED',
        );
      }
      const priorAddenda = await tx.$queryRawUnsafe(
        `SELECT id, generation_version, addendum_text, previous_classification,
                result_classification, classification_basis, clinical_significance,
                signed_by, signed_at, idempotency_key, request_sha256
           FROM radiology_report_addenda
          WHERE tenant_id = $1::uuid
            AND radiology_order_id = $2::int
          ORDER BY generation_version ASC, id ASC`,
        scopedTenantId,
        requireIntId(id),
      );
      const predecessor = priorAddenda.at(-1) || null;
      const replayAddendum = priorAddenda.find(
        (entry) => entry.idempotency_key === idempotencyKey,
      ) || null;
      if (replayAddendum && replayAddendum.request_sha256 !== requestSha256) {
        throw AppError.conflict(
          'Idempotency-Key was reused with different radiology addendum content',
          'DIAGNOSTIC_IDEMPOTENCY_CONFLICT',
        );
      }
      const generationVersion = replayAddendum
        ? Number(replayAddendum.generation_version)
        : predecessor
          ? Number(predecessor.generation_version) + 1
          : 2;
      const previousClassification = replayAddendum?.previous_classification
        || predecessor?.result_classification
        || existing[0].result_classification;
      let addendumRow = replayAddendum;
      if (!addendumRow) {
        const inserted = await tx.$queryRawUnsafe(
          `INSERT INTO radiology_report_addenda
             (tenant_id, radiology_order_id, generation_version, addendum_text,
              previous_classification, result_classification, classification_basis,
              clinical_significance, signed_by, idempotency_key, request_sha256,
              metadata)
           VALUES
             ($1::uuid, $2::int, $3::bigint, $4::text,
              $5::text, $6::text, $7::jsonb, $8::text, $9::uuid,
              $10::text, $11::text, '{}'::jsonb)
           RETURNING *`,
          scopedTenantId,
          requireIntId(id),
          generationVersion,
          cleanAddendum,
          previousClassification,
          classification,
          JSON.stringify(classificationBasis),
          significance,
          addendum_by,
          idempotencyKey,
          requestSha256,
        );
        [addendumRow] = inserted;
      }
      const encounterId = await resolveCanonicalEncounterUuid(tx, existing[0]);
      const generationAddenda = replayAddendum
        ? priorAddenda.filter(
          (entry) => Number(entry.generation_version) <= generationVersion,
        )
        : [...priorAddenda, addendumRow];
      const sourceContentSha256 = sha256ClinicalJson({
        report: existing[0].report,
        structured_report: existing[0].structured_report,
        addenda: generationAddenda.map((entry) => ({
          generation_version: Number(entry.generation_version),
          addendum_text: entry.addendum_text,
          result_classification: entry.result_classification,
          classification_basis: entry.classification_basis,
          clinical_significance: entry.clinical_significance,
          signed_by: entry.signed_by,
          signed_at: entry.signed_at,
        })),
      });
      const diagnosticGeneration = await createRadiologyDiagnosticGenerationTx({
        tx,
        tenantId: scopedTenantId,
        patientUid: existing[0].patient_uid,
        encounterId,
        sourceEpisodeKey: `radiology_order:${existing[0].id}`,
        sourceVersion: generationVersion,
        sourceRowId: addendumRow.id,
        radiologyOrderId: existing[0].id,
        radiologyAddendumId: addendumRow.id,
        orderingOwnerUid: existing[0].ordered_by,
        signerUid: addendum_by,
        signerRole: actorRole,
        signedAt: addendumRow.signed_at,
        resultClassification: classification,
        classificationBasis,
        sourceContentSha256,
        clinicalSignificance: significance,
      });

      if (!replayAddendum) {
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_logs
             (uid, action, resource, resource_id, metadata, ip_address)
           VALUES ($1::uuid, 'RADIOLOGY_REPORT_ADDENDUM', 'radiology_order', $2, $3::jsonb, NULL)`,
          String(addendum_by), String(id),
          JSON.stringify({
            radiology_order_id: id,
            radiology_addendum_id: addendumRow.id,
            generation_version: generationVersion,
            result_classification: classification,
            clinical_significance: significance,
            appended_at: addendumRow.signed_at,
          }),
        );
        await emitRadiologyCanonicalEvent(tx, existing[0], 'radiology.report_addendum', {
          actorUid: addendum_by,
          actorRole,
          summary: `Radiology report addendum appended for ${existing[0].modality} ${existing[0].body_part}`,
          payload: {
            radiology_addendum_id: addendumRow.id,
            generation_version: generationVersion,
            result_classification: classification,
            clinical_significance: significance,
          },
          beforeStatus: existing[0].status,
          afterStatus: existing[0].status,
          occurredAt: addendumRow.signed_at,
        });
      }
      const {
        idempotency_key: _idempotencyKey,
        request_sha256: _requestSha256,
        ...publicAddendum
      } = addendumRow;
      return {
        ...existing[0],
        result_classification: addendumRow.result_classification,
        classification_basis: addendumRow.classification_basis,
        report_generation_version: addendumRow.generation_version,
        classification_signed_by: addendumRow.signed_by,
        classification_signed_at: addendumRow.signed_at,
        latest_clinical_significance: addendumRow.clinical_significance,
        latest_addendum_id: addendumRow.id,
        addendum: publicAddendum,
        diagnostic_generation: diagnosticGeneration,
      };
    });

    logger.info('Radiology report addendum appended', { orderId: id, addendum_by });
    return normalizeWireValue(result);
  }

  async signOffReport(id, {
    signed_off_by,
    result_classification,
    classification_basis,
    idempotencyKey: rawIdempotencyKey,
    tenantId,
    actorRole,
  } = {}) {
    const scopedTenantId = tenantOr(tenantId);
    if (!signed_off_by) throw AppError.badRequest('signed_off_by is required');
    if (!actorRole) throw AppError.badRequest('Authenticated signer role is required');
    const classification = normalizeStructuredResultClassification(result_classification);
    const classificationBasis = normalizeStructuredClassificationBasis(classification_basis);
    const idempotencyKey = normalizeDiagnosticIdempotencyKey(rawIdempotencyKey);
    const requestSha256 = sha256ClinicalJson({
      radiology_order_id: String(requireIntId(id)),
      signer_uid: String(signed_off_by),
      result_classification: classification,
      classification_basis: classificationBasis,
    });
    const result = await setTenantTx(scopedTenantId, async (tx) => {
      const existing = await tx.$queryRawUnsafe(
        `SELECT ${RAD_RETURNING}, signoff_idempotency_key, signoff_request_sha256
           FROM radiology_orders
          WHERE id = $1::int AND tenant_id = $2::uuid
          FOR UPDATE`,
        requireIntId(id),
        scopedTenantId,
      );
      if (existing.length === 0) throw AppError.notFound('Radiology order not found');
      if (!existing[0].report_completed_at) {
        throw AppError.badRequest('Cannot sign off — report has not been submitted yet');
      }
      if (existing[0].report_signed_off_at) {
        if (
          existing[0].signoff_idempotency_key === idempotencyKey
          && existing[0].signoff_request_sha256 === requestSha256
        ) {
          const diagnosticGeneration = await createRadiologyDiagnosticGenerationTx({
            tx,
            tenantId: scopedTenantId,
            patientUid: existing[0].patient_uid,
            encounterId: await resolveCanonicalEncounterUuid(tx, existing[0]),
            sourceEpisodeKey: `radiology_order:${existing[0].id}`,
            sourceVersion: 1,
            sourceRowId: existing[0].id,
            radiologyOrderId: existing[0].id,
            orderingOwnerUid: existing[0].ordered_by,
            signerUid: existing[0].classification_signed_by,
            signerRole: actorRole,
            signedAt: existing[0].classification_signed_at,
            resultClassification: existing[0].result_classification,
            classificationBasis: existing[0].classification_basis,
            sourceContentSha256: sha256ClinicalJson({
              report: existing[0].report,
              structured_report: existing[0].structured_report,
            }),
          });
          return { ...existing[0], diagnostic_generation: diagnosticGeneration };
        }
        throw AppError.conflict('Report is already signed off', 'REPORT_SIGNED_OFF');
      }
      const result = await tx.$queryRawUnsafe(
        `UPDATE radiology_orders
            SET report_signed_off_at = NOW(),
                report_signed_off_by = $1::uuid,
                result_classification = $4::text,
                classification_basis = $5::jsonb,
                report_generation_version = 1,
                classification_signed_by = $1::uuid,
                classification_signed_at = NOW(),
                signoff_idempotency_key = $6::text,
                signoff_request_sha256 = $7::text,
                updated_at = NOW()
          WHERE id = $2::int AND tenant_id = $3::uuid
          RETURNING ${RAD_RETURNING}`,
        signed_off_by,
        requireIntId(id),
        scopedTenantId,
        classification,
        JSON.stringify(classificationBasis),
        idempotencyKey,
        requestSha256,
      );
      const row = result[0];
      const encounterId = await resolveCanonicalEncounterUuid(tx, row);
      const diagnosticGeneration = await createRadiologyDiagnosticGenerationTx({
        tx,
        tenantId: scopedTenantId,
        patientUid: row.patient_uid,
        encounterId,
        sourceEpisodeKey: `radiology_order:${row.id}`,
        sourceVersion: 1,
        sourceRowId: row.id,
        radiologyOrderId: row.id,
        orderingOwnerUid: row.ordered_by,
        signerUid: signed_off_by,
        signerRole: actorRole,
        signedAt: row.classification_signed_at,
        resultClassification: classification,
        classificationBasis,
        sourceContentSha256: sha256ClinicalJson({
          report: row.report,
          structured_report: row.structured_report,
        }),
      });
      await emitRadiologyCanonicalEvent(tx, row, 'radiology.report_signed_off', {
        actorUid: signed_off_by,
        actorRole,
        summary: `Radiology report signed off for ${row.modality} ${row.body_part}`,
        beforeStatus: existing[0].status,
        afterStatus: row.status,
        occurredAt: row.report_signed_off_at,
      });
      const metrics = await tx.$queryRawUnsafe(
        `SELECT * FROM radiology_tat_metrics
          WHERE tenant_id = $1::uuid AND radiology_order_id = $2::int`,
        scopedTenantId,
        requireIntId(id),
      );
      if (metrics[0]) await maybeEmitTatAlert(tx, metrics[0]);
      return { ...row, diagnostic_generation: diagnosticGeneration };
    });

    logger.info('Radiology report signed off', { orderId: id, signed_off_by });
    const {
      signoff_idempotency_key: _signoffIdempotencyKey,
      signoff_request_sha256: _signoffRequestSha256,
      ...publicResult
    } = result;
    return normalizeWireValue(publicResult);
  }

  async recordPeerReview(id, data = {}, context = {}) {
    const tenantId = tenantOr(context.tenantId || data.tenantId || data.tenant_id);
    const reviewerUid = data.reviewer_uid || data.reviewerUid || context.actorUid;
    if (!reviewerUid) throw AppError.badRequest('reviewer_uid is required');
    const score = Number.parseInt(String(data.discrepancy_score ?? data.discrepancyScore), 10);
    if (!Number.isInteger(score) || score < 1 || score > 4) {
      throw AppError.badRequest('discrepancy_score must be an integer from 1 to 4', 'RADIOLOGY_PEER_REVIEW_SCORE_INVALID');
    }
    const outcome = cleanOptionalText(data.outcome) || 'no_change';
    if (!PEER_REVIEW_OUTCOMES.includes(outcome)) {
      throw AppError.badRequest(`outcome must be one of: ${PEER_REVIEW_OUTCOMES.join(', ')}`, 'RADIOLOGY_PEER_REVIEW_OUTCOME_INVALID');
    }

    return setTenantTx(tenantId, async (tx) => {
      const orderRows = await tx.$queryRawUnsafe(
        `SELECT id, tenant_id, patient_uid, status, radiologist, report_signed_off_by, report_signed_off_at
           FROM radiology_orders
          WHERE id = $1::int AND tenant_id = $2::uuid
          LIMIT 1`,
        requireIntId(id),
        tenantId,
      );
      if (!orderRows.length) throw AppError.notFound('Radiology order not found');
      const order = orderRows[0];
      if (!order.report_signed_off_at) {
        throw AppError.badRequest('Peer review is only available after report sign-off', 'RADIOLOGY_PEER_REVIEW_REQUIRES_SIGNOFF');
      }
      const authorUid = order.radiologist || order.report_signed_off_by;
      if (!authorUid) throw AppError.badRequest('Signed report has no report author to review', 'RADIOLOGY_PEER_REVIEW_AUTHOR_MISSING');
      if (String(authorUid).toLowerCase() === String(reviewerUid).toLowerCase()) {
        throw AppError.conflict('Reviewer must be different from the report author', 'RADIOLOGY_PEER_REVIEW_SAME_AUTHOR');
      }
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO radiology_peer_reviews
           (tenant_id, radiology_order_id, reviewer_uid, report_author_uid,
            discrepancy_score, outcome, comments, addendum_recommendation, metadata)
         VALUES ($1::uuid, $2::int, $3::uuid, $4::uuid, $5::int, $6, $7, $8, $9::jsonb)
         ON CONFLICT (tenant_id, radiology_order_id, reviewer_uid) DO UPDATE SET
           discrepancy_score = EXCLUDED.discrepancy_score,
           outcome = EXCLUDED.outcome,
           comments = EXCLUDED.comments,
           addendum_recommendation = EXCLUDED.addendum_recommendation,
           metadata = EXCLUDED.metadata,
           reviewed_at = NOW(),
           updated_at = NOW()
         RETURNING *`,
        tenantId,
        order.id,
        reviewerUid,
        authorUid,
        score,
        outcome,
        cleanOptionalText(data.comments),
        cleanOptionalText(data.addendum_recommendation ?? data.addendumRecommendation ?? data.addendum),
        JSON.stringify(safeJsonObject(data.metadata)),
      );
      return normalizeWireValue(rows[0]);
    });
  }

  async listPeerReviewBoard(filters = {}) {
    const tenantId = tenantOr(filters.tenantId || filters.tenant_id);
    const listQuery = parseListQuery(filters, { defaultLimit: 50, maxLimit: 200, defaultSortBy: 'report_signed_off_at' });
    const status = cleanOptionalText(filters.status);
    const conditions = ['ro.tenant_id = $1::uuid', 'ro.report_signed_off_at IS NOT NULL'];
    const params = [tenantId];
    if (status === 'needs_review') {
      conditions.push('pr.review_count IS NULL');
    } else if (status === 'reviewed') {
      conditions.push('pr.review_count IS NOT NULL');
    }
    params.push(listQuery.limit, listQuery.offset);
    return setTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `WITH peer_rollup AS (
           SELECT radiology_order_id, COUNT(*)::int AS review_count,
                  MAX(reviewed_at) AS latest_reviewed_at,
                  MAX(discrepancy_score) AS max_discrepancy_score
             FROM radiology_peer_reviews
            WHERE tenant_id = $1::uuid
            GROUP BY radiology_order_id
         )
         SELECT ro.id, ro.patient_uid, ro.modality, ro.body_part, ro.priority, ro.status,
                ro.radiologist, ro.report_signed_off_by, ro.report_signed_off_at,
                COALESCE(pr.review_count, 0)::int AS review_count,
                pr.latest_reviewed_at, pr.max_discrepancy_score
           FROM radiology_orders ro
           LEFT JOIN peer_rollup pr ON pr.radiology_order_id = ro.id
          WHERE ${conditions.join(' AND ')}
          ORDER BY ro.report_signed_off_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        ...params,
      );
      const countRows = await tx.$queryRawUnsafe(
        `WITH peer_rollup AS (
           SELECT radiology_order_id, COUNT(*)::int AS review_count
             FROM radiology_peer_reviews
            WHERE tenant_id = $1::uuid
            GROUP BY radiology_order_id
         )
         SELECT COUNT(*)::int AS count
           FROM radiology_orders ro
           LEFT JOIN peer_rollup pr ON pr.radiology_order_id = ro.id
          WHERE ${conditions.join(' AND ')}`,
        ...params.slice(0, -2),
      );
      return {
        reviews: normalizeWireValue(rows),
        pagination: buildPagination(Number(countRows[0]?.count || 0), listQuery.page, listQuery.limit),
      };
    }, { readOnly: true });
  }

  async pickPeerReviewSample(filters = {}) {
    const tenantId = tenantOr(filters.tenantId || filters.tenant_id);
    const seed = cleanOptionalText(filters.seed) || new Date().toISOString().slice(0, 10);
    const limit = positiveIntOrNull(filters.limit) || 25;
    return setTenant(tenantId, async (tx) => {
      const settingRows = await tx.$queryRawUnsafe(
        `SELECT sampling_rate FROM radiology_peer_review_settings WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      const samplingRate = Number(settingRows[0]?.sampling_rate ?? DEFAULT_PEER_REVIEW_SAMPLE_RATE);
      const rows = await tx.$queryRawUnsafe(
        `SELECT ro.id, ro.patient_uid, ro.modality, ro.body_part, ro.priority,
                ro.radiologist, ro.report_signed_off_by, ro.report_signed_off_at
           FROM radiology_orders ro
           LEFT JOIN radiology_peer_reviews pr
             ON pr.tenant_id = ro.tenant_id AND pr.radiology_order_id = ro.id
          WHERE ro.tenant_id = $1::uuid
            AND ro.report_signed_off_at IS NOT NULL
            AND pr.id IS NULL
          ORDER BY ro.report_signed_off_at DESC
          LIMIT 1000`,
        tenantId,
      );
      return {
        seed,
        sampling_rate: samplingRate,
        orders: normalizeWireValue(pickDeterministicSignedReportSample(rows, { seed, samplingRate, limit })),
      };
    }, { readOnly: true });
  }

  async getTatMetrics(filters = {}) {
    const tenantId = tenantOr(filters.tenantId || filters.tenant_id);
    const listQuery = parseListQuery(filters, { defaultLimit: 50, maxLimit: 200, defaultSortBy: 'ordered_at' });
    const conditions = ['tenant_id = $1::uuid'];
    const params = [tenantId];
    if (filters.priority) {
      params.push(normalisePriority(filters.priority));
      conditions.push(`priority = $${params.length}`);
    }
    if (filters.modality) {
      params.push(normaliseModality(filters.modality));
      conditions.push(`modality = $${params.length}`);
    }
    if (filters.breached === true || filters.breached === 'true') {
      conditions.push('threshold_breached = TRUE');
    }

    params.push(listQuery.limit, listQuery.offset);
    const result = await setTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT *
           FROM radiology_tat_metrics
          WHERE ${conditions.join(' AND ')}
          ORDER BY threshold_breached DESC, ordered_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        ...params,
      );
      const countRows = await tx.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count
           FROM radiology_tat_metrics
          WHERE ${conditions.join(' AND ')}`,
        ...params.slice(0, -2),
      );
      return {
        metrics: normalizeWireValue(rows),
        pagination: buildPagination(Number(countRows[0]?.count || 0), listQuery.page, listQuery.limit),
      };
    }, { readOnly: true });

    if (filters.emitAlerts !== false) {
      for (const metric of result.metrics.filter((row) => row.threshold_breached)) {
        await setTenantTx(tenantId, (tx) => maybeEmitTatAlert(tx, metric));
      }
    }
    return result;
  }

  async cancelOrder(id, cancelledBy, context = {}) {
    const tenantId = tenantOr(context.tenantId || context.tenant_id);
    const order = await setTenantTx(tenantId, async (tx) => {
      const existing = await tx.$queryRawUnsafe(
        `SELECT id, tenant_id, patient_uid, encounter_id, status
           FROM radiology_orders
          WHERE id = $1::int AND tenant_id = $2::uuid`,
        requireIntId(id),
        tenantId,
      );
      if (existing.length === 0) throw AppError.notFound('Radiology order not found');
      if (existing[0].status === 'completed') {
        throw AppError.badRequest('Cannot cancel a completed order');
      }
      if (existing[0].status === 'cancelled') {
        throw AppError.badRequest('Order is already cancelled');
      }

      const result = await tx.$queryRawUnsafe(
        `UPDATE radiology_orders
            SET status = 'cancelled', updated_at = NOW()
          WHERE id = $1::int AND tenant_id = $2::uuid
          RETURNING ${RAD_RETURNING}`,
        requireIntId(id),
        tenantId,
      );
      const row = result[0];
      await emitRadiologyCanonicalEvent(tx, row, 'radiology.order_cancelled', {
        actorUid: cancelledBy,
        actorRole: context.actorRole || null,
        summary: `Radiology order cancelled for ${row.modality} ${row.body_part}`,
        beforeStatus: existing[0].status,
        afterStatus: 'cancelled',
        occurredAt: row.updated_at,
      });
      return row;
    });

    logger.info('Radiology order cancelled', { orderId: id, cancelledBy });
    return normalizeWireValue(order);
  }
}

export default new RadiologyService();
