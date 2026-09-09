// The teardown census's count expressions, in ONE place.
//
// WHY THIS FILE EXISTS. The census writes docs/security/teardown-tx-census.json
// and the CI gate re-checks it, and until this file both sides computed the
// counters. Two copies of a rule drift, and this particular set of rules cannot
// be kept honest by inspection: on today's corpus only two of the four delete
// kinds occur (609 `literal`, 16 `dynamic`; zero `dynamic-partial`, zero
// `unresolved`) and no delete has an empty `relations`, so several competing
// rules produce identical numbers. A hand-written second copy "matched" while
// being wrong in two ways - `kind === 'dynamic'` instead of
// `dynamic || dynamic-partial`, and the `relations.length > 0` condition
// dropped - and neither error was visible in any current count. Exporting the
// expressions makes divergence impossible by construction rather than by
// review.
//
// DEPENDENCY-FREE ON PURPOSE. The CI gate's artifact-integrity half runs in the
// unconditional `security` stage, which installs nothing. Nothing here may
// import the parser, or that stage reddens on every PR.

/** `dynamic-partial` is a dynamic hit whose source list resolved only in part. */
const dynamicKind = (kind) => kind === 'dynamic' || kind === 'dynamic-partial';

/**
 * Counters that are a pure function of the per-file records, and therefore
 * recomputable from a committed artifact's `files[]` alone.
 */
export const DERIVED_COUNTS = Object.freeze([
  'parseFailures',
  'filesWithTargetDelete',
  'filesReachedByLiteralArm',
  'filesReachedByDynamicArm',
  'filesReachedOnlyByDynamicArm',
  'filesWithDynamicUsersAndNoLiteralUsers',
  'classA',
  'classB',
  'classBoth',
  'classNone',
  'classUnknown',
  'aUsers',
  'aTenants',
  'bUsers',
  'bTenants',
  'filesUsingHelperAndStillDeletingTargets',
  'filesWithUnresolvedDynamicDelete',
  'filesWithPartiallyResolvedDynamicDelete',
]);

/**
 * Counters measured over the WALK, not over the records, so a committed
 * artifact cannot reproduce them from `files[]`. Only floors are assertable.
 *
 * `filesUsingTenantTeardownHelper` is the trap: it counts helper users across
 * every walked file (12 today), while `files[]` holds only the files carrying a
 * users/tenants delete (403 of 2042). Deriving it from `files[]` yields 1 - and
 * that 1 is tenantTeardown.js itself - so a naive integrity check reddens on a
 * correct artifact. Its record-scoped sibling,
 * `filesUsingHelperAndStillDeletingTargets`, IS derivable and is above.
 */
export const FLOOR_ONLY_COUNTS = Object.freeze([
  'filesWalked',
  'filesUsingTenantTeardownHelper',
]);

/**
 * Every counter the census emits. The gate fails on a `counts` key in neither
 * list, so a counter added later cannot land in an unchecked bucket.
 */
export const ALL_COUNTS = Object.freeze([...DERIVED_COUNTS, ...FLOOR_ONLY_COUNTS]);

/**
 * The census's counts. The single implementation: `census()` calls this to
 * write the artifact and the CI gate calls it to re-check one.
 *
 * @param {object[]} records per-file records (the artifact's `files[]`)
 * @param {object} walk values measured over the walk, not over the records
 * @param {number} walk.filesWalked
 * @param {number} walk.parseFailureCount
 * @param {number} walk.filesUsingHelper helper users across ALL walked files
 */
export function computeCounts(records, { filesWalked, parseFailureCount, filesUsingHelper }) {
  const by = (predicate) => records.filter(predicate).length;
  return {
    filesWalked,
    parseFailures: parseFailureCount,
    filesWithTargetDelete: records.length,
    filesReachedByLiteralArm: by((r) => r.deletes.some((d) => d.kind === 'literal')),
    filesReachedByDynamicArm: by((r) => r.deletes.some((d) => dynamicKind(d.kind) && d.relations.length > 0)),
    filesReachedOnlyByDynamicArm: by(
      (r) => r.deletes.some((d) => dynamicKind(d.kind) && d.relations.length > 0)
        && !r.deletes.some((d) => d.kind === 'literal'),
    ),
    filesWithDynamicUsersAndNoLiteralUsers: by(
      (r) => r.deletes.some((d) => dynamicKind(d.kind) && d.relations.includes('users'))
        && !r.deletes.some((d) => d.kind === 'literal' && d.relations.includes('users')),
    ),
    classA: by((r) => r.classification === 'a'),
    classB: by((r) => r.classification === 'b'),
    classBoth: by((r) => r.classification === 'both'),
    classNone: by((r) => r.classification === 'none'),
    classUnknown: by((r) => r.classification === 'unknown'),
    aUsers: by((r) => r.a.users),
    aTenants: by((r) => r.a.tenants),
    bUsers: by((r) => r.b.users),
    bTenants: by((r) => r.b.tenants),
    filesUsingTenantTeardownHelper: filesUsingHelper,
    filesUsingHelperAndStillDeletingTargets: by((r) => r.usesTenantTeardownHelper),
    filesWithUnresolvedDynamicDelete: by((r) => r.unresolvedDynamicDeletes > 0),
    filesWithPartiallyResolvedDynamicDelete: by((r) => r.partiallyResolvedDynamicDeletes > 0),
  };
}

/**
 * Recompute the counters from a committed artifact, using the SAME expressions
 * the census used to write it.
 *
 * `parseFailures` is genuinely re-derived, from the length of the artifact's own
 * `parseFailures[]` list rather than from its `counts` - taking it from `counts`
 * would make that comparison a tautology. The two walk-scoped counters are
 * echoed back so the returned object has the full shape; the caller compares
 * only DERIVED_COUNTS and asserts floors on FLOOR_ONLY_COUNTS, so the echoed
 * values are never used as evidence of anything.
 */
export function deriveCountsFromArtifact(artifact) {
  return computeCounts(artifact.files ?? [], {
    filesWalked: artifact.counts?.filesWalked,
    parseFailureCount: (artifact.parseFailures ?? []).length,
    filesUsingHelper: artifact.counts?.filesUsingTenantTeardownHelper,
  });
}
