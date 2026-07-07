// src/services/quality/infectionControlWorkbenchService.js
//
// N6-6 infection-control depth: isolation orders, device-associated HAI
// rates, outbreak line lists, and hand-hygiene audits on top of the D5
// infection-control workbench.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { createBedCleaningRequest } from '../staff/housekeepingTaskDispatchService.js';

const PRECAUTION_TYPES = new Set(['standard', 'contact', 'droplet', 'airborne', 'protective', 'enteric']);
const ISOLATION_STATUSES = new Set(['active', 'discontinued', 'cancelled']);
const DEVICE_TYPES = new Set(['urinary_catheter', 'central_line', 'ventilator']);
const HAI_TYPES = new Set(['CAUTI', 'CLABSI', 'VAP', 'SSI', 'OTHER']);
const HAI_DENOMINATOR_DEVICE = {
  CAUTI: 'urinary_catheter',
  CLABSI: 'central_line',
  VAP: 'ventilator',
};
const OUTBREAK_STATUSES = new Set(['suspected', 'confirmed', 'closed']);
const OUTBREAK_CASE_STATUSES = new Set(['suspected', 'confirmed', 'ruled_out']);

function resolveTenantId(tenantId) {
  return requireTenantId(tenantId);
}

function requireActor(actorUid) {
  if (!actorUid) {
    throw AppError.forbidden('Authenticated staff user is required', 'IC_ACTOR_REQUIRED');
  }
  return actorUid;
}

function cleanText(value, max = 2000) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, max);
}

function parsePositiveInt(value, field) {
  if (value == null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${field} must be a positive integer`, 'IC_INVALID_ID');
  }
  return parsed;
}

function normalizePrecautionType(value) {
  const normalized = cleanText(value, 30)?.toLowerCase();
  if (!normalized || !PRECAUTION_TYPES.has(normalized)) {
    throw AppError.badRequest('precaution_type is invalid', 'IC_INVALID_PRECAUTION');
  }
  return normalized;
}

function normalizeDeviceType(value, { optional = false } = {}) {
  if (value == null || value === '') {
    if (optional) return null;
    throw AppError.badRequest('device_type is required', 'IC_DEVICE_REQUIRED');
  }
  const normalized = cleanText(value, 40)?.toLowerCase();
  if (!DEVICE_TYPES.has(normalized)) {
    throw AppError.badRequest('device_type is invalid', 'IC_INVALID_DEVICE');
  }
  return normalized;
}

function normalizeHaiType(value) {
  const normalized = cleanText(value, 20)?.toUpperCase();
  if (!normalized || !HAI_TYPES.has(normalized)) {
    throw AppError.badRequest('hai_type is invalid', 'IC_INVALID_HAI_TYPE');
  }
  return normalized;
}

function normalizeOutbreakStatus(value, fallback = 'suspected') {
  const normalized = cleanText(value || fallback, 30)?.toLowerCase();
  if (!OUTBREAK_STATUSES.has(normalized)) {
    throw AppError.badRequest('outbreak status is invalid', 'IC_INVALID_OUTBREAK_STATUS');
  }
  return normalized;
}

function normalizeOutbreakCaseStatus(value, fallback = 'suspected') {
  const normalized = cleanText(value || fallback, 30)?.toLowerCase();
  if (!OUTBREAK_CASE_STATUSES.has(normalized)) {
    throw AppError.badRequest('outbreak case status is invalid', 'IC_INVALID_OUTBREAK_CASE_STATUS');
  }
  return normalized;
}

function assertDate(value, field) {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw AppError.badRequest(`${field} is required`, 'IC_DATE_REQUIRED');
  }
  return value;
}

function json(value) {
  return JSON.stringify(value ?? {});
}

function idText(value) {
  return value == null ? null : String(value);
}

function ratePer1000(numerator, denominator) {
  const n = Number(numerator) || 0;
  const d = Number(denominator) || 0;
  return d > 0 ? Number(((n / d) * 1000).toFixed(2)) : null;
}

function parseCount(value, field) {
  const parsed = Number.parseInt(value ?? 0, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw AppError.badRequest(`${field} must be a non-negative integer`, 'IC_INVALID_COUNT');
  }
  return parsed;
}

function precautionChecklist(precautionType) {
  const common = [
    { item_key: 'door_signage', label: 'Isolation signage placed at room entrance' },
    { item_key: 'ppe_station', label: 'PPE station stocked at point of care' },
    { item_key: 'staff_briefed', label: 'Care team briefed on current precautions' },
  ];
  const extra = {
    contact: [
      { item_key: 'dedicated_equipment', label: 'Dedicated or disinfected patient equipment available' },
      { item_key: 'terminal_clean_plan', label: 'Terminal clean plan documented for discharge/transfer' },
    ],
    droplet: [
      { item_key: 'mask_protocol', label: 'Surgical-mask protocol communicated' },
      { item_key: 'visitor_controls', label: 'Visitor controls documented' },
    ],
    airborne: [
      { item_key: 'airborne_room_verified', label: 'Airborne isolation room/ventilation verified' },
      { item_key: 'n95_fit_check', label: 'N95/respirator fit-check guidance posted' },
      { item_key: 'transport_masking', label: 'Transport masking plan documented' },
    ],
    protective: [
      { item_key: 'positive_pressure_review', label: 'Protective environment reviewed' },
      { item_key: 'neutropenic_precautions', label: 'Protective/neutropenic precautions documented' },
    ],
    enteric: [
      { item_key: 'soap_water_protocol', label: 'Soap-and-water hand hygiene protocol posted' },
      { item_key: 'bleach_cleaning', label: 'Sporicidal/bleach cleaning plan documented' },
    ],
    standard: [],
  };
  return [...common, ...(extra[precautionType] || [])];
}

export function computeHandHygieneCompliance(moments = []) {
  const totals = moments.reduce((acc, item) => {
    const opportunities = Number(item.opportunity_count ?? item.opportunities ?? item.total_moments ?? 0) || 0;
    const compliant = Number(item.compliant_count ?? item.compliant ?? item.compliant_moments ?? 0) || 0;
    return {
      total_moments: acc.total_moments + opportunities,
      compliant_moments: acc.compliant_moments + compliant,
    };
  }, { total_moments: 0, compliant_moments: 0 });
  return {
    ...totals,
    compliance_pct: totals.total_moments
      ? Number(((totals.compliant_moments / totals.total_moments) * 100).toFixed(2))
      : null,
  };
}

export function computeDeviceDaysFromIntervals(rows = [], { from, to } = {}) {
  assertDate(from, 'from');
  assertDate(to, 'to');
  const start = new Date(from);
  const end = new Date(new Date(to).getTime() + 24 * 60 * 60 * 1000);
  const byDevice = {};
  for (const row of rows) {
    const deviceType = row.device_type || 'unknown';
    const rowStart = new Date(row.started_at);
    const rowEnd = row.stopped_at ? new Date(row.stopped_at) : end;
    const overlapStart = rowStart > start ? rowStart : start;
    const overlapEnd = rowEnd < end ? rowEnd : end;
    const days = Math.max(0, (overlapEnd.getTime() - overlapStart.getTime()) / 86400000);
    if (!byDevice[deviceType]) byDevice[deviceType] = 0;
    byDevice[deviceType] += days;
  }
  const rounded = Object.fromEntries(
    Object.entries(byDevice).map(([deviceType, days]) => [deviceType, Number(days.toFixed(2))]),
  );
  const total = Object.values(rounded).reduce((sum, value) => sum + Number(value), 0);
  return { total_device_days: Number(total.toFixed(2)), by_device_type: rounded };
}

export function groupOutbreakClusterRows(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const organism = cleanText(row.organism || row.organism_name, 255);
    if (!organism) continue;
    const ward = cleanText(row.ward, 255) || 'unassigned';
    const key = `${organism.toLowerCase()}|${ward.toLowerCase()}`;
    if (!groups.has(key)) {
      groups.set(key, {
        organism,
        ward,
        case_count: 0,
        patient_count: 0,
        first_detection_date: null,
        last_detection_date: null,
        cases: [],
        patientUids: new Set(),
      });
    }
    const group = groups.get(key);
    group.case_count += 1;
    if (row.patient_uid) group.patientUids.add(String(row.patient_uid));
    const detected = row.detection_date || row.detected_at || null;
    if (detected) {
      const detectedText = new Date(detected).toISOString();
      if (!group.first_detection_date || detectedText < group.first_detection_date) {
        group.first_detection_date = detectedText;
      }
      if (!group.last_detection_date || detectedText > group.last_detection_date) {
        group.last_detection_date = detectedText;
      }
    }
    group.cases.push({
      infection_case_id: row.infection_case_id ?? row.id ?? null,
      patient_uid: row.patient_uid || null,
      patient_name: row.patient_name || null,
      admission_id: row.admission_id ?? null,
      detection_date: detected,
      infection_site: row.infection_site || null,
    });
  }
  return [...groups.values()]
    .map((group) => ({
      organism: group.organism,
      ward: group.ward,
      case_count: group.case_count,
      patient_count: group.patientUids.size,
      first_detection_date: group.first_detection_date,
      last_detection_date: group.last_detection_date,
      cases: group.cases,
    }))
    .filter((group) => group.case_count >= 2)
    .sort((a, b) => b.case_count - a.case_count || String(a.organism).localeCompare(String(b.organism)));
}

async function loadAdmission(db, { admissionId = null, patientUid = null, tenantId }) {
  if (admissionId) {
    const rows = await db.$queryRawUnsafe(
      `SELECT id, tenant_id, patient_uid, encounter_id, bed_id, ward, bed_number,
              status, admitted_at, discharged_at
         FROM admissions
        WHERE id = $1::int AND tenant_id = $2::uuid
          AND ($3::uuid IS NULL OR patient_uid = $3::uuid)
        LIMIT 1`,
      admissionId, tenantId, patientUid,
    );
    return rows[0] || null;
  }
  if (!patientUid) return null;
  const rows = await db.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, encounter_id, bed_id, ward, bed_number,
            status, admitted_at, discharged_at
       FROM admissions
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND COALESCE(status, 'admitted') NOT IN ('discharged', 'cancelled')
      ORDER BY admitted_at DESC, id DESC
      LIMIT 1`,
    tenantId, patientUid,
  );
  return rows[0] || null;
}

async function loadInfectionCase(db, { infectionCaseId, tenantId }) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, organism, infection_site,
            detection_date, status
       FROM infection_cases
      WHERE id = $1::int AND tenant_id = $2::uuid
      LIMIT 1`,
    infectionCaseId, tenantId,
  );
  return rows[0] || null;
}

/** Active isolation board: infection cases plus explicit isolation orders. */
export async function isolationBoard({ ward = null, tenantId = null } = {}) {
  const tid = resolveTenantId(tenantId);
  const params = [tid];
  let wardFilter = '';
  if (ward) {
    params.push(ward);
    wardFilter = `AND a.ward = $${params.length}`;
  }
  return prisma.$queryRawUnsafe(
    `SELECT *
       FROM (
        SELECT 'infection_case' AS source,
               ic.id::text AS infection_case_id,
               NULL::text AS isolation_order_id,
               ic.patient_uid,
               u.name AS patient_name,
               ic.organism,
               ic.infection_site,
               ic.isolation_required,
               ic.isolation_type,
               ic.detection_date::timestamptz AS detection_date,
               ic.status AS case_status,
               a.id AS admission_id,
               a.ward,
               a.bed_number,
               a.status AS admission_status,
               NULL::text AS reason,
               '[]'::jsonb AS checklist
          FROM infection_cases ic
          JOIN users u ON u.uid = ic.patient_uid
          LEFT JOIN admissions a ON a.patient_uid = ic.patient_uid
               AND a.tenant_id = $1::uuid
               AND COALESCE(a.status, 'admitted') NOT IN ('discharged', 'cancelled')
         WHERE ic.tenant_id = $1::uuid
           AND COALESCE(ic.status, 'active') NOT IN ('resolved', 'closed')
           ${wardFilter}
        UNION ALL
        SELECT 'isolation_order' AS source,
               io.infection_case_id::text AS infection_case_id,
               io.id::text AS isolation_order_id,
               io.patient_uid,
               u.name AS patient_name,
               ic.organism,
               ic.infection_site,
               TRUE AS isolation_required,
               io.precaution_type AS isolation_type,
               io.ordered_at AS detection_date,
               io.status AS case_status,
               COALESCE(io.admission_id, a.id) AS admission_id,
               COALESCE(a.ward, ad.ward) AS ward,
               COALESCE(a.bed_number, ad.bed_number) AS bed_number,
               COALESCE(a.status, ad.status) AS admission_status,
               io.reason,
               io.checklist
          FROM isolation_orders io
          JOIN users u ON u.uid = io.patient_uid
          LEFT JOIN infection_cases ic ON ic.id = io.infection_case_id AND ic.tenant_id = io.tenant_id
          LEFT JOIN admissions a ON a.id = io.admission_id AND a.tenant_id = io.tenant_id
          LEFT JOIN LATERAL (
            SELECT id, ward, bed_number, status
              FROM admissions
             WHERE tenant_id = io.tenant_id
               AND patient_uid = io.patient_uid
               AND COALESCE(status, 'admitted') NOT IN ('discharged', 'cancelled')
             ORDER BY admitted_at DESC, id DESC
             LIMIT 1
          ) ad ON TRUE
         WHERE io.tenant_id = $1::uuid
           AND io.status = 'active'
           ${wardFilter}
       ) board
      ORDER BY isolation_required DESC, detection_date DESC NULLS LAST
      LIMIT 300`,
    ...params,
  );
}

export async function createIsolationOrder(data = {}, context = {}) {
  const tenantId = resolveTenantId(context.tenantId || data.tenant_id || data.tenantId);
  const actorUid = requireActor(context.actorUid || data.actorUid || data.ordered_by);
  const actorRole = cleanText(context.actorRole || data.actorRole || data.actor_role, 80);
  const infectionCaseId = parsePositiveInt(data.infection_case_id || data.infectionCaseId, 'infection_case_id');
  const admissionId = parsePositiveInt(data.admission_id || data.admissionId, 'admission_id');
  const precautionType = normalizePrecautionType(data.precaution_type || data.precautionType);
  const reason = cleanText(data.reason, 2000);
  const metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
  const checklist = precautionChecklist(precautionType);

  return setTenantTx(tenantId, async (tx) => {
    let patientUid = data.patient_uid || data.patientUid || null;
    let infectionCase = null;
    if (infectionCaseId) {
      infectionCase = await loadInfectionCase(tx, { infectionCaseId, tenantId });
      if (!infectionCase) throw AppError.notFound('Infection case not found', 'IC_CASE_NOT_FOUND');
      patientUid = patientUid || infectionCase.patient_uid;
    }
    if (!patientUid) {
      throw AppError.badRequest('patient_uid is required', 'IC_PATIENT_REQUIRED');
    }
    const admission = await loadAdmission(tx, { admissionId, patientUid, tenantId });
    if (admissionId && !admission) {
      throw AppError.notFound('Admission not found for patient/tenant', 'IC_ADMISSION_NOT_FOUND');
    }
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO isolation_orders
         (tenant_id, patient_uid, admission_id, infection_case_id, precaution_type,
          reason, ordered_by, checklist, metadata)
       VALUES ($1::uuid, $2::uuid, $3::int, $4::int, $5, $6, $7::uuid, $8::jsonb, $9::jsonb)
       RETURNING id::text, tenant_id, patient_uid, admission_id, infection_case_id,
                 precaution_type, status, reason, ordered_by, ordered_at,
                 terminal_clean_requested_at, terminal_clean_request_id, checklist,
                 metadata, created_at, updated_at`,
      tenantId,
      patientUid,
      admission?.id || null,
      infectionCaseId,
      precautionType,
      reason,
      actorUid,
      json(checklist),
      json(metadata),
    );
    const order = rows[0];
    for (const item of checklist) {
      await tx.$executeRawUnsafe(
        `INSERT INTO isolation_order_checklist_items
           (tenant_id, isolation_order_id, item_key, label)
         VALUES ($1::uuid, $2::bigint, $3, $4)
         ON CONFLICT (tenant_id, isolation_order_id, item_key) DO NOTHING`,
        tenantId, order.id, item.item_key, item.label,
      );
    }
    const items = await tx.$queryRawUnsafe(
      `SELECT id::text, item_key, label, status, completed_by, completed_at, notes
         FROM isolation_order_checklist_items
        WHERE tenant_id = $1::uuid AND isolation_order_id = $2::bigint
        ORDER BY id`,
      tenantId, order.id,
    );
    await recordCanonicalClinicalEvent({
      tenantId,
      patientUid,
      encounterId: admission?.encounter_id || null,
      eventType: 'infection_control.isolation_ordered',
      eventStatus: 'active',
      sourceTable: 'isolation_orders',
      sourceId: order.id,
      resourceType: 'isolation_order',
      resourceId: order.id,
      actorUid,
      actorRole,
      visibleToPatient: false,
      summary: `${precautionType} isolation ordered`,
      payload: {
        precaution_type: precautionType,
        admission_id: admission?.id || null,
        infection_case_id: infectionCaseId,
        reason,
      },
      tags: ['infection_control', 'isolation'],
      timelineIdempotencyKey: `isolation_orders:${order.id}:ordered`,
      auditIdempotencyKey: `isolation_orders:${order.id}:audit:ordered`,
    }, { db: tx });
    return { ...order, checklist_items: items };
  });
}

export async function listIsolationOrders({
  status = null,
  patientUid = null,
  admissionId = null,
  tenantId = null,
} = {}) {
  const tid = resolveTenantId(tenantId);
  const params = [tid];
  const filters = ['io.tenant_id = $1::uuid'];
  if (status) {
    const normalized = cleanText(status, 30)?.toLowerCase();
    if (!ISOLATION_STATUSES.has(normalized)) {
      throw AppError.badRequest('status is invalid', 'IC_INVALID_STATUS');
    }
    params.push(normalized);
    filters.push(`io.status = $${params.length}`);
  }
  if (patientUid) {
    params.push(patientUid);
    filters.push(`io.patient_uid = $${params.length}::uuid`);
  }
  const parsedAdmissionId = parsePositiveInt(admissionId, 'admission_id');
  if (parsedAdmissionId) {
    params.push(parsedAdmissionId);
    filters.push(`io.admission_id = $${params.length}::int`);
  }
  return prisma.$queryRawUnsafe(
    `SELECT io.id::text, io.tenant_id, io.patient_uid, u.name AS patient_name,
            io.admission_id, io.infection_case_id, io.precaution_type, io.status,
            io.reason, io.ordered_by, io.ordered_at, io.discontinued_by,
            io.discontinued_at, io.terminal_clean_requested_at,
            io.terminal_clean_request_id, io.checklist, io.metadata,
            a.ward, a.bed_number
       FROM isolation_orders io
       JOIN users u ON u.uid = io.patient_uid
       LEFT JOIN admissions a ON a.id = io.admission_id AND a.tenant_id = io.tenant_id
      WHERE ${filters.join(' AND ')}
      ORDER BY io.ordered_at DESC, io.id DESC
      LIMIT 300`,
    ...params,
  );
}

export async function requestIsolationTerminalClean({
  isolationOrderId,
  tenantId = null,
  actorUid = null,
  actorRole = null,
} = {}) {
  const tid = resolveTenantId(tenantId);
  const actor = requireActor(actorUid);
  const orderId = parsePositiveInt(isolationOrderId, 'isolation_order_id');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT io.id::text, io.tenant_id, io.patient_uid, io.admission_id,
            io.precaution_type, io.status, io.terminal_clean_request_id,
            a.encounter_id, a.bed_id, a.ward, a.bed_number
       FROM isolation_orders io
       LEFT JOIN admissions a ON a.id = io.admission_id AND a.tenant_id = io.tenant_id
      WHERE io.id = $1::bigint AND io.tenant_id = $2::uuid
      LIMIT 1`,
    orderId, tid,
  );
  const order = rows[0];
  if (!order) throw AppError.notFound('Isolation order not found', 'IC_ORDER_NOT_FOUND');
  if (order.status !== 'active') {
    throw AppError.conflict('Only active isolation orders can request terminal cleaning', 'IC_ORDER_NOT_ACTIVE');
  }
  if (!order.bed_id) {
    throw AppError.conflict('Isolation order has no admitted bed for terminal cleaning', 'IC_ORDER_NO_BED');
  }

  const bedLabel = [order.ward, order.bed_number].filter(Boolean).join(' / ') || `Bed ${order.bed_id}`;
  const dispatch = await createBedCleaningRequest({
    bedId: order.bed_id,
    requesterUid: actor,
    trigger: 'isolation_terminal_clean',
    urgency: 'urgent',
    description: `Isolation terminal clean required for ${bedLabel} after ${order.precaution_type} isolation order #${order.id}. bed_id=${order.bed_id}.`,
  });
  const requestId = dispatch?.request?.id || order.terminal_clean_request_id || null;

  const updated = await setTenantTx(tid, async (tx) => {
    const updateRows = await tx.$queryRawUnsafe(
      `UPDATE isolation_orders
          SET terminal_clean_requested_at = COALESCE(terminal_clean_requested_at, NOW()),
              terminal_clean_request_id = COALESCE($3::int, terminal_clean_request_id),
              metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::bigint
        RETURNING id::text, tenant_id, patient_uid, admission_id, precaution_type,
                  status, terminal_clean_requested_at, terminal_clean_request_id,
                  metadata, updated_at`,
      tid,
      orderId,
      requestId,
      json({ terminal_clean_trigger: 'infection_control', housekeeping_created: dispatch?.created === true }),
    );
    const row = updateRows[0];
    await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: order.patient_uid,
      encounterId: order.encounter_id || null,
      eventType: 'infection_control.terminal_clean_requested',
      eventStatus: 'requested',
      sourceTable: 'isolation_orders',
      sourceId: row.id,
      resourceType: 'housekeeping_requests',
      resourceId: idText(requestId),
      actorUid: actor,
      actorRole: cleanText(actorRole, 80),
      visibleToPatient: false,
      summary: 'Isolation terminal clean requested',
      payload: { isolation_order_id: row.id, housekeeping_request_id: requestId },
      tags: ['infection_control', 'isolation', 'housekeeping'],
      timelineIdempotencyKey: `isolation_orders:${row.id}:terminal-clean`,
      auditIdempotencyKey: `isolation_orders:${row.id}:audit:terminal-clean`,
    }, { db: tx });
    return row;
  });

  return { isolation_order: updated, housekeeping: dispatch };
}

export async function updateIsolationChecklistItem({
  orderId,
  itemKey,
  status,
  notes = null,
  tenantId = null,
  actorUid = null,
} = {}) {
  const tid = resolveTenantId(tenantId);
  const actor = requireActor(actorUid);
  const parsedOrderId = parsePositiveInt(orderId, 'isolation_order_id');
  const normalizedStatus = cleanText(status, 20)?.toLowerCase();
  if (!['pending', 'complete', 'not_applicable'].includes(normalizedStatus)) {
    throw AppError.badRequest('status is invalid', 'IC_INVALID_CHECKLIST_STATUS');
  }
  const cleanKey = cleanText(itemKey, 80);
  if (!cleanKey) throw AppError.badRequest('itemKey is required', 'IC_CHECKLIST_ITEM_REQUIRED');
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE isolation_order_checklist_items
          SET status = $4,
              notes = $5,
              completed_by = CASE WHEN $4 = 'complete' THEN $6::uuid ELSE completed_by END,
              completed_at = CASE WHEN $4 = 'complete' THEN COALESCE(completed_at, NOW()) ELSE completed_at END,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND isolation_order_id = $2::bigint
          AND item_key = $3
        RETURNING id::text, isolation_order_id::text, item_key, label, status,
                  completed_by, completed_at, notes, updated_at`,
      tid, parsedOrderId, cleanKey, normalizedStatus, cleanText(notes, 2000), actor,
    );
    if (!rows[0]) throw AppError.notFound('Isolation checklist item not found', 'IC_CHECKLIST_ITEM_NOT_FOUND');
    return rows[0];
  });
}

export async function discontinueIsolationOrder({
  orderId,
  tenantId = null,
  actorUid = null,
  actorRole = null,
} = {}) {
  const tid = resolveTenantId(tenantId);
  const actor = requireActor(actorUid);
  const parsedOrderId = parsePositiveInt(orderId, 'isolation_order_id');
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `WITH updated AS (
         UPDATE isolation_orders
            SET status = 'discontinued',
                discontinued_by = $3::uuid,
                discontinued_at = COALESCE(discontinued_at, NOW()),
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint
            AND status = 'active'
          RETURNING id::text, tenant_id, patient_uid, admission_id, precaution_type,
                    status, discontinued_by, discontinued_at, updated_at
       )
       SELECT updated.*, a.encounter_id
         FROM updated
         LEFT JOIN admissions a ON a.id = updated.admission_id AND a.tenant_id = updated.tenant_id`,
      tid, parsedOrderId, actor,
    );
    const order = rows[0];
    if (!order) throw AppError.notFound('Active isolation order not found', 'IC_ORDER_NOT_FOUND');
    await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: order.patient_uid,
      encounterId: order.encounter_id || null,
      eventType: 'infection_control.isolation_discontinued',
      eventStatus: 'discontinued',
      sourceTable: 'isolation_orders',
      sourceId: order.id,
      resourceType: 'isolation_order',
      resourceId: order.id,
      actorUid: actor,
      actorRole: cleanText(actorRole, 80),
      visibleToPatient: false,
      summary: `${order.precaution_type} isolation discontinued`,
      payload: { admission_id: order.admission_id, precaution_type: order.precaution_type },
      tags: ['infection_control', 'isolation'],
      timelineIdempotencyKey: `isolation_orders:${order.id}:discontinued`,
      auditIdempotencyKey: `isolation_orders:${order.id}:audit:discontinued`,
    }, { db: tx });
    return order;
  });
}

export async function createDevicePresenceLog(data = {}, context = {}) {
  const tenantId = resolveTenantId(context.tenantId || data.tenant_id || data.tenantId);
  const actorUid = context.actorUid || data.actorUid || data.inserted_by || data.removed_by || null;
  const admissionId = parsePositiveInt(data.admission_id || data.admissionId, 'admission_id');
  if (!admissionId) throw AppError.badRequest('admission_id is required', 'IC_ADMISSION_REQUIRED');
  const deviceType = normalizeDeviceType(data.device_type || data.deviceType);
  const startedAt = assertDate(data.started_at || data.startedAt, 'started_at');
  const stoppedAt = data.stopped_at || data.stoppedAt || null;
  if (stoppedAt && new Date(stoppedAt) < new Date(startedAt)) {
    throw AppError.badRequest('stopped_at must be >= started_at', 'IC_INVALID_DEVICE_INTERVAL');
  }
  return setTenantTx(tenantId, async (tx) => {
    const admission = await loadAdmission(tx, { admissionId, tenantId, patientUid: data.patient_uid || data.patientUid || null });
    if (!admission) throw AppError.notFound('Admission not found', 'IC_ADMISSION_NOT_FOUND');
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO device_presence_logs
         (tenant_id, admission_id, patient_uid, device_type, device_label,
          started_at, stopped_at, inserted_by, removed_by, notes)
       VALUES ($1::uuid, $2::int, $3::uuid, $4, $5, $6::timestamptz,
               $7::timestamptz, $8::uuid, $9::uuid, $10)
       RETURNING id::text, tenant_id, admission_id, patient_uid, device_type,
                 device_label, started_at, stopped_at, inserted_by, removed_by,
                 notes, created_at, updated_at`,
      tenantId,
      admission.id,
      admission.patient_uid,
      deviceType,
      cleanText(data.device_label || data.deviceLabel, 120),
      startedAt,
      stoppedAt,
      data.inserted_by || actorUid,
      data.removed_by || null,
      cleanText(data.notes, 2000),
    );
    return rows[0];
  });
}

export const logDevicePresence = createDevicePresenceLog;

export async function stopDevicePresence({
  id,
  stoppedAt = null,
  tenantId = null,
  actorUid = null,
} = {}) {
  const tid = resolveTenantId(tenantId);
  const actor = requireActor(actorUid);
  const deviceId = parsePositiveInt(id, 'device_presence_id');
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE device_presence_logs
          SET stopped_at = COALESCE($3::timestamptz, NOW()),
              removed_by = $4::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
          AND stopped_at IS NULL
        RETURNING id::text, tenant_id, admission_id, patient_uid, device_type,
                  device_label, started_at, stopped_at, inserted_by, removed_by,
                  notes, created_at, updated_at`,
      tid, deviceId, stoppedAt, actor,
    );
    if (!rows[0]) throw AppError.notFound('Active device presence log not found', 'IC_DEVICE_NOT_FOUND');
    return rows[0];
  });
}

export async function createHaiCase(data = {}, context = {}) {
  const tenantId = resolveTenantId(context.tenantId || data.tenant_id || data.tenantId);
  const actorUid = requireActor(context.actorUid || data.actorUid || data.attributed_by);
  const actorRole = cleanText(context.actorRole || data.actorRole || data.actor_role, 80);
  const infectionCaseId = parsePositiveInt(data.infection_case_id || data.infectionCaseId, 'infection_case_id');
  if (!infectionCaseId) throw AppError.badRequest('infection_case_id is required', 'IC_CASE_REQUIRED');
  const haiType = normalizeHaiType(data.hai_type || data.haiType);
  const deviceType = normalizeDeviceType(data.device_type || data.deviceType || HAI_DENOMINATOR_DEVICE[haiType], {
    optional: haiType === 'SSI' || haiType === 'OTHER',
  });
  return setTenantTx(tenantId, async (tx) => {
    const infectionCase = await loadInfectionCase(tx, { infectionCaseId, tenantId });
    if (!infectionCase) throw AppError.notFound('Infection case not found', 'IC_CASE_NOT_FOUND');
    const admissionId = parsePositiveInt(data.admission_id || data.admissionId || infectionCase.admission_id, 'admission_id');
    const admission = await loadAdmission(tx, {
      admissionId,
      patientUid: infectionCase.patient_uid,
      tenantId,
    });
    if (!admission) throw AppError.notFound('Admission not found for infection case', 'IC_ADMISSION_NOT_FOUND');
    const onsetDate = data.onset_date || data.onsetDate || infectionCase.detection_date;
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO hai_cases
         (tenant_id, infection_case_id, admission_id, patient_uid, hai_type,
          device_type, onset_date, numerator_count, denominator_snapshot,
          attributed_by, notes)
       VALUES ($1::uuid, $2::int, $3::int, $4::uuid, $5, $6, $7::date,
               $8::int, $9::jsonb, $10::uuid, $11)
       ON CONFLICT (tenant_id, infection_case_id, hai_type)
       DO UPDATE SET admission_id = EXCLUDED.admission_id,
                     patient_uid = EXCLUDED.patient_uid,
                     device_type = EXCLUDED.device_type,
                     onset_date = EXCLUDED.onset_date,
                     numerator_count = EXCLUDED.numerator_count,
                     denominator_snapshot = EXCLUDED.denominator_snapshot,
                     attributed_by = EXCLUDED.attributed_by,
                     notes = EXCLUDED.notes,
                     updated_at = NOW()
       RETURNING id::text, tenant_id, infection_case_id, admission_id, patient_uid,
                 hai_type, device_type, onset_date, numerator_count,
                 denominator_snapshot, attributed_by, notes, created_at, updated_at`,
      tenantId,
      infectionCaseId,
      admission.id,
      infectionCase.patient_uid,
      haiType,
      deviceType,
      onsetDate,
      parseCount(data.numerator_count || data.numeratorCount || 1, 'numerator_count'),
      json(data.denominator_snapshot || {
        device_type: deviceType,
        source: 'device_presence_logs',
      }),
      actorUid,
      cleanText(data.notes, 2000),
    );
    const haiCase = rows[0];
    await recordCanonicalClinicalEvent({
      tenantId,
      patientUid: infectionCase.patient_uid,
      encounterId: admission.encounter_id || null,
      eventType: 'infection_control.hai_case_attributed',
      eventStatus: 'active',
      sourceTable: 'hai_cases',
      sourceId: haiCase.id,
      resourceType: 'hai_case',
      resourceId: haiCase.id,
      actorUid,
      actorRole,
      visibleToPatient: false,
      summary: `${haiType} attributed for surveillance`,
      payload: {
        infection_case_id: infectionCaseId,
        admission_id: admission.id,
        hai_type: haiType,
        device_type: deviceType,
      },
      tags: ['infection_control', 'hai'],
      timelineIdempotencyKey: `hai_cases:${haiCase.id}:attributed`,
      auditIdempotencyKey: `hai_cases:${haiCase.id}:audit:attributed`,
    }, { db: tx });
    return haiCase;
  });
}

export async function haiRates({ from, to, tenantId = null } = {}) {
  const tid = resolveTenantId(tenantId);
  assertDate(from, 'from');
  assertDate(to, 'to');
  const rows = await prisma.$queryRawUnsafe(
    `WITH hai_counts AS (
       SELECT hai_type,
              COALESCE(device_type,
                CASE hai_type
                  WHEN 'CAUTI' THEN 'urinary_catheter'
                  WHEN 'CLABSI' THEN 'central_line'
                  WHEN 'VAP' THEN 'ventilator'
                  ELSE NULL
                END) AS denominator_device_type,
              SUM(numerator_count)::int AS numerator
         FROM hai_cases
        WHERE tenant_id = $1::uuid
          AND onset_date >= $2::date
          AND onset_date <= $3::date
        GROUP BY hai_type, denominator_device_type
     ),
     device_days AS (
       SELECT device_type,
              COALESCE(SUM(
                GREATEST(0, EXTRACT(EPOCH FROM (
                  LEAST(COALESCE(stopped_at, ($3::date + 1)::timestamptz), ($3::date + 1)::timestamptz)
                  - GREATEST(started_at, $2::date::timestamptz)
                )) / 86400)
              ), 0)::numeric(14,2) AS device_days
         FROM device_presence_logs
        WHERE tenant_id = $1::uuid
          AND started_at < ($3::date + 1)
          AND COALESCE(stopped_at, ($3::date + 1)::timestamptz) >= $2::date
        GROUP BY device_type
     )
     SELECT hc.hai_type,
            hc.denominator_device_type AS device_type,
            hc.numerator,
            COALESCE(dd.device_days, 0)::numeric(14,2) AS device_days
       FROM hai_counts hc
       LEFT JOIN device_days dd ON dd.device_type = hc.denominator_device_type
      ORDER BY hc.hai_type`,
    tid, from, to,
  );
  const rates = rows.map((row) => {
    const numerator = Number(row.numerator) || 0;
    const deviceDays = Number(row.device_days) || 0;
    return {
      hai_type: row.hai_type,
      device_type: row.device_type,
      numerator,
      device_days: deviceDays,
      rate_per_1000_device_days: ratePer1000(numerator, deviceDays),
    };
  });
  return {
    period: { from, to },
    rates,
    totals: {
      numerator: rates.reduce((sum, row) => sum + row.numerator, 0),
      device_days: Number(rates.reduce((sum, row) => sum + row.device_days, 0).toFixed(2)),
    },
  };
}

export const calculateHaiRates = haiRates;

export async function snapshotHaiRates({ from, to, computedBy = null, tenantId = null } = {}) {
  const tid = resolveTenantId(tenantId);
  const pack = await haiRates({ from, to, tenantId: tid });
  const numerator = pack.totals.numerator;
  const denominator = pack.totals.device_days;
  const value = ratePer1000(numerator, denominator);
  await setTenantTx(tid, async (tx) => {
    await tx.$queryRawUnsafe(
      `INSERT INTO nabh_indicator_snapshots
         (tenant_id, period_start, period_end, indicator_code, label, value,
          numerator, denominator, unit, details, computed_by)
       VALUES ($1::uuid, $2::date, $3::date, 'hai_device_rate_per_1000_device_days',
               'Device-associated HAI cases per 1000 device-days', $4, $5, $6,
               'per 1000 device-days', $7::jsonb, $8::uuid)
       ON CONFLICT (tenant_id, period_start, period_end, indicator_code)
       DO UPDATE SET value = EXCLUDED.value,
                     numerator = EXCLUDED.numerator,
                     denominator = EXCLUDED.denominator,
                     details = EXCLUDED.details,
                     computed_by = EXCLUDED.computed_by,
                     computed_at = NOW()`,
      tid,
      from,
      to,
      value,
      numerator,
      denominator,
      json({ source: 'infection_control_workbench', rates: pack.rates }),
      computedBy,
    );
  });
  return { ...pack, snapshot_saved: 1, snapshot_indicator_code: 'hai_device_rate_per_1000_device_days' };
}

export async function createOutbreakEpisode(data = {}, context = {}) {
  const tenantId = resolveTenantId(context.tenantId || data.tenant_id || data.tenantId);
  const actorUid = requireActor(context.actorUid || data.actorUid || data.opened_by);
  const episodeCode = cleanText(data.episode_code || data.episodeCode, 60);
  if (!episodeCode) throw AppError.badRequest('episode_code is required', 'IC_EPISODE_CODE_REQUIRED');
  const organism = cleanText(data.organism, 255);
  if (!organism) throw AppError.badRequest('organism is required', 'IC_ORGANISM_REQUIRED');
  const status = normalizeOutbreakStatus(data.status);
  return setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO outbreak_episodes
         (tenant_id, episode_code, organism, ward, status, suspected_at,
          confirmed_at, opened_by, line_list_notes, cluster_rule)
       VALUES ($1::uuid, $2::varchar(60), $3::varchar(255), $4::varchar(255),
               $5::varchar(30), COALESCE($6::timestamptz, NOW()),
               CASE WHEN $5::text = 'confirmed' THEN COALESCE($7::timestamptz, NOW()) ELSE $7::timestamptz END,
               $8::uuid, $9::text, $10::jsonb)
       RETURNING id::text, tenant_id, episode_code, organism, ward, status,
                 suspected_at, confirmed_at, closed_at, opened_by, closed_by,
                 line_list_notes, cluster_rule, created_at, updated_at`,
      tenantId,
      episodeCode,
      organism,
      cleanText(data.ward, 255),
      status,
      data.suspected_at || data.suspectedAt || null,
      data.confirmed_at || data.confirmedAt || null,
      actorUid,
      cleanText(data.line_list_notes || data.lineListNotes, 2000),
      json(data.cluster_rule || data.clusterRule || {}),
    );
    return rows[0];
  });
}

export async function linkOutbreakCase(data = {}, context = {}) {
  const tenantId = resolveTenantId(context.tenantId || data.tenant_id || data.tenantId);
  const actorUid = requireActor(context.actorUid || data.actorUid || data.linked_by);
  const actorRole = cleanText(context.actorRole || data.actorRole || data.actor_role, 80);
  const episodeId = parsePositiveInt(data.episode_id || data.episodeId, 'episode_id');
  const infectionCaseId = parsePositiveInt(data.infection_case_id || data.infectionCaseId, 'infection_case_id');
  if (!episodeId || !infectionCaseId) {
    throw AppError.badRequest('episode_id and infection_case_id are required', 'IC_OUTBREAK_LINK_REQUIRED');
  }
  const caseStatus = normalizeOutbreakCaseStatus(data.case_status || data.caseStatus);
  return setTenantTx(tenantId, async (tx) => {
    const episodeRows = await tx.$queryRawUnsafe(
      `SELECT id::text, episode_code, organism, ward, status
         FROM outbreak_episodes
        WHERE tenant_id = $1::uuid AND id = $2::bigint
        LIMIT 1`,
      tenantId, episodeId,
    );
    const episode = episodeRows[0];
    if (!episode) throw AppError.notFound('Outbreak episode not found', 'IC_EPISODE_NOT_FOUND');
    const infectionCase = await loadInfectionCase(tx, { infectionCaseId, tenantId });
    if (!infectionCase) throw AppError.notFound('Infection case not found', 'IC_CASE_NOT_FOUND');
    const admission = await loadAdmission(tx, {
      admissionId: data.admission_id || data.admissionId || infectionCase.admission_id || null,
      patientUid: infectionCase.patient_uid,
      tenantId,
    });
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO outbreak_episode_cases
         (tenant_id, episode_id, infection_case_id, admission_id, patient_uid,
          case_status, linked_by, notes)
       VALUES ($1::uuid, $2::bigint, $3::int, $4::int, $5::uuid, $6, $7::uuid, $8)
       ON CONFLICT (tenant_id, episode_id, infection_case_id)
       DO UPDATE SET admission_id = EXCLUDED.admission_id,
                     patient_uid = EXCLUDED.patient_uid,
                     case_status = EXCLUDED.case_status,
                     linked_by = EXCLUDED.linked_by,
                     notes = EXCLUDED.notes,
                     updated_at = NOW()
       RETURNING id::text, tenant_id, episode_id::text, infection_case_id,
                 admission_id, patient_uid, case_status, linked_by, linked_at,
                 notes, created_at, updated_at`,
      tenantId,
      episodeId,
      infectionCaseId,
      admission?.id || null,
      infectionCase.patient_uid,
      caseStatus,
      actorUid,
      cleanText(data.notes, 2000),
    );
    const link = rows[0];
    await recordCanonicalClinicalEvent({
      tenantId,
      patientUid: infectionCase.patient_uid,
      encounterId: admission?.encounter_id || null,
      eventType: 'infection_control.outbreak_case_linked',
      eventStatus: caseStatus,
      sourceTable: 'outbreak_episode_cases',
      sourceId: link.id,
      resourceType: 'outbreak_episode',
      resourceId: episode.id,
      actorUid,
      actorRole,
      visibleToPatient: false,
      summary: `Linked to outbreak episode ${episode.episode_code}`,
      payload: {
        episode_id: episode.id,
        episode_code: episode.episode_code,
        infection_case_id: infectionCaseId,
        organism: episode.organism,
        ward: episode.ward,
        case_status: caseStatus,
      },
      tags: ['infection_control', 'outbreak'],
      timelineIdempotencyKey: `outbreak_episode_cases:${link.id}:linked`,
      auditIdempotencyKey: `outbreak_episode_cases:${link.id}:audit:linked`,
    }, { db: tx });
    return { ...link, episode };
  });
}

export async function listOutbreakEpisodes({ status = null, tenantId = null } = {}) {
  const tid = resolveTenantId(tenantId);
  const params = [tid];
  const filters = ['oe.tenant_id = $1::uuid'];
  if (status && status !== 'all') {
    const normalized = normalizeOutbreakStatus(status);
    params.push(normalized);
    filters.push(`oe.status = $${params.length}`);
  }
  return prisma.$queryRawUnsafe(
    `SELECT oe.id::text, oe.episode_code, oe.organism, oe.ward, oe.status,
            oe.suspected_at, oe.confirmed_at, oe.closed_at, oe.opened_by,
            oe.closed_by, oe.line_list_notes, oe.cluster_rule,
            COUNT(oec.id)::int AS case_count
       FROM outbreak_episodes oe
       LEFT JOIN outbreak_episode_cases oec
         ON oec.episode_id = oe.id AND oec.tenant_id = oe.tenant_id
      WHERE ${filters.join(' AND ')}
      GROUP BY oe.id
      ORDER BY oe.suspected_at DESC, oe.id DESC
      LIMIT 200`,
    ...params,
  );
}

export async function suggestOutbreakClusters({ from, to, tenantId = null } = {}) {
  const tid = resolveTenantId(tenantId);
  assertDate(from, 'from');
  assertDate(to, 'to');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ic.id AS infection_case_id,
            ic.patient_uid,
            u.name AS patient_name,
            ic.organism,
            ic.infection_site,
            ic.detection_date,
            a.id AS admission_id,
            COALESCE(a.ward, 'unassigned') AS ward
       FROM infection_cases ic
       JOIN users u ON u.uid = ic.patient_uid
       LEFT JOIN LATERAL (
         SELECT id, ward
           FROM admissions
          WHERE tenant_id = ic.tenant_id
            AND patient_uid = ic.patient_uid
            AND admitted_at < (ic.detection_date::date + 1)
            AND COALESCE(discharged_at, NOW()) >= ic.detection_date::date
          ORDER BY admitted_at DESC, id DESC
          LIMIT 1
       ) a ON TRUE
      WHERE ic.tenant_id = $1::uuid
        AND ic.detection_date >= $2::date
        AND ic.detection_date <= $3::date
        AND NULLIF(TRIM(ic.organism), '') IS NOT NULL
      ORDER BY ic.organism, ward, ic.detection_date`,
    tid, from, to,
  );
  return {
    period: { from, to },
    clusters: groupOutbreakClusterRows(rows),
  };
}

export async function outbreakEpiCurve({ episodeId, tenantId = null } = {}) {
  const tid = resolveTenantId(tenantId);
  const id = parsePositiveInt(episodeId, 'episode_id');
  if (!id) throw AppError.badRequest('episode_id is required', 'IC_EPISODE_REQUIRED');
  return prisma.$queryRawUnsafe(
    `SELECT ic.detection_date::date AS day,
            COUNT(*)::int AS cases,
            COUNT(*) FILTER (WHERE oec.case_status = 'confirmed')::int AS confirmed
       FROM outbreak_episode_cases oec
       JOIN infection_cases ic ON ic.id = oec.infection_case_id AND ic.tenant_id = oec.tenant_id
      WHERE oec.tenant_id = $1::uuid AND oec.episode_id = $2::bigint
      GROUP BY 1
      ORDER BY 1`,
    tid, id,
  );
}

export async function createHandHygieneAudit(data = {}, context = {}) {
  const tenantId = resolveTenantId(context.tenantId || data.tenant_id || data.tenantId);
  const actorUid = requireActor(context.actorUid || data.actorUid || data.observer_uid);
  const moments = Array.isArray(data.moments) ? data.moments : [];
  if (!moments.length) {
    throw AppError.badRequest('moments are required', 'IC_HAND_HYGIENE_MOMENTS_REQUIRED');
  }
  const normalizedMoments = moments.map((item) => {
    const opportunityCount = parseCount(item.opportunity_count ?? item.opportunities, 'opportunity_count');
    const compliantCount = parseCount(item.compliant_count ?? item.compliant, 'compliant_count');
    if (compliantCount > opportunityCount) {
      throw AppError.badRequest('compliant_count cannot exceed opportunity_count', 'IC_HAND_HYGIENE_COUNT_RANGE');
    }
    return {
      moment_code: cleanText(item.moment_code || item.code, 60) || 'other',
      opportunity_count: opportunityCount,
      compliant_count: compliantCount,
      notes: cleanText(item.notes, 2000),
    };
  });
  const compliance = computeHandHygieneCompliance(normalizedMoments);
  return setTenantTx(tenantId, async (tx) => {
    const auditRows = await tx.$queryRawUnsafe(
      `INSERT INTO hand_hygiene_audits
         (tenant_id, audit_date, ward, unit, session_label, observer_uid,
          total_moments, compliant_moments, compliance_pct, notes)
       VALUES ($1::uuid, $2::date, $3, $4, $5, $6::uuid,
               $7::int, $8::int, $9::numeric, $10)
       RETURNING id::text, tenant_id, audit_date, ward, unit, session_label,
                 observer_uid, total_moments, compliant_moments, compliance_pct,
                 notes, created_at, updated_at`,
      tenantId,
      assertDate(data.audit_date || data.auditDate, 'audit_date'),
      cleanText(data.ward, 255),
      cleanText(data.unit, 120),
      cleanText(data.session_label || data.sessionLabel, 160),
      actorUid,
      compliance.total_moments,
      compliance.compliant_moments,
      compliance.compliance_pct,
      cleanText(data.notes, 2000),
    );
    const audit = auditRows[0];
    for (const item of normalizedMoments) {
      await tx.$executeRawUnsafe(
        `INSERT INTO hand_hygiene_moments
           (tenant_id, audit_id, moment_code, opportunity_count, compliant_count, notes)
         VALUES ($1::uuid, $2::bigint, $3, $4::int, $5::int, $6)
         ON CONFLICT (tenant_id, audit_id, moment_code)
         DO UPDATE SET opportunity_count = EXCLUDED.opportunity_count,
                       compliant_count = EXCLUDED.compliant_count,
                       notes = EXCLUDED.notes,
                       updated_at = NOW()`,
        tenantId,
        audit.id,
        item.moment_code,
        item.opportunity_count,
        item.compliant_count,
        item.notes,
      );
    }
    const savedMoments = await tx.$queryRawUnsafe(
      `SELECT id::text, moment_code, opportunity_count, compliant_count, notes
         FROM hand_hygiene_moments
        WHERE tenant_id = $1::uuid AND audit_id = $2::bigint
        ORDER BY id`,
      tenantId,
      audit.id,
    );
    return { ...audit, moments: savedMoments };
  });
}

export async function listHandHygieneAudits({ from = null, to = null, ward = null, tenantId = null } = {}) {
  const tid = resolveTenantId(tenantId);
  const params = [tid];
  const filters = ['hha.tenant_id = $1::uuid'];
  if (from) {
    params.push(from);
    filters.push(`hha.audit_date >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    filters.push(`hha.audit_date <= $${params.length}::date`);
  }
  if (ward) {
    params.push(ward);
    filters.push(`hha.ward = $${params.length}`);
  }
  return prisma.$queryRawUnsafe(
    `SELECT hha.id::text, hha.audit_date, hha.ward, hha.unit, hha.session_label,
            hha.observer_uid, hha.total_moments, hha.compliant_moments,
            hha.compliance_pct, hha.notes, hha.created_at,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'id', hhm.id::text,
                  'moment_code', hhm.moment_code,
                  'opportunity_count', hhm.opportunity_count,
                  'compliant_count', hhm.compliant_count,
                  'notes', hhm.notes
                )
                ORDER BY hhm.id
              ) FILTER (WHERE hhm.id IS NOT NULL),
              '[]'::jsonb
            ) AS moments
       FROM hand_hygiene_audits hha
       LEFT JOIN hand_hygiene_moments hhm
         ON hhm.audit_id = hha.id AND hhm.tenant_id = hha.tenant_id
      WHERE ${filters.join(' AND ')}
      GROUP BY hha.id
      ORDER BY hha.audit_date DESC, hha.id DESC
      LIMIT 200`,
    ...params,
  );
}

export async function ensureIsolationTerminalCleanForAdmission({
  admissionId,
  tenantId = null,
  actorUid = null,
  actorRole = 'DISCHARGE',
} = {}) {
  const tid = resolveTenantId(tenantId);
  const actor = requireActor(actorUid);
  const parsedAdmissionId = parsePositiveInt(admissionId, 'admission_id');
  if (!parsedAdmissionId) {
    throw AppError.badRequest('admission_id is required', 'IC_ADMISSION_REQUIRED');
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id::text
       FROM isolation_orders
      WHERE tenant_id = $1::uuid
        AND admission_id = $2::int
        AND status = 'active'
        AND terminal_clean_requested_at IS NULL
      ORDER BY ordered_at DESC, id DESC`,
    tid, parsedAdmissionId,
  );
  let requested = 0;
  for (const row of rows) {
    try {
      await requestIsolationTerminalClean({
        isolationOrderId: row.id,
        tenantId: tid,
        actorUid: actor,
        actorRole,
      });
      requested += 1;
    } catch (err) {
      logger.warn(`Isolation terminal clean request failed for order ${row.id}: ${err.message}`);
    }
  }
  return { requested, considered: rows.length };
}

/**
 * Contact tracing from ADT history: admissions that overlapped the index
 * patient's stays in the same ward inside the exposure window.
 */
export async function traceContacts({ patientUid, from, to, tenantId = null } = {}) {
  if (!patientUid || !from || !to) {
    throw AppError.badRequest('patient_uid, from and to are required', 'IC_TRACE_INPUT');
  }
  const tid = resolveTenantId(tenantId);
  return prisma.$queryRawUnsafe(
    `WITH index_stays AS (
       SELECT ward,
              GREATEST(admitted_at, $2::date::timestamptz) AS s,
              LEAST(COALESCE(discharged_at, NOW()), ($3::date + 1)::timestamptz) AS e
         FROM admissions
        WHERE patient_uid = $1::uuid
          AND tenant_id = $4::uuid
          AND admitted_at < ($3::date + 1)
          AND COALESCE(discharged_at, NOW()) >= $2::date
          AND ward IS NOT NULL
     )
     SELECT DISTINCT ON (a.patient_uid, a.ward)
            a.patient_uid, u.name AS patient_name, a.ward, a.bed_number,
            GREATEST(a.admitted_at, i.s) AS overlap_start,
            LEAST(COALESCE(a.discharged_at, NOW()), i.e) AS overlap_end,
            ROUND((EXTRACT(EPOCH FROM (LEAST(COALESCE(a.discharged_at, NOW()), i.e)
                  - GREATEST(a.admitted_at, i.s))) / 3600)::numeric, 1) AS overlap_hours,
            a.status AS admission_status
       FROM index_stays i
       JOIN admissions a ON a.ward = i.ward
            AND a.tenant_id = $4::uuid
            AND a.admitted_at < i.e
            AND COALESCE(a.discharged_at, NOW()) > i.s
            AND a.patient_uid <> $1::uuid
       JOIN users u ON u.uid = a.patient_uid
      ORDER BY a.patient_uid, a.ward, overlap_hours DESC
      LIMIT 500`,
    patientUid, from, to, tid,
  );
}

/**
 * Antibiogram: percent susceptible per organism x antibiotic over the period.
 * micro_isolates/micro_sensitivities carry no tenant column, so scope rides
 * through the owning micro_orders row.
 */
export async function antibiogram({ from, to, minIsolates = 1, tenantId = null } = {}) {
  if (!from || !to) throw AppError.badRequest('from and to are required', 'IC_ABG_PERIOD');
  const tid = resolveTenantId(tenantId);
  const floor = Math.max(Number.parseInt(minIsolates, 10) || 1, 1);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT mi.organism_name,
            ms.antibiotic_name,
            COUNT(*)::int AS tested,
            COUNT(*) FILTER (WHERE UPPER(LEFT(TRIM(ms.result), 1)) = 'S')::int AS susceptible,
            COUNT(*) FILTER (WHERE UPPER(LEFT(TRIM(ms.result), 1)) = 'R')::int AS resistant,
            COUNT(*) FILTER (WHERE UPPER(LEFT(TRIM(ms.result), 1)) = 'I')::int AS intermediate
       FROM micro_sensitivities ms
       JOIN micro_isolates mi ON mi.id = ms.isolate_id
       JOIN micro_orders mo ON mo.id = mi.order_id AND mo.tenant_id = $4::uuid
      WHERE ms.created_at >= $1::date AND ms.created_at < ($2::date + 1)
      GROUP BY mi.organism_name, ms.antibiotic_name
     HAVING COUNT(*) >= $3::int
      ORDER BY mi.organism_name, ms.antibiotic_name`,
    from, to, floor, tid,
  );
  const organisms = {};
  for (const row of rows) {
    const tested = Number(row.tested);
    if (!organisms[row.organism_name]) organisms[row.organism_name] = {};
    organisms[row.organism_name][row.antibiotic_name] = {
      tested,
      susceptible: Number(row.susceptible),
      resistant: Number(row.resistant),
      intermediate: Number(row.intermediate),
      pct_susceptible: tested ? Number(((Number(row.susceptible) / tested) * 100).toFixed(1)) : 0,
    };
  }
  const flags = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) FILTER (WHERE mi.is_mrsa)::int AS mrsa,
            COUNT(*) FILTER (WHERE mi.is_esbl)::int AS esbl,
            COUNT(*) FILTER (WHERE mi.is_carbapenemase)::int AS cre,
            COUNT(*) FILTER (WHERE mi.is_vre)::int AS vre,
            COUNT(*) FILTER (WHERE mi.is_xdr)::int AS xdr,
            COUNT(*)::int AS isolates
       FROM micro_isolates mi
       JOIN micro_orders mo ON mo.id = mi.order_id AND mo.tenant_id = $3::uuid
      WHERE mi.created_at >= $1::date AND mi.created_at < ($2::date + 1)`,
    from, to, tid,
  );
  return { period: { from, to }, organisms, resistance_flags: flags[0] || {} };
}

export default {
  isolationBoard,
  createIsolationOrder,
  listIsolationOrders,
  requestIsolationTerminalClean,
  updateIsolationChecklistItem,
  discontinueIsolationOrder,
  createDevicePresenceLog,
  logDevicePresence,
  stopDevicePresence,
  createHaiCase,
  haiRates,
  calculateHaiRates,
  snapshotHaiRates,
  createOutbreakEpisode,
  linkOutbreakCase,
  listOutbreakEpisodes,
  suggestOutbreakClusters,
  outbreakEpiCurve,
  createHandHygieneAudit,
  listHandHygieneAudits,
  ensureIsolationTerminalCleanForAdmission,
  traceContacts,
  antibiogram,
};
