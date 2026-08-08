/**
 * Merged-patient read union (patient-merge integrity rework, PR follow-up to
 * the migration-634 merge sweep).
 *
 * Append-only history (canonical timeline/audit plus every table the merge
 * sweep excludes because an update-blocking trigger protects it) stays
 * recorded under the uid it happened to. After a merge, the survivor's chart
 * must still show that history, so READERS union the survivor's uid with
 * every uid that was merged into it (users.merged_into_uid).
 *
 * Two forms, one contract:
 *
 *   - resolveMergedPatientUidSet(db, { tenantId, patientUid }) — resolve the
 *     full set {uid} ∪ {uids merged into it, transitively} for
 *     parameter-driven readers ("... WHERE patient_uid = ANY($n::uuid[])").
 *     The walk is depth-bounded and therefore cycle-safe.
 *
 *   - mergedPatientUidsSubquery(tenantSqlExpr, uidSqlExpr) — a correlated SQL
 *     subquery fragment for set-based readers that filter per-row
 *     ("timeline.patient_uid IN (<fragment>)"). One level of
 *     users.merged_into_uid is COMPLETE, not an approximation: executeMerge
 *     re-points every stored merged_into_uid pointer at the final survivor
 *     when a chain forms (A→B then B→C leaves both A and B pointing at C), so
 *     no live pointer is ever more than one hop from its survivor.
 *
 * Both forms preserve tenant scoping: the users lookup is always constrained
 * to the same tenant as the caller's row filter. Missing tenant context or a
 * failed union lookup fails the read rather than returning an incomplete
 * chart.
 */

import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_DEPTH = 8;

function cleanUuid(value) {
  const text = value == null ? '' : String(value).trim();
  return UUID_RE.test(text) ? text : null;
}

/**
 * Resolve a patient uid to the set of uids whose history belongs to the same
 * chart: the uid itself plus every uid merged into it, transitively
 * (grand-merges included even though executeMerge flattens pointers — the
 * walk stays transitive so the reader is correct even for data written before
 * the flattening fix). Returns an array of uid strings with the requested uid
 * first; on any failure (missing column on an un-migrated schema, no tenant)
 * it fails closed. Falling back to [patientUid] would silently hide the
 * merged-away portion of the chart while returning an apparently successful
 * response.
 *
 * @param {object} db - prisma client or transaction client with $queryRawUnsafe
 * @param {object} opts
 * @param {string} opts.tenantId - REQUIRED tenant scope for the users walk
 * @param {string} opts.patientUid - the uid the caller is reading for
 * @param {number} [opts.maxDepth] - chain depth bound (cycle safety)
 * @returns {Promise<string[]>}
 */
export async function resolveMergedPatientUidSet(db, {
  tenantId,
  patientUid,
  maxDepth = DEFAULT_MAX_DEPTH,
} = {}) {
  const uid = cleanUuid(patientUid);
  if (!uid) return [];
  const tid = cleanUuid(tenantId);
  const depth = Number.isInteger(maxDepth) && maxDepth > 0 ? Math.min(maxDepth, 32) : DEFAULT_MAX_DEPTH;
  if (!tid) {
    throw AppError.badRequest(
      'tenant_id is required to resolve merged patient history',
      'MERGED_PATIENT_TENANT_REQUIRED',
    );
  }
  if (typeof db?.$queryRawUnsafe !== 'function') {
    throw AppError.internal(
      'Merged patient history could not be resolved',
      'MERGED_PATIENT_READER_UNAVAILABLE',
    );
  }
  try {
    const rows = await db.$queryRawUnsafe(
      `WITH RECURSIVE merged_chain(uid, depth) AS (
         SELECT $2::uuid, 0
         UNION ALL
         SELECT merged_user.uid, merged_chain.depth + 1
           FROM users AS merged_user
           JOIN merged_chain
             ON merged_user.merged_into_uid = merged_chain.uid
          WHERE merged_user.tenant_id = $1::uuid
            AND merged_chain.depth < $3::int
       )
       SELECT DISTINCT uid::text AS uid FROM merged_chain`,
      tid, uid, depth,
    );
    const set = new Set([uid]);
    for (const row of rows) {
      const chained = cleanUuid(row.uid);
      if (chained) set.add(chained);
    }
    return [uid, ...[...set].filter((entry) => entry !== uid)];
  } catch (err) {
    logger.error('merged patient uid chain resolution failed', {
      patientUid: uid,
      error: err?.message || String(err),
    });
    throw err;
  }
}

/**
 * Correlated SQL fragment for set-based readers: the survivor's uid plus
 * every uid whose users.merged_into_uid points at it. Use as
 * `x.patient_uid IN (${mergedPatientUidsSubquery('a.tenant_id', 'a.patient_uid')})`.
 *
 * One level is complete because executeMerge re-points stored
 * merged_into_uid pointers to the final survivor on every merge (chains are
 * flattened at write time; the transitive walk lives in
 * resolveMergedPatientUidSet for defence in depth).
 *
 * SECURITY: both arguments are interpolated into SQL verbatim. Callers MUST
 * pass only trusted SQL expressions — a column reference (`admission.tenant_id`)
 * or a bind-parameter placeholder (`$1::uuid`) — never user input.
 */
export function mergedPatientUidsSubquery(tenantSqlExpr, uidSqlExpr) {
  return `SELECT ${uidSqlExpr} AS uid
           UNION
          SELECT merged_user.uid
             FROM users AS merged_user
            WHERE merged_user.tenant_id = ${tenantSqlExpr}
              AND merged_user.merged_into_uid = ${uidSqlExpr}`;
}

export const __testing__ = {
  DEFAULT_MAX_DEPTH,
  cleanUuid,
};

export default {
  resolveMergedPatientUidSet,
  mergedPatientUidsSubquery,
};
