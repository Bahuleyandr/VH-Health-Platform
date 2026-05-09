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

function assertClaimId(claimId) {
  const parsed = Number.parseInt(claimId, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest('claim_id must be a positive integer');
  }
  return parsed;
}

/**
 * Bulk-set / replace caps for a claim. Each row is upserted on
 * (claim_id, category). Caps absent from `caps[]` are NOT removed —
 * use deleteCap() for that. This matches TPA workflow where revisions
 * typically add/raise caps without explicitly clearing earlier ones.
 *
 * @param {Object} args
 * @param {number} args.claimId
 * @param {Array<{category, max_amount, currency?, source?, notes?}>} args.caps
 * @param {string} args.actorUid
 */
export async function setClaimCaps({ claimId, caps, actorUid }) {
  const id = assertClaimId(claimId);
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

  const claim = await prisma.insurance_claims.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!claim) throw AppError.notFound(`Claim ${id} not found`);

  const result = await prisma.$transaction(async (tx) => {
    const rows = [];
    for (const c of caps) {
      const row = await tx.insurance_claim_caps.upsert({
        where: { claim_id_category: { claim_id: id, category: c.category } },
        update: {
          max_amount: c.max_amount,
          currency: c.currency ?? 'INR',
          source: c.source ?? 'tpa_preauth',
          notes: c.notes ?? null,
          updated_at: new Date(),
        },
        create: {
          claim_id: id,
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
        resource_id: String(id),
        metadata: { claim_id: id, cap_count: rows.length, categories: rows.map((r) => r.category) },
        ip_address: null,
      },
    });
    return rows;
  });

  logger.info(`Claim caps set: claim=${id} categories=${result.map((r) => r.category).join(',')} by=${actorUid}`);
  return result;
}

export async function getClaimCaps(claimId) {
  const id = assertClaimId(claimId);
  return prisma.insurance_claim_caps.findMany({
    where: { claim_id: id },
    orderBy: { category: 'asc' },
  });
}

export async function deleteCap({ claimId, category, actorUid }) {
  const id = assertClaimId(claimId);
  if (!VALID_CATEGORIES.has(category)) {
    throw AppError.badRequest(`Invalid category: ${category}`);
  }
  if (!actorUid) throw AppError.badRequest('actorUid is required');

  return prisma.$transaction(async (tx) => {
    const existing = await tx.insurance_claim_caps.findUnique({
      where: { claim_id_category: { claim_id: id, category } },
    });
    if (!existing) throw AppError.notFound(`Cap for ${category} not found on claim ${id}`);
    await tx.insurance_claim_caps.delete({ where: { id: existing.id } });
    await tx.audit_logs.create({
      data: {
        uid: actorUid,
        action: 'DELETE_CLAIM_CAP',
        resource: 'insurance_claim_caps',
        resource_id: String(existing.id),
        metadata: { claim_id: id, category, prior_max_amount: existing.max_amount },
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
export async function applyCapsToInvoiceLines(claimId, lines) {
  const id = assertClaimId(claimId);
  if (!Array.isArray(lines)) throw AppError.badRequest('lines must be an array');
  const caps = await prisma.insurance_claim_caps.findMany({
    where: { claim_id: id },
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
