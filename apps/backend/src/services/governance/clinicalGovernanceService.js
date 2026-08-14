import { classifyCareTeamContextShape } from '../../config/careTeamContextShapes.js';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { mergedPatientUidsSubquery } from '../clinical/mergedPatientReadUnion.js';
import { requireTenantId } from '../tenant/tenantService.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const CARE_TEAM_KINDS = [
  'op', 'ip', 'er', 'icu', 'day_care', 'dialysis',
  'perioperative', 'longitudinal', 'other',
];
const CARE_TEAM_STATUSES = ['active', 'paused', 'closed', 'archived'];
const CARE_TEAM_MEMBER_RELATIONSHIPS = [
  'primary_consultant', 'attending_doctor', 'covering_doctor',
  'resident', 'nurse', 'pharmacist', 'physiotherapist',
  'billing_counsellor', 'care_coordinator', 'diagnostics',
  'housekeeping', 'care_team', 'other',
];
const CARE_TEAM_MEMBER_STATUSES = ['active', 'inactive', 'suspended', 'ended'];
const BREAK_GLASS_STATUSES = ['active', 'ended', 'expired', 'revoked'];
const SPECIMEN_TYPES = [
  'blood', 'urine', 'stool', 'sputum', 'swab', 'tissue',
  'csf', 'fluid', 'semen', 'other',
];
const SPECIMEN_PRIORITIES = ['routine', 'urgent', 'stat'];
const SPECIMEN_STATUSES = [
  'ordered', 'collected', 'in_transit', 'received',
  'processing', 'rejected', 'disposed', 'cancelled',
];
const ANALYZER_INTERFACE_KINDS = ['manual', 'hl7', 'astm', 'api', 'file_drop', 'other'];
const ANALYZER_STATUSES = ['active', 'maintenance', 'offline', 'retired'];
const QC_LEVELS = ['low', 'normal', 'high', 'calibration', 'linearity', 'other'];
const QC_RESULT_STATUSES = ['pending', 'passed', 'failed', 'warning'];

function tenantId(value) {
  return requireTenantId(value);
}

function missingSchema(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function duplicateKey(err) {
  return /duplicate key value/i.test(String(err?.message || ''));
}

function text(value, max = 255) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return max ? normalized.slice(0, max) : normalized;
}

function id(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function optionalId(value, label = 'id') {
  if (value === null || value === undefined || value === '') return null;
  return id(value, label);
}

function uuid(value, label = 'uid', { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const normalized = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return normalized;
}

function enumValue(value, allowed, label, fallback = null) {
  if (value === null || value === undefined || value === '') {
    if (fallback !== null) return fallback;
    throw AppError.badRequest(`${label} is required`);
  }
  const normalized = String(value).trim();
  if (!allowed.includes(normalized)) {
    throw AppError.badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return normalized;
}

function bool(value, fallback = false) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return Boolean(value);
}

function jsonObject(value, label = 'metadata') {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

function limit(value) {
  return Math.min(Math.max(Number.parseInt(value, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
}

function optionalDate(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw AppError.badRequest(`${label} must be a valid date`);
  return parsed.toISOString();
}

function dateOnly(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw AppError.badRequest(`${label} must be YYYY-MM-DD`, 'INVALID_DATE');
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw AppError.badRequest(`${label} must be a real calendar date`, 'INVALID_DATE');
  }
  return normalized;
}

function dateRange(dateFrom, dateTo) {
  const from = dateOnly(dateFrom, 'date_from');
  const to = dateOnly(dateTo, 'date_to');
  if (from && to && from > to) {
    throw AppError.badRequest('date_from must be on or before date_to', 'INVALID_DATE_RANGE');
  }
  return { from, to };
}

function statusFilters({ status, tableAlias = '' } = {}) {
  const prefix = tableAlias ? `${tableAlias}.` : '';
  return status ? [`${prefix}status = $STATUS`] : [];
}

function replaceStatusToken(sql, params, status, allowed, label) {
  if (!status) return sql;
  params.push(enumValue(status, allowed, label));
  return sql.replace('$STATUS', `$${params.length}`);
}

export async function createCareTeam({
  tenantId = null,
  patientUid,
  admissionId = null,
  appointmentId = null,
  teamKind = 'longitudinal',
  displayName = null,
  primaryDepartment = null,
  status = 'active',
  statusReason = null,
  metadata = null,
  createdBy = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const patient = uuid(patientUid, 'patient_uid', { required: true });
  const normalizedAdmissionId = optionalId(admissionId, 'admission_id');
  const normalizedAppointmentId = optionalId(appointmentId, 'appointment_id');
  const normalizedTeamKind = enumValue(teamKind, CARE_TEAM_KINDS, 'team_kind', 'longitudinal');

  // Refuse a shape the patient-access engine cannot honour. Without this the
  // row inserts, returns 201, and grants nothing — see
  // src/config/careTeamContextShapes.js for why silence here is the hazard.
  const shape = classifyCareTeamContextShape({
    teamKind: normalizedTeamKind,
    admissionId: normalizedAdmissionId,
    appointmentId: normalizedAppointmentId,
  });
  if (!shape.honourable) {
    throw AppError.badRequest(shape.reason, shape.code);
  }

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO care_teams
         (tenant_id, patient_uid, admission_id, appointment_id, team_kind,
          display_name, primary_department, status, status_reason, metadata,
          created_by, updated_by)
       VALUES ($1::uuid, $2::uuid, $3::int, $4::int, $5, $6, $7, $8, $9, $10::jsonb,
               $11::uuid, $11::uuid)
       RETURNING *`,
      tid,
      patient,
      normalizedAdmissionId,
      normalizedAppointmentId,
      normalizedTeamKind,
      text(displayName),
      text(primaryDepartment, 120),
      enumValue(status, CARE_TEAM_STATUSES, 'status', 'active'),
      text(statusReason, 8000),
      JSON.stringify(jsonObject(metadata)),
      uuid(createdBy, 'created_by'),
    );
    return rows[0];
  } catch (err) {
    if (duplicateKey(err)) throw AppError.conflict('An active care team already exists for that patient context');
    if (missingSchema(err)) throw AppError.internal('Care-team registry is not available yet', 'CARE_TEAM_SCHEMA_UNAVAILABLE');
    throw err;
  }
}

export async function listCareTeams({
  tenantId: tid = null,
  patientUid = null,
  admissionId = null,
  appointmentId = null,
  status = null,
  take = DEFAULT_LIMIT,
} = {}) {
  const params = [tenantId(tid)];
  const filters = ['tenant_id = $1::uuid'];
  const patient = uuid(patientUid, 'patient_uid');
  if (patient) {
    params.push(patient);
    filters.push(`patient_uid = $${params.length}::uuid`);
  }
  const admission = optionalId(admissionId, 'admission_id');
  if (admission) {
    params.push(admission);
    filters.push(`admission_id = $${params.length}`);
  }
  const appointment = optionalId(appointmentId, 'appointment_id');
  if (appointment) {
    params.push(appointment);
    filters.push(`appointment_id = $${params.length}`);
  }
  let sql = `SELECT * FROM care_teams WHERE ${filters.concat(statusFilters({ status })).join(' AND ')}
             ORDER BY updated_at DESC, id DESC LIMIT $LIMIT`;
  sql = replaceStatusToken(sql, params, status, CARE_TEAM_STATUSES, 'status');
  params.push(limit(take));
  sql = sql.replace('$LIMIT', `$${params.length}`);
  try {
    const rows = await prisma.$queryRawUnsafe(sql, ...params);
    return { care_teams: rows, count: rows.length };
  } catch (err) {
    if (missingSchema(err)) return { care_teams: [], count: 0 };
    throw err;
  }
}

export async function transitionCareTeam({
  tenantId: tid = null,
  id: careTeamId,
  nextStatus,
  reason = null,
  changedBy = null,
  metadata = null,
} = {}) {
  const normalizedId = id(careTeamId, 'care_team id');
  const status = enumValue(nextStatus, CARE_TEAM_STATUSES, 'next_status');
  const actor = uuid(changedBy, 'changed_by');
  return setTenantTx(tenantId(tid), async (tx) => {
    const currentRows = await tx.$queryRawUnsafe(
      `SELECT id, status FROM care_teams WHERE tenant_id = $1::uuid AND id = $2`,
      tenantId(tid), normalizedId,
    );
    const current = currentRows[0];
    if (!current) throw AppError.notFound('Care team not found');
    const rows = await tx.$queryRawUnsafe(
      `UPDATE care_teams
          SET status = $3, status_reason = $4, updated_by = $5::uuid, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2
        RETURNING *`,
      tenantId(tid), normalizedId, status, text(reason, 8000), actor,
    );
    await tx.$queryRawUnsafe(
      `INSERT INTO care_team_status_history
         (tenant_id, care_team_id, from_status, to_status, reason, changed_by,
          metadata, created_by, updated_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7::jsonb, $6::uuid, $6::uuid)`,
      tenantId(tid),
      normalizedId,
      current.status,
      status,
      text(reason, 8000),
      actor,
      JSON.stringify(jsonObject(metadata)),
    );
    return rows[0];
  });
}

export async function addCareTeamMember({
  tenantId: tid = null,
  careTeamId,
  staffUid = null,
  staffId = null,
  staffRole = null,
  memberName = null,
  relationshipKind = 'care_team',
  accessScope = null,
  breakGlassAllowed = false,
  activeFrom = null,
  activeUntil = null,
  status = 'active',
  notes = null,
  metadata = null,
  createdBy = null,
} = {}) {
  const teamId = id(careTeamId, 'care_team_id');
  const staffUuid = uuid(staffUid, 'staff_uid');
  const staffIntId = optionalId(staffId, 'staff_id');
  if (!staffUuid && !staffIntId) throw AppError.badRequest('staff_uid or staff_id is required');
  const actor = uuid(createdBy, 'created_by');
  try {
    return await setTenantTx(tenantId(tid), async (tx) => {
      const teams = await tx.$queryRawUnsafe(
        `SELECT patient_uid FROM care_teams WHERE tenant_id = $1::uuid AND id = $2`,
        tenantId(tid), teamId,
      );
      if (!teams[0]) throw AppError.notFound('Care team not found');
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO care_team_members
           (tenant_id, care_team_id, patient_uid, staff_uid, staff_id, staff_role,
            member_name, relationship_kind, access_scope, break_glass_allowed,
            active_from, active_until, status, notes, metadata, created_by, updated_by)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::int, $6, $7, $8, $9::jsonb, $10,
                 COALESCE($11::timestamptz, NOW()), $12::timestamptz, $13, $14, $15::jsonb,
                 $16::uuid, $16::uuid)
         RETURNING *`,
        tenantId(tid),
        teamId,
        teams[0].patient_uid,
        staffUuid,
        staffIntId,
        text(staffRole, 80),
        text(memberName),
        enumValue(relationshipKind, CARE_TEAM_MEMBER_RELATIONSHIPS, 'relationship_kind', 'care_team'),
        JSON.stringify(jsonObject(accessScope, 'access_scope')),
        bool(breakGlassAllowed, false),
        optionalDate(activeFrom, 'active_from'),
        optionalDate(activeUntil, 'active_until'),
        enumValue(status, CARE_TEAM_MEMBER_STATUSES, 'status', 'active'),
        text(notes, 8000),
        JSON.stringify(jsonObject(metadata)),
        actor,
      );
      return rows[0];
    });
  } catch (err) {
    if (duplicateKey(err)) throw AppError.conflict('That active care-team member relationship already exists');
    if (missingSchema(err)) throw AppError.internal('Care-team registry is not available yet', 'CARE_TEAM_SCHEMA_UNAVAILABLE');
    throw err;
  }
}

export async function transitionCareTeamMember({
  tenantId: tid = null,
  careTeamId,
  memberId,
  nextStatus,
  reason = null,
  changedBy = null,
  metadata = null,
} = {}) {
  const teamId = id(careTeamId, 'care_team_id');
  const normalizedMemberId = id(memberId, 'care_team_member id');
  const status = enumValue(nextStatus, CARE_TEAM_MEMBER_STATUSES, 'next_status');
  const actor = uuid(changedBy, 'changed_by');
  return setTenantTx(tenantId(tid), async (tx) => {
    const currentRows = await tx.$queryRawUnsafe(
      `SELECT id, care_team_id, status
         FROM care_team_members
        WHERE tenant_id = $1::uuid AND care_team_id = $2 AND id = $3`,
      tenantId(tid), teamId, normalizedMemberId,
    );
    const current = currentRows[0];
    if (!current) throw AppError.notFound('Care-team member not found');
    const rows = await tx.$queryRawUnsafe(
      `UPDATE care_team_members
          SET status = $4, notes = COALESCE($5, notes),
              updated_by = $6::uuid, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND care_team_id = $2 AND id = $3
        RETURNING *`,
      tenantId(tid),
      teamId,
      normalizedMemberId,
      status,
      text(reason, 8000),
      actor,
    );
    await tx.$queryRawUnsafe(
      `INSERT INTO care_team_member_status_history
         (tenant_id, care_team_member_id, care_team_id, from_status, to_status,
          reason, changed_by, metadata, created_by, updated_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8::jsonb, $7::uuid, $7::uuid)`,
      tenantId(tid),
      normalizedMemberId,
      teamId,
      current.status,
      status,
      text(reason, 8000),
      actor,
      JSON.stringify(jsonObject(metadata)),
    );
    return rows[0];
  });
}

export async function listCareTeamMembers({
  tenantId: tid = null,
  careTeamId,
  status = null,
  take = DEFAULT_LIMIT,
} = {}) {
  const params = [tenantId(tid), id(careTeamId, 'care_team_id')];
  let sql = `SELECT * FROM care_team_members
             WHERE tenant_id = $1::uuid AND care_team_id = $2`;
  if (status) {
    params.push(enumValue(status, CARE_TEAM_MEMBER_STATUSES, 'status'));
    sql += ` AND status = $${params.length}`;
  }
  params.push(limit(take));
  sql += ` ORDER BY status ASC, relationship_kind ASC, active_from DESC LIMIT $${params.length}`;
  try {
    const rows = await prisma.$queryRawUnsafe(sql, ...params);
    return { members: rows, count: rows.length };
  } catch (err) {
    if (missingSchema(err)) return { members: [], count: 0 };
    throw err;
  }
}

export async function startPatientBreakGlass({
  tenantId: tid = null,
  patientUid,
  actorUid,
  actorRole = null,
  reason,
  expiresAt = null,
  metadata = null,
} = {}) {
  const cleanReason = text(reason, 8000);
  if (!cleanReason || cleanReason.length < 8) {
    throw AppError.badRequest('reason must be at least 8 characters');
  }
  const actor = uuid(actorUid, 'actor_uid', { required: true });
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO patient_access_break_glass
         (tenant_id, patient_uid, actor_uid, actor_role, reason, expires_at,
          metadata, created_by, updated_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz,
               $7::jsonb, $3::uuid, $3::uuid)
       RETURNING *`,
      tenantId(tid),
      uuid(patientUid, 'patient_uid', { required: true }),
      actor,
      text(actorRole, 80),
      cleanReason,
      optionalDate(expiresAt, 'expires_at'),
      JSON.stringify(jsonObject(metadata)),
    );
    return rows[0];
  } catch (err) {
    if (missingSchema(err)) throw AppError.internal('Patient access governance is not available yet', 'PATIENT_ACCESS_SCHEMA_UNAVAILABLE');
    throw err;
  }
}

export async function endPatientBreakGlass({
  tenantId: tid = null,
  id: breakGlassId,
  endedBy = null,
  status = 'ended',
} = {}) {
  const breakGlassIntId = id(breakGlassId, 'break_glass id');
  const nextStatus = enumValue(status, BREAK_GLASS_STATUSES, 'status', 'ended');
  const actor = uuid(endedBy, 'ended_by');
  return setTenantTx(tenantId(tid), async (tx) => {
    const currentRows = await tx.$queryRawUnsafe(
      `SELECT id, patient_uid, actor_uid, status
         FROM patient_access_break_glass
        WHERE tenant_id = $1::uuid AND id = $2`,
      tenantId(tid), breakGlassIntId,
    );
    const current = currentRows[0];
    if (!current) throw AppError.notFound('Break-glass session not found');
    const rows = await tx.$queryRawUnsafe(
      `UPDATE patient_access_break_glass
          SET status = $3, ended_at = NOW(), ended_by = $4::uuid,
              updated_by = $4::uuid, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2
        RETURNING *`,
      tenantId(tid),
      breakGlassIntId,
      nextStatus,
      actor,
    );
    await tx.$queryRawUnsafe(
      `INSERT INTO patient_access_break_glass_status_history
         (tenant_id, break_glass_id, patient_uid, actor_uid, from_status, to_status,
          changed_by, metadata, created_by, updated_by)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7::uuid, '{}'::jsonb, $7::uuid, $7::uuid)`,
      tenantId(tid),
      breakGlassIntId,
      current.patient_uid,
      current.actor_uid,
      current.status,
      nextStatus,
      actor,
    );
    return rows[0];
  });
}

export async function listPatientAccessAudit({
  tenantId: tid = null,
  patientUid = null,
  actorUid = null,
  decision = null,
  source = null,
  action = null,
  recordType = null,
  resourceType = null,
  route = null,
  dateFrom = null,
  dateTo = null,
  take = DEFAULT_LIMIT,
} = {}) {
  const params = [tenantId(tid)];
  const filters = ['tenant_id = $1::uuid'];
  const patient = uuid(patientUid, 'patient_uid');
  if (patient) {
    params.push(patient);
    filters.push(
      `patient_uid IN (${mergedPatientUidsSubquery('$1::uuid', `$${params.length}::uuid`)})`,
    );
  }
  const actor = uuid(actorUid, 'actor_uid');
  if (actor) {
    params.push(actor);
    filters.push(`actor_uid = $${params.length}::uuid`);
  }
  const cleanDecision = text(decision, 40);
  if (cleanDecision) {
    params.push(cleanDecision.toLowerCase());
    filters.push(`LOWER(access_decision) = $${params.length}`);
  }
  const cleanSource = text(source, 40);
  if (cleanSource) {
    params.push(cleanSource.toLowerCase());
    filters.push(`LOWER(access_source) = $${params.length}`);
  }
  const cleanAction = text(action, 40);
  if (cleanAction) {
    params.push(cleanAction.toUpperCase());
    filters.push(`UPPER(action) = $${params.length}`);
  }
  const cleanRecordType = text(recordType, 120);
  if (cleanRecordType) {
    params.push(cleanRecordType.toLowerCase());
    filters.push(`LOWER(metadata->>'record_type') = $${params.length}`);
  }
  const cleanResourceType = text(resourceType, 120);
  if (cleanResourceType) {
    params.push(cleanResourceType.toLowerCase());
    filters.push(`LOWER(metadata->>'resource_type') = $${params.length}`);
  }
  const cleanRoute = text(route, 120);
  if (cleanRoute) {
    params.push(`%${cleanRoute}%`);
    filters.push(`route ILIKE $${params.length}`);
  }
  const from = optionalDate(dateFrom, 'date_from');
  if (from) {
    params.push(from);
    filters.push(`created_at >= $${params.length}::timestamptz`);
  }
  const to = optionalDate(dateTo, 'date_to');
  if (to) {
    params.push(to);
    filters.push(`created_at <= $${params.length}::timestamptz`);
  }
  params.push(limit(take));
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT
         id, tenant_id, patient_uid, actor_uid, actor_role,
         access_decision, access_source, reason AS access_reason,
         route, action, care_team_id, break_glass_id, request_id,
         metadata,
         metadata->>'record_type' AS record_type,
         metadata->>'resource_type' AS resource_type,
         metadata->>'policy_code' AS policy_code,
         created_at
       FROM patient_access_audit_log
       WHERE ${filters.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      ...params,
    );
    return { access_events: rows, count: rows.length };
  } catch (err) {
    if (missingSchema(err)) return { access_events: [], count: 0 };
    throw err;
  }
}

export async function listPatientAccessShadowDenials({
  tenantId: tid = null,
  dateFrom = null,
  dateTo = null,
} = {}) {
  const range = dateRange(dateFrom, dateTo);
  const params = [tenantId(tid)];
  const filters = [
    'tenant_id = $1::uuid',
    "LOWER(access_decision) = 'deny'",
    "metadata->>'shadow_mode' = 'true'",
  ];
  if (range.from) {
    params.push(range.from);
    filters.push(`(created_at AT TIME ZONE 'Asia/Kolkata')::date >= $${params.length}::date`);
  }
  if (range.to) {
    params.push(range.to);
    filters.push(`(created_at AT TIME ZONE 'Asia/Kolkata')::date <= $${params.length}::date`);
  }

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT
         (created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day,
         COALESCE(NULLIF(actor_role, ''), 'UNKNOWN') AS actor_role,
         COALESCE(
           NULLIF(metadata->>'record_type', ''),
           NULLIF(metadata->>'resource_type', ''),
           NULLIF(metadata->>'policy_code', ''),
           NULLIF(split_part(regexp_replace(COALESCE(route, ''), '^/api/v1/', ''), '/', 1), ''),
           'UNKNOWN'
         ) AS resource_family,
         COUNT(*)::int AS denial_count,
         MIN(created_at) AS first_seen_at,
         MAX(created_at) AS last_seen_at
       FROM patient_access_audit_log
       WHERE ${filters.join(' AND ')}
       GROUP BY day, actor_role, resource_family
       ORDER BY day DESC, actor_role ASC, resource_family ASC`,
      ...params,
    );
    const shadowDenials = rows.map((row) => ({
      day: row.day,
      actor_role: row.actor_role,
      resource_family: row.resource_family,
      denial_count: Number(row.denial_count || 0),
      first_seen_at: row.first_seen_at instanceof Date ? row.first_seen_at.toISOString() : row.first_seen_at,
      last_seen_at: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : row.last_seen_at,
    }));
    return {
      range: { date_from: range.from, date_to: range.to },
      shadow_denials: shadowDenials,
      count: shadowDenials.length,
      total_denials: shadowDenials.reduce((sum, row) => sum + row.denial_count, 0),
    };
  } catch (err) {
    if (missingSchema(err)) {
      return {
        range: { date_from: range.from, date_to: range.to },
        shadow_denials: [],
        count: 0,
        total_denials: 0,
      };
    }
    throw err;
  }
}

export async function createLabSpecimen({
  tenantId: tid = null,
  patientUid,
  bookingId = null,
  accessionNumber,
  specimenType = 'blood',
  containerType = null,
  collectionSite = null,
  priority = 'routine',
  status = 'ordered',
  statusReason = null,
  collectedAt = null,
  collectedBy = null,
  metadata = null,
  createdBy = null,
} = {}) {
  const accession = text(accessionNumber, 120);
  if (!accession) throw AppError.badRequest('accession_number is required');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_specimens
         (tenant_id, patient_uid, booking_id, accession_number, specimen_type,
          container_type, collection_site, priority, status, status_reason,
          collected_at, collected_by, metadata, created_by, updated_by)
       VALUES ($1::uuid, $2::uuid, $3::int, $4, $5, $6, $7, $8, $9, $10,
               $11::timestamptz, $12::uuid, $13::jsonb, $14::uuid, $14::uuid)
       RETURNING *`,
      tenantId(tid),
      uuid(patientUid, 'patient_uid', { required: true }),
      optionalId(bookingId, 'booking_id'),
      accession,
      enumValue(specimenType, SPECIMEN_TYPES, 'specimen_type', 'blood'),
      text(containerType, 80),
      text(collectionSite, 120),
      enumValue(priority, SPECIMEN_PRIORITIES, 'priority', 'routine'),
      enumValue(status, SPECIMEN_STATUSES, 'status', 'ordered'),
      text(statusReason, 8000),
      optionalDate(collectedAt, 'collected_at'),
      uuid(collectedBy, 'collected_by'),
      JSON.stringify(jsonObject(metadata)),
      uuid(createdBy, 'created_by'),
    );
    return rows[0];
  } catch (err) {
    if (duplicateKey(err)) throw AppError.conflict('That accession number already exists for this tenant');
    if (missingSchema(err)) throw AppError.internal('Lab specimen registry is not available yet', 'LAB_SPECIMEN_SCHEMA_UNAVAILABLE');
    throw err;
  }
}

export async function transitionLabSpecimen({
  tenantId: tid = null,
  id: specimenId,
  nextStatus,
  reason = null,
  changedBy = null,
  metadata = null,
} = {}) {
  const normalizedId = id(specimenId, 'specimen id');
  const status = enumValue(nextStatus, SPECIMEN_STATUSES, 'next_status');
  const actor = uuid(changedBy, 'changed_by');
  return setTenantTx(tenantId(tid), async (tx) => {
    const currentRows = await tx.$queryRawUnsafe(
      `SELECT id, status FROM lab_specimens WHERE tenant_id = $1::uuid AND id = $2`,
      tenantId(tid), normalizedId,
    );
    const current = currentRows[0];
    if (!current) throw AppError.notFound('Lab specimen not found');
    const rows = await tx.$queryRawUnsafe(
      `UPDATE lab_specimens
          SET status = $3, status_reason = $4, updated_by = $5::uuid, updated_at = NOW(),
              received_at = CASE WHEN $3 = 'received' AND received_at IS NULL THEN NOW() ELSE received_at END,
              received_by = CASE WHEN $3 = 'received' AND received_by IS NULL THEN $5::uuid ELSE received_by END,
              rejected_at = CASE WHEN $3 = 'rejected' AND rejected_at IS NULL THEN NOW() ELSE rejected_at END,
              rejected_by = CASE WHEN $3 = 'rejected' AND rejected_by IS NULL THEN $5::uuid ELSE rejected_by END,
              rejection_reason = CASE WHEN $3 = 'rejected' THEN $4 ELSE rejection_reason END
        WHERE tenant_id = $1::uuid AND id = $2
        RETURNING *`,
      tenantId(tid), normalizedId, status, text(reason, 8000), actor,
    );
    await tx.$queryRawUnsafe(
      `INSERT INTO lab_specimen_status_history
         (tenant_id, specimen_id, from_status, to_status, reason, changed_by,
          metadata, created_by, updated_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7::jsonb, $6::uuid, $6::uuid)`,
      tenantId(tid),
      normalizedId,
      current.status,
      status,
      text(reason, 8000),
      actor,
      JSON.stringify(jsonObject(metadata)),
    );
    return rows[0];
  });
}

export async function listLabSpecimens({
  tenantId: tid = null,
  patientUid = null,
  bookingId = null,
  status = null,
  take = DEFAULT_LIMIT,
} = {}) {
  const params = [tenantId(tid)];
  const filters = ['tenant_id = $1::uuid'];
  const patient = uuid(patientUid, 'patient_uid');
  if (patient) {
    params.push(patient);
    filters.push(`patient_uid = $${params.length}::uuid`);
  }
  const booking = optionalId(bookingId, 'booking_id');
  if (booking) {
    params.push(booking);
    filters.push(`booking_id = $${params.length}`);
  }
  if (status) {
    params.push(enumValue(status, SPECIMEN_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  params.push(limit(take));
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT * FROM lab_specimens
       WHERE ${filters.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      ...params,
    );
    return { specimens: rows, count: rows.length };
  } catch (err) {
    if (missingSchema(err)) return { specimens: [], count: 0 };
    throw err;
  }
}

export async function upsertLabAnalyzer({
  tenantId: tid = null,
  id: analyzerId = null,
  facilityId = null,
  locationId = null,
  analyzerCode,
  displayName,
  manufacturer = null,
  model = null,
  serialNumber = null,
  interfaceKind = 'manual',
  status = 'active',
  metadata = null,
  updatedBy = null,
} = {}) {
  const analyzerIntId = optionalId(analyzerId, 'analyzer id');
  const args = [
    tenantId(tid),
    optionalId(facilityId, 'facility_id'),
    optionalId(locationId, 'location_id'),
    text(analyzerCode, 120),
    text(displayName),
    text(manufacturer, 120),
    text(model, 120),
    text(serialNumber, 120),
    enumValue(interfaceKind, ANALYZER_INTERFACE_KINDS, 'interface_kind', 'manual'),
    enumValue(status, ANALYZER_STATUSES, 'status', 'active'),
    JSON.stringify(jsonObject(metadata)),
    uuid(updatedBy, 'updated_by'),
  ];
  if (!args[3]) throw AppError.badRequest('analyzer_code is required');
  if (!args[4]) throw AppError.badRequest('display_name is required');

  try {
    if (analyzerIntId) {
      const rows = await prisma.$queryRawUnsafe(
        `UPDATE lab_analyzers
            SET facility_id = $2::int, location_id = $3::int, analyzer_code = $4,
                display_name = $5, manufacturer = $6, model = $7, serial_number = $8,
                interface_kind = $9, status = $10, metadata = $11::jsonb,
                updated_by = $12::uuid, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $13
          RETURNING *`,
        ...args,
        analyzerIntId,
      );
      if (!rows[0]) throw AppError.notFound('Lab analyzer not found');
      return rows[0];
    }
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_analyzers
         (tenant_id, facility_id, location_id, analyzer_code, display_name,
          manufacturer, model, serial_number, interface_kind, status,
          metadata, created_by, updated_by)
       VALUES ($1::uuid, $2::int, $3::int, $4, $5, $6, $7, $8, $9, $10,
               $11::jsonb, $12::uuid, $12::uuid)
       RETURNING *`,
      ...args,
    );
    return rows[0];
  } catch (err) {
    if (duplicateKey(err)) throw AppError.conflict('That analyzer code already exists for this tenant');
    if (missingSchema(err)) throw AppError.internal('Lab analyzer registry is not available yet', 'LAB_ANALYZER_SCHEMA_UNAVAILABLE');
    throw err;
  }
}

export async function listLabAnalyzers({
  tenantId: tid = null,
  status = null,
  facilityId = null,
  take = DEFAULT_LIMIT,
} = {}) {
  const params = [tenantId(tid)];
  const filters = ['tenant_id = $1::uuid'];
  if (status) {
    params.push(enumValue(status, ANALYZER_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  const facility = optionalId(facilityId, 'facility_id');
  if (facility) {
    params.push(facility);
    filters.push(`facility_id = $${params.length}`);
  }
  params.push(limit(take));
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT * FROM lab_analyzers
       WHERE ${filters.join(' AND ')}
       ORDER BY analyzer_code ASC LIMIT $${params.length}`,
      ...params,
    );
    return { analyzers: rows, count: rows.length };
  } catch (err) {
    if (missingSchema(err)) return { analyzers: [], count: 0 };
    throw err;
  }
}

export async function recordLabQcRun({
  tenantId: tid = null,
  analyzerId,
  qcLevel = 'normal',
  qcLotNumber = null,
  resultStatus = 'pending',
  measuredValues = null,
  performedAt = null,
  performedBy = null,
  reviewedAt = null,
  reviewedBy = null,
  notes = null,
  rawPayload = null,
  metadata = null,
} = {}) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_analyzer_qc_runs
         (tenant_id, analyzer_id, qc_level, qc_lot_number, result_status,
          measured_values, performed_at, performed_by, reviewed_at, reviewed_by,
          notes, raw_payload, metadata, created_by, updated_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb,
               COALESCE($7::timestamptz, NOW()), $8::uuid, $9::timestamptz,
               $10::uuid, $11, $12::jsonb, $13::jsonb, $8::uuid, $8::uuid)
       RETURNING *`,
      tenantId(tid),
      id(analyzerId, 'analyzer_id'),
      enumValue(qcLevel, QC_LEVELS, 'qc_level', 'normal'),
      text(qcLotNumber, 120),
      enumValue(resultStatus, QC_RESULT_STATUSES, 'result_status', 'pending'),
      JSON.stringify(jsonObject(measuredValues, 'measured_values')),
      optionalDate(performedAt, 'performed_at'),
      uuid(performedBy, 'performed_by'),
      optionalDate(reviewedAt, 'reviewed_at'),
      uuid(reviewedBy, 'reviewed_by'),
      text(notes, 8000),
      JSON.stringify(jsonObject(rawPayload, 'raw_payload')),
      JSON.stringify(jsonObject(metadata)),
    );
    return rows[0];
  } catch (err) {
    if (missingSchema(err)) throw AppError.internal('Lab QC registry is not available yet', 'LAB_QC_SCHEMA_UNAVAILABLE');
    throw err;
  }
}

export async function listLabQcRuns({
  tenantId: tid = null,
  analyzerId = null,
  resultStatus = null,
  take = DEFAULT_LIMIT,
} = {}) {
  const params = [tenantId(tid)];
  const filters = ['tenant_id = $1::uuid'];
  const analyzer = optionalId(analyzerId, 'analyzer_id');
  if (analyzer) {
    params.push(analyzer);
    filters.push(`analyzer_id = $${params.length}`);
  }
  if (resultStatus) {
    params.push(enumValue(resultStatus, QC_RESULT_STATUSES, 'result_status'));
    filters.push(`result_status = $${params.length}`);
  }
  params.push(limit(take));
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT * FROM lab_analyzer_qc_runs
       WHERE ${filters.join(' AND ')}
       ORDER BY performed_at DESC, id DESC LIMIT $${params.length}`,
      ...params,
    );
    return { qc_runs: rows, count: rows.length };
  } catch (err) {
    if (missingSchema(err)) return { qc_runs: [], count: 0 };
    throw err;
  }
}
