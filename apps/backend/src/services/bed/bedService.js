// src/services/bed/bedService.js
import prisma from '../../lib/prisma.js';
import {
  MINIMIZED_INPATIENT_PAYLOAD_ROLES,
  resolveInpatientLocationScope,
} from '../emr/inpatientScopeService.js';
import { AppError } from '../../utils/AppError.js';
import { ICU_BED_TYPES, canAllocateIcu } from '../../utils/roleHelpers.js';
import { normalizeRole as normalizePlatformRole } from '../../utils/roles.js';

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

  async updateBed(id, data) {
    const { ward_id, bed_number, status, patient_id, patient_name, notes } = data;
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE beds SET
         ward_id = COALESCE($1, ward_id),
         bed_number = COALESCE($2, bed_number),
         status = COALESCE($3, status),
         patient_id = $4,
         patient_name = $5,
         notes = COALESCE($6, notes),
         updated_at = NOW()
       WHERE id = $7
       RETURNING ${BED_RETURNING}`,
      ward_id ?? null, bed_number ?? null, status ?? null,
      patient_id ?? null, patient_name ?? null, notes ?? null, parseInt(id)
    );
    return rows[0];
  }

  async deleteBed(id) {
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
        LIMIT 1`,
      bedId,
    );
    const bed = rows[0];
    if (!bed) return null;

    const activeAdmissions = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, status
         FROM admissions
        WHERE (bed_id = $1 OR ($2::int IS NOT NULL AND id = $2::int))
          AND discharged_at IS NULL
        LIMIT 1`,
      bedId,
      bed.admission_id ?? null,
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
      `DELETE FROM beds WHERE id = $1`,
      bedId,
    );
    if (count <= 0) return null;
    return bed;
  }

  // Dedicated notes-update path. The full PUT /beds/:id handler nulls
  // patient_id/patient_name when those fields aren't echoed back in the
  // body — fine for admin tooling that always sends the whole row, but
  // not for the staff app's bed-detail sheet which sends only `{ notes }`.
  // Keeping this isolated guarantees a notes save can't silently
  // discharge the patient. Returns the updated bed (with the same join
  // shape getBedsByWard uses) or null when the id doesn't exist.
  async updateBedNotes(id, notes) {
    const bedId = parseInt(id, 10);
    const bedRows = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM beds WHERE id = $1`,
      bedId,
    );
    if (!bedRows.length) return null;
    const status = String(bedRows[0].status || '').toLowerCase();
    if (!['occupied', 'reserved'].includes(status)) {
      throw AppError.badRequest('Bed notes can only be saved for occupied or reserved beds');
    }

    const rows = await prisma.$queryRawUnsafe(
      `UPDATE beds
         SET notes = $1,
             updated_at = NOW()
       WHERE id = $2
       RETURNING ${BED_RETURNING}`,
      typeof notes === 'string' ? notes : null, bedId
    );
    return rows[0] ?? null;
  }

  async admitPatient(bedId, { patient_id, patient_name, notes }, actorRole = null) {
    // Stage-4-C — ICU/CCU beds require physician/admin sign-off; a ward
    // nurse cannot independently allocate an intensive-care bed. Probe
    // bed_type first; throw forbidden when the actor lacks the tier.
    // Finding: 2026-05-09-emergency-walk-in-admission-no-icu-rbac-tier
    const typeRows = await prisma.$queryRawUnsafe(
      `SELECT bed_type FROM beds WHERE id = $1`, parseInt(bedId)
    );
    if (typeRows.length && ICU_BED_TYPES.has(typeRows[0].bed_type) && !canAllocateIcu(actorRole)) {
      throw AppError.forbidden('ICU/CCU bed allocation requires physician or admission-officer authorisation');
    }

    const rows = await prisma.$queryRawUnsafe(
      `UPDATE beds SET
         status = 'occupied',
         patient_id = $1,
         patient_name = $2,
         admitted_at = NOW(),
         assigned_at = NOW(),
         notes = COALESCE($3, notes),
         updated_at = NOW()
       WHERE id = $4 AND status = 'available'
       RETURNING ${BED_RETURNING}`,
      patient_id ?? null, patient_name, notes ?? null, parseInt(bedId)
    );
    return rows[0];
  }

  async dischargePatient(bedId) {
    // F-2 — clear patient_uid and admission_id alongside patient_id /
    // patient_name. Leaving the uuid FK behind made the bed appear
    // available on the map while still pointing at a previous occupant
    // (who, after a fresh admit elsewhere, surfaced on two rows).
    // Finding: 2026-05-10-dynamic-acute-abdomen-admission-available-bed-retains-active-patient.
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE beds SET
         status = 'available',
         patient_id = NULL,
         patient_name = NULL,
         patient_uid = NULL,
         admission_id = NULL,
         admitted_at = NULL,
         expected_discharge = NULL,
         updated_at = NOW()
       WHERE id = $1 AND status = 'occupied'
       RETURNING ${BED_RETURNING}`,
      parseInt(bedId)
    );
    return rows[0];
  }
}

export default new BedService();
