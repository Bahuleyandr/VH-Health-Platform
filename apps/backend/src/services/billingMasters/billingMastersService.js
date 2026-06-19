/**
 * Billing master data service (Phase B3).
 *
 * CRUD over the seven tables added in migration 119:
 *   - payers
 *   - tpas
 *   - tariff_plans / tariff_items
 *   - packages / package_items
 *   - payer_tariff_links
 *
 * Decision-support only: this is a master-data registry, not a pricing
 * engine. resolveServicePrice() is a pure read helper that returns the
 * price for a (tenant, service_code, payer_id?, tpa_id?) tuple by
 * looking up the linked tariff plan; never auto-applies to invoices.
 */

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const TEXT_MAX = 8000;
const SHORT_MAX = 255;

export const PAYER_KINDS = [
  'private_insurance', 'government_scheme', 'corporate', 'self_pay',
  'international_insurance', 'cash_advance', 'other',
];
export const PAYER_STATUSES = ['active', 'paused', 'archived'];
export const TARIFF_PLAN_STATUSES = ['draft', 'active', 'paused', 'archived'];
export const SERVICE_KINDS = [
  'service', 'consultation', 'procedure', 'investigation', 'medication',
  'consumable', 'room', 'package', 'discount', 'other',
];
export const PACKAGE_STATUSES = ['draft', 'active', 'paused', 'archived'];
export const LINK_STATUSES = ['active', 'paused', 'archived'];

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isUniqueViolation(err) {
  return /duplicate key value/i.test(String(err?.message || ''));
}

function isFkViolation(err) {
  return /foreign key constraint/i.test(String(err?.message || ''));
}

function safeText(value, max = TEXT_MAX) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function normalizeLimit(value, fallback = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
}

function normalizeJsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

function normalizeEnum(value, allowed, label, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const text = String(value).trim();
  if (!allowed.includes(text)) {
    throw AppError.badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return text;
}

function normalizeBoolean(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return Boolean(value);
}

function normalizeDate(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw AppError.badRequest(`${label} must be a YYYY-MM-DD date`);
  }
  return text;
}

function normalizeBigInt(value, label, { min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be numeric`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return Math.round(parsed);
}

// ---------------------------------------------------------------------------
// Payers
// ---------------------------------------------------------------------------

const PAYER_RETURNING = `id, tenant_id, payer_code, display_name, payer_kind,
  registration_number, contact_email, contact_phone, address,
  status, ehr_external_id, metadata, created_by, created_at, updated_at`;

export async function upsertPayer({
  tenantId = null,
  id = null,
  payerCode,
  displayName,
  payerKind = 'private_insurance',
  registrationNumber = null,
  contactEmail = null,
  contactPhone = null,
  address = null,
  status = 'active',
  ehrExternalId = null,
  metadata = null,
  createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanCode = safeText(payerCode, 80);
  if (!cleanCode) throw AppError.badRequest('payer_code is required');
  const cleanName = safeText(displayName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('display_name is required');

  if (id) {
    const payerId = normalizeId(id, 'payer id');
    try {
      const rows = await prisma.$queryRawUnsafe(
        `UPDATE payers SET
           payer_code = $1, display_name = $2, payer_kind = $3,
           registration_number = $4, contact_email = $5, contact_phone = $6,
           address = $7, status = $8, ehr_external_id = $9, metadata = $10::jsonb,
           updated_at = NOW()
         WHERE id = $11 AND tenant_id = $12::uuid
         RETURNING ${PAYER_RETURNING}`,
        cleanCode, cleanName,
        normalizeEnum(payerKind, PAYER_KINDS, 'payer_kind') || 'private_insurance',
        safeText(registrationNumber, 120),
        safeText(contactEmail, 255), safeText(contactPhone, 40),
        safeText(address),
        normalizeEnum(status, PAYER_STATUSES, 'status') || 'active',
        safeText(ehrExternalId, 120),
        JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
        payerId, tid,
      );
      if (!rows[0]) throw AppError.notFound('Payer not found');
      return rows[0];
    } catch (err) {
      if (isUniqueViolation(err)) throw AppError.conflict('payer_code already exists');
      throw err;
    }
  }

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO payers
         (tenant_id, payer_code, display_name, payer_kind,
          registration_number, contact_email, contact_phone, address,
          status, ehr_external_id, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::uuid)
       RETURNING ${PAYER_RETURNING}`,
      tid, cleanCode, cleanName,
      normalizeEnum(payerKind, PAYER_KINDS, 'payer_kind') || 'private_insurance',
      safeText(registrationNumber, 120),
      safeText(contactEmail, 255), safeText(contactPhone, 40),
      safeText(address),
      normalizeEnum(status, PAYER_STATUSES, 'status') || 'active',
      safeText(ehrExternalId, 120),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      maybeUuid(createdBy, 'created_by'),
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('payer_code already exists');
    throw err;
  }
}

export async function listPayers({
  tenantId = null, status = null, payerKind = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, PAYER_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (payerKind) {
    params.push(normalizeEnum(payerKind, PAYER_KINDS, 'payer_kind'));
    filters.push(`payer_kind = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${PAYER_RETURNING} FROM payers
       WHERE ${filters.join(' AND ')}
       ORDER BY display_name
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { payers: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { payers: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// TPAs
// ---------------------------------------------------------------------------

const TPA_RETURNING = `id, tenant_id, tpa_code, display_name, parent_payer_id,
  irda_license_number, contact_email, contact_phone, address,
  status, ehr_external_id, metadata, created_by, created_at, updated_at`;

export async function upsertTpa({
  tenantId = null,
  id = null,
  tpaCode,
  displayName,
  parentPayerId = null,
  irdaLicenseNumber = null,
  contactEmail = null,
  contactPhone = null,
  address = null,
  status = 'active',
  ehrExternalId = null,
  metadata = null,
  createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanCode = safeText(tpaCode, 80);
  if (!cleanCode) throw AppError.badRequest('tpa_code is required');
  const cleanName = safeText(displayName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('display_name is required');

  const args = [
    cleanCode, cleanName,
    parentPayerId ? normalizeId(parentPayerId, 'parent_payer_id') : null,
    safeText(irdaLicenseNumber, 120),
    safeText(contactEmail, 255), safeText(contactPhone, 40),
    safeText(address),
    normalizeEnum(status, PAYER_STATUSES, 'status') || 'active',
    safeText(ehrExternalId, 120),
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
  ];

  try {
    if (id) {
      const tpaId = normalizeId(id, 'tpa id');
      const rows = await prisma.$queryRawUnsafe(
        `UPDATE tpas SET
           tpa_code = $1, display_name = $2, parent_payer_id = $3,
           irda_license_number = $4, contact_email = $5, contact_phone = $6,
           address = $7, status = $8, ehr_external_id = $9, metadata = $10::jsonb,
           updated_at = NOW()
         WHERE id = $11 AND tenant_id = $12::uuid
         RETURNING ${TPA_RETURNING}`,
        ...args, tpaId, tid,
      );
      if (!rows[0]) throw AppError.notFound('TPA not found');
      return rows[0];
    }
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO tpas
         (tenant_id, tpa_code, display_name, parent_payer_id,
          irda_license_number, contact_email, contact_phone, address,
          status, ehr_external_id, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::uuid)
       RETURNING ${TPA_RETURNING}`,
      tid, ...args, maybeUuid(createdBy, 'created_by'),
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('tpa_code already exists');
    if (isFkViolation(err)) throw AppError.badRequest('parent_payer_id is invalid');
    throw err;
  }
}

export async function listTpas({
  tenantId = null, status = null, parentPayerId = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, PAYER_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (parentPayerId) {
    params.push(normalizeId(parentPayerId, 'parent_payer_id'));
    filters.push(`parent_payer_id = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${TPA_RETURNING} FROM tpas
       WHERE ${filters.join(' AND ')}
       ORDER BY display_name
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { tpas: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { tpas: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Tariff plans + items
// ---------------------------------------------------------------------------

const TARIFF_PLAN_RETURNING = `id, tenant_id, plan_code, display_name, description,
  is_default, currency, effective_from, effective_to, status,
  metadata, created_by, created_at, updated_at`;

const TARIFF_ITEM_RETURNING = `id, tenant_id, tariff_plan_id, service_code, service_kind,
  display_name, unit_price_minor, unit_label, taxable, tax_rate_pct,
  effective_from, effective_to, metadata, created_at, updated_at`;

export async function upsertTariffPlan({
  tenantId = null, id = null,
  planCode, displayName, description = null,
  isDefault = false, currency = 'INR',
  effectiveFrom = null, effectiveTo = null,
  status = 'active', metadata = null, createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanCode = safeText(planCode, 80);
  if (!cleanCode) throw AppError.badRequest('plan_code is required');
  const cleanName = safeText(displayName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('display_name is required');
  const cleanStatus = normalizeEnum(status, TARIFF_PLAN_STATUSES, 'status') || 'active';
  const flagDefault = normalizeBoolean(isDefault, false);

  // Demote other defaults if making this one the default + active.
  if (flagDefault && cleanStatus === 'active') {
    try {
      await prisma.$queryRawUnsafe(
        `UPDATE tariff_plans
         SET is_default = false, updated_at = NOW()
         WHERE tenant_id = $1::uuid AND is_default = true AND status = 'active' AND plan_code <> $2`,
        tid, cleanCode,
      );
    } catch (err) {
      if (!isMissingSchemaError(err)) throw err;
    }
  }

  const args = [
    cleanCode, cleanName, safeText(description),
    flagDefault, safeText(currency, 8) || 'INR',
    normalizeDate(effectiveFrom, 'effective_from'),
    normalizeDate(effectiveTo, 'effective_to'),
    cleanStatus,
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
  ];

  try {
    if (id) {
      const planId = normalizeId(id, 'tariff_plan id');
      const rows = await prisma.$queryRawUnsafe(
        `UPDATE tariff_plans SET
           plan_code = $1, display_name = $2, description = $3,
           is_default = $4, currency = $5, effective_from = $6::date, effective_to = $7::date,
           status = $8, metadata = $9::jsonb, updated_at = NOW()
         WHERE id = $10 AND tenant_id = $11::uuid
         RETURNING ${TARIFF_PLAN_RETURNING}`,
        ...args, planId, tid,
      );
      if (!rows[0]) throw AppError.notFound('Tariff plan not found');
      return rows[0];
    }
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO tariff_plans
         (tenant_id, plan_code, display_name, description,
          is_default, currency, effective_from, effective_to, status,
          metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::date, $8::date, $9, $10::jsonb, $11::uuid)
       RETURNING ${TARIFF_PLAN_RETURNING}`,
      tid, ...args, maybeUuid(createdBy, 'created_by'),
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('plan_code already exists');
    throw err;
  }
}

export async function listTariffPlans({
  tenantId = null, status = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, TARIFF_PLAN_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${TARIFF_PLAN_RETURNING} FROM tariff_plans
       WHERE ${filters.join(' AND ')}
       ORDER BY is_default DESC, display_name
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { plans: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { plans: [], count: 0 };
    throw err;
  }
}

export async function upsertTariffItem({
  tenantId = null, id = null,
  tariffPlanId, serviceCode, serviceKind = 'service',
  displayName, unitPriceMinor,
  unitLabel = 'each', taxable = false, taxRatePct = null,
  effectiveFrom = null, effectiveTo = null, metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const planId = normalizeId(tariffPlanId, 'tariff_plan_id');
  const cleanService = safeText(serviceCode, 120);
  if (!cleanService) throw AppError.badRequest('service_code is required');
  const cleanName = safeText(displayName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('display_name is required');
  const price = normalizeBigInt(unitPriceMinor, 'unit_price_minor', { min: 0, max: 1_000_000_000_000 });
  if (price == null) throw AppError.badRequest('unit_price_minor is required');

  let taxRate = null;
  if (taxRatePct != null) {
    const v = Number(taxRatePct);
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      throw AppError.badRequest('tax_rate_pct must be 0..100');
    }
    taxRate = v;
  }

  const args = [
    planId, cleanService,
    normalizeEnum(serviceKind, SERVICE_KINDS, 'service_kind') || 'service',
    cleanName, price,
    safeText(unitLabel, 40) || 'each',
    normalizeBoolean(taxable, false),
    taxRate,
    normalizeDate(effectiveFrom, 'effective_from'),
    normalizeDate(effectiveTo, 'effective_to'),
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
  ];

  try {
    if (id) {
      const itemId = normalizeId(id, 'tariff_item id');
      const rows = await prisma.$queryRawUnsafe(
        `UPDATE tariff_items SET
           tariff_plan_id = $1, service_code = $2, service_kind = $3,
           display_name = $4, unit_price_minor = $5,
           unit_label = $6, taxable = $7, tax_rate_pct = $8,
           effective_from = $9::date, effective_to = $10::date, metadata = $11::jsonb,
           updated_at = NOW()
         WHERE id = $12 AND tenant_id = $13::uuid
         RETURNING ${TARIFF_ITEM_RETURNING}`,
        ...args, itemId, tid,
      );
      if (!rows[0]) throw AppError.notFound('Tariff item not found');
      return rows[0];
    }
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO tariff_items
         (tenant_id, tariff_plan_id, service_code, service_kind,
          display_name, unit_price_minor,
          unit_label, taxable, tax_rate_pct,
          effective_from, effective_to, metadata)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11::date, $12::jsonb)
       RETURNING ${TARIFF_ITEM_RETURNING}`,
      tid, ...args,
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('service_code already exists in this plan');
    throw err;
  }
}

export async function listTariffItems({
  tenantId = null, tariffPlanId, serviceKind = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const planId = normalizeId(tariffPlanId, 'tariff_plan_id');
  const filters = ['tenant_id = $1::uuid', 'tariff_plan_id = $2'];
  const params = [tid, planId];
  if (serviceKind) {
    params.push(normalizeEnum(serviceKind, SERVICE_KINDS, 'service_kind'));
    filters.push(`service_kind = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${TARIFF_ITEM_RETURNING} FROM tariff_items
       WHERE ${filters.join(' AND ')}
       ORDER BY service_kind, service_code
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { items: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { items: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Packages + items
// ---------------------------------------------------------------------------

const PACKAGE_RETURNING = `id, tenant_id, package_code, display_name, description,
  base_specialty, base_procedure_code, duration_days,
  fixed_price_minor, currency, status, exclusion_notes, inclusion_notes,
  metadata, created_by, created_at, updated_at`;

export async function upsertPackage({
  tenantId = null, id = null,
  packageCode, displayName, description = null,
  baseSpecialty = null, baseProcedureCode = null, durationDays = null,
  fixedPriceMinor = null, currency = 'INR',
  status = 'active', exclusionNotes = null, inclusionNotes = null,
  metadata = null, createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanCode = safeText(packageCode, 120);
  if (!cleanCode) throw AppError.badRequest('package_code is required');
  const cleanName = safeText(displayName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('display_name is required');
  const args = [
    cleanCode, cleanName, safeText(description),
    safeText(baseSpecialty, 120),
    safeText(baseProcedureCode, 120),
    durationDays == null ? null : normalizeBigInt(durationDays, 'duration_days', { min: 0, max: 365 }),
    normalizeBigInt(fixedPriceMinor, 'fixed_price_minor', { min: 0, max: 1_000_000_000_000 }),
    safeText(currency, 8) || 'INR',
    normalizeEnum(status, PACKAGE_STATUSES, 'status') || 'active',
    safeText(exclusionNotes), safeText(inclusionNotes),
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
  ];
  try {
    if (id) {
      const pkgId = normalizeId(id, 'package id');
      const rows = await prisma.$queryRawUnsafe(
        `UPDATE packages SET
           package_code = $1, display_name = $2, description = $3,
           base_specialty = $4, base_procedure_code = $5, duration_days = $6,
           fixed_price_minor = $7, currency = $8, status = $9,
           exclusion_notes = $10, inclusion_notes = $11, metadata = $12::jsonb,
           updated_at = NOW()
         WHERE id = $13 AND tenant_id = $14::uuid
         RETURNING ${PACKAGE_RETURNING}`,
        ...args, pkgId, tid,
      );
      if (!rows[0]) throw AppError.notFound('Package not found');
      return rows[0];
    }
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO packages
         (tenant_id, package_code, display_name, description,
          base_specialty, base_procedure_code, duration_days,
          fixed_price_minor, currency, status,
          exclusion_notes, inclusion_notes, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::uuid)
       RETURNING ${PACKAGE_RETURNING}`,
      tid, ...args, maybeUuid(createdBy, 'created_by'),
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('package_code already exists');
    throw err;
  }
}

export async function listPackages({
  tenantId = null, status = null, baseSpecialty = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, PACKAGE_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (baseSpecialty) {
    params.push(safeText(baseSpecialty, 120));
    filters.push(`base_specialty = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${PACKAGE_RETURNING} FROM packages
       WHERE ${filters.join(' AND ')}
       ORDER BY display_name
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { packages: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { packages: [], count: 0 };
    throw err;
  }
}

export async function addPackageItem({
  tenantId = null, packageId,
  serviceCode, serviceKind = 'service',
  displayName, quantity = 1, unitPriceMinor = null,
  isIncluded = true, notes = null, metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const pkgId = normalizeId(packageId, 'package_id');
  const cleanService = safeText(serviceCode, 120);
  if (!cleanService) throw AppError.badRequest('service_code is required');
  const cleanName = safeText(displayName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('display_name is required');

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO package_items
         (tenant_id, package_id, service_code, service_kind,
          display_name, quantity, unit_price_minor,
          is_included, notes, metadata)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       RETURNING id, tenant_id, package_id, service_code, service_kind,
                 display_name, quantity, unit_price_minor,
                 is_included, notes, metadata, created_at, updated_at`,
      tid, pkgId, cleanService,
      normalizeEnum(serviceKind, SERVICE_KINDS, 'service_kind') || 'service',
      cleanName,
      Number.isFinite(Number(quantity)) ? Number(quantity) : 1,
      normalizeBigInt(unitPriceMinor, 'unit_price_minor', { min: 0, max: 1_000_000_000_000 }),
      normalizeBoolean(isIncluded, true),
      safeText(notes),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid package_id');
    throw err;
  }
}

export async function listPackageItems({ tenantId = null, packageId } = {}) {
  const tid = resolveTenantId({ tenantId });
  const pkgId = normalizeId(packageId, 'package_id');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, package_id, service_code, service_kind,
              display_name, quantity, unit_price_minor, is_included,
              notes, metadata, created_at, updated_at
       FROM package_items
       WHERE tenant_id = $1::uuid AND package_id = $2
       ORDER BY service_kind, service_code`,
      tid, pkgId,
    );
    return { items: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { items: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Payer ↔ tariff plan link
// ---------------------------------------------------------------------------

const LINK_RETURNING = `id, tenant_id, payer_id, tpa_id, tariff_plan_id,
  is_primary, effective_from, effective_to, status,
  metadata, created_by, created_at, updated_at`;

export async function linkPayerTariff({
  tenantId = null,
  payerId = null, tpaId = null,
  tariffPlanId,
  isPrimary = false,
  effectiveFrom = null, effectiveTo = null,
  status = 'active', metadata = null, createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  if (!payerId && !tpaId) throw AppError.badRequest('payer_id or tpa_id is required');
  const planId = normalizeId(tariffPlanId, 'tariff_plan_id');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO payer_tariff_links
         (tenant_id, payer_id, tpa_id, tariff_plan_id,
          is_primary, effective_from, effective_to, status, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::date, $7::date, $8, $9::jsonb, $10::uuid)
       RETURNING ${LINK_RETURNING}`,
      tid,
      payerId ? normalizeId(payerId, 'payer_id') : null,
      tpaId ? normalizeId(tpaId, 'tpa_id') : null,
      planId,
      normalizeBoolean(isPrimary, false),
      normalizeDate(effectiveFrom, 'effective_from'),
      normalizeDate(effectiveTo, 'effective_to'),
      normalizeEnum(status, LINK_STATUSES, 'status') || 'active',
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      maybeUuid(createdBy, 'created_by'),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function listPayerTariffLinks({
  tenantId = null, payerId = null, tpaId = null,
  tariffPlanId = null, status = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (payerId) {
    params.push(normalizeId(payerId, 'payer_id'));
    filters.push(`payer_id = $${params.length}`);
  }
  if (tpaId) {
    params.push(normalizeId(tpaId, 'tpa_id'));
    filters.push(`tpa_id = $${params.length}`);
  }
  if (tariffPlanId) {
    params.push(normalizeId(tariffPlanId, 'tariff_plan_id'));
    filters.push(`tariff_plan_id = $${params.length}`);
  }
  if (status) {
    params.push(normalizeEnum(status, LINK_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${LINK_RETURNING} FROM payer_tariff_links
       WHERE ${filters.join(' AND ')}
       ORDER BY is_primary DESC, created_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { links: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { links: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Pure read helper — resolve a service price for a (payer/tpa) on date.
// ---------------------------------------------------------------------------

export async function resolveServicePrice({
  tenantId = null,
  serviceCode,
  payerId = null,
  tpaId = null,
  asOf = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanCode = safeText(serviceCode, 120);
  if (!cleanCode) throw AppError.badRequest('service_code is required');
  const date = asOf ? normalizeDate(asOf, 'as_of') : null;
  const subjectFilters = ['ptl.tenant_id = $1::uuid', `ptl.status = 'active'`];
  const params = [tid];
  if (payerId) {
    params.push(normalizeId(payerId, 'payer_id'));
    subjectFilters.push(`ptl.payer_id = $${params.length}`);
  } else if (tpaId) {
    params.push(normalizeId(tpaId, 'tpa_id'));
    subjectFilters.push(`ptl.tpa_id = $${params.length}`);
  } else {
    subjectFilters.push(`ptl.is_primary = true`);
  }

  if (date) {
    params.push(date);
    subjectFilters.push(`(ptl.effective_from IS NULL OR ptl.effective_from <= $${params.length}::date)`);
    params.push(date);
    subjectFilters.push(`(ptl.effective_to IS NULL OR ptl.effective_to >= $${params.length}::date)`);
  }

  params.push(cleanCode);
  const serviceParam = `$${params.length}`;
  if (date) {
    params.push(date);
    params.push(date);
  }

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ti.id AS tariff_item_id,
              ti.tariff_plan_id,
              ti.service_code,
              ti.service_kind,
              ti.display_name,
              ti.unit_price_minor,
              ti.unit_label,
              ti.taxable,
              ti.tax_rate_pct,
              tp.plan_code,
              tp.display_name AS plan_display_name,
              ptl.payer_id,
              ptl.tpa_id,
              ptl.is_primary,
              ptl.effective_from AS link_effective_from,
              ptl.effective_to AS link_effective_to
       FROM payer_tariff_links ptl
       JOIN tariff_plans tp ON tp.id = ptl.tariff_plan_id AND tp.status = 'active'
       JOIN tariff_items ti ON ti.tariff_plan_id = tp.id AND ti.tenant_id = ptl.tenant_id
       WHERE ${subjectFilters.join(' AND ')}
         AND ti.service_code = ${serviceParam}
         ${date ? `AND (ti.effective_from IS NULL OR ti.effective_from <= $${params.length - 1}::date)
                  AND (ti.effective_to IS NULL OR ti.effective_to >= $${params.length}::date)` : ''}
       ORDER BY ptl.is_primary DESC, tp.is_default DESC
       LIMIT 1`,
      ...params,
    );
    return rows[0] || null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

export const __testing__ = {
  PAYER_KINDS,
  PAYER_STATUSES,
  TARIFF_PLAN_STATUSES,
  SERVICE_KINDS,
  PACKAGE_STATUSES,
  LINK_STATUSES,
};

export default {
  upsertPayer,
  listPayers,
  upsertTpa,
  listTpas,
  upsertTariffPlan,
  listTariffPlans,
  upsertTariffItem,
  listTariffItems,
  upsertPackage,
  listPackages,
  addPackageItem,
  listPackageItems,
  linkPayerTariff,
  listPayerTariffLinks,
  resolveServicePrice,
};
