// scripts/lib/migrationSessionGucs.mjs
//
// The session parameters the migration runner OWNS for the whole chain.
//
// ★ WHY THIS EXISTS. `ci-setup-db.mjs` applies every migration through ONE
// long-lived connection, and a plain `SET` is session-scoped — it outlives the
// file that issued it and governs every migration after it. `000_baseline.sql`
// is `pg_dump` output whose preamble opens with nine such SETs, so for years
// the entire chain ran under whatever pg_dump happened to want.
//
// That is not theoretical. `check_function_bodies = false` leaked from the
// baseline is why migrations 744 and 745 shipped trigger functions whose plpgsql
// bodies cannot compile while CI stayed green (a bare CASE inside an IF
// condition consumes the IF's own THEN). Migration 759 repairs those bodies.
//
// ★★ THE TWO GUCS PULL IN OPPOSITE DIRECTIONS, AND THAT IS DELIBERATE.
//
// `check_function_bodies` is pinned ON so a body that cannot compile is rejected
// at CREATE time rather than at first trigger fire (plpgsql compiles lazily).
//
// `row_security` is pinned OFF, and "off" here does NOT mean "ignore RLS" — it
// means "raise an error instead of silently applying a policy". Measured on
// pg17 for a query a policy would filter:
//
//   role                             row_security=off       row_security=on
//   superuser / BYPASSRLS            unaffected             unaffected
//   plain owner of a FORCE-RLS table ERROR 42501 (loud)     0 rows, silently
//
// Migrations run as an owner over tables that 237/272 and the continuity series
// put under FORCE ROW LEVEL SECURITY, which removes the owner exemption. So `on`
// is the dangerous value: a backfill a policy would filter reports success
// having touched nothing, and a silently-empty backfill is indistinguishable
// from a correct one. Pinning `off` keeps that case loud.
//
// ★ Today the value is inert everywhere — CI connects as a superuser, and the
// migration Job connects as `vhhealth`, which cluster.yaml grants BYPASSRLS
// precisely so a fresh-cluster apply survives (its `wait-owner-bypassrls`
// initContainer blocks until CNPG has reconciled it). What this pin removes is
// the trapdoor: the baseline is regenerated pg_dump output, so the day its
// preamble changes, the session would silently fall back to the default `on`.
// Combined with any future withdrawal of BYPASSRLS from the migration role,
// that turns loud failures into silent no-ops.
//
// ★★ IF YOU ARE HERE TO DROP BYPASSRLS FROM THE MIGRATION ROLE: that is fine,
// and this pin is what makes it safe. Do NOT also "restore" row_security to on.

export const MIGRATION_SESSION_GUCS = Object.freeze({
  // Every plpgsql body a migration creates must compile before it is accepted.
  check_function_bodies: 'on',
  // A policy-affected migration query must error, never silently see fewer rows.
  row_security: 'off',
});

/**
 * Assert ownership of the session. Called once before the first migration — so
 * the invariant does not depend on the baseline's preamble at all — and again
 * after each file, so no single migration can govern the ones that follow it.
 */
export async function pinMigrationSessionGucs(client) {
  for (const [name, value] of Object.entries(MIGRATION_SESSION_GUCS)) {
    // Parameters are not permitted in SET, and these names and values are
    // compile-time constants from the frozen table above — never user input.
    await client.query(`SET ${name} = ${value}`);
  }
}

export async function readMigrationSessionGucs(client) {
  const actual = {};
  for (const name of Object.keys(MIGRATION_SESSION_GUCS)) {
    const { rows } = await client.query('SELECT current_setting($1) AS value', [name]);
    actual[name] = rows[0]?.value;
  }
  return actual;
}

/**
 * Pure comparison, so the drift report is unit-testable without a database.
 * Returns [] when the session still matches what the runner pinned.
 */
export function findDriftedGucs(actual) {
  return Object.entries(MIGRATION_SESSION_GUCS)
    .filter(([name, expected]) => actual[name] !== expected)
    .map(([name, expected]) => `${name}=${actual[name]} (expected ${expected})`);
}
