// N6-13 CSSD instrument tracking.
//
// Operational CSSD data is tenant-scoped and audited, but it is not a
// patient-facing clinical timeline subject.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { code39Svg } from '../../utils/barcode/code39.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

const SET_STATUSES = new Set([
  'available',
  'issued',
  'in_theatre',
  'returned',
  'decontamination',
  'sterilization_pending',
  'sterilized',
  'unusable',
  'retired',
]);

const LOAD_STATUSES = new Set(['planned', 'running', 'completed', 'passed', 'failed', 'cancelled']);
const LOAD_CYCLE_TYPES = new Set(['steam', 'eto', 'plasma', 'dry_heat', 'chemical', 'other']);
const INDICATOR_RESULTS = new Set(['not_required', 'pending', 'passed', 'failed']);
const RETURN_CONDITIONS = new Set(['intact', 'missing_item', 'damaged', 'contaminated']);

const ISSUE_TRANSITIONS = {
  issued: ['in_theatre', 'returned', 'cancelled'],
  in_theatre: ['returned'],
  returned: ['awaiting_sterilization'],
  awaiting_sterilization: [],
  sterilized: [],
  sterilization_failed: [],
  cancelled: [],
};

export function getAllowedIssueTransitions(status) {
  return [...(ISSUE_TRANSITIONS[status] || [])];
}

function tenantOr(value) {
  return requireTenantId(String(value || '').trim());
}

function unwrap(rows) {
  return Array.isArray(rows) ? rows[0] || null : rows || null;
}

function intId(value, field = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${field} must be a positive integer`, 'CSSD_BAD_ID');
  }
  return parsed;
}

function cleanText(value, max = 255) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function cleanJson(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return value;
}

function cleanDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw AppError.badRequest('Invalid timestamp supplied', 'CSSD_BAD_TIMESTAMP');
  }
  return date.toISOString();
}

function boolFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  const text = String(value).trim().toLowerCase();
  if (['true', 'yes', 'y'].includes(text)) return true;
  if (['false', 'no', 'n'].includes(text)) return false;
  return Boolean(value);
}

function actorUid(context = {}) {
  return cleanText(context.actorUid || context.actor_uid || context.uid, 80);
}

function actorRole(context = {}) {
  return cleanText(context.actorRole || context.actor_role || context.role, 60);
}

function cleanCode(value, fallbackPrefix) {
  const text = cleanText(value, 80);
  if (text) return text.toUpperCase();
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-10);
  return `${fallbackPrefix}-${stamp}`.toUpperCase();
}

function barcodeFromCode(value) {
  const cleaned = String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ./$+%-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 74);
  return `CSSD-${cleaned || Date.now()}`.slice(0, 80);
}

function numericOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function indicator(value, fallback = 'pending') {
  const normalized = cleanText(value, 30) || fallback;
  if (!INDICATOR_RESULTS.has(normalized)) {
    throw AppError.badRequest(
      `indicator result must be one of: ${[...INDICATOR_RESULTS].join(', ')}`,
      'CSSD_BAD_INDICATOR',
    );
  }
  return normalized;
}

function normalizeValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value?.toNumber === 'function') return value.toNumber();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, normalizeValue(val)]));
  }
  return value;
}

function normalizeRows(rows) {
  return normalizeValue(rows);
}

export function validateSetContents(contents) {
  if (!Array.isArray(contents)) {
    throw AppError.badRequest('contents must be an array', 'CSSD_CONTENTS_ARRAY_REQUIRED');
  }
  return contents.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw AppError.badRequest(`contents[${index}] must be an object`, 'CSSD_CONTENTS_ITEM_BAD');
    }
    const name = cleanText(item.name || item.item_name || item.instrument, 160);
    if (!name) {
      throw AppError.badRequest(`contents[${index}].name is required`, 'CSSD_CONTENTS_NAME_REQUIRED');
    }
    const quantity = Number.parseInt(item.quantity ?? item.qty ?? item.count ?? 1, 10);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw AppError.badRequest(`contents[${index}].quantity must be a positive integer`, 'CSSD_CONTENTS_QUANTITY_BAD');
    }
    return {
      item_code: cleanText(item.item_code || item.code, 80),
      name,
      quantity,
      category: cleanText(item.category, 80),
      critical: boolFlag(item.critical, false),
    };
  });
}

export function deriveLoadStatus(data = {}) {
  const status = cleanText(data.status, 40);
  const bi = indicator(data.biological_indicator_result ?? data.biologicalIndicatorResult, 'pending');
  const chemical = indicator(data.chemical_indicator_result ?? data.chemicalIndicatorResult, 'pending');
  const mechanical = indicator(data.mechanical_indicator_result ?? data.mechanicalIndicatorResult, 'pending');

  if ([bi, chemical, mechanical].includes('failed')) return 'failed';
  if (status) {
    if (!LOAD_STATUSES.has(status)) {
      throw AppError.badRequest(`status must be one of: ${[...LOAD_STATUSES].join(', ')}`, 'CSSD_BAD_LOAD_STATUS');
    }
    if (status === 'passed' && [bi, chemical, mechanical].includes('pending')) {
      throw AppError.badRequest('passed loads cannot have pending indicators', 'CSSD_INDICATORS_PENDING');
    }
    return status;
  }

  const completed = cleanDate(data.completed_at || data.completedAt);
  const started = cleanDate(data.started_at || data.startedAt);
  const indicatorsComplete = [bi, chemical, mechanical].every((result) => result === 'passed' || result === 'not_required');
  if (completed && indicatorsComplete) return 'passed';
  if (completed) return 'completed';
  if (started) return 'running';
  return 'planned';
}

async function recordAudit(db, {
  tenantId,
  action,
  resource,
  resourceId,
  context = {},
  metadata = {},
}) {
  await db.$executeRawUnsafe(
    `INSERT INTO audit_logs
       (tenant_id, uid, role, action, resource, resource_id, metadata, actor_uid, created_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $2::uuid, NOW())`,
    tenantId,
    actorUid(context),
    actorRole(context),
    action,
    resource,
    String(resourceId),
    JSON.stringify(metadata),
  );
}

async function loadSet(db, tenantId, id) {
  const rows = await db.$queryRawUnsafe(
    `SELECT *
       FROM instrument_sets
      WHERE id = $1::bigint
        AND tenant_id = $2::uuid
      LIMIT 1`,
    intId(id, 'instrument_set_id'),
    tenantId,
  );
  return unwrap(rows);
}

async function loadSets(db, tenantId, ids) {
  if (!ids.length) return [];
  const rows = await db.$queryRawUnsafe(
    `SELECT *
       FROM instrument_sets
      WHERE tenant_id = $1::uuid
        AND id = ANY($2::bigint[])
      ORDER BY id`,
    tenantId,
    ids,
  );
  return rows;
}

async function assertOtSchedule(db, tenantId, id) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, tenant_id, status, scheduled_date, procedure_name
       FROM ot_schedules
      WHERE id = $1::int
        AND tenant_id = $2::uuid
      LIMIT 1`,
    intId(id, 'ot_schedule_id'),
    tenantId,
  );
  const schedule = unwrap(rows);
  if (!schedule) throw AppError.notFound('OT schedule not found', 'CSSD_OT_SCHEDULE_NOT_FOUND');
  return schedule;
}

function warningCodesForSet(row) {
  const warnings = [];
  if (!row.last_passed_load_id) {
    warnings.push('CSSD_SET_NOT_FROM_PASSED_LOAD');
  }
  if (row.requires_reprocessing || row.status === 'unusable') {
    warnings.push('CSSD_SET_REQUIRES_REPROCESSING');
  }
  return warnings;
}

function sterilityGateSnapshot() {
  return {
    warn_only: true,
    enforcement_enabled: false,
    enforcement_configured: String(process.env.CSSD_REQUIRE_PASSED_LOAD_FOR_OT || '').toLowerCase() === 'true',
  };
}

export async function listInstrumentSets({ tenantId, status = null, usable = null, q = null, limit = 200 } = {}) {
  const safeTenant = tenantOr(tenantId);
  const clauses = ['tenant_id = $1::uuid'];
  const args = [safeTenant];
  const setStatus = cleanText(status, 40);
  if (setStatus) {
    if (!SET_STATUSES.has(setStatus)) throw AppError.badRequest('Invalid set status', 'CSSD_BAD_SET_STATUS');
    args.push(setStatus);
    clauses.push(`status = $${args.length}`);
  }
  if (usable !== null && usable !== undefined && usable !== '') {
    args.push(boolFlag(usable));
    clauses.push(`usable = $${args.length}`);
  }
  const search = cleanText(q, 120);
  if (search) {
    args.push(`%${search}%`);
    clauses.push(`(set_code ILIKE $${args.length} OR barcode ILIKE $${args.length} OR display_name ILIKE $${args.length})`);
  }
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 200, 1), 1000);
  args.push(safeLimit);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT *
       FROM instrument_sets
      WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC, id DESC
      LIMIT $${args.length}`,
    ...args,
  );
  return normalizeRows(rows);
}

export async function createInstrumentSet(data = {}, context = {}) {
  const tenantId = tenantOr(data.tenantId || data.tenant_id || context.tenantId);
  const setCode = cleanCode(data.set_code || data.setCode, 'CSSDSET');
  const barcode = cleanText(data.barcode, 80) || barcodeFromCode(setCode);
  const displayName = cleanText(data.display_name || data.displayName || data.name, 180);
  if (!displayName) throw AppError.badRequest('display_name is required', 'CSSD_SET_NAME_REQUIRED');
  const setType = cleanText(data.set_type || data.setType, 40) || 'instrument_set';
  const status = cleanText(data.status, 40) || 'available';
  if (!SET_STATUSES.has(status)) throw AppError.badRequest('Invalid set status', 'CSSD_BAD_SET_STATUS');
  const contents = validateSetContents(cleanJson(data.contents, []));
  const usable = data.usable === undefined ? !['unusable', 'retired'].includes(status) : boolFlag(data.usable);
  const requiresReprocessing = boolFlag(data.requires_reprocessing ?? data.requiresReprocessing, false);

  return normalizeValue(await setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO instrument_sets
         (tenant_id, set_code, barcode, display_name, set_type, specialty, storage_location,
          contents, status, usable, requires_reprocessing, notes, metadata, created_by, updated_by)
       VALUES
         ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13::jsonb, $14::uuid, $14::uuid)
       RETURNING *`,
      tenantId,
      setCode,
      barcode,
      displayName,
      setType,
      cleanText(data.specialty, 80),
      cleanText(data.storage_location || data.storageLocation, 120),
      JSON.stringify(contents),
      status,
      usable,
      requiresReprocessing,
      cleanText(data.notes, 2000),
      JSON.stringify(cleanJson(data.metadata, {})),
      actorUid(context),
    );
    const created = unwrap(rows);
    await recordAudit(tx, {
      tenantId,
      action: 'cssd.instrument_set.created',
      resource: 'instrument_sets',
      resourceId: created.id,
      context,
      metadata: { set_code: setCode, barcode },
    });
    return created;
  }));
}

export async function getInstrumentSetLabel(id, context = {}) {
  const tenantId = tenantOr(context.tenantId || context.tenant_id);
  const setId = intId(id, 'instrument_set_id');
  const set = await loadSet(prisma, tenantId, setId);
  if (!set) throw AppError.notFound('Instrument set not found', 'CSSD_SET_NOT_FOUND');
  await setTenantTx(tenantId, async (tx) => {
    await tx.$executeRawUnsafe(
      `UPDATE instrument_sets
          SET label_printed_at = NOW(),
              label_printed_by = $3::uuid,
              updated_at = NOW(),
              updated_by = $3::uuid
        WHERE id = $1::bigint
          AND tenant_id = $2::uuid`,
      setId,
      tenantId,
      actorUid(context),
    );
    await recordAudit(tx, {
      tenantId,
      action: 'cssd.instrument_set.label_printed',
      resource: 'instrument_sets',
      resourceId: setId,
      context,
      metadata: { barcode: set.barcode },
    });
  });
  return {
    instrument_set_id: Number(set.id),
    set_code: set.set_code,
    display_name: set.display_name,
    barcode: set.barcode,
    barcode_symbology: 'code39',
    svg: code39Svg(set.barcode, { module: 2, height: 44 }),
    generated_at: new Date().toISOString(),
  };
}

export async function listSterilizationLoads({ tenantId, status = null, limit = 100 } = {}) {
  const safeTenant = tenantOr(tenantId);
  const clauses = ['tenant_id = $1::uuid'];
  const args = [safeTenant];
  const loadStatus = cleanText(status, 40);
  if (loadStatus) {
    if (!LOAD_STATUSES.has(loadStatus)) throw AppError.badRequest('Invalid load status', 'CSSD_BAD_LOAD_STATUS');
    args.push(loadStatus);
    clauses.push(`status = $${args.length}`);
  }
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
  args.push(safeLimit);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT *
       FROM sterilization_loads
      WHERE ${clauses.join(' AND ')}
      ORDER BY COALESCE(completed_at, started_at, created_at) DESC, id DESC
      LIMIT $${args.length}`,
    ...args,
  );
  return normalizeRows(rows);
}

export async function createSterilizationLoad(data = {}, context = {}) {
  const tenantId = tenantOr(data.tenantId || data.tenant_id || context.tenantId);
  const loadCode = cleanCode(data.load_code || data.loadCode, 'CSSDLOAD');
  const cycleType = cleanText(data.cycle_type || data.cycleType, 40) || 'steam';
  if (!LOAD_CYCLE_TYPES.has(cycleType)) {
    throw AppError.badRequest(`cycle_type must be one of: ${[...LOAD_CYCLE_TYPES].join(', ')}`, 'CSSD_BAD_CYCLE_TYPE');
  }
  const status = deriveLoadStatus(data);
  const setIds = [...new Set((data.set_ids || data.setIds || []).map((id) => intId(id, 'set_ids')))];
  if (!setIds.length) throw AppError.badRequest('set_ids must contain at least one set', 'CSSD_LOAD_SET_IDS_REQUIRED');
  const bi = indicator(data.biological_indicator_result ?? data.biologicalIndicatorResult, 'pending');
  const chemical = indicator(data.chemical_indicator_result ?? data.chemicalIndicatorResult, 'pending');
  const mechanical = indicator(data.mechanical_indicator_result ?? data.mechanicalIndicatorResult, 'pending');

  return normalizeValue(await setTenantTx(tenantId, async (tx) => {
    const sets = await loadSets(tx, tenantId, setIds);
    if (sets.length !== setIds.length) {
      throw AppError.notFound('One or more instrument sets were not found', 'CSSD_SET_NOT_FOUND');
    }
    const loadContents = Array.isArray(data.load_contents || data.loadContents)
      ? data.load_contents || data.loadContents
      : sets.map((set) => ({
          instrument_set_id: Number(set.id),
          set_code: set.set_code,
          display_name: set.display_name,
        }));

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO sterilization_loads
         (tenant_id, load_code, sterilizer_id, sterilizer_name, cycle_type, cycle_number,
          status, started_at, completed_at, released_at, operator_uid, released_by,
          temperature_c, pressure_kpa, exposure_minutes, drying_minutes,
          biological_indicator_result, chemical_indicator_result, mechanical_indicator_result,
          indicator_lot, set_ids, load_contents, failure_reason, notes, metadata,
          created_by, updated_by)
       VALUES
         ($1::uuid, $2, $3, $4, $5, $6, $7::text, $8::timestamptz, $9::timestamptz,
          CASE WHEN $7::text = 'passed' THEN COALESCE($10::timestamptz, NOW()) ELSE $10::timestamptz END,
          $11::uuid, $12::uuid, $13::numeric, $14::numeric, $15::int, $16::int,
          $17, $18, $19, $20, $21::bigint[], $22::jsonb, $23, $24, $25::jsonb,
          $26::uuid, $26::uuid)
       RETURNING *`,
      tenantId,
      loadCode,
      cleanText(data.sterilizer_id || data.sterilizerId, 80),
      cleanText(data.sterilizer_name || data.sterilizerName, 160),
      cycleType,
      cleanText(data.cycle_number || data.cycleNumber, 80),
      status,
      cleanDate(data.started_at || data.startedAt),
      cleanDate(data.completed_at || data.completedAt),
      cleanDate(data.released_at || data.releasedAt),
      cleanText(data.operator_uid || data.operatorUid || actorUid(context), 80),
      cleanText(data.released_by || data.releasedBy, 80),
      numericOrNull(data.temperature_c || data.temperatureC),
      numericOrNull(data.pressure_kpa || data.pressureKpa),
      numericOrNull(data.exposure_minutes || data.exposureMinutes),
      numericOrNull(data.drying_minutes || data.dryingMinutes),
      bi,
      chemical,
      mechanical,
      cleanText(data.indicator_lot || data.indicatorLot, 120),
      setIds,
      JSON.stringify(loadContents),
      cleanText(data.failure_reason || data.failureReason, 2000),
      cleanText(data.notes, 2000),
      JSON.stringify(cleanJson(data.metadata, {})),
      actorUid(context),
    );
    const load = unwrap(rows);

    if (status === 'passed') {
      await tx.$executeRawUnsafe(
        `UPDATE instrument_sets
            SET status = 'sterilized',
                usable = true,
                requires_reprocessing = false,
                current_sterilization_load_id = $3::bigint,
                last_passed_load_id = $3::bigint,
                last_sterilized_at = COALESCE($4::timestamptz, NOW()),
                updated_at = NOW(),
                updated_by = $5::uuid
          WHERE tenant_id = $1::uuid
            AND id = ANY($2::bigint[])`,
        tenantId,
        setIds,
        load.id,
        load.released_at || load.completed_at,
        actorUid(context),
      );
      await tx.$executeRawUnsafe(
        `UPDATE set_issue_log
            SET status = 'sterilized',
                sterilized_at = COALESCE($4::timestamptz, NOW()),
                sterilized_by = $5::uuid,
                sterilization_load_id = $3::bigint,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND instrument_set_id = ANY($2::bigint[])
            AND status IN ('returned', 'awaiting_sterilization', 'sterilization_failed')`,
        tenantId,
        setIds,
        load.id,
        load.released_at || load.completed_at,
        actorUid(context),
      );
    } else if (status === 'failed') {
      await tx.$executeRawUnsafe(
        `UPDATE instrument_sets
            SET status = 'unusable',
                usable = false,
                requires_reprocessing = true,
                current_sterilization_load_id = $3::bigint,
                updated_at = NOW(),
                updated_by = $4::uuid
          WHERE tenant_id = $1::uuid
            AND id = ANY($2::bigint[])`,
        tenantId,
        setIds,
        load.id,
        actorUid(context),
      );
      await tx.$executeRawUnsafe(
        `UPDATE set_issue_log
            SET status = 'sterilization_failed',
                sterilization_load_id = $3::bigint,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND instrument_set_id = ANY($2::bigint[])
            AND status IN ('returned', 'awaiting_sterilization')`,
        tenantId,
        setIds,
        load.id,
      );
    } else if (!['cancelled'].includes(status)) {
      await tx.$executeRawUnsafe(
        `UPDATE instrument_sets
            SET status = 'sterilization_pending',
                usable = false,
                requires_reprocessing = true,
                current_sterilization_load_id = $3::bigint,
                updated_at = NOW(),
                updated_by = $4::uuid
          WHERE tenant_id = $1::uuid
            AND id = ANY($2::bigint[])`,
        tenantId,
        setIds,
        load.id,
        actorUid(context),
      );
    }

    await recordAudit(tx, {
      tenantId,
      action: status === 'failed' ? 'cssd.sterilization_load.failed' : 'cssd.sterilization_load.created',
      resource: 'sterilization_loads',
      resourceId: load.id,
      context,
      metadata: { load_code: loadCode, status, set_ids: setIds },
    });
    return { ...load, affected_set_ids: setIds };
  }));
}

export async function transitionSterilizationLoad(id, patch = {}, context = {}) {
  const tenantId = tenantOr(context.tenantId || patch.tenantId || patch.tenant_id);
  const loadId = intId(id, 'load_id');
  return normalizeValue(await setTenantTx(tenantId, async (tx) => {
    const lockedRows = await tx.$queryRawUnsafe(
      `SELECT *
         FROM sterilization_loads
        WHERE id = $1::bigint
          AND tenant_id = $2::uuid
        FOR UPDATE`,
      loadId,
      tenantId,
    );
    const current = unwrap(lockedRows);
    if (!current) throw AppError.notFound('Sterilization load not found', 'CSSD_LOAD_NOT_FOUND');

    const next = {
      ...current,
      ...patch,
      biological_indicator_result: patch.biological_indicator_result
        ?? patch.biologicalIndicatorResult
        ?? current.biological_indicator_result,
      chemical_indicator_result: patch.chemical_indicator_result
        ?? patch.chemicalIndicatorResult
        ?? current.chemical_indicator_result,
      mechanical_indicator_result: patch.mechanical_indicator_result
        ?? patch.mechanicalIndicatorResult
        ?? current.mechanical_indicator_result,
      completed_at: patch.completed_at ?? patch.completedAt ?? current.completed_at,
      started_at: patch.started_at ?? patch.startedAt ?? current.started_at,
    };
    const status = deriveLoadStatus(next);
    const setIds = (current.set_ids || []).map((setId) => intId(setId, 'set_ids'));
    const bi = indicator(next.biological_indicator_result, 'pending');
    const chemical = indicator(next.chemical_indicator_result, 'pending');
    const mechanical = indicator(next.mechanical_indicator_result, 'pending');

    const updatedRows = await tx.$queryRawUnsafe(
      `UPDATE sterilization_loads
          SET status = $3::text,
              completed_at = CASE WHEN $3::text IN ('completed', 'passed', 'failed') THEN COALESCE($4::timestamptz, NOW()) ELSE completed_at END,
              released_at = CASE WHEN $3::text = 'passed' THEN COALESCE($5::timestamptz, NOW()) ELSE released_at END,
              biological_indicator_result = $6,
              chemical_indicator_result = $7,
              mechanical_indicator_result = $8,
              failure_reason = COALESCE($9, failure_reason),
              notes = COALESCE($10, notes),
              updated_by = $11::uuid,
              updated_at = NOW()
        WHERE id = $1::bigint
          AND tenant_id = $2::uuid
       RETURNING *`,
      loadId,
      tenantId,
      status,
      cleanDate(patch.completed_at || patch.completedAt),
      cleanDate(patch.released_at || patch.releasedAt),
      bi,
      chemical,
      mechanical,
      cleanText(patch.failure_reason || patch.failureReason, 2000),
      cleanText(patch.notes, 2000),
      actorUid(context),
    );
    const load = unwrap(updatedRows);

    if (setIds.length && status === 'passed') {
      await tx.$executeRawUnsafe(
        `UPDATE instrument_sets
            SET status = 'sterilized',
                usable = true,
                requires_reprocessing = false,
                current_sterilization_load_id = $3::bigint,
                last_passed_load_id = $3::bigint,
                last_sterilized_at = COALESCE($4::timestamptz, NOW()),
                updated_at = NOW(),
                updated_by = $5::uuid
          WHERE tenant_id = $1::uuid
            AND id = ANY($2::bigint[])`,
        tenantId,
        setIds,
        load.id,
        load.released_at || load.completed_at,
        actorUid(context),
      );
      await tx.$executeRawUnsafe(
        `UPDATE set_issue_log
            SET status = 'sterilized',
                sterilized_at = COALESCE($4::timestamptz, NOW()),
                sterilized_by = $5::uuid,
                sterilization_load_id = $3::bigint,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND instrument_set_id = ANY($2::bigint[])
            AND status IN ('returned', 'awaiting_sterilization', 'sterilization_failed')`,
        tenantId,
        setIds,
        load.id,
        load.released_at || load.completed_at,
        actorUid(context),
      );
    } else if (setIds.length && status === 'failed') {
      await tx.$executeRawUnsafe(
        `UPDATE instrument_sets
            SET status = 'unusable',
                usable = false,
                requires_reprocessing = true,
                current_sterilization_load_id = $3::bigint,
                updated_at = NOW(),
                updated_by = $4::uuid
          WHERE tenant_id = $1::uuid
            AND id = ANY($2::bigint[])`,
        tenantId,
        setIds,
        load.id,
        actorUid(context),
      );
      await tx.$executeRawUnsafe(
        `UPDATE set_issue_log
            SET status = 'sterilization_failed',
                sterilization_load_id = $3::bigint,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND instrument_set_id = ANY($2::bigint[])
            AND status IN ('returned', 'awaiting_sterilization')`,
        tenantId,
        setIds,
        load.id,
      );
    }

    await recordAudit(tx, {
      tenantId,
      action: `cssd.sterilization_load.${status}`,
      resource: 'sterilization_loads',
      resourceId: load.id,
      context,
      metadata: { load_code: load.load_code, status, set_ids: setIds },
    });
    return { ...load, affected_set_ids: setIds };
  }));
}

export async function issueSet(data = {}, context = {}) {
  const tenantId = tenantOr(data.tenantId || data.tenant_id || context.tenantId);
  const setId = intId(data.instrument_set_id || data.instrumentSetId || data.set_id, 'instrument_set_id');
  const scheduleId = intId(data.ot_schedule_id || data.otScheduleId, 'ot_schedule_id');
  await assertOtSchedule(prisma, tenantId, scheduleId);

  return normalizeValue(await setTenantTx(tenantId, async (tx) => {
    const set = await loadSet(tx, tenantId, setId);
    if (!set) throw AppError.notFound('Instrument set not found', 'CSSD_SET_NOT_FOUND');
    if (set.status === 'retired') throw AppError.conflict('Instrument set is retired', 'CSSD_SET_RETIRED');
    if (set.status === 'unusable' || set.requires_reprocessing || !set.usable) {
      throw AppError.conflict('Instrument set is unusable until reprocessed', 'CSSD_SET_UNUSABLE');
    }
    if (!['available', 'sterilized'].includes(set.status)) {
      throw AppError.conflict('Instrument set is already in circulation', 'CSSD_SET_NOT_AVAILABLE');
    }
    const warningCodes = warningCodesForSet(set);
    const issueCode = cleanCode(data.issue_code || data.issueCode, 'CSSDISSUE');
    const gate = sterilityGateSnapshot();
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO set_issue_log
         (tenant_id, issue_code, instrument_set_id, ot_schedule_id, issued_at, issued_by,
          return_due_at, issue_warning_codes, warn_only, enforcement_enabled, notes, metadata)
       VALUES
         ($1::uuid, $2, $3::bigint, $4::int, COALESCE($5::timestamptz, NOW()), $6::uuid,
          $7::timestamptz, $8::text[], true, false, $9, $10::jsonb)
       RETURNING *`,
      tenantId,
      issueCode,
      setId,
      scheduleId,
      cleanDate(data.issued_at || data.issuedAt),
      actorUid(context),
      cleanDate(data.return_due_at || data.returnDueAt),
      warningCodes,
      cleanText(data.notes, 2000),
      JSON.stringify(cleanJson(data.metadata, {})),
    );
    const issue = unwrap(rows);
    await tx.$executeRawUnsafe(
      `UPDATE instrument_sets
          SET status = 'issued',
              last_issued_at = $3::timestamptz,
              updated_at = NOW(),
              updated_by = $4::uuid
        WHERE id = $1::bigint
          AND tenant_id = $2::uuid`,
      setId,
      tenantId,
      issue.issued_at,
      actorUid(context),
    );
    await recordAudit(tx, {
      tenantId,
      action: 'cssd.set.issued',
      resource: 'set_issue_log',
      resourceId: issue.id,
      context,
      metadata: { issue_code: issueCode, instrument_set_id: setId, ot_schedule_id: scheduleId, warnings: warningCodes },
    });
    return {
      ...issue,
      warnings: warningCodes.map((code) => ({
        code,
        message: code === 'CSSD_SET_NOT_FROM_PASSED_LOAD'
          ? 'Set not from a passed sterilization load'
          : 'Set requires reprocessing before reuse',
        set_code: set.set_code,
        instrument_set_id: setId,
        ...gate,
      })),
      gate,
    };
  }));
}

async function transitionIssue(id, nextStatus, patch = {}, context = {}) {
  const tenantId = tenantOr(context.tenantId || patch.tenantId || patch.tenant_id);
  const issueId = intId(id, 'issue_id');
  return normalizeValue(await setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT l.*, s.last_passed_load_id
         FROM set_issue_log l
         JOIN instrument_sets s ON s.id = l.instrument_set_id AND s.tenant_id = l.tenant_id
        WHERE l.id = $1::bigint
          AND l.tenant_id = $2::uuid
        FOR UPDATE OF l`,
      issueId,
      tenantId,
    );
    const issue = unwrap(rows);
    if (!issue) throw AppError.notFound('CSSD issue record not found', 'CSSD_ISSUE_NOT_FOUND');
    const allowed = ISSUE_TRANSITIONS[issue.status] || [];
    if (!allowed.includes(nextStatus)) {
      throw AppError.invalidTransition(issue.status, nextStatus, allowed);
    }

    const at = cleanDate(
      patch.at
      || patch.returned_at
      || patch.returnedAt
      || patch.decontaminated_at
      || patch.decontaminatedAt
      || patch.theatre_use_started_at
      || patch.theatreUseStartedAt,
    );
    const actor = actorUid(context);
    const returnCondition = cleanText(patch.return_condition || patch.returnCondition, 40);
    if (returnCondition && !RETURN_CONDITIONS.has(returnCondition)) {
      throw AppError.badRequest('Invalid return condition', 'CSSD_BAD_RETURN_CONDITION');
    }

    const updatedRows = await tx.$queryRawUnsafe(
      `UPDATE set_issue_log
          SET status = $3::text,
              theatre_use_started_at = CASE WHEN $3::text = 'in_theatre' THEN COALESCE($4::timestamptz, NOW()) ELSE theatre_use_started_at END,
              theatre_use_started_by = CASE WHEN $3::text = 'in_theatre' THEN $5::uuid ELSE theatre_use_started_by END,
              returned_at = CASE WHEN $3::text = 'returned' THEN COALESCE($4::timestamptz, NOW()) ELSE returned_at END,
              returned_by = CASE WHEN $3::text = 'returned' THEN $5::uuid ELSE returned_by END,
              decontaminated_at = CASE WHEN $3::text = 'awaiting_sterilization' THEN COALESCE($4::timestamptz, NOW()) ELSE decontaminated_at END,
              decontaminated_by = CASE WHEN $3::text = 'awaiting_sterilization' THEN $5::uuid ELSE decontaminated_by END,
              return_condition = CASE WHEN $3::text = 'returned' THEN COALESCE($6::text, return_condition) ELSE return_condition END,
              contamination_notes = COALESCE($7::text, contamination_notes),
              notes = CASE WHEN $3::text = 'cancelled' THEN COALESCE($8::text, notes) ELSE notes END,
              updated_at = NOW()
        WHERE id = $1::bigint
          AND tenant_id = $2::uuid
       RETURNING *`,
      issueId,
      tenantId,
      nextStatus,
      at,
      actor,
      returnCondition,
      cleanText(patch.contamination_notes || patch.contaminationNotes, 2000),
      cleanText(patch.notes || patch.reason, 2000),
    );
    const updated = unwrap(updatedRows);

    if (nextStatus === 'in_theatre') {
      await tx.$executeRawUnsafe(
        `UPDATE instrument_sets
            SET status = 'in_theatre',
                updated_at = NOW(),
                updated_by = $3::uuid
          WHERE id = $1::bigint AND tenant_id = $2::uuid`,
        issue.instrument_set_id,
        tenantId,
        actor,
      );
    } else if (nextStatus === 'returned') {
      await tx.$executeRawUnsafe(
        `UPDATE instrument_sets
            SET status = 'returned',
                usable = false,
                last_returned_at = COALESCE($3::timestamptz, NOW()),
                updated_at = NOW(),
                updated_by = $4::uuid
          WHERE id = $1::bigint AND tenant_id = $2::uuid`,
        issue.instrument_set_id,
        tenantId,
        at,
        actor,
      );
    } else if (nextStatus === 'awaiting_sterilization') {
      await tx.$executeRawUnsafe(
        `UPDATE instrument_sets
            SET status = 'sterilization_pending',
                usable = false,
                requires_reprocessing = true,
                updated_at = NOW(),
                updated_by = $3::uuid
          WHERE id = $1::bigint AND tenant_id = $2::uuid`,
        issue.instrument_set_id,
        tenantId,
        actor,
      );
    } else if (nextStatus === 'cancelled') {
      await tx.$executeRawUnsafe(
        `UPDATE instrument_sets
            SET status = CASE WHEN last_passed_load_id IS NULL THEN 'available' ELSE 'sterilized' END,
                usable = true,
                requires_reprocessing = false,
                updated_at = NOW(),
                updated_by = $3::uuid
          WHERE id = $1::bigint AND tenant_id = $2::uuid`,
        issue.instrument_set_id,
        tenantId,
        actor,
      );
    }

    await recordAudit(tx, {
      tenantId,
      action: `cssd.issue.${nextStatus}`,
      resource: 'set_issue_log',
      resourceId: issueId,
      context,
      metadata: { instrument_set_id: Number(issue.instrument_set_id), ot_schedule_id: issue.ot_schedule_id },
    });
    return updated;
  }));
}

export async function markTheatreUse(id, patch = {}, context = {}) {
  return transitionIssue(id, 'in_theatre', patch, context);
}

export async function returnIssuedSet(id, patch = {}, context = {}) {
  return transitionIssue(id, 'returned', patch, context);
}

export async function markDecontaminated(id, patch = {}, context = {}) {
  return transitionIssue(id, 'awaiting_sterilization', patch, context);
}

export async function cancelIssue(id, patch = {}, context = {}) {
  return transitionIssue(id, 'cancelled', patch, context);
}

export async function listIssues({ tenantId, ot_schedule_id = null, status = null, limit = 200 } = {}) {
  const safeTenant = tenantOr(tenantId);
  const clauses = ['l.tenant_id = $1::uuid'];
  const args = [safeTenant];
  if (ot_schedule_id) {
    args.push(intId(ot_schedule_id, 'ot_schedule_id'));
    clauses.push(`l.ot_schedule_id = $${args.length}::int`);
  }
  const issueStatus = cleanText(status, 40);
  if (issueStatus) {
    args.push(issueStatus);
    clauses.push(`l.status = $${args.length}`);
  }
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 200, 1), 1000);
  args.push(safeLimit);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT l.*, s.set_code, s.barcode, s.display_name AS set_name,
            o.procedure_name, o.scheduled_date, o.ot_room
       FROM set_issue_log l
       JOIN instrument_sets s ON s.id = l.instrument_set_id AND s.tenant_id = l.tenant_id
       JOIN ot_schedules o ON o.id = l.ot_schedule_id AND o.tenant_id = l.tenant_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY l.updated_at DESC, l.id DESC
      LIMIT $${args.length}`,
    ...args,
  );
  return normalizeRows(rows);
}

export async function getCssdBoard({ tenantId, now = new Date(), limit = 8 } = {}) {
  const safeTenant = tenantOr(tenantId);
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 8, 1), 50);
  const [setCounts, loadCounts, activeIssues, recentLoads] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT
          COUNT(*)::int AS total_sets,
          COUNT(*) FILTER (WHERE status IN ('available', 'sterilized') AND usable = true)::int AS available_sets,
          COUNT(*) FILTER (WHERE status IN ('issued', 'in_theatre'))::int AS sets_in_circulation,
          COUNT(*) FILTER (WHERE status = 'unusable' OR requires_reprocessing = true)::int AS sets_requiring_reprocessing
         FROM instrument_sets
        WHERE tenant_id = $1::uuid`,
      safeTenant,
    ),
    prisma.$queryRawUnsafe(
      `SELECT
          COUNT(*) FILTER (WHERE status IN ('planned', 'running', 'completed'))::int AS open_loads,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_loads
         FROM sterilization_loads
        WHERE tenant_id = $1::uuid`,
      safeTenant,
    ),
    prisma.$queryRawUnsafe(
      `SELECT l.*, s.set_code, s.display_name AS set_name, o.procedure_name, o.ot_room, o.scheduled_date
         FROM set_issue_log l
         JOIN instrument_sets s ON s.id = l.instrument_set_id AND s.tenant_id = l.tenant_id
         JOIN ot_schedules o ON o.id = l.ot_schedule_id AND o.tenant_id = l.tenant_id
        WHERE l.tenant_id = $1::uuid
          AND l.status IN ('issued', 'in_theatre', 'returned', 'awaiting_sterilization')
        ORDER BY l.return_due_at ASC NULLS LAST, l.updated_at DESC
        LIMIT $2`,
      safeTenant,
      safeLimit,
    ),
    prisma.$queryRawUnsafe(
      `SELECT *
         FROM sterilization_loads
        WHERE tenant_id = $1::uuid
        ORDER BY COALESCE(completed_at, started_at, created_at) DESC, id DESC
        LIMIT $2`,
      safeTenant,
      safeLimit,
    ),
  ]);
  const overdueRows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS overdue_returns
       FROM set_issue_log
      WHERE tenant_id = $1::uuid
        AND status IN ('issued', 'in_theatre')
        AND return_due_at IS NOT NULL
        AND return_due_at < $2::timestamptz`,
    safeTenant,
    now.toISOString(),
  );
  return normalizeValue({
    summary: {
      ...(unwrap(setCounts) || {}),
      ...(unwrap(loadCounts) || {}),
      overdue_returns: unwrap(overdueRows)?.overdue_returns || 0,
    },
    active_issues: activeIssues,
    recent_loads: recentLoads,
  });
}

export async function getOtSterilityWarnings({ tenantId, otScheduleId = null, scheduleIds = null } = {}) {
  const safeTenant = tenantOr(tenantId);
  const ids = scheduleIds
    ? [...new Set(scheduleIds.map((id) => intId(id, 'ot_schedule_id')))]
    : [intId(otScheduleId, 'ot_schedule_id')];
  if (!ids.length) return scheduleIds ? new Map() : [];

  const rows = await prisma.$queryRawUnsafe(
    `SELECT l.ot_schedule_id, l.instrument_set_id, l.issue_warning_codes,
            s.set_code, s.display_name, s.status, s.requires_reprocessing, s.last_passed_load_id
       FROM set_issue_log l
       JOIN instrument_sets s ON s.id = l.instrument_set_id AND s.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1::uuid
        AND l.ot_schedule_id = ANY($2::int[])
        AND l.status IN ('issued', 'in_theatre')
      ORDER BY l.issued_at DESC`,
    safeTenant,
    ids,
  );
  const gate = sterilityGateSnapshot();
  const bySchedule = new Map(ids.map((id) => [id, []]));
  for (const row of rows) {
    const codes = new Set([...(row.issue_warning_codes || []), ...warningCodesForSet(row)]);
    for (const code of codes) {
      bySchedule.get(Number(row.ot_schedule_id))?.push({
        code,
        message: code === 'CSSD_SET_NOT_FROM_PASSED_LOAD'
          ? 'Set not from a passed sterilization load'
          : 'Set requires reprocessing before reuse',
        instrument_set_id: Number(row.instrument_set_id),
        set_code: row.set_code,
        display_name: row.display_name,
        ...gate,
      });
    }
  }
  if (scheduleIds) return bySchedule;
  return bySchedule.get(ids[0]) || [];
}

export default {
  validateSetContents,
  deriveLoadStatus,
  getAllowedIssueTransitions,
  listInstrumentSets,
  createInstrumentSet,
  getInstrumentSetLabel,
  listSterilizationLoads,
  createSterilizationLoad,
  transitionSterilizationLoad,
  issueSet,
  listIssues,
  markTheatreUse,
  returnIssuedSet,
  markDecontaminated,
  cancelIssue,
  getCssdBoard,
  getOtSterilityWarnings,
};
