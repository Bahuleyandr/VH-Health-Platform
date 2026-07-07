// src/services/radiology/radiologyService.js

import crypto from 'node:crypto';
import prisma, { setTenant, setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { AppError } from '../../utils/AppError.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';

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

const RAD_RETURNING = `id, patient_uid, encounter_id, modality, body_part, clinical_indication,
    priority, status, ordered_by, radiologist, report, report_completed_at,
    report_signed_off_at, report_signed_off_by, acquired_at, acquired_by,
    acquired_by_name, tech_uid, tech_name, tech_license_number,
    pacs_study_instance_uid, acquisition_evidence, template_id, structured_report,
    tenant_id, notes, created_at, updated_at`;

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

export async function resolveEncounterIdForRadiology(rawEncounterId, patientUid) {
  if (rawEncounterId == null || rawEncounterId === '') return null;
  const raw = String(rawEncounterId).trim();
  if (UUID_RE.test(raw)) {
    try {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id FROM admissions WHERE encounter_id = $1::uuid LIMIT 1`,
        raw,
      );
      if (rows.length) return Number(rows[0].id);
    } catch (e) {
      logger.warn('Radiology order: admissions lookup failed for encounter_id uuid', {
        encounter_id: raw, patient_uid: patientUid, err: e?.message ?? String(e),
      });
      return null;
    }
    logger.warn('Radiology order: encounter_id uuid did not match any admission; storing null', {
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
  try {
    const rows = await db.$queryRawUnsafe(
      `SELECT encounter_id
         FROM admissions
        WHERE id = $1::int AND patient_uid = $2::uuid
        LIMIT 1`,
      Number(order.encounter_id),
      order.patient_uid,
    );
    return rows[0]?.encounter_id || null;
  } catch (err) {
    logger.warn('Radiology canonical encounter resolution failed', {
      orderId: order.id,
      encounter_id: order.encounter_id,
      err: err?.message ?? String(err),
    });
    return null;
  }
}

async function emitRadiologyCanonicalEvent(db, order, eventType, {
  actorUid = null, actorRole = null, summary, payload = {}, beforeStatus = null, afterStatus = null, occurredAt = null,
}) {
  const eventAt = occurredAt || order.updated_at || order.created_at || new Date().toISOString();
  const encounterId = await resolveCanonicalEncounterUuid(db, order);
  await recordCanonicalClinicalEvent({
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

async function resolveAcquiringTechnologist(techUid, fallbackName, fallbackLicenseNumber) {
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
        AND UPPER(COALESCE(u.role, '')) = 'RADIOLOGY_STAFF'
        AND COALESCE(u.is_active, true) = true
      LIMIT 1`,
    techUid,
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

class RadiologyService {
  async createOrder(data, context = {}) {
    const tenantId = tenantOr(context.tenantId || data.tenantId || data.tenant_id);
    const patient_uid = data.patient_uid;
    const encounter_id = data.encounter_id;
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

    const resolvedEncounterId = await resolveEncounterIdForRadiology(encounter_id, patient_uid);
    const order = await setTenantTx(tenantId, async (tx) => {
      const result = await tx.$queryRawUnsafe(
        `INSERT INTO radiology_orders
          (patient_uid, encounter_id, modality, body_part, clinical_indication,
           priority, status, ordered_by, notes, tenant_id, created_at, updated_at)
         VALUES ($1::uuid, $2::int, $3, $4, $5, $6, 'ordered', $7::uuid, $8, $9::uuid, NOW(), NOW())
         RETURNING ${RAD_RETURNING}`,
        patient_uid, resolvedEncounterId, modality, body_part, clinical_indication,
        priority, ordered_by, notes || null, tenantId,
      );
      const row = result[0];
      await emitRadiologyCanonicalEvent(tx, row, 'radiology.order_created', {
        actorUid: ordered_by,
        actorRole: context.actorRole || data.actorRole || null,
        summary: `Radiology ${modality} order created for ${body_part}`,
        payload: { clinical_indication },
        afterStatus: 'ordered',
        occurredAt: row.created_at,
      });
      return row;
    });

    logger.info('Radiology order created', { orderId: order.id, modality, patient_uid });
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
        `SELECT ro.id, ro.patient_uid, ro.encounter_id, ro.modality, ro.body_part,
                ro.clinical_indication, ro.priority, ro.status, ro.ordered_by,
                ro.radiologist, ro.report, ro.report_completed_at,
                ro.report_signed_off_at, ro.report_signed_off_by,
                ro.acquired_at, ro.acquired_by, ro.acquired_by_name,
                ro.tech_uid, ro.tech_name, ro.tech_license_number,
                ro.pacs_study_instance_uid, ro.acquisition_evidence,
                ro.template_id, ro.structured_report, ro.tenant_id,
                ro.notes, ro.created_at, ro.updated_at
         FROM radiology_orders ro
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
          WHERE id = $1::int AND tenant_id = $2::uuid`,
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
        `SELECT ${RAD_RETURNING}
           FROM radiology_orders
          WHERE patient_uid = $1::uuid AND tenant_id = $2::uuid
          ORDER BY created_at DESC
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
    const result = await setTenant(tenantId, (tx) => tx.$queryRawUnsafe(
      `SELECT ${RAD_RETURNING}
         FROM radiology_orders
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      requireIntId(id),
      tenantId,
    ), { readOnly: true });
    if (result.length === 0) throw AppError.notFound('Radiology order not found');
    return normalizeWireValue(result[0]);
  }

  async markAcquired(id, { tech_uid, tech_name, tech_license_number, acquisition_evidence, tenantId, actorRole } = {}) {
    const scopedTenantId = tenantOr(tenantId);
    if (!tech_uid) throw AppError.badRequest('tech_uid is required');
    const evidence = normalizeAcquisitionEvidence(acquisition_evidence);
    const techIdentity = await resolveAcquiringTechnologist(
      tech_uid,
      tech_name,
      tech_license_number,
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

  async appendReportAddendum(id, { addendum, addendum_by, tenantId, actorRole } = {}) {
    const scopedTenantId = tenantOr(tenantId);
    if (!addendum || typeof addendum !== 'string' || !addendum.trim()) {
      throw AppError.badRequest('addendum text is required');
    }
    if (!addendum_by) throw AppError.badRequest('addendum_by is required');
    const cleanAddendum = String(addendum).trim();

    const order = await setTenantTx(scopedTenantId, async (tx) => {
      const existing = await tx.$queryRawUnsafe(
        `SELECT id, tenant_id, patient_uid, encounter_id, status, report, report_signed_off_at
           FROM radiology_orders
          WHERE id = $1::int AND tenant_id = $2::uuid`,
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
      const stampedAddendum = `\n\n--- Addendum (${new Date().toISOString()} by ${addendum_by}) ---\n${cleanAddendum}`;
      const baseReport = existing[0].report || '';
      const newReport = `${baseReport}${stampedAddendum}`;

      const result = await tx.$queryRawUnsafe(
        `UPDATE radiology_orders
            SET report = $1, updated_at = NOW()
          WHERE id = $2::int AND tenant_id = $3::uuid
          RETURNING ${RAD_RETURNING}`,
        newReport,
        requireIntId(id),
        scopedTenantId,
      );
      const row = result[0];

      await tx.$executeRawUnsafe(
        `INSERT INTO audit_logs
           (uid, action, resource, resource_id, metadata, ip_address)
         VALUES ($1::uuid, 'RADIOLOGY_REPORT_ADDENDUM', 'radiology_order', $2, $3::jsonb, NULL)`,
        String(addendum_by), String(id),
        JSON.stringify({
          radiology_order_id: id,
          addendum_text: cleanAddendum.slice(0, 4000),
          appended_at: new Date().toISOString(),
        }),
      );
      await emitRadiologyCanonicalEvent(tx, row, 'radiology.report_addendum', {
        actorUid: addendum_by,
        actorRole,
        summary: `Radiology report addendum appended for ${row.modality} ${row.body_part}`,
        payload: { addendum_preview: cleanAddendum.slice(0, 240) },
        beforeStatus: existing[0].status,
        afterStatus: row.status,
        occurredAt: row.updated_at,
      });
      return row;
    });

    logger.info('Radiology report addendum appended', { orderId: id, addendum_by });
    return normalizeWireValue(order);
  }

  async signOffReport(id, { signed_off_by, tenantId, actorRole } = {}) {
    const scopedTenantId = tenantOr(tenantId);
    if (!signed_off_by) throw AppError.badRequest('signed_off_by is required');
    const order = await setTenantTx(scopedTenantId, async (tx) => {
      const existing = await tx.$queryRawUnsafe(
        `SELECT id, tenant_id, patient_uid, encounter_id, status, report_completed_at, report_signed_off_at
           FROM radiology_orders
          WHERE id = $1::int AND tenant_id = $2::uuid`,
        requireIntId(id),
        scopedTenantId,
      );
      if (existing.length === 0) throw AppError.notFound('Radiology order not found');
      if (!existing[0].report_completed_at) {
        throw AppError.badRequest('Cannot sign off — report has not been submitted yet');
      }
      if (existing[0].report_signed_off_at) {
        throw AppError.conflict('Report is already signed off', 'REPORT_SIGNED_OFF');
      }
      const result = await tx.$queryRawUnsafe(
        `UPDATE radiology_orders
            SET report_signed_off_at = NOW(),
                report_signed_off_by = $1::uuid,
                updated_at = NOW()
          WHERE id = $2::int AND tenant_id = $3::uuid
          RETURNING ${RAD_RETURNING}, report_signed_off_at, report_signed_off_by`,
        signed_off_by,
        requireIntId(id),
        scopedTenantId,
      );
      const row = result[0];
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
      ).catch(() => []);
      if (metrics[0]) await maybeEmitTatAlert(tx, metrics[0]);
      return row;
    });

    logger.info('Radiology report signed off', { orderId: id, signed_off_by });
    return normalizeWireValue(order);
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
        await setTenantTx(tenantId, (tx) => maybeEmitTatAlert(tx, metric)).catch((err) => {
          logger.warn('Radiology TAT alert emission failed', { orderId: metric.radiology_order_id, err: err.message });
        });
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
