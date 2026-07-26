// src/services/bed/bedService.js
import prisma, { setTenantTx } from '../../lib/prisma.js';
import { getCurrentTenantId } from '../../lib/tenantContext.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  MINIMIZED_INPATIENT_PAYLOAD_ROLES,
  resolveInpatientLocationScope,
} from '../emr/inpatientScopeService.js';
import { AppError } from '../../utils/AppError.js';
import { ICU_BED_TYPES, canAllocateIcu } from '../../utils/roleHelpers.js';
import { normalizeRole as normalizePlatformRole } from '../../utils/roles.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { ensureAdmissionPatientEncounterTx } from '../emr/admissionService.js';
import bedManagementService from './bedManagementService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}
function normalizeTenantId(value) {
  return isUuid(value) ? String(value).trim() : null;
}
function parseExpectedDischarge(value) {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Canonical clinical timeline invariant (docs/CANONICAL_CLINICAL_TIMELINE.md):
// the admission detail row + its canonical timeline/audit events persist in the
// SAME transaction. Runs on the tx client and is NOT swallowed — a failure
// aborts the tx so the bed/admission mutation rolls back rather than leaving the
// timeline/audit layer out of sync (recordCanonicalClinicalEvent still tolerates
// a genuinely-absent canonical table, SQLSTATE 42P01).
async function recordCanonicalAdmissionEvent(input, tx) {
  const event = await recordCanonicalClinicalEvent(input, { db: tx });
  if (!event?.timeline?.id || !event?.audit?.id) {
    throw AppError.internal(
      'Bed write requires canonical timeline and audit events',
      'BED_CANONICAL_EVENT_REQUIRED',
    );
  }
  return event;
}

const BED_RETURNING = `id, ward_id, ward_name, floor, bed_number, bed_type, status,
    patient_id, patient_name, patient_uid, admission_id, admitted_at,
    expected_discharge, notes, assigned_at, created_at, updated_at, tenant_id`;
const WARD_RETURNING = `id, name, floor, department_id, total_beds, created_at, updated_at`;
const VALID_BED_STATUSES = new Set(['available', 'occupied', 'reserved', 'maintenance', 'cleaning', 'dirty']);
const ACTIVE_HOUSEKEEPING_REQUEST_STATUSES = ['open', 'pending', 'assigned', 'in_progress'];
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const BED_CLEANING_REQUEST_SELECT = `
        hkr.id AS housekeeping_request_id,
        hkr.request_number AS housekeeping_request_number,
        hkr.status AS housekeeping_request_status,
        hkr.urgency AS housekeeping_request_urgency,
        hkr.assigned_to AS housekeeping_primary_assignee_id,
        hka.assignee_names AS housekeeping_assignee_names,
        hka.staff_names AS housekeeping_staff_names,
        COALESCE(hka.assignees, '[]'::jsonb) AS housekeeping_assignees`;
const BED_CLEANING_REQUEST_JOINS = `
      LEFT JOIN LATERAL (
        SELECT hr.id, hr.request_number, hr.status, hr.urgency, hr.assigned_to
          FROM housekeeping_requests hr
         WHERE b.status = 'cleaning'
           AND COALESCE(hr.status, 'open') = ANY($1::text[])
           AND hr.request_type IN ('bed_cleaning', 'cleaning')
           AND (
             COALESCE(hr.description, '') ~* ('(^|[^0-9])bed_id\\s*=\\s*' || b.id::text || '([^0-9]|$)')
             OR LOWER(COALESCE(hr.location_text, '')) = LOWER(CONCAT_WS(' / ', NULLIF(w.name, ''), b.bed_number))
           )
         ORDER BY CASE WHEN hr.request_type = 'bed_cleaning' THEN 0 ELSE 1 END,
                  hr.created_at DESC,
                  hr.id DESC
         LIMIT 1
      ) hkr ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          string_agg(NULLIF(TRIM(u.name), ''), ', ' ORDER BY u.name)
            FILTER (WHERE NULLIF(TRIM(u.name), '') IS NOT NULL) AS assignee_names,
          string_agg(NULLIF(TRIM(u.name), ''), ', ' ORDER BY u.name)
            FILTER (WHERE u.role = 'HOUSEKEEPING_STAFF' AND NULLIF(TRIM(u.name), '') IS NOT NULL) AS staff_names,
          COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'id', u.id,
                'uid', u.uid,
                'name', u.name,
                'role', u.role,
                'kind', hrr.recipient_kind,
                'source', hrr.source
              )
              ORDER BY u.role, u.name
            ) FILTER (WHERE u.id IS NOT NULL),
            '[]'::jsonb
          ) AS assignees
          FROM housekeeping_request_recipients hrr
          JOIN users u ON u.id = hrr.staff_id
         WHERE hrr.request_id = hkr.id
      ) hka ON TRUE`;

function truthyParam(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

function tenantOf(options = {}) {
  return options.tenantId || getCurrentTenantId() || null;
}

function normalizeRole(role) {
  return normalizePlatformRole(role) || '';
}

function shouldMinimizeBedPayload(actor = {}) {
  return MINIMIZED_INPATIENT_PAYLOAD_ROLES.has(normalizeRole(actor.role));
}

function minimizeBedPayload(row) {
  return {
    ...row,
    patient_id: null,
    patient_uid: null,
    patient_name: null,
    patient_full_name: null,
    patient_gender: null,
    patient_dob: null,
    patient_phone: null,
    patient_hospital_number: null,
    hospital_number: null,
    patient_age: null,
    chief_complaint: null,
    admitting_diagnosis: null,
    attending_doctor_uid: null,
    attending_doctor_name: null,
  };
}

function addAvailableBedConditions(conditions) {
  conditions.push(
    "b.status = 'available'",
    'b.patient_uid IS NULL',
    'b.patient_id IS NULL',
    'b.patient_name IS NULL',
    'b.admission_id IS NULL',
    "NOT EXISTS (SELECT 1 FROM admissions a WHERE a.bed_id = b.id AND a.discharged_at IS NULL)",
  );
}

function addLocationScopeConditions({ conditions, addParam, locationScope, bedAlias = 'b', wardAlias = 'w' }) {
  if (!locationScope || locationScope.allLocations) return;

  const ors = [];
  if (Array.isArray(locationScope.wardIds) && locationScope.wardIds.length) {
    ors.push(`${bedAlias}.ward_id = ANY(${addParam(locationScope.wardIds)}::int[])`);
  }
  if (Array.isArray(locationScope.wardNames) && locationScope.wardNames.length) {
    ors.push(`LOWER(COALESCE(${bedAlias}.ward_name, ${wardAlias}.name, '')) = ANY(${addParam(locationScope.wardNames.map((name) => String(name).toLowerCase()))}::text[])`);
  }
  if (Array.isArray(locationScope.bedIds) && locationScope.bedIds.length) {
    ors.push(`${bedAlias}.id = ANY(${addParam(locationScope.bedIds)}::int[])`);
  }
  if (Array.isArray(locationScope.floors) && locationScope.floors.length) {
    ors.push(`COALESCE(${bedAlias}.floor, ${wardAlias}.floor) = ANY(${addParam(locationScope.floors)}::int[])`);
  }

  conditions.push(ors.length ? `(${ors.join(' OR ')})` : '1 = 0');
}

function buildBedListFilters(filters = {}, fixedWardId = null, paramOffset = 0, locationScope = null) {
  const conditions = [];
  const params = [];
  const addParam = (value) => {
    params.push(value);
    return `$${params.length + paramOffset}`;
  };

  const rawStatus = filters.status ? String(filters.status).trim().toLowerCase() : null;
  const availableOnly = truthyParam(filters.available)
    || truthyParam(filters.only_available)
    || rawStatus === 'available';

  if (filters.tenantId) {
    conditions.push(`b.tenant_id = ${addParam(String(filters.tenantId))}::uuid`);
  }

  if (availableOnly) {
    addAvailableBedConditions(conditions);
  } else if (rawStatus && rawStatus !== 'all') {
    if (!VALID_BED_STATUSES.has(rawStatus)) {
      throw AppError.badRequest(`Invalid bed status "${filters.status}"`);
    }
    conditions.push(`b.status = ${addParam(rawStatus)}`);
  }

  const wardId = fixedWardId ?? filters.ward_id ?? filters.wardId;
  if (wardId !== null && wardId !== undefined && wardId !== '') {
    const parsed = Number(wardId);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw AppError.badRequest('ward_id must be a positive integer');
    }
    conditions.push(`b.ward_id = ${addParam(parsed)}`);
  }

  const bedType = filters.bed_type || filters.bedType;
  if (bedType) {
    conditions.push(`b.bed_type = ${addParam(String(bedType))}`);
  }

  addLocationScopeConditions({ conditions, addParam, locationScope });

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

function buildScopedBedWhere(locationScope = null, paramOffset = 0, tenantId = null) {
  const conditions = [];
  const params = [];
  const addParam = (value) => {
    params.push(value);
    return `$${params.length + paramOffset}`;
  };

  if (tenantId) {
    conditions.push(`b.tenant_id = ${addParam(String(tenantId))}::uuid`);
  }

  addLocationScopeConditions({ conditions, addParam, locationScope });

  return {
    where: conditions.length ? conditions.join(' AND ') : 'TRUE',
    params,
  };
}

class BedService {
  // ===== WARD OPERATIONS =====

  async listWards({ actor = {}, tenantId = null } = {}) {
    const locationScope = await resolveInpatientLocationScope({
      actor: { ...actor, tenantId: actor.tenantId || tenantId },
      filters: { tenantId: actor.tenantId || tenantId },
    });

    const resolvedTenantId = actor.tenantId || tenantId;
    if (locationScope.allLocations) {
      const wards = await prisma.$queryRawUnsafe(`
      SELECT w.*, d.name as department_name,
        (SELECT COUNT(*)::int FROM beds b WHERE b.ward_id = w.id AND ($1::uuid IS NULL OR b.tenant_id = $1::uuid)) as bed_count,
        (SELECT COUNT(*)::int FROM beds b WHERE b.ward_id = w.id AND b.status = 'occupied' AND ($1::uuid IS NULL OR b.tenant_id = $1::uuid)) as occupied_count
      FROM wards w
      LEFT JOIN departments d ON w.department_id = d.id
      ORDER BY w.name
    `, resolvedTenantId || null);
      return { wards, scope: locationScope.scope };
    }

    const { where, params } = buildScopedBedWhere(locationScope, 0, resolvedTenantId);
    const wards = await prisma.$queryRawUnsafe(`
      WITH visible_beds AS (
        SELECT b.id, b.ward_id, b.status
          FROM beds b
          LEFT JOIN wards w ON b.ward_id = w.id
         WHERE ${where}
      )
      SELECT w.*, d.name as department_name,
        COUNT(vb.id)::int as bed_count,
        COUNT(vb.id) FILTER (WHERE vb.status = 'occupied')::int as occupied_count
      FROM wards w
      JOIN visible_beds vb ON vb.ward_id = w.id
      LEFT JOIN departments d ON w.department_id = d.id
      GROUP BY w.id, d.name
      ORDER BY w.name
    `, ...params);
    return { wards, scope: locationScope.scope };
  }

  async createWard(data) {
    const { floor, department_id, total_beds } = data;
    const name = String(data.name || '').trim();
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, name
         FROM wards
        WHERE LOWER(name) = LOWER($1)
        LIMIT 1`,
      name,
    );
    if (existing.length > 0) {
      throw AppError.conflict(
        `Ward ${name} already exists.`,
        'WARD_ALREADY_EXISTS',
        { ward_id: existing[0].id, ward_name: existing[0].name },
      );
    }

    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO wards (name, floor, department_id, total_beds)
       VALUES ($1, $2, $3, $4)
       RETURNING ${WARD_RETURNING}`,
      name,
      floor ?? 1,
      department_id ?? null,
      total_beds ?? 0,
    );
    return rows[0];
  }

  async updateWard(id, data) {
    const { name, floor, department_id, total_beds } = data;
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE wards SET
         name = COALESCE($1, name),
         floor = COALESCE($2, floor),
         department_id = COALESCE($3, department_id),
         total_beds = COALESCE($4, total_beds),
         updated_at = NOW()
       WHERE id = $5
       RETURNING ${WARD_RETURNING}`,
      name ?? null, floor ?? null, department_id ?? null, total_beds ?? null, parseInt(id)
    );
    return rows[0];
  }

  async deleteWard(id) {
    const wardId = parseInt(id, 10);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${WARD_RETURNING}
         FROM wards
        WHERE id = $1
        LIMIT 1`,
      wardId,
    );
    const ward = rows[0];
    if (!ward) return null;

    const bedRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS bed_count,
              ARRAY_REMOVE(ARRAY_AGG(bed_number ORDER BY bed_number), NULL) AS bed_numbers
         FROM beds
        WHERE ward_id = $1
           OR LOWER(COALESCE(ward_name, '')) = LOWER($2)`,
      wardId,
      ward.name,
    );
    const bedCount = Number(bedRows[0]?.bed_count || 0);
    if (bedCount > 0) {
      throw AppError.conflict(
        `Cannot delete ward ${ward.name}; delete or move its ${bedCount} bed${bedCount === 1 ? '' : 's'} first.`,
        'WARD_DELETE_HAS_BEDS',
        {
          ward_id: ward.id,
          ward_name: ward.name,
          bed_count: bedCount,
          bed_numbers: (bedRows[0]?.bed_numbers || []).slice(0, 10),
        },
      );
    }

    const activeAdmissions = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, status, bed_number
         FROM admissions
        WHERE discharged_at IS NULL
          AND LOWER(COALESCE(ward, '')) = LOWER($1)
        ORDER BY admitted_at DESC NULLS LAST, id DESC
        LIMIT 1`,
      ward.name,
    );
    if (activeAdmissions.length > 0) {
      throw AppError.conflict(
        `Cannot delete ward ${ward.name}; it is linked to an active admission.`,
        'WARD_DELETE_ACTIVE_ADMISSION',
        {
          ward_id: ward.id,
          ward_name: ward.name,
          admission_id: activeAdmissions[0].id,
          bed_number: activeAdmissions[0].bed_number,
          status: activeAdmissions[0].status,
        },
      );
    }

    const count = await prisma.$executeRawUnsafe(
      `DELETE FROM wards WHERE id = $1`,
      wardId,
    );
    if (count <= 0) return null;
    return ward;
  }

  // ===== BED OPERATIONS =====

  async listBeds(filters = {}, { actor = {}, tenantId = null } = {}) {
    const locationScope = await resolveInpatientLocationScope({
      actor: { ...actor, tenantId: actor.tenantId || tenantId },
      filters: { tenantId: actor.tenantId || tenantId },
    });
    const resolvedTenantId = actor.tenantId || tenantId;
    const { where, params } = buildBedListFilters(
      { ...filters, tenantId: resolvedTenantId },
      null,
      1,
      locationScope,
    );
    const rows = await prisma.$queryRawUnsafe(`
      SELECT b.*, w.name as ward_name, w.floor as ward_floor,
        ${BED_CLEANING_REQUEST_SELECT}
      FROM beds b
      LEFT JOIN wards w ON b.ward_id = w.id
      ${BED_CLEANING_REQUEST_JOINS}
      ${where}
      ORDER BY w.name, b.bed_number
    `, ACTIVE_HOUSEKEEPING_REQUEST_STATUSES, ...params);
    const beds = shouldMinimizeBedPayload(actor) ? rows.map(minimizeBedPayload) : rows;
    return { beds, scope: locationScope.scope };
  }

  async getBedsByWard(wardId, filters = {}, { actor = {}, tenantId = null } = {}) {
    // Pull patient + admission context alongside the bed so the bed-board
    // detail sheet can render name + age + gender + admission reason +
    // attending doctor without an N+1 round trip per bed. All joins are
    // LEFT joins so empty/maintenance beds still come back. Active
    // admission resolved via `admissions.bed_id = b.id AND
    // discharged_at IS NULL` — beds has no admission_id FK on the
    // dalekdefender deployment (schema-dump claims one but `\d beds`
    // disagrees), so we hit it from the admissions side. Patient
    // details come from users via `b.patient_uid = u.uid`. The age
    // column is computed in SQL from `users.birthday` (NOT `dob` —
    // that's a schema-dump-vs-live mismatch).
    const locationScope = await resolveInpatientLocationScope({
      actor: { ...actor, tenantId: actor.tenantId || tenantId },
      filters: { tenantId: actor.tenantId || tenantId },
    });
    const resolvedTenantId = actor.tenantId || tenantId;
    const { where, params } = buildBedListFilters(
      { ...filters, tenantId: resolvedTenantId },
      wardId,
      1,
      locationScope,
    );
    const rows = await prisma.$queryRawUnsafe(
      `SELECT b.*,
              w.name AS ward_name,
              u.name     AS patient_full_name,
              u.gender   AS patient_gender,
              u.birthday AS patient_dob,
              u.phone    AS patient_phone,
              COALESCE(hn.identifier_value,
                       CASE WHEN u.id IS NOT NULL THEN 'VH-' || LPAD(u.id::text, 6, '0') END)
                       AS patient_hospital_number,
              COALESCE(hn.identifier_value,
                       CASE WHEN u.id IS NOT NULL THEN 'VH-' || LPAD(u.id::text, 6, '0') END)
                       AS hospital_number,
              CASE WHEN u.birthday IS NOT NULL
                   THEN DATE_PART('year', AGE(u.birthday))::int
              END        AS patient_age,
              a.id       AS admission_id_resolved,
              a.chief_complaint,
              a.admitting_diagnosis,
              a.admission_type,
              a.priority    AS admission_priority,
              a.admitted_at AS admission_admitted_at,
              a.discharge_initiated_at,
              a.billing_closed_at,
              a.summary_signed_at,
              a.discharge_drugs_dispensed_at,
              a.attending_doctor AS attending_doctor_uid,
              doc.name   AS attending_doctor_name,
              ${BED_CLEANING_REQUEST_SELECT}
       FROM beds b
       LEFT JOIN wards w
         ON b.ward_id = w.id
       LEFT JOIN users u
         ON b.patient_uid = u.uid
       LEFT JOIN admissions a
         ON a.bed_id = b.id AND a.discharged_at IS NULL
       LEFT JOIN LATERAL (
         SELECT pi.identifier_value
           FROM patient_identifiers pi
          WHERE pi.tenant_id = COALESCE(a.tenant_id, u.tenant_id)
            AND pi.patient_uid = u.uid
            AND pi.identifier_type IN ('mrn', 'uhid')
            AND pi.status = 'active'
          ORDER BY pi.is_primary DESC,
                   CASE pi.identifier_type WHEN 'mrn' THEN 0 WHEN 'uhid' THEN 1 ELSE 2 END,
                   pi.created_at ASC
          LIMIT 1
       ) hn ON TRUE
       LEFT JOIN users doc
         ON doc.uid = a.attending_doctor
       ${BED_CLEANING_REQUEST_JOINS}
       ${where}
       ORDER BY regexp_replace(COALESCE(b.bed_number, ''), '\\d.*$', ''),
                NULLIF(regexp_replace(COALESCE(b.bed_number, ''), '\\D', '', 'g'), '')::numeric NULLS FIRST,
                b.bed_number`,
      ACTIVE_HOUSEKEEPING_REQUEST_STATUSES,
      ...params
    );
    const beds = shouldMinimizeBedPayload(actor) ? rows.map(minimizeBedPayload) : rows;
    return { beds, scope: locationScope.scope };
  }

  async getBedSummary({ actor = {}, tenantId = null } = {}) {
    const locationScope = await resolveInpatientLocationScope({
      actor: { ...actor, tenantId: actor.tenantId || tenantId },
      filters: { tenantId: actor.tenantId || tenantId },
    });

    const resolvedTenantId = actor.tenantId || tenantId;
    if (locationScope.allLocations) {
      const summary = await prisma.$queryRawUnsafe(`
      SELECT w.id as ward_id, w.name as ward_name, w.floor, w.total_beds,
        COUNT(b.id)::int as actual_beds,
        COUNT(b.id) FILTER (WHERE b.status = 'occupied')::int as occupied,
        COUNT(b.id) FILTER (WHERE b.status = 'available')::int as available,
        COUNT(b.id) FILTER (WHERE b.status = 'reserved')::int as reserved,
        COUNT(b.id) FILTER (WHERE b.status = 'maintenance')::int as maintenance
      FROM wards w
      LEFT JOIN beds b ON b.ward_id = w.id AND ($1::uuid IS NULL OR b.tenant_id = $1::uuid)
      GROUP BY w.id, w.name, w.floor, w.total_beds
      ORDER BY w.name
    `, resolvedTenantId || null);
      return { summary, scope: locationScope.scope };
    }

    const { where, params } = buildScopedBedWhere(locationScope, 0, resolvedTenantId);
    const summary = await prisma.$queryRawUnsafe(`
      WITH visible_beds AS (
        SELECT b.id, b.ward_id, b.status
          FROM beds b
          LEFT JOIN wards w ON b.ward_id = w.id
         WHERE ${where}
      )
      SELECT w.id as ward_id, w.name as ward_name, w.floor, w.total_beds,
        COUNT(vb.id)::int as actual_beds,
        COUNT(vb.id) FILTER (WHERE vb.status = 'occupied')::int as occupied,
        COUNT(vb.id) FILTER (WHERE vb.status = 'available')::int as available,
        COUNT(vb.id) FILTER (WHERE vb.status = 'reserved')::int as reserved,
        COUNT(vb.id) FILTER (WHERE vb.status = 'maintenance')::int as maintenance
      FROM wards w
      JOIN visible_beds vb ON vb.ward_id = w.id
      GROUP BY w.id, w.name, w.floor, w.total_beds
      ORDER BY w.name
    `, ...params);
    return { summary, scope: locationScope.scope };
  }

  async createBed(data, { tenantId = null } = {}) {
    const wardId = parseInt(data.ward_id, 10);
    const bedNumber = String(data.bed_number || '').trim();
    const status = data.status || 'available';
    const bedType = String(data.bed_type || 'general').trim() || 'general';
    const notes = typeof data.notes === 'string' && data.notes.trim() ? data.notes.trim() : null;

    if (!['available', 'maintenance'].includes(status)) {
      throw AppError.badRequest(
        'New beds can only start as available or maintenance.',
        'BED_CREATE_INVALID_STATUS',
        { allowed_statuses: ['available', 'maintenance'] },
      );
    }

    const wardRows = await prisma.$queryRawUnsafe(
      `SELECT id, name, floor
         FROM wards
        WHERE id = $1
        LIMIT 1`,
      wardId,
    );
    const ward = wardRows[0];
    if (!ward) {
      throw AppError.notFound('Ward not found', 'WARD_NOT_FOUND');
    }

    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, ward_id, bed_number
         FROM beds
        WHERE LOWER(bed_number) = LOWER($1)
          AND (
            ward_id = $2
            OR LOWER(COALESCE(ward_name, '')) = LOWER($3)
          )
        LIMIT 1`,
      bedNumber,
      wardId,
      ward.name,
    );
    if (existing.length > 0) {
      throw AppError.conflict(
        `Bed ${bedNumber} already exists in ${ward.name}.`,
        'BED_ALREADY_EXISTS',
        {
          bed_id: existing[0].id,
          ward_id: existing[0].ward_id,
          bed_number: existing[0].bed_number,
          ward_name: ward.name,
        },
      );
    }

    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO beds (ward_id, ward_name, floor, bed_number, bed_type, status, notes, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::uuid, '${DEFAULT_TENANT_ID}'::uuid))
       RETURNING ${BED_RETURNING}`,
      wardId,
      ward.name,
      ward.floor ?? null,
      bedNumber,
      bedType,
      status,
      notes,
      tenantId || null,
    );
    return rows[0];
  }

  async updateBed(id, data, options = {}) {
    const tenantId = requireTenantId(tenantOf(options));
    const bedId = parseInt(id, 10);
    const { ward_id, bed_number, status, notes } = data;
    if (!Number.isSafeInteger(bedId) || bedId <= 0) {
      throw AppError.badRequest('Bed ID must be a positive integer', 'BED_ID_INVALID');
    }
    if (
      status === 'occupied'
      || ['patient_id', 'patient_uid', 'patient_name', 'admission_id']
        .some((field) => Object.hasOwn(data, field))
    ) {
      throw AppError.badRequest(
        'Generic bed updates cannot assign a patient or admission',
        'BED_OCCUPANCY_REQUIRES_ADMISSION',
      );
    }

    return setTenantTx(tenantId, async (tx) => {
      const currentRows = await tx.$queryRawUnsafe(
        `SELECT id, status, patient_id, patient_uid, patient_name, admission_id
           FROM beds
          WHERE id = $1
            AND tenant_id = $2::uuid
          FOR UPDATE`,
        bedId,
        tenantId,
      );
      const current = currentRows[0];
      if (!current) return null;
      if (
        status
        && status !== current.status
        && (
          current.status === 'occupied'
          || current.patient_id != null
          || current.patient_uid != null
          || current.patient_name != null
          || current.admission_id != null
        )
      ) {
        throw AppError.conflict(
          'Occupied bed status can change only through admission discharge or transfer',
          'BED_OCCUPIED_TRANSITION_REQUIRES_ADMISSION',
        );
      }
      if (status === 'available' && current.status === 'cleaning') {
        throw AppError.conflict(
          'Cleaning beds must be released through the bed-ready workflow',
          'BED_READY_WORKFLOW_REQUIRED',
        );
      }

      const rows = await tx.$queryRawUnsafe(
        `UPDATE beds SET
           ward_id = COALESCE($1, ward_id),
           bed_number = COALESCE($2, bed_number),
           status = COALESCE($3, status),
           notes = COALESCE($4, notes),
           updated_at = NOW()
         WHERE id = $5
           AND tenant_id = $6::uuid
         RETURNING ${BED_RETURNING}`,
        ward_id ?? null,
        bed_number ?? null,
        status ?? null,
        notes ?? null,
        bedId,
        tenantId,
      );
      return rows[0] || null;
    });
  }

  async deleteBed(id, options = {}) {
    const tenantId = tenantOf(options);
    const bedId = parseInt(id, 10);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT b.id,
              b.ward_id,
              COALESCE(b.ward_name, w.name) AS ward_name,
              b.floor,
              b.bed_number,
              COALESCE(b.status, 'available') AS status,
              b.patient_id,
              b.patient_name,
              b.patient_uid,
              b.admission_id,
              b.bed_type,
              b.notes,
              b.tenant_id
         FROM beds b
         LEFT JOIN wards w ON w.id = b.ward_id
        WHERE b.id = $1
          AND ($2::uuid IS NULL OR b.tenant_id = $2::uuid)
        LIMIT 1`,
      bedId,
      tenantId,
    );
    const bed = rows[0];
    if (!bed) return null;

    const activeAdmissions = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, status
         FROM admissions
        WHERE (bed_id = $1 OR ($2::int IS NOT NULL AND id = $2::int))
          AND ($3::uuid IS NULL OR tenant_id = $3::uuid)
          AND discharged_at IS NULL
        LIMIT 1`,
      bedId,
      bed.admission_id ?? null,
      tenantId,
    );
    if (activeAdmissions.length > 0) {
      throw AppError.conflict(
        `Cannot delete bed ${bed.bed_number}; it is linked to an active admission.`,
        'BED_DELETE_ACTIVE_ADMISSION',
        {
          bed_id: bed.id,
          bed_number: bed.bed_number,
          admission_id: activeAdmissions[0].id,
          status: bed.status,
        },
      );
    }

    if (
      bed.status === 'occupied'
      || bed.patient_id != null
      || bed.patient_uid != null
      || bed.patient_name != null
      || bed.admission_id != null
    ) {
      throw AppError.conflict(
        `Cannot delete bed ${bed.bed_number}; clear the patient/admission link first.`,
        'BED_DELETE_PATIENT_LINKED',
        {
          bed_id: bed.id,
          bed_number: bed.bed_number,
          status: bed.status,
        },
      );
    }

    if (!['available', 'maintenance'].includes(String(bed.status).toLowerCase())) {
      throw AppError.conflict(
        `Cannot delete bed ${bed.bed_number} while status is ${bed.status}.`,
        'BED_DELETE_STATUS_BLOCKED',
        {
          bed_id: bed.id,
          bed_number: bed.bed_number,
          status: bed.status,
          allowed_statuses: ['available', 'maintenance'],
        },
      );
    }

    const activeHousekeepingRequests = await prisma.$queryRawUnsafe(
      `SELECT id, request_number, status
         FROM housekeeping_requests hr
        WHERE COALESCE(hr.status, 'open') = ANY($1::text[])
          AND hr.request_type IN ('bed_cleaning', 'cleaning')
          AND (
            COALESCE(hr.description, '') ~* ('(^|[^0-9])bed_id\\s*=\\s*' || $2::text || '([^0-9]|$)')
            OR LOWER(COALESCE(hr.location_text, '')) = LOWER($3)
          )
        ORDER BY hr.created_at DESC, hr.id DESC
        LIMIT 1`,
      ACTIVE_HOUSEKEEPING_REQUEST_STATUSES,
      bed.id,
      [bed.ward_name, bed.bed_number].filter(Boolean).join(' / '),
    );
    if (activeHousekeepingRequests.length > 0) {
      throw AppError.conflict(
        `Cannot delete bed ${bed.bed_number}; an active housekeeping request is still open.`,
        'BED_DELETE_ACTIVE_HOUSEKEEPING',
        {
          bed_id: bed.id,
          bed_number: bed.bed_number,
          housekeeping_request_id: activeHousekeepingRequests[0].id,
          housekeeping_request_number: activeHousekeepingRequests[0].request_number,
          housekeeping_status: activeHousekeepingRequests[0].status,
        },
      );
    }

    const count = await prisma.$executeRawUnsafe(
      `DELETE FROM beds WHERE id = $1 AND ($2::uuid IS NULL OR tenant_id = $2::uuid)`,
      bedId,
      tenantId,
    );
    if (count <= 0) return null;
    return bed;
  }

  // Dedicated notes-update path for patient-linked authorization, audit,
  // and realtime-event behavior. Generic PUT updates cannot mutate patient
  // or admission links. Returns the updated bed (with the same join shape
  // getBedsByWard uses) or null when the id doesn't exist.
  async updateBedNotes(id, notes, options = {}) {
    const tenantId = requireTenantId(tenantOf(options));
    const bedId = parseInt(id, 10);
    return setTenantTx(tenantId, async (tx) => {
      const bedRows = await tx.$queryRawUnsafe(
        `SELECT b.id, b.tenant_id, b.status, b.patient_uid, b.admission_id,
                b.bed_number, b.notes, a.encounter_id
           FROM beds b
      LEFT JOIN admissions a ON a.id = b.admission_id AND a.tenant_id = b.tenant_id
          WHERE b.id = $1 AND b.tenant_id = $2::uuid
          FOR UPDATE OF b`,
        bedId,
        tenantId,
      );
      if (!bedRows.length) return null;
      const previous = bedRows[0];
      const status = String(previous.status || '').toLowerCase();
      if (!['occupied', 'reserved'].includes(status)) {
        throw AppError.badRequest('Bed notes can only be saved for occupied or reserved beds');
      }
      if (!previous.patient_uid) {
        throw AppError.conflict(
          'Bed notes require a patient-linked occupied or reserved bed',
          'BED_PATIENT_REQUIRED',
        );
      }

      const rows = await tx.$queryRawUnsafe(
        `UPDATE beds
           SET notes = $1,
               updated_at = NOW()
         WHERE id = $2
           AND tenant_id = $3::uuid
         RETURNING ${BED_RETURNING}`,
        typeof notes === 'string' ? notes : null, bedId, tenantId,
      );
      const updated = rows[0];
      await recordCanonicalAdmissionEvent({
        tenantId: updated.tenant_id,
        patientUid: updated.patient_uid,
        encounterId: previous.encounter_id,
        eventType: 'bed.notes_updated',
        eventStatus: updated.status,
        sourceTable: 'beds',
        sourceId: updated.id,
        resourceType: 'bed',
        resourceId: updated.id,
        actorUid: options.actorUid || null,
        actorRole: options.actorRole || null,
        summary: `Bed notes updated for bed ${updated.bed_number}`,
        payload: {
          bed_id: updated.id,
          bed_number: updated.bed_number,
          admission_id: updated.admission_id,
        },
        beforeState: previous,
        afterState: updated,
        timelineIdempotencyKey: `beds:${updated.id}:notes:${updated.updated_at?.toISOString?.() || 'now'}`,
        auditIdempotencyKey: `beds:${updated.id}:audit:notes:${updated.updated_at?.toISOString?.() || 'now'}`,
      }, tx);
      return updated;
    });
  }

  // Admit a patient to a bed via the bed board's quick-admit endpoint
  // (POST /api/v1/beds/:id/admit).
  //
  // C-2 (audit 2026-06-18): the previous implementation was a bypass — an
  // unlocked SELECT + a conditional `UPDATE beds ... WHERE status='available'`
  // that occupied the bed WITHOUT ever creating an `admissions` row. The bed
  // ended up half-populated (patient_uid / admission_id NULL), nothing landed
  // in bed_transfers, no canonical timeline/audit row was written, and the
  // discharge workflow (which resolves the active admission for the bed) could
  // never find an admission to close. This now does a real, atomic admission:
  //   (a) locks the bed row FOR UPDATE (serialises concurrent admits),
  //   (b) creates the admissions row (status='admitted') so the bed is fully
  //       linked and the discharge workflow can close it,
  //   (c) sets the bed occupied with patient_id + patient_name + patient_uid +
  //       admission_id back-links,
  //   (d) writes the bed_transfers admission audit row, and
  //   (e) emits the canonical admission.created timeline/audit events —
  // all inside ONE setTenantTx so a failure rolls the whole thing back rather
  // than leaving a half-populated bed or an orphan admission.
  //
  // A resolvable patient is required (patient_uid, or patient_id → users.uid):
  // admissions.patient_uid and bed_transfers.patient_uid are both NOT NULL, so a
  // name-only occupancy cannot create the admission the discharge path needs.
  async admitPatient(bedId, { patient_id, patient_uid, patient_name, notes, expected_discharge } = {}, actorRole = null, options = {}) {
    const tenantId = tenantOf(options);
    const parsedBedId = parseInt(bedId, 10);

    // Stage-4-C — ICU/CCU tier gate fires FIRST (before patient validation),
    // matching the legacy pre-lock bed_type probe: a ward nurse must be told she
    // lacks ICU-allocation authority (403) even on an incomplete request, rather
    // than getting a generic "patient required" 400 that masks the real reason.
    // The authoritative re-check still happens on the FOR UPDATE-locked row in
    // the transaction below. Finding: 2026-05-09-emergency-walk-in-admission-no-icu-rbac-tier
    const typeRows = await prisma.$queryRawUnsafe(
      `SELECT bed_type FROM beds WHERE id = $1 AND ($2::uuid IS NULL OR tenant_id = $2::uuid)`,
      parsedBedId,
      tenantId,
    );
    if (typeRows.length && ICU_BED_TYPES.has(typeRows[0].bed_type) && !canAllocateIcu(actorRole)) {
      throw AppError.forbidden('ICU/CCU bed allocation requires physician or admission-officer authorisation');
    }

    // Resolve a patient_uid (the load-bearing key for the admission). Accept an
    // explicit patient_uid, else resolve the int patient_id → users.uid.
    let resolvedPatientUid = isUuid(patient_uid) ? String(patient_uid).trim() : null;
    let resolvedPatientId = Number.isInteger(patient_id) ? patient_id
      : (patient_id != null && /^\d+$/.test(String(patient_id)) ? parseInt(patient_id, 10) : null);
    let resolvedPatientName = patient_name ?? null;

    if (!resolvedPatientUid && resolvedPatientId == null) {
      throw AppError.badRequest(
        'patient_uid or patient_id is required to admit a patient (a bed cannot be occupied without an admission record)',
        'ADMIT_PATIENT_REQUIRED',
      );
    }

    const patientRows = await prisma.$queryRawUnsafe(
      `SELECT id, uid, name, role, tenant_id
         FROM users
        WHERE (($1::uuid IS NOT NULL AND uid = $1::uuid)
           OR ($2::int  IS NOT NULL AND id  = $2::int))
          AND ($3::uuid IS NULL OR tenant_id = $3::uuid)
        LIMIT 1`,
      resolvedPatientUid,
      resolvedPatientId,
      tenantId,
    );
    const patient = patientRows[0] ?? null;
    if (!patient) throw AppError.notFound('Patient not found', 'PATIENT_NOT_FOUND');
    if (String(patient.role || '').toUpperCase() !== 'PATIENT') {
      throw AppError.badRequest('Referenced user is not a patient', 'NOT_A_PATIENT');
    }
    resolvedPatientUid = String(patient.uid);
    resolvedPatientId = patient.id;
    resolvedPatientName = resolvedPatientName ?? patient.name ?? null;
    const resolvedTenantId = requireTenantId(tenantId || normalizeTenantId(patient.tenant_id));

    const expectedDischarge = parseExpectedDischarge(expected_discharge);

    const result = await setTenantTx(resolvedTenantId, async (tx) => {
      // (a) Lock the bed row FOR UPDATE so two concurrent admits can't both
      // occupy it (the legacy unlocked UPDATE could double-allocate).
      const bedRows = await tx.$queryRawUnsafe(
        `SELECT id, tenant_id, status, bed_number, bed_type
           FROM beds
          WHERE id = $1 AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
          FOR UPDATE`,
        parsedBedId,
        tenantId,
      );
      if (!bedRows.length) throw AppError.notFound('Bed not found', 'BED_NOT_FOUND');
      const bed = bedRows[0];

      // Stage-4-C — ICU/CCU beds require physician/admin sign-off; a ward
      // nurse cannot independently allocate an intensive-care bed.
      // Finding: 2026-05-09-emergency-walk-in-admission-no-icu-rbac-tier
      if (ICU_BED_TYPES.has(bed.bed_type) && !canAllocateIcu(actorRole)) {
        throw AppError.forbidden('ICU/CCU bed allocation requires physician or admission-officer authorisation');
      }
      if (bed.status !== 'available') {
        throw AppError.badRequest(
          `Bed ${bed.bed_number} is not available (current status: ${bed.status})`,
          'BED_NOT_AVAILABLE',
        );
      }

      // Guard the patient against a double admission (mirrors
      // bedManagementService.admitPatient).
      const existing = await tx.$queryRawUnsafe(
        `SELECT id FROM admissions
          WHERE patient_uid = $1::uuid
            AND status IN ('admitted', 'transferred')
            AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
          LIMIT 1`,
        resolvedPatientUid,
        tenantId,
      );
      if (existing.length) {
        throw AppError.conflict('Patient already has an active admission', 'PATIENT_ALREADY_ADMITTED');
      }

      // (b) Create the admission row so the bed is fully linked and the
      // discharge workflow can close it. Minimal payload — the bed board's
      // quick-admit carries no doctor / chief-complaint; those nullable
      // columns are filled later through the full ADT surface.
      const admission = await tx.admissions.create({
        data: {
          patient_uid: resolvedPatientUid,
          tenant_id: resolvedTenantId,
          status: 'admitted',
          bed_id: parsedBedId,
          bed_number: bed.bed_number,
          admission_type: 'elective',
          admitted_at: new Date(),
        },
        select: {
          id: true, tenant_id: true, patient_uid: true, encounter_id: true,
          status: true, admission_type: true, bed_id: true, bed_number: true,
        },
      });
      const canonicalEncounter = await ensureAdmissionPatientEncounterTx({
        tx,
        tenantId: resolvedTenantId,
        admission,
        actorUid: options.actorUid,
      });
      admission.encounter_id = canonicalEncounter.encounter.id;

      // (c) Occupy the bed with full back-links (no half-populated row).
      const rows = await tx.$queryRawUnsafe(
        `UPDATE beds SET
           status = 'occupied',
           patient_id = $1,
           patient_name = $2,
           patient_uid = $3::uuid,
           admission_id = $4,
           admitted_at = NOW(),
           assigned_at = NOW(),
           expected_discharge = $5,
           notes = COALESCE($6, notes),
           updated_at = NOW()
         WHERE id = $7
           AND ($8::uuid IS NULL OR tenant_id = $8::uuid)
         RETURNING ${BED_RETURNING}`,
        resolvedPatientId,
        resolvedPatientName,
        resolvedPatientUid,
        admission.id,
        expectedDischarge,
        notes ?? null,
        parsedBedId,
        tenantId,
      );

      // (d) bed_transfers admission audit row (patient_uid + tenant NOT NULL).
      await tx.$executeRawUnsafe(
        `INSERT INTO bed_transfers (tenant_id, patient_uid, admission_id, from_bed_id, to_bed_id, reason, transferred_by)
         VALUES ($1::uuid, $2::uuid, $3, NULL, $4, 'Admission', $5::uuid)`,
        bed.tenant_id || resolvedTenantId,
        resolvedPatientUid,
        admission.id,
        parsedBedId,
        options.actorUid || null,
      );

      // (e) Canonical clinical timeline invariant — admission.created on `tx`.
      await recordCanonicalAdmissionEvent({
        tenantId: admission.tenant_id || resolvedTenantId,
        patientUid: admission.patient_uid,
        encounterId: admission.encounter_id,
        eventType: 'admission.created',
        eventSubtype: admission.admission_type,
        eventStatus: admission.status,
        sourceTable: 'admissions',
        sourceId: admission.id,
        resourceType: 'admission',
        resourceId: admission.id,
        actorUid: options.actorUid || null,
        actorRole,
        summary: `${resolvedPatientName || 'Patient'} admitted to bed ${bed.bed_number}`,
        payload: {
          admission_id: admission.id,
          bed_id: parsedBedId,
          bed_number: bed.bed_number,
          admit_path: 'bed_board_quick_admit',
        },
        afterState: admission,
        timelineIdempotencyKey: `admissions:${admission.id}:created`,
        auditIdempotencyKey: `admissions:${admission.id}:audit:created`,
      }, tx);

      return rows[0];
    });

    return result;
  }

  // Discharge a patient from a bed via the bed board (POST /api/v1/beds/:id/discharge).
  //
  // C-2 (audit 2026-06-18): the previous implementation flipped the bed straight
  // to 'available' — skipping the mandatory 'cleaning' turnover (an
  // infection-control bypass), starting no cleaning SLA / housekeeping ticket,
  // writing no canonical event, and never closing the open admissions row.
  // It now delegates to the typed bedManagementService.dischargePatient, which
  // does all of that atomically under a FOR UPDATE lock: bed → 'cleaning',
  // admission closed, bed_transfers audit row, canonical discharge.completed
  // event in-tx, and a post-commit housekeeping cleaning ticket. No orphan bed,
  // no open admission.
  async dischargePatient(bedId, options = {}) {
    const parsedBedId = parseInt(bedId, 10);
    const dischargedBy = options.dischargedBy || options.actorUid || null;
    return bedManagementService.dischargePatient(parsedBedId, dischargedBy, options);
  }
}

export default new BedService();
