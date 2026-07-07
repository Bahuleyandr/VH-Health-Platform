// src/services/pathology/pathologyService.js

import crypto from 'node:crypto';
import { setTenant, setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { AppError } from '../../utils/AppError.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';

const VALID_CASE_KINDS = ['histopathology', 'cytology', 'frozen_section'];
const VALID_PRIORITIES = ['routine', 'urgent', 'stat'];
const VALID_MALIGNANCY_FLAGS = ['not_assessed', 'benign', 'premalignant', 'malignant', 'suspicious', 'inadequate'];
const VALID_STAIN_TYPES = ['h_and_e', 'special', 'ihc', 'cytology'];
const REPORT_TRANSITIONS = {
  draft: new Set(['draft', 'preliminary', 'final']),
  preliminary: new Set(['preliminary', 'final']),
  final: new Set(['amended']),
  amended: new Set(['amended']),
};

const CASE_KIND_ALIASES = {
  histo: 'histopathology',
  biopsy: 'histopathology',
  histology: 'histopathology',
  fnac: 'cytology',
  pap: 'cytology',
  fluid_cyto: 'cytology',
  fluid_cytology: 'cytology',
  frozen: 'frozen_section',
  frozensection: 'frozen_section',
  frozen_section: 'frozen_section',
};

const PRIORITY_ALIASES = {
  emergency: 'stat',
  emergent: 'stat',
  high: 'urgent',
  normal: 'routine',
  low: 'routine',
};

const STAIN_ALIASES = {
  he: 'h_and_e',
  h_e: 'h_and_e',
  'h&e': 'h_and_e',
  h_and_e: 'h_and_e',
  special_stain: 'special',
  immunohistochemistry: 'ihc',
  pap: 'cytology',
  cytology: 'cytology',
};

const AP_CASE_RETURNING = `id, tenant_id, ap_case_uid, case_number, patient_uid, encounter_id,
  source_investigation_id, primary_specimen_id, case_kind, priority, status,
  clinical_history, accessioned_at, accessioned_by, metadata, created_at, updated_at`;

function tenantOr(value) {
  return requireTenantId(value);
}

function cleanOptionalText(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function safeJsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeWireValue(value) {
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (value instanceof Date || value == null || typeof value !== 'object') return value;
  // Prisma returns Postgres NUMERIC (e.g. ap_tat_metrics.elapsed_hours) as
  // Decimal objects; the generic branch below would destructure them into
  // their {s, e, d} internals and leak that shape to clients.
  if (typeof value.toNumber === 'function' && typeof value.toFixed === 'function') {
    const n = value.toNumber();
    return Number.isFinite(n) ? n : value.toString();
  }
  if (Array.isArray(value)) return value.map(normalizeWireValue);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeWireValue(entry)]));
}

function requireIntId(id, label = 'id') {
  const n = Number.parseInt(id, 10);
  if (!Number.isInteger(n) || n <= 0) throw AppError.badRequest(`Invalid ${label} - must be a positive integer`);
  return n;
}

function optionalInt(value) {
  if (value == null || value === '') return null;
  return requireIntId(value);
}

function optionalUuid(value) {
  const text = cleanOptionalText(value);
  if (!text) return null;
  return text;
}

function normalizeEnum(raw, allowed, aliases, label) {
  const normalized = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const value = aliases[normalized] || normalized;
  if (allowed.includes(value)) return value;
  throw AppError.badRequest(`Invalid ${label}`, `INVALID_${label.toUpperCase()}`, { allowed });
}

function normalizePriority(raw) {
  return normalizeEnum(raw || 'routine', VALID_PRIORITIES, PRIORITY_ALIASES, 'priority');
}

function normalizeCaseKind(raw) {
  return normalizeEnum(raw || 'histopathology', VALID_CASE_KINDS, CASE_KIND_ALIASES, 'case_kind');
}

function normalizeStainType(raw) {
  return normalizeEnum(raw || 'h_and_e', VALID_STAIN_TYPES, STAIN_ALIASES, 'stain_type');
}

function normalizeMalignancyFlag(raw) {
  return normalizeEnum(raw || 'not_assessed', VALID_MALIGNANCY_FLAGS, {}, 'malignancy_flag');
}

function normalizeSpecimenIds(raw) {
  const values = Array.isArray(raw) ? raw : String(raw || '').split(',');
  const ids = [...new Set(values.map((value) => Number.parseInt(value, 10)).filter((value) => Number.isInteger(value) && value > 0))];
  if (ids.length === 0) throw AppError.badRequest('At least one specimen id is required', 'AP_SPECIMEN_REQUIRED');
  return ids;
}

function sanitizeCodePart(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

export function deriveApBlockCode(caseNumber, sequenceNo) {
  const base = sanitizeCodePart(caseNumber);
  const seq = requireIntId(sequenceNo, 'sequence_no');
  return `${base}-B${pad2(seq)}`;
}

export function deriveApSlideCode(blockCode, sequenceNo, stainType = 'h_and_e') {
  const base = sanitizeCodePart(blockCode);
  const seq = requireIntId(sequenceNo, 'sequence_no');
  const stain = {
    h_and_e: 'HE',
    special: 'SP',
    ihc: 'IHC',
    cytology: 'CY',
  }[normalizeStainType(stainType)];
  return `${base}-S${pad2(seq)}-${stain}`;
}

export function transitionApReportStatus(currentStatus, nextStatus) {
  const current = String(currentStatus || 'draft').trim().toLowerCase();
  const next = String(nextStatus || '').trim().toLowerCase();
  const allowed = REPORT_TRANSITIONS[current];
  if (!allowed || !allowed.has(next)) {
    throw AppError.invalidTransition(current, next, allowed ? [...allowed] : []);
  }
  return next;
}

export function computeApTatMetric(row = {}, now = new Date()) {
  const accessioned = row.accessioned_at ? new Date(row.accessioned_at) : null;
  if (!accessioned || Number.isNaN(accessioned.getTime())) return null;
  const signed = row.signed_at ? new Date(row.signed_at) : now;
  const elapsedHours = Math.round(((signed.getTime() - accessioned.getTime()) / 36_000)) / 100;
  const targetHours = Number(row.target_hours ?? 0);
  return {
    elapsed_hours: elapsedHours,
    target_hours: targetHours || null,
    breached: targetHours > 0 ? elapsedHours > targetHours : false,
    current_tat_stage: row.current_tat_stage || row.case_status || 'accessioned',
  };
}

function generateCaseNumber(caseKind) {
  const prefix = caseKind === 'cytology' ? 'CY' : caseKind === 'frozen_section' ? 'FS' : 'AP';
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${prefix}-${stamp}-${String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')}`;
}

async function emitPathologyCanonicalEvent(db, row, eventType, options = {}) {
  await recordCanonicalClinicalEvent({
    tenantId: row.tenant_id,
    patientUid: row.patient_uid,
    encounterId: row.encounter_id || null,
    eventType,
    eventStatus: options.afterStatus || row.status || null,
    sourceTable: options.sourceTable || 'ap_cases',
    sourceId: String(options.sourceId || row.id),
    resourceType: options.resourceType || 'anatomic_pathology',
    resourceTable: options.sourceTable || 'ap_cases',
    resourceId: String(options.sourceId || row.id),
    actorUid: options.actorUid || null,
    actorRole: options.actorRole || null,
    occurredAt: options.occurredAt || null,
    visibleToPatient: false,
    summary: options.summary || 'Anatomic pathology workflow updated',
    payload: {
      case_number: row.case_number,
      case_kind: row.case_kind,
      before_status: options.beforeStatus || null,
      after_status: options.afterStatus || row.status || null,
      ...safeJsonObject(options.payload),
    },
    tags: ['pathology', 'anatomic_pathology'],
    timelineIdempotencyKey: `${options.sourceTable || 'ap_cases'}:${options.sourceId || row.id}:${eventType}:${options.occurredAt ? new Date(options.occurredAt).toISOString() : new Date().toISOString()}`,
    auditIdempotencyKey: `${options.sourceTable || 'ap_cases'}:${options.sourceId || row.id}:${eventType}:audit:${options.occurredAt ? new Date(options.occurredAt).toISOString() : new Date().toISOString()}`,
  }, { db });
}

async function loadCaseDetail(db, id, tenantId) {
  const caseRows = await db.$queryRawUnsafe(
    `SELECT c.*, tm.target_hours, tm.elapsed_hours, tm.current_tat_stage, tm.breached
       FROM ap_cases c
       LEFT JOIN ap_tat_metrics tm
         ON tm.tenant_id = c.tenant_id AND tm.ap_case_id = c.id
      WHERE c.id = $1::bigint AND c.tenant_id = $2::uuid
      LIMIT 1`,
    requireIntId(id),
    tenantId,
  );
  if (caseRows.length === 0) throw AppError.notFound('Pathology case not found');

  const [specimens, grossRecords, blocks, slides, reports] = await Promise.all([
    db.$queryRawUnsafe(
      `SELECT cs.id, cs.specimen_role, ls.id AS specimen_id, ls.specimen_uid,
              ls.accession_number, ls.specimen_type, ls.priority, ls.status
         FROM ap_case_specimens cs
         JOIN lab_specimens ls
           ON ls.id = cs.specimen_id AND ls.tenant_id = cs.tenant_id
        WHERE cs.ap_case_id = $1::bigint AND cs.tenant_id = $2::uuid
        ORDER BY cs.id ASC`,
      requireIntId(id),
      tenantId,
    ),
    db.$queryRawUnsafe(
      `SELECT *
         FROM ap_gross_records
        WHERE ap_case_id = $1::bigint AND tenant_id = $2::uuid
        ORDER BY recorded_at ASC, id ASC`,
      requireIntId(id),
      tenantId,
    ),
    db.$queryRawUnsafe(
      `SELECT *
         FROM ap_blocks
        WHERE ap_case_id = $1::bigint AND tenant_id = $2::uuid
        ORDER BY sequence_no ASC, id ASC`,
      requireIntId(id),
      tenantId,
    ),
    db.$queryRawUnsafe(
      `SELECT *
         FROM ap_slides
        WHERE ap_case_id = $1::bigint AND tenant_id = $2::uuid
        ORDER BY block_id ASC, sequence_no ASC, id ASC`,
      requireIntId(id),
      tenantId,
    ),
    db.$queryRawUnsafe(
      `SELECT *
         FROM ap_reports
        WHERE ap_case_id = $1::bigint AND tenant_id = $2::uuid
        LIMIT 1`,
      requireIntId(id),
      tenantId,
    ),
  ]);

  let addenda = [];
  if (reports[0]) {
    addenda = await db.$queryRawUnsafe(
      `SELECT *
         FROM ap_report_addenda
        WHERE ap_report_id = $1::bigint AND tenant_id = $2::uuid
        ORDER BY addendum_at ASC, id ASC`,
      reports[0].id,
      tenantId,
    );
  }

  return normalizeWireValue({
    case: caseRows[0],
    specimens,
    gross_records: grossRecords,
    blocks,
    slides,
    report: reports[0] || null,
    addenda,
  });
}

class PathologyService {
  async createCase(data, context = {}) {
    const tenantId = tenantOr(context.tenantId || context.tenant_id);
    const specimenIds = normalizeSpecimenIds(data.specimen_ids ?? data.specimenIds);
    const patientUid = cleanOptionalText(data.patient_uid ?? data.patientUid);
    if (!patientUid) throw AppError.badRequest('patient_uid is required');
    const caseKind = normalizeCaseKind(data.case_kind ?? data.caseKind);
    const priority = normalizePriority(data.priority);
    const caseNumber = cleanOptionalText(data.case_number ?? data.caseNumber) || generateCaseNumber(caseKind);

    const detail = await setTenantTx(tenantId, async (tx) => {
      const specimenPlaceholders = specimenIds.map((_, index) => `$${index + 1}::int`).join(', ');
      const specimens = await tx.$queryRawUnsafe(
        `SELECT id, tenant_id, patient_uid, accession_number, specimen_type, priority, status
           FROM lab_specimens
          WHERE id IN (${specimenPlaceholders}) AND tenant_id = $${specimenIds.length + 1}::uuid`,
        ...specimenIds,
        tenantId,
      );
      if (specimens.length !== specimenIds.length) {
        throw AppError.badRequest('One or more specimens were not found for this tenant', 'AP_SPECIMEN_NOT_FOUND');
      }
      const mismatched = specimens.find((specimen) => String(specimen.patient_uid) !== String(patientUid));
      if (mismatched) {
        throw AppError.badRequest('All specimens must belong to the requested patient', 'AP_SPECIMEN_PATIENT_MISMATCH');
      }

      const primarySpecimenId = optionalInt(data.primary_specimen_id ?? data.primarySpecimenId) || specimenIds[0];
      const inserted = await tx.$queryRawUnsafe(
        `INSERT INTO ap_cases
           (tenant_id, case_number, patient_uid, encounter_id, source_investigation_id,
            primary_specimen_id, case_kind, priority, status, clinical_history,
            accessioned_by, metadata)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::int,
                 $6::int, $7, $8, 'accessioned', $9, $10::uuid, $11::jsonb)
         RETURNING ${AP_CASE_RETURNING}`,
        tenantId,
        caseNumber,
        patientUid,
        optionalUuid(data.encounter_id ?? data.encounterId),
        optionalInt(data.source_investigation_id ?? data.sourceInvestigationId),
        primarySpecimenId,
        caseKind,
        priority,
        cleanOptionalText(data.clinical_history ?? data.clinicalHistory),
        optionalUuid(data.accessioned_by ?? data.accessionedBy ?? context.actorUid),
        JSON.stringify(safeJsonObject(data.metadata)),
      );
      const row = inserted[0];

      for (const specimenId of specimenIds) {
        await tx.$queryRawUnsafe(
          `INSERT INTO ap_case_specimens (tenant_id, ap_case_id, specimen_id, specimen_role)
           VALUES ($1::uuid, $2::bigint, $3::int, $4)
           ON CONFLICT (tenant_id, ap_case_id, specimen_id) DO NOTHING`,
          tenantId,
          row.id,
          specimenId,
          specimenId === primarySpecimenId ? 'primary' : 'additional',
        );
      }

      await emitPathologyCanonicalEvent(tx, row, 'pathology.case_accessioned', {
        actorUid: data.accessioned_by ?? data.accessionedBy ?? context.actorUid,
        actorRole: context.actorRole || null,
        afterStatus: 'accessioned',
        occurredAt: row.accessioned_at,
        summary: `Pathology case ${row.case_number} accessioned`,
        payload: { specimen_count: specimenIds.length },
      });

      return loadCaseDetail(tx, row.id, tenantId);
    });

    logger.info('Pathology case accessioned', { caseId: detail.case.id, caseNumber: detail.case.case_number });
    return detail;
  }

  async getCaseDetail(id, context = {}) {
    const tenantId = tenantOr(context.tenantId || context.tenant_id);
    return setTenant(tenantId, (tx) => loadCaseDetail(tx, id, tenantId), { readOnly: true });
  }

  async getWorklist(filters = {}) {
    const tenantId = tenantOr(filters.tenantId || filters.tenant_id);
    const listQuery = parseListQuery(filters, {
      defaultLimit: 25,
      maxLimit: 100,
      defaultSortBy: 'accessioned_at',
      allowedSortFields: ['accessioned_at', 'priority', 'status', 'case_kind'],
    });
    const where = ['c.tenant_id = $1::uuid'];
    const params = [tenantId];
    if (filters.status) {
      params.push(String(filters.status));
      where.push(`c.status = $${params.length}`);
    }
    if (filters.case_kind || filters.caseKind) {
      params.push(normalizeCaseKind(filters.case_kind || filters.caseKind));
      where.push(`c.case_kind = $${params.length}`);
    }
    if (filters.priority) {
      params.push(normalizePriority(filters.priority));
      where.push(`c.priority = $${params.length}`);
    }
    const orderBy = {
      accessioned_at: 'c.accessioned_at',
      priority: 'c.priority',
      status: 'c.status',
      case_kind: 'c.case_kind',
    }[listQuery.sortBy] || 'c.accessioned_at';
    const sort = listQuery.sortOrder === 'ASC' ? 'ASC' : 'DESC';

    return setTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT c.*, r.id AS report_id, r.report_status, r.signed_at, r.signed_by,
                COALESCE(specimens.specimen_count, 0)::int AS specimen_count,
                COALESCE(blocks.block_count, 0)::int AS block_count,
                COALESCE(slides.slide_count, 0)::int AS slide_count,
                tm.target_hours, tm.elapsed_hours, tm.current_tat_stage, tm.breached
           FROM ap_cases c
           LEFT JOIN ap_reports r
             ON r.tenant_id = c.tenant_id AND r.ap_case_id = c.id
           LEFT JOIN LATERAL (
             SELECT COUNT(*) AS specimen_count
               FROM ap_case_specimens cs
              WHERE cs.tenant_id = c.tenant_id AND cs.ap_case_id = c.id
           ) specimens ON TRUE
           LEFT JOIN LATERAL (
             SELECT COUNT(*) AS block_count
               FROM ap_blocks b
              WHERE b.tenant_id = c.tenant_id AND b.ap_case_id = c.id
           ) blocks ON TRUE
           LEFT JOIN LATERAL (
             SELECT COUNT(*) AS slide_count
               FROM ap_slides s
              WHERE s.tenant_id = c.tenant_id AND s.ap_case_id = c.id
           ) slides ON TRUE
           LEFT JOIN ap_tat_metrics tm
             ON tm.tenant_id = c.tenant_id AND tm.ap_case_id = c.id
          WHERE ${where.join(' AND ')}
          ORDER BY ${orderBy} ${sort}, c.id DESC
          LIMIT $${params.length + 1}::int OFFSET $${params.length + 2}::int`,
        ...params,
        listQuery.limit,
        listQuery.offset,
      );
      const countRows = await tx.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count
           FROM ap_cases c
          WHERE ${where.join(' AND ')}`,
        ...params,
      );
      return {
        cases: normalizeWireValue(rows),
        pagination: buildPagination(Number(countRows[0]?.count || 0), listQuery.page, listQuery.limit),
      };
    }, { readOnly: true });
  }

  async recordGross(caseId, data, context = {}) {
    const tenantId = tenantOr(context.tenantId || context.tenant_id);
    const grossText = cleanOptionalText(data.gross_text ?? data.grossText);
    if (!grossText) throw AppError.badRequest('gross_text is required');

    return setTenantTx(tenantId, async (tx) => {
      const existing = await tx.$queryRawUnsafe(
        `SELECT ${AP_CASE_RETURNING} FROM ap_cases WHERE id = $1::bigint AND tenant_id = $2::uuid LIMIT 1`,
        requireIntId(caseId),
        tenantId,
      );
      if (existing.length === 0) throw AppError.notFound('Pathology case not found');
      const beforeStatus = existing[0].status;
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO ap_gross_records
           (tenant_id, ap_case_id, gross_text, specimen_weight_g, dimensions_text,
            cassette_count, dictation_ref, recorded_by, metadata)
         VALUES ($1::uuid, $2::bigint, $3, $4::numeric, $5, $6::int, $7, $8::uuid, $9::jsonb)
         RETURNING *`,
        tenantId,
        requireIntId(caseId),
        grossText,
        data.specimen_weight_g ?? data.specimenWeightG ?? null,
        cleanOptionalText(data.dimensions_text ?? data.dimensionsText),
        optionalInt(data.cassette_count ?? data.cassetteCount),
        cleanOptionalText(data.dictation_ref ?? data.dictationRef),
        optionalUuid(data.recorded_by ?? data.recordedBy ?? context.actorUid),
        JSON.stringify(safeJsonObject(data.metadata)),
      );
      const updated = await tx.$queryRawUnsafe(
        `UPDATE ap_cases
            SET status = 'grossing', updated_at = NOW()
          WHERE id = $1::bigint AND tenant_id = $2::uuid
          RETURNING ${AP_CASE_RETURNING}`,
        requireIntId(caseId),
        tenantId,
      );
      await emitPathologyCanonicalEvent(tx, updated[0], 'pathology.gross_recorded', {
        sourceTable: 'ap_gross_records',
        sourceId: rows[0].id,
        actorUid: data.recorded_by ?? data.recordedBy ?? context.actorUid,
        actorRole: context.actorRole || null,
        beforeStatus,
        afterStatus: 'grossing',
        occurredAt: rows[0].recorded_at,
        summary: `Gross record entered for pathology case ${updated[0].case_number}`,
      });
      return normalizeWireValue(rows[0]);
    });
  }

  async createBlock(caseId, data, context = {}) {
    const tenantId = tenantOr(context.tenantId || context.tenant_id);
    return setTenantTx(tenantId, async (tx) => {
      const existing = await tx.$queryRawUnsafe(
        `SELECT ${AP_CASE_RETURNING} FROM ap_cases WHERE id = $1::bigint AND tenant_id = $2::uuid LIMIT 1`,
        requireIntId(caseId),
        tenantId,
      );
      if (existing.length === 0) throw AppError.notFound('Pathology case not found');
      const maxRows = await tx.$queryRawUnsafe(
        `SELECT COALESCE(MAX(sequence_no), 0)::int AS max_sequence
           FROM ap_blocks
          WHERE tenant_id = $1::uuid AND ap_case_id = $2::bigint`,
        tenantId,
        requireIntId(caseId),
      );
      const sequenceNo = optionalInt(data.sequence_no ?? data.sequenceNo) || Number(maxRows[0]?.max_sequence || 0) + 1;
      const blockCode = cleanOptionalText(data.block_code ?? data.blockCode) || deriveApBlockCode(existing[0].case_number, sequenceNo);
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO ap_blocks
           (tenant_id, ap_case_id, gross_record_id, block_code, sequence_no,
            tissue_site, cassette_label, status, created_by)
         VALUES ($1::uuid, $2::bigint, $3::bigint, $4, $5::int, $6, $7, 'processed', $8::uuid)
         RETURNING *`,
        tenantId,
        requireIntId(caseId),
        optionalInt(data.gross_record_id ?? data.grossRecordId),
        blockCode,
        sequenceNo,
        cleanOptionalText(data.tissue_site ?? data.tissueSite),
        cleanOptionalText(data.cassette_label ?? data.cassetteLabel) || blockCode,
        optionalUuid(data.created_by ?? data.createdBy ?? context.actorUid),
      );
      const updated = await tx.$queryRawUnsafe(
        `UPDATE ap_cases
            SET status = 'processing', updated_at = NOW()
          WHERE id = $1::bigint AND tenant_id = $2::uuid
          RETURNING ${AP_CASE_RETURNING}`,
        requireIntId(caseId),
        tenantId,
      );
      await emitPathologyCanonicalEvent(tx, updated[0], 'pathology.block_created', {
        sourceTable: 'ap_blocks',
        sourceId: rows[0].id,
        actorUid: data.created_by ?? data.createdBy ?? context.actorUid,
        actorRole: context.actorRole || null,
        beforeStatus: existing[0].status,
        afterStatus: 'processing',
        occurredAt: rows[0].created_at,
        summary: `Block ${rows[0].block_code} created for pathology case ${updated[0].case_number}`,
      });
      return normalizeWireValue(rows[0]);
    });
  }

  async createSlide(blockId, data, context = {}) {
    const tenantId = tenantOr(context.tenantId || context.tenant_id);
    return setTenantTx(tenantId, async (tx) => {
      const blockRows = await tx.$queryRawUnsafe(
        `SELECT b.*, c.case_number, c.patient_uid, c.encounter_id, c.case_kind, c.status AS case_status
           FROM ap_blocks b
           JOIN ap_cases c ON c.id = b.ap_case_id AND c.tenant_id = b.tenant_id
          WHERE b.id = $1::bigint AND b.tenant_id = $2::uuid
          LIMIT 1`,
        requireIntId(blockId),
        tenantId,
      );
      if (blockRows.length === 0) throw AppError.notFound('Pathology block not found');
      const block = blockRows[0];
      const maxRows = await tx.$queryRawUnsafe(
        `SELECT COALESCE(MAX(sequence_no), 0)::int AS max_sequence
           FROM ap_slides
          WHERE tenant_id = $1::uuid AND block_id = $2::bigint`,
        tenantId,
        requireIntId(blockId),
      );
      const sequenceNo = optionalInt(data.sequence_no ?? data.sequenceNo) || Number(maxRows[0]?.max_sequence || 0) + 1;
      const stainType = normalizeStainType(data.stain_type ?? data.stainType ?? (block.case_kind === 'cytology' ? 'cytology' : 'h_and_e'));
      const slideCode = cleanOptionalText(data.slide_code ?? data.slideCode) || deriveApSlideCode(block.block_code, sequenceNo, stainType);
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO ap_slides
           (tenant_id, ap_case_id, block_id, slide_code, barcode, sequence_no,
            stain_type, stain_name, status, label_printed_at, label_printed_by, created_by)
         VALUES ($1::uuid, $2::bigint, $3::bigint, $4, $5, $6::int,
                 $7, $8, 'review_ready', $9::timestamptz, $10::uuid, $11::uuid)
         RETURNING *`,
        tenantId,
        block.ap_case_id,
        requireIntId(blockId),
        slideCode,
        cleanOptionalText(data.barcode) || slideCode,
        sequenceNo,
        stainType,
        cleanOptionalText(data.stain_name ?? data.stainName),
        data.label_printed_at ?? data.labelPrintedAt ?? null,
        optionalUuid(data.label_printed_by ?? data.labelPrintedBy),
        optionalUuid(data.created_by ?? data.createdBy ?? context.actorUid),
      );
      const updated = await tx.$queryRawUnsafe(
        `UPDATE ap_cases
            SET status = 'slides_ready', updated_at = NOW()
          WHERE id = $1::bigint AND tenant_id = $2::uuid
          RETURNING ${AP_CASE_RETURNING}`,
        block.ap_case_id,
        tenantId,
      );
      await emitPathologyCanonicalEvent(tx, updated[0], 'pathology.slide_created', {
        sourceTable: 'ap_slides',
        sourceId: rows[0].id,
        actorUid: data.created_by ?? data.createdBy ?? context.actorUid,
        actorRole: context.actorRole || null,
        beforeStatus: block.case_status,
        afterStatus: 'slides_ready',
        occurredAt: rows[0].created_at,
        summary: `Slide ${rows[0].slide_code} created for pathology case ${updated[0].case_number}`,
      });
      return normalizeWireValue(rows[0]);
    });
  }

  async draftReport(caseId, data, context = {}) {
    const tenantId = tenantOr(context.tenantId || context.tenant_id);
    const targetStatus = String(data.report_status ?? data.reportStatus ?? 'draft').trim().toLowerCase();
    if (!['draft', 'preliminary'].includes(targetStatus)) {
      throw AppError.badRequest('Use sign-off or addendum endpoints for final/amended pathology reports', 'AP_REPORT_STATUS_ROUTE');
    }
    const diagnosisText = cleanOptionalText(data.diagnosis_text ?? data.diagnosisText ?? data.diagnosis);

    return setTenantTx(tenantId, async (tx) => {
      const cases = await tx.$queryRawUnsafe(
        `SELECT ${AP_CASE_RETURNING} FROM ap_cases WHERE id = $1::bigint AND tenant_id = $2::uuid LIMIT 1`,
        requireIntId(caseId),
        tenantId,
      );
      if (cases.length === 0) throw AppError.notFound('Pathology case not found');
      const existingReports = await tx.$queryRawUnsafe(
        `SELECT * FROM ap_reports WHERE ap_case_id = $1::bigint AND tenant_id = $2::uuid LIMIT 1`,
        requireIntId(caseId),
        tenantId,
      );
      if (existingReports[0]?.signed_at) {
        throw AppError.conflict('Signed pathology reports are append-only; use an addendum');
      }
      const currentStatus = existingReports[0]?.report_status || 'draft';
      transitionApReportStatus(currentStatus, targetStatus);
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO ap_reports
           (tenant_id, ap_case_id, report_status, gross_text, microscopic_text,
            diagnosis_text, synoptic_fields, malignancy_flag, report_author_uid,
            preliminary_at, preliminary_by, metadata)
         VALUES ($1::uuid, $2::bigint, $3::varchar, $4, $5, $6, $7::jsonb, $8, $9::uuid,
                 CASE WHEN $3::varchar = 'preliminary' THEN NOW() ELSE NULL END,
                 CASE WHEN $3::varchar = 'preliminary' THEN $9::uuid ELSE NULL END,
                 $10::jsonb)
         ON CONFLICT (tenant_id, ap_case_id) DO UPDATE SET
           report_status = EXCLUDED.report_status,
           gross_text = EXCLUDED.gross_text,
           microscopic_text = EXCLUDED.microscopic_text,
           diagnosis_text = EXCLUDED.diagnosis_text,
           synoptic_fields = EXCLUDED.synoptic_fields,
           malignancy_flag = EXCLUDED.malignancy_flag,
           report_author_uid = EXCLUDED.report_author_uid,
           preliminary_at = COALESCE(ap_reports.preliminary_at, EXCLUDED.preliminary_at),
           preliminary_by = COALESCE(ap_reports.preliminary_by, EXCLUDED.preliminary_by),
           metadata = EXCLUDED.metadata,
           updated_at = NOW()
         RETURNING *`,
        tenantId,
        requireIntId(caseId),
        targetStatus,
        cleanOptionalText(data.gross_text ?? data.grossText),
        cleanOptionalText(data.microscopic_text ?? data.microscopicText ?? data.microscopy),
        diagnosisText,
        JSON.stringify(safeJsonObject(data.synoptic_fields ?? data.synopticFields)),
        normalizeMalignancyFlag(data.malignancy_flag ?? data.malignancyFlag),
        optionalUuid(data.report_author_uid ?? data.reportAuthorUid ?? context.actorUid),
        JSON.stringify(safeJsonObject(data.metadata)),
      );
      const updated = await tx.$queryRawUnsafe(
        `UPDATE ap_cases
            SET status = 'reported', updated_at = NOW()
          WHERE id = $1::bigint AND tenant_id = $2::uuid
          RETURNING ${AP_CASE_RETURNING}`,
        requireIntId(caseId),
        tenantId,
      );
      await emitPathologyCanonicalEvent(tx, updated[0], targetStatus === 'preliminary' ? 'pathology.report_preliminary' : 'pathology.report_drafted', {
        sourceTable: 'ap_reports',
        sourceId: rows[0].id,
        actorUid: data.report_author_uid ?? data.reportAuthorUid ?? context.actorUid,
        actorRole: context.actorRole || null,
        beforeStatus: cases[0].status,
        afterStatus: 'reported',
        occurredAt: rows[0].updated_at || rows[0].created_at,
        summary: `Pathology report ${targetStatus} for case ${updated[0].case_number}`,
      });
      return normalizeWireValue(rows[0]);
    });
  }

  async signOffReport(reportId, data = {}, context = {}) {
    const tenantId = tenantOr(context.tenantId || context.tenant_id);
    return setTenantTx(tenantId, async (tx) => {
      const reports = await tx.$queryRawUnsafe(
        `SELECT r.*, c.case_number, c.patient_uid, c.encounter_id, c.case_kind, c.status AS case_status
           FROM ap_reports r
           JOIN ap_cases c ON c.id = r.ap_case_id AND c.tenant_id = r.tenant_id
          WHERE r.id = $1::bigint AND r.tenant_id = $2::uuid
          LIMIT 1`,
        requireIntId(reportId),
        tenantId,
      );
      if (reports.length === 0) throw AppError.notFound('Pathology report not found');
      const report = reports[0];
      if (report.signed_at) throw AppError.conflict('Pathology report is already signed');
      if (!cleanOptionalText(report.diagnosis_text)) {
        throw AppError.badRequest('Diagnosis text is required before sign-off', 'AP_DIAGNOSIS_REQUIRED');
      }
      transitionApReportStatus(report.report_status, 'final');
      const rows = await tx.$queryRawUnsafe(
        `UPDATE ap_reports
            SET report_status = 'final',
                signed_at = NOW(),
                signed_by = $3::uuid,
                updated_at = NOW()
          WHERE id = $1::bigint AND tenant_id = $2::uuid
          RETURNING *`,
        requireIntId(reportId),
        tenantId,
        optionalUuid(data.signed_by ?? data.signedBy ?? context.actorUid),
      );
      const updated = await tx.$queryRawUnsafe(
        `UPDATE ap_cases
            SET status = 'signed', updated_at = NOW()
          WHERE id = $1::bigint AND tenant_id = $2::uuid
          RETURNING ${AP_CASE_RETURNING}`,
        report.ap_case_id,
        tenantId,
      );
      await emitPathologyCanonicalEvent(tx, updated[0], 'pathology.report_signed_off', {
        sourceTable: 'ap_reports',
        sourceId: rows[0].id,
        actorUid: data.signed_by ?? data.signedBy ?? context.actorUid,
        actorRole: context.actorRole || null,
        beforeStatus: report.case_status,
        afterStatus: 'signed',
        occurredAt: rows[0].signed_at,
        summary: `Pathology report signed for case ${updated[0].case_number}`,
      });
      return normalizeWireValue(rows[0]);
    });
  }

  async appendAddendum(reportId, data, context = {}) {
    const tenantId = tenantOr(context.tenantId || context.tenant_id);
    const addendumText = cleanOptionalText(data.addendum_text ?? data.addendumText);
    if (!addendumText) throw AppError.badRequest('addendum_text is required');

    return setTenantTx(tenantId, async (tx) => {
      const reports = await tx.$queryRawUnsafe(
        `SELECT r.*, c.case_number, c.patient_uid, c.encounter_id, c.case_kind, c.status AS case_status
           FROM ap_reports r
           JOIN ap_cases c ON c.id = r.ap_case_id AND c.tenant_id = r.tenant_id
          WHERE r.id = $1::bigint AND r.tenant_id = $2::uuid
          LIMIT 1`,
        requireIntId(reportId),
        tenantId,
      );
      if (reports.length === 0) throw AppError.notFound('Pathology report not found');
      const report = reports[0];
      if (!report.signed_at) throw AppError.badRequest('Only signed pathology reports can receive addenda');
      transitionApReportStatus(report.report_status, 'amended');
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO ap_report_addenda
           (tenant_id, ap_report_id, addendum_text, addendum_by, metadata)
         VALUES ($1::uuid, $2::bigint, $3, $4::uuid, $5::jsonb)
         RETURNING *`,
        tenantId,
        requireIntId(reportId),
        addendumText,
        optionalUuid(data.addendum_by ?? data.addendumBy ?? context.actorUid),
        JSON.stringify(safeJsonObject(data.metadata)),
      );
      const updatedReports = await tx.$queryRawUnsafe(
        `UPDATE ap_reports
            SET report_status = 'amended', amended_at = $3::timestamptz, updated_at = NOW()
          WHERE id = $1::bigint AND tenant_id = $2::uuid
          RETURNING *`,
        requireIntId(reportId),
        tenantId,
        rows[0].addendum_at,
      );
      const updated = await tx.$queryRawUnsafe(
        `UPDATE ap_cases
            SET status = 'amended', updated_at = NOW()
          WHERE id = $1::bigint AND tenant_id = $2::uuid
          RETURNING ${AP_CASE_RETURNING}`,
        report.ap_case_id,
        tenantId,
      );
      await emitPathologyCanonicalEvent(tx, updated[0], 'pathology.report_addendum', {
        sourceTable: 'ap_report_addenda',
        sourceId: rows[0].id,
        actorUid: data.addendum_by ?? data.addendumBy ?? context.actorUid,
        actorRole: context.actorRole || null,
        beforeStatus: report.case_status,
        afterStatus: 'amended',
        occurredAt: rows[0].addendum_at,
        summary: `Pathology addendum appended for case ${updated[0].case_number}`,
      });
      return normalizeWireValue({ addendum: rows[0], report: updatedReports[0] });
    });
  }

  async getTatMetrics(filters = {}) {
    const tenantId = tenantOr(filters.tenantId || filters.tenant_id);
    const listQuery = parseListQuery(filters, {
      defaultLimit: 25,
      maxLimit: 100,
      defaultSortBy: 'accessioned_at',
      allowedSortFields: ['accessioned_at', 'elapsed_hours', 'priority', 'case_kind'],
    });
    const where = ['tenant_id = $1::uuid'];
    const params = [tenantId];
    if (filters.priority) {
      params.push(normalizePriority(filters.priority));
      where.push(`priority = $${params.length}`);
    }
    if (filters.case_kind || filters.caseKind) {
      params.push(normalizeCaseKind(filters.case_kind || filters.caseKind));
      where.push(`case_kind = $${params.length}`);
    }
    if (filters.breached != null && filters.breached !== '') {
      params.push(String(filters.breached).toLowerCase() === 'true');
      where.push(`breached = $${params.length}::boolean`);
    }
    const orderBy = {
      accessioned_at: 'accessioned_at',
      elapsed_hours: 'elapsed_hours',
      priority: 'priority',
      case_kind: 'case_kind',
    }[listQuery.sortBy] || 'accessioned_at';
    const sort = listQuery.sortOrder === 'ASC' ? 'ASC' : 'DESC';

    return setTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT *
           FROM ap_tat_metrics
          WHERE ${where.join(' AND ')}
          ORDER BY ${orderBy} ${sort}, ap_case_id DESC
          LIMIT $${params.length + 1}::int OFFSET $${params.length + 2}::int`,
        ...params,
        listQuery.limit,
        listQuery.offset,
      );
      const countRows = await tx.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count
           FROM ap_tat_metrics
          WHERE ${where.join(' AND ')}`,
        ...params,
      );
      return {
        metrics: normalizeWireValue(rows),
        pagination: buildPagination(Number(countRows[0]?.count || 0), listQuery.page, listQuery.limit),
      };
    }, { readOnly: true });
  }
}

export default new PathologyService();
