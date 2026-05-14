// src/services/insurance/packagesService.js
//
// Stage-5 fix — package master read surface + cost estimator.
//
// The `packages` master (migration 119, seeded by 195) carries
// fixed-price day-care / surgical packages. Before this surface the
// admission counter and the TPA pre-auth both took `estimated_cost` /
// `expected_cost` as free-text — nothing tied the figure to a package.
// This module exposes the master and a calculator so the counter can
// derive an itemised estimate (package base + length-of-stay extension
// + room-category upgrade) and write THAT into the pre-auth.
//
// The package base price is real (finance-seeded). Length-of-stay
// extension and room upgrades have no per-day tariff master to price
// from — those lines are emitted explicitly flagged for financial
// review rather than guessed, because a wrong number here flows
// straight into a TPA pre-auth and caps the sanctioned amount.
//
// Finding: 2026-05-09-tpa-insurance-claim-admission-no-estimated-cost-package-calculator

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

const REVIEW_PLACEHOLDER = '[PLACEHOLDER — clinical/financial review required]';

// Room-category rank — mirrors claimsService.ROOM_CATEGORY_RANK so a
// requested room above the package's bedded category surfaces an
// upgrade-delta line.
const ROOM_CATEGORY_RANK = {
  general: 1,
  semi_private: 2,
  'semi-private': 2,
  semiprivate: 2,
  private: 3,
  deluxe: 4,
  suite: 5,
  icu: 5,
  ccu: 5,
};

export async function listPackages({ tenantId, specialty, status = 'active', q }) {
  const params = [tenantId];
  const where = [`tenant_id = $1::uuid`];
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (specialty) {
    params.push(specialty);
    where.push(`base_specialty = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    where.push(
      `(display_name ILIKE $${params.length} OR package_code ILIKE $${params.length})`,
    );
  }
  return prisma.$queryRawUnsafe(
    `SELECT id, package_code, display_name, description, base_specialty,
            base_procedure_code, duration_days, fixed_price_minor, currency,
            status, inclusion_notes, exclusion_notes
       FROM packages
      WHERE ${where.join(' AND ')}
      ORDER BY base_specialty NULLS LAST, display_name`,
    ...params,
  );
}

export async function getPackage({ tenantId, id }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, package_code, display_name, description, base_specialty,
            base_procedure_code, duration_days, fixed_price_minor, currency,
            status, inclusion_notes, exclusion_notes, metadata
       FROM packages
      WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(id), tenantId,
  );
  if (!rows.length) throw AppError.notFound('Package not found');
  const items = await prisma.$queryRawUnsafe(
    `SELECT id, service_code, service_kind, display_name, quantity,
            unit_price_minor, is_included, notes
       FROM package_items
      WHERE package_id = $1::int AND tenant_id = $2::uuid
      ORDER BY id`,
    Number(id), tenantId,
  );
  return { ...rows[0], items };
}

/**
 * Estimate the cost of a package for a given room category + length of
 * stay. Returns an itemised breakdown. The package base price is the
 * one finance-approved figure; extended-stay and room-upgrade lines are
 * emitted flagged for review — the platform has no per-day room tariff
 * master to price them from. `estimated_total_minor` therefore counts
 * only the priced lines and is a LOWER BOUND when any line is flagged.
 */
export async function estimatePackageCost({
  tenantId, package_id, package_code, room_category, los_days,
}) {
  if (!package_id && !package_code) {
    throw AppError.badRequest('package_id or package_code is required');
  }
  const params = [tenantId];
  let lookup;
  if (package_id) {
    params.push(Number(package_id));
    lookup = `id = $2::int`;
  } else {
    params.push(String(package_code).toUpperCase());
    lookup = `UPPER(package_code) = $2`;
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, package_code, display_name, base_specialty, duration_days,
            fixed_price_minor, currency, status, inclusion_notes, exclusion_notes
       FROM packages
      WHERE tenant_id = $1::uuid AND ${lookup}`,
    ...params,
  );
  if (!rows.length) throw AppError.notFound('Package not found');
  const pkg = rows[0];

  const basePrice = pkg.fixed_price_minor != null ? Number(pkg.fixed_price_minor) : null;
  const lineItems = [];
  const reviewFlags = [];

  // 1. Package base — the one real, finance-approved figure.
  lineItems.push({
    kind: 'package_base',
    label: `${pkg.display_name} (bundled ${pkg.duration_days ?? 1} day(s))`,
    amount_minor: basePrice,
    review_required: basePrice == null,
  });
  if (basePrice == null) {
    reviewFlags.push(
      `Package ${pkg.package_code} has no fixed_price_minor set — ${REVIEW_PLACEHOLDER}`,
    );
  }

  // 2. Length-of-stay extension beyond the bundled duration.
  const bundledDays = Number(pkg.duration_days ?? 1);
  const requestedDays = los_days != null ? Number(los_days) : null;
  if (requestedDays != null && Number.isFinite(requestedDays) && requestedDays > bundledDays) {
    const extraDays = requestedDays - bundledDays;
    lineItems.push({
      kind: 'extended_stay',
      label: `Extended stay — ${extraDays} day(s) beyond bundled ${bundledDays}`,
      amount_minor: null,
      review_required: true,
      note: REVIEW_PLACEHOLDER,
    });
    reviewFlags.push(
      `Extended stay of ${extraDays} day(s) needs a per-day room tariff — ${REVIEW_PLACEHOLDER}`,
    );
  }

  // 3. Room-category upgrade vs the package's bedded category. Packages
  //    don't currently carry a bedded room category, so the bundle is
  //    treated as general ward until a richer master is added.
  if (room_category) {
    const reqRank = ROOM_CATEGORY_RANK[String(room_category).toLowerCase()] || 0;
    if (reqRank > ROOM_CATEGORY_RANK.general) {
      lineItems.push({
        kind: 'room_upgrade',
        label: `Room upgrade to ${room_category} (package bundles general ward)`,
        amount_minor: null,
        review_required: true,
        note: REVIEW_PLACEHOLDER,
      });
      reviewFlags.push(
        `Room upgrade to ${room_category} needs a room-tariff master — ${REVIEW_PLACEHOLDER}`,
      );
    }
  }

  // Estimate total: only the lines we can actually price. When any line
  // is review-flagged the total is a LOWER BOUND, not the final figure.
  const pricedMinor = lineItems
    .filter((l) => !l.review_required && l.amount_minor != null)
    .reduce((sum, l) => sum + l.amount_minor, 0);
  const hasUnpriced = lineItems.some((l) => l.review_required);

  return {
    package: {
      id: pkg.id,
      package_code: pkg.package_code,
      display_name: pkg.display_name,
      base_specialty: pkg.base_specialty,
      duration_days: pkg.duration_days,
      status: pkg.status,
      inclusion_notes: pkg.inclusion_notes,
      exclusion_notes: pkg.exclusion_notes,
    },
    inputs: { room_category: room_category || null, los_days: requestedDays },
    line_items: lineItems,
    estimated_total_minor: pricedMinor,
    estimated_total_is_lower_bound: hasUnpriced,
    review_required: hasUnpriced,
    review_flags: reviewFlags,
    currency: pkg.currency || 'INR',
  };
}
