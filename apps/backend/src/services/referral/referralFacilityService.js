// src/services/referral/referralFacilityService.js
//
// Destination facility master for external referrals (migration 680).
// Admin-managed, tenant-scoped CRUD with an `active` soft-delete flag.
// Facility rows are configuration (like mis_report_schedules), not clinical
// writes — the canonical clinical timeline invariant applies to the referral
// rows that *link* a facility (referralService / referralClosedLoopService),
// not to master maintenance here.
//
// The Prisma client generated for the pre-678 schema does not know this
// table, so all access is raw SQL through the hardened prisma singleton —
// the established pattern for this wave.

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { stripHtml } from '../../utils/sanitize.js';
import { requireTenantId } from '../tenant/tenantService.js';

export const REFERRAL_FACILITY_TYPES = Object.freeze([
  'hospital', 'clinic', 'diagnostic', 'specialty_center', 'other',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+0-9()\-\s]{4,20}$/;
const PINCODE_RE = /^[0-9]{6}$/;
const MAX_SPECIALTIES = 20;

function badRequest(message) {
  return AppError.badRequest(message, 'REFERRAL_FACILITY_INVALID');
}

function cleanText(value, max) {
  const text = stripHtml(String(value ?? '')).trim();
  if (!text) return null;
  return text.slice(0, max);
}

function normalizeName(value) {
  const name = cleanText(value, 200);
  if (!name) throw badRequest('name is required');
  return name;
}

function normalizeFacilityType(value) {
  const type = String(value ?? 'hospital').trim().toLowerCase();
  if (!REFERRAL_FACILITY_TYPES.includes(type)) {
    throw badRequest(`facilityType must be one of: ${REFERRAL_FACILITY_TYPES.join(', ')}`);
  }
  return type;
}

function normalizeSpecialties(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw badRequest('specialties must be an array of strings');
  const tags = [...new Set(
    value.map((tag) => stripHtml(String(tag ?? '')).trim().toLowerCase()).filter(Boolean),
  )];
  if (tags.length > MAX_SPECIALTIES) {
    throw badRequest(`specialties must contain at most ${MAX_SPECIALTIES} tags`);
  }
  for (const tag of tags) {
    if (tag.length > 120) throw badRequest('each specialty tag must be at most 120 characters');
  }
  return tags;
}

function normalizePincode(value) {
  const pincode = cleanText(value, 10);
  if (pincode && !PINCODE_RE.test(pincode)) {
    throw badRequest('pincode must be a 6-digit Indian PIN code');
  }
  return pincode;
}

function normalizePhoneNumber(value) {
  const phone = cleanText(value, 20);
  if (phone && !PHONE_RE.test(phone)) {
    throw badRequest('phone must contain only digits, +, -, parentheses, and spaces');
  }
  return phone;
}

function normalizeEmail(value) {
  const email = cleanText(value, 320)?.toLowerCase() ?? null;
  if (email && !EMAIL_RE.test(email)) throw badRequest('email is not a valid address');
  return email;
}

function normalizePayload(payload = {}, existing = null) {
  return {
    name: normalizeName(payload.name ?? existing?.name),
    facilityType: normalizeFacilityType(payload.facilityType ?? existing?.facilityType),
    specialties: normalizeSpecialties(payload.specialties ?? existing?.specialties),
    addressLine1: cleanText(payload.addressLine1 ?? existing?.addressLine1, 300),
    addressLine2: cleanText(payload.addressLine2 ?? existing?.addressLine2, 300),
    city: cleanText(payload.city ?? existing?.city, 120),
    state: cleanText(payload.state ?? existing?.state, 120),
    pincode: normalizePincode(payload.pincode ?? existing?.pincode),
    phone: normalizePhoneNumber(payload.phone ?? existing?.phone),
    email: normalizeEmail(payload.email ?? existing?.email),
    contactPerson: cleanText(payload.contactPerson ?? existing?.contactPerson, 120),
    notes: cleanText(payload.notes ?? existing?.notes, 2000),
  };
}

const FACILITY_COLUMNS = `id, tenant_id, name, facility_type, specialties,
       address_line1, address_line2, city, state, pincode, phone, email,
       contact_person, notes, active, created_by, updated_by, created_at, updated_at`;

function toIso(value) {
  return value instanceof Date ? value.toISOString() : value ?? null;
}

export function toFacility(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    facilityType: row.facility_type,
    specialties: row.specialties || [],
    addressLine1: row.address_line1 ?? null,
    addressLine2: row.address_line2 ?? null,
    city: row.city ?? null,
    state: row.state ?? null,
    pincode: row.pincode ?? null,
    phone: row.phone ?? null,
    email: row.email ?? null,
    contactPerson: row.contact_person ?? null,
    notes: row.notes ?? null,
    active: row.active === true,
    createdBy: row.created_by ?? null,
    updatedBy: row.updated_by ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function facilityId(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(id) || id < 1) throw badRequest('facilityId must be a positive integer');
  return id;
}

function rethrowDuplicate(err) {
  if (err?.meta?.code === '23505' || /ux_referral_facilities_tenant_name_city/.test(String(err?.message))) {
    throw AppError.conflict(
      'A facility with this name already exists in this city',
      'REFERRAL_FACILITY_DUPLICATE',
    );
  }
  throw err;
}

/* ─── CRUD ───────────────────────────────────────────────────────────────── */

export async function listReferralFacilities(tenantId, {
  q = '', facilityType = '', includeInactive = false, limit = 200,
} = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  const query = String(q ?? '').trim().toLowerCase();
  const type = String(facilityType ?? '').trim().toLowerCase();
  if (type && !REFERRAL_FACILITY_TYPES.includes(type)) {
    throw badRequest(`facilityType must be one of: ${REFERRAL_FACILITY_TYPES.join(', ')}`);
  }
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 200, 500));
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${FACILITY_COLUMNS}
       FROM referral_facilities
      WHERE tenant_id = $1::uuid
        AND ($2::boolean OR active = TRUE)
        AND ($3::text = '' OR facility_type = $3::text)
        AND (
          $4::text = ''
          OR LOWER(name) LIKE '%' || $4::text || '%'
          OR LOWER(COALESCE(city, '')) LIKE '%' || $4::text || '%'
          OR EXISTS (
            SELECT 1 FROM unnest(specialties) AS tag
             WHERE LOWER(tag) LIKE '%' || $4::text || '%'
          )
        )
      ORDER BY active DESC, name ASC, id ASC
      LIMIT $5::int`,
    scopedTenantId,
    includeInactive === true || includeInactive === 'true',
    type,
    query,
    safeLimit,
  );
  return rows.map(toFacility);
}

export async function getReferralFacility(tenantId, id) {
  const scopedTenantId = requireTenantId(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${FACILITY_COLUMNS}
       FROM referral_facilities
      WHERE tenant_id = $1::uuid AND id = $2::int
      LIMIT 1`,
    scopedTenantId,
    facilityId(id),
  );
  const facility = toFacility(rows[0]);
  if (!facility) {
    throw AppError.notFound('Referral facility not found', 'REFERRAL_FACILITY_NOT_FOUND');
  }
  return facility;
}

export async function createReferralFacility(tenantId, payload = {}, { actorUid = null } = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  const next = normalizePayload(payload);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO referral_facilities (
         tenant_id, name, facility_type, specialties, address_line1,
         address_line2, city, state, pincode, phone, email, contact_person,
         notes, created_by, updated_by
       )
       VALUES ($1::uuid, $2::text, $3::text, $4::text[], $5::text, $6::text,
               $7::text, $8::text, $9::text, $10::text, $11::text, $12::text,
               $13::text, $14::uuid, $14::uuid)
       RETURNING ${FACILITY_COLUMNS}`,
      scopedTenantId,
      next.name,
      next.facilityType,
      next.specialties,
      next.addressLine1,
      next.addressLine2,
      next.city,
      next.state,
      next.pincode,
      next.phone,
      next.email,
      next.contactPerson,
      next.notes,
      actorUid,
    );
    return toFacility(rows[0]);
  } catch (err) {
    rethrowDuplicate(err);
  }
}

export async function updateReferralFacility(tenantId, id, payload = {}, { actorUid = null } = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  const existing = await getReferralFacility(scopedTenantId, id);
  const next = normalizePayload(payload, existing);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE referral_facilities
          SET name = $3::text, facility_type = $4::text, specialties = $5::text[],
              address_line1 = $6::text, address_line2 = $7::text, city = $8::text,
              state = $9::text, pincode = $10::text, phone = $11::text,
              email = $12::text, contact_person = $13::text, notes = $14::text,
              updated_by = $15::uuid, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int
        RETURNING ${FACILITY_COLUMNS}`,
      scopedTenantId,
      existing.id,
      next.name,
      next.facilityType,
      next.specialties,
      next.addressLine1,
      next.addressLine2,
      next.city,
      next.state,
      next.pincode,
      next.phone,
      next.email,
      next.contactPerson,
      next.notes,
      actorUid,
    );
    return toFacility(rows[0]);
  } catch (err) {
    rethrowDuplicate(err);
  }
}

export async function setReferralFacilityActive(tenantId, id, active, { actorUid = null } = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  if (typeof active !== 'boolean') throw badRequest('active must be a boolean');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE referral_facilities
        SET active = $3::boolean, updated_by = $4::uuid, updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::int
      RETURNING ${FACILITY_COLUMNS}`,
    scopedTenantId,
    facilityId(id),
    active,
    actorUid,
  );
  const facility = toFacility(rows[0]);
  if (!facility) {
    throw AppError.notFound('Referral facility not found', 'REFERRAL_FACILITY_NOT_FOUND');
  }
  return facility;
}

/* ─── referral-linkage validation ────────────────────────────────────────── */

/**
 * Validates that a facility may be linked as the destination of an external
 * referral: it must exist in the caller's tenant and be active. Returns the
 * raw facility row ({id, name, facility_type, city, phone}).
 *
 * `db` is either the prisma singleton or a transaction client — referral
 * creation calls this inside its tx with FOR SHARE so a concurrent
 * deactivation cannot race the linkage.
 */
export async function assertReferralFacilityUsable(db, tenantId, id, { lock = false } = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  const rows = await db.$queryRawUnsafe(
    `SELECT id, name, facility_type, city, phone, active
       FROM referral_facilities
      WHERE tenant_id = $1::uuid AND id = $2::int
      LIMIT 1${lock ? '\n      FOR SHARE' : ''}`,
    scopedTenantId,
    facilityId(id),
  );
  const facility = rows[0];
  if (!facility) {
    throw AppError.notFound('Referral facility not found', 'REFERRAL_FACILITY_NOT_FOUND');
  }
  if (facility.active !== true) {
    throw AppError.conflict(
      'Referral facility is inactive and cannot receive new referrals',
      'REFERRAL_FACILITY_INACTIVE',
    );
  }
  return facility;
}

export default {
  REFERRAL_FACILITY_TYPES,
  listReferralFacilities,
  getReferralFacility,
  createReferralFacility,
  updateReferralFacility,
  setReferralFacilityActive,
  assertReferralFacilityUsable,
};
