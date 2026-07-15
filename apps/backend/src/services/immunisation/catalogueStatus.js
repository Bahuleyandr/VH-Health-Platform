// Shared vaccine_catalogue configuration probe.
//
// A tenant's immunisation schedule is "configured" when it has at least one
// ACTIVE vaccine_catalogue row. Onboarding never seeds a catalogue (choosing a
// pack is the unsigned D6 clinical decision), so a freshly onboarded tenant has
// zero rows — and both seeders used to report `{inserted:0}` as SUCCESS against
// that empty catalogue, silently giving a new hospital's babies no schedule at
// all. This probe is the single definition of "configured" shared by both
// seeders (which now fail closed) and the onboarding reporter.

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

export const SCHEDULE_NOT_CONFIGURED_CODE = 'IMMUNISATION_SCHEDULE_NOT_CONFIGURED';

/**
 * Count the ACTIVE catalogue rows for a tenant. `db` may be a transaction
 * client; defaults to the prisma singleton (safe as a pre-flight — the query
 * carries an explicit tenant_id predicate, so it reads the right tenant even on
 * the RLS-permissive plain client).
 */
export async function getActiveCatalogueCount(tenantId, db = prisma) {
  if (!tenantId) throw AppError.badRequest('tenantId is required');
  const rows = await db.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n
       FROM vaccine_catalogue
      WHERE tenant_id = $1::uuid AND active = true`,
    tenantId,
  );
  return Number(rows[0]?.n || 0);
}

/**
 * The 422 raised when a facility has no configured schedule. A factory so both
 * seeders raise the identical error whether they detect the empty catalogue via
 * a pre-flight count (newborn) or the `total` their seed query already computes
 * (paediatric).
 */
export function scheduleNotConfiguredError() {
  return new AppError(
    'No immunisation schedule is configured for this facility. An administrator '
    + 'must import a vaccine schedule (after clinical sign-off) before doses can be scheduled.',
    422,
    SCHEDULE_NOT_CONFIGURED_CODE,
  );
}

/**
 * Fail closed (422) when a tenant has no active immunisation schedule. Keys on
 * catalogue POPULATION, never on insert count — an idempotent re-seed of an
 * already-populated catalogue (inserted=0) is a success, not a misconfiguration.
 */
export async function assertScheduleConfigured(tenantId, db = prisma) {
  const count = await getActiveCatalogueCount(tenantId, db);
  if (count === 0) throw scheduleNotConfiguredError();
}
