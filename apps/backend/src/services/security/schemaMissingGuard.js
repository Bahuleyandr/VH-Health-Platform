// src/services/security/schemaMissingGuard.js
//
// Strict "governance schema not migrated yet" detector for the PHI/IDOR
// access-decision guards (audit finding M3, 2026-06-10).
//
// The old check matched the broad message regex /does not exist/i — so ANY
// error whose message contained that phrase (a renamed column, a dropped
// function, "operator does not exist: integer = text", a partial migration)
// silently DISABLED the patient/staff access checks. The skip now requires:
//   * an EXACT SQLSTATE 42P01 (undefined_table) on a verified error-code
//     field — never message text; AND
//   * a non-production environment. In production a missing governance
//     table is a deployment fault and the guard FAILS CLOSED (403/500),
//     never open.
// Every skip is alerted at error level by the callers.

const SCHEMA_MISSING_SQLSTATES = new Set([
  '42P01', // undefined_table — the governance table itself is not migrated
]);

/** Extracts the Postgres SQLSTATE from the places Prisma surfaces it. */
export function extractSqlState(err) {
  const candidates = [
    err?.code,
    err?.meta?.code,
    err?.meta?.driverAdapterError?.cause?.originalCode,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c)) return c;
  }
  return null;
}

function extractMissingRelation(err) {
  const structuredCandidates = [
    err?.table,
    err?.meta?.table,
    err?.meta?.driverAdapterError?.cause?.table,
  ];
  for (const candidate of structuredCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim().toLowerCase();
    }
  }

  const messageCandidates = [
    err?.message,
    err?.meta?.message,
    err?.meta?.driverAdapterError?.cause?.message,
    err?.meta?.driverAdapterError?.cause?.originalMessage,
  ];
  for (const candidate of messageCandidates) {
    if (typeof candidate !== 'string') continue;
    const match = /\brelation\s+(?:"([^"]+)"|'([^']+)'|([a-z_][a-z0-9_.]*))\s+does not exist\b/i.exec(candidate);
    const relation = match?.[1] || match?.[2] || match?.[3];
    if (relation) return relation.toLowerCase();
  }

  return null;
}

/**
 * True only when a named optional public table is the exact missing relation
 * and the compatibility fallback is running outside production.
 */
export function isOptionalTableMissing(err, tableName) {
  if ((process.env.NODE_ENV || '').toLowerCase() === 'production') return false;
  if (extractSqlState(err) !== '42P01') return false;

  const expected = String(tableName || '').trim().toLowerCase();
  if (!/^[a-z_][a-z0-9_]*$/.test(expected)) return false;

  const missingRelation = extractMissingRelation(err);
  return missingRelation === expected || missingRelation === `public.${expected}`;
}

/**
 * True only when the error is a verified undefined_table SQLSTATE AND we are
 * not in production. Callers must alert loudly on every skip.
 */
export function isGovernanceSchemaMissing(err) {
  if ((process.env.NODE_ENV || '').toLowerCase() === 'production') {
    return false; // prod: never skip an access check — fail closed
  }
  const sqlState = extractSqlState(err);
  return sqlState !== null && SCHEMA_MISSING_SQLSTATES.has(sqlState);
}

export default { extractSqlState, isGovernanceSchemaMissing, isOptionalTableMissing };
