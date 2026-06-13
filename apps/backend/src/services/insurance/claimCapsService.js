// src/services/insurance/claimCapsService.js
//
// A11 — structured per-category caps for TPA / insurance claims.
//
// Companion to insuranceClaimsService. The legacy path stuffed cap
// data into insurance_claims.documents jsonb (batch 9 caps-merge).
// This service writes structured rows to insurance_claim_caps
// (migration 178) so:
//
//   - billing can query (claim_id, category) -> max_amount with an
//     index lookup at invoice creation
//   - dashboards can aggregate caps across live claims by category
//   - revisions overwrite a single row instead of restringifying jsonb
//
// Wrong-table-tpa batch 4 — `insurance_claim_caps` was extended in
// migration 197 to also reference `tpa_claims`. The Sprint 5 TPA
// workflow lives there (see CLAUDE.md table-split note), and the
// /api/v1/insurance/claims/:id/caps surface receives a tpa_claims id
// today. Before 197, every cap POST returned 404 because the service
// only probed the legacy `insurance_claims` side. Now we probe both
// tables and write to the correct parent column. Each row carries
// exactly one of (claim_id, tpa_claim_id) — CHECK constraint in 197.
//
// Categories mirror the existing invoice-line buckets.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

const VALID_CATEGORIES = new Set([
  'room_rent', 'pharmacy', 'investigations', 'consultation',
  'procedure', 'implants', 'radiology', 'physiotherapy', 'other',
]);
const VALID_SOURCES = new Set([
  'tpa_preauth', 'tpa_revision', 'policy_default', 'manual_override',
]);

function parseClaimId(claimId) {
  const parsed = Number.parseInt(claimId, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest('claim_id must be a positive integer');
  }
  return parsed;
}

/**
 * Probe both `insurance_claims` and `tpa_claims` for the supplied id
 * and return a discriminator the rest of the service uses to choose
 * the right FK column. The two tables use independent SERIAL ids
 * starting at 1, so the same numeric id can exist in both; we prefer
 * `tpa_claims` when both match because that's the surface the route
 * (`/api/v1/insurance/claims/:id`) actively writes to today.
 *
 * Tenant scoping is MANDATORY (fail closed). `insurance_claim_caps` has no
 * tenant_id column and no RLS policy of its own (migrations 178/197/304); caps
 * rows inherit tenant isolation ONLY transitively through this parent-claim
 * lookup. A missing tenantId would probe insurance_claims/tpa_claims by id
 * alone and hand back cross-tenant reach, so we refuse it outright rather than
 * leave the unscoped path as a latent footgun for a future caller.
 *
 * @param {number|string} claimId
 * @param {string} tenantId  REQUIRED — throws 403 TENANT_SCOPE_REQUIRED if falsy.
 * @returns {{ id: number, side: 'legacy'|'tpa', whereByParent: object }}
 */
async function resolveClaimTarget(claimId, tenantId) {
  if (!tenantId) {
    throw AppError.forbidden(
      'Tenant context is required for claim cap operations',
      'TENANT_SCOPE_REQUIRED',
    );
  }
  const id = parseClaimId(claimId);
  const where = { id, tenant_id: String(tenantId) };
  const [tpa, legacy] = await Promise.all([
    prisma.tpa_claims.findFirst({
      where,
      select: { id: true, tenant_id: true, patient_uid: true },
    }),
    prisma.insurance_claims.findFirst({
      where,
      select: { id: true, tenant_id: true, patient_uid: true },
    }),
  ]);
  if (tpa) {
    return { id, side: 'tpa', tenant_id: tpa.tenant_id, patient_uid: tpa.patient_uid, whereByParent: { tpa_claim_id: id } };
  }
  if (legacy) {
    return { id, side: 'legacy', tenant_id: legacy.tenant_id, patient_uid: legacy.patient_uid, whereByParent: { claim_id: id } };
  }
  throw AppError.notFound(`Claim ${id} not found`);
}

/**
 * Bulk-set / replace caps for a claim. Each row is upserted on
 * (parent_id, category) — partial unique indexes in migration 197
 * enforce the constraint per parent side. Caps absent from `caps[]`
 * are NOT removed — use deleteCap() for that. This matches TPA
 * workflow where revisions typically add/raise caps without
 * explicitly clearing earlier ones.
 *
 * @param {Object} args
 * @param {number} args.claimId
 * @param {Array<{category, max_amount, currency?, source?, notes?}>} args.caps
 * @param {string} args.actorUid
 */
export async function setClaimCaps({ tenantId, claimId, caps, actorUid }) {
  if (!actorUid) throw AppError.badRequest('actorUid is required');
  if (!Array.isArray(caps) || caps.length === 0) {
    throw AppError.badRequest('caps must be a non-empty array');
  }
  for (const c of caps) {
    if (!c.category || !VALID_CATEGORIES.has(c.category)) {
      throw AppError.badRequest(`Invalid category: ${c.category}. Must be one of: ${[...VALID_CATEGORIES].join(', ')}`);
    }
    if (c.max_amount == null || Number.isNaN(Number(c.max_amount)) || Number(c.max_amount) < 0) {
      throw AppError.badRequest(`Cap for ${c.category} requires a non-negative max_amount`);
    }
    if (c.source && !VALID_SOURCES.has(c.source)) {
      throw AppError.badRequest(`Invalid source: ${c.source}. Must be one of: ${[...VALID_SOURCES].join(', ')}`);
    }
  }

  const target = await resolveClaimTarget(claimId, tenantId);

  const result = await prisma.$transaction(async (tx) => {
    const rows = [];
    for (const c of caps) {
      const existing = await tx.insurance_claim_caps.findFirst({
        where: { ...target.whereByParent, category: c.category },
      });
      const row = existing
        ? await tx.insurance_claim_caps.update({
            where: { id: existing.id },
            data: {
              max_amount: c.max_amount,
              currency: c.currency ?? 'INR',
              source: c.source ?? 'tpa_preauth',
              notes: c.notes ?? null,
              updated_at: new Date(),
            },
          })
        : await tx.insurance_claim_caps.create({
            data: {
              ...target.whereByParent,
              category: c.category,
              max_amount: c.max_amount,
              currency: c.currency ?? 'INR',
              source: c.source ?? 'tpa_preauth',
              notes: c.notes ?? null,
              created_by: actorUid,
            },
          });
      rows.push(row);
    }
    await tx.audit_logs.create({
      data: {
        uid: actorUid,
        action: 'SET_CLAIM_CAPS',
        resource: 'insurance_claim_caps',
        resource_id: String(target.id),
        metadata: {
          claim_id: target.id,
          claim_side: target.side,
          tenant_id: target.tenant_id,
          cap_count: rows.length,
          categories: rows.map((r) => r.category),
        },
        ip_address: null,
      },
    });
    return rows;
  });

  logger.info(`Claim caps set: ${target.side}=${target.id} categories=${result.map((r) => r.category).join(',')} by=${actorUid}`);
  return result;
}

export async function getClaimCaps(claimId, { tenantId } = {}) {
  const target = await resolveClaimTarget(claimId, tenantId);
  return prisma.insurance_claim_caps.findMany({
    where: target.whereByParent,
    orderBy: { category: 'asc' },
  });
}

export async function deleteCap({ tenantId, claimId, category, actorUid }) {
  if (!VALID_CATEGORIES.has(category)) {
    throw AppError.badRequest(`Invalid category: ${category}`);
  }
  if (!actorUid) throw AppError.badRequest('actorUid is required');
  const target = await resolveClaimTarget(claimId, tenantId);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.insurance_claim_caps.findFirst({
      where: { ...target.whereByParent, category },
    });
    if (!existing) throw AppError.notFound(`Cap for ${category} not found on claim ${target.id}`);
    await tx.insurance_claim_caps.delete({ where: { id: existing.id } });
    await tx.audit_logs.create({
      data: {
        uid: actorUid,
        action: 'DELETE_CLAIM_CAP',
        resource: 'insurance_claim_caps',
        resource_id: String(existing.id),
        metadata: {
          claim_id: target.id,
          claim_side: target.side,
          tenant_id: target.tenant_id,
          category,
          prior_max_amount: existing.max_amount,
        },
        ip_address: null,
      },
    });
    return { deleted: true, category };
  });
}

/**
 * Apply caps to an array of (category, amount) lines. Pure function
 * that returns a per-line breakdown so the caller can decide whether
 * to truncate, alert, or block.
 *
 * @param {number} claimId
 * @param {Array<{category, amount}>} lines
 * @returns {{
 *   total_uncapped: number,
 *   total_capped: number,
 *   any_breached: boolean,
 *   lines: Array<{category, amount, capped_amount, cap_breached, cap}>
 * }}
 */
export async function applyCapsToInvoiceLines(claimId, lines, { tenantId } = {}) {
  if (!Array.isArray(lines)) throw AppError.badRequest('lines must be an array');
  const target = await resolveClaimTarget(claimId, tenantId);
  const caps = await prisma.insurance_claim_caps.findMany({
    where: target.whereByParent,
  });
  const capByCategory = new Map(caps.map((c) => [c.category, c]));

  // Caps apply category-aggregate, so accumulate spend per category
  // before deciding what's payable. Two pharmacy lines that each fit
  // under the cap individually but together exceed it should be
  // capped on the second line, not silently approved.
  const accumulated = new Map();
  let totalUncapped = 0;
  let totalCapped = 0;
  let anyBreached = false;
  const out = [];
  for (const line of lines) {
    const amount = Number(line.amount) || 0;
    const cap = capByCategory.get(line.category);
    totalUncapped += amount;
    if (!cap) {
      totalCapped += amount;
      out.push({ ...line, amount, capped_amount: amount, cap_breached: false, cap: null });
      continue;
    }
    const used = Number(accumulated.get(line.category) || 0);
    const remaining = Math.max(0, Number(cap.max_amount) - used);
    const cappedAmount = Math.min(amount, remaining);
    if (cappedAmount < amount) anyBreached = true;
    accumulated.set(line.category, used + cappedAmount);
    totalCapped += cappedAmount;
    out.push({
      ...line,
      amount,
      capped_amount: cappedAmount,
      cap_breached: cappedAmount < amount,
      cap: { max_amount: Number(cap.max_amount), source: cap.source },
    });
  }
  return {
    total_uncapped: totalUncapped,
    total_capped: totalCapped,
    any_breached: anyBreached,
    lines: out,
  };
}

export default {
  setClaimCaps,
  getClaimCaps,
  deleteCap,
  applyCapsToInvoiceLines,
};
